'use strict'

// The quiet visit lane 'varanda/visit/1' (docs/protocol.md section 11): a
// seeder on a local DHT stores visit pings in its own capped pool, pages them
// back on the visit channel only, never wakes anyone for them, and a seeder
// without the lane leaves the channel unopened.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { testnet, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { generateNoiseKeyPair, attachAdmission } = require('../lib/net')
const { attachDm, VISIT_PROTOCOL, VISIT_PROTOCOL_V2, DM_PROTOCOL_V2 } = require('../lib/dm-net')
const { encodeDrop, DM_SEALED_BYTES, DM_PROTOCOL } = require('../lib/dm')
const { VISIT_POOL_DIR, POOL_DIR } = require('../lib/dm-pool')
const postage = require('../lib/dm-postage')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

function rsaKey () {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: postage.kidOf(n), n: n.toString(10), e: '65537', d: fromBase64url(jwk.d).toString(10) }
}

const K1 = rsaKey()

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return dataDir
}

async function startSeeder (t, bootstrap, dataDir, assoc, dm) {
  const events = []
  const seeder = new Seeder({ dataDir, associationKey: assoc.hex, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), dm })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    seeder.acceptStream(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  return { seeder, events, port: server.address().port }
}

// An anonymous member link: fresh Noise key, an empty inventory.
async function link (t, port) {
  const tcp = net.connect(port, '127.0.0.1')
  tcp.on('error', () => {})
  const noise = new NoiseSecretStream(true, tcp, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve, reject) => {
    noise.once('connect', resolve)
    noise.once('close', () => reject(new Error('link fechado')))
  })
  Hypercore.createProtocolStream(noise)
  attachAdmission(noise, { role: 'member', have: [] })
  return noise
}

// A stamp made directly with the seeder's postage key (the stamp channel and
// its budget are covered by seeder-dm.test.js).
function stamp () {
  const n = BigInt(K1.n)
  const token = postage.newToken(n)
  const sig = postage.modPow(postage.representative(token), BigInt(K1.d), n)
  return { kid: K1.kid, token, sig }
}

function dropFor ({ kid, token, sig }) {
  return encodeDrop({
    dropId: hcrypto.randomBytes(32),
    kid: b4a.from(kid, 'hex'),
    rsaSig: postage.bigToBytes(sig),
    token,
    sealed: hcrypto.randomBytes(DM_SEALED_BYTES)
  })
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function streams (t) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  Hypercore.createProtocolStream(a)
  Hypercore.createProtocolStream(b)
  t.teardown(() => {
    a.destroy()
    b.destroy()
  }, { force: true })
  return { a, b }
}

test('visit lane: pings go to the visit pool only, wake nobody, and a full lane leaves dms alone', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = {
    postage: { get: async () => ({ keys: [K1] }) },
    visitMax: 2
  }
  const { seeder, events, port } = await startSeeder(t, bootstrap, dataDir, assoc, dm)

  const noise = await link(t, port)
  const visit = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL })
  const dms = attachDm(noise, { role: 'member' })
  t.is(await visit.supported, true, 'the visit channel opens')
  t.is(await dms.supported, true)

  const s1 = stamp()
  const ping = dropFor(s1)
  t.alike(await visit.put(ping), { ok: true, reason: null })
  t.is(seeder._dm.size, 0, 'the dm pool count is unchanged')
  t.is(seeder._visit.size, 1)
  const vp = await visit.requestPage({ after: 0, limit: 8 })
  t.is(vp.items.length, 1)
  t.alike(vp.items[0].bytes, ping, 'paged back on the visit channel')
  t.alike((await dms.requestPage({ after: 0, limit: 8 })).items, [], 'never on the dm channel')

  t.alike(await dms.put(dropFor(s1)), { ok: false, reason: 'invalido' }, 'a stamp spent on a visit pays for no dm')
  const s2 = stamp()
  const msg = dropFor(s2)
  t.alike(await dms.put(msg), { ok: true, reason: null })
  t.alike(await visit.put(dropFor(s2)), { ok: false, reason: 'invalido' }, 'a stamp spent on a dm pays for no visit')
  t.alike(await visit.put(ping), { ok: true, reason: null }, 'an identical ping again is a repeated success')
  t.is((await visit.requestPage({ after: 0, limit: 8 })).items.length, 1, 'the dm is not on the visit channel')

  t.alike(await visit.put(dropFor(stamp())), { ok: true, reason: null })
  t.alike(await visit.put(dropFor(stamp())), { ok: false, reason: 'cheio' }, 'a full visit pool answers cheio')
  t.alike(await dms.put(dropFor(stamp())), { ok: true, reason: null }, 'dm puts still succeed')
  t.is(seeder._dm.size, 2)
  t.is(seeder._visit.size, 2)

  t.ok(fs.existsSync(path.join(dataDir, VISIT_POOL_DIR)), 'the visit pool has its own directory')
  t.ok(fs.existsSync(path.join(dataDir, POOL_DIR)))
  t.ok(events.some((e) => e.event === 'visit' && e.reason === 'guardada'))
  t.ok(events.some((e) => e.event === 'visit' && e.reason === 'cheio'))
  t.is(events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length, 2, 'visit puts are not logged as dms')
})

test('visit lane: a seeder without dm (--no-dm) never opens the channel', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const { port } = await startSeeder(t, bootstrap, dataDir, assoc, null)
  const noise = await link(t, port)
  const visit = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL })
  t.is(await visit.supported, false, 'the member sees the lane as unsupported')
  await t.exception(visit.put(dropFor(stamp())), /closed/, 'and nothing can be sent on it')
  t.absent(noise.destroyed, 'the link stays up')
  t.absent(fs.existsSync(path.join(dataDir, VISIT_POOL_DIR)), 'no visit pool dir')
})

