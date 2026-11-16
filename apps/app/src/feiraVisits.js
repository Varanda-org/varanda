// What arrived in a city's list since the last time it was shown. The time of
// each visit lives per city in the saved-searches file (feiraAlerts.js), on
// this device only. Pure: no React, no storage, no clock unless passed in.

export const MAX_VISITS = 20
const time = (n) => Number.isSafeInteger(n) && n >= 0
const refOf = (row) => row.author + ':' + row.seq

// One city of one state, the part of a saved query that names the place.
export function visitKey (query) {
  return query && typeof query.uf === 'string' && typeof query.cityKey === 'string' && query.uf && query.cityKey ? query.uf + '/' + query.cityKey : null
}

// { key: ms } with only readable entries, the most recent MAX_VISITS of them.
export function cleanVisits (value) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).filter(([key, at]) => key !== '' && time(at)) : []
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, MAX_VISITS))
}

export const previousVisit = (visits, key) => {
  const at = cleanVisits(visits)[key]
  return time(at) ? at : null
}

// The visits after one is recorded, and the time of the one before (null on
// the first). The stored time never moves backwards.
export function recordVisit (visits, key, now) {
  const clean = cleanVisits(visits)
  const previous = previousVisit(clean, key)
  if (typeof key !== 'string' || key === '' || !time(now)) return { visits: clean, previous }
  return { visits: cleanVisits({ ...clean, [key]: Math.max(previous === null ? 0 : previous, now) }), previous }
}

// The refs of the rows that arrived after `since`. Nothing before a first
// visit (since null), and nothing the person wrote themselves. A row dated
// after `now` is a clock that disagrees and does not count, as in countNew.
export function newRefs (rows, since, { now = Date.now(), isOwn = () => false } = {}) {
  const refs = new Set()
  if (!time(since) || !time(now) || !Array.isArray(rows)) return refs
  for (const row of rows) {
    if (!row || isOwn(row)) continue
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN
    if (at > since && at <= now) refs.add(refOf(row))
  }
  return refs
}

// The same order, the new rows first.
export function splitNew (rows, refs) {
  const fresh = []
  const older = []
  for (const row of rows) (refs.has(refOf(row)) ? fresh : older).push(row)
  return { fresh, older }
}

// One visit of the screen to one city: the time is read once, and recorded
// once, and only while the list is unfiltered (a filtered list does not show
// what the person has not seen). `session` is what the last step returned.
// -> { session, read, record }
export function visitStep (session, { id = null, shown = false, narrowed = false } = {}) {
  // No place on screen (the tab is hidden, say): the next time is a new visit.
  if (id === null) return { session: null, read: false, record: false }
  if (!shown) return { session, read: false, record: false }
  const current = session && session.id === id ? session : { id, read: false, recorded: false }
  const read = !current.read
  const record = !current.recorded && !narrowed
  if (!read && !record) return { session: current, read, record }
  return { session: { id, read: true, recorded: current.recorded || record }, read, record }
}
