// The member identity behind a WebAuthn passkey: the PRF extension's output
// for one fixed input, run through HKDF-SHA-256, is the seed of the diary's
// Ed25519 key pair. The passkey lives in the member's password manager (the
// Google Password Manager syncs it across devices), so the same account opens
// the same identity everywhere and no secret is ever stored by Varanda.
//
// Derivation, version 1 (any change here changes every member's key):
//   prf  = PRF(credential, utf8('varanda/member-identity/prf/v1'))  32 bytes
//   seed = HKDF-SHA-256(ikm = prf, salt = utf8('varanda/member-identity/hkdf/v1'),
//                       info = utf8('varanda/member-identity/ed25519/v1'), 32)
//   keyPair = hypercore-crypto.keyPair(seed)   (crypto_sign_seed_keypair)
// Nothing else (challenge, credential id, rp.id, device, association) enters
// it. The labels are raw UTF-8 bytes, not hashes, so every option is built
// synchronously and the WebAuthn call stays inside the user's click.
//
// Browser-bundleable: no Node builtin, only globalThis.crypto (subtle and
// getRandomValues), b4a and hypercore-crypto. The ceremonies take the
// CredentialsContainer as a parameter (navigator.credentials in the page, a
// fake in the tests) and call create()/get() before any await.
//
// Every failure is an Error with a `.code` (UNSUPPORTED, NO_PRF, CANCELLED,
// EXISTS, WEBAUTHN) and a fixed pt-BR message; the browser's own text is
// never shown.
const b4a = require('b4a')
const hypercoreCrypto = require('hypercore-crypto')

const PRF_EVAL = b4a.from('varanda/member-identity/prf/v1', 'utf8')
const HKDF_SALT = b4a.from('varanda/member-identity/hkdf/v1', 'utf8')
const HKDF_INFO = b4a.from('varanda/member-identity/ed25519/v1', 'utf8')

const PRF_BYTES = 32
const USER_ID_BYTES = 32
const CHALLENGE_BYTES = 32
const TIMEOUT_MS = 120000
const RP_NAME = 'Varanda'

const MESSAGES = {
  UNSUPPORTED: 'este endereço não pode usar passkeys',
  NO_PRF: 'este navegador ou gerenciador de senhas não oferece a extensão PRF das passkeys; o Varanda precisa dela para derivar a identidade',
  CANCELLED: 'entrada com a passkey cancelada',
  EXISTS: 'já existe uma passkey do Varanda neste gerenciador: use entrar',
  WEBAUTHN: 'a passkey não respondeu; tente de novo'
}
const NO_DOMAIN = 'passkeys exigem um nome de domínio (use localhost no desenvolvimento)'
const AUTHENTICATOR_UNFIT = 'este autenticador não atende ao que a passkey do Varanda exige (guardada no gerenciador e com biometria ou PIN); use outro gerenciador ou aparelho'

function passkeyError (code, message = MESSAGES[code]) {
  const err = new Error(message)
  err.code = code
  return err
}

// A caller bug (bad argument), kept apart from WebAuthn failures so the
// ceremonies do not turn it into WEBAUTHN.
function argumentError (message) {
  const err = new TypeError(message)
  err.passkeyArgument = true
  return err
}

// Maps whatever create()/get() threw to one of the codes above.
function mapError (err, ceremony) {
  if (err && err.passkeyArgument === true) return err
  if (err && typeof err.code === 'string' && Object.hasOwn(MESSAGES, err.code) && err.message === MESSAGES[err.code]) return err
  const name = err && typeof err.name === 'string' ? err.name : ''
  if (name === 'NotAllowedError' || name === 'AbortError') return passkeyError('CANCELLED')
  if (name === 'InvalidStateError' && ceremony === 'create') return passkeyError('EXISTS')
  if (name === 'SecurityError') return passkeyError('UNSUPPORTED')
  // Permanent for this authenticator (no resident credential, no user
  // verification, no usable algorithm): retrying cannot help.
  if (name === 'ConstraintError' || name === 'NotSupportedError') return passkeyError('UNSUPPORTED', AUTHENTICATOR_UNFIT)
  return passkeyError('WEBAUTHN')
}

// A fresh Uint8Array copy of a BufferSource (ArrayBuffer or any view), or
// null. WebAuthn hands out ArrayBuffers; copying first keeps the length check
// and the zeroing on memory this module owns.
function copyBytes (value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  return null
}

