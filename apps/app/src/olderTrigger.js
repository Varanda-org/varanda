export const OLDER_ZONE = 200

export function olderInitial () {
  return { fired: false }
}

// The frame carries no dragging flag, so userScrolled (from onUserScroll)
// stands in for intent: the first layout of a short list must not load.
export function olderStep (state, { y, userScrolled, hasNext, loading, failed }) {
  const fired = Boolean(state && state.fired)
  if (!(y <= OLDER_ZONE)) return { state: { fired: false }, load: false }
  if (fired) return { state: { fired: true }, load: false }
  // Latched: a manual load that clears the error must not trigger one at once.
  if (failed) return { state: { fired: true }, load: false }
  if (!userScrolled || !hasNext || loading) {
    return { state: { fired: false }, load: false }
  }
  return { state: { fired: true }, load: true }
}
