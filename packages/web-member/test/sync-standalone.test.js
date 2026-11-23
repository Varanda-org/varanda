'use strict'

// The browser's member sync and standalone groups (docs/protocol.md section
// 10): a v2 group root naming no community (`community` and `member` both
// null) is a group root with no parent. It is accepted where a group root
// is expected and wherever either kind may be, refused where a community
// is, and a bad hint when a catalogue was to name it. Its writers name the
// root itself (`member` = G); a writer naming none is refused once the root
// is known as a group, and a private one carries its box. Loopback only: the
// root and a member's writer travel through a real Seeder behind a
// WebSocket, and no community is paged for the root.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const grp = require('@varanda/core/lib/group')
const store = require('../lib/node-store')
const { groupVerdict, boxMismatch } = require('../lib/sync')
const { member, seederOverWs, admittedGroups, indexed, once, named, held } = require('./helpers/sync-groups')

const hex = (buf) => b4a.toString(buf, 'hex')
const key = () => hex(crypto.randomBytes(32))
const enc = (record) => b4a.from(JSON.stringify(record))

const ANY = { root: null, parent: false, within: null }
const AS_GROUP = { root: 'group', parent: false, within: null }
const AS_COMMUNITY = { root: 'community', parent: false, within: null }
const AS_PARENT = { root: 'community', parent: true, within: null }

const G = key()
const diary = key()
const writer = key()
const standalone = enc(grp.groupHeader({ diary, community: null, member: null, name: 'Horta', join: 'open' }))
const privateStandalone = enc(grp.groupHeader({ diary, community: null, member: null, visibility: 'private', join: 'approval', name: null, box: key() }))
const atG = enc(grp.writerHeader({ group: G, diary, member: G }))
const atNone = enc(grp.writerHeader({ group: G, diary, member: null }))
const boxedAtG = enc(grp.writerHeader({ group: G, diary, member: G, box: key() }))

test('a standalone root is a group root with no parent', (t) => {
  t.ok(grp.isStandaloneHeader(JSON.parse(b4a.toString(standalone))), 'the fixture is standalone')
  t.is(groupVerdict(standalone, G, G, diary), null, 'accepted when either kind may be (default)')
  t.is(groupVerdict(standalone, G, G, diary, ANY), null, 'accepted under ANY_ROOT')
  t.is(groupVerdict(standalone, G, G, diary, AS_GROUP), null, 'accepted where a group root is expected')
  t.is(groupVerdict(standalone, G, G, diary, AS_COMMUNITY), 'header-invalid', 'refused where a community is expected')
  t.is(groupVerdict(standalone, G, G, diary, AS_PARENT), 'not-community', 'refused as a parent community')
  t.is(groupVerdict(standalone, G, G, key(), AS_GROUP), 'wrong-diary', 'the hinted diary still binds')
})

test('a standalone root is a bad hint for a catalogue that was to name it', (t) => {
  const within = { root: 'group', parent: false, within: new Set([key()]) }
  t.is(groupVerdict(standalone, G, G, diary, within), 'wrong-group', 'no catalogue names a root with no parent')
})

test('a root naming a community without a member, or a member without a community, stays malformed', (t) => {
  const at = new Date().toISOString()
  const base = { type: 'group-header', v: 2, kind: 'group', diary, visibility: 'public', join: 'open', name: null, box: null, at }
  const onlyMember = enc({ ...base, community: null, member: key() })
  const onlyCommunity = enc({ ...base, community: key(), member: null })
  t.is(groupVerdict(onlyMember, G, G, diary), 'header-invalid', 'member without community')
  t.is(groupVerdict(onlyCommunity, G, G, diary), 'header-invalid', 'community without member')
  t.is(groupVerdict(onlyMember, G, G, diary, AS_GROUP), 'header-invalid')
})

test('a standalone writer names the root: member null is refused once the kind is known', (t) => {
  t.is(groupVerdict(atG, writer, G, diary, ANY, 'public', 'group'), null, 'member = G in a group')
  t.is(groupVerdict(atG, writer, G, diary), null, 'member = G, kind unknown')
  t.is(groupVerdict(atNone, writer, G, diary, ANY, 'public', 'group'), 'header-invalid', 'member null in a group')
  t.is(groupVerdict(atNone, writer, G, diary), null, 'kind unknown: judged once the root is verified')
  t.is(groupVerdict(atG, writer, G, diary, ANY, 'public', 'community'), 'header-invalid', 'a member is never a community writer')
  t.is(groupVerdict(atG, writer, key(), diary, ANY, 'public', 'group'), 'wrong-group', 'listed under another group')
})

