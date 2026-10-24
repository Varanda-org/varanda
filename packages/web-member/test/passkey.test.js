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
