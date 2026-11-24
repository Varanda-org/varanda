'use strict'

// "Em alta" at the seeder: indexGroupBrowse('trending') lists the open
// public groups attached to a served community where at least two distinct
// diaries posted in the last 7 days, read from a bounded scan of the tail
// of each public group writer core (_scanActivity, lib/group-activity.js).

const test = require('brittle')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { createSnapshot } = require('../lib/blocklist')
const { decodeBlock, groupJoinRecord, groupCutRecord } = require('../lib/records')
const { groupPost, groupCreateRecord, groupMeta } = require('../lib/group')
const {
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  onPassesStart,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  moderator,
  scansDone,
  groupHeader,
  writerHeader,
  downloaded,
  hex
} = require('./helpers/seeder-groups')

const BOX = 'e'.repeat(64)
const DAY = 86400000

function iso (ms) {
  return new Date(ms).toISOString()
}

// Creator A (adapted from seeder-communities.test.js): community root C
// ('Praia') whose root creates G ('Cadeiras', its Geral), H ('Toalhas'),
// M ('Mesas'), all open, P ('Guarda-sol', approval) and the private group
// X, whose root holds a plaintext post. A joins every root and posts in
// none of the public ones.
async function creator (t, bootstrap, assoc, now) {
  const k = {}
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const under = (opts) => groupHeader({ diary: key, community: k.C, member: k.C, ...opts })
    k.C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Praia' }))
    k.G = await make('geral', under({ name: 'Cadeiras' }))
    k.H = await make('toalhas', under({ name: 'Toalhas' }))
    k.M = await make('mesas', under({ name: 'Mesas' }))
    k.P = await make('guarda-sol', under({ name: 'Guarda-sol', join: 'approval' }))
    k.X = await make('privado', under({ visibility: 'private', join: 'approval', name: null, box: BOX }), [groupPost({ text: 'oi', at: iso(now) })])
    return [k.C, k.G, k.H, k.M, k.P, k.X].map((g) => groupJoinRecord({ group: g, writer: g, on: true }))
  })
  for (const g of [k.G, k.H, k.M, k.P, k.X]) await A.cores.community.append(encode(groupCreateRecord({ group: g })))
  return { A, ...k }
}

// A and members D, E and F. In G, D, E and F posted a minute ago (E's
// core holds an older post below it; F's core, with `filler`, that many
// posts of 9 days ago above it). In H, D posted a minute ago and E 8 days
// ago and 2 days ahead. In M and in the approval group P, D and E posted
// a minute ago. Resolves once every core is admitted and downloaded and the
// trending answer is complete.
async function setup (t, { activityTail, filler = 0 } = {}) {
  const now = Date.now()
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const opts = { associationKey: assoc.hex }
  if (activityTail !== undefined) opts.activityTail = activityTail
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, opts)

  const { A, C, G, H, M, P, X } = await creator(t, bootstrap, assoc, now)
  const recent = (text) => groupPost({ text, at: iso(now - 60000) })
  const w = {}
  const D = await member(t, bootstrap, assoc, async ({ key, make }) => {
    w.DG = await make('dg', writerHeader({ group: G, diary: key }), [recent('d')])
    w.DH = await make('dh', writerHeader({ group: H, diary: key }), [recent('d')])
    w.DM = await make('dm', writerHeader({ group: M, diary: key }), [recent('d')])
    w.DP = await make('dp', writerHeader({ group: P, diary: key }), [recent('d')])
    return [G, H, M, P].map((g, i) => groupJoinRecord({ group: g, writer: [w.DG, w.DH, w.DM, w.DP][i], on: true }))
  })
  const E = await member(t, bootstrap, assoc, async ({ key, make }) => {
    w.EG = await make('eg', writerHeader({ group: G, diary: key }), [groupPost({ text: 'antes', at: iso(now - 3600000) }), recent('e')])
    w.EH = await make('eh', writerHeader({ group: H, diary: key }), [groupPost({ text: 'velho', at: iso(now - 8 * DAY) }), groupPost({ text: 'futuro', at: iso(now + 2 * DAY) })])
    w.EM = await make('em', writerHeader({ group: M, diary: key }), [recent('e')])
    w.EP = await make('ep', writerHeader({ group: P, diary: key }), [recent('e')])
    return [G, H, M, P].map((g, i) => groupJoinRecord({ group: g, writer: [w.EG, w.EH, w.EM, w.EP][i], on: true }))
  })
  const F = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const old = []
    for (let i = 0; i < filler; i++) old.push(groupPost({ text: 'velho ' + i, at: iso(now - 9 * DAY) }))
    w.FG = await make('fg', writerHeader({ group: G, diary: key }), [recent('f'), ...old])
    return [groupJoinRecord({ group: G, writer: w.FG, on: true })]
  })

  for (const m of [A, D, E, F]) await admit(m, assoc)
  for (const k of [C, G, H, M, P, X, ...Object.values(w)]) await admitted(events, k)
  // complete covers only the blocks the seeder holds (_activityBehind reads
  // up to the contiguous prefix): a core counts once block 0 verifies, and
  // its posts may still be on the way.
  for (const m of [A, D, E, F]) for (const core of Object.values(m.cores)) await downloaded(seeder, hex(core.key), core.length)
  await settled(seeder, 'em alta completo', (a) => a.groups.length > 0)
  return { bootstrap, assoc, dataDir, publicKey, seeder, events, now, A, D, E, F, C, G, H, M, P, X, w }
}

