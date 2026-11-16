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
  t.is(devices.alreadyCut(cuts, l1, 4), true)
  t.is(devices.alreadyCut(cuts, l1, 5), true)
  t.is(devices.alreadyCut(cuts, l1, 3), false, 'a lower held length marks again')
  t.is(devices.alreadyCut(cuts, l2, 9), false)
})
