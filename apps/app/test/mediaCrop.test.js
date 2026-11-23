'use strict'

// The avatar crop math (src/media/crop.js). It is an ES module bundled by
// Metro; import() loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('avatar movement uses two rows of accessible icon actions', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/AvatarEditor.js'), 'utf8')
  const start = src.indexOf('<View style={styles.moveControls}>')
  const controls = start < 0 ? '' : src.slice(start, src.indexOf('</View>', start))
  const rows = [...controls.matchAll(/<Row>([\s\S]*?)<\/Row>/g)]
  t.alike(rows.map((m) => (m[1].match(/<IconAction /g) || []).length), [2, 2], 'a two by two control')
  for (const [icon, label, direction] of [
    ['esquerda', 'mover para a esquerda', 'left'],
    ['direita', 'mover para a direita', 'right'],
    ['seta_cima', 'mover para cima', 'up'],
    ['baixo', 'mover para baixo', 'down']
  ]) {
    t.ok(controls.includes("<IconAction icon='" + icon + "' label='" + label + "' onPress={() => move('" + direction + "')} disabled={off || !limits." + direction + '} />'), direction + ' keeps the spoken label, movement and limit')
  }
  t.ok(/<Row>\s*<Pill label='Aproximar'[^\n]+\s*<Pill label='Afastar'[^\n]+\s*<Pill label='Centralizar'[^\n]+\s*<\/Row>/.test(src), 'zoom and centering stay together as text')
  t.ok(src.includes("<Pill label='Cancelar' onPress={onCancel} disabled={off} />") && src.includes("<Pill label='Usar foto' filled pending={off} onPress={() => onConfirm(cropRect(crop, source))} />"), 'cancel and confirm remain textual')
  t.ok(src.includes("{'Zoom de ' + percent + '%'}"), 'the zoom line starts with a capital')
})

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

test('Escape in the photo editor cancels only the crop', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'AvatarEditor.js'), 'utf8')
  t.ok(src.includes("useEscapeLayer(true, () => { if (!off && onCancel) onCancel() }, 'editor')"), 'the editor is the top Escape layer over its sheet')
})

test('the photo editor panel is not a focus stop of its own', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'AvatarEditor.js'), 'utf8')
  t.ok(src.includes('const webPanel = WEB ? { onKeyDown, onKeyUp } : null'), 'Shift+Tab reaches Cancelar and Usar foto')
})

test('clampCrop uses the visible width and height of a rectangular frame', async (t) => {
  const m = await load()
  const src = SOURCES.square
  const crop = { zoom: 1, cx: 0, cy: 0 }
  t.alike(m.clampCrop(crop, src, 4 / 5), { zoom: 1, cx: 0.4, cy: 0.5 })
  t.alike(m.clampCrop(crop, src, 16 / 9), { zoom: 1, cx: 0.5, cy: 0.28125 })
})

test('omitted, square and invalid ratios preserve the square crop', async (t) => {
  const m = await load()
  const operations = [
    [m.clampCrop, (crop, src) => [crop, src]],
    [m.displayRect, (crop, src) => [crop, src, VIEW]],
    [m.panBy, (crop, src) => [crop, 20, -40, src, VIEW]],
    [m.zoomBy, (crop, src) => [crop, m.ZOOM_STEP, src]],
    [m.nudge, (crop, src) => [crop, 'down', src]],
    [m.limitsOf, (crop, src) => [crop, src]],
    [m.cropRect, (crop, src) => [crop, src]]
  ]
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const crop of [m.initialCrop(), { zoom: 1.5, cx: 0.6, cy: 0.2 }, { zoom: 4, cx: 0, cy: 1 }]) {
      const { sx, sy, size } = m.cropRect(crop, src)
      const square = { sx, sy, sw: size, sh: size }
      t.alike(m.frameRect(crop, src), square, name + ' implicit frame')
      for (const ratio of [1, null, 0, -2, NaN, Infinity, '1.5', {}, Symbol('ratio')]) {
        t.alike(m.frameRect(crop, src, ratio), square, name + ' explicit frame')
        for (const [operation, argsFor] of operations) {
          const args = argsFor(crop, src)
          t.alike(operation(...args, ratio), operation(...args), name + ' ' + operation.name)
        }
      }
    }
  }
})

