'use strict'

// Group message notices (group-notice.js): the membership hint a seeder
// keeps per group, checked against buildGroup on shared fixtures, and the
// notice event and sentence rules.
const test = require('brittle')
const b4a = require('b4a')
const {
  groupPost, groupHide, groupReact, groupAdmit, groupBan, groupAdmin, groupLeave, groupMeta,
  groupSealed, groupKey, groupImage, groupAbout, groupHeader, writerHeader, communityAdmit, communityBan, buildGroup
} = require('../lib/group')
const {
  UNKNOWN, MAX_NOTICE_RECIPIENTS, MAX_GROUP_HINT_BYTES, GROUP_HINT_DIGEST_BYTES,
  GROUP_HINT_BLOCK_BYTES, GROUP_HINT_ENTRY_BYTES, GROUP_HINT_REFERENCE_BYTES, GROUP_HINT_WORK_PER_BLOCK,
  createGroupHint, createGroupHintBudget, noticeFor, noticeName, validateGroupNotice, groupSentence
} = require('../lib/group-notice')
const { K, AT, NOW, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const B = K(0x3)
const X = K(0x4)
const Y = K(0x5)
const D = K(0x6)
const cwA = K(0x20)
const cwB = K(0x30)
const cwX = K(0x40)
const cwY = K(0x50)
const cwD = K(0x60)
const G1 = K(0x100)
const wA = K(0x2000)
const wB = K(0x3000)
const wX = K(0x4000)
const wY = K(0x5000)
const wD = K(0x6000)

// Every block of C's and G's cores, as a seeder serving both holds them.
function hintOf (C, g, { feed = true, ...limits } = {}) {
  const h0 = g.logs.get(g.key).entries[0].record
  const c0 = C.logs.get(C.key).entries[0].record
  const hint = createGroupHint({
    group: g.key,
    creator: h0.diary,
    join: h0.join,
    visibility: h0.visibility,
    community: { key: C.key, creator: c0.diary, join: c0.join },
    ...limits
  })
  if (feed) {
    for (const log of C.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true })
    for (const log of g.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
    for (const input of [C.input(), g.input()]) {
      for (const [diary, marks] of input.marks) for (const m of marks) hint.mark(diary, m.writer, m.cut)
    }
  }
  return hint
}

function foldOf (g) {
  const r = buildGroup(g.input())
  return { r, members: [...r.members].filter(([, st]) => st === 'member').map(([d]) => d).sort() }
}

// The hint's members equal the fold's on a complete fold.
function parity (t, C, g, label) {
  const { r, members } = foldOf(g)
  t.is(r.incomplete, false, label + ': the fold is complete')
  t.alike(hintOf(C, g).members(), members, label + ': same members as buildGroup')
  return members
}

const open4 = (extra = {}) => community({
  creator: Z,
  members: [
    { diary: A, cw: cwA, status: 'member' },
    { diary: B, cw: cwB, status: 'member' },
    { diary: X, cw: cwX, status: 'member' },
    { diary: Y, cw: cwY, status: 'member' },
    { diary: D, cw: cwD, status: 'member' }
  ],
  creates: [{ by: Z, group: G1 }],
  ...extra
})

function withWriters (g) {
  return g.add(A, wA).add(B, wB).add(X, wX).add(Y, wY).add(D, wD)
}

test('approval group: a non-admin admit is ignored, an admin the creator named admits, ban and leave remove', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  let s = 10
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(s++) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(s++) }))
  g.push(wX, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(s++) }))
  g.push(G1, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: AT(s++) }))

  let hint = hintOf(C, g)
  t.is(hint.allowed(Z), true, 'the creator')
  t.is(hint.allowed(A), true, 'an admin needs no admit')
  t.is(hint.allowed(B), true, 'admitted by an admin the creator named')
  t.is(hint.allowed(X), false, 'never admitted')
  t.is(hint.allowed(Y), false, 'a non-admin admit is ignored')
  t.is(hint.allowed(D), true, 'admitted by the creator')
  t.is(hint.allowed(K(0x77)), false, 'a diary with no writer here')
  t.is(hint.allowed('nope'), false)
  t.alike(parity(t, C, g, 'admits'), [A, B, D, Z].sort())

  g.push(G1, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: g.len(wB) }], at: AT(s++) }))
  g.push(wD, groupLeave({ cuts: [{ writer: wD, seq: g.len(wD) }], at: AT(s++) }))
  hint = hintOf(C, g)
  t.is(hint.allowed(B), false, 'banned')
  t.is(hint.allowed(D), false, 'left')
  t.alike(parity(t, C, g, 'ban and leave'), [A, Z].sort())
})

test('open group: everyone with a writer, a non-admin ban is ignored, an unban lifts', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  let s = 10
  g.push(wX, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(s++) }))
  t.alike(parity(t, C, g, 'non-admin ban'), [A, B, D, X, Y, Z].sort())
  const ban = g.push(G1, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(s++) }))
  t.is(hintOf(C, g).allowed(Y), false)
  t.alike(parity(t, C, g, 'creator ban'), [A, B, D, X, Z].sort())
  g.push(G1, groupBan({ member: Y, on: false, lifts: ban, cuts: [{ writer: wY, seq: 1 }], at: AT(s++) }))
  t.is(hintOf(C, g).allowed(Y), true)
  t.alike(parity(t, C, g, 'unban'), [A, B, D, X, Y, Z].sort())
  // The creator and an admin cannot be banned.
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(s++) }))
  g.push(wA, groupBan({ member: Z, on: true, at: AT(s++) }))
  g.push(G1, groupBan({ member: A, on: true, at: AT(s++) }))
  t.alike(parity(t, C, g, 'shielded'), [A, B, D, X, Y, Z].sort())

  // The fold only accepts G created by C's creator, whose CWs cannot
  // acquire a ban layer. A secondary creator writer still acts here.
  const cwZ = C.addWriter(Z, K(0x91))
  const wZ = K(0x9001)
  g.add(Z, wZ, { cw: cwZ })
  C.push(C.key, communityBan({ member: Z, on: true, cuts: [{ writer: cwZ, seq: 1 }], at: C.at() }))
  const banZ = g.push(wZ, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(s++) }))
  t.is(foldOf(g).r.community.members.get(Z), 'member', 'C ignores a ban of its creator')
  t.is(hintOf(C, g).allowed(B), false, 'the secondary creator writer still bans')
  t.alike(parity(t, C, g, 'secondary creator writer'), [A, D, X, Y, Z].sort())
  g.push(G1, groupBan({ member: B, on: false, lifts: banZ, cuts: [{ writer: wB, seq: 1 }], at: AT(s++) }))
  t.is(hintOf(C, g).allowed(B), true, 'the root keeps its own authority')
  t.alike(parity(t, C, g, 'creator root'), [A, B, D, X, Y, Z].sort())
})

test('community: a C-wide ban, a C ban naming G, and leaving C remove a member', (t) => {
  const C = community({
    creator: Z,
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: X, cw: cwX, status: 'member' },
      { diary: Y, cw: cwY, status: 'left' },
      { diary: D, cw: cwD, status: 'member' }
    ],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1 }).add(A, wA).add(B, wB).add(X, wX).add(D, wD)
  // Y's writer names its old CW, which left C.
  g.add(Y, wY)
  t.is(hintOf(C, g).allowed(Y), false, 'left C')
  t.alike(parity(t, C, g, 'left C'), [A, B, D, X, Z].sort())

  // D is no C admin: its bans, in C or naming G, are ignored.
  C.push(cwD, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: C.len(cwX) }], at: C.at() }))
  C.push(cwD, communityBan({ group: G1, member: B, on: true, at: C.at() }))
  t.is(hintOf(C, g).allowed(X), true)
  t.is(hintOf(C, g).allowed(B), true)
  t.alike(parity(t, C, g, 'non-admin C bans'), [A, B, D, X, Z].sort())

  C.push(C.key, communityBan({ member: B, on: true, cuts: [{ writer: cwB, seq: C.len(cwB) }], at: C.at() }))
  t.is(hintOf(C, g).allowed(B), false, 'a ban in C (group: null)')
  t.alike(parity(t, C, g, 'C ban'), [A, D, X, Z].sort())

  C.push(cwA, communityBan({ group: G1, member: X, on: true, at: C.at() }))
  t.is(hintOf(C, g).allowed(X), false, 'a C admin\'s ban naming G')
  t.alike(parity(t, C, g, 'C ban naming G'), [A, D, Z].sort())

  // D is no C admin: its ban naming G is ignored.
  C.push(cwD, communityBan({ group: G1, member: A, on: true, at: C.at() }))
  C.push(cwD, communityBan({ group: K(0x101), member: A, on: true, at: C.at() }))
  t.is(hintOf(C, g).allowed(A), true)
  t.alike(parity(t, C, g, 'non-admin C ban'), [A, D, Z].sort())
})

test('community: approval C and a C admin admitting into an approval G', (t) => {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: X, cw: cwX, status: 'requested' }
    ],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1, join: 'approval' }).add(A, wA).add(B, wB).add(X, wX)
  const hint = hintOf(C, g)
  t.is(hint.allowed(X), false, 'not admitted into C')
  t.is(hint.allowed(A), true, 'a C admin counts as admitted in G')
  t.is(hint.allowed(B), false, 'not admitted into G')
  t.alike(parity(t, C, g, 'approval C'), [A, Z].sort())
  C.push(cwA, communityAdmit({ group: G1, member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: C.at() }))
  t.is(hintOf(C, g).allowed(B), true, 'admitted by a C admin naming G')
  t.alike(parity(t, C, g, 'C admit naming G'), [A, B, Z].sort())
})

test('parity: join change, private group, demotion', (t) => {
  {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1 }))
    g.push(G1, groupMeta({ name: 'Varanda', join: 'approval', at: AT(20) }))
    t.alike(parity(t, C, g, 'meta to approval'), [Z])
    g.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    t.alike(parity(t, C, g, 'then admitted'), [B, Z].sort())
  }
  {
    const C = open4()
    const g = groupIn(C, { key: G1, visibility: 'private', join: 'approval', box: K(0x7701) })
    g.add(A, wA, { box: K(0x7702) }).add(B, wB, { box: K(0x7703) })
    g.push(G1, groupAdmit({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    const hint = hintOf(C, g)
    t.is(hint.allowed(A), true)
    t.is(hint.allowed(B), false)
    t.alike(parity(t, C, g, 'private'), [A, Z].sort())
  }
  {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    g.push(G1, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(22) }))
    // The admit came before the demotion's cut: it stays.
    t.alike(parity(t, C, g, 'demoted after admitting'), [B, Z].sort())
    g.push(wA, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: AT(23) }))
    t.is(hintOf(C, g).allowed(D), false, 'a demoted admin admits nobody')
    t.alike(parity(t, C, g, 'admit after demotion'), [B, Z].sort())
  }
})

test('an admin\'s admit of itself never counts', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g.push(wA, groupAdmit({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(21) }))
  g.push(G1, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(22) }))
  t.is(hintOf(C, g).allowed(A), false, 'demoted, and never admitted')
  t.alike(parity(t, C, g, 'self admit'), [Z])
})

