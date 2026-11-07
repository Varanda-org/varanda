'use strict'

// The invite card frames as data (src/inviteCardArt.js), a pure ES module;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { DESIGNS } = require('@varanda/rpc')

const load = () => import('../src/inviteCardArt.js')
const HEX = /^#[0-9a-f]{6}$/
const KINDS = ['rect', 'circle', 'tri', 'diamond', 'stripes']
const num = (n) => typeof n === 'number' && Number.isFinite(n)

function fillsOf (shape) {
  return shape.kind === 'stripes' ? shape.colors : [shape.fill]
}

function overlaps (a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

test('inviteCardArt: every design has its own frozen art', async (t) => {
  const { ART, artFor } = await load()
  t.is(DESIGNS.length, 13)
  t.alike(Object.keys(ART).sort(), [...DESIGNS].sort(), 'one art per design id, nothing else')
  t.ok(Object.isFrozen(ART))
  for (const id of DESIGNS) {
    t.is(artFor(id), ART[id], id + ': artFor returns its art')
    t.ok(Object.isFrozen(ART[id].shapes), id + ': shapes frozen')
    t.ok(ART[id].shapes.length >= 4, id + ': has motifs')
  }
})

test('inviteCardArt: unknown ids get the neutral frame', async (t) => {
  const { ART, artFor } = await load()
  const neutral = artFor('nao-existe')
  t.ok(neutral && Array.isArray(neutral.shapes))
  t.ok(!Object.values(ART).includes(neutral))
  t.is(artFor(undefined), neutral)
  t.is(artFor(3), neutral)
  t.is(artFor('__proto__'), neutral)
  t.is(artFor('toString'), neutral)
})

test('inviteCardArt: shapes use the five primitives inside the canvas', async (t) => {
  const { ART, CANVAS, artFor, shapeBounds } = await load()
  t.alike({ ...CANVAS }, { w: 1000, h: 525 })
  for (const [id, art] of [...Object.entries(ART), ['neutral', artFor('')]]) {
    let bad = 0
    for (const s of art.shapes) {
      if (!KINDS.includes(s.kind)) { bad++; continue }
      const fields = {
        rect: ['x', 'y', 'w', 'h'],
        circle: ['cx', 'cy', 'r'],
        diamond: ['cx', 'cy', 'w', 'h'],
        stripes: ['y', 'h', 'count'],
        tri: []
      }[s.kind]
      if (!fields.every((f) => num(s[f]))) bad++
      if (s.kind === 'rect' && s.r !== undefined && !num(s.r)) bad++
      if (s.kind === 'stripes' && (!Number.isInteger(s.count) || s.count < 1 || !Array.isArray(s.colors) || s.colors.length < 1)) bad++
      if (s.kind === 'tri') {
        const p = s.points
        if (!Array.isArray(p) || p.length !== 3 || !p.every((q) => Array.isArray(q) && q.length === 2 && num(q[0]) && num(q[1]))) { bad++; continue }
        // A View border draws only a horizontal base with the apex above or below it.
        const [a, b, apex] = p
        const lo = Math.min(a[0], b[0])
        const hi = Math.max(a[0], b[0])
        if (a[1] !== b[1] || apex[1] === a[1] || apex[0] < lo || apex[0] > hi || lo === hi) bad++
      }
      const box = shapeBounds(s)
      if (!(box.w > 0 && box.h > 0)) bad++
      if (box.x < 0 || box.y < 0 || box.x + box.w > CANVAS.w || box.y + box.h > CANVAS.h) bad++
    }
    t.is(bad, 0, id + ': every shape valid and inside the canvas')
  }
})

test('inviteCardArt: light and dark colors are #rrggbb', async (t) => {
  const { ART, PALETTE, artFor, resolveFill } = await load()
  for (const [key, p] of Object.entries(PALETTE)) {
    t.ok(HEX.test(p.light) && HEX.test(p.dark), 'palette ' + key)
  }
  for (const [id, art] of [...Object.entries(ART), ['neutral', artFor('')]]) {
    t.ok(HEX.test(art.bg.light) && HEX.test(art.bg.dark), id + ': bg pair')
    t.ok(HEX.test(art.ink.light) && HEX.test(art.ink.dark), id + ': ink pair')
    let bad = 0
    for (const s of art.shapes) {
      for (const fill of fillsOf(s)) {
        if (typeof fill !== 'string' && !(fill && 'light' in fill && 'dark' in fill)) bad++
        if (!HEX.test(resolveFill(fill, 'light') || '')) bad++
        if (!HEX.test(resolveFill(fill, 'dark') || '')) bad++
      }
    }
    t.is(bad, 0, id + ': every fill resolves in light and dark')
  }
  t.is(resolveFill('nao-existe', 'light'), null)
})

test('inviteCardArt: no shape enters the text area', async (t) => {
  const { ART, SAFE_AREA, artFor, shapeBounds } = await load()
  t.ok(Object.isFrozen(SAFE_AREA))
  t.ok(SAFE_AREA.x > 0 && SAFE_AREA.y > 0 && SAFE_AREA.w >= 600 && SAFE_AREA.h >= 250, 'a roomy text area')
  for (const [id, art] of [...Object.entries(ART), ['neutral', artFor('')]]) {
    const intruders = art.shapes.filter((s) => overlaps(shapeBounds(s), SAFE_AREA))
    t.is(intruders.length, 0, id + ': border only')
  }
})

test('inviteCardArt: layout at the canvas aspect scales evenly', async (t) => {
  const { artFor, layoutArt } = await load()
  const art = {
    shapes: [
      { kind: 'rect', x: 100, y: 10, w: 200, h: 50, r: 10, fill: 'ink' },
      { kind: 'circle', cx: 60, cy: 262, r: 20, fill: 'sun' },
      { kind: 'diamond', cx: 500, cy: 50, w: 40, h: 20, fill: 'ochre' },
      { kind: 'tri', points: [[10, 20], [80, 20], [45, 84]], fill: 'red' },
      { kind: 'stripes', y: 440, h: 80, count: 4, colors: ['sea', { light: '#000000', dark: '#ffffff' }] }
    ]
  }
  const out = layoutArt(art, 500, 262.5, 'light')
  t.is(out.length, 8, 'stripes expand into one box each')
  t.alike(out[0], { kind: 'box', left: 50, top: 5, width: 100, height: 25, radius: 5, color: '#2b1d14' })
  t.alike(out[1], { kind: 'box', left: 20, top: 121, width: 20, height: 20, radius: 10, color: '#e46f3c' })
  t.is(out[2].kind, 'diamond')
  t.ok(Math.abs(out[2].side * Math.SQRT2 - 10) < 1e-9, 'diagonal spans h')
  t.is(out[2].scaleX, 2)
  t.alike(out[3], { kind: 'tri', left: 5, top: 10, leftWidth: 17.5, rightWidth: 17.5, height: 32, up: false, color: '#c2392b' })
  t.alike(out.slice(4).map((b) => b.top), [220, 230, 240, 250])
  t.alike(out.slice(4).map((b) => b.color), ['#1b6f8a', '#000000', '#1b6f8a', '#000000'])
  t.is(layoutArt(art, 500, 262.5, 'dark')[7].color, '#ffffff')
  t.alike(layoutArt(artFor('ipe'), 0, 100, 'light'), [])
})

test('inviteCardArt: a taller box stretches only beside the text area', async (t) => {
  const { layoutArt } = await load()
  const art = {
    shapes: [
      { kind: 'rect', x: 0, y: 0, w: 24, h: 525, fill: 'ink' },
      { kind: 'circle', cx: 60, cy: 470, r: 20, fill: 'sun' },
      { kind: 'circle', cx: 60, cy: 262.5, r: 20, fill: 'sun' }
    ]
  }
  const out = layoutArt(art, 1000, 825, 'light')
  t.is(out[0].height, 825, 'a full height border stretches')
  t.is(out[1].top, 825 - 55 - 20, 'the bottom band follows the bottom edge')
  t.is(out[1].width, 40, 'circles keep their size')
  t.ok(Math.abs(out[2].top - (105 + 157.5 * 615 / 315 - 20)) < 1e-9, 'side motifs follow their centre')
  const short = layoutArt(art, 1000, 100, 'light')
  t.is(short[0].height, 525, 'never shorter than the canvas aspect')
})

test('inviteCardArt: pure module', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/inviteCardArt.js'), 'utf8')
  t.absent(/\bimport\b[^\n]*from/.test(src), 'no imports')
  t.absent(/\b(window|document|navigator|globalThis|process)\b/.test(src), 'no globals')
  t.absent(src.includes('\u2014'), 'no em dash')
  t.absent(/Kusiwa|Wajãpi/i.test(src.replace(/^\/\/.*$/gm, '')), 'no protected pattern names in data')
})
