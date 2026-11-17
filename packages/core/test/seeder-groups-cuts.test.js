'use strict'

// The writers a diary cut (#350, docs/protocol.md section 10) at a seeder:
// the slot walk picks the writers that count (liveGroupJoins), a frozen
// writer is kept below its cut plus its leaves and key blocks, a released
// one as a stub (block 0, leaves, key blocks), the quota counts what is
// kept, and a restart recomputes both from admitted.json and the scan.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { createSwarm, attachAdmission } = require('../lib/net')
const { openStore } = require('../lib/store')
const { Seeder, liveGroupJoins, groupWalkStep, groupWalkCut } = require('../lib/seeder')
const {
  groupJoinRecord,
  groupCutRecord,
  deleteRecord,
  MAX_GROUP_WRITERS_PER_DIARY,
  MAX_FROZEN_WRITERS_PER_DIARY,
  MAX_WRITER_RELEASES_PER_DIARY,
  MAX_GROUPS_PER_DIARY
} = require('../lib/records')
const { groupPost, groupLeave, diaryGroupKeys } = require('../lib/group')
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
  downloaded,
  readGroups,
  scansDone,
  gate
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

test('liveGroupJoins: a cut frees a slot for a 9th writer, never past 8 live, 8 frozen and 16 released (#350)', (t) => {
  const eight = []
  for (let i = 0; i < 8; i++) eight.push(join(key(i)))
  t.absent(kept([...eight, join(key(8))]).has(key(8)), 'control: the 9th is past the cap')
  const frozen = kept([...eight, cut(key(0), 2), join(key(8))])
  t.ok(frozen.has(key(8)), 'a freeze lets the 9th in')
  t.ok(frozen.has(key(0)), 'and the frozen writer stays')
  const released = kept([...eight, cut(key(0), 0), join(key(8))])
  t.ok(released.has(key(8)), 'so does a release')
  t.alike(released.get(key(0)), { group: G, seq: 1, left: true }, 'and the released writer stays, left')
  t.is(diary([...eight, cut(key(0), 0)]).walks.get(G).state.get(key(0)), 'released')
  t.is(groupWalkCut(diary([...eight, cut(key(0), 0)]).walks, G, key(0)), 0, 'kept at cut 0')
  t.is(groupWalkCut(diary([...eight, cut(key(1), 2)]).walks, G, key(1)), 2, 'a frozen writer at its cut')
  t.is(groupWalkCut(diary(eight).walks, G, key(0)), null, 'a live writer has none')

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
  t.is(walks.get(G).cut.get(key(100)), 3, 'its cut still applies')
  t.is(walks.get(G).state.get(key(100)), 'live', 'and it keeps its live slot')
})

test('liveGroupJoins: a counted writer whose join is off stays, left; an uncounted one does not (#350)', (t) => {
  const records = []
  for (let i = 0; i < 9; i++) records.push(join(key(i)))
  records.push(join(key(1), false), join(key(8), false), cut(key(1), 2))
  const out = kept(records)
  t.alike(out.get(key(1)), { group: G, seq: 2, left: true }, 'frozen and left: kept for its history, by its on join')
  t.absent(out.has(key(8)), 'never counted: not kept')
  t.alike(out.get(key(0)), { group: G, seq: 1, left: false })

  // A group the diary left entirely still keeps its counted writers, the
  // root key never through an off join.
  const H = 'bb'.repeat(32)
  const gone = kept([join(H, true, H), join(key(50), true, H), join(key(50), false, H), join(H, false, H)])
  t.alike(gone.get(key(50)), { group: H, seq: 2, left: true })
  t.absent(gone.has(H), 'the root key is not kept through an off join')
})

test('liveGroupJoins: a left or released writer is listed by its newest on join for the group, never an off join (#350)', (t) => {
  // Readers check the item's seq against an on:true join naming the writer.
  const H = 'bb'.repeat(32)
  const out = kept([
    join(key(0)), join(key(0)), join(key(0), false),
    join(key(1)), cut(key(1), 0), join(key(1), false),
    join(key(2), true, H), join(key(2)), join(key(2), false),
    join(key(3)), join(key(3), false), join(key(3)), join(key(3), false)
  ])
  t.alike(out.get(key(0)), { group: G, seq: 2, left: true }, 'joined twice, then left: the second join')
  t.alike(out.get(key(1)), { group: G, seq: 4, left: true }, 'released, then left: its join')
  t.alike(out.get(key(2)), { group: G, seq: 8, left: true }, 'an on join to another group is not it')
  t.alike(out.get(key(3)), { group: G, seq: 12, left: true }, 'left, back and left again: the last on join')
})

