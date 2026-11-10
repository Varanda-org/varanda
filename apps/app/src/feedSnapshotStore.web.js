// Web: A Rua's snapshot (./feedSnapshot.js) in localStorage. localStorage is
// read inside each call, never at import, and every access is guarded
// (private modes and sandboxed frames throw). Never throws.
// The Vitrine (src/vitrine/enabled.js) must never read this device's real
// snapshot nor write fixtures over it: the caller must not call this store
// in Vitrine mode (test/vitrineGuard.test.js keeps the vitrine flag to a few
// modules, so the store does not import it).

const KEY = 'varanda-rua-snapshot'

// A Rua paints a snapshot first only on the phone. The web keeps the same
// API, so the shared screen decides by this flag, not by Platform.OS.
export const previewCapable = false

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

export function loadSnapshotText () {
  try {
    const raw = storage().getItem(KEY)
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

export function saveSnapshotText (text) {
  if (typeof text !== 'string') return
  try {
    storage().setItem(KEY, text)
  } catch {}
}

export function clearSnapshot () {
  try {
    storage().removeItem(KEY)
  } catch {}
}
