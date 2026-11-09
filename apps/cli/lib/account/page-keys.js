'use strict'

// The secret keys of every page the hosted service writes: ONE file,
// <dir>/page-keys.json (mode 0o600), always replaced whole through
// writeJsonAtomic and sealed with AES-256-GCM under VARANDA_PAGE_KEYS (64
// lowercase hex characters, 32 bytes). Unset (or empty), pages are off:
// enabled is false, get answers null and every write throws { code:
// 'desligado' }. A value of any other shape is a usage error whose message
// never contains the value. A file that does not open under the given key
// (another key, a tampered or truncated file, a link, not a regular file)
// fails closed: openPageKeys throws { code: 'indisponivel' } and nothing is
// rewritten.
//
// A row is { secretKey, mediaSecretKey, boxSecretKey?, groupBoxSecretKey?,
// writers?: { <writerHex>: secretKey } }, every value a Buffer. secretKey
// and each writer secret are 64-byte Ed25519 secrets (the public key is the
// last 32 bytes and must be the key the row is filed under); box keys are
// 32-byte X25519 secrets. The optional fields are simply absent from older
// rows. put replaces the whole row. boxSecretKey is legacy only: the gen 1
// Conversas box of a page from before its keys moved to devices, read while
// present and never created here or by anything that starts or restores a
// page (./pages-dm.js deletes it at the owner's first 'dm-box').
//
// pending(nonce) derives a page key pair and a media key pair for a
// creation (or a move's K2) in progress from the nonce alone: the seeds are
// HMAC-SHA256 under a pending secret (itself an HMAC of the file key with
// its own label) of a label and the nonce. Nothing is stored until the
// caller puts the row, so no shared table can be filled by anonymous starts,
// and the same nonce yields the same pair again, after a restart too (the
// route nonces are HMAC-bound to the member, the action and an expiry, so
// only a minted nonce reaches a page key).
//
// put() and wipe() replace the file atomically (writeJsonAtomic), so the
// previous ciphertext stays in the replaced inode until the filesystem
// reuses it, as with every writeJsonAtomic store; only wipe() overwrites
// that inode with zeros, because only wipe() removes a row.
//
// Single writer: every put() and wipe() asks guard() (the account service's
// lock, as the other sidecars do) before it changes anything and again right
// before the file is replaced, and fail() refuses every later write; a
// refused write throws { code: 'indisponivel' } and leaves the file and the
// table as they were.
//
// Nothing here exports the table, logs a key, or puts a secret in an error.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { refuseSymlinkDir, isPlainObject } = require('@varanda/core/lib/cert')
const { UsageError } = require('@varanda/core/lib/errors')
const { NONCE_RE } = require('@varanda/core/lib/account-link')

const FILE = 'page-keys.json'
const VERSION = 1
const ENV = 'VARANDA_PAGE_KEYS'
const KEY_RE = /^[0-9a-f]{64}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const AAD = b4a.from('varanda-page-keys-v1')
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_FILE_BYTES = 64 * 1024 * 1024
const PENDING_LABEL = 'varanda-page-pending-v1'
const PENDING_MEDIA_LABEL = 'varanda-page-pending-media-v1'
const PENDING_SECRET_LABEL = 'varanda-page-pending-secret-v1'
const ROW_KEYS = ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey', 'writers']

function noop () {}

// Writes `size` zeros at offset 0, looping over short writes, then fsync.
// -> false when any write or the fsync fails.
function zeroFill (fd, size) {
  const zeros = b4a.alloc(Math.min(size, 65536))
  let done = 0
  try {
    while (done < size) {
      const n = fs.writeSync(fd, zeros, 0, Math.min(zeros.byteLength, size - done), done)
      if (!Number.isInteger(n) || n <= 0) return false
      done += n
    }
    fs.fsyncSync(fd)
  } catch {
    return false
  }
  return true
}

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function parseKey (env) {
  const value = env[ENV]
  if (value === undefined || value === '') return null
  if (typeof value !== 'string' || !KEY_RE.test(value)) {
    throw new UsageError(ENV + ' inválida: use 64 caracteres hexadecimais minúsculos')
  }
  return b4a.from(value, 'hex')
}

