'use strict'

// Conversas as a page (docs/protocol.md §12 'Conversas como página', the
// client side of section 11): the account service holds each page's box.
//
// Box: per page one X25519 pair (crypto_box_keypair, a weak key refused),
// kept by ./page-keys.js as boxSecretKey beside the signing key, never the
// group box. Its public half is the page's dm-key gen 1, appended through
// the writer's own hook (./pages-writer.js ensureDmKey) at start, at
// creation (enable) and again whenever it falls out of the newest 256
// blocks, on the writer's chain and under its guard and pause.
//
// Links, each a short-lived WebSocket to the loopback seeder with a FRESH
// Noise key, the admission hello in the member role, an EMPTY inventory and
// no announce, the seeder's hello verified before anything is sent (the
// packages/web-member/lib/dm-link.js shape):
//   - the drop link: 'varanda/dm/1' (core dm-net.js, member role, one
//     request in flight), nothing on it names a page;
//   - the stamp link: 'varanda/dm-stamp/1', proving the PAGE key, used for
//     a wallet top-up and closed right after;
//   - the lookup link: replicates the recipient's diary into a temporary
//     store to read ITS newest dm-key (block 0 gate first). The recipient's
//     box never comes from the caller.
//
// Pull: every pullEveryMs, one at a time, the global pool with one cursor
// per page (a page moves past a drop only once its box tried it); every
// drop is tried against every live page box (the global-pool rule).
// A msg opens only with a certificate of the association (revoked issuers
// honoured) and is dropped when the sender is blocked by the association or
// by the page.
//
// Rows: per page in <dir>/pages-dm/<page>.json (0600, atomic), sealed with
// AES-256-GCM under a key derived from VARANDA_PAGE_KEYS and the page key:
// messages, the page's folder ops (blocked peers included), the seen marks,
// the stamp wallet and the sends in progress. Folders are core dm-fold.js
// at ownKey = page key, followSet = the page's follows.
//
// Sends: the inner message is built with from = the page key and the page's
// v2 certificate (block 0), signed with the page key, sealed to the
// recipient's box and to the page's own box, two drops each with its own
// stamp. The exact drop bytes are saved under (member, nonce) BEFORE the
// first put, so a resend of an unanswered request puts the same bytes (the
// pool answers an identical drop as success) and never mints a second
// message; a put without an ack throws { code: 'incerto' }.
//
// Logs carry { event: 'page-dm', reason } only: never a text, key or peer.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { WebSocket, createWebSocketStream } = require('ws')
const dm = require('@varanda/core/lib/dm')
const dmFold = require('@varanda/core/lib/dm-fold')
const postage = require('@varanda/core/lib/dm-postage')
const { attachDm } = require('@varanda/core/lib/dm-net')
const { attachDmStamp } = require('@varanda/core/lib/dm-stamp-net')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { seederCertForKey, certForKey, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { decodeBlock, validateRecord, MAX_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { isWeakBoxKey } = require('@varanda/core/lib/group')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { parseSeederWs } = require('./pages-writer')
const { ENV } = require('./page-keys')

const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', { paths: [coreDir] }))
const sodium = require(require.resolve('sodium-universal', { paths: [coreDir] }))

const STATE_DIR = 'pages-dm'
const CURSOR_FILE = 'cursor.json'
const VERSION = 1
const AAD = b4a.from('varanda-page-dm-v1')
const KEY_LABEL = 'varanda-page-dm-rows-v1'
const PULL_EVERY_MS = 60000
const CONNECT_TIMEOUT_MS = 15000
const LINK_DEADLINE_MS = 25000
const STAMP_DEADLINE_MS = 45000
const MAX_PAYLOAD = 2 * 1024 * 1024
// The newest blocks a lookup reads for a dm-key: the 256-block refresh rule
// plus one window of margin, as the session's 8 windows of 36.
const LOOKUP_BLOCKS = 288
const DM_GEN = 1
const PREVIEW_MAX = 140
const MAX_MESSAGES = 5000
const MAX_OPS = 2000
const MAX_SEEN = 10000
const MAX_SENDS = 64
const SEND_TTL_MS = 600 * 1000
const ISSUE_BURST = 8
const ISSUE_PACE_MS = 1100
const HEX64_RE = /^[0-9a-f]{64}$/
const TIMEOUT = Symbol('timeout')
// Below this a filedAt is a counter from an older state file, not ms.
const FILED_MS_FLOOR = 1e12
// The ops dm-fold reads; any other is ignored by it and not kept.
const OP_KINDS = ['accepted', 'declined', 'blocked', 'unblocked', 'deleted']

function noop () {}

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function within (promise, ms) {
  let timer
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(1, ms), TIMEOUT) })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

function preview (text) {
  return Array.from(text).slice(0, PREVIEW_MAX).join('')
}

function emptyState () {
  return { v: VERSION, filed: 0, stopped: false, messages: [], ops: [], seen: [], wallet: { items: [], kids: [] }, sends: {} }
}

function validState (s) {
  return isPlainObject(s) && s.v === VERSION && Number.isSafeInteger(s.filed) && typeof s.stopped === 'boolean' &&
    Array.isArray(s.messages) && Array.isArray(s.ops) && Array.isArray(s.seen) && isPlainObject(s.wallet) &&
    Array.isArray(s.wallet.items) && Array.isArray(s.wallet.kids) && isPlainObject(s.sends)
}

// The newest valid dm-key among entries ({ seq, record }): highest gen, ties
// by highest seq. -> { box, gen, seq } | null.
function newestDmKey (entries) {
  let best = null
  for (const e of entries) {
    if (!e || !isPlainObject(e.record) || e.record.type !== 'dm-key' || validateRecord(e.record, e.seq) !== null) continue
    if (best === null || e.record.gen > best.gen || (e.record.gen === best.gen && e.seq > best.seq)) {
      best = { box: e.record.box, gen: e.record.gen, seq: e.seq }
    }
  }
  return best
}

