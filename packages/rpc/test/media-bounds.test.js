'use strict'

const test = require('brittle')
const { mediaBounds, mediaSize, MAX_MEDIA_PIXELS, MAX_MEDIA_FRAMES, MAX_MEDIA_TOTAL_PIXELS, MAX_MEDIA_DIMENSION } = require('..')

function bytes (...parts) {
  const out = []
  for (const part of parts) {
    if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0))
    else if (typeof part === 'number') out.push(part)
    else for (const b of part) out.push(b)
  }
  return new Uint8Array(out)
}

const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const le16 = (v) => [v & 0xff, (v >>> 8) & 0xff]
const le24 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

function jpeg (w, h) {
  return bytes(0xff, 0xd8,
    0xff, 0xe0, be16(16), 'JFIF', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, be16(17), 8, be16(h), be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, be16(2), 0xff, 0xd9)
}

function pngChunk (id, data) {
  return [...be32(data.length), ...bytes(id), ...data, 0, 0, 0, 0]
}

function png (w, h, frames) {
  const ihdr = [...be32(w), ...be32(h), 8, 6, 0, 0, 0]
  const parts = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', ihdr)]
  if (frames !== undefined) parts.push(...pngChunk('acTL', [...be32(frames), ...be32(0)]))
  parts.push(...pngChunk('IDAT', [1, 2, 3]), ...pngChunk('IEND', []))
  return bytes(parts)
}

// An APNG with one fcTL per entry of rects ([x, y, w, h]); opts.declared
// overrides the acTL frame count and opts.noEnd drops IEND.
function apng (w, h, rects, opts = {}) {
  const ihdr = [...be32(w), ...be32(h), 8, 6, 0, 0, 0]
  const declared = opts.declared === undefined ? rects.length : opts.declared
  const parts = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', ihdr),
    ...pngChunk('acTL', [...be32(declared), ...be32(0)])]
  let seq = 0
  rects.forEach(([x, y, fw, fh], i) => {
    parts.push(...pngChunk('fcTL', [...be32(seq++), ...be32(fw), ...be32(fh), ...be32(x), ...be32(y), ...be16(1), ...be16(10), 0, 0]))
    if (i === 0) parts.push(...pngChunk('IDAT', [1, 2, 3]))
    else parts.push(...pngChunk('fdAT', [...be32(seq++), 1, 2, 3]))
  })
  if (rects.length === 0) parts.push(...pngChunk('IDAT', [1, 2, 3]))
  if (!opts.noEnd) parts.push(...pngChunk('IEND', []))
  return bytes(parts)
}

function riff (chunks) {
  const body = [...bytes('WEBP')]
  for (const [id, data] of chunks) {
    body.push(...bytes(id), ...le32(data.length), ...data)
    if (data.length & 1) body.push(0)
  }
  return bytes('RIFF', le32(body.length), body)
}

function webpLossless (w, h) {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return riff([['VP8L', [0x2f, ...le32(v >>> 0), 0, 0, 0]]])
}

function vp8lChunk (w, h) {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return [...bytes('VP8L'), ...le32(8), 0x2f, ...le32(v >>> 0), 0, 0, 0]
}

function vp8Chunk (w, h) {
  return [...bytes('VP8 '), ...le32(10), 0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]
}

function anmf (fw, fh, payload) {
  return ['ANMF', [...le24(0), ...le24(0), ...le24(fw - 1), ...le24(fh - 1), ...le24(100), 0, ...payload]]
}

function webpAnimated (w, h, frames, payload) {
  const chunks = [['VP8X', [0x02, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]], ['ANIM', [0, 0, 0, 0, 0, 0]]]
  for (let i = 0; i < frames; i++) chunks.push(anmf(w, h, payload || vp8lChunk(w, h)))
  return riff(chunks)
}

function gif (w, h, frames, opts = {}) {
  const parts = [...bytes('GIF89a'), ...le16(w), ...le16(h), 0x80, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < frames; i++) {
    parts.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0)
    const fw = opts.frameW || w
    const fh = opts.frameH || h
    parts.push(0x2c, ...le16(0), ...le16(0), ...le16(fw), ...le16(fh), 0, 2, 2, 0x4c, 0x01, 0)
  }
  if (!opts.noTrailer) parts.push(0x3b)
  return bytes(parts)
}

test('reads ordinary images in every format', (t) => {
  t.alike(mediaBounds(jpeg(640, 480), 'image/jpeg'), { width: 640, height: 480, frames: 1 })
  t.alike(mediaBounds(png(300, 200), 'image/png'), { width: 300, height: 200, frames: 1 })
  t.alike(mediaBounds(png(300, 200, 12), 'image/png'), { width: 300, height: 200, frames: 12 })
  t.alike(mediaBounds(webpLossless(100, 50), 'image/webp'), { width: 100, height: 50, frames: 1 })
  t.alike(mediaBounds(webpAnimated(64, 32, 3), 'image/webp'), { width: 64, height: 32, frames: 3 })
  t.alike(mediaBounds(gif(10, 20, 5), 'image/gif'), { width: 10, height: 20, frames: 5 })
  t.alike(mediaBounds(gif(10, 20, 1)), { width: 10, height: 20, frames: 1 }, 'mime is optional')
})

test('a small file claiming a huge canvas is refused', (t) => {
  t.ok(jpeg(65535, 65535).length < 64)
  t.is(mediaBounds(jpeg(65535, 65535), 'image/jpeg'), null)
  t.is(mediaBounds(jpeg(MAX_MEDIA_DIMENSION + 1, 1), 'image/jpeg'), null, 'one side over the cap')
  t.is(mediaBounds(png(0x7fffffff, 0x7fffffff), 'image/png'), null)
  t.is(mediaBounds(webpAnimated(16777216, 16777216, 1), 'image/webp'), null)
  t.is(mediaBounds(webpLossless(16384, 16384), 'image/webp'), null, 'area over the cap')
  t.is(mediaBounds(gif(65535, 65535, 1), 'image/gif'), null)
  t.is(mediaBounds(gif(10, 10, 1, { frameW: 60000, frameH: 60000 }), 'image/gif'), null,
    'a frame larger than the logical screen counts')
})

test('area bound sits exactly at MAX_MEDIA_PIXELS', (t) => {
  t.is(MAX_MEDIA_PIXELS, 16777216)
  t.alike(mediaBounds(jpeg(4096, 4096), 'image/jpeg'), { width: 4096, height: 4096, frames: 1 })
  t.alike(mediaBounds(jpeg(16384, 1024), 'image/jpeg'), { width: 16384, height: 1024, frames: 1 })
  t.is(mediaBounds(jpeg(16384, 1025), 'image/jpeg'), null)
})

test('a GIF over the frame cap is refused, even with a tiny screen', (t) => {
  t.is(MAX_MEDIA_FRAMES, 300)
  t.alike(mediaBounds(gif(1, 1, 300), 'image/gif'), { width: 1, height: 1, frames: 300 })
  t.is(mediaBounds(gif(1, 1, 301), 'image/gif'), null)
  t.is(mediaBounds(gif(1, 1, 5000, { noTrailer: true }), 'image/gif'), null, 'the walk stops at the cap')
})

test('other formats over the frame cap are refused', (t) => {
  t.is(mediaBounds(png(10, 10, 301), 'image/png'), null)
  t.is(mediaBounds(png(10, 10, 0xffffffff), 'image/png'), null)
  t.alike(mediaBounds(webpAnimated(4, 4, 300), 'image/webp').frames, 300)
  t.is(mediaBounds(webpAnimated(4, 4, 301), 'image/webp'), null)
})

test('a mime that does not match the bytes is refused', (t) => {
  t.is(mediaBounds(jpeg(10, 10), 'image/png'), null)
  t.is(mediaBounds(gif(10, 10, 1), 'image/webp'), null)
  t.is(mediaBounds(png(10, 10), 'image/svg+xml'), null)
  t.is(mediaBounds(bytes('<svg>'), undefined), null)
})

