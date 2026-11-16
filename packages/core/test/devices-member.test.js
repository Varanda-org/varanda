'use strict'

// Connected devices on the node (docs/rpc.md 5.151 to 5.154): member.js
// over a real data dir. Another device of the account is simulated by
// appending its records to the own diary.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const member = require('../lib/member')
const store = require('../lib/store')
const devices = require('../lib/devices')
const { groupJoinRecord, groupCutRecord } = require('../lib/records')
const { hex, person, createGroup, joinGroup, exchange } = require('./helpers/private-member')

const rand = () => hex(crypto.randomBytes(32))

// fn({ diary, key, entries }) on the own diary, `key` the device key.
async function onDiary (ctx, fn) {
  return member.withIdentity(ctx, async ({ diary }) => {
    const key = devices.deviceKey(diary.keyPair.secretKey, diary.key)
    try {
      return await fn({ diary, key, entries: await store.readAll(diary) })
    } finally {
      devices.wipeKey(key)
    }
  })
}

// Another device `id` of the account holding `pairs` (linked in the diary).
async function plantDevice (ctx, id, name, pairs) {
  await onDiary(ctx, async ({ diary, key }) => {
    for (const p of pairs) await store.appendRecord(diary, groupJoinRecord({ group: p.group, writer: p.writer, on: true }))
    if (id !== null) await store.appendRecord(diary, devices.sealedRecord({ v: 1, id, name, on: true, writers: pairs }, key))
  })
}

function cutsOf (entries) {
  return entries.filter((e) => e.record && e.record.type === 'group-cut').map((e) => ({ group: e.record.group, writer: e.record.writer, cut: e.record.cut }))
}

function deviceRecords (entries, key) {
  return entries.filter((e) => e.record && e.record.type === 'device').map((e) => devices.openDevice(e.record, key, e.seq))
}

test('hello registers once and never renames; list shows this device', async (t) => {
  const a = await person(t, crypto.keyPair(), 'Ana')
  const first = await member.deviceHello(a, { name: '  Celular  ' })
  t.ok(/^[0-9a-f]{64}$/.test(first.id))
  t.alike(first, { id: first.id, registered: true, off: false })
  const file = path.join(a.dataDir, 'device.json')
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, own: a.key, id: first.id })
  if (process.platform !== 'win32') t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.alike(await member.deviceHello(a, { name: 'Outro nome' }), { id: first.id, registered: false, off: false }, 'no rename')
  const list = await member.deviceList(a)
  t.is(list.self, first.id)
  t.is(list.off, false)
  t.is(list.previous, null)
  t.is(list.devices.length, 1)
  t.is(list.devices[0].name, 'Celular')
  t.is(list.devices[0].self, true)
  await t.exception(member.deviceHello(a, { name: '' }), /nome do aparelho inválido/)
  // The record is opaque: no name or id in clear.
  const raw = await onDiary(a, async ({ entries }) => JSON.stringify(entries.filter((e) => e.record && e.record.type === 'device')))
  t.absent(raw.includes('Celular'))
  t.absent(raw.includes(first.id))
})

test('a join of a non-root writer is mapped to this device; roots are not', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Praça', join: 'open' })
  const ha = await member.deviceHello(a, { name: 'Ana' })
  t.is((await member.deviceList(a)).devices[0].writers, 0, 'own roots are not device writers')
  t.ok(ha.registered)
  await member.deviceHello(b, { name: 'Bia' })
  await exchange(a, b)
  await joinGroup(b, { group })
  const own = store.readGroups(b.dataDir).filter((g) => g.writer !== g.group)
  t.ok(own.length >= 2, 'a CW and a group writer')
  const mapped = await onDiary(b, async ({ entries, key }) => deviceRecords(entries, key).flatMap((r) => r.writers))
  for (const g of own) t.ok(mapped.some((p) => p.group === g.group && p.writer === g.writer), 'mapped: ' + g.group.slice(0, 8))
  t.is((await member.deviceList(b)).devices[0].writers, own.length)
})

