// Frame selection, paging and Portuguese counter strings for the photo carousel.
// Pure, so tests can load it on its own.

import { postFrame } from './media/frame.js'

// Use the first photo's frame for the whole strip so it stays steady as you swipe.
export function frameRatio (media) {
  return postFrame(media).ratio
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

export function counterShown ({ many, measured, idleMs, hold = 1600 }) {
  return Boolean(many && measured && idleMs < hold)
}

// The end is exclusive, so the window can be passed straight to slice.
export function dotWindow (index, count, max = 5) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(max) || max < 1) return { start: 0, end: 0 }
  const size = Math.min(count, max)
  const current = Number.isFinite(index) ? Math.min(count - 1, Math.max(0, Math.round(index))) : 0
  const start = Math.min(count - size, Math.max(0, current - Math.floor(size / 2)))
  return { start, end: start + size }
}

// The accessibility name the grid builds today, for example 'foto 2 de 4'.
export function slideLabel (index, count) {
  return 'foto ' + (index + 1) + ' de ' + count
}
