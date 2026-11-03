// The native AWS Face Liveness capture (Android com.amplifyframework.ui:liveness,
// iOS amplify-ui-swift-liveness), the official SDKs only. The caller obtains
// guest credentials with src/livenessCredentials.js and hands them here
// in-process; they are never stored, logged or passed through an Intent.
//
// isAvailable() never throws. start({ sessionId, region, credentials })
// resolves { ok: true } once the capture is done and rejects with `.code`
// set to one of CODES. Errors carry a generic message only: no credential,
// session id or native text ever appears in them.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'
import { SESSION_ID_RE, STREAMING_REGIONS } from '../../src/livenessCredentials.js'

let native = null
try {
  native = requireNativeModule('FaceLiveness')
} catch {}

export const CODES = Object.freeze([
  'INVALID',
  'CANCELLED',
  'CAMERA_DENIED',
  'SESSION_EXPIRED',
  'UNSUPPORTED',
  'BUSY',
  'FAILED'
])

const MESSAGES = {
  INVALID: 'Os dados da verificação estão incompletos. Tente de novo.',
  CANCELLED: 'A verificação foi cancelada.',
  CAMERA_DENIED: 'Permita o uso da câmera para fazer a verificação.',
  SESSION_EXPIRED: 'A verificação expirou. Tente de novo.',
  UNSUPPORTED: 'Este aparelho não pode fazer a verificação aqui.',
  BUSY: 'A verificação já está aberta.',
  FAILED: 'Não foi possível concluir a verificação. Tente de novo.'
}

function fail (code) {
  const err = new Error(MESSAGES[code])
  err.code = code
  return err
}

function nonEmpty (v) {
  return typeof v === 'string' && v.length > 0
}

function validInput (input) {
  if (!input || typeof input !== 'object') return false
  const { sessionId, region, credentials } = input
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false
  if (typeof region !== 'string' || !STREAMING_REGIONS.includes(region)) return false
  if (!credentials || typeof credentials !== 'object') return false
  const { accessKeyId, secretAccessKey, sessionToken, expiration } = credentials
  if (!nonEmpty(accessKeyId) || !nonEmpty(secretAccessKey) || !nonEmpty(sessionToken)) return false
  return expiration instanceof Date && Number.isFinite(expiration.getTime())
}

export function isAvailable () {
  if (native === null) return false
  try {
    return native.isAvailable() === true
  } catch {
    return false
  }
}

// Closes an open capture screen, whose pending start() then rejects
// CANCELLED. The screen outlives the React screen that opened it, so the
// caller closes it on unmount; nothing here may throw from a cleanup.
export function cancel () {
  if (native === null) return
  try {
    native.cancel()
  } catch {}
}

export async function start (input) {
  if (!validInput(input)) throw fail('INVALID')
  if (!isAvailable()) throw fail('UNSUPPORTED')
  const { sessionId, region, credentials } = input
  try {
    await native.start({
      sessionId,
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        expiration: credentials.expiration.getTime()
      }
    })
  } catch (err) {
    const code = err && CODES.includes(err.code) ? err.code : 'FAILED'
    throw fail(code)
  }
  return { ok: true }
}
