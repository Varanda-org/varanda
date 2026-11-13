'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { DESIGNS } = require('@varanda/rpc')

const load = () => import('../src/inviteWelcomeStage.js')
const loadArt = () => import('../src/inviteCardArt.js')
const COUNTS = {
  marajoara: [4],
  aguas: [3],
  vitoria: [4],
  cordel: [2],
  bandeirinhas: [1, 1, 1, 1, 1],
  chita: [6],
  ipe: [4],
  pantanal: [2],
  azulejo: [8],
  copacabana: [6],
  minas: [3],
  araucaria: [8],
  chimarrao: [5]
}
const near = (a, b) => Math.abs(a - b) < 0.01

function deeplyFrozen (value) {
  return value === null || typeof value !== 'object' ||
    (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen))
}

test('inviteWelcomeStage: frozen motifs cut every window in art order', async (t) => {
  const { MOTIF_WINDOWS, motifsFor } = await load()
  const { artFor, shapeBounds } = await loadArt()
  t.alike(Object.keys(MOTIF_WINDOWS).sort(), [...DESIGNS].sort())
  t.ok(deeplyFrozen(MOTIF_WINDOWS), 'windows are deeply frozen')
  for (const id of DESIGNS) {
    const motifs = motifsFor(id)
    t.is(motifsFor(id), motifs, id + ': cached array')
    t.ok(deeplyFrozen(motifs), id + ': motifs are deeply frozen')
    t.alike(motifs.map((m) => m.shapes.length), COUNTS[id], id + ': pinned shape counts')
    t.is(motifs.length, MOTIF_WINDOWS[id].length)
    for (const [variant, motif] of motifs.entries()) {
      const [x, y, w, h] = MOTIF_WINDOWS[id][variant]
      const originals = artFor(id).shapes.filter((s) => {
        if (s.kind === 'stripes') return false
        const b = shapeBounds(s)
        return b.x >= x && b.y >= y && b.x + b.w <= x + w && b.y + b.h <= y + h
      })
      const boxes = originals.map(shapeBounds)
      const x0 = Math.min(...boxes.map((b) => b.x))
      const y0 = Math.min(...boxes.map((b) => b.y))
      t.ok(motif.w > 0 && motif.h > 0, id + ': positive extent')
      t.ok(near(motif.w, Math.max(...boxes.map((b) => b.x + b.w)) - x0))
      t.ok(near(motif.h, Math.max(...boxes.map((b) => b.y + b.h)) - y0))
      for (const [i, shape] of motif.shapes.entries()) {
        const b = shapeBounds(shape)
        t.not(shape.kind, 'stripes')
        t.ok(b.x >= -0.01 && b.y >= -0.01 && b.x + b.w <= motif.w + 0.01 && b.y + b.h <= motif.h + 0.01, id + ': shape inside motif')
        t.not(shape, originals[i], 'shape is a copy')
        t.is(shape.fill, originals[i].fill, 'fill is preserved')
        let restored
        if (shape.kind === 'rect') restored = { ...shape, x: originals[i].x, y: originals[i].y }
        else if (shape.kind === 'tri') restored = { ...shape, points: shape.points.map(([px, py]) => [px + x0, py + y0]) }
        else restored = { ...shape, cx: originals[i].cx, cy: originals[i].cy }
        t.alike(restored, originals[i], 'shape dimensions and art order are preserved')
        t.ok(near(b.x, boxes[i].x - x0) && near(b.y, boxes[i].y - y0), 'translated to union origin')
      }
    }
  }
})

test('inviteWelcomeStage: unknown and non-string designs have no motifs', async (t) => {
  const { motifsFor } = await load()
  for (const id of ['nao-existe', null, undefined, 3, {}, ['chita'], '__proto__', 'toString', 'hasOwnProperty']) {
    t.alike(motifsFor(id), [])
    t.ok(Object.isFrozen(motifsFor(id)))
  }
})

