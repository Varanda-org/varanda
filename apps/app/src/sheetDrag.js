export function claimDrag ({ dx, dy }) {
  return Number.isFinite(dx) && Number.isFinite(dy) && dy > 8 && dy > Math.abs(dx) * 1.5
}

export function dragVerdict ({ dy, vy, height }) {
  if (!Number.isFinite(dy) || !Number.isFinite(vy) || !Number.isFinite(height) || height <= 0 || dy <= 8) return 'stay'
  return dy > height * 0.3 || vy > 0.8 ? 'close' : 'stay'
}