test('a private standalone root requires the writer box', (t) => {
  t.is(groupVerdict(privateStandalone, G, G, diary, AS_GROUP), null, 'the private root is accepted')
  t.is(groupVerdict(boxedAtG, writer, G, diary, ANY, 'private', 'group'), null, 'boxed member = G')
  t.is(groupVerdict(atG, writer, G, diary, ANY, 'private', 'group'), 'header-invalid', 'boxless in a private standalone group')
  t.is(groupVerdict(boxedAtG, writer, G, diary, ANY, 'public', 'group'), 'header-invalid', 'boxed in a public standalone group')
  t.ok(boxMismatch(atG, writer, G, 'private'))
  t.absent(boxMismatch(privateStandalone, G, G, 'public'), 'a root is never judged by its box')
})

// A group core of `m` whose block 0 is `header(key)`, listed and bound as
// group.create or a join would: -> its key.
async function craft (m, header, group = null) {
  const nonce = crypto.randomBytes(32)
  const kp = await m.ctx.groupKeyPair(new Uint8Array(nonce))
  const k = hex(kp.publicKey)
  const core = await store.openGroupWriter(m.storage, kp)
  try {
    await store.appendGroupRecord(core, header(k), { root: group === null })
  } finally {
    await core.close()
  }
  const g = group === null ? k : group
  await store.putGroupWriter(m.storage, { group: g, key: k, nonce: hex(nonce), rootNonce: group === null ? hex(nonce) : null })
  const d = await store.openDiary(m.storage, m.ctx.keyPair)
  try {
    await store.appendRecord(d, groupJoinRecord({ group: g, writer: k, on: true }))
  } finally {
    await d.close()
  }
  return k
}

test('a standalone root and its member writer sync through the seeder, with no parent paged', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const { seeder, dataDir, url } = await seederOverWs(t, assocKp, bootstrap)
  const a = await member(assocKp, 'Ana')
  const b = await member(assocKp, 'Bia')

  const root = await craft(a, () => grp.groupHeader({ diary: a.ownHex, community: null, member: null, name: 'Horta', join: 'open' }))
  const evA = []
  const resA = await once(a, url, evA)
  t.ok(resA.ok, 'creator once run ok ' + JSON.stringify(resA.errors))
  t.ok(named(evA, 'group-pushed').some((e) => e.key === root), 'root confirmed pushed')
  await until(() => admittedGroups(dataDir)[root], { name: 'root admitted' })
  await until(() => indexed(seeder, root, root), { name: 'root indexed' })

  await store.addGroupReplica(b.storage, root)
  const evB = []
  const resB = await once(b, url, evB)
  t.ok(resB.ok, 'member once run ok ' + JSON.stringify(resB.errors))
  t.alike(await held(b, root), { length: 1, contiguous: 1 }, 'the standalone root is stored')
  t.absent(named(evB, 'group-skipped').some((e) => e.key === root), 'never skipped')
  t.is(named(evB, 'community-parent').length, 0, 'no parent community is announced')
  t.absent(named(evB, 'group-paged').some((e) => e.group !== root), 'nothing but the root is paged')

  const w = await craft(b, () => grp.writerHeader({ group: root, diary: b.ownHex, member: root }), root)
  const evB2 = []
  const resB2 = await once(b, url, evB2)
  t.ok(resB2.ok, 'member push run ok ' + JSON.stringify(resB2.errors))
  t.ok(named(evB2, 'group-pushed').some((e) => e.key === w), 'the writer naming G is pushed')
  await until(() => indexed(seeder, root, w), { name: 'writer indexed' })

  const evA2 = []
  const resA2 = await once(a, url, evA2)
  t.ok(resA2.ok, 'creator once run ok ' + JSON.stringify(resA2.errors))
  t.alike(await held(a, w), { length: 1, contiguous: 1 }, 'the creator holds the writer in full')
  t.absent(named(evA2, 'group-skipped').some((e) => e.key === w), 'the writer is never skipped')
  t.is(named(evA2, 'community-parent').length, 0, 'still no parent community')
})