// Best effort: the source may be read-only or detached.
function wipe (value) {
  try {
    if (value instanceof ArrayBuffer) new Uint8Array(value).fill(0)
    else if (ArrayBuffer.isView(value)) new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0)
  } catch {}
}

function randomBytes (n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

function toBase64Url (buf) {
  const bytes = copyBytes(buf)
  if (bytes === null) throw argumentError('bytes inválidos')
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// -> a plain Uint8Array; throws TypeError on anything that is not base64url.
function fromBase64Url (str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) {
    throw argumentError('identificador de passkey inválido')
  }
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)
  return new Uint8Array(b4a.from(b64, 'base64'))
}

function credentialDescriptors (ids) {
  if (!Array.isArray(ids)) throw argumentError('identificadores de passkey inválidos')
  return ids.map((id) => ({ type: 'public-key', id: fromBase64Url(id) }))
}

function prfExtension () {
  return { prf: { eval: { first: new Uint8Array(PRF_EVAL) } } }
}

// HKDF-SHA-256 of a 32-byte PRF output -> the 32-byte Ed25519 seed.
async function seedFromPrf (prf) {
  if (!(prf instanceof Uint8Array) || prf.byteLength !== PRF_BYTES) throw new TypeError('resultado PRF inválido')
  const ikm = new Uint8Array(prf)
  try {
    const subtle = globalThis.crypto.subtle
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO }, key, 256)
    return new Uint8Array(bits)
  } finally {
    ikm.fill(0)
  }
}

// -> { publicKey: Uint8Array(32), secretKey: Uint8Array(64) } in fresh buffers.
// The seed and the key pair hypercore-crypto allocated are zeroed after.
async function keyPairFromPrf (prf) {
  const seed = await seedFromPrf(prf)
  let kp = null
  try {
    kp = hypercoreCrypto.keyPair(seed)
    return { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) }
  } finally {
    seed.fill(0)
    if (kp) kp.secretKey.fill(0)
  }
}

// The rp.id is the page's exact host: no registrable-domain widening, so no
// other origin under the same apex can ask for this passkey's PRF. An IP
// literal cannot be an rp.id, so local development uses localhost.
function rpIdFor (hostname) {
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : ''
  if (host === '' || host.includes(':') || host.includes('[') || host.includes(']') ||
      /^[0-9.]+$/.test(host) || !/^[a-z0-9.-]+$/.test(host)) {
    throw passkeyError('UNSUPPORTED', NO_DOMAIN)
  }
  return host
}

// -> { webauthn, prf: 'yes' | 'no' | 'unknown' }. Only getClientCapabilities()
// can say 'no' before a ceremony; without it the answer comes from register().
async function supportStatus (globals = globalThis) {
  const PKC = globals ? globals.PublicKeyCredential : undefined
  const webauthn = typeof PKC === 'function' && globals.isSecureContext === true
  let prf = 'unknown'
  if (webauthn && typeof PKC.getClientCapabilities === 'function') {
    try {
      const caps = await PKC.getClientCapabilities()
      const value = caps ? caps['extension:prf'] : undefined
      if (value === true) prf = 'yes'
      else if (value === false) prf = 'no'
    } catch {}
  }
  return { webauthn, prf }
}

// userId: the caller's 32 random bytes (the passkey's user handle). The label
// is 'Varanda <6 hex>': never an email or a Google identifier.
function createOptions ({ rpId, userId, excludeCredentialIds = [] } = {}) {
  if (typeof rpId !== 'string' || rpId === '') throw argumentError('rp.id inválido')
  if (!(userId instanceof Uint8Array) || userId.byteLength !== USER_ID_BYTES) throw argumentError('identificador de usuário inválido')
  const label = RP_NAME + ' ' + b4a.toString(userId, 'hex').slice(0, 6)
  return {
    rp: { id: rpId, name: RP_NAME },
    user: { id: new Uint8Array(userId), name: label, displayName: label },
    challenge: randomBytes(CHALLENGE_BYTES),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    timeout: TIMEOUT_MS,
    excludeCredentials: credentialDescriptors(excludeCredentialIds),
    extensions: prfExtension()
  }
}

// Without ids the request is discoverable: the password manager offers every
// Varanda passkey for this rp.id.
function getOptions ({ rpId, allowCredentialIds = [] } = {}) {
  if (typeof rpId !== 'string' || rpId === '') throw argumentError('rp.id inválido')
  const options = {
    rpId,
    challenge: randomBytes(CHALLENGE_BYTES),
    userVerification: 'required',
    timeout: TIMEOUT_MS,
    extensions: prfExtension()
  }
  const allow = credentialDescriptors(allowCredentialIds)
  if (allow.length > 0) options.allowCredentials = allow
  return options
}

