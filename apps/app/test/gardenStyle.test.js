'use strict'

// The Varandinha look (src/ui/gardenStyle.js). import() loads the ESM module.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const rpc = require('@varanda/rpc')

const load = () => import('../src/ui/gardenStyle.js')
const SRC = path.join(__dirname, '../src/ui/gardenStyle.js')
const HEX = /^#[0-9a-f]{6}$/
const PATH = /^(?:[MLCQ]-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?)*|Z)+$/
const PLANT_IDS = rpc.garden.GARDEN_PLANTS.map((p) => p.id)

function pairs (d) {
  if (!PATH.test(String(d))) return null
  const nums = String(d).match(/-?\d+(?:\.\d+)?/g).map(Number)
  if (nums.length % 2 !== 0) return null
  const out = []
  for (let i = 0; i < nums.length; i += 2) out.push([nums[i], nums[i + 1]])
  return out
}

function assertShape (t, shape, label, keys, box) {
  const ok = (x0, y0, x1, y1) => x0 >= 0 && y0 >= 0 && x1 <= box.w && y1 <= box.h && x1 >= x0 && y1 >= y0
  t.ok(Object.isFrozen(shape), label + ' frozen')
  t.ok(shape.fill === 'none' || keys.includes(shape.fill), label + ' fill ' + shape.fill)
  if (shape.stroke !== undefined) t.ok(keys.includes(shape.stroke) && shape.sw > 0, label + ' stroke ' + shape.stroke)
  t.ok(shape.fill !== 'none' || shape.stroke !== undefined, label + ' paints something')
  t.absent('transform' in shape, label + ' has no transform')
  if (shape.kind === 'rect') t.ok(ok(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h), label + ' rect')
  else if (shape.kind === 'circle') t.ok(ok(shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r), label + ' circle')
  else if (shape.kind === 'ellipse') t.ok(ok(shape.cx - shape.rx, shape.cy - shape.ry, shape.cx + shape.rx, shape.cy + shape.ry), label + ' ellipse')
  else if (shape.kind === 'path') {
    const pts = pairs(shape.d)
    t.ok(pts && pts.length > 0 && pts.every(([x, y]) => ok(x, y, x, y)), label + ' path ' + shape.d)
  } else t.fail(label + ' kind')
}

