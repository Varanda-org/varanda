'use strict'

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const devices = require('../lib/devices')
const { groupJoinRecord, groupCutRecord, validRecordCopy, MAX_DEVICE_BOX } = require('../lib/records')

function rand32 () {
  const b = b4a.alloc(32)
  sodium.randombytes_buf(b)
  return b
}

function hex32 () {
  return b4a.toString(rand32(), 'hex')
}

function secretKey () {
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(64)
  sodium.crypto_sign_keypair(pk, sk)
  return sk
}

// A diary of { seq, record } from a list of records (block 0 is the
// certificate, so entries start at seq 1).
function diary (records) {
  return records.map((record, i) => ({ seq: i + 1, record }))
}

function at (n) {
  return '2026-11-16T10:00:0' + n + '.000Z'
}

function setup () {
  const key = devices.deviceKey(secretKey(), rand32())
  return { key, seal: (inner, n = 0) => devices.sealedRecord(inner, key, at(n)) }
}

test('deviceKey: keyed by the seed, bound to the diary key', (t) => {
  const sk = secretKey()
  const dk = rand32()
  const k1 = devices.deviceKey(sk, dk)
  t.is(k1.byteLength, 32)
  t.alike(devices.deviceKey(sk, dk), k1, 'deterministic')
  t.unlike(devices.deviceKey(sk, rand32()), k1, 'another diary key')
  t.unlike(devices.deviceKey(secretKey(), dk), k1, 'another seed')
  t.exception.all(() => devices.deviceKey(b4a.alloc(32), dk), /secretKey/)
  t.exception.all(() => devices.deviceKey(sk, b4a.alloc(31)), /diaryKey/)
  devices.wipeKey(k1)
  t.alike(k1, b4a.alloc(32), 'wiped')
})

test('seal and open: round trip, wrong key and tampering', (t) => {
  const { key, seal } = setup()
  const inner = { v: 1, id: hex32(), name: 'Celular', on: true, writers: [{ group: hex32(), writer: hex32() }] }
  const record = seal(inner)
  t.alike(Object.keys(record).sort(), ['at', 'box', 'nonce', 'type'])
  t.ok(validRecordCopy(record, 1), 'a valid diary record')
  t.alike(devices.openDevice(record, key), inner)
  t.is(devices.openDevice(record, rand32()), null, 'another key')
  const box = b4a.from(record.box, 'base64')
  box[box.length - 1] ^= 1
  t.is(devices.openDevice({ ...record, box: b4a.toString(box, 'base64') }, key), null, 'tampered')
  t.exception.all(() => devices.sealDevice({ ...inner, name: '' }, key), /invalid/)
  t.exception.all(() => devices.sealDevice({ ...inner, extra: 1 }, key), /invalid/)
  t.exception.all(() => devices.sealDevice({ ...inner, writers: [inner.writers[0], inner.writers[0]] }, key), /invalid/)
})

test('seal: 32 writers and a 40-character name fit the box, 33 writers do not', (t) => {
  const { key, seal } = setup()
  const writers = Array.from({ length: 32 }, () => ({ group: hex32(), writer: hex32() }))
  const name = 'é'.repeat(40)
  const record = seal({ v: 1, id: hex32(), name, on: true, writers })
  t.ok(b4a.from(record.box, 'base64').byteLength <= MAX_DEVICE_BOX)
  t.ok(validRecordCopy(record, 1), 'valid at the cap')
  t.ok(devices.openDevice(record, key))
  t.exception.all(() => devices.sealDevice({ v: 1, id: hex32(), name, on: true, writers: [...writers, { group: hex32(), writer: hex32() }] }, key), /invalid/)
})

test('foldDevices: last name, final off, union of writers, first at', (t) => {
  const { key, seal } = setup()
  const id = hex32()
  const a = { group: hex32(), writer: hex32() }
  const b = { group: hex32(), writer: hex32() }
  const fold = devices.foldDevices(diary([
    seal({ v: 1, id, name: 'Um', on: true, writers: [a] }, 1),
    seal({ v: 1, id, name: null, on: true, writers: [a, b] }, 2),
    seal({ v: 1, id, name: 'Dois', on: false, writers: [] }, 3),
    seal({ v: 1, id, name: null, on: true, writers: [] }, 4),
    { type: 'device', nonce: 'x', box: 'y', at: at(5) }
  ]), key)
  const d = fold.byId.get(id)
  t.is(d.name, 'Dois')
  t.is(d.on, false, 'off is final')
  t.alike(d.writers, [a, b])
  t.is(d.since, at(1))
  t.is(fold.byId.size, 1)
})

