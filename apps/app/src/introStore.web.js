import { STORAGE_KEY, introRecordOf } from './intro.js'

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

export async function loadIntroRecord () {
  try {
    const raw = storage().getItem(STORAGE_KEY)
    if (typeof raw !== 'string') return null
    return introRecordOf(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function saveIntroRecord (record) {
  try {
    const valid = introRecordOf(record)
    if (valid === null) return false
    storage().setItem(STORAGE_KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}
