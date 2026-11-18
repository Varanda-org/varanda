// Enfeites for the Varandinha balcony, in the "Pôr do sol" look: flat colour
// with an ink outline. Shapes name palette keys and follow the vocabulary of
// gardenStyle.js, so one drawing serves both schemes. Geometry is original
// and local to each drawing, in whole units: the view scales the box, so
// nothing here reads a frame. A bulb marked glow gets a halo at night.

export const DECOR_LIGHT = deepFreeze({
  ink: '#1f2a24',
  rope: '#9a6b45',
  wood: '#b98d74',
  cloth: '#e8805a',
  clothAlt: '#fff6dd',
  fur: '#f0a35e',
  furDark: '#b8622c',
  furLight: '#fde3c0',
  wire: '#3a2a22',
  bulb1: '#f6c453',
  bulb2: '#e8805a',
  bulb3: '#5dcaa0',
  bulb4: '#fff6dd'
})

// Same keys at night: lit bulbs, and rope and cloth that still read on the
// dark sky.
export const DECOR_DARK = deepFreeze({
  ink: '#090c0b',
  rope: '#c9a27e',
  wood: '#84675a',
  cloth: '#c96b4c',
  clothAlt: '#e9dcc0',
  fur: '#d98f4e',
  furDark: '#9a5428',
  furLight: '#e8cfae',
  wire: '#4a5068',
  bulb1: '#ffd45e',
  bulb2: '#ff9a6e',
  bulb3: '#7fe0b6',
  bulb4: '#fffbe8'
})

export function decorPalette (scheme) {
  return scheme === 'dark' ? DECOR_DARK : DECOR_LIGHT
}

const OUTLINE = { stroke: 'ink', sw: 1.5 }

