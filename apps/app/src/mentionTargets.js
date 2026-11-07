import { suggestionRows, validUsername } from './mentions.js'

const HEX64_RE = /^[0-9a-f]{64}$/

function validTarget (row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) &&
    (row.kind === 'member' || row.kind === 'page') &&
    typeof row.key === 'string' && HEX64_RE.test(row.key) && validUsername(row.username) &&
    (row.name == null || typeof row.name === 'string') && row.closed !== true && row.moved !== true
}

export function mergeSuggestions (memberHits, pageHits, query, ownKey) {
  const hits = []
  const seen = new Set()
  for (const [list, pages] of [[memberHits, false], [pageHits, true]]) {
    if (!Array.isArray(list)) continue
    for (const hit of list) {
      if (hit === null || typeof hit !== 'object' || Array.isArray(hit)) continue
      const kind = pages || hit.page === true ? 'page' : 'member'
      const key = hit.author ?? hit.key
      const row = { ...hit, kind, key }
      if (!validTarget(row) || seen.has(key)) continue
      seen.add(key)
      hits.push({ ...row, author: key, page: kind === 'page' })
    }
  }
  return suggestionRows(hits, query, ownKey).map((hit) => ({
    kind: hit.kind,
    username: hit.username,
    // Raw on purpose: the row runs whoOf (which strips look-alike at-signs and
    // invisibles) before displayText; escaping first would defeat whoOf.
    name: typeof hit.name === 'string' ? hit.name : null,
    key: hit.key,
    chipLabel: hit.kind === 'page' ? 'Página' : null
  }))
}

export function openTarget (row) {
  return validTarget(row) ? { screen: 'membro', key: row.key } : null
}
