'use strict'

// Verified media fetch: URL building, the capped body reader and the SHA-256
// check, with fetch and WebCrypto injected (no network).
const test = require('brittle')
const { createHash, webcrypto } = require('node:crypto')
const load = () => import('../src/media/fetch.js')

const AUTHOR = 'ab'.repeat(32)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function descriptor (bytes, over = {}) {
  return {
    core: 'cd'.repeat(32),
    mime: 'image/jpeg',
    start: 1,
    blocks: Math.ceil(bytes.byteLength / 32768),
    bytes: bytes.byteLength,
    sha256: sha(bytes),
    width: 10,
    height: 20,
    ...over
  }
}

// A response whose body arrives in the given chunks.
function response (chunks, status = 200) {
  let i = 0
  let cancelled = false
  return {
    status,
    redirected: false,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => { cancelled = true }
      }),
      cancel: async () => { cancelled = true }
    },
    get cancelled () { return cancelled }
  }
}

test('mediaUrl builds the same-origin path and refuses bad fields', async (t) => {
  const { mediaUrl, validDescriptor } = await load()
  const bytes = new Uint8Array(40000).fill(7)
  const d = descriptor(bytes)
  t.ok(validDescriptor(d))
  t.is(mediaUrl(AUTHOR, d), '/media/' + AUTHOR + '/' + d.core + '/1/2')
  t.is(mediaUrl(AUTHOR.toUpperCase(), d), '/media/' + AUTHOR + '/' + d.core + '/1/2', 'author lowercased')
  for (const author of ['', 'ab', 'zz'.repeat(32), AUTHOR + '/..', null, 42]) {
    t.is(mediaUrl(author, d), null, 'author ' + String(author))
  }
  const bad = [
    { core: 'CD'.repeat(32) },
    { core: '../'.repeat(21) + 'a' },
    { core: 'cd'.repeat(31) },
    { start: 0 },
    { start: '1' },
    { start: 1.5 },
    { start: 8191, blocks: 2 },
    { blocks: 0 },
    { blocks: 257 },
    { blocks: 3 },
    { blocks: 1 },
    { bytes: 32768 },
    { sha256: 'x'.repeat(64) },
    { mime: 'image/svg+xml' },
    { width: 0 },
    { height: 16385 },
    { extra: 1 }
  ]
  for (const over of bad) t.is(mediaUrl(AUTHOR, descriptor(bytes, over)), null, JSON.stringify(over))
  const missing = { ...d }
  delete missing.width
  t.is(mediaUrl(AUTHOR, missing), null, 'missing key')
  t.is(mediaUrl(AUTHOR, null), null)
  t.is(mediaUrl(AUTHOR, [d]), null)
})

test('readCapped: exact length passes, more or fewer bytes fail', async (t) => {
  const { readCapped } = await load()
  const ok = await readCapped(response([new Uint8Array([1, 2]), new Uint8Array([3])]), 3)
  t.alike(Array.from(ok), [1, 2, 3])
  const more = response([new Uint8Array([1, 2]), new Uint8Array([3, 4])])
  await t.exception(() => readCapped(more, 3))
  t.ok(more.cancelled, 'oversized read is cancelled')
  await t.exception(() => readCapped(response([new Uint8Array([1, 2])]), 3))
  await t.exception(() => readCapped(response(['abc']), 3), 'non-bytes chunk')
  const plain = { arrayBuffer: async () => new Uint8Array([9, 9]).buffer }
  t.alike(Array.from(await readCapped(plain, 2)), [9, 9])
  await t.exception(() => readCapped(plain, 3))
})

