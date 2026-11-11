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
// 'group/<hex>' is a group core (@varanda/core lib/group.js), own or foreign,
// JSON blocks, LAZY 'data': this device's own roots and writers are created
// with the public key only and unlocked in memory exactly as media cores
// (kv 'groupWriters' names them with their derivation nonce); foreign roots
// and writers are opened by key and listed in kv 'groupReplicas'.
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
const { validateGroupRecord, validateGroupHeader, validateWriterHeader, MAX_GROUPS_PER_DIARY, MAX_GROUP_WRITERS } = require('@varanda/core/lib/group')
const { presentState, clearRanges } = require('@varanda/core/lib/deletion')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { SEEN_BLOB_BYTES, SEEN_BLOB_B64 } = require('@varanda/core/lib/seen-blob')
const { normalizeBlocks } = require('@varanda/core/lib/member-block')
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
const GROUP_PREFIX = 'group/'
const GROUP_FULL = 'limite do grupo atingido'
const GROUPS_FULL = 'limite de grupos atingido'
const MAX_GROUP_REPLICAS = MAX_GROUPS_PER_DIARY * MAX_GROUP_WRITERS

// The flag an open core carries when the session key pair was set on it:
// appendNow trusts this and never `core.writable` (a legacy store is
// writable from its stored header).
const UNLOCKED = Symbol('varanda.unlocked')

// Every read scans each diary, replica and group core in full, so without
// Hypercore's block cache each read fetches every block from IndexedDB or
// flash again. Records are small (MAX_BLOCK_BYTES, a log capped by
// MAX_LOG_BYTES), so the default bound (2 x 65536 blocks per core) keeps a
// realistic core whole; media cores (32 KiB blocks, read once) stay uncached.
const BLOCK_CACHE = true
const EVICTS = Symbol('varanda.evictsOnClear')

// Hypercore 10's clear never evicts the block cache, so a cleared (deleted)
// block would still be served from memory, also by get({ wait: false }).
// The wrap sits on the per-files state (core.core), not on one handle: every
// session of the core, including those openShared hands out and any made
// later with core.session(), clears through it and is in its session list
// (Core.sessions, the array every session of these files shares).
// Evicting before and after the clear also drops an entry that a read
// started while the clear waited on the oplog put back.
// Evictions alone are not enough: a get pending on a block not held yet is
// answered by a storage read (an append or upgrade resolving it locally, or
// a peer's block) that can settle after the clear, and Hypercore then caches
// it (_cacheOnResolve). So the cache refuses any set for a block the
// bitfield does not hold at that moment; it is installed on the root right
// after ready, before any session exists, and sessions inherit it.
function evictOnClear (core) {
  const state = core.core
  if (state === null || state === undefined || state[EVICTS] === true) return core
  const clear = state.clear
  const sessions = state.sessions || core.sessions
  state.clear = async function (start, end, cleared) {
    evictRange(sessions, start, end)
    try {
      return await clear.call(this, start, end, cleared)
    } finally {
      evictRange(sessions, start, end)
    }
  }
  if (core.cache) core.cache = heldOnlyCache(core.cache, state)
  state[EVICTS] = true
  return core
}

function heldOnlyCache (inner, state) {
  return {
    get size () { return inner.size },
    keys () { return inner.keys() },
    // Also gated on the bitfield: between Core.clear dropping the bit and
    // the eviction that follows it, an entry cached a moment before the
    // clear must already read as absent.
    has (index) { return state.bitfield.get(index) && inner.has(index) },
    get (index) { return state.bitfield.get(index) ? inner.get(index) : undefined },
    set (index, value) {
      if (!state.bitfield.get(index)) return this
      inner.set(index, value)
      // Hypercore caches the read's promise before it settles: a transient
      // storage failure must not stay cached and fail every later read.
      if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
        value.then(null, () => { if (inner.get(index) === value) inner.delete(index) })
      }
      return this
    },
    delete (index) { return inner.delete(index) },
    clear () { inner.clear() }
  }
}

function evictRange (sessions, start, end) {
  for (const s of sessions) {
    const cache = s.cache
    if (!cache) continue
    if (end - start <= cache.size) {
      for (let i = start; i < end; i++) cache.delete(i)
    } else {
      for (const i of [...cache.keys()]) if (i >= start && i < end) cache.delete(i)
    }
  }
}

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

// One Hypercore per stored core per storage. Hypercore 10 keeps the oplog
// offset, tree and bitfield per instance, and a clear or flush writes that
// instance's view: a second instance on the same files (one opened before
// an append) overwrites the other's oplog entries and header and drops the
// blocks appended through it. So every open of a core that is already open
// is a session of it (one oplog, tree and bitfield), and a core is only
// opened again once its last session closed its files. A session never
// inherits a secret key from another one: openDiary and openMediaCore set
// the pair on their own session.
const sharedCores = new WeakMap() // storage -> Map(name -> slot)

async function openShared (storage, name, valueEncoding, create) {
  let byName = sharedCores.get(storage)
  if (byName === undefined) sharedCores.set(storage, (byName = new Map()))
  let slot = byName.get(name)
  if (slot === undefined) byName.set(name, (slot = { lock: Promise.resolve(), sessions: null, closed: null }))
  const prev = slot.lock
  let release
  slot.lock = new Promise((resolve) => { release = resolve })
  try {
    await prev
    const live = slot.sessions === null ? undefined : slot.sessions.find((s) => !s.closing)
    if (live !== undefined) {
      const s = live.session({ valueEncoding })
      watchShared(slot, s)
      await s.ready()
      s.setKeyPair({ publicKey: s.key })
      return { core: s, fresh: false }
    }
    if (slot.closed !== null) await slot.closed
    const core = await create()
    let done
    slot.sessions = core.sessions
    slot.closed = new Promise((resolve) => { done = resolve })
    slot.done = done
    watchShared(slot, core)
    return { core, fresh: true }
  } finally {
    release()
  }
}

// The last session of a core emits 'close' with true once its files closed.
function watchShared (slot, core) {
  const done = slot.done
  core.on('close', (last) => {
    if (last && slot.done === done && typeof done === 'function') done()
  })
}