test('unknown: incomplete, bad config, creator leave, fork, rejoin, unordered admits', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const hint = hintOf(C, g)
  t.is(hint.allowed(A), true)
  hint.incomplete()
  t.is(hint.allowed(A), UNKNOWN, 'incomplete')
  t.is(hint.members(), null)

  const bad = createGroupHint({ creator: Z, join: 'open' })
  t.is(bad.allowed(Z), UNKNOWN, 'no group nor community')
  t.is(bad.members(), null)
  t.is(bad.add(groupPost({ text: 'x', at: AT(1) }), { diary: Z, writer: G1, seq: 1 }), false)
  const c0 = { key: C.key, creator: Z, join: 'open' }
  t.is(createGroupHint({ group: G1, creator: Z, join: 'open', visibility: 'private', community: c0 }).members(), null, 'private and open')
  t.is(createGroupHint({ group: G1, creator: Z, join: 'shut', community: c0 }).members(), null)
  t.is(createGroupHint({ group: G1, creator: Z, join: 'open', community: { ...c0, join: 'x' } }).members(), null)
  t.alike(createGroupHint({ group: G1, creator: Z, join: 'open', community: c0 }).members(), [Z], 'nothing fed: the creator alone')

  {
    const h = hintOf(C, g)
    h.add(groupLeave({ cuts: [], at: AT(50) }), { diary: Z, writer: C.key, seq: C.len(C.key), community: true })
    t.is(h.members(), null, 'the creator left C')
  }
  {
    const h = hintOf(C, g)
    t.ok(h.add(groupAdmit({ member: B, on: true, cuts: [], at: AT(50) }), { diary: Z, writer: G1, seq: 1 }))
    t.is(h.members().length, 6)
    h.add(groupAdmit({ member: B, on: false, cuts: [], at: AT(50) }), { diary: Z, writer: G1, seq: 1 })
    t.is(h.members(), null, 'two blocks for one seq')
  }
  {
    const C2 = open4()
    const g2 = withWriters(groupIn(C2, { key: G1 }))
    const leave = g2.push(wB, groupLeave({ cuts: [{ writer: wB, seq: g2.len(wB) }], at: AT(30) }))
    g2.logs.set(K(0x3001), { key: K(0x3001), diary: B, entries: [{ seq: 0, record: writerHeader({ group: G1, diary: B, member: cwB, rejoin: leave, at: AT(31) }) }] })
    g2.joins.get(B).push({ writer: K(0x3001), on: true, seq: 10 })
    const h = hintOf(C2, g2)
    t.is(h.allowed(B), UNKNOWN, 'back after a leave')
    t.absent(h.members().includes(B))
    t.ok(foldOf(g2).members.includes(B), 'the fold has it back: the hint only leaves it out')
  }
  {
    const C2 = open4()
    const g2 = withWriters(groupIn(C2, { key: G1, join: 'approval' }))
    g2.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    g2.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
    g2.push(G1, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    const h = hintOf(C2, g2)
    t.is(h.allowed(B), UNKNOWN, 'an admit and a withdrawal on two cores, neither naming the other')
    t.absent(h.members().includes(B))
    // Ordered by a reference, it is decided.
    g2.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: { writer: wA, seq: 1 }, at: AT(23) }))
    t.is(hintOf(C2, g2).allowed(B), true, 'a later admit on the root')
    t.alike(parity(t, C2, g2, 'ordered'), [A, B, Z].sort())
  }
})

test('a group writer naming another diary\'s CW counts for no one', (t) => {
  const C = open4()
  const g = groupIn(C, { key: G1 }).add(A, wA).add(B, wB, { cw: cwA })
  t.is(hintOf(C, g).allowed(B), false)
  t.alike(parity(t, C, g, 'borrowed CW'), [A, Z].sort())
  // Its records count for no one either.
  g.push(wB, groupBan({ member: A, on: true, at: AT(30) }))
  t.alike(parity(t, C, g, 'borrowed CW records'), [A, Z].sort())
  // A CW the hint never saw: the writer may count, so its records make all unknown.
  const h = hintOf(C, g, { feed: false })
  for (const log of g.logs.values()) for (const e of log.entries) h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
  t.is(h.members(), null, 'the CW headers are missing')
})

test('a reference past what a core holds orders nothing', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: { writer: G1, seq: 100 }, at: AT(21) }))
  g.push(G1, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
  t.not(hintOf(C, g).allowed(B), true)
  t.alike(parity(t, C, g, 'seen past the root'), [A, Z].sort())
  // Within what the root holds, the same reference orders.
  const g2 = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g2.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g2.push(G1, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
  g2.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: { writer: G1, seq: 2 }, at: AT(21) }))
  t.is(hintOf(C, g2).allowed(B), true)
  t.alike(parity(t, C, g2, 'seen within the root'), [A, B, Z].sort())
})

test('a rejoin must name a leave of the same diary', (t) => {
  const C = open4()
  const g = groupIn(C, { key: G1 }).add(A, wA)
  const leave = g.push(wA, groupLeave({ cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(30) }))
  g.add(B, K(0x3001), { rejoin: leave })
  t.is(hintOf(C, g).allowed(B), false, 'B names A\'s leave')
  t.alike(parity(t, C, g, 'foreign rejoin'), [Z])
  // Naming a block that is no leave.
  const g2 = groupIn(C, { key: G1 }).add(A, wA)
  const post = g2.push(wA, groupPost({ text: 'oi', at: AT(30) }))
  g2.add(A, K(0x2001), { rejoin: post })
  t.alike(parity(t, C, g2, 'rejoin naming a post'), [A, Z].sort())
  t.is(hintOf(C, g2).allowed(A), true, 'A counts through its first writer')
})

test('an unban in C that lists no CW keeps the diary\'s CWs banned', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const ban = C.push(C.key, communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  C.push(C.key, communityBan({ member: A, on: false, lifts: ban, cuts: [], at: C.at() }))
  t.is(hintOf(C, g).allowed(A), false, 'every CW of A stays banned')
  t.alike(parity(t, C, g, 'unban listing no CW'), [B, D, X, Y, Z].sort())
  C.push(C.key, communityBan({ member: A, on: false, lifts: ban, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  t.is(hintOf(C, g).allowed(A), true, 'an unban listing its CW')
  t.alike(parity(t, C, g, 'unban listing the CW'), [A, B, D, X, Y, Z].sort())
})

for (const visibility of ['public', 'private']) {
  test('parity: ' + visibility + ' admits need the admin writer\'s own live CW', (t) => {
    const C = open4()
    const cwA2 = C.addWriter(A, K(0x21))
    const wA2 = K(0x2001)
    const box = visibility === 'private' ? K(0x7701) : null
    const g = groupIn(C, { key: G1, join: 'approval', visibility, box })
      .add(A, wA, { box }).add(A, wA2, { cw: cwA2, box }).add(B, wB, { box })
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA2, seq: 1 }], at: AT(20) }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    t.is(hintOf(C, g).allowed(B), true, 'a live admin writer admits')
    t.alike(parity(t, C, g, 'live CW'), [A, B, Z].sort())

    const ban = C.push(C.key, communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }, { writer: cwA2, seq: 1 }], at: C.at() }))
    C.push(C.key, communityBan({ member: A, on: false, lifts: ban, cuts: [{ writer: cwA2, seq: 1 }], at: C.at() }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
    const { r } = foldOf(g)
    t.is(r.community.members.get(A), 'member', 'the diary is back in C on CW2')
    t.is(r.members.get(B), 'requested', 'the fold ignores admits tied to the still-banned CW1')
    t.is(hintOf(C, g).allowed(B), false, 'the hint also ignores those admits')
    t.alike(parity(t, C, g, 'selective unban'), [A, Z].sort())

    g.push(wA2, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(23) }))
    t.is(hintOf(C, g).allowed(B), true, 'a grant on the live CW2 still admits')
    t.alike(parity(t, C, g, 'live second writer'), [A, B, Z].sort())

    g.push(wA, groupLeave({ cuts: [{ writer: wA, seq: 3 }, { writer: wA2, seq: 2 }], at: AT(24) }))
    t.is(foldOf(g).r.members.get(A), 'left', 'the CW gate does not discard a leave')
    t.is(hintOf(C, g).allowed(A), false, 'the hint keeps the leave too')
  })
}

test('parity: bans, lifts and admit withdrawals need the group writer\'s live CW', (t) => {
  for (const visibility of ['public', 'private']) {
    for (const action of ['ban', 'lift', 'withdraw']) {
      const C = open4()
      const cwA2 = C.addWriter(A, K(0x21))
      const box = visibility === 'private' ? K(0x7701) : null
      const g = groupIn(C, { key: G1, join: 'approval', visibility, box })
        .add(A, wA, { box }).add(B, wB, { box })
      g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
      g.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
      const cuts = [{ writer: wB, seq: 1 }]
      if (action === 'ban') g.push(wA, groupBan({ member: B, on: true, cuts, at: AT(23) }))
      if (action === 'lift') {
        const lifts = g.push(G1, groupBan({ member: B, on: true, cuts, at: AT(22) }))
        g.push(wA, groupBan({ member: B, on: false, lifts, cuts, at: AT(23) }))
      }
      if (action === 'withdraw') g.push(wA, groupAdmit({ member: B, on: false, cuts, seen: { writer: G1, seq: 2 }, at: AT(23) }))
      const ban = C.push(C.key, communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: C.at() }))
      C.push(C.key, communityBan({ member: A, on: false, lifts: ban, cuts: [{ writer: cwA2, seq: 1 }], at: C.at() }))
      const { r } = foldOf(g)
      t.is(r.members.get(B), action === 'lift' ? 'banned' : 'member', 'the fold ignores ' + action + ' on CW1')
      t.is(hintOf(C, g).allowed(B), action !== 'lift', 'the hint ignores ' + action + ' on CW1')
      parity(t, C, g, visibility + ' ' + action)
    }
  }
})

test('an admit in C that lists none of the diary\'s CWs leaves it out', (t) => {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: X, cw: cwX, status: 'requested' }
    ],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1 }).add(A, wA).add(X, wX)
  C.push(C.key, communityAdmit({ member: X, on: true, cuts: [{ writer: K(0x41), seq: 1 }], at: C.at() }))
  // The fold may give the CW automatic cuts; the hint never counts on them.
  t.is(hintOf(C, g).allowed(X), UNKNOWN)
  t.alike(hintOf(C, g).members(), [A, Z].sort())
  t.ok(foldOf(g).members.includes(X), 'the fold has it: the hint only leaves it out')
  C.push(C.key, communityAdmit({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: C.at() }))
  t.is(hintOf(C, g).allowed(X), true)
  t.alike(parity(t, C, g, 'admit listing the CW'), [A, X, Z].sort())
})

