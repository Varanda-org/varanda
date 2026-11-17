'use strict'

// Reads the canvas size and frame count of a JPEG, PNG, WebP, GIF or still
// AVIF from its container headers, so a caller can refuse an image before
// handing it to a decoder that would allocate width x height x frames of
// pixels. Pixels are
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

// Still AVIF is read only in the narrow shape the app's encoders write
// (ImageIO, libavif): one coded av01 item, or a grid of identical av01 tiles.
// The rest of HEIF (alpha and other auxiliary items, sequences, transforms,
// crops, metadata items) is refused, because a decoder could size, crop or
// composite pixels from a part this walk never checked.
const AVIF_MAX_TILES = 64
const AVIF_MAX_ITEMS = AVIF_MAX_TILES + 1
const AVIF_MAX_PROPS = 64
const AV1_MAX_OBUS = 256
// Real hdlr boxes carry an empty or short name; ICC profiles are a few KiB.
const AVIF_MAX_HDLR = 256
const AVIF_MAX_ICC = 262144
const AVIF_MAX_AV1C = 4 + 256
const AVIF_META_CHILDREN = ['hdlr', 'pitm', 'iloc', 'iinf', 'iprp', 'dinf', 'iref', 'idat', 'free', 'skip']
const AVIF_REFUSED_PROPS = ['imir', 'clap', 'auxC', 'lsel', 'a1op', 'a1lx']

// The child boxes of b[start..end), or null. A size of 0 (to the end) or 1
// (64-bit largesize) is refused with every other size under 8, each box must
// end inside the parent and no byte may be left over. The one exception, for
// the top level only (largeMdat): ImageIO writes its mdat with a largesize,
// accepted when it fits 32 bits and runs exactly to the end of the file.
function isoBoxes (b, start, end, max, largeMdat) {
  const out = []
  let p = start
  while (p < end) {
    if (out.length >= max || end - p < 8) return null
    const size = be32(b, p)
    if (size === 1 && largeMdat && fourcc(b, p + 4) === 'mdat' && end - p >= 16 && be32(b, p + 8) === 0) {
      const large = be32(b, p + 12)
      if (large < 16 || large !== end - p) return null
      out.push({ type: 'mdat', body: p + 16, end })
      p = end
      continue
    }
    if (size < 8 || size > end - p) return null
    out.push({ type: fourcc(b, p + 4), body: p + 8, end: p + size })
    p += size
  }
  return out
}

function fullBoxHeader (b, box) {
  if (box.end - box.body < 4) return null
  return { version: b[box.body], flags: be32(b, box.body) & 0xffffff }
}

function isAvif (b) {
  const n = b.length
  if (n < 16 || fourcc(b, 4) !== 'ftyp') return false
  const size = be32(b, 0)
  if (size < 16 || size > 16 + 4 * 32 || size % 4 !== 0 || size > n) return false
  const major = fourcc(b, 8)
  const brands = []
  for (let p = 16; p < size; p += 4) brands.push(fourcc(b, p))
  if (major === 'avis' || brands.includes('avis')) return false
  return major === 'avif' || (major === 'mif1' && brands.includes('avif'))
}

// A bounded MSB-first bit reader over b[start..end); reading past the end
// sets bad and yields zeros, so the caller checks bad once at the end.
function bitReader (b, start, end) {
  let pos = start * 8
  const limit = end * 8
  const r = {
    bad: false,
    f (n) {
      let v = 0
      for (let i = 0; i < n; i++) {
        if (pos >= limit) {
          r.bad = true
          return 0
        }
        v = v * 2 + ((b[Math.floor(pos / 8)] >> (7 - (pos % 8))) & 1)
        pos++
      }
      return v
    },
    uvlc () {
      let zeros = 0
      while (r.f(1) === 0) {
        if (r.bad || ++zeros >= 32) {
          r.bad = true
          return 0
        }
      }
      return r.f(zeros) + 2 ** zeros - 1
    }
  }
  return r
}

