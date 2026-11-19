'use strict'

// Cover planning (src/media/shareCover.js). Fakes only: no encoder, no network.
const test = require('brittle')

const load = () => import('../src/media/shareCover.js')

const jpeg = (bytes, extra) => ({ mime: 'image/jpeg', bytes, width: 800, height: 600, ...extra })
const still = (mime, bytes, extra) => ({ mime, bytes, width: 800, height: 600, ...extra })
const video = { mime: 'video/mp4', bytes: 8000, width: 1280, height: 720, ms: 4000 }

test('cover constants are the side, the byte cap and the encode target', async (t) => {
  const plan = await load()
  t.is(plan.SHARE_COVER_SIDE, 1200)
  t.is(plan.MAX_SHARE_COVER_BYTES, 262144)
  t.is(plan.COVER_TARGET_BYTES, 204800)
  t.ok(plan.COVER_TARGET_BYTES < plan.MAX_SHARE_COVER_BYTES, 'the encode target sits under the cap')
  t.ok(plan.COVER_TARGET_BYTES > 0)
})

test('cover constants match the rpc contract', async (t) => {
  const plan = await load()
  const rpc = require('@varanda/rpc')
  t.is(plan.SHARE_COVER_SIDE, rpc.MAX_SHARE_COVER_SIDE, 'side')
  t.is(plan.MAX_SHARE_COVER_BYTES, rpc.MAX_SHARE_COVER_BYTES, 'byte cap')
  t.ok(plan.COVER_TARGET_BYTES < rpc.MAX_SHARE_COVER_BYTES, 'the encode target sits under the contract cap')
  // A cover the encoder hands back must fit the descriptor's block cap too.
  t.ok(rpc.MAX_SHARE_COVER_BLOCKS * rpc.MEDIA_BLOCK_BYTES >= rpc.MAX_SHARE_COVER_BYTES, 'the byte cap fits in the block cap')
})

test('coverSource: no source', async (t) => {
  const { coverSource, needsCover } = await load()
  const absent = [null, undefined, 0, 1, '', 'post', true, false, [], () => {}, { media: null }, { media: {} }, { media: [] }, { preview: { image: jpeg(10) } }]
  for (const bad of absent) {
    t.is(coverSource(bad), null, 'no source: ' + Object.prototype.toString.call(bad))
    t.is(needsCover(bad), false, 'needs nothing: ' + Object.prototype.toString.call(bad))
  }
  const onlyVideo = { media: [video] }
  t.is(coverSource(onlyVideo), null, 'a video with no poster')
  t.is(needsCover(onlyVideo), false, 'a video with no poster needs no cover')
  const voice = { media: [{ mime: 'audio/mp4', bytes: 1000, width: 0, height: 0 }] }
  t.is(coverSource(voice), null, 'a voice note is not a still')
  t.is(needsCover(voice), false)
  const unknown = { media: [{ mime: 'image/heic', bytes: 10 }, { mime: 'image/svg+xml', bytes: 10 }, { mime: 'IMAGE/JPEG', bytes: 10 }] }
  t.is(coverSource(unknown), null, 'only the still mimes')
  const tooMany = { media: [] }
  for (let i = 0; i < 11; i++) tooMany.media.push(jpeg(10))
  t.is(coverSource(tooMany), null, 'more than a post may carry')
  t.is(needsCover(tooMany), false)
})

