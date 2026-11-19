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
const { finishWeb, releaseNodePath } = require('../scripts/finish-web')

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
    'assets/m.mjs': 'export default 1\n',
    'assets/d.json': '{"a":1}',
    'assets/s.css': 'body{}\n',
    'assets/m.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    'assets/a.jpg': Buffer.from([0xff, 0xd8, 0xff]),
    'assets/b.jpeg': Buffer.from([0xff, 0xd8, 0xff, 1]),
    'assets/c.gif': 'GIF89a',
    'assets/w.webp': 'RIFF',
    'assets/v.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/f2.woff2': Buffer.from([1, 2]),
    'assets/f1.woff': Buffer.from([1, 3]),
    'assets/f.otf': Buffer.from([1, 4]),
    'assets/t.txt': 'texto\n',
    'assets/blob.dat': Buffer.from([7, 7]),
    'metadata.json': '{"fileMetadata":{}}'
  }
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

// The node copy a page of `version` loads (src/client/browser.js nodeScriptUrl).
const nodeOf = (version) => '/varanda-node-' + version + '.js'

function readWorker (dist) {
  const code = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')
  return {
    code,
    version: JSON.parse(code.match(/^const VERSION = (.*)$/m)[1]),
    precache: JSON.parse(code.match(/^const PRECACHE = (.*)$/m)[1])
  }
}

// The (cabecalhos_seguranca) header snippet of deploy/seeder/Caddyfile, with
// the domain Caddy fills in: the worker must accept the headers the real
// server sends, or no release would ever install, and it serves the offline
// shell with its own copy of them. Lines are trimmed (CRLF, trailing spaces),
// as in apps/cli/test/caddyfile.test.js.
function caddyHeaders () {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'deploy', 'seeder', 'Caddyfile'), 'utf8')
    .split('\n').map((l) => l.trim())
  const start = lines.indexOf('(cabecalhos_seguranca) {')
  if (start < 0 || lines[start + 1] !== 'header {') throw new Error('header snippet not found in deploy/seeder/Caddyfile')
  const headers = new Map()
  for (const line of lines.slice(start + 2)) {
    if (line === '}') break
    const m = line.match(/^([A-Za-z-]+) "(.*)"$/)
    if (m) headers.set(m[1].toLowerCase(), m[2].replaceAll('{$VARANDA_DOMAIN}', 'example.test'))
  }
  return headers
}
const CADDY_HEADERS = caddyHeaders()
const CADDY_CSP = CADDY_HEADERS.get('content-security-policy')
const SECURITY = { 'content-security-policy': CADDY_CSP, 'x-content-type-options': 'nosniff' }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf', '.txt': 'text/plain' }

