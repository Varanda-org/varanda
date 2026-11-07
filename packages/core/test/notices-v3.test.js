'use strict'

const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { noticePayload, verifyNoticeProof } = require('../lib/notices')
const {
  noticeV2Payload,
  verifyNoticeV2Proof,
  validateNoticesV2Message
} = require('../lib/notices-v2')
const {
  NOTICES_V3_PROTOCOL,
  NOTICE_V3_PROOF_PREFIX,
  NOTICE_V3_KINDS,
  MAX_NOTICES_MESSAGE,
  noticeV3Payload,
  signNoticeProof,
  verifyNoticeV3Proof,
  validateNoticesV3Message
} = require('../lib/notices-v3')

const coreRoot = path.join(__dirname, '..')
const D1 = '2026-01-01T00:00:00.000Z'
const K1 = 'ab'.repeat(32)
const K2 = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function items (list, next = null) {
  return { type: 'items', items: list, next, incomplete: false }
}

test('constants', (t) => {
  t.is(NOTICES_V3_PROTOCOL, 'varanda/notices/3')
  t.is(NOTICE_V3_PROOF_PREFIX, 'varanda-notices-v3\n')
  t.alike([...NOTICE_V3_KINDS], ['follow', 'reply', 'quote', 'mention', 'like', 'repost'])
  t.ok(Object.isFrozen(NOTICE_V3_KINDS))
  t.is(MAX_NOTICES_MESSAGE, 16384)
})

test('validator: the six kinds validate; like and repost stay invalid on v2', (t) => {
  const item = { key: K1, seq: 1, at: D1, kind: 'like' }
  for (const kind of NOTICE_V3_KINDS) t.ok(validateNoticesV3Message(items([{ ...item, kind }])), kind)

  // An old client must never see a like or a repost: v2 rejects the page.
  t.absent(validateNoticesV2Message(items([{ ...item, kind: 'like' }])), 'like is not a v2 kind')
  t.absent(validateNoticesV2Message(items([{ ...item, kind: 'repost' }])), 'repost is not a v2 kind')

  const good = { ...item, kind: 'follow' }
  t.absent(validateNoticesV3Message(items([good, { ...item, kind: 'dm' }])), 'one unknown kind invalidates the page')
  t.absent(validateNoticesV3Message(items([{ ...item, kind: 'toString' }])), 'prototype name is not a kind')
  t.absent(validateNoticesV3Message(items([{ ...item, kind: 1 }])), 'non-string kind')
  t.absent(validateNoticesV3Message(items([{ key: K1, seq: 1, at: D1 }])), 'missing kind')
  t.absent(validateNoticesV3Message(items([{ ...item, extra: 1 }])), 'extra item key')
  t.absent(validateNoticesV3Message(items([{ ...item, seq: 0 }])), 'seq 0')
  t.absent(validateNoticesV3Message({ ...items([]), extra: 1 }), 'extra message key')

  t.ok(validateNoticesV3Message(items([item], { at: D1, key: K1, seq: 1 })))
  t.absent(validateNoticesV3Message(items([item], { at: D1, key: K1 })), '2-key next')
  t.ok(validateNoticesV3Message({ type: 'page', after: null, limit: 64 }))
  t.ok(validateNoticesV3Message({ type: 'page', after: { at: D1, key: K2, seq: 9 }, limit: 1 }))
  t.absent(validateNoticesV3Message({ type: 'page', after: null, limit: 0 }))
  t.absent(validateNoticesV3Message({ type: 'page', after: null, limit: 65 }))
  t.absent(validateNoticesV3Message(items(Array.from({ length: 65 }, () => item))), '65 items')

  t.ok(validateNoticesV3Message({ type: 'challenge', nonce: K1 }))
  t.ok(validateNoticesV3Message({ type: 'proof', key: K1, sig: 'ef'.repeat(64) }))
  t.absent(validateNoticesV3Message({ type: 'proof', key: K1, sig: 'EF'.repeat(64) }))
  t.absent(validateNoticesV3Message(null))
  t.absent(validateNoticesV3Message({ type: 'other' }))
  const hostile = new Proxy({}, { get () { throw new Error('boom') }, ownKeys () { throw new Error('boom') } })
  t.absent(validateNoticesV3Message(hostile))
  t.absent(validateNoticesV3Message(items([hostile])))
})

test('a 64-item page fits in one frame', (t) => {
  const list = Array.from({ length: 64 }, (_, i) => ({
    key: hex(hcrypto.randomBytes(32)),
    seq: Number.MAX_SAFE_INTEGER - i,
    at: '2026-12-31T23:59:59.999Z',
    kind: 'mention'
  }))
  const msg = { type: 'items', items: list, next: { at: '2026-12-31T23:59:59.999Z', key: K1, seq: Number.MAX_SAFE_INTEGER }, incomplete: true }
  t.ok(validateNoticesV3Message(msg))
  t.ok(b4a.byteLength(JSON.stringify(msg)) < MAX_NOTICES_MESSAGE)
})

test('proofs are domain separated between v1, v2 and v3', (t) => {
  const kp = hcrypto.keyPair()
  const ownKey = hex(kp.publicKey)
  const fields = { nonce: K1, noise: K2, key: ownKey }
  const v1sig = hex(signNoticeProof(noticePayload(K1, K2, ownKey), kp))
  const v2sig = hex(signNoticeProof(noticeV2Payload(K1, K2, ownKey), kp))
  const v3sig = hex(signNoticeProof(noticeV3Payload(K1, K2, ownKey), kp))
  t.ok(verifyNoticeV3Proof(fields, v3sig))
  t.absent(verifyNoticeV3Proof(fields, v1sig), 'a v1 proof fails on v3')
  t.absent(verifyNoticeV3Proof(fields, v2sig), 'a v2 proof fails on v3')
  t.absent(verifyNoticeProof(fields, v3sig), 'a v3 proof fails on v1')
  t.absent(verifyNoticeV2Proof(fields, v3sig), 'a v3 proof fails on v2')
  t.absent(verifyNoticeV3Proof({ ...fields, noise: K1 }, v3sig), 'bound to the Noise key')
  t.absent(verifyNoticeV3Proof(null, v3sig))
  t.absent(verifyNoticeV3Proof(fields, 'zz'))
})

test('notices-v3 loads without node-only modules, hypercore or crypto', (t) => {
  const code = "require('./lib/notices-v3.js'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const cached = JSON.parse(r.stdout)
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/', '/protomux/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'does not load ' + frag)
  }
})