test('helloPlan: registers once, never renames, maps missing writers, skips roots and cut writers', (t) => {
  const { key, seal } = setup()
  const id = hex32()
  const root = hex32()
  const a = { group: hex32(), writer: hex32() }
  const b = { group: hex32(), writer: hex32() }
  const cutPair = { group: hex32(), writer: hex32() }
  const own = [a, { group: root, writer: root }, cutPair]
  const cuts = devices.cutMarks(diary([groupCutRecord({ group: cutPair.group, writer: cutPair.writer, cut: 3 })]))

  // A device whose cut writer is not its current one is not off.
  const fresh = devices.helloPlan({ fold: devices.foldDevices([], key), self: null, id, name: 'Celular', own: [a, { group: root, writer: root }], cuts: new Map() })
  t.is(fresh.off, false)
  t.alike(fresh.records, [{ v: 1, id, name: 'Celular', on: true, writers: [a] }], 'no root')

  const entries = diary([seal({ v: 1, id, name: 'Celular', on: true, writers: [a] })])
  const fold = devices.foldDevices(entries, key)
  const same = devices.helloPlan({ fold, self: id, id, name: 'Outro nome', own: [a], cuts: new Map() })
  t.alike(same.records, [], 'no rename, nothing missing')
  const more = devices.helloPlan({ fold, self: id, id, name: 'Outro nome', own: [a, b], cuts: new Map() })
  t.alike(more.records, [{ v: 1, id, name: null, on: true, writers: [b] }], 'only the missing writer, no name')

  const unnamed = devices.foldDevices(diary([seal({ v: 1, id, name: null, on: true, writers: [a] })]), key)
  t.alike(devices.helloPlan({ fold: unnamed, self: id, id, name: 'Celular', own: [a], cuts: new Map() }).records,
    [{ v: 1, id, name: 'Celular', on: true, writers: [] }], 'a name only while the id has none')

  const withCut = devices.helloPlan({ fold, self: id, id, name: 'x', own: own.slice(0, 2), cuts })
  t.alike(withCut.records, [], 'the cut pair is not this device\'s current writer here')
})

test('selfOff: no id and a cut current writer is disconnected; hello registers nothing', (t) => {
  const { key } = setup()
  const a = { group: hex32(), writer: hex32() }
  const cuts = devices.cutMarks(diary([groupCutRecord({ group: a.group, writer: a.writer, cut: 0 })]))
  const fold = devices.foldDevices([], key)
  t.is(devices.selfOff({ fold, self: null, own: [a], cuts }), true)
  t.alike(devices.helloPlan({ fold, self: null, id: hex32(), name: 'Celular', own: [a], cuts }), { off: true, records: [] })
  t.is(devices.listView({ fold, self: null, linked: [], cuts, own: [a] }).off, true)
  t.alike(devices.disconnectPlan({ fold, self: null, previous: true, linked: [], own: [a], cuts }), { error: devices.OFF_REFUSED })
  // A root is never a device writer: a cut root alone does not disconnect.
  const r = hex32()
  const rootCuts = devices.cutMarks(diary([groupCutRecord({ group: r, writer: r, cut: 1 })]))
  t.is(devices.selfOff({ fold, self: null, own: [{ group: r, writer: r }], cuts: rootCuts }), false)
})

test('selfOff: an id the fold turned off', (t) => {
  const { key, seal } = setup()
  const id = hex32()
  const fold = devices.foldDevices(diary([
    seal({ v: 1, id, name: 'Celular', on: true, writers: [] }),
    seal({ v: 1, id, name: null, on: false, writers: [] })
  ]), key)
  t.is(devices.selfOff({ fold, self: id, own: [], cuts: new Map() }), true)
  t.alike(devices.helloPlan({ fold, self: id, id, name: 'Celular', own: [], cuts: new Map() }), { off: true, records: [] })
  t.alike(devices.disconnectPlan({ fold, self: id, id: hex32(), linked: [], own: [] }), { error: devices.OFF_REFUSED })
})

