// Lifetime rules for a provider player frame that loads by itself in a list.
// A card loads its frame once it has been in the band, or near it (up to
// EMBED_AHEAD_BANDS band heights ahead or behind), on two checks in a row, so
// the player is ready before the person reaches it. A loaded frame is kept
// for as long as its screen is the one being looked at: coming back to its
// card must find the same provider page, mid-track, instead of a fresh load,
// however far or long the person scrolled. A list draws its frames in one
// layer of its own (./ui/EmbedLayer), so the frame outlives a row the list
// unmounts. At most EMBED_LIVE_MAX frames load app-wide, a cap that shrink
// lowers, never under EMBED_LIVE_MIN, when the system reclaims a frame's
// content process. The app cannot see play or pause inside a cross-origin
// frame, so it treats a frame the person touched (engaged) as playing: such a
// frame never yields to a preload, and yields to a visible card only when no
// untouched frame is parked. Only a frame found out of the band on two checks
// in a row may yield, because a measurement that has not answered by the next
// tick counts as hidden, and one late answer must not cost a playing frame
// its slot. The inline feed video shares the visibility rule and timing
// constants.

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
export const EMBED_LIVE_MAX = 4
export const EMBED_LIVE_MIN = 2
export const EMBED_AHEAD_BANDS = 2
// A preload asks a parked frame to yield only when that frame is this much
// farther from the band, so two near cards whose distances barely differ do
// not take turns loading.
export const EMBED_YIELD_GAP = 400
export const EMBED_SHRINK_MS = 5000

// Distance in pt between a slot and the band, 0 when they meet. A slot that
// cannot be measured, or that is mostly out sideways (the seenW rule of
// mostlyHidden), is never near.
export function bandGap (x, y, w, h, top, bottom, width) {
  if (![x, y, w, h, top, bottom, width].every(Number.isFinite) || !(w > 0) || !(h > 0)) return Infinity
  const seenW = Math.max(0, Math.min(x + w, width) - Math.max(x, 0))
  if (seenW * 2 < w) return Infinity
  if (y + h < top) return top - (y + h)
  if (y > bottom) return y - bottom
  return 0
}

export function embedNear (gap, top, bottom) {
  return Number.isFinite(gap) && gap <= EMBED_AHEAD_BANDS * (bottom - top)
}

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
    if (sample.hidden === true && sample.near !== true) return EMBED_IDLE
    const seen = Math.min(state.seen + 1, EMBED_DWELL_TICKS)
    if (seen < EMBED_DWELL_TICKS) return Object.freeze({ live: false, seen })
    return sample.free === true ? EMBED_LIVE : EMBED_WAITING
  } catch {
    return EMBED_IDLE
  }
}

