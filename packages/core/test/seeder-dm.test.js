'use strict'

// Direct messages on the seeder (docs/protocol.md section 11): the pool and
// the stamp channel over a member link with a fresh Noise key and an empty
// inventory, as a member opens them.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder } = require('../lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { memberCertRecord } = require('../lib/records')
const { generateNoiseKeyPair, attachAdmission } = require('../lib/net')
const { attachDm } = require('../lib/dm-net')
const { attachDmStamp } = require('../lib/dm-stamp-net')
const { attachDmNotice, DM_NOTICE_PROTOCOL } = require('../lib/dm-notice-net')
const { DM_NOTICE_BOX_BYTES, DM_NOTICE_TTL_MS } = require('../lib/dm-notice')
const { encodeDrop, decodeDrop, DM_SEALED_BYTES, DM_PROTOCOL_V2, VISIT_PROTOCOL } = require('../lib/dm')
const clock = require('../lib/clock')
const { signNoticeProof } = require('../lib/notices-v2')
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
const K2 = rsaKey()
const K3 = rsaKey()

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
  const accepted = []
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    accepted.push(seeder.acceptStream(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(() => resolve())), { force: true })
  return { seeder, events, port: server.address().port }
}

// A member link: fresh Noise key, an empty inventory (the seeder drops a peer
// that refuses admission), then the dm channels.
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

function diary () {
  const kp = hcrypto.keyPair()
  return { ownKey: hex(kp.publicKey), sign: (payload) => signNoticeProof(payload, kp) }
}

// A member diary the seeder admits: its own link, announce, wait for
// 'admitted'. A compat core (key = Ed25519 public key, as a browser diary),
// so its key pair signs the stamp proofs.
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

// A stamp from the seeder for `member`, or { error }.
async function issue (stamp, pub) {
  const n = BigInt(pub.n)
  const token = postage.newToken(n)
  const { blinded, r } = postage.blind(postage.representative(token), n)
  const got = await stamp.issue(postage.toBase64(blinded))
  if (got.error) return got
  const sig = postage.unblind(postage.fromBase64(got.sig), r, n)
  return { kid: got.kid, token, sig }
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

// A stamp made directly with a key (as an older or newer seeder key would).
function directStamp (key) {
  const n = BigInt(key.n)
  const token = postage.newToken(n)
  const sig = postage.modPow(postage.representative(token), BigInt(key.d), n)
  return { kid: key.kid, token, sig }
}

function stampChannel (noise, member) {
  return attachDmStamp(noise, { role: 'member', ownKey: member.ownKey, sign: member.sign })
}

function noDiaryKey (t, events, member) {
  const text = JSON.stringify(events.filter((e) => e.event === 'dm' || e.event === 'dm-stamp'))
  t.ok(text.length > 2)
  t.absent(text.includes(member.ownKey), 'the dm log has no diary key')
}

test('seeder dm: a stamped drop is stored, paged, kept across a restart; bad stamps and the budget', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  let gets = 0
  const dm = {
    postage: { get: async () => { gets++; return { keys: [K1] } } },
    stampsPerDay: 2
  }
  const first = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  t.is(gets, 0, 'start never asks for the postage key')

  const stranger = diary()
  const sNoise = await link(t, first.port)
  const sStamp = stampChannel(sNoise, stranger)
  t.alike(await issue(sStamp, await sStamp.key()), { error: 'teto' }, 'a diary the seeder does not admit gets no stamp')
  t.absent(fs.existsSync(path.join(dataDir, 'dm-stamps.json')), 'and adds no row')

  const member = await admittedMember(t, first.port, assoc, first.events)
  const noise = await link(t, first.port)
  const stamp = stampChannel(noise, member)
  t.is(await stamp.supported, true)
  const pub = await stamp.key()
  t.alike(pub, postage.publicKey(BigInt(K1.n)), 'the key answer is the current public key')
  t.absent('d' in pub, 'the public answer has no d')

  const s1 = await issue(stamp, pub)
  t.is(s1.kid, K1.kid)
  const s2 = await issue(stamp, pub)
  t.ok(s2.sig)
  t.alike(await issue(stamp, pub), { error: 'teto' }, 'teto after stampsPerDay')
  const budget = JSON.parse(fs.readFileSync(path.join(dataDir, 'dm-stamps.json'), 'utf8'))
  t.is(budget.v, 2)
  t.alike(Object.values(budget.days[member.ownKey]), [2])
  t.is(fs.statSync(path.join(dataDir, 'dm-stamps.json')).mode & 0o777, 0o600)

  const anon = await link(t, first.port)
  const ch = attachDm(anon, { role: 'member' })
  t.is(await ch.supported, true)
  const bytes = dropFor(s1)
  t.alike(await ch.put(bytes), { ok: true, reason: null })
  const bad = dropFor({ ...s2, sig: s2.sig + 1n })
  t.alike(await ch.put(bad), { ok: false, reason: 'invalido' }, 'a bad stamp is invalido')
  const page = await ch.requestPage({ after: 0, limit: 8 })
  t.is(page.items.length, 1)
  t.alike(page.items[0].bytes, bytes)
  t.ok(first.events.some((e) => e.event === 'dm' && e.reason === 'guardada'))
  t.ok(first.events.some((e) => e.event === 'dm' && e.reason === 'invalido'))
  noDiaryKey(t, first.events, member)
  await first.seeder.close()

  const again = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  const anon2 = await link(t, again.port)
  const ch2 = attachDm(anon2, { role: 'member' })
  const page2 = await ch2.requestPage({ after: 0, limit: 8 })
  t.is(page2.items.length, 1, 'the drop survives a restart')
  t.alike(page2.items[0].bytes, bytes)
  t.alike(await ch2.put(dropFor({ ...s1, kid: s1.kid })), { ok: false, reason: 'invalido' }, 'a spent token is refused after restart')
  const noise2 = await link(t, again.port)
  const stamp2 = stampChannel(noise2, member)
  await stamp2.supported
  t.alike(await issue(stamp2, await stamp2.key()), { error: 'teto' }, 'the budget survives a restart')
  t.absent(fs.existsSync(path.join(dataDir, 'dm-postage.json')), 'the seeder writes no postage file itself')
})

