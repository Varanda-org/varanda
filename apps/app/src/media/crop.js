// Pure crop math for the avatar editor. No React or browser dependencies.
// A crop is { zoom, cx, cy }: the zoom over the largest square that fits the
// image, and the center of the visible square normalized to the image size.
// The visible side is min(w, h) / zoom image pixels. Every control moves the
// photo, not the window over it, so a drag right, nudge('right') and the
// ArrowRight key all move the photo right. No function throws: bad input
// gives initialCrop() or a clamped value.

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
export const ZOOM_STEP = 1.25
// A fraction of the visible side.
export const MOVE_STEP = 0.1

export function initialCrop () {
  return { zoom: 1, cx: 0.5, cy: 0.5 }
}

// Integer image size (the frozen canvas is integer anyway), or null.
function dims (src) {
  if (!src || typeof src !== 'object') return null
  const w = Math.floor(src.width)
  const h = Math.floor(src.height)
  if (!(Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1)) return null
  return { w, h }
}

function clamp (n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function finite (n, fallback) {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function sideOf (zoom, d) {
  return Math.min(d.w, d.h) / zoom
}

export function clampCrop (crop, src) {
  const d = dims(src)
  if (!d || !crop || typeof crop !== 'object') return initialCrop()
  const zoom = clamp(finite(crop.zoom, MIN_ZOOM), MIN_ZOOM, MAX_ZOOM)
  const s = sideOf(zoom, d)
  const hx = s / (2 * d.w)
  const hy = s / (2 * d.h)
  return {
    zoom,
    cx: clamp(finite(crop.cx, 0.5), hx, 1 - hx),
    cy: clamp(finite(crop.cy, 0.5), hy, 1 - hy)
  }
}

// -> integer { sx, sy, size }, always inside the image, size >= 1.
export function cropRect (crop, src) {
  const d = dims(src)
  if (!d) return { sx: 0, sy: 0, size: 1 }
  const c = clampCrop(crop, src)
  const size = clamp(Math.round(sideOf(c.zoom, d)), 1, Math.min(d.w, d.h))
  return {
    sx: clamp(Math.round(c.cx * d.w - size / 2), 0, d.w - size),
    sy: clamp(Math.round(c.cy * d.h - size / 2), 0, d.h - size),
    size
  }
}

// Where the whole image sits inside a square viewport of side `view`, so the
// viewport shows exactly cropRect (the preview is what is exported).
export function displayRect (crop, src, view) {
  const d = dims(src)
  if (!d || !(typeof view === 'number' && Number.isFinite(view) && view > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const { sx, sy, size } = cropRect(crop, src)
  const scale = view / size
  return { left: -sx * scale, top: -sy * scale, width: d.w * scale, height: d.h * scale }
}

// dx, dy in view pixels: the photo follows the finger, so dragging right
// shows more of the left.
export function panBy (crop, dx, dy, src, view) {
  const c = clampCrop(crop, src)
  const d = dims(src)
  if (!d || !(typeof view === 'number' && Number.isFinite(view) && view > 0)) return c
  const k = sideOf(c.zoom, d) / view
  return clampCrop({
    zoom: c.zoom,
    cx: c.cx - (finite(dx, 0) * k) / d.w,
    cy: c.cy - (finite(dy, 0) * k) / d.h
  }, src)
}

export function zoomBy (crop, factor, src) {
  const c = clampCrop(crop, src)
  const f = finite(factor, 1)
  if (!(f > 0)) return c
  return clampCrop({ zoom: c.zoom * f, cx: c.cx, cy: c.cy }, src)
}

// How the photo moves; the crop center moves the opposite way.
const DIRECTIONS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

export function nudge (crop, direction, src) {
  const c = clampCrop(crop, src)
  const d = dims(src)
  if (!d || !Object.hasOwn(DIRECTIONS, direction)) return c
  const [x, y] = DIRECTIONS[direction]
  const step = MOVE_STEP * sideOf(c.zoom, d)
  return clampCrop({ zoom: c.zoom, cx: c.cx - (x * step) / d.w, cy: c.cy - (y * step) / d.h }, src)
}

// Integer 100..400.
export function zoomPercent (crop) {
  const zoom = crop && typeof crop === 'object' ? finite(crop.zoom, MIN_ZOOM) : MIN_ZOOM
  return Math.round(clamp(zoom, MIN_ZOOM, MAX_ZOOM) * 100)
}

// Each direction flag means the photo can still move that way, so right is
// off once the exported square touches the image's left edge. The edges
// follow cropRect, so a flag is off exactly when nudge cannot move.
export function limitsOf (crop, src) {
  const d = dims(src)
  if (!d) return { zoomIn: false, zoomOut: false, left: false, right: false, up: false, down: false }
  const c = clampCrop(crop, src)
  const { sx, sy, size } = cropRect(c, src)
  return {
    zoomIn: c.zoom < MAX_ZOOM,
    zoomOut: c.zoom > MIN_ZOOM,
    left: sx + size < d.w,
    right: sx > 0,
    up: sy + size < d.h,
    down: sy > 0
  }
}