function isBytes (v, n) {
  return v instanceof Uint8Array && v.byteLength === n
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// A 64-byte Ed25519 secret whose public half is `publicHex`.
function signingSecretOk (secret, publicHex) {
  return isBytes(secret, 64) && hex(secret.subarray(32)) === publicHex
}

// -> a row of fresh Buffers, or null when `row` is not one (key checks
// included).
function copyRow (pageKey, row) {
  if (!isPlainObject(row)) return null
  for (const k of Object.keys(row)) if (!ROW_KEYS.includes(k)) return null
  if (!signingSecretOk(row.secretKey, pageKey) || !isBytes(row.mediaSecretKey, 64)) return null
  if (hex(row.mediaSecretKey.subarray(32)) === pageKey) return null
  const out = { secretKey: b4a.from(row.secretKey), mediaSecretKey: b4a.from(row.mediaSecretKey) }
  for (const k of ['boxSecretKey', 'groupBoxSecretKey']) {
    if (row[k] === undefined) continue
    if (!isBytes(row[k], 32)) return null
    out[k] = b4a.from(row[k])
  }
  if (row.writers !== undefined) {
    if (!isPlainObject(row.writers)) return null
    const writers = {}
    for (const w of Object.keys(row.writers)) {
      if (!HEX64_RE.test(w) || !signingSecretOk(row.writers[w], w)) return null
      writers[w] = b4a.from(row.writers[w])
    }
    out.writers = writers
  }
  return out
}

function zeroRow (row) {
  if (!row) return
  for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) {
    if (row[k] instanceof Uint8Array) row[k].fill(0)
  }
  if (row.writers) {
    for (const w of Object.keys(row.writers)) {
      if (row.writers[w] instanceof Uint8Array) row.writers[w].fill(0)
    }
  }
}

function rowToJson (row) {
  const out = { secretKey: hex(row.secretKey), mediaSecretKey: hex(row.mediaSecretKey) }
  if (row.boxSecretKey) out.boxSecretKey = hex(row.boxSecretKey)
  if (row.groupBoxSecretKey) out.groupBoxSecretKey = hex(row.groupBoxSecretKey)
  if (row.writers) {
    out.writers = {}
    for (const w of Object.keys(row.writers)) out.writers[w] = hex(row.writers[w])
  }
  return out
}

function rowFromJson (pageKey, j) {
  if (!isPlainObject(j)) return null
  for (const k of Object.keys(j)) if (!ROW_KEYS.includes(k)) return null
  const bytes = (v, re) => typeof v === 'string' && re.test(v) ? b4a.from(v, 'hex') : null
  const row = { secretKey: bytes(j.secretKey, HEX128_RE), mediaSecretKey: bytes(j.mediaSecretKey, HEX128_RE) }
  if (j.boxSecretKey !== undefined) row.boxSecretKey = bytes(j.boxSecretKey, HEX64_RE)
  if (j.groupBoxSecretKey !== undefined) row.groupBoxSecretKey = bytes(j.groupBoxSecretKey, HEX64_RE)
  if (j.writers !== undefined) {
    if (!isPlainObject(j.writers)) return null
    row.writers = {}
    for (const w of Object.keys(j.writers)) row.writers[w] = bytes(j.writers[w], HEX128_RE)
  }
  const copy = copyRow(pageKey, row)
  zeroRow(row)
  return copy
}

