'use strict'

const test = require('brittle')
const { BROWSE_MAX, RECENT_PER_CREATOR, PUBLIC_GROUPS_PAGE, CREATED_SKEW_MS, TREND_WINDOW_MS, TREND_MIN_ACTIVE, createGroupIndex } = require('../lib/group-index')
const { groupHeader, groupCreateRecord, groupMeta } = require('../lib/group')

const key = (n) => n.toString(16).padStart(64, '0')
const G = key(1)
const W = key(2)
const C = key(100)
const C2 = key(101)
const D1 = key(200)
const D2 = key(201)
const NOW = Date.parse('2026-01-02T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function header ({ community = C, diary = D1, join = 'open', at = NOW } = {}) {
  return groupHeader({ diary, community, member: community, join, name: 'Cadeiras', at: iso(at) })
}

function addCommunity (idx, community = C, diary = D1) {
  idx.setHeader(community, groupHeader({ kind: 'community', diary, name: 'Bairro', at: iso(NOW) }))
}

function addGroup (idx, group, options = {}) {
  const root = header(options)
  idx.setHeader(group, root)
  idx.foldRoot(root.community, groupCreateRecord({ group, at: iso(NOW) }))
  idx.addWriter(group, group, root.diary, 1)
}

function fixture () {
  const idx = createGroupIndex()
  addCommunity(idx)
  addGroup(idx, G)
  idx.addWriter(G, W, D2, 2)
  return idx
}

function keysOf ({ groups }) {
  return groups.map((row) => row.group)
}

// Each order uses one descending field, then the group key ascending.
function inOrder (t, order, { groups }) {
  const field = { members: 'members', recent: 'created', trending: 'active' }[order]
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1]
    const b = groups[i]
    const before = a[field] > b[field] || (a[field] === b[field] && a.group < b.group)
    t.ok(before, order + ' row ' + i + ' in the stated order')
  }
  if (order === 'recent') t.ok(groups.every((row) => Number.isSafeInteger(row.created)), 'recent rows all dated')
}

function dated ({ groups }) {
  return groups.map(({ group, created }) => [group, created])
}

test('browse: listed row shape, folded names and read-time filters', (t) => {
  const idx = fixture()
  const row = { group: G, name: 'Cadeiras', creator: D1, community: C, communityName: 'Bairro', members: 2, created: NOW, active: null }
  t.alike(idx.browse('members', NOW), { groups: [row], more: false })
  t.alike(idx.header(G), { kind: 'group', visibility: 'public', join: 'open', diary: D1, name: 'Cadeiras', community: C, member: C })
  t.alike(idx.browse('members', NOW, {
    parent: (community) => community === C,
    visible: (group, creator) => group === G && creator === D1,
    members: (diary, writer) => diary === D2 && writer === W
  }).groups, [{ ...row, members: 1 }])
  t.alike(idx.browse('members', NOW, { parent: () => false }).groups, [], 'hidden community')
  t.alike(idx.browse('members', NOW, { visible: () => false }).groups, [], 'hidden group or creator')
  t.alike(idx.browse('members', NOW, { members: () => false }).groups, [], 'every member filtered out')

  idx.foldRoot(C, groupMeta({ name: 'Vila', join: 'open', at: iso(NOW) }))
  idx.foldRoot(G, groupMeta({ name: 'Praça', join: 'open', at: iso(NOW) }))
  t.alike(idx.browse('members', NOW).groups, [{ ...row, name: 'Praça', communityName: 'Vila' }])
  idx.setLeft(G, true)
  idx.setLeft(W, true)
  t.alike(idx.browse('members', NOW).groups, [], 'every writer left')
})

test('browse: requires a named public group attached to a named community', (t) => {
  const cases = [
    ['private group', (idx) => idx.setHeader(G, groupHeader({ diary: D1, community: C, member: C, visibility: 'private', join: 'approval', box: key(300), at: iso(NOW) }))],
    ['nameless group', (idx) => idx.foldRoot(G, groupMeta({ name: null, join: 'open', at: iso(NOW) }))],
    ['no community in header', (idx) => idx.setHeader(G, { ...header(), community: null, member: null })],
    ['no catalogue entry', (idx) => idx.resetRoot(C)],
    ['empty community name', (idx) => idx.foldRoot(C, { type: 'group-meta', name: '' })],
    ['forgotten header', (idx) => idx.setHeader(G, null)]
  ]
  for (const [reason, change] of cases) {
    const idx = fixture()
    t.ok(change(idx), reason)
    t.alike(idx.browse('members', NOW), { groups: [], more: false }, reason)
  }
})

