/* global self, caches, fetch, Request, Response, Headers, URL, TextDecoder, crypto, clients, MessageChannel, __VARANDA_VERSION__, __VARANDA_PRECACHE__ */
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
// Online, navigations always run what the server delivers; the cached shell
// only answers when the network does not (offline, or a 404/5xx while a deploy
// replaces the files). The page loads the node copy named for its own release
// (/varanda-node-<release>.js, scripts/finish-web.js), a precached file like a
// hashed bundle: the cached shell of this release runs this release's node,
// and a page of another release never gets it. /varanda-node.js itself is
// not precached, so only the network answers it.
//
// Besides the verified precache of this release, the worker stores only
// values it builds itself (the DM mute record, the block list, a received
// share), never a network response, and never serves them.
//
// Every cached response is re-verified before it is returned (verifiedMatch):
// the Cache API is writable by any same-origin script (window.caches), so a
// cache hit is untrusted until its hash matches this release's list.
//
// A DM wake this device should not show is shown quietly and closed at once:
// while an app window is visible and focused (it gets a varanda-dm-wake
// message instead), and for DM_WAKE_MUTE_MS after this browser's own app
// window reported sending a DM (the wake is then most likely our own message
// echoed back). It is never left unshown: the subscription is userVisibleOnly
// (src/pushClient.web.js), and WebKit documents that it revokes a
// subscription whose push handler does not show a notification, for any
// reason. The quiet notice has its own tag, so it never replaces or closes a
// real DM wake still on screen. Whether Chrome counts a notice closed at once
// as shown (with the app in the background it may show its own generic
// notice) is not verified: the manual matrix in docs/verification.md section
// 112 records it, and its results go back to the owner. On Android the close
// is not at once: it waits QUIET_CLOSE_WAIT_MS (see showQuietlyAndClose).
//
// The DM notices (kinds dm and dm-page) replace the wake: the account service
// sends them to each recipient, never to the sender, so they never take the
// own-send mute, which would hide a real message that arrives just after this
// device sent one. A dm notice takes the wake's focused-window hand-off and
// quiet notice; a dm-page notice always shows, since the hand-off only
// re-reads the member inbox and the Pagina's thread lives in its own. A
// group notice (kinds group and group-private) always shows for the same
// reason: that hand-off never refreshes a group thread. A click opens
// Conversas, where the groups live, and the notification stores neither the
// group key nor its name. The wake stays for one release, for an account
// service that still sends it.

const VERSION = __VARANDA_VERSION__
const PRECACHE = __VARANDA_PRECACHE__
const PREFIX = 'varanda-shell-'
const CACHE = PREFIX + VERSION

// Paths that are never intercepted (besides /seeder/..., /account/..., /media/..., /blob/..., /index/..., /f/... and /p/...):
// live configuration, the worker script itself and the seeder's own pages.
// /version.json is live deploy state written by deploy.sh: never precached,
// never answered from the cache or with the shell, so offline it fails like
// any network error. The pathname check below already ignores a query string.
const BYPASS = new Set(['/varanda.json', '/sw.js', '/seeder', '/version.json', '/f', '/p'])
// The account service (Google link, @username; a later moderation panel under
// /account/mod/) is reverse-proxied by Caddy and never part of the shell. The
// Google step returns by a top-level navigation to /account/callback?code=…,
// and the page fetches /account/status, /start, /authorize, /finish...: none
// of them may be answered with the cached index.html (an OAuth error would
// become the app shell), turned into a 503 offline, or looked up in the cache
// at all. The network alone answers them.
const ACCOUNT_PREFIX = '/account/'
// Post media (/media/<diary>/<core>/<start>/<blocks>) is served by the seeder
// through Caddy with its own long-lived Cache-Control and real 404s. Like the
// account service, the worker never answers it: no cache lookup, no 503.
const MEDIA_PREFIX = '/media/'
// Chat media chunks (/blob/<id>/<index>, sealed ciphertext from the seeder's
// anonymous blob pool) follow the same rule: never cached in the shell, never
// answered with the shell or a 503.
const BLOB_PREFIX = '/blob/'
// The seeder's engagement index (/index/post/..., /index/counts/...,
// /index/member/..., the account search /index/search/...) and its topic
// search (/index/topic/...) are proxied by Caddy the same way, with their own
// no-store and real 404s: never answered by the worker either (an app route
// such as /indexes keeps the shell: only the '/index/' prefix is bypassed).
const INDEX_PREFIX = '/index/'
// The Feira's public pages (/f/<diary>/<seq>, .../foto/<n>, /f/sitemap.xml)
// come from the seeder with their own headers and real 404s. Only the '/f/'
// prefix is bypassed; /anuncio/... is an app route that keeps the shell, and
// /robots.txt is a Caddy response the worker never looks at.
const FEIRA_PREFIX = '/f/'
// Public post pages (/p/<diary>/<seq>, .../foto/<n>, .../previa, /p/policy) come from the
// seeder with their own headers, a 302 and real 404s. Only '/p/' is bypassed;
// /publicacao/... is an app route that keeps the shell.
const POST_PAGE_PREFIX = '/p/'
const BAD_TYPES = new Set(['opaque', 'opaqueredirect', 'error'])
// Mute deadline for DM wakes after an own send. The cache name must not start
// with PREFIX (dropOldCaches deletes those), and the fetch handler only ever
// opens CACHE, so this synthetic entry is never served.
const DM_WAKE_MUTE_MS = 120000
const DM_STATE_CACHE = 'varanda-dm-state'
const DM_STATE_KEY = self.location.origin + '/__varanda-dm-state'
// The member's own block list, which the page reports (src/pushBlocks.web.js):
// a push from one of these keys stays quiet. Same cache rules as above.
const BLOCK_STATE_CACHE = 'varanda-block-state'
const BLOCK_STATE_KEY = self.location.origin + '/__varanda-blocks'
const BLOCKS_MAX = 500
// Web Share Target (manifest share_target, POST multipart): the share waits
// here until the app reads it (src/shareIntake.web.js). Same cache rules as
// above, so it is never served and dropOldCaches leaves it alone.
const SHARE_PATH = '/compartilhar'
const SHARE_CACHE = 'varanda-share'
const SHARE_KEY_PREFIX = '/__varanda-share/'
const SHARE_MAX_FILES = 10
const SHARE_MAX_BYTES = 50 * 1024 * 1024
const SHARE_MAX_TEXT = 4000
// No HEIC: the post composer cannot show or send it. A video is MP4 only, the
// one container the browser composer takes without re-encoding.
const SHARE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const SHARE_VIDEO = 'video/mp4'

