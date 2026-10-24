/* global localStorage, location, fetch, AbortController, TextEncoder */

// Web. With varanda-serve the node configuration is varanda-serve's: nothing
// is stored here. With the node in the browser, the configuration the person
// typed in Conectar (the association key and the seeder address, neither a
// secret) is kept in localStorage. The member's key is derived from the
// passkey and lives only in the node's memory: never here, never stored.

import { hostedConfigOf, isHostedPage, reviveWeb } from './config'
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

export async function clearConfig () {
  if (webMode !== 'browser') return
  try { localStorage.removeItem(KEY) } catch {}
}

// True on a hosted installation (https, not loopback): see isHostedPage.
export const hostedPage = (() => {
  try {
    return isHostedPage({ mode: webMode, protocol: location.protocol, hostname: location.hostname })
  } catch {
    return false
  }
})()

const MAX_DISCOVERY_BYTES = 4096

// The configuration of the installation that served this page: the same
// origin's /varanda.json ({ v: 1, association }). null on any failure, never
// throws. The SPA fallback and Expo's dev server answer index.html
// (text/html), which is refused by the content type.
export async function discoverConfig () {
  if (webMode !== 'browser') return null
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 8000)
  try {
    const res = await fetch('/varanda.json', { cache: 'no-store', credentials: 'omit', signal: abort.signal })
    if (!res.ok) return null
    if (!/application\/json/i.test(res.headers.get('content-type') || '')) return null
    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_DISCOVERY_BYTES) return null
    const text = await res.text()
    if (new TextEncoder().encode(text).length > MAX_DISCOVERY_BYTES) return null
    return hostedConfigOf(JSON.parse(text), { host: location.host, secure: location.protocol === 'https:' }).config || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
