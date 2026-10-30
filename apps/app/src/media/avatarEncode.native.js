// Native: opens a picked asset for the avatar editor and encodes the cropped
// square, like avatarEncode.web.js. An avatar is always a still image.
// - openImage(asset) re-encodes the photo once with expo-image-manipulator at
//   fitWithin(w, h, MAX_IMAGE_SIDE) as JPEG. That frozen file is the only
//   source for the preview and the export (so an animation contributes one
//   frame) and it carries no metadata.
// - encode({ sx, sy, size }, maxBytes) crops that square, resizes it to
//   AVATAR_SIDE and saves a JPEG, lowering the quality until it fits.
// The frozen file and every temporary file are deleted by release() or at
// once. -> { uri, width, height, encode, release }; every failure is an Error
// with a message for the person.

import { File } from 'expo-file-system'
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator'
import { AVATAR_SIDE } from './avatar.js'
import { MAX_IMAGE_SIDE, MAX_MEDIA_DIMENSION, fitWithin } from './plan.js'
import { acceptedSource, canHaveAlpha } from './source.js'

const QUALITIES = [0.85, 0.70, 0.55]
const MAX_SOURCE_BYTES = 50 * 1024 * 1024

function fail (message) {
  return new Error(message)
}

function discard (uri) {
  try {
    const file = new File(uri)
    if (file.exists) file.delete()
  } catch {}
}

function validRect (rect, width, height) {
  if (!rect || typeof rect !== 'object') return false
  const { sx, sy, size } = rect
  return [sx, sy, size].every(Number.isInteger) && size >= 1 && sx >= 0 && sy >= 0 &&
    sx + size <= width && sy + size <= height
}

export async function openImage (asset) {
  if (!asset || typeof asset.uri !== 'string') throw fail('formato não aceito')
  if (!acceptedSource(asset.mimeType)) throw fail('formato não aceito')
  const w = asset.width
  const h = asset.height
  if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1)) throw fail('não foi possível abrir a foto')
  if (w > MAX_MEDIA_DIMENSION || h > MAX_MEDIA_DIMENSION) throw fail('foto grande demais')
  let size
  try {
    size = new File(asset.uri).size
  } catch {
    throw fail('não foi possível abrir a foto')
  }
  if (!(size >= 1)) throw fail('não foi possível abrir a foto')
  if (size > MAX_SOURCE_BYTES) throw fail('arquivo grande demais')

  const fit = fitWithin(w, h, MAX_IMAGE_SIDE)
  // A source that can be transparent is frozen as PNG, so the transparency
  // survives until encode (a JPEG freeze would turn it black).
  const alpha = canHaveAlpha(asset.mimeType)
  let frozen
  try {
    frozen = await manipulateAsync(asset.uri, [{ resize: { width: fit.width, height: fit.height } }], { compress: 0.9, format: alpha ? SaveFormat.PNG : SaveFormat.JPEG })
  } catch {
    throw fail('não foi possível preparar a foto')
  }
  const { uri, width, height } = frozen
  let released = false

  async function encode (rect, maxBytes) {
    if (released || !validRect(rect, width, height) || !(Number.isSafeInteger(maxBytes) && maxBytes >= 1)) {
      throw fail('não foi possível preparar a foto')
    }
    const actions = [
      { crop: { originX: rect.sx, originY: rect.sy, width: rect.size, height: rect.size } },
      { resize: { width: AVATAR_SIDE, height: AVATAR_SIDE } }
    ]
    // Avatars are JPEG or WebP only. A source with alpha tries WebP (which
    // keeps it) first; JPEG is the fallback when no WebP fits the cap
    // (residual: transparent pixels then turn black).
    const formats = alpha
      ? [[SaveFormat.WEBP, 'image/webp'], [SaveFormat.JPEG, 'image/jpeg']]
      : [[SaveFormat.JPEG, 'image/jpeg']]
    for (const [format, mime] of formats) {
      for (const quality of QUALITIES) {
        let out
        try {
          out = await manipulateAsync(uri, actions, { compress: quality, format })
        } catch {
          throw fail('não foi possível preparar a foto')
        }
        try {
          const bytes = await new File(out.uri).bytes()
          if (bytes.byteLength <= maxBytes) {
            return { bytes, mime, width: AVATAR_SIDE, height: AVATAR_SIDE }
          }
        } finally {
          discard(out.uri)
        }
      }
    }
    throw fail('foto grande demais')
  }

  function release () {
    if (released) return
    released = true
    discard(uri)
  }

  return { uri, width, height, encode, release }
}
