// Pure media planning for the composer. No browser or Node dependencies.
// Same values as packages/core/lib/records.js, except the chat cap below.
export const MEDIA_BLOCK_BYTES = 32768
export const MAX_MEDIA_ITEM_BLOCKS = 256
// Same value as packages/core/lib/records.js.
export const MAX_MEDIA_PER_POST = 10
// Photos per chat message. DMs and groups stay at four: MAX_GROUP_MEDIA and
// the DM inner body budget, which were measured for four items.
export const MAX_MEDIA_PER_MESSAGE = 4
export const MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_MEDIA_DIMENSION = 16384
export const MAX_IMAGE_SIDE = 2048
export const MAX_GIF_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function kindOf (mime) {
  if (!MEDIA_MIMES.includes(mime)) return null
  return mime === 'image/gif' ? 'gif' : 'image'
}

export function blocksFor (bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError('Expected a positive byte count')
  return Math.ceil(bytes / MEDIA_BLOCK_BYTES)
}

export function splitBlocks (bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array')
  const count = blocksFor(bytes.byteLength)
  return Array.from({ length: count }, (_, i) => bytes.subarray(i * MEDIA_BLOCK_BYTES, (i + 1) * MEDIA_BLOCK_BYTES))
}

export function fitWithin (width, height, maxSide = MAX_IMAGE_SIDE) {
  if (![width, height, maxSide].every(n => Number.isFinite(n) && n >= 1)) {
    throw new RangeError('Expected positive image dimensions')
  }
  const scale = Math.min(1, Math.floor(maxSide) / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

export function checkFile ({ mime, bytes, width, height }) {
  const kind = kindOf(mime)
  if (!kind) return 'formato não aceito'
  const max = kind === 'gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > max) return 'arquivo grande demais'
  if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= MAX_MEDIA_DIMENSION)) {
    return 'imagem grande demais'
  }
  return null
}

export function descriptorFor ({ core, mime, start, bytes, sha256, width, height }) {
  return { core, mime, start, blocks: blocksFor(bytes), bytes, sha256, width, height }
}

export function toHex (bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function gridLayout (n) {
  const kinds = ['one', 'two', 'three', 'four']
  return Number.isInteger(n) && n >= 1 && n <= kinds.length ? kinds[n - 1] : null
}

// A quote card has no room past four tiles, so the rest is only a count.
export function mosaicLayout (n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MEDIA_PER_POST) return null
  return { kind: gridLayout(Math.min(n, 4)), more: Math.max(0, n - 4) }
}

// Short videos, same values as packages/core/lib/records.js. kindOf stays
// images only: checkFile and the web encoder would otherwise send a video
// into the image path shared by chat, the Feira and avatars.
export const VIDEO_MIME = 'video/mp4'
export const MAX_VIDEO_MS = 30000
export const MAX_VIDEO_BYTES = 8388608
export const MAX_VIDEO_DIMENSION = 1920
export const MAX_VIDEO_PIXELS = 2073600
export const MAX_MOMENT_VIDEO_MS = 15000
export const MAX_MOMENT_VIDEO_BYTES = 4194304

// A video post's media is exactly [JPEG poster, video]: { poster, video },
// else null. Shape only; fetch.js checks each descriptor before any URL.
export function videoPair (media) {
  if (!Array.isArray(media) || media.length !== 2) return null
  const poster = media[0]
  const video = media[1]
  if (!poster || typeof poster !== 'object' || poster.mime !== 'image/jpeg') return null
  if (!video || typeof video !== 'object' || video.mime !== VIDEO_MIME) return null
  return { poster, video }
}

// "0:07", "1:30": whole seconds, rounded up so a clip never reads 0:00.
export function durationLabel (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m + ':' + String(s).padStart(2, '0')
}
