import { embedStep, EMBED_IDLE } from './embedLive.js'

export const MUSIC_AUTO_PREF_LABEL = 'Tocar música sozinha'
export const MUSIC_AUTO_PREF_NOTE = 'Ligada, a música de uma publicação toca quando aparece na tela, e o app pede a faixa ao serviço de conta. Desligada, só toca quando você toca no cartão.'

const KEY = 'varanda-musica-sozinha'
const listeners = new Set()
let held = false
const holdListeners = new Set()
const autoFailed = new Set()
const AUTO_FAILED_MAX = 500

export function musicAutoEnabled (store) {
  let raw
  try {
    raw = store.getItem(KEY)
  } catch {
    return true
  }
  if (typeof raw !== 'string') return true
  try {
    const record = JSON.parse(raw)
    return record !== null && typeof record === 'object' &&
      Object.keys(record).length === 2 && record.v === 1 &&
      typeof record.enabled === 'boolean' && record.enabled
  } catch {
    return false
  }
}

export function setMusicAutoEnabled (store, on) {
  try {
    if (typeof on !== 'boolean') return false
    store.setItem(KEY, JSON.stringify({ v: 1, enabled: on }))
  } catch {
    return false
  }
  for (const fn of [...listeners]) {
    try { fn() } catch {}
  }
  return true
}

export function onMusicAutoChange (fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function ambientKind (music) {
  return !!music && typeof music === 'object' && (music.kind === 'snippet' || music.kind === 'track')
}

export function autoplayRefused (err) {
  return err?.name === 'NotAllowedError' || err?.cause?.name === 'NotAllowedError'
}

// A refusal, manual silence or daily limit must also stop other rows spending requests.
export function holdMusicAuto () {
  setHeld(true)
}

export function musicAutoHeld () {
  return held
}

export function clearMusicAutoHold () {
  setHeld(false)
}

// Rows that did not cause the change still render, so they hear of it here.
export function onMusicAutoHold (fn) {
  if (typeof fn !== 'function') return () => {}
  holdListeners.add(fn)
  return () => { holdListeners.delete(fn) }
}

function setHeld (value) {
  if (held === value) return
  held = value
  for (const fn of [...holdListeners]) {
    try { fn() } catch {}
  }
}

// A row scrolled far away unmounts: the session, not the row, remembers that
// an automatic attempt failed, so coming back does not spend another request.
export function markMusicAutoFailed (key) {
  if (typeof key !== 'string' || autoFailed.has(key)) return
  autoFailed.add(key)
  if (autoFailed.size > AUTO_FAILED_MAX) autoFailed.delete(autoFailed.values().next().value)
}

export function musicAutoFailed (key) {
  return typeof key === 'string' && autoFailed.has(key)
}

export function ambientStep (state, sample) {
  let wasLive = false
  try {
    wasLive = state?.live === true
    if (!state || typeof state !== 'object' || typeof state.live !== 'boolean' || !Number.isFinite(state.seen) || !sample || typeof sample !== 'object') {
      return Object.freeze({ state: EMBED_IDLE, action: wasLive ? 'stop' : null })
    }
    const next = embedStep(state, {
      hidden: sample.hidden,
      allowed: true,
      turned: false,
      free: sample.busy !== true && sample.failed !== true && !musicAutoHeld()
    })
    const action = next.live && !wasLive ? 'start' : wasLive && !next.live ? 'stop' : null
    return Object.freeze({ state: next, action })
  } catch {
    return Object.freeze({ state: EMBED_IDLE, action: wasLive ? 'stop' : null })
  }
}
