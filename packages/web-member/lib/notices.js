'use strict'

// Follow notices in the browser node (docs/rpc.md 5.28, docs/protocol.md
// 'Notices link'): `notices.list` answers "who started following me and
// whom I do not follow yet" HERE, in the browser. One short-lived seeder link
// per read: the node proves on 'varanda/notices/1' that it owns its diary key
// (@varanda/core lib/notices-net.js, member role), reads the seeder's
// candidate followers ({ key, seq, at } pages) and keeps only the rows it
// VERIFIED against author-signed blocks fetched into MEMORY on the same link.
// The link, the block-0 gate and the budgeted fetch mirror ./peek.js (same
// names where sensible; peek.js internals are not exported).
//
// TRUST MODEL: the seeder can withhold (an edge, a block, a later unfollow it
// keeps to itself) but cannot forge: every row is checked against the
// author's signed block 0 (the gate: certificate for the association with
// the stored revoked issuers, fork 0, quota on the verified length and
// byteLength, before any other block of that diary is requested) and against
// the named block `seq`, which must be the author's signed follow of THIS
// node's key with on: true and the claimed `at`; the head and the signed tail
// (from the verified length, never a seeder-claimed one) are read too and a
// later signed unfollow drops the row. The seeder only serves the followers
// of the key the channel proved (an Ed25519 signature bound to this link's
// Noise key), and no core is replicated nor any proof signed before its hello
// verified (role 'seeder' and seederCertForKey on the Noise key, as
// ./sync.js). The stored follows, blocklist and revoked issuers are
// re-applied on every read, cached evidence included.
// PRIVACY: ephemeral Noise key, empty inventory, no announce. The proof
// reveals to the seeder only what it already knows: this node's diary key,
// which the sync link advertises on the same IP. Nothing is stored anywhere.
// DATA FLOWS: browser memory only: no kv entry, no storage core, no replica.
// A small cache keeps the retained evidence of verified rows (block 0,
// profile and username records, the follow record) for NOTICES_CACHE_TTL_MS,
// at most NOTICES_CACHE_MAX rows; every hit re-runs the verdict with the
// current revoked issuers and clock (never a cached name or verdict).
// COST: one WebSocket + Noise + hello + proof + at most NOTICES_MAX_SEEDER_PAGES
// pages, then per unverified row one memory core and at most
// NOTICES_MAX_BLOCKS_PER_ROW block requests (block 0, `seq`, blocks 1..2 and
// the last PEEK_TAIL_BLOCKS), NOTICES_PARALLEL rows in flight, under one read
// deadline and one byte budget charged per block as it arrives and checked
// before every request. A block over MAX_BLOCK_BYTES ends its row. One read
// at a time.
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { decodeBlock, validRecordCopy, isHex64, isCanonicalIso, MAX_LOG_BLOCKS, MAX_LOG_BYTES, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { UsageError } = require('@varanda/core/lib/errors')
const { PEEK_CONNECT_TIMEOUT_MS, PEEK_TAIL_BLOCKS, diaryPeek, retainRecords } = require('@varanda/core/lib/peek')
const { NOTICES_LIMIT_MAX } = require('@varanda/core/lib/notices')
const { attachNotices, NOTICES_REQUEST_TIMEOUT_MS } = require('@varanda/core/lib/notices-net')
const { memoryStorage } = require('./storage')
const { guardedWsStream } = require('./ws-stream')
const { moderation } = require('./member-ops')
const { PEEK_CORE_PAGE_SIZE, PEEK_MAX_FRAME, SEEDER_BUSY } = require('./peek')
const store = require('./node-store')

const NOTICES_DEADLINE_MS = 25000
const NOTICES_BUDGET_BYTES = 16777216
const NOTICES_PARALLEL = 8
const NOTICES_BLOCK_TIMEOUT_MS = 10000
const NOTICES_MAX_BLOCKS_PER_ROW = 16
const NOTICES_MAX_SEEDER_PAGES = 8
const NOTICES_CACHE_TTL_MS = 300000
const NOTICES_CACHE_MAX = 512
// No request starts with less than this left on the read deadline (peek.js).
const MIN_FETCH_MS = 250
const NO_SEEDER = 'sem conexão com o semeador'
const BUSY = 'avisos já em andamento'
const UNSUPPORTED = 'aviso: o semeador ainda não envia avisos'
const HEX64 = /^[0-9a-f]{64}$/
const TIMEOUT = Symbol('timeout')

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

function overQuota (core) {
  return core.length > MAX_LOG_BLOCKS || core.byteLength > MAX_LOG_BYTES
}

// Runs fn over items with at most n in flight, in order (peek.js).
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

// Resolves to the promise's value, or TIMEOUT after ms; rejections pass.
function within (promise, ms) {
  let timer
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(1, ms), TIMEOUT) })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

