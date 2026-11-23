'use strict'

// Member sync of standalone groups (lib/sync.js, docs/protocol.md section 10):
// a v2 group root naming neither a community nor a member is paged like any
// joined group, names no parent, and its writers name member = G (the root
// key). Under a role that wants a community it stays this node's own verdict
// 'not-community'; named by a community catalogue it is paged root only.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { groupHeader, writerHeader, groupPost, groupCreateRecord, validateGroupHeader } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const { hex, syncOnce, stored, heldCopy, fakeSeeder, groupMember, copyInto } = require('./helpers/sync-groups')

const put = (core, record) => core.append(b4a.from(JSON.stringify(record)))
const box = () => hex(crypto.randomBytes(32))
const sorted = (items) => items.sort((x, y) => x.key < y.key ? -1 : 1)
const skipped = (events, key) => events.filter((ev) => ev.event === 'group-skipped' && ev.key === key).map((ev) => ev.reason)
const parentEvents = (events) => events.filter((ev) => ev.event === 'group-parent' || ev.event === 'community-parent')

async function diary (cs, kp, name) {
  const d = cs.get({ name })
  await d.ready()
  await put(d, memberCertRecord(createCert({ member: hex(d.key) }, kp)))
  return { d, dkey: hex(d.key) }
}

// A writer of `group` bound by a fresh diary's join, with `header` fields
// and `posts` posts, as a page item.
async function boundWriter (cs, kp, group, name, fields, posts = 0) {
  const e = await diary(cs, kp, 'diary-' + name)
  const w = cs.get({ name: 'writer-' + name })
  await w.ready()
  const wkey = hex(w.key)
  await put(w, writerHeader({ group, diary: e.dkey, ...fields }))
  for (let i = 0; i < posts; i++) await put(w, groupPost({ text: name + ' ' + i }))
  const seq = e.d.length
  await put(e.d, groupJoinRecord({ group, writer: wkey, on: true }))
  return { key: wkey, diary: e.dkey, length: w.length, seq }
}

// In `cs`: a creator diary D, a standalone root S it binds (`visibility`),
// and two writers of S: `named` names member = S and `bare` names no member
// (public), or `boxed` has a box and `boxless` none (private). `creator`
// reuses a diary already in `cs` as D.
async function standalone (cs, kp, { visibility = 'public', creator = null } = {}) {
  const { d, dkey } = creator || await diary(cs, kp, 'creator')
  const root = cs.get({ name: 'standalone-' + visibility })
  await root.ready()
  const skey = hex(root.key)
  const header = visibility === 'private'
    ? groupHeader({ diary: dkey, visibility: 'private', join: 'approval', name: null, box: box() })
    : groupHeader({ diary: dkey, name: 'Praça', join: 'open' })
  await put(root, header)
  const rseq = d.length
  await put(d, groupJoinRecord({ group: skey, writer: skey, on: true }))
  const out = { d, dkey, header, root, skey, rootItem: { key: skey, diary: dkey, length: root.length, seq: rseq } }
  if (visibility === 'private') {
    out.boxed = await boundWriter(cs, kp, skey, 'boxed', { member: skey, box: box() }, 0)
    out.boxless = await boundWriter(cs, kp, skey, 'boxless', { member: skey }, 1)
  } else {
    out.named = await boundWriter(cs, kp, skey, 'named', { member: skey }, 2)
    out.bare = await boundWriter(cs, kp, skey, 'bare', { member: null }, 1)
  }
  return out
}

// A fake seeder whose page for each key is `pages.get(key)`.
async function pagedSeeder (t, bootstrap, kp, pages) {
  return fakeSeeder(t, bootstrap, kp, [], {
    answer: ({ group, after }) => ({ items: sorted((pages.get(group) || []).filter((it) => after === null || it.key > after)), next: null, incomplete: false })
  })
}

// A member in no group, as one that only holds pages.
async function bareMember (t, kp) {
  const dir = tmpDir(t, 'varanda-gsync-')
  store.writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
  const s = await store.openStore(dir)
  try {
    await store.openDiary(s)
  } finally {
    await s.close()
  }
  store.writeGroups(dir, [])
  return { dataDir: dir, groups: [] }
}

test('a joined standalone root is accepted, its writers naming it are held in full and one naming no member is a stub', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const pages = new Map()
  const fake = await pagedSeeder(t, bootstrap, kp, pages)
  const s = await standalone(fake.store, kp)
  t.is(validateGroupHeader(s.header), null, 'control: the root header names no community and is valid')
  t.is(s.header.community, null)
  t.is(s.header.member, null)
  pages.set(s.skey, [s.rootItem, s.named, s.bare])
  const m = await groupMember(t, kp, s.skey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.alike(skipped(events, s.skey), [], 'the root is never refused')
  t.ok(await stored(m, s.skey), 'the standalone root is stored')
  t.alike(skipped(events, s.named.key), [], 'the writer naming member = G is never refused')
  t.alike(await heldCopy(m, s.named.key), { contiguous: 3, held: [0, 1, 2] }, 'and is held in full')
  t.alike(skipped(events, s.bare.key), [], 'the writer naming no member is never refused')
  t.alike(await heldCopy(m, s.bare.key), { contiguous: 1, held: [0] }, 'but is a member mismatch: block 0 alone, though the seeder holds its post')
  t.alike(parentEvents(events), [], 'a standalone root names no parent')
  t.absent(fake.requests.some((r) => r.group !== s.skey), 'no other key is paged')
})

