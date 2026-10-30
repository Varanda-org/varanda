// A browser session the app opens itself and whose https return only this app
// receives (Android Auth Tab, iOS ASWebAuthenticationSession with an https
// callback). The Google step of the account link uses it so the one-time
// redeem code never travels over the varanda:// scheme, which any app can
// claim or forge.
//
// isAvailable() never throws. open(url, host, path) resolves exactly one of
// { type: 'ok', url }, { type: 'cancel' } or
// { type: 'failed', reason: 'verification' | 'timeout' | 'unknown' }; it
// rejects with `.code` UNSUPPORTED, BUSY or INVALID. Native error text is
// never shown, and URLs (they carry the OAuth state and the code) are never
// logged.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('AuthSession')
} catch {}

const FAILED_REASONS = new Set(['verification', 'timeout', 'unknown'])

function fail (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

export function validArgs (url, host, path) {
  return typeof url === 'string' && url.startsWith('https://') && url.length > 8 &&
    typeof host === 'string' && host.length > 0 && !/[/:\s]/.test(host) &&
    typeof path === 'string' && path.startsWith('/') && !/[?#\s]/.test(path)
}

export function normalize (answer) {
  if (answer === null || typeof answer !== 'object') return { type: 'failed', reason: 'unknown' }
  if (answer.type === 'ok' && typeof answer.url === 'string' && answer.url.startsWith('https://')) {
    return { type: 'ok', url: answer.url }
  }
  if (answer.type === 'cancel') return { type: 'cancel' }
  if (answer.type === 'failed' && FAILED_REASONS.has(answer.reason)) {
    return { type: 'failed', reason: answer.reason }
  }
  return { type: 'failed', reason: 'unknown' }
}

export function isAvailable () {
  if (native === null) return false
  try {
    return native.isAvailable() === true
  } catch {
    return false
  }
}

export async function open (url, host, path) {
  if (!validArgs(url, host, path)) throw fail('INVALID', 'endereço inválido')
  if (!isAvailable()) throw fail('UNSUPPORTED', 'este aparelho não pode abrir o login aqui')
  let answer
  try {
    answer = await native.open(url, host, path)
  } catch (err) {
    const code = err && (err.code === 'BUSY' || err.code === 'INVALID') ? err.code : 'UNSUPPORTED'
    throw fail(code, code === 'BUSY' ? 'o login já está aberto' : code === 'INVALID' ? 'endereço inválido' : 'este aparelho não pode abrir o login aqui')
  }
  return normalize(answer)
}
