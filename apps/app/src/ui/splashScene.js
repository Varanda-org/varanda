// The splash scene (a varanda with the chair, above a petit-pavê street
// with motifs from several Brazilian cities) as plain path data and pixel
// boxes. Two renderers draw it: the react-native-svg component and the static
// HTML overlay that paints before the bundle runs. Keeping the geometry and
// the placement here, pure and deterministic, is what lets both show the same
// picture. Shapes name palette keys, not colours, so one geometry serves the
// light and the dark scheme.

import { SLIDES } from './splashMotion.js'

// Heights of the scene bands at scale 1, bottom to top.
export const SCENE = deepFreeze({
  rua: 36,
  kerb: 6,
  near: 96,
  far: 48,
  floor: 12,
  wall: 132,
  roof: 30,
  // Open sky above the roof, room for the sun and the birds.
  sky: 80,
  varandaWidth: 232,
  // About 1.2 times the varanda, so the araucária reads as a tree beside it.
  tree: 208,
  chair: 116,
  chairSink: 10,
  // The splash word sits outside the scaled scene block, so this is not
  // multiplied by k; its width follows LETTERING's viewBox.
  letteringHeight: 34
})

export const SCENE_HEIGHT = SCENE.rua + SCENE.kerb + SCENE.near + SCENE.far +
  SCENE.floor + SCENE.wall + SCENE.roof + SCENE.sky

// These k keep both tile widths (96 and 128) whole pixels, so tiles laid side
// by side never leave a hairline gap from subpixel rounding. Each threshold
// leaves at least 110 px above the scaled block for the word and the bar.
export const SCALE_STEPS = deepFreeze([
  { minHeight: 600, k: 1 },
  { minHeight: 440, k: 0.75 },
  { minHeight: 330, k: 0.5 },
  { minHeight: 0, k: 0.375 }
])

const NEAR = 96
const FAR_W = 128
const TREE_W = 96
const TREE_H = 208
// The sun's centre sits this far below the roof's top edge, so its glow
// rises behind the roof as on the landing.
const SUN_DROP = 20
const BIRD_W = 20
const BUTTERFLY_W = 24
const BUTTERFLY_H = 20
const BUTTERFLY_SIZE = 28

export function sceneScale (height) {
  const h = Number.isFinite(height) ? height : 0
  for (const step of SCALE_STEPS) if (h >= step.minHeight) return step.k
  return SCALE_STEPS[SCALE_STEPS.length - 1].k
}

// The near strip repeats this sequence of motifs, left to right.
export const NEAR_SEQUENCE = deepFreeze(['araucaria', 'saoPaulo'])

// One strip loop is a whole period of its motifs, so when the animation
// jumps back the same motif is under the seam and nothing visibly skips. The
// per-tile speed is the one SLIDES sets.
export function stripLoops (k) {
  const n = NEAR_SEQUENCE.length
  return Object.freeze({
    near: Object.freeze({ distance: SLIDES.near.tile * n * k, ms: SLIDES.near.ms * n }),
    far: Object.freeze({ distance: SLIDES.far.tile * k, ms: SLIDES.far.ms })
  })
}

// The bbox of every coordinate in CHAIR_PATHS, in its 256 viewBox (the test
// recomputes it). The drawing sits right of the viewBox centre, so placing
// the box by its own centre would push the chair off the varanda's middle.
export const CHAIR_BBOX = deepFreeze({ minX: 45.9, minY: 22.9, maxX: 209.9, maxY: 234.4 })

function meet (box, vbW, vbH) {
  const s = Math.min(box.w / vbW, box.h / vbH)
  return { s, x: box.x + (box.w - vbW * s) / 2, y: box.y + (box.h - vbH * s) / 2 }
}

// The sky's flyers, in scale-1 pixels: each bird's top and width (its height
// is half its width), all above the roof line even at the top of the bob.
export const BIRDS = deepFreeze([
  { y: 22, w: 18 },
  { y: 38, w: 14 },
  { y: 52, w: 16 }
])

// Pixel boxes for the bottom-anchored scene block, y from the block top, so
// both renderers draw the same picture without computing anything. The
// strips keep their exact tile height and the kerb takes the rounding, so
// every edge lands on a whole pixel. The strips carry enough tiles to slide
// a full loop (stripLoops) and still cover the width.
export function sceneLayout ({ width, height }) {
  const k = sceneScale(height)
  const w = Number.isFinite(width) && width > 0 ? Math.round(width) : 0
  const total = SCENE_HEIGHT * k
  const skyH = Math.round(SCENE.sky * k)
  const vh = Math.round((SCENE.roof + SCENE.wall + SCENE.floor) * k)
  const farH = SCENE.far * k
  const nearH = SCENE.near * k
  const ruaH = Math.round(SCENE.rua * k)
  const kerbH = total - skyH - vh - farH - nearH - ruaH
  const vw = Math.round(SCENE.varandaWidth * k)
  const varanda = { x: Math.round((w - vw) / 2), y: skyH, w: vw, h: vh }
  const farY = skyH + vh

  const fit = meet(varanda, SCENE.varandaWidth, SCENE.roof + SCENE.wall + SCENE.floor)
  const size = Math.round(SCENE.chair * k)
  const u = size / 256
  const centre = fit.x + fit.s * SCENE.varandaWidth / 2
  // The floor is seen from slightly above, so the front foot stands inside
  // the floor band, not on its top edge.
  const feet = fit.y + fit.s * (SCENE.roof + SCENE.wall + SCENE.chairSink)
  const chair = {
    x: Math.round(centre - u * (CHAIR_BBOX.minX + CHAIR_BBOX.maxX) / 2),
    y: Math.round(feet - u * CHAIR_BBOX.maxY),
    size
  }

  // The trunk stands left of the varanda; on a narrow screen it cannot move
  // further left than this, so the crown tucks behind the left post instead
  // and the screen edge may crop it.
  const treeH = Math.round(SCENE.tree * k)
  const treeW = Math.round(treeH * TREE_W / TREE_H)
  const trunk = Math.max(varanda.x - 44 * k, 48 * k)
  const tree = { x: Math.round(trunk - treeW / 2), y: farY - treeH, w: treeW, h: treeH }

  // The glow box is as tall as twice its centre's depth, so it starts at the
  // band's top and never reaches up toward the word.
  const sunC = skyH + Math.round(SUN_DROP * k)
  const sun = { x: Math.round(varanda.x + vw / 2 - sunC), y: 0, size: 2 * sunC }

  // Just outside the right post, beside the plant.
  const bw = Math.round(BUTTERFLY_SIZE * k)
  const bh = Math.round(BUTTERFLY_SIZE * BUTTERFLY_H / BUTTERFLY_W * k)
  const butterfly = {
    x: Math.round(varanda.x + 242 * k - bw / 2),
    y: Math.round(skyH + 116 * k - bh / 2),
    w: bw,
    h: bh
  }

  return deepFreeze({
    k,
    width: w,
    height: total,
    sky: { y: 0, height: farY },
    sun,
    birds: BIRDS.map((b) => ({ y: Math.round(b.y * k), w: Math.round(b.w * k), h: Math.round(b.w * k / 2) })),
    tree,
    varanda,
    chair,
    butterfly,
    far: { y: farY, height: farH },
    near: { y: farY + farH, height: nearH },
    kerb: { y: farY + farH + nearH, height: kerbH },
    rua: { y: total - ruaH, height: ruaH },
    nearCount: Math.ceil(w / (NEAR * k)) + NEAR_SEQUENCE.length,
    farCount: Math.ceil(w / (FAR_W * k)) + 1
  })
}

