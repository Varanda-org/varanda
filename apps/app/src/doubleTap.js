// Whether a tap on a post body is the second of a double tap (like) or a
// single one (open the conversation after the window). Pure, for the tests.

export const DOUBLE_TAP_MS = 280

export function tapKind (prevAt, now, windowMs = DOUBLE_TAP_MS) {
  if (typeof prevAt !== 'number' || !Number.isFinite(prevAt)) return 'single'
  const delta = now - prevAt
  return delta >= 0 && delta <= windowMs ? 'double' : 'single'
}

// The single-tap open waiting out the window. One per list, not per row: a
// tap on another post (or any other press) must cancel it, or the first
// post's conversation opens under the second one.
export function createPendingOpen ({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null
  let owner = null
  let at = null
  const cancel = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    owner = null
    at = null
  }
  return {
    arm (fn, who, now, ms = DOUBLE_TAP_MS) {
      cancel()
      owner = who
      at = now
      timer = setTimer(() => {
        timer = null
        owner = null
        at = null
        fn()
      }, ms)
    },
    cancel,
    cancelOwn (who) {
      if (owner === who) cancel()
    },
    // The armed tap's time only for the row that armed it: a tap on another
    // row is never the second half of a double tap.
    armedAt (who) {
      return owner === who ? at : null
    }
  }
}

// The one pending single-tap open of the whole app: post rows arm it, and
// any other touch (another row, a tab) cancels it, so a late open never lands
// on a screen the person already left.
export const pendingOpen = createPendingOpen()
