// Web: saved posts live in localStorage, on this installation's origin.
// Globals are read inside each call, never at import; savedPosts.js answers
// even when storage throws (private modes, sandboxed frames).

import { STORAGE_KEY, createSavedStore } from './savedPosts.js'

const store = createSavedStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})

export const loadSaved = store.load
export const hasSaved = store.has
export const addSaved = store.add
export const removeSaved = store.remove
export const forgetSavedScope = store.forgetScope
export const forgetSavedKey = store.forgetKey
