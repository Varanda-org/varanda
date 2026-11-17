// Balcony for the Varandinha: a back wall, a floor, a front railing and six
// pots. Shapes name palette keys, so one drawing serves both schemes.
// Geometry is flat and original to this module.

import rpc from '@varanda/rpc'

export const LIGHT = deepFreeze({
  wall: '#f3ecdf',
  floor: '#e7d3b4',
  railing: '#5e6f68',
  railingShade: '#3f514b',
  potClay: '#c46b42',
  potRim: '#9a4e32',
  soilDry: '#8d6b43',
  soilWet: '#4a3424',
  stem: '#3e6b38',
  leaf: '#2f8f4e',
  leafDark: '#1d5c34',
  basil: '#3c9a45',
  tomato: '#d63b32',
  pepper: '#e25b1a',
  rosemary: '#7d8f78',
  fern: '#2f7a45',
  snake: '#1f6b45',
  snakeEdge: '#e2c14a'
})

// Same keys, lightened so pots and leaves still read on a dark page.
export const DARK = deepFreeze({
  wall: '#2c2824',
  floor: '#3d342c',
  railing: '#c5d1cb',
  railingShade: '#8ea099',
  potClay: '#e0906a',
  potRim: '#f0b090',
  soilDry: '#b08a5c',
  soilWet: '#6e4c34',
  stem: '#9dcc86',
  leaf: '#7ed492',
  leafDark: '#3f9a62',
  basil: '#8ed67e',
  tomato: '#ff6d5e',
  pepper: '#ff8a3d',
  rosemary: '#c5d0bc',
  fern: '#7dcc8a',
  snake: '#5ec08a',
  snakeEdge: '#f0d56a'
})

export function gardenPalette (scheme) {
  return scheme === 'dark' ? DARK : LIGHT
}

// Past this span the six pots stop reading as a balcony, so a wider frame
// keeps the scene at this width and sits it in the middle.
const MAX_WIDTH = 420
// A pot narrower than this cannot hold a 44 x 44 hit box (the slot is never
// shorter than wide), so a frame too small for it draws nothing.
const MIN_HIT = 44

export function gardenLayout (width) {
  const sceneW = Number.isFinite(width) && width > 0 ? Math.round(width) : 0
  const inner = Math.min(sceneW, MAX_WIDTH)
  const ox = Math.round((sceneW - inner) / 2)
  if (inner === 0) return emptyLayout(sceneW)

  const gapX = Math.max(8, Math.round(inner * 3 / 100))
  const margin = Math.max(12, Math.round(inner * 4 / 100))
  const potW = Math.max(0, Math.floor((inner - margin * 2 - gapX * 2) / 3))
  // A slot a little taller than wide, so the plant has room above the clay.
  if (potW < MIN_HIT) return emptyLayout(sceneW)
  const potH = Math.round(potW * 115 / 100)
  const rowGap = Math.max(8, Math.round(inner * 2 / 100))
  const pad = Math.round((inner - (potW * 3 + gapX * 2)) / 2)
  const top = Math.max(16, Math.round(inner * 6 / 100))
  const railH = Math.max(8, Math.round(inner * 25 / 1000))
  const railGap = Math.max(10, Math.round(inner * 4 / 100))
  const bottom = Math.max(12, Math.round(inner * 4 / 100))
  const postW = Math.max(6, Math.round(inner * 18 / 1000))
  const backY = top
  const frontY = backY + potH + rowGap
  const railY1 = frontY + potH + 4
  const railY2 = railY1 + railH + railGap
  const height = railY2 + railH + bottom
  // Local y 64 is the pot lip. The view fits the square drawing in the slot,
  // so the lip lands this far below the slot's top.
  const lip = Math.max(0, Math.round((potH - potW) / 2)) + Math.round(potW * 64 / 100)
  const floorY = Math.max(0, Math.min(height, backY + lip))
  const railSpan = railY2 + railH - railY1
  const wall = { x: ox, y: 0, w: inner, h: floorY }
  const floor = { x: ox, y: floorY, w: inner, h: height - floorY }
  const railing = [
    { x: ox, y: railY1, w: inner, h: railH, fill: 'railing' },
    { x: ox, y: railY2, w: inner, h: railH, fill: 'railingShade' },
    { x: ox, y: railY1, w: postW, h: railSpan, fill: 'railing' },
    { x: ox + inner - postW, y: railY1, w: postW, h: railSpan, fill: 'railing' },
    { x: ox + Math.round((inner - postW) / 2), y: railY1, w: postW, h: railSpan, fill: 'railing' }
  ]
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
  return deepFreeze({ width: sceneW, height, wall, floor, railing, pots })
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
    railing: [],
    pots
  })
}

