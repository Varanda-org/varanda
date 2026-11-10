'use strict'

// Notices in the browser node (docs/rpc.md 5.28, docs/protocol.md
// 'Notices link'): `notices.list` answers "who started following me and
// whom I do not follow yet, who replied to, quoted or mentioned me, and who
// liked or reposted my posts" HERE, in the browser. One short-lived seeder
// link per read: the node proves on 'varanda/notices/3' (or, when the seeder
// rejects it or leaves it unanswered, 'varanda/notices/2', no likes or
// reposts, or then 'varanda/notices/1', follows only: activity false) that it
// owns its diary key (@varanda/core lib/notices-net.js, member role), reads
// the seeder's candidates ({ key, seq, at, kind } pages, no kind on v1) and
// keeps only the rows it VERIFIED against author-signed blocks fetched into
// MEMORY on the same link.
// The link, the block-0 gate and the budgeted fetch mirror ./peek.js (same
// names where sensible; peek.js internals are not exported).
//
// TRUST MODEL: the seeder can withhold (an edge, a block, a later unfollow it
// keeps to itself) but cannot forge: every row is checked against the
// author's signed block 0 (the gate: certificate for the association with
// the stored revoked issuers, fork 0, quota on the verified length and
// byteLength, before any other block of that diary is requested) and against
// the named block `seq`, which must be the author's signed follow of THIS
// node's key with on: true and the claimed `at`, or the author's signed post
// with the claimed `at`; the head and the signed tail (from the verified
// length, never a seeder-claimed one) are read too and, for a follow, a later
// signed unfollow drops the row. The seeder cannot forge a reply, a quote or
// a mention: the kind is derived here from the signed post and the own
// diary (a reply to or a quote of one of its post blocks, else an '@nome' in
// the text naming one of the usernames the own diary verifiably held, under
// the current revoked issuers), never taken from the seeder's hint; a post
// that earns none is dropped. Nor can it forge a like or a repost: block
// `seq` must be the author's signed like or repost with on: true, the
// claimed `at` and a target in this node's diary, the target must be a post
// the own diary still holds, a later signed toggle of the same target in the
// tail drops the row (an unlike, or a newer like that is the row instead),
// and one author's like (or repost) of one post is one row, the highest seq.
// The kind is the signed block's type, never the hint, and only a v3 read
// lists it. The seeder only serves the notices of the key the channel proved (an Ed25519 signature bound to this link's
// Noise key), and no core is replicated nor any proof signed before its hello
// verified (role 'seeder' and seederCertForKey on the Noise key, as
// ./sync.js). The stored follows, blocklist and revoked issuers are
// re-applied on every read, cached evidence included.
// PRIVACY: ephemeral Noise key, empty inventory, no announce. The proof
// reveals to the seeder only what it already knows: this node's diary key,
// which the sync link advertises on the same IP. Nothing is stored anywhere.
// DATA FLOWS: browser memory only: no kv entry, no replica, nothing written;
// the only storage core opened is the own diary, read (a v2 or v3 read only).
// A small cache keeps the retained evidence of verified rows (block 0,
// profile and username records, the facts block `seq` signed) for
// NOTICES_CACHE_TTL_MS, at most NOTICES_CACHE_MAX rows; every hit re-runs
// the verdict and the kind with the current revoked issuers, own context
// and clock (never a cached name, kind or verdict). A v2 or v3 read also
// reads the own diary once (the session's ownContext, cached on its length).
// COST: one WebSocket + Noise + hello + proof + at most NOTICES_MAX_SEEDER_PAGES
// pages, then per unverified row one memory core and at most
// NOTICES_MAX_BLOCKS_PER_ROW block requests (block 0 alone and first, then
// `seq` alone, then blocks 1..2 and the last PEEK_TAIL_BLOCKS with up to
// NOTICES_WINDOW_INFLIGHT (4) in flight through ./block-window.js, consumed
// strictly highest seq first), NOTICES_PARALLEL rows in flight, under one
// read deadline and one byte budget charged per block as it arrives, in
// flight or already abandoned, and checked before every request. A row's
// first get may always go out, a further one only while every get in flight
// on the link fits under the budget, so in-flight data is bounded by
// NOTICES_PARALLEL x 4 blocks and the overshoot past the budget stays at one
// block per row. A block over MAX_BLOCK_BYTES ends its row. A read over
// NOTICES_SLOW_READ_MS writes one local timing line (connection, support and
// proof, rows). One read at a time.
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
const { attachNotices, attachNoticesV2, attachNoticesV3, NOTICES_REQUEST_TIMEOUT_MS } = require('@varanda/core/lib/notices-net')
const { MAX_FUTURE_MS } = require('@varanda/core/lib/feed')
const { mentionTokens } = require('@varanda/rpc')
const { memoryStorage } = require('./storage')
const { pipeline } = require('./block-window')
const { guardedWsStream } = require('./ws-stream')
const { readerModeration } = require('./member-ops')
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
// Evidence blocks of one row in flight at once after block 0 and `seq`:
// about one round trip per 4 blocks instead of one per block. 8 rows x 4 x
// 16384 bytes stays under PEEK_MAX_FRAME.
const NOTICES_WINDOW_INFLIGHT = 4
// A read slower than this writes one local timing line (never sent).
const NOTICES_SLOW_READ_MS = 1000
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