const FRAME_SOURCES = { ...SOURCES, pixel: { width: 1, height: 1 }, small: { width: 3, height: 2 } }
const RATIOS = [4 / 5, 1, 16 / 9]

test('frames use the rounded pixel rectangle for preview and the visible window for gestures', async (t) => {
  const m = await load()
  for (const [name, src] of Object.entries(FRAME_SOURCES)) {
    for (const ratio of RATIOS) {
      for (const zoom of [1, 1.5, 2, 3, 4]) {
        const label = `${name}, ratio ${ratio}, zoom ${zoom}`
        const crop = { zoom, cx: 0.5, cy: 0.5 }
        const vw = Math.min(src.width, src.height * ratio) / zoom
        const vh = vw / ratio
        const { sx, sy, sw, sh } = m.frameRect(crop, src, ratio)
        t.ok([sx, sy, sw, sh].every(Number.isInteger) && sx >= 0 && sy >= 0 && sw >= 1 && sh >= 1 && sx + sw <= src.width && sy + sh <= src.height, label + ' bounds')
        t.is(sw, Math.min(src.width, Math.max(1, Math.round(vw))), label + ' width')
        t.is(sh, Math.min(src.height, Math.max(1, Math.round(sw / ratio))), label + ' height')
        if (src.width >= 1000) t.ok(Math.abs(sw / sh - ratio) < 0.01, label + ' aspect ratio')
        const scale = VIEW / sw
        t.alike(m.displayRect(crop, src, VIEW, ratio), {
          left: -sx * scale,
          top: -sy * scale,
          width: src.width * scale,
          height: src.height * scale
        }, label + ' preview')

        const k = vw / VIEW
        t.alike(m.panBy(crop, 21, -14, src, VIEW, ratio), m.clampCrop({
          zoom,
          cx: 0.5 - (21 * k) / src.width,
          cy: 0.5 + (14 * k) / src.height
        }, src, ratio), label + ' drag')
        const down = m.nudge(crop, 'down', src, ratio)
        const expectedDown = m.clampCrop({ zoom, cx: 0.5, cy: 0.5 - m.MOVE_STEP * vh / src.height }, src, ratio)
        t.ok(Math.abs(down.cy - expectedDown.cy) < 1e-12 && down.cx === 0.5, label + ' vertical step')
        const left = m.nudge(crop, 'left', src, ratio)
        const expectedLeft = m.clampCrop({ zoom, cx: 0.5 + m.MOVE_STEP * vw / src.width, cy: 0.5 }, src, ratio)
        t.alike(left, expectedLeft, label + ' horizontal step')
        t.alike(m.zoomBy(left, 0.5, src, ratio), m.clampCrop({ ...left, zoom: zoom / 2 }, src, ratio), label + ' zoom')

        for (const oldRatio of RATIOS) {
          const previous = m.clampCrop({ zoom, cx: 0, cy: 1 }, src, oldRatio)
          const framed = m.clampCrop(previous, src, ratio)
          const hx = vw / (2 * src.width)
          const hy = vh / (2 * src.height)
          t.ok(framed.cx >= hx - 1e-12 && framed.cx <= 1 - hx + 1e-12 && framed.cy >= hy - 1e-12 && framed.cy <= 1 - hy + 1e-12, label + ' after changing ratio from ' + oldRatio)
        }
      }
    }
  }
})

