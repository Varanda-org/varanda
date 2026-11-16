'use strict'

// Connected devices (docs/protocol.md section 2, `device`; docs/rpc.md
// device.*): each device of an account gets a random id and a name in the
// account's own diary, so the person can list the devices and disconnect a
// lost one. The name and the writers a device holds are sealed in an opaque
// secretbox: a seeder or a follower sees only blobs.
//
// Key: K = BLAKE2b-256(message = "varanda/device/1" || diary key,
// key = identity seed), the seed being the first 32 bytes of the diary's
// Ed25519 secret key. Every unlocked device of the account derives the same
// K with no exchange; the domain string keeps it apart from every other key
// derived from the same seed (lib/seen-blob.js seenKeyFromSeed is another).
// Callers zero K (sodium_memzero) when done.
//
// Everything here is pure and total except deviceKey and sealDevice (which
// take a caller error as a TypeError) and newDeviceId (randomness). A record
// that fails to open or validate is ignored, never thrown.

const b4a = require('b4a')
const sodium = require('sodium-universal')
const { canonicalInviteCardText } = require('@varanda/rpc')
const { deviceRecord, validRecordCopy, isHex64, DEVICE_NONCE_BYTES, MAX_DEVICE_BOX } = require('./records')

const DEVICE_DOMAIN = b4a.from('varanda/device/1', 'utf8')
const DEVICE_KEY_BYTES = 32
const DEVICE_NAME_MAX = 40
const MAX_DEVICE_WRITERS = 32
const INNER_KEYS = ['v', 'id', 'name', 'on', 'writers']
const PAIR_KEYS = ['group', 'writer']
const MAC_BYTES = 16 // crypto_secretbox_MACBYTES

const SELF_REFUSED = 'não dá para desconectar este aparelho por aqui'
const NOT_FOUND = 'aparelho não encontrado'
const OFF_REFUSED = 'este aparelho foi desconectado da conta'
const NOT_OFF = 'este aparelho está conectado'
const PARTIAL = 'a desconexão ficou incompleta: tente de novo'

function isBytes (v) {
  return b4a.isBuffer(v) || v instanceof Uint8Array
}

function isPlain (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function exactKeys (o, keys) {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))
}

// K for the diary whose key is `diaryKey` (the 32-byte key readers know it
// by) from the Ed25519 `secretKey` (64 bytes, the seed first) that signs
// it. In the browser node (Hypercore 10) the diary key is the signing
// public key; in the node session (Hypercore 11) it is derived from a
// manifest, so the two are not compared here.
function deviceKey (secretKey, diaryKey) {
  if (!isBytes(secretKey) || secretKey.byteLength !== 64) throw new TypeError('secretKey must be 64 bytes')
  if (!isBytes(diaryKey) || diaryKey.byteLength !== 32) throw new TypeError('diaryKey must be 32 bytes')
  const out = b4a.alloc(DEVICE_KEY_BYTES)
  sodium.crypto_generichash(out, b4a.concat([DEVICE_DOMAIN, diaryKey]), secretKey.subarray(0, 32))
  return out
}

function wipeKey (key) {
  if (isBytes(key)) sodium.sodium_memzero(key)
}

function newDeviceId () {
  const id = b4a.alloc(32)
  sodium.randombytes_buf(id)
  return b4a.toString(id, 'hex')
}

// The stored form of a device name (trimmed, NFC, 1..40 code points, no
// control or display-unsafe character: the invite card name rule), or null.
function canonicalDeviceName (name) {
  return canonicalInviteCardText(name, DEVICE_NAME_MAX)
}

function validName (name) {
  return name === null || (typeof name === 'string' && canonicalDeviceName(name) === name)
}

function pairKey (p) {
  return p.group + ':' + p.writer
}

function validWriters (list) {
  if (!Array.isArray(list) || list.length > MAX_DEVICE_WRITERS) return false
  const seen = new Set()
  for (const p of list) {
    if (!isPlain(p) || !exactKeys(p, PAIR_KEYS) || !isHex64(p.group) || !isHex64(p.writer)) return false
    const k = pairKey(p)
    if (seen.has(k)) return false
    seen.add(k)
  }
  return true
}