// A static server over dist with an SPA fallback: a missing file is answered
// with index.html, 200 text/html (what a hosting without real 404s does).
// Every answer carries Caddy's security headers, as in production.
function serveDist (dist) {
  return (pathname) => {
    const file = path.join(dist, pathname)
    if (pathname !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', ...SECURITY } })
    }
    return new Response(fs.readFileSync(path.join(dist, 'index.html')), { status: 200, headers: { 'content-type': TYPES['.html'], ...SECURITY } })
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
    // Like Cache Storage, keys() answers Request-like objects, not strings.
    async keys () { return [...this.map.keys()].map((url) => ({ url })) }
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
// may throw to simulate being offline. Passing `caches` simulates a worker
// restart over the same storage; setting `w.now` fixes the worker's clock.
function loadWorker (code, server, opts = {}) {
  const handlers = {}
  const caches = opts.caches || fakeCaches()
  const calls = []
  const w = { handlers, caches, calls, server, shown: [], closed: new Set(), windows: [], opened: [], now: null, postDelayMs: 0 }
  const timers = opts.timers || { setTimeout, clearTimeout }
  class WorkerDate extends Date {
    static now () { return w.now === null ? Date.now() : w.now }
  }
  const fetch = async (request) => {
    calls.push(request.url)
    return w.server(new URL(request.url).pathname, request)
  }
  const self = {
    location: { origin: ORIGIN, host: 'example.test' },
    navigator: opts.navigator,
    addEventListener: (type, fn) => { handlers[type] = fn },
    registration: {
      showNotification: async (title, options) => {
        const record = { title, options, posted: w.postDelayMs === 0 }
        w.shown.push(record)
        if (w.postDelayMs > 0) timers.setTimeout(() => { record.posted = true }, w.postDelayMs)
      },
      getNotifications: async (filter) => w.shown
        .filter((n) => !w.closed.has(n) && !n.dropped && (!filter || !filter.tag || n.options.tag === filter.tag))
        .map((n) => ({ close: () => { if (n.posted) w.closed.add(n); else n.dropped = true } }))
    }
  }
  const clients = {
    matchAll: async (opts) => {
      w.matchAllOpts = opts
      return w.windows
    },
    openWindow: async (url) => { w.opened.push(url) }
  }
  vm.runInNewContext(code, { self, caches, clients, fetch, Request, Response, Headers, URL, TextDecoder, crypto: globalThis.crypto, Date: WorkerDate, MessageChannel, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
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
  for (const u of ['/index.html', BUNDLE, nodeOf(version), '/manifest.webmanifest', '/icon-192.png', '/assets/x.ttf', '/favicon.ico']) {
    t.ok(urls.includes(u), 'precaches ' + u)
  }
  for (const u of ['/metadata.json', '/sw.js', '/_expo/static/js/web/index.js.map', '/varanda-node.js']) {
    t.absent(urls.includes(u), 'does not precache ' + u)
  }
  t.is(releaseNodePath(version), nodeOf(version))
  t.ok(fs.readFileSync(path.join(dist, nodeOf(version))).equals(fs.readFileSync(path.join(dist, 'varanda-node.js'))), 'the release copy has the node bytes')
  t.ok(fs.existsSync(path.join(dist, 'varanda-node.js')), 'the plain name stays for the deploy probe')
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

  t.alike(fs.readdirSync(dist).filter((n) => n.startsWith('varanda-node-')), [nodeOf(v1).slice(1)], 'one release copy')

  fs.appendFileSync(path.join(dist, BUNDLE), ';')
  quiet(() => finishWeb(dist))
  const v2 = readWorker(dist).version
  t.not(v2, v1, 'bundle byte changes the version')
  t.alike(fs.readdirSync(dist).filter((n) => n.startsWith('varanda-node-')), [nodeOf(v2).slice(1)], 'the old release copy is replaced')

  fs.appendFileSync(path.join(dist, 'varanda-node.js'), ';')
  quiet(() => finishWeb(dist))
  t.not(readWorker(dist).version, v2, 'node byte changes the version')

  const tpl = path.join(ROOT, 'sw-template-' + count++ + '.js')
  fs.writeFileSync(tpl, fs.readFileSync(TEMPLATE, 'utf8') + '\n')
  quiet(() => finishWeb(dist, tpl))
  t.not(readWorker(dist).version, v2, 'template byte changes the version')
})

test('a version.json in dist is not precached and does not change the release id', (t) => {
  const plain = makeDist()
  quiet(() => finishWeb(plain))
  const dist = makeDist()
  fs.writeFileSync(path.join(dist, 'version.json'), '{"commit":"0123456789abcdef"}\n')
  quiet(() => finishWeb(dist))
  const sw1 = fs.readFileSync(path.join(dist, 'sw.js'))
  const { version, precache } = readWorker(dist)
  t.absent(precache.some((e) => e.url === '/version.json'), 'not precached')
  t.is(version, readWorker(plain).version, 'same release id as without the file')
  quiet(() => finishWeb(dist))
  t.ok(sw1.equals(fs.readFileSync(path.join(dist, 'sw.js'))), 'second run byte-identical')
})

test('the messenger preview images under /og/ are not precached', (t) => {
  const plain = makeDist()
  quiet(() => finishWeb(plain))
  const dist = makeDist()
  fs.mkdirSync(path.join(dist, 'og'))
  fs.writeFileSync(path.join(dist, 'og', 'convite.png'), 'png')
  quiet(() => finishWeb(dist))
  const { version, precache } = readWorker(dist)
  t.absent(precache.some((e) => e.url.startsWith('/og/')), 'not precached')
  t.is(version, readWorker(plain).version, 'same release id as without them')
})

test('finishWeb refuses an incomplete export', (t) => {
  for (const missing of ['index.html', 'varanda-node.js', 'manifest.webmanifest', BUNDLE.slice(1)]) {
    const dist = makeDist()
    fs.rmSync(path.join(dist, missing))
    t.exception(() => quiet(() => finishWeb(dist)), /falta|nenhum/, 'without ' + missing)
  }
  const dist = makeDist()
  fs.rmSync(path.join(dist, 'varanda-node.js'))
  fs.mkdirSync(path.join(dist, 'varanda-node.js'))
  t.exception(() => quiet(() => finishWeb(dist)), /varanda-node\.js não é um arquivo comum/, 'a directory named varanda-node.js')
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
  const { code, version } = readWorker(dist)
  const real = serveDist(dist)

  const html = loadWorker(code, (p, r) => p === BUNDLE ? real('/nope') : real(p, r))
  await t.exception(lifecycle(html, 'install'), /text\/html/, 'bundle answered as text/html')

  const changed = loadWorker(code, (p, r) => p === nodeOf(version)
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

const NEW_NODE = 'module.exports = "new"\n'
const jsBody = (body) => () => new Response(body, { headers: { 'content-type': 'text/javascript' } })

// #478 deploy window: while a deploy replaces the files, a navigation gets a
// 5xx and the worker answers with this release's cached shell, but the server
// already has the next release's node. The shell must still run its own node.
test('the cached shell runs the node of its own release while the server has another', async (t) => {
  const { w, dist, version } = await installed()
  w.server = (p) => p.startsWith('/varanda-node') ? jsBody(NEW_NODE)() : status(503)()
  const nav = await dispatch(w, ORIGIN + '/perfil', { mode: 'navigate' })
  const shell = await nav.res.text()
  const release = shell.match(/<meta name="varanda-release" content="([0-9a-f]{16})">/)[1]
  t.is(release, version, 'the cached shell of this release')
  w.calls.length = 0
  const node = await dispatch(w, ORIGIN + nodeOf(release))
  t.is(await node.res.text(), 'module.exports = "node"\n', 'its own node, not the new one')
  t.is(w.calls.length, 0, 'answered from the verified precache')

  w.server = offline
  const off = await dispatch(w, ORIGIN + nodeOf(release))
  t.is(await off.res.text(), 'module.exports = "node"\n', 'offline too')
  onlyPrecache(t, w, dist, 'nothing stored')
})

// The reverse: a page of the next release (network-first navigation) whose
// node fetch fails while this release's worker controls it must not get this
// release's node, under its own name or the plain one.
test('a page of another release never gets this release\'s node', async (t) => {
  const { w, dist, version } = await installed()
  const other = version === 'fedcba9876543210' ? '0123456789abcdef' : 'fedcba9876543210'
  for (const p of [nodeOf(other), '/varanda-node.js']) {
    w.server = jsBody(NEW_NODE)
    const on = await dispatch(w, ORIGIN + p)
    t.is(await on.res.text(), NEW_NODE, p + ': the network copy online')

    w.server = status(404, 'nada')
    const gone = await dispatch(w, ORIGIN + p)
    t.is(gone.res.status, 404, p + ': a 404 is passed on')
    t.is(await gone.res.text(), 'nada')

    w.server = offline
    const off = await dispatch(w, ORIGIN + p)
    t.is(off.res.status, 503, p + ': offline')
    t.is(await off.res.text(), 'sem conexão')

    w.server = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    const html = await dispatch(w, ORIGIN + p)
    t.is(html.res.status, 503, p + ': HTML refused')
    t.is(await html.res.text(), 'tipo inesperado')
  }
  onlyPrecache(t, w, dist, 'nothing stored')
})

test('bypassed requests are never intercepted', async (t) => {
  const { w } = await installed()
  for (const url of [ORIGIN + '/varanda.json', ORIGIN + '/sw.js', ORIGIN + '/seeder', ORIGIN + '/seeder/x',
    ORIGIN + '/version.json', ORIGIN + '/version.json?x=1', 'https://other.test' + BUNDLE]) {
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

// Chat media chunks are proxied by Caddy to the seeder's blob pool: the
// worker must not cache them, answer them with the shell or turn a failure
// into a 503.
test('/blob/* is never intercepted', async (t) => {
  const { w } = await installed()
  w.server = offline
  for (const p of ['/blob/' + 'a'.repeat(64) + '/0', '/blob/' + 'b'.repeat(64) + '/256', '/blob/x']) {
    t.absent((await dispatch(w, ORIGIN + p)).responded, p)
    t.absent((await dispatch(w, ORIGIN + p, { method: 'HEAD' })).responded, 'HEAD ' + p)
    t.absent((await dispatch(w, ORIGIN + p, { mode: 'navigate' })).responded, 'navigate ' + p)
  }
  t.is(w.calls.length, 0, 'the worker fetched nothing')
  t.ok((await dispatch(w, ORIGIN + '/blobs', { mode: 'navigate' })).responded, '/blobs is an app route')
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

// The Feira's public pages come from the seeder (no-store, real 404s): never
// intercepted. /anuncio/... is an app route and keeps the shell.
test('/f/* is never intercepted, /anuncio/* keeps the shell', async (t) => {
  const { w } = await installed()
  w.server = offline
  const A = 'a'.repeat(64)
  for (const p of ['/f/' + A + '/7', '/f/' + A + '/7/foto/1', '/f/sitemap.xml', '/f']) {
    t.absent((await dispatch(w, ORIGIN + p)).responded, p)
    t.absent((await dispatch(w, ORIGIN + p, { method: 'HEAD' })).responded, 'HEAD ' + p)
    t.absent((await dispatch(w, ORIGIN + p, { mode: 'navigate' })).responded, 'navigate ' + p)
  }
  t.is(w.calls.length, 0, 'the worker fetched nothing')
  t.ok((await dispatch(w, ORIGIN + '/anuncio/' + A + '/7', { mode: 'navigate' })).responded, '/anuncio/<hex>/<seq> keeps the shell')
  t.ok((await dispatch(w, ORIGIN + '/fa', { mode: 'navigate' })).responded, '/fa is an app route')
})

// Public post pages come from the seeder; /publicacao/... is the app route.
test('/p/* is never intercepted, /publicacao/* keeps the shell', async (t) => {
  const { w } = await installed()
  w.server = offline
  const A = 'a'.repeat(64)
  for (const p of ['/p/' + A + '/1', '/p/' + A + '/1/foto/1', '/p/policy', '/p']) {
    t.absent((await dispatch(w, ORIGIN + p)).responded, p)
    t.absent((await dispatch(w, ORIGIN + p, { method: 'HEAD' })).responded, 'HEAD ' + p)
    t.absent((await dispatch(w, ORIGIN + p, { mode: 'navigate' })).responded, 'navigate ' + p)
  }
  t.is(w.calls.length, 0, 'the worker fetched nothing')
  t.ok((await dispatch(w, ORIGIN + '/publicacao/' + A + '/1', { mode: 'navigate' })).responded, '/publicacao/<hex>/<seq> keeps the shell')
  t.ok((await dispatch(w, ORIGIN + '/pa', { mode: 'navigate' })).responded, '/pa is an app route')
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
  for (const p of [nodeOf(readWorker(dist).version), '/varanda-node.js']) {
    const node = await dispatch(w, ORIGIN + p)
    t.is(await node.res.text(), 'sem conexão', p)
  }
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
      if ((typeof k === 'string' ? k : k.url).endsWith(nodeOf(version))) throw new Error('QuotaExceededError')
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
// An index.html is planted with valid security headers, so that only the
// check under test can refuse it.
const poison = (w, pathname, body, type = 'text/javascript', extra = {}) =>
  w.cache.put(ORIGIN + pathname, new Response(body, { headers: { 'content-type': type, ...extra } }))

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
  await poison(w, '/index.html', '<meta name="varanda-release" content="' + version + '"><script src="/evil.js"></script>', 'text/html', SECURITY)
  w.server = offline
  const off = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + '/index.html'), 'deleted')

  w.server = status(404, 'nada')
  await poison(w, '/index.html', 'evil', 'text/html', SECURITY)
  const gone = await dispatch(w, ORIGIN + '/perfil', { mode: 'navigate' })
  t.is(gone.res.status, 404, 'the network answer stands')

  await w.cache.put(ORIGIN + '/index.html', real)
  w.server = offline
  const ok = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.ok((await ok.res.text()).includes('<meta name="varanda-release" content="' + version + '">'), 'the correct copy still answers')
})

test('a poisoned release node copy is never served', async (t) => {
  const { w, version } = await installed()
  const node = nodeOf(version)
  await poison(w, node, 'module.exports = "evil"\n')
  w.server = offline
  const off = await dispatch(w, ORIGIN + node)
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + node), 'deleted')

  await poison(w, node, 'module.exports = "evil"\n')
  w.server = status(404, 'nada')
  const gone = await dispatch(w, ORIGIN + node)
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
  await replant(w, '/index.html', { status: 302, headers: { 'content-type': 'text/html', location: 'https://evil.test/', ...SECURITY } })
  w.server = offline
  const off = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(off.res.status, 503)
  t.is(off.res.headers.get('location'), null, 'no planted Location')
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + '/index.html'), 'deleted')
})

test('a planted header on a legitimate index.html is dropped, the shell gets the worker headers', async (t) => {
  const { w, version } = await installed()
  const csp = CADDY_CSP
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

test('planted headers on a cached bundle are dropped, the worker sets the type', async (t) => {
  const { w } = await installed()
  await replant(w, BUNDLE, {
    status: 200,
    headers: {
      'content-type': 'text/javascript',
      location: 'https://evil.test/',
      refresh: '0;url=https://evil.test/',
      link: '<https://evil.test/x.js>; rel=preload',
      'clear-site-data': '"*"'
    }
  })
  w.server = offline
  const { res } = await dispatch(w, ORIGIN + BUNDLE)
  t.is(res.status, 200)
  for (const h of ['location', 'refresh', 'link', 'clear-site-data']) {
    t.is(res.headers.get(h), null, 'no ' + h)
  }
  t.is(res.headers.get('content-type'), 'text/javascript; charset=utf-8', 'constant content-type')
  t.is(res.headers.get('x-content-type-options'), 'nosniff')
  t.alike([...res.headers.keys()].sort(), ['content-type', 'x-content-type-options'], 'no other header')
  t.is(await res.text(), 'console.log("varanda")\n')
})

// A replanted bundle whose headers would make the browser refuse it (a type
// that is not a script type plus nosniff, or another charset) is served with
// the worker's constants, never with the planted ones.
test('a replanted bundle with a planted type or charset is served with the constant type and nosniff', async (t) => {
  for (const [label, type] of [['a type with a suffix', 'text/javascriptx'], ['another charset', 'text/javascript; charset=utf-16le'], ['application/javascript', 'application/javascript; charset=utf-16le']]) {
    for (const name of [BUNDLE, 'node']) {
      const { w, version } = await installed()
      const p = name === 'node' ? nodeOf(version) : name
      w.server = offline
      await replant(w, p, { status: 200, headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
      const { res } = await dispatch(w, ORIGIN + p)
      if (type === 'text/javascriptx') {
        t.is(res.status, 503, label + ' ' + p + ': a type outside the family is poisoned')
        t.absent(w.cache.map.has(ORIGIN + p), label + ' ' + p + ': deleted')
      } else {
        t.is(res.status, 200, label + ' ' + p)
        t.is(res.headers.get('content-type'), 'text/javascript; charset=utf-8', label + ' ' + p + ' constant type')
        t.is(res.headers.get('x-content-type-options'), 'nosniff')
        t.is(res.headers.get('cache-control'), null, 'no copied header')
      }
    }
  }
})

test('a type that is not its extension family, or an extension with no known type, is never served from the cache', async (t) => {
  const cases = [
    ['/icon-192.png', 'image/svg+xml'],
    ['/icon-192.png', 'image/png+xml'],
    ['/assets/d.json', 'application/jsonx'],
    ['/assets/m.wasm', 'application/octet-stream'],
    ['/assets/s.css', 'text/html'],
    ['/assets/blob.dat', 'application/octet-stream'],
    ['/assets/blob.dat', 'text/javascript']
  ]
  for (const [p, type] of cases) {
    const { w } = await installed()
    w.server = offline
    await replant(w, p, { status: 200, headers: { 'content-type': type, 'x-content-type-options': 'nosniff' } })
    const { res } = await dispatch(w, ORIGIN + p)
    t.is(res.status, 503, p + ' as ' + type)
    t.absent(w.cache.map.has(ORIGIN + p), p + ' as ' + type + ': deleted')
  }
  // Online, the network answers instead.
  const { w } = await installed()
  await replant(w, '/assets/blob.dat', { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  w.server = () => new Response('rede', { headers: { 'content-type': 'application/octet-stream' } })
  const online = await dispatch(w, ORIGIN + '/assets/blob.dat')
  t.is(await online.res.text(), 'rede')
})

// An index.html whose headers lost a protection is refused at install and
// dropped at serve, even with the release's exact bytes (the shell is served
// with the worker's own headers either way).
const WEAK_HEADERS = {
  'weak CSP': { 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff' },
  'missing CSP': { 'x-content-type-options': 'nosniff' },
  'missing nosniff': { 'content-security-policy': CADDY_CSP },
  'inline scripts allowed': { 'content-security-policy': CADDY_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), 'x-content-type-options': 'nosniff' },
  'framing allowed': { 'content-security-policy': CADDY_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'"), 'x-content-type-options': 'nosniff' },
  'a second policy': { 'content-security-policy': CADDY_CSP + ", script-src 'self'", 'x-content-type-options': 'nosniff' },
  'plugins allowed': { 'content-security-policy': CADDY_CSP.replace("object-src 'none'", "object-src 'self'"), 'x-content-type-options': 'nosniff' },
  'base element allowed': { 'content-security-policy': CADDY_CSP.replace("base-uri 'none'", "base-uri 'self'"), 'x-content-type-options': 'nosniff' },
  'inline script elements via script-src-elem': { 'content-security-policy': CADDY_CSP + "; script-src-elem 'self' 'unsafe-inline'", 'x-content-type-options': 'nosniff' },
  'inline handlers via script-src-attr': { 'content-security-policy': CADDY_CSP + "; script-src-attr 'unsafe-inline'", 'x-content-type-options': 'nosniff' },
  'a vertical tab in script-src': { 'content-security-policy': CADDY_CSP.replace("script-src 'self'", "script-src\x0b'self'"), 'x-content-type-options': 'nosniff' },
  'a non-breaking space in frame-ancestors': { 'content-security-policy': CADDY_CSP.replace("frame-ancestors 'none'", "frame-ancestors\u00a0'none'"), 'x-content-type-options': 'nosniff' }
}

test('the CSP of the Caddyfile is the one the test server sends', (t) => {
  t.ok(CADDY_CSP.includes("frame-ancestors 'none'") && CADDY_CSP.includes('wss://example.test'), 'read from deploy/seeder/Caddyfile, domain filled in')
})

// The worker's own constants (SHELL_HEADERS in scripts/sw.js), pinned to the
// header snippet of the Caddyfile: every header of the snippet but HSTS, and
// nothing else besides the content-type.
test('the offline shell carries the security headers of the Caddyfile', async (t) => {
  const { w } = await installed()
  w.server = offline
  const { res } = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(res.status, 200)
  const expected = new Map(CADDY_HEADERS)
  t.ok(expected.delete('strict-transport-security'), 'HSTS read from the snippet')
  t.alike([...expected.keys()].sort(), ['content-security-policy', 'permissions-policy', 'referrer-policy', 'x-content-type-options', 'x-frame-options'], 'the snippet read in full')
  for (const [name, value] of expected) t.is(res.headers.get(name), value, name + ' as in the Caddyfile')
  t.is(res.headers.get('content-type'), 'text/html; charset=utf-8')
  t.alike([...res.headers.keys()].sort(), ['content-type', ...expected.keys()].sort(), 'no other header, no HSTS')
})

test('the offline shell never takes the headers of its cache entry', async (t) => {
  const { w, version } = await installed()
  // Passes headersOk, but loosens everything the check does not cover.
  const loose = CADDY_CSP.replace("connect-src 'self' wss://example.test", 'connect-src *').replace("img-src 'self' data: blob:", 'img-src *')
  await replant(w, '/index.html', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-7',
      'content-security-policy': loose,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'unsafe-url',
      'x-frame-options': 'ALLOWALL',
      'permissions-policy': 'camera=*, microphone=*',
      'cache-control': 'max-age=31536000'
    }
  })
  w.server = offline
  const { res } = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
  t.is(res.status, 200, 'served: the entry passes the check')
  t.ok((await res.text()).includes('<meta name="varanda-release" content="' + version + '">'), 'the verified shell')
  t.is(res.headers.get('content-security-policy'), CADDY_CSP, "the worker's CSP")
  t.is(res.headers.get('content-type'), 'text/html; charset=utf-8')
  t.is(res.headers.get('referrer-policy'), CADDY_HEADERS.get('referrer-policy'))
  t.is(res.headers.get('x-frame-options'), CADDY_HEADERS.get('x-frame-options'))
  t.is(res.headers.get('permissions-policy'), CADDY_HEADERS.get('permissions-policy'))
  t.is(res.headers.get('cache-control'), null, 'no cache-control from the entry')
  t.ok(w.cache.map.has(ORIGIN + '/index.html'), 'the entry is kept')
})

test('install refuses an index.html with a missing or weak CSP or nosniff', async (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const { code } = readWorker(dist)
  const real = serveDist(dist)
  const bytes = fs.readFileSync(path.join(dist, 'index.html'))
  for (const [label, headers] of Object.entries(WEAK_HEADERS)) {
    const w = loadWorker(code, (p, r) => p === '/index.html'
      ? new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
      : real(p, r))
    await t.exception(lifecycle(w, 'install'), /CSP or nosniff/, label + ': install fails')
    const stored = [...w.caches.stores.values()].reduce((n, c) => n + c.map.size, 0)
    t.is(stored, 0, label + ': nothing stored')
  }
})

test('a cached index.html with a missing or weak CSP or nosniff is a miss and is deleted', async (t) => {
  for (const [label, headers] of Object.entries(WEAK_HEADERS)) {
    const { w } = await installed()
    const bytes = await (await w.cache.match(ORIGIN + '/index.html')).arrayBuffer()
    const plant = () => w.cache.put(ORIGIN + '/index.html', new Response(bytes, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } }))
    await plant()
    w.server = offline
    const off = await dispatch(w, ORIGIN + '/', { mode: 'navigate' })
    t.is(off.res.status, 503, label + ': not served offline')
    t.is(await off.res.text(), 'sem conexão', label)
    t.absent(w.cache.map.has(ORIGIN + '/index.html'), label + ': deleted')

    await plant()
    w.server = status(404, 'nada')
    const gone = await dispatch(w, ORIGIN + '/perfil', { mode: 'navigate' })
    t.is(gone.res.status, 404, label + ': the network answer stands')
  }
})

test('a legitimate bundle stored as text/html (or with no content-type) is poisoned', async (t) => {
  const { w, version } = await installed()
  await replant(w, BUNDLE, { status: 200, headers: { 'content-type': 'text/html' } })
  w.server = offline
  const off = await dispatch(w, ORIGIN + BUNDLE)
  t.is(off.res.status, 503)
  t.is(await off.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + BUNDLE), 'deleted')

  // An ArrayBuffer body gets no default content-type.
  await replant(w, nodeOf(version), { status: 200 })
  t.is(w.cache.map.get(ORIGIN + nodeOf(version)).headers.get('content-type'), null)
  const node = await dispatch(w, ORIGIN + nodeOf(version))
  t.is(await node.res.text(), 'sem conexão')
  t.absent(w.cache.map.has(ORIGIN + nodeOf(version)), 'deleted')
})

test('correct entries are served offline as fresh 200s with their content-type', async (t) => {
  const { w, dist, version } = await installed()
  w.server = offline
  const expected = {
    [BUNDLE]: 'text/javascript; charset=utf-8',
    [nodeOf(version)]: 'text/javascript; charset=utf-8',
    '/assets/m.mjs': 'text/javascript; charset=utf-8',
    '/manifest.webmanifest': 'application/manifest+json',
    '/assets/d.json': 'application/json',
    '/assets/m.wasm': 'application/wasm',
    '/assets/s.css': 'text/css; charset=utf-8',
    '/icon-192.png': 'image/png',
    '/assets/a.jpg': 'image/jpeg',
    '/assets/b.jpeg': 'image/jpeg',
    '/assets/c.gif': 'image/gif',
    '/assets/w.webp': 'image/webp',
    '/assets/v.svg': 'image/svg+xml',
    '/favicon.ico': 'image/x-icon',
    '/assets/x.ttf': 'font/ttf',
    '/assets/f.otf': 'font/otf',
    '/assets/f1.woff': 'font/woff',
    '/assets/f2.woff2': 'font/woff2',
    '/assets/t.txt': 'text/plain; charset=utf-8'
  }
  for (const [p, type] of Object.entries(expected)) {
    const { res } = await dispatch(w, ORIGIN + p)
    t.is(res.status, 200, p)
    t.is(res.headers.get('content-type'), type, p + ' content-type')
    t.is(res.headers.get('x-content-type-options'), 'nosniff', p + ' nosniff')
    t.alike([...res.headers.keys()].sort(), ['content-type', 'x-content-type-options'], p + ' no other header')
    t.ok(Buffer.from(await res.arrayBuffer()).equals(fs.readFileSync(path.join(dist, p))), p + ' bytes')
  }
  // An extension with no known type is never answered from the cache.
  const blob = await dispatch(w, ORIGIN + '/assets/blob.dat')
  t.is(blob.res.status, 503)
  t.absent(w.cache.map.has(ORIGIN + '/assets/blob.dat'), 'blob.dat deleted')
  w.cache.map.delete(ORIGIN + '/assets/blob.dat')
  const names = readWorker(dist).precache.filter((e) => e.url !== '/assets/blob.dat')
  t.alike([...w.cache.map.keys()].sort(), names.map((e) => ORIGIN + e.url).sort(), 'every other entry kept')
})

const ACTOR = 'a'.repeat(64)
const RECIPIENT = 'b'.repeat(64)
const REF = RECIPIENT + ':7'
const THIRD = 'c'.repeat(64)
const ACTOR_REF = ACTOR + ':5'
const FALLBACK = 'Você tem um aviso novo na Varanda'

function renderedWorker (opts) {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  return loadWorker(readWorker(dist).code, offline, opts)
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
  // answers: the app's listener (src/usePush.web.js) takes a DM wake and
  // says so on the port the worker passes along.
  const win = { url, type: 'window', focused: 0, visibilityState: 'hidden', messages: [], answers: true }
  win.focus = async () => { win.focused++ }
  win.postMessage = (m, transfer) => {
    win.messages.push(m)
    const port = transfer && transfer[0]
    if (win.answers && port && m && m.type === 'varanda-dm-wake') port.postMessage({ type: win.answers === 'no' ? 'varanda-dm-wake-no' : 'varanda-dm-wake-ok' })
  }
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

test('push: a quote or a mention points at the actor\'s own post', async (t) => {
  const w = renderedWorker()
  const quote = await push(w, pushData(valid({ kind: 'quote', body: 'Ana citou sua publicação', ref: ACTOR_REF })))
  t.is(quote.options.body, 'Ana citou sua publicação')
  t.is(quote.options.tag, 'varanda-quote-' + ACTOR_REF)
  t.alike(plain(quote.options.data), { kind: 'quote', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR_REF })

  const mention = await push(w, pushData(valid({ kind: 'mention', body: 'Ana mencionou você', ref: ACTOR_REF })))
  t.is(mention.options.body, 'Ana mencionou você')
  t.is(mention.options.tag, 'varanda-mention-' + ACTOR_REF)
  t.alike(plain(mention.options.data), { kind: 'mention', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR_REF })

  for (const kind of ['quote', 'mention']) {
    const cases = {
      'ref author is the recipient': REF,
      'ref author is a third key': THIRD + ':5',
      'no ref': null,
      'seq 0': ACTOR + ':0',
      'not a ref': ACTOR
    }
    for (const [label, ref] of Object.entries(cases)) {
      const shown = await push(w, pushData(valid({ kind, body: 'Ana citou sua publicação', ref })))
      t.is(shown.options.body, FALLBACK, kind + ': ' + label)
      t.is(shown.options.tag, 'varanda-generic', kind + ': ' + label)
      t.alike(plain(shown.options.data), {}, kind + ': ' + label)
    }
  }

  // The actor-authored ref stays a quote and mention rule only.
  for (const kind of ['reply', 'like', 'repost']) {
    const shown = await push(w, pushData(valid({ kind, ref: ACTOR_REF })))
    t.is(shown.options.body, FALLBACK, kind + ' with the actor\'s ref')
  }
})

test('push: a blocked actor stays quiet, the shown notice is closed at once, others still show', async (t) => {
  const w = renderedWorker()
  const page = fakeWindow(ORIGIN + '/')
  await message(w, { type: 'varanda-blocks', keys: [ACTOR] }, page)
  const reply = await push(w, pushData(valid()))
  t.is(reply.options.tag, 'varanda-dm-wake-quiet', 'WebKit: a push always shows something')
  t.is(reply.options.silent, true)

  const other = 'c'.repeat(64)
  const shown = await push(w, pushData(valid({ actor: other })))
  t.is(shown.options.body, 'Ana respondeu ao seu post')
  t.is(shown.options.data.actor, other)

  await message(w, { type: 'varanda-blocks', keys: [] }, page)
  const undone = await push(w, pushData(valid()))
  t.is(undone.options.body, 'Ana respondeu ao seu post', 'an empty list undoes it')
})

test('push: the list outlives a worker restart', async (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const { code } = readWorker(dist)
  const first = loadWorker(code, serveDist(dist))
  await message(first, { type: 'varanda-blocks', keys: [ACTOR] }, fakeWindow(ORIGIN + '/'))
  const again = loadWorker(code, serveDist(dist), { caches: first.caches })
  const reply = await push(again, pushData(valid()))
  t.is(reply.options.tag, 'varanda-dm-wake-quiet')
})

test('push: a report that is not from an app window, or not a clean list, changes nothing', async (t) => {
  const w = renderedWorker()
  const page = fakeWindow(ORIGIN + '/')
  await message(w, { type: 'varanda-blocks', keys: [ACTOR] }, { ...fakeWindow(ORIGIN + '/'), type: 'worker' })
  await message(w, { type: 'varanda-blocks', keys: [ACTOR] }, null)
  await message(w, { type: 'varanda-blocks', keys: [ACTOR.toUpperCase()] }, page)
  await message(w, { type: 'varanda-blocks', keys: ACTOR }, page)
  await message(w, { type: 'varanda-blocks', keys: new Array(501).fill(ACTOR) }, page)
  await message(w, { type: 'varanda-blocks', keys: [ACTOR], extra: 1 }, page)
  const reply = await push(w, pushData(valid()))
  t.is(reply.options.body, 'Ana respondeu ao seu post')
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
    'unknown kind': pushData(valid({ kind: 'boost' })),
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
  const blob = fakeWindow(ORIGIN + '/blob/' + 'a'.repeat(64) + '/0')
  const post = fakeWindow(ORIGIN + '/p/' + 'a'.repeat(64) + '/1')
  const app = fakeWindow(ORIGIN + '/?conta=1')
  w.windows = [panel, media, blob, post, app]
  await click(w, { kind: 'like', actor: ACTOR, recipient: RECIPIENT, ref: REF })
  t.is(panel.focused, 0)
  t.is(panel.messages.length, 0)
  t.is(media.focused, 0)
  t.is(blob.focused, 0, 'a /blob/ chunk tab is not the app')
  t.is(post.focused, 0, 'a /p/ page is not the app')
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

test('notificationclick: a quote or a mention opens the actor\'s post', async (t) => {
  const w = renderedWorker()
  w.windows = [fakeWindow('https://other.test/')]
  await click(w, { kind: 'quote', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR_REF })
  await click(w, { kind: 'mention', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR_REF })
  await click(w, { kind: 'quote', actor: ACTOR, recipient: RECIPIENT, ref: REF })
  await click(w, { kind: 'mention', actor: ACTOR, recipient: RECIPIENT, ref: THIRD + ':5' })
  t.alike(w.opened, [
    '/?aviso=quote&actor=' + ACTOR + '&recipient=' + RECIPIENT + '&ref=' + ACTOR_REF,
    '/?aviso=mention&actor=' + ACTOR + '&recipient=' + RECIPIENT + '&ref=' + ACTOR_REF,
    '/',
    '/'
  ])

  const mine = fakeWindow(ORIGIN + '/')
  w.windows = [mine]
  await click(w, { kind: 'mention', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR_REF })
  await click(w, { kind: 'quote', actor: ACTOR, recipient: RECIPIENT, ref: REF })
  t.is(mine.focused, 2)
  t.alike(plain(mine.messages), [{ source: 'varanda-push', kind: 'mention', actor: ACTOR, recipient: RECIPIENT, ref: ACTOR_REF }])
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

test('push: a DM wake shows the fixed sentence naming nobody; anything more is the fallback', async (t) => {
  const w = renderedWorker()
  const shown = await push(w, pushData({ v: 1, kind: 'dm-wake' }))
  t.is(shown.title, 'Varanda')
  t.is(shown.options.body, 'Pode haver uma mensagem nova na Varanda')
  t.is(shown.options.tag, 'varanda-dm-wake')
  t.is(shown.options.renotify, false)
  t.alike(plain(shown.options.data), { kind: 'dm-wake' })
  for (const bad of [{ v: 1, kind: 'dm-wake', actor: ACTOR }, { v: 1, kind: 'dm-wake', body: 'Ana mandou' }, { v: 2, kind: 'dm-wake' }, { kind: 'dm-wake' }]) {
    const fallback = await push(w, pushData(bad))
    t.is(fallback.options.body, FALLBACK, JSON.stringify(bad))
    t.alike(plain(fallback.options.data), {})
  }
})

test('notificationclick: a DM wake focuses the app and posts varanda-dm-open', async (t) => {
  const w = renderedWorker()
  const mine = fakeWindow(ORIGIN + '/')
  w.windows = [mine]
  t.ok(await click(w, { kind: 'dm-wake' }), 'closed')
  t.is(mine.focused, 1)
  t.alike(plain(mine.messages), [{ type: 'varanda-dm-open' }])
  t.alike(w.opened, [])

  // No window open: the launch query, read once the app starts, opens
  // Conversas; nothing is posted to a page that may still be loading.
  const fresh = renderedWorker()
  t.ok(await click(fresh, { kind: 'dm-wake' }))
  t.alike(fresh.opened, ['/?aviso=dm'])

  // A window that refuses focus: the same launch query in a new window.
  const stuck = renderedWorker()
  const refusing = fakeWindow(ORIGIN + '/')
  refusing.focus = async () => { throw new Error('InvalidAccessError') }
  stuck.windows = [refusing]
  t.ok(await click(stuck, { kind: 'dm-wake' }))
  t.alike(stuck.opened, ['/?aviso=dm'])
  t.alike(refusing.messages, [])

  // Extra fields are not a DM wake: nothing is posted.
  t.ok(await click(w, { kind: 'dm-wake', actor: ACTOR }))
  t.is(mine.messages.length, 1)
})

test('push: an invite drop shows its own title and fixed sentence; anything more is the fallback', async (t) => {
  const w = renderedWorker()
  const shown = await push(w, pushData({ v: 1, kind: 'invite-drop' }))
  t.is(shown.title, 'Chegou um convite pra sua varanda')
  t.is(shown.options.body, 'Escolha com carinho quem você quer chamar: alguém próximo, que faz falta na conversa.')
  t.is(shown.options.icon, '/icon-192.png')
  t.is(shown.options.tag, 'varanda-invite-drop')
  t.is(shown.options.renotify, false)
  t.alike(plain(shown.options.data), { kind: 'invite-drop' })
  const bads = [
    { v: 1, kind: 'invite-drop', actor: ACTOR },
    { v: 1, kind: 'invite-drop', body: 'Ana chamou você' },
    { v: 1, kind: 'invite-drop', recipient: RECIPIENT },
    { v: 1, kind: 'invite-drop', grant: 'g1' },
    { v: 2, kind: 'invite-drop' },
    { kind: 'invite-drop' },
    { v: 1, kind: 'invite' }
  ]
  for (const bad of bads) {
    const fallback = await push(w, pushData(bad))
    t.is(fallback.title, 'Varanda', JSON.stringify(bad))
    t.is(fallback.options.body, FALLBACK, JSON.stringify(bad))
    t.alike(plain(fallback.options.data), {})
  }

  // The other kinds keep the Varanda title.
  t.is((await push(w, pushData({ v: 1, kind: 'dm-wake' }))).title, 'Varanda')
  t.is((await push(w, pushData(valid()))).title, 'Varanda')
})

test('push: a scheduled deletion shows its own title and fixed sentence; anything more is the fallback', async (t) => {
  const w = renderedWorker()
  const shown = await push(w, pushData({ v: 1, kind: 'delete-scheduled' }))
  t.is(shown.title, 'Pedido de exclusão da sua conta')
  t.is(shown.options.body, 'Se não foi você, abra a Varanda e cancele em Ajustes.')
  t.is(shown.options.tag, 'varanda-delete-scheduled')
  t.alike(plain(shown.options.data), { kind: 'delete-scheduled' })
  for (const bad of [{ v: 1, kind: 'delete-scheduled', body: 'x' }, { v: 2, kind: 'delete-scheduled' }, { kind: 'delete-scheduled' }]) {
    const fallback = await push(w, pushData(bad))
    t.is(fallback.title, 'Varanda', JSON.stringify(bad))
    t.is(fallback.options.body, FALLBACK, JSON.stringify(bad))
  }
})

test('notificationclick: an invite drop focuses the app and posts varanda-invite-open', async (t) => {
  const w = renderedWorker()
  const mine = fakeWindow(ORIGIN + '/')
  w.windows = [mine]
  t.ok(await click(w, { kind: 'invite-drop' }), 'closed')
  t.is(mine.focused, 1)
  t.alike(plain(mine.messages), [{ type: 'varanda-invite-open' }])
  t.alike(w.opened, [])

  const fresh = renderedWorker()
  t.ok(await click(fresh, { kind: 'invite-drop' }))
  t.alike(fresh.opened, ['/?aviso=convite'])

  const stuck = renderedWorker()
  const refusing = fakeWindow(ORIGIN + '/')
  refusing.focus = async () => { throw new Error('InvalidAccessError') }
  stuck.windows = [refusing]
  t.ok(await click(stuck, { kind: 'invite-drop' }))
  t.alike(stuck.opened, ['/?aviso=convite'])
  t.alike(refusing.messages, [])

  // Extra fields never navigate to the notice and never post.
  t.ok(await click(w, { kind: 'invite-drop', actor: ACTOR }))
  t.is(mine.messages.length, 1)
  const extra = renderedWorker()
  await click(extra, { kind: 'invite-drop', recipient: RECIPIENT })
  await click(extra, { kind: 'invite-drop', ref: REF })
  // An old worker's generic notification (data {}) still opens the root.
  await click(extra, {})
  t.alike(extra.opened, ['/', '/', '/'])
})

const DM_WAKE = { v: 1, kind: 'dm-wake' }
const MUTE_MS = 120000
const DM_STATE = ORIGIN + '/__varanda-dm-state'

function activeWindow (url) {
  const win = fakeWindow(url)
  win.focused = true
  win.visibilityState = 'visible'
  return win
}

async function message (w, data, source) {
  const waits = []
  w.handlers.message({ data, source, ports: [], waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
}

// The notices this wake left on screen: a quiet one shown and closed at once
// (showQuietlyAndClose) is not among them.
async function wakeShown (w) {
  const waits = []
  const before = w.shown.length
  w.handlers.push({ data: pushData(DM_WAKE), waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
  return w.shown.slice(before).filter((n) => !w.closed.has(n))
}

function openNotices (w) {
  return w.shown.filter((n) => !w.closed.has(n))
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function fakeTimers () {
  let now = 0
  let next = 1
  const pending = new Map()
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, at: now + ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    advance (ms) {
      now += ms
      const due = [...pending].filter(([, x]) => x.at <= now).sort((a, b) => a[1].at - b[1].at)
      for (const [id, x] of due) {
        if (!pending.delete(id)) continue
        x.fn()
      }
    }
  }
}

async function settle (cond, max = 50) {
  for (let i = 0; i < max && !cond(); i++) await new Promise(setImmediate)
}

function startPush (w, data) {
  const waits = []
  w.handlers.push({ data, waitUntil: (p) => waits.push(p) })
  return Promise.all(waits)
}

test('dm wake: on Android the quiet notice is closed only once the system has posted it', async (t) => {
  const cases = {
    'focused window': async (w) => { w.windows = [activeWindow(ORIGIN + '/')] },
    'own send': async (w) => { await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/')) },
    'blocked actor': async (w) => { await message(w, { type: 'varanda-blocks', keys: [ACTOR] }, fakeWindow(ORIGIN + '/')) }
  }
  for (const [label, prepare] of Object.entries(cases)) {
    const clock = fakeTimers()
    const w = renderedWorker({ navigator: { userAgent: ANDROID_UA }, timers: clock })
    w.postDelayMs = 500
    await prepare(w)
    const done = startPush(w, pushData(label === 'blocked actor' ? valid() : DM_WAKE))
    await settle(() => w.shown.length === 1)
    t.is(w.shown.length, 1, label + ': one notice shown')
    t.is(openNotices(w).length, 1, label + ': still open')
    clock.advance(1999)
    await settle(() => false, 5)
    t.is(openNotices(w).length, 1, label + ': still open before the wait ends')
    clock.advance(1)
    await done
    t.alike(openNotices(w), [], label + ': closed')
    t.ok(w.closed.has(w.shown[0]), label + ': the close was kept')
  }
})

test('dm wake: outside Android the quiet notice is still closed at once', async (t) => {
  for (const [label, opts] of [['no navigator', {}], ['desktop Chrome', { navigator: { userAgent: DESKTOP_UA } }]]) {
    const clock = fakeTimers()
    const w = renderedWorker({ ...opts, timers: clock })
    w.windows = [activeWindow(ORIGIN + '/')]
    await startPush(w, pushData(DM_WAKE))
    t.is(w.shown.length, 1, label + ': one notice shown')
    t.ok(w.closed.has(w.shown[0]), label + ': closed with no timer advanced')
  }
})

test('dm wake: on Android a second quiet notice inside the wait is closed after its own wait', async (t) => {
  const clock = fakeTimers()
  const w = renderedWorker({ navigator: { userAgent: ANDROID_UA }, timers: clock })
  w.postDelayMs = 500
  w.windows = [activeWindow(ORIGIN + '/')]
  let done1 = false
  let done2 = false
  const p1 = startPush(w, pushData(DM_WAKE)).then(() => { done1 = true })
  await settle(() => w.shown.length === 1)
  clock.advance(1500)
  const p2 = startPush(w, pushData(DM_WAKE)).then(() => { done2 = true })
  await settle(() => w.shown.length === 2)
  clock.advance(500)
  await p1
  t.ok(done1, 'the first push is done')
  t.not(done2, 'the second push still waits')
  t.absent(w.closed.has(w.shown[1]), 'the second notice is not closed')
  t.absent(w.shown[1].dropped, 'the second notice is not dropped')
  clock.advance(1500)
  await p2
  t.alike(openNotices(w), [], 'closed after its own wait')
})

test('dm wake: on Android the delayed close leaves a real DM wake on screen', async (t) => {
  const clock = fakeTimers()
  const w = renderedWorker({ navigator: { userAgent: ANDROID_UA }, timers: clock })
  w.postDelayMs = 500
  const real = startPush(w, pushData(DM_WAKE))
  await settle(() => w.shown.length === 1)
  clock.advance(500)
  await real
  await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
  const quietWake = startPush(w, pushData(DM_WAKE))
  await settle(() => w.shown.length === 2)
  clock.advance(2000)
  await quietWake
  const open = openNotices(w)
  t.is(open.length, 1, 'one notice left')
  t.is(open[0].options.tag, 'varanda-dm-wake', 'the real wake')
})

test('push: on Android a failing showNotification neither waits nor throws', async (t) => {
  const clock = fakeTimers()
  const w = renderedWorker({ navigator: { userAgent: ANDROID_UA }, timers: clock })
  w.windows = [activeWindow(ORIGIN + '/')]
  w.shown = { push: () => { throw new Error('quota') } }
  let done = false
  const p = startPush(w, pushData(DM_WAKE)).then(() => { done = true })
  await settle(() => done)
  t.ok(done, 'settled with no timer advanced')
  await t.execution(p)
})

test('dm wake: a wake this device hides is still shown, quietly, and closed at once', async (t) => {
  // WebKit revokes a subscription whose push shows no notification.
  const focusedCase = renderedWorker()
  focusedCase.windows = [activeWindow(ORIGIN + '/')]
  const mutedCase = renderedWorker()
  await message(mutedCase, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
  for (const [label, w] of [['focused window', focusedCase], ['own send', mutedCase]]) {
    t.alike(await wakeShown(w), [], label + ': nothing left on screen')
    t.is(w.shown.length, 1, label + ': one notice shown')
    const quiet = w.shown[0]
    if (!quiet) continue
    t.is(quiet.options.tag, 'varanda-dm-wake-quiet', label)
    t.is(quiet.options.silent, true, label + ': no sound or vibration')
    t.ok(w.closed.has(quiet), label + ': closed')
  }
})

test('dm wake: the quiet notice never closes a real DM wake still on screen', async (t) => {
  const w = renderedWorker()
  const real = await wakeShown(w)
  t.is(real.length, 1, 'a real wake is shown')
  await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
  t.alike(await wakeShown(w), [], 'the next one is hidden')
  t.alike(openNotices(w), real, 'the real one stays')
})

test('dm wake: a visible focused app window gets a message instead of a notification', async (t) => {
  const w = renderedWorker()
  const win = activeWindow(ORIGIN + '/')
  w.windows = [fakeWindow('https://other.test/'), win]
  t.alike(await wakeShown(w), [], 'nothing shown')
  t.alike(plain(win.messages), [{ type: 'varanda-dm-wake' }])
  t.alike(w.matchAllOpts && plain(w.matchAllOpts), { type: 'window', includeUncontrolled: true })
})

test('dm wake: a window that answers no (the person left it) gets the notice at once', async (t) => {
  const w = renderedWorker()
  const win = activeWindow(ORIGIN + '/')
  win.answers = 'no'
  w.windows = [win]
  const started = Date.now()
  const shown = await wakeShown(w)
  t.is(shown.length, 1, 'shown')
  if (shown[0]) t.is(shown[0].options.tag, 'varanda-dm-wake')
  t.ok(Date.now() - started < 900, 'without waiting for the acknowledgement timeout')
})

test('dm wake: the acknowledgement window is 2 s: a slow answer still counts, silence shows the notice after it', async (t) => {
  const slow = renderedWorker()
  const late = activeWindow(ORIGIN + '/')
  late.postMessage = (m, transfer) => {
    late.messages.push(m)
    const port = transfer && transfer[0]
    if (port) setTimeout(() => port.postMessage({ type: 'varanda-dm-wake-ok' }), 1500)
  }
  slow.windows = [late]
  t.alike(await wakeShown(slow), [], 'an answer at 1.5 s still hides the notice')

  const silent = renderedWorker()
  const mute = activeWindow(ORIGIN + '/')
  mute.answers = false
  silent.windows = [mute]
  const started = Date.now()
  t.is((await wakeShown(silent)).length, 1, 'silence shows the notice')
  const waited = Date.now() - started
  t.ok(waited >= 1900 && waited < 3500, 'after about 2 s, not 1 s (' + waited + ' ms)')
})

test('dm wake: once a focused window takes the wake, the other app windows are told to re-read', async (t) => {
  const w = renderedWorker()
  const focused = activeWindow(ORIGIN + '/')
  const hidden = fakeWindow(ORIGIN + '/')
  const panel = fakeWindow(ORIGIN + '/account/mod/')
  w.windows = [hidden, focused, panel]
  t.alike(await wakeShown(w), [], 'nothing shown')
  t.alike(plain(focused.messages), [{ type: 'varanda-dm-wake' }])
  t.alike(plain(hidden.messages), [{ type: 'varanda-dm-wake' }], 'the hidden app window re-reads')
  t.alike(panel.messages, [], 'not the moderation panel')
})

test('dm wake: an unfocused, hidden or non-app window does not stop the notification', async (t) => {
  const cases = {
    'visible but unfocused': () => { const x = activeWindow(ORIGIN + '/'); x.focused = false; return x },
    'hidden and focused': () => { const x = activeWindow(ORIGIN + '/'); x.visibilityState = 'hidden'; return x },
    'moderation panel': () => activeWindow(ORIGIN + '/account/mod/'),
    'well-known file': () => activeWindow(ORIGIN + '/.well-known/assetlinks.json'),
    'other origin': () => activeWindow('https://other.test/'),
    'focused tab that never answers (an image opened directly)': () => { const x = activeWindow(ORIGIN + '/icon-192.png'); x.answers = false; return x }
  }
  for (const [label, make] of Object.entries(cases)) {
    const w = renderedWorker()
    const win = make()
    w.windows = [win]
    const shown = await wakeShown(w)
    t.is(shown.length, 1, label)
    if (shown.length === 1) {
      t.is(shown[0].options.body, 'Pode haver uma mensagem nova na Varanda', label)
      t.is(shown[0].options.tag, 'varanda-dm-wake', label)
    }
    if (win.answers) t.alike(win.messages, [], label + ': nothing posted')
    else t.alike(plain(win.messages), [{ type: 'varanda-dm-wake' }], label + ': asked, no answer')
  }
})

test('dm wake: muted for 120 s after an own send reported by an app window', async (t) => {
  const w = renderedWorker()
  const app = fakeWindow(ORIGIN + '/')
  w.now = 1000000
  await message(w, { type: 'varanda-dm-sent' }, app)
  t.ok(w.caches.stores.has('varanda-dm-state'), 'state cache written')
  t.alike(await wakeShown(w), [], 'right away')
  w.now = 1000000 + MUTE_MS - 1
  t.alike(await wakeShown(w), [], 'just inside the window')
  w.now = 1000000 + MUTE_MS
  t.is((await wakeShown(w)).length, 1, 'shown at the deadline')
  w.now = 1000000 + MUTE_MS + 1
  const shown = await wakeShown(w)
  t.is(shown.length, 1, 'shown 1 ms after')
  t.is(shown[0].options.tag, 'varanda-dm-wake')
  t.alike(plain(shown[0].options.data), { kind: 'dm-wake' })
})

test('dm wake: a send reported while the wake reads the mute record still mutes it', async (t) => {
  const w = renderedWorker()
  w.now = 1000000
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reading = false
  const open = w.caches.open
  w.caches.open = async (name) => {
    const cache = await open.call(w.caches, name)
    if (name !== 'varanda-dm-state') return cache
    return {
      put: (k, v) => cache.put(k, v),
      // The read takes its answer before the send is reported and hands
      // it back after: the stale record a real slow read can return.
      match: async (k) => {
        const res = await cache.match(k)
        reading = true
        await gate
        return res
      }
    }
  }
  const waits = []
  w.handlers.push({ data: pushData(DM_WAKE), waitUntil: (p) => waits.push(p) })
  await new Promise((resolve) => setImmediate(resolve))
  t.ok(reading, 'the wake is reading the record')
  await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
  release()
  await Promise.all(waits)
  t.alike(openNotices(w), [], 'muted')
})

test('dm wake: the deadline comes from the worker clock, never the page', async (t) => {
  const w = renderedWorker()
  w.now = 5000
  await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
  const res = await (await w.caches.open('varanda-dm-state')).match(DM_STATE)
  t.ok(res, 'record stored')
  if (res) t.alike(JSON.parse(await res.text()), { v: 1, until: 5000 + MUTE_MS })
})

test('dm wake: malformed or foreign send reports are ignored', async (t) => {
  const app = fakeWindow(ORIGIN + '/')
  const cases = [
    ['extra key', { type: 'varanda-dm-sent', until: 9e15 }, app],
    ['non-object', 'varanda-dm-sent', app],
    ['array', ['varanda-dm-sent'], app],
    ['account client', { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/account/mod/')],
    ['media client', { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/media/x')],
    ['well-known client', { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/.well-known/assetlinks.json')],
    ['other origin', { type: 'varanda-dm-sent' }, fakeWindow('https://other.test/')],
    ['worker client', { type: 'varanda-dm-sent' }, { url: ORIGIN + '/', type: 'worker' }],
    ['no source', { type: 'varanda-dm-sent' }, undefined]
  ]
  for (const [label, data, source] of cases) {
    const w = renderedWorker()
    await message(w, data, source)
    t.is((await wakeShown(w)).length, 1, label)
  }
  const w = renderedWorker()
  t.execution(() => w.handlers.message({ data: { type: 'varanda-dm-sent' } }))
  t.execution(() => w.handlers.message({ data: { type: 'varanda-dm-sent' }, source: app }))
})

test('dm wake: the mute survives a worker restart and an activate', async (t) => {
  const dist = makeDist()
  quiet(() => finishWeb(dist))
  const { code, version } = readWorker(dist)
  const first = loadWorker(code, serveDist(dist))
  await lifecycle(first, 'install')
  first.now = 2000000
  await message(first, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))

  const second = loadWorker(code, serveDist(dist), { caches: first.caches })
  second.now = 2000000 + 1000
  await lifecycle(second, 'activate')
  t.ok(first.caches.stores.has('varanda-dm-state'), 'activate keeps the state cache')
  t.ok(first.caches.stores.has('varanda-shell-' + version), 'and the current release')
  t.alike(await wakeShown(second), [], 'still muted after restart')
  second.now = 2000000 + MUTE_MS + 1
  t.is((await wakeShown(second)).length, 1)
})

test('dm wake: a cached deadline that is too far, not an integer or malformed is ignored', async (t) => {
  const cases = {
    'far future': JSON.stringify({ v: 1, until: 1000 + MUTE_MS + 1 }),
    'way in the future': JSON.stringify({ v: 1, until: 9e15 }),
    'not an integer': JSON.stringify({ v: 1, until: 1000 + 0.5 }),
    'string deadline': JSON.stringify({ v: 1, until: String(1000 + 1000) }),
    'unsafe integer': JSON.stringify({ v: 1, until: 2 ** 60 }),
    'wrong version': JSON.stringify({ v: 2, until: 1000 + 1000 }),
    'extra key': JSON.stringify({ v: 1, until: 1000 + 1000, x: 1 }),
    'not json': 'mute'
  }
  for (const [label, body] of Object.entries(cases)) {
    const w = renderedWorker()
    w.now = 1000
    await (await w.caches.open('varanda-dm-state')).put(DM_STATE, new Response(body))
    t.is((await wakeShown(w)).length, 1, label)
  }
  const ok = renderedWorker()
  ok.now = 1000
  await (await ok.caches.open('varanda-dm-state')).put(DM_STATE, new Response(JSON.stringify({ v: 1, until: 1000 + MUTE_MS })))
  t.alike(await wakeShown(ok), [], 'a well-formed deadline mutes')
})

test('dm wake: member notices still show while muted or with a focused window', async (t) => {
  const w = renderedWorker()
  const win = activeWindow(ORIGIN + '/')
  w.windows = [win]
  await message(w, { type: 'varanda-dm-sent' }, win)
  for (const kind of ['follow', 'reply', 'like', 'repost']) {
    const over = kind === 'follow' ? { kind, ref: null } : { kind }
    const shown = await push(w, pushData(valid(over)))
    t.is(shown.options.body, 'Ana respondeu ao seu post', kind)
  }
  const fallback = await push(w, pushData({ v: 1, kind: 'dm-wake', x: 1 }))
  t.is(fallback.options.body, FALLBACK, 'invalid payload still falls back')
  t.alike(win.messages, [], 'no wake message for notices')
})

const G = 1763400000000
const DM_NOTICES = {
  dm: { body: 'Nova mensagem nas Conversas', tag: 'varanda-dm' },
  'dm-page': { body: 'Nova mensagem para uma página que você administra', tag: 'varanda-dm-page' }
}

// The notices a push left on screen (a quiet one closed at once is not).
async function noticeShown (w, payload) {
  const before = w.shown.length
  await startPush(w, pushData(payload))
  return w.shown.slice(before).filter((n) => !w.closed.has(n))
}

test('push: a DM notice shows the fixed sentence of its kind, naming nobody', async (t) => {
  const w = renderedWorker()
  for (const [kind, want] of Object.entries(DM_NOTICES)) {
    for (const g of [G, 1, Number.MAX_SAFE_INTEGER]) {
      const shown = await push(w, pushData({ v: 1, kind, g }))
      t.is(shown.title, 'Varanda', kind)
      t.is(shown.options.body, want.body, kind)
      t.is(shown.options.icon, '/icon-192.png', kind)
      t.is(shown.options.tag, want.tag, kind)
      t.is(shown.options.renotify, false, kind)
      t.alike(plain(shown.options.data), { kind, g }, kind + ' g ' + g)
    }
  }
})

test('push: a malformed DM notice shows only the fallback sentence', async (t) => {
  const w = renderedWorker()
  for (const kind of Object.keys(DM_NOTICES)) {
    const bads = {
      'extra key': { v: 1, kind, g: G, x: 1 },
      'with a group': { v: 1, kind, g: G, group: 'c'.repeat(64) },
      'with a body': { v: 1, kind, g: G, body: 'Ana mandou' },
      'with an actor': { v: 1, kind, g: G, actor: ACTOR },
      'missing g': { v: 1, kind },
      'g swapped for another key': { v: 1, kind, group: G },
      'g a string': { v: 1, kind, g: String(G) },
      'g zero': { v: 1, kind, g: 0 },
      'g negative': { v: 1, kind, g: -G },
      'g not an integer': { v: 1, kind, g: G + 0.5 },
      'g past safe integers': { v: 1, kind, g: Number.MAX_SAFE_INTEGER + 1 },
      'g null': { v: 1, kind, g: null },
      'wrong version': { v: 2, kind, g: G },
      'missing version': { kind, g: G }
    }
    for (const [label, bad] of Object.entries(bads)) {
      const shown = await push(w, pushData(bad))
      t.is(shown.title, 'Varanda', kind + ': ' + label)
      t.is(shown.options.body, FALLBACK, kind + ': ' + label)
      t.is(shown.options.tag, 'varanda-generic', kind + ': ' + label)
      t.alike(plain(shown.options.data), {}, kind + ': ' + label)
    }
  }
  const unknown = await push(w, pushData({ v: 1, kind: 'dm-group', g: G }))
  t.is(unknown.options.body, FALLBACK, 'an unknown DM kind')
})

test('dm notice: a visible focused app window takes it and the worker shows only the quiet notice', async (t) => {
  for (const kind of ['dm']) {
    const w = renderedWorker()
    const win = activeWindow(ORIGIN + '/')
    const hidden = fakeWindow(ORIGIN + '/')
    w.windows = [hidden, win]
    t.alike(await noticeShown(w, { v: 1, kind, g: G }), [], kind + ': nothing left on screen')
    t.is(w.shown.length, 1, kind + ': one notice shown (WebKit: a push always shows something)')
    const quiet = w.shown[0]
    if (quiet) {
      t.is(quiet.options.tag, 'varanda-dm-wake-quiet', kind)
      t.is(quiet.options.silent, true, kind + ': no sound or vibration')
      t.is(quiet.options.body, DM_NOTICES[kind].body, kind + ': the notice sentence, not the old wake one')
      t.ok(w.closed.has(quiet), kind + ': closed')
    }
    t.alike(plain(win.messages), [{ type: 'varanda-dm-wake' }], kind + ': the focused window re-reads')
    t.alike(plain(hidden.messages), [{ type: 'varanda-dm-wake' }], kind + ': the other app window re-reads')

    // A window that is visible but not focused does not take it.
    const other = renderedWorker()
    const unfocused = activeWindow(ORIGIN + '/')
    unfocused.focused = false
    other.windows = [unfocused]
    const shown = await noticeShown(other, { v: 1, kind, g: G })
    t.is(shown.length, 1, kind + ': shown with an unfocused window')
    if (shown[0]) t.is(shown[0].options.tag, DM_NOTICES[kind].tag, kind)
    t.alike(unfocused.messages, [], kind + ': nothing posted')
  }
})

// The focused window's hand-off only re-reads the member inbox; a Pagina's
// thread lives in the Pagina's own inbox, so its notice must always show.
test('dm-page notice: shown even with a visible focused app window, which gets no wake', async (t) => {
  const w = renderedWorker()
  const win = activeWindow(ORIGIN + '/')
  const hidden = fakeWindow(ORIGIN + '/')
  w.windows = [hidden, win]
  const shown = await noticeShown(w, { v: 1, kind: 'dm-page', g: G })
  t.is(shown.length, 1, 'shown')
  if (shown[0]) {
    t.is(shown[0].options.tag, 'varanda-dm-page')
    t.is(shown[0].options.body, DM_NOTICES['dm-page'].body)
    t.is(shown[0].options.silent, undefined, 'not the quiet notice')
  }
  t.is(w.shown.length, 1, 'no quiet notice besides it')
  t.alike(win.messages, [], 'no wake to the focused window')
  t.alike(hidden.messages, [], 'no wake to the other window')
})

test('dm notice: shown 1 s after an own send, while a DM wake is still muted', async (t) => {
  for (const kind of Object.keys(DM_NOTICES)) {
    const w = renderedWorker()
    w.now = 1000000
    await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
    w.now = 1000000 + 1000
    const shown = await noticeShown(w, { v: 1, kind, g: G })
    t.is(shown.length, 1, kind + ': shown inside the mute window')
    if (shown[0]) {
      t.is(shown[0].options.tag, DM_NOTICES[kind].tag, kind)
      t.is(shown[0].options.body, DM_NOTICES[kind].body, kind)
    }
    t.alike(await wakeShown(w), [], kind + ': the wake itself stays muted')
  }
})

// A dm notice opens Conversas; a dm-page notice opens Paginas, since its
// thread is in the Pagina's own inbox and the notice names no Pagina.
const DM_CLICKS = {
  dm: { message: { type: 'varanda-dm-open' }, path: '/?aviso=dm' },
  'dm-page': { message: { type: 'varanda-page-dm-open' }, path: '/?aviso=dm-page' }
}

test('notificationclick: a DM notice focuses the app and posts its open message', async (t) => {
  for (const kind of Object.keys(DM_NOTICES)) {
    const want = DM_CLICKS[kind]
    const w = renderedWorker()
    const mine = fakeWindow(ORIGIN + '/')
    w.windows = [mine]
    t.ok(await click(w, { kind, g: G }), kind + ': closed')
    t.is(mine.focused, 1, kind)
    t.alike(plain(mine.messages), [want.message], kind)
    t.alike(w.opened, [], kind)

    const fresh = renderedWorker()
    t.ok(await click(fresh, { kind, g: G }))
    t.alike(fresh.opened, [want.path], kind + ': no window opens the app on its screen')

    const stuck = renderedWorker()
    const refusing = fakeWindow(ORIGIN + '/')
    refusing.focus = async () => { throw new Error('InvalidAccessError') }
    stuck.windows = [refusing]
    t.ok(await click(stuck, { kind, g: G }))
    t.alike(stuck.opened, [want.path], kind + ': a window that refuses focus')
    t.alike(refusing.messages, [], kind)

    // Anything but the shape the worker itself stored is not a DM notice.
    t.ok(await click(w, { kind, g: G, actor: ACTOR }))
    t.ok(await click(w, { kind, g: '1' }))
    t.ok(await click(w, { kind }))
    t.is(mine.messages.length, 1, kind + ': nothing more posted')
    const bad = renderedWorker()
    await click(bad, { kind, g: G, actor: ACTOR })
    await click(bad, { kind, g: 0 })
    await click(bad, { kind })
    t.alike(bad.opened, ['/', '/', '/'], kind + ': malformed data opens the root')
  }
})

const GROUP_KEY = 'd'.repeat(64)
const GROUP_NAME = 'Varanda'

function groupPublic (over = {}) {
  return { v: 1, kind: 'group', group: GROUP_KEY, body: GROUP_NAME, g: G, ...over }
}

test('push: a group notice shows the sentence, tag and data of its kind', async (t) => {
  const w = renderedWorker()
  const cases = [
    {
      label: 'public with a name',
      payload: (g) => groupPublic({ g }),
      body: 'Nova mensagem em ' + GROUP_NAME,
      tag: 'varanda-group-' + GROUP_KEY,
      kind: 'group'
    },
    {
      label: 'public with no name',
      payload: (g) => groupPublic({ body: null, g }),
      body: 'Nova mensagem num grupo',
      tag: 'varanda-group-' + GROUP_KEY,
      kind: 'group'
    },
    {
      label: 'private',
      payload: (g) => ({ v: 1, kind: 'group-private', g }),
      body: 'Nova mensagem num grupo privado',
      tag: 'varanda-group-private',
      kind: 'group-private'
    }
  ]
  for (const c of cases) {
    for (const g of [G, 1, Number.MAX_SAFE_INTEGER]) {
      const shown = await push(w, pushData(c.payload(g)))
      t.is(shown.title, 'Varanda', c.label)
      t.is(shown.options.body, c.body, c.label)
      t.is(shown.options.icon, '/icon-192.png', c.label)
      t.is(shown.options.tag, c.tag, c.label)
      t.is(shown.options.renotify, false, c.label)
      t.alike(plain(shown.options.data), { kind: c.kind, g }, c.label + ' g ' + g)
      t.absent(shown.options.body.includes(GROUP_KEY), c.label + ': the sentence names no key')
    }
  }

  // Key order is not part of the shape: the same keys in another order still show.
  const reordered = await push(w, pushData({ body: GROUP_NAME, g: G, v: 1, group: GROUP_KEY, kind: 'group' }))
  t.is(reordered.options.body, 'Nova mensagem em ' + GROUP_NAME, 'reordered public keys')
  t.is(reordered.options.tag, 'varanda-group-' + GROUP_KEY, 'reordered public keys')
  t.alike(plain(reordered.options.data), { kind: 'group', g: G }, 'reordered public keys')
  const reorderedPrivate = await push(w, pushData({ g: G, kind: 'group-private', v: 1 }))
  t.is(reorderedPrivate.options.body, 'Nova mensagem num grupo privado', 'reordered private keys')
  t.is(reorderedPrivate.options.tag, 'varanda-group-private', 'reordered private keys')
  t.alike(plain(reorderedPrivate.options.data), { kind: 'group-private', g: G }, 'reordered private keys')

  const long = '😀'.repeat(120)
  const named = await push(w, pushData(groupPublic({ body: long })))
  t.is(named.options.body, 'Nova mensagem em ' + long, '120 code points are allowed')
  t.is(named.options.renotify, false, '120 code points')
  // validBody accepts a one-space name: it is not the null name.
  const space = await push(w, pushData(groupPublic({ body: ' ' })))
  t.is(space.options.body, 'Nova mensagem em  ', 'a name validBody accepts is shown')
  t.is(space.options.tag, 'varanda-group-' + GROUP_KEY, 'a one-space name still tags the group')
})

test('push: a malformed public group notice shows only the fallback sentence', async (t) => {
  const w = renderedWorker()
  const refused = async (payload, label) => {
    const shown = await push(w, pushData(payload))
    t.is(shown.title, 'Varanda', label)
    t.is(shown.options.body, FALLBACK, label)
    t.is(shown.options.tag, 'varanda-generic', label)
    t.alike(plain(shown.options.data), {}, label)
  }
  const bodies = {
    'empty body': '',
    'body too long': 'a'.repeat(121),
    '121 emoji': '😀'.repeat(121),
    newline: 'Varanda\n',
    'line separator': 'Varanda\u2028',
    'bidi override': 'Varanda\u202e',
    'left to right mark': 'Varanda\u200e',
    'body a number': 1,
    'body an object': { name: GROUP_NAME },
    'body an array': [GROUP_NAME],
    'body false': false
  }
  for (const [label, body] of Object.entries(bodies)) await refused(groupPublic({ body }), label)
  const groups = {
    uppercase: 'A'.repeat(64),
    'mixed case': 'a'.repeat(63) + 'F',
    short: 'a'.repeat(63),
    long: 'a'.repeat(65),
    'not hex': 'g'.repeat(64),
    'empty group': '',
    'group null': null,
    'group a number': 1
  }
  for (const [label, group] of Object.entries(groups)) await refused(groupPublic({ group }), label)
  await refused({ kind: 'group', group: GROUP_KEY, body: GROUP_NAME, g: G }, 'missing v')
  await refused({ v: 1, group: GROUP_KEY, body: GROUP_NAME, g: G }, 'missing kind')
  await refused({ v: 1, kind: 'group', body: GROUP_NAME, g: G }, 'missing group')
  await refused({ v: 1, kind: 'group', group: GROUP_KEY, g: G }, 'missing body')
  await refused({ v: 1, kind: 'group', group: GROUP_KEY, body: GROUP_NAME }, 'missing g')
  await refused(groupPublic({ x: 1 }), 'extra key')
  await refused(groupPublic({ body: null, x: 1 }), 'null name with an extra key')
  await refused(groupPublic({ actor: ACTOR }), 'with an actor')
  await refused(groupPublic({ name: GROUP_NAME }), 'with a name key')
  await refused(groupPublic({ visibility: 'public' }), 'with a visibility')
  const times = {
    'g a string': String(G),
    'g zero': 0,
    'g negative': -G,
    'g not an integer': G + 0.5,
    'g past safe integers': Number.MAX_SAFE_INTEGER + 1,
    'g null': null
  }
  for (const [label, g] of Object.entries(times)) await refused(groupPublic({ g }), label)
  await refused(groupPublic({ v: 2 }), 'wrong version')
  await refused({ v: 1, kind: 'group', g: G }, 'only the dm keys')
  await refused(groupPublic({ kind: 'groups' }), 'wrong kind')
})

test('push: a private group notice with a group, a body or an extra key shows only the fallback sentence', async (t) => {
  const w = renderedWorker()
  const refused = async (payload, label) => {
    const shown = await push(w, pushData(payload))
    t.is(shown.title, 'Varanda', label)
    t.is(shown.options.body, FALLBACK, label)
    t.is(shown.options.tag, 'varanda-generic', label)
    t.alike(plain(shown.options.data), {}, label)
  }
  const priv = { v: 1, kind: 'group-private', g: G }
  await refused({ ...priv, group: GROUP_KEY }, 'with a group')
  await refused({ ...priv, body: 'Segredo' }, 'with a body')
  await refused({ ...priv, body: null }, 'with a null body')
  await refused({ ...priv, group: GROUP_KEY, body: null }, 'with a group and a body')
  await refused({ ...priv, x: 1 }, 'extra key')
  await refused({ v: 1, kind: 'group-private' }, 'missing g')
  await refused({ kind: 'group-private', g: G }, 'missing version')
  await refused({ v: 2, kind: 'group-private', g: G }, 'wrong version')
  await refused({ v: 1, kind: 'group-secret', g: G }, 'unknown kind')
  const times = {
    'g a string': String(G),
    'g zero': 0,
    'g negative': -G,
    'g not an integer': G + 0.5,
    'g past safe integers': Number.MAX_SAFE_INTEGER + 1,
    'g null': null
  }
  for (const [label, g] of Object.entries(times)) await refused({ v: 1, kind: 'group-private', g }, label)
})

// The focused window's hand-off only re-reads the member inbox; a group
// thread is not in it, so a group notice must always show.
test('group notice: shown even with a visible focused app window, which gets no wake', async (t) => {
  const cases = [
    ['public with a name', groupPublic(), 'Nova mensagem em ' + GROUP_NAME, 'varanda-group-' + GROUP_KEY],
    ['public with no name', groupPublic({ body: null }), 'Nova mensagem num grupo', 'varanda-group-' + GROUP_KEY],
    ['private', { v: 1, kind: 'group-private', g: G }, 'Nova mensagem num grupo privado', 'varanda-group-private']
  ]
  for (const [label, payload, body, tag] of cases) {
    const w = renderedWorker()
    const win = activeWindow(ORIGIN + '/')
    const hidden = fakeWindow(ORIGIN + '/')
    w.windows = [hidden, win]
    const shown = await noticeShown(w, payload)
    t.is(shown.length, 1, label + ': shown')
    if (shown[0]) {
      t.is(shown[0].options.tag, tag, label)
      t.is(shown[0].options.body, body, label)
      t.is(shown[0].options.renotify, false, label)
      t.is(shown[0].options.silent, undefined, label + ': not the quiet notice')
    }
    t.is(w.shown.length, 1, label + ': no quiet notice besides it')
    t.alike(win.messages, [], label + ': no wake to the focused window')
    t.alike(hidden.messages, [], label + ': no wake to the other window')
  }
})

test('group notice: shown 1 s after an own send, while a DM wake is still muted', async (t) => {
  const cases = [
    ['public with a name', groupPublic()],
    ['public with no name', groupPublic({ body: null })],
    ['private', { v: 1, kind: 'group-private', g: G }]
  ]
  for (const [label, payload] of cases) {
    const w = renderedWorker()
    w.now = 1000000
    await message(w, { type: 'varanda-dm-sent' }, fakeWindow(ORIGIN + '/'))
    w.now = 1000000 + 1000
    const shown = await noticeShown(w, payload)
    t.is(shown.length, 1, label + ': shown inside the mute window')
    t.alike(await wakeShown(w), [], label + ': the wake itself stays muted')
  }
})

// A group notice opens Conversas, the same screen as a dm notice: groups
// live on that list, and the notification names no group.
test('notificationclick: a group notice focuses the app and opens Conversas', async (t) => {
  for (const kind of ['group', 'group-private']) {
    const w = renderedWorker()
    const mine = fakeWindow(ORIGIN + '/')
    w.windows = [mine]
    t.ok(await click(w, { kind, g: G }), kind + ': closed')
    t.is(mine.focused, 1, kind)
    t.alike(plain(mine.messages), [{ type: 'varanda-group-open' }], kind)
    t.alike(w.opened, [], kind)

    const fresh = renderedWorker()
    t.ok(await click(fresh, { kind, g: G }))
    t.alike(fresh.opened, ['/?aviso=grupo'], kind + ': no window opens the app on Conversas')

    const stuck = renderedWorker()
    const refusing = fakeWindow(ORIGIN + '/')
    refusing.focus = async () => { throw new Error('InvalidAccessError') }
    stuck.windows = [refusing]
    t.ok(await click(stuck, { kind, g: G }))
    t.alike(stuck.opened, ['/?aviso=grupo'], kind + ': a window that refuses focus')
    t.alike(refusing.messages, [], kind)

    // Anything but the shape the worker itself stored is not a group notice.
    t.ok(await click(w, { kind, g: G, group: GROUP_KEY }))
    t.ok(await click(w, { kind, g: G, body: GROUP_NAME }))
    t.ok(await click(w, { kind, group: GROUP_KEY }))
    t.ok(await click(w, { kind, g: '1' }))
    t.ok(await click(w, { kind }))
    t.is(mine.messages.length, 1, kind + ': nothing more posted')
    const bad = renderedWorker()
    await click(bad, { kind, g: G, group: GROUP_KEY })
    await click(bad, { kind, group: GROUP_KEY })
    await click(bad, { kind, g: 0 })
    await click(bad, { kind })
    t.alike(bad.opened, ['/', '/', '/', '/'], kind + ': malformed data opens the root')
  }
})

const SHARE = ORIGIN + '/compartilhar'
const SHARE_PREFIX = ORIGIN + '/__varanda-share/'
const SHARE_META_KEYS = ['at', 'files', 'id', 'text', 'title', 'total', 'url', 'v', 'videos']

const photo = (name, type = 'image/jpeg', bytes = [1, 2, 3]) => new File([Uint8Array.from(bytes)], name, { type })

function shareForm ({ title, text, url, fotos = [] } = {}) {
  const form = new FormData()
  if (title !== undefined) form.append('title', title)
  if (text !== undefined) form.append('text', text)
  if (url !== undefined) form.append('url', url)
  for (const f of fotos) form.append('fotos', f)
  return form
}

// `form` may be an Error, thrown by formData() as on a malformed body.
async function share (w, form, { url = SHARE, method = 'POST' } = {}) {
  let responded = null
  const formData = async () => {
    if (form instanceof Error) throw form
    return form
  }
  w.handlers.fetch({
    request: { url, method, mode: 'navigate', formData },
    respondWith: (p) => { responded = Promise.resolve(p) },
    waitUntil: () => {}
  })
  const res = responded && await responded
  return { responded: responded !== null, res }
}

async function storedShare (w) {
  const cache = w.caches.stores.get('varanda-share')
  const keys = cache ? [...cache.map.keys()].sort() : []
  const metaKey = keys.find((k) => k.endsWith('/meta'))
  const meta = metaKey ? JSON.parse(await (await cache.match(metaKey)).text()) : null
  return { cache, keys, meta }
}

function redirectsHome (t, res, label) {
  t.is(res.status, 303, label + ': 303')
  t.is(res.headers.get('location'), ORIGIN + '/', label + ': to /')
}

// A share the worker could not store lands where the app tells the person.
function redirectsLost (t, res, label) {
  t.is(res.status, 303, label + ': 303')
  t.is(res.headers.get('location'), ORIGIN + '/?compartilhamento=nao-coube', label + ': to the lost notice')
}

test('share target: a share with text and one photo is stored, then redirects to /', async (t) => {
  const w = renderedWorker()
  w.now = 1700000000123
  const { responded, res } = await share(w, shareForm({ text: 'olha isso', fotos: [photo('a.jpg', 'image/jpeg', [9, 8, 7])] }))
  t.ok(responded, 'answered')
  redirectsHome(t, res, 'share')
  t.alike(w.calls, [], 'no network fetch')
  const { cache, keys, meta } = await storedShare(w)
  t.alike(Object.keys(meta).sort(), SHARE_META_KEYS, 'meta keys')
  t.ok(/^[0-9]{13}-[0-9a-f]{32}$/.test(meta.id), 'id is 13 digit ms and 32 hex')
  t.is(meta.id.slice(0, 14), '1700000000123-', 'id starts with the worker clock')
  t.is(meta.v, 1)
  t.is(meta.at, 1700000000123)
  t.is(meta.title, '')
  t.is(meta.text, 'olha isso')
  t.is(meta.url, '')
  t.is(meta.total, 1)
  t.alike(meta.files, [{ n: 0, mime: 'image/jpeg' }])
  t.alike(keys, [SHARE_PREFIX + meta.id + '/0', SHARE_PREFIX + meta.id + '/meta'])
  const file = await cache.match(SHARE_PREFIX + meta.id + '/0')
  t.is(file.headers.get('content-type'), 'image/jpeg')
  t.alike([...new Uint8Array(await file.arrayBuffer())], [9, 8, 7], 'photo bytes')
  const metaRes = await cache.match(SHARE_PREFIX + meta.id + '/meta')
  t.is(metaRes.headers.get('content-type'), 'application/json')
  t.alike([...w.caches.stores.keys()], ['varanda-share'], 'nothing else stored')
})

test('share target: a second share replaces the first', async (t) => {
  const w = renderedWorker()
  w.now = 1700000000000
  await share(w, shareForm({ text: 'primeiro', fotos: [photo('a.png', 'image/png'), photo('b.gif', 'image/gif')] }))
  const first = (await storedShare(w)).meta
  w.now += 1
  const { res } = await share(w, shareForm({ text: 'segundo' }))
  redirectsHome(t, res, 'second')
  const { keys, meta } = await storedShare(w)
  t.not(meta.id, first.id, 'a new id')
  t.is(meta.text, 'segundo')
  t.alike(meta.files, [])
  t.alike(keys, [SHARE_PREFIX + meta.id + '/meta'], 'the older files are gone')
})

test('share target: 11 photos keep the first 10, total 11', async (t) => {
  const w = renderedWorker()
  const fotos = Array.from({ length: 11 }, (_, i) => photo('f' + i + '.webp', 'image/webp', [i]))
  await share(w, shareForm({ fotos }))
  const { cache, keys, meta } = await storedShare(w)
  t.is(meta.total, 11)
  t.alike(meta.files, Array.from({ length: 10 }, (_, n) => ({ n, mime: 'image/webp' })))
  t.is(keys.length, 11, '10 photos and the meta')
  t.alike([...new Uint8Array(await (await cache.match(SHARE_PREFIX + meta.id + '/9')).arrayBuffer())], [9], 'the tenth is the tenth offered')
  t.absent(keys.includes(SHARE_PREFIX + meta.id + '/10'))
})

test('share target: HEIC and oversized files are skipped but counted, a video beside a photo only counted, text entries are not files', async (t) => {
  const w = renderedWorker()
  const form = shareForm({ fotos: [photo('v.mp4', 'video/mp4'), photo('h.heic', 'image/heic'), photo('ok.png', 'image/png', [5]), 'nao sou foto'] })
  await share(w, form)
  const { keys, meta } = await storedShare(w)
  t.is(meta.total, 2, 'two photo entries offered')
  t.is(meta.videos, 1, 'and one video, left out since photos win')
  t.alike(meta.files, [{ n: 0, mime: 'image/png' }], 'only the png, numbered from 0')
  t.alike(keys, [SHARE_PREFIX + meta.id + '/0', SHARE_PREFIX + meta.id + '/meta'])

  const big = renderedWorker()
  const huge = { type: 'image/png', size: 50 * 1024 * 1024 + 1 }
  const exact = photo('ok.gif', 'image/gif', [1])
  const fake = { get: () => null, getAll: (name) => name === 'fotos' ? [huge, exact] : [] }
  await share(big, fake)
  const stored = await storedShare(big)
  t.is(stored.meta.total, 2)
  t.alike(stored.meta.files, [{ n: 0, mime: 'image/gif' }], 'over 50 MiB skipped')

  const none = renderedWorker()
  const { res } = await share(none, shareForm({ text: '   ', fotos: [photo('h.heic', 'image/heic')] }))
  redirectsHome(t, res, 'nothing kept')
  t.alike((await storedShare(none)).keys, [], 'blank text and no kept photo store nothing')

  const counted = renderedWorker()
  await share(counted, shareForm({ text: '   ', fotos: [photo('v.webm', 'video/webm')] }))
  const left = await storedShare(counted)
  t.alike([left.meta.videos, left.meta.files], [1, []], 'a video that cannot be kept is stored as a count, so the app says so')
  t.alike(left.keys, [SHARE_PREFIX + left.meta.id + '/meta'])
})

// The browser composer takes an MP4 as it is (src/media/videoPrep.web.js), so
// that is the one video kept; any other is counted, and the app says why.
test('share target: the first MP4 alone is kept, other videos are only counted', async (t) => {
  const w = renderedWorker()
  await share(w, shareForm({ fotos: [photo('a.mov', 'video/quicktime'), photo('b.mp4', 'video/mp4', [7, 8]), photo('c.mp4', 'video/mp4', [9])] }))
  const { cache, keys, meta } = await storedShare(w)
  t.is(meta.total, 0, 'no photo offered')
  t.is(meta.videos, 3)
  t.alike(meta.files, [{ n: 0, mime: 'video/mp4' }], 'only the first MP4')
  t.alike(keys, [SHARE_PREFIX + meta.id + '/0', SHARE_PREFIX + meta.id + '/meta'])
  const file = await cache.match(SHARE_PREFIX + meta.id + '/0')
  t.is(file.headers.get('content-type'), 'video/mp4')
  t.alike([...new Uint8Array(await file.arrayBuffer())], [7, 8], 'its own bytes')

  const big = renderedWorker()
  const huge = { type: 'video/mp4', size: 50 * 1024 * 1024 + 1 }
  const fake = { get: (name) => name === 'text' ? 'oi' : null, getAll: (name) => name === 'fotos' ? [huge] : [] }
  await share(big, fake)
  const stored = await storedShare(big)
  t.is(stored.meta.videos, 1, 'over 50 MiB counted')
  t.alike(stored.meta.files, [], 'and not kept')
})

test('share target: title, text and url are stored separately and cut to 4000 units', async (t) => {
  const w = renderedWorker()
  await share(w, shareForm({ title: 'Um título', text: 'a'.repeat(5000), url: 'https://exemplo.test/x' }))
  const { meta } = await storedShare(w)
  t.is(meta.title, 'Um título')
  t.is(meta.text, 'a'.repeat(4000))
  t.is(meta.url, 'https://exemplo.test/x')
  t.is(meta.total, 0)

  const link = renderedWorker()
  await share(link, shareForm({ url: 'https://exemplo.test/y' }))
  t.is((await storedShare(link)).meta.url, 'https://exemplo.test/y', 'a link alone is kept')

  const titled = renderedWorker()
  await share(titled, shareForm({ title: 'só título' }))
  t.is((await storedShare(titled)).meta.title, 'só título', 'a title alone is kept, as on Android and iOS')

  const blank = renderedWorker()
  await share(blank, shareForm({ title: ' ', text: '\n', url: '' }))
  t.alike((await storedShare(blank)).keys, [], 'only blank fields store nothing')
})

test('share target: a failing formData still redirects and stores nothing', async (t) => {
  const w = renderedWorker()
  const { responded, res } = await share(w, new TypeError('bad multipart'))
  t.ok(responded)
  redirectsHome(t, res, 'failure')
  t.alike((await storedShare(w)).keys, [])
})

test('share target: a store failing half way leaves nothing and redirects to the lost notice', async (t) => {
  const w = renderedWorker()
  const open = w.caches.open
  w.caches.open = async (name) => {
    const cache = await open(name)
    if (name === 'varanda-share') {
      const put = cache.put.bind(cache)
      cache.put = async (k, r) => {
        if (k.endsWith('/1')) throw new Error('QuotaExceededError')
        return put(k, r)
      }
    }
    return cache
  }
  const { res } = await share(w, shareForm({ fotos: [photo('a.jpg'), photo('b.jpg')] }))
  redirectsLost(t, res, 'quota')
  t.alike((await storedShare(w)).keys, [], 'the first photo is dropped')
})

test('share target: other POSTs are never answered', async (t) => {
  const w = renderedWorker()
  for (const url of [ORIGIN + '/account/x', ORIGIN + '/other', ORIGIN + '/seeder/x', ORIGIN + '/f/x', ORIGIN + '/p/x', ORIGIN + '/compartilhar/', 'https://other.test/compartilhar']) {
    t.absent((await share(w, shareForm({ text: 'x' }), { url })).responded, url)
  }
  t.absent((await share(w, shareForm({ text: 'x' }), { method: 'PUT' })).responded, 'PUT /compartilhar')
  t.ok((await share(w, shareForm({ text: 'x' }), { url: SHARE + '?x=1' })).responded, 'a query string is the same path')
})

test('share target: the share survives an activate', async (t) => {
  const { w } = await installed()
  await share(w, shareForm({ text: 'guardado' }))
  await w.caches.open('varanda-shell-old')
  await lifecycle(w, 'activate')
  t.ok(w.caches.stores.has('varanda-share'), 'activate keeps the share cache')
  t.is((await storedShare(w)).meta.text, 'guardado')
})

// Wraps the share cache so a test can fail a put or watch the deletes.
function watchShareCache (w, { failPut = () => false, failDelete = () => false } = {}) {
  const deleted = []
  const open = w.caches.open
  w.caches.open = async (name) => {
    const cache = await open(name)
    if (name === 'varanda-share' && !cache.watched) {
      cache.watched = true
      const put = cache.put.bind(cache)
      const del = cache.delete.bind(cache)
      cache.put = async (k, r) => {
        if (failPut(k)) throw new Error('QuotaExceededError')
        return put(k, r)
      }
      cache.delete = async (k) => {
        const url = typeof k === 'string' ? k : k.url
        deleted.push(url)
        if (failDelete(url)) throw new Error('delete failed')
        return del(k)
      }
    }
    return cache
  }
  return deleted
}

test('share target: a replacement that fails keeps the saved share whole', async (t) => {
  const w = renderedWorker()
  w.now = 1700000000000
  await share(w, shareForm({ text: 'primeiro', fotos: [photo('a.png', 'image/png', [4])] }))
  const before = await storedShare(w)
  let failing = false
  watchShareCache(w, { failPut: (k) => failing && k.endsWith('/1') })
  failing = true
  w.now += 1
  const { res } = await share(w, shareForm({ text: 'segundo', fotos: [photo('b.png', 'image/png'), photo('c.png', 'image/png')] }))
  redirectsLost(t, res, 'failed replacement')
  const after = await storedShare(w)
  t.alike(after.keys, before.keys, 'only the first share is left')
  t.alike(after.meta, before.meta, 'its meta is unchanged')
  const file = await after.cache.match(SHARE_PREFIX + before.meta.id + '/0')
  t.alike([...new Uint8Array(await file.arrayBuffer())], [4], 'its photo is still readable')
})

test('share target: cleanup drops the older meta before its files, and junk keys', async (t) => {
  const w = renderedWorker()
  w.now = 1700000000000
  await share(w, shareForm({ text: 'primeiro', fotos: [photo('a.png', 'image/png'), photo('b.png', 'image/png')] }))
  const first = (await storedShare(w)).meta
  const junk = ORIGIN + '/__varanda-share/lixo'
  await (await w.caches.open('varanda-share')).put(junk, new Response('x'))
  const deleted = watchShareCache(w)
  w.now += 1
  await share(w, shareForm({ text: 'segundo' }))
  const { keys, meta } = await storedShare(w)
  t.is(meta.text, 'segundo')
  t.alike(keys, [SHARE_PREFIX + meta.id + '/meta'], 'only the new share is left')
  const old = SHARE_PREFIX + first.id
  t.alike(deleted.filter((k) => k.startsWith(old)), [old + '/meta', old + '/0', old + '/1'], 'the older meta goes before its files')
  t.ok(deleted.includes(junk), 'the junk key is deleted')
})

test('share target: an earlier request that parses last never replaces a newer share', async (t) => {
  const w = renderedWorker()
  let release
  const slowForm = new Promise((resolve) => { release = resolve })
  const answers = []
  const fire = (formData) => {
    w.handlers.fetch({
      request: { url: SHARE, method: 'POST', mode: 'navigate', formData },
      respondWith: (p) => { answers.push(Promise.resolve(p)) },
      waitUntil: () => {}
    })
  }
  w.now = 1700000000000
  fire(() => slowForm)
  w.now = 1700000000500
  fire(async () => shareForm({ text: 'mais nova' }))
  redirectsHome(t, await answers[1], 'newer')
  release(shareForm({ text: 'mais velha', fotos: [photo('a.jpg')] }))
  redirectsHome(t, await answers[0], 'older')
  const { keys, meta } = await storedShare(w)
  t.is(meta.text, 'mais nova', 'the newer share is the one stored')
  t.is(meta.at, 1700000000500)
  t.alike(keys, [SHARE_PREFIX + meta.id + '/meta'], 'nothing of the older one')
})

test('share target: an older share whose meta cannot be deleted keeps its photos', async (t) => {
  const w = renderedWorker()
  w.now = 1700000000000
  await share(w, shareForm({ text: 'primeiro', fotos: [photo('a.png', 'image/png', [6])] }))
  const first = (await storedShare(w)).meta
  const old = SHARE_PREFIX + first.id
  watchShareCache(w, { failDelete: (k) => k === old + '/meta' })
  w.now += 1
  const { res } = await share(w, shareForm({ text: 'segundo' }))
  redirectsHome(t, res, 'stuck cleanup')
  const { cache, keys } = await storedShare(w)
  t.ok(keys.includes(old + '/meta'), 'the older meta is still there')
  const file = await cache.match(old + '/0')
  t.ok(file, 'so its photo is kept too')
  t.alike(file ? [...new Uint8Array(await file.arrayBuffer())] : [], [6], 'and readable')
})

test('share target: an earlier request never lands after a newer share was stored and released', async (t) => {
  const w = renderedWorker()
  let release
  const slowForm = new Promise((resolve) => { release = resolve })
  const answers = []
  const fire = (formData) => {
    w.handlers.fetch({
      request: { url: SHARE, method: 'POST', mode: 'navigate', formData },
      respondWith: (p) => { answers.push(Promise.resolve(p)) },
      waitUntil: () => {}
    })
  }
  w.now = 1700000000000
  fire(() => slowForm)
  w.now = 1700000000500
  fire(async () => shareForm({ text: 'mais nova' }))
  redirectsHome(t, await answers[1], 'newer')
  const cache = await w.caches.open('varanda-share')
  for (const key of [...cache.map.keys()]) await cache.delete(key)
  release(shareForm({ text: 'mais velha', fotos: [photo('a.jpg')] }))
  redirectsHome(t, await answers[0], 'older')
  t.alike((await storedShare(w)).keys, [], 'the superseded share is not stored')
})
