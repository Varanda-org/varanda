'use strict'

const test = require('brittle')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..', '..')
const LOGO = path.join(ROOT, 'apps', 'site', 'artwork', 'logo')
const APP = path.join(ROOT, 'apps', 'app')
const RES = path.join(APP, 'android', 'app', 'src', 'main', 'res')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BACKGROUND = '#fbf8f3'

const text = (file) => fs.readFileSync(file, 'utf8')

// The signature, then the IHDR chunk: width at 16, height at 20, colour type at 25.
function ihdr (buf) {
  if (buf.length < 26 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] }
}

test('asset-manifest.json matches the files on disk', (t) => {
  const manifest = JSON.parse(text(path.join(LOGO, 'asset-manifest.json')))
  t.ok(manifest.outputs.length > 0, 'outputs listed (' + manifest.outputs.length + ')')
  for (const o of manifest.outputs) {
    const file = path.join(ROOT, o.path)
    const exists = fs.existsSync(file)
    t.ok(exists, 'exists: ' + o.path)
    if (!exists) continue
    const buf = fs.readFileSync(file)
    t.is(buf.length, o.bytes, 'bytes: ' + o.path)
    t.is(crypto.createHash('sha256').update(buf).digest('hex'), o.sha256, 'sha256: ' + o.path)
    if (/\.(png|webp)$/.test(o.path) && o.width) {
      const h = ihdr(buf)
      t.ok(h, 'PNG header: ' + o.path)
      if (h) t.alike({ width: h.width, height: h.height }, { width: o.width, height: o.height }, 'size: ' + o.path)
    }
  }
})

test('Google Play art: feature graphic is 1024x500 RGB, icon is 512x512 RGBA', (t) => {
  const play = path.join(ROOT, 'apps', 'site', 'artwork', 'play')
  const graphic = ihdr(fs.readFileSync(path.join(play, 'feature-graphic-1024x500.png')))
  t.ok(graphic, 'feature graphic PNG header')
  if (graphic) t.alike(graphic, { width: 1024, height: 500, colorType: 2 }, 'feature graphic 1024x500, colour type 2 (no alpha)')
  const icon = ihdr(fs.readFileSync(path.join(play, 'icon-512.png')))
  t.ok(icon, 'icon PNG header')
  if (icon) t.alike(icon, { width: 512, height: 512, colorType: 6 }, 'icon 512x512, colour type 6 (32-bit)')
})

test('icons are opaque (IHDR colour type 2, RGB without alpha)', (t) => {
  const icons = [
    path.join(APP, 'ios', 'Varanda', 'Images.xcassets', 'AppIcon.appiconset', 'App-Icon-1024x1024@1x.png'),
    path.join(APP, 'assets', 'icon.png'),
    path.join(ROOT, 'apps', 'site', 'public', 'apple-touch-icon.png')
  ]
  for (const f of icons) {
    const h = ihdr(fs.readFileSync(f))
    t.ok(h, 'PNG header: ' + path.relative(ROOT, f))
    if (h) t.is(h.colorType, 2, 'colour type 2: ' + path.relative(ROOT, f))
  }
})

test('Android mipmap .webp files hold PNG bytes, as Expo writes them', (t) => {
  const dirs = fs.readdirSync(RES).filter((d) => d.startsWith('mipmap-'))
  t.ok(dirs.length > 0, 'mipmap dirs (' + dirs.length + ')')
  for (const d of dirs) {
    for (const name of fs.readdirSync(path.join(RES, d)).filter((n) => n.endsWith('.webp'))) {
      const head = fs.readFileSync(path.join(RES, d, name)).subarray(0, 8)
      t.ok(head.equals(PNG_SIGNATURE), 'PNG signature: ' + d + '/' + name)
    }
  }
})

