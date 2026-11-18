// The Varandinha look ("Pôr do sol"): palettes, small art and card styles that
// the balcony, its sheets and the Rua share. Pure: no React, no platform, so
// every number here runs in the tests.
//
// A drawing is { w, h, shapes } in its own box. A shape names palette keys:
//   { kind: 'rect', x, y, w, h, rx? } | { kind: 'circle', cx, cy, r }
//   { kind: 'ellipse', cx, cy, rx, ry } | { kind: 'path', d }
// plus fill (a key or 'none') and, optionally, stroke (a key), sw (stroke
// width in box units), cap ('round'), dash ([on, off]), opacity, grad (a
// gradient id from gardenGradients; fill stays a key, the fallback) and glow
// (a lamp that gets a halo at night). Geometry is absolute in the box:
// placePath bends a local path into place once, at load, so no transform is
// ever handed to the renderer.

import rpc from '@varanda/rpc'

export const GARDEN_LIGHT = deepFreeze({
  sky1: '#fbe7c6',
  sky2: '#f7b267',
  sky3: '#e8805a',
  sky4: '#a85a78',
  orb: '#fff2cf',
  halo: '#ffe2a0',
  city: '#c4677a',
  city2: '#8a4e7a',
  star: '#fff6dd',
  window: '#f6c453',
  roof: '#e8805a',
  roof2: '#d96b47',
  seam: '#c95d3d',
  wood: '#b98d74',
  woodHi: '#d3ab92',
  ink: '#1f2a24',
  floor: '#efd6b8',
  floorShade: '#ddb892',
  tile: '#dcbc98',
  pot: '#d9774f',
  potShade: '#b95c3a',
  potHi: '#f09c76',
  rim: '#cf6a44',
  soilDry: '#a58262',
  soilWet: '#5a3d2b',
  leaf: '#45a066',
  leaf2: '#1d6b4f',
  stem: '#2c7a52',
  ros: '#6f9670',
  ros2: '#9bbb93',
  flower: '#9db7e8',
  fern: '#58aa70',
  fern2: '#3f8f5c',
  fernLine: '#2a7a4d',
  tomato: '#d9473a',
  tomHi: '#ffc0ad',
  chili: '#c8322a',
  snake: '#2f7a52',
  snakeEdge: '#e2c14a',
  stake: '#b98d74',
  twine: '#e2c08f',
  spark: '#f6c453',
  glow: '#fff0b8',
  badge: '#fffaf1',
  drop: '#2f86c6',
  dotOn: '#45a066',
  dotOff: '#fffaf1',
  shadow: '#50280a',
  awning: '#e8805a',
  awningAlt: '#fff6dd',
  card: '#fffaf1',
  cardInk: '#1f2a24',
  lift: '#1f2a24',
  text: '#1f2a24',
  muted: '#5b5148',
  accent: '#e8805a',
  accentText: '#a8461f',
  onAccent: '#1f2a24',
  danger: '#b3261e'
})

// Same keys at night: a moonlit city, and colours that still read on a dark page.
export const GARDEN_DARK = deepFreeze({
  sky1: '#0d1220',
  sky2: '#141d36',
  sky3: '#1f2f54',
  sky4: '#2a3d62',
  orb: '#f4f1e8',
  halo: '#9fb0cc',
  city: '#1b2640',
  city2: '#111a2e',
  star: '#fff6dd',
  window: '#f6c453',
  roof: '#8f4a35',
  roof2: '#7a3d2b',
  seam: '#6a3324',
  wood: '#6b5244',
  woodHi: '#84675a',
  ink: '#090c0b',
  floor: '#3a2e27',
  floorShade: '#2c231e',
  tile: '#2f2520',
  pot: '#a5583d',
  potShade: '#7f402c',
  potHi: '#c06e4f',
  rim: '#9a4f35',
  soilDry: '#6e543d',
  soilWet: '#38261c',
  leaf: '#3d8a5b',
  leaf2: '#21604a',
  stem: '#2b6a4c',
  ros: '#62806a',
  ros2: '#83a083',
  flower: '#8fa8d8',
  fern: '#4a9161',
  fern2: '#357a50',
  fernLine: '#245e3e',
  tomato: '#c4473c',
  tomHi: '#f2a08f',
  chili: '#b83a30',
  snake: '#2a6a4a',
  snakeEdge: '#c9a93e',
  stake: '#6b5244',
  twine: '#a88a5f',
  spark: '#f6c453',
  glow: '#f6c453',
  badge: '#1d2030',
  drop: '#6bb6ea',
  dotOn: '#5dcaa0',
  dotOff: '#1d2030',
  shadow: '#000000',
  awning: '#b4573e',
  awningAlt: '#e9dcc0',
  card: '#1d2030',
  cardInk: '#3a3f55',
  lift: '#06070b',
  text: '#f4f1e8',
  muted: '#b9b3a8',
  accent: '#f7b267',
  accentText: '#f7b267',
  onAccent: '#1f2a24',
  danger: '#ff8a80'
})