// The 32-byte PRF output of a ceremony, copied; null when there is none.
// Throws NO_PRF for an output of any other length.
function prfFirst (prfResults) {
  const first = prfResults && prfResults.results ? prfResults.results.first : undefined
  if (first === undefined || first === null) return null
  const out = copyBytes(first)
  wipe(first)
  if (out === null || out.byteLength !== PRF_BYTES) {
    if (out) out.fill(0)
    throw passkeyError('NO_PRF')
  }
  return out
}

function extensionResults (cred) {
  if (!cred || typeof cred.getClientExtensionResults !== 'function') throw passkeyError('WEBAUTHN')
  const ext = cred.getClientExtensionResults()
  return ext && ext.prf ? ext.prf : null
}

function credentialIdOf (cred) {
  const raw = copyBytes(cred.rawId)
  if (raw === null || raw.byteLength === 0) throw passkeyError('WEBAUTHN')
  return toBase64Url(raw)
}

// Creates the passkey. -> { credentialId, userId, prf } when the PRF output
// came with the creation, or { credentialId, userId, pending: true } when the
// authenticator only said PRF is enabled (results on create are optional in
// WebAuthn L3): the caller then asks for a second click and calls
// completeRegistration(). userId is hex. userId may be omitted: 32 random
// bytes are drawn.
async function register (credentials, { rpId, userId = randomBytes(USER_ID_BYTES), excludeCredentialIds = [] } = {}) {
  let cred
  try {
    cred = await credentials.create({ publicKey: createOptions({ rpId, userId, excludeCredentialIds }) })
  } catch (err) {
    throw mapError(err, 'create')
  }
  const userIdHex = b4a.toString(userId, 'hex')
  let credentialId = null
  try {
    if (!cred) throw passkeyError('WEBAUTHN')
    credentialId = credentialIdOf(cred)
    const ext = extensionResults(cred)
    const prf = prfFirst(ext)
    if (prf !== null) return { credentialId, userId: userIdHex, prf }
    if (!ext || ext.enabled !== true) throw passkeyError('NO_PRF')
    return { credentialId, userId: userIdHex, pending: true }
  } catch (err) {
    const mapped = mapError(err, 'create')
    // The passkey already exists in the manager even though it is unusable:
    // the caller can exclude it next time and name it to the person.
    if (credentialId !== null) {
      mapped.credentialId = credentialId
      mapped.userId = userIdHex
    }
    throw mapped
  }
}

// Unlocks with an existing passkey. -> { credentialId, prf, userHandle }:
// userHandle is the hex of the passkey's user id when the authenticator
// returns it, else null (a second device has no local record of it).
async function signIn (credentials, { rpId, allowCredentialIds = [] } = {}) {
  let cred
  try {
    cred = await credentials.get({ publicKey: getOptions({ rpId, allowCredentialIds }) })
  } catch (err) {
    throw mapError(err, 'get')
  }
  let credentialId = null
  let userHandle = null
  try {
    if (!cred) throw passkeyError('WEBAUTHN')
    credentialId = credentialIdOf(cred)
    const handle = cred.response ? copyBytes(cred.response.userHandle) : null
    userHandle = handle && handle.byteLength > 0 ? b4a.toString(handle, 'hex') : null
    const ext = extensionResults(cred)
    // get() reports no `enabled`: only the output itself counts.
    const prf = prfFirst(ext)
    if (prf === null) throw passkeyError('NO_PRF')
    return { credentialId, prf, userHandle }
  } catch (err) {
    const mapped = mapError(err, 'get')
    // The chosen passkey cannot be used: name it, like register() does.
    if (credentialId !== null) {
      mapped.credentialId = credentialId
      if (userHandle !== null) mapped.userId = userHandle
    }
    throw mapped
  }
}

// The second gesture of a pending registration: a get() restricted to the
// passkey just created.
function completeRegistration (credentials, { rpId, credentialId } = {}) {
  return signIn(credentials, { rpId, allowCredentialIds: [credentialId] })
}

module.exports = {
  PRF_EVAL,
  HKDF_SALT,
  HKDF_INFO,
  MESSAGES,
  seedFromPrf,
  keyPairFromPrf,
  rpIdFor,
  supportStatus,
  createOptions,
  getOptions,
  register,
  completeRegistration,
  signIn,
  toBase64Url,
  fromBase64Url
}
