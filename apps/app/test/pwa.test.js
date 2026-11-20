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
  // The installed app's system navigation bar takes this one colour; on the
  // web the tab bar above it is the same opaque dark bg in both schemes.
  t.is(manifest.theme_color, '#101010', 'theme_color is the dark bg')
  const tabBar = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'TabBar.js'), 'utf8')
  t.ok(!/alwaysDark|Platform|useTheme|useStyles/.test(tabBar) && tabBar.includes('const colors = DARK'), 'the tab bar stays dark on every platform and scheme')
  t.ok(tabBar.includes('makeStyles({ ...DARK, tabBar: DARK.bg })'), 'the web tab bar is opaque dark bg, not the translucent tabBar')
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
  // CSP script-src 'self': only same-origin files, never inline code.
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  t.is(scripts.length, (html.match(/<script/gi) || []).length, 'every script tag is closed')
  for (const [, attrs, body] of scripts) {
    t.ok(/^ src="\/[\w-]+\.js"$/.test(attrs), 'same-origin src only: ' + attrs)
    t.is(body, '', 'no inline code')
  }
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
  const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)
  t.ok(viewport, 'viewport meta exists')
  t.ok(viewport[1].includes('viewport-fit=cover'), 'viewport-fit=cover so iOS reports the home-indicator inset')
  t.ok(viewport[1].includes('width=device-width'), 'width=device-width')
  t.ok(viewport[1].includes('initial-scale=1'), 'initial-scale=1')
  t.ok(viewport[1].includes('shrink-to-fit=no'), 'shrink-to-fit=no')
  t.absent(viewport[1].includes('user-scalable'), 'no user-scalable (pinch zoom stays on)')
  t.absent(viewport[1].includes('maximum-scale'), 'no maximum-scale (pinch zoom stays on)')
  const reset = /<style id="expo-reset">([\s\S]*?)<\/style>/.exec(html)
  t.ok(reset, 'expo-reset style exists')
  t.ok(reset[1].includes('background-color: #fbf8f3'), 'expo-reset paints the app background')
  t.absent(html.includes('varanda-release'), 'the release meta is added to dist only')
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'))
  t.is(app.expo.web.lang, 'pt-BR')
})

