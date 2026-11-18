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

// A path is pairs of numbers after M, L, C, Q and Z only, so every point
// can be bounded.
const PATH = /^(?:[MLCQ]-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?)*|Z)+$/

function pathPairs (d) {
  if (!PATH.test(String(d))) return null
  const nums = String(d).match(/-?\d+(?:\.\d+)?/g).map(Number)
  if (nums.length % 2 !== 0) return null
  const pairs = []
  for (let i = 0; i < nums.length; i += 2) pairs.push([nums[i], nums[i + 1]])
  return pairs
}

function assertPaint (t, shape, label, keys) {
  t.ok(shape && (shape.fill === 'none' || keys.includes(shape.fill)), label + ' fill ' + (shape && shape.fill))
  if (shape.stroke !== undefined) t.ok(keys.includes(shape.stroke) && shape.sw > 0, label + ' stroke ' + shape.stroke)
  if (shape.opacity !== undefined) t.ok(shape.opacity > 0 && shape.opacity <= 1, label + ' opacity')
  t.absent('transform' in shape, label + ' has no transform')
}

function assertShape (t, shape, label, keys, area) {
  const [ax0, ay0, ax1, ay1] = area || [0, 0, 100, 100]
  const ok = (x0, y0, x1, y1) => x0 >= ax0 && y0 >= ay0 && x1 <= ax1 && y1 <= ay1 && x1 >= x0 && y1 >= y0
  assertPaint(t, shape, label, keys)
  if (shape.kind === 'rect') {
    t.ok(ok(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h), label + ' rect')
  } else if (shape.kind === 'circle') {
    t.ok(ok(shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r), label + ' circle')
  } else if (shape.kind === 'ellipse') {
    t.ok(ok(shape.cx - shape.rx, shape.cy - shape.ry, shape.cx + shape.rx, shape.cy + shape.ry), label + ' ellipse')
  } else if (shape.kind === 'path') {
    const pairs = pathPairs(shape.d)
    t.ok(pairs && pairs.length > 0 && pairs.every(([x, y]) => ok(x, y, x, y)), label + ' path')
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
  t.ok(m.PLANT_STAGES.manjericao[3].some((shape) => shape.fill === 'leaf'))
  t.ok(m.PLANT_STAGES.tomate[3].some((shape) => shape.fill === 'tomato'))
  t.ok(m.PLANT_STAGES.pimenta[3].some((shape) => shape.fill === 'chili'))
  t.ok(m.PLANT_STAGES.alecrim[3].some((shape) => shape.stroke === 'ros'))
  t.ok(m.PLANT_STAGES.samambaia[3].some((shape) => shape.fill === 'fern'))
  const sword = m.PLANT_STAGES.espada[3].map((shape) => shape.fill)
  t.ok(sword.includes('snake') && sword.includes('snakeEdge'), 'ripe snake plant has a yellow edge')
  for (const id of ids) {
    const sparks = (stage) => m.PLANT_STAGES[id][stage].filter((shape) => shape.fill === 'spark').length
    t.ok(sparks(3) >= 2, id + ' sparkles when ripe')
    t.is(sparks(0) + sparks(1), 0, id + ' does not sparkle while young')
    t.ok(m.PLANT_STAGES[id][3].some((shape) => shape.stroke === 'ink'), id + ' is outlined')
  }
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
  const style = await import('../src/ui/gardenStyle.js')
  t.is(m.LIGHT, style.GARDEN_LIGHT, 'the scene palette is the style palette')
  t.is(m.DARK, style.GARDEN_DARK)
  for (const key of ['sky1', 'orb', 'city', 'roof', 'wood', 'woodHi', 'ink', 'floor', 'tile', 'pot', 'rim', 'soilDry', 'soilWet', 'stem', 'leaf', 'leaf2', 'tomato', 'chili', 'ros', 'fern', 'snake', 'snakeEdge', 'spark', 'glow', 'dotOn', 'dotOff', 'badge', 'drop']) {
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
  assertShape(t, m.RIPE_GLOW, 'glow', lightKeys)
  t.is(m.RIPE_GLOW.grad, 'glow')
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

const PHASE_KEYS = ['width', 'height', 'wall', 'floor', 'roof', 'horizon', 'railing', 'pots']
const DECOR_ORDER = ['rede', 'varal', 'gato', 'pisca']

test('gardenScene: missing decor keeps the phase 1 balcony', async (t) => {
  const m = await load()
  for (const width of [360, 375, 1280]) {
    const plain = m.gardenLayout(width)
    t.alike(Object.keys(plain), PHASE_KEYS, width + ' six keys')
    t.absent(plain.decor, width + ' no decor')
    t.alike(m.gardenLayout(width, {}), plain, width + ' empty opts')
    t.alike(m.gardenLayout(width, { decor: [] }), plain, width + ' empty list')
    t.alike(m.gardenLayout(width, { decor: ['lamp', 'cadeira'] }), plain, width + ' unknown ids')
    t.ok(plain.height > 0 && plain.height < width, width + ' phase 1 height')
  }
  const at360 = m.gardenLayout(360)
  t.is(at360.height, 297)
  t.alike(at360.wall, { x: 0, y: 0, w: 360, h: 196 })
  t.alike(at360.floor, { x: 0, y: 196, w: 360, h: 101 })
  t.alike(at360.roof, { x: 0, y: 0, w: 360, h: 31 })
  t.is(at360.horizon, 144)
  t.alike(at360.pots[0], { index: 0, x: 15, y: 39, w: 103, h: 118, hit: { x: 15, y: 39, w: 103, h: 118 } })
  t.alike(at360.pots[5], { index: 5, x: 243, y: 165, w: 103, h: 118, hit: { x: 243, y: 165, w: 103, h: 118 } })
})

test('gardenScene: the back row stands on the cap, the front row on the floor', async (t) => {
  const m = await load()
  for (const width of [172, 360, 375, 1280]) {
    for (const decor of [[], DECOR_ORDER]) {
      const layout = m.gardenLayout(width, { decor })
      const label = width + ' ' + decor.join(',')
      const back = layout.pots[0]
      const front = layout.pots[3]
      const base = (pot) => pot.y + Math.round(pot.h * (95 - m.POT_BOX.y) / m.POT_BOX.h)
      t.is(layout.horizon, base(back), label + ' cap top under the back pots')
      const cap = layout.railing.find((bar) => bar.fill === 'woodHi')
      t.ok(cap && cap.y === layout.horizon && cap.w === layout.wall.w, label + ' the cap spans the balcony')
      t.ok(layout.floor.y < base(front) && base(front) < layout.height, label + ' front pots on the floor')
      t.ok(layout.roof.h > 0 && layout.roof.y === 0 && layout.roof.x === layout.wall.x && layout.roof.w === layout.wall.w, label + ' roof on top')
      for (const pot of layout.pots) t.absent(overlaps(pot, layout.roof), label + ' pot under the roof')
      const posts = layout.railing.filter((bar) => bar.y === layout.roof.h)
      t.is(posts.length, 2, label + ' two posts from the roof')
      for (const post of posts) t.is(post.y + post.h, layout.floor.y, label + ' post down to the floor')
    }
  }
})

test('gardenScene: the backdrop fills the scene, stars only at night', async (t) => {
  const m = await load()
  const style = await import('../src/ui/gardenStyle.js')
  const keys = Object.keys(m.LIGHT)
  for (const width of [172, 360, 1280]) {
    for (const decor of [[], DECOR_ORDER]) {
      const layout = m.gardenLayout(width, { decor })
      const label = width + ' ' + decor.join(',')
      const area = [layout.wall.x, 0, layout.wall.x + layout.wall.w, layout.height]
      for (const scheme of ['light', 'dark']) {
        const shapes = m.backdropShapes(layout, scheme)
        t.ok(Array.isArray(shapes) && shapes.length > 0 && Object.isFrozen(shapes), label + ' ' + scheme)
        t.is(m.backdropShapes(layout, scheme), shapes, label + ' ' + scheme + ' cached')
        for (const shape of shapes) {
          assertShape(t, shape, label + ' ' + scheme, keys, area)
          if (shape.grad !== undefined) t.ok(Object.hasOwn(style.gardenGradients(scheme), shape.grad), 'gradient ' + shape.grad)
        }
      }
      const fills = (scheme) => m.backdropShapes(layout, scheme).map((shape) => shape.fill)
      t.absent(fills('light').includes('star') || fills('light').includes('window'), label + ' day draws no stars or windows')
      t.ok(fills('dark').includes('star') && fills('dark').includes('window'), label + ' night has stars and lit windows')
      t.is(m.backdropShapes(layout, 'light')[0].grad, 'sky', label + ' sky first')
      const rails = m.railShapes(layout)
      t.is(rails.length, layout.railing.length, label + ' one shape per bar')
      t.is(m.railShapes(layout), rails, label + ' rails cached')
      for (const shape of rails) assertShape(t, shape, label + ' rail', keys, area)
    }
  }
  for (const bad of [null, undefined, 0, 'x', {}, { wall: { x: 0, y: 0, w: 10, h: 10 } }, m.gardenLayout(40)]) {
    t.alike(m.backdropShapes(bad, 'light'), [], 'nothing for ' + String(bad))
  }
  const hostile = Object.freeze(new Proxy({}, { get () { throw new Error('get') }, getOwnPropertyDescriptor () { throw new Error('desc') } }))
  t.alike(m.backdropShapes(hostile, 'dark'), [])
  t.alike(m.railShapes(hostile), [])
  t.alike(m.railShapes(null), [])
})

test('gardenScene: cues are the stage dots and, when it can take water, the drop', async (t) => {
  const m = await load()
  const keys = Object.keys(m.LIGHT)
  const area = [0, m.POT_BOX.y, m.POT_BOX.w, m.POT_BOX.y + m.POT_BOX.h]
  for (const bad of [null, undefined, 0, 'tomate', { plant: 'rosa', stage: 1 }, { plant: 'tomate', stage: 9 }]) {
    t.alike(m.potCues(bad), [], 'an empty pot says nothing')
  }
  for (let stage = 0; stage < 4; stage++) {
    const cues = m.potCues({ plant: 'alecrim', stage, dry: true, canWater: false })
    t.ok(Object.isFrozen(cues))
    t.is(cues.length, 4, 'four dots at stage ' + stage)
    t.is(cues.filter((shape) => shape.fill === 'dotOn').length, stage + 1, 'filled up to stage ' + stage)
    for (const shape of cues) assertShape(t, shape, 'cue', keys, area)
    for (const shape of cues) t.ok(shape.cy - shape.r > 95, 'dots under the pot')
  }
  const thirsty = m.potCues({ plant: 'tomate', stage: 1, dry: true, canWater: true })
  t.ok(thirsty.length > 4 && thirsty.some((shape) => shape.fill === 'drop'), 'the drop shows')
  for (const shape of thirsty) assertShape(t, shape, 'badge', keys, area)
  t.absent(m.potCues({ plant: 'tomate', stage: 1, dry: true, canWater: 1 }).some((shape) => shape.fill === 'drop'), 'only exactly true')
  const trap = { plant: 'tomate', stage: 1 }
  Object.defineProperty(trap, 'canWater', { enumerable: true, get () { throw new Error('canWater') } })
  let err = null
  try {
    t.is(m.potCues(trap).length, 4, 'a getter is not called')
  } catch (e) {
    err = e
  }
  t.is(err, null)
})

test('gardenScene: DECOR_IDS matches the rules list', async (t) => {
  const m = await load()
  t.alike(m.DECOR_IDS, rpc.garden.GARDEN_DECOR_IDS)
  t.alike(m.DECOR_IDS, DECOR_ORDER)
  t.ok(Object.isFrozen(m.DECOR_IDS))
})

test('gardenScene: enfeite bands clear the pots and the railing', async (t) => {
  const m = await load()
  const sets = DECOR_ORDER.map((id) => [id]).concat([DECOR_ORDER])
  for (const width of [172, 360, 375, 1280]) {
    const plain = m.gardenLayout(width)
    for (const decor of sets) {
      const label = width + ' ' + decor.join(',')
      const layout = m.gardenLayout(width, { decor })
      const flipped = m.gardenLayout(width, { decor: decor.slice().reverse() })
      t.alike(layout, flipped, label + ' order does not matter')
      t.alike(layout, m.gardenLayout(width, { decor: decor.slice() }), label + ' deterministic')
      t.ok(Object.isFrozen(layout) && Object.isFrozen(layout.decor), label + ' frozen')
      t.ok(Object.isFrozen(layout.pots) && Object.isFrozen(layout.railing), label + ' scene frozen')
      const bad = []
      wholePixels(layout, bad, label)
      t.alike(bad, [], label + ' whole pixels')
      t.alike(Object.keys(layout), PHASE_KEYS.concat(['decor']), label + ' keys')
      t.ok(Object.isFrozen(layout.roof), label + ' roof frozen')
      t.alike(Object.keys(layout.decor), DECOR_ORDER.filter((id) => decor.includes(id)), label + ' decor keys')
      t.ok(layout.height > plain.height, label + ' adds height')
      t.is(layout.width, width)
      t.is(layout.pots.length, 6, label + ' six pots')
      t.ok(inside(layout, layout.wall) && inside(layout, layout.floor), label + ' wall and floor')
      const span = (box) => box.x >= layout.wall.x && box.x + box.w <= layout.wall.x + layout.wall.w
      for (const bar of layout.railing) {
        t.ok(inside(layout, bar), label + ' rail inside')
        t.ok(span(bar), label + ' rail in the balcony')
      }
      for (let i = 0; i < layout.pots.length; i++) {
        const pot = layout.pots[i]
        t.ok(pot.hit.w >= 44 && pot.hit.h >= 44, label + ' hit ' + i)
        t.ok(inside(layout, pot) && inside(layout, pot.hit), label + ' pot ' + i)
        t.ok(span(pot), label + ' pot in the balcony')
        for (let j = i + 1; j < layout.pots.length; j++) {
          t.absent(overlaps(pot.hit, layout.pots[j].hit), label + ' pot overlap ' + i)
        }
      }
      const ids = Object.keys(layout.decor)
      for (let i = 0; i < ids.length; i++) {
        const rect = layout.decor[ids[i]]
        t.ok(Object.isFrozen(rect), label + ' rect frozen')
        t.alike(Object.keys(rect).sort(), ['h', 'w', 'x', 'y'], label + ' rect keys')
        t.ok(rect.w > 0 && rect.h > 0, label + ' rect has area')
        t.ok(inside(layout, rect), label + ' ' + ids[i] + ' inside')
        t.ok(span(rect), label + ' ' + ids[i] + ' in the balcony')
        for (const pot of layout.pots) t.absent(overlaps(rect, pot), label + ' ' + ids[i] + ' pot')
        for (const bar of layout.railing) t.absent(overlaps(rect, bar), label + ' ' + ids[i] + ' rail')
        t.absent(overlaps(rect, layout.roof), label + ' ' + ids[i] + ' roof')
        for (let j = i + 1; j < ids.length; j++) {
          t.absent(overlaps(rect, layout.decor[ids[j]]), label + ' ' + ids[i] + ' ' + ids[j])
        }
      }
    }
  }
  const full = m.gardenLayout(360, { decor: DECOR_ORDER })
  t.ok(full.height > full.width, 'decorated height may pass the width')
})

test('gardenScene: enfeite rects are fixed for the frame', async (t) => {
  const m = await load()
  const all = m.gardenLayout(360, { decor: ['pisca', 'varal', 'rede', 'gato'] })
  t.alike(all.decor, {
    rede: { x: 15, y: 53, w: 160, h: 52 },
    varal: { x: 186, y: 53, w: 160, h: 52 },
    gato: { x: 243, y: 361, w: 103, h: 46 },
    pisca: { x: 15, y: 31, w: 331, h: 22 }
  })
  t.is(all.height, 421)
  t.alike(m.gardenLayout(360, { decor: ['pisca'] }).decor, {
    pisca: { x: 15, y: 31, w: 331, h: 22 }
  })
  t.alike(m.gardenLayout(360, { decor: ['rede'] }).decor, {
    rede: { x: 15, y: 31, w: 160, h: 52 }
  })
  t.alike(m.gardenLayout(360, { decor: ['varal'] }).decor, {
    varal: { x: 186, y: 31, w: 160, h: 52 }
  })
  t.alike(m.gardenLayout(360, { decor: ['gato'] }).decor, {
    gato: { x: 243, y: 287, w: 103, h: 46 }
  })
  const redeOnly = m.gardenLayout(360, { decor: ['rede'] })
  const redeLit = m.gardenLayout(360, { decor: ['rede', 'pisca'] })
  t.ok(redeLit.decor.rede.y > redeOnly.decor.rede.y, 'lights push the net down')
  t.alike(redeLit.decor.pisca, all.decor.pisca, 'pisca stays on the top band')
  const listed = ['gato', 'pisca']
  const copy = listed.slice()
  m.gardenLayout(360, { decor: listed, x: 3, y: 4, w: 9, h: 9 })
  t.alike(listed, copy, 'opts are not mutated')
  t.alike(
    m.gardenLayout(360, { decor: ['gato'], x: 3, y: 4, w: 9, h: 9 }),
    m.gardenLayout(360, { decor: ['gato'] }),
    'coordinates in opts are ignored'
  )
  t.alike(
    m.gardenLayout(360, { decor: ['gato', 'gato', 'lamp'] }).decor,
    m.gardenLayout(360, { decor: ['gato'] }).decor,
    'a repeat and an unknown id add no rect'
  )
  t.alike(
    m.gardenLayout(360, { decor: ['nope', 'rede', 'varal', 'gato', 'pisca', 'x'] }).decor,
    m.gardenLayout(360, { decor: DECOR_ORDER }).decor,
    'unknown ids do not drop a known one'
  )
  t.alike(
    m.gardenLayout(360, { decor: [1, 'rede', null, {}] }).decor,
    m.gardenLayout(360, { decor: ['rede'] }).decor,
    'a non string is skipped'
  )
})

test('gardenScene: hostile decor opts draw no enfeites', async (t) => {
  const m = await load()
  const plain = m.gardenLayout(360)
  const throwing = {}
  Object.defineProperty(throwing, 'decor', {
    enumerable: true,
    get () { throw new Error('decor') }
  })
  const yielding = {}
  Object.defineProperty(yielding, 'decor', {
    enumerable: true,
    get () { return ['pisca', 'gato', 'rede', 'varal'] }
  })
  const proxy = new Proxy({ decor: ['rede', 'varal', 'gato', 'pisca'] }, {
    get () { throw new Error('get') },
    getOwnPropertyDescriptor () { throw new Error('desc') }
  })
  const arrayProxy = new Proxy(['pisca', 'rede'], {
    get () { throw new Error('get') },
    getOwnPropertyDescriptor () { throw new Error('desc') }
  })
  const sneaky = ['rede']
  Object.defineProperty(sneaky, '1', {
    enumerable: true,
    get () { throw new Error('item') }
  })
  const optsList = [
    throwing,
    yielding,
    proxy,
    { decor: arrayProxy },
    { decor: 'pisca' },
    { decor: null },
    { decor: { 0: 'gato', length: 1 } },
    null,
    0
  ]
  for (const opts of optsList) {
    let err = null
    let layout = null
    try {
      layout = m.gardenLayout(360, opts)
    } catch (e) {
      err = e
    }
    t.is(err, null, 'does not throw')
    t.alike(layout, plain, 'unchanged')
  }
  const beside = { decor: ['gato'] }
  Object.defineProperty(beside, 'x', {
    enumerable: true,
    get () { throw new Error('x') }
  })
  let err = null
  let layout = null
  try {
    layout = m.gardenLayout(360, beside)
  } catch (e) {
    err = e
  }
  t.is(err, null, 'a sibling getter is not read')
  t.alike(layout.decor, m.gardenLayout(360, { decor: ['gato'] }).decor)
  const onlyRede = m.gardenLayout(360, { decor: ['rede'] })
  t.alike(m.gardenLayout(360, { decor: sneaky }), onlyRede, 'an accessor entry reads as no id and is never called')
  t.alike(m.gardenLayout(360, { decor: [, 'rede'] }), onlyRede, 'a hole reads as no id') // eslint-disable-line no-sparse-arrays
  t.alike(m.gardenLayout(360, { decor: new Array(9).fill('rede') }), onlyRede, 'a long list still draws its ids')
  const past = ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'rede']
  t.alike(m.gardenLayout(360, { decor: past }), plain, 'an id past the eighth entry is not read')
})

test('gardenScene: a frame too small ignores enfeites', async (t) => {
  const m = await load()
  const opts = { decor: ['rede', 'varal', 'gato', 'pisca'] }
  for (const width of [0, 1, 40, 171, -5, NaN, Infinity]) {
    const layout = m.gardenLayout(width, opts)
    t.alike(layout, m.gardenLayout(width), width + ' unchanged')
    t.is(layout.height, 0, width + ' empty')
    t.absent(layout.decor, width + ' no decor')
  }
  const hostile = new Proxy(opts, {
    get () { throw new Error('get') },
    getOwnPropertyDescriptor () { throw new Error('desc') }
  })
  t.alike(m.gardenLayout(40, hostile), m.gardenLayout(40))
  t.alike(m.gardenLayout(171, hostile), m.gardenLayout(171))
})
