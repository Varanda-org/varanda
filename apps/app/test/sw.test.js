'use strict'

// The offline web shell: scripts/finish-web.js renders scripts/sw.js into a
// fake dist, then the generated worker runs in a vm context against fake
// caches, a fake server and fake fetch events.
const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const crypto = require('crypto')
const { finishWeb } = require('../scripts/finish-web')

const TEMPLATE = path.join(__dirname, '..', 'scripts', 'sw.js')
const ROOT = process.env.VARANDA_TEST_TMPDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-sw-'))
const ORIGIN = 'https://example.test'
const BUNDLE = '/_expo/static/js/web/index-0123456789abcdef0123456789abcdef.js'
const INDEX = '<!DOCTYPE html><html lang="pt-BR"><head><title>Varanda</title></head><body><div id="root"></div>' +
  '<script src="' + BUNDLE + '" defer></script></body></html>'

const sha256hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const quiet = (fn) => {
  const log = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = log }
}

let count = 0
function makeDist () {
  const dir = path.join(ROOT, 'dist-' + count++)
  const files = {
    'index.html': INDEX,
    [BUNDLE.slice(1)]: 'console.log("varanda")\n',
    '_expo/static/js/web/index.js.map': '{}',
    'varanda-node.js': 'module.exports = "node"\n',
    'manifest.webmanifest': '{"name":"Varanda"}',
    'icon-192.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    'assets/x.ttf': Buffer.from([0, 1, 0, 0, 9]),
    'favicon.ico': Buffer.from([0, 0, 1, 0]),
    'metadata.json': '{"fileMetadata":{}}'
  }
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

function readWorker (dist) {
  const code = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')
  return {
    code,
    version: JSON.parse(code.match(/^const VERSION = (.*)$/m)[1]),
    precache: JSON.parse(code.match(/^const PRECACHE = (.*)$/m)[1])
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }

// A static server over dist with an SPA fallback: a missing file is answered
// with index.html, 200 text/html (what a hosting without real 404s does).
function serveDist (dist) {
  return (pathname) => {
    const file = path.join(dist, pathname)
    if (pathname !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } })
    }
    return new Response(fs.readFileSync(path.join(dist, 'index.html')), { status: 200, headers: { 'content-type': TYPES['.html'] } })
  }
}

const status = (code, body = 'erro') => () => new Response(body, { status: code, headers: { 'content-type': 'text/plain' } })

// The release cache must only ever hold the precache entries.
function onlyPrecache (t, w, dist, label) {
  const keys = [...w.cache.map.keys()].sort()
  const expected = readWorker(dist).precache.map((e) => ORIGIN + e.url).sort()
  t.alike(keys, expected, label)
  t.is(w.caches.stores.size, 1, 'a single cache')
}

function fakeCaches () {
  const stores = new Map()
  const keyOf = (k) => typeof k === 'string' ? k : k.url
  class Cache {
    constructor () { this.map = new Map() }
    async put (k, res) { this.map.set(keyOf(k), res) }
    async match (k) {
      const res = this.map.get(keyOf(k))
      return res ? res.clone() : undefined
    }

    async delete (k) { return this.map.delete(keyOf(k)) }
  }
  return {
    stores,
    async open (name) {
      if (!stores.has(name)) stores.set(name, new Cache())
      return stores.get(name)
    },
    async keys () { return [...stores.keys()] },
    async delete (name) { return stores.delete(name) },
    async match (k) {
      for (const c of stores.values()) {
        const res = await c.match(k)
        if (res) return res
      }
    }
  }
}

// Loads the generated worker. `server(pathname, request)` answers fetches; it
// may throw to simulate being offline.
function loadWorker (code, server) {
  const handlers = {}
  const caches = fakeCaches()
  const calls = []
  const w = { handlers, caches, calls, server, shown: [], windows: [], opened: [] }
  const fetch = async (request) => {
    calls.push(request.url)
    return w.server(new URL(request.url).pathname, request)
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { handlers[type] = fn },
    registration: {
      showNotification: async (title, options) => { w.shown.push({ title, options }) }
    }
  }
  const clients = {
    matchAll: async (opts) => {
      w.matchAllOpts = opts
      return w.windows
    },
    openWindow: async (url) => { w.opened.push(url) }
  }
  vm.runInNewContext(code, { self, caches, clients, fetch, Request, Response, Headers, URL, TextDecoder, crypto: globalThis.crypto })
  return w
}

