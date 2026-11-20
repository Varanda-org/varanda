import { installationOrigin } from './installation.js'
import { PLAY_LISTING, watchStoreRelease } from './storeRelease.js'

let AppState = null
let openExternal = null
let appBuild = () => null
try {
  // Loading inside the guard also lets Node import this file without React
  // Native, where the watcher stays a noop.
  AppState = require('react-native').AppState
  openExternal = require('./openExternal').openExternal
  appBuild = require('../modules/app-build').appBuild
} catch {}

// iOS/Android: no service worker.
export function startPwa () {
  return Promise.resolve(false)
}

// Only Android has the app-build module, and only an install from Google
// Play gets the notice (src/storeRelease.js). Elsewhere this is a noop.
export function watchRelease (onChange) {
  return watchStoreRelease({
    build: appBuild(),
    origin: installationOrigin,
    onChange,
    onActive: (fn) => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') fn()
      })
      return () => sub.remove()
    }
  })
}

export function applyUpdate () {
  try { openExternal(PLAY_LISTING) } catch {}
}
