'use strict'

// The avatar rules exist in packages/core (records.js, still-image.js),
// packages/rpc (limits.js) and apps/app/src/media/avatar.js, which cannot
// import the first two. This pins the copies: same constants, same verdicts
// on a shared vector set.
const test = require('brittle')
const records = require('@varanda/core/lib/records')
const { stillImageSize: coreSize } = require('@varanda/core/lib/still-image')
const rpc = require('@varanda/rpc')

const load = () => import('../src/media/avatar.js')

const be16 = (n) => [(n >> 8) & 0xff, n & 0xff]
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

// [name, bytes, mime, expected]; an expected of undefined only compares the
// two parsers with each other.
function vectors () {
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
  const sof = (len, nf, w, h, marker = 0xc0) => [0xff, marker, ...be16(len), 8, ...be16(h), ...be16(w), nf, ...new Array(Math.max(0, len - 8)).fill(1)]
  const jpg = (...parts) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9])
  const still = body(v8(512, 512))
  const early = body(ck('ICCP', [1, 2, 3, 4]), v8(512, 512))
  const W = 'image/webp'
  const J = 'image/jpeg'
  const ok = web(v8(512, 512))
  const okJpg = jpg(sof(17, 3, 512, 512))
  const pastSize = web(v8(512, 512))
  pastSize.set(le32(1000), 16)
  const list = [
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
    ['JPEG SOF0 Nf 3 L 17 at 512', okJpg, J, S],
    ['JPEG SOF0 Nf 1 L 11 at 512', jpg(sof(11, 1, 512, 512)), J, S],
    ['JPEG L 17 with Nf 1', jpg(sof(17, 1, 512, 512)), J, null],
    ['JPEG L 14 with Nf 3', jpg(sof(14, 3, 512, 512)), J, null],
    ['JPEG Nf 0', jpg(sof(11, 0, 512, 512)), J, null],
    ['JPEG Nf 5 L 23', jpg(sof(23, 5, 512, 512)), J, null],
    ['JPEG SOF2 512', jpg(sof(17, 3, 512, 512, 0xc2)), J, S],
    ['JPEG SOF0 511 wide', jpg(sof(17, 3, 511, 512)), J, { width: 511, height: 512 }],
    ['JPEG SOF2 511 high', jpg(sof(17, 3, 512, 511, 0xc2)), J, { width: 512, height: 511 }],
    ['WebP VP8 512', ok, W, S],
    ['WebP VP8 511', web(v8(511, 511)), W, { width: 511, height: 511 }],
    ['WebP VP8L 512', web(v8l(512, 512)), W, S],
    ['WebP VP8L 511', web(v8l(511, 511)), W, { width: 511, height: 511 }],
    ['WebP still VP8X 512', web(v8x(0x00, 512, 512), v8(512, 512)), W, S],
    ['WebP VP8X with the animation flag', web(v8x(0x02, 512, 512), v8(512, 512)), W, null],
    ['WebP ANIM before the image', web(v8x(0x00, 512, 512), anim, v8(512, 512)), W, null],
    ['WebP ANMF only', web(v8x(0x00, 512, 512), anmf), W, null],
    ['WebP chunk size past the end', pastSize, W, null],
    ['PNG signature', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 'image/png', null],
    ['GIF signature', new Uint8Array([...ascii('GIF89a'), 0, 2, 0, 2, 0, 0]), 'image/gif', null],
    ['JPEG bytes labelled webp', okJpg, W, null],
    ['WebP bytes labelled jpeg', ok, J, null],
    ['empty jpeg', new Uint8Array(0), J, null],
    ['empty webp', new Uint8Array(0), W, null],
    ['not bytes', 'RIFF', W, null],
    ['unknown mime', ok, 'image/avif', null]
  ]
  for (let n = 0; n < ok.length; n++) list.push(['WebP cut at ' + n, ok.subarray(0, n), W, null])
  // The walk stops at the frame header, so a cut after it is still readable.
  for (let n = 0; n < okJpg.length; n++) list.push(['JPEG cut at ' + n, okJpg.subarray(0, n), J, n >= 4 + 17 ? undefined : null])
  return list
}

