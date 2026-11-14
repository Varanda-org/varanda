'use strict'

const test = require('brittle')
const fs = require('fs')
const { renderPreSplash, readRegions, INDEX } = require('../scripts/pre-splash.js')

const html = fs.readFileSync(INDEX, 'utf8')

test('index.html holds the generated overlay', async (t) => {
  const out = await renderPreSplash()
  const now = readRegions(html)
  t.is(now.style, out.style, 'style matches renderPreSplash (run node scripts/pre-splash.js --write)')
  t.is(now.markup, out.markup, 'markup matches renderPreSplash')
})

test('ids and url() stay inside the vps- namespace', (t) => {
  const { style, markup } = readRegions(html)
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  t.ok(ids.length >= 2, 'the two patterns')
  for (const id of ids) t.ok(id.startsWith('vps-'), id)
  const urls = [...(style + markup).matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])
  t.ok(urls.length >= 2)
  for (const u of urls) t.ok(u.startsWith('#vps-'), u)
})

test('the CSS carries the motion and the strip loops', async (t) => {
  const { splashMotion, PULSE_MS, BAR_MS } = await import('../src/ui/splashMotion.js')
  const { stripLoops, sceneLayout } = await import('../src/ui/splashScene.js')
  const { style } = readRegions(html)
  const m = splashMotion(false)
  t.ok(style.includes('vps-ground ' + m.ground.duration + 'ms'), 'ground')
  t.ok(style.includes('vps-varanda ' + m.varanda.duration + 'ms'), 'varanda')
  t.ok(style.includes('vps-chair ' + m.chair.duration + 'ms'), 'chair')
  t.ok(style.includes('translateY(' + m.chair.from.translateY + 'px) rotate(' + m.chair.from.rotate + 'deg) scale(' + m.chair.from.scale + ')'), 'chair from')
  t.ok(style.includes('vps-rise ' + m.letters[0].duration + 'ms'), 'letters')
  t.ok(style.includes('calc(' + m.letters[0].delay + 'ms + var(--i) * ' + (m.letters[1].delay - m.letters[0].delay) + 'ms)'), 'letter stagger')
  t.ok(style.includes('vps-fade ' + m.hint.duration + 'ms ease-out ' + m.hint.delay + 'ms'), 'bar fade')
  t.ok(style.includes('vps-pulse ' + PULSE_MS + 'ms'), 'pulse')
  t.ok(style.includes('transition: width ' + BAR_MS + 'ms'), 'bar width')
  const loops = stripLoops(1)
  t.ok(style.includes('vps-slide-near ' + loops.near.ms + 'ms linear infinite'), 'near period')
  t.ok(style.includes('translateX(-' + loops.near.distance + 'px)'), 'near distance')
  t.ok(style.includes('calc(100% + ' + loops.near.distance + 'px)'), 'near width')
  t.ok(style.includes('vps-slide-far ' + loops.far.ms + 'ms linear infinite'), 'far period')
  t.ok(style.includes('translateX(-' + loops.far.distance + 'px)'), 'far distance')

  const offsets = (w) => {
    const l = sceneLayout({ width: w, height: 900 })
    return [l.varanda.x - l.width / 2, l.chair.x - l.width / 2, l.varanda.y, l.chair.y]
  }
  t.alike(offsets(1280), offsets(390), 'centre offsets do not depend on the width')
})

test('every keyframe but the expiry is motion-gated', (t) => {
  const { style } = readRegions(html)
  const at = style.indexOf('@media (prefers-reduced-motion: no-preference) {')
  t.ok(at > 0)
  const names = [...style.matchAll(/@keyframes ([\w-]+)/g)]
  t.ok(names.length >= 9)
  for (const k of names) {
    if (k[1] === 'vps-expire') t.ok(k.index < at, 'expiry is ungated')
    else t.ok(k.index > at, k[1] + ' inside no-preference')
  }
  t.absent(/animation:[^;]*\b(width|height|left|top)\b/.test(style), 'only transform and opacity animate')
})