const abs = (p) => new URL(p, self.location.origin).href
const RELEASE_META = '<meta name="varanda-release" content="' + VERSION + '">'
// Absolute URL -> expected sha256 of every file of this release.
const EXPECTED = new Map(PRECACHE.map((entry) => [abs(entry.url), entry.sha256]))

function isHtml (res) {
  return (res.headers.get('content-type') || '').toLowerCase().startsWith('text/html')
}

// /index.html must carry the protections of deploy/seeder/Caddyfile, checked
// at install (fetchEntry) and again at serve (verifiedMatch), by directive
// because Caddy fills the domain into connect-src: nosniff; frame-ancestors
// 'none' (no framing); script-src only 'self' and 'wasm-unsafe-eval' (no
// inline, eval or other script origin), and no script-src-elem or
// script-src-attr, which take its place for script elements and inline
// handlers; object-src 'none' (no plugins); base-uri 'none' (a <base> cannot
// move the relative script URLs). The browser splits a policy on ';' and on
// ASCII whitespace only, so a byte outside printable ASCII (a vertical tab, a
// non-breaking space) refuses the header instead of being read as a
// separator, and only the space (all Caddy sends) separates tokens. A comma
// means more than one policy: refused.
const CSP_EXACT = [['frame-ancestors', ["'none'"]], ['object-src', ["'none'"]], ['base-uri', ["'none'"]]]
const SCRIPT_SOURCES = new Set(["'self'", "'wasm-unsafe-eval'"])
const SCRIPT_OVERRIDES = ['script-src-elem', 'script-src-attr']

