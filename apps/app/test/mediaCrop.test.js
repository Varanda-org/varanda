'use strict'

// The avatar crop math (src/media/crop.js). It is an ES module bundled by
// Metro; import() loads it here through Node's module syntax detection.
const test = require('brittle')

const load = () => import('../src/media/crop.js')

const SOURCES = {
  portrait: { width: 1536, height: 2048 },
  landscape: { width: 2048, height: 1365 },
  square: { width: 1000, height: 1000 },
  tiny: { width: 3, height: 7 }
}
const VIEW = 280

function inBounds (t, rect, src, label) {
  const ok = Number.isInteger(rect.sx) && Number.isInteger(rect.sy) && Number.isInteger(rect.size) &&
    rect.size >= 1 && rect.sx >= 0 && rect.sy >= 0 &&
    rect.sx + rect.size <= src.width && rect.sy + rect.size <= src.height
  if (!ok) t.fail(label + ': ' + JSON.stringify(rect))
  return ok
}

function agrees (t, crop, src, view, m, label) {
  const rect = m.cropRect(crop, src)
  const d = m.displayRect(crop, src, view)
  const scale = view / rect.size
  const close = (a, b) => Math.abs(a - b) < 1e-6
  const ok = close(d.left, -rect.sx * scale) && close(d.top, -rect.sy * scale) &&
    close(d.width, src.width * scale) && close(d.height, src.height * scale) &&
    close(d.width / src.width, d.height / src.height)
  if (!ok) t.fail(label + ': display ' + JSON.stringify(d) + ' crop ' + JSON.stringify(rect))
  return ok
}

test('initialCrop and constants', async (t) => {
  const m = await load()
  t.alike(m.initialCrop(), { zoom: 1, cx: 0.5, cy: 0.5 })
  t.is(m.MIN_ZOOM, 1)
  t.is(m.MAX_ZOOM, 4)
  t.is(m.ZOOM_STEP, 1.25)
  t.is(m.MOVE_STEP, 0.1)
})

test('cropRect is the largest centered square at zoom 1 and a quarter side at zoom 4', async (t) => {
  const m = await load()
  t.alike(m.cropRect(m.initialCrop(), SOURCES.portrait), { sx: 0, sy: 256, size: 1536 })
  t.alike(m.cropRect(m.initialCrop(), SOURCES.landscape), { sx: 342, sy: 0, size: 1365 })
  t.alike(m.cropRect(m.initialCrop(), SOURCES.square), { sx: 0, sy: 0, size: 1000 })
  t.alike(m.cropRect({ zoom: 4, cx: 0.5, cy: 0.5 }, SOURCES.square), { sx: 375, sy: 375, size: 250 })
})

test('every pan, nudge and zoom keeps the crop square, in bounds and matching the display', async (t) => {
  const m = await load()
  const moves = [
    (c, src) => m.panBy(c, 40, 0, src, VIEW),
    (c, src) => m.panBy(c, -1000, 0, src, VIEW),
    (c, src) => m.panBy(c, 0, 1000, src, VIEW),
    (c, src) => m.panBy(c, 5000, -5000, src, VIEW),
    (c, src) => m.nudge(c, 'left', src),
    (c, src) => m.nudge(c, 'right', src),
    (c, src) => m.nudge(c, 'up', src),
    (c, src) => m.nudge(c, 'down', src),
    (c, src) => m.zoomBy(c, m.ZOOM_STEP, src),
    (c, src) => m.zoomBy(c, 1 / m.ZOOM_STEP, src)
  ]
  let checks = 0
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const zoom of [1, 4]) {
      let crop = m.clampCrop({ zoom, cx: 0.5, cy: 0.5 }, src)
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < moves.length; i++) {
          crop = moves[i](crop, src)
          const label = name + ' zoom ' + zoom + ' move ' + i
          if (!inBounds(t, m.cropRect(crop, src), src, label)) return
          if (!agrees(t, crop, src, VIEW, m, label)) return
          if (crop.zoom < m.MIN_ZOOM || crop.zoom > m.MAX_ZOOM) return t.fail(label + ': zoom ' + crop.zoom)
          checks++
        }
      }
    }
  }
  t.is(checks, Object.keys(SOURCES).length * 2 * 3 * 10)
})

