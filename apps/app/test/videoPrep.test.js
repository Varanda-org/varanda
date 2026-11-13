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
  get exists () { return files.has(this.uri) }
  get size () { return files.has(this.uri) ? files.get(this.uri).byteLength : 0 }
  async bytes () { if (!files.has(this.uri)) throw new Error('missing'); globalThis.__vpReads.push(this.uri); return Uint8Array.from(files.get(this.uri)) }
  delete () { if (!files.has(this.uri)) throw new Error('missing'); files.delete(this.uri) }
}
`
const videoPrep = `
export function isAvailable () { return true }
export async function prepare (uri, opts) { return globalThis.__vpModule(uri, opts) }
`
const encode = `
export async function encodeFile (asset) { return globalThis.__vpEncode(asset) }
`
const picker = `
export async function launchImageLibraryAsync (opts) { return globalThis.__vpPicker(opts) }
`
const data = (src) => 'data:text/javascript,' + encodeURIComponent(src)
const hooks = `
const stubs = {
  'expo-file-system': ${JSON.stringify(data(fileSystem))},
  'expo-image-picker': ${JSON.stringify(data(picker))},
  '../../modules/video-prep': ${JSON.stringify(data(videoPrep))}
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
  const env = { calls: [], encoded: [] }
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
  globalThis.__vpEncode = async (asset) => {
    env.encoded.push(asset)
    if (!globalThis.__vpFiles.has(asset.uri)) throw new Error('poster already gone')
    if (encodeFails) throw new Error('não foi possível preparar a foto')
    return { bytes: new Uint8Array([0xff, 0xd8, 7, 0xff, 0xd9]), mime: 'image/jpeg', width: asset.width, height: asset.height }
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
  const file = { size: 4194305, type: 'video/mp4', arrayBuffer: async () => { read = true; return new ArrayBuffer(0) } }
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
