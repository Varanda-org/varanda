// Community roots at the seeder (docs/protocol.md section 10,
// "Communities"): a community root is admitted like a group root, from its
// creator diary's join { group: C, writer: C, on: true }, and the index
// folds the link records of every served root (group-link in a community
// root, community-link in a group root). A link is answered only while both
// sides name each other.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord, MAX_GROUPS_PER_COMMUNITY } = require('../lib/records')
const { groupHeader, writerHeader, groupPost, groupLink, communityLink } = require('../lib/group')
const {
  hex,
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  stored,
  moderator
} = require('./helpers/seeder-groups')

// Creator A: group root G (its community-link to C written up front) and,
// when `community` is set, community root C with group-links from
// `community(G)`. C's key is unknown until its core exists, so G's link is
// appended once C is made.
async function creator (t, bootstrap, assoc, { links = null } = {}) {
  let G = null
  let C = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    G = await make('group', groupHeader({ diary: key, name: 'Cadeiras' }), [groupPost({ text: 'oi' })])
    C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Praia' }), links ? links(G) : [groupLink({ group: G, on: true })])
    return [groupJoinRecord({ group: G, writer: G, on: true }), groupJoinRecord({ group: C, writer: C, on: true })]
  })
  return { A, G, C }
}

function scanned (seeder, key, length) {
  return until(() => {
    const e = seeder._groupServed.get(key)
    return e && e.headerOk && e.core.contiguousLength === length && !e.rootScanning && e.rootScanned === length
  }, { name: 'raiz lida ' + key.slice(0, 8), timeoutMs: 30000 })
}

test('a community root is admitted from its creator\'s join; a link shows only while both sides name each other', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await scanned(seeder, C, 2)
  await scanned(seeder, G, 2)
  t.is(seeder.indexGroup(G).community, null, 'the community side alone is no link')
  const one = seeder.indexCommunity(C)
  t.is(one.name, 'Praia')
  t.alike(one.groups, [], 'nothing listed one way')

  const group = A.cores.group
  const community = A.cores.community
  await group.append(encode(communityLink({ community: C, on: true })))
  await until(() => seeder.indexGroup(G).community === C, { name: 'ligação nos dois lados' })
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.alike(seeder.indexCommunity(C).groups, [{ group: G, name: 'Cadeiras', members: 1 }])
  t.is(seeder.indexGroup(C).community, null, 'a community root names no community')

  await community.append(encode(groupLink({ group: G, on: false })))
  await until(() => seeder.indexGroup(G).community === null, { name: 'desligada no lado da comunidade' })
  t.alike(seeder.indexCommunity(C).groups, [])

  await community.append(encode(groupLink({ group: G, on: true })))
  await until(() => seeder.indexGroup(G).community === C, { name: 'religada' })
  await group.append(encode(communityLink({ community: C, on: false })))
  await until(() => seeder.indexGroup(G).community === null, { name: 'desligada no lado do grupo' })
  await scanned(seeder, G, 4)
  t.alike(seeder.indexCommunity(C).groups, [])
  t.is(seeder.indexCommunity('f'.repeat(64)), null, 'an unknown key once settled')
  t.is(seeder.indexCommunity(G), null, 'a group root is no community')
  t.is(seeder.indexCommunity('zz'), null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a blocked community root is purged, drops from the index and is not served', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await A.cores.group.append(encode(communityLink({ community: C, on: true })))
  await until(() => seeder.indexGroup(G).community === C, { name: 'ligação nos dois lados' })

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [C], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, C, 'group-blocked')
  await until(async () => seeder._drops.size === 0 && !(await stored(seeder, C)), { name: 'comunidade purgada' })
  t.is(seeder.indexCommunity(C), null, 'a blocked community answers nothing')
  t.is(seeder.indexGroup(G).community, null, 'and no group names it')
  t.ok(seeder._groupServed.has(G), 'the group stays')
  t.absent(seeder._groupServed.has(C), 'the community root is not served')
})

