import { artFor, resolveFill, shapeBounds } from './inviteCardArt.js'

export const MOTIF_WINDOWS = deepFreeze({
  marajoara: [[20, 16, 80, 80]],
  aguas: [[472, 436, 78, 90]],
  vitoria: [[10, 4, 100, 100]],
  cordel: [[464, 28, 72, 72]],
  bandeirinhas: [[13, 18, 74, 68], [94, 18, 74, 68], [175, 18, 74, 68], [256, 18, 74, 68], [337, 18, 74, 68]],
  chita: [[14, 7, 92, 90]],
  ipe: [[59, 31, 62, 54]],
  pantanal: [[854, 14, 92, 92]],
  azulejo: [[10, 15, 74, 74]],
  copacabana: [[12, 424, 76, 91]],
  minas: [[6, 0, 108, 100]],
  araucaria: [[6, 148, 108, 134]],
  chimarrao: [[888, 339, 104, 151]]
})

export const STAGE = deepFreeze({
  SIZE: { compact: 40, phone: 52, wide: 72 },
  LEAD: 1.25,
  FOOT: 0.8,
  GAP: 14,
  FOOT_GAP: 12,
  MARGIN: 8,
  COLUMN: 420
})

const MOTIFS = deepFreeze(Object.fromEntries(Object.entries(MOTIF_WINDOWS).map(([design, windows]) => [
  design, windows.map((region) => cutMotif(artFor(design), region))
])))
const EMPTY = Object.freeze([])

function cutMotif (art, [x, y, w, h]) {
  const selected = art.shapes.filter((shape) => {
    if (shape.kind === 'stripes') return false
    const b = shapeBounds(shape)
    return b.x >= x && b.y >= y && b.x + b.w <= x + w && b.y + b.h <= y + h
  })
  const bounds = selected.map(shapeBounds)
  const x0 = Math.min(...bounds.map((b) => b.x))
  const y0 = Math.min(...bounds.map((b) => b.y))
  const w0 = Math.max(...bounds.map((b) => b.x + b.w)) - x0
  const h0 = Math.max(...bounds.map((b) => b.y + b.h)) - y0
  const shapes = selected.map((shape) => {
    if (shape.kind === 'rect') return { ...shape, x: shape.x - x0, y: shape.y - y0 }
    if (shape.kind === 'tri') return { ...shape, points: shape.points.map(([px, py]) => [px - x0, py - y0]) }
    return { ...shape, cx: shape.cx - x0, cy: shape.cy - y0 }
  })
  return { w: w0, h: h0, shapes }
}

export function motifsFor (design) {
  return typeof design === 'string' && Object.prototype.hasOwnProperty.call(MOTIF_WINDOWS, design) ? MOTIFS[design] : EMPTY
}

export function layoutMotif (motif, size, scheme) {
  if (!motif || !(size > 0)) return { width: 0, height: 0, items: [] }
  const k = size / Math.max(motif.w, motif.h)
  const items = []
  for (const s of motif.shapes) {
    const color = resolveFill(s.fill, scheme)
    if (color === null) continue
    if (s.kind === 'rect') {
      items.push({ kind: 'box', left: s.x * k, top: s.y * k, width: s.w * k, height: s.h * k, radius: (s.r || 0) * k, color })
    } else if (s.kind === 'circle') {
      items.push({ kind: 'box', left: (s.cx - s.r) * k, top: (s.cy - s.r) * k, width: 2 * s.r * k, height: 2 * s.r * k, radius: s.r * k, color })
    } else if (s.kind === 'diamond') {
      const side = s.h * k / Math.SQRT2
      items.push({ kind: 'diamond', left: s.cx * k - side / 2, top: s.cy * k - side / 2, side, scaleX: s.w / s.h, color })
    } else if (s.kind === 'tri') {
      const [a, b, apex] = s.points
      const x1 = Math.min(a[0], b[0])
      const x2 = Math.max(a[0], b[0])
      items.push({ kind: 'tri', left: x1 * k, top: Math.min(apex[1], a[1]) * k, leftWidth: (apex[0] - x1) * k, rightWidth: (x2 - apex[0]) * k, height: Math.abs(apex[1] - a[1]) * k, up: apex[1] < a[1], color })
    }
  }
  return { width: motif.w * k, height: motif.h * k, items }
}

export function stageClass (width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) return 'none'
  if (width < 360 || height < 600) return 'compact'
  return width >= 768 ? 'wide' : 'phone'
}

export function welcomeBands (width, height) {
  const cls = stageClass(width, height)
  if (cls === 'none') return { top: 16, bottom: 16 }
  const size = STAGE.SIZE[cls]
  return {
    top: Math.round(STAGE.GAP + size * STAGE.LEAD + STAGE.GAP),
    bottom: cls === 'compact' ? 16 : Math.round(STAGE.FOOT_GAP + size * STAGE.FOOT + STAGE.FOOT_GAP)
  }
}

export function welcomeStage ({ design, width, height }) {
  const cls = stageClass(width, height)
  const motifs = motifsFor(design)
  if (cls === 'none' || motifs.length === 0) return { cls, slots: [] }
  const size = STAGE.SIZE[cls]
  const topY = STAGE.GAP + size * STAGE.LEAD / 2
  const footY = height - STAGE.FOOT_GAP - size * STAGE.FOOT / 2
  const centres = [[width * 0.5, topY, size * STAGE.LEAD]]
  if (cls === 'wide') {
    for (const fraction of [0.30, 0.70, 0.10, 0.90]) centres.push([width * fraction, topY, size])
    const sideX = (width - STAGE.COLUMN) / 4
    centres.push([sideX, height / 2, size], [width - sideX, height / 2, size])
  } else {
    centres.push([width * 0.16, topY, size], [width * 0.84, topY, size])
  }
  if (cls !== 'compact') centres.push([width * 0.12, footY, size * STAGE.FOOT], [width * 0.88, footY, size * STAGE.FOOT])
  const slots = centres.map(([cx, cy, long], order) => {
    const variant = order % motifs.length
    const motif = motifs[variant]
    const k = long / Math.max(motif.w, motif.h)
    const bw = motif.w * k
    const bh = motif.h * k
    return {
      key: 's' + order,
      order,
      side: cx < width / 2 ? -1 : cx > width / 2 ? 1 : 0,
      variant,
      size: long,
      left: clamp(cx - bw / 2, STAGE.MARGIN, width - STAGE.MARGIN - bw),
      top: clamp(cy - bh / 2, STAGE.MARGIN, height - STAGE.MARGIN - bh),
      width: bw,
      height: bh
    }
  })
  return { cls, slots }
}

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function deepFreeze (value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