async function lifecycle (w, type) {
  const waits = []
  w.handlers[type]({ waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
}

async function dispatch (w, url, { method = 'GET', mode = 'no-cors' } = {}) {
  const waits = []
  let responded = null
  w.handlers.fetch({
    request: { url, method, mode },
    respondWith: (p) => { responded = Promise.resolve(p) },
    waitUntil: (p) => waits.push(p)
  })
  const res = responded && await responded
  await Promise.all(waits)
  return { responded: responded !== null, res }
}

const offline = () => { throw new TypeError('Failed to fetch') }

async function installed () {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const { code, version } = readWorker(dist)
  const w = loadWorker(code, serveDist(dist))
  await lifecycle(w, 'install')
  w.cache = w.caches.stores.get('varanda-shell-' + version)
  w.calls.length = 0
  return { w, dist, version }
}

test('finishWeb renders the precache list and marks index.html', (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  t.absent(fs.existsSync(path.join(__dirname, '..', 'public', 'sw.js')))
  const { version, precache } = readWorker(dist)
  t.ok(/^[0-9a-f]{16}$/.test(version), 'version is 16 lowercase hex')
  const urls = precache.map((e) => e.url)
  for (const u of ['/index.html', BUNDLE, '/varanda-node.js', '/manifest.webmanifest', '/icon-192.png', '/assets/x.ttf', '/favicon.ico']) {
    t.ok(urls.includes(u), 'precaches ' + u)
  }
  for (const u of ['/metadata.json', '/sw.js', '/_expo/static/js/web/index.js.map']) {
    t.absent(urls.includes(u), 'does not precache ' + u)
  }
  for (const e of precache) {
    // index.html's hash is that of the final file, release meta included.
    t.is(e.sha256, sha256hex(fs.readFileSync(path.join(dist, e.url))), e.url + ' sha256')
  }
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  t.is(html.split('<meta name="varanda-release" content="' + version + '">').length, 2, 'one release meta')
  t.is((html.match(/varanda-release/g) || []).length, 1)
  t.absent(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script')
})

test('a second run is byte-identical; any byte change changes the version', (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const sw1 = fs.readFileSync(path.join(dist, 'sw.js'))
  const html1 = fs.readFileSync(path.join(dist, 'index.html'))
  const v1 = readWorker(dist).version
  quiet(() => finishWeb(dist))
  t.ok(sw1.equals(fs.readFileSync(path.join(dist, 'sw.js'))), 'sw.js identical')
  t.ok(html1.equals(fs.readFileSync(path.join(dist, 'index.html'))), 'index.html identical')
  t.is(readWorker(dist).version, v1)
  t.is((html1.toString().match(/varanda-release/g) || []).length, 1, 'still one release meta')

  fs.appendFileSync(path.join(dist, BUNDLE), ';')
  quiet(() => finishWeb(dist))
  const v2 = readWorker(dist).version
  t.not(v2, v1, 'bundle byte changes the version')

  const tpl = path.join(ROOT, 'sw-template-' + count++ + '.js')
  fs.writeFileSync(tpl, fs.readFileSync(TEMPLATE, 'utf8') + '\n')
  quiet(() => finishWeb(dist, tpl))
  t.not(readWorker(dist).version, v2, 'template byte changes the version')
})

test('finishWeb refuses an incomplete export', (t) => {
  for (const missing of ['index.html', 'varanda-node.js', 'manifest.webmanifest', BUNDLE.slice(1)]) {
    const dist = makeDist()
    fs.rmSync(path.join(dist, missing))
    t.exception(() => quiet(() => finishWeb(dist)), /falta|nenhum/, 'without ' + missing)
  }
})

test('install stores every precache path under absolute URLs', async (t) => {
  const { w, dist } = await installed()
  t.ok(w.cache, 'release cache exists')
  for (const e of readWorker(dist).precache) {
    t.ok(w.cache.map.has(ORIGIN + e.url), 'cached ' + e.url)
  }
})

test('install fails on the SPA fallback, a changed byte or another release', async (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const { code } = readWorker(dist)
  const real = serveDist(dist)

  const html = loadWorker(code, (p, r) => p === BUNDLE ? real('/nope') : real(p, r))
  await t.exception(lifecycle(html, 'install'), /text\/html/, 'bundle answered as text/html')

  const changed = loadWorker(code, (p, r) => p === '/varanda-node.js'
    ? new Response('module.exports = "nodf"\n', { headers: { 'content-type': 'text/javascript' } })
    : real(p, r))
  await t.exception(lifecycle(changed, 'install'), /differs/, 'one byte differs')

  const other = loadWorker(code, (p, r) => p === '/index.html'
    ? new Response(INDEX.replace('</head>', '<meta name="varanda-release" content="0000000000000000"></head>'), { headers: { 'content-type': 'text/html' } })
    : real(p, r))
  await t.exception(lifecycle(other, 'install'), /another release/, 'index.html from another release')

  // A copy torn by an in-place deploy: the release meta is there, the rest
  // (root element, bundle script) is not.
  const finalHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const torn = loadWorker(code, (p, r) => p === '/index.html'
    ? new Response(finalHtml.slice(0, finalHtml.indexOf('varanda-release') + 60), { headers: { 'content-type': 'text/html' } })
    : real(p, r))
  await t.exception(lifecycle(torn, 'install'), /differs/, 'a torn index.html with the release meta')

  for (const w of [html, changed, other, torn]) {
    const stored = [...w.caches.stores.values()].reduce((n, c) => n + c.map.size, 0)
    t.is(stored, 0, 'a failed install stores nothing')
  }

  const ok = loadWorker(code, real)
  await t.execution(lifecycle(ok, 'install'), 'exact files install')
})

test('activate drops older shells and keeps its own', async (t) => {
  const { w, version } = await installed()
  await w.caches.open('varanda-shell-old')
  await w.caches.open('other-cache')
  await lifecycle(w, 'activate')
  const names = await w.caches.keys()
  t.absent(names.includes('varanda-shell-old'))
  t.ok(names.includes('varanda-shell-' + version))
  t.ok(names.includes('other-cache'), 'foreign caches are left alone')
})

test('navigation: network first, cached index.html offline', async (t) => {
  const { w, version } = await installed()
  const live = new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } })
  w.server = () => live
  const before = w.cache.map.size
  const on = await dispatch(w, ORIGIN + '/perfil', { mode: 'navigate' })
  t.is(on.res, live, 'the network response unchanged')
  t.is(w.cache.map.size, before, 'nothing stored')
  t.ok((await (await w.cache.match(ORIGIN + '/index.html')).text()).includes(version), 'cached index.html untouched')

  w.server = offline
  const off = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  const body = await off.res.text()
  t.ok(body.includes('<meta name="varanda-release" content="' + version + '">'), 'the cached index.html')
})

