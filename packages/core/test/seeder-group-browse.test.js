// Public group discovery at the seeder: indexGroupBrowse lists the public
// groups attached to a served community by member count or creation date,
// and indexPublicGroups the open public groups one diary takes part in (its
// community's Geral left out). Private groups, blocked keys and groups of a
// community this seeder does not serve never appear.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord, groupsShowRecord, deleteRecord } = require('../lib/records')
const { Seeder } = require('../lib/seeder')
const { groupPost, groupCreateRecord, groupMeta } = require('../lib/group')
const {
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  moderator,
  scansDone,
  creatorAndMember,
  groupHeader,
  writerHeader
} = require('./helpers/seeder-groups')

const BOX = 'e'.repeat(64)

function iso (ms) {
  return new Date(ms).toISOString()
}

// Creator A: community root C ('Praia') whose root creates, in this order,
// G ('Cadeiras', its Geral: the first create folded), H ('Toalhas', open),
// P ('Guarda-sol', approval) and the private group X. A joins every root.
// H is the newest, P the oldest.
async function creator (t, bootstrap, assoc) {
  const now = Date.now()
  const k = { at: { G: iso(now - 2000), H: iso(now - 1000), P: iso(now - 3000) } }
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const under = (opts) => groupHeader({ diary: key, community: k.C, member: k.C, ...opts })
    k.C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Praia' }))
    k.G = await make('geral', under({ name: 'Cadeiras', at: k.at.G }), [groupPost({ text: 'oi' })])
    k.H = await make('toalhas', under({ name: 'Toalhas', at: k.at.H }))
    k.P = await make('guarda-sol', under({ name: 'Guarda-sol', join: 'approval', at: k.at.P }))
    k.X = await make('privado', under({ visibility: 'private', join: 'approval', name: null, box: BOX }))
    return [k.C, k.G, k.H, k.P, k.X].map((g) => groupJoinRecord({ group: g, writer: g, on: true }))
  })
  for (const g of [k.G, k.H, k.P, k.X]) await A.cores.community.append(encode(groupCreateRecord({ group: g })))
  return { A, ...k }
}

// A, member D (writers in G, H and P), member E (a writer in H) and the
// helper's creator and member of R, a group whose parent community this
// seeder never serves. Resolves once every core is admitted and the
// discovery answers are complete.
async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, C, G, H, P, X, at } = await creator(t, bootstrap, assoc)
  const w = {}
  const D = await member(t, bootstrap, assoc, async ({ key, make }) => {
    w.DG = await make('dg', writerHeader({ group: G, diary: key }))
    w.DH = await make('dh', writerHeader({ group: H, diary: key }))
    w.DP = await make('dp', writerHeader({ group: P, diary: key }))
    return [groupJoinRecord({ group: G, writer: w.DG, on: true }), groupJoinRecord({ group: H, writer: w.DH, on: true }), groupJoinRecord({ group: P, writer: w.DP, on: true })]
  })
  const E = await member(t, bootstrap, assoc, async ({ key, make }) => {
    w.EH = await make('eh', writerHeader({ group: H, diary: key }))
    return [groupJoinRecord({ group: H, writer: w.EH, on: true })]
  })
  const other = await creatorAndMember(t, bootstrap, assoc)

  for (const m of [A, D, E, other.A, other.B]) await admit(m, assoc)
  for (const k of [C, G, H, P, X, w.DG, w.DH, w.DP, w.EH, other.R, other.W]) await admitted(events, k)
  await until(() => {
    if (!scansDone(seeder)) return false
    const m = seeder.indexGroupBrowse('members')
    const r = seeder.indexGroupBrowse('recent')
    const d = seeder.indexPublicGroups(D.key)
    return m !== null && m.complete && r !== null && r.complete && d !== null && d.complete
  }, { name: 'descoberta completa', timeoutMs: 60000 })
  return { bootstrap, assoc, publicKey, seeder, events, A, D, E, C, G, H, P, X, at, w, other }
}

function keys (answer) {
  return answer.groups.map((r) => r.group)
}

