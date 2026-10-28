// The browser node's counterpart of @varanda/core lib/store.js: opening the
// own diary and the replicas on Hypercore 10 over a ./node-storage.js
// storage, reading every block, appending a record within the diary limits,
// and the config / follows records (kept as JSON in the storage's key-value
// area instead of config.json / follows.json).
//
// Core names: 'diary' for the own diary, 'replica/<hex>' for a followed one,
// 'media/<hex>' for one of this device's own media cores (@varanda/core
// lib/media.js: block 0 a JSON header naming the diary, then raw 32 KiB
// blocks; compat mode, LAZY 'data' file, created with the public key only
// and the secret set in memory exactly as the diary's). Follows are
// local-first: kv 'follows' changes at once, kv 'followsPending' holds the
// changes not yet appended as `follow` records, and writeFoldedFollows
// folds the own diary's records back into kv 'follows'.
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
const {
  decodeBlock,
  validateRecord,
  isHex64,
  isCanonicalIso,
  MAX_BLOCK_BYTES,
  MAX_LOG_BLOCKS,
  MAX_LOG_BYTES,
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_BYTES
} = require('@varanda/core/lib/records')
const { mediaHeader } = require('@varanda/core/lib/media')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { UsageError } = require('@varanda/core/lib/errors')
const { DIARY_OPTIONS } = require('./diary-options')

const DIARY = 'diary'
const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED = 'identidade bloqueada: entre com a passkey'
const MISMATCH = 'passkey não corresponde ao diário guardado'
const MEDIA_PREFIX = 'media/'
const MEDIA_FULL = 'espaço de fotos deste aparelho esgotado'
const MEDIA_INVALID = 'mídia inválida'
const MAX_MEDIA_CORE_ENTRIES = 8 // kv mediaCores keeps the newest 8

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

// One atomic append of 1..8 records (the profile compat pair): each is
// validated at its own seq, and either all are appended or none.
function appendRecords (core, records, limits) {
  const prev = appendQueues.get(core) || Promise.resolve()
  const run = () => appendManyNow(core, records, { ...DEFAULT_LIMITS, ...limits })
  const next = prev.then(run, run)
  appendQueues.set(core, next.catch(() => {}))
  return next
}

async function appendManyNow (core, records, limits) {
  await core.ready()
  if (core[UNLOCKED] !== true) throw new UsageError(LOCKED)
  if (!Array.isArray(records) || records.length < 1 || records.length > 8) throw invalidRecord('malformed')
  const plains = []
  let bytes = 0
  for (let i = 0; i < records.length; i++) {
    let plain = null
    try {
      plain = decodeBlock(b4a.from(JSON.stringify(records[i])))
    } catch {}
    if (plain === null) throw invalidRecord('malformed')
    const reason = validateRecord(plain, core.length + i)
    if (reason) throw invalidRecord(reason)
    const blockBytes = b4a.byteLength(JSON.stringify(plain))
    bytes += blockBytes
    if (blockBytes > limits.maxBlockBytes ||
        core.length + i >= limits.maxLogBlocks ||
        core.byteLength + bytes > limits.maxLogBytes) {
      throw new Error('limite do diário atingido')
    }
    plains.push(plain)
  }
  await core.append(plains)
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

// ---- media cores ----

function mediaName (hex) {
  return MEDIA_PREFIX + hex.toLowerCase()
}

const MEDIA_STORAGE = Object.freeze({ lazy: ['data'] })

// Opens (creating when missing) this device's media core for `keyPair`
// (derived per device by the session). The storage only ever receives the
// public key; with a secretKey the pair is set on the open core in memory
// and the core is UNLOCKED (writeMediaHeader, appendMediaBlocks), without
// one it is read-only. A stored core of another key is refused.
async function openMediaCore (storage, keyPair) {
  if (keyPair === null || typeof keyPair !== 'object' ||
      !(keyPair.publicKey instanceof Uint8Array) || keyPair.publicKey.byteLength !== 32) {
    throw new TypeError('par de chaves inválido')
  }
  const unlock = keyPair.secretKey !== undefined && keyPair.secretKey !== null
  if (unlock) checkKeyPair(keyPair)
  const name = mediaName(b4a.toString(keyPair.publicKey, 'hex'))
  const options = { ...DIARY_OPTIONS, valueEncoding: 'binary' }
  if (!(await storage.hasCore(name))) options.keyPair = { publicKey: keyPair.publicKey }
  const core = new Hypercore(storage.core(name, MEDIA_STORAGE), options)
  await core.ready()
  if (!b4a.equals(core.key, keyPair.publicKey)) {
    await core.close()
    throw new Error('núcleo de mídia de outra chave')
  }
  if (unlock) {
    core.setKeyPair({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey })
    core[UNLOCKED] = true
  }
  return core
}

// A stored own media core by key, read-only; null when none is stored (or
// the key is not hex64). Never creates anything.
async function openMediaCoreReadOnly (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) return null
  const name = mediaName(hex)
  if (!(await storage.hasCore(name))) return null
  const core = new Hypercore(storage.core(name, MEDIA_STORAGE), b4a.from(hex.toLowerCase(), 'hex'), { valueEncoding: 'binary' })
  await core.ready()
  return core
}

