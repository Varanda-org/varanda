'use strict'

// Catalogue hints from the creator's other devices (docs/protocol.md
// section 10, "Catalogue hints"): a community's index lists the
// group-create records of C's root first, in root order, then those of the
// CWs its creator's diary binds, by writer key then seq, below each CW's
// diary cut, each group once, never in place of a root create. A
// group-leave on one of those CWs, or more than MAX_GROUPS_PER_COMMUNITY
// distinct groups, lists the root's alone.

const test = require('brittle')
const { until } = require('./helpers/net')
const { Seeder } = require('../lib/seeder')
const { createGroupIndex } = require('../lib/group-index')
const { groupCreateRecord, groupLeave } = require('../lib/group')
const { MAX_GROUPS_PER_COMMUNITY } = require('../lib/records')
const { groupHeader, writerHeader, encode } = require('./helpers/seeder-groups')

const k = (c) => c.repeat(64)
const C = k('c')
const D1 = k('a') // the creator
const D2 = k('b') // another diary
const W2 = k('5') // the creator's second device in C
const W3 = k('3') // the creator's third device in C, a smaller key
const WO = k('7') // another diary's CW in C
const GERAL = k('1')
const G1 = k('2')
const G2 = k('4')
const G3 = k('6')
const G4 = k('8')
const create = (group) => groupCreateRecord({ group })
// Group roots past the hex digits of the named ones, for the cap.
const nth = (i) => i.toString(16).padStart(4, '0').repeat(16)

function index (groups = [GERAL, G1, G2, G3, G4]) {
  const idx = createGroupIndex()
  idx.setHeader(C, groupHeader({ kind: 'community', diary: D1, name: 'Vila' }))
  idx.addWriter(C, C, D1, 1)
  idx.addWriter(C, W2, D1, 2)
  idx.addWriter(C, W3, D1, 3)
  idx.addWriter(C, WO, D2, 4)
  let seq = 5
  for (const G of groups) {
    idx.setHeader(G, groupHeader({ diary: D1, community: C, member: C, name: 'Grupo' }))
    idx.addWriter(G, G, D1, seq++)
  }
  return idx
}

const rows = (idx) => idx.community(C).groups.map((r) => r.group)

test('a create on a creator-bound CW is listed and attaches; one on another diary\'s CW is not', (t) => {
  const idx = index()
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.ok(idx.foldCharter(C, W2, create(G2), { seq: 1 }))
  t.absent(idx.foldCharter(C, WO, create(G3), { seq: 1 }), 'another diary\'s CW folds nothing')
  t.absent(idx.foldCharter(C, W2, create(C), { seq: 2 }), 'a create naming C itself')
  t.alike(rows(idx), [GERAL, G2].sort())
  t.ok(idx.attached(C, G2))
  t.is(idx.communityOf(G2), C)
  t.absent(idx.attached(C, G3))
  t.alike(idx.createdIn(C), [GERAL, G2].sort())
  t.is(idx.generalOf(C), GERAL)
})

test('a CW create never becomes Geral', (t) => {
  const idx = index()
  t.ok(idx.foldCharter(C, W2, create(G2), { seq: 1 }))
  t.alike(rows(idx), [G2])
  t.is(idx.generalOf(C), null)
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.is(idx.generalOf(C), GERAL)
})

test('a root rescan keeps the CW creates; a CW reset or removal keeps the root\'s', (t) => {
  const idx = index()
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.ok(idx.foldCharter(C, W2, create(G2), { seq: 1 }))
  t.ok(idx.resetRoot(C))
  t.alike(rows(idx), [G2], 'the CW create stays across a root reset')
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.alike(rows(idx), [GERAL, G2].sort())
  t.ok(idx.resetCharter(C, W2))
  t.alike(rows(idx), [GERAL], 'a CW reset keeps the root\'s')
  t.ok(idx.foldCharter(C, W2, create(G2), { seq: 1 }))
  t.ok(idx.removeWriter(W2))
  t.alike(rows(idx), [GERAL])
})

