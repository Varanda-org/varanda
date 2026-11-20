// Balcony for the Varandinha, "Pôr do sol": a telha roof on wooden posts,
// a sunset sky over the city (a moonlit one at night), a railing whose cap
// holds the back row, a tiled floor for the front row, and six pots. Shapes
// name palette keys and follow the vocabulary of gardenStyle.js, so one
// drawing serves both schemes. Geometry is original to this module.

import rpc from '@varanda/rpc'
import {
  GARDEN_DARK,
  GARDEN_LIGHT,
  PATHS,
  THIRST_BADGE,
  bladeAt,
  dotRow,
  gardenTokens,
  leafAt,
  lineAt,
  placePath,
  placeShapes,
  shapePath,
  sparkAt,
  sprigPath,
  thirsty,
  veinAt
} from './gardenStyle.js'

export const LIGHT = GARDEN_LIGHT
export const DARK = GARDEN_DARK

export function gardenPalette (scheme) {
  return gardenTokens(scheme)
}

// Past this span the six pots stop reading as a balcony, so a wider frame
// keeps the scene at this width and sits it in the middle.
const MAX_WIDTH = 420
// A pot narrower than this cannot hold a 44 x 44 hit box (the slot is never
// shorter than wide), so a frame too small for it draws nothing.
const MIN_HIT = 44
// Same ids and order as the rules. Where each one sits is this module's choice.
export const DECOR_IDS = deepFreeze(['rede', 'varal', 'gato', 'pisca'])
// Four ids is the whole set. Only this many entries are read, so a hostile
// length spends no time; a hole or an accessor reads as no id.
const DECOR_LIST_MAX = 8

// A pot slot is potW wide and 115% as tall. Its drawing uses this box: the
// 0..100 square in the middle, with room above for a tall plant and below
// for the stage dots. The base of the pot is local y 95.
export const POT_BOX = deepFreeze({ x: 0, y: -7.5, w: 100, h: 115 })
const POT_BASE_Y = 95
// The plant grows from the soil, and sways about it.
export const SOIL_Y = 54.5
const SOIL_X = 50

export function gardenLayout (width, opts) {
  const sceneW = Number.isFinite(width) && width > 0 ? Math.round(width) : 0
  const inner = Math.min(sceneW, MAX_WIDTH)
  const ox = Math.round((sceneW - inner) / 2)
  if (inner === 0) return emptyLayout(sceneW)

  const gapX = Math.max(8, Math.round(inner * 3 / 100))
  const margin = Math.max(12, Math.round(inner * 4 / 100))
  const potW = Math.max(0, Math.floor((inner - margin * 2 - gapX * 2) / 3))
  if (potW < MIN_HIT) return emptyLayout(sceneW)
  const potH = Math.round(potW * 115 / 100)
  const rowGap = Math.max(8, Math.round(inner * 2 / 100))
  const pad = Math.round((inner - (potW * 3 + gapX * 2)) / 2)
  const roofH = Math.max(16, Math.round(inner * 34 / 390))
  const capH = Math.max(8, Math.round(inner * 3 / 100))
  const footH = Math.max(4, Math.round(inner * 15 / 1000))
  const postW = Math.max(6, Math.round(inner * 25 / 1000))
  const bottom = Math.max(12, Math.round(inner * 4 / 100))
  // An enfeite that is on gets a band of its own, so nothing it draws can
  // cover a pot. A band above pushes the next one down: on or off is the
  // only choice.
  const chosen = decorChosen(opts)
  const stripH = chosen.has('pisca') ? Math.max(12, Math.round(inner * 6 / 100)) : 0
  const wallH = (chosen.has('rede') || chosen.has('varal')) ? Math.round(potW * 50 / 100) : 0
  const floorH = chosen.has('gato') ? Math.round(potW * 45 / 100) : 0
  // The lights hang from the beam; the hammock and the line hang below them.
  const stripY = roofH
  const wallY = stripY + stripH
  const backY = wallY + wallH + rowGap
  const frontY = backY + potH + rowGap
  const bandY = frontY + potH + 4
  const height = floorH > 0 ? bandY + floorH + bottom : frontY + potH + bottom
  // The back row stands on the cap: a pot's base, local y 95, lands on its top.
  const capY = backY + Math.round(potH * (POT_BASE_Y - POT_BOX.y) / POT_BOX.h)
  const floorY = frontY + Math.round(potW * 30 / 100)
  const wall = { x: ox, y: 0, w: inner, h: floorY }
  const floor = { x: ox, y: floorY, w: inner, h: height - floorY }
  const roof = { x: ox, y: 0, w: inner, h: roofH }
  const railing = balusters(ox, inner, postW, capY + capH, floorY - footH)
  railing.push({ x: ox, y: floorY - footH, w: inner, h: footH, fill: 'wood' })
  railing.push({ x: ox, y: capY, w: inner, h: capH, fill: 'woodHi' })
  railing.push({ x: ox, y: roofH, w: postW, h: floorY - roofH, fill: 'wood' })
  railing.push({ x: ox + inner - postW, y: roofH, w: postW, h: floorY - roofH, fill: 'wood' })
  const pots = []
  for (let index = 0; index < 6; index++) {
    const col = index % 3
    const x = ox + pad + col * (potW + gapX)
    const y = index < 3 ? backY : frontY
    pots.push({
      index,
      x,
      y,
      w: potW,
      h: potH,
      hit: { x, y, w: potW, h: potH }
    })
  }
  const scene = { width: sceneW, height, wall, floor, roof, horizon: capY, railing, pots }
  if (chosen.size === 0) return deepFreeze(scene)
  scene.decor = decorRects(chosen, {
    ox,
    pad,
    potW,
    gapX,
    stripY,
    stripH,
    wallY,
    wallH,
    bandY,
    floorH
  })
  return deepFreeze(scene)
}