test('visit lane: a seeder from before the lane answers dms but not visits', async (t) => {
  const { a, b } = streams(t)
  const stored = []
  const put = (bytes) => { stored.push(bytes); return { seq: stored.length } }
  const page = () => ({ items: [], next: null, oldest: 1 })
  // The old seeder: only the dm channel.
  attachDm(a, { role: 'seeder', put, page })
  const dms = attachDm(b, { role: 'member' })
  const visit = attachDm(b, { role: 'member', protocol: VISIT_PROTOCOL })
  t.is(await dms.supported, true)
  t.is(await visit.supported, false, 'the visit lane is unsupported')
  t.is(dms.protocol, DM_PROTOCOL)
  t.is(stored.length, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('visit lane: a ping with a bad stamp is refused and stored nowhere', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = { postage: { get: async () => ({ keys: [K1] }) } }
  const { seeder, events, port } = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  const noise = await link(t, port)
  const visit = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL })
  const dms = attachDm(noise, { role: 'member' })
  t.is(await visit.supported, true)

  const good = stamp()
  const bad = { ...good, sig: good.sig + 1n }
  t.alike(await visit.put(dropFor(bad)), { ok: false, reason: 'invalido' }, 'a forged stamp is refused')
  t.is(seeder._visit.size, 0, 'not in the visit pool')
  t.is(seeder._dm.size, 0, 'nor in the dm pool')
  t.alike((await visit.requestPage({ after: 0, limit: 8 })).items, [])
  t.alike((await dms.requestPage({ after: 0, limit: 8 })).items, [])
  t.is(fs.statSync(path.join(dataDir, VISIT_POOL_DIR, 'log.bin')).size, 0, 'nothing written to the visit log')
  t.ok(events.some((e) => e.event === 'visit' && e.reason === 'invalido'))
  t.alike(await visit.put(dropFor(good)), { ok: true, reason: null }, 'the forged ping spent nothing: the real stamp still pays')
})

test('buckets: the bits follow the served count, at attach time', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = { postage: { get: async () => ({ keys: [K1] }) } }
  const { seeder } = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  t.is(seeder._dmBucketBits(), 0, 'no diaries: one bucket')
  const real = seeder._served
  const fill = (n) => new Map(Array.from({ length: n }, (_, i) => ['k' + i, { gated: false }]))
  seeder._served = fill(999)
  t.is(seeder._dmBucketBits(), 0)
  seeder._served = fill(1000)
  t.is(seeder._dmBucketBits(), 1)
  seeder._served = fill(4000)
  t.is(seeder._dmBucketBits(), 3)
  seeder._served = real
})

test('buckets: v2 put then page by bucket on both lanes; a v1 page still gets everything', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = { postage: { get: async () => ({ keys: [K1] }) } }
  const { seeder, events, port } = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  seeder._dmBucketBits = () => 2

  const noise = await link(t, port)
  const dm2 = attachDm(noise, { role: 'member', protocol: DM_PROTOCOL_V2 })
  const visit2 = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL_V2 })
  const dm1 = attachDm(noise, { role: 'member' })
  const visit1 = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL })
  t.is(await dm2.supported, true)
  t.is(await visit2.supported, true)
  t.is(dm2.bits, 2)
  t.is(visit2.bits, 2)

  // Prefix 0b100000 is bucket 2 at 2 bits.
  const a = dropFor(stamp())
  const b = dropFor(stamp())
  const untagged = dropFor(stamp())
  t.alike(await dm2.put(a, 0b100000), { ok: true, reason: null })
  t.alike(await dm2.put(b, 0b000000), { ok: true, reason: null })
  t.alike(await dm2.put(untagged, null), { ok: true, reason: null })
  const right = await dm2.requestPage({ after: 0, limit: 8, prefixes: [0b100011] })
  t.alike(right.items.map((i) => i.bytes), [a, untagged], 'the right bucket and the untagged one')
  const other = await dm2.requestPage({ after: 0, limit: 8, prefixes: [0b110000] })
  t.alike(other.items.map((i) => i.bytes), [untagged], 'another bucket: only the untagged')
  const all = await dm1.requestPage({ after: 0, limit: 8 })
  t.is(all.items.length, 3, 'a v1 page returns both buckets and the untagged drop')

  const v = dropFor(stamp())
  t.alike(await visit2.put(v, 0b010000), { ok: true, reason: null })
  t.alike((await visit2.requestPage({ after: 0, limit: 8, prefixes: [0b100000] })).items, [], 'a visit of another bucket is not returned')
  t.alike((await visit2.requestPage({ after: 0, limit: 8, prefixes: [0b010000] })).items.map((i) => i.bytes), [v])
  t.is((await visit1.requestPage({ after: 0, limit: 8 })).items.length, 1, 'a v1 visit page returns it')
  t.is(seeder._visit.size, 1)
  t.is(seeder._dm.size, 3)

  const logged = JSON.stringify(events)
  t.absent(/bucket|bits|tag/i.test(logged), 'no log line names a bucket, a tag or the bits')
})

test('buckets: --no-dm turns the v2 lanes off with the rest', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const { port } = await startSeeder(t, bootstrap, dataDir, assoc, null)
  const noise = await link(t, port)
  const dm2 = attachDm(noise, { role: 'member', protocol: DM_PROTOCOL_V2 })
  const visit2 = attachDm(noise, { role: 'member', protocol: VISIT_PROTOCOL_V2 })
  t.is(await dm2.supported, false)
  t.is(await visit2.supported, false)
})
