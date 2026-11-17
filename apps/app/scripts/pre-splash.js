'use strict'

// Generates the pre-bundle splash overlay in public/index.html from the same
// scene and motion data the app's Splash draws, so the web overlay and the
// React splash under it show one picture. The overlay must paint with no
// script (CSP script-src 'self' and the bundle not loaded yet), so the scene
// is inline SVG plus CSS.
// Usage: node scripts/pre-splash.js --write | --check

const fs = require('fs')
const path = require('path')

const INDEX = path.join(__dirname, '..', 'public', 'index.html')
const STYLE_OPEN = '<style id="varanda-pre-splash-style">'
const DIV_OPEN = '<div id="varanda-pre-splash" role="status" aria-label="Varanda, carregando">'
const DIV_CLOSE = '\n    </div>\n  </body>'
const P = '#varanda-pre-splash'
const LETTER_EASE = 'ease-out'
const SPRING = 'cubic-bezier(0.22, 1, 0.36, 1)'

async function load () {
  const scene = await import('../src/ui/splashScene.js')
  const motion = await import('../src/ui/splashMotion.js')
  const street = await import('../src/ui/splashStreet.js')
  return { scene, motion, street }
}

function attrs (shape) {
  let a = ' d="' + shape.d + '"'
  const cls = []
  if (!shape.fill) a += ' fill="none"'
  else if (shape.fill.startsWith('#')) a += ' fill="' + shape.fill + '"'
  else cls.push('f-' + shape.fill)
  if (shape.stroke) cls.push('s-' + shape.stroke)
  if (cls.length) a += ' class="' + cls.join(' ') + '"'
  if (shape.fillOpacity != null) a += ' fill-opacity="' + shape.fillOpacity + '"'
  if (shape.stroke) {
    a += ' stroke-width="' + shape.width + '"'
    if (shape.cap) a += ' stroke-linecap="' + shape.cap + '"'
    if (shape.join) a += ' stroke-linejoin="' + shape.join + '"'
  }
  if (shape.opacity != null) a += ' opacity="' + shape.opacity + '"'
  return '<path' + a + '/>'
}

function shapes (tile) {
  return tile.shapes.map(attrs).join('')
}

function tileScale (tile) {
  const [, , vw] = tile.viewBox.split(' ').map(Number)
  return tile.width / vw
}

function group (tile, dx) {
  const s = tileScale(tile)
  const t = []
  if (dx) t.push('translate(' + dx + ' 0)')
  if (s !== 1) t.push('scale(' + s + ')')
  return t.length ? '<g transform="' + t.join(' ') + '">' + shapes(tile) + '</g>' : shapes(tile)
}

function strip (name, period, height, tiles) {
  return '<svg class="strip ' + name + '" xmlns="http://www.w3.org/2000/svg" width="100%" height="' + height + '">' +
    '<defs><pattern id="vps-' + name + '" patternUnits="userSpaceOnUse" width="' + period + '" height="' + height + '">' +
    tiles + '</pattern></defs>' +
    '<rect class="f-pedra" width="100%" height="100%"/>' +
    '<rect fill="url(#vps-' + name + ')" width="100%" height="100%"/></svg>'
}

function transform (v) {
  const t = []
  if (v.translateY != null) t.push('translateY(' + v.translateY + 'px)')
  if (v.rotate != null) t.push('rotate(' + v.rotate + 'deg)')
  if (v.scale != null) t.push('scale(' + v.scale + ')')
  return t.length ? ' transform: ' + t.join(' ') + ';' : ''
}

function keyframes (name, step) {
  const frame = (v) => '{ opacity: ' + v.opacity + ';' + transform(v) + ' }'
  return '@keyframes ' + name + ' { from ' + frame(step.from) + ' to ' + frame(step.to) + ' }'
}

