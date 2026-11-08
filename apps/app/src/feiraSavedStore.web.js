// Web: saved listings live in localStorage, on this installation's origin.
// Globals are read inside each call, never at import; feiraSaved.js answers
// even when storage throws (private modes, sandboxed frames).

import { STORAGE_KEY, createSavedStore } from './feiraSaved.js'

const store = createSavedStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})

export const listSaved = store.list
export const isSaved = store.has
export const toggleSaved = store.toggle
export const removeSaved = store.remove
export const clearSaved = store.clear
