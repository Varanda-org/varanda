// Encodes one photo to AVIF with the iOS system encoder (ImageIO): long side
// at most maxSide (16 to 4096), even sides of at least 16, opaque, with no
// metadata. Native clamps quality to 0.1..0.98, since ImageIO wrote nothing
// at 1.0 and turns a photo into blocks under 0.1. The file lands in the app
// cache; the caller reads and deletes it.
//
// canEncodeAvif() resolves true only when the device both lists the AVIF
// encoder and passed a trial encode. encodeAvif(uri, { maxSide, quality })
// resolves { uri, width, height } or null, and never rejects. Android and web
// have no such module, so there both resolve false and null. Native error
// text is never shown, and paths are never logged.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir).

import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('ImagePrep')
} catch {}

const MAX_URI = 4096
const MIN_SIDE = 16
// 512 px grid tiles: the receiving parser allows 64 of them and
// MAX_MEDIA_PIXELS, which 4096 x 4096 meets exactly.
const MAX_SIDE = 4096

const fileUri = (u) => typeof u === 'string' && u.startsWith('file://') && u.length > 7

export function validArgs (uri, opts) {
  if (!fileUri(uri) || uri.length >= MAX_URI) return false
  if (opts === null || typeof opts !== 'object') return false
  const { maxSide, quality } = opts
  if (!Number.isInteger(maxSide) || maxSide < MIN_SIDE || maxSide > MAX_SIDE) return false
  return typeof quality === 'number' && quality > 0 && quality <= 1
}

const evenSide = (n, maxSide) => Number.isInteger(n) && n >= MIN_SIDE && n % 2 === 0 && n <= maxSide

// -> the contract shape, or null when the native answer is malformed. The
// source uri is refused so the caller never deletes the picked original. A
// refused answer may leave its file in the cache, which native clears after
// ten minutes.
export function normalize (answer, maxSide, source) {
  if (answer === null || typeof answer !== 'object') return null
  const { uri, width, height } = answer
  if (!fileUri(uri) || !uri.endsWith('.avif') || uri === source) return null
  if (!evenSide(width, maxSide) || !evenSide(height, maxSide)) return null
  return { uri, width, height }
}

export async function canEncodeAvif () {
  if (native === null) return false
  try {
    return (await native.canEncodeAvif()) === true
  } catch {
    return false
  }
}

export async function encodeAvif (uri, opts) {
  if (!validArgs(uri, opts)) return null
  if (!(await canEncodeAvif())) return null
  try {
    return normalize(await native.encodeAvif(uri, opts.maxSide, opts.quality), opts.maxSide, uri)
  } catch {
    return null
  }
}
