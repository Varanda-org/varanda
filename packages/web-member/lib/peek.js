'use strict'

// The Espiadinha in the browser node (docs/rpc.md 5.22): the page of
// `peek.read` is computed HERE, in the browser, from the seeder's inventory
// and author-signed blocks fetched into MEMORY over a short-lived dedicated
// seeder link. The rule (which diaries, which blocks, which order) is
// @varanda/core lib/peek.js (peekCandidates, peekWindow, diaryPeek,
// buildPeekPage); this module is the transport and the memory. No seeder
// change, no new protocol message, no storage write: nothing here writes a
// key-value entry, opens a replica or opens any core of the node storage.
//
// TRUST MODEL: compared with A Rua the seeder gains nothing. It can withhold
// (an inventory entry, a block, a shorter length, an older signed state it
// kept), as it can today; it cannot forge (Hypercore verifies every block
// against the author key), cannot choose which post is shown (the client
// reads the signed tail: the window is computed from the memory core's
// length after the block-0 get, the length Hypercore verified with the
// upgrade proof, never from the unsigned length of the hello, which only
// picks candidates), cannot bypass the block-0 gate (verified locally with
// the stored revoked-issuer set, block 0 alone, before any other block of
// that diary is requested) nor unblock anyone (the stored signed blocklist
// is re-applied on every read). Nor can it mix histories: every window
// after the first runs on a fresh memory core, so the snapshot binds the
// diary to the verified length AND the Merkle roots (treeHash) learned with
// block 0, and a later window is accepted only when its core reproduces
// exactly that state; blocks of another fork-0 history the author signed
// (or of a history that grew since the snapshot) are discarded, the diary
// stops extending for this snapshot (only a fresh first page rebinds it)
// and the page is incomplete. No core is replicated before the verified
// hello (role 'seeder' and seederCertForKey on the Noise key, exactly as
// ./sync.js). Peer data never escapes lib/peek.js's copying readers.
// PRIVACY: the link sends an empty inventory and no announce; it requests
// the complement of the follow set, which the seeder already learns from
// the sync link's inventory on the same IP; the seeder logs one `peer`
// event per link (lib/seeder.js _attachPeer) with an ephemeral Noise key;
// nothing is stored anywhere, on any server or in this node's storage.
// DATA FLOWS: browser memory only. The node keeps one snapshot for at most
// PEEK_SNAPSHOT_TTL_MS (the UI keeps the page until the list is refreshed);
// the association and the account service learn nothing.
// COST: as docs/rpc.md 5.22 (one WebSocket + Noise + hello/inventory, then
// per candidate one channel and <= 11 block requests in two phases, 16
// diaries in parallel, under one page deadline and one byte budget).
// The budget is charged per block as it arrives and checked before every
// block request; each worker keeps ONE block in flight and a block over
// MAX_BLOCK_BYTES ends its diary for the snapshot. RESIDUAL RISK: at most
// PEEK_PARALLEL blocks are in flight at once, each bounded only by the
// transport's frame limit until it arrives, so a hostile seeder can make
// the node receive up to PEEK_PARALLEL oversized frames past the budget
// before the link is destroyed.
//
// Memory: between pages a diary keeps only retainRecords(entries) (block 0,
// profile and username records, posts and reposts) plus the set of fetched
// seqs, within PEEK_SNAPSHOT_MAX_BYTES of retained JSON per snapshot; raw
// buffers and the memory cores (64 KiB pages) are released after every
// window. The snapshot is replaced on every after-less read once the new one
// exists (a failed refresh must not strand the list on screen) and dropped
// on TTL, abort() and close(). A continuation without a live snapshot is
// refused: applying its cursor to a rebuilt order could silently skip rows.
// One read at a time.
//
// Every read, continuation pages included and even when nothing is
// fetched, re-filters the snapshot with the CURRENT follows and blocklist
// and re-runs diaryPeek over the retained records with the current revoked
// issuers and clock: a newly revoked issuer removes a v2-certified diary
// and nulls the username of a v1-certified one.
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { decodeBlock, MAX_LOG_BLOCKS, MAX_LOG_BYTES, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { UsageError } = require('@varanda/core/lib/errors')
const {
  PEEK_MAX_ROUNDS,
  PEEK_PARALLEL,
  PEEK_FETCH_TIMEOUT_MS,
  PEEK_PAGE_TIMEOUT_MS,
  PEEK_CONNECT_TIMEOUT_MS,
  PEEK_SNAPSHOT_TTL_MS,
  PEEK_PAGE_MAX_BYTES,
  peekCandidates,
  peekWindow,
  diaryPeek,
  buildPeekPage,
  isPeekCursor,
  retainRecords
} = require('@varanda/core/lib/peek')
const { memoryStorage } = require('./storage')
const { wsStream } = require('./ws-stream')
const { moderation } = require('./member-ops')
const store = require('./node-store')

// Retained records (UTF-8 JSON) one snapshot may hold.
const PEEK_SNAPSHOT_MAX_BYTES = 33554432
// Page size of the memory cores (random-access-memory defaults to 1 MiB).
const PEEK_CORE_PAGE_SIZE = 65536
// No fetch starts with less than this left on the page deadline.
const PEEK_MIN_FETCH_MS = 250
const NO_SEEDER = 'sem conexão com o semeador'
const BUSY = 'espiadinha já em andamento'
const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

function overQuota (core) {
  return core.length > MAX_LOG_BLOCKS || core.byteLength > MAX_LOG_BYTES
}

// Uniform index in [0, n) from hypercore-crypto's randomness.
function randomIndex (n) {
  const span = 0x100000000
  const limit = span - (span % n)
  while (true) {
    const bytes = crypto.randomBytes(4)
    const r = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
    if (r < limit) return r % n
  }
}

// Fisher-Yates in place: a deadline or budget cut never falls
// systematically on the same diaries.
function shuffle (list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
  return list
}

// Runs fn over items with at most n in flight, in order.
async function pool (items, n, fn) {
  let next = 0
  const workers = []
  for (let i = 0; i < Math.min(n, items.length); i++) {
    workers.push((async () => {
      while (next < items.length) await fn(items[next++])
    })())
  }
  await Promise.all(workers)
}

// log(text): warnings for the page. limits: test-only overrides of the
// timings and budgets (connectTimeoutMs, pageTimeoutMs, fetchTimeoutMs,
// snapshotTtlMs, pageMaxBytes, snapshotMaxBytes, parallel).
function createPeeker ({ storage, association, seederUrl, createSocket, log = noop, limits = {} } = {}) {
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  const L = {
    connectTimeoutMs: PEEK_CONNECT_TIMEOUT_MS,
    pageTimeoutMs: PEEK_PAGE_TIMEOUT_MS,
    fetchTimeoutMs: PEEK_FETCH_TIMEOUT_MS,
    snapshotTtlMs: PEEK_SNAPSHOT_TTL_MS,
    pageMaxBytes: PEEK_PAGE_MAX_BYTES,
    snapshotMaxBytes: PEEK_SNAPSHOT_MAX_BYTES,
    parallel: PEEK_PARALLEL,
    ...(limits || {})
  }

  // { at, order: [diary] (random fetch order), incomplete, bytes }; a diary:
  // { key, length (verified, null until block 0), seqs, records, bytes,
  //   fail (sticky verdict of this snapshot), failed (a block did not
  //   arrive), reason, name, username, posts, scanned, capped, exhausted }
  let snapshot = null
  let current = null // the running read: { link, cores, aborted, lost }
  let closed = false

  function warn (text) {
    try { log(text) } catch {}
  }

  function checkAborted (run) {
    if (run.aborted) throw new Error(NO_SEEDER)
  }

  // ---- the peek link ----

  // Dials the seeder with an ephemeral Noise key, attaches the muxer and
  // the admission channel with an EMPTY inventory, verifies the hello
  // exactly as ./sync.js does and waits for the inventory to complete. One
  // deadline covers socket, Noise, hello and inventory. -> the link
  // { noise, peer, incomplete }; rejects Error('sem conexão com o semeador').
  function openLink (run) {
    return new Promise((resolve, reject) => {
      let socket
      try {
        socket = createSocket(seederUrl)
      } catch {
        reject(new Error(NO_SEEDER))
        return
      }
      const noise = new NoiseSecretStream(true, wsStream(socket), { keyPair: crypto.keyPair() })
      noise.on('error', noop)
      const link = { noise, peer: null, verified: false, incomplete: false }
      run.link = link
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          noise.destroy()
          reject(err)
        } else {
          resolve(link)
        }
      }
      const timer = setTimeout(() => finish(new Error(NO_SEEDER)), L.connectTimeoutMs)
      noise.once('close', () => {
        // A link lost after the inventory: the fetches in flight end now
        // (their cores are closed) and the page is incomplete.
        run.lost = true
        for (const q of run.cores) q.close().catch(noop)
        finish(new Error(NO_SEEDER))
      })
      noise.once('connect', () => {
        if (run.aborted) {
          finish(new Error(NO_SEEDER))
          return
        }
        try {
          // The muxer only: no core is attached before the hello verified.
          Hypercore.createProtocolStream(noise)
          link.peer = attachAdmission(noise, {
            role: 'member',
            have: [],
            onmessage: (msg, peer) => {
              if (msg.type !== 'hello') return
              link.verified = msg.role === 'seeder' &&
                peer.peerKey !== null &&
                seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
              if (!link.verified) {
                warn('aviso: o endereço configurado não respondeu como um semeador verificado (' + key8(peer.peerKey) + ')')
                finish(new Error(NO_SEEDER))
              }
            },
            oninventory: (peer) => {
              if (!link.verified) return
              link.incomplete = peer.remoteHave.size < peer.remoteCount
              finish(null)
            },
            log: (ev) => {
              if (ev && ev.event === 'inventory-timeout') warn('aviso: inventário incompleto (' + key8(ev.peerKey) + ')')
              else if (ev && ev.event === 'peer-dropped') warn('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
            }
          })
        } catch {
          finish(new Error(NO_SEEDER))
        }
      })
    })
  }

  // Whether this read's link was cut under a window (budget, lost link,
  // abort): what failed then says nothing about the diary.
  function cutLink (run, link) {
    return run.lost || run.aborted || run.overBudget === true || link === null || link.noise.destroyed
  }

  function closeLink (run) {
    const link = run.link
    run.link = null
    if (link !== null) link.noise.destroy()
  }

  // ---- the snapshot ----

  function newDiary ({ key }) {
    return {
      key,
      length: null,
      treeHash: null,
      seqs: new Set(),
      records: [],
      bytes: 0,
      fail: null,
      failed: false,
      changed: false,
      reason: null,
      name: null,
      username: null,
      posts: [],
      scanned: false,
      capped: false,
      exhausted: false
    }
  }

  async function buildSnapshot (run, { follows, blocked }) {
    const link = await openLink(run)
    checkAborted(run)
    const candidates = peekCandidates({ inventory: link.peer.remoteHave, follows, blocked })
    const order = shuffle(candidates.map(newDiary))
    return { at: Date.now(), order, incomplete: link.incomplete, bytes: 0 }
  }

  // Keeps only what lib/peek.js retainRecords keeps and accounts its bytes.
  function setRecords (snap, diary, entries) {
    const kept = retainRecords([...diary.records, ...entries])
    snap.bytes -= diary.bytes
    diary.records = kept
    diary.bytes = b4a.byteLength(JSON.stringify(kept), 'utf8')
    snap.bytes += diary.bytes
  }

  // The diary's standing for THIS read: follows and the blocklist first,
  // then this snapshot's sticky verdict (fork, quota, short, unavailable),
  // then diaryPeek over the retained records with the current revoked
  // issuers and clock.
  function refresh (diary, { follows, mod, now }) {
    if (follows.has(diary.key)) diary.reason = 'followed'
    else if (mod.blocked.has(diary.key)) diary.reason = 'blocked'
    else if (diary.fail !== null) diary.reason = diary.fail
    else if (diary.length === null) diary.reason = null
    else {
      const r = diaryPeek({
        key: diary.key,
        length: diary.length,
        entries: diary.records,
        fetched: diary.seqs,
        association,
        revokedIssuers: mod.revokedIssuers,
        now
      })
      diary.reason = r.reason
      diary.name = r.name
      diary.username = r.username
      diary.posts = r.posts
      diary.scanned = r.scanned
      diary.capped = r.capped
    }
    diary.exhausted = diary.reason !== null || diary.failed || diary.scanned || diary.capped ||
      diary.posts.length >= PEEK_MAX_ROUNDS
  }

  function visible (snap) {
    return snap.order.filter((d) => d.reason === null)
  }

  // ---- fetching ----

  // Whether a later window's core reproduces the verified state of the
  // first one: same length and the same Merkle roots. Any error -> false.
  async function sameHistory (q, diary) {
    try {
      if (q.length !== diary.length || diary.treeHash === null) return false
      return b4a.equals(await q.treeHash(diary.length), diary.treeHash)
    } catch {
      return false
    }
  }

  // The seeder served another history (or a longer one) for the diary:
  // terminal for this snapshot. The diary keeps only what earlier windows
  // verified against the first window's state (its accepted posts stay
  // shown), extends no further and leaves the page incomplete.
  function changed (diary, ctx) {
    diary.changed = true
    diary.failed = true
    refresh(diary, ctx)
  }

  // One window of a diary through a memory core on the read's link: block 0
  // alone first (the gate, then fork and quota on the verified state), then
  // peekWindow over the VERIFIED length. -> raw bytes received. Never
  // throws: a block that did not arrive marks the diary failed.
  // A block over MAX_BLOCK_BYTES (records.js; decodeBlock never parses one)
  // makes the diary terminal for the snapshot: skipped, page incomplete, no
  // further block of it requested.
  function oversized (diary, ctx) {
    diary.fail = 'oversized'
    diary.failed = true
    refresh(diary, ctx)
  }

  // Charges a received block to the read's page budget. When the budget is
  // exceeded the read's link is destroyed, which ends every get in flight
  // (the other workers) at once; the page is then incomplete. -> false when
  // the block itself is oversized.
  function charge (run, raw) {
    run.budget += raw.byteLength
    if (run.budget >= L.pageMaxBytes && run.link !== null) {
      run.overBudget = true
      closeLink(run)
    }
    return raw.byteLength <= MAX_BLOCK_BYTES
  }

  async function fetchWindow (run, snap, diary, ctx) {
    const link = run.link
    const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(diary.key, 'hex'), { valueEncoding: 'binary' })
    run.cores.add(q)
    try {
      await q.ready()
      if (run.aborted || run.lost || link === null || link.noise.destroyed) return
      q.replicate(link.noise)
      const timeout = () => Math.max(1, Math.min(L.fetchTimeoutMs, ctx.deadline - Date.now()))
      const firstWindow = diary.length === null
      if (firstWindow) {
        let raw0 = null
        const t0 = timeout()
        try {
          raw0 = await q.get(0, { raw: true, timeout: t0 })
        } catch {}
        if (raw0 === null) {
          // Ended by the budget cut, a lost link or the page deadline (a
          // timeout shorter than the fetch timeout): not a verdict on the
          // diary, which stays pending for a later read.
          if (run.lost || run.aborted || t0 < L.fetchTimeoutMs) return
          // Terminal for this snapshot at once: skipped and page incomplete,
          // never listed in `needs` again, so paging continues over the rest.
          diary.fail = 'unavailable'
          diary.failed = true
          refresh(diary, ctx)
          return
        }
        if (!charge(run, raw0)) {
          oversized(diary, ctx)
          return
        }
        // The signed length: what Hypercore verified with the upgrade proof.
        diary.length = q.length
        diary.seqs.add(0)
        setRecords(snap, diary, [{ seq: 0, record: decodeBlock(raw0) }])
        refresh(diary, ctx)
        if (diary.reason !== null) return
        if (q.fork !== 0) diary.fail = 'fork'
        else if (overQuota(q)) diary.fail = 'quota'
        else if (diary.length < 2) diary.fail = 'short'
        if (diary.fail !== null) {
          refresh(diary, ctx)
          return
        }
        // The verified history this snapshot is bound to: the Merkle roots at
        // the verified length are local after the upgrade. Every later
        // window (a fresh memory core) must reproduce this exact state, so
        // a seeder cannot serve blocks of another fork-0 history the author
        // signed and have them combined with this block 0.
        try {
          diary.treeHash = await q.treeHash(diary.length)
        } catch {
          // A core closed by the budget cut (charge destroys the link, the
          // block-0 charge of this very worker included), a lost link or an
          // abort is not a verdict: the diary goes back to pending, without
          // its block 0, so a later read runs its first window again.
          if (cutLink(run, link)) {
            diary.length = null
            diary.seqs.delete(0)
            diary.records = diary.records.filter((e) => e.seq !== 0)
            setRecords(snap, diary, [])
            refresh(diary, ctx)
            return
          }
          changed(diary, ctx)
          return
        }
      }
      const seqs = peekWindow(diary.length, diary.seqs)
      if (seqs.length === 0) {
        refresh(diary, ctx)
        return
      }
      // ONE block in flight per worker (highest seq first, as peekWindow
      // orders them): the budget is checked before every request and
      // charged as every block arrives, so in-flight data is bounded by
      // PEEK_PARALLEL blocks. The blocks are buffered in `got` until the
      // window is accepted.
      const got = []
      let hole = false
      for (const seq of seqs) {
        if (ctx.cut()) break
        let raw
        const t = timeout()
        try {
          raw = await q.get(seq, { raw: true, timeout: t })
        } catch {
          // A hole the seeder left: the window is never extended past it.
          // A get ended by the budget cut, a lost link or the page deadline
          // (a timeout shorter than the fetch timeout) is not one.
          if (!run.lost && !run.aborted && t >= L.fetchTimeoutMs) hole = true
          break
        }
        if (!charge(run, raw)) {
          oversized(diary, ctx)
          return
        }
        // A later window runs on a fresh core: a block is accepted only
        // while the core stands at the snapshot's verified length with the
        // same Merkle roots (checked once the first block upgraded it and
        // again after every block); otherwise everything this window
        // fetched is discarded.
        if (!firstWindow && !(await sameHistory(q, diary))) {
          // A cut link is not a verdict either: this window is discarded and
          // the diary stays pending for a later read.
          if (cutLink(run, link)) return
          changed(diary, ctx)
          return
        }
        got.push({ seq, record: decodeBlock(raw) })
      }
      if (hole) diary.failed = true
      for (const e of got) diary.seqs.add(e.seq)
      setRecords(snap, diary, got)
      // The signed length and byteLength advance on upgrade.
      if (q.fork !== 0) diary.fail = 'fork'
      else if (overQuota(q)) diary.fail = 'quota'
      refresh(diary, ctx)
    } catch {
      diary.failed = true
      refresh(diary, ctx)
    } finally {
      run.cores.delete(q)
      await q.close().catch(noop)
    }
  }

  // ---- read ----

  async function readWith (run, { limit, cursor, first }) {
    const deadline = Date.now() + L.pageTimeoutMs
    // Preparation: kv reads only, no core is opened.
    const follows = new Set()
    for (const raw of await store.readFollows(storage)) {
      const key = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (HEX64.test(key)) follows.add(key)
    }
    const mod = await moderation(storage, association)
    checkAborted(run)
    if (cursor !== null && (snapshot === null || Date.now() - snapshot.at > L.snapshotTtlMs)) {
      throw new UsageError('A lista expirou; atualize para continuar.')
    }
    if (first) {
      // The previous snapshot stays until this one exists: a failed refresh
      // must not strand the list on screen. Idle expiry, abort() and close()
      // still drop it.
      const built = await buildSnapshot(run, { follows, blocked: mod.blocked })
      checkAborted(run)
      snapshot = built
    }
    const snap = snapshot
    // Checked before EVERY block request, by every worker.
    const cut = () => Date.now() >= deadline - PEEK_MIN_FETCH_MS || run.budget >= L.pageMaxBytes || snap.bytes >= L.snapshotMaxBytes || run.lost || run.link === null
    const ctx = { follows, mod, deadline, cut, now: Date.now() }
    for (const diary of snap.order) refresh(diary, ctx)
    let incomplete = snap.incomplete
    let page
    while (true) {
      page = buildPeekPage({ diaries: visible(snap), limit, after: cursor })
      if (page.needs.length === 0) break
      // A continuation needing no fetch opens no link; one needing fetches
      // opens a fresh one and reuses the cached blocks. A link destroyed by
      // the budget is not reopened: the page is cut.
      if (run.link === null && !run.overBudget && !run.lost) {
        await openLink(run)
        checkAborted(run)
      }
      if (cut()) {
        incomplete = true
        // A provisional page ends with next: null, which reads as the end of
        // the Espiadinha. Build the final page from what arrived instead:
        // diaries still needing blocks count as exhausted for THIS read only
        // (the snapshot keeps them, so a later read may fetch them), and the
        // page carries a real cursor. A post of theirs that would have sorted
        // before the cursor is missed until a fresh first page; incomplete
        // tells the person to refresh.
        const pending = new Set(page.needs)
        page = buildPeekPage({
          diaries: visible(snap).map((d) => (pending.has(d.key) ? { ...d, exhausted: true } : d)),
          limit,
          after: cursor
        })
        break
      }
      const wanted = new Set(page.needs)
      const batch = snap.order.filter((d) => wanted.has(d.key))
      await pool(batch, L.parallel, async (diary) => {
        if (run.aborted) return
        if (cut()) {
          incomplete = true
          return
        }
        ctx.now = Date.now()
        // The budget lives on the run and is charged per block as it
        // arrives (charge), never through a local read before an await.
        await fetchWindow(run, snap, diary, ctx)
      })
      checkAborted(run)
      if (run.overBudget) incomplete = true
    }
    // A diary a block did not arrive for (block 0 included: skipped as
    // 'unavailable') or one capped before supplying its posts leaves the
    // page incomplete, on every page of this snapshot.
    for (const d of snap.order) {
      if (d.failed || (d.reason === null && d.capped && d.posts.length < PEEK_MAX_ROUNDS)) incomplete = true
    }
    // Skipped = left out by a problem the person should know about (block 0
    // or certificate, blocklist, revoked issuer, unavailable, fork, quota,
    // oversized block) or a scan that ended before finding any post. A diary
    // with nothing to show (only a profile or likes, too short) and one
    // followed after this snapshot was built are not problems.
    const skipped = snap.order.filter((d) =>
      (d.reason !== null && d.reason !== 'followed' && d.reason !== 'short') ||
      (d.reason === null && d.posts.length === 0 && (d.capped || d.failed))).length
    return { items: page.items, next: page.next, diaries: snap.order.length, skipped, incomplete }
  }

  // -> { items, next, diaries, skipped, incomplete } (docs/rpc.md 5.22).
  // A concurrent read is refused (UsageError 'espiadinha já em andamento');
  // abort() rejects the running one with Error('sem conexão com o semeador').
  async function read ({ limit, after } = {}) {
    if (closed) throw new Error(NO_SEEDER)
    if (current !== null) throw new UsageError(BUSY)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new UsageError('limit inválido')
    const first = after === undefined || after === null
    if (!first && !isPeekCursor(after)) throw new UsageError('after inválido')
    const run = { link: null, cores: new Set(), aborted: false, lost: false, budget: 0, overBudget: false }
    current = run
    try {
      return await readWith(run, { limit, cursor: first ? null : after, first })
    } finally {
      closeLink(run)
      for (const q of run.cores) q.close().catch(noop)
      // Guarded by identity: an aborted read never touches a newer one.
      if (current === run) {
        current = null
        armExpiry()
      }
    }
  }

  // The snapshot is dropped PEEK_SNAPSHOT_TTL_MS after it was built even
  // when no read ever comes again (an idle session must not keep up to
  // PEEK_SNAPSHOT_MAX_BYTES of records); one timer, re-armed after each
  // read, unref'd so it never keeps a process alive.
  let expiryTimer = null

  function clearExpiry () {
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    expiryTimer = null
  }

  function armExpiry () {
    clearExpiry()
    const snap = snapshot
    if (snap === null) return
    expiryTimer = setTimeout(() => {
      expiryTimer = null
      if (snapshot === snap) snapshot = null
    }, Math.max(0, snap.at + L.snapshotTtlMs - Date.now()))
    if (expiryTimer.unref) expiryTimer.unref()
  }

  // Drops the snapshot, destroys the link and ends the running read, and
  // releases the one-at-a-time slot at once: a new read may start while
  // the aborted one is still unwinding (it sees `aborted` at its next
  // checkpoint and throws without touching the new read's state).
  function abort () {
    snapshot = null
    clearExpiry()
    const run = current
    if (run === null) return
    current = null
    run.aborted = true
    closeLink(run)
    for (const q of run.cores) q.close().catch(noop)
  }

  function close () {
    closed = true
    abort()
  }

  // Test hook only (not part of the session's API): whether a snapshot is
  // currently retained.
  function hasSnapshot () {
    return snapshot !== null
  }

  return { read, abort, close, hasSnapshot }
}

module.exports = { createPeeker, PEEK_SNAPSHOT_MAX_BYTES, PEEK_CORE_PAGE_SIZE }
