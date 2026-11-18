'use strict'

// The four enfeites (src/ui/gardenDecor.js). import() loads the ESM module.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const rpc = require('@varanda/rpc')

const load = () => import('../src/ui/gardenDecor.js')
const SRC = path.join(__dirname, '../src/ui/gardenDecor.js')
const HEX = /^#[0-9a-f]{6}$/
const PALETTE_KEYS = ['cloth', 'clothAlt', 'fur', 'furDark', 'lamp', 'rope']
const BOX = {
  rede: { w: 150, h: 50 },
  varal: { w: 150, h: 50 },
  gato: { w: 100, h: 100 },
  pisca: { w: 300, h: 20 }
}
const EMPTY = { w: 1, h: 1, shapes: [] }

function isInt (n) {
  return typeof n === 'number' && Number.isFinite(n) && Math.round(n) === n
}

function inside (x0, y0, x1, y1, box) {
  return isInt(x0) && isInt(y0) && isInt(x1) && isInt(y1) &&
    x0 >= 0 && y0 >= 0 && x1 <= box.w && y1 <= box.h && x1 > x0 && y1 > y0
}

function pathPoints (d) {
  const nums = String(d).match(/-?\d+\.?\d*/g)
  if (!nums || nums.length < 2 || nums.length % 2 !== 0) return null
  const pts = []
  for (let i = 0; i < nums.length; i += 2) {
    const x = Number(nums[i])
    const y = Number(nums[i + 1])
    if (!isInt(x) || !isInt(y)) return null
    pts.push([x, y])
  }
  return pts
}

function assertShape (t, shape, label, lightKeys, darkKeys, box) {
  if (!shape || typeof shape !== 'object') {
    t.fail(label + ' shape')
    return
  }
  t.ok(Object.isFrozen(shape), label + ' frozen')
  const fill = shape.fill
  t.ok(lightKeys.includes(fill) && darkKeys.includes(fill), label + ' fill ' + fill)
  if (shape.kind === 'rect') {
    t.ok(inside(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, box), label + ' rect')
  } else if (shape.kind === 'circle') {
    t.ok(shape.r > 0 && inside(shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r, box), label + ' circle')
  } else if (shape.kind === 'ellipse') {
    t.ok(shape.rx > 0 && shape.ry > 0 && inside(shape.cx - shape.rx, shape.cy - shape.ry, shape.cx + shape.rx, shape.cy + shape.ry, box), label + ' ellipse')
  } else if (shape.kind === 'path') {
    const pts = pathPoints(shape.d)
    t.ok(pts && pts.every(([x, y]) => x >= 0 && y >= 0 && x <= box.w && y <= box.h), label + ' path')
  } else {
    t.fail(label + ' kind')
  }
}

function call (fn) {
  try {
    return { err: null, value: fn() }
  } catch (err) {
    return { err, value: null }
  }
}

test('gardenDecor: keys match the rules and every shape sits in its box', async (t) => {
  const m = await load()
  const ids = [...rpc.garden.GARDEN_DECOR_IDS]
  t.alike(Object.keys(m.DECOR_DRAWINGS).sort(), ids.slice().sort())
  t.is(Object.keys(m.DECOR_DRAWINGS).length, ids.length)
  t.ok(Object.isFrozen(m.DECOR_DRAWINGS))
  const lightKeys = Object.keys(m.DECOR_LIGHT)
  const darkKeys = Object.keys(m.DECOR_DARK)
  const seen = new Set()
  for (const id of ids) {
    const drawing = m.DECOR_DRAWINGS[id]
    const box = BOX[id]
    t.ok(drawing && box, id)
    if (!drawing || !box) continue
    t.is(drawing.w, box.w, id + ' w')
    t.is(drawing.h, box.h, id + ' h')
    t.ok(Array.isArray(drawing.shapes) && drawing.shapes.length > 0, id + ' draws')
    t.ok(Object.isFrozen(drawing) && Object.isFrozen(drawing.shapes), id + ' frozen')
    t.is(m.decorDrawing(id), drawing, id + ' lookup')
    if (!Array.isArray(drawing.shapes)) continue
    const sig = JSON.stringify(drawing.shapes)
    t.ok(!seen.has(sig), id + ' is its own drawing')
    seen.add(sig)
    for (const shape of drawing.shapes) assertShape(t, shape, id, lightKeys, darkKeys, drawing)
  }
  const rede = m.DECOR_DRAWINGS.rede && m.DECOR_DRAWINGS.rede.shapes
  const varal = m.DECOR_DRAWINGS.varal && m.DECOR_DRAWINGS.varal.shapes
  const gato = m.DECOR_DRAWINGS.gato && m.DECOR_DRAWINGS.gato.shapes
  const pisca = m.DECOR_DRAWINGS.pisca && m.DECOR_DRAWINGS.pisca.shapes
  t.ok(rede && varal && gato && pisca, 'four drawings')
  if (!rede || !varal || !gato || !pisca) return
  t.ok(rede.some((shape) => shape.fill === 'rope'), 'hammock rope')
  t.ok(rede.some((shape) => shape.fill === 'cloth' || shape.fill === 'clothAlt'), 'hammock cloth')
  const cloths = varal.filter((shape) => shape.fill === 'cloth' || shape.fill === 'clothAlt')
  t.is(cloths.length, 3, 'three cloths')
  t.ok(varal.some((shape) => shape.fill === 'rope'), 'clothesline')
  t.ok(gato.some((shape) => shape.fill === 'fur') && gato.some((shape) => shape.fill === 'furDark'), 'sitting cat')
  t.ok(gato.some((shape) => shape.kind === 'circle' || shape.kind === 'ellipse'), 'cat has a round body')
  const lamps = pisca.filter((shape) => shape.kind === 'circle' && shape.fill === 'lamp')
  t.ok(lamps.length >= 5, 'string of lamps')
  t.ok(pisca.some((shape) => shape.fill === 'rope'), 'lamp string')
})