export const POT_SHAPES = deepFreeze([
  { kind: 'path', d: 'M24 70 L76 70 L68 92 L62 98 L38 98 L32 92 Z', fill: 'potClay' },
  { kind: 'rect', x: 20, y: 64, w: 60, h: 8, fill: 'potRim' },
  { kind: 'ellipse', cx: 50, cy: 64, rx: 26, ry: 5, fill: 'potClay' }
])

export const SOIL_DRY = deepFreeze([
  { kind: 'ellipse', cx: 50, cy: 64, rx: 22, ry: 3, fill: 'soilDry' }
])

export const SOIL_WET = deepFreeze([
  { kind: 'ellipse', cx: 50, cy: 64, rx: 22, ry: 3, fill: 'soilWet' }
])

export const EMPTY = deepFreeze(POT_SHAPES.concat(SOIL_DRY))

// Four stages per plant (seed, sprout, grown, ripe) in a 0..100 box.
// potDrawing adds the pot and the soil; these lists are only the plant.
const DRAWINGS = {
  manjericao: [
    [
      { kind: 'ellipse', cx: 50, cy: 62, rx: 4, ry: 2, fill: 'basil' }
    ],
    [
      { kind: 'rect', x: 48, y: 46, w: 4, h: 18, fill: 'stem' },
      { kind: 'ellipse', cx: 40, cy: 46, rx: 8, ry: 5, fill: 'basil' },
      { kind: 'ellipse', cx: 60, cy: 44, rx: 8, ry: 5, fill: 'leaf' }
    ],
    [
      { kind: 'rect', x: 47, y: 32, w: 6, h: 32, fill: 'stem' },
      { kind: 'ellipse', cx: 32, cy: 40, rx: 12, ry: 7, fill: 'basil' },
      { kind: 'ellipse', cx: 68, cy: 38, rx: 12, ry: 7, fill: 'leaf' },
      { kind: 'ellipse', cx: 46, cy: 26, rx: 10, ry: 6, fill: 'leafDark' },
      { kind: 'ellipse', cx: 60, cy: 22, rx: 9, ry: 6, fill: 'basil' }
    ],
    [
      { kind: 'rect', x: 46, y: 24, w: 8, h: 40, fill: 'stem' },
      { kind: 'ellipse', cx: 26, cy: 42, rx: 14, ry: 8, fill: 'basil' },
      { kind: 'ellipse', cx: 74, cy: 40, rx: 14, ry: 8, fill: 'leaf' },
      { kind: 'ellipse', cx: 38, cy: 26, rx: 12, ry: 7, fill: 'leafDark' },
      { kind: 'ellipse', cx: 64, cy: 22, rx: 12, ry: 7, fill: 'basil' },
      { kind: 'ellipse', cx: 50, cy: 14, rx: 9, ry: 6, fill: 'leaf' },
      { kind: 'circle', cx: 50, cy: 10, r: 3, fill: 'basil' }
    ]
  ],
  tomate: [
    [
      { kind: 'circle', cx: 50, cy: 62, r: 3, fill: 'stem' }
    ],
    [
      { kind: 'rect', x: 48, y: 42, w: 4, h: 22, fill: 'stem' },
      { kind: 'ellipse', cx: 38, cy: 42, rx: 9, ry: 5, fill: 'leaf' },
      { kind: 'ellipse', cx: 62, cy: 42, rx: 9, ry: 5, fill: 'leafDark' }
    ],
    [
      { kind: 'rect', x: 47, y: 26, w: 6, h: 38, fill: 'stem' },
      { kind: 'ellipse', cx: 30, cy: 36, rx: 13, ry: 8, fill: 'leaf' },
      { kind: 'ellipse', cx: 70, cy: 32, rx: 13, ry: 8, fill: 'leafDark' },
      { kind: 'ellipse', cx: 48, cy: 18, rx: 10, ry: 6, fill: 'leaf' },
      { kind: 'circle', cx: 64, cy: 48, r: 6, fill: 'leafDark' }
    ],
    [
      { kind: 'rect', x: 47, y: 22, w: 6, h: 42, fill: 'stem' },
      { kind: 'ellipse', cx: 28, cy: 32, rx: 14, ry: 8, fill: 'leaf' },
      { kind: 'ellipse', cx: 74, cy: 30, rx: 13, ry: 7, fill: 'leafDark' },
      { kind: 'circle', cx: 34, cy: 50, r: 9, fill: 'tomato' },
      { kind: 'circle', cx: 58, cy: 44, r: 8, fill: 'tomato' },
      { kind: 'circle', cx: 48, cy: 14, r: 4, fill: 'leaf' }
    ]
  ],
  pimenta: [
    [
      { kind: 'ellipse', cx: 50, cy: 63, rx: 3, ry: 2, fill: 'stem' }
    ],
    [
      { kind: 'rect', x: 49, y: 44, w: 3, h: 20, fill: 'stem' },
      { kind: 'ellipse', cx: 40, cy: 46, rx: 8, ry: 4, fill: 'leaf' },
      { kind: 'ellipse', cx: 61, cy: 44, rx: 8, ry: 4, fill: 'leafDark' }
    ],
    [
      { kind: 'rect', x: 48, y: 30, w: 4, h: 34, fill: 'stem' },
      { kind: 'ellipse', cx: 32, cy: 34, rx: 12, ry: 6, fill: 'leaf' },
      { kind: 'ellipse', cx: 68, cy: 32, rx: 12, ry: 6, fill: 'leafDark' },
      { kind: 'path', d: 'M42 42 L38 58 L46 60 L48 44 Z', fill: 'leafDark' }
    ],
    [
      { kind: 'rect', x: 48, y: 24, w: 4, h: 40, fill: 'stem' },
      { kind: 'ellipse', cx: 30, cy: 30, rx: 12, ry: 7, fill: 'leaf' },
      { kind: 'ellipse', cx: 70, cy: 28, rx: 12, ry: 7, fill: 'leafDark' },
      { kind: 'path', d: 'M36 38 L30 58 L40 64 L46 42 Z', fill: 'pepper' },
      { kind: 'path', d: 'M58 34 L66 54 L58 66 L52 40 Z', fill: 'pepper' }
    ]
  ],
  alecrim: [
    [
      { kind: 'circle', cx: 50, cy: 62, r: 2, fill: 'rosemary' }
    ],
    [
      { kind: 'rect', x: 49, y: 40, w: 3, h: 24, fill: 'stem' },
      { kind: 'rect', x: 42, y: 48, w: 2, h: 14, fill: 'rosemary' },
      { kind: 'rect', x: 56, y: 46, w: 2, h: 16, fill: 'rosemary' }
    ],
    [
      { kind: 'rect', x: 48, y: 28, w: 4, h: 36, fill: 'stem' },
      { kind: 'rect', x: 36, y: 36, w: 3, h: 26, fill: 'rosemary' },
      { kind: 'rect', x: 42, y: 30, w: 3, h: 32, fill: 'rosemary' },
      { kind: 'rect', x: 56, y: 26, w: 3, h: 36, fill: 'rosemary' },
      { kind: 'rect', x: 62, y: 34, w: 3, h: 28, fill: 'leaf' }
    ],
    [
      { kind: 'rect', x: 47, y: 16, w: 5, h: 48, fill: 'stem' },
      { kind: 'rect', x: 28, y: 30, w: 3, h: 34, fill: 'rosemary' },
      { kind: 'rect', x: 36, y: 20, w: 3, h: 44, fill: 'rosemary' },
      { kind: 'rect', x: 56, y: 14, w: 3, h: 50, fill: 'rosemary' },
      { kind: 'rect', x: 64, y: 22, w: 3, h: 42, fill: 'rosemary' },
      { kind: 'rect', x: 72, y: 32, w: 3, h: 32, fill: 'leaf' },
      { kind: 'circle', cx: 30, cy: 28, r: 2, fill: 'rosemary' }
    ]
  ],
  samambaia: [
    [
      { kind: 'ellipse', cx: 50, cy: 62, rx: 6, ry: 3, fill: 'fern' }
    ],
    [
      { kind: 'path', d: 'M50 64 L28 46 L50 52 Z', fill: 'fern' },
      { kind: 'path', d: 'M50 64 L72 48 L50 54 Z', fill: 'leaf' }
    ],
    [
      { kind: 'path', d: 'M50 64 L18 40 L50 50 Z', fill: 'fern' },
      { kind: 'path', d: 'M50 64 L82 38 L50 48 Z', fill: 'leafDark' },
      { kind: 'path', d: 'M50 64 L46 28 L58 64 Z', fill: 'fern' },
      { kind: 'ellipse', cx: 50, cy: 64, rx: 8, ry: 3, fill: 'stem' }
    ],
    [
      { kind: 'path', d: 'M48 66 L8 34 L48 48 Z', fill: 'fern' },
      { kind: 'path', d: 'M52 66 L92 30 L52 46 Z', fill: 'leaf' },
      { kind: 'path', d: 'M50 66 L24 16 L50 40 Z', fill: 'leafDark' },
      { kind: 'path', d: 'M50 66 L76 14 L50 38 Z', fill: 'fern' },
      { kind: 'ellipse', cx: 50, cy: 65, rx: 10, ry: 4, fill: 'stem' }
    ]
  ],
  espada: [
    [
      { kind: 'rect', x: 46, y: 58, w: 8, h: 6, fill: 'snake' }
    ],
    [
      { kind: 'path', d: 'M44 66 L50 38 L56 66 Z', fill: 'snake' },
      { kind: 'path', d: 'M48 66 L50 42 L52 66 Z', fill: 'snakeEdge' }
    ],
    [
      { kind: 'path', d: 'M34 66 L30 28 L42 66 Z', fill: 'snake' },
      { kind: 'path', d: 'M36 66 L31 32 L34 66 Z', fill: 'snakeEdge' },
      { kind: 'path', d: 'M46 66 L50 16 L56 66 Z', fill: 'leafDark' },
      { kind: 'path', d: 'M49 66 L50 20 L52 66 Z', fill: 'snakeEdge' },
      { kind: 'path', d: 'M60 66 L68 32 L74 66 Z', fill: 'snake' }
    ],
    [
      { kind: 'path', d: 'M26 66 L18 18 L38 66 Z', fill: 'snake' },
      { kind: 'path', d: 'M28 66 L20 22 L26 66 Z', fill: 'snakeEdge' },
      { kind: 'path', d: 'M42 66 L48 6 L56 66 Z', fill: 'leafDark' },
      { kind: 'path', d: 'M47 66 L48 10 L50 66 Z', fill: 'snakeEdge' },
      { kind: 'path', d: 'M60 66 L72 12 L80 66 Z', fill: 'snake' },
      { kind: 'path', d: 'M70 66 L72 16 L75 66 Z', fill: 'snakeEdge' }
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

const NONE = deepFreeze([])

function resolve (view) {
  try {
    if (view === null || view === undefined) return null
    const plant = ownValue(view, 'plant')
    const stage = ownValue(view, 'stage')
    const stages = stagesOf(plant)
    if (!stages || !isStage(stage)) return null
    const drawing = stages[stage]
    if (!drawing) return null
    const soil = ownValue(view, 'dry') === false ? SOIL_WET : SOIL_DRY
    return { base: deepFreeze(POT_SHAPES.concat(soil)), plant: drawing }
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
