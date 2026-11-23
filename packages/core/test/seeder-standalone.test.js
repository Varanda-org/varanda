'use strict'

// Standalone groups at the seeder (docs/protocol.md section 10): a v2 group
// root that names no community (community and member both null) is
// admitted, served and kept like any other root, its writers name the root
// key as `member`, and its header record survives a restart. The legacy
// search, the browse lists and the profile box never show it, and it queues
// no community notice.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { groupJoinRecord } = require('../lib/records')
const { groupHeader, writerHeader, groupPost } = require('../lib/group')
const { createIssuedCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const {
  PARENT,
  makeAssociation,
  makeIssuer,
  moderator,
  readFile,
  readGroups,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  downloaded,
  scansDone
} = require('./helpers/seeder-groups')

const BOX = 'e'.repeat(64)
const WRITER_BOX = 'd'.repeat(64)

function standalone (diary, opts = {}) {
  return groupHeader({ diary, ...opts })
}

function standalonePrivate (diary) {
  return groupHeader({ diary, visibility: 'private', join: 'approval', name: null, box: BOX })
}

// Creator A: public standalone S ('Roda livre', one post), private
// standalone V and, for contrast, G ('Roda da praia') under a community
// this seeder never serves. Member B: writer WS in S and WV in V, each
// naming the root as `member`. `certOf` signs A's certificate.
async function standaloneGroups (t, bootstrap, assoc, certOf = null) {
  const k = {}
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.S = await make('s', standalone(key, { name: 'Roda livre' }), [groupPost({ text: 'oi' })])
    k.V = await make('v', standalonePrivate(key))
    k.G = await make('g', groupHeader({ diary: key, community: PARENT, member: PARENT, name: 'Roda da praia' }))
    return [k.S, k.V, k.G].map((g) => groupJoinRecord({ group: g, writer: g, on: true }))
  }, certOf === null ? {} : { certOf })
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.WS = await make('ws', writerHeader({ group: k.S, diary: key, member: k.S }), [groupPost({ text: 'olá' })])
    k.WV = await make('wv', writerHeader({ group: k.V, diary: key, member: k.V, box: WRITER_BOX }))
    return [groupJoinRecord({ group: k.S, writer: k.WS, on: true }), groupJoinRecord({ group: k.V, writer: k.WV, on: true })]
  })
  return { A, B, ...k }
}

function indexedHeader (seeder, group) {
  const g = seeder.indexGroup(group)
  return g === null ? null : g.header
}