// Notices order: newest first by Date.parse, then key ascending (notices.js).
function compareRows (a, b) {
  return (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

function isCursor (v) {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const keys = Object.keys(v)
    return keys.length === 2 && Object.prototype.hasOwnProperty.call(v, 'at') &&
      Object.prototype.hasOwnProperty.call(v, 'key') && isCanonicalIso(v.at) && isHex64(v.key)
  } catch {
    return false
  }
}

// ownKey: () => Promise<lowercase hex64> (the session's requireOwnKey).
// sign(payload, own): -> 64-byte Ed25519 signature by the identity key for
// the diary key `own`; may throw (locked, mismatch), which rejects the read.
// seenToken(own, key, seq): -> 32 lowercase hex, the row's opaque `seen`
// token keyed by the identity secret; may throw like sign, which rejects the
// read. Computed for the returned rows only, at return time (never cached).
// log(text): warnings. limits: test-only overrides (connectTimeoutMs,
// deadlineMs, budgetBytes, parallel, blockTimeoutMs, maxBlocksPerRow,
// maxSeederPages, cacheTtlMs, cacheMax, requestTimeoutMs, maxFrame).
function createNoticer ({ storage, association, seederUrl, createSocket, ownKey, sign, seenToken, log = noop, limits = {} } = {}) {
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  if (typeof ownKey !== 'function') throw new TypeError('ownKey required')
  if (typeof sign !== 'function') throw new TypeError('sign required')
  if (typeof seenToken !== 'function') throw new TypeError('seenToken required')
  const L = {
    connectTimeoutMs: PEEK_CONNECT_TIMEOUT_MS,
    deadlineMs: NOTICES_DEADLINE_MS,
    budgetBytes: NOTICES_BUDGET_BYTES,
    parallel: NOTICES_PARALLEL,
    blockTimeoutMs: NOTICES_BLOCK_TIMEOUT_MS,
    maxBlocksPerRow: NOTICES_MAX_BLOCKS_PER_ROW,
    maxSeederPages: NOTICES_MAX_SEEDER_PAGES,
    cacheTtlMs: NOTICES_CACHE_TTL_MS,
    cacheMax: NOTICES_CACHE_MAX,
    requestTimeoutMs: NOTICES_REQUEST_TIMEOUT_MS,
    // The link carries bounded notices pages and a few blocks: the peek
    // link's frame bound (./peek.js PEEK_MAX_FRAME) fits it with margin.
    maxFrame: PEEK_MAX_FRAME,
    ...(limits || {})
  }

  // key + ':' + seq -> { cachedAt, target, length, seqs, records, followAt }
  const cache = new Map()
  let current = null // the running read: { link, cores, aborted, lost, ... }
  let closed = false
  let warnedUnsupported = false

  function warn (text) {
    try { log(text) } catch {}
  }

  // The read's checkpoints: an aborted read, or one whose link was LOST (the
  // socket closed under it, not cut by its own budget or abort), ends with
  // 'sem conexão com o semeador' and no rows (docs/rpc.md 5.28): a partial
  // read is never reported as a successful incomplete one.
  function checkAborted (run) {
    if (run.aborted || run.lost) throw new Error(NO_SEEDER)
  }

  // ---- the notices link (mirrors peek.js openLink) ----

  // Dials the seeder with an ephemeral Noise key, attaches the muxer, the
  // admission channel with an EMPTY inventory and the notices channel (on
  // the muxer before the hello, so protomux pairs the seeder's open), and
  // resolves once the hello verified exactly as ./sync.js does. The proof is
  // never signed before that: the admission channel opens first, so an
  // honest seeder's hello precedes its challenge. -> the link
  // { noise, peer, notices, verified }; rejects Error('sem conexão com o semeador'),
  // or UsageError(SEEDER_BUSY) when the socket closed with 1013 (a fixed
  // text, never the seeder's). The link runs behind a frame guard
  // (./ws-stream.js guardedWsStream): a frame over maxFrame is cut at its
  // header with a warning and the link is lost (the read fails, no rows).
  function openLink (run, own) {
    return new Promise((resolve, reject) => {
      let socket
      try {
        socket = createSocket(seederUrl)
      } catch {
        reject(new Error(NO_SEEDER))
        return
      }
      let noise = null
      const { ws, stream } = guardedWsStream(socket, {
        maxFrame: L.maxFrame,
        onLimit: () => {
          warn('aviso: quadro grande demais do semeador')
          if (noise !== null) noise.destroy()
        }
      })
      noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
      noise.on('error', noop)
      const link = { noise, peer: null, notices: null, verified: false }
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
        // A link lost under the read (not closed by its budget cut, its
        // abort or its end): the fetches in flight end now (their cores are
        // closed) and the read fails at its next checkpoint.
        if (run.link === link && !run.aborted && !run.overBudget) run.lost = true
        for (const q of run.cores) q.close().catch(noop)
        finish(ws.closeCode === 1013 ? new UsageError(SEEDER_BUSY) : new Error(NO_SEEDER))
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
                return
              }
              finish(null)
            },
            log: (ev) => {
              if (ev && ev.event === 'peer-dropped') warn('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
            }
          })
          link.notices = attachNotices(noise, {
            role: 'member',
            ownKey: own,
            requestTimeoutMs: L.requestTimeoutMs,
            sign: (payload) => {
              if (!link.verified) throw new Error(NO_SEEDER)
              return sign(payload, own)
            }
          })
        } catch {
          finish(new Error(NO_SEEDER))
        }
      })
    })
  }

  // Whether this read's link was cut under a fetch (budget, lost link,
  // abort): what failed then says nothing about the row.
  function cutLink (run, link) {
    return run.lost || run.aborted || run.overBudget === true || link === null || link.noise.destroyed
  }

  function closeLink (run) {
    const link = run.link
    run.link = null
    if (link !== null) {
      try { if (link.notices !== null) link.notices.close() } catch {}
      link.noise.destroy()
    }
  }

  // Charges a received block to the read's budget (peek.js charge): over it,
  // the link is destroyed, which ends every get in flight. -> false when the
  // block itself is oversized.
  function charge (run, raw) {
    run.budget += raw.byteLength
    if (run.budget >= L.budgetBytes && run.link !== null) {
      run.overBudget = true
      closeLink(run)
    }
    return raw.byteLength <= MAX_BLOCK_BYTES
  }

  // ---- the cache ----

  function cacheGet (ck, own) {
    const e = cache.get(ck)
    if (e === undefined) return null
    if (Date.now() - e.cachedAt > L.cacheTtlMs || e.target !== own) {
      cache.delete(ck)
      return null
    }
    return e
  }

  function cacheSet (ck, evidence) {
    cache.delete(ck)
    cache.set(ck, evidence)
    while (cache.size > L.cacheMax) cache.delete(cache.keys().next().value)
  }

  // ---- verifying one row ----

  // The signed evidence for one seeder item, fetched into a fresh memory
  // core on the read's link: block 0 alone first (the gate, fork and quota
  // on the verified state), then block `seq` (the follow), then the head and
  // the signed tail. -> { state: 'ok', evidence } | { state: 'dropped' } |
  // { state: 'pending' } (cut: no verdict, the row is left for a later read).
  // A block that did not arrive or is oversized drops the row and marks the
  // read incomplete. Never throws.
  async function fetchEvidence (run, item, ctx) {
    const link = run.link
    if (link === null || ctx.cut()) return { state: 'pending' }
    const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(item.key, 'hex'), { valueEncoding: 'binary' })
    run.cores.add(q)
    const timeout = () => Math.max(1, Math.min(L.blockTimeoutMs, ctx.deadline - Date.now()))
    const PENDING = { state: 'pending' }
    const DROPPED = { state: 'dropped' }
    const failed = () => {
      run.incomplete = true
      return DROPPED
    }
    // -> raw block | PENDING | DROPPED (missing or oversized).
    const get = async (seq) => {
      if (ctx.cut()) return PENDING
      const t = timeout()
      let raw = null
      try {
        raw = await q.get(seq, { raw: true, timeout: t })
      } catch {}
      if (raw === null) {
        // Ended by the budget cut, a lost link, an abort or the read
        // deadline (a timeout shorter than the block timeout): no verdict.
        if (cutLink(run, link) || t < L.blockTimeoutMs) return PENDING
        return failed()
      }
      if (!charge(run, raw)) return failed()
      return raw
    }
    try {
      await q.ready()
      if (cutLink(run, link)) return PENDING
      q.replicate(link.noise)
      const raw0 = await get(0)
      if (!(raw0 instanceof Uint8Array)) return raw0
      // The signed length: what Hypercore verified with the upgrade proof.
      const length = q.length
      const seqs = new Set([0])
      const entries = [{ seq: 0, record: decodeBlock(raw0) }]
      const gate = diaryPeek({ key: item.key, length, entries, fetched: seqs, association, revokedIssuers: ctx.mod.revokedIssuers, now: Date.now() })
      if (gate.reason !== null || q.fork !== 0 || overQuota(q) || item.seq >= length) return DROPPED
      const rawF = await get(item.seq)
      if (!(rawF instanceof Uint8Array)) return rawF
      const follow = validRecordCopy(decodeBlock(rawF), item.seq)
      if (follow === null || follow.type !== 'follow' || follow.key !== ctx.own || follow.on !== true || follow.at !== item.at) return DROPPED
      seqs.add(item.seq)
      // The head (1..2) and the signed tail, highest first, within the row's
      // block cap (block 0 and `seq` included).
      const wanted = new Set()
      for (let s = length - 1; s >= Math.max(1, length - PEEK_TAIL_BLOCKS); s--) wanted.add(s)
      for (let s = 1; s <= 2 && s < length; s++) wanted.add(s)
      const rest = [...wanted].filter((s) => !seqs.has(s)).sort((a, b) => b - a).slice(0, Math.max(0, L.maxBlocksPerRow - seqs.size))
      for (const seq of rest) {
        const raw = await get(seq)
        if (!(raw instanceof Uint8Array)) return raw
        seqs.add(seq)
        const record = decodeBlock(raw)
        entries.push({ seq, record })
        if (seq > item.seq) {
          const copy = validRecordCopy(record, seq)
          // A later signed unfollow of this node: the seeder's edge is stale.
          if (copy !== null && copy.type === 'follow' && copy.key === ctx.own && copy.on === false) return DROPPED
        }
      }
      // The signed length and byteLength advance on upgrade (peek.js).
      if (q.fork !== 0 || overQuota(q)) return DROPPED
      return {
        state: 'ok',
        evidence: { cachedAt: Date.now(), target: ctx.own, length, seqs, records: retainRecords(entries), followAt: follow.at }
      }
    } catch {
      return cutLink(run, link) ? PENDING : failed()
    } finally {
      run.cores.delete(q)
      await q.close().catch(noop)
    }
  }

  // -> { state: 'accepted', row } | { state: 'dropped' } | { state: 'pending' }.
  async function verifyItem (run, item, ctx) {
    if (item.key === ctx.own || ctx.mod.blocked.has(item.key) || ctx.follows.has(item.key)) return { state: 'dropped' }
    // A key listed twice counts once (a seeder's duplicate is dropped).
    if (ctx.claimed.has(item.key)) return { state: 'dropped' }
    ctx.claimed.add(item.key)
    const ck = item.key + ':' + item.seq
    let evidence = cacheGet(ck, ctx.own)
    if (evidence === null) {
      const r = await fetchEvidence(run, item, ctx)
      if (r.state !== 'ok') return r
      evidence = r.evidence
      cacheSet(ck, evidence)
    }
    if (evidence.followAt !== item.at) return { state: 'dropped' }
    // The verdict, always fresh: certificate with the CURRENT revoked
    // issuers (block 0 is among the retained records) and the name and
    // username of the retained records (peek.js refresh).
    const v = diaryPeek({
      key: item.key,
      length: evidence.length,
      entries: evidence.records,
      fetched: evidence.seqs,
      association,
      revokedIssuers: ctx.mod.revokedIssuers,
      now: Date.now()
    })
    if (v.reason !== null) return { state: 'dropped' }
    return { state: 'accepted', row: { key: item.key, seq: item.seq, at: item.at, name: v.name, avatar: v.avatar, username: v.username } }
  }

  // ---- read ----

  function token (own, key, seq) {
    const t = seenToken(own, key, seq)
    if (typeof t !== 'string' || !/^[0-9a-f]{32}$/.test(t)) throw new Error('seen inválido')
    return t
  }

  async function readWith (run, { limit, after }) {
    const deadline = Date.now() + L.deadlineMs
    // Preparation: kv reads only, no core is opened.
    const own = await ownKey()
    const follows = new Set()
    for (const raw of await store.readFollows(storage)) {
      const key = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (HEX64.test(key)) follows.add(key)
    }
    const mod = await moderation(storage, association)
    checkAborted(run)
    if (mod.blocked.has(own)) return { notices: [], next: null, incomplete: false, supported: true }

    const link = await openLink(run, own)
    checkAborted(run)
    const handle = link.notices
    const left = () => deadline - Date.now()
    const supported = await within(handle.supported, Math.min(L.requestTimeoutMs, left()))
    checkAborted(run)
    if (supported === TIMEOUT) return { notices: [], next: null, incomplete: true, supported: true }
    if (supported !== true) {
      if (!warnedUnsupported) {
        warnedUnsupported = true
        warn(UNSUPPORTED)
      }
      return { notices: [], next: null, incomplete: false, supported: false }
    }
    let proved
    try {
      proved = await within(handle.proved, Math.min(L.requestTimeoutMs, left()))
    } catch (err) {
      checkAborted(run)
      throw err // the identity is locked, or another diary's pair
    }
    checkAborted(run)
    // A proof not sent on a live link within the request timeout: nothing
    // was read, the seeder may answer later.
    if (proved !== true) return { notices: [], next: null, incomplete: true, supported: true }

    const cut = () => Date.now() >= deadline - MIN_FETCH_MS || run.budget >= L.budgetBytes || run.lost || run.aborted || run.link === null
    const ctx = { own, follows, mod, deadline, cut, claimed: new Set() }
    // Every seeder item in seeder order, with its outcome.
    const seen = []
    let accepted = 0
    let more = false
    let cursor = after
    let pages = 0
    while (true) {
      if (pages >= L.maxSeederPages || cut()) {
        more = true
        run.incomplete = true
        break
      }
      let page
      const asked = handle.requestPage({ after: cursor, limit: NOTICES_LIMIT_MAX })
      asked.catch(noop)
      try {
        page = await within(asked, left())
      } catch {
        page = TIMEOUT // page timed out or channel closed: the read is incomplete
      }
      checkAborted(run) // unless the link itself was lost: NO_SEEDER
      if (page === TIMEOUT) {
        more = true
        run.incomplete = true
        break
      }
      pages++
      if (page.incomplete) run.incomplete = true
      const entries = page.items.map((item) => ({ item, state: 'pending', row: null }))
      seen.push(...entries)
      await pool(entries, L.parallel, async (e) => {
        if (run.aborted || accepted >= limit) return
        if (cut()) {
          run.incomplete = true
          return
        }
        const r = await verifyItem(run, e.item, ctx)
        e.state = r.state
        if (r.state === 'accepted') {
          e.row = r.row
          accepted++
        } else if (r.state === 'pending') {
          run.incomplete = true
        }
      })
      checkAborted(run) // a link lost under a block fetch: NO_SEEDER, no rows
      if (entries.some((e) => e.state === 'pending')) {
        more = true
        break
      }
      if (page.next === null) break
      cursor = page.next
      if (accepted >= limit) {
        more = true
        break
      }
    }

    // Only the prefix of the seeder's order that was fully decided counts:
    // a row decided after a pending one would make the cursor skip it.
    const prefix = []
    for (const e of seen) {
      if (e.state === 'pending') break
      prefix.push(e)
    }
    const rows = prefix.filter((e) => e.state === 'accepted').map((e) => e.row).sort(compareRows)
    // The `seen` token of each returned row, after verification and at
    // return time (a lock mid-read throws here, like a locked sign).
    const notices = rows.slice(0, limit).map((row) => ({ ...row, seen: token(own, row.key, row.seq) }))
    const last = notices.length > 0 ? notices[notices.length - 1] : null
    let next = null
    if (rows.length > limit) {
      next = { at: last.at, key: last.key }
    } else if (more && prefix.length > 0) {
      // Past every row decided, dropped ones included, never before a row
      // returned.
      const edge = prefix[prefix.length - 1].item
      next = last !== null && compareRows(edge, last) < 0 ? { at: last.at, key: last.key } : { at: edge.at, key: edge.key }
    }
    return { notices, next, incomplete: run.incomplete, supported: true }
  }

  // -> { notices, next, incomplete, supported } (docs/rpc.md 5.28). A
  // concurrent read is refused (UsageError 'avisos já em andamento');
  // abort() and a link lost after the hello reject the running one with
  // Error('sem conexão com o semeador') (the session maps it to USAGE). A
  // page timeout or a budget / deadline cut on a live link is an incomplete
  // success.
  async function read ({ limit, after } = {}) {
    if (closed) throw new Error(NO_SEEDER)
    if (current !== null) throw new UsageError(BUSY)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTICES_LIMIT_MAX) throw new UsageError('limit inválido')
    const first = after === undefined || after === null
    if (!first && !isCursor(after)) throw new UsageError('after inválido')
    const run = { link: null, cores: new Set(), aborted: false, lost: false, budget: 0, overBudget: false, incomplete: false }
    current = run
    try {
      return await readWith(run, { limit, after: first ? null : { at: after.at, key: after.key } })
    } finally {
      closeLink(run)
      for (const q of run.cores) q.close().catch(noop)
      // Guarded by identity: an aborted read never touches a newer one.
      if (current === run) current = null
    }
  }

  // Destroys the link and ends the running read, and releases the slot at
  // once (peek.js abort): the aborted read throws at its next checkpoint
  // without touching a newer read's state.
  function abort () {
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
    cache.clear()
  }

  // Test hook only (not part of the session's API): cached rows.
  function cacheSize () {
    return cache.size
  }

  return { read, abort, close, cacheSize }
}

module.exports = {
  createNoticer,
  NOTICES_DEADLINE_MS,
  NOTICES_BUDGET_BYTES,
  NOTICES_PARALLEL,
  NOTICES_BLOCK_TIMEOUT_MS,
  NOTICES_MAX_BLOCKS_PER_ROW,
  NOTICES_MAX_SEEDER_PAGES,
  NOTICES_CACHE_TTL_MS,
  NOTICES_CACHE_MAX
}
