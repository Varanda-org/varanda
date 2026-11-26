// A photo or a short video from the phone's own camera app, on Android only.
// The camera permission stays removed from the Android manifest (CI fails an
// APK that carries it), and expo-image-picker's camera always asks for it
// there. An app that does not declare it may start the system IMAGE_CAPTURE /
// VIDEO_CAPTURE intent with no permission at all, which is what this module
// does: no viewfinder of ours, nothing written to the gallery. iOS uses
// expo-image-picker's camera instead.
//
// isAvailable() is true when the native module loaded and never throws.
// canCapture() resolves { photo, video }. capture(kind, { maxMs }) resolves
// { uri, kind, mimeType, width, height } for a photo, { uri, kind, mimeType }
// for a video, or null when the person cancels, and rejects with `.code`
// UNAVAILABLE, BUSY or FAILED. The file lives in the app cache; the caller
// reads and deletes it. Native error text is never shown, and paths are never
// logged.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('CameraCapture')
} catch {}

const NATIVE_CODES = new Set(['UNAVAILABLE', 'BUSY'])
const MESSAGES = {
  UNAVAILABLE: 'nenhum app de câmera foi encontrado',
  BUSY: 'a câmera já está aberta',
  FAILED: 'não foi possível usar a câmera'
}
const KINDS = {
  photo: { ext: 'jpg', mimeType: 'image/jpeg' },
  video: { ext: 'mp4', mimeType: 'video/mp4' }
}
const NAME = /^[0-9a-f]{32}\.(jpg|mp4)$/

function fail (code) {
  const err = new Error(MESSAGES[code])
  err.code = code
  return err
}

const positiveInt = (n) => Number.isSafeInteger(n) && n > 0

// Only the file native created: <...>/cache/CameraCapture/<32 hex>.<ext>,
// an absolute file:// path with no relative or encoded segment.
export function validUri (uri, kind) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///')) return false
  const path = uri.slice('file://'.length)
  if (/[?#%\\\s]/.test(path)) return false
  const segments = path.split('/').slice(1)
  if (segments.length < 3) return false
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false
  const name = segments[segments.length - 1]
  const match = NAME.exec(name)
  return match !== null && match[1] === KINDS[kind].ext &&
    segments[segments.length - 2] === 'CameraCapture' &&
    segments[segments.length - 3] === 'cache'
}

// -> the contract shape, or null when the native answer is malformed.
export function normalize (answer, kind) {
  if (answer === null || typeof answer !== 'object') return null
  const { uri, mimeType, width, height } = answer
  if (answer.kind !== kind || mimeType !== KINDS[kind].mimeType || !validUri(uri, kind)) return null
  if (kind === 'video') return { uri, kind, mimeType }
  if (!positiveInt(width) || !positiveInt(height)) return null
  return { uri, kind, mimeType, width, height }
}

export function isAvailable () {
  return native !== null
}

async function nativeAvailable (kind) {
  try {
    return (await native.isAvailable(kind)) === true
  } catch {
    return false
  }
}

export async function canCapture () {
  if (native === null) return { photo: false, video: false }
  const [photo, video] = await Promise.all([nativeAvailable('photo'), nativeAvailable('video')])
  return { photo, video }
}

export async function capture (kind, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw fail('FAILED')
  const maxMs = options === null || typeof options !== 'object' ? undefined : options.maxMs
  if (maxMs !== undefined && !positiveInt(maxMs)) throw fail('FAILED')
  if (native === null) throw fail('UNAVAILABLE')
  let answer
  try {
    answer = await native.capture(kind, kind === 'video' && maxMs !== undefined ? maxMs : null)
  } catch (err) {
    throw fail(err && NATIVE_CODES.has(err.code) ? err.code : 'FAILED')
  }
  if (answer === null) return null
  const result = normalize(answer, kind)
  if (result === null) throw fail('FAILED')
  return result
}
