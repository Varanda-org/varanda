// Lifetime rules for a provider player frame that loads when its card is seen.
// The app cannot see play or pause inside a cross-origin frame, so a loaded
// visible frame is never dropped for a newcomer. The inline feed video shares
// the visibility rule and timing constants.

export const VISIBILITY_MS = 500
// A just-tapped player may still be scrolling into view, so it is not closed
// in its first 2 s.
export const OPEN_GRACE_MS = 2000
// A tall player stays while a meaningful part of it shows.
export const SEEN_ENOUGH = 120

// Whether a slot at (x, y) of w by h has less than half of its width, or less
// than min(half of its height, SEEN_ENOUGH) pt of its height, inside the band
// from top to bottom and 0 to width. The band is where the list is
// seen: measureInWindow reports the slot unclipped, so a slot under the top
// bar or the tab bar would otherwise count as on screen. A slot that cannot
// be measured counts as hidden, so a player whose row left the screen never
// keeps playing.
export function mostlyHidden (x, y, w, h, top, bottom, width) {
  if (![x, y, w, h, top, bottom, width].every(Number.isFinite) || !(w > 0) || !(h > 0)) return true
  const seenW = Math.max(0, Math.min(x + w, width) - Math.max(x, 0))
  const seenH = Math.max(0, Math.min(y + h, bottom) - Math.max(y, top))
  return seenW * 2 < w || seenH < Math.min(h / 2, SEEN_ENOUGH)
}

export const EMBED_TICK_MS = VISIBILITY_MS
export const EMBED_DWELL_TICKS = 2
export const EMBED_LIVE_MAX = 2

export const EMBED_IDLE = Object.freeze({ live: false, seen: 0 })
export const EMBED_LIVE = Object.freeze({ live: true, seen: EMBED_DWELL_TICKS })

export function embedStep (state, sample) {
  try {
    if (!state || typeof state !== 'object' || typeof state.live !== 'boolean' || !Number.isFinite(state.seen)) state = EMBED_IDLE
    if (!sample || typeof sample !== 'object') return EMBED_IDLE
    if (sample.allowed !== true) return EMBED_IDLE
    if (state.live && sample.turned === true) return state
    if (sample.turned === true) return EMBED_IDLE
    if (sample.hidden !== false) return EMBED_IDLE
    if (state.live) return state
    const seen = Math.min(state.seen + 1, EMBED_DWELL_TICKS)
    return seen >= EMBED_DWELL_TICKS && sample.free === true ? EMBED_LIVE : Object.freeze({ live: false, seen })
  } catch {
    return EMBED_IDLE
  }
}

export function createEmbedSlots (max = EMBED_LIVE_MAX) {
  const holders = new Set()
  const count = () => holders.size
  const free = () => count() < max
  const acquire = () => {
    if (!free()) return null
    const holder = {}
    holders.add(holder)
    return () => { holders.delete(holder) }
  }
  return { acquire, free, count }
}

export const embedSlots = createEmbedSlots()

let layers = 0
let allHolds = 0
const listeners = new Set()

function notifyHolds () {
  for (const fn of [...listeners]) {
    try { fn() } catch {}
  }
}

export function holdEmbeds () {
  layers++
  notifyHolds()
  let done = false
  return () => {
    if (done) return
    done = true
    layers--
    notifyHolds()
  }
}

export function holdAllEmbeds () {
  allHolds++
  notifyHolds()
  let done = false
  return () => {
    if (done) return
    done = true
    allHolds--
    notifyHolds()
  }
}

export function embedsHeld (depth = 0) {
  if (!Number.isInteger(depth) || depth < 0) depth = 0
  return allHolds > 0 || layers > depth
}

export function onEmbedHold (fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