test('disconnect cuts the lost device at the held length, turns it off, then refuses', async (t) => {
  const a = await person(t, crypto.keyPair(), 'Ana')
  const { id: self } = await member.deviceHello(a, { name: 'Este' })
  const lost = rand()
  const w1 = { group: rand(), writer: rand() }
  const w2 = { group: w1.group, writer: rand() }
  const old = { group: rand(), writer: rand() }
  await plantDevice(a, lost, 'Perdido', [w1, w2])
  await plantDevice(a, null, null, [old])
  const before = await member.deviceList(a)
  t.alike(before.devices.map((d) => [d.name, d.on, d.writers]), [['Este', true, 0], ['Perdido', true, 2]])
  t.alike(before.previous, { writers: 1 })

  await t.exception(member.deviceDisconnect(a, { id: self }), new RegExp(devices.SELF_REFUSED))
  await t.exception(member.deviceDisconnect(a, { id: rand() }), new RegExp(devices.NOT_FOUND))
  t.alike(await member.deviceDisconnect(a, { id: lost }, { write: false }), { pairs: 2 })

  const r = await member.deviceDisconnect(a, { id: lost.toUpperCase() })
  t.alike(r, { cut: 2, empty: 2, groups: [w1.group] }, 'not held here: marked at 0')
  const after = await onDiary(a, async ({ entries, key }) => ({ cuts: cutsOf(entries), fold: devices.foldDevices(entries, key) }))
  t.alike(after.cuts, [{ ...w1, cut: 0 }, { ...w2, cut: 0 }])
  t.is(after.fold.byId.get(lost).on, false)
  await t.exception(member.deviceDisconnect(a, { id: lost }), new RegExp(devices.NOT_FOUND), 'an off device is not found')

  t.alike(await member.deviceDisconnect(a, { previous: true }), { cut: 1, empty: 1, groups: [old.group] })
  t.alike(await member.deviceDisconnect(a, { previous: true }), { cut: 0, empty: 0, groups: [] }, 'already marked')
  const list = await member.deviceList(a)
  t.is(list.previous, null)
  t.alike(list.devices.map((d) => [d.name, d.on, d.writers]), [['Este', true, 0], ['Perdido', false, 0]])
})

test('disconnect marks a held writer at its contiguous length', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Praça', join: 'open' })
  await exchange(a, b)
  await joinGroup(b, { group })
  await member.groupPost(b, { group, text: 'oi' })
  await exchange(b, a)
  const bw = store.readGroups(b.dataDir).find((g) => g.group === group)
  // Ana's diary links Bia's writer as if a lost device of Ana's held it.
  await member.deviceHello(a, { name: 'Ana' })
  const lost = rand()
  await plantDevice(a, lost, 'Perdido', [{ group, writer: bw.writer }])
  const held = await member.withIdentity(a, async ({ store: s }) => {
    const core = s.get({ key: b4a.from(bw.writer, 'hex'), writable: false, active: false })
    await core.ready()
    const n = core.contiguousLength
    await core.close()
    return n
  })
  t.ok(held >= 2, 'header and post held')
  t.alike(await member.deviceDisconnect(a, { id: lost }), { cut: 1, empty: 0, groups: [group] })
  const cuts = await onDiary(a, async ({ entries }) => cutsOf(entries))
  t.alike(cuts, [{ group, writer: bw.writer, cut: held }])
})

test('a repeated disconnect never lowers an earlier mark', async (t) => {
  const a = await person(t, crypto.keyPair(), 'Ana')
  await member.deviceHello(a, { name: 'Este' })
  // Another device cut old writer W at 100 and a writer of `lost` at 7;
  // this one holds neither (length 0 here).
  const w = { group: rand(), writer: rand() }
  const lost = rand()
  const kept = { group: rand(), writer: rand() }
  await plantDevice(a, null, null, [w])
  await plantDevice(a, lost, 'Perdido', [kept])
  await onDiary(a, async ({ diary }) => {
    await store.appendRecord(diary, groupCutRecord({ ...w, cut: 100 }))
    await store.appendRecord(diary, groupCutRecord({ ...kept, cut: 7 }))
  })
  const later = { group: rand(), writer: rand() }
  await plantDevice(a, null, null, [later])
  t.alike((await member.deviceList(a)).previous, { writers: 1 })

  t.alike(await member.deviceDisconnect(a, { previous: true }), { cut: 1, empty: 1, groups: [later.group] })
  t.alike(await member.deviceDisconnect(a, { id: lost }), { cut: 0, empty: 0, groups: [] })
  const after = await onDiary(a, async ({ entries, key }) => ({ marks: devices.cutMarks(entries), cuts: cutsOf(entries), fold: devices.foldDevices(entries, key) }))
  t.is(after.marks.get(devices.pairKey(w)), 100, 'W keeps the history the first device held')
  t.is(after.marks.get(devices.pairKey(kept)), 7)
  t.alike(after.cuts, [{ ...w, cut: 100 }, { ...kept, cut: 7 }, { ...later, cut: 0 }], 'no second mark on a marked pair')
  t.is(after.fold.byId.get(lost).on, false, 'the id is still turned off')
})

