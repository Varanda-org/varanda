// Playback state shared by VideoPlayer.native.js and VideoPlayer.web.js. Pure:
// no React, no react-native, no browser globals, so the rules are tested in
// Node. Every event carries the uri of the player that sent it; an event from
// a previous uri (a late callback of a released player) changes nothing.

export const VIDEO_PROGRESS_MS = 250

const STATUSES = new Set(['loading', 'ready', 'playing', 'paused', 'ended', 'error'])

// The rule of audio.native.js isLocalUri: the players only open a file the
// node already wrote and checked, never a remote or inline source.
export function isLocalPlayable (uri) {
  return typeof uri === 'string' && (uri.startsWith('file://') || uri.startsWith('blob:'))
}

function videoError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

export function refusedSourceError () {
  return videoError('vídeo inválido', 'not-local')
}

export function playbackError () {
  return videoError('não foi possível tocar o vídeo', 'playback')
}

// What the web player does when el.play() rejects. An AbortError is a play
// interrupted by pause() or a new load, not a failure. A refusal of sound is
// retried muted once. A refusal while already muted is 'blocked': the
// browser wants a gesture (no autoplay at all, Low Power Mode, a tap spent
// before the download ended), the file is fine and a later play() can work.
// Anything else means the video will not play.
export function playRefusal (err, muted) {
  const name = err && err.name
  if (name === 'AbortError') return 'aborted'
  if (name === 'NotAllowedError') return muted === true ? 'blocked' : 'muteAndRetry'
  return 'failed'
}

function whole (n) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0
}

export function videoState (uri, { muted = false } = {}) {
  const local = isLocalPlayable(uri)
  return {
    uri: local ? uri : null,
    status: local ? 'loading' : 'error',
    ms: 0,
    durationMs: 0,
    muted: muted === true,
    soundRefused: false
  }
}

// Positions from a player in seconds (expo-video and the video element both
// report currentTime and duration in seconds).
export function progressFromSeconds ({ currentTime, duration, playing, ended } = {}) {
  return {
    ms: whole(Number(currentTime) * 1000),
    durationMs: whole(Number(duration) * 1000),
    playing: playing === true,
    ended: ended === true
  }
}

function withPosition (state, event) {
  const durationMs = whole(event.durationMs) || state.durationMs
  let ms = 'ms' in event ? whole(event.ms) : state.ms
  if (durationMs > 0 && ms > durationMs) ms = durationMs
  return { ...state, ms, durationMs }
}

// Events: { type, uri, ... } with type one of 'ready' (durationMs),
// 'playing', 'paused', 'ended', 'error', 'progress' ({ ms, durationMs,
// playing, ended }) and 'soundRefused'. Returns the same object when nothing
// changes.
export function reduceVideo (state, event) {
  if (state === null || typeof state !== 'object' || !STATUSES.has(state.status)) return state
  if (event === null || typeof event !== 'object') return state
  if (state.uri === null || event.uri !== state.uri) return state
  if (state.status === 'error') return state
  switch (event.type) {
    case 'ready': {
      const next = withPosition(state, { durationMs: event.durationMs })
      if (state.status === 'loading') next.status = 'ready'
      return same(state, next)
    }
    case 'playing':
      return same(state, { ...state, status: 'playing' })
    case 'paused':
      if (state.status === 'ended' || state.status === 'loading') return state
      return same(state, { ...state, status: 'paused' })
    case 'ended': {
      const next = withPosition(state, { durationMs: event.durationMs })
      return same(state, { ...next, status: 'ended', ms: next.durationMs || next.ms })
    }
    case 'error':
      return { ...state, status: 'error' }
    case 'progress': {
      const next = withPosition(state, event)
      if (event.ended === true) {
        next.status = 'ended'
        next.ms = next.durationMs || next.ms
      } else if (event.playing === true) {
        next.status = 'playing'
      } else if (state.status === 'playing') {
        next.status = 'paused'
      }
      return same(state, next)
    }
    case 'soundRefused':
      return same(state, { ...state, muted: true, soundRefused: true })
    default:
      return state
  }
}

function same (a, b) {
  for (const key of Object.keys(b)) if (a[key] !== b[key]) return b
  return a
}

export function progressOf (state) {
  return {
    ms: state.ms,
    durationMs: state.durationMs,
    playing: state.status === 'playing',
    ended: state.status === 'ended'
  }
}

export function remainingMs (state) {
  return Math.max(0, state.durationMs - state.ms)
}

// What the component reports after a step from prev to next, in order:
// { type: 'ready', durationMs }, { type: 'progress', ...progressOf(next) },
// { type: 'end' }, { type: 'soundRefused' } and { type: 'error' }. Progress is
// reported when something moved while playing, so every tick, then once on
// the pause or the end that stops it.
export function videoEffects (prev, next) {
  const out = []
  if (prev === next || next.uri !== prev.uri) return out
  if (next.status === 'error') {
    if (prev.status !== 'error') out.push({ type: 'error' })
    return out
  }
  if (prev.status === 'loading' && next.status !== 'loading') out.push({ type: 'ready', durationMs: next.durationMs })
  if (next.soundRefused && !prev.soundRefused) out.push({ type: 'soundRefused' })
  const a = progressOf(prev)
  const b = progressOf(next)
  const moved = a.ms !== b.ms || a.durationMs !== b.durationMs || a.playing !== b.playing || a.ended !== b.ended
  if (moved && (a.playing || b.playing || b.ended)) out.push({ type: 'progress', ...b })
  if (next.status === 'ended' && prev.status !== 'ended') out.push({ type: 'end' })
  return out
}

// One video plays at a time: claiming playback stops the previous holder.
// stop is the holder's own pause; a throwing stop never blocks the new one.
export function createPlaybackRegistry () {
  let holder = null
  return {
    claim (token, stop) {
      if (holder !== null && holder.token === token) {
        holder.stop = stop
        return
      }
      const previous = holder
      holder = { token, stop }
      if (previous !== null) { try { previous.stop() } catch {} }
    },
    release (token) {
      if (holder !== null && holder.token === token) holder = null
    },
    active () {
      return holder === null ? null : holder.token
    }
  }
}

export const videoPlayers = createPlaybackRegistry()
