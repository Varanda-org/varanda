// Lifetime rules for a provider player frame that loads when its card is seen.
// A loaded frame is kept for as long as its screen is the one being looked
// at: coming back to its card must find the same provider page, mid-track,
// instead of a fresh load, however far or long the person scrolled. A list
// draws its frames in one layer of its own (./ui/EmbedLayer), so the frame
// outlives a row the list unmounts. The app cannot see play or pause inside
// a cross-origin frame, so a frame in the band never yields to a newcomer;
// only a frame found out of the band on two checks in a row may, because a
// measurement that has not answered by the next tick counts as hidden, and
// one late answer must not cost a playing frame its slot. The inline feed
// video shares the visibility rule and timing constants.

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
// be measured counts as hidden, so an inline feed video whose row left the
// screen never keeps playing.
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
export const EMBED_AWAY_TICKS = 2
export const EMBED_AWAY = Object.freeze({ live: true, seen: EMBED_DWELL_TICKS, away: 1 })
export const EMBED_PARKED = Object.freeze({ live: true, seen: EMBED_DWELL_TICKS, away: EMBED_AWAY_TICKS })
export const EMBED_WAITING = Object.freeze({ live: false, seen: EMBED_DWELL_TICKS })

export function embedStep (state, sample) {
  try {
    if (!state || typeof state !== 'object' || typeof state.live !== 'boolean' || !Number.isFinite(state.seen)) state = EMBED_IDLE
    if (!sample || typeof sample !== 'object') return EMBED_IDLE
    if (sample.allowed !== true) return EMBED_IDLE
    // A turned window clears the away count: a card that is not live re-bases
    // to the turned window and could otherwise take the slot of a full-screen
    // player that was under half visible when it was opened.
    if (state.live && sample.turned === true) return state.away > 0 ? EMBED_LIVE : state
    if (sample.turned === true) return EMBED_IDLE
    // An invalid sample cannot keep a frame.
    if (sample.hidden !== true && sample.hidden !== false) return EMBED_IDLE
    if (state.live) {
      if (sample.hidden === false) return state.away > 0 ? EMBED_LIVE : state
      return state.away >= 1 ? EMBED_PARKED : EMBED_AWAY
    }
    if (sample.hidden === true) return EMBED_IDLE
    const seen = Math.min(state.seen + 1, EMBED_DWELL_TICKS)
    if (seen < EMBED_DWELL_TICKS) return Object.freeze({ live: false, seen })
    return sample.free === true ? EMBED_LIVE : EMBED_WAITING
  } catch {
    return EMBED_IDLE
  }
}

// Each card ticks on its own timer, so a newcomer that removed another holder
// at once could close a player that scrolled back into view after its last
// check. acquire only marks the longest-parked holder as wanted; that card
// decides on its own fresh check whether it still yields. A release frees a
// slot, so it clears every request: a newcomer that still needs one asks
// again on its next tick, and no holder yields while a slot stands free.
export function createEmbedSlots (max = EMBED_LIVE_MAX) {
  const holders = new Map()
  let order = 0
  const count = () => holders.size
  const park = (release, parked) => {
    const holder = holders.get(release)
    if (holder === undefined) return
    if (parked === true) {
      if (holder.since === 0) holder.since = ++order
    } else {
      holder.since = 0
      holder.wanted = false
    }
  }
  const yielding = (release) => {
    const holder = holders.get(release)
    return holder !== undefined && holder.wanted === true
  }
  const free = () => {
    if (count() < max) return true
    for (const holder of holders.values()) if (holder.since > 0) return true
    return false
  }
  const acquire = () => {
    if (count() < max) {
      const release = () => {
        if (!holders.delete(release)) return
        for (const holder of holders.values()) holder.wanted = false
      }
      holders.set(release, { since: 0, wanted: false })
      return release
    }
    let oldest = null
    for (const holder of holders.values()) {
      if (holder.since > 0 && (oldest === null || holder.since < oldest.since)) oldest = holder
    }
    if (oldest !== null) oldest.wanted = true
    return null
  }
  // A waiting card holds no handle to its own request, so it clears them
  // all: a card still waiting asks again on its next tick, as a release
  // already relies on.
  const withdraw = () => {
    for (const holder of holders.values()) holder.wanted = false
  }
  return { acquire, park, yielding, free, count, withdraw }
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
