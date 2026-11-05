'use strict'

// Confirms that `actor` (the Ed25519 key that signs a person's page
// statements) is the delegate a core member named in their OWN diary, so
// the service can attribute a page action signed by `actor` to `diary`.
// The diary key is a corestore-7 manifest hash and cannot sign page
// statements itself; the diary's Hypercore signature is what authenticates
// its page-delegate record.
//
// One short-lived link per read, as pages-notices.js: a WebSocket to the
// loopback seeder (/seeder), a NoiseSecretStream with a FRESH key, the
// admission hello with role 'member', an EMPTY inventory and no announce,
// the seeder's hello verified (role 'seeder', seederCertForKey on its Noise
// key) before any core is replicated. The diary is replicated into a
// temporary Corestore under tmpRoot, removed when the read ends.
//
// verify({ actor, diary }) -> { ok: true, length } | { ok: false, reason },
// never throws. It requires: block 0 a member-cert for `diary` under the
// association and the CURRENT revoked issuers (certForKey), fork 0, the
// newest live page-delegate (latestDelegate over the blocks read from the
// head down to it, tombstones folded) naming `actor`, actor !== diary, and neither key blocked.
// Reasons: nao-certificado, delegado-desconhecido, bloqueado, indisponivel
// (no seeder, diary not served in full within DEADLINE_MS / BUDGET_BYTES,
// over quota, busy).
//
// TRUST MODEL: the seeder can withhold but not forge, since every block is
// checked against the diary key by Hypercore. Withholding the tail is
// 'indisponivel', never an answer from a prefix.
//
// COST: one read in flight per diary (concurrent calls share it), at most
// MAX_RUNNING reads at once. What a read learned is cached per diary; within
// RECHECK_MS a call is answered from the cache without a socket, after it a
// link checks the length and only a moved length (or fork) reads the blocks
// again. The cert, the blocklist and the revoked issuers are re-applied on
// every answer, cached or not. Nothing is written anywhere.
//
// A diary the caller picked (verify({ ..., probe: true }), the 'terms'
// action) may hold at most MAX_PROBES of the MAX_RUNNING reads, so unknown
// diaries never take every slot from the delegates already known; and a
// diary never read before whose read failed (no block 0, not served) is
// answered 'indisponivel' without a read for NEGATIVE_MS.
//
// Logs carry { event: 'page-delegate', reason } only: never a key.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { WebSocket, createWebSocketStream } = require('ws')
const { decodeBlock, validRecordCopy, MAX_LOG_BLOCKS, MAX_LOG_BYTES, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { certForKey, seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { latestDelegate } = require('@varanda/core/lib/page-lifecycle')
const { parseSeederWs } = require('./pages-writer')

const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', {
  paths: [path.dirname(require.resolve('@varanda/core/lib/seeder'))]
}))

const CONNECT_TIMEOUT_MS = 15000
const DEADLINE_MS = 25000
const BUDGET_BYTES = 16 * 1024 * 1024
const BLOCK_TIMEOUT_MS = 10000
const RECHECK_MS = 60000
const MAX_RUNNING = 4
const MAX_PROBES = 1
const NEGATIVE_MS = 60000
const MAX_CACHE = 1000
const MAX_PAYLOAD = 2 * 1024 * 1024
const WINDOW = 64
const KEY_RE = /^[0-9a-f]{64}$/

function noop () {}

function fail (reason) {
  return { ok: false, reason }
}

// null when the revocation list cannot be read: an authorisation decision
// never runs without it.
function toSet (value) {
  if (value === null || value === undefined) return new Set()
  try {
    const v = typeof value === 'function' ? value() : value
    if (v instanceof Set) return new Set(v)
    if (Array.isArray(v)) return new Set(v)
  } catch {}
  return null
}