// Each card ticks on its own timer, so a newcomer that removed another holder
// at once could close a player that scrolled back into view after its last
// check. acquire only marks one parked holder as wanted, with the gap of the
// card that asked (0 for a visible card); that holder decides on its own
// fresh check whether it still yields, and yielding re-checks the request
// against the holder's fresh distance, passed by that check, and its
// engagement at that moment, since either may have changed since the mark.
// The farthest untouched holder is asked first. A screen reader can start
// playback without a touch, so while one runs, or has not answered yet
// (readerTouch, read by the caller at each call), every holder counts as
// touched: a preload marks nobody, and a visible card asks the holder parked
// first. A preload (gap > 0) asks only an untouched holder at least
// EMBED_YIELD_GAP farther away, and takes at most one new slot per tick, so a
// fling does not load a burst of frames at once; a visible card is never
// held back. A release frees a slot, so it clears every request: a newcomer
// that still needs one asks again on its next tick, and no holder yields
// while a slot stands free. shrink lowers the cap without closing anything:
// the pool drains to it as holders release.
export function createEmbedSlots (max = EMBED_LIVE_MAX) {
  const holders = new Map()
  let order = 0
  let lastPreload = -Infinity
  let lastShrink = -Infinity
  const count = () => holders.size
  const preloadOf = (gap) => (gap > 0 ? gap : 0)
  const untouched = (holder, readerTouch) => readerTouch !== true && holder.engaged === false
  const eligible = (holder, gap, readerTouch) => {
    if (!(holder.since > 0)) return false
    if (gap > 0) return untouched(holder, readerTouch) && holder.gap > gap + EMBED_YIELD_GAP
    if (untouched(holder, readerTouch)) return true
    for (const other of holders.values()) {
      if (other.since > 0 && untouched(other, readerTouch)) return false
    }
    return true
  }
  const pick = (gap, readerTouch) => {
    let best = null
    for (const holder of holders.values()) {
      if (!(holder.since > 0) || !untouched(holder, readerTouch)) continue
      if (gap > 0 && !(holder.gap > gap + EMBED_YIELD_GAP)) continue
      if (best === null || holder.gap > best.gap || (holder.gap === best.gap && holder.since < best.since)) best = holder
    }
    if (best !== null || gap > 0) return best
    for (const holder of holders.values()) {
      if (holder.since > 0 && (best === null || holder.since < best.since)) best = holder
    }
    return best
  }
  const park = (release, parked, gap) => {
    const holder = holders.get(release)
    if (holder === undefined) return
    if (parked === true) {
      if (holder.since === 0) holder.since = ++order
      holder.gap = Number.isFinite(gap) ? gap : Infinity
    } else {
      holder.since = 0
      holder.wanted = false
      holder.gap = 0
    }
  }
  // gap is the holder's distance on the check that asks, stored before the
  // re-check; with none, the distance it last parked with stands.
  const yielding = (release, gap, readerTouch) => {
    const holder = holders.get(release)
    if (holder === undefined) return false
    if (holder.since > 0 && typeof gap === 'number') holder.gap = Number.isFinite(gap) ? gap : Infinity
    return holder.wanted === true && eligible(holder, holder.wantGap, readerTouch)
  }
  const free = (gap = 0, readerTouch) => count() < max || pick(preloadOf(gap), readerTouch) !== null
  const acquire = (gap = 0, now, readerTouch) => {
    const want = preloadOf(gap)
    if (want > 0 && Number.isFinite(now) && now - lastPreload < EMBED_TICK_MS) return null
    if (count() < max) {
      const release = () => {
        if (!holders.delete(release)) return
        for (const holder of holders.values()) holder.wanted = false
      }
      holders.set(release, { since: 0, wanted: false, wantGap: 0, gap: 0, engaged: false, mark: null })
      if (want > 0 && Number.isFinite(now)) lastPreload = now
      return release
    }
    const holder = pick(want, readerTouch)
    if (holder !== null) {
      // A visible request is the looser one, so it wins over a preload's mark.
      holder.wantGap = holder.wanted === true ? Math.min(holder.wantGap, want) : want
      holder.wanted = true
    }
    return null
  }
  // A waiting card holds no handle to its own request, so it clears them
  // all: a card still waiting asks again on its next tick, as a release
  // already relies on.
  const withdraw = () => {
    for (const holder of holders.values()) holder.wanted = false
  }
  // mark is the app's playback claim count at the touch, so the card can tell
  // a claim made before the touch from one made after it.
  const engage = (release, on = true, mark) => {
    const holder = holders.get(release)
    if (holder === undefined) return
    holder.engaged = on === true
    holder.mark = holder.engaged && Number.isFinite(mark) ? mark : null
  }
  const engaged = (release) => {
    const holder = holders.get(release)
    return holder !== undefined && holder.engaged === true
  }
  const engagedAt = (release) => {
    const holder = holders.get(release)
    return holder !== undefined && holder.engaged === true && Number.isFinite(holder.mark) ? holder.mark : null
  }
  const engagedCount = () => {
    let n = 0
    for (const holder of holders.values()) if (holder.engaged === true) n++
    return n
  }
  const limit = () => max
  const shrink = (now) => {
    if (Number.isFinite(now) && now - lastShrink < EMBED_SHRINK_MS) return max
    if (max > EMBED_LIVE_MIN) {
      max--
      if (Number.isFinite(now)) lastShrink = now
    }
    return max
  }
  return { acquire, park, yielding, free, count, withdraw, engage, engaged, engagedAt, engagedCount, limit, shrink }
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

export function embedsHeldAll () {
  return allHolds > 0
}

// A frame nobody is looking at stays loaded only while untouched and the
// device unlocked; a touched one may be playing, so it goes.
export function embedStays (touched, locked) {
  return touched === false && locked === false
}

// A screen reader activates a control without raising a touch, and can be
// turned on after the frame loaded, so an unknown or running reader counts
// as a touch.
export function embedTouched (engaged, readerOn, readerKnown) {
  return engaged === true || readerOn === true || readerKnown !== true
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