test('browse: members sort by distinct diary count and then group key', (t) => {
  const idx = createGroupIndex()
  addCommunity(idx)
  for (const group of [key(3), key(2), G]) addGroup(idx, group)
  idx.addWriter(key(3), key(4), D2, 2)
  idx.addWriter(key(2), key(5), D1, 2)
  t.alike(idx.browse('members', NOW).groups.map(({ group, members }) => [group, members]), [
    [key(3), 2], [G, 1], [key(2), 1]
  ])
})

test('browse: recent lists a date at most CREATED_SKEW_MS ahead as written and leaves later ones out', (t) => {
  const idx = createGroupIndex()
  addCommunity(idx)
  addCommunity(idx, C2, D2)
  const edge = key(2)
  const over = key(3)
  const ahead = key(4)
  const honest = key(5)
  addGroup(idx, edge, { at: NOW + CREATED_SKEW_MS })
  addGroup(idx, over, { at: NOW + CREATED_SKEW_MS + 1 })
  addGroup(idx, ahead, { community: C2, diary: D2, at: NOW + 23 * 3600000 })
  addGroup(idx, honest, { community: C2, diary: D2, at: NOW - 60000 })

  t.is(CREATED_SKEW_MS, 300000)
  t.is(RECENT_PER_CREATOR, 2)
  const recent = idx.browse('recent', NOW)
  t.alike(dated(recent), [[edge, NOW + CREATED_SKEW_MS], [honest, NOW - 60000]], 'a group dated 23 h ahead never sits above an honest one')
  t.is(recent.more, false)
  inOrder(t, 'recent', recent)
  t.alike(dated(idx.browse('recent', NOW + 23 * 3600000 - CREATED_SKEW_MS)).slice(0, 1), [[ahead, NOW + 23 * 3600000]], 'listed once its date is within the skew')
})

test('browse: recent ties go by group key and a creator keeps its two latest dates unclamped', (t) => {
  const tie = createGroupIndex()
  addCommunity(tie)
  addCommunity(tie, C2, D2)
  addGroup(tie, key(6), { community: C2, diary: D2, at: NOW - 1000 })
  addGroup(tie, key(5), { at: NOW - 1000 })
  const tied = tie.browse('recent', NOW)
  t.alike(dated(tied), [[key(5), NOW - 1000], [key(6), NOW - 1000]])
  inOrder(t, 'recent', tied)

  const idx = createGroupIndex()
  addCommunity(idx)
  const minute = 60000
  addGroup(idx, key(9), { at: NOW + minute })
  addGroup(idx, key(8), { at: NOW + 2 * minute })
  addGroup(idx, key(7), { at: NOW + 3 * minute })
  const recent = idx.browse('recent', NOW)
  t.alike(dated(recent), [[key(7), NOW + 3 * minute], [key(8), NOW + 2 * minute]])
  t.is(recent.more, false, 'only rows that pass the creator cap count')
  inOrder(t, 'recent', recent)
  for (const row of recent.groups) t.alike(Object.keys(row), ['group', 'name', 'creator', 'community', 'communityName', 'members', 'created', 'active'])
})

test('browse: members keeps every row in place and nulls a date more than CREATED_SKEW_MS ahead', (t) => {
  const idx = createGroupIndex()
  addCommunity(idx)
  const twoDays = key(2)
  const hour = key(3)
  const minute = key(4)
  const old = key(5)
  addGroup(idx, twoDays, { at: NOW + 2 * 86400000 })
  addGroup(idx, hour, { at: NOW + 3600000 })
  addGroup(idx, minute, { at: NOW + 60000 })
  addGroup(idx, old)
  t.ok(idx.setHeader(old, { ...header(), at: iso(-1) }))
  idx.addWriter(hour, key(6), D2, 2)
  const members = idx.browse('members', NOW)
  t.alike(dated(members), [[hour, null], [twoDays, null], [minute, NOW + 60000], [old, null]], 'every row keeps its place')
  inOrder(t, 'members', members)
  for (const row of members.groups) t.alike(Object.keys(row), ['group', 'name', 'creator', 'community', 'communityName', 'members', 'created', 'active'])
  t.alike(dated(idx.browse('recent', NOW)), [[minute, NOW + 60000]])
})

