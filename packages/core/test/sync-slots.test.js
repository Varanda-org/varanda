'use strict'

// Member sync and issue #32: connection slots shared fairly by remote
// address (a verified seeder's connection is never displaced) and the
// `prove` message a member sends, once per connection, to a verified seeder
// that offers CAP_PEER_PROOF. Fake peers only (lib/seeder.js is not used).
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const Verifier = require('hypercore/lib/verifier')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { runSync } = require('../lib/sync')
const { openStore, openDiary, appendRecord, writeConfig } = require('../lib/store')
const { memberCertRecord, profileRecord } = require('../lib/records')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { verifyPeerProof, signPeerProof } = require('../lib/peer-proof')
const {
  createSwarm,
  topicFor,
  joinAndFlush,
  attachAdmission,
  generateNoiseKeyPair,
  CAP_PEER_PROOF
} = require('../lib/net')

const PROBATION_MS = 250
const QUIET_MS = 1500 // how long a test waits to see that a message never comes

const hex = (b) => b4a.toString(b, 'hex')
const manifestKey = (pk) => Hypercore.key(Verifier.defaultSignerManifest(pk))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A member data dir whose block 0 is a member cert signed by certKp (the
// association is trustKp). The store is closed on return.
async function makeMember (t, trustKp, { certKp = trustKp } = {}) {
  const dir = tmpDir(t, 'varanda-slots-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: hex(trustKp.publicKey) })
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, certKp)))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    return { dir, key }
  } finally {
    await store.close()
  }
}

// A raw node on the association's rendezvous: a Corestore and a loopback
// swarm with a fixed Noise key pair that attaches an admission channel on
// every connection. Every message is recorded per connection. onhello(peer)
// runs when the remote hello arrives.
async function rawNode (t, bootstrap, association, { noise = generateNoiseKeyPair(), role = 'member', cert = null, caps = 0, onhello = () => {}, join = true } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-slots-raw-'))
  await store.ready()
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair: noise })
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const links = [] // { socket, peer, messages, closed }
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const link = { socket, peer: null, messages: [], closed: false }
    links.push(link)
    link.peer = attachAdmission(socket, {
      role,
      cert,
      caps,
      onmessage: (msg, p) => {
        link.messages.push(msg)
        if (msg.type === 'hello') onhello(p, link)
      },
      onclose: () => { link.closed = true }
    })
  })
  const node = {
    noise,
    noiseHex: hex(noise.publicKey),
    swarm,
    links,
    join: () => joinAndFlush(swarm, [topicFor(association)]),
    // Open links on which a member's hello arrived.
    memberLinks: () => links.filter((l) => !l.closed && l.peer.remoteRole === 'member'),
    received: (type) => links.flatMap((l) => l.messages.filter((m) => m.type === type))
  }
  if (join) await node.join()
  return node
}

// A fake seeder: role 'seeder' with a seeder cert for its Noise key, signed
// by certKp (the association key for a valid one).
function fakeSeeder (t, bootstrap, kp, { certKp = kp, caps = CAP_PEER_PROOF, join = true } = {}) {
  const noise = generateNoiseKeyPair()
  return rawNode(t, bootstrap, hex(kp.publicKey), {
    noise,
    role: 'seeder',
    cert: createSeederCert({ seeder: hex(noise.publicKey) }, certKp),
    caps,
    join
  })
}

function startMember (t, bootstrap, member, opts = {}) {
  const events = []
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const run = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: member.dir,
    signal: controller.signal,
    onEvent: (ev) => events.push(ev),
    ...opts
  })
  const sawPeer = (key, verified) => events.some((e) => e.event === 'peer' && e.peerKey === key && (verified === undefined || e.verified === verified))
  const dropped = (reason, key) => events.filter((e) => e.event === 'peer-dropped' && e.reason === reason && (key === undefined || e.peerKey === key))
  return {
    events,
    sawPeer,
    dropped,
    stop: async () => {
      controller.abort()
      return run
    }
  }
}