// Each scheme also carries the sun's stops as ready colours: the faded ones
// need rgba, and color-mix() is missing on older Safari.
function vars (palette, sunStops) {
  const colour = (s) => {
    if (s.opacity === 1) return palette[s.key]
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(palette[s.key].slice(i, i + 2), 16))
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + s.opacity + ')'
  }
  return Object.keys(palette).map((key) => '--vps-' + key + ': ' + palette[key] + ';')
    .concat(sunStops.map((s, i) => '--vps-sun' + i + ': ' + colour(s) + ';')).join(' ')
}

function px (n) {
  return n < 0 ? '- ' + (-n) + 'px' : '+ ' + n + 'px'
}

function pct (n) {
  return Math.round(n * 10000) / 100 + '%'
}

// The band reads its stops through the palette variables, so the dark
// scheme's values turn the same gradient into the moonlit night.
function skyGradient (stops) {
  return 'linear-gradient(180deg, ' + stops.map((s) => 'var(--vps-' + s.key + ') ' + pct(s.offset)).join(', ') + ')'
}

function sunGradient (stops) {
  return 'radial-gradient(circle closest-side, ' + stops.map((s, i) => 'var(--vps-sun' + i + ') ' + pct(s.offset)).join(', ') + ')'
}

// The flyers' loops, inside the no-preference block: a bird drifts from just
// off the left edge to the right edge, started `phase` of the way in (a
// negative delay) so it matches its rest pose, and bobs on its own svg; the
// butterfly drifts its figure of eight and flaps on its svg.
function flyerCss (L, flyers, motion) {
  const out = []
  L.birds.forEach((b, i) => {
    const f = flyers.birds[i]
    const n = i + 1
    const half = Math.round(f.ms / f.bobs / 2)
    out.push(
      '  ' + P + ' .a' + n + ' { animation: vps-ave' + n + ' ' + f.ms + 'ms linear -' + Math.round(f.phase * f.ms) + 'ms infinite; }',
      '  @keyframes vps-ave' + n + ' { from { transform: translateX(-' + b.w + 'px); } to { transform: translateX(100%); } }',
      '  ' + P + ' .a' + n + ' svg { animation: vps-bob' + n + ' ' + half + 'ms ease-in-out -' + half + 'ms infinite alternate; }',
      '  @keyframes vps-bob' + n + ' { from { transform: translateY(' + f.bob + 'px); } to { transform: translateY(-' + f.bob + 'px); } }'
    )
  })
  const b = flyers.butterfly
  const d = motion.butterflyDrift(b)
  const frames = d.input.map((t, i) => pct(t) + ' { transform: translate(' + d.x[i] + 'px, ' + d.y[i] + 'px); }').join(' ')
  out.push(
    '  ' + P + ' .borboleta { animation: vps-borboleta ' + b.driftMs + 'ms linear infinite; }',
    '  @keyframes vps-borboleta { ' + frames + ' }',
    '  ' + P + ' .borboleta svg { animation: vps-flap ' + b.flapMs / 2 + 'ms ease-in-out infinite alternate; }',
    '  @keyframes vps-flap { from { transform: scaleX(1); } to { transform: scaleX(' + b.fold + '); } }'
  )
  return out
}

// Street shapes share one rule for the cap and the common 3 wide stroke
// (.g svg, inherited), so only a different width stays as an attribute (it beats the inherited value); `n` is fill: none.
// The join is opt in (`j`): limbs keep sharp knees and shoes, only the outlines ask for round corners.
function streetAttrs (shape) {
  const cls = [shape.fill ? 'f-' + shape.fill : 'n']
  if (shape.stroke) cls.push('s-' + shape.stroke)
  if (shape.join === 'round') cls.push('j')
  let a = ' d="' + shape.d + '" class="' + cls.join(' ') + '"'
  if (shape.stroke && shape.width !== 3) a += ' stroke-width="' + shape.width + '"'
  return '<path' + a + '/>'
}

// The people on the near band, from splashStreet.js. Each mover is an HTML
// wrapper around one svg; a lane is mirrored as a whole, so the left-facing
// walkers share the one motion. No ids and no <use>: every figure repeats its
// paths, which keeps the overlay free of references the CSP scan rejects.
// A bare unit-less 0 and no leading zero keep the generated frames short.
function short (n) {
  return n === 0 ? '0' : String(n).replace(/^(-?)0\./, '$1.')
}

