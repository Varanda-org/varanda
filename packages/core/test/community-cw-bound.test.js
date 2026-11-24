'use strict'

// The bound a confirmed creator leave gives a creator CW (repairBound) for
// its group creates and its repairs: it comes from the earliest leave set
// that bounds the CW, and a later set never lowers it, as for C's root
// (docs/protocol.md, "The creator's root after a leave"), so a creator who
// leaves C twice keeps the groups its old devices created and the repairs
// they made.

const test = require('brittle')
const { groupLeave, groupCreateRecord, communityMetaCw, buildCommunity } = require('../lib/group')
const { K, community } = require('./helpers/groups')

const Z = K(0x9)
const cwZ2 = K(0x92)
const cwZ3 = K(0x93)
const cwZ5 = K(0x95)
const cwZ6 = K(0x96)
const cwZ7 = K(0x97)
const G1 = K(0x100)
const G2 = K(0x101)
const G3 = K(0x102)

const comm = (C) => buildCommunity(C.input())
const create = (C, w, group) => C.push(w, groupCreateRecord({ group, at: C.at() }))
const leave = (C, on, cuts) => C.push(on, groupLeave({ cuts, at: C.at() }))

// The creator writes G2 and G3 on cwZ3, leaves C from cwZ2 listing cwZ3 at
// 2 (G2 below the bound, G3 at it), confirms, and comes back on cwZ5.
function firstLeave () {
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ3)
  create(C, cwZ3, G2)
  create(C, cwZ3, G3)
  const L = leave(C, cwZ2, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }, { writer: cwZ3, seq: 2 }])
  C.confirm(Z, cwZ2)
  C.addWriter(Z, cwZ5, { rejoin: L })
  return C
}

test('a later confirmed leave that does not list an old CW keeps the creates the first bound counted', (t) => {
  const C = firstLeave()
  let c = comm(C)
  t.is(c.members.get(Z), 'member', 'control: the creator is back')
  t.ok(c.created.has(G2), 'control: below the first bound')
  t.absent(c.created.has(G3), 'control: at the first bound')
  // An honest second leave names the live writers only: cwZ3, retired by
  // the first leave, is not listed.
  leave(C, cwZ5, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ5, seq: C.len(cwZ5) }])
  C.confirm(Z, cwZ5)
  c = comm(C)
  t.is(c.members.get(Z), 'left', 'control: the second leave counts')
  t.ok(c.created.has(G2), 'the create below the first bound stays')
  t.absent(c.created.has(G3), 'the one at it stays out')
  t.ok(c.created.has(G1), 'the root create stays')
})

test('a later confirmed leave listing an old CW lower never lowers its bound', (t) => {
  const C = firstLeave()
  leave(C, cwZ5, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ5, seq: C.len(cwZ5) }, { writer: cwZ3, seq: 1 }])
  C.confirm(Z, cwZ5)
  const c = comm(C)
  t.is(c.members.get(Z), 'left', 'control: the second leave counts')
  t.ok(c.created.has(G2), 'the create below the first bound stays')
  t.absent(c.created.has(G3), 'the one at it stays out')
})

test('a later confirmed leave that does not list a bounded CW keeps the repairs it made', (t) => {
  // The creator leaves (set 0), returns on cwZ5 and cwZ6, repairs C's name
  // from cwZ5, then leaves from cwZ6 listing cwZ5 past the repair (set 1).
  const C = community({ creator: Z, creates: [] })
  C.addWriter(Z, cwZ2)
  const L0 = leave(C, cwZ2, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }])
  C.confirm(Z, cwZ2)
  C.addWriter(Z, cwZ5, { rejoin: L0 })
  C.addWriter(Z, cwZ6, { rejoin: L0 })
  C.push(cwZ5, communityMetaCw({ name: 'Reparado', join: 'open', at: C.at() }))
  const L1 = leave(C, cwZ6, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ6, seq: C.len(cwZ6) }, { writer: cwZ5, seq: C.len(cwZ5) }])
  C.confirm(Z, cwZ6)
  t.is(comm(C).name, 'Reparado', 'control: the repair counts below its bound')
  // Back again on cwZ7 and an honest third leave from it, naming only the
  // live writers.
  C.addWriter(Z, cwZ7, { rejoin: L1 })
  leave(C, cwZ7, [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ7, seq: C.len(cwZ7) }])
  C.confirm(Z, cwZ7)
  const c = comm(C)
  t.is(c.members.get(Z), 'left', 'control: the third leave counts')
  t.is(c.name, 'Reparado', 'the repair below the earlier bound stays')
})