test('an unban before the ban it names lifts nothing', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  g.push(G1, groupBan({ member: Y, on: false, lifts: { writer: G1, seq: 2 }, cuts: [{ writer: wY, seq: 1 }], at: AT(20) }))
  g.push(G1, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(21) }))
  t.is(hintOf(C, g).allowed(Y), false)
  t.alike(parity(t, C, g, 'unban first'), [A, B, D, X, Z].sort())
  // On another core, naming the ban orders the unban after it.
  const g2 = withWriters(groupIn(C, { key: G1 }))
  g2.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  const ban = g2.push(G1, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(21) }))
  g2.push(wA, groupBan({ member: Y, on: false, lifts: ban, cuts: [{ writer: wY, seq: 1 }], at: AT(22) }))
  t.is(hintOf(C, g2).allowed(Y), true)
  t.alike(parity(t, C, g2, 'unban on another core'), [A, B, D, X, Y, Z].sort())
})

test('mutually referenced admits cannot prove membership', (t) => {
  for (const admitFirst of [true, false]) {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    const admit = g.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: { writer: wA, seq: 1 }, at: AT(admitFirst ? 21 : 22) }))
    g.push(wA, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], seen: admit, at: AT(admitFirst ? 22 : 21) }))
    const { r, members } = foldOf(g)
    t.is(r.incomplete, false, 'the fold is complete')
    t.is(r.members.get(B), admitFirst ? 'requested' : 'member', 'the later timestamp wins the cycle in the fold')
    const h = hintOf(C, g)
    t.is(h.allowed(B), UNKNOWN, 'neither reference proves which record comes last')
    t.alike(h.members(), [A, Z].sort(), 'the uncertain member is left out')
    t.absent(h.members().some((d) => !members.includes(d)), 'every hinted member belongs to the fold')
  }
})

test('a mutually referenced unban cannot prove a ban was lifted', (t) => {
  for (const unbanFirst of [true, false]) {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1 }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    const ban = g.push(G1, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: { writer: wA, seq: 1 }, at: AT(unbanFirst ? 22 : 21) }))
    g.push(wA, groupBan({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], lifts: ban, at: AT(unbanFirst ? 21 : 22) }))
    const { r, members } = foldOf(g)
    t.is(r.incomplete, false, 'the fold is complete')
    t.is(r.members.get(B), unbanFirst ? 'banned' : 'member', 'only an unban ordered after the ban lifts it in the fold')
    const h = hintOf(C, g)
    t.is(h.allowed(B), UNKNOWN, 'the cycle cannot prove the ban was lifted')
    t.alike(h.members(), [A, D, X, Y, Z].sort(), 'the uncertain member is left out')
    t.absent(h.members().some((d) => !members.includes(d)), 'every hinted member belongs to the fold')
  }
})

for (const length of [3, 4]) {
  test('parity: a ' + length + '-record reference cycle cannot prove a lift', (t) => {
    for (const posts of [false, true]) {
      const C = open4()
      const g = withWriters(groupIn(C, { key: G1 }))
      g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
      const ban = g.push(G1, groupBan({ member: B, on: true, seen: { writer: wX, seq: 1 }, at: AT(30) }))
      const lift = g.push(wA, groupBan({ member: B, on: false, lifts: ban, at: AT(20) }))
      const bridge = (seen) => posts
        ? groupPost({ text: 'ordering only', replyTo: seen, at: AT(40) })
        : groupBan({ member: D, on: true, seen, at: AT(40) })
      g.push(wX, bridge(length === 3 ? lift : { writer: wY, seq: 1 }))
      if (length === 4) g.push(wY, bridge(lift))
      const { r, members } = foldOf(g)
      t.is(r.incomplete, false, 'the fold is complete')
      t.is(r.members.get(B), 'banned', 'the fold releases the earliest writer head, the lift, before the ban')
      const h = hintOf(C, g)
      t.is(h.allowed(B), UNKNOWN, 'indirect references do not prove the lift follows the ban')
      t.absent(h.members().includes(B), 'an unknown membership gets no notice')
      t.absent(h.members().some((d) => !members.includes(d)), 'every hinted member belongs to the fold')
    }
  })
}

test('parity: a ban cycle outside the lift preserves the fold\'s same-writer order', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  const ban = g.push(G1, groupBan({ member: B, on: true, seen: { writer: wX, seq: 1 }, at: AT(30) }))
  g.push(wX, groupPost({ text: 'ordering only', seen: ban, at: AT(40) }))
  g.push(wA, groupBan({ member: B, on: false, lifts: ban, at: AT(20) }))
  const h = hintOf(C, g)
  const { r } = foldOf(g)
  t.is(r.incomplete, false, 'the fold is complete')
  t.is(r.members.get(B), 'banned', 'the lift can be released first without belonging to the cycle')
  t.is(h.allowed(B), UNKNOWN)
  t.absent(h.members().includes(B))

  const record = groupBan({ member: B, on: false, lifts: ban, at: AT(15) })
  const lift = g.push(G1, record)
  h.add(record, { diary: Z, writer: G1, seq: lift.seq })
  t.is(h.allowed(B), true, 'the fold preserves same-writer order even with an earlier timestamp')
  t.alike(h.members(), parity(t, C, g, 'same-writer lift outside the cycle'), 'a state change refreshes the memo')
})

test('parity: a cycle between acyclic ban and lift endpoints leaves the hint undecided', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  const ban = g.push(G1, groupBan({ member: B, on: true, at: AT(30) }))
  g.push(wX, groupPost({ text: 'ordering only', replyTo: ban, seen: { writer: wY, seq: 1 }, at: AT(40) }))
  g.push(wY, groupPost({ text: 'ordering only', seen: { writer: wX, seq: 1 }, at: AT(50) }))
  g.push(wA, groupBan({ member: B, on: false, lifts: ban, seen: { writer: wX, seq: 1 }, at: AT(20) }))
  const { r, members } = foldOf(g)
  t.is(r.incomplete, false, 'the fold is complete')
  t.is(r.members.get(B), 'member', 'the ready ban is processed before breaking the intermediate cycle')
  const h = hintOf(C, g)
  t.is(h.allowed(B), UNKNOWN, 'a path through a cycle is not proof of order')
  t.absent(h.members().includes(B))
  t.absent(h.members().some((d) => !members.includes(d)), 'every hinted member belongs to the fold')
})

test('parity: the cycle memo refreshes when a block closes a cycle or a mark removes it', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  const ban = g.push(G1, groupBan({ member: B, on: true, seen: { writer: wX, seq: 1 }, at: AT(30) }))
  const lift = g.push(wA, groupBan({ member: B, on: false, lifts: ban, at: AT(20) }))
  const h = hintOf(C, g)
  t.is(h.allowed(B), true, 'the reference past X\'s last node orders nothing')
  t.alike(h.members(), parity(t, C, g, 'before the cycle closes'))

  const record = groupPost({ text: 'ordering only', seen: lift, at: AT(40) })
  const ref = g.push(wX, record)
  h.add(record, { diary: X, writer: wX, seq: ref.seq })
  const { r } = foldOf(g)
  t.is(r.incomplete, false)
  t.is(r.members.get(B), 'banned')
  t.is(h.allowed(B), UNKNOWN, 'the new block invalidates the acyclic memo')
  t.absent(h.members().includes(B))

  g.mark(X, wX, 1)
  h.mark(X, wX, 1)
  t.is(h.allowed(B), true, 'cutting the bridge invalidates the cyclic memo')
  t.alike(h.members(), parity(t, C, g, 'after the bridge is cut'))
})

test('two blocks for one seq of any kind are a fork', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const h = hintOf(C, g)
  t.ok(h.add(groupPost({ text: 'oi', at: AT(30) }), { diary: A, writer: wA, seq: 1 }))
  t.alike(h.members(), [A, B, D, X, Y, Z].sort())
  h.add(groupPost({ text: 'tchau', at: AT(30) }), { diary: A, writer: wA, seq: 1 })
  t.is(h.members(), null, 'two posts for one seq')
  const h2 = hintOf(C, g)
  h2.add(groupPost({ text: 'oi', at: AT(30) }), { diary: A, writer: wA, seq: 1 })
  h2.add({ type: 'nada' }, { diary: A, writer: wA, seq: 1 })
  t.is(h2.members(), null, 'a valid and an invalid block for one seq')

  const approval = groupIn(C, { key: G1, join: 'approval' }).add(A, wA).add(B, wB)
  approval.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  approval.push(wA, groupPost({ text: 'oi', at: AT(21) }))
  approval.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
  t.alike(parity(t, C, approval, 'before the fork'), [A, B, Z].sort())
  const input = approval.input()
  const original = approval.logs.get(wA)
  for (const record of [groupPost({ text: 'tchau', at: AT(21) }), { type: 'nada' }]) {
    const copy = { ...original, entries: original.entries.map((e) => e.seq === 1 ? { seq: 1, record } : e) }
    for (const writers of [[...input.writers, copy], [copy, ...input.writers]]) {
      const folded = buildGroup({ ...input, writers })
      t.absent(folded.writers.has(wA), 'a fork outside the folded kinds drops the whole core')
      t.is(folded.members.get(B), 'requested', 'the forked core admits nobody')
      const hint = hintOf(C, approval, { feed: false })
      for (const log of C.logs.values()) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true })
      for (const log of [input.root, ...writers]) for (const e of log.entries) hint.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
      t.is(hint.allowed(B), UNKNOWN, 'the hint cannot accept the forked admission')
      t.is(hint.members(), null, 'either copy order fails closed')
    }
  }
})

test('large blocks retain only fixed-size digests in every hint', (t) => {
  const C = open4()
  const hints = Array.from({ length: 8 }, (_, i) => hintOf(C, groupIn(C, { key: K(0x100 + i) }), { feed: false }))
  const record = { type: 'ignored', text: 'x'.repeat(32768), nested: { b: 2, a: 1 } }
  for (const h of hints) {
    for (let seq = 1; seq <= 64; seq++) h.add(record, { diary: Z, writer: C.key, seq, community: true })
    t.alike(h.held(), { blocks: 64, marks: 0, entries: 0, writers: 0, refused: 0, digestBytes: 64 * GROUP_HINT_DIGEST_BYTES, bytes: 64 * GROUP_HINT_BLOCK_BYTES })
    h.add({ nested: { a: 1, b: 2 }, text: record.text, type: record.type }, { diary: Z, writer: C.key, seq: 1, community: true })
    t.is(h.allowed(Z), true, 'key order does not make a fork')
    t.is(h.held().blocks, 64, 'replays do not spend another slot')
    h.add({ ...record, text: record.text + 'y' }, { diary: Z, writer: C.key, seq: 1, community: true })
    t.is(h.allowed(Z), UNKNOWN, 'a differing invalid block still taints')
    t.is(h.held().digestBytes, 0, 'a fork releases its digests')
  }
})

