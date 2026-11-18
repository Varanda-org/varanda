'use strict'

// The 'varanda/dm-stamp/1' channel over two in-memory NoiseSecretStreams, as
// notices-net.test.js. No DHT at all. One RSA-2048 key per run, generated on
// the spot (AGENTS.md); dm-postage does the blind signature.
const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  attachDmStamp, encodeProof, verifyProof, encodeProofV2, verifyProofV2, validateDmStampMessage,
  DM_STAMP_PROOF_PREFIX, DM_STAMP_PROOF_PREFIX_V2, MAX_BAD_DM_STAMP, MAX_TETO_DM_STAMP
} = require('../lib/dm-stamp-net')
const { DM_STAMP_PROTOCOL } = require('../lib/dm')
const postage = require('../lib/dm-postage')
const { noticeV2Payload, signNoticeProof } = require('../lib/notices-v2')
const { until } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const clock = require('../lib/clock')

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

const RSA = (() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  return { n: fromBase64url(jwk.n), d: fromBase64url(jwk.d) }
})()
const PUB = postage.publicKey(RSA.n)
// The blob key pair: separate from the DM one, as on the seeder.
const BLOB_RSA = (() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  return { n: fromBase64url(jwk.n), d: fromBase64url(jwk.d) }
})()
const BLOB_PUB = postage.publicKey(BLOB_RSA.n)

function seederBlobPostage () {
  return { publicKey: BLOB_PUB, sign: (blinded) => postage.sign(blinded, BLOB_RSA.n, BLOB_RSA.d) }
}

function seederPostage () {
  return { publicKey: PUB, sign: (blinded) => postage.sign(blinded, RSA.n, RSA.d) }
}

function counterBudget (limit) {
  const calls = []
  const used = new Map()
  return {
    calls,
    take (diary, day) {
      calls.push({ diary, day })
      const k = diary + ' ' + day
      const n = used.get(k) || 0
      if (n >= limit) return false
      used.set(k, n + 1)
      return true
    }
  }
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

function member () {
  const kp = hcrypto.keyPair()
  return { kp, ownKey: b4a.toString(kp.publicKey, 'hex'), sign: (payload) => signNoticeProof(payload, kp) }
}

// A core node's diary: a real Corestore 7 core, whose key is the hash of its
// signer's one-signer manifest, signed with that core's key pair.
async function manifestDiary (t) {
  const store = new Corestore(tmpDir(t, 'varanda-dm-stamp-'))
  t.teardown(() => store.close(), { force: true })
  const core = store.get({ name: 'diary' })
  await core.ready()
  const kp = core.keyPair
  return {
    kp,
    ownKey: b4a.toString(core.key, 'hex'),
    ownSigner: b4a.toString(kp.publicKey, 'hex'),
    sign: (payload) => hcrypto.sign(payload, kp.secretKey)
  }
}

function rawPeer (noise) {
  const received = []
  const ch = noise.userData.createChannel({ protocol: DM_STAMP_PROTOCOL })
  const m = ch.addMessage({
    encoding: c.buffer,
    onmessage: (buf) => received.push(JSON.parse(b4a.toString(buf, 'utf8')))
  })
  ch.open()
  return {
    received,
    opened: ch.fullyOpened(),
    sendJson: (o) => m.send(b4a.from(JSON.stringify(o), 'utf8'))
  }
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function blindedToken () {
  const token = postage.newToken(RSA.n)
  const { blinded, r } = postage.blind(postage.representative(token), RSA.n)
  return { token, r, blinded: postage.toBase64(blinded) }
}

test('proof binds the Noise key and the diary; a notices-v2 signature never verifies', (t) => {
  const m = member()
  const nonce = 'ab'.repeat(32)
  const noise = 'cd'.repeat(32)
  t.is(b4a.toString(encodeProof(nonce, noise, m.ownKey), 'utf8'), DM_STAMP_PROOF_PREFIX + nonce + '\n' + noise + '\n' + m.ownKey)
  const sig = hex(m.sign(encodeProof(nonce, noise, m.ownKey)))
  t.ok(verifyProof({ nonce, noise, key: m.ownKey }, sig))
  t.absent(verifyProof({ nonce, noise: 'ef'.repeat(32), key: m.ownKey }, sig), 'other Noise key')
  t.absent(verifyProof({ nonce, noise, key: member().ownKey }, sig), 'other diary')
  t.absent(verifyProof({ nonce: 'ee'.repeat(32), noise, key: m.ownKey }, sig), 'other nonce')
  const v2 = hex(m.sign(noticeV2Payload(nonce, noise, m.ownKey)))
  t.absent(verifyProof({ nonce, noise, key: m.ownKey }, v2), 'notices-v2 proof')
  t.absent(verifyProof(null, sig))
  t.absent(verifyProof({ nonce, noise, key: m.ownKey }, 'zz'))
})

test('a member proves, reads the key and gets a blind stamp that verifies', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const logged = []
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget, log: (e) => logged.push(e), now: () => Date.parse('2026-11-03T12:00:00.000Z') })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.is(await hm.supported, true)
  t.is(await hm.proved, true)

  const pub = await hm.key()
  t.alike(pub, PUB)
  const bt = blindedToken()
  const stamp = await hm.issue(bt.blinded)
  t.is(stamp.kid, PUB.kid)
  const sig = postage.unblind(postage.fromBase64(stamp.sig), bt.r, RSA.n)
  t.ok(postage.verify(bt.token, sig, pub), 'the unblinded stamp verifies')
  t.alike(budget.calls, [{ diary: m.ownKey, day: '2026-11-03' }])
  t.alike(logged, [{ event: 'dm-stamp', reason: 'ok' }])
  t.is(hs.badMessages + hm.badMessages, 0)
})

