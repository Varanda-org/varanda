'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const cert = require('../lib/cert')
const blocklist = require('../lib/blocklist')
const { verify, memoSize, clearMemo, MAX_ENTRIES, MAX_BYTES } = require('../lib/verified')

const MEMBER = 'ab'.repeat(32)
const DATE = '2026-10-19T00:00:00.000Z'

// Counts the real checks (lib/verified.js calls hypercore-crypto verify).
function countChecks (t) {
  const real = crypto.verify
  const counter = { n: 0 }
  crypto.verify = function (...args) {
    counter.n++
    return real.apply(this, args)
  }
  t.teardown(() => { crypto.verify = real })
  clearMemo()
  t.teardown(clearMemo)
  return counter
}

function signed (text) {
  const kp = crypto.keyPair()
  const message = b4a.from(text)
  return { kp, message, signature: crypto.sign(message, kp.secretKey) }
}

test('verify: same verdicts as hypercore-crypto, a repeated success skips the check', (t) => {
  const checks = countChecks(t)
  const { kp, message, signature } = signed('varanda-cert-v2\nexemplo')
  t.is(verify(message, signature, kp.publicKey), true)
  t.is(checks.n, 1)
  t.is(verify(message, signature, kp.publicKey), true)
  t.is(verify(b4a.from(message), b4a.from(signature), b4a.from(kp.publicKey)), true, 'equal bytes in other buffers')
  t.is(checks.n, 1, 'answered from the memo')
  t.is(verify(b4a.from('varanda-cert-v2\noutro'), signature, kp.publicKey), false, 'same key and signature, other message')
  t.is(checks.n, 2)
  const bad = b4a.from(signature)
  bad[0] ^= 1
  t.is(verify(message, bad, kp.publicKey), false)
  t.is(verify(message, bad, kp.publicKey), false)
  t.is(checks.n, 4, 'a failure is never kept')
  t.is(verify(message, signature, crypto.keyPair().publicKey), false, 'another key')
  t.is(checks.n, 5)
})

test('verify: the memo keeps its own copy of the message', (t) => {
  const checks = countChecks(t)
  const { kp, message, signature } = signed('mensagem original')
  const original = b4a.from(message)
  t.is(verify(message, signature, kp.publicKey), true)
  message[0] ^= 1
  t.is(verify(message, signature, kp.publicKey), false, 'the caller changed its buffer: checked again')
  t.is(checks.n, 2)
  t.is(verify(original, signature, kp.publicKey), true)
  t.is(checks.n, 2, 'the original bytes are still remembered')
})

test('verify: other lengths and types never reach the memo', (t) => {
  const checks = countChecks(t)
  const { kp, message, signature } = signed('comprimentos')
  t.is(verify(message, signature, kp.publicKey), true)
  // The same hex id from a 31-byte key and a 65-byte signature.
  const key31 = kp.publicKey.subarray(0, 31)
  const sig65 = b4a.concat([kp.publicKey.subarray(31), signature])
  t.is(b4a.toString(key31, 'hex') + b4a.toString(sig65, 'hex'), b4a.toString(kp.publicKey, 'hex') + b4a.toString(signature, 'hex'))
  let direct
  try {
    direct = crypto.verify(message, sig65, key31)
  } catch (err) {
    direct = err
  }
  checks.n = 0
  let memo
  try {
    memo = verify(message, sig65, key31)
  } catch (err) {
    memo = err
  }
  t.is(checks.n, 1, 'the real check ran')
  if (direct instanceof Error) t.ok(memo instanceof Error, 'it throws as hypercore-crypto does')
  else t.is(memo, direct)
  t.exception(() => verify('texto', signature, kp.publicKey), 'a string message is passed through')
  t.is(checks.n, 2)
})

test('verify: bounded by entries, oldest first, a hit refreshes', (t) => {
  const checks = countChecks(t)
  const kp = crypto.keyPair()
  const items = []
  for (let i = 0; i <= MAX_ENTRIES; i++) {
    const message = b4a.from('item ' + i)
    items.push({ message, signature: crypto.sign(message, kp.secretKey) })
  }
  const check = (i) => verify(items[i].message, items[i].signature, kp.publicKey)
  let all = true
  for (let i = 0; i < MAX_ENTRIES; i++) all = check(i) && all
  t.ok(all)
  t.is(memoSize().entries, MAX_ENTRIES)
  // Item 0 used again, so item 1 is the oldest when one more comes in.
  check(0)
  check(MAX_ENTRIES)
  t.is(memoSize().entries, MAX_ENTRIES)
  checks.n = 0
  t.is(check(0), true)
  t.is(checks.n, 0, 'the refreshed entry stayed')
  t.is(check(1), true)
  t.is(checks.n, 1, 'the oldest one went')
})

test('verify: bounded by message bytes', (t) => {
  countChecks(t)
  const kp = crypto.keyPair()
  const big = Math.floor(MAX_BYTES / 3) + 1
  for (let i = 0; i < 4; i++) {
    const message = b4a.alloc(big, i + 1)
    t.is(verify(message, crypto.sign(message, kp.secretKey), kp.publicKey), true)
    t.ok(memoSize().bytes <= MAX_BYTES)
  }
  t.is(memoSize().entries, 2)
  const huge = b4a.alloc(MAX_BYTES + 1, 7)
  t.is(verify(huge, crypto.sign(huge, kp.secretKey), kp.publicKey), true)
  t.is(memoSize().entries, 2, 'a message over the whole budget is not kept')
})

test('verify: with a warm memo, revocation and tampering are still refused', (t) => {
  countChecks(t)
  const assocKp = crypto.keyPair()
  const assocHex = b4a.toString(assocKp.publicKey, 'hex')
  const issuerKp = crypto.keyPair()
  const issuerHex = b4a.toString(issuerKp.publicKey, 'hex')
  const issuerCert = cert.createIssuerCert({ issuer: issuerHex, date: DATE }, assocKp)
  const c = cert.createIssuedCert({ member: MEMBER, date: DATE }, issuerKp, issuerCert)
  const r = cert.createUsernameRecord({ member: MEMBER, username: 'ana', date: DATE }, issuerKp, issuerCert)
  t.alike(cert.certForKey(c, MEMBER, assocHex), { ok: true })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex), { ok: true })
  const revokedIssuers = new Set([issuerHex])
  t.alike(cert.certForKey(c, MEMBER, assocHex, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex, { revokedIssuers }), { ok: false, reason: 'revoked-issuer' })
  t.alike(cert.certForKey({ ...c, date: '2026-10-20T00:00:00.000Z' }, MEMBER, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyUsernameRecord({ ...r, username: 'bia' }, MEMBER, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.certForKey(c, MEMBER, 'cd'.repeat(32)), { ok: false, reason: 'untrusted-association' })

  const modKp = crypto.keyPair()
  const modCert = cert.createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: DATE }, assocKp)
  const snapshot = blocklist.createSnapshot({ seq: 1, date: DATE, blocked: ['11'.repeat(32)] }, modKp, modCert)
  t.alike(blocklist.verifySnapshot(snapshot, assocHex), { ok: true })
  t.alike(blocklist.verifySnapshot({ ...snapshot, blocked: [] }, assocHex), { ok: false, reason: 'bad-signature' }, 'a key dropped from the signed list')
})
