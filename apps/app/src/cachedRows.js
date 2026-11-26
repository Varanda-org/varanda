function filterRows (rows, authorsOf, show) {
  if (!Array.isArray(rows) || typeof authorsOf !== 'function') return []
  const kept = rows.filter((row) => {
    const authors = authorsOf(row)
    if (!Array.isArray(authors)) return false
    for (const author of authors) {
      if (typeof author !== 'string') return false
    }
    return show(authors)
  })
  return kept.length === rows.length ? rows : kept
}

function clearOf (authors, keys) {
  return keys == null || (typeof keys.has === 'function' && !authors.some((author) => keys.has(author)))
}

// Evaluate at render time so a block or mute can hide a cached row immediately.
export function cachedRowsShown (rows, options) {
  const { loadState, blocked, muted = null, owner, authorsOf } = options ?? {}
  const own = typeof owner === 'string' ? owner.toLowerCase() : null
  return filterRows(rows, authorsOf, (authors) => {
    if (own !== null && authors.length > 0 && authors.every((author) => author.toLowerCase() === own)) return true
    return loadState === 'ok' && clearOf(authors, blocked) && clearOf(authors, muted)
  })
}

export function withoutBlockedRows (rows, blocked, authorsOf) {
  if (blocked == null) return Array.isArray(rows) ? rows : []
  return filterRows(rows, authorsOf, (authors) => clearOf(authors, blocked))
}
