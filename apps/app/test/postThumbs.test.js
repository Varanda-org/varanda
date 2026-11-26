'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')
const loadRaw = () => import('../src/postThumbs.js')
// The list alone; the stop signal has its own tests.
const load = async () => {
  const { buildPostThumbs } = await loadRaw()
  return { buildPostThumbs: async (input) => (await buildPostThumbs(input)).thumbs }
}

const ORIGINAL = { mime: 'image/avif', bytes: 90000, width: 1200, height: 900 }

function descriptor (built) {
  return {
    core: 'ab'.repeat(32),
    mime: built.mime,
    start: 1,
    blocks: Math.ceil(built.bytes.byteLength / 32768),
    bytes: built.bytes.byteLength,
    width: built.width,
    height: built.height,
    sha256: createHash('sha256').update(built.bytes).digest('hex')
  }
}

function rig (media = [ORIGINAL]) {
  const built = { bytes: new Uint8Array(40000), mime: 'image/jpeg', width: 640, height: 480 }
  const seen = { encodes: [], uploads: [] }
  return {
    media,
    held: media.map(item => item && { bytes: new Uint8Array(item.bytes), mime: item.mime }),
    built,
    seen,
    encodeThumbnail: async (...args) => { seen.encodes.push(args); return built },
    upload: async (image) => { seen.uploads.push(image); return descriptor(image) }
  }
}

test('post thumbs build with the caps and use the photo upload', async (t) => {
  const { buildPostThumbs } = await load()
  const r = rig()
  t.alike(await buildPostThumbs(r), [descriptor(r.built)])
  t.alike(r.seen.encodes, [[r.held[0].bytes, ORIGINAL.mime, { side: 640, maxBytes: 65536 }]])
  t.is(r.seen.encodes[0][0], r.held[0].bytes)
  t.alike(r.seen.uploads, [r.built])
})

test('post thumbs reject a mismatched hash, size, sides or MIME', async (t) => {
  const { buildPostThumbs } = await load()
  const otherHash = createHash('sha256').update(new Uint8Array(40000).fill(1)).digest('hex')
  for (const change of [{ sha256: otherHash }, { bytes: 39999 }, { width: 639 }, { height: 479 }, { mime: 'image/png' }]) {
    const r = rig()
    r.upload = async (built) => { r.seen.uploads.push(built); return { ...descriptor(built), ...change } }
    t.is(await buildPostThumbs(r), null)
    t.is(r.seen.uploads.length, 1, 'no second upload')
  }
})

test('post thumbs keep media length and order through skips and failures', async (t) => {
  const { buildPostThumbs } = await load()
  const r = rig([
    { ...ORIGINAL, mime: 'image/gif' },
    ORIGINAL,
    { ...ORIGINAL, bytes: 65536, width: 640, height: 640 },
    ORIGINAL,
    ORIGINAL
  ])
  r.upload = async (built) => {
    r.seen.uploads.push(built)
    if (r.seen.uploads.length === 2) throw new Error('upload failed')
    return descriptor(built)
  }
  const thumbs = await buildPostThumbs(r)
  t.is(thumbs.length, r.media.length)
  t.alike(thumbs, [null, descriptor(r.built), null, null, descriptor(r.built)])
  t.is(r.seen.encodes.length, 3)
  t.is(r.seen.uploads.length, 3, 'a failed item is not retried')
})

test('post thumbs return null for all skipped entries including a video pair', async (t) => {
  const { buildPostThumbs } = await load()
  for (const media of [
    [],
    [{ ...ORIGINAL, mime: 'image/gif' }],
    [{ ...ORIGINAL, bytes: 65536, width: 640, height: 640 }],
    [{ ...ORIGINAL, mime: 'image/jpeg' }, { mime: 'video/mp4', bytes: 100000, width: 1200, height: 900 }]
  ]) {
    const r = rig(media)
    t.is(await buildPostThumbs(r), null)
    t.is(r.seen.encodes.length, 0)
    t.is(r.seen.uploads.length, 0)
  }
})

test('post thumbs build when either cap is exceeded, for every still MIME', async (t) => {
  const { buildPostThumbs } = await load()
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/avif']) {
    for (const change of [{ bytes: 65537 }, { width: 641 }, { height: 641 }]) {
      const r = rig([{ mime, bytes: 65536, width: 640, height: 640, ...change }])
      r.built.bytes = new Uint8Array(65536)
      r.built.height = 640
      t.alike(await buildPostThumbs(r), [descriptor(r.built)])
      t.is(r.seen.encodes.length, 1)
    }
  }
})

test('post thumbs absorb definite failures and rejected uploads without retrying', async (t) => {
  const { buildPostThumbs } = await load()
  for (const fail of [
    () => { throw new Error('upload failed') },
    async () => { throw Object.assign(new Error('refused'), { uncertain: false }) },
    async () => null,
    async () => ({})
  ]) {
    const r = rig()
    r.upload = (built) => { r.seen.uploads.push(built); return fail() }
    t.is(await buildPostThumbs(r), null, 'resolves without throwing')
    t.is(r.seen.uploads.length, 1)
  }
})

test('post thumbs never upload a failed or invalid build', async (t) => {
  const { buildPostThumbs } = await load()
  const { built } = rig()
  for (const out of [
    null,
    {},
    { ...built, bytes: 40000 },
    { ...built, bytes: new Uint8Array(0) },
    { ...built, bytes: new Uint8Array(65537) },
    { ...built, width: 641 },
    { ...built, height: 641 },
    { ...built, width: 0 },
    { ...built, height: 1.5 },
    { ...built, mime: 'image/gif' }
  ]) {
    const r = rig()
    r.encodeThumbnail = async () => out
    t.is(await buildPostThumbs(r), null)
    t.is(r.seen.uploads.length, 0)
  }
  const r = rig([ORIGINAL, ORIGINAL])
  r.encodeThumbnail = async (...args) => {
    r.seen.encodes.push(args)
    if (r.seen.encodes.length === 1) throw new Error('decode failed')
    return r.built
  }
  t.alike(await buildPostThumbs(r), [null, descriptor(r.built)])
  t.is(r.seen.encodes.length, 2)
  t.is(r.seen.uploads.length, 1)
})