export function gardenTokens (scheme) {
  return scheme === 'dark' ? GARDEN_DARK : GARDEN_LIGHT
}

// Gradients by id, resolved for one scheme: the renderer only copies them.
// The sky runs top to bottom; halo and glow fade from the centre out.
const GRADIENTS = {
  sky: { kind: 'linear', stops: [['sky1', 0, 1], ['sky2', 0.38, 1], ['sky3', 0.68, 1], ['sky4', 1, 1]] },
  halo: { kind: 'radial', stops: [['halo', 0, { light: 0.85, dark: 0.55 }], ['halo', 1, 0]] },
  glow: { kind: 'radial', stops: [['glow', 0, { light: 0.9, dark: 0.55 }], ['glow', 1, 0]] }
}

const RESOLVED = deepFreeze({ light: resolveGradients('light'), dark: resolveGradients('dark') })

export function gardenGradients (scheme) {
  return scheme === 'dark' ? RESOLVED.dark : RESOLVED.light
}

function resolveGradients (scheme) {
  const tokens = gardenTokens(scheme)
  const out = {}
  for (const id of Object.keys(GRADIENTS)) {
    const g = GRADIENTS[id]
    out[id] = {
      kind: g.kind,
      stops: g.stops.map(([key, offset, op]) => ({
        offset,
        color: tokens[key],
        opacity: typeof op === 'number' ? op : op[scheme]
      }))
    }
  }
  return out
}

// Local outlines the drawings place. Absolute commands only (M L H V C Q Z).
export const PATHS = deepFreeze({
  leaf: 'M0 0C3 -6 11 -8 17 -5C21 -2 21 2 17 5C11 8 3 6 0 0Z',
  blade: 'M0 0C5 -6 15 -6 20 0C15 6 5 6 0 0Z',
  vein: 'M3 0L15 0',
  spark: 'M0 -7L1.8 -1.8L7 0L1.8 1.8L0 7L-1.8 1.8L-7 0L-1.8 -1.8Z',
  drop: 'M0 -7C3 -3 5.5 0 5.5 2.5C5.5 5.5 3 8 0 8C-3 8 -5.5 5.5 -5.5 2.5C-5.5 0 -3 -3 0 -7Z',
  chili: 'M-2 0C-5 8 -3 16 4 22C1 14 1 7 3 0Z',
  calyx: 'M-4 1Q0 -4 5 1Z',
  sword: 'M-5 0C-7 -16 -6 -34 -1 -50C3 -34 5 -16 4 0Z',
  swordCore: 'M-3 0C-4.5 -15 -4 -30 -1 -43C1.5 -30 3 -15 2 0Z',
  frondUp: 'M0 0L2.8 -8.1L2.2 -10.1L6.7 -15.3L2.7 -15.8L7.8 -21L3.2 -21.1L8 -26.1L3.8 -26.3L8.1 -30.8L4.5 -31.1L8.2 -35.2L5.1 -35.7L8.2 -39.4L5.9 -40.1L8.1 -43.3L6.6 -44.1L6 -48L3.9 -44.7L2.2 -44.4L3.1 -40.5L0.7 -40.6L2.4 -36.2L-0.7 -36.5L1.7 -31.5L-2 -32.1L1 -26.6L-3.1 -27.3L0.4 -21.5L-4.1 -22.2L-0.1 -16L-4.2 -16.3L-0.6 -10.4L-1.6 -8.4Z',
  frondUpLine: 'M0 0Q2 -30 6 -48',
  frondSide: 'M0 0L7.4 -5.6L7.2 -7.1L13.6 -7L10.3 -9.5L17.7 -7.1L13.5 -11.1L19.7 -7.1L16.8 -11.8L21.6 -6.8L20.2 -11.6L23.7 -6.1L23.8 -10.6L26.3 -5L27.6 -8.7L29.5 -3.3L31.6 -5.8L33.3 -0.8L35.8 -2L37.5 2.6L40.1 2.8L46 8L42.3 1L42.4 -1.8L37.7 -4L38.7 -6.8L33.3 -8L35 -11L29 -11.1L31.1 -14.6L24.8 -13.2L26.8 -17.5L20.6 -14.4L22 -19.5L16.5 -14.6L16.8 -20.3L12.6 -13.7L11.4 -19.6L8.8 -11.9L6.6 -15.6L5.3 -9.1L3.5 -9Z',
  frondSideLine: 'M0 0Q18 -30 46 8',
  frondBack: 'M0 0L5.4 -8.4L5.2 -10.5L11.2 -13.7L7.6 -15.3L15 -17.5L10.2 -19.4L17.4 -20.6L13.1 -22.8L19.8 -22.9L16.3 -25.5L22.2 -24.7L19.6 -27.5L24.7 -26L23.2 -28.8L27.5 -27L27.1 -29.4L30.6 -27.7L31.3 -29.4L36 -30L31.5 -32.1L30.7 -34L26.9 -32.2L26.1 -34.7L22.5 -31.5L21.5 -34.7L18.4 -30L16.8 -33.6L14.6 -27.8L12.2 -31.6L11.2 -24.8L7.9 -28.5L8 -21.1L4 -24.6L5.1 -16.7L1.4 -18.5L2.6 -11.6L0.8 -10.1Z',
  frondBackLine: 'M0 0Q10 -36 36 -30',
  fiddle: 'M0 0C0 -4 0 -7 2 -9C4 -11 6 -9 5 -7C4 -6 3 -7 3 -8'
})

