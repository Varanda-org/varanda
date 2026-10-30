// iOS/Android: the padded seen list of Avisos, as text in the app's document
// dir (next to varanda-config.json, never inside the node data dir). Read
// synchronously like localStorage on the web. Never throws.

import { File, Paths } from 'expo-file-system'

const FILE_NAME = 'varanda-avisos-vistos.json'

function file (suffix = '') {
  return new File(Paths.document, FILE_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a crash mid-write would leave a partial
// list that parses as empty and loses every seen token. The text goes whole
// to a .tmp file, the old one is set aside (.bak) and only dropped once the
// new one is in place. move never overwrites, hence the steps (same as
// configStore.native.js).
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

export function loadSeenText () {
  try {
    let f = file()
    if (!f.exists) f = file('.bak')
    if (!f.exists) return null
    return f.textSync()
  } catch {
    return null
  }
}

export function saveSeenText (text) {
  try {
    replaceFile(text)
  } catch {}
}

export function clearSeenText () {
  removeQuietly(file())
  removeQuietly(file('.bak'))
  removeQuietly(file('.tmp'))
}
