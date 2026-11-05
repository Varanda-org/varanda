'use strict'

// The only appender of every page diary (hosted pages, docs/protocol.md §12).
// Each page is a standalone Hypercore 11 core in compat mode, so its key IS
// the page's Ed25519 public key (the shape notices and Conversas prove). The
// core is created with the PUBLIC key only, so its storage header never
// holds the secret, and the secret is set in memory with setKeyPair (the
// web-member/lib/node-store.js openDiary pattern); the key is read from
// page-keys.js for every write, so a wiped page can no longer append.
// Media items go to one media core per page (key pair mediaSecretKey, same
// rule), declared once by a `media-core` record.
//
// Storage under <dir>/pages-store/: <page>/ the diary, <page>-media/ the
// media core, <page>.json the writer's own state (0600, atomic): the diary
// and media lengths it last wrote, paused, announced, the media core key and
// the item table
// (the only check a post's media descriptors are matched against), the
// idempotency records, and noise-key.json, the link's persistent Noise pair.
//
// Idempotency: append, mediaItem and setFollow take { member, nonce }; the
// write's result is recorded for NONCE_TTL_MS (at most MAX_NONCES per page)
// in the same state save that records the write, so a resend of a request
// whose answer was lost, even across a restart, returns the stored result
// and appends nothing.
//
// Every write runs on a per-page chain; page creation runs on one
// writer-wide chain. A diary or media core whose length is not the one this
// writer last wrote, or whose fork is not 0, was written elsewhere (a leaked
// key, or a crash between the append and the state write): the page is
// paused for good and nothing more is appended ('pausada'). Only
// mediaItem() and setFollow() write `media-core` and `follow` records, and a
// post or profile may only point at items of the page's own item table.
//
// The link: one WebSocket to the loopback seeder (/seeder), wrapped as a
// NoiseSecretStream initiator with the persistent pair, the admission
// channel in the member role, have = the diary keys only (media keys never
// travel on admission, packages/core/lib/seeder.js), an announce { key,
// cert } per page after the seeder's hello and at creation, and every
// diary and media core replicated on it once the seeder's hello proved it
// holds a seeder certificate (nothing is replicated before). It reconnects with a 1 s .. 60 s
// backoff. `pushed` says the seeder's have/admitted reached the new length
// within PUSH_TIMEOUT_MS.
//
// Close and move (docs/protocol.md §12): closePage appends the caller's
// unfollows, group leaves and tombstones, then the countersigned page-close,
// clears the deleted blocks and removes the page's sealed DM rows; the
// closed diary stays announced and served, read only, and its secrets are
// wiped once the seeder holds the page-close (`closed` in the state file).
// movePage creates the new key's diary (genesis plus page-origin, announced
// only once page-moved landed on the old one), then appends page-moved to
// the old one; the old key's secrets are wiped once the new diary reached
// the seeder, and the old diary stays announced, read only. A deferred wipe
// is armed again after a restart. A page-close or page-moved this writer
// appended is terminal: nothing more is appended to that diary. A paused
// page gets no new block ({ paused: true }).
//
// Single writer: every write (state file, diary or media append, a cleared
// block, the noise key) asks guard() (the account service's lock) first, and
// fail() refuses every later one; a refused write throws { code:
// 'indisponivel' }. Two holders appending to one core would fork it.
//
// Nothing logged ever names a key.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { WebSocket, createWebSocketStream } = require('ws')
const { writeJsonAtomic, appendRecords, readAll, readRaw } = require('@varanda/core/lib/store')
const { refuseSymlinkDir, certForKey, seederCertForKey, isPlainObject } = require('@varanda/core/lib/cert')
const { attachAdmission, MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { generateNoiseKeyPair } = require('@varanda/core/lib/net')
const {
  MEDIA_BLOCK_BYTES, MAX_MEDIA_BLOCKS, MAX_MEDIA_BYTES, MAX_MEDIA_ITEM_BLOCKS, MEDIA_MIMES,
  AVATAR_SIDE, AVATAR_MIMES, MAX_AVATAR_BLOCKS,
  memberCertRecord, mediaCoreRecord, followRecord, validDescriptor, validAvatar, validRecordCopy, validateRecord, isHex64
} = require('@varanda/core/lib/records')
const { mediaHeader, latestMediaCores } = require('@varanda/core/lib/media')
const { deletedSeqs, deletedRanges, clearDeleted: clearDeletedSeqs, clearRanges, overlaps } = require('@varanda/core/lib/deletion')
const { engagementState } = require('@varanda/core/lib/engagement')
const { stillImageSize } = require('@varanda/core/lib/still-image')
const { MAX_PAGE_FOLLOWS } = require('@varanda/core/lib/page')
const { pageLifecycle, verifyClose, verifyMoved } = require('@varanda/core/lib/page-lifecycle')

// Resolved from @varanda/core, as apps/cli/lib/seed-ws.js does: the
// secret-stream the seeder itself speaks, with no dependency of our own.
const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', {
  paths: [path.dirname(require.resolve('@varanda/core/lib/seeder'))]
}))