// Slim boards between the posts, spaced evenly and centred.
function balusters (ox, inner, postW, top, bottom) {
  const out = []
  const h = bottom - top
  if (h <= 0) return out
  const w = Math.max(4, Math.round(inner * 7 / 390))
  const pitch = Math.max(w * 2, Math.round(inner * 21 / 390))
  const span = inner - postW * 2
  const count = Math.max(0, Math.floor((span - w) / pitch) + 1)
  const start = ox + postW + Math.round((span - ((count - 1) * pitch + w)) / 2)
  for (let i = 0; i < count; i++) out.push({ x: start + i * pitch, y: top, w, h, fill: 'wood' })
  return out
}

function emptyLayout (sceneW) {
  const pots = []
  for (let index = 0; index < 6; index++) {
    pots.push({ index, x: 0, y: 0, w: 0, h: 0, hit: { x: 0, y: 0, w: 0, h: 0 } })
  }
  return deepFreeze({
    width: sceneW,
    height: 0,
    wall: { x: 0, y: 0, w: 0, h: 0 },
    floor: { x: 0, y: 0, w: 0, h: 0 },
    roof: { x: 0, y: 0, w: 0, h: 0 },
    horizon: 0,
    railing: [],
    pots
  })
}

// opts may be hostile. Only an own data array counts: a getter or a throw
// is a balcony with no enfeites, and an id is only on or off.
function decorChosen (opts) {
  const chosen = new Set()
  const list = decorItems(opts)
  if (!list) return chosen
  for (const id of list) {
    if (typeof id === 'string' && DECOR_IDS.includes(id)) chosen.add(id)
  }
  return chosen
}

function decorItems (opts) {
  try {
    const value = ownValue(opts, 'decor')
    if (!Array.isArray(value)) return null
    const lenDesc = Object.getOwnPropertyDescriptor(value, 'length')
    const len = lenDesc && lenDesc.value
    if (!Number.isSafeInteger(len) || len < 0) return null
    const out = []
    const end = Math.min(len, DECOR_LIST_MAX)
    for (let i = 0; i < end; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i))
      if (desc && 'value' in desc && desc.enumerable) out.push(desc.value)
    }
    return out
  } catch {
    return null
  }
}

