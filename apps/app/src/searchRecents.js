// The Busca tab's recent searches for this session. Pure and in memory only:
// the screen keeps the list in component state, nothing is written to a
// store, a file or a URL (SEARCH_MEMORY in topics.js promises that), and a
// change of signed-in account starts an empty list.

import { recentQueries } from './buscaGlobal.js'

export const RECENTS_MAX = 8
export const RECENTS_TITLE = 'Buscas recentes'
export const RECENTS_CLEAR = 'Limpar'
export const RECENTS_CLEAR_LABEL = 'limpar buscas recentes'
export const RECENTS_REMOVE = 'Remover'

function keyOf (query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : ''
}

// Newest first, trimmed, one entry per query ignoring case, at most
// RECENTS_MAX. A blank query leaves the list as it was.
export function recordRecent (list, query) {
  return recentQueries(list, query, RECENTS_MAX)
}

export function removeRecent (list, query) {
  const key = keyOf(query)
  return (Array.isArray(list) ? list : []).filter((q) => typeof q === 'string' && keyOf(q) !== key)
}

export function clearRecents () {
  return []
}
