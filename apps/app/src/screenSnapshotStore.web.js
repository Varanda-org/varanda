// Web: the per-screen snapshots (./screenSnapshot.js) in localStorage, one
// key per kind. localStorage is read inside each call, never at import, and
// every access is guarded (private modes and sandboxed frames throw). Never
// throws.
// The Vitrine (src/vitrine/enabled.js) must never read this device's real
// snapshots nor write fixtures over them: the caller must not call this
// store in Vitrine mode.

import { SCREEN_SNAPSHOT_KINDS, SCREEN_SNAPSHOT_MAX_BYTES, createScreenSnapshotStore } from './screenSnapshot.js'

// Same flag as A Rua's web store: the shared screens decide by it, not by
// Platform.OS.
export const previewCapable = false

const keyOf = (kind) => 'varanda-screen-' + kind

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

function clear (kind) {
  if (!SCREEN_SNAPSHOT_KINDS.includes(kind)) return
  try {
    storage().removeItem(keyOf(kind))
  } catch {}
}

// A longer text is over the cap in bytes too.
export function loadScreenSnapshotText (kind) {
  if (!SCREEN_SNAPSHOT_KINDS.includes(kind)) return null
  try {
    const raw = storage().getItem(keyOf(kind))
    if (typeof raw !== 'string') return null
    if (raw.length > SCREEN_SNAPSHOT_MAX_BYTES) {
      clear(kind)
      return null
    }
    return raw
  } catch {
    return null
  }
}

function save (kind, text) {
  if (!SCREEN_SNAPSHOT_KINDS.includes(kind) || typeof text !== 'string') return
  try {
    storage().setItem(keyOf(kind), text)
  } catch {}
}

export const {
  loadScreenSnapshot,
  saveScreenSnapshot,
  clearScreenSnapshot,
  clearScreenSnapshots
} = createScreenSnapshotStore({ load: loadScreenSnapshotText, save, clear })
