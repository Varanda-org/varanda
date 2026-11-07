// iOS/Android: the age check memory, as JSON in the app's document dir (next
// to varanda-terms.json). Validated on every read and write; never throws.

import { File, Paths } from 'expo-file-system'
import { AGE_RECORD_UNREADABLE, FILE_NAME, ageRecordOf, ageRecordRead } from './ageMemory.js'

function file (suffix = '') {
  return new File(Paths.document, FILE_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a crash mid-write would leave a partial
// record and lose every refusal. The text goes whole to a .tmp file, the old
// one is set aside (.bak) and only dropped once the new one is in place. move
// never overwrites, hence the steps (same as appearanceStore.native.js).
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

// null: no record. AGE_RECORD_UNREADABLE: a file is there but cannot be
// trusted, so a save must not replace it.
export async function loadAgeRecord () {
  try {
    let f = file()
    if (!f.exists) f = file('.bak')
    if (!f.exists) return null
    return ageRecordRead(JSON.parse(await f.text()))
  } catch {
    return AGE_RECORD_UNREADABLE
  }
}

export async function saveAgeRecord (record) {
  try {
    const valid = ageRecordOf(record)
    if (valid === null) return false
    replaceFile(JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

// One app process: no other writer to hear from.
export function onAgeRecordChange () {
  return () => {}
}

// One app process, and the hook already saves one change after another.
export async function withAgeLock (fn) {
  return fn()
}
