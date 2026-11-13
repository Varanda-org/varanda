export const SOUND_MUTE_LABEL = 'Silenciar som'
export const SOUND_UNMUTE_LABEL = 'Ativar som'

let muted = false
const listeners = new Set()

export function soundMuted () {
  return muted
}

export function setSoundMuted (value) {
  if (typeof value !== 'boolean' || muted === value) return
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
