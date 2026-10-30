// Native: turns a picked asset ({ uri, mimeType, width, height }) into the
// bytes that are uploaded, like encode.web.js.
// - A GIF passes through UNCHANGED (the animation is kept), at most
//   MAX_GIF_BYTES; its size comes from the header (gif.js).
// - Other photos go through expo-image-manipulator: resized to
//   fitWithin(w, h, MAX_IMAGE_SIDE) and re-encoded as JPEG (0.85). Decoding
//   and re-encoding the pixels STRIPS all metadata: EXIF, GPS position,
//   camera data. The temporary file the module writes is deleted at once.
// Sources over 50 MiB are refused before decoding (memory). Every result
// passes checkFile.
// -> { bytes: Uint8Array, mime, width, height }; throws an Error with a
// message for the person.

import { File } from 'expo-file-system'
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator'
import { gifSize } from './gif.js'
import { MAX_GIF_BYTES, MAX_IMAGE_SIDE, MAX_MEDIA_DIMENSION, checkFile, fitWithin } from './plan.js'

const QUALITY = 0.85
const MAX_SOURCE_BYTES = 50 * 1024 * 1024

function fail (message) {
  return new Error(message)
}

function discard (file) {
  try { if (file.exists) file.delete() } catch {}
}

async function encodeGif (source, bytes) {
  if (bytes.byteLength > MAX_GIF_BYTES) throw fail('arquivo grande demais')
  const size = gifSize(bytes)
  if (!size) throw fail('formato não aceito')
  const problem = checkFile({ mime: 'image/gif', bytes: bytes.byteLength, ...size })
  if (problem) throw fail(problem)
  return { bytes, mime: 'image/gif', ...size }
}

async function encodePhoto (asset) {
  const w = asset.width
  const h = asset.height
  if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1)) throw fail('não foi possível abrir a foto')
  if (w > MAX_MEDIA_DIMENSION || h > MAX_MEDIA_DIMENSION) throw fail('foto grande demais')
  const fit = fitWithin(w, h, MAX_IMAGE_SIDE)
  const actions = fit.width === w && fit.height === h ? [] : [{ resize: { width: fit.width, height: fit.height } }]
  let result
  try {
    result = await manipulateAsync(asset.uri, actions, { compress: QUALITY, format: SaveFormat.JPEG })
  } catch {
    throw fail('não foi possível preparar a foto')
  }
  const out = new File(result.uri)
  try {
    const bytes = await out.bytes()
    const problem = checkFile({ mime: 'image/jpeg', bytes: bytes.byteLength, width: result.width, height: result.height })
    if (problem) throw fail(problem)
    return { bytes, mime: 'image/jpeg', width: result.width, height: result.height }
  } finally {
    discard(out)
  }
}

export async function encodeFile (asset) {
  if (!asset || typeof asset.uri !== 'string') throw fail('formato não aceito')
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
  // A GIF is told by its signature too: a picker may report a wrong type.
  if (mime === 'image/gif' || size <= MAX_GIF_BYTES) {
    let bytes
    try {
      bytes = await file.bytes()
    } catch {
      throw fail('não foi possível abrir a foto')
    }
    if (gifSize(bytes)) return encodeGif(asset, bytes)
    if (mime === 'image/gif') throw fail('formato não aceito')
  }
  return encodePhoto(asset)
}
