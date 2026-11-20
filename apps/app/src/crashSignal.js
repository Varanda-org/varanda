// The crash screen tells the rest of the app that the tree is gone for good,
// so what an unmount alone would leave running (a hosted node's connection)
// can stop. One crash per process: the app is never remounted after it.
const listeners = new Set()
// In development a Fast Refresh can remount the app after a crash and it never
// reconnects: reload fully. Release builds never remount.
let crashed = false

export function onCrash (fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// For work that starts or finishes after the crash (a restart awaiting the old
// close, a connect in flight): it reads this and stops instead.
export function isCrashed () {
  return crashed
}

// Never throws: it runs inside the error boundary's commit.
export function signalCrash () {
  if (crashed) return
  crashed = true
  const fns = [...listeners]
  listeners.clear()
  for (const fn of fns) {
    try { fn() } catch {}
  }
}
