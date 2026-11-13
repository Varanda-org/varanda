export function swipePlan (dx, dy, startX) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(startX) || startX < 24 || dx <= 8 || Math.abs(dx) < 2 * Math.abs(dy)) return 'ignore'
  return dx >= 56 ? 'reply' : 'track'
}

export function jumpVisible ({ distanceFromEnd, viewport }) {
  return Number.isFinite(distanceFromEnd) && Number.isFinite(viewport) && viewport > 0 && distanceFromEnd > 1.5 * viewport
}

export function awayCount (rows, lastSeenKey) {
  if (lastSeenKey === null || lastSeenKey === undefined) return 0
  const index = rows.findIndex((row) => row.key === lastSeenKey)
  return index < 0 ? 0 : rows.length - index - 1
}