function headersOk (headers) {
  if ((headers.get('x-content-type-options') || '').toLowerCase() !== 'nosniff') return false
  const csp = headers.get('content-security-policy')
  if (!csp || !/^[\x20-\x7e]*$/.test(csp) || csp.includes(',')) return false
  const directives = new Map()
  for (const part of csp.split(';')) {
    const [name, ...values] = part.toLowerCase().split(' ').filter(Boolean)
    // The browser enforces the first occurrence of a directive and ignores the rest.
    if (name && !directives.has(name)) directives.set(name, values)
  }
  if (SCRIPT_OVERRIDES.some((name) => directives.has(name))) return false
  for (const [name, expected] of CSP_EXACT) {
    const values = directives.get(name)
    if (!values || values.join(' ') !== expected.join(' ')) return false
  }
  const script = directives.get('script-src')
  return Boolean(script && script.length > 0 && script.every((v) => SCRIPT_SOURCES.has(v)))
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
  if (entry.url === '/index.html' && !headersOk(res.headers)) {
    throw new Error('precache /index.html: missing or weak CSP or nosniff')
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

// The offline shell takes none of its entry's headers, not even those that
// pass headersOk: it is always served with these constants, the document
// headers of the (cabecalhos_seguranca) snippet of deploy/seeder/Caddyfile,
// with the domain Caddy fills in taken from the worker's own host.
// apps/app/test/sw.test.js pins each one to the Caddyfile. HSTS is left out:
// it only takes effect on a network response.
const SHELL_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' wss://{$VARANDA_DOMAIN}; frame-src https://www.youtube-nocookie.com https://w.soundcloud.com https://open.spotify.com https://embed.music.apple.com; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
const SHELL_HEADERS = [
  ['content-type', 'text/html; charset=utf-8'],
  ['content-security-policy', SHELL_CSP.split('{$VARANDA_DOMAIN}').join(self.location.host)],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
  ['permissions-policy', 'camera=(), microphone=(self), geolocation=()']
]

// Per file extension: the Content-Type the worker serves (a constant, never
// the entry's own) and the stored types (MIME essence, lowercased, parameters
// dropped) a cache entry may carry. The status and headers of a cache entry are
// attacker-writable just like its body: a same-origin script can store the
// legitimate bytes with status 302 and its own Location, Set-Cookie,
// Clear-Site-Data, Refresh, Link, or with a content-type such as
// text/javascriptx plus nosniff, or charset=utf-16le, that makes the browser
// refuse the bundle on every load. So no header is copied from an entry: the
// response gets the constant type of its extension and nosniff. A stored type
// outside its extension's list is poisoned. An extension with no entry here
// (or none) is never served from the cache (typeMatches is false: the entry is
// deleted and the network answers), because there is no safe type to give it.
const isFont = (e) => e.startsWith('font/') || e.startsWith('application/font') || e.startsWith('application/x-font') || e === 'application/octet-stream'
const accepts = (...types) => (e) => types.includes(e)
const JS = ['text/javascript', 'application/javascript', 'application/x-javascript']
const FILE_TYPES = new Map([
  ['.html', { type: 'text/html; charset=utf-8', accept: accepts('text/html') }],
  ['.js', { type: 'text/javascript; charset=utf-8', accept: accepts(...JS) }],
  ['.mjs', { type: 'text/javascript; charset=utf-8', accept: accepts(...JS) }],
  ['.json', { type: 'application/json', accept: accepts('application/json') }],
  ['.webmanifest', { type: 'application/manifest+json', accept: accepts('application/manifest+json', 'application/json') }],
  ['.wasm', { type: 'application/wasm', accept: accepts('application/wasm') }],
  ['.css', { type: 'text/css; charset=utf-8', accept: accepts('text/css') }],
  ['.png', { type: 'image/png', accept: accepts('image/png') }],
  ['.jpg', { type: 'image/jpeg', accept: accepts('image/jpeg') }],
  ['.jpeg', { type: 'image/jpeg', accept: accepts('image/jpeg') }],
  ['.gif', { type: 'image/gif', accept: accepts('image/gif') }],
  ['.webp', { type: 'image/webp', accept: accepts('image/webp') }],
  ['.svg', { type: 'image/svg+xml', accept: accepts('image/svg+xml') }],
  ['.ico', { type: 'image/x-icon', accept: accepts('image/x-icon', 'image/vnd.microsoft.icon', 'image/ico') }],
  ['.woff2', { type: 'font/woff2', accept: isFont }],
  ['.woff', { type: 'font/woff', accept: isFont }],
  ['.ttf', { type: 'font/ttf', accept: isFont }],
  ['.otf', { type: 'font/otf', accept: isFont }],
  ['.txt', { type: 'text/plain; charset=utf-8', accept: accepts('text/plain') }]
])

function fileType (url) {
  const pathname = new URL(url).pathname
  const name = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? FILE_TYPES.get(name.slice(dot).toLowerCase()) : undefined
}

function typeMatches (url, type) {
  if (!type) return false
  const entry = fileType(url)
  return Boolean(entry && entry.accept(type.split(';')[0].trim().toLowerCase()))
}

// The only way a cached response is read. The install-time check is not
// enough: the Cache API is writable by any same-origin script (DevTools, an
// extension, a transient XSS can open this cache and put its own body under a
// hashed bundle URL), so a hit is untrusted until its bytes hash to this
// release's PRECACHE entry. An entry outside the list (there is no runtime
// caching, so nothing else belongs here), with a stored status other than
// 200, an opaque/error type, a content-type outside its extension's list
// (FILE_TYPES) or another hash is deleted and treated as a miss. The stored
// Response is never returned as is: its status and headers are attacker-writable
// too, so a fresh 200 is built from the verified bytes with no header taken
// from the entry: SHELL_HEADERS for /index.html, any other entry its extension's
// constant type plus nosniff. An /index.html whose own headers fail headersOk
// is still deleted like a wrong hash.
// Cost: crypto.subtle hashes a few milliseconds per MB, acceptable on each
// load.
async function verifiedMatch (cache, url) {
  const hit = await cache.match(url)
  if (!hit) return undefined
  const shell = url === abs('/index.html')
  const expected = EXPECTED.get(url)
  if (!expected || hit.status !== 200 || BAD_TYPES.has(hit.type) ||
    !typeMatches(url, hit.headers.get('content-type')) ||
    (shell && !headersOk(hit.headers))) {
    await cache.delete(url)
    return undefined
  }
  const buf = await hit.arrayBuffer()
  const ok = await sha256hex(buf) === expected &&
    (!shell || new TextDecoder().decode(buf).includes(RELEASE_META))
  if (!ok) {
    await cache.delete(url)
    return undefined
  }
  if (shell) return new Response(buf, { status: 200, statusText: 'OK', headers: new Headers(SHELL_HEADERS) })
  const headers = new Headers([['content-type', fileType(url).type], ['x-content-type-options', 'nosniff']])
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

// Everything else: cache first, otherwise the network, never stored. A miss
// is a file outside this release's verified precache (e.g. a newer release's
// bundle or node copy, possibly still being written, or /varanda-node.js):
// keeping it could pin a broken file. A cached copy that fails verification
// is a miss too.
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

function shareId (at) {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return String(at).padStart(13, '0') + '-' + hex
}

const SHARE_ID = /^[0-9]{13}-[0-9a-f]{32}$/

// The share id a stored key belongs to, or null for any other key.
function shareIdOf (key) {
  try {
    const pathname = new URL(typeof key === 'string' ? key : key.url).pathname
    if (!pathname.startsWith(SHARE_KEY_PREFIX)) return null
    const id = pathname.slice(SHARE_KEY_PREFIX.length).split('/')[0]
    return SHARE_ID.test(id) ? id : null
  } catch {
    return null
  }
}

function shareText (form, name) {
  const v = form.get(name)
  return typeof v === 'string' ? v.slice(0, SHARE_MAX_TEXT) : ''
}

// Writes are chained so two shares never interleave their puts and deletes.
let shareWrite = Promise.resolve()
// Arrival time of the newest share this worker stored. The app may already
// have read and released it, so the cache alone cannot tell that a slower,
// earlier request is stale; the worker stays alive while that request's
// respondWith is pending.
let newestShareAt = 0

async function storeShare (share, files) {
  const cache = await caches.open(SHARE_CACHE)
  // Ids start with the zero-padded arrival time: a request that arrived
  // earlier but finished parsing later must not replace a newer share.
  if (share.at < newestShareAt) return
  const at = share.id.slice(0, 13)
  if ((await cache.keys()).some((k) => { const id = shareIdOf(k); return id !== null && id.slice(0, 13) > at })) return
  try {
    for (let n = 0; n < files.length; n++) {
      await cache.put(abs(SHARE_KEY_PREFIX + share.id + '/' + n), new Response(files[n], { headers: { 'content-type': share.files[n].mime } }))
    }
    // Last, so the app never sees a meta whose files are not all stored yet.
    await cache.put(abs(SHARE_KEY_PREFIX + share.id + '/meta'), new Response(JSON.stringify(share), { headers: { 'content-type': 'application/json' } }))
  } catch (err) {
    // Only this share's own keys: a failed replacement (e.g. out of quota)
    // keeps the share already saved.
    for (const key of await cache.keys().catch(() => [])) {
      if (shareIdOf(key) === share.id) await cache.delete(key).catch(() => {})
    }
    throw err
  }
  newestShareAt = Math.max(newestShareAt, share.at)
  // Only the newest share is kept, and only once it is complete. Each older
  // share loses its meta first, and its files only when that delete worked:
  // a meta left behind must never point at files that are gone.
  const older = new Map()
  for (const key of await cache.keys()) {
    const id = shareIdOf(key)
    if (id === share.id) continue
    if (id === null) {
      await cache.delete(key).catch(() => {})
      continue
    }
    if (!older.has(id)) older.set(id, [])
    if (!new URL(typeof key === 'string' ? key : key.url).pathname.endsWith('/meta')) older.get(id).push(key)
  }
  for (const [id, bodies] of older) {
    try {
      await cache.delete(abs(SHARE_KEY_PREFIX + id + '/meta'))
    } catch {
      continue
    }
    for (const key of bodies) await cache.delete(key).catch(() => {})
  }
}

// Read and stripped by src/shareIntake.web.js takeLost.
const SHARE_LOST = '/?compartilhamento=nao-coube'

// The answer is always the redirect, also on a malformed or failed share:
// the person lands in the app either way, never on a browser error page. A
// share that could not be stored (usually out of quota) lands on SHARE_LOST,
// so the app says so instead of opening as if nothing was shared.
async function takeShare (request) {
  // Taken on arrival, before the body is parsed: arrival order decides which
  // share is the newest.
  const at = Date.now()
  let lost = false
  try {
    const form = await request.formData()
    const title = shareText(form, 'title')
    const text = shareText(form, 'text')
    const url = shareText(form, 'url')
    let kept = []
    let total = 0
    let videos = 0
    let video = null
    for (const v of form.getAll('fotos')) {
      if (typeof v === 'string' || !v) continue
      const mime = typeof v.type === 'string' ? v.type.toLowerCase() : ''
      const fits = typeof v.size === 'number' && v.size <= SHARE_MAX_BYTES
      if (mime.startsWith('video/')) {
        videos++
        if (video === null && mime === SHARE_VIDEO && fits) video = { file: v, mime }
        continue
      }
      total++
      if (kept.length < SHARE_MAX_FILES && SHARE_TYPES.has(mime) && fits) {
        kept.push({ file: v, mime })
      }
    }
    // A post holds one video or photos, and photos win: the video is only
    // counted, so the app can say why it was left out.
    if (kept.length === 0 && video !== null) kept = [video]
    // A video that cannot be kept (not MP4, too big) is still stored as a
    // count, so the app says it did not arrive instead of opening blank.
    if (kept.length > 0 || videos > 0 || title.trim() !== '' || text.trim() !== '' || url.trim() !== '') {
      const id = shareId(at)
      const share = { v: 1, id, at, title, text, url, total, videos, files: kept.map((k, n) => ({ n, mime: k.mime })) }
      const files = kept.map((k) => k.file)
      shareWrite = shareWrite.catch(() => {}).then(() => storeShare(share, files))
      try {
        await shareWrite
      } catch {
        lost = true
      }
    }
  } catch {}
  return Response.redirect(abs(lost ? SHARE_LOST : '/'), 303)
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(dropOldCaches())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method === 'POST') {
    const target = new URL(request.url)
    if (target.origin === self.location.origin && target.pathname === SHARE_PATH) event.respondWith(takeShare(request))
    return
  }
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const pathname = url.pathname
  // /.well-known/ holds the native app association files: a missing one must
  // stay a real 404, never the cached shell.
  if (BYPASS.has(pathname) || pathname.startsWith('/seeder/') || pathname.startsWith('/.well-known/') || pathname.startsWith(ACCOUNT_PREFIX) ||
    pathname.startsWith(MEDIA_PREFIX) || pathname.startsWith(BLOB_PREFIX) || pathname.startsWith(INDEX_PREFIX) ||
    pathname.startsWith(FEIRA_PREFIX) || pathname.startsWith(POST_PAGE_PREFIX)) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
  } else {
    event.respondWith(cacheFirst(request))
  }
})

