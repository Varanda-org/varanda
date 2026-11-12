'use strict'

// Reads the canvas size and frame count of a JPEG, PNG, WebP or GIF from its
// container headers, so a caller can refuse an image before handing it to a
// decoder that would allocate width x height x frames of pixels. Pixels are
// never decoded. Anything truncated, malformed, over a bound, or whose bytes
// do not match the given mime is null. Never throws. Works on Uint8Array
// only, with no Node built-ins, so the app bundle can use it. mediaSize reads
// the same headers without the size bounds, for a caller with its own.

const { MAX_MEDIA_DIMENSION } = require('./limits')

const MAX_MEDIA_PIXELS = 16777216
const MAX_MEDIA_FRAMES = 300
// Pixels across every frame, for a decoder that keeps all frames at once: a
// 640x480 animation of 218 frames fits.
const MAX_MEDIA_TOTAL_PIXELS = 67108864
// Segments or chunks walked before giving up; every step also advances, so
// the walks end on any input regardless.
const MAX_PARTS = 1024
// An APNG is walked to IEND, through every fcTL, fdAT and split IDAT. Each
// chunk is at least 12 bytes, so this also bounds the walk on a large file.
const MAX_PNG_CHUNKS = 65536

// The frame cap stays in both: the walks stop on it.
const STRICT = { dimension: MAX_MEDIA_DIMENSION, pixels: MAX_MEDIA_PIXELS, total: MAX_MEDIA_TOTAL_PIXELS }
const LOOSE = { dimension: Infinity, pixels: Infinity, total: Infinity }

function be16 (b, p) {
  return (b[p] << 8) | b[p + 1]
}

function be32 (b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
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

function bounded (width, height, frames, cap) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(frames)) return null
  if (width < 1 || height < 1 || frames < 1) return null
  if (width > cap.dimension || height > cap.dimension) return null
  if (width * height > cap.pixels) return null
  if (frames > MAX_MEDIA_FRAMES) return null
  if (width * height * frames > cap.total) return null
  return { width, height, frames }
}

function isSof (m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
}

// Before the frame header a decoder skips only these by their length: APPn,
// COM, DQT, DHT, DAC, DRI, DNL. On any other marker (FF 00 above all) libjpeg
// rescans byte by byte and may find a frame header inside the bytes this walk
// would have skipped, so the size read here would not be the one decoded.
function skippedByLength (m) {
  return (m >= 0xe0 && m <= 0xef) || m === 0xfe || m === 0xdb || m === 0xc4 || m === 0xcc || m === 0xdd || m === 0xdc
}

function jpegBounds (b, cap) {
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
    // Scan data or the end before any frame header: no size to trust.
    if (marker === 0xda || marker === 0xd9) return null
    if (!isSof(marker) && !skippedByLength(marker)) return null
    if (p + 4 > n) return null
    const len = be16(b, p + 2)
    if (len < 2 || p + 2 + len > n) return null
    if (isSof(marker)) {
      if (len < 11) return null
      const nf = b[p + 9]
      if (nf < 1 || nf > 4 || len !== 8 + 3 * nf) return null
      return bounded(be16(b, p + 7), be16(b, p + 5), 1, cap)
    }
    p += 2 + len
  }
  return null
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// A plain PNG is walked up to the first IDAT, because an APNG declares its
// frame count in an acTL chunk that must come before it. An APNG is walked to
// IEND so every fcTL frame rectangle is checked against the canvas and the
// frames are counted, never only the count acTL declares.
function pngBounds (b, cap) {
  const n = b.length
  if (n < 33) return null
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return null
  if (be32(b, 8) !== 13 || fourcc(b, 12) !== 'IHDR') return null
  const width = be32(b, 16)
  const height = be32(b, 20)
  if (width < 1 || height < 1 || width > cap.dimension || height > cap.dimension) return null
  let frames = 1
  let seenActl = false
  let seenIdat = false
  let fctls = 0
  let p = 33
  for (let count = 0; count < MAX_PNG_CHUNKS; count++) {
    if (!seenActl && count >= MAX_PARTS) return null
    if (p + 8 > n) return null
    const len = be32(b, p)
    const id = fourcc(b, p + 4)
    if (len > n - p - 12) return null
    const at = p + 8
    if (id === 'IDAT') {
      if (!seenActl) return bounded(width, height, frames, cap)
      seenIdat = true
    } else if (id === 'IHDR') {
      return null
    } else if (id === 'IEND') {
      if (!seenActl || !seenIdat || len !== 0) return null
      return bounded(width, height, frames, cap)
    } else if (id === 'acTL') {
      if (seenActl || seenIdat || len !== 8) return null
      seenActl = true
      frames = be32(b, at)
      if (frames < 1 || frames > MAX_MEDIA_FRAMES || fctls > frames) return null
    } else if (id === 'fcTL') {
      if (len !== 26) return null
      if (++fctls > MAX_MEDIA_FRAMES || (seenActl && fctls > frames)) return null
      const fw = be32(b, at + 4)
      const fh = be32(b, at + 8)
      const fx = be32(b, at + 12)
      const fy = be32(b, at + 16)
      if (fw < 1 || fh < 1 || fx + fw > width || fy + fh > height) return null
    }
    p = at + len + 4
  }
  return null
}

