// Voice notes on the phone: expo-audio records MPEG-4 AAC (audio/mp4) to a
// file under the cache directory, the bytes are read back and the file is
// deleted before the caller sees them. One recording at a time. The
// microphone permission is asked only inside startRecording, that is, when
// the person starts a recording. Anything that takes the app away from the
// screen (a call, the lock button, the app switcher) cancels the recording
// and drops the file: the screen calls cancelRecording on navigation and on
// the app lock. Playback goes through createPlayer, for local files only.

import { AppState, Platform } from 'react-native'
import { AudioModule, requestRecordingPermissionsAsync, setAudioModeAsync, createAudioPlayer } from 'expo-audio'
import { Directory, File, Paths } from 'expo-file-system'

export const VOICE_MIME = 'audio/mp4'
export const MAX_VOICE_MS = 120000

// Mono AAC at 64 kbps: 120 s is about 960 KB, under the 1.5 MiB voice limit.
// iOS outputFormat 'aac ' is IOSOutputFormat.MPEG4AAC; audioQuality 32 is
// AudioQuality.LOW.
export const RECORDING_OPTIONS = Object.freeze({
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: false,
  android: { extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: {
    extension: '.m4a',
    outputFormat: 'aac ',
    audioQuality: 32,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false
  }
})

// The recorder constructor takes the options of one platform, flattened:
// this mirrors createRecordingOptions, which expo-audio's useAudioRecorder
// applies but does not export. Platform.OS picks the native API's shape.
export function platformRecordingOptions (os = Platform.OS) {
  const o = RECORDING_OPTIONS
  const common = {
    extension: o.extension,
    sampleRate: o.sampleRate,
    numberOfChannels: o.numberOfChannels,
    bitRate: o.bitRate,
    isMeteringEnabled: o.isMeteringEnabled
  }
  if (os === 'ios') return { ...common, ...o.ios }
  if (os === 'android') return { ...common, ...o.android }
  return common
}

let session = null

export function canRecordMp4 () {
  return typeof AudioModule?.AudioRecorder === 'function'
}

function voiceError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function dropFile (uri) {
  if (typeof uri !== 'string' || uri === '') return
  try {
    const file = new File(uri)
    if (file.exists) file.delete()
  } catch {}
}

async function playbackMode () {
  try { await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }) } catch {}
}

// Single flight: the limit timer and stopRecording share one stop, because
// a second stop throws on Android. Resolves the file uri, if any.
function stopOnce (s) {
  if (s.stopping === null) {
    s.stopping = (async () => {
      try { if (s.recorder.isRecording) await s.recorder.stop() } catch {}
      try { return s.recorder.uri } catch { return null }
    })()
  }
  return s.stopping
}

// Tears the session down in a fixed order: listeners first (so a late event
// cannot re-enter), then the capture, then the file, then the recorder. Runs
// once; s.done alone only asks a pending start to give up. The session stays
// current until everything is released, so a new start cannot overlap.
async function teardown (s, keepFile) {
  if (s.released) return null
  s.released = true
  s.done = true
  clearTimeout(s.limit)
  try { s.appState?.remove() } catch {}
  try { s.status?.remove() } catch {}
  let bytes = null
  if (s.recorder !== null) {
    const uri = await stopOnce(s)
    if (keepFile && uri) {
      try { bytes = await new File(uri).bytes() } catch {}
    }
    dropFile(uri)
    try { s.recorder.release() } catch {}
  }
  await playbackMode()
  if (session === s) session = null
  return bytes
}

function interrupt (s, reason) {
  if (s.done) return
  teardown(s, false).then(() => { try { s.onInterrupt?.(reason) } catch {} })
}