test('a verified seeder offering CAP_PEER_PROOF gets one valid prove per connection', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const member = await makeMember(t, kp)
  const seeder = await fakeSeeder(t, bootstrap, kp)
  const m = startMember(t, bootstrap, member)
  await until(() => seeder.received('prove').length >= 1, { timeoutMs: 30000, name: 'prove received' })
  t.ok(m.sawPeer(seeder.noiseHex, true), 'the member verified the seeder')
  // Later traffic (announce, have) brings no second prove.
  await sleep(QUIET_MS)
  const proving = seeder.links.filter((l) => l.messages.some((msg) => msg.type === 'prove'))
  t.ok(proving.length >= 1)
  for (const link of proving) {
    const proves = link.messages.filter((msg) => msg.type === 'prove')
    t.is(proves.length, 1, 'one prove on this connection')
    const msg = proves[0]
    t.is(msg.key, member.key, 'the proof names the member diary')
    t.not(msg.signer, msg.key, 'Hypercore 11 diary: the signer is not the key')
    t.ok(verifyPeerProof({ noiseHex: hex(link.socket.remotePublicKey), ...msg }, { manifestKey }), 'the proof verifies for this connection')
    t.absent(verifyPeerProof({ noiseHex: seeder.noiseHex, ...msg }, { manifestKey }), 'and not for another Noise key')
    t.ok(link.messages.findIndex((x) => x.type === 'announce') < link.messages.indexOf(msg), 'the announce came first')
  }
  const r = await m.stop()
  t.is(r.ok, true, JSON.stringify(r.errors))
})

test('no prove without CAP_PEER_PROOF', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const member = await makeMember(t, kp)
  const seeder = await fakeSeeder(t, bootstrap, kp, { caps: 0 })
  const m = startMember(t, bootstrap, member)
  await until(() => m.sawPeer(seeder.noiseHex, true) && seeder.received('announce').length >= 1, { timeoutMs: 30000, name: 'verified and announced' })
  await sleep(QUIET_MS)
  t.is(seeder.received('prove').length, 0)
  await m.stop()
})

test('no prove to a seeder whose cert does not verify', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const member = await makeMember(t, kp)
  const seeder = await fakeSeeder(t, bootstrap, kp, { certKp: generateAssociationKeyPair() })
  const m = startMember(t, bootstrap, member)
  await until(() => m.sawPeer(seeder.noiseHex, false) && seeder.received('announce').length >= 1, { timeoutMs: 30000, name: 'unverified peer met' })
  await sleep(QUIET_MS)
  t.is(seeder.received('prove').length, 0)
  await m.stop()
})

test('no prove when the member has no valid cert to announce', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const member = await makeMember(t, kp, { certKp: generateAssociationKeyPair() })
  const seeder = await fakeSeeder(t, bootstrap, kp)
  const m = startMember(t, bootstrap, member)
  await until(() => m.sawPeer(seeder.noiseHex, true), { timeoutMs: 30000, name: 'verified seeder met' })
  await sleep(QUIET_MS)
  t.is(seeder.received('announce').length, 0, 'no announce')
  t.is(seeder.received('prove').length, 0, 'no prove')
  await m.stop()
})

test('a member ignores a prove it receives and never proves to a member', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const member = await makeMember(t, kp)
  // A member-role peer that offers the cap and sends a well-formed prove.
  const other = await rawNode(t, bootstrap, hex(kp.publicKey), {
    caps: CAP_PEER_PROOF,
    onhello: (peer, link) => {
      const signer = generateNoiseKeyPair()
      peer.send({ type: 'prove', ...signPeerProof({ noiseHex: hex(link.socket.publicKey), keyHex: hex(signer.publicKey), keyPair: signer }) })
    }
  })
  const m = startMember(t, bootstrap, member)
  await until(() => m.sawPeer(other.noiseHex) && other.memberLinks().length >= 1, { timeoutMs: 30000, name: 'member peer met' })
  await sleep(QUIET_MS)
  t.ok(other.memberLinks().length >= 1, 'the connection stays open')
  t.is(m.events.filter((e) => e.event === 'peer-dropped' && e.peerKey === other.noiseHex).length, 0, 'not dropped')
  t.is(other.received('prove').length, 0, 'no prove to a member')
  const r = await m.stop()
  t.is(r.ok, true, JSON.stringify(r.errors))
})

// addressOf by the remote Noise key: each fake node gets a chosen address.
function addressBook () {
  const book = new Map()
  const hosts = []
  return {
    set: (node, host) => book.set(node.noiseHex, host),
    hosts,
    addressOf: (socket) => {
      hosts.push(socket.rawStream ? socket.rawStream.remoteHost : null)
      return book.get(hex(socket.remotePublicKey)) || '192.0.2.250'
    }
  }
}

