'use strict'

// Renders the Varanda logo PNGs (app icons, splash, favicons) from the SVG
// sources in apps/site/artwork/logo/ (written by artwork/logo/generator/cadeira.py)
// and copies the SVGs the site uses into apps/site/public.
//
// Usage: node apps/site/scripts/render-assets.js [--check]
//   (no flag)  render every target, write it, and write artwork/logo/asset-manifest.json
//   --check    render to a temporary directory and compare with the manifest and with
//              the files on disk; writes nothing, exits 1 on any difference
//
// Needs rsvg-convert (brew install librsvg). Every PNG is re-encoded through pngjs
// with fixed options, so there are no time or text chunks and a second run is
// byte-identical. The Android mipmaps are PNG bytes in files named .webp, as Expo
// writes them.

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PNG } = require('pngjs')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const LOGO = 'apps/site/artwork/logo'
const MANIFEST = path.join(LOGO, 'asset-manifest.json')
const CREAM = { red: 0xfb, green: 0xf8, blue: 0xf3 }

const APP = 'apps/app'
const IOS = APP + '/ios/Varanda/Images.xcassets'
const RES = APP + '/android/app/src/main/res'
const PUB = 'apps/site/public'
const WEB = APP + '/public'
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]

function targets () {
  const t = [
    { out: APP + '/assets/icon.png', src: 'icon-ios.svg', size: 1024, opaque: true },
    { out: APP + '/assets/splash-icon.png', src: 'splash.svg', size: 1024 },
    { out: APP + '/assets/favicon.png', src: 'mark.svg', size: 48 },
    { out: APP + '/assets/cadeira.png', src: 'chair.svg', size: 128 },
    { out: APP + '/assets/android-icon-foreground.png', src: 'icon-android-foreground.svg', size: 512 },
    { out: APP + '/assets/android-icon-background.png', src: 'icon-android-background.svg', size: 512 },
    { out: APP + '/assets/android-icon-monochrome.png', src: 'icon-android-monochrome.svg', size: 432 },
    { out: IOS + '/AppIcon.appiconset/App-Icon-1024x1024@1x.png', src: 'icon-ios.svg', size: 1024, opaque: true },
    { out: IOS + '/SplashScreenLegacy.imageset/image.png', src: 'splash.svg', size: 1024 },
    { out: IOS + '/SplashScreenLegacy.imageset/image@2x.png', src: 'splash.svg', size: 1024 },
    { out: IOS + '/SplashScreenLegacy.imageset/image@3x.png', src: 'splash.svg', size: 1024 }
  ]
  for (const [dpi, s] of DENSITIES) {
    const mip = RES + '/mipmap-' + dpi + '/'
    t.push({ out: mip + 'ic_launcher.webp', src: 'icon-android-legacy.svg', size: 48 * s })
    t.push({ out: mip + 'ic_launcher_round.webp', src: 'icon-android-legacy-round.svg', size: 48 * s })
    t.push({ out: mip + 'ic_launcher_foreground.webp', src: 'icon-android-foreground.svg', size: 108 * s })
    t.push({ out: mip + 'ic_launcher_background.webp', src: 'icon-android-background.svg', size: 108 * s })
    t.push({ out: mip + 'ic_launcher_monochrome.webp', src: 'icon-android-monochrome.svg', size: 108 * s })
  }
  for (const [dpi, s] of DENSITIES) {
    t.push({ out: RES + '/drawable-' + dpi + '/splashscreen_logo.png', src: 'splash.svg', size: 288 * s })
  }
  t.push(
    { out: PUB + '/favicon.svg', src: 'favicon.svg', copy: true },
    { out: PUB + '/favicon-32.png', src: 'favicon.svg', size: 32 },
    { out: PUB + '/apple-touch-icon.png', src: 'icon-ios.svg', size: 180, opaque: true },
    { out: PUB + '/assets/logo-lockup.svg', src: 'lockup-horizontal.svg', copy: true },
    { out: PUB + '/assets/logo-mark.svg', src: 'mark.svg', copy: true },
    { out: PUB + '/assets/cadeira.svg', src: 'chair.svg', copy: true },
    // The installable web app (apps/app/public/manifest.webmanifest). The
    // maskable icon is the Android adaptive foreground, whose artwork sits
    // inside the safe zone, flattened onto the same #fbf8f3 as
    // icon-android-background.svg (the full-bleed square a mask may crop);
    // icon-ios.svg runs nearly edge to edge and would be cut by a mask.
    { out: WEB + '/icon-192.png', src: 'icon-ios.svg', size: 192, opaque: true },
    { out: WEB + '/icon-512.png', src: 'icon-ios.svg', size: 512, opaque: true },
    { out: WEB + '/icon-maskable-512.png', src: 'icon-android-foreground.svg', size: 512, opaque: true },
    { out: WEB + '/apple-touch-icon.png', src: 'icon-ios.svg', size: 180, opaque: true }
  )
  return t
}