// Profile links (/@username, /m/<64>) are extensionless navigations: the same
// shell policy as any other app route.
test('navigation: profile links /@ana and /m/<64> are the app shell', async (t) => {
  const { w, version } = await installed()
  const live = new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } })
  w.server = () => live
  const before = w.cache.map.size
  for (const p of ['/@ana', '/m/' + 'a'.repeat(64)]) {
    const on = await dispatch(w, ORIGIN + p, { mode: 'navigate' })
    t.is(on.res, live, p + ': the network response unchanged')
    t.is(w.cache.map.size, before, p + ': nothing stored')
  }
  t.ok((await (await w.cache.match(ORIGIN + '/index.html')).text()).includes(version), 'cached index.html untouched')

  w.server = offline
  for (const p of ['/@ana', '/m/' + 'a'.repeat(64)]) {
    const off = await dispatch(w, ORIGIN + p, { mode: 'navigate' })
    const shell = await off.res.text()
    t.ok(shell.includes('<meta name="varanda-release" content="' + version + '">'), p + ': the cached index.html')
  }
})

test('navigation answered 404 or 5xx: the cached index.html, or the network answer without one', async (t) => {
  const { w, dist, version } = await installed()
  for (const code of [404, 503]) {
    w.server = status(code)
    const { res } = await dispatch(w, ORIGIN + '/perfil', { mode: 'navigate' })
    t.is(res.status, 200, 'HTTP ' + code + ' is not passed on')
    t.ok((await res.text()).includes('<meta name="varanda-release" content="' + version + '">'), 'cached shell on ' + code)
  }
  onlyPrecache(t, w, dist, 'nothing stored')

  const empty = loadWorker(readWorker(dist).code, status(404, 'nada'))
  const { res } = await dispatch(empty, ORIGIN + '/perfil', { mode: 'navigate' })
  t.is(res.status, 404, 'the network 404 when nothing is cached')
  t.is(await res.text(), 'nada')
})

test('hashed assets: cache first, a miss goes to the network and is not stored, HTML refused', async (t) => {
  const { w, dist } = await installed()
  const hit = await dispatch(w, ORIGIN + BUNDLE)
  t.is(await hit.res.text(), 'console.log("varanda")\n')
  t.is(w.calls.length, 0, 'answered without fetch')

  const other = ORIGIN + '/_expo/static/js/web/other.js'
  w.server = () => new Response('other()', { headers: { 'content-type': 'text/javascript' } })
  const miss = await dispatch(w, other)
  t.is(await miss.res.text(), 'other()')
  t.is(w.calls.length, 1, 'fetched once')
  t.absent(w.cache.map.has(other), 'not stored')

  w.server = status(404)
  const gone = await dispatch(w, ORIGIN + '/assets/gone.png')
  t.is(gone.res.status, 404, 'a non-HTML failure is passed on')

  const missing = ORIGIN + '/_expo/static/js/web/missing.js'
  w.server = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  const html = await dispatch(w, missing)
  t.is(html.res.status, 503)
  t.ok(html.res.headers.get('content-type').startsWith('text/plain'))
  t.is(await html.res.text(), 'tipo inesperado')
  t.absent(w.cache.map.has(missing), 'not stored')
  onlyPrecache(t, w, dist, 'only precache keys after every fetch')
})

