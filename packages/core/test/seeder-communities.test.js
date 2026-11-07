// Community roots at the seeder (docs/protocol.md section 10, "Protocol v2
// admission and scan"): a community root is admitted like a group root,
// from its creator diary's join { group: C, writer: C, on: true }; a group
// header names its parent community; the index folds the root's group-meta
// and group-create records. Only the community's creator creates groups: a
// group is attached while its header diary is C's creator and C's root
// holds a create for it. Community writers (CWs) are paged, never scanned.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord, MAX_GROUPS_PER_COMMUNITY } = require('../lib/records')
const { groupPost, groupCreateRecord, groupAdmin } = require('../lib/group')
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
  moderator,
  downloaded,
  readFile,
  readGroups,
  groupHeader,
  writerHeader
} = require('./helpers/seeder-groups')

// Creator A: community root C and group root G whose header names C (the
// creator device's CW is C itself). C's creates are appended by the test
// once both keys exist (`create`, default on).
async function creator (t, bootstrap, assoc, { create = true } = {}) {
  let G = null
  let C = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Praia' }))
    G = await make('group', groupHeader({ diary: key, community: C, member: C, name: 'Cadeiras' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: G, writer: G, on: true }), groupJoinRecord({ group: C, writer: C, on: true })]
  })
  if (create) await A.cores.community.append(encode(groupCreateRecord({ group: G })))
  return { A, G, C }
}

function scanned (seeder, key, length) {
  return until(() => {
    const e = seeder._groupServed.get(key)
    return e && e.headerOk && e.core.contiguousLength === length && !e.rootScanning && e.rootScanned === length
  }, { name: 'núcleo lido ' + key.slice(0, 8), timeoutMs: 30000 })
}

test('a community root is admitted from its creator\'s join; a group is attached once C\'s root creates it', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc, { create: false })
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await scanned(seeder, C, 1)
  await until(() => seeder.indexCommunity(C).complete && seeder.indexGroup(G).complete, { name: 'respostas completas' })
  const before = seeder.indexGroup(G)
  t.is(before.community, C, 'the header names its parent')
  t.is(before.attached, false, 'a header alone is no catalogue entry')
  t.alike(seeder.indexCommunity(C), { name: 'Praia', join: 'open', creator: A.key, members: 1, groups: [], next: null, indexing: false, complete: true })

  await A.cores.community.append(encode(groupCreateRecord({ group: G })))
  await until(() => seeder.indexGroup(G).attached, { name: 'G no catálogo' })
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.alike(seeder.indexCommunity(C).groups, [{ group: G, visibility: 'public', join: 'open', name: 'Cadeiras', writerCount: 1 }])
  const cg = seeder.indexGroup(C)
  t.is(cg.community, null, 'a community root names no community')
  t.is(cg.attached, false)
  t.alike(seeder.indexCommunityGroups(C, G), { groups: [], next: null, indexing: false, complete: true }, 'nothing after the last key')
  t.is(seeder.indexCommunity('f'.repeat(64)), null, 'an unknown key once settled')
  t.is(seeder.indexCommunity(G), null, 'a group root is no community')
  t.is(seeder.indexCommunity('zz'), null)
  t.is(seeder.indexCommunityGroups(C, 'zz'), null)
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
  await until(() => seeder.indexGroup(G).attached, { name: 'G no catálogo' })

  const mod = moderator(assoc)
  const snapshot = createSnapshot({ seq: 1, blocked: [C], revokedIssuers: [] }, mod.kp, mod.cert)
  await reader(t, bootstrap, publicKey, { blocklist: snapshot })
  await rejected(events, C, 'group-blocked')
  await until(async () => seeder._drops.size === 0 && !(await stored(seeder, C)), { name: 'comunidade purgada' })
  t.is(seeder.indexCommunity(C), null, 'a blocked community answers nothing')
  t.is(seeder.indexCommunityGroups(C, G), null)
  t.is(seeder.indexGroup(G).attached, false, 'and no group is attached to it')
  t.ok(seeder._groupServed.has(G), 'the group stays')
  t.absent(seeder._groupServed.has(C), 'the community root is not served')
})

test('a hostile community root creating many groups is bounded to 32 creates', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const bogus = Array.from({ length: MAX_GROUPS_PER_COMMUNITY + 8 }, (_, i) => i.toString(16).padStart(64, '0'))
  // The real group G is created after the root's share is full: never listed.
  const { A, G, C } = await creator(t, bootstrap, assoc, { create: false })
  for (const g of bogus) await A.cores.community.append(encode(groupCreateRecord({ group: g })))
  await A.cores.community.append(encode(groupCreateRecord({ group: G })))
  await admit(A, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await scanned(seeder, C, bogus.length + 2)
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.alike(seeder.indexCommunity(C).groups, [], 'a create over the cap is ignored; bogus keys have no header here')
  t.is(seeder.indexGroup(G).attached, false)
  t.is(seeder._groupIndex.createdIn(C).length, MAX_GROUPS_PER_COMMUNITY)
  t.is(hex(A.cores.community.key), C)
})

