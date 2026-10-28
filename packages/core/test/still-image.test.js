'use strict'

const test = require('brittle')
const { stillImageSize } = require('../lib/still-image')

function be16 (n) {
  return [(n >> 8) & 0xff, n & 0xff]
}

function le16 (n) {
  return [n & 0xff, (n >> 8) & 0xff]
}

function le24 (n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
}

function le32 (n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function ascii (s) {
  return [...s].map((c) => c.charCodeAt(0))
}

function segment (marker, payload) {
  return [0xff, marker, ...be16(payload.length + 2), ...payload]
}

function sof (marker, width, height) {
  return segment(marker, [8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
}

function jpeg (...parts) {
  return new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9])
}

const APP0 = segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
const DQT = segment(0xdb, new Array(65).fill(1))
const DHT = segment(0xc4, new Array(20).fill(0))

function chunk (id, payload) {
  const out = [...ascii(id), ...le32(payload.length), ...payload]
  if (payload.length & 1) out.push(0)
  return out
}

function riff (...chunks) {
  const body = [...ascii('WEBP'), ...chunks.flat()]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}

function vp8 (width, height) {
  return chunk('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0])
}

function vp8l (width, height) {
  const v = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  return chunk('VP8L', [0x2f, ...le32(v >>> 0), 0, 0])
}

function vp8x (flags, width, height) {
  return chunk('VP8X', [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)])
}

// The same block is in packages/core/test/still-image.test.js and
// apps/app/test/mediaAvatar.test.js: both parsers must give these verdicts.
function hardeningVectors () {
  const S = { width: 512, height: 512 }
  const ck = (id, payload) => {
    const out = [...ascii(id), ...le32(payload.length), ...payload]
    if (payload.length & 1) out.push(0)
    return out
  }
  const body = (...chunks) => [...ascii('WEBP'), ...chunks.flat()]
  const wrap = (b, riffSize = b.length) => new Uint8Array([...ascii('RIFF'), ...le32(riffSize), ...b])
  const web = (...chunks) => wrap(body(...chunks))
  const v8 = (w, h) => ck('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0])
  const v8l = (w, h) => ck('VP8L', [0x2f, ...le32((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0), 0, 0])
  const v8x = (flags, w, h) => ck('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])
  const anim = ck('ANIM', [0, 0, 0, 0, 0, 0])
  const anmf = ck('ANMF', new Array(16).fill(0))
  const badStart = ck('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2b, ...le16(512), ...le16(512), 0, 0])
  const sof = (len, nf, w, h) => [0xff, 0xc0, ...be16(len), 8, ...be16(h), ...be16(w), nf, ...new Array(Math.max(0, len - 8)).fill(1)]
  const jpg = (...parts) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9])
  const still = body(v8(512, 512))
  const early = body(ck('ICCP', [1, 2, 3, 4]), v8(512, 512))
  const W = 'image/webp'
  const J = 'image/jpeg'
  return [
    ['VP8 512 then a trailing ANIM', web(v8(512, 512), anim), W, null],
    ['VP8 then ANMF', web(v8(512, 512), anmf), W, null],
    ['still VP8X + VP8L 512', web(v8x(0x00, 512, 512), v8l(512, 512)), W, S],
    ['VP8X canvas 512 + VP8 frame 256', web(v8x(0x00, 512, 512), v8(256, 256)), W, null],
    ['VP8X then a VP8 with a bad start code', web(v8x(0x00, 512, 512), badStart), W, null],
    ['two VP8X', web(v8x(0x00, 512, 512), v8x(0x00, 512, 512), v8(512, 512)), W, null],
    ['VP8X after the image chunk', web(v8(512, 512), v8x(0x00, 512, 512)), W, null],
    ['two image chunks', web(v8(512, 512), v8l(512, 512)), W, null],
    ['ALPH + VP8 with VP8X', web(v8x(0x10, 512, 512), ck('ALPH', [0, 1, 2]), v8(512, 512)), W, S],
    ['riffSize larger than the buffer', wrap(still, still.length + 2), W, null],
    ['riffSize ends before the only image chunk', wrap(early, 4 + 12), W, null],
    ['trailing bytes after the RIFF end are ignored', new Uint8Array([...wrap(still), ...anim, 1, 2, 3]), W, S],
    ['truncated trailing chunk inside the RIFF', web(v8(512, 512), [...ascii('EXIF'), ...le32(100), 1, 2]), W, null],
    ['stray partial chunk header inside the RIFF', web(v8(512, 512), [...ascii('ANIM')]), W, null],
    ['odd last chunk without its pad byte', wrap(body(v8(512, 512), ck('EXIF', [1, 2, 3])).slice(0, -1)), W, null],
    ['JPEG with an 11-byte short SOF', new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x02, 0x00, 0x02, 0x00]), J, null],
    ['JPEG SOF0 Nf 3 L 17 at 512', jpg(sof(17, 3, 512, 512)), J, S],
    ['JPEG SOF0 Nf 1 L 11 at 512', jpg(sof(11, 1, 512, 512)), J, S],
    ['JPEG L 17 with Nf 1', jpg(sof(17, 1, 512, 512)), J, null],
    ['JPEG L 14 with Nf 3', jpg(sof(14, 3, 512, 512)), J, null],
    ['JPEG Nf 0', jpg(sof(11, 0, 512, 512)), J, null],
    ['JPEG Nf 5 L 23', jpg(sof(23, 5, 512, 512)), J, null]
  ]
}

test('JPEG: baseline and progressive', async (t) => {
  t.alike(stillImageSize(jpeg(APP0, DQT, sof(0xc0, 512, 512), DHT), 'image/jpeg'), { width: 512, height: 512 })
  t.alike(stillImageSize(jpeg(APP0, DQT, DHT, sof(0xc2, 512, 512)), 'image/jpeg'), { width: 512, height: 512 })
  t.alike(stillImageSize(jpeg(sof(0xc0, 640, 480)), 'image/jpeg'), { width: 640, height: 480 })
  t.alike(stillImageSize(jpeg(sof(0xc1, 3, 7)), 'image/jpeg'), { width: 3, height: 7 })
  // Fill bytes before a marker, and a marker without a length.
  const fill = jpeg([0xff, 0xff, 0xff], APP0, [0xff, 0xd0], sof(0xc0, 512, 512))
  t.alike(stillImageSize(fill, 'image/jpeg'), { width: 512, height: 512 })
  // A Buffer is a Uint8Array view.
  t.alike(stillImageSize(Buffer.from(jpeg(sof(0xc0, 512, 512))), 'image/jpeg'), { width: 512, height: 512 })
  const big = jpeg(sof(0xc0, 512, 512))
  const view = new Uint8Array(big.buffer.slice(0), 0, big.length)
  t.alike(stillImageSize(view, 'image/jpeg'), { width: 512, height: 512 })
})

test('JPEG: refused', async (t) => {
  const ok = jpeg(APP0, sof(0xc0, 512, 512))
  t.is(stillImageSize(ok, 'image/webp'), null, 'JPEG bytes labelled image/webp')
  t.is(stillImageSize(ok, 'image/png'), null)
  t.is(stillImageSize(jpeg(APP0, sof(0xc0, 0, 512)), 'image/jpeg'), null, 'zero width')
  t.is(stillImageSize(jpeg(APP0, sof(0xc0, 512, 0)), 'image/jpeg'), null, 'zero height')
  // DHT, JPG and DAC are not frames; SOS before any frame.
  t.is(stillImageSize(jpeg(DHT, segment(0xc8, [1, 2, 3, 4, 5, 6, 7]), segment(0xcc, [1, 2, 3, 4, 5, 6, 7])), 'image/jpeg'), null)
  t.is(stillImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'), null, 'EOI first')
  t.is(stillImageSize(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'), null)
  t.is(stillImageSize(new Uint8Array([0xff, 0xd8, 0x00]), 'image/jpeg'), null)
  t.is(stillImageSize(new Uint8Array([0xff, 0xd9, 0xff, 0xc0]), 'image/jpeg'), null, 'no SOI')
  // Truncated: a segment length past the end, and a SOF cut short.
  t.is(stillImageSize(ok.subarray(0, 10), 'image/jpeg'), null)
  const full = jpeg(sof(0xc0, 512, 512))
  for (let n = 0; n < 2 + 2 + 2 + 5; n++) t.is(stillImageSize(full.subarray(0, n), 'image/jpeg'), null, 'cut at ' + n)
  t.is(stillImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0]), 'image/jpeg'), null, 'length below 2')
  t.is(stillImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x00]), 'image/jpeg'), null, 'length past the end')
  // More than 64 segments before the frame.
  const many = []
  for (let i = 0; i < 64; i++) many.push(segment(0xe1, [i]))
  t.is(stillImageSize(jpeg(...many, sof(0xc0, 512, 512)), 'image/jpeg'), null)
  t.alike(stillImageSize(jpeg(...many.slice(1), sof(0xc0, 512, 512)), 'image/jpeg'), { width: 512, height: 512 })
})