test('browse: creation time requires a canonical ISO string at or after the epoch', (t) => {
  const idx = fixture()
  for (const at of [undefined, NOW, 'invalid', '2026-01-02T12:00:00Z', iso(-1)]) {
    t.ok(idx.setHeader(G, { ...header(), at }))
    t.is(idx.browse('members', NOW).groups[0].created, null)
    t.alike(idx.browse('recent', NOW).groups, [])
  }
  t.ok(idx.setHeader(G, header({ at: 0 })))
  t.is(idx.browse('recent', NOW).groups[0].created, 0)
})

test('browse: more counts rows after filters and creator caps', (t) => {
  const idx = createGroupIndex()
  t.is(BROWSE_MAX, 20)
  for (let i = 21; i >= 1; i--) {
    const community = key(100 + i)
    const diary = key(200 + i)
    addCommunity(idx, community, diary)
    addGroup(idx, key(i), { community, diary })
  }
  const first = Array.from({ length: 20 }, (_, i) => key(i + 1))
  for (const order of ['members', 'recent']) {
    const result = idx.browse(order, NOW)
    inOrder(t, order, result)
    t.alike(keysOf(result), first)
    t.is(result.more, true)
    t.is(idx.browse(order, NOW, { visible: (group) => group !== key(21) }).more, false)
  }
  for (const i of [22, 23]) {
    const community = key(100 + i)
    const diary = key(201)
    addCommunity(idx, community, diary)
    addGroup(idx, key(i), { community, diary })
  }
  const filters = { visible: (group) => group !== key(20) && group !== key(21) }
  const recent = idx.browse('recent', NOW, filters)
  t.alike(keysOf(recent), [...first.slice(0, 19), key(22)], 'one cap applies across communities')
  inOrder(t, 'recent', recent)
  t.is(recent.more, false)
  t.is(idx.browse('members', NOW, filters).more, true)
})

test('browse: trending reads writer activity recorded before addWriter', (t) => {
  const idx = createGroupIndex()
  addCommunity(idx)
  addGroup(idx, G)
  const activity = new Map([[G, NOW], [W, NOW]])
  const filters = { lastActivity: (writer) => activity.get(writer) ?? null }
  const empty = { groups: [], more: false }
  t.alike(idx.browse('trending', NOW, filters), empty, 'one active diary is below the threshold')
  t.ok(idx.addWriter(G, W, D2, 2))
  const row = { group: G, name: 'Cadeiras', creator: D1, community: C, communityName: 'Bairro', members: 2, created: NOW, active: null }
  t.alike(idx.browse('trending', NOW, filters), { groups: [{ ...row, active: 2 }], more: false })
  t.alike(idx.browse('members', NOW, filters), { groups: [row], more: false })
  t.alike(idx.browse('recent', NOW, filters), { groups: [row], more: false })
  activity.delete(W)
  t.alike(idx.browse('trending', NOW, filters), empty, 'the lookup is repeated on each query')
})

test('browse: trending counts distinct live diaries using its own member filter', (t) => {
  const idx = fixture()
  const duplicate = key(3)
  const left = key(4)
  const filtered = key(5)
  const departed = key(202)
  idx.addWriter(G, duplicate, D1, 3)
  idx.addWriter(G, left, key(203), 4)
  idx.addWriter(G, filtered, departed, 5)
  idx.setLeft(left, true)
  const result = idx.browse('trending', NOW, {
    lastActivity: () => NOW,
    members: () => true,
    activeMember: (diary, writer) => diary !== departed || writer !== filtered
  })
  t.alike(result.groups.map(({ group, members, active }) => [group, members, active]), [[G, 3, 2]])
})