test('every truncation of a valid file is null or the full answer, never a throw', (t) => {
  const files = [jpeg(64, 48), png(30, 20, 4), webpLossless(9, 7), webpAnimated(8, 8, 2), gif(5, 6, 3),
    apng(30, 20, [[0, 0, 30, 20], [5, 5, 10, 10]]), webpAnimated(8, 8, 2, [...bytes('ALPH'), ...le32(1), 0, 0, ...vp8Chunk(8, 8)])]
  let bad = 0
  for (const file of files) {
    const full = mediaBounds(file)
    for (let i = 0; i < file.length; i++) {
      const got = mediaBounds(file.subarray(0, i))
      if (got !== null && JSON.stringify(got) !== JSON.stringify(full)) bad++
    }
  }
  t.is(bad, 0)
  t.is(mediaBounds(gif(5, 6, 3).subarray(0, 30)), null, 'a GIF cut mid-frame')
  t.is(mediaBounds(gif(5, 6, 3, { noTrailer: true })), null, 'a GIF without its trailer')
})

test('hostile shapes end and return null', (t) => {
  t.is(mediaBounds(null), null)
  t.is(mediaBounds('GIF89a'), null)
  t.is(mediaBounds(new Uint8Array(0)), null)
  // JPEG made only of fill bytes and padding segments: the walk must end.
  const fill = new Uint8Array(200000).fill(0xff)
  fill[0] = 0xff; fill[1] = 0xd8
  t.is(mediaBounds(fill, 'image/jpeg'), null)
  const app = [0xff, 0xd8]
  for (let i = 0; i < 5000; i++) app.push(0xff, 0xe1, 0, 2)
  t.is(mediaBounds(bytes(app), 'image/jpeg'), null, 'segment walk is capped')
  // GIF sub-block length pointing past the end.
  t.is(mediaBounds(bytes('GIF89a', le16(1), le16(1), 0, 0, 0, 0x21, 0xff, 255, 1, 2), 'image/gif'), null)
  // RIFF size larger than the buffer.
  t.is(mediaBounds(bytes('RIFF', le32(0xffffffff), 'WEBP'), 'image/webp'), null)
  // PNG chunk length larger than the buffer.
  const p = png(10, 10)
  const cut = bytes([...p.subarray(0, 33), ...be32(0xfffffff0), ...bytes('IDAT')])
  t.is(mediaBounds(cut, 'image/png'), null)
  // ANMF before VP8X, or outside the canvas.
  t.is(mediaBounds(riff([['ANMF', new Array(16).fill(0)]]), 'image/webp'), null)
  const outside = riff([['VP8X', [0x02, 0, 0, 0, ...le24(3), ...le24(3)]],
    ['ANMF', [...le24(0), ...le24(0), ...le24(99), ...le24(99), ...le24(1), 0]]])
  t.is(mediaBounds(outside, 'image/webp'), null)
  // Random bytes behind every magic never throw.
  let seed = 7
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16 & 0xff }
  // The APNG head reaches the fcTL walk; the animated WebP head reaches the
  // ANMF bitstream reader.
  const apngHead = [...apng(16, 16, [[0, 0, 16, 16]]).subarray(0, 33 + 20)]
  const anmfHead = [...bytes('RIFF'), 64, 0, 0, 0, ...bytes('WEBP', 'VP8X'), ...le32(10), 0x02, 0, 0, 0, ...le24(15), ...le24(15),
    ...bytes('ANMF'), 40, 0, 0, 0, ...le24(0), ...le24(0), ...le24(15), ...le24(15), ...le24(1), 0]
  const heads = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [...bytes('RIFF'), 64, 0, 0, 0, ...bytes('WEBP')], [...bytes('GIF89a')],
    apngHead, anmfHead]
  let threw = 0
  for (let round = 0; round < 6000; round++) {
    const head = heads[round % heads.length]
    const b = new Uint8Array(head.length + (round % 97))
    b.set(head)
    for (let i = head.length; i < b.length; i++) b[i] = rand()
    try {
      const r = mediaBounds(b)
      if (r !== null && (r.width > MAX_MEDIA_DIMENSION || r.height > MAX_MEDIA_DIMENSION || r.frames > MAX_MEDIA_FRAMES ||
        r.width * r.height * r.frames > MAX_MEDIA_TOTAL_PIXELS)) threw++
    } catch { threw++ }
  }
  t.is(threw, 0)
})

test('pixels across every frame are bounded by MAX_MEDIA_TOTAL_PIXELS', (t) => {
  t.is(MAX_MEDIA_TOTAL_PIXELS, 67108864)
  t.alike(mediaBounds(gif(640, 480, 218), 'image/gif'), { width: 640, height: 480, frames: 218 })
  t.is(mediaBounds(gif(640, 480, 219), 'image/gif'), null)
  t.alike(mediaBounds(webpAnimated(4096, 4096, 4), 'image/webp').frames, 4, 'exactly at the bound')
  t.is(mediaBounds(webpAnimated(4096, 4096, 5), 'image/webp'), null)
  t.is(mediaBounds(png(4096, 4096, 300), 'image/png'), null)
  t.is(mediaBounds(apng(4096, 4096, [[0, 0, 4096, 4096]], { declared: 300 }), 'image/png'), null)
})

test('APNG frame rectangles and fcTL count are checked up to IEND', (t) => {
  t.alike(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [10, 5, 20, 15]]), 'image/png'), { width: 30, height: 20, frames: 2 })
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [11, 0, 20, 20]]), 'image/png'), null, 'a frame past the right edge')
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [0, 1, 30, 20]]), 'image/png'), null, 'a frame past the bottom edge')
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [0, 0, 0, 20]]), 'image/png'), null, 'a frame of zero width')
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [0, 0, 30, 0]]), 'image/png'), null, 'a frame of zero height')
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [0xffffffff, 0, 30, 20]]), 'image/png'), null, 'an offset that would wrap')
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [0, 0, 30, 20], [0, 0, 30, 20]], { declared: 2 }), 'image/png'), null,
    'more fcTL than acTL declares')
  const many = []
  for (let i = 0; i < MAX_MEDIA_FRAMES + 1; i++) many.push([0, 0, 1, 1])
  t.is(mediaBounds(apng(1, 1, many, { declared: MAX_MEDIA_FRAMES }), 'image/png'), null, 'more fcTL than the frame cap')
  t.is(mediaBounds(apng(30, 20, [[0, 0, 30, 20], [0, 0, 30, 20]], { noEnd: true }), 'image/png'), null, 'no IEND')
  t.alike(mediaBounds(png(30, 20), 'image/png'), { width: 30, height: 20, frames: 1 }, 'a plain PNG still stops at IDAT')
})

test('animated WebP frame bitstreams must match the ANMF frame size', (t) => {
  t.alike(mediaBounds(webpAnimated(16, 8, 2, vp8Chunk(16, 8)), 'image/webp'), { width: 16, height: 8, frames: 2 }, 'VP8')
  const alph = [...bytes('ALPH'), ...le32(3), 0, 0, 0, 0]
  t.alike(mediaBounds(webpAnimated(16, 8, 1, [...alph, ...vp8Chunk(16, 8)]), 'image/webp').frames, 1, 'ALPH then VP8')
  t.is(mediaBounds(webpAnimated(16, 8, 1, vp8lChunk(4096, 4096)), 'image/webp'), null, 'a VP8L larger than the frame')
  t.is(mediaBounds(webpAnimated(16, 8, 1, vp8Chunk(15, 8)), 'image/webp'), null, 'a VP8 of another size')
  t.is(mediaBounds(webpAnimated(16, 8, 1, []), 'image/webp'), null, 'no bitstream')
  t.is(mediaBounds(webpAnimated(16, 8, 1, alph), 'image/webp'), null, 'ALPH alone')
  t.is(mediaBounds(webpAnimated(16, 8, 1, [...alph, ...vp8lChunk(16, 8)]), 'image/webp'), null, 'ALPH before VP8L')
  t.is(mediaBounds(webpAnimated(16, 8, 1, [...bytes('VP8L'), ...le32(2), 0x2f, 0]), 'image/webp'), null, 'an unreadable VP8L')
  t.is(mediaBounds(webpAnimated(16, 8, 1, [...bytes('VP8L'), ...le32(99), 0x2f, 0, 0, 0, 0]), 'image/webp'), null,
    'a bitstream longer than the frame')
})

