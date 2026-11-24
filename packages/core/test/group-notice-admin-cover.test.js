'use strict'

// Group message notices and the admin grant cover (docs/protocol.md, "Admin
// grants cover the admin's devices"): a positive grant covers the admin's
// writers it does not list from an auto cut the hint cannot place (it has
// no causal order or writer generations), so what such a writer does makes
// the answers it could change unknown, never yes. A later demotion still
// gives no authority, and listed writers answer as before.
const test = require('brittle')
const { groupAdmit, groupBan, groupAdmin, communityBan, communityAdmit, buildGroup } = require('../lib/group')
const { UNKNOWN, createGroupHint } = require('../lib/group-notice')
const { K, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const B = K(0x3)
const D = K(0x6)
const cwA = K(0x20)
const cwA2 = K(0x21)
const cwB = K(0x30)
const cwD = K(0x60)
const G1 = K(0x100)
const wA = K(0x2000)
const wA2 = K(0x2001)
const wB = K(0x3000)
const wD = K(0x6000)

function hintOf (C, g) {
  const h0 = g.logs.get(g.key).entries[0].record
  const c0 = C.logs.get(C.key).entries[0].record
  const hint = createGroupHint({
    group: g.key,
    creator: h0.diary,
    join: h0.join,
    visibility: h0.visibility,
    community: { key: C.key, creator: c0.diary, join: c0.join }
  })
  for (const log of C.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true })
  for (const log of g.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
  return hint
}

// Every diary the hint calls a member, the fold calls a member.
function subset (t, C, g, label) {
  const r = buildGroup(g.input())
  t.is(r.incomplete, false, label + ': the fold is complete')
  const members = [...r.members].filter(([, st]) => st === 'member').map(([d]) => d)
  const hinted = hintOf(C, g).members()
  t.ok(Array.isArray(hinted), label + ': the hint decides')
  t.absent((hinted || []).some((d) => !members.includes(d)), label + ': every hinted member is a fold member')
  return { r, hinted }
}

// A community Z created with members A, B, D, group G1 in it, a writer in
// G1 for each, and a second G1 writer of A on the same CW.
function world ({ join = 'open', admins = [] } = {}) {
  const C = community({
    creator: Z,
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: D, cw: cwD, status: 'member' }
    ],
    admins,
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1, join })
  g.add(A, wA).add(A, wA2).add(B, wB).add(D, wD)
  return { C, g }
}

const grantA = (C, g) => g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: C.at() }))

