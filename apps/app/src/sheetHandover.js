// One sheet at a time on the way in: a sheet asked to open while another is
// still sliding out waits until that one reports it is gone. iOS cannot
// present a page sheet while another dismisses, and react-native-web hands
// focus to the modal on top of its stack, so a sheet shown during another's
// exit could stay closed or dead ("Ver quem reagiu" right after a sheet
// closed). Each leaving sheet also has a fallback timer, for a platform (or a
// dismissal) that never reports.

export function createHandover ({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const leaving = new Set()
  let waiting = []
  const settle = () => {
    if (leaving.size > 0 || waiting.length === 0) return
    const run = waiting
    waiting = []
    for (const entry of run) entry.fn()
  }
  return {
    busy: () => leaving.size > 0,
    // A sheet starts leaving; the returned function says it is gone (once).
    leave (fallbackMs) {
      const token = {}
      leaving.add(token)
      const timer = setTimer(() => done(), fallbackMs)
      function done () {
        if (!leaving.delete(token)) return
        clearTimer(timer)
        settle()
      }
      return done
    },
    // Runs fn now when no sheet is leaving, or once every leaving sheet is
    // gone. The returned function withdraws a request that has not run.
    request (fn) {
      if (leaving.size === 0) {
        fn()
        return () => {}
      }
      const entry = { fn }
      waiting.push(entry)
      return () => { waiting = waiting.filter((e) => e !== entry) }
    }
  }
}

export const sheetHandover = createHandover()
