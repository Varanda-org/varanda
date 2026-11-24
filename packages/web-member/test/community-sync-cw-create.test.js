'use strict'

// The browser sync's catalogue hint before C's held cores fold
// (docs/protocol.md section 10, "Catalogue hints"): C's root creates first,
// in root order, then those of the CWs of the root's diary by writer key and
// seq, below each CW's diary cut when the creator's diary is held, at most
// `max` distinct keys. A CW of another diary adds nothing.

const test = require('brittle')
const { groupJoinRecord, groupCutRecord, MAX_GROUPS_PER_COMMUNITY } = require('@varanda/core/lib/records')
const { catalogueHint } = require('../lib/sync')

const k = (c) => c.repeat(64)
const C = k('c')
const D1 = k('a') // the creator
const D2 = k('b') // another diary
const W2 = k('5') // the creator's second device in C
const W3 = k('3') // the creator's third device, a smaller key
const WO = k('7') // another diary's CW
const GERAL = k('1')
const G2 = k('2')
const G3 = k('4')
const G4 = k('6')
const nth = (i) => i.toString(16).padStart(4, '0').repeat(16)
const cw = (key, diary, creates) => ({ key, diary, creates, seqs: creates.map((_, i) => i + 1) })

test('before C folds: a creator CW create is paged after the root\'s, another diary\'s CW create is not', (t) => {
  const scans = [cw(W2, D1, [G2]), cw(W3, D1, [G3, GERAL]), cw(WO, D2, [G4])]
  t.alike(catalogueHint(C, D1, [GERAL], scans, 64, null), [GERAL, G3, G2], 'root first, then CWs by key, each once')
})

test('a CW stops at its diary cut when the creator\'s diary is held', (t) => {
  const entries = [
    { seq: 1, record: groupJoinRecord({ group: C, writer: W2, on: true }) },
    { seq: 2, record: groupCutRecord({ group: C, writer: W2, cut: 2 }) }
  ]
  const scans = [cw(W2, D1, [G2, G3])]
  t.alike(catalogueHint(C, D1, [GERAL], scans, 64, entries), [GERAL, G2], 'the create at the cut is not paged')
  t.alike(catalogueHint(C, D1, [GERAL], scans, 64, null), [GERAL, G2, G3], 'without the diary, every create')
})

test('the root\'s creates come first under the cap', (t) => {
  const max = 2 * MAX_GROUPS_PER_COMMUNITY
  const many = []
  for (let i = 0; i < max; i++) many.push(nth(i))
  const keys = catalogueHint(C, D1, many, [cw(W3, D1, [G2])], max, null)
  t.is(keys.length, max)
  t.absent(keys.includes(G2), 'a CW create never takes a root create\'s place')
  t.ok(catalogueHint(C, D1, many.slice(1), [cw(W3, D1, [G2])], max, null).includes(G2), 'below the cap it is paged')
})