test('post thumbs tolerate missing input or unavailable held bytes', async (t) => {
  const { buildPostThumbs } = await load()
  for (const input of [undefined, null, {}, { media: [] }]) t.is(await buildPostThumbs(input), null)
  for (const held of [[], [null], [{ bytes: new Uint8Array(1), mime: ORIGINAL.mime }], [{ bytes: new Uint8Array(90000), mime: 'image/png' }]]) {
    const r = rig()
    r.held = held
    t.is(await buildPostThumbs(r), null)
    t.is(r.seen.encodes.length, 0)
    t.is(r.seen.uploads.length, 0)
  }
})

function lost (retry) {
  return Object.assign(new Error('lost answer'), { uncertain: true, retry })
}

test('post thumbs stop on an uncertain upload and keep its retry and the finished ones', async (t) => {
  const { buildPostThumbs } = await loadRaw()
  const r = rig([ORIGINAL, ORIGINAL, ORIGINAL])
  const retry = async () => ({ descriptor: descriptor(r.built) })
  r.upload = async (built) => {
    r.seen.uploads.push(built)
    if (r.seen.uploads.length === 2) throw lost(retry)
    return descriptor(built)
  }
  const kept = []
  r.keep = (i, entry) => { kept[i] = entry }
  const out = await buildPostThumbs(r)
  t.is(out.stopped, true)
  t.is(out.thumbs, null, 'no post list while stopped')
  t.is(r.seen.uploads.length, 2, 'the third photo is not tried')
  t.alike(kept[0], { image: descriptor(r.built) })
  t.is(kept[1].retry, retry, 'the very same retry')
  t.alike(kept[1].expect, { mime: 'image/jpeg', bytes: 40000, width: 640, height: 480, sha256: descriptor(r.built).sha256 })
  t.is(kept.length, 2)

  // Next tap: the done thumbnail is not built again, the retry is resent
  // (no encode, no new signature) and the rest goes on.
  const again = rig([ORIGINAL, ORIGINAL, ORIGINAL])
  let resent = 0
  again.kept = kept
  again.resend = async (fn) => { resent++; return (await fn()).descriptor }
  const next = []
  again.keep = (i, entry) => { next[i] = entry }
  const done = await buildPostThumbs(again)
  t.is(done.stopped, false)
  t.alike(done.thumbs, [descriptor(r.built), descriptor(r.built), descriptor(r.built)])
  t.is(resent, 1)
  t.is(again.seen.encodes.length, 1, 'only the third photo is encoded')
  t.is(again.seen.uploads.length, 1, 'only the third photo is signed and uploaded')
  t.alike(next[1], { image: descriptor(r.built) }, 'the resent one is now kept as done')
})

test('post thumbs stop on an uncertain upload that has no retry and keep nothing for it', async (t) => {
  const { buildPostThumbs } = await loadRaw()
  const r = rig([ORIGINAL, ORIGINAL])
  r.upload = async (built) => { r.seen.uploads.push(built); throw lost() }
  const kept = ['old']
  r.keep = (i, entry) => { kept[i] = entry }
  const out = await buildPostThumbs(r)
  t.alike(out, { thumbs: null, stopped: true })
  t.is(kept[0], null)
  t.is(r.seen.uploads.length, 1)
})

test('post thumbs treat a kept retry that fails for good or answers wrongly as a missing thumbnail', async (t) => {
  const { buildPostThumbs } = await loadRaw()
  const good = rig()
  const expect = { mime: 'image/jpeg', bytes: 40000, width: 640, height: 480, sha256: descriptor(good.built).sha256 }
  for (const resend of [
    async () => { throw new Error('refused') },
    async () => ({ ...descriptor(good.built), sha256: 'cd'.repeat(32) }),
    async () => null
  ]) {
    const r = rig([ORIGINAL, ORIGINAL])
    r.kept = [{ retry: () => {}, expect }]
    r.resend = resend
    const kept = []
    r.keep = (i, entry) => { kept[i] = entry }
    const out = await buildPostThumbs(r)
    t.is(out.stopped, false, 'the post is not blocked')
    t.alike(out.thumbs, [null, descriptor(r.built)])
    t.is(kept[0], null, 'the failed retry is dropped')
    t.is(r.seen.uploads.length, 1, 'only the second photo is uploaded')
  }
  // Again uncertain: the new retry replaces the old one.
  const r = rig()
  const next = async () => ({})
  r.kept = [{ retry: () => {}, expect }]
  r.resend = async () => { throw lost(next) }
  const kept = []
  r.keep = (i, entry) => { kept[i] = entry }
  t.is((await buildPostThumbs(r)).stopped, true)
  t.is(kept[0].retry, next)
  t.is(r.seen.encodes.length, 0)
})

test('post thumbs keep an uploaded thumbnail even if the photo no longer builds one', async (t) => {
  const { buildPostThumbs } = await loadRaw()
  const r = rig()
  const image = descriptor(r.built)
  r.kept = [{ image }]
  r.encodeThumbnail = async () => { throw new Error('must not encode') }
  const out = await buildPostThumbs(r)
  t.alike(out, { thumbs: [image], stopped: false })
  t.is(r.seen.uploads.length, 0)
})
