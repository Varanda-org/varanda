'use strict'

// Notices of a hosted page (docs/rpc.md 5.28 shape, docs/protocol.md
// 'Notices link'), read by the account service that holds the page key:
// who followed the page and whom it does not follow yet, and who replied to,
// quoted or mentioned it. The rules are packages/web-member/lib/notices.js's
// (not imported: that package is browser-only), on the CLI's Hypercore 11.
//
// One short-lived link per read: a WebSocket to the loopback seeder
// (/seeder), a NoiseSecretStream with a FRESH key, the admission hello with
// role 'member', an EMPTY inventory and no announce, the seeder's hello
// verified (role 'seeder', seederCertForKey on its Noise key) before
// anything else is sent. Then 'varanda/notices/2' in the member role proves
// the PAGE key: the channel builds the v2 payload (notices-v2.js, its own
// prefix, so a v1 proof never opens it) and the page secret only signs it.
//
// TRUST MODEL: the seeder can withhold but not forge. Every row is checked
// on the same link against the author's signed blocks, replicated into a
// temporary store: block 0 first (certificate for the association under the
// revoked issuers, fork 0, quota on the verified length), the blocklist,
// then block `seq`, which must be the author's signed follow of the page
// with on: true and the claimed `at` (a later signed unfollow in the
// verified tail drops it), or a signed post whose kind is DERIVED here: a
// reply to or a quote of a page post block, else an '@nome' that the page
// diary verifiably held (heldUsernames). The seeder's kind is never used.
//
// COST: at most MAX_SEEDER_PAGES pages, DEADLINE_MS and BUDGET_BYTES of
// WebSocket payload per read; one read in flight per page; one cached
// answer per page (at most 64 rows) for CACHE_TTL_MS, re-filtered by the
// current blocklist and follows on every hit. The temporary store is
// removed and the socket closed when the read ends.
//
// `seen` is docs/rpc.md 5.28's construction with a per-page seed derived
// from VARANDA_PAGE_KEYS in place of the identity seed, so it is stable for
// one page and opaque without that key.
//
// Logs carry { event: 'page-notices', reason } only: never a key.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { WebSocket, createWebSocketStream } = require('ws')
const { decodeBlock, validRecordCopy, isHex64, isCanonicalIso, MAX_LOG_BLOCKS, MAX_LOG_BYTES, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { PEEK_TAIL_BLOCKS, diaryPeek, retainRecords } = require('@varanda/core/lib/peek')
const { NOTICES_LIMIT_MAX, NOTICES_LIMIT_DEFAULT } = require('@varanda/core/lib/notices')
const { attachNoticesV2, NOTICES_REQUEST_TIMEOUT_MS } = require('@varanda/core/lib/notices-net')
const { MAX_FUTURE_MS } = require('@varanda/core/lib/feed')
const { heldUsernames } = require('@varanda/core/lib/username')
const { mentionTokens } = require('@varanda/rpc')
const { parseSeederWs } = require('./pages-writer')
const { ENV } = require('./page-keys')

const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', {
  paths: [path.dirname(require.resolve('@varanda/core/lib/seeder'))]
}))

const CONNECT_TIMEOUT_MS = 15000
const DEADLINE_MS = 25000
const BUDGET_BYTES = 8 * 1024 * 1024
const MAX_SEEDER_PAGES = 8
const PARALLEL = 8
const BLOCK_TIMEOUT_MS = 10000
const MAX_BLOCKS_PER_ROW = 16
const CACHE_TTL_MS = 60000
// One WebSocket message is one secret-stream frame; blocks are bounded by
// MAX_BLOCK_BYTES and protomux batches stay well under this here.
const MAX_PAYLOAD = 2 * 1024 * 1024
const MIN_FETCH_MS = 250
const SEEN_PREFIX = 'varanda-notices-seen-v1\n'
const SEEN_KEY_LABEL = 'varanda-page-notices-seen-v1'
const KEY_RE = /^[0-9a-f]{64}$/
const TIMEOUT = Symbol('timeout')

function noop () {}

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function overQuota (core) {
  return core.length > MAX_LOG_BLOCKS || core.byteLength > MAX_LOG_BYTES
}

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