// The fields of an AV1 sequence header OBU payload that the av1C and ispe
// must agree with, and those the frame header syntax depends on, read up to
// the end of color_config; null when it is not profile 0, 8-bit, 4:2:0.
function av1SequenceFields (b, start, end) {
  const r = bitReader(b, start, end)
  const profile = r.f(3)
  const still = r.f(1)
  const reduced = r.f(1)
  if (profile !== 0 || (reduced && !still)) return null
  let level = 0
  let tier = 0
  let decoderModel = 0
  let equalInterval = 0
  let presentationBits = 0
  if (reduced) {
    level = r.f(5)
  } else {
    let delayBits = 0
    if (r.f(1)) {
      r.f(32)
      r.f(32)
      equalInterval = r.f(1)
      if (equalInterval) r.uvlc()
      decoderModel = r.f(1)
      if (decoderModel) {
        delayBits = r.f(5) + 1
        r.f(32)
        r.f(5)
        presentationBits = r.f(5) + 1
      }
    }
    const displayDelay = r.f(1)
    const points = r.f(5) + 1
    for (let i = 0; i < points; i++) {
      r.f(12)
      const lv = r.f(5)
      const t = lv > 7 ? r.f(1) : 0
      if (i === 0) {
        level = lv
        tier = t
      }
      if (decoderModel && r.f(1)) r.f(2 * delayBits + 1)
      if (displayDelay && r.f(1)) r.f(4)
    }
  }
  const widthBits = r.f(4) + 1
  const heightBits = r.f(4) + 1
  const width = r.f(widthBits) + 1
  const height = r.f(heightBits) + 1
  let idBits = 0
  if (!reduced && r.f(1)) idBits = r.f(4) + 2 + r.f(3) + 1
  r.f(3)
  // 2 is SELECT for both, as the frame header reads them.
  let forceScreen = 2
  let forceIntegerMv = 2
  if (!reduced) {
    r.f(4)
    const orderHint = r.f(1)
    if (orderHint) r.f(2)
    forceScreen = r.f(1) ? 2 : r.f(1)
    if (forceScreen > 0 && !r.f(1)) forceIntegerMv = r.f(1)
    if (orderHint) r.f(3)
  }
  r.f(3)
  const highBitdepth = r.f(1)
  const mono = r.f(1)
  let primaries = 2
  let transfer = 2
  let matrix = 2
  if (r.f(1)) {
    primaries = r.f(8)
    transfer = r.f(8)
    matrix = r.f(8)
  }
  // sRGB with the identity matrix is coded 4:4:4, which profile 0 cannot carry.
  if (highBitdepth || mono || (primaries === 1 && transfer === 13 && matrix === 0)) return null
  r.f(4)
  r.f(1)
  if (r.bad) return null
  return { level, tier, width, height, reduced, decoderModel, equalInterval, presentationBits, idBits, forceScreen, forceIntegerMv }
}

// The frame is coded at the sequence header's maximum size only when
// frame_size_override_flag is 0, so the uncompressed header is read up to it.
// Only a shown key frame is a still image.
function av1FrameAtMaxSize (b, start, end, seq) {
  if (seq.reduced) return true
  const r = bitReader(b, start, end)
  if (r.f(1) !== 0 || r.f(2) !== 0 || r.f(1) !== 1) return false
  if (seq.decoderModel && !seq.equalInterval) r.f(seq.presentationBits)
  r.f(1)
  const screen = seq.forceScreen === 2 ? r.f(1) : seq.forceScreen
  if (screen && seq.forceIntegerMv === 2) r.f(1)
  if (seq.idBits) r.f(seq.idBits)
  return r.f(1) === 0 && !r.bad
}