// Canonical order, so the same set always freezes the same way. The rect comes
// from the frame, never from a coordinate on opts.
function decorRects (chosen, box) {
  const rowW = box.potW * 3 + box.gapX * 2
  const halfW = Math.floor((rowW - box.gapX) / 2)
  const rects = {}
  if (chosen.has('rede')) {
    rects.rede = { x: box.ox + box.pad, y: box.wallY, w: halfW, h: box.wallH }
  }
  if (chosen.has('varal')) {
    rects.varal = {
      x: box.ox + box.pad + rowW - halfW,
      y: box.wallY,
      w: halfW,
      h: box.wallH
    }
  }
  if (chosen.has('gato')) {
    rects.gato = {
      x: box.ox + box.pad + 2 * (box.potW + box.gapX),
      y: box.bandY,
      w: box.potW,
      h: box.floorH
    }
  }
  if (chosen.has('pisca')) {
    rects.pisca = { x: box.ox + box.pad, y: box.stripY, w: rowW, h: box.stripH }
  }
  return rects
}

// The scene behind the pots, in scene pixels: sky, sun or moon, city, floor
// and roof. Stars and lit windows are drawn only at night, so the day draws
// no hidden nodes. The railing comes after the enfeites, from the layout.
const STARS = [[0.08, 0.34], [0.2, 0.62], [0.31, 0.2], [0.42, 0.5], [0.55, 0.28], [0.68, 0.12], [0.8, 0.44], [0.93, 0.22]]
// City outlines from a 390 wide frame whose cap top sits at y 190.
const CITY = 'M0 196V174H18L30 163L42 174H58V166H76V157L84 150L92 157V174H112L126 161L140 174H150V167H172V174H186L198 164L210 174H230V140L237 130L244 140V174H262V165H284L296 155L308 165V174H330L343 161L356 174H372V167H390V196Z'
const CITY_NEAR = 'M0 200V186H36L50 177L64 186H118V180H158V186H206L220 175L234 186H298V181H338L352 172L366 181H390V200Z'
const WINDOWS = [[20, 178, 4, 5], [64, 168, 3, 4], [100, 177, 4, 5], [156, 170, 4, 4], [235, 146, 3, 6], [268, 170, 4, 4], [316, 177, 4, 5], [378, 172, 3, 4]]
const TILE_TOPS = [40, 100, 160, 230, 290, 350]
const TILE_FEET = [1, 76, 151, 239, 314, 389]
const TILE_ROWS = [0.27, 0.56, 0.88]
const SCALLOPS = 15

const BACKDROPS = new WeakMap()

export function backdropShapes (layout, scheme) {
  const night = scheme === 'dark'
  try {
    if (layout === null || typeof layout !== 'object' || !Object.isFrozen(layout)) return NONE
    let entry = BACKDROPS.get(layout)
    if (entry === undefined) {
      entry = {}
      BACKDROPS.set(layout, entry)
    }
    const key = night ? 'dark' : 'light'
    if (entry[key] === undefined) entry[key] = deepFreeze(drawBackdrop(layout, night))
    return entry[key]
  } catch {
    return NONE
  }
}

// The railing bars of a layout as shapes, outlined in ink, drawn over the
// enfeites. The cap gets rounded ends.
const RAILS = new WeakMap()

export function railShapes (layout) {
  try {
    if (layout === null || typeof layout !== 'object' || !Object.isFrozen(layout)) return NONE
    let shapes = RAILS.get(layout)
    if (shapes === undefined) {
      const bars = ownValue(layout, 'railing')
      shapes = deepFreeze(Array.isArray(bars)
        ? bars.filter(box).map((bar) => ({
          kind: 'rect',
          x: bar.x,
          y: bar.y,
          w: bar.w,
          h: bar.h,
          rx: bar.fill === 'woodHi' ? Math.min(3, bar.h / 2) : 0,
          fill: bar.fill,
          stroke: 'ink',
          sw: 1.5
        }))
        : [])
      RAILS.set(layout, shapes)
    }
    return shapes
  } catch {
    return NONE
  }
}

