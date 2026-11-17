// Which still format to try, at what size and quality, and whether the
// encoded bytes are acceptable. Kept pure so the encoders and the tests share
// it without a browser, React or Node built-ins.

import { checkFile, fitWithin, MAX_IMAGE_SIDE } from './plan.js'

export const WEBP_QUALITY = 0.85
export const JPEG_QUALITY = 0.85
export const AVIF_QUALITY = 0.8
// The system encoder fails at 0.99 and above.
export const AVIF_MAX_QUALITY = 0.98
export const AVIF_BUDGET_MS = 8000

const STILL_MIMES = ['image/avif', 'image/webp', 'image/jpeg', 'image/png']

// One AVIF encode that blows the budget is enough: later photos skip it.
let avifSkip = false

export function noteAvifTimeout () {
  avifSkip = true
}

export function avifSkipped () {
  return avifSkip
}

export function resetAvifSkip () {
  avifSkip = false
}

export function stillAttempts ({ avif, webp, alpha, force }) {
  // Anything but a video poster, which has to be JPEG, is not a force.
  if (force !== undefined && force !== 'jpeg') throw new TypeError('Expected force to be jpeg')
  if (force === 'jpeg') return ['jpeg']
  const attempts = []
  // JPEG turns transparent pixels black, and the AVIF profile refuses alpha.
  if (alpha === true) {
    if (webp) attempts.push('webp')
    attempts.push('png')
    return attempts
  }
  if (avif && !avifSkip) attempts.push('avif')
  if (webp) attempts.push('webp')
  attempts.push('jpeg')
  return attempts
}

// An odd AVIF size makes the system encoder write a crop box the profile refuses.
function evenSide (side) {
  const even = side - (side % 2)
  return even >= 2 ? even : 2
}

export function targetSize (width, height, format) {
  const fitted = fitWithin(width, height, MAX_IMAGE_SIDE)
  if (format !== 'avif') return fitted
  return { width: evenSide(fitted.width), height: evenSide(fitted.height) }
}

export function avifQuality (q) {
  if (!Number.isFinite(q)) return AVIF_QUALITY
  return Math.min(AVIF_MAX_QUALITY, Math.max(0.1, q))
}

export function mimeOf (format) {
  if (format === 'avif') return 'image/avif'
  if (format === 'webp') return 'image/webp'
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'png') return 'image/png'
  throw new TypeError('Expected a still format')
}

export function accept (bytes, mime, mediaBounds) {
  // checkFile allows a GIF, but a re-encode never writes one.
  if (!STILL_MIMES.includes(mime)) return null
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) return null
  const parsed = mediaBounds(bytes, mime)
  if (!parsed || parsed.frames !== 1) return null
  const { width, height } = parsed
  if (checkFile({ mime, bytes: bytes.byteLength, width, height })) return null
  return { width, height }
}

// The deadline can win while the encode is still writing its file.
export function withBudget (promise, ms, onLate) {
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(null)
    }, ms)
    promise.then(
      value => {
        if (done) {
          onLate(value)
          return
        }
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}
