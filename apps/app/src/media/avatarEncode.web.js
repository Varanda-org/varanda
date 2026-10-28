/* global createImageBitmap, document, Image, URL */

// Web: opens a chosen file for the avatar editor and encodes the cropped
// square. Separate from encode.web.js on purpose: posts keep their GIF
// passthrough, while an avatar is always a still image.
// - The file is decoded once (createImageBitmap with the orientation applied,
//   then without the option, then an <img>) and FROZEN at once onto a source
//   canvas at fitWithin(w, h, MAX_IMAGE_SIDE), on white. The bitmap, the
//   <img> and its object URL are released right after: an <img> is a live
//   source, so drawing it later could pick another frame of an animated GIF
//   or WebP. The frozen canvas is the only source for the preview and the
//   export, so an animation contributes exactly one frame.
// - encode({ sx, sy, size }, maxBytes) draws that square at 512x512 and
//   re-encodes it (image/webp when the browser really produces it, else
//   image/jpeg), which strips all metadata (EXIF, GPS position, camera data).
// -> openImage(file) resolves { uri, width, height, encode, release }; every
// failure is an Error with a message for the person.

import { MAX_IMAGE_SIDE, MAX_MEDIA_DIMENSION, MEDIA_MIMES, fitWithin } from './plan.js'

const OUTPUT_SIDE = 512
const QUALITIES = [0.85, 0.70, 0.55]
const PREVIEW_QUALITY = 0.8
// Larger source files are refused before decoding (memory).
const MAX_SOURCE_BYTES = 50 * 1024 * 1024

function fail (message) {
  return new Error(message)
}

function toBlob (canvas, mime, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), mime, quality)
    } catch {
      resolve(null)
    }
  })
}

function zero (canvas) {
  canvas.width = 0
  canvas.height = 0
}

// -> { source, width, height, release }
async function decode (file) {
  if (typeof createImageBitmap === 'function') {
    try {
      let bitmap
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      } catch {
        bitmap = await createImageBitmap(file)
      }
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { try { bitmap.close() } catch {} } }
    } catch {}
  }
  const url = URL.createObjectURL(file)
  const img = new Image()
  const release = () => {
    URL.revokeObjectURL(url)
    img.src = ''
  }
  try {
    img.src = url
    await img.decode()
  } catch {
    release()
    throw fail('não foi possível abrir a foto')
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release }
}

async function freeze (file) {
  const decoded = await decode(file)
  const canvas = document.createElement('canvas')
  try {
    if (!(decoded.width >= 1 && decoded.height >= 1)) throw fail('não foi possível abrir a foto')
    if (decoded.width > MAX_MEDIA_DIMENSION || decoded.height > MAX_MEDIA_DIMENSION) throw fail('foto grande demais')
    const { width, height } = fitWithin(decoded.width, decoded.height, MAX_IMAGE_SIDE)
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw fail('não foi possível preparar a foto')
    // White under transparency: the jpeg preview and a jpeg export match.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(decoded.source, 0, 0, width, height)
    return canvas
  } catch (err) {
    zero(canvas)
    throw err
  } finally {
    decoded.release()
  }
}

function validRect (rect, canvas) {
  if (!rect || typeof rect !== 'object') return false
  const { sx, sy, size } = rect
  return [sx, sy, size].every(Number.isInteger) && size >= 1 && sx >= 0 && sy >= 0 &&
    sx + size <= canvas.width && sy + size <= canvas.height
}

// -> the first blob of `mime` that fits, null when none fits, or false when
// the browser does not produce `mime`.
async function firstFit (canvas, mime, maxBytes) {
  for (const quality of QUALITIES) {
    const blob = await toBlob(canvas, mime, quality)
    if (!blob || blob.type !== mime) return false
    if (blob.size <= maxBytes) return blob
  }
  return null
}

export async function openImage (file) {
  if (!file || !MEDIA_MIMES.includes(file.type)) throw fail('formato não aceito')
  if (!(file.size <= MAX_SOURCE_BYTES)) throw fail('arquivo grande demais')
  const frozen = await freeze(file)
  const preview = await toBlob(frozen, 'image/jpeg', PREVIEW_QUALITY)
  if (!preview) {
    zero(frozen)
    throw fail('não foi possível preparar a foto')
  }
  const uri = URL.createObjectURL(preview)
  let released = false

  async function encode (rect, maxBytes) {
    if (released || !validRect(rect, frozen) || !(Number.isSafeInteger(maxBytes) && maxBytes >= 1)) {
      throw fail('não foi possível preparar a foto')
    }
    const out = document.createElement('canvas')
    try {
      out.width = OUTPUT_SIDE
      out.height = OUTPUT_SIDE
      const ctx = out.getContext('2d')
      if (!ctx) throw fail('não foi possível preparar a foto')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      // The frozen canvas is already opaque, so jpeg needs no extra white.
      ctx.drawImage(frozen, rect.sx, rect.sy, rect.size, rect.size, 0, 0, OUTPUT_SIDE, OUTPUT_SIDE)
      let mime = 'image/webp'
      let blob = await firstFit(out, mime, maxBytes)
      if (blob === false) {
        mime = 'image/jpeg'
        blob = await firstFit(out, mime, maxBytes)
        if (blob === false) throw fail('não foi possível preparar a foto')
      }
      if (!blob) throw fail('foto grande demais')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { bytes, mime, width: OUTPUT_SIDE, height: OUTPUT_SIDE }
    } finally {
      zero(out)
    }
  }

  function release () {
    if (released) return
    released = true
    try { URL.revokeObjectURL(uri) } catch {}
    zero(frozen)
  }

  return { uri, width: frozen.width, height: frozen.height, encode, release }
}
