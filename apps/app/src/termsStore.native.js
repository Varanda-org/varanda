// iOS/Android: the terms acceptance record, as JSON in the app's document dir
// (next to varanda-config.json). Validated on every read; never throws.

import { File, Paths } from 'expo-file-system'
import { FILE_NAME, termsRecordOf } from './terms.js'

function file () {
  return new File(Paths.document, FILE_NAME)
}

export async function loadTermsRecord () {
  try {
    const f = file()
    if (!f.exists) return null
    return termsRecordOf(JSON.parse(await f.text()))
  } catch {
    return null
  }
}

export async function saveTermsRecord (record) {
  try {
    const valid = termsRecordOf(record)
    if (valid === null) return false
    const f = file()
    if (!f.exists) f.create()
    f.write(JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}