test('/varanda-node.js: network first, cached copy on HTML, 404 or offline', async (t) => {
  const { w, dist } = await installed()
  w.server = () => new Response('module.exports = "new"\n', { headers: { 'content-type': 'text/javascript' } })
  const on = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(await on.res.text(), 'module.exports = "new"\n', 'the live copy online')
  t.is(await (await w.cache.match(ORIGIN + '/varanda-node.js')).text(), 'module.exports = "node"\n', 'not stored')

  w.server = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  const html = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(await html.res.text(), 'module.exports = "node"\n', 'the cached copy')

  w.server = status(404)
  const gone = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(await gone.res.text(), 'module.exports = "node"\n', 'the cached copy on 404')

  w.server = offline
  const off = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(await off.res.text(), 'module.exports = "node"\n', 'the cached copy offline')
  onlyPrecache(t, w, dist, 'nothing stored')

  const empty = loadWorker(readWorker(dist).code, status(404, 'nada'))
  t.is((await dispatch(empty, ORIGIN + '/varanda-node.js')).res.status, 404, 'the network 404 when nothing is cached')
  empty.server = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  const html2 = await dispatch(empty, ORIGIN + '/varanda-node.js')
  t.is(html2.res.status, 503)
  t.is(await html2.res.text(), 'tipo inesperado', 'HTML with nothing cached')
})

test('bypassed requests are never intercepted', async (t) => {
  const { w } = await installed()
  for (const url of [ORIGIN + '/varanda.json', ORIGIN + '/sw.js', ORIGIN + '/seeder', ORIGIN + '/seeder/x', 'https://other.test' + BUNDLE]) {
    t.absent((await dispatch(w, url)).responded, url)
  }
  for (const url of [ORIGIN + '/.well-known/assetlinks.json', ORIGIN + '/.well-known/apple-app-site-association']) {
    t.absent((await dispatch(w, url, { mode: 'navigate' })).responded, url)
    t.absent((await dispatch(w, url)).responded, url)
  }
  t.absent((await dispatch(w, ORIGIN + BUNDLE, { method: 'POST' })).responded, 'POST')
})

// The account service (Google link, @username, later /account/mod/) is
// reverse-proxied by Caddy: the OAuth callback is a top-level navigation to
// /account/callback and the page fetches /account/status etc. Offline here,
// so an intercepted request would show as the cached index.html (navigation)
// or a 503; neither is allowed, and the worker makes no fetch of its own.
test('/account/* is never intercepted: the OAuth callback navigation and the API fetches', async (t) => {
  const { w } = await installed()
  w.server = offline
  const callback = await dispatch(w, ORIGIN + '/account/callback?code=4%2Fabc&state=xyz', { mode: 'navigate' })
  t.absent(callback.responded, 'navigation to /account/callback is left to the network')
  for (const p of ['/account/status?member=ab12', '/account/start', '/account/authorize', '/account/pending',
    '/account/finish', '/account/username/maria', '/account/rename', '/account/health', '/account/mod/']) {
    t.absent((await dispatch(w, ORIGIN + p)).responded, p)
  }
  t.is(w.calls.length, 0, 'the worker fetched nothing')
  // Still intercepted: an app route next to it, and the shell itself.
  t.ok((await dispatch(w, ORIGIN + '/accounts', { mode: 'navigate' })).responded, '/accounts is an app route')
  t.ok((await dispatch(w, ORIGIN + '/', { mode: 'navigate' })).responded, '/ is the shell')
})

// Post media is proxied by Caddy to the seeder (long-lived Cache-Control, real
// 404s): the worker must not cache it or turn a failure into a 503.
test('/media/* is never intercepted', async (t) => {
  const { w } = await installed()
  w.server = offline
  for (const p of ['/media/x/y/1/2', '/media/' + 'a'.repeat(64) + '/' + 'b'.repeat(64) + '/0/4']) {
    t.absent((await dispatch(w, ORIGIN + p)).responded, p)
    t.absent((await dispatch(w, ORIGIN + p, { method: 'HEAD' })).responded, 'HEAD ' + p)
  }
  t.is(w.calls.length, 0, 'the worker fetched nothing')
  t.ok((await dispatch(w, ORIGIN + '/medias', { mode: 'navigate' })).responded, '/medias is an app route')
})

// The seeder's engagement index is proxied by Caddy (no-store, real 404s):
// the worker must not cache it, answer it from the shell or turn a failure
// into a 503, for GET or HEAD, online or offline.
test('/index/* is never intercepted', async (t) => {
  const { w } = await installed()
  w.server = offline
  const A = 'a'.repeat(64)
  for (const p of ['/index/post/' + A + '/1', '/index/post/' + A + '/1/1700000000000.' + 'b'.repeat(64) + '.2',
    '/index/counts/' + A + ':1,' + 'b'.repeat(64) + ':2', '/index/member/' + A, '/index/member/' + A + '/10', '/index/search/ana-silva', '/index/x',
    '/index/topic/ceu+azul', '/index/topic/ceu/1700000000000.' + 'b'.repeat(64) + '.2',
    '/index/likes/' + A + '/1', '/index/likes/' + A + '/1/1700000000000.' + 'b'.repeat(64) + '.2',
    '/index/reposts/' + A + '/1', '/index/reposts/' + A + '/1/1700000000000.' + 'b'.repeat(64) + '.2']) {
    t.absent((await dispatch(w, ORIGIN + p)).responded, p)
    t.absent((await dispatch(w, ORIGIN + p, { method: 'HEAD' })).responded, 'HEAD ' + p)
    t.absent((await dispatch(w, ORIGIN + p, { mode: 'navigate' })).responded, 'navigate ' + p)
  }
  t.is(w.calls.length, 0, 'the worker fetched nothing')
  t.ok((await dispatch(w, ORIGIN + '/indexes', { mode: 'navigate' })).responded, '/indexes is an app route')
  t.ok((await dispatch(w, ORIGIN + '/index', { mode: 'navigate' })).responded, '/index (no slash) is an app route')
})

