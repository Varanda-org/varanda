'use strict'

// Member sync of community roots (docs/protocol.md section 10
// "Communities"): every community a group root's community-link records
// ever named (on or off) is paged, gated through the root path and fetched
// with its creator diary, up to 32 keys per group root in order of first
// appearance.
const test = require('brittle')
const b4a = require('b4a')
const { testnet } = require('./helpers/net')
const { generateAssociationKeyPair, createCert } = require('../lib/cert')
const { groupHeader, groupLink, communityLink, writerHeader } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const { hex, syncOnce, stored, fakeSeeder, groupMember } = require('./helpers/sync-groups')

const put = (core, record) => core.append(b4a.from(JSON.stringify(record)))

// In the fake seeder's store: a creator diary D, a group root G linking to
// `links` communities (in order, all on), and one community root per link,
// each bound by D unless listed in `unbound`. Pages list each root as the
// only core of its key, with the seq of D's join (or a wrong one). Indices
// in `off` are unlinked again after every link; those in `groupRoots` hold
// a group header instead of a community one.
async function fixture (t, bootstrap, kp, { links = 1, unbound = [], off = [], groupRoots = [] } = {}) {
  const pages = new Map()
  const fake = await fakeSeeder(t, bootstrap, kp, [], {
    answer: ({ group }) => ({ items: pages.get(group) || [], next: null, incomplete: false })
  })
  const cs = fake.store
  const d = cs.get({ name: 'creator' })
  await d.ready()
  const dkey = hex(d.key)
  await put(d, memberCertRecord(createCert({ member: dkey }, kp)))
  const g = cs.get({ name: 'group' })
  await g.ready()
  const gkey = hex(g.key)
  await put(d, groupJoinRecord({ group: gkey, writer: gkey, on: true }))
  await put(g, groupHeader({ diary: dkey, name: 'Grupo' }))
  const communities = []
  for (let i = 0; i < links; i++) {
    const c = cs.get({ name: 'community-' + i })
    await c.ready()
    const ckey = hex(c.key)
    if (groupRoots.includes(i)) {
      await put(c, groupHeader({ diary: dkey, name: 'Outro grupo ' + i }))
    } else {
      await put(c, groupHeader({ kind: 'community', diary: dkey, name: 'Comunidade ' + i }))
      await put(c, groupLink({ group: gkey, on: true }))
    }
    let seq = 1 // the group's join: names another root
    if (!unbound.includes(i)) {
      seq = d.length
      await put(d, groupJoinRecord({ group: ckey, writer: ckey, on: true }))
    }
    await put(g, communityLink({ community: ckey, on: true }))
    pages.set(ckey, [{ key: ckey, diary: dkey, length: c.length, seq }])
    communities.push(ckey)
  }
  for (const i of off) await put(g, communityLink({ community: communities[i], on: false }))
  pages.set(gkey, [{ key: gkey, diary: dkey, length: g.length, seq: 1 }])
  return { fake, d, dkey, gkey, communities, pages }
}

test('a once run replicates the linked community root and its creator diary', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { fake, d, dkey, gkey, communities, pages } = await fixture(t, bootstrap, kp)
  const [ckey] = communities
  // A writer bound to the community by the same diary: a community has no
  // writers, so the listing is never gated.
  const w = fake.store.get({ name: 'stray' })
  await w.ready()
  const wkey = hex(w.key)
  const seq = d.length
  await put(d, groupJoinRecord({ group: ckey, writer: wkey, on: true }))
  await put(w, writerHeader({ group: ckey, diary: dkey }))
  pages.get(ckey).push({ key: wkey, diary: dkey, length: 1, seq })
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.some((r) => r.group === ckey), 'the community was paged')
  t.ok(await stored(m, ckey), 'community root stored')
  t.ok(await stored(m, dkey), 'creator diary stored')
  t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === ckey && ev.group === ckey), 'growth reported for the community root')
  t.ok(events.some((ev) => ev.event === 'community-linked' && ev.key === ckey && ev.group === gkey))
  t.absent(await stored(m, wkey), 'a writer listed under a community is never fetched')
})

test('a community root its creator diary does not bind is not fetched', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { gkey, communities } = await fixture(t, bootstrap, kp, { unbound: [0] })
  const [ckey] = communities
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(await stored(m, gkey), 'the group root is fetched')
  const skipped = events.find((ev) => ev.event === 'group-skipped' && ev.key === ckey)
  t.is(skipped && skipped.reason, 'unbound')
  t.absent(await stored(m, ckey), 'the unbound community root never enters the main store')
})

test('a group root naming more than 32 communities makes the node page only the first 32', async (t) => {
  t.timeout(110000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { fake, gkey, communities } = await fixture(t, bootstrap, kp, { links: 33 })
  const m = await groupMember(t, kp, gkey)
  const { result } = await syncOnce(bootstrap, m, { gateTimeoutMs: 10000, timeoutMs: 90000 })
  t.ok(result.ok, result.errors.join('; '))
  const paged = new Set(fake.requests.map((r) => r.group))
  t.alike([...paged].sort(), [gkey, ...communities.slice(0, 32)].sort(), 'the group and its first 32 communities are paged')
  t.ok(await stored(m, communities[0]))
  t.ok(await stored(m, communities[31]))
  t.absent(await stored(m, communities[32]), 'a key past the cap is never fetched')
})

test('a community the group root unlinked is still fetched', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { fake, gkey, communities } = await fixture(t, bootstrap, kp, { links: 2, off: [0] })
  const m = await groupMember(t, kp, gkey)
  const { result } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.some((r) => r.group === communities[0]), 'the unlinked community is paged')
  t.ok(await stored(m, communities[0]), 'acts from while it was linked stay readable')
  t.ok(await stored(m, communities[1]))
})

test('a community-link naming a group root is refused as the node\'s own verdict', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const { gkey, communities } = await fixture(t, bootstrap, kp, { links: 2, groupRoots: [0] })
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  const skipped = events.find((ev) => ev.event === 'group-skipped' && ev.key === communities[0])
  t.is(skipped && skipped.reason, 'not-community', 'judged by its own block 0, never as a bad header from the seeder')
  t.absent(await stored(m, communities[0]))
  t.ok(await stored(m, communities[1]), 'the real community still arrives')
})
