'use strict'

const test = require('brittle')
const load = () => import('../src/media/variant.js')
const full = Object.freeze({ core: 'a'.repeat(64), start: 1, blocks: 2, bytes: 40000, sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 1200, height: 800 })
const thumb = Object.freeze({ ...full, start: 3, blocks: 1, bytes: 10000, sha256: 'c'.repeat(64), width: 640, height: 427 })
const media = Object.freeze([full, full])

test('old posts and null thumbnails pick full size', async t => {
  const { pickVariant } = await load()
  for (const thumbs of [undefined, null, [], [null]]) {
    t.alike(pickVariant({ media, thumbs, index: 0, widthPx: 320, dpr: 2 }), [full])
  }
})

test('thumbnail comes first up to and including 640 physical pixels', async t => {
  const { pickVariant } = await load()
  const thumbs = Object.freeze([thumb, null])
  for (const [widthPx, dpr] of [[320, 1], [320, 2], [640, 1], [160, 4]]) {
    const order = pickVariant({ media, thumbs, index: 0, widthPx, dpr })
    t.is(order[0], thumb)
    t.is(order[1], full)
    t.is(order.length, 2)
  }
})

test('larger physical widths pick full size', async t => {
  const { pickVariant } = await load()
  for (const [widthPx, dpr] of [[321, 2], [640, 2], [641, 1]]) {
    t.alike(pickVariant({ media, thumbs: [thumb, null], index: 0, widthPx, dpr }), [full])
  }
})

test('thumbnail selection preserves index alignment and inputs', async t => {
  const { pickVariant } = await load()
  const thumbs = Object.freeze([null, thumb])
  const args = Object.freeze({ media, thumbs, index: 1, widthPx: 320, dpr: 1 })
  const order = pickVariant(args)
  t.alike(order, [thumb, full])
  order.pop()
  t.alike(pickVariant(args), [thumb, full])
  t.alike(pickVariant({ ...args, index: 0 }), [full])
})

test('the reader rule: misaligned lists, video pairs and non-still slots pick full size', async t => {
  const { pickVariant } = await load()
  t.alike(pickVariant({ media, thumbs: [thumb], index: 0, widthPx: 320, dpr: 2 }), [full], 'thumbs shorter than media')
  const poster = full
  const clip = Object.freeze({ ...full, mime: 'video/mp4' })
  t.alike(pickVariant({ media: [poster, clip], thumbs: [thumb, null], index: 0, widthPx: 320, dpr: 1 }), [poster], 'a video pair never uses a thumbnail')
  t.alike(pickVariant({ media: [clip], thumbs: [thumb], index: 0, widthPx: 320, dpr: 1 }), [clip], 'a clip slot')
  t.alike(pickVariant({ media, thumbs: [thumb, null], index: 0, widthPx: NaN, dpr: 1 }), [full], 'unknown width')
})

test('pickVariant never uses a thumbnail that breaks the protocol limits', async (t) => {
  const { pickVariant, validThumb } = await load()
  t.ok(validThumb(thumb))
  const bad = [
    { ...thumb, bytes: 65537, blocks: 3 },
    { ...thumb, width: 641 },
    { ...thumb, height: 641 },
    { ...thumb, mime: 'image/png' },
    { ...thumb, sha256: 'x' },
    { ...thumb, start: 0 },
    { ...thumb, extra: 1 }
  ]
  for (const d of bad) {
    t.absent(validThumb(d), JSON.stringify(d))
    t.alike(pickVariant({ media, thumbs: [d, null], index: 0, widthPx: 320, dpr: 1 }), [full], 'full size instead')
  }
})

