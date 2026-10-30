'use strict'

// 'varanda/notices/2' next to 'varanda/notices/1' on the same in-memory
// NoiseSecretStreams (as notices-net.test.js does).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { MAX_BAD_NOTICES, attachNotices, attachNoticesV2 } = require('../lib/notices-net')
const { noticePayload, verifyNoticeProof, validateNoticesMessage } = require('../lib/notices')
const {
  NOTICES_V2_PROTOCOL,
  NOTICE_V2_PROOF_PREFIX,
  NOTICE_KINDS,
  MAX_NOTICES_MESSAGE,
  noticeV2Payload,
  signNoticeProof,
  verifyNoticeV2Proof,
  validateNoticesV2Message
} = require('../lib/notices-v2')
const { until } = require('./helpers/net')

const coreRoot = path.join(__dirname, '..')
const D1 = '2026-01-01T00:00:00.000Z'
const K1 = 'ab'.repeat(32)
const K2 = 'cd'.repeat(32)

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

// One page() stand-in for both channels: the rows carry kind, the v1
// projection must strip it.
function fakePage () {
  const calls = []
  return {
    calls,
    page: ({ target, after, limit }) => {
      calls.push({ target, after, limit })
      return {
        items: [{ key: K1, seq: 3, at: D1, kind: 'mention' }],
        next: { at: D1, key: K1, seq: 3 },
        incomplete: false
      }
    }
  }
}

function rawPeer (noise, protocol) {
  const received = []
  const ch = noise.userData.createChannel({ protocol })
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

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function items (list, next = null) {
  return { type: 'items', items: list, next, incomplete: false }
}

test('constants', (t) => {
  t.is(NOTICES_V2_PROTOCOL, 'varanda/notices/2')
  t.is(NOTICE_V2_PROOF_PREFIX, 'varanda-notices-v2\n')
  t.alike([...NOTICE_KINDS], ['follow', 'reply', 'quote', 'mention'])
  t.ok(Object.isFrozen(NOTICE_KINDS))
  t.is(MAX_NOTICES_MESSAGE, 16384)
})

test('validator: items carry exactly one known kind; cursors carry seq', (t) => {
  const item = { key: K1, seq: 1, at: D1, kind: 'reply' }
  t.ok(validateNoticesV2Message(items([item])))
  for (const kind of NOTICE_KINDS) t.ok(validateNoticesV2Message(items([{ ...item, kind }])), kind)

  t.absent(validateNoticesV2Message(items([{ key: K1, seq: 1, at: D1 }])), 'missing kind')
  t.absent(validateNoticesV2Message(items([{ ...item, kind: 'like' }])), 'unknown kind')
  t.absent(validateNoticesV2Message(items([{ ...item, kind: 'toString' }])), 'prototype name is not a kind')
  t.absent(validateNoticesV2Message(items([{ ...item, kind: 1 }])), 'non-string kind')
  t.absent(validateNoticesV2Message(items([{ ...item, extra: 1 }])), 'extra item key')
  t.absent(validateNoticesV2Message(items([{ ...item, seq: 0 }])), 'seq 0')
  t.absent(validateNoticesV2Message({ ...items([]), extra: 1 }), 'extra message key')

  t.ok(validateNoticesV2Message(items([item], { at: D1, key: K1, seq: 1 })))
  t.absent(validateNoticesV2Message(items([item], { at: D1, key: K1 })), '2-key next on v2')
  t.absent(validateNoticesV2Message(items([item], { at: D1, key: K1, seq: 0 })), 'next seq 0')
  t.absent(validateNoticesV2Message(items([item], { at: D1, key: K1, seq: 1.5 })), 'next seq not integer')
  t.ok(validateNoticesV2Message({ type: 'page', after: null, limit: 64 }))
  t.ok(validateNoticesV2Message({ type: 'page', after: { at: D1, key: K2, seq: 9 }, limit: 1 }))
  t.absent(validateNoticesV2Message({ type: 'page', after: { at: D1, key: K2 }, limit: 1 }), '2-key after on v2')
  t.absent(validateNoticesV2Message({ type: 'page', after: null, limit: 0 }))
  t.absent(validateNoticesV2Message({ type: 'page', after: null, limit: 65 }))
  t.absent(validateNoticesV2Message({ ...items([]), incomplete: 'no' }))
  const tooMany = Array.from({ length: 65 }, () => item)
  t.absent(validateNoticesV2Message(items(tooMany)), '65 items')

  t.ok(validateNoticesV2Message({ type: 'challenge', nonce: K1 }))
  t.ok(validateNoticesV2Message({ type: 'proof', key: K1, sig: 'ef'.repeat(64) }))
  t.absent(validateNoticesV2Message({ type: 'proof', key: K1, sig: 'EF'.repeat(64) }))
  t.absent(validateNoticesV2Message(null))
  t.absent(validateNoticesV2Message({ type: 'other' }))

  // v1 is untouched: kinded items and 3-key cursors stay invalid there.
  t.absent(validateNoticesMessage(items([item])))
  t.absent(validateNoticesMessage({ type: 'page', after: { at: D1, key: K2, seq: 9 }, limit: 1 }))
})

test('a 64-item page fits in one frame', (t) => {
  const list = Array.from({ length: 64 }, (_, i) => ({
    key: hex(hcrypto.randomBytes(32)),
    seq: Number.MAX_SAFE_INTEGER - i,
    at: '2026-12-31T23:59:59.999Z',
    kind: 'mention'
  }))
  const msg = { type: 'items', items: list, next: { at: '2026-12-31T23:59:59.999Z', key: K1, seq: Number.MAX_SAFE_INTEGER }, incomplete: true }
  t.ok(validateNoticesV2Message(msg))
  t.ok(b4a.byteLength(JSON.stringify(msg)) < MAX_NOTICES_MESSAGE)
})

test('proofs are domain separated between v1 and v2', (t) => {
  const m = member()
  const fields = { nonce: K1, noise: K2, key: m.ownKey }
  const v1sig = hex(m.sign(noticePayload(K1, K2, m.ownKey)))
  const v2sig = hex(m.sign(noticeV2Payload(K1, K2, m.ownKey)))
  t.ok(verifyNoticeProof(fields, v1sig))
  t.ok(verifyNoticeV2Proof(fields, v2sig))
  t.absent(verifyNoticeV2Proof(fields, v1sig), 'a v1 proof fails on v2')
  t.absent(verifyNoticeProof(fields, v2sig), 'a v2 proof fails on v1')
  t.absent(verifyNoticeV2Proof({ ...fields, noise: K1 }, v2sig), 'bound to the Noise key')
  t.absent(verifyNoticeV2Proof(null, v2sig))
  t.absent(verifyNoticeV2Proof(fields, 'zz'))
})

test('one socket serves v1 and v2; v1 items stay kindless, v2 items carry kind', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  const hs1 = attachNotices(a, { role: 'seeder', page: fp.page })
  const hs2 = attachNoticesV2(a, { role: 'seeder', page: fp.page })
  t.not(hs1, hs2)
  t.is(a._varandaNotices, hs1)
  t.is(a._varandaNoticesV2, hs2)
  t.is(attachNoticesV2(a, { role: 'seeder', page: fp.page }), hs2, 'cached per slot')

  const hm1 = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const hm2 = attachNoticesV2(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.is(await hm1.proved, true)
  t.is(await hm2.proved, true)

  const p1 = await hm1.requestPage({ limit: 5 })
  t.alike(p1, { items: [{ key: K1, seq: 3, at: D1 }], next: { at: D1, key: K1 }, incomplete: false })
  const p2 = await hm2.requestPage({ after: { at: D1, key: K2, seq: 7 }, limit: 5 })
  t.alike(p2, { items: [{ key: K1, seq: 3, at: D1, kind: 'mention' }], next: { at: D1, key: K1, seq: 3 }, incomplete: false })
  t.alike(fp.calls, [
    { target: m.ownKey, after: null, limit: 5 },
    { target: m.ownKey, after: { at: D1, key: K2, seq: 7 }, limit: 5 }
  ])

  // Closing v2 leaves v1 working and its slot in place.
  hm2.close()
  t.absent(b._varandaNoticesV2)
  t.is(b._varandaNotices, hm1)
  t.alike((await hm1.requestPage({})).items, [{ key: K1, seq: 3, at: D1 }])
  t.is(hs1.badMessages + hs2.badMessages + hm1.badMessages + hm2.badMessages, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a seeder page() whose rows lack a valid kind answers an empty incomplete page', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const logged = []
  const page = () => ({ items: [{ key: K1, seq: 3, at: D1, kind: 'like' }], next: null, incomplete: false })
  attachNoticesV2(a, { role: 'seeder', page, log: (e) => logged.push(e) })
  const hm = attachNoticesV2(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.alike(await hm.requestPage({}), { items: [], next: null, incomplete: true })
  t.alike(logged.map((e) => e.event), ['notices-v2-page-invalid'])
})

test('a v1 proof on the v2 channel is bad and never binds', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  const hs = attachNoticesV2(a, { role: 'seeder', page: fp.page })
  const raw = rawPeer(b, NOTICES_V2_PROTOCOL)
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'challenge' })
  const nonce = raw.received[0].nonce
  raw.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(noticePayload(nonce, hex(b.publicKey), m.ownKey))) })
  await until(() => hs.badMessages === 1, { name: 'v1 proof is bad on v2' })
  raw.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => hs.badMessages === 2, { name: 'page without binding is bad' })
  t.is(fp.calls.length, 0)
  t.absent(a.destroyed)
})

