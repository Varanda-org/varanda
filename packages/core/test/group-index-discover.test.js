'use strict'

const test = require('brittle')
const { BROWSE_MAX, RECENT_PER_CREATOR, PUBLIC_GROUPS_PAGE, TREND_MIN_ACTIVE, createGroupIndex } = require('../lib/group-index')
const { RESULTS_MAX } = require('../lib/search-text')
const { groupHeader, groupCreateRecord, groupMeta } = require('../lib/group')

const key = (n) => n.toString(16).padStart(64, '0')
const S = key(1)
const C = key(100)
const GERAL = key(101)
const CG = key(102)
const ORPHAN = key(103)
const P = key(104)
const C2 = key(110)
const D1 = key(200)
const D2 = key(201)
const NOW = Date.parse('2026-01-02T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function addStandalone (idx, group, { diary = D1, name = 'Cadeiras', join = 'open', at = NOW } = {}) {
  idx.setHeader(group, groupHeader({ diary, name, join, at: iso(at) }))
  idx.addWriter(group, group, diary, 1)
}

function addCommunity (idx, community, { diary = D1, name = 'Bairro', at = NOW } = {}) {
  idx.setHeader(community, groupHeader({ kind: 'community', diary, name, at: iso(at) }))
  idx.addWriter(community, community, diary, 1)
}

function addCommunityGroup (idx, group, community, { name = 'Cadeiras', create = true } = {}) {
  idx.setHeader(group, groupHeader({ diary: D1, community, member: community, name, at: iso(NOW) }))
  if (create) idx.foldRoot(community, groupCreateRecord({ group, at: iso(NOW) }))
  idx.addWriter(group, group, D1, 1)
}

// One standalone group, a community with its Geral and another group, an
// orphan (its community never created it) and a private standalone group,
// all named 'Cadeiras' and joined by D2.
function fixture () {
  const idx = createGroupIndex()
  addStandalone(idx, S)
  addCommunity(idx, C, { name: 'Cadeiras' })
  addCommunityGroup(idx, GERAL, C)
  addCommunityGroup(idx, CG, C)
  addCommunityGroup(idx, ORPHAN, C2, { create: false })
  idx.setHeader(P, groupHeader({ diary: D1, visibility: 'private', join: 'approval', box: key(300), at: iso(NOW) }))
  idx.addWriter(P, P, D1, 1)
  let n = 400
  for (const g of [S, C, GERAL, CG, ORPHAN, P]) idx.addWriter(g, key(n++), D2, 2)
  return idx
}

const groupKeys = (rows) => rows.map((r) => r.group)

test('discovery: no community group, orphan or private group in any listing', (t) => {
  const idx = fixture()
  const active = { lastActivity: () => NOW }
  for (const order of ['members', 'recent', 'trending']) {
    t.alike(groupKeys(idx.browseStandalone(order, NOW, active).groups), [S], order)
  }
  t.alike(idx.browseStandalone('members', NOW).groups, [{ group: S, name: 'Cadeiras', creator: D1, members: 2, created: NOW, active: null }])
  for (const order of ['members', 'recent']) {
    t.alike(idx.browseCommunities(order, NOW), {
      communities: [{ community: C, name: 'Cadeiras', creator: D1, join: 'open', members: 2, created: NOW }],
      more: false
    }, order)
  }
  t.is(idx.browseCommunities('trending', NOW), null, 'no trending order for communities')
  t.alike(idx.discoverSearch('cadeiras'), {
    groups: [{ group: S, name: 'Cadeiras', members: 2 }],
    communities: [{ community: C, name: 'Cadeiras', members: 2 }],
    moreGroups: false,
    moreCommunities: false
  })
  t.alike(idx.standaloneGroupsOf(D2), { groups: [{ group: S, name: 'Cadeiras', creator: D1, members: 2 }], next: null })
  t.is(idx.browse('members', NOW).groups.length, 2, 'browse keeps listing community groups')
  t.is(idx.discoverSearch('%%'), null, 'malformed segment')
  t.is(idx.standaloneGroupsOf('x'), null)
})

test('discovery: a catalogue naming a standalone root neither hides nor attaches it', (t) => {
  const idx = fixture()
  t.ok(idx.foldRoot(C, groupCreateRecord({ group: S, at: iso(NOW) })))
  t.alike(groupKeys(idx.browseStandalone('members', NOW).groups), [S])
  t.alike(groupKeys(idx.discoverSearch('cadeiras').groups), [S])
  t.alike(groupKeys(idx.standaloneGroupsOf(D2).groups), [S])
  t.absent(idx.attached(C, S), 'not that community\'s group')
  t.absent(idx.community(C).groups.some((r) => r.group === S))
})