function trending (seeder) {
  return seeder.indexGroupBrowse('trending')
}

function settled (seeder, name, fn = () => true) {
  return until(() => {
    if (!scansDone(seeder)) return false
    const a = trending(seeder)
    return a !== null && a.complete && fn(a)
  }, { name, timeoutMs: 60000 })
}

function keys (answer) {
  return answer.groups.map((r) => r.group)
}

function row (answer, group) {
  return answer.groups.find((r) => r.group === group) || null
}

function activeWithinMembers (t, answer) {
  for (const r of answer.groups) t.ok(r.active <= r.members, 'active ' + r.active + ' <= members ' + r.members)
}

test('two diaries that posted lately list an open group with active 2; one alone, an old or a future post, an approval group and a private group do not', async (t) => {
  t.timeout(150000)
  const { seeder, events, now, A, C, G, H, M, P, X, w } = await setup(t)

  const answer = trending(seeder)
  t.is(answer.indexing, false)
  t.is(answer.complete, true)
  t.is(answer.more, false)
  t.alike(keys(answer), [G, M], 'most active first')
  t.is(row(answer, G).active, 3, 'D, E and F in G')
  t.is(row(answer, G).members, 4, 'A, D, E and F are members')
  t.alike(row(answer, M), { group: M, name: 'Mesas', creator: A.key, community: C, communityName: 'Praia', members: 3, created: row(answer, M).created, active: 2 })
  activeWithinMembers(t, answer)

  t.absent(keys(answer).includes(H), 'one diary alone in the window: H is not listed')
  t.is(seeder._groupActivity.entry(w.DH).at, now - 60000)
  t.is(seeder._groupActivity.entry(w.EH).at, now - 8 * 86400000, 'a post 2 days ahead is not stored; one 8 days old is, and does not count')
  t.is(seeder._groupActivity.entry(w.EH).seq, 1)

  t.absent(keys(answer).includes(P), 'an approval group is not listed')
  t.ok(seeder._groupActivity.entry(w.DP) !== null && seeder._groupActivity.entry(w.EP) !== null, 'though its posts are read')

  t.absent(keys(answer).includes(X), 'a private group is not listed')
  t.is(seeder._groupActivity.entry(X), null, 'and its cores are never read for activity')
  t.is(seeder._groupServed.get(X).actScanned, 0)
  t.is(seeder._groupActivity.entry(C), null, 'nor are a community\'s')
  t.is(seeder._groupServed.get(C).actScanned, 0)

  t.is(seeder._groupActivity.entry(w.EG).seq, 2, 'the newest post of a core is kept')
  t.is(seeder.indexGroupBrowse('members').groups.find((r) => r.group === G).active, null, 'the other orders carry no active count')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a blocked diary stops counting at once and its dropped cores leave the activity; a verified Pagina and a hidden writer core never count', async (t) => {
  t.timeout(180000)
  const { bootstrap, assoc, publicKey, seeder, events, D, E, F, G, M, w } = await setup(t)

  // F's core hidden: the members filter drops it, and active must too, or
  // active could exceed the member count.
  const coreVisible = seeder._groupCoreVisible
  seeder._groupCoreVisible = function (key) {
    return key !== w.FG && coreVisible.call(this, key)
  }
  const hidden = trending(seeder)
  t.is(row(hidden, G).members, 3, 'the members filter drops F')
  t.is(row(hidden, G).active, 2, 'and so does the active count')
  activeWithinMembers(t, hidden)
  seeder._groupCoreVisible = coreVisible

  // A verified Pagina (page-roster hint) is never active: one owner holds
  // several.
  const hint = seeder._names.hint
  seeder._names.hint = (k) => k === F.key ? { page: true, closed: false, moved: false } : hint(k)
  t.is(row(trending(seeder), G).active, 2, 'the Pagina F does not count')
  t.is(row(trending(seeder), G).members, 4, 'though it is a member')
  seeder._names.hint = (k) => k === D.key || k === F.key ? { page: true, closed: false, moved: false } : hint(k)
  t.absent(keys(trending(seeder)).includes(M), 'M with only E left active is not listed')
  seeder._names.hint = hint
  t.alike(keys(trending(seeder)), [G, M])

  const before = seeder._groupActivity.stats().writers
  const mod = moderator(assoc)
  const blocklist = createSnapshot({ seq: 1, blocked: [E.key], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist })
  await until(() => seeder._isBlocked(E.key), { name: 'E bloqueado' })
  const seen = trending(seeder)
  t.is(row(seen, G).active, 2, 'E stops counting at once')
  t.absent(keys(seen).includes(M), 'M is left with D alone')
  for (const k of [w.EG, w.EH, w.EM, w.EP]) await rejected(events, k, 'blocked')
  for (const k of [w.EG, w.EH, w.EM, w.EP]) t.is(seeder._groupActivity.entry(k), null, 'a dropped core leaves the activity')
  t.is(seeder._groupActivity.stats().writers, before - 4, 'its slots are freed')
  await settled(seeder, 'E fora', (a) => keys(a).length === 1)
  t.is(row(trending(seeder), G).active, 2)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('with activityTail 4 the scan skips a post 10 blocks back and counts a new post with an escaped type', async (t) => {
  t.timeout(150000)
  const { seeder, events, now, F, G, w } = await setup(t, { activityTail: 4, filler: 10 })
  const answer = trending(seeder)
  t.is(answer.complete, true, 'nothing is behind: history past the tail is skipped')
  t.is(row(answer, G).active, 2, 'F\'s recent post, 10 blocks back, is not read')
  const entry = seeder._groupServed.get(w.FG)
  t.is(entry.core.contiguousLength, 12)
  t.is(entry.actScanned, 12)
  t.is(seeder._groupActivity.entry(w.FG).at, now - 9 * 86400000, 'only the old posts of the tail were read')
  t.ok(seeder._groupActivity.entry(w.FG).seq >= 8, 'from the last 4 blocks')

  const post = groupPost({ text: 'voltei' })
  const raw = b4a.from(JSON.stringify(post).replace('group-post', 'group\\u002dpost'))
  t.is(decodeBlock(raw)?.type, 'group-post')
  await F.cores.fg.append(raw)
  await settled(seeder, 'F ativo de novo', (a) => row(a, G) !== null && row(a, G).active === 3)
  t.is(seeder._groupActivity.entry(w.FG).seq, 12)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a post at or past its writer\'s cut never counts, and lowering the cut below a counted post removes it', async (t) => {
  t.timeout(150000)
  const { seeder, events, now, E, G, M, w } = await setup(t)
  t.alike(seeder._groupActivity.entry(w.EG), { at: now - 60000, seq: 2 })

  await E.diary.append(groupCutRecord({ group: G, writer: w.EG, cut: 2 }))
  await until(() => {
    const e = seeder._groupServed.get(w.EG)
    return e.cut === 2 && !e.actScanning && !seeder._activityBehind()
  }, { name: 'EG cortado em 2' })
  t.alike(seeder._groupActivity.entry(w.EG), { at: now - 3600000, seq: 1 }, 'the post at the cut is gone; the one below it is read again')

  await E.diary.append(groupCutRecord({ group: G, writer: w.EG, cut: 1 }))
  await until(() => {
    const e = seeder._groupServed.get(w.EG)
    return e.cut === 1 && !e.actScanning && !seeder._activityBehind()
  }, { name: 'EG cortado em 1' })
  t.is(seeder._groupActivity.entry(w.EG), null, 'no post of E is below the cut')
  await settled(seeder, 'E fora de G', (a) => row(a, G) !== null && row(a, G).active === 2)
  t.ok(keys(trending(seeder)).includes(M), 'E\'s other groups still count')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('writer growth respects pending activity backoff and a new cut retries at once', async (t) => {
  t.timeout(150000)
  const { seeder, D, G, w } = await setup(t)
  const entry = seeder._groupServed.get(w.DG)
  const index = D.cores.dg.length
  const get = entry.core.get
  let reads = 0
  // Allow time for growth and the cut to replicate before the timer fires.
  entry.actReadFailures = 3
  entry.core.get = function (i, opts) {
    if (i === index && opts?.wait === false) {
      reads++
      if (reads === 1) return Promise.resolve(null)
    }
    return get.call(this, i, opts)
  }

  await D.cores.dg.append(encode(groupPost({ text: 'uma publicação' })))
  const retry = await until(() => entry.actRetry, { name: 'nova leitura de DG agendada' })
  t.is(reads, 1, 'the first read failed')

  await D.cores.dg.append(encode(groupPost({ text: 'outra publicação' })))
  await until(() => entry.core.contiguousLength === index + 2, { name: 'DG cresceu durante a espera' })
  await seeder._activityQueue
  t.ok(entry.actRetry === retry, 'the retry timer is still pending')
  t.is(reads, 1, 'growth did not read the failed block again')

  const cut = index + 1
  await D.diary.append(groupCutRecord({ group: G, writer: w.DG, cut }))
  await until(() => entry.cut === cut, { name: 'DG cortado' })
  t.is(entry.actRetry, null, 'the cut canceled the pending retry')
  await settled(seeder, 'atividade abaixo do corte de DG', () => seeder._groupActivity.entry(w.DG)?.seq === index)
  t.is(reads, 2, 'the new pass read the block below the cut')
})

test('after a restart, cores served before the diary scans add their index rows still count', async (t) => {
  t.timeout(180000)
  const { bootstrap, assoc, dataDir, seeder, G, M, w } = await setup(t)
  const before = trending(seeder)
  await seeder.close()

  let early = null
  const beforeStart = (s) => onPassesStart(s, () => {
    early = { served: s._groupServed.has(w.DG), row: s._groupIndex.writer(w.DG) }
  })
  const { seeder: again, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, beforeStart })
  t.ok(early.served, 'D\'s core in G is served when the passes start')
  t.is(early.row, null, 'before the diary scan adds its index row')
  await settled(again, 'em alta depois do reinício', (a) => a.groups.length === 2)
  const after = trending(again)
  t.alike(keys(after), [G, M])
  t.alike(after.groups.map((r) => r.active), before.groups.map((r) => r.active), 'the same active counts')
  activeWithinMembers(t, after)
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

test('a pending activity read of a non-root writer keeps trending incomplete', async (t) => {
  t.timeout(150000)
  const { seeder, D, G, w } = await setup(t)
  const index = D.cores.dg.length
  const hold = holdRead(seeder, w.DG, index)
  try {
    await D.cores.dg.append(encode(groupPost({ text: 'em leitura' })))
    await until(() => hold.entered, { name: 'leitura da atividade de DG' })
    t.is(seeder._rootScanBehind(G), false, 'the root scan is caught up')
    t.is(seeder._activityBehind(), true, 'the activity scan is held')
    t.is(seeder.indexGroupBrowse('members').complete, true)
    t.is(trending(seeder).complete, false)
  } finally {
    hold.release()
  }

  await settled(seeder, 'atividade de DG lida', () => seeder._groupActivity.entry(w.DG)?.seq === index)
  t.is(trending(seeder).complete, true)
})

test('a group whose header says open and whose later group-meta says approval is not listed, nor while its root scan is behind', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, G, M } = await setup(t)
  t.ok(keys(trending(seeder)).includes(M))

  const hold = holdRead(seeder, M, 1)
  await A.cores.mesas.append(encode(groupMeta({ name: 'Mesas', join: 'approval' })))
  await until(() => hold.entered, { name: 'leitura do meta de M' })
  t.ok(seeder._rootScanBehind(M), 'the scan of M is held')
  const held = trending(seeder)
  t.absent(keys(held).includes(M), 'M is left out while its join may have closed')
  t.is(held.complete, false, 'and the answer is not complete')
  t.ok(keys(held).includes(G))

  hold.release()
  await settled(seeder, 'meta de M lido', () => !seeder._rootScanBehind(M))
  t.alike(keys(trending(seeder)), [G], 'once folded, M asks for approval: not listed')
  t.ok(keys(seeder.indexGroupBrowse('members')).includes(M), 'the members order still lists it')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// A root downloads out of order, so its signed length can run ahead of its
// contiguous prefix, which is all a root scan reads: a group-meta past the
// hole is not folded, yet neither the root scan (_rootScanBehind) nor the
// activity scan (_activityBehind) is behind. The hole is made as in
// seeder-group-browse.test.js: the read of block 1 is held, block 1 is
// cleared once both new blocks are local, then the held read gets nothing.
// Both new blocks are group-meta, so the root adds no activity of A.
test('an open group whose root has a hole below a later block is left out and the answer is not complete until its root is read in order', async (t) => {
  t.timeout(150000)
  const { seeder, events, A, G, M } = await setup(t)
  t.ok(keys(trending(seeder)).includes(M))

  const entry = seeder._groupServed.get(M)
  const hold = holdRead(seeder, M, 1)
  await A.cores.mesas.append(encode(groupMeta({ name: 'Mesas', join: 'open' })))
  await A.cores.mesas.append(encode(groupMeta({ name: 'Mesas de praia', join: 'open' })))
  await until(() => hold.entered && entry.core.contiguousLength === 3, { name: 'blocos novos de M baixados' })
  await entry.core.clear(1)
  t.is(entry.core.contiguousLength, 1, 'a hole at block 1')
  t.is(entry.core.length, 3, 'below a block the seeder holds')
  hold.release()
  await until(() => !entry.rootScanning && !entry.actScanning && !seeder._activityBehind() && scansDone(seeder), { name: 'leituras de M paradas no buraco' })
  t.absent(seeder._rootScanBehind(M), 'the root scan is not behind its contiguous prefix')
  t.absent(seeder._activityBehind(), 'nor is the activity scan')
  t.ok(seeder._rootGap(M), 'but the root is not read up to its length')
  const held = trending(seeder)
  t.absent(keys(held).includes(M), 'M is left out while a group-meta past the hole is unread')
  t.is(held.complete, false, 'and the answer is not complete')
  t.ok(keys(held).includes(G), 'G still lists')

  await entry.core.download({ start: 1, end: 2 }).done()
  await settled(seeder, 'buraco de M preenchido', (a) => row(a, M) !== null)
  t.absent(seeder._rootGap(M))
  const after = trending(seeder)
  t.is(after.complete, true)
  t.is(row(after, M).active, 2, 'D and E, as before')
  t.is(row(after, M).name, 'Mesas de praia', 'the rename past the hole is read')
  activeWithinMembers(t, after)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