test('index.html stays small and has no em dash', (t) => {
  const size = Buffer.byteLength(html)
  t.comment('index.html is ' + size + ' bytes')
  t.ok(size < 47000, 'index.html is ' + size + ' bytes')
  t.absent(html.includes('\u2014'), 'no em dash')
})

test('the rua reaches under the bottom inset at every scale step', async (t) => {
  const { SCALE_STEPS } = await import('../src/ui/splashScene.js')
  const m = /\.rua \{[^}]*calc\(\d+px \+ (\d+) \* env\(safe-area-inset-bottom\)\)/.exec(html)
  t.ok(m, 'the rua extends by a multiple of the inset')
  for (const { k } of SCALE_STEPS) t.ok(Number(m[1]) * k >= 1, 'at k = ' + k + ' the rua covers the inset')
})

test('the overlay draws the lockup lettering in both schemes', async (t) => {
  const { LETTERING, scenePalette } = await import('../src/ui/splashScene.js')
  const { style, markup } = readRegions(html)
  const drawn = [...markup.matchAll(/<path class="letra" d="([^"]*)"\/>/g)].map((m) => m[1])
  t.alike(drawn, LETTERING.letters.map((l) => l.d), 'every letter, verbatim, in order')
  t.ok(markup.includes('viewBox="' + LETTERING.viewBox + '"'), 'the lettering viewBox')
  t.ok(style.includes('.letra { fill: var(--vps-letra); }'), 'fill from the palette variable')
  const light = '--vps-letra: ' + scenePalette('light').letra + ';'
  const dark = '--vps-letra: ' + scenePalette('dark').letra + ';'
  const media = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n {6}\}/.exec(style)
  t.ok(media && media[1].includes(dark), 'dark media query carries the cream')
  const manualDark = /html\[data-scheme=dark\] #varanda-pre-splash \{ ([^}]*)\}/.exec(style)
  t.ok(manualDark && manualDark[1].includes(dark), 'manual Escuro carries the cream')
  const manualLight = /html\[data-scheme=light\] #varanda-pre-splash \{ (--[^}]*)\}/.exec(style)
  t.ok(manualLight && manualLight[1].includes(light), 'manual Claro carries the ink')
  t.absent(/\.word \{[^}]*(font|color)/.test(style), 'no font or colour on the word')
})