export const DECOR_DRAWINGS = deepFreeze({
  rede: {
    w: 150,
    h: 50,
    shapes: [
      { kind: 'path', d: 'M3 3L28 17M147 3L122 17', fill: 'none', stroke: 'rope', sw: 2, cap: 'round' },
      { kind: 'circle', cx: 3, cy: 3, r: 2, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'circle', cx: 147, cy: 3, r: 2, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'path', d: 'M26 16C40 46 110 46 124 16Z', fill: 'cloth', ...OUTLINE },
      { kind: 'path', d: 'M30 18C46 30 104 30 120 18', fill: 'none', stroke: 'clothAlt', sw: 2 },
      { kind: 'path', d: 'M34 22C50 40 100 40 116 22', fill: 'none', stroke: 'clothAlt', sw: 3 },
      { kind: 'ellipse', cx: 42, cy: 21, rx: 8, ry: 4, fill: 'clothAlt', stroke: 'ink', sw: 1 },
      { kind: 'circle', cx: 27, cy: 17, r: 3, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'circle', cx: 123, cy: 17, r: 3, fill: 'wood', stroke: 'ink', sw: 1 }
    ]
  },
  varal: {
    w: 150,
    h: 50,
    shapes: [
      { kind: 'path', d: 'M2 6Q75 14 148 6', fill: 'none', stroke: 'rope', sw: 1.5, cap: 'round' },
      { kind: 'path', d: 'M14 9L24 7L28 11L32 7L42 9L46 19L40 21L40 42L16 42L16 21L10 19Z', fill: 'cloth', ...OUTLINE },
      { kind: 'rect', x: 60, y: 10, w: 30, h: 32, rx: 2, fill: 'clothAlt', ...OUTLINE },
      { kind: 'path', d: 'M60 34L90 34M60 38L90 38', fill: 'none', stroke: 'cloth', sw: 2 },
      { kind: 'path', d: 'M104 9L134 9L136 34L122 34L119 20L116 34L102 34Z', fill: 'cloth', ...OUTLINE },
      { kind: 'rect', x: 22, y: 5, w: 3, h: 6, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'rect', x: 32, y: 5, w: 3, h: 6, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'rect', x: 63, y: 7, w: 3, h: 6, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'rect', x: 84, y: 7, w: 3, h: 6, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'rect', x: 108, y: 6, w: 3, h: 6, fill: 'wood', stroke: 'ink', sw: 1 },
      { kind: 'rect', x: 127, y: 6, w: 3, h: 6, fill: 'wood', stroke: 'ink', sw: 1 }
    ]
  },
  gato: {
    w: 100,
    h: 100,
    shapes: [
      { kind: 'path', d: 'M70 88C88 90 96 76 90 62', fill: 'none', stroke: 'ink', sw: 8, cap: 'round' },
      { kind: 'path', d: 'M70 88C88 90 96 76 90 62', fill: 'none', stroke: 'fur', sw: 5, cap: 'round' },
      { kind: 'ellipse', cx: 50, cy: 74, rx: 24, ry: 20, fill: 'fur', ...OUTLINE },
      { kind: 'ellipse', cx: 50, cy: 79, rx: 11, ry: 13, fill: 'furLight' },
      { kind: 'path', d: 'M30 66Q35 68 36 74M70 66Q65 68 64 74', fill: 'none', stroke: 'furDark', sw: 2.5, cap: 'round' },
      { kind: 'ellipse', cx: 40, cy: 93, rx: 7, ry: 4, fill: 'furLight', ...OUTLINE },
      { kind: 'ellipse', cx: 60, cy: 93, rx: 7, ry: 4, fill: 'furLight', ...OUTLINE },
      { kind: 'path', d: 'M33 34L30 14L47 27Z', fill: 'fur', ...OUTLINE },
      { kind: 'path', d: 'M67 34L70 14L53 27Z', fill: 'fur', ...OUTLINE },
      { kind: 'path', d: 'M35 30L33 19L43 27Z', fill: 'furDark' },
      { kind: 'path', d: 'M65 30L67 19L57 27Z', fill: 'furDark' },
      { kind: 'circle', cx: 50, cy: 42, r: 18, fill: 'fur', ...OUTLINE },
      { kind: 'path', d: 'M50 25L50 32M44 26L46 32M56 26L54 32', fill: 'none', stroke: 'furDark', sw: 2.5, cap: 'round' },
      { kind: 'ellipse', cx: 50, cy: 49, rx: 8, ry: 5, fill: 'furLight' },
      { kind: 'ellipse', cx: 43, cy: 42, rx: 2, ry: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 57, cy: 42, rx: 2, ry: 3, fill: 'ink' },
      { kind: 'path', d: 'M48 47L52 47L50 49Z', fill: 'cloth', stroke: 'ink', sw: 0.6 },
      { kind: 'path', d: 'M50 49Q48 53 45 51M50 49Q52 53 55 51', fill: 'none', stroke: 'ink', sw: 1, cap: 'round' },
      { kind: 'path', d: 'M39 48L28 47M39 51L29 53M61 48L72 47M61 51L71 53', fill: 'none', stroke: 'ink', sw: 0.8, opacity: 0.6 }
    ]
  },
  pisca: {
    w: 300,
    h: 20,
    shapes: [
      { kind: 'path', d: 'M4 2Q150 16 296 2', fill: 'none', stroke: 'wire', sw: 1.5, cap: 'round' },
      { kind: 'rect', x: 31, y: 5, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 33, cy: 12, rx: 3, ry: 4, fill: 'bulb1', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 60, y: 6, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 62, cy: 13, rx: 3, ry: 4, fill: 'bulb2', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 90, y: 8, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 92, cy: 15, rx: 3, ry: 4, fill: 'bulb3', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 119, y: 9, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 121, cy: 16, rx: 3, ry: 4, fill: 'bulb4', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 148, y: 9, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 150, cy: 16, rx: 3, ry: 4, fill: 'bulb1', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 177, y: 9, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 179, cy: 16, rx: 3, ry: 4, fill: 'bulb2', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 206, y: 8, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 208, cy: 15, rx: 3, ry: 4, fill: 'bulb3', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 236, y: 6, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 238, cy: 13, rx: 3, ry: 4, fill: 'bulb4', stroke: 'ink', sw: 1, glow: true },
      { kind: 'rect', x: 265, y: 5, w: 4, h: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 267, cy: 12, rx: 3, ry: 4, fill: 'bulb1', stroke: 'ink', sw: 1, glow: true }
    ]
  }
})

const EMPTY = deepFreeze({ w: 1, h: 1, shapes: [] })

// An id from the view is untrusted. Anything other than the four strings,
// including a proxy or a throwing getter, is the empty drawing.
export function decorDrawing (id) {
  try {
    if (typeof id !== 'string') return EMPTY
    if (!Object.hasOwn(DECOR_DRAWINGS, id)) return EMPTY
    return DECOR_DRAWINGS[id]
  } catch {
    return EMPTY
  }
}

function deepFreeze (value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
