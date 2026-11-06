// Voice notes in the browser: the only module that touches MediaRecorder.
// Recording exists only where MediaRecorder can produce audio/mp4 (Safari,
// recent Chrome); elsewhere canRecordMp4 is false and the screen hides the
// microphone. The microphone permission (getUserMedia) is asked only inside
// startRecording. A hidden page, pagehide, a track that ends or a recorder
// error cancels the recording and stops the tracks; the screen calls
// cancelRecording on navigation and on the app lock. Playback goes through
// an audio element, for local URIs only.

export const VOICE_MIME = 'audio/mp4'
export const MAX_VOICE_MS = 120000
const BITS_PER_SECOND = 64000
// A recorder that never fires its stop event must not keep the microphone
// open: after this wait the tracks stop and the chunks so far are returned.
export const STOP_WAIT_MS = 3000

let session = null

export function canRecordMp4 () {
  const MR = globalThis.MediaRecorder
  if (typeof MR !== 'function' || typeof MR.isTypeSupported !== 'function') return false
  if (typeof globalThis.navigator?.mediaDevices?.getUserMedia !== 'function') return false
  try { return MR.isTypeSupported(VOICE_MIME) === true } catch { return false }
}

function voiceError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function stopTracks (stream) {
  try { for (const track of stream.getTracks()) track.stop() } catch {}
}

function detach (offs) {
  for (const off of offs.splice(0)) { try { off() } catch {} }
}

// Fixed order: listeners first (a late event cannot re-enter), then the
// recorder, then the tracks, so the browser's microphone indicator goes off.
// Runs once; s.done alone only asks a pending start to give up.
function teardown (s) {
  if (s.released) return
  s.released = true
  s.done = true
  if (session === s) session = null
  clearTimeout(s.limit)
  s.settle()
  detach(s.guards)
  detach(s.offs)
  try { if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop() } catch {}
  if (s.stream) stopTracks(s.stream)
  s.chunks = []
}

function interrupt (s, reason) {
  if (s.done) return
  teardown(s)
  try { s.onInterrupt?.(reason) } catch {}
}

function listen (target, type, fn, offs) {
  if (!target || typeof target.addEventListener !== 'function') return
  target.addEventListener(type, fn)
  offs.push(() => target.removeEventListener(type, fn))
}

// Rejects with code 'busy', 'unsupported' or 'permission'. onInterrupt(reason)
// runs after a cancel the person did not ask for ('background', 'error');
// onLimit runs when MAX_VOICE_MS is reached, the capture is already stopped
// and stopRecording returns what was recorded.
export async function startRecording ({ onInterrupt, onLimit } = {}) {
  if (session !== null) throw voiceError('já existe uma gravação', 'busy')
  if (!canRecordMp4()) throw voiceError('gravação indisponível', 'unsupported')
  // offs: the recorder's own events; guards: the interruptions.
  const s = { done: false, released: false, stream: null, recorder: null, chunks: [], offs: [], guards: [], onInterrupt, startedAt: 0, stoppedMs: 0 }
  // Settles on the recorder's stop event or on any teardown, so a stop that
  // races an interruption never waits forever.
  s.stopped = new Promise((resolve) => { s.settle = resolve })
  let started
  s.starting = new Promise((resolve) => { started = resolve })
  session = s
  try {
    try {
      s.stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      throw voiceError('sem acesso ao microfone', err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'permission' : 'unsupported')
    }
    if (s.done) throw voiceError('gravação cancelada', 'cancelled')
    s.recorder = new globalThis.MediaRecorder(s.stream, { mimeType: VOICE_MIME, audioBitsPerSecond: BITS_PER_SECOND })
  } catch (err) {
    teardown(s)
    started()
    throw err
  }
  started()
  listen(s.recorder, 'stop', () => s.settle(), s.offs)
  listen(s.recorder, 'dataavailable', (e) => { if (!s.done && e.data && e.data.size > 0) s.chunks.push(e.data) }, s.offs)
  listen(s.recorder, 'error', () => interrupt(s, 'error'), s.guards)
  for (const track of s.stream.getTracks()) listen(track, 'ended', () => interrupt(s, 'error'), s.guards)
  const doc = globalThis.document
  listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') interrupt(s, 'background') }, s.guards)
  listen(globalThis.window, 'pagehide', () => interrupt(s, 'background'), s.guards)
  try {
    s.recorder.start()
  } catch {
    teardown(s)
    throw voiceError('gravação indisponível', 'unsupported')
  }
  // Hidden while getUserMedia was pending: the visibilitychange listener
  // above came too late to see it.
  if (doc && doc.visibilityState === 'hidden') {
    teardown(s)
    throw voiceError('gravação cancelada', 'cancelled')
  }
  s.startedAt = Date.now()
  s.limit = setTimeout(() => {
    if (s.done || s.recorder.state === 'inactive') return
    s.stoppedMs = MAX_VOICE_MS
    // The capture is finished, not interrupted: an ended track must not drop
    // the chunks that stopRecording is about to return.
    detach(s.guards)
    try { s.recorder.stop() } catch {}
    stopTracks(s.stream)
    try { onLimit?.() } catch {}
  }, MAX_VOICE_MS)
  return true
}