// seederWs: the loopback seeder URL; blocklist: { has(key) } or null;
// revokedIssuers: () => Set | Array of revoked issuer keys (or a Set);
// limits: test overrides.
function createPagesDelegate ({ seederWs, association, blocklist = null, revokedIssuers = null, tmpRoot = os.tmpdir(), log = noop, limits = {} } = {}) {
  if (typeof association !== 'string' || !KEY_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  const url = parseSeederWs(seederWs)
  if (url === null) throw new TypeError('seederWs must be a loopback http or ws URL with a port')
  const L = {
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    deadlineMs: DEADLINE_MS,
    budgetBytes: BUDGET_BYTES,
    blockTimeoutMs: BLOCK_TIMEOUT_MS,
    recheckMs: RECHECK_MS,
    maxRunning: MAX_RUNNING,
    maxProbes: MAX_PROBES,
    negativeMs: NEGATIVE_MS,
    maxCache: MAX_CACHE,
    ...(limits || {})
  }

  const cache = new Map() // diary -> { at, length, cert, delegate }
  const running = new Map() // diary -> { promise, run }
  const missed = new Map() // diary never read in full -> when its read failed
  let closed = false

  function note (reason) {
    try { log({ event: 'page-delegate', reason }) } catch {}
  }

  function isBlocked (key) {
    try {
      return blocklist !== null && typeof blocklist.has === 'function' && blocklist.has(key) === true
    } catch {
      return true
    }
  }

  // ---- the link ----

  function openLink (run) {
    return new Promise((resolve, reject) => {
      const link = { ws: null, noise: null, closeCode: null }
      run.link = link
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          destroyLink(link)
          reject(err)
        } else {
          resolve(link)
        }
      }
      const timer = setTimeout(() => finish(new Error('indisponivel')), L.connectTimeoutMs)
      try {
        link.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: L.connectTimeoutMs, maxPayload: MAX_PAYLOAD })
        link.ws.on('error', noop)
        link.ws.on('close', (code) => { link.closeCode = code })
        link.ws.on('message', (data) => {
          run.bytes += data.byteLength !== undefined ? data.byteLength : 0
          if (run.bytes > L.budgetBytes && !run.cutoff) {
            run.cutoff = true
            destroyLink(link)
          }
        })
        const duplex = createWebSocketStream(link.ws)
        duplex.on('error', noop)
        link.noise = new NoiseSecretStream(true, duplex, { keyPair: hcrypto.keyPair() })
        link.noise.on('error', noop)
      } catch {
        finish(new Error('indisponivel'))
        return
      }
      link.noise.once('close', () => {
        run.lost = true
        finish(new Error('indisponivel'))
      })
      link.noise.once('connect', () => {
        try {
          Hypercore.createProtocolStream(link.noise)
          attachAdmission(link.noise, {
            role: 'member',
            have: [],
            onmessage: (msg, peer) => {
              if (msg.type !== 'hello') return
              const verified = msg.role === 'seeder' &&
                peer.peerKey !== null &&
                seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
              if (!verified) {
                note('semeador-nao-verificado')
                finish(new Error('indisponivel'))
                return
              }
              finish(null)
            },
            log: noop
          })
        } catch {
          finish(new Error('indisponivel'))
        }
      })
    })
  }

  function destroyLink (link) {
    if (link === null) return
    try { if (link.noise !== null) link.noise.destroy() } catch {}
    try { if (link.ws !== null) link.ws.terminate() } catch {}
  }

  // ---- one read ----

  // -> { length, cert, delegate } (cert null when block 0 is not a
  // member-cert for `diary`), or null when the diary was not read in full.
  async function readDiary (run, diary, cached) {
    const deadline = Date.now() + L.deadlineMs
    run.deadlineTimer = setTimeout(() => {
      run.cutoff = true
      if (run.link !== null) destroyLink(run.link)
    }, L.deadlineMs)
    run.tmp = fs.mkdtempSync(path.join(tmpRoot, 'varanda-page-delegate-'))
    run.store = new Corestore(path.join(run.tmp, 'store'))
    await run.store.ready()
    const link = await openLink(run)
    const q = run.store.get({ key: b4a.from(diary, 'hex'), writable: false })
    run.core = q
    await q.ready()
    if (run.lost || run.cutoff) return null
    q.replicate(link.noise)
    const get = async (seq) => {
      const t = Math.max(1, Math.min(L.blockTimeoutMs, deadline - Date.now()))
      let raw = null
      try {
        raw = await q.get(seq, { raw: true, timeout: t })
      } catch {}
      if (raw === null || raw === undefined || raw.byteLength > MAX_BLOCK_BYTES) return null
      return raw
    }
    const raw0 = await get(0)
    if (raw0 === null) return null
    const length = q.length
    // A fork is unreadable, not uncertified: answered 'indisponivel', never cached.
    if (q.fork !== 0) return null
    if (length > MAX_LOG_BLOCKS || q.byteLength > MAX_LOG_BYTES) return null
    const first = validRecordCopy(decodeBlock(raw0), 0)
    if (first === null || first.type !== 'member-cert') return { length, cert: null, delegate: null }
    if (cached !== undefined && cached.length === length && cached.cert !== null) return { length, cert: cached.cert, delegate: cached.delegate }
    // Highest first: a tombstone always targets a lower block, so a block
    // already deleted is skipped (the seeder clears it) and the first live
    // page-delegate met is the newest one.
    const entries = [{ seq: 0, record: first }]
    const deleted = new Set()
    for (let seq = length - 1; seq >= 1; seq--) {
      if (run.lost || run.cutoff) return null
      if ((length - 1 - seq) % WINDOW === 0) q.download({ start: Math.max(1, seq - WINDOW + 1), end: seq + 1 })
      if (deleted.has(seq)) continue
      const raw = await get(seq)
      if (raw === null) return null
      const record = decodeBlock(raw)
      entries.push({ seq, record })
      const copy = validRecordCopy(record, seq)
      if (copy === null) continue
      if (copy.type === 'delete') deleted.add(copy.seq)
      if (copy.type === 'page-delegate') break
    }
    if (q.fork !== 0) return null
    return { length, cert: first.cert, delegate: latestDelegate(entries) }
  }

  async function finishRun (run) {
    clearTimeout(run.deadlineTimer)
    destroyLink(run.link)
    run.link = null
    if (run.core !== null) await run.core.close().catch(noop)
    if (run.store !== null) await run.store.close().catch(noop)
    if (run.tmp !== null) {
      try { fs.rmSync(run.tmp, { recursive: true, force: true }) } catch {}
    }
  }

  function remember (diary, info) {
    cache.delete(diary)
    cache.set(diary, { at: Date.now(), ...info })
    while (cache.size > L.maxCache) cache.delete(cache.keys().next().value)
  }

  function judge (actor, diary, info) {
    if (isBlocked(actor) || isBlocked(diary)) return fail('bloqueado')
    const revoked = toSet(revokedIssuers)
    if (revoked === null) return fail('indisponivel')
    if (info.cert === null || !certForKey(info.cert, diary, association, { revokedIssuers: revoked }).ok) return fail('nao-certificado')
    if (info.delegate !== actor) return fail('delegado-desconhecido')
    return { ok: true, length: info.length }
  }

  async function lookup (diary, probe) {
    const hit = cache.get(diary)
    if (hit !== undefined && Date.now() - hit.at < L.recheckMs) return hit
    const inflight = running.get(diary)
    if (inflight !== undefined) return inflight.promise
    if (hit === undefined) {
      const at = missed.get(diary)
      if (at !== undefined && Date.now() - at < L.negativeMs) return null
      if (at !== undefined) missed.delete(diary)
    }
    if (running.size >= L.maxRunning) return null
    if (probe) {
      let probes = 0
      for (const r of running.values()) if (r.probe) probes++
      if (probes >= L.maxProbes) return null
    }
    const run = { link: null, store: null, core: null, tmp: null, bytes: 0, cutoff: false, lost: false, deadlineTimer: null }
    const promise = (async () => {
      let info = null
      try {
        info = await readDiary(run, diary, hit)
        if (info !== null && !closed) remember(diary, info)
        return info
      } catch {
        return null
      } finally {
        if (info === null && hit === undefined && !closed) {
          missed.delete(diary)
          missed.set(diary, Date.now())
          while (missed.size > L.maxCache) missed.delete(missed.keys().next().value)
        }
        await finishRun(run)
      }
    })()
    const entry = { promise, run, probe: probe === true }
    running.set(diary, entry)
    try {
      return await promise
    } finally {
      if (running.get(diary) === entry) running.delete(diary)
    }
  }

  async function verify ({ actor, diary, probe = false } = {}) {
    let result
    try {
      if (closed) {
        result = fail('indisponivel')
      } else if (typeof actor !== 'string' || !KEY_RE.test(actor) || typeof diary !== 'string' || !KEY_RE.test(diary) || actor === diary) {
        result = fail('delegado-desconhecido')
      } else if (isBlocked(actor) || isBlocked(diary)) {
        result = fail('bloqueado')
      } else {
        const info = await lookup(diary, probe === true)
        result = info === null ? fail('indisponivel') : judge(actor, diary, info)
      }
    } catch {
      result = fail('indisponivel')
    }
    if (!result.ok) note(result.reason)
    return result
  }

  function close () {
    closed = true
    cache.clear()
    missed.clear()
    for (const { run } of running.values()) {
      run.lost = true
      if (run.link !== null) destroyLink(run.link)
    }
  }

  return { verify, close }
}

module.exports = {
  createPagesDelegate,
  DEADLINE_MS,
  BUDGET_BYTES,
  RECHECK_MS
}
