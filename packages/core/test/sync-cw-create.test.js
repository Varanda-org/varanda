'use strict'

// The core sync's catalogue hint before C's held cores fold
// (docs/protocol.md section 10, "Catalogue hints"): the group-create records
// of C's root first, then those of the CWs of the root's diary by writer key
// and seq, each validated, at most MAX_CATALOGUE_SCAN distinct keys. A CW of
// another diary, or a core whose block 0 names another diary than the one
// its gate checked, adds nothing.

const test = require('brittle')
const { catalogueBlock, catalogueHint, MAX_CATALOGUE_SCAN } = require('../lib/sync')
const { groupHeader, writerHeader, groupCreateRecord } = require('../lib/group')

const k = (c) => c.repeat(64)
const C = k('c')
const D1 = k('a') // the creator
const D2 = k('b') // another diary
const W2 = k('5') // the creator's second device in C
const W3 = k('3') // the creator's third device, a smaller key
const WO = k('7') // another diary's CW
const WX = k('9') // block 0 names the creator, the gate checked D2
const GERAL = k('1')
const G2 = k('2')
const G3 = k('4')
const G4 = k('6')
const G5 = k('8')
const nth = (i) => i.toString(16).padStart(4, '0').repeat(16)
const create = (group) => groupCreateRecord({ group })

const scan = (gated) => ({ gated, diary: null, dead: false, creates: [], seqs: [] })

// Feeds `records` (block 0 first) to a fresh scan, as scanCatalogue reads
// them, the root's diary known as `creatorDiary`.
function scanned (key, gated, records, creatorDiary) {
  const s = scan(gated)
  records.forEach((r, seq) => catalogueBlock(s, seq, r, C, key === C, creatorDiary))
  return [key, s]
}

const rootHeader = () => groupHeader({ kind: 'community', diary: D1, name: 'Vila' })
const cwHeader = (diary) => writerHeader({ group: C, diary, member: null })

test('before C folds: a creator CW create is paged after the root\'s, another diary\'s CW create is not', (t) => {
  const root = scanned(C, D1, [rootHeader(), create(GERAL)], null)
  const list = [
    scanned(W2, D1, [cwHeader(D1), create(G2), { type: 'group-create', group: 'zz' }], D1),
    scanned(W3, D1, [cwHeader(D1), create(G3)], D1),
    scanned(WO, D2, [cwHeader(D2), create(G4)], D1),
    root
  ]
  t.alike(list[0][1].creates, [G2], 'an invalid create is not read')
  t.alike(list[2][1].creates, [], 'another diary\'s CW keeps no create')
  const hint = catalogueHint(C, list, () => Infinity)
  t.alike([...hint], [GERAL, G3, G2], 'root first, then CWs by key')
  t.absent(hint.has(G4))
})

test('a core whose block 0 names the creator under another gated diary is not paged', (t) => {
  const root = scanned(C, D1, [rootHeader(), create(GERAL)], null)
  const wx = scanned(WX, D2, [cwHeader(D1), create(G5)], D1)
  t.ok(wx[1].dead)
  t.alike(wx[1].creates, [])
  const own = scanned(W2, null, [cwHeader(D1), create(G2)], D1)
  t.alike(own[1].creates, [G2], 'an own core (no gate) reads its block 0')
  t.alike([...catalogueHint(C, [root, wx, own], () => Infinity)], [GERAL, G2])
})

test('a CW scanned before the root is pruned once the root names another diary', (t) => {
  const wo = scanned(WO, D2, [cwHeader(D2), create(G4)], null)
  t.alike(wo[1].creates, [G4], 'kept while the root is not known')
  const root = scanned(C, D1, [rootHeader(), create(GERAL)], null)
  t.alike([...catalogueHint(C, [root, wo], () => Infinity)], [GERAL])
  t.alike(wo[1].creates, [], 'and dropped')
  t.is(catalogueHint(C, [wo], () => Infinity), null, 'no hint without the root')
})

test('an own CW stops at its diary cut; the root\'s creates come first under the cap', (t) => {
  const root = scanned(C, D1, [rootHeader(), create(GERAL)], null)
  const w2 = scanned(W2, D1, [cwHeader(D1), create(G2), create(G3)], D1)
  t.alike([...catalogueHint(C, [root, w2], (key) => key === W2 ? 2 : Infinity)], [GERAL, G2], 'the create at the cut is not paged')

  const many = []
  for (let i = 0; i < MAX_CATALOGUE_SCAN; i++) many.push(nth(i))
  const full = scanned(C, D1, [rootHeader(), ...many.map(create)], null)
  const hint = catalogueHint(C, [scanned(W3, D1, [cwHeader(D1), create(G2)], D1), full], () => Infinity)
  t.is(hint.size, MAX_CATALOGUE_SCAN)
  t.absent(hint.has(G2), 'a CW create never takes a root create\'s place')
})
