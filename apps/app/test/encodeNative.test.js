'use strict'

// src/media/encode.native.js photo path: the still order from stillPlan.js,
// the AVIF budget and every temporary file deleted. expo-file-system,
// expo-image-manipulator, ./display and modules/image-prep are stubbed by
// specifier; @varanda/rpc is the real one, so every output is parsed from
// real AVIF, WebP, JPEG and PNG bytes.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')
const samples = require('../../../packages/rpc/test/helpers/avif-samples')

const fileSystem = `
const files = globalThis.__enFiles = globalThis.__enFiles || new Map()
export class File {
  constructor (uri) { if (typeof uri !== 'string') throw new TypeError('uri'); this.uri = uri }
  get exists () { return files.has(this.uri) }
  get size () { return files.has(this.uri) ? files.get(this.uri).byteLength : 0 }
  async bytes () { if (!files.has(this.uri)) throw new Error('missing'); return Uint8Array.from(files.get(this.uri)) }
  delete () { if (!files.has(this.uri)) throw new Error('missing'); files.delete(this.uri); globalThis.__en.deleted.push(this.uri) }
}
`
const manipulator = `
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' }
export async function manipulateAsync (uri, actions, opts) { return globalThis.__en.manipulate(uri, actions, opts) }
`
const display = `
export function urlFromBytes (bytes, mime) {
  const box = globalThis.__en
  const uri = 'file:///stub/cache/bytes-' + (box.urls.length + 1)
  globalThis.__enFiles.set(uri, bytes)
  box.urls.push({ uri, mime })
  return uri
}
export function revokeUrl (uri) { globalThis.__en.revoked.push(uri); globalThis.__enFiles.delete(uri) }
`
const imagePrep = `
globalThis.__enPrepLoads = (globalThis.__enPrepLoads || 0) + 1
// Not async, so a synchronous native throw reaches the encoder as one.
export function canEncodeAvif () { return globalThis.__en.canAvif() }
export function encodeAvif (uri, opts) { return globalThis.__en.encodeAvif(uri, opts) }
`
const data = (src) => 'data:text/javascript,' + encodeURIComponent(src)
const hooks = `
const stubs = {
  'expo-file-system': ${JSON.stringify(data(fileSystem))},
  'expo-image-manipulator': ${JSON.stringify(data(manipulator))},
  '../../modules/image-prep': ${JSON.stringify(data(imagePrep))}
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (specifier === './display' && context.parentURL && context.parentURL.endsWith('/encode.native.js')) {
    return { url: ${JSON.stringify(data(display))}, shortCircuit: true }
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const load = () => import('../src/media/encode.native.js')
const plan = () => import('../src/media/stillPlan.js')

const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))

function jpeg (w, h) {
  return new Uint8Array([0xff, 0xd8,
    0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, ...be16(2), 0xff, 0xd9])
}

function pngChunk (id, body) {
  return [...be32(body.length), ...ascii(id), ...body, 0, 0, 0, 0]
}

function png (w, h) {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
    ...pngChunk('IDAT', [1, 2, 3]),
    ...pngChunk('IEND', [])])
}

function webp (w, h) {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  const chunk = [...ascii('VP8L'), ...le32(8), 0x2f, ...le32(v >>> 0), 0, 0, 0]
  const body = [...ascii('WEBP'), ...chunk]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}

const GIF = new Uint8Array([...ascii('GIF89a'), 2, 0, 3, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0,
  0x2c, 0, 0, 0, 0, 2, 0, 3, 0, 0, 2, 2, 0x4c, 0x01, 0, 0x3b])
const GARBAGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
const SOURCE = 'file:///stub/picked/IMG_0001.HEIC'
const LATE = 'file:///stub/cache/late.avif'
const PREPARE_FAILED = 'não foi possível preparar a foto'
const exactly = (text) => new RegExp('^Error: ' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
const photo = (mimeType = 'image/heic') => ({ uri: SOURCE, mimeType, width: 4032, height: 3024 })

// The image-prep stub writes its AVIF and the manipulator stub its output
// into the stub file system, as the real ones write into the app cache. Both
// claim a size the bytes contradict, so a result sized from the bytes shows.
function setup ({ canAvif = true, avif = samples.libavif.opaque, outputs = {} } = {}) {
  const files = globalThis.__enFiles = globalThis.__enFiles || new Map()
  files.clear()
  files.set(SOURCE, new Uint8Array([0, 0, 0, 0x18, 1, 2, 3]))
  const box = globalThis.__en = { probes: 0, avifCalls: [], manip: [], deleted: [], urls: [], revoked: [] }
  box.canAvif = async () => {
    box.probes++
    return canAvif
  }
  box.encodeAvif = async (uri, opts) => {
    box.avifCalls.push({ uri, opts })
    if (avif === null) return null
    const out = 'file:///stub/cache/photo-' + box.avifCalls.length + '.avif'
    files.set(out, avif)
    return { uri: out, width: 16, height: 16 }
  }
  const outs = { webp: webp(640, 480), jpeg: jpeg(640, 480), png: png(640, 480), ...outputs }
  box.manipulate = async (uri, actions, opts) => {
    box.manip.push({ uri, actions, opts })
    if (outs[opts.format] instanceof Error) throw outs[opts.format]
    const out = 'file:///stub/cache/manip-' + box.manip.length + '.' + opts.format
    files.set(out, outs[opts.format])
    return { uri: out, width: 9999, height: 9999 }
  }
  return box
}

const leftovers = () => [...globalThis.__enFiles.keys()].filter((uri) => uri !== SOURCE)
const formats = (box) => box.manip.map((call) => call.opts.format)

test('loading the encoder, an alpha source and a forced JPEG never load the AVIF module', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  t.is(globalThis.__enPrepLoads, undefined, 'not loaded on import')
  setup()
  await encodeFile(photo('image/png'))
  await encodeFile(photo(), { format: 'jpeg' })
  t.is(globalThis.__enPrepLoads, undefined, 'not loaded when AVIF cannot be tried')
})

test('AVIF when the probe passes and the bytes parse: no manipulator, file deleted', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  const box = setup()
  const res = await encodeFile(photo())
  t.is(res.mime, 'image/avif')
  t.alike(res.bytes, samples.libavif.opaque)
  t.is(box.probes, 1)
  t.alike(box.avifCalls, [{ uri: SOURCE, opts: { maxSide: 2048, quality: 0.75 } }], 'straight from the source, long side at most 2048')
  t.alike(box.manip, [], 'no manipulator intermediate')
  t.alike(box.deleted, ['file:///stub/cache/photo-1.avif'])
  t.alike(leftovers(), [], 'temp files deleted')
})

test('width and height come from the parsed bytes, not from the encoders', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  setup({ avif: samples.ios.grid2048x1536 })
  const avif = await encodeFile(photo())
  t.is(avif.mime, 'image/avif')
  t.is(avif.width, 2048, 'the encoder claimed 16')
  t.is(avif.height, 1536)
  setup({ canAvif: false, outputs: { webp: webp(1024, 768) } })
  const still = await encodeFile(photo())
  t.is(still.mime, 'image/webp')
  t.is(still.width, 1024, 'the manipulator claimed 9999')
  t.is(still.height, 768)
  t.alike(leftovers(), [], 'temp files deleted')
})

test('WebP when the probe fails: the AVIF encoder is never called', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  const box = setup({ canAvif: false })
  const res = await encodeFile(photo())
  t.is(res.mime, 'image/webp')
  t.alike(res.bytes, webp(640, 480))
  t.is(res.width, 640)
  t.is(res.height, 480)
  t.is(box.probes, 1)
  t.is(box.avifCalls.length, 0)
  t.alike(box.manip, [{ uri: SOURCE, actions: [{ resize: { width: 2048, height: 1536 } }], opts: { format: 'webp', compress: 0.85 } }])
  t.alike(leftovers(), [], 'temp files deleted')
})

test('WebP when the AVIF output fails the parser, or the encoder gives nothing', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip, avifSkipped } = await plan()
  resetAvifSkip()
  let box = setup({ avif: GARBAGE })
  let res = await encodeFile(photo())
  t.is(res.mime, 'image/webp', 'garbage AVIF bytes are refused')
  t.is(box.avifCalls.length, 1)
  t.alike(formats(box), ['webp'])
  t.ok(box.deleted.includes('file:///stub/cache/photo-1.avif'), 'the refused AVIF is deleted')
  t.absent(avifSkipped(), 'refused bytes are not a timeout')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ avif: samples.libavif.alpha })
  res = await encodeFile(photo())
  t.is(res.mime, 'image/webp', 'an AVIF with an alpha item is refused')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ avif: null })
  res = await encodeFile(photo())
  t.is(res.mime, 'image/webp', 'encodeAvif resolved null')
  t.is(box.avifCalls.length, 1)
  t.absent(avifSkipped(), 'a quick null is not a timeout')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup()
  box.encodeAvif = async () => { throw new Error('native failure') }
  res = await encodeFile(photo())
  t.is(res.mime, 'image/webp', 'a rejected encode')
  t.absent(avifSkipped(), 'a quick rejection is not a timeout')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup()
  box.encodeAvif = () => { throw new Error('sync native failure') }
  res = await encodeFile(photo())
  t.is(res.mime, 'image/webp', 'a synchronous native throw')
  t.absent(avifSkipped(), 'a synchronous throw is not a timeout')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup()
  box.encodeAvif = async (uri) => ({ uri, width: 16, height: 16 })
  res = await encodeFile(photo())
  t.is(res.mime, 'image/webp', 'an answer naming the source')
  t.ok(globalThis.__enFiles.has(SOURCE), 'the picked original is never deleted')
})

test('a probe that is not exactly true, or that throws, means WebP and no AVIF call', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip, avifSkipped } = await plan()
  resetAvifSkip()
  for (const answer of ['yes', 1, {}, null, 'true']) {
    const box = setup({ canAvif: answer })
    const res = await encodeFile(photo())
    t.is(res.mime, 'image/webp', 'probe answered ' + JSON.stringify(answer))
    t.is(box.probes, 1)
    t.is(box.avifCalls.length, 0, 'no AVIF call')
  }
  const throws = {
    sync: () => { throw new Error('native probe failure') },
    async: async () => { throw new Error('native probe failure') }
  }
  for (const [kind, canAvif] of Object.entries(throws)) {
    const box = setup()
    box.canAvif = canAvif
    const res = await encodeFile(photo())
    t.is(res.mime, 'image/webp', kind + ' probe throw: no error reaches the person')
    t.is(box.avifCalls.length, 0)
    t.absent(avifSkipped(), kind + ' probe throw is not a timeout')
    t.alike(leftovers(), [], 'temp files deleted')
  }
})

test('JPEG when the WebP output is invalid or the manipulator fails', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  let box = setup({ canAvif: false, outputs: { webp: GARBAGE } })
  let res = await encodeFile(photo())
  t.is(res.mime, 'image/jpeg')
  t.alike(res.bytes, jpeg(640, 480))
  t.alike(formats(box), ['webp', 'jpeg'])
  t.alike(box.manip[1].opts, { format: 'jpeg', compress: 0.85 })
  t.is(box.deleted.length, 2, 'both outputs deleted')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ avif: GARBAGE, outputs: { webp: new Error('no WebP encoder') } })
  res = await encodeFile(photo())
  t.is(res.mime, 'image/jpeg', 'AVIF refused, WebP threw')
  t.alike(formats(box), ['webp', 'jpeg'])
  t.alike(leftovers(), [], 'temp files deleted')
})

test('alpha sources never try AVIF: WebP, then PNG', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  for (const mime of ['image/png', 'image/webp', 'image/avif', 'IMAGE/PNG']) {
    let box = setup()
    let res = await encodeFile(photo(mime))
    t.is(res.mime, 'image/webp', mime + ': WebP keeps the alpha')
    t.is(box.probes, 0, mime + ': no probe')
    t.is(box.avifCalls.length, 0, mime + ': no AVIF')
    t.alike(formats(box), ['webp'])
    t.alike(leftovers(), [], 'temp files deleted')

    box = setup({ outputs: { webp: GARBAGE } })
    res = await encodeFile(photo(mime))
    t.is(res.mime, 'image/png', mime + ': PNG when WebP fails')
    t.alike(res.bytes, png(640, 480))
    t.alike(formats(box), ['webp', 'png'], mime + ': never JPEG')
    t.alike(box.manip[1].opts, { format: 'png' }, 'PNG has no quality')
    t.is(box.avifCalls.length, 0)
    t.alike(leftovers(), [], 'temp files deleted')
  }
})

test('a forced JPEG writes JPEG only', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  let box = setup()
  const res = await encodeFile(photo(), { format: 'jpeg' })
  t.is(res.mime, 'image/jpeg')
  t.is(box.probes, 0, 'no probe')
  t.is(box.avifCalls.length, 0, 'no AVIF')
  t.alike(formats(box), ['jpeg'], 'no WebP')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ outputs: { jpeg: GARBAGE } })
  await t.exception(encodeFile(photo(), { format: 'jpeg' }), exactly(PREPARE_FAILED), 'nothing else is tried')
  t.alike(formats(box), ['jpeg'])
  t.alike(leftovers(), [], 'temp files deleted')

  setup()
  // A TypeError is a native error, which plain t.exception rethrows.
  await t.exception.all(encodeFile(photo(), { format: 'webp' }), /TypeError: Expected format to be jpeg/)
  t.alike(globalThis.__en.manip, [], 'refused before any work')
})

test('when no output passes, the person reads why', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  setup({ avif: GARBAGE, outputs: { webp: GARBAGE, jpeg: GARBAGE } })
  await t.exception(encodeFile(photo()), exactly(PREPARE_FAILED))
  t.alike(leftovers(), [], 'temp files deleted')

  const huge = new Uint8Array(8 * 1024 * 1024 + 1)
  huge.set(jpeg(640, 480))
  setup({ canAvif: false, outputs: { webp: GARBAGE, jpeg: huge } })
  await t.exception(encodeFile(photo()), exactly('arquivo grande demais'), 'checkFile names the limit')
  t.alike(leftovers(), [], 'temp files deleted')

  setup({ canAvif: false, outputs: { webp: new Error('x'), jpeg: new Error('y') } })
  await t.exception(encodeFile(photo()), exactly(PREPARE_FAILED))
  t.alike(leftovers(), [], 'temp files deleted')
})

// The budget runs out when the test calls expire(), not after eight seconds.
// Running it out at once would race the probe's import() through the loader
// hooks, which can take milliseconds on Node 20.
async function heldBudget (t) {
  const { resetAvifSkip, AVIF_BUDGET_MS } = await plan()
  resetAvifSkip()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const held = new Set()
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== AVIF_BUDGET_MS) return realSetTimeout(fn, ms, ...args)
    const timer = () => fn(...args)
    held.add(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    if (!held.delete(timer)) realClearTimeout(timer)
  }
  t.teardown(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    resetAvifSkip()
  })
  return {
    expire () {
      const due = [...held]
      held.clear()
      for (const timer of due) timer()
      return due.length
    }
  }
}

// -> a promise that settles on the next call of box[name].
function nextCall (box, name) {
  const stub = box[name]
  return new Promise((resolve) => {
    box[name] = (...args) => {
      box[name] = stub
      resolve()
      return stub(...args)
    }
  })
}

test('an AVIF encode past the budget: WebP now, no AVIF later, the late file deleted', async (t) => {
  const { encodeFile } = await load()
  const { avifSkipped } = await plan()
  const budget = await heldBudget(t)
  const box = setup()
  let release
  box.encodeAvif = (uri, opts) => {
    box.avifCalls.push({ uri, opts })
    return new Promise((resolve) => {
      release = () => {
        globalThis.__enFiles.set(LATE, samples.libavif.opaque)
        resolve({ uri: LATE, width: 16, height: 16 })
      }
    })
  }
  const encoding = nextCall(box, 'encodeAvif')
  const pending = encodeFile(photo())
  await encoding
  t.is(budget.expire(), 1, 'only the encode is on the clock')
  const res = await pending
  t.is(res.mime, 'image/webp')
  t.ok(avifSkipped(), 'the timeout is noted')
  t.alike(leftovers(), [], 'nothing left yet')

  release()
  await new Promise((resolve) => setImmediate(resolve))
  t.absent(globalThis.__enFiles.has(LATE), 'the late output is deleted')
  t.ok(box.deleted.includes(LATE))

  const next = await encodeFile(photo())
  t.is(next.mime, 'image/webp')
  t.is(box.avifCalls.length, 1, 'AVIF is skipped next time')
  t.is(box.probes, 1, 'and not even probed')
  t.alike(leftovers(), [], 'temp files deleted')
})

test('a probe past the budget: WebP, and AVIF skipped from then on', async (t) => {
  const { encodeFile } = await load()
  const { avifSkipped } = await plan()
  const budget = await heldBudget(t)
  const box = setup()
  box.canAvif = () => {
    box.probes++
    return new Promise(() => {})
  }
  const probing = nextCall(box, 'canAvif')
  const pending = encodeFile(photo())
  await probing
  t.is(budget.expire(), 1, 'the probe is on the clock')
  const res = await pending
  t.is(res.mime, 'image/webp', 'a stalled probe does not hang the photo')
  t.ok(avifSkipped(), 'the timeout is noted')
  t.is(box.avifCalls.length, 0)
  const next = await encodeFile(photo())
  t.is(next.mime, 'image/webp')
  t.is(box.probes, 1, 'not probed again')
  t.alike(leftovers(), [], 'temp files deleted')
})

test('a late answer naming the source never deletes the picked original', async (t) => {
  const { encodeFile } = await load()
  const budget = await heldBudget(t)
  const box = setup()
  let release
  box.encodeAvif = (uri) => new Promise((resolve) => { release = () => resolve({ uri, width: 16, height: 16 }) })
  const encoding = nextCall(box, 'encodeAvif')
  const pending = encodeFile(photo())
  await encoding
  t.is(budget.expire(), 1, 'only the encode is on the clock')
  const res = await pending
  t.is(res.mime, 'image/webp')
  release()
  await new Promise((resolve) => setImmediate(resolve))
  t.ok(globalThis.__enFiles.has(SOURCE), 'the source is still there')
  t.absent(box.deleted.includes(SOURCE))
})

test('a forced JPEG re-encodes GIF bytes instead of passing them through', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  for (const mimeType of ['image/jpeg', 'image/gif']) {
    const box = setup()
    globalThis.__enFiles.set(SOURCE, GIF)
    const res = await encodeFile({ uri: SOURCE, mimeType, width: 2, height: 3 }, { format: 'jpeg' })
    t.is(res.mime, 'image/jpeg', mimeType + ' with GIF bytes')
    t.alike(formats(box), ['jpeg'])
    t.alike(leftovers(), [], 'temp files deleted')
  }
})

test('GIF and source checks are unchanged', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  const box = setup()
  const gif = GIF
  globalThis.__enFiles.set(SOURCE, gif)
  const res = await encodeFile({ uri: SOURCE, mimeType: 'image/gif', width: 2, height: 3 })
  t.is(res.mime, 'image/gif', 'a GIF passes through')
  t.alike(res.bytes, gif)
  t.is(box.probes, 0)
  t.alike(box.manip, [])
  await t.exception(encodeFile({ uri: SOURCE, mimeType: 'video/mp4', width: 2, height: 3 }), exactly('formato não aceito'))
  setup()
  await t.exception(encodeFile({ uri: SOURCE, mimeType: 'image/jpeg', width: 20000, height: 3 }), exactly('foto grande demais'))
  t.alike(globalThis.__en.manip, [])
})

const CROP = { sx: 100, sy: 20, sw: 3000, sh: 3000 }
const CROP_ACTION = { crop: { originX: 100, originY: 20, width: 3000, height: 3000 } }

test('cropFor: crop then resize from the crop size', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  const box = setup({ canAvif: false })
  const seen = []
  const res = await encodeFile(photo(), { cropFor: (size) => { seen.push(size); return CROP } })
  t.alike(seen, [{ width: 4032, height: 3024 }], 'called once with the source size')
  t.is(res.mime, 'image/webp')
  t.is(res.width, 640, 'sizes from the parsed output')
  t.absent('whole' in res, 'no whole unless asked')
  t.alike(box.manip[0].actions, [CROP_ACTION, { resize: { width: 2048, height: 2048 } }])

  const small = setup({ canAvif: false })
  await encodeFile(photo(), { cropFor: () => ({ sx: 0, sy: 0, sw: 1000, sh: 800 }) })
  t.alike(small.manip[0].actions, [{ crop: { originX: 0, originY: 0, width: 1000, height: 800 } }], 'no resize when the crop fits')
  t.alike(leftovers(), [], 'temp files deleted')
})

test('cropFor: null or the full image gives exactly today\'s actions', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  for (const rect of [null, { sx: 0, sy: 0, sw: 4032, sh: 3024 }]) {
    const box = setup({ canAvif: false })
    const res = await encodeFile(photo(), { cropFor: () => rect, whole: true })
    t.alike(box.manip, [{ uri: SOURCE, actions: [{ resize: { width: 2048, height: 1536 } }], opts: { format: 'webp', compress: 0.85 } }], JSON.stringify(rect))
    t.absent('whole' in res, 'no whole without a crop')
  }
})

test('cropFor: a rect outside the image throws before any work', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  const bad = [
    { sx: -1, sy: 0, sw: 10, sh: 10 },
    { sx: 0, sy: 0, sw: 0, sh: 10 },
    { sx: 0.5, sy: 0, sw: 10, sh: 10 },
    { sx: 4000, sy: 0, sw: 100, sh: 10 },
    { sx: 0, sy: 3000, sw: 10, sh: 25 },
    {}
  ]
  for (const rect of bad) {
    const box = setup({ canAvif: false })
    await t.exception.all(encodeFile(photo(), { cropFor: () => rect }), /TypeError: Expected a crop inside the image/, JSON.stringify(rect))
    t.alike(box.manip, [])
  }
})

test('cropFor: a GIF passes through uncropped, cropFor never called', async (t) => {
  const { encodeFile } = await load()
  const box = setup()
  globalThis.__enFiles.set(SOURCE, GIF)
  let calls = 0
  const res = await encodeFile({ uri: SOURCE, mimeType: 'image/gif', width: 2, height: 3 }, { cropFor: () => { calls++; return { sx: 0, sy: 0, sw: 1, sh: 1 } }, whole: true })
  t.is(res.mime, 'image/gif')
  t.alike(res.bytes, GIF)
  t.is(calls, 0)
  t.absent('whole' in res)
  t.alike(box.manip, [])
})

test('cropFor with AVIF: encodes from a JPEG intermediate, deleted after', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  let box = setup()
  let res = await encodeFile(photo(), { cropFor: () => CROP })
  t.is(res.mime, 'image/avif')
  t.alike(box.manip, [{ uri: SOURCE, actions: [CROP_ACTION, { resize: { width: 2048, height: 2048 } }], opts: { compress: 1, format: 'jpeg' } }])
  t.is(box.avifCalls[0].uri, 'file:///stub/cache/manip-1.jpeg', 'AVIF from the intermediate')
  t.ok(box.deleted.includes('file:///stub/cache/manip-1.jpeg'), 'intermediate deleted')
  t.ok(globalThis.__enFiles.has(SOURCE), 'original kept')
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ outputs: { jpeg: new Error('no intermediate') } })
  res = await encodeFile(photo(), { cropFor: () => CROP })
  t.is(res.mime, 'image/webp', 'falls to WebP')
  t.is(box.avifCalls.length, 0)
  t.alike(formats(box), ['jpeg', 'webp'])
  t.alike(leftovers(), [], 'temp files deleted')
})

test('whole: the uncropped photo at 1280, only with a crop, PNG for alpha, absent on failure', async (t) => {
  const { encodeFile } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  let box = setup({ canAvif: false, outputs: { jpeg: jpeg(1280, 960) } })
  let res = await encodeFile(photo(), { cropFor: () => CROP, whole: true })
  t.is(res.mime, 'image/webp')
  t.alike(res.whole, { bytes: jpeg(1280, 960), mime: 'image/jpeg', width: 1280, height: 960 })
  t.alike(box.manip[1], { uri: SOURCE, actions: [{ resize: { width: 1280, height: 960 } }], opts: { compress: 0.8, format: 'jpeg' } })
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ outputs: { png: png(1280, 960) } })
  res = await encodeFile(photo('image/png'), { cropFor: () => CROP, whole: true })
  t.is(res.whole.mime, 'image/png', 'PNG for an alpha source')
  t.alike(box.manip[1].opts, { format: 'png' })
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ canAvif: false, outputs: { jpeg: new Error('whole failed') } })
  res = await encodeFile(photo(), { cropFor: () => CROP, whole: true })
  t.is(res.mime, 'image/webp', 'the encode still succeeds')
  t.absent('whole' in res)
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ canAvif: false, outputs: { jpeg: GARBAGE } })
  res = await encodeFile(photo(), { cropFor: () => CROP, whole: true })
  t.absent('whole' in res, 'unparseable whole is dropped')
  t.alike(leftovers(), [], 'temp files deleted')
})

test('a forced JPEG with cropFor still yields JPEG', async (t) => {
  const { encodeFile } = await load()
  const box = setup()
  const res = await encodeFile(photo(), { format: 'jpeg', cropFor: () => CROP })
  t.is(res.mime, 'image/jpeg')
  t.alike(formats(box), ['jpeg'])
  t.alike(box.manip[0].actions[0], CROP_ACTION)
})

test('encodeBytes runs the file path and revokes its uri on success and failure', async (t) => {
  const { encodeBytes } = await load()
  const { resetAvifSkip } = await plan()
  resetAvifSkip()
  let box = setup({ canAvif: false })
  const still = { bytes: jpeg(4032, 3024), mime: 'image/jpeg', width: 4032, height: 3024 }
  const res = await encodeBytes(still, { cropFor: () => CROP })
  t.is(res.mime, 'image/webp')
  t.alike(box.urls, [{ uri: 'file:///stub/cache/bytes-1', mime: 'image/jpeg' }])
  t.is(box.manip[0].uri, 'file:///stub/cache/bytes-1')
  t.alike(box.revoked, ['file:///stub/cache/bytes-1'])
  t.alike(leftovers(), [], 'temp files deleted')

  box = setup({ canAvif: false, outputs: { webp: GARBAGE, jpeg: GARBAGE } })
  await t.exception(encodeBytes(still), exactly(PREPARE_FAILED))
  t.alike(box.revoked, ['file:///stub/cache/bytes-1'], 'revoked on failure')
  t.alike(leftovers(), [], 'temp files deleted')
})