// Notices order: newest first by Date.parse, then key ascending, then seq
// descending (one author may have several v2 notices at one instant; a v1
// page has one row per key, so seq never decides there).
function compareRows (a, b) {
  return (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (b.seq - a.seq)
}

// Exactly { at, key } or exactly { at, key, seq } (seq >= 1).
function isCursor (v) {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const keys = Object.keys(v)
    const has = (k) => Object.prototype.hasOwnProperty.call(v, k)
    if (!has('at') || !has('key') || !isCanonicalIso(v.at) || !isHex64(v.key)) return false
    if (keys.length === 2) return true
    return keys.length === 3 && has('seq') && Number.isSafeInteger(v.seq) && v.seq >= 1
  } catch {
    return false
  }
}

// The cursor as the channel in use takes it. v2 maps a 2-key cursor to
// seq 1, the lowest of its (at, key) group, so the rest of that group is
// skipped (a 2-key cursor came from a v1 read, where a key had one row);
// v1 has one row per key and takes no seq.
function channelCursor (after, v2) {
  if (after === null) return null
  if (v2) return { at: after.at, key: after.key, seq: after.seq === undefined ? 1 : after.seq }
  return { at: after.at, key: after.key }
}

function cursorOf (row, v2) {
  return v2 ? { at: row.at, key: row.key, seq: row.seq } : { at: row.at, key: row.key }
}

// The notice kind a post block earns against the own context, derived here
// and never taken from the seeder: a reply to or a quote of one of the own
// diary's posts, else a mention of a name the own diary verifiably held.
// -> 'reply' | 'quote' | 'mention' | null.
function postKind (facts, ctx) {
  const ref = (r) => r !== null && r.author === ctx.own && ctx.posts.has(r.seq)
  if (ref(facts.replyTo)) return 'reply'
  if (ref(facts.quote)) return 'quote'
  if (facts.mentions.some((name) => ctx.names.has(name))) return 'mention'
  return null
}

function isEngagement (type) {
  return type === 'like' || type === 'repost'
}

