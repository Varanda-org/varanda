'use strict'

// The /index/discover answers of the seeder: indexDiscoverGroups lists
// public standalone groups, indexDiscoverCommunities public communities,
// indexDiscoverSearch both by name and indexDiscoverGroupsOf the open
// standalone groups one diary takes part in. A community's own groups, a
// private group, a root its header's diary never bound and anything
// blocked never appear, and a catalogue claim on a standalone root neither
// hides it nor makes it the community's group.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord, groupsShowRecord } = require('../lib/records')
const { Seeder } = require('../lib/seeder')
const { groupHeader, writerHeader, groupPost, groupCreateRecord } = require('../lib/group')
const {
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  moderator,
  scansDone
} = require('./helpers/seeder-groups')

const BOX = 'e'.repeat(64)
const WRITER_BOX = 'd'.repeat(64)

function iso (ms) {
  return new Date(ms).toISOString()
}

function keys (rows) {
  return rows.map((r) => r.group)
}

// Creator A: standalone S ('Roda livre', open, newest), standalone Q ('Roda
// fechada', approval), private standalone V, community C ('Roda de samba')
// whose catalogue first names S, a forged entry in the Geral position, and
// then creates G ('Roda geral') and H ('Roda da praia'). A joins every root. Member B: writers in S, V, G and H,
// in U ('Roda solta'), a standalone root whose header names A but that A
// never joined (unbound), and in UC ('Roda vizinha'), an unbound community.
// Resolves once every core is admitted and the discover answers are
// complete.
async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const now = Date.now()
  const at = { S: iso(now - 1000), Q: iso(now - 2000), C: iso(now - 3000) }
  const k = { at }
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const under = (opts) => groupHeader({ diary: key, community: k.C, member: k.C, ...opts })
    k.S = await make('s', groupHeader({ diary: key, name: 'Roda livre', at: at.S }), [groupPost({ text: 'oi' })])
    k.Q = await make('q', groupHeader({ diary: key, name: 'Roda fechada', join: 'approval', at: at.Q }))
    k.V = await make('v', groupHeader({ diary: key, visibility: 'private', join: 'approval', name: null, box: BOX }))
    k.C = await make('c', groupHeader({ kind: 'community', diary: key, name: 'Roda de samba', at: at.C }))
    k.G = await make('g', under({ name: 'Roda geral' }))
    k.H = await make('h', under({ name: 'Roda da praia' }))
    return [k.S, k.Q, k.V, k.C, k.G, k.H].map((g) => groupJoinRecord({ group: g, writer: g, on: true }))
  })
  for (const g of [k.S, k.G, k.H]) await A.cores.c.append(encode(groupCreateRecord({ group: g })))
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.U = await make('u', groupHeader({ diary: A.key, name: 'Roda solta' }))
    k.WS = await make('ws', writerHeader({ group: k.S, diary: key, member: k.S }), [groupPost({ text: 'olá' })])
    k.WV = await make('wv', writerHeader({ group: k.V, diary: key, member: k.V, box: WRITER_BOX }))
    k.WG = await make('wg', writerHeader({ group: k.G, diary: key, member: k.C }))
    k.WH = await make('wh', writerHeader({ group: k.H, diary: key, member: k.C }))
    k.WU = await make('wu', writerHeader({ group: k.U, diary: key, member: k.U }))
    k.UC = await make('uc', groupHeader({ kind: 'community', diary: A.key, name: 'Roda vizinha' }))
    k.WUC = await make('wuc', writerHeader({ group: k.UC, diary: key, member: null }))
    return [[k.S, k.WS], [k.V, k.WV], [k.G, k.WG], [k.H, k.WH], [k.U, k.WU], [k.UC, k.WUC]].map(([group, writer]) => groupJoinRecord({ group, writer, on: true }))
  })
  await admit(A, assoc)
  await admit(B, assoc)
  for (const key of [k.S, k.Q, k.V, k.C, k.G, k.H, k.U, k.UC, k.WS, k.WV, k.WG, k.WH, k.WU, k.WUC]) await admitted(events, key)
  await until(() => {
    if (!scansDone(seeder)) return false
    const answers = [
      seeder.indexDiscoverGroups('members'),
      seeder.indexDiscoverGroups('recent'),
      seeder.indexDiscoverCommunities('members'),
      seeder.indexDiscoverSearch('roda'),
      seeder.indexDiscoverGroupsOf(B.key)
    ]
    return answers.every((a) => a !== null && a.complete)
  }, { name: 'descoberta completa', timeoutMs: 60000 })
  return { bootstrap, assoc, publicKey, seeder, events, A, B, ...k }
}

