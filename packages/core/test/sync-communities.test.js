'use strict'

// Member sync of communities, protocol v2 (docs/protocol.md section 10,
// "Member sync", parent paging): the community a held group root names is
// paged like a group (its root and its community writers, CWs, gated like
// group writers, with their binding diaries), and the roots of its
// catalogue are paged root only.
const test = require('brittle')
const b4a = require('b4a')
const { testnet } = require('./helpers/net')
const { generateAssociationKeyPair, createCert } = require('../lib/cert')
const { groupHeader, writerHeader, groupCreateRecord } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const { hex, syncOnce, stored, fakeSeeder, groupMember, copyInto } = require('./helpers/sync-groups')

const put = (core, record) => core.append(b4a.from(JSON.stringify(record)))

async function diary (cs, kp, name) {
  const d = cs.get({ name })
  await d.ready()
  await put(d, memberCertRecord(createCert({ member: hex(d.key) }, kp)))
  return { d, dkey: hex(d.key) }
}

// In the fake seeder's store: a creator diary D, a community root C bound
// by D (unless `unbound`), a group G of C with D's join, `cws` CWs of other
// diaries, and a catalogue group G2 whose create C's root holds. `parent`
// replaces the community G names (a group root when 'group'). Pages list
// each key's cores; `pageSize` splits C's page with a cursor.
async function fixture (t, bootstrap, kp, { cws = 1, unbound = false, parent = 'community', pageSize = 0 } = {}) {
  const pages = new Map()
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: ({ group, after }) => {
      const all = (pages.get(group) || []).filter((it) => after === null || it.key > after)
      if (pageSize === 0 || all.length <= pageSize) return { items: all, next: null, incomplete: false }
      const out = all.slice(0, pageSize)
      return { items: out, next: out[out.length - 1].key, incomplete: false }
    }
  })
  const cs = fake.store
  const { d, dkey } = await diary(cs, kp, 'creator')
  const c = cs.get({ name: 'community' })
  await c.ready()
  const ckey = hex(c.key)
  const g = cs.get({ name: 'group' })
  await g.ready()
  const gkey = hex(g.key)
  const g2 = cs.get({ name: 'group-2' })
  await g2.ready()
  const g2key = hex(g2.key)
  if (parent === 'group') await put(c, groupHeader({ diary: dkey, community: g2key, member: g2key, name: 'Outro grupo' }))
  else await put(c, groupHeader({ kind: 'community', diary: dkey, name: 'Comunidade' }))
  let cseq = 1 // a wrong join seq when unbound
  if (!unbound) {
    cseq = d.length
    await put(d, groupJoinRecord({ group: ckey, writer: ckey, on: true }))
  }
  const rootItems = [{ key: ckey, diary: dkey, length: 0, seq: cseq }]
  await put(g, groupHeader({ diary: dkey, community: ckey, member: ckey, name: 'Geral' }))
  const gseq = d.length
  await put(d, groupJoinRecord({ group: gkey, writer: gkey, on: true }))
  await put(g2, groupHeader({ diary: dkey, community: ckey, member: ckey, name: 'Horta' }))
  const g2seq = d.length
  await put(d, groupJoinRecord({ group: g2key, writer: g2key, on: true }))
  if (parent === 'community') {
    await put(c, groupCreateRecord({ group: gkey }))
    await put(c, groupCreateRecord({ group: g2key }))
  }
  rootItems[0].length = c.length
  const cwKeys = []
  const diaries = []
  const cwItems = []
  for (let i = 0; i < cws; i++) {
    const e = await diary(cs, kp, 'member-' + i)
    const w = cs.get({ name: 'cw-' + i })
    await w.ready()
    const wkey = hex(w.key)
    await put(w, writerHeader({ group: ckey, diary: e.dkey, member: null }))
    const seq = e.d.length
    await put(e.d, groupJoinRecord({ group: ckey, writer: wkey, on: true }))
    cwItems.push({ key: wkey, diary: e.dkey, length: w.length, seq })
    cwKeys.push(wkey)
    diaries.push(e.dkey)
  }
  pages.set(ckey, [...rootItems, ...cwItems].sort((x, y) => x.key < y.key ? -1 : 1))
  pages.set(gkey, [{ key: gkey, diary: dkey, length: g.length, seq: gseq }])
  pages.set(g2key, [{ key: g2key, diary: dkey, length: g2.length, seq: g2seq }])
  return { fake, cs, d, dkey, c, ckey, g, gkey, g2key, cwKeys, diaries, pages }
}

test('a once run replicates the parent community, its CWs and their binding diaries, and the catalogue roots', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { fake, ckey, gkey, g2key, cwKeys, diaries, dkey, pages } = await fixture(t, bootstrap, kp)
  // A writer listed with the catalogue root is never fetched: catalogue
  // roots are paged root only.
  const stray = cwKeys[0]
  pages.get(g2key).push({ key: 'ff'.repeat(32), diary: dkey, length: 1, seq: 1 })
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.some((r) => r.group === ckey), 'the parent was paged')
  t.ok(await stored(m, ckey), 'community root stored')
  t.ok(await stored(m, stray), 'the CW is stored')
  t.ok(await stored(m, diaries[0]), 'the CW binding diary is stored')
  t.ok(await stored(m, dkey), 'creator diary stored')
  t.ok(events.some((ev) => ev.event === 'community-parent' && ev.key === ckey && ev.group === gkey), 'community-parent names C and G')
  t.is(events.filter((ev) => ev.event === 'community-parent').length, 1, 'once per community')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === stray && ev.group === ckey), 'CW growth reported under C')
  t.ok(fake.requests.some((r) => r.group === g2key), 'the catalogue root was paged')
  t.ok(await stored(m, g2key), 'catalogue root stored')
  t.absent(await stored(m, 'ff'.repeat(32)), 'a writer listed with a catalogue root is never fetched')
})

