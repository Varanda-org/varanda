'use strict'

// Private groups at the seeder (docs/protocol.md section 10, "Private
// groups", "Seeders, communities and reports"): roots and writers are
// admitted and served like public ones, sealed blocks travel raw, the index
// never shows a private name, and the moderation lookup answers a sealed
// block with its structure only.

const test = require('brittle')
const b4a = require('b4a')
const { testnet, until } = require('./helpers/net')
const { groupJoinRecord } = require('../lib/records')
const { groupHeader, writerHeader, groupPost, groupSealed, sealedInner, groupLink, communityLink } = require('../lib/group')
const { newEpochKey, sealRecord } = require('../lib/group-crypto')
const { Seeder } = require('../lib/seeder')
const { tmpDir } = require('./helpers/tmp')
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
  downloaded
} = require('./helpers/seeder-groups')

const BOX = 'e'.repeat(64)
const SECRET = 'texto secreto do grupo'

function sealed (writer, group, epochKey) {
  const kid = { writer: group, seq: 1 }
  const { nonce, box } = sealRecord(sealedInner(groupPost({ text: SECRET }), { writer, group, kid }), epochKey)
  return groupSealed({ kid, nonce, box })
}

// Creator A: private root G (box header, a sealed post), public root P and
// community root C linked two-way with G. Member B: writer W in G with a
// box (a sealed post, then a plaintext post the fold would not count).
// Member X: writer N in G without a box and writer Q in P with one, both
// mismatches.
async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const epochKey = newEpochKey()
  let G = null
  let P = null
  let C = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    G = await make('group', groupHeader({ diary: key, visibility: 'private', join: 'approval', name: null, box: BOX }))
    P = await make('public', groupHeader({ diary: key, name: 'Cadeiras' }), [groupPost({ text: 'oi' })])
    C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Praia' }), [groupLink({ group: G, on: true })])
    return [groupJoinRecord({ group: G, writer: G, on: true }), groupJoinRecord({ group: P, writer: P, on: true }), groupJoinRecord({ group: C, writer: C, on: true })]
  })
  await A.cores.group.append(encode(sealed(G, G, epochKey)))
  await A.cores.group.append(encode(communityLink({ community: C, on: true })))
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: G, diary: key, box: 'd'.repeat(64) }))
    return [groupJoinRecord({ group: G, writer: W, on: true })]
  })
  await B.cores.w.append(encode(sealed(W, G, epochKey)))
  await B.cores.w.append(encode(groupPost({ text: 'em claro' })))
  return { bootstrap, assoc, publicKey, seeder, events, A, B, G, P, C, W }
}

test('a private group is admitted, served raw and indexed without a name; box mismatches are refused', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, publicKey, seeder, events, A, B, G, P, C, W } = await setup(t)
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, P)
  await admitted(events, C)
  await downloaded(seeder, G, 3)
  await admit(B, assoc)
  await admitted(events, W)
  await downloaded(seeder, W, 3)

  // A writer without a box in the private group, one with a box in the
  // public group: refused once the root's visibility is known.
  let N = null
  let Q = null
  const X = await member(t, bootstrap, assoc, async ({ key, make }) => {
    N = await make('n', writerHeader({ group: G, diary: key }))
    Q = await make('q', writerHeader({ group: P, diary: key, box: 'c'.repeat(64) }))
    return [groupJoinRecord({ group: G, writer: N, on: true }), groupJoinRecord({ group: P, writer: Q, on: true })]
  })
  await admit(X, assoc)
  await rejected(events, N, 'header-invalid')
  await rejected(events, Q, 'header-invalid')
  t.absent(seeder._groupServed.has(N), 'a private writer without a box is not served')
  t.absent(seeder._groupServed.has(Q), 'a public writer with a box is not served')

  const g = seeder.indexGroup(G)
  t.is(g.header.visibility, 'private')
  t.is(g.header.name, null, 'no name for a private group')
  t.ok(g.writers.some((w) => w.key === W && w.diary === B.key), 'the writers as for a public group')
  await until(() => seeder.indexGroupSearch('cadeiras').complete, { name: 'busca completa' })
  t.alike(seeder.indexGroupSearch('cadeiras').groups.map((r) => r.group), [P], 'the search lists only the public group')
  await until(() => seeder.indexCommunity(C) && seeder.indexCommunity(C).groups.length === 1, { name: 'ligação privada' })
  t.alike(seeder.indexCommunity(C).groups, [{ group: G, visibility: 'private' }], 'a private group is listed by key and visibility only')

  // The sealed block reaches a reader over the swarm byte for byte.
  const r = await reader(t, bootstrap, publicKey)
  const copy = r.store.get({ key: b4a.from(W, 'hex') })
  await copy.ready()
  const got = await copy.get(1, { raw: true, timeout: 20000 })
  t.alike(got, await B.cores.w.get(1, { raw: true }), 'the sealed block is served raw')

  const answer = await seeder.groupPostBlock(W, 1)
  t.alike(answer, { sealed: true, writer: W, diary: B.key, group: G, seq: 1 }, 'the structure only')
  t.alike(Object.keys(answer).sort(), ['diary', 'group', 'sealed', 'seq', 'writer'])
  t.alike(await seeder.groupPostBlock(G, 1), { sealed: true, writer: G, diary: A.key, group: G, seq: 1 }, 'the root as a writer of its creator')
  t.is(await seeder.groupPostBlock(W, 2), null, 'a plaintext post in a private group is no counted record')
  t.is(await seeder.groupPostBlock(G, 2), null, 'a community-link is no post')
  t.is(await seeder.groupPostBlock(W, 3), null, 'a block past the length')
  t.is(await seeder.groupPostBlock(N, 1), null, 'an unserved writer')
  t.is(await seeder.postBlock(W, 1), null, '/moderation-post never resolves a group ref')
  t.is(await seeder.postBlock(G, 1), null)

  // Logs carry keys and reasons, never block text or sealed content.
  const logged = JSON.stringify(events)
  t.absent(logged.includes(SECRET))
  t.absent(logged.includes('em claro'))
  t.absent(logged.includes('"box"'))
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a sealed block in a public group is no sealed report; the plaintext post keeps its answer', async (t) => {
  t.timeout(120000)
  const { seeder, events, assoc, A, P } = await setup(t)
  await A.cores.public.append(encode({ type: 'group-sealed', kid: { writer: P, seq: 1 }, nonce: 'ab'.repeat(24), box: b4a.toString(b4a.alloc(40, 1), 'base64'), at: new Date().toISOString() }))
  await admit(A, assoc)
  await admitted(events, P)
  await downloaded(seeder, P, 3)
  const post = await seeder.groupPostBlock(P, 1)
  t.is(post.texto, 'oi', 'a public group-post answers as before')
  t.absent('sealed' in post)
  t.is(await seeder.groupPostBlock(P, 2), null, 'a group-sealed record in a public group')
})

