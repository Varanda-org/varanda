'use strict'

// The writers a diary cut (#350, docs/protocol.md section 10) at a seeder:
// the slot walk picks the writers that count (liveGroupJoins), and a frozen
// or released writer is held whole, as a reader folds from a contiguous
// copy (a reduced copy comes with the client nodes' sparse read).

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { liveGroupJoins, groupWalkStep } = require('../lib/seeder')
const {
  groupJoinRecord,
  groupCutRecord,
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

test('a cut writer is held whole: its blocks past the cut stay, and a fresh reader reads its leave in order (#350)', async (t) => {
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

  // B cuts W at 3, then keeps writing to it: a post, a leave, another post.
  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 3 }))
  await settledFor(seeder, B)
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'depois do corte' }))))
  await B.cores.w.append(b4a.from(JSON.stringify(groupLeave({ cuts: [{ writer: W, seq: 7 }] }))))
  await B.cores.w.append(b4a.from(JSON.stringify(groupPost({ text: 'mais um' }))))
  await downloaded(seeder, W, 9)
  const entry = seeder._groupServed.get(W)
  t.alike(await blocksHeld(entry.core, 0, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'every block stays, past the cut too')
  t.absent('cut' in readGroups(dataDir)[W], 'no cut is kept with the binding')

  // B goes; a reader that dials the seeder only reads W from block 0 up,
  // as the nodes do (store.js readBlocks stops at the first hole).
  await B.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  const copy = r.store.get({ key: b4a.from(W, 'hex') })
  await copy.ready()
  await until(() => copy.length === 9, { name: 'comprimento assinado no leitor', timeoutMs: 30000 })
  const types = []
  for (let i = 0; i < 9; i++) types.push(JSON.parse(b4a.toString(await copy.get(i, { timeout: 15000 }))).type)
  t.is(types[7], 'group-leave', 'the leave past the cut is reached by a contiguous read')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a 9th writer after a freeze is admitted, a counted writer whose join is off is admitted as left, the 10th never (#350)', async (t) => {
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
  await downloaded(seeder, W[0], 2)
  t.pass('the frozen writer is held whole')
  await downloaded(seeder, W[8], 2)

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

test('a writer its diary released (cut 0) stays held whole, and a fresh reader reads its leave in order (#350)', async (t) => {
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
  await settledFor(seeder, B)
  const entry = seeder._groupServed.get(W)
  t.ok(entry, 'still served')
  t.alike(await blocksHeld(entry.core, 0, 8), [0, 1, 2, 3, 4, 5, 6, 7], 'every block stays')
  t.absent('cut' in readGroups(dataDir)[W], 'no cut is kept with the binding')
  t.ok(seeder._groupIndex.writer(W), 'it stays in the index')
  t.absent(events.some((e) => e.event === 'group-rejected' && e.key === W), 'never purged')
  t.ok(seeder._groupServed.has(R), 'the root stays')

  // B goes; a reader that dials the seeder only reads W from block 0 up.
  await B.swarm.destroy()
  const r = await reader(t, bootstrap, publicKey)
  const copy = r.store.get({ key: b4a.from(W, 'hex') })
  await copy.ready()
  await until(() => copy.length === 8, { name: 'comprimento assinado no leitor', timeoutMs: 30000 })
  const types = []
  for (let i = 0; i < 8; i++) types.push(JSON.parse(b4a.toString(await copy.get(i, { timeout: 15000 }))).type)
  t.is(types[6], 'group-leave', 'the leave of a released writer is reached by a contiguous read')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a restart keeps a cut writer and a released one whole (#350)', async (t) => {
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
  await downloaded(first.seeder, W, 6)
  await downloaded(first.seeder, W2, 2)
  await first.seeder.close()

  // While the seeder is down B lowers W's cut and releases W2.
  await B.diary.append(groupCutRecord({ group: R, writer: W, cut: 2 }))
  await B.diary.append(groupCutRecord({ group: R, writer: W2, cut: 0 }))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.seeder._groupServed.get(W), 'W served at ready')
  await settledFor(second.seeder, B)
  t.alike(await blocksHeld(second.seeder._groupServed.get(W).core, 0, 6), [0, 1, 2, 3, 4, 5], 'W whole')
  t.alike(await blocksHeld(second.seeder._groupServed.get(W2).core, 0, 2), [0, 1], 'W2 released, whole')
  t.absent(second.events.some((e) => e.event === 'group-rejected' && (e.key === W || e.key === W2)), 'never purged')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a cut writer is held to its whole log\'s quota: refused past it at admission, dropped once it grows past it (#350)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBytes: 20000 })
  // A raw block near the block limit is enough to cross the byte quota.
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
