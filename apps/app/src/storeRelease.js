/* global URL */

// The Android build the installation says Google Play serves now, read from
// /.well-known/app-release.json, and the store notice built on it. The file
// is untrusted: anything but the exact contract below, within 256 bytes, is
// no information and never a notice. Only an app Google Play installed asks
// (a debug build or a sideloaded preview APK has no store update to take),
// and only once an installation is known: without one no request is made.

import { shouldCheck } from './release.js'

export const STORE_RELEASE_PATH = '/.well-known/app-release.json'
export const MAX_STORE_RELEASE_BYTES = 256
export const MAX_STORE_BUILD = 999999999
export const STORE_RELEASE_TIMEOUT_MS = 10000
export const PLAY_LISTING = 'https://play.google.com/store/apps/details?id=app.varanda'

const CONTENT_LENGTH_RE = /^(0|[1-9][0-9]{0,15})$/
// The contract is ASCII, so its length in characters is its length in bytes.
const ASCII_RE = /^[\t\n\r\x20-\x7e]*$/

function plainObject (value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function sameKeys (value, keys) {
  const own = Object.keys(value).sort()
  return own.length === keys.length && own.every((key, i) => key === keys[i])
}

export function validStoreBuild (value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_STORE_BUILD
}

// -> N of exactly {"v":1,"android":{"build":N}}, else null. Never throws.
export function parseStoreRelease (text) {
  try {
    if (typeof text !== 'string' || text.length > MAX_STORE_RELEASE_BYTES || !ASCII_RE.test(text)) return null
    const doc = JSON.parse(text)
    if (!plainObject(doc) || !sameKeys(doc, ['android', 'v']) || doc.v !== 1) return null
    const android = doc.android
    if (!plainObject(android) || !sameKeys(android, ['build'])) return null
    return validStoreBuild(android.build) ? android.build : null
  } catch {
    return null
  }
}

export function storeUpdate (arg) {
  try {
    const { fromPlay, installed, served } = arg
    return fromPlay === true && Number.isInteger(installed) && installed >= 1 &&
      validStoreBuild(served) && served > installed
  } catch {
    return false
  }
}

// Same rule as redirectedAway in src/version.js, for this path.
function redirectedAway (res, installation) {
  if (res.redirected === true) return true
  const url = res.url
  if (typeof url !== 'string' || url === '') return false
  try {
    const u = new URL(url)
    return u.pathname !== STORE_RELEASE_PATH || u.search !== '' || u.username !== '' ||
      u.password !== '' || u.origin !== installation
  } catch {
    return true
  }
}

function cancelBody (res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {})
  } catch {}
}

// -> the body text, or null once it grows past MAX_STORE_RELEASE_BYTES.
async function readBounded (res) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || typeof value.byteLength !== 'number') {
        try { reader.cancel().catch(() => {}) } catch {}
        return null
      }
      total += value.byteLength
      if (total > MAX_STORE_RELEASE_BYTES) {
        try { reader.cancel().catch(() => {}) } catch {}
        return null
      }
      chunks.push(value)
    }
    let text = ''
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.byteLength; i++) text += String.fromCharCode(chunk[i])
    }
    return text
  }
  // React Native's fetch has already buffered the body here, so this bounds
  // what is parsed, not what is downloaded; the abort timer bounds the
  // download, as in fetchDeployedCommit.
  const length = res.headers.get('content-length')
  if (typeof length !== 'string' || !CONTENT_LENGTH_RE.test(length) || Number(length) > MAX_STORE_RELEASE_BYTES) return null
  const text = await res.text()
  return typeof text === 'string' && text.length <= MAX_STORE_RELEASE_BYTES ? text : null
}