test('a left CW or a leave of the creator\'s diary lists the root\'s alone; a root cut too', (t) => {
  const idx = index()
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.ok(idx.foldCharter(C, W2, create(G2), { seq: 1 }))
  t.ok(idx.foldCharter(C, W3, create(G1), { seq: 1 }))
  t.ok(idx.setLeft(W2, true))
  t.alike(rows(idx), [GERAL, G1].sort(), 'a left CW lists nothing')
  t.ok(idx.setLeft(W2, false))
  t.ok(idx.setRootCut(C, true))
  t.alike(rows(idx), [GERAL])
  t.ok(idx.setRootCut(C, false))
  t.alike(rows(idx), [GERAL, G1, G2].sort())
  t.ok(idx.markLeave(W3))
  t.alike(rows(idx), [GERAL], 'after the creator\'s leave the root answers alone')
  t.absent(idx.attached(C, G2))
})

test('the cap: up to MAX_GROUPS_PER_COMMUNITY distinct groups the CW creates are listed; past it the root\'s alone', (t) => {
  const many = []
  for (let i = 0; i < MAX_GROUPS_PER_COMMUNITY; i++) many.push(nth(i))
  const idx = index([...many, G1, G2])
  // 31 root creates, Geral first.
  for (let i = 0; i < MAX_GROUPS_PER_COMMUNITY - 1; i++) t.ok(idx.foldRoot(C, create(many[i]), i + 1))
  t.ok(idx.foldCharter(C, W3, create(G1), { seq: 1 }))
  t.ok(idx.foldCharter(C, W3, create(many[0]), { seq: 2 }), 'a group already listed takes no second slot')
  let listed = idx.createdIn(C)
  t.is(listed.length, MAX_GROUPS_PER_COMMUNITY)
  t.ok(listed.includes(G1), 'at the cap the CW create is listed')
  t.ok(idx.attached(C, G1))
  // A 33rd distinct group: the fold orders the CWs causally, unknown here,
  // so no CW create is listed.
  t.ok(idx.foldCharter(C, W2, create(G2), { seq: 1 }))
  listed = idx.createdIn(C)
  t.is(listed.length, MAX_GROUPS_PER_COMMUNITY - 1, 'the root\'s alone')
  t.absent(listed.includes(G1))
  t.absent(listed.includes(G2))
  t.absent(idx.attached(C, G1))
  t.is(idx.generalOf(C), many[0])
  // A later root create fills the cap; the CWs still list none.
  t.ok(idx.foldRoot(C, create(many[MAX_GROUPS_PER_COMMUNITY - 1]), MAX_GROUPS_PER_COMMUNITY))
  listed = idx.createdIn(C)
  t.is(listed.length, MAX_GROUPS_PER_COMMUNITY)
  for (const G of many) t.ok(listed.includes(G), 'every root create stays')
  t.absent(listed.includes(G1))
  t.absent(idx.attached(C, G1))
  t.ok(idx.attached(C, many[0]))
  t.is(idx.generalOf(C), many[0], 'Geral stays')
  // Dropping the 33rd lists the CW create again only while it fits.
  t.ok(idx.resetCharter(C, W2))
  t.absent(idx.createdIn(C).includes(G1), 'root and CW groups still pass the cap')
})

test('a group-leave on a creator CW lists the root\'s alone, across a CW reset, a root rescan and the writer\'s removal', (t) => {
  const idx = index()
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.ok(idx.foldCharter(C, W3, create(G2), { seq: 1 }))
  t.alike(rows(idx), [GERAL, G2].sort(), 'control: without the leave')
  t.absent(idx.foldCharter(C, WO, groupLeave({ cuts: [{ writer: WO, seq: 1 }] }), { seq: 1 }), 'another diary\'s CW folds nothing')
  t.alike(rows(idx), [GERAL, G2].sort())
  t.ok(idx.foldCharter(C, W2, groupLeave({ cuts: [{ writer: W2, seq: 1 }] }), { seq: 1 }))
  t.alike(rows(idx), [GERAL])
  t.absent(idx.attached(C, G2))
  t.ok(idx.resetCharter(C, W2))
  t.ok(idx.resetRoot(C))
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.alike(rows(idx), [GERAL], 'the leave stays')
  t.ok(idx.removeWriter(W2))
  t.alike(rows(idx), [GERAL], 'and after its writer is removed')
})

