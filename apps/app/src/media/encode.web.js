/* global Blob, createImageBitmap, document, Image, URL */

// Web: turns a chosen file into the bytes that are uploaded.
// - Photos (jpeg, png, webp) whose header size passes photoProblem are
//   decoded (createImageBitmap, or an <img> when it is missing or fails),
//   drawn on a canvas at fitWithin(w, h, MAX_IMAGE_SIDE) and re-encoded as
//   image/webp (quality 0.85) when the browser really produces webp, else
//   image/jpeg (0.85, on white, since jpeg has no transparency). The
//   re-encode STRIPS all metadata: EXIF, GPS position, camera data. The
//   orientation is applied while decoding.
// - GIFs pass through UNCHANGED (the animation is kept), at most
//   MAX_GIF_BYTES; their size comes from the header (logical screen width and
//   height, bytes 6-9, little-endian). A GIF carries no EXIF; its own
//   metadata blocks (comment and application extensions) are kept as they are.
// Every result passes checkFile. Every object URL, bitmap and canvas created
// here is released before returning.
// -> { bytes: Uint8Array, mime, width, height }; throws an Error with a
// message for the person.

import rpc from '@varanda/rpc'
import { gifProblem, gifSize } from './gif.js'
import { MAX_GIF_BYTES, MAX_IMAGE_SIDE, checkFile, fitWithin, kindOf } from './plan.js'

const QUALITY = 0.85
// Larger source files are refused before decoding (memory).
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
// A decode allocates width x height pixels, so the header size is checked
// first. Same limits as the iOS share import: 48 MP photos and panoramas fit.
export const MAX_PHOTO_SIDE = 16384
export const MAX_PHOTO_PIXELS = 100000000

function fail (message) {
  return new Error(message)
}

async function bytesOf (blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

async function encodeGif (file) {
  if (file.size > MAX_GIF_BYTES) throw fail('arquivo grande demais')
  const bytes = await bytesOf(file)
  const size = gifSize(bytes)
  if (!size) throw fail('formato não aceito')
  const problem = checkFile({ mime: 'image/gif', bytes: bytes.byteLength, ...size })
  if (problem) throw fail(problem)
  const refused = gifProblem(bytes)
  if (refused) throw fail(refused)
  return { bytes, mime: 'image/gif', ...size }
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
  try {
    img.src = url
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw fail('não foi possível abrir a foto')
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => {
      URL.revokeObjectURL(url)
      img.src = ''
    }
  }
}

function toBlob (canvas, mime) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), mime, QUALITY)
    } catch {
      resolve(null)
    }
  })
}

// The message for a photo that must not reach the decoder, or null. The
// decoder sniffs the bytes, not the declared type, so the header is read the
// same way.
export function photoProblem (bytes) {
  const size = rpc.mediaSize(bytes)
  if (size === null) return 'não foi possível abrir a foto'
  if (size.width > MAX_PHOTO_SIDE || size.height > MAX_PHOTO_SIDE || size.width * size.height > MAX_PHOTO_PIXELS) return 'foto grande demais'
  return null
}

async function encodePhoto (file) {
  if (file.size > MAX_SOURCE_BYTES) throw fail('arquivo grande demais')
  let source
  try {
    source = await bytesOf(file)
  } catch {
    throw fail('não foi possível abrir a foto')
  }
  const refused = photoProblem(source)
  if (refused) throw fail(refused)
  const decoded = await decode(file)
  const canvas = document.createElement('canvas')
  try {
    if (!(decoded.width >= 1 && decoded.height >= 1)) throw fail('não foi possível abrir a foto')
    const { width, height } = fitWithin(decoded.width, decoded.height, MAX_IMAGE_SIDE)
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw fail('não foi possível preparar a foto')
    ctx.drawImage(decoded.source, 0, 0, width, height)
    let blob = await toBlob(canvas, 'image/webp')
    let mime = 'image/webp'
    if (!blob || blob.type !== 'image/webp') {
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(decoded.source, 0, 0, width, height)
      blob = await toBlob(canvas, 'image/jpeg')
      mime = 'image/jpeg'
      if (!blob || blob.type !== 'image/jpeg') throw fail('não foi possível preparar a foto')
    }
    const bytes = await bytesOf(blob)
    const problem = checkFile({ mime, bytes: bytes.byteLength, width, height })
    if (problem) throw fail(problem)
    return { bytes, mime, width, height }
  } finally {
    decoded.release()
    canvas.width = 0
    canvas.height = 0
  }
}

export async function encodeFile (file) {
  const kind = file ? kindOf(file.type) : null
  if (kind === null) throw fail('formato não aceito')
  return kind === 'gif' ? encodeGif(file) : encodePhoto(file)
}

// A link card's thumbnail (../linkCard.js): the page image drawn on white
// and re-encoded as a JPEG at most `side` px on the long side and `maxBytes`
// bytes, with a lower quality, then a smaller size, until it fits.
// -> { bytes, mime, width, height } or null when it never fits.
const THUMB_QUALITIES = [0.7, 0.5, 0.35]
const THUMB_SCALES = [1, 0.75, 0.5]

function toJpeg (canvas, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', quality)
    } catch {
      resolve(null)
    }
  })
}

export async function encodeThumbnail (bytes, mime, { side = 320, maxBytes = 32752 } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null
  // The page chose the image: its header must declare a size within the
  // photo bounds before anything decodes it (a decompression bomb).
  if (rpc.mediaBounds(bytes, mime) === null) return null
  let decoded
  try {
    decoded = await decode(new Blob([bytes], { type: mime }))
  } catch {
    return null
  }
  const canvas = document.createElement('canvas')
  try {
    if (!(decoded.width >= 1 && decoded.height >= 1)) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    for (const scale of THUMB_SCALES) {
      const { width, height } = fitWithin(decoded.width, decoded.height, Math.max(1, Math.round(side * scale)))
      canvas.width = width
      canvas.height = height
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(decoded.source, 0, 0, width, height)
      for (const q of THUMB_QUALITIES) {
        const blob = await toJpeg(canvas, q)
        if (!blob || blob.type !== 'image/jpeg') return null
        if (blob.size <= maxBytes) return { bytes: await bytesOf(blob), mime: 'image/jpeg', width, height }
      }
    }
    return null
  } catch {
    return null
  } finally {
    decoded.release()
    canvas.width = 0
    canvas.height = 0
  }
}