test('over budget is teto; a value the key cannot sign is ruim; the log has no key', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(1)
  const logged = []
  attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget, log: (e) => logged.push(e) })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.ok((await hm.issue(blindedToken().blinded)).sig)
  t.alike(await hm.issue(blindedToken().blinded), { error: 'teto' })
  const tooBig = postage.toBase64(RSA.n + 1n)
  t.alike(await hm.issue(tooBig), { error: 'ruim' })
  t.is(budget.calls.length, 2, 'ruim spends no budget')
  t.alike(logged.map((e) => e.reason), ['ok', 'teto', 'ruim'])
  const sink = JSON.stringify(logged)
  t.absent(sink.includes(m.ownKey), 'no diary hex in the log')
  t.absent(sink.includes(hex(a.remotePublicKey)), 'no Noise key in the log')
  for (const e of logged) t.alike(Object.keys(e), ['event', 'reason'])
})

test('a sign failure answers ruim and takes no budget', async (t) => {
  const m = member()
  for (const sign of [() => null, () => { throw new Error('rsa') }, () => RSA.n]) {
    const s = streams(t)
    const budget = counterBudget(5)
    const logged = []
    attachDmStamp(s.a, { role: 'seeder', postage: { publicKey: PUB, sign }, budget, log: (e) => logged.push(e) })
    const hm = attachDmStamp(s.b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
    t.alike(await hm.issue(blindedToken().blinded), { error: 'ruim' })
    t.is(budget.calls.length, 0, 'budget untouched')
    t.alike(logged, [{ event: 'dm-stamp', reason: 'ruim' }])
  }
})

test('a budget.take that throws answers ruim, never teto', async (t) => {
  const m = member()
  for (const take of [() => { throw new Error('db') }, async () => { throw new Error('db') }]) {
    const s = streams(t)
    attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: { take } })
    const hm = attachDmStamp(s.b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
    t.alike(await hm.issue(blindedToken().blinded), { error: 'ruim' })
  }
})

test('budget.check false answers teto without signing; MAX_TETO_DM_STAMP in a row drop the peer', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  let signs = 0
  const checks = []
  const budget = counterBudget(5)
  budget.check = (diary, day) => {
    checks.push({ diary, day })
    return false
  }
  const logged = []
  attachDmStamp(a, {
    role: 'seeder',
    postage: { publicKey: PUB, sign: (v) => { signs++; return postage.sign(v, RSA.n, RSA.d) } },
    budget,
    log: (e) => logged.push(e),
    now: () => Date.parse('2026-11-03T12:00:00.000Z')
  })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  for (let i = 0; i < MAX_TETO_DM_STAMP - 1; i++) {
    t.alike(await hm.issue(blindedToken().blinded), { error: 'teto' })
  }
  t.is(a.destroyed, false, 'still up below the limit')
  // The drop may beat the last reply to the member.
  const last = await hm.issue(blindedToken().blinded).catch((err) => err.message)
  t.ok(last && (last.error === 'teto' || /closed|dropped/.test(last)), 'teto or closed')
  await until(() => a.destroyed, { name: 'teto drop' })
  t.is(signs, 0, 'sign never ran')
  t.is(budget.calls.length, 0, 'take never ran')
  t.is(checks.length, MAX_TETO_DM_STAMP)
  t.alike(checks[0], { diary: m.ownKey, day: '2026-11-03' })
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [{ event: 'peer-dropped', reason: 'dm-stamp-teto' }])
})

test('reopening the stamp channel on the same socket does not reset the teto run', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  budget.check = () => false
  attachDmStamp(a, { role: 'seeder', postage: { publicKey: PUB, sign: (v) => postage.sign(v, RSA.n, RSA.d) }, budget })
  const first = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  for (let i = 0; i < MAX_TETO_DM_STAMP - 1; i++) t.alike(await first.issue(blindedToken().blinded), { error: 'teto' })
  first.close()
  const again = attachDmStamp(b, { role: 'member', slot: '_reopened', ownKey: m.ownKey, sign: m.sign })
  await again.issue(blindedToken().blinded).catch(() => null)
  await until(() => a.destroyed, { name: 'teto drop after reopen' })
  t.ok(a.destroyed, 'the run counted across the reopen')
})

