'use strict'

// The seeder's blob channel and the /blob route (docs/protocol.md section
// 11): stamped chunks put over 'varanda/blob/1' on an anonymous link, served
// over HTTP once the blob is complete. The key files are the real ones from
// `seed` (dm-postage.json and blob-postage.json) unless a test swaps them.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { generateNoiseKeyPair, attachAdmission } = require('@varanda/core/lib/net')
const { attachDmStamp } = require('@varanda/core/lib/dm-stamp-net')
const { attachBlob } = require('@varanda/core/lib/blob-net')
const { signNoticeProof } = require('@varanda/core/lib/notices-v2')
const { BLOB_CHUNK_BYTES, BLOB_FRAME_BYTES, encodeChunk, newBlobId } = require('@varanda/core/lib/blob')
const postage = require('@varanda/core/lib/dm-postage')
const { startSeedWs } = require('../lib/seed-ws')
const { dmOption } = require('../lib/commands/seed')

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

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

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

// A member link: fresh Noise key and an empty inventory, as a member opens
// the anonymous channels.
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

// A diary the seeder admits (compat core, so its key pair signs the proofs).
async function admittedMember (t, port, assoc, events) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const kp = hcrypto.keyPair()
  const core = store.get({ key: kp.publicKey, keyPair: kp, valueEncoding: 'json' })
  await core.ready()
  const key = hex(core.key)
  await core.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const tcp = net.connect(port, '127.0.0.1')
  tcp.on('error', () => {})
  const noise = new NoiseSecretStream(true, tcp, { keyPair: generateNoiseKeyPair() })
  noise.on('error', () => {})
  t.teardown(() => noise.destroy(), { force: true })
  await new Promise((resolve) => noise.once('connect', resolve))
  store.replicate(noise)
  const peer = attachAdmission(noise, { role: 'member', have: [{ key, length: core.length }] })
  await peer.hello
  peer.send({ type: 'announce', key, cert: createCert({ member: key }, assoc.kp) })
  await until(() => events.some((e) => e.event === 'admitted' && e.key === key), { name: 'diário admitido' })
  return { ownKey: key, sign: (payload) => signNoticeProof(payload, kp) }
}

function stampChannel (noise, member, extra = {}) {
  return attachDmStamp(noise, { role: 'member', ownKey: member.ownKey, sign: member.sign, ...extra })
}

async function dmIssue (stamp) {
  const pub = await stamp.key()
  const n = BigInt(pub.n)
  const token = postage.newToken(n)
  const { blinded, r } = postage.blind(postage.representative(token), n)
  const got = await stamp.issue(postage.toBase64(blinded))
  if (got.error) return got
  return { kid: got.kid, ok: postage.verify(token, postage.unblind(postage.fromBase64(got.sig), r, n), pub, 'dm') }
}

// Every chunk of a fresh blob, each under a blob stamp the seeder issued.
// The stamps are bought first, on random tokens, as a client's wallet would,
// and only then spent on the chunks.
async function stampedBlob (stamp, count) {
  const pub = await stamp.key('blob')
  const n = BigInt(pub.n)
  const wallet = []
  for (let i = 0; i < count; i++) {
    const token = postage.newToken(n, 'blob')
    const { blinded, r } = postage.blind(postage.representative(token, 'blob'), n)
    const got = await stamp.issue(postage.toBase64(blinded), 'blob')
    if (got.error) throw new Error('blob stamp refused: ' + got.error)
    const sig = postage.unblind(postage.fromBase64(got.sig), r, n)
    wallet.push({ token, kid: b4a.from(got.kid, 'hex'), sig: postage.bigToBytes(sig) })
  }
  const id = newBlobId()
  const frames = []
  for (let index = 0; index < count; index++) {
    const bytes = crypto.randomBytes(index === count - 1 ? 1000 : BLOB_CHUNK_BYTES)
    const { token, kid, sig } = wallet[index]
    frames.push(encodeChunk({ id, index, count, kid, sig, token, bytes }))
  }
  return { id: hex(id), frames, kid: pub.kid }
}

