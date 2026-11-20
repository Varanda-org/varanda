// Order of diary.peek work for a list. The app shares one peek slot, so the
// rows on screen go first, then the rows below them (where the reader is
// headed), then the rows above. Each of those groups stays in row order.
// A ref indexOf cannot place (not a finite number) is not a row here and
// stays after the rows, in the order it was given. No range: row order.

function finite (n) {
  return typeof n === 'number' && Number.isFinite(n)
}

// { first, last } inclusive, or null when there is nothing to window by.
function spanOf (range) {
  if (!range || typeof range !== 'object') return null
  if (!finite(range.first) || !finite(range.last) || range.first > range.last) return null
  return range
}

export function orderRefs (refs, indexOf, range) {
  if (!Array.isArray(refs) || refs.length === 0) return []
  const lookup = typeof indexOf === 'function' ? indexOf : () => undefined
  const ranked = []
  const rest = []
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]
    const index = lookup(ref)
    if (finite(index)) ranked.push({ ref, index, i })
    else rest.push(ref)
  }
  ranked.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.i - b.i))
  const span = spanOf(range)
  if (span === null) {
    const rowOrder = []
    for (let i = 0; i < ranked.length; i++) rowOrder.push(ranked[i].ref)
    for (let i = 0; i < rest.length; i++) rowOrder.push(rest[i])
    return rowOrder
  }
  const inside = []
  const below = []
  const above = []
  for (let i = 0; i < ranked.length; i++) {
    const row = ranked[i]
    if (row.index >= span.first && row.index <= span.last) inside.push(row.ref)
    else if (row.index > span.last) below.push(row.ref)
    else above.push(row.ref)
  }
  return inside.concat(below, above, rest)
}