test('disconnect rotates the key of a private group this node distributes in', async (t) => {
  const a = await person(t, crypto.keyPair(), 'Ana')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await member.deviceHello(a, { name: 'Ana' })
  const before = await member.groupRead(a, { group })
  const lost = rand()
  await plantDevice(a, lost, 'Perdido', [{ group, writer: rand() }])
  t.alike(await member.deviceDisconnect(a, { id: lost }), { cut: 1, empty: 1, groups: [group] })
  const after = await member.groupRead(a, { group })
  t.ok(after.epoch !== null, 'an epoch')
  t.unlike(after.epoch, before.epoch, 'a new epoch after the cut')
})

test('no id and a cut current writer: off, hello registers nothing, only reconnect does', async (t) => {
  const a = await person(t, crypto.keyPair(), 'Ana')
  const mine = { group: rand(), writer: rand() }
  store.writeGroups(a.dataDir, [...store.readGroups(a.dataDir), { group: mine.group, writer: mine.writer, nonce: hex(crypto.randomBytes(16)) }])
  await plantDevice(a, null, null, [mine])
  await onDiary(a, ({ diary }) => store.appendRecord(diary, groupCutRecord({ group: mine.group, writer: mine.writer, cut: 0 })))

  t.alike(await member.deviceHello(a, { name: 'Celular' }), { id: null, registered: false, off: true })
  t.absent(fs.existsSync(path.join(a.dataDir, 'device.json')), 'no id created')
  const list = await member.deviceList(a)
  t.is(list.off, true)
  t.is(list.self, null)
  t.alike(list.devices, [])
  await t.exception(member.deviceDisconnect(a, { previous: true }), new RegExp(devices.OFF_REFUSED))
  t.alike(await member.deviceOff(a), { off: true })
  await t.exception(member.communityCreate(a, { name: 'Bairro', join: 'open' }), new RegExp(devices.OFF_REFUSED), 'no id: a create is refused too')

  const back = await member.deviceReconnect(a, { name: 'Celular' })
  t.ok(/^[0-9a-f]{64}$/.test(back.id))
  t.alike(back, { id: back.id, registered: true, off: false })
  const view = await member.deviceList(a)
  t.is(view.self, back.id)
  t.is(view.off, false)
  t.alike(view.devices.map((d) => [d.name, d.writers]), [['Celular', 0]], 'the cut writer is not mapped')
  await t.exception(member.deviceReconnect(a, { name: 'Celular' }), new RegExp(devices.NOT_OFF))
})

test('an id turned off by another device: hello off, disconnect refused, reconnect gives a new id', async (t) => {
  const a = await person(t, crypto.keyPair(), 'Ana')
  const { community, group: general } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { id } = await member.deviceHello(a, { name: 'Celular' })
  await onDiary(a, ({ diary, key }) => store.appendRecord(diary, devices.sealedRecord({ v: 1, id, name: null, on: false, writers: [] }, key)))
  t.alike(await member.deviceHello(a, { name: 'Celular' }), { id, registered: false, off: true })
  await t.exception(member.deviceDisconnect(a, { previous: true }), new RegExp(devices.OFF_REFUSED))

  // No join or create by hand either, and nothing is written.
  const length = await onDiary(a, async ({ entries }) => entries.length)
  await t.exception(member.communityJoin(a, { community }), new RegExp(devices.OFF_REFUSED))
  await t.exception(member.groupJoin(a, { group: general }), new RegExp(devices.OFF_REFUSED))
  await t.exception(member.groupJoin(a, { group: rand(), community }), new RegExp(devices.OFF_REFUSED), 'a group not held yet')
  await t.exception(member.groupCreate(a, { name: 'Feira', join: 'open', community }), new RegExp(devices.OFF_REFUSED))
  await t.exception(member.communityCreate(a, { name: 'Outro', join: 'open' }), new RegExp(devices.OFF_REFUSED))
  t.is(await onDiary(a, async ({ entries }) => entries.length), length, 'nothing written')
  const back = await member.deviceReconnect(a, { name: 'Celular de novo' })
  t.not(back.id, id)
  const list = await member.deviceList(a)
  t.alike(list.devices.map((d) => [d.name, d.on, d.self]), [['Celular de novo', true, true], ['Celular', false, false]])
})
