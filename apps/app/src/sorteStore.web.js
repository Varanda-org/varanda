// Web: the per-device salt of an older Sorte do dia is forgotten. Every access
// is guarded (private modes and sandboxed frames throw).
export const STORAGE_KEY = 'varanda-sorte'

export function forgetSalt () {
  try { globalThis.localStorage.removeItem(STORAGE_KEY) } catch {}
}
