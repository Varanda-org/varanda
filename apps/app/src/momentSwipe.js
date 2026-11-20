export function momentSwipe ({ dx, dy }) {
  if (dy > 12 && dy > Math.abs(dx) * 1.5) return 'down'
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) return dx < 0 ? 'next' : 'prev'
  return null
}

// The grant resets dx and dy to 0, so a release counts only the movement after
// the capture: add back what the capture saw.
export function swipeTotal (from, { dx, dy, vy }) {
  return { dx: from.dx + dx, dy: from.dy + dy, vy }
}

// The release keeps the axis the drag was claimed on: a drag that starts
// downward and drifts sideways still closes on a flick, and one that starts
// sideways never closes.
export function swipeRelease (axis, { dx, dy, vy }, closeAt) {
  if (axis === 'down') return dy > closeAt || vy > 0.8 ? 'close' : null
  if (axis !== 'next' && axis !== 'prev') return null
  if (Math.abs(dx) <= 48) return null
  return dx < 0 ? 'next' : 'prev'
}