test('validThumbs: aligned, at least one thumbnail, never beside a video', async (t) => {
  const { validThumbs } = await load()
  t.ok(validThumbs([thumb, null], media))
  t.ok(validThumbs([null, thumb], media))
  t.absent(validThumbs([null, null], media), 'all null')
  t.absent(validThumbs([thumb], media), 'shorter')
  t.absent(validThumbs([thumb, null, null], media), 'longer')
  t.absent(validThumbs(new Array(2), media), 'holes')
  t.absent(validThumbs([thumb, undefined], media), 'undefined entry')
  t.absent(validThumbs(null, media))
  t.absent(validThumbs([thumb, null], [full, { ...full, mime: 'video/mp4' }]), 'video pair')
})

test('a row tile waits for its width, then requests only the thumbnail', async (t) => {
  const { rowVariants, MAX_THUMB_BYTES } = await load()
  const thumbs = Object.freeze([thumb, null])
  t.is(rowVariants({ media, thumbs, index: 0, widthPx: 0, dpr: 3 }), null, 'nothing before the width is known')
  const order = rowVariants({ media, thumbs, index: 0, widthPx: 200, dpr: 3 })
  t.is(order[0], thumb, 'the first request is the thumbnail')
  t.ok(order[0].bytes <= MAX_THUMB_BYTES)
  t.alike(rowVariants({ media, thumbs, index: 1, widthPx: 0, dpr: 3 }), [full], 'a slot without a thumbnail loads the full size at once')
  t.alike(rowVariants({ media, thumbs: undefined, index: 0, widthPx: 0, dpr: 3 }), [full], 'an old post loads the full size at once')
  t.alike(rowVariants({ media, thumbs, index: 0, widthPx: 400, dpr: 3 }), [full], 'a wide tile loads the full size')
})

test('a thumbnail that fails its hash check falls back to full size once', async (t) => {
  const { createHash, webcrypto } = require('node:crypto')
  const { rowVariants, nextVariant } = await load()
  const { fetchMedia } = await import('../src/media/fetch.js')
  const { retryDelay } = await import('../src/media/cache.js')
  const jpeg = (n, fill) => {
    const b = new Uint8Array(n).fill(fill)
    b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])
    return b
  }
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  const big = jpeg(40000, 1)
  const small = jpeg(10000, 2)
  const real = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 2, bytes: big.byteLength, sha256: sha(big), width: 1200, height: 800 }
  const tiny = { ...real, start: 3, blocks: 1, bytes: small.byteLength, sha256: 'ee'.repeat(32), width: 640, height: 427 }
  const order = rowVariants({ media: [real], thumbs: [tiny], index: 0, widthPx: 300, dpr: 2 })
  t.alike(order, [tiny, real])
  const asked = []
  const body = (b) => {
    let done = false
    const read = async () => {
      if (done) return { done: true }
      done = true
      return { done: false, value: b }
    }
    return { status: 200, redirected: false, body: { getReader: () => ({ read, cancel: async () => {} }) } }
  }
  const fetch = async (url) => {
    asked.push(url)
    return body(url.endsWith('/3/1') ? small : big)
  }
  const deps = { fetch, subtle: webcrypto.subtle }
  const author = 'ab'.repeat(32)
  let step = 0
  let err = null
  try { await fetchMedia(author, order[step], deps) } catch (e) { err = e }
  t.ok(err, 'the thumbnail bytes do not match its hash')
  t.is(retryDelay(err, 0), null, 'a mismatch is not retried')
  step = nextVariant(order, step)
  t.is(step, 1, 'the full size comes next')
  const bytes = await fetchMedia(author, order[step], deps)
  t.is(bytes.byteLength, big.byteLength, 'the full size loads and passes its own check')
  t.is(nextVariant(order, step), null, 'no further fallback')
  t.is(asked.length, 2, 'one thumbnail request, one full size request')
  t.ok(asked[0].endsWith('/3/1') && asked[1].endsWith('/1/2'))
})

