'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const cert = require('../lib/cert')
const blocklist = require('../lib/blocklist')
const { verify, warm, loadDigests, exportDigests, onDigest, clearDigests, useSubtle, memoSize, clearMemo, MAX_ENTRIES, MAX_BYTES, MAX_DIGESTS } = require('../lib/verified')

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

function issued () {
  const assocKp = crypto.keyPair()
  const assocHex = b4a.toString(assocKp.publicKey, 'hex')
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: DATE }, assocKp)
  const c = cert.createIssuedCert({ member: MEMBER, date: DATE }, issuerKp, issuerCert)
  const r = cert.createUsernameRecord({ member: MEMBER, username: 'ana', date: DATE }, issuerKp, issuerCert)
  return { assocKp, assocHex, issuerKp, c, r }
}

function platformSubtle () {
  return globalThis.crypto ? globalThis.crypto.subtle : null
}

// RFC 8032 section 7.1, test 1, as lib/verified.js probes WebCrypto with.
const RFC_KEY = b4a.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')
const RFC_SIG = b4a.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex')

// A SubtleCrypto that answers the probe truthfully and accepts anything
// else, recording what reached it.
function acceptingSubtle (reached) {
  return {
    async importKey (format, raw) { return { raw: b4a.from(raw) } },
    async verify (algorithm, key, signature, message) {
      if (b4a.equals(key.raw, RFC_KEY)) return crypto.verify(b4a.from(message), b4a.from(signature), key.raw)
      reached.push(b4a.from(signature))
      return true
    }
  }
}

test('digests: a verified triple stays known without the memo until cleared', (t) => {
  const checks = countChecks(t)
  loadDigests('')
  t.teardown(clearDigests)
  const { kp, message, signature } = signed('varanda digest')
  t.is(verify(message, signature, kp.publicKey), true)
  const saved = exportDigests()
  t.is(saved.length, 64, 'one digest')
  clearMemo()
  t.is(verify(message, signature, kp.publicKey), true)
  t.is(checks.n, 1, 'answered from the digest')
  const other = b4a.from(message)
  other[0] ^= 1
  t.is(verify(other, signature, kp.publicKey), false, 'another message is checked and refused')
  t.is(checks.n, 2)
  clearDigests()
  clearMemo()
  t.is(verify(message, signature, kp.publicKey), true)
  t.is(checks.n, 3, 'checked again once cleared')
  t.is(exportDigests(), '', 'nothing recorded while the tier is off')
  clearMemo()
  t.is(loadDigests(saved), 1, 'a restart loads the saved digest')
  t.is(verify(message, signature, kp.publicKey), true)
  t.is(checks.n, 3, 'and answers from it')
})

test('digests: only well-formed input loads, the newest are kept, onDigest fires per new digest', (t) => {
  countChecks(t)
  t.teardown(clearDigests)
  for (const bad of [null, 'xyz', 'ab'.repeat(31), 'AB'.repeat(32), 42]) t.is(loadDigests(bad), 0)
  t.is(exportDigests(), '')
  const digest = (i) => i.toString(16).padStart(64, '0')
  const many = Array.from({ length: MAX_DIGESTS + 2 }, (_, i) => digest(i)).join('')
  t.is(loadDigests(many), MAX_DIGESTS)
  t.is(exportDigests().length, MAX_DIGESTS * 64)
  t.is(exportDigests().slice(0, 64), digest(2), 'the two oldest dropped')
  clearDigests()
  loadDigests('')
  let fired = 0
  const off = onDigest(() => fired++)
  const a = signed('a')
  verify(a.message, a.signature, a.kp.publicKey)
  clearMemo()
  verify(a.message, a.signature, a.kp.publicKey)
  t.is(fired, 1, 'a known digest does not fire again')
  off()
  const b = signed('b')
  verify(b.message, b.signature, b.kp.publicKey)
  t.is(fired, 1, 'unsubscribed')
})

