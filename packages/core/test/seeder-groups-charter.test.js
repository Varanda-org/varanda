'use strict'

// Seeder hints from the creator's other devices (docs/protocol.md section
// 10, "Seeder hints"): the name, image and about of a public group root or a
// community root also read the writers its header diary bound, ranked by
// what each record's `seen` anchors it after (as the fold orders charter),
// below each writer's diary cut, each on its own scan cursor.

const test = require('brittle')
const { until } = require('./helpers/net')
const { Seeder, groupWalkStep, liveGroupJoins } = require('../lib/seeder')
const { groupMeta, groupImage, groupAbout, communityMetaCw, communityImageCw, communityAboutCw, groupCreateRecord, groupPost: realPost } = require('../lib/group')
const { createGroupIndex } = require('../lib/group-index')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { groupHeader, writerHeader, encode, PARENT } = require('./helpers/seeder-groups')

const DAY = 86400000
const D = 'aa'.repeat(32) // the creator
const O = 'ab'.repeat(32) // another diary
const ROOT = 'bb'.repeat(32)
const W2 = 'c5'.repeat(32) // the creator's second device
const W3 = 'c3'.repeat(32) // the creator's third device
const WO = 'c7'.repeat(32) // a writer of O
const iso = (ms) => new Date(ms).toISOString()
const image = (c) => ({ core: c.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: 'dd'.repeat(32), width: 512, height: 512 })

function memCore (records) {
  return {
    records,
    get length () { return records.length },
    get contiguousLength () { return records.length },
    async get (i) { return encode(records[i]) }
  }
}

function setup ({ kind = 'group', visibility = 'public' } = {}) {
  const seeder = new Seeder({})
  seeder._passesStarted = true
  const blocked = new Set()
  seeder._blocklist = { blocked: () => blocked }
  for (const d of [D, O]) {
    seeder._admitted.set(d, {})
    seeder._served.set(d, { gated: true, scanned: 1, core: { length: 1, contiguousLength: 1 }, groupEvents: new Map() })
  }
  const header = kind === 'community'
    ? groupHeader({ kind, diary: D, name: 'Vila' })
    : visibility === 'public'
      ? groupHeader({ diary: D, name: 'Praia' })
      : groupHeader({ diary: D, visibility: 'private', join: 'approval', name: null, box: 'ee'.repeat(32) })
  const now = Date.now()
  const meta = kind === 'community' ? communityMetaCw : groupMeta
  const img = kind === 'community' ? communityImageCw : groupImage
  const about = kind === 'community' ? communityAboutCw : groupAbout
  const rootCore = memCore([header,
    groupMeta({ name: 'Raiz', join: 'open', at: iso(now - 30000) }),
    groupImage({ image: image('d1'), at: iso(now - 30000) }),
    groupAbout({ about: 'da raiz', at: iso(now - 30000) })])
  const root = { group: ROOT, headerOk: true, rootScanned: 0, rootDecoded: 0, core: rootCore }
  seeder._groupServed.set(ROOT, root)
  seeder._groupIndex.setHeader(ROOT, header)
  seeder._groupIndex.addWriter(ROOT, ROOT, D, 1)
  const writer = (key, diary, records, seq) => {
    const entry = { group: ROOT, diary, headerOk: true, cut: null, rootScanned: 0, charterScanned: 0, charterLimit: undefined, charterScanning: false, charterRetry: null, charterReadFailures: 0, core: memCore([writerHeader({ group: ROOT, diary }), ...records]) }
    seeder._groupServed.set(key, entry)
    seeder._groupIndex.addWriter(ROOT, key, diary, seq)
    return entry
  }
  // W2 names the root records it follows, with clocks behind the root's:
  // the anchor ranks, not `at`. W3 names the header only, one record far
  // ahead and one later in range; WO is another diary's.
  const onRoot = (seq) => ({ writer: ROOT, seq })
  const w2 = writer(W2, D, [
    groupPost('x'),
    meta({ name: 'Nova', join: 'approval', seen: onRoot(1), at: iso(now - 40000) }),
    img({ image: image('f2'), seen: onRoot(2), at: iso(now - 40000) }),
    about({ about: 'do segundo', seen: onRoot(3), at: iso(now - 40000) })
  ], 2)
  const w3 = writer(W3, D, [meta({ name: 'Futura', join: 'open', seen: onRoot(0), at: iso(now + DAY + 60000) }), about({ about: 'futuro', seen: onRoot(0), at: iso(now) })], 3)
  const wo = writer(WO, O, [meta({ name: 'Intrusa', join: 'open', seen: onRoot(3), at: iso(now) }), about({ about: 'intrusa', seen: onRoot(3), at: iso(now) })], 4)
  // The slot walk's cut of W2 (_charterCutAt): `at` its mark's.
  const cutW2 = (cut, at) => {
    w2.cut = cut
    const walk = { state: new Map([[W2, 'frozen']]), cut: new Map([[W2, cut]]), cutAt: new Map([[W2, Date.parse(at)]]) }
    seeder._served.get(D).groupWalks = new Map(cut === null ? [] : [[ROOT, walk]])
  }
  const scanRoot = async () => {
    seeder._scanRoot(ROOT, root)
    await until(() => !root.rootScanning, { name: 'varredura da raiz' })
  }
  const scan = async (key, entry) => {
    seeder._scanRoot(key, entry)
    await until(() => !entry.charterScanning, { name: 'varredura do aparelho' })
  }
  const scanAll = async () => {
    await scanRoot()
    for (const [k, e] of [[W2, w2], [W3, w3], [WO, wo]]) await scan(k, e)
  }
  return { seeder, blocked, root, w2, w3, wo, scanRoot, scan, scanAll, now, meta, about, onRoot, cutW2 }
}

