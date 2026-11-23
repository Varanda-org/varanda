// Native: turns a picked asset ({ uri, mimeType, width, height }) into the
// bytes that are uploaded, like encode.web.js.
// - A GIF passes through UNCHANGED (the animation is kept), at most
//   MAX_GIF_BYTES; its size comes from the header (gif.js).
// - Other photos are re-encoded in the order stillPlan.js gives: AVIF when
//   the device's system encoder passed its probe (modules/image-prep, loaded
//   only when a photo needs it; a probe or encode past AVIF_BUDGET_MS turns
//   AVIF off for later photos), then WebP, then JPEG; a source that can be
//   transparent tries WebP, then PNG. AVIF is written straight from the
//   source; the others go through expo-image-manipulator, resized to
//   fitWithin(w, h, MAX_IMAGE_SIDE). Decoding and re-encoding the pixels
//   STRIPS all metadata: EXIF, GPS position, camera data. Every output is
//   parsed as a peer would parse it (stillPlan accept), the first one that
//   passes wins with the size its header declares, and each temporary file
//   is deleted at once, kept or not. encodeFile(asset, { format: 'jpeg' })
//   writes JPEG only (a video poster).
// - options.cropFor({ width, height }) -> null or { sx, sy, sw, sh } crops a
//   still before the resize (a GIF passes through uncropped); with
//   options.whole === true a cropped photo also returns whole, the uncropped
//   photo at WHOLE_SIDE, best effort. encodeBytes does the same from bytes.
// Sources over 50 MiB are refused before decoding (memory).
// -> { bytes: Uint8Array, mime, width, height }; throws an Error with a
// message for the person.

import rpc from '@varanda/rpc'
import { File } from 'expo-file-system'
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator'
import { revokeUrl, urlFromBytes } from './display'
import { orientedSize } from './exif.js'
import { gifProblem, gifSize } from './gif.js'
import { acceptedSource, canHaveAlpha, gifOverCap } from './source.js'
import { MAX_GIF_BYTES, MAX_IMAGE_SIDE, MAX_MEDIA_DIMENSION, checkFile, fitWithin } from './plan.js'
import { AVIF_BUDGET_MS, JPEG_QUALITY, WEBP_QUALITY, accept, avifQuality, mimeOf, noteAvifTimeout, stillAttempts, withBudget } from './stillPlan.js'

const MAX_SOURCE_BYTES = 50 * 1024 * 1024
const PREPARE_FAILED = 'não foi possível preparar a foto'
const WHOLE_SIDE = 1280
const WHOLE_QUALITY = 0.8
const SAVE_FORMATS = {
  webp: { format: SaveFormat.WEBP, compress: WEBP_QUALITY },
  jpeg: { format: SaveFormat.JPEG, compress: JPEG_QUALITY },
  png: { format: SaveFormat.PNG }
}

function fail (message) {
  return new Error(message)
}

function discard (file) {
  try { if (file.exists) file.delete() } catch {}
}

function discardUri (uri) {
  if (typeof uri !== 'string') return
  try { discard(new File(uri)) } catch {}
}

async function encodeGif (source, bytes) {
  if (bytes.byteLength > MAX_GIF_BYTES) throw fail('arquivo grande demais')
  const size = gifSize(bytes)
  if (!size) throw fail('formato não aceito')
  const problem = checkFile({ mime: 'image/gif', bytes: bytes.byteLength, ...size })
  if (problem) throw fail(problem)
  const refused = gifProblem(bytes)
  if (refused) throw fail(refused)
  return { bytes, mime: 'image/gif', ...size }
}

// -> null (no crop) or { sx, sy, sw, sh } inside a w x h source. A rect equal
// to the whole image counts as no crop.
function cropOf (cropFor, w, h) {
  if (typeof cropFor !== 'function') return null
  const rect = cropFor({ width: w, height: h })
  if (rect === null || rect === undefined) return null
  const { sx, sy, sw, sh } = rect
  if (![sx, sy, sw, sh].every(Number.isInteger) || sw < 1 || sh < 1 || sx < 0 || sy < 0 || sx + sw > w || sy + sh > h) {
    throw new TypeError('Expected a crop inside the image')
  }
  if (sx === 0 && sy === 0 && sw === w && sh === h) return null
  return { sx, sy, sw, sh }
}

