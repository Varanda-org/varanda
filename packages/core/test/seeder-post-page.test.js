'use strict'

// The seeder's public share gate for a PAGE diary (packages/core/lib/seeder.js
// postPublic): a page's shared post is shown like a person's, with the
// page's display name and its @nome verified as a person's, and every null
// of the person's gate still holds; a closed page answers null
// (docs/protocol.md section 2, "Public share", and section 16).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const cert = require('../lib/cert')
const { createCert, createSeederCert, generateAssociationKeyPair } = cert
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../lib/net')
const { memberCertRecord, postRecord, profileRecord, deleteRecord, postShareRecord } = require('../lib/records')
const { signRoster, issuerCountersign } = require('../lib/page')
const { signClose, signMoved } = require('../lib/page-lifecycle')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeIssuer (kp) {
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: hex(issuerKp.publicKey), date: at(0) }, kp)
  return { issuerKp, issuerCert }
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey), ...makeIssuer(kp) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
}

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
function at (i) {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function post (text, i) {
  return postRecord({ text, at: at(i) })
}

function share (seq, i) {
  return postShareRecord({ seq, at: at(i) })
}

function del (seq, i) {
  return deleteRecord({ seq, at: at(i) })
}

const nonce = (c) => c.repeat(43)

// The genesis roster of page `pageKey`, signed by its owner and countersigned
// by an issuer of the association (lib/page.js), as the account service
// writes it at seq 2, after the page's @nome at seq 1 (docs/protocol.md
// section 12).
function roster (assoc, pageKey, ownerKp, i) {
  const fields = { type: 'page-roster', page: pageKey, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: at(i), nonce: nonce('r'), association: assoc.hex }
  return issuerCountersign({ ...fields, signature: signRoster(fields, ownerKp) }, assoc.issuerKp, assoc.issuerCert)
}

function close (assoc, pageKey, ownerKp, i, issuer = assoc) {
  const fields = { type: 'page-close', page: pageKey, gen: 2, at: at(i), nonce: nonce('c'), actor: hex(ownerKp.publicKey), association: assoc.hex }
  return issuerCountersign({ ...fields, signature: signClose(fields, ownerKp) }, issuer.issuerKp, issuer.issuerCert)
}

function moved (assoc, pageKey, ownerKp, i) {
  const fields = { type: 'page-moved', page: pageKey, to: hex(crypto.keyPair().publicKey), gen: 2, at: at(i), nonce: nonce('m'), actor: hex(ownerKp.publicKey), association: assoc.hex }
  return issuerCountersign({ ...fields, signature: signMoved(fields, ownerKp) }, assoc.issuerKp, assoc.issuerCert)
}

// A @nome for `key` signed by `issuerKp` under `issuerCert`: the account
// service certifies a page's @nome exactly like a person's.
function usernameFor (key, username, issuerKp, issuerCert) {
  return cert.createUsernameRecord({ member: key, username, date: at(0) }, issuerKp, issuerCert)
}

// A diary on the swarm. `records(key)` follow block 0.
async function diaryOf (t, bootstrap, assoc, records) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  for (const r of records(key)) await diary.append(r)

  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, diary, key, swarm, peers, messages, seederPeer, message }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

async function append (m, records) {
  for (const r of records) await m.diary.append(r)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

function settled (seeder, m) {
  return until(() => {
    const entry = seeder._served.get(m.key)
    const length = m.diary.length
    return entry && !entry.scanQueued && entry.scanned >= length && entry.indexed >= length
  }, { name: 'diário processado até ' + m.diary.length })
}

async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {}, associationKey: assoc.hex })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { bootstrap, assoc, seeder }
}

test('postPublic shows a page post with a live share, its name and verified @nome, and null once withdrawn, deleted, unindexed or closed', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const ownerKp = crypto.keyPair()
  const P = await diaryOf(t, bootstrap, assoc, (key) => [
    usernameFor(key, 'padaria_bairro', assoc.issuerKp, assoc.issuerCert), // 1
    roster(assoc, key, ownerKp, 2), // 2
    profileRecord({ name: 'Padaria do Bairro', at: at(3) }), // 3
    post('pão quente', 4), // 4
    post('bolo', 5), // 5
    post('café', 6), // 6
    share(4, 7), // 7
    share(5, 8), // 8
    share(6, 9), // 9
    share(2, 10) // 10: names the roster, not a post
  ])
  await admit(P, assoc)
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).page, true, 'the seeder knows the diary as a page')

  const got = await seeder.postPublic(P.key, 4)
  t.ok(got, 'a page post with a live share is shown')
  t.is(got.record.type, 'post')
  t.is(got.record.text, 'pão quente')
  t.is(got.name, 'Padaria do Bairro')
  t.is(got.username, 'padaria_bairro', 'the page @nome, verified as a person\'s')
  t.is(got.shareSeq, 7)
  t.alike(Object.keys(got).sort(), ['cover', 'coverSeq', 'name', 'record', 'shareSeq', 'username'], 'the same answer shape as a person\'s')
  t.is((await seeder.postPublic(P.key, 5)).shareSeq, 8)
  t.is((await seeder.postPublic(P.key, 6)).shareSeq, 9)
  t.is(await seeder.postPublic(P.key, 2), null, 'a live share naming the roster block')
  t.is(await seeder.postPublic(P.key, 1), null, 'the @nome block, never shared')

  // The issuer of the page @nome revoked: the post stays, the @nome goes.
  const certOpts = seeder._certOpts
  seeder._certOpts = () => ({ ...(certOpts.call(seeder) || {}), revokedIssuers: new Set([assoc.issuerCert.issuer]) })
  const revoked = await seeder.postPublic(P.key, 4)
  seeder._certOpts = certOpts
  t.is(revoked.username, null, 'a revoked issuer drops the page @nome')
  t.is(revoked.name, 'Padaria do Bairro')

  // The name index has not read the whole page: a close it has not seen
  // yet could be there, so nothing is shown and no block is read.
  const entry = seeder._served.get(P.key)
  const indexed = entry.indexed
  const liveRecord = seeder._liveRecord
  let reads = 0
  seeder._liveRecord = function (...args) {
    reads++
    return liveRecord.apply(this, args)
  }
  entry.indexed = entry.core.length - 1
  t.is(await seeder.postPublic(P.key, 6), null, 'a page whose name index is behind')
  t.is(reads, 0, 'refused before reading any block')
  seeder._liveRecord = liveRecord
  entry.indexed = indexed
  entry.indexPaused = true
  t.is(await seeder.postPublic(P.key, 6), null, 'a page whose name index is paused')
  entry.indexPaused = false
  t.is((await seeder.postPublic(P.key, 6)).shareSeq, 9, 'shown again once indexed')

  await append(P, [del(7, 11)]) // 11
  await settled(seeder, P)
  t.is(await seeder.postPublic(P.key, 4), null, 'the page share tombstoned')

  await append(P, [del(5, 12)]) // 12
  await settled(seeder, P)
  t.is(await seeder.postPublic(P.key, 5), null, 'the page post deleted under a live share')
  t.is((await seeder.postPublic(P.key, 6)).shareSeq, 9, 'another page post keeps its share')

  await append(P, [close(assoc, P.key, ownerKp, 13)]) // 13
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).closed, true, 'the close was indexed')
  t.is(await seeder.postPublic(P.key, 6), null, 'a closed page shows nothing')
})

