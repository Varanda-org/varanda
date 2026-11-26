'use strict'

// src/media/videoPrep.native.js and .web.js, and pickVideo in both attach
// siblings. The native module (modules/video-prep), expo-file-system, the
// photo encoder and the image picker are stubbed by specifier; @varanda/rpc
// is the real one, fed MP4 files built here box by box.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')
const rpc = require('@varanda/rpc')

const fileSystem = `
const files = globalThis.__vpFiles = globalThis.__vpFiles || new Map()
export const Paths = { cache: { uri: 'file:///stub/Caches/' } }
export class File {
  constructor (a, b) { this.uri = typeof a === 'string' ? a : a.uri + b }
  get name () { return this.uri.slice(this.uri.lastIndexOf('/') + 1) }
  get modificationTime () { return globalThis.__vpTimes.get(this.uri) }
  get exists () { return files.has(this.uri) }
  get size () { return files.has(this.uri) ? files.get(this.uri).byteLength : 0 }
  async bytes () { if (!files.has(this.uri)) throw new Error('missing'); globalThis.__vpReads.push(this.uri); return Uint8Array.from(files.get(this.uri)) }
  delete () { if (!files.has(this.uri)) throw new Error('missing'); files.delete(this.uri) }
}
export class Directory {
  constructor (a, b) { this.uri = typeof a === 'string' ? a : a.uri + b + '/' }
  get exists () { return true }
  list () { return globalThis.__vpList(this.uri) }
}
`
const videoPrep = `
export function isAvailable () { return true }
export async function prepare (uri, opts) { return globalThis.__vpModule(uri, opts) }
`
const encode = `
export async function encodeFile (asset, options) { return globalThis.__vpEncode(asset, options) }
`
const picker = `
export async function launchImageLibraryAsync (opts) { return globalThis.__vpPicker(opts) }
export async function requestCameraPermissionsAsync () { return globalThis.__vpPermission() }
export let launchCameraAsync = (opts) => globalThis.__vpCamera(opts)
globalThis.__vpSetCameraAvailable = (available) => { launchCameraAsync = available ? (opts) => globalThis.__vpCamera(opts) : undefined }
`
const cameraCapture = `
export function isAvailable () { return globalThis.__vpCaptureAvailable }
export async function canCapture () { return globalThis.__vpCanCapture() }
export async function capture (kind, opts) { return globalThis.__vpCapture(kind, opts) }
`
const data = (src) => 'data:text/javascript,' + encodeURIComponent(src)
const hooks = `
const stubs = {
  'expo-file-system': ${JSON.stringify(data(fileSystem))},
  'expo-image-picker': ${JSON.stringify(data(picker))},
  '../../modules/video-prep': ${JSON.stringify(data(videoPrep))},
  '../../modules/camera-capture': ${JSON.stringify(data(cameraCapture))}
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (specifier === './encode' && context.parentURL && context.parentURL.endsWith('/videoPrep.native.js')) {
    return { url: ${JSON.stringify(data(encode))}, shortCircuit: true }
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const loadNative = () => import('../src/media/videoPrep.native.js')
const loadWeb = () => import('../src/media/videoPrep.web.js')

// MP4 bytes: ftyp, moov (mvhd, one H.264 video trak, optional udta), mdat.
const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
const zeros = (n) => new Array(n).fill(0)
function box (type, ...parts) {
  const body = parts.flat()
  return [...be32(8 + body.length), ...ascii(type), ...body]
}
const ONE = 0x10000
const IDENTITY = [ONE, 0, 0, 0, ONE, 0, 0, 0, 0x40000000]
const SECRET = ascii('GPS -23.5505-046.6333')

function mp4 ({ seconds = 3, width = 640, height = 360, entry = 'avc1', udta = true } = {}) {
  const n = seconds * 30
  const sampleSize = 10
  const ftyp = box('ftyp', ascii('isom'), be32(0x200), ascii('isom'), ascii('avc1'), ascii('mp41'))
  const avcC = box('avcC', [1, 100, 0, 40, 0xff, 0xe1], be16(6), [0x67, 100, 0, 40, 0xac, 0xd9], [1], be16(4), [0x68, 0xeb, 0xe3, 0xcb])
  const compressor = [4, ...ascii('x264'), ...zeros(27)]
  const sample = box(entry, zeros(6), be16(1), zeros(16), be16(width), be16(height), be32(0x480000), be32(0x480000), be32(0), be16(1), compressor, be16(0x18), be16(0xffff), avcC, box('pasp', be32(1), be32(1)))
  const trakOf = (offset) => box('trak',
    box('tkhd', [0, 0, 0, 7], be32(7), be32(9), be32(1), be32(0), be32(seconds * 1000), zeros(16), ...IDENTITY.map((v) => be32(v >>> 0)), be32(width * ONE), be32(height * ONE)),
    box('mdia',
      box('mdhd', [0, 0, 0, 0], be32(7), be32(9), be32(3000), be32(n * 100), [0x55, 0xc4, 0, 0]),
      box('hdlr', [0, 0, 0, 0], be32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), [0]),
      box('minf',
        box('vmhd', [0, 0, 0, 1], zeros(8)),
        box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))),
        box('stbl',
          box('stsd', [0, 0, 0, 0], be32(1), sample),
          box('stts', [0, 0, 0, 0], be32(1), be32(n), be32(100)),
          box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(n), be32(1)),
          box('stsz', [0, 0, 0, 0], be32(0), be32(n), ...new Array(n).fill(be32(sampleSize))),
          box('stco', [0, 0, 0, 0], be32(1), be32(offset))))))
  const moovOf = (offset) => box('moov',
    box('mvhd', [0, 0, 0, 0], be32(7), be32(9), be32(1000), be32(seconds * 1000), zeros(16), ...[0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(be32), zeros(28)),
    trakOf(offset),
    ...(udta ? [box('udta', box('©xyz', SECRET))] : []))
  const offset = ftyp.length + moovOf(0).length + 8
  return new Uint8Array([...ftyp, ...moovOf(offset), ...box('mdat', new Array(n * sampleSize).fill(1))])
}

function contains (hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) { // eslint-disable-line no-labels
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer // eslint-disable-line no-labels
    return true
  }
  return false
}

const PICKED = 'file:///stub/Caches/ImagePicker/IMG_0001.MOV'
const OUT = 'file:///stub/Caches/video-prep/out.mp4'
const POSTER = 'file:///stub/Caches/video-prep/poster.jpg'
const POSTER_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
const GENERIC = 'Este vídeo não cabe no formato aceito.'
// brittle matches a RegExp against String(err); an Error argument would not
// compare the message.
const exactly = (text) => new RegExp('^Error: ' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')

// The module writes both outputs into the stub file system, as the real one
// writes them into the app cache.
function nativeEnv ({ output = mp4(), claim = {}, fail = null, encodeFails = false } = {}) {
  globalThis.__vpFiles = globalThis.__vpFiles || new Map()
  globalThis.__vpFiles.clear()
  globalThis.__vpFiles.set(PICKED, new Uint8Array([9, 9, 9]))
  globalThis.__vpReads = []
  const env = { calls: [], encoded: [], options: [] }
  globalThis.__vpModule = async (uri, opts) => {
    env.calls.push({ uri, opts })
    if (env.during) await env.during()
    if (fail) {
      const err = new Error('/private/var/mobile/secret/path AVFoundation -11800')
      err.code = fail
      throw err
    }
    globalThis.__vpFiles.set(OUT, output)
    globalThis.__vpFiles.set(POSTER, POSTER_BYTES)
    return { uri: OUT, posterUri: POSTER, width: 1234, height: 4321, ms: 1, bytes: 1, ...claim }
  }
  globalThis.__vpEncode = async (asset, options) => {
    env.encoded.push(asset)
    env.options.push(options)
    if (!globalThis.__vpFiles.has(asset.uri)) throw new Error('poster already gone')
    if (encodeFails) throw new Error('não foi possível preparar a foto')
    // Only a forced JPEG comes back as one: the default would be AVIF or WebP.
    const mime = options && options.format === 'jpeg' ? 'image/jpeg' : 'image/avif'
    return { bytes: new Uint8Array([0xff, 0xd8, 7, 0xff, 0xd9]), mime, width: asset.width, height: asset.height }
  }
  return env
}

const leftovers = () => [...globalThis.__vpFiles.keys()].filter((uri) => uri !== PICKED)

test('native: stripped bytes, sizes from the bytes, poster through the photo encoder, temp files gone', async (t) => {
  const { prepareVideo } = await loadNative()
  const raw = mp4()
  const env = nativeEnv({ output: raw })
  const asset = { uri: PICKED, mimeType: 'video/quicktime', width: 4032, height: 3024, duration: 99000 }
  const res = await prepareVideo(asset, { maxMs: 30000, maxBytes: 8388608 })
  t.is(env.calls.length, 1, 'one attempt')
  t.is(env.calls[0].uri, PICKED)
  t.alike(env.calls[0].opts, { maxMs: 30000, maxBytes: 8388608, maxSide: 960, maxBitrate: 1400000 })
  t.is(res.mime, 'video/mp4')
  t.is(res.width, 640, 'width from the bytes, not the picker nor the module')
  t.is(res.height, 360)
  t.is(res.ms, 3000)
  t.ok(contains(raw, SECRET), 'the encoder output carried metadata')
  t.absent(contains(res.bytes, SECRET), 'the result does not')
  t.alike(res.bytes, rpc.stripVideoMetadata(raw), 'the result is the stripped file')
  t.ok(rpc.videoBounds(res.bytes, { maxMs: 30000 }), 'and passes the strict check')
  t.is(env.encoded.length, 1)
  t.alike(env.encoded[0], { uri: POSTER, mimeType: 'image/jpeg', width: 640, height: 360 }, 'poster sized from the bytes')
  t.alike(env.options[0], { format: 'jpeg' }, 'the poster is forced to JPEG')
  t.alike(res.poster, { bytes: new Uint8Array([0xff, 0xd8, 7, 0xff, 0xd9]), mime: 'image/jpeg', width: 640, height: 360 })
  t.alike(leftovers(), [], 'output and poster deleted')
  t.absent(globalThis.__vpFiles.has(PICKED), 'the picker\'s copy deleted')
})

test('native: an output over maxBytes is refused unread and deleted', async (t) => {
  const { prepareVideo } = await loadNative()
  const raw = mp4()
  nativeEnv({ output: raw, claim: { bytes: 10 } })
  await t.exception(prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: raw.byteLength - 1 }), exactly(GENERIC))
  t.alike(globalThis.__vpReads, [], 'never read')
  t.alike(leftovers(), [], 'temp files deleted')
})

test('native: TOO_LONG names the limit; other codes and refused output say the format', async (t) => {
  const { prepareVideo } = await loadNative()
  nativeEnv({ fail: 'TOO_LONG' })
  await t.exception(prepareVideo({ uri: PICKED }, { maxMs: 15000, maxBytes: 4194304 }), /^Error: Escolha um vídeo de até 15 segundos\.$/)
  nativeEnv({ fail: 'TOO_LONG' })
  await t.exception(prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608 }), /até 30 segundos/)
  for (const code of ['UNSUPPORTED', 'BUSY', 'INVALID', 'FAILED', undefined]) {
    nativeEnv({ fail: code || 'X' })
    try {
      await prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608 })
      t.fail('refused ' + code)
    } catch (err) {
      t.is(err.message, GENERIC, String(code))
      t.absent(err.message.includes('/private'), 'no native text')
      t.absent(err.code, String(code))
    }
  }
  nativeEnv({ output: mp4({ entry: 'hvc1' }) })
  await t.exception(prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608 }), exactly(GENERIC), 'not H.264')
  t.alike(leftovers(), [], 'temp files deleted after a refused output')
  nativeEnv({ output: mp4({ seconds: 20 }) })
  await t.exception(prepareVideo({ uri: PICKED }, { maxMs: 15000, maxBytes: 4194304 }), exactly(GENERIC), 'longer than the cap')
  t.alike(leftovers(), [], 'temp files deleted')
})

test('native: a poster the encoder refuses fails the video and deletes both files', async (t) => {
  const { prepareVideo } = await loadNative()
  const env = nativeEnv({ encodeFails: true })
  await t.exception(prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608 }), exactly(GENERIC))
  t.is(env.encoded.length, 1)
  t.alike(leftovers(), [])
})

test('native: a cancelled preparation drops its late result and its files', async (t) => {
  const { prepareVideo } = await loadNative()
  const env = nativeEnv()
  const signal = { aborted: false }
  env.during = async () => { signal.aborted = true }
  t.is(await prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608, signal }), null)
  t.alike(globalThis.__vpReads, [], 'nothing read')
  t.is(env.encoded.length, 0, 'nothing encoded')
  t.alike(leftovers(), [], 'temp files deleted')
  const before = nativeEnv()
  t.is(await prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608, signal: { aborted: true } }), null)
  t.is(before.calls.length, 0, 'never started when already cancelled')
})

test('native: a cancelled preparation whose module then fails resolves null', async (t) => {
  const { prepareVideo } = await loadNative()
  const env = nativeEnv({ fail: 'FAILED' })
  const signal = { aborted: false }
  env.during = async () => { signal.aborted = true }
  t.is(await prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608, signal }), null)
  t.alike(leftovers(), [])
})

test('native: the picker\'s copy is deleted on every exit', async (t) => {
  const { prepareVideo } = await loadNative()
  const opts = { maxMs: 30000, maxBytes: 8388608 }
  const gone = (what) => t.absent(globalThis.__vpFiles.has(PICKED), what)
  nativeEnv()
  t.ok(await prepareVideo({ uri: PICKED }, opts))
  gone('after a success')
  nativeEnv({ output: mp4({ entry: 'hvc1' }) })
  await t.exception(prepareVideo({ uri: PICKED }, opts), exactly(GENERIC))
  gone('after a refused output')
  nativeEnv({ fail: 'TOO_LONG' })
  await t.exception(prepareVideo({ uri: PICKED }, opts), /até 30 segundos/)
  gone('after TOO_LONG')
  nativeEnv({ fail: 'FAILED' })
  await t.exception(prepareVideo({ uri: PICKED }, opts), exactly(GENERIC))
  gone('after a native error')
  const before = nativeEnv()
  t.is(await prepareVideo({ uri: PICKED }, { ...opts, signal: { aborted: true } }), null)
  t.is(before.calls.length, 0)
  gone('after an abort before the native call')
  const env = nativeEnv()
  const signal = { aborted: false }
  env.during = async () => { signal.aborted = true }
  t.is(await prepareVideo({ uri: PICKED }, { ...opts, signal }), null)
  gone('after an abort during the native call')
})

test('native: nothing outside the picker\'s folder is deleted', async (t) => {
  const { prepareVideo } = await loadNative()
  const opts = { maxMs: 30000, maxBytes: 8388608 }
  const others = [
    'file:///stub/Caches/other.mov',
    'file:///stub/Caches/ImagePickerX/IMG_0001.MOV',
    'file:///stub/Caches/ImagePicker/../keep.mov',
    'file:///stub/Caches/ImagePicker/%2e%2e%2fkeep.mov',
    'file:///stub/Caches/ImagePicker/',
    'file:///stub/Documents/ImagePicker/IMG_0001.MOV',
    'content://media/external/video/media/7',
    'ph://0E1A-4C2B'
  ]
  for (const uri of others) {
    nativeEnv()
    globalThis.__vpFiles.set(uri, new Uint8Array([1]))
    t.ok(await prepareVideo({ uri }, opts), uri)
    t.ok(globalThis.__vpFiles.has(uri), 'kept ' + uri)
    nativeEnv({ fail: 'FAILED' })
    globalThis.__vpFiles.set(uri, new Uint8Array([1]))
    await t.exception(prepareVideo({ uri }, opts), exactly(GENERIC))
    t.ok(globalThis.__vpFiles.has(uri), 'kept after a failure ' + uri)
  }
})

// A browser, as far as videoPrep.web.js and attach.web.js reach.
// safari: the element loads only the metadata until a seek is asked for,
// then fires `seeked` and never `loadeddata`.
function webEnv ({ frame = true, videoWidth = 640, videoHeight = 360, safari = false } = {}) {
  const env = { urls: new Map(), revoked: [], made: [], drawn: 0 }
  const realCreate = URL.createObjectURL
  const realRevoke = URL.revokeObjectURL
  let n = 0
  URL.createObjectURL = (blob) => { const u = 'blob:test/' + (++n); env.urls.set(u, blob); return u }
  URL.revokeObjectURL = (u) => { env.revoked.push(u) }
  globalThis.document = {
    createElement (tag) {
      env.made.push(tag)
      if (tag === 'video') {
        const listeners = new Map()
        const el = {
          videoWidth: 0,
          videoHeight: 0,
          addEventListener (type, fn) { listeners.set(type, fn) },
          removeEventListener (type) { listeners.delete(type) },
          removeAttribute () {},
          load () {},
          play () { env.played = (env.played || 0) + 1; return Promise.reject(new Error('NotAllowedError')) },
          pause () { env.paused = (env.paused || 0) + 1 },
          readyState: 0,
          get currentTime () { return env.seekedTo || 0 },
          set currentTime (s) {
            env.seekedTo = s
            queueMicrotask(() => {
              el.readyState = 2
              listeners.get('seeked') && listeners.get('seeked')()
            })
          },
          get src () { return env.src },
          set src (u) {
            env.src = u
            queueMicrotask(() => {
              if (!frame) return listeners.get('error') && listeners.get('error')()
              el.videoWidth = videoWidth
              el.videoHeight = videoHeight
              el.readyState = 1
              listeners.get('loadedmetadata') && listeners.get('loadedmetadata')()
              if (safari) return
              el.readyState = 2
              listeners.get('loadeddata') && listeners.get('loadeddata')()
            })
          }
        }
        return el
      }
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => { env.drawn++ } }),
          toBlob (cb, type) { cb(new Blob([new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9])], { type })) }
        }
      }
      throw new Error('unexpected element ' + tag)
    }
  }
  env.restore = () => {
    URL.createObjectURL = realCreate
    URL.revokeObjectURL = realRevoke
    delete globalThis.document
  }
  return env
}

const webText = (s, mb) => 'Neste navegador o vídeo precisa ser MP4 (H.264), com até ' + s + ' segundos e ' + mb + ' MB. Pelo app do celular ele é ajustado sozinho.'

test('web: a fitting MP4 is taken as is, stripped, with a poster drawn from the stripped bytes', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv({ videoWidth: 1920, videoHeight: 1080 })
  t.teardown(env.restore)
  const raw = mp4()
  const file = new Blob([raw], { type: 'video/mp4' })
  const res = await prepareVideo(file, { maxMs: 30000, maxBytes: 8388608 })
  t.is(res.width, 640, 'width from the bytes')
  t.is(res.height, 360)
  t.is(res.ms, 3000)
  t.alike(res.bytes, rpc.stripVideoMetadata(raw))
  t.absent(contains(res.bytes, SECRET), 'no metadata in the result')
  t.is(env.urls.size, 1, 'one object URL')
  const shown = new Uint8Array(await [...env.urls.values()][0].arrayBuffer())
  t.alike(shown, res.bytes, 'the poster is drawn from the stripped bytes')
  t.absent(contains(shown, SECRET), 'never from the picked ones')
  t.alike(env.revoked, [...env.urls.keys()], 'object URL released')
  t.alike(res.poster, { bytes: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), mime: 'image/jpeg', width: 960, height: 540 }, 'poster long side 960')
  t.is(env.drawn, 1)
})

test('web: an oversized file is refused before it is read', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  let read = false
  // Over a post as well (8 MiB + 1). A file only over the momento cap is read, below.
  const file = { size: 8388609, type: 'video/mp4', arrayBuffer: async () => { read = true; return new ArrayBuffer(0) } }
  await t.exception(prepareVideo(file, { maxMs: 15000, maxBytes: 4194304 }), exactly(webText(15, 4)))
  t.absent(read, 'not read')
  t.alike(env.made, [], 'nothing drawn')
})

test('web: a file that is not H.264, too long or over the cap once read is refused', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  try {
    await prepareVideo(new Blob([mp4({ entry: 'hvc1' })], { type: 'video/mp4' }), { maxMs: 30000, maxBytes: 8388608 })
    t.fail('hvc1 taken')
  } catch (err) {
    t.is(err.message, webText(30, 8), 'not H.264')
    t.absent(err.code, 'a post refusal stays untagged')
  }
  await t.exception(prepareVideo(new Blob([mp4({ seconds: 20 })]), { maxMs: 15000, maxBytes: 4194304 }), exactly(webText(15, 4)), 'too long')
  const raw = mp4()
  // A size that lies: the bytes read are what count.
  const liar = { size: 10, arrayBuffer: async () => raw.buffer }
  await t.exception(prepareVideo(liar, { maxMs: 30000, maxBytes: raw.byteLength - 1 }), exactly(webText(30, 0)), 'over the cap once read')
  t.alike(env.made, [], 'no poster for a refused file')
})

test('web: a browser that cannot show the frame refuses the file and releases the URL', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv({ frame: false })
  t.teardown(env.restore)
  await t.exception(prepareVideo(new Blob([mp4()]), { maxMs: 30000, maxBytes: 8388608 }), exactly(webText(30, 8)))
  t.alike(env.revoked, [...env.urls.keys()])
})

test('web: a browser that loads only metadata draws the frame after the seek', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv({ safari: true })
  t.teardown(env.restore)
  const got = await prepareVideo(new Blob([mp4()]), { maxMs: 30000, maxBytes: 8388608 })
  t.is(got.poster.mime, 'image/jpeg')
  t.ok(env.seekedTo > 0 && env.seekedTo < 0.1, 'a seek to the start was asked for')
  t.is(env.played, 1, 'a muted play was tried; its refusal is ignored')
  t.ok(env.paused >= 1, 'paused again once the frame is there')
  t.is(env.drawn, 1)
  t.alike(env.revoked, [...env.urls.keys()])
})

test('web: a cancelled preparation whose read then fails resolves null', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  const signal = { aborted: false }
  const file = { size: 100, arrayBuffer: async () => { signal.aborted = true; throw new Error('NotReadableError') } }
  t.is(await prepareVideo(file, { maxMs: 30000, maxBytes: 8388608, signal }), null)
})

test('web: a cancelled preparation resolves null', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  const signal = { aborted: false }
  const file = { size: 100, arrayBuffer: async () => { signal.aborted = true; return mp4().buffer } }
  t.is(await prepareVideo(file, { maxMs: 30000, maxBytes: 8388608, signal }), null)
  t.alike(env.made, [], 'nothing drawn')
})

test('pickVideo native: videos only, one, no exif; cancel resolves null', async (t) => {
  const { pickVideo, pickImages } = await import('../src/media/attach.native.js')
  const seen = []
  globalThis.__vpPicker = async (opts) => { seen.push(opts); return { canceled: true, assets: null } }
  t.is(await pickVideo(), null)
  t.alike(seen[0], { mediaTypes: ['videos'], exif: false, allowsMultipleSelection: false })
  globalThis.__vpPicker = async (opts) => { seen.push(opts); return { canceled: false, assets: [{ uri: PICKED, mimeType: 'video/quicktime', width: 1, height: 2 }] } }
  t.alike(await pickVideo(), { uri: PICKED, mimeType: 'video/quicktime', width: 1, height: 2 })
  await pickImages()
  t.alike(seen[2].mediaTypes, ['images'], 'pickImages unchanged')
})

test('pickVideo web: an MP4 input, single; cancel resolves null', async (t) => {
  const { pickVideo } = await import('../src/media/attach.web.js')
  const inputs = []
  globalThis.document = {
    body: { appendChild () {} },
    createElement () {
      const listeners = new Map()
      const input = {
        style: {},
        files: [],
        setAttribute () {},
        remove () {},
        addEventListener (type, fn) { listeners.set(type, fn) },
        removeEventListener (type) { listeners.delete(type) },
        click () { queueMicrotask(() => listeners.get(input.next)()) }
      }
      inputs.push(input)
      return input
    }
  }
  t.teardown(() => { delete globalThis.document })
  const pending = pickVideo()
  inputs[0].next = 'cancel'
  t.is(await pending, null)
  t.is(inputs[0].accept, 'video/mp4')
  t.is(inputs[0].multiple, false)
  const chosen = { name: 'a.mp4' }
  const second = pickVideo()
  inputs[1].files = [chosen]
  inputs[1].next = 'change'
  t.is(await second, chosen)
})

test('native: TOO_LONG carries OVER_LIMIT and limitMs; a refused output does not', async (t) => {
  const { prepareVideo } = await loadNative()
  const momento = { maxMs: 15000, maxBytes: 4194304 }
  nativeEnv({ fail: 'TOO_LONG' })
  try {
    await prepareVideo({ uri: PICKED }, momento)
    t.fail('too long')
  } catch (err) {
    t.is(err.message, 'Escolha um vídeo de até 15 segundos.')
    t.is(err.code, 'OVER_LIMIT')
    t.is(err.limitMs, 15000)
  }
  nativeEnv({ fail: 'TOO_LONG' })
  try {
    await prepareVideo({ uri: PICKED }, { maxMs: 30000, maxBytes: 8388608 })
    t.fail('too long for a post')
  } catch (err) {
    t.is(err.message, 'Escolha um vídeo de até 30 segundos.')
    t.is(err.code, 'OVER_LIMIT')
    t.is(err.limitMs, 30000)
  }
  nativeEnv({ output: mp4({ seconds: 20 }) })
  try {
    await prepareVideo({ uri: PICKED }, momento)
    t.fail('longer than the cap')
  } catch (err) {
    t.is(err.message, GENERIC)
    t.absent(err.code, 'post-encode preflight stays untagged')
    t.absent(err.limitMs)
  }
  nativeEnv({ output: mp4({ entry: 'hvc1' }) })
  try {
    await prepareVideo({ uri: PICKED }, momento)
    t.fail('not H.264')
  } catch (err) {
    t.is(err.message, GENERIC)
    t.absent(err.code)
  }
  try {
    await prepareVideo(null, momento)
    t.fail('no asset')
  } catch (err) {
    t.is(err.message, GENERIC)
    t.absent(err.code)
  }
})

test('web: a clip a post could take, over a momento limit, is OVER_LIMIT', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  const momento = { maxMs: 15000, maxBytes: 4194304 }
  try {
    await prepareVideo(new Blob([mp4({ seconds: 20 })]), momento)
    t.fail('20s')
  } catch (err) {
    t.is(err.message, webText(15, 4))
    t.is(err.code, 'OVER_LIMIT')
    t.is(err.limitMs, 15000)
  }
  const raw = mp4()
  let reads = 0
  const sized = {
    size: 4194305,
    arrayBuffer: async () => {
      reads++
      return raw.slice().buffer
    }
  }
  try {
    await prepareVideo(sized, momento)
    t.fail('over the momento cap in bytes')
  } catch (err) {
    t.is(err.message, webText(15, 4))
    t.is(err.code, 'OVER_LIMIT')
    t.is(err.limitMs, 15000)
  }
  t.is(reads, 1, 'read once to check the post limits')
  t.alike(env.made, [], 'no poster for a refused file')
})

test('web: a clip that also misses a post carries no code', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  const momento = { maxMs: 15000, maxBytes: 4194304 }
  try {
    await prepareVideo(new Blob([mp4({ seconds: 40 })]), momento)
    t.fail('40s')
  } catch (err) {
    t.is(err.message, webText(15, 4))
    t.absent(err.code)
    t.absent(err.limitMs)
  }
  try {
    await prepareVideo(new Blob([mp4({ entry: 'hvc1' })]), momento)
    t.fail('not H.264')
  } catch (err) {
    t.is(err.message, webText(15, 4))
    t.absent(err.code)
  }
  let read = false
  const huge = { size: 8388609, arrayBuffer: async () => { read = true; return mp4().buffer } }
  try {
    await prepareVideo(huge, momento)
    t.fail('over 8 MiB')
  } catch (err) {
    t.is(err.message, webText(15, 4))
    t.absent(err.code)
  }
  t.absent(read, 'over the post cap is not read')
  t.alike(env.made, [], 'no poster')
})

test('web: post limits are unchanged', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  const post = { maxMs: 30000, maxBytes: 8388608 }
  const ok = await prepareVideo(new Blob([mp4({ seconds: 20 })]), post)
  t.is(ok.ms, 20000)
  t.is(ok.mime, 'video/mp4')
  try {
    await prepareVideo(new Blob([mp4({ seconds: 40 })]), post)
    t.fail('40s')
  } catch (err) {
    t.is(err.message, webText(30, 8))
    t.absent(err.code)
    t.absent(err.limitMs)
  }
  let read = false
  const over = { size: 8388609, arrayBuffer: async () => { read = true; return mp4().buffer } }
  try {
    await prepareVideo(over, post)
    t.fail('over the cap')
  } catch (err) {
    t.is(err.message, webText(30, 8))
    t.absent(err.code)
  }
  t.absent(read, 'still refused before it is read')
})

test('web: aborting the post-limit read of a momento file resolves null', async (t) => {
  const { prepareVideo } = await loadWeb()
  const env = webEnv()
  t.teardown(env.restore)
  const momento = { maxMs: 15000, maxBytes: 4194304 }
  const dropped = { aborted: false }
  const failing = {
    size: 4194305,
    arrayBuffer: async () => {
      dropped.aborted = true
      throw new Error('NotReadableError')
    }
  }
  t.is(await prepareVideo(failing, { ...momento, signal: dropped }), null)
  let reads = 0
  const lateSignal = { aborted: false }
  const late = {
    size: 4194305,
    arrayBuffer: async () => {
      reads++
      lateSignal.aborted = true
      return mp4().slice().buffer
    }
  }
  t.is(await prepareVideo(late, { ...momento, signal: lateSignal }), null)
  t.is(reads, 1, 'the read started, then the screen went away')
  let started = false
  const idle = { size: 4194305, arrayBuffer: async () => { started = true; return new ArrayBuffer(0) } }
  t.is(await prepareVideo(idle, { ...momento, signal: { aborted: true } }), null)
  t.absent(started, 'not read once cancelled')
  t.alike(env.made, [])
})

const CAPTURE_FOLDER = 'file:///stub/Caches/CameraCapture/'
const CAPTURE_NAME = '0123456789abcdef0123456789abcdef'
const CAPTURE_PHOTO = { uri: CAPTURE_FOLDER + CAPTURE_NAME + '.jpg', mimeType: 'image/jpeg', width: 640, height: 480 }
const CAPTURE_VIDEO = { uri: CAPTURE_FOLDER + CAPTURE_NAME + '.mp4', mimeType: 'video/mp4', width: undefined, height: undefined }

function cameraEnv (available = true) {
  nativeEnv()
  globalThis.__vpCaptureAvailable = available
  globalThis.__vpTimes = new Map()
  globalThis.__vpList = () => []
  globalThis.__vpSetCameraAvailable(true)
  const env = { captures: [], launches: [], permissions: 0 }
  globalThis.__vpCanCapture = async () => ({ photo: true, video: true })
  globalThis.__vpCapture = async (kind, opts) => {
    env.captures.push({ kind, opts })
    return { ...(kind === 'photo' ? CAPTURE_PHOTO : CAPTURE_VIDEO), kind, exif: { ignored: true } }
  }
  globalThis.__vpPermission = async () => { env.permissions++; return { granted: true } }
  globalThis.__vpCamera = async (opts) => {
    env.launches.push(opts)
    return { canceled: false, assets: [{ ...(opts.mediaTypes[0] === 'images' ? CAPTURE_PHOTO : CAPTURE_VIDEO), exif: { ignored: true } }] }
  }
  return env
}

async function cameraFailure (t, action, code) {
  const { CAPTURE_TEXT } = await import('../src/cameraChoice.js')
  try {
    await action()
    t.fail('expected ' + code)
  } catch (err) {
    t.is(err.code, code)
    t.is(err.message, CAPTURE_TEXT[code], 'only the known message reaches the caller')
  }
}

test('capture native module: plain photo and video, duration, cancellation and error codes', async (t) => {
  const { canCapture, capturePhoto, captureVideo } = await import('../src/media/attach.native.js')
  const env = cameraEnv()
  t.alike(await canCapture(), { photo: true, video: true })
  t.alike(await capturePhoto(), CAPTURE_PHOTO)
  t.alike(await captureVideo({ maxMs: 15001 }), CAPTURE_VIDEO)
  t.alike(env.captures, [{ kind: 'photo', opts: undefined }, { kind: 'video', opts: { maxMs: 15001 } }])
  const actions = [capturePhoto, () => captureVideo({ maxMs: 30000 })]
  globalThis.__vpCapture = async () => null
  for (const action of actions) t.is(await action(), null)
  for (const code of ['UNAVAILABLE', 'BUSY', 'FAILED', 'UNKNOWN', undefined]) {
    globalThis.__vpCapture = async () => { throw Object.assign(new Error('native details'), { code }) }
    const expected = code === 'UNAVAILABLE' ? 'CAMERA_UNAVAILABLE' : code === 'BUSY' ? 'CAMERA_BUSY' : 'CAMERA_FAILED'
    for (const action of actions) await cameraFailure(t, action, expected)
  }
  t.alike(env.launches, [], 'never launches Expo on Android')
  t.is(env.permissions, 0, 'never asks Expo for Android camera permission')
})

test('capture capability: a present module never falls back to Expo', async (t) => {
  const { canCapture } = await import('../src/media/attach.native.js')
  const env = cameraEnv()
  globalThis.__vpCanCapture = async () => ({ photo: false, video: false })
  t.alike(await canCapture(), { photo: false, video: false })
  globalThis.__vpCanCapture = async () => { throw new Error('probe failed') }
  t.alike(await canCapture(), { photo: false, video: false })
  globalThis.__vpCanCapture = async () => ({ photo: true, video: false })
  t.alike(await canCapture(), { photo: true, video: false })
  t.alike(env.launches, [])
  t.is(env.permissions, 0)
})

test('capture Expo: permission, exact options, plain assets, cancellation and safe errors', async (t) => {
  const { canCapture, capturePhoto, captureVideo } = await import('../src/media/attach.native.js')
  const env = cameraEnv(false)
  t.alike(await canCapture(), { photo: true, video: true })
  t.alike(await capturePhoto(), CAPTURE_PHOTO)
  t.alike(await captureVideo({ maxMs: 15001 }), CAPTURE_VIDEO)
  t.alike(env.launches, [
    { mediaTypes: ['images'], exif: false },
    { mediaTypes: ['videos'], exif: false, videoMaxDuration: 16 }
  ])
  t.is(env.permissions, 2)
  t.alike(env.captures, [])
  const actions = [capturePhoto, () => captureVideo({ maxMs: 30000 })]
  globalThis.__vpCamera = async () => ({ canceled: true, assets: [CAPTURE_PHOTO] })
  for (const action of actions) t.is(await action(), null)
  let launches = 0
  globalThis.__vpCamera = async () => { launches++; throw new Error('native details') }
  globalThis.__vpPermission = async () => ({ granted: false })
  for (const action of actions) await cameraFailure(t, action, 'CAMERA_DENIED')
  t.is(launches, 0, 'no launch after denial')
  globalThis.__vpPermission = async () => { throw new Error('permission details') }
  for (const action of actions) await cameraFailure(t, action, 'CAMERA_FAILED')
  t.is(launches, 0, 'no launch after permission failure')
  globalThis.__vpPermission = async () => ({ granted: true })
  for (const action of actions) await cameraFailure(t, action, 'CAMERA_FAILED')
  t.is(launches, 2)
  globalThis.__vpSetCameraAvailable(false)
  t.teardown(() => globalThis.__vpSetCameraAvailable(true))
  t.alike(await canCapture(), { photo: false, video: false })
  for (const action of actions) await cameraFailure(t, action, 'CAMERA_UNAVAILABLE')
})

test('capture web: unavailable without touching browser camera APIs', async (t) => {
  const { canCapture, capturePhoto, captureVideo, discardCapture, sweepCaptures } = await import('../src/media/attach.web.js')
  t.alike(await canCapture(), { photo: false, video: false })
  await cameraFailure(t, capturePhoto, 'CAMERA_UNAVAILABLE')
  await cameraFailure(t, () => captureVideo({ maxMs: 15000 }), 'CAMERA_UNAVAILABLE')
  t.is(discardCapture(CAPTURE_PHOTO.uri), undefined)
  t.is(sweepCaptures(), undefined)
})

test('capture discard: only direct lowercase capture names, with no traversal or alternate folder', async (t) => {
  const { discardCapture } = await import('../src/media/attach.native.js')
  const { File, Paths } = await import('expo-file-system')
  cameraEnv()
  const entries = [
    [CAPTURE_PHOTO.uri, true],
    [CAPTURE_VIDEO.uri, true],
    [CAPTURE_FOLDER + '../' + CAPTURE_NAME + '.jpg', false],
    [CAPTURE_FOLDER + '%2e%2e%2f' + CAPTURE_NAME + '.jpg', false],
    [CAPTURE_FOLDER + 'nested/' + CAPTURE_NAME + '.jpg', false],
    [CAPTURE_FOLDER + '\\' + CAPTURE_NAME + '.jpg', false],
    [CAPTURE_FOLDER + 'wrong.jpg', false],
    [CAPTURE_FOLDER + 'A'.repeat(32) + '.jpg', false],
    [CAPTURE_FOLDER + CAPTURE_NAME + '.jpg?x', false],
    [CAPTURE_FOLDER + CAPTURE_NAME + '.jpg#x', false],
    [CAPTURE_FOLDER + CAPTURE_NAME + '.png', false],
    ['file:///stub/Caches/CameraCaptureX/' + CAPTURE_NAME + '.jpg', false],
    ['file:///stub/Caches/ImagePicker/' + CAPTURE_NAME + '.jpg', false],
    ['file:///stub/Documents/CameraCapture/' + CAPTURE_NAME + '.jpg', false],
    ['content://stub/Caches/CameraCapture/' + CAPTURE_NAME + '.jpg', false]
  ]
  for (const [uri, deleted] of entries) {
    globalThis.__vpFiles.set(uri, new Uint8Array([1]))
    t.is(discardCapture(uri), undefined)
    t.is(globalThis.__vpFiles.has(uri), !deleted, uri)
  }
  for (const value of [null, undefined, {}, 1, '']) t.is(discardCapture(value), undefined)
  t.is(discardCapture(CAPTURE_PHOTO.uri), undefined, 'missing file is harmless')
  const oldDelete = File.prototype.delete
  const oldCache = Paths.cache
  t.teardown(() => { File.prototype.delete = oldDelete; Paths.cache = oldCache })
  globalThis.__vpFiles.set(CAPTURE_PHOTO.uri, new Uint8Array([1]))
  File.prototype.delete = () => { throw new Error('unavailable') }
  t.is(discardCapture(CAPTURE_PHOTO.uri), undefined, 'deletion errors are ignored')
  File.prototype.delete = oldDelete
  for (const cache of [null, {}, { uri: 'content://stub/Caches/' }]) {
    Paths.cache = cache
    t.is(discardCapture(CAPTURE_PHOTO.uri), undefined)
    t.ok(globalThis.__vpFiles.has(CAPTURE_PHOTO.uri), 'invalid cache cannot authorize deletion')
  }
})

test('capture sweep: only direct named files older than a day, before probing, never directories', async (t) => {
  const { canCapture, sweepCaptures } = await import('../src/media/attach.native.js')
  const { File, Directory } = await import('expo-file-system')
  cameraEnv()
  const now = Date.now()
  const realNow = Date.now
  Date.now = () => now
  t.teardown(() => { Date.now = realNow })
  const entries = [
    [CAPTURE_PHOTO.uri, now - 86400001, true],
    [CAPTURE_VIDEO.uri, now - 86400001, true],
    [CAPTURE_FOLDER + 'a'.repeat(32) + '.jpg', now - 86400000, false],
    [CAPTURE_FOLDER + 'b'.repeat(32) + '.mp4', now, false],
    [CAPTURE_FOLDER + 'c'.repeat(32) + '.mp4', null, false],
    [CAPTURE_FOLDER + 'd'.repeat(32) + '.mp4', 0, false],
    [CAPTURE_FOLDER + '../' + CAPTURE_NAME + '.mp4', 1, false],
    [CAPTURE_FOLDER + 'nested/' + CAPTURE_NAME + '.jpg', 1, false],
    [CAPTURE_FOLDER + '%2e%2e%2f' + CAPTURE_NAME + '.mp4', 1, false],
    [CAPTURE_FOLDER + 'wrong.mp4', 1, false],
    [CAPTURE_FOLDER + CAPTURE_NAME + '.mov', 1, false],
    ['file:///stub/Caches/other/' + CAPTURE_NAME + '.mp4', 1, false]
  ]
  for (const [uri, time] of entries) {
    globalThis.__vpFiles.set(uri, new Uint8Array([1]))
    globalThis.__vpTimes.set(uri, time)
  }
  const subdir = new Directory(CAPTURE_FOLDER + 'e'.repeat(32) + '.jpg')
  subdir.delete = () => t.fail('deleted a directory')
  globalThis.__vpList = (uri) => {
    t.is(uri, CAPTURE_FOLDER, 'only the capture folder is listed')
    return [subdir, ...entries.map(([uri]) => new File(uri))]
  }
  globalThis.__vpCanCapture = async () => {
    t.absent(globalThis.__vpFiles.has(CAPTURE_PHOTO.uri), 'swept before probing')
    return { photo: true, video: true }
  }
  t.alike(await canCapture(), { photo: true, video: true })
  for (const [uri, , deleted] of entries) t.is(globalThis.__vpFiles.has(uri), !deleted, uri)
  globalThis.__vpList = () => { throw new Error('unreadable folder') }
  t.execution(() => sweepCaptures(), 'listing failure is ignored')
  globalThis.__vpList = () => [new File(CAPTURE_PHOTO.uri)]
  t.execution(() => sweepCaptures(), 'deletion failure is ignored')
})

test('native: camera originals are deleted on success, failure and cancellation only with a strict MP4 path', async (t) => {
  const { prepareVideo } = await loadNative()
  const opts = { maxMs: 30000, maxBytes: 8388608 }
  const entries = [
    [CAPTURE_VIDEO.uri, true],
    [CAPTURE_PHOTO.uri, false],
    [CAPTURE_FOLDER + '../' + CAPTURE_NAME + '.mp4', false],
    [CAPTURE_FOLDER + '%2e%2e%2f' + CAPTURE_NAME + '.mp4', false],
    [CAPTURE_FOLDER + 'nested/' + CAPTURE_NAME + '.mp4', false],
    [CAPTURE_FOLDER + 'wrong.mp4', false],
    [CAPTURE_FOLDER + 'A'.repeat(32) + '.mp4', false],
    [CAPTURE_FOLDER + CAPTURE_NAME + '.mp4?x', false],
    ['file:///stub/Caches/CameraCaptureX/' + CAPTURE_NAME + '.mp4', false],
    ['file:///stub/Documents/CameraCapture/' + CAPTURE_NAME + '.mp4', false],
    ['content://stub/Caches/CameraCapture/' + CAPTURE_NAME + '.mp4', false]
  ]
  for (const [uri, deleted] of entries) {
    for (const mode of ['success', 'failure', 'cancel']) {
      nativeEnv({ fail: mode === 'failure' ? 'FAILED' : null })
      globalThis.__vpFiles.set(uri, new Uint8Array([1]))
      const pending = prepareVideo({ uri }, { ...opts, signal: { aborted: mode === 'cancel' } })
      if (mode === 'failure') await t.exception(pending, exactly(GENERIC))
      else if (mode === 'cancel') t.is(await pending, null)
      else t.ok(await pending)
      t.is(globalThis.__vpFiles.has(uri), !deleted, mode + ': ' + uri)
    }
  }
})
