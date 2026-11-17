// The own diary's `prove` (issue #32, @varanda/core lib/peer-proof.js) from
// the browser node, against a fake seeder on loopback (Noise responder,
// admission role 'seeder' certified by the association, the blocklist
// channel, and admission caps the test picks): the sync link sends exactly
// one prove, bound to its own Noise key and signed by the diary key, when
// the verified seeder offered CAP_PEER_PROOF and the diary is announced;
// none without the cap, none to an unverified seeder, none while the
// identity is locked, none on an anonymous peek link; a second announce on
// the same link (own key blocked then unblocked) does not prove again, a
// new link proves again, a certificate recovered after the hello proves
// then; a prove the seeder sends is ignored. The spike's seeder link
// (lib/seeder-link.js) proves once too.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { connectClient, stoppedOf } = require('./helpers/session')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { attachAdmission, CAP_PEER_PROOF } = require('@varanda/core/lib/admission')
const { verifyPeerProof, signPeerProof } = require('@varanda/core/lib/peer-proof')
const { createSnapshot, compareSnapshots } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { createPeeker } = require('../lib/peek')
const { createMember } = require('../lib/member')
const { connectSeeder } = require('../lib/seeder-link')

// After the announce, how long a prove that should not come is waited for
// (the member sends it right behind the announce, on the same channel).
const QUIET_MS = 500

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function moderator (assocKp) {
  const keyPair = crypto.keyPair()
  return { keyPair, cert: createModeratorCert({ moderator: hex(keyPair.publicKey) }, assocKp) }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until (t, what, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(20)
  }
  t.fail('timed out waiting for ' + what)
  return false
}

// A Hypercore 10 diary with the given records (block 0 first).
async function diary (t, records, keyPair) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json', keyPair })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

// A seeder stand-in: role 'seeder' certified by `signer` (a key of another
// association makes it unverified), admission opened with `caps`, the
// blocklist channel holding `seeder.snapshot` (pushed on the open links
// with seeder.push), replicating and advertising `cores`, admitting
// whatever is announced. Every connection records its Noise stream, the
// announces and the proves it received. `sendProve`: the seeder sends a
// well-formed prove of its own right after its hello.
async function fakeSeeder (t, { signer, caps = CAP_PEER_PROOF, cores = [], sendProve = false }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    snapshot: null,
    conns: [], // { ws, noise, peer, handle, announces, proves, closed }
    push (snap, { reject = null } = {}) {
      seeder.snapshot = snap
      for (const conn of seeder.conns) {
        if (conn.closed) continue
        if (reject !== null) conn.peer.send({ type: 'rejected', key: reject, reason: 'blocked' })
        conn.handle.announce()
      }
    },
    proves () {
      return seeder.conns.reduce((n, conn) => n + conn.proves.length, 0)
    },
    announces () {
      return seeder.conns.reduce((n, conn) => n + conn.announces.length, 0)
    }
  }
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    const conn = { ws, noise, peer: null, handle: null, announces: [], proves: [], closed: false }
    seeder.conns.push(conn)
    noise.once('close', () => { conn.closed = true })
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      conn.handle = attachBlocklist(noise, {
        current: () => seeder.snapshot,
        offer: async () => ({ adopted: false, reason: 'same' }),
        compare: compareSnapshots,
        minIntervalMs: 0
      })
      for (const core of cores) core.replicate(noise)
      conn.peer = attachAdmission(noise, {
        role: 'seeder',
        cert,
        caps,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type === 'prove') {
            conn.proves.push(msg)
            return
          }
          if (msg.type !== 'announce') return
          conn.announces.push(msg.key)
          const held = cores.find((core) => hex(core.key) === msg.key)
          peer.send({ type: 'admitted', key: msg.key, length: held ? held.length : (peer.remoteHave.get(msg.key) || 0) })
        }
      })
      if (sendProve) {
        const other = crypto.keyPair()
        conn.peer.send({ type: 'prove', ...signPeerProof({ noiseHex: hex(keyPair.publicKey), keyHex: hex(other.publicKey), keyPair: other }) })
      }
    })
  })
  return seeder
}

// A certified member on a browser node wired to `url`; `cert: false`
// leaves the identity without a certificate (a device that recovers it).
async function webNode (t, assoc, url, { keyPair = crypto.keyPair(), cert = true } = {}) {
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, blocklistMinIntervalMs: 0 },
    onInternalError: (err) => internal.push(err),
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  if (cert) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, key: publicKey, keyPair, internal }
}

function stopped (web) {
  return web.events.some((e) => e.name === 'sync.stopped')
}

function warningsOf (web) {
  return web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
}