// A camera JPEG: APP1 (EXIF) and APP2 (ICC) segments of near-maximum length
// before the frame header, which may be progressive (SOF2).
function cameraJpeg (w, h, sof = 0xc0) {
  const app = (marker, fill) => [0xff, marker, ...be16(65533), ...new Array(65531).fill(fill)]
  return bytes(0xff, 0xd8,
    app(0xe1, 0x45), app(0xe2, 0x49), app(0xe2, 0x49),
    0xff, sof, be16(17), 8, be16(h), be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, be16(2), 0xff, 0xd9)
}

test('mediaSize reads the header size with no size bound', (t) => {
  t.alike(mediaSize(jpeg(8000, 6000), 'image/jpeg'), { width: 8000, height: 6000, frames: 1 }, 'a 48 MP JPEG, past mediaBounds')
  t.is(mediaBounds(jpeg(8000, 6000), 'image/jpeg'), null, 'mediaBounds still refuses it')
  t.alike(mediaSize(png(23000, 23000), 'image/png'), { width: 23000, height: 23000, frames: 1 }, 'a huge PNG header is reported, not refused')
  t.alike(mediaSize(png(0x7fffffff, 1)), { width: 0x7fffffff, height: 1, frames: 1 }, 'no dimension bound either; the mime is optional')
  t.alike(mediaSize(webpLossless(16384, 16384), 'image/webp'), { width: 16384, height: 16384, frames: 1 })
  t.alike(mediaSize(gif(65535, 65535, 1), 'image/gif'), { width: 65535, height: 65535, frames: 1 })
  t.alike(mediaSize(cameraJpeg(8064, 6048), 'image/jpeg'), { width: 8064, height: 6048, frames: 1 }, 'EXIF and ICC before the SOF')
  t.alike(mediaSize(cameraJpeg(4032, 3024, 0xc2), 'image/jpeg'), { width: 4032, height: 3024, frames: 1 }, 'a progressive JPEG')
})