test('seeder dm: current and previous kid accepted, a dropped kid is invalido', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  let keys = [K2, K1]
  const { port } = await startSeeder(t, bootstrap, dataDir, assoc, { postage: { get: async () => ({ keys }) } })
  const ch = attachDm(await link(t, port), { role: 'member' })
  t.alike(await ch.put(dropFor(directStamp(K2))), { ok: true, reason: null }, 'current kid')
  t.alike(await ch.put(dropFor(directStamp(K1))), { ok: true, reason: null }, 'previous kid')
  keys = [K3, K2, K1]
  t.alike(await ch.put(dropFor(directStamp(K1))), { ok: false, reason: 'invalido' }, 'a third key never counts')
  keys = [K3, K2]
  t.alike(await ch.put(dropFor(directStamp(K2))), { ok: true, reason: null }, 'previous after rotation')
  t.alike(await ch.put(dropFor(directStamp(K1))), { ok: false, reason: 'invalido' }, 'dropped kid')
  const member = diary()
  const stamp = stampChannel(await link(t, port), member)
  t.is((await stamp.key()).kid, K3.kid, 'stamps are issued under the current key only')
})

test('seeder dm: a rotation under an open stamp channel never issues under the old key', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  let keys = [K1]
  const { seeder, port, events } = await startSeeder(t, bootstrap, dataDir, assoc, { postage: { get: async () => ({ keys }) }, stampsPerDay: 10 })
  const member = await admittedMember(t, port, assoc, events)
  const noise = await link(t, port)
  const stamp = stampChannel(noise, member)
  const pub1 = await stamp.key()
  t.is((await issue(stamp, pub1)).kid, K1.kid)

  keys = [K2, K1]
  const ch = attachDm(await link(t, port), { role: 'member' })
  t.alike(await ch.put(dropFor(directStamp(K2))), { ok: true, reason: null }, 'a put loads the rotated keys')
  t.alike(await issue(stamp, pub1), { error: 'ruim' }, 'the old channel signs nothing once its key is not current')

  await seeder._dmTick()
  let closed = false
  try {
    await stamp.key()
  } catch {
    closed = true
  }
  t.ok(closed, 'the refresh closed the stale stamp channel')
  const again = stampChannel(noise, member)
  t.is(await again.supported, true, 'the same socket reopens the channel')
  const pub2 = await again.key()
  t.is(pub2.kid, K2.kid)
  const s = await issue(again, pub2)
  t.is(s.kid, K2.kid, 'the next issue is under the new kid')
  t.alike(await ch.put(dropFor(s)), { ok: true, reason: null })
})