test('only a 404 or a network error is retryable; mismatches are not', async (t) => {
  const { fetchMedia } = await load()
  const bytes = new Uint8Array(100).fill(3)
  const d = descriptor(bytes)
  const subtle = webcrypto.subtle
  const reason = async (fetch, extra = {}) => {
    try {
      await fetchMedia(AUTHOR, d, { fetch, subtle, ...extra })
    } catch (err) {
      return err
    }
    return null
  }
  t.is((await reason(async () => response([bytes], 404))).retryable, true, '404')
  t.is((await reason(async () => { throw new TypeError('network') })).retryable, true, 'network error')
  t.absent((await reason(async () => response([bytes], 500))).retryable, '500')
  const busy = (h) => Object.assign(response([bytes], 503), { headers: { get: (k) => (k === 'retry-after' ? h : null) } })
  const b1 = await reason(async () => busy('1'))
  t.is(b1.retryable, true, '503 is retryable')
  t.is(b1.retryAfterMs, 1000, 'Retry-After 1 s')
  t.is((await reason(async () => busy('30'))).retryAfterMs, 30000, 'Retry-After 30 s')
  for (const h of ['0', '31', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', null]) {
    const e = await reason(async () => busy(h))
    t.is(e.retryable, true, '503 stays retryable with Retry-After ' + h)
    t.absent('retryAfterMs' in e, 'ignored Retry-After ' + h)
  }
  t.absent((await reason(async () => ({ ...busy('1'), url: 'https://evil.test/x' }))).retryable, '503 after leaving the origin')
  t.absent((await reason(async () => response([bytes, bytes]))).retryable, 'too long')
  t.absent((await reason(async () => response([bytes.subarray(1)]))).retryable, 'too short')
  t.absent((await reason(async () => response([new Uint8Array(100)]))).retryable, 'sha mismatch')
  const seen = []
  t.is(await reason(async (url, opts) => { seen.push(opts.cache); return response([bytes]) }, { fresh: true }), null)
  t.alike(seen, ['no-cache'], 'a retry revalidates')
})

test('fetchMedia: persist false is no-store on the first attempt and on retries', async (t) => {
  const { fetchMedia } = await load()
  const bytes = new Uint8Array(100).fill(3)
  const d = descriptor(bytes)
  const seen = []
  const fetch = async (url, opts) => { seen.push(opts.cache); return response([bytes]) }
  const subtle = webcrypto.subtle
  await fetchMedia(AUTHOR, d, { fetch, subtle, persist: false })
  await fetchMedia(AUTHOR, d, { fetch, subtle, persist: false, fresh: true })
  await fetchMedia(AUTHOR, d, { fetch, subtle, persist: true })
  await fetchMedia(AUTHOR, d, { fetch, subtle })
  t.alike(seen, ['no-store', 'no-store', 'force-cache', 'force-cache'])
})

test('fetchMedia: the app client sends no cache option and the URL unchanged', async (t) => {
  const { fetchMedia, mediaUrl } = await load()
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => setAppClient(false))
  setAppClient(true)
  const bytes = new Uint8Array(100).fill(3)
  const d = descriptor(bytes)
  const seen = []
  const fetch = async (url, opts) => { seen.push({ url, opts }); return response([bytes]) }
  const subtle = webcrypto.subtle
  await fetchMedia(AUTHOR, d, { fetch, subtle, persist: false })
  await fetchMedia(AUTHOR, d, { fetch, subtle, persist: false, fresh: true })
  await fetchMedia(AUTHOR, d, { fetch, subtle, fresh: true })
  await fetchMedia(AUTHOR, d, { fetch, subtle })
  for (const s of seen) {
    t.absent('cache' in s.opts, 'no cache option')
    t.is(s.url, mediaUrl(AUTHOR, d), 'url unchanged')
    t.is(s.opts.redirect, 'error')
    t.is(s.opts.credentials, 'omit')
  }
  seen.length = 0
  setAppClient(false)
  await fetchMedia(AUTHOR, d, { fetch, subtle, persist: false })
  await fetchMedia(AUTHOR, d, { fetch, subtle, fresh: true })
  await fetchMedia(AUTHOR, d, { fetch, subtle })
  t.alike(seen.map((s) => s.opts.cache), ['no-store', 'no-cache', 'force-cache'], 'the web keeps its cache modes')
})

