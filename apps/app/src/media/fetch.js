/* global fetch, crypto, URL, AbortController */

// Verified media fetch for the hosted web app. A photo is fetched from the
// installation that served the page (same origin: GET
// /media/<author>/<core>/<start>/<blocks>, the seeder's media route) and is
// trusted only after every check passed:
// 1. the descriptor passes the same rules as packages/core/lib/records.js
//    (copied here: the app imports nothing from packages for this) and the
//    author is hex64, so no peer text ever reaches the URL unchecked;
// 2. the answer is exactly 200 (redirects are errors, no credentials; React
//    Native may follow a redirect anyway, so a redirected answer or one whose
//    final URL has another origin fails too);
// 3. a Content-Length above descriptor.bytes fails before the body is read,
//    and the body is read with a hard cap of descriptor.bytes: more bytes
//    stop the read and fail, fewer fail;
// 4. the SHA-256 of the bytes (WebCrypto, or @noble/hashes where there is no
//    WebCrypto, as in React Native) equals descriptor.sha256;
// Persistence: the device keeps nothing of members it does not follow. With
// deps.persist === false (authors the device does not follow: the Espiadinha, threads,
// profiles, reposts, quotes) every attempt uses cache: 'no-store', so not even
// the browser HTTP cache keeps the photo; otherwise the first attempt may use
// the long cache (force-cache) and retries revalidate (no-cache).
// only then the bytes go to deps.urlFromBytes (the caller passes the one from
// ./display: a blob: URL on the web, a cache file:// URI natively) typed with
// the descriptor's mime (one of the four image types), which the UI shows as
// an image and nothing else. The display module is injected, not imported,
// so this file stays loadable in Node. Every function takes injectable
// dependencies for tests.

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { isAppClient } from '../appClient.js'
import { installationOrigin, resolveUrl } from '../installation.js'
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

// The URL of an item on the installation (a same-origin path on the web), or
// null when the author or the descriptor is not valid.
export function mediaUrl (author, d) {
  const a = authorOf(author)
  if (a === null || !validDescriptor(d)) return null
  return resolveUrl('/media/' + a + '/' + d.core + '/' + d.start + '/' + d.blocks)
}

function fail (message) {
  return new Error(message)
}

// Reads a response body into exactly `expected` bytes; throws when more or
// fewer arrive. Without a readable stream it falls back to arrayBuffer() and
// checks the length after the fact. `stop` (optional) aborts the request
// when the body is refused, so no further bytes are downloaded.
export async function readCapped (res, expected, stop = () => {}) {
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
      stop()
      throw fail('corpo inválido')
    }
    if (total + value.byteLength > expected) {
      try { reader.cancel().catch(() => {}) } catch {}
      stop()
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
    subtle: deps.subtle !== undefined ? deps.subtle : (typeof crypto !== 'undefined' && crypto.subtle) || null,
    sha256: deps.sha256 || nobleSha256
  }
}

async function digestHex ({ subtle, sha256 }, bytes) {
  if (subtle) return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
  return toHex(sha256(bytes))
}

// True when the answer may come from somewhere else than `url`: a followed
// redirect, or a final URL on another origin. On the web `url` is a relative
// path, resolved against the page. Any exception counts as true.
function leftOrigin (res, url) {
  try {
    if (res.redirected === true) return true
    if (typeof res.url !== 'string' || res.url === '') return false
    const base = installationOrigin() || globalThis.location.origin
    return new URL(res.url).origin !== new URL(url, base).origin
  } catch {
    return true
  }
}

// A declared length above the expected one fails before any byte is read.
function tooLong (res, expected) {
  try {
    const h = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null
    if (h === null || h === undefined) return false
    const n = Number(String(h).trim())
    return !Number.isFinite(n) || n > expected
  } catch {
    return true
  }
}

function cancelBody (res) {
  try { if (res && res.body) res.body.cancel().catch(() => {}) } catch {}
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
// The native app (isAppClient()) sends no cache option at all. RN's
// fetch is whatwg-fetch, which appends '_=<timestamp>' to the URL for
// 'no-store' and 'no-cache', and the seeder's /media route answers 404 to any
// query, so every transient fetch and every retry would fail. whatwg-fetch
// also resolves only after XHR buffered the whole body, too late for the
// caps, so MediaView and Avatar pass deps.fetch = expo/fetch natively: its
// body is a stream, and an AbortSignal cancels the native request as soon as
// more bytes than descriptor.bytes arrive. expo/fetch has no cache mode
// either, so persist: false sends the header 'Cache-Control: no-store'
// instead. Residuals: the platform HTTP cache (iOS URLCache in particular)
// may ignore that header and keep a /media answer (served immutable) inside
// the app's own cache directory; and native code may buffer what arrives
// between the headers and the first read. Without deps.fetch the global fetch
// is used, bounded for an honest seeder by MAX_MEDIA_ITEM_BLOCKS *
// MEDIA_BLOCK_BYTES; the risk there is a compromised installation host. The
// verified bytes shown on screen still go only to the cache files
// ./display.native.js sweeps.
export async function fetchMedia (author, d, deps) {
  const url = mediaUrl(author, d)
  if (url === null) throw fail('foto inválida')
  const hashing = defaults(deps)
  const get = hashing.fetch
  const transient = deps && deps.persist === false
  const init = { method: 'GET', credentials: 'omit', redirect: 'error' }
  let stop = () => {}
  if (!isAppClient()) {
    init.cache = transient ? 'no-store' : deps && deps.fresh === true ? 'no-cache' : 'force-cache'
  } else {
    if (transient) init.headers = { 'Cache-Control': 'no-store' }
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController()
      init.signal = ctrl.signal
      stop = () => { try { ctrl.abort() } catch {} }
    }
  }
  let res
  try {
    res = await get(url, init)
  } catch {
    throw retryable('sem conexão')
  }
  if (!res || res.status !== 200 || leftOrigin(res, url)) {
    cancelBody(res)
    stop()
    if (res && res.status === 404 && !leftOrigin(res, url)) throw retryable('indisponível')
    throw fail('indisponível')
  }
  if (tooLong(res, d.bytes)) {
    cancelBody(res)
    stop()
    throw fail('grande demais')
  }
  let bytes
  try {
    bytes = await readCapped(res, d.bytes, stop)
  } catch (err) {
    stop()
    throw err
  }
  if (await digestHex(hashing, bytes) !== d.sha256) throw fail('conteúdo não confere')
  return bytes
}

// The URL deps.urlFromBytes makes of verified bytes typed with `mime`.
export function displayUrl (bytes, mime, deps = {}) {
  if (typeof deps.urlFromBytes !== 'function') throw fail('sem exibição')
  return deps.urlFromBytes(bytes, mime)
}

// -> a displayable URL of the verified bytes, typed with the descriptor's
// mime (deps.urlFromBytes: blob: on the web, file:// natively).
export async function loadMediaUrl (author, d, deps = {}) {
  const bytes = await fetchMedia(author, d, deps)
  return displayUrl(bytes, d.mime, deps)
}