test('a full hint releases its maps and remains incomplete', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const h = hintOf(C, g)
  h.mark(A, wA, 50)
  h.add({ type: 'wrong-header' }, { diary: A, writer: K(8000), seq: 0 })
  h.add(groupPost({ text: 'node' }), { diary: A, writer: wA, seq: 1 })
  const initial = h.held()
  const remaining = (MAX_GROUP_HINT_BYTES - initial.bytes) / GROUP_HINT_BLOCK_BYTES
  for (let seq = 1; seq <= remaining; seq++) h.add({ type: 'ignored' }, { diary: A, writer: K(9000), seq })
  t.is(h.held().bytes, MAX_GROUP_HINT_BYTES, 'the default limit is inclusive')
  t.is(h.allowed(A), true, 'still complete at the limit')
  t.is(h.add({ type: 'ignored' }, { diary: A, writer: K(9000), seq: remaining + 1 }), false)
  t.is(h.allowed(A), UNKNOWN)
  t.is(h.members(), null)
  t.alike(h.held(), { blocks: 0, marks: 0, entries: 0, writers: 0, refused: 0, digestBytes: 0, bytes: 0 })
  t.is(h.add(groupPost({ text: 'later' }), { diary: A, writer: wA, seq: 2 }), false)
  t.is(h.mark(A, wA, 1), false)
  t.is(h.held().blocks + h.held().marks, 0, 'later feeds cannot refill an incomplete hint')
})

test('marks share the byte budgets and release their charges once', (t) => {
  const C = open4()
  const g = groupIn(C, { key: G1 })
  const budget = createGroupHintBudget(3 * GROUP_HINT_BLOCK_BYTES)
  const h = hintOf(C, g, { feed: false, maxBytes: 2 * GROUP_HINT_BLOCK_BYTES, budget })
  t.ok(h.mark(A, wA, 2))
  t.ok(h.mark(A, wA, 1))
  t.is(budget.held(), GROUP_HINT_BLOCK_BYTES, 'updating a mark reuses its charge')
  t.ok(h.mark(B, wB, 1))
  t.is(h.mark(D, wD, 1), false, 'marks alone can exhaust the hint')
  t.is(h.members(), null)
  t.is(h.held().marks, 0)
  t.is(budget.held(), 0)
  h.incomplete()
  t.is(budget.held(), 0, 'release is idempotent')
  const other = hintOf(C, g, { feed: false, budget })
  for (const [diary, writer] of [[A, wA], [B, wB], [D, wD]]) other.mark(diary, writer, 1)
  t.is(budget.held(), 3 * GROUP_HINT_BLOCK_BYTES)
  t.is(other.mark(X, wX, 1), false, 'marks also exhaust the shared budget')
  t.is(other.members(), null)
  t.is(budget.held(), 0)
})

test('cut-heavy records exhaust the byte cap before the same count of ordinary blocks', (t) => {
  const C = open4()
  const g = groupIn(C, { key: G1 })
  const cuts = Array.from({ length: 16 }, (_, i) => ({ writer: K(7000 + i), seq: i }))
  const seen = { writer: wA, seq: 1 }
  const records = [
    groupAdmit({ member: A, on: true, cuts, seen }),
    groupBan({ member: A, on: false, cuts, seen, lifts: seen }),
    groupLeave({ cuts: cuts.slice(0, 8), seen })
  ]
  for (const record of records) {
    const references = record.cuts.length + 1 + (record.lifts ? 1 : 0)
    const cost = GROUP_HINT_BLOCK_BYTES + GROUP_HINT_ENTRY_BYTES + references * GROUP_HINT_REFERENCE_BYTES
    const heavy = hintOf(C, g, { feed: false, maxBytes: 2 * cost })
    const ordinary = hintOf(C, g, { feed: false, maxBytes: 2 * cost })
    for (let seq = 1; seq <= 2; seq++) {
      t.ok(heavy.add(record, { diary: Z, writer: G1, seq }), record.type + ' fits at the inclusive byte limit')
      t.ok(ordinary.add(groupPost({ text: 'ordinary' }), { diary: Z, writer: G1, seq }))
    }
    t.is(heavy.held().blocks, ordinary.held().blocks, 'same block count')
    t.is(heavy.held().bytes, 2 * cost, 'cuts, including seq zero, and references are charged')
    t.is(ordinary.held().bytes, 2 * GROUP_HINT_BLOCK_BYTES)
    t.ok(heavy.add(record, { diary: Z, writer: G1, seq: 2 }), 'a replay at the limit is free')
    t.is(heavy.held().bytes, 2 * cost)
    t.is(heavy.add(record, { diary: Z, writer: G1, seq: 3 }), false)
    t.is(heavy.held().bytes, 0)
    t.is(heavy.members(), null)
    t.ok(ordinary.add(groupPost({ text: 'ordinary' }), { diary: Z, writer: G1, seq: 3 }))
    t.is(ordinary.allowed(Z), true, 'ordinary history still fits')
  }
})

test('folded entries and header references refund exactly alongside marks', (t) => {
  const C = open4()
  const g = groupIn(C, { key: G1 })
  const budget = createGroupHintBudget(64 * 1024)
  const other = hintOf(C, g, { feed: false, budget })
  t.ok(other.mark(B, wB, 1))
  const header = writerHeader({ group: G1, diary: A, member: cwA, rejoin: { writer: wX, seq: 1 } })
  const record = groupBan({ member: B, on: false, cuts: [{ writer: wB, seq: 0 }], seen: { writer: wB, seq: 1 }, lifts: { writer: G1, seq: 1 } })
  const cost = 3 * GROUP_HINT_BLOCK_BYTES + 2 * GROUP_HINT_ENTRY_BYTES + 4 * GROUP_HINT_REFERENCE_BYTES
  for (let rebuild = 0; rebuild < 3; rebuild++) {
    const h = hintOf(C, g, { feed: false, budget })
    t.ok(h.add(header, { diary: A, writer: wA, seq: 0 }))
    t.ok(h.add(record, { diary: Z, writer: G1, seq: 1 }))
    t.ok(h.mark(A, wA, 2))
    t.is(h.held().bytes, cost)
    t.is(budget.held(), cost + GROUP_HINT_BLOCK_BYTES)
    t.ok(h.add(record, { diary: Z, writer: G1, seq: 1 }))
    t.ok(h.mark(A, wA, 1))
    t.is(budget.held(), cost + GROUP_HINT_BLOCK_BYTES, 'replays and mark updates are free')
    h.incomplete()
    h.incomplete()
    t.is(budget.held(), GROUP_HINT_BLOCK_BYTES, 'rebuilding refunds only this hint, once')
  }
  other.incomplete()
  t.is(budget.held(), 0, 'nothing leaks or goes negative')
})

test('a writer counts up to its first hole', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g.push(wA, groupPost({ text: 'oi', at: AT(21) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
  t.is(hintOf(C, g).allowed(B), true, 'whole: admitted')
  t.alike(parity(t, C, g, 'whole core'), [A, B, Z].sort())
  g.logs.get(wA).entries.splice(1, 1)
  t.is(hintOf(C, g).allowed(B), false, 'past a hole the admit does not count')
  t.alike(parity(t, C, g, 'a hole before the admit'), [A, Z].sort())
  // A root past its first hole: unknown.
  const g2 = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g2.push(G1, groupPost({ text: 'oi', at: AT(20) }))
  g2.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
  g2.logs.get(G1).entries.splice(1, 1)
  t.is(hintOf(C, g2).members(), null)
})

test('a community root mark does not remove its bans', (t) => {
  for (const group of [null, G1]) {
    for (const cut of [0, 1, 2]) {
      const C = open4()
      const g = withWriters(groupIn(C, { key: G1 }))
      const writer = group === null ? cwB : wB
      C.push(C.key, communityBan({ group, member: B, on: true, cuts: [{ writer, seq: 1 }], at: AT(20) }))
      C.mark(Z, C.key, cut)
      const { r } = foldOf(g)
      t.is(r.members.get(B), 'banned', 'the fold keeps the ban at or past the root mark')
      t.is(hintOf(C, g).allowed(B), false, 'the hint keeps the community root ban')
      t.alike(parity(t, C, g, 'community root mark'), [A, D, X, Y, Z].sort())
    }
  }
})

test('root marks never hide a creator leave', (t) => {
  for (const onC of [false, true]) {
    for (const cut of [0, 1, 2]) {
      const C = open4()
      const g = withWriters(groupIn(C, { key: G1 }))
      const scope = onC ? C : g
      if (!onC) g.push(G1, groupPost({ text: 'oi', at: AT(10) }))
      scope.push(scope.key, groupLeave({ cuts: [{ writer: scope.key, seq: 2 }], at: AT(20) }))
      scope.mark(Z, scope.key, cut)
      const { r, members } = foldOf(g)
      t.is(r.incomplete, false, 'the fold is complete')
      t.is(r.members.get(Z), 'left', 'the creator leave still counts past the root mark')
      const h = hintOf(C, g)
      t.is(h.allowed(Z), UNKNOWN, 'the hint cannot decide creator leave generations')
      t.is(h.members(), null, 'the hint fails closed')
      t.absent((h.members() || []).some((d) => !members.includes(d)), 'every hinted member belongs to the fold')
    }
  }
})

test('marks drop a writer\'s records from the cut on', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
  const h = hintOf(C, g)
  t.is(h.allowed(B), true)
  t.ok(h.mark(B, wA, 1), 'another diary\'s mark')
  t.is(h.allowed(B), true, 'only the writer\'s own diary cuts it')
  t.ok(h.mark(A, wA, 1))
  t.is(h.allowed(B), false, 'the admit is past the cut')
  t.is(h.mark(A, 'x', 1), false)
  t.is(h.mark(A, wA, -1), false)
})

test('add refuses blocks that do not fit the core', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const h = hintOf(C, g)
  const admit = groupAdmit({ member: B, on: true, cuts: [], at: AT(40) })
  const other = hintOf(C, g)
  t.is(other.add(admit, { diary: A, writer: G1, seq: 5 }), false, 'the root is the creator\'s')
  t.is(other.members(), null, 'a root fed under another diary taints the hint')
  t.is(h.add(admit, { diary: Z, writer: C.key, seq: 5 }), false, 'C\'s root fed as a G core')
  t.is(h.add(admit, { diary: Z, writer: G1, seq: 5, community: true }), false, 'G\'s root fed as a C core')
  t.is(h.add(admit, { diary: Z, writer: G1, seq: -1 }), false)
  t.is(h.add(admit, { diary: 'z', writer: G1, seq: 5 }), false)
  t.is(h.add(null, { diary: Z, writer: G1, seq: 5 }), false)
  t.is(h.add({ ...admit, extra: 1 }, { diary: Z, writer: G1, seq: 5 }), false, 'invalid record')
  t.is(h.add(groupAdmin({ member: A, on: true, cuts: [], at: AT(40) }), { diary: A, writer: wA, seq: 9 }), true, 'a grant off the root is valid, counted only from the creator\'s devices')
  t.is(h.add(writerHeader({ group: K(0x101), diary: A, member: cwA, at: AT(0) }), { diary: A, writer: K(0x2001), seq: 0 }), false, 'a header naming another group')
  t.is(h.add(writerHeader({ group: G1, diary: A, member: null, at: AT(0) }), { diary: A, writer: K(0x2004), seq: 0 }), false, 'a group writer naming no CW')
  t.is(h.add(groupPost({ text: 'oi', at: AT(40) }), { diary: A, writer: wA, seq: 3 }), true, 'a post is valid and not kept')
  // A refused writer's records count for no one.
  t.ok(h.add(groupBan({ member: B, on: true, at: AT(41) }), { diary: A, writer: K(0x2001), seq: 1 }))
  t.alike(h.members(), [A, B, D, X, Y, Z].sort())
  // One valid and one refused block 0 for a writer: a fork.
  h.add(writerHeader({ group: G1, diary: A, member: cwA, at: AT(0) }), { diary: A, writer: K(0x2001), seq: 0 })
  t.is(h.members(), null, 'a forked block 0')

  // A ban on a writer whose header was not fed may count: unknown until it is.
  const h2 = hintOf(C, g)
  t.ok(h2.add(groupBan({ member: B, on: true, at: AT(41) }), { diary: A, writer: K(0x2002), seq: 1 }))
  t.is(h2.allowed(B), UNKNOWN, 'no header yet')
  t.is(h2.members(), null)
  h2.add(writerHeader({ group: G1, diary: A, member: cwA, at: AT(0) }), { diary: A, writer: K(0x2002), seq: 0 })
  t.alike(h2.members(), [A, B, D, X, Y, Z].sort(), 'its header came: A is no admin, the ban is ignored')

  // A record fed for another diary than its header names: a wrong feed.
  const h3 = hintOf(C, g)
  t.ok(h3.add(groupAdmit({ member: Y, on: true, cuts: [], at: AT(41) }), { diary: X, writer: wA, seq: 4 }))
  t.is(h3.members(), null)
  // So is a header fed for another diary than it names.
  const h4 = hintOf(C, g)
  t.is(h4.add(writerHeader({ group: G1, diary: B, member: cwB, at: AT(0) }), { diary: A, writer: K(0x2003), seq: 0 }), false)
  t.is(h4.members(), null, 'a header naming another diary')
})

