/* global localStorage, location, fetch, AbortController, TextDecoder */

// Web. With varanda-serve the node configuration is varanda-serve's: nothing
// is stored here. With the node in the browser, the configuration the person
// typed in Conectar (the association key and the seeder address, neither a
// secret) is kept in localStorage. The member's key is derived from the
// passkey and lives only in the node's memory: never here, never stored.
// On a hosted installation the association of the last valid /varanda.json is
// also remembered (apart, bound to this origin, not a secret) and used only
// when the installation does not answer, so the installed app starts offline.

import { hostedConfigOf, isHostedPage, reviveWeb } from './config'
import { webMode } from './client/mode'
import { setMediaOrigin } from './installation'
import { discoveryOutcome, rememberedHostedConfig, MAX_DISCOVERY_BYTES } from './discovery'

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

// The cold-start preview that reads this (App.js) never runs on the web
// (previewCapable is false here): nothing is
// remembered for it here.
export async function rememberedConfig () {
  return null
}

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

const DISCOVERED_KEY = 'varanda-web-discovered'

const validate = (json) => hostedConfigOf(json, { host: location.host, secure: location.protocol === 'https:' })

// The association of the last valid /varanda.json, bound to this origin. It is
// not a secret. Stored apart from KEY (the manual configuration), never
// trusted for the seeder address.
function rememberDiscovered (config) {
  try {
    localStorage.setItem(DISCOVERED_KEY, JSON.stringify({ v: 1, origin: location.origin, association: config.association }))
    return true
  } catch {
    return false
  }
}

function loadDiscovered () {
  try {
    const text = localStorage.getItem(DISCOVERED_KEY)
    if (text === null) return null
    return rememberedHostedConfig(JSON.parse(text), { origin: location.origin }, validate)
  } catch {
    return null
  }
}

function forgetDiscovered () {
  try { localStorage.removeItem(DISCOVERED_KEY) } catch {}
}

// The configuration of the installation that served this page: the same
// origin's /varanda.json ({ v: 1, association }). null on any failure, never
// throws. The SPA fallback and Expo's dev server answer index.html
// (text/html), which is refused by the content type. A live answer is
// remembered; the remembered association is used only when the installation
// does not answer (offline, network error, 408/429/5xx, redirect). An answer
// that is not a valid configuration forgets it and is never concealed by a
// stale one. options: { onStatus, onLine, preferRemembered, onRevalidated };
// onStatus({ source, persisted? }) is called at most once, source: 'live' |
// 'remembered' | 'none' | 'invalid'.
//
// preferRemembered (a returning member's start): when this origin has a
// remembered answer and onLine is not false, it is returned at once (status
// 'remembered') so the node starts without waiting up to 8 s for the
// installation; the live fetch then runs detached and, when it settles,
// onRevalidated is called exactly once with { verdict: 'same' },
// { verdict: 'changed', config } (the new answer, now remembered),
// { verdict: 'invalid' } (a valid response with an invalid body; the
// remembered answer is forgotten) or { verdict: 'transport' } (the remembered
// answer is kept). It is not called when a newer discovery started meanwhile.
// Without a remembered answer the live path runs as usual and onRevalidated is
// never called. The remembered record is only that of this origin
// (rememberedHostedConfig), and its association is revalidated.
// Each discovery is numbered: an older one that settles late writes nothing,
// so it can neither erase nor replace what a newer one remembered.
let discoveries = 0

// The media origin is the one thing a stale answer may still settle: every
// live answer (a media origin or its absence) is applied when it is newer than
// the last one applied, even if a newer discovery has started or ended in a
// transport failure meanwhile, so a live answer without `media` is not lost to
// a later failure and an older answer never undoes a newer one.
let appliedLive = 0
function applyMedia (seq, value) {
  if (seq <= appliedLive) return
  appliedLive = seq
  setMediaOrigin(value)
}