test('the overlay tree stands where the native one does at every width', async (t) => {
  const { sceneLayout } = await import('../src/ui/splashScene.js')
  const { style } = readRegions(html)
  const m = /\.arvore \{ left: (?:max\()?calc\(50% ([+-]) (\d+)px\)(?:, (-?\d+)px\))?;/.exec(style)
  t.ok(m, 'the tree has a left offset from the centre')
  const offset = (m[1] === '-' ? -1 : 1) * Number(m[2])
  const floor = m[3] == null ? -Infinity : Number(m[3])
  for (const width of [280, 320, 344, 390, 430, 768, 1280]) {
    const native = sceneLayout({ width, height: 900 }).tree.x
    const overlay = Math.max(width / 2 + offset, floor)
    t.ok(Math.abs(overlay - native) <= 1, width + 'px wide: overlay ' + overlay + ', native ' + native)
  }
})

test('the sky, the tree and the flyers', async (t) => {
  const { FLYERS } = await import('../src/ui/splashMotion.js')
  const { style, markup } = readRegions(html)
  t.ok(markup.indexOf('class="ceu"') < markup.indexOf('class="arvore"'), 'the sky is drawn first')
  t.ok(markup.indexOf('class="arvore"') < markup.indexOf('class="varanda"'), 'the tree before the varanda')
  t.is((markup.match(/<div class="ave a\d">/g) || []).length, FLYERS.birds.length, 'one wrapper per bird')
  t.ok(markup.includes('<div class="borboleta"><svg'), 'the butterfly has its own wrapper')
  t.ok(/\.ceu \{ position: absolute; left: 0; right: 0;/.test(style), 'the band is full width')
  const at = style.indexOf('@media (prefers-reduced-motion: no-preference) {')
  for (const name of ['vps-ave1', 'vps-ave2', 'vps-ave3', 'vps-bob1', 'vps-borboleta', 'vps-flap']) {
    const k = style.indexOf('@keyframes ' + name + ' ')
    t.ok(k > at, name + ' inside no-preference')
  }
  t.ok(/\.arvore, #varanda-pre-splash \.varanda \{ animation: vps-varanda/.test(style), 'the tree enters with the varanda')
  FLYERS.birds.forEach((b, i) => {
    t.ok(style.includes('vps-ave' + (i + 1) + ' ' + b.ms + 'ms linear -' + Math.round(b.phase * b.ms) + 'ms infinite'), 'bird ' + i + ' drift and phase')
  })
  // Outside the motion block the flyers have a resting transform, so reduced
  // motion still shows them on screen.
  t.ok(/\.a1 \{ top: \d+px; height: \d+px; transform: translateX\(calc\(/.test(style.slice(0, at)), 'birds rest on screen')
  const media = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n {6}\}/.exec(style)
  const hide = '#varanda-pre-splash .ceu .sol, #varanda-pre-splash .ave, #varanda-pre-splash .borboleta { display: none; }'
  t.ok(media && media[1].includes(hide), 'dark hides the sun, birds and butterfly')
  t.ok(style.includes('html[data-scheme=dark] #varanda-pre-splash .ceu .sol, html[data-scheme=dark] #varanda-pre-splash .ave, html[data-scheme=dark] #varanda-pre-splash .borboleta { display: none; }'), 'manual Escuro hides them')
  t.ok(style.includes('html[data-scheme=light] #varanda-pre-splash .ceu .sol, html[data-scheme=light] #varanda-pre-splash .ave, html[data-scheme=light] #varanda-pre-splash .borboleta { display: block; }'), 'manual Claro shows them')
})

test('the band and the sun draw the module\'s stops', async (t) => {
  const { SKY_STOPS, SUN_STOPS, scenePalette } = await import('../src/ui/splashScene.js')
  const { style, markup } = readRegions(html)
  const light = scenePalette('light')
  const dark = scenePalette('dark')
  const pct = (n) => Math.round(n * 10000) / 100 + '%'
  t.ok(markup.includes('<div class="ceu"><div class="sol"></div></div>'), 'the sun sits inside the band')
  t.absent(/<i>|\.ceu i\b/.test(style + markup), 'no flat steps')
  const sky = /\.ceu \{[^}]*background: linear-gradient\(180deg, ([^;]*)\); \}/.exec(style)
  t.ok(sky, 'the band is a vertical gradient')
  t.alike(sky[1].split(', '), SKY_STOPS.map((s) => 'var(--vps-' + s.key + ') ' + pct(s.offset)), 'the band stops are the module\'s')
  const sun = /\.sol \{[^}]*background: radial-gradient\(circle closest-side, ([^;]*)\); \}/.exec(style)
  t.ok(sun, 'the sun is a radial gradient')
  const colour = (s) => {
    if (s.opacity === 1) return light[s.key]
    return 'rgba(' + [1, 3, 5].map((i) => parseInt(light[s.key].slice(i, i + 2), 16)).join(', ') + ', ' + s.opacity + ')'
  }
  t.alike(sun[1].match(/(#[0-9a-f]{6}|rgba\([^)]*\)) [\d.]+%/g), SUN_STOPS.map((s) => colour(s) + ' ' + pct(s.offset)), 'the sun stops are the module\'s')
  // The band reads the palette variables, so the dark blocks switch it to the night.
  const media = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n {6}\}/.exec(style)
  const manualDark = /html\[data-scheme=dark\] #varanda-pre-splash \{ ([^}]*)\}/.exec(style)
  for (const s of SKY_STOPS) {
    const v = '--vps-' + s.key + ': ' + dark[s.key] + ';'
    t.ok(media && media[1].includes(v), 'dark media query: ' + v)
    t.ok(manualDark && manualDark[1].includes(v), 'manual Escuro: ' + v)
  }
  t.ok(media && media[1].includes('#varanda-pre-splash .ceu .sol, #varanda-pre-splash .ave, #varanda-pre-splash .borboleta { display: none; }'), 'dark hides the sun, birds and butterfly')
  t.absent(/\.sol \{[^}]*animation/.test(style), 'the sun stays still')
})