test('noticeFor: public posts and every private envelope', (t) => {
  const ref = { writer: wA, seq: 1 }
  t.is(noticeFor(groupPost({ text: 'oi', at: AT(1) })), true, 'public post')
  t.is(noticeFor(groupPost({ text: 'oi', replyTo: ref, at: AT(1) })), true, 'public reply')
  t.is(noticeFor(groupHide({ target: ref, on: true, at: AT(1) })), false, 'public hide')
  t.is(noticeFor(groupReact({ target: ref, emoji: '', at: AT(1) })), false, 'public reaction')
  t.is(noticeFor(groupAdmit({ member: B, on: true, at: AT(1) })), false, 'admit')
  t.is(noticeFor(groupBan({ member: B, on: true, at: AT(1) })), false, 'ban')
  t.is(noticeFor(groupLeave({ at: AT(1) })), false, 'leave')
  t.is(noticeFor(groupMeta({ name: 'x', join: 'open', at: AT(1) })), false, 'meta')
  const sealed = groupSealed({ kid: ref, nonce: 'ab'.repeat(24), box: b4a.toString(b4a.alloc(40, 7), 'base64'), at: AT(1) })
  t.is(noticeFor(sealed, { private: true }), true, 'any sealed envelope')
  t.is(noticeFor(sealed), false, 'no envelope in a public group')
  t.is(noticeFor(groupPost({ text: 'oi', at: AT(1) }), { private: true }), false, 'no plain post in a private group')
  const key = groupKey({ kid: ref, keys: [{ writer: wA, sealed: 'A'.repeat(128) }], at: AT(1) })
  t.is(noticeFor(key, { private: true }), false, 'a key block')
  t.is(noticeFor({ type: 'group-post', text: 'oi' }), false, 'invalid post')
  t.is(noticeFor(null), false)
})

test('validateGroupNotice: exact shape, no author', (t) => {
  const recipients = [A, B]
  const ok = { v: 1, kind: 'group', group: G1, visibility: 'public', name: 'Varanda', nid: 'a'.repeat(32), recipients }
  t.is(validateGroupNotice(ok), true)
  t.is(validateGroupNotice({ ...ok, name: null }), true, 'a public group with no name')
  t.is(validateGroupNotice({ ...ok, visibility: 'private', name: null }), true)
  const many = Array.from({ length: MAX_NOTICE_RECIPIENTS }, (_, i) => K(0x10000 + i))
  t.is(validateGroupNotice({ ...ok, recipients: many }), true, '64 recipients')
  const { recipients: _r, ...noRecipients } = ok
  const rows = [
    ['author', { ...ok, author: A }],
    ['extra key', { ...ok, seq: 3 }],
    ['missing key', noRecipients],
    ['private with a name', { ...ok, visibility: 'private' }],
    ['private with an empty name', { ...ok, visibility: 'private', name: '' }],
    ['visibility', { ...ok, visibility: 'secret' }],
    ['v', { ...ok, v: 2 }],
    ['kind', { ...ok, kind: 'dm' }],
    ['group upper hex', { ...ok, group: 'AB' + G1.slice(2) }],
    ['group short', { ...ok, group: G1.slice(1) }],
    ['name control chars', { ...ok, name: 'a\u0007b' }],
    ['name newline', { ...ok, name: 'a\nb' }],
    ['name bidi', { ...ok, name: 'a‮b' }],
    ['name blank', { ...ok, name: '   ' }],
    ['name empty', { ...ok, name: '' }],
    ['name too long', { ...ok, name: 'x'.repeat(81) }],
    ['name not a string', { ...ok, name: 7 }],
    ['nid short', { ...ok, nid: 'a'.repeat(31) }],
    ['nid upper', { ...ok, nid: 'A'.repeat(32) }],
    ['nid long', { ...ok, nid: 'a'.repeat(64) }],
    ['nid number', { ...ok, nid: 12 }],
    ['0 recipients', { ...ok, recipients: [] }],
    ['65 recipients', { ...ok, recipients: [...many, K(0x20000)] }],
    ['duplicate', { ...ok, recipients: [A, A] }],
    ['bad hex recipient', { ...ok, recipients: [A, 'b'.repeat(63)] }],
    ['recipients not an array', { ...ok, recipients: A }],
    ['sparse recipients', { ...ok, recipients: [A, , B] }], // eslint-disable-line no-sparse-arrays
    ['not an object', 'x'],
    ['array', [ok]],
    ['null', null]
  ]
  for (const [label, value] of rows) t.is(validateGroupNotice(value), false, label)
  const hostile = { ...ok }
  Object.defineProperty(hostile, 'recipients', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateGroupNotice(hostile), false, 'a throwing getter')
})

test('groupSentence: three sentences', (t) => {
  t.is(groupSentence({ visibility: 'public', name: 'Varanda' }), 'Nova mensagem em Varanda')
  t.is(groupSentence({ visibility: 'public', name: 'Rua 7 \u{1F33B}' }), 'Nova mensagem em Rua 7 \u{1F33B}')
  for (const name of [null, '', '  ', 'a\u0007b', 'a\nb', 'a‮b', 'x'.repeat(81), 7, undefined]) {
    t.is(groupSentence({ visibility: 'public', name }), 'Nova mensagem num grupo', 'unusable name ' + JSON.stringify(name))
  }
  t.is(groupSentence({ visibility: 'private', name: null }), 'Nova mensagem num grupo privado')
  t.is(groupSentence({ visibility: 'private', name: 'Segredo' }), 'Nova mensagem num grupo privado', 'a private name never shows')
  t.is(groupSentence({ visibility: 'x', name: 'Varanda' }), 'Nova mensagem num grupo')
  t.is(groupSentence(), 'Nova mensagem num grupo')
  t.is(noticeName('x'.repeat(80)), 'x'.repeat(80))
  t.is(noticeName('x'.repeat(81)), null)
})

test('membership evaluation bounds work for non-admin records with reference fanout', (t) => {
  for (const n of [1000, 2000, 4000]) {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1 }))
    const cuts = Array.from({ length: 16 }, (_, i) => ({ writer: K(0x8000 + i), seq: 2 }))
    for (let i = 0; i < n; i++) {
      const options = { member: B, on: true, cuts, seen: { writer: wY, seq: 1 }, at: AT(10) }
      g.push(wX, i % 2 ? groupAdmit(options) : groupBan(options))
    }
    const h = hintOf(C, g)
    t.is(h.allowed(B), true, 'non-admin records do not remove membership')
    const work = h.work()
    t.comment(n + ' records: ' + work + ' work units for allowed')
    t.ok(work < 64 * h.held().blocks, 'fewer than 64 visits per held block')
    t.alike(h.members(), [A, B, D, X, Y, Z].sort())
    t.ok(h.work() < 64 * h.held().blocks, 'all candidates share the linear work bound')
    const all = h.work()
    h.allowed(B)
    h.members()
    t.is(h.work(), all, 'unchanged state reuses membership decisions')
  }
})

test('membership work stays linear for indexed lifts and cached order endpoints', (t) => {
  for (const n of [500, 1000]) {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1 }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }] }))
    for (let i = 0; i < n; i++) {
      const ban = g.push(G1, groupBan({ member: B, on: true }))
      g.push(wA, groupBan({ member: B, on: false, lifts: ban, cuts: [{ writer: wB, seq: 1 }] }))
    }
    const h = hintOf(C, g)
    t.is(h.allowed(B), true, 'every ban has its own authorized lift')
    t.alike(h.members(), [A, B, D, X, Y, Z].sort())
    t.comment(2 * n + ' ban/lift records: ' + h.work() + ' work units for all members')
    t.ok(h.work() < GROUP_HINT_WORK_PER_BLOCK * h.held().blocks)
  }
})

test('cycle indexing shares the linear work budget on deep acyclic logs and many small cycles', (t) => {
  for (const cyclic of [false, true]) {
    let previous = 0
    for (const n of [6000, 12000]) {
      const C = open4()
      const g = withWriters(groupIn(C, { key: G1 }))
      g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }] }))
      for (let i = 0; i < n; i++) {
        const seen = cyclic ? { writer: wX, seq: i + 1 } : null
        const ban = g.push(G1, groupBan({ member: B, on: true, seen }))
        const lift = g.push(wA, groupBan({ member: B, on: false, lifts: ban }))
        if (cyclic) g.push(wX, groupPost({ text: 'ordering only', seen: lift }))
      }
      const h = hintOf(C, g)
      t.is(h.allowed(B), cyclic ? UNKNOWN : true, 'cycles leave membership undecided; acyclic lifts count')
      t.is(h.members().includes(B), !cyclic)
      t.is(h.allowed(D), true, 'an unrelated diary still gets a notice')
      const work = h.work()
      t.comment(n + (cyclic ? ' small cycles: ' : ' acyclic ban/lift pairs: ') + work + ' work units')
      t.ok(work < GROUP_HINT_WORK_PER_BLOCK * h.held().blocks, 'indexing and all queries stay below the linear budget')
      if (previous) t.ok(work < 2.2 * previous, 'doubling the input stays within the linear allowance')
      previous = work
      for (let i = 0; i < 10; i++) {
        h.allowed(B)
        h.members()
      }
      t.is(h.work(), work, 'queries on an unchanged state reuse the components and membership memo')
    }
  }
})