function drawBackdrop (layout, night) {
  const wall = ownValue(layout, 'wall')
  const floor = ownValue(layout, 'floor')
  const roof = ownValue(layout, 'roof')
  const horizon = ownValue(layout, 'horizon')
  if (!box(wall) || !box(floor) || !box(roof) || typeof horizon !== 'number') return []
  if (wall.w === 0 || wall.h === 0) return []
  const ox = wall.x
  const w = wall.w
  const k = w / 390
  const out = []
  out.push({ kind: 'rect', x: ox, y: 0, w, h: wall.h, fill: 'sky2', grad: 'sky' })
  const skyTop = roof.h
  const skyH = Math.max(0, horizon - skyTop)
  if (night) {
    for (const [fx, fy] of STARS) {
      out.push({ kind: 'circle', cx: r2(ox + fx * w), cy: r2(skyTop + fy * skyH * 0.6), r: r2(Math.max(0.8, 1.2 * k)), fill: 'star' })
    }
  }
  const orbX = r2(ox + w * 0.67)
  const orbY = r2(horizon - skyH * 0.42)
  const orbR = r2(Math.max(8, 22 * k))
  out.push({ kind: 'circle', cx: orbX, cy: orbY, r: r2(orbR * 3.2), fill: 'halo', grad: 'halo' })
  out.push({ kind: 'circle', cx: orbX, cy: orbY, r: orbR, fill: 'orb' })
  if (night) {
    out.push({ kind: 'circle', cx: r2(orbX - orbR * 0.35), cy: r2(orbY - orbR * 0.2), r: r2(orbR * 0.22), fill: 'halo', opacity: 0.5 })
    out.push({ kind: 'circle', cx: r2(orbX + orbR * 0.3), cy: r2(orbY + orbR * 0.35), r: r2(orbR * 0.16), fill: 'halo', opacity: 0.5 })
  }
  const city = { x: ox, y: r2(horizon - 190 * k), s: k }
  out.push({ kind: 'path', d: placePath(CITY, city), fill: 'city' })
  if (night) {
    for (const [x, y, ww, hh] of WINDOWS) {
      out.push({ kind: 'rect', x: r2(ox + x * k), y: r2(horizon + (y - 190) * k), w: r2(ww * k), h: r2(hh * k), fill: 'window' })
    }
  }
  out.push({ kind: 'path', d: placePath(CITY_NEAR, city), fill: 'city2' })
  out.push({ kind: 'rect', x: ox, y: floor.y, w, h: floor.h, fill: 'floor' })
  const shadeH = r2(Math.max(4, 10 * k))
  out.push({ kind: 'rect', x: ox, y: floor.y, w, h: shadeH, fill: 'floorShade' })
  let tiles = ''
  for (const f of TILE_ROWS) {
    const y = r2(floor.y + shadeH + f * (floor.h - shadeH))
    tiles += 'M' + ox + ' ' + y + 'L' + (ox + w) + ' ' + y
  }
  const tileTop = r2(floor.y + shadeH)
  const tileFoot = floor.y + floor.h
  for (let i = 0; i < TILE_TOPS.length; i++) {
    tiles += 'M' + r2(ox + TILE_TOPS[i] * k) + ' ' + tileTop + 'L' + r2(ox + TILE_FEET[i] * k) + ' ' + tileFoot
  }
  out.push({ kind: 'path', d: tiles, fill: 'none', stroke: 'tile', sw: 1.5 })
  // Telha: tiles, seams, the beam, then the scalloped edge over the beam.
  const rk = roof.h / 34
  const tileH = r2(22 * rk)
  out.push({ kind: 'rect', x: ox, y: 0, w, h: tileH, fill: 'roof' })
  let seams = ''
  const pitch = w / SCALLOPS
  for (let i = 1; i < SCALLOPS; i++) {
    const x = r2(ox + i * pitch)
    seams += 'M' + x + ' 0L' + x + ' ' + r2(20 * rk)
  }
  out.push({ kind: 'path', d: seams, fill: 'none', stroke: 'seam', sw: 1.5 })
  out.push({ kind: 'rect', x: ox, y: r2(26 * rk), w, h: r2(8 * rk), fill: 'wood', stroke: 'ink', sw: 1.5 })
  const edgeY = r2(22 * rk)
  const dip = r2(9 * rk * 2)
  let edge = 'M' + ox + ' ' + r2(16 * rk) + 'L' + (ox + w) + ' ' + r2(16 * rk) + 'L' + (ox + w) + ' ' + edgeY
  for (let i = SCALLOPS; i > 0; i--) {
    const x1 = ox + (i - 1) * pitch
    const mid = ox + (i - 0.5) * pitch
    edge += 'Q' + r2(mid) + ' ' + r2(edgeY + dip) + ' ' + r2(x1) + ' ' + edgeY
  }
  edge += 'Z'
  out.push({ kind: 'path', d: edge, fill: 'roof2', stroke: 'ink', sw: 1.5 })
  return out
}