test('discovery: a renamed community is found by its new name', (t) => {
  const idx = fixture()
  idx.foldRoot(C, groupMeta({ name: 'Vila Nova', join: 'approval', at: iso(NOW) }))
  const r = idx.discoverSearch('vila')
  t.alike(r.communities, [{ community: C, name: 'Vila Nova', members: 2 }])
  t.alike(idx.discoverSearch('cadeiras').communities, [])
  t.is(idx.browseCommunities('members', NOW).communities[0].join, 'approval')
  idx.resetRoot(C)
  t.alike(idx.discoverSearch('cadeiras').communities.map((x) => x.community), [C], 'reset restores the header name')
})

test('discovery: filters, approval and private rules', (t) => {
  const idx = fixture()
  t.alike(idx.browseStandalone('members', NOW, { visible: () => false }).groups, [])
  t.is(idx.browseStandalone('members', NOW, { members: (diary) => diary === D2 }).groups[0].members, 1)
  t.alike(idx.browseCommunities('members', NOW, { visible: (c, creator) => c !== C || creator !== D1 }).communities, [])
  t.alike(idx.discoverSearch('cadeiras', { members: () => false }), { groups: [], communities: [], moreGroups: false, moreCommunities: false })
  t.alike(idx.standaloneGroupsOf(D2, { joined: () => false }).groups, [])

  idx.foldRoot(S, groupMeta({ name: 'Cadeiras', join: 'approval', at: iso(NOW) }))
  t.alike(idx.standaloneGroupsOf(D2).groups, [], 'approval group not in a diary\'s list')
  t.alike(idx.browseStandalone('trending', NOW, { lastActivity: () => NOW }).groups, [], 'approval never trends')
  t.alike(groupKeys(idx.browseStandalone('members', NOW).groups), [S], 'approval still browsed')

  idx.setLeft(key(400), true)
  idx.setLeft(S, true)
  t.alike(idx.browseStandalone('members', NOW).groups, [], 'every writer left')
})

test('discovery: order, caps and cursor', (t) => {
  const idx = createGroupIndex()
  const n = BROWSE_MAX + 3
  for (let i = 0; i < n; i++) {
    const g = key(1000 + i)
    addStandalone(idx, g, { diary: key(2000 + (i % 7)), at: NOW - i * 1000 })
    for (let j = 0; j < i % 4; j++) idx.addWriter(g, key(10000 + i * 10 + j), key(3000 + j), 2)
    idx.addWriter(g, key(20000 + i), D2, 3)
    const c = key(5000 + i)
    addCommunity(idx, c, { diary: key(2000 + (i % 7)), name: 'Cadeiras ' + i, at: NOW - i * 1000 })
    for (let j = 0; j < i % 3; j++) idx.addWriter(c, key(30000 + i * 10 + j), key(3000 + j), 2)
  }

  const members = idx.browseStandalone('members', NOW)
  t.is(members.groups.length, BROWSE_MAX)
  t.ok(members.more)
  for (let i = 1; i < members.groups.length; i++) {
    const a = members.groups[i - 1]
    const b = members.groups[i]
    t.ok(a.members > b.members || (a.members === b.members && a.group < b.group))
  }
  const recent = idx.browseStandalone('recent', NOW).groups
  t.is(recent.length, 7 * RECENT_PER_CREATOR, 'recent capped per creator')
  for (let i = 1; i < recent.length; i++) t.ok(recent[i - 1].created >= recent[i].created)
  const trending = idx.browseStandalone('trending', NOW, { lastActivity: () => NOW }).groups
  t.ok(trending.every((r) => r.active >= TREND_MIN_ACTIVE))
  t.ok(trending.length > 0)

  const cm = idx.browseCommunities('members', NOW)
  t.is(cm.communities.length, BROWSE_MAX)
  t.ok(cm.more)
  t.is(idx.browseCommunities('recent', NOW).communities.length, 7 * RECENT_PER_CREATOR)
  idx.setHeader(key(5000), groupHeader({ kind: 'community', diary: key(2000), name: 'Futuro', at: iso(NOW + 86400000) }))
  t.absent(idx.browseCommunities('recent', NOW).communities.some((r) => r.community === key(5000)), 'future date not recent')

  const found = idx.discoverSearch('cadeiras')
  t.is(found.groups.length, RESULTS_MAX)
  t.is(found.communities.length, RESULTS_MAX)
  t.ok(found.moreGroups)
  t.ok(found.moreCommunities)

  const seen = []
  let after = null
  for (;;) {
    const page = idx.standaloneGroupsOf(D2, { after, limit: 10 })
    t.ok(page.groups.length <= 10)
    seen.push(...groupKeys(page.groups))
    if (page.next === null) break
    after = page.next
  }
  t.is(seen.length, n)
  t.alike(seen, [...seen].sort())
  t.is(idx.standaloneGroupsOf(D2, { limit: 1000 }).groups.length, Math.min(n, PUBLIC_GROUPS_PAGE))
})