const COMMAND = /[MLHVCQZ]|-?(?:\d+\.?\d*|\.\d+)/g
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, Z: 0 }

// One local path moved into a drawing: rotate by r degrees, mirror when flip,
// scale by s, then shift to (x, y). Out comes M L C Q Z only, two decimals,
// so every point is a pair the tests can bound. A malformed path is ''.
export function placePath (d, at) {
  const place = placement(at)
  const tokens = String(d).match(COMMAND)
  if (!tokens) return ''
  const out = []
  let cmd = null
  let x = 0
  let y = 0
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (Object.hasOwn(ARITY, tok)) {
      cmd = tok
      i += 1
      if (cmd === 'Z') {
        out.push('Z')
        cmd = null
      }
      continue
    }
    if (cmd === null) return ''
    const n = ARITY[cmd]
    if (i + n > tokens.length) return ''
    const nums = tokens.slice(i, i + n).map(Number)
    if (nums.some((v) => !Number.isFinite(v))) return ''
    i += n
    let pts
    let letter = cmd
    if (cmd === 'H') {
      pts = [nums[0], y]
      letter = 'L'
    } else if (cmd === 'V') {
      pts = [x, nums[0]]
      letter = 'L'
    } else {
      pts = nums
    }
    x = pts[pts.length - 2]
    y = pts[pts.length - 1]
    const mapped = []
    for (let k = 0; k < pts.length; k += 2) mapped.push(...place(pts[k], pts[k + 1]))
    out.push(letter + mapped.map(fmt).join(' '))
    // Pairs after a moveto are linetos, as in SVG.
    if (cmd === 'M') cmd = 'L'
  }
  return out.join('')
}

