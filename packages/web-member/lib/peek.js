'use strict'

// The Espiadinha in the browser node (docs/rpc.md 5.22): the page of
// `peek.read` is computed HERE, in the browser, from the seeder's inventory
// (or its candidate pages) and author-signed blocks fetched into MEMORY over
// a short-lived dedicated seeder link. The rule (which diaries, which
// blocks, which order) is @varanda/core lib/peek.js (peekCandidates,
// peekWindow, diaryPeek, buildPeekPage); this module is the transport and
// the memory. No storage write: nothing here writes a key-value entry,
// opens a replica or opens any core of the node storage.
//
// BOUNDED LINK: a seeder that offers 'varanda/discovery/1' (CAP_DISCOVERY,
// @varanda/core lib/discovery-net.js) sends a lean hello to this link
// (CAP_NO_INVENTORY) and the snapshot loads its candidates in batches of
// PEEK_CANDIDATES from the seeder's frozen view instead of the whole
// inventory, so a first page fetches at most one batch of diaries. A batch
// is asked only when a round runs out before the page is full (buildPeekPage
// with batchOf and more), at most PEEK_CANDIDATE_PAGES per read, paced by the
// channel; a timeout, a closed channel or a stale view ends the read
// incomplete with a usable cursor and restarts the candidate traversal from
// a fresh first page at the next batch, keeping the snapshot's diaries and
// batches (a repeated key is ignored). A seeder without discovery gives
// exactly the pages it gave before. The candidate pages are as untrusted as
// the inventory: their lengths only pick candidates.
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
// PRIVACY: the link sends an empty inventory (asking for none) and no
// announce; on a bounded link the seeder also learns how many candidate
// pages were asked (how far the member scrolled; follows are filtered
// here); it requests
// the complement of the follow set, which the seeder already learns from
// the sync link's inventory on the same IP; the own diary is part of what
// is requested and only hidden from the page, so the request pattern does
// not single the member out; the seeder logs one `peer`
// event per link (lib/seeder.js _attachPeer) with an ephemeral Noise key;
// nothing is stored anywhere, on any server or in this node's storage.
// DATA FLOWS: browser memory only. The node keeps one snapshot for at most
// PEEK_SNAPSHOT_TTL_MS (the UI keeps the page until the list is refreshed);
// the association and the account service learn nothing.
// COST: as docs/rpc.md 5.22 (one WebSocket + Noise + hello/inventory, then
// per candidate one channel and <= 11 block requests in two phases, block 0
// alone and first, then the window with up to PEEK_WINDOW_INFLIGHT (3)
// blocks in flight (./block-window.js, consumed strictly highest seq
// first), 16 diaries in parallel, under one page deadline and one byte
// budget). The budget is charged per block as it arrives, in flight or
// already abandoned, and checked before every block request; a worker's
// first get may always go out, a further one only while every get in
// flight on the link fits under the budget, so in-flight data is bounded
// by PEEK_PARALLEL x 3 blocks and the overshoot past the budget stays at
// one block per worker. A block over MAX_BLOCK_BYTES ends its diary for
// the snapshot. A bounded link adds one candidate page per batch the pages
// need. A page over PEEK_SLOW_READ_MS writes one local timing line
// (connection, inventory or candidates, blocks). FRAMES: the link runs
// behind a frame guard (./ws-stream.js guardedWsStream, @varanda/core
// lib/frame-guard) bounding every frame the seeder sends after the Noise
// handshake to PEEK_MAX_FRAME; a frame declaring more cuts the link at its
// 3-byte header (warning 'aviso: quadro grande demais do semeador', page
// incomplete), before the secret stream allocates the body and before the
// page budget is charged. RESIDUAL RISK: the browser has already allocated
// each WebSocket message it hands over (one message is one frame or more,
// so up to the socket's own message limit), and a hostile seeder may have
// several such messages in flight when the guard cuts; the guard bounds
// the secret stream's copy of a frame and cuts early, it cannot un-receive
// what the WebSocket buffered.
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
const { decodeBlock, validRecordCopy, MAX_LOG_BLOCKS, MAX_LOG_BYTES, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission, CAP_NO_INVENTORY, CAP_DISCOVERY, MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { attachDiscovery, DISCOVERY_REQUEST_TIMEOUT_MS, MAX_PAGES_PER_READ } = require('@varanda/core/lib/discovery-net')
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
const { pipeline } = require('./block-window')
const { guardedWsStream } = require('./ws-stream')
const { readerModeration } = require('./member-ops')
const store = require('./node-store')

// Retained records (UTF-8 JSON) one snapshot may hold.
const PEEK_SNAPSHOT_MAX_BYTES = 33554432
// Page size of the memory cores (random-access-memory defaults to 1 MiB).
const PEEK_CORE_PAGE_SIZE = 65536
// No fetch starts with less than this left on the page deadline.
const PEEK_MIN_FETCH_MS = 250
// Blocks of one diary's window in flight at once (block 0 always alone and
// first): about one round trip per 3 blocks instead of one per block.
const PEEK_WINDOW_INFLIGHT = 3
// A page slower than this writes one local timing line (never sent).
const PEEK_SLOW_READ_MS = 1000
// The largest frame the peek link accepts after the Noise handshake (the
// FrameGuard bound; sync and seeder links keep MAX_EXTERNAL_FRAME because a
// member's batches legitimately reach 8 MiB). The peek link receives the
// seeder's inventory (a hello of at most MAX_HELLO_HAVE = 100 keys inside
// one admission payload of at most 16 KiB, the rest as one 'have' message
// each, up to MAX_INVENTORY 4096) and blocks answered for PEEK_PARALLEL
// workers with up to PEEK_WINDOW_INFLIGHT (3) blocks in flight each (each
// <= MAX_BLOCK_BYTES plus its proof), which the seeder may cork into one
// batch: 16 x 3 x 16384 bytes is 768 KiB, ~792 KiB with the proofs, in the
// worst legitimate case. MEASURED 2026-10-27, with one block in flight
// (test/frame-guard-client.test.js): a full 7-page read from a real seeder
// holding 64 diaries of 200 near-4 KiB posts and a media core received 831
// frames, the largest 11 665 bytes; a full 4096-key inventory from the real
// admission code, 4027 frames, the largest 9031 bytes.
// 1 MiB stays above that worst case and far above both measurements while
// refusing a frame 8x larger.
const PEEK_MAX_FRAME = 1048576
// Diaries asked per candidate page on a bounded link: one batch. A first
// page then fetches at most this many diaries instead of the whole inventory.
const PEEK_CANDIDATES = 48
// Candidate pages one read may ask for (the discovery channel's own per-read
// bound); the channel paces them at one per DISCOVERY_PACE_MS, the seeder's
// refill rate, so an honest read never trips the seeder's rate drop.
const PEEK_CANDIDATE_PAGES = MAX_PAGES_PER_READ
// The cursor handed back by a bounded page that ran out of candidates before
// showing anything: it sorts before every item of the snapshot (round 0,
// batch 0 through the own key, a time no post can carry), so the next read
// continues from the very start of the snapshot.
const START_AT = '9999-12-31T23:59:59.999Z'
// A seeder at its connection cap closes the WebSocket with 1013 (try again
// later); an older one terminates the socket (1006): NO_SEEDER.
const CLOSE_TRY_AGAIN = 1013
const SEEDER_BUSY = 'Semeador ocupado; tente novamente em instantes.'
const FRAME_TOO_LARGE = 'aviso: quadro grande demais do semeador'
const NO_SEEDER = 'sem conexão com o semeador'
const BUSY = 'espiadinha já em andamento'
const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

// The seq a valid tombstone at `seq` deletes, or null.
function tombstoneTarget (record, seq, length) {
  const copy = validRecordCopy(record, seq)
  return copy !== null && copy.type === 'delete' && copy.seq >= 1 && copy.seq < length ? copy.seq : null
}

// The targets of the retained tombstones of a diary.
function deletedTargets (records, length) {
  const out = new Set()
  for (const { seq, record } of records) {
    const target = tombstoneTarget(record, seq, length)
    if (target !== null) out.add(target)
  }
  return out
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
// snapshotTtlMs, pageMaxBytes, snapshotMaxBytes, parallel, windowInflight,
// maxFrame, candidates, candidatePages, candidateTimeoutMs) and test hooks
// (now: the slow-read clock; trace(event): every block get, its outcome,
// its charge, every accepted block and every candidate page asked).
// ownKey() returns the viewer's lowercase hex64 key or a Promise of it: the
// viewer's diary is fetched like any candidate (cover for the anonymous
// link) and hidden from their own page.
function createPeeker ({ storage, association, seederUrl, createSocket, ownKey, log = noop, limits = {} } = {}) {
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  if (typeof ownKey !== 'function') throw new TypeError('ownKey required')
  const L = {
    connectTimeoutMs: PEEK_CONNECT_TIMEOUT_MS,
    pageTimeoutMs: PEEK_PAGE_TIMEOUT_MS,
    fetchTimeoutMs: PEEK_FETCH_TIMEOUT_MS,
    snapshotTtlMs: PEEK_SNAPSHOT_TTL_MS,
    pageMaxBytes: PEEK_PAGE_MAX_BYTES,
    snapshotMaxBytes: PEEK_SNAPSHOT_MAX_BYTES,
    parallel: PEEK_PARALLEL,
    windowInflight: PEEK_WINDOW_INFLIGHT,
    maxFrame: PEEK_MAX_FRAME,
    candidates: PEEK_CANDIDATES,
    maxCandidates: MAX_INVENTORY,
    candidatePages: PEEK_CANDIDATE_PAGES,
    candidateTimeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    now: Date.now,
    trace: noop,
    ...(limits || {})
  }

  // { at, order: [diary] (random fetch order, batch by batch), incomplete,
  // bytes, own, batchOf, keys, view, after, more, batch }. batchOf is null on
  // a snapshot built from a full inventory; on a bounded one it maps every
  // key that ever entered the snapshot (and the own key, at batch 0) to its
  // candidate batch and is never pruned, so any cursor of the snapshot stays
  // valid for its whole life. keys: the keys in `order`. view, after: where
  // the next candidate page starts (null, null: a fresh first page). more:
  // further candidate pages may exist. batch: the next batch number. A diary:
  // { key, length (verified, null until block 0), seqs, records, bytes,
  //   fail (sticky verdict of this snapshot), failed (a block did not
  //   arrive), reason, name, username, posts, scanned, capped, exhausted }
  let snapshot = null
  let current = null // the running read: { link, cores, aborted, lost }
  let closed = false

  function warn (text) {
    try { log(text) } catch {}
  }

  // Test hook only: every block get, its outcome and every charge.
  function trace (ev) {
    try { L.trace(ev) } catch {}
  }

  // The clock of the slow-read line only (deadlines use Date.now).
  function clock () {
    try {
      const t = L.now()
      return Number.isFinite(t) ? t : Date.now()
    } catch {
      return Date.now()
    }
  }

  function checkAborted (run) {
    if (run.aborted) throw new Error(NO_SEEDER)
  }

  // ---- the peek link ----

  // Dials the seeder with an ephemeral Noise key, attaches the muxer, the
  // discovery channel (member role) and the admission channel with an EMPTY
  // inventory, asking for none (CAP_NO_INVENTORY), and verifies the hello
  // exactly as ./sync.js does. A seeder that offers discovery
  // (CAP_DISCOVERY) and opens the channel makes the link BOUNDED: it
  // resolves without an inventory and candidates come in pages. Any other
  // seeder ignores the bit and the link waits for the inventory to complete,
  // as before discovery. One deadline covers socket, Noise, hello and
  // inventory (or the discovery open). -> the link
  // { noise, peer, discovery, bounded, incomplete }; rejects Error('sem conexão com o semeador'),
  // or UsageError(SEEDER_BUSY) when the socket closed with 1013 (a fixed
  // text: nothing the seeder sent is ever echoed). A frame over maxFrame
  // destroys the link (run.lost) and marks the read frameCut: after the
  // inventory that page is answered incomplete; during the hello or the
  // inventory (this link not resolved yet) the read fails with
  // 'sem conexão com o semeador' instead. The warning is logged either way.
  function openLink (run) {
    const dialAt = clock()
    let helloAt = null
    return new Promise((resolve, reject) => {
      let socket
      try {
        socket = createSocket(seederUrl)
      } catch {
        run.times.connect += clock() - dialAt
        reject(new Error(NO_SEEDER))
        return
      }
      let noise = null
      const { ws, stream } = guardedWsStream(socket, {
        maxFrame: L.maxFrame,
        onLimit: () => {
          run.frameCut = true
          warn(FRAME_TOO_LARGE)
          if (noise !== null) noise.destroy()
        }
      })
      noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
      noise.on('error', noop)
      // offered: the verified seeder sent CAP_DISCOVERY; supported: its
      // discovery channel opened (null until known); inventory: the hello's
      // inventory completed.
      const link = { noise, peer: null, discovery: null, bounded: false, verified: false, incomplete: false, offered: false, supported: null, inventory: false }
      run.link = link
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const endAt = clock()
        if (helloAt === null) {
          run.times.connect += endAt - dialAt
        } else {
          run.times.connect += helloAt - dialAt
          run.times.inventory += endAt - helloAt
        }
        if (err) {
          noise.destroy()
          reject(err)
        } else {
          if (link.bounded) run.bounded = true
          resolve(link)
        }
      }
      const timer = setTimeout(() => finish(new Error(NO_SEEDER)), L.connectTimeoutMs)
      noise.once('close', () => {
        // A link lost after the inventory: the fetches in flight end now
        // (their cores are closed) and the page is incomplete.
        run.lost = true
        for (const q of run.cores) q.close().catch(noop)
        finish(ws.closeCode === CLOSE_TRY_AGAIN ? new UsageError(SEEDER_BUSY) : new Error(NO_SEEDER))
      })
      noise.once('connect', () => {
        if (run.aborted) {
          finish(new Error(NO_SEEDER))
          return
        }
        try {
          // The muxer only: no core is attached before the hello verified.
          Hypercore.createProtocolStream(noise)
          // On the muxer before the hello, so protomux pairs the seeder's
          // open; a seeder from before discovery rejects it (supported false).
          link.discovery = attachDiscovery(noise, {
            role: 'member',
            requestTimeoutMs: L.candidateTimeoutMs,
            log: (ev) => {
              if (ev && ev.event === 'peer-dropped') warn('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
            }
          })
          link.peer = attachAdmission(noise, {
            role: 'member',
            have: [],
            caps: CAP_NO_INVENTORY,
            onmessage: (msg, peer) => {
              if (msg.type !== 'hello') return
              link.verified = msg.role === 'seeder' &&
                peer.peerKey !== null &&
                seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
              if (link.verified) helloAt = clock()
              if (!link.verified) {
                warn('aviso: o endereço configurado não respondeu como um semeador verificado (' + key8(peer.peerKey) + ')')
                finish(new Error(NO_SEEDER))
                return
              }
              // Only a verified seeder's offer counts: the candidates of a
              // bounded link come from the same verified peer.
              if ((peer.remoteCaps & CAP_DISCOVERY) === 0) return
              link.offered = true
              link.discovery.supported.then((ok) => {
                link.supported = ok === true
                if (link.supported) {
                  link.bounded = true
                  finish(null)
                } else if (link.inventory) {
                  // It offered discovery, so its hello was lean, yet the
                  // channel never opened: the inventory says nothing.
                  link.incomplete = true
                  finish(null)
                }
              }, noop)
            },
            oninventory: (peer) => {
              if (!link.verified) return
              link.inventory = true
              link.incomplete = peer.remoteHave.size < peer.remoteCount
              if (!link.offered) {
                finish(null)
              } else if (link.supported === false) {
                link.incomplete = true
                finish(null)
              }
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
      avatar: null,
      username: null,
      posts: [],
      scanned: false,
      capped: false,
      exhausted: false
    }
  }

  // A full-inventory link gives today's snapshot (batchOf null). A bounded
  // link gives an empty one with the own key at batch 0 (START_AT), then
  // asks the first candidate page; a first page that fails leaves it empty
  // and the read incomplete.
  async function buildSnapshot (run, ctx) {
    const { follows, mod, own } = ctx
    const link = await openLink(run)
    checkAborted(run)
    if (!link.bounded) {
      const candidates = peekCandidates({ inventory: link.peer.remoteHave, follows, blocked: mod.blocked })
      const order = shuffle(candidates.map(newDiary))
      return { at: Date.now(), order, incomplete: link.incomplete, bytes: 0, own, batchOf: null }
    }
    const snap = {
      at: Date.now(),
      order: [],
      incomplete: false,
      bytes: 0,
      own,
      batchOf: new Map([[own, 0]]),
      keys: new Set(),
      view: null,
      after: null,
      more: true,
      batch: 0
    }
    await loadCandidates(run, snap, ctx)
    return snap
  }

  // A candidate page could not be trusted to continue the traversal (stale
  // view, timeout, closed channel): the next one starts a fresh view from
  // its first page. The snapshot's diaries and batches stay, so a cursor
  // keeps its meaning, and a key the fresh view repeats is ignored: no row
  // of the snapshot is shown twice or skipped.
  function restartCandidates (snap) {
    snap.view = null
    snap.after = null
    snap.more = true
  }

  // Asks the next candidate page of a bounded snapshot on the read's link
  // and appends its new candidates as the next batch, shuffled within it.
  // The lengths are unsigned hints that only pick candidates, exactly as the
  // inventory's (peekCandidates: hex64, length >= 2, not followed, not
  // blocked; the own diary stays as cover); every diary is verified from its
  // block 0 as always. -> true when a page arrived (even with nothing new),
  // false when none could be asked or none came (the read is incomplete,
  // and the run asks no further page).
  async function loadCandidates (run, snap, ctx) {
    const link = run.link
    // The hello inventory stopped at MAX_INVENTORY; batches stop there too,
    // so a seeder that keeps naming new keys (with no blocks to verify)
    // cannot grow the snapshot for its whole life.
    if (snap.keys.size >= L.maxCandidates) {
      snap.more = false
      return true
    }
    if (run.candidatesFailed || run.candidatePages >= L.candidatePages || link === null || !link.bounded) {
      run.candidatesFailed = true
      return false
    }
    run.candidatePages++
    const left = ctx.deadline - PEEK_MIN_FETCH_MS - Date.now()
    trace({ type: 'candidates', view: snap.view, after: snap.after })
    const askedAt = clock()
    let res = null
    let timer = null
    try {
      const request = link.discovery.page({ after: snap.after, limit: L.candidates, view: snap.view })
      // Past the page deadline the answer is not waited for; nothing is
      // known about the traversal then, so it is kept as it was.
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, left)) })
      res = await Promise.race([request.catch(() => false), late])
    } finally {
      clearTimeout(timer)
      run.times.inventory += clock() - askedAt
    }
    checkAborted(run)
    if (res === null) {
      run.candidatesFailed = true
      return false
    }
    if (res === false || res.stale === true) {
      restartCandidates(snap)
      run.candidatesFailed = true
      return false
    }
    snap.view = res.view
    snap.after = res.next
    snap.more = res.next !== null
    const batch = snap.batch++
    const fresh = peekCandidates({
      inventory: res.items.map((it) => [it.key, it.length]),
      follows: ctx.follows,
      blocked: ctx.mod.blocked
    }).filter((c) => !snap.keys.has(c.key))
    const added = shuffle(fresh.map(newDiary))
    for (const diary of added) {
      snap.keys.add(diary.key)
      // The own key keeps batch 0 (START_AT relies on it).
      if (!snap.batchOf.has(diary.key)) snap.batchOf.set(diary.key, batch)
      snap.order.push(diary)
      refresh(diary, ctx)
    }
    return true
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
    else if (mod.hidden.has(diary.key)) diary.reason = 'hidden'
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
        hidden: mod.hidden,
        now
      })
      diary.reason = r.reason
      diary.name = r.name
      diary.avatar = r.avatar
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

  // One raw get on the read's link, counted in run.pending while in flight
  // and charged to the budget on ARRIVAL, exactly once, whether or not the
  // window later uses the block. -> { raw, ok (not oversized), t } or
  // { raw: null, t } when it failed (t: the timeout it was given).
  function getBlock (run, q, key, seq, t) {
    run.pending++
    trace({ type: 'get', key, seq })
    return q.get(seq, { raw: true, timeout: t }).then((raw) => {
      run.pending--
      if (raw === null || raw === undefined) {
        trace({ type: 'settle', key, seq, bytes: null })
        return { raw: null, t }
      }
      trace({ type: 'settle', key, seq, bytes: raw.byteLength })
      const ok = charge(run, raw)
      trace({ type: 'charge', key, seq, bytes: raw.byteLength, budget: run.budget })
      return { raw, ok, t }
    }, () => {
      run.pending--
      trace({ type: 'settle', key, seq, bytes: null })
      return { raw: null, t }
    })
  }

  async function fetchWindow (run, snap, diary, ctx) {
    const link = run.link
    const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(diary.key, 'hex'), { valueEncoding: 'binary' })
    const sessions = new Map() // seq -> the session of its window get in flight
    let win = null
    let closing = null
    // What run.cores holds for this window: every path that ends it (its
    // own end, abort, a lost link, the budget cut) closes through here.
    // Closing q does NOT close its sessions (hypercore 10), so the window
    // gets, each on its own session, are cancelled first, then q. Idempotent.
    const closer = {
      close () {
        if (closing === null) {
          if (win !== null) win.stop()
          const open = [...sessions.values()]
          sessions.clear()
          trace({ type: 'closed', key: diary.key, cancelled: open.length })
          closing = Promise.allSettled(open.map((s) => s.close())).then(() => q.close())
        }
        return closing
      }
    }
    run.cores.add(closer)
    try {
      await q.ready()
      if (run.aborted || run.lost || link === null || link.noise.destroyed) return
      q.replicate(link.noise)
      const timeout = () => Math.max(1, Math.min(L.fetchTimeoutMs, ctx.deadline - Date.now()))
      const firstWindow = diary.length === null
      if (firstWindow) {
        const t0 = timeout()
        const first = await getBlock(run, q, diary.key, 0, t0)
        const raw0 = first.raw
        if (raw0 === null) {
          // Ended by the budget cut, a lost link or the page deadline (a
          // timeout shorter than the fetch timeout): not a verdict on the
          // diary, which stays pending for a later read.
          if (run.lost || run.aborted || run.overBudget || t0 < L.fetchTimeoutMs) return
          // Terminal for this snapshot at once: skipped and page incomplete,
          // never listed in `needs` again, so paging continues over the rest.
          diary.fail = 'unavailable'
          diary.failed = true
          refresh(diary, ctx)
          return
        }
        if (!first.ok) {
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
      // Up to L.windowInflight blocks of this diary in flight (highest seq
      // first, as peekWindow orders them), consumed strictly in that order
      // so every rule below sees the blocks as a serial read would. The
      // budget is checked before every request and charged as every block
      // arrives (getBlock); a block that is already in flight when the
      // window stops is still charged and then dropped. The window's first
      // get may always go out (one block per worker, as before); a further
      // one only while every get in flight on the link still fits under the
      // page budget, so the overshoot stays at PEEK_PARALLEL blocks. The
      // blocks are buffered in `got` until the window is accepted.
      const got = []
      const absent = []
      const gone = deletedTargets(diary.records, diary.length)
      let hole = false
      let mine = 0
      const GONE = { gone: true }
      win = pipeline({
        seqs,
        inflight: L.windowInflight,
        canStart: () => !ctx.cut() && run.overBudget !== true &&
          (mine === 0 || run.budget + (run.pending + 1) * MAX_BLOCK_BYTES < L.pageMaxBytes),
        start: (seq) => {
          // A block a tombstone already read deleted is never asked for:
          // seeders clear it, and a get would only wait for the timeout.
          if (gone.has(seq)) return GONE
          // A window already closed starts nothing (q takes no new session).
          if (closing !== null) return { raw: null, t: 0 }
          mine++
          // Each get on its own session of the memory core: closing that
          // session cancels the get and drops its block request (hypercore
          // clearRequests), the only per-request cancel hypercore offers.
          const s = q.session()
          sessions.set(seq, s)
          return getBlock(run, s, diary.key, seq, timeout()).finally(() => {
            mine--
            sessions.delete(seq)
            s.close().catch(noop)
          })
        },
        // A block deleted by a tombstone consumed while its get was already
        // in flight is not waited for: seeders clear it, so the get would
        // only end at the fetch timeout. Its get is cancelled; it keeps
        // counting in run.pending, mine and the pipeline's bound until it
        // settles, and is charged only if a block really arrived first.
        skip: (seq) => gone.has(seq),
        cancel: (seq) => {
          const s = sessions.get(seq)
          if (s !== undefined) s.close().catch(noop)
        }
      })
      try {
        for await (const { seq, result } of win) {
          // A block a tombstone read deleted (the window is read highest seq
          // first, so the tombstone comes before its target) counts as
          // fetched, absent, even when its get was already in flight: what
          // arrived for it is ignored.
          if (gone.has(seq)) {
            absent.push(seq)
            continue
          }
          if (result === undefined || result.raw === null) {
            const timedOut = result !== undefined && !run.lost && !run.aborted && !run.overBudget && result.t >= L.fetchTimeoutMs
            // A hole the seeder left: the window is never extended past it,
            // and the lower blocks already in flight are dropped. A get ended
            // by the budget cut, a lost link or the page deadline (a timeout
            // shorter than the fetch timeout) is not one. A head block too:
            // only a block a tombstone already read deleted counts as absent
            // (above); any other one may be a live profile or the tombstone
            // of the block below it, so it is never cached as fetched and
            // nothing below it is read.
            if (timedOut) hole = true
            break
          }
          if (!result.ok) {
            oversized(diary, ctx)
            return
          }
          // A later window runs on a fresh core: a block is accepted only
          // while the core stands at the snapshot's verified length with the
          // same Merkle roots (checked once the first block upgraded it and
          // again as every block is consumed); otherwise everything this
          // window fetched is discarded.
          if (!firstWindow && !(await sameHistory(q, diary))) {
            // A cut link is not a verdict either: this window is discarded
            // and the diary stays pending for a later read.
            if (cutLink(run, link)) return
            changed(diary, ctx)
            return
          }
          const record = decodeBlock(result.raw)
          got.push({ seq, record })
          trace({ type: 'accept', key: diary.key, seq })
          const target = tombstoneTarget(record, seq, diary.length)
          if (target !== null) gone.add(target)
        }
      } finally {
        // The gets still in flight are cancelled when the window closes below.
        win.stop()
      }
      if (hole) diary.failed = true
      for (const e of got) diary.seqs.add(e.seq)
      for (const seq of absent) diary.seqs.add(seq)
      setRecords(snap, diary, got)
      // The signed length and byteLength advance on upgrade.
      if (q.fork !== 0) diary.fail = 'fork'
      else if (overQuota(q)) diary.fail = 'quota'
      refresh(diary, ctx)
    } catch {
      diary.failed = true
      refresh(diary, ctx)
    } finally {
      run.cores.delete(closer)
      await closer.close().catch(noop)
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
    const mod = await readerModeration(storage, association)
    checkAborted(run)
    if (cursor !== null && (snapshot === null || Date.now() - snapshot.at > L.snapshotTtlMs)) {
      throw new UsageError('A lista expirou; atualize para continuar.')
    }
    let snap = snapshot
    // Checked before EVERY block request, by every worker.
    const cut = () => Date.now() >= deadline - PEEK_MIN_FETCH_MS || run.budget >= L.pageMaxBytes || snap.bytes >= L.snapshotMaxBytes || run.lost || run.link === null
    const ctx = { follows, mod, deadline, cut, now: Date.now() }
    if (first) {
      const raw = await ownKey()
      checkAborted(run)
      const own = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (!HEX64.test(own)) throw new TypeError('ownKey inválido')
      // The previous snapshot stays until this one exists: a failed refresh
      // must not strand the list on screen. Idle expiry, abort() and close()
      // still drop it.
      const built = await buildSnapshot(run, { ...ctx, own })
      checkAborted(run)
      snapshot = built
      snap = built
    }
    for (const diary of snap.order) refresh(diary, ctx)
    const bounded = snap.batchOf !== null
    let incomplete = snap.incomplete || run.candidatesFailed
    // A bounded page that cannot load the candidates it waits for ends
    // where it stands: its cursor is its last item, or the cursor it was
    // given, or START_AT; the next read loads the rest of the round from
    // there, so nothing it skipped is lost.
    const held = (p) => {
      if (p.more !== true) return p
      const last = p.items[p.items.length - 1]
      let next
      if (last !== undefined) next = { round: last.round, at: last.at, author: last.author, seq: last.seq }
      else if (cursor !== null) next = { round: cursor.round, at: cursor.at, author: cursor.author, seq: cursor.seq }
      else next = { round: 0, at: START_AT, author: snap.own, seq: 1 }
      return { items: p.items, next, needs: [] }
    }
    const pageOf = (diaries) => buildPeekPage({ diaries, limit, after: cursor, hidden: snap.own, batchOf: snap.batchOf, more: bounded && snap.more })
    let page
    while (true) {
      page = pageOf(visible(snap))
      if (page.needs.length === 0 && page.more === true) {
        // The round ran out before the page filled and the snapshot holds
        // more candidates: ask the next page on this read's link (opened
        // when needed), paced by the discovery channel and bounded per read.
        if (run.link === null && !run.overBudget && !run.lost && !run.candidatesFailed) {
          await openLink(run)
          checkAborted(run)
        }
        if (!cut() && await loadCandidates(run, snap, ctx)) continue
        incomplete = true
        page = held(page)
        break
      }
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
        page = held(pageOf(visible(snap).map((d) => (pending.has(d.key) ? { ...d, exhausted: true } : d))))
        break
      }
      const wanted = new Set(page.needs)
      const batch = snap.order.filter((d) => wanted.has(d.key))
      const blocksAt = clock()
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
      run.times.blocks += clock() - blocksAt
      checkAborted(run)
      if (run.overBudget || run.frameCut) incomplete = true
    }
    // A diary a block did not arrive for (block 0 included: skipped as
    // 'unavailable') or one capped before supplying its posts leaves the
    // page incomplete, on every page of this snapshot. The own diary is only
    // cover there: its failures never warn on its owner's page.
    const shown = snap.order.filter((d) => d.key !== snap.own)
    for (const d of shown) {
      if (d.failed || (d.reason === null && d.capped && d.posts.length < PEEK_MAX_ROUNDS)) incomplete = true
    }
    // A link cut by the frame guard never answers a complete page.
    if (run.frameCut) incomplete = true
    // Skipped = left out by a problem the person should know about (block 0
    // or certificate, blocklist, revoked issuer, unavailable, fork, quota,
    // oversized block) or a scan that ended before finding any post. A diary
    // with nothing to show (only a profile or likes, too short), one followed
    // after this snapshot was built and one the member blocked are not problems.
    const skipped = shown.filter((d) =>
      (d.reason !== null && d.reason !== 'followed' && d.reason !== 'short' && d.reason !== 'hidden') ||
      (d.reason === null && d.posts.length === 0 && (d.capped || d.failed))).length
    return { items: page.items, next: page.next, diaries: shown.length, skipped, incomplete }
  }

  // A page over PEEK_SLOW_READ_MS writes ONE local line saying where the
  // time went (the Sincronização screen; it never leaves the device). Only
  // durations: no key, no address, nothing the seeder sent.
  function slowRead (run, total) {
    if (run.aborted || !(total > PEEK_SLOW_READ_MS)) return
    const ms = (n) => Math.max(0, Math.round(n)) + ' ms'
    warn('espiadinha: conexão ' + ms(run.times.connect) + (run.bounded ? ', candidatos ' : ', inventário ') + ms(run.times.inventory) +
      ', blocos ' + ms(run.times.blocks) + ', total ' + ms(total))
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
    // cores: what closes each window in flight (its gets' sessions, then its
    // memory core). pending: block gets in flight on the link (getBlock).
    // times: ms spent
    // dialling up to the verified hello, waiting for the inventory (or, on a
    // bounded link, the discovery open and the candidate pages) and
    // fetching blocks, for the slow-read line. candidatePages: candidate
    // pages asked by this read; candidatesFailed: one could not be asked or
    // did not come, so this read asks no more; bounded: a link of this read
    // was bounded.
    const run = { link: null, cores: new Set(), aborted: false, lost: false, budget: 0, pending: 0, overBudget: false, frameCut: false, candidatePages: 0, candidatesFailed: false, bounded: false, times: { connect: 0, inventory: 0, blocks: 0 } }
    current = run
    const startedAt = clock()
    try {
      return await readWith(run, { limit, cursor: first ? null : after, first })
    } finally {
      slowRead(run, clock() - startedAt)
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

module.exports = { createPeeker, PEEK_SNAPSHOT_MAX_BYTES, PEEK_CORE_PAGE_SIZE, PEEK_MAX_FRAME, SEEDER_BUSY }