// A post whose text holds the needle: decoded, never folded.
function groupPost (text) {
  return { type: 'group-post', text: 'group-meta ' + text, replyTo: null, seen: null, at: new Date().toISOString() }
}

const nameOf = (seeder) => {
  const h = seeder._groupIndex.header(ROOT)
  return h.kind === 'community' ? seeder._groupIndex.communityNameOf(ROOT) : seeder._groupIndex.nameOf(ROOT)
}

for (const kind of ['group', 'community']) {
  test(kind + ': a sibling anchored after the root records replaces the hints; earlier-anchored, foreign, cut and left ones do not', async (t) => {
    const { seeder, w2, scanAll, scan, cutW2, now } = setup({ kind })
    await scanAll()
    t.is(nameOf(seeder), 'Nova', 'the sibling name wins by its anchor, with an earlier at')
    t.alike(seeder.groupImagePublic(ROOT), { image: image('f2'), author: D })
    t.is(seeder.groupAboutPublic(ROOT), 'do segundo')
    t.alike(seeder._groupIndex.search('nova').groups.map((g) => g.group), kind === 'group' ? [ROOT] : [], 'search follows the sibling name')
    t.alike(seeder._groupIndex.search('intrusa').groups, [], 'another diary\'s writer never counts')
    t.alike(seeder._groupIndex.search('futura').groups, [], 'nor an earlier anchor with an at far ahead')
    if (kind === 'community') t.is(seeder._groupIndex.community(ROOT).join, 'approval', 'the join follows the meta')
    const link = await seeder.linkPublic(kind === 'group' ? 'g' : 'c', ROOT)
    t.is(link.name, 'Nova')
    t.is(link.about, 'do segundo')

    seeder._groupIndex.setLeft(W2, true)
    t.is(nameOf(seeder), 'Raiz', 'a left sibling is ignored')
    t.is(seeder.groupAboutPublic(ROOT), 'da raiz')
    seeder._groupIndex.setLeft(W2, false)
    t.is(nameOf(seeder), 'Nova')

    // A cut at block 3 voids the image and about (blocks 3 and 4) but keeps
    // the meta (block 2), its whole chain before the cut's at.
    cutW2(3, iso(now))
    await scan(W2, w2)
    t.is(nameOf(seeder), 'Nova', 'below the cut stays')
    t.alike(seeder.groupImagePublic(ROOT), { image: image('d1'), author: D }, 'at the cut goes')
    t.is(seeder.groupAboutPublic(ROOT), 'da raiz')
    // Only the cut the slot walk applies (entry.cut) counts: a cut mark the
    // walk ignored voids nothing, as in the fold.
    cutW2(null)
    seeder._served.get(D).groupEvents.set(ROOT, [{ kind: 'cut', writer: W2, cut: 2, seq: 9 }])
    await scan(W2, w2)
    t.is(nameOf(seeder), 'Nova', 'a cleared cut reads the writer again')
    t.is(seeder.groupAboutPublic(ROOT), 'do segundo')
    t.is(nameOf(seeder), 'Nova', 'a cut mark the walk ignores voids nothing')
  })

  test(kind + ': a root rescan keeps the sibling values and a sibling reset keeps the root\'s', async (t) => {
    const { seeder, root, w2, scanAll, scanRoot } = setup({ kind })
    await scanAll()
    root.rootScanned = 0
    await scanRoot()
    t.is(nameOf(seeder), 'Nova', 'name kept across a root rescan')
    t.alike(seeder.groupImagePublic(ROOT), { image: image('f2'), author: D }, 'image kept')
    t.is(seeder.groupAboutPublic(ROOT), 'do segundo', 'about kept')
    seeder._forgetCharter(W2, w2)
    t.is(nameOf(seeder), 'Raiz', 'resetCharter restores the root\'s')
    t.is(seeder.groupAboutPublic(ROOT), 'da raiz')
    t.alike(seeder.groupImagePublic(ROOT), { image: image('d1'), author: D })
  })

  test(kind + ': the hints wait while a sibling scan is behind', async (t) => {
    const { seeder, w2, scanAll, scan, onRoot } = setup({ kind })
    await scanAll()
    t.is(seeder.groupAboutPublic(ROOT), 'do segundo')
    w2.core.records.push(groupAbout({ about: 'mais nova', seen: onRoot(3) }))
    t.is(seeder.groupAboutPublic(ROOT), null, 'about waits for the sibling cursor')
    t.is(seeder.groupImagePublic(ROOT), null, 'image too')
    t.ok(seeder._rootScanBehind(ROOT))
    t.ok(seeder._rootGap(ROOT))
    t.is(await seeder.linkPublic(kind === 'group' ? 'g' : 'c', ROOT), null, 'the link page waits too')
    await scan(W2, w2)
    t.absent(seeder._rootScanBehind(ROOT))
    t.is(seeder.groupAboutPublic(ROOT), kind === 'group' ? 'mais nova' : 'do segundo', 'a root-shaped about off a community root never folds')
  })

  test(kind + ': a removed sibling or an unbound creator leaves only the root\'s hints', async (t) => {
    const { seeder, w2, scanAll, scan } = setup({ kind })
    await scanAll()
    seeder._groupIndex.removeWriter(ROOT)
    await scan(W2, w2)
    seeder._groupIndex.addWriter(ROOT, ROOT, D, 1)
    t.is(nameOf(seeder), 'Raiz', 'a root its creator does not bind reads no sibling')
    await scan(W2, w2)
    t.is(nameOf(seeder), 'Nova', 'bound again')
    seeder._groupIndex.removeWriter(W2)
    t.is(nameOf(seeder), 'Raiz', 'a removed sibling row takes its source along')
    seeder._groupIndex.addWriter(ROOT, W2, D, 2)
    seeder._forgetCharter(W2, w2)
    t.absent(seeder._charterScans.get(ROOT).has(W2), 'a forgotten writer leaves the scan set')
    t.absent(seeder._charterScans.get(ROOT).has(WO), 'another diary\'s writer never enters it')
  })
}

