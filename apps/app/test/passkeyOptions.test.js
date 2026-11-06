'use strict'

// src/passkeyOptions.js: the WebAuthn JSON of the native ceremonies must match
// what packages/web-member/lib/passkey.js hands the browser, byte for byte
// where the authenticator sees it (rp.id, PRF input, requirements).
const test = require('brittle')
const passkey = require('@varanda/web-member/lib/passkey')

const load = () => import('../src/passkeyOptions.js')

const fill = (n, v) => new Uint8Array(n).fill(v)
const b64url = (bytes) => Buffer.from(bytes).toString('base64url')

test('create options match the web createOptions', async (t) => {
  const { buildCreateOptions, fromBase64Url } = await load()
  const userId = fill(32, 0xab)
  const challenge = fill(32, 7)
  const native = buildCreateOptions({ rpId: 'varanda.example', userId, challenge })
  const web = passkey.createOptions({ rpId: 'varanda.example', userId })

  t.alike(native.rp, web.rp)
  t.is(native.user.name, web.user.name)
  t.is(native.user.displayName, web.user.displayName)
  t.alike(fromBase64Url(native.user.id), new Uint8Array(web.user.id))
  t.is(native.user.id, b64url(userId))
  t.is(native.challenge, b64url(challenge))
  t.alike(native.pubKeyCredParams, web.pubKeyCredParams)
  t.alike(native.authenticatorSelection, web.authenticatorSelection)
  t.is(native.attestation, web.attestation)
  t.is(native.timeout, web.timeout)
  t.alike(fromBase64Url(native.extensions.prf.eval.first), new Uint8Array(passkey.PRF_EVAL))
  t.alike(fromBase64Url(native.extensions.prf.eval.first), new Uint8Array(web.extensions.prf.eval.first))
  t.is(native.extensions.prf.eval.first, b64url(passkey.PRF_EVAL))
  t.is(JSON.parse(JSON.stringify(native)).rp.id, 'varanda.example')
})

test('get options match the web getOptions', async (t) => {
  const { buildGetOptions } = await load()
  const challenge = fill(32, 9)
  const native = buildGetOptions({ rpId: 'varanda.example', challenge })
  const web = passkey.getOptions({ rpId: 'varanda.example' })
  t.is(native.rpId, web.rpId)
  t.is(native.userVerification, web.userVerification)
  t.is(native.timeout, web.timeout)
  t.is(native.challenge, b64url(challenge))
  t.is(native.extensions.prf.eval.first, b64url(passkey.PRF_EVAL))
  t.absent(native.allowCredentials)

  const restricted = buildGetOptions({ rpId: 'varanda.example', challenge, allowCredentialIds: ['AQID'] })
  t.alike(restricted.allowCredentials, [{ type: 'public-key', id: 'AQID' }])
  t.exception.all(() => buildGetOptions({ rpId: 'varanda.example', challenge, allowCredentialIds: ['a+b/'] }))
})

test('builders refuse bad arguments', async (t) => {
  const { buildCreateOptions, buildGetOptions } = await load()
  t.exception.all(() => buildCreateOptions({ rpId: '', userId: fill(32, 1), challenge: fill(32, 1) }))
  t.exception.all(() => buildCreateOptions({ rpId: 'a.b', userId: fill(31, 1), challenge: fill(32, 1) }))
  t.exception.all(() => buildCreateOptions({ rpId: 'a.b', userId: fill(32, 1), challenge: fill(16, 1) }))
  t.exception.all(() => buildGetOptions({ rpId: 'a.b' }))
})

test('base64url round trip matches Node', async (t) => {
  const { toBase64Url, fromBase64Url } = await load()
  for (let n = 0; n < 40; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff)
    t.is(toBase64Url(bytes), b64url(bytes))
    t.alike(fromBase64Url(b64url(bytes)), bytes)
  }
  t.alike(fromBase64Url('AQ=='), new Uint8Array([1]))
  t.exception.all(() => fromBase64Url('A'))
  t.exception.all(() => fromBase64Url('a+b/'))
})