test('coverSource: first still in media order, and a video post uses its JPEG poster', async (t) => {
  const { coverSource, needsCover } = await load()
  const first = jpeg(20)
  const second = still('image/png', 30)
  t.is(coverSource({ media: [first, second] }), first, 'media order, not the later still')
  const skipped = [null, 1, 'image/jpeg', { mime: 1 }, { mime: 'image/heic', bytes: 5 }, video]
  const after = still('image/webp', 40)
  t.is(coverSource({ media: [...skipped, after, second] }), after, 'the first real still, after a video')
  const hole = []
  hole[1] = jpeg(7)
  t.is(coverSource({ media: hole }), hole[1], 'a hole is not a still')
  const poster = jpeg(500, { width: 320, height: 180 })
  const clip = { media: [poster, video] }
  t.is(coverSource(clip), poster, 'the JPEG poster, not the video')
  const avif = still('image/avif', 80)
  const laterJpeg = jpeg(80)
  t.is(coverSource({ media: [avif, laterJpeg] }), avif, 'AVIF is a still and stays first')
  const gif = still('image/gif', 80)
  t.is(coverSource({ media: [gif, laterJpeg] }), gif, 'GIF is a still')
  const ten = []
  for (let i = 0; i < 10; i++) ten.push(jpeg(i + 1))
  t.is(coverSource({ media: ten }), ten[0], 'ten photos, the first')
  const poisoned = {}
  Object.defineProperty(poisoned, 'media', { get () { throw new Error('media') } })
  t.is(coverSource(poisoned), null, 'a throwing media field')
  t.is(needsCover(poisoned), false, 'a throwing media field needs nothing')
})

test('needsCover: a small JPEG, PNG or WebP needs no cover', async (t) => {
  const { needsCover, MAX_SHARE_COVER_BYTES } = await load()
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    t.is(needsCover({ media: [still(mime, 1)] }), false, mime + ' of 1 byte')
    t.is(needsCover({ media: [still(mime, MAX_SHARE_COVER_BYTES)] }), false, mime + ' at the cap')
    t.is(needsCover({ media: [still(mime, new Uint8Array(32))] }), false, mime + ' bytes already fetched')
    t.is(needsCover({ media: [still(mime, 4000, { width: 4000, height: 3000 })] }), false, mime + ' wider than the cover side')
  }
  const poster = jpeg(1000, { width: 1920, height: 1080 })
  t.is(needsCover({ media: [poster, video] }), false, 'a small JPEG poster')
})

test('needsCover: AVIF, GIF and an oversize JPEG need a cover', async (t) => {
  const { coverSource, needsCover, MAX_SHARE_COVER_BYTES } = await load()
  t.is(needsCover({ media: [still('image/avif', 1)] }), true, 'a tiny AVIF')
  t.is(needsCover({ media: [still('image/avif', MAX_SHARE_COVER_BYTES)] }), true, 'an AVIF at the cap')
  t.is(needsCover({ media: [still('image/avif', 50), jpeg(50)] }), true, 'the first still wins over a later JPEG')
  t.is(needsCover({ media: [still('image/gif', 50)] }), true, 'a small GIF')
  t.is(needsCover({ media: [jpeg(MAX_SHARE_COVER_BYTES + 1)] }), true, 'oversize JPEG')
  t.is(needsCover({ media: [still('image/png', MAX_SHARE_COVER_BYTES + 1)] }), true, 'oversize PNG')
  t.is(needsCover({ media: [still('image/webp', new Uint8Array(MAX_SHARE_COVER_BYTES + 1))] }), true, 'oversize fetched WebP')
  const poster = jpeg(MAX_SHARE_COVER_BYTES + 1, { width: 1920, height: 1080 })
  t.is(needsCover({ media: [poster, video] }), true, 'an oversize JPEG poster')
  for (const bytes of [0, -1, 1.5, NaN, Infinity, undefined, null, '10']) {
    t.is(needsCover({ media: [jpeg(bytes)] }), true, 'not a usable size: ' + bytes)
  }
  const hostile = { mime: 'image/jpeg', width: 10, height: 10 }
  Object.defineProperty(hostile, 'bytes', { get () { throw new Error('bytes') } })
  t.is(coverSource({ media: [hostile] }), hostile, 'the still is still the source')
  t.is(needsCover({ media: [hostile] }), false, 'a throwing size does not escape')
})

