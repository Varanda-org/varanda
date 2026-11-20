'use strict'

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { Seeder } = require('../lib/seeder')
const cert = require('../lib/cert')
const { memberCertRecord, profileRecord, groupJoinRecord, mediaCoreRecord } = require('../lib/records')
const { groupMeta, groupImage, groupAbout } = require('../lib/group')
const { mediaHeader } = require('../lib/media')
const { signRoster, issuerCountersign } = require('../lib/page')
const { signClose, signMoved } = require('../lib/page-lifecycle')
const { testnet, until } = require('./helpers/net')
const {
  hex, makeAssociation, prepareSeederDir, startSeeder,
  groupHeader, encode, member, admit, admitted
} = require('./helpers/seeder-groups')

const AT = '2026-03-01T12:00:00.000Z'
const IMAGE = { core: 'da'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: 'db'.repeat(32), width: 512, height: 512 }

function association () {
  const assoc = makeAssociation()
  const kp = crypto.keyPair()
  const issuer = hex(kp.publicKey)
  return { ...assoc, issuer: { kp, hex: issuer, cert: cert.createIssuerCert({ issuer, date: AT }, assoc.kp) } }
}

function username (assoc, key, name = 'padaria_bairro') {
  return cert.createUsernameRecord({ member: key, username: name, date: AT }, assoc.issuer.kp, assoc.issuer.cert)
}

function pageRecord (assoc, key, owner, type = 'page-roster') {
  const fields = {
    type,
    page: key,
    gen: type === 'page-roster' ? 1 : 2,
    at: AT,
    nonce: 'r'.repeat(43),
    association: assoc.hex
  }
  let sign = signRoster
  if (type === 'page-roster') Object.assign(fields, { owner: hex(owner.publicKey), admins: [], prev: null })
  else {
    fields.actor = hex(owner.publicKey)
    sign = type === 'page-close' ? signClose : signMoved
    if (type === 'page-moved') fields.to = 'dc'.repeat(32)
  }
  return issuerCountersign({ ...fields, signature: sign(fields, owner) }, assoc.issuer.kp, assoc.issuer.cert)
}

function pageRecords (assoc, key, owner, avatar = IMAGE) {
  return [
    username(assoc, key),
    pageRecord(assoc, key, owner),
    profileRecord({ name: 'Padaria do Bairro', bio: 'Pão quente', avatar, at: AT })
  ]
}

function pageAnswer (author, avatar = IMAGE) {
  return { name: 'Padaria do Bairro', username: 'padaria_bairro', bio: 'Pão quente', avatar, author }
}

function memoryPage () {
  const assoc = association()
  const owner = crypto.keyPair()
  const author = hex(crypto.keyPair().publicKey)
  const records = [memberCertRecord(cert.createCert({ member: author }, assoc.kp)), ...pageRecords(assoc, author, owner)]
  const seeder = new Seeder({})
  seeder.association = assoc.hex
  const blocked = new Set()
  seeder._blocklist = { blocked: () => blocked, revokedIssuers: () => new Set() }
  const reads = []
  const core = {
    fork: 0,
    get length () { return records.length },
    async has (i) { return i < records.length },
    async get (i) { reads.push(i); return encode(records[i]) }
  }
  const entry = { core, gated: true, scanned: records.length, indexed: records.length, effective: new Set() }
  seeder._admitted.set(author, {})
  seeder._served.set(author, entry)
  for (let seq = 1; seq < records.length; seq++) {
    seeder._index.add(author, seq, records[seq])
    seeder._names.note(author, seq, records[seq])
  }
  seeder._names.settle(author)
  return { seeder, assoc, owner, author, records, entry, blocked, reads }
}

test('linkPublic reads a verified page by key and exact username, never a display-name match', async (t) => {
  const { seeder, author, reads } = memoryPage()
  t.alike(await seeder.linkPublic('m', author), pageAnswer(author))
  t.alike(await seeder.linkPublic('u', '@PADARIA_BAIRRO'), pageAnswer(author))
  t.alike(await seeder.linkPublic('u', 'padaria_bairro'), pageAnswer(author))
  t.alike([...new Set(reads)].sort(), [0, 1, 3], 'only certificate, username and profile blocks are read')
  const collision = 'bb'.repeat(32)
  seeder._names.note(collision, 1, profileRecord({ name: 'padaria_bairro' }))
  t.is((await seeder.linkPublic('u', 'padaria_bairro')).author, author)
  seeder._names.remove(author)
  t.is(await seeder.linkPublic('u', 'padaria_bairro'), null, 'a display-name collision alone never resolves')
  for (const value of [null, undefined, {}, Symbol('id'), 'missing', 'ff'.repeat(32)]) {
    t.is(await seeder.linkPublic('m', value), null)
    t.is(await seeder.linkPublic('g', value), null)
    t.is(await seeder.linkPublic('c', value), null)
  }
  for (const value of ['@@padaria_bairro', ' padaria_bairro', 'padaria_bairro ', 'padaria-bairro', 'pa', '1padaria', 'ááá', 'a'.repeat(21)]) {
    t.is(await seeder.linkPublic('u', value), null)
  }
  t.is(await seeder.linkPublic('unknown', author), null)
})