// Resolves { bytes, ms, mime } and releases the microphone. Rejects with code
// 'idle' without a recording and 'empty' when nothing was captured.
export async function stopRecording () {
  const s = session
  if (s === null || s.recorder === null || s.startedAt === 0 || s.stopping) throw voiceError('nenhuma gravação', 'idle')
  // The session stays current until teardown, so cancelRecording can still
  // end a stop that never gets its event.
  s.stopping = true
  const ms = Math.min(Math.max(s.stoppedMs || Date.now() - s.startedAt, 1), MAX_VOICE_MS)
  try { if (s.recorder.state !== 'inactive') s.recorder.stop() } catch {}
  let timer
  await Promise.race([s.stopped, new Promise((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS) })])
  clearTimeout(timer)
  const chunks = s.chunks
  teardown(s)
  if (chunks.length === 0) throw voiceError('gravação vazia', 'empty')
  const buffer = await new Blob(chunks, { type: VOICE_MIME }).arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength === 0) throw voiceError('gravação vazia', 'empty')
  return { bytes, ms, mime: VOICE_MIME }
}

// Idempotent; for navigation away, the app lock and an explicit discard.
export async function cancelRecording () {
  const s = session
  if (s === null) return
  if (s.startedAt === 0) {
    // Still starting: the start path sees s.done after getUserMedia and
    // releases the stream it got.
    s.done = true
    await s.starting
    return
  }
  teardown(s)
}

export function isRecording () {
  return session !== null
}

// The browser keeps no recording on disk: nothing to sweep.
export function sweepVoiceCache () {
  return false
}

export function isLocalUri (uri) {
  return typeof uri === 'string' && (uri.startsWith('blob:') || uri.startsWith('file://'))
}

// onProgress(fn) gets { ms, durationMs, playing, ended } and returns an
// unsubscribe function. Calls after release do nothing.
export function createPlayer (localUri) {
  if (!isLocalUri(localUri)) throw new Error('áudio inválido')
  let el = new globalThis.Audio()
  el.preload = 'metadata'
  el.src = localUri
  const listeners = new Set()
  const offs = []
  const emit = (ended) => {
    if (el === null) return
    const duration = Number(el.duration)
    const update = {
      ms: Math.round((Number(el.currentTime) || 0) * 1000),
      durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
      playing: !el.paused && !el.ended,
      ended
    }
    for (const fn of [...listeners]) { try { fn(update) } catch {} }
  }
  for (const type of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange']) {
    listen(el, type, () => emit(false), offs)
  }
  listen(el, 'ended', () => emit(true), offs)
  return {
    play () {
      if (el === null) return
      const p = el.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    },
    pause () { if (el !== null) el.pause() },
    seek (ms) {
      if (el === null) return Promise.resolve()
      try { el.currentTime = Math.max(0, Number(ms) || 0) / 1000 } catch {}
      return Promise.resolve()
    },
    onProgress (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    release () {
      if (el === null) return
      const a = el
      el = null
      listeners.clear()
      for (const off of offs) { try { off() } catch {} }
      try { a.pause() } catch {}
      try { a.removeAttribute('src'); a.load() } catch {}
    }
  }
}