// Linear frames between two equal neighbours add nothing, so drop them.
function trim (input, ...ys) {
  const keep = input.map((_, j) => j === 0 || j === input.length - 1 || ys.some((y) => y[j] !== y[j - 1] || y[j] !== y[j + 1]))
  return input.map((t, j) => keep[j] ? j : -1).filter((j) => j >= 0)
}

function streetParts (st, top) {
  const { STREET: S } = st
  const row = (name) => S.rows.find((r) => r.name === name)
  const figure = (f, cls) => {
    const art = st.figureArt(f.figure, f.tint)
    const pose = (k) => art[k].length ? '<g class="' + k + '">' + art[k].map(streetAttrs).join('') + '</g>' : ''
    return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="' + art.viewBox + '">' + art.body.map(streetAttrs).join('') + pose('a') + pose('b') + '</svg>'
  }
  const rest = []
  const motion = []
  const marg = S.track.margin
  const travel = 'max(' + S.track.period + 'px, 100% + ' + 2 * marg + 'px)'
  const lines = []
  // Every pose loop is one a-then-b swap per --t, so one pair of keyframes
  // serves the lanes and the roda; a second cycle count would need its own.
  if (S.idle.poseCycles !== 1) throw new Error('pre-splash: the roda swaps once per loop')
  const sw = st.poseSwap(1)
  for (const k of ['a', 'b']) {
    motion.push(
      '  ' + P + ' .' + k + ' { animation: vps-p' + k + ' var(--t) steps(1) infinite; }',
      '  @keyframes vps-p' + k + ' { ' + sw.input.map((t, i) => pct(t) + ' { opacity: ' + sw[k][i] + '; }').join(' ') + ' }'
    )
  }
  const laneHtml = (name) => {
    const lane = S.lanes[name]
    const r = row(lane.row)
    const inner = lane.movers.map((m, i) => {
      const art = st.figureArt(m.figure, m.tint)
      const h = art.height * r.scale
      const cls = name[0] + i
      rest.push(P + ' .' + cls + ' { top: ' + (r.feet - h) + 'px; height: ' + h + 'px; --p: ' + short(Math.round(st.moverPhase(lane, m) * 10000) / 10000) + '; }')
      motion.push('  ' + P + ' .' + cls + ' { animation: vps-walk ' + lane.ms + 'ms linear -' + st.moverDelayMs(lane, m) + 'ms infinite; }')
      return '<div class="m ' + cls + '">' + figure(m) + '</div>'
    })
    return '<div class="l ' + name + '" style="--t:' + lane.strideMs + 'ms">' + inner.join('') + '</div>'
  }
  motion.push('  @keyframes vps-walk { from { transform: translateX(-' + marg + 'px); } to { transform: translateX(calc(' + travel + ' - ' + marg + 'px)); } }')
  const sr = row('standing')
  let kid = 0
  const standing = S.standing.map((f, i) => {
    const art = st.figureArt(f.figure, f.tint)
    rest.push(P + ' .s' + i + ' { left: calc(50% ' + px(f.x) + '); top: ' + (sr.feet - art.height) + 'px; height: ' + art.height + 'px;' + (f.figure === 'roda' ? ' --t: ' + S.idle.ms + 'ms;' : '') + ' }')
    if (f.figure === 'crianca') {
      const hop = st.kidHop(kid)
      const frames = trim(hop.input, hop.y).map((j) => pct(hop.input[j]) + ' { transform: translateY(' + short(hop.y[j]) + (hop.y[j] ? 'px' : '') + '); }').join(' ')
      motion.push('  ' + P + ' .s' + i + ' { animation: vps-hop' + kid + ' ' + S.idle.ms + 'ms linear infinite; }', '  @keyframes vps-hop' + kid + ' { ' + frames + ' }')
      kid++
    } else if (f.figure === 'bola') {
      const b = st.ballArc()
      const frames = trim(b.input, b.x, b.y).map((j) => pct(b.input[j]) + ' { transform: translate(' + short(b.x[j]) + (b.x[j] ? 'px' : '') + ', ' + short(b.y[j]) + (b.y[j] ? 'px' : '') + '); }').join(' ')
      motion.push('  ' + P + ' .s' + i + ' { animation: vps-bola ' + S.idle.ms + 'ms linear infinite; }', '  @keyframes vps-bola { ' + frames + ' }')
    }
    return '<div class="f s' + i + '">' + figure(f, f.mirrored ? 'e' : '') + '</div>'
  })
  const markup = '<div class="g">' + laneHtml('vindo') + standing.join('') + laneHtml('indo') + '</div>'
  lines.push(
    P + ' .g, ' + P + ' .l, ' + P + ' .m, ' + P + ' .f { position: absolute; }',
    P + ' .g { inset: ' + top + 'px 0 auto; height: ' + S.band + 'px; overflow: hidden; }',
    P + ' .l { inset: 0; }',
    P + ' .vindo, ' + P + ' .e { transform: scaleX(-1); }',
    P + ' .m { left: 0; width: 100%; transform: translateX(calc(' + travel + ' * var(--p) - ' + marg + 'px)); }',
    P + ' .g svg { height: 100%; overflow: visible; stroke-width: 3; stroke-linecap: round; }',
    P + ' .j { stroke-linejoin: round; }',
    P + ' .n { fill: none; }',
    P + ' .b { opacity: 0; }'
  )
  return { markup, rest: lines.concat(rest), motion }
}