// Every OBU of an av01 item's data b[start..end): an optional empty temporal
// delimiter, the sequence header, then exactly one shown key frame (a frame
// OBU, or a frame header OBU and tile groups), with metadata, padding and
// byte-identical copies of the sequence header allowed around it. Each OBU
// has a size field and no extension header, and together they fill the
// extent. Returns the sequence fields plus the sequence header OBU's range.
function av1Item (b, start, end) {
  let p = start
  let seq = null
  let frames = 0
  for (let i = 0; p < end; i++) {
    if (i >= AV1_MAX_OBUS || (b[p] & 0x87) !== 0x02) return null
    const type = (b[p] >> 3) & 0x0f
    let q = p + 1
    let size = 0
    let k = 0
    for (; k < 4; k++) {
      if (q >= end) return null
      const x = b[q++]
      size += (x & 0x7f) * 2 ** (7 * k)
      if ((x & 0x80) === 0) break
    }
    if (k === 4 || size > end - q) return null
    const next = q + size
    if (type === 2) {
      if (i !== 0 || size !== 0) return null
    } else if (seq === null) {
      if (type !== 1) return null
      seq = av1SequenceFields(b, q, next)
      if (seq === null) return null
      seq.obu = { body: p, end: next }
    } else if (type === 1) {
      if (!sameBytes(b, seq.obu, { body: p, end: next })) return null
    } else if (type === 3 || type === 6) {
      if (++frames > 1 || !av1FrameAtMaxSize(b, q, next, seq)) return null
    } else if (type === 4) {
      if (frames === 0) return null
    } else if (type !== 5 && type !== 15) {
      return null
    }
    p = next
  }
  return frames === 1 ? seq : null
}

function avifProperty (b, box) {
  const { type, body, end } = box
  const len = end - body
  if (AVIF_REFUSED_PROPS.includes(type)) return null
  if (type === 'ispe') {
    if (len !== 12 || be32(b, body) !== 0) return null
    const width = be32(b, body + 4)
    const height = be32(b, body + 8)
    if (width < 1 || height < 1) return null
    return { type, width, height }
  }
  if (type === 'av1C') {
    // marker and version 1, seq_profile 0; high_bitdepth, twelve_bit and
    // monochrome clear with both chroma subsampling bits set is 8-bit 4:2:0.
    if (len < 4 || len > AVIF_MAX_AV1C || b[body] !== 0x81 || (b[body + 1] >> 5) !== 0) return null
    if ((b[body + 2] & 0x7c) !== 0x0c || (b[body + 3] & 0xe0) !== 0) return null
    return { type, level: b[body + 1] & 0x1f, tier: b[body + 2] >> 7, body, end }
  }
  if (type === 'colr') {
    if (len < 4) return null
    const kind = fourcc(b, body)
    if (kind === 'nclx') return len === 11 && (b[body + 10] & 0x7f) === 0 ? { type } : null
    if ((kind === 'prof' || kind === 'rICC') && len > 4 && len <= 4 + AVIF_MAX_ICC) return { type }
    return null
  }
  if (type === 'pixi') {
    const ok = len === 8 && be32(b, body) === 0 && b[body + 4] === 3 && b[body + 5] === 8 && b[body + 6] === 8 && b[body + 7] === 8
    return ok ? { type } : null
  }
  if (type === 'clli') return len === 4 ? { type } : null
  if (type === 'irot') return len === 1 && b[body] === 0 ? { type } : null
  return { type, unknown: true }
}