test('a pending owner scan answers with the last groups-show choice it has read', async (t) => {
  const diary = 'd'.repeat(64)
  const row = { group: 'a'.repeat(64) }
  const seeder = new Seeder({ dataDir: '/nonexistent' })
  const blocks = [null, encode(groupsShowRecord({ on: false })), encode(groupsShowRecord({ on: true }))]
  const core = { length: 2, contiguousLength: 2, get: (seq) => blocks[seq] }
  const entry = { core, present: 2, scanned: 2, indexed: 1, gated: true, groupLive: new Map() }
  seeder._served.set(diary, entry)
  seeder._admitted.set(diary, true)
  seeder._passesStarted = true
  seeder._indexStartup = new Set()
  seeder._groupIndex.publicGroupsOf = () => ({ groups: [row], next: null })

  const shown = { groups: [row], next: null, hidden: false, indexing: false, complete: true }
  const hidden = { groups: [], next: null, hidden: true, indexing: false, complete: true }
  t.alike(seeder.indexPublicGroups(diary), { ...shown, complete: false }, 'the unread off record leaves the group listed')
  await seeder._runIndex(diary, entry)
  t.alike(seeder.indexPublicGroups(diary), hidden)

  core.length = core.contiguousLength = entry.present = entry.scanned = 3
  t.alike(seeder.indexPublicGroups(diary), { ...hidden, complete: false }, 'the unread on record leaves the box hidden')
  await seeder._runIndex(diary, entry)
  t.alike(seeder.indexPublicGroups(diary), shown)
})

test('members and recent list the public groups of a served community; a private group and an unserved community\'s group never appear', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, C, G, H, P, X, at, other } = await setup(t)

  const members = seeder.indexGroupBrowse('members')
  t.is(members.indexing, false)
  t.is(members.complete, true)
  t.is(members.more, false)
  t.alike(keys(members), [H, ...[G, P].sort()], 'most members first, then by key')
  t.alike(members.groups[0], { group: H, name: 'Toalhas', creator: A.key, community: C, communityName: 'Praia', members: 3, created: Date.parse(at.H), active: null })
  t.alike(members.groups.map((r) => r.members), [3, 2, 2])

  const recent = seeder.indexGroupBrowse('recent')
  t.is(recent.indexing, false)
  t.is(recent.complete, true)
  t.alike(keys(recent), [H, G], 'newest first, at most two of one creator: Geral and the second group')
  t.is(recent.groups[1].created, Date.parse(at.G))

  for (const answer of [members, recent]) {
    t.absent(keys(answer).includes(X), 'a private group never appears')
    t.absent(keys(answer).includes(other.R), 'nor a group whose community is not served here')
  }
  t.is(seeder.indexGroupBrowse('nope'), null, 'an unknown order')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('the public groups of a diary: open ones only, its community\'s Geral left out, a group it left omitted, shown by default', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, D, E, C, H, X, w } = await setup(t)

  const row = { group: H, name: 'Toalhas', creator: A.key, community: C, communityName: 'Praia', members: 3 }
  t.alike(seeder.indexPublicGroups(D.key), { groups: [row], next: null, hidden: false, indexing: false, complete: true }, 'H only: G is Geral, P asks for approval')
  t.alike(seeder.indexPublicGroups(A.key).groups, [row], 'the creator: the private group X is not listed either')
  t.absent(keys(seeder.indexPublicGroups(A.key)).includes(X))
  t.alike(seeder.indexPublicGroups(E.key).groups, [row])
  t.alike(seeder.indexPublicGroups(D.key, H).groups, [], 'nothing after the last key')
  t.is(seeder.indexPublicGroups('f'.repeat(64)), null, 'a diary not served here')
  t.is(seeder.indexPublicGroups('zz'), null)
  t.is(seeder.indexPublicGroups(D.key, 'zz'), null, 'a malformed cursor')

  await D.diary.append(groupJoinRecord({ group: H, writer: w.DH, on: false }))
  await until(() => {
    const d = seeder.indexPublicGroups(D.key)
    return d !== null && d.complete && d.groups.length === 0
  }, { name: 'D saiu de H' })
  const after = seeder.indexPublicGroups(D.key)
  t.is(after.hidden, false)
  t.is(after.next, null)
  t.is(seeder.indexPublicGroups(E.key).groups[0].members, 2, 'D no longer counts in H')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('groups-show hides only the member\'s profile list and a tombstone restores the previous choice', async (t) => {
  t.timeout(150000)
  const { seeder, D, E, H, w } = await setup(t)
  const shown = seeder.indexPublicGroups(D.key)
  t.alike(keys(shown), [H])
  await D.cores.dh.append(encode(groupPost({ text: 'oi' })))
  await E.cores.eh.append(encode(groupPost({ text: 'olá' })))
  await until(() => seeder.indexGroupBrowse('trending').groups.some((row) => row.group === H && row.active === 2), { name: 'H em alta' })

  async function appendChoice (record) {
    await D.diary.append(record)
    const entry = seeder._served.get(D.key)
    await until(() => entry.indexed >= D.diary.length && entry.scanned >= D.diary.length && seeder.indexPublicGroups(D.key).complete, { name: 'escolha de D lida' })
    return seeder.indexPublicGroups(D.key)
  }

  const hidden = { groups: [], next: null, hidden: true, indexing: false, complete: true }
  t.alike(await appendChoice(groupsShowRecord({ on: false })), hidden)
  t.alike(seeder.indexPublicGroups(D.key, H), hidden, 'every page omits the group key and cursor')
  t.is(seeder.indexPublicGroups(D.key, 'zz'), null, 'a malformed cursor is still refused')
  t.alike(keys(seeder.indexPublicGroups(E.key)), [H], 'the other profile still lists H')
  t.is(seeder.indexGroupBrowse('members').groups.find((row) => row.group === H).members, 3)
  t.is(seeder.indexGroupBrowse('trending').groups.find((row) => row.group === H).active, 2)
  t.ok(seeder.indexGroup(H).writers.some((row) => row.key === w.DH && row.diary === D.key), 'report confirmation still sees the writer')

  t.alike(await appendChoice(groupsShowRecord({ on: true })), shown)
  const offSeq = D.diary.length
  t.alike(await appendChoice(groupsShowRecord({ on: false })), hidden)
  t.alike(await appendChoice(deleteRecord({ seq: offSeq })), shown)
})

