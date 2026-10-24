// The non-secret node configuration, as JSON in the app's document dir
// (next to, not inside, the node's own data dir "varanda").

import { File, Paths } from 'expo-file-system'
import { revive } from './config'

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

export const canConfigure = true

// No hosted installation on native: the person configures the node.
export async function discoverConfig () {
  return null
}

export async function clearConfig () {}

export const hostedPage = false
