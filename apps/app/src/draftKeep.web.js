/* global sessionStorage */

// The PWA share target loads the app again (scripts/sw.js answers the share
// with a redirect), which would drop a post the person was typing. Its text
// is kept in this tab while the page is hidden, and read back once by the
// next load of the composer for the same account. sessionStorage dies with
// the tab and is not shared with other tabs. Photos are not kept.

const KEY = 'varanda.publicarRascunho'
const TTL_MS = 3600000
// Far past any post (the field has no cap of its own); longer is not kept.
const MAX_UNITS = 50000

function tabStorage () {
  try { return sessionStorage } catch { return null }
}

function drop (store) {
  try { if (store) store.removeItem(KEY) } catch {}
}

export function dropDraft () {
  drop(tabStorage())
}

function decode (raw, owner, now) {
  if (typeof raw !== 'string') return ''
  let o
  try { o = JSON.parse(raw) } catch { return '' }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return ''
  if (typeof o.owner !== 'string' || o.owner !== owner) return ''
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at > now || now - o.at > TTL_MS) return ''
  if (typeof o.text !== 'string' || o.text.length > MAX_UNITS || o.text.trim() === '') return ''
  return o.text
}

// -> the text kept for `owner` (lowercase public key), or ''. Read once: the
// record is removed either way.
export function takeDraft (owner, now = Date.now()) {
  const store = tabStorage()
  if (!store || typeof owner !== 'string' || owner === '') return ''
  let raw = null
  try { raw = store.getItem(KEY) } catch {}
  drop(store)
  return decode(raw, owner, now)
}

function keep (get) {
  const store = tabStorage()
  if (!store) return
  let draft = null
  try { draft = get() } catch {}
  const owner = draft && typeof draft.owner === 'string' ? draft.owner : ''
  const text = draft && typeof draft.text === 'string' ? draft.text : ''
  if (owner === '' || text.trim() === '' || text.length > MAX_UNITS) {
    drop(store)
    return
  }
  try {
    store.setItem(KEY, JSON.stringify({ v: 1, owner, at: Date.now(), text }))
  } catch {
    drop(store)
  }
}

// get() -> { owner, text } of the draft to keep, or null. Saved while the page
// is hidden or leaving, removed again once it is visible: only a page that
// never came back is read by the next load. -> stop.
export function watchDraft (get) {
  const doc = globalThis.document
  const win = globalThis.window
  if (!doc || typeof doc.addEventListener !== 'function') return function () {}
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') keep(get)
    else dropDraft()
  }
  const onHide = () => keep(get)
  doc.addEventListener('visibilitychange', onVisibility)
  if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', onHide)
  return function () {
    doc.removeEventListener('visibilitychange', onVisibility)
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', onHide)
  }
}