test('dragging right shows more of the left', async (t) => {
  const m = await load()
  const src = SOURCES.square
  const zoomed = { zoom: 2, cx: 0.5, cy: 0.5 }
  const before = m.cropRect(zoomed, src)
  const after = m.cropRect(m.panBy(zoomed, 28, 0, src, VIEW), src)
  t.ok(after.sx < before.sx)
  t.is(after.sy, before.sy)
  const down = m.cropRect(m.panBy(zoomed, 0, 28, src, VIEW), src)
  t.ok(down.sy < before.sy)
  t.ok(m.cropRect(m.nudge(zoomed, 'left', src), src).sx > before.sx)
  t.ok(m.cropRect(m.nudge(zoomed, 'down', src), src).sy < before.sy)
})

test('dragging and nudging move the photo the same way', async (t) => {
  const m = await load()
  const src = SOURCES.square
  const zoomed = { zoom: 2, cx: 0.5, cy: 0.5 }
  const sign = (n) => Math.sign(n)
  const pan = (dx, dy) => m.panBy(zoomed, dx, dy, src, VIEW)
  const go = (dir) => m.nudge(zoomed, dir, src)
  t.is(sign(pan(28, 0).cx - zoomed.cx), sign(go('right').cx - zoomed.cx), 'right')
  t.is(sign(pan(-28, 0).cx - zoomed.cx), sign(go('left').cx - zoomed.cx), 'left')
  t.is(sign(pan(0, 28).cy - zoomed.cy), sign(go('down').cy - zoomed.cy), 'down')
  t.is(sign(pan(0, -28).cy - zoomed.cy), sign(go('up').cy - zoomed.cy), 'up')
  t.ok(go('right').cx < zoomed.cx)
  t.ok(go('down').cy < zoomed.cy)
  t.is(go('right').cy, zoomed.cy)
  t.is(go('down').cx, zoomed.cx)
  // A drag right then ArrowLeft goes back toward where it started.
  const back = m.nudge(pan(28, 0), 'left', src)
  t.ok(Math.abs(back.cx - zoomed.cx) < Math.abs(pan(28, 0).cx - zoomed.cx))
})

test('limitsOf flags agree with whether nudge moves the crop', async (t) => {
  const m = await load()
  let checks = 0
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const zoom of [1, 1.5, 2, 4]) {
      for (const cx of [0, 0.3, 0.5, 0.7, 1]) {
        for (const cy of [0, 0.3, 0.5, 0.7, 1]) {
          const crop = m.clampCrop({ zoom, cx, cy }, src)
          const before = m.cropRect(crop, src)
          const limits = m.limitsOf(crop, src)
          for (const dir of ['left', 'right', 'up', 'down']) {
            // On the tiny image one step can be under a pixel, so allow many.
            let next = crop
            let moved = false
            for (let i = 0; i < 200 && !moved; i++) {
              next = m.nudge(next, dir, src)
              const after = m.cropRect(next, src)
              moved = after.sx !== before.sx || after.sy !== before.sy
            }
            if (moved !== limits[dir]) return t.fail(name + ' ' + JSON.stringify(crop) + ' ' + dir)
            checks++
          }
        }
      }
    }
  }
  t.is(checks, Object.keys(SOURCES).length * 4 * 5 * 5 * 4)
})

test('zoomBy clamps between 1 and 4 and zoomPercent reports it', async (t) => {
  const m = await load()
  const src = SOURCES.landscape
  let crop = m.initialCrop()
  for (let i = 0; i < 20; i++) crop = m.zoomBy(crop, m.ZOOM_STEP, src)
  t.is(crop.zoom, 4)
  t.is(m.zoomPercent(crop), 400)
  for (let i = 0; i < 20; i++) crop = m.zoomBy(crop, 1 / m.ZOOM_STEP, src)
  t.is(crop.zoom, 1)
  t.is(m.zoomPercent(crop), 100)
  t.is(m.zoomPercent(m.zoomBy(m.initialCrop(), m.ZOOM_STEP, src)), 125)
  t.is(m.zoomPercent({ zoom: 9 }), 400)
  t.is(m.zoomPercent({ zoom: 0.1 }), 100)
})