test('a stored binding the scan no longer lists gets its on join too, never an off one (#350)', (t) => {
  // An older seeder stored W in G with its off join (seq 2); the diary then
  // named W in H, so the scan lists W there and not in G.
  const D = key(90)
  const H = 'bb'.repeat(32)
  const W = key(0)
  const { decls, walks } = diary([join(W), join(W, false), join(W, true, H)])
  // A diary the scan read to its length (its certificate and three records),
  // as _groupCutScan reads it on every reconcile.
  const entry = { gated: true, dropped: false, scanned: 4, core: { length: 4 }, groupDecls: decls, groupWalks: walks, groupBound: new Map(), groupRefused: new Map(), groupLive: liveGroupJoins(decls, walks) }
  t.is(entry.groupLive.get(W).group, H, 'the scan lists W in H only')
  const rows = []
  const seeder = Object.create(Seeder.prototype)
  Object.assign(seeder, {
    _closing: false,
    _groups: new Map([[W, { diary: D, group: G, seq: 2 }]]),
    _groupServed: new Map([[W, { dropped: false, cut: null, cutConfirmed: false }]]),
    _groupIndex: {
      addWriter: (group, k, d, seq) => rows.push({ group, key: k, diary: d, seq }),
      setLeft: (k, left) => rows.push({ key: k, left })
    },
    _persist: async () => {},
    _isBlocked: () => true
  })
  seeder._reconcileGroups(D, entry)
  t.is(seeder._groups.get(W).seq, 1, 'the binding takes its on join in G')
  t.alike(rows, [{ group: G, key: W, diary: D, seq: 1 }, { key: W, left: true }], 'and so does its row, left')
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
  t.is(kept(records).size, MAX_WRITER_RELEASES_PER_DIARY + MAX_GROUP_WRITERS_PER_DIARY, 'and keeps all 24')
  for (let i = 0; i < 16; i++) t.is(s.state.get(key(i)), 'released')
  for (let i = 16; i < 24; i++) t.ok(s.state.get(key(i)) === 'live' && s.cut.get(key(i)) === 0, 'a cut 0 past K keeps the slot at cut 0')
  t.absent(kept(records).has(key(24)), 'the 25th was never counted')
})

test('liveGroupJoins: a released writer never takes one of the 64 groups diaryGroupKeys picks (#350)', (t) => {
  // A group whose only writer is released with its join still on, then
  // MAX_GROUPS_PER_DIARY ordinary groups.
  const lone = key(9000)
  const records = [join(key(8000), true, lone), cut(key(8000), 0, lone)]
  for (let g = 0; g < MAX_GROUPS_PER_DIARY; g++) records.push(join(key(1000 + g), true, key(5000 + g)))
  const entries = records.map((r, n) => ({
    seq: n + 1,
    record: r.type === 'join' ? groupJoinRecord({ group: r.group, writer: r.writer, on: r.on }) : groupCutRecord({ group: r.group, writer: r.writer, cut: r.cut })
  }))
  const picked = diaryGroupKeys(entries)
  t.is(picked.length, MAX_GROUPS_PER_DIARY)
  t.absent(picked.includes(lone), 'control: the fold leaves the released-only group out')
  const out = kept(records)
  const groups = new Set([...out.values()].filter((j) => !j.left).map((j) => j.group))
  t.alike([...groups].sort(), [...picked].sort(), 'the seeder picks the same groups')
  t.alike(out.get(key(1000 + MAX_GROUPS_PER_DIARY - 1)), { group: key(5000 + MAX_GROUPS_PER_DIARY - 1), seq: records.length, left: false }, 'the last ordinary group is kept')
  t.alike(out.get(key(8000)), { group: lone, seq: 1, left: true }, 'the released writer is kept, left: it fetches no root and supports none')
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
  await until(async () => entry.cut === 3 && !entry.cutting && seeder._groups.get(W).clearedTo === 6 && (await blocksHeld(entry.core, 0, 6)).length === 3, { name: 'W cortado em 3' })
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1, 2], 'only the blocks below the cut are stored')
  t.is(entry.core.contiguousLength, 3)
  t.alike(readGroups(dataDir)[W], { diary: B.key, group: R, seq: 1, cut: 3, clearedFrom: 3, clearedTo: 6 }, 'the cut and the range read are persisted with the binding')
  t.ok(seeder._groupServed.has(W), 'the writer stays served')

  // B keeps writing past its cut: a post goes, a leave and a key block stay
  // (the fold counts them past a cut), and so does the next post's gap.
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'depois do corte' }))))
  await B.cores.w.append(b4a.from(JSON.stringify(groupLeave({ cuts: [{ writer: W, seq: 7 }] }))))
  await B.cores.w.append(b4a.from(JSON.stringify({ type: 'group-key' })))
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'mais um' }))))
  await until(async () => entry.core.length === 10 && !entry.cutting && seeder._groups.get(W).clearedTo === 10, { name: 'W lido depois do corte' })
  t.alike(await blocksHeld(entry.core, 0, 10), [0, 1, 2, 7, 8], 'below the cut, then the leave and the key block only')
  t.is(entry.keptPast.size, 2, 'the quota counts the two blocks kept past the cut')

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
  await until(() => seeder._groups.get(W[0]).clearedTo === 2 && !seeder._groupServed.get(W[0]).cutting, { name: 'W0 lido depois do corte' })
  t.is(seeder._groupServed.get(W[0]).core.contiguousLength, 1, 'W0 below its cut')
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