test('a blocked member is not counted; a blocked group and a blocked community never appear; a blocked diary answers null', async (t) => {
  t.timeout(180000)
  const { bootstrap, assoc, publicKey, seeder, events, D, E, C, G, H, P } = await setup(t)
  const mod = moderator(assoc)
  const block = (seq, blocked) => reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert) })
  const settled = (name, fn) => until(() => {
    const m = seeder.indexGroupBrowse('members')
    const r = seeder.indexGroupBrowse('recent')
    return m !== null && m.complete && r !== null && r.complete && fn(m, r)
  }, { name, timeoutMs: 60000 })

  await block(1, [E.key])
  // H, G and P then count 2 each: the order falls back to the keys.
  await settled('E fora da contagem', (m) => m.groups.some((r) => r.group === H && r.members === 2))
  t.alike(seeder.indexGroupBrowse('members').groups.map((r) => r.members), [2, 2, 2])
  t.is(seeder.indexPublicGroups(E.key), null, 'a blocked diary answers null')
  t.is(seeder.indexPublicGroups(D.key).groups[0].members, 2, 'the blocked member is not counted')

  await block(2, [E.key, H])
  await rejected(events, H, 'group-blocked')
  await settled('H fora', (m, r) => !keys(m).includes(H) && !keys(r).includes(H))
  t.alike(keys(seeder.indexGroupBrowse('members')), [G, P].sort(), 'a blocked group never appears')
  t.alike(keys(seeder.indexGroupBrowse('recent')), [G, P])
  t.alike(seeder.indexPublicGroups(D.key).groups, [], 'nor in a diary\'s public groups')

  await block(3, [E.key, H, C])
  await rejected(events, C, 'group-blocked')
  await settled('comunidade fora', (m, r) => m.groups.length === 0 && r.groups.length === 0)
  t.alike(seeder.indexGroupBrowse('members').groups, [], 'no group of a blocked community appears')
  t.alike(seeder.indexGroupBrowse('recent').groups, [])
  t.alike(seeder.indexPublicGroups(D.key).groups, [])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('the groups of a blocked creator never appear', async (t) => {
  t.timeout(180000)
  const { bootstrap, assoc, publicKey, seeder, events, A, D, H } = await setup(t)
  t.ok(keys(seeder.indexGroupBrowse('members')).includes(H))
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.kp, mod.cert) })
  await until(() => {
    const m = seeder.indexGroupBrowse('members')
    const r = seeder.indexGroupBrowse('recent')
    return m !== null && m.complete && m.groups.length === 0 && r !== null && r.complete && r.groups.length === 0
  }, { name: 'grupos do criador fora', timeoutMs: 60000 })
  t.is(seeder.indexPublicGroups(A.key), null, 'the blocked creator answers null')
  t.alike(seeder.indexPublicGroups(D.key).groups, [], 'and its groups leave a member\'s list')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// Holds every read of block `index` of served core `key` until release().
