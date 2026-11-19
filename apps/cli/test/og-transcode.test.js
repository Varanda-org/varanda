'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fork, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const test = require('brittle')
const { mediaBounds, MAX_SHARE_COVER_BYTES } = require('@varanda/rpc')
const { stillImageSize } = require('@varanda/core/lib/still-image')
const { createOgTranscoder, needsTranscode, coverSize } = require('../lib/og-transcode')
const { createFakeOgTranscoder, jpegHeader } = require('./helpers/fake-og-transcode')
const { tmpDir, until } = require('./helpers/net')
const samples = require('../../../packages/rpc/test/helpers/avif-samples')

const CHILD = path.resolve(__dirname, '../lib/og-transcode-child.js')
const HELPER = require.resolve('./helpers/fake-og-transcode')
const SOURCES = [
  ['ios.opaque', samples.ios.opaque],
  ['libavif.opaque', samples.libavif.opaque],
  ['ios.grid2048x1536', samples.ios.grid2048x1536],
  ['imageio.grid1024x768', samples.imageio.grid1024x768],
  ['imageio.grid1025x769', samples.imageio.grid1025x769],
  ['libavif.odd1001x667', samples.libavif.odd1001x667]
]

function input (bytes = samples.ios.opaque, mime = 'image/avif') {
  const size = mediaBounds(bytes, mime) || { width: 16, height: 16 }
  return {
    bytes,
    mime,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    srcWidth: size.width,
    srcHeight: size.height,
    ...coverSize(size.width, size.height)
  }
}

function transcoder (t, opts) {
  const value = createOgTranscoder(opts)
  t.teardown(() => value.close(), { force: true })
  return value
}

function records (report) {
  return fs.existsSync(report) ? fs.readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
}

function fake (t, config = {}, opts = {}) {
  const dir = tmpDir(t, 'varanda-og-')
  const report = path.join(dir, 'report.jsonl')
  const childPath = path.join(dir, 'child.js')
  const write = (next = config) => fs.writeFileSync(childPath, `require(${JSON.stringify(HELPER)}).runChild(${JSON.stringify({ report, ...next })})\n`)
  write()
  let time = 100000
  const now = () => time
  const advance = (ms) => { time += ms }
  const e = transcoder(t, { childPath, now, initMs: 2000, requestMs: 1000, backoffMs: 5000, ...opts })
  return { e, report, write, advance, messages: () => records(report).filter((r) => r.type === 'message').length }
}

function variant (t, transform = (source) => source) {
  const dir = tmpDir(t, 'varanda-og-real-')
  const file = path.join(dir, 'child.js')
  const source = fs.readFileSync(CHILD, 'utf8').replace(/require\('([^']+)'\)/g, (_, name) => {
    return `require(${JSON.stringify(require.resolve(name, { paths: [path.dirname(CHILD)] }))})`
  })
  fs.writeFileSync(file, transform(source))
  return file
}

async function directChild (t, childPath) {
  const proc = fork(childPath, [], {
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    execArgv: ['--max-old-space-size=256']
  })
  const inbox = []
  let dead = false
  proc.on('message', (msg) => inbox.push(msg))
  proc.on('error', () => { dead = true })
  const exited = new Promise((resolve) => proc.once('exit', () => { dead = true; resolve() }))
  t.teardown(async () => { proc.kill('SIGKILL'); await exited }, { force: true })
  const receive = async (type) => {
    await until(() => dead || inbox.some((msg) => msg.type === type), { timeoutMs: 10000 })
    const index = inbox.findIndex((msg) => msg.type === type)
    if (index < 0) throw new Error('real transcoder child exited before ' + type)
    return inbox.splice(index, 1)[0]
  }
  return { proc, receive }
}

function checkJpeg (t, bytes, size, name) {
  t.ok(bytes instanceof Uint8Array, name + ' is a JPEG byte buffer')
  if (!(bytes instanceof Uint8Array)) return
  t.ok(bytes.length <= MAX_SHARE_COVER_BYTES, name + ' fits the hard cap')
  t.alike(stillImageSize(bytes, 'image/jpeg'), size, name + ' has the expected size')
  for (const tag of ['Exif', 'ICC_PROFILE', 'http://ns.adobe.com/xap/']) {
    t.absent(Buffer.from(bytes).includes(Buffer.from(tag)), name + ' strips ' + tag)
  }
}

