// lib/passkey.js: the PRF -> HKDF-SHA-256 -> Ed25519 derivation (a pinned
// golden vector, cross-checked against node:crypto), rpIdFor, supportStatus,
// the creation/request options, and the ceremonies against a fake
// CredentialsContainer that records whether create()/get() ran before the
// caller awaited anything (the user's click must still be active).
const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const hypercoreCrypto = require('hypercore-crypto')
const passkey = require('../lib/passkey')
const { hkdfSha256 } = require('../lib/hkdf')

const {
  PRF_EVAL, HKDF_SALT, HKDF_INFO,
  seedFromPrf, keyPairFromPrf, rpIdFor, supportStatus, createOptions, getOptions,
  register, completeRegistration, signIn, toBase64Url, fromBase64Url
} = passkey

// Golden vector, computed once and pinned: PRF = 00 01 02 .. 1f. Any change
// to a label, the KDF or the key derivation fails here.
const GOLDEN_PRF = new Uint8Array(32).map((_, i) => i)
const GOLDEN_SEED = '8b185f1b1aada2d7124b67aaa6acbfc89136f743f1e1fe48a48c232718a19b4c'
const GOLDEN_PUBLIC_KEY = '8f661848c6dce93f57bae57ee588857959f35163cba676f3d19846f96e52b0a5'

const RP_ID = 'bora.varanda.app'
const hex = (buf) => buf instanceof ArrayBuffer
  ? b4a.toString(b4a.from(buf), 'hex')
  : b4a.toString(b4a.from(buf.buffer, buf.byteOffset, buf.byteLength), 'hex')

async function codeOf (promiseOrFn) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn)
  } catch (err) {
    return err.code || err.name
  }
  return null
}

function domError (name) {
  const err = new Error('browser text that must not reach the member')
  err.name = name
  return err
}

// A fake PublicKeyCredential. prf: what getClientExtensionResults().prf holds.
function fakeCredential ({ rawId = new Uint8Array([1, 2, 3, 4]).buffer, prf, userHandle = null } = {}) {
  return {
    rawId,
    response: { userHandle },
    getClientExtensionResults: () => (prf === undefined ? {} : { prf })
  }
}

// A fake CredentialsContainer. `synchronous` records, for each call, whether
// it happened before the ceremony's caller got control back.
function fakeContainer ({ create, get } = {}) {
  const calls = { create: [], get: [] }
  let returned = true
  const record = (kind, impl) => (options) => {
    calls[kind].push({ options, synchronous: !returned })
    if (impl instanceof Error) return Promise.reject(impl)
    return Promise.resolve(typeof impl === 'function' ? impl(options) : impl)
  }
  return {
    calls,
    // Wraps a ceremony call: marks the window in which create()/get() count
    // as synchronous (between the call and its return).
    run (fn) {
      returned = false
      const p = fn(this)
      returned = true
      return p
    },
    create: record('create', create),
    get: record('get', get)
  }
}

test('golden vector: fixed PRF -> fixed seed and public key', async (t) => {
  const seed = await seedFromPrf(GOLDEN_PRF)
  t.is(hex(seed), GOLDEN_SEED, 'seed')
  t.is(hex(crypto.hkdfSync('sha256', GOLDEN_PRF, HKDF_SALT, HKDF_INFO, 32)), GOLDEN_SEED, 'seed matches node:crypto hkdfSync')
  const kp = await keyPairFromPrf(GOLDEN_PRF)
  t.is(hex(kp.publicKey), GOLDEN_PUBLIC_KEY, 'public key')
  t.is(kp.publicKey.byteLength, 32)
  t.is(kp.secretKey.byteLength, 64)

  // Independent Ed25519 check: node:crypto from the same seed (PKCS#8 wrap).
  const der = b4a.concat([b4a.from('302e020100300506032b657004220420', 'hex'), b4a.from(GOLDEN_SEED, 'hex')])
  const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))
  const spki = pub.export({ format: 'der', type: 'spki' })
  t.is(hex(spki.subarray(spki.length - 32)), GOLDEN_PUBLIC_KEY, 'node:crypto Ed25519 agrees')

  // The key signs and verifies as a hypercore key pair.
  const msg = b4a.from('varanda')
  const sig = hypercoreCrypto.sign(msg, b4a.from(kp.secretKey))
  t.ok(hypercoreCrypto.verify(msg, sig, b4a.from(kp.publicKey)), 'signature verifies')
  t.alike(Array.from(GOLDEN_PRF), Array.from({ length: 32 }, (_, i) => i), 'caller PRF untouched')
})

test('labels are raw UTF-8 v1', (t) => {
  t.is(b4a.toString(PRF_EVAL), 'varanda/member-identity/prf/v1')
  t.is(b4a.toString(HKDF_SALT), 'varanda/member-identity/hkdf/v1')
  t.is(b4a.toString(HKDF_INFO), 'varanda/member-identity/ed25519/v1')
})