test('a verified seeder offering CAP_PEER_PROOF gets one prove bound to the link Noise key and signed by the diary key', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const me = await webNode(t, assoc, seeder.url)

  await me.web.request('sync.start', { once: false })
  await until(t, 'the prove', () => seeder.proves() === 1)
  await sleep(QUIET_MS)
  t.is(seeder.conns.length, 1, 'one link')
  const conn = seeder.conns[0]
  t.alike(conn.announces, [me.key], 'the diary was announced on it')
  t.is(conn.proves.length, 1, 'exactly one prove')
  const msg = conn.proves[0]
  t.alike(Object.keys(msg).sort(), ['key', 'sig', 'signer', 'type'])
  t.is(msg.key, me.key, 'for the own diary')
  t.is(msg.signer, me.key, 'a browser diary key is its signing key')
  t.ok(verifyPeerProof({ noiseHex: hex(conn.noise.remotePublicKey), key: msg.key, signer: msg.signer, sig: msg.sig }), 'verifies for the member Noise key the seeder reads')
  t.absent(verifyPeerProof({ noiseHex: hex(conn.noise.publicKey), key: msg.key, signer: msg.signer, sig: msg.sig }), 'and for no other Noise key')
  t.absent(stopped(me.web), 'the run goes on')
  t.alike(me.internal, [])
  await me.web.request('sync.stop')
})

test('no prove to a verified seeder that did not offer CAP_PEER_PROOF', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp, caps: 0 })
  const me = await webNode(t, assoc, seeder.url)

  await me.web.request('sync.start', { once: false })
  await until(t, 'the announce', () => seeder.announces() === 1)
  await sleep(QUIET_MS)
  t.is(seeder.proves(), 0, 'no prove')
  t.alike(me.internal, [])
  await me.web.request('sync.stop')
})

test('no prove to a seeder whose certificate is from another association', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const other = association()
  const seeder = await fakeSeeder(t, { signer: other.kp })
  const me = await webNode(t, assoc, seeder.url)

  await me.web.request('sync.start', { once: false })
  await until(t, 'two dials', () => seeder.conns.length >= 2 && seeder.conns[0].closed)
  await sleep(QUIET_MS)
  t.is(seeder.announces(), 0, 'nothing announced')
  t.is(seeder.proves(), 0, 'no prove')
  t.ok(warningsOf(me.web).some((line) => /semeador verificado/.test(line)), 'the unverified seeder was reported')
  await me.web.request('sync.stop')
})

test('a locked identity announces without a prove and the run goes on', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const me = await webNode(t, assoc, seeder.url)
  await me.node.clearKeyPair()

  await me.web.request('sync.start', { once: false })
  await until(t, 'the announce', () => seeder.announces() === 1)
  await until(t, 'own-synced', () => me.web.events.some((e) => e.name === 'sync.event' && /diário próprio sincronizado/.test(e.data.line)))
  await sleep(QUIET_MS)
  t.is(seeder.proves(), 0, 'no prove')
  t.is(seeder.conns.length, 1, 'the link stayed up')
  t.absent(stopped(me.web), 'the run goes on')
  t.alike(me.internal, [])
  await me.web.request('sync.stop')
})

test('own key blocked then unblocked on one link: announced twice, proved once', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const mod = moderator(assoc.kp)
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const me = await webNode(t, assoc, seeder.url)

  await me.web.request('sync.start', { once: false })
  await until(t, 'the first prove', () => seeder.proves() === 1)
  seeder.push(createSnapshot({ seq: 1, blocked: [me.key], revokedIssuers: [] }, mod.keyPair, mod.cert), { reject: me.key })
  await until(t, 'the own-blocked warning', () => warningsOf(me.web).includes('aviso: sua identidade está bloqueada pela associação'))
  seeder.push(createSnapshot({ seq: 2, blocked: [], revokedIssuers: [] }, mod.keyPair, mod.cert))
  await until(t, 'the second announce', () => seeder.announces() === 2)
  await sleep(QUIET_MS)
  t.is(seeder.conns.length, 1, 'on the same link')
  t.is(seeder.proves(), 1, 'one prove on the link')
  t.alike(me.internal, [])
  await me.web.request('sync.stop')
})