test('ordering-only references share the byte budget and are refunded', (t) => {
  const C = open4()
  const g = groupIn(C, { key: G1 })
  const record = groupPost({ text: 'not retained', seen: { writer: wA, seq: 1 }, replyTo: { writer: wX, seq: 1 } })
  const cost = GROUP_HINT_BLOCK_BYTES + 2 * GROUP_HINT_REFERENCE_BYTES
  const budget = createGroupHintBudget(cost)
  const h = hintOf(C, g, { feed: false, maxBytes: cost, budget })
  t.ok(h.add(record, { diary: Z, writer: G1, seq: 1 }))
  t.is(h.held().bytes, cost, 'the node and both ordering references are charged')
  t.is(budget.held(), cost)
  t.ok(h.add(record, { diary: Z, writer: G1, seq: 1 }))
  t.is(budget.held(), cost, 'a duplicate retains no new references')
  t.is(h.add(record, { diary: Z, writer: G1, seq: 2 }), false)
  t.is(h.members(), null)
  t.is(budget.held(), 0, 'exhaustion releases the ordering index too')
})

test('admit ordering uses linear work or leaves the diary unknown', (t) => {
  for (const split of [false, true]) {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }] }))
    g.push(G1, groupAdmit({ member: D, on: true }))
    for (let i = 0; i < 1000; i++) {
      g.push(G1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }] }))
      g.push(split ? wA : G1, groupAdmit({ member: B, on: false }))
    }
    const h = hintOf(C, g)
    t.is(h.allowed(B), split ? UNKNOWN : false, 'dense cross-core order fails closed; one core has a last off')
    t.is(h.allowed(D), true, 'an unrelated diary still has a cheap answer')
    t.absent(h.members().includes(B))
    t.ok(h.work() < GROUP_HINT_WORK_PER_BLOCK * h.held().blocks)
  }
})

test('authority work shares a finite budget across candidate and writer queries', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }] }))
  for (let i = 0; i < 1000; i++) {
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 10000 + i }] }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }] }))
  }
  const h = hintOf(C, g)
  t.is(h.allowed(B), UNKNOWN, 'a costly authority history cannot prove membership')
  t.is(h.work(), GROUP_HINT_WORK_PER_BLOCK * (h.held().blocks + 1), 'the state stops at its work budget')
  const work = h.work()
  t.absent(h.members().includes(B))
  t.is(h.allowed(B), UNKNOWN)
  t.is(h.work(), work, 'another query cannot restart the budget')
})

test('reverse rejoin chains resolve with bounded work', (t) => {
  for (const n of [500, 1000]) {
    const C = open4()
    const g = groupIn(C, { key: G1 }).add(A, wA)
    let leave = g.push(wA, groupLeave({ cuts: [{ writer: wA, seq: 1 }] }))
    for (let i = 0; i < n; i++) {
      const writer = K(0x10000 + i)
      g.add(A, writer, { rejoin: leave })
      leave = g.push(writer, groupLeave({ cuts: [{ writer, seq: 1 }] }))
    }
    const h = hintOf(C, g, { feed: false })
    for (const log of C.logs.values()) {
      for (const e of log.entries) h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true })
    }
    for (const log of [...g.logs.values()].reverse()) {
      for (const e of log.entries) h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
    }
    t.is(h.allowed(A), false, 'the last generation left')
    t.alike(h.members(), [Z])
    t.ok(h.work() < GROUP_HINT_WORK_PER_BLOCK * h.held().blocks)
  }
})

test('membership memo survives duplicate blocks and refreshes on authority changes and marks', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const record = groupBan({ member: B, on: true })
  const ban = g.push(wA, record)
  const h = hintOf(C, g)
  t.is(h.allowed(B), true, 'A has no authority yet')
  const members = h.members()
  const work = h.work()
  members.length = 0
  h.add(record, { diary: A, writer: wA, seq: ban.seq })
  t.alike(h.members(), [A, B, D, X, Y, Z].sort(), 'the cached list is not exposed to mutation')
  t.is(h.work(), work, 'feeding an identical block does not invalidate the memo')
  const grant = groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }] })
  h.add(grant, { diary: Z, writer: G1, seq: g.len(G1) })
  t.is(h.allowed(B), false, 'a new grant makes the earlier ban count')
  h.mark(A, wA, 1)
  t.is(h.allowed(B), true, 'a new mark removes the ban')
  h.incomplete()
  t.is(h.allowed(B), UNKNOWN)
  t.is(h.members(), null)
})

test('32000 ordinary-member records keep membership work bounded', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  for (let i = 0; i < 32000; i++) g.push(wX, groupBan({ member: B, on: true }))
  const h = hintOf(C, g)
  t.is(h.allowed(B), true)
  t.alike(h.members(), [A, B, D, X, Y, Z].sort())
  t.comment('32000 bans: ' + h.work() + ' work units for all members')
  t.ok(h.work() < GROUP_HINT_WORK_PER_BLOCK * h.held().blocks)
})

test('membership work is bounded across many candidate diaries', (t) => {
  for (const n of [500, 1000]) {
    const members = Array.from({ length: n }, (_, i) => ({ diary: K(0x10000 + i), cw: K(0x20000 + i), status: 'member' }))
    const C = community({ creator: Z, members })
    const g = groupIn(C, { key: G1 })
    for (let i = 0; i < n; i++) {
      const writer = K(0x30000 + i)
      g.add(members[i].diary, writer)
      g.push(writer, groupBan({ member: members[(i + 1) % n].diary, on: true }))
    }
    const h = hintOf(C, g)
    t.is(h.members().length, n + 1, 'non-admin bans do not remove any candidate')
    t.comment(n + ' candidate diaries: ' + h.work() + ' work units for all members')
    t.ok(h.work() < GROUP_HINT_WORK_PER_BLOCK * h.held().blocks)
  }
})

test('grant and meta order does not depend on block feed order', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }] }))
  g.push(G1, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }] }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }] }))
  g.push(wA, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }] }))
  g.push(G1, groupMeta({ name: 'Geral', join: 'open' }))
  g.push(G1, groupMeta({ name: 'Geral', join: 'approval' }))
  const expected = parity(t, C, g, 'ordered grants and metas')
  const h = hintOf(C, g, { feed: false })
  for (const scope of [g, C]) {
    for (const log of [...scope.logs.values()].reverse()) {
      for (const e of [...log.entries].reverse()) {
        h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: scope === C })
      }
    }
  }
  t.alike(h.members(), expected, 'reverse feed keeps the same grant layers and latest meta')
})

// The fold keeps images and descriptions out of the causal order
// (lib/group.js splitReacts): an admit whose reference names one must order
// as there, or the hint counts a diary the fold leaves out.
for (const [kind, side] of [
  ['description', (seen) => groupAbout({ about: 'Bairro novo', seen, at: AT(23) })],
  ['image', (seen) => groupImage({ image: null, seen, at: AT(23) })]
]) {
  test('a trailing ' + kind + ' on the root orders nothing after a withdrawal', (t) => {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    const withdrawal = g.push(G1, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
    const trailing = g.push(G1, side(withdrawal))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: trailing, at: AT(21) }))
    const { r, members } = foldOf(g)
    t.is(r.incomplete, false, 'the fold is complete')
    t.is(r.members.get(B), 'requested', 'the fold orders the admit before the withdrawal')
    const h = hintOf(C, g)
    // Neither names the other, so the hint cannot order them: undecided,
    // never allowed.
    t.is(h.allowed(B), UNKNOWN, 'the hint does not count B')
    t.absent(h.members().includes(B), 'B is no recipient')
    t.alike(h.members(), members, 'same members as buildGroup')
  })
}

test('image and description records leave the hint as it was', (t) => {
  // With them, the admit names the last one; without them, it names nothing.
  const build = (extra) => {
    const C = open4()
    const g = withWriters(groupIn(C, { key: G1, join: 'approval' }))
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    const withdrawal = g.push(G1, groupAdmit({ member: B, on: false, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
    let seen = null
    if (extra) {
      g.push(G1, groupImage({ image: null, seen: withdrawal, at: AT(23) }))
      seen = g.push(G1, groupAbout({ about: 'Bairro novo', at: AT(24) }))
    }
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen, at: AT(21) }))
    return { C, g }
  }
  const plain = build(false)
  const sided = build(true)
  const expected = parity(t, plain.C, plain.g, 'without side records')
  t.alike(parity(t, sided.C, sided.g, 'with side records'), expected, 'same members as without them')
  t.is(hintOf(sided.C, sided.g).allowed(B), hintOf(plain.C, plain.g).allowed(B), 'same answer for B')
})

// Standalone groups (lib/group.js isStandaloneHeader): a root naming no
// community, writers naming G itself. The hint takes community: null and
// must stay a subset of buildGroup's members, which folds with no gate.
const S = K(0x200)

function standalone ({ key = S, diary = Z, join = 'open', visibility = 'public', box = null } = {}) {
  const header = groupHeader({ diary, visibility, join, name: visibility === 'private' ? null : 'Varanda', box, at: AT(0) })
  const logs = new Map([[key, { key, diary, entries: [{ seq: 0, record: header }] }]])
  const joins = new Map([[diary, [{ writer: key, on: true, seq: 1 }]]])
  const marks = new Map()
  const next = (d) => {
    let seq = 0
    for (const list of [joins.get(d) || [], marks.get(d) || []]) for (const e of list) seq = Math.max(seq, e.seq)
    return seq + 1
  }
  const g = {
    key,
    logs,
    joins,
    marks,
    add (member, wkey, { box: wbox = null, rejoin = null, name = key } = {}) {
      logs.set(wkey, { key: wkey, diary: member, entries: [{ seq: 0, record: writerHeader({ group: key, diary: member, member: name, box: wbox, rejoin, at: AT(0) }) }] })
      const list = joins.get(member) || []
      list.push({ writer: wkey, on: true, seq: next(member) })
      joins.set(member, list)
      return g
    },
    mark (d, writer, cut) {
      const list = marks.get(d) || []
      list.push({ writer, cut, seq: next(d) })
      marks.set(d, list)
      return g
    },
    push (wkey, record) {
      const log = logs.get(wkey)
      const seq = log.entries.length
      log.entries.push({ seq, record })
      return { writer: wkey, seq }
    },
    len: (wkey) => logs.get(wkey).entries.length,
    input: () => ({ root: logs.get(key), writers: [...logs.values()].filter((l) => l.key !== key), joins, marks, now: NOW })
  }
  return g
}

// Fixed-seed PRNG (mulberry32): deterministic shuffles and random worlds.
function prng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle (list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const x = list[i]
    list[i] = list[j]
    list[j] = x
  }
  return list
}

// `rng` shuffles the feed order, `skip` leaves blocks out (a partial feed).
function standaloneHint (g, { community = null, rng = null, skip = null } = {}) {
  const h0 = g.logs.get(g.key).entries[0].record
  const hint = createGroupHint({ group: g.key, creator: h0.diary, join: h0.join, visibility: h0.visibility, community })
  const blocks = []
  for (const log of g.logs.values()) for (const e of log.entries) blocks.push({ record: e.record, at: { diary: log.diary, writer: log.key, seq: e.seq } })
  if (rng !== null) shuffle(blocks, rng)
  for (const b of blocks) if (skip === null || !skip(b.at)) hint.add(b.record, b.at)
  for (const [diary, marks] of g.input().marks) for (const m of marks) hint.mark(diary, m.writer, m.cut)
  return hint
}