export async function discoverConfig (options = {}) {
  if (webMode !== 'browser') return null
  const seq = ++discoveries
  const current = () => seq === discoveries
  const { onStatus, onLine, preferRemembered = false, onRevalidated } = options || {}
  const report = (status) => {
    if (typeof onStatus !== 'function') return
    try { onStatus(status) } catch {}
  }
  const fromMemory = () => {
    const remembered = loadDiscovered()
    report({ source: remembered ? 'remembered' : 'none' })
    return remembered
  }
  if (onLine === false) return fromMemory()
  if (preferRemembered === true) {
    const remembered = loadDiscovered()
    if (remembered !== null) {
      report({ source: 'remembered' })
      revalidate(seq, remembered, onRevalidated, current)
      return remembered
    }
  }
  const outcome = await liveOutcome()
  if (outcome.verdict === 'live') {
    applyMedia(seq, outcome.config.media)
    report({ source: 'live', persisted: current() ? rememberDiscovered(outcome.config) : false })
    return outcome.config
  }
  if (outcome.verdict === 'transport') return fromMemory()
  applyMedia(seq, null)
  if (current()) forgetDiscovered()
  report({ source: 'invalid' })
  return null
}

async function liveOutcome () {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 8000)
  try {
    return discoveryOutcome(await fetchDiscovery(abort.signal), validate)
  } catch {
    return { verdict: 'transport' }
  } finally {
    clearTimeout(timer)
  }
}

// The detached live fetch of a preferRemembered start (see discoverConfig).
async function revalidate (seq, remembered, onRevalidated, current) {
  let result
  try {
    const outcome = await liveOutcome()
    if (outcome.verdict === 'live') applyMedia(seq, outcome.config.media)
    else if (outcome.verdict !== 'transport') applyMedia(seq, null)
    if (!current()) return
    if (outcome.verdict === 'live') {
      const { config } = outcome
      rememberDiscovered(config)
      const same = config.association === remembered.association && config.seederUrl === remembered.seederUrl
      result = same ? { verdict: 'same' } : { verdict: 'changed', config }
    } else if (outcome.verdict === 'transport') {
      result = { verdict: 'transport' }
    } else {
      forgetDiscovered()
      result = { verdict: 'invalid' }
    }
  } catch {
    result = { verdict: 'transport' }
  }
  if (!current() || typeof onRevalidated !== 'function') return
  try { onRevalidated(result) } catch {}
}

// Classifies from the headers before reading any body: a transport status
// (408, 429, 5xx) or a redirect is returned unread; any other non-2xx or a
// content type that is not JSON has its body cancelled unread (it is an
// answer, and an invalid one, even if its body would never arrive). Only a
// 2xx JSON body is read, bounded by MAX_DISCOVERY_BYTES, inside the caller's
// abort window. A failed fetch, or a failed read of that body (abort,
// network), is { kind: 'threw' }: the installation did not answer in full.
async function fetchDiscovery (signal) {
  let res
  try {
    res = await fetch('/varanda.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal })
  } catch {
    return { kind: 'threw' }
  }
  const { status, redirected } = res
  let contentType = ''
  try { contentType = res.headers.get('content-type') || '' } catch {}
  const result = { kind: 'response', status, contentType, text: '', redirected }
  if (redirected === true || status === 408 || status === 429 || (status >= 500 && status <= 599)) return result
  if (!(status >= 200 && status <= 299) || !/application\/json/i.test(contentType)) {
    try { if (res.body) res.body.cancel().catch(() => {}) } catch {}
    return result
  }
  try {
    return { ...result, ...(await readBounded(res)) }
  } catch {
    return { kind: 'threw' }
  }
}

// -> { text } | { oversized: true } | { invalidText: true }; throws when the
// read fails. Without a readable body (old engines) it falls back to
// res.text(), whose size discoveryOutcome still checks.
async function readBounded (res) {
  if (!res.body || typeof res.body.getReader !== 'function') return { text: await res.text() }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_DISCOVERY_BYTES) {
      try { reader.cancel().catch(() => {}) } catch {}
      return { oversized: true }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { invalidText: true }
  }
}