// Web Push. The payload's sender is only as trusted as the account service,
// and a bug there must not put raw peer text, a key or a link on the lock
// screen: anything that fails the strict shape below shows a fixed sentence
// instead. A notification is always shown because the subscription is
// userVisibleOnly. The worker cannot import @varanda/rpc, so the display rule
// for the body is inlined here.
const PUSH_KINDS = ['follow', 'reply', 'like', 'repost', 'quote', 'mention']
// A quote or a mention points at the actor's own post (the one that quotes
// or names the recipient); the others point at the recipient's post.
const ACTOR_REF_KINDS = ['quote', 'mention']
const PUSH_KEYS = ['v', 'kind', 'body', 'actor', 'recipient', 'ref']
const PUSH_FALLBACK = 'Você tem um aviso novo na Varanda'
// The retired DM wake named nobody; shown for one more release.
const DM_WAKE_TEXT = 'Pode haver uma mensagem nova na Varanda'
// The DM notices name nobody either, and their sentences live here: the
// payload carries only its kind and the server's enqueue time g.
const DM_NOTICE_TEXT = new Map([
  ['dm', 'Nova mensagem nas Conversas'],
  ['dm-page', 'Nova mensagem para uma página que você administra']
])
const DM_NOTICE_KEYS = ['v', 'kind', 'g']
// A public group notice carries the group key and a display name (or null).
// A private one carries neither: the name would leave the group, and the key
// is not needed to open Conversas.
const GROUP_PUBLIC_KEYS = ['v', 'kind', 'group', 'body', 'g']
const GROUP_PRIVATE_KEYS = ['v', 'kind', 'g']
// The invite drop carries no text: the sentence lives here, so a payload can
// never put words of its own on the lock screen.
const INVITE_DROP_TITLE = 'Chegou um convite pra sua varanda'
const INVITE_DROP_TEXT = 'Escolha com carinho quem você quer chamar: alguém próximo, que faz falta na conversa.'
// Excluir conta scheduled without a verified passkey: no text and no date
// in the payload either.
const DELETE_SCHEDULED_TITLE = 'Pedido de exclusão da sua conta'
const DELETE_SCHEDULED_TEXT = 'Se não foi você, abra a Varanda e cancele em Ajustes.'
const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):[1-9][0-9]{0,14}$/