test('inviteWelcomeStage: every motif lays out in both schemes', async (t) => {
  const { motifsFor, layoutMotif } = await load()
  for (const id of DESIGNS) {
    for (const motif of motifsFor(id)) {
      for (const scheme of ['light', 'dark']) {
        const { width, height, items } = layoutMotif(motif, 52, scheme)
        t.ok(near(Math.max(width, height), 52), id + ': long side is 52')
        t.is(items.length, motif.shapes.length)
        t.ok(items.every((item) => ['box', 'tri', 'diamond'].includes(item.kind)), id + ': drawable kinds')
        t.ok(items.every((item) => /^#[0-9a-f]{6}$/.test(item.color)), id + ': resolved colors')
      }
      t.alike(layoutMotif(motif, 0, 'light'), { width: 0, height: 0, items: [] })
    }
  }
  for (const size of [-1, NaN, undefined]) {
    t.alike(layoutMotif(motifsFor('chita')[0], size, 'light'), { width: 0, height: 0, items: [] })
  }
  t.alike(layoutMotif(null, 52, 'dark'), { width: 0, height: 0, items: [] })
})

test('inviteWelcomeStage: layout preserves primitive geometry and skips null colors', async (t) => {
  const { layoutMotif } = await load()
  const fill = { light: '#123456', dark: '#abcdef' }
  const motif = {
    w: 100,
    h: 80,
    shapes: [
      { kind: 'rect', x: 10, y: 20, w: 30, h: 40, r: 6, fill },
      { kind: 'rect', x: 0, y: 0, w: 10, h: 10, fill },
      { kind: 'circle', cx: 40, cy: 30, r: 10, fill },
      { kind: 'diamond', cx: 50, cy: 40, w: 40, h: 20, fill },
      { kind: 'tri', points: [[80, 20], [10, 20], [30, 60]], fill },
      { kind: 'tri', points: [[10, 60], [80, 60], [30, 20]], fill },
      { kind: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'nao-existe' }
    ]
  }
  for (const scheme of ['light', 'dark']) {
    const color = fill[scheme]
    const side = 10 / Math.SQRT2
    t.alike(layoutMotif(motif, 50, scheme), {
      width: 50,
      height: 40,
      items: [
        { kind: 'box', left: 5, top: 10, width: 15, height: 20, radius: 3, color },
        { kind: 'box', left: 0, top: 0, width: 5, height: 5, radius: 0, color },
        { kind: 'box', left: 15, top: 10, width: 10, height: 10, radius: 5, color },
        { kind: 'diamond', left: 25 - side / 2, top: 20 - side / 2, side, scaleX: 2, color },
        { kind: 'tri', left: 5, top: 10, leftWidth: 10, rightWidth: 25, height: 20, up: false, color },
        { kind: 'tri', left: 5, top: 10, leftWidth: 10, rightWidth: 25, height: 20, up: true, color }
      ]
    })
  }
})

test('inviteWelcomeStage: classes and reserved bands follow viewport bounds', async (t) => {
  const { STAGE, stageClass, welcomeBands } = await load()
  t.ok(deeplyFrozen(STAGE))
  t.alike(STAGE, { SIZE: { compact: 40, phone: 52, wide: 72 }, LEAD: 1.25, FOOT: 0.8, GAP: 14, FOOT_GAP: 12, MARGIN: 8, COLUMN: 420 })
  for (const [w, h, cls, top, bottom] of [
    [320, 568, 'compact', 78, 16],
    [844, 390, 'compact', 78, 16],
    [390, 844, 'phone', 93, 66],
    [360, 600, 'phone', 93, 66],
    [767, 700, 'phone', 93, 66],
    [768, 700, 'wide', 118, 82],
    [1280, 800, 'wide', 118, 82],
    [0, 800, 'none', 16, 16],
    [NaN, 1, 'none', 16, 16],
    [390, Infinity, 'none', 16, 16],
    [Infinity, 800, 'none', 16, 16],
    [390, 0, 'none', 16, 16],
    [-1, 800, 'none', 16, 16],
    [390, NaN, 'none', 16, 16],
    ['390', 844, 'none', 16, 16]
  ]) {
    t.is(stageClass(w, h), cls)
    t.alike(welcomeBands(w, h), { top, bottom })
  }
})

test('inviteWelcomeStage: slots fit the inset, bands and sides of the content column', async (t) => {
  const { motifsFor, welcomeStage, welcomeBands } = await load()
  for (const design of DESIGNS) {
    for (const [width, height, cls, size, count, topCount, centres] of [
      [320, 568, 'compact', 40, 3, 3, [160, 51.2, 268.8]],
      [390, 844, 'phone', 52, 5, 3, [195, 62.4, 327.6, 46.8, 343.2]],
      [1280, 800, 'wide', 72, 9, 5, [640, 384, 896, 128, 1152, 215, 1065, 153.6, 1126.4]],
      [768, 700, 'wide', 72, 9, 5, [384, 230.4, 537.6, 76.8, 691.2, 87, 681, 92.16, 675.84]]
    ]) {
      const stage = welcomeStage({ design, width, height })
      const bands = welcomeBands(width, height)
      t.is(stage.cls, cls)
      t.is(stage.slots.length, count)
      t.alike(stage.slots.map((s) => s.order), Array.from({ length: count }, (_, i) => i))
      for (const [i, slot] of stage.slots.entries()) {
        const foot = cls !== 'compact' && i >= count - 2
        t.is(slot.key, 's' + i)
        t.is(slot.variant, i % motifsFor(design).length)
        t.is(slot.size, i === 0 ? size * 1.25 : foot ? size * 0.8 : size)
        t.is(slot.side, i === 0 ? 0 : centres[i] < width / 2 ? -1 : 1)
        t.ok(near(Math.max(slot.width, slot.height), slot.size))
        t.ok(near(slot.width / slot.height, motifsFor(design)[slot.variant].w / motifsFor(design)[slot.variant].h))
        t.ok(near(slot.left + slot.width / 2, centres[i]), design + ': horizontal centre')
        const cy = i < topCount ? 14 + size * 1.25 / 2 : foot ? height - 12 - size * 0.8 / 2 : height / 2
        t.ok(near(slot.top + slot.height / 2, cy), design + ': vertical centre')
        t.ok(slot.left >= 8 - 0.01 && slot.top >= 8 - 0.01 && slot.left + slot.width <= width - 8 + 0.01 && slot.top + slot.height <= height - 8 + 0.01, design + ': inside inset')
        if (i < topCount) t.ok(slot.top + slot.height <= bands.top, design + ': above content')
        if (foot) t.ok(slot.top >= height - bands.bottom, design + ': below content')
      }
      if (cls === 'wide') {
        t.ok(stage.slots[5].left + stage.slots[5].width <= (width - 420) / 2, design + ': left of column')
        t.ok(stage.slots[6].left >= (width + 420) / 2, design + ': right of column')
      }
    }
  }
  t.alike(welcomeStage({ design: 'bandeirinhas', width: 390, height: 844 }).slots.map((s) => s.variant), [0, 1, 2, 3, 4])
})

test('inviteWelcomeStage: clamps small viewports and returns fresh deterministic slots', async (t) => {
  const { welcomeStage } = await load()
  const small = welcomeStage({ design: 'marajoara', width: 100, height: 70 })
  t.is(small.slots[0].top, 70 - 8 - 50, 'clamped at bottom')
  t.is(small.slots[1].left, 8, 'clamped at left')
  t.is(small.slots[2].left, 100 - 8 - 40, 'clamped at right')
  const args = { design: 'bandeirinhas', width: 390, height: 844 }
  const first = welcomeStage(args)
  const second = welcomeStage(args)
  t.alike(first, second)
  t.not(first, second)
  t.not(first.slots, second.slots)
  t.not(first.slots[0], second.slots[0])
  first.slots[0].left = -100
  first.slots.pop()
  t.alike(welcomeStage(args), second)
  t.alike(welcomeStage({ ...args, design: 'nao-existe' }), { cls: 'phone', slots: [] })
  t.alike(welcomeStage({ ...args, width: 0 }), { cls: 'none', slots: [] })
})

function luminance (hex) {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

test('inviteWelcomeStage: ink against ground meets WCAG contrast in both schemes', async (t) => {
  const { artFor } = await loadArt()
  for (const design of [...DESIGNS, 'nao-existe']) {
    const art = artFor(design)
    for (const scheme of ['light', 'dark']) {
      const ink = luminance(art.ink[scheme])
      const bg = luminance(art.bg[scheme])
      const contrast = (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05)
      t.ok(contrast >= 4.5, design + ': ' + scheme + ' contrast ' + contrast)
    }
  }
})

test('inviteWelcomeStage: pure module with only the art import', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/inviteWelcomeStage.js'), 'utf8')
  for (const forbidden of ['\u2014', "from 'react", 'react-native', 'Platform', 'Math.random', 'require(']) {
    t.absent(src.includes(forbidden))
  }
  t.absent(/\b(Date|window|document|navigator|globalThis|process)\b/.test(src))
  t.alike(src.match(/^import .*$/gm), ["import { artFor, resolveFill, shapeBounds } from './inviteCardArt.js'"])
})