test('budget.check true still signs and takes; a throwing check is teto; a stamp resets the teto run', async (t) => {
  const m = member()
  const s = streams(t)
  let signs = 0
  let eligible = true
  const budget = counterBudget(5)
  budget.check = () => eligible
  attachDmStamp(s.a, {
    role: 'seeder',
    postage: { publicKey: PUB, sign: (v) => { signs++; return postage.sign(v, RSA.n, RSA.d) } },
    budget
  })
  const hm = attachDmStamp(s.b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.ok((await hm.issue(blindedToken().blinded)).sig, 'eligible diary gets a stamp')
  t.is(signs, 1)
  t.is(budget.calls.length, 1)
  eligible = false
  for (let i = 0; i < MAX_TETO_DM_STAMP - 1; i++) t.alike(await hm.issue(blindedToken().blinded), { error: 'teto' })
  eligible = true
  t.ok((await hm.issue(blindedToken().blinded)).sig, 'stamp after teto')
  eligible = false
  for (let i = 0; i < MAX_TETO_DM_STAMP - 1; i++) t.alike(await hm.issue(blindedToken().blinded), { error: 'teto' })
  t.is(s.a.destroyed, false, 'a stamp reset the run')
  t.is(signs, 2)

  const s2 = streams(t)
  const b2 = counterBudget(5)
  b2.check = () => { throw new Error('db') }
  attachDmStamp(s2.a, { role: 'seeder', postage: seederPostage(), budget: b2 })
  const hm2 = attachDmStamp(s2.b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.alike(await hm2.issue(blindedToken().blinded), { error: 'teto' })
  t.is(b2.calls.length, 0)

  const s3 = streams(t)
  t.exception.all(() => attachDmStamp(s3.a, { role: 'seeder', postage: seederPostage(), budget: { take: () => true, check: 1 } }), /invalid budget/)
})

test('requests before a proof, a notices-v2 proof and a second proof are bad', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget })
  const raw = rawPeer(b)
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'challenge' })
  t.is(raw.received[0].type, 'challenge')
  const nonce = raw.received[0].nonce

  raw.sendJson({ type: 'key' })
  await until(() => hs.badMessages === 1, { name: 'key before proof' })
  const v2 = hex(m.sign(noticeV2Payload(nonce, hex(b.publicKey), m.ownKey)))
  raw.sendJson({ type: 'proof', key: m.ownKey, sig: v2 })
  await until(() => hs.badMessages === 2, { name: 'notices-v2 proof refused' })
  raw.sendJson({ type: 'issue', blinded: blindedToken().blinded })
  await until(() => hs.badMessages === 3, { name: 'issue after a failed proof' })
  await delay(30)
  t.is(raw.received.length, 1, 'nothing answered')
  t.is(budget.calls.length, 0)

  // A proof made for another connection's Noise key, on a fresh channel.
  const other = streams(t)
  const hs2 = attachDmStamp(other.a, { role: 'seeder', postage: seederPostage(), budget })
  const raw2 = rawPeer(other.b)
  await until(() => raw2.received.length === 1, { name: 'challenge 2' })
  const n2 = raw2.received[0].nonce
  raw2.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(encodeProof(n2, hex(b.publicKey), m.ownKey))) })
  raw2.sendJson({ type: 'key' })
  await until(() => hs2.badMessages === 2, { name: 'wrong Noise key' })

  // The right proof, then a second one.
  const other3 = streams(t)
  const hs3 = attachDmStamp(other3.a, { role: 'seeder', postage: seederPostage(), budget })
  const raw3 = rawPeer(other3.b)
  await until(() => raw3.received.length === 1, { name: 'challenge 3' })
  const proof = { type: 'proof', key: m.ownKey, sig: hex(m.sign(encodeProof(raw3.received[0].nonce, hex(other3.b.publicKey), m.ownKey))) }
  raw3.sendJson(proof)
  raw3.sendJson(proof)
  raw3.sendJson({ type: 'key' })
  await until(() => raw3.received.length === 2, { name: 'key' })
  t.is(hs3.badMessages, 1)
  t.is(raw3.received[1].kid, PUB.kid)
})

test('more than MAX_BAD_DM_STAMP bad messages drop the peer; issue rate drops too', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  for (let i = 0; i <= MAX_BAD_DM_STAMP; i++) raw.sendJson({ type: 'key' })
  await until(() => a.destroyed, { name: 'dropped' })
  t.is(hs.badMessages, MAX_BAD_DM_STAMP + 1)
  t.alike(logged, [{ event: 'peer-dropped', reason: 'dm-stamp' }])

  const s = streams(t)
  const m = member()
  const logged2 = []
  attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(50), log: (e) => logged2.push(e), issueBurst: 2, issueRate: 0.001 })
  const hm = attachDmStamp(s.b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  await hm.issue(blindedToken().blinded)
  await hm.issue(blindedToken().blinded)
  await t.exception(hm.issue(blindedToken().blinded), /closed|dropped/)
  await until(() => s.a.destroyed, { name: 'rate drop' })
  t.alike(logged2.filter((e) => e.event === 'peer-dropped'), [{ event: 'peer-dropped', reason: 'dm-stamp-rate' }])
})

test('message shapes', (t) => {
  const bt = blindedToken()
  t.ok(validateDmStampMessage({ type: 'key' }))
  t.ok(validateDmStampMessage({ type: 'key', ...PUB }))
  t.absent(validateDmStampMessage({ type: 'key', ...PUB, kid: '00'.repeat(8) }), 'kid must match n')
  t.ok(validateDmStampMessage({ type: 'issue', blinded: bt.blinded }))
  t.absent(validateDmStampMessage({ type: 'issue', blinded: bt.blinded.slice(0, -4) }))
  t.ok(validateDmStampMessage({ type: 'stamp', error: 'teto' }))
  t.absent(validateDmStampMessage({ type: 'stamp', error: 'outro' }))
  t.ok(validateDmStampMessage({ type: 'stamp', kid: PUB.kid, sig: bt.blinded }))
  t.absent(validateDmStampMessage({ type: 'stamp', kid: PUB.kid, sig: bt.blinded, error: 'teto' }))
})