function request (port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host: '127.0.0.1:' + port } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('seeder blob: put, fetch a complete blob, 404 for an incomplete one, query refused, separate stamp counter', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = dmOption({ dataDir })
  t.is(typeof dm.blobPostage.get, 'function', 'seed gives the seeder a blob key file')
  t.not(dm.blobPostage, dm.postage)
  const { seeder, events, port } = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })

  const member = await admittedMember(t, port, assoc, events)
  const stamp = stampChannel(await link(t, port), member)
  t.is(await stamp.supported, true)
  const blob = await stampedBlob(stamp, 2)
  t.ok(fs.existsSync(path.join(dataDir, 'blob-postage.json')), 'the blob key file is made on first use')
  t.not(blob.kid, readJson(path.join(dataDir, 'dm-postage.json')).keys[0].kid, 'its own key, not the DM key')

  const blobStamps = readJson(path.join(dataDir, 'blob-stamps.json'))
  t.alike(Object.values(blobStamps.days[member.ownKey]), [2], 'blob stamps counted in blob-stamps.json')
  t.absent(fs.existsSync(path.join(dataDir, 'dm-stamps.json')), 'and never in dm-stamps.json')
  const dmStamp = await dmIssue(stamp)
  t.ok(dmStamp.ok, 'a DM stamp still verifies')
  t.alike(Object.values(readJson(path.join(dataDir, 'dm-stamps.json')).days[member.ownKey]), [1])
  t.alike(Object.values(readJson(path.join(dataDir, 'blob-stamps.json')).days[member.ownKey]), [2], 'a DM stamp spends no blob allowance')

  const ch = attachBlob(await link(t, port), { role: 'member' })
  t.is(await ch.supported, true, 'the seeder opens the blob channel')
  t.alike(await ch.put(blob.frames[0]), { ok: true, reason: null })
  const url0 = '/blob/' + blob.id + '/0'
  const incomplete = await request(ws.port, 'GET', url0)
  t.is(incomplete.status, 404, 'an incomplete blob is not served')
  t.is(incomplete.headers['cache-control'], 'no-store')
  t.alike(await ch.put(blob.frames[0]), { ok: true, reason: null }, 'a repeated put is a success')
  t.alike(await ch.put(blob.frames[1]), { ok: true, reason: null })
  t.ok(events.some((e) => e.event === 'blob' && e.reason === 'completo'))

  for (const index of [0, 1]) {
    const got = await request(ws.port, 'GET', '/blob/' + blob.id + '/' + index)
    t.is(got.status, 200)
    t.ok(b4a.equals(got.body, blob.frames[index]), 'the stored frame, exactly')
    t.is(got.body.byteLength, BLOB_FRAME_BYTES)
    t.is(got.headers['content-type'], 'application/octet-stream')
    t.is(got.headers['cache-control'], 'private, max-age=604800')
    t.is(got.headers['x-content-type-options'], 'nosniff')
    t.absent(got.headers['set-cookie'], 'no cookie')
  }
  const head = await request(ws.port, 'HEAD', url0)
  t.is(head.status, 200)
  t.is(head.headers['content-length'], String(BLOB_FRAME_BYTES))
  t.is(head.body.byteLength, 0)

  for (const bad of [
    url0 + '?x=1',
    url0 + '?',
    '/blob/' + blob.id + '/2',
    '/blob/' + blob.id + '/00',
    '/blob/' + blob.id + '/-1',
    '/blob/' + blob.id.toUpperCase() + '/0',
    '/blob/' + blob.id + '/0/',
    '/blob/' + blob.id,
    '/blob/' + hex(newBlobId()) + '/0',
    '/blob'
  ]) {
    const got = await request(ws.port, 'GET', bad)
    t.is(got.status, 404, 'refused: ' + bad.replace(blob.id, '<id>'))
    t.is(got.headers['cache-control'], 'no-store')
    t.is(got.body.toString(), 'não encontrado\n')
  }
  const post = await request(ws.port, 'POST', url0)
  t.is(post.status, 405)

  const text = JSON.stringify(events)
  t.absent(text.includes(blob.id), 'no blob id in the log')
  t.absent(JSON.stringify(events.filter((e) => e.event === 'blob' || e.event === 'dm-stamp')).includes(member.ownKey), 'no diary key in the blob log')
  for (const e of events.filter((e) => e.event === 'blob')) t.alike(Object.keys(e).sort(), ['event', 'reason'])

  await ws.close()
  await seeder.close()
  t.is(seeder.blobChunk(blob.id, 0), null, 'a closed seeder serves nothing')
})

test('seeder blob: --no-dm turns the blob pool and route off', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  t.is(dmOption({ dataDir, noDm: true }), null)
  const { seeder, port } = await startSeeder(t, bootstrap, dataDir, assoc, null)
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  t.is(seeder.blobChunk(hex(newBlobId()), 0), null)
  const got = await request(ws.port, 'GET', '/blob/' + hex(newBlobId()) + '/0')
  t.is(got.status, 404)
  const ch = attachBlob(await link(t, port), { role: 'member' })
  t.is(await ch.supported, false, 'no blob channel without direct messages')
  t.absent(fs.existsSync(path.join(dataDir, 'blobs')), 'no pool directory')
})