test('a group-leave on the community root lists the root\'s alone, across a root rescan', (t) => {
  const idx = index()
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.ok(idx.foldCharter(C, W3, create(G2), { seq: 1 }))
  t.alike(rows(idx), [GERAL, G2].sort(), 'control: without the leave')
  t.ok(idx.foldRoot(C, groupLeave({ cuts: [{ writer: C, seq: 2 }] }), 2))
  t.alike(rows(idx), [GERAL])
  t.absent(idx.attached(C, G2))
  t.ok(idx.resetRoot(C))
  t.ok(idx.foldRoot(C, create(GERAL), 1))
  t.alike(rows(idx), [GERAL], 'the leave stays')
})

// The seeder side: the creator-bound writer scan (_scanCharter) folds a CW's
// group-create, below its diary cut, into /index/community and /index/group.
function memCore (records) {
  return {
    records,
    get length () { return records.length },
    get contiguousLength () { return records.length },
    async get (i) { return encode(records[i]) }
  }
}

function setup ({ w2Records = [create(G2), create(G4)], w3Records = null, rootRecords = [] } = {}) {
  const seeder = new Seeder({})
  seeder._passesStarted = true
  const blocked = new Set()
  seeder._blocklist = { blocked: () => blocked }
  for (const d of [D1, D2]) {
    seeder._admitted.set(d, {})
    seeder._served.set(d, { gated: true, scanned: 1, core: { length: 1, contiguousLength: 1 }, groupEvents: new Map() })
  }
  const header = groupHeader({ kind: 'community', diary: D1, name: 'Vila' })
  const root = { group: C, headerOk: true, rootScanned: 0, rootDecoded: 0, core: memCore([header, create(GERAL), ...rootRecords]) }
  seeder._groupServed.set(C, root)
  seeder._groupIndex.setHeader(C, header)
  seeder._groupIndex.addWriter(C, C, D1, 1)
  const writer = (key, diary, records, seq) => {
    const entry = { group: C, diary, headerOk: true, cut: null, rootScanned: 0, charterScanned: 0, charterLimit: undefined, charterScanning: false, charterRetry: null, charterReadFailures: 0, core: memCore([writerHeader({ group: C, diary, member: null }), ...records]) }
    seeder._groupServed.set(key, entry)
    seeder._groupIndex.addWriter(C, key, diary, seq)
    return entry
  }
  // W2's second create sits at the seq a cut voids below.
  const w2 = writer(W2, D1, w2Records, 2)
  const wo = writer(WO, D2, [create(G3)], 3)
  const w3 = w3Records === null ? null : writer(W3, D1, w3Records, 8)
  let seq = 4
  for (const G of [GERAL, G2, G3, G4]) {
    const h = groupHeader({ diary: D1, community: C, member: C, name: 'Grupo' })
    seeder._groupServed.set(G, { group: G, headerOk: true, rootScanned: 1, rootDecoded: 1, core: memCore([h]) })
    seeder._groupIndex.setHeader(G, h)
    seeder._groupIndex.addWriter(G, G, D1, seq++)
  }
  const scanRoot = async () => {
    seeder._scanRoot(C, root)
    await until(() => !root.rootScanning, { name: 'varredura da raiz' })
  }
  const scan = async (key, entry) => {
    seeder._scanRoot(key, entry)
    await until(() => !entry.charterScanning, { name: 'varredura do aparelho' })
  }
  const scanAll = async () => {
    await scanRoot()
    await scan(W2, w2)
    await scan(WO, wo)
    if (w3 !== null) await scan(W3, w3)
  }
  return { seeder, root, w2, wo, w3, scanRoot, scan, scanAll }
}

const listedAt = (seeder) => seeder.indexCommunity(C).groups.map((r) => r.group)

test('seeder: a creator CW create is listed by /index/community and attached in /index/group; a foreign CW create is not', async (t) => {
  const { seeder, scanAll } = setup()
  await scanAll()
  const c = seeder.indexCommunity(C)
  t.ok(c.complete)
  t.alike(listedAt(seeder), [GERAL, G2, G4].sort())
  t.ok(seeder.indexGroup(G2).attached)
  t.is(seeder.indexGroup(G2).community, C)
  t.absent(seeder.indexGroup(G3).attached, 'another diary\'s CW create attaches nothing')
  t.ok(seeder.indexGroup(GERAL).attached)
})