test('a new link proves again, bound to its own Noise key', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const me = await webNode(t, assoc, seeder.url)

  await me.web.request('sync.start', { once: false })
  await until(t, 'the first prove', () => seeder.proves() === 1)
  seeder.conns[0].ws.terminate()
  await until(t, 'the prove of the second link', () => seeder.conns.length >= 2 && seeder.conns[1].proves.length === 1)
  await sleep(QUIET_MS)
  t.is(seeder.conns[0].proves.length, 1)
  t.is(seeder.conns[1].proves.length, 1)
  const [a, b] = seeder.conns
  t.unlike(hex(a.noise.remotePublicKey), hex(b.noise.remotePublicKey), 'each link has its own Noise key')
  t.ok(verifyPeerProof({ noiseHex: hex(b.noise.remotePublicKey), ...b.proves[0] }), 'the second prove verifies for the second link')
  t.absent(verifyPeerProof({ noiseHex: hex(a.noise.remotePublicKey), ...b.proves[0] }), 'and not for the first')
  await me.web.request('sync.stop')
})

test('a certificate recovered after the hello is proved then', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const keyPair = crypto.keyPair()
  // The diary another device wrote; this device starts with no block 0.
  const remote = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name: 'Autor', bio: '' }),
    () => postRecord({ text: 'de outro aparelho' })
  ], keyPair)
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [remote] })
  const me = await webNode(t, assoc, seeder.url, { keyPair, cert: false })
  t.is(me.key, hex(remote.key))

  const { runId } = await me.web.request('sync.start', { once: true, timeoutMs: 15000 })
  const done = await stoppedOf(me.web.events, runId)
  t.is(done.reason, 'done')
  const lines = me.web.events.filter((e) => e.name === 'sync.event').map((e) => e.data.line)
  t.ok(lines.includes('certificado recuperado do semeador'), 'own-recovered')
  t.is(seeder.conns.length, 1, 'one link')
  const conn = seeder.conns[0]
  t.alike(conn.announces, [me.key], 'announced after the recovery')
  t.is(conn.proves.length, 1, 'and proved then')
  t.ok(verifyPeerProof({ noiseHex: hex(conn.noise.remotePublicKey), ...conn.proves[0] }))
})

test('a prove sent by the seeder is ignored', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp, sendProve: true })
  const me = await webNode(t, assoc, seeder.url)

  await me.web.request('sync.start', { once: false })
  await until(t, 'own-synced', () => me.web.events.some((e) => e.name === 'sync.event' && /diário próprio sincronizado/.test(e.data.line)))
  await sleep(QUIET_MS)
  t.is(seeder.conns.length, 1, 'the link stayed up')
  t.is(seeder.proves(), 1, 'the member still proved once')
  t.absent(stopped(me.web), 'the run goes on')
  t.alike(warningsOf(me.web), [], 'no warning')
  t.alike(me.internal, [])
  await me.web.request('sync.stop')
})

test('an anonymous peek link never proves', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const own = hex(crypto.keyPair().publicKey)
  const peeker = createPeeker({
    ownKey: async () => own,
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    }
  })
  t.teardown(() => peeker.close(), { force: true })
  const page = await peeker.read({ limit: 10 })
  t.alike(page.items, [])
  await sleep(QUIET_MS)
  t.ok(seeder.conns.length >= 1, 'the peek link reached the seeder')
  t.is(seeder.announces(), 0, 'nothing announced')
  t.is(seeder.proves(), 0, 'no prove')
})

test('the spike seeder link proves once, after its announce', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const member = await createMember({ storage: memoryStorage(), keyPair: crypto.keyPair(), association: assoc.hex })
  t.teardown(() => member.close(), { force: true })
  await member.setCert(createCert({ member: member.key }, assoc.kp))
  const ws = new WebSocket(seeder.url)
  ws.on('error', () => {})
  const link = connectSeeder({ member, socket: ws, association: assoc.hex })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await until(t, 'the prove', () => seeder.proves() === 1)
  await sleep(QUIET_MS)
  const conn = seeder.conns[0]
  t.is(conn.proves.length, 1, 'exactly one prove')
  t.is(conn.proves[0].key, member.key)
  t.ok(verifyPeerProof({ noiseHex: hex(conn.noise.remotePublicKey), ...conn.proves[0] }), 'bound to the link Noise key')
})

test('the spike seeder link sends no prove without CAP_PEER_PROOF', async (t) => {
  t.timeout(60000)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp, caps: 0 })
  const member = await createMember({ storage: memoryStorage(), keyPair: crypto.keyPair(), association: assoc.hex })
  t.teardown(() => member.close(), { force: true })
  await member.setCert(createCert({ member: member.key }, assoc.kp))
  const ws = new WebSocket(seeder.url)
  ws.on('error', () => {})
  const link = connectSeeder({ member, socket: ws, association: assoc.hex })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await sleep(QUIET_MS)
  t.is(seeder.announces(), 1)
  t.is(seeder.proves(), 0, 'no prove')
})
