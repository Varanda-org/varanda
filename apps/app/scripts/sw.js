/* global self, caches, fetch, Request, Response, Headers, URL, TextDecoder, crypto, __VARANDA_VERSION__, __VARANDA_PRECACHE__ */
'use strict'

// Service worker TEMPLATE. scripts/finish-web.js renders it into dist/sw.js
// after `expo export`, filling in this release's id and its precache list
// (entries { url, sha256 }; /index.html is also checked through its
// varanda-release meta, and its sha256 is that of the final, marked file).
// It is never served from here.
//
// Lifecycle: a new release installs in the background and waits until every
// window of the previous one is closed (no forced activation, no taking over
// open pages), so an open page never sees its caches change mid-session.
// Online, navigations and /varanda-node.js always run what the server
// delivers; the cache only answers when the network does not (offline, or a
// 404/5xx while a deploy replaces the files). Nothing is ever stored outside
// the verified precache of this release.
//
// Every cached response is re-verified before it is returned (verifiedMatch):
// the Cache API is writable by any same-origin script (window.caches), so a
// cache hit is untrusted until its hash matches this release's list.

const VERSION = __VARANDA_VERSION__
const PRECACHE = __VARANDA_PRECACHE__
const PREFIX = 'varanda-shell-'
const CACHE = PREFIX + VERSION

// Paths that are never intercepted (besides /seeder/... and /account/...):
// live configuration, the worker script itself and the seeder's own pages.
const BYPASS = new Set(['/varanda.json', '/sw.js', '/seeder'])
// The account service (Google link, @username; a later moderation panel under
// /account/mod/) is reverse-proxied by Caddy and never part of the shell. The
// Google step returns by a top-level navigation to /account/callback?code=…,
// and the page fetches /account/status, /start, /authorize, /finish...: none
// of them may be answered with the cached index.html (an OAuth error would
// become the app shell), turned into a 503 offline, or looked up in the cache
// at all. The network alone answers them.
const ACCOUNT_PREFIX = '/account/'
const BAD_TYPES = new Set(['opaque', 'opaqueredirect', 'error'])

const abs = (p) => new URL(p, self.location.origin).href
const RELEASE_META = '<meta name="varanda-release" content="' + VERSION + '">'
// Absolute URL -> expected sha256 of every file of this release.
const EXPECTED = new Map(PRECACHE.map((entry) => [abs(entry.url), entry.sha256]))

function isHtml (res) {
  return (res.headers.get('content-type') || '').toLowerCase().startsWith('text/html')
}

function text503 (body) {
  return new Response(body, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

async function sha256hex (buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Fetches one precache entry and checks it belongs to this exact release: a
// deploy or rollback can swap files while the worker installs, and a hosting
// with an SPA fallback answers a missing file with index.html. Any mismatch
// throws, the install fails and the previous worker (if any) stays in charge.
async function fetchEntry (entry) {
  const res = await fetch(new Request(abs(entry.url), { cache: 'reload', credentials: 'omit', redirect: 'error' }))
  if (!res.ok || BAD_TYPES.has(res.type) || res.redirected) {
    throw new Error('precache ' + entry.url + ': HTTP ' + res.status + ' ' + res.type)
  }
  if (entry.url === '/index.html') {
    if (!isHtml(res)) throw new Error('precache /index.html: not text/html')
    const text = await res.clone().text()
    if (!text.includes(RELEASE_META)) {
      throw new Error('precache /index.html: another release')
    }
  } else if (isHtml(res)) {
    throw new Error('precache ' + entry.url + ': text/html (missing file)')
  }
  // Byte for byte, index.html included: a copy torn by an in-place deploy can
  // already carry the release meta.
  if (entry.sha256 && await sha256hex(await res.clone().arrayBuffer()) !== entry.sha256) {
    throw new Error('precache ' + entry.url + ': content differs from this release')
  }
  return res
}

async function precache () {
  // Verify everything first, then store: a failed install writes nothing.
  const responses = await Promise.all(PRECACHE.map(fetchEntry))
  const cache = await caches.open(CACHE)
  try {
    await Promise.all(PRECACHE.map((entry, i) => cache.put(abs(entry.url), responses[i])))
  } catch (err) {
    // A store that failed half way (e.g. out of quota) is dropped: a worker
    // that never activates would never clean it up.
    await caches.delete(CACHE).catch(() => {})
    throw err
  }
}

async function dropOldCaches () {
  const names = await caches.keys()
  await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)))
}

// Headers copied from a cache entry into the response the worker returns.
// The status and headers of a cache entry are attacker-writable just like its
// body (a same-origin script can store the legitimate bytes with status 302
// and its own Location, Set-Cookie, Clear-Site-Data, Refresh, Link...), so
// only these are kept and everything else is dropped.
const KEEP_HEADERS = ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy', 'cache-control']

