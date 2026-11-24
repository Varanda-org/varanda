'use strict'

// The catalogue from the community creator's other devices: a group-create
// on one of the creator's CWs counts after the root's creates, never for
// anyone else, and a leave or a diary cut bounds it.

const test = require('brittle')
const {
  MAX_GROUPS_PER_COMMUNITY, groupLeave, groupCreateRecord, buildGroup, buildCommunity
} = require('../lib/group')
const { K, AT, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const B = K(0x3)
const cwA = K(0x20)
const cwA2 = K(0x21)
const cwB = K(0x30)
const cwZ2 = K(0x92)
const cwZ3 = K(0x93)
const cwZ4 = K(0x94)
const G1 = K(0x100)
const G2 = K(0x101)
const G3 = K(0x102)
const G4 = K(0x103)
const G5 = K(0x104)

const comm = (C) => buildCommunity(C.input())
const create = (C, w, group, extra = {}) => C.push(w, groupCreateRecord({ group, at: C.at(), ...extra }))
const leaveAll = (C, on, cuts) => C.push(on, groupLeave({ cuts, at: C.at() }))

test('a creator CW create lists the group, after the root creates', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  create(C, cwZ2, G2)
  let c = comm(C)
  t.alike(c.groups, [G1, G2].sort())
  t.alike(c.created.get(G2), { writer: cwZ2, seq: 1, diary: Z })
  t.is(c.general, G1, 'Geral stays the root\'s first create')
  t.is(buildGroup(groupIn(C, { key: G2, diary: Z }).input()).orphan, false, 'the creator\'s group attaches')
  t.is(buildGroup(groupIn(C, { key: G2, diary: A }).input()).orphan, true, 'a header naming another diary stays an orphan')

  // A root create of the same group keeps the root's entry, later or not.
  C.push(C.key, groupCreateRecord({ group: G2, at: C.at() }))
  c = comm(C)
  t.is(c.created.get(G2).writer, C.key)
  t.is(c.groups.length, 2, 'each group once')
})

test('a CW create never becomes Geral', (t) => {
  const C = community({ creator: Z })
  C.addWriter(Z, cwZ2)
  create(C, cwZ2, G2)
  let c = comm(C)
  t.alike(c.groups, [G2])
  t.is(c.general, null)
  C.push(C.key, groupCreateRecord({ group: G3, at: C.at() }))
  c = comm(C)
  t.is(c.general, G3, 'the root\'s first counted create')
  t.alike(c.groups, [G2, G3].sort())
})

test('a member\'s or an admin\'s CW create never counts and adds no node', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  // A's second device, covered by the admin grant.
  C.addWriter(A, cwA2)
  const before = comm(C)
  t.ok(before.admins.has(A), 'control: A is a C admin')
  create(C, cwA, G2)
  create(C, cwA2, G3)
  create(C, cwB, G4)
  const c = comm(C)
  t.alike(c.groups, [G1])
  t.alike(c.last, before.last, 'dropped before the causal order')
  t.is(buildGroup(groupIn(C, { key: G2, diary: A }).input()).orphan, true)
})

test('root creates come first: the cap never evicts one, and past it a CW create is an orphan', (t) => {
  const roots = []
  for (let i = 0; i < MAX_GROUPS_PER_COMMUNITY - 2; i++) roots.push(K(0x7000 + i))
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  // CW creates written before the root's later ones.
  create(C, cwZ2, G2)
  create(C, cwZ2, G3)
  for (const g of roots) C.push(C.key, groupCreateRecord({ group: g, at: C.at() }))
  let c = comm(C)
  t.is(c.groups.length, MAX_GROUPS_PER_COMMUNITY)
  t.is(c.general, G1)
  for (const g of roots) t.ok(c.created.has(g), 'every root create stays')
  t.ok(c.created.has(G2), 'the first CW create takes the last slot')
  t.absent(c.created.has(G3), 'the next one is over the cap')
  t.is(buildGroup(groupIn(C, { key: G3, diary: Z }).input()).orphan, true, 'an orphan')

  // One more root create fills the catalogue from the root alone.
  C.push(C.key, groupCreateRecord({ group: G4, at: C.at() }))
  c = comm(C)
  t.ok(c.created.has(G4), 'a later root create still enters')
  t.absent(c.created.has(G2), 'and the CW create gives up its slot')
  t.is(c.groups.length, MAX_GROUPS_PER_COMMUNITY)
})

