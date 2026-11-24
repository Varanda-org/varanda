'use strict'

// Group message notices and the sibling charter (docs/protocol.md, "Charter
// from the creator's other devices"): the hint has no causal order, so a
// meta or a grant on one of the creator's non-root writers makes the answers
// it could change unknown, never yes. Nobody else's charter off the root
// changes an answer.
const test = require('brittle')
const {
  groupAdmit, groupBan, groupAdmin, groupMeta, communityBan, communityGrant, communityMetaCw, communityAdmit, buildGroup
} = require('../lib/group')
const { UNKNOWN, createGroupHint } = require('../lib/group-notice')
const { K, AT, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const B = K(0x3)
const X = K(0x4)
const Y = K(0x5)
const cwA = K(0x20)
const cwB = K(0x30)
const cwX = K(0x40)
const cwY = K(0x50)
const cwZ = K(0x91)
const G1 = K(0x100)
const wA = K(0x2000)
const wB = K(0x3000)
const wX = K(0x4000)
const wY = K(0x5000)
const wZ = K(0x9001)

function hintOf (C, g, { rootBound = true } = {}) {
  const h0 = g.logs.get(g.key).entries[0].record
  const c0 = C.logs.get(C.key).entries[0].record
  const hint = createGroupHint({
    group: g.key,
    creator: h0.diary,
    join: h0.join,
    visibility: h0.visibility,
    community: { key: C.key, creator: c0.diary, join: c0.join },
    rootBound
  })
  for (const log of C.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true })
  for (const log of g.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
  return hint
}

function foldOf (t, g) {
  const r = buildGroup(g.input())
  t.is(r.incomplete, false, 'the fold is complete')
  return r
}

// Every diary the hint calls a member, the fold calls a member.
function subset (t, C, g, label) {
  const r = foldOf(t, g)
  const members = [...r.members].filter(([, st]) => st === 'member').map(([d]) => d)
  const hinted = hintOf(C, g).members()
  t.absent((hinted || []).some((d) => !members.includes(d)), label + ': every hinted member belongs to the fold')
  return r
}

// A community Z created with members A, B, X, Y, group G1 in it, a writer
// in G1 for each, and a second device of Z (CW cwZ, G1 writer wZ).
function world ({ join = 'open', cjoin = 'open', bindRoot = true } = {}) {
  const C = community({
    creator: Z,
    join: cjoin,
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: X, cw: cwX, status: 'member' },
      { diary: Y, cw: cwY, status: 'member' }
    ],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1, join, bindRoot })
  C.addWriter(Z, cwZ)
  g.add(A, wA).add(B, wB).add(X, wX).add(Y, wY).add(Z, wZ, { cw: cwZ })
  return { C, g }
}

test('a creator sibling meta switching open to approval makes a later joiner unknown', (t) => {
  const { C, g } = world()
  t.is(hintOf(C, g).allowed(A), true, 'an open group')
  g.push(wZ, groupMeta({ name: 'Varanda', join: 'approval', at: AT(20) }))
  const r = subset(t, C, g, 'sibling meta')
  t.is(r.join, 'approval', 'the fold counts the sibling meta')
  t.not(r.members.get(A), 'member', 'the fold asks A for an admit')
  const h = hintOf(C, g)
  t.is(h.allowed(A), UNKNOWN, 'never member')
  t.is(h.allowed(Z), true, 'the creator stays')
})

test('a creator sibling meta keeping the join leaves the answer definite', (t) => {
  const { C, g } = world()
  g.push(wZ, groupMeta({ name: 'Outro nome', join: 'open', at: AT(20) }))
  subset(t, C, g, 'same join')
  t.is(hintOf(C, g).allowed(A), true)
})

test('a ban by an admin granted only from a sibling writer leaves the banned diary unknown', (t) => {
  const { C, g } = world()
  g.push(wZ, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g.push(wA, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
  const r = subset(t, C, g, 'sibling-granted ban')
  t.is(r.members.get(B), 'banned', 'the fold counts the ban')
  const h = hintOf(C, g)
  t.is(h.allowed(B), UNKNOWN, 'never member')
  t.absent(h.members().includes(B))
  t.is(h.allowed(X), true, 'others stay members')
})

test('an admission by an admin a sibling demoted answers unknown', (t) => {
  const { C, g } = world({ join: 'approval' })
  const grant = g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g.push(wZ, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 1 }], seen: grant, at: AT(21) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
  const r = subset(t, C, g, 'demoted admit')
  t.not(r.members.get(B), 'member', 'the fold voids the admit')
  t.is(hintOf(C, g).allowed(B), UNKNOWN, 'never member')
})

test('an unban by an admin a sibling demoted answers unknown', (t) => {
  const { C, g } = world()
  const ban = g.push(G1, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(20) }))
  const grant = g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(21) }))
  g.push(wZ, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 1 }], seen: grant, at: AT(22) }))
  g.push(wA, groupBan({ member: B, on: false, lifts: ban, cuts: [{ writer: wB, seq: 1 }], at: AT(23) }))
  const r = subset(t, C, g, 'demoted unban')
  t.is(r.members.get(B), 'banned', 'the fold keeps the ban')
  t.is(hintOf(C, g).allowed(B), UNKNOWN, 'never member')
})

