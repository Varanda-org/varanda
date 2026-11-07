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

export function setPreviewsEnabled (store, on) {
  try {
    if (typeof on !== 'boolean') return false
    store.setItem(KEY, JSON.stringify({ v: 1, enabled: on }))
    return true
  } catch {
    return false
  }
}