test('nothing cached and offline: 503 sem conexão', async (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const w = loadWorker(readWorker(dist).code, offline)
  for (const opts of [{}, { mode: 'navigate' }]) {
    const { res } = await dispatch(w, ORIGIN + '/assets/y.png', opts)
    t.is(res.status, 503)
    t.is(await res.text(), 'sem conexão')
  }
  const node = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(await node.res.text(), 'sem conexão')
})

test('a store that fails half way (out of quota) drops the release cache', async (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const { code, version } = readWorker(dist)
  const w = loadWorker(code, serveDist(dist))
  const open = w.caches.open
  w.caches.open = async (name) => {
    const cache = await open(name)
    const put = cache.put.bind(cache)
    cache.put = async (k, res) => {
      if ((typeof k === 'string' ? k : k.url).endsWith('/varanda-node.js')) throw new Error('QuotaExceededError')
      return put(k, res)
    }
    return cache
  }
  await t.exception(lifecycle(w, 'install'), /QuotaExceededError/, 'the install fails')
  t.absent(w.caches.stores.has('varanda-shell-' + version), 'no partial cache is left behind')
})

test('navigation: a redirect (opaque redirect) is passed on, not replaced by the cached shell', async (t) => {
  const { w } = await installed()
  const redirect = { ok: false, status: 0, type: 'opaqueredirect', headers: new Headers() }
  w.server = () => redirect
  const out = await dispatch(w, ORIGIN + '/antigo', { mode: 'navigate' })
  t.is(out.res, redirect, 'the redirect unchanged')
})

// The Cache API is writable by any same-origin script: an entry planted in the
// release cache is never served, it is deleted and treated as a miss.
const poison = (w, pathname, body, type = 'text/javascript') =>
  w.cache.put(ORIGIN + pathname, new Response(body, { headers: { 'content-type': type } }))

test('a poisoned hashed bundle in the cache is not served: network online, 503 offline', async (t) => {
  const { w } = await installed()
  await poison(w, BUNDLE, 'steal()')
  const on = await dispatch(w, ORIGIN + BUNDLE)
  t.is(await on.res.text(), 'console.log("varanda")\n', 'the real bundle from the network')
  t.is(w.calls.length, 1, 'fetched')
  t.absent(w.cache.map.has(ORIGIN + BUNDLE), 'the poisoned entry is deleted and the network copy not stored')

  await poison(w, BUNDLE, 'steal()')
  w.server = offline
  const off = await dispatch(w, ORIGIN + BUNDLE)
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão', 'not the poisoned body')
  t.absent(w.cache.map.has(ORIGIN + BUNDLE), 'deleted')
})

test('a poisoned index.html is not the offline navigation fallback', async (t) => {
  const { w, version } = await installed()
  const real = await w.cache.match(ORIGIN + '/index.html')
  // Carries the release meta, but not the release's bytes.
  await poison(w, '/index.html', '<meta name="varanda-release" content="' + version + '"><script src="/evil.js"></script>', 'text/html')
  w.server = offline
  const off = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + '/index.html'), 'deleted')

  w.server = status(404, 'nada')
  await poison(w, '/index.html', 'evil', 'text/html')
  const gone = await dispatch(w, ORIGIN + '/perfil', { mode: 'navigate' })
  t.is(gone.res.status, 404, 'the network answer stands')

  await w.cache.put(ORIGIN + '/index.html', real)
  w.server = offline
  const ok = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.ok((await ok.res.text()).includes('<meta name="varanda-release" content="' + version + '">'), 'the correct copy still answers')
})

test('a poisoned /varanda-node.js is not the fallback', async (t) => {
  const { w } = await installed()
  await poison(w, '/varanda-node.js', 'module.exports = "evil"\n')
  w.server = offline
  const off = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + '/varanda-node.js'), 'deleted')

  await poison(w, '/varanda-node.js', 'module.exports = "evil"\n')
  w.server = status(404, 'nada')
  const gone = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(gone.res.status, 404, 'the network answer stands')
  t.is(await gone.res.text(), 'nada')
})

