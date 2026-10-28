'use strict'

// Reads the pixel size of a still JPEG or WebP from its container headers,
// without decoding pixels or reading metadata. Anything it cannot read for
// certain (truncated, animated, another format, a mime that does not match
// the bytes) is null, so a caller can refuse it. Never throws.

// At most this many JPEG segments or WebP chunks are walked.
const MAX_PARTS = 64

function be16 (b, p) {
  return (b[p] << 8) | b[p + 1]
}

function le16 (b, p) {
  return b[p] | (b[p + 1] << 8)
}

function le24 (b, p) {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)
}

function le32 (b, p) {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
}

function fourcc (b, p) {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])
}

function size (width, height) {
  return width >= 1 && height >= 1 ? { width, height } : null
}

function isSof (m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
}

function jpegSize (b) {
  const n = b.length
  if (n < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null
  let p = 2
  for (let count = 0; count < MAX_PARTS; count++) {
    if (p + 1 >= n || b[p] !== 0xff) return null
    while (p + 1 < n && b[p + 1] === 0xff) p++
    if (p + 1 >= n) return null
    const marker = b[p + 1]
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null
    if (p + 4 > n) return null
    const len = be16(b, p + 2)
    if (len < 2 || p + 2 + len > n) return null
    if (isSof(marker)) {
      // A frame header is 8 bytes plus 3 per component, so a short or
      // inconsistent one is not trusted for its size fields.
      if (len < 11) return null
      const nf = b[p + 9]
      if (nf < 1 || nf > 4 || len !== 8 + 3 * nf) return null
      return size(be16(b, p + 7), be16(b, p + 5))
    }
    p += 2 + len
  }
  return null
}

// The whole RIFF body is walked, never stopping at the image chunk, so an
// animation chunk or a second image anywhere makes the file null.
function webpSize (b) {
  const n = b.length
  if (n < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null
  const riffSize = le32(b, 4)
  if (riffSize < 4 || 8 + riffSize > n) return null
  const end = 8 + riffSize
  let p = 12
  let canvas = null
  let frame = null
  for (let count = 0; p + 8 <= end; count++) {
    if (count >= MAX_PARTS) return null
    const id = fourcc(b, p)
    const len = le32(b, p + 4)
    const at = p + 8
    if (len > end - at) return null
    if (id === 'ANIM' || id === 'ANMF') return null
    if (id === 'VP8X') {
      if (canvas !== null || frame !== null || len < 10) return null
      if ((b[at] & 0x02) !== 0) return null
      canvas = { width: 1 + le24(b, at + 4), height: 1 + le24(b, at + 7) }
    } else if (id === 'VP8 ') {
      if (frame !== null || len < 10) return null
      if (b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) return null
      frame = size(le16(b, at + 6) & 0x3fff, le16(b, at + 8) & 0x3fff)
      if (frame === null) return null
    } else if (id === 'VP8L') {
      if (frame !== null || len < 5 || b[at] !== 0x2f) return null
      const v = le32(b, at + 1)
      frame = { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
    }
    p = at + len + (len & 1)
  }
  // Stray bytes or a missing pad byte at the end mean a malformed container.
  if (p !== end) return null
  if (frame === null) return null
  if (canvas !== null && (canvas.width !== frame.width || canvas.height !== frame.height)) return null
  return frame
}

function stillImageSize (bytes, mime) {
  try {
    if (!(bytes instanceof Uint8Array)) return null
    if (mime === 'image/jpeg') return jpegSize(bytes)
    if (mime === 'image/webp') return webpSize(bytes)
    return null
  } catch {
    return null
  }
}

module.exports = { stillImageSize }
