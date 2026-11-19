// The tab dot follows unread counts the Conversas screen already shows.
// Group event counters also move on the person's own posts, reactions and
// member changes, so they must not light it.

const PAGE_KEY = /^[0-9a-f]{64}$/

export function groupsUnread (rows, opts) {
  if (!Array.isArray(rows)) return null
  const complete = opts != null && opts.complete === true
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.kind === 'group' && Number.isInteger(row.unread) && row.unread > 0) return true
  }
  // A partial list must not clear the dot: only a finished read can say none.
  return complete === true ? false : null
}

export function conversasDot ({ dm, groups, actingPage }) {
  const dmLit = !!dm && (dm.inboxUnread === true || dm.requests === true)
  // A Página has no groups in Conversas, so group unread stays dark there.
  return dmLit || (!actingPage && groups === true)
}

export function settleGroups (prev, next) {
  // An unknown read keeps the last answer so a failed refresh does not clear the dot.
  if (next === null || next === undefined) return prev === true
  return next === true
}

export function badgeListParams (pageKey) {
  if (typeof pageKey === 'string' && PAGE_KEY.test(pageKey)) {
    return { folder: 'inbox', limit: 1, page: pageKey }
  }
  return { folder: 'inbox', limit: 1 }
}

export function showNaoLidasEmpty ({ rows, requests, more, inboxUnread }) {
  // An unread row on a page not loaded yet must not look like an empty inbox.
  // When the service says nothing is unread anywhere, later pages do not matter.
  return Array.isArray(rows) && rows.length === 0 && requests !== true && (more !== true || inboxUnread === false)
}