async function renderPreSplash () {
  const { scene, motion, street } = await load()
  const L = scene.sceneLayout({ width: 390, height: 900 })
  const mid = L.width / 2
  // sceneLayout keeps the trunk beside the varanda but never left of a
  // minimum, and that clamp is already active at 390. CSS max() keeps both
  // terms, so the overlay tree stands where the native one does at any width.
  const wide = scene.sceneLayout({ width: 2000, height: 900 })
  const treeLeft = 'max(calc(50% ' + px(L.varanda.x - mid + wide.tree.x - wide.varanda.x) + '), ' +
    scene.sceneLayout({ width: 200, height: 900 }).tree.x + 'px)'
  const m = motion.splashMotion(false)
  const light = scene.scenePalette('light')
  const dark = scene.scenePalette('dark')
  const keys = Object.keys(light)
  const H = L.height
  const g = L.far.y

  const walk = streetParts(street, L.near.y - g)
  const nearTiles = scene.nearTiles()
  // The pattern repeats at the tiles' own widths; the strips no longer move.
  const nearPeriod = nearTiles.reduce((n, t) => n + t.width, 0)
  const farTile = scene.farTile()
  const farPeriod = farTile.width
  const varanda = scene.varandaArt()
  const tree = scene.treeArt()
  const bird = scene.birdArt()
  const butterfly = scene.butterflyArt()
  const flyers = motion.FLYERS
  const svgOf = (cls, art) => '<svg' + (cls ? ' class="' + cls + '"' : '') + ' xmlns="http://www.w3.org/2000/svg" viewBox="' + art.viewBox + '">' + shapes(art) + '</svg>'
  // Each flyer moves as an HTML wrapper around its own small svg, so its
  // transform behaves the same in Safari as elsewhere.
  const birds = L.birds.map((_, i) => '<div class="ave a' + (i + 1) + '">' + svgOf('', bird) + '</div>')

  const chair = '<svg class="chair" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="' + scene.CHAIR_VIEWBOX + '" width="96" height="96">' +
    scene.CHAIR_PATHS.map(attrs).join('') + '</svg>'
  const lettering = scene.LETTERING
  const [, , lw, lh] = lettering.viewBox.split(' ').map(Number)
  const wordH = scene.SCENE.letteringHeight
  const wordW = Math.round(wordH * lw / lh)
  // One svg per letter, each with the full viewBox, so every letter keeps its
  // place in the lockup and rises on its own.
  const letters = lettering.letters.map((l, i) => '<svg style="--i:' + i + '" viewBox="' + lettering.viewBox + '"><path class="letra" d="' + l.d + '"/></svg>').join('')
  const lines = [
    '<div class="scene" aria-hidden="true">',
    '  <div class="ceu"><div class="sol"></div></div>',
    ...birds.map((b) => '  ' + b),
    '  ' + svgOf('arvore', tree),
    '  <svg class="varanda" xmlns="http://www.w3.org/2000/svg" viewBox="' + varanda.viewBox + '">' + shapes(varanda) + '</svg>',
    '  ' + chair,
    '  <div class="borboleta">' + svgOf('', butterfly) + '</div>',
    '  <div class="ground">',
    '    ' + strip('far', farPeriod, L.far.height, group(farTile, 0)),
    '    ' + strip('near', nearPeriod, L.near.height, nearTiles.map((t, i) => group(t, i * t.width)).join('')),
    '    ' + walk.markup,
    '    <div class="kerb"></div>',
    '    <div class="rua"></div>',
    '  </div>',
    '</div>',
    '<div class="word" aria-hidden="true">' + letters + '</div>',
    '<div class="bar" aria-hidden="true"><span></span></div>'
  ]
  const markup = '\n' + lines.map((l) => '      ' + l).join('\n')
  const used = new Set(markup.match(/\b[fs]-[a-zA-Z]+/g))
  const css = [
    P + ' { position: fixed; inset: 0; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; margin: 0; background: #fbf8f3; pointer-events: none; animation: vps-expire 0s linear 20s forwards; }',
    '/* a no-script safety net so the overlay can never outlive a boot that failed to mount the app */',
    '@keyframes vps-expire { to { visibility: hidden; } }',
    P + ' { overflow: hidden; padding-bottom: ' + H + 'px; box-sizing: border-box; }',
    '/* the data-scheme selectors outrank the media query, so Ajustes wins over the system scheme */',
    P + ', html[data-scheme=light] ' + P + ' { ' + vars(light, scene.SUN_STOPS) + ' }',
    'html[data-scheme=dark] ' + P + ' { ' + vars(dark, scene.SUN_STOPS) + ' }',
    P + ' .word { position: relative; width: ' + wordW + 'px; height: ' + wordH + 'px; }',
    P + ' .word svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }',
    P + ' .letra { fill: var(--vps-letra); }',
    '/* the app sets --varanda-progress (0..1) from real boot steps (src/ui/Splash.js) */',
    P + ' .bar { margin-top: -4px; width: ' + motion.BAR_WIDTH + 'px; height: 4px; border-radius: 2px; overflow: hidden; background: rgba(31,42,36,0.10); }',
    P + ' .bar span { display: block; height: 100%; border-radius: 2px; background: #1d6b4f; width: calc(var(--varanda-progress, 0.1) * 100%); }',
    '/* generated by scripts/pre-splash.js; x is a centre offset, the page width is unknown here */',
    P + ' .scene { position: absolute; left: 0; bottom: env(safe-area-inset-bottom); width: 100%; height: ' + H + 'px; transform-origin: 0 100%; }',
    P + ' .scene svg { position: absolute; display: block; }',
    P + ' .varanda { left: calc(50% ' + px(L.varanda.x - mid) + '); top: ' + L.varanda.y + 'px; width: ' + L.varanda.w + 'px; height: ' + L.varanda.h + 'px; }',
    P + ' .scene .chair { left: calc(50% ' + px(L.chair.x - mid) + '); top: ' + L.chair.y + 'px; width: ' + L.chair.size + 'px; height: ' + L.chair.size + 'px; }',
    '/* the landing\'s sunset, melting out of the page cream at the top */',
    P + ' .ceu { position: absolute; left: 0; right: 0; top: ' + L.sky.y + 'px; height: ' + L.sky.height + 'px; background: ' + skyGradient(scene.SKY_STOPS) + '; }',
    P + ' .sol { position: absolute; left: calc(50% ' + px(L.sun.x - mid) + '); top: ' + L.sun.y + 'px; width: ' + L.sun.size + 'px; height: ' + L.sun.size + 'px; background: ' + sunGradient(scene.SUN_STOPS) + '; }',
    P + ' .arvore { left: ' + treeLeft + '; top: ' + L.tree.y + 'px; width: ' + L.tree.w + 'px; height: ' + L.tree.h + 'px; }',
    '/* a bird at rest sits `phase` of the way across, where its drift starts */',
    P + ' .ave { position: absolute; left: 0; width: 100%; }',
    P + ' .ave svg { left: 0; top: 0; height: 100%; overflow: visible; }',
    ...L.birds.map((b, i) => {
      const f = flyers.birds[i]
      return P + ' .a' + (i + 1) + ' { top: ' + b.y + 'px; height: ' + b.h + 'px; transform: translateX(calc(' + f.phase * 100 + '% ' + px(Math.round((f.phase - 1) * b.w * 100) / 100) + ')); } ' +
        P + ' .a' + (i + 1) + ' svg { width: ' + b.w + 'px; }'
    }),
    P + ' .borboleta { position: absolute; left: calc(50% ' + px(L.butterfly.x - mid) + '); top: ' + L.butterfly.y + 'px; width: ' + L.butterfly.w + 'px; height: ' + L.butterfly.h + 'px; }',
    P + ' .borboleta svg { left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }',
    P + ' .ground { position: absolute; left: 0; right: 0; top: ' + g + 'px; bottom: 0; }',
    P + ' .strip { left: 0; }',
    P + ' .far { top: ' + (L.far.y - g) + 'px; width: 100%; height: ' + L.far.height + 'px; }',
    P + ' .near { top: ' + (L.near.y - g) + 'px; width: 100%; height: ' + L.near.height + 'px; }',
    P + ' .kerb, ' + P + ' .rua { position: absolute; left: 0; right: 0; }',
    P + ' .kerb { top: ' + (L.kerb.y - g) + 'px; height: ' + L.kerb.height + 'px; background: var(--vps-meioFio); }',
    '/* the scene sits above the inset; the rua runs on under it at the smallest k too */',
    P + ' .rua { top: ' + (L.rua.y - g) + 'px; height: calc(' + L.rua.height + 'px + ' + Math.ceil(1 / Math.min(...scene.SCALE_STEPS.map((s) => s.k))) + ' * env(safe-area-inset-bottom)); background: var(--vps-asfalto); }',
    ...walk.rest,
    ...keys.filter((key) => used.has('f-' + key)).map((key) => P + ' .f-' + key + ' { fill: var(--vps-' + key + '); }'),
    ...keys.filter((key) => used.has('s-' + key)).map((key) => P + ' .s-' + key + ' { stroke: var(--vps-' + key + '); }')
  ]
  for (const step of scene.SCALE_STEPS) {
    if (step.k === 1) continue
    const upper = scene.SCALE_STEPS[scene.SCALE_STEPS.indexOf(step) - 1].minHeight - 0.02
    css.push('@media (max-height: ' + upper + 'px) { ' + P + ' { padding-bottom: ' + (H * step.k) + 'px; } ' + P + ' .scene { transform: scale(' + step.k + '); width: calc(100% / ' + step.k + '); } }')
  }
  css.push(
    '@media (prefers-color-scheme: dark) {',
    '  html,',
    '  body,',
    '  ' + P + ' { background: #101010; }',
    '  ' + P + ' { ' + vars(dark, scene.SUN_STOPS) + ' }',
    '  ' + P + ' .bar { background: rgba(245,245,245,0.14); }',
    '  ' + P + ' .bar span { background: #5dcaa0; }',
    '}',
    '/* public/pre-scheme.js, then the bundle, put the scheme chosen in Ajustes on html; it can differ from the system\'s */',
    'html[data-scheme=light] ' + P + ' { background: #fbf8f3; }',
    'html[data-scheme=light] ' + P + ' .bar { background: rgba(31,42,36,0.10); }',
    'html[data-scheme=light] ' + P + ' .bar span { background: #1d6b4f; }',
    'html[data-scheme=dark] ' + P + ' { background: #101010; }',
    'html[data-scheme=dark] ' + P + ' .bar { background: rgba(245,245,245,0.14); }',
    'html[data-scheme=dark] ' + P + ' .bar span { background: #5dcaa0; }',
    '@media (prefers-reduced-motion: no-preference) {',
    '  /* generated from apps/app/src/ui/splashMotion.js */',
    '  ' + P + ' .ceu, ' + P + ' .ground { animation: vps-ground ' + m.ground.duration + 'ms ' + SPRING + ' ' + m.ground.delay + 'ms both; }',
    '  ' + keyframes('vps-ground', m.ground),
    '  ' + P + ' .arvore, ' + P + ' .varanda { animation: vps-varanda ' + m.varanda.duration + 'ms ' + SPRING + ' ' + m.varanda.delay + 'ms both; }',
    '  ' + keyframes('vps-varanda', m.varanda),
    '  ' + P + ' .scene .chair { animation: vps-chair ' + m.chair.duration + 'ms ' + SPRING + ' ' + m.chair.delay + 'ms both; }',
    '  ' + keyframes('vps-chair', m.chair),
    ...walk.motion,
    ...flyerCss(L, flyers, motion),
    '  ' + P + ' .word svg { animation: vps-rise ' + m.letters[0].duration + 'ms ' + LETTER_EASE + ' both; animation-delay: calc(' + m.letters[0].delay + 'ms + var(--i) * ' + (m.letters[1].delay - m.letters[0].delay) + 'ms); }',
    '  ' + keyframes('vps-rise', m.letters[0]),
    '  ' + P + ' .bar { animation: vps-fade ' + m.hint.duration + 'ms ease-out ' + m.hint.delay + 'ms both, vps-pulse ' + motion.PULSE_MS + 'ms ease-in-out ' + (m.hint.delay + m.hint.duration) + 'ms infinite alternate; }',
    '  ' + P + ' .bar span { transition: width ' + motion.BAR_MS + 'ms ease-out; }',
    '  ' + keyframes('vps-fade', m.hint),
    '  @keyframes vps-pulse { from { opacity: 1; } to { opacity: 0.6; } }',
    '}'
  )
  const style = '\n' + css.map((l) => '      ' + l).join('\n') + '\n    '

  return { style, markup }
}