test('derivation: deterministic, PRF-sensitive, length-checked', async (t) => {
  const a = await keyPairFromPrf(new Uint8Array(32).fill(7))
  const b = await keyPairFromPrf(new Uint8Array(32).fill(7))
  const c = await keyPairFromPrf(new Uint8Array(32).fill(8))
  t.is(hex(a.publicKey), hex(b.publicKey), 'same PRF, same key')
  t.is(hex(a.secretKey), hex(b.secretKey))
  t.not(hex(a.publicKey), hex(c.publicKey), 'different PRF, different key')
  t.not(a.secretKey.buffer, b.secretKey.buffer, 'fresh buffers')

  for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0), 'x'.repeat(32), null, new Uint8Array(32).buffer]) {
    t.is(await codeOf(() => seedFromPrf(bad)), 'TypeError', 'seedFromPrf refuses ' + (bad && bad.byteLength))
    t.is(await codeOf(() => keyPairFromPrf(bad)), 'TypeError', 'keyPairFromPrf refuses ' + (bad && bad.byteLength))
  }
  t.is(await codeOf(() => seedFromPrf(new Uint8Array(32))), null, 'any 32 bytes accepted')
})

test('keyPairFromPrf zeroes the seed and hypercore-crypto\'s key pair', async (t) => {
  const original = hypercoreCrypto.keyPair
  let seenSeed = null
  let made = null
  hypercoreCrypto.keyPair = (seed) => {
    seenSeed = seed
    t.is(hex(seed), GOLDEN_SEED, 'the HKDF seed reaches keyPair')
    made = original(seed)
    return made
  }
  try {
    const kp = await keyPairFromPrf(GOLDEN_PRF)
    t.is(hex(kp.publicKey), GOLDEN_PUBLIC_KEY)
    t.ok(seenSeed.every((x) => x === 0), 'seed zeroed')
    t.ok(made.secretKey.every((x) => x === 0), 'internal secret key zeroed')
    t.ok(kp.secretKey.some((x) => x !== 0), 'returned copy intact')
  } finally {
    hypercoreCrypto.keyPair = original
  }
})

test('rpIdFor: the exact host, never an IP', async (t) => {
  t.is(rpIdFor('bora.varanda.app'), 'bora.varanda.app')
  t.is(rpIdFor('LOCALHOST'), 'localhost')
  t.is(rpIdFor('Bora.Varanda.App'), 'bora.varanda.app')
  for (const bad of ['127.0.0.1', '[::1]', '::1', '', '10.0.0.2', null, undefined, 'a b', 'host:443']) {
    let err = null
    try { rpIdFor(bad) } catch (e) { err = e }
    t.is(err && err.code, 'UNSUPPORTED', 'refuses ' + JSON.stringify(bad))
    t.is(err && err.message, 'passkeys exigem um nome de domínio (use localhost no desenvolvimento)')
  }
})

test('supportStatus', async (t) => {
  const PKC = function () {}
  t.alike(await supportStatus({}), { webauthn: false, prf: 'unknown' }, 'no WebAuthn')
  t.alike(await supportStatus({ PublicKeyCredential: PKC, isSecureContext: false }), { webauthn: false, prf: 'unknown' }, 'insecure context')
  t.alike(await supportStatus({ PublicKeyCredential: PKC, isSecureContext: true }), { webauthn: true, prf: 'unknown' }, 'no getClientCapabilities')
  const withCaps = (caps) => Object.assign(function () {}, { getClientCapabilities: async () => caps })
  t.alike(await supportStatus({ PublicKeyCredential: withCaps({ 'extension:prf': true }), isSecureContext: true }), { webauthn: true, prf: 'yes' })
  t.alike(await supportStatus({ PublicKeyCredential: withCaps({ 'extension:prf': false }), isSecureContext: true }), { webauthn: true, prf: 'no' })
  t.alike(await supportStatus({ PublicKeyCredential: withCaps({}), isSecureContext: true }), { webauthn: true, prf: 'unknown' })
  const throwing = Object.assign(function () {}, { getClientCapabilities: async () => { throw new Error('x') } })
  t.alike(await supportStatus({ PublicKeyCredential: throwing, isSecureContext: true }), { webauthn: true, prf: 'unknown' })
})

test('base64url helpers', (t) => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01])
  const s = toBase64Url(bytes)
  t.is(s, '-_-_AAE')
  t.alike(Array.from(fromBase64Url(s)), Array.from(bytes))
  t.ok(fromBase64Url(s) instanceof Uint8Array)
  t.is(toBase64Url(bytes.buffer), s, 'accepts an ArrayBuffer')
  for (const bad of ['a+b/', 'abc=', 'a', 12, null]) {
    let err = null
    try { fromBase64Url(bad) } catch (e) { err = e }
    t.ok(err instanceof TypeError, 'refuses ' + JSON.stringify(bad))
  }
})

