// Loaded by index.html in <head>, before the body parses: the pre-splash then
// paints in the Ajustes > Aparência choice instead of the system's. A file and
// not inline code because of CSP script-src 'self'. Same key and record as
// src/appearanceStore.web.js; with nothing stored (or 'system') the media
// query in index.html decides. Never throws.
;(function () {
  try {
    const record = JSON.parse(globalThis.localStorage.getItem('varanda-aparencia'))
    const mode = record !== null && typeof record === 'object' && record.v === 1 ? record.mode : null
    if (mode !== 'light' && mode !== 'dark') return
    const doc = globalThis.document
    const root = doc.documentElement
    root.dataset.scheme = mode
    root.style.colorScheme = mode
    const bg = mode === 'dark' ? '#101010' : '#fbf8f3'
    root.style.backgroundColor = bg
    // A media-scoped meta would win when the system and the choice disagree.
    for (const meta of doc.querySelectorAll('meta[name=theme-color]')) {
      meta.setAttribute('content', bg)
      meta.removeAttribute('media')
    }
  } catch {}
})()