test('a public and a private standalone group with a member are admitted, served, kept across a restart and stay out of legacy discovery', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const notices = []
  const opts = { associationKey: assoc.hex, onGroupNotice: (e) => notices.push(e) }
  const first = await startSeeder(t, bootstrap, dataDir, opts)
  const { seeder, events } = first

  const { A, B, S, V, G, WS, WV } = await standaloneGroups(t, bootstrap, assoc)
  // A root whose parent fields mix null and a key is no header.
  let M = null
  const X = await member(t, bootstrap, assoc, async ({ key, make }) => {
    M = await make('m', { ...standalone(key, { name: 'Roda mista' }), member: 'ab'.repeat(32) })
    return [groupJoinRecord({ group: M, writer: M, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(X, assoc)
  for (const key of [S, V, G, WS, WV]) await admitted(events, key)
  await rejected(events, M, 'header-invalid')
  t.absent(seeder._groupServed.has(M), 'a mixed root is not served')
  await downloaded(seeder, S, 2)
  await downloaded(seeder, WS, 2)
  await downloaded(seeder, V, 1)
  await downloaded(seeder, WV, 1)

  // Replicated: a reader that dials only the seeder gets the blocks.
  const r = await reader(t, bootstrap, publicKey)
  for (const [key, source] of [[S, A.cores.s], [WS, B.cores.ws]]) {
    const copy = r.store.get({ key: b4a.from(key, 'hex') })
    await copy.ready()
    t.alike(await copy.get(1, { raw: true, timeout: 20000 }), await source.get(1, { raw: true }), 'served from the seeder: ' + key.slice(0, 8))
  }

  const s = seeder.indexGroup(S)
  t.alike({ ...s.header, diary: null }, { kind: 'group', visibility: 'public', join: 'open', name: 'Roda livre', community: null, member: null, diary: null })
  t.is(s.community, null, 'no parent community')
  t.is(s.attached, false, 'no catalogue attaches it')
  t.ok(s.writers.some((w) => w.key === WS && w.diary === B.key), 'the member writer is listed')
  const v = seeder.indexGroup(V)
  t.is(v.header.visibility, 'private')
  t.is(v.header.name, null, 'no name for a private group')
  t.is(v.header.community, null)
  t.is(v.header.member, null)
  t.is(v.community, null)
  t.is(v.attached, false)
  t.ok(v.writers.some((w) => w.key === WV && w.diary === B.key))

  await until(() => seeder.indexGroupSearch('roda').complete, { name: 'busca completa' })
  t.alike(seeder.indexGroupSearch('roda').groups.map((g) => g.group), [G], 'legacy search lists the community group only')
  t.alike(seeder.indexGroupSearch('roda-livre').groups, [], 'not even by the exact name')
  for (const order of ['members', 'recent', 'trending']) {
    t.absent(seeder.indexGroupBrowse(order).groups.some((g) => g.group === S), 'browse ' + order)
  }
  for (const diary of [A.key, B.key]) {
    const page = seeder.indexPublicGroups(diary)
    t.ok(page !== null && !page.hidden)
    t.absent(page.groups.some((g) => g.group === S), 'public groups of ' + diary.slice(0, 8))
  }

  // No community notice is ever set up for a standalone root.
  await B.cores.ws.append(encode(groupPost({ text: 'novidade' })))
  await downloaded(seeder, WS, 3)
  seeder._queueGroupNotices()
  seeder._queueGroupNotices(S)
  t.is(seeder._groupServed.get(S).groupNotice, null, 'no notice state for S')
  t.is(seeder._groupServed.get(V).groupNotice, null, 'nor for V')
  t.alike(notices, [])

  await until(() => S in (readFile(dataDir).groupHeaders || {}) && V in readFile(dataDir).groupHeaders, { name: 'registros gravados' })
  const listed = readFile(dataDir).groupHeaders
  t.alike(listed[S], { kind: 'group', visibility: 'public', join: 'open', name: 'Roda livre', community: null, member: null }, 'the record is persisted')
  t.alike(listed[V], { kind: 'group', visibility: 'private', join: 'approval', name: null, community: null, member: null })
  t.absent(M in listed, 'a mixed root is never recorded')

  await seeder.close()
  const second = await startSeeder(t, bootstrap, dataDir, opts)
  await until(() => second.seeder._groupRootStartup === null && scansDone(second.seeder), { name: 'varreduras de início' })
  for (const key of [S, V, WS, WV]) {
    t.ok(second.seeder._groupServed.has(key), 'served after the restart: ' + key.slice(0, 8))
    t.ok(key in readGroups(dataDir), 'listed after the restart: ' + key.slice(0, 8))
    t.absent(second.events.some((e) => e.event === 'group-rejected' && e.key === key), 'never dropped: ' + key.slice(0, 8))
  }
  t.is(second.seeder.indexGroup(S).header.community, null)
  t.is(second.seeder.indexGroup(S).attached, false)
  t.alike(second.seeder._groupHeaders.get(V), { kind: 'group', visibility: 'private', join: 'approval', name: null, community: null, member: null })
  second.seeder._queueGroupNotices()
  t.is(second.seeder._groupServed.get(S).groupNotice, null, 'still no notice state')
  t.alike(notices, [])
  t.is(events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a standalone root purged at a restart keeps its header record for its member\'s writer; a mixed or keyless record is dropped', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const issuer = makeIssuer(assoc)
  const { A, B, S, V, WS, WV } = await standaloneGroups(t, bootstrap, assoc, (key) => createIssuedCert({ member: key }, issuer.kp, issuer.cert))
  // Two more standalone roots of A, whose records the file then mangles.
  const k = {}
  const roots = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.MIX = await make('mix', standalone(key, { name: 'Roda mista' }))
    k.NOKEY = await make('nokey', standalone(key, { name: 'Roda sem chaves' }))
    return [k.MIX, k.NOKEY].map((g) => groupJoinRecord({ group: g, writer: g, on: true }))
  }, { certOf: (key) => createIssuedCert({ member: key }, issuer.kp, issuer.cert) })
  const Z = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.WM = await make('wm', writerHeader({ group: k.MIX, diary: key, member: k.MIX }))
    k.WN = await make('wn', writerHeader({ group: k.NOKEY, diary: key, member: k.NOKEY }))
    return [groupJoinRecord({ group: k.MIX, writer: k.WM, on: true }), groupJoinRecord({ group: k.NOKEY, writer: k.WN, on: true })]
  })
  for (const m of [A, B, roots, Z]) await admit(m, assoc)
  for (const key of [S, V, WS, WV, k.MIX, k.NOKEY, k.WM, k.WN]) await admitted(first.events, key)
  await downloaded(first.seeder, S, 2)
  await downloaded(first.seeder, WS, 2)
  await until(() => [S, V, k.MIX, k.NOKEY].every((g) => g in (readFile(dataDir).groupHeaders || {})), { name: 'registros gravados' })
  await first.seeder.close()
  // Nobody holds the roots any more, so no join fetches and records one again.
  for (const m of [A, B, roots, Z]) await m.swarm.destroy()

  // The creators' issuer is revoked: their roots go at the restart while
  // the members' writers stay. One record mixes null and a key, one lacks
  // the parent keys: both are dropped as they are read.
  const file = readFile(dataDir)
  file.groupHeaders[k.MIX] = { ...file.groupHeaders[k.MIX], member: 'ab'.repeat(32) }
  delete file.groupHeaders[k.NOKEY].community
  delete file.groupHeaders[k.NOKEY].member
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  for (const key of [S, V, k.MIX, k.NOKEY]) {
    t.ok(second.events.some((e) => e.event === 'group-rejected' && e.key === key && e.reason === 'revoked-issuer'), 'root purged at start: ' + key.slice(0, 8))
  }
  for (const key of [WS, WV, k.WM, k.WN]) t.ok(second.seeder._groupServed.has(key), 'writer kept: ' + key.slice(0, 8))

  const s = second.seeder.indexGroup(S)
  t.is(s.rootServed, false)
  t.alike(s.header, { kind: 'group', visibility: 'public', join: 'open', name: 'Roda livre', community: null, member: null, diary: null }, 'the kept record answers for the purged public root')
  t.is(s.community, null)
  t.is(s.attached, false)
  t.alike(indexedHeader(second.seeder, V), { kind: 'group', visibility: 'private', join: 'approval', name: null, community: null, member: null, diary: null }, 'and for the purged private root')
  t.is(indexedHeader(second.seeder, k.MIX), null, 'a mixed record is not read back')
  t.is(indexedHeader(second.seeder, k.NOKEY), null, 'nor one without the parent keys')
  t.is(second.seeder.indexGroup(k.MIX).complete, false, 'a group without a header record is never complete')
  const written = readFile(dataDir).groupHeaders
  t.alike(written[S], { kind: 'group', visibility: 'public', join: 'open', name: 'Roda livre', community: null, member: null }, 'the record is written back')
  t.absent(k.MIX in written, 'the mixed record is gone from the file')
  t.absent(k.NOKEY in written, 'and so is the keyless one')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})