test('the groups channel pages a community root and its community writers, each at its binding seq', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  // B joins the community with a CW (member: null).
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: C, diary: key, member: null }))
    return [groupJoinRecord({ group: C, writer: W, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, G)
  await admitted(events, C)
  await admitted(events, W)
  await until(() => {
    const p = seeder.groupWriters({ group: C, after: null, limit: 64 })
    return p.items.length === 2 && !p.incomplete
  }, { name: 'página da comunidade', timeoutMs: 30000 })
  const page = seeder.groupWriters({ group: C, after: null, limit: 64 })
  // A's diary: block 0 the certificate, then the joins for G (1) and C (2).
  const want = [{ key: C, diary: A.key, seq: 2 }, { key: W, diary: B.key, seq: 1 }].sort((a, b) => a.key < b.key ? -1 : 1)
  t.alike(page.items.map(({ key, diary, seq }) => ({ key, diary, seq })), want, 'the root under its creator and the CW under its diary')
  t.is(page.next, null)
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.is(seeder.indexCommunity(C).members, 2, 'the bound creator and B')
  const gp = seeder.groupWriters({ group: G, after: null, limit: 64 })
  t.alike(gp.items.map((i) => [i.key, i.seq]), [[G, 1]], 'a group root pages as before')
})

test('only the creator\'s groups are listed: a CW create, an admin\'s group and a demoted admin\'s are not', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  // B: CW W in C and group H whose header names C and W; W creates H.
  let W = null
  let H = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: C, diary: key, member: null }))
    H = await make('h', groupHeader({ diary: key, community: C, member: W, name: 'Quiosque' }))
    return [groupJoinRecord({ group: C, writer: W, on: true }), groupJoinRecord({ group: H, writer: H, on: true })]
  })
  await B.cores.w.append(encode(groupCreateRecord({ group: H })))
  await admit(A, assoc)
  await admit(B, assoc)
  for (const k of [G, C, W, H]) await admitted(events, k)
  await downloaded(seeder, W, 2)
  await until(() => seeder.indexCommunity(C).complete && seeder.indexGroup(H).complete, { name: 'respostas completas' })
  t.alike(seeder.indexCommunity(C).groups.map((r) => r.group), [G], 'a CW create is not listed; the creator\'s root create is')
  t.is(seeder.indexGroup(H).attached, false)
  t.is(seeder._groupServed.get(W).rootScanned, 0, 'a CW is never scanned')

  await A.cores.community.append(encode(groupAdmin({ member: B.key, on: true, cuts: [{ writer: W, seq: 2 }] })))
  await A.cores.community.append(encode(groupCreateRecord({ group: H })))
  await scanned(seeder, C, 4)
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.absent(seeder.indexGroup(H).attached, 'an admin\'s group is not listed, even with a root create')
  t.alike(seeder.indexCommunity(C).groups.map((r) => r.group), [G])
  await A.cores.community.append(encode(groupAdmin({ member: B.key, on: false, cuts: [{ writer: W, seq: 2 }] })))
  await scanned(seeder, C, 5)
  t.absent(seeder.indexGroup(H).attached, 'nor a demoted admin\'s')
  t.ok(seeder.indexGroup(G).attached)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// Makes the next read of block `index` of served core `key` fail once
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