test('parsePrf reads the 32-byte output or throws NO_PRF', async (t) => {
  const { parsePrf, prfEnabled, credentialIdOf, userHandleOf } = await load()
  const out = fill(32, 0x5a)
  const response = JSON.stringify({
    id: 'Y3JlZA',
    rawId: 'Y3JlZA',
    response: { userHandle: b64url(fill(32, 1)) },
    clientExtensionResults: { prf: { results: { first: b64url(out) } } }
  })
  t.alike(parsePrf(response), out)
  t.is(credentialIdOf(response), 'Y3JlZA')
  t.is(userHandleOf(response), '01'.repeat(32))

  const noPrf = (r) => {
    try {
      parsePrf(r)
      return null
    } catch (err) {
      return err
    }
  }
  t.is(noPrf({ clientExtensionResults: {} }).code, 'NO_PRF')
  t.is(noPrf({ clientExtensionResults: { prf: { enabled: true } } }).code, 'NO_PRF')
  t.is(noPrf({ clientExtensionResults: { prf: { results: { first: b64url(fill(16, 1)) } } } }).code, 'NO_PRF')
  t.is(noPrf({ clientExtensionResults: { prf: { results: { first: '%%' } } } }).code, 'NO_PRF')
  t.is(noPrf({}).code, 'NO_PRF')
  t.is(noPrf('not json').code, 'WEBAUTHN')
  t.is(noPrf({ clientExtensionResults: {} }).message, passkey.MESSAGES.NO_PRF)

  t.ok(prfEnabled({ clientExtensionResults: { prf: { enabled: true } } }))
  t.absent(prfEnabled({ clientExtensionResults: { prf: { enabled: false } } }))
  t.absent(prfEnabled({}))
  t.is(userHandleOf({ response: {} }), '')
  t.exception.all(() => credentialIdOf({}))
})

test('messages are the web ones', async (t) => {
  const { MESSAGES } = await load()
  t.alike({ ...MESSAGES }, { ...passkey.MESSAGES })
})

test('excludeCredentials match the web descriptors; no hints on native', async (t) => {
  const { buildCreateOptions, fromBase64Url } = await load()
  const userId = fill(32, 0xab)
  const ids = ['AQID', b64url(fill(16, 0x42))]
  const native = buildCreateOptions({ rpId: 'varanda.example', userId, challenge: fill(32, 7), excludeCredentialIds: ids })
  const web = passkey.createOptions({ rpId: 'varanda.example', userId, excludeCredentialIds: ids })
  t.is(native.excludeCredentials.length, web.excludeCredentials.length)
  native.excludeCredentials.forEach((d, i) => {
    t.is(d.type, web.excludeCredentials[i].type)
    t.alike(fromBase64Url(d.id), new Uint8Array(web.excludeCredentials[i].id))
  })
  t.alike(buildCreateOptions({ rpId: 'varanda.example', userId, challenge: fill(32, 7) }).excludeCredentials, [], 'empty by default')
  t.exception.all(() => buildCreateOptions({ rpId: 'varanda.example', userId, challenge: fill(32, 7), excludeCredentialIds: ['a+b/'] }))
  t.exception.all(() => buildCreateOptions({ rpId: 'varanda.example', userId, challenge: fill(32, 7), excludeCredentialIds: 'AQID' }))
  t.absent('hints' in JSON.parse(JSON.stringify(native)), 'no hints key')
  t.ok('hints' in web, 'the web has hints')
})

// rpIdHash (32) + flags (1) + signCount (4).
function authData (flags) {
  const out = new Uint8Array(37)
  out.fill(0x11, 0, 32)
  out[32] = flags
  return out
}

function noneAttestation (data) {
  const text = (s) => [0x60 + s.length, ...Buffer.from(s, 'utf8')]
  return new Uint8Array([0xa3, ...text('fmt'), ...text('none'), ...text('attStmt'), 0xa0, ...text('authData'), 0x58, data.length, ...data])
}

