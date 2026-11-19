import { File, Paths } from 'expo-file-system'
import { createBackfillFileStore } from './coverBackfill.js'

function file (suffix = '') {
  return new File(Paths.document, 'varanda-cover-backfill.json' + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place; keep the last ledger until the replacement is whole.
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

function readText () {
  let f = file()
  if (!f.exists) f = file('.bak')
  return f.exists ? f.text() : null
}

const store = createBackfillFileStore({ read: readText, write: replaceFile })

export const read = store.read
export const write = store.write

export function exclusive (fn) {
  return fn()
}
