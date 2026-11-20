export const NEW_GROUP_LIMIT = 32

export function creatorCommunities (list) {
  if (!Array.isArray(list)) return []
  return list.filter((row) => row?.role === 'creator' && row.state === 'ready')
}

export function newGroupCount (info) {
  if (!Array.isArray(info?.groups) || !Array.isArray(info?.dropped)) return null
  // A dropped group still occupies a slot in the root catalogue.
  return info.groups.length + info.dropped.length
}

export function newGroupGate (info) {
  if (!info || typeof info !== 'object' || info.state === 'pending') {
    return { show: false, enabled: false, reason: '' }
  }
  if (info.role !== 'creator') {
    return { show: false, enabled: false, reason: info.role === 'admin' ? 'Só quem criou a comunidade cria grupos.' : '' }
  }
  if (info.rootHere === false) {
    return { show: true, enabled: false, reason: 'Novo grupo só funciona no aparelho que criou a comunidade.' }
  }
  if (info.rootAuthority === false) {
    return { show: true, enabled: false, reason: 'Esta comunidade não recebe mais grupos novos.' }
  }
  const count = newGroupCount(info)
  if (count !== null && count >= NEW_GROUP_LIMIT) {
    return { show: true, enabled: false, reason: 'A comunidade chegou ao limite de ' + NEW_GROUP_LIMIT + ' grupos.' }
  }
  return { show: true, enabled: true, reason: '' }
}