// The subset property alone: an undecided hint (null) notifies nobody.
function standaloneSubset (t, g, label, opts) {
  const r = buildGroup(g.input())
  const members = [...r.members].filter(([, st]) => st === 'member').map(([d]) => d)
  const hinted = standaloneHint(g, opts).members()
  t.absent((hinted || []).some((d) => !members.includes(d)), label + ': every hinted member is a fold member')
  return { r, hinted }
}

// Every diary the hint calls a member is one buildGroup calls a member; on
// these complete folds they are the same set.
function standaloneParity (t, g, label) {
  const r = buildGroup(g.input())
  const members = [...r.members].filter(([, st]) => st === 'member').map(([d]) => d).sort()
  t.is(r.incomplete, false, label + ': the fold is complete')
  t.is(r.community, null, label + ': the fold has no parent')
  const hinted = standaloneHint(g).members()
  t.ok(Array.isArray(hinted), label + ': the hint decides')
  t.absent((hinted || []).some((d) => !members.includes(d)), label + ': every hinted member is a fold member')
  t.alike(hinted, members, label + ': same members as buildGroup')
  return members
}

test('standalone open group: writers naming G are members, bans and leaves remove', (t) => {
  const g = standalone().add(A, wA).add(B, wB).add(X, wX).add(Y, wY)
  t.alike(standaloneParity(t, g, 'open'), [A, B, X, Y, Z].sort())
  g.push(wX, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(10) }))
  t.alike(standaloneParity(t, g, 'non-admin ban'), [A, B, X, Y, Z].sort())
  const ban = g.push(S, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(11) }))
  g.push(wB, groupLeave({ cuts: [{ writer: wB, seq: g.len(wB) }], at: AT(12) }))
  const h = standaloneHint(g)
  t.is(h.allowed(Y), false, 'banned by the creator')
  t.is(h.allowed(B), false, 'departed')
  t.is(h.allowed(Z), true, 'the creator: the root stays live')
  t.alike(standaloneParity(t, g, 'ban and leave'), [A, X, Z].sort())
  g.push(S, groupBan({ member: Y, on: false, lifts: ban, cuts: [{ writer: wY, seq: 1 }], at: AT(13) }))
  t.alike(standaloneParity(t, g, 'unban'), [A, X, Y, Z].sort())
})

test('standalone approval group: only G-granted admins admit, pending writers get no notice', (t) => {
  const g = standalone({ join: 'approval' }).add(A, wA).add(B, wB).add(X, wX).add(Y, wY).add(D, wD)
  t.alike(standaloneParity(t, g, 'nobody admitted'), [Z])
  t.is(standaloneHint(g).allowed(B), false, 'pending')
  g.push(S, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(11) }))
  g.push(wX, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(12) }))
  g.push(S, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: AT(13) }))
  const h = standaloneHint(g)
  t.is(h.allowed(A), true, 'an admin needs no admit')
  t.is(h.allowed(B), true, 'admitted by an admin G granted')
  t.is(h.allowed(X), false, 'pending')
  t.is(h.allowed(Y), false, 'a non-admin admit is ignored')
  t.alike(standaloneParity(t, g, 'admits'), [A, B, D, Z].sort())
  g.push(S, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: g.len(wB) }], at: AT(14) }))
  g.push(wD, groupLeave({ cuts: [{ writer: wD, seq: g.len(wD) }], at: AT(15) }))
  t.alike(standaloneParity(t, g, 'ban and leave'), [A, Z].sort())
})

test('standalone private group: admitted writers with a box, pending ones out', (t) => {
  const g = standalone({ join: 'approval', visibility: 'private', box: K(0x7701) })
  g.add(A, wA, { box: K(0x7702) }).add(B, wB, { box: K(0x7703) }).add(X, wX, { box: K(0x7704) })
  g.push(S, groupAdmit({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  g.push(S, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(11) }))
  const h = standaloneHint(g)
  t.is(h.allowed(A), true)
  t.is(h.allowed(B), false, 'pending')
  t.alike(standaloneParity(t, g, 'private'), [A, X, Z].sort())
  g.push(S, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(12) }))
  t.alike(standaloneParity(t, g, 'private ban'), [A, Z].sort())
  // A boxless writer does not fit a private group.
  const h2 = standaloneHint(standalone({ join: 'approval', visibility: 'private', box: K(0x7701) }).add(Y, wY))
  t.alike(h2.members(), [Z], 'the boxless writer counts for no one')
})

test('standalone group: a writer\'s own mark cuts its admits', (t) => {
  const g = standalone({ join: 'approval' }).add(A, wA).add(B, wB)
  g.push(S, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(10) }))
  g.push(wA, groupPost({ text: 'oi', at: AT(11) }))
  g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(12) }))
  t.alike(standaloneParity(t, g, 'before the cut'), [A, B, Z].sort())
  g.mark(A, wA, 2)
  t.is(standaloneHint(g).allowed(B), false, 'the admit is past the cut')
  t.alike(standaloneParity(t, g, 'cut writer'), [A, Z].sort())
})

test('standalone group: writer headers must name G, community cores are refused', (t) => {
  const g = standalone().add(A, wA).add(B, wB, { name: cwB })
  t.alike(standaloneParity(t, g, 'a writer naming a CW'), [A, Z].sort())
  g.push(wB, groupBan({ member: A, on: true, at: AT(10) }))
  t.alike(standaloneParity(t, g, 'its records count for no one'), [A, Z].sort())
  const h = standaloneHint(g)
  t.is(h.add(writerHeader({ group: S, diary: X, member: null, at: AT(0) }), { diary: X, writer: wX, seq: 0 }), false, 'a header naming no member')
  t.is(h.add(writerHeader({ group: S, diary: Y, member: cwY, at: AT(0) }), { diary: Y, writer: wY, seq: 0 }), false, 'a header naming a CW')
  t.is(h.allowed(X), false)
  t.is(h.allowed(Y), false)
  const held = h.held().blocks
  // Whatever a caller feeds as a community core is no input here.
  const C = open4()
  for (const log of C.logs.values()) {
    for (const e of log.entries) {
      t.is(h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true }), false, 'C block ' + log.key.slice(-4) + ':' + e.seq)
    }
  }
  t.is(h.add(communityBan({ group: S, member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }), { diary: Z, writer: C.key, seq: 9, community: true }), false, 'a C ban naming G')
  t.alike(h.members(), [A, Z].sort(), 'nothing fed as C changed the hint')
  t.is(h.held().blocks, held, 'C blocks are not even held')
})

test('standalone group: rejoins and creator leaves stay unknown', (t) => {
  const g = standalone().add(A, wA).add(B, wB)
  const leave = g.push(wB, groupLeave({ cuts: [{ writer: wB, seq: g.len(wB) }], at: AT(10) }))
  g.add(B, K(0x3001), { rejoin: leave })
  const h = standaloneHint(g)
  t.is(h.allowed(B), UNKNOWN, 'back after a leave')
  t.is(buildGroup(g.input()).members.get(B), 'member', 'the fold has it back: the hint only leaves it out')
  t.alike(h.members(), [A, Z].sort())
  const g2 = standalone().add(A, wA)
  g2.push(S, groupLeave({ cuts: [{ writer: S, seq: 1 }], at: AT(10) }))
  t.is(standaloneHint(g2).members(), null, 'a creator leave')
})

test('community: null is the standalone config only; a community group without its evidence stays unknown', (t) => {
  const c0 = { key: K(0xc0), creator: Z, join: 'open' }
  t.alike(createGroupHint({ group: S, creator: Z, join: 'open', community: null }).members(), [Z], 'standalone, nothing fed')
  t.is(createGroupHint({ group: S, creator: Z, join: 'open' }).members(), null, 'an absent community')
  t.is(createGroupHint({ group: S, creator: Z, join: 'open', community: undefined }).members(), null, 'undefined')
  t.is(createGroupHint({ group: S, creator: Z, join: 'open', community: {} }).members(), null, 'malformed')
  t.is(createGroupHint({ group: S, creator: Z, join: 'open', community: { ...c0, key: S } }).members(), null, 'G as its own community')
  t.is(createGroupHint({ group: S, creator: Z, join: 'open', visibility: 'private', community: null }).members(), null, 'private and open')

  // A community group's root under the standalone config, and the reverse.
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  t.is(standaloneHint(g).members(), null, 'a root naming a community under community: null')
  t.is(standaloneHint(g).allowed(Z), UNKNOWN)
  const s = standalone().add(A, wA)
  t.is(standaloneHint(s, { community: c0 }).members(), null, 'a standalone root under a community config')

  // A community group whose caller lacks or garbles the parent's header:
  // never read as standalone, every answer unknown.
  const h0 = g.logs.get(G1).entries[0].record
  for (const [label, extra] of [['absent', {}], ['malformed', { community: { key: C.key } }]]) {
    const h = createGroupHint({ group: G1, creator: h0.diary, join: h0.join, visibility: h0.visibility, ...extra })
    for (const log of C.logs.values()) for (const e of log.entries) h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq, community: true })
    for (const log of g.logs.values()) for (const e of log.entries) h.add(e.record, { diary: log.diary, writer: log.key, seq: e.seq })
    t.is(h.members(), null, label + ' community evidence: no members')
    t.is(h.allowed(A), UNKNOWN, label + ' community evidence: unknown')
  }
})

test('a standalone root block 0 that is unreadable, misattributed or off the config taints the hint', (t) => {
  const config = { group: S, creator: Z, join: 'open', visibility: 'public', community: null }
  const header = (extra = {}) => groupHeader({ diary: Z, join: 'open', name: 'Varanda', at: AT(0), ...extra })
  const run = (cfg, record, diary = Z) => {
    const h = createGroupHint(cfg)
    h.add(record, { diary, writer: S, seq: 0 })
    h.add(writerHeader({ group: S, diary: A, member: S, at: AT(0) }), { diary: A, writer: wA, seq: 0 })
    return h
  }
  t.alike(run(config, header()).members(), [A, Z].sort(), 'the right root: decided')
  const cases = [
    ['a null root', config, null],
    ['a non-plain root', config, new Map()],
    ['an array root', config, [header()]],
    ['a root fed under another diary', config, header(), A],
    ['a root naming another diary', config, header({ diary: A })],
    ['a root with another join', config, header({ join: 'approval' })],
    ['a private root under a public config', { ...config, join: 'approval' }, header({ join: 'approval', visibility: 'private', name: null, box: K(0x7701) })],
    ['a community root at G', config, groupHeader({ kind: 'community', diary: Z, join: 'open', name: 'Bairro', at: AT(0) })],
    ['a root naming a community', config, header({ community: K(0xc0), member: K(0x91) })],
    ['an invalid root', config, { ...header(), at: 'x' }]
  ]
  for (const [label, cfg, record, diary] of cases) {
    const h = run(cfg, record, diary)
    t.is(h.members(), null, label)
    t.is(h.allowed(A), UNKNOWN, label + ': unknown')
  }
  // The fold agrees there is no group to notify about.
  for (const record of [null, groupHeader({ kind: 'community', diary: Z, join: 'open', name: 'Bairro', at: AT(0) })]) {
    const g = standalone().add(A, wA)
    g.logs.get(S).entries[0].record = record
    t.is(buildGroup(g.input()).members.size, 0, 'buildGroup: no members')
  }
  // A root block past 0 under another diary taints too: it may carry the
  // admits and bans the fold needs.
  const h = run(config, header())
  t.is(h.add(groupBan({ member: A, on: true, at: AT(5) }), { diary: A, writer: S, seq: 1 }), false)
  t.is(h.members(), null)
  t.is(h.allowed(A), UNKNOWN)
})