test('cover planning and lazy native isolation', (t) => {
  t.alike(coverSize(2048, 1536), { width: 1200, height: 900 })
  t.alike(coverSize(1536, 2048), { width: 900, height: 1200 })
  t.alike(coverSize(1001, 667), { width: 1001, height: 667 })
  t.alike(coverSize(16384, 1), { width: 1200, height: 1 })
  for (const bad of [0, -1, NaN, Infinity, 1.5]) t.is(coverSize(bad, 10), null)
  t.ok(needsTranscode({ mime: 'image/avif', bytes: 1 }))
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    t.absent(needsTranscode({ mime, bytes: 262144 }))
    t.ok(needsTranscode({ mime, bytes: 262145 }))
    t.ok(needsTranscode({ mime, bytes: new Uint8Array(262145) }))
  }
  t.absent(needsTranscode(null))
  t.absent(needsTranscode({ mime: 'video/mp4', bytes: 999999 }))
  t.absent(Object.keys(require.cache).some((file) => /node_modules\/sharp\//.test(file)))
  const needle = "require('" + "sharp')"
  const matches = execFileSync('rg', ['-l', '-F', needle, path.resolve(__dirname, '../lib/og-transcode.js'), CHILD, __filename, HELPER], { encoding: 'utf8' }).trim().split('\n')
  t.alike(matches, [CHILD], 'only the decoder child requires sharp')
})

test('real child must load sharp and decode single-item and grid AVIF', async (t) => {
  const e = transcoder(t)
  t.alike(await e.ready(), { avif: true }, 'required native AVIF support, including grids')
  t.ok(e.canDo('image/avif'))
  t.ok(e.canDo('image/jpeg'))
  t.absent(e.canDo('image/gif'))
  for (const [name, bytes] of SOURCES) {
    const request = input(bytes)
    const out = await e.transcode(request)
    checkJpeg(t, out, coverSize(request.srcWidth, request.srcHeight), name)
    t.ok(e.known(request.sha256), name + ' is cached')
  }
})

test('alpha and invalid containers are refused before IPC', async (t) => {
  const f = fake(t)
  await f.e.ready()
  for (const bytes of [samples.ios.alpha, samples.libavif.alpha, Buffer.from('garbage'), samples.ios.opaque.slice(0, 100)]) {
    const request = input(bytes)
    t.is(await f.e.transcode(request), null)
    t.ok(f.e.known(request.sha256))
    t.is(await f.e.transcode(request), null)
  }
  t.is(await f.e.transcode({ ...input(), srcWidth: 17 }), null, 'wrong declared source width')
  t.is(await f.e.transcode({ ...input(), width: 15 }), null, 'wrong requested output width')
  t.is(await f.e.transcode({ ...input(), sha256: 'a'.repeat(64) }), null, 'hash must match bytes')
  t.is(await f.e.transcode({ ...input(), bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }), null)
  t.is(await f.e.transcode({ ...input(), bytes: '/tmp/image.avif' }), null)
  t.is(await f.e.transcode({ ...input(), bytes: 'https://example.org/image.avif' }), null)
  t.is(await f.e.transcode(input(jpegHeader(16384, 16384), 'image/jpeg')), null, 'pixel cap')
  t.is(f.messages(), 0, 'no refused source reached the child')
  t.ok(await f.e.transcode(input()), 'next valid request still works')
  t.is(f.messages(), 1)
  const start = records(f.report)[0]
  t.is(start.env, 0, 'empty environment')
  t.alike(start.execArgv, ['--max-old-space-size=256'], 'only the heap limit is inherited')
})

test('real child: JPEG, PNG, WebP, metadata, animation, truncation and decoded size', async (t) => {
  const file = variant(t, (source) => source.replace('if (require.main === module) start()', `
async function fixtures () {
  const create = { width: 1600, height: 900, channels: 4, background: { r: 0, g: 80, b: 160, alpha: 0.5 } }
  const jpeg = await sharp({ create }).withMetadata({ orientation: 1 }).jpeg().toBuffer()
  const rotated = await sharp({ create }).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  const png = await sharp({ create }).png().toBuffer()
  const webp = await sharp({ create }).webp().toBuffer()
  const frames = Buffer.alloc(16 * 16 * 3 * 2)
  frames.fill(255, frames.length / 2)
  const animated = await sharp(frames, { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer()
  send({ type: 'fixtures', jpeg, rotated, png, webp, animated })
}
start().then(fixtures)
`))
  const { proc, receive } = await directChild(t, file)
  t.alike(await receive('ready'), { type: 'ready', avif: true })
  const fixtures = await receive('fixtures')
  const e = transcoder(t)
  await e.ready()
  for (const format of ['jpeg', 'png', 'webp']) {
    const bytes = fixtures[format]
    checkJpeg(t, await e.transcode(input(bytes, 'image/' + format)), { width: 1200, height: 675 }, format)
  }
  t.ok(fixtures.jpeg.includes(Buffer.from('Exif')), 'source contains EXIF')
  t.is(await e.transcode(input(fixtures.rotated, 'image/jpeg')), null, 'an EXIF-rotated JPEG is refused, never served sideways')
  t.is(mediaBounds(fixtures.animated, 'image/webp').frames, 2, 'fixture is animated')
  t.is(await e.transcode(input(fixtures.animated, 'image/webp')), null)
  const truncated = fixtures.jpeg.subarray(0, fixtures.jpeg.length - 200)
  t.ok(mediaBounds(truncated, 'image/jpeg'), 'truncated scan passes header checks')
  t.is(await e.transcode(input(truncated, 'image/jpeg')), null, 'decoder rejects truncated pixels')
  proc.send({ type: 'transcode', id: 1, ...input(fixtures.jpeg, 'image/jpeg'), srcWidth: 1599 })
  t.is((await receive('result')).bytes, null, 'child independently refuses declared size mismatch')
  proc.send({ type: 'transcode', id: 2, ...input(fixtures.animated, 'image/webp') })
  t.is((await receive('result')).bytes, null, 'child independently refuses animation')
  proc.send({ type: 'transcode', id: 3, ...input() })
  checkJpeg(t, (await receive('result')).bytes, { width: 16, height: 16 }, 'child recovery')
  t.ok(await e.transcode(input(samples.libavif.opaque)), 'parent and decoder recover after bad input')
})

test('real child self-test needs the grid, reports empty env and sampled peak RSS', async (t) => {
  const badGrid = variant(t, (source) => source.replace('[IMAGEIO_GRID_1024X768, 1024, 768]', "['Z2FyYmFnZQ==', 1024, 768]"))
  const e = transcoder(t, { childPath: badGrid })
  t.alike(await e.ready(), { avif: false }, 'single-item success cannot hide a broken grid decoder')
  t.absent(e.canDo('image/avif'))
  t.ok(e.canDo('image/jpeg'))
  t.is(await e.transcode(input()), null)

  const observed = variant(t, (source) => source.replace('if (require.main === module) start()', `
let peakRss = process.memoryUsage().rss
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }
const timer = setInterval(sample, 1)
timer.unref()
const originalSend = process.send.bind(process)
process.send = (msg, callback) => {
  sample()
  originalSend({ ...msg, env: Object.keys(process.env).length, peakRss }, callback)
}
start()
`))
  const { proc, receive } = await directChild(t, observed)
  const ready = await receive('ready')
  t.is(ready.avif, true)
  t.is(ready.env, 0, 'real native child has an empty environment')
  proc.send({ type: 'transcode', id: 1, ...input(samples.ios.grid2048x1536) })
  const result = await receive('result')
  checkJpeg(t, result.bytes, { width: 1200, height: 900 }, 'measured grid')
  t.ok(result.peakRss > 0)
  t.comment('ios.grid2048x1536 child sampled peak process.memoryUsage().rss: ' + result.peakRss + ' bytes')
})

test('child answers are checked and refused hashes are not resent', async (t) => {
  for (const mode of ['over-cap', 'wrong-size', 'wrong-magic', 'wrong-type', 'null']) {
    const f = fake(t, { mode, once: true })
    await f.e.ready()
    const request = input()
    t.is(await f.e.transcode(request), null, mode)
    t.ok(f.e.known(request.sha256), mode + ' remembered')
    t.is(await f.e.transcode(request), null)
    t.is(f.messages(), 1, mode + ' never resent')
    t.ok(await f.e.transcode(input(samples.libavif.opaque)), mode + ' leaves the next request usable')
    t.is(f.messages(), 2)
    await f.e.close()
  }
})

test('deadline kills, lazy backoff respawns, failures do not poison the source', async (t) => {
  const f = fake(t, { mode: 'hang' }, { requestMs: 60 })
  await f.e.ready()
  const pid = records(f.report)[0].pid
  t.is(await f.e.transcode(input()), null)
  await until(() => {
    try { process.kill(pid, 0); return false } catch { return true }
  }, { timeoutMs: 2000 })
  t.pass('timed out child was killed')
  t.absent(f.e.known(input().sha256), 'timeout is not a permanent refusal')
  f.write({})
  t.is(await f.e.transcode(input()), null, 'backoff returns immediately')
  t.is(records(f.report).filter((r) => r.type === 'start').length, 1)
  f.advance(5000)
  t.ok(await f.e.transcode(input()), 'same request succeeds in the replacement child')
  t.is(records(f.report).filter((r) => r.type === 'start').length, 2)
})

test('init deadline, missing child, crashes and disconnects resolve without throwing', async (t) => {
  const hanging = fake(t, { mode: 'init-hang' }, { initMs: 60 })
  t.alike(await hanging.e.ready(), { avif: false })
  t.is(await hanging.e.transcode(input()), null)
  const missing = transcoder(t, { childPath: path.join(tmpDir(t), 'missing.js') })
  t.alike(await missing.ready(), { avif: false })
  for (const mode of ['init-exit', 'exit', 'disconnect']) {
    const f = fake(t, { mode })
    await f.e.ready()
    t.is(await f.e.transcode(input()), null, mode)
    f.write({})
    f.advance(5000)
    t.ok(await f.e.transcode(input()), mode + ' recovers')
  }
})

for (const mode of ['init-hang', 'init-exit']) {
  test('host AVIF readiness recovers after ' + mode + ' and stays sticky', async (t) => {
    const f = fake(t, { mode }, { initMs: 500 })
    t.absent(f.e.avif(), 'false before a successful self-test')
    t.alike(await f.e.ready(), { avif: false }, 'startup failed')
    f.write({})
    for (let i = 0; i < 10; i++) t.absent(f.e.avif(), 'backoff has not elapsed')
    t.alike(await f.e.ready(), { avif: false })
    t.is(records(f.report).length, 1, 'no probe bypasses the backoff')
    f.advance(5000)
    for (let i = 0; i < 10; i++) t.absent(f.e.avif(), 'background probe is not awaited')
    await until(() => f.e.canDo('image/avif'), { name: 'replacement ready' })
    t.ok(f.e.avif(), 'a later self-test updates host readiness')
    t.is(records(f.report).length, 2, 'concurrent probes spawn only one child')
    process.kill(records(f.report)[1].pid, 'SIGKILL')
    await until(() => !f.e.canDo('image/jpeg'), { name: 'replacement exited' })
    t.ok(f.e.avif(), 'host capability survives a child exit')
    f.advance(5000)
    for (let i = 0; i < 10; i++) t.ok(f.e.avif(), 'page probes after the backoff')
    await until(() => f.e.canDo('image/avif'), { name: 'page probe replaced the dead child' })
    t.is(records(f.report).length, 3, 'one replacement for many page probes')
    process.kill(records(f.report)[2].pid, 'SIGKILL')
    await until(() => !f.e.canDo('image/jpeg'), { name: 'second replacement exited' })
    f.write({ avif: false })
    f.advance(5000)
    t.alike(await f.e.ready(), { avif: false }, 'ready still reports the current child')
    t.ok(f.e.avif(), 'a later negative self-test does not erase host capability')
  })
}

test('explicit refusals share a bounded negative set and exclude cached successes', async (t) => {
  const f = fake(t, {}, { negativeEntries: 2 })
  const success = input()
  t.ok(await f.e.transcode(success))
  t.ok(f.e.known(success.sha256))
  t.absent(f.e.refused(success.sha256), 'a cached JPEG is not a refusal')
  const hashes = ['a', 'b'].map((c) => c.repeat(64))
  f.e.refuse(hashes[0])
  t.ok(f.e.refused(hashes[0]), 'external refusal is visible')
  t.ok(f.e.known(hashes[0]), 'known retains its existing contract')
  const invalid = input(Buffer.from('invalid'))
  t.is(await f.e.transcode(invalid), null)
  t.ok(f.e.refused(invalid.sha256), 'internal refusal uses the same set')
  f.e.refuse(hashes[1])
  t.absent(f.e.refused(hashes[0]), 'oldest refusal evicted at the shared bound')
  t.ok(f.e.refused(invalid.sha256))
  t.ok(f.e.refused(hashes[1]))
  t.absent(f.e.refused(success.sha256))
  f.e.refuse(success.sha256)
  t.is(await f.e.transcode(success), null, 'explicit refusal also prevents cached conversion')
  t.is(f.messages(), 1, 'no refused source reached IPC')
})

test('one active job, four waiting, coalescing and close', async (t) => {
  const f = fake(t, { delay: 80 })
  await f.e.ready()
  const requests = SOURCES.map(([, bytes]) => input(bytes))
  const first = f.e.transcode(requests[0])
  const duplicate = f.e.transcode(requests[0])
  const waiting = requests.slice(1, 5).map((request) => f.e.transcode(request))
  t.is(await f.e.transcode(requests[5]), null, 'sixth distinct source overflows immediately')
  t.absent(f.e.known(requests[5].sha256), 'overflow is transient')
  await until(() => f.messages() === 1)
  t.is(f.messages(), 1, 'only the active job was sent')
  const results = await Promise.all([first, duplicate, ...waiting])
  t.ok(results.every((bytes) => bytes instanceof Uint8Array))
  t.alike(results[0], results[1])
  t.not(results[0], results[1], 'callers own separate buffers')
  t.is(f.messages(), 5, 'identical sources coalesced')
  t.ok(await f.e.transcode(requests[5]), 'overflowed source works later')

  const closing = fake(t, { mode: 'hang' })
  const ready = closing.e.ready()
  const active = closing.e.transcode(requests[0])
  const queued = closing.e.transcode(requests[1])
  await closing.e.close()
  t.alike(await ready, { avif: false })
  t.is(await active, null)
  t.is(await queued, null)
  t.is(await closing.e.transcode(requests[2]), null)
  t.absent(closing.e.canDo('image/jpeg'))

  const running = fake(t, { mode: 'hang' })
  await running.e.ready()
  const inFlight = running.e.transcode(requests[0])
  const inQueue = running.e.transcode(requests[1])
  await until(() => running.messages() === 1)
  await running.e.close()
  t.is(await inFlight, null, 'close settles an active IPC request')
  t.is(await inQueue, null, 'close settles the queue')
})

test('real quality ladder, hard cap and white sRGB flattening', async (t) => {
  const file = variant(t, (source) => source.replace('if (require.main === module) start()', `
async function fixtures () {
  let state = 123456789
  const noise = []
  for (const side of [400, 600, 700, 1000]) {
    const raw = Buffer.alloc(side * side * 3)
    for (let i = 0; i < raw.length; i++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      raw[i] = state & 255
    }
    const image = sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    const png = await image.clone().png().toBuffer()
    const lengths = []
    for (const quality of [82, 72, 60]) lengths.push((await image.clone().jpeg({ quality }).toBuffer()).length)
    noise.push({ png, lengths })
  }
  const transparent = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
  send({ type: 'fixtures', noise, transparent })
  process.on('message', async (msg) => {
    if (msg.type !== 'inspect') return
    const image = sharp(msg.bytes)
    const metadata = await image.metadata()
    const raw = await image.raw().toBuffer()
    send({ type: 'inspected', white: raw.every((n) => n === 255), space: metadata.space, channels: metadata.channels })
  })
}
start().then(fixtures)
`))
  const { proc, receive } = await directChild(t, file)
  await receive('ready')
  const fixtures = await receive('fixtures')
  const e = transcoder(t)
  await e.ready()
  const qualities = []
  let refused = 0
  for (const { png, lengths } of fixtures.noise) {
    let rung = lengths.findIndex((n) => n <= 204800)
    if (rung < 0) rung = 2
    const out = await e.transcode(input(png, 'image/png'))
    if (lengths[rung] > MAX_SHARE_COVER_BYTES) {
      t.ok(out === null, 'real noisy image cannot fit even at quality 60')
      refused++
    } else {
      t.is(out && out.length, lengths[rung], 'stops at the first quality within target, or at the hard cap')
      qualities.push([82, 72, 60][rung])
    }
  }
  t.alike(qualities, [82, 72, 60], 'real images exercise all quality rungs')
  t.is(refused, 1, 'real image exercises final hard-cap refusal')
  const white = await e.transcode(input(fixtures.transparent, 'image/png'))
  t.ok(white instanceof Uint8Array, 'next conversion works after hard-cap refusal')
  proc.send({ type: 'inspect', bytes: white })
  t.alike(await receive('inspected'), { type: 'inspected', white: true, space: 'srgb', channels: 3 })
})

test('LRU entry and byte limits, owned buffers and bounded negative set', async (t) => {
  const f = fake(t, {}, { cacheEntries: 2 })
  await f.e.ready()
  const [a, b, c] = SOURCES.slice(0, 3).map(([, bytes]) => input(bytes))
  const first = await f.e.transcode(a)
  const expected = Buffer.from(first)
  first.fill(0)
  t.alike(await f.e.transcode(a), expected, 'caller cannot corrupt the cache')
  await f.e.transcode(b)
  await f.e.transcode(a)
  await f.e.transcode(c)
  t.ok(f.e.known(a.sha256), 'cache hit refreshed recency')
  t.absent(f.e.known(b.sha256), 'least recently used entry evicted')
  t.ok(f.e.known(c.sha256))
  t.is(f.messages(), 3)
  const small = fake(t, {}, { cacheBytes: jpegHeader(16, 16).length })
  await small.e.transcode(a)
  await small.e.transcode(b)
  t.absent(small.e.known(a.sha256), 'byte budget evicts independently of entry count')
  t.ok(small.e.known(b.sha256))
  const negatives = fake(t, {}, { negativeEntries: 2 })
  const invalid = ['one', 'two', 'three'].map((text) => input(Buffer.from(text)))
  for (const request of invalid) t.is(await negatives.e.transcode(request), null)
  t.absent(negatives.e.known(invalid[0].sha256))
  t.ok(negatives.e.known(invalid[1].sha256))
  t.ok(negatives.e.known(invalid[2].sha256))
  t.is(negatives.messages(), 0)
})

test('injectable route fake follows the public contract', async (t) => {
  const bytes = jpegHeader(16, 16)
  const e = createFakeOgTranscoder({ bytes, negativeEntries: 2 })
  t.alike(await e.ready(), { avif: true })
  t.ok(e.avif())
  t.ok(e.canDo('image/png'))
  t.is(await e.transcode(input()), bytes)
  t.is(e.calls.length, 1)
  t.ok(e.known(input().sha256))
  t.absent(e.refused(input().sha256), 'fake cached success is not refused')
  const hashes = ['a', 'b', 'c'].map((c) => c.repeat(64))
  e.refuse(hashes[0])
  t.ok(e.refused(hashes[0]))
  e.refuse(hashes[1])
  e.refuse(hashes[2])
  t.absent(e.refused(hashes[0]), 'fake negative set is bounded')
  t.ok(e.refused(hashes[1]))
  t.ok(e.refused(hashes[2]))
  await e.close()
  t.is(await e.transcode(input()), null)
})
