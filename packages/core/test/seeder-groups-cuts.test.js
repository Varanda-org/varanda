'use strict'

// The writers a diary cut (#350, docs/protocol.md section 10) at a seeder:
// the slot walk picks the writers that count (liveGroupJoins), a frozen
// writer is kept below its cut only, a released one is purged, and a
// restart recomputes both from admitted.json and the scan.

const test = require('brittle')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { liveGroupJoins, groupWalkStep, groupWalkCut } = require('../lib/seeder')
const {
  groupJoinRecord,
  groupCutRecord,
  MAX_GROUP_WRITERS_PER_DIARY,
  MAX_FROZEN_WRITERS_PER_DIARY,
  MAX_WRITER_RELEASES_PER_DIARY,
  MAX_GROUPS_PER_DIARY
} = require('../lib/records')
const { groupPost, groupLeave } = require('../lib/group')
const {
  groupHeader,
  writerHeader,
  hex,
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  member,
  admit,
  reader,
  admitted,
  rejected,
  stored,
  downloaded,
  readGroups,
  scansDone
} = require('./helpers/seeder-groups')

const G = 'aa'.repeat(32)

function key (i) {
  return (i + 1).toString(16).padStart(64, '0')
}

// A diary's group records in seq order (from 1), fed as the scan feeds them:
// { decls, walks } for liveGroupJoins.
function diary (records) {
  const decls = new Map()
  const walks = new Map()
  records.forEach((r, n) => {
    const seq = n + 1
    if (r.type === 'join') {
      const prev = decls.get(r.writer)
      if (prev === undefined || seq > prev.seq) decls.set(r.writer, { group: r.group, on: r.on, seq, at: '2026-11-16T00:00:00.000Z' })
      groupWalkStep(walks, r.group, { kind: 'join', writer: r.writer, on: r.on, seq })
    } else {
      groupWalkStep(walks, r.group, { kind: 'cut', writer: r.writer, cut: r.cut, seq })
    }
  })
  return { decls, walks }
}

const join = (writer, on = true, group = G) => ({ type: 'join', group, writer, on })
const cut = (writer, at, group = G) => ({ type: 'cut', group, writer, cut: at })

function kept (records) {
  const { decls, walks } = diary(records)
  return liveGroupJoins(decls, walks)
}

test('liveGroupJoins: a cut frees a slot for a 9th writer, never past 8 live and 8 frozen (#350)', (t) => {
  const eight = []
  for (let i = 0; i < 8; i++) eight.push(join(key(i)))
  t.absent(kept([...eight, join(key(8))]).has(key(8)), 'control: the 9th is past the cap')
  const frozen = kept([...eight, cut(key(0), 2), join(key(8))])
  t.ok(frozen.has(key(8)), 'a freeze lets the 9th in')
  t.ok(frozen.has(key(0)), 'and the frozen writer stays')
  const released = kept([...eight, cut(key(0), 0), join(key(8))])
  t.ok(released.has(key(8)), 'so does a release')
  t.absent(released.has(key(0)), 'and the released writer goes')

  // Eight frozen, then eight live: the 17th never counts.
  const full = []
  for (let i = 0; i < MAX_FROZEN_WRITERS_PER_DIARY; i++) full.push(join(key(i)), cut(key(i), 1))
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) full.push(join(key(100 + i)))
  full.push(join(key(200)))
  const out = kept(full)
  t.is(out.size, MAX_GROUP_WRITERS_PER_DIARY + MAX_FROZEN_WRITERS_PER_DIARY, '8 + R writers')
  t.absent(out.has(key(200)), 'the next one is past both caps')
  // A ninth cut finds no frozen room: the writer stays live with its cut.
  const { walks } = diary([...full, cut(key(100), 3)])
  t.is(groupWalkCut(walks, G, key(100)), 3, 'its cut still applies')
  t.is(walks.get(G).state.get(key(100)), 'live', 'and it keeps its live slot')
})