test('WebP: VP8, VP8L and still VP8X', async (t) => {
  t.alike(stillImageSize(riff(vp8(512, 512)), 'image/webp'), { width: 512, height: 512 })
  t.alike(stillImageSize(riff(vp8(512 | 0x4000, 512 | 0xc000)), 'image/webp'), { width: 512, height: 512 }, 'scale bits ignored')
  t.alike(stillImageSize(riff(vp8l(512, 512)), 'image/webp'), { width: 512, height: 512 })
  t.alike(stillImageSize(riff(vp8l(1, 16384)), 'image/webp'), { width: 1, height: 16384 })
  t.alike(stillImageSize(riff(vp8x(0x10, 512, 512), chunk('ALPH', [0, 1, 2]), vp8(512, 512)), 'image/webp'), { width: 512, height: 512 })
  t.alike(stillImageSize(riff(vp8x(0x00, 512, 512), vp8l(512, 512)), 'image/webp'), { width: 512, height: 512 })
  t.alike(stillImageSize(riff(chunk('ICCP', [1, 2, 3]), vp8(300, 200)), 'image/webp'), { width: 300, height: 200 }, 'odd chunk padded')
})

test('WebP: refused', async (t) => {
  t.is(stillImageSize(riff(vp8x(0x02, 512, 512), vp8(512, 512)), 'image/webp'), null, 'animation flag')
  t.is(stillImageSize(riff(vp8x(0x12, 512, 512), vp8(512, 512)), 'image/webp'), null, 'animation flag with alpha')
  t.is(stillImageSize(riff(vp8x(0x00, 512, 512), chunk('ANIM', [0, 0, 0, 0, 0, 0]), vp8(512, 512)), 'image/webp'), null, 'ANIM')
  t.is(stillImageSize(riff(vp8x(0x00, 512, 512), chunk('ANMF', new Array(16).fill(0)), vp8(512, 512)), 'image/webp'), null, 'ANMF')
  t.is(stillImageSize(riff(chunk('ANMF', new Array(16).fill(0)), vp8(512, 512)), 'image/webp'), null, 'ANMF without VP8X')
  t.is(stillImageSize(riff(vp8x(0x00, 512, 512)), 'image/webp'), null, 'VP8X with no image chunk')
  t.is(stillImageSize(riff(vp8x(0x00, 512, 512), chunk('ALPH', [0])), 'image/webp'), null)
  t.is(stillImageSize(riff(vp8(512, 512)), 'image/jpeg'), null, 'WebP bytes labelled image/jpeg')
  t.is(stillImageSize(riff(chunk('VP8 ', [0x10, 0x02, 0x00, 0x00, 0x01, 0x2a, 0, 2, 0, 2])), 'image/webp'), null, 'bad VP8 start code')
  t.is(stillImageSize(riff(chunk('VP8L', [0x2e, 0, 0, 0, 0])), 'image/webp'), null, 'bad VP8L signature')
  t.is(stillImageSize(riff(vp8(0, 512)), 'image/webp'), null, 'zero width')
  // Truncated and a size past the end.
  const ok = riff(vp8(512, 512))
  for (let n = 0; n < ok.length; n++) t.is(stillImageSize(ok.subarray(0, n), 'image/webp'), null, 'cut at ' + n)
  const past = riff(vp8(512, 512))
  past.set(le32(1000), 16)
  t.is(stillImageSize(past, 'image/webp'), null, 'chunk size past the end')
  const huge = riff(vp8(512, 512))
  huge.set(le32(0xffffffff), 16)
  t.is(stillImageSize(huge, 'image/webp'), null, 'chunk size 2^32 - 1')
  // More than 64 chunks before the image.
  const many = []
  for (let i = 0; i < 64; i++) many.push(chunk('EXIF', [i, i]))
  t.is(stillImageSize(riff(...many, vp8(512, 512)), 'image/webp'), null)
  t.alike(stillImageSize(riff(...many.slice(1), vp8(512, 512)), 'image/webp'), { width: 512, height: 512 })
  t.is(stillImageSize(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]), 'image/webp'), null)
})