test('createOptions and getOptions', (t) => {
  const userId = new Uint8Array(32).fill(0xab)
  const excluded = toBase64Url(new Uint8Array([9, 8, 7]))
  const c = createOptions({ rpId: RP_ID, userId, excludeCredentialIds: [excluded] })
  t.alike(c.rp, { id: RP_ID, name: 'Varanda' })
  t.is(c.user.id.byteLength, 32, 'user.id 32 bytes')
  t.is(c.user.name, 'Varanda ababab')
  t.is(c.user.displayName, 'Varanda ababab')
  t.is(c.challenge.byteLength, 32)
  t.alike(c.pubKeyCredParams, [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }])
  t.alike(c.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' })
  t.is(c.attestation, 'none')
  t.is(c.timeout, 120000)
  t.is(c.excludeCredentials.length, 1)
  t.is(c.excludeCredentials[0].type, 'public-key')
  t.ok(c.excludeCredentials[0].id instanceof Uint8Array, 'excludeCredentials id is bytes, not a string')
  t.alike(Array.from(c.excludeCredentials[0].id), [9, 8, 7])
  t.alike(Array.from(c.extensions.prf.eval.first), Array.from(PRF_EVAL), 'eval.first = PRF_EVAL')
  t.absent(JSON.stringify(c).includes('@'), 'no @ in the creation options')
  t.not(hex(c.challenge), hex(createOptions({ rpId: RP_ID, userId }).challenge), 'fresh challenge')

  const g = getOptions({ rpId: RP_ID })
  t.is(g.rpId, RP_ID)
  t.is(g.challenge.byteLength, 32)
  t.is(g.userVerification, 'required')
  t.is(g.timeout, 120000)
  t.absent('allowCredentials' in g, 'discoverable without ids')
  t.alike(Array.from(g.extensions.prf.eval.first), Array.from(PRF_EVAL))
  t.absent(JSON.stringify(g).includes('@'), 'no @ in the request options')

  const g2 = getOptions({ rpId: RP_ID, allowCredentialIds: [excluded] })
  t.is(g2.allowCredentials[0].type, 'public-key')
  t.ok(g2.allowCredentials[0].id instanceof Uint8Array, 'allowCredentials id is bytes, not a string')
  t.alike(Array.from(g2.allowCredentials[0].id), [9, 8, 7])

  const thrown = (fn) => { try { fn() } catch (err) { return err.message } return null }
  t.is(thrown(() => createOptions({ rpId: RP_ID, userId: new Uint8Array(16) })), 'identificador de usuário inválido')
  t.is(thrown(() => createOptions({ userId })), 'rp.id inválido')
})

test('register: PRF output on create', async (t) => {
  const rawId = new Uint8Array([0xfb, 0xff, 0x01])
  const first = new Uint8Array(32).fill(5).buffer // an ArrayBuffer, as browsers give it
  const box = fakeContainer({ create: fakeCredential({ rawId: rawId.buffer, prf: { enabled: true, results: { first } } }) })
  const userId = new Uint8Array(32).fill(0x11)
  const res = await box.run((c) => register(c, { rpId: RP_ID, userId }))
  t.is(box.calls.create.length, 1)
  t.ok(box.calls.create[0].synchronous, 'create() called before the caller awaited')
  t.is(box.calls.get.length, 0)
  const opts = box.calls.create[0].options.publicKey
  t.is(opts.rp.id, RP_ID)
  t.alike(Array.from(opts.user.id), Array.from(userId))
  t.is(res.credentialId, toBase64Url(rawId))
  t.is(res.userId, b4a.toString(b4a.from(userId), 'hex'))
  t.ok(res.prf instanceof Uint8Array)
  t.alike(Array.from(res.prf), new Array(32).fill(5))
  t.absent(res.pending)
})

test('register: draws a userId when none is given', async (t) => {
  const box = fakeContainer({ create: fakeCredential({ prf: { enabled: true, results: { first: new Uint8Array(32).fill(1) } } }) })
  const res = await box.run((c) => register(c, { rpId: RP_ID }))
  t.is(res.userId.length, 64)
  t.is(hex(box.calls.create[0].options.publicKey.user.id), res.userId)
})