function isPlainObject (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    Object.prototype.toString.call(x) === '[object Object]'
}

// Mirrors isDisplayUnsafe in packages/rpc/lib/text.js (single line).
function unsafeCodePoint (c) {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) ||
    (c >= 0xd800 && c <= 0xdfff) || c === 0x200e || c === 0x200f || c === 0x061c
}

function validBody (body) {
  if (typeof body !== 'string') return false
  const points = [...body]
  if (points.length < 1 || points.length > 120) return false
  return points.every((p) => !unsafeCodePoint(p.codePointAt(0)))
}

// The fields a click may carry into the app's URL or a postMessage.
function validTarget (kind, actor, recipient, ref) {
  if (!PUSH_KINDS.includes(kind)) return false
  if (typeof actor !== 'string' || !HEX64.test(actor)) return false
  if (typeof recipient !== 'string' || !HEX64.test(recipient) || actor === recipient) return false
  if (kind === 'follow') return ref === null
  if (typeof ref !== 'string') return false
  const m = REF.exec(ref)
  return m !== null && m[1] === (ACTOR_REF_KINDS.includes(kind) ? actor : recipient)
}

function validPush (p) {
  if (!isPlainObject(p)) return false
  const keys = Object.keys(p)
  if (keys.length !== PUSH_KEYS.length || !PUSH_KEYS.every((k) => Object.prototype.hasOwnProperty.call(p, k))) return false
  return p.v === 1 && validBody(p.body) && validTarget(p.kind, p.actor, p.recipient, p.ref)
}

function isDmWake (p) {
  return isPlainObject(p) && Object.keys(p).length === 2 && p.v === 1 && p.kind === 'dm-wake'
}

function validNoticeTime (g) {
  return Number.isSafeInteger(g) && g > 0
}

function isDmNotice (p) {
  if (!isPlainObject(p)) return false
  const keys = Object.keys(p)
  if (keys.length !== DM_NOTICE_KEYS.length || !DM_NOTICE_KEYS.every((k) => Object.prototype.hasOwnProperty.call(p, k))) return false
  return p.v === 1 && DM_NOTICE_TEXT.has(p.kind) && validNoticeTime(p.g)
}

