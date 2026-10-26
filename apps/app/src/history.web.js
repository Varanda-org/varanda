// Browser history binding for the screen stack (hosted web only), so the
// browser Back button closes screens. Every screen opened pushes one history
// entry tagged { varanda: <stack depth> }; a popstate that lands on a lower
// depth (an untagged entry counts as depth 0) asks the app to close that many
// screens. Depth 0 never pushes. When a push does not raise the depth above
// the current history entry's tag (nav.js MAX_DEPTH dropped the oldest
// screen), the entry is replaced instead of pushed (replaceState), so the
// history depth always equals the stack depth and no Back press is dead. Tolerates a missing history API (does
// nothing). `win` is injectable for tests; the global is touched only inside
// these functions.

function depthOfState (state) {
  const d = state && typeof state === 'object' ? state.varanda : 0
  return Number.isSafeInteger(d) && d >= 0 ? d : 0
}

export function bindHistory ({ depthOf, onBack, win = globalThis } = {}) {
  const history = win && win.history
  const canPush = !!history && typeof history.pushState === 'function'
  const canListen = !!win && typeof win.addEventListener === 'function'

  const onPop = (event) => {
    const current = depthOf()
    const target = depthOfState(event ? event.state : null)
    if (target < current) onBack(current - target)
  }
  if (canListen) win.addEventListener('popstate', onPop)

  return {
    pushed () {
      if (!canPush) return
      const d = depthOf()
      if (!Number.isSafeInteger(d) || d <= 0) return
      const replace = depthOfState(history.state) >= d && typeof history.replaceState === 'function'
      try {
        if (replace) history.replaceState({ varanda: d }, '')
        else history.pushState({ varanda: d }, '')
      } catch {}
    },
    unbind () {
      if (canListen && typeof win.removeEventListener === 'function') win.removeEventListener('popstate', onPop)
    }
  }
}
