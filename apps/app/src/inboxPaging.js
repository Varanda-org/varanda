// The paging rules of the Conversas inbox (dm.list pages), pure so they load
// in tests. A refresh keeps the depth the person has loaded and a search pages
// through the rest on the device; neither changes the protocol.

// A refresh re-reads at most this many pages (the rows loaded past them stay),
// and a search pages through at most SEARCH_PAGES_MAX more before it asks the
// person to go on, so a huge inbox never turns into a long walk.
export const REFRESH_PAGES_MAX = 10
export const SEARCH_PAGES_MAX = 20
// Pause between two search pages: the walk never spins on a fast answer.
export const SEARCH_PAGE_GAP_MS = 150

function rowsOf (res) {
  return res && Array.isArray(res.conversations) ? res.conversations : []
}

// One row per peer, the first occurrence wins.
export function joinPages (pages) {
  const seen = new Set()
  const rows = []
  for (const page of pages) {
    for (const row of Array.isArray(page) ? page : []) {
      if (!row || seen.has(row.peer)) continue
      seen.add(row.peer)
      rows.push(row)
    }
  }
  return rows
}

// The fresh first page over the rows already loaded: its rows come first and
// win, every loaded row it does not list stays after them, so the list is not
// emptied while the deeper pages are read again.
export function mergeFirstPage (loaded, first) {
  return joinPages([first, loaded])
}

// How many pages a refresh reads: what is on screen, or what an overlapping
// refresh already set out to read, whichever is deeper, so two refreshes in a
// row never shrink the list.
export function refreshDepth (loaded, wanted) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 1)
  return Math.min(REFRESH_PAGES_MAX, Math.max(n(loaded), n(wanted)))
}

// Reads the pages after `first` (a dm.list answer) until `depth` pages are
// held or the cursor ends. `current()` false at any point drops the walk
// (null): a newer refresh owns the list. A failed read throws, with nothing
// swapped in. -> { rows, next, depth } to swap in once.
export async function readDepth ({ first, depth, read, current }) {
  const pages = [rowsOf(first)]
  let next = first && first.next ? first.next : null
  while (pages.length < depth && next) {
    if (!current()) return null
    const res = await read(next)
    if (!current()) return null
    pages.push(rowsOf(res))
    next = res && res.next ? res.next : null
  }
  if (!current()) return null
  return { rows: joinPages(pages), next, depth: pages.length }
}

// What a refresh swaps in once its re-read lands. A re-read that stopped at
// the cap with pages left keeps the rows loaded past it and their cursor, so a
// deep scroll or a search is never cut back to REFRESH_PAGES_MAX pages; the
// fresh rows come first and win. -> { rows, next, depth }
export function settleRefresh ({ rows, next }, deep, loadedDepth) {
  if (deep.next && Number.isInteger(loadedDepth) && loadedDepth > deep.depth) {
    return { rows: joinPages([deep.rows, rows]), next, depth: loadedDepth }
  }
  return { rows: deep.rows, next: deep.next, depth: deep.depth }
}

// Whether a search keeps paging through dm.list: text typed, a next page
// exists, nothing failed and the budget is not spent.
export function searchPaging ({ needle, next, pages, failed }) {
  return typeof needle === 'string' && needle !== '' && !!next && failed !== true &&
    Number.isInteger(pages) && pages < SEARCH_PAGES_MAX
}
