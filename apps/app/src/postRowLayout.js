// Layout decisions that keep a post row at one render on mount. A row
// measures its caption and head targets on its first layout; storing a value
// the first render already used would render it again for nothing.

const JITTER = 0.5

// The caption width the row should store: undefined while the measurement
// matches the estimate the clamp already used, so the state never changes.
export function captionWidthNext (estimate, measured) {
  if (!Number.isFinite(measured) || measured <= 0) return undefined
  if (Number.isFinite(estimate) && Math.abs(measured - estimate) < JITTER) return undefined
  return measured
}

// The head targets measure the same in every row with the same buttons and
// text size, so the last size seeds the reserve of the next row's first render.
const headSizes = new Map()

export function headActionsKey (follow, more, fontScale) {
  return (follow ? 'f' : '-') + (more ? 'm' : '-') + ':' + String(Number.isFinite(fontScale) ? fontScale : 1)
}

export function cachedHeadActions (key) {
  return headSizes.get(key) || null
}

// Android rounds layout to device pixels, so one 44 pt target reads 43.81 or
// 44.19 by its offset; under half a point is the same size.
export function sameSize (a, b) {
  if (!a || !b) return false
  return Math.abs(a.width - b.width) < JITTER && Math.abs(a.height - b.height) < JITTER
}

export function rememberHeadActions (key, size) {
  if (!size || !(size.width > 0)) return
  const prev = headSizes.get(key)
  if (sameSize(prev, size)) return
  // A handful of button and font-scale combinations at most; the bound only
  // guards against a scale that keeps changing.
  if (!prev && headSizes.size >= 32) headSizes.clear()
  headSizes.set(key, { width: size.width, height: size.height })
}

// The row's measured size when it is for these targets, else the size seeded
// from the cache for this key (read once per row, so a later write by another
// row never moves it), else the guess.
export function headReserveOf ({ key, measured, seeded, guess }) {
  if (measured && measured.key === key && measured.width > 0) return { width: measured.width, height: measured.height }
  if (seeded && seeded.key === key && seeded.size) return seeded.size
  return guess
}

export function seedHeadActions (seeded, key) {
  if (seeded && seeded.key === key) return seeded
  return { key, size: cachedHeadActions(key) }
}

// Sheets mount on their first opening and stay mounted, so a row costs no
// sheet until one is used and a closing sheet keeps its pending action.
export function openedNext (opened, sheet) {
  if (typeof sheet !== 'string' || (opened && opened[sheet] === true)) return opened
  return { ...opened, [sheet]: true }
}
