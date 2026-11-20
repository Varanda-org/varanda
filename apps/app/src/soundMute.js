export const SOUND_MUTE_LABEL = 'Silenciar som'
export const SOUND_UNMUTE_LABEL = 'Ativar som'

export const SOUND_MUTE_KEY = 'varanda-som-mudo'

let muted = false
let bound = null
const listeners = new Set()

// Present but unreadable stays muted: losing the choice must not turn sound on.
export function soundMuteOf (raw) {
  if (raw === null || raw === undefined) return false
  if (typeof raw !== 'string') return true
  try {
    const record = JSON.parse(raw)
    if (record !== null && typeof record === 'object' &&
      Object.keys(record).length === 2 && record.v === 1 &&
      typeof record.muted === 'boolean') return record.muted
  } catch {}
  return true
}

export function bindSoundMute (store) {
  if (bound) return
  bound = store
  try {
    muted = soundMuteOf(store.getItem(SOUND_MUTE_KEY))
  } catch {}
}

export function soundMuted () {
  return muted
}

export function setSoundMuted (value) {
  if (typeof value !== 'boolean' || muted === value) return
  try {
    bound?.setItem(SOUND_MUTE_KEY, JSON.stringify({ v: 1, muted: value }))
  } catch {}
  muted = value
  for (const fn of [...listeners]) {
    try { fn() } catch {}
  }
}

export function onSoundMute (fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
