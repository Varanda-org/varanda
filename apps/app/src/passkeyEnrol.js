// The passkey enrolment of Excluir conta, the pure part (no React, no
// react-native, no Node built-ins): right after the account is linked, the
// app sends the attestation object of the passkey that created the identity
// to the account service, which keeps its public key and from then on
// verifies a fresh assertion before a deletion
// (apps/cli/lib/account/passkey-routes.js, docs/protocol.md "Account
// deletion"). The record comes from the browser node's kv (handle
// identity.enrolment()) or, on the native app, from
// src/passkeyEnrolStore.native.js through src/identity.native.js.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { fromBase64Url, toHex } from './passkeyOptions.js'

const KEY_RE = /^[0-9a-f]{64}$/
const ID_RE = /^[A-Za-z0-9_-]{1,1364}$/
const ATTESTATION_RE = /^[A-Za-z0-9_-]{1,2731}$/

// The stored record { v: 1, rpId, credentialId, attestationObject,
// publicKey } (publicKey null while a creation waits for its PRF output),
// or null for anything else.
export function enrolRecordOf (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.keys(value).length !== 5 || value.v !== 1) return null
  if (typeof value.rpId !== 'string' || value.rpId === '' || value.rpId.length > 253) return null
  if (typeof value.credentialId !== 'string' || !ID_RE.test(value.credentialId)) return null
  if (typeof value.attestationObject !== 'string' || !ATTESTATION_RE.test(value.attestationObject)) return null
  if (value.publicKey !== null && (typeof value.publicKey !== 'string' || !KEY_RE.test(value.publicKey))) return null
  return { v: 1, rpId: value.rpId, credentialId: value.credentialId, attestationObject: value.attestationObject, publicKey: value.publicKey }
}

// The hex SHA-256 of the attestation object's bytes: the `sub` of the
// account-link statement at phase 'passkey'.
export function attestationHash (attestationObject) {
  return toHex(nobleSha256(fromBase64Url(attestationObject)))
}

// Refusals after which sending again can never help: the key is dropped.
const FINAL = new Set(['passkey-registrada', 'vinculo-antigo', 'passkey-invalida', 'conta-excluida'])

// One enrolment attempt, every effect injected:
//   enrolment              { credentialId, attestationObject } or null
//   start({ member })      -> { nonce }        POST /account/passkey/start
//   sign({ nonce, username, sub }) -> { signature }   account.sign 'passkey'
//   add({ member, nonce, signature, credentialId, attestationObject })
//   drop()                 forget the local record
// -> 'stored' (the service holds it, now or already), 'refused' (for good:
// dropped too) or 'later' (offline, a 5xx, a rename meanwhile: tried again
// at the next start, until the service answers 'vinculo-antigo').
export async function runEnrolment ({ member, username, enrolment, start, sign, add, drop }) {
  if (enrolment === null || enrolment === undefined) return 'stored'
  if (typeof member !== 'string' || !KEY_RE.test(member) || typeof username !== 'string' || username === '') return 'later'
  try {
    const { nonce } = await start({ member })
    const sub = attestationHash(enrolment.attestationObject)
    const { signature } = await sign({ nonce, username, sub })
    await add({ member, nonce, signature, credentialId: enrolment.credentialId, attestationObject: enrolment.attestationObject })
  } catch (err) {
    if (err && FINAL.has(err.code)) {
      try { await drop() } catch {}
      return 'refused'
    }
    return 'later'
  }
  try { await drop() } catch {}
  return 'stored'
}

// runEnrolment with the node's passkey handle (node.passkey: enrolment(),
// dropEnrolment()) and account.sign at phase 'passkey'. start and add are
// the account service calls (src/account.js passkeyStart, passkeyAdd).
export async function enrolWith ({ passkey, request, member, username, start, add }) {
  if (!passkey || typeof passkey.enrolment !== 'function') return 'stored'
  let enrolment = null
  try {
    enrolment = await passkey.enrolment()
  } catch {
    return 'later'
  }
  return runEnrolment({
    member,
    username,
    enrolment,
    start,
    sign: ({ nonce, username: name, sub }) => request('account.sign', { phase: 'passkey', nonce, username: name, sub }),
    add,
    drop: () => passkey.dropEnrolment()
  })
}