test('a member whose sign throws rejects proved; requests reject; the socket stays up', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5) })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: () => { throw new Error('identity locked') } })
  await t.exception(hm.proved, /identity locked/)
  await t.exception(hm.key(), /closed/)
  await delay(30)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('old clients without kind still get DM stamps when the seeder has a blob key', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const blobBudget = counterBudget(5)
  const logged = []
  attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget, blobPostage: seederBlobPostage(), blobBudget, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await until(() => raw.received.length === 1, { name: 'challenge' })
  raw.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(encodeProof(raw.received[0].nonce, hex(b.publicKey), m.ownKey))) })
  raw.sendJson({ type: 'key' })
  await until(() => raw.received.length === 2, { name: 'dm key' })
  t.alike(raw.received[1], { type: 'key', ...PUB }, 'the DM key reply is unchanged, without kind')
  const bt = blindedToken()
  raw.sendJson({ type: 'issue', blinded: bt.blinded })
  await until(() => raw.received.length === 3, { name: 'dm stamp' })
  const reply = raw.received[2]
  t.alike(Object.keys(reply), ['type', 'kid', 'sig'])
  t.is(reply.kid, PUB.kid)
  t.ok(postage.verify(bt.token, postage.unblind(postage.fromBase64(reply.sig), bt.r, RSA.n), PUB), 'a DM stamp')
  t.is(budget.calls.length, 1)
  t.is(blobBudget.calls.length, 0, 'the blob budget is untouched')
  t.alike(logged, [{ event: 'dm-stamp', reason: 'ok' }])
})

test('blob stamps: own key, own domain, own budget', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const blobBudget = counterBudget(5)
  const logged = []
  attachDmStamp(a, {
    role: 'seeder',
    postage: seederPostage(),
    budget,
    blobPostage: seederBlobPostage(),
    blobBudget,
    log: (e) => logged.push(e),
    now: () => Date.parse('2026-11-03T12:00:00.000Z')
  })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.alike(await hm.key('blob'), BLOB_PUB)
  t.alike(await hm.key(), PUB)

  const token = postage.newToken(BLOB_RSA.n, 'blob')
  const { blinded, r } = postage.blind(postage.representative(token, 'blob'), BLOB_RSA.n)
  const stamp = await hm.issue(postage.toBase64(blinded), 'blob')
  t.is(stamp.kid, BLOB_PUB.kid)
  const sig = postage.unblind(postage.fromBase64(stamp.sig), r, BLOB_RSA.n)
  t.ok(postage.verify(token, sig, BLOB_PUB, 'blob'), 'the blob stamp verifies under the blob key')
  t.absent(postage.verify(token, sig, BLOB_PUB, 'dm'), 'never as a DM stamp')
  t.absent(postage.verify(token, sig, PUB, 'dm'))
  t.alike(blobBudget.calls, [{ diary: m.ownKey, day: '2026-11-03' }])
  t.is(budget.calls.length, 0, 'the DM budget is untouched by blob issuance')

  // A DM stamp spent as a blob stamp is refused.
  const bt = blindedToken()
  const dm = await hm.issue(bt.blinded)
  const dmSig = postage.unblind(postage.fromBase64(dm.sig), bt.r, RSA.n)
  t.ok(postage.verify(bt.token, dmSig, PUB))
  t.absent(postage.verify(bt.token, dmSig, BLOB_PUB, 'blob'), 'a DM stamp under the blob key')
  t.absent(postage.verify(bt.token, dmSig, PUB, 'blob'), 'a DM stamp under the blob domain')
  t.is(budget.calls.length, 1)
  t.is(blobBudget.calls.length, 1)
  t.alike(logged, [{ event: 'blob-stamp', reason: 'ok' }, { event: 'dm-stamp', reason: 'ok' }])
})

test('cross issuance: a DM-domain value sent as a blob issue never yields a DM stamp', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const blobBudget = counterBudget(5)
  let dmSigns = 0
  attachDmStamp(a, {
    role: 'seeder',
    postage: { publicKey: PUB, sign: (v) => { dmSigns++; return postage.sign(v, RSA.n, RSA.d) } },
    budget,
    blobPostage: seederBlobPostage(),
    blobBudget
  })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })

  // Blinded under the DM key, as a forger wanting a DM stamp would do; it
  // must also be below the blob modulus to be signed at all.
  let token, blinded, r
  do {
    token = postage.newToken(RSA.n)
    ;({ blinded, r } = postage.blind(postage.representative(token), RSA.n))
  } while (blinded >= BLOB_RSA.n)
  const stamp = await hm.issue(postage.toBase64(blinded), 'blob')
  t.is(stamp.kid, BLOB_PUB.kid, 'signed, but by the blob key')
  const s = postage.fromBase64(stamp.sig)
  t.absent(postage.verify(token, postage.unblind(s, r, RSA.n), PUB), 'the DM verifier refuses it')
  t.absent(postage.verify(token, postage.unblind(s % RSA.n, r, RSA.n), PUB, 'dm'))

  // Blinded under the blob key with a DM-domain representative.
  const token2 = postage.newToken(BLOB_RSA.n)
  const b2 = postage.blind(postage.representative(token2), BLOB_RSA.n)
  const stamp2 = await hm.issue(postage.toBase64(b2.blinded), 'blob')
  const sig2 = postage.unblind(postage.fromBase64(stamp2.sig), b2.r, BLOB_RSA.n)
  // It verifies with the DM domain under the BLOB key, which is why the DM
  // verifier must only ever use DM keys (seeder._verifyStamp).
  t.absent(postage.verify(token2, sig2, PUB), 'not a DM stamp under the DM key')
  t.absent(postage.verify(token2, sig2, BLOB_PUB, 'blob'), 'nor a blob stamp: wrong domain')

  t.is(dmSigns, 0, 'the DM key never signed')
  t.is(budget.calls.length, 0, 'the DM daily counter is untouched')
  t.is(blobBudget.calls.length, 2)
})