// The landing's sunset (apps/site/public/styles.css .heroi), squeezed into
// the band: it melts out of the page cream, the birds fly in the orange, and
// plum turns to dusk navy behind the lower varanda, down to the floor line.
// Offsets run 0 (band top) to 1 (floor line); keys name palette colours, so
// the dark palette turns the same stops into a moonlit night.
export const SKY_STOPS = deepFreeze([
  { offset: 0, key: 'ceuTopo' },
  { offset: 0.13, key: 'ceuOuro' },
  { offset: 0.24, key: 'ceuLaranja' },
  { offset: 0.36, key: 'ceuCoral' },
  { offset: 0.54, key: 'ceuAmeixa' },
  { offset: 1, key: 'ceuNoite' }
])

// The landing's sun glow. Offsets are of the box's half side (the landing's
// `circle` reaches the box corner, so its stops are scaled by 1.41 here):
// the warm edge fades out right at the box edge. The outer glow has its own
// key so the moon's halo can be pale on a dark sky.
export const SUN_STOPS = deepFreeze([
  { offset: 0, key: 'solNucleo', opacity: 1 },
  { offset: 0.45, key: 'solMeio', opacity: 1 },
  { offset: 0.68, key: 'solHalo', opacity: 0.55 },
  { offset: 1, key: 'solHalo', opacity: 0 }
])

const LIGHT = {
  pedra: '#f3ede2',
  tinta: '#1f2a24',
  junta: '#8c8679',
  parede: '#f3ede2',
  telha: '#e8805a',
  beiral: '#a7382b',
  madeira: '#b98d74',
  planta: '#1d6b4f',
  meioFio: '#d6cfc1',
  asfalto: '#3d4440',
  // The lockup's ink, the chair frame's colour.
  letra: '#1f2a24',
  // The page cream, then the landing's sunset.
  ceuTopo: '#fbf8f3',
  ceuOuro: '#f7b267',
  ceuLaranja: '#f09a5f',
  ceuCoral: '#e8805a',
  ceuAmeixa: '#8a4e7a',
  ceuNoite: '#2b2a4a',
  solNucleo: '#ffe2a8',
  solMeio: '#ffc77c',
  solHalo: '#f7b267',
  // The birds' ink, their own key so the dark sky can light them.
  ave: '#1f2a24',
  // The stripe yellow of the chair: the butterfly's upper wings, over the
  // plum where its old blue was lost and the telha fell under 3:1.
  sol: '#f2b705',
  // The landing draws its tree from this palette too (render-calcada.js), so
  // the bark stays the site's; it reads on the plum, as it does there.
  tronco: '#9a6b52',
  copa: '#1a5e45'
}

// Dark is the light palette at about 78 percent brightness. The wall stays
// lit: it sits behind the chair (where the cream disc used to be), so the
// chair's ink frame keeps its contrast in both schemes.
const DARK = {
  pedra: '#bdb6a8',
  tinta: '#18211c',
  junta: '#6d695e',
  parede: '#f3ede2',
  telha: '#b56446',
  beiral: '#822c22',
  madeira: '#906e5a',
  planta: '#17533e',
  meioFio: '#a7a197',
  asfalto: '#303532',
  // lockup-dark.svg draws the lettering in cream.
  letra: '#fbf8f3',
  // The moonlit night: out of the dark page (#101010), lightening in cool
  // blue down to the floor line.
  ceuTopo: '#101010',
  ceuOuro: '#131a2a',
  ceuLaranja: '#18233a',
  ceuCoral: '#1e2c4a',
  ceuAmeixa: '#233456',
  ceuNoite: '#2a3d62',
  // The sun becomes a full moon rising behind the roof, with a pale silver
  // halo.
  solNucleo: '#f4f1e8',
  solMeio: '#d6dbe4',
  solHalo: '#9fb0cc',
  // Silver birds, lit by the moon.
  ave: '#c3cad6',
  sol: '#bd8f04',
  tronco: '#785340',
  copa: '#144936'
}

const PALETTES = deepFreeze({ light: LIGHT, dark: DARK })

export function scenePalette (scheme) {
  return scheme === 'dark' ? PALETTES.dark : PALETTES.light
}

// Seeded, so the hand-set look is identical on every device and every run.
function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function r1 (n) {
  const v = Math.round(n * 10) / 10
  return v === 0 ? 0 : v
}

function pt (p) {
  return r1(p[0]) + ' ' + r1(p[1])
}

function polyline (points) {
  return 'M' + pt(points[0]) + 'L' + points.slice(1).map(pt).join(' ')
}

// The top and bottom rows keep their y so the strip edges stay straight, and
// no line is drawn along them: the bands above and below supply that edge.
// The last column reuses column 0's jitter and no vertical line is drawn at
// x = w, so the next tile's first column lands exactly where this one ends.
//
// With stagger, each row of stones is its own course: a vertical joint spans
// one row, alternate rows shift by half a stone and each joint leans on its
// own, the way stones are set by hand rather than on a grid. Those short
// joints stay inside the tile (clear of the last 3 units, so only the long
// row joints run across the seam) and end on the row joints above and below.
export function jointMesh ({ w, h, cols, rows, seed, jitter, stagger }) {
  const rand = mulberry32(seed)
  const off = () => r1((rand() * 2 - 1) * jitter)
  const jx = []
  const jy = []
  for (let r = 0; r <= rows; r++) {
    jx.push([])
    jy.push([])
    for (let c = 0; c < cols; c++) {
      jx[r].push(off())
      const y = off()
      jy[r].push(r === 0 || r === rows ? 0 : y)
    }
  }
  const cw = w / cols
  const wrap = (c) => ((c % cols) + cols) % cols
  const p = (r, c) => [c * cw + jx[r][wrap(c)], r * h / rows + jy[r][wrap(c)]]
  const lines = []
  for (let r = 1; r < rows; r++) {
    const row = []
    for (let c = 0; c <= cols; c++) row.push(p(r, c))
    lines.push(polyline(row))
  }
  if (!stagger) {
    for (let c = 0; c < cols; c++) {
      const col = []
      for (let r = 0; r <= rows; r++) col.push(p(r, c))
      lines.push(polyline(col))
    }
    return lines.join('')
  }
  const onRow = (r, x) => {
    for (let c = -1; c <= cols; c++) {
      const [ax, ay] = p(r, c)
      const [bx, by] = p(r, c + 1)
      if (x >= ax && x <= bx) return [x, ay + (by - ay) * (x - ax) / (bx - ax)]
    }
    return [x, r * h / rows]
  }
  const place = (base) => Math.min(w - 3.1, Math.max(0.5, base + off()))
  for (let r = 0; r < rows; r++) {
    const shift = r % 2 === 1 ? cw / 2 : 0
    for (let c = 0; c < cols; c++) {
      const base = c * cw + shift
      lines.push(polyline([onRow(r, place(base)), onRow(r + 1, place(base))]))
    }
  }
  return lines.join('')
}

