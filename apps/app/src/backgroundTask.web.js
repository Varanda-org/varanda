// Web: no background task (the browser node runs only with the page), and
// no keychain to protect, so the foreground gate is always open. The native
// twin is ./backgroundTask.native.js.

export const TASK_NAME = 'varanda-rua-refresh'

export const foregroundSeen = () => true
export const whenForeground = () => Promise.resolve()
export const whenActive = () => Promise.resolve()
export const cancelBackgroundRefresh = () => Promise.resolve()
export const noteForegroundUse = () => {}
export const registerBackgroundRefresh = () => Promise.resolve()
export const unregisterBackgroundRefresh = () => Promise.resolve()