test('linkPublic pages fail closed before reading and after each awaited record', async (t) => {
  const changes = {
    blocked: ({ blocked, author }) => blocked.add(author),
    dropped: ({ entry }) => { entry.dropped = true },
    ungated: ({ entry }) => { entry.gated = false },
    held: ({ entry }) => { entry.searchHold = 1 },
    unscanned: ({ entry }) => { entry.scanned-- },
    unindexed: ({ entry }) => { entry.indexed-- },
    paused: ({ entry }) => { entry.indexPaused = true },
    removed: ({ seeder, author }) => seeder._served.delete(author),
    servedAgain: ({ seeder, author, entry }) => seeder._served.set(author, { ...entry }),
    deleted: ({ entry }) => entry.effective.add(3),
    renamed: ({ seeder, author }) => seeder._index.add(author, 4, profileRecord({ name: 'Outra' })),
    appended: ({ records, entry }) => { records.push(profileRecord({ name: 'Outra' })); entry.scanned++; entry.indexed++ },
    closed: ({ seeder, assoc, author, owner }) => seeder._names.note(author, 4, pageRecord(assoc, author, owner, 'page-close')),
    moved: ({ seeder, assoc, author, owner }) => seeder._names.note(author, 4, pageRecord(assoc, author, owner, 'page-moved')),
    unverifiedEnd: ({ seeder, assoc, author, owner }) => seeder._names.note(author, 4, { ...pageRecord(assoc, author, owner, 'page-close'), countersignature: '00'.repeat(64) }),
    person: ({ seeder, author }) => seeder._names.remove(author)
  }
  for (const [name, change] of Object.entries(changes)) {
    if (name !== 'appended' && name !== 'servedAgain') {
      const before = memoryPage()
      change(before)
      t.is(await before.seeder.linkPublic('m', before.author), null, name + ' before reading')
      if (name !== 'renamed') t.is(before.reads.length, 0, name + ' reads nothing')
    }
    for (const seq of [3, 1]) {
      const f = memoryPage()
      const read = f.seeder._liveRecord.bind(f.seeder)
      const calls = []
      f.seeder._liveRecord = async (author, at) => {
        calls.push(at)
        const record = await read(author, at)
        if (at === seq) change(f)
        return record
      }
      t.is(await f.seeder.linkPublic('m', f.author), null, name + ' during read ' + seq)
      if (seq === 3) t.alike(calls, [3], name + ' stops before the next read')
    }
  }
})

test('linkPublic usernames require current verification and a stable reverse mapping', async (t) => {
  for (const seq of [3, 1]) {
    const f = memoryPage()
    const read = f.seeder._liveRecord.bind(f.seeder)
    f.seeder._liveRecord = async (author, at) => {
      const record = await read(author, at)
      if (at === seq) f.seeder._names.note(author, 4, username(f.assoc, author, 'outro_nome'))
      return record
    }
    t.is(await f.seeder.linkPublic('u', '@padaria_bairro'), null, 'mapping changed during read ' + seq)
  }
  const f = memoryPage()
  f.seeder._certOpts = () => ({ revokedIssuers: new Set([f.assoc.issuer.hex]) })
  t.is(await f.seeder.linkPublic('u', 'padaria_bairro'), null, 'revoked issuer never resolves')
  t.alike(await f.seeder.linkPublic('m', f.author), { ...pageAnswer(f.author), username: null })
  f.seeder._certOpts = () => ({})
  f.records[1] = username(association(), f.author)
  f.seeder._names.remove(f.author)
  f.seeder._names.note(f.author, 1, f.records[1])
  f.seeder._names.note(f.author, 2, f.records[2])
  f.seeder._names.settle(f.author)
  t.is(await f.seeder.linkPublic('u', 'padaria_bairro'), null, 'untrusted issuer never resolves')
  t.alike(await f.seeder.linkPublic('m', f.author), { ...pageAnswer(f.author), username: null })
  f.seeder._liveRecord = async () => { throw new Error('read failed') }
  t.is(await f.seeder.linkPublic('m', f.author), null, 'a read error never escapes')
})

