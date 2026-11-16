// Web: event reminders live in localStorage, on this installation's origin.
// Globals are read inside each call, never at import.

import { STORAGE_KEY, createReminderStore } from './eventReminders.js'

const store = createReminderStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})

export const loadReminders = store.load
export const hasReminder = store.has
export const setReminder = store.set
export const removeReminder = store.remove
export const forgetReminderKey = store.forgetKey