test('seeder: a root rescan keeps a CW create; one at or above the CW\'s diary cut is dropped', async (t) => {
  const { seeder, root, w2, scanAll, scanRoot, scan } = setup()
  await scanAll()
  root.rootScanned = 0
  await scanRoot()
  t.alike(listedAt(seeder), [GERAL, G2, G4].sort(), 'kept across a root rescan')
  // A cut at block 2 voids G4's create (block 2) and keeps G2's (block 1).
  w2.cut = 2
  await scan(W2, w2)
  t.alike(listedAt(seeder), [GERAL, G2].sort())
  t.absent(seeder.indexGroup(G4).attached, 'at the cut goes')
  t.ok(seeder.indexGroup(G2).attached, 'below the cut stays')
  w2.cut = 1
  await scan(W2, w2)
  t.alike(listedAt(seeder), [GERAL])
})

test('seeder: a CW create waits for its scan, and the creator\'s leave drops it from the hints', async (t) => {
  const { seeder, w2, scanAll, scan } = setup()
  await scanAll()
  w2.core.records.push(create(G3))
  t.ok(seeder._rootScanBehind(C))
  t.absent(seeder.indexCommunity(C).complete, 'the community waits for the CW cursor')
  await scan(W2, w2)
  t.ok(seeder.indexCommunity(C).complete)
  t.ok(seeder.indexGroup(G3).attached, 'now from the creator\'s own CW')
  seeder._groupIndex.markLeave(W2)
  t.alike(listedAt(seeder), [GERAL], 'the root answers alone after a leave of the creator\'s diary')
  t.absent(seeder.indexGroup(G2).attached)
})

test('seeder: a group-leave on a creator CW lists the root\'s creates alone, also after a CW reset or a root rescan', async (t) => {
  const leave = groupLeave({ cuts: [{ writer: W2, seq: 1 }] })
  const control = setup({ w2Records: [], w3Records: [create(G2)] })
  await control.scanAll()
  t.alike(listedAt(control.seeder), [GERAL, G2].sort(), 'control: without the leave')
  t.ok(control.seeder.indexGroup(G2).attached)

  const { seeder, root, w2, scanAll, scanRoot, scan } = setup({ w2Records: [leave], w3Records: [create(G2)] })
  await scanAll()
  t.alike(listedAt(seeder), [GERAL])
  t.absent(seeder.indexGroup(G2).attached, 'a leave on z2 retires z3\'s create too')
  root.rootScanned = 0
  await scanRoot()
  t.alike(listedAt(seeder), [GERAL], 'after a root rescan')
  w2.cut = 3
  await scan(W2, w2)
  t.alike(listedAt(seeder), [GERAL], 'after a CW reset')
  t.absent(seeder.indexGroup(G2).attached)
})

test('seeder: an unconfirmed group-leave on the community root lists the root\'s creates alone', async (t) => {
  const { seeder, scanAll } = setup({ w2Records: [], w3Records: [create(G2)], rootRecords: [groupLeave({ cuts: [{ writer: C, seq: 2 }] })] })
  await scanAll()
  t.ok(seeder.indexCommunity(C).complete)
  t.alike(listedAt(seeder), [GERAL])
  t.absent(seeder.indexGroup(G2).attached, 'a root leave retires the CWs\' creates too')
  t.ok(seeder.indexGroup(GERAL).attached)
})

test('seeder: a CW leave past its diary cut, kept by the cut, lists the root\'s creates alone', async (t) => {
  const leave = groupLeave({ cuts: [{ writer: W2, seq: 1 }] })
  const { seeder, w2, scanAll, scan } = setup({ w2Records: [leave], w3Records: [create(G2)] })
  // The cut is there before the first scan: the leave at seq 1 is past it.
  w2.cut = 1
  await scanAll()
  t.alike(listedAt(seeder), [GERAL, G2].sort(), 'control: the cut has not kept the leave yet')
  // The cut pass keeps the leave (_cutGroupCore) and wakes the scan.
  w2.keptPast = new Map([[1, 64]])
  t.ok(seeder._rootScanBehind(C), 'behind while a kept block past the cut is unread')
  seeder._charterPastKept(W2, w2)
  await until(() => !w2.charterScanning, { name: 'varredura do aparelho' })
  t.absent(seeder._rootScanBehind(C))
  t.alike(listedAt(seeder), [GERAL])
  t.absent(seeder.indexGroup(G2).attached)
  // Read again under a moved cut: the leave stays.
  w2.cut = 2
  await scan(W2, w2)
  t.alike(listedAt(seeder), [GERAL])
})