function within (promise, ms) {
  let timer
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(1, ms), TIMEOUT) })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

function compareRows (a, b) {
  return (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (b.seq - a.seq)
}

// Exactly { at, key } (read as seq 1, docs/rpc.md 5.28) or { at, key, seq }.
function parseCursor (v) {
  try {
    if (v === null || v === undefined) return null
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    const keys = Object.keys(v)
    const has = (k) => Object.prototype.hasOwnProperty.call(v, k)
    if (!has('at') || !has('key') || !isCanonicalIso(v.at) || !isHex64(v.key)) return undefined
    if (keys.length === 2) return { at: v.at, key: v.key, seq: 1 }
    if (keys.length === 3 && has('seq') && Number.isSafeInteger(v.seq) && v.seq >= 1) return { at: v.at, key: v.key, seq: v.seq }
    return undefined
  } catch {
    return undefined
  }
}

// null when the revocation list cannot be read: no notice is judged without it.
function toSet (value) {
  if (value === null || value === undefined) return new Set()
  try {
    const v = typeof value === 'function' ? value() : value
    if (v instanceof Set) return new Set(v)
    if (Array.isArray(v)) return new Set(v)
  } catch {}
  return null
}

function postKind (facts, ctx) {
  const ref = (r) => r !== null && r.author === ctx.own && ctx.posts.has(r.seq)
  if (ref(facts.replyTo)) return 'reply'
  if (ref(facts.quote)) return 'quote'
  if (facts.mentions.some((name) => ctx.names.has(name))) return 'mention'
  return null
}

function zeroRow (row) {
  if (!row) return
  for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) {
    if (row[k] instanceof Uint8Array) row[k].fill(0)
  }
  if (row.writers) for (const w of Object.keys(row.writers)) if (row.writers[w] instanceof Uint8Array) row.writers[w].fill(0)
}