test('a JPEG marker a decoder does not skip by length is refused', (t) => {
  const hidden = [0xff, 0xc0, ...be16(17), 8, ...be16(23000), ...be16(23000), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]
  const decoy = [0xff, 0xc0, ...be16(17), 8, ...be16(16), ...be16(16), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]
  // FF 00 is a stuffed zero to libjpeg, which then finds the hidden frame header.
  const wrapped = bytes(0xff, 0xd8, 0xff, 0x00, be16(2 + hidden.length), hidden, decoy, 0xff, 0xd9)
  t.is(mediaSize(wrapped, 'image/jpeg'), null, 'mediaSize')
  t.is(mediaBounds(wrapped, 'image/jpeg'), null, 'mediaBounds')
  for (const marker of [0x02, 0xbf, 0xc8, 0xde, 0xdf, 0xf0, 0xfd]) {
    t.is(mediaSize(bytes(0xff, 0xd8, 0xff, marker, be16(4), 0, 0, decoy, 0xff, 0xd9), 'image/jpeg'), null, 'marker ' + marker.toString(16))
  }
  const tables = [
    0xff, 0xe0, ...be16(16), ...bytes('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xfe, ...be16(5), 0x61, 0x62, 0x63,
    0xff, 0xdb, ...be16(67), 0, ...new Array(64).fill(1),
    0xff, 0xc4, ...be16(20), 0, ...new Array(16).fill(0), 0,
    0xff, 0xcc, ...be16(4), 0, 0,
    0xff, 0xdd, ...be16(4), 0, 0
  ]
  t.alike(mediaSize(bytes(0xff, 0xd8, tables, decoy, 0xff, 0xda, be16(2), 0xff, 0xd9), 'image/jpeg'), { width: 16, height: 16, frames: 1 }, 'APP0, COM, DQT, DHT, DAC and DRI are still skipped')
})

test('mediaSize keeps the format checks and the walk limits', (t) => {
  t.is(mediaSize(png(30, 20), 'image/jpeg'), null, 'bytes that are not the given mime')
  t.is(mediaSize(new Uint8Array([1, 2, 3])), null, 'no known format')
  t.is(mediaSize('not bytes'), null, 'not a Uint8Array')
  t.is(mediaSize(jpeg(0, 10), 'image/jpeg'), null, 'a zero side')
  t.is(mediaSize(png(30, 20).subarray(0, 40), 'image/png'), null, 'truncated')
  t.is(mediaSize(gif(10, 10, MAX_MEDIA_FRAMES + 1), 'image/gif'), null, 'the frame cap still stops the walk')
  const segments = []
  for (let i = 0; i < 1025; i++) segments.push(0xff, 0xfe, ...be16(2))
  t.is(mediaSize(bytes(0xff, 0xd8, segments, 0xff, 0xc0, be16(17), 8, be16(1), be16(1), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1), 'image/jpeg'), null, 'more segments than the walk allows')
})

const avif = require('./helpers/avif')
const samples = require('./helpers/avif-samples')

// ImageIO samples as captured, with their largesize mdat header.
const imageio = {
  opaque: samples.ios.opaque,
  grid1024x768: samples.imageio.grid1024x768,
  grid1025x769: samples.imageio.grid1025x769,
  grid2048x1536: samples.ios.grid2048x1536
}

const ACCEPTED_AVIF = [
  ['libavif 16x16', samples.libavif.opaque, 16, 16],
  ['libavif 1001x667, odd and without clap', samples.libavif.odd1001x667, 1001, 667],
  ['ImageIO 16x16', imageio.opaque, 16, 16],
  ['ImageIO 1024x768 grid', imageio.grid1024x768, 1024, 768],
  ['ImageIO 1025x769 grid cropped by its output size', imageio.grid1025x769, 1025, 769],
  ['ImageIO 2048x1536 grid', imageio.grid2048x1536, 2048, 1536],
  ['ImageIO 16x16 with a 32-bit mdat header', avif.withoutLargesize(samples.ios.opaque), 16, 16],
  ['ImageIO 1025x769 grid with a 32-bit mdat header', avif.withoutLargesize(samples.imageio.grid1025x769), 1025, 769],
  ['synthetic single item', avif.build(avif.single({ width: 33, height: 17 })), 33, 17],
  ['synthetic 2x2 grid', avif.build(avif.grid()), 128, 128],
  ['synthetic 8x8 grid, the tile cap', avif.build(avif.grid({ rows: 8, cols: 8, tileWidth: 16, tileHeight: 16, width: 120, height: 113 })), 120, 113]
]

test('AVIF: every accepted sample reads its size, one frame', (t) => {
  for (const [name, file, width, height] of ACCEPTED_AVIF) {
    t.alike(mediaBounds(file, 'image/avif'), { width, height, frames: 1 }, name + ' (mediaBounds)')
    t.alike(mediaSize(file, 'image/avif'), { width, height, frames: 1 }, name + ' (mediaSize)')
    t.alike(mediaBounds(file), { width, height, frames: 1 }, name + ' (sniffed)')
  }
  const d = avif.single()
  d.major = 'mif1'
  d.compatible = ['mif1', 'avif']
  t.alike(mediaBounds(avif.build(d), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'major mif1 with avif compatible')
  const free = avif.single()
  free.after = [avif.box('free', 0, 0)]
  t.alike(mediaBounds(avif.build(free), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'a free box at the top level')
  const unknown = avif.single()
  unknown.props.push(avif.box('zzzz', 1, 2))
  unknown.items[0].assoc.push([5, 0])
  t.is(mediaBounds(avif.build(unknown), 'image/avif'), null, 'an unknown property tied to an item is refused, though not essential')
  const iscl = avif.single()
  iscl.props.push(avif.box('iscl', 0, 0, 0, 0, 0xff, 0xff, 0, 1, 0xff, 0xff, 0, 1))
  iscl.items[0].assoc.push([5, 0])
  t.is(mediaBounds(avif.build(iscl), 'image/avif'), null, 'a non-essential iscl (scaling) is refused')
  const unused = avif.single()
  unused.props.push(avif.box('zzzz', 1, 2))
  t.alike(mediaBounds(avif.build(unused), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'an unknown property no item uses is ignored')
})

test('AVIF: ImageIO files are read as captured, largesize mdat included', (t) => {
  t.alike(mediaBounds(samples.ios.opaque, 'image/avif'), { width: 16, height: 16, frames: 1 }, 'ImageIO 16x16')
  t.alike(mediaBounds(samples.imageio.grid1024x768, 'image/avif'), { width: 1024, height: 768, frames: 1 }, 'ImageIO grid')
  t.alike(mediaSize(samples.ios.grid2048x1536, 'image/avif'), { width: 2048, height: 1536, frames: 1 }, 'ImageIO grid (mediaSize)')
})

test('AVIF: refused shapes from the real encoders', (t) => {
  t.is(mediaBounds(samples.ios.alpha, 'image/avif'), null, 'ImageIO alpha: auxl item with auxC')
  t.is(mediaBounds(samples.libavif.alpha, 'image/avif'), null, 'libavif alpha: auxl item with auxC')
})

function refused (t, file, name) {
  t.is(mediaBounds(file, 'image/avif'), null, name)
  t.is(mediaSize(file), null, name + ' (mediaSize)')
}

// The sequence header OBU and the frame OBU that sequenceHeader() writes.
function obus (o) {
  const all = avif.sequenceHeader({ width: 16, height: 16, ...o })
  const n = 2 + all[1]
  return { seq: all.slice(0, n), frame: all.slice(n) }
}

function withData (data) {
  const d = avif.single()
  d.items[0].data = data
  return avif.build(d)
}

test('AVIF: brands and top-level boxes', (t) => {
  const brands = (major, compatible) => {
    const d = avif.single()
    d.major = major
    d.compatible = compatible
    return avif.build(d)
  }
  refused(t, brands('avis', ['avis', 'avif', 'mif1']), 'avis major')
  refused(t, brands('avif', ['avif', 'avis', 'mif1']), 'avis compatible')
  refused(t, brands('mif1', ['mif1', 'heic']), 'mif1 without avif')
  const d = avif.single()
  d.before = [avif.box('moov', avif.box('mvhd', 0))]
  refused(t, avif.build(d), 'moov at the top level')
  const twoMeta = avif.single()
  twoMeta.between = [avif.fullBox('meta', 0, 0, avif.fullBox('hdlr', 0, 0, avif.be32(0), 'pict', new Array(13).fill(0)))]
  refused(t, avif.build(twoMeta), 'two meta')
  const twoMdat = avif.single()
  twoMdat.after = [avif.box('mdat', 1, 2, 3)]
  refused(t, avif.build(twoMdat), 'two mdat')
  const zero = avif.single()
  zero.mdatHeader = 'zero'
  refused(t, avif.build(zero), 'size 0')
  const file = avif.build(avif.single())
  refused(t, new Uint8Array([...file, 0]), 'one trailing byte')
  refused(t, new Uint8Array([...file, 0, 0, 0, 0, 0, 0, 0, 0]), 'trailing zeros')
})

test('AVIF: a largesize only on the one mdat, in 32 bits, to the end of the file', (t) => {
  const large = (edit) => {
    const d = avif.single()
    d.mdatHeader = 'largesize'
    edit(d)
    return avif.build(d)
  }
  t.alike(mediaBounds(large(() => {}), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'a largesize mdat to the end')
  refused(t, large((d) => { d.largeHigh = 1 }), 'a largesize with its high 32 bits set')
  refused(t, large((d) => { d.largeDelta = 1 }), 'a largesize past the end of the file')
  refused(t, large((d) => { d.largeDelta = -1 }), 'a largesize short of the end of the file')
  refused(t, large((d) => { d.largeDelta = -(d.items[0].data.length + 8) }), 'a largesize under its own header')
  refused(t, large((d) => { d.after = [avif.box('free', 0)] }), 'a box after a largesize mdat')
  const largeFree = [...avif.be32(1), ...avif.bytes('free'), ...avif.be32(0), ...avif.be32(16)]
  refused(t, large((d) => { d.before = [largeFree] }), 'a largesize on a top-level box other than mdat')
  refused(t, large((d) => { d.metaExtra = [largeFree] }), 'a largesize on a box inside meta')
  const second = [...avif.be32(1), ...avif.bytes('mdat'), ...avif.be32(0), ...avif.be32(17), 0]
  const twoMdat = avif.single()
  twoMdat.after = [second]
  refused(t, avif.build(twoMdat), 'a second mdat with a largesize')
})

test('AVIF: items, references and idat', (t) => {
  const second = avif.single()
  second.items.push({ ...second.items[0], id: 2 })
  refused(t, avif.build(second), 'a second av01 item in single mode')
  const exif = avif.single()
  exif.items.push({ id: 2, type: 'Exif', data: [0, 0, 0, 0, 0x4d, 0x4d] })
  refused(t, avif.build(exif), 'an Exif item')
  const gridExif = avif.grid()
  gridExif.items.push({ id: 9, type: 'Exif', data: [0, 0, 0, 0, 0x4d, 0x4d] })
  refused(t, avif.build(gridExif), 'an Exif item beside a grid')
  const alpha = avif.single()
  alpha.items.push({ ...alpha.items[0], id: 2 })
  alpha.iref = [{ type: 'auxl', from: 2, to: [1] }]
  refused(t, avif.build(alpha), 'an alpha auxl item')
  const iref = avif.single()
  iref.iref = [{ type: 'cdsc', from: 1, to: [1] }]
  refused(t, avif.build(iref), 'iref in single mode')
  const idat = avif.single()
  idat.idat = [1, 2, 3]
  refused(t, avif.build(idat), 'idat in single mode')
  const hidden = avif.single()
  hidden.items[0].flags = 1
  refused(t, avif.build(hidden), 'a hidden primary item')
  const noPitm = avif.single()
  noPitm.primary = 2
  refused(t, avif.build(noPitm), 'pitm naming no item')
})

test('AVIF: extents', (t) => {
  const past = avif.single()
  past.extent = (i, [offset, length]) => [offset, length + 1]
  refused(t, avif.build(past), 'an extent past the mdat payload')
  const meta = avif.single()
  meta.extent = (i, [offset, length], layout) => [layout.metaStart, length]
  refused(t, avif.build(meta), 'an extent pointing into meta')
  const header = avif.single()
  header.extent = (i, [offset, length]) => [offset - 8, length]
  refused(t, avif.build(header), 'an extent over the mdat header')
  const overlap = avif.grid()
  overlap.extent = (i, abs, layout) => i === 1 ? [layout.mdatStart, abs[1]] : abs
  refused(t, avif.build(overlap), 'overlapping extents')
  const empty = avif.single()
  empty.extent = (i, [offset]) => [offset, 0]
  refused(t, avif.build(empty), 'an empty extent')
})

test('AVIF: grids', (t) => {
  refused(t, avif.build(avif.grid({ rows: 5, cols: 13, tileWidth: 16, tileHeight: 16 })), 'a grid of 65 tiles')
  const size = avif.grid()
  size.props.push(avif.ispe(32, 64))
  size.items[1].assoc = [[7, 1], [1, 1], [5, 1]]
  size.items[1].data = avif.sequenceHeader({ width: 32, height: 64, reduced: false })
  refused(t, avif.build(size), 'tiles of different sizes')
  const config = avif.grid()
  config.props.push(avif.av1C({ delay: 0x10 }))
  config.items[1].assoc = [[2, 1], [1, 1], [7, 1]]
  refused(t, avif.build(config), 'tiles with differing av1C')
  refused(t, avif.build(avif.grid({ rows: 2, cols: 2, tiles: 3 })), 'rows x cols is not the tile count')
  refused(t, avif.build(avif.grid({ width: 129 })), 'output wider than the tiles')
  refused(t, avif.build(avif.grid({ height: 64 })), 'output that leaves a row of tiles unused')
  const ispe = avif.grid()
  ispe.props[2] = avif.ispe(127, 128)
  refused(t, avif.build(ispe), 'a grid ispe that is not the output size')
  const missing = avif.grid()
  missing.iref[0].to = missing.iref[0].to.slice(0, 3)
  refused(t, avif.build(missing), 'dimg missing a tile')
  const twice = avif.grid()
  twice.iref[0].to[3] = twice.iref[0].to[0]
  refused(t, avif.build(twice), 'dimg naming a tile twice')
  const other = avif.grid()
  other.iref.push({ type: 'cdsc', from: 1, to: [5] })
  refused(t, avif.build(other), 'a reference besides dimg')
  const noIdat = avif.grid()
  noIdat.items[4].method = 0
  noIdat.idat = [0]
  refused(t, avif.build(noIdat), 'a grid descriptor outside idat')
  const config1 = avif.grid()
  config1.items[4].assoc.push([5, 1])
  refused(t, avif.build(config1), 'av1C on the grid item')
  // Five tiles each at MAX_MEDIA_PIXELS under a 1x4097 output: small to the eye, 84 M pixels to decode.
  const tall = avif.grid({ rows: 5, cols: 1, tileWidth: 16384, tileHeight: 1024, width: 1, height: 4097 })
  t.is(mediaBounds(avif.build(tall), 'image/avif'), null, 'tile pixels past MAX_MEDIA_TOTAL_PIXELS')
  t.alike(mediaSize(avif.build(tall), 'image/avif'), { width: 1, height: 4097, frames: 1 }, 'mediaSize still reads it')
  refused(t, avif.build(avif.grid({ rows: 1, cols: 1 })), 'a grid of one tile')
  const tileSeq = avif.grid()
  tileSeq.items[1].data = avif.sequenceHeader({ width: 32, height: 64, reduced: false, temporalDelimiter: true })
  refused(t, avif.build(tileSeq), 'a tile whose sequence header alone differs from its ispe')
  const tileIdat = avif.grid()
  tileIdat.items[0].method = 1
  refused(t, avif.build(tileIdat), 'a tile in idat')
  const method2 = avif.grid()
  method2.items[0].method = 2
  refused(t, avif.build(method2), 'a tile with construction method 2')
  const descriptor = (edit) => {
    const d = avif.grid()
    edit(d.items[4].data)
    return avif.build(d)
  }
  refused(t, descriptor((x) => { x[0] = 1 }), 'grid descriptor version 1')
  refused(t, descriptor((x) => { x[1] = 2 }), 'grid descriptor flags 2')
  refused(t, descriptor((x) => { x[1] = 1 }), 'grid descriptor with 32-bit sizes in 8 bytes')
  refused(t, descriptor((x) => { x.push(0) }), 'grid descriptor of 9 bytes')
})

test('AVIF: each grid tile is bounded as an image of its own', (t) => {
  // Under MAX_MEDIA_TOTAL_PIXELS in all, but each tile is decoded whole first.
  const wide = avif.grid({ rows: 2, cols: 1, tileWidth: 65536, tileHeight: 512, width: 1, height: 513 })
  t.is(mediaBounds(avif.build(wide), 'image/avif'), null, 'tiles wider than MAX_MEDIA_DIMENSION')
  const big = avif.grid({ rows: 2, cols: 1, tileWidth: 8192, tileHeight: 4096, width: 1, height: 4097 })
  t.is(mediaBounds(avif.build(big), 'image/avif'), null, 'tiles over MAX_MEDIA_PIXELS')
  t.alike(mediaSize(avif.build(big), 'image/avif'), { width: 1, height: 4097, frames: 1 }, 'mediaSize still reads it')
  const edge = avif.grid({ rows: 2, cols: 1, tileWidth: 16384, tileHeight: 1024, width: 1, height: 1025 })
  t.alike(mediaBounds(avif.build(edge), 'image/avif'), { width: 1, height: 1025, frames: 1 }, 'tiles exactly at MAX_MEDIA_PIXELS')
})

test('AVIF: properties', (t) => {
  const withProp = (prop, essential) => {
    const d = avif.single()
    d.props.push(prop)
    d.items[0].assoc.push([5, essential])
    return avif.build(d)
  }
  refused(t, withProp(avif.irot(1), 1), 'irot angle 90')
  refused(t, withProp(avif.box('imir', 0), 1), 'imir')
  refused(t, withProp(avif.box('clap', new Array(32).fill(0)), 1), 'clap')
  refused(t, withProp(avif.fullBox('auxC', 0, 0, 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha', 0), 0), 'auxC')
  refused(t, withProp(avif.box('zzzz', 1), 1), 'an unknown essential property')
  refused(t, withProp(avif.ispe(16, 16), 0), 'a second ispe on the item')
  for (const type of ['lsel', 'a1op', 'a1lx']) refused(t, withProp(avif.box(type, 0, 0, 0), 0), type + ', even not essential')
  refused(t, withProp(avif.box('clli', 0, 0, 0, 0, 0), 0), 'clli of 5 bytes')
  t.alike(mediaBounds(withProp(avif.box('clli', 0, 0, 0, 0), 0), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'clli of 4 bytes')
  const zero = avif.single()
  zero.props[0] = avif.ispe(0, 0)
  refused(t, avif.build(zero), 'ispe 0x0')
  const pixi10 = avif.single()
  pixi10.props[1] = avif.fullBox('pixi', 0, 0, 3, 10, 10, 10)
  refused(t, avif.build(pixi10), 'pixi of 10 bits')
  const colr = avif.single()
  colr.props[3] = avif.box('colr', 'xxxx', 0, 0)
  refused(t, avif.build(colr), 'a colr that is neither nclx nor ICC')
  const noIspe = avif.single()
  noIspe.items[0].assoc = [[2, 0], [3, 1], [4, 0]]
  refused(t, avif.build(noIspe), 'no ispe')
  const noConfig = avif.single()
  noConfig.items[0].assoc = [[1, 0], [2, 0], [4, 0]]
  refused(t, avif.build(noConfig), 'no av1C')
  const badIndex = avif.single()
  badIndex.items[0].assoc.push([9, 0])
  refused(t, avif.build(badIndex), 'a property index past ipco')
})

test('AVIF: av1C and the AV1 sequence header', (t) => {
  const coded = (config, seq) => {
    const d = avif.single()
    if (config) d.props[2] = avif.av1C(config)
    if (seq) d.items[0].data = avif.sequenceHeader({ width: 16, height: 16, ...seq })
    return avif.build(d)
  }
  refused(t, coded({ highBitdepth: true }, { highBitdepth: true }), '10-bit av1C')
  refused(t, coded(null, { highBitdepth: true }), '10-bit sequence header under an 8-bit av1C')
  refused(t, coded({ mono: true }, { mono: true }), 'monochrome av1C')
  refused(t, coded(null, { mono: true }), 'monochrome sequence header')
  refused(t, coded({ profile: 1, ssx: 0, ssy: 0 }, { profile: 1 }), 'profile 1 av1C')
  refused(t, coded(null, { profile: 1 }), 'profile 1 sequence header')
  refused(t, coded({ ssy: 0 }), '4:2:2 av1C')
  refused(t, coded(null, { cicp: [1, 13, 0] }), 'sRGB identity matrix, coded 4:4:4')
  refused(t, coded({ level: 5 }), 'av1C level that is not the sequence header level')
  refused(t, coded(null, { width: 17 }), 'sequence header max width is not the ispe')
  refused(t, coded(null, { height: 15 }), 'sequence header max height is not the ispe')
  refused(t, coded(null, { reduced: true, still: false }), 'reduced header on a non-still sequence')
  t.alike(mediaBounds(coded(null, { reduced: false, temporalDelimiter: true }), 'image/avif'), { width: 16, height: 16, frames: 1 },
    'the full header after a temporal delimiter, like ImageIO')
  const noSize = avif.single()
  noSize.items[0].data = [0x08, 0, 0, 0]
  refused(t, avif.build(noSize), 'an OBU without a size field')
  const frame = avif.single()
  frame.items[0].data = [0x32, 0x01, 0x00, ...avif.sequenceHeader({ width: 16, height: 16 })]
  refused(t, avif.build(frame), 'a frame OBU before the sequence header')
  const short = avif.single()
  short.items[0].data = avif.sequenceHeader({ width: 16, height: 16 }).slice(0, 4)
  refused(t, avif.build(short), 'a sequence header cut by the extent')
})

test('AVIF: every OBU of an item is walked', (t) => {
  const { seq, frame } = obus()
  const ok = (data, name) => t.alike(mediaBounds(withData(data), 'image/avif'), { width: 16, height: 16, frames: 1 }, name)
  ok([...seq, ...seq, ...frame], 'a byte-identical second sequence header')
  ok([...seq, 0x2a, 0x01, 0x00, ...frame, 0x7a, 0x02, 0x00, 0x00], 'metadata and padding OBUs')
  ok([...seq, 0x1a, 0x01, 0x10, 0x22, 0x01, 0x00], 'a frame header OBU then a tile group')
  refused(t, withData([...seq, ...obus({ cicp: [1, 1, 1] }).seq, ...frame]), 'a second sequence header that differs')
  t.is(obus({ width: 4096 }).seq.length, seq.length)
  refused(t, withData([...seq, ...obus({ width: 4096 }).seq, ...frame]), 'a second sequence header of the same length with a larger max size')
  refused(t, withData([0x12, 0x00, ...seq, 0x12, 0x00, ...frame]), 'a second temporal delimiter')
  refused(t, withData([0x12, 0x01, 0x00, ...seq, ...frame]), 'a temporal delimiter with a payload')
  refused(t, withData([...seq, ...frame, ...frame]), 'a second frame')
  refused(t, withData([...seq, 0x1a, 0x01, 0x10, ...frame]), 'a frame header OBU and a frame OBU')
  refused(t, withData(seq), 'no frame')
  refused(t, withData([...seq, 0x22, 0x01, 0x00, ...frame]), 'a tile group before the frame')
  refused(t, withData([...seq, ...frame, 0x3a, 0x01, 0x00]), 'a redundant frame header OBU')
  refused(t, withData([...seq, ...frame, 0x42, 0x01, 0x00]), 'a tile list OBU')
  refused(t, withData([...seq, 0x36, 0x00, 0x03, 0x10, 0x00, 0x00]), 'a frame OBU with an extension header')
  refused(t, withData([...seq, 0x32, 0x04, 0x10, 0x00, 0x00]), 'an OBU size past the extent')
  refused(t, withData([...seq, ...frame, 0x00]), 'a byte after the last OBU')
  refused(t, withData([...seq, 0x32, 0x80, 0x80, 0x80, 0x80, 0x00]), 'an OBU size of five leb128 bytes')
  ok([...seq, ...frame, ...new Array(254).fill([0x7a, 0x00]).flat()], '256 OBUs')
  refused(t, withData([...seq, ...frame, ...new Array(255).fill([0x7a, 0x00]).flat()]), '257 OBUs')
})

test('AVIF: the frame is coded at the sequence header size', (t) => {
  const full = (frame, o) => withData(avif.sequenceHeader({ width: 16, height: 16, reduced: false, frame, ...o }))
  t.alike(mediaBounds(full([0x10, 0x00]), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'a shown key frame, no override')
  t.alike(mediaBounds(full([0x14, 0x00]), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'screen content tools then force_integer_mv')
  refused(t, full([0x12, 0x00]), 'frame_size_override_flag set')
  refused(t, full([0x15, 0x00]), 'frame_size_override_flag set after force_integer_mv')
  refused(t, full([0x30, 0x00]), 'an inter frame')
  refused(t, full([0x50, 0x00]), 'an intra-only frame')
  refused(t, full([0x00, 0x00]), 'a key frame not shown')
  refused(t, full([0x80, 0x00]), 'show_existing_frame')
  refused(t, full([]), 'an empty frame header')
  const header = withData([...obus({ reduced: false }).seq, 0x1a, 0x01, 0x12, 0x22, 0x01, 0x00])
  refused(t, header, 'frame_size_override_flag set in a frame header OBU')
})

test('AVIF: every sequence header branch leads to frame_size_override_flag', (t) => {
  const dm = (presentationBits) => ({ presentationBits })
  const cases = [
    ['choose screen content tools and integer mv', {}],
    ['timing_info, no equal_picture_interval', { timing: {} }],
    ['timing_info with equal_picture_interval (uvlc)', { timing: { equal: true } }],
    ['decoder_model_info, so temporal_point_info of 7 bits', { timing: { decoderModel: dm(7) } }],
    ['decoder_model_info with equal_picture_interval, no temporal_point_info', { timing: { equal: true, decoderModel: dm(7) } }],
    ['initial_display_delay, 3 operating points', { displayDelay: true, points: 3 }],
    ['decoder model and display delay, 2 operating points', { timing: { decoderModel: dm(5) }, displayDelay: true, points: 2 }],
    ['frame_id_numbers_present, current_frame_id of 10 bits', { frameIds: [5, 2] }],
    ['enable_order_hint', { orderHint: true }],
    ['seq_force_screen_content_tools 0', { screen: 0 }],
    ['screen content tools forced on, integer mv forced 1', { screen: 1, integerMv: 1 }],
    ['screen content tools forced on, integer mv forced 0', { screen: 1, integerMv: 0 }],
    ['screen content tools forced on, choose integer mv', { screen: 1 }],
    ['choose screen content tools, integer mv forced 0', { integerMv: 0 }],
    ['level 9, tier 1', { level: 9, tier: 1 }],
    ['all of them', { timing: { decoderModel: dm(9) }, displayDelay: true, points: 2, frameIds: [3, 4], orderHint: true, level: 9, tier: 1 }]
  ]
  const file = (o, f) => {
    const d = avif.single()
    d.items[0].data = avif.sequenceHeader({ width: 16, height: 16, reduced: false, ...o, frame: avif.frameHeader(o, f) })
    if (o.level) d.props[2] = avif.av1C({ level: o.level, tier: o.tier })
    return avif.build(d)
  }
  for (const [name, o] of cases) {
    for (const screen of [0, 1]) {
      const at = name + (screen ? '' : ', screen content tools off in the frame')
      t.alike(mediaBounds(file(o, { screen, override: 0 }), 'image/avif'), { width: 16, height: 16, frames: 1 }, at + ': override 0')
      t.is(mediaBounds(file(o, { screen, override: 1 }), 'image/avif'), null, at + ': override 1')
    }
  }
  refused(t, file({}, { type: 2 }), 'an intra-only frame under the full header')
  refused(t, file({}, { type: 3 }), 'a switch frame')
  const tier = (seqTier, configTier) => {
    const d = avif.single()
    d.items[0].data = avif.sequenceHeader({ width: 16, height: 16, reduced: false, level: 9, tier: seqTier })
    d.props[2] = avif.av1C({ level: 9, tier: configTier })
    return avif.build(d)
  }
  refused(t, tier(0, 1), 'av1C seq_tier_0 1 under a tier 0 sequence header')
  refused(t, tier(1, 0), 'av1C seq_tier_0 0 under a tier 1 sequence header')
})

test('AVIF: av1C, ICC and hdlr sizes are capped', (t) => {
  const withProps = (...extra) => {
    const d = avif.single()
    d.props.push(...extra)
    return avif.build(d)
  }
  // ipco properties are read whether or not an item uses them.
  t.alike(mediaBounds(withProps(avif.av1C({ configOBUs: new Array(256).fill(0) })), 'image/avif'), { width: 16, height: 16, frames: 1 },
    'an unused av1C of 4 + 256 bytes')
  refused(t, withProps(avif.av1C({ configOBUs: new Array(257).fill(0) })), 'an unused av1C past 4 + 256 bytes')
  const icc = (n) => {
    const d = avif.single()
    d.props[3] = avif.box('colr', 'prof', new Array(n).fill(0))
    return avif.build(d)
  }
  t.alike(mediaBounds(icc(262144), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'an ICC profile of 256 KiB')
  refused(t, icc(262145), 'an ICC profile past 256 KiB')
  const hdlr = (name) => {
    const d = avif.single()
    d.hdlr = avif.fullBox('hdlr', 0, 0, avif.be32(0), 'pict', new Array(12).fill(0), name, 0)
    return avif.build(d)
  }
  t.alike(mediaBounds(hdlr('x'.repeat(231)), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'a hdlr of 256 bytes')
  refused(t, hdlr('x'.repeat(232)), 'a hdlr past 256 bytes')
})

test('AVIF: configOBUs are empty or the item sequence header', (t) => {
  const config = (configOBUs) => {
    const d = avif.single()
    d.props[2] = avif.av1C({ configOBUs })
    return avif.build(d)
  }
  t.alike(mediaBounds(config(obus().seq), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'configOBUs equal to the sequence header OBU')
  refused(t, config(obus({ cicp: [1, 1, 1] }).seq), 'configOBUs with another sequence header')
  refused(t, config([...obus().seq, 0x7a, 0x00]), 'configOBUs with a padding OBU after it')
})

test('AVIF: header boxes, item info and locations', (t) => {
  const edit = (fn, base = avif.single) => {
    const d = base()
    fn(d)
    return avif.build(d)
  }
  refused(t, edit((d) => { d.metaExtra = [avif.box('grpl')] }), 'an unknown meta child, grpl')
  refused(t, edit((d) => { d.metaExtra = [avif.box('free'), avif.box('free')] }), 'a meta child twice')
  refused(t, edit((d) => { d.metaExtra = [[...avif.be32(64), ...avif.bytes('free')]] }), 'a child box past its parent')
  refused(t, edit((d) => { d.handler = 'vide' }), 'hdlr not pict')
  refused(t, edit((d) => { d.pitm = avif.fullBox('pitm', 1, 0, avif.be32(1)) }), 'pitm version 1')
  refused(t, edit((d) => { d.dinf = avif.box('dinf', avif.fullBox('dref', 0, 0, avif.be32(2), avif.fullBox('url ', 0, 1), avif.fullBox('url ', 0, 1))) }), 'dref with two entries')
  refused(t, edit((d) => { d.dinf = avif.box('dinf', avif.fullBox('dref', 0, 0, avif.be32(1), avif.fullBox('url ', 0, 0))) }), 'url with flags 0, data elsewhere')
  refused(t, edit((d) => { d.iinfCount = 2 }), 'iinf entry count that is not its infe count')
  refused(t, edit((d) => { d.items[0].raw = avif.fullBox('infe', 0, 0, avif.be16(1), avif.be16(0), 0, 0, 0) }), 'infe version 0')
  refused(t, edit((d) => { d.items[0].raw = avif.fullBox('infe', 1, 0, avif.be16(1), avif.be16(0), 0, 0, 0, 0) }), 'infe version 1')
  refused(t, edit((d) => { d.items[0].protection = 1 }), 'item_protection_index 1')
  refused(t, edit((d) => { d.items.push({ id: 1, type: 'av01', data: [], noLocation: true }) }), 'an item id twice in iinf')
  refused(t, edit((d) => { d.items[0].id = 0; d.primary = 0 }), 'item id 0')
  refused(t, edit((d) => { d.ilocSizes = 0x48 }), 'iloc length_size 8')
  refused(t, edit((d) => { d.ilocSizes = 0x84 }), 'iloc offset_size 8')
  refused(t, edit((d) => { d.ilocBase = 0x40 }), 'iloc base_offset_size 4')
  refused(t, edit((d) => { d.ilocVersion = 2 }), 'iloc version 2')
  refused(t, edit((d) => { d.items[0].dri = 1 }), 'data_reference_index 1')
  refused(t, edit((d) => { d.items[0].extents = 2 }), 'two extents')
})

test('AVIF: ipma associations', (t) => {
  const entry = [...avif.be16(1), 4, 1, 2, 0x83, 4]
  const ipma = (count, ...entries) => avif.fullBox('ipma', 0, 0, avif.be32(count), ...entries)
  const edit = (fn) => {
    const d = avif.single()
    fn(d)
    return avif.build(d)
  }
  t.alike(mediaBounds(edit((d) => { d.ipma = ipma(1, entry) }), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'the raw ipma as built')
  refused(t, edit((d) => { d.ipma = ipma(2, entry, entry) }), 'ipma listing an item twice')
  refused(t, edit((d) => { d.ipma = ipma(2, entry, avif.be16(7), 1, 1) }), 'ipma for an item not in iinf')
  refused(t, edit((d) => { d.iprpExtra = [ipma(1, entry)] }), 'two ipma boxes')
  t.alike(mediaBounds(edit((d) => { d.items[0].assoc.push([0, 0]) }), 'image/avif'), { width: 16, height: 16, frames: 1 }, 'index 0, not essential, is skipped')
  refused(t, edit((d) => { d.items[0].assoc.push([0, 1]) }), 'index 0 marked essential')
})

// The built file with one byte of the first box of this type changed, at
// offset at from the start of its body.
function patched (file, type, at, value) {
  const b = Uint8Array.from(file)
  for (let p = 0; p + 8 <= b.length; p++) {
    if (String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]) === type) {
      b[p + 8 + at] = value
      return b
    }
  }
  throw new Error('no ' + type)
}

test('AVIF: ftyp, top-level and box count caps', (t) => {
  const ok = (file, name) => t.alike(mediaBounds(file, 'image/avif'), { width: 16, height: 16, frames: 1 }, name)
  const edit = (fn) => {
    const d = avif.single()
    fn(d)
    return avif.build(d)
  }
  refused(t, edit((d) => { d.compatible = ['avif', 'mif1', 'ab'] }), 'an ftyp size that is not a multiple of 4')
  ok(edit((d) => { d.compatible = new Array(32).fill('avif') }), 'an ftyp of 32 compatible brands, 144 bytes')
  refused(t, edit((d) => { d.compatible = new Array(33).fill('avif') }), 'an ftyp of 33 compatible brands, 148 bytes')
  refused(t, new Uint8Array([...avif.be32(24), ...avif.bytes('ftyp', 'avif'), ...avif.be32(0)]), 'an ftyp past the end of the file')
  ok(edit((d) => { d.between = [avif.box('skip', 1, 2, 3)] }), 'a skip box at the top level')
  refused(t, edit((d) => { d.between = [avif.box('uuid', new Array(16).fill(0))] }), 'a uuid box at the top level')
  refused(t, edit((d) => { d.between = [avif.box('ftyp', 'avif', avif.be32(0), 'avif')] }), 'a second ftyp')
  ok(edit((d) => { d.between = new Array(1021).fill(avif.box('free')) }), '1024 top-level boxes')
  refused(t, edit((d) => { d.between = new Array(1022).fill(avif.box('free')) }), '1025 top-level boxes')
  const props = (n) => edit((d) => { for (let i = d.props.length; i < n; i++) d.props.push(avif.box('zzzz', i)) })
  ok(props(64), '64 properties in ipco, the unused ones unknown')
  refused(t, props(65), '65 properties in ipco')
})

test('AVIF: versions and flags of the header boxes', (t) => {
  const ok = (file, name) => t.alike(mediaBounds(file, 'image/avif'), { width: 16, height: 16, frames: 1 }, name)
  const single = avif.build(avif.single())
  const grid = avif.build(avif.grid())
  for (const type of ['meta', 'hdlr', 'pitm', 'iinf', 'iloc']) {
    refused(t, patched(single, type, 0, type === 'iinf' || type === 'iloc' ? 2 : 1), type + ' version ' + (type === 'iinf' || type === 'iloc' ? 2 : 1))
    refused(t, patched(single, type, 3, 1), type + ' flags 1')
  }
  refused(t, patched(grid, 'iref', 0, 1), 'iref version 1')
  refused(t, patched(grid, 'iref', 3, 1), 'iref flags 1')
  refused(t, patched(single, 'ispe', 0, 1), 'ispe version 1')
  refused(t, patched(single, 'pixi', 3, 1), 'pixi flags 1')
  const iinf1 = avif.single()
  iinf1.iinfVersion = 1
  ok(avif.build(iinf1), 'iinf version 1, a 32-bit entry count')
  const infe = avif.single()
  infe.items[0].flags = 2
  refused(t, avif.build(infe), 'infe flags 2')
  const hdlr = (zeros) => {
    const d = avif.single()
    d.hdlr = avif.fullBox('hdlr', 0, 0, avif.be32(0), 'pict', new Array(zeros).fill(0))
    return avif.build(d)
  }
  ok(hdlr(12), 'a hdlr body of 24 bytes, no name')
  refused(t, hdlr(11), 'a hdlr body of 23 bytes')
  const ipma = (version, flags, ...body) => {
    const d = avif.single()
    d.ipma = avif.fullBox('ipma', version, flags, avif.be32(1), ...body)
    return avif.build(d)
  }
  ok(ipma(0, 1, avif.be16(1), 4, avif.be16(1), avif.be16(2), avif.be16(0x8003), avif.be16(4)), 'ipma flags 1, 15-bit indices')
  ok(ipma(1, 0, avif.be32(1), 4, 1, 2, 0x83, 4), 'ipma version 1, a 32-bit item id')
  refused(t, ipma(2, 0, avif.be16(1), 4, 1, 2, 0x83, 4), 'ipma version 2')
  refused(t, ipma(0, 2, avif.be16(1), 4, 1, 2, 0x83, 4), 'ipma flags 2')
  refused(t, ipma(0, 0, avif.be16(1), 4, 1, 2, 0x83, 4, 0), 'ipma with a trailing byte')
})

test('AVIF: colr and av1C bits', (t) => {
  const ok = (file, name) => t.alike(mediaBounds(file, 'image/avif'), { width: 16, height: 16, frames: 1 }, name)
  const single = avif.build(avif.single())
  ok(patched(single, 'colr', 10, 0x00), 'nclx with full_range_flag 0')
  refused(t, patched(single, 'colr', 10, 0x81), 'nclx with a reserved bit set')
  refused(t, patched(single, 'colr', 10, 0x01), 'nclx with only the lowest reserved bit set')
  const nclx = (...values) => {
    const d = avif.single()
    d.props[3] = avif.box('colr', 'nclx', ...values)
    return avif.build(d)
  }
  ok(nclx(avif.be16(1), avif.be16(13), avif.be16(0), 0x80), 'nclx values are not interpreted, identity matrix included')
  refused(t, nclx(avif.be16(1), avif.be16(13), avif.be16(6), 0x80, 0), 'nclx of 12 bytes')
  refused(t, patched(single, 'av1C', 0, 0x01), 'av1C marker 0')
  refused(t, patched(single, 'av1C', 0, 0x82), 'av1C version 2')
  for (const value of [0x20, 0x40, 0x80]) refused(t, patched(single, 'av1C', 3, value), 'av1C reserved bits ' + value.toString(16))
  ok(patched(single, 'av1C', 2, 0x0e), 'av1C chroma_sample_position is not checked')
  ok(patched(single, 'av1C', 3, 0x1f), 'av1C initial_presentation_delay is not checked')
  refused(t, patched(single, 'av1C', 2, 0x8c), 'av1C seq_tier_0 1 under a level 0 sequence header')
})

test('AVIF: a grid descriptor with 32-bit sizes', (t) => {
  const d = avif.grid({ height: 127 })
  d.items[4].data = [0, 1, 1, 1, ...avif.be32(128), ...avif.be32(127)]
  t.alike(mediaBounds(avif.build(d), 'image/avif'), { width: 128, height: 127, frames: 1 }, 'flags 1, 12 bytes')
  d.items[4].data = [0, 1, 1, 1, ...avif.be32(128), ...avif.be32(127), 0]
  refused(t, avif.build(d), 'flags 1, 13 bytes')
  d.items[4].data = [0, 1, 1, 1, ...avif.be32(129), ...avif.be32(127)]
  refused(t, avif.build(d), 'flags 1, wider than the tiles')
})

test('AVIF: a canvas over the pixel bound is sized by mediaSize only', (t) => {
  const file = avif.build(avif.single({ width: 8192, height: 4096 }))
  t.is(mediaBounds(file, 'image/avif'), null)
  t.alike(mediaSize(file, 'image/avif'), { width: 8192, height: 4096, frames: 1 })
  t.is(mediaBounds(avif.build(avif.single({ width: MAX_MEDIA_DIMENSION + 1, height: 1 })), 'image/avif'), null, 'one side over the cap')
})

test('AVIF: the mime must match the bytes, and MP4 is not an image', (t) => {
  t.is(mediaBounds(samples.libavif.opaque, 'image/png'), null, 'an AVIF declared image/png')
  t.is(mediaBounds(png(16, 16), 'image/avif'), null, 'a PNG declared image/avif')
  t.is(mediaSize(png(16, 16), 'image/avif'), null, 'a PNG declared image/avif (mediaSize)')
  const mp4 = (major, compatible) => new Uint8Array([...avif.box('ftyp', major, avif.be32(0), ...compatible), ...avif.box('mdat', 0)])
  for (const file of [mp4('M4A ', ['M4A ', 'mp42', 'isom']), mp4('isom', ['isom', 'iso2', 'avc1', 'mp41']), mp4('mp42', ['mp42', 'mp41'])]) {
    t.is(mediaBounds(file), null)
    t.is(mediaBounds(file, 'image/avif'), null)
  }
  t.is(mediaBounds(new Uint8Array(avif.box('ftyp', 'avif', avif.be32(0), 'avif')), 'image/avif'), null, 'a bare ftyp')
})

function lcg (seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return (seed >>> 16) & 0xff
  }
}

function withinBounds (r) {
  return r === null || (r.frames === 1 && r.width >= 1 && r.height >= 1 && r.width <= MAX_MEDIA_DIMENSION &&
    r.height <= MAX_MEDIA_DIMENSION && r.width * r.height <= MAX_MEDIA_PIXELS)
}

test('AVIF: every truncation of a real sample is null', (t) => {
  let bad = 0
  for (const file of [samples.libavif.opaque, imageio.grid1024x768]) {
    for (let i = 0; i < file.length; i++) {
      try {
        if (mediaBounds(file.subarray(0, i), 'image/avif') !== null || mediaSize(file.subarray(0, i)) !== null) bad++
      } catch {
        bad++
      }
    }
  }
  t.is(bad, 0)
})

test('AVIF: random bytes and random flips end in null or a bounded size', (t) => {
  const rand = lcg(11)
  const head = avif.box('ftyp', 'avif', avif.be32(0), 'avif', 'mif1')
  const noise = new Uint8Array(head.length + 1024 * 1024)
  noise.set(head)
  for (let i = head.length; i < noise.length; i++) noise[i] = rand()
  t.is(mediaBounds(noise, 'image/avif'), null, '1 MiB of random bytes after a valid ftyp')
  let bad = 0
  let rounds = 0
  const real = [samples.libavif.opaque, samples.libavif.odd1001x667, samples.ios.opaque, imageio.opaque,
    imageio.grid1024x768, imageio.grid1025x769, imageio.grid2048x1536]
  for (const file of real) {
    // About 1 MiB of mutated input per sample.
    for (let total = 0; total < 1024 * 1024; total += file.length) {
      const b = Uint8Array.from(file)
      const flips = 1 + (rand() & 3)
      for (let k = 0; k < flips; k++) b[((rand() << 8) | rand()) % b.length] ^= 1 << (rand() & 7)
      try {
        if (!withinBounds(mediaBounds(b)) || !withinBounds(mediaBounds(b, 'image/avif'))) bad++
        mediaSize(b)
      } catch {
        bad++
      }
      rounds++
    }
  }
  t.is(bad, 0)
  t.ok(rounds > 1000, rounds + ' mutated files')
})
