import { STORAGE_KEY, appearanceRecordOf } from './appearance.js'

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

// Synchronous like the native store, so the first render has the right palette.
export function loadAppearanceRecord () {
  try {
    const raw = storage().getItem(STORAGE_KEY)
    if (typeof raw !== 'string') return null
    return appearanceRecordOf(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveAppearanceRecord (record) {
  try {
    const valid = appearanceRecordOf(record)
    if (valid === null) return false
    storage().setItem(STORAGE_KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

export function applySchemeToDocument (scheme, { bg, themeColor } = {}) {
  try {
    document.documentElement.style.colorScheme = scheme
    // index.html repaints the boot overlay from this, so a manual choice that
    // differs from the system's holds for the rest of the boot.
    document.documentElement.dataset.scheme = scheme
  } catch {}
  // Both: index.html paints html and body dark by media query, and an inline
  // style on html alone leaves a dark body under a manual Claro.
  try {
    document.documentElement.style.backgroundColor = bg
    document.body.style.backgroundColor = bg
  } catch {}
  const color = typeof themeColor === 'string' ? themeColor : bg
  if (typeof color !== 'string') return
  try {
    // A media-scoped meta would win when the OS and the manual choice disagree.
    for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
      meta.setAttribute('content', color)
      meta.removeAttribute('media')
    }
  } catch {}
}

// The sunset band paints the top of the screen, so the browser chrome takes
// its top colour while the band shows and the scheme bg otherwise.
export function applyBandMeta (on, bg) {
  const color = on ? '#f7b267' : bg
  if (typeof color !== 'string') return
  try {
    for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
      meta.setAttribute('content', color)
      meta.removeAttribute('media')
    }
  } catch {}
}