// ipco and ipma: a map from item id to its properties by type, or null.
function avifProperties (b, box, items) {
  const kids = isoBoxes(b, box.body, box.end, 2)
  if (kids === null || kids.length !== 2 || kids[0].type !== 'ipco' || kids[1].type !== 'ipma') return null
  const boxes = isoBoxes(b, kids[0].body, kids[0].end, AVIF_MAX_PROPS)
  if (boxes === null) return null
  const props = []
  for (const x of boxes) {
    const prop = avifProperty(b, x)
    if (prop === null) return null
    props.push(prop)
  }
  const ipma = kids[1]
  const head = fullBoxHeader(b, ipma)
  if (head === null || head.version > 1 || head.flags > 1 || ipma.end - ipma.body < 8) return null
  const count = be32(b, ipma.body + 4)
  if (count > AVIF_MAX_ITEMS) return null
  const idLen = head.version === 0 ? 2 : 4
  const wide = head.flags === 1
  const out = new Map()
  let p = ipma.body + 8
  for (let i = 0; i < count; i++) {
    if (ipma.end - p < idLen + 1) return null
    const id = idLen === 2 ? be16(b, p) : be32(b, p)
    p += idLen
    const n = b[p++]
    if (ipma.end - p < n * (wide ? 2 : 1)) return null
    if (!items.has(id) || out.has(id)) return null
    const assoc = Object.create(null)
    for (let k = 0; k < n; k++) {
      const x = wide ? be16(b, p) : b[p]
      p += wide ? 2 : 1
      const essential = wide ? x >> 15 : x >> 7
      const index = wide ? x & 0x7fff : x & 0x7f
      if (index === 0) {
        if (essential) return null
        continue
      }
      if (index > props.length) return null
      const prop = props[index - 1]
      // An unknown property tied to an item is refused, essential or not: a
      // decoder may apply a transformative one (iscl) whatever the bit says.
      if (assoc[prop.type] !== undefined || prop.unknown) return null
      assoc[prop.type] = prop
    }
    out.set(id, assoc)
  }
  if (p !== ipma.end) return null
  return out
}

// iinf: a map from item id to { type, hidden }, or null.
function avifItems (b, box) {
  const head = fullBoxHeader(b, box)
  if (head === null || head.version > 1 || head.flags !== 0) return null
  const countLen = head.version === 0 ? 2 : 4
  if (box.end - box.body < 4 + countLen) return null
  const count = countLen === 2 ? be16(b, box.body + 4) : be32(b, box.body + 4)
  if (count < 1 || count > AVIF_MAX_ITEMS) return null
  const kids = isoBoxes(b, box.body + 4 + countLen, box.end, AVIF_MAX_ITEMS)
  if (kids === null || kids.length !== count) return null
  const items = new Map()
  for (const k of kids) {
    const infe = fullBoxHeader(b, k)
    if (k.type !== 'infe' || infe === null || (infe.version !== 2 && infe.version !== 3) || infe.flags > 1) return null
    const idLen = infe.version === 2 ? 2 : 4
    let p = k.body + 4
    if (k.end - p < idLen + 7) return null
    const id = idLen === 2 ? be16(b, p) : be32(b, p)
    p += idLen
    if (be16(b, p) !== 0) return null
    const type = fourcc(b, p + 2)
    p += 6
    // The item name, then nothing: no content_type or uri for these types.
    while (p < k.end && b[p] !== 0) p++
    if (p !== k.end - 1 || id === 0 || items.has(id)) return null
    items.set(id, { type, hidden: infe.flags === 1 })
  }
  return items
}

// iloc: a map from item id to its single extent { method, offset, length }.
function avifLocations (b, box) {
  const head = fullBoxHeader(b, box)
  if (head === null || head.version > 1 || head.flags !== 0 || box.end - box.body < 8) return null
  // offset_size 4, length_size 4, base_offset_size 0, index_size 0
  if (b[box.body + 4] !== 0x44 || b[box.body + 5] !== 0) return null
  const count = be16(b, box.body + 6)
  const entry = head.version === 0 ? 14 : 16
  if (count < 1 || count > AVIF_MAX_ITEMS || box.end - box.body - 8 !== count * entry) return null
  const locs = new Map()
  let p = box.body + 8
  for (let i = 0; i < count; i++) {
    const id = be16(b, p)
    p += 2
    let method = 0
    if (head.version === 1) {
      method = be16(b, p)
      p += 2
      if (method > 1) return null
    }
    // data_reference_index 0 (this file), extent_count 1
    if (be16(b, p) !== 0 || be16(b, p + 2) !== 1) return null
    const offset = be32(b, p + 4)
    const length = be32(b, p + 8)
    p += 12
    if (length < 1 || locs.has(id)) return null
    locs.set(id, { method, offset, length })
  }
  return locs
}