test('register: enabled without results -> pending, no get(); completeRegistration finishes', async (t) => {
  const rawId = new Uint8Array([7, 7, 7, 7])
  const box = fakeContainer({
    create: fakeCredential({ rawId: rawId.buffer, prf: { enabled: true } }),
    get: () => fakeCredential({ rawId: rawId.buffer, prf: { results: { first: new Uint8Array(32).fill(9) } }, userHandle: new Uint8Array(32).fill(0x22).buffer })
  })
  const userId = new Uint8Array(32).fill(0x22)
  const res = await box.run((c) => register(c, { rpId: RP_ID, userId, excludeCredentialIds: [toBase64Url(new Uint8Array([1]))] }))
  t.alike(res, { credentialId: toBase64Url(rawId), userId: '22'.repeat(32), pending: true })
  t.is(box.calls.get.length, 0, 'zero get() calls')
  t.ok(box.calls.create[0].options.publicKey.excludeCredentials[0].id instanceof Uint8Array, 'exclude id is bytes')

  const done = await box.run((c) => completeRegistration(c, { rpId: RP_ID, credentialId: res.credentialId }))
  t.is(box.calls.get.length, 1)
  t.ok(box.calls.get[0].synchronous, 'get() called before the caller awaited')
  const allow = box.calls.get[0].options.publicKey.allowCredentials
  t.is(allow.length, 1)
  t.is(allow[0].type, 'public-key')
  t.ok(allow[0].id instanceof Uint8Array, 'allowCredentials id is a Uint8Array')
  t.alike(Array.from(allow[0].id), Array.from(rawId))
  t.is(done.credentialId, res.credentialId)
  t.alike(Array.from(done.prf), new Array(32).fill(9))
  t.is(done.userHandle, '22'.repeat(32))
})

test('register: errors', async (t) => {
  const noPrf = fakeContainer({ create: fakeCredential({ prf: { enabled: false } }) })
  t.is(await codeOf(noPrf.run((c) => register(c, { rpId: RP_ID }))), 'NO_PRF', 'enabled: false -> NO_PRF')
  const noExt = fakeContainer({ create: fakeCredential({}) })
  t.is(await codeOf(noExt.run((c) => register(c, { rpId: RP_ID }))), 'NO_PRF', 'no prf extension -> NO_PRF')
  const shortPrf = fakeContainer({ create: fakeCredential({ prf: { enabled: true, results: { first: new Uint8Array(16) } } }) })
  t.is(await codeOf(shortPrf.run((c) => register(c, { rpId: RP_ID }))), 'NO_PRF', '16-byte output -> NO_PRF')

  for (const [name, code] of [['NotAllowedError', 'CANCELLED'], ['AbortError', 'CANCELLED'], ['InvalidStateError', 'EXISTS'], ['SecurityError', 'UNSUPPORTED'], ['UnknownError', 'WEBAUTHN']]) {
    const box = fakeContainer({ create: domError(name) })
    let err = null
    try { await box.run((c) => register(c, { rpId: RP_ID })) } catch (e) { err = e }
    t.is(err.code, code, name + ' -> ' + code)
    t.is(err.message, passkey.MESSAGES[code], 'fixed pt-BR message')
    t.ok(box.calls.create[0].synchronous)
  }
  const nothing = fakeContainer({ create: null })
  t.is(await codeOf(nothing.run((c) => register(c, { rpId: RP_ID }))), 'WEBAUTHN', 'null credential -> WEBAUTHN')

  // Permanent authenticator limits are UNSUPPORTED, not "try again".
  for (const name of ['ConstraintError', 'NotSupportedError']) {
    const box = fakeContainer({ create: domError(name) })
    let err = null
    try { await box.run((c) => register(c, { rpId: RP_ID })) } catch (e) { err = e }
    t.is(err.code, 'UNSUPPORTED', name + ' -> UNSUPPORTED')
    t.not(err.message, passkey.MESSAGES.WEBAUTHN, name + ' is not presented as retryable')
  }

  // A passkey created without PRF still exists in the manager: the error
  // carries its id so the caller can exclude it and name it.
  let orphan = null
  try { await noPrf.run((c) => register(c, { rpId: RP_ID })) } catch (e) { orphan = e }
  t.is(orphan.code, 'NO_PRF')
  t.is(orphan.credentialId, passkey.toBase64Url(new Uint8Array([1, 2, 3, 4])), 'credentialId of the unusable passkey')
  t.ok(/^[0-9a-f]{64}$/.test(orphan.userId), 'userId of the unusable passkey')
})

