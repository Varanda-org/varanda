// The non-secret node configuration, as JSON in the app's document dir
// (next to, not inside, the node's own data dir "varanda").

/* global fetch, AbortController */

import { File, Paths } from 'expo-file-system'
import { revive } from './config'
import { installationOrigin, setInstallation } from './installation'
import { setAppClient } from './appClient'
import { hostedOutcome, redirectedAway, rememberedHosted, MAX_DISCOVERY_BYTES } from './discoverHosted'

function file () {
  return new File(Paths.document, 'varanda-config.json')
}

export async function loadConfig () {
  try {
    const f = file()
    if (!f.exists) return null
    return revive(JSON.parse(await f.text()))
  } catch {
    return null
  }
}

export async function saveConfig (config) {
  const f = file()
  if (!f.exists) f.create()
  f.write(JSON.stringify(config))
}

// The installation the app talks to lives in its own file: src/node.js reads
// any saved core config as the person's explicit manual choice, so it must
// never be mixed into varanda-config.json.
const INSTALLATION_NAME = 'varanda-installation.json'

function installationFile (suffix = '') {
  return new File(Paths.document, INSTALLATION_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a failed write would leave a partial
// file. The new content is written whole to a temporary file first; the old
// file is set aside (.bak) and only dropped once the new one is in place.
// expo-file-system's move never overwrites, hence the three steps.
function replaceInstallationFile (text) {
  const tmp = installationFile('.tmp')
  removeQuietly(tmp)
  try {
    tmp.create()
    tmp.write(text)
  } catch (err) {
    removeQuietly(installationFile('.tmp'))
    throw err
  }
  // A set-aside file with no current one is the last choice: restore it
  // first, so a failure below still leaves it in place.
  if (!installationFile().exists && installationFile('.bak').exists) {
    try { installationFile('.bak').move(installationFile()) } catch {}
  }
  // A .bak that could not be put back is still the only good copy: keep it.
  if (installationFile().exists) removeQuietly(installationFile('.bak'))
  const current = installationFile()
  const hadCurrent = current.exists
  try {
    if (hadCurrent) current.move(installationFile('.bak'))
    installationFile('.tmp').move(installationFile())
  } catch (err) {
    if (hadCurrent && !installationFile().exists && installationFile('.bak').exists) {
      try { installationFile('.bak').move(installationFile()) } catch {}
    }
    removeQuietly(installationFile('.tmp'))
    throw err
  }
  removeQuietly(installationFile('.bak'))
}

async function savedInstallation () {
  try {
    let f = installationFile()
    // Interrupted between setting the old file aside and moving the new one
    // in: the old choice still counts.
    if (!f.exists) f = installationFile('.bak')
    if (!f.exists) return null
    const value = JSON.parse(await f.text())
    if (value === null || typeof value !== 'object' || value.v !== 1 || typeof value.origin !== 'string') return null
    return value.origin
  } catch {
    return null
  }
}

// The saved installation, else the build-time one (Metro inlines
// EXPO_PUBLIC_VARANDA_INSTALLATION into the bundle). Either is used only once
// setInstallation accepts it. -> the origin or null.
export async function loadInstallation () {
  const saved = await savedInstallation()
  const built = process.env.EXPO_PUBLIC_VARANDA_INSTALLATION
  for (const value of [saved, built]) {
    if (typeof value === 'string' && value !== '' && setInstallation(value)) {
      setAppClient(true)
      return installationOrigin()
    }
  }
  return null
}

// null forgets the saved choice (the build-time one applies again, as on the
// next launch). -> true, or false for an invalid origin, which changes
// nothing in memory or on disk.
export async function saveInstallation (origin) {
  if (origin === null) {
    const f = installationFile()
    if (f.exists) f.delete()
    removeQuietly(installationFile('.bak'))
    removeQuietly(installationFile('.tmp'))
    setInstallation(null)
    setAppClient(false)
    await loadInstallation()
    return true
  }
  const previous = installationOrigin()
  if (!setInstallation(origin)) return false
  // The remembered /varanda.json of the same installation stays, so
  // applying the same address again keeps the offline fallback.
  const current = await readInstallationValue()
  const next = { v: 1, origin: installationOrigin() }
  const discovered = current !== null ? current.discovered : undefined
  if (discovered !== null && typeof discovered === 'object' && discovered.origin === next.origin) next.discovered = discovered
  try {
    replaceInstallationFile(JSON.stringify(next))
  } catch (err) {
    setInstallation(previous)
    throw err
  }
  setAppClient(true)
  return true
}

export const canConfigure = true

async function readInstallationValue () {
  try {
    let f = installationFile()
    if (!f.exists) f = installationFile('.bak')
    if (!f.exists) return null
    const value = JSON.parse(await f.text())
    return value !== null && typeof value === 'object' && value.v === 1 ? value : null
  } catch {
    return null
  }
}

// The last valid /varanda.json of the current installation is kept inside
// varanda-installation.json under its own key, next to the saved choice. A
// build-time installation is not written as a saved one: without a saved
// origin the file carries only the remembered answer, which
// savedInstallation ignores. Never the core config file.
async function writeDiscovered (discovered) {
  const value = await readInstallationValue()
  const next = { v: 1 }
  if (value !== null && typeof value.origin === 'string') next.origin = value.origin
  if (discovered !== null) next.discovered = discovered
  if (next.origin === undefined && next.discovered === undefined) {
    removeQuietly(installationFile())
    removeQuietly(installationFile('.bak'))
    removeQuietly(installationFile('.tmp'))
    return
  }
  replaceInstallationFile(JSON.stringify(next))
}

async function rememberDiscovered (origin, config) {
  try {
    await writeDiscovered({ v: 1, origin, association: config.association })
    return true
  } catch {
    return false
  }
}

async function loadDiscovered (origin) {
  const value = await readInstallationValue()
  return value === null ? null : rememberedHosted(value.discovered, { installation: origin })
}

async function forgetDiscovered () {
  const value = await readInstallationValue()
  if (value === null || value.discovered === undefined) return
  try { await writeDiscovered(null) } catch {}
}

// The chosen installation's /varanda.json, with the rules of the hosted web
// page (configStore.web.js): null when no installation is set or on any
// failure, never throws. A live answer is remembered; the remembered one is
// used only when the installation does not answer (offline, network error,
// 408/429/5xx, redirect). An answer that is not a valid configuration
// forgets it. options: { onStatus, onLine }; onStatus({ source, persisted? })
// is called at most once, source: 'live' | 'remembered' | 'none' | 'invalid'.
export async function discoverConfig (options = {}) {
  const origin = installationOrigin()
  if (origin === null) return null
  const { onStatus, onLine } = options || {}
  const report = (status) => {
    if (typeof onStatus !== 'function') return
    try { onStatus(status) } catch {}
  }
  const fromMemory = async () => {
    const remembered = await loadDiscovered(origin)
    report({ source: remembered ? 'remembered' : 'none' })
    return remembered
  }
  if (onLine === false) return fromMemory()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 8000)
  let outcome
  try {
    outcome = hostedOutcome(await fetchDiscovery(origin, abort.signal), { installation: origin })
  } catch {
    outcome = { verdict: 'transport' }
  } finally {
    clearTimeout(timer)
  }
  // Another installation was chosen meanwhile: this answer is not its own.
  if (installationOrigin() !== origin) return null
  if (outcome.verdict === 'live') {
    report({ source: 'live', persisted: await rememberDiscovered(origin, outcome.config) })
    return outcome.config
  }
  if (outcome.verdict === 'transport') return fromMemory()
  await forgetDiscovered()
  report({ source: 'invalid' })
  return null
}

// As configStore.web.js fetchDiscovery: the headers classify first and only a
// 2xx JSON body is read. React Native's fetch has no readable body stream and
// res.text() buffers the whole body, so only a canonical Content-Length within
// the cap is read; a missing, non-canonical or larger one is refused unread
// (the installation's Caddy always sends Content-Length for this static
// file). The text that is read is measured again by hostedOutcome.
function declaredWithin (length) {
  return typeof length === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(length) && Number(length) <= MAX_DISCOVERY_BYTES
}

async function fetchDiscovery (installation, signal) {
  const url = installation + '/varanda.json'
  let res
  try {
    // No cache option: React Native's fetch (whatwg-fetch) turns 'no-store' and
    // 'no-cache' into a ?_=<time> query, and redirectedAway refuses an answer
    // whose URL carries a query.
    res = await fetch(url, { credentials: 'omit', redirect: 'error', signal })
  } catch {
    return { kind: 'threw' }
  }
  const { status } = res
  let redirected = true
  try { redirected = redirectedAway({ redirected: res.redirected, url: res.url }, { installation }) } catch {}
  let contentType = ''
  let length = null
  try {
    contentType = res.headers.get('content-type') || ''
    length = res.headers.get('content-length')
  } catch {}
  const result = { kind: 'response', status, contentType, text: '', redirected }
  if (redirected === true || status === 408 || status === 429 || (status >= 500 && status <= 599)) return result
  if (!(status >= 200 && status <= 299) || !/application\/json/i.test(contentType)) return result
  if (!declaredWithin(length)) return { ...result, oversized: true }
  try {
    return { ...result, text: await res.text() }
  } catch {
    return { kind: 'threw' }
  }
}

// Drops the saved manual (core) configuration: the installation applies again.
export async function clearConfig () {
  removeQuietly(file())
}

// A web-only notion (a page served by the installation): on native the
// connected configuration's kind ('hosted') says it instead.
export const hostedPage = false