test('a private group root and its writers stay unscanned', async (t) => {
  const { seeder, root, w2 } = setup({ visibility: 'private' })
  root.core.get = () => { throw new Error('private root read') }
  w2.core.get = () => { throw new Error('private writer read') }
  seeder._scanRoot(ROOT, root)
  seeder._scanRoot(W2, w2)
  t.is(root.rootScanned, 0)
  t.is(w2.charterScanned, 0)
  t.absent(w2.charterScanning)
  t.is(seeder._groupIndex.nameOf(ROOT), null)
  t.is(seeder.groupAboutPublic(ROOT), null)
})

test('the notice name, image and about hints agree with nameOf; while behind the notice keeps the root\'s', async (t) => {
  const { seeder, w2, scanAll } = setup()
  await scanAll()
  const state = { name: 'Raiz' }
  t.is(seeder._noticeName(ROOT, state), 'Nova')
  t.is(seeder._noticeName(ROOT, state), seeder._groupIndex.nameOf(ROOT))
  t.alike(seeder.groupImagePublic(ROOT), { image: image('f2'), author: D }, 'the image of the same writer')
  t.is(seeder.groupAboutPublic(ROOT), 'do segundo')
  w2.core.records.push(groupAbout({ about: 'mais nova' }))
  t.is(seeder._noticeName(ROOT, state), 'Raiz', 'behind, the root\'s own')
})

