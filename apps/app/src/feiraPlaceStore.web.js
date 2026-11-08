// Web: the Feira's state and city (feiraScreen.js createLocationStore) live
// in localStorage on this installation's origin. Globals are read inside each
// call, never at import. A refused read means nothing remembered; a refused
// write rejects, so the screen can say the city was not kept.

import { createLocationStore } from './feiraScreen.js'

export const feiraLocation = createLocationStore({
  read: (key) => {
    try { return globalThis.localStorage.getItem(key) } catch { return null }
  },
  write: (key, raw) => globalThis.localStorage.setItem(key, raw)
})