test('seeder blob: a blob key file holding the DM key is refused, DM stamps keep working', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = dmOption({ dataDir })
  await dm.postage.get()
  fs.copyFileSync(path.join(dataDir, 'dm-postage.json'), path.join(dataDir, 'blob-postage.json'))
  const { events, port } = await startSeeder(t, bootstrap, dataDir, assoc, dm)

  const member = await admittedMember(t, port, assoc, events)
  const noise = await link(t, port)
  const stamp = stampChannel(noise, member, { requestTimeoutMs: 2000 })
  t.ok((await dmIssue(stamp)).ok, 'DM stamps work')
  t.ok(events.some((e) => e.event === 'dm-stamp' && e.reason === 'blob-postage'), 'the shared key is refused')
  await t.exception(stamp.key('blob'), 'no blob kind on the stamp channel')

  const fresh = stampChannel(await link(t, port), member)
  t.ok((await dmIssue(fresh)).ok, 'DM stamps keep working')
  t.absent(fs.existsSync(path.join(dataDir, 'blob-stamps.json')), 'no blob stamp issued')

  // A frame under the DM key, as a blob request with that key would mint.
  const key = readJson(path.join(dataDir, 'dm-postage.json')).keys[0]
  const n = BigInt(key.n)
  const id = newBlobId()
  const bytes = crypto.randomBytes(100)
  const token = postage.newToken(n, 'blob')
  const sig = postage.modPow(postage.representative(token, 'blob'), BigInt(key.d), n)
  const frame = encodeChunk({ id, index: 0, count: 1, kid: b4a.from(key.kid, 'hex'), sig: postage.bigToBytes(sig), token, bytes })
  const ch = attachBlob(await link(t, port), { role: 'member' })
  t.is(await ch.supported, true)
  await t.exception(ch.put(frame), 'the put stays uncertain, never stored')
  t.ok(events.some((e) => e.event === 'blob' && e.reason === 'postage'))
  t.absent(fs.existsSync(path.join(dataDir, 'blobs', hex(id))), 'nothing stored')
})

test('seeder blob: the stamp channel reopens when the blob kid rotates', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const K1 = rsaKey()
  const K2 = rsaKey()
  const K3 = rsaKey()
  let blobKeys = [K2]
  const { seeder, events, port } = await startSeeder(t, bootstrap, dataDir, assoc, {
    postage: { get: async () => ({ keys: [K1] }) },
    blobPostage: { get: async () => ({ keys: blobKeys }) }
  })
  const member = await admittedMember(t, port, assoc, events)
  const noise = await link(t, port)
  const stamp = stampChannel(noise, member)
  t.is((await stamp.key('blob')).kid, K2.kid)
  const before = await stampedBlob(stamp, 1)
  const ch = attachBlob(await link(t, port), { role: 'member' })
  t.alike(await ch.put(before.frames[0]), { ok: true, reason: null })

  blobKeys = [K3, K2]
  await seeder._dmTick()
  await t.exception(stamp.key('blob'), 'the tick closed the channel of the old blob kid')
  const again = stampChannel(noise, member)
  t.is(await again.supported, true, 'the same socket reopens it')
  t.is((await again.key('blob')).kid, K3.kid, 'under the new blob kid')
  t.is((await again.key()).kid, K1.kid, 'the DM key is unchanged')
  const after = await stampedBlob(again, 1)
  t.alike(await ch.put(after.frames[0]), { ok: true, reason: null }, 'a chunk under the new kid is stored')
  t.ok(b4a.equals(seeder.blobChunk(before.id, 0), before.frames[0]), 'the chunk under the previous kid is still served')
})

test('seeder blob: replacing a blob key file that held the DM key restores blob stamps on the next tick', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = dmOption({ dataDir })
  await dm.postage.get()
  const blobFile = path.join(dataDir, 'blob-postage.json')
  fs.copyFileSync(path.join(dataDir, 'dm-postage.json'), blobFile)
  const { seeder, events, port } = await startSeeder(t, bootstrap, dataDir, assoc, dm)

  const member = await admittedMember(t, port, assoc, events)
  const noise = await link(t, port)
  const stamp = stampChannel(noise, member, { requestTimeoutMs: 2000 })
  t.ok((await dmIssue(stamp)).ok, 'DM stamps work')
  await t.exception(stamp.key('blob'), 'the shared key gives no blob kind')
  await seeder._dmTick()
  const still = stampChannel(noise, member, { requestTimeoutMs: 2000 })
  t.ok((await dmIssue(still)).ok, 'DM stamps work after a tick on the same file')
  await t.exception(still.key('blob'), 'and blob stamps stay refused')

  const separate = { ...rsaKey(), createdAt: Date.now() }
  fs.writeFileSync(blobFile, JSON.stringify({ v: 2, keys: [separate] }), { mode: 0o600 })
  await seeder._dmTick()
  const fresh = stampChannel(noise, member, { requestTimeoutMs: 5000 })
  t.is(await fresh.supported, true, 'the same socket reopens the stamp channel')
  const blobKey = await fresh.key('blob').catch(() => null)
  t.is(blobKey === null ? null : blobKey.kid, separate.kid, 'under the replaced blob key, without a restart')
  if (blobKey === null) return
  const blob = await stampedBlob(fresh, 1)
  const ch = attachBlob(await link(t, port), { role: 'member' })
  t.alike(await ch.put(blob.frames[0]), { ok: true, reason: null }, 'a chunk under the new blob key is stored')
  t.ok((await dmIssue(fresh)).ok, 'DM stamps keep working')
  t.alike(Object.values(readJson(path.join(dataDir, 'blob-stamps.json')).days[member.ownKey]), [1])
  t.absent(JSON.stringify(events).includes(separate.d), 'no key material in the log')
})