test('MediaView wiring: thumbnail first in rows, never in the viewer', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
  const view = read('ui/MediaView.js')
  t.ok(view.includes('const order = variants ? rowVariants({ media: postMedia, thumbs, index, widthPx, dpr }) : null'), 'order from the measured width')
  t.ok(view.includes('const { d: rowActive, final: thumbStep } = mainRequest(variants ? order : null, step)'), 'nothing fetched while waiting')
  t.ok(view.includes('const active = !variants ? descriptor : rowActive'))
  t.ok(view.includes('useMedia(author, local ? null : active, '), 'the active descriptor goes through the verified loader')
  t.ok(view.includes("if (!variants || order === null || fetched.state !== 'error') return"), 'falls back only on a failed load')
  t.ok(view.includes('setFallback((f) => failStep(f, orderKey, order, step))'), 'one step at most, through the pure failStep')
  t.ok(view.includes('if (delay === null || errorIsFinal(err, isThumb)) {'), 'a thumbnail error ends the load')
  t.ok(view.includes('validate: isThumb ? thumbBytesOk : undefined'), 'thumbnail bytes pass the decoded bounds check')
  t.ok(view.includes('    const isThumb = thumb\n'), 'the flag is read when the load is set up, not when it leaves the queue')
  t.absent(view.includes('thumbRef'), 'no lazy ref read')
  t.ok(view.includes("fullAtHand = useMemo(() => full !== null && (Boolean(cache.peek(fullKey)) || keptOnlyUrl('posts', author, full, keep) !== null)"), 'a full size at hand skips the underlay')
  t.ok(view.includes('const below = useMedia(author, under, keep, true)'), 'the underlay is a final thumbnail load')
  t.ok(view.includes('onShown={showUnder ? () => setFadedUrl(url) : undefined}'), 'the underlay unmounts after the fade-in')
  t.ok(view.includes("const thumbBytesOk = (bytes) => thumbBoundsOk(rpc.mediaBounds(bytes, 'image/jpeg'))"), 'decoded headers, not the descriptor')
  t.ok(view.includes('onError={broken}'), 'a bitmap that does not decode falls back too')
  t.ok(view.includes('order.length === 1 ? underlayFor({ media: postMedia, thumbs, index, widthPx, dpr }) : null'), 'the underlay only beside the full size alone')
  t.ok(view.includes("firstKept(order, (d) => keptOnlyUrl('posts', author, d, keep) !== null)"), 'kept-only shows any kept step')
  const grid = read('ui/MediaGrid.js')
  const viewer = grid.slice(grid.indexOf('function Viewer'), grid.indexOf('function useVideoClip'))
  t.absent(viewer.includes('thumbs'), 'the full-screen viewer gets no thumbs')
  t.ok(grid.includes('postMedia={media}\n      thumbs={thumbs}\n      index={i}'), 'grid tiles get the post thumbs')
  t.ok(read('ui/PostRow.js').includes('media={media} thumbs={thumbs}'), 'PostRow hands them to MediaGrid')
})

test('a GIF slot keeps its motion: no thumbnail, no underlay', async (t) => {
  const { pickVariant, underlayFor } = await load()
  const gif = { ...full, mime: 'image/gif' }
  const slot = { media: [gif], thumbs: [thumb], index: 0, dpr: 1 }
  t.alike(pickVariant({ ...slot, widthPx: 320 }), [gif], 'the GIF itself at a small width')
  t.is(underlayFor({ ...slot, widthPx: 1080 }), null, 'and nothing beneath it at a large one')
  const png = { ...full, mime: 'image/png' }
  t.alike(pickVariant({ media: [png], thumbs: [thumb], index: 0, widthPx: 320, dpr: 1 }), [thumb, png], 'positive control: a PNG still takes it')
})