const STORE_DIR = 'pages-store'
const NOISE_FILE = 'noise-key.json'
const STATE_VERSION = 1
const MAX_PAGES = 256
const PUSH_TIMEOUT_MS = 10000
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60000
const HANDSHAKE_TIMEOUT_MS = 10000
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1024
const DM_KEY_REFRESH_BLOCKS = 256
const MAX_MOVE_DEPTH = 4
// cert, username, genesis roster, page-origin.
const MOVE_GENESIS = 4
const DM_DIR = 'pages-dm'
const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/
const NONCE_ID_RE = /^(append|media|follow):[0-9a-f]{64}:[A-Za-z0-9_-]{1,64}$/
const HEX64_RE = /^[0-9a-f]{64}$/
// A local copy of seeder-health.js SEEDER_HTTP_RE, with ws as well.
const SEEDER_RE = /^(?:http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/
const PNG_MAGIC = b4a.from([0x89, 0x50, 0x4e, 0x47])
const GIF_MAGIC = b4a.from([0x47, 0x49, 0x46, 0x38])

function noop () {}

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function sha256Hex (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

// -> 'ws://host:port/seeder', or null when value is not a loopback URL.
function parseSeederWs (value) {
  if (typeof value !== 'string') return null
  const m = SEEDER_RE.exec(value)
  if (m === null) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return 'ws://' + m[1] + ':' + port + '/seeder'
}

// The file's bytes, never through a link nor blocking on a FIFO; null when
// it does not exist, 'indisponivel' when it is not a regular file.
function readFileNoFollow (file) {
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

function sameItem (a, b) {
  return a.core === b.core && a.start === b.start && a.blocks === b.blocks && a.sha256 === b.sha256 &&
    a.mime === b.mime && a.bytes === b.bytes && a.width === b.width && a.height === b.height
}

// A plain JSON copy taken before any await, so a caller changing its object
// later changes nothing this writer checks or appends.
function copyJson (value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw fail('invalido')
  }
}

const DELETABLE = ['post', 'like', 'repost', 'profile']

function validItem (it) {
  return isPlainObject(it) && validDescriptor(it)
}

// -> { member, nonce } or null; a malformed one is a refusal.
function idempotency (opts) {
  if (opts === undefined || opts === null) return null
  if (!isPlainObject(opts) || typeof opts.member !== 'string' || !HEX64_RE.test(opts.member) ||
      typeof opts.nonce !== 'string' || !NONCE_RE.test(opts.nonce)) throw fail('invalido')
  return { member: opts.member, nonce: opts.nonce }
}

function validNonces (obj) {
  if (!isPlainObject(obj)) return false
  for (const [id, v] of Object.entries(obj)) {
    if (!NONCE_ID_RE.test(id) || !isPlainObject(v) || !Number.isSafeInteger(v.seq) || v.seq < 0 ||
        !Number.isSafeInteger(v.length) || v.length < 0 || !Number.isSafeInteger(v.expiresAt) ||
        !(v.descriptor === undefined || validItem(v.descriptor))) return false
  }
  return true
}

function createPagesWriter ({ dir, keys, association, seederWs = null, log = noop, pushTimeoutMs = PUSH_TIMEOUT_MS, maxPages = MAX_PAGES, guard = () => true, now = Date.now } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a path')
  if (typeof guard !== 'function') throw new TypeError('guard must be a function')
  if (!keys || typeof keys.get !== 'function') throw new TypeError('keys must be a page-keys table')
  if (typeof association !== 'string' || !HEX64_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  const url = seederWs === null || seederWs === undefined ? null : parseSeederWs(seederWs)
  if (seederWs !== null && seederWs !== undefined && url === null) throw new TypeError('seederWs must be a loopback http or ws URL with a port')
  const pageCap = Number.isSafeInteger(maxPages) && maxPages > 0 ? Math.min(maxPages, MAX_PAGES) : MAX_PAGES

  refuseSymlinkDir(dir)
  const storeDir = path.join(dir, STORE_DIR)
  const pages = new Map() // key -> page
  const remote = new Map() // key -> length the seeder last advertised
  const waiters = new Set()
  let closed = false
  let conn = null
  let backoff = BACKOFF_MIN_MS
  let reconnectTimer = null
  let noisePair = null
  let creating = Promise.resolve()
  let failed = false

  const opening = open()
  opening.catch(noop)

  return {
    ready: () => opening,
    createPage,
    closePage,
    movePage,
    append,
    readEntries,
    mediaItem,
    avatarItem,
    items,
    nonceRecord,
    follows,
    setFollow,
    engagement,
    clearDeleted,
    unannounce,
    wipe,
    info,
    pageKeys: () => [...pages.keys()],
    certOf,
    ensureDmKey,
    connected: () => conn !== null && conn.ready,
    fail: failWriter,
    close
  }

  function check () {
    let ok = false
    try {
      ok = !failed && guard() === true
    } catch {}
    if (!ok) throw fail('indisponivel')
  }

  // The lock is gone: nothing more is written, starting now.
  function failWriter () {
    failed = true
  }

  // ---- storage --------------------------------------------------------

  function statePath (key) {
    return path.join(storeDir, key + '.json')
  }

  function saveState (p) {
    // An unreadable state file is kept as found for the operator.
    if (p.stateLost) throw fail('pausada')
    check()
    refuseSymlinkDir(storeDir)
    writeJsonAtomic(statePath(p.key), {
      v: STATE_VERSION,
      length: p.length,
      mediaLength: p.mediaLength,
      paused: p.paused,
      announced: p.announced,
      media: p.mediaKey,
      items: p.items,
      nonces: p.nonces,
      movedTo: p.movedTo,
      closed: p.closed === true
    }, 0o600)
  }

  function readState (key) {
    let data
    try {
      data = JSON.parse(b4a.toString(readFileNoFollow(statePath(key)), 'utf8'))
    } catch {
      return null
    }
    if (!isPlainObject(data) || data.v !== STATE_VERSION || !Number.isSafeInteger(data.length) || data.length < 0 ||
        !Number.isSafeInteger(data.mediaLength) || data.mediaLength < 0 ||
        typeof data.paused !== 'boolean' || typeof data.announced !== 'boolean' ||
        !(data.media === null || (typeof data.media === 'string' && HEX64_RE.test(data.media))) ||
        !Array.isArray(data.items) || !data.items.every(validItem) ||
        !(data.nonces === undefined || validNonces(data.nonces)) ||
        !(data.movedTo === undefined || data.movedTo === null || (typeof data.movedTo === 'string' && HEX64_RE.test(data.movedTo))) ||
        !(data.closed === undefined || typeof data.closed === 'boolean')) return null
    if (data.nonces === undefined) data.nonces = {}
    if (data.movedTo === undefined) data.movedTo = null
    if (data.closed === undefined) data.closed = false
    return data
  }

  function loadNoisePair () {
    const file = path.join(storeDir, NOISE_FILE)
    const raw = readFileNoFollow(file)
    try {
      const data = raw === null ? null : JSON.parse(b4a.toString(raw, 'utf8'))
      if (isPlainObject(data) && /^[0-9a-f]{64}$/.test(data.publicKey) && /^[0-9a-f]{128}$/.test(data.secretKey)) {
        return { publicKey: b4a.from(data.publicKey, 'hex'), secretKey: b4a.from(data.secretKey, 'hex') }
      }
    } catch {}
    const kp = generateNoiseKeyPair()
    check()
    writeJsonAtomic(file, { publicKey: hex(kp.publicKey), secretKey: hex(kp.secretKey) }, 0o600)
    return kp
  }

  // A core opened with the public key only; the secret, when given, is set
  // in memory. Its key must be that public key.
  async function openCore (location, publicKey, secretKey, valueEncoding) {
    const opts = { keyPair: { publicKey }, compat: true }
    if (valueEncoding) opts.valueEncoding = valueEncoding
    const core = new Hypercore(location, opts)
    try {
      await core.ready()
      if (!b4a.equals(core.key, publicKey)) throw new Error('núcleo de outra chave')
    } catch (err) {
      await core.close().catch(noop)
      throw err
    }
    if (secretKey) core.setKeyPair({ publicKey, secretKey })
    return core
  }

  // The page's row from page-keys, or null when it was wiped.
  function rowOf (key) {
    return keys.enabled ? keys.get(key) : null
  }

  function zero (row) {
    if (!row) return
    for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) if (row[k]) row[k].fill(0)
    if (row.writers) for (const w of Object.keys(row.writers)) row.writers[w].fill(0)
  }

  async function open () {
    if (!keys.enabled) return
    refuseSymlinkDir(storeDir)
    let names = []
    try {
      names = fs.readdirSync(storeDir, { withFileTypes: true })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    for (const entry of names) {
      if (!entry.isDirectory() || !HEX64_RE.test(entry.name)) continue
      if (liveCount() >= pageCap) break
      const key = entry.name
      const row = rowOf(key)
      // A moved or closed page whose secrets are gone is still served, read
      // only.
      const state = readState(key)
      if (row === null && (state === null || (state.movedTo === null && !state.closed))) continue
      try {
        await openPage(key, row, state)
      } catch {
        log({ event: 'page-open-failed' })
      } finally {
        zero(row)
      }
    }
    if (url !== null && !closed) {
      try {
        noisePair = loadNoisePair()
      } catch {
        log({ event: 'pages-link', state: 'indisponivel' })
        return
      }
      connect()
    }
  }

  // state null: an unreadable state opens the page paused, not announced,
  // and the state file is never rewritten (fail closed).
  async function openPage (key, row, state) {
    const publicKey = b4a.from(key, 'hex')
    const core = await openCore(path.join(storeDir, key), publicKey, null, 'json')
    const p = {
      key,
      core,
      media: null,
      mediaKey: state ? state.media : null,
      length: state ? state.length : core.length,
      mediaLength: state ? state.mediaLength : 0,
      paused: state ? state.paused : true,
      announced: state ? state.announced : false,
      stateLost: state === null,
      items: state ? state.items : [],
      nonces: state ? state.nonces : {},
      movedTo: state ? state.movedTo : null,
      closed: state ? state.closed : false,
      terminal: null,
      wipeAfter: null,
      cert: null,
      follows: new Map(),
      chain: Promise.resolve()
    }
    if (p.movedTo !== null) {
      p.terminal = 'movida'
      if (row !== null) p.wipeAfter = { key: p.movedTo, length: MOVE_GENESIS }
    } else if (p.closed) {
      p.terminal = 'encerrada'
      if (row !== null) p.wipeAfter = { key, length: core.length }
    }
    pages.set(key, p)
    try {
      // A terminal page is served read only, so its media core opens from
      // the state alone; a writable one must match its row.
      if (p.mediaKey !== null && (row !== null || p.terminal !== null)) {
        if (row !== null && hex(row.mediaSecretKey.subarray(32)) !== p.mediaKey) throw new Error('núcleo de mídia de outra chave')
        p.media = await openCore(path.join(storeDir, key + '-media'), b4a.from(p.mediaKey, 'hex'), null, null)
      }
      if (core.length > 0) {
        const block0 = await core.get(0, { wait: false })
        if (block0 && block0.type === 'member-cert') p.cert = block0.cert
      }
      const entries = await readAll(core)
      for (const { seq, record } of entries) {
        foldFollow(p, seq, record)
        foldTerminal(p, record)
      }
      if (row !== null && !p.stateLost && p.terminal !== null && p.movedTo === null && !p.closed) recoverTerminal(p, entries)
      if (!p.paused && foreign(p)) pause(p)
    } catch (err) {
      pages.delete(key)
      await closeCores(p)
      throw err
    }
    return p
  }

  // A terminal record in the log the state file missed (its save failed, or
  // a crash came first): the wipe it owes is armed again.
  function recoverTerminal (p, entries) {
    const lc = pageLifecycle(entries, p.key, association)
    if (lc.movedTo !== null) {
      p.movedTo = lc.movedTo.to
      p.wipeAfter = { key: p.movedTo, length: MOVE_GENESIS }
    } else if (lc.closed !== null) {
      p.closed = true
      p.wipeAfter = { key: p.key, length: p.core.length }
    } else {
      return
    }
    try { saveState(p) } catch {}
  }

  async function closeCores (p) {
    await p.core.close().catch(noop)
    if (p.media) await p.media.close().catch(noop)
  }

  function pause (p) {
    p.paused = true
    try {
      saveState(p)
    } catch {}
    log({ event: 'page-paused' })
  }

  // The diary or media core was written by someone else.
  function foreign (p) {
    if (p.core.length !== p.length || p.core.fork !== 0) return true
    if (p.media === null) return false
    return p.media.length !== p.mediaLength || p.media.fork !== 0
  }

  function foldFollow (p, seq, record) {
    const copy = validRecordCopy(record, seq)
    if (copy === null || copy.type !== 'follow' || copy.key === p.key) return
    p.follows.set(copy.key, { on: copy.on, seq })
  }

  // Only a countersigned record ends the page. A leaked key's unsigned one
  // stays a foreign block (the page pauses), so the owner can still close or
  // move it.
  function foldTerminal (p, record) {
    if (!isPlainObject(record) || p.terminal !== null || record.page !== p.key) return
    if (record.type === 'page-close' && verifyClose(record, p.key, association).ok) p.terminal = 'encerrada'
    else if (record.type === 'page-moved' && verifyMoved(record, p.key, association).ok) p.terminal = 'movida'
  }

  function followList (p) {
    const out = []
    for (const [key, { on, seq }] of p.follows) if (on) out.push({ key, seq })
    return out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }

  function pageOf (key) {
    const p = typeof key === 'string' ? pages.get(key) : undefined
    if (p === undefined) throw fail('nao-encontrada')
    return p
  }

  // Runs fn on the page's chain, with the page writable: not paused, not
  // closed or moved, its key still in page-keys (set in memory for fn and
  // zeroed after), and the diary at the length this writer last wrote.
  // orPaused(p), when given, answers for a paused page instead of the
  // refusal; closing lets a closed page through, so a close cut short
  // between its page-close and the wipe can be finished.
  async function withPage (key, fn, { orPaused = null, closing = false } = {}) {
    await opening
    if (closed) throw fail('fechado')
    check()
    const p = pageOf(key)
    const run = async () => {
      if (closed) throw fail('fechado')
      check()
      if (pages.get(key) !== p) throw fail('nao-encontrada')
      if (p.terminal !== null && !(closing && p.terminal === 'encerrada')) throw fail(p.terminal)
      if (p.paused) {
        if (orPaused !== null) return orPaused(p)
        throw fail('pausada')
      }
      const row = rowOf(key)
      // A closed page whose secrets went after its push stays served.
      if (row === null && p.terminal !== null) throw fail('chave-ausente')
      if (row === null) {
        pages.delete(key)
        await closeCores(p)
        restartLink()
        throw fail('chave-ausente')
      }
      if (foreign(p)) {
        zero(row)
        pause(p)
        if (orPaused !== null) return orPaused(p)
        throw fail('pausada')
      }
      p.core.setKeyPair({ publicKey: p.core.key, secretKey: row.secretKey })
      try {
        return await fn(p, row)
      } finally {
        p.core.setKeyPair({ publicKey: p.core.key, secretKey: null })
        if (p.media) p.media.setKeyPair({ publicKey: p.media.key, secretKey: null })
        zero(row)
      }
    }
    const next = p.chain.then(run, run)
    p.chain = next.catch(noop)
    return next
  }

  // The key may have been wiped while this call waited: nothing is signed
  // for a page whose row is gone.
  function stillKeyed (p) {
    const row = rowOf(p.key)
    if (row === null) throw fail('chave-ausente')
    zero(row)
  }

  // A committed write whose state could not be saved: memory already holds
  // it, the file does not, so the page stops until an operator looks.
  function saveOrPause (p) {
    try {
      saveState(p)
    } catch (err) {
      pause(p)
      throw err
    }
  }

  function nonceId (kind, idem) {
    return kind + ':' + idem.member + ':' + idem.nonce
  }

  // The stored result of an earlier write with this member and nonce, or null.
  function recall (p, kind, idem) {
    if (idem === null) return null
    const v = p.nonces[nonceId(kind, idem)]
    if (v === undefined || v.expiresAt <= now()) return null
    return v
  }

  // Set in memory only; the caller's next saveState writes it with the write.
  function remember (p, kind, idem, value) {
    if (idem === null) return
    const t = now()
    for (const [id, v] of Object.entries(p.nonces)) if (v.expiresAt <= t) delete p.nonces[id]
    const ids = Object.keys(p.nonces)
    for (let i = 0; i <= ids.length - MAX_NONCES; i++) delete p.nonces[ids[i]]
    p.nonces[nonceId(kind, idem)] = { ...value, expiresAt: t + NONCE_TTL_MS }
  }

  function copyRecord (v) {
    if (v === null) return null
    const out = { seq: v.seq, length: v.length }
    if (v.descriptor !== undefined) out.descriptor = { ...v.descriptor }
    return out
  }

  // -> { append, media, follow }: each the stored { seq, length[, descriptor] }
  // of a write with this member and nonce, or null.
  function nonceRecord (key, member, nonce) {
    const idem = idempotency({ member, nonce })
    const p = pageOf(key)
    return { append: copyRecord(recall(p, 'append', idem)), media: copyRecord(recall(p, 'media', idem)), follow: copyRecord(recall(p, 'follow', idem)) }
  }

  // Appends 1..8 records and records the new length -> the last seq. A
  // length other than the one this append makes pauses the page, and the
  // foreign length is never saved as this writer's. `mark(seq, length)`
  // runs before the state save, so what it records lands with the append.
  async function appendBatch (p, records, mark = null) {
    const prev = p.length
    check()
    stillKeyed(p)
    const seq = await appendRecords(p.core, records)
    if (p.core.length !== prev + records.length) {
      pause(p)
      throw fail('pausada')
    }
    p.length = p.core.length
    const first = seq - records.length + 1
    for (let i = 0; i < records.length; i++) {
      foldFollow(p, first + i, records[i])
      foldTerminal(p, records[i])
    }
    if (mark !== null) mark(seq, p.length)
    saveOrPause(p)
    return seq
  }

  // ---- pages ----------------------------------------------------------

  async function createPage (args = {}) {
    const { cert, usernameRecord, rosterRecord } = copyJson(isPlainObject(args) ? { cert: args.cert, usernameRecord: args.usernameRecord, rosterRecord: args.rosterRecord } : {})
    await opening
    if (closed) throw fail('fechado')
    if (!keys.enabled) throw fail('desligado')
    check()
    const key = genesisKey(cert, usernameRecord, rosterRecord)
    return queueCreate(key, cert, [usernameRecord, rosterRecord])
  }

  // -> the page key the genesis records are for; a mismatch is a refusal.
  function genesisKey (cert, usernameRecord, rosterRecord) {
    if (!isPlainObject(cert) || typeof cert.member !== 'string' || !HEX64_RE.test(cert.member)) throw fail('invalido')
    const key = cert.member
    if (!certForKey(cert, key, association).ok) throw fail('invalido')
    if (!isPlainObject(usernameRecord) || usernameRecord.member !== key || !isPlainObject(rosterRecord) || rosterRecord.page !== key) throw fail('invalido')
    return key
  }

  // One creation at a time: the checks of createNow and the directory it
  // removes on failure are never another call's.
  // Closed and moved pages stay served read only: only live ones count
  // against the host cap, so a close or a move never burns a slot.
  function liveCount () {
    let n = 0
    for (const p of pages.values()) if (p.terminal === null) n++
    return n
  }

  function queueCreate (key, cert, rest, announced = true) {
    const run = () => createNow(key, cert, rest, announced)
    const next = creating.then(run, run)
    creating = next.catch(noop)
    return next
  }

  async function createNow (key, cert, rest, announced) {
    if (closed) throw fail('fechado')
    check()
    if (pages.has(key) || fs.existsSync(path.join(storeDir, key)) || fs.existsSync(statePath(key))) throw fail('existe')
    if (liveCount() >= pageCap) throw fail('limite')
    const row = rowOf(key)
    if (row === null) throw fail('chave-ausente')
    refuseSymlinkDir(storeDir)
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 })
    const publicKey = b4a.from(key, 'hex')
    let core = null
    let p = null
    try {
      core = await openCore(path.join(storeDir, key), publicKey, row.secretKey, 'json')
      p = { key, core, media: null, mediaKey: null, length: 0, mediaLength: 0, paused: false, announced, items: [], nonces: {}, movedTo: null, closed: false, terminal: null, wipeAfter: null, cert, follows: new Map(), chain: Promise.resolve() }
      saveState(p)
      await appendBatch(p, [memberCertRecord(cert), ...rest])
      core.setKeyPair({ publicKey, secretKey: null })
    } catch (err) {
      if (core !== null) await core.close().catch(noop)
      fs.rmSync(path.join(storeDir, key), { recursive: true, force: true })
      fs.rmSync(statePath(key), { force: true })
      throw err.code === 'INVALID_RECORD' ? fail('invalido') : err
    } finally {
      zero(row)
    }
    pages.set(key, p)
    linkAdd(p)
    return { key }
  }

  async function append (key, input, opts) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw fail('invalido')
    const idem = idempotency(opts)
    const records = copyJson(input)
    for (const r of records) {
      if (!isPlainObject(r) || r.type === 'media-core' || r.type === 'follow') throw fail('invalido')
    }
    const { seq, length, replay } = await withPage(key, async (p) => {
      const prior = recall(p, 'append', idem)
      if (prior !== null) return { seq: prior.seq, length: prior.length, replay: true }
      // A tombstone only removes what was published (closing a page needs
      // the profile's); the page's own structure (certs, roster, follows,
      // media cores) stays.
      for (const r of records) if (r.type === 'delete') await checkDeleteTarget(p, r)
      for (const r of records) {
        if (r.type !== 'post' && r.type !== 'profile') continue
        const pointed = []
        if (r.media !== undefined) {
          if (!Array.isArray(r.media)) throw fail('midia-invalida')
          pointed.push(...r.media)
        }
        if (r.avatar !== undefined && r.avatar !== null) pointed.push(r.avatar)
        for (const d of pointed) {
          if (!isPlainObject(d) || !p.items.some((it) => sameItem(it, d))) throw fail('midia-invalida')
        }
      }
      try {
        const mark = (s, n) => remember(p, 'append', idem, { seq: s, length: n })
        return { seq: await appendBatch(p, records, mark), length: p.core.length, replay: false }
      } catch (err) {
        throw err.code === 'INVALID_RECORD' ? fail('invalido') : err
      }
    })
    const pushed = await waitPushed(key, length)
    return replay ? { seq, length, pushed, replay } : { seq, length, pushed }
  }

  async function checkDeleteTarget (p, r) {
    if (!Number.isSafeInteger(r.seq) || r.seq < 1 || r.seq >= p.length) throw fail('invalido')
    let target = null
    try {
      target = await p.core.get(r.seq, { wait: false })
    } catch {}
    if (!isPlainObject(target) || !DELETABLE.includes(target.type)) throw fail('invalido')
  }

  async function readEntries (key) {
    await opening
    return readAll(pageOf(key).core)
  }

  function info (key) {
    const p = pageOf(key)
    return { length: p.core.length, paused: p.paused, announced: p.announced, movedTo: p.movedTo }
  }

  function certOf (key) {
    return copyJson(pageOf(key).cert)
  }

  // The hook of page Conversas (./pages-dm.js): appends { type: 'dm-key',
  // box, gen } unless the newest valid dm-key is exactly that and within the
  // newest DM_KEY_REFRESH_BLOCKS blocks (the person's refresh rule,
  // packages/web-member/lib/member-ops.js dmKeyCurrent), on the page's
  // chain, so two callers never append it twice. -> { seq | null, length,
  // pushed }.
  async function ensureDmKey (key, { box, gen } = {}) {
    if (typeof box !== 'string' || !HEX64_RE.test(box) || !Number.isSafeInteger(gen) || gen < 1) throw fail('invalido')
    const res = await withPage(key, async (p) => {
      const floor = Math.max(1, p.length - DM_KEY_REFRESH_BLOCKS)
      let best = null
      if (p.dmKey && p.dmKey.seq >= floor && p.dmKey.seq < p.length) {
        best = p.dmKey
      } else {
        for (let seq = p.length - 1; seq >= floor; seq--) {
          let r = null
          try {
            r = await p.core.get(seq, { wait: false })
          } catch {}
          if (!isPlainObject(r) || r.type !== 'dm-key' || validateRecord(r, seq) !== null) continue
          if (best === null || r.gen > best.gen) best = { box: r.box, gen: r.gen, seq }
        }
      }
      if (best !== null && best.box === box && best.gen === gen) {
        p.dmKey = best
        return { seq: null, length: p.length }
      }
      try {
        const seq = await appendBatch(p, [{ type: 'dm-key', box, gen, at: new Date(now()).toISOString() }])
        p.dmKey = { box, gen, seq }
        return { seq, length: p.length }
      } catch (err) {
        throw err.code === 'INVALID_RECORD' ? fail('invalido') : err
      }
    })
    if (res.seq === null) return { ...res, pushed: true }
    return { ...res, pushed: await waitPushed(key, res.length) }
  }

  // ---- media ----------------------------------------------------------

  async function mediaItem (key, { bytes: input, mime, width, height, sha256 } = {}, opts) {
    const idem = idempotency(opts)
    if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES) throw fail('midia-invalida')
    const bytes = b4a.from(input)
    if (typeof sha256 !== 'string' || !HEX64_RE.test(sha256) || sha256Hex(bytes) !== sha256) throw fail('midia-invalida')
    if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw fail('midia-invalida')
    if (mime === 'image/jpeg' || mime === 'image/webp') {
      const size = stillImageSize(bytes, mime)
      if (size === null || size.width !== width || size.height !== height) throw fail('midia-invalida')
    } else {
      const magic = mime === 'image/png' ? PNG_MAGIC : GIF_MAGIC
      if (bytes.byteLength < magic.byteLength || !b4a.equals(bytes.subarray(0, magic.byteLength), magic)) throw fail('midia-invalida')
    }
    const blocks = Math.ceil(bytes.byteLength / MEDIA_BLOCK_BYTES)
    const shape = { core: '0'.repeat(64), mime, start: 1, blocks, bytes: bytes.byteLength, sha256, width, height }
    if (!validDescriptor(shape)) throw fail('midia-invalida')

    return withPage(key, async (p, row) => {
      const prior = recall(p, 'media', idem)
      if (prior !== null) return { ...prior.descriptor }
      const media = await ownMediaCore(p, row)
      if (media.length + blocks > MAX_MEDIA_BLOCKS || media.byteLength + bytes.byteLength > MAX_MEDIA_BYTES) throw fail('limite')
      const declared = latestMediaCores(await readAll(p.core), p.key).some((c) => c.key === p.mediaKey)
      if (!declared) await appendBatch(p, [mediaCoreRecord({ key: p.mediaKey })])
      const chunks = []
      for (let i = 0; i < blocks; i++) chunks.push(b4a.from(bytes.subarray(i * MEDIA_BLOCK_BYTES, Math.min(bytes.byteLength, (i + 1) * MEDIA_BLOCK_BYTES))))
      const start = p.mediaLength
      const descriptor = { core: p.mediaKey, mime, start, blocks, bytes: bytes.byteLength, sha256, width, height }
      if (!validDescriptor(descriptor)) throw fail('midia-invalida')
      check()
      stillKeyed(p)
      await media.append(chunks)
      if (media.length !== start + blocks) {
        pause(p)
        throw fail('pausada')
      }
      p.mediaLength = media.length
      p.items.push(descriptor)
      remember(p, 'media', idem, { seq: 0, length: p.core.length, descriptor })
      saveOrPause(p)
      return { ...descriptor }
    })
  }

  // The page's media core, created with its header naming the page when new
  // (public key only in storage), with the media secret set in memory.
  async function ownMediaCore (p, row) {
    const publicKey = row.mediaSecretKey.subarray(32)
    const mediaHex = hex(publicKey)
    if (mediaHex === p.key) throw fail('midia-invalida')
    if (p.media === null) {
      check()
      const media = await openCore(path.join(storeDir, p.key + '-media'), b4a.from(publicKey), null, null)
      // A media core already written elsewhere is never declared nor
      // replicated as this page's.
      if (media.length !== p.mediaLength || media.fork !== 0) {
        await media.close().catch(noop)
        pause(p)
        throw fail('pausada')
      }
      p.media = media
      p.mediaKey = mediaHex
      saveOrPause(p)
      if (conn !== null && conn.ready && p.announced) p.media.replicate(conn.noise)
    } else if (p.mediaKey !== mediaHex) {
      throw fail('midia-invalida')
    }
    if (p.media.length !== p.mediaLength || p.media.fork !== 0) {
      pause(p)
      throw fail('pausada')
    }
    p.media.setKeyPair({ publicKey: p.media.key, secretKey: row.mediaSecretKey })
    if (p.mediaLength === 0) {
      check()
      stillKeyed(p)
      await p.media.append(b4a.from(JSON.stringify(mediaHeader({ diary: p.key }))))
      if (p.media.length !== 1) {
        pause(p)
        throw fail('pausada')
      }
      p.mediaLength = 1
      saveOrPause(p)
    }
    return p.media
  }

  async function avatarItem (key, bytes, mime, opts) {
    if (!AVATAR_MIMES.includes(mime) || !(bytes instanceof Uint8Array)) throw fail('midia-invalida')
    if (Math.ceil(bytes.byteLength / MEDIA_BLOCK_BYTES) > MAX_AVATAR_BLOCKS) throw fail('midia-invalida')
    const size = stillImageSize(bytes, mime)
    if (size === null || size.width !== AVATAR_SIDE || size.height !== AVATAR_SIDE) throw fail('midia-invalida')
    const descriptor = await mediaItem(key, { bytes, mime, width: AVATAR_SIDE, height: AVATAR_SIDE, sha256: sha256Hex(bytes) }, opts)
    if (!validAvatar(descriptor)) throw fail('midia-invalida')
    return descriptor
  }

  function items (key) {
    return pageOf(key).items.map((it) => ({ ...it }))
  }

  // ---- follows, engagement, deletion ----------------------------------

  function follows (key) {
    return followList(pageOf(key))
  }

  async function setFollow (key, target, on, opts) {
    if (typeof target !== 'string' || !isHex64(target) || typeof on !== 'boolean') throw fail('invalido')
    if (target === key) throw fail('propria-pagina')
    const idem = idempotency(opts)
    const { seq, length } = await withPage(key, async (p) => {
      const prior = recall(p, 'follow', idem)
      if (prior !== null) return { seq: prior.seq, length: prior.length }
      if (on && !(p.follows.get(target) || {}).on && followList(p).length >= MAX_PAGE_FOLLOWS) throw fail('limite')
      const mark = (s, n) => remember(p, 'follow', idem, { seq: s, length: n })
      return { seq: await appendBatch(p, [followRecord({ key: target, on })], mark), length: p.core.length }
    })
    const pushed = await waitPushed(key, length)
    return { seq, length, pushed, follows: follows(key) }
  }

  async function engagement (key) {
    await opening
    return engagementState(await readAll(pageOf(key).core))
  }

  // Clears the diary blocks `deleted` names (default: every block an
  // effective tombstone deletes) and the media ranges the tombstones
  // release; item table rows inside a cleared range are dropped.
  async function clearDeleted (key, deleted) {
    return withPage(key, (p) => clearOn(p, deleted))
  }

  async function clearOn (p, deleted) {
    const raw = await readRaw(p.core)
    check()
    const seqs = [...(deleted === undefined ? deletedSeqs(raw) : deleted)].filter((seq) => seq !== 0)
    const cleared = await clearDeletedSeqs(p.core, seqs)
    let ranges = []
    if (p.media !== null) {
      ranges = deletedRanges(raw, [p.mediaKey])
      check()
      await clearRanges(p.media, ranges)
      const kept = p.items.filter((it) => !ranges.some((r) => overlaps(it, r)))
      if (kept.length !== p.items.length) {
        p.items = kept
        saveOrPause(p)
      }
    }
    return { cleared, media: ranges }
  }

  // ---- close and move -------------------------------------------------

  // Under the page's chain: the unfollows, the group leaves and the
  // tombstones the caller built, in batches of at most 8, then the
  // countersigned page-close (`closed` saved with it); the deleted blocks are
  // cleared (block 0 and tombstones never) and the sealed DM rows removed.
  // The page stays announced and served, read only, so later readers get
  // the close; its secrets are wiped once the seeder holds the page-close,
  // now or at a later push. A page already closed finishes the same way.
  // -> { closed, length, pushed, cleared, wiped }, or { paused: true } when
  // the page is paused (nothing appended, nothing wiped: the caller closes
  // the ACL and the directory only).
  async function closePage (key, args = {}) {
    const input = copyJson(isPlainObject(args) ? { unfollows: args.unfollows || [], leaves: args.leaves || [], deletes: args.deletes || [], closeRecord: args.closeRecord } : {})
    const { unfollows, leaves, deletes, closeRecord } = input
    if (!Array.isArray(unfollows) || !Array.isArray(leaves) || !Array.isArray(deletes)) throw fail('invalido')
    if (!unfollows.every((r) => isPlainObject(r) && r.type === 'follow' && r.on === false)) throw fail('invalido')
    if (!leaves.every((r) => isPlainObject(r) && r.type === 'group-join' && r.on === false)) throw fail('invalido')
    if (!deletes.every((r) => isPlainObject(r) && r.type === 'delete')) throw fail('invalido')
    if (!isPlainObject(closeRecord) || closeRecord.type !== 'page-close' || closeRecord.page !== key || validateRecord(closeRecord, 1) !== null) throw fail('invalido')
    let res
    try {
      res = await withPage(key, async (p) => {
        if (p.terminal === null) {
          for (const r of deletes) await checkDeleteTarget(p, r)
          const all = [...unfollows, ...leaves, ...deletes]
          try {
            for (let i = 0; i < all.length; i += 8) await appendBatch(p, all.slice(i, i + 8))
            await appendBatch(p, [closeRecord], () => { p.closed = true })
          } catch (err) {
            throw err.code === 'INVALID_RECORD' ? fail('invalido') : err
          }
        } else if (!p.closed) {
          p.closed = true
          saveOrPause(p)
        }
        const { cleared } = await clearOn(p)
        return { length: p.core.length, cleared: cleared.length }
      }, { orPaused: () => ({ paused: true }), closing: true })
    } catch (err) {
      // Closed and wiped already: the retry of a close cut short after it.
      const p = pages.get(key)
      if (err.code !== 'chave-ausente' || p === undefined || !p.closed) throw err
      res = { length: p.core.length, cleared: 0 }
    }
    if (res.paused) return { paused: true }
    const p = pages.get(key)
    if (p !== undefined && p.closed && p.wipeAfter === null && !p.wiping && !keysGone(key)) p.wipeAfter = { key, length: res.length }
    // The secrets go only once the seeder serves the close; until then the
    // wipe waits for a later push (onRemote), across a restart too.
    const pushed = await waitPushed(key, res.length)
    removeDmRows(key)
    let wiped = false
    if (pushed && p !== undefined) wiped = await wipeMoved(p)
    if (!wiped) wiped = keysGone(key)
    return { closed: true, length: res.length, pushed, cleared: res.cleared, wiped }
  }

  function keysGone (key) {
    const row = rowOf(key)
    if (row === null) return true
    zero(row)
    return false
  }

  // Best effort: the rows are sealed under a key the page row does not hold,
  // so a closed page keeps no readable inbox either.
  function removeDmRows (key) {
    try {
      check()
      const dmDir = path.join(dir, DM_DIR)
      refuseSymlinkDir(dmDir)
      fs.rmSync(path.join(dmDir, key + '.json'), { force: true })
    } catch {
      log({ event: 'page-dm-rows', state: 'incompleto' })
    }
  }

  // K2 (`to`, its row already in page-keys) is created with its genesis and
  // the page-origin at seq 3, then page-moved is appended to K1 (`from`),
  // all on K1's chain. A paused K1 gets no block: the answer carries the
  // record for a detached statement. K1 is read only from then on, still
  // announced; its secrets are wiped once the seeder holds K2's genesis.
  // -> { key, length, pushed, moved: seq | null, wiped, paused?, record? }.
  async function movePage (args = {}) {
    const input = copyJson(isPlainObject(args)
      ? { from: args.from, to: args.to, cert: args.cert, usernameRecord: args.usernameRecord, rosterRecord: args.rosterRecord, originRecord: args.originRecord, movedRecord: args.movedRecord, depth: args.depth }
      : {})
    const { from, to, cert, usernameRecord, rosterRecord, originRecord, movedRecord, depth } = input
    if (!Number.isSafeInteger(depth) || depth < 1) throw fail('invalido')
    if (depth > MAX_MOVE_DEPTH) throw fail('limite')
    if (typeof from !== 'string' || !HEX64_RE.test(from) || from === to) throw fail('invalido')
    await opening
    if (closed) throw fail('fechado')
    if (!keys.enabled) throw fail('desligado')
    check()
    if (genesisKey(cert, usernameRecord, rosterRecord) !== to) throw fail('invalido')
    if (!isPlainObject(originRecord) || originRecord.type !== 'page-origin' || originRecord.page !== to || originRecord.from !== from ||
        validateRecord(originRecord, 3) !== null) throw fail('invalido')
    if (!isPlainObject(movedRecord) || movedRecord.type !== 'page-moved' || movedRecord.page !== from || movedRecord.to !== to ||
        validateRecord(movedRecord, 1) !== null) throw fail('invalido')
    const rest = [usernameRecord, rosterRecord, originRecord]
    const moved = (p) => {
      p.movedTo = to
      p.terminal = 'movida'
      p.wipeAfter = { key: to, length: MOVE_GENESIS }
    }
    // K2 is announced only once K1 says where the page went.
    const announceK2 = () => {
      const p2 = pages.get(to)
      if (p2 === undefined || p2.announced) return
      p2.announced = true
      try {
        saveState(p2)
      } catch {
        log({ event: 'page-announce', state: 'incompleto' })
      }
      linkAdd(p2)
    }
    // K2 created by an earlier run of this move whose answer was uncertain
    // (never announced, no terminal record on K1 yet): the resend reuses it.
    const createK2 = () => {
      const p2 = pages.get(to)
      if (p2 !== undefined && !p2.announced && p2.terminal === null) return
      return queueCreate(to, cert, rest, false)
    }
    const pausedMove = async (p, create) => {
      if (create) await createK2()
      moved(p)
      try { saveState(p) } catch {}
      announceK2()
      return { paused: true }
    }
    const res = await withPage(from, async (p) => {
      await createK2()
      try {
        const seq = await appendBatch(p, [movedRecord], () => moved(p))
        announceK2()
        return { moved: seq }
      } catch (err) {
        // K2 exists by now: a K1 found paused at this append falls back to
        // the detached statement.
        if (err.code !== 'pausada') throw err.code === 'INVALID_RECORD' ? fail('invalido') : err
        return pausedMove(p, false)
      }
    }, { orPaused: (p) => pausedMove(p, true) })
    const pushed = await waitPushed(to, MOVE_GENESIS)
    const p1 = pages.get(from)
    const wiped = pushed && p1 !== undefined ? await wipeMoved(p1) : false
    const out = { key: to, length: MOVE_GENESIS, pushed, moved: res.paused ? null : res.moved, wiped }
    if (res.paused) {
      out.paused = true
      out.record = movedRecord
    }
    return out
  }

  // A moved K1's or a closed page's secrets leave page-keys on its chain,
  // once; a refused wipe is tried again at the next push. -> keys.wipe()'s
  // answer.
  function wipeMoved (p) {
    if (p.wipeAfter === null) return p.wiping || Promise.resolve(false)
    const after = p.wipeAfter
    p.wipeAfter = null
    const run = async () => {
      try {
        check()
        return keys.wipe(p.key)
      } catch {
        if (pages.get(p.key) === p) p.wipeAfter = after
        return false
      }
    }
    const next = p.chain.then(run, run)
    p.chain = next.catch(noop)
    p.wiping = next
    return next
  }

  async function unannounce (key) {
    await opening
    const p = pageOf(key)
    if (!p.announced) return false
    check()
    p.announced = false
    try {
      saveState(p)
    } finally {
      restartLink()
    }
    return true
  }

  // Wipes the page's secrets once its in-flight writes end: the page is
  // unannounced, leaves this writer's table and its cores close, then the
  // row leaves page-keys -> keys.wipe()'s answer.
  async function wipe (key) {
    await opening
    check()
    const p = typeof key === 'string' ? pages.get(key) : undefined
    if (p === undefined) return keys.wipe(key)
    const run = async () => {
      check()
      if (pages.get(key) === p) {
        if (p.announced) {
          p.announced = false
          try { saveState(p) } catch {}
        }
        pages.delete(key)
        await closeCores(p)
        restartLink()
      }
      return keys.wipe(key)
    }
    const next = p.chain.then(run, run)
    p.chain = next.catch(noop)
    return next
  }

  async function close () {
    if (closed) return
    closed = true
    await opening.catch(noop)
    await creating
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (conn !== null) conn.finish()
    for (const w of [...waiters]) w.done(false)
    for (const p of pages.values()) {
      await p.chain
      await closeCores(p)
    }
    pages.clear()
    if (noisePair) noisePair.secretKey.fill(0)
  }

  // ---- link -----------------------------------------------------------

  function haveList () {
    const out = []
    for (const p of pages.values()) {
      if (p.announced && p.cert !== null && out.length < MAX_INVENTORY) out.push({ key: p.key, length: p.core.length })
    }
    return out
  }

  function announce (p) {
    if (conn === null || !conn.ready || !p.announced || p.cert === null) return
    conn.peer.send({ type: 'have', key: p.key, length: p.core.length })
    conn.peer.send({ type: 'announce', key: p.key, cert: p.cert })
  }

  function replicatePage (c, p) {
    if (!p.announced) return
    p.core.replicate(c.noise)
    if (p.media) p.media.replicate(c.noise)
  }

  function linkAdd (p) {
    if (conn === null || !conn.ready) return
    replicatePage(conn, p)
    announce(p)
  }

  function restartLink () {
    if (conn === null) return
    backoff = BACKOFF_MIN_MS
    conn.finish()
  }

  function scheduleReconnect () {
    if (closed || url === null || reconnectTimer !== null) return
    const delay = backoff
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    if (reconnectTimer.unref) reconnectTimer.unref()
  }

  function onRemote (key, length) {
    if (!pages.has(key)) return
    const prev = remote.get(key) || 0
    if (length > prev) remote.set(key, length)
    for (const p of pages.values()) {
      if (p.wipeAfter !== null && p.wipeAfter.key === key && length >= p.wipeAfter.length) wipeMoved(p).catch(noop)
    }
    for (const w of [...waiters]) if (w.key === key && length >= w.length) w.done(true)
  }

  function waitPushed (key, length) {
    if ((remote.get(key) || 0) >= length) return Promise.resolve(true)
    if (conn === null || !conn.ready) return Promise.resolve(false)
    return new Promise((resolve) => {
      const w = {
        key,
        length,
        timer: null,
        done (ok) {
          if (!waiters.delete(w)) return
          clearTimeout(w.timer)
          resolve(ok)
        }
      }
      waiters.add(w)
      w.timer = setTimeout(() => w.done(false), pushTimeoutMs)
    })
  }

  function connect () {
    if (closed) return
    const c = { ws: null, duplex: null, noise: null, peer: null, ready: false, done: false, finish }
    conn = c
    function finish () {
      if (c.done) return
      c.done = true
      if (conn === c) conn = null
      if (c.ready) log({ event: 'pages-link', state: 'down' })
      try { if (c.noise) c.noise.destroy() } catch {}
      try { if (c.duplex) c.duplex.destroy() } catch {}
      try { c.ws.terminate() } catch {}
      scheduleReconnect()
    }
    try {
      c.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
      c.ws.on('error', finish)
      c.ws.once('close', finish)
      c.duplex = createWebSocketStream(c.ws)
      c.duplex.on('error', finish)
      c.noise = new NoiseSecretStream(true, c.duplex, { keyPair: noisePair })
      c.noise.on('error', finish)
      c.noise.once('close', finish)
    } catch {
      finish()
      return
    }
    c.noise.once('connect', () => {
      if (c.done) return
      try {
        Hypercore.createProtocolStream(c.noise, { keepAlive: true })
        c.peer = attachAdmission(c.noise, { role: 'member', have: haveList(), onclose: finish, onmessage })
      } catch {
        finish()
      }
    })

    function onmessage (msg) {
      if (c.done) return
      if (msg.type === 'hello') {
        const verdict = msg.role === 'seeder' ? seederCertForKey(msg.cert, hex(c.noise.remotePublicKey), association) : null
        if (!verdict || verdict.ok !== true) return finish()
        c.ready = true
        backoff = BACKOFF_MIN_MS
        log({ event: 'pages-link', state: 'up' })
        for (const p of pages.values()) replicatePage(c, p)
        for (const e of msg.have) onRemote(e.key, e.length)
        for (const p of pages.values()) announce(p)
        return
      }
      if (!c.ready) return
      if (msg.type === 'have' || msg.type === 'admitted') onRemote(msg.key, msg.length)
    }
  }
}

module.exports = { createPagesWriter, parseSeederWs, MAX_PAGES, PUSH_TIMEOUT_MS, STORE_DIR }