// iref of a grid: one dimg from the grid item to every other item, each once.
function avifGridTiles (b, box, items, primary) {
  const head = fullBoxHeader(b, box)
  if (head === null || head.version !== 0 || head.flags !== 0) return null
  const refs = isoBoxes(b, box.body + 4, box.end, 1)
  if (refs === null || refs.length !== 1 || refs[0].type !== 'dimg') return null
  const r = refs[0]
  if (r.end - r.body < 4) return null
  const count = be16(b, r.body + 2)
  if (be16(b, r.body) !== primary || count < 2 || count > AVIF_MAX_TILES || count !== items.size - 1) return null
  if (r.end - r.body !== 4 + 2 * count) return null
  const tiles = []
  for (let i = 0; i < count; i++) {
    const id = be16(b, r.body + 4 + 2 * i)
    const item = items.get(id)
    if (item === undefined || item.type !== 'av01' || tiles.includes(id)) return null
    tiles.push(id)
  }
  return tiles
}

function avifHandler (b, box) {
  const head = fullBoxHeader(b, box)
  return head !== null && head.version === 0 && head.flags === 0 && box.end - box.body >= 24 && box.end - box.body <= AVIF_MAX_HDLR && fourcc(b, box.body + 8) === 'pict'
}

// dinf: one dref holding one self-contained 'url ' entry.
function avifDinf (b, box) {
  const kids = isoBoxes(b, box.body, box.end, 1)
  if (kids === null || kids.length !== 1 || kids[0].type !== 'dref') return false
  const dref = kids[0]
  if (dref.end - dref.body < 8 || be32(b, dref.body) !== 0 || be32(b, dref.body + 4) !== 1) return false
  const entries = isoBoxes(b, dref.body + 8, dref.end, 1)
  if (entries === null || entries.length !== 1 || entries[0].type !== 'url ') return false
  return entries[0].end - entries[0].body === 4 && be32(b, entries[0].body) === 1
}

function sameBytes (b, x, y) {
  if (x.body === y.body && x.end === y.end) return true
  if (x.end - x.body !== y.end - y.body) return false
  for (let i = 0; i < x.end - x.body; i++) if (b[x.body + i] !== b[y.body + i]) return false
  return true
}