test('linkPublic groups use only verified bound public headers and settled root metadata', async (t) => {
  const seeder = new Seeder({})
  const author = 'aa'.repeat(32)
  const root = 'bb'.repeat(32)
  const blocked = new Set()
  seeder._blocklist = { blocked: () => blocked }
  seeder._served.set(author, { gated: true, core: { length: 1 }, scanned: 1 })
  const forbidden = () => { throw new Error('membership or content read') }
  seeder.indexGroup = seeder.indexCommunity = seeder._groupIndex.page = forbidden
  for (const [kind, headerKind] of [['g', 'group'], ['c', 'community']]) {
    const header = groupHeader({ kind: headerKind, diary: author, name: 'Praia' })
    seeder._groupIndex.setHeader(root, header)
    seeder._groupIndex.addWriter(root, root, author, 1)
    const entry = { group: root, headerOk: true, rootScanned: 1, cut: null, core: { length: 1, contiguousLength: 1, get: forbidden } }
    seeder._groupServed.set(root, entry)
    t.alike(await seeder.linkPublic(kind, root), { name: 'Praia', image: null, author, about: null })
    seeder._groupIndex.foldRoot(root, groupImage({ image: IMAGE }))
    t.alike(await seeder.linkPublic(kind, root), { name: 'Praia', image: IMAGE, author, about: null })
    seeder._groupIndex.foldRoot(root, groupAbout({ about: 'Quem gosta de praia' }))
    t.alike(await seeder.linkPublic(kind, root), { name: 'Praia', image: IMAGE, author, about: 'Quem gosta de praia' })
    t.is(await seeder.linkPublic(kind === 'g' ? 'c' : 'g', root), null, 'kind must match')
    if (kind === 'g') {
      seeder._groupIndex.foldRoot(root, groupMeta({ name: 'Nova Praia', join: 'open' }))
      t.is((await seeder.linkPublic(kind, root)).name, 'Nova Praia', 'the indexed rename wins')
    }
    entry.headerOk = false
    t.is(await seeder.linkPublic(kind, root), null, 'unverified header')
    entry.headerOk = true
    entry.rootScanned = 0
    t.is(await seeder.linkPublic(kind, root), null, 'root scan behind')
    entry.rootScanned = 1
    entry.core.length = 2
    t.is(await seeder.linkPublic(kind, root), null, 'signed length ahead of the local prefix')
    entry.core.length = 1
    entry.rootScanning = true
    t.is(await seeder.linkPublic(kind, root), null, 'root scan running')
    entry.rootScanning = false
    for (const key of [root, author]) {
      blocked.add(key)
      t.is(await seeder.linkPublic(kind, root), null, 'blocked ' + key.slice(0, 2))
      blocked.delete(key)
    }
    seeder._groupIndex.removeWriter(root)
    t.is(await seeder.linkPublic(kind, root), null, 'the header diary must bind the root')
    seeder._groupIndex.addWriter(root, root, author, 1)
    seeder._groupIndex.foldRoot(root, groupImage({ image: null }))
    t.is((await seeder.linkPublic(kind, root)).image, null, 'an image clear wins')
    seeder._groupIndex.foldRoot(root, groupAbout({ about: null }))
    t.is((await seeder.linkPublic(kind, root)).about, null, 'a description clear wins')
    seeder._groupIndex.removeGroup(root)
  }
  seeder._groupIndex.setHeader(root, groupHeader({ diary: author, visibility: 'private', join: 'approval', name: null, box: 'ee'.repeat(32) }))
  seeder._groupIndex.addWriter(root, root, author, 1)
  t.absent(seeder._groupIndex.foldRoot(root, groupAbout({ about: 'SENTINELA' })), 'a private root folds no description')
  t.is(await seeder.linkPublic('g', root), null, 'private group')
  t.is(seeder.groupAboutPublic(root), null, 'private group description')
})

for (const [kind, headerKind] of [['c', 'community'], ['g', 'group']]) {
  test('linkPublic uses the current ' + headerKind + ' name after rename and clear', async (t) => {
    const seeder = new Seeder({})
    const author = 'aa'.repeat(32)
    const root = 'bb'.repeat(32)
    seeder._served.set(author, { gated: true, core: { length: 1 }, scanned: 1 })
    seeder._groupServed.set(root, { group: root, headerOk: true, rootScanned: 1, cut: null, core: { length: 1, contiguousLength: 1 } })
    seeder._groupIndex.setHeader(root, groupHeader({ kind: headerKind, diary: author, name: 'Praia' }))
    seeder._groupIndex.addWriter(root, root, author, 1)
    for (const name of ['Nova Praia', null]) {
      seeder._groupIndex.foldRoot(root, groupMeta({ name, join: 'open' }))
      const indexedName = kind === 'c' ? seeder._groupIndex.community(root).name : seeder._groupIndex.nameOf(root)
      t.is(indexedName, name, 'the index reflects the metadata')
      t.alike(await seeder.linkPublic(kind, root), { name, image: null, author, about: null }, 'the preview matches the index')
    }
  })
}

async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assoc = association()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  return { bootstrap, assoc, seeder, events }
}