test('a sibling anchored to a root record whose at is past the sibling\'s cut at is ignored', async (t) => {
  for (const kind of ['group', 'community']) {
    const { seeder, w2, scanAll, scan, cutW2, now } = setup({ kind })
    await scanAll()
    t.is(nameOf(seeder), 'Nova')
    // The meta (at now - 40000) sits below the cut, but the root meta it
    // names (at now - 30000) is after the cut's at.
    cutW2(3, iso(now - 35000))
    await scan(W2, w2)
    t.is(nameOf(seeder), 'Raiz', kind + ': no older record stands in either')
    cutW2(4, iso(now - 20000))
    await scan(W2, w2)
    t.is(nameOf(seeder), 'Nova', kind + ': the whole chain before the cut counts')
  }
})

test('a root cut by its creator\'s mark answers alone', async (t) => {
  const { seeder, w2, scanAll, scan } = setup()
  await scanAll()
  t.is(nameOf(seeder), 'Nova')
  seeder._served.get(D).groupEvents.set(ROOT, [{ kind: 'cut', writer: ROOT, cut: 2, seq: 9, at: new Date().toISOString() }])
  await scan(W2, w2)
  t.is(nameOf(seeder), 'Raiz')
  t.alike(seeder.groupImagePublic(ROOT), { image: image('d1'), author: D })
  t.is(seeder.groupAboutPublic(ROOT), 'da raiz')
  t.is(seeder._noticeName(ROOT, { name: null }), 'Raiz', 'the notice name too')
})

test('a root block a shown sibling record names is read alone when the root reaches it, never the sibling core again', async (t) => {
  const { seeder, root, w2, scan, scanRoot, onRoot, cutW2, now } = setup()
  // Superseded metas naming root seqs far ahead, then the shown one naming
  // root seq 4, all under a cut dated now.
  for (let i = 0; i < 20; i++) w2.core.records.push(groupMeta({ name: 'Velha ' + i, join: 'open', seen: onRoot(5 + i), at: iso(now - 60000) }))
  w2.core.records.push(groupMeta({ name: 'Adiante', join: 'open', seen: onRoot(4), at: iso(now - 50000) }))
  cutW2(100, iso(now))
  await scanRoot()
  await scan(W2, w2)
  t.is(nameOf(seeder), 'Raiz', 'root seq 4 is not held yet')
  let reads = 0
  const get = w2.core.get
  w2.core.get = (...args) => { reads++; return get(...args) }
  for (let i = 0; i < 22; i++) root.core.records.push(realPost({ text: 'oi ' + i, at: iso(now - 45000) }))
  await scanRoot()
  await until(() => nameOf(seeder) === 'Adiante', { name: 'ancora lida' })
  t.pass('the shown record ranks after root seq 4 with its anchor at read')
  t.is(reads, 0, 'the sibling core is not read again')
  t.alike(seeder._groupIndex.anchorsWanted(ROOT, root.rootScanned), [], 'nothing left to read')
})

