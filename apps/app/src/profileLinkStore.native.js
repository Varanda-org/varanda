// iOS/Android: a profile link reaches the app as varanda:///@nome,
// varanda:///m/<key> or an https link of this installation; App.js routes
// every URL the app is opened with here. The invite record keeps the web's
// contract (src/profileLink.js: a fresh 'new' record, consent only through
// saveInvite after the card, the 1 h limit on every read) in this process's
// memory instead of tab storage. No react-native import: the tests load this
// module with import().

import { captureInvite as capture, readInvite, writeInvite, clearInvite } from './profileLink.js'
import { parseAppLink } from './linkReturn.js'

function memoryStorage () {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

const storage = memoryStorage()
const NO_HISTORY = { state: null, replaceState () {} }

// With no argument (App.js at import): the record held, if any. With a URL:
// a valid profile link replaces the held invite with a fresh 'new' one, so a
// link never inherits earlier consent; any other URL changes nothing.
export function captureInvite (url, now = Date.now()) {
  try {
    if (url === undefined) return readInvite(storage, now)
    const link = parseAppLink(url)
    if (link === null || link.kind !== 'perfil') return null
    const pathname = link.username ? '/@' + link.username : '/m/' + link.key
    return capture({ location: { pathname, search: '', hash: '' }, history: NO_HISTORY, storage, now })
  } catch {
    return null
  }
}

export function loadInvite () {
  return readInvite(storage, Date.now())
}

export function saveInvite (rec) {
  return writeInvite(storage, rec)
}

export function dropInvite () {
  return clearInvite(storage)
}