function descriptor (over) {
  return Object.assign({
    core: 'ab'.repeat(32),
    mime: 'image/jpeg',
    start: 1,
    blocks: 1,
    bytes: 1000,
    sha256: 'cd'.repeat(32),
    width: 512,
    height: 512
  }, over)
}

function descriptors () {
  const B = 32768
  const noSha = descriptor()
  delete noSha.sha256
  return [
    ['valid jpeg', descriptor()],
    ['valid webp', descriptor({ mime: 'image/webp' })],
    ['png', descriptor({ mime: 'image/png' })],
    ['gif', descriptor({ mime: 'image/gif' })],
    ['mp4', descriptor({ mime: 'video/mp4' })],
    ['width 511', descriptor({ width: 511 })],
    ['width 513', descriptor({ width: 513 })],
    ['height 511', descriptor({ height: 511 })],
    ['height 513', descriptor({ height: 513 })],
    ['blocks 8 at the cap', descriptor({ blocks: 8, bytes: 8 * B })],
    ['blocks 8, one byte over the first 7', descriptor({ blocks: 8, bytes: 7 * B + 1 })],
    ['blocks 9', descriptor({ blocks: 9, bytes: 9 * B })],
    ['blocks 7 full', descriptor({ blocks: 7, bytes: 7 * B })],
    ['bytes 1', descriptor({ bytes: 1 })],
    ['bytes 0', descriptor({ bytes: 0 })],
    ['bytes one block', descriptor({ bytes: B })],
    ['bytes 262144 in 8 blocks', descriptor({ blocks: 8, bytes: 262144 })],
    ['bytes 262145 in 8 blocks', descriptor({ blocks: 8, bytes: 262145 })],
    ['bytes inconsistent with blocks', descriptor({ blocks: 2, bytes: 100 })],
    ['start 0', descriptor({ start: 0 })],
    ['start near the end', descriptor({ start: 4095 })],
    ['extra key', descriptor({ extra: 1 })],
    ['missing key', noSha],
    ['bad core', descriptor({ core: 'zz' })],
    ['uppercase sha256', descriptor({ sha256: 'CD'.repeat(32) })],
    ['string width', descriptor({ width: '512' })],
    ['fractional width', descriptor({ width: 512.5 })],
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['number', 512]
  ]
}

test('constants are equal in core, rpc and the app copy', async (t) => {
  const app = await load()
  for (const k of ['AVATAR_SIDE', 'MAX_AVATAR_BLOCKS', 'MAX_AVATAR_BYTES']) {
    t.is(typeof records[k], 'number', k + ' in core')
    t.is(app[k], records[k], k + ' app vs core')
    t.is(rpc[k], records[k], k + ' rpc vs core')
  }
  t.alike([...app.AVATAR_MIMES], [...records.AVATAR_MIMES], 'AVATAR_MIMES app vs core')
  t.alike([...rpc.AVATAR_MIMES], [...records.AVATAR_MIMES], 'AVATAR_MIMES rpc vs core')
  t.is(records.AVATAR_SIDE, 512)
  t.is(records.MAX_AVATAR_BLOCKS, 8)
  t.is(records.MAX_AVATAR_BYTES, 262144)
})

test('stillImageSize gives the same verdict in core and the app copy', async (t) => {
  const app = await load()
  const all = vectors()
  t.ok(all.length > 60, 'vector count ' + all.length)
  for (const [name, bytes, mime, want] of all) {
    const a = coreSize(bytes, mime)
    t.alike(app.stillImageSize(bytes, mime), a, 'app equals core: ' + name)
    if (want !== undefined) t.alike(a, want, 'expected: ' + name)
  }
})

test('validAvatar gives the same verdict in core and the app copy', async (t) => {
  const app = await load()
  const all = descriptors()
  let valid = 0
  for (const [name, d] of all) {
    const a = records.validAvatar(d)
    t.is(app.validAvatar(d), a, name)
    if (a) valid++
  }
  t.ok(valid >= 4 && valid < all.length, 'both verdicts are exercised')
})