test('signIn: discoverable, userHandle, errors', async (t) => {
  const first = new Uint8Array(32).fill(3)
  const box = fakeContainer({ get: fakeCredential({ prf: { results: { first } }, userHandle: new Uint8Array(32).fill(0xcd).buffer }) })
  const res = await box.run((c) => signIn(c, { rpId: RP_ID }))
  t.ok(box.calls.get[0].synchronous, 'get() called before the caller awaited')
  t.absent('allowCredentials' in box.calls.get[0].options.publicKey, 'discoverable')
  t.is(res.userHandle, 'cd'.repeat(32))
  t.alike(Array.from(res.prf), new Array(32).fill(3))
  t.ok(first.every((x) => x === 0), 'browser PRF buffer wiped after copying')

  const noHandle = fakeContainer({ get: fakeCredential({ prf: { results: { first: new Uint8Array(32).fill(4) } } }) })
  t.is((await noHandle.run((c) => signIn(c, { rpId: RP_ID }))).userHandle, null, 'no userHandle -> null')

  const noFirst = fakeContainer({ get: fakeCredential({ prf: { results: {} } }) })
  t.is(await codeOf(noFirst.run((c) => signIn(c, { rpId: RP_ID }))), 'NO_PRF', 'get without first -> NO_PRF')
  const shortFirst = fakeContainer({ get: fakeCredential({ prf: { results: { first: new Uint8Array(31) } } }) })
  t.is(await codeOf(shortFirst.run((c) => signIn(c, { rpId: RP_ID }))), 'NO_PRF', 'get with a 31-byte first -> NO_PRF')
  const enabledOnly = fakeContainer({ get: fakeCredential({ prf: { enabled: true } }) })
  t.is(await codeOf(enabledOnly.run((c) => signIn(c, { rpId: RP_ID }))), 'NO_PRF', 'get with only enabled -> NO_PRF')

  const cancelled = fakeContainer({ get: domError('NotAllowedError') })
  t.is(await codeOf(cancelled.run((c) => signIn(c, { rpId: RP_ID }))), 'CANCELLED', 'NotAllowedError -> CANCELLED')
  const invalid = fakeContainer({ get: domError('InvalidStateError') })
  t.is(await codeOf(invalid.run((c) => signIn(c, { rpId: RP_ID }))), 'WEBAUTHN', 'InvalidStateError on get -> WEBAUTHN')
})

test('derivation end to end: same passkey output, same identity', async (t) => {
  const box = fakeContainer({ get: () => fakeCredential({ prf: { results: { first: new Uint8Array(GOLDEN_PRF) } } }) })
  const a = await box.run((c) => signIn(c, { rpId: RP_ID }))
  const b = await box.run((c) => signIn(c, { rpId: RP_ID }))
  t.is(hex((await keyPairFromPrf(a.prf)).publicKey), GOLDEN_PUBLIC_KEY)
  t.is(hex((await keyPairFromPrf(b.prf)).publicKey), GOLDEN_PUBLIC_KEY)
})

test('media key pair: per (PRF, nonce), unrelated to the identity, zeroed buffers', async (t) => {
  const { MEDIA_HKDF_SALT, MEDIA_HKDF_INFO, mediaKeyPairFromPrf } = passkey
  t.is(b4a.toString(MEDIA_HKDF_SALT), 'varanda/member-media/hkdf/v1')
  t.is(b4a.toString(MEDIA_HKDF_INFO), 'varanda/member-media/ed25519/v1')
  const prf = new Uint8Array(32).fill(7)
  const nonce = new Uint8Array(32).map((_, i) => 255 - i)
  const a = await mediaKeyPairFromPrf(prf, nonce)
  const b = await mediaKeyPairFromPrf(new Uint8Array(prf), new Uint8Array(nonce))
  t.is(hex(a.publicKey), hex(b.publicKey), 'same PRF and nonce, same key')
  t.is(hex(a.secretKey), hex(b.secretKey))
  t.is(a.publicKey.byteLength, 32)
  t.is(a.secretKey.byteLength, 64)
  t.not(a.secretKey.buffer, b.secretKey.buffer, 'fresh buffers')
  const other = await mediaKeyPairFromPrf(prf, new Uint8Array(32).fill(1))
  t.not(hex(other.publicKey), hex(a.publicKey), 'another nonce, another key')
  const identity = await keyPairFromPrf(prf)
  t.not(hex(identity.publicKey), hex(a.publicKey), 'not the identity key')
  t.ok(prf.every((x) => x === 7), 'caller PRF untouched')
  t.ok(nonce.every((x, i) => x === 255 - i), 'caller nonce untouched')

  // Cross-checked against node:crypto: info = label || nonce.
  const seed = crypto.hkdfSync('sha256', prf, MEDIA_HKDF_SALT, b4a.concat([MEDIA_HKDF_INFO, nonce]), 32)
  t.is(hex(hypercoreCrypto.keyPair(b4a.from(seed)).publicKey), hex(a.publicKey), 'matches node:crypto hkdfSync')

  // The seed and hypercore-crypto's pair are zeroed.
  const original = hypercoreCrypto.keyPair
  let seenSeed = null
  let made = null
  hypercoreCrypto.keyPair = (s) => {
    seenSeed = s
    made = original(s)
    return made
  }
  try {
    const kp = await mediaKeyPairFromPrf(prf, nonce)
    t.is(hex(kp.publicKey), hex(a.publicKey))
    t.ok(seenSeed.every((x) => x === 0), 'seed zeroed')
    t.ok(made.secretKey.every((x) => x === 0), 'internal secret key zeroed')
  } finally {
    hypercoreCrypto.keyPair = original
  }

  for (const bad of [new Uint8Array(31), new Uint8Array(33), null, 'x'.repeat(32), new Uint8Array(32).buffer]) {
    t.is(await codeOf(() => mediaKeyPairFromPrf(bad, nonce)), 'TypeError', 'bad PRF refused')
    t.is(await codeOf(() => mediaKeyPairFromPrf(prf, bad)), 'TypeError', 'bad nonce refused')
  }
  t.is(await codeOf(() => mediaKeyPairFromPrf(prf)), 'TypeError', 'a nonce is required')
})

