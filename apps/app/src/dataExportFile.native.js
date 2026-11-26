import { Platform, Share } from 'react-native'
import { Directory, File, Paths } from 'expo-file-system'

// React Native Share attaches a file URL only on iOS; Android takes text only.
export const exportDelivery = Object.freeze({ save: true, share: Platform.OS === 'ios' })

const CACHE_DIR = 'varanda-export'
// iOS never settles Share.share when the person picks an app and then
// cancels inside it. After this long the screen takes taps again; the copy
// stays in the cache folder until clearExportCache, since the app may still
// be reading it.
const SHARE_SETTLE_MS = 60000
// iOS createFile refuses a name that exists (a second export the same day);
// Android picks a free name itself.
const NAME_TRIES = 9

const cacheDir = () => new Directory(Paths.cache, CACHE_DIR)

export function clearExportCache () {
  try {
    const dir = cacheDir()
    if (dir.exists) dir.delete()
  } catch {}
}

function numbered (name, n) {
  return n === 1 ? name : name.replace(/\.json$/, '') + '-' + n + '.json'
}

function createFree (dir, name) {
  let error
  for (let n = 1; n <= NAME_TRIES; n++) {
    try {
      return dir.createFile(numbered(name, n), 'application/json')
    } catch (err) {
      error = err
    }
  }
  throw error
}

export async function saveExport (name, text) {
  clearExportCache()
  let dir
  try {
    dir = await Directory.pickDirectoryAsync()
  } catch (err) {
    const detail = err ? [err.name, err.code, err.message].join(' ') : ''
    if (/cancel|dismiss|abort/i.test(detail)) return { ok: false, reason: 'cancelled' }
    return { ok: false }
  }
  let file
  try {
    file = createFree(dir, name)
    file.write(text)
    return { ok: true }
  } catch {
    // An empty or partial file in the person's folder would pass for an export.
    try { if (file) file.delete() } catch {}
    return { ok: false }
  }
}

export async function shareExport (name, text) {
  if (!exportDelivery.share) return { ok: false, reason: 'unavailable' }
  clearExportCache()
  let file
  let settled = false
  let timer
  try {
    const dir = cacheDir()
    dir.create({ intermediates: true, idempotent: true })
    file = new File(dir, name)
    file.create({ overwrite: true })
    file.write(text)
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SHARE_SETTLE_MS) })
    const result = await Promise.race([Share.share({ url: file.uri }), late])
    if (result === null) return { ok: false, reason: 'cancelled' }
    settled = true
    if (result.action === Share.dismissedAction) return { ok: false, reason: 'cancelled' }
    return { ok: result.action === Share.sharedAction }
  } catch {
    settled = true
    return { ok: false }
  } finally {
    clearTimeout(timer)
    if (settled) clearExportCache()
  }
}
