// Enfeites for the Varandinha balcony. Shapes name palette keys, so one
// drawing serves both schemes. Geometry is flat, original, and local to
// each drawing: the view scales the box, so nothing here reads a frame.

export const DECOR_LIGHT = deepFreeze({
  rope: '#8a5a32',
  cloth: '#d4534a',
  clothAlt: '#f0d7a2',
  lamp: '#f2c14e',
  fur: '#e0a15a',
  furDark: '#7a4a28'
})

// Same keys, lightened so rope, cloth and fur still read on a dark page.
export const DECOR_DARK = deepFreeze({
  rope: '#e0b888',
  cloth: '#f09284',
  clothAlt: '#f6e6c0',
  lamp: '#ffe08a',
  fur: '#f0c48a',
  furDark: '#c48a5c'
})

export function decorPalette (scheme) {
  return scheme === 'dark' ? DECOR_DARK : DECOR_LIGHT
}

export const DECOR_DRAWINGS = deepFreeze({
  rede: {
    w: 150,
    h: 50,
    shapes: [
      { kind: 'path', d: 'M6 2 L14 2 L34 18 L26 18 Z', fill: 'rope' },
      { kind: 'path', d: 'M144 2 L136 2 L116 18 L124 18 Z', fill: 'rope' },
      { kind: 'path', d: 'M26 14 L124 14 L124 18 L26 18 Z', fill: 'rope' },
      { kind: 'path', d: 'M26 16 L124 16 L112 38 L38 38 Z', fill: 'cloth' },
      { kind: 'path', d: 'M38 38 L112 38 L102 46 L48 46 Z', fill: 'clothAlt' },
      { kind: 'circle', cx: 30, cy: 18, r: 3, fill: 'rope' },
      { kind: 'circle', cx: 120, cy: 18, r: 3, fill: 'rope' }
    ]
  },
  varal: {
    w: 150,
    h: 50,
    shapes: [
      { kind: 'rect', x: 4, y: 6, w: 142, h: 2, fill: 'rope' },
      { kind: 'rect', x: 26, y: 4, w: 6, h: 6, fill: 'rope' },
      { kind: 'rect', x: 72, y: 4, w: 6, h: 6, fill: 'rope' },
      { kind: 'rect', x: 116, y: 4, w: 6, h: 6, fill: 'rope' },
      { kind: 'path', d: 'M16 10 L46 10 L50 40 L12 40 Z', fill: 'cloth' },
      { kind: 'path', d: 'M60 10 L90 10 L86 44 L56 44 Z', fill: 'clothAlt' },
      { kind: 'path', d: 'M104 10 L134 10 L138 36 L100 36 Z', fill: 'cloth' }
    ]
  },
  gato: {
    w: 100,
    h: 100,
    shapes: [
      { kind: 'path', d: 'M74 68 L94 46 L98 56 L80 78 Z', fill: 'furDark' },
      { kind: 'ellipse', cx: 48, cy: 70, rx: 24, ry: 20, fill: 'fur' },
      { kind: 'ellipse', cx: 66, cy: 74, rx: 16, ry: 14, fill: 'fur' },
      { kind: 'path', d: 'M52 62 L66 76 L60 80 L48 66 Z', fill: 'furDark' },
      { kind: 'ellipse', cx: 36, cy: 90, rx: 10, ry: 6, fill: 'fur' },
      { kind: 'ellipse', cx: 58, cy: 90, rx: 10, ry: 6, fill: 'fur' },
      { kind: 'path', d: 'M30 30 L22 10 L42 26 Z', fill: 'fur' },
      { kind: 'path', d: 'M28 18 L24 12 L36 18 Z', fill: 'furDark' },
      { kind: 'path', d: 'M50 28 L64 8 L68 30 Z', fill: 'fur' },
      { kind: 'path', d: 'M58 18 L64 10 L66 20 Z', fill: 'furDark' },
      { kind: 'circle', cx: 46, cy: 40, r: 16, fill: 'fur' },
      { kind: 'path', d: 'M38 30 L46 44 L42 44 L34 32 Z', fill: 'furDark' },
      { kind: 'circle', cx: 40, cy: 40, r: 2, fill: 'furDark' },
      { kind: 'circle', cx: 52, cy: 40, r: 2, fill: 'furDark' },
      { kind: 'ellipse', cx: 46, cy: 46, rx: 3, ry: 2, fill: 'furDark' },
      { kind: 'path', d: 'M42 48 L46 52 L50 48 Z', fill: 'furDark' }
    ]
  },
  pisca: {
    w: 300,
    h: 20,
    shapes: [
      { kind: 'rect', x: 8, y: 2, w: 284, h: 2, fill: 'rope' },
      { kind: 'circle', cx: 8, cy: 3, r: 2, fill: 'rope' },
      { kind: 'circle', cx: 292, cy: 3, r: 2, fill: 'rope' },
      { kind: 'rect', x: 23, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 61, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 99, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 137, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 175, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 213, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 251, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'rect', x: 289, y: 4, w: 2, h: 6, fill: 'rope' },
      { kind: 'circle', cx: 24, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 62, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 100, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 138, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 176, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 214, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 252, cy: 13, r: 4, fill: 'lamp' },
      { kind: 'circle', cx: 290, cy: 13, r: 4, fill: 'lamp' }
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