test('a C ban by an admin granted from a creator CW leaves the banned diary unknown', (t) => {
  const { C, g } = world()
  C.push(cwZ, communityGrant({ member: A, cuts: [{ writer: cwA, seq: 1 }], at: AT(20) }))
  C.push(cwA, communityBan({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], at: AT(21) }))
  const r = subset(t, C, g, 'C sibling grant')
  t.not(r.members.get(B), 'member', 'the fold bans B in C')
  t.is(hintOf(C, g).allowed(B), UNKNOWN, 'never member')
})

test('a creator CW meta switching C to approval makes its members unknown', (t) => {
  const { C, g } = world()
  C.push(cwZ, communityMetaCw({ name: 'Bairro', join: 'approval', at: AT(20) }))
  const r = subset(t, C, g, 'C sibling meta')
  t.not(r.members.get(A), 'member', 'A was never admitted in C')
  t.is(hintOf(C, g).allowed(A), UNKNOWN, 'never member')
})

test('a non-creator meta or grant off the root changes no answer', (t) => {
  const { C, g } = world({ join: 'approval' })
  g.push(G1, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(19) }))
  const before = hintOf(C, g).members()
  g.push(wX, groupMeta({ name: 'Outro', join: 'open', at: AT(20) }))
  g.push(wX, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(21) }))
  g.push(wX, groupAdmin({ member: Y, on: false, cuts: [{ writer: wY, seq: 1 }], at: AT(22) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(23) }))
  C.push(cwX, communityGrant({ member: A, cuts: [{ writer: cwA, seq: 1 }], at: AT(24) }))
  C.push(cwX, communityMetaCw({ name: 'Bairro', join: 'approval', at: AT(25) }))
  C.push(cwA, communityBan({ member: Y, on: true, cuts: [{ writer: cwY, seq: 1 }], at: AT(26) }))
  C.push(cwA, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], at: AT(27) }))
  const r = foldOf(t, g)
  const members = [...r.members].filter(([, st]) => st === 'member').map(([d]) => d).sort()
  const h = hintOf(C, g)
  t.alike(h.members(), before, 'the same answers')
  t.alike(h.members(), members, 'the same members as buildGroup')
  t.is(h.allowed(A), false, 'A is no admin and was never admitted')
  t.is(h.allowed(B), false, 'a non-admin admit is ignored')
  t.is(h.allowed(Y), true, 'a non-admin ban is ignored')
})

// The fold drops another diary's charter off the root (dropForeignCharter),
// so a reference to it orders nothing there and must not here.
test('a non-creator meta off the root is no node to order an admit after', (t) => {
  const { C, g } = world({ join: 'approval' })
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  g.push(G1, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(11) }))
  g.push(wX, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], at: AT(15) }))
  const meta = g.push(wX, groupMeta({ name: 'Outro', join: 'open', at: AT(16) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: meta, at: AT(1) }))
  const r = subset(t, C, g, 'foreign node')
  t.not(r.members.get(B), 'member', 'the fold sees no order and keeps the off')
  t.not(hintOf(C, g).allowed(B), true, 'never member')
})

// The fold drops an unbound root's records and every charter off the root,
// whose cuts would otherwise order the records they name.
test('an unbound root answers unknown, never yes', (t) => {
  const { C, g } = world({ join: 'approval', bindRoot: false })
  g.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(10) }))
  const ban = g.push(G1, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(11) }))
  g.push(G1, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(12) }))
  g.push(wZ, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 2 }], at: AT(13) }))
  g.push(wA, groupBan({ member: Y, on: false, lifts: ban, cuts: [{ writer: wY, seq: 1 }], at: AT(14) }))
  const r = buildGroup(g.input())
  t.is(r.incomplete, true, 'the fold is incomplete')
  t.not(r.members.get(B), 'member', 'the root admits nobody')
  t.not(r.members.get(Y), 'member')
  const bound = hintOf(C, g)
  t.is(bound.allowed(B), true, 'a caller claiming a bound root gets the root\'s answer')
  const h = hintOf(C, g, { rootBound: false })
  t.is(h.allowed(B), UNKNOWN, 'never member')
  t.is(h.allowed(Y), UNKNOWN, 'never member')
  t.is(h.members(), null)
  t.is(createGroupHint({ group: G1, creator: Z, join: 'open', community: { key: C.key, creator: Z, join: 'open' }, rootBound: 'yes' }).members(), null, 'a bad rootBound')
  const hc = hintOf(C, world().g)
  t.ok(hc.members().length > 0, 'a bound community')
  const c0 = C.logs.get(C.key).entries[0].record
  const h2 = createGroupHint({ group: G1, creator: Z, join: 'approval', community: { key: C.key, creator: c0.diary, join: c0.join, rootBound: false } })
  t.is(h2.members(), null, 'an unbound community root')
})