function validInner (inner) {
  try {
    return isPlain(inner) && exactKeys(inner, INNER_KEYS) && inner.v === 1 && isHex64(inner.id) &&
      validName(inner.name) && typeof inner.on === 'boolean' && validWriters(inner.writers)
  } catch {
    return false
  }
}

function innerJson (inner) {
  return JSON.stringify({
    v: 1,
    id: inner.id,
    name: inner.name,
    on: inner.on,
    writers: inner.writers.map((p) => ({ group: p.group, writer: p.writer }))
  })
}

// -> { nonce, box } (canonical base64) for a valid inner object.
function sealDevice (inner, key) {
  if (!validInner(inner)) throw new TypeError('invalid device record')
  if (!isBytes(key) || key.byteLength !== DEVICE_KEY_BYTES) throw new TypeError('key must be 32 bytes')
  const plain = b4a.from(innerJson(inner), 'utf8')
  if (plain.byteLength + MAC_BYTES > MAX_DEVICE_BOX) throw new TypeError('device record too large')
  const nonce = b4a.alloc(DEVICE_NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(plain.byteLength + MAC_BYTES)
  sodium.crypto_secretbox_easy(box, plain, nonce, key)
  sodium.sodium_memzero(plain)
  return { nonce: b4a.toString(nonce, 'base64'), box: b4a.toString(box, 'base64') }
}

// The diary record for `inner` sealed under `key`.
function sealedRecord (inner, key, at) {
  const { nonce, box } = sealDevice(inner, key)
  return at === undefined ? deviceRecord({ nonce, box }) : deviceRecord({ nonce, box, at })
}

// The validated inner object of a `device` record, or null (not a valid
// record, another key, a tampered box or an invalid inner object).
function openDevice (record, key, seq = 1) {
  try {
    if (!isBytes(key) || key.byteLength !== DEVICE_KEY_BYTES) return null
    const copy = validRecordCopy(record, seq)
    if (copy === null || copy.type !== 'device') return null
    const nonce = b4a.from(copy.nonce, 'base64')
    const box = b4a.from(copy.box, 'base64')
    const plain = b4a.alloc(box.byteLength - MAC_BYTES)
    if (!sodium.crypto_secretbox_open_easy(plain, box, nonce, key)) return null
    let inner = null
    try {
      inner = JSON.parse(b4a.toString(plain, 'utf8'))
    } catch {}
    sodium.sodium_memzero(plain)
    return validInner(inner) ? inner : null
  } catch {
    return null
  }
}

// Visits the own diary entries ({ seq, record }) of `type` in seq order (the
// type is read before any validation, so a long diary costs one pass); a
// hostile entry is skipped.
function eachEntry (entries, type, fn) {
  if (!Array.isArray(entries)) return
  const list = []
  for (const e of entries) {
    try {
      if (e !== null && typeof e === 'object' && Number.isSafeInteger(e.seq) && e.seq >= 1 &&
          e.record !== null && typeof e.record === 'object' && e.record.type === type) list.push({ seq: e.seq, record: e.record })
    } catch {}
  }
  list.sort((a, b) => a.seq - b.seq)
  for (const e of list) fn(e.seq, e.record)
}

// The account's own diary entries -> { byId: Map(id -> { name, since, on,
// writers: [{ group, writer }] }) }: name is the last non-null one by seq,
// on is false once any record of the id says so (final for the id),
// writers is the union, since the `at` of the id's first record.
function foldDevices (entries, key) {
  const byId = new Map()
  try {
    eachEntry(entries, 'device', (seq, record) => {
      const inner = openDevice(record, key, seq)
      if (inner === null) return
      let d = byId.get(inner.id)
      if (d === undefined) {
        d = { name: null, since: record.at, on: true, writers: [], seen: new Set() }
        byId.set(inner.id, d)
      }
      if (inner.name !== null) d.name = inner.name
      if (inner.on === false) d.on = false
      for (const p of inner.writers) {
        const k = pairKey(p)
        if (d.seen.has(k)) continue
        d.seen.add(k)
        d.writers.push({ group: p.group, writer: p.writer })
      }
    })
  } catch {}
  for (const d of byId.values()) delete d.seen
  return { byId }
}

// The (root, writer) pairs the diary links now: the latest valid group-join
// of the pair (highest seq) is on:true. Roots (writer === group) are never
// listed: a device mapping never names them and a disconnect never cuts one.
function linkedPairs (entries) {
  const latest = new Map()
  try {
    eachEntry(entries, 'group-join', (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join' || copy.writer === copy.group) return
      latest.set(pairKey(copy), { group: copy.group, writer: copy.writer, on: copy.on })
    })
  } catch {}
  const out = []
  for (const p of latest.values()) if (p.on) out.push({ group: p.group, writer: p.writer })
  return out
}

// 'group:writer' -> the lowest `cut` the diary's group-cut marks give it.
function cutMarks (entries) {
  const out = new Map()
  try {
    eachEntry(entries, 'group-cut', (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-cut') return
      const k = pairKey(copy)
      if (!out.has(k) || copy.cut < out.get(k)) out.set(k, copy.cut)
    })
  } catch {}
  return out
}

function chunks (list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// Inner objects mapping `writers` to `id`, at most MAX_DEVICE_WRITERS per
// record; `name` (null for none) goes on the first. At least one record
// when `name` is not null.
function mappingRecords (id, name, writers, on = true) {
  const parts = chunks(writers, MAX_DEVICE_WRITERS)
  if (parts.length === 0 && name !== null) parts.push([])
  return parts.map((w, i) => ({ v: 1, id, name: i === 0 ? name : null, on, writers: w }))
}

function nonRoot (pairs) {
  const seen = new Set()
  const out = []
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (p === null || typeof p !== 'object' || !isHex64(p.group) || !isHex64(p.writer) || p.group === p.writer) continue
    const k = pairKey(p)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ group: p.group, writer: p.writer })
  }
  return out
}