test('a pending owner scan answers the discover profile list empty until it has read the groups-show choice', async (t) => {
  const diary = 'd'.repeat(64)
  const row = { group: 'a'.repeat(64) }
  const seeder = new Seeder({ dataDir: '/nonexistent' })
  const blocks = [null, encode(groupsShowRecord({ on: false }))]
  const core = { length: 2, contiguousLength: 2, get: (seq) => blocks[seq] }
  const entry = { core, present: 2, scanned: 2, indexed: 1, gated: true, groupLive: new Map() }
  seeder._served.set(diary, entry)
  seeder._admitted.set(diary, true)
  seeder._passesStarted = true
  seeder._indexStartup = new Set()
  seeder._groupIndex.standaloneGroupsOf = () => ({ groups: [row], next: null })

  const pending = { groups: [], next: null, hidden: false, indexing: false, complete: false }
  t.alike(seeder.indexDiscoverGroupsOf(diary), pending, 'the unread off record lists nothing')
  t.alike(seeder.indexDiscoverGroupsOf(diary, 'f'.repeat(64)), pending, 'on every page')
  await seeder._runIndex(diary, entry)
  const hidden = { groups: [], next: null, hidden: true, indexing: false, complete: true }
  t.alike(seeder.indexDiscoverGroupsOf(diary), hidden)
  t.alike(seeder.indexDiscoverGroupsOf(diary, 'f'.repeat(64)), hidden, 'every page')
  t.is(seeder.indexDiscoverGroupsOf(diary, 'zz'), null, 'a malformed cursor is still refused')
  t.is(seeder.indexDiscoverGroupsOf('f'.repeat(64)), null, 'a diary not served here')
})