// ownKey: () => Promise<lowercase hex64> (the session's requireOwnKey).
// sign(payload, own): -> 64-byte Ed25519 signature by the identity key for
// the diary key `own`; may throw (locked, mismatch), which rejects the read.
// seenToken(own, key, seq): -> 32 lowercase hex, the row's opaque `seen`
// token keyed by the identity secret; may throw like sign, which rejects the
// read. Computed for the returned rows only, at return time (never cached).
// log(text): warnings. limits: test-only overrides (connectTimeoutMs,
// deadlineMs, budgetBytes, parallel, blockTimeoutMs, maxBlocksPerRow,
// maxSeederPages, cacheTtlMs, cacheMax, requestTimeoutMs, windowInflight,
// maxFrame) and test hooks (now: the slow-read clock; trace(event): every
// block get, its outcome, its charge and every accepted block).
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
    windowInflight: NOTICES_WINDOW_INFLIGHT,
    now: Date.now,
    trace: noop,
    ...(limits || {})
  }

  // key + ':' + seq -> { cachedAt, target, length, seqs, records, at, facts }
  // (facts: what block `seq` signed, never a kind derived from it).
  const cache = new Map()
  let current = null // the running read: { link, cores, aborted, lost, ... }
  let closed = false
  let warnedUnsupported = false

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

  // The read's checkpoints: an aborted read, or one whose link was LOST (the
  // socket closed under it, not cut by its own budget or abort), ends with
  // 'sem conexão com o semeador' and no rows (docs/rpc.md 5.28): a partial
  // read is never reported as a successful incomplete one.
  function checkAborted (run) {
    if (run.aborted || run.lost) throw new Error(NO_SEEDER)
  }

  // ---- the notices link (mirrors peek.js openLink) ----

  // Dials the seeder with an ephemeral Noise key, attaches the muxer, the
  // admission channel with an EMPTY inventory and every notices channel (on
  // the muxer before the hello, so protomux pairs the seeder's open), and
  // resolves once the hello verified exactly as ./sync.js does. The proof is
  // never signed before that: the admission channel opens first, so an
  // honest seeder's hello precedes its challenge. -> the link
  // { noise, peer, notices, noticesV2, noticesV3, verified }; rejects Error('sem conexão com o semeador'),
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
      const link = { noise, peer: null, notices: null, noticesV2: null, noticesV3: null, verified: false }
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
        for (const c of run.cores) c.close().catch(noop)
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
          // Every channel: the read uses v3 when the seeder pairs it, else
          // v2 (no likes or reposts), else v1 (follows only).
          const noticesOpts = {
            role: 'member',
            ownKey: own,
            requestTimeoutMs: L.requestTimeoutMs,
            sign: (payload) => {
              if (!link.verified) throw new Error(NO_SEEDER)
              return sign(payload, own)
            }
          }
          link.notices = attachNotices(noise, noticesOpts)
          link.noticesV2 = attachNoticesV2(noise, noticesOpts)
          link.noticesV3 = attachNoticesV3(noise, noticesOpts)
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
      try { if (link.noticesV2 !== null) link.noticesV2.close() } catch {}
      try { if (link.noticesV3 !== null) link.noticesV3.close() } catch {}
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
  // on the verified state), then block `seq` (a follow of this node, a
  // post, or an on: true like or repost of this node's post, at the claimed
  // `at`), then the head and the signed tail. -> { state: 'ok', evidence } | { state: 'dropped' } |
  // { state: 'pending' } (cut: no verdict, the row is left for a later read).
  // A block that did not arrive or is oversized drops the row and marks the
  // read incomplete. Never throws. Items of one author run one after the
  // other: two memory cores of one key cannot replicate on one link at once.
  async function fetchEvidence (run, item, ctx) {
    const prev = run.keyLocks.get(item.key) || Promise.resolve()
    let release
    const mine = prev.then(() => new Promise((resolve) => { release = resolve }))
    run.keyLocks.set(item.key, mine)
    await prev
    try {
      return await fetchOne(run, item, ctx)
    } finally {
      release()
      if (run.keyLocks.get(item.key) === mine) run.keyLocks.delete(item.key)
    }
  }

  // One raw get on the read's link, counted in run.pending while in flight
  // and charged to the budget on ARRIVAL, exactly once, whether or not the
  // row later uses the block (peek.js getBlock). -> { raw, ok (not
  // oversized), t } or { raw: null, t } when it failed (t: the timeout it
  // was given).
  function getBlock (run, q, key, seq, t) {
    run.pending++
    trace({ type: 'get', key, seq })
    let asked
    try {
      asked = q.get(seq, { raw: true, timeout: t })
    } catch (err) {
      asked = Promise.reject(err)
    }
    return asked.then((raw) => {
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

  async function fetchOne (run, item, ctx) {
    const link = run.link
    if (link === null || ctx.cut()) return { state: 'pending' }
    const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(item.key, 'hex'), { valueEncoding: 'binary' })
    const sessions = new Map() // seq -> the session of its window get in flight
    let win = null
    let closing = null
    // What run.cores holds for this row: every path that ends it (its own
    // end, abort, a lost link, the budget cut) closes through here. Closing
    // q does NOT close its sessions (hypercore 10), so the window gets, each
    // on its own session, are cancelled first, then q. Idempotent.
    const closer = {
      close () {
        if (closing === null) {
          if (win !== null) win.stop()
          const open = [...sessions.values()]
          sessions.clear()
          trace({ type: 'closed', key: item.key, cancelled: open.length })
          closing = Promise.allSettled(open.map((s) => s.close())).then(() => q.close())
        }
        return closing
      }
    }
    run.cores.add(closer)
    const timeout = () => Math.max(1, Math.min(L.blockTimeoutMs, ctx.deadline - Date.now()))
    const PENDING = { state: 'pending' }
    const DROPPED = { state: 'dropped' }
    const failed = () => {
      run.incomplete = true
      return DROPPED
    }
    // A got block -> raw block | PENDING | DROPPED (missing or oversized) |
    // ABSENT (missing, when the caller allows it: a head block).
    const ABSENT = { state: 'absent' }
    const verdict = (got, allowAbsent = false) => {
      if (got === undefined || got.raw === null) {
        // Ended by the budget cut, a lost link, an abort or the read
        // deadline (a timeout shorter than the block timeout): no verdict.
        if (got === undefined || cutLink(run, link) || got.t < L.blockTimeoutMs) return PENDING
        if (allowAbsent) return ABSENT
        return failed()
      }
      if (!got.ok) return failed()
      return got.raw
    }
    // Block 0 and `seq`: alone, one after the other, on q itself.
    const get = async (seq) => {
      if (ctx.cut()) return PENDING
      return verdict(await getBlock(run, q, item.key, seq, timeout()))
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
      const signed = validRecordCopy(decodeBlock(rawF), item.seq)
      if (signed === null || signed.at !== item.at) return DROPPED
      let facts
      if (signed.type === 'follow' && signed.key === ctx.own && signed.on === true) {
        facts = { type: 'follow' }
      } else if (signed.type === 'post') {
        facts = {
          type: 'post',
          replyTo: signed.replyTo === null ? null : { author: signed.replyTo.author, seq: signed.replyTo.seq },
          quote: signed.quote === undefined ? null : { author: signed.quote.author, seq: signed.quote.seq },
          mentions: mentionTokens(signed.text)
        }
      } else if (isEngagement(signed.type) && signed.on === true && signed.to.author === ctx.own) {
        facts = { type: signed.type, to: { author: signed.to.author, seq: signed.to.seq } }
      } else {
        return DROPPED
      }
      seqs.add(item.seq)
      // The head (1..2) and the signed tail, highest first, within the row's
      // block cap (block 0 and `seq` included).
      const wanted = new Set()
      for (let s = length - 1; s >= Math.max(1, length - PEEK_TAIL_BLOCKS); s--) wanted.add(s)
      for (let s = 1; s <= 2 && s < length; s++) wanted.add(s)
      const rest = [...wanted].filter((s) => !seqs.has(s)).sort((a, b) => b - a).slice(0, Math.max(0, L.maxBlocksPerRow - seqs.size))
      // Up to L.windowInflight blocks of this row in flight, consumed
      // strictly highest seq first, so a tombstone comes before its target:
      // a block it deleted is never asked for once it is read (seeders clear
      // it), and one already in flight is not waited for and its get is
      // cancelled; either way it counts as fetched, absent. A head block
      // that did not arrive is not known to be deleted (it may be a live
      // profile or the tombstone of the block below it): it is never
      // counted as fetched, nothing below it is used, the row stands without
      // it, the read is incomplete and the evidence is not cached, so a
      // later read asks again. The row's first window get may always go
      // out; a further one only while every get in flight on the link still
      // fits under the byte budget (peek.js).
      const gone = new Set()
      let partial = false
      let mine = 0
      let consumed = 0
      const GONE = { gone: true }
      win = pipeline({
        seqs: rest,
        inflight: L.windowInflight,
        canStart: () => !ctx.cut() && run.overBudget !== true &&
          (mine === 0 || run.budget + (run.pending + 1) * MAX_BLOCK_BYTES < L.budgetBytes),
        start: (seq) => {
          if (gone.has(seq)) return GONE
          // A row already closed starts nothing (q takes no new session).
          if (closing !== null) return { raw: null, t: 0 }
          mine++
          // Each get on its own session of the memory core: closing that
          // session cancels the get and drops its block request, the only
          // per-request cancel hypercore offers.
          const s = q.session()
          sessions.set(seq, s)
          return getBlock(run, s, item.key, seq, timeout()).finally(() => {
            mine--
            sessions.delete(seq)
            s.close().catch(noop)
          })
        },
        skip: (seq) => gone.has(seq),
        cancel: (seq) => {
          const s = sessions.get(seq)
          if (s !== undefined) s.close().catch(noop)
        }
      })
      try {
        for await (const { seq, result, error } of win) {
          consumed++
          if (error !== undefined) return cutLink(run, link) ? PENDING : failed()
          if (gone.has(seq) || result === GONE) {
            seqs.add(seq)
            continue
          }
          const raw = verdict(result, seq <= 2)
          if (raw === ABSENT) {
            run.incomplete = true
            partial = true
            break
          }
          if (!(raw instanceof Uint8Array)) return raw
          seqs.add(seq)
          const record = decodeBlock(raw)
          entries.push({ seq, record })
          trace({ type: 'accept', key: item.key, seq })
          const copy = validRecordCopy(record, seq)
          if (copy !== null && copy.type === 'delete' && copy.seq >= 1 && copy.seq < length) gone.add(copy.seq)
          if (copy !== null && seq > item.seq) {
            // A later signed unfollow of this node: the seeder's edge is stale.
            if (facts.type === 'follow' && copy.type === 'follow' && copy.key === ctx.own && copy.on === false) return DROPPED
            // A later toggle of the same target: an unlike ends the row, and a
            // later like is the row that stands for it.
            if (copy.type === facts.type && isEngagement(copy.type) && copy.to.author === facts.to.author && copy.to.seq === facts.to.seq) return DROPPED
          }
        }
      } finally {
        // The gets still in flight are cancelled when the row closes below.
        win.stop()
      }
      if (!partial && consumed < rest.length) {
        // The window stopped starting gets: the cut (deadline, budget, lost
        // link, abort). The blocks left that a tombstone already deleted
        // count as fetched, as a serial read skips them without asking; any
        // other one leaves the row without a verdict.
        for (const seq of rest.slice(consumed)) {
          if (!gone.has(seq)) return PENDING
          seqs.add(seq)
        }
      }
      // The signed length and byteLength advance on upgrade (peek.js).
      if (q.fork !== 0 || overQuota(q)) return DROPPED
      return {
        state: 'ok',
        partial,
        evidence: { cachedAt: Date.now(), target: ctx.own, length, seqs, records: retainRecords(entries), at: signed.at, facts }
      }
    } catch {
      return cutLink(run, link) ? PENDING : failed()
    } finally {
      run.cores.delete(closer)
      await closer.close().catch(noop)
    }
  }

  // A follow row: an author already followed is omitted, and an author
  // listed twice counts once (a seeder's duplicate is dropped). -> whether
  // the row may stand.
  function claimFollow (key, ctx) {
    if (ctx.follows.has(key) || ctx.claimed.has(key)) return false
    ctx.claimed.add(key)
    return true
  }

  // -> { state: 'accepted', row, supersedes } | { state: 'dropped' } |
  // { state: 'pending' }; supersedes is null or an earlier accepted row this
  // one replaces (a like or repost of the same post by the same author at a
  // lower seq), which the caller drops.
  // The seeder's kind is only a hint: a v1 item has none and means 'follow';
  // a 'follow' hint is filtered before any block is fetched, and whatever
  // the hint, the kind of the row is the one the signed block proves.
  async function verifyItem (run, item, ctx) {
    const DROPPED = { state: 'dropped' }
    if (item.key === ctx.own || ctx.mod.blocked.has(item.key)) return DROPPED
    const ck = item.key + ':' + item.seq
    if (ctx.claimedSeqs.has(ck)) return DROPPED
    ctx.claimedSeqs.add(ck)
    const hintFollow = item.kind === undefined || item.kind === 'follow'
    if (hintFollow && !claimFollow(item.key, ctx)) return DROPPED
    let evidence = cacheGet(ck, ctx.own)
    if (evidence === null) {
      const r = await fetchEvidence(run, item, ctx)
      if (r.state !== 'ok') return r
      evidence = r.evidence
      if (!r.partial) cacheSet(ck, evidence)
    }
    if (evidence.at !== item.at) return DROPPED
    let kind
    const facts = evidence.facts
    if (facts.type === 'follow') {
      kind = 'follow'
      if (!hintFollow && !claimFollow(item.key, ctx)) return DROPPED
    } else if (isEngagement(facts.type)) {
      // Only a v3 read lists likes and reposts, and only of a post the own
      // diary still holds (a deleted block is not among ctx.posts).
      if (!ctx.v3 || facts.to.author !== ctx.own || !ctx.posts.has(facts.to.seq)) return DROPPED
      if (Date.parse(evidence.at) - Date.now() > MAX_FUTURE_MS) return DROPPED
      kind = facts.type
    } else {
      // A follows-only (v1) read lists follows only.
      kind = ctx.v2 ? postKind(facts, ctx) : null
      if (kind === null || Date.parse(evidence.at) - Date.now() > MAX_FUTURE_MS) return DROPPED
    }
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
    if (v.reason !== null) return DROPPED
    const row = { key: item.key, seq: item.seq, at: item.at, kind, name: v.name, avatar: v.avatar, username: v.username }
    if (!isEngagement(kind)) return { state: 'accepted', row, supersedes: null }
    row.post = facts.to.author + ':' + facts.to.seq
    // One row per (author, post, kind) however many on: true blocks the
    // seeder names: the highest seq, the latest toggle, stands.
    const ref = item.key + ':' + row.post + ':' + kind
    const prior = ctx.claimedEngagements.get(ref)
    if (prior !== undefined && prior.seq > item.seq) return DROPPED
    ctx.claimedEngagements.set(ref, { seq: item.seq, row })
    return { state: 'accepted', row, supersedes: prior === undefined ? null : prior.row }
  }

  // ---- read ----

  function token (own, key, seq) {
    const t = seenToken(own, key, seq)
    if (typeof t !== 'string' || !/^[0-9a-f]{32}$/.test(t)) throw new Error('seen inválido')
    return t
  }

  // ownContext: () => Promise<{ names: Map username -> issuer, posts: Set of
  // seqs }>, the own diary's verified names and post blocks; called only on
  // a v2 or v3 read, so a follows-only read opens no storage core.
  async function readWith (run, { limit, after }, ownContext) {
    const deadline = Date.now() + L.deadlineMs
    // Preparation: kv reads only, no core is opened.
    const own = await ownKey()
    const follows = new Set()
    for (const raw of await store.readFollows(storage)) {
      const key = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (HEX64.test(key)) follows.add(key)
    }
    const mod = await readerModeration(storage, association)
    checkAborted(run)
    // activity is false only on a read that used v1 because the seeder took
    // neither v3 nor v2: every other result says nothing about the seeder's
    // channels and stays neutral (true, no "follows only" banner).
    if (mod.blocked.has(own)) return { notices: [], next: null, incomplete: false, supported: true, activity: true }

    const dialAt = clock()
    let link
    try {
      link = await openLink(run, own)
    } finally {
      run.times.connect += clock() - dialAt
    }
    checkAborted(run)
    const proofAt = clock()
    run.proofAt = proofAt
    const left = () => deadline - Date.now()
    // v3 first, then v2: each carries every older kind. A rejected open
    // settles false at once, so only a channel the seeder leaves unanswered
    // is waited for. v1 is consulted when the seeder took neither, and the
    // channels not used are closed.
    const supportedV3 = await within(link.noticesV3.supported, Math.min(L.requestTimeoutMs, left()))
    checkAborted(run)
    const v3 = supportedV3 === true
    let supportedV2 = true
    if (!v3) supportedV2 = await within(link.noticesV2.supported, Math.min(L.requestTimeoutMs, left()))
    checkAborted(run)
    // v2 here means the v2 shape (seq cursor, activity), which v3 shares.
    const v2 = supportedV2 === true
    let supported = true
    if (!v2) supported = await within(link.notices.supported, Math.max(1, Math.min(L.requestTimeoutMs, left())))
    checkAborted(run)
    // v3 or v2 unanswered and v1 not taken: nothing known yet, the seeder
    // may answer later.
    if ((supportedV3 === TIMEOUT || supportedV2 === TIMEOUT) && supported !== true) return { notices: [], next: null, incomplete: true, supported: true, activity: true }
    if (supported === TIMEOUT) return { notices: [], next: null, incomplete: true, supported: true, activity: true }
    if (supported !== true) {
      if (!warnedUnsupported) {
        warnedUnsupported = true
        warn(UNSUPPORTED)
      }
      return { notices: [], next: null, incomplete: false, supported: false, activity: true }
    }
    const handle = v3 ? link.noticesV3 : v2 ? link.noticesV2 : link.notices
    for (const unused of [link.notices, link.noticesV2, link.noticesV3]) {
      if (unused !== handle) try { unused.close() } catch {}
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
    if (proved !== true) return { notices: [], next: null, incomplete: true, supported: true, activity: true }

    // The names are filtered with the CURRENT revoked issuers on every read
    // (the own context may be cached across reads).
    const names = new Set()
    let posts = new Set()
    if (v2) {
      const oc = await ownContext()
      checkAborted(run)
      for (const [name, issuer] of oc.names) {
        if (!mod.revokedIssuers.has(issuer)) names.add(name)
      }
      posts = oc.posts
    }
    run.times.proof += clock() - proofAt
    run.proofAt = null
    run.rowsAt = clock()

    const cut = () => Date.now() >= deadline - MIN_FETCH_MS || run.budget >= L.budgetBytes || run.lost || run.aborted || run.link === null
    const ctx = { own, follows, mod, deadline, cut, v2, v3, names, posts, claimed: new Set(), claimedSeqs: new Set(), claimedEngagements: new Map() }
    // Every seeder item in seeder order, with its outcome.
    const seen = []
    let accepted = 0
    let more = false
    let cursor = channelCursor(after, v2)
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
          const old = r.supersedes === null ? undefined : seen.find((x) => x.row === r.supersedes)
          if (old !== undefined) {
            old.state = 'dropped'
            old.row = null
            accepted--
          }
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
    run.times.rows = clock() - run.rowsAt
    run.rowsAt = null
    const rows = prefix.filter((e) => e.state === 'accepted').map((e) => e.row).sort(compareRows)
    // The `seen` token of each returned row, after verification and at
    // return time (a lock mid-read throws here, like a locked sign).
    const notices = rows.slice(0, limit).map((row) => ({ ...row, seen: token(own, row.key, row.seq) }))
    const last = notices.length > 0 ? notices[notices.length - 1] : null
    let next = null
    if (rows.length > limit) {
      next = cursorOf(last, v2)
    } else if (more && prefix.length > 0) {
      // Past every row decided, dropped ones included, never before a row
      // returned.
      const edge = prefix[prefix.length - 1].item
      next = cursorOf(last !== null && compareRows(edge, last) < 0 ? last : edge, v2)
    }
    return { notices, next, incomplete: run.incomplete, supported: true, activity: v2 }
  }

  // A read over NOTICES_SLOW_READ_MS writes ONE local line saying where the
  // time went (the Sincronização screen; it never leaves the device). Only
  // durations: no key, no address, nothing the seeder sent.
  function slowRead (run, startedAt) {
    const endAt = clock()
    const total = endAt - startedAt
    if (run.aborted || !(total > NOTICES_SLOW_READ_MS)) return
    // A read that failed among its rows (a lost link) counts them up to now;
    // one that ended during support or proof counts that phase up to now.
    if (run.rowsAt !== null) run.times.rows = endAt - run.rowsAt
    else if (run.proofAt !== null) run.times.proof += endAt - run.proofAt
    const ms = (n) => Math.max(0, Math.round(n)) + ' ms'
    warn('avisos: conexão ' + ms(run.times.connect) + ', suporte e prova ' + ms(run.times.proof) +
      ', linhas ' + ms(run.times.rows) + ', total ' + ms(total))
  }

  // -> { notices, next, incomplete, supported, activity } (docs/rpc.md
  // 5.28; ownContext as readWith). A
  // concurrent read is refused (UsageError 'avisos já em andamento');
  // abort() and a link lost after the hello reject the running one with
  // Error('sem conexão com o semeador') (the session maps it to USAGE). A
  // page timeout or a budget / deadline cut on a live link is an incomplete
  // success.
  async function read ({ limit, after } = {}, ownContext = null) {
    if (closed) throw new Error(NO_SEEDER)
    if (current !== null) throw new UsageError(BUSY)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTICES_LIMIT_MAX) throw new UsageError('limit inválido')
    const first = after === undefined || after === null
    if (!first && !isCursor(after)) throw new UsageError('after inválido')
    // cores: what closes each row in flight (its window gets' sessions,
    // then its memory core). pending: block gets in flight on the link
    // (getBlock). times: ms spent dialling up to the verified hello, on the
    // channel support, the proof and the own context, and on the seeder
    // pages and their rows, for the slow-read line.
    const run = { link: null, cores: new Set(), keyLocks: new Map(), aborted: false, lost: false, budget: 0, pending: 0, overBudget: false, incomplete: false, rowsAt: null, proofAt: null, times: { connect: 0, proof: 0, rows: 0 } }
    current = run
    const startedAt = clock()
    try {
      const cursor = first ? null : after.seq === undefined ? { at: after.at, key: after.key } : { at: after.at, key: after.key, seq: after.seq }
      return await readWith(run, { limit, after: cursor }, typeof ownContext === 'function' ? ownContext : async () => ({ names: new Map(), posts: new Set() }))
    } finally {
      slowRead(run, startedAt)
      closeLink(run)
      for (const c of run.cores) c.close().catch(noop)
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
    for (const c of run.cores) c.close().catch(noop)
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
  NOTICES_CACHE_MAX,
  NOTICES_WINDOW_INFLIGHT,
  NOTICES_SLOW_READ_MS
}