function settled (seeder, m) {
  return until(() => {
    const e = seeder._served.get(m.key)
    return e && !e.scanQueued && e.scanned >= m.diary.length && e.indexed >= m.diary.length
  }, { name: 'diário indexado' })
}

function rootScanned (seeder, root, length) {
  return until(() => {
    const e = seeder._groupServed.get(root)
    return e && e.headerOk && !e.rootScanning && e.rootScanned === length && e.core.contiguousLength === length
  }, { name: 'raiz indexada' })
}

test('linkPublic replicated public groups and communities with and without images; private and blocked roots stay hidden', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder, events } = await setup(t)
  let G, C, P
  const m = await member(t, bootstrap, assoc, async ({ key, make }) => {
    C = await make('community', groupHeader({ kind: 'community', diary: key, name: 'Praia' }))
    G = await make('group', groupHeader({ diary: key, community: C, member: C, name: 'Cadeiras' }))
    P = await make('private', groupHeader({ diary: key, visibility: 'private', join: 'approval', name: null, box: 'ee'.repeat(32) }))
    return [C, G, P].map(group => groupJoinRecord({ group, writer: group, on: true }))
  })
  await admit(m, assoc)
  for (const root of [C, G, P]) await admitted(events, root)
  await settled(seeder, m)
  for (const [kind, root, core, name] of [['g', G, m.cores.group, 'Cadeiras'], ['c', C, m.cores.community, 'Praia']]) {
    await rootScanned(seeder, root, core.length)
    t.alike(await seeder.linkPublic(kind, root), { name, image: null, author: m.key, about: null })
    await core.append(encode(groupImage({ image: IMAGE })))
    await rootScanned(seeder, root, core.length)
    t.alike(await seeder.linkPublic(kind, root), { name, image: IMAGE, author: m.key, about: null })
    await core.append(encode(groupAbout({ about: 'Sobre ' + name })))
    await rootScanned(seeder, root, core.length)
    t.alike(await seeder.linkPublic(kind, root), { name, image: IMAGE, author: m.key, about: 'Sobre ' + name }, 'a replicated description passes the byte and record filters')
    const isBlocked = seeder._isBlocked
    seeder._isBlocked = key => key === root || isBlocked.call(seeder, key)
    t.is(await seeder.linkPublic(kind, root), null)
    seeder._isBlocked = isBlocked
  }
  await m.cores.private.append(encode(groupAbout({ about: 'SENTINELA' })))
  t.is(await seeder.linkPublic('g', P), null)
  t.is(seeder.groupAboutPublic(P), null)
  t.absent(JSON.stringify(seeder.indexGroupAbouts([C, G, P])).includes('SENTINELA'), 'a private description never appears')
  t.is(await seeder.linkPublic('g', 'ff'.repeat(32)), null)
})

test('linkPublic replicated pages carry the diary author for media and stop at a close or move', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  for (const end of ['page-close', 'page-moved']) {
    const owner = crypto.keyPair()
    let avatar
    const m = await member(t, bootstrap, assoc, async ({ key, make }) => {
      const media = await make('media', mediaHeader({ diary: key }))
      avatar = { ...IMAGE, core: media }
      return [...pageRecords(assoc, key, owner, avatar), mediaCoreRecord({ key: media, at: AT })]
    })
    await admit(m, assoc)
    await settled(seeder, m)
    await until(() => seeder._media.get(avatar.core)?.diary === m.key, { name: 'mídia vinculada ao diário' })
    t.alike(await seeder.linkPublic('m', m.key), pageAnswer(m.key, avatar))
    t.alike(await seeder.linkPublic('u', '@PADARIA_BAIRRO'), pageAnswer(m.key, avatar))
    await m.diary.append(pageRecord(assoc, m.key, owner, end))
    await settled(seeder, m)
    t.is(await seeder.linkPublic('m', m.key), null, end)
    t.is(await seeder.linkPublic('u', 'padaria_bairro'), null, end)
  }
  const person = await member(t, bootstrap, assoc, ({ key }) => [username(assoc, key, 'pessoa'), profileRecord({ name: 'Pessoa' })])
  await admit(person, assoc)
  await settled(seeder, person)
  t.is(await seeder.linkPublic('m', person.key), null)
  t.is(await seeder.linkPublic('u', '@pessoa'), null)
  const owner = crypto.keyPair()
  const other = association()
  const bad = await member(t, bootstrap, assoc, ({ key }) => [
    username(other, key, 'nao_verificado'), pageRecord(assoc, key, owner), profileRecord({ name: 'Outra Página' })
  ])
  await admit(bad, assoc)
  await settled(seeder, bad)
  t.is(await seeder.linkPublic('u', 'nao_verificado'), null)
  t.alike(await seeder.linkPublic('m', bad.key), { name: 'Outra Página', username: null, bio: '', avatar: null, author: bad.key })
})