test('one background colour everywhere', (t) => {
  const app = JSON.parse(text(path.join(APP, 'app.json')))
  t.is(app.expo.splash.backgroundColor.toLowerCase(), BACKGROUND, 'app.json splash')
  t.is(app.expo.android.adaptiveIcon.backgroundColor.toLowerCase(), BACKGROUND, 'app.json adaptive icon')

  const colors = text(path.join(RES, 'values', 'colors.xml'))
  for (const name of ['splashscreen_background', 'iconBackground']) {
    const m = new RegExp('<color name="' + name + '">([^<]+)</color>').exec(colors)
    t.ok(m, 'colors.xml has ' + name)
    if (m) t.is(m[1].trim().toLowerCase(), BACKGROUND, 'colors.xml ' + name)
  }

  const styles = text(path.join(RES, 'values', 'styles.xml'))
  t.ok(/<item name="android:windowSplashScreenBackground">@color\/splashscreen_background<\/item>/.test(styles), 'styles.xml uses @color/splashscreen_background')

  const set = JSON.parse(text(path.join(APP, 'ios', 'Varanda', 'Images.xcassets', 'SplashScreenBackground.colorset', 'Contents.json')))
  const c = set.colors[0].color.components
  const channel = (v) => (/^0x/i.test(String(v)) ? parseInt(v, 16) / 255 : parseFloat(v))
  const want = { red: 0xfb, green: 0xf8, blue: 0xf3 }
  for (const k of Object.keys(want)) {
    t.ok(Math.abs(channel(c[k]) - want[k] / 255) <= 1 / 255, 'colorset ' + k + ' ' + c[k])
  }

  const board = text(path.join(APP, 'ios', 'Varanda', 'SplashScreen.storyboard'))
  const named = /<namedColor name="SplashScreenBackground">\s*<color ([^>]*)\/>/.exec(board)
  t.ok(named, 'storyboard has the SplashScreenBackground named colour')
  for (const k of Object.keys(want)) {
    const m = named && new RegExp('\\s' + k + '="([^"]+)"').exec(named[1])
    t.ok(m && Math.abs(parseFloat(m[1]) - want[k] / 255) <= 1 / 255, 'storyboard ' + k + ' ' + (m && m[1]))
  }
})

test('logo SVGs are self-contained vector art', (t) => {
  const svgs = fs.readdirSync(LOGO).filter((n) => n.endsWith('.svg'))
  t.ok(svgs.length > 0, 'svgs found (' + svgs.length + ')')
  for (const name of svgs) {
    const s = text(path.join(LOGO, name))
    t.ok(/<svg[^>]*\sviewBox="/.test(s), name + ': viewBox')
    for (const bad of ['<text', '<image', 'href', '@import', '<filter', 'gradient']) {
      t.absent(s.toLowerCase().includes(bad), name + ': no ' + bad)
    }
  }
})

test('never "expo prebuild": native customisations are still there', (t) => {
  const delegate = text(path.join(APP, 'ios', 'Varanda', 'AppDelegate.swift'))
  t.ok(/isExcludedFromBackup\s*=\s*true/.test(delegate), 'AppDelegate excludes the node data from backup')
  const gradle = text(path.join(APP, 'android', 'app', 'build.gradle'))
  for (const p of ['STORE_FILE', 'STORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
    t.ok(gradle.includes("findProperty('VARANDA_RELEASE_" + p + "')"), 'build.gradle reads VARANDA_RELEASE_' + p)
  }
  t.ok(/applicationIdSuffix\s+'\.debug'/.test(gradle), "build.gradle keeps applicationIdSuffix '.debug'")
})

const hasRsvg = !spawnSync('rsvg-convert', ['--version']).error
if (!hasRsvg) console.log('# skip: rsvg-convert not on PATH, render-assets --check not run')

test('render-assets --check agrees with the committed assets' + (hasRsvg ? '' : ' (skipped: rsvg-convert not on PATH)'), { skip: !hasRsvg }, (t) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'site', 'scripts', 'render-assets.js'), '--check'], {
    encoding: 'utf8',
    timeout: 120000
  })
  t.is(r.status, 0, 'exit 0' + (r.status === 0 ? '' : ': ' + r.stderr + r.stdout))
})
