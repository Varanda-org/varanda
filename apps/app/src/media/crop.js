// Pure crop math for the avatar editor and the post framing step.
// A crop is { zoom, cx, cy }: the zoom over the largest frame of the chosen
// ratio that fits the image, and its center normalized to the image size.
// The ratio defaults to 1 for avatars. The controls move the photo, so the
// crop center moves in the opposite direction.

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
export const ZOOM_STEP = 1.25
// A fraction of the visible width or height.
export const MOVE_STEP = 0.1

export function initialCrop () {
  return { zoom: 1, cx: 0.5, cy: 0.5 }
}

// Integer image size (the frozen canvas is integer anyway), or null.
function dims (src) {
  if (!src || typeof src !== 'object') return null
  let w, h
  try {
    w = Math.floor(src.width)
    h = Math.floor(src.height)
  } catch {
    return null
  }
  if (!(Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1)) return null
  return { w, h }
}

function clamp (n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function finite (n, fallback) {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function ratioOf (ratio) {
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
}

function widthOf (zoom, d, ratio) {
  return Math.min(d.w, d.h * ratio) / zoom
}

function heightOf (zoom, d, ratio) {
  return Math.min(d.h, d.w / ratio) / zoom
}

function clampToFrame (crop, d, ratio) {
  if (!d || !crop || typeof crop !== 'object') return initialCrop()
  const zoom = clamp(finite(crop.zoom, MIN_ZOOM), MIN_ZOOM, MAX_ZOOM)
  const hx = widthOf(zoom, d, ratio) / (2 * d.w)
  const hy = heightOf(zoom, d, ratio) / (2 * d.h)
  return {
    zoom,
    cx: clamp(finite(crop.cx, 0.5), hx, 1 - hx),
    cy: clamp(finite(crop.cy, 0.5), hy, 1 - hy)
  }
}

export function clampCrop (crop, src, ratio) {
  return clampToFrame(crop, dims(src), ratioOf(ratio))
}

// -> integer { sx, sy, size }, always inside the image, size >= 1.
export function cropRect (crop, src) {
  const d = dims(src)
  if (!d) return { sx: 0, sy: 0, size: 1 }
  const { sx, sy, sw } = frameOf(clampToFrame(crop, d, 1), d, 1)
  return { sx, sy, size: sw }
}

function frameOf (crop, d, ratio) {
  const vw = widthOf(crop.zoom, d, ratio)
  const vh = heightOf(crop.zoom, d, ratio)
  const sw = clamp(Math.round(vw), 1, d.w)
  const sh = clamp(Math.round(sw / ratio), 1, d.h)
  let sy = clamp(Math.round(crop.cy * d.h - sh / 2), 0, d.h - sh)
  // Rounding both dimensions can shorten the frame enough to miss an edge.
  const hy = vh / (2 * d.h)
  if (ratio !== 1 && hy < 0.5) {
    if (crop.cy === hy) sy = 0
    if (crop.cy === 1 - hy) sy = d.h - sh
  }
  return { sx: clamp(Math.round(crop.cx * d.w - sw / 2), 0, d.w - sw), sy, sw, sh }
}

export function frameRect (crop, src, ratio) {
  const d = dims(src)
  if (!d || !crop || typeof crop !== 'object') return { sx: 0, sy: 0, sw: 1, sh: 1 }
  const r = ratioOf(ratio)
  return frameOf(clampToFrame(crop, d, r), d, r)
}

// The preview uses the pixel-snapped frame and the viewport width.
export function displayRect (crop, src, view, ratio) {
  const d = dims(src)
  if (!d || !(typeof view === 'number' && Number.isFinite(view) && view > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const r = ratioOf(ratio)
  const { sx, sy, sw } = frameOf(clampToFrame(crop, d, r), d, r)
  const scale = view / sw
  return { left: -sx * scale, top: -sy * scale, width: d.w * scale, height: d.h * scale }
}

// dx, dy in view pixels: the photo follows the finger, so dragging right
// shows more of the left.
export function panBy (crop, dx, dy, src, view, ratio) {
  const d = dims(src)
  const r = ratioOf(ratio)
  const c = clampToFrame(crop, d, r)
  if (!d || !(typeof view === 'number' && Number.isFinite(view) && view > 0)) return c
  const k = widthOf(c.zoom, d, r) / view
  return clampToFrame({
    zoom: c.zoom,
    cx: c.cx - (finite(dx, 0) * k) / d.w,
    cy: c.cy - (finite(dy, 0) * k) / d.h
  }, d, r)
}

export function zoomBy (crop, factor, src, ratio) {
  const d = dims(src)
  const r = ratioOf(ratio)
  const c = clampToFrame(crop, d, r)
  const f = finite(factor, 1)
  if (!(f > 0)) return c
  return clampToFrame({ zoom: c.zoom * f, cx: c.cx, cy: c.cy }, d, r)
}

// How the photo moves; the crop center moves the opposite way.
const DIRECTIONS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

export function nudge (crop, direction, src, ratio) {
  const d = dims(src)
  const r = ratioOf(ratio)
  const c = clampToFrame(crop, d, r)
  if (!d || typeof direction !== 'string' || !Object.hasOwn(DIRECTIONS, direction)) return c
  const [x, y] = DIRECTIONS[direction]
  const stepX = MOVE_STEP * widthOf(c.zoom, d, r)
  const stepY = MOVE_STEP * heightOf(c.zoom, d, r)
  return clampToFrame({ zoom: c.zoom, cx: c.cx - (x * stepX) / d.w, cy: c.cy - (y * stepY) / d.h }, d, r)
}

// Integer 100..400.
export function zoomPercent (crop) {
  const zoom = crop && typeof crop === 'object' ? finite(crop.zoom, MIN_ZOOM) : MIN_ZOOM
  return Math.round(clamp(zoom, MIN_ZOOM, MAX_ZOOM) * 100)
}

// Each direction flag means the photo can still move that way, so right is
// off once the exported frame touches the image's left edge.
export function limitsOf (crop, src, ratio) {
  const d = dims(src)
  if (!d) return { zoomIn: false, zoomOut: false, left: false, right: false, up: false, down: false }
  const r = ratioOf(ratio)
  const c = clampToFrame(crop, d, r)
  const { sx, sy, sw, sh } = frameOf(c, d, r)
  const canMoveY = heightOf(c.zoom, d, r) < d.h
  return {
    zoomIn: c.zoom < MAX_ZOOM,
    zoomOut: c.zoom > MIN_ZOOM,
    left: sx + sw < d.w,
    right: sx > 0,
    up: canMoveY && sy + sh < d.h,
    down: canMoveY && sy > 0
  }
}

export function sameCrop (a, b) {
  return !!a && !!b && typeof a.zoom === 'number' && a.zoom === b.zoom &&
    typeof a.cx === 'number' && a.cx === b.cx && typeof a.cy === 'number' && a.cy === b.cy
}

export function isWholeRect (rect, src) {
  const d = dims(src)
  return !!d && !!rect && rect.sx === 0 && rect.sy === 0 && rect.sw === d.w && rect.sh === d.h
}