test('other formats and inputs', async (t) => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), 0, 0, 2, 0, 0, 0, 2, 0, 8, 6, 0, 0, 0])
  const gif = new Uint8Array([...ascii('GIF89a'), 0, 2, 0, 2, 0, 0, 0])
  for (const mime of ['image/jpeg', 'image/webp', 'image/png', 'image/gif']) {
    t.is(stillImageSize(png, mime), null, 'PNG as ' + mime)
    t.is(stillImageSize(gif, mime), null, 'GIF as ' + mime)
  }
  const ok = jpeg(sof(0xc0, 512, 512))
  for (const bytes of [undefined, null, 'x', 1, [...ok], ok.buffer, new Uint16Array(4), {}, new DataView(ok.buffer)]) {
    t.is(stillImageSize(bytes, 'image/jpeg'), null)
  }
  for (const mime of [undefined, null, 'IMAGE/JPEG', 'image/jpg', '', 1]) t.is(stillImageSize(ok, mime), null)
  t.is(stillImageSize(new Uint8Array(0), 'image/jpeg'), null)
  t.is(stillImageSize(new Uint8Array(0), 'image/webp'), null)
  const hostile = new Proxy(ok, { get () { throw new Error('boom') } })
  t.is(stillImageSize(hostile, 'image/jpeg'), null)
})

test('random buffers never throw', async (t) => {
  let thrown = 0
  for (let i = 0; i < 1000; i++) {
    const len = Math.floor(Math.random() * 200)
    const b = new Uint8Array(len)
    for (let j = 0; j < len; j++) b[j] = Math.floor(Math.random() * 256)
    if (i % 3 === 1 && len >= 3) b.set([0xff, 0xd8, 0xff])
    if (i % 3 === 2 && len >= 12) {
      b.set(ascii('RIFF'))
      b.set(ascii('WEBP'), 8)
    }
    for (const mime of ['image/jpeg', 'image/webp']) {
      try {
        const got = stillImageSize(b, mime)
        if (got !== null && !(got.width >= 1 && got.height >= 1)) thrown++
      } catch {
        thrown++
      }
    }
  }
  t.is(thrown, 0)
})

test('hardening vectors (shared with the app copy)', async (t) => {
  for (const [name, bytes, mime, want] of hardeningVectors()) t.alike(stillImageSize(bytes, mime), want, name)
})
