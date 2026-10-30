'use strict'

// Shared setup of the seeder group-core tests (seeder-groups.test.js,
// seeder-groups-waits.test.js and seeder-groups-3.test.js): a seeder with
// its own certificate, members on the local DHT holding diaries and group
// cores, and waits on its log.
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { discoveryKey, keyPair: signingKeyPair } = require('hypercore-crypto')
const { until, localSwarmOptions } = require('./net')
const { tmpDir } = require('./tmp')
const { Seeder } = require('../../lib/seeder')
const { createCert, createSeederCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('../../lib/cert')
const { attachBlocklist } = require('../../lib/blocklist-net')
const { attachGroups } = require('../../lib/groups-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('../../lib/net')
const { memberCertRecord, groupJoinRecord } = require('../../lib/records')
const { groupHeader, writerHeader, groupPost } = require('../../lib/group')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
}

function readFile (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return { v: 1, admitted: {} }
    throw err
  }
}

function readGroups (dataDir) {
  return readFile(dataDir).groups || {}
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

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const { onlog, ...rest } = opts
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
      if (onlog) onlog(e)
    },
    ...rest
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

function encode (record) {
  return b4a.from(JSON.stringify(record))
}

// A member on the swarm: its diary (certificate, then what `fill` returns)
// and the group cores `fill` makes through make(name, header, records).
// Its store replicates every core to every connection.
// `certOf(key)` signs the member certificate (default: the association).
async function member (t, bootstrap, assoc, fill, { certOf = (key) => validCert(assoc, key) } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const cores = {}
  const make = async (name, header, records = []) => {
    const core = store.get({ name })
    await core.ready()
    await core.append(encode(header))
    for (const r of records) await core.append(encode(r))
    cores[name] = core
    return hex(core.key)
  }
  await diary.append(memberCertRecord(certOf(key)))
  for (const r of await fill({ key, make })) await diary.append(r)

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
  return { store, diary, key, cores, swarm, messages, seederPeer, certOf }
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: m.certOf(m.key) })
  await until(() => m.messages.find((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length), { name: 'have ' + m.key.slice(0, 8) })
}

// A node holding nothing that dials the seeder only: what it reads came
// from the seeder. `blocklist` hands the seeder a snapshot.
async function reader (t, bootstrap, publicKey, { blocklist = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-reader-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const peers = []
  const handles = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    if (blocklist) {
      attachBlocklist(socket, {
        current: () => blocklist,
        offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
      })
    }
    handles.push(attachGroups(socket, { role: 'member' }))
    peers.push(attachAdmission(socket, { role: 'member', have: [] }))
  })
  swarm.joinPeer(b4a.from(publicKey, 'hex'))
  await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador (leitor)' })
  return { store, swarm, groups: handles[0] }
}

function admitted (events, key) {
  return until(() => events.find((e) => e.event === 'group-admitted' && e.key === key), { name: 'group-admitted ' + key.slice(0, 8), timeoutMs: 30000 })
}

function rejected (events, key, reason) {
  return until(() => events.find((e) => e.event === 'group-rejected' && e.key === key && (reason === undefined || e.reason === reason)), { name: 'group-rejected ' + key.slice(0, 8) + ' ' + reason, timeoutMs: 30000 })
}

async function stored (seeder, key) {
  return seeder.store.storage.hasCore(discoveryKey(b4a.from(key, 'hex')))
}

function downloaded (seeder, key, length) {
  return until(() => {
    const e = seeder._groupServed.get(key)
    return e && e.headerOk && e.core.contiguousLength === length
  }, { name: 'núcleo baixado ' + key.slice(0, 8) })
}

function moderator (assoc) {
  const kp = signingKeyPair()
  return { kp, cert: createModeratorCert({ moderator: hex(kp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp) }
}

// Creator A (root R, joined with writer R) and member B (writer W).
async function creatorAndMember (t, bootstrap, assoc) {
  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Cadeiras da praia' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }), [groupPost({ text: 'olá' }), groupPost({ text: 'tudo bem?' })])
    return [groupJoinRecord({ group: R, writer: W, on: true })]
  })
  return { A, B, R, W }
}

// A gate a hook awaits until the test opens it.
function gate () {
  let open
  const g = { key: null, entered: false }
  g.promise = new Promise((resolve) => { open = resolve })
  g.open = open
  g.hook = async (key) => {
    if (key !== g.key) return
    g.entered = true
    await g.promise
  }
  return g
}

function scansDone (seeder) {
  for (const e of seeder._served.values()) {
    if (!e.gated || e.scanQueued || e.scanned < e.core.contiguousLength) return false
  }
  return true
}

// A creator certified by an issuer, joined to its root R; member B (an
// association certificate) keeps R through its writer W.
async function issuedCreatorAndMember (t, bootstrap, assoc) {
  const ikp = signingKeyPair()
  const issuer = { kp: ikp, cert: createIssuerCert({ issuer: hex(ikp.publicKey) }, assoc.kp), hex: hex(ikp.publicKey) }
  let R = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    R = await make('root', groupHeader({ diary: key, name: 'Revogada' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  }, { certOf: (key) => createIssuedCert({ member: key }, issuer.kp, issuer.cert) })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: R, diary: key }))
    return [groupJoinRecord({ group: R, writer: W, on: true })]
  })
  return { issuer, A, B, R, W }
}

function makeIssuer (assoc) {
  const kp = signingKeyPair()
  return { kp, cert: createIssuerCert({ issuer: hex(kp.publicKey) }, assoc.kp), hex: hex(kp.publicKey) }
}

// A stand-in for an admission peer: admit() only needs send() and a socket.
function fakePeer () {
  return { sent: [], send (m) { this.sent.push(m) }, socket: { destroy () {} } }
}

module.exports = {
  hex,
  makeAssociation,
  validCert,
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
  stored,
  downloaded,
  moderator,
  creatorAndMember,
  gate,
  scansDone,
  issuedCreatorAndMember,
  makeIssuer,
  fakePeer
}
