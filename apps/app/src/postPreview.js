/* global AbortController, URL */

// The seeder's public preview of one post (GET /p/<D>/<seq>/previa), shown
// before sign-in. Everything in the answer is untrusted, so every doubt
// answers null and a valid answer is rebuilt field by field. Pure ES module:
// no React and no Node built-ins, so Metro bundles it and the tests load it
// with import(). The caller supplies the origin: resolveUrl gives a bare
// relative path while no installation is set.
//
// No identifier rides on the request: no credentials, no header, no query,
// no cache option. One call sends at most one request and keeps nothing.

import { postRef } from './postLink.js'

export const PREVIEW_PATH_SUFFIX = '/previa'
export const PHOTO_PATH_SUFFIX = '/foto/'
export const PREVIEW_TIMEOUT_MS = 5000
export const PREVIEW_MAX_BYTES = 65536
export const MAX_PHOTOS = 4
export const MAX_MORE_PHOTOS = 6
export const TEXT_MAX = 1000
export const NAME_MAX = 80
export const USERNAME_MAX = 40
export const CARD_FIELD_MAX = 300

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/

function postPath (target) {
  return '/p/' + target.author + '/' + target.seq
}

function valid (origin, target) {
  return isBareOrigin(origin) && postRef(target) !== null
}

export function previewUrl (origin, target) {
  return valid(origin, target) ? origin + postPath(target) + PREVIEW_PATH_SUFFIX : null
}

export function photoUrl (origin, target, n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PHOTOS) return null
  return valid(origin, target) ? origin + postPath(target) + PHOTO_PATH_SUFFIX + n : null
}

// -> Promise<model | null>, never rejects. timeoutMs exists for the tests and
// can only shorten the default.
export async function fetchPostPreview ({ origin, post, signal, timeoutMs } = {}) {
  let url
  try {
    url = previewUrl(origin, post)
  } catch {
    url = null
  }
  if (url === null) return null
  if (signal && signal.aborted) return null
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs < PREVIEW_TIMEOUT_MS ? timeoutMs : PREVIEW_TIMEOUT_MS
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  if (signal) signal.addEventListener('abort', onAbort)
  // The timer also covers reading the body: a slow trickle is not an answer.
  const timer = setTimeout(() => ctl.abort(), ms)
  let text
  try {
    // No cache option: React Native's fetch (whatwg-fetch) turns 'no-store'
    // into a ?_=<time> query, which redirectedAway refuses. redirect 'error'
    // stops a browser before it asks the redirect target; React Native
    // ignores the option and follows, so redirectedAway stays the native check.
    const res = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal: ctl.signal })
    if (redirectedAway(res, url)) return null
    if (res.status !== 200) return null
    // A chunked answer without Content-Length is still read whole, for up to
    // the timeout: React Native has no streaming body reader, and the origin
    // is the person's own installation.
    if (declaredTooLong(res)) return null
    text = await res.text()
    if (ctl.signal.aborted) return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    // An early return leaves the body unread, and with the timer and the
    // caller's listener gone a browser would keep downloading it.
    ctl.abort()
  }
  if (typeof text !== 'string' || utf8Length(text) > PREVIEW_MAX_BYTES) return null
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlain(body)) return null
  return parsePreview(body.post)
}

export function parsePreview (p) {
  if (!isPlain(p) || p.v !== 1) return null
  const { name, username, date, text, photoCount, morePhotos, video, relation, card } = p
  if (name !== null && typeof name !== 'string') return null
  if (username !== null && typeof username !== 'string') return null
  if (typeof date !== 'string' || typeof text !== 'string') return null
  if (!Number.isInteger(photoCount) || photoCount < 0 || photoCount > MAX_PHOTOS) return null
  if (!Number.isInteger(morePhotos) || morePhotos < 0 || morePhotos > MAX_MORE_PHOTOS) return null
  // The seeder counts extra photos only past a full grid of MAX_PHOTOS.
  if (morePhotos > 0 && photoCount !== MAX_PHOTOS) return null
  if (typeof video !== 'boolean') return null
  if (video && (photoCount > 1 || morePhotos > 0)) return null
  if (relation !== null && relation !== 'quote' && relation !== 'reply') return null
  let outCard = null
  if (card !== null) {
    if (!isPlain(card) || typeof card.title !== 'string' || typeof card.host !== 'string') return null
    if (card.title === '' && card.host === '') return null
    outCard = { title: capped(card.title, CARD_FIELD_MAX), host: capped(card.host, CARD_FIELD_MAX) }
  }
  return {
    name: name === null ? null : capped(name, NAME_MAX),
    username: username === null ? null : capped(username, USERNAME_MAX),
    date: DATE_RE.test(date) ? date : '',
    text: capped(text, TEXT_MAX),
    photoCount,
    morePhotos,
    video,
    relation,
    card: outCard
  }
}

// The seeder caps by code point, so a UTF-16 cut could split an emoji. A
// string no longer than max in UTF-16 units has at most max code points.
function capped (s, max) {
  return s.length > max ? Array.from(s).slice(0, max).join('') : s
}

function declaredTooLong (res) {
  const h = res.headers
  if (!h || typeof h.get !== 'function') return false
  const v = h.get('content-length')
  if (typeof v !== 'string' || !/^\d+$/.test(v.trim())) return false
  return Number(v.trim()) > PREVIEW_MAX_BYTES
}

// TextEncoder is not on every React Native engine. A lone surrogate counts 3,
// as the encoder's U+FFFD would.
function utf8Length (s) {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

function isPlain (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// React Native's fetch follows a redirect and leaves `redirected` unset, so
// the final URL is judged too. An absent or empty url is judged by
// `redirected` alone.
function redirectedAway ({ redirected, url } = {}, asked) {
  if (redirected === true) return true
  if (typeof url !== 'string' || url === '') return false
  try {
    const u = new URL(url)
    const want = new URL(asked)
    if (u.pathname !== want.pathname || u.search !== '' || u.username !== '' || u.password !== '') return true
    return u.origin !== want.origin
  } catch {
    return true
  }
}

function isBareOrigin (origin) {
  if (typeof origin !== 'string') return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol === 'http:') {
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false
  } else if (url.protocol !== 'https:') {
    return false
  }
  // The exact spelling of an origin: no path, slash, query, fragment,
  // credentials, default port or uppercase host.
  return url.origin === origin
}
