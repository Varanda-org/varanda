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
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  attachDmStamp, encodeProof, verifyProof, validateDmStampMessage, DM_STAMP_PROOF_PREFIX, MAX_BAD_DM_STAMP, MAX_TETO_DM_STAMP
} = require('../lib/dm-stamp-net')
const { DM_STAMP_PROTOCOL } = require('../lib/dm')
const postage = require('../lib/dm-postage')
const { noticeV2Payload, signNoticeProof } = require('../lib/notices-v2')
const { until } = require('./helpers/net')

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

const RSA = (() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  return { n: fromBase64url(jwk.n), d: fromBase64url(jwk.d) }
})()
const PUB = postage.publicKey(RSA.n)

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