// The queues below are per shared core: every session of one core shares
// them (core.core is Hypercore 10's per-files state, set once ready).
function queueKey (core) {
  return core.core || core
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
  const options = { ...DIARY_OPTIONS, valueEncoding: 'json', cache: BLOCK_CACHE }
  if (!exists) options.keyPair = { publicKey: keyPair.publicKey }
  // The legacy scrub writes the oplog file directly: only on a first open,
  // never beside a live core.
  const { core } = await openShared(storage, DIARY, 'json', async () => {
    const core = new Hypercore(storage.core(DIARY), options)
    await core.ready()
    evictOnClear(core)
    try {
      if (await scrubLegacySecret(core)) legacySeen.add(storage)
    } catch (err) {
      await core.close().catch(() => {})
      throw err
    }
    return core
  })
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
  const core = new Hypercore(storage.core(replicaName(hex)), b4a.from(hex.toLowerCase(), 'hex'), { valueEncoding: 'binary', cache: BLOCK_CACHE })
  await core.ready()
  evictOnClear(core)
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
// closed core is an error, never an empty log. A block an effective
// tombstone deleted is { seq, record: null, deleted: true }
// (@varanda/core lib/deletion.js), held or cleared, at its own index. The
// result ends at the present length: contiguousLength is never the end,
// Hypercore 10 does not keep its lowered value across a reopen after a
// clear.
async function readAll (core) {
  assertOpen(core)
  const { entries, present } = await presentState(core)
  return entries.slice(0, present)
}

// What a followed diary can show while it downloads newest-first (./sync.js
// trackPresent): the readAll prefix plus the unbroken run of blocks that
// ends at core.length, a hole in that run passed only when the effective
// deletion fold of the stored blocks deletes it. -> { entries, present, tail }
// with entries = the prefix, then the stored blocks of [tail, core.length)
// (a hole the run passed is absent, so log.read skips it);
// tail === core.length when there is no such run (or none is needed). The
// run needs block 0 (moderation reads it) and is never read past
// MAX_LOG_BLOCKS. A tombstone comes after its target, so every tombstone
// that can delete a block of the run lies inside the run: stored, and
// applied to the whole result by the same fold. raw: the same blocks as
// entries, tombstones not applied, for the page cut of buildFeed (a
// tombstone naming a page-close or page-moved never moves it).
async function readVisible (core) {
  assertOpen(core)
  const length = core.length
  // presentState folds holes and blocks that do not decode into the same
  // { record: null }; the view records which blocks this snapshot read.
  const stored = new Set()
  const view = {
    get length () { return length },
    has: (i) => core.has(i),
    get: async (i, opts) => {
      const block = await core.get(i, opts)
      if (block !== null) stored.add(i)
      return block
    }
  }
  const { raw, entries, deleted, present } = await presentState(view)
  const prefix = entries.slice(0, present)
  const rawPrefix = raw.slice(0, present)
  if (present < 1 || present >= length || length > MAX_LOG_BLOCKS || raw.length < length) {
    return { entries: prefix, raw: rawPrefix, present, tail: length }
  }
  let tail = length
  while (tail > present) {
    const seq = tail - 1
    // Judged on the snapshot alone: a block that arrived after presentState
    // (a tombstone, say) is not in `raw`, so asking the live core would bridge
    // a gap with a deletion this read never applied. A stored block that does
    // not decode stops the run too, which only shows less.
    // A hole is passed only when the effective fold deletes it: a tombstone
    // that a later one cancelled names a block that may itself be a live
    // tombstone of a post below, which this read would then show.
    if (raw[seq].record === null && !deleted.has(seq)) break
    tail = seq
  }
  // Only a block that arrived after presentState can close the gap: the
  // next read shows it.
  if (tail <= present) return { entries: prefix, raw: rawPrefix, present, tail: length }
  for (let seq = tail; seq < length; seq++) {
    if (stored.has(seq)) {
      prefix.push(entries[seq])
      rawPrefix.push(raw[seq])
    }
  }
  return { entries: prefix, raw: rawPrefix, present, tail }
}

// Every block as decoded up to the same end, tombstones not applied (the
// delete writers check the targeted block itself); a cleared block is
// { seq, record: null }.
async function readRaw (core) {
  assertOpen(core)
  const { raw, present } = await presentState(core)
  return raw.slice(0, present)
}

// EVERY stored block as decoded, in seq order, holes skipped (not only the
// present prefix: a followed diary downloads newest-first, so its tail can
// be stored past a gap), tombstones not applied. length: the core's, so the
// caller can tell whether every block of [0, length) was read.
async function readHeld (core) {
  assertOpen(core)
  const length = core.length
  const limit = Math.min(length, MAX_LOG_BLOCKS)
  const entries = []
  for (let i = 0; i < limit; i++) {
    if (!(await core.has(i))) continue
    const block = await core.get(i, { wait: false, raw: true })
    if (block === null) continue
    entries.push({ seq: i, record: decodeBlock(block) })
  }
  return { entries, length }
}

// As @varanda/core readBlocks: a group core's blocks, decoded, tombstones
// not applied (deletion is a diary feature, groups hide with their own
// records), up to the first block not held locally.
async function readBlocks (core) {
  assertOpen(core)
  const limit = Math.min(core.length, MAX_LOG_BLOCKS)
  const out = []
  for (let i = 0; i < limit; i++) {
    if (!(await core.has(i))) break
    const block = await core.get(i, { wait: false, raw: true })
    if (block === null) break
    out.push({ seq: i, record: decodeBlock(block) })
  }
  return out
}

function assertOpen (core) {
  if (core.closing) {
    const err = new Error('SESSION_CLOSED: cannot read from a closed session')
    err.code = 'SESSION_CLOSED'
    throw err
  }
}

// Block 0 as the Hypercore 11 side decodes it, or null.
async function readBlock0 (core) {
  if (core.length < 1 || !(await core.has(0))) return null
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
  return enqueueAppend(core, record, validateRecord, limits, 'limite do diário atingido')
}

// The same queue and limits for a group core: block 0 is its header, the
// root (`root: true`) alone may hold root-only records, and a community core
// (`community: true`: its root or a community writer) only its own set.
function appendGroupRecord (core, record, { root = false, community = false, private: priv = false, limits } = {}) {
  const validate = (plain, seq) => validateGroupRecord(plain, seq, { root: root === true, community: community === true, private: priv === true })
  return enqueueAppend(core, record, validate, limits, GROUP_FULL)
}

function enqueueAppend (core, record, validate, limits, full) {
  const prev = appendQueues.get(queueKey(core)) || Promise.resolve()
  const run = () => appendNow(core, record, validate, { ...DEFAULT_LIMITS, ...limits }, full)
  const next = prev.then(run, run)
  appendQueues.set(queueKey(core), next.catch(() => {}))
  return next
}

// The storage limits of the own diary (protocol S3), exactly as
// @varanda/core appendNow: a seeder rejects and purges a diary over them.
// Only a core unlocked by openDiary(storage, keyPair) (or openGroupWriter)
// may append.
async function appendNow (core, record, validate, limits, full) {
  await core.ready()
  if (core[UNLOCKED] !== true) throw new UsageError(LOCKED)
  let plain = null
  try {
    plain = decodeBlock(b4a.from(JSON.stringify(record)))
  } catch {}
  if (plain === null) throw invalidRecord('malformed')
  const reason = validate(plain, core.length)
  if (reason) throw invalidRecord(reason)
  const blockBytes = b4a.byteLength(JSON.stringify(plain))
  if (blockBytes > limits.maxBlockBytes ||
      core.length >= limits.maxLogBlocks ||
      core.byteLength + blockBytes > limits.maxLogBytes) {
    throw new Error(full)
  }
  await core.append(plain)
  return core.length - 1
}

// One atomic append of 1..8 records (the profile compat pair): each is
// validated at its own seq, and either all are appended or none.
function appendRecords (core, records, limits) {
  const prev = appendQueues.get(queueKey(core)) || Promise.resolve()
  const run = () => appendManyNow(core, records, { ...DEFAULT_LIMITS, ...limits })
  const next = prev.then(run, run)
  appendQueues.set(queueKey(core), next.catch(() => {}))
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

// kv memberBlocks = { v: 1, entries }: the member's own block list
// (@varanda/core lib/member-block.js). Identity state: reset() deletes it.
async function readMemberBlocks (storage) {
  const data = await readKv(storage, 'memberBlocks')
  return data && typeof data === 'object' && data.v === 1 ? normalizeBlocks(data.entries) : []
}

function writeMemberBlocks (storage, entries) {
  return storage.writeJson('memberBlocks', entries.length === 0 ? null : { v: 1, entries })
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
  const { core } = await openShared(storage, name, 'binary', async () => {
    const core = new Hypercore(storage.core(name, MEDIA_STORAGE), options)
    await core.ready()
    return core
  })
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
  const { core } = await openShared(storage, name, 'binary', async () => {
    const core = new Hypercore(storage.core(name, MEDIA_STORAGE), b4a.from(hex.toLowerCase(), 'hex'), { valueEncoding: 'binary' })
    await core.ready()
    return core
  })
  return core
}

// Per-core queue of the media writes (the appendQueues pattern).
const mediaQueues = new WeakMap()

function queued (core, run) {
  const prev = mediaQueues.get(queueKey(core)) || Promise.resolve()
  const next = prev.then(run, run)
  mediaQueues.set(queueKey(core), next.catch(() => {}))
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

// Clears a deleted item's blocks ({ start, blocks } ranges) of a media core,
// never block 0 (the header naming the diary). Every session of the core
// (openShared), unlocked or read-only, clears through the core's one write
// queue, so a clear never interleaves with an append. No signing key is
// needed to clear.
function clearMediaRanges (core, ranges) {
  const safe = (Array.isArray(ranges) ? ranges : []).filter((r) =>
    r !== null && typeof r === 'object' && Number.isSafeInteger(r.start) && r.start >= 1)
  return queued(core, async () => {
    await core.ready()
    await clearRanges(core, safe)
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

// kv groupBoxDevice = { v: 1, nonce: hex64 }: the random per-device nonce
// the group box key pair is derived with (passkey.js). Nothing secret: the
// pair itself only lives in memory while unlocked (./group-keys.js).
async function readGroupBoxDevice (storage) {
  const data = await readKv(storage, 'groupBoxDevice')
  return isVersioned(data) && isHex64(data.nonce) ? { v: 1, nonce: data.nonce.toLowerCase() } : null
}

function writeGroupBoxDevice (storage, nonceHex) {
  if (typeof nonceHex !== 'string' || !HEX64.test(nonceHex)) throw new TypeError('nonce inválido')
  return storage.writeJson('groupBoxDevice', { v: 1, nonce: nonceHex.toLowerCase() })
}

// The stored nonce, else `fresh` (hex64) written once. Queued per storage:
// two unlocks racing on an empty kv must not derive from two nonces, and a
// nonce once written is never replaced (every epoch key this device holds
// is sealed to the pair it derives).
const groupBoxLocks = new WeakMap()

function withGroupBoxLock (storage, fn) {
  const prev = groupBoxLocks.get(storage) || Promise.resolve()
  const p = prev.then(fn)
  groupBoxLocks.set(storage, p.catch(() => {}))
  return p
}

function ensureGroupBoxDevice (storage, fresh) {
  if (typeof fresh !== 'string' || !HEX64.test(fresh)) return Promise.reject(new TypeError('nonce inválido'))
  return withGroupBoxLock(storage, async () => {
    const have = await readGroupBoxDevice(storage)
    if (have !== null) return have.nonce
    await writeGroupBoxDevice(storage, fresh)
    return fresh.toLowerCase()
  })
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

// ---- group cores ----

function groupName (hex) {
  return GROUP_PREFIX + hex.toLowerCase()
}

const GROUP_STORAGE = Object.freeze({ lazy: ['data'] })

// kv groupCores = { v: 1, keys }: every group core key this storage may
// hold, written BEFORE the core is created (write-ahead) and dropped after
// its purge, so a reset finds every group core, also one no other list
// names (a re-gate core left by a closed tab, a key sliced off a full
// list): the next person on the device must not inherit any of them. The
// storage cannot list its cores, hence the list.
const groupCoreLocks = new WeakMap()

function withGroupCoreLock (storage, fn) {
  const prev = groupCoreLocks.get(storage) || Promise.resolve()
  const p = prev.then(fn)
  groupCoreLocks.set(storage, p.catch(() => {}))
  return p
}

async function readGroupCoreKeys (storage) {
  const data = await readKv(storage, 'groupCores')
  if (!isVersioned(data) || !Array.isArray(data.keys)) return []
  return [...new Set(data.keys.filter((k) => isHex64(k)).map((k) => k.toLowerCase()))]
}

function registerGroupCore (storage, hex) {
  const key = hex.toLowerCase()
  return withGroupCoreLock(storage, async () => {
    const keys = await readGroupCoreKeys(storage)
    if (keys.includes(key)) return
    keys.push(key)
    await storage.writeJson('groupCores', { v: 1, keys })
  })
}

function unregisterGroupCore (storage, hex) {
  const key = String(hex).toLowerCase()
  return withGroupCoreLock(storage, async () => {
    const keys = await readGroupCoreKeys(storage)
    if (!keys.includes(key)) return
    await storage.writeJson('groupCores', { v: 1, keys: keys.filter((k) => k !== key) })
  })
}

// Opens (creating when missing) one of this device's group cores (a root or
// a writer) for `keyPair`, derived by the session from the passkey and the
// core's nonce: the openMediaCore pattern, so the storage only ever receives
// the public key and the secret lives on the open core, in memory.
async function openGroupWriter (storage, keyPair) {
  if (keyPair === null || typeof keyPair !== 'object' ||
      !(keyPair.publicKey instanceof Uint8Array) || keyPair.publicKey.byteLength !== 32) {
    throw new TypeError('par de chaves inválido')
  }
  const unlock = keyPair.secretKey !== undefined && keyPair.secretKey !== null
  if (unlock) checkKeyPair(keyPair)
  const name = groupName(b4a.toString(keyPair.publicKey, 'hex'))
  const options = { ...DIARY_OPTIONS, valueEncoding: 'json', cache: BLOCK_CACHE }
  if (!(await storage.hasCore(name))) {
    options.keyPair = { publicKey: keyPair.publicKey }
    await registerGroupCore(storage, b4a.toString(keyPair.publicKey, 'hex'))
  }
  const core = new Hypercore(storage.core(name, GROUP_STORAGE), options)
  await core.ready()
  evictOnClear(core)
  if (!b4a.equals(core.key, keyPair.publicKey)) {
    await core.close()
    throw new Error('núcleo de grupo de outra chave')
  }
  if (unlock) {
    core.setKeyPair({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey })
    core[UNLOCKED] = true
  }
  return core
}

// A group core by key, read-only (a foreign root or writer, or an own core
// read without its secret); created empty when missing, for replication.
async function openGroupReplica (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new Error('chave inválida')
  if (!(await groupCoreExists(storage, hex))) await registerGroupCore(storage, hex)
  const core = new Hypercore(storage.core(groupName(hex), GROUP_STORAGE), b4a.from(hex.toLowerCase(), 'hex'), { valueEncoding: 'binary', cache: BLOCK_CACHE })
  await core.ready()
  evictOnClear(core)
  return core
}

function groupCoreExists (storage, hex) {
  return storage.hasCore(groupName(hex))
}

// A stored group core, read-only; null when none is stored. Never creates.
async function openGroupCoreReadOnly (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) return null
  if (!(await groupCoreExists(storage, hex))) return null
  return openGroupReplica(storage, hex)
}

async function purgeGroupCore (storage, hex) {
  await storage.deleteCore(groupName(hex))
  await unregisterGroupCore(storage, hex)
  await removeBoundRoot(storage, hex)
}

// kv boundRoots = { v: 1, keys: [rootHex...] }: the group roots whose gate
// proved the creator's own signed join of the root here, newest last, at
// most MAX_GROUP_REPLICAS. A restart before the join block was stored
// still knows the root goes with a blocked or revoked creator. Removed with
// the core. An unreadable entry reads as not bound.
async function readBoundRoots (storage) {
  const data = await readKv(storage, 'boundRoots')
  if (!isVersioned(data) || !Array.isArray(data.keys)) return []
  return [...new Set(data.keys.filter((k) => isHex64(k)).map((k) => k.toLowerCase()))]
}

function addBoundRoot (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new TypeError('chave inválida')
  const key = hex.toLowerCase()
  return withGroupCoreLock(storage, async () => {
    const keys = await readBoundRoots(storage)
    if (keys.includes(key)) return
    keys.push(key)
    await storage.writeJson('boundRoots', { v: 1, keys: keys.slice(-MAX_GROUP_REPLICAS) })
  })
}

function removeBoundRoot (storage, hex) {
  const key = String(hex).toLowerCase()
  return withGroupCoreLock(storage, async () => {
    const keys = await readBoundRoots(storage)
    if (!keys.includes(key)) return
    await storage.writeJson('boundRoots', { v: 1, keys: keys.filter((k) => k !== key) })
  })
}

function validWriterEntry (e) {
  return e !== null && typeof e === 'object' && isHex64(e.group) && isHex64(e.key) && isHex64(e.nonce) &&
    (e.rootNonce === undefined || e.rootNonce === null || isHex64(e.rootNonce)) &&
    (e.kind === undefined || e.kind === 'group' || e.kind === 'community')
}

// The root's nonce of a group this device created: kept apart from the
// current writer's, because a creator who leaves and rejoins writes through a
// new writer but still needs the root for the root-only records. An entry
// from before the field existed whose writer is the root names it already.
function rootNonceOf (e) {
  if (typeof e.rootNonce === 'string') return e.rootNonce.toLowerCase()
  return e.key.toLowerCase() === e.group.toLowerCase() ? e.nonce.toLowerCase() : null
}

function kindOf (e) {
  return e.kind === 'community' ? { kind: 'community' } : {}
}

// kv groupWriters = { v: 1, entries: [{ group, key, nonce, rootNonce }] }: per
// group the core this device writes (key === group for a group it created
// and has not left), the nonce its key pair is derived with, and the root's
// nonce when this device created the group (else null); one entry per
// group, at most MAX_GROUPS_PER_DIARY, oldest first. A community root this
// device created takes a slot too, with `kind: 'community'` (an entry
// without a kind is a group).
async function readGroupWriters (storage) {
  const data = await readKv(storage, 'groupWriters')
  if (!isVersioned(data) || !Array.isArray(data.entries)) return []
  const seen = new Set()
  const out = []
  for (const e of data.entries) {
    if (!validWriterEntry(e)) continue
    const group = e.group.toLowerCase()
    if (seen.has(group)) continue
    seen.add(group)
    out.push({ group, key: e.key.toLowerCase(), nonce: e.nonce.toLowerCase(), rootNonce: rootNonceOf(e), ...kindOf(e) })
  }
  return out.slice(0, MAX_GROUPS_PER_DIARY)
}

// Sets the entry of entry.group (replacing that group's previous one, which
// moves to the end, and never dropping its root nonce); a new group beyond
// the cap is refused.
async function putGroupWriter (storage, entry) {
  if (!validWriterEntry(entry)) throw new TypeError('entrada de grupo inválida')
  const current = await readGroupWriters(storage)
  const group = entry.group.toLowerCase()
  const prev = current.find((e) => e.group === group)
  let rootNonce = rootNonceOf(entry)
  if (rootNonce === null && prev !== undefined) rootNonce = prev.rootNonce
  const plain = { group, key: entry.key.toLowerCase(), nonce: entry.nonce.toLowerCase(), rootNonce, ...kindOf(prev !== undefined && prev.kind ? prev : entry) }
  const entries = current.filter((e) => e.group !== group)
  if (entries.length >= MAX_GROUPS_PER_DIARY) throw new UsageError(GROUPS_FULL)
  entries.push(plain)
  await storage.writeJson('groupWriters', { v: 1, entries })
  return entries
}

async function removeGroupWriter (storage, group) {
  const entries = (await readGroupWriters(storage)).filter((e) => e.group !== String(group).toLowerCase())
  await storage.writeJson('groupWriters', { v: 1, entries })
  return entries
}

// kv groupReplicas = { v: 1, keys: [hex64...] }: the foreign group cores
// (roots and writers) and this device's former writers, oldest first, at
// most MAX_GROUP_REPLICAS (the newest kept).
async function readGroupReplicas (storage) {
  const data = await readKv(storage, 'groupReplicas')
  if (!isVersioned(data) || !Array.isArray(data.keys)) return []
  return [...new Set(data.keys.filter((k) => isHex64(k)).map((k) => k.toLowerCase()))].slice(-MAX_GROUP_REPLICAS)
}

async function addGroupReplica (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new TypeError('chave inválida')
  const key = hex.toLowerCase()
  const keys = await readGroupReplicas(storage)
  if (keys.includes(key)) return keys
  keys.push(key)
  const kept = keys.slice(-MAX_GROUP_REPLICAS)
  await storage.writeJson('groupReplicas', { v: 1, keys: kept })
  return kept
}

async function removeGroupReplica (storage, hex) {
  const key = String(hex).toLowerCase()
  const keys = (await readGroupReplicas(storage)).filter((k) => k !== key)
  await storage.writeJson('groupReplicas', { v: 1, keys })
  return keys
}

// kv communityCreate = { v: 1, community, communityNonce, group, groupNonce,
// name, join, at }: a community.create planned here and not finished (its two
// own cores and nonces, the Geral group), so a repeated call resumes it with
// the same keys. null when none.
async function readCommunityCreate (storage) {
  const d = await readKv(storage, 'communityCreate')
  if (!isVersioned(d) || ![d.community, d.communityNonce, d.group, d.groupNonce].every(isHex64) ||
      typeof d.name !== 'string' || (d.join !== 'open' && d.join !== 'approval') || !isCanonicalIso(d.at)) return null
  return {
    v: 1,
    community: d.community.toLowerCase(),
    communityNonce: d.communityNonce.toLowerCase(),
    group: d.group.toLowerCase(),
    groupNonce: d.groupNonce.toLowerCase(),
    name: d.name,
    join: d.join,
    at: d.at
  }
}

function writeCommunityCreate (storage, record) {
  return storage.writeJson('communityCreate', record === null ? null : { ...record, v: 1 })
}

// kv communityLeave = { v: 1, notes: [{ community, writer, seq, hash }] }: per
// community, the group-leave this device appended as its creator (the CW,
// the block's seq and the hex blake2b of its bytes) until the diary confirms
// it. Only a leave matching its note is confirmed later.
async function readLeaveNotes (storage) {
  const d = await readKv(storage, 'communityLeave')
  // v 1 notes named a block hash, not the leave's digest: never finished.
  if (d === null || typeof d !== 'object' || d.v !== 2 || !Array.isArray(d.notes)) return []
  const root = (r) => r !== null && typeof r === 'object' && isHex64(r.group) && Number.isSafeInteger(r.cut) && r.cut >= 1
  return d.notes.filter((n) => n !== null && typeof n === 'object' && [n.community, n.writer, n.digest].every(isHex64) &&
    Number.isSafeInteger(n.seq) && n.seq >= 1 && Array.isArray(n.roots) && n.roots.every(root))
    .map((n) => ({
      community: n.community.toLowerCase(),
      writer: n.writer.toLowerCase(),
      seq: n.seq,
      digest: n.digest.toLowerCase(),
      roots: n.roots.map((r) => ({ group: r.group.toLowerCase(), cut: r.cut }))
    }))
}

// { community, writer, seq, digest, roots: [{ group, cut }] }: the C leave
// this creator device appends at `seq` on its CW (its leaveDigest), and the
// length of each group root of C it held at leave time.
function writeLeaveNotes (storage, notes) {
  return storage.writeJson('communityLeave', notes.length === 0 ? null : { v: 2, notes })
}

// Protocol v1 group cores (a group-header or group-writer block 0 with
// v: 1) among those kv groupWriters, groupReplicas and groupCores name:
// each is purged and dropped from the lists, a created entry included, since
// no seeder or fold of protocol v2 takes it -> [{ event: 'group-skipped',
// key, reason: 'legacy' }], one per purged core.
async function purgeLegacyGroupCores (storage) {
  const writers = await readGroupWriters(storage)
  const keys = new Set([...await readGroupReplicas(storage), ...await readGroupCoreKeys(storage)])
  for (const e of writers) {
    keys.add(e.key)
    if (e.rootNonce !== null) keys.add(e.group)
  }
  const legacy = new Set()
  for (const key of [...keys].sort()) {
    const core = await openGroupCoreReadOnly(storage, key)
    if (core === null) continue
    let h = null
    try {
      if (core.contiguousLength > 0) h = decodeBlock(await core.get(0, { wait: false, raw: true }))
    } catch {
    } finally {
      await core.close()
    }
    if (h === null || typeof h !== 'object') continue
    const reason = h.type === 'group-header' ? validateGroupHeader(h) : h.type === 'group-writer' ? validateWriterHeader(h) : null
    if (reason === 'legacy') legacy.add(key)
  }
  if (legacy.size === 0) return []
  for (const e of writers) {
    if (!legacy.has(e.key) && !legacy.has(e.group)) continue
    await removeGroupWriter(storage, e.group)
    // The own writer of a legacy group goes with it.
    legacy.add(e.key)
  }
  const events = []
  for (const key of [...legacy].sort()) {
    await purgeGroupCore(storage, key)
    await removeGroupReplica(storage, key)
    events.push({ event: 'group-skipped', key, reason: 'legacy' })
  }
  return events
}

// The binding diaries of accepted foreign group writers, stored as replicas
// (replicaName) for the join evidence and the names of their authors and
// never listed in kv follows: kv 'groupDiaries' { v: 1, keys }, at most
// MAX_GROUP_REPLICAS (the newest kept).
async function readGroupDiaries (storage) {
  const data = await readKv(storage, 'groupDiaries')
  if (!isVersioned(data) || !Array.isArray(data.keys)) return []
  return [...new Set(data.keys.filter((k) => isHex64(k)).map((k) => k.toLowerCase()))].slice(-MAX_GROUP_REPLICAS)
}

async function addGroupDiary (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new TypeError('chave inválida')
  const key = hex.toLowerCase()
  const keys = await readGroupDiaries(storage)
  if (keys.includes(key)) return keys
  keys.push(key)
  const kept = keys.slice(-MAX_GROUP_REPLICAS)
  await storage.writeJson('groupDiaries', { v: 1, keys: kept })
  return kept
}

async function removeGroupDiary (storage, hex) {
  const key = String(hex).toLowerCase()
  const keys = (await readGroupDiaries(storage)).filter((k) => k !== key)
  await storage.writeJson('groupDiaries', { v: 1, keys })
  return keys
}

// kv groupCerts = { v: 1, entries: [[diaryHex, block0Hex]...] }: the block 0
// (the certificate) of each binding diary whose group core this device
// accepted, newest last, at most MAX_GROUP_REPLICAS. A restart re-judges the
// binding against a newer revocation even when the diary itself is not
// stored, so a revoked member's cores cannot outlive the revocation.
async function readGroupCerts (storage) {
  const data = await readKv(storage, 'groupCerts')
  const out = new Map()
  if (!isVersioned(data) || !Array.isArray(data.entries)) return out
  for (const e of data.entries) {
    if (!Array.isArray(e) || !isHex64(e[0]) || typeof e[1] !== 'string' || !/^([0-9a-f]{2})+$/.test(e[1])) continue
    out.set(e[0].toLowerCase(), b4a.from(e[1], 'hex'))
  }
  return out
}

function putGroupCert (storage, diaryHex, raw0) {
  if (typeof diaryHex !== 'string' || !HEX64.test(diaryHex) || !(raw0 instanceof Uint8Array)) throw new TypeError('certificado inválido')
  const key = diaryHex.toLowerCase()
  return withGroupCoreLock(storage, async () => {
    const map = await readGroupCerts(storage)
    map.delete(key)
    map.set(key, raw0)
    const entries = [...map].slice(-MAX_GROUP_REPLICAS).map(([d, r]) => [d, b4a.toString(r, 'hex')])
    await storage.writeJson('groupCerts', { v: 1, entries })
  })
}

// Every group core and binding replica this device holds, and the three
// group kv lists (reset; the cores must be closed first): the next person on
// a shared device must neither read nor push the previous person's groups.
// A binding diary that kv follows still lists keeps its replica (the
// follows survive a reset).
async function deleteGroupData (storage) {
  const cores = new Set()
  for (const e of await readGroupWriters(storage)) {
    cores.add(e.key)
    if (e.rootNonce !== null) cores.add(e.group)
  }
  for (const key of await readGroupReplicas(storage)) cores.add(key)
  for (const key of await readGroupCoreKeys(storage)) cores.add(key)
  for (const key of cores) await storage.deleteCore(groupName(key))
  const followed = new Set((await readFollows(storage)).map((k) => String(k).toLowerCase()))
  for (const d of await readGroupDiaries(storage)) {
    if (!followed.has(d) && await replicaExists(storage, d)) await purgeReplica(storage, d)
  }
  await storage.writeJson('groupWriters', null)
  await storage.writeJson('groupReplicas', null)
  await storage.writeJson('groupSeen', null)
  await storage.writeJson('communityCreate', null)
  await storage.writeJson('communityLeave', null)
  // A new identity on this storage derives a new box key pair: the old
  // nonce would only tie it to the cores just deleted.
  await withGroupBoxLock(storage, () => storage.writeJson('groupBoxDevice', null))
  await storage.writeJson('groupDiaries', null)
  await withGroupCoreLock(storage, () => storage.writeJson('groupCores', null))
  await withGroupCoreLock(storage, () => storage.writeJson('groupCerts', null))
  await withGroupCoreLock(storage, () => storage.writeJson('boundRoots', null))
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

// ---- direct messages (docs/protocol.md section 11) ----

// 'dm-local': this identity's message store, local only (./dm-store.js). It
// is never replicated, never named in an inventory, a hello or a kv list: the
// sync opens cores from kv lists only, so this name never reaches it. Compat
// mode with a key pair derived from the local store key, created with the
// public key only; the pair is set in memory, as the diary's.
const DM_LOCAL = 'dm-local'
// A Página's conversations held on this device (./page-dm.js): the same
// stores and kv entries as the own ones, every name under this prefix.
const PAGE_DM_PREFIX = 'pages/'

function pageDmPrefix (page) {
  if (typeof page !== 'string' || !/^[0-9a-f]{64}$/.test(page)) throw new TypeError('página inválida')
  return PAGE_DM_PREFIX + page + '/'
}

// prefix: '' for the own store, pageDmPrefix(page) for a page's.
async function openDmLocal (storage, keyPair, prefix = '') {
  checkKeyPair(keyPair)
  const name = prefix + DM_LOCAL
  const options = { ...DIARY_OPTIONS, valueEncoding: 'json' }
  if (!(await storage.hasCore(name))) options.keyPair = { publicKey: keyPair.publicKey }
  const { core } = await openShared(storage, name, 'json', async () => {
    const core = new Hypercore(storage.core(name), options)
    await core.ready()
    return core
  })
  if (!b4a.equals(core.key, keyPair.publicKey)) {
    await core.close()
    return null
  }
  core.setKeyPair({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey })
  return core
}

function deleteDmLocal (storage, prefix = '') {
  return storage.deleteCore(prefix + DM_LOCAL)
}

const SEEN_TOKEN_RE = /^[0-9a-f]{32}$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const HEX16_RE = /^[0-9a-f]{16}$/
const MAX_DM_SEEN = 5000
const MAX_DM_STAMPS = 64

// kv dmKey = { v: 1, gen }: the box key generation in use. No key in kv.
async function readDmKey (storage) {
  const data = await readKv(storage, 'dmKey')
  return isVersioned(data) && Number.isSafeInteger(data.gen) && data.gen >= 1 && data.gen <= 0xffffffff ? { v: 1, gen: data.gen } : null
}

function writeDmKey (storage, gen) {
  if (!Number.isSafeInteger(gen) || gen < 1 || gen > 0xffffffff) throw new TypeError('gen inválido')
  return storage.writeJson('dmKey', { v: 1, gen })
}

// kv dmCursor = { v: 1, after }: the exclusive pool seq cursor.
async function readDmCursor (storage) {
  const data = await readKv(storage, 'dmCursor')
  return isVersioned(data) && Number.isSafeInteger(data.after) && data.after >= 0 ? data.after : 0
}

function writeDmCursor (storage, after) {
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('cursor inválido')
  return storage.writeJson('dmCursor', { v: 1, after })
}

// kv <page prefix>dmCursor = { v: 1, after, gen, set }: a page's own pool
// cursor, the secrets gen and the box set (a hex32 digest of the held
// public boxes, ./dm.js) it was scanned with; absent, the oldest retained
// drop.
async function readPageCursor (storage, prefix) {
  const data = await readKv(storage, prefix + 'dmCursor')
  if (!isVersioned(data) || !Number.isSafeInteger(data.after) || data.after < 0) return { after: 0, gen: 0, set: '' }
  return {
    after: data.after,
    gen: Number.isSafeInteger(data.gen) && data.gen >= 0 ? data.gen : 0,
    set: typeof data.set === 'string' && SEEN_TOKEN_RE.test(data.set) ? data.set : ''
  }
}

function writePageCursor (storage, prefix, { after, gen, set }) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(gen) || gen < 0) throw new TypeError('cursor inválido')
  if (typeof set !== 'string' || !SEEN_TOKEN_RE.test(set)) throw new TypeError('cursor inválido')
  return storage.writeJson(prefix + 'dmCursor', { v: 1, after, gen, set })
}

// kv dmSeen = { v: 1, ids: [hex32] }: for each message marked seen here, a
// token keyed by the local store key over its seen key (@varanda/core
// lib/dm-fold.js seenKey, which names the sender), so kv holds no peer key;
// newest last, at most MAX_DM_SEEN. A bare id of an earlier form matches no
// token and is dropped in effect (its dot may show once more).
async function readDmSeen (storage, prefix = '') {
  const data = await readKv(storage, prefix + 'dmSeen')
  if (!isVersioned(data) || !Array.isArray(data.ids)) return []
  return data.ids.filter((id) => typeof id === 'string' && SEEN_TOKEN_RE.test(id))
}

function writeDmSeen (storage, ids, prefix = '') {
  const list = [...new Set(ids.filter((id) => typeof id === 'string' && SEEN_TOKEN_RE.test(id)))]
  return storage.writeJson(prefix + 'dmSeen', { v: 1, ids: list.slice(-MAX_DM_SEEN) })
}

// kv groupSeen = { v: 1, marks: [{ group, at, writer, seq }] }: per group the
// newest post marked seen on this device (rpc.md 5.82), newest last, at most
// MAX_GROUP_SEEN (the least recently marked dropped first). Plain, like kv
// groupWriters: it holds only group and writer keys, a time and a seq.
const MAX_GROUP_SEEN = 512

function validSeenMark (m) {
  return m !== null && typeof m === 'object' && isHex64(m.group) && isHex64(m.writer) &&
    isCanonicalIso(m.at) && Number.isSafeInteger(m.seq) && m.seq >= 1
}

// One mark per group, the last one written kept (at its own place). Walked
// from the end so a hand-edited kv value of any length costs one pass.
function seenMarks (marks) {
  const out = []
  const taken = new Set()
  for (let i = marks.length - 1; i >= 0 && out.length < MAX_GROUP_SEEN; i--) {
    const m = marks[i]
    if (!validSeenMark(m) || taken.has(m.group)) continue
    taken.add(m.group)
    out.push({ group: m.group, at: m.at, writer: m.writer, seq: m.seq })
  }
  return out.reverse()
}

async function readGroupSeen (storage) {
  const data = await readKv(storage, 'groupSeen')
  if (!isVersioned(data) || !Array.isArray(data.marks)) return []
  return seenMarks(data.marks)
}

function writeGroupSeen (storage, marks) {
  return storage.writeJson('groupSeen', { v: 1, marks: seenMarks(marks) })
}

// kv seenLocal = { v: 1, own: hex64, blob }: the node's full view of what the
// account service's seen blob should hold (the canonical document of the
// last merge or write plus Avisos tokens added here since), sealed under the
// seen key (@varanda/core lib/seen-blob.js seal). Always exactly
// SEEN_BLOB_BYTES, so kv shows a constant length and a reader without the
// passkey learns nothing. kv dmSeen and groupSeen stay this device's source
// of truth; this copy only feeds the sync. Bound to the own key: a value left
// by another identity reads as absent.
function isSeenBlob (b64) {
  return typeof b64 === 'string' && b64.length === SEEN_BLOB_B64 && BASE64_RE.test(b64) &&
    b4a.byteLength(b64, 'base64') === SEEN_BLOB_BYTES
}

function sameOwn (data, own) {
  return isHex64(own) && data.own === own
}

async function readSeenLocal (storage, own) {
  const data = await readKv(storage, 'seenLocal')
  if (!isVersioned(data) || !sameOwn(data, own) || !isSeenBlob(data.blob)) return null
  return data.blob
}

function writeSeenLocal (storage, own, b64) {
  if (!isHex64(own)) throw new TypeError('chave inválida')
  if (!isSeenBlob(b64)) throw new TypeError('visto inválido')
  return storage.writeJson('seenLocal', { v: 1, own, blob: b64 })
}

// kv seenRemote = { v: 1, own: hex64, blob }: the sealed blob exactly as the
// service holds it at the seenSync cursor (its hash is the cursor), so an
// unchanged read can still tell which local marks the service lacks. Bound
// to the own key like seenLocal.
async function readSeenRemote (storage, own) {
  const data = await readKv(storage, 'seenRemote')
  if (!isVersioned(data) || !sameOwn(data, own) || !isSeenBlob(data.blob)) return null
  return data.blob
}

function writeSeenRemote (storage, own, b64) {
  if (!isHex64(own)) throw new TypeError('chave inválida')
  if (!isSeenBlob(b64)) throw new TypeError('visto inválido')
  return storage.writeJson('seenRemote', { v: 1, own, blob: b64 })
}

// kv seenSync = { v: 1, own: hex64, hash: hex64 | null, gen }: the hash of the
// remote blob last merged (the prevHash of the next compare-and-swap write,
// null before any) and the local generation.
function validSeenSync (hash, gen) {
  return (hash === null || isHex64(hash)) && Number.isSafeInteger(gen) && gen >= 0
}

async function readSeenSync (storage, own) {
  const data = await readKv(storage, 'seenSync')
  if (!isVersioned(data) || !sameOwn(data, own) || !validSeenSync(data.hash, data.gen)) return { hash: null, gen: 0 }
  return { hash: data.hash, gen: data.gen }
}

function writeSeenSync (storage, own, { hash = null, gen = 0 } = {}) {
  if (!isHex64(own)) throw new TypeError('chave inválida')
  if (!validSeenSync(hash, gen)) throw new TypeError('sincronização inválida')
  return storage.writeJson('seenSync', { v: 1, own, hash, gen })
}

// A secretbox under the local dm key (./dm-store.js seal): { nonce, box }.
// Stamps and queued drops are bearer values (anyone holding one can spend
// it), so kv holds them only sealed; plaintext entries of the earlier v1
// form are dropped on read (a top-up refills the wallet).
const NONCE48_RE = /^[0-9a-f]{48}$/
const MAX_SEALED_B64 = 16384

function validBox (b) {
  return b !== null && typeof b === 'object' && typeof b.nonce === 'string' && NONCE48_RE.test(b.nonce) &&
    typeof b.box === 'string' && b.box.length <= MAX_SEALED_B64 && BASE64_RE.test(b.box)
}

function isV2 (data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data) && data.v === 2 && Array.isArray(data.items)
}

function validKids (kids) {
  return Array.isArray(kids) ? kids.filter((k) => typeof k === 'string' && HEX16_RE.test(k)).slice(0, 2) : []
}

// kv dmStamps = { v: 2, items: [{ kid, nonce, box }], kids }: the unspent
// wallet, each stamp's { token, sig } sealed, and the last two postage kids
// seen (newest first). The kid alone spends nothing.
async function readDmStamps (storage) {
  const data = await readKv(storage, 'dmStamps')
  if (!isV2(data)) return { items: [], kids: [] }
  return {
    items: data.items.filter((s) => validBox(s) && typeof s.kid === 'string' && HEX16_RE.test(s.kid)).map((s) => ({ kid: s.kid, nonce: s.nonce, box: s.box })),
    kids: validKids(data.kids)
  }
}

function writeDmStamps (storage, { items, kids }) {
  return storage.writeJson('dmStamps', {
    v: 2,
    items: items.filter((s) => validBox(s) && typeof s.kid === 'string' && HEX16_RE.test(s.kid)).slice(0, MAX_DM_STAMPS).map((s) => ({ kid: s.kid, nonce: s.nonce, box: s.box })),
    kids: validKids(kids)
  })
}

// kv blobStamps: the blob stamp wallet (./blob.js), the same shape and
// rules as kv dmStamps under its own key, holding at most MAX_BLOB_STAMPS
// (a little over BLOB_STAMP_WALLET).
const MAX_BLOB_STAMPS = 320

async function readBlobStamps (storage) {
  const data = await readKv(storage, 'blobStamps')
  if (!isV2(data)) return { items: [], kids: [] }
  return {
    items: data.items.filter((s) => validBox(s) && typeof s.kid === 'string' && HEX16_RE.test(s.kid)).slice(0, MAX_BLOB_STAMPS).map((s) => ({ kid: s.kid, nonce: s.nonce, box: s.box })),
    kids: validKids(data.kids)
  }
}

function writeBlobStamps (storage, { items, kids }) {
  return storage.writeJson('blobStamps', {
    v: 2,
    items: items.filter((s) => validBox(s) && typeof s.kid === 'string' && HEX16_RE.test(s.kid)).slice(0, MAX_BLOB_STAMPS).map((s) => ({ kid: s.kid, nonce: s.nonce, box: s.box })),
    kids: validKids(kids)
  })
}

// kv dmCtlQueue = { v: 2, items: [{ nonce, box }] }: ctls to the own box not
// put yet, oldest first, at most MAX_DM_CTL_QUEUE, each sealed. Inside, a
// sealed envelope still waiting for a stamp or, once stamped, the exact
// encoded drop (dropId and stamp inside), so a later put repeats the same
// bytes.
const MAX_DM_CTL_QUEUE = 32

async function readDmCtlQueue (storage, prefix = '') {
  const data = await readKv(storage, prefix + 'dmCtlQueue')
  if (!isV2(data)) return []
  return data.items.filter(validBox).slice(-MAX_DM_CTL_QUEUE).map((b) => ({ nonce: b.nonce, box: b.box }))
}

function writeDmCtlQueue (storage, items, prefix = '') {
  return storage.writeJson(prefix + 'dmCtlQueue', { v: 2, items: items.filter(validBox).slice(-MAX_DM_CTL_QUEUE).map((b) => ({ nonce: b.nonce, box: b.box })) })
}

// Appends one sealed item -> how many old ones were dropped to fit.
async function pushDmCtlQueue (storage, item, prefix = '') {
  const items = [...await readDmCtlQueue(storage, prefix), item]
  const dropped = Math.max(0, items.length - MAX_DM_CTL_QUEUE)
  await writeDmCtlQueue(storage, items, prefix)
  return dropped
}

// kv pageSecrets = { v: 1, pages: { <page>: { gen, sealed, legacy, cert, previous? } } }:
// the Página secrets this identity holds (./page-dm.js), `sealed`,
// legacy.sealed and each previous[i].sealed a secretbox under the local dm
// key, so kv alone opens nothing; cert is the page's public membership
// certificate. previous: the dm box secrets of the gens held before the
// current one, newest first, for reading only.
const MAX_PAGE_SECRETS = 64
const MAX_PAGE_PREVIOUS = 3

function validPrevious (list) {
  if (list === undefined) return true
  return Array.isArray(list) && list.length <= MAX_PAGE_PREVIOUS && list.every((p) => p !== null && typeof p === 'object' &&
    Number.isSafeInteger(p.gen) && p.gen >= 1 && p.gen <= 0xffffffff && validBox(p.sealed))
}

function validPageEntry (e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return false
  if (!Number.isSafeInteger(e.gen) || e.gen < 1 || e.gen > 0xffffffff || !validBox(e.sealed)) return false
  if (e.legacy !== null && (typeof e.legacy !== 'object' || !Number.isSafeInteger(e.legacy.gen) ||
      e.legacy.gen < 1 || !validBox(e.legacy.sealed))) return false
  if (!validPrevious(e.previous)) return false
  return e.cert !== null && typeof e.cert === 'object' && !Array.isArray(e.cert)
}

function copyPageEntry (e) {
  return {
    gen: e.gen,
    sealed: { nonce: e.sealed.nonce, box: e.sealed.box },
    legacy: e.legacy === null ? null : { gen: e.legacy.gen, sealed: { nonce: e.legacy.sealed.nonce, box: e.legacy.sealed.box } },
    cert: JSON.parse(JSON.stringify(e.cert)),
    previous: (e.previous || []).map((p) => ({ gen: p.gen, sealed: { nonce: p.sealed.nonce, box: p.sealed.box } }))
  }
}

// -> { <page>: entry }; a torn value or a bad entry reads as absent.
async function readPageSecrets (storage) {
  const data = await readKv(storage, 'pageSecrets')
  const out = {}
  if (!isVersioned(data) || data.pages === null || typeof data.pages !== 'object' || Array.isArray(data.pages)) return out
  for (const [page, e] of Object.entries(data.pages)) {
    if (/^[0-9a-f]{64}$/.test(page) && validPageEntry(e) && Object.keys(out).length < MAX_PAGE_SECRETS) out[page] = copyPageEntry(e)
  }
  return out
}

function writePageSecrets (storage, pages) {
  const out = {}
  for (const [page, e] of Object.entries(pages)) {
    if (!/^[0-9a-f]{64}$/.test(page) || !validPageEntry(e)) throw new TypeError('segredos inválidos')
    out[page] = copyPageEntry(e)
  }
  if (Object.keys(out).length > MAX_PAGE_SECRETS) throw new UsageError('páginas demais neste aparelho')
  return storage.writeJson('pageSecrets', { v: 1, pages: out })
}

// kv pageMaxGen = { v: 1, pages: { <page>: gen } }: the highest page share
// gen this device ever held per page (./page-dm.js adopt refuses a lower
// one, so a replayed older share cannot roll a page back). Kept by
// dm.pageForget and across lock; only the identity reset removes it.
const MAX_PAGE_MAX_GEN = 256

function validGen (g) {
  return Number.isSafeInteger(g) && g >= 1 && g <= 0xffffffff
}

// -> { <page>: gen }; a torn value or a bad entry reads as absent.
async function readPageMaxGen (storage) {
  const data = await readKv(storage, 'pageMaxGen')
  const out = {}
  if (!isVersioned(data) || data.pages === null || typeof data.pages !== 'object' || Array.isArray(data.pages)) return out
  for (const [page, g] of Object.entries(data.pages)) {
    if (/^[0-9a-f]{64}$/.test(page) && validGen(g) && Object.keys(out).length < MAX_PAGE_MAX_GEN) out[page] = g
  }
  return out
}

function writePageMaxGen (storage, pages) {
  const out = {}
  for (const [page, g] of Object.entries(pages)) {
    if (!/^[0-9a-f]{64}$/.test(page) || !validGen(g)) throw new TypeError('gerações inválidas')
    out[page] = g
  }
  if (Object.keys(out).length > MAX_PAGE_MAX_GEN) throw new UsageError('páginas demais neste aparelho')
  return storage.writeJson('pageMaxGen', { v: 1, pages: out })
}

// The legacy bundle of a page (dm.pageLegacyChunk, docs/rpc.md 5.114), all
// under the page prefix: kv dmLegacy = { v: 1, id, count, have } names the
// bundle being gathered (written before its first chunk, so a forget or a
// reset finds every chunk); kv dmLegacy/<index> = { nonce, box }, a chunk's
// plaintext sealed under the page store's key (./dm-store.js sealBytes);
// kv dmLegacyBlocks = { nonce, box }, the sealed list of peers whose legacy
// block still has to be signed again; kv dmLegacyDone = { nonce, box }, the
// sealed ids of the bundles filed here, so a repeated chunk never files one
// twice.
const PAGE_LEGACY_CHUNKS_MAX = 1024
const MAX_LEGACY_SEALED_B64 = 1 << 21
const HEX64_RE = /^[0-9a-f]{64}$/

function validLegacySealed (b) {
  return b !== null && typeof b === 'object' && typeof b.nonce === 'string' && NONCE48_RE.test(b.nonce) &&
    typeof b.box === 'string' && b.box.length <= MAX_LEGACY_SEALED_B64 && BASE64_RE.test(b.box)
}

function legacyIndex (index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= PAGE_LEGACY_CHUNKS_MAX) throw new TypeError('parte inválida')
  return index
}

// -> { id, count, have } or null.
async function readPageLegacy (storage, prefix) {
  const data = await readKv(storage, prefix + 'dmLegacy')
  if (!isVersioned(data) || typeof data.id !== 'string' || !HEX64_RE.test(data.id)) return null
  if (!Number.isSafeInteger(data.count) || data.count < 1 || data.count > PAGE_LEGACY_CHUNKS_MAX || !Array.isArray(data.have)) return null
  const have = [...new Set(data.have.filter((i) => Number.isSafeInteger(i) && i >= 0 && i < data.count))].sort((a, b) => a - b)
  return { id: data.id, count: data.count, have, horizon: Number.isSafeInteger(data.horizon) ? data.horizon : null }
}

function writePageLegacy (storage, prefix, meta) {
  if (meta === null) return storage.writeJson(prefix + 'dmLegacy', null)
  if (typeof meta.id !== 'string' || !HEX64_RE.test(meta.id) || !Number.isSafeInteger(meta.count) || meta.count < 1 || meta.count > PAGE_LEGACY_CHUNKS_MAX) throw new TypeError('pacote inválido')
  const have = [...new Set(meta.have)].filter((i) => Number.isSafeInteger(i) && i >= 0 && i < meta.count).sort((a, b) => a - b)
  const out = { v: 1, id: meta.id, count: meta.count, have }
  if (Number.isSafeInteger(meta.horizon)) out.horizon = meta.horizon
  return storage.writeJson(prefix + 'dmLegacy', out)
}

async function readPageLegacyChunk (storage, prefix, index) {
  const data = await readKv(storage, prefix + 'dmLegacy/' + legacyIndex(index))
  return validLegacySealed(data) ? { nonce: data.nonce, box: data.box } : null
}

function writePageLegacyChunk (storage, prefix, index, sealed) {
  const k = prefix + 'dmLegacy/' + legacyIndex(index)
  if (sealed === null) return storage.writeJson(k, null)
  if (!validLegacySealed(sealed)) throw new TypeError('parte inválida')
  return storage.writeJson(k, { nonce: sealed.nonce, box: sealed.box })
}

// Every chunk the bundle record names, then the record.
async function deletePageLegacyChunks (storage, prefix) {
  const meta = await readPageLegacy(storage, prefix)
  if (meta !== null) for (let i = 0; i < meta.count; i++) await storage.writeJson(prefix + 'dmLegacy/' + i, null)
  await storage.writeJson(prefix + 'dmLegacy', null)
}

async function readPageLegacyBlocks (storage, prefix) {
  const data = await readKv(storage, prefix + 'dmLegacyBlocks')
  return validLegacySealed(data) ? { nonce: data.nonce, box: data.box } : null
}

function writePageLegacyBlocks (storage, prefix, sealed) {
  if (sealed === null) return storage.writeJson(prefix + 'dmLegacyBlocks', null)
  if (!validLegacySealed(sealed)) throw new TypeError('lista inválida')
  return storage.writeJson(prefix + 'dmLegacyBlocks', { nonce: sealed.nonce, box: sealed.box })
}

async function readPageLegacyDone (storage, prefix) {
  const data = await readKv(storage, prefix + 'dmLegacyDone')
  return validLegacySealed(data) ? { nonce: data.nonce, box: data.box } : null
}

function writePageLegacyDone (storage, prefix, sealed) {
  if (sealed === null) return storage.writeJson(prefix + 'dmLegacyDone', null)
  if (!validLegacySealed(sealed)) throw new TypeError('lista inválida')
  return storage.writeJson(prefix + 'dmLegacyDone', { nonce: sealed.nonce, box: sealed.box })
}

// One page's store and kv entries (dm.pageForget, reset), its media cache
// included (the ./dm-store.js index under the prefix needs no key).
async function deletePageDm (storage, page) {
  const prefix = pageDmPrefix(page)
  const index = await readKv(storage, prefix + 'dmMediaIndex')
  if (isVersioned(index) && Array.isArray(index.items)) {
    for (const e of index.items) {
      if (e === null || typeof e !== 'object' || typeof e.n !== 'string' || !SEEN_TOKEN_RE.test(e.n) || !Number.isSafeInteger(e.c) || e.c < 1 || e.c > 4) continue
      for (let i = 0; i < e.c; i++) await storage.writeJson(prefix + 'dmMedia/' + e.n + '/' + i, null)
    }
  }
  await storage.writeJson(prefix + 'dmMediaIndex', null)
  await storage.deleteCore(prefix + DM_LOCAL)
  await deletePageLegacyChunks(storage, prefix)
  for (const key of ['dmCursor', 'dmSeen', 'dmCtlQueue', 'dmLegacyBlocks', 'dmLegacyDone']) await storage.writeJson(prefix + key, null)
}

// kv pageStores = { v: 1, pages: [page] }: every page whose local store this
// device ever opened, written ahead of the store, so a reset removes a page
// history whose secrets entry is already gone. Only page keys, no secret.
const MAX_PAGE_STORES = 256

async function readPageStores (storage) {
  const data = await readKv(storage, 'pageStores')
  if (!isVersioned(data) || !Array.isArray(data.pages)) return []
  return [...new Set(data.pages.filter((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p)))].slice(0, MAX_PAGE_STORES)
}

async function notePageStore (storage, page) {
  pageDmPrefix(page)
  const pages = await readPageStores(storage)
  if (pages.includes(page)) return
  if (pages.length >= MAX_PAGE_STORES) throw new UsageError('páginas demais neste aparelho')
  await storage.writeJson('pageStores', { v: 1, pages: [...pages, page] })
}

async function forgetPageStore (storage, page) {
  const pages = await readPageStores(storage)
  if (pages.includes(page)) await storage.writeJson('pageStores', { v: 1, pages: pages.filter((p) => p !== page) })
}

// Every dm kv entry and the local store (reset).
async function deleteDmData (storage) {
  const listed = new Set([...Object.keys(await readPageSecrets(storage)), ...await readPageStores(storage)])
  for (const page of listed) await deletePageDm(storage, page)
  await storage.writeJson('pageSecrets', null)
  await storage.writeJson('pageMaxGen', null)
  await storage.writeJson('pageStores', null)
  await storage.deleteCore(DM_LOCAL)
  // seenSync before seenRemote and seenLocal: an interrupted reset must
  // never leave the compare-and-swap cursor without the documents it was
  // taken from.
  for (const key of ['seenSync', 'seenRemote', 'dmKey', 'dmCursor', 'dmSeen', 'dmStamps', 'blobStamps', 'dmCtlQueue', 'seenLocal']) await storage.writeJson(key, null)
}

// kv ageVerified / ageSince = { v: 1, proof }: the account service's signed
// age attestations (@varanda/core lib/age-proof.js). Shape and size only:
// kv is device-owner writable, so the session re-verifies every read
// against the own key and the association.
const MAX_AGE_PROOF_BYTES = 1024

function isAgeProof (proof) {
  return proof !== null && typeof proof === 'object' && !Array.isArray(proof) &&
    b4a.byteLength(JSON.stringify(proof)) <= MAX_AGE_PROOF_BYTES
}

async function readAgeProof (storage, key) {
  const data = await readKv(storage, key)
  return isVersioned(data) && isAgeProof(data.proof) ? data.proof : null
}

function writeAgeProof (storage, key, proof) {
  if (!isAgeProof(proof)) throw new TypeError('comprovante de idade inválido')
  return storage.writeJson(key, { v: 1, proof })
}

function readAgeVerified (storage) {
  return readAgeProof(storage, 'ageVerified')
}

function writeAgeVerified (storage, proof) {
  return writeAgeProof(storage, 'ageVerified', proof)
}

function readAgeSince (storage) {
  return readAgeProof(storage, 'ageSince')
}

function writeAgeSince (storage, proof) {
  if (proof === null) return storage.writeJson('ageSince', null)
  return writeAgeProof(storage, 'ageSince', proof)
}

async function deleteAgeProofs (storage) {
  for (const key of ['ageVerified', 'ageSince']) await storage.writeJson(key, null)
}

// kv phoneVerified / phoneSince = { v: 1, proof }: the account service's
// signed phone attestations (@varanda/core lib/phone-proof.js), stored like
// the age ones. They carry no phone number.
const MAX_PHONE_PROOF_BYTES = 1024

function isPhoneProof (proof) {
  return proof !== null && typeof proof === 'object' && !Array.isArray(proof) &&
    b4a.byteLength(JSON.stringify(proof)) <= MAX_PHONE_PROOF_BYTES
}

async function readPhoneProof (storage, key) {
  const data = await readKv(storage, key)
  return isVersioned(data) && isPhoneProof(data.proof) ? data.proof : null
}

function writePhoneProof (storage, key, proof) {
  if (proof === null) return storage.writeJson(key, null)
  if (!isPhoneProof(proof)) throw new TypeError('comprovante de celular inválido')
  return storage.writeJson(key, { v: 1, proof })
}

function readPhoneVerified (storage) {
  return readPhoneProof(storage, 'phoneVerified')
}

function writePhoneVerified (storage, proof) {
  return writePhoneProof(storage, 'phoneVerified', proof)
}

function readPhoneSince (storage) {
  return readPhoneProof(storage, 'phoneSince')
}

function writePhoneSince (storage, proof) {
  return writePhoneProof(storage, 'phoneSince', proof)
}

async function deletePhoneProofs (storage) {
  for (const key of ['phoneVerified', 'phoneSince']) await storage.writeJson(key, null)
}

module.exports = {
  readAgeVerified,
  writeAgeVerified,
  readAgeSince,
  writeAgeSince,
  deleteAgeProofs,
  readPhoneVerified,
  writePhoneVerified,
  readPhoneSince,
  writePhoneSince,
  deletePhoneProofs,
  DM_LOCAL,
  openDmLocal,
  deleteDmLocal,
  readDmKey,
  writeDmKey,
  readDmCursor,
  writeDmCursor,
  readPageCursor,
  readPageLegacy,
  writePageLegacy,
  readPageLegacyChunk,
  writePageLegacyChunk,
  deletePageLegacyChunks,
  readPageLegacyBlocks,
  writePageLegacyBlocks,
  readPageLegacyDone,
  writePageLegacyDone,
  PAGE_LEGACY_CHUNKS_MAX,
  writePageCursor,
  readPageSecrets,
  writePageSecrets,
  readPageMaxGen,
  writePageMaxGen,
  deletePageDm,
  pageDmPrefix,
  readPageStores,
  notePageStore,
  forgetPageStore,
  readDmSeen,
  writeDmSeen,
  readGroupSeen,
  writeGroupSeen,
  MAX_GROUP_SEEN,
  readSeenLocal,
  writeSeenLocal,
  readSeenSync,
  writeSeenSync,
  readSeenRemote,
  writeSeenRemote,
  readDmStamps,
  writeDmStamps,
  readBlobStamps,
  writeBlobStamps,
  MAX_BLOB_STAMPS,
  deleteDmData,
  readDmCtlQueue,
  writeDmCtlQueue,
  pushDmCtlQueue,
  MAX_DM_CTL_QUEUE,
  DIARY,
  LOCKED,
  MISMATCH,
  MEDIA_PREFIX,
  MEDIA_FULL,
  MEDIA_INVALID,
  GROUP_PREFIX,
  GROUP_FULL,
  GROUPS_FULL,
  MAX_GROUP_REPLICAS,
  replicaName,
  mediaName,
  openDiary,
  diaryExists,
  diaryStatus,
  forgetLegacy,
  isLegacy,
  openReplica,
  replicaExists,
  purgeReplica,
  readAll,
  readVisible,
  readRaw,
  readHeld,
  readBlocks,
  readBlock0,
  appendRecord,
  appendRecords,
  readConfig,
  writeConfig,
  readFollows,
  writeFollows,
  readBlocklist,
  writeBlocklist,
  readMemberBlocks,
  writeMemberBlocks,
  openMediaCore,
  openMediaCoreReadOnly,
  writeMediaHeader,
  appendMediaBlocks,
  clearMediaRanges,
  readMediaDevice,
  writeMediaDevice,
  readGroupBoxDevice,
  writeGroupBoxDevice,
  ensureGroupBoxDevice,
  readMediaCores,
  addMediaCore,
  deleteMediaCores,
  groupName,
  openGroupWriter,
  openGroupReplica,
  openGroupCoreReadOnly,
  groupCoreExists,
  purgeGroupCore,
  appendGroupRecord,
  readGroupWriters,
  putGroupWriter,
  removeGroupWriter,
  readGroupReplicas,
  addGroupReplica,
  removeGroupReplica,
  readGroupDiaries,
  addGroupDiary,
  removeGroupDiary,
  deleteGroupData,
  readCommunityCreate,
  writeCommunityCreate,
  readLeaveNotes,
  writeLeaveNotes,
  purgeLegacyGroupCores,
  readGroupCoreKeys,
  readGroupCerts,
  putGroupCert,
  readBoundRoots,
  addBoundRoot,
  withFollowsLock,
  readFollowsPending,
  writeFollowsPending,
  readFollowsMigrated,
  writeFollowsMigrated,
  clearFollowsMigrated,
  writeFoldedFollows
}