async function readStoreRelease (url, installation, f, signal) {
  // No cache option: React Native's fetch turns no-store into a ?_= query,
  // which redirectedAway would reject.
  const res = await f(url, { credentials: 'omit', redirect: 'error', signal })
  if (!res || redirectedAway(res, installation) || !(res.status >= 200 && res.status <= 299)) {
    cancelBody(res)
    return null
  }
  let type = null
  try { type = res.headers.get('content-type') } catch {}
  if (typeof type !== 'string' || !/application\/json/i.test(type)) {
    cancelBody(res)
    return null
  }
  return parseStoreRelease(await readBounded(res))
}

// -> the served build, or null for no installation, a failure, a timeout, an
// abort through signal or anything outside the contract. Never rejects.
export async function fetchStoreRelease ({
  installation = null,
  fetch: f = globalThis.fetch,
  signal = null,
  timeoutMs = STORE_RELEASE_TIMEOUT_MS,
  setTimeout: arm = globalThis.setTimeout,
  clearTimeout: disarm = globalThis.clearTimeout
} = {}) {
  if (typeof installation !== 'string' || installation === '' || typeof f !== 'function') return null
  if (signal && signal.aborted === true) return null
  let controller = null
  try { controller = new globalThis.AbortController() } catch {}
  let timer = null
  let unlink = null
  try {
    // A fetch that ignores the abort still loses the race.
    const ended = new Promise((resolve) => {
      const end = () => {
        try { controller?.abort() } catch {}
        resolve(null)
      }
      timer = arm(end, timeoutMs)
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', end)
        unlink = () => signal.removeEventListener('abort', end)
      }
    })
    const read = readStoreRelease(installation + STORE_RELEASE_PATH, installation, f, controller?.signal)
      .catch(() => null)
    return await Promise.race([read, ended])
  } catch {
    return null
  } finally {
    try { disarm(timer) } catch {}
    try { unlink?.() } catch {}
  }
}

// Checks at start and whenever onActive fires (the app back in front),
// within shouldCheck's cooldown, and reports { update } when it changes.
// Failures are silent and keep the last state; stop() drops a late answer
// and removes the listener. -> stop
export function watchStoreRelease ({
  build,
  origin,
  onActive,
  onChange,
  fetch: f = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = STORE_RELEASE_TIMEOUT_MS,
  setTimeout: arm = globalThis.setTimeout,
  clearTimeout: disarm = globalThis.clearTimeout
} = {}) {
  let stopped = false
  let seq = 0
  let remove = null
  let inflight = null
  const abort = () => {
    const current = inflight
    inflight = null
    try { current?.abort() } catch {}
  }
  const stop = () => {
    stopped = true
    seq += 1
    abort()
    const current = remove
    remove = null
    try { if (typeof current === 'function') current() } catch {}
  }
  if (!build || build.fromPlay !== true || !Number.isInteger(build.versionCode) ||
    typeof origin !== 'function' || typeof onChange !== 'function') return stop

  let lastCheck = null
  let update
  const check = (focus) => {
    if (stopped) return
    let installation = null
    try {
      installation = origin()
      if (typeof installation !== 'string' || installation === '') return
      const at = now()
      if (!shouldCheck({ now: at, lastCheck, visible: true, focus })) return
      // A failed attempt counts too, so foreground returns cannot hammer the
      // network.
      lastCheck = at
    } catch {
      return
    }
    const token = ++seq
    // A newer check replaces an older one still in flight.
    abort()
    let controller = null
    try { controller = new globalThis.AbortController() } catch {}
    inflight = controller
    fetchStoreRelease({ installation, fetch: f, signal: controller?.signal ?? null, timeoutMs, setTimeout: arm, clearTimeout: disarm }).then((served) => {
      if (inflight === controller) inflight = null
      if (stopped || token !== seq || served === null) return
      const next = storeUpdate({ fromPlay: build.fromPlay, installed: build.versionCode, served })
      if (next === update) return
      update = next
      try { onChange({ update }) } catch {}
    }, () => {})
  }
  if (typeof onActive === 'function') {
    try {
      const off = onActive(() => check(true))
      if (typeof off === 'function') remove = off
    } catch {}
  }
  check(false)
  return stop
}
