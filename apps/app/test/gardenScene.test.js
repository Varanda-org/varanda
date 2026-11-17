'use strict'

// The balcony geometry (src/ui/gardenScene.js). import() loads the ESM module.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const rpc = require('@varanda/rpc')

const load = () => import('../src/ui/gardenScene.js')
const SRC = path.join(__dirname, '../src/ui/gardenScene.js')
const HEX = /^#[0-9a-f]{6}$/
const CAP = 420

function signature (shapes) {
  return JSON.stringify(shapes)
}

function wholePixels (value, bad, at) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.round(value) !== value) bad.push(at)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => wholePixels(item, bad, at + '[' + i + ']'))
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) wholePixels(value[key], bad, at + '.' + key)
  }
}

function inside (scene, box) {
  return box.x >= 0 && box.y >= 0 && box.w >= 0 && box.h >= 0 &&
    box.x + box.w <= scene.width && box.y + box.h <= scene.height
}

function overlaps (a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function boxOk (x0, y0, x1, y1) {
  return x0 >= 0 && y0 >= 0 && x1 <= 100 && y1 <= 100 && x1 >= x0 && y1 >= y0
}

function assertShape (t, shape, label, keys) {
  t.ok(shape && typeof shape.fill === 'string' && keys.includes(shape.fill), label + ' fill ' + (shape && shape.fill))
  if (shape.kind === 'rect') {
    t.ok(boxOk(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h), label + ' rect')
  } else if (shape.kind === 'circle') {
    t.ok(boxOk(shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r), label + ' circle')
  } else if (shape.kind === 'ellipse') {
    t.ok(boxOk(shape.cx - shape.rx, shape.cy - shape.ry, shape.cx + shape.rx, shape.cy + shape.ry), label + ' ellipse')
  } else if (shape.kind === 'path') {
    const nums = (String(shape.d).match(/-?\d+\.?\d*/g) || []).map(Number)
    t.ok(nums.length > 0 && nums.every((n) => n >= 0 && n <= 100), label + ' path')
  } else {
    t.fail(label + ' kind')
  }
}

test('gardenScene: four distinct stages per plant', async (t) => {
  const m = await load()
  const ids = rpc.garden.GARDEN_PLANTS.map((plant) => plant.id)
  t.is(ids.length, 6)
  t.alike(Object.keys(m.PLANT_STAGES), ids)
  t.ok(Object.isFrozen(m.PLANT_STAGES))
  for (const id of ids) {
    const stages = m.PLANT_STAGES[id]
    t.ok(Array.isArray(stages) && stages.length === 4, id + ' has four stages')
    t.ok(Object.isFrozen(stages), id + ' stages frozen')
    for (let a = 0; a < 4; a++) {
      t.ok(stages[a].length > 0, id + ' stage ' + a + ' draws something')
      t.ok(Object.isFrozen(stages[a]), id + ' stage ' + a + ' frozen')
      for (let b = a + 1; b < 4; b++) {
        t.not(signature(stages[a]), signature(stages[b]), id + ' ' + a + ' differs from ' + b)
      }
    }
  }
  t.ok(m.PLANT_STAGES.manjericao[3].some((shape) => shape.fill === 'basil'))
  t.ok(m.PLANT_STAGES.tomate[3].some((shape) => shape.fill === 'tomato'))
  t.ok(m.PLANT_STAGES.pimenta[3].some((shape) => shape.fill === 'pepper'))
  t.ok(m.PLANT_STAGES.alecrim[3].some((shape) => shape.fill === 'rosemary'))
  t.ok(m.PLANT_STAGES.samambaia[3].some((shape) => shape.fill === 'fern'))
  const sword = m.PLANT_STAGES.espada[3].map((shape) => shape.fill)
  t.ok(sword.includes('snake') && sword.includes('snakeEdge'), 'ripe snake plant has a yellow edge')
})

test('gardenScene: fills name keys of both palettes', async (t) => {
  const m = await load()
  t.is(m.gardenPalette('dark'), m.DARK)
  t.is(m.gardenPalette('light'), m.LIGHT)
  t.is(m.gardenPalette(undefined), m.LIGHT)
  t.ok(Object.isFrozen(m.LIGHT) && Object.isFrozen(m.DARK))
  const lightKeys = Object.keys(m.LIGHT).sort()
  const darkKeys = Object.keys(m.DARK).sort()
  t.alike(lightKeys, darkKeys)
  for (const key of lightKeys) {
    t.ok(HEX.test(m.LIGHT[key]), 'light ' + key)
    t.ok(HEX.test(m.DARK[key]), 'dark ' + key)
  }
  for (const key of ['wall', 'floor', 'railing', 'railingShade', 'potClay', 'potRim', 'soilDry', 'soilWet', 'stem', 'leaf', 'leafDark', 'basil', 'tomato', 'pepper', 'rosemary', 'fern', 'snake', 'snakeEdge']) {
    t.ok(lightKeys.includes(key), 'palette has ' + key)
  }
  const groups = [
    [m.POT_SHAPES, 'pot'],
    [m.SOIL_DRY, 'soil dry'],
    [m.SOIL_WET, 'soil wet'],
    [m.EMPTY, 'empty']
  ]
  for (const id of Object.keys(m.PLANT_STAGES)) {
    m.PLANT_STAGES[id].forEach((stage, n) => groups.push([stage, id + ' ' + n]))
  }
  for (const [shapes, label] of groups) {
    t.ok(Array.isArray(shapes) && shapes.length > 0, label)
    for (const shape of shapes) assertShape(t, shape, label, lightKeys)
  }
  t.alike(m.EMPTY, m.POT_SHAPES.concat(m.SOIL_DRY))
  t.not(signature(m.SOIL_DRY), signature(m.SOIL_WET))
})

test('gardenScene: layout at 360, 375 and 1280', async (t) => {
  const m = await load()
  for (const width of [360, 375, 1280]) {
    const layout = m.gardenLayout(width)
    const bad = []
    wholePixels(layout, bad, String(width))
    t.alike(bad, [], width + ' is finite whole pixels')
    t.alike(layout, m.gardenLayout(width), width + ' is deterministic')
    t.is(layout.width, width)
    t.ok(layout.height > 0 && layout.height < width, width + ' height')
    t.is(layout.pots.length, 6)
    if (width > CAP) {
      t.is(layout.wall.w, CAP, 'capped')
      t.is(layout.wall.x, Math.round((width - CAP) / 2), 'centred')
    } else {
      t.is(layout.wall.w, width)
      t.is(layout.wall.x, 0)
    }
    t.is(layout.floor.x, layout.wall.x)
    t.is(layout.floor.w, layout.wall.w)
    t.ok(inside(layout, layout.wall), width + ' wall')
    t.ok(inside(layout, layout.floor), width + ' floor')
    t.ok(layout.railing.length > 0, width + ' railing')
    for (const bar of layout.railing) t.ok(inside(layout, bar), width + ' rail')
    const span = (box) => box.x >= layout.wall.x && box.x + box.w <= layout.wall.x + layout.wall.w
    for (const bar of layout.railing) t.ok(span(bar), width + ' rail in wall span')
    for (const pot of layout.pots) t.ok(span(pot), width + ' pot in wall span')
    const ys = [...new Set(layout.pots.map((pot) => pot.y))]
    const xs = [...new Set(layout.pots.map((pot) => pot.x))]
    t.is(ys.length, 2, width + ' two rows')
    t.is(xs.length, 3, width + ' three columns')
    for (let i = 0; i < layout.pots.length; i++) {
      const pot = layout.pots[i]
      t.is(pot.index, i)
      t.ok(pot.hit.w >= 44 && pot.hit.h >= 44, width + ' hit ' + i)
      t.ok(inside(layout, pot), width + ' pot ' + i)
      t.ok(inside(layout, pot.hit), width + ' hit box ' + i)
      for (let j = i + 1; j < layout.pots.length; j++) {
        t.absent(overlaps(pot.hit, layout.pots[j].hit), width + ' overlap ' + i + ' ' + j)
      }
    }
  }
})

test('gardenScene: potDrawing is empty, wet or safe', async (t) => {
  const m = await load()
  t.alike(m.potDrawing(null), m.EMPTY)
  t.alike(m.potDrawing(undefined), m.EMPTY)
  for (const bad of [0, 'tomate', true, []]) t.alike(m.potDrawing(bad), m.EMPTY)
  const dry = m.potDrawing({ plant: 'tomate', stage: 2, dry: true })
  const wet = m.potDrawing({ plant: 'tomate', stage: 2, dry: false })
  t.alike(dry, m.POT_SHAPES.concat(m.SOIL_DRY, m.PLANT_STAGES.tomate[2]))
  t.alike(wet, m.POT_SHAPES.concat(m.SOIL_WET, m.PLANT_STAGES.tomate[2]))
  t.not(signature(dry), signature(wet), 'dry and wet differ')
  t.ok(Object.isFrozen(dry) && Object.isFrozen(wet))
  t.alike(m.potDrawing({ plant: 'tomate', stage: 7, dry: false }), m.EMPTY)
  t.alike(m.potDrawing({ plant: 'rosa', stage: 1, dry: false }), m.EMPTY)
  t.alike(m.potDrawing({ plant: 'manjericao', stage: 1 }), m.POT_SHAPES.concat(m.SOIL_DRY, m.PLANT_STAGES.manjericao[1]))

  const trap = {}
  for (const key of ['plant', 'stage', 'dry', 'ripe']) {
    Object.defineProperty(trap, key, {
      enumerable: true,
      get () { throw new Error(key) }
    })
  }
  t.alike(m.potDrawing(trap), m.EMPTY, 'throwing getters read as empty')

  const hostile = new Proxy({ plant: 'tomate', stage: 3, dry: false }, {
    get () { throw new Error('get') },
    getOwnPropertyDescriptor () { throw new Error('desc') }
  })
  let err = null
  let drawn = null
  try {
    drawn = m.potDrawing(hostile)
  } catch (e) {
    err = e
  }
  t.is(err, null, 'hostile object does not throw')
  t.alike(drawn, m.EMPTY)
})

test('gardenScene: source has no em dash or en dash', (t) => {
  const src = fs.readFileSync(SRC, 'utf8')
  t.absent(src.includes('\u2014'), 'no em dash')
  t.absent(src.includes('\u2013'), 'no en dash')
  t.absent(src.includes("from 'react"), 'pure module')
  t.absent(src.includes('react-native'), 'no react-native')
  t.absent(src.includes('Math.random'), 'deterministic')
  t.absent(src.includes('require('), 'esm')
})

test('gardenScene: tiny frames give the empty layout', async (t) => {
  const m = await load()
  const MIN = 172
  for (const width of [0, 1, 40, MIN - 1]) {
    const layout = m.gardenLayout(width)
    t.is(layout.height, 0, width + ' empty')
    t.is(layout.pots.length, 6)
    t.ok(layout.pots.every((pot) => pot.w === 0 && pot.h === 0), width + ' zero pots')
    t.alike(layout.railing, [])
  }
  const layout = m.gardenLayout(MIN)
  t.ok(layout.height > 0)
  t.is(layout.pots.length, 6)
  t.ok(layout.pots.every((pot) => pot.hit.w >= 44 && pot.hit.h >= 44), 'threshold hit boxes')
})

test('gardenScene: railing fills are palette keys', async (t) => {
  const m = await load()
  for (const width of [360, 375, 1280]) {
    for (const bar of m.gardenLayout(width).railing) {
      t.ok(Object.hasOwn(m.LIGHT, bar.fill) && Object.hasOwn(m.DARK, bar.fill), width + ' ' + bar.fill)
    }
  }
})

test('gardenScene: potDrawing is potBase then plantShapes', async (t) => {
  const m = await load()
  const views = [
    { plant: 'tomate', stage: 2, dry: false },
    { plant: 'manjericao', stage: 0 },
    null,
    { plant: 'rosa', stage: 1 }
  ]
  for (const view of views) {
    t.alike(m.potDrawing(view), m.potBase(view).concat(m.plantShapes(view)))
    t.ok(Object.isFrozen(m.potBase(view)) && Object.isFrozen(m.plantShapes(view)))
  }
  t.alike(m.plantShapes(null), [])
  t.alike(m.plantShapes({ plant: 'tomate', stage: 3 }), m.PLANT_STAGES.tomate[3])
  const hostile = new Proxy({}, { get () { throw new Error('x') }, getOwnPropertyDescriptor () { throw new Error('x') } })
  t.alike(m.potBase(hostile), m.EMPTY)
  t.alike(m.plantShapes(hostile), [])
})

test('GardenSceneView: native driver off the web, plant-only sway', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/GardenSceneView.js'), 'utf8')
  t.ok(src.includes('Platform.select({ web: false, default: true })'))
  t.ok(src.includes('useNativeDriver: native'))
  t.absent(src.includes('useNativeDriver: false'))
  t.ok(src.includes('easing: Easing.linear') && src.includes('loopTiming({'), 'sine stops, linear timing')
  t.ok(src.includes('layout.height > 0'))
  t.ok(src.includes('[movingKey, sway]'), 'the loop restarts when the moving set changes')
  t.absent(src.includes('anyRipe'))
})