// Reads the file without following a link and only when it is a regular
// file; null when it does not exist.
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
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) throw fail('indisponivel')
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function seal (key, plain) {
  const iv = nodeCrypto.randomBytes(IV_BYTES)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(AAD)
  const data = b4a.concat([cipher.update(plain), cipher.final()])
  return { v: VERSION, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function unseal (key, raw) {
  let outer
  try {
    outer = JSON.parse(b4a.toString(raw, 'utf8'))
  } catch {
    throw fail('indisponivel')
  }
  if (!isPlainObject(outer) || outer.v !== VERSION || typeof outer.iv !== 'string' ||
      typeof outer.tag !== 'string' || typeof outer.data !== 'string') throw fail('indisponivel')
  const iv = Buffer.from(outer.iv, 'base64')
  const tag = Buffer.from(outer.tag, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw fail('indisponivel')
  let plain
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    plain = b4a.concat([decipher.update(Buffer.from(outer.data, 'base64')), decipher.final()])
  } catch {
    throw fail('indisponivel')
  }
  let inner
  try {
    inner = JSON.parse(b4a.toString(plain, 'utf8'))
  } catch {
    throw fail('indisponivel')
  } finally {
    plain.fill(0)
  }
  if (!isPlainObject(inner) || inner.v !== VERSION || !isPlainObject(inner.rows)) throw fail('indisponivel')
  const rows = new Map()
  try {
    for (const pageKey of Object.keys(inner.rows)) {
      const row = HEX64_RE.test(pageKey) ? rowFromJson(pageKey, inner.rows[pageKey]) : null
      if (row === null) throw fail('indisponivel')
      rows.set(pageKey, row)
    }
  } catch {
    for (const r of rows.values()) zeroRow(r)
    throw fail('indisponivel')
  }
  return rows
}

function openPageKeys ({ dir, env = process.env, now = Date.now, log = noop, guard = () => true } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a path')
  if (typeof guard !== 'function') throw new TypeError('guard must be a function')
  const key = parseKey(env)
  if (key === null) {
    const off = () => { throw fail('desligado') }
    return Object.freeze({ enabled: false, get: () => null, put: off, pending: off, wipe: off, fail: noop })
  }
  refuseSymlinkDir(dir)
  const file = path.join(dir, FILE)
  const raw = readFileNoFollow(file)
  const rows = raw === null ? new Map() : unseal(key, raw)
  const pendingSecret = nodeCrypto.createHmac('sha256', key).update(PENDING_SECRET_LABEL).digest()
  let failed = false

  function check () {
    let ok = false
    try {
      ok = !failed && guard() === true
    } catch {}
    if (!ok) throw fail('indisponivel')
  }

  function persist () {
    refuseSymlinkDir(dir)
    const json = { v: VERSION, rows: {} }
    for (const [pageKey, row] of rows) json.rows[pageKey] = rowToJson(row)
    const plain = b4a.from(JSON.stringify(json))
    try {
      const sealed = seal(key, plain)
      check()
      writeJsonAtomic(file, sealed, 0o600)
    } finally {
      plain.fill(0)
    }
  }

  function get (pageKey) {
    if (typeof pageKey !== 'string' || !HEX64_RE.test(pageKey)) return null
    const row = rows.get(pageKey)
    return row === undefined ? null : copyRow(pageKey, row)
  }

  function put (pageKey, row) {
    if (typeof pageKey !== 'string' || !HEX64_RE.test(pageKey)) throw new TypeError('pageKey must be 64 lowercase hex characters')
    const copy = copyRow(pageKey, row)
    if (copy === null) throw new TypeError('invalid page key row')
    try {
      check()
    } catch (err) {
      zeroRow(copy)
      throw err
    }
    const prev = rows.get(pageKey)
    rows.set(pageKey, copy)
    try {
      persist()
    } catch (err) {
      if (prev === undefined) rows.delete(pageKey)
      else rows.set(pageKey, prev)
      zeroRow(copy)
      throw err
    }
    if (prev !== undefined) zeroRow(prev)
  }

  function seedOf (label, nonce) {
    return nodeCrypto.createHmac('sha256', pendingSecret).update(label + '\n' + nonce).digest()
  }

  // -> { key, row } (the row a copy the caller may put).
  function pending (nonce) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new TypeError('invalid nonce')
    check()
    const seed = seedOf(PENDING_LABEL, nonce)
    const mediaSeed = seedOf(PENDING_MEDIA_LABEL, nonce)
    const page = hcrypto.keyPair(seed)
    const media = hcrypto.keyPair(mediaSeed)
    seed.fill(0)
    mediaSeed.fill(0)
    try {
      if (b4a.equals(media.publicKey, page.publicKey)) throw fail('indisponivel')
      const pageKey = hex(page.publicKey)
      return { key: pageKey, row: copyRow(pageKey, { secretKey: page.secretKey, mediaSecretKey: media.secretKey }) }
    } finally {
      page.secretKey.fill(0)
      media.secretKey.fill(0)
    }
  }

  // Idempotent: the in-memory secrets are overwritten with zeros, the row
  // leaves the file (rewritten whole, fsync'ed) and get answers null. -> true
  // only when the replaced file was overwritten with zeros too; false when
  // there was no row or that overwrite failed (the row is gone either way).
  function wipe (pageKey) {
    if (typeof pageKey !== 'string' || !HEX64_RE.test(pageKey)) throw new TypeError('pageKey must be 64 lowercase hex characters')
    check()
    const row = rows.get(pageKey)
    if (row === undefined) return false
    // The replaced file still holds the row (sealed): its blocks are
    // overwritten with zeros once the new file is in place, through a
    // descriptor opened before the rename unlinks it.
    let old = null
    try {
      old = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    } catch {}
    let ok = false
    try {
      rows.delete(pageKey)
      try {
        persist()
      } catch (err) {
        rows.set(pageKey, row)
        throw err
      }
      zeroRow(row)
      if (old !== null) {
        try {
          const st = fs.fstatSync(old)
          ok = st.isFile() && (st.size === 0 || zeroFill(old, st.size))
        } catch {}
      }
    } finally {
      if (old !== null) fs.closeSync(old)
    }
    if (!ok) log({ event: 'page-keys-wipe', state: 'incompleto' })
    return ok
  }

  // The lock is gone: no later put or wipe reaches the file.
  function failKeys () {
    failed = true
  }

  return Object.freeze({ enabled: true, get, put, pending, wipe, fail: failKeys })
}

module.exports = { openPageKeys, FILE, ENV }