test('a writer that left before its admission is listed by its on join, and a binding stored with the off join heals at the next start (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // B's diary: its certificate (0) and the join of W (1); then B leaves
  // online, before any seeder saw W: a leave in W (block 6) and the join
  // turned off (2).
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  await B.cores.w.append(b4a.from(JSON.stringify(groupLeave({ seen: null, cuts: [{ writer: W, seq: 6 }] }))))
  await B.diary.append(groupJoinRecord({ group: R, writer: W, on: false }))
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, W)
  await settledFor(first.seeder, B)
  await downloaded(first.seeder, W, 7)
  const item = first.seeder._groupIndex.page(R).items.find((i) => i.key === W)
  t.is(item.left, true, 'listed left')
  t.is(item.seq, 1, 'by its on join, the block readers check')
  t.is(readGroups(dataDir)[W].seq, 1, 'and stored with it')
  await first.seeder.close()

  // A binding stored with the seq of the off join, as the build before
  // this one wrote it, takes the on join at the next scan.
  const file = path.join(dataDir, 'admitted.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.groups[W].seq = 2
  fs.writeFileSync(file, JSON.stringify(data))
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await settledFor(second.seeder, B)
  await until(() => readGroups(dataDir)[W].seq === 1, { name: 'vínculo corrigido', timeoutMs: 10000 }).catch(() => {})
  t.alike(second.seeder._groupIndex.writer(W), { group: R, diary: B.key, seq: 1, left: true }, 'listed left by its on join again')
  t.is(readGroups(dataDir)[W].seq, 1, 'and stored with it')
  t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === W), 'never purged')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a writer its diary released (cut 0) is kept as a stub that serves its leave to a fresh reader (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // W: header, five posts, a leave (block 6) and one more post.
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  await B.cores.w.append(b4a.from(JSON.stringify(groupLeave({ cuts: [{ writer: W, seq: 6 }] }))))
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'depois da saída' }))))
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, W)
  await downloaded(seeder, W, 8)

  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 0 }))
  const entry = seeder._groupServed.get(W)
  await until(async () => entry.cut === 0 && !entry.cutting && seeder._groups.get(W).clearedTo === 8 && (await blocksHeld(entry.core, 0, 8)).length === 2, { name: 'W reduzido a um toco' })
  t.alike(await blocksHeld(entry.core, 0, 8), [0, 6], 'block 0 and the leave only')
  t.is(readGroups(dataDir)[W].cut, 0, 'the stub is persisted at cut 0')
  t.ok(seeder._groupIndex.writer(W), 'and stays in the index')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === W), 'never purged')
  await settledFor(seeder, B)
  t.ok(seeder._groupServed.has(R), 'the root stays')

  // B goes; a reader that dials the seeder only gets the leave, verified.
  await B.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  const copy = r.store.get({ key: b4a.from(W, 'hex') })
  await copy.ready()
  await until(() => copy.length === 8, { name: 'comprimento assinado no leitor', timeoutMs: 30000 })
  t.ok(await copy.get(0, { timeout: 15000 }), 'block 0 verified from the seeder')
  t.is(JSON.parse(b4a.toString(await copy.get(6, { timeout: 15000 }))).type, 'group-leave', 'the leave of a released writer is served, verified')
  await t.exception(copy.get(1, { timeout: 3000 }), 'a post is not served')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a restart restores a writer at its persisted cut and the scan lowers it or makes it a stub (#350)', async (t) => {
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
  await until(() => first.seeder._groups.get(W).clearedTo === 6 && !first.seeder._groupServed.get(W).cutting, { name: 'W lido depois do corte' })
  t.alike(await blocksHeld(first.seeder._groupServed.get(W).core, 0, 6), [0, 1, 2, 3])
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
  await until(async () => entry.cut === 2 && !entry.cutting && (await blocksHeld(entry.core, 0, 6)).length === 2, { name: 'W cortado em 2' })
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1])
  t.is(readGroups(dataDir)[W].cut, 2, 'the lower cut is persisted')
  t.is(readGroups(dataDir)[W].clearedFrom, 2, 'and the range read reaches down to it')
  const stub = second.seeder._groupServed.get(W2)
  await until(async () => stub.cut === 0 && !stub.cutting && (await blocksHeld(stub.core, 0, 2)).length === 1, { name: 'W2 reduzido a um toco' })
  t.alike(await blocksHeld(stub.core, 0, 2), [0], 'W2 released: its block 0 stays')
  await until(() => readGroups(dataDir)[W2].cut === 0, { name: 'toco persistido' })
  t.absent(second.events.some((e) => e.event === 'group-rejected' && (e.key === W || e.key === W2)), 'never purged')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a cut its diary deleted still applies at the seeder, after a restart too (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // B's diary: certificate, the join of W, then the cut at 3 (block 2).
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc, (R, W) => [groupCutRecord({ group: R, writer: W, cut: 3 })])
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, W)
  await until(async () => first.seeder._groups.get(W).clearedTo === 6 && !first.seeder._groupServed.get(W).cutting, { name: 'W lido depois do corte' })
  t.alike(await blocksHeld(first.seeder._groupServed.get(W).core, 0, 6), [0, 1, 2], 'cleared past its cut')

  // B deletes the cut record: a group-cut ignores deletes (docs/protocol.md
  // "Deletion"), so the seeder keeps both the block and the cut.
  await B.diary.append(deleteRecord({ seq: 2 }))
  await settledFor(first.seeder, B)
  t.ok(await first.seeder._served.get(B.key).core.has(2), 'the deleted cut stays at the seeder')
  t.is(first.seeder._groups.get(W).cut, 3, 'and so does the cut')
  await first.seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const entry = second.seeder._groupServed.get(W)
  t.ok(entry, 'W served at ready')
  await settledFor(second.seeder, B)
  t.is(entry.cut, 3, 'the scan reads the deleted cut again')
  t.alike(readGroups(dataDir)[W], { diary: B.key, group: R, seq: 1, cut: 3, clearedFrom: 3, clearedTo: 6 }, 'the binding keeps it')
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1, 2], 'and nothing it cleared is fetched again')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a persisted cut the diary does not give is dropped once the scan caught up, and what clearing removed is fetched again (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // B's diary: certificate and the join of W, no cut.
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, W)
  await downloaded(first.seeder, W, 6)
  await first.seeder.close()

  // A cut stored with W's binding and cleared past it, as admitted.json
  // keeps one whose record the scan no longer gives (a store restored from
  // an older copy, say): a deleted cut still counts since #717, so a
  // delete cannot make one go.
  const file = path.join(dataDir, 'admitted.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(data.groups[W], { cut: 3, clearedFrom: 3, clearedTo: 6 })
  fs.writeFileSync(file, JSON.stringify(data))
  const store = await openStore(dataDir)
  const core = store.get({ key: b4a.from(W, 'hex') })
  await core.ready()
  await core.clear(3, 6)
  t.alike(await blocksHeld(core, 0, 6), [0, 1, 2], 'cleared past the stored cut')
  await core.close()
  await store.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const entry = second.seeder._groupServed.get(W)
  t.ok(entry, 'W served at ready')
  t.is(entry.cut, 3, 'from its persisted cut')
  await until(async () => entry.cut === null && (await blocksHeld(entry.core, 0, 6)).length === 6, { name: 'W buscado de novo' })
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1, 2, 3, 4, 5], 'every block fetched again')
  await until(() => !('cut' in readGroups(dataDir)[W]), { name: 'sem corte persistido' })
  t.alike(readGroups(dataDir)[W], { diary: B.key, group: R, seq: 1 }, 'the binding has no cut nor range')
  t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === W), 'never purged')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a cut writer counts what it keeps toward the log quota: posts past the cut are cleared, not counted (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBytes: 20000 })
  // Blocks past a cut are only read at the seeder, never validated: a raw
  // block near the block limit is enough to cross the byte quota.
  const big = () => b4a.from(JSON.stringify({ type: 'group-post', text: 'x'.repeat(12000) }))
  const bigKey = () => b4a.from(JSON.stringify({ type: 'group-key', pad: 'x'.repeat(12000) }))

  // W is cut at 2 and already holds 24 KB of posts past its cut when B is
  // admitted: they are cleared, so W is served.
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc, (R, W) => [groupCutRecord({ group: R, writer: W, cut: 2 })])
  await B.cores.w.append(big())
  await B.cores.w.append(big())
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, W)
  const entry = seeder._groupServed.get(W)
  await until(async () => !entry.cutting && seeder._groups.get(W).clearedTo === 8 && (await blocksHeld(entry.core, 0, 8)).length === 2, { name: 'W lido depois do corte' })
  t.alike(await blocksHeld(entry.core, 0, 8), [0, 1], 'the posts past the cut are cleared')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === W), 'and not counted')

  // Two key blocks past the cut stay, and they are past the quota.
  await B.cores.w.append(bigKey())
  await B.cores.w.append(bigKey())
  t.is((await rejected(events, W, 'quota')).reason, 'quota', 'dropped once what it keeps passes the quota')
  await until(() => !seeder._groupServed.has(W), { name: 'W fora' })

  // W2, cut at 4 while small, is served; it then grows past the quota
  // below its cut.
  const W2 = await addWriter(B, R, 'w2')
  await B.diary.append(groupJoinRecord({ group: R, writer: W2, on: true }))
  await B.diary.append(groupCutRecord({ group: R, writer: W2, cut: 4 }))
  await admitted(events, W2)
  await downloaded(seeder, W2, 2)
  await until(() => seeder._groupServed.get(W2).cut === 4, { name: 'W2 em 4' })
  await B.cores.w2.append(big())
  await B.cores.w2.append(big())
  t.is((await rejected(events, W2, 'quota')).reason, 'quota', 'the bytes below the cut count')
  await until(() => !seeder._groupServed.has(W2), { name: 'W2 fora' })
  await settledFor(seeder, B)
  t.is(events.filter((e) => e.event === 'group-admitted' && e.key === W).length, 1, 'a writer dropped for what it keeps is not fetched again')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a lower cut seen while a writer core is still opening is the cut it is served at (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const hold = gate()
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: (key, step) => step === 'open' ? hold.hook(key) : undefined
  })
  t.teardown(() => hold.open())

  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc, (R, W) => [groupCutRecord({ group: R, writer: W, cut: 4 })])
  hold.key = W
  await admit(A, assoc)
  await admit(B, assoc)
  await until(() => hold.entered, { name: 'W abrindo' })
  t.is(seeder._groups.get(W).cut, 4, 'admitted at its cut')
  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 2 }))
  await until(() => seeder._groups.get(W).cut === 2, { name: 'corte menor na ligação', timeoutMs: 30000 })
  t.absent(seeder._groupServed.has(W), 'while the core is still opening')
  await until(() => readGroups(dataDir)[W].cut === 2, { name: 'corte menor persistido' })
  hold.open()
  await admitted(events, W)
  const entry = seeder._groupServed.get(W)
  t.is(entry.cut, 2, 'served at the lower cut')
  await until(async () => !entry.cutting && seeder._groups.get(W).clearedTo === 6 && (await blocksHeld(entry.core, 0, 6)).length === 2, { name: 'W abaixo de 2' })
  t.alike(await blocksHeld(entry.core, 0, 6), [0, 1])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a boxless writer of a private group its diary released is kept as a stub; before the release it is refused (#350)', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  let P = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    P = await make('root', groupHeader({ diary: key, visibility: 'private', join: 'approval', name: null, box: 'e'.repeat(64) }))
    return [groupJoinRecord({ group: P, writer: P, on: true })]
  })
  // N: a writer of B in the private group without a box (one its diary
  // replaced), header and a post.
  let N = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    N = await make('n', writerHeader({ group: P, diary: key }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: P, writer: N, on: true })]
  })
  await admit(A, assoc)
  await admitted(first.events, P)
  await until(() => first.seeder._groupVisibility(P) === 'private', { name: 'raiz privada conhecida' })
  await admit(B, assoc)
  await rejected(first.events, N, 'header-invalid')
  t.absent(first.seeder._groupServed.has(N), 'refused while counted')

  await B.diary.append(groupCutRecord({ group: P, writer: N, cut: 0 }))
  await admitted(first.events, N)
  const entry = first.seeder._groupServed.get(N)
  await until(async () => !entry.cutting && first.seeder._groups.get(N).clearedTo === 2 && (await blocksHeld(entry.core, 0, 2)).length === 1, { name: 'N reduzido a um toco' })
  t.alike(await blocksHeld(entry.core, 0, 2), [0], 'released: its block 0 is kept')
  t.is(readGroups(dataDir)[N].cut, 0)

  // A reader fetches the stub's header from the seeder alone.
  await B.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  const copy = r.store.get({ key: b4a.from(N, 'hex') })
  await copy.ready()
  const header = JSON.parse(b4a.toString(await copy.get(0, { timeout: 20000 })))
  t.is(header.type, 'group-writer')
  t.is(header.box, null, 'the boxless header readers reject')
  await first.seeder.close()

  // A restart keeps the stub: its header is judged as a released writer's.
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.seeder._groupServed.get(N), 'N served at ready')
  t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === N), 'not purged')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a seeder fed only by a seeder that keeps a writer sparse reads past cut + 256, then reads it again once a fuller peer joins (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const first = prepareSeederDir(t, assoc)
  const one = await startSeeder(t, bootstrap, first.dataDir, { associationKey: assoc.hex })

  // W: header, five posts, 300 more, a leave and one more post; cut at 3,
  // so the leave sits past the first chunk read after the cut.
  const { A, B, R, W } = await cutWorld(t, bootstrap, assoc)
  const posts = []
  for (let i = 0; i < 300; i++) posts.push(b4a.from(JSON.stringify(groupPost({ text: 'mais ' + i }))))
  await B.cores.w.append(posts)
  const leaveAt = B.cores.w.length
  await B.cores.w.append(b4a.from(JSON.stringify(groupLeave({ cuts: [{ writer: W, seq: leaveAt }] }))))
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'depois da saída' }))))
  const length = B.cores.w.length
  t.ok(leaveAt >= 3 + 256, 'the leave is past the first chunk')
  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 3 }))
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(one.events, W)
  const e1 = one.seeder._groupServed.get(W)
  await until(async () => e1.cut === 3 && !e1.cutting && one.seeder._groups.get(W).clearedTo === length && (await blocksHeld(e1.core, 0, length)).length === 4, { name: 'W esparso no primeiro semeador' })
  t.alike(await blocksHeld(e1.core, 0, length), [0, 1, 2, leaveAt], 'the first seeder keeps W below its cut and its leave')
  t.absent('unsureFrom' in readGroups(first.dataDir)[W], 'read whole from its owner')

  // B goes: a second seeder reads W from the first only, which holds
  // nothing of the first chunk past the cut. A carries B's diary to it (the
  // gate fetches a diary from its announcer), never W.
  const carried = A.store.get({ key: B.diary.key })
  await carried.ready()
  await carried.download({ start: 0, end: B.diary.length }).done()
  await B.swarm.destroy()
  const second = prepareSeederDir(t, assoc)
  const two = await startSeeder(t, bootstrap, second.dataDir, { associationKey: assoc.hex })
  const twoKey = hex(two.seeder.swarm.keyPair.publicKey)
  const peer = await until(() => A.peers.find((p) => p.remoteRole === 'seeder' && p.peerKey === twoKey), { name: 'segundo semeador' })
  peer.send({ type: 'announce', key: A.key, cert: A.certOf(A.key) })
  peer.send({ type: 'announce', key: B.key, cert: B.certOf(B.key) })
  await admitted(two.events, W)
  const e2 = two.seeder._groupServed.get(W)
  await until(async () => !e2.cutting && two.seeder._groups.get(W).clearedTo === length && await e2.core.has(leaveAt), { name: 'W lido do primeiro semeador', timeoutMs: 60000 })
  t.alike(await blocksHeld(e2.core, 0, length), [0, 1, 2, leaveAt], 'the second seeder keeps the leave too')
  t.is(e2.keptPast.size, 1, 'and counts it toward the quota')
  const listed = readGroups(second.dataDir)[W]
  t.alike([listed.unsureFrom, listed.unsureTo], [3, length], 'the range read from sparse peers only is listed as such')

  // A peer that joins with nothing there the second seeder lacks (A opens
  // W, empty) reads nothing again and leaves the backoff. The backoff is
  // pushed out first, so that only a peer could start a pass.
  const far = 5 * 60 * 1000
  e2.rereadDelay = far
  two.seeder._armReread(W, e2, far)
  await until(() => !e2.cutting && !e2.reread, { name: 'nenhuma releitura em curso' })
  let passes = 0
  const pastRange = two.seeder._groupPastRange
  two.seeder._groupPastRange = function (...args) {
    passes++
    return pastRange.apply(this, args)
  }
  let joined = false
  e2.core.once('peer-add', () => { joined = true })
  const empty = A.store.get({ key: b4a.from(W, 'hex') })
  await empty.ready()
  t.teardown(() => empty.close(), { force: true })
  await until(() => joined, { name: 'A ligado a W' })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.is(passes, 0, 'a peer offering nothing there starts no pass')
  t.is(e2.rereadDelay, far, 'and leaves the backoff')
  delete two.seeder._groupPastRange

  // B comes back with W whole, which it advertises: the range is read again
  // at once, each chunk whole, and what is not kept is cleared again.
  const back = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => back.destroy(), { force: true })
  back.on('connection', (socket) => {
    socket.on('error', () => {})
    B.store.replicate(socket)
    attachAdmission(socket, { role: 'member', have: [] })
  })
  back.joinPeer(b4a.from(twoKey, 'hex'))
  await until(() => !('unsureFrom' in two.seeder._groups.get(W)) && !e2.cutting, { name: 'W relido inteiro', timeoutMs: 60000 })
  t.alike(await blocksHeld(e2.core, 0, length), [0, 1, 2, leaveAt], 'what it read again past the cut is cleared again')
  t.absent('unsureFrom' in readGroups(second.dataDir)[W], 'and the range is listed as read whole')
  t.is(one.events.filter((e) => e.event === 'fatal').length + two.events.filter((e) => e.event === 'fatal').length, 0)
})

