// iOS/Android: the chosen appearance mode as text in the app's document dir.
// Read synchronously so the first frame already has the right palette (an
// async read would flash the light one). Never throws.

import { File, Paths } from 'expo-file-system'
import { FILE_NAME, appearanceRecordOf } from './appearance.js'

function file (suffix = '') {
  return new File(Paths.document, FILE_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a crash mid-write would leave a partial
// record that parses as nothing and loses the choice. The text goes whole to
// a .tmp file, the old one is set aside (.bak) and only dropped once the new
// one is in place. move never overwrites, hence the steps (same as
// seenStore.native.js).
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

export function loadAppearanceRecord () {
  try {
    let f = file()
    if (!f.exists) f = file('.bak')
    if (!f.exists) return null
    return appearanceRecordOf(JSON.parse(f.textSync()))
  } catch {
    return null
  }
}

export function saveAppearanceRecord (record) {
  try {
    const valid = appearanceRecordOf(record)
    if (valid === null) return false
    replaceFile(JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

export function applySchemeToDocument () {}

export function applyBandMeta () {}