// Size from a VP8 key frame header at b[at..at+len), or null.
function vp8Size (b, at, len) {
  if (len < 10) return null
  if (b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) return null
  return { width: le16(b, at + 6) & 0x3fff, height: le16(b, at + 8) & 0x3fff }
}

// Size from a VP8L header at b[at..at+len), or null.
function vp8lSize (b, at, len) {
  if (len < 5 || b[at] !== 0x2f) return null
  const v = le32(b, at + 1)
  return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
}

// Size of the bitstream inside an ANMF payload b[at..end): an optional ALPH
// chunk then VP8, or VP8L alone (it carries its own alpha). Null when the
// bitstream is missing, unreadable or does not fit the payload.
function anmfBitstreamSize (b, at, end) {
  let q = at
  let alpha = false
  for (let i = 0; i < 2; i++) {
    if (q + 8 > end) return null
    const id = fourcc(b, q)
    const len = le32(b, q + 4)
    const data = q + 8
    if (len > end - data) return null
    if (id === 'ALPH' && !alpha) {
      alpha = true
      q = data + len + (len & 1)
      continue
    }
    if (id === 'VP8 ') return vp8Size(b, data, len)
    if (id === 'VP8L' && !alpha) return vp8lSize(b, data, len)
    return null
  }
  return null
}