function isGroupPublicNotice (p) {
  if (!isPlainObject(p)) return false
  const keys = Object.keys(p)
  if (keys.length !== GROUP_PUBLIC_KEYS.length || !GROUP_PUBLIC_KEYS.every((k) => Object.prototype.hasOwnProperty.call(p, k))) return false
  if (p.v !== 1 || p.kind !== 'group' || !validNoticeTime(p.g)) return false
  if (typeof p.group !== 'string' || !HEX64.test(p.group)) return false
  return p.body === null || validBody(p.body)
}

function isGroupPrivateNotice (p) {
  if (!isPlainObject(p)) return false
  const keys = Object.keys(p)
  if (keys.length !== GROUP_PRIVATE_KEYS.length || !GROUP_PRIVATE_KEYS.every((k) => Object.prototype.hasOwnProperty.call(p, k))) return false
  return p.v === 1 && p.kind === 'group-private' && validNoticeTime(p.g)
}

function isGroupNotice (p) {
  return isGroupPublicNotice(p) || isGroupPrivateNotice(p)
}

// Fixed sentences, so the payload cannot choose the words on the lock
// screen. A public notice may only insert a display name validBody accepted.
function groupNoticeBody (p) {
  if (p.kind === 'group-private') return 'Nova mensagem num grupo privado'
  return p.body === null ? 'Nova mensagem num grupo' : 'Nova mensagem em ' + p.body
}

function isInviteDrop (p) {
  return isPlainObject(p) && Object.keys(p).length === 2 && p.v === 1 && p.kind === 'invite-drop'
}

function isDeleteScheduled (p) {
  return isPlainObject(p) && Object.keys(p).length === 2 && p.v === 1 && p.kind === 'delete-scheduled'
}

function readPush (data) {
  if (!data) return null
  try {
    const p = data.json()
    return validPush(p) || isDmWake(p) || isDmNotice(p) || isGroupNotice(p) || isInviteDrop(p) || isDeleteScheduled(p) ? p : null
  } catch {
    return null
  }
}

// Same origin is not enough: the moderation panel (/account/mod/) and the
// other bypassed paths are not the app.
function isAppWindow (c) {
  try {
    const u = new URL(c.url)
    const p = u.pathname
    return u.origin === self.location.origin && !BYPASS.has(p) && !p.startsWith('/seeder/') &&
      !p.startsWith('/.well-known/') && !p.startsWith(ACCOUNT_PREFIX) && !p.startsWith(MEDIA_PREFIX) &&
      !p.startsWith(BLOB_PREFIX) && !p.startsWith(INDEX_PREFIX) && !p.startsWith(FEIRA_PREFIX) &&
      !p.startsWith(POST_PAGE_PREFIX)
  } catch {
    return false
  }
}

// Writes are chained so a slow put can never land after a newer one.
let dmStateWrite = Promise.resolve()
// The same deadline in memory, set at once: a wake read while the cache put
// is still pending must see it. The cache copy only outlives a restart.
let dmMutedUntil = 0

function muteDmWakes () {
  // The worker clock only: a page could hand over any deadline.
  const until = Date.now() + DM_WAKE_MUTE_MS
  dmMutedUntil = until
  dmStateWrite = dmStateWrite.then(async () => {
    const cache = await caches.open(DM_STATE_CACHE)
    await cache.put(DM_STATE_KEY, new Response(JSON.stringify({ v: 1, until }), { headers: { 'content-type': 'application/json' } }))
  }).catch(() => {})
  return dmStateWrite
}

// The record is same-origin writable (window.caches): a malformed or
// oversized deadline is ignored rather than muting wakes indefinitely.
function mutedInMemory () {
  const left = dmMutedUntil - Date.now()
  return left > 0 && left <= DM_WAKE_MUTE_MS
}

async function mutedInCache () {
  try {
    await dmStateWrite
    const cache = await caches.open(DM_STATE_CACHE)
    const res = await cache.match(DM_STATE_KEY)
    if (!res) return false
    const r = JSON.parse(await res.text())
    if (!isPlainObject(r) || Object.keys(r).length !== 2 || r.v !== 1 || !Number.isSafeInteger(r.until)) return false
    const left = r.until - Date.now()
    return left > 0 && left <= DM_WAKE_MUTE_MS
  } catch {
    return false
  }
}

// Memory is read again after the cache: a send reported while the cache was
// being read must still mute this wake.
async function dmWakesMuted () {
  if (mutedInMemory()) return true
  return (await mutedInCache()) || mutedInMemory()
}

let blockStateWrite = Promise.resolve()
// null until read from the cache: the worker may have just started for a push.
let blockedActors = null

function validBlockKeys (keys) {
  return Array.isArray(keys) && keys.length <= BLOCKS_MAX && keys.every((k) => typeof k === 'string' && HEX64.test(k))
}

function rememberBlocks (keys) {
  blockedActors = new Set(keys)
  blockStateWrite = blockStateWrite.then(async () => {
    const cache = await caches.open(BLOCK_STATE_CACHE)
    await cache.put(BLOCK_STATE_KEY, new Response(JSON.stringify({ v: 1, keys }), { headers: { 'content-type': 'application/json' } }))
  }).catch(() => {})
  return blockStateWrite
}

