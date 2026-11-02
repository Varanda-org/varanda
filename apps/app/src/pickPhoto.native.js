// Native: one document photo from the system picker, as
// { type: 'image/jpeg' | 'image/png', size, bytes }, null for a cancel, or
// false when the photo could not be used (so the screen can say so instead
// of looking like a cancel). The pixels are decoded and saved again with no
// resize: the document must stay legible, and the re-encode is what strips
// EXIF and GPS (media/encode.native.js).
// Photos become JPEG; a PNG, WebP or GIF source becomes PNG, because JPEG has
// no alpha and Android fills transparency with black, which hides dark text
// on a scan. Not encodeFile: it can hand back a GIF, which the upload
// refuses. Both temporary files (the picker's copy and the manipulator's
// output) are deleted whatever happens.

import { File, Paths } from 'expo-file-system'
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { canHaveAlpha } from './media/source.js'

const QUALITY = 0.92
const MAX_BYTES = 10 * 1024 * 1024

// The upload takes JPEG or PNG only, so a WebP or GIF that may carry
// transparency is saved as PNG too.
function keepsAlpha (asset) {
  if (typeof asset.mimeType === 'string' && asset.mimeType) {
    return canHaveAlpha(asset.mimeType) || asset.mimeType.toLowerCase() === 'image/gif'
  }
  return /\.(png|webp|gif)$/i.test(asset.uri)
}

// Only a file:// URI under the app's own cache is ours to delete.
function inCache (uri) {
  try {
    if (typeof uri !== 'string' || !uri.startsWith('file://') || /\/\.\.(\/|$)|%2e/i.test(uri)) return false
    const base = Paths.cache.uri
    if (typeof base !== 'string' || !base.startsWith('file://')) return false
    const prefix = base.endsWith('/') ? base : base + '/'
    return uri.startsWith(prefix) && uri.length > prefix.length
  } catch {
    return false
  }
}

function discard (uri) {
  try {
    if (!inCache(uri)) return
    const file = new File(uri)
    if (file.exists) file.delete()
  } catch {}
}

export async function pickPhoto () {
  let pickedUri = null
  let savedUri = null
  try {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], exif: false, allowsMultipleSelection: false })
    if (!res || res.canceled || !Array.isArray(res.assets) || !res.assets[0]) return null
    const asset = res.assets[0]
    if (typeof asset.uri !== 'string') return null
    pickedUri = asset.uri
    const png = keepsAlpha(asset)
    const out = await manipulateAsync(pickedUri, [], png ? { format: SaveFormat.PNG } : { compress: QUALITY, format: SaveFormat.JPEG })
    if (!out || typeof out.uri !== 'string') return false
    savedUri = out.uri
    // The size first, so an oversized result is never read into memory.
    const file = new File(savedUri)
    if (!(file.size > 0) || file.size > MAX_BYTES) return false
    const bytes = await file.bytes()
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) return false
    return { type: png ? 'image/png' : 'image/jpeg', size: bytes.byteLength, bytes }
  } catch {
    return false
  } finally {
    discard(savedUri)
    discard(pickedUri)
  }
}
