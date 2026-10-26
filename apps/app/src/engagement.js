// Pure helpers for the optimistic like/repost state on screen. The own state
// is `{ liked: Set<ref>, reposted: Set<ref> }` (from engagement.read); index
// counts are `{ replies, likes, reposts, quotes }` or null when unknown.
// Every function returns new values and never mutates its inputs.

const FIELD = { like: 'liked', repost: 'reposted' }
const COUNT = { like: 'likes', repost: 'reposts' }

export function emptyState () {
  return { liked: new Set(), reposted: new Set() }
}

// From an engagement.read result `{ liked: [ref], reposted: [ref] }`.
export function fromRead (result) {
  const list = (v) => (Array.isArray(v) ? v.filter((r) => typeof r === 'string') : [])
  return { liked: new Set(list(result && result.liked)), reposted: new Set(list(result && result.reposted)) }
}

export function applyToggle (state, kind, ref, on) {
  const field = FIELD[kind]
  const base = state || emptyState()
  if (!field || typeof ref !== 'string') return base
  const set = new Set(base[field] || [])
  if (on) set.add(ref)
  else set.delete(ref)
  return { liked: field === 'liked' ? set : new Set(base.liked || []), reposted: field === 'reposted' ? set : new Set(base.reposted || []) }
}

// The counts with `delta` applied to likes or reposts, never below 0; null
// (unknown) stays null.
export function countsAfter (counts, kind, delta) {
  if (counts === null || counts === undefined) return null
  const field = COUNT[kind]
  if (!field || !Number.isSafeInteger(delta)) return counts
  const n = counts[field]
  if (!Number.isSafeInteger(n)) return counts
  return { ...counts, [field]: Math.max(0, n + delta) }
}

// A new Map ref -> counts with the fetched counts (a plain object or a Map,
// as from indexClient fetchCounts) taking precedence.
export function mergeCounts (map, fetched) {
  const out = new Map(map instanceof Map ? map : [])
  if (fetched instanceof Map) {
    for (const [ref, counts] of fetched) out.set(ref, counts)
  } else if (fetched && typeof fetched === 'object') {
    for (const ref of Object.keys(fetched)) out.set(ref, fetched[ref])
  }
  return out
}