// A drop or a close destroys the range of a chunk past the cut, whose done()
// then never settles, and wakes only a wait already armed: one landing while
// the loop checks what its peers advertise must still end it.
test('a drop during the check of a chunk past the cut ends its wait (#350)', async (t) => {
  const listeners = new Set()
  const entry = { past: null, wake: null, dropped: false }
  const peer = { remoteSynced: true, remoteContiguousLength: 300, remoteLength: 300, remoteBitfield: { getBitfield: () => null, get: () => false } }
  const core = {
    peers: [peer],
    contiguousLength: 3,
    download: () => ({ done: () => new Promise(() => {}), destroy () {} }),
    // The drop lands while advertisedHeld reads what is held, and the close
    // takes the peers with it.
    async has () {
      entry.dropped = true
      core.peers = []
      return false
    },
    on (name, fn) { listeners.add(fn) },
    off (name, fn) { listeners.delete(fn) }
  }
  entry.core = core
  const read = Seeder.prototype._groupPastRange.call({ _closing: false }, entry, 3, 259)
  const ended = await Promise.race([read.then((value) => ({ value })), new Promise((resolve) => setTimeout(() => resolve(null), 2000))])
  t.alike(ended, { value: null }, 'the wait ends with nothing read')
  t.is(listeners.size, 0, 'and listens on the core no more')
})