test('browse: trending never counts a writer its members filter rejects, with no activeMember filter', (t) => {
  const idx = fixture()
  const other = key(6)
  const hidden = key(3)
  const hiddenDiary = key(202)
  idx.addWriter(G, hidden, hiddenDiary, 3)
  addGroup(idx, other)
  idx.addWriter(other, key(7), D2, 2)
  const result = idx.browse('trending', NOW, {
    lastActivity: () => NOW,
    members: (diary, writer) => diary !== hiddenDiary || writer !== hidden
  })
  t.alike(result.groups.map(({ group, members, active }) => [group, members, active]), [[G, 2, 2], [other, 2, 2]], 'the rejected writer posted lately but is not active')
  for (const row of result.groups) t.ok(row.active <= row.members, 'active ' + row.active + ' <= members ' + row.members)
  const unfiltered = idx.browse('trending', NOW, { lastActivity: () => NOW })
  t.alike(unfiltered.groups.map(({ group, members, active }) => [group, members, active]), [[G, 3, 3], [other, 2, 2]], 'without the filter it counts')
})

test('browse: trending uses an inclusive activity window and skips invalid or throwing activity', (t) => {
  const idx = fixture()
  const third = key(3)
  idx.addWriter(G, third, key(202), 3)
  t.is(TREND_WINDOW_MS, 604800000)
  t.is(TREND_MIN_ACTIVE, 2)
  const oldest = NOW - TREND_WINDOW_MS
  const newest = NOW + 86400000
  for (const time of [oldest, newest]) {
    const result = idx.browse('trending', NOW, {
      lastActivity: (writer) => {
        if (writer === third) throw new Error('lookup failed')
        return writer === W ? time : NOW
      },
      activeMember: null
    })
    t.alike(result.groups.map(({ group, active }) => [group, active]), [[G, 2]], String(time))
  }
  for (const time of [oldest - 1, newest + 1, NOW + 0.5, String(NOW), null]) {
    const result = idx.browse('trending', NOW, {
      lastActivity: (writer) => writer === W ? time : NOW,
      activeMember: (diary, writer) => {
        if (writer === third) throw new Error('filter failed')
        return true
      }
    })
    t.alike(result, { groups: [], more: false }, String(time))
  }
})

test('browse: trending requires effective join open and sorts by active then key', (t) => {
  const idx = fixture()
  const tied = key(3)
  const busiest = key(4)
  const approval = key(5)
  const closedByMeta = key(6)
  addGroup(idx, busiest, { at: NOW + CREATED_SKEW_MS + 1 })
  addGroup(idx, tied, { join: 'approval', at: NOW + CREATED_SKEW_MS })
  addGroup(idx, approval, { join: 'approval' })
  addGroup(idx, closedByMeta)
  idx.foldRoot(tied, groupMeta({ name: 'Cadeiras', join: 'open', at: iso(NOW) }))
  idx.foldRoot(closedByMeta, groupMeta({ name: 'Cadeiras', join: 'approval', at: iso(NOW) }))
  const activity = new Map([[G, NOW], [W, NOW]])
  for (const [i, group] of [tied, busiest, approval, closedByMeta].entries()) {
    const writer = key(300 + i)
    idx.addWriter(group, writer, D2, 2)
    activity.set(group, NOW)
    activity.set(writer, NOW)
    const extra = key(400 + i)
    idx.addWriter(group, extra, key(202), 3)
    if (group !== tied) activity.set(extra, NOW)
  }
  const result = idx.browse('trending', NOW, { lastActivity: (writer) => activity.get(writer) ?? null })
  t.alike(result.groups.map(({ group, active, members, created }) => [group, active, members, created]), [
    [busiest, 3, 3, null], [G, 2, 2, NOW], [tied, 2, 3, NOW + CREATED_SKEW_MS]
  ])
  inOrder(t, 'trending', result)
  t.is(result.more, false)
})

test('browse: trending caps the result after the activity threshold and listing filters', (t) => {
  const idx = createGroupIndex()
  addCommunity(idx)
  for (let i = BROWSE_MAX + 1; i >= 1; i--) {
    const group = key(i)
    addGroup(idx, group)
    idx.addWriter(group, key(300 + i), D2, 2)
  }
  const lastActivity = () => NOW
  const result = idx.browse('trending', NOW, { lastActivity })
  const first = Array.from({ length: BROWSE_MAX }, (_, i) => key(i + 1))
  t.alike(keysOf(result), first)
  inOrder(t, 'trending', result)
  t.is(result.more, true)
  t.is(idx.browse('trending', NOW, { lastActivity, visible: (group) => group !== G }).more, false)
  t.is(idx.browse('trending', NOW, { lastActivity: (writer) => writer === G ? null : NOW }).more, false)
})

