'use strict'

const test = require('brittle')
const { mediaBounds, MAX_MEDIA_PIXELS, MAX_MEDIA_FRAMES, MAX_MEDIA_TOTAL_PIXELS, MAX_MEDIA_DIMENSION } = require('..')

function bytes (...parts) {
  const out = []
  for (const part of parts) {
    if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0))
    else if (typeof part === 'number') out.push(part)
    else out.push(...part)
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