// Clay pot on its shadow: body, shade, highlight, ink outline, rim.
export const POT_SHAPES = deepFreeze([
  { kind: 'ellipse', cx: 50, cy: 95, rx: 27, ry: 3.6, fill: 'shadow', opacity: 0.22 },
  { kind: 'path', d: 'M24.8 59L75.2 59L68.9 95L31.1 95Z', fill: 'pot' },
  { kind: 'path', d: 'M57.2 59L75.2 59L68.9 95L55.4 95Z', fill: 'potShade' },
  { kind: 'path', d: 'M30.2 63.5L34.7 63.5L36.5 89.6L33.8 89.6Z', fill: 'potHi' },
  { kind: 'path', d: 'M24.8 59L75.2 59L68.9 95L31.1 95Z', fill: 'none', stroke: 'ink', sw: 1.6 },
  { kind: 'rect', x: 21.2, y: 50.9, w: 57.6, h: 9, rx: 2.7, fill: 'rim', stroke: 'ink', sw: 1.6 }
])

export const SOIL_DRY = deepFreeze([
  { kind: 'ellipse', cx: 50, cy: SOIL_Y, rx: 23.4, ry: 2.9, fill: 'soilDry', stroke: 'ink', sw: 0.8 }
])

export const SOIL_WET = deepFreeze([
  { kind: 'ellipse', cx: 50, cy: SOIL_Y, rx: 23.4, ry: 2.9, fill: 'soilWet', stroke: 'ink', sw: 0.8 }
])

export const EMPTY = deepFreeze(POT_SHAPES.concat(SOIL_DRY))

// The warm light behind a ripe plant. The view pulses its opacity.
export const RIPE_GLOW = deepFreeze({ kind: 'circle', cx: 50, cy: 33, r: 32, fill: 'glow', grad: 'glow' })

// Plants are drawn about the soil centre in the units of the prototype,
// then shrunk by K into the pot box.
const K = 0.9

function at (px, py, r, s) {
  return { x: SOIL_X + K * px, y: SOIL_Y + K * py, r: r || 0, s: K * (s || 1) }
}

function leaf (fill, px, py, r, s) {
  const p = at(px, py, r, s)
  return leafAt(fill, p.x, p.y, p.r, p.s)
}

function blade (fill, px, py, r, s) {
  const p = at(px, py, r, s)
  return bladeAt(fill, p.x, p.y, p.r, p.s)
}

function vein (px, py, r, s) {
  const p = at(px, py, r, s)
  return veinAt(p.x, p.y, p.r, p.s)
}

function line (d, stroke, sw, px, py, r, s) {
  return lineAt(d, at(px || 0, py || 0, r, s), stroke, sw)
}

function filled (d, style, px, py, r, s, flip) {
  const p = at(px || 0, py || 0, r, s)
  if (flip) p.flip = true
  return shapePath(d, p, style)
}

function spark (px, py, s) {
  const p = at(px, py, 0, s)
  return sparkAt(p.x, p.y, p.s)
}

function local (shapes) {
  return placeShapes(shapes, { x: SOIL_X, y: SOIL_Y, s: K })
}

// A seed half in the soil with the tip of a root showing.
function seed (fillKey) {
  return [
    ...local([{ kind: 'ellipse', cx: -1, cy: -1, rx: 4, ry: 2.6, fill: fillKey, stroke: 'ink', sw: 1 }]),
    line('M1 -3Q3 -7 6 -8', 'stem', 1.6)
  ]
}

function leafWithVein (fill, px, py, r, s) {
  return [leaf(fill, px, py, r, s), vein(px, py, r, s)]
}

