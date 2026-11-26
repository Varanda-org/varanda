// Rows carry media arrays. Empty rows still count toward the lookahead window.
// Only still images are planned: a clip is never fetched before a tap
// (ui/MediaGrid.js). lastVisible is the last row on screen (null or -1 when
// none is yet); a bad count falls back to its default.
const count = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback)

export function planPrefetch ({ rows, lastVisible, ahead = 6, max = 8 }) {
  const plan = []
  if (!Array.isArray(rows)) return plan
  const seen = new Set()
  const last = Number.isFinite(lastVisible) ? Math.floor(lastVisible) : -1
  const start = Math.max(0, last + 1)
  const end = Math.min(rows.length, start + count(ahead, 6))
  const limit = count(max, 8)
  for (let i = start; i < end && plan.length < limit; i++) {
    for (const descriptor of rows[i]?.media || []) {
      if (!descriptor || typeof descriptor.mime !== 'string' || !descriptor.mime.startsWith('image/')) continue
      // Descriptor fields are scalars; property insertion order is immaterial.
      const key = JSON.stringify(Object.keys(descriptor).sort().map(key => [key, descriptor[key]]))
      if (seen.has(key)) continue
      seen.add(key)
      plan.push(descriptor)
      if (plan.length >= limit) break
    }
  }
  return plan
}