test('liveGroupJoins: a counted writer whose join is off stays, left; an uncounted one does not (#350)', (t) => {
  const records = []
  for (let i = 0; i < 9; i++) records.push(join(key(i)))
  records.push(join(key(1), false), join(key(8), false), cut(key(1), 2))
  const out = kept(records)
  t.alike(out.get(key(1)), { group: G, seq: 10, left: true }, 'frozen and left: kept for its history')
  t.absent(out.has(key(8)), 'never counted: not kept')
  t.alike(out.get(key(0)), { group: G, seq: 1, left: false })

  // A group the diary left entirely still keeps its counted writers, the
  // root key never through an off join.
  const H = 'bb'.repeat(32)
  const gone = kept([join(H, true, H), join(key(50), true, H), join(key(50), false, H), join(H, false, H)])
  t.alike(gone.get(key(50)), { group: H, seq: 3, left: true })
  t.absent(gone.has(H), 'the root key is not kept through an off join')
})

test('liveGroupJoins: groups past MAX_GROUPS_PER_DIARY keep no writer, left or not (#350)', (t) => {
  const records = []
  for (let g = 0; g <= MAX_GROUPS_PER_DIARY; g++) records.push(join(key(1000 + g), true, key(5000 + g)))
  // The writer of the group past the cap leaves; another joins it.
  const last = key(5000 + MAX_GROUPS_PER_DIARY)
  records.push(join(key(1000 + MAX_GROUPS_PER_DIARY), false, last), join(key(3000), true, last))
  const out = kept(records)
  t.is(new Set([...out.values()].map((j) => j.group)).size, MAX_GROUPS_PER_DIARY)
  t.absent(out.has(key(1000 + MAX_GROUPS_PER_DIARY)), 'not kept as left')
  t.absent(out.has(key(3000)))
})

test('liveGroupJoins: a join, cut 0, join loop stops at K releases (#350)', (t) => {
  const records = []
  const ever = new Set()
  for (let i = 0; i < 100; i++) {
    records.push(join(key(i)))
    for (const w of kept(records).keys()) ever.add(w)
    records.push(cut(key(i), 0))
  }
  const { walks } = diary(records)
  const s = walks.get(G)
  t.is(s.released, MAX_WRITER_RELEASES_PER_DIARY, 'K writers released')
  t.is(s.live, MAX_GROUP_WRITERS_PER_DIARY, 'then cut 0 keeps eight live slots at cut 0')
  t.is(ever.size, MAX_WRITER_RELEASES_PER_DIARY + MAX_GROUP_WRITERS_PER_DIARY, 'the seeder was asked for 24 writers in all')
  t.is(kept(records).size, 0, 'and keeps none of them now')
  t.is(groupWalkCut(walks, G, key(20)), 0, 'a cut 0 past K still reads as 0')
})

test('liveGroupJoins: without cuts it keeps what the earliest-join rule kept', (t) => {
  // The rule it replaces (lib/group.js capPerDiary), for writers that are on.
  const old = (records) => {
    const first = new Map()
    const newest = new Map()
    records.forEach((r, n) => {
      newest.set(r.writer, { ...r, seq: n + 1 })
      if (r.on && !first.has(r.writer)) first.set(r.writer, n + 1)
    })
    const order = [...first].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([w]) => w)
    const allowed = new Set(order.slice(0, MAX_GROUP_WRITERS_PER_DIARY))
    const out = new Map()
    for (const [w, j] of newest) if (j.on && allowed.has(w)) out.set(w, j.seq)
    return out
  }
  let seed = 7
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 200; round++) {
    const records = []
    for (let i = 0, n = 1 + rnd(30); i < n; i++) records.push(join(key(rnd(14)), rnd(3) !== 0))
    const got = new Map()
    for (const [w, j] of kept(records)) if (!j.left) got.set(w, j.seq)
    t.alike([...got].sort(), [...old(records)].sort(), 'round ' + round)
  }
})

// Creator A with root R; member B with writer W (header and five posts),
// joined to R; `extra` more records for B's diary.
async function cutWorld (t, bootstrap, assoc, extra = () => []) {
  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Varal' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const posts = []
    for (let i = 0; i < 5; i++) posts.push(groupPost({ text: 'post ' + i }))
    W = await make('w', writerHeader({ group: R, diary: key }), posts)
    return [groupJoinRecord({ group: R, writer: W, on: true }), ...extra(R, W)]
  })
  return { A, B, R, W }
}

// One more writer core of member m in group R (header and one post).
async function addWriter (m, R, name) {
  const core = m.store.get({ name })
  await core.ready()
  await core.append(b4a.from(JSON.stringify(writerHeader({ group: R, diary: m.key }))))
  await core.append(b4a.from(JSON.stringify(groupPost({ text: 'segundo' }))))
  m.cores[name] = core
  return hex(core.key)
}

