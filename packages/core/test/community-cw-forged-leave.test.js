'use strict'

// A forged creator leave: a thief holding one of the creator's CWs writes
// a leave there that the creator's diary never confirms. It retires the
// CWs of that generation, but, as for repairs ("An unconfirmed leave voids
// no repair"), it voids no group create on another CW: the groups the
// creator made on an honest device stay in the catalogue.

const test = require('brittle')
const { groupLeave, groupCreateRecord, buildGroup, buildCommunity } = require('../lib/group')
const { K, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const cwZ2 = K(0x92)
const cwZ4 = K(0x94)
const G1 = K(0x100)
const G2 = K(0x101)
const G3 = K(0x102)
const G4 = K(0x103)

const comm = (C) => buildCommunity(C.input())
const create = (C, w, group) => C.push(w, groupCreateRecord({ group, at: C.at() }))
const leave = (C, on, cuts) => C.push(on, groupLeave({ cuts, at: C.at() }))

// The creator made G2 on its honest CW cwZ4; the thief holds cwZ2.
function world () {
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ4)
  create(C, cwZ4, G2)
  return C
}

test('a forged leave on a stolen CW voids no create on another CW of its generation', (t) => {
  for (const listsSibling of [false, true]) {
    const name = listsSibling ? 'listing cwZ4 at 0: ' : 'own writer only: '
    const C = world()
    t.ok(comm(C).created.has(G2), name + 'control: listed before the leave')
    const cuts = [{ writer: cwZ2, seq: C.len(cwZ2) }]
    if (listsSibling) cuts.push({ writer: cwZ4, seq: 0 })
    leave(C, cwZ2, cuts)
    const c = comm(C)
    t.is(c.rootAuthority, true, name + 'control: no confirmed leave, the root keeps its powers')
    t.absent(c.liveWriters.has(cwZ4), name + 'control: the leave retires cwZ4')
    t.ok(c.created.has(G2), name + 'the create on cwZ4 stays')
    t.is(buildGroup(groupIn(C, { key: G2, diary: Z }).input()).orphan, false, name + 'and the group still attaches')
  }
})

test('a forged leave: the stolen CW counts only below its own leave, and the diary cut stays the remedy', (t) => {
  const C = world()
  // The thief's create before its leave, and one after it.
  create(C, cwZ2, G3)
  leave(C, cwZ2, [{ writer: cwZ2, seq: C.len(cwZ2) }])
  create(C, cwZ2, G4)
  let c = comm(C)
  t.ok(c.created.has(G2), 'the honest CW keeps its create')
  t.ok(c.created.has(G3), 'a create below the thief\'s own leave counts until the diary cut, as before any leave')
  t.absent(c.created.has(G4), 'control: none past its own leave')
  C.mark(Z, cwZ2, 1)
  c = comm(C)
  t.absent(c.created.has(G3), 'control: the diary cut drops the thief\'s create')
  t.ok(c.created.has(G2), 'and keeps the honest one')
})

test('an unconfirmed leave on C\'s root still lets no CW create count', (t) => {
  const C = world()
  leave(C, C.key, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }, { writer: cwZ4, seq: C.len(cwZ4) }])
  const c = comm(C)
  t.is(c.rootAuthority, false, 'control: the root leave ends the root powers')
  t.alike(c.groups, [G1], 'with the gate set and no confirmed bound, no CW create counts')
})