test('a standalone root bound by a held page is accepted under its unknown kind and names no parent', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const pages = new Map()
  const fake = await pagedSeeder(t, bootstrap, kp, pages)
  const s = await standalone(fake.store, kp)
  pages.set(s.skey, [s.rootItem, s.named])
  const m = await bareMember(t, kp)
  // The member holds the page diary D alone, which binds S.
  await copyInto(fake.store, m, [s.d])
  const { result, events } = await syncOnce(bootstrap, m, { pages: [s.dkey], gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(fake.requests.some((r) => r.group === s.skey), 'the page root is paged')
  t.alike(skipped(events, s.skey), [], 'the root is never refused')
  t.ok(await stored(m, s.skey), 'the standalone root is stored')
  t.alike(await heldCopy(m, s.named.key), { contiguous: 3, held: [0, 1, 2] }, 'its writer naming member = G is held in full')
  t.alike(parentEvents(events), [], 'a standalone root names no parent')
})

test('a standalone root a group names as its community is refused as the node\'s own verdict not-community', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const pages = new Map()
  const fake = await pagedSeeder(t, bootstrap, kp, pages)
  const s = await standalone(fake.store, kp)
  const g = fake.store.get({ name: 'child' })
  await g.ready()
  const gkey = hex(g.key)
  await put(g, groupHeader({ diary: s.dkey, community: s.skey, member: s.skey, name: 'Filho' }))
  const gseq = s.d.length
  await put(s.d, groupJoinRecord({ group: gkey, writer: gkey, on: true }))
  pages.set(gkey, [{ key: gkey, diary: s.dkey, length: g.length, seq: gseq }])
  pages.set(s.skey, [s.rootItem, s.named])
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(await stored(m, gkey), 'the group root arrives')
  t.ok(fake.requests.some((r) => r.group === s.skey), 'the standalone root is paged as the parent')
  t.alike(skipped(events, s.skey), ['not-community'], 'judged by its own block 0, never as a bad header from the seeder')
  t.absent(await stored(m, s.skey), 'the standalone root is not stored')
  // A writer listed under a key paged as a community that names a member
  // is a member mismatch (memberMismatch), as under any parent whose root is
  // refused: block 0 at most, never its posts.
  const w = (await stored(m, s.named.key)) ? await heldCopy(m, s.named.key) : null
  t.ok(w === null || (w.held.length === 1 && w.held[0] === 0), 'its writer is never held past block 0: ' + JSON.stringify(w))
})

test('a standalone root a community catalogue names is paged root only and never becomes a child', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const pages = new Map()
  const fake = await pagedSeeder(t, bootstrap, kp, pages)
  const cs = fake.store
  const creator = await diary(cs, kp, 'creator')
  const { d, dkey } = creator
  const c = cs.get({ name: 'community' })
  await c.ready()
  const ckey = hex(c.key)
  await put(c, groupHeader({ kind: 'community', diary: dkey, name: 'Comunidade' }))
  const cseq = d.length
  await put(d, groupJoinRecord({ group: ckey, writer: ckey, on: true }))
  const g = cs.get({ name: 'geral' })
  await g.ready()
  const gkey = hex(g.key)
  await put(g, groupHeader({ diary: dkey, community: ckey, member: ckey, name: 'Geral' }))
  const gseq = d.length
  await put(d, groupJoinRecord({ group: gkey, writer: gkey, on: true }))
  const s = await standalone(cs, kp, { creator })
  // C's root names S in a create, as a community never should.
  await put(c, groupCreateRecord({ group: gkey }))
  await put(c, groupCreateRecord({ group: s.skey }))
  pages.set(ckey, [{ key: ckey, diary: dkey, length: c.length, seq: cseq }])
  pages.set(gkey, [{ key: gkey, diary: dkey, length: g.length, seq: gseq }])
  pages.set(s.skey, [s.rootItem, s.named])
  const m = await groupMember(t, kp, gkey)
  const { result, events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000 })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(await stored(m, ckey), 'the parent community is stored')
  t.ok(fake.requests.some((r) => r.group === s.skey), 'the catalogue root is paged')
  t.alike(skipped(events, s.skey), [], 'it is never refused')
  t.ok(await stored(m, s.skey), 'its root is stored')
  t.absent(await stored(m, s.named.key), 'its writer is never fetched: a catalogue root is paged root only')
  t.ok(events.some((ev) => ev.event === 'group-parent' && ev.key === ckey && ev.group === gkey), 'control: G names C')
  t.absent(parentEvents(events).some((ev) => ev.key === s.skey || ev.group === s.skey), 'S is never a parent or a child')
  t.alike(store.readGroups(m.dataDir).map((x) => x.group), [gkey], 'and never a local group')
})

test('a private standalone root refuses its writer without a box and holds the boxed one', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const pages = new Map()
  const fake = await pagedSeeder(t, bootstrap, kp, pages)
  const s = await standalone(fake.store, kp, { visibility: 'private' })
  t.is(validateGroupHeader(s.header), null, 'control: a private standalone root header is valid')
  pages.set(s.skey, [s.rootItem, s.boxed, s.boxless])
  const m = await groupMember(t, kp, s.skey)
  const { events } = await syncOnce(bootstrap, m, { gateTimeoutMs: 5000, timeoutMs: 20000 })
  t.alike(skipped(events, s.skey), [], 'the private root is never refused')
  t.ok(await stored(m, s.skey), 'the private root is stored')
  t.ok(await stored(m, s.boxed.key), 'the boxed writer is stored')
  t.alike(skipped(events, s.boxless.key), ['header-invalid'], 'the boxless writer is header-invalid')
  t.absent(await stored(m, s.boxless.key), 'and is not stored')
  t.alike(parentEvents(events), [], 'a standalone root names no parent')
})