test('copyView: on devices registered after this one, inside the window', (t) => {
  const { key, seal } = setup()
  const [old, self, mid, gone, late] = [hex32(), hex32(), hex32(), hex32(), hex32()]
  const fold = devices.foldDevices(diary([
    seal({ v: 1, id: old, name: 'Antigo', on: true, writers: [] }, 1),
    seal({ v: 1, id: self, name: 'Este', on: true, writers: [] }, 2),
    seal({ v: 1, id: mid, name: 'Tablet', on: true, writers: [] }, 3),
    seal({ v: 1, id: gone, name: 'Perdido', on: true, writers: [] }, 4),
    seal({ v: 1, id: gone, name: null, on: false, writers: [] }, 5),
    seal({ v: 1, id: late, name: 'Novo', on: true, writers: [] }, 6),
    seal({ v: 1, id: old, name: null, on: true, writers: [] }, 7)
  ]), key)
  const now = Date.parse(at(9))
  const cuts = new Map()
  const view = (over = {}) => devices.copyView({ fold, self, own: [], cuts, now, windowMs: 60000, ...over })
  t.alike(view(), { self, off: false, targets: [mid, late] }, 'never an older device, this one or an off one')
  t.alike(view({ windowMs: 4000 }).targets, [late], 'registered before the window: left out')
  const lateAt = Date.parse(at(6))
  t.alike(view({ now: lateAt - devices.COPY_SINCE_SKEW_MS - 1, windowMs: 3600000 + 60000 }).targets, [mid], 'a first record dated more than the skew ahead: left out')
  t.alike(view({ now: lateAt - devices.COPY_SINCE_SKEW_MS, windowMs: 3600000 + 60000 }).targets, [mid, late], 'within the skew: still a target')
  t.alike(view({ self: old }).targets, [self, mid, late], 'a later record of an id keeps its first place')
  t.alike(view({ self: late }).targets, [], 'the newest device copies to nobody')
  t.alike(view({ self: null }), { self: null, off: false, targets: [] }, 'no id yet')
  t.alike(view({ self: hex32() }).targets, [], 'an id the diary does not hold yet')
  t.alike(view({ self: gone }), { self: gone, off: true, targets: [] }, 'a disconnected device copies to nobody')
})

test('reconnectPlan: only on a disconnected device, a new id with the uncut writers', (t) => {
  const { key, seal } = setup()
  const old = hex32()
  const id = hex32()
  const a = { group: hex32(), writer: hex32() }
  const b = { group: hex32(), writer: hex32() }
  const cuts = devices.cutMarks(diary([groupCutRecord({ group: a.group, writer: a.writer, cut: 2 })]))
  const off = devices.foldDevices(diary([seal({ v: 1, id: old, name: 'x', on: false, writers: [a] })]), key)
  t.alike(devices.reconnectPlan({ fold: off, self: old, id, name: 'Celular', own: [a, b], cuts }),
    { records: [{ v: 1, id, name: 'Celular', on: true, writers: [b] }] })
  t.alike(devices.reconnectPlan({ fold: devices.foldDevices([], key), self: null, id, name: 'Celular', own: [a], cuts }),
    { records: [{ v: 1, id, name: 'Celular', on: true, writers: [] }] }, 'no id, cut writer')
  const on = devices.foldDevices(diary([seal({ v: 1, id: old, name: 'x', on: true, writers: [] })]), key)
  t.alike(devices.reconnectPlan({ fold: on, self: old, id, name: 'Celular', own: [b], cuts: new Map() }), { error: devices.NOT_OFF })
  t.alike(devices.reconnectPlan({ fold: on, self: null, id, name: 'Celular', own: [b], cuts: new Map() }), { error: devices.NOT_OFF })
})

test('joinRecord: maps a new own writer once, never a root or an off id', (t) => {
  const { key, seal } = setup()
  const id = hex32()
  const a = { group: hex32(), writer: hex32() }
  const empty = devices.foldDevices([], key)
  t.alike(devices.joinRecord({ fold: empty, self: id, ...a }), { v: 1, id, name: null, on: true, writers: [a] })
  t.is(devices.joinRecord({ fold: empty, self: null, ...a }), null, 'no id')
  t.is(devices.joinRecord({ fold: empty, self: id, group: a.group, writer: a.group }), null, 'root')
  const mapped = devices.foldDevices(diary([seal({ v: 1, id, name: null, on: true, writers: [a] })]), key)
  t.is(devices.joinRecord({ fold: mapped, self: id, ...a }), null, 'already mapped')
  const off = devices.foldDevices(diary([seal({ v: 1, id, name: null, on: false, writers: [] })]), key)
  t.is(devices.joinRecord({ fold: off, self: id, ...a }), null, 'off id')
})