test('index.html paints the brand before the bundle runs', (t) => {
  t.ok(/<div id="root"><\/div>\s*<div id="varanda-pre-splash" role="status" aria-label="Varanda, carregando">/.test(html), 'splash follows the empty root')
  const start = html.indexOf('<div id="varanda-pre-splash"')
  const tail = '<div class="bar" aria-hidden="true"><span></span></div>\n    </div>'
  const block = html.slice(start, html.indexOf(tail, start) + tail.length)
  t.ok(block.includes('<svg'), 'chair svg')
  t.ok(block.includes('viewBox="0 0 256 256"'), 'chair viewBox')
  for (const fill of ['#2a7fb8', '#e8805a', '#f2b705', '#e94e3c', '#1d6b4f', '#a7382b', '#ae8303']) {
    t.ok(block.includes(fill), fill)
  }
  const chair = /<svg class="chair"[\s\S]*?<\/svg>/.exec(block)
  t.ok(chair, 'chair svg element')
  t.is(((chair && chair[0]).match(/<path/g) || []).length, 21, '21 chair paths')
  t.absent(/href|<text|<filter|<img|<iframe|<object|<embed|<script/i.test(block), 'no external or forbidden markup in the splash')
  t.absent(block.includes('conectando'), 'no connecting text')
  t.absent(/<use|data:/.test(block), 'no <use> or data: URL in the splash')
  t.absent(/#cde6f1|f-asa/.test(block), 'no flat blue sky or blue butterfly wing')
  t.ok(/\.ceu \{[^}]*linear-gradient\(/.test(html), 'the sky band is the sunset gradient')
  t.ok(html.includes('<div class="bar" aria-hidden="true"><span></span></div>\n    </div>'), 'progress bar, last in the splash')
  t.ok(html.includes('width: calc(var(--varanda-progress, 0.1) * 100%)'), 'the bar fill follows the app')
  // The word is the logo's hand lettering: one svg per letter, in order.
  const word = /<div class="word" aria-hidden="true">([\s\S]*?)<\/div>/.exec(block)
  t.ok(word, 'word div')
  const svgs = [...((word && word[1]) || '').matchAll(/<svg style="--i:(\d+)"[^>]*>([\s\S]*?)<\/svg>/g)]
  t.alike(svgs.map((s) => Number(s[1])), [0, 1, 2, 3, 4, 5, 6], 'seven letter svgs in order')
  for (const s of svgs) t.is((s[2].match(/<path/g) || []).length, 1, 'letter ' + s[1] + ' has one path')
  t.ok(html.includes('<meta name="color-scheme" content="light dark" />'), 'color-scheme meta')
  t.ok(html.includes('<meta name="theme-color" content="#fbf8f3" />'), 'light theme-color meta')
  t.ok(html.includes('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101010" />'), 'dark theme-color meta')
  // Browsers take the first matching theme-color: the unscoped light one
  // would always win if it came first.
  t.ok(html.indexOf('media="(prefers-color-scheme: dark)" content="#101010"') < html.indexOf('<meta name="theme-color" content="#fbf8f3" />'), 'dark theme-color comes first')
  t.ok(html.includes('html[data-scheme=light] #varanda-pre-splash { background: #fbf8f3; }'), 'manual Claro repaints the overlay')
  t.ok(html.includes('html[data-scheme=dark] #varanda-pre-splash { background: #101010; }'), 'manual Escuro repaints the overlay')
  const dark = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n {6}\}/.exec(html)
  t.ok(dark, 'dark media query exists')
  t.ok(dark && dark[1].includes('#varanda-pre-splash { background: #101010; }'), 'dark pre-splash background')
  t.absent(/\.chair \{[^}]*(background|padding)/.test(html), 'no cream pad rule on the chair')
  t.ok(dark && dark[1].includes('--vps-parede: #f3ede2;'), 'the parede stays cream in dark')
  t.ok(html.includes('prefers-reduced-motion: no-preference'), 'motion lives in the no-preference query')
  t.ok(html.includes('pointer-events: none'), 'splash does not eat taps')
  t.ok(html.includes('visibility: hidden'), 'expiry keyframe')
  t.ok(/<noscript><style>#varanda-pre-splash \{ display: none; }<\/style><\/noscript>/.test(html), 'noscript hides the splash')
  const reset = /<style id="expo-reset">([\s\S]*?)<\/style>/.exec(html)
  t.ok(reset && reset[1].includes('#root {'), 'expo-reset still has #root')
  t.ok(reset && reset[1].includes('display: flex'), 'expo-reset still has display flex')
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
  // Besides the shell, the only cache entries are the DM wake mute record, the
  // block list and a received share: values the worker writes itself, never a
  // network response, never served.
  t.is(sw.split('cache.put(').length - 1, 5, 'five cache.put: precache, the DM mute record, the block list and a share (files, then meta) (no runtime caching)')
  t.is(sw.split('cache.put(DM_STATE_KEY, ').length - 1, 1, 'the second writes only the DM mute record')
  t.is(sw.split('cache.put(BLOCK_STATE_KEY, ').length - 1, 1, 'the third writes only the block list')
  t.is(sw.split('cache.put(abs(SHARE_KEY_PREFIX + share.id + ').length - 1, 2, 'the last two write only the shared files and their meta')
  t.ok(sw.includes('async function verifiedMatch ('), 'cached responses are re-verified')
  t.is(sw.split('.match(').length - 1, 3, 'three cache reads: verifiedMatch, the DM mute record and the block list')
  t.is(sw.split('cache.match(DM_STATE_KEY)').length - 1, 1, 'the second reads only the DM mute record')
  t.is(sw.split('cache.match(BLOCK_STATE_KEY)').length - 1, 1, 'the third reads only the block list')
  t.ok(sw.includes("new Response(buf, { status: 200, statusText: 'OK', headers })"), 'a cache hit is rebuilt, never returned as stored')
  t.absent(/<script(?! src="\/[\w-]+\.js"><\/script>)/i.test(html), 'index.html still has no inline script')
})

test('round 8: html and body never pan or bounce after a screen push', (t) => {
  t.ok(/html,\s*body \{\s*overflow: hidden;/.test(html), 'html is clipped too')
  t.ok(/html,\s*body \{\s*overscroll-behavior: none;/.test(html), 'no overscroll on either axis')
})

// The installed PWA joins the Android share sheet through this target.
// encodeFile refuses every other type before decoding, and the web picker
// offers the same four, so a video type or image/* would list Varanda for a
// share it cannot post.
test('manifest share_target receives photos, GIFs, one MP4 video, text and links', (t) => {
  const share = manifest.share_target
  t.alike(share, {
    action: '/compartilhar',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      title: 'title',
      text: 'text',
      url: 'url',
      files: [
        { name: 'fotos', accept: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'] }
      ]
    }
  })
  const files = share && share.params && Array.isArray(share.params.files) ? share.params.files : []
  const accepted = []
  for (const file of files) {
    const accept = file && file.accept
    if (Array.isArray(accept)) accepted.push(...accept)
    else if (accept != null) accepted.push(accept)
  }
  t.ok(accepted.length > 0, 'at least one accepted file type')
  t.alike(accepted.filter((mime) => String(mime).startsWith('video/')), ['video/mp4'], 'MP4 the only video, the one the browser composer takes as it is')
  for (const mime of accepted) {
    t.absent(mime === 'image/*' || mime === 'video/*', mime)
  }
})

// src/pwa.native.js: the Android store notice wiring. Its native imports sit
// in a guarded require, which an ES module resolves through globalThis.
const ORIGIN = 'https://bora.example'
const STORE_FILE = ORIGIN + '/.well-known/app-release.json'
let nativeNonce = 0

function storeAnswer (build) {
  const text = JSON.stringify({ v: 1, android: { build } })
  return {
    status: 200,
    url: STORE_FILE,
    redirected: false,
    headers: { get: (name) => ({ 'content-type': 'application/json', 'content-length': String(text.length) })[name.toLowerCase()] ?? null },
    text: async () => text
  }
}

async function loadNative ({ build, served = 6 }) {
  const appState = new Set()
  const opened = []
  const fetches = []
  const fake = (name) => {
    if (name === 'react-native') {
      return {
        AppState: {
          addEventListener (type, fn) {
            const entry = { type, fn }
            appState.add(entry)
            return { remove: () => appState.delete(entry) }
          }
        }
      }
    }
    if (name === './openExternal') return { openExternal: (url) => opened.push(url) }
    if (name === '../modules/app-build') return { appBuild: () => build }
    throw new Error('unexpected ' + name)
  }
  const had = Object.hasOwn(globalThis, 'require')
  const previous = globalThis.require
  globalThis.require = fake
  let mod
  try {
    mod = await import('../src/pwa.native.js?n=' + (++nativeNonce))
  } finally {
    if (had) globalThis.require = previous
    else delete globalThis.require
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => {
    fetches.push({ url, opts })
    return Promise.resolve(storeAnswer(served))
  }
  const restore = () => { globalThis.fetch = realFetch }
  const emit = (state) => { for (const entry of [...appState]) if (entry.type === 'change') entry.fn(state) }
  const foreground = () => emit('active')
  return { mod, appState, opened, fetches, emit, foreground, restore }
}

// React's effect rule for App.js's watcher: rerun only when a dep changes.
function appEffect (watchRelease, onChange) {
  let deps
  let stop = null
  return {
    render (origin) {
      if (stop !== null && Object.is(origin, deps)) return
      if (stop !== null) stop()
      deps = origin
      stop = watchRelease(onChange)
    },
    unmount () { if (stop !== null) stop() }
  }
}

const settleAll = () => new Promise((resolve) => setImmediate(resolve))

test('pwa.native: an installation that loads after the watcher starts is checked once, without a foreground event', async (t) => {
  const installation = await import('../src/installation.js')
  installation.setInstallation(null)
  const n = await loadNative({ build: { versionCode: 5, fromPlay: true } })
  t.teardown(() => { n.restore(); installation.setInstallation(null) })
  const states = []
  const effect = appEffect(n.mod.watchRelease, (s) => states.push(s.update))
  effect.render(installation.installationOrigin())
  await settleAll()
  t.is(n.fetches.length, 0, 'no request before the installation loads')
  t.ok(installation.setInstallation(ORIGIN))
  effect.render(installation.installationOrigin())
  effect.render(installation.installationOrigin())
  await settleAll()
  t.is(n.fetches.length, 1, 'exactly one check')
  t.is(n.fetches[0].url, STORE_FILE)
  t.alike(states, [true])
  effect.unmount()
  t.is(n.appState.size, 0, 'the AppState listener is removed on unmount')
})

test('pwa.native: AppState active rechecks after the cooldown only', async (t) => {
  const installation = await import('../src/installation.js')
  installation.setInstallation(ORIGIN)
  const n = await loadNative({ build: { versionCode: 5, fromPlay: true }, served: 5 })
  t.teardown(() => { n.restore(); installation.setInstallation(null) })
  const states = []
  const stop = n.mod.watchRelease((s) => states.push(s.update))
  await settleAll()
  t.is(n.fetches.length, 1)
  t.alike(states, [false], 'equal build: no notice')
  n.foreground()
  await settleAll()
  t.is(n.fetches.length, 1, 'a return inside the cooldown makes no request')
  stop()
  t.is(n.appState.size, 0)
})

test('pwa.native: only a return to active checks, after the cooldown', async (t) => {
  const installation = await import('../src/installation.js')
  installation.setInstallation(ORIGIN)
  const n = await loadNative({ build: { versionCode: 5, fromPlay: true } })
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  t.teardown(() => { Date.now = realNow; n.restore(); installation.setInstallation(null) })
  const stop = n.mod.watchRelease(() => {})
  await settleAll()
  t.is(n.fetches.length, 1)
  now += 120000
  n.emit('background')
  n.emit('inactive')
  await settleAll()
  t.is(n.fetches.length, 1, 'background and inactive make no request')
  n.foreground()
  await settleAll()
  t.is(n.fetches.length, 2, 'active after the cooldown checks again')
  stop()
})

test('pwa.native: no request on a sideloaded build, iOS or without the module', async (t) => {
  const installation = await import('../src/installation.js')
  installation.setInstallation(ORIGIN)
  t.teardown(() => installation.setInstallation(null))
  for (const build of [{ versionCode: 1, fromPlay: false }, null]) {
    const n = await loadNative({ build })
    const stop = n.mod.watchRelease(() => t.fail('no notice'))
    n.foreground()
    await settleAll()
    n.restore()
    t.is(n.fetches.length, 0, 'no request for ' + JSON.stringify(build))
    t.is(n.appState.size, 0, 'no listener')
    stop()
  }
  const plain = await import('../src/pwa.native.js')
  const stop = plain.watchRelease(() => t.fail('no notice'))
  stop()
  t.execution(() => plain.applyUpdate(), 'without React Native, applyUpdate does nothing')
})

test('pwa.native: applyUpdate opens the fixed Play listing', async (t) => {
  const n = await loadNative({ build: { versionCode: 5, fromPlay: true } })
  n.restore()
  n.mod.applyUpdate()
  t.alike(n.opened, ['https://play.google.com/store/apps/details?id=app.varanda'])
})

test('App.js: the notice button and the watcher go through src/pwa', (t) => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  t.ok(app.includes("import { applyUpdate, watchRelease } from './src/pwa'\n"))
  t.ok(app.includes('<UpdateNote onUpdate={applyUpdate} '), 'the button calls applyUpdate')
  t.absent(app.includes('window.location.reload'), 'no platform check in App.js')
  // The installation loads after the first render: the watcher restarts once
  // it is known, and again when it changes.
  t.ok(app.includes('    const stop = watchRelease((s) => setUpdateReady(s.update))\n    return () => stop()\n  }, [installationOrigin()])\n'))
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'pwa.web.js'), 'utf8')
  t.ok(web.includes('export function applyUpdate () {\n  try { window.location.reload() } catch {}\n}'), 'the web keeps its reload')
})
