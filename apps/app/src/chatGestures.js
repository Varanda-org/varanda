export function swipePlan (dx, dy, startX) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(startX) || startX < 24 || dx <= 8 || Math.abs(dx) < 2 * Math.abs(dy)) return 'ignore'
  return dx >= 56 ? 'reply' : 'track'
}