// The araucária rosette of Curitiba's sidewalks, seen from above: black
// stones on white. Each arm runs straight out, then steps sideways and out
// again, the hooked branch tip of the araucária. All hooks turn the same way;
// straight arms would read as a sun, and mirrored tips as a flower.
const ROSETTE = { cx: 48, cy: 48, R: 42, arms: 9 }

function buildNearTile () {
  const { cx, cy, R, arms } = ROSETTE
  const rand = mulberry32(0x0a7a)
  const shake = () => (rand() * 2 - 1) * 0.012 * R
  const at = (r, deg) => {
    const a = deg * Math.PI / 180
    return [cx + r * R * Math.cos(a) + shake(), cy + r * R * Math.sin(a) + shake()]
  }
  const disc = 0.1 * R
  const spokes = []
  const wedges = []
  for (let i = 0; i < arms; i++) {
    const t = -90 + i * (360 / arms)
    spokes.push(polyline([at(0.17, t), at(0.62, t), at(0.7, t + 17), at(0.92, t + 17)]))
    // The gap on the far side of the next arm's hook, so the wedge sits in
    // the open rim instead of under a branch tip.
    const g = t + 31
    wedges.push(polyline([at(0.7, g), at(0.94, g + 6.5), at(0.94, g - 6.5)]) + 'Z')
  }
  return {
    width: NEAR,
    height: NEAR,
    viewBox: '0 0 96 96',
    shapes: [
      {
        d: 'M' + r1(cx - disc) + ' ' + cy + 'A' + r1(disc) + ' ' + r1(disc) + ' 0 1 0 ' + r1(cx + disc) + ' ' + cy +
          'A' + r1(disc) + ' ' + r1(disc) + ' 0 1 0 ' + r1(cx - disc) + ' ' + cy + 'Z',
        fill: 'tinta'
      },
      { d: spokes.join(''), stroke: 'tinta', width: r1(0.1 * R), cap: 'round', join: 'round' },
      { d: wedges.join(''), fill: 'tinta' },
      nearJoints()
    ]
  }
}

// One mesh for every near tile: each mesh is seamless only with itself, so a
// different seed per motif would break the joints where two motifs meet.
function nearJoints () {
  return {
    d: jointMesh({ w: NEAR, h: NEAR, cols: 12, rows: 12, seed: 0x5eed, jitter: 1.8, stagger: true }),
    stroke: 'junta',
    width: 0.6,
    opacity: 0.3
  }
}

// São Paulo's sidewalks carry a map of the state, designed by
// Mirthes Bernardes. This silhouette is our own simplified drawing in homage,
// not her tile. Rough (lon, lat) vertices, clockwise from the western tip on the
// Paraná river.
const SP_OUTLINE = [
  [-53.1, -22.65],
  [-52.6, -22.1], [-52.1, -21.5], [-51.6, -20.9], [-51.05, -20.2],
  [-50.3, -19.95], [-49.3, -20.1], [-48.4, -20.15], [-47.6, -19.95], [-47.3, -20.3],
  [-46.9, -20.9], [-46.65, -21.6], [-46.5, -22.3], [-45.8, -22.7], [-45.1, -22.5], [-44.6, -22.6], [-44.2, -22.85],
  [-44.75, -23.35],
  [-45.1, -23.5], [-45.4, -23.8], [-45.9, -23.8], [-46.35, -24.0], [-46.9, -24.25], [-47.4, -24.6], [-47.9, -25.0], [-48.05, -25.3],
  [-48.6, -24.75], [-49.25, -24.4], [-49.5, -23.7], [-49.9, -22.95],
  [-50.4, -22.9], [-51.0, -22.65], [-51.7, -22.6], [-52.4, -22.55]
]

const SP_MAP = { cx: 48, cy: 48, width: 80 }