function holdRead (seeder, key, index) {
  const core = seeder._groupServed.get(key).core
  const get = core.get
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const state = { entered: false, release: () => release() }
  core.get = function (i, opts) {
    if (i !== index) return get.call(this, i, opts)
    state.entered = true
    return gate.then(() => get.call(this, i, opts))
  }
  return state
}

test('a group whose root scan is behind is not in a diary\'s public groups: a group-meta may have closed its join', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, D, E, H } = await setup(t)
  t.alike(keys(seeder.indexPublicGroups(D.key)), [H])

  const hold = holdRead(seeder, H, 1)
  await A.cores.toalhas.append(encode(groupMeta({ name: 'Toalhas', join: 'approval' })))
  await until(() => hold.entered, { name: 'leitura do meta de H' })
  t.ok(seeder._rootScanBehind(H), 'the scan of H is held')
  for (const diary of [D, E, A]) {
    const answer = seeder.indexPublicGroups(diary.key)
    t.alike(answer.groups, [], 'H is left out while its join may have closed')
    t.is(answer.complete, false, 'and the answer is not complete')
  }
  t.ok(keys(seeder.indexGroupBrowse('members')).includes(H), 'the browse orders still list H')

  hold.release()
  await until(() => {
    const d = seeder.indexPublicGroups(D.key)
    return d !== null && d.complete && !seeder._rootScanBehind(H)
  }, { name: 'meta de H lido' })
  t.alike(seeder.indexPublicGroups(D.key).groups, [], 'once folded, H asks for approval: not listed')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// A root downloads out of order, so its signed length can run ahead of its
// contiguous prefix, which is all a root scan reads: a group-meta past the
// hole is not folded and the scan is not behind (_rootScanBehind). The hole
// is made at the seeder, deterministically: the read of block 1 is held so
// the scan stops there, block 1 is cleared from the seeder's copy once both
// new blocks are local (contiguousLength falls back to 1, length stays 3),
// then the held read gets nothing. The live download range does not fetch
// a block cleared locally again by itself, so the test asks for block 1, as
// a peer that holds it would deliver it, and the scan folds the rename past
// it.
test('a group whose root has a hole below a later block is not in a diary\'s public groups until the seeder reads its root in order', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, D, E, C, H, X } = await setup(t)
  t.alike(keys(seeder.indexPublicGroups(D.key)), [H])
  const a = seeder.indexPublicGroups(A.key)
  t.alike(keys(a), [H], 'the creator: in the private group X and in the open group H')
  t.is(a.complete, true, 'a private root, never scanned, does not hold the answer incomplete')
  t.is(seeder._rootGap(X), false, 'a private root is never a gap')

  const entry = seeder._groupServed.get(H)
  const hold = holdRead(seeder, H, 1)
  await A.cores.toalhas.append(encode(groupPost({ text: 'oi' })))
  await A.cores.toalhas.append(encode(groupMeta({ name: 'Toalhas de praia', join: 'open' })))
  await until(() => hold.entered && entry.core.contiguousLength === 3, { name: 'blocos novos de H baixados' })
  await entry.core.clear(1)
  t.is(entry.core.contiguousLength, 1, 'a hole at block 1')
  t.is(entry.core.length, 3, 'below a block the seeder holds')
  hold.release()
  await until(() => !entry.rootScanning, { name: 'leitura de H parada no buraco' })
  t.absent(seeder._rootScanBehind(H), 'the scan is not behind its contiguous prefix')
  t.ok(seeder._rootGap(H), 'but its root is not read up to its length')
  for (const diary of [D, E, A]) {
    const answer = seeder.indexPublicGroups(diary.key)
    t.alike(answer.groups, [], 'H is left out while a group-meta past the hole is unread')
    t.is(answer.complete, false, 'and the answer is not complete')
  }
  t.ok(keys(seeder.indexGroupBrowse('members')).includes(H), 'the browse orders still list H')

  await entry.core.download({ start: 1, end: 2 }).done()
  await until(() => {
    const d = seeder.indexPublicGroups(D.key)
    return d !== null && d.complete && d.groups.length === 1
  }, { name: 'buraco de H preenchido', timeoutMs: 60000 })
  t.absent(seeder._rootGap(H))
  t.alike(seeder.indexPublicGroups(D.key).groups, [{ group: H, name: 'Toalhas de praia', creator: A.key, community: C, communityName: 'Praia', members: 3 }], 'listed again, with the rename read past the hole')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// Makes the hole of the test above in served root `key` of A's core `name`:
