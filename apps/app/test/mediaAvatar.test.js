'use strict'

// Avatar rules (src/media/avatar.js): descriptor checks, the still-image
// header check and the verified load, with fetch and WebCrypto injected (no
// network).
const test = require('brittle')
const { createHash, webcrypto } = require('node:crypto')
const load = () => import('../src/media/avatar.js')

const AUTHOR = 'ab'.repeat(32)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

const be16 = (n) => [(n >> 8) & 0xff, n & 0xff]
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))

function jpeg (width, height, sof = 0xc0) {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const frame = [0xff, sof, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const sos = [0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]
  return new Uint8Array([0xff, 0xd8, ...app0, ...frame, ...sos, 1, 2, 3, 0xff, 0xd9])
}

function chunk (fourcc, payload) {
  const out = [...ascii(fourcc), ...le32(payload.length), ...payload]
  if (payload.length & 1) out.push(0)
  return out
}

function riff (chunks) {
  const body = [...ascii('WEBP'), ...chunks.flat()]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}

const vp8 = (w, h) => chunk('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0])
function vp8l (w, h) {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return chunk('VP8L', [0x2f, ...le32(v >>> 0), 0, 0])
}
const vp8x = (w, h, flags = 0x10) => chunk('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])

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

function descriptor (bytes, over = {}) {
  return {
    core: 'cd'.repeat(32),
    mime: 'image/jpeg',
    start: 1,
    blocks: Math.max(1, Math.ceil(bytes.byteLength / 32768)),
    bytes: bytes.byteLength,
    sha256: sha(bytes),
    width: 512,
    height: 512,
    ...over
  }
}

function response (bytes, status = 200) {
  return { status, redirected: false, arrayBuffer: async () => bytes.slice().buffer }
}

function deps (res, over = {}) {
  const calls = []
  return {
    calls,
    fetch: async (url, opts) => { calls.push({ url, opts }); return typeof res === 'function' ? res() : res },
    subtle: webcrypto.subtle,
    urlFromBytes: (bytes, mime) => 'blob:test/' + mime,
    ...over
  }
}

test('constants and validAvatar mirror the core rules', async (t) => {
  const { validAvatar, AVATAR_SIDE, MAX_AVATAR_BLOCKS, MAX_AVATAR_BYTES, AVATAR_MIMES } = await load()
  t.is(AVATAR_SIDE, 512)
  t.is(MAX_AVATAR_BLOCKS, 8)
  t.is(MAX_AVATAR_BYTES, 262144)
  t.alike([...AVATAR_MIMES], ['image/jpeg', 'image/webp'])
  const d = descriptor(new Uint8Array(1000))
  t.ok(validAvatar(d))
  t.ok(validAvatar({ ...d, mime: 'image/webp' }))
  t.ok(validAvatar({ ...d, start: 8184, blocks: 8, bytes: 262144 }), 'worst case')
  const bad = [
    { mime: 'image/png' },
    { mime: 'image/gif' },
    { width: 511 },
    { height: 1024 },
    { blocks: 9, bytes: 9 * 32768 },
    { core: 'CD'.repeat(32) },
    { start: 0 }
  ]
  for (const over of bad) t.absent(validAvatar({ ...d, ...over }), JSON.stringify(over))
  t.absent(validAvatar({ ...d, extra: 1 }), 'extra key')
  for (const v of [null, undefined, 'x', 42, [], {}]) t.absent(validAvatar(v))
})

test('stillImageSize reads still JPEG and WebP headers only', async (t) => {
  const { stillImageSize } = await load()
  t.alike(stillImageSize(jpeg(512, 512), 'image/jpeg'), { width: 512, height: 512 }, 'SOF0')
  t.alike(stillImageSize(jpeg(512, 512, 0xc2), 'image/jpeg'), { width: 512, height: 512 }, 'SOF2')
  t.alike(stillImageSize(jpeg(300, 200), 'image/jpeg'), { width: 300, height: 200 })
  t.alike(stillImageSize(riff([vp8(512, 512)]), 'image/webp'), { width: 512, height: 512 }, 'VP8')
  t.alike(stillImageSize(riff([vp8l(512, 512)]), 'image/webp'), { width: 512, height: 512 }, 'VP8L')
  t.alike(stillImageSize(riff([vp8x(512, 512), chunk('ALPH', [0, 1, 2]), vp8(512, 512)]), 'image/webp'), { width: 512, height: 512 }, 'still VP8X + ALPH')

  t.is(stillImageSize(riff([vp8x(512, 512, 0x12), vp8(512, 512)]), 'image/webp'), null, 'VP8X animation flag')
  t.is(stillImageSize(riff([chunk('ANIM', [0, 0, 0, 0, 0, 0]), vp8(512, 512)]), 'image/webp'), null, 'ANIM')
  t.is(stillImageSize(riff([vp8(512, 512), chunk('ANMF', [0, 0])]), 'image/webp'), null, 'ANMF')
  t.is(stillImageSize(riff([vp8x(512, 512)]), 'image/webp'), null, 'VP8X without an image chunk')
  t.is(stillImageSize(jpeg(512, 512), 'image/webp'), null, 'JPEG labelled image/webp')
  t.is(stillImageSize(riff([vp8(512, 512)]), 'image/jpeg'), null, 'WebP labelled image/jpeg')
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  t.is(stillImageSize(png, 'image/png'), null, 'PNG')
  t.is(stillImageSize(new Uint8Array(ascii('GIF89a')), 'image/gif'), null, 'GIF')
  t.is(stillImageSize(jpeg(512, 512).subarray(0, 30), 'image/jpeg'), null, 'truncated segment')
  const sizePast = riff([vp8(512, 512)])
  sizePast.set(le32(1000), 16)
  t.is(stillImageSize(sizePast, 'image/webp'), null, 'chunk size past the end')
  const many = Array.from({ length: 65 }, () => chunk('XYZW', [0, 0]))
  t.is(stillImageSize(riff([...many, vp8(512, 512)]), 'image/webp'), null, 'more than 64 chunks')
  t.is(stillImageSize([0xff, 0xd8, 0xff], 'image/jpeg'), null, 'not a Uint8Array')
  t.is(stillImageSize(null, 'image/jpeg'), null)

  let threw = false
  for (let i = 0; i < 1000; i++) {
    const b = new Uint8Array(Math.floor(Math.random() * 64))
    for (let j = 0; j < b.length; j++) b[j] = Math.floor(Math.random() * 256)
    if (i % 2 === 0 && b.length >= 3) b.set([0xff, 0xd8, 0xff])
    try { stillImageSize(b, i % 2 === 0 ? 'image/jpeg' : 'image/webp') } catch { threw = true }
  }
  t.absent(threw, 'random buffers never throw')
})

test('hardening vectors (shared with the core copy)', async (t) => {
  const { stillImageSize } = await load()
  for (const [name, bytes, mime, want] of hardeningVectors()) t.alike(stillImageSize(bytes, mime), want, name)
})

test('checkAvatarBytes needs the exact descriptor dimensions', async (t) => {
  const { checkAvatarBytes } = await load()
  const bytes = jpeg(512, 512)
  t.ok(checkAvatarBytes(bytes, descriptor(bytes)))
  t.absent(checkAvatarBytes(jpeg(512, 511), descriptor(bytes)))
  t.absent(checkAvatarBytes(bytes, descriptor(bytes, { mime: 'image/webp' })))
  const webp = riff([vp8l(512, 512)])
  t.ok(checkAvatarBytes(webp, descriptor(webp, { mime: 'image/webp' })))
})

test('avatarKey, avatarOf and sameAvatar', async (t) => {
  const { avatarKey, avatarOf, sameAvatar } = await load()
  const d = descriptor(jpeg(512, 512))
  const other = 'ef'.repeat(32)
  t.is(avatarKey(AUTHOR.toUpperCase(), d), avatarKey(AUTHOR, d), 'author lowercased')
  t.not(avatarKey(AUTHOR, d), avatarKey(other, d), 'per author')
  t.not(avatarKey(AUTHOR, d), avatarKey(AUTHOR, { ...d, mime: 'image/webp' }), 'per mime')

  const copy = avatarOf(d)
  t.alike(copy, d)
  t.not(copy, d, 'a fresh object')
  t.is(avatarOf({ ...d, width: 10 }), null)
  t.is(avatarOf(null), null)

  t.ok(sameAvatar(null, null))
  t.ok(sameAvatar(undefined, null))
  t.ok(sameAvatar(d, { ...d }))
  t.absent(sameAvatar(d, null))
  t.absent(sameAvatar(null, d))
  for (const k of Object.keys(d)) {
    t.absent(sameAvatar(d, { ...d, [k]: typeof d[k] === 'number' ? d[k] + 1 : d[k] + 'x' }), 'field ' + k)
  }
})

test('pickAvatar prefers a defined cached avatar, null included', async (t) => {
  const { pickAvatar } = await load()
  const a = descriptor(jpeg(512, 512))
  const b = descriptor(jpeg(512, 512), { core: 'ee'.repeat(32) })
  t.alike(pickAvatar({ avatar: a }, { avatar: b }), a)
  t.is(pickAvatar({ avatar: null }, { avatar: b }), null, 'a cached null wins')
  t.alike(pickAvatar({ avatar: undefined }, { avatar: b }), b, 'unknown falls back to the row')
  t.alike(pickAvatar(undefined, { avatar: b }), b)
  t.alike(pickAvatar(null, { avatar: b }), b)
  t.is(pickAvatar(null, null), null)
  t.is(pickAvatar(null, { avatar: { ...b, width: 1 } }), null, 'an invalid row value is none')
})

test('loadAvatarUrl returns a blob URL for verified still 512x512 bytes', async (t) => {
  const { loadAvatarUrl } = await load()
  const bytes = jpeg(512, 512)
  const d = descriptor(bytes)
  const io = deps(response(bytes))
  t.is(await loadAvatarUrl(AUTHOR, d, io), 'blob:test/image/jpeg')
  t.is(io.calls.length, 1)
  t.is(io.calls[0].url, '/media/' + AUTHOR + '/' + d.core + '/1/1')
  t.is(io.calls[0].opts.cache, 'force-cache', 'persisting by default')

  const webp = riff([vp8x(512, 512), vp8(512, 512)])
  const dw = descriptor(webp, { mime: 'image/webp' })
  t.is(await loadAvatarUrl(AUTHOR, dw, deps(response(webp))), 'blob:test/image/webp')
})

test('loadAvatarUrl uses no-store when persist is false', async (t) => {
  const { loadAvatarUrl } = await load()
  const bytes = jpeg(512, 512)
  const io = deps(response(bytes), { persist: false })
  await loadAvatarUrl(AUTHOR, descriptor(bytes), io)
  t.is(io.calls[0].opts.cache, 'no-store')
  const again = deps(response(bytes), { persist: false, fresh: true })
  await loadAvatarUrl(AUTHOR, descriptor(bytes), again)
  t.is(again.calls[0].opts.cache, 'no-store', 'retries too')
})

test('loadAvatarUrl failures: invalid ones are never retryable, a 404 is', async (t) => {
  const { loadAvatarUrl } = await load()
  const bytes = jpeg(512, 512)

  const invalid = deps(response(bytes))
  await t.exception(() => loadAvatarUrl(AUTHOR, descriptor(bytes, { width: 256 }), invalid), /foto inválida/)
  t.is(invalid.calls.length, 0, 'nothing fetched for an invalid descriptor')

  const cases = [
    ['SHA-256 mismatch', bytes, descriptor(bytes, { sha256: 'ee'.repeat(32) })],
    ['animated WebP', riff([vp8x(512, 512, 0x12), vp8(512, 512)]), null],
    ['wrong dimensions', jpeg(512, 256), null]
  ]
  for (const [name, body, given] of cases) {
    const d = given || descriptor(body, { mime: name === 'animated WebP' ? 'image/webp' : 'image/jpeg' })
    try {
      await loadAvatarUrl(AUTHOR, d, deps(response(body)))
      t.fail(name + ' should throw')
    } catch (err) {
      t.ok(err.retryable !== true, name + ' not retryable')
    }
  }

  try {
    await loadAvatarUrl(AUTHOR, descriptor(bytes), deps(response(new Uint8Array(0), 404)))
    t.fail('404 should throw')
  } catch (err) {
    t.is(err.retryable, true, '404 retryable')
  }
})