test('budgets are counted apart: blob teto leaves DM stamps, DM teto leaves blob stamps', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(1)
  const blobBudget = counterBudget(1)
  attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget, blobPostage: seederBlobPostage(), blobBudget })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const blobBlinded = () => {
    const token = postage.newToken(BLOB_RSA.n, 'blob')
    return postage.toBase64(postage.blind(postage.representative(token, 'blob'), BLOB_RSA.n).blinded)
  }
  t.ok((await hm.issue(blobBlinded(), 'blob')).sig)
  t.alike(await hm.issue(blobBlinded(), 'blob'), { error: 'teto' })
  t.ok((await hm.issue(blindedToken().blinded)).sig, 'DM still issues after blob teto')
  t.alike(await hm.issue(blindedToken().blinded), { error: 'teto' })
  t.is(budget.calls.length, 2)
  t.is(blobBudget.calls.length, 2)
  t.alike(await hm.issue(postage.toBase64(BLOB_RSA.n + 1n), 'blob'), { error: 'ruim' })
  t.is(blobBudget.calls.length, 2, 'ruim spends no blob budget')
})

test('a seeder without a blob key treats blob requests as bad', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget })
  const raw = rawPeer(b)
  await until(() => raw.received.length === 1, { name: 'challenge' })
  raw.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(encodeProof(raw.received[0].nonce, hex(b.publicKey), m.ownKey))) })
  raw.sendJson({ type: 'key', kind: 'blob' })
  await until(() => hs.badMessages === 1, { name: 'blob key' })
  raw.sendJson({ type: 'issue', blinded: blindedToken().blinded, kind: 'blob' })
  await until(() => hs.badMessages === 2, { name: 'blob issue' })
  await delay(30)
  t.is(raw.received.length, 1, 'nothing answered')
  t.is(budget.calls.length, 0, 'no DM budget spent')
})

test('the seeder refuses one key for both kinds and a blob budget without a key', (t) => {
  const s = streams(t)
  t.exception.all(() => attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), blobPostage: seederPostage(), blobBudget: counterBudget(5) }), /own key/)
  t.exception.all(() => attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), blobPostage: seederBlobPostage() }), /invalid blobBudget/)
  t.exception.all(() => attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), blobBudget: counterBudget(5) }), /blobBudget without blobPostage/)
  t.exception.all(() => attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), blobPostage: { publicKey: PUB } }), /invalid blobPostage/)
})

test('member requests refuse unknown stamp kinds', async (t) => {
  const { b } = streams(t)
  const m = member()
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  await t.exception.all(hm.key('other'), /invalid stamp kind/)
  await t.exception.all(hm.issue(blindedToken().blinded, 'other'), /invalid stamp kind/)
  hm.close()
})

test('blob message shapes', (t) => {
  const bt = blindedToken()
  t.ok(validateDmStampMessage({ type: 'key', kind: 'blob' }))
  t.absent(validateDmStampMessage({ type: 'key', kind: 'dm' }), 'dm is never written')
  t.absent(validateDmStampMessage({ type: 'key', kind: 'other' }))
  t.ok(validateDmStampMessage({ type: 'key', kind: 'blob', ...BLOB_PUB }))
  t.absent(validateDmStampMessage({ type: 'key', kind: 'dm', ...BLOB_PUB }))
  t.absent(validateDmStampMessage({ type: 'key', kind: 'blob', ...BLOB_PUB, kid: '00'.repeat(8) }), 'kid must match n')
  t.absent(validateDmStampMessage({ type: 'key', kind: 'blob', ...BLOB_PUB, extra: 1 }))
  t.ok(validateDmStampMessage({ type: 'issue', blinded: bt.blinded, kind: 'blob' }))
  t.absent(validateDmStampMessage({ type: 'issue', blinded: bt.blinded, kind: 'dm' }), 'dm is never written')
  t.absent(validateDmStampMessage({ type: 'issue', blinded: bt.blinded, kind: 'other' }))
  t.absent(validateDmStampMessage({ type: 'issue', blinded: bt.blinded, kind: 'blob', extra: 1 }))
  t.absent(validateDmStampMessage({ type: 'issue', blinded: bt.blinded.slice(0, -4), kind: 'blob' }))
  t.absent(validateDmStampMessage({ type: 'issue', kind: 'blob' }))
  t.absent(validateDmStampMessage({ type: 'stamp', kid: PUB.kid, sig: bt.blinded, kind: 'blob' }), 'the stamp reply has no kind')
})

test('issuing at the allowed blob and DM rates never trips the inbound limit; a flood still does', async (t) => {
  // A fake monotonic clock: 250 ms per step is exactly BLOB_ISSUE_RATE.
  const realNow = clock.now
  let fake = 1e6
  clock.now = () => fake
  t.teardown(() => { clock.now = realNow })
  const { a, b } = streams(t)
  const m = member()
  const logged = []
  // A small message bucket, so the old shared bucket ran dry within steps.
  const limits = { messageBurst: 4, messageRate: 2 }
  attachDmStamp(a, {
    role: 'seeder',
    postage: seederPostage(),
    budget: counterBudget(1000),
    blobPostage: seederBlobPostage(),
    blobBudget: counterBudget(1000),
    log: (e) => logged.push(e),
    ...limits
  })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign, ...limits })
  await hm.key('blob')
  const blobBlinded = () => {
    const token = postage.newToken(BLOB_RSA.n, 'blob')
    return postage.toBase64(postage.blind(postage.representative(token, 'blob'), BLOB_RSA.n).blinded)
  }
  let blobSigned = 0
  let dmSigned = 0
  for (let i = 0; i < 48; i++) {
    fake += 250
    if ((await hm.issue(blobBlinded(), 'blob')).sig) blobSigned++
    if (i % 4 === 3 && (await hm.issue(blindedToken().blinded)).sig) dmSigned++
  }
  t.is(blobSigned, 48, 'every blob issue signed')
  t.is(dmSigned, 12, 'every DM issue signed')
  t.absent(a.destroyed || b.destroyed, 'the socket survives')
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [])

  // Garbage still meets a hard flood limit before the bad-message count.
  const s = streams(t)
  const logged2 = []
  attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), log: (e) => logged2.push(e), maxBad: 1000, ...limits })
  const raw = rawPeer(s.b)
  await raw.opened
  for (let i = 0; i < 100; i++) raw.sendJson({ type: 'nope' })
  await until(() => s.a.destroyed, { name: 'flood drop' })
  t.alike(logged2, [{ event: 'peer-dropped', reason: 'message-rate' }])
})