test('limitsOf flags each edge', async (t) => {
  const m = await load()
  const step = (crop, dir, src) => {
    for (let i = 0; i < 200 && m.limitsOf(crop, src)[dir]; i++) crop = m.nudge(crop, dir, src)
    return crop
  }
  for (const [name, src] of Object.entries(SOURCES)) {
    const start = m.clampCrop({ zoom: 2, cx: 0.5, cy: 0.5 }, src)
    const opposite = { left: 'right', right: 'left', up: 'down', down: 'up' }
    for (const dir of ['left', 'right', 'up', 'down']) {
      const end = step(start, dir, src)
      const limits = m.limitsOf(end, src)
      t.is(limits[dir], false, name + ' ' + dir + ' reaches the edge')
      t.is(limits[opposite[dir]], true, name + ' ' + dir + ' can come back')
      const rect = m.cropRect(end, src)
      if (dir === 'left') t.is(rect.sx + rect.size, src.width)
      if (dir === 'right') t.is(rect.sx, 0)
      if (dir === 'up') t.is(rect.sy + rect.size, src.height)
      if (dir === 'down') t.is(rect.sy, 0)
    }
  }
  const square = m.limitsOf(m.initialCrop(), SOURCES.square)
  t.alike(square, { zoomIn: true, zoomOut: false, left: false, right: false, up: false, down: false })
  const portrait = m.limitsOf(m.initialCrop(), SOURCES.portrait)
  t.is(portrait.left || portrait.right, false)
  t.is(portrait.up && portrait.down, true)
  const landscape = m.limitsOf(m.initialCrop(), SOURCES.landscape)
  t.is(landscape.left && landscape.right, true)
  t.is(landscape.up || landscape.down, false)
  t.is(m.limitsOf({ zoom: 4, cx: 0.5, cy: 0.5 }, SOURCES.square).zoomIn, false)
})

test('invalid input never throws', async (t) => {
  const m = await load()
  const bad = [undefined, null, 0, 'x', {}, [], { zoom: NaN, cx: Infinity, cy: -Infinity }, { zoom: -3, cx: 'a', cy: null }]
  const srcs = [undefined, null, {}, { width: 0, height: 10 }, { width: NaN, height: 5 }, { width: -1, height: -1 }, { width: '10', height: 10 }, SOURCES.square]
  const views = [undefined, 0, -10, NaN, 'x', VIEW]
  for (const crop of bad) {
    for (const src of srcs) {
      for (const view of views) {
        try {
          const c = m.clampCrop(crop, src)
          if (![c.zoom, c.cx, c.cy].every(Number.isFinite)) return t.fail('clampCrop not finite')
          const rect = m.cropRect(crop, src)
          if (![rect.sx, rect.sy, rect.size].every(Number.isInteger) || rect.size < 1) return t.fail('cropRect')
          const d = m.displayRect(crop, src, view)
          if (![d.left, d.top, d.width, d.height].every(Number.isFinite)) return t.fail('displayRect')
          m.panBy(crop, NaN, 'x', src, view)
          m.zoomBy(crop, -1, src)
          m.zoomBy(crop, NaN, src)
          m.nudge(crop, 'sideways', src)
          m.nudge(crop, '__proto__', src)
          const p = m.zoomPercent(crop)
          if (!Number.isInteger(p) || p < 100 || p > 400) return t.fail('zoomPercent')
          m.limitsOf(crop, src)
        } catch (err) {
          return t.fail('threw: ' + err.message)
        }
      }
    }
  }
  t.alike(m.clampCrop(null, SOURCES.square), m.initialCrop())
  t.alike(m.clampCrop({ zoom: 2 }, null), m.initialCrop())
  t.alike(m.clampCrop({ zoom: 9, cx: 2, cy: -1 }, SOURCES.square), { zoom: 4, cx: 0.875, cy: 0.125 })
  t.alike(m.displayRect(m.initialCrop(), SOURCES.square, 0), { left: 0, top: 0, width: 0, height: 0 })
})