// keys: page-keys.js table; writer: pages-writer.js (readEntries, follows);
// seederWs: the loopback seeder URL; blocklist: { has(key) } or null;
// revokedIssuers: () => Set | Array of revoked issuer keys; env: where
// VARANDA_PAGE_KEYS is read for the `seen` seed; limits: test overrides.
function createPagesNotices ({ keys, writer, seederWs, association, blocklist = null, revokedIssuers = null, env = process.env, tmpRoot = os.tmpdir(), log = noop, limits = {} } = {}) {
  if (!keys || typeof keys.get !== 'function') throw new TypeError('keys must be a page-keys table')
  if (!writer || typeof writer.readEntries !== 'function' || typeof writer.follows !== 'function') throw new TypeError('writer must be a pages writer')
  if (typeof association !== 'string' || !KEY_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  const url = parseSeederWs(seederWs)
  if (url === null) throw new TypeError('seederWs must be a loopback http or ws URL with a port')
  const L = {
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    deadlineMs: DEADLINE_MS,
    budgetBytes: BUDGET_BYTES,
    maxSeederPages: MAX_SEEDER_PAGES,
    parallel: PARALLEL,
    blockTimeoutMs: BLOCK_TIMEOUT_MS,
    maxBlocksPerRow: MAX_BLOCKS_PER_ROW,
    cacheTtlMs: CACHE_TTL_MS,
    requestTimeoutMs: NOTICES_REQUEST_TIMEOUT_MS,
    ...(limits || {})
  }

  // Only a derived key is kept, never the env value itself.
  let seenMaster = null
  const raw = env && typeof env[ENV] === 'string' ? env[ENV] : ''
  if (KEY_RE.test(raw)) {
    const k = b4a.from(raw, 'hex')
    seenMaster = nodeCrypto.createHmac('sha256', k).update(SEEN_KEY_LABEL).digest()
    k.fill(0)
  }

  const cache = new Map() // page -> { at, ck, result }
  const running = new Map() // page -> { ck, promise, run }
  let closed = false

  function note (reason) {
    try { log({ event: 'page-notices', reason }) } catch {}
  }

  function isBlocked (key) {
    try {
      return blocklist !== null && typeof blocklist.has === 'function' && blocklist.has(key) === true
    } catch {
      return true
    }
  }

  function seenToken (page, key, seq) {
    const seed = nodeCrypto.createHmac('sha256', seenMaster).update(page).digest()
    try {
      const digest = hcrypto.hash([b4a.from(SEEN_PREFIX), seed, b4a.from(page + '\n' + key + ':' + seq)])
      return b4a.toString(digest, 'hex').slice(0, 32)
    } finally {
      seed.fill(0)
    }
  }

  // ---- the link ----

  function openLink (run, page, secretKey) {
    return new Promise((resolve, reject) => {
      const link = { ws: null, noise: null, v2: null, verified: false, closeCode: null }
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
      const timer = setTimeout(() => finish(fail('sem-semeador')), L.connectTimeoutMs)
      try {
        link.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: L.connectTimeoutMs, maxPayload: MAX_PAYLOAD })
        link.ws.on('error', noop)
        link.ws.on('close', (code) => { link.closeCode = code })
        link.ws.on('message', (data) => {
          run.bytes += data.byteLength !== undefined ? data.byteLength : 0
          if (run.bytes > L.budgetBytes && !run.cutoff) {
            run.cutoff = true
            run.incomplete = true
            destroyLink(link)
          }
        })
        const duplex = createWebSocketStream(link.ws)
        duplex.on('error', noop)
        link.noise = new NoiseSecretStream(true, duplex, { keyPair: hcrypto.keyPair() })
        link.noise.on('error', noop)
      } catch {
        finish(fail('sem-semeador'))
        return
      }
      link.noise.once('close', () => {
        if (run.link === link && !run.cutoff && !run.ended) run.lost = true
        for (const q of run.cores) q.close().catch(noop)
        finish(link.closeCode === 1013 ? fail('semeador-ocupado') : fail('sem-semeador'))
      })
      link.noise.once('connect', () => {
        try {
          Hypercore.createProtocolStream(link.noise)
          attachAdmission(link.noise, {
            role: 'member',
            have: [],
            onmessage: (msg, peer) => {
              if (msg.type !== 'hello') return
              link.verified = msg.role === 'seeder' &&
                peer.peerKey !== null &&
                seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
              if (!link.verified) {
                note('semeador-nao-verificado')
                finish(fail('sem-semeador'))
                return
              }
              finish(null)
            },
            log: noop
          })
          // On the muxer before the hello, so protomux pairs the seeder's
          // open; the proof is refused until the hello verified.
          link.v2 = attachNoticesV2(link.noise, {
            role: 'member',
            ownKey: page,
            requestTimeoutMs: L.requestTimeoutMs,
            sign: (bytes) => {
              if (!link.verified) throw new Error('semeador não verificado')
              return hcrypto.sign(bytes, secretKey)
            }
          })
        } catch {
          finish(fail('sem-semeador'))
        }
      })
    })
  }

  function destroyLink (link) {
    if (link === null) return
    try { if (link.v2 !== null) link.v2.close() } catch {}
    try { if (link.noise !== null) link.noise.destroy() } catch {}
    try { if (link.ws !== null) link.ws.terminate() } catch {}
  }

  function cutLink (run, link) {
    return run.lost || run.cutoff || run.link === null || link.noise.destroyed
  }

  // ---- verifying one row ----

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

  async function fetchOne (run, item, ctx) {
    const PENDING = { state: 'pending' }
    const DROPPED = { state: 'dropped' }
    const ABSENT = { state: 'absent' }
    const link = run.link
    if (link === null || ctx.cut()) return PENDING
    const q = run.store.get({ key: b4a.from(item.key, 'hex') })
    run.cores.add(q)
    const timeout = () => Math.max(1, Math.min(L.blockTimeoutMs, ctx.deadline - Date.now()))
    const failed = () => {
      run.incomplete = true
      return DROPPED
    }
    const get = async (seq, allowAbsent = false) => {
      if (ctx.cut()) return PENDING
      const t = timeout()
      let raw = null
      try {
        raw = await q.get(seq, { raw: true, timeout: t })
      } catch {}
      if (raw === null || raw === undefined) {
        if (cutLink(run, link) || t < L.blockTimeoutMs) return PENDING
        if (allowAbsent) return ABSENT
        return failed()
      }
      if (raw.byteLength > MAX_BLOCK_BYTES) return failed()
      return raw
    }
    try {
      await q.ready()
      if (cutLink(run, link)) return PENDING
      q.replicate(link.noise)
      const raw0 = await get(0)
      if (!(raw0 instanceof Uint8Array)) return raw0
      const length = q.length
      const seqs = new Set([0])
      const entries = [{ seq: 0, record: decodeBlock(raw0) }]
      const gate = diaryPeek({ key: item.key, length, entries, fetched: seqs, association, revokedIssuers: ctx.revoked, now: Date.now() })
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
          replyTo: signed.replyTo === null || signed.replyTo === undefined ? null : { author: signed.replyTo.author, seq: signed.replyTo.seq },
          quote: signed.quote === undefined || signed.quote === null ? null : { author: signed.quote.author, seq: signed.quote.seq },
          mentions: mentionTokens(signed.text)
        }
      } else {
        return DROPPED
      }
      seqs.add(item.seq)
      const wanted = new Set()
      for (let s = length - 1; s >= Math.max(1, length - PEEK_TAIL_BLOCKS); s--) wanted.add(s)
      for (let s = 1; s <= 2 && s < length; s++) wanted.add(s)
      const rest = [...wanted].filter((s) => !seqs.has(s)).sort((a, b) => b - a).slice(0, Math.max(0, L.maxBlocksPerRow - seqs.size))
      // Highest first, so a tombstone comes before its target (web-member
      // notices.js); a missing head block stops the walk and the row stands
      // without it.
      const gone = new Set()
      for (const seq of rest) {
        if (gone.has(seq)) {
          seqs.add(seq)
          continue
        }
        const r = await get(seq, seq <= 2)
        if (r === ABSENT) {
          run.incomplete = true
          break
        }
        if (!(r instanceof Uint8Array)) return r
        seqs.add(seq)
        const record = decodeBlock(r)
        entries.push({ seq, record })
        const copy = validRecordCopy(record, seq)
        if (copy !== null && copy.type === 'delete' && copy.seq >= 1 && copy.seq < length) gone.add(copy.seq)
        if (facts.type === 'follow' && seq > item.seq && copy !== null && copy.type === 'follow' && copy.key === ctx.own && copy.on === false) return DROPPED
      }
      if (q.fork !== 0 || overQuota(q)) return DROPPED
      return { state: 'ok', evidence: { length, seqs, records: retainRecords(entries), at: signed.at, facts } }
    } catch {
      return cutLink(run, link) ? PENDING : failed()
    } finally {
      run.cores.delete(q)
      await q.close().catch(noop)
    }
  }

  function claimFollow (key, ctx) {
    if (ctx.follows.has(key) || ctx.claimed.has(key)) return false
    ctx.claimed.add(key)
    return true
  }

  async function verifyItem (run, item, ctx) {
    const DROPPED = { state: 'dropped' }
    if (item.key === ctx.own || isBlocked(item.key)) return DROPPED
    // A block or a follower is claimed only by a VERIFIED row, so a forged
    // duplicate listed first cannot hide the real one.
    const ck = item.key + ':' + item.seq
    if (ctx.claimedSeqs.has(ck)) return DROPPED
    // Only a filter before any fetch: the kind is the one the block proves.
    if (item.kind === 'follow' && (ctx.follows.has(item.key) || ctx.claimed.has(item.key))) return DROPPED
    const r = await fetchEvidence(run, item, ctx)
    if (r.state !== 'ok') return r
    const evidence = r.evidence
    let kind
    if (evidence.facts.type === 'follow') {
      kind = 'follow'
    } else {
      kind = postKind(evidence.facts, ctx)
      if (kind === null || Date.parse(evidence.at) - Date.now() > MAX_FUTURE_MS) return DROPPED
    }
    const v = diaryPeek({ key: item.key, length: evidence.length, entries: evidence.records, fetched: evidence.seqs, association, revokedIssuers: ctx.revoked, now: Date.now() })
    if (v.reason !== null || ctx.claimedSeqs.has(ck)) return DROPPED
    if (kind === 'follow' && !claimFollow(item.key, ctx)) return DROPPED
    ctx.claimedSeqs.add(ck)
    return { state: 'accepted', row: { kind, key: item.key, seq: item.seq, at: item.at, name: v.name, username: v.username, avatar: v.avatar } }
  }

  // ---- read ----

  function ownContext (page, entries, revoked) {
    const posts = new Set()
    for (const { seq, record } of entries) {
      if (record !== null && typeof record === 'object' && record.type === 'post' && validRecordCopy(record, seq) !== null) posts.add(seq)
    }
    const names = new Set(heldUsernames(entries, page, association, { revokedIssuers: revoked }).keys())
    return { posts, names }
  }

  function empty (over) {
    return { notices: [], next: null, incomplete: false, supported: true, activity: true, ...over }
  }

  async function readWith (run, page, after, limit) {
    const deadline = Date.now() + L.deadlineMs
    const left = () => deadline - Date.now()
    const revoked = toSet(revokedIssuers)
    if (revoked === null) throw fail('indisponivel')
    if (isBlocked(page)) return empty()
    const entries = await writer.readEntries(page)
    const follows = new Set(writer.follows(page).map((f) => f.key))
    const { posts, names } = ownContext(page, entries, revoked)

    const row = keys.enabled ? keys.get(page) : null
    if (row === null) throw fail('nao-encontrada')
    const secretKey = b4a.from(row.secretKey)
    zeroRow(row)
    run.secrets.push(secretKey)

    run.tmp = fs.mkdtempSync(path.join(tmpRoot, 'varanda-page-notices-'))
    run.store = new Corestore(path.join(run.tmp, 'store'))
    await run.store.ready()
    // The deadline cuts the link; what was decided before it still counts.
    run.deadlineTimer = setTimeout(() => {
      run.cutoff = true
      run.incomplete = true
      if (run.link !== null) destroyLink(run.link)
    }, L.deadlineMs)

    const link = await openLink(run, page, secretKey)
    const supported = await within(link.v2.supported, Math.min(L.requestTimeoutMs, left()))
    if (run.lost) throw fail('sem-semeador')
    if (supported === TIMEOUT) return empty({ incomplete: true })
    if (supported !== true) {
      note('sem-suporte')
      return empty({ supported: false })
    }
    let proved
    try {
      proved = await within(link.v2.proved, Math.min(L.requestTimeoutMs, left()))
    } catch {
      proved = false
    }
    if (run.lost) throw fail('sem-semeador')
    if (proved !== true) {
      note('prova-recusada')
      return empty({ incomplete: true })
    }

    const cut = () => Date.now() >= deadline - MIN_FETCH_MS || run.cutoff || run.lost || run.link === null
    const ctx = { own: page, follows, revoked, deadline, cut, names, posts, claimed: new Set(), claimedSeqs: new Set() }
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
      let pageResult
      const asked = link.v2.requestPage({ after: cursor, limit: NOTICES_LIMIT_MAX })
      asked.catch(noop)
      try {
        pageResult = await within(asked, left())
      } catch {
        pageResult = TIMEOUT
      }
      if (run.lost) throw fail('sem-semeador')
      if (pageResult === TIMEOUT) {
        more = true
        run.incomplete = true
        break
      }
      pages++
      if (pageResult.incomplete) run.incomplete = true
      const batch = pageResult.items.map((item) => ({ item, state: 'pending', row: null }))
      seen.push(...batch)
      await pool(batch, L.parallel, async (e) => {
        if (accepted >= limit) return
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
      if (run.lost) throw fail('sem-semeador')
      if (batch.some((e) => e.state === 'pending')) {
        more = true
        break
      }
      if (pageResult.next === null) break
      cursor = pageResult.next
      if (accepted >= limit) {
        more = true
        break
      }
    }

    const prefix = []
    for (const e of seen) {
      if (e.state === 'pending') break
      prefix.push(e)
    }
    const rows = prefix.filter((e) => e.state === 'accepted').map((e) => e.row).sort(compareRows)
    const notices = rows.slice(0, limit).map((r) => ({ ...r, seen: seenToken(page, r.key, r.seq) }))
    const last = notices.length > 0 ? notices[notices.length - 1] : null
    const cursorOf = (r) => ({ at: r.at, key: r.key, seq: r.seq })
    let next = null
    if (rows.length > limit) {
      next = cursorOf(last)
    } else if (more && prefix.length > 0) {
      const edge = prefix[prefix.length - 1].item
      next = cursorOf(last !== null && compareRows(edge, last) < 0 ? last : edge)
    }
    if (run.incomplete) note('incompleto')
    return { notices, next, incomplete: run.incomplete, supported: true, activity: true }
  }

  async function finishRun (run) {
    run.ended = true
    clearTimeout(run.deadlineTimer)
    destroyLink(run.link)
    run.link = null
    for (const q of run.cores) await q.close().catch(noop)
    if (run.store !== null) await run.store.close().catch(noop)
    if (run.tmp !== null) {
      try { fs.rmSync(run.tmp, { recursive: true, force: true }) } catch {}
    }
    for (const s of run.secrets) s.fill(0)
  }

  // A cached answer, with rows of authors since blocked or followed removed.
  function fromCache (page, result) {
    let follows = new Set()
    try { follows = new Set(writer.follows(page).map((f) => f.key)) } catch {}
    const notices = result.notices
      .filter((r) => !isBlocked(r.key) && !(r.kind === 'follow' && follows.has(r.key)))
      .map((r) => ({ ...r, avatar: r.avatar === null ? null : { ...r.avatar } }))
    return { ...result, notices, next: result.next === null ? null : { ...result.next } }
  }

  // -> { notices, next, incomplete, supported, activity } (docs/rpc.md 5.28).
  // Throws { code } invalido | desligado | nao-encontrada | ocupado |
  // sem-semeador | semeador-ocupado | fechado.
  async function read (page, { after = null, limit = NOTICES_LIMIT_DEFAULT } = {}) {
    if (closed) throw fail('fechado')
    if (typeof page !== 'string' || !KEY_RE.test(page)) throw fail('invalido')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTICES_LIMIT_MAX) throw fail('invalido')
    const cursor = parseCursor(after)
    if (cursor === undefined) throw fail('invalido')
    if (!keys.enabled || seenMaster === null) throw fail('desligado')
    const ck = JSON.stringify([cursor, limit])
    const hit = cache.get(page)
    if (hit !== undefined) {
      if (hit.ck === ck && Date.now() - hit.at < L.cacheTtlMs) return fromCache(page, hit.result)
      if (Date.now() - hit.at >= L.cacheTtlMs) cache.delete(page)
    }
    const inflight = running.get(page)
    if (inflight !== undefined) {
      if (inflight.ck !== ck) throw fail('ocupado')
      return fromCache(page, await inflight.promise)
    }
    const run = { link: null, store: null, tmp: null, cores: new Set(), keyLocks: new Map(), secrets: [], bytes: 0, cutoff: false, lost: false, ended: false, incomplete: false, deadlineTimer: null }
    const promise = (async () => {
      try {
        return await readWith(run, page, cursor, limit)
      } catch (err) {
        if (err && (err.code === 'sem-semeador' || err.code === 'semeador-ocupado')) note(err.code)
        throw err
      } finally {
        await finishRun(run)
      }
    })()
    const entry = { ck, promise, run }
    running.set(page, entry)
    try {
      const result = await promise
      if (!closed) cache.set(page, { at: Date.now(), ck, result })
      return fromCache(page, result)
    } finally {
      if (running.get(page) === entry) running.delete(page)
    }
  }

  function close () {
    closed = true
    cache.clear()
    for (const { run } of running.values()) {
      run.lost = true
      if (run.link !== null) destroyLink(run.link)
    }
  }

  return { read, close }
}

module.exports = {
  createPagesNotices,
  DEADLINE_MS,
  BUDGET_BYTES,
  MAX_SEEDER_PAGES,
  CACHE_TTL_MS
}