test('copy stamps: a blob stamp with its own weekly budget, the daily blob budget untouched', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const budget = counterBudget(5)
  const blobBudget = counterBudget(5)
  const copyBudget = counterBudget(5)
  const logged = []
  attachDmStamp(a, {
    role: 'seeder',
    postage: seederPostage(),
    budget,
    blobPostage: seederBlobPostage(),
    blobBudget,
    copyBudget,
    log: (e) => logged.push(e),
    now: () => Date.parse('2026-11-16T12:00:00.000Z')
  })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.alike(await hm.key('copy'), BLOB_PUB, 'the blob key signs a copy stamp')
  const token = postage.newToken(BLOB_RSA.n, 'blob')
  const { blinded, r } = postage.blind(postage.representative(token, 'blob'), BLOB_RSA.n)
  const stamp = await hm.issue(postage.toBase64(blinded), 'copy')
  t.is(stamp.kid, BLOB_PUB.kid)
  const sig = postage.unblind(postage.fromBase64(stamp.sig), r, BLOB_RSA.n)
  t.ok(postage.verify(token, sig, BLOB_PUB, 'blob'), 'a copy stamp IS a blob stamp on the blob pool')
  t.alike(copyBudget.calls, [{ diary: m.ownKey, day: '2026-W47' }], 'counted per Brasília ISO week')
  t.is(blobBudget.calls.length, 0, 'the daily blob allowance is not spent')
  t.is(budget.calls.length, 0)
  t.alike(logged, [{ event: 'copy-stamp', reason: 'ok' }])
  hm.close()
})

test('copy stamps: the week budget runs out as teto without touching the daily blob stamps', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const blobBudget = counterBudget(5)
  attachDmStamp(a, {
    role: 'seeder', postage: seederPostage(), budget: counterBudget(5), blobPostage: seederBlobPostage(), blobBudget, copyBudget: counterBudget(1)
  })
  const hm = attachDmStamp(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const one = () => {
    const token = postage.newToken(BLOB_RSA.n, 'blob')
    return postage.toBase64(postage.blind(postage.representative(token, 'blob'), BLOB_RSA.n).blinded)
  }
  await hm.issue(one(), 'copy')
  t.alike(await hm.issue(one(), 'copy'), { error: 'teto' })
  const day = await hm.issue(one(), 'blob')
  t.is(day.kid, BLOB_PUB.kid, 'a daily blob stamp is still served')
  hm.close()
})

test('a seeder without a copy budget treats copy requests as bad, and no budget is spent', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const blobBudget = counterBudget(5)
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), blobPostage: seederBlobPostage(), blobBudget })
  const raw = rawPeer(b)
  await until(() => raw.received.length === 1, { name: 'challenge' })
  raw.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(encodeProof(raw.received[0].nonce, hex(b.publicKey), m.ownKey))) })
  raw.sendJson({ type: 'key', kind: 'copy' })
  await until(() => hs.badMessages === 1, { name: 'copy key' })
  raw.sendJson({ type: 'issue', blinded: blindedToken().blinded, kind: 'copy' })
  await until(() => hs.badMessages === 2, { name: 'copy issue' })
  await delay(30)
  t.is(raw.received.length, 1, 'nothing answered: an old seeder looks the same')
  t.is(blobBudget.calls.length, 0)
})

test('copy message shapes', (t) => {
  const bt = blindedToken()
  t.ok(validateDmStampMessage({ type: 'key', kind: 'copy' }))
  t.ok(validateDmStampMessage({ type: 'key', kind: 'copy', ...BLOB_PUB }))
  t.ok(validateDmStampMessage({ type: 'issue', blinded: bt.blinded, kind: 'copy' }))
  t.absent(validateDmStampMessage({ type: 'issue', blinded: bt.blinded, kind: 'copy', extra: 1 }))
  t.absent(validateDmStampMessage({ type: 'issue', kind: 'copy' }))
})

test('a copy budget needs a blob key', (t) => {
  const s = streams(t)
  t.exception.all(() => attachDmStamp(s.a, { role: 'seeder', postage: seederPostage(), budget: counterBudget(5), copyBudget: counterBudget(5) }), /copyBudget without blobPostage/)
})

// The member's first message on a seeder stand-in that only sends a
// challenge: the proof exactly as it goes on the wire.
async function sentProof (t, opts) {
  const { a, b } = streams(t)
  const raw = rawPeer(a)
  attachDmStamp(b, { role: 'member', ...opts })
  await raw.opened
  const nonce = 'ab'.repeat(32)
  raw.sendJson({ type: 'challenge', nonce })
  await until(() => raw.received.length === 1, { name: 'proof' })
  return { proof: raw.received[0], nonce, noise: hex(b.publicKey) }
}