test('seeder dm: a blob key file that fails first is retried by the tick and reaches the open stamp channel', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  let blobBroken = true
  let blobGets = 0
  const { seeder, port, events } = await startSeeder(t, bootstrap, dataDir, assoc, {
    postage: { get: async () => ({ keys: [K1] }) },
    blobPostage: {
      get: async () => {
        blobGets++
        if (blobBroken) throw new Error('broken key file')
        return { keys: [K2] }
      }
    },
    stampsPerDay: 10
  })
  const member = await admittedMember(t, port, assoc, events)
  const noise = await link(t, port)
  const stamp = stampChannel(noise, member)
  const pub1 = await stamp.key()
  t.is((await issue(stamp, pub1)).kid, K1.kid, 'DM stamps work while the blob key fails')
  t.ok(blobGets >= 1, 'the attach tried the blob key')
  t.ok(events.some((e) => e.event === 'dm-stamp' && e.reason === 'blob-postage'))

  const failed = blobGets
  await seeder._dmTick()
  t.is(blobGets, failed + 1, 'the tick retries a blob key that never loaded')
  t.is((await issue(stamp, pub1)).kid, K1.kid, 'DM stamps still work after a failed retry')

  blobBroken = false
  await seeder._dmTick()
  let closed = false
  try {
    await stamp.key()
  } catch {
    closed = true
  }
  t.ok(closed, 'the tick closed the stamp channel that had no blob kind')
  const again = stampChannel(noise, member)
  t.is(await again.supported, true, 'the same socket reopens the channel')
  const blobPub = await again.key('blob')
  t.is(blobPub.kid, K2.kid, 'the reopened channel has the blob key')
  const n = BigInt(blobPub.n)
  const token = postage.newToken(n, 'blob')
  const { blinded, r } = postage.blind(postage.representative(token, 'blob'), n)
  const got = await again.issue(postage.toBase64(blinded), 'blob')
  t.is(got.kid, K2.kid)
  t.ok(postage.verify(token, postage.unblind(postage.fromBase64(got.sig), r, n), blobPub, 'blob'), 'the blob stamp verifies')
  t.is((await issue(again, await again.key())).kid, K1.kid, 'DM stamps keep working')
})

test('seeder dm: disabled leaves both channels unsupported and needs no postage', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const { port } = await startSeeder(t, bootstrap, dataDir, assoc, null)
  const noise = await link(t, port)
  t.is(await attachDm(noise, { role: 'member' }).supported, false)
  const member = diary()
  t.is(await stampChannel(noise, member).supported, false)
  await until(() => true)
  t.absent(fs.existsSync(path.join(dataDir, 'dm-pool')), 'no pool dir')
  t.absent(fs.existsSync(path.join(dataDir, 'dm-postage.json')))
})

test('seeder dm: a postage failure leaves the put uncertain, never invalido', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  let broken = true
  const { port, events } = await startSeeder(t, bootstrap, dataDir, assoc, {
    postage: { get: async () => { if (broken) throw new Error('dm-postage inválido'); return { keys: [K1] } } }
  })
  const ch = attachDm(await link(t, port), { role: 'member' })
  await ch.supported
  const stamped = dropFor(directStamp(K1))
  let failed = null
  try {
    await ch.put(stamped)
  } catch (err) {
    failed = err
  }
  t.ok(failed, 'the put has no ack: the channel closed')
  t.absent(events.some((e) => e.event === 'dm' && e.reason === 'invalido'), 'nothing was called invalido')
  broken = false
  const ch2 = attachDm(await link(t, port), { role: 'member' })
  t.alike(await ch2.put(stamped), { ok: true, reason: null }, 'the same drop goes through once the key is back')
})

