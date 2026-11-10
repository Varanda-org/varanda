import { whoOf, UNNAMED } from './who.js'

export const FILTERS = Object.freeze(['todas', 'nao-lidas', 'grupos'])

export const FILTER_LABELS = Object.freeze({
  todas: 'Todas',
  'nao-lidas': 'Não lidas',
  grupos: 'Grupos'
})

// The tab stays mounted while hidden; its reads wait for the first show so
// they never queue on the node's serial chain in front of A Rua at boot.
export function conversasReadsAllowed ({ active, shownOnce } = {}) {
  return active === true || shownOnce === true
}

function textOf (value) {
  return typeof value === 'string' ? value : ''
}

function titleOf (item, fallback) {
  if (textOf(item.title).trim()) return item.title
  if (textOf(item.name).trim() && whoOf({ name: item.name }).title !== UNNAMED) return item.name
  if (textOf(item.username).trim()) return '@' + item.username
  return fallback
}

function flat (value) {
  return textOf(value).replace(/\r?\n/g, ' ')
}

// Twin of lastLine in groups.js (the hidden label must stay in sync); not imported to stay dependency-free.
// Keep peer text raw here for displayText at the screen. The own marker is the row's `mine`, never text.
function groupLine (last) {
  if (!last || typeof last !== 'object') return ''
  if (last.hidden === true) return 'mensagem escondida'
  const preview = flat(last.preview)
  if (last.mine === true) return preview
  const author = whoOf({ name: last.name, username: last.username }).title
  return author === UNNAMED ? preview : author + ': ' + preview
}

function timeOf (at) {
  const time = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(time) ? time : null
}

function compareRows (a, b) {
  const ta = timeOf(a.at)
  const tb = timeOf(b.at)
  if (ta !== null && tb !== null && ta !== tb) return tb - ta
  if (ta !== null && tb === null) return -1
  if (ta === null && tb !== null) return 1
  if (ta === null && tb === null) {
    const title = (a.title || '').localeCompare(b.title || '', 'pt-BR')
    if (title !== 0) return title
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export function mergeRows ({ dmConversations = [], groups = [] } = {}) {
  const rows = []
  for (const dm of dmConversations) {
    if (!dm || !textOf(dm.peer)) continue
    if (dm.folder && dm.folder !== 'inbox') continue
    rows.push({
      kind: 'dm',
      key: 'dm:' + dm.peer,
      peer: dm.peer,
      title: titleOf(dm, null),
      subtitle: flat(dm.preview),
      mine: dm.mine === true,
      at: timeOf(dm.at) === null ? null : dm.at,
      unread: dm.unread === true,
      community: null
    })
  }
  for (const group of groups) {
    if (!group) continue
    const id = textOf(group.group) || textOf(group.id)
    if (!id) continue
    const last = group.last
    rows.push({
      kind: 'group',
      key: 'group:' + id,
      group: id,
      title: titleOf(group, group.general === true ? 'Geral' : 'Grupo'),
      subtitle: groupLine(last),
      mine: !!last && last.mine === true && last.hidden !== true,
      at: last && timeOf(last.at) !== null ? last.at : null,
      unread: Number.isInteger(group.unread) && group.unread > 0 ? group.unread : 0,
      community: group.community || null
    })
  }
  return rows.sort(compareRows)
}

export function applyFilter (rows, filter) {
  return rows.filter((row) => {
    if (filter === 'grupos') return row.kind === 'group' || row.kind === 'communities'
    if (filter === 'nao-lidas') {
      return (row.kind === 'requests' && row.unread === true) ||
        (row.kind === 'dm' && row.unread === true) ||
        (row.kind === 'group' && row.unread > 0)
    }
    return true
  })
}

export function requestsRow (dmList) {
  return {
    kind: 'requests',
    key: 'requests',
    title: 'Pedidos de mensagem',
    pinned: true,
    unread: !!dmList && dmList.requests === true
  }
}

// How many recent conversation partners the + sheet lists.
export const RECENT_MAX = 8

export function communitiesRow () {
  return {
    kind: 'communities',
    key: 'communities',
    title: 'Comunidades',
    pinned: true
  }
}
