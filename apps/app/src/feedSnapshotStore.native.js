// iOS/Android: A Rua's snapshot (./feedSnapshot.js) as text in the app's
// document dir (next to varanda-config.json, never inside the node data
// dir). Read synchronously, so the first frame of A Rua can paint it.
// Never throws.
// The Vitrine (src/vitrine/enabled.js) must never read this device's real
// snapshot nor write fixtures over it: the caller must not call this store
// in Vitrine mode (test/vitrineGuard.test.js keeps the vitrine flag to a few
// modules, so the store does not import it).

import { File, Paths } from 'expo-file-system'

const FILE_NAME = 'varanda-rua-snapshot.json'

// A Rua paints a snapshot first only where this is true (see the web twin).
export const previewCapable = true

function file (suffix = '') {
  return new File(Paths.document, FILE_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a crash mid-write would leave a partial
// text that no longer parses. The text goes whole to a .tmp file, the old
// one is set aside (.bak) and only dropped once the new one is in place.
// move never overwrites, hence the steps (same as seenStore.native.js).
function replaceFile (text) {
  removeQuietly(file('.tmp'))
  try {
    file('.tmp').create()
    file('.tmp').write(text)
  } catch (err) {
    removeQuietly(file('.tmp'))
    throw err
  }
  if (!file().exists && file('.bak').exists) {
    try { file('.bak').move(file()) } catch {}
  }
  // A .bak that could not be put back is still the only good copy: keep it.
  if (file().exists) removeQuietly(file('.bak'))
  const hadCurrent = file().exists
  try {
    if (hadCurrent) file().move(file('.bak'))
    file('.tmp').move(file())
  } catch (err) {
    if (hadCurrent && !file().exists && file('.bak').exists) {
      try { file('.bak').move(file()) } catch {}
    }
    removeQuietly(file('.tmp'))
    throw err
  }
  removeQuietly(file('.bak'))
}

export function loadSnapshotText () {
  try {
    let f = file()
    if (!f.exists) f = file('.bak')
    if (!f.exists) return null
    return f.textSync()
  } catch {
    return null
  }
}

export function saveSnapshotText (text) {
  if (typeof text !== 'string') return
  try {
    replaceFile(text)
  } catch {}
}

export function clearSnapshot () {
  removeQuietly(file())
  removeQuietly(file('.bak'))
  removeQuietly(file('.tmp'))
}