test('disconnectPlan: refusals, linked pairs only, never own writers, previous', (t) => {
  const { key, seal } = setup()
  const self = hex32()
  const lost = hex32()
  const mine = { group: hex32(), writer: hex32() }
  const l1 = { group: hex32(), writer: hex32() }
  const l2 = { group: hex32(), writer: hex32() }
  const old = { group: hex32(), writer: hex32() }
  const entries = diary([
    groupJoinRecord({ group: mine.group, writer: mine.writer, on: true }),
    groupJoinRecord({ group: l1.group, writer: l1.writer, on: true }),
    groupJoinRecord({ group: l2.group, writer: l2.writer, on: true }),
    groupJoinRecord({ group: l2.group, writer: l2.writer, on: false }),
    groupJoinRecord({ group: old.group, writer: old.writer, on: true }),
    seal({ v: 1, id: self, name: 'Este', on: true, writers: [mine] }),
    seal({ v: 1, id: lost, name: 'Perdido', on: true, writers: [l1, l2, mine] })
  ])
  const view = devices.deviceView(entries, key, self, [mine])
  t.is(view.off, false)
  const base = { fold: view.fold, self, linked: view.linked, own: [mine], cuts: view.cuts }
  t.alike(devices.disconnectPlan({ ...base, id: self }), { error: devices.SELF_REFUSED })
  t.alike(devices.disconnectPlan({ ...base, id: hex32() }), { error: devices.NOT_FOUND })
  t.alike(devices.disconnectPlan({ ...base, id: lost }), { pairs: [l1], off: lost }, 'l2 unlinked, mine kept')
  t.alike(devices.disconnectPlan({ ...base, previous: true }), { pairs: [old], off: null })

  const list = devices.listView(base)
  t.is(list.self, self)
  t.is(list.off, false)
  t.alike(list.devices.map((d) => [d.id, d.self, d.on, d.writers]), [[self, true, true, 1], [lost, false, true, 2]])
  t.alike(list.previous, { writers: 1 })

  const cuts = devices.cutMarks(diary([groupCutRecord({ group: l1.group, writer: l1.writer, cut: 4 })]))
  t.is(devices.alreadyCut(cuts, l1), true, 'a marked pair is never marked again')
  t.is(devices.alreadyCut(cuts, l2), false)
})

test('disconnectPlan: a pair another disconnect marked is never named again', (t) => {
  const { key, seal } = setup()
  const self = hex32()
  const lost = hex32()
  const mine = { group: hex32(), writer: hex32() }
  const w = { group: hex32(), writer: hex32() }
  const later = { group: hex32(), writer: hex32() }
  const kept = { group: hex32(), writer: hex32() }
  // A cut W at 100 ("Aparelhos anteriores"); then a new unmapped writer;
  // `lost` maps a writer some device already cut and one not cut.
  const entries = diary([
    groupJoinRecord({ group: mine.group, writer: mine.writer, on: true }),
    groupJoinRecord({ group: w.group, writer: w.writer, on: true }),
    groupCutRecord({ group: w.group, writer: w.writer, cut: 100 }),
    groupJoinRecord({ group: later.group, writer: later.writer, on: true }),
    groupJoinRecord({ group: kept.group, writer: kept.writer, on: true }),
    seal({ v: 1, id: self, name: 'Este', on: true, writers: [mine] }),
    seal({ v: 1, id: lost, name: 'Perdido', on: true, writers: [kept] }),
    groupCutRecord({ group: kept.group, writer: kept.writer, cut: 7 })
  ])
  const view = devices.deviceView(entries, key, self, [mine])
  const base = { fold: view.fold, self, linked: view.linked, own: [mine], cuts: view.cuts }
  t.alike(devices.listView(base).previous, { writers: 1 }, 'only the new writer is counted')
  t.alike(devices.disconnectPlan({ ...base, previous: true }), { pairs: [later], off: null }, 'W keeps its mark at 100')
  t.alike(devices.disconnectPlan({ ...base, id: lost }), { pairs: [], off: lost }, 'a marked writer of an id is not marked again')
})

