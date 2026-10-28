// Web: the terms acceptance record lives in localStorage (it must outlive the
// tab: accepting once per device is the point). It is untrusted on every read,
// so terms.js validates it. localStorage is read inside each call, never at
// import, and every access is guarded (private modes and sandboxed frames
// throw).

import { STORAGE_KEY, termsRecordOf } from './terms.js'

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

export async function loadTermsRecord () {
  try {
    const raw = storage().getItem(STORAGE_KEY)
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
    storage().setItem(STORAGE_KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}