// An injected HKDF (the Bare worklet's, over bare-crypto's HMAC) must give
// the very same keys as the WebCrypto path.
const injectedHkdf = (ikm, salt, info, length) => hkdfSha256(ikm, salt, info, length, {
  hmac: (k, d) => new Uint8Array(crypto.createHmac('sha256', k).update(d).digest())
})

test('injected hkdf: identity key pair byte-equal to WebCrypto', async (t) => {
  const golden = await keyPairFromPrf(GOLDEN_PRF, { hkdf: injectedHkdf })
  t.is(hex(golden.publicKey), GOLDEN_PUBLIC_KEY, 'golden public key')
  t.is(hex(await seedFromPrf(GOLDEN_PRF, { hkdf: injectedHkdf })), GOLDEN_SEED, 'golden seed')
  for (let i = 0; i < 5; i++) {
    const prf = new Uint8Array(crypto.randomBytes(32))
    const web = await keyPairFromPrf(prf)
    const injected = await keyPairFromPrf(prf, { hkdf: injectedHkdf })
    t.is(hex(injected.publicKey), hex(web.publicKey), 'public key ' + i)
    t.is(hex(injected.secretKey), hex(web.secretKey), 'secret key ' + i)
  }
  t.alike(Array.from(GOLDEN_PRF), Array.from({ length: 32 }, (_, i) => i), 'caller PRF untouched')
})

test('injected hkdf: media key pair byte-equal to WebCrypto', async (t) => {
  const { mediaKeyPairFromPrf } = passkey
  for (let i = 0; i < 5; i++) {
    const prf = new Uint8Array(crypto.randomBytes(32))
    const nonce = new Uint8Array(crypto.randomBytes(32))
    const nonceHex = hex(nonce)
    const web = await mediaKeyPairFromPrf(prf, nonce)
    const injected = await mediaKeyPairFromPrf(prf, nonce, { hkdf: injectedHkdf })
    t.is(hex(injected.publicKey), hex(web.publicKey), 'public key ' + i)
    t.is(hex(injected.secretKey), hex(web.secretKey), 'secret key ' + i)
    t.is(hex(nonce), nonceHex, 'nonce untouched')
  }
})

test('injected hkdf: receives copies of the labels and its output is checked', async (t) => {
  const { MEDIA_HKDF_SALT, MEDIA_HKDF_INFO, mediaKeyPairFromPrf } = passkey
  const saltHex = hex(HKDF_SALT)
  const infoHex = hex(HKDF_INFO)
  let seen = null
  const vandal = async (ikm, salt, info, length) => {
    seen = { salt: hex(salt), info: hex(info), length }
    const out = await injectedHkdf(ikm, salt, info, length)
    ikm.fill(0)
    salt.fill(0)
    info.fill(0)
    return out
  }
  const kp = await keyPairFromPrf(GOLDEN_PRF, { hkdf: vandal })
  t.is(hex(kp.publicKey), GOLDEN_PUBLIC_KEY)
  t.alike(seen, { salt: saltHex, info: infoHex, length: 32 })
  t.is(hex(HKDF_SALT), saltHex, 'module salt untouched')
  t.is(hex(HKDF_INFO), infoHex, 'module info untouched')
  t.alike(Array.from(GOLDEN_PRF), Array.from({ length: 32 }, (_, i) => i), 'caller PRF untouched')

  const mediaSalt = hex(MEDIA_HKDF_SALT)
  const mediaInfo = hex(MEDIA_HKDF_INFO)
  await mediaKeyPairFromPrf(GOLDEN_PRF, new Uint8Array(32).fill(4), { hkdf: vandal })
  t.is(hex(MEDIA_HKDF_SALT), mediaSalt, 'media salt untouched')
  t.is(hex(MEDIA_HKDF_INFO), mediaInfo, 'media info untouched')

  t.is(await codeOf(() => keyPairFromPrf(GOLDEN_PRF, { hkdf: async () => new Uint8Array(16) })), 'TypeError', 'short output refused')
  t.is(await codeOf(() => keyPairFromPrf(GOLDEN_PRF, { hkdf: async () => 'x'.repeat(32) })), 'TypeError', 'non-bytes refused')
})

// Golden vector of the group derivation: PRF = 00 01 .. 1f, nonce = ff fe .. e0.
const GOLDEN_GROUP_NONCE = new Uint8Array(32).map((_, i) => 255 - i)
const GOLDEN_GROUP_SEED = '66916b6b5dcdc95da41b166c966d0f55369867604aacb16ec464f16e018ca18d'
const GOLDEN_GROUP_PUBLIC_KEY = '9ceb6df34264298a1e1ca4a67f8064ea6fd3a1e62f20f6f4c559e4c8f898b887'

