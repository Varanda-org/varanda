// Regional welcome choreography, kept pure so a test can pin it.
// Motifs and the three header lines arrive once. Nothing repeats:
// the card keeps its own fade, and a preference that never answers
// shows the finished scene instead of a blank header.

export const WELCOME_BEZIER = Object.freeze([0.22, 1, 0.36, 1])
export const MOTIF_MS = 720
export const MOTIF_DELAY_MS = 80
export const MAX_MOTIFS = 9
export const WELCOME_MS = 1500
// Lands when the card fade (420 ms) has finished.
export const HAPTIC_MS = 420
// A preference query that never answers must not leave the header invisible.
export const PREF_WAIT_MS = 300

function frozenMotion (from, mirror, stagger) {
  return Object.freeze({
    from: Object.freeze(from),
    mirror,
    stagger
  })
}

// How motifs arrive. Norte rises, nordeste swings in, centro-oeste falls
// aslant, sudeste pops in place, sul blows in from the side.
export const REGION_MOTION = Object.freeze({
  norte: frozenMotion({ translateX: 12, translateY: 48, scale: 0.8, rotate: 0 }, true, 70),
  nordeste: frozenMotion({ translateX: 0, translateY: -56, scale: 1, rotate: 14 }, true, 60),
  'centro-oeste': frozenMotion({ translateX: -24, translateY: -64, scale: 0.7, rotate: -20 }, false, 80),
  sudeste: frozenMotion({ translateX: 0, translateY: 0, scale: 0.2, rotate: 0 }, false, 50),
  sul: frozenMotion({ translateX: 64, translateY: 0, scale: 0.9, rotate: 8 }, false, 70)
})

export const NEUTRAL_MOTION = frozenMotion(
  { translateX: 0, translateY: 16, scale: 1, rotate: 0 },
  false,
  70
)

const REST = Object.freeze({ opacity: 1, translateX: 0, translateY: 0, scale: 1, rotate: 0 })

function motifOrder (order) {
  if (!Number.isInteger(order) || order <= 0) return 0
  return order >= MAX_MOTIFS ? MAX_MOTIFS - 1 : order
}

export function motifMotion (region, order, side, reduced) {
  const entry = Object.hasOwn(REGION_MOTION, region) ? REGION_MOTION[region] : NEUTRAL_MOTION
  const index = motifOrder(order)
  const sign = entry.mirror && side < 0 ? -1 : 1
  const to = { ...REST }
  if (reduced === true) return { delay: 0, duration: 0, from: { ...to }, to }
  return {
    delay: MOTIF_DELAY_MS + index * entry.stagger,
    duration: MOTIF_MS,
    // * sign + 0 collapses -0, which would fail a deep equality check.
    from: {
      opacity: 0,
      translateX: entry.from.translateX * sign + 0,
      translateY: entry.from.translateY,
      scale: entry.from.scale,
      rotate: entry.from.rotate * sign + 0
    },
    to
  }
}

const TEXT_FROM = Object.freeze({ opacity: 0, translateY: 10 })
const TEXT_TO = Object.freeze({ opacity: 1, translateY: 0 })

function textBeat (delay, duration, reduced) {
  const to = { ...TEXT_TO }
  if (reduced === true) return { delay: 0, duration: 0, from: { ...to }, to }
  return { delay, duration, from: { ...TEXT_FROM }, to }
}

export function welcomeMotion (reduced) {
  const still = reduced === true
  return {
    tag: textBeat(120, 360, reduced),
    title: textBeat(220, 420, reduced),
    line: textBeat(380, 420, reduced),
    hapticAt: still ? null : HAPTIC_MS
  }
}

// Only an explicit false from a query that succeeded allows motion.
export function motionPref (value, failed) {
  return failed !== true && value === false ? 'allow' : 'reduce'
}

export function welcomeStep ({ pref, measured, phase, waited } = {}) {
  if (pref === 'reduce' && phase !== 'done') return 'settle'
  if (pref === 'unknown' && waited === true && phase !== 'done') return 'settle'
  if (pref === 'allow' && measured === true && phase === 'idle') return 'play'
  return 'none'
}

export function createEntrance ({ query, subscribe, setTimer, clearTimer, play, settle, haptic }) {
  let pref = 'unknown'
  let measured = false
  let phase = 'idle'
  let waited = false
  let disposed = false
  // A change event is newer than the in-flight read, so a late answer must not overwrite it.
  let eventWon = false
  let didSettle = false
  let played = false
  let unsubscribe = null
  let waitOn = false
  let waitHandle = null
  let hapticOn = false
  let hapticHandle = null

  function clearHaptic () {
    if (!hapticOn) return
    hapticOn = false
    clearTimer(hapticHandle)
    hapticHandle = null
  }

  function clearWait () {
    if (!waitOn) return
    waitOn = false
    clearTimer(waitHandle)
    waitHandle = null
  }

  function apply () {
    if (disposed) return
    const action = welcomeStep({ pref, measured, phase, waited })
    if (action === 'play') {
      // Phase flips before the outside call so a re-entrant input cannot start a second entrance.
      if (played) return
      played = true
      phase = 'playing'
      hapticOn = true
      hapticHandle = setTimer(() => {
        hapticOn = false
        hapticHandle = null
        if (disposed || didSettle) return
        haptic()
      }, HAPTIC_MS)
      if (disposed || didSettle) return
      play((finished) => {
        if (disposed) return
        if (finished === true) phase = 'done'
      })
      return
    }
    if (action === 'settle') {
      phase = 'done'
      didSettle = true
      clearHaptic()
      if (disposed) return
      settle()
    }
  }

  function onQuery (value, failed) {
    if (disposed || eventWon) return
    pref = motionPref(value, failed)
    apply()
  }

  function onEvent (value) {
    if (disposed) return
    eventWon = true
    pref = motionPref(value, false)
    apply()
  }

  try {
    const pending = query()
    pending.then(
      (value) => onQuery(value, false),
      () => onQuery(undefined, true)
    )
  } catch {
    onQuery(undefined, true)
  }

  if (!disposed) {
    try {
      unsubscribe = subscribe(onEvent)
    } catch {
      unsubscribe = null
    }
  }

  // subscribe can settle (and dispose) before it returns the unsubscribe function.
  if (disposed) {
    if (typeof unsubscribe === 'function') {
      const off = unsubscribe
      unsubscribe = null
      off()
    }
  } else {
    waitOn = true
    waitHandle = setTimer(() => {
      waitOn = false
      waitHandle = null
      if (disposed) return
      waited = true
      apply()
    }, PREF_WAIT_MS)
  }

  return {
    measure (bool) {
      if (disposed) return
      measured = bool === true
      apply()
    },
    dispose () {
      if (disposed) return
      disposed = true
      clearWait()
      clearHaptic()
      const off = unsubscribe
      unsubscribe = null
      if (typeof off === 'function') off()
    }
  }
}
