// Web: the per-device salt of the Sorte do dia lives in localStorage. Every
// access is guarded (private modes and sandboxed frames throw); without
// storage the salt is made fresh and the day's line may change per visit.
import { isSalt, newSalt } from './sorte.js'

export const STORAGE_KEY = 'varanda-sorte'

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

export async function loadSalt () {
  let saved = null
  try {
    const raw = storage().getItem(STORAGE_KEY)
    if (typeof raw === 'string' && isSalt(raw)) saved = raw
  } catch {}
  if (saved !== null) return saved
  const salt = newSalt()
  try { storage().setItem(STORAGE_KEY, salt) } catch {}
  return salt
}