test('fetchMedia: the app client streams with an abortable request and a no-store header', async (t) => {
  const { fetchMedia, mediaUrl } = await load()
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => setAppClient(false))
  setAppClient(true)
  const bytes = new Uint8Array(100).fill(8)
  const d = descriptor(bytes)
  const seen = []
  let reads = 0
  // A streaming body that would never end: only the cap and the abort stop it.
  const endless = (url, opts) => {
    seen.push({ url, opts })
    return {
      status: 200,
      redirected: false,
      body: {
        getReader: () => ({
          read: async () => { reads++; return { done: false, value: new Uint8Array(60) } },
          cancel: async () => {}
        }),
        cancel: async () => {}
      }
    }
  }
  await t.exception(() => fetchMedia(AUTHOR, d, { fetch: async (u, o) => endless(u, o), subtle: null, persist: false }), /grande demais/)
  t.is(reads, 2, 'reading stops at the first chunk past the descriptor length')
  t.ok(seen[0].opts.signal.aborted, 'the request is aborted')
  t.alike(seen[0].opts.headers, { 'Cache-Control': 'no-store' }, 'persist false sends no-store as a header')
  t.absent('cache' in seen[0].opts, 'no cache mode')
  t.is(seen[0].url, mediaUrl(AUTHOR, d), 'no query appended')

  const ok = []
  const good = await fetchMedia(AUTHOR, d, { fetch: async (url, opts) => { ok.push(opts); return response([bytes.subarray(0, 60), bytes.subarray(60)]) }, subtle: null })
  t.is(good.byteLength, 100, 'a correct body passes')
  t.absent(ok[0].signal.aborted, 'not aborted')
  t.absent('headers' in ok[0], 'persisting items send no no-store header')

  const bad = []
  await t.exception(() => fetchMedia(AUTHOR, descriptor(bytes, { sha256: 'ee'.repeat(32) }), { fetch: async (url, opts) => { bad.push(opts); return response([bytes]) }, subtle: null }), /não confere/)
  const short = []
  await t.exception(() => fetchMedia(AUTHOR, d, { fetch: async (url, opts) => { short.push(opts); return response([bytes.subarray(1)]) }, subtle: null }), /incompleto/)
  t.ok(short[0].signal.aborted, 'a short body aborts too')

  setAppClient(false)
  const web = []
  await fetchMedia(AUTHOR, d, { fetch: async (url, opts) => { web.push(opts); return response([bytes]) }, subtle: null, persist: false })
  t.alike(Object.keys(web[0]).sort(), ['cache', 'credentials', 'method', 'redirect'], 'the web init is unchanged')
  t.is(web[0].cache, 'no-store')
})

test('fetchMedia: request options, status and sha checks', async (t) => {
  const { fetchMedia, loadMediaUrl } = await load()
  const bytes = new Uint8Array(70000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255
  const d = descriptor(bytes, { mime: 'image/png' })
  const calls = []
  const chunks = [bytes.subarray(0, 50000), bytes.subarray(50000)]
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(chunks)
  }
  const deps = { fetch, subtle: webcrypto.subtle }
  const got = await fetchMedia(AUTHOR, d, deps)
  t.is(got.byteLength, bytes.byteLength)
  t.is(calls[0].url, '/media/' + AUTHOR + '/' + d.core + '/1/3')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.cache, 'force-cache')
  t.is(calls[0].opts.redirect, 'error')

  await t.exception(() => fetchMedia(AUTHOR, { ...d, sha256: 'ee'.repeat(32) }, deps), /não confere/)
  await t.exception(() => fetchMedia(AUTHOR, d, { ...deps, fetch: async () => response(chunks, 404) }), /indisponível/)
  await t.exception(() => fetchMedia(AUTHOR, d, { ...deps, fetch: async () => response(chunks, 206) }), /indisponível/)
  await t.exception(() => fetchMedia(AUTHOR, d, { ...deps, fetch: async () => ({ ...response(chunks), redirected: true }) }), /indisponível/)
  let fetched = false
  await t.exception(() => fetchMedia('nope', d, { ...deps, fetch: async () => { fetched = true } }), /inválida/)
  t.absent(fetched, 'no request for an invalid author')

  const made = []
  const urlFromBytes = (b, mime) => { made.push({ b, mime }); return 'blob:x' }
  const url = await loadMediaUrl(AUTHOR, d, { ...deps, urlFromBytes })
  t.is(url, 'blob:x')
  t.is(made[0].mime, 'image/png', 'url typed with the descriptor mime')
  t.is(made[0].b.byteLength, bytes.byteLength, 'the verified bytes')
  await t.exception(() => loadMediaUrl(AUTHOR, d, deps), /sem exibição/)
})

