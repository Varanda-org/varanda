export const PREVIEW_PREF_LABEL = 'Prévia de links'

const KEY = 'varanda-previas-links'

// Like appearance preferences, reads are synchronous and records are versioned JSON.
export function previewsEnabled (store) {
  try {
    const raw = store.getItem(KEY)
    if (typeof raw !== 'string') return true
    const record = JSON.parse(raw)
    return !(record && record.v === 1 && record.enabled === false)
  } catch {
    return true
  }
}

const listeners = new Set()

// The players follow the switch at once (./ui/usePreviewsEnabled), not only
// the cards mounted after it changed.
export function onPreviewsChange (fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function setPreviewsEnabled (store, on) {
  if (typeof on !== 'boolean') return false
  try {
    store.setItem(KEY, JSON.stringify({ v: 1, enabled: on }))
  } catch {
    return false
  }
  for (const fn of [...listeners]) {
    try { fn(on) } catch {}
  }
  return true
}