test('a community group root or C root block 0 off the config taints the hint', (t) => {
  const C = open4()
  const g = withWriters(groupIn(C, { key: G1 }))
  const g0 = g.logs.get(G1).entries[0].record
  const c0 = C.logs.get(C.key).entries[0].record
  const config = { group: G1, creator: Z, join: 'open', visibility: 'public', community: { key: C.key, creator: Z, join: 'open' } }
  const run = ({ cfg = config, groot = g0, gdiary = Z, croot = c0, cdiary = Z } = {}) => {
    const h = createGroupHint(cfg)
    for (const log of C.logs.values()) {
      for (const e of log.entries) {
        const own = log.key === C.key && e.seq === 0
        h.add(own ? croot : e.record, { diary: own ? cdiary : log.diary, writer: log.key, seq: e.seq, community: true })
      }
    }
    for (const log of g.logs.values()) {
      for (const e of log.entries) {
        const own = log.key === G1 && e.seq === 0
        h.add(own ? groot : e.record, { diary: own ? gdiary : log.diary, writer: log.key, seq: e.seq })
      }
    }
    return h
  }
  t.alike(run().members(), foldOf(g).members, 'the right roots: same members as buildGroup')
  const cases = [
    ['a null G root', { groot: null }],
    ['a non-plain G root', { groot: new Map() }],
    ['a G root fed under another diary', { gdiary: A }],
    ['a G root naming another diary', { groot: { ...g0, diary: A } }],
    ['a G root with another join', { groot: { ...g0, join: 'approval' } }],
    ['a G root with another visibility', { cfg: { ...config, join: 'approval' }, groot: { ...g0, join: 'approval', visibility: 'private', name: null, box: K(0x7701) } }],
    ['a G root naming another community', { groot: { ...g0, community: K(0xc1) } }],
    ['a standalone G root', { groot: groupHeader({ diary: Z, join: 'open', name: 'Varanda', at: AT(0) }) }],
    ['a community root at G', { groot: c0 }],
    ['a null C root', { croot: null }],
    ['a C root fed under another diary', { cdiary: A }],
    ['a C root with another join', { croot: { ...c0, join: 'approval' } }],
    ['a group root at C', { croot: g0 }]
  ]
  for (const [label, opts] of cases) {
    const h = run(opts)
    t.is(h.members(), null, label)
    t.is(h.allowed(A), UNKNOWN, label + ': unknown')
  }
})

test('standalone parity: demotion, join flips, admin and creator bans, second writers', (t) => {
  {
    const g = standalone({ join: 'approval' }).add(A, wA).add(B, wB).add(D, wD)
    g.push(S, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    g.push(S, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(22) }))
    t.alike(standaloneParity(t, g, 'demoted after admitting'), [B, Z].sort())
    g.push(wA, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: AT(23) }))
    t.is(standaloneHint(g).allowed(D), false, 'a demoted admin admits nobody')
    t.alike(standaloneParity(t, g, 'admit after demotion'), [B, Z].sort())
  }
  {
    const g = standalone().add(A, wA).add(B, wB)
    g.push(S, groupMeta({ name: 'Varanda', join: 'approval', at: AT(20) }))
    t.alike(standaloneParity(t, g, 'meta to approval'), [Z])
    g.push(S, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    t.alike(standaloneParity(t, g, 'then admitted'), [B, Z].sort())
    g.push(S, groupMeta({ name: 'Varanda', join: 'open', at: AT(22) }))
    t.alike(standaloneParity(t, g, 'meta back to open'), [A, B, Z].sort())
  }
  {
    const g = standalone().add(A, wA).add(B, wB)
    g.push(S, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    g.push(S, groupBan({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(21) }))
    g.push(wA, groupBan({ member: Z, on: true, at: AT(22) }))
    g.push(wB, groupBan({ member: A, on: true, at: AT(23) }))
    t.alike(standaloneParity(t, g, 'an admin and the creator cannot be banned'), [A, B, Z].sort())
  }
  {
    const wA2 = K(0x2001)
    const g = standalone({ join: 'approval' }).add(A, wA).add(A, wA2).add(B, wB).add(D, wD)
    g.push(S, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    // The grant lists wA only and covers wA2 from an auto cut the hint
    // cannot place: the fold counts wA2's admit, the hint leaves D unknown.
    g.push(wA2, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: AT(22) }))
    const { r, hinted } = standaloneSubset(t, g, 'a second writer for one diary')
    t.is(r.members.get(D), 'member', 'the fold counts the covered writer\'s admit')
    t.alike(hinted, [A, B, Z].sort(), 'the hint leaves D out')
    t.is(standaloneHint(g).allowed(D), UNKNOWN, 'D is unknown, never a member')
  }
})

test('standalone: a creator root mark, a missing writer header and any feed order', (t) => {
  {
    const g = standalone().add(A, wA).add(B, wB)
    g.push(S, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(20) }))
    g.mark(Z, S, 1)
    const { r, hinted } = standaloneSubset(t, g, 'creator root mark')
    t.is(r.incomplete, false, 'the fold is complete')
    t.is(hinted, null, 'the hint cannot judge a cut root')
  }
  {
    const g = standalone().add(A, wA).add(B, wB)
    const skip = (at) => at.writer === wB && at.seq === 0
    t.alike(standaloneHint(g, { skip }).members(), [A, Z].sort(), 'a writer with no header and no records is left out')
    g.push(wB, groupBan({ member: A, on: true, at: AT(20) }))
    t.is(standaloneHint(g, { skip }).members(), null, 'a record on a writer whose header is missing may be a ban')
    standaloneSubset(t, g, 'partial feed', { skip })
  }
  {
    const g = standalone({ join: 'approval' }).add(A, wA).add(B, wB).add(X, wX).add(Y, wY)
    g.push(S, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(20) }))
    g.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(21) }))
    const ban = g.push(S, groupBan({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(22) }))
    g.push(S, groupBan({ member: B, on: false, lifts: ban, cuts: [{ writer: wB, seq: 1 }], at: AT(23) }))
    g.push(wA, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(24) }))
    g.push(wX, groupLeave({ cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(25) }))
    const expected = standaloneParity(t, g, 'in order')
    t.alike(expected, [A, B, Z].sort())
    for (let seed = 1; seed <= 8; seed++) {
      t.alike(standaloneHint(g, { rng: prng(seed) }).members(), expected, 'shuffled feed, seed ' + seed)
    }
  }
})

// Random standalone worlds under a fixed seed: whatever the records, a
// diary the hint calls a member is one a complete fold calls a member, and
// neither the hint nor its answers throw.
test('standalone: randomized worlds keep the hint a subset of buildGroup', (t) => {
  const rng = prng(0x5eed)
  const pick = (list) => list[Math.floor(rng() * list.length)]
  const diaries = [A, B, X, Y, D]
  const ROUNDS = 250
  let complete = 0
  let decided = 0
  let bad = 0
  let several = 0
  let same = 0
  for (let round = 0; round < ROUNDS; round++) {
    const priv = rng() < 0.3
    const join = priv || rng() < 0.5 ? 'approval' : 'open'
    const g = standalone({ join, visibility: priv ? 'private' : 'public', box: priv ? K(0x7701) : null })
    const writers = new Map()
    let n = 0
    for (const d of diaries.slice(0, 2 + Math.floor(rng() * 4))) {
      const count = rng() < 0.2 ? 2 : 1
      for (let i = 0; i < count; i++) {
        const w = K(0x10000 + round * 64 + n++)
        g.add(d, w, { box: priv ? K(0x8000 + n) : null, name: rng() < 0.1 ? K(0x91) : S })
        if (!writers.has(d)) writers.set(d, [])
        writers.get(d).push(w)
      }
    }
    const all = [...writers.values()].flat()
    const targets = [...writers.keys(), Z]
    const bans = new Map()
    let s = 10
    const ops = Math.floor(rng() * 10)
    for (let i = 0; i < ops; i++) {
      const by = rng() < 0.4 ? S : pick(all)
      const d = pick(targets)
      const cuts = d === Z ? [] : [{ writer: writers.get(d)[0], seq: 1 }]
      const kind = Math.floor(rng() * 7)
      if (kind === 0) {
        if (d !== Z) g.push(S, groupAdmin({ member: d, on: rng() < 0.7, cuts, at: AT(s++) }))
      } else if (kind === 1) {
        g.push(by, groupAdmit({ member: d, on: rng() < 0.75, cuts, at: AT(s++) }))
      } else if (kind === 2) {
        bans.set(d, g.push(by, groupBan({ member: d, on: true, cuts, at: AT(s++) })))
      } else if (kind === 3 && bans.has(d)) {
        g.push(by, groupBan({ member: d, on: false, lifts: bans.get(d), cuts, at: AT(s++) }))
      } else if (kind === 4 && by !== S) {
        g.push(by, groupLeave({ cuts: [{ writer: by, seq: g.len(by) }], at: AT(s++) }))
      } else if (kind === 5 && !priv) {
        g.push(S, groupMeta({ name: 'Varanda', join: rng() < 0.5 ? 'open' : 'approval', at: AT(s++) }))
      } else if (kind === 6 && by !== S) {
        g.mark(g.logs.get(by).diary, by, 1 + Math.floor(rng() * g.len(by)))
      }
    }
    let r = null
    let hinted = null
    try {
      r = buildGroup(g.input())
      const h = standaloneHint(g, { rng })
      hinted = h.members()
      for (const d of [Z, ...diaries]) h.allowed(d)
    } catch (err) {
      t.fail('round ' + round + ' threw: ' + err.message)
      continue
    }
    if (r.incomplete) continue
    complete++
    if (hinted !== null) decided++
    const members = [...r.members].filter(([, st]) => st === 'member').map(([d]) => d)
    if ((hinted || []).some((d) => !members.includes(d))) {
      bad++
      t.fail('round ' + round + ': hinted ' + JSON.stringify(hinted) + ' not within ' + JSON.stringify(members))
    }
    if (hinted !== null && hinted.length > 1) several++
    if (hinted !== null && hinted.length === members.length) same++
  }
  t.comment(several + ' hints with members besides the creator, ' + same + ' equal to the fold')
  t.is(bad, 0, ROUNDS + ' rounds, ' + complete + ' complete folds, ' + decided + ' decided hints: never a non-member')
  t.ok(complete > ROUNDS / 2 && decided > complete / 2 && several > ROUNDS / 4, 'most rounds exercise a decided, non-trivial hint')
})