// A device record whose box seals `plain` (any bytes) under `key`, built
// by hand so the box size and encoding are the test's.
function handRecord (seal, key, plain) {
  const nonce = rand32().subarray(0, 24)
  const box = b4a.alloc(plain.byteLength + 16)
  sodium.crypto_secretbox_easy(box, plain, nonce, key)
  return { ...seal({ v: 1, id: hex32(), name: null, on: true, writers: [] }), nonce: b4a.toString(nonce, 'base64'), box }
}

test('foldDevices: the box limit and canonical base64 hold at fold level', (t) => {
  const { key, seal } = setup()
  const id = hex32()
  const json = JSON.stringify({ v: 1, id, name: 'Tablet', on: true, writers: [] })
  // JSON allows trailing blanks: the inner object stays valid at any size.
  const padded = (boxBytes) => b4a.from(json + ' '.repeat(boxBytes - 16 - json.length), 'utf8')
  const at = (box) => [{ seq: 1, record: box }]
  const fits = handRecord(seal, key, padded(MAX_DEVICE_BOX))
  t.ok(devices.foldDevices(at({ ...fits, box: b4a.toString(fits.box, 'base64') }), key).byId.has(id), 'a box of 8192 bytes is read')
  const over = handRecord(seal, key, padded(MAX_DEVICE_BOX + 1))
  t.is(devices.foldDevices(at({ ...over, box: b4a.toString(over.box, 'base64') }), key).byId.size, 0, 'a box of 8193 bytes is not')

  const small = handRecord(seal, key, b4a.from(json, 'utf8'))
  const canonical = b4a.toString(small.box, 'base64')
  t.ok(devices.foldDevices(at({ ...small, box: canonical }), key).byId.has(id))
  t.ok(canonical.endsWith('='), 'the box needs padding')
  const variants = [
    canonical.replace(/=+$/, ''),
    canonical.slice(0, 8) + '\n' + canonical.slice(8),
    canonical.replace(/\+/g, '-').replace(/\//g, '_') + (/[+/]/.test(canonical) ? '' : ' ')
  ]
  for (const box of variants) t.is(devices.foldDevices(at({ ...small, box }), key).byId.size, 0, 'non-canonical base64 is not read')
})

test('foldDevices, linkedPairs and cutMarks never throw on hostile entries', (t) => {
  const { key, seal } = setup()
  const id = hex32()
  const good = { seq: 50, record: seal({ v: 1, id, name: 'Bom', on: true, writers: [] }) }
  const boom = () => { throw new Error('boom') }
  const trap = new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom })
  const hostile = [
    null, undefined, 0, 'device', [], [good.record], trap,
    { seq: 1, record: trap },
    { seq: 2, get record () { throw new Error('boom') } },
    { get seq () { throw new Error('boom') }, record: good.record },
    { seq: '3', record: good.record },
    { seq: 4.5, record: good.record },
    { seq: -1, record: good.record },
    { seq: 5, record: { get type () { throw new Error('boom') } } },
    { seq: 6, record: { type: 'device', get nonce () { throw new Error('boom') }, box: good.record.box } },
    { seq: 7, record: { ...good.record, box: 42 } },
    { seq: 8, record: { ...good.record, nonce: null } },
    { seq: 9, record: { type: 'group-join', get group () { throw new Error('boom') } } },
    { seq: 10, record: { type: 'group-cut', group: trap, writer: [], cut: '1' } },
    { seq: 11, record: new Proxy({ type: 'device' }, { get: (o, k) => (k === 'type' ? 'device' : boom()) }) },
    good
  ]
  for (const entries of [hostile, trap, 'x', null, new Proxy([good], { get: boom })]) {
    let fold = null
    t.execution(() => { fold = devices.foldDevices(entries, key) })
    t.ok(fold !== null && fold.byId instanceof Map)
    t.execution(() => devices.linkedPairs(entries))
    t.execution(() => devices.cutMarks(entries))
    t.execution(() => devices.deviceView(entries, key, null, []))
  }
  t.ok(devices.foldDevices(hostile, key).byId.has(id), 'the valid entry still counts')
  t.is(devices.foldDevices(hostile, b4a.alloc(31)).byId.size, 0, 'a wrong key reads nothing')
})