test('a hostile community root listing many groups is bounded by the fold\'s cap', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const bogus = Array.from({ length: MAX_GROUPS_PER_COMMUNITY + 8 }, (_, i) => i.toString(16).padStart(64, '0'))
  // The real group G comes after the cap is full: never listed.
  const { A, G, C } = await creator(t, bootstrap, assoc, {
    links: (G) => [...bogus.map((g) => groupLink({ group: g, on: true })), groupLink({ group: G, on: true })]
  })
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await A.cores.group.append(encode(communityLink({ community: C, on: true })))
  await scanned(seeder, C, bogus.length + 2)
  await scanned(seeder, G, 3)
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.alike(seeder.indexCommunity(C).groups, [], 'a link over the cap is ignored')
  t.is(seeder.indexGroup(G).community, null)

  // Unlinking one frees a slot for a later relink of G.
  await A.cores.community.append(encode(groupLink({ group: bogus[0], on: false })))
  await A.cores.community.append(encode(groupLink({ group: G, on: true })))
  await until(() => seeder.indexGroup(G).community === C, { name: 'G entra na vaga' })
  t.alike(seeder.indexCommunity(C).groups.map((r) => r.group), [G])
  t.is(hex(A.cores.community.key), C)
})

test('the groups channel pages a community root as its only writer, with its creator\'s binding seq', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  // B joins the community with a writer core naming C: never paged.
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: C, diary: key }), [groupPost({ text: 'intrusa' })])
    return [groupJoinRecord({ group: C, writer: W, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await scanned(seeder, C, 2)
  // A's diary: block 0 the certificate, then the joins for G (1) and C (2).
  await until(() => {
    const p = seeder.groupWriters({ group: C, after: null, limit: 64 })
    return p.items.length === 1 && !p.incomplete
  }, { name: 'página da comunidade', timeoutMs: 30000 })
  await until(() => seeder._groupServed.has(W) || events.some((e) => e.event === 'group-rejected' && e.key === W), { name: 'W decidido', timeoutMs: 30000 })
  const page = seeder.groupWriters({ group: C, after: null, limit: 64 })
  t.alike(page.items.map(({ key, diary, seq, length }) => ({ key, diary, seq, length })), [{ key: C, diary: A.key, seq: 2, length: 2 }], 'only the root, under its creator, at the binding seq')
  t.is(page.next, null)
  const gp = seeder.groupWriters({ group: G, after: null, limit: 64 })
  t.alike(gp.items.map((i) => [i.key, i.seq]), [[G, 1]], 'a group root pages as before')
})

// Makes the next read of block `index` of served root `key` fail once
// (answer null), as a missing local block does.
function failReadOnce (seeder, key, index) {
  const core = seeder._groupServed.get(key).core
  const get = core.get
  const state = { failed: false }
  core.get = function (i, opts) {
    if (i === index && !state.failed) {
      state.failed = true
      return Promise.resolve(null)
    }
    return get.call(this, i, opts)
  }
  return state
}

test('a failed root read is retried, keeps what was folded and holds both roots\' answers incomplete', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await scanned(seeder, C, 2)
  await scanned(seeder, G, 2)
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })

  // G's community-link cannot be read yet: C links G, G is served here and
  // has not folded its side, so C's answer is not complete.
  const g = failReadOnce(seeder, G, 2)
  await A.cores.group.append(encode(communityLink({ community: C, on: true })))
  await until(() => g.failed && !seeder._groupServed.get(G).rootScanning, { name: 'leitura de G falhou' })
  t.alike(seeder.indexCommunity(C).groups, [])
  t.absent(seeder.indexCommunity(C).complete, 'a linked group still folding keeps the community incomplete')
  t.absent(seeder.indexGroup(G).complete)
  await until(() => seeder.indexGroup(G).community === C && seeder.indexCommunity(C).complete, { name: 'G relida sem crescer' })
  t.alike(seeder.indexCommunity(C).groups, [{ group: G, name: 'Cadeiras', members: 1 }])

  // A writer of a listed group in admission may change writerCount.
  seeder._groupReserved.set('e'.repeat(64), G)
  t.absent(seeder.indexCommunity(C).complete, 'a listed group with a writer in admission is not settled')
  seeder._groupReserved.delete('e'.repeat(64))
  t.ok(seeder.indexCommunity(C).complete)

  // C's unlink cannot be read yet: G's answer names C until it is, and is
  // not complete meanwhile.
  t.ok(seeder.indexGroup(G).complete)
  const c = failReadOnce(seeder, C, 2)
  await A.cores.community.append(encode(groupLink({ group: G, on: false })))
  await until(() => c.failed && !seeder._groupServed.get(C).rootScanning, { name: 'leitura de C falhou' })
  t.is(seeder.indexGroup(G).community, C, 'a retry keeps the links already folded')
  t.absent(seeder.indexGroup(G).complete, 'the linked community still folding keeps the group incomplete')
  await until(() => seeder.indexGroup(G).community === null && seeder.indexGroup(G).complete, { name: 'C relida sem crescer' })
  t.alike(seeder.indexCommunity(C).groups, [])
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
