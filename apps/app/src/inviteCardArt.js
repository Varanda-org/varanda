// The invite card frames as plain data, one per design id of @varanda/rpc
// DESIGNS. Pure on purpose (no React, no react-native, no globals): the app
// frame (src/ui/InviteCardFrame.js) draws it with Views, and the messenger
// preview rasterizes the same data to a 1200x630 PNG, so both stay alike.
//
// Each frame lives on a 0..1000 x 0..525 virtual canvas (the 1200x630 shape)
// and is made only of these primitives:
//   { kind: 'rect', x, y, w, h, r?, fill }
//   { kind: 'circle', cx, cy, r, fill }
//   { kind: 'tri', points: [[x, y], [x, y], [x, y]], fill } two points share
//     y (the base) and the third sits between them in x, so a View border
//     can draw it
//   { kind: 'diamond', cx, cy, w, h, fill }
//   { kind: 'stripes', y, h, count, colors: [fill, ...] } full width bands
// A fill is a { light, dark } pair or a PALETTE key. Shapes stay out of
// SAFE_AREA so the text over it stays legible.
//
// The geometry is original and generic: it nods to regional traditions
// without copying any artist's print, historic tile panel, sidewalk or
// protected indigenous pattern.

export const CANVAS = Object.freeze({ w: 1000, h: 525 })
export const SAFE_AREA = Object.freeze({ x: 120, y: 105, w: 760, h: 315 })

const pair = (light, dark) => ({ light, dark })

export const PALETTE = deepFreeze({
  ink: pair('#2b1d14', '#f1e4cf'),
  terracota: pair('#b5532f', '#e08a62'),
  ochre: pair('#d99a1e', '#f2c25b'),
  cream: pair('#f3e3c3', '#5a4632'),
  sand: pair('#d9b77f', '#8a6f4c'),
  river: pair('#2f6f9f', '#6fb0dd'),
  teal: pair('#2f8a7a', '#6cc7b4'),
  forest: pair('#2f6b3a', '#7cc48a'),
  leaf: pair('#5f9a3c', '#9bd178'),
  pink: pair('#cc3f73', '#f08bb0'),
  red: pair('#c2392b', '#f07f6f'),
  yellow: pair('#e8ac00', '#f7cf4a'),
  sun: pair('#e46f3c', '#f4a37f'),
  wood: pair('#7a4a2a', '#c79a6e'),
  tileBlue: pair('#1f4fa0', '#86aaea'),
  tileWhite: pair('#ffffff', '#dfe7f5'),
  sea: pair('#1b6f8a', '#5fb7d3'),
  gold: pair('#b0801f', '#e4b866'),
  stone: pair('#8a7a66', '#bfae96'),
  pine: pair('#2f5b3a', '#7fbf8e'),
  cone: pair('#8a4e2a', '#d4956a'),
  mate: pair('#5c7f2e', '#a6c96a'),
  straw: pair('#7d838b', '#c9cdd2'),
  gourd: pair('#8c5a2b', '#c98c55')
})

const INK = pair('#1f2a24', '#f4f0e6')

const rect = (x, y, w, h, fill, r) => (r === undefined ? { kind: 'rect', x, y, w, h, fill } : { kind: 'rect', x, y, w, h, r, fill })
const circle = (cx, cy, r, fill) => ({ kind: 'circle', cx, cy, r, fill })
const diamond = (cx, cy, w, h, fill) => ({ kind: 'diamond', cx, cy, w, h, fill })
// The base runs from x1 to x2 at baseY; the apex sits at (apexX, apexY).
const tri = (x1, x2, baseY, apexX, apexY, fill) => ({ kind: 'tri', points: [[x1, baseY], [x2, baseY], [apexX, apexY]], fill })
const stripes = (y, h, count, colors) => ({ kind: 'stripes', y, h, count, colors })

const round = (n) => Math.round(n * 10) / 10
const range = (n) => Array.from({ length: n }, (_, i) => i)