// This device's current writers (`own`, kv groupWriters or groups.json as
// { group, writer }) the diary has not cut, roots dropped.
function uncut (own, cuts) {
  return nonRoot(own).filter((p) => !cuts.has(pairKey(p)))
}

// Whether a current writer of this device (never a root) carries a cut mark.
function ownCutAny (own, cuts) {
  return nonRoot(own).some((p) => cuts.has(pairKey(p)))
}

// Whether this device is disconnected: its id is off in the fold or, with no
// id yet, one of its current writers is cut (a disconnect of "Aparelhos
// anteriores" from another device).
function selfOff ({ fold, self, own, cuts }) {
  if (self === null) return ownCutAny(own, cuts)
  const d = fold.byId.get(self)
  return d !== undefined && !d.on
}

// The records registering id `id` afresh: the name and every writer not cut.
function registerRecords (id, name, own, cuts) {
  const records = mappingRecords(id, name, uncut(own, cuts))
  return records.length > 0 ? records : [{ v: 1, id, name, on: true, writers: [] }]
}

// What device.hello writes. -> { off: true, records: [] } for a
// disconnected device (selfOff: nothing is registered, and no id is created
// when there is none); else the inner objects still missing for `id` (the
// new id the caller made when `self` is null): the name only while the id
// has none (hello never renames), and every uncut writer no record maps.
function helloPlan ({ fold, self, id, name, own, cuts }) {
  if (selfOff({ fold, self, own, cuts })) return { off: true, records: [] }
  const d = fold.byId.get(id)
  if (d === undefined) return { off: false, records: registerRecords(id, name, own, cuts) }
  const mapped = new Set(d.writers.map(pairKey))
  const missing = uncut(own, cuts).filter((p) => !mapped.has(pairKey(p)))
  return { off: false, records: mappingRecords(id, d.name === null ? name : null, missing) }
}

// The record an own new on:true join of `writer` in `group` adds for id
// `self`, or null (no id, a root, the id off or the pair already mapped).
function joinRecord ({ fold, self, group, writer }) {
  if (self === null || !isHex64(group) || !isHex64(writer) || group === writer) return null
  const d = fold.byId.get(self)
  if (d !== undefined && (!d.on || d.writers.some((p) => p.group === group && p.writer === writer))) return null
  return { v: 1, id: self, name: null, on: true, writers: [{ group, writer }] }
}

// What device.reconnect writes: { error: NOT_OFF } on a device that is not
// disconnected, else { records } registering the new id `id`.
function reconnectPlan ({ fold, self, id, name, own, cuts }) {
  if (!selfOff({ fold, self, own, cuts })) return { error: NOT_OFF }
  return { records: registerRecords(id, name, own, cuts) }
}

