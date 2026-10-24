/* global localStorage */

// Web. With varanda-serve the node configuration is varanda-serve's: nothing
// is stored here. With the node in the browser, the configuration the person
// typed in Conectar (the association key and the seeder address, neither a
// secret) is kept in localStorage; the key itself lives in the node's
// IndexedDB, never here.

import { reviveWeb } from './config'
import { webMode } from './client/mode'

const KEY = 'varanda-web-config'

export async function loadConfig () {
  if (webMode !== 'browser') return null
  try {
    const text = localStorage.getItem(KEY)
    return text === null ? null : reviveWeb(JSON.parse(text))
  } catch {
    return null
  }
}

export async function saveConfig (config) {
  if (webMode !== 'browser') return
  localStorage.setItem(KEY, JSON.stringify(config))
}

export const canConfigure = webMode === 'browser'