// Concentric diamonds stepping in from the outline.
function steppedDiamond (cx, cy, size, fills) {
  const step = size / fills.length
  return fills.map((fill, i) => diamond(cx, cy, round(size - i * step), round(size - i * step), fill))
}

// A square spiral of bars inside an 80 box at (x, y), bar thickness 8.
function squareSpiral (x, y, fill) {
  return [
    rect(x, y, 8, 80, fill),
    rect(x, y, 80, 8, fill),
    rect(x + 72, y, 8, 64, fill),
    rect(x + 16, y + 56, 64, 8, fill),
    rect(x + 16, y + 24, 8, 40, fill),
    rect(x + 16, y + 24, 40, 8, fill),
    rect(x + 48, y + 24, 8, 20, fill)
  ]
}

function concentric (cx, cy, radii, fills) {
  return radii.map((r, i) => circle(cx, cy, r, fills[i % fills.length]))
}

// Five round petals around a centre.
function flower (cx, cy, scale, petal, heart) {
  const out = []
  for (let k = 0; k < 5; k++) {
    const a = (k * 72 - 90) * Math.PI / 180
    out.push(circle(round(cx + Math.cos(a) * 18 * scale), round(cy + Math.sin(a) * 18 * scale), round(14 * scale), petal))
  }
  out.push(circle(cx, cy, round(9 * scale), heart))
  return out
}

function blossom (cx, cy, scale) {
  return [
    circle(round(cx - 16 * scale), round(cy + 6 * scale), round(13 * scale), 'ochre'),
    circle(round(cx + 16 * scale), round(cy + 6 * scale), round(13 * scale), 'ochre'),
    circle(cx, round(cy - 10 * scale), round(15 * scale), 'yellow'),
    circle(cx, round(cy + 8 * scale), round(17 * scale), 'yellow')
  ]
}

function tile (x, y) {
  return [
    rect(x, y, 70, 70, 'tileWhite', 4),
    diamond(x + 35, y + 35, 50, 50, 'tileBlue'),
    diamond(x + 35, y + 35, 24, 24, 'tileWhite'),
    circle(x + 35, y + 35, 5, 'tileBlue'),
    circle(x + 8, y + 8, 4, 'tileBlue'),
    circle(x + 62, y + 8, 4, 'tileBlue'),
    circle(x + 8, y + 62, 4, 'tileBlue'),
    circle(x + 62, y + 62, 4, 'tileBlue')
  ]
}

// An araucaria: a flat crown made of downward tiers on a thin trunk, with a
// few cones under the crown.
function araucaria (cx, top, scale) {
  const s = (n) => round(n * scale)
  return [
    rect(round(cx - s(4)), top + s(20), s(8), s(110), 'wood'),
    tri(round(cx - s(52)), round(cx + s(52)), top, cx, top + s(34), 'pine'),
    tri(round(cx - s(40)), round(cx + s(40)), top + s(30), cx, top + s(58), 'pine'),
    tri(round(cx - s(26)), round(cx + s(26)), top + s(54), cx, top + s(76), 'pine'),
    circle(round(cx - s(30)), top + s(38), s(5), 'cone'),
    circle(round(cx + s(30)), top + s(38), s(5), 'cone'),
    circle(round(cx - s(16)), top + s(62), s(4), 'cone'),
    circle(round(cx + s(16)), top + s(62), s(4), 'cone')
  ]
}