test('an entry outside the precache list is never served and is deleted', async (t) => {
  const { w, dist } = await installed()
  const evil = '/_expo/static/js/web/evil.js'
  await poison(w, evil, 'steal()')
  w.server = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  const res = (await dispatch(w, ORIGIN + evil)).res
  t.is(res.status, 503)
  t.is(await res.text(), 'tipo inesperado', 'the network answer, not the planted body')
  t.absent(w.cache.map.has(ORIGIN + evil), 'deleted')

  await poison(w, evil, 'steal()')
  w.server = offline
  const off = (await dispatch(w, ORIGIN + evil)).res
  t.is(await off.text(), 'sem conexão')
  onlyPrecache(t, w, dist, 'only precache keys remain')
})

// The status and headers of a cache entry are attacker-writable too: the
// legitimate bytes are re-stored with a planted status or header.
async function replant (w, pathname, init) {
  const body = await (await w.cache.match(ORIGIN + pathname)).arrayBuffer()
  await w.cache.put(ORIGIN + pathname, new Response(body, init))
}

test('a cached index.html with the right bytes but status 302 is not used', async (t) => {
  const { w } = await installed()
  await replant(w, '/index.html', { status: 302, headers: { 'content-type': 'text/html', location: 'https://evil.test/' } })
  w.server = offline
  const off = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(off.res.status, 503)
  t.is(off.res.headers.get('location'), null, 'no planted Location')
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + '/index.html'), 'deleted')
})

test('a planted header on a legitimate entry is dropped, the allowed ones kept', async (t) => {
  const { w, version } = await installed()
  const csp = "default-src 'self'"
  await replant(w, '/index.html', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'clear-site-data': '"*"',
      'set-cookie': 'a=b',
      refresh: '0;url=https://evil.test/',
      link: '<https://evil.test/x.js>; rel=preload'
    }
  })
  w.server = offline
  const { res } = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(res.status, 200)
  t.is(res.statusText, 'OK')
  for (const h of ['clear-site-data', 'set-cookie', 'refresh', 'link', 'location']) {
    t.is(res.headers.get(h), null, 'no ' + h)
  }
  t.is(res.headers.get('content-type'), 'text/html; charset=utf-8', 'content-type kept')
  t.is(res.headers.get('content-security-policy'), csp, 'CSP kept')
  t.is(res.headers.get('x-content-type-options'), 'nosniff')
  t.ok((await res.text()).includes('<meta name="varanda-release" content="' + version + '">'), 'the verified shell')
  t.ok(w.cache.map.has(ORIGIN + '/index.html'), 'the entry itself is valid and kept')
})

test('a legitimate bundle stored as text/html (or with no content-type) is poisoned', async (t) => {
  const { w } = await installed()
  await replant(w, BUNDLE, { status: 200, headers: { 'content-type': 'text/html' } })
  w.server = offline
  const off = await dispatch(w, ORIGIN + BUNDLE)
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + BUNDLE), 'deleted')

  // An ArrayBuffer body gets no default content-type.
  await replant(w, '/varanda-node.js', { status: 200 })
  t.is(w.cache.map.get(ORIGIN + '/varanda-node.js').headers.get('content-type'), null)
  const node = await dispatch(w, ORIGIN + '/varanda-node.js')
  t.is(await node.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + '/varanda-node.js'), 'deleted')
})

test('correct entries are served offline as fresh 200s with their content-type', async (t) => {
  const { w, dist } = await installed()
  w.server = offline
  const expected = {
    [BUNDLE]: 'text/javascript',
    '/varanda-node.js': 'text/javascript',
    '/manifest.webmanifest': 'application/manifest+json',
    '/icon-192.png': 'image/png',
    '/assets/x.ttf': 'font/ttf',
    '/favicon.ico': 'image/x-icon'
  }
  for (const [p, type] of Object.entries(expected)) {
    const { res } = await dispatch(w, ORIGIN + p)
    t.is(res.status, 200, p)
    t.is(res.headers.get('content-type'), type, p + ' content-type')
    t.ok(Buffer.from(await res.arrayBuffer()).equals(fs.readFileSync(path.join(dist, p))), p + ' bytes')
  }
  onlyPrecache(t, w, dist, 'every entry kept')
})

const ACTOR = 'a'.repeat(64)
const RECIPIENT = 'b'.repeat(64)
const REF = RECIPIENT + ':7'
const FALLBACK = 'Você tem um aviso novo na Varanda'

function renderedWorker () {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  return loadWorker(readWorker(dist).code, offline)
}

const pushData = (payload) => ({ json: () => payload })
// Objects built inside the vm context have that realm's prototypes.
const plain = (x) => JSON.parse(JSON.stringify(x))