test('generalOf: first create in fold order, rebuilt after resetRoot', (t) => {
  const idx = createGroupIndex()
  addCommunity(idx)
  t.is(idx.generalOf(C), null)
  addGroup(idx, key(9))
  addGroup(idx, G)
  t.is(idx.generalOf(C), key(9))
  t.ok(idx.resetRoot(C))
  t.is(idx.generalOf(C), null)
  t.ok(idx.foldRoot(C, groupCreateRecord({ group: G })))
  t.is(idx.generalOf(C), G)
})

test('publicGroupsOf: only listed open groups other than Geral with a live accepted join', (t) => {
  const idx = fixture()
  const open = key(10)
  const approval = key(11)
  const closedByMeta = key(12)
  const openedByMeta = key(13)
  addGroup(idx, open)
  addGroup(idx, approval, { join: 'approval' })
  addGroup(idx, closedByMeta)
  addGroup(idx, openedByMeta, { join: 'approval' })
  idx.foldRoot(closedByMeta, groupMeta({ name: 'Cadeiras', join: 'approval', at: iso(NOW) }))
  idx.foldRoot(openedByMeta, groupMeta({ name: 'Cadeiras', join: 'open', at: iso(NOW) }))
  for (const [i, group] of [open, approval, closedByMeta, openedByMeta].entries()) idx.addWriter(group, key(300 + i), D2, 2)
  const extra = key(400)
  idx.addWriter(open, extra, D2, 3)
  const row = { group: open, name: 'Cadeiras', creator: D1, community: C, communityName: 'Bairro', members: 2 }
  t.alike(idx.publicGroupsOf(D2), { groups: [row, { ...row, group: openedByMeta }], next: null })
  t.alike(keysOf(idx.browse('members', NOW)), [G, open, approval, closedByMeta, openedByMeta])
  const onlyExtra = { joined: (group, writer) => group === open && writer === extra }
  t.alike(idx.publicGroupsOf(D2, onlyExtra).groups, [row])
  idx.setLeft(extra, true)
  t.alike(idx.publicGroupsOf(D2, onlyExtra).groups, [], 'a left writer cannot qualify the group')
  t.alike(idx.publicGroupsOf(D2, { parent: () => false }).groups, [])
  t.alike(idx.publicGroupsOf(D2, { visible: () => false }).groups, [])
  t.alike(idx.publicGroupsOf(D2, { members: () => false }).groups, [])
})

test('publicGroupsOf: a private group the diary joined is never listed', (t) => {
  const idx = fixture()
  const P = key(20)
  // Join forced open and a name kept, so only the visibility can hide it.
  idx.setHeader(P, { ...groupHeader({ diary: D1, community: C, member: C, visibility: 'private', join: 'approval', box: key(300), at: iso(NOW) }), join: 'open', name: 'Cadeiras' })
  idx.foldRoot(C, groupCreateRecord({ group: P, at: iso(NOW) }))
  idx.addWriter(P, P, D1, 2)
  idx.addWriter(P, key(21), D2, 3)
  t.ok(idx.attached(C, P), 'attached like a public group')
  t.ok(idx.groupsOf(D2).some(({ group, left }) => group === P && !left), 'the diary has a live writer in it')
  t.alike(idx.publicGroupsOf(D2), { groups: [], next: null })
  t.alike(idx.publicGroupsOf(D1), { groups: [], next: null })
})