const DESIGN_ART = {
  // Stepped diamonds and square spirals: generic geometry.
  marajoara: {
    bg: pair('#f4e6cf', '#2b2019'),
    ink: INK,
    shapes: [
      rect(0, 6, 1000, 6, 'ink'),
      rect(0, 513, 1000, 6, 'ink'),
      ...range(10).flatMap((i) => steppedDiamond(60 + i * 98, 56, 76, ['ink', 'terracota', 'cream', 'ink'])),
      ...range(10).flatMap((i) => steppedDiamond(60 + i * 98, 469, 76, ['ink', 'terracota', 'cream', 'ink'])),
      ...squareSpiral(20, 182, 'terracota'),
      ...squareSpiral(20, 263, 'ink'),
      ...squareSpiral(900, 182, 'ink'),
      ...squareSpiral(900, 263, 'terracota')
    ]
  },
  // Two waters meeting side by side without mixing.
  aguas: {
    bg: pair('#eef3ef', '#1d2a2a'),
    ink: INK,
    shapes: [
      stripes(0, 60, 4, [pair('#3a2618', '#9b7656'), pair('#c99a5b', '#e0bb85')]),
      rect(0, 440, 540, 85, pair('#3a2618', '#9b7656')),
      rect(500, 440, 500, 85, pair('#c99a5b', '#e0bb85')),
      circle(500, 458, 18, pair('#3a2618', '#9b7656')),
      circle(530, 484, 16, pair('#c99a5b', '#e0bb85')),
      circle(490, 508, 15, pair('#3a2618', '#9b7656')),
      circle(60, 190, 12, 'teal'),
      circle(44, 262, 18, 'river'),
      circle(76, 334, 10, 'teal'),
      circle(940, 190, 10, 'teal'),
      circle(956, 262, 18, 'river'),
      circle(924, 334, 12, 'teal')
    ]
  },
  // Round pads seen from above, in rings.
  vitoria: {
    bg: pair('#eef4ea', '#1c2a22'),
    ink: INK,
    shapes: [
      ...concentric(60, 54, [48, 38, 26, 12], ['forest', 'leaf', 'forest', 'pink']),
      ...concentric(940, 54, [48, 38, 26, 12], ['forest', 'leaf', 'forest', 'pink']),
      ...concentric(60, 471, [48, 38, 26, 12], ['forest', 'leaf', 'forest', 'pink']),
      ...concentric(940, 471, [48, 38, 26, 12], ['forest', 'leaf', 'forest', 'pink']),
      ...concentric(60, 262, [36, 26, 14], ['leaf', 'forest', 'leaf']),
      ...concentric(940, 262, [36, 26, 14], ['leaf', 'forest', 'leaf']),
      ...[300, 500, 700].flatMap((x) => concentric(x, 52, [30, 20, 8], ['leaf', 'forest', 'pink'])),
      ...[400, 600].flatMap((x) => concentric(x, 473, [30, 20, 8], ['leaf', 'forest', 'pink']))
    ]
  },
  // A thick printed border, a sun disc and two hills.
  cordel: {
    bg: pair('#f5ecd7', '#2a241b'),
    ink: INK,
    shapes: [
      circle(500, 64, 34, 'ochre'),
      circle(500, 64, 18, 'sun'),
      circle(340, 470, 50, 'terracota'),
      circle(440, 480, 40, 'forest'),
      diamond(70, 70, 26, 26, 'ink'),
      diamond(930, 70, 26, 26, 'ink'),
      diamond(70, 262, 22, 22, 'ink'),
      diamond(930, 262, 22, 22, 'ink'),
      diamond(930, 455, 26, 26, 'ink'),
      rect(0, 0, 1000, 24, 'ink'),
      rect(0, 490, 1000, 35, 'ink'),
      rect(0, 0, 24, 525, 'ink'),
      rect(976, 0, 24, 525, 'ink')
    ]
  },
  // A string of little flags across the top.
  bandeirinhas: {
    bg: pair('#fdf3e1', '#2a2119'),
    ink: INK,
    shapes: [
      rect(0, 16, 1000, 4, 'wood'),
      ...range(12).map((i) => {
        const x = 15 + i * 81
        return tri(x, x + 70, 20, x + 35, 84, ['red', 'yellow', 'river', 'leaf', 'pink'][i % 5])
      }),
      ...range(9).map((i) => circle(70 + i * 107, 480 + (i % 2) * 18, 7, ['ochre', 'pink', 'river'][i % 3])),
      rect(0, 515, 1000, 10, 'terracota')
    ]
  },
  // Five petal flowers made of circles, with small leaves between.
  chita: {
    bg: pair('#fbe9dc', '#2c1d1f'),
    ink: INK,
    shapes: [
      ...[60, 940].flatMap((x) => flower(x, 54, 1.4, 'red', 'yellow')),
      ...[60, 940].flatMap((x) => flower(x, 471, 1.4, 'red', 'yellow')),
      ...[60, 940].flatMap((x) => flower(x, 262, 1, 'pink', 'yellow')),
      ...[230, 410, 590, 770].flatMap((x, i) => flower(x, 52, 1, i % 2 ? 'yellow' : 'pink', 'red')),
      ...[320, 500, 680].flatMap((x, i) => flower(x, 473, 1, i % 2 ? 'pink' : 'yellow', 'red')),
      ...[145, 320, 500, 680, 855].map((x) => diamond(x, 52, 22, 14, 'leaf')),
      ...[230, 410, 590, 770].map((x) => diamond(x, 473, 22, 14, 'leaf')),
      diamond(60, 160, 14, 22, 'leaf'),
      diamond(60, 364, 14, 22, 'leaf'),
      diamond(940, 160, 14, 22, 'leaf'),
      diamond(940, 364, 14, 22, 'leaf')
    ]
  },
  // Round yellow blossoms on a branch and on the ground.
  ipe: {
    bg: pair('#fbf6e4', '#26231a'),
    ink: INK,
    shapes: [
      rect(30, 28, 940, 6, 'wood', 3),
      ...[90, 260, 430, 600, 770, 920].flatMap((x, i) => blossom(x, 58 + (i % 2) * 10, 1)),
      rect(0, 500, 1000, 25, 'leaf'),
      ...[80, 200, 330, 470, 610, 740, 880].map((x, i) => circle(x, 480 - (i % 2) * 10, 9, i % 3 ? 'yellow' : 'ochre')),
      circle(60, 180, 10, 'yellow'),
      circle(48, 300, 8, 'ochre'),
      circle(940, 220, 10, 'yellow'),
      circle(956, 340, 8, 'ochre')
    ]
  },
  // A low horizon, a big sun and reeds by the water.
  pantanal: {
    bg: pair('#fdf1e2', '#1f2229'),
    ink: INK,
    shapes: [
      circle(900, 60, 44, pair('#f7c9a4', '#6a4a3a')),
      circle(900, 60, 32, 'sun'),
      stripes(440, 85, 4, ['leaf', 'teal', 'river', 'teal']),
      ...[24, 40, 58, 76, 94].map((x, i) => rect(x, 300 + (i % 2) * 30, 5, 140 - (i % 2) * 30, 'forest')),
      ...[24, 58, 94].map((x) => diamond(x + 2.5, 300, 10, 26, 'wood')),
      ...[906, 924, 942, 960, 978].map((x, i) => rect(x, 320 + (i % 2) * 24, 5, 120 - (i % 2) * 24, 'forest')),
      ...[906, 942, 978].map((x) => diamond(x + 2.5, 320, 10, 26, 'wood')),
      rect(180, 456, 120, 6, 'cream', 3),
      rect(640, 476, 160, 6, 'cream', 3)
    ]
  },
  // A border of blue and white tiles of a simple invented motif.
  azulejo: {
    bg: pair('#eaf0fa', '#18213a'),
    ink: INK,
    shapes: [
      ...range(13).flatMap((i) => tile(12 + i * 76, 17)),
      ...range(13).flatMap((i) => tile(12 + i * 76, 438)),
      ...[112, 188, 264, 340].flatMap((y) => tile(25, y)),
      ...[112, 188, 264, 340].flatMap((y) => tile(905, y))
    ]
  },
  // Four bands of sea and sand with rounded wave crests.
  copacabana: {
    bg: pair('#fdf6ea', '#1a2329'),
    ink: INK,
    shapes: [
      stripes(0, 88, 4, ['sea', 'sand']),
      ...range(20).map((i) => circle(25 + i * 50, 88, 11, 'sand')),
      stripes(437, 88, 4, ['sea', 'sand']),
      ...range(20).map((i) => circle(25 + i * 50, 437, 11, 'sea')),
      ...range(19).map((i) => circle(50 + i * 50, 459, 10, 'sand')),
      ...range(20).map((i) => circle(25 + i * 50, 481, 10, 'sea')),
      ...range(19).map((i) => circle(50 + i * 50, 503, 10, 'sand'))
    ]
  },
  // An arch of bars over the text between two pillars.
  minas: {
    bg: pair('#f6efe2', '#26221d'),
    ink: INK,
    shapes: [
      ...range(25).map((i) => {
        const cx = 20 + i * 40
        const u = (cx - 500) / 500
        const h = round(30 + 70 * (1 - Math.sqrt(1 - u * u)))
        return rect(cx - 12, 0, 24, h, i % 2 ? 'stone' : 'gold')
      }),
      rect(20, 100, 30, 380, 'stone'),
      rect(62, 100, 16, 380, 'gold'),
      rect(950, 100, 30, 380, 'stone'),
      rect(922, 100, 16, 380, 'gold'),
      circle(98, 262, 8, 'river'),
      circle(902, 262, 8, 'river'),
      rect(0, 480, 1000, 18, 'gold'),
      rect(0, 498, 1000, 27, 'stone')
    ]
  },
  // Araucaria crowns like candelabra, with small cones.
  araucaria: {
    bg: pair('#eef3ea', '#1b2520'),
    ink: INK,
    shapes: [
      ...araucaria(60, 150, 1),
      ...araucaria(940, 150, 1),
      ...[200, 340, 660, 800].flatMap((x) => araucaria(x, 14, 0.6)),
      ...[500].flatMap((x) => araucaria(x, 20, 0.5)),
      rect(0, 450, 1000, 18, 'leaf'),
      rect(0, 468, 1000, 57, 'pine'),
      ...[150, 330, 500, 670, 850].map((x) => circle(x, 496, 7, 'cone'))
    ]
  },
  // A gourd with its straw, and a row of leaves.
  chimarrao: {
    bg: pair('#f3f1e3', '#202419'),
    ink: INK,
    shapes: [
      stripes(0, 48, 3, ['mate', 'leaf', 'forest']),
      rect(950, 230, 8, 130, 'straw', 4),
      rect(950, 230, 30, 8, 'straw', 4),
      circle(940, 438, 50, 'gourd'),
      circle(940, 386, 32, 'gourd'),
      rect(906, 352, 68, 12, 'wood', 6),
      circle(926, 352, 8, 'mate'),
      circle(942, 350, 9, 'leaf'),
      ...[180, 260, 340].map((y, i) => diamond(60, y, 26, 44, i % 2 ? 'leaf' : 'mate')),
      ...range(8).map((i) => diamond(160 + i * 96, 484, 44, 22, i % 2 ? 'leaf' : 'mate')),
      rect(0, 512, 1000, 13, 'forest')
    ]
  }
}