test('a failed root read is retried, keeps what was folded and holds the answers incomplete; a CW is never read', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc, { create: false })
  // A's second device: CW W in C (paged, never scanned for creates).
  let W = null
  const A2 = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: C, diary: key, member: null }))
    return [groupJoinRecord({ group: C, writer: W, on: true })]
  })
  await admit(A, assoc)
  await admit(A2, assoc)
  for (const k of [G, C, W]) await admitted(events, k)
  await scanned(seeder, C, 1)
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })

  // C's create of G cannot be read yet: G's answer waits for its parent.
  const c = failReadOnce(seeder, C, 1)
  await A.cores.community.append(encode(groupCreateRecord({ group: G })))
  await until(() => c.failed && !seeder._groupServed.get(C).rootScanning, { name: 'leitura de C falhou' })
  t.is(seeder.indexGroup(G).attached, false)
  t.absent(seeder.indexGroup(G).complete, 'the parent still folding keeps the group incomplete')
  t.absent(seeder.indexCommunity(C).complete)
  await until(() => seeder.indexGroup(G).attached && seeder.indexGroup(G).complete, { name: 'C relida sem crescer' })

  // A listed group with a writer in admission may change writerCount.
  seeder._groupReserved.set('e'.repeat(64), G)
  t.absent(seeder.indexCommunity(C).complete, 'a listed group with a writer in admission is not settled')
  seeder._groupReserved.delete('e'.repeat(64))
  t.ok(seeder.indexCommunity(C).complete)

  // A CW's records are never read: its growth holds nothing back.
  const w = failReadOnce(seeder, W, 1)
  await A2.cores.w.append(encode(groupCreateRecord({ group: G })))
  await downloaded(seeder, W, 2)
  t.absent(w.failed, 'the CW block is not read')
  t.ok(seeder.indexCommunity(C).complete, 'a CW never keeps the community incomplete')
  t.ok(seeder.indexGroup(G).attached, 'what the root folded stays')
  t.is(seeder._groupServed.get(W).rootScanned, 0)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('version 1 headers: a root and a writer are header-invalid at admission and purged at startup', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc)
  const v1 = (h) => ({ ...h, v: 1 })
  let R1 = null
  let W1 = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R1 = await make('r1', v1(groupHeader({ diary: key, name: 'Antiga' })))
    W1 = await make('w1', v1(writerHeader({ group: G, diary: key })))
    return [groupJoinRecord({ group: R1, writer: R1, on: true }), groupJoinRecord({ group: G, writer: W1, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(first.events, G)
  await admitted(first.events, C)
  await rejected(first.events, R1, 'header-invalid')
  await rejected(first.events, W1, 'header-invalid')
  t.absent(first.seeder._groupServed.has(R1))
  t.absent(first.seeder._groupServed.has(W1))

  // Cores stored by an older seeder: version 1 blocks 0 in the seeder's own
  // store, listed in admitted.json under B's surviving diary.
  const make = async (header) => {
    const core = first.seeder.store.get({ keyPair: signingKeyPair() })
    await core.ready()
    await core.append(encode(header))
    const key = hex(core.key)
    await core.close()
    return key
  }
  const oldRoot = await make(v1(groupHeader({ diary: B.key, name: 'Velha' })))
  const oldWriter = await make(v1(writerHeader({ group: G, diary: B.key })))
  await first.seeder.close()
  const file = readFile(dataDir)
  file.groups[oldRoot] = { diary: B.key, group: oldRoot, seq: 1, by: B.key }
  file.groups[oldWriter] = { diary: B.key, group: G, seq: 2 }
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await rejected(second.events, oldRoot, 'header-invalid')
  await rejected(second.events, oldWriter, 'header-invalid')
  t.absent(oldRoot in readGroups(dataDir), 'the v1 root is no longer listed')
  t.absent(oldWriter in readGroups(dataDir), 'nor the v1 writer')
  t.absent(await stored(second.seeder, oldRoot), 'and both are purged')
  t.absent(await stored(second.seeder, oldWriter))
  t.ok(G in readGroups(dataDir), 'a v2 root stays')
  t.is(second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root create read while the community root is gone is folded once the root is served again', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, G, C } = await creator(t, bootstrap, assoc, { create: false })
  await admit(A, assoc)
  for (const k of [G, C]) await admitted(events, k)
  await scanned(seeder, C, 1)

  // C's read of its create hangs while C's header leaves the index (as
  // _dropGroup does), then lands with no header to fold into.
  const core = seeder._groupServed.get(C).core
  const get = core.get
  let release = null
  const held = new Promise((resolve) => { release = resolve })
  let reading = false
  core.get = async function (i, opts) {
    if (i === 1) {
      reading = true
      await held
    }
    return get.call(this, i, opts)
  }
  await A.cores.community.append(encode(groupCreateRecord({ group: G })))
  await until(() => reading, { name: 'C lendo o create' })
  const header = groupHeader({ kind: 'community', diary: A.key, name: 'Praia' })
  seeder._groupIndex.setHeader(C, null)
  release()
  await until(() => !seeder._groupServed.get(C).rootScanning, { name: 'leitura de C terminou' })
  t.is(seeder._groupIndex.createdIn(C).length, 0, 'refused while C had no header')

  // C's root is served again: a new entry, scanned from the start.
  seeder._groupIndex.setHeader(C, header)
  const root = seeder._groupServed.get(C)
  root.rootScanned = 0
  seeder._scanRoot(C, root)
  await until(() => seeder.indexGroup(G).attached, { name: 'G no catálogo de novo' })
  await until(() => seeder.indexCommunity(C).complete, { name: 'comunidade completa' })
  t.alike(seeder.indexCommunity(C).groups.map((r) => r.group), [G], 'the create is listed')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
