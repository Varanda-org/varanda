import { STORAGE_KEY, createInviteSeenStore } from './inviteDrop.js'

const store = createInviteSeenStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})

export const loadInviteSeen = store.load
export const saveInviteSeen = store.save
