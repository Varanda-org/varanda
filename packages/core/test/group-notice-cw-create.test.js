'use strict'

// Group message notices and group-create on a CW: the fold drops another
// diary's CW group-create before the causal order (dropForeignCharter), so a
// reference to it orders nothing there and must not in the hint either. The
// creator's own CW creates are nodes of both.
const test = require('brittle')
const { communityAdmit, groupCreateRecord, buildGroup } = require('../lib/group')
const { createGroupHint } = require('../lib/group-notice')
const { K, AT, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const B = K(0x3)
const X = K(0x4)
const cwA = K(0x20)
const cwB = K(0x30)
const cwX = K(0x40)
const cwZ = K(0x91)
const G1 = K(0x100)
const G2 = K(0x101)
const wA = K(0x2000)
const wB = K(0x3000)
const wX = K(0x4000)

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
  t.absent((hinted || []).some((d) => !members.includes(d)), label + ': every hinted member belongs to the fold')
  return r
}

// An approval community Z created with admins A and X and member B, group
// G1 in it with a writer for each, and a second device of Z (CW cwZ).
function world () {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: X, cw: cwX, status: 'member' }
    ],
    admins: [A, X],
    creates: [{ by: Z, group: G1 }]
  })
  C.addWriter(Z, cwZ)
  const g = groupIn(C, { key: G1 })
  g.add(A, wA).add(B, wB).add(X, wX)
  return { C, g }
}

test('a non-creator CW create is no node to order a C admit after', (t) => {
  const { C, g } = world()
  t.is(hintOf(C, g).allowed(B), true, 'control: B is admitted')
  C.push(cwX, communityAdmit({ member: B, on: false, cuts: [{ writer: cwB, seq: 1 }], at: AT(15) }))
  const made = C.push(cwX, groupCreateRecord({ group: G2, at: AT(16) }))
  C.push(cwA, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], seen: made, at: AT(1) }))
  const r = subset(t, C, g, 'foreign create')
  t.not(r.members.get(B), 'member', 'the fold sees no order and keeps the off')
  t.not(hintOf(C, g).allowed(B), true, 'never member')
})

// The creator's own CW create is a node of both: the hint, like the fold,
// orders an admit naming it after the creator's earlier off on that CW.
test('a creator CW create still orders a C admit after it', (t) => {
  const { C, g } = world()
  C.push(cwZ, communityAdmit({ member: B, on: false, cuts: [{ writer: cwB, seq: 1 }], at: AT(15) }))
  const made = C.push(cwZ, groupCreateRecord({ group: G2, at: AT(16) }))
  C.push(cwA, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], seen: made, at: AT(1) }))
  const r = subset(t, C, g, 'creator create')
  t.is(r.members.get(B), 'member', 'the fold orders the on after the off')
  t.is(hintOf(C, g).allowed(B), true, 'and so does the hint')
})
