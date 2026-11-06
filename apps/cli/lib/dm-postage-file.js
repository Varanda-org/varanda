'use strict'

// The seeder's postage keys for direct message stamps (docs/protocol.md
// section 11), in <dataDir>/dm-postage.json (mode 0o600):
//   { v: 2, keys: [{ kid, n, e, d, createdAt }] }
// RSA-2048, e = 65537, n, e and d as decimal strings, kid the first 8 bytes
// of BLAKE2b-256 over n's decimal digits (dm-postage.js kidOf), newest key
// first and at most two: the current one, which issues stamps, and the
// previous one, still accepted on drops. A key older than ROTATE_MS is
// replaced by a new one, and a key older than MAX_AGE_MS is forgotten.
//
// Invariant (with dm-pool.js): MAX_AGE_MS <= the pool's spent token
// retention (14 days), so a stamp is never accepted after the pool could
// have forgotten that its token was spent.
//
// The file is created only when get() is first called, never at startup. A
// file this module would not have written (any other version or shape)
// fails closed with Error('dm-postage
// inválido') and is never overwritten: the operator repairs or removes it.
//
// The blob stamp keys (media chunks) live apart in <dataDir>/blob-postage.json
// with the same shape, rotation, maximum age and invariant (blob-pool.js keeps
// spent tokens for 14 days too); its errors say 'blob-postage inválido'. A key
// shared by both files is refused by the seeder, never here.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { kidOf, parsePublicKey } = require('@varanda/core/lib/dm-postage')

const FILE = 'dm-postage.json'
const BLOB_FILE = 'blob-postage.json'
const DAY_MS = 86400000
const ROTATE_MS = 7 * DAY_MS
const MAX_AGE_MS = 14 * DAY_MS
const MAX_KEYS = 2
const DECIMAL = /^[1-9][0-9]*$/

function invalid (file = FILE) {
  return new Error((file === BLOB_FILE ? 'blob-postage' : 'dm-postage') + ' inválido')
}

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
}

function exactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

// { kid, n, e, d, createdAt } or throws.
function checkKey (k, name) {
  if (!isPlainObject(k) || !exactKeys(k, ['kid', 'n', 'e', 'd', 'createdAt'])) throw invalid(name)
  if (parsePublicKey({ v: 1, kid: k.kid, n: k.n, e: k.e }) === null) throw invalid(name)
  if (typeof k.d !== 'string' || !DECIMAL.test(k.d) || BigInt(k.d) >= BigInt(k.n)) throw invalid(name)
  if (!Number.isSafeInteger(k.createdAt) || k.createdAt < 0) throw invalid(name)
  return { kid: k.kid, n: k.n, e: k.e, d: k.d, createdAt: k.createdAt }
}

function readKeys (file, name) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    throw invalid(name)
  }
  if (!isPlainObject(doc) || doc.v !== 2 || !exactKeys(doc, ['v', 'keys']) || !Array.isArray(doc.keys)) throw invalid(name)
  if (doc.keys.length < 1 || doc.keys.length > MAX_KEYS) throw invalid(name)
  const keys = doc.keys.map((k) => checkKey(k, name))
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].createdAt > keys[i - 1].createdAt || keys[i].kid === keys[i - 1].kid) throw invalid(name)
  }
  return keys
}

function generateKey (now) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: kidOf(n), n: n.toString(10), e: fromBase64url(jwk.e).toString(10), d: fromBase64url(jwk.d).toString(10), createdAt: now }
}

// The keys after rotation at `now`, and whether they changed.
function rotate (keys, now) {
  let next = keys.slice()
  if (next.length === 0 || now - next[0].createdAt >= ROTATE_MS) next.unshift(generateKey(now))
  next = next.filter((k, i) => i === 0 || now - k.createdAt < MAX_AGE_MS).slice(0, MAX_KEYS)
  const changed = next.length !== keys.length || next.some((k, i) => k !== keys[i])
  return { keys: next, changed }
}

// { kid, n, e, d, keys }: the current key's fields at the top, every usable
// key (newest first) in keys. Generates and rotates as the header says.
// name is FILE or BLOB_FILE.
function loadOrCreate (dataDir, { now = Date.now, name = FILE } = {}) {
  return load(dataDir, now, name).got
}

// loadOrCreate, and whether it wrote the file.
function load (dataDir, now, name) {
  if (name !== FILE && name !== BLOB_FILE) throw new TypeError('invalid postage file name')
  const t = Math.max(0, Math.floor(now()))
  const file = path.join(dataDir, name)
  const { keys, changed } = rotate(readKeys(file, name), t)
  if (changed) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(file, { v: 2, keys }, 0o600)
  }
  const current = keys[0]
  return { got: { kid: current.kid, n: current.n, e: current.e, d: current.d, keys: keys.map((k) => ({ ...k })) }, wrote: changed }
}

// What identifies the file on disk without reading it: a replaced, rewritten
// or removed file gives another string.
function fileStamp (file) {
  let st
  try {
    st = fs.statSync(file, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing'
    throw err
  }
  return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':')
}

// The public part of a key: never d.
function publicPart (key) {
  return { v: 1, kid: key.kid, n: key.n, e: key.e }
}

// The seeder's dm.postage: get() reads the file on the first call, again
// once a key is due to rotate or to be forgotten, and again whenever the file
// on disk changed (an operator replaced or removed it); otherwise it answers
// the same object. name is FILE (the default) or BLOB_FILE.
function createPostageFile (dataDir, { now = Date.now, name = FILE } = {}) {
  if (name !== FILE && name !== BLOB_FILE) throw new TypeError('invalid postage file name')
  const file = path.join(dataDir, name)
  let cached = null
  let dueAt = 0
  let stamp = null
  return {
    async get () {
      const t = now()
      const before = fileStamp(file)
      if (cached !== null && t < dueAt && before === stamp) return cached
      const { got, wrote } = load(dataDir, () => t, name)
      const due = [got.keys[0].createdAt + ROTATE_MS, ...got.keys.slice(1).map((k) => k.createdAt + MAX_AGE_MS)]
      cached = got
      dueAt = Math.min(...due)
      // Only our own write moves the stamp past `before`: a change made by
      // someone else while the file was read keeps the old stamp, so the next
      // get() reads it again.
      stamp = wrote ? fileStamp(file) : before
      return cached
    }
  }
}

// The seeder's dm.blobPostage.
function createBlobPostageFile (dataDir, { now = Date.now } = {}) {
  return createPostageFile(dataDir, { now, name: BLOB_FILE })
}

module.exports = {
  FILE,
  BLOB_FILE,
  ROTATE_MS,
  MAX_AGE_MS,
  MAX_KEYS,
  loadOrCreate,
  publicPart,
  createPostageFile,
  createBlobPostageFile
}
