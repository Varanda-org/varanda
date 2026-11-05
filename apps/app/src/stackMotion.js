// Plans for the screen-stack transition. Pure, so the screens and the tests
// share one set of numbers and this module loads without React. X is a
// fraction of the width: the width exists only once the screen has laid out,
// and a plan in pixels would be wrong on the next device.

export const STACK_MS = 250
// A slow drag has to cross this fraction of the width. A short flick still
// means "go back" once it is faster than SWIPE_VX. Resting on the line does
// not commit: the comparisons are strict.
export const SWIPE_FRACTION = 0.35
export const SWIPE_VX = 0.5
// A drag that starts over the content belongs to whatever scrolls there.
// Only one that starts on the left edge pops the stack.
export const EDGE_PX = 24

// Reduce motion keeps the direction and drops the time, so the screen still
// ends where a full slide would, just without moving.
export function pushPlan (reduceMotion) {
  return { duration: reduceMotion ? 0 : STACK_MS, fromX: 1, toX: 0 }
}

export function popPlan (reduceMotion) {
  return { duration: reduceMotion ? 0 : STACK_MS, fromX: 0, toX: 1 }
}

export function swipeVerdict (gesture) {
  const { dx, vx, width } = gesture || {}
  if (dx > width * SWIPE_FRACTION || vx > SWIPE_VX) return 'pop'
  return 'cancel'
}

// A negative x is left of the layer, so it never counts as the edge.
export function edgeStart (x) {
  return x >= 0 && x <= EDGE_PX
}

// The drag must start inside the layer's own left edge (startX and pageLeft
// are page coordinates), head right and be mostly horizontal, so a drag that
// starts over the content stays with the list or the carousel under it.
export function claimSwipe (gesture) {
  const { startX, pageLeft, dx, dy } = gesture || {}
  if (!Number.isFinite(startX) || !Number.isFinite(dx) || !Number.isFinite(dy)) return false
  const rel = startX - (Number.isFinite(pageLeft) ? pageLeft : 0)
  if (!(rel >= 0) || !edgeStart(rel)) return false
  return dx > 8 && Math.abs(dx) > Math.abs(dy) * 1.5
}

function isPrefix (short, long) {
  if (short.length > long.length) return false
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false
  return true
}

function sameScreen (a, b) {
  return !!a && !!b && a.screen === b.screen && a.key === b.key
}

// What a stack change means for the slide. A shorter prefix is a pop (the
// old top leaves from its old index); a longer stack that keeps the old one
// as its prefix is a push. A push past the stack's depth limit drops the
// oldest entry, so the stack keeps its length with a new top: that is a push
// too, and the dropped bottom entry just unmounts. Anything else (a reset
// to a different stack) changes without a slide.
export function stackChange (prev, next) {
  const before = Array.isArray(prev) ? prev : []
  const after = Array.isArray(next) ? next : []
  if (after.length < before.length && isPrefix(after, before)) {
    return { kind: 'pop', entry: before[before.length - 1], index: before.length - 1 }
  }
  if (after.length > before.length && isPrefix(before, after)) {
    return { kind: 'push', entry: after[after.length - 1] }
  }
  if (after.length > 0 && after.length === before.length) {
    const top = after[after.length - 1]
    const was = before[before.length - 1]
    if (!sameScreen(top, was) && isPrefix(after.slice(0, -1), before.slice(1))) {
      return { kind: 'push', entry: top }
    }
  }
  return { kind: 'none' }
}