test('postPublic never shows a page @nome that does not verify', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const ownerKp = crypto.keyPair()
  // An issuer delegated by another association: shape-valid, never trusted.
  const other = makeAssociation()
  const P = await diaryOf(t, bootstrap, assoc, (key) => [
    usernameFor(key, 'feira_livre', other.issuerKp, other.issuerCert), // 1
    roster(assoc, key, ownerKp, 2), // 2
    profileRecord({ name: 'Feira Livre', at: at(3) }), // 3
    post('banca nova', 4), // 4
    share(4, 5) // 5
  ])
  await admit(P, assoc)
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).page, true, 'the seeder knows the diary as a page')

  const got = await seeder.postPublic(P.key, 4)
  t.ok(got, 'the shared page post is shown')
  t.is(got.name, 'Feira Livre')
  t.is(got.username, null, 'an @nome from an untrusted issuer is dropped')
  t.is(got.shareSeq, 5)
})

test('postPublic answers null for a page ended by a countersigned page-moved', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const ownerKp = crypto.keyPair()
  const P = await diaryOf(t, bootstrap, assoc, (key) => [
    usernameFor(key, 'mudanca', assoc.issuerKp, assoc.issuerCert), // 1
    roster(assoc, key, ownerKp, 2), // 2
    post('de mudança', 3), // 3
    share(3, 4) // 4
  ])
  await admit(P, assoc)
  await settled(seeder, P)
  t.is((await seeder.postPublic(P.key, 3)).shareSeq, 4, 'shown while the page is open')

  await append(P, [moved(assoc, P.key, ownerKp, 5)]) // 5
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).moved, true, 'the move was indexed')
  t.is(await seeder.postPublic(P.key, 3), null, 'a moved page shows nothing on its old key')
})

test('postPublic stays null for a page closed by an issuer revoked later, after the name index is rebuilt', async (t) => {
  t.timeout(120000)
  const { bootstrap, assoc, seeder } = await setup(t)
  const ownerKp = crypto.keyPair()
  // A second issuer of the same association countersigns the close.
  const closer = makeIssuer(assoc.kp)
  const P = await diaryOf(t, bootstrap, assoc, (key) => [
    usernameFor(key, 'fechada', assoc.issuerKp, assoc.issuerCert), // 1
    roster(assoc, key, ownerKp, 2), // 2
    post('ainda compartilhada', 3), // 3
    share(3, 4), // 4
    close(assoc, key, ownerKp, 5, closer) // 5
  ])
  await admit(P, assoc)
  await settled(seeder, P)
  t.is(seeder._names.hint(P.key).closed, true, 'the close verifies while its issuer is trusted')
  t.is(await seeder.postPublic(P.key, 3), null, 'a closed page shows nothing')

  // The closer's issuer is revoked and the name index rebuilt: the close no
  // longer verifies, so the index sets no end and the page reads as open.
  const certOpts = seeder._certOpts
  seeder._certOpts = () => ({ ...(certOpts.call(seeder) || {}), revokedIssuers: new Set([closer.issuerCert.issuer]) })
  t.teardown(() => { seeder._certOpts = certOpts })
  seeder._rebuildIndex()
  const entry = seeder._served.get(P.key)
  await until(() => !seeder._indexRebuildQueued && entry.indexed >= P.diary.length && !entry.indexQueued, { name: 'índice reconstruído' })
  t.is(seeder._names.endSeq(P.key), null, 'the revoked close sets no end')
  t.is(seeder._names.hint(P.key).page, true, 'the roster still verifies')
  t.is(seeder._names.endUnverified(P.key), true, 'the index remembers an end it could not verify')
  t.is(await seeder.postPublic(P.key, 3), null, 'still nothing shown: fails closed')
})
