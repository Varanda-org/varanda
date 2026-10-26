/* global fetch, crypto, Blob, URL */

// Verified media fetch for the hosted web app. A photo is fetched from the
// installation that served the page (same origin: GET
// /media/<author>/<core>/<start>/<blocks>, the seeder's media route) and is
// trusted only after every check passed:
// 1. the descriptor passes the same rules as packages/core/lib/records.js
//    (copied here: the app imports nothing from packages for this) and the
//    author is hex64, so no peer text ever reaches the URL unchecked;
// 2. the answer is exactly 200 (redirects are errors, no credentials);
// 3. the body is read with a hard cap of descriptor.bytes: more bytes stop
//    the read and fail, fewer fail;
// 4. the SHA-256 of the bytes (WebCrypto) equals descriptor.sha256;
// Persistence: the device keeps nothing of members it does not follow. With
// deps.persist === false (authors the device does not follow: the Espiadinha, threads,
// profiles, reposts, quotes) every attempt uses cache: 'no-store', so not even
// the browser HTTP cache keeps the photo; otherwise the first attempt may use
// the long cache (force-cache) and retries revalidate (no-cache).
// only then the bytes become a Blob typed with the descriptor's mime (one of
// the four image types) and a blob: URL, which the UI shows as an image and
// nothing else. Every function takes injectable dependencies for tests.

import { MAX_MEDIA_DIMENSION, MAX_MEDIA_ITEM_BLOCKS, MEDIA_BLOCK_BYTES, MEDIA_MIMES, toHex } from './plan.js'

// Same value as packages/core/lib/records.js.
export const MAX_MEDIA_BLOCKS = 8192

const HEX64 = /^[0-9a-f]{64}$/
const KEYS = ['blocks', 'bytes', 'core', 'height', 'mime', 'sha256', 'start', 'width']

const isInt = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max

// Same rules as records.js: exact keys, core and sha256 lowercase hex64, an
// accepted mime, a block range inside the core, a byte count that fits the
// blocks exactly, and sane dimensions. Never throws.
export function validDescriptor (d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false
  const keys = Object.keys(d).sort()
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return false
  if (typeof d.core !== 'string' || !HEX64.test(d.core)) return false
  if (typeof d.sha256 !== 'string' || !HEX64.test(d.sha256)) return false
  if (!MEDIA_MIMES.includes(d.mime)) return false
  if (!isInt(d.start, 1, MAX_MEDIA_BLOCKS - 1)) return false
  if (!isInt(d.blocks, 1, MAX_MEDIA_ITEM_BLOCKS) || d.start + d.blocks > MAX_MEDIA_BLOCKS) return false
  if (!isInt(d.bytes, (d.blocks - 1) * MEDIA_BLOCK_BYTES + 1, d.blocks * MEDIA_BLOCK_BYTES)) return false
  if (!isInt(d.width, 1, MAX_MEDIA_DIMENSION) || !isInt(d.height, 1, MAX_MEDIA_DIMENSION)) return false
  return true
}

// The author as lowercase hex64, or null.
function authorOf (author) {
  if (typeof author !== 'string') return null
  const lower = author.toLowerCase()
  return HEX64.test(lower) ? lower : null
}

// The same-origin path of an item, or null when the author or the
// descriptor is not valid.
export function mediaUrl (author, d) {
  const a = authorOf(author)
  if (a === null || !validDescriptor(d)) return null
  return '/media/' + a + '/' + d.core + '/' + d.start + '/' + d.blocks
}

function fail (message) {
  return new Error(message)
}

// Reads a response body into exactly `expected` bytes; throws when more or
// fewer arrive. Without a readable stream it falls back to arrayBuffer() and
// checks the length after the fact.
export async function readCapped (res, expected) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    if (typeof res.arrayBuffer !== 'function') throw fail('sem corpo')
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength !== expected) throw fail('tamanho errado')
    return buf
  }
  const reader = res.body.getReader()
  const out = new Uint8Array(expected)
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!(value instanceof Uint8Array)) {
      try { reader.cancel().catch(() => {}) } catch {}
      throw fail('corpo inválido')
    }
    if (total + value.byteLength > expected) {
      try { reader.cancel().catch(() => {}) } catch {}
      throw fail('grande demais')
    }
    out.set(value, total)
    total += value.byteLength
  }
  if (total !== expected) throw fail('incompleto')
  return out
}

function defaults (deps = {}) {
  return {
    fetch: deps.fetch || ((...args) => fetch(...args)),
    subtle: deps.subtle || (typeof crypto !== 'undefined' ? crypto.subtle : null)
  }
}

// A failure that may be "not there yet" (a 404 right after the post, before
// the blocks reached the seeder, or a network error): err.retryable = true.
// A length or SHA-256 mismatch, or any other status, is never retryable.
function retryable (message) {
  const err = fail(message)
  err.retryable = true
  return err
}

// -> Uint8Array of the verified bytes; throws on any failed check.
// deps.fresh: revalidate with the server instead of reusing the HTTP cache
// (used by retries, so a stored 404 is not served again).
// deps.persist === false: never store the answer ('no-store' on every attempt).
export async function fetchMedia (author, d, deps) {
  const url = mediaUrl(author, d)
  if (url === null) throw fail('foto inválida')
  const { fetch: get, subtle } = defaults(deps)
  if (!subtle) throw fail('sem criptografia')
  const transient = deps && deps.persist === false
  const cache = transient ? 'no-store' : deps && deps.fresh === true ? 'no-cache' : 'force-cache'
  let res
  try {
    res = await get(url, { method: 'GET', credentials: 'omit', cache, redirect: 'error' })
  } catch {
    throw retryable('sem conexão')
  }
  if (!res || res.status !== 200 || res.redirected === true) {
    try { if (res && res.body) res.body.cancel().catch(() => {}) } catch {}
    if (res && res.status === 404 && res.redirected !== true) throw retryable('indisponível')
    throw fail('indisponível')
  }
  const bytes = await readCapped(res, d.bytes)
  const digest = toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
  if (digest !== d.sha256) throw fail('conteúdo não confere')
  return bytes
}

// -> a blob: URL of the verified bytes, typed with the descriptor's mime.
export async function loadMediaUrl (author, d, deps = {}) {
  const bytes = await fetchMedia(author, d, deps)
  const MakeBlob = deps.Blob || Blob
  const create = deps.createObjectURL || ((blob) => URL.createObjectURL(blob))
  return create(new MakeBlob([bytes], { type: d.mime }))
}