test('validShareCover: a JPEG inside the side and the byte cap', async (t) => {
  const { validShareCover, SHARE_COVER_SIDE, MAX_SHARE_COVER_BYTES, COVER_TARGET_BYTES } = await load()
  const fit = (extra) => ({ mime: 'image/jpeg', bytes: new Uint8Array(10), width: 1200, height: 630, ...extra })
  t.is(validShareCover(fit({})), true, 'image/jpeg')
  t.is(validShareCover(fit({ bytes: 10 })), true, 'image/jpeg counted on a descriptor')
  for (const mime of ['image/png', 'image/webp', 'image/avif', 'image/gif']) {
    t.is(validShareCover(fit({ mime })), false, mime + ' is not a cover the record accepts')
  }
  t.is(validShareCover(fit({ bytes: new Uint8Array(MAX_SHARE_COVER_BYTES), width: 1, height: 1 })), true, 'the cap itself')
  t.is(validShareCover(fit({ bytes: new Uint8Array(COVER_TARGET_BYTES + 1) })), true, 'over the encode target, under the cap')
  t.is(validShareCover(fit({ width: SHARE_COVER_SIDE, height: SHARE_COVER_SIDE })), true, 'the side itself')
  for (const bad of [null, undefined, 0, 'cover', true, [], () => {}]) {
    t.is(validShareCover(bad), false, 'not a cover: ' + Object.prototype.toString.call(bad))
  }
  const rejected = [
    fit({ mime: 'image/avif' }),
    fit({ mime: 'image/gif' }),
    fit({ mime: 'image/jpeg ' }),
    fit({ mime: 'IMAGE/JPEG' }),
    fit({ mime: '' }),
    fit({ bytes: new Uint8Array(0) }),
    fit({ bytes: 0 }),
    fit({ bytes: new Uint8Array(MAX_SHARE_COVER_BYTES + 1) }),
    fit({ bytes: MAX_SHARE_COVER_BYTES + 1 }),
    fit({ bytes: -5 }),
    fit({ bytes: 1.5 }),
    fit({ width: 0 }),
    fit({ height: 0 }),
    fit({ width: SHARE_COVER_SIDE + 1 }),
    fit({ height: SHARE_COVER_SIDE + 1 }),
    fit({ width: 1.5 }),
    fit({ height: NaN }),
    fit({ width: undefined }),
    { mime: 'image/jpeg', bytes: new Uint8Array(10), width: 10 },
    { mime: 'image/jpeg', width: 10, height: 10 }
  ]
  for (let i = 0; i < rejected.length; i++) t.is(validShareCover(rejected[i]), false, 'rejected ' + i)
  // A photo the page can name as-is may be wider than a generated cover.
  t.is(validShareCover(fit({ bytes: 1000, width: 4000, height: 3000 })), false, 'wider than the cover side')
  const tricky = { width: 1, height: 1 }
  Object.defineProperty(tricky, 'mime', { get () { throw new Error('mime') } })
  t.is(validShareCover(tricky), false, 'a throwing field is not a cover')
})

test('buildCover: encoder returns null', async (t) => {
  const { buildCover, SHARE_COVER_SIDE, COVER_TARGET_BYTES } = await load()
  let seen = null
  const out = await buildCover({
    bytes: new Uint8Array([9]),
    mime: 'image/avif',
    encodeThumbnail: async (bytes, mime, opts) => {
      seen = { bytes, mime, opts }
      return null
    }
  })
  t.is(out, null)
  t.is(seen.mime, 'image/avif')
  t.is(seen.bytes[0], 9)
  t.alike(seen.opts, { side: SHARE_COVER_SIDE, maxBytes: COVER_TARGET_BYTES })
  t.is(await buildCover({ bytes: new Uint8Array([1]), mime: 'image/jpeg', encodeThumbnail: async () => undefined }), null)
  t.is(await buildCover({ bytes: new Uint8Array([1]), mime: 'image/jpeg', encodeThumbnail: async () => ({}) }), null)
  t.is(await buildCover({ bytes: new Uint8Array([1]), mime: 'image/jpeg', encodeThumbnail: async () => 0 }), null)
})

