// Pure media planning for the composer. No browser or Node dependencies.
// Same values as packages/core/lib/records.js.
export const MEDIA_BLOCK_BYTES = 32768
export const MAX_MEDIA_ITEM_BLOCKS = 256
export const MAX_MEDIA_PER_POST = 4
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
  return Number.isInteger(n) && n >= 1 && n <= MAX_MEDIA_PER_POST
    ? ['one', 'two', 'three', 'four'][n - 1]
    : null
}
