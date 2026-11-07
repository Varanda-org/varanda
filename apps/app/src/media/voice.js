// Pure: the rules of recording a voice note, shared by the web and native
// recorders and the chat bubble. The cap matches the node's (audio/mp4, at
// most two minutes); a press shorter than MIN_RECORD_MS is a slip, not a note.

export const MIN_RECORD_MS = 800
export const MAX_RECORD_MS = 120000
// How far left (px) a finger slides off the microphone to drop the note.
export const CANCEL_DX = -80

// What to do with a recording of `ms` milliseconds once the finger lifts.
// Anything that is not a finite duration counts as a slip.
export function recordPlan (ms) {
  const n = Number.isFinite(ms) ? ms : 0
  return { cancelled: n < MIN_RECORD_MS, tooLong: n > MAX_RECORD_MS }
}

// 'm:ss' of a duration, whole seconds rounded down.
export function durationLabel (ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

export function slideToCancel (dx) {
  return Number.isFinite(dx) && dx < CANCEL_DX
}