test('seeder dm: stamp budget rows, members only, no new allowance on a clock step back', (t) => {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const seeder = new Seeder({ dataDir, maxServed: 2, dm: { postage: { get: async () => ({ keys: [K1] }) }, stampsPerDay: 2 } })
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)
  const d = 'd'.repeat(64)
  t.is(seeder._takeStamp(a, '2026-11-03'), false, 'not admitted: no stamp')
  t.is(seeder._dmStamps.size, 0, 'and no row')
  for (const k of [a, b, c, d]) seeder._admitted.set(k, {})
  t.is(seeder._takeStamp(a, '2026-11-04'), true)
  t.is(seeder._takeStamp(a, '2026-11-04'), true)
  t.is(seeder._takeStamp(a, '2026-11-04'), false, 'teto')
  t.is(seeder._takeStamp(b, '2026-11-04'), true)
  t.is(seeder._takeStamp(c, '2026-11-04'), true)
  t.is(seeder._takeStamp(d, '2026-11-04'), true)
  t.is(seeder._dmStamps.size, 4, 'rows up to the cap (2 * maxServed)')
  const e = 'e'.repeat(64)
  seeder._admitted.set(e, {})
  t.is(seeder._takeStamp(e, '2026-11-04'), false, 'past the cap no new row')
  t.is(seeder._dmStamps.size, 4)

  t.is(seeder._takeStamp(a, '2026-11-06'), true, 'two days later: a fresh day')
  t.is(seeder._takeStamp(a, '2026-11-04'), false, 'stepped back to the exhausted day: still exhausted')
  t.is(seeder._dmStamps.size, 4, 'other diaries keep their rows across the jump')
  t.is(seeder._takeStamp(b, '2026-11-04'), true, 'and their counts')
  t.is(seeder._takeStamp(b, '2026-11-04'), false)
  t.alike(seeder._dmStamps.get(a), { '2026-11-06': 1, '2026-11-04': 2 })

  for (const day of ['2026-11-07', '2026-11-08', '2026-11-09']) t.is(seeder._takeStamp(a, day), true)
  t.alike(Object.keys(seeder._dmStamps.get(a)).sort(), ['2026-11-07', '2026-11-08', '2026-11-09'], 'at most 3 days per diary')

  t.is(seeder._takeStamp(e, '2026-11-20'), true, 'days older than 7 are dropped, then room again')
  t.alike([...seeder._dmStamps.keys()].sort(), [e])
  const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'dm-stamps.json'), 'utf8'))
  t.alike(file, { v: 2, days: { [e]: { '2026-11-20': 1 } } })
})

test('seeder dm: _checkStamp answers as _takeStamp would and writes nothing', (t) => {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const seeder = new Seeder({ dataDir, maxServed: 1, dm: { postage: { get: async () => ({ keys: [K1] }) }, stampsPerDay: 2 } })
  const file = path.join(dataDir, 'dm-stamps.json')
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)
  t.is(seeder._checkStamp(a, '2026-11-04'), false, 'not admitted')
  t.absent(fs.existsSync(file), 'check writes no file')
  for (const k of [a, b, c]) seeder._admitted.set(k, {})
  const steps = [
    [a, '2026-11-04'], [a, '2026-11-04'], [a, '2026-11-04'],
    [b, '2026-11-04'], [c, '2026-11-04'],
    [c, '2026-11-20'], [a, '2026-11-20']
  ]
  for (const [k, day] of steps) {
    const before = JSON.stringify([...seeder._dmStamps])
    const checked = seeder._checkStamp(k, day)
    t.is(JSON.stringify([...seeder._dmStamps]), before, 'check mutates nothing')
    t.is(checked, seeder._takeStamp(k, day), 'check matches take for ' + k[0] + ' ' + day)
  }
  t.is(seeder._checkStamp('f'.repeat(64), '2026-11-20'), false, 'unknown diary')
})

