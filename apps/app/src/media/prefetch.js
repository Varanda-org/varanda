import { mediaKey } from './cache.js'
import { persistMode } from './keptLoad.js'
import { usableThumb } from './variant.js'

// Rows carry media arrays. Empty rows still count toward the lookahead window.
// Only usable thumbnails are planned, never full photos or clips.
// lastVisible is the last row on screen (null or -1 when none is yet);
// a bad count falls back to its default.
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
    const { media, thumbs } = rows[i] || {}
    if (!Array.isArray(media) || !Array.isArray(thumbs)) continue
    for (let index = 0; index < media.length; index++) {
      const descriptor = usableThumb(media, thumbs, index)
      if (descriptor === null) continue
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

// Each list owns its cancellations; the cache owns the shared two-slot lane.
export function createThumbnailPrefetch ({ cache, load, defer = setTimeout, cancelDefer = clearTimeout, mounted = { current: true } }) {
  const jobs = new Map()
  let planned = new Map()
  let timer = null
  let last = -1
  let currentRows = null
  let enabled = false
  let persistOf
  const stopTimer = () => {
    if (timer !== null) cancelDefer(timer)
    timer = null
  }
  const cancel = () => {
    stopTimer()
    for (const stop of jobs.values()) stop()
    jobs.clear()
    planned.clear()
    last = -1
  }
  const update = ({ rows, lastVisible, persistOf }) => {
    if (!mounted.current) return
    if (!Array.isArray(rows) || !Number.isInteger(lastVisible) || lastVisible < 0) {
      cancel()
      return
    }
    const upcoming = rows.slice(lastVisible + 1, lastVisible + 7)
    const next = new Map()
    for (const d of planPrefetch({ rows: upcoming, lastVisible: -1 })) {
      const row = upcoming.find(row => row?.thumbs?.includes(d))
      if (!row || typeof row.author !== 'string' || !/^[0-9a-f]{64}$/.test(row.author)) continue
      const policy = typeof persistOf === 'function' ? persistOf(row) : row.persist
      const persist = persistMode(policy)
      next.set(mediaKey(d), { author: row.author, d, persist })
    }
    const same = (a, b) => a && b && a.author === b.author && a.persist === b.persist
    const covered = () => [...planned.keys()].every(key => jobs.has(key))
    // A key the cache skipped (another list or a visible load had it) stays
    // uncovered, so an unchanged update retries it once nothing is pending.
    if (last === lastVisible && next.size === planned.size && [...next].every(([key, value]) => same(value, planned.get(key))) && (timer !== null || covered())) return
    for (const [key, stop] of jobs) {
      if (same(next.get(key), planned.get(key))) continue
      stop()
      jobs.delete(key)
    }
    planned = next
    last = lastVisible
    stopTimer()
    if (covered()) return
    timer = defer(() => {
      timer = null
      if (!mounted.current) return
      for (const [key, { author, d, persist }] of planned) {
        if (jobs.has(key)) continue
        const stop = cache.prefetch(key, load(author, d, persist))
        if (typeof stop === 'function') jobs.set(key, stop)
      }
    }, 150)
  }
  // Only a list that states its keep policy prefetches: loading with
  // persist false would put an unkept URL in the shared cache and stop a
  // followed author's thumbnail from being kept by later visible loads.
  const configure = (options) => {
    const on = options.enabled === true && typeof options.persistOf === 'function'
    if (currentRows !== options.rows || enabled !== on) cancel()
    currentRows = options.rows
    enabled = on
    persistOf = options.persistOf
    if (enabled) update({ rows: currentRows, lastVisible: last, persistOf })
  }
  const viewable = (info) => {
    if (!mounted.current || !enabled) return
    const lastVisible = Math.max(-1, ...info.viewableItems.filter(item => item.isViewable && Number.isInteger(item.index)).map(item => item.index))
    update({ rows: currentRows, lastVisible, persistOf })
  }
  return { update, cancel, configure, viewable }
}
