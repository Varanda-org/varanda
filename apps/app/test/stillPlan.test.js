'use strict'

// Pure still re-encode policy (src/media/stillPlan.js).
const test = require('brittle')

const load = () => import('../src/media/stillPlan.js')
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('still constants and avifQuality stay inside the encoder range', async (t) => {
  const plan = await load()
  t.is(plan.WEBP_QUALITY, 0.85)
  t.is(plan.JPEG_QUALITY, 0.85)
  t.is(plan.AVIF_QUALITY, 0.8)
  t.is(plan.AVIF_MAX_QUALITY, 0.98)
  t.is(plan.AVIF_BUDGET_MS, 8000)
  t.is(plan.avifQuality(0.99), plan.AVIF_MAX_QUALITY)
  t.is(plan.avifQuality(1), plan.AVIF_MAX_QUALITY)
  t.is(plan.avifQuality(1.5), plan.AVIF_MAX_QUALITY)
  t.is(plan.avifQuality(0), 0.1)
  t.is(plan.avifQuality(-0.4), 0.1)
  t.is(plan.avifQuality(0.1), 0.1)
  t.is(plan.avifQuality(0.5), 0.5)
  t.is(plan.avifQuality(plan.AVIF_MAX_QUALITY), plan.AVIF_MAX_QUALITY)
  t.is(plan.avifQuality(NaN), plan.AVIF_QUALITY)
  t.is(plan.avifQuality(Infinity), plan.AVIF_QUALITY)
  t.is(plan.avifQuality(undefined), plan.AVIF_QUALITY)
  t.is(plan.avifQuality(), plan.AVIF_QUALITY)
})

test('stillAttempts lists every opaque and alpha capability combination', async (t) => {
  const { stillAttempts, resetAvifSkip } = await load()
  resetAvifSkip()
  const opaque = [
    [true, true, ['avif', 'webp', 'jpeg']],
    [true, false, ['avif', 'jpeg']],
    [false, true, ['webp', 'jpeg']],
    [false, false, ['jpeg']]
  ]
  for (const [avif, webp, expected] of opaque) {
    t.alike(stillAttempts({ avif, webp, alpha: false }), expected)
  }
  const alpha = [
    [true, true, ['webp', 'png']],
    [true, false, ['png']],
    [false, true, ['webp', 'png']],
    [false, false, ['png']]
  ]
  for (const [avif, webp, expected] of alpha) {
    t.alike(stillAttempts({ avif, webp, alpha: true }), expected)
  }
  t.alike(stillAttempts({ avif: false, webp: false, alpha: false, force: undefined }), ['jpeg'])
})

test('stillAttempts forces JPEG and rejects any other force', async (t) => {
  const { stillAttempts, resetAvifSkip } = await load()
  resetAvifSkip()
  for (const avif of [true, false]) {
    for (const webp of [true, false]) {
      for (const alpha of [true, false]) {
        t.alike(stillAttempts({ avif, webp, alpha, force: 'jpeg' }), ['jpeg'])
      }
    }
  }
  for (const force of ['png', 'webp', 'avif', 'gif', 'JPEG', 'jpg', '', null, false, true, 0, 1]) {
    await t.exception.all(() => stillAttempts({ avif: true, webp: true, alpha: false, force }), TypeError)
    await t.exception.all(() => stillAttempts({ avif: true, webp: true, alpha: true, force }), TypeError)
  }
})