function settledFor (seeder, m) {
  return until(() => scansDone(seeder) && seeder._groupReserved.size === 0 &&
    seeder._served.get(m.key) && seeder._served.get(m.key).scanned === m.diary.length, { name: 'diário varrido ' + m.key.slice(0, 8) })
}

async function blocksHeld (core, from, to) {
  const out = []
  for (let i = from; i < to; i++) if (await core.has(i)) out.push(i)
  return out
}

test('a cut after the download clears from the cut, keeps only leaves and key blocks past it, and serves what it keeps with proofs (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, W)
  await downloaded(seeder, W, 6)
  t.absent('cut' in readGroups(dataDir)[W], 'no cut yet')

  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 3 }))
  const entry = seeder._groupServed.get(W)
  await until(async () => entry.cut === 3 && !entry.cutting && (await blocksHeld(entry.core, 0, 6)).length === 3, { name: 'W cortado em 3' })
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1, 2], 'only the blocks below the cut are stored')
  t.is(entry.core.contiguousLength, 3)
  t.is(readGroups(dataDir)[W].cut, 3, 'the cut is persisted with the binding')
  t.ok(seeder._groupServed.has(W), 'the writer stays served')

  // B keeps writing past its cut: a post goes, a leave and a key block stay
  // (the fold counts them past a cut), and so does the next post's gap.
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'depois do corte' }))))
  await B.cores.w.append(b4a.from(JSON.stringify(groupLeave({ cuts: [{ writer: W, seq: 7 }] }))))
  await B.cores.w.append(b4a.from(JSON.stringify({ type: 'group-key' })))
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'mais um' }))))
  await until(async () => entry.core.length === 10 && !entry.cutting && entry.clearedTo === 10, { name: 'W lido depois do corte' })
  t.alike(await blocksHeld(entry.core, 0, 10), [0, 1, 2, 7, 8], 'below the cut, then the leave and the key block only')

  // B goes; a reader that dials the seeder only verifies the kept blocks
  // against the signed length (Hypercore checks each proof).
  await B.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  const copy = r.store.get({ key: b4a.from(W, 'hex') })
  await copy.ready()
  await until(() => copy.length === 10, { name: 'comprimento assinado no leitor', timeoutMs: 30000 })
  for (let i = 0; i < 3; i++) t.ok(await copy.get(i, { timeout: 15000 }), 'block ' + i + ' verified from the seeder')
  const leave = JSON.parse(b4a.toString(await copy.get(7, { timeout: 15000 })))
  t.is(leave.type, 'group-leave', 'the leave past the cut is served, verified')
  t.is(JSON.parse(b4a.toString(await copy.get(8, { timeout: 15000 }))).type, 'group-key', 'and the key block')
  await t.exception(copy.get(3, { timeout: 3000 }), 'a post past the cut is not served')
  await t.exception(copy.get(9, { timeout: 3000 }), 'nor one after the leave')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a 9th writer after a freeze is admitted at its cut, a counted writer whose join is off is admitted as left, the 10th never (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Roda' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  const W = []
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    for (let i = 0; i < 10; i++) W.push(await make('w' + i, writerHeader({ group: R, diary: key }), [groupPost({ text: 'oi ' + i })]))
    return [
      ...W.slice(0, 8).map((w) => groupJoinRecord({ group: R, writer: w, on: true })),
      groupJoinRecord({ group: R, writer: W[1], on: false }),
      groupCutRecord({ group: R, writer: W[0], cut: 1 }),
      groupJoinRecord({ group: R, writer: W[8], on: true }),
      groupJoinRecord({ group: R, writer: W[9], on: true })
    ]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  for (const w of W.slice(0, 9)) await admitted(events, w)
  await settledFor(seeder, B)
  t.absent(events.some((e) => e.key === W[9]), 'the 10th is past the cap and never tried')
  t.absent(W[9] in readGroups(dataDir))
  t.is(readGroups(dataDir)[W[0]].cut, 1, 'the frozen writer is listed at its cut')
  await until(async () => seeder._groupServed.get(W[0]).core.contiguousLength === 1, { name: 'W0 abaixo do corte' })
  t.is(await seeder._groupServed.get(W[0]).core.has(1), false, 'and holds nothing past it')
  await downloaded(seeder, W[8], 2)
  t.absent('cut' in readGroups(dataDir)[W[8]], 'the 9th has no cut')

  const rows = new Map(seeder._groupIndex.page(R).items.filter((i) => i.diary === B.key).map((i) => [i.key, i]))
  t.is(rows.size, 9, 'nine writers of B listed')
  t.ok(seeder._groupServed.has(W[1]), 'the writer whose join is off is served')
  t.is(seeder._groupIndex.writer(W[1]).left, true, 'and marked left')
  t.is(seeder._groupIndex.writer(W[0]).left, false, 'a frozen writer with its join on is not')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a writer its diary cut at 0 is purged and leaves the index (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, W)
  await downloaded(seeder, W, 6)

  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 0 }))
  await rejected(events, W, 'released')
  await until(async () => seeder._drops.size === 0 && !(W in readGroups(dataDir)) && !(await stored(seeder, W)), { name: 'W purgado' })
  t.is(seeder._groupIndex.writer(W), null, 'no index row')
  await settledFor(seeder, B)
  t.absent(seeder._groupReserved.has(W), 'and it is not admitted again')
  t.ok(seeder._groupServed.has(R), 'the root stays')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a restart restores a writer at its persisted cut and the scan lowers it or releases it (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  const W2 = await addWriter(B, R, 'w2')
  await B.diary.append(groupJoinRecord({ group: R, writer: W2, on: true }))
  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 4 }))
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, W)
  await admitted(first.events, W2)
  await settledFor(first.seeder, B)
  // Held before the restart, or the restore drops them as headerless.
  await downloaded(first.seeder, W, 4)
  await downloaded(first.seeder, W2, 2)
  t.is(readGroups(dataDir)[W].cut, 4)
  await first.seeder.close()

  // While the seeder is down B lowers W's cut and releases W2.
  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 2 }))
  await B.diary.append(groupCutRecord({ group: R, writer: W2, cut: 0 }))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const entry = second.seeder._groupServed.get(W)
  t.ok(entry, 'W served at ready')
  t.ok(entry.cut === 4 || entry.cut === 2, 'from its persisted cut')
  await rejected(second.events, W2, 'released')
  await until(async () => entry.cut === 2 && !entry.cutting && (await blocksHeld(entry.core, 0, 6)).length === 2, { name: 'W cortado em 2' })
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1])
  t.is(readGroups(dataDir)[W].cut, 2, 'the lower cut is persisted')
  await until(async () => second.seeder._drops.size === 0 && !(W2 in readGroups(dataDir)) && !(await stored(second.seeder, W2)), { name: 'W2 purgado' })
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a cut writer is held to its whole log\'s quota: refused past it at admission, dropped once it grows past it (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBytes: 20000 })
  // Blocks past a cut are only read at the seeder, never validated: a raw
  // block near the block limit is enough to cross the byte quota.
  const big = () => b4a.from(JSON.stringify({ type: 'group-post', text: 'x'.repeat(12000) }))

  // W is cut at 2 and already holds 24 KB past its cut when B is admitted.
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc, (R, W) => [groupCutRecord({ group: R, writer: W, cut: 2 })])
  await B.cores.w.append(big())
  await B.cores.w.append(big())
  await admit(A, assoc)
  await admit(B, assoc)
  t.is((await rejected(events, W, 'quota')).reason, 'quota', 'refused at admission: the bytes past the cut count')
  t.absent(seeder._groupServed.has(W))

  // W2, cut at 2 while small, is served; it then grows past the quota.
  const W2 = await addWriter(B, R, 'w2')
  await B.diary.append(groupJoinRecord({ group: R, writer: W2, on: true }))
  await B.diary.append(groupCutRecord({ group: R, writer: W2, cut: 2 }))
  await admitted(events, W2)
  await downloaded(seeder, W2, 2)
  t.ok(seeder._groupServed.has(W2), 'served while within the quota')
  await B.cores.w2.append(big())
  await B.cores.w2.append(big())
  t.is((await rejected(events, W2, 'quota')).reason, 'quota', 'dropped once its log passes the quota')
  await until(() => !seeder._groupServed.has(W2), { name: 'W2 fora' })
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