test('slots: a flood from one address cannot displace a verified seeder of that address', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const member = await makeMember(t, kp)
  const book = addressBook()
  const m = startMember(t, bootstrap, member, { maxConnections: 2, probationMs: PROBATION_MS, addressOf: book.addressOf })

  const f1 = await rawNode(t, bootstrap, association, { join: false })
  book.set(f1, '198.51.100.7')
  await f1.join()
  await until(() => m.sawPeer(f1.noiseHex), { timeoutMs: 30000, name: 'first flood peer met' })
  // The seeder shares the flood's address and is the newest entry, so the
  // same-address rotation would pick it if it were not protected.
  const seeder = await fakeSeeder(t, bootstrap, kp, { join: false })
  book.set(seeder, '198.51.100.7')
  await seeder.join()
  await until(() => m.sawPeer(seeder.noiseHex, true), { timeoutMs: 30000, name: 'seeder verified' })
  await sleep(2 * PROBATION_MS)

  const flood = []
  for (let i = 0; i < 2; i++) {
    const f = await rawNode(t, bootstrap, association, { join: false })
    book.set(f, '198.51.100.7')
    await f.join()
    flood.push(f)
    await until(() => m.events.some((e) => e.event === 'peer-dropped' && e.peerKey === f.noiseHex) || m.sawPeer(f.noiseHex), { timeoutMs: 30000, name: 'flood peer handled' })
    await sleep(2 * PROBATION_MS)
  }
  t.ok(book.hosts.includes('127.0.0.1'), 'the testnet remote host is 127.0.0.1')
  t.ok(m.dropped('connection-displaced').length >= 1, 'flood connections rotated')
  t.is(m.dropped('connection-displaced', seeder.noiseHex).length, 0, 'the seeder was never displaced')
  t.ok(seeder.memberLinks().length >= 1, 'the seeder connection is still open')
  await m.stop()
})

test('slots: a connection from another address displaces a flood connection', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const member = await makeMember(t, kp)
  const book = addressBook()
  // Probation far longer than the test: only the fair-share rule can apply.
  const m = startMember(t, bootstrap, member, { maxConnections: 2, probationMs: 600000, addressOf: book.addressOf })
  const flood = []
  for (let i = 0; i < 2; i++) {
    const f = await rawNode(t, bootstrap, association, { join: false })
    book.set(f, '198.51.100.7')
    await f.join()
    flood.push(f)
    await until(() => m.sawPeer(f.noiseHex), { timeoutMs: 30000, name: 'flood peer ' + i + ' met' })
  }
  const g = await rawNode(t, bootstrap, association, { join: false })
  book.set(g, '203.0.113.9')
  await g.join()
  await until(() => m.sawPeer(g.noiseHex), { timeoutMs: 30000, name: 'peer of another address admitted' })
  const displaced = m.dropped('connection-displaced')
  t.ok(displaced.length >= 1, 'a flood connection made room')
  t.ok(displaced.every((e) => flood.some((f) => f.noiseHex === e.peerKey)), 'only flood connections were displaced')
  t.is(m.dropped('connection-limit', g.noiseHex).length, 0, 'the newcomer was not refused')
  await m.stop()
})

test('slots: refused when only a verified seeder holds the table', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const member = await makeMember(t, kp)
  const book = addressBook()
  const m = startMember(t, bootstrap, member, { maxConnections: 1, probationMs: PROBATION_MS, addressOf: book.addressOf })
  const seeder = await fakeSeeder(t, bootstrap, kp, { join: false })
  book.set(seeder, '203.0.113.9')
  await seeder.join()
  await until(() => m.sawPeer(seeder.noiseHex, true), { timeoutMs: 30000, name: 'seeder verified' })
  await sleep(2 * PROBATION_MS)
  const f = await rawNode(t, bootstrap, association, { join: false })
  book.set(f, '198.51.100.7')
  await f.join()
  await until(() => m.dropped('connection-limit', f.noiseHex).length >= 1, { timeoutMs: 30000, name: 'newcomer refused' })
  t.absent(m.sawPeer(f.noiseHex), 'the newcomer never got a hello through')
  t.is(m.dropped('connection-displaced').length, 0, 'nothing displaced')
  t.ok(seeder.memberLinks().length >= 1, 'the seeder connection is still open')
  await m.stop()
})