// As seeder-groups.test.js noticeFixture: in-memory cores of a community
// and one public group of it, with every diary scan complete.
function noticeFixture () {
  const { K, community, groupIn } = require('./helpers/groups')
  const members = [0, 1].map((i) => ({ diary: K(100 + i), cw: K(1000 + i), status: 'member' }))
  const C = community({ creator: K(1), members })
  const G = groupIn(C, { key: K(2) })
  const writers = members.map((m, i) => {
    const w = K(2000 + i)
    G.add(m.diary, w)
    return w
  })
  G.push(writers[0], realPost({ text: 'history' }))
  const events = []
  const seeder = new Seeder({ onGroupNotice: (e) => events.push(e) })
  seeder._keyPair = signingKeyPair()
  seeder._passesStarted = true
  seeder._groupIndex = createGroupIndex()
  for (const scope of [C, G]) {
    for (const [key, log] of scope.logs) {
      const core = {
        fork: 0,
        get length () { return log.entries.length },
        get contiguousLength () { return log.entries.length },
        async get (seq) { return encode(log.entries[seq].record) }
      }
      seeder._groupServed.set(key, { core, group: scope.key, diary: log.diary, headerOk: true, dropped: false, noticeFrom: core.length, groupNotice: null, cut: null })
      seeder._groups.set(key, { group: scope.key, diary: log.diary, seq: 1, bound: true })
      seeder._groupIndex.addWriter(scope.key, key, log.diary, 1)
      if (key === scope.key) seeder._groupIndex.setHeader(key, log.entries[0].record)
      let diary = seeder._served.get(log.diary)
      if (!diary) {
        diary = { core: { length: 1, contiguousLength: 1 }, scanned: 1, gated: true, dropped: false, groupEvents: new Map(), groupLive: new Map() }
        seeder._served.set(log.diary, diary)
      }
      diary.groupLive.set(key, { group: scope.key, seq: 1, left: false })
    }
  }
  seeder._groupIncomplete = () => false
  const scan = async () => {
    seeder._queueGroupNotices()
    await until(() => {
      const state = seeder._groupServed.get(G.key).groupNotice
      return state !== null && !state.busy
    }, { name: 'group notice scan' })
  }
  return { seeder, C, G, writers, events, scan }
}

test('an unbound group or community root sends no member notice the bound one would', async (t) => {
  for (const unbound of [null, 'G', 'C']) {
    const f = noticeFixture()
    const off = unbound === 'G' ? f.G.key : unbound === 'C' ? f.C.key : null
    const bound = f.seeder._rootBound.bind(f.seeder)
    f.seeder._rootBound = (group, creator) => group !== off && bound(group, creator)
    await f.scan()
    f.G.push(f.writers[0], realPost({ text: 'nova' }))
    await f.scan()
    t.is(f.events.length, unbound === null ? 1 : 0, (unbound || 'none') + ' unbound')
    if (unbound === null) continue
    // Bound again: the hint is rebuilt and the next post notifies.
    f.seeder._rootBound = bound
    f.G.push(f.writers[0], realPost({ text: 'depois' }))
    await f.scan()
    t.is(f.events.length, 1, unbound + ' bound again')
  }
})

test('a restored sibling listed before its root is read once the reconcile indexes the root', async (t) => {
  const { seeder, root, w2, scanRoot } = setup()
  seeder._groupIndex.removeWriter(W2)
  seeder._groupIndex.removeWriter(ROOT)
  await scanRoot()
  t.is(seeder._groupIndex.nameOf(ROOT), 'Raiz')
  for (const name of ['_dropUnboundStubRows', '_queueGroupNotices', '_groupCutScan']) seeder[name] = () => {}
  seeder._persist = async () => {}
  seeder._stubJoin = () => true
  seeder._groups = new Map([
    [W2, { diary: D, group: ROOT, seq: 2 }],
    [ROOT, { diary: D, group: ROOT, seq: 1, bound: true, first: 1 }]
  ])
  const diary = Object.assign(seeder._served.get(D), {
    groupLive: new Map([[W2, { group: ROOT, seq: 2, left: false }], [ROOT, { group: ROOT, seq: 1, left: false }]]),
    groupWalks: new Map(),
    groupBound: new Map([[ROOT, { group: ROOT, seq: 1, first: 1 }]]),
    cert0: null
  })
  seeder._reconcileGroups(D, diary)
  await until(() => !w2.charterScanning, { name: 'varredura do aparelho' })
  t.is(root.rootScanned, root.core.length, 'the root was not read again')
  t.is(seeder._groupIndex.nameOf(ROOT), 'Nova', 'the sibling was read')
  t.absent(seeder._rootScanBehind(ROOT))
})

test('a left creator writer that withholds a block does not hold the hints back', async (t) => {
  const { seeder, w2, scanAll, scan } = setup()
  await scanAll()
  Object.defineProperty(w2.core, 'length', { get: () => w2.core.records.length + 1 })
  t.ok(seeder._rootGap(ROOT), 'a live sibling with a withheld block is a gap')
  seeder._groupIndex.setLeft(W2, true)
  t.absent(seeder._rootGap(ROOT), 'a left one is not')
  t.is(seeder.groupAboutPublic(ROOT), 'da raiz')
  t.is((await seeder.linkPublic('g', ROOT)).name, 'Raiz')
  await scan(W2, w2)
  t.absent(seeder._charterScans.get(ROOT).has(W2), 'its scan state is forgotten')
  t.is(w2.charterLimit, undefined)
  seeder._groupIndex.addWriter(ROOT, W2, D, 5)
  await scan(W2, w2)
  t.is(seeder._groupIndex.nameOf(ROOT), 'Nova', 'a rejoin reads it again')
})