// A shape list moved the same way. Rects and ellipses keep their axes, so a
// rotation applies to paths only; circles and ellipses move their centre.
// Stroke widths stay as written: they are box units of the target.
export function placeShapes (shapes, at) {
  const place = placement(at)
  const s = scaleOf(at)
  const out = []
  for (const shape of shapes) {
    const copy = { ...shape }
    if (shape.kind === 'path') {
      copy.d = placePath(shape.d, at)
    } else if (shape.kind === 'rect') {
      const [x, y] = place(shape.x, shape.y)
      copy.x = round2(Math.min(x, x + (isFlip(at) ? -shape.w * s : 0)))
      copy.y = round2(y)
      copy.w = round2(shape.w * s)
      copy.h = round2(shape.h * s)
      if (typeof shape.rx === 'number') copy.rx = round2(shape.rx * s)
    } else if (shape.kind === 'circle') {
      const [cx, cy] = place(shape.cx, shape.cy)
      copy.cx = round2(cx)
      copy.cy = round2(cy)
      copy.r = round2(shape.r * s)
    } else if (shape.kind === 'ellipse') {
      const [cx, cy] = place(shape.cx, shape.cy)
      copy.cx = round2(cx)
      copy.cy = round2(cy)
      copy.rx = round2(shape.rx * s)
      copy.ry = round2(shape.ry * s)
    }
    out.push(copy)
  }
  return out
}

function placement (at) {
  const x0 = numberOf(at, 'x', 0)
  const y0 = numberOf(at, 'y', 0)
  const s = scaleOf(at)
  const turn = numberOf(at, 'r', 0) * Math.PI / 180
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  const flip = isFlip(at)
  return (px, py) => {
    const rx = px * cos - py * sin
    const ry = px * sin + py * cos
    return [x0 + s * (flip ? -rx : rx), y0 + s * ry]
  }
}

function scaleOf (at) {
  const s = numberOf(at, 's', 1)
  return s > 0 ? s : 1
}

function isFlip (at) {
  return !!at && typeof at === 'object' && at.flip === true
}