// Per-core queue of the media writes (the appendQueues pattern).
const mediaQueues = new WeakMap()

function queued (core, run) {
  const prev = mediaQueues.get(core) || Promise.resolve()
  const next = prev.then(run, run)
  mediaQueues.set(core, next.catch(() => {}))
  return next
}

// Block 0: the JSON header naming the own diary, only on an empty core.
function writeMediaHeader (core, diaryHex) {
  return queued(core, async () => {
    await core.ready()
    if (core[UNLOCKED] !== true) throw new UsageError(LOCKED)
    if (core.length !== 0) throw new Error('cabeçalho de mídia já gravado')
    await core.append(b4a.from(JSON.stringify(mediaHeader({ diary: diaryHex }))))
    return 0
  })
}

// Appends one item's blocks (each 1..MEDIA_BLOCK_BYTES bytes) in one atomic
// append after the header -> the seq of the first block. Over
// MAX_MEDIA_BLOCKS or MAX_MEDIA_BYTES the core is full (no rotation yet).
function appendMediaBlocks (core, blocks) {
  return queued(core, async () => {
    await core.ready()
    if (core[UNLOCKED] !== true) throw new UsageError(LOCKED)
    if (!Array.isArray(blocks) || blocks.length === 0) throw new UsageError(MEDIA_INVALID)
    let total = 0
    for (const block of blocks) {
      if (!(block instanceof Uint8Array) || block.byteLength < 1 || block.byteLength > MEDIA_BLOCK_BYTES) {
        throw new UsageError(MEDIA_INVALID)
      }
      total += block.byteLength
    }
    if (core.length < 1) throw new Error('cabeçalho de mídia ausente')
    if (core.length + blocks.length > MAX_MEDIA_BLOCKS || core.byteLength + total > MAX_MEDIA_BYTES) {
      throw new UsageError(MEDIA_FULL)
    }
    const first = core.length
    await core.append(blocks)
    return first
  })
}

// A kv JSON value; a torn or hand-edited value reads as absent (as
// readBlocklist), an IndexedDB failure throws.
async function readKv (storage, key) {
  try {
    return await storage.readJson(key)
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
}

function isVersioned (data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data) && data.v === 1
}

// kv mediaDevice = { v: 1, nonce: hex64 }: the random per-device nonce the
// media key pair is derived with.
async function readMediaDevice (storage) {
  const data = await readKv(storage, 'mediaDevice')
  return isVersioned(data) && isHex64(data.nonce) ? { v: 1, nonce: data.nonce } : null
}

function writeMediaDevice (storage, nonceHex) {
  if (typeof nonceHex !== 'string' || !HEX64.test(nonceHex)) throw new TypeError('nonce inválido')
  return storage.writeJson('mediaDevice', { v: 1, nonce: nonceHex.toLowerCase() })
}

// kv mediaCores = { v: 1, keys: [hex64...] }: this device's media cores,
// newest last.
async function readMediaCores (storage) {
  const data = await readKv(storage, 'mediaCores')
  if (!isVersioned(data) || !Array.isArray(data.keys)) return []
  return data.keys.filter((k) => isHex64(k))
}

async function addMediaCore (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new TypeError('chave inválida')
  const key = hex.toLowerCase()
  const keys = (await readMediaCores(storage)).filter((k) => k !== key)
  keys.push(key)
  const kept = keys.slice(-MAX_MEDIA_CORE_ENTRIES)
  await storage.writeJson('mediaCores', { v: 1, keys: kept })
  return kept
}

// Every listed media core and the media kv entries go (reset; the cores
// must be closed first).
async function deleteMediaCores (storage) {
  for (const key of await readMediaCores(storage)) await storage.deleteCore(mediaName(key))
  await storage.writeJson('mediaCores', null)
  await storage.writeJson('mediaDevice', null)
}

// ---- follows, local-first ----

// One chain per storage for every read-modify-write of kv follows and
// followsPending (the page's follow changes, the drain and the sync's fold
// interleave).
const followsLocks = new WeakMap()

function withFollowsLock (storage, fn) {
  const prev = followsLocks.get(storage) || Promise.resolve()
  const run = () => fn()
  const next = prev.then(run, run)
  followsLocks.set(storage, next.catch(() => {}))
  return next
}