test('a wide slot loads the full size over its thumbnail', async (t) => {
  const { pickVariant, underlayFor } = await load()
  const thumbs = [thumb, null]
  t.alike(pickVariant({ media, thumbs, index: 0, widthPx: 393, dpr: 3 }), [full], 'a phone row loads the full size')
  t.is(underlayFor({ media, thumbs, index: 0, widthPx: 393, dpr: 3 }), thumb, 'with the thumbnail beneath')
  t.is(underlayFor({ media, thumbs, index: 0, widthPx: 640, dpr: 1 }), null, '640 px uses the thumbnail itself, no underlay')
  t.is(underlayFor({ media, thumbs, index: 0, widthPx: 641, dpr: 1 }), thumb, '641 px underlays')
  t.is(underlayFor({ media, thumbs, index: 1, widthPx: 641, dpr: 1 }), null, 'a null slot does not')
  t.is(underlayFor({ media, thumbs: [{ ...thumb, width: 641 }, null], index: 0, widthPx: 1080, dpr: 1 }), null, 'never an invalid thumbnail')
  t.is(underlayFor({ media: [{ ...full, mime: 'video/mp4' }, full], thumbs, index: 1, widthPx: 1080, dpr: 1 }), null, 'never beside a video')
})

test('pickVariant nits: same bytes, an invalid full size, no width', async (t) => {
  const { pickVariant } = await load()
  const same = { ...thumb, core: full.core, start: full.start, blocks: full.blocks, sha256: full.sha256 }
  t.alike(pickVariant({ media: [full], thumbs: [same], index: 0, widthPx: 320, dpr: 1 }), [full], 'a thumbnail that is the full size is tried once')
  const bad = { ...full, start: 0 }
  t.alike(pickVariant({ media: [bad], thumbs: [thumb], index: 0, widthPx: 320, dpr: 1 }), [bad], 'no thumbnail before an invalid full size')
  for (const [widthPx, dpr] of [[0, 2], [-1, 1], [320, 0], [NaN, 1], [Infinity, 1]]) {
    t.alike(pickVariant({ media: [full], thumbs: [thumb], index: 0, widthPx, dpr }), [full], 'no thumbnail at ' + widthPx + ' x ' + dpr)
  }
})

test('the fallback state machine: one step forward, stale failures ignored, a new order restarts', async (t) => {
  const { currentStep, failStep } = await load()
  const order = [thumb, full]
  let state = { key: '', step: 0 }
  t.is(currentStep(state, 'k'), 0, 'a new order starts at its first step')
  state = failStep(state, 'k', order, 0)
  t.alike(state, { key: 'k', step: 1 }, 'a failed thumbnail moves to the full size')
  t.is(currentStep(state, 'k'), 1)
  t.is(failStep(state, 'k', order, 0), state, 'a late failure of the thumbnail changes nothing')
  t.is(failStep(state, 'k', order, 1), state, 'the full size is the last step')
  t.is(currentStep(state, 'other'), 0, 'another width or post starts again')
  t.alike(failStep(state, 'other', order, 0), { key: 'other', step: 1 })
  const alone = [full]
  const start = { key: 'a', step: 0 }
  t.is(failStep(start, 'a', alone, 0), start, 'a full size alone has nowhere to go')
  t.is(currentStep({ key: 'k', step: -1 }, 'k'), 0, 'a broken state reads as the first step')
})

test('retry or final: every thumbnail error is final, the full size keeps its ladder', async (t) => {
  const { errorIsFinal, mainRequest, failStep } = await load()
  const { retryDelay } = await import('../src/media/cache.js')
  const down = Object.assign(new Error('indisponível'), { retryable: true })
  const missing = Object.assign(new Error('indisponível'), { retryable: true, missing: true })
  const order = [thumb, full]
  const first = mainRequest(order, 0)
  t.is(first.d, thumb, 'a narrow tile asks for the thumbnail')
  t.ok(first.final, 'as a final load')
  t.ok(errorIsFinal(down, first.final), 'a retryable thumbnail error (network, 502/503/504) is final')
  t.ok(errorIsFinal(missing, first.final), 'so is a 404')
  t.alike(failStep({ key: 'k', step: 0 }, 'k', order, 0), { key: 'k', step: 1 }, 'and the full size comes next at once')
  const second = mainRequest(order, 1)
  t.is(second.d, full)
  t.absent(second.final, 'the full size is not final')
  t.absent(errorIsFinal(down, second.final), 'it keeps the ladder')
  t.is(retryDelay(down, 0), 2000)
  t.ok(errorIsFinal(down, true), 'an underlay error is final')
  t.absent(errorIsFinal(null, true))
  t.alike(mainRequest(null, 0), { d: null, final: false }, 'nothing while waiting for a width')
  t.alike(mainRequest([full], 0), { d: full, final: false }, 'a full size alone keeps the ladder')
})