test('group key pair: golden vector, per (PRF, nonce), unrelated to identity and media, zeroed buffers', async (t) => {
  const { GROUP_HKDF_SALT, GROUP_HKDF_INFO, groupKeyPairFromPrf, mediaKeyPairFromPrf } = passkey
  t.is(b4a.toString(GROUP_HKDF_SALT), 'varanda/member-group/hkdf/v1')
  t.is(b4a.toString(GROUP_HKDF_INFO), 'varanda/member-group/ed25519/v1')
  const seed = crypto.hkdfSync('sha256', GOLDEN_PRF, GROUP_HKDF_SALT, b4a.concat([GROUP_HKDF_INFO, GOLDEN_GROUP_NONCE]), 32)
  t.is(hex(seed), GOLDEN_GROUP_SEED, 'seed matches node:crypto hkdfSync')
  const kp = await groupKeyPairFromPrf(GOLDEN_PRF, GOLDEN_GROUP_NONCE)
  t.is(hex(kp.publicKey), GOLDEN_GROUP_PUBLIC_KEY, 'public key')
  t.is(hex(hypercoreCrypto.keyPair(b4a.from(GOLDEN_GROUP_SEED, 'hex')).publicKey), GOLDEN_GROUP_PUBLIC_KEY, 'seed -> public key')
  t.is(kp.secretKey.byteLength, 64)
  t.ok(GOLDEN_PRF.every((x, i) => x === i), 'caller PRF untouched')
  t.ok(GOLDEN_GROUP_NONCE.every((x, i) => x === 255 - i), 'caller nonce untouched')

  const again = await groupKeyPairFromPrf(new Uint8Array(GOLDEN_PRF), new Uint8Array(GOLDEN_GROUP_NONCE))
  t.is(hex(again.secretKey), hex(kp.secretKey), 'deterministic')
  t.not(again.secretKey.buffer, kp.secretKey.buffer, 'fresh buffers')
  const other = await groupKeyPairFromPrf(GOLDEN_PRF, new Uint8Array(32).fill(1))
  t.not(hex(other.publicKey), GOLDEN_GROUP_PUBLIC_KEY, 'another nonce, another key')
  t.not(hex((await mediaKeyPairFromPrf(GOLDEN_PRF, GOLDEN_GROUP_NONCE)).publicKey), GOLDEN_GROUP_PUBLIC_KEY, 'not the media key')
  t.not(hex((await keyPairFromPrf(GOLDEN_PRF)).publicKey), GOLDEN_GROUP_PUBLIC_KEY, 'not the identity key')

  const original = hypercoreCrypto.keyPair
  let seenSeed = null
  let made = null
  hypercoreCrypto.keyPair = (s) => {
    seenSeed = s
    made = original(s)
    return made
  }
  try {
    await groupKeyPairFromPrf(GOLDEN_PRF, GOLDEN_GROUP_NONCE)
    t.ok(seenSeed.every((x) => x === 0), 'seed zeroed')
    t.ok(made.secretKey.every((x) => x === 0), 'internal secret key zeroed')
  } finally {
    hypercoreCrypto.keyPair = original
  }

  for (const bad of [new Uint8Array(31), new Uint8Array(33), null, 'x'.repeat(32), new Uint8Array(32).buffer]) {
    t.is(await codeOf(() => groupKeyPairFromPrf(bad, GOLDEN_GROUP_NONCE)), 'TypeError', 'bad PRF refused')
    t.is(await codeOf(() => groupKeyPairFromPrf(GOLDEN_PRF, bad)), 'TypeError', 'bad nonce refused')
  }
  t.is(await codeOf(() => groupKeyPairFromPrf(GOLDEN_PRF)), 'TypeError', 'a nonce is required')
})

test('injected hkdf: group key pair byte-equal to WebCrypto', async (t) => {
  const { groupKeyPairFromPrf } = passkey
  for (let i = 0; i < 3; i++) {
    const prf = new Uint8Array(crypto.randomBytes(32))
    const nonce = new Uint8Array(crypto.randomBytes(32))
    const web = await groupKeyPairFromPrf(prf, nonce)
    const injected = await groupKeyPairFromPrf(prf, nonce, { hkdf: injectedHkdf })
    t.is(hex(injected.publicKey), hex(web.publicKey), 'public key ' + i)
    t.is(hex(injected.secretKey), hex(web.secretKey), 'secret key ' + i)
  }
})

// Box key pair golden vector, computed once (node:crypto hkdfSync and
// sodium crypto_box_seed_keypair) and pinned.
const GOLDEN_BOX_SEED = '020d767a1c48e4491061e0f40d9047b53b84b653cddb8df3b29fad456d2efb37'
const GOLDEN_BOX_PUBLIC_KEY = '17a2f02a98e348b003c674765cd07c66814426427cd4c887fc329980d607da5e'