test('v1 proof bytes and message are unchanged', async (t) => {
  t.is(DM_STAMP_PROOF_PREFIX, 'varanda-dm-stamp-v1\n')
  t.is(
    b4a.toString(encodeProof('ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)), 'hex'),
    b4a.toString(b4a.from('varanda-dm-stamp-v1\n' + 'ab'.repeat(32) + '\n' + 'cd'.repeat(32) + '\n' + 'ef'.repeat(32), 'utf8'), 'hex')
  )
  const m = member()
  const { proof, nonce, noise } = await sentProof(t, { ownKey: m.ownKey, sign: m.sign })
  t.alike(Object.keys(proof), ['type', 'key', 'sig'], 'no signer without ownSigner')
  t.is(proof.key, m.ownKey)
  t.ok(hcrypto.verify(b4a.from('varanda-dm-stamp-v1\n' + nonce + '\n' + noise + '\n' + m.ownKey, 'utf8'), b4a.from(proof.sig, 'hex'), m.kp.publicKey), 'signed by the key over the v1 payload')
})

test('v2 proof payload; a member with ownSigner sends it with four keys', async (t) => {
  t.is(DM_STAMP_PROOF_PREFIX_V2, 'varanda-dm-stamp-v2\n')
  t.is(
    b4a.toString(encodeProofV2('ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32), '01'.repeat(32)), 'utf8'),
    'varanda-dm-stamp-v2\n' + 'ab'.repeat(32) + '\n' + 'cd'.repeat(32) + '\n' + 'ef'.repeat(32) + '\n' + '01'.repeat(32)
  )
  const d = await manifestDiary(t)
  const { proof, nonce, noise } = await sentProof(t, { ownKey: d.ownKey, ownSigner: d.ownSigner, sign: d.sign })
  t.alike(Object.keys(proof), ['type', 'key', 'sig', 'signer'])
  t.is(proof.key, d.ownKey, 'key is the diary')
  t.is(proof.signer, d.ownSigner)
  t.ok(verifyProofV2({ nonce, noise, key: d.ownKey, signer: d.ownSigner }, proof.sig))
  t.absent(verifyProof({ nonce, noise, key: d.ownKey }, proof.sig), 'never a v1 proof')
})

test('verifyProofV2 refuses what does not bind the signer to the diary, and never throws', async (t) => {
  const d = await manifestDiary(t)
  const other = await manifestDiary(t)
  const m = member()
  const nonce = 'ab'.repeat(32)
  const noise = 'cd'.repeat(32)
  const fields = { nonce, noise, key: d.ownKey, signer: d.ownSigner }
  const sig = hex(d.sign(encodeProofV2(nonce, noise, d.ownKey, d.ownSigner)))
  t.ok(verifyProofV2(fields, sig))
  t.absent(verifyProofV2({ ...fields, noise: 'ef'.repeat(32) }, sig), 'other Noise key')
  t.absent(verifyProofV2({ ...fields, nonce: 'ee'.repeat(32) }, sig), 'other nonce')
  const otherSig = hex(other.sign(encodeProofV2(nonce, noise, d.ownKey, other.ownSigner)))
  t.absent(verifyProofV2({ ...fields, signer: other.ownSigner }, otherSig), 'the signer of another diary')
  const selfSig = hex(m.sign(encodeProofV2(nonce, noise, m.ownKey, m.ownKey)))
  t.absent(verifyProofV2({ nonce, noise, key: m.ownKey, signer: m.ownKey }, selfSig), 'signer === key')
  t.absent(verifyProofV2(fields, hex(d.sign(encodeProof(nonce, noise, d.ownKey)))), 'a v1 payload')
  const throwing = { nonce, noise, key: d.ownKey }
  Object.defineProperty(throwing, 'signer', { enumerable: true, get () { throw new Error('boom') } })
  for (const [f, s] of [[null, sig], [fields, null], [fields, 'zz'], [{ ...fields, signer: 'AB'.repeat(32) }, sig], [{ ...fields, signer: undefined }, sig], [throwing, sig], [[], sig]]) {
    t.absent(verifyProofV2(f, s))
  }
})

test('a core diary proves with v2 and gets stamps charged to the diary', async (t) => {
  const { a, b } = streams(t)
  const d = await manifestDiary(t)
  const budget = counterBudget(5)
  const logged = []
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget, log: (e) => logged.push(e), now: () => Date.parse('2026-11-17T12:00:00.000Z') })
  const hm = attachDmStamp(b, { role: 'member', ownKey: d.ownKey, ownSigner: d.ownSigner, sign: d.sign })
  t.is(await hm.proved, true)
  const pub = await hm.key()
  t.alike(pub, PUB)
  const bt = blindedToken()
  const stamp = await hm.issue(bt.blinded)
  t.is(stamp.kid, PUB.kid)
  t.ok(postage.verify(bt.token, postage.unblind(postage.fromBase64(stamp.sig), bt.r, RSA.n), pub), 'the unblinded stamp verifies')
  t.alike(budget.calls, [{ diary: d.ownKey, day: '2026-11-17' }], 'the diary key, never the signer')
  t.is(hs.badMessages + hm.badMessages, 0)
  const sink = JSON.stringify(logged)
  t.absent(sink.includes(d.ownKey) || sink.includes(d.ownSigner), 'no key in the log')
})

// One proof on a fresh seeder channel, then a key request: a refused proof
// binds nothing, so both count as bad and nothing but the challenge is sent.
async function refusedProof (t, name, makeProof) {
  const { a, b } = streams(t)
  const budget = counterBudget(5)
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget })
  const raw = rawPeer(b)
  await until(() => raw.received.length === 1, { name: name + ': challenge' })
  raw.sendJson(await makeProof({ nonce: raw.received[0].nonce, noise: hex(b.publicKey) }))
  raw.sendJson({ type: 'key' })
  await until(() => hs.badMessages === 2, { name })
  await delay(30)
  t.is(raw.received.length, 1, name + ': nothing answered')
  t.is(budget.calls.length, 0, name + ': no budget')
}