test('a confirmed creator leave listing a CW bounds its creates at the listed cut', (t) => {
  for (const root of [true, false]) {
    const label = root ? 'listing the root: ' : 'root untouched: '
    const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    C.addWriter(Z, cwZ3)
    C.addWriter(Z, cwZ4)
    create(C, cwZ3, G2)
    create(C, cwZ3, G3)
    create(C, cwZ4, K(0x200))
    const cuts = [{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: cwZ3, seq: 2 }]
    if (root) cuts.unshift({ writer: C.key, seq: C.len(C.key) })
    leaveAll(C, cwZ2, cuts)
    C.confirm(Z, cwZ2)
    // At or above the cut, whatever at or seen they carry.
    C.push(cwZ3, groupCreateRecord({ group: G4, at: AT(0) }))
    C.push(cwZ3, groupCreateRecord({ group: G5, seen: { writer: C.key, seq: 1 }, at: AT(1) }))
    C.push(C.key, groupCreateRecord({ group: K(0x201), at: C.at() }))
    const c = comm(C)
    t.is(c.rootAuthority, !root, label + 'control: the root powers')
    t.ok(c.created.has(G2), label + 'below the cut stays')
    t.absent(c.created.has(G3), label + 'at the cut does not')
    t.absent(c.created.has(G4), label + 'nor a backdated one')
    t.absent(c.created.has(G5), label + 'nor one naming an early root seq')
    t.absent(c.created.has(K(0x200)), label + 'an unlisted CW keeps none')
    t.is(c.created.has(K(0x201)), !root, label + 'the root creates while it keeps its powers')
    t.is(c.general, G1)
  }
})

test('a create past a leave on its own CW never counts, whatever another leave lists', (t) => {
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ3)
  create(C, cwZ2, G2)
  leaveAll(C, cwZ2, [{ writer: cwZ2, seq: C.len(cwZ2) }])
  create(C, cwZ2, G3)
  // A confirmed leave listing cwZ2 past its own leave.
  leaveAll(C, cwZ3, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) + 1 }, { writer: cwZ3, seq: C.len(cwZ3) }])
  C.confirm(Z, cwZ3)
  const c = comm(C)
  t.ok(c.created.has(G2), 'below both leaves')
  t.absent(c.created.has(G3), 'past its own leave')
})

test('an unconfirmed leave on another CW retires its generation\'s CWs but voids none of their creates; on the root no CW create counts', (t) => {
  // The creator leaves from cwZ2 but the diary never confirms it, then
  // returns: the root keeps its powers, and so does the new CW, and cwZ4
  // of the leave's generation, with no confirmed bound, keeps its create.
  let C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ4)
  create(C, cwZ4, K(0x200))
  const L = leaveAll(C, cwZ2, [{ writer: C.key, seq: 0 }, { writer: cwZ2, seq: C.len(cwZ2) }, { writer: cwZ4, seq: 0 }])
  C.addWriter(Z, cwZ3, { rejoin: L })
  create(C, cwZ3, G2)
  let c = comm(C)
  t.is(c.rootAuthority, true, 'control: no gate')
  t.ok(c.created.has(G2), 'the later CW creates')
  t.ok(c.created.has(G1), 'the root create stays')
  t.ok(c.created.has(K(0x200)), 'a retired CW with no confirmed bound keeps its create')

  // Only an unconfirmed leave on the root: the gate is set and no CW has a
  // confirmed bound, so no CW create counts.
  C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  create(C, cwZ2, G2)
  leaveAll(C, C.key, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }])
  create(C, cwZ2, G3)
  c = comm(C)
  t.is(c.rootAuthority, false, 'control: the root leave ends the root powers')
  t.alike(c.groups, [G1], 'neither CW create counts')
})

test('a returning creator\'s later-generation CW creates nothing', (t) => {
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  create(C, cwZ2, G2)
  const L = leaveAll(C, cwZ2, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }])
  C.confirm(Z, cwZ2)
  C.addWriter(Z, cwZ3, { rejoin: L })
  create(C, cwZ3, G3)
  let c = comm(C)
  t.is(c.members.get(Z), 'member', 'control: the creator is back')
  t.ok(c.created.has(G2), 'a create below its own leave stays')
  t.absent(c.created.has(G3), 'the new CW creates nothing')
  // A second confirmed leave, on cwZ3, bounds cwZ3 past G3's create: the
  // bound alone does not let a CW of a generation after the gate create.
  leaveAll(C, cwZ3, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ3, seq: C.len(cwZ3) }])
  C.confirm(Z, cwZ3)
  c = comm(C)
  t.ok(c.created.has(G2), 'control: the first CW create stays')
  t.absent(c.created.has(G3), 'a bound on a later-generation CW creates nothing')
})

test('a diary cut at or below a CW create removes it, one above does not', (t) => {
  for (const [cut, kept] of [[1, []], [2, [G2]], [3, [G2, G3]]]) {
    const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    create(C, cwZ2, G2)
    create(C, cwZ2, G3)
    C.mark(Z, cwZ2, cut)
    const c = comm(C)
    t.alike(c.groups, [G1, ...kept].sort(), 'cut at ' + cut)
  }
})
