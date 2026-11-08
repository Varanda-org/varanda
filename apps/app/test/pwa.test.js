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
  t.is(manifest.theme_color, '#1c2622', 'theme_color is the dark bg')
  const tabBar = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'TabBar.js'), 'utf8')
  t.ok(tabBar.includes("const alwaysDark = Platform.OS === 'web'"), 'the tab bar is always dark on the web')
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
  const block = html.slice(start, html.indexOf('</div>', start))
  t.ok(block.includes('<svg'), 'chair svg')
  t.ok(block.includes('viewBox="0 0 256 256"'), 'chair viewBox')
  for (const fill of ['#2a7fb8', '#e8805a', '#f2b705', '#e94e3c', '#1d6b4f', '#a7382b', '#ae8303']) {
    t.ok(block.includes(fill), fill)
  }
  t.is((block.match(/<path/g) || []).length, 21, '21 chair paths')
  t.absent(/href|<text|<filter|<img|<iframe|<object|<embed|<script/i.test(block), 'no external or forbidden markup in the splash')
  t.absent(block.includes('conectando'), 'no connecting text')
  t.ok(html.includes('<div class="bar" aria-hidden="true"><span></span></div>\n    </div>'), 'progress bar, last in the splash')
  t.ok(html.includes('width: calc(var(--varanda-progress, 0.1) * 100%)'), 'the bar fill follows the app')
  const letters = ['V', 'a', 'r', 'a', 'n', 'd', 'a']
  const spans = letters.map((letter, i) => '<span style="--i:' + i + '">' + letter + '</span>').join('')
  t.ok(block.includes(spans), 'Varanda letter spans in order')
  t.ok(html.includes('<meta name="color-scheme" content="light dark" />'), 'color-scheme meta')
  t.ok(html.includes('<meta name="theme-color" content="#fbf8f3" />'), 'light theme-color meta')
  t.ok(html.includes('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c2622" />'), 'dark theme-color meta')
  // Browsers take the first matching theme-color: the unscoped light one
  // would always win if it came first.
  t.ok(html.indexOf('media="(prefers-color-scheme: dark)" content="#1c2622"') < html.indexOf('<meta name="theme-color" content="#fbf8f3" />'), 'dark theme-color comes first')
  t.ok(html.includes('html[data-scheme=light] #varanda-pre-splash { background: #fbf8f3; }'), 'manual Claro repaints the overlay')
  t.ok(html.includes('html[data-scheme=dark] #varanda-pre-splash { background: #1c2622; }'), 'manual Escuro repaints the overlay')
  const dark = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n {6}\}/.exec(html)
  t.ok(dark, 'dark media query exists')
  t.ok(dark && dark[1].includes('#varanda-pre-splash { background: #1c2622; }'), 'dark pre-splash background')
  t.ok(dark && /\.chair \{[^}]*background: #fbf8f3/.test(dark[1]), 'chair keeps a cream pad in dark')
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
  // Besides the shell, the only cache entries are the DM wake mute record and
  // the block list: values the worker writes itself, never a network response,
  // never served.
  t.is(sw.split('cache.put(').length - 1, 3, 'three cache.put: precache, the DM mute record and the block list (no runtime caching)')
  t.is(sw.split('cache.put(DM_STATE_KEY, ').length - 1, 1, 'the second writes only the DM mute record')
  t.is(sw.split('cache.put(BLOCK_STATE_KEY, ').length - 1, 1, 'the third writes only the block list')
  t.ok(sw.includes('async function verifiedMatch ('), 'cached responses are re-verified')
  t.is(sw.split('.match(').length - 1, 3, 'three cache reads: verifiedMatch, the DM mute record and the block list')
  t.is(sw.split('cache.match(DM_STATE_KEY)').length - 1, 1, 'the second reads only the DM mute record')
  t.is(sw.split('cache.match(BLOCK_STATE_KEY)').length - 1, 1, 'the third reads only the block list')
  t.ok(sw.includes("new Response(buf, { status: 200, statusText: 'OK', headers })"), 'a cache hit is rebuilt, never returned as stored')
  t.absent(/<script/i.test(html), 'index.html still has no script tag')
})
