// The filter field of the Seguindo and Seguidores lists. It narrows only the
// rows already on the list: finding any other account is the global Busca's
// job, so a 64-hex string typed here is just text, never a follow or a lookup.
//
// Pure: imports only the fold of the account search, so Node tests load it
// directly and a name folds here exactly as the Busca folds it.

import { splitTokens } from './search.js'

export const FILTER_LABEL = 'Filtrar nesta lista'
export const FILTER_PLACEHOLDER = 'nome ou @nome'
export const FILTER_HINT = 'Para encontrar outra conta, use a Busca.'
export const FILTER_EMPTY = 'Ninguém com esse nome nesta lista.'

// The folded name and username that can be matched, or null when the account
// has neither, which is the only case a non-empty filter drops it for. '@',
// punctuation and invisible characters fold away on both sides.
function fieldsOf (profile) {
  if (!profile || typeof profile !== 'object') return null
  const fields = [profile.name, profile.username]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .map((v) => splitTokens(v).join(' '))
    .filter((v) => v.length > 0)
  return fields.length > 0 ? fields : null
}

// Keeps the keys whose profile matches every token, in list order. Each token
// may match either field. Blank text returns the same array untouched.
export function filterPeople (keys, profileOf, text) {
  if (!Array.isArray(keys)) return []
  if (typeof text !== 'string') return keys
  const tokens = splitTokens(text)
  if (tokens.length === 0) return keys
  const kept = []
  for (const key of keys) {
    let fields = null
    try {
      fields = fieldsOf(typeof profileOf === 'function' ? profileOf(key) : undefined)
    } catch {
      fields = null
    }
    if (fields === null) continue
    if (tokens.every((t) => fields.some((f) => f.includes(t)))) kept.push(key)
  }
  return kept
}
