// The native passkey ceremonies of the app (Android Credential Manager, iOS
// AuthenticationServices), each taking and answering WebAuthn JSON with
// base64url fields: create(requestJson) and get(requestJson) resolve the
// registration or authentication response JSON, including
// clientExtensionResults.prf. Errors carry a `.code`: CANCELLED, EXISTS,
// UNSUPPORTED, NO_PRF or WEBAUTHN; their native text is never shown.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir); src/identity.native.js is its only caller.

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('PasskeyPrf')
} catch {}

function unsupported () {
  const err = new Error('este endereço não pode usar passkeys')
  err.code = 'UNSUPPORTED'
  return err
}

export function isAvailable () {
  if (native === null) return false
  try {
    return native.isAvailable() === true
  } catch {
    return false
  }
}

export async function create (requestJson) {
  if (native === null) throw unsupported()
  return native.create(requestJson)
}

export async function get (requestJson) {
  if (native === null) throw unsupported()
  return native.get(requestJson)
}
