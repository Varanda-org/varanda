// The WebAuthn JSON (base64url fields, the form Android's Credential Manager
// and the local passkey-prf module take) of the ceremonies that
// packages/web-member/lib/passkey.js runs in the browser. The same account on
// the app and on the web needs the same PRF output, so every field that
// reaches the authenticator matches createOptions / getOptions there: the
// rp.id (the installation hostname), the PRF input
// utf8('varanda/member-identity/prf/v1'), resident key and user verification
// required, ES256 and RS256. test/passkeyOptions.test.js compares them with
// the web module's own constants.
//
// Pure: no React, no react-native, no Node built-in. The caller draws the
// random challenge and user id (globalThis.crypto.getRandomValues).
//
// Every failure is an Error with a `.code` and the pt-BR text of passkey.js
// MESSAGES.

export const PRF_INPUT = 'varanda/member-identity/prf/v1'
export const RP_NAME = 'Varanda'
export const PRF_BYTES = 32
export const USER_ID_BYTES = 32
export const CHALLENGE_BYTES = 32
export const TIMEOUT_MS = 120000

export const MESSAGES = Object.freeze({
  UNSUPPORTED: 'este endereço não pode usar passkeys',
  NO_PRF: 'este navegador ou gerenciador de senhas não oferece a extensão PRF das passkeys; o Varanda precisa dela para derivar a identidade',
  CANCELLED: 'entrada com a passkey cancelada',
  EXISTS: 'já existe uma passkey do Varanda neste gerenciador: use entrar',
  WEBAUTHN: 'a passkey não respondeu; tente de novo'
})

export function passkeyError (code, message = MESSAGES[code]) {
  const err = new Error(message)
  err.code = code
  return err
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_INDEX = (() => {
  const map = new Map()
  for (let i = 0; i < B64.length; i++) map.set(B64[i], i)
  return map
})()

export function toBase64Url (bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes inválidos')
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64[n >> 18] + B64[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

// -> a Uint8Array; throws TypeError on anything that is not unpadded or padded
// base64url (some platforms pad, none should use the + / alphabet).
export function fromBase64Url (str) {
  if (typeof str !== 'string') throw new TypeError('base64url inválido')
  const s = str.replace(/=+$/, '')
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new TypeError('base64url inválido')
  const out = new Uint8Array(Math.floor(s.length * 3 / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (const ch of s) {
    acc = (acc << 6) | B64_INDEX.get(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export function toHex (bytes) {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function utf8 (str) {
  return new TextEncoder().encode(str)
}

function checkBytes (value, length, message) {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new TypeError(message)
}

function checkRpId (rpId) {
  if (typeof rpId !== 'string' || rpId === '') throw new TypeError('rp.id inválido')
}

function prfExtension () {
  return { prf: { eval: { first: toBase64Url(utf8(PRF_INPUT)) } } }
}

// userId and challenge: 32 random bytes each, drawn by the caller. The label
// is 'Varanda <6 hex>' like the web's: never an email or a platform account.
export function buildCreateOptions ({ rpId, userId, challenge } = {}) {
  checkRpId(rpId)
  checkBytes(userId, USER_ID_BYTES, 'identificador de usuário inválido')
  checkBytes(challenge, CHALLENGE_BYTES, 'desafio inválido')
  const label = RP_NAME + ' ' + toHex(userId).slice(0, 6)
  return {
    rp: { id: rpId, name: RP_NAME },
    user: { id: toBase64Url(userId), name: label, displayName: label },
    challenge: toBase64Url(challenge),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    timeout: TIMEOUT_MS,
    excludeCredentials: [],
    extensions: prfExtension()
  }
}

// Without ids the request is discoverable: the credential manager offers every
// Varanda passkey for this rp.id, the ones the web created included.
export function buildGetOptions ({ rpId, challenge, allowCredentialIds = [] } = {}) {
  checkRpId(rpId)
  checkBytes(challenge, CHALLENGE_BYTES, 'desafio inválido')
  if (!Array.isArray(allowCredentialIds)) throw new TypeError('identificadores de passkey inválidos')
  const options = {
    rpId,
    challenge: toBase64Url(challenge),
    userVerification: 'required',
    timeout: TIMEOUT_MS,
    extensions: prfExtension()
  }
  if (allowCredentialIds.length > 0) {
    options.allowCredentials = allowCredentialIds.map((id) => {
      fromBase64Url(id)
      return { type: 'public-key', id }
    })
  }
  return options
}

function responseObject (response) {
  if (typeof response === 'string') {
    try {
      return JSON.parse(response)
    } catch {
      throw passkeyError('WEBAUTHN')
    }
  }
  if (response !== null && typeof response === 'object') return response
  throw passkeyError('WEBAUTHN')
}

function prfResults (response) {
  const ext = responseObject(response).clientExtensionResults
  return ext !== null && typeof ext === 'object' && ext.prf !== null && typeof ext.prf === 'object' ? ext.prf : null
}

// The 32-byte PRF output of a ceremony's response JSON, or NO_PRF.
export function parsePrf (response) {
  const prf = prfResults(response)
  const first = prf !== null && prf.results ? prf.results.first : undefined
  if (typeof first !== 'string') throw passkeyError('NO_PRF')
  let out
  try {
    out = fromBase64Url(first)
  } catch {
    throw passkeyError('NO_PRF')
  }
  if (out.byteLength !== PRF_BYTES) {
    out.fill(0)
    throw passkeyError('NO_PRF')
  }
  return out
}

// A creation without the output may still say the extension is on (results
// on create are optional in WebAuthn L3): a second ceremony then fetches it.
export function prfEnabled (response) {
  const prf = prfResults(response)
  return prf !== null && prf.enabled === true
}

// The credential id (base64url) of a response, or WEBAUTHN.
export function credentialIdOf (response) {
  const r = responseObject(response)
  const id = typeof r.rawId === 'string' && r.rawId !== '' ? r.rawId : r.id
  if (typeof id !== 'string' || id === '' || id.length > 1024 || !/^[A-Za-z0-9_-]+=*$/.test(id)) throw passkeyError('WEBAUTHN')
  return id.replace(/=+$/, '')
}

// The hex of the passkey's user handle when the authenticator returned it,
// else ''.
export function userHandleOf (response) {
  const r = responseObject(response)
  const handle = r.response !== null && typeof r.response === 'object' ? r.response.userHandle : null
  if (typeof handle !== 'string' || handle === '') return ''
  try {
    const bytes = fromBase64Url(handle)
    return bytes.byteLength > 0 && bytes.byteLength <= 64 ? toHex(bytes) : ''
  } catch {
    return ''
  }
}
