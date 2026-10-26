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
  class FakeBlob {
    constructor (parts, opts) { made.push({ parts, opts }) }
  }
  const url = await loadMediaUrl(AUTHOR, d, { ...deps, Blob: FakeBlob, createObjectURL: () => 'blob:x' })
  t.is(url, 'blob:x')
  t.is(made[0].opts.type, 'image/png', 'blob typed with the descriptor mime')
})