test('publicGroupsOf: joined runs only for groups the list would show, on every page', (t) => {
  const idx = fixture()
  t.is(idx.generalOf(C), G, 'G is Geral and D2 has a live writer in it')
  const open = key(10)
  const approval = key(11)
  const unnamed = key(12)
  const P = key(13)
  const loose = key(14)
  const later = key(15)
  addGroup(idx, open)
  addGroup(idx, approval, { join: 'approval' })
  addGroup(idx, unnamed)
  idx.foldRoot(unnamed, groupMeta({ name: null, join: 'open', at: iso(NOW) }))
  idx.setHeader(P, { ...groupHeader({ diary: D1, community: C, member: C, visibility: 'private', join: 'approval', box: key(300), at: iso(NOW) }), join: 'open', name: 'Cadeiras' })
  idx.foldRoot(C, groupCreateRecord({ group: P, at: iso(NOW) }))
  idx.addWriter(P, P, D1, 1)
  idx.setHeader(loose, header())
  idx.addWriter(loose, loose, D1, 1)
  addGroup(idx, later)
  for (const [i, group] of [open, approval, unnamed, P, loose, later].entries()) idx.addWriter(group, key(400 + i), D2, 2)
  t.absent(idx.attached(C, loose), 'no create names it')

  const calls = []
  const joined = (group, writer) => {
    calls.push(group)
    return true
  }
  const all = idx.publicGroupsOf(D2, { joined: () => true })
  t.alike(keysOf(all), [open, later])
  t.alike(idx.publicGroupsOf(D2, { joined }), all, 'the same rows as with joined true for all')
  t.alike(calls, [open, later])

  calls.length = 0
  const first = idx.publicGroupsOf(D2, { joined, limit: 1 })
  t.alike(keysOf(first), [open])
  t.is(first.next, open)
  t.alike(calls, [open, later], 'past the page too')
  calls.length = 0
  t.alike(idx.publicGroupsOf(D2, { joined, after: open }).groups.map((row) => row.group), [later])
  t.alike(calls, [open, later], 'before the cursor too')
})

test('publicGroupsOf: a larger limit is clamped to the page and odd limits answer null', (t) => {
  const idx = fixture()
  addCommunity(idx, C2)
  addGroup(idx, key(9), { community: C2 })
  // A catalogue holds 32 creates, so the rows span two communities.
  for (let i = 11; i <= 50; i++) addGroup(idx, key(i), { community: i > 30 ? C2 : C })
  const big = idx.publicGroupsOf(D1, { limit: 1000 })
  t.is(big.groups.length, PUBLIC_GROUPS_PAGE)
  t.is(big.next, key(10 + PUBLIC_GROUPS_PAGE))
  for (const limit of [0, -1, 1.5, '3']) t.is(idx.publicGroupsOf(D1, { limit }), null, String(limit))
})

test('publicGroupsOf: pages 33 groups in ascending key order with an exclusive cursor', (t) => {
  const idx = fixture()
  addCommunity(idx, C2)
  addGroup(idx, key(9), { community: C2 })
  for (let i = 43; i >= 11; i--) addGroup(idx, key(i), { community: i > 41 ? C2 : C })
  const expected = Array.from({ length: 33 }, (_, i) => key(i + 11))
  t.is(PUBLIC_GROUPS_PAGE, 32)
  const first = idx.publicGroupsOf(D1)
  t.alike(keysOf(first), expected.slice(0, 32))
  t.is(first.next, expected[31])
  const second = idx.publicGroupsOf(D1, { after: first.next })
  t.alike(keysOf(second), expected.slice(32))
  t.is(second.next, null)
  t.alike(idx.publicGroupsOf(D1, { after: expected[32] }), { groups: [], next: null })
  const short = idx.publicGroupsOf(D1, { limit: 1 })
  t.alike(keysOf(short), [expected[0]])
  t.is(short.next, expected[0])
})

test('discovery: unsupported orders and hostile inputs answer without throwing', (t) => {
  const idx = fixture()
  const fail = () => { throw new Error('x') }
  const hostile = { toString: fail, get visible () { return fail() } }
  t.alike(idx.browse('trending', NOW), { groups: [], more: false })
  t.is(idx.browse('x', NOW), null)
  t.is(idx.browse(hostile, NOW), null)
  t.is(idx.browse('members', hostile), null)
  t.is(idx.browse('members', NOW + 0.5), null)
  t.is(idx.browse('members', NOW, null), null)
  t.is(idx.browse('members', NOW, hostile), null)
  t.alike(idx.browse('members', NOW, { visible: fail }).groups, [])
  t.is(idx.generalOf(hostile), null)
  t.is(idx.publicGroupsOf(hostile), null)
  t.is(idx.publicGroupsOf(D2, { after: 'x' }), null)
  t.is(idx.publicGroupsOf(D2, { after: hostile }), null)
  t.is(idx.publicGroupsOf(D2, { limit: hostile }), null)
  t.is(idx.publicGroupsOf(D2, { limit: 0 }), null)
  t.is(idx.publicGroupsOf(D2, null), null)
  t.is(idx.publicGroupsOf(D2, hostile), null)
  t.alike(idx.publicGroupsOf(key(300)), { groups: [], next: null })
})
