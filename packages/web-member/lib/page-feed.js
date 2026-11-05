'use strict'

// A Rua of a page in the browser node (docs/rpc.md 5.86): `page.feed`
// answers the newest feed rows of the diaries a page follows, read HERE over
// one short-lived seeder link into memory cores. Nothing is appended to the
// caller's diary or the page's, no follow is written and no core is stored.
// The link is built like ./notices.js and ./peek.js (an ephemeral Noise key,
// an EMPTY inventory, no announce, the hello verified as ./sync.js does), so
// the seeder cannot bind this browsing to the member's sync link.
//
// TRUST MODEL: the seeder can withhold, never forge. Each key is gated on
// its signed block 0 before any other block of it is asked for: blocked
// keys are skipped before a core exists, then the certificate for the
// association with the stored revoked issuers, fork 0 and quota on the
// verified length. Every block is verified by Hypercore against the signed
// tree. Per diary the head (PEEK_HEAD_BLOCKS) and the newest
// PEEK_TAIL_BLOCKS are read (core peekWindow), newest first, so a tombstone
// is read before its target. A personal diary's target, which seeders
// clear, is never asked for. A page diary's target in the window is asked
// for after the walk (docs/protocol.md §12): the fold ignores a tombstone
// over a page-* record only when it holds the target, so a leaked page key
// must not hide a page-close or page-moved by deleting it. Seeders never
// clear a page-* block; the targets at 1 and 2 are asked one at a time
// (they settle whether the diary may be a page), the rest at once, and one
// the seeder does not advertise is waited for TARGET_PROBE_MS at most (one
// shared timer per diary) and then counts as deleted. With a gap between
// the head and the tail, only the tail run gives rows (the Espiadinha's
// rule): a tombstone in the gap is never seen, so a head post it deleted
// must not show. The fold is feed.read's (buildFeed, which applies the
// tombstones) after the moved cut: a diary whose RAW entries hold a verified
// page-moved (or page-close) contributes nothing above it.
// END POINTER: a close or move further back than the window would be
// missed when a leaked page key appended after it, so for a diary that may
// be a page (also one whose block 2 is unread only because a tombstone
// names it: the leaked key may delete the roster and the close) the
// seeder's name index is asked for the seq of the first verified close or
// move (GET /index/page-end/<key> on the seeder's host) and that block is
// ALWAYS fetched on its own here. It joins the entries only when it
// verifies as this diary's close or move; anything else is dropped unseen,
// so a pointer at a person's deleted post never shows it. The seeder's
// word is a pointer: a seq whose block does not arrive in time or does not
// verify as a close or move at or below it makes the diary incomplete and
// drops its rows above the head (fail closed); no answer changes nothing
// (the seeder can withhold, as for any block).
// COST: one WebSocket + Noise + hello, then per key one memory core, at
// most PEEK_MAX_BLOCKS_PER_DIARY block requests plus the pointed block, and
// for a diary that may be a page one GET of at most END_MAX_BYTES,
// PEEK_PARALLEL keys in flight, ONE block in flight per key during the
// walk, under one deadline (25 s) and one byte budget (16 MiB) charged per
// block as it arrives. One read at a time.
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { decodeBlock, validRecordCopy, validateRecord, MAX_LOG_BLOCKS, MAX_LOG_BYTES, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { seederCertForKey, certForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { UsageError } = require('@varanda/core/lib/errors')
const {
  PEEK_PARALLEL,
  PEEK_FETCH_TIMEOUT_MS,
  PEEK_PAGE_TIMEOUT_MS,
  PEEK_CONNECT_TIMEOUT_MS,
  PEEK_PAGE_MAX_BYTES,
  PEEK_HEAD_BLOCKS,
  peekWindow
} = require('@varanda/core/lib/peek')
const { applyDeletes } = require('@varanda/core/lib/deletion')
const { buildFeed } = require('@varanda/core/lib/feed')
const { pageLifecycle, cutEntries, verifyClose, verifyMoved } = require('@varanda/core/lib/page-lifecycle')
const { memoryStorage } = require('./storage')
const { guardedWsStream } = require('./ws-stream')
const { moderation } = require('./member-ops')
const { PEEK_CORE_PAGE_SIZE, PEEK_MAX_FRAME, SEEDER_BUSY } = require('./peek')

const MIN_FETCH_MS = 250
const TARGET_PROBE_MS = 1000
const ROSTER_SEQ = 2
const CLOSE_TRY_AGAIN = 1013
const NO_SEEDER = 'sem conexão com o semeador'
const BUSY = 'feed de página já em andamento'
const FRAME_TOO_LARGE = 'aviso: quadro grande demais do semeador'
const HEX64 = /^[0-9a-f]{64}$/
const END_MAX_BYTES = 1024
const OVERSIZED = Symbol('oversized')

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

function overQuota (core) {
  return core.length > MAX_LOG_BLOCKS || core.byteLength > MAX_LOG_BYTES
}

// The seq a valid tombstone at `seq` deletes, or null (./peek.js).
function tombstoneTarget (record, seq, length) {
  const copy = validRecordCopy(record, seq)
  return copy !== null && copy.type === 'delete' && copy.seq >= 1 && copy.seq < length ? copy.seq : null
}

// Whether the diary read so far may be a page diary (lib/deletion.js
// pageTargets): a page-roster at 1 or 2 (the genesis puts it at 2) says
// yes, another record at 2 says no, and a block 2 not read says maybe.
function mayBePage (entries) {
  let second = false
  for (const e of entries) {
    if (e.seq !== 1 && e.seq !== ROSTER_SEQ) continue
    const copy = validRecordCopy(e.record, e.seq)
    if (copy !== null && copy.type === 'page-roster') return true
    if (e.seq === ROSTER_SEQ) second = true
  }
  return !second
}

// Whether a block the seeder's end pointer named is a verified page-close
// or page-move of THIS diary (lib/page-lifecycle.js; the countersigned
// check binds `page` to the key).
function terminalFor (record, key, association, revokedIssuers) {
  const opts = { revokedIssuers }
  return verifyClose(record, key, association, opts).ok || verifyMoved(record, key, association, opts).ok
}

// Whether the seeder peer advertised block seq (Hypercore 10.38.2: its
// contiguous range, then its bitfield; see ./sync.js seederHoldsMedia).
function advertised (core, seq) {
  try {
    for (const peer of core.peers) {
      if (seq < peer.remoteContiguousLength || peer.remoteBitfield.get(seq) === true) return true
    }
  } catch {}
  return false
}

// Whether block 0's certificate fails only because its issuer is revoked.
function revokedAt0 (entries, key, association, revokedIssuers) {
  if (revokedIssuers.size === 0 || entries.length === 0 || entries[0].seq !== 0) return false
  const first = entries[0].record
  if (validateRecord(first, 0) !== null) return false
  return certForKey(first.cert, key, association, { revokedIssuers }).reason === 'revoked-issuer'
}

// The lowest seq of the run of covered seqs that reaches the top.
function tailFloor (length, covered) {
  let floor = length
  while (floor > 0 && covered.has(floor - 1)) floor--
  return floor
}

// What feed.read folds of a diary read from `floor` up: block 0 and the
// tail run; past a gap, a head block only lends the name (the head's
// newest profile or username, unless the tail has its own), never a row.
function feedEntries (entries, floor) {
  if (floor === 0) return entries
  const tail = entries.filter((e) => e.seq === 0 || e.seq >= floor)
  const own = new Set()
  for (const e of tail) {
    const copy = e.seq === 0 ? null : validRecordCopy(e.record, e.seq)
    if (copy !== null) own.add(copy.type)
  }
  const head = applyDeletes(entries.filter((e) => e.seq > 0 && e.seq < Math.min(floor, PEEK_HEAD_BLOCKS)))
  const lent = []
  for (const e of head) {
    const copy = e.record === null ? null : validRecordCopy(e.record, e.seq)
    if (copy !== null && (copy.type === 'profile' || copy.type === 'username') && !own.has(copy.type)) lent.push(e)
  }
  return [...lent, ...tail].sort((a, b) => a.seq - b.seq)
}

// The seq of the verified terminal close or move, or null.
function endOf (lifecycle) {
  const seqs = [lifecycle.closed?.seq, lifecycle.movedTo?.seq].filter(Number.isSafeInteger)
  return seqs.length === 0 ? null : Math.min(...seqs)
}

// The seeder's /index/page-end route on the host of its WebSocket address
// (seed-ws serves /seeder and /index/* on one listener), or null.
// The lookup runs outside the seeder's Noise session, so it needs TLS: a
// plain ws: seeder gets no pointer unless it is on this machine.
function pageEndUrl (seederUrl, key) {
  try {
    const url = new URL('/index/page-end/' + key, seederUrl)
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'wss:' && !loopback) return null
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    return url.href
  } catch {
    return null
  }
}

// Runs fn over items with at most n in flight.
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

function createPageFeeder ({ storage, association, seederUrl, createSocket, fetch: fetchFn = globalThis.fetch, log = noop, limits = {} } = {}) {
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  const L = {
    connectTimeoutMs: PEEK_CONNECT_TIMEOUT_MS,
    deadlineMs: PEEK_PAGE_TIMEOUT_MS,
    fetchTimeoutMs: PEEK_FETCH_TIMEOUT_MS,
    maxBytes: PEEK_PAGE_MAX_BYTES,
    parallel: PEEK_PARALLEL,
    maxFrame: PEEK_MAX_FRAME,
    ...(limits || {})
  }
  let current = null
  let closed = false

  function warn (text) {
    try { log(text) } catch {}
  }

  function checkAborted (run) {
    if (run.aborted) throw new Error(NO_SEEDER)
  }

  // The link of ./peek.js openLink: resolves once the seeder's hello
  // verified and its inventory arrived; rejects Error(NO_SEEDER), or
  // UsageError(SEEDER_BUSY) on a 1013 close.
  function openLink (run) {
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
          run.cut = true
          warn(FRAME_TOO_LARGE)
          if (noise !== null) noise.destroy()
        }
      })
      noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
      noise.on('error', noop)
      const link = { noise, verified: false }
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
          Hypercore.createProtocolStream(noise)
          attachAdmission(noise, {
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
            oninventory: () => {
              if (link.verified) finish(null)
            },
            log: noop
          })
        } catch {
          finish(new Error(NO_SEEDER))
        }
      })
    })
  }

  function closeLink (run) {
    const link = run.link
    run.link = null
    if (link !== null) link.noise.destroy()
  }

  function linkDown (run, link) {
    return run.aborted || run.lost || run.overBudget || link === null || link.noise.destroyed
  }

  // -> false when the block is oversized. Over the budget the link is cut,
  // which ends every get in flight.
  function charge (run, raw) {
    run.budget += raw.byteLength
    if (run.budget >= L.maxBytes && run.link !== null) {
      run.overBudget = true
      closeLink(run)
    }
    return raw.byteLength <= MAX_BLOCK_BYTES
  }

  // Block seq of q: the raw block, null when not served in time, or
  // OVERSIZED. An unadvertised block is waited for until `until` at most
  // (null: the whole fetch timeout), then asked again if the seeder
  // advertised it meanwhile. Charged as it arrives.
  async function probeBlock (run, link, q, seq, until) {
    const full = timeout(run)
    const probe = until === null || advertised(q, seq) ? full : Math.min(full, until - Date.now())
    let raw = null
    if (probe >= 1) {
      try {
        raw = await q.get(seq, { raw: true, timeout: probe })
      } catch {}
    }
    if (raw === null && probe < full && advertised(q, seq) && !linkDown(run, link)) {
      try {
        raw = await q.get(seq, { raw: true, timeout: Math.max(MIN_FETCH_MS, timeout(run)) })
      } catch {}
    }
    if (raw === null) return null
    return charge(run, raw) ? raw : OVERSIZED
  }

  // GET /index/page-end/<key> on the seeder's host: the seq of the first
  // verified close or move its name index noted, or null (none, no answer,
  // a bad shape, a seq outside the log). Bounded by the fetch timeout and
  // END_MAX_BYTES, charged to the byte budget. Withholding it changes
  // nothing; a lie is caught by the verification of the block.
  async function seederEnd (run, key, length) {
    const url = pageEndUrl(seederUrl, key)
    const t = timeout(run)
    if (typeof fetchFn !== 'function' || url === null || t < MIN_FETCH_MS || run.aborted || run.overBudget) return null
    const ctl = new AbortController()
    run.requests.add(ctl)
    const timer = setTimeout(() => ctl.abort(), t)
    try {
      const res = await fetchFn(url, { signal: ctl.signal, credentials: 'omit', redirect: 'error' })
      if (!res || res.status !== 200 || !res.body) return null
      const reader = res.body.getReader()
      const chunks = []
      let n = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        n += value.byteLength
        if (n > END_MAX_BYTES) {
          reader.cancel().catch(noop)
          return null
        }
        chunks.push(value)
      }
      charge(run, { byteLength: n })
      const body = JSON.parse(b4a.toString(b4a.concat(chunks)))
      const seq = body !== null && typeof body === 'object' ? body.endSeq : null
      return Number.isSafeInteger(seq) && seq >= 1 && seq < length ? seq : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      run.requests.delete(ctl)
    }
  }

  function timeout (run) {
    return Math.min(L.fetchTimeoutMs, run.deadline - Date.now())
  }

  // -> { entries, partial } for a diary that passed the gate, { skip } for
  // one the gate refused, { unserved } for one that did not arrive.
  async function fetchDiary (run, key, mod) {
    const link = run.link
    if (mod.blocked.has(key)) return { skip: 'blocked' }
    if (linkDown(run, link)) return { unserved: true }
    const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(key, 'hex'), { valueEncoding: 'binary' })
    run.cores.add(q)
    try {
      await q.ready()
      if (linkDown(run, link)) return { unserved: true }
      q.replicate(link.noise)
      let t = timeout(run)
      if (t < MIN_FETCH_MS) return { unserved: true }
      let raw0 = null
      try {
        raw0 = await q.get(0, { raw: true, timeout: t })
      } catch {}
      if (raw0 === null) return { unserved: true }
      if (!charge(run, raw0)) return { skip: 'oversized' }
      const first = decodeBlock(raw0)
      if (validateRecord(first, 0) !== null) return { skip: 'not-in-log' }
      if (!certForKey(first.cert, key, association, { revokedIssuers: mod.revokedIssuers }).ok) return { skip: 'cert' }
      if (q.fork !== 0 || overQuota(q)) return { skip: 'quota' }
      const length = q.length
      const entries = [{ seq: 0, record: first }]
      const gone = new Set()
      const targets = []
      let partial = false
      for (const seq of peekWindow(length, new Set([0]))) {
        if (gone.has(seq)) {
          targets.push(seq)
          continue
        }
        t = timeout(run)
        if (t < MIN_FETCH_MS || linkDown(run, link)) {
          partial = true
          break
        }
        let raw
        try {
          raw = await q.get(seq, { raw: true, timeout: t })
        } catch {
          partial = true
          break
        }
        if (!charge(run, raw)) {
          partial = true
          break
        }
        const record = decodeBlock(raw)
        entries.push({ seq, record })
        const target = tombstoneTarget(record, seq, length)
        if (target !== null) gone.add(target)
      }
      // A page diary's targets. One not served stays in `gone`; one served
      // joins the entries, where buildFeed drops it unless it is a page-*
      // record, which keeps the moved cut. An unheld block 2 named by a
      // tombstone may be a person's deleted block, so the other targets
      // stay unasked (privacy); the end pointer below is still asked.
      const personal = gone.has(ROSTER_SEQ) && !entries.some((e) => e.seq === ROSTER_SEQ)
      const asked = personal ? [] : targets.sort((a, b) => a - b)
      // Targets at 1 and 2 first, one at a time: they settle mayBePage.
      let next = 0
      for (; next < asked.length && asked[next] <= ROSTER_SEQ && !partial; next++) {
        if (!mayBePage(entries)) break
        if (timeout(run) < MIN_FETCH_MS || linkDown(run, link)) {
          partial = true
          break
        }
        const got = await probeBlock(run, link, q, asked[next], Date.now() + TARGET_PROBE_MS)
        if (got === OVERSIZED) partial = true
        else if (got !== null) entries.push({ seq: asked[next], record: decodeBlock(got) })
      }
      // The seeder's pointer to the first verified close or move
      // (docs/protocol.md §12), asked for every diary that may be a page,
      // also when block 2 is unread only because a tombstone names it (a
      // leaked page key may delete the roster and the close together).
      const maybe = mayBePage(entries)
      const page = !personal && maybe
      const end = maybe ? await seederEnd(run, key, length) : null
      // The other targets (a page's only) at once under ONE probe timer, and
      // the pointed block on its own with the whole fetch timeout, wherever
      // it is. The pointed block joins the entries ONLY when it verifies as
      // this diary's close or move: anything else (a person's deleted post
      // a hostile seeder points at) is dropped unseen, and readWith then
      // fails closed on the unverified pointer.
      const batch = page && !partial ? asked.slice(next).filter((seq) => seq !== end) : []
      const pointed = end !== null && !entries.some((e) => e.seq === end)
      if (batch.length > 0 || pointed) {
        if (timeout(run) < MIN_FETCH_MS || linkDown(run, link)) {
          partial = true
        } else {
          const probeUntil = Date.now() + TARGET_PROBE_MS
          const [got, last] = await Promise.all([
            Promise.all(batch.map((seq) => probeBlock(run, link, q, seq, probeUntil))),
            pointed ? probeBlock(run, link, q, end, null) : null
          ])
          for (let i = 0; i < batch.length; i++) {
            if (got[i] === OVERSIZED) partial = true
            else if (got[i] !== null) entries.push({ seq: batch[i], record: decodeBlock(got[i]) })
          }
          if (last !== null && last !== OVERSIZED) {
            const record = decodeBlock(last)
            if (terminalFor(record, key, association, mod.revokedIssuers)) entries.push({ seq: end, record })
          }
        }
      }
      if (q.fork !== 0 || overQuota(q)) return { skip: 'quota' }
      // A deleted block skipped counts as read: it shows nothing either way.
      const covered = new Set(gone)
      for (const e of entries) covered.add(e.seq)
      return { entries: entries.sort((a, b) => a.seq - b.seq), partial, floor: tailFloor(length, covered), end }
    } catch {
      return { unserved: true }
    } finally {
      run.cores.delete(q)
      await q.close().catch(noop)
    }
  }

  async function readWith (run, { keys, limit }) {
    run.deadline = Date.now() + L.deadlineMs
    const mod = await moderation(storage, association)
    checkAborted(run)
    await openLink(run)
    checkAborted(run)
    const logs = []
    let incomplete = false
    await pool(keys, L.parallel, async (key) => {
      const r = await fetchDiary(run, key, mod)
      if (r.unserved) {
        incomplete = true
        return
      }
      if (r.skip !== undefined) return
      if (r.partial) incomplete = true
      // Raw entries for the lifecycle: a tombstone never undoes a move.
      const lifecycle = pageLifecycle(r.entries, key, association, { revokedIssuers: mod.revokedIssuers })
      let entries = cutEntries(r.entries, lifecycle)
      // The seeder points at an end this read did not verify at or below
      // it (not served in time, or not a verified close or move): fail
      // closed, nothing above the head shows and the answer is incomplete.
      const cut = endOf(lifecycle)
      if (r.end !== null && (cut === null || cut > r.end)) {
        incomplete = true
        entries = entries.filter((e) => e.seq < PEEK_HEAD_BLOCKS)
      }
      logs.push({ key, entries: feedEntries(entries, r.floor) })
    })
    checkAborted(run)
    if (run.overBudget || run.lost || run.cut) incomplete = true
    // A snapshot adopted meanwhile (another tab's sync) decides the answer.
    const final = await moderation(storage, association)
    // As logRead: a block-0 issuer the final snapshot revokes reads as no
    // local data, like a block.
    const kept = logs.filter(({ key, entries }) => !final.blocked.has(key) && !revokedAt0(entries, key, association, final.revokedIssuers))
    const built = buildFeed({ logs: kept, association, limit, revokedIssuers: final.revokedIssuers })
    return { items: built.items, incomplete }
  }

  // -> { items, incomplete } (docs/rpc.md 5.86). One read at a time
  // (UsageError 'feed de página já em andamento'); abort() rejects the
  // running one with Error('sem conexão com o semeador').
  async function read ({ keys, limit } = {}) {
    if (closed) throw new Error(NO_SEEDER)
    if (current !== null) throw new UsageError(BUSY)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new UsageError('limit inválido')
    if (!Array.isArray(keys)) throw new UsageError('keys inválido')
    const list = []
    for (const k of keys) {
      const key = typeof k === 'string' ? k.toLowerCase() : ''
      if (HEX64.test(key) && !list.includes(key)) list.push(key)
    }
    const run = { link: null, cores: new Set(), requests: new Set(), aborted: false, lost: false, cut: false, budget: 0, overBudget: false, deadline: 0 }
    current = run
    try {
      return await readWith(run, { keys: list, limit })
    } finally {
      closeLink(run)
      for (const q of run.cores) q.close().catch(noop)
      for (const ctl of run.requests) ctl.abort()
      if (current === run) current = null
    }
  }

  function abort () {
    const run = current
    if (run === null) return
    current = null
    run.aborted = true
    closeLink(run)
    for (const q of run.cores) q.close().catch(noop)
    for (const ctl of run.requests) ctl.abort()
  }

  function close () {
    closed = true
    abort()
  }

  return { read, abort, close }
}

module.exports = { createPageFeeder }
