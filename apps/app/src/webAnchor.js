// react-native-web has no maintainVisibleContentPosition to keep a row in view.
export function pickAnchor (rects) {
  if (!Array.isArray(rects)) return -1
  return rects.findIndex((rect) => Number.isFinite(rect?.top) && Number.isFinite(rect?.bottom) && rect.bottom > 0)
}

export function anchorShift (before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0
  const shift = after - before
  return Math.abs(shift) < 0.5 ? 0 : shift
}

// An older page landed in front when the old first row is still there, further
// down. Other updates (a reaction under a bubble) keep the browser's anchoring.
export function isPrepend (before, after, keyOf) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length === 0) return false
  const key = typeof keyOf === 'function' ? keyOf : (row) => row?.key
  const first = key(before[0], 0)
  if (first === undefined || first === null) return false
  for (let i = 1; i < after.length; i++) if (key(after[i], i) === first) return true
  return false
}
