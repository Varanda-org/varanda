// iOS/Android: saved posts live in one JSON file in the app's documents,
// keyed by origin and own diary key inside the file (savedPosts.js). Writes
// are atomic (.tmp, .bak, move) like seenStore.native.js; a read falls back
// to the .bak a crash may have left.

import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createSavedStore } from './savedPosts.js'

function file (suffix = '') {
  return new File(Paths.document, FILE_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a crash mid-write would leave a partial
// list that parses as empty and loses every saved post. The text goes whole
// to a .tmp file, the old one is set aside (.bak) and only dropped once the
// new one is in place. move never overwrites, hence the steps (same as
// seenStore.native.js and configStore.native.js). Throws when it fails.
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

// null when there is no file yet; a read that throws is a failed read.
function readText () {
  let f = file()
  if (!f.exists) f = file('.bak')
  return f.exists ? f.text() : null
}

const store = createSavedStore({ read: readText, write: replaceFile })

export const loadSaved = store.load
export const hasSaved = store.has
export const addSaved = store.add
export const removeSaved = store.remove
export const forgetSavedScope = store.forgetScope
export const forgetSavedKey = store.forgetKey
