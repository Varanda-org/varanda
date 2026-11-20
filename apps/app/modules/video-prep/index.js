// Re-encodes one short video picked for a post or a momento, on the
// platform's own frameworks (iOS AVFoundation, Android Media3 / MediaCodec):
// H.264 and AAC in a plain MP4, long side at most maxSide, about maxBitrate,
// with no metadata, plus a JPEG poster of its first frame. Both files land in
// the app cache; the caller reads and deletes them.
//
// isAvailable() never throws. prepare(uri, { maxMs, maxBytes, maxSide,
// maxBitrate }) resolves { uri, posterUri, width, height, ms, bytes } and
// rejects with `.code` TOO_LONG (the source is longer than maxMs, refused
// before any encoding: nothing is trimmed), UNSUPPORTED, BUSY (one
// preparation at a time), INVALID or FAILED. Native error text is never
// shown, and paths are never logged.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('VideoPrep')
} catch {}

export const MAX_SIDE = 960
export const MAX_BITRATE = 1400000

const NATIVE_CODES = new Set(['TOO_LONG', 'BUSY', 'INVALID', 'UNSUPPORTED'])
const MESSAGES = {
  TOO_LONG: 'o vídeo é mais longo do que o permitido',
  UNSUPPORTED: 'este aparelho não pode preparar o vídeo aqui',
  BUSY: 'outro vídeo já está sendo preparado',
  INVALID: 'vídeo inválido',
  FAILED: 'não foi possível preparar o vídeo'
}

function fail (code) {
  const err = new Error(MESSAGES[code])
  err.code = code
  return err
}

const positiveInt = (n) => Number.isSafeInteger(n) && n > 0

export function validArgs (uri, opts) {
  if (typeof uri !== 'string' || !/^(file|content):\/\/./.test(uri)) return false
  if (opts === null || typeof opts !== 'object') return false
  return positiveInt(opts.maxMs) && positiveInt(opts.maxBytes) &&
    positiveInt(opts.maxSide) && positiveInt(opts.maxBitrate)
}

const fileUri = (u) => typeof u === 'string' && u.startsWith('file://') && u.length > 7

// -> the contract shape, or null when the native answer is malformed. The
// caps are not checked here: native deletes an output over them itself, and
// the caller checks the bytes it reads (and then deletes both files), so a
// refusal here would only orphan the files in the cache.
export function normalize (answer) {
  if (answer === null || typeof answer !== 'object') return null
  const { uri, posterUri, width, height, ms, bytes } = answer
  if (!fileUri(uri) || !fileUri(posterUri) || uri === posterUri) return null
  if (![width, height, ms, bytes].every(positiveInt)) return null
  return { uri, posterUri, width, height, ms, bytes }
}

export function isAvailable () {
  if (native === null) return false
  try {
    return native.isAvailable() === true
  } catch {
    return false
  }
}

export async function prepare (uri, options = {}) {
  const opts = { maxSide: MAX_SIDE, maxBitrate: MAX_BITRATE, ...options }
  if (!validArgs(uri, opts)) throw fail('INVALID')
  if (!isAvailable()) throw fail('UNSUPPORTED')
  let answer
  try {
    answer = await native.prepare(uri, {
      maxMs: opts.maxMs,
      maxBytes: opts.maxBytes,
      maxSide: opts.maxSide,
      maxBitrate: opts.maxBitrate
    })
  } catch (err) {
    throw fail(err && NATIVE_CODES.has(err.code) ? err.code : 'FAILED')
  }
  const result = normalize(answer)
  if (result === null) throw fail('FAILED')
  return result
}