test('gardenDecor: palettes share keys and hex colours', async (t) => {
  const m = await load()
  t.is(m.decorPalette('dark'), m.DECOR_DARK)
  t.is(m.decorPalette('light'), m.DECOR_LIGHT)
  t.is(m.decorPalette(undefined), m.DECOR_LIGHT)
  t.is(m.decorPalette(null), m.DECOR_LIGHT)
  t.ok(Object.isFrozen(m.DECOR_LIGHT) && Object.isFrozen(m.DECOR_DARK))
  const lightKeys = Object.keys(m.DECOR_LIGHT).sort()
  const darkKeys = Object.keys(m.DECOR_DARK).sort()
  t.alike(lightKeys, darkKeys)
  t.alike(lightKeys, PALETTE_KEYS)
  for (const key of lightKeys) {
    t.ok(HEX.test(m.DECOR_LIGHT[key]), 'light ' + key)
    t.ok(HEX.test(m.DECOR_DARK[key]), 'dark ' + key)
    t.not(m.DECOR_LIGHT[key], m.DECOR_DARK[key], key + ' changes with the scheme')
  }
  const hostile = new Proxy({}, {
    get () { throw new Error('get') }
  })
  const got = call(() => m.decorPalette(hostile))
  t.is(got.err, null, 'hostile scheme does not throw')
  t.is(got.value, m.DECOR_LIGHT)
})

test('gardenDecor: unknown, proxy and getter ids are the empty drawing', async (t) => {
  const m = await load()
  const empty = m.decorDrawing('nope')
  t.alike(empty, EMPTY)
  t.ok(Object.isFrozen(empty) && Object.isFrozen(empty.shapes), 'empty frozen')
  const plain = [undefined, null, '', 'rosa', 'Rede', 'gato ', 0, 1, true, false, [], {}, Symbol('rede'), '__proto__', 'constructor', 'toString']
  for (const id of plain) {
    const got = call(() => m.decorDrawing(id))
    t.is(got.err, null, 'plain does not throw')
    t.is(got.value, empty)
  }
  const getter = {}
  for (const key of ['toString', 'valueOf', 'id', 'then']) {
    Object.defineProperty(getter, key, {
      enumerable: true,
      get () { throw new Error(key) }
    })
  }
  const proxy = new Proxy({}, {
    get () { throw new Error('get') },
    getOwnPropertyDescriptor () { throw new Error('desc') },
    ownKeys () { throw new Error('keys') }
  })
  const held = Proxy.revocable({}, {
    get () { throw new Error('get') }
  })
  held.revoke()
  for (const [label, id] of [['getter', getter], ['proxy', proxy], ['revoked', held.proxy]]) {
    const got = call(() => m.decorDrawing(id))
    t.is(got.err, null, label + ' does not throw')
    t.alike(got.value, EMPTY)
    t.is(got.value, empty, label + ' is the empty drawing')
  }
})

test('gardenDecor: source has no em dash, random or require', (t) => {
  const src = fs.readFileSync(SRC, 'utf8')
  t.absent(src.includes('\u2014'), 'no em dash')
  t.absent(src.includes('\u2013'), 'no en dash')
  t.absent(src.includes('Math.random'), 'deterministic')
  t.absent(src.includes('require('), 'esm')
  t.absent(src.includes('react'), 'no react')
  t.absent(src.includes('react-native'), 'no platform')
  t.absent(src.includes('requestAnimationFrame'), 'no animation')
})