function chili (px, py, r, s) {
  return [
    filled(PATHS.chili, { fill: 'chili', stroke: 'ink', sw: 1.2 }, px, py, r, s),
    filled(PATHS.calyx, { fill: 'leaf2', stroke: 'ink', sw: 0.8 }, px, py, r, s)
  ]
}

function sword (px, r, s) {
  return [
    filled(PATHS.sword, { fill: 'snakeEdge', stroke: 'ink', sw: 1.2 }, px, 0, r, s),
    filled(PATHS.swordCore, { fill: 'snake' }, px, 0, r, s)
  ]
}

function frond (path, linePath, fillKey, px, r, s, flip) {
  const style = { fill: fillKey, stroke: 'ink', sw: 0.8 }
  const p = at(px || 0, 0, r, s)
  if (flip) p.flip = true
  return [shapePath(path, p, style), lineAt(linePath, p, 'fernLine', 0.9)]
}

function tomatoAt (cx, cy, r) {
  return local([
    { kind: 'circle', cx, cy, r, fill: 'tomato', stroke: 'ink', sw: 1.2 },
    { kind: 'circle', cx: cx - 2, cy: cy - 2, r: r * 0.27, fill: 'tomHi' }
  ])
}

// Four stages per plant (semente, broto, crescendo, pronta) in the pot box.
// potDrawing adds the pot and the soil; these lists are only the plant.
const DRAWINGS = {
  manjericao: [
    seed('leaf2'),
    [
      line('M0 0C0 -8 1 -13 0 -19', 'stem', 2),
      leaf('leaf', 0, -17, -155, 0.7),
      leaf('leaf2', 0, -18, -25, 0.7)
    ],
    [
      line('M0 0L-7 -16M0 0L0 -24M0 0L7 -16', 'stem', 2.2),
      leaf('leaf2', -7, -16, -165, 0.75),
      leaf('leaf2', 7, -16, -15, 0.75),
      leaf('leaf', 0, -23, -130, 0.75),
      leaf('leaf', 0, -23, -50, 0.75),
      leaf('leaf', 0, -24, -90, 0.7)
    ],
    [
      line('M0 0L-10 -24M0 0L0 -32M0 0L10 -24', 'stem', 2.4),
      ...leafWithVein('leaf2', -4, -10, -165, 1),
      ...leafWithVein('leaf2', 4, -10, -15, 1),
      ...leafWithVein('leaf', -10, -24, -175, 1),
      ...leafWithVein('leaf', 10, -24, -5, 1),
      ...leafWithVein('leaf2', -10, -24, -125, 1),
      ...leafWithVein('leaf2', 10, -24, -55, 1),
      ...leafWithVein('leaf', 0, -31, -130, 0.95),
      ...leafWithVein('leaf', 0, -31, -50, 0.95),
      ...leafWithVein('leaf', 0, -32, -90, 0.9),
      spark(26, -46, 1),
      spark(-27, -40, 0.6)
    ]
  ],
  tomate: [
    seed('tomHi'),
    [
      line('M0 0C0 -8 1 -13 0 -19', 'stem', 2),
      blade('leaf', 0, -17, -155, 0.7),
      blade('leaf2', 0, -18, -25, 0.7)
    ],
    [
      line('M0 0C-2 -12 3 -22 0 -34', 'stem', 2.2),
      blade('leaf', -1, -10, -165, 0.8),
      blade('leaf2', 1, -17, -25, 0.8),
      blade('leaf2', 1, -27, -150, 0.75),
      blade('leaf', 0, -33, -40, 0.7),
      ...local([
        { kind: 'circle', cx: 9, cy: -21, r: 2.4, fill: 'spark', stroke: 'ink', sw: 0.8 },
        { kind: 'circle', cx: -9, cy: -29, r: 2.4, fill: 'spark', stroke: 'ink', sw: 0.8 }
      ])
    ],
    [
      ...local([{ kind: 'rect', x: 10, y: -55, w: 3.5, h: 55, rx: 1, fill: 'stake', stroke: 'ink', sw: 1 }]),
      line('M0 0C-3 -14 4 -26 0 -46', 'stem', 2.4),
      blade('leaf', -1, -10, -165, 0.85),
      blade('leaf2', 1, -17, -25, 0.85),
      blade('leaf2', 1, -28, -150, 0.8),
      blade('leaf', 0, -36, -32, 0.8),
      blade('leaf', 0, -45, -105, 0.7),
      ...tomatoAt(-11, -22, 6),
      ...tomatoAt(-5, -31, 5.5),
      ...tomatoAt(-15, -34, 5),
      ...tomatoAt(12, -12, 5.5),
      spark(22, -48, 1),
      spark(-25, -46, 0.6)
    ]
  ],
  pimenta: [
    seed('chili'),
    [
      line('M0 0C0 -6 1 -10 0 -15', 'stem', 2),
      leaf('leaf', 0, -14, -150, 0.6),
      leaf('leaf2', 0, -15, -30, 0.6)
    ],
    [
      line('M0 0L0 -30M0 -12L-9 -21M0 -18L9 -27', 'stem', 2.2),
      leaf('leaf', -9, -21, -160, 0.7),
      leaf('leaf2', 9, -27, -20, 0.7),
      leaf('leaf2', 0, -12, -20, 0.65),
      leaf('leaf', 0, -30, -100, 0.65),
      ...local([
        { kind: 'circle', cx: -4, cy: -27, r: 2.2, fill: 'badge', stroke: 'ink', sw: 0.8 },
        { kind: 'circle', cx: 5, cy: -15, r: 2.2, fill: 'badge', stroke: 'ink', sw: 0.8 }
      ])
    ],
    [
      line('M0 0L0 -38M0 -14L-12 -26M0 -22L12 -32', 'stem', 2.4),
      ...leafWithVein('leaf', -12, -26, -165, 0.8),
      ...leafWithVein('leaf2', 12, -32, -15, 0.8),
      ...leafWithVein('leaf2', 0, -14, -25, 0.75),
      ...leafWithVein('leaf', 0, -38, -110, 0.75),
      ...leafWithVein('leaf', 0, -38, -70, 0.7),
      ...chili(-8, -22, 15, 0.8),
      ...chili(8, -28, -10, 0.85),
      ...chili(-2, -12, 5, 0.7),
      spark(24, -44, 1),
      spark(-26, -40, 0.6)
    ]
  ],
  alecrim: [
    seed('ros'),
    [
      line(sprigPath(0, 0, -16, 2), 'ros2', 2)
    ],
    [
      line(sprigPath(-8, -11, -26, 3), 'ros', 2),
      line(sprigPath(0, 1, -32, 4), 'ros2', 2),
      line(sprigPath(8, 11, -22, 2), 'ros', 2)
    ],
    [
      line(sprigPath(-12, -16, -36, 4), 'ros', 2.2),
      line(sprigPath(-3, -2, -46, 5), 'ros2', 2.2),
      line(sprigPath(7, 11, -40, 4), 'ros', 2.2),
      line(sprigPath(15, 20, -26, 2), 'ros2', 2.2),
      ...local([
        { kind: 'circle', cx: -16, cy: -37, r: 2.6, fill: 'flower', stroke: 'ink', sw: 0.8 },
        { kind: 'circle', cx: -2, cy: -47, r: 2.6, fill: 'flower', stroke: 'ink', sw: 0.8 },
        { kind: 'circle', cx: 11, cy: -41, r: 2.6, fill: 'flower', stroke: 'ink', sw: 0.8 }
      ]),
      spark(26, -44, 1),
      spark(-28, -30, 0.6)
    ]
  ],
  samambaia: [
    seed('fern2'),
    [
      line(PATHS.fiddle, 'fern', 2.2, 1, 0, 0, 1.6),
      ...frond(PATHS.frondUp, PATHS.frondUpLine, 'fern', -2, 0, 0.35)
    ],
    [
      ...frond(PATHS.frondSide, PATHS.frondSideLine, 'fern2', 0, -10, 0.6),
      ...frond(PATHS.frondSide, PATHS.frondSideLine, 'fern2', 0, -10, 0.6, true),
      ...frond(PATHS.frondUp, PATHS.frondUpLine, 'fern', -2, 0, 0.7)
    ],
    [
      ...frond(PATHS.frondBack, PATHS.frondBackLine, 'fern2', 0, -38, 1),
      ...frond(PATHS.frondBack, PATHS.frondBackLine, 'fern2', 0, -38, 1, true),
      ...frond(PATHS.frondUp, PATHS.frondUpLine, 'fern', -2, 0, 1),
      ...frond(PATHS.frondSide, PATHS.frondSideLine, 'fern', 0, 0, 1),
      ...frond(PATHS.frondSide, PATHS.frondSideLine, 'fern', 0, 0, 1, true),
      spark(28, -44, 1),
      spark(-30, -36, 0.6)
    ]
  ],
  espada: [
    seed('snake'),
    [
      ...sword(0, 0, 0.35)
    ],
    [
      ...sword(-6, -14, 0.5),
      ...sword(6, 12, 0.45),
      ...sword(0, 0, 0.65)
    ],
    [
      ...sword(-10, -20, 0.6),
      ...sword(10, 18, 0.55),
      ...sword(-5, -8, 0.75),
      ...sword(5, 9, 0.7),
      ...sword(0, 0, 0.85),
      spark(24, -46, 1),
      spark(-26, -40, 0.6)
    ]
  ]
}

