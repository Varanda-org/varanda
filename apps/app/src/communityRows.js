export function rowVisibility (row, hint) {
  if (row.visibility === 'public' || row.visibility === 'private') return row.visibility
  if (hint?.visibility === 'public' || hint?.visibility === 'private') return hint.visibility
  return null
}

export function rowTitle (row, hint, labels) {
  if (typeof row.name === 'string' && row.name !== '') return row.name
  if (typeof hint?.name === 'string' && hint.name !== '') return hint.name
  if (row.general === true) return labels.general
  return rowVisibility(row, hint) === 'private' ? labels.private : 'Grupo'
}

export function rowVisibilityText (row, hint, label) {
  const visibility = rowVisibility(row, hint)
  return visibility === null ? '' : label(visibility)
}

export function needNames (info) {
  if (!info || typeof info !== 'object' || info.state === 'pending' || !Array.isArray(info.groups)) return false
  return info.groups.some((row) => row.name === null && row.visibility === null && row.general !== true)
}