// two new blocks past `index`, the read of `index` held, `index` cleared once
// both are local, the held read released.
async function rootHole (seeder, A, key, name, index, meta) {
  const entry = seeder._groupServed.get(key)
  const hold = holdRead(seeder, key, index)
  await A.cores[name].append(encode(groupPost({ text: 'oi' })))
  await A.cores[name].append(encode(meta))
  await until(() => hold.entered && entry.core.contiguousLength === index + 2, { name: 'blocos novos de ' + name + ' baixados' })
  await entry.core.clear(index)
  hold.release()
  await until(() => !entry.rootScanning, { name: 'leitura de ' + name + ' parada no buraco' })
  return entry
}

test('a hole in the root of a group the list would never show (Geral, approval) leaves a diary\'s public groups complete', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, D, G, H, P } = await setup(t)
  t.is(seeder._groupIndex.generalOf(seeder._groupIndex.header(G).community), G, 'G is the Geral')
  const p = await rootHole(seeder, A, P, 'guarda-sol', 1, groupMeta({ name: 'Guarda-sol', join: 'approval' }))
  const g = await rootHole(seeder, A, G, 'geral', 2, groupMeta({ name: 'Cadeiras', join: 'open' }))
  t.is(p.core.contiguousLength, 1, 'a hole at block 1 of P')
  t.is(g.core.contiguousLength, 2, 'a hole at block 2 of G')
  for (const k of [G, P]) {
    t.ok(seeder._rootGap(k), 'the root is not read up to its length')
    t.absent(seeder._rootScanBehind(k), 'nor is its scan behind')
  }
  for (const diary of [D, A]) {
    const answer = seeder.indexPublicGroups(diary.key)
    t.alike(keys(answer), [H], 'H only, as before')
    t.is(answer.complete, true, 'neither hole holds the answer incomplete')
  }
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// Only the community root's scan is behind (the group roots caught up): the
// community's name and its group-create records may still change, so both
// discovery lists answer incomplete until the scan reads the new block.
test('a community root scan behind keeps both discovery lists incomplete until it catches up', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, D, C, G, H, P } = await setup(t)
  const entry = seeder._groupServed.get(C)
  const index = entry.core.length
  const hold = holdRead(seeder, C, index)
  await A.cores.community.append(encode(groupMeta({ name: 'Praia Grande', join: 'open' })))
  await until(() => hold.entered, { name: 'leitura do meta de C' })
  t.ok(seeder._rootScanBehind(C), 'the scan of C is held')
  for (const k of [G, H, P]) t.absent(seeder._rootScanBehind(k), 'the group roots caught up')
  t.is(seeder.indexGroupBrowse('members').complete, false)
  t.is(seeder.indexGroupBrowse('recent').complete, false)
  t.is(seeder.indexPublicGroups(D.key).complete, false)

  hold.release()
  await until(() => {
    const m = seeder.indexGroupBrowse('members')
    const r = seeder.indexGroupBrowse('recent')
    const d = seeder.indexPublicGroups(D.key)
    return m.complete && r.complete && d.complete && !seeder._rootScanBehind(C)
  }, { name: 'meta de C lido', timeoutMs: 60000 })
  t.is(seeder.indexPublicGroups(D.key).groups[0].communityName, 'Praia Grande', 'the rename is read')
  t.is(seeder.indexGroupBrowse('members').groups[0].communityName, 'Praia Grande')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
