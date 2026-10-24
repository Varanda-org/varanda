'use strict'

// The installable web build: public/manifest.webmanifest, its icons, and the
// public/index.html that replaces Expo's default template.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const PUBLIC = path.join(__dirname, '..', 'public')
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'))
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')

function pngSize (file) {
  const buf = fs.readFileSync(file)
  if (buf.subarray(1, 4).toString() !== 'PNG') throw new Error(file + ' is not a PNG')
  return buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20)
}

test('manifest has the members an installable app needs', (t) => {
  t.ok(manifest.name)
  t.ok(manifest.short_name)
  t.is(manifest.start_url, '/')
  t.is(manifest.display, 'standalone')
  t.ok(manifest.background_color)
  t.ok(manifest.theme_color)
  const icon = (size, purpose) => manifest.icons.find((i) => i.sizes === size && i.purpose === purpose)
  t.ok(icon('192x192', 'any'), '192 any icon')
  t.ok(icon('512x512', 'any'), '512 any icon')
  t.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'a maskable icon')
})

test('every manifest icon exists and has the declared size', (t) => {
  for (const i of manifest.icons) {
    const file = path.join(PUBLIC, i.src.replace(/^\//, ''))
    t.ok(fs.existsSync(file), i.src + ' exists')
    t.is(i.type, 'image/png')
    t.is(pngSize(file), i.sizes, i.src + ' size')
  }
})

test('index.html links the manifest and keeps the Expo template', (t) => {
  t.ok(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(html), 'manifest link')
  t.ok(fs.existsSync(path.join(PUBLIC, 'apple-touch-icon.png')))
  t.is(pngSize(path.join(PUBLIC, 'apple-touch-icon.png')), '180x180')
  t.absent(/<script/i.test(html), 'no script tag (CSP script-src self)')
  t.ok(html.includes('%LANG_ISO_CODE%'))
  t.ok(html.includes('%WEB_TITLE%'))
  t.ok(html.includes('<div id="root"></div>'))
})

test('index.html carries the install metas in pt-BR', (t) => {
  t.ok(html.includes('<meta name="mobile-web-app-capable" content="yes" />'))
  t.ok(html.includes('<meta name="apple-mobile-web-app-capable" content="yes" />'))
  t.ok(html.includes('<meta name="apple-mobile-web-app-status-bar-style" content="default" />'))
  t.ok(html.includes('<meta name="apple-mobile-web-app-title" content="Varanda" />'))
  t.ok(html.includes('Ative o JavaScript para usar o Varanda.'))
  t.absent(html.includes('varanda-release'), 'the release meta is added to dist only')
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'))
  t.is(app.expo.web.lang, 'pt-BR')
})

test('the service worker is a template outside public/', (t) => {
  t.absent(fs.existsSync(path.join(PUBLIC, 'sw.js')), 'no public/sw.js (the dev server would serve it)')
  const sw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sw.js'), 'utf8')
  for (const s of ['__VARANDA_VERSION__', '__VARANDA_PRECACHE__', 'varanda-shell-', 'install', 'activate', 'fetch']) {
    t.ok(sw.includes(s), 'has ' + s)
  }
  for (const s of ['skipWaiting', 'clients.claim', 'cache.addAll', 'importScripts', 'eval(', 'RUNTIME_PREFIXES']) {
    t.absent(sw.includes(s), 'no ' + s)
  }
  t.is(sw.split('cache.put(').length - 1, 1, 'a single cache.put, inside precache (no runtime caching)')
  t.ok(sw.includes('async function verifiedMatch ('), 'cached responses are re-verified')
  t.is(sw.split('.match(').length - 1, 1, 'a single cache read, inside verifiedMatch')
  t.ok(sw.includes("new Response(buf, { status: 200, statusText: 'OK', headers })"), 'a cache hit is rebuilt, never returned as stored')
  t.absent(/<script/i.test(html), 'index.html still has no script tag')
})
