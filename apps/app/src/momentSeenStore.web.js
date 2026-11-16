import { STORAGE_KEY, createMomentSeenStore } from './momentSeen.js'

const store = createMomentSeenStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})

export const loadMomentSeen = () => store.load()
export const markMomentSeen = (id) => store.mark(id)
export const onMomentSeen = (fn) => store.subscribe(fn)
export const bindMomentSeen = (source) => store.bind(source)
export const refreshMomentSeen = () => store.refresh()
export const migrateMomentSeenOnce = (allowed) => store.migrate(allowed)
export const clearMomentSeen = () => store.clear()