function regions (html) {
  const s0 = html.indexOf(STYLE_OPEN)
  const s1 = html.indexOf('</style>', s0)
  const d0 = html.indexOf(DIV_OPEN)
  const d1 = html.indexOf(DIV_CLOSE, d0)
  if (s0 < 0 || s1 < 0 || d0 < 0 || d1 < 0) throw new Error('pre-splash markers not found in ' + INDEX)
  return {
    styleStart: s0 + STYLE_OPEN.length,
    styleEnd: s1,
    divStart: d0 + DIV_OPEN.length,
    divEnd: d1
  }
}

function readRegions (html) {
  const r = regions(html)
  return { style: html.slice(r.styleStart, r.styleEnd), markup: html.slice(r.divStart, r.divEnd) }
}

function apply (html, out) {
  const r = regions(html)
  return html.slice(0, r.styleStart) + out.style + html.slice(r.styleEnd, r.divStart) + out.markup + html.slice(r.divEnd)
}

async function main (argv) {
  const out = await renderPreSplash()
  const html = fs.readFileSync(INDEX, 'utf8')
  const next = apply(html, out)
  if (argv.includes('--write')) {
    if (next !== html) fs.writeFileSync(INDEX, next)
    console.log('pre-splash: ' + Buffer.byteLength(next) + ' bytes')
    return 0
  }
  if (argv.includes('--check')) {
    if (next !== html) {
      console.error('pre-splash: public/index.html is out of date, run node scripts/pre-splash.js --write')
      return 1
    }
    return 0
  }
  console.error('usage: node scripts/pre-splash.js --write | --check')
  return 2
}

module.exports = { renderPreSplash, readRegions, INDEX }

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    console.error(err)
    process.exitCode = 1
  })
}