test('frame movement flags agree with nudging to each pixel edge', async (t) => {
  const m = await load()
  const atEdge = {
    left: (r, src) => r.sx + r.sw === src.width,
    right: (r) => r.sx === 0,
    up: (r, src) => r.sy + r.sh === src.height,
    down: (r) => r.sy === 0
  }
  for (const [name, src] of Object.entries(FRAME_SOURCES)) {
    for (const ratio of [...RATIOS, 2 / 5]) {
      for (const zoom of [1, 2, 3, 4, 400 / 200.49]) {
        for (const [dir, touches] of Object.entries(atEdge)) {
          const label = `${name}, ratio ${ratio}, zoom ${zoom}, ${dir}`
          let crop = { zoom, cx: 0.5, cy: 0.5 }
          const start = m.frameRect(crop, src, ratio)
          for (let i = 0; i < 200 && m.limitsOf(crop, src, ratio)[dir]; i++) crop = m.nudge(crop, dir, src, ratio)
          const end = m.frameRect(crop, src, ratio)
          t.is(m.limitsOf({ zoom, cx: 0.5, cy: 0.5 }, src, ratio)[dir], end.sx !== start.sx || end.sy !== start.sy, label + ' can start moving')
          t.ok(touches(end, src), label + ' reaches the edge')
          t.absent(m.limitsOf(crop, src, ratio)[dir], label + ' cannot continue')
          t.alike(m.frameRect(m.nudge(crop, dir, src, ratio), src, ratio), end, label + ' stays at the edge')
        }
      }
    }
  }

  const crop = m.initialCrop()
  const src = { width: 10, height: 33 }
  t.absent(m.limitsOf(crop, src, 0.1).up)
  t.absent(m.limitsOf(crop, src, 0.1).down)
})

test('sameCrop compares numeric fields and isWholeRect checks the complete image', async (t) => {
  const m = await load()
  const crop = m.initialCrop()
  t.ok(m.sameCrop(crop, { ...crop }))
  t.absent(m.sameCrop(crop, { ...crop, cx: 0 }))
  t.absent(m.sameCrop(crop, { ...crop, cy: 0 }))
  t.absent(m.sameCrop(crop, { ...crop, zoom: 2 }))
  t.absent(m.sameCrop({ zoom: '1', cx: 0.5, cy: 0.5 }, { zoom: '1', cx: 0.5, cy: 0.5 }))
  t.absent(m.sameCrop({}, {}))
  t.ok(m.isWholeRect(m.frameRect(crop, SOURCES.square, 1), SOURCES.square))
  t.absent(m.isWholeRect(m.frameRect(crop, SOURCES.square, 4 / 5), SOURCES.square))
  t.absent(m.isWholeRect({ sx: 1, sy: 0, sw: 1000, sh: 1000 }, SOURCES.square))
})

test('invalid frame inputs are safe', async (t) => {
  const m = await load()
  const fallback = { sx: 0, sy: 0, sw: 1, sh: 1 }
  t.alike(m.frameRect(null, SOURCES.square, 4 / 5), fallback)
  t.absent(m.sameCrop(null, undefined))
  t.absent(m.isWholeRect(null, SOURCES.square))
  for (const src of [null, {}, { width: Symbol('width'), height: 50 }, { width: 80, height: 0 }]) {
    t.alike(m.frameRect({}, src, 4 / 5), fallback)
    t.absent(m.isWholeRect(fallback, src))
    t.alike(m.displayRect({}, src, VIEW, 4 / 5), { left: 0, top: 0, width: 0, height: 0 })
    t.alike(m.panBy({}, 1n, Symbol('dy'), src, VIEW, 4 / 5), m.initialCrop())
    t.alike(m.zoomBy({}, Symbol('factor'), src, 4 / 5), m.initialCrop())
  }
  const src = SOURCES.square
  t.alike(m.nudge(null, Object.create(null), src, 4 / 5), m.initialCrop())
  for (const ratio of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    const rect = m.frameRect(m.initialCrop(), src, ratio)
    t.ok(rect.sw >= 1 && rect.sw <= src.width && rect.sh >= 1 && rect.sh <= src.height)
  }
})