test('fetchMedia: without WebCrypto the injected sha256 checks the bytes', async (t) => {
  const { fetchMedia } = await load()
  const bytes = new Uint8Array(100).fill(9)
  const d = descriptor(bytes)
  const hashed = []
  const sha256 = (b) => { hashed.push(b.byteLength); return new Uint8Array(createHash('sha256').update(b).digest()) }
  const deps = { fetch: async () => response([bytes]), subtle: null, sha256 }
  t.is((await fetchMedia(AUTHOR, d, deps)).byteLength, 100)
  t.alike(hashed, [100], 'sha256 used, no "sem criptografia"')
  let err = null
  try {
    await fetchMedia(AUTHOR, descriptor(bytes, { sha256: 'ee'.repeat(32) }), deps)
  } catch (e) { err = e }
  t.ok(err && /não confere/.test(err.message), 'mismatched digest')
  t.absent(err.retryable, 'a mismatch is not retried')
})

test('fetchMedia: without WebCrypto the bundled sha256 is the default', async (t) => {
  const { fetchMedia } = await load()
  const bytes = new Uint8Array(300).fill(4)
  t.is((await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response([bytes]), subtle: null })).byteLength, 300)
  await t.exception(() => fetchMedia(AUTHOR, descriptor(bytes, { sha256: 'ee'.repeat(32) }), { fetch: async () => response([bytes]), subtle: null }), /não confere/)
})

test('fetchMedia: short body, oversized Content-Length and another origin are refused', async (t) => {
  const { fetchMedia } = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  const bytes = new Uint8Array(100).fill(5)
  const d = descriptor(bytes)
  const deps = (res) => ({ fetch: async () => res, subtle: null })
  const withHeaders = (res, h) => Object.assign(res, { headers: { get: (k) => (k === 'content-length' ? h : null) } })

  await t.exception(() => fetchMedia(AUTHOR, d, deps(response([bytes.subarray(10)]))), /incompleto/, 'short body')

  const big = withHeaders(response([bytes]), '101')
  await t.exception(() => fetchMedia(AUTHOR, d, deps(big)), /grande demais/, 'Content-Length above the descriptor')
  t.ok(big.cancelled, 'body cancelled without reading')
  t.is((await fetchMedia(AUTHOR, d, deps(withHeaders(response([bytes]), '100')))).byteLength, 100, 'exact Content-Length passes')

  t.ok(setInstallation('https://example.test'))
  const away = { ...response([bytes]), url: 'https://evil.test/media/x' }
  const err = await fetchMedia(AUTHOR, d, deps(away)).catch((e) => e)
  t.ok(/indisponível/.test(err.message), 'cross-origin res.url')
  t.absent(err.retryable, 'not retried')
  const err404 = await fetchMedia(AUTHOR, d, deps({ ...response([bytes], 404), url: 'https://evil.test/x' })).catch((e) => e)
  t.absent(err404.retryable, 'a 404 from another origin is not retried')
  await t.exception(() => fetchMedia(AUTHOR, d, deps({ ...response([bytes]), url: 'not a url' })), /indisponível/, 'unparsable res.url')
  const same = { ...response([bytes]), url: 'https://example.test/media/' + AUTHOR + '/' + d.core + '/1/1' }
  t.is((await fetchMedia(AUTHOR, d, deps(same))).byteLength, 100, 'same-origin absolute url')
})

test('fetchMedia: a relative url with a same-origin res.url passes on the web', async (t) => {
  const { fetchMedia, mediaUrl } = await load()
  const bytes = new Uint8Array(100).fill(6)
  const d = descriptor(bytes)
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: { origin: 'https://page.test' }, configurable: true, writable: true })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'location', had)
    else delete globalThis.location
  })
  t.ok(mediaUrl(AUTHOR, d).startsWith('/media/'), 'relative request')
  const res = { ...response([bytes]), url: 'https://page.test' + mediaUrl(AUTHOR, d) }
  t.is((await fetchMedia(AUTHOR, d, { fetch: async () => res, subtle: null })).byteLength, 100)
  const away = { ...response([bytes]), url: 'https://other.test' + mediaUrl(AUTHOR, d) }
  await t.exception(() => fetchMedia(AUTHOR, d, { fetch: async () => away, subtle: null }), /indisponível/)
  delete globalThis.location
  await t.exception(() => fetchMedia(AUTHOR, d, { fetch: async () => res, subtle: null }), /indisponível/, 'no location fails, no uncaught throw')
})