test('the underlay is requested only while the full size is not at hand', async (t) => {
  const { underRequest } = await load()
  const base = { underlay: thumb, fullAtHand: false, fullOk: false, underShown: false, faded: false }
  t.is(underRequest(base), thumb, 'the full size loading: the thumbnail beneath')
  t.is(underRequest({ ...base, fullAtHand: true }), null, 'full size cached or kept: no underlay request')
  t.is(underRequest({ ...base, fullOk: true }), null, 'full size ok before the underlay showed: underlay null')
  t.is(underRequest({ ...base, fullOk: true, underShown: true }), thumb, 'kept while the full size fades in over it')
  t.is(underRequest({ ...base, fullOk: true, underShown: true, faded: true }), null, 'dropped once the fade ended')
  t.is(underRequest({ ...base, underlay: null }), null, 'no thumbnail, no request')
})

test('a thumbnail under the key of any photo of the post is never used', async (t) => {
  const { pickVariant, underlayFor } = await load()
  const other = { ...full, start: 5, sha256: 'd'.repeat(64), width: 600, height: 400, bytes: 30000, blocks: 1 }
  const media = [full, other]
  const shared = { ...thumb, core: other.core, start: other.start, blocks: other.blocks, sha256: other.sha256, bytes: other.bytes }
  t.alike(pickVariant({ media, thumbs: [shared, null], index: 0, widthPx: 320, dpr: 1 }), [full], 'the key of photo 1 is refused for slot 0')
  t.is(underlayFor({ media, thumbs: [shared, null], index: 0, widthPx: 1080, dpr: 1 }), null, 'also as an underlay')
  t.alike(pickVariant({ media, thumbs: [thumb, null], index: 0, widthPx: 320, dpr: 1 }), [thumb, full], 'positive control: its own key is used')
})

test('thumbnail decoded bounds: 640 px a side at most', async (t) => {
  const { thumbBoundsOk } = await load()
  t.ok(thumbBoundsOk({ width: 640, height: 640, frames: 1 }), '640 x 640 is accepted')
  t.absent(thumbBoundsOk({ width: 641, height: 10, frames: 1 }), 'wider is refused')
  t.absent(thumbBoundsOk({ width: 10, height: 641, frames: 1 }), 'taller is refused')
  t.absent(thumbBoundsOk(null), 'headers that do not parse are refused')
  t.absent(thumbBoundsOk({ width: 0, height: 10 }))
})

test('kept-only mode shows the first kept step', async (t) => {
  const { firstKept } = await load()
  const order = [thumb, full]
  t.is(firstKept(order, (d) => d === full), 1, 'the full size when only it is kept')
  t.is(firstKept(order, () => true), 0, 'the thumbnail first when both are')
  t.is(firstKept(order, () => false), null, 'a miss stays loading')
  t.is(firstKept(null, () => true), null)
})

test('exact protocol boundaries are accepted: 640 px and 65536 bytes', async (t) => {
  const { validThumb } = await load()
  t.ok(validThumb({ ...thumb, width: 640, height: 640 }), '640 x 640')
  t.ok(validThumb({ ...thumb, blocks: 2, bytes: 65536 }), '65536 bytes')
  t.absent(validThumb({ ...thumb, blocks: 3, bytes: 65537 }), 'one byte more')
})
