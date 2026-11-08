import { STORAGE_KEY, createAlertsStore } from './feiraAlerts.js'

export const alertsStore = createAlertsStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})