function boxPairOf (secretKey) {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_scalarmult_base(publicKey, secretKey)
  return { publicKey, secretKey }
}

// -> a fresh 32-byte X25519 secret whose public half is not weak.
function newBoxSecret () {
  for (;;) {
    const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
    const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
    sodium.crypto_box_keypair(publicKey, secretKey)
    if (!isWeakBoxKey(hex(publicKey))) return secretKey
    secretKey.fill(0)
  }
}

function readNoFollow (file) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw fail('indisponivel')
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw fail('indisponivel')
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// limits (tests): pullEveryMs, connectTimeoutMs, deadlineMs, stampDeadlineMs,
// requestTimeoutMs, issuePaceMs, budgetBytes. revokedIssuers: () => Set |
// Array; blocklist: { has(key) } (the association's).
function createPagesDm ({ writer, pagesStore = null, keys, association, seederWs, dir, env = process.env, blocklist = null, revokedIssuers = null, guard = () => true, tmpRoot = os.tmpdir(), log = noop, limits = {} } = {}) {
  if (!writer || typeof writer.ensureDmKey !== 'function' || typeof writer.readEntries !== 'function') throw new TypeError('writer must be a pages writer')
  if (!keys || typeof keys.get !== 'function') throw new TypeError('keys must be a page-keys table')
  if (typeof association !== 'string' || !HEX64_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a path')
  const url = parseSeederWs(seederWs)
  if (url === null) throw new TypeError('seederWs must be a loopback http or ws URL with a port')
  const raw = env && typeof env[ENV] === 'string' ? env[ENV] : ''
  if (!HEX64_RE.test(raw)) throw new TypeError(ENV + ' ausente')
  const L = {
    pullEveryMs: PULL_EVERY_MS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    deadlineMs: LINK_DEADLINE_MS,
    stampDeadlineMs: STAMP_DEADLINE_MS,
    requestTimeoutMs: undefined,
    issuePaceMs: ISSUE_PACE_MS,
    budgetBytes: dm.DM_PULL_BUDGET_BYTES,
    ...(limits || {})
  }
  // Only a derived key is kept, never the env value itself.
  const envKey = b4a.from(raw, 'hex')
  const master = nodeCrypto.createHmac('sha256', envKey).update(KEY_LABEL).digest()
  envKey.fill(0)

  refuseSymlinkDir(dir)
  const stateDir = path.join(dir, STATE_DIR)
  const states = new Map() // page -> state
  const chains = new Map() // page -> Promise
  const forgotten = new Set() // closed pages: never saved again
  const topping = new Map() // page -> Promise
  let cursor = null
  let pulling = null
  let timer = null
  let closed = false
  const inflight = new Set()

  const starting = start()
  starting.catch(noop)

  return {
    ready: () => starting,
    enable: tracked(enable),
    stop: tracked(stop),
    forget: tracked(forget),
    list: tracked(list),
    thread: tracked(thread),
    send: tracked(send),
    set: tracked(setOp),
    seen: tracked(seen),
    pull: tracked(pull),
    topUp: tracked((page) => topUp(page, { force: true })),
    walletSize: tracked(walletSize),
    close
  }

  function note (reason) {
    try { log({ event: 'page-dm', reason }) } catch {}
  }

  function tracked (fn) {
    return (...args) => {
      if (closed) return Promise.reject(fail('fechado'))
      const p = Promise.resolve().then(() => fn(...args))
      inflight.add(p)
      const done = () => { inflight.delete(p) }
      p.then(done, done)
      return p
    }
  }

  function check () {
    let ok = false
    try {
      ok = !closed && guard() === true
    } catch {}
    if (!ok) throw fail('indisponivel')
  }

  function pageParam (page) {
    if (typeof page !== 'string' || !HEX64_RE.test(page)) throw fail('pedido-invalido')
    return page
  }

  // ---- state ------------------------------------------------------------

  function keyOf (page) {
    return nodeCrypto.createHmac('sha256', master).update(page).digest()
  }

  function fileOf (page) {
    return path.join(stateDir, page + '.json')
  }

  function loadState (page) {
    // A forgotten page reads as stopped and is never cached nor saved.
    if (forgotten.has(page)) return { ...emptyState(), stopped: true }
    let s = states.get(page)
    if (s !== undefined) return s
    const buf = readNoFollow(fileOf(page))
    if (buf === null) {
      s = emptyState()
    } else {
      const key = keyOf(page)
      let plain = null
      try {
        const outer = JSON.parse(b4a.toString(buf, 'utf8'))
        const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(outer.iv, 'base64'), { authTagLength: 16 })
        decipher.setAAD(AAD)
        decipher.setAuthTag(Buffer.from(outer.tag, 'base64'))
        plain = b4a.concat([decipher.update(Buffer.from(outer.data, 'base64')), decipher.final()])
        s = JSON.parse(b4a.toString(plain, 'utf8'))
      } catch {
        throw fail('indisponivel')
      } finally {
        key.fill(0)
        if (plain !== null) plain.fill(0)
      }
      if (!validState(s)) throw fail('indisponivel')
      let mtime = Date.now()
      try { mtime = fs.lstatSync(fileOf(page)).mtimeMs } catch {}
      migrateFiled(s, mtime)
    }
    states.set(page, s)
    return s
  }

  // filedAt is the local filing time in ms (dm-fold reads it so), strictly
  // increasing per page; s.filed is the last one handed out.
  function nextFiled (s) {
    s.filed = Math.max(Date.now(), s.filed + 1)
    return s.filed
  }

  // Older files numbered rows 1, 2, 3 (s.filed++). Those counters become ms
  // just before the file's last write, in the same order, so no row reads as
  // 1970 and every later filing sorts after them. Kept in memory only: the
  // next save writes it, and until then a reload maps the same way.
  function migrateFiled (s, mtime) {
    const rows = [...s.messages, ...s.ops]
    if (!rows.some((r) => isPlainObject(r) && typeof r.filedAt === 'number' && r.filedAt < FILED_MS_FLOOR)) return
    const legacy = s.filed < FILED_MS_FLOOR
    let top = legacy ? s.filed : 0
    for (const r of rows) if (isPlainObject(r) && Number.isSafeInteger(r.filedAt) && r.filedAt < FILED_MS_FLOOR && r.filedAt > top) top = r.filedAt
    const base = Math.floor(Math.min(mtime, Date.now())) - top - 1
    let last = 0
    for (const r of rows) {
      if (!isPlainObject(r) || typeof r.filedAt !== 'number') continue
      if (r.filedAt < FILED_MS_FLOOR) r.filedAt = base + r.filedAt
      if (r.filedAt > last) last = r.filedAt
    }
    s.filed = legacy ? last : Math.max(last, s.filed)
  }

  function saveState (page, s) {
    if (forgotten.has(page)) return
    check()
    refuseSymlinkDir(dir)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    refuseSymlinkDir(stateDir)
    const plain = b4a.from(JSON.stringify(s))
    const key = keyOf(page)
    try {
      const iv = nodeCrypto.randomBytes(12)
      const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
      cipher.setAAD(AAD)
      const data = b4a.concat([cipher.update(plain), cipher.final()])
      check()
      writeJsonAtomic(fileOf(page), { v: VERSION, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }, 0o600)
    } finally {
      plain.fill(0)
      key.fill(0)
    }
    states.set(page, s)
  }

  // Runs fn(state) on the page's chain; fn returns true to save.
  function withState (page, fn) {
    const prev = chains.get(page) || Promise.resolve()
    const run = async () => {
      const s = loadState(page)
      const out = await fn(s)
      return out
    }
    const next = prev.then(run, run)
    const tail = next.then(noop, noop)
    chains.set(page, tail)
    tail.then(() => { if (chains.get(page) === tail) chains.delete(page) })
    return next
  }

  function trim (s) {
    if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES)
    if (s.ops.length > MAX_OPS) s.ops = compactOps(s.ops)
    if (s.seen.length > MAX_SEEN) s.seen = s.seen.slice(-MAX_SEEN)
  }

  // dm-fold reads, per peer, only the newest op of each kind (the newest
  // folder op, the newest declined, blocked and deleted as cutoffs, the
  // newest block op), so the newest row per (peer, op) carries the whole
  // state and older ones go first. Past the cap even then, the peers whose
  // newest op is oldest lose all their rows at once: such a peer is back to
  // no op at all (not blocked, not accepted, no delete cutoff), never left
  // with a half state such as an unblock without its block.
  function compactOps (ops) {
    const newest = new Map() // peer + op -> row
    for (const o of ops) {
      if (!isPlainObject(o) || !OP_KINDS.includes(o.op) || typeof o.peer !== 'string' || typeof o.filedAt !== 'number') continue
      const k = o.peer + ':' + o.op
      const had = newest.get(k)
      if (had === undefined || o.filedAt >= had.filedAt) newest.set(k, o)
    }
    let kept = [...newest.values()].sort((a, b) => a.filedAt - b.filedAt)
    if (kept.length <= MAX_OPS) return kept
    const lastOf = new Map() // peer -> newest filedAt
    for (const o of kept) lastOf.set(o.peer, o.filedAt)
    const peers = [...lastOf.keys()].sort((a, b) => lastOf.get(b) - lastOf.get(a))
    const keep = new Set()
    let n = 0
    const count = new Map()
    for (const o of kept) count.set(o.peer, (count.get(o.peer) || 0) + 1)
    for (const p of peers) {
      if (n + count.get(p) > MAX_OPS) break
      keep.add(p)
      n += count.get(p)
    }
    kept = kept.filter((o) => keep.has(o.peer))
    return kept
  }

  // One pool cursor per page: a page moves past a drop only once its box
  // tried it, so a page that was stopped, paused, unloadable or without a
  // box picks up from where it left off (within the pool's retention).
  // `cursor` is the single cursor of older files (0 in a new one) and the
  // start of a page without its own yet: it is never moved again, so it is
  // at or before anything that page could have been sent.
  function readCursor () {
    if (cursor !== null) return cursor
    const buf = readNoFollow(path.join(stateDir, CURSOR_FILE))
    const c = { legacy: 0, pages: new Map() }
    if (buf !== null) {
      try {
        const j = JSON.parse(b4a.toString(buf, 'utf8'))
        if (isPlainObject(j) && j.v === VERSION) {
          if (Number.isSafeInteger(j.cursor) && j.cursor >= 0) c.legacy = j.cursor
          if (isPlainObject(j.pages)) {
            for (const [k, v] of Object.entries(j.pages)) if (HEX64_RE.test(k) && Number.isSafeInteger(v) && v >= 0) c.pages.set(k, v)
          }
        }
      } catch {}
    }
    cursor = c
    return c
  }

  function cursorOf (page) {
    const c = readCursor()
    const v = c.pages.get(page)
    return v === undefined ? c.legacy : v
  }

  function writeCursor (moved) {
    check()
    const c = readCursor()
    const pages = new Map(c.pages)
    for (const [k, v] of moved) pages.set(k, v)
    // Keys the writer no longer holds drop out, so the file stays bounded.
    const held = new Set(writer.pageKeys())
    for (const k of [...pages.keys()]) if (!held.has(k)) pages.delete(k)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    refuseSymlinkDir(stateDir)
    writeJsonAtomic(path.join(stateDir, CURSOR_FILE), { v: VERSION, cursor: c.legacy, pages: Object.fromEntries(pages) }, 0o600)
    cursor = { legacy: c.legacy, pages }
  }

  // ---- the page, its box and its role -----------------------------------

  function live (page) {
    if (pagesStore === null) return true
    let row = null
    try {
      row = pagesStore.get(page)
    } catch {
      return false
    }
    // A key the ACL does not hold yet (a move's K2 before its row) is live;
    // a closed or paused one is not.
    return row === null || (row.closed === null && row.paused !== true)
  }

  // -> { publicKey, secretKey } of the page's box (caller zeroes), or null.
  function boxOf (page) {
    const row = keys.get(page)
    if (row === null) return null
    const box = row.boxSecretKey ? boxPairOf(b4a.from(row.boxSecretKey)) : null
    row.secretKey.fill(0)
    row.mediaSecretKey.fill(0)
    if (row.boxSecretKey) row.boxSecretKey.fill(0)
    if (row.groupBoxSecretKey) row.groupBoxSecretKey.fill(0)
    if (row.writers) for (const w of Object.values(row.writers)) w.fill(0)
    return box
  }

  function zeroPair (pair) {
    if (pair === null) return
    pair.publicKey.fill(0)
    pair.secretKey.fill(0)
  }

  function signingPair (page) {
    const row = keys.get(page)
    if (row === null) throw fail('pausada')
    row.mediaSecretKey.fill(0)
    if (row.boxSecretKey) row.boxSecretKey.fill(0)
    if (row.groupBoxSecretKey) row.groupBoxSecretKey.fill(0)
    if (row.writers) for (const w of Object.values(row.writers)) w.fill(0)
    return { publicKey: b4a.from(page, 'hex'), secretKey: row.secretKey }
  }

  // The box secret is put in the same synchronous step that read the row,
  // so a concurrent row change (put replaces the whole row) is not lost.
  function ensureBox (page) {
    const row = keys.get(page)
    if (row === null) return false
    try {
      if (row.boxSecretKey) return true
      row.boxSecretKey = newBoxSecret()
      keys.put(page, row)
      return true
    } finally {
      for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) if (row[k]) row[k].fill(0)
      if (row.writers) for (const w of Object.values(row.writers)) w.fill(0)
    }
  }

  async function ensureDmKey (page) {
    if (!live(page)) return null
    if (!ensureBox(page)) return null
    const pair = boxOf(page)
    if (pair === null) return null
    const box = hex(pair.publicKey)
    zeroPair(pair)
    let res
    try {
      res = await writer.ensureDmKey(page, { box, gen: DM_GEN })
    } catch {
      note('dm-key-falhou')
      return null
    }
    if (res.seq !== null && pagesStore !== null) {
      // Behind a later route append the ACL is already longer: nothing to do.
      try { await pagesStore.expectLength(page, res.length) } catch {}
    }
    return { box, gen: DM_GEN, seq: res.seq }
  }

  async function start () {
    await writer.ready()
    readCursor()
    for (const page of writer.pageKeys()) {
      if (closed) return
      await ensureDmKey(page)
    }
    if (L.pullEveryMs > 0 && !closed) {
      timer = setInterval(() => { tick().catch(noop) }, L.pullEveryMs)
      if (timer.unref) timer.unref()
    }
  }

  async function tick () {
    if (closed) return
    for (const page of writer.pageKeys()) {
      if (closed) return
      await ensureDmKey(page)
      if (live(page)) await topUp(page).catch(noop)
    }
    await pull().catch(noop)
  }

  async function enable (page) {
    pageParam(page)
    await starting
    await withState(page, async (s) => {
      if (s.stopped) {
        s.stopped = false
        saveState(page, s)
        // Stopped under the single cursor of an older file: that cursor went
        // on without it, so the pool's retained window is read again for it
        // (ids already filed are skipped).
        if (!readCursor().pages.has(page)) writeCursor([[page, 0]])
      }
    })
    const res = await ensureDmKey(page)
    if (res === null) throw fail('indisponivel')
    await topUp(page).catch(noop)
    return res
  }

  async function stop (page) {
    pageParam(page)
    await withState(page, async (s) => {
      if (s.stopped) return
      s.stopped = true
      s.sends = {}
      saveState(page, s)
    })
    note('parada')
    return { ok: true }
  }

  // A closed page: its rows leave memory and disk once its in-flight work
  // ends, and nothing saves them again (a later stop included). Idempotent.
  async function forget (page) {
    pageParam(page)
    forgotten.add(page)
    let prev = chains.get(page)
    while (prev !== undefined) {
      await prev
      const next = chains.get(page)
      prev = next === prev ? undefined : next
    }
    states.delete(page)
    check()
    refuseSymlinkDir(dir)
    refuseSymlinkDir(stateDir)
    fs.rmSync(fileOf(page), { force: true })
    note('esquecida')
    return { ok: true }
  }

  // ---- links --------------------------------------------------------------

  function destroyLink (link) {
    try { if (link.noise !== null) link.noise.destroy() } catch {}
    try { if (link.ws !== null) link.ws.terminate() } catch {}
  }

  // -> the link once the seeder's hello verified; attach(noise, link) runs
  // on connect, before the hello can arrive.
  function dial (attach, deadlineMs) {
    return new Promise((resolve, reject) => {
      const link = { ws: null, noise: null, verified: false, closeCode: null }
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(connectTimer)
        if (err) {
          destroyLink(link)
          reject(err)
        } else {
          resolve(link)
        }
      }
      const connectTimer = setTimeout(() => finish(fail('sem-semeador')), L.connectTimeoutMs)
      const deadline = setTimeout(() => destroyLink(link), deadlineMs)
      if (deadline.unref) deadline.unref()
      try {
        link.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: L.connectTimeoutMs, maxPayload: MAX_PAYLOAD })
        link.ws.on('error', noop)
        link.ws.on('close', (code) => { link.closeCode = code })
        const duplex = createWebSocketStream(link.ws)
        duplex.on('error', noop)
        link.noise = new NoiseSecretStream(true, duplex, { keyPair: hcrypto.keyPair() })
        link.noise.on('error', noop)
      } catch {
        finish(fail('sem-semeador'))
        return
      }
      link.noise.once('close', () => {
        clearTimeout(deadline)
        finish(fail(link.closeCode === 1013 ? 'limite' : 'sem-semeador'))
      })
      link.noise.once('connect', () => {
        try {
          Hypercore.createProtocolStream(link.noise)
          attachAdmission(link.noise, {
            role: 'member',
            have: [],
            onmessage: (msg, peer) => {
              if (msg.type !== 'hello') return
              link.verified = msg.role === 'seeder' && peer.peerKey !== null &&
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
          attach(link.noise, link)
        } catch {
          finish(fail('sem-semeador'))
        }
      })
    })
  }

  function reqOpts () {
    return L.requestTimeoutMs ? { requestTimeoutMs: L.requestTimeoutMs } : {}
  }

  async function openDropLink () {
    let ch = null
    const link = await dial((noise) => { ch = attachDm(noise, { role: 'member', ...reqOpts() }) }, L.deadlineMs)
    return {
      put: (bytes) => ch.put(bytes),
      page: (q) => ch.requestPage(q),
      close () {
        try { ch.close() } catch {}
        destroyLink(link)
      }
    }
  }

  // null when the revocation list cannot be read (a throw, an unexpected
  // type): no certificate is judged without it. Not wired at all (null or
  // undefined): no issuer is revoked.
  function revoked () {
    if (revokedIssuers === null || revokedIssuers === undefined) return new Set()
    try {
      const v = typeof revokedIssuers === 'function' ? revokedIssuers() : revokedIssuers
      if (v instanceof Set) return new Set(v)
      if (Array.isArray(v)) return new Set(v)
    } catch {}
    return null
  }

  function blockedKey (key) {
    if (blocklist === null) return false
    try {
      return blocklist.has(key) === true
    } catch {
      return true
    }
  }

  // ---- the recipient's box ----------------------------------------------

  // One deadline (deadlineMs) bounds the whole lookup. The newest dm-key is
  // only trusted from a complete tail: a range with holes may hide a newer
  // gen, so then nothing is sealed ('indisponivel').
  async function lookupBox (to) {
    if (writer.pageKeys().includes(to)) {
      const best = newestDmKey(await writer.readEntries(to))
      return best === null ? null : best.box
    }
    const revokedSet = revoked()
    if (revokedSet === null) throw fail('indisponivel')
    const until = Date.now() + L.deadlineMs
    const left = () => until - Date.now()
    const bounded = async (promise) => {
      if (left() <= 0) throw fail('indisponivel')
      const v = await within(promise, left())
      if (v === TIMEOUT) throw fail('indisponivel')
      return v
    }
    fs.mkdirSync(tmpRoot, { recursive: true })
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'varanda-page-dm-'))
    let store = null
    let link = null
    let q = null
    try {
      const dialing = dial(noop, L.deadlineMs)
      try {
        link = await bounded(dialing)
      } catch (err) {
        // Past the deadline the dial may still land: that link is closed.
        dialing.then(destroyLink, noop)
        throw err
      }
      store = new Corestore(tmp)
      await bounded(store.ready())
      q = store.get({ key: b4a.from(to, 'hex') })
      await bounded(q.ready())
      q.replicate(link.noise)
      const decoded = (v) => (v instanceof Uint8Array && v.byteLength <= MAX_BLOCK_BYTES) ? decodeBlock(v) : null
      let first = null
      try {
        first = decoded(await bounded(q.get(0, { timeout: Math.max(1, left()) })))
      } catch {
        if (left() <= 0) throw fail('indisponivel')
      }
      if (!isPlainObject(first) || first.type !== 'member-cert' || q.fork !== 0) return null
      if (!certForKey(first.cert, to, association, { revokedIssuers: revokedSet }).ok) return null
      await bounded(q.update({ wait: true }))
      const length = q.length
      const floor = Math.max(1, length - LOOKUP_BLOCKS)
      if (length > floor) {
        await bounded(q.download({ start: floor, end: length }).done())
        if (!(await bounded(q.has(floor, length)))) throw fail('indisponivel')
      }
      const entries = []
      for (let seq = length - 1; seq >= floor; seq--) {
        const v = await bounded(q.get(seq, { wait: false }))
        if (v === null) throw fail('indisponivel')
        const record = decoded(v)
        if (record !== null) entries.push({ seq, record })
      }
      const best = newestDmKey(entries)
      return best === null ? null : best.box
    } catch (err) {
      throw fail(err && err.code === 'indisponivel' ? 'indisponivel' : 'sem-semeador')
    } finally {
      if (q !== null) await q.close().catch(noop)
      if (store !== null) await store.close().catch(noop)
      if (link !== null) destroyLink(link)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // ---- stamps -------------------------------------------------------------

  function usable (w) {
    return w.items.filter((s) => w.kids.length === 0 || w.kids.includes(s.kid))
  }

  async function walletSize (page) {
    pageParam(page)
    return withState(page, async (s) => usable(s.wallet).length)
  }

  // Fills the page's wallet to DM_STAMP_WALLET when below DM_STAMP_WALLET_LOW
  // (or forced). Single flight per page.
  function topUp (page, { force = false } = {}) {
    const busy = topping.get(page)
    if (busy !== undefined) return busy
    const p = (async () => {
      const have = await withState(page, async (s) => s.stopped ? null : usable(s.wallet).length)
      if (have === null || (!force && have >= dm.DM_STAMP_WALLET_LOW)) return 0
      let fresh = []
      let kid = null
      try {
        ({ fresh, kid } = await issueStamps(page, dm.DM_STAMP_WALLET - have))
      } catch {}
      if (fresh.length === 0) {
        note('selos-nao-renovados')
        return 0
      }
      await withState(page, async (s) => {
        const w = s.wallet
        const kids = w.kids[0] === kid ? w.kids : [kid, ...w.kids.slice(0, 1)]
        const known = new Set(w.items.map((x) => x.token))
        s.wallet = { items: [...w.items.filter((x) => kids.includes(x.kid)), ...fresh.filter((x) => !known.has(x.token))], kids }
        saveState(page, s)
      })
      return fresh.length
    })()
    topping.set(page, p)
    const clear = () => { if (topping.get(page) === p) topping.delete(page) }
    p.then(clear, clear)
    return p
  }

  async function issueStamps (page, need) {
    let stamp = null
    const pair = signingPair(page)
    let link
    try {
      link = await dial((noise, l) => {
        stamp = attachDmStamp(noise, {
          role: 'member',
          ownKey: page,
          ...reqOpts(),
          sign: (payload) => {
            if (!l.verified) throw new Error('semeador não verificado')
            return hcrypto.sign(payload, pair.secretKey)
          }
        })
      }, L.stampDeadlineMs)
    } catch (err) {
      pair.secretKey.fill(0)
      throw err
    }
    const fresh = []
    let kid = null
    try {
      const pub = await stamp.key()
      const parsed = postage.parsePublicKey(pub)
      if (parsed === null) return { fresh, kid }
      kid = pub.kid
      for (let i = 0; i < need; i++) {
        if (i >= ISSUE_BURST && L.issuePaceMs > 0) await sleep(L.issuePaceMs)
        const token = postage.newToken(parsed.n)
        const { blinded, r } = postage.blind(postage.representative(token), parsed.n)
        let res
        try {
          res = await stamp.issue(postage.toBase64(blinded))
        } catch {
          break
        }
        if (res.error !== undefined || res.kid !== pub.kid) break
        const s = postage.fromBase64(res.sig)
        if (s === null) break
        const sig = postage.unblind(s, r, parsed.n)
        if (!postage.verify(token, sig, pub)) break
        fresh.push({ kid: pub.kid, token: hex(token), sig: postage.toBase64(sig) })
      }
    } finally {
      pair.secretKey.fill(0)
      try { stamp.close() } catch {}
      destroyLink(link)
    }
    return { fresh, kid }
  }

  function dropOf (sealed, stamp) {
    return dm.encodeDrop({
      dropId: dm.newDropId(),
      kid: b4a.from(stamp.kid, 'hex'),
      rsaSig: b4a.from(stamp.sig, 'base64'),
      token: b4a.from(stamp.token, 'hex'),
      sealed
    })
  }

  // ---- folders ------------------------------------------------------------

  function followKeys (page) {
    try {
      return writer.follows(page).map((f) => typeof f === 'string' ? f : f && f.key).filter((k) => typeof k === 'string')
    } catch {
      return []
    }
  }

  function folded (page, s) {
    return dmFold.fold({
      self: page,
      followSet: followKeys(page),
      seen: s.seen,
      ops: s.ops,
      messages: s.messages.map((m) => ({ id: m.id, from: m.from, to: m.mine ? m.peer : page, text: m.text, replyTo: m.replyTo, at: m.at, filedAt: m.filedAt }))
    })
  }

  function threadOf (page, s, peer) {
    const { inbox, requests } = folded(page, s)
    return inbox.find((c) => c.peer === peer) || requests.find((c) => c.peer === peer) || null
  }

  function hasMessage (s, from, id) {
    return s.messages.some((m) => m.from === from && m.id === id)
  }

  async function list (page, { folder = 'inbox', limit = 30, before = null } = {}) {
    pageParam(page)
    return withState(page, async (s) => {
      const { inbox, requests } = folded(page, s)
      const all = folder === 'request' ? requests : inbox
      let start = 0
      if (before !== null && before !== undefined) {
        const i = all.findIndex((c) => c.at === before.at && c.peer === before.peer)
        if (i !== -1) {
          start = i + 1
        } else {
          const t = Date.parse(before.at)
          start = all.findIndex((c) => Date.parse(c.at) < t || (Date.parse(c.at) === t && c.peer > before.peer))
          if (start === -1) start = all.length
        }
      }
      const pageRows = all.slice(start, start + limit)
      const more = start + pageRows.length < all.length
      const tail = pageRows[pageRows.length - 1]
      return {
        conversations: pageRows.map((c) => {
          const last = c.messages[c.messages.length - 1]
          return { peer: c.peer, folder: c.folder, preview: preview(last.text), at: c.at, unread: c.unread, mine: last.mine }
        }),
        next: more && tail ? { at: tail.at, peer: tail.peer } : null,
        requests: requests.some((c) => c.unread),
        inboxUnread: inbox.some((c) => c.unread)
      }
    })
  }

  async function thread (page, { peer, before = null, limit = 30 } = {}) {
    pageParam(page)
    return withState(page, async (s) => {
      const c = threadOf(page, s, peer)
      const state = { folder: c === null ? 'inbox' : c.folder, blocked: !dmFold.canSend({ self: page, peer, ops: s.ops }) }
      if (c === null) return { messages: [], next: null, ...state }
      let end = c.messages.length
      if (before !== null && before !== undefined) {
        const i = c.messages.findIndex((m) => m.id === before)
        if (i !== -1) end = i
      }
      const startAt = Math.max(0, end - limit)
      const rows = c.messages.slice(startAt, end)
      return {
        messages: rows.map((m) => ({ id: m.id, from: m.from, text: m.text, replyTo: m.replyTo, at: m.at, mine: m.mine })),
        next: startAt > 0 && rows.length > 0 ? rows[0].id : null,
        ...state
      }
    })
  }

  async function seen (page, { peer } = {}) {
    pageParam(page)
    return withState(page, async (s) => {
      const c = threadOf(page, s, peer)
      if (c === null) return { ok: true }
      const marks = new Set(s.seen)
      let added = false
      for (const m of c.messages) {
        if (m.mine) continue
        const k = dmFold.seenKey(m.from, m.id)
        if (!marks.has(k)) {
          s.seen.push(k)
          added = true
        }
      }
      if (added) {
        trim(s)
        saveState(page, s)
      }
      return { ok: true }
    })
  }

  // One service holds the page box, so a folder op is filed here and no
  // ctl is sealed: there is no other device to tell, and nothing goes to the
  // peer.
  async function setOp (page, { peer, state } = {}, { recheck = null } = {}) {
    pageParam(page)
    if (peer === page) throw fail('pedido-invalido')
    return withState(page, async (s) => {
      if (s.stopped) throw fail('encerrada')
      // Queued behind a send: the role is checked again when its turn comes.
      if (typeof recheck === 'function') {
        let ok = false
        try {
          ok = recheck() === true
        } catch {}
        if (!ok) throw fail('sem-permissao')
      }
      s.ops.push({ t: 'ctl', id: dm.newMessageId(), op: state, peer, at: new Date().toISOString(), filedAt: nextFiled(s) })
      trim(s)
      saveState(page, s)
      return { ok: true }
    })
  }

  // ---- sending ------------------------------------------------------------

  function sendHash (to, text, replyTo) {
    return nodeCrypto.createHash('sha256').update(JSON.stringify([to, text, replyTo])).digest('hex')
  }

  function sweepSends (s) {
    const t = Date.now()
    for (const [k, v] of Object.entries(s.sends)) if (!isPlainObject(v) || v.expiresAt <= t) delete s.sends[k]
    const ids = Object.keys(s.sends)
    for (let i = 0; i <= ids.length - MAX_SENDS; i++) delete s.sends[ids[i]]
  }

  function fileSent (s, entry) {
    if (!hasMessage(s, entry.from, entry.id)) {
      s.messages.push({ id: entry.id, peer: entry.to, from: entry.from, text: entry.text, replyTo: entry.replyTo, at: entry.at, mine: true, filedAt: nextFiled(s) })
      trim(s)
    }
  }

  async function takeTwo (page, s) {
    let items = usable(s.wallet)
    if (items.length < 2) {
      // The chain is ours: the top-up below must not wait on it.
      const fresh = await issueStamps(page, dm.DM_STAMP_WALLET - items.length).catch(() => ({ fresh: [], kid: null }))
      if (fresh.fresh.length > 0) {
        const w = s.wallet
        const kids = w.kids[0] === fresh.kid ? w.kids : [fresh.kid, ...w.kids.slice(0, 1)]
        s.wallet = { items: [...w.items.filter((x) => kids.includes(x.kid)), ...fresh.fresh], kids }
        items = usable(s.wallet)
      }
    }
    if (items.length < 2) return null
    const taken = items.slice(0, 2)
    const spent = new Set(taken.map((x) => x.token))
    s.wallet = { items: s.wallet.items.filter((x) => !spent.has(x.token)), kids: s.wallet.kids }
    return taken
  }

  // idem: { member, nonce, recheck? } of the signed request. recheck() is
  // the route's admin check, run again on the page's DM chain right before
  // anything is sealed or delivered as the page: the recipient lookup can
  // take until its deadline, and an admin removed meanwhile is refused
  // 'sem-permissao' with nothing filed. -> { id, at }.
  async function send (page, { to, text, replyTo = null } = {}, idem = {}) {
    pageParam(page)
    if (!isPlainObject(idem) || typeof idem.member !== 'string' || typeof idem.nonce !== 'string') throw fail('pedido-invalido')
    if (idem.recheck !== undefined && typeof idem.recheck !== 'function') throw fail('pedido-invalido')
    const allowed = () => {
      let ok = true
      try {
        if (idem.recheck !== undefined) ok = idem.recheck() === true
      } catch {
        ok = false
      }
      if (!ok) throw fail('sem-permissao')
    }
    const slot = idem.member + ':' + idem.nonce
    const hash = sendHash(to, text, replyTo)
    // -> the saved entry of this request, or null when a new one may be made.
    const admit = (s) => {
      if (s.stopped || !live(page)) throw fail('encerrada')
      sweepSends(s)
      const entry = s.sends[slot]
      if (entry !== undefined && entry.hash !== hash) throw fail('expirado')
      if (entry !== undefined) return entry
      if (to === page) throw fail('para-si')
      if (!dmFold.canSend({ self: page, peer: to, ops: s.ops })) throw fail('bloqueou')
      if (blockedKey(to)) throw fail('sem-permissao')
      if (replyTo !== null) {
        const c = threadOf(page, s, to)
        if (c === null || dmFold.replyTarget(c.messages, replyTo) === null) throw fail('resposta-invalida')
      }
      return null
    }
    const resent = await withState(page, async (s) => {
      const entry = admit(s)
      if (entry === null) return null
      if (!entry.done) {
        allowed()
        await deliver(page, s, slot, entry)
      }
      return { id: entry.id, at: entry.at }
    })
    if (resent !== null) return resent
    // The recipient's diary is read off the page's chain, so its list, pull
    // and ops do not wait on the network; the checks run again once back.
    const box = await lookupBox(to)
    if (box === null) throw fail('sem-caixa')
    return withState(page, async (s) => {
      let entry = admit(s)
      if (entry === null || !entry.done) allowed()
      if (entry === null) {
        const own = boxOf(page)
        if (own === null) throw fail('sem-caixa')
        const ownBox = hex(own.publicKey)
        zeroPair(own)
        let cert
        try {
          cert = writer.certOf(page)
        } catch {
          throw fail('pausada')
        }
        const id = dm.newMessageId()
        const at = new Date().toISOString()
        const pair = signingPair(page)
        let inner
        try {
          inner = dm.buildInner({ kind: 'msg', id, at, to, text, replyTo, cert }, pair)
        } catch (err) {
          throw fail(err && err.message === 'mensagem longa demais' ? 'longa-demais' : 'pedido-invalido')
        } finally {
          pair.secretKey.fill(0)
        }
        let sealedTo, sealedSelf
        try {
          sealedTo = dm.sealInner(inner, box)
          sealedSelf = dm.sealInner(inner, ownBox)
        } catch {
          throw fail('sem-caixa')
        } finally {
          inner.fill(0)
        }
        const stamps = await takeTwo(page, s)
        if (stamps === null) {
          saveState(page, s)
          throw fail('sem-selos')
        }
        // The stamp wait can be long: a role lost meanwhile files nothing.
        allowed()
        entry = {
          hash,
          id,
          at,
          from: page,
          to,
          text,
          replyTo,
          drops: [dropOf(sealedTo, stamps[0]), dropOf(sealedSelf, stamps[1])].map((d) => b4a.toString(d, 'base64')),
          acked: [false, false],
          done: false,
          expiresAt: Date.now() + SEND_TTL_MS
        }
        s.sends[slot] = entry
        // Saved before the first put: a resend puts these exact bytes.
        saveState(page, s)
      }
      if (!entry.done) await deliver(page, s, slot, entry)
      return { id: entry.id, at: entry.at }
    })
  }

  async function deliver (page, s, slot, entry) {
    let link
    try {
      link = await openDropLink()
    } catch (err) {
      throw fail(err && err.code === 'limite' ? 'limite' : 'indisponivel')
    }
    try {
      for (let i = 0; i < entry.drops.length; i++) {
        if (entry.acked[i]) continue
        let r
        try {
          r = await link.put(b4a.from(entry.drops[i], 'base64'))
        } catch {
          note('envio-incerto')
          throw fail('incerto')
        }
        if (!r || !r.ok) {
          if (r && r.reason === 'invalido') {
            delete s.sends[slot]
            saveState(page, s)
          }
          note('envio-recusado')
          throw fail(r && (r.reason === 'cheio' || r.reason === 'ritmo') ? 'limite' : 'pedido-invalido')
        }
        entry.acked[i] = true
        if (i === 0) fileSent(s, entry)
        saveState(page, s)
      }
    } finally {
      link.close()
    }
    entry.done = true
    entry.drops = []
    saveState(page, s)
  }

  // ---- pulling ------------------------------------------------------------

  function pull () {
    if (pulling !== null) return pulling
    const p = pullNow()
    pulling = p
    const clear = () => { if (pulling === p) pulling = null }
    p.then(clear, clear)
    return p
  }

  async function pullNow () {
    await starting
    const boxes = []
    for (const page of writer.pageKeys()) {
      if (!live(page)) continue
      let s
      try {
        s = await withState(page, async (st) => st)
      } catch {
        continue
      }
      if (s.stopped) continue
      const pair = boxOf(page)
      if (pair !== null) boxes.push({ page, pair, at: cursorOf(page), failed: false })
    }
    let added = 0
    let incomplete = false
    let link = null
    try {
      if (boxes.length === 0) return { added, incomplete }
      const mod = { revokedIssuers: revoked() }
      // Nothing is opened, so no cursor moves: the next pull tries again.
      if (mod.revokedIssuers === null) {
        note('revogacao-indisponivel')
        return { added, incomplete: true }
      }
      link = await openDropLink()
      let c = Math.min(...boxes.map((b) => b.at))
      let read = 0
      for (;;) {
        if (closed) break
        let pageRes
        try {
          pageRes = await link.page({ after: c, limit: dm.DM_PAGE_MAX })
        } catch {
          incomplete = true
          break
        }
        const byPage = new Map()
        for (const item of pageRes.items) {
          read += item.bytes.byteLength
          const drop = dm.decodeDrop(item.bytes)
          if (drop === null) continue
          for (const b of boxes) {
            // At or before its own cursor this page already tried the drop.
            if (b.failed || item.seq <= b.at) continue
            const inner = dm.openSealed(drop.sealed, b.pair)
            if (inner === null) continue
            const body = dm.openInner(inner, b.page, { association, revokedIssuers: mod.revokedIssuers })
            if (body !== null && body.kind === 'msg') {
              if (!byPage.has(b.page)) byPage.set(b.page, [])
              byPage.get(b.page).push(body)
            }
            break
          }
        }
        for (const [page, bodies] of byPage) {
          const b = boxes.find((x) => x.page === page)
          let n
          try {
            n = await fileBodies(page, bodies)
          } catch {
            n = null
          }
          // Not filed (stopped meanwhile, storage down): its cursor stays, so
          // the next pull tries these drops again for it.
          if (n === null) {
            b.failed = true
            incomplete = true
          } else {
            added += n
          }
        }
        if (pageRes.items.length > 0) {
          c = pageRes.items[pageRes.items.length - 1].seq
          const moved = []
          for (const b of boxes) {
            if (b.failed || c <= b.at) continue
            b.at = c
            moved.push([b.page, c])
          }
          if (moved.length > 0) writeCursor(moved)
        }
        if (pageRes.next === null || pageRes.items.length === 0) break
        if (boxes.every((b) => b.failed)) break
        if (read >= L.budgetBytes) {
          incomplete = true
          break
        }
      }
    } catch (err) {
      note(err && err.code === 'indisponivel' ? 'armazenamento-indisponivel' : 'sem-semeador')
      incomplete = true
    } finally {
      for (const b of boxes) zeroPair(b.pair)
      if (link !== null) link.close()
    }
    return { added, incomplete }
  }

  // -> how many rows were filed, or null when the page is stopped.
  function fileBodies (page, bodies) {
    return withState(page, async (s) => {
      if (s.stopped) return null
      let n = 0
      for (const body of bodies) {
        if (!body.mine && blockedKey(body.from)) continue
        const peer = body.mine ? body.to : body.from
        if (!body.mine && !dmFold.canSend({ self: page, peer, ops: s.ops })) continue
        if (hasMessage(s, body.from, body.id)) continue
        s.messages.push({ id: body.id, peer, from: body.from, text: body.text, replyTo: body.replyTo, at: body.at, mine: body.mine, filedAt: nextFiled(s) })
        n++
      }
      if (n > 0) {
        trim(s)
        saveState(page, s)
      }
      return n
    })
  }

  async function close () {
    if (closed) return
    closed = true
    clearInterval(timer)
    timer = null
    await starting.catch(noop)
    while (inflight.size > 0) await Promise.allSettled([...inflight])
    if (pulling !== null) await pulling.catch(noop)
    master.fill(0)
    states.clear()
  }
}

module.exports = { createPagesDm, PULL_EVERY_MS, STATE_DIR }