// A read that fails shows the push: losing a notice would be worse.
async function actorBlocked (actor) {
  if (blockedActors === null) {
    try {
      await blockStateWrite
      const cache = await caches.open(BLOCK_STATE_CACHE)
      const res = await cache.match(BLOCK_STATE_KEY)
      const r = res ? JSON.parse(await res.text()) : null
      const keys = isPlainObject(r) && r.v === 1 && validBlockKeys(r.keys) ? r.keys : []
      // A list reported while the cache was being read is newer.
      if (blockedActors === null) blockedActors = new Set(keys)
    } catch {
      return false
    }
  }
  return blockedActors.has(actor)
}

// True when the wake was handed to a visible, focused app window instead.
const DM_WAKE_ACK_MS = 2000

// True only when the window answers on the port. A focused tab that is not
// the app (an image opened directly, say) never does, so its wake still
// becomes a notice.
function handedOver (client) {
  return new Promise((resolve) => {
    let channel
    try {
      channel = new MessageChannel()
    } catch {
      resolve(false)
      return
    }
    let done = false
    let timer = null
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { channel.port1.close() } catch {}
      resolve(ok)
    }
    timer = setTimeout(() => finish(false), DM_WAKE_ACK_MS)
    channel.port1.onmessage = (e) => {
      const d = e && e.data
      finish(isPlainObject(d) && Object.keys(d).length === 1 && d.type === 'varanda-dm-wake-ok')
    }
    try {
      client.postMessage({ type: 'varanda-dm-wake' }, [channel.port2])
    } catch {
      finish(false)
    }
  })
}

async function wakeFocusedWindow () {
  try {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const apps = list.filter((c) => isAppWindow(c))
    for (const c of apps) {
      if (c.visibilityState !== 'visible' || c.focused !== true) continue
      if (!(await handedOver(c))) continue
      // The person is looking at the app on this device, so no notice here;
      // the other app windows of this browser still re-read Conversas.
      for (const other of apps) {
        if (other === c) continue
        try { other.postMessage({ type: 'varanda-dm-wake' }) } catch {}
      }
      return true
    }
    return false
  } catch {
    return false
  }
}

const DM_WAKE_QUIET_TAG = 'varanda-dm-wake-quiet'
const QUIET_CLOSE_WAIT_MS = 2000
let quietShows = 0

// Any browser on Android, the installed app included: there a close sent right
// after showNotification resolved was seen to be lost (see showQuietlyAndClose).
function postsLate () {
  try {
    const ua = self.navigator && self.navigator.userAgent
    return typeof ua === 'string' && ua.includes('Android')
  } catch {
    return false
  }
}

// Shown, so the push is not a silent one, then closed: no sound, no
// vibration, and only notices with this tag are closed. The close is sent at
// once, except on Android, where it waits QUIET_CLOSE_WAIT_MS: an installed
// app there left the notice in the tray after an immediate close, most likely
// because the system posts it asynchronously and the earlier close is lost
// (inferred from one device report, docs/verification/fix-android-quiet-notice-close.md). A later quiet notice with the same tag replaces this one and closes
// after its own wait.
async function showQuietlyAndClose (body = DM_WAKE_TEXT) {
  try {
    await self.registration.showNotification('Varanda', {
      body, icon: '/icon-192.png', tag: DM_WAKE_QUIET_TAG, renotify: false, silent: true, data: { kind: 'dm-wake' }
    })
    const mine = ++quietShows
    if (postsLate()) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_CLOSE_WAIT_MS))
      if (mine !== quietShows) return
    }
    const shown = await self.registration.getNotifications({ tag: DM_WAKE_QUIET_TAG })
    for (const n of shown) {
      try { n.close() } catch {}
    }
  } catch {}
}

async function showPush (data) {
  const p = readPush(data)
  let title = 'Varanda'
  let options = { body: PUSH_FALLBACK, icon: '/icon-192.png', tag: 'varanda-generic', renotify: false, data: {} }
  if (p && isInviteDrop(p)) {
    title = INVITE_DROP_TITLE
    options = { body: INVITE_DROP_TEXT, icon: '/icon-192.png', tag: 'varanda-invite-drop', renotify: false, data: { kind: 'invite-drop' } }
  } else if (p && isDeleteScheduled(p)) {
    title = DELETE_SCHEDULED_TITLE
    options = { body: DELETE_SCHEDULED_TEXT, icon: '/icon-192.png', tag: 'varanda-delete-scheduled', renotify: false, data: { kind: 'delete-scheduled' } }
  } else if (p && isDmWake(p)) {
    if ((await wakeFocusedWindow()) || (await dmWakesMuted())) {
      await showQuietlyAndClose()
      return
    }
    options = { body: DM_WAKE_TEXT, icon: '/icon-192.png', tag: 'varanda-dm-wake', renotify: false, data: { kind: 'dm-wake' } }
  } else if (p && isDmNotice(p)) {
    // A focused window only re-reads the member inbox, never the Pagina's,
    // so a dm-page notice always shows.
    if (p.kind === 'dm' && (await wakeFocusedWindow())) {
      await showQuietlyAndClose(DM_NOTICE_TEXT.get('dm'))
      return
    }
    options = { body: DM_NOTICE_TEXT.get(p.kind), icon: '/icon-192.png', tag: 'varanda-' + p.kind, renotify: false, data: { kind: p.kind, g: p.g } }
  } else if (p && isGroupNotice(p)) {
    // The hand-off only re-reads the member inbox, never a group thread, so
    // this always shows. Data omits the group key and the name: the click
    // only opens Conversas, and neither belongs on the notification.
    options = {
      body: groupNoticeBody(p),
      icon: '/icon-192.png',
      tag: p.kind === 'group' ? 'varanda-group-' + p.group : 'varanda-group-private',
      renotify: false,
      data: { kind: p.kind, g: p.g }
    }
  } else if (p) {
    if (await actorBlocked(p.actor)) {
      await showQuietlyAndClose()
      return
    }
    options = {
      body: p.body,
      icon: '/icon-192.png',
      tag: 'varanda-' + p.kind + '-' + (p.ref || p.actor),
      renotify: false,
      data: { kind: p.kind, actor: p.actor, recipient: p.recipient, ref: p.ref }
    }
  }
  try {
    await self.registration.showNotification(title, options)
  } catch {}
}