test('a ban by an admin\'s unlisted writer leaves the banned diary unknown, never a member', (t) => {
  const { C, g } = world()
  grantA(C, g)
  g.push(wA2, groupBan({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  const { r, hinted } = subset(t, C, g, 'unlisted ban')
  t.is(r.members.get(D), 'banned', 'the fold counts the covered writer\'s ban')
  t.is(hintOf(C, g).allowed(D), UNKNOWN, 'D is unknown')
  t.absent(hinted.includes(D), 'no notice for D')
  t.alike(hinted, [A, B, Z].sort(), 'the others stay members')
})

test('a ban by an admin\'s listed writer still removes the diary', (t) => {
  const { C, g } = world()
  grantA(C, g)
  g.push(wA, groupBan({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  const { r, hinted } = subset(t, C, g, 'listed ban')
  t.is(r.members.get(D), 'banned')
  t.is(hintOf(C, g).allowed(D), false, 'D is not a member')
  t.alike(hinted, [A, B, Z].sort())
})

test('an admission through an admin\'s unlisted writer answers unknown', (t) => {
  const { C, g } = world({ join: 'approval' })
  grantA(C, g)
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: C.at() }))
  g.push(wA2, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  const { r, hinted } = subset(t, C, g, 'unlisted admit')
  t.is(r.members.get(D), 'member', 'the fold counts the covered writer\'s admit')
  const hint = hintOf(C, g)
  t.is(hint.allowed(D), UNKNOWN, 'D is unknown')
  t.is(hint.allowed(B), true, 'the listed writer\'s admit still counts')
  t.alike(hinted, [A, B, Z].sort())
})

test('an unban through an admin\'s unlisted writer answers unknown', (t) => {
  const { C, g } = world()
  grantA(C, g)
  const ban = g.push(wA, groupBan({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  g.push(wA2, groupBan({ member: D, on: false, lifts: ban, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  const { r, hinted } = subset(t, C, g, 'unlisted unban')
  t.is(r.members.get(D), 'member', 'the fold counts the covered writer\'s unban')
  t.is(hintOf(C, g).allowed(D), UNKNOWN, 'D is unknown')
  t.alike(hinted, [A, B, Z].sort())
})

test('a later demotion gives an unlisted writer no authority', (t) => {
  const { C, g } = world({ join: 'approval' })
  grantA(C, g)
  g.push(G1, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: g.len(wA) }], at: C.at() }))
  g.push(wA2, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  g.push(wA2, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: C.at() }))
  const { r } = subset(t, C, g, 'after demotion')
  t.not(r.members.get(D), 'member', 'the fold ignores the admit')
  const hint = hintOf(C, g)
  t.is(hint.allowed(D), false, 'D is not a member')
  t.is(hint.allowed(B), false, 'B was never admitted')
  t.is(hint.allowed(A), false, 'A, no longer an admin, was never admitted')
})

test('a ban in C by a C admin\'s unlisted CW leaves the diary unknown', (t) => {
  const { C, g } = world({ admins: [A] })
  C.addWriter(A, cwA2)
  C.push(cwA2, communityBan({ member: D, on: true, cuts: [{ writer: cwD, seq: 1 }], at: C.at() }))
  const { r, hinted } = subset(t, C, g, 'unlisted C ban')
  t.not(r.members.get(D), 'member', 'the fold counts the covered CW\'s ban')
  t.is(hintOf(C, g).allowed(D), UNKNOWN, 'D is unknown')
  t.alike(hinted, [A, B, Z].sort())
})

// An approval community admits A listing cwA only; A's later device gets a
// new CW (cwA2), admitted in the fold through the admit's cover of new
// devices, and a G1 writer wA3 naming it. The hint cannot place that cover.
const wA3 = K(0x2002)
function approvalWorld () {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: D, cw: cwD, status: 'member' }
    ],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1 })
  g.add(A, wA).add(B, wB).add(D, wD)
  C.addWriter(A, cwA2)
  g.add(A, wA3, { cw: cwA2 })
  return { C, g }
}

for (const [label, cuts] of [
  ['a grant listing only the old writer', [{ writer: wA, seq: 1 }]],
  ['a grant listing the new writer', [{ writer: wA, seq: 1 }, { writer: wA3, seq: 1 }]]
]) {
  test('approval community, ' + label + ': a ban from a device whose CW only the admit cover admits is unknown', (t) => {
    const { C, g } = approvalWorld()
    g.push(G1, groupAdmin({ member: A, on: true, cuts, at: C.at() }))
    g.push(wA3, groupBan({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
    const { r, hinted } = subset(t, C, g, label)
    t.is(r.members.get(D), 'banned', 'the fold counts the ban')
    t.is(hintOf(C, g).allowed(D), UNKNOWN, 'D is unknown, never a member')
    t.alike(hinted, [A, B, Z].sort(), 'the others stay members')
  })
}

test('approval community: a later withdrawal of the admit still leaves the new CW out', (t) => {
  const { C, g } = approvalWorld()
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA3, seq: 1 }], at: C.at() }))
  C.push(C.key, communityAdmit({ member: A, on: false, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  g.push(wA3, groupBan({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: C.at() }))
  const { r } = subset(t, C, g, 'withdrawn')
  t.is(r.members.get(D), 'member', 'the fold ignores the ban')
  t.is(hintOf(C, g).allowed(D), true, 'D stays a member')
})