test('a cut while a retry waits applies at once', async (t) => {
  const { seeder, w2, scanAll, scan, cutW2, now } = setup()
  await scanAll()
  t.alike(seeder.groupImagePublic(ROOT), { image: image('f2'), author: D })
  w2.charterRetry = setTimeout(() => {}, 60000)
  cutW2(3, iso(now))
  await scan(W2, w2)
  t.is(w2.charterLimit, 3)
  t.alike(seeder.groupImagePublic(ROOT), { image: image('d1'), author: D }, 'the image at the cut is gone')
  t.is(seeder._groupIndex.nameOf(ROOT), 'Nova', 'the meta below it read again')
  t.is(w2.charterRetry, null, 'the old retry is cleared')
})

for (const kind of ['group', 'community']) {
  test(kind + ': once the creator leaves from one writer, another writer\'s later rename does not replace the root\'s hints, even after a rejoin', async (t) => {
    const { seeder, w2, w3, scanAll, scan, onRoot, meta, now } = setup({ kind })
    await scanAll()
    t.is(nameOf(seeder), 'Nova')
    // The group listed in its community, past the Geral: the open-join shelf.
    const shelf = () => seeder._groupIndex.publicGroupsOf(D).groups.map((g) => g.group)
    if (kind === 'group') {
      seeder._groupIndex.setHeader(PARENT, groupHeader({ kind: 'community', diary: D, name: 'Bairro' }))
      for (const group of ['ee'.repeat(32), ROOT]) seeder._groupIndex.foldRoot(PARENT, groupCreateRecord({ group, at: iso(now) }))
      t.alike(shelf(), [], 'the sibling\'s approval join keeps it off')
    }
    for (const name of ['_dropUnboundStubRows', '_queueGroupNotices', '_groupCutScan']) seeder[name] = () => {}
    seeder._persist = async () => {}
    seeder._stubJoin = () => true
    seeder._groups = new Map([
      [ROOT, { diary: D, group: ROOT, seq: 1, bound: true, first: 1 }],
      [W2, { diary: D, group: ROOT, seq: 2 }],
      [W3, { diary: D, group: ROOT, seq: 3 }]
    ])
    const walks = new Map()
    const decls = new Map()
    const diary = Object.assign(seeder._served.get(D), { groupDecls: decls, groupWalks: walks, groupBound: new Map([[ROOT, { group: ROOT, seq: 1, first: 1 }]]), cert0: null })
    const join = (writer, on, seq) => {
      groupWalkStep(walks, ROOT, { kind: 'join', writer, on, seq })
      decls.set(writer, { group: ROOT, on, seq, at: iso(now) })
      diary.groupLive = liveGroupJoins(decls, walks)
    }
    join(ROOT, true, 1)
    join(W2, true, 2)
    join(W3, true, 3)
    seeder._reconcileGroups(D, diary)
    t.is(nameOf(seeder), 'Nova', 'no leave yet')

    join(W3, false, 9)
    seeder._reconcileGroups(D, diary)
    w2.core.records.push(meta({ name: 'Roubada', join: 'approval', seen: onRoot(3), at: iso(now) }))
    await scan(W2, w2)
    const shown = async () => {
      t.is(nameOf(seeder), 'Raiz')
      t.is((await seeder.linkPublic(kind === 'group' ? 'g' : 'c', ROOT)).name, 'Raiz')
      t.alike(seeder._groupIndex.search('roubada').groups, [])
      if (kind === 'community') t.is(seeder._groupIndex.community(ROOT).join, 'open', 'the root\'s join')
      else t.alike(shelf(), [ROOT], 'the open-join shelf takes the root\'s join')
    }
    await shown()

    join(W3, true, 10)
    seeder._reconcileGroups(D, diary)
    await until(() => !w3.charterScanning, { name: 'varredura do aparelho' })
    await scan(W2, w2)
    await shown()
  })
}
