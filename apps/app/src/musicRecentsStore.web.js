// Web: recent music picks live in localStorage, on this installation's
// origin, keyed by account inside the value (musicRecents.js). Globals are
// read inside each call, never at import; musicRecents.js answers even when
// storage throws (private modes, sandboxed frames). Not wiped with the local
// caches, which a lock also clears: node.js removes it on sign-out and reset.

import { STORAGE_KEY, createMusicRecents } from './musicRecents.js'

const store = createMusicRecents({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw),
  remove: () => globalThis.localStorage.removeItem(STORAGE_KEY)
})

export const listMusicRecents = store.list
export const noteMusicRecent = store.note
export const clearMusicRecentsOf = store.clearOwner
export const clearMusicRecents = store.clear
