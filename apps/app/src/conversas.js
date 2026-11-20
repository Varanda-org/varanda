import { whoOf, UNNAMED } from './who.js'
import { plainPreview } from './chatPreview.js'

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

// The name as the row shows it: whoOf drops leading at-signs and invisible
// characters, so a name made only of those reads as no name at all.
function visible (value) {
  return textOf(value).trim() !== '' && whoOf({ name: value }).title !== UNNAMED
}

function titleOf (item, fallback) {
  if (visible(item.title)) return item.title
  if (visible(item.name)) return item.name
  if (textOf(item.username).trim()) return '@' + item.username
  return fallback
}

// The verified @nome a person row shows under the name, or null. The same
// whoOf rule as the title: the @nome comes only from a username record, and
// it is left out when the title already is that @nome written as a name.
export function handleLine (profile) {
  if (!profile || typeof profile !== 'object') return null
  const who = whoOf(profile)
  if (who.subtitle === null) return null
  return whoOf({ name: profile.name }).title === UNNAMED ? null : who.subtitle
}

function flat (value) {
  return textOf(value).replace(/\r?\n/g, ' ')
}

// Twin of lastLine in groups.js: the hidden label must stay in sync.
// Escaping stays at the screen's displayText. The own marker is the row's `mine`, never text.
function groupLine (last) {
  if (!last || typeof last !== 'object') return ''
  if (last.hidden === true) return 'mensagem escondida'
  const preview = flat(plainPreview(last.preview))
  if (last.mine === true) return preview
  const author = whoOf({ name: last.name, username: last.username }).title
  return author === UNNAMED ? preview : author + ': ' + preview
}

function timeOf (at) {
  const time = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(time) ? time : null
}

function sortTitle (title) {
  if (typeof title !== 'string') return ''
  const shown = whoOf({ name: title }).title
  return shown === UNNAMED ? '' : shown
}

function compareRows (a, b) {
  const ta = timeOf(a.at)
  const tb = timeOf(b.at)
  if (ta !== null && tb !== null && ta !== tb) return tb - ta
  if (ta !== null && tb === null) return -1
  if (ta === null && tb !== null) return 1
  if (ta === null && tb === null) {
    // The title the row draws (whoOf), not the raw text: a leading at-sign or
    // invisible character would otherwise decide the order.
    const title = sortTitle(a.title).localeCompare(sortTitle(b.title), 'pt-BR')
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
      subtitle: flat(plainPreview(dm.preview)),
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
      ...(group.visibility !== undefined ? { visibility: group.visibility } : {}),
      ...(group.image !== undefined ? { image: group.image } : {}),
      ...(group.imageAuthor !== undefined ? { imageAuthor: group.imageAuthor } : {}),
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

// Private image keys stay only in live rows, never in a stored list.
export function rowsForStorage (rows) {
  return rows.map((row) => {
    const { privateItem, ...stored } = row
    if (row.visibility === 'private' || row.image?.mime === 'application/octet-stream' || row.image?.key !== undefined) {
      delete stored.image
      delete stored.imageAuthor
    }
    return stored
  })
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

// A read-only list of a moved Página's old key (pageOldKeys.js). It has no
// unread mark, so only the Todas chip shows it. The title repeats
// pageOldKeys.js OLD_KEY_TITLE (a test keeps them equal) because this module
// may import only who.js and the preview helper.
const OLD_KEY_ROW_TITLE = 'Conversas da chave antiga'

export function oldKeyRow (key, i) {
  return {
    kind: 'old-key',
    key: 'old-key:' + key,
    page: key,
    title: i === 0 ? OLD_KEY_ROW_TITLE : OLD_KEY_ROW_TITLE + ' ' + (i + 1),
    pinned: true,
    unread: false
  }
}

// How many recent conversation partners the + sheet lists.
export const RECENT_MAX = 8

// The items whose key is none of the acting identity's own keys: the person's
// key and, acting as a Página, the Página's key too. Keys compare in lower
// case; `keyOf` reads the key off an item (the item itself by default).
export function withoutOwn (items, ownKeys, keyOf = (item) => item) {
  const own = new Set((Array.isArray(ownKeys) ? ownKeys : []).filter((k) => typeof k === 'string' && k !== '').map((k) => k.toLowerCase()))
  if (!Array.isArray(items)) return []
  return items.filter((item) => {
    const key = keyOf(item)
    return !(typeof key === 'string' && own.has(key.toLowerCase()))
  })
}

export function communitiesRow () {
  return {
    kind: 'communities',
    key: 'communities',
    title: 'Comunidades',
    pinned: true
  }
}