async function encodePhoto (asset, force, options) {
  const w = asset.width
  const h = asset.height
  if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1)) throw fail('não foi possível abrir a foto')
  if (w > MAX_MEDIA_DIMENSION || h > MAX_MEDIA_DIMENSION) throw fail('foto grande demais')
  const crop = cropOf(options && options.cropFor, w, h)
  const cw = crop ? crop.sw : w
  const ch = crop ? crop.sh : h
  const fit = fitWithin(cw, ch, MAX_IMAGE_SIDE)
  const actions = fit.width === cw && fit.height === ch ? [] : [{ resize: { width: fit.width, height: fit.height } }]
  if (crop) actions.unshift({ crop: { originX: crop.sx, originY: crop.sy, width: crop.sw, height: crop.sh } })
  const mime = typeof asset.mimeType === 'string' ? asset.mimeType.toLowerCase() : ''
  // PNG, WebP and AVIF can be transparent and the manipulator cannot fill a
  // white background here, so they never become JPEG (transparent pixels
  // would turn black), nor AVIF, whose profile refuses alpha.
  const alpha = canHaveAlpha(asset.mimeType) || mime === 'image/avif'
  // The probe loads the native module, so it runs only when AVIF could be tried.
  const prep = stillAttempts({ avif: true, webp: true, alpha, force }).includes('avif') ? await avifEncoder() : null
  let problem = PREPARE_FAILED
  for (const format of stillAttempts({ avif: prep !== null, webp: true, alpha, force })) {
    const out = format === 'avif'
      ? (crop ? await saveAvifCropped(prep, asset.uri, actions) : await saveAvif(prep, asset.uri))
      : await save(asset.uri, actions, format)
    if (out.value) {
      if (crop && options.whole === true) {
        const whole = await saveWhole(asset.uri, w, h, alpha)
        if (whole) out.value.whole = whole
      }
      return out.value
    }
    problem = out.problem
  }
  throw fail(problem)
}

// The system encoder reads its source file and cannot crop, so a cropped
// photo goes through a full-quality JPEG intermediate (alpha sources never
// try AVIF, so JPEG loses nothing here), deleted afterwards.
async function saveAvifCropped (prep, uri, actions) {
  let mid
  try {
    mid = await manipulateAsync(uri, actions, { compress: 1, format: SaveFormat.JPEG })
    if (!mid || typeof mid.uri !== 'string' || mid.uri === uri) return { problem: PREPARE_FAILED }
  } catch {
    return { problem: PREPARE_FAILED }
  }
  try {
    return await saveAvif(prep, mid.uri)
  } finally {
    discardUri(mid.uri)
  }
}

// The uncropped photo, smaller, or null; a failure never fails the encode.
async function saveWhole (uri, w, h, alpha) {
  const fit = fitWithin(w, h, WHOLE_SIDE)
  const actions = fit.width === w && fit.height === h ? [] : [{ resize: { width: fit.width, height: fit.height } }]
  const mime = alpha ? 'image/png' : 'image/jpeg'
  let file
  try {
    const result = await manipulateAsync(uri, actions, alpha ? { format: SaveFormat.PNG } : { compress: WHOLE_QUALITY, format: SaveFormat.JPEG })
    if (result.uri === uri) return null
    file = new File(result.uri)
    const bytes = await file.bytes()
    const size = accept(bytes, mime, rpc.mediaBounds)
    return size ? { bytes, mime, width: size.width, height: size.height } : null
  } catch {
    return null
  } finally {
    if (file) discard(file)
  }
}

// -> { value, timedOut }. The system encoder runs on one serial queue, so a
// stalled probe or encode would hang the photo without a deadline. value is
// null when the call failed or ran past the budget; a late value goes to onLate.
async function budgeted (call, onLate) {
  let pending = true
  // A synchronous throw from native code becomes a rejection here.
  const settled = (async () => call())().finally(() => { pending = false })
  const value = await withBudget(settled, AVIF_BUDGET_MS, onLate)
  return { value, timedOut: value === null && pending }
}

// -> the image-prep module when this device encodes AVIF, else null.
async function avifEncoder () {
  const probe = await budgeted(async () => {
    const prep = await import('../../modules/image-prep')
    return (await prep.canEncodeAvif()) === true ? prep : null
  }, () => {})
  if (probe.timedOut) noteAvifTimeout()
  return probe.value || null
}

// -> { value } or { problem }. The system encoder reads the source itself, so
// there is no manipulator intermediate to delete.
async function saveAvif (prep, uri) {
  const { value: out, timedOut } = await budgeted(() => prep.encodeAvif(uri, { maxSide: MAX_IMAGE_SIDE, quality: avifQuality() }), (late) => {
    if (late && late.uri !== uri) discardUri(late.uri)
  })
  if (timedOut) noteAvifTimeout()
  // Never the picked original, which is not ours to delete.
  if (!out || typeof out.uri !== 'string' || out.uri === uri) return { problem: PREPARE_FAILED }
  let file
  try {
    file = new File(out.uri)
  } catch {
    return { problem: PREPARE_FAILED }
  }
  try {
    const bytes = await file.bytes()
    const size = accept(bytes, 'image/avif', rpc.mediaBounds)
    if (size) return { value: { bytes, mime: 'image/avif', width: size.width, height: size.height } }
    return { problem: PREPARE_FAILED }
  } catch {
    return { problem: PREPARE_FAILED }
  } finally {
    discard(file)
  }
}

