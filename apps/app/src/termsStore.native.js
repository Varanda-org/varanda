// iOS/Android: the terms acceptance record, as JSON in the app's document dir
// (next to varanda-config.json). Validated on every read; never throws.
/* global __DEV__ */

import { File, Paths } from 'expo-file-system'
import { FILE_NAME, termsRecordOf } from './terms.js'
import { vitrineEnabled } from './vitrine/enabled.js'

// The Vitrine (src/vitrine/enabled.js) seeds its own record in its own file,
// so this device's real acceptances are never read or overwritten. The
// literal member access is what Expo inlines into the bundle.
const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)
const VITRINE_FILE_NAME = 'varanda-terms-vitrine.json'

function file () {
  return new File(Paths.document, VITRINE ? VITRINE_FILE_NAME : FILE_NAME)
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