test('discover lists standalone groups and communities only: no community group, private group or unbound root; a catalogue claim on a standalone root changes nothing', async (t) => {
  t.timeout(170000)
  const { seeder, events, A, B, S, Q, V, C, G, H, U, UC, at } = await setup(t)

  const members = seeder.indexDiscoverGroups('members')
  t.is(members.indexing, false)
  t.is(members.more, false)
  t.alike(members.groups, [
    { group: S, name: 'Roda livre', creator: A.key, members: 2, created: Date.parse(at.S), active: null },
    { group: Q, name: 'Roda fechada', creator: A.key, members: 1, created: Date.parse(at.Q), active: null }
  ], 'S and the approval group Q, most members first')
  t.alike(keys(seeder.indexDiscoverGroups('recent').groups), [S, Q], 'newest first')

  t.alike(seeder.indexDiscoverCommunities('members'), {
    communities: [{ community: C, name: 'Roda de samba', creator: A.key, join: 'open', members: 1, created: Date.parse(at.C) }],
    more: false,
    indexing: false,
    complete: true
  })
  t.alike(seeder.indexDiscoverCommunities('recent').communities.map((r) => r.community), [C])

  const found = seeder.indexDiscoverSearch('roda')
  t.alike(found, {
    groups: [{ group: S, name: 'Roda livre', creator: A.key, members: 2 }, { group: Q, name: 'Roda fechada', creator: A.key, members: 1 }],
    communities: [{ community: C, name: 'Roda de samba', creator: A.key, members: 1 }],
    moreGroups: false,
    moreCommunities: false,
    indexing: false,
    complete: true
  })
  t.alike(seeder.indexDiscoverSearch('roda-solta').groups, [], 'the unbound root is not found by its exact name')
  t.alike(seeder.indexDiscoverSearch('roda-vizinha').communities, [], 'nor the unbound community')
  t.alike(seeder.indexDiscoverSearch('roda-da-praia').groups, [], 'nor a community\'s group by its exact name')

  t.alike(seeder.indexDiscoverGroupsOf(B.key), {
    groups: [{ group: S, name: 'Roda livre', creator: A.key, members: 2 }],
    next: null,
    hidden: false,
    indexing: false,
    complete: true
  }, 'B: S only, not its community groups, its private group or the unbound root')
  t.alike(keys(seeder.indexDiscoverGroupsOf(A.key).groups), [S], 'A: the approval group Q is left out')
  t.alike(seeder.indexDiscoverGroupsOf(B.key, S).groups, [], 'nothing after the last key')

  t.ok(seeder._groupCoreVisible(U), 'the unbound root is served')
  t.is(seeder.indexGroup(U).header.diary, null, 'with no creator: A never bound it')
  t.ok(seeder.indexGroup(U).writers.some((w) => w.diary === B.key), 'and B is its member')
  t.ok(seeder._groupCoreVisible(UC), 'the unbound community is served')
  t.is(seeder.indexCommunity(UC).creator, null, 'with no creator either')
  t.is(seeder.indexCommunity(UC).members, 1, 'and B as its member')
  const answers = [members, seeder.indexDiscoverGroups('recent'), found, seeder.indexDiscoverGroupsOf(B.key), seeder.indexDiscoverGroupsOf(A.key)]
  for (const a of answers) {
    for (const key of [V, G, H, U, C]) t.absent(keys(a.groups).includes(key), 'never listed: ' + key.slice(0, 8))
  }

  // The catalogue claim on S, in the Geral position: the community lists G
  // and H only, and S stays standalone everywhere above.
  t.is(seeder._groupIndex.generalOf(C), S, 'the forged entry is the first create')
  t.alike(seeder.indexCommunity(C).groups.map((r) => r.group), [G, H].sort(), 'S is not the community\'s group')
  t.is(seeder.indexGroup(S).attached, false)

  // A's diary gone here (quota, capacity, a restart without it): its bound
  // roots stay listed under A through the kept root rows, until A is
  // blocked. Synchronous, so no pass sees the edited state.
  const entryA = seeder._served.get(A.key)
  const isBlocked = seeder._isBlocked
  seeder._served.delete(A.key)
  try {
    t.absent(seeder._rootBound(S, A.key), 'A no longer binds S here')
    t.alike(seeder.indexDiscoverGroups('members').groups.map((r) => [r.group, r.creator, r.members]), [[S, A.key, 2], [Q, A.key, 1]], 'kept roots list with their creator')
    t.alike(seeder.indexDiscoverCommunities('members').communities.map((r) => [r.community, r.creator, r.members]), [[C, A.key, 1]], 'and the kept community')
    t.alike(keys(seeder.indexDiscoverSearch('roda').groups), [S, Q])
    t.alike(keys(seeder.indexDiscoverGroupsOf(B.key).groups), [S])
    seeder._isBlocked = (key) => key === A.key || isBlocked.call(seeder, key)
    t.alike(seeder.indexDiscoverGroups('members').groups, [], 'a blocked creator\'s kept roots stop listing')
    t.alike(seeder.indexDiscoverCommunities('members').communities, [])
    t.alike(seeder.indexDiscoverGroupsOf(B.key).groups, [])
  } finally {
    seeder._isBlocked = isBlocked
    seeder._served.set(A.key, entryA)
  }

  // The legacy lists keep their output.
  t.alike(keys(seeder.indexGroupBrowse('members').groups).sort(), [G, H].sort())
  t.alike(keys(seeder.indexGroupSearch('roda').groups).sort(), [G, H].sort())

  t.is(seeder.indexDiscoverGroups('nope'), null, 'an unknown order')
  t.is(seeder.indexDiscoverCommunities('trending'), null, 'communities have no trending order')
  t.is(seeder.indexDiscoverSearch('%%'), null, 'a malformed segment')
  t.is(seeder.indexDiscoverGroupsOf('zz'), null)
  t.is(seeder.indexDiscoverGroupsOf(B.key, 'zz'), null, 'a malformed cursor')

  // Trending: two diaries posted in S lately; Q asks for approval.
  await until(() => {
    const tr = seeder.indexDiscoverGroups('trending')
    return tr !== null && tr.complete && tr.groups.length > 0
  }, { name: 'S em alta', timeoutMs: 60000 })
  t.alike(seeder.indexDiscoverGroups('trending').groups, [{ group: S, name: 'Roda livre', creator: A.key, members: 2, created: Date.parse(at.S), active: 2 }])

  // S's root not read in order: left out of trending and the profile list,
  // which are incomplete meanwhile. Synchronous, as above.
  const rootGap = seeder._rootGap
  const rootScanBehind = seeder._rootScanBehind
  for (const [name, stub] of [['_rootGap', rootGap], ['_rootScanBehind', rootScanBehind]]) {
    seeder[name] = (key) => key === S || stub.call(seeder, key)
    try {
      const tr = seeder.indexDiscoverGroups('trending')
      t.alike([tr.groups, tr.complete], [[], false], name + ': out of trending')
      const of = seeder.indexDiscoverGroupsOf(B.key)
      t.alike([of.groups, of.complete], [[], false], name + ': out of the profile list')
    } finally {
      seeder[name] = stub
    }
  }
  t.ok(seeder.indexDiscoverGroupsOf(B.key).complete, 'complete again once read')

  // B hides its profile list: only that list.
  await B.diary.append(groupsShowRecord({ on: false }))
  const entry = seeder._served.get(B.key)
  await until(() => entry.indexed >= B.diary.length && entry.scanned >= B.diary.length && seeder.indexDiscoverGroupsOf(B.key).complete, { name: 'escolha de B lida' })
  const hidden = { groups: [], next: null, hidden: true, indexing: false, complete: true }
  t.alike(seeder.indexDiscoverGroupsOf(B.key), hidden)
  t.alike(seeder.indexDiscoverGroupsOf(B.key, S), hidden, 'every page')
  t.is(seeder.indexDiscoverGroups('members').groups[0].members, 2, 'B still counts in S')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a blocked standalone group, a blocked community and a blocked creator\'s roots never appear in discover', async (t) => {
  t.timeout(170000)
  const { bootstrap, assoc, publicKey, seeder, events, A, B, S, Q, C } = await setup(t)
  const mod = moderator(assoc)
  const block = (seq, blocked) => reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert) })
  const settled = (name, fn) => until(() => {
    const g = seeder.indexDiscoverGroups('members')
    const c = seeder.indexDiscoverCommunities('members')
    const s = seeder.indexDiscoverSearch('roda')
    const o = seeder.indexDiscoverGroupsOf(B.key)
    return [g, c, s, o].every((a) => a !== null && a.complete) && fn(g, c, s, o)
  }, { name, timeoutMs: 60000 })

  await block(1, [S])
  await rejected(events, S, 'group-blocked')
  await settled('S fora', (g, c, s, o) => !keys(g.groups).includes(S) && !keys(s.groups).includes(S) && o.groups.length === 0)
  t.alike(keys(seeder.indexDiscoverGroups('members').groups), [Q])
  t.alike(keys(seeder.indexDiscoverGroups('recent').groups), [Q])
  t.alike(keys(seeder.indexDiscoverSearch('roda').groups), [Q])
  t.alike(seeder.indexDiscoverGroupsOf(B.key).groups, [])

  await block(2, [S, C])
  await rejected(events, C, 'group-blocked')
  await settled('C fora', (g, c, s) => c.communities.length === 0 && s.communities.length === 0)
  t.alike(seeder.indexDiscoverCommunities('recent').communities, [])

  await block(3, [S, C, A.key])
  await settled('raízes de A fora', (g, c, s) => g.groups.length === 0 && s.groups.length === 0)
  t.alike(seeder.indexDiscoverGroups('recent').groups, [])
  t.is(seeder.indexDiscoverGroupsOf(A.key), null, 'the blocked creator answers null')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