const NEUTRAL = deepFreeze({
  bg: pair('#fbf8f3', '#1c2622'),
  ink: INK,
  shapes: [
    rect(0, 0, 1000, 10, 'stone'),
    rect(0, 515, 1000, 10, 'stone')
  ]
})

export const ART = deepFreeze(DESIGN_ART)

export function artFor (id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ART, id) ? ART[id] : NEUTRAL
}

export function resolveFill (fill, scheme) {
  const key = scheme === 'dark' ? 'dark' : 'light'
  if (typeof fill === 'string') {
    const p = Object.prototype.hasOwnProperty.call(PALETTE, fill) ? PALETTE[fill] : null
    return p === null ? null : p[key]
  }
  return fill !== null && typeof fill === 'object' ? fill[key] : null
}

// The box a shape covers on the canvas.
export function shapeBounds (s) {
  switch (s.kind) {
    case 'rect': return { x: s.x, y: s.y, w: s.w, h: s.h }
    case 'circle': return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 }
    case 'diamond': return { x: s.cx - s.w / 2, y: s.cy - s.h / 2, w: s.w, h: s.h }
    case 'stripes': return { x: 0, y: s.y, w: CANVAS.w, h: s.h }
    case 'tri': {
      const xs = s.points.map((p) => p[0])
      const ys = s.points.map((p) => p[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
    default: return null
  }
}

// Lays the art out on a box of width x height (height >= the canvas aspect).
// The width scales the canvas evenly; a taller box stretches only the band
// beside SAFE_AREA, so the top and bottom borders keep their shape and the
// text area grows with its content. Rects and stripes stretch with it;
// circles, diamonds and triangles keep their size and follow their centre.
// Returns plain boxes for the frame to draw:
//   { kind: 'box', left, top, width, height, radius, color }
//   { kind: 'tri', left, top, leftWidth, rightWidth, height, up, color }
//   { kind: 'diamond', left, top, side, scaleX, color }
export function layoutArt (art, width, height, scheme) {
  if (!(width > 0)) return []
  const k = width / CANVAS.w
  const minH = CANVAS.h * k
  const h = height > minH ? height : minH
  const top = SAFE_AREA.y * k
  const bottomBand = (CANVAS.h - SAFE_AREA.y - SAFE_AREA.h) * k
  const mid = (h - top - bottomBand) / SAFE_AREA.h
  const mapY = (y) => {
    if (y <= SAFE_AREA.y) return y * k
    if (y >= SAFE_AREA.y + SAFE_AREA.h) return h - (CANVAS.h - y) * k
    return top + (y - SAFE_AREA.y) * mid
  }
  const out = []
  const box = (x, y, w, bh, r, color) => {
    const y0 = mapY(y)
    out.push({ kind: 'box', left: x * k, top: y0, width: w * k, height: mapY(y + bh) - y0, radius: (r || 0) * k, color })
  }
  for (const s of art.shapes) {
    if (s.kind === 'rect') {
      box(s.x, s.y, s.w, s.h, s.r, resolveFill(s.fill, scheme))
    } else if (s.kind === 'stripes') {
      const step = s.h / s.count
      for (let i = 0; i < s.count; i++) {
        box(0, s.y + i * step, CANVAS.w, step, 0, resolveFill(s.colors[i % s.colors.length], scheme))
      }
    } else if (s.kind === 'circle') {
      const r = s.r * k
      out.push({ kind: 'box', left: (s.cx - s.r) * k, top: mapY(s.cy) - r, width: r * 2, height: r * 2, radius: r, color: resolveFill(s.fill, scheme) })
    } else if (s.kind === 'diamond') {
      // A square of side h / sqrt(2) turned 45 degrees spans h both ways;
      // scaleX then widens it to w.
      const side = s.h * k / Math.SQRT2
      out.push({ kind: 'diamond', left: s.cx * k - side / 2, top: mapY(s.cy) - side / 2, side, scaleX: s.w / s.h, color: resolveFill(s.fill, scheme) })
    } else if (s.kind === 'tri') {
      const [a, b, apex] = s.points
      const x1 = Math.min(a[0], b[0])
      const x2 = Math.max(a[0], b[0])
      const up = apex[1] < a[1]
      const th = Math.abs(apex[1] - a[1]) * k
      const cy = mapY((apex[1] + a[1]) / 2)
      out.push({ kind: 'tri', left: x1 * k, top: cy - th / 2, leftWidth: (apex[0] - x1) * k, rightWidth: (x2 - apex[0]) * k, height: th, up, color: resolveFill(s.fill, scheme) })
    }
  }
  return out
}

function deepFreeze (value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