test('box key pair: golden vector, per (PRF, nonce), unrelated to the other keys, zeroed buffers', async (t) => {
  const sodium = require('sodium-universal')
  const groupCrypto = require('@varanda/core/lib/group-crypto')
  const { BOX_HKDF_SALT, BOX_HKDF_INFO, boxKeyPairFromPrf, groupKeyPairFromPrf } = passkey
  t.is(b4a.toString(BOX_HKDF_SALT), 'varanda/member-group-box/hkdf/v1')
  t.is(b4a.toString(BOX_HKDF_INFO), 'varanda/member-group-box/x25519/v1')
  const seed = crypto.hkdfSync('sha256', GOLDEN_PRF, BOX_HKDF_SALT, b4a.concat([BOX_HKDF_INFO, GOLDEN_GROUP_NONCE]), 32)
  t.is(hex(seed), GOLDEN_BOX_SEED, 'seed matches node:crypto hkdfSync')
  const kp = await boxKeyPairFromPrf(GOLDEN_PRF, GOLDEN_GROUP_NONCE)
  t.is(hex(kp.publicKey), GOLDEN_BOX_PUBLIC_KEY, 'public key')
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(32)
  sodium.crypto_box_seed_keypair(pk, sk, b4a.from(GOLDEN_BOX_SEED, 'hex'))
  t.is(hex(pk), GOLDEN_BOX_PUBLIC_KEY, 'seed -> public key')
  t.is(hex(kp.secretKey), hex(sk), 'secret key')
  t.is(kp.publicKey.byteLength, 32)
  t.is(kp.secretKey.byteLength, 32)
  t.ok(GOLDEN_PRF.every((x, i) => x === i), 'caller PRF untouched')
  t.ok(GOLDEN_GROUP_NONCE.every((x, i) => x === 255 - i), 'caller nonce untouched')

  const again = await boxKeyPairFromPrf(new Uint8Array(GOLDEN_PRF), new Uint8Array(GOLDEN_GROUP_NONCE))
  t.is(hex(again.secretKey), hex(kp.secretKey), 'deterministic')
  t.not(again.secretKey.buffer, kp.secretKey.buffer, 'fresh buffers')
  t.not(hex((await boxKeyPairFromPrf(GOLDEN_PRF, new Uint8Array(32).fill(1))).publicKey), GOLDEN_BOX_PUBLIC_KEY, 'another nonce, another key')
  const group = await groupKeyPairFromPrf(GOLDEN_PRF, GOLDEN_GROUP_NONCE)
  t.not(hex(group.secretKey.subarray(0, 32)), hex(kp.secretKey), 'not the group core seed')

  // A box sealed to the derived public key opens with the derived pair.
  const sealed = groupCrypto.sealTo(b4a.from('epoch key'), b4a.from(kp.publicKey))
  const opened = groupCrypto.openFrom(sealed, { publicKey: b4a.from(kp.publicKey), secretKey: b4a.from(kp.secretKey) })
  t.is(b4a.toString(opened), 'epoch key', 'usable with crypto_box_seal')

  const original = groupCrypto.boxKeyPairFromSeed
  let seenSeed = null
  let made = null
  groupCrypto.boxKeyPairFromSeed = (s) => {
    seenSeed = s
    made = original(s)
    return made
  }
  try {
    const kp2 = await boxKeyPairFromPrf(GOLDEN_PRF, GOLDEN_GROUP_NONCE)
    t.is(hex(kp2.publicKey), GOLDEN_BOX_PUBLIC_KEY)
    t.ok(seenSeed.every((x) => x === 0), 'seed zeroed')
    t.ok(made.secretKey.every((x) => x === 0), 'internal secret key zeroed')
  } finally {
    groupCrypto.boxKeyPairFromSeed = original
  }

  for (const bad of [new Uint8Array(31), new Uint8Array(33), null, 'x'.repeat(32), new Uint8Array(32).buffer]) {
    t.is(await codeOf(() => boxKeyPairFromPrf(bad, GOLDEN_GROUP_NONCE)), 'TypeError', 'bad PRF refused')
    t.is(await codeOf(() => boxKeyPairFromPrf(GOLDEN_PRF, bad)), 'TypeError', 'bad nonce refused')
  }
  t.is(await codeOf(() => boxKeyPairFromPrf(GOLDEN_PRF)), 'TypeError', 'a nonce is required')
})

test('injected hkdf: box key pair byte-equal to WebCrypto', async (t) => {
  const { boxKeyPairFromPrf } = passkey
  for (let i = 0; i < 3; i++) {
    const prf = new Uint8Array(crypto.randomBytes(32))
    const nonce = new Uint8Array(crypto.randomBytes(32))
    const web = await boxKeyPairFromPrf(prf, nonce)
    const injected = await boxKeyPairFromPrf(prf, nonce, { hkdf: injectedHkdf })
    t.is(hex(injected.publicKey), hex(web.publicKey), 'public key ' + i)
    t.is(hex(injected.secretKey), hex(web.secretKey), 'secret key ' + i)
  }
})