test('a community root its creator diary does not bind is not fetched', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { gkey, ckey } = await fixture(t, bootstrap, kp, { unbound: true })
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(await stored(m, gkey), 'the group root is fetched')
  const skipped = events.find((ev) => ev.event === 'group-skipped' && ev.key === ckey)
  t.is(skipped && skipped.reason, 'unbound')
  t.absent(await stored(m, ckey), 'the unbound community root never enters the main store')
})

test('the CWs of a community are paged across cursor pages', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { fake, gkey, ckey, cwKeys } = await fixture(t, bootstrap, kp, { cws: 5, pageSize: 2 })
  const m = await groupMember(t, kp, gkey)
  const { result } = await syncOnce(bootstrap, m, { gateTimeoutMs: 10000, timeoutMs: 90000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.filter((r) => r.group === ckey).length >= 3, 'C was paged with its cursor')
  for (const key of cwKeys) t.ok(await stored(m, key), 'CW ' + key.slice(0, 8) + ' stored')
})

test('a community is still fetched while the group root is held locally and no seeder lists it', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { fake, cs, g, gkey, ckey, pages } = await fixture(t, bootstrap, kp)
  pages.delete(gkey)
  const m = await groupMember(t, kp, gkey)
  await copyInto(cs, m, [g])
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.some((r) => r.group === ckey), 'the parent is paged')
  t.ok(await stored(m, ckey), 'and stored')
  t.ok(events.some((ev) => ev.event === 'community-parent' && ev.key === ckey))
})

test('a parent whose root is a group header is refused as the node\'s own verdict', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { gkey, ckey } = await fixture(t, bootstrap, kp, { parent: 'group' })
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  const skipped = events.find((ev) => ev.event === 'group-skipped' && ev.key === ckey)
  t.is(skipped && skipped.reason, 'not-community', 'judged by its own block 0, never as a bad header from the seeder')
  t.absent(await stored(m, ckey))
  t.ok(await stored(m, gkey), 'the group root still arrives')
})

test('a writer with a member under a community, or a group writer without one, is refused as header-invalid', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { cs, gkey, ckey, pages, d, dkey } = await fixture(t, bootstrap, kp)
  const bad = cs.get({ name: 'bad-cw' })
  await bad.ready()
  const bkey = hex(bad.key)
  await put(bad, writerHeader({ group: ckey, diary: dkey, member: ckey }))
  const seq = d.length
  await put(d, groupJoinRecord({ group: ckey, writer: bkey, on: true }))
  pages.get(ckey).push({ key: bkey, diary: dkey, length: 1, seq })
  pages.get(ckey).sort((x, y) => x.key < y.key ? -1 : 1)
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  const skipped = events.find((ev) => ev.event === 'group-skipped' && ev.key === bkey)
  t.is(skipped && skipped.reason, 'header-invalid')
  t.absent(await stored(m, bkey))
})

test('the fold\'s catalogue is paged: with 33 root creates the 32 counted groups are fetched', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const pages = new Map()
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: ({ group }) => ({ items: pages.get(group) || [], next: null, incomplete: false })
  })
  const cs = fake.store
  const { d, dkey } = await diary(cs, kp, 'creator')
  const c = cs.get({ name: 'community' })
  await c.ready()
  const ckey = hex(c.key)
  await put(c, groupHeader({ kind: 'community', diary: dkey, name: 'Comunidade' }))
  const cseq = d.length
  await put(d, groupJoinRecord({ group: ckey, writer: ckey, on: true }))
  // 33 creator roots, each created in C's root: the fold counts the first
  // 32 (the 32nd is the last slot) and leaves the 33rd an orphan.
  const roots = []
  for (let i = 0; i < 33; i++) {
    const r = cs.get({ name: 'root-' + i })
    await r.ready()
    const rkey = hex(r.key)
    await put(r, groupHeader({ diary: dkey, community: ckey, member: ckey, name: 'Grupo ' + i }))
    const rseq = d.length
    await put(d, groupJoinRecord({ group: rkey, writer: rkey, on: true }))
    await put(c, groupCreateRecord({ group: rkey }))
    pages.set(rkey, [{ key: rkey, diary: dkey, length: r.length, seq: rseq }])
    roots.push(rkey)
  }
  pages.set(ckey, [{ key: ckey, diary: dkey, length: c.length, seq: cseq }])
  const m = await groupMember(t, kp, roots[0])
  const { result } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000, timeoutMs: 90000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(await stored(m, roots[31]), 'the 32nd group, in the fold\'s catalogue, is fetched')
  t.ok(await stored(m, roots[1]), 'and so are the others it counts')
})