test('refused proofs: v2 without the right signer, mixed versions, replays, malformed signers', async (t) => {
  const d = await manifestDiary(t)
  const other = await manifestDiary(t)
  const stranger = hcrypto.keyPair()
  const m = member()
  const elsewhere = hex(hcrypto.keyPair().publicKey)
  const cases = {
    'wrong signer for the key': ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(hcrypto.sign(encodeProofV2(nonce, noise, d.ownKey, hex(stranger.publicKey)), stranger.secretKey)), signer: hex(stranger.publicKey) }),
    'the signer of another diary': ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(other.sign(encodeProofV2(nonce, noise, d.ownKey, other.ownSigner))), signer: other.ownSigner }),
    'v2 with signer === key': ({ nonce, noise }) => ({ type: 'proof', key: m.ownKey, sig: hex(m.sign(encodeProofV2(nonce, noise, m.ownKey, m.ownKey))), signer: m.ownKey }),
    'a v1 signature with four keys': ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProof(nonce, noise, d.ownKey))), signer: d.ownSigner }),
    'v2 fields under the v1 prefix': ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(d.sign(b4a.from(DM_STAMP_PROOF_PREFIX + nonce + '\n' + noise + '\n' + d.ownKey + '\n' + d.ownSigner, 'utf8'))), signer: d.ownSigner }),
    'a v2 signature as three keys': ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProofV2(nonce, noise, d.ownKey, d.ownSigner))) }),
    'replayed on another Noise key': ({ nonce }) => ({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProofV2(nonce, elsewhere, d.ownKey, d.ownSigner))), signer: d.ownSigner }),
    // Why core could not get stamps: a manifest diary's key is no public key.
    'a manifest diary\'s v1 proof': ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProof(nonce, noise, d.ownKey))) })
  }
  for (const [name, makeProof] of Object.entries(cases)) await refusedProof(t, name, makeProof)
  for (const signer of ['zz', d.ownSigner.toUpperCase(), d.ownSigner.slice(2), null, 1]) {
    await refusedProof(t, 'malformed signer ' + JSON.stringify(signer), ({ nonce, noise }) => ({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProofV2(nonce, noise, d.ownKey, d.ownSigner))), signer }))
  }
})

test('a refused v2 proof is the one proof of the channel; a valid one after it binds nothing', async (t) => {
  const { a, b } = streams(t)
  const d = await manifestDiary(t)
  const budget = counterBudget(5)
  const hs = attachDmStamp(a, { role: 'seeder', postage: seederPostage(), budget })
  const raw = rawPeer(b)
  await until(() => raw.received.length === 1, { name: 'challenge' })
  const nonce = raw.received[0].nonce
  const noise = hex(b.publicKey)
  raw.sendJson({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProof(nonce, noise, d.ownKey))), signer: d.ownSigner })
  raw.sendJson({ type: 'proof', key: d.ownKey, sig: hex(d.sign(encodeProofV2(nonce, noise, d.ownKey, d.ownSigner))), signer: d.ownSigner })
  raw.sendJson({ type: 'key' })
  await until(() => hs.badMessages === 3, { name: 'all bad' })
  await delay(30)
  t.is(raw.received.length, 1)
  t.is(budget.calls.length, 0)
})

test('proof message shapes', (t) => {
  const key = 'ab'.repeat(32)
  const signer = 'cd'.repeat(32)
  const sig = 'ef'.repeat(64)
  t.ok(validateDmStampMessage({ type: 'proof', key, sig }))
  t.ok(validateDmStampMessage({ type: 'proof', key, sig, signer }))
  t.absent(validateDmStampMessage({ type: 'proof', key, sig, signer: 'zz' }))
  t.absent(validateDmStampMessage({ type: 'proof', key, sig, signer: signer.toUpperCase() }))
  t.absent(validateDmStampMessage({ type: 'proof', key, sig, signer, extra: 1 }))
  t.absent(validateDmStampMessage({ type: 'proof', key, sig, other: signer }))
  t.absent(validateDmStampMessage({ type: 'proof', key, signer }))
  t.absent(validateDmStampMessage({ type: 'proof', key: 'zz', sig, signer }))
})

test('a member refuses an ownSigner that does not own ownKey', async (t) => {
  const { b } = streams(t)
  const d = await manifestDiary(t)
  const other = await manifestDiary(t)
  const m = member()
  for (const ownSigner of ['zz', 1, d.ownSigner.toUpperCase(), other.ownSigner, d.ownKey]) {
    t.exception.all(() => attachDmStamp(b, { role: 'member', slot: '_bad', ownKey: d.ownKey, ownSigner, sign: d.sign }), /invalid ownSigner/)
  }
  t.exception.all(() => attachDmStamp(b, { role: 'member', slot: '_bad', ownKey: m.ownKey, ownSigner: m.ownKey, sign: m.sign }), /invalid ownSigner/, 'a key that is its own signer uses v1')
  t.absent(b._bad)
})