test('seeder dm: a tick with no dm peer never asks for the postage keys', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  let gets = 0
  const { seeder, port } = await startSeeder(t, bootstrap, dataDir, assoc, {
    postage: { get: async () => { gets++; return { keys: [K1] } } }
  })
  await seeder._dmTick()
  await seeder._dmTick()
  t.is(gets, 0, 'no get() before a dm peer loads the keys')
  t.absent(fs.existsSync(path.join(dataDir, 'dm-postage.json')), 'no postage file')
  const ch = attachDm(await link(t, port), { role: 'member' })
  t.alike(await ch.put(dropFor(directStamp(K1))), { ok: true, reason: null })
  const loaded = gets
  await seeder._dmTick()
  t.is(gets, loaded + 1, 'once loaded, the tick refreshes the keys')
})

test('seeder dm: dm-stamps.json v1 is read as one day per diary', async (t) => {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const a = 'a'.repeat(64)
  fs.writeFileSync(path.join(dataDir, 'dm-stamps.json'), JSON.stringify({ v: 1, days: { [a]: { day: '2026-11-04', count: 2 } } }))
  const seeder = new Seeder({ dataDir, dm: { postage: { get: async () => ({ keys: [K1] }) }, stampsPerDay: 2 } })
  seeder._openDm()
  t.teardown(() => seeder.close())
  seeder._admitted.set(a, {})
  t.alike(seeder._dmStamps.get(a), { '2026-11-04': 2 })
  t.is(seeder._takeStamp(a, '2026-11-04'), false)
})

test('seeder dm: the copy allowance counts per ISO week, apart from the daily blob and DM stamps', (t) => {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const seeder = new Seeder({ dataDir, maxServed: 2, dm: { postage: { get: async () => ({ keys: [K1] }) }, stampsPerDay: 1, blobStampsPerDay: 1, copyStampsPerWeek: 2 } })
  const a = 'a'.repeat(64)
  t.is(seeder._takeStamp(a, '2026-W47', 'copy'), false, 'not admitted: no stamp')
  seeder._admitted.set(a, {})
  t.is(seeder._checkStamp(a, '2026-W47', 'copy'), true)
  t.is(seeder._takeStamp(a, '2026-W47', 'copy'), true)
  t.is(seeder._takeStamp(a, '2026-W47', 'copy'), true)
  t.is(seeder._checkStamp(a, '2026-W47', 'copy'), false, 'teto, checked without signing')
  t.is(seeder._takeStamp(a, '2026-W47', 'copy'), false, 'teto')
  t.is(seeder._takeStamp(a, '2026-11-16', 'blob'), true, 'the daily blob allowance is untouched')
  t.is(seeder._takeStamp(a, '2026-11-16'), true, 'and the DM one')
  t.is(seeder._takeStamp(a, '2026-W48', 'copy'), true, 'the next week is a fresh allowance')
  t.is(seeder._takeStamp(a, '2026-W47', 'copy'), false, 'stepped back to the exhausted week: still exhausted')
  t.is(seeder._takeStamp(a, '2026-11-16', 'copy'), false, 'a day is not a week')
  t.is(seeder._takeStamp(a, 'nope', 'copy'), false, 'a malformed period')
  const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'copy-stamps.json'), 'utf8'))
  t.alike(file, { v: 2, days: { [a]: { '2026-W47': 2, '2026-W48': 1 } } })
  t.absent(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, 'blob-stamps.json'), 'utf8'))).includes('W47'))
  for (const w of ['2026-W49', '2026-W50', '2026-W51', '2026-W52']) t.is(seeder._takeStamp(a, w, 'copy'), true)
  t.alike(Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'copy-stamps.json'), 'utf8')).days[a]).sort(), ['2026-W50', '2026-W51', '2026-W52'].sort(), 'a few recent weeks only')
})

test('seeder dm: copy-stamps.json is read back after a restart and a day key in it is refused', async (t) => {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const a = 'a'.repeat(64)
  fs.writeFileSync(path.join(dataDir, 'copy-stamps.json'), JSON.stringify({ v: 2, days: { [a]: { '2026-W47': 2 } } }))
  const seeder = new Seeder({ dataDir, dm: { postage: { get: async () => ({ keys: [K1] }) }, blobPostage: { get: async () => ({ keys: [K2] }) }, copyStampsPerWeek: 2 } })
  seeder._openDm()
  t.teardown(() => seeder.close())
  seeder._admitted.set(a, {})
  t.alike(seeder._copyStamps.get(a), { '2026-W47': 2 })
  t.is(seeder._takeStamp(a, '2026-W47', 'copy'), false, 'the count survives a restart')
  t.exception.all(() => new Seeder({ dm: { postage: { get () {} }, copyStampsPerWeek: 0 } }), /copyStampsPerWeek/)
})

