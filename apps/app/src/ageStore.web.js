// Web: the age check memory lives in localStorage (it must outlive the tab, or
// the age step would come back after every splash). It is untrusted on every
// read, so ageMemory.js validates it. localStorage is read inside each call,
// never at import, and every access is guarded (private modes and sandboxed
// frames throw).

import { AGE_RECORD_UNREADABLE, STORAGE_KEY, ageRecordOf, ageRecordRead } from './ageMemory.js'

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

// null: no record. AGE_RECORD_UNREADABLE: something is there (or storage
// cannot be read), so a save must not replace it.
export async function loadAgeRecord () {
  try {
    const raw = storage().getItem(STORAGE_KEY)
    if (raw === null) return null
    if (typeof raw !== 'string') return AGE_RECORD_UNREADABLE
    return ageRecordRead(JSON.parse(raw))
  } catch {
    return AGE_RECORD_UNREADABLE
  }
}

export async function saveAgeRecord (record) {
  try {
    const valid = ageRecordOf(record)
    if (valid === null) return false
    storage().setItem(STORAGE_KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

// Another tab's save (the 'storage' event fires only in the other tabs of the
// origin; a null key is a clear()). The unsubscribe function, or a no-op where
// there is no window.
export function onAgeRecordChange (cb) {
  try {
    const w = globalThis.window
    if (!w || typeof w.addEventListener !== 'function') return () => {}
    const handler = (e) => {
      if (e && (e.key === STORAGE_KEY || e.key === null)) cb()
    }
    w.addEventListener('storage', handler)
    return () => {
      try { w.removeEventListener('storage', handler) } catch {}
    }
  } catch {
    return () => {}
  }
}

// localStorage is shared by every tab of the origin, so a read, change and
// save in one tab could overwrite a refusal another tab saved in between.
// Web Locks serialize them across tabs; without the API, runs fn directly.
export async function withAgeLock (fn) {
  let locks = null
  try { locks = globalThis.navigator?.locks || null } catch {}
  if (locks === null || typeof locks.request !== 'function') return fn()
  return locks.request('varanda-age', () => fn())
}