// Linked pairs no cut mark touches, as 'group:writer' keys.
function liveLinks (linked, cuts) {
  return new Set(linked.filter((p) => !cuts.has(pairKey(p))).map(pairKey))
}

// The device.list result. `self` is this device's id (null before its first
// hello), `own` its writers.
function listView ({ fold, self, linked, cuts, own }) {
  const live = liveLinks(linked, cuts)
  const ownKeys = new Set(nonRoot(own).map(pairKey))
  const mapped = new Set()
  const devices = []
  for (const [id, d] of fold.byId) {
    for (const p of d.writers) mapped.add(pairKey(p))
    devices.push({
      id,
      name: d.name,
      since: d.since,
      on: d.on,
      writers: d.writers.filter((p) => live.has(pairKey(p))).length,
      self: id === self
    })
  }
  const rank = (d) => (d.self ? 0 : d.on ? 1 : 2)
  devices.sort((a, b) => rank(a) - rank(b) || (a.since < b.since ? 1 : a.since > b.since ? -1 : 0) || (a.id < b.id ? -1 : 1))
  let previous = 0
  for (const k of live) if (!mapped.has(k) && !ownKeys.has(k)) previous++
  return {
    self,
    off: selfOff({ fold, self, own, cuts }),
    devices,
    previous: previous === 0 ? null : { writers: previous }
  }
}

// The pairs device.disconnect cuts, before the held-length check:
// { error: OFF_REFUSED | SELF_REFUSED | NOT_FOUND } or { pairs, off }
// (`off` the id to turn off afterwards, null for `previous`). Never this
// device's own writers, never a root, never a pair already marked, only
// pairs the diary links now. A disconnected device disconnects nothing.
function disconnectPlan ({ fold, self, id = null, previous = false, linked, own, cuts = new Map() }) {
  if (selfOff({ fold, self, own, cuts })) return { error: OFF_REFUSED }
  const ownKeys = new Set(nonRoot(own).map(pairKey))
  const linkedKeys = new Set(nonRoot(linked).map(pairKey))
  // A pair that already carries a mark is never named (alreadyCut): marking
  // it again could only lower the earlier mark. For `previous` this also
  // matches listView, which does not count a marked pair.
  const take = (list) => nonRoot(list).filter((p) => linkedKeys.has(pairKey(p)) && !ownKeys.has(pairKey(p)) && !cuts.has(pairKey(p)))
  if (previous === true) {
    const mapped = new Set()
    for (const d of fold.byId.values()) for (const p of d.writers) mapped.add(pairKey(p))
    return { pairs: take(linked).filter((p) => !mapped.has(pairKey(p))), off: null }
  }
  if (id !== null && id === self) return { error: SELF_REFUSED }
  const d = id === null ? undefined : fold.byId.get(id)
  if (d === undefined || !d.on) return { error: NOT_FOUND }
  return { pairs: take(d.writers), off: id }
}

// What device.* reads from the own diary entries, at once: { fold, cuts,
// linked, off } for this device (`self` its id or null, `own` its writers).
function deviceView (entries, key, self, own) {
  const fold = foldDevices(entries, key)
  const cuts = cutMarks(entries)
  return { fold, cuts, linked: linkedPairs(entries), off: selfOff({ fold, self, own, cuts }) }
}

// Whether a pair already carries a mark: a disconnect never marks it again.
// cutMarks keeps the lowest mark, so a new one is either ignored or lowers
// the earlier one, hiding the history the device that cut first kept.
function alreadyCut (cuts, pair) {
  return cuts.has(pairKey(pair))
}

module.exports = {
  DEVICE_DOMAIN,
  DEVICE_KEY_BYTES,
  DEVICE_NAME_MAX,
  MAX_DEVICE_WRITERS,
  SELF_REFUSED,
  NOT_FOUND,
  OFF_REFUSED,
  NOT_OFF,
  PARTIAL,
  deviceKey,
  wipeKey,
  newDeviceId,
  canonicalDeviceName,
  validInner,
  sealDevice,
  sealedRecord,
  openDevice,
  foldDevices,
  linkedPairs,
  cutMarks,
  mappingRecords,
  uncut,
  ownCutAny,
  selfOff,
  helloPlan,
  joinRecord,
  reconnectPlan,
  listView,
  disconnectPlan,
  deviceView,
  alreadyCut,
  pairKey
}