// -> { value } or { problem }: checkFile's message when the output breaks a
// limit, so the person reads why.
async function save (uri, actions, format) {
  const mime = mimeOf(format)
  let result
  let file
  try {
    result = await manipulateAsync(uri, actions, SAVE_FORMATS[format])
    file = new File(result.uri)
  } catch {
    return { problem: PREPARE_FAILED }
  }
  try {
    const bytes = await file.bytes()
    const size = accept(bytes, mime, rpc.mediaBounds)
    if (size) return { value: { bytes, mime, width: size.width, height: size.height } }
    return { problem: checkFile({ mime, bytes: bytes.byteLength, width: result.width, height: result.height }) || PREPARE_FAILED }
  } catch {
    return { problem: PREPARE_FAILED }
  } finally {
    discard(file)
  }
}

// options.format 'jpeg' forces JPEG: a video poster must be image/jpeg.
export async function encodeFile (asset, options) {
  const force = options ? options.format : undefined
  if (force !== undefined && force !== 'jpeg') throw new TypeError('Expected format to be jpeg')
  if (!asset || typeof asset.uri !== 'string' || !acceptedSource(asset.mimeType)) throw fail('formato não aceito')
  let file
  let size
  try {
    file = new File(asset.uri)
    size = file.size
  } catch {
    throw fail('não foi possível abrir a foto')
  }
  if (!(size >= 1)) throw fail('não foi possível abrir a foto')
  if (size > MAX_SOURCE_BYTES) throw fail('arquivo grande demais')
  const mime = typeof asset.mimeType === 'string' ? asset.mimeType.toLowerCase() : ''
  // A GIF is told by its signature too: a picker may report a wrong type. A
  // forced JPEG never passes a GIF through, so it skips the sniff.
  if (force === undefined && mime === 'image/gif' && gifOverCap(size, MAX_GIF_BYTES)) throw fail('arquivo grande demais')
  if (force === undefined && (mime === 'image/gif' || size <= MAX_GIF_BYTES)) {
    let bytes
    try {
      bytes = await file.bytes()
    } catch {
      throw fail('não foi possível abrir a foto')
    }
    if (gifSize(bytes)) return encodeGif(asset, bytes)
    if (mime === 'image/gif') throw fail('formato não aceito')
  }
  return encodePhoto(asset, force, options)
}

// An already encoded photo ({ bytes, mime, width, height }) through the same
// path as encodeFile, from a temporary cache file deleted afterwards.
export async function encodeBytes (still, options) {
  if (!still || !(still.bytes instanceof Uint8Array)) throw fail('formato não aceito')
  let uri
  try {
    uri = urlFromBytes(still.bytes, still.mime)
  } catch {
    throw fail('não foi possível abrir a foto')
  }
  try {
    return await encodeFile({ uri, mimeType: still.mime, width: still.width, height: still.height }, options)
  } finally {
    revokeUrl(uri)
  }
}

// A link card's thumbnail (../linkCard.js): the page image re-encoded as a
// JPEG at most `side` px on the long side and `maxBytes` bytes, with a lower
// quality, then a smaller size, until it fits. -> { bytes, mime, width,
// height } or null when it never fits; the temporary files are deleted.
const THUMB_QUALITIES = [0.7, 0.5, 0.35]
const THUMB_SCALES = [1, 0.75, 0.5]

export async function encodeThumbnail (bytes, mime, { side = 320, maxBytes = 32752 } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null
  // The page chose the image: its header must declare a size within the
  // photo bounds before anything decodes it (a decompression bomb), and that
  // size is what the first resize starts from (no full-size probe decode).
  const bounds = rpc.mediaBounds(bytes, mime)
  if (bounds === null || !(bounds.width >= 1 && bounds.height >= 1)) return null
  // The decoder turns a JPEG by its EXIF orientation before resizing, so a
  // resize to the stored sides would squash a photo taken sideways.
  const size = orientedSize(bytes, mime, bounds)
  let uri
  try {
    uri = urlFromBytes(bytes, mime)
  } catch {
    return null
  }
  try {
    for (const scale of THUMB_SCALES) {
      const fit = fitWithin(size.width, size.height, Math.max(1, Math.round(side * scale)))
      for (const q of THUMB_QUALITIES) {
        const out = await manipulateAsync(uri, [{ resize: { width: fit.width, height: fit.height } }], { compress: q, format: SaveFormat.JPEG })
        const file = new File(out.uri)
        try {
          const b = await file.bytes()
          if (b.byteLength <= maxBytes && out.width <= side && out.height <= side) {
            return { bytes: b, mime: 'image/jpeg', width: out.width, height: out.height }
          }
        } finally {
          discard(file)
        }
      }
    }
    return null
  } catch {
    return null
  } finally {
    revokeUrl(uri)
  }
}
