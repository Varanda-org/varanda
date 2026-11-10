// iOS/Android: the per-screen snapshots (./screenSnapshot.js), one text file
// per kind in the app's document dir (next to varanda-config.json, never
// inside the node data dir). Read synchronously, so a screen's first frame
// can paint it. Never throws.
// The Vitrine (src/vitrine/enabled.js) must never read this device's real
// snapshots nor write fixtures over them: the caller must not call this
// store in Vitrine mode.

import { File, Paths } from 'expo-file-system'
import { SCREEN_SNAPSHOT_KINDS, SCREEN_SNAPSHOT_MAX_BYTES, createScreenSnapshotStore } from './screenSnapshot.js'

// A screen paints a snapshot first only where this is true (see the web twin).
export const previewCapable = true

function file (kind, suffix = '') {
  return new File(Paths.document, 'varanda-screen-' + kind + '.json' + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

function clear (kind) {
  if (!SCREEN_SNAPSHOT_KINDS.includes(kind)) return
  removeQuietly(file(kind))
  removeQuietly(file(kind, '.bak'))
  removeQuietly(file(kind, '.tmp'))
}

// File.write truncates in place, so a crash mid-write would leave a partial
// text that no longer parses. The text goes whole to a .tmp file, the old
// one is set aside (.bak) and only dropped once the new one is in place.
// move never overwrites, hence the steps (same as feedSnapshotStore.native.js).
function replaceFile (kind, text) {
  const f = (suffix) => file(kind, suffix)
  removeQuietly(f('.tmp'))
  try {
    f('.tmp').create()
    f('.tmp').write(text)
  } catch (err) {
    removeQuietly(f('.tmp'))
    throw err
  }
  if (!f().exists && f('.bak').exists) {
    try { f('.bak').move(f()) } catch {}
  }
  // A .bak that could not be put back is still the only good copy: keep it.
  if (f().exists) removeQuietly(f('.bak'))
  const hadCurrent = f().exists
  try {
    if (hadCurrent) f().move(f('.bak'))
    f('.tmp').move(f())
  } catch (err) {
    if (hadCurrent && !f().exists && f('.bak').exists) {
      try { f('.bak').move(f()) } catch {}
    }
    removeQuietly(f('.tmp'))
    throw err
  }
  removeQuietly(f('.bak'))
}

// A file over the cap is never read whole: it could only be refused after.
export function loadScreenSnapshotText (kind) {
  if (!SCREEN_SNAPSHOT_KINDS.includes(kind)) return null
  try {
    let f = file(kind)
    if (!f.exists) f = file(kind, '.bak')
    if (!f.exists) return null
    let size
    try { size = f.size } catch { size = NaN }
    // undefined: a File without size (older API, test stubs); the text
    // length below still bounds it.
    if (size !== undefined && !(typeof size === 'number' && size >= 0 && size <= SCREEN_SNAPSHOT_MAX_BYTES)) {
      clear(kind)
      return null
    }
    const text = f.textSync()
    if (typeof text !== 'string' || text.length > SCREEN_SNAPSHOT_MAX_BYTES) {
      clear(kind)
      return null
    }
    return text
  } catch {
    return null
  }
}

function save (kind, text) {
  if (!SCREEN_SNAPSHOT_KINDS.includes(kind) || typeof text !== 'string') return
  try {
    replaceFile(kind, text)
  } catch {}
}

export const {
  loadScreenSnapshot,
  saveScreenSnapshot,
  clearScreenSnapshot,
  clearScreenSnapshots
} = createScreenSnapshotStore({ load: loadScreenSnapshotText, save, clear })