async function push (w, data) {
  const waits = []
  w.handlers.push({ data, waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
  return w.shown.pop()
}

async function click (w, data) {
  const waits = []
  let closed = false
  w.handlers.notificationclick({
    notification: { data, close: () => { closed = true } },
    waitUntil: (p) => waits.push(p)
  })
  await Promise.all(waits)
  return closed
}

function fakeWindow (url) {
  const win = { url, focused: 0, messages: [] }
  win.focus = async () => { win.focused++ }
  win.postMessage = (m) => { win.messages.push(m) }
  return win
}

const valid = (over = {}) => ({ v: 1, kind: 'reply', body: 'Ana respondeu ao seu post', actor: ACTOR, recipient: RECIPIENT, ref: REF, ...over })

test('the rendered worker registers only its five listeners', (t) => {
  const w = renderedWorker()
  t.alike(Object.keys(w.handlers).sort(), ['activate', 'fetch', 'install', 'message', 'notificationclick', 'push'])
})

test('push: a valid payload shows its body, tag and data', async (t) => {
  const w = renderedWorker()
  const reply = await push(w, pushData(valid()))
  t.is(reply.title, 'Varanda')
  t.is(reply.options.body, 'Ana respondeu ao seu post')
  t.is(reply.options.icon, '/icon-192.png')
  t.is(reply.options.tag, 'varanda-reply-' + REF)
  t.is(reply.options.renotify, false)
  t.alike(plain(reply.options.data), { kind: 'reply', actor: ACTOR, recipient: RECIPIENT, ref: REF })

  const follow = await push(w, pushData(valid({ kind: 'follow', body: 'Ana começou a seguir você', ref: null })))
  t.is(follow.options.body, 'Ana começou a seguir você')
  t.is(follow.options.tag, 'varanda-follow-' + ACTOR)
  t.alike(plain(follow.options.data), { kind: 'follow', actor: ACTOR, recipient: RECIPIENT, ref: null })

  const long = await push(w, pushData(valid({ body: '😀'.repeat(120) })))
  t.is(long.options.body, '😀'.repeat(120), '120 code points are allowed')
})

test('push: missing or invalid data shows only the fallback sentence', async (t) => {
  const w = renderedWorker()
  const extra = valid()
  extra.url = 'https://evil.test/'
  const cases = {
    'data null': null,
    'json throws': { json: () => { throw new SyntaxError('bad') } },
    'not an object': pushData('Ana respondeu'),
    array: pushData([valid()]),
    'extra key': pushData({ ...valid(), x: 1 }),
    'url field': pushData(extra),
    'missing key': pushData((({ ref, ...rest }) => rest)(valid())),
    'wrong version': pushData(valid({ v: 2 })),
    'unknown kind': pushData(valid({ kind: 'mention' })),
    'uppercase actor': pushData(valid({ actor: 'A'.repeat(64) })),
    'actor is recipient': pushData(valid({ actor: RECIPIENT })),
    'follow with ref': pushData(valid({ kind: 'follow' })),
    'reply without ref': pushData(valid({ ref: null })),
    'ref author is not the recipient': pushData(valid({ ref: ACTOR + ':7' })),
    'ref seq 0': pushData(valid({ ref: RECIPIENT + ':0' })),
    'ref seq too long': pushData(valid({ ref: RECIPIENT + ':1' + '0'.repeat(15) })),
    'empty body': pushData(valid({ body: '' })),
    '121 code points': pushData(valid({ body: '😀'.repeat(121) })),
    'body not a string': pushData(valid({ body: 7 })),
    'control char': pushData(valid({ body: 'Ana\nrespondeu' })),
    'C1 control': pushData(valid({ body: 'Ana\u0085respondeu' })),
    'line separator': pushData(valid({ body: 'Ana\u2028respondeu' })),
    'bidi override': pushData(valid({ body: 'Ana \u202erespondeu' })),
    'bidi isolate': pushData(valid({ body: 'Ana \u2067respondeu' })),
    'left-to-right mark': pushData(valid({ body: 'Ana \u200erespondeu' })),
    'right-to-left mark': pushData(valid({ body: 'Ana \u200frespondeu' })),
    'arabic letter mark': pushData(valid({ body: 'Ana \u061crespondeu' })),
    'lone surrogate': pushData(valid({ body: 'Ana \ud800respondeu' }))
  }
  for (const [label, data] of Object.entries(cases)) {
    const shown = await push(w, data)
    t.is(shown.title, 'Varanda', label)
    t.is(shown.options.body, FALLBACK, label)
    t.is(shown.options.tag, 'varanda-generic', label)
    t.alike(plain(shown.options.data), {}, label)
  }
})

test('push: a failing showNotification never throws', async (t) => {
  const w = renderedWorker()
  w.shown = { push: () => { throw new Error('quota') } }
  const waits = []
  t.execution(() => w.handlers.push({ data: pushData(valid()), waitUntil: (p) => waits.push(p) }))
  await t.execution(Promise.all(waits))
  t.execution(() => w.handlers.push(null))
})

test('notificationclick: focuses an open same-origin window and posts the target', async (t) => {
  const w = renderedWorker()
  const other = fakeWindow('https://other.test/')
  const mine = fakeWindow(ORIGIN + '/')
  w.windows = [other, mine]
  t.ok(await click(w, { kind: 'reply', actor: ACTOR, recipient: RECIPIENT, ref: REF }), 'closed')
  t.alike(plain(w.matchAllOpts), { type: 'window', includeUncontrolled: true })
  t.is(other.focused, 0)
  t.is(mine.focused, 1)
  t.alike(plain(mine.messages), [{ source: 'varanda-push', kind: 'reply', actor: ACTOR, recipient: RECIPIENT, ref: REF }])
  t.alike(w.opened, [])

  // Invalid data still focuses, but posts nothing.
  t.ok(await click(w, { kind: 'reply', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR + ':1' }))
  t.is(mine.focused, 2)
  t.is(mine.messages.length, 1)
  t.alike(w.opened, [])
})

test('notificationclick: a window that refuses focus falls back to a new window', async (t) => {
  const w = renderedWorker()
  const mine = fakeWindow(ORIGIN + '/')
  mine.focus = async () => { throw new Error('InvalidAccessError') }
  w.windows = [mine]
  t.ok(await click(w, { kind: 'reply', actor: ACTOR, recipient: RECIPIENT, ref: REF }), 'closed')
  t.alike(w.opened, ['/?aviso=reply&actor=' + ACTOR + '&recipient=' + RECIPIENT + '&ref=' + REF])
  t.is(mine.messages.length, 0)
})

test('notificationclick: the moderation panel and other bypassed pages are never the app window', async (t) => {
  const w = renderedWorker()
  const panel = fakeWindow(ORIGIN + '/account/mod/')
  const media = fakeWindow(ORIGIN + '/media/x')
  const app = fakeWindow(ORIGIN + '/?conta=1')
  w.windows = [panel, media, app]
  await click(w, { kind: 'like', actor: ACTOR, recipient: RECIPIENT, ref: REF })
  t.is(panel.focused, 0)
  t.is(panel.messages.length, 0)
  t.is(media.focused, 0)
  t.is(app.focused, 1)
  t.is(app.messages.length, 1)

  w.windows = [panel]
  await click(w, { kind: 'like', actor: ACTOR, recipient: RECIPIENT, ref: REF })
  t.is(panel.focused, 0, 'only the panel open: a new app window instead')
  t.alike(w.opened, ['/?aviso=like&actor=' + ACTOR + '&recipient=' + RECIPIENT + '&ref=' + REF])
})

test('notificationclick: no window opens the validated query path', async (t) => {
  const w = renderedWorker()
  w.windows = [fakeWindow('https://other.test/')]
  await click(w, { kind: 'like', actor: ACTOR, recipient: RECIPIENT, ref: REF })
  await click(w, { kind: 'follow', actor: ACTOR, recipient: RECIPIENT, ref: null })
  t.alike(w.opened, [
    '/?aviso=like&actor=' + ACTOR + '&recipient=' + RECIPIENT + '&ref=' + REF,
    '/?aviso=follow&actor=' + ACTOR + '&recipient=' + RECIPIENT
  ])
})

test('notificationclick: invalid data opens the root, never a profile link', async (t) => {
  const w = renderedWorker()
  const cases = [
    {},
    null,
    undefined,
    'x',
    { kind: 'reply', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR + ':1' },
    { kind: 'like', actor: '/@ana', recipient: RECIPIENT, ref: REF },
    { kind: 'like', actor: ACTOR, recipient: '/m/' + ACTOR, ref: REF },
    { kind: 'repost', actor: ACTOR, recipient: RECIPIENT, ref: null }
  ]
  for (const data of cases) await click(w, data)
  t.alike(w.opened, cases.map(() => '/'))
  for (const u of w.opened) t.absent(/\/m\/|\/@/.test(u), u)
})

test('notificationclick: a failing clients API never throws', async (t) => {
  const w = renderedWorker()
  w.windows = null
  await t.execution(click(w, { kind: 'like', actor: ACTOR, recipient: RECIPIENT, ref: REF }))
})

test('message: the push ping is answered on its port, anything else ignored', (t) => {
  const w = renderedWorker()
  const port = () => {
    const p = { sent: [] }
    p.postMessage = (m) => { p.sent.push(m) }
    return p
  }
  const ping = port()
  w.handlers.message({ data: { type: 'varanda-push-ping' }, ports: [ping] })
  t.alike(plain(ping.sent), [{ source: 'varanda-sw', push: 1 }])

  for (const data of [null, 'varanda-push-ping', { type: 'other' }, { type: 'varanda-push-ping', x: 1 }, ['varanda-push-ping']]) {
    const p = port()
    w.handlers.message({ data, ports: [p] })
    t.alike(p.sent, [], JSON.stringify(data))
  }
  t.execution(() => w.handlers.message({ data: { type: 'varanda-push-ping' }, ports: [] }))
  t.execution(() => w.handlers.message({ data: { type: 'varanda-push-ping' } }))
  t.execution(() => w.handlers.message({}))
  t.execution(() => w.handlers.message(null))
})