// Rejects with code 'busy', 'unsupported' or 'permission'. onInterrupt(reason)
// runs after a cancel the person did not ask for ('background', 'error');
// onLimit runs when MAX_VOICE_MS is reached, the capture is already stopped
// and stopRecording returns what was recorded.
export async function startRecording ({ onInterrupt, onLimit } = {}) {
  if (session !== null) throw voiceError('já existe uma gravação', 'busy')
  if (!canRecordMp4()) throw voiceError('gravação indisponível', 'unsupported')
  const s = { done: false, released: false, recorder: null, stopping: null, onInterrupt, startedAt: 0, stoppedMs: 0 }
  let started
  s.starting = new Promise((resolve) => { started = resolve })
  session = s
  try {
    const permission = await requestRecordingPermissionsAsync()
    if (!permission?.granted) throw voiceError('sem acesso ao microfone', 'permission')
    if (s.done) throw voiceError('gravação cancelada', 'cancelled')
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
    if (s.done) throw voiceError('gravação cancelada', 'cancelled')
    s.recorder = new AudioModule.AudioRecorder(platformRecordingOptions())
    await s.recorder.prepareToRecordAsync()
    if (s.done) throw voiceError('gravação cancelada', 'cancelled')
    s.recorder.record()
    s.startedAt = Date.now()
    // The app left the foreground while the prompt or the prepare ran: the
    // AppState listener below would come too late to see it.
    const state = AppState.currentState
    if (state === 'background' || state === 'inactive') throw voiceError('gravação cancelada', 'cancelled')
  } catch (err) {
    await teardown(s, false)
    started()
    throw err
  }
  started()
  s.appState = AppState.addEventListener('change', (state) => {
    if (state !== 'active') interrupt(s, 'background')
  })
  s.status = s.recorder.addListener?.('recordingStatusUpdate', (status) => {
    if (status?.hasError || status?.mediaServicesDidReset) interrupt(s, 'error')
  })
  s.limit = setTimeout(() => {
    if (s.done || !s.recorder.isRecording) return
    s.stoppedMs = MAX_VOICE_MS
    stopOnce(s).then(() => { try { onLimit?.() } catch {} })
  }, MAX_VOICE_MS)
  return true
}

function elapsed (s) {
  if (s.stoppedMs > 0) return s.stoppedMs
  let ms = 0
  try { ms = Math.round(Number(s.recorder.getStatus()?.durationMillis) || 0) } catch {}
  if (!(ms > 0)) ms = Date.now() - s.startedAt
  return Math.min(Math.max(ms, 1), MAX_VOICE_MS)
}

// Resolves { bytes, ms, mime } and leaves no file behind. Rejects with code
// 'idle' without a recording and 'empty' when nothing could be read.
export async function stopRecording () {
  const s = session
  if (s === null || s.recorder === null || s.startedAt === 0 || s.released) throw voiceError('nenhuma gravação', 'idle')
  const ms = elapsed(s)
  const bytes = await teardown(s, true)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw voiceError('gravação vazia', 'empty')
  return { bytes, ms, mime: VOICE_MIME }
}

// Idempotent; for navigation away, the app lock and an explicit discard.
export async function cancelRecording () {
  const s = session
  if (s === null) return
  if (s.startedAt === 0) {
    // Still starting: the start path sees s.done after its current await and
    // releases whatever it acquired.
    s.done = true
    await s.starting
    return
  }
  await teardown(s, false)
}

export function isRecording () {
  return session !== null
}

// A recording killed mid-way (a crash, a force-quit) leaves its plaintext
// m4a in expo-audio's cache dir. Deleted at handle creation and on lock;
// skipped while a recording runs, whose file is still being written.
// Idempotent, never throws. -> true when the sweep ran.
const RECORDING_DIRS = Object.freeze(['ExpoAudio', 'Audio'])

export function sweepVoiceCache () {
  if (isRecording()) return false
  // Where expo-audio 55 writes a live recording: <cache>/ExpoAudio on iOS
  // (AudioUtils.swift), <cache>/Audio on Android (AudioRecorder.kt).
  for (const name of RECORDING_DIRS) {
    try {
      const dir = new Directory(Paths.cache, name)
      if (!dir.exists) continue
      for (const entry of dir.list()) {
        if (entry instanceof File && entry.name.endsWith('.m4a')) dropFile(entry.uri)
      }
    } catch {}
  }
  return true
}

export function isLocalUri (uri) {
  return typeof uri === 'string' && (uri.startsWith('file://') || uri.startsWith('blob:'))
}

// onProgress(fn) gets { ms, durationMs, playing, ended } and returns an
// unsubscribe function. Calls after release do nothing.
export function createPlayer (localUri) {
  if (!isLocalUri(localUri)) throw new Error('áudio inválido')
  let player = createAudioPlayer({ uri: localUri }, { updateInterval: 250 })
  const listeners = new Set()
  const sub = player.addListener('playbackStatusUpdate', (status) => {
    const update = {
      ms: Math.round((Number(status?.currentTime) || 0) * 1000),
      durationMs: Math.round((Number(status?.duration) || 0) * 1000),
      playing: status?.playing === true,
      ended: status?.didJustFinish === true
    }
    for (const fn of [...listeners]) { try { fn(update) } catch {} }
  })
  return {
    play () {
      if (player === null) return
      playbackMode()
      player.play()
    },
    pause () { if (player !== null) player.pause() },
    seek (ms) {
      if (player === null) return Promise.resolve()
      return Promise.resolve(player.seekTo(Math.max(0, Number(ms) || 0) / 1000)).catch(() => {})
    },
    onProgress (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    release () {
      if (player === null) return
      const p = player
      player = null
      listeners.clear()
      try { sub.remove() } catch {}
      try { p.pause() } catch {}
      try { p.remove() } catch {}
    }
  }
}