const SYNC_FIXTURES = [
  ['0x1d', { authenticatorData: authData(0x1d) }, 'synced'],
  ['0x0d', { authenticatorData: authData(0x0d) }, 'synced'],
  ['0x45', { authenticatorData: authData(0x45) }, 'bound'],
  ['0x05', { authenticatorData: authData(0x05) }, 'bound'],
  ['36 bytes', { authenticatorData: new Uint8Array(36) }, 'unknown'],
  ['ArrayBuffer', { authenticatorData: authData(0x0d).buffer }, 'synced'],
  ['none attestation, BE set', { attestationObject: noneAttestation(authData(0x5d)) }, 'synced'],
  ['none attestation, BE clear', { attestationObject: noneAttestation(authData(0x45)) }, 'bound'],
  ['truncated attestation', { attestationObject: noneAttestation(authData(0x5d)).subarray(0, 20) }, 'unknown'],
  ['indefinite map', { attestationObject: new Uint8Array([0xbf, 0xff]) }, 'unknown'],
  ['nothing', {}, 'unknown']
]

test('both authenticator data parsers agree on one fixture table', async (t) => {
  const web = require('@varanda/web-member/lib/authenticator-data')
  const native = await import('../src/authenticatorData.js')
  for (const [name, input, expected] of SYNC_FIXTURES) {
    t.is(web.syncState(input), expected, 'web ' + name)
    t.is(native.syncState(input), expected, 'native ' + name)
  }
  const data = authData(0x5d)
  t.alike(native.authDataFromAttestationObject(noneAttestation(data)), web.authDataFromAttestationObject(noneAttestation(data)))
  t.alike(native.parseAuthData(data), web.parseAuthData(data))
})

test('syncStateOf reads create and get response JSON', async (t) => {
  const { syncStateOf } = await import('../src/authenticatorData.js')
  const { fromBase64Url } = await load()
  const create = JSON.stringify({ id: 'AQID', rawId: 'AQID', response: { attestationObject: b64url(noneAttestation(authData(0x45))) } })
  t.is(syncStateOf(create, fromBase64Url), 'bound', 'create JSON, attestationObject')
  const createSynced = { response: { attestationObject: b64url(noneAttestation(authData(0x5d))) } }
  t.is(syncStateOf(createSynced, fromBase64Url), 'synced')
  const get = { response: { authenticatorData: b64url(authData(0x1d)), attestationObject: b64url(noneAttestation(authData(0x45))) } }
  t.is(syncStateOf(get, fromBase64Url), 'synced', 'authenticatorData wins')
  t.is(syncStateOf({ response: { authenticatorData: b64url(authData(0x05)) } }, fromBase64Url), 'bound', 'get JSON')
  t.is(syncStateOf({ response: {} }, fromBase64Url), 'unknown', 'iOS without attestationObject')
  t.is(syncStateOf({ response: { authenticatorData: '%%' } }, fromBase64Url), 'unknown')
  t.is(syncStateOf('not json', fromBase64Url), 'unknown')
  t.is(syncStateOf(null, fromBase64Url), 'unknown')
  t.exception.all(() => syncStateOf({}, null))
})

test('prfOutputPresent', async (t) => {
  const { prfOutputPresent } = await load()
  t.ok(prfOutputPresent({ clientExtensionResults: { prf: { results: { first: b64url(fill(32, 1)) } } } }))
  t.ok(prfOutputPresent(JSON.stringify({ clientExtensionResults: { prf: { results: { first: '%%' } } } })), 'present but invalid still counts')
  t.absent(prfOutputPresent({ clientExtensionResults: { prf: { enabled: true } } }))
  t.absent(prfOutputPresent({ clientExtensionResults: { prf: { results: {} } } }))
  t.absent(prfOutputPresent({ clientExtensionResults: { prf: { results: null } } }))
  t.absent(prfOutputPresent({}))
  t.absent(prfOutputPresent('not json'))
  t.absent(prfOutputPresent(null))
})
