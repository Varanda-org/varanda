export const NEW_GROUP_LIMIT = 32

export const STANDALONE_ROW_LABEL = 'Grupo sem comunidade'
export const STANDALONE_ROW_HELP = 'Qualquer pessoa pode criar. Um grupo público sem comunidade aparece em Descobrir, em Grupos.'
export const STANDALONE_ROW_DOC = Object.freeze({ title: STANDALONE_ROW_LABEL, paragraphs: Object.freeze([STANDALONE_ROW_HELP]) })
export const STANDALONE_UNKNOWN_NOTE = 'Não dá para conferir agora. Espere um pouco e confira a sua lista de grupos antes de tentar de novo.'

// The reconcile view (groups.js, create without community) of an uncertain
// create: `before` is the readStandalone result taken before the create.
export function standaloneCreateView (before, after) {
  return {
    before: (Array.isArray(before?.groups) ? before.groups : []).map((g) => g.group),
    groups: Array.isArray(after?.groups) ? after.groups : [],
    complete: before?.complete === true && after?.complete === true
  }
}

// The key of the group a landed create made: the one new creator row with the name.
export function createdStandaloneKey (view, name) {
  const before = new Set(Array.isArray(view?.before) ? view.before : [])
  const fresh = (Array.isArray(view?.groups) ? view.groups : []).filter((g) => g && g.name === name && g.role === 'creator' && !before.has(g.group))
  return fresh.length === 1 ? fresh[0].group : null
}

// Conversas group rows: the community rows plus the groups without
// community, one row per key (a community row wins). The title of a group
// without community is its name.
export function withStandaloneRows (rows, standalone) {
  const seen = new Set(rows.map((r) => r.group))
  const out = rows.slice()
  for (const g of standalone) {
    if (seen.has(g.group)) continue
    seen.add(g.group)
    const row = { ...g, community: null }
    if (typeof g.name === 'string' && g.name !== '') row.title = g.name
    out.push(row)
  }
  return out
}

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