function validOp (op) {
  return op !== null && typeof op === 'object' && isHex64(op.key) &&
    typeof op.on === 'boolean' && isCanonicalIso(op.at) &&
    (op.sig === undefined || typeof op.sig === 'string')
}

// The op's own fields only (sig kept when present: the identity key's
// signature over the op, ./member-ops.js signFollowOp; this module checks
// shapes, drainFollows verifies it and drops what does not verify).
function plainOp ({ key, on, at, sig }) {
  return sig === undefined ? { key, on, at } : { key, on, at, sig }
}

// kv followsPending = { v: 1, ops: [{ key, on, at, sig }] }: the follow
// changes not yet appended to the own diary as `follow` records, in order,
// at most one per key (member-ops followChange coalesces them). Read and
// written capped at MAX_INVENTORY - 1 ops (the newest kept): a queue
// inflated by hand never costs more than that per drain.
const MAX_PENDING_OPS = MAX_INVENTORY - 1

async function readFollowsPending (storage) {
  const data = await readKv(storage, 'followsPending')
  if (!isVersioned(data) || !Array.isArray(data.ops)) return []
  return data.ops.filter(validOp).map(plainOp).slice(-MAX_PENDING_OPS)
}

function writeFollowsPending (storage, ops) {
  const list = (Array.isArray(ops) ? ops : []).filter(validOp).map(plainOp).slice(-MAX_PENDING_OPS)
  return storage.writeJson('followsPending', { v: 1, ops: list })
}

// kv followsMigrated = { v: 1, at }: set on this device once its local
// follows (from before `follow` records existed) were appended to the own
// diary (member-ops drainFollows). Per device: another device migrating
// first does not migrate this one's.
async function readFollowsMigrated (storage) {
  const data = await readKv(storage, 'followsMigrated')
  return isVersioned(data) && isCanonicalIso(data.at)
}

function writeFollowsMigrated (storage) {
  return storage.writeJson('followsMigrated', { v: 1, at: new Date().toISOString() })
}

function clearFollowsMigrated (storage) {
  return storage.writeJson('followsMigrated', null)
}

// The follow set `derived` (by the caller) from the own diary's `follow`
// records, with the still-pending local ops on top (in order, the last one
// per key wins); the own key and invalid keys dropped, at most
// MAX_INVENTORY - 1 keys. kv follows is written only when it differs.
// While this device has not migrated (no followsMigrated) and kv follows is
// non-empty, nothing is written: local follows not yet in the diary are
// never overwritten ({ follows: kv follows, changed: false }); with neither
// kv follows nor pending ops, the fold sets followsMigrated first.
// Opens no core: ./sync.js calls it while it holds the own diary open.
function writeFoldedFollows (storage, derived, ownHex) {
  return withFollowsLock(storage, async () => {
    if (!(await readFollowsMigrated(storage))) {
      const local = await readFollows(storage)
      if (local.length > 0) return { follows: local, changed: false }
      // Nothing local at all (no follows, no pending op): nothing to
      // migrate, so this device counts as migrated from this fold on and
      // later folds keep applying the diary's changes.
      if ((await readFollowsPending(storage)).length === 0) await writeFollowsMigrated(storage)
    }
    const own = typeof ownHex === 'string' ? ownHex.toLowerCase() : null
    const set = new Set()
    for (const raw of Array.isArray(derived) ? derived : []) {
      if (typeof raw !== 'string' || !HEX64.test(raw)) continue
      const key = raw.toLowerCase()
      if (key !== own) set.add(key)
    }
    for (const op of await readFollowsPending(storage)) {
      if (op.key === own) continue
      if (op.on) set.add(op.key)
      else set.delete(op.key)
    }
    const follows = [...set].slice(0, MAX_INVENTORY - 1).sort()
    const current = [...new Set((await readFollows(storage)).map((k) => String(k).toLowerCase()))].sort()
    const changed = current.length !== follows.length || current.some((k, i) => k !== follows[i])
    if (changed) await writeFollows(storage, follows)
    return { follows, changed }
  })
}

module.exports = {
  DIARY,
  LOCKED,
  MISMATCH,
  MEDIA_PREFIX,
  MEDIA_FULL,
  MEDIA_INVALID,
  replicaName,
  mediaName,
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
  appendRecords,
  readConfig,
  writeConfig,
  readFollows,
  writeFollows,
  readBlocklist,
  writeBlocklist,
  openMediaCore,
  openMediaCoreReadOnly,
  writeMediaHeader,
  appendMediaBlocks,
  readMediaDevice,
  writeMediaDevice,
  readMediaCores,
  addMediaCore,
  deleteMediaCores,
  withFollowsLock,
  readFollowsPending,
  writeFollowsPending,
  readFollowsMigrated,
  writeFollowsMigrated,
  clearFollowsMigrated,
  writeFoldedFollows
}