test('targetSize fits the long side and rounds only AVIF down to even', async (t) => {
  const { targetSize } = await load()
  const { fitWithin } = await import('../src/media/plan.js')
  for (const [width, height] of [[4031, 3023], [1001, 667]]) {
    const fitted = fitWithin(width, height)
    for (const format of ['webp', 'jpeg', 'png']) {
      t.alike(targetSize(width, height, format), fitted)
    }
    t.alike(targetSize(width, height, 'avif'), {
      width: Math.max(2, fitted.width - (fitted.width % 2)),
      height: Math.max(2, fitted.height - (fitted.height % 2))
    })
  }
  t.alike(targetSize(1001, 667, 'avif'), { width: 1000, height: 666 })
  t.alike(targetSize(1001, 667, 'jpeg'), { width: 1001, height: 667 })
  t.alike(targetSize(1001, 667, 'webp'), { width: 1001, height: 667 })
  t.alike(targetSize(1001, 667, 'png'), { width: 1001, height: 667 })
  t.alike(targetSize(3000, 2000, 'jpeg'), { width: 2048, height: 1365 })
  t.alike(targetSize(3000, 2000, 'avif'), { width: 2048, height: 1364 })
  t.alike(targetSize(1, 1, 'avif'), { width: 2, height: 2 })
  t.alike(targetSize(1, 1, 'png'), { width: 1, height: 1 })
  t.alike(targetSize(3, 5, 'webp'), { width: 3, height: 5 })
  t.alike(targetSize(3, 5, 'avif'), { width: 2, height: 4 })
  t.alike(targetSize(16384, 1, 'avif'), { width: 2048, height: 2 })
  t.alike(targetSize(16384, 1, 'jpeg'), { width: 2048, height: 1 })
  t.alike(targetSize(1, 16384, 'avif'), { width: 2, height: 2048 })
  // Fitting 4001x7 lands on 2048x4. Evening the sides before the fit would
  // shrink 4000x6 onto a height of 3, then 2.
  t.alike(targetSize(4001, 7, 'jpeg'), { width: 2048, height: 4 })
  t.alike(targetSize(4001, 7, 'avif'), { width: 2048, height: 4 })
  for (const args of [[0, 2, 'avif'], [2, -1, 'jpeg'], [Infinity, 2, 'webp'], [2, NaN, 'png'], [-5, -5, 'avif'], [1, 0, 'jpeg']]) {
    await t.exception.all(() => targetSize(...args), RangeError)
  }
})

test('an AVIF timeout skips AVIF until reset', async (t) => {
  const { stillAttempts, noteAvifTimeout, avifSkipped, resetAvifSkip } = await load()
  resetAvifSkip()
  try {
    t.is(avifSkipped(), false)
    t.alike(stillAttempts({ avif: true, webp: true, alpha: false }), ['avif', 'webp', 'jpeg'])
    noteAvifTimeout()
    t.is(avifSkipped(), true)
    noteAvifTimeout()
    t.is(avifSkipped(), true)
    t.alike(stillAttempts({ avif: true, webp: true, alpha: false }), ['webp', 'jpeg'])
    t.alike(stillAttempts({ avif: true, webp: false, alpha: false }), ['jpeg'])
    t.alike(stillAttempts({ avif: false, webp: true, alpha: false }), ['webp', 'jpeg'])
    t.alike(stillAttempts({ avif: false, webp: false, alpha: false }), ['jpeg'])
    t.alike(stillAttempts({ avif: true, webp: true, alpha: true }), ['webp', 'png'])
    t.alike(stillAttempts({ avif: true, webp: false, alpha: true }), ['png'])
    t.alike(stillAttempts({ avif: true, webp: true, alpha: true, force: 'jpeg' }), ['jpeg'])
  } finally {
    resetAvifSkip()
  }
  t.is(avifSkipped(), false)
  t.alike(stillAttempts({ avif: true, webp: true, alpha: false }), ['avif', 'webp', 'jpeg'])
  t.alike(stillAttempts({ avif: true, webp: false, alpha: false }), ['avif', 'jpeg'])
})

test('mimeOf maps the four still formats', async (t) => {
  const { mimeOf } = await load()
  t.is(mimeOf('avif'), 'image/avif')
  t.is(mimeOf('webp'), 'image/webp')
  t.is(mimeOf('jpeg'), 'image/jpeg')
  t.is(mimeOf('png'), 'image/png')
  for (const format of ['gif', 'jpg', 'image/jpeg', 'AVIF', '', null, undefined]) {
    await t.exception.all(() => mimeOf(format), TypeError)
  }
})