function rsvgVersion () {
  try {
    const v = execFileSync('rsvg-convert', ['--version'], { encoding: 'utf8' })
    const m = v.match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : v.trim()
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('rsvg-convert não encontrado: brew install librsvg')
      process.exit(1)
    }
    throw err
  }
}

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function svgSize (buf) {
  const m = buf.toString('utf8').match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/)
  if (!m) throw new Error('SVG sem viewBox')
  return { width: Number(m[3]), height: Number(m[4]) }
}

function render (t) {
  const src = path.join(ROOT, LOGO, t.src)
  if (t.copy) {
    const buf = fs.readFileSync(src)
    return { buf, ...svgSize(buf) }
  }
  const n = String(t.size)
  const raw = execFileSync('rsvg-convert', ['-w', n, '-h', n, src], { maxBuffer: 256 * 1024 * 1024 })
  const png = PNG.sync.read(raw)
  if (png.width !== t.size || png.height !== t.size) throw new Error(t.out + ': rsvg-convert gave ' + png.width + 'x' + png.height)
  const opts = { colorType: t.opaque ? 2 : 6, inputColorType: 6, inputHasAlpha: true, bitDepth: 8, deflateLevel: 9, deflateStrategy: 3, filterType: -1 }
  if (t.opaque) opts.bgColor = { ...CREAM }
  const buf = PNG.sync.write({ width: png.width, height: png.height, data: png.data }, opts)
  return { buf, width: png.width, height: png.height }
}

function entry (t, r) {
  return { path: t.out, source: LOGO + '/' + t.src, width: r.width, height: r.height, bytes: r.buf.length, sha256: sha256(r.buf) }
}

function main () {
  const check = process.argv.includes('--check')
  const version = rsvgVersion()
  const list = targets()

  if (!check) {
    const outputs = []
    for (const t of list) {
      const r = render(t)
      const file = path.join(ROOT, t.out)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, r.buf)
      outputs.push(entry(t, r))
      console.log(t.out)
    }
    const manifest = { generator: 'apps/site/scripts/render-assets.js', rsvgConvert: version, outputs }
    fs.writeFileSync(path.join(ROOT, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
    console.log(MANIFEST)
    return
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'))
  const known = new Map(manifest.outputs.map((o) => [o.path, o]))
  const problems = []
  if (manifest.rsvgConvert !== version) problems.push('rsvg-convert ' + version + ' (o manifesto foi feito com ' + manifest.rsvgConvert + ')')
  if (known.size !== list.length) problems.push('o manifesto lista ' + known.size + ' arquivos, o script ' + list.length)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-assets-'))
  try {
    for (const t of list) {
      const r = render(t)
      const file = path.join(tmp, t.out)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, r.buf)
      const e = entry(t, { ...r, buf: fs.readFileSync(file) })
      const m = known.get(t.out)
      if (!m) problems.push(t.out + ': fora do manifesto')
      else if (m.sha256 !== e.sha256 || m.bytes !== e.bytes || m.width !== e.width || m.height !== e.height) problems.push(t.out + ': difere do manifesto')
      const disk = path.join(ROOT, t.out)
      if (!fs.existsSync(disk)) problems.push(t.out + ': não existe no disco')
      else if (sha256(fs.readFileSync(disk)) !== e.sha256) problems.push(t.out + ': o arquivo no disco difere')
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  if (problems.length) {
    for (const p of problems) console.error(p)
    process.exit(1)
  }
  console.log('ok: ' + list.length + ' arquivos conferem com ' + MANIFEST)
}

main()