function buildSaoPauloTile () {
  const kx = Math.cos(-22.5 * Math.PI / 180)
  const flat = SP_OUTLINE.map(([lon, lat]) => [lon * kx, -lat])
  const xs = flat.map((q) => q[0])
  const ys = flat.map((q) => q[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const s = SP_MAP.width / (x1 - x0)
  const ox = SP_MAP.cx - s * (x0 + x1) / 2
  const oy = SP_MAP.cy - s * (y0 + y1) / 2
  const pts = flat.map(([x, y]) => [ox + s * x, oy + s * y])
  return {
    width: NEAR,
    height: NEAR,
    viewBox: '0 0 96 96',
    shapes: [
      { d: polyline(pts) + 'Z', fill: 'tinta' },
      nearJoints()
    ]
  }
}

// The black wave band of the site's mar-largo.svg, copied verbatim so the
// splash and the site show the same Copacabana-style far sidewalk.
export const WAVE_PATH = 'M0 34C40 34 56 6 80 6C120 6 200 62 240 62C264 62 280 34 320 34V82C280 82 264 110 240 110C200 110 120 54 80 54C56 54 40 82 0 82Z'

// Drawn at 0.4 scale (320x120 into 128x48), so the joints are coarser in
// viewBox units and the stroke is wider to land near the near tile's 0.6 px.
function buildFarTile () {
  return {
    width: FAR_W,
    height: SCENE.far,
    viewBox: '0 0 320 120',
    shapes: [
      { d: WAVE_PATH, fill: 'tinta' },
      {
        d: jointMesh({ w: 320, h: 120, cols: 16, rows: 6, seed: 0xfa7, jitter: 2.4, stagger: true }),
        stroke: 'junta',
        width: 1.4,
        opacity: 0.3
      }
    ]
  }
}

function rect (x, y, w, h) {
  return 'M' + x + ' ' + y + 'H' + (x + w) + 'V' + (y + h) + 'H' + x + 'Z'
}

// 232x174: roof 30, wall 132, floor 12. The railing covers only the outer
// thirds so the chair, standing in the middle, is never behind bars.
function buildVaranda () {
  const W = SCENE.varandaWidth
  const roofBottom = SCENE.roof
  const floorTop = SCENE.roof + SCENE.wall
  const H = floorTop + SCENE.floor
  const postW = 10
  const postL = 14
  const postR = W - 14 - postW
  const railTop = 118
  const railH = 5
  const leftEnd = 78
  const rightStart = 154

  const balusters = []
  for (let x = postL + postW + 6; x + 3 <= leftEnd - 2; x += 11) balusters.push(rect(x, railTop + railH, 3, floorTop - railTop - railH))
  for (let x = postR - 9; x >= rightStart + 2; x -= 11) balusters.push(rect(x, railTop + railH, 3, floorTop - railTop - railH))

  const planks = ['M4 ' + (floorTop + 6) + 'H' + (W - 4)]
  for (let x = 22, row = 0; x < W - 8; x += 26, row++) {
    const y = row % 2 === 0 ? floorTop : floorTop + 6
    planks.push('M' + x + ' ' + y + 'V' + (y + 6))
  }

  // The plant stands on the floor inside the right post, clear of the chair.
  const potX = 186
  const potTop = 142
  const leaves = [
    'M195 143C183 134 180 120 186 106C191 118 195 130 195 143Z',
    'M195 143C196 128 198 112 206 100C209 116 204 132 195 143Z',
    'M195 143C192 132 186 124 176 120C184 130 188 138 195 143Z',
    'M195 143C202 134 208 128 216 126C210 134 204 140 195 143Z'
  ]

  return {
    width: W,
    height: H,
    viewBox: '0 0 ' + W + ' ' + H,
    shapes: [
      { d: rect(postL, roofBottom, postR + postW - postL, floorTop - roofBottom), fill: 'parede' },
      { d: rect(postL + postW, roofBottom, postR - postL - postW, 5), fill: 'madeira' },
      { d: rect(postL, roofBottom, postW, floorTop - roofBottom) + rect(postR, roofBottom, postW, floorTop - roofBottom), fill: 'madeira' },
      {
        d: rect(postL + postW, railTop, leftEnd - postL - postW, railH) + rect(rightStart, railTop, postR - rightStart, railH) + balusters.join(''),
        fill: 'madeira'
      },
      { d: 'M' + potX + ' ' + potTop + 'H' + (potX + 18) + 'L' + (potX + 15) + ' ' + floorTop + 'H' + (potX + 3) + 'Z', fill: 'beiral' },
      { d: leaves.join(''), fill: 'planta' },
      { d: rect(4, floorTop, W - 8, SCENE.floor), fill: 'madeira' },
      { d: planks.join(''), stroke: 'tinta', width: 0.8, opacity: 0.3 },
      { d: 'M22 0H' + (W - 22) + 'L' + W + ' ' + (roofBottom - 4) + 'H0Z', fill: 'telha' },
      { d: 'M14 9H' + (W - 14) + 'M7 18H' + (W - 7), stroke: 'beiral', width: 1, opacity: 0.45 },
      { d: rect(0, roofBottom - 4, W, 4), fill: 'beiral' }
    ]
  }
}

// Araucaria angustifolia, the Curitiba pine of the calçada's rosette: a tall
// bare trunk under tiers of branches that run out and curve up. Each tier is
// a crescent of foliage, wider the higher it is, and the top one is closed
// by a flat edge, which gives the flat-topped candelabra crown.
function buildTree () {
  const cx = TREE_W / 2
  // [tip x offset, tip y, y where the tier meets the trunk, thickness there]
  const tiers = [[44, 12, 28, 0], [37, 26, 45, 8.5], [29, 40, 58, 8], [20, 53, 69, 7.5]]
  const arc = (dx, ty, by) => pt([cx, 2 * by - ty]) + ' '
  const crowns = tiers.map(([dx, ty, by, th], i) => {
    const left = pt([cx - dx, ty])
    const right = pt([cx + dx, ty])
    // The tips stand up a little, the brush at the end of each branch.
    const tip = (x) => 'L' + pt([x, ty - 4])
    if (i === 0) return 'M' + left + tip(cx - dx + 1) + 'H' + r1(cx + dx - 1) + 'L' + right + 'Q' + arc(dx, ty, by) + left + 'Z'
    return 'M' + left + tip(cx - dx + 1) + 'Q' + pt([cx, 2 * (by - th) - ty]) + ' ' + pt([cx + dx - 1, ty - 4]) + 'L' + right + 'Q' + arc(dx, ty, by) + left + 'Z'
  })
  return {
    width: TREE_W,
    height: TREE_H,
    viewBox: '0 0 ' + TREE_W + ' ' + TREE_H,
    shapes: [
      { d: 'M' + pt([cx - 3.5, TREE_H]) + 'L' + pt([cx - 1.5, 20]) + ' ' + pt([cx + 1.5, 20]) + ' ' + pt([cx + 3.5, TREE_H]) + 'Z', fill: 'tronco' },
      { d: crowns.join(''), fill: 'copa' }
    ]
  }
}

// A gull far off: two shallow arcs meeting in a v.
function buildBird () {
  return {
    width: BIRD_W,
    height: BIRD_W / 2,
    viewBox: '0 0 ' + BIRD_W + ' ' + BIRD_W / 2,
    shapes: [{ d: 'M1.5 4Q6 0.8 10 6Q14 0.8 18.5 4', stroke: 'ave', width: 1.6, cap: 'round', join: 'round' }]
  }
}

// Two wing pairs on an ink body. The body sits on the vertical centre line,
// so a flap (scaleX about the middle) folds both sides onto it.
function buildButterfly () {
  return {
    width: BUTTERFLY_W,
    height: BUTTERFLY_H,
    viewBox: '0 0 ' + BUTTERFLY_W + ' ' + BUTTERFLY_H,
    shapes: [
      { d: 'M12 9C8 1 1.5 1 1.5 6C1.5 10 7 11 12 9ZM12 9C16 1 22.5 1 22.5 6C22.5 10 17 11 12 9Z', fill: 'sol' },
      { d: 'M12 10C8 10 4 13 5.5 16.5C7 19 11 16 12 10ZM12 10C16 10 20 13 18.5 16.5C17 19 13 16 12 10Z', fill: 'telha' },
      { d: 'M12 5.5V16', stroke: 'tinta', width: 1.6, cap: 'round' },
      { d: 'M12 6L10 2.5M12 6L14 2.5', stroke: 'tinta', width: 0.8, cap: 'round' }
    ]
  }
}

export const CHAIR_VIEWBOX = '0 0 256 256'

// The 21 paths of apps/site/public/assets/cadeira.svg, verbatim, so the
// splash chair is the site's chair. Their colours are literal (the drawing is
// the brand mark, not themed).
export const CHAIR_PATHS = deepFreeze([
  { d: 'M195.4 190Q202.7 195.2 200.6 202.2Q198.5 209.2 188.1 215.8Q177.7 222.4 159.5 225.3Q141.2 228.2 124.1 227.6Q107 227.1 94.3 222Q81.5 216.9 77.6 210.7Q73.6 204.4 78.6 198.1Q83.6 191.7 96.1 186.1Q108.7 180.6 121.8 178.7Q134.9 176.8 150.9 177.2Q166.9 177.6 177.5 181.3Q188 184.9 195.4 190Z', fill: '#1f2a24', fillOpacity: 0.13 },
  { d: 'M201.4 193.3Q197.8 186.8 194.5 180Q191.2 173.2 186.8 167.1Q182.4 161 178.4 154.7Q174.4 148.4 170.3 142Q166.3 135.7 164 128.7Q161.6 121.8 159.2 115.2Q156.8 108.7 154.7 101.6Q152.6 94.5 151.2 87.1Q149.8 79.7 148.4 72.3Q147.1 65 146 57.5Q145 50.1 142.5 42.9Q140 35.8 139.5 31.1Q138.9 26.5 138.9 25.3Q138.9 24 137 23.5Q135.1 22.9 133.6 24.2Q132.1 25.4 131.4 26.8Q130.7 28.1 131.7 32.7Q132.8 37.2 135.5 44.3Q138.2 51.4 139.5 58.8Q140.7 66.2 141.9 73.6Q143.2 81 143.5 88.6Q143.9 96.2 146.4 103.4Q148.9 110.7 151.2 118Q153.5 125.3 157 132.3Q160.4 139.2 164.6 145.4Q168.8 151.6 172.6 158.1Q176.4 164.6 180.7 170.7Q185 176.9 187.3 184.2Q189.7 191.5 193.9 197.7Q198.1 204 199.3 204.6Q200.5 205.3 202.4 205.2Q204.2 205.1 205.2 203.5Q206.2 201.9 205.6 200.9Q205.1 199.9 201.4 193.3ZM161.6 175.6Q167.8 171.3 172.8 165.6Q177.8 159.9 183.5 155Q189.1 150.1 194.9 144.9Q200.6 139.6 204.3 133Q208.1 126.4 208.4 118.4Q208.7 110.4 207.2 102.2Q205.8 94 198.8 90.7Q191.9 87.3 184.8 84.3Q177.7 81.2 170.4 79.5Q163.1 77.8 155.6 76.6Q148.2 75.5 147.6 75.4Q147 75.3 146 75.4Q144.9 75.5 143.9 76.7Q142.9 77.9 143.2 79.4Q143.6 80.9 144.5 81.3Q145.3 81.8 145.9 82Q146.5 82.2 153.7 84.3Q160.9 86.5 168.2 88.2Q175.5 89.9 182.3 92.5Q189.1 95.1 193.9 96.8Q198.7 98.4 200.2 104.6Q201.8 110.9 202 118Q202.2 125.1 198.5 129.9Q194.7 134.6 189 139Q183.3 143.4 177.7 148.4Q172.2 153.5 167.1 159.1Q162 164.7 156.1 169.3Q150.1 173.8 149.4 174.8Q148.8 175.8 149.2 177.6Q149.6 179.4 151.4 180.1Q153.1 180.7 154.2 180.3Q155.4 179.9 161.6 175.6Z', fill: '#1f2a24' },
  { d: 'M73.2 120.9L91.9 117.4L111.4 114.5L129.9 110.6L148.9 107.4L151.7 120.2L133.7 124.9L114.7 128L96.6 132.8L76.4 135.7Z', fill: '#2a7fb8' },
  { d: 'M71.1 108.3L90.6 105L109.4 102.4L127.6 99.1L147.7 96.2L149.8 109.4L130 112.4L112.4 116.2L92.6 119.8L74.4 123.3Z', fill: '#e8805a' },
  { d: 'M67.6 94.7L87.2 92.8L106.3 89.5L125.4 86.1L144 84.1L148.2 97.6L128.1 100.3L109.3 104.8L90.8 107.1L71.7 109.5Z', fill: '#f2b705' },
  { d: 'M64.8 82.2L84.5 79.4L103.3 77.2L123.6 73.8L142.8 72.2L145.7 85.9L126.3 88.7L106.8 91.5L86.9 94.9L68.3 96.3Z', fill: '#e94e3c' },
  { d: 'M61.8 68.1L81.3 66.3L101.1 64.7L120.6 62.2L139.1 59.2L142.1 73.7L123.9 76.9L104.5 79.6L84.4 82L65.5 82.8Z', fill: '#1d6b4f' },
  { d: 'M58 53.8L79.1 53L97.7 52L117.6 49.1L136.9 47.5L139.7 61.1L121.1 64L101.1 66.4L81.2 68.3L62.1 69.6Z', fill: '#2a7fb8' },
  { d: 'M55.1 41.6L75.9 39.8L95.8 39.5L114.5 36.5L134.5 35.5L137.3 49.6L118.5 51.8L98.3 54.5L79.6 55.4L58.8 56.9Z', fill: '#e8805a' },
  { d: 'M53.3 30.8L73.4 30.5L92.9 29L114.1 28.4L132.9 26.4L135.1 37.7L116.1 39L95.6 40.1L76.9 41.5L56.7 43.7Z', fill: '#f2b705' },
  { d: 'M53.8 32.2L74 31.8L93.9 30.8L113.6 29.2L133.5 27.2L136.1 25.8L116.2 27.8L96.3 29.3L76.3 30.2L56 30.6Z', fill: '#ae8303' },
  { d: 'M84.1 137.3L105.4 137.3L124.6 133.5L142.5 128.5L159.6 122.6L151.6 120L133.9 127L116 131.4L96.8 134.9L77.3 134.6Z', fill: '#f2b705' },
  { d: 'M90.3 139.7L112.6 139.1L131.3 135L150.4 131.1L168.4 123.7L159.6 122.4L141.6 129.2L122.8 133.6L103.1 135.8L83.7 137Z', fill: '#e94e3c' },
  { d: 'M98.3 142.4L119.7 140.6L138.8 137.2L158.5 132.6L176.4 126.3L166 123.8L148.4 129.5L129.8 135.8L111.2 138.9L89.5 139.8Z', fill: '#1d6b4f' },
  { d: 'M105.7 144.4L127 142.7L146.3 139.3L166.6 134.5L184.6 127.4L174.1 125.9L157.2 131.4L138.2 136.6L117.4 141.1L96.1 141.5Z', fill: '#2a7fb8' },
  { d: 'M113.8 147L134.2 145L154.8 142.3L173.8 137.1L192.3 130.1L183.3 126.8L164.3 134.1L145.1 139.6L124.9 142L104.9 143.9Z', fill: '#e8805a' },
  { d: 'M121.4 149.7L143 147.3L164.5 145L184 138L201.1 131.4L192 129.1L173.4 136.4L153.6 141.6L133.3 144.8L111.2 146.4Z', fill: '#f2b705' },
  { d: 'M124.1 150.3L145.7 148.9L166.8 144.7L185.2 138.9L203.5 132.3L200.8 130.6L181.6 138.4L162.7 144.1L141.6 146.9L119.5 148.7Z', fill: '#e94e3c' },
  { d: 'M122.4 150.1L144.5 148.4L165.1 144.6L184.5 138.9L202.8 131.5L202.5 136.7L184.2 144.2L164.9 150L144.4 153.9L122.4 155.8Z', fill: '#a7382b' },
  { d: 'M56.1 37.2Q61.1 37.4 66.1 37.1Q71.1 36.8 76.1 36.1Q81.2 35.3 86.2 35.3Q91.2 35.3 96.3 35.2Q101.3 35 106.3 34.3Q111.3 33.6 116.3 33.2Q121.3 32.8 126.3 32.2Q131.2 31.7 133.9 31.3Q136.6 30.9 137.7 30.3Q138.7 29.7 139.3 28.1Q139.9 26.5 139 25.1Q138 23.7 137 23.6Q135.9 23.6 133.2 24.2Q130.5 24.8 125.5 25.1Q120.6 25.5 115.5 25.1Q110.5 24.8 105.5 25Q100.6 25.3 95.6 25.4Q90.6 25.6 85.7 25.6Q80.7 25.6 75.8 26.1Q70.8 26.6 65.9 26.7Q60.9 26.8 55.9 27.1Q50.9 27.5 49.5 27.9Q48.2 28.3 47.2 30.3Q46.2 32.3 47.3 34.3Q48.3 36.2 49.7 36.6Q51.1 37.1 56.1 37.2ZM124.5 155.2Q129.5 154.9 134.6 154.3Q139.6 153.6 144.6 152.6Q149.6 151.5 154.6 150.1Q159.5 148.8 164.5 147.8Q169.5 146.9 174.3 145.4Q179.2 143.9 184.1 142.4Q188.9 141 194 140Q199.1 138.9 203.2 137.2Q207.3 135.4 208.4 134.2Q209.4 133 209.7 130.8Q209.9 128.5 208.1 127Q206.3 125.5 204.9 125.9Q203.5 126.2 199.3 127.8Q195.1 129.5 190.6 131.4Q186.1 133.4 181.5 134.8Q176.8 136.2 172.2 138Q167.6 139.7 162.9 140.8Q158.1 141.9 153.2 142.1Q148.2 142.3 143.5 143.2Q138.7 144.2 133.8 144.8Q128.9 145.4 123.9 145.5Q118.8 145.6 117.5 146Q116.1 146.4 115.2 148.5Q114.3 150.5 115.4 152.5Q116.6 154.4 118.1 154.9Q119.6 155.5 124.5 155.2Z', fill: '#1f2a24' },
  { d: 'M123.9 219.4Q119.9 213 115.7 206.8Q111.4 200.5 108.2 193.7Q105.1 186.9 102.6 179.8Q100.2 172.6 96.4 166.1Q92.6 159.6 89 153Q85.5 146.4 81.3 140.4Q77.2 134.4 76.2 127.1Q75.3 119.9 74.7 112.3Q74.1 104.7 71.6 97.6Q69 90.5 67.4 83.2Q65.9 75.8 63.4 68.7Q60.9 61.6 60.3 54Q59.7 46.5 58.5 39.1Q57.3 31.6 57.2 31.3Q57.1 31 55.7 29.7Q54.3 28.5 51.9 27.9Q49.6 27.3 47.8 28.8Q45.9 30.4 46.4 31.8Q46.9 33.3 47 33.6Q47 33.9 47.1 41.6Q47.2 49.3 49.5 56.4Q51.9 63.6 54.2 70.8Q56.6 77.9 58.2 85.2Q59.8 92.6 61 100Q62.1 107.4 63.2 114.9Q64.4 122.3 66.3 129.9Q68.3 137.5 72.9 144Q77.4 150.5 80.4 157.5Q83.3 164.4 86.1 171.4Q89 178.4 92.6 184.9Q96.2 191.5 99.5 198.2Q102.9 205 107.6 211Q112.3 217 114.6 224.2Q116.9 231.5 117.9 232.9Q119 234.4 121.8 234.4Q124.7 234.4 126.3 232.1Q128 229.7 127.9 227.8Q127.8 225.8 123.9 219.4ZM86.1 195.9Q90.3 189.7 95.4 184.2Q100.6 178.7 106.2 173.7Q111.9 168.7 117.5 162.2Q123.1 155.8 122.1 147.4Q121.1 139 121.1 131.3Q121.1 123.6 120.5 114.4Q120 105.2 111.7 101.4Q103.5 97.6 95.7 96.7Q87.9 95.9 81.4 91.9Q74.8 88 70.4 85.7Q66 83.4 64.1 83.9Q62.1 84.4 60.1 86.2Q58.2 88 58.5 90.7Q58.9 93.3 60.5 93.8Q62.1 94.3 66.4 96.8Q70.7 99.3 77.9 101.5Q85.1 103.7 92.2 105.8Q99.4 107.9 105 109.9Q110.7 111.9 109.7 118.5Q108.8 125.1 110.7 132.2Q112.6 139.3 113 145.5Q113.5 151.7 108.4 156.4Q103.4 161.1 97.3 165.7Q91.3 170.4 87.3 176.9Q83.4 183.4 79 189.6Q74.7 195.8 73.5 196.6Q72.3 197.3 73.1 199.4Q73.8 201.5 76 202Q78.1 202.6 80 202.4Q81.8 202.2 86.1 195.9Z', fill: '#1f2a24' }
])

// The hand-drawn capitals of apps/site/public/assets/logo-lockup.svg (its
// one lettering path, split before each M and grouped by letter), verbatim
// and in the lettering's own coordinates: an original drawing, not a font,
// so the splash word is the brand's word. One entry per letter lets each
// rise on its own layer. The viewBox is the bbox of every coordinate
// (control points too) rounded outward with 2 units of margin.
export const LETTERING = deepFreeze({
  viewBox: '-12 -12 538 124',
  letters: [
    { char: 'V', d: 'M-5.6 9.4Q-2.9 16.9 0 24.4Q2.9 31.8 5.3 39.5Q7.8 47.1 9.4 55Q11.1 62.9 14 70.4Q16.8 77.8 20.4 85.4Q24 93 31.1 96.3Q38.2 99.6 41.4 91Q44.7 82.4 46.3 74.5Q48 66.7 51 59.2Q54.1 51.8 55.2 43.8Q56.3 35.8 59.1 28.3Q61.9 20.7 64.7 13.2Q67.5 5.6 68.3 2.2Q69.1 -1.2 68.4 -3.5Q67.7 -5.8 65.3 -7.9Q62.9 -10.1 59.8 -9.4Q56.6 -8.7 56.1 -6.8Q55.6 -4.8 54.6 -1.4Q53.7 2 51.9 9.8Q50 17.6 48 25.3Q45.9 33 42.8 40.5Q39.8 47.9 37.2 55.5Q34.7 63.1 33.4 71.1Q32.2 79 31.2 85.5Q30.2 92 32.1 90.1Q34 88.1 32.6 80.4Q31.3 72.7 27.6 65.5Q23.9 58.3 21.5 50.7Q19 43.1 16.5 35.5Q14.1 27.9 11.9 20.2Q9.8 12.4 8 4.6Q6.2 -3.3 4.1 -4.9Q2 -6.5 -1.5 -7Q-5.1 -7.5 -7.5 -4.9Q-9.9 -2.3 -9.1 -0.2Q-8.4 1.9 -5.6 9.4Z' },
    { char: 'A', d: 'M84.9 95.3Q86 87.2 89 79.7Q91.9 72.3 95 64.9Q98.1 57.5 101.2 50.1Q104.2 42.7 106.7 35.1Q109.3 27.5 111.3 20.6Q113.4 13.6 110.6 13.3Q107.8 13 108.9 20.1Q110 27.3 112.9 34.7Q115.9 42.2 117.9 50Q119.9 57.7 122.8 65.2Q125.7 72.7 128.1 80.3Q130.5 88 131.5 96Q132.6 104 132.7 104.3Q132.8 104.6 134.1 106.2Q135.5 107.9 138.6 108.5Q141.7 109.1 144 106.9Q146.3 104.7 146.1 102.8Q145.9 100.8 145.9 100.5Q145.8 100.2 143.8 92.4Q141.9 84.7 139.7 77Q137.5 69.3 134 61.9Q130.6 54.6 128.9 46.8Q127.3 38.9 125.8 31Q124.3 23.1 122.3 14.2Q120.2 5.2 110.3 5.1Q100.3 5 98.6 14.1Q96.8 23.1 94.8 30.9Q92.7 38.6 89.7 46.1Q86.6 53.5 84.2 61.1Q81.8 68.7 78 75.9Q74.3 83.1 72 90.7Q69.6 98.4 69.3 100.5Q69 102.7 71.4 105.3Q73.8 107.8 77.2 107.3Q80.6 106.8 82.2 105.1Q83.8 103.4 84.9 95.3ZM98 71.7Q106 70.8 114 72.4Q122 74.1 125.3 73.8Q128.7 73.5 130.6 72.7Q132.5 71.9 134 69.3Q135.4 66.6 134.1 63.9Q132.8 61.2 131 60.8Q129.1 60.4 125.7 59.6Q122.4 58.8 114.4 58.5Q106.4 58.2 98.4 59.6Q90.3 61 88.7 60.8Q87 60.5 85.7 62.8Q84.4 65.2 85.6 67.6Q86.7 70 88.4 71.3Q90 72.6 98 71.7Z' },
    { char: 'R', d: 'M160.6 88.3Q160.8 80.3 160.5 72.2Q160.2 64.2 161.3 56.3Q162.3 48.3 163 40.3Q163.8 32.3 163.9 24.3Q164 16.3 163.5 8.4Q163 0.5 163.1 -1.5Q163.3 -3.6 160.5 -5.2Q157.6 -6.8 154.7 -5.5Q151.7 -4.1 150.3 -2.1Q148.8 -0.1 149 7.8Q149.2 15.7 150 23.8Q150.8 31.8 150.3 39.8Q149.8 47.8 149.6 55.8Q149.3 63.8 148.4 71.7Q147.5 79.7 146.2 87.7Q144.9 95.6 145.9 97.9Q146.8 100.1 149.9 101.9Q153 103.7 156.3 102.2Q159.5 100.7 160 98.5Q160.4 96.3 160.6 88.3ZM165 7.9Q172.7 8.6 179.4 10Q186.2 11.4 191.5 14.7Q196.9 18.1 199 23Q201.2 28 198.6 32.8Q195.9 37.5 190.5 40.8Q185 44.1 177.9 44.8Q170.8 45.4 163.2 44.5Q155.5 43.5 153.5 44.4Q151.6 45.3 150 48Q148.4 50.7 149.8 53.5Q151.1 56.4 153 56.7Q155 57.1 163.1 57.3Q171.2 57.4 180 56.7Q188.9 56 197.3 51.6Q205.8 47.2 210.4 37.9Q215 28.6 210.3 19.8Q205.6 10.9 198.4 5.3Q191.2 -0.4 182.6 -3.6Q174.1 -6.8 165.6 -5.5Q157.2 -4.2 155.6 -3.4Q153.9 -2.5 152.7 -0.1Q151.5 2.2 152.8 4.6Q154 6.9 155.7 7Q157.3 7.2 165 7.9ZM179.1 62Q182.7 69.2 187.2 75.9Q191.7 82.5 195.4 89.6Q199 96.8 200.8 99.5Q202.5 102.2 204.5 102.9Q206.5 103.7 209.2 103.5Q211.9 103.3 213.3 100.9Q214.7 98.6 213.6 97.3Q212.5 96 211 93.1Q209.6 90.2 206.4 82.8Q203.3 75.3 199.2 68.4Q195.1 61.5 190.6 54.9Q186.1 48.3 184.3 47.3Q182.6 46.3 179.7 46.5Q176.8 46.7 175.4 49.2Q173.9 51.7 174.7 53.2Q175.6 54.8 179.1 62Z' },
    { char: 'A', d: 'M234.2 96.1Q236 88.2 238.1 80.5Q240.2 72.8 242.9 65.3Q245.6 57.7 248 50.1Q250.4 42.5 252.8 34.8Q255.2 27.2 257.5 19.7Q259.9 12.2 257.9 8.7Q256 5.1 256.4 11Q256.9 16.8 259 24.5Q261.2 32.3 264.5 39.6Q267.9 46.9 270.9 54.3Q274 61.7 275.9 69.5Q277.8 77.3 279.8 85.1Q281.9 92.8 283.3 98.2Q284.7 103.6 286.1 105.3Q287.5 107.1 290.9 107.7Q294.2 108.2 296.6 105.8Q299 103.4 298.8 101.2Q298.7 99 296.7 93.8Q294.6 88.7 292.4 81Q290.2 73.3 287.8 65.6Q285.4 58 281.7 50.8Q277.9 43.6 275.7 35.9Q273.4 28.3 272.3 20.2Q271.3 12.1 266.6 2.3Q262 -7.6 254.6 -0Q247.2 7.5 244.8 15.4Q242.4 23.2 241.1 31.2Q239.8 39.1 237.6 46.8Q235.3 54.5 231.2 61.6Q227 68.7 224.5 76.3Q222.1 83.9 220.6 91.8Q219.2 99.7 218.9 101.7Q218.5 103.7 220.8 106Q223.1 108.2 226.2 107.7Q229.4 107.1 230.9 105.5Q232.4 103.9 234.2 96.1ZM246.5 70Q254.5 70.1 262.5 69.9Q270.5 69.7 274.9 69.8Q279.2 69.9 280.9 69.2Q282.6 68.5 283.8 66.1Q285 63.7 283.8 61.3Q282.5 58.9 280.8 58.6Q279.1 58.2 274.8 58.6Q270.5 59 262.5 58.6Q254.4 58.2 246.4 57.9Q238.4 57.5 236.7 58.2Q234.9 58.9 233.6 61.5Q232.3 64 233.6 66.5Q235 69.1 236.7 69.5Q238.5 69.9 246.5 70Z' },
    { char: 'N', d: 'M309.5 89.4Q310.1 81.4 310.4 73.5Q310.7 65.5 311.5 57.5Q312.3 49.5 312.4 41.5Q312.4 33.5 313 25.5Q313.6 17.5 313.6 12.7Q313.6 7.9 311.4 11.4Q309.1 14.9 312.8 21.8Q316.6 28.7 320.6 35.6Q324.7 42.5 328.6 49.5Q332.5 56.5 336 63.7Q339.5 70.9 342.3 78.4Q345.1 86 349.8 95Q354.4 104 361.9 97.2Q369.4 90.4 369.5 82Q369.5 73.6 369.3 65.6Q369.1 57.6 369.5 49.6Q370 41.6 370.9 33.6Q371.8 25.7 373.8 17.8Q375.7 9.9 375.7 6.6Q375.7 3.3 374.5 1.2Q373.3 -0.8 370.6 -2.5Q367.9 -4.1 365 -2.8Q362.1 -1.5 362 0.5Q362 2.4 361.6 5.7Q361.3 9 360.4 17Q359.6 24.9 358.6 32.9Q357.6 40.8 358.1 48.9Q358.7 56.9 357.6 64.9Q356.6 72.8 356.2 80.5Q355.8 88.2 359.3 89.7Q362.9 91.2 360.2 85.4Q357.5 79.6 354.7 72Q351.9 64.5 347.7 57.7Q343.4 50.9 338.8 44.3Q334.1 37.7 330.9 30.3Q327.7 22.9 323.8 15.9Q319.8 8.8 312.1 2.3Q304.4 -4.2 302 6.2Q299.6 16.7 298.8 24.6Q298.1 32.6 299 40.7Q299.9 48.7 300 56.8Q300 64.8 298.9 72.7Q297.8 80.7 297.4 88.7Q297.1 96.7 297.3 98.4Q297.5 100.1 299.9 101.5Q302.2 103 304.7 101.8Q307.2 100.7 308.1 99.1Q309 97.4 309.5 89.4Z' },
    { char: 'D', d: 'M384.8 87.3Q385.2 79.3 384.1 71.2Q383 63.2 383.6 55.2Q384.2 47.2 384.5 39.2Q384.9 31.2 385.8 23.3Q386.8 15.3 386.7 7.3Q386.7 -0.7 386.7 -1.1Q386.8 -1.5 386.1 -3.3Q385.4 -5 383 -6.4Q380.5 -7.8 378 -6.6Q375.5 -5.4 375.1 -3.7Q374.7 -2 374.7 -1.6Q374.6 -1.2 374 6.8Q373.4 14.8 372.2 22.8Q371 30.7 371.3 38.7Q371.6 46.7 371.5 54.8Q371.4 62.8 371.2 70.8Q371 78.8 370.6 86.7Q370.2 94.7 370.5 96.8Q370.7 98.9 373.6 100.5Q376.4 102.1 379.4 100.7Q382.4 99.3 383.5 97.3Q384.5 95.3 384.8 87.3ZM387.6 7.2Q394.8 5.9 401.6 7.8Q408.4 9.6 412.5 15.4Q416.6 21.2 420.3 26.8Q424 32.3 426.3 38.8Q428.7 45.3 427.7 52.2Q426.6 59.1 423.2 65.1Q419.7 71.1 414.4 75.3Q409.2 79.6 403.8 84.2Q398.4 88.8 391.1 89.1Q383.9 89.4 381.3 88Q378.6 86.7 376.7 86.9Q374.7 87 372.7 89.2Q370.7 91.3 371.2 94.1Q371.8 97 373.4 98Q375.1 98.9 379.4 99.6Q383.8 100.3 392.8 100.5Q401.8 100.7 410 96.4Q418.1 92.1 424 85.2Q429.9 78.4 434.1 70.5Q438.2 62.6 439.5 53.7Q440.7 44.8 439.4 35.8Q438 26.8 432.4 19.6Q426.9 12.5 420.3 6.5Q413.8 0.5 405.6 -3.5Q397.3 -7.4 388.8 -6.4Q380.2 -5.4 378.2 -5.5Q376.2 -5.5 374.7 -2.6Q373.3 0.2 374.8 3.1Q376.3 5.9 378.3 7.2Q380.3 8.5 387.6 7.2Z' },
    { char: 'A', d: 'M461.7 94.4Q464.8 87 466.2 79.1Q467.7 71.2 469.3 63.4Q471 55.5 473.4 47.9Q475.8 40.2 477.7 32.5Q479.6 24.7 481.8 17.5Q483.9 10.3 480.5 9.4Q477.1 8.6 479.4 14.5Q481.7 20.5 484.7 27.9Q487.8 35.3 491.1 42.6Q494.4 49.9 496.9 57.5Q499.5 65.1 500.6 73.2Q501.8 81.3 505.9 88.3Q510 95.3 511 97.4Q512.1 99.5 513.1 101Q514 102.5 516.8 102.8Q519.6 103.2 521.5 101.1Q523.4 99 523.4 97.2Q523.5 95.3 522.3 93.2Q521.1 91.2 518.6 83.6Q516.1 76 513.7 68.4Q511.2 60.8 508.3 53.3Q505.4 45.8 503 38.2Q500.6 30.5 497.6 23.1Q494.6 15.7 490.4 7.7Q486.1 -0.3 480.1 2.8Q474 5.9 470 13.5Q466 21 464.2 28.8Q462.4 36.6 460.8 44.5Q459.3 52.3 457.5 60.1Q455.8 68 453.7 75.7Q451.6 83.4 448.3 90.8Q445 98.2 445.5 100.4Q446.1 102.7 448.5 104.9Q450.9 107.1 454.1 106.4Q457.3 105.7 457.9 103.8Q458.6 101.9 461.7 94.4ZM472.6 69.8Q480.6 70.1 488.6 68.6Q496.5 67.2 500.2 66.8Q504 66.4 505.7 66.3Q507.3 66.2 508.5 63.8Q509.6 61.3 508.3 59Q506.9 56.6 505.2 55.7Q503.5 54.7 499.7 55.4Q496 56 488.1 57Q480.1 58 472.1 58Q464.1 58 462.5 58.4Q460.8 58.8 459.7 61.2Q458.6 63.6 459.9 65.8Q461.2 68.1 462.9 68.8Q464.6 69.5 472.6 69.8Z' }
  ]
})

const NEAR_TILE = deepFreeze(buildNearTile())
const SP_TILE = deepFreeze(buildSaoPauloTile())
const NEAR_TILES = deepFreeze(NEAR_SEQUENCE.map((name) => ({ araucaria: NEAR_TILE, saoPaulo: SP_TILE })[name]))
const FAR_TILE = deepFreeze(buildFarTile())
const VARANDA = deepFreeze(buildVaranda())
const TREE = deepFreeze(buildTree())
const BIRD = deepFreeze(buildBird())
const BUTTERFLY = deepFreeze(buildButterfly())

export function nearTile () {
  return NEAR_TILE
}

export function spMapTile () {
  return SP_TILE
}

export function nearTiles () {
  return NEAR_TILES
}

export function farTile () {
  return FAR_TILE
}

export function varandaArt () {
  return VARANDA
}

export function treeArt () {
  return TREE
}

export function birdArt () {
  return BIRD
}

export function butterflyArt () {
  return BUTTERFLY
}

function deepFreeze (value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