export const PLANT_STAGES = deepFreeze(stagesFor(rpc.garden.GARDEN_PLANTS))

// A view is untrusted: only own data properties are read, and any throw is
// an empty pot. Wet soil is used only when dry is exactly false.
export function potDrawing (view) {
  const base = potBase(view)
  const plant = plantShapes(view)
  if (plant.length === 0) return base
  return deepFreeze(base.concat(plant))
}

// The still part: pot and soil. An unreadable view is an empty pot.
export function potBase (view) {
  const drawn = resolve(view)
  return drawn ? drawn.base : EMPTY
}

// The part that sways: only the stage drawing, empty for an unreadable view.
export function plantShapes (view) {
  const drawn = resolve(view)
  return drawn ? drawn.plant : NONE
}

// What the pot says about itself, drawn still over the plant: four stage
// dots under the pot and, when it can take water now, the drop badge. An
// empty or unreadable pot has none.
const DOT_Y = 101.5
const BADGE_AT = { x: 69, y: 27, s: 0.9 }
const BADGE = deepFreeze(placeShapes(THIRST_BADGE.shapes, BADGE_AT))

export function potCues (view) {
  const drawn = resolve(view)
  if (!drawn) return NONE
  const dots = dotRow(view, 50, DOT_Y, 3.6, 10)
  return deepFreeze(thirsty(view) ? dots.concat(BADGE) : dots.slice())
}

