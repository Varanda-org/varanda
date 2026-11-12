'use strict'

// The music of a momento (docs/protocol.md, "Momentos"): a reference to one
// Audius track and the second it starts from, shared by core's record check
// and the RPC contract. No title, artist or URL is kept: the viewer asks the
// association's service for them only when it plays, so a diary never holds
// text it would have to trust. Zero dependencies, no Node built-ins. Never
// throws.

const MOMENT_MUSIC_KEYS = ['p', 'id', 'start']
// The length of the excerpt a viewer plays from `start`, in seconds.
const MOMENT_SNIPPET_S = 15
// A track lasts at most 7200 s (the account service's MAX_DURATION).
const MAX_MUSIC_START = 7200
const MUSIC_ID = /^[A-Za-z0-9]{1,32}$/

function isMomentMusic (v) {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false
    const keys = Object.keys(v)
    if (keys.length !== MOMENT_MUSIC_KEYS.length) return false
    for (const k of MOMENT_MUSIC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) return false
    }
    if (v.p !== 'audius') return false
    if (typeof v.id !== 'string' || !MUSIC_ID.test(v.id)) return false
    return Number.isSafeInteger(v.start) && v.start >= 0 && v.start <= MAX_MUSIC_START
  } catch {
    return false
  }
}

module.exports = {
  MOMENT_MUSIC_KEYS,
  MOMENT_SNIPPET_S,
  isMomentMusic
}