function avifBounds (b, cap) {
  if (!isAvif(b)) return null
  const top = isoBoxes(b, 0, b.length, MAX_PARTS, true)
  if (top === null || top[0].type !== 'ftyp') return null
  let meta = null
  let mdat = null
  for (let i = 1; i < top.length; i++) {
    const t = top[i].type
    if (t === 'meta' && meta === null) meta = top[i]
    else if (t === 'mdat' && mdat === null) mdat = top[i]
    else if (t !== 'free' && t !== 'skip') return null
  }
  if (meta === null || mdat === null) return null
  const metaHead = fullBoxHeader(b, meta)
  if (metaHead === null || metaHead.version !== 0 || metaHead.flags !== 0) return null
  const kids = isoBoxes(b, meta.body + 4, meta.end, AVIF_META_CHILDREN.length)
  if (kids === null) return null
  const m = Object.create(null)
  for (const k of kids) {
    if (!AVIF_META_CHILDREN.includes(k.type) || m[k.type] !== undefined) return null
    m[k.type] = k
  }
  if (!m.hdlr || !m.pitm || !m.iloc || !m.iinf || !m.iprp) return null
  if (!avifHandler(b, m.hdlr) || (m.dinf && !avifDinf(b, m.dinf))) return null
  if (m.pitm.end - m.pitm.body !== 6 || be32(b, m.pitm.body) !== 0) return null
  const primary = be16(b, m.pitm.body + 4)
  const items = avifItems(b, m.iinf)
  if (items === null) return null
  const locs = avifLocations(b, m.iloc)
  const props = avifProperties(b, m.iprp, items)
  if (locs === null || props === null || locs.size !== items.size) return null
  const main = items.get(primary)
  if (main === undefined || main.hidden) return null
  let tiles
  if (main.type === 'av01') {
    if (items.size !== 1 || m.iref || m.idat) return null
    tiles = [primary]
  } else if (main.type === 'grid') {
    if (!m.iref || !m.idat) return null
    tiles = avifGridTiles(b, m.iref, items, primary)
    if (tiles === null) return null
  } else {
    return null
  }

  const extents = []
  for (const id of items.keys()) {
    const loc = locs.get(id)
    if (loc === undefined) return null
    const assoc = props.get(id) || Object.create(null)
    if (id === primary && main.type === 'grid') {
      if (loc.method !== 1 || loc.offset > m.idat.end - m.idat.body || loc.length > m.idat.end - m.idat.body - loc.offset) return null
      if (assoc.av1C) return null
      continue
    }
    if (loc.method !== 0 || loc.offset < mdat.body || loc.offset > mdat.end || loc.length > mdat.end - loc.offset) return null
    extents.push(loc)
    if (!assoc.ispe || !assoc.av1C) return null
    const seq = av1Item(b, loc.offset, loc.offset + loc.length)
    if (seq === null || seq.width !== assoc.ispe.width || seq.height !== assoc.ispe.height) return null
    if (seq.level !== assoc.av1C.level || seq.tier !== assoc.av1C.tier) return null
    // configOBUs, when present, must be this item's own sequence header.
    const config = { body: assoc.av1C.body + 4, end: assoc.av1C.end }
    if (config.end > config.body && !sameBytes(b, config, seq.obu)) return null
  }
  extents.sort((x, y) => x.offset - y.offset)
  for (let i = 1; i < extents.length; i++) {
    if (extents[i].offset < extents[i - 1].offset + extents[i - 1].length) return null
  }

  const first = props.get(tiles[0])
  const tw = first.ispe.width
  const th = first.ispe.height
  // Each tile is decoded at its own size before the grid crops it.
  if (tw > cap.dimension || th > cap.dimension || tw * th > cap.pixels) return null
  if (main.type === 'av01') return bounded(tw, th, 1, cap)

  for (const id of tiles) {
    const assoc = props.get(id)
    if (assoc.ispe.width !== tw || assoc.ispe.height !== th || !sameBytes(b, assoc.av1C, first.av1C)) return null
  }
  const loc = locs.get(primary)
  const g = m.idat.body + loc.offset
  const wide = b[g + 1]
  if (b[g] !== 0 || wide > 1 || loc.length !== (wide ? 12 : 8)) return null
  const rows = b[g + 2] + 1
  const cols = b[g + 3] + 1
  const width = wide ? be32(b, g + 4) : be16(b, g + 4)
  const height = wide ? be32(b, g + 8) : be16(b, g + 6)
  if (rows * cols !== tiles.length) return null
  if (width <= (cols - 1) * tw || width > cols * tw || height <= (rows - 1) * th || height > rows * th) return null
  const gridIspe = (props.get(primary) || {}).ispe
  if (gridIspe && (gridIspe.width !== width || gridIspe.height !== height)) return null
  // A decoder holds every tile before it crops to the output size.
  if (tiles.length * tw * th > cap.total) return null
  return bounded(width, height, 1, cap)
}

const PARSERS = {
  'image/jpeg': jpegBounds,
  'image/png': pngBounds,
  'image/webp': webpBounds,
  'image/gif': gifBounds,
  'image/avif': avifBounds
}

function sniff (b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && fourcc(b, 0) === 'RIFF' && fourcc(b, 8) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && fourcc(b, 0) === 'GIF8') return 'image/gif'
  if (isAvif(b)) return 'image/avif'
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