const NONE = deepFreeze([])

const BASES = deepFreeze({ dry: POT_SHAPES.concat(SOIL_DRY), wet: POT_SHAPES.concat(SOIL_WET) })

function resolve (view) {
  try {
    if (view === null || view === undefined) return null
    const plant = ownValue(view, 'plant')
    const stage = ownValue(view, 'stage')
    const stages = stagesOf(plant)
    if (!stages || !isStage(stage)) return null
    const drawing = stages[stage]
    if (!drawing) return null
    return { base: ownValue(view, 'dry') === false ? BASES.wet : BASES.dry, plant: drawing }
  } catch {
    return null
  }
}

function stagesFor (plants) {
  const out = {}
  for (const plant of plants) out[plant.id] = DRAWINGS[plant.id]
  return out
}

function stagesOf (plant) {
  if (typeof plant !== 'string') return null
  if (!Object.hasOwn(PLANT_STAGES, plant)) return null
  const stages = PLANT_STAGES[plant]
  return Array.isArray(stages) ? stages : null
}

function isStage (stage) {
  return stage === 0 || stage === 1 || stage === 2 || stage === 3
}

function box (value) {
  return value !== null && typeof value === 'object' &&
    typeof value.x === 'number' && typeof value.y === 'number' &&
    typeof value.w === 'number' && typeof value.h === 'number'
}

function r2 (n) {
  const v = Math.round(n * 100) / 100
  return Object.is(v, -0) ? 0 : v
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