// The seeder's ack comes before its take and onNotice, both synchronous, so
// once notice() resolves the seeder has decided.
test('seeder dm: a wake passes the box on once, only for a new drop stored on the same socket', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const notices = []
  const { events, port } = await startSeeder(t, bootstrap, dataDir, assoc, {
    postage: { get: async () => ({ keys: [K1] }) },
    onNotice: (...args) => notices.push(args)
  })
  const realNow = clock.now
  let skew = 0
  clock.now = () => realNow() + skew
  t.teardown(() => { clock.now = realNow })

  const a = await link(t, port)
  const dmA = attachDm(a, { role: 'member' })
  const noteA = attachDmNotice(a, { role: 'member' })
  t.is(await noteA.supported, true, 'the seeder answers the notice channel')
  const bytes = dropFor(directStamp(K1))
  const id = hex(decodeDrop(bytes).dropId)
  const box = hcrypto.randomBytes(DM_NOTICE_BOX_BYTES)

  t.is(await noteA.notice(id, box), true, 'a wake before any put is acked')
  t.alike(notices, [], 'and passes nothing on')

  t.alike(await dmA.put(bytes), { ok: true, reason: null })
  const b = await link(t, port)
  const noteB = attachDmNotice(b, { role: 'member' })
  t.is(await noteB.notice(id, box), true, 'a wake on another socket is acked')
  t.alike(notices, [], 'and passes nothing on')

  t.is(await noteA.notice(id, box), true)
  t.is(notices.length, 1, 'the wake on the socket that stored the drop passes the box on')
  t.is(notices[0].length, 1, 'onNotice gets the box only')
  t.ok(b4a.isBuffer(notices[0][0]))
  t.alike(notices[0][0], box, 'the same bytes, unopened')

  t.is(await noteA.notice(id, box), true, 'a second wake of the same id is acked')
  t.is(notices.length, 1, 'and passes nothing on')

  t.alike(await dmA.put(bytes), { ok: true, reason: null }, 'a repeated put is a success')
  t.is(await noteA.notice(id, box), true)
  t.is(notices.length, 1, 'a repeated put opens no new wake')

  const dmB = attachDm(b, { role: 'member' })
  t.alike(await dmB.put(bytes), { ok: true, reason: null })
  t.is(await noteB.notice(id, box), true)
  t.is(notices.length, 1, 'nor does a repeated put on another socket')

  const late = dropFor(directStamp(K1))
  t.alike(await dmA.put(late), { ok: true, reason: null })
  skew += DM_NOTICE_TTL_MS + 1000
  t.is(await noteA.notice(hex(decodeDrop(late).dropId), box), true, 'a late wake is acked')
  t.is(notices.length, 1, 'and passes nothing on')

  const v2 = attachDm(a, { role: 'member', protocol: DM_PROTOCOL_V2 })
  t.is(await v2.supported, true)
  const bucketed = dropFor(directStamp(K1))
  t.alike(await v2.put(bucketed, 0), { ok: true, reason: null })
  const box2 = hcrypto.randomBytes(DM_NOTICE_BOX_BYTES)
  t.is(await noteA.notice(decodeDrop(bucketed).dropId, box2), true)
  t.is(notices.length, 2, 'a drop stored on the bucketed lane opens a wake too')
  t.alike(notices[1][0], box2)

  const visit = attachDm(a, { role: 'member', protocol: VISIT_PROTOCOL })
  const ping = dropFor(directStamp(K1))
  t.alike(await visit.put(ping), { ok: true, reason: null })
  t.is(await noteA.notice(decodeDrop(ping).dropId, box), true)
  t.is(notices.length, 2, 'a visit ping opens none')

  t.is(noteA.badMessages, 0)
  t.absent(JSON.stringify(events).includes(id), 'no drop id in the log')
  t.absent(JSON.stringify(events).includes(b4a.toString(box, 'base64')), 'no box in the log')
})

