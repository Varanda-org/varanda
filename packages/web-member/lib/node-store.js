// The browser node's counterpart of @varanda/core lib/store.js: opening the
// own diary and the replicas on Hypercore 10 over a ./node-storage.js
// storage, reading every block, appending a record within the diary limits,
// and the config / follows records (kept as JSON in the storage's key-value
// area instead of config.json / follows.json).
//
// Core names: 'diary' for the own diary, 'replica/<hex>' for a followed one.
// The own diary uses ./diary-options.js (compat mode: core.key is the signing
// public key, the key a member certificate names) and valueEncoding 'json'
// (stores exactly the JSON.stringify bytes, ./member.js); replicas are
// opened by key alone (no secret key, so never writable) and read raw.
//
// The own diary's secret key never reaches the storage: the core is created
// with { publicKey } only (hypercore 10.38.2 lib/core.js:100-108 then stores
// header.keyPair = { publicKey, secretKey: null }) and the session hands the
// key pair, derived from the passkey and held in memory, to setKeyPair()
// after ready() (index.js:267-270: the session's copy only, never flushed to
// the oplog header). A store whose header still holds a secret (created
// before this rule) is `legacy`: anyone reading the profile's IndexedDB
// would get a usable signing key, so the secret is wiped on sight, on the
// first open of any kind (scrubLegacySecret), and the diary stays readable
// under its old key; the passkey key never matches it ('passkey não
// corresponde ao diário guardado'), so the app offers to start over.
const Hypercore = require('hypercore')
const b4a = require('b4a')
const { decodeBlock, validateRecord, MAX_BLOCK_BYTES, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('@varanda/core/lib/records')
const { UsageError } = require('@varanda/core/lib/errors')
const { DIARY_OPTIONS } = require('./diary-options')

const DIARY = 'diary'
const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED = 'identidade bloqueada: entre com a passkey'
const MISMATCH = 'passkey não corresponde ao diário guardado'

// The flag an open core carries when the session key pair was set on it:
// appendNow trusts this and never `core.writable` (a legacy store is
// writable from its stored header).
const UNLOCKED = Symbol('varanda.unlocked')

function replicaName (hex) {
  return 'replica/' + hex.toLowerCase()
}

function checkKeyPair (keyPair) {
  if (keyPair === null || typeof keyPair !== 'object' ||
      !(keyPair.publicKey instanceof Uint8Array) || keyPair.publicKey.byteLength !== 32 ||
      !(keyPair.secretKey instanceof Uint8Array) || keyPair.secretKey.byteLength !== 64) {
    throw new TypeError('par de chaves inválido')
  }
}

function write (storage, offset, data) {
  return new Promise((resolve, reject) => {
    storage.write(offset, data, (err) => (err ? reject(err) : resolve()))
  })
}

function stat (storage) {
  return new Promise((resolve, reject) => {
    storage.stat((err, st) => (err ? reject(err) : resolve(st)))
  })
}

function read (storage, offset, size) {
  return new Promise((resolve, reject) => {
    storage.read(offset, size, (err, buf) => (err ? reject(err) : resolve(buf)))
  })
}

function nonZero (buf, start, end) {
  for (let i = start; i < end; i++) if (buf[i] !== 0) return true
  return false
}

// The two raw oplog header slots, decoded from the file itself (lib/oplog.js
// open() pattern, _decodeEntry with the header encoding; null = no valid
// header there), not only the active header Hypercore picked:
// -> { secret, dirty }: secret = EITHER slot still holds a secret key (a
// scrub cut short after its first flush, the alternate slot complete);
// dirty = the byte ranges past a decoded header up to the end of its slot
// that are not all zero (a scrub cut short before its tail writes: the end
// of the old, longer encoding), plus a whole undecodable slot with bytes in
// it when the OTHER slot holds a valid header (the only valid header is
// never touched). One stat and one read of at most 2 x pageSize per open.
async function inspectSlots (oplog) {
  const pageSize = oplog._pageSize
  const { size } = await stat(oplog.storage)
  const len = Math.min(size, 2 * pageSize)
  const out = { secret: false, dirty: [] }
  if (len < 8) return out
  const buffer = await read(oplog.storage, 0, len)
  try {
    const slots = [0, pageSize].map((start) => {
      const slotEnd = Math.min(start + pageSize, len)
      if (slotEnd - start < 8) return { start, slotEnd, entry: null, entryEnd: start }
      const state = { start, end: slotEnd, buffer }
      const entry = oplog._decodeEntry(state, oplog.headerEncoding)
      return { start, slotEnd, entry, entryEnd: entry ? state.start : start }
    })
    for (const [i, slot] of slots.entries()) {
      const other = slots[1 - i]
      const m = slot.entry && slot.entry.message
      if (m && m.keyPair && m.keyPair.secretKey) out.secret = true
      if (!slot.entry && !(other.entry)) continue // never destroy the only (or no) valid header
      if (nonZero(buffer, slot.entryEnd, slot.slotEnd)) out.dirty.push({ offset: slot.entryEnd, length: slot.slotEnd - slot.entryEnd })
    }
    return out
  } finally {
    buffer.fill(0) // the decoded secret, if any, is a view into it
  }
}

// A legacy header (hypercore 10.38.2 lib/core.js:100-108 stored the pair it
// generated) is wiped in place: the secret buffer is zero-filled and nulled
// on the header object itself (the session's core.keyPair is that same
// object, index.js:409, and lib/core.js:134 already copied it out of the
// read slab, so no other reference keeps the bytes), the header is flushed
// TWICE (lib/core.js flush() takes the mutex and rewrites the oplog header;
// lib/oplog.js flush() alternates its two 4 KiB slots, so both now hold the
// secret-free header), and the tail of each slot past the new, shorter
// encoding is zero-filled (oplog flush() writes only the encoded bytes).
// The decision reads the raw slots (inspectSlots), so the scrub is
// idempotent and resumable: an open that failed half-way leaves the next
// open to finish it, the tail cleanup included. An external (BigHeader) header is not expected for a
// diary and is not handled. -> true when a secret was found and wiped.
async function scrubLegacySecret (core) {
  const inner = core.core
  const header = inner.header
  const oplog = inner.oplog
  const inMemory = !!(header.keyPair && header.keyPair.secretKey)
  const slots = inMemory ? null : await inspectSlots(oplog)
  if (!inMemory && !slots.secret) {
    // No secret anywhere: only stale bytes past the headers may remain
    // (the tail writes of an earlier scrub failed); clear them, quietly.
    for (const d of slots.dirty) await write(oplog.storage, d.offset, b4a.alloc(d.length))
    return false
  }
  if (inMemory) {
    header.keyPair.secretKey.fill(0)
    header.keyPair.secretKey = null
    core.setKeyPair(header.keyPair) // same object: `writable` drops with it
  }
  await inner.flush()
  await inner.flush()
  const state = { start: 8, end: 8, buffer: null }
  oplog.headerEncoding.preencode(state, header)
  const size = oplog._pageSize
  if (state.end < size) {
    const zeros = b4a.alloc(size - state.end)
    await write(oplog.storage, state.end, zeros)
    await write(oplog.storage, size + state.end, zeros)
  }
  return true
}

// `legacy`: an open of this storage (in this process) found and wiped a
// stored secret; remembered per storage object until the diary is reset
// (forgetLegacy), so the session reports it whichever operation opened the
// diary first. After a reload the header is secret-free and the diary is
// simply one of a key the passkey does not derive (a mismatch).
const legacySeen = new WeakSet()

function isLegacy (storage) {
  return legacySeen.has(storage)
}

function forgetLegacy (storage) {
  legacySeen.delete(storage)
}

// Opens the own diary. With a key pair: creates it when missing (public key
// only in the storage) and sets the pair on the open core, in memory, so it
// can append; a stored diary of another key, or a legacy store, is refused
// ('passkey não corresponde ao diário guardado'). Without one: opens an
// existing diary read-only (reads and sync need no secret), or throws
// 'identidade não encontrada' when there is none.
async function openDiary (storage, keyPair = null) {
  if (keyPair !== null) checkKeyPair(keyPair)
  const exists = await storage.hasCore(DIARY)
  if (!exists && keyPair === null) throw new Error('identidade não encontrada')
  const options = { ...DIARY_OPTIONS, valueEncoding: 'json' }
  if (!exists) options.keyPair = { publicKey: keyPair.publicKey }
  const core = new Hypercore(storage.core(DIARY), options)
  await core.ready()
  try {
    if (await scrubLegacySecret(core)) legacySeen.add(storage)
  } catch (err) {
    await core.close().catch(() => {})
    throw err
  }
  if (keyPair !== null) {
    if (isLegacy(storage) || !b4a.equals(core.key, keyPair.publicKey)) {
      await core.close()
      throw new UsageError(MISMATCH)
    }
    core.setKeyPair({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey })
    core[UNLOCKED] = true
  }
  return core
}

function diaryExists (storage) {
  return storage.hasCore(DIARY)
}

// -> { exists, publicKey (hex | null), legacy }, without a key pair and
// without creating anything.
async function diaryStatus (storage) {
  if (!(await storage.hasCore(DIARY))) {
    forgetLegacy(storage)
    return { exists: false, publicKey: null, legacy: false }
  }
  const core = await openDiary(storage)
  try {
    return { exists: true, publicKey: b4a.toString(core.key, 'hex'), legacy: isLegacy(storage) }
  } finally {
    await core.close()
  }
}

// Replicas are read-only: opened by key, so the storage never holds a secret.
async function openReplica (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new Error('chave inválida')
  const core = new Hypercore(storage.core(replicaName(hex)), b4a.from(hex.toLowerCase(), 'hex'), { valueEncoding: 'binary' })
  await core.ready()
  if (core.writable) {
    await core.close()
    throw new Error('chave do próprio diário')
  }
  return core
}

function replicaExists (storage, hex) {
  return storage.hasCore(replicaName(hex))
}

// Every file of the replica goes (the core must already be closed).
function purgeReplica (storage, hex) {
  return storage.deleteCore(replicaName(hex))
}

// As @varanda/core readAll: a decode failure is { seq, record: null }; a
// closed core is an error, never an empty log.
async function readAll (core) {
  if (core.closing) {
    const err = new Error('SESSION_CLOSED: cannot read from a closed session')
    err.code = 'SESSION_CLOSED'
    throw err
  }
  const entries = []
  for (let i = 0; i < core.contiguousLength; i++) {
    const block = await core.get(i, { wait: false, raw: true })
    entries.push({ seq: i, record: decodeBlock(block) })
  }
  return entries
}

// Block 0 as the Hypercore 11 side decodes it, or null.
async function readBlock0 (core) {
  if (core.contiguousLength < 1) return null
  return decodeBlock(await core.get(0, { wait: false, raw: true }))
}

function invalidRecord (reason) {
  const err = new Error('registro inválido: ' + reason)
  err.code = 'INVALID_RECORD'
  return err
}

const DEFAULT_LIMITS = Object.freeze({
  maxBlockBytes: MAX_BLOCK_BYTES,
  maxLogBlocks: MAX_LOG_BLOCKS,
  maxLogBytes: MAX_LOG_BYTES
})

// Per-core append queue: validation and append of one call complete before
// the next call computes its seq.
const appendQueues = new WeakMap()

function appendRecord (core, record, limits) {
  const prev = appendQueues.get(core) || Promise.resolve()
  const run = () => appendNow(core, record, { ...DEFAULT_LIMITS, ...limits })
  const next = prev.then(run, run)
  appendQueues.set(core, next.catch(() => {}))
  return next
}

// The storage limits of the own diary (protocol S3), exactly as
// @varanda/core appendNow: a seeder rejects and purges a diary over them.
// Only a core unlocked by openDiary(storage, keyPair) may append.
async function appendNow (core, record, limits) {
  await core.ready()
  if (core[UNLOCKED] !== true) throw new UsageError(LOCKED)
  let plain = null
  try {
    plain = decodeBlock(b4a.from(JSON.stringify(record)))
  } catch {}
  if (plain === null) throw invalidRecord('malformed')
  const reason = validateRecord(plain, core.length)
  if (reason) throw invalidRecord(reason)
  const blockBytes = b4a.byteLength(JSON.stringify(plain))
  if (blockBytes > limits.maxBlockBytes ||
      core.length >= limits.maxLogBlocks ||
      core.byteLength + blockBytes > limits.maxLogBytes) {
    throw new Error('limite do diário atingido')
  }
  await core.append(plain)
  return core.length - 1
}

function readConfig (storage) {
  return storage.readJson('config')
}

function writeConfig (storage, config) {
  return storage.writeJson('config', config)
}

async function readFollows (storage) {
  const data = await storage.readJson('follows')
  return data && Array.isArray(data.follows) ? data.follows : []
}

function writeFollows (storage, list) {
  const follows = [...new Set(list.map((k) => k.toLowerCase()))].sort()
  return storage.writeJson('follows', { v: 1, follows })
}

// The signed moderation snapshot, in the kv beside follows. Association
// state, not identity: reset() deletes only the diary core, so it stays.
async function readBlocklist (storage) {
  let data
  try {
    data = await storage.readJson('blocklist')
  } catch (err) {
    // A torn or hand-edited value reads as absent (as packages/core/lib/store.js
    // readBlocklist does); an IndexedDB failure still throws.
    if (err instanceof SyntaxError) return null
    throw err
  }
  const ok = data && typeof data === 'object' && !Array.isArray(data) && data.v === 1 &&
    data.snapshot && typeof data.snapshot === 'object' && !Array.isArray(data.snapshot)
  return ok ? data : null
}

function writeBlocklist (storage, snapshot) {
  return storage.writeJson('blocklist', { v: 1, snapshot })
}

module.exports = {
  DIARY,
  LOCKED,
  MISMATCH,
  replicaName,
  openDiary,
  diaryExists,
  diaryStatus,
  forgetLegacy,
  openReplica,
  replicaExists,
  purgeReplica,
  readAll,
  readBlock0,
  appendRecord,
  readConfig,
  writeConfig,
  readFollows,
  writeFollows,
  readBlocklist,
  writeBlocklist
}