test('a peer that never opens v2 keeps v1 working and is not destroyed', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  attachNotices(a, { role: 'seeder', page: fp.page })
  const hm1 = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const hm2 = attachNoticesV2(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.is(await hm2.supported, false)
  t.is(await hm2.proved, false)
  await t.exception(hm2.requestPage({}), /closed/)
  t.is(await hm1.supported, true)
  t.alike((await hm1.requestPage({})).items, [{ key: K1, seq: 3, at: D1 }])
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('more than MAX_BAD_NOTICES bad v2 messages drops the peer with reason notices-v2', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const logged = []
  const hs1 = attachNotices(a, { role: 'seeder', page: fp.page })
  const hs = attachNoticesV2(a, { role: 'seeder', page: fp.page, log: (e) => logged.push(e) })
  const raw = rawPeer(b, NOTICES_V2_PROTOCOL)
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'challenge' })
  // A v1-shaped page (2-key cursor) is bad on v2.
  for (let i = 0; i < MAX_BAD_NOTICES; i++) raw.sendJson({ type: 'page', after: { at: D1, key: K1 }, limit: 5 })
  await until(() => hs.badMessages === MAX_BAD_NOTICES, { name: 'five bad messages' })
  await delay(50)
  t.absent(a.destroyed)
  raw.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.is(hs.badMessages, MAX_BAD_NOTICES + 1)
  t.is(hs1.badMessages, 0, 'v1 counted nothing')
  t.alike(logged, [{ event: 'peer-dropped', peerKey: hs.peerKey, reason: 'notices-v2' }])
  t.is(fp.calls.length, 0)
})

test('notices-v2 loads without node-only modules, hypercore or crypto', (t) => {
  const code = "require('./lib/notices-v2.js'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const cached = JSON.parse(r.stdout)
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/', '/protomux/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'does not load ' + frag)
  }
})