// The whole RIFF body is walked so every ANMF frame is counted, never only
// the canvas the VP8X chunk declares.
function webpBounds (b, cap) {
  const n = b.length
  if (n < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null
  const riffSize = le32(b, 4)
  if (riffSize < 4 || riffSize > n - 8) return null
  const end = 8 + riffSize
  let p = 12
  let canvas = null
  let animated = false
  let still = null
  let frames = 0
  for (let count = 0; p + 8 <= end; count++) {
    if (count >= MAX_PARTS) return null
    const id = fourcc(b, p)
    const len = le32(b, p + 4)
    const at = p + 8
    if (len > end - at) return null
    if (id === 'VP8X') {
      if (canvas !== null || still !== null || frames > 0 || len < 10) return null
      animated = (b[at] & 0x02) !== 0
      canvas = { width: 1 + le24(b, at + 4), height: 1 + le24(b, at + 7) }
      if (canvas.width > cap.dimension || canvas.height > cap.dimension) return null
    } else if (id === 'ANMF') {
      if (!animated || len < 16) return null
      if (++frames > MAX_MEDIA_FRAMES) return null
      const fw = 1 + le24(b, at + 6)
      const fh = 1 + le24(b, at + 9)
      const fx = 2 * le24(b, at)
      const fy = 2 * le24(b, at + 3)
      if (fx + fw > canvas.width || fy + fh > canvas.height) return null
      // A decoder sizes the frame from its bitstream, so it must match.
      const inner = anmfBitstreamSize(b, at + 16, at + len)
      if (inner === null || inner.width !== fw || inner.height !== fh) return null
    } else if (id === 'VP8 ') {
      if (animated || still !== null) return null
      still = vp8Size(b, at, len)
      if (still === null) return null
    } else if (id === 'VP8L') {
      if (animated || still !== null) return null
      still = vp8lSize(b, at, len)
      if (still === null) return null
    }
    p = at + len + (len & 1)
  }
  if (p !== end) return null
  if (animated) return bounded(canvas.width, canvas.height, frames, cap)
  if (still === null) return null
  if (canvas !== null && (canvas.width !== still.width || canvas.height !== still.height)) return null
  return bounded(still.width, still.height, 1, cap)
}

// Skips a run of GIF data sub-blocks and returns the offset after the zero
// terminator, or -1 when the buffer ends first. Each step advances by at least
// one byte, so it ends on any input.
function skipSubBlocks (b, p) {
  const n = b.length
  while (p < n) {
    const len = b[p]
    if (len === 0) return p + 1
    p += 1 + len
  }
  return -1
}

// Walks every block up to the trailer, counting image descriptors and
// stopping as soon as the count passes the cap. Some decoders grow the canvas
// to fit a frame that overflows the logical screen, so the bounds apply to
// the union of the screen and every frame rectangle.
function gifBounds (b, cap) {
  const n = b.length
  if (n < 13) return null
  const sig = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5])
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null
  let width = le16(b, 6)
  let height = le16(b, 8)
  let p = 13
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 0x07) + 1))
  let frames = 0
  while (true) {
    if (p >= n) return null
    const tag = b[p]
    if (tag === 0x3b) break
    if (tag === 0x21) {
      if (p + 2 > n) return null
      p = skipSubBlocks(b, p + 2)
      if (p < 0) return null
    } else if (tag === 0x2c) {
      if (p + 10 > n) return null
      if (++frames > MAX_MEDIA_FRAMES) return null
      const right = le16(b, p + 1) + le16(b, p + 5)
      const bottom = le16(b, p + 3) + le16(b, p + 7)
      if (right > width) width = right
      if (bottom > height) height = bottom
      const packed = b[p + 9]
      p += 10
      if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1))
      // LZW minimum code size byte, then the image data sub-blocks.
      if (p + 1 > n) return null
      p = skipSubBlocks(b, p + 1)
      if (p < 0) return null
    } else {
      return null
    }
  }
  return bounded(width, height, frames, cap)
}

const PARSERS = {
  'image/jpeg': jpegBounds,
  'image/png': pngBounds,
  'image/webp': webpBounds,
  'image/gif': gifBounds
}

function sniff (b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && fourcc(b, 0) === 'RIFF' && fourcc(b, 8) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && fourcc(b, 0) === 'GIF8') return 'image/gif'
  return null
}

function read (bytes, mime, cap) {
  try {
    if (!(bytes instanceof Uint8Array)) return null
    const kind = sniff(bytes)
    if (kind === null) return null
    if (mime !== undefined && mime !== kind) return null
    return PARSERS[kind](bytes, cap)
  } catch {
    return null
  }
}

// mime is optional; when given, the bytes must be that format.
function mediaBounds (bytes, mime) {
  return read(bytes, mime, STRICT)
}

// The header's { width, height, frames } with no dimension or pixel bound
// (frames still stop at MAX_MEDIA_FRAMES), or null like mediaBounds.
function mediaSize (bytes, mime) {
  return read(bytes, mime, LOOSE)
}

module.exports = { mediaBounds, mediaSize, MAX_MEDIA_PIXELS, MAX_MEDIA_FRAMES, MAX_MEDIA_TOTAL_PIXELS }