test('seeder dm: with no onNotice a wake is acked and dropped', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const { seeder, port } = await startSeeder(t, bootstrap, dataDir, assoc, { postage: { get: async () => ({ keys: [K1] }) } })
  const a = await link(t, port)
  const dmA = attachDm(a, { role: 'member' })
  const note = attachDmNotice(a, { role: 'member' })
  const bytes = dropFor(directStamp(K1))
  t.alike(await dmA.put(bytes), { ok: true, reason: null })
  t.is(await note.notice(decodeDrop(bytes).dropId, hcrypto.randomBytes(DM_NOTICE_BOX_BYTES)), true)
  t.ok(seeder._peers.size > 0, 'the link stays up')
  t.alike(await dmA.put(bytes), { ok: true, reason: null }, 'and the DM lane still answers')
})

test('seeder dm: without the dm option the notice channel is not answered', async (t) => {
  t.timeout(90000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const { port } = await startSeeder(t, bootstrap, dataDir, assoc, null)
  const note = attachDmNotice(await link(t, port), { role: 'member' })
  t.is(await note.supported, false)
  t.is(note.protocol, DM_NOTICE_PROTOCOL)
})

test('seeder dm: invalid options are refused', (t) => {
  t.exception.all(() => new Seeder({ dm: {} }), /dm.postage.get/)
  t.exception.all(() => new Seeder({ dm: { postage: { get () {} }, stampsPerDay: 0 } }), /stampsPerDay/)
  t.exception.all(() => new Seeder({ dm: { postage: { get () {} }, onNotice: 1 } }), /onNotice/)
})

test('seeder dm: a blocked diary loses its dm, blob and copy stamp rows, in memory, on disk and after a restart', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const dataDir = prepareSeederDir(t, assoc)
  const dm = { postage: { get: async () => ({ keys: [K1] }) }, blobPostage: { get: async () => ({ keys: [K2] }) } }
  const { seeder } = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)
  for (const k of [a, b]) {
    seeder._admitted.set(k, {})
    t.ok(seeder._takeStamp(k, '2026-11-16'))
    t.ok(seeder._takeStamp(k, '2026-11-16', 'blob'))
    t.ok(seeder._takeStamp(k, '2026-W47', 'copy'))
  }
  const files = ['dm-stamps.json', 'blob-stamps.json', 'copy-stamps.json']
  const onDisk = (name) => Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')).days).sort()
  for (const name of files) t.alike(onDisk(name), [a, b], name + ' holds both rows')

  const kp = hcrypto.keyPair()
  const mod = { kp, cert: createModeratorCert({ moderator: hex(kp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp) }
  const result = await seeder._offerBlocklist(createSnapshot({ seq: 1, blocked: [a] }, mod.kp, mod.cert), null)
  t.ok(result.adopted)
  for (const table of [seeder._dmStamps, seeder._blobStamps, seeder._copyStamps]) t.alike([...table.keys()], [b], 'only the unblocked row stays in memory')
  for (const name of files) t.alike(onDisk(name), [b], name + ' keeps only the unblocked row')
  t.alike(seeder._dmStamps.get(b), { '2026-11-16': 1 }, 'the other diary keeps its count')
  await seeder.close()

  const reread = new Seeder({ dataDir, dm })
  reread._openDm()
  t.teardown(() => reread.close())
  for (const table of [reread._dmStamps, reread._blobStamps, reread._copyStamps]) t.alike([...table.keys()], [b], 'a restart reads no row for the blocked diary')
  await reread.close()

  // A row of an already blocked diary still on disk (a stop before the
  // prune) goes at the next start.
  fs.writeFileSync(path.join(dataDir, 'dm-stamps.json'), JSON.stringify({ v: 2, days: { [a]: { '2026-11-16': 1 }, [c]: { '2026-11-16': 2 } } }))
  const { seeder: again } = await startSeeder(t, bootstrap, dataDir, assoc, dm)
  t.alike([...again._dmStamps.keys()], [c], 'the start drops the blocked row')
  t.alike(onDisk('dm-stamps.json'), [c])
})