test('warm: the RFC 8032 probe vector verifies, a SubtleCrypto that accepts a bad signature is not used', async (t) => {
  t.is(crypto.verify(b4a.alloc(0), RFC_SIG, RFC_KEY), true)
  t.teardown(() => useSubtle(platformSubtle()))
  const yes = { importKey: async () => ({}), verify: async () => true }
  t.is(await useSubtle(yes), null)
  const { assocKp, c } = issued()
  t.is(await warm([cert.certChain(c)], assocKp.publicKey), 0, 'nothing warmed')
  t.is(await useSubtle(null), null)
  t.is(await warm([cert.certChain(c)], assocKp.publicKey), 0)
})

test('warm: WebCrypto checks association-rooted chains ahead, link by link, and changes no answer', async (t) => {
  if (await useSubtle(platformSubtle()) === null) {
    t.pass('no WebCrypto Ed25519 on this platform')
    return
  }
  const checks = countChecks(t)
  const { assocKp, assocHex, issuerKp, c, r } = issued()
  clearMemo()
  checks.n = 0
  const chains = [cert.certChain(c), cert.usernameChain(r)]
  t.is(await warm(chains, assocKp.publicKey), 4, 'two links per chain known good')
  t.alike(cert.certForKey(c, MEMBER, assocHex), { ok: true })
  t.alike(cert.verifyUsernameRecord(r, MEMBER, assocHex), { ok: true })
  t.is(checks.n, 0, 'every check answered from the memo')
  t.alike(cert.certForKey({ ...c, date: '2026-10-20T00:00:00.000Z' }, MEMBER, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.certForKey(c, MEMBER, assocHex, { revokedIssuers: new Set([b4a.toString(issuerKp.publicKey, 'hex')]) }), { ok: false, reason: 'revoked-issuer' })

  clearMemo()
  checks.n = 0
  t.is(await warm(chains, issuerKp.publicKey), 0, 'a chain not rooted at the given key is skipped')
  t.alike(cert.certForKey(c, MEMBER, assocHex), { ok: true })
  t.is(checks.n, 2, 'both checked for real')

  clearMemo()
  checks.n = 0
  const chain = cert.certChain(c)
  const badSignature = b4a.from(chain[0].signature)
  badSignature[0] ^= 1
  chain[0] = { ...chain[0], signature: badSignature }
  t.is(await warm([chain], assocKp.publicKey), 0, 'a bad first link stops the chain')
  t.is(verify(chain[1].message, chain[1].signature, chain[1].publicKey), true)
  t.is(checks.n, 1, 'the link after it was not warmed')
})

test('warm: only triples that pass libsodium\'s encoding checks reach WebCrypto', async (t) => {
  const reached = []
  t.teardown(() => useSubtle(platformSubtle()))
  t.ok(await useSubtle(acceptingSubtle(reached)), 'the probe passes')
  const checks = countChecks(t)
  const { kp, message, signature } = signed('varanda-cert-v1')
  // S + L: the same signature with a non-canonical S, which libsodium refuses.
  const ORDER = b4a.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex')
  const malleated = b4a.from(signature)
  let carry = 0
  for (let i = 0; i < 32; i++) {
    const sum = malleated[32 + i] + ORDER[i] + carry
    malleated[32 + i] = sum & 0xff
    carry = sum >> 8
  }
  const identity = b4a.alloc(32)
  identity[0] = 1
  const smallR = b4a.concat([identity, signature.subarray(32)])
  const highY = b4a.from('efffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex')
  const nonCanonicalR = b4a.concat([highY, signature.subarray(32)])
  const bad = [malleated, smallR, nonCanonicalR]
  t.is(await warm(bad.map((s) => [{ message, signature: s, publicKey: kp.publicKey }]), kp.publicKey), 0)
  t.is(await warm([[{ message, signature, publicKey: identity }]], identity), 0, 'a small-order key')
  t.is(reached.length, 0, 'none reached WebCrypto')
  for (const s of bad) t.is(verify(message, s, kp.publicKey), false, 'and the real check refuses them')
  t.is(await warm([[{ message, signature, publicKey: kp.publicKey }]], kp.publicKey), 1)
  t.is(reached.length, 1, 'a well-formed triple does')
  checks.n = 0
  t.is(verify(message, signature, kp.publicKey), true)
  t.is(checks.n, 0, 'answered from the memo')
})