function luminance (hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast (a, b) {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function hostiles () {
  const getter = {}
  for (const key of ['stage', 'canWater', 'ripe', 'plant']) {
    Object.defineProperty(getter, key, { enumerable: true, get () { throw new Error(key) } })
  }
  const proxy = new Proxy({}, {
    get () { throw new Error('get') },
    getOwnPropertyDescriptor () { throw new Error('desc') },
    ownKeys () { throw new Error('keys') }
  })
  const held = Proxy.revocable({}, {})
  held.revoke()
  const inherited = Object.create({ stage: 3, canWater: true, ripe: true })
  return [undefined, null, 0, 'x', [], getter, proxy, held.proxy, inherited]
}

function call (fn) {
  try {
    return { err: null, value: fn() }
  } catch (err) {
    return { err, value: null }
  }
}

test('gardenStyle: both palettes share keys and hold hex colours', async (t) => {
  const m = await load()
  t.ok(Object.isFrozen(m.GARDEN_LIGHT) && Object.isFrozen(m.GARDEN_DARK))
  t.alike(Object.keys(m.GARDEN_LIGHT).sort(), Object.keys(m.GARDEN_DARK).sort())
  for (const key of Object.keys(m.GARDEN_LIGHT)) {
    t.ok(HEX.test(m.GARDEN_LIGHT[key]), 'light ' + key)
    t.ok(HEX.test(m.GARDEN_DARK[key]), 'dark ' + key)
  }
  for (const key of ['sky1', 'sky2', 'sky3', 'sky4', 'orb', 'halo', 'city', 'star', 'window', 'roof', 'wood', 'ink', 'floor', 'pot', 'rim', 'soilDry', 'soilWet', 'leaf', 'tomato', 'chili', 'ros', 'fern', 'snake', 'spark', 'glow', 'badge', 'drop', 'dotOn', 'dotOff', 'card', 'cardInk', 'lift', 'text', 'muted', 'accent', 'accentText', 'onAccent', 'danger']) {
    t.ok(Object.hasOwn(m.GARDEN_LIGHT, key), 'has ' + key)
  }
  t.not(m.GARDEN_LIGHT.sky1, m.GARDEN_DARK.sky1, 'day and night skies differ')
  t.not(m.GARDEN_LIGHT.card, m.GARDEN_DARK.card, 'cards follow the scheme')
  t.is(m.gardenTokens('dark'), m.GARDEN_DARK)
  t.is(m.gardenTokens('light'), m.GARDEN_LIGHT)
  for (const odd of [undefined, null, 'Dark', 1, {}]) t.is(m.gardenTokens(odd), m.GARDEN_LIGHT)
})

test('gardenStyle: sheet text reads on its card', async (t) => {
  const m = await load()
  for (const scheme of ['light', 'dark']) {
    const c = m.gardenTokens(scheme)
    for (const key of ['text', 'muted', 'accentText', 'danger']) {
      t.ok(contrast(c[key], c.card) >= 4.5, scheme + ' ' + key + ' on card')
    }
    t.ok(contrast(c.onAccent, c.accent) >= 4.5, scheme + ' label on the primary button')
    t.ok(contrast(c.dotOn, c.dotOff) >= 3, scheme + ' a filled dot stands out')
    t.ok(contrast(c.drop, c.badge) >= 3, scheme + ' the drop reads on its disc')
  }
})

test('gardenStyle: gradients resolve to palette colours', async (t) => {
  const m = await load()
  for (const scheme of ['light', 'dark']) {
    const grads = m.gardenGradients(scheme)
    t.ok(Object.isFrozen(grads))
    t.alike(Object.keys(grads).sort(), ['glow', 'halo', 'sky'])
    t.is(grads.sky.kind, 'linear')
    t.is(grads.halo.kind, 'radial')
    t.is(grads.glow.kind, 'radial')
    const colours = Object.values(m.gardenTokens(scheme))
    for (const id of Object.keys(grads)) {
      const stops = grads[id].stops
      t.ok(stops.length >= 2, id + ' has stops')
      t.is(stops[0].offset, 0)
      t.is(stops[stops.length - 1].offset, 1)
      for (let i = 0; i < stops.length; i++) {
        t.ok(colours.includes(stops[i].color), scheme + ' ' + id + ' stop colour')
        t.ok(stops[i].opacity >= 0 && stops[i].opacity <= 1, scheme + ' ' + id + ' stop opacity')
        if (i > 0) t.ok(stops[i].offset > stops[i - 1].offset, id + ' offsets rise')
      }
    }
    t.is(grads.halo.stops[grads.halo.stops.length - 1].opacity, 0, 'halo fades out')
    t.is(grads.glow.stops[grads.glow.stops.length - 1].opacity, 0, 'glow fades out')
  }
  t.is(m.gardenGradients(null), m.gardenGradients('light'))
})

test('gardenStyle: placePath moves, turns, mirrors and scales', async (t) => {
  const m = await load()
  t.is(m.placePath('M0 0L10 0', {}), 'M0 0L10 0')
  t.is(m.placePath('M0 0L10 0', { x: 5, y: 7 }), 'M5 7L15 7')
  t.is(m.placePath('M0 0L10 0', { s: 2 }), 'M0 0L20 0')
  t.is(m.placePath('M0 0L10 0', { r: 90 }), 'M0 0L0 10')
  t.is(m.placePath('M0 0L10 0', { flip: true }), 'M0 0L-10 0')
  t.is(m.placePath('M0 0H10V5Z', {}), 'M0 0L10 0L10 5Z', 'H and V become L')
  t.is(m.placePath('M0 0 10 0 10 5', {}), 'M0 0L10 0L10 5', 'pairs after M are linetos')
  t.is(m.placePath('M0 0C1 2 3 4 5 6Q7 8 9 10', { x: 1 }), 'M1 0C2 2 4 4 6 6Q8 8 10 10')
  t.is(m.placePath('M0 0L1 1', { s: -2 }), 'M0 0L1 1', 'a bad scale is 1')
  t.is(m.placePath('M0 0L1 1', { x: NaN, y: Infinity }), 'M0 0L1 1', 'bad offsets are 0')
  t.is(m.placePath('M0.333 0L1 1', null), 'M0.33 0L1 1', 'two decimals')
  for (const bad of ['', 'L', '1 2', 'M1', 'M1 2C3 4', 'A1 1 0 0 1 2 2', null, undefined, {}]) {
    const got = call(() => m.placePath(bad, {}))
    t.is(got.err, null, 'malformed does not throw')
    t.ok(got.value === '' || PATH.test(got.value), 'malformed gives a safe path: ' + String(bad))
  }
  t.is(m.placePath('M1 2C3 4', {}), '', 'a short curve is nothing')
  t.is(m.placePath('A1 1 0 0 1 2 2', {}), '', 'arcs are not in the vocabulary')
  for (const key of Object.keys(m.PATHS)) {
    t.ok(PATH.test(m.placePath(m.PATHS[key], { x: 50, y: 50 })), key + ' places')
  }
})

test('gardenStyle: placeShapes keeps paint and stroke widths', async (t) => {
  const m = await load()
  const [rect, circle, ellipse, p] = m.placeShapes([
    { kind: 'rect', x: 1, y: 2, w: 3, h: 4, rx: 1, fill: 'pot', stroke: 'ink', sw: 1.5 },
    { kind: 'circle', cx: 1, cy: 1, r: 2, fill: 'dotOn' },
    { kind: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 1, fill: 'shadow', opacity: 0.2 },
    { kind: 'path', d: 'M0 0L1 0', fill: 'none', stroke: 'stem', sw: 2 }
  ], { x: 10, y: 20, s: 2 })
  t.alike(rect, { kind: 'rect', x: 12, y: 24, w: 6, h: 8, rx: 2, fill: 'pot', stroke: 'ink', sw: 1.5 })
  t.alike(circle, { kind: 'circle', cx: 12, cy: 22, r: 4, fill: 'dotOn' })
  t.alike(ellipse, { kind: 'ellipse', cx: 10, cy: 20, rx: 4, ry: 2, fill: 'shadow', opacity: 0.2 })
  t.alike(p, { kind: 'path', d: 'M10 20L12 20', fill: 'none', stroke: 'stem', sw: 2 })
  const [flipped] = m.placeShapes([{ kind: 'rect', x: 1, y: 0, w: 3, h: 1, fill: 'pot' }], { x: 10, flip: true })
  t.is(flipped.x, 6, 'a mirrored rect keeps a positive width')
  t.is(flipped.w, 3)
})

test('gardenStyle: dots, thirst and ripeness read own data only', async (t) => {
  const m = await load()
  for (let stage = 0; stage < 4; stage++) {
    const dots = m.stageDots({ stage })
    t.ok(Object.isFrozen(dots))
    t.is(dots.length, 4)
    t.is(dots.filter(Boolean).length, stage + 1, 'stage ' + stage)
    t.ok(dots.every((on, i) => on === (i <= stage)), 'filled from the left')
    const row = m.dotRow({ stage }, 20, 5, 3.6, 10)
    t.ok(Object.isFrozen(row) && row.length === 4)
    t.is(row.filter((dot) => dot.fill === 'dotOn').length, stage + 1)
    t.alike(row.map((dot) => dot.cx), [5, 15, 25, 35], 'centred on cx')
    for (const dot of row) assertShape(t, dot, 'dot', Object.keys(m.GARDEN_LIGHT), { w: 40, h: 10 })
  }
  for (const odd of [-1, 4, 1.5, '1', null, NaN]) {
    t.ok(m.stageDots({ stage: odd }).every((on) => on === false), 'no dots for ' + String(odd))
  }
  t.is(m.thirsty({ canWater: true }), true)
  t.is(m.ripeOf({ ripe: true }), true)
  for (const view of [{ canWater: 1 }, { canWater: 'true' }, { canWater: false }, {}]) t.is(m.thirsty(view), false)
  for (const view of [{ ripe: 1 }, { ripe: false }, {}]) t.is(m.ripeOf(view), false)
  for (const view of hostiles()) {
    for (const fn of ['stageDots', 'thirsty', 'ripeOf']) {
      const got = call(() => m[fn](view))
      t.is(got.err, null, fn + ' does not throw')
    }
    t.ok(m.stageDots(view).every((on) => on === false), 'hostile has no dots')
    t.is(m.thirsty(view), false, 'hostile is not thirsty')
    t.is(m.ripeOf(view), false, 'hostile is not ripe')
    t.is(call(() => m.dotRow(view, 20, 5, 3.6, 10)).err, null, 'dotRow does not throw')
  }
})

test('gardenStyle: badge, gifts and stall stay in their boxes', async (t) => {
  const m = await load()
  const keys = Object.keys(m.GARDEN_LIGHT)
  t.is(m.THIRST_BADGE.w, 24)
  t.is(m.THIRST_BADGE.h, 24)
  t.ok(m.THIRST_BADGE.shapes.some((shape) => shape.fill === 'drop'), 'the badge is a drop')
  for (const shape of m.THIRST_BADGE.shapes) assertShape(t, shape, 'badge', keys, m.THIRST_BADGE)
  const seen = new Set()
  for (const id of PLANT_IDS) {
    const drawing = m.giftDrawing(id)
    t.is(drawing.w, 48, id)
    t.is(drawing.h, 48, id)
    t.ok(Object.isFrozen(drawing) && drawing.shapes.length >= 3, id + ' draws')
    t.ok(drawing.shapes.some((shape) => shape.stroke === 'ink'), id + ' is outlined')
    const sig = JSON.stringify(drawing.shapes)
    t.absent(seen.has(sig), id + ' is its own drawing')
    seen.add(sig)
    for (const shape of drawing.shapes) assertShape(t, shape, 'gift ' + id, keys, drawing)
  }
  const empty = m.giftDrawing('rosa')
  t.alike(empty, { w: 48, h: 48, shapes: [] })
  t.ok(Object.isFrozen(empty) && Object.isFrozen(empty.shapes))
  for (const odd of [undefined, null, '', 'Tomate', '__proto__', 'constructor', 'hasOwnProperty', 1, [], {}, Symbol('tomate')].concat(hostiles())) {
    const got = call(() => m.giftDrawing(odd))
    t.is(got.err, null, 'odd item does not throw')
    t.is(got.value, empty, 'odd item is the empty drawing')
  }
  t.is(m.STALL_DRAWING.w, 358)
  t.is(m.STALL_DRAWING.h, 96)
  t.ok(m.STALL_DRAWING.shapes.some((shape) => shape.fill === 'awning') && m.STALL_DRAWING.shapes.some((shape) => shape.fill === 'awningAlt'), 'striped awning')
  for (const shape of m.STALL_DRAWING.shapes) assertShape(t, shape, 'stall', keys, m.STALL_DRAWING)
})

test('gardenStyle: card styles keep every target at least 44 tall', async (t) => {
  const m = await load()
  t.is(m.HIT, 44)
  for (const scheme of ['light', 'dark']) {
    const tokens = m.gardenTokens(scheme)
    const s = m.gardenCardStyles(tokens)
    for (const key of ['card', 'row', 'btn']) t.ok(s[key].minHeight >= 44, scheme + ' ' + key)
    t.ok(s.tile.minHeight >= 44, scheme + ' tile')
    t.is(s.card.backgroundColor, tokens.card)
    t.is(s.card.borderColor, tokens.cardInk)
    t.is(s.cardLift.backgroundColor, tokens.lift)
    t.is(s.cardLift.top, m.LIFT, 'the shadow sits under the card')
    t.is(s.card.flexGrow, 1, 'a card stretched by its row fills its wrap, so the shadow stays under it')
    t.is(s.btnPrimary.backgroundColor, tokens.accent)
    t.is(s.btnLabel.color, tokens.onAccent)
    t.is(s.btnLabelDanger.color, tokens.danger)
    for (const key of Object.keys(s)) {
      t.absent('elevation' in s[key] || 'shadowColor' in s[key], key + ' draws its own shadow')
    }
  }
  t.alike(m.gardenCardStyles(null), m.gardenCardStyles(m.GARDEN_LIGHT), 'no tokens is the day look')
})

test('gardenStyle: source is pure and deterministic', (t) => {
  const src = fs.readFileSync(SRC, 'utf8')
  t.absent(src.includes('\u2014'), 'no em dash')
  t.absent(src.includes('–'), 'no en dash')
  t.absent(src.includes('Math.random'), 'deterministic')
  t.absent(src.includes('Date.now') || src.includes('new Date'), 'no clock')
  t.absent(src.includes('require('), 'esm')
  t.absent(/from 'react'|from 'react-native'|react-native-svg/.test(src), 'no react')
  t.absent(/from '(?:fs|path|os|node:)/.test(src), 'no node built-ins')
})
