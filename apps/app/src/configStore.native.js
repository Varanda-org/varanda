// The non-secret node configuration, as JSON in the app's document dir
// (next to, not inside, the node's own data dir "varanda").

import { File, Paths } from 'expo-file-system'
import { revive } from './config'
import { installationOrigin, setInstallation } from './installation'
import { setAppClient } from './appClient'

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
  try {
    replaceInstallationFile(JSON.stringify({ v: 1, origin: installationOrigin() }))
  } catch (err) {
    setInstallation(previous)
    throw err
  }
  setAppClient(true)
  return true
}

export const canConfigure = true

// No hosted installation on native: the person configures the node.
export async function discoverConfig () {
  return null
}

export async function clearConfig () {}

export const hostedPage = false