test('a writer gated before its root header was known is dropped when the header shows a box mismatch', async (t) => {
  const seeder = new Seeder({ dataDir: tmpDir(t, 'varanda-seed-') })
  const G = '1'.repeat(64)
  const D = '2'.repeat(64)
  const raws = {
    ['3'.repeat(64)]: encode(writerHeader({ group: G, diary: D })),
    ['4'.repeat(64)]: encode(writerHeader({ group: G, diary: D, box: 'd'.repeat(64) }))
  }
  for (const [key, raw] of Object.entries(raws)) {
    seeder._groupServed.set(key, { group: G, diary: D, headerOk: true, dropped: false, core: { get: async () => raw } })
  }
  const drops = []
  seeder._dropGroup = (key, reason) => drops.push([key, reason])
  seeder._persist = async () => {}
  t.is(seeder._groupVisibility(G), null, 'unknown before the header')
  seeder._keepGroupHeader(G, groupHeader({ diary: D, visibility: 'private', join: 'approval', name: null, box: BOX }))
  await until(() => drops.length === 1, { name: 'reverificação' })
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(drops, [['3'.repeat(64), 'header-invalid']], 'only the writer without a box goes')
  t.is(seeder._groupVisibility(G), 'private')
})

test('a root header recorded while a writer\'s gate runs still refuses a box mismatch', async (t) => {
  const G = '1'.repeat(64)
  const D = '2'.repeat(64)
  const header = groupHeader({ diary: D, visibility: 'private', join: 'approval', name: null, box: BOX })
  const run = async (box) => {
    const key = (box === null ? '3' : '4').repeat(64)
    // The hook runs between the verdict (visibility unknown) and headerOk.
    const seeder = new Seeder({ dataDir: tmpDir(t, 'varanda-seed-'), regateHook: async () => seeder._keepGroupHeader(G, header) })
    seeder._persist = async () => {}
    const drops = []
    seeder._dropGroup = (k, reason) => drops.push([k, reason])
    const raw = encode(writerHeader({ group: G, diary: D, box }))
    const entry = { group: G, diary: D, by: D, headerOk: false, gating: false, dropped: false, expected: null, headerTimer: null, core: { contiguousLength: 1, get: async () => raw } }
    seeder._groupServed.set(key, entry)
    t.is(seeder._groupVisibility(G), null)
    seeder._gateGroup(key, entry)
    await until(() => !entry.gating, { name: 'gate' })
    return { drops, entry, key }
  }
  const bad = await run(null)
  t.alike(bad.drops, [[bad.key, 'header-invalid']], 'a writer without a box is refused')
  t.absent(bad.entry.headerOk)
  const good = await run('d'.repeat(64))
  t.alike(good.drops, [])
  t.ok(good.entry.headerOk, 'a writer with a box is gated')
})
