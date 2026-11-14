// Zoom math for the photo viewers (src/ui/ZoomView.js). Pure, for the tests.
// Points are { x, y } in points; a pan is the photo's offset from the centre
// of its frame, applied before the scale, so a photo point p (from the
// centre) is drawn at pan + scale * p.

export const MIN_SCALE = 1
export const MAX_SCALE = 4
export const DOUBLE_TAP_SCALE = 2.5
// Below this a pinch has ended at scale 1, not a hair above it.
export const ZOOM_EPSILON = 0.01
export const DISMISS_DISTANCE = 120
// Points per millisecond, the unit PanResponder reports.
export const DISMISS_FLING = 1
// A fling shorter than this is a jitter at the end of a tap.
export const DISMISS_FLING_MIN = 24
export const PAN_SLOP = 8
export const TAP_SLOP = 10
export const DOUBLE_TAP_SLOP = 40
// A downward drag closes only when it is clearly more vertical than
// sideways; anything flatter belongs to the pager.
export const VERTICAL_RATIO = 1.5

const finite = (n) => typeof n === 'number' && Number.isFinite(n)

export function clampScale (scale) {
  if (!finite(scale)) return MIN_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function isZoomed (scale) {
  return finite(scale) && scale > MIN_SCALE + ZOOM_EPSILON
}

export function touchDistance (a, b) {
  if (!a || !b || !finite(a.x) || !finite(a.y) || !finite(b.x) || !finite(b.y)) return 0
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function touchFocal (a, b) {
  if (!a || !b || !finite(a.x) || !finite(a.y) || !finite(b.x) || !finite(b.y)) return null
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

// A pinch scales by how far the fingers moved apart since they landed, from
// the scale the photo had then, so a second pinch continues the first.
export function pinchScale (startDistance, distance, startScale) {
  if (!finite(startDistance) || startDistance <= 0 || !finite(distance) || distance < 0) return clampScale(startScale)
  return clampScale(clampScale(startScale) * distance / startDistance)
}

// The box a 'contain' photo of this ratio (width / height) fills in the
// frame. Without a usable ratio the photo is taken to fill the frame.
export function fitSize (frame, ratio) {
  const width = frame && finite(frame.width) && frame.width > 0 ? frame.width : 0
  const height = frame && finite(frame.height) && frame.height > 0 ? frame.height : 0
  if (!width || !height || !finite(ratio) || ratio <= 0) return { width, height }
  if (width / height > ratio) return { width: height * ratio, height }
  return { width, height: width / ratio }
}

// How far the photo may move from the centre on each axis before an edge of
// the scaled photo would come inside the frame. A side that still fits in the
// frame stays centred.
export function panBounds ({ scale, frame, content } = {}) {
  const s = clampScale(scale)
  const fw = frame && finite(frame.width) ? frame.width : 0
  const fh = frame && finite(frame.height) ? frame.height : 0
  const cw = content && finite(content.width) ? content.width : fw
  const ch = content && finite(content.height) ? content.height : fh
  return { x: Math.max(0, (s * cw - fw) / 2), y: Math.max(0, (s * ch - fh) / 2) }
}

// `|| 0` turns -0 and NaN into 0.
export function clampPan (pan, box) {
  const bounds = panBounds(box)
  const x = pan && finite(pan.x) ? pan.x : 0
  const y = pan && finite(pan.y) ? pan.y : 0
  return {
    x: Math.min(bounds.x, Math.max(-bounds.x, x)) || 0,
    y: Math.min(bounds.y, Math.max(-bounds.y, y)) || 0
  }
}

// The pan that keeps the photo point under the fingers (or the tap) under
// them at the new scale. Focals are from the centre of the frame. The result
// is not clamped.
export function focalPan ({ startPan, startScale, startFocal, focal, scale }) {
  const s0 = clampScale(startScale)
  const s = clampScale(scale)
  const p0 = { x: startPan && finite(startPan.x) ? startPan.x : 0, y: startPan && finite(startPan.y) ? startPan.y : 0 }
  const f0 = startFocal && finite(startFocal.x) && finite(startFocal.y) ? startFocal : { x: 0, y: 0 }
  const f = focal && finite(focal.x) && finite(focal.y) ? focal : f0
  return {
    x: f.x - (s * (f0.x - p0.x)) / s0,
    y: f.y - (s * (f0.y - p0.y)) / s0
  }
}

export function doubleTapTarget (scale) {
  return isZoomed(scale) ? MIN_SCALE : DOUBLE_TAP_SCALE
}

// Two taps belong together only when the second lands near the first.
export function nearTap (a, b) {
  if (!a || !b || !finite(a.x) || !finite(a.y) || !finite(b.x) || !finite(b.y)) return false
  return touchDistance(a, b) <= DOUBLE_TAP_SLOP
}

// dy and vy are downward positive. A zoomed photo never closes: its drag is a pan.
export function dismissVerdict ({ dy, vy, scale } = {}) {
  if (isZoomed(scale) || !finite(dy) || dy <= 0) return 'stay'
  if (dy >= DISMISS_DISTANCE) return 'close'
  if (finite(vy) && vy >= DISMISS_FLING && dy >= DISMISS_FLING_MIN) return 'close'
  return 'stay'
}

// Whether a moving touch belongs to the zoom view rather than the pager or
// the screen under it: two fingers and any move of a zoomed photo always do;
// at scale 1 only a clearly downward drag (drag to close) does, never a
// sideways one, which pages.
export function panClaim ({ dx, dy, scale, touches = 1 } = {}) {
  if (touches >= 2) return true
  if (isZoomed(scale)) return true
  if (!finite(dx) || !finite(dy)) return false
  return dy > PAN_SLOP && dy > VERTICAL_RATIO * Math.abs(dx)
}

// What a grant, or a change in the number of fingers, starts. A one-finger
// touch that a downward move won (moved, see panClaim) is already a drag to
// close at its grant, so the view can block the native pager from the first
// frame; a fresh touch at scale 1 can still be a tap, and a finger left over
// from a pinch is ignored.
export function gestureMode ({ touches, scale, fresh = false, moved = false, canDismiss = false } = {}) {
  if (!Number.isInteger(touches) || touches < 1) return 'none'
  if (touches >= 2) return 'pinch'
  if (isZoomed(scale)) return 'pan'
  if (moved) return canDismiss ? 'dismiss' : 'ignore'
  return fresh ? 'tap' : 'ignore'
}