test('mediaUrl is absolute on the installation when one is set', async (t) => {
  const { mediaUrl } = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  const d = descriptor(new Uint8Array(40000).fill(7))
  t.ok(setInstallation('https://example.test'))
  t.is(mediaUrl(AUTHOR, d), 'https://example.test/media/' + AUTHOR + '/' + d.core + '/1/2')
  t.is(mediaUrl('ab', d), null)
  setInstallation(null)
  t.is(mediaUrl(AUTHOR, d), '/media/' + AUTHOR + '/' + d.core + '/1/2')
})

// A minimal MPEG-4 audio file (ftyp, moov with mvhd and one trak per
// handler, mdat): enough for audioBounds.
function m4a ({ ms = 3000, handlers = ['soun'], pad = 0 } = {}) {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  // A real sound track: mdhd timescale 1000, a self-contained data reference,
  // one mp4a sample entry and a sample table as long as `ms`.
  const trak = (h) => box('trak', box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii(h), be32(0), be32(0), be32(0), [0]), box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 25, 0, 1, 0, 4, 17, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 18, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(1), be32(ms)), box('stsz', [0, 0, 0, 0], be32(1), be32(1)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(1), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))))
  return new Uint8Array([
    ...box('ftyp', ascii('M4A '), be32(0), ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0)), ...handlers.map(trak)),
    ...box('mdat', new Array(pad).fill(9))
  ])
}

function audioDescriptor (bytes, over = {}) {
  return { ...descriptor(bytes), mime: 'audio/mp4', width: 0, height: 0, ms: 3000, ...over }
}

test('validAudioDescriptor: the records.js voice note rules', async (t) => {
  const { validAudioDescriptor, validDescriptor, MAX_AUDIO_BYTES } = await load()
  const d = audioDescriptor(m4a())
  t.ok(validAudioDescriptor(d))
  t.absent(validDescriptor(d), 'never a diary post descriptor')
  t.absent(validAudioDescriptor(descriptor(m4a())), 'an image descriptor is not a voice note')
  const blocks = Math.ceil((MAX_AUDIO_BYTES + 1) / 32768)
  const bad = {
    'video mime': { mime: 'video/mp4' },
    'other audio mime': { mime: 'audio/mpeg' },
    'with sides': { width: 1 },
    'ms 0': { ms: 0 },
    'ms over': { ms: 120001 },
    'ms float': { ms: 1.5 },
    'over the byte cap': { blocks, bytes: MAX_AUDIO_BYTES + 1 }
  }
  for (const [name, over] of Object.entries(bad)) t.absent(validAudioDescriptor({ ...d, ...over }), name)
  const { ms, ...noMs } = d
  t.absent(validAudioDescriptor(noMs), 'ms required')
  t.absent(validAudioDescriptor({ ...d, extra: 1 }), 'extra key')
  t.absent(validAudioDescriptor(null))
})

test('fetchMedia: a voice note only for chat items, checked by its bytes', async (t) => {
  const { fetchMedia, mediaUrl } = await load()
  const bytes = m4a({ pad: 100 })
  const d = audioDescriptor(bytes)
  t.is(mediaUrl(AUTHOR, d), null, 'a diary post never names audio')
  t.ok(mediaUrl(AUTHOR, d, { chat: true }).startsWith('/media/'))
  await t.exception(() => fetchMedia(AUTHOR, d, { fetch: async () => response([bytes]), subtle: webcrypto.subtle }), /inválida/, 'not a chat item')
  const got = await fetchMedia(AUTHOR, d, { chat: true, fetch: async () => response([bytes]), subtle: webcrypto.subtle })
  t.alike(got, bytes)
  const video = m4a({ handlers: ['soun', 'vide'], pad: 100 })
  await t.exception(() => fetchMedia(AUTHOR, audioDescriptor(video), { chat: true, fetch: async () => response([video]), subtle: webcrypto.subtle }), /não confere/, 'a video track is refused even when the hash matches')
  const img = new Uint8Array(200).fill(3)
  t.is((await fetchMedia(AUTHOR, descriptor(img), { chat: true, fetch: async () => response([img]), subtle: webcrypto.subtle })).byteLength, 200, 'chat photos still pass')
})