test('accept returns the parser size or null', async (t) => {
  const { accept } = await load()
  const bytes = new Uint8Array([4, 5, 6, 7, 8])
  let calls = 0
  const count = () => {
    calls++
    return { width: 8, height: 8, frames: 1 }
  }
  t.is(accept(null, 'image/jpeg', count), null)
  t.is(accept(undefined, 'image/jpeg', count), null)
  t.is(accept([4, 5, 6], 'image/jpeg', count), null)
  t.is(accept(new ArrayBuffer(8), 'image/png', count), null)
  t.is(accept(new DataView(new ArrayBuffer(8)), 'image/webp', count), null)
  t.is(accept(new Uint8Array(0), 'image/jpeg', count), null)
  t.is(calls, 0, 'invalid bytes are not parsed')

  t.is(accept(bytes, 'image/jpeg', () => null), null)
  t.is(accept(bytes, 'image/png', () => undefined), null)
  t.is(accept(bytes, 'image/webp', () => ({ width: 8, height: 8, frames: 2 })), null)
  t.is(accept(bytes, 'image/avif', () => ({ width: 8, height: 8 })), null)
  t.is(accept(bytes, 'image/jpeg', () => ({ width: 20000, height: 10, frames: 1 })), null)
  t.is(accept(bytes, 'image/jpeg', () => ({ width: 10, height: 20000, frames: 1 })), null)

  const ok = () => ({ width: 16, height: 16, frames: 1 })
  for (const mime of ['image/gif', 'image/JPEG', 'image/jpg', 'video/mp4', '', null]) {
    t.is(accept(bytes, mime, ok), null, String(mime))
  }

  let seen = null
  const parsed = accept(bytes, 'image/webp', (got, mime) => {
    seen = { got, mime }
    return { width: 1001, height: 667, frames: 1, alpha: true }
  })
  t.alike(parsed, { width: 1001, height: 667 })
  t.alike(Object.keys(parsed).sort(), ['height', 'width'])
  t.is(seen.got, bytes)
  t.is(seen.mime, 'image/webp')

  const view = new Uint8Array(20).subarray(2, 6)
  t.alike(accept(view, 'image/jpeg', (got, mime) => {
    t.is(got, view)
    t.is(mime, 'image/jpeg')
    return { width: 12, height: 34, frames: 1 }
  }), { width: 12, height: 34 })

  for (const mime of ['image/avif', 'image/webp', 'image/jpeg', 'image/png']) {
    t.alike(accept(bytes, mime, (got, gotMime) => {
      t.is(got, bytes)
      t.is(gotMime, mime)
      return { width: 20, height: 10, frames: 1 }
    }), { width: 20, height: 10 })
  }
})

test('withBudget returns a fast result and ignores the deadline', async (t) => {
  const { withBudget } = await load()
  let calls = 0
  const fast = { uri: 'file://fast' }
  t.is(await withBudget(Promise.resolve(fast), 30, () => { calls++ }), fast)
  await wait(50)
  t.is(calls, 0)
})

test('withBudget returns null on timeout and reports the late value', async (t) => {
  const { withBudget } = await load()
  let resolveEncode
  const encode = new Promise(resolve => { resolveEncode = resolve })
  let late
  t.is(await withBudget(encode, 25, value => { late = value }), null)
  t.is(late, undefined)
  const file = { uri: 'file://late.avif' }
  resolveEncode(file)
  await encode
  t.is(late, file)
})

test('withBudget turns a rejection into null', async (t) => {
  const { withBudget } = await load()
  let calls = 0
  const failed = Promise.reject(new Error('encode failed'))
  t.is(await withBudget(failed, 40, () => { calls++ }), null)
  t.is(calls, 0)

  let rejectLate
  const hanging = new Promise((_resolve, reject) => { rejectLate = reject })
  t.is(await withBudget(hanging, 20, () => { calls++ }), null)
  rejectLate(new Error('too late'))
  await Promise.resolve()
  t.is(calls, 0)
})