test('buildCover: encoder throws', async (t) => {
  const { buildCover } = await load()
  const thrown = await buildCover({
    bytes: new Uint8Array([1]),
    mime: 'image/jpeg',
    encodeThumbnail: async () => { throw new Error('decode') }
  })
  t.is(thrown, null, 'a rejected encode is no cover')
  const sync = await buildCover({
    bytes: new Uint8Array([1]),
    mime: 'image/png',
    encodeThumbnail: () => { throw new Error('sync') }
  })
  t.is(sync, null, 'a synchronous throw is no cover')
  t.is(await buildCover(), null, 'no arguments')
  t.is(await buildCover(null), null, 'null input')
  t.is(await buildCover({}), null, 'no encoder')
  t.is(await buildCover({ bytes: new Uint8Array([1]), mime: 'image/jpeg', encodeThumbnail: 'nope' }), null, 'encoder is not a function')
  const hostile = {}
  Object.defineProperty(hostile, 'encodeThumbnail', { get () { throw new Error('encoder') } })
  t.is(await buildCover(hostile), null, 'a throwing encoder field')
})

test('buildCover returns the encoded cover and drops one that misses the box', async (t) => {
  const { buildCover, validShareCover, SHARE_COVER_SIDE, MAX_SHARE_COVER_BYTES, COVER_TARGET_BYTES } = await load()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const encoded = { bytes: new Uint8Array(100), mime: 'image/jpeg', width: 1200, height: 630, extra: true }
  let seen
  const out = await buildCover({
    bytes,
    mime: 'image/avif',
    encodeThumbnail: async (b, mime, opts) => {
      seen = { b, mime, opts }
      return encoded
    }
  })
  t.is(seen.b, bytes, 'the caller chooses the bytes')
  t.is(seen.mime, 'image/avif')
  t.alike(seen.opts, { side: SHARE_COVER_SIDE, maxBytes: COVER_TARGET_BYTES })
  t.alike(out, { bytes: encoded.bytes, mime: 'image/jpeg', width: 1200, height: 630 })
  t.is(out.extra, undefined, 'only the cover fields')
  t.is(validShareCover(out), true)
  const between = new Uint8Array(COVER_TARGET_BYTES + 1)
  const kept = await buildCover({
    encodeThumbnail: async () => ({ bytes: between, mime: 'image/jpeg', width: 10, height: 10 })
  })
  t.is(kept.bytes, between, 'over the target and under the cap is kept')
  t.is(kept.mime, 'image/jpeg')
  const png = await buildCover({
    encodeThumbnail: async () => ({ bytes: new Uint8Array(10), mime: 'image/png', width: 10, height: 10 })
  })
  t.is(png, null, 'the record takes only a JPEG cover')
  const over = await buildCover({
    encodeThumbnail: async () => ({ bytes: new Uint8Array(MAX_SHARE_COVER_BYTES + 1), mime: 'image/jpeg', width: 10, height: 10 })
  })
  t.is(over, null, 'over the cap')
  const wide = await buildCover({
    encodeThumbnail: async () => ({ bytes: new Uint8Array(10), mime: 'image/jpeg', width: SHARE_COVER_SIDE + 1, height: 10 })
  })
  t.is(wide, null, 'past the side')
  const counted = await buildCover({
    encodeThumbnail: async () => ({ bytes: 10, mime: 'image/jpeg', width: 10, height: 10 })
  })
  t.is(counted, null, 'a count is not uploadable bytes')
  const avif = await buildCover({
    encodeThumbnail: async () => ({ bytes: new Uint8Array(10), mime: 'image/avif', width: 10, height: 10 })
  })
  t.is(avif, null, 'the encode must not come back as AVIF')
})