// Expected content-type family per file extension (header lowercased). A
// cache entry whose content-type is missing or outside its family is
// poisoned: .html text/html*; .js *javascript*; .json *json*; .webmanifest
// application/manifest+json or *json*; .png image/png; .ico image/*; fonts
// font/*, application/font* or application/octet-stream; any other
// extension (or none) anything but text/html*.
const isFont = (t) => t.startsWith('font/') || t.startsWith('application/font') || t === 'application/octet-stream'
const TYPE_RULES = new Map([
  ['.html', (t) => t.startsWith('text/html')],
  ['.js', (t) => t.includes('javascript')],
  ['.json', (t) => t.includes('json')],
  ['.webmanifest', (t) => t.startsWith('application/manifest+json') || t.includes('json')],
  ['.png', (t) => t.startsWith('image/png')],
  ['.ico', (t) => t.startsWith('image/')],
  ['.ttf', isFont],
  ['.otf', isFont],
  ['.woff', isFont],
  ['.woff2', isFont]
])
const notHtml = (t) => !t.startsWith('text/html')

function typeMatches (url, type) {
  if (!type) return false
  const pathname = new URL(url).pathname
  const name = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const rule = (dot >= 0 && TYPE_RULES.get(name.slice(dot).toLowerCase())) || notHtml
  return rule(type.toLowerCase())
}

// The only way a cached response is read. The install-time check is not
// enough: the Cache API is writable by any same-origin script (DevTools, an
// extension, a transient XSS can open this cache and put its own body under a
// hashed bundle URL), so a hit is untrusted until its bytes hash to this
// release's PRECACHE entry. An entry outside the list (there is no runtime
// caching, so nothing else belongs here), with a stored status other than
// 200, an opaque/error type, a content-type outside its family (TYPE_RULES)
// or another hash is deleted and treated as a miss. The stored Response is
// never returned as is: its status and headers are attacker-writable too, so
// a fresh 200 is built from the verified bytes with only KEEP_HEADERS.
// Cost: crypto.subtle hashes a few milliseconds per MB, acceptable on each
// load.
async function verifiedMatch (cache, url) {
  const hit = await cache.match(url)
  if (!hit) return undefined
  const expected = EXPECTED.get(url)
  if (!expected || hit.status !== 200 || BAD_TYPES.has(hit.type) ||
    !typeMatches(url, hit.headers.get('content-type'))) {
    await cache.delete(url)
    return undefined
  }
  const buf = await hit.arrayBuffer()
  const ok = await sha256hex(buf) === expected &&
    (url !== abs('/index.html') || new TextDecoder().decode(buf).includes(RELEASE_META))
  if (!ok) {
    await cache.delete(url)
    return undefined
  }
  const headers = new Headers()
  for (const name of KEEP_HEADERS) {
    const value = hit.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(buf, { status: 200, statusText: 'OK', headers })
}

async function cached (pathname) {
  const cache = await caches.open(CACHE)
  return verifiedMatch(cache, abs(pathname))
}

// Navigation: network first, never stored. The cached shell of this release
// answers offline and when the server fails (404 or 5xx, e.g. a reload while
// a deploy empties the directory); without a shell, the network answer stands.
async function navigate (request) {
  let res
  try {
    res = await fetch(request)
  } catch {
    return (await cached('/index.html')) || text503('sem conexão')
  }
  // A redirect reaches a navigation as an opaque redirect (status 0): it is
  // passed on so the browser follows it.
  if (res.ok || res.type === 'opaqueredirect') return res
  return (await cached('/index.html')) || res
}

// /varanda-node.js is not content-hashed: network first, never stored here.
// The cached copy answers offline, on a failed status or when the server
// answers with HTML (a missing file behind an SPA fallback).
async function nodeScript (request) {
  let res
  try {
    res = await fetch(request)
  } catch {
    return (await cached('/varanda-node.js')) || text503('sem conexão')
  }
  if (res.ok && !isHtml(res)) return res
  const copy = await cached('/varanda-node.js')
  if (copy) return copy
  return isHtml(res) ? text503('tipo inesperado') : res
}

// Everything else: cache first, otherwise the network, never stored. A miss
// is a file outside this release's verified precache (e.g. a newer release's
// bundle, possibly still being written): keeping it could pin a broken file.
// A cached copy that fails verification is a miss too.
async function cacheFirst (request) {
  const cache = await caches.open(CACHE)
  const hit = await verifiedMatch(cache, request.url)
  if (hit) return hit
  let res
  try {
    res = await fetch(request)
  } catch {
    return text503('sem conexão')
  }
  // HTML here is the fallback for a missing file; with nosniff it would
  // otherwise blank the page as a script or style.
  if (isHtml(res)) return text503('tipo inesperado')
  return res
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(dropOldCaches())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const pathname = url.pathname
  if (BYPASS.has(pathname) || pathname.startsWith('/seeder/') || pathname.startsWith(ACCOUNT_PREFIX)) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
  } else if (pathname === '/varanda-node.js') {
    event.respondWith(nodeScript(request))
  } else {
    event.respondWith(cacheFirst(request))
  }
})
