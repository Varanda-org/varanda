// Web: the terms acceptance record lives in localStorage (it must outlive the
// tab: accepting once per device is the point). It is untrusted on every read,
// so terms.js validates it. localStorage is read inside each call, never at
// import, and every access is guarded (private modes and sandboxed frames
// throw).
/* global __DEV__ */

import { STORAGE_KEY, termsRecordOf } from './terms.js'
import { vitrineEnabled } from './vitrine/enabled.js'

// The Vitrine (src/vitrine/enabled.js) seeds its own record under its own key,
// so this device's real acceptances are never read or overwritten. The
// literal member access is what Expo inlines into the bundle.
const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)
const VITRINE_KEY = 'varanda-terms-vitrine'
const KEY = VITRINE ? VITRINE_KEY : STORAGE_KEY

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

export async function loadTermsRecord () {
  try {
    const raw = storage().getItem(KEY)
    if (typeof raw !== 'string') return null
    return termsRecordOf(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function saveTermsRecord (record) {
  try {
    const valid = termsRecordOf(record)
    if (valid === null) return false
    storage().setItem(KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}
