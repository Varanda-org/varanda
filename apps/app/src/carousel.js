// Frame ratio, paging and the Portuguese counter strings for an Instagram-style
// photo carousel. Pure, so tests can load it on their own.

// 4:5 portrait through 1.91:1 landscape. Named so either bound is a one-line change.
export const FRAME_RATIO_MIN = 0.8
export const FRAME_RATIO_MAX = 1.91

// One ratio for the whole strip, from the first photo, held inside those bounds
// so the frame does not jump as you swipe.
export function frameRatio (media) {
  const photo = Array.isArray(media) ? media[0] : null
  if (!photo || typeof photo !== 'object') return 1
  const { width, height } = photo
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  return Math.min(FRAME_RATIO_MAX, Math.max(FRAME_RATIO_MIN, width / height))
}

// A resting scroll offset belongs to one page. Keep it inside the strip, and
// stay on page 0 when the width is not laid out yet (that division is NaN).
export function pageAt (offsetX, width, count) {
  if (!Number.isFinite(offsetX) || !Number.isFinite(width) || width <= 0) return 0
  if (!Number.isInteger(count) || count < 1) return 0
  return Math.min(count - 1, Math.max(0, Math.round(offsetX / width)))
}

// Scroll offset of a page. Anything that is not a real page stays at 0.
export function offsetOf (index, width) {
  if (!Number.isFinite(index) || !Number.isFinite(width) || width <= 0 || index < 0) return 0
  return index * width
}

// Move by delta and stop at the ends. The strip does not wrap.
export function stepIndex (index, delta, count) {
  if (!Number.isFinite(index) || !Number.isFinite(delta)) return 0
  if (!Number.isInteger(count) || count < 1) return 0
  return Math.min(count - 1, Math.max(0, index + delta))
}

// The open page and radius pages either side (one by default). Farther photos
// stay unmounted.
export function shouldMount (i, index, radius = 1) {
  return Math.abs(i - index) <= radius
}

// The viewer's count, the same '2 de 4' form the grid already shows.
export function counterText (index, count) {
  return (index + 1) + ' de ' + count
}

// The accessibility name the grid builds today, for example 'foto 2 de 4'.
export function slideLabel (index, count) {
  return 'foto ' + (index + 1) + ' de ' + count
}