function numberOf (at, key, fallback) {
  if (!at || typeof at !== 'object') return fallback
  const v = at[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function round2 (n) {
  const v = Math.round(n * 100) / 100
  return Object.is(v, -0) ? 0 : v
}

function fmt (n) {
  return String(round2(n))
}

// Shape makers the drawings below and gardenScene.js share. A local path at
// (x, y) turned r degrees and scaled s, styled by the rest.
export function shapePath (d, at, style) {
  return { kind: 'path', d: placePath(d, at), ...style }
}

export function leafAt (fill, x, y, r, s, extra) {
  return shapePath(PATHS.leaf, { x, y, r, s }, { fill, stroke: 'ink', sw: 1.2, ...extra })
}

export function bladeAt (fill, x, y, r, s, extra) {
  return shapePath(PATHS.blade, { x, y, r, s }, { fill, stroke: 'ink', sw: 1.2, ...extra })
}

export function veinAt (x, y, r, s) {
  return shapePath(PATHS.vein, { x, y, r, s }, { fill: 'none', stroke: 'ink', sw: 0.8, opacity: 0.35 })
}

export function sparkAt (x, y, s) {
  return shapePath(PATHS.spark, { x, y, s }, { fill: 'spark', stroke: 'ink', sw: 0.8 })
}

export function lineAt (d, at, stroke, sw) {
  return shapePath(d, at, { fill: 'none', stroke, sw, cap: 'round' })
}

// A rosemary sprig from (x0, 0) up to (x1, top), with pairs of needles
// along it, as one local path for lineAt.
export function sprigPath (x0, x1, top, pairs) {
  let d = 'M' + x0 + ' 0L' + x1 + ' ' + top
  for (let k = 1; k <= pairs; k++) {
    const t = k / (pairs + 1)
    const px = round2(x0 + (x1 - x0) * t)
    const py = round2(top * t)
    d += 'M' + px + ' ' + py + 'L' + round2(px - 5) + ' ' + round2(py - 4)
    d += 'M' + px + ' ' + py + 'L' + round2(px + 5) + ' ' + round2(py - 4)
  }
  return d
}

// Four booleans, one per growth stage, true up to the pot's stage. A view is
// untrusted: only own data properties are read, and anything odd is four
// empty dots.
const NO_DOTS = deepFreeze([false, false, false, false])
const DOT_ROWS = deepFreeze([
  [true, false, false, false],
  [true, true, false, false],
  [true, true, true, false],
  [true, true, true, true]
])

export function stageDots (view) {
  const stage = ownValue(view, 'stage')
  if (stage === 0 || stage === 1 || stage === 2 || stage === 3) return DOT_ROWS[stage]
  return NO_DOTS
}

// The drop badge: the pot could take water now (canWater is exactly true).
export function thirsty (view) {
  return ownValue(view, 'canWater') === true
}

export function ripeOf (view) {
  return ownValue(view, 'ripe') === true
}

// A row of four dots centred on (cx, cy), filled up to the stage.
export function dotRow (view, cx, cy, r, gap) {
  const dots = stageDots(view)
  const out = []
  for (let i = 0; i < 4; i++) {
    out.push({
      kind: 'circle',
      cx: round2(cx + (i - 1.5) * gap),
      cy: round2(cy),
      r,
      fill: dots[i] ? 'dotOn' : 'dotOff',
      stroke: 'ink',
      sw: round2(Math.max(0.8, r * 0.45))
    })
  }
  return deepFreeze(out)
}

// The water drop on a cream disc, in a 24 box.
export const THIRST_BADGE = deepFreeze({
  w: 24,
  h: 24,
  shapes: [
    { kind: 'circle', cx: 12, cy: 12, r: 10.5, fill: 'badge', stroke: 'ink', sw: 1.5 },
    shapePath(PATHS.drop, { x: 12, y: 12, s: 0.95 }, { fill: 'drop', stroke: 'ink', sw: 1 })
  ]
})

const EMPTY_DRAWING = deepFreeze({ w: 48, h: 48, shapes: [] })

const TWINE = { kind: 'rect', x: -5, y: -9, w: 10, h: 5, rx: 1.5, fill: 'twine', stroke: 'ink', sw: 1.2 }

function twineAt (x, y) {
  return placeShapes([TWINE], { x, y })[0]
}

// A harvest or a cutting, as it sits on the shelf and in the gift rows: one
// 48 x 48 drawing per plant id of the rules.
const GIFTS = {
  manjericao: [
    lineAt('M0 0L-6 -18M0 0L0 -22M0 0L6 -18', { x: 24, y: 43 }, 'stem', 2.2),
    leafAt('leaf2', 18, 25, -150, 0.8),
    leafAt('leaf2', 30, 25, -30, 0.8),
    leafAt('leaf', 18, 25, -112, 0.8),
    leafAt('leaf', 30, 25, -68, 0.8),
    leafAt('leaf', 24, 21, -90, 0.8),
    twineAt(24, 43)
  ],
  tomate: [
    lineAt('M24 6C23 12 18 15 15 19M24 6C25 13 30 17 33 21M24 6C24 18 23 24 23 29', {}, 'stem', 2.2),
    { kind: 'circle', cx: 14, cy: 26, r: 8, fill: 'tomato', stroke: 'ink', sw: 1.4 },
    { kind: 'circle', cx: 33, cy: 28, r: 8.5, fill: 'tomato', stroke: 'ink', sw: 1.4 },
    { kind: 'circle', cx: 23, cy: 36, r: 8, fill: 'tomato', stroke: 'ink', sw: 1.4 },
    { kind: 'circle', cx: 11.5, cy: 23.5, r: 2, fill: 'tomHi' },
    { kind: 'circle', cx: 30.5, cy: 25.5, r: 2, fill: 'tomHi' },
    { kind: 'circle', cx: 20.5, cy: 33.5, r: 2, fill: 'tomHi' },
    bladeAt('leaf', 24, 7, -20, 0.55),
    bladeAt('leaf2', 24, 7, -160, 0.55)
  ],
  pimenta: [
    lineAt('M21 14L21 8M34 16L34 10', {}, 'stem', 2),
    shapePath('M17 15C13 25 17 37 30 44C24 35 23 26 25 16Z', {}, { fill: 'chili', stroke: 'ink', sw: 1.4 }),
    shapePath('M16 16Q21 11 26 16Z', {}, { fill: 'leaf2', stroke: 'ink', sw: 1 }),
    shapePath('M30 17C28 27 31 36 42 41C37 33 36 26 38 18Z', {}, { fill: 'chili', stroke: 'ink', sw: 1.4 }),
    shapePath('M29 18Q34 13 39 18Z', {}, { fill: 'leaf2', stroke: 'ink', sw: 1 })
  ],
  alecrim: [
    lineAt(sprigPath(0, -9, -34, 3), { x: 24, y: 43 }, 'ros', 2.2),
    lineAt(sprigPath(0, 0, -38, 3), { x: 24, y: 43 }, 'ros2', 2.2),
    lineAt(sprigPath(0, 9, -34, 3), { x: 24, y: 43 }, 'ros', 2.2),
    { kind: 'circle', cx: 15, cy: 9, r: 2, fill: 'flower', stroke: 'ink', sw: 0.8 },
    { kind: 'circle', cx: 33, cy: 9, r: 2, fill: 'flower', stroke: 'ink', sw: 0.8 },
    twineAt(24, 43)
  ],
  samambaia: [
    shapePath(PATHS.frondBack, { x: 24, y: 43, r: -40, s: 0.62 }, { fill: 'fern2', stroke: 'ink', sw: 0.8 }),
    shapePath(PATHS.frondBack, { x: 24, y: 43, r: -40, s: 0.62, flip: true }, { fill: 'fern2', stroke: 'ink', sw: 0.8 }),
    shapePath(PATHS.frondUp, { x: 23, y: 43, s: 0.75 }, { fill: 'fern', stroke: 'ink', sw: 0.8 }),
    lineAt(PATHS.frondUpLine, { x: 23, y: 43, s: 0.75 }, 'fernLine', 0.9),
    twineAt(24, 43)
  ],
  espada: [
    shapePath(PATHS.sword, { x: 21, y: 43, r: -12, s: 0.62 }, { fill: 'snakeEdge', stroke: 'ink', sw: 1.2 }),
    shapePath(PATHS.swordCore, { x: 21, y: 43, r: -12, s: 0.62 }, { fill: 'snake' }),
    shapePath(PATHS.sword, { x: 27, y: 43, r: 12, s: 0.55 }, { fill: 'snakeEdge', stroke: 'ink', sw: 1.2 }),
    shapePath(PATHS.swordCore, { x: 27, y: 43, r: 12, s: 0.55 }, { fill: 'snake' }),
    shapePath(PATHS.sword, { x: 24, y: 43, s: 0.75 }, { fill: 'snakeEdge', stroke: 'ink', sw: 1.2 }),
    shapePath(PATHS.swordCore, { x: 24, y: 43, s: 0.75 }, { fill: 'snake' }),
    twineAt(24, 43)
  ]
}

const GIFT_DRAWINGS = deepFreeze(giftsFor(rpc.garden.GARDEN_PLANTS))

function giftsFor (plants) {
  const out = {}
  for (const plant of plants) out[plant.id] = { w: 48, h: 48, shapes: GIFTS[plant.id] || [] }
  return out
}

// An item from a record is untrusted: anything but a plant id of the rules,
// including a proxy or a throwing getter, is the empty drawing.
export function giftDrawing (item) {
  try {
    if (typeof item !== 'string' || !Object.hasOwn(GIFT_DRAWINGS, item)) return EMPTY_DRAWING
    return GIFT_DRAWINGS[item]
  } catch {
    return EMPTY_DRAWING
  }
}

// The Barraquinha: a striped awning over a counter with the week's harvest.
function stallShapes () {
  const shapes = [
    { kind: 'rect', x: 14, y: 28, w: 6, h: 60, fill: 'wood', stroke: 'ink', sw: 1.5 },
    { kind: 'rect', x: 338, y: 28, w: 6, h: 60, fill: 'wood', stroke: 'ink', sw: 1.5 }
  ]
  for (let i = 0; i < 9; i++) {
    const x = 9 + i * 38
    const w = i === 8 ? 36 : 38
    const fill = i % 2 === 0 ? 'awning' : 'awningAlt'
    shapes.push({ kind: 'rect', x, y: 6, w, h: 22, fill, stroke: 'ink', sw: 1.5 })
    shapes.push(shapePath('M' + x + ' 28Q' + (x + w / 2) + ' 46 ' + (x + w) + ' 28Z', {}, { fill, stroke: 'ink', sw: 1.5 }))
  }
  for (const [cx, cy, r] of [[62, 58, 6], [74, 56, 6], [86, 58, 6], [68, 50, 5.5], [80, 49, 5.5]]) {
    shapes.push({ kind: 'circle', cx, cy, r, fill: 'tomato', stroke: 'ink', sw: 1.2 })
  }
  shapes.push(leafAt('leaf', 160, 62, -140, 0.9))
  shapes.push(leafAt('leaf2', 166, 62, -100, 0.95))
  shapes.push(leafAt('leaf', 172, 62, -75, 0.95))
  shapes.push(leafAt('leaf2', 178, 62, -40, 0.9))
  for (const d of [
    'M262 46C258 54 262 62 274 66C269 59 268 53 270 47Z',
    'M278 46C276 54 279 62 290 66C285 59 284 53 286 47Z',
    'M292 48C292 55 296 62 306 64C301 58 300 53 301 48Z'
  ]) shapes.push(shapePath(d, {}, { fill: 'chili', stroke: 'ink', sw: 1.2 }))
  for (const [x, w] of [[44, 60], [140, 60], [252, 62]]) {
    shapes.push({ kind: 'rect', x, y: 60, w, h: 12, rx: 2, fill: 'woodHi', stroke: 'ink', sw: 1.5 })
  }
  shapes.push({ kind: 'rect', x: 8, y: 72, w: 342, h: 20, rx: 3, fill: 'woodHi', stroke: 'ink', sw: 1.8 })
  return shapes
}

export const STALL_DRAWING = deepFreeze({ w: 358, h: 96, shapes: stallShapes() })

// Plain style objects (no StyleSheet, so they run in the tests) for the
// sticker cards and buttons: a cream card with an ink edge and a hard ink
// shadow drawn by a second view, never elevation. Every target is at least
// 44 tall. The face grows with its wrap, so a card that a taller neighbour
// stretched in a row keeps its shadow just under it.
export const HIT = 44
export const CARD_RADIUS = 16
export const LIFT = 3

export function gardenCardStyles (tokens) {
  const t = tokens && typeof tokens === 'object' ? tokens : GARDEN_LIGHT
  return {
    cardWrap: { paddingBottom: LIFT },
    cardLift: { position: 'absolute', left: 0, right: 0, top: LIFT, bottom: 0, borderRadius: CARD_RADIUS, backgroundColor: t.lift },
    card: { flexGrow: 1, backgroundColor: t.card, borderColor: t.cardInk, borderWidth: 1.5, borderRadius: CARD_RADIUS, paddingHorizontal: 12, paddingVertical: 10, minHeight: HIT },
    cardPressed: { transform: [{ translateY: 2 }] },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: HIT },
    rowArt: { width: 52, height: 52, borderRadius: 14, backgroundColor: t.card, borderColor: t.cardInk, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
    rowText: { flex: 1, minWidth: 0 },
    rowName: { fontSize: 15, fontWeight: '700', lineHeight: 20, color: t.text },
    rowSub: { fontSize: 13, fontWeight: '400', lineHeight: 18, color: t.muted },
    section: { fontSize: 13, fontWeight: '700', lineHeight: 16, letterSpacing: 0.8, textTransform: 'uppercase', color: t.muted },
    tile: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 64 },
    tileName: { fontSize: 15, fontWeight: '700', lineHeight: 20, color: t.text },
    tileSub: { fontSize: 13, fontWeight: '400', lineHeight: 18, color: t.muted },
    tileSubHot: { fontSize: 13, fontWeight: '600', lineHeight: 18, color: t.accentText },
    note: { fontSize: 13, fontWeight: '400', lineHeight: 18, color: t.muted },
    btnWrap: { paddingBottom: 2, alignSelf: 'stretch' },
    btnLift: { position: 'absolute', left: 0, right: 0, top: 2, bottom: 0, borderRadius: HIT / 2, backgroundColor: t.lift },
    btn: { minHeight: HIT, paddingHorizontal: 18, paddingVertical: 10, borderRadius: HIT / 2, borderWidth: 1.5, borderColor: t.cardInk, alignItems: 'center', justifyContent: 'center' },
    btnPrimary: { backgroundColor: t.accent },
    btnSecondary: { backgroundColor: t.card },
    btnDanger: { backgroundColor: t.card, borderColor: t.danger },
    btnPressed: { transform: [{ translateY: 2 }] },
    btnOff: { opacity: 0.45 },
    btnLabel: { fontSize: 15, fontWeight: '700', lineHeight: 20, color: t.onAccent, textAlign: 'center' },
    btnLabelSecondary: { color: t.text },
    btnLabelDanger: { color: t.danger }
  }
}

function ownValue (obj, key) {
  try {
    if (obj === null || typeof obj !== 'object') return undefined
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc || !('value' in desc)) return undefined
    return desc.value
  } catch {
    return undefined
  }
}

function deepFreeze (value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