// Opens the Avisos screen, never a /m/... or /@... path: those are profile
// invite links with their own flow.
async function openPush (data) {
  const d = isPlainObject(data) ? data : {}
  const ok = validTarget(d.kind, d.actor, d.recipient, d.ref)
  // A DM wake or notice opens Conversas; neither passes anything on. A
  // dm-page notice opens Paginas instead: its thread lives in the Pagina's
  // own inbox, and the notice names no Pagina. A group notice opens
  // Conversas as the member: groups are hidden while acting as a Pagina,
  // and the notification names no group.
  const notice = Object.keys(d).length === 2 && DM_NOTICE_TEXT.has(d.kind) && validNoticeTime(d.g)
  const pageDm = notice && d.kind === 'dm-page'
  const dm = (Object.keys(d).length === 1 && d.kind === 'dm-wake') || (notice && d.kind === 'dm')
  const groupNotice = Object.keys(d).length === 2 && (d.kind === 'group' || d.kind === 'group-private') && validNoticeTime(d.g)
  const invite = Object.keys(d).length === 1 && d.kind === 'invite-drop'
  let path = '/'
  if (ok) path = '/?aviso=' + d.kind + '&actor=' + d.actor + '&recipient=' + d.recipient + (d.ref ? '&ref=' + d.ref : '')
  else if (dm) path = '/?aviso=dm'
  else if (groupNotice) path = '/?aviso=grupo'
  else if (pageDm) path = '/?aviso=dm-page'
  else if (invite) path = '/?aviso=convite'
  try {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const client = list.find(isAppWindow)
    if (client) {
      let focused = true
      try {
        await client.focus()
      } catch {
        // focus() can reject (InvalidAccessError); the click must still open the app.
        focused = false
      }
      if (focused) {
        if (ok) client.postMessage({ source: 'varanda-push', kind: d.kind, actor: d.actor, recipient: d.recipient, ref: d.ref })
        if (dm) client.postMessage({ type: 'varanda-dm-open' })
        if (groupNotice) client.postMessage({ type: 'varanda-group-open' })
        if (pageDm) client.postMessage({ type: 'varanda-page-dm-open' })
        if (invite) client.postMessage({ type: 'varanda-invite-open' })
        return
      }
    }
    // A page that is still loading would miss a message: the query is read
    // once the app starts (pushClient.web.js captureLaunch).
    await clients.openWindow(path)
  } catch {}
}

self.addEventListener('push', (event) => {
  try {
    event.waitUntil(showPush(event.data))
  } catch {}
})

self.addEventListener('notificationclick', (event) => {
  try {
    event.notification.close()
  } catch {}
  try {
    event.waitUntil(openPush(event.notification && event.notification.data))
  } catch {}
})

// A new release waits for every window of the previous one to close, so an
// open page can face an older active worker without the push handler: the
// page pings before offering the toggle. An app window also reports each DM
// it sends, so the wake that echoes it back stays quiet (DM_WAKE_MUTE_MS); the
// DM notices never reach the sender, so the mute leaves them alone.
self.addEventListener('message', (event) => {
  try {
    const d = event.data
    if (!isPlainObject(d)) return
    if (d.type === 'varanda-blocks') {
      const from = event.source
      if (Object.keys(d).length !== 2 || !validBlockKeys(d.keys)) return
      if (!from || from.type !== 'window' || !isAppWindow(from)) return
      const kept = rememberBlocks(d.keys.slice())
      if (typeof event.waitUntil === 'function') event.waitUntil(kept)
      return
    }
    if (Object.keys(d).length !== 1) return
    if (d.type === 'varanda-push-ping') {
      const port = event.ports && event.ports[0]
      if (port) port.postMessage({ source: 'varanda-sw', push: 1 })
      return
    }
    if (d.type !== 'varanda-dm-sent') return
    const source = event.source
    if (!source || source.type !== 'window' || !isAppWindow(source)) return
    const done = muteDmWakes()
    if (typeof event.waitUntil === 'function') event.waitUntil(done)
  } catch {}
})
