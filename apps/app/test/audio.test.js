'use strict'

// src/media/audio.native.js with expo-audio, expo-file-system and
// react-native (AppState) replaced by stubs (a module hook), and
// src/media/audio.web.js with fake MediaRecorder, getUserMedia, document and
// Audio globals. The stubs record calls in order on globalThis. Both modules
// keep one recording at a time, so the tests run in order.
const { register } = require('node:module')
const test = require('brittle')

const expoAudio = `
const box = globalThis.__audio
export class AudioRecorder {
  constructor (options) { box.log.push('new'); box.options = options; this.isRecording = false; this.uri = null; this.listeners = {}; box.recorder = this }
  async prepareToRecordAsync () { box.log.push('prepare'); if (box.prepareHold) await box.prepareHold }
  record () { box.log.push('record'); this.isRecording = true }
  async stop () { box.log.push('stop'); this.isRecording = false; this.uri = 'file:///cache/rec.m4a'; box.files.add(this.uri) }
  getStatus () { return { durationMillis: box.duration } }
  addListener (type, fn) { this.listeners[type] = fn; return { remove: () => { box.log.push('unlisten-' + type); delete this.listeners[type] } } }
  release () { box.log.push('release') }
}
export const AudioModule = { AudioRecorder }
export async function requestRecordingPermissionsAsync () { box.log.push('permission'); return { granted: box.granted } }
export async function setAudioModeAsync (mode) { box.log.push('mode-' + mode.allowsRecording); if (box.modeHold && mode.allowsRecording) await box.modeHold }
export function createAudioPlayer (source, options) {
  box.log.push('player ' + source.uri)
  const p = {
    listeners: {},
    addListener (type, fn) { p.listeners[type] = fn; return { remove: () => { box.log.push('player-unlisten'); delete p.listeners[type] } } },
    play () { box.log.push('play') },
    pause () { box.log.push('pause') },
    seekTo (s) { box.log.push('seek ' + s) },
    remove () { box.log.push('player-remove') }
  }
  box.player = p
  return p
}
`
const fileSystem = `
const box = globalThis.__audio
export const Paths = { cache: { uri: 'file:///cache/' } }
export class Directory {
  constructor (parent, name) { this.uri = parent.uri + name + '/' }
  get exists () { return !box.dirMissing }
  list () {
    if (box.listThrows) throw new Error('io')
    return [...box.files].filter((uri) => uri.startsWith(this.uri) && !uri.slice(this.uri.length).includes('/')).map((uri) => new File(uri))
  }
}
export class File {
  constructor (uri) { this.uri = uri }
  get name () { return this.uri.slice(this.uri.lastIndexOf('/') + 1) }
  get exists () { return box.files.has(this.uri) }
  async bytes () { box.log.push('read'); return new Uint8Array([1, 2, 3]) }
  delete () { box.log.push('delete'); box.files.delete(this.uri) }
}
`
const reactNative = `
const box = globalThis.__audio
export const Platform = { get OS () { return box.os } }
export const AppState = {
  get currentState () { return box.currentState },
  addEventListener (type, fn) {
    box.appState.add(fn)
    return { remove: () => { box.log.push('unlisten-appstate'); box.appState.delete(fn) } }
  }
}
`
const hooks = `
const stubs = {
  'expo-audio': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(expoAudio)}),
  'expo-file-system': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fileSystem)}),
  'react-native': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(reactNative)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const settle = () => new Promise((resolve) => setImmediate(resolve))

// Reset in place: the stubs keep the object they saw when first loaded.
function resetNative () {
  const box = globalThis.__audio = globalThis.__audio || {}
  Object.assign(box, { log: [], files: new Set(), appState: new Set(), granted: true, duration: 4200, options: null, recorder: null, player: null, os: 'android', modeHold: null, prepareHold: null, dirMissing: false, listThrows: false, currentState: 'active' })
  return box
}
resetNative()

const native = () => import('../src/media/audio.native.js')
const web = () => import('../src/media/audio.web.js')

test('native: recorder options are mono AAC in MPEG-4 and 120 s fit the voice limit', async (t) => {
  const audio = await native()
  const o = audio.RECORDING_OPTIONS
  t.is(audio.VOICE_MIME, 'audio/mp4')
  t.is(o.numberOfChannels, 1)
  t.is(o.android.outputFormat, 'mpeg4')
  t.is(o.android.audioEncoder, 'aac')
  t.is(o.ios.outputFormat, 'aac ')
  t.ok(o.bitRate / 8 * audio.MAX_VOICE_MS / 1000 < 1572864, 'max length stays under 1.5 MiB')
  t.ok(audio.canRecordMp4())
})

// Captures the MAX_VOICE_MS timer so a test can fire it.
function catchLimit () {
  const real = globalThis.setTimeout
  const caught = {}
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 120000) { caught.fire = fn; return 0 }
    return real(fn, ms)
  }
  caught.restore = () => { globalThis.setTimeout = real }
  return caught
}

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

test('native: the recorder gets the flattened options of its platform', async (t) => {
  const audio = await native()
  for (const os of ['ios', 'android']) {
    const box = resetNative()
    box.os = os
    await audio.startRecording()
    const o = box.options
    t.absent('ios' in o || 'android' in o, os + ': no nested platform objects')
    t.is(o.numberOfChannels, 1, os)
    t.is(o.bitRate, 64000, os)
    t.is(o.extension, '.m4a', os)
    if (os === 'ios') {
      t.is(o.outputFormat, 'aac ')
      t.is(o.audioQuality, 32)
    } else {
      t.is(o.outputFormat, 'mpeg4')
      t.is(o.audioEncoder, 'aac')
    }
    await audio.cancelRecording()
  }
})

test('native: cancel while the audio mode is switching releases what start acquires', async (t) => {
  const box = resetNative()
  const audio = await native()
  const hold = deferred()
  box.modeHold = hold.promise
  const starting = audio.startRecording().catch((e) => e)
  await settle()
  const cancelling = audio.cancelRecording()
  t.ok(audio.isRecording(), 'still busy until start lets go')
  hold.resolve()
  await t.exception(audio.startRecording(), /já existe/, 'no second capture')
  const err = await starting
  await cancelling
  t.is(err.code, 'cancelled')
  t.absent(audio.isRecording())
  t.absent(box.log.includes('record'), 'never records')
  t.is(box.log[box.log.length - 1], 'mode-false', 'audio mode restored')
  box.modeHold = null
  await audio.startRecording()
  await audio.cancelRecording()
})

test('native: cancel while the recorder prepares releases the recorder and its file', async (t) => {
  const box = resetNative()
  const audio = await native()
  const hold = deferred()
  box.prepareHold = hold.promise
  const starting = audio.startRecording().catch((e) => e)
  await settle()
  t.ok(box.log.includes('prepare'))
  const cancelling = audio.cancelRecording()
  t.ok(audio.isRecording())
  box.files.add('file:///cache/prep.m4a')
  box.recorder.uri = 'file:///cache/prep.m4a'
  hold.resolve()
  t.is((await starting).code, 'cancelled')
  await cancelling
  t.absent(audio.isRecording())
  t.absent(box.log.includes('record'))
  t.is(box.log.filter((x) => x === 'release').length, 1)
  t.is(box.files.size, 0, 'prepared file deleted')
  t.is(box.log[box.log.length - 1], 'mode-false')
})

test('native: stop during the limit stop shares it and still returns the bytes', async (t) => {
  const box = resetNative()
  const audio = await native()
  const limit = catchLimit()
  let limited = false
  try {
    await audio.startRecording({ onLimit: () => { limited = true } })
  } finally {
    limit.restore()
  }
  const rec = box.recorder
  const pending = deferred()
  let stops = 0
  rec.stop = function () {
    stops++
    if (stops > 1) throw new Error('already stopped')
    box.log.push('stop')
    return pending.promise.then(() => { this.isRecording = false; this.uri = 'file:///cache/rec.m4a'; box.files.add(this.uri) })
  }
  limit.fire()
  const out = audio.stopRecording()
  pending.resolve()
  const result = await out
  t.is(stops, 1, 'one native stop')
  t.alike(result.bytes, new Uint8Array([1, 2, 3]))
  t.is(result.ms, 120000)
  t.ok(box.log.indexOf('read') < box.log.indexOf('delete'), 'read before delete')
  t.is(box.files.size, 0)
  await settle()
  t.ok(limited)
})

test('native: permission is asked only on start, and a refusal leaves nothing behind', async (t) => {
  const box = resetNative()
  const audio = await native()
  t.alike(box.log, [], 'loading the module asks nothing')
  box.granted = false
  await t.exception(audio.startRecording(), /microfone/)
  t.alike(box.log, ['permission', 'mode-false'])
  t.absent(audio.isRecording())
})

test('native: stop returns the bytes and deletes the file before returning', async (t) => {
  const box = resetNative()
  const audio = await native()
  await audio.startRecording()
  t.alike(box.options, audio.platformRecordingOptions('android'))
  await t.exception(audio.startRecording(), /já existe/)
  const out = await audio.stopRecording()
  t.alike(out, { bytes: new Uint8Array([1, 2, 3]), ms: 4200, mime: 'audio/mp4' })
  t.alike(box.log, [
    'permission', 'mode-true', 'new', 'prepare', 'record',
    'unlisten-appstate', 'unlisten-recordingStatusUpdate', 'stop', 'read', 'delete', 'release', 'mode-false'
  ])
  t.is(box.files.size, 0, 'no recording left on disk')
  t.absent(audio.isRecording())
  await t.exception(audio.stopRecording(), /nenhuma/)
})

test('native: backgrounding cancels, drops the file and tells the screen', async (t) => {
  const box = resetNative()
  const audio = await native()
  let reason = null
  await audio.startRecording({ onInterrupt: (r) => { reason = r } })
  for (const fn of [...box.appState]) fn('active')
  t.ok(audio.isRecording(), 'active is not an interruption')
  for (const fn of [...box.appState]) fn('background')
  await settle()
  await settle()
  t.is(reason, 'background')
  t.absent(audio.isRecording())
  t.is(box.files.size, 0)
  t.absent(box.log.includes('read'), 'nothing is read')
  t.is(box.appState.size, 0)
})

test('native: a recorder error and cancelRecording both clean up', async (t) => {
  let box = resetNative()
  const audio = await native()
  let reason = null
  await audio.startRecording({ onInterrupt: (r) => { reason = r } })
  box.recorder.listeners.recordingStatusUpdate({ hasError: true })
  await settle()
  await settle()
  t.is(reason, 'error')
  t.ok(box.log.includes('release'))

  box = resetNative()
  await audio.startRecording()
  await audio.cancelRecording()
  await audio.cancelRecording()
  t.absent(audio.isRecording())
  t.is(box.files.size, 0)
  t.is(box.log.filter((x) => x === 'release').length, 1, 'idempotent')
})

test('native: the player takes local files only and stops reporting after release', async (t) => {
  const box = resetNative()
  const audio = await native()
  for (const uri of ['https://example.com/a.m4a', 'http://x', 'data:audio/mp4,', '/cache/a.m4a', '', null]) {
    t.exception(() => audio.createPlayer(uri), /áudio inválido/, String(uri))
  }
  const player = audio.createPlayer('file:///cache/a.m4a')
  const seen = []
  const off = player.onProgress((u) => seen.push(u))
  box.player.listeners.playbackStatusUpdate({ currentTime: 1.5, duration: 4, playing: true, didJustFinish: false })
  t.alike(seen, [{ ms: 1500, durationMs: 4000, playing: true, ended: false }])
  player.play()
  await player.seek(2500)
  off()
  box.player.listeners.playbackStatusUpdate({ currentTime: 2, duration: 4, playing: true })
  t.is(seen.length, 1, 'unsubscribed')
  player.release()
  player.release()
  player.play()
  t.alike(box.log.filter((x) => x !== 'mode-false'), ['player file:///cache/a.m4a', 'play', 'seek 2.5', 'player-unlisten', 'pause', 'player-remove'])
})

test('native: the voice cache sweep drops leftover m4a files, never during a recording, never throws', async (t) => {
  const box = resetNative()
  const audio = await native()
  const leftover = 'file:///cache/ExpoAudio/recording-1.m4a'
  const androidLeftover = 'file:///cache/Audio/recording-2.m4a'
  const kept = ['file:///cache/ExpoAudio/notes.txt', 'file:///cache/other.m4a', 'file:///cache/ExpoAudio/sub/x.m4a', 'file:///cache/Audio/notes.txt']
  for (const uri of [leftover, androidLeftover, ...kept]) box.files.add(uri)
  t.ok(audio.sweepVoiceCache())
  t.absent(box.files.has(leftover), 'a killed recording is deleted (iOS directory)')
  t.absent(box.files.has(androidLeftover), 'a killed recording is deleted (Android directory)')
  for (const uri of kept) t.ok(box.files.has(uri), 'kept: ' + uri)
  t.ok(audio.sweepVoiceCache(), 'idempotent')

  await audio.startRecording()
  box.files.add(leftover)
  t.absent(audio.sweepVoiceCache(), 'skipped while recording')
  t.ok(box.files.has(leftover), 'the file being written stays')
  await audio.cancelRecording()
  t.ok(audio.sweepVoiceCache())
  t.absent(box.files.has(leftover))

  box.listThrows = true
  box.files.add(leftover)
  t.execution(() => audio.sweepVoiceCache(), 'a failing list does not throw')
  box.listThrows = false
  box.dirMissing = true
  t.ok(audio.sweepVoiceCache(), 'no dir, nothing to do')
  box.files.clear()
})

test('native: backgrounded while the start is pending, the capture is released before it runs on', async (t) => {
  for (const state of ['background', 'inactive']) {
    const box = resetNative()
    const audio = await native()
    const hold = deferred()
    box.prepareHold = hold.promise
    const starting = audio.startRecording().catch((e) => e)
    await settle()
    box.currentState = state
    hold.resolve()
    t.is((await starting).code, 'cancelled', state)
    t.ok(box.log.includes('release'), state + ': recorder released')
    t.is(box.files.size, 0, state + ': no file left')
    t.is(box.appState.size, 0, state + ': no listener left')
    t.absent(audio.isRecording(), state)
  }
  resetNative()
})

// Fakes for the browser module.
class FakeTarget {
  constructor () { this.handlers = {} }
  addEventListener (type, fn) { (this.handlers[type] = this.handlers[type] || new Set()).add(fn) }
  removeEventListener (type, fn) { this.handlers[type]?.delete(fn) }
  fire (type, e = {}) { for (const fn of [...(this.handlers[type] || [])]) fn(e) }
  count () { let n = 0; for (const set of Object.values(this.handlers)) n += set.size; return n }
}

function installWeb ({ mp4 = true, deny = false } = {}) {
  const box = { log: [], recorder: null, tracks: [] }
  class FakeRecorder extends FakeTarget {
    static isTypeSupported (mime) { return mp4 && mime === 'audio/mp4' }
    constructor (stream, options) { super(); this.options = options; this.state = 'inactive'; box.recorder = this; box.log.push('recorder') }
    start () { this.state = 'recording'; box.log.push('start') }
    stop () {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      box.log.push('stop')
      this.fire('dataavailable', { data: new Blob([new Uint8Array([9, 8, 7])]) })
      this.fire('stop')
    }
  }
  globalThis.MediaRecorder = FakeRecorder
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia () {
          box.log.push('getUserMedia')
          if (deny) { const e = new Error('no'); e.name = 'NotAllowedError'; throw e }
          const track = new FakeTarget()
          track.stop = () => box.log.push('track-stop')
          box.tracks.push(track)
          return { getTracks: () => [track] }
        }
      }
    }
  })
  globalThis.document = new FakeTarget()
  globalThis.document.visibilityState = 'visible'
  globalThis.window = new FakeTarget()
  return box
}

test('web: no audio/mp4 support means no recording and no permission prompt', async (t) => {
  const audio = await web()
  const box = installWeb({ mp4: false })
  t.absent(audio.canRecordMp4())
  await t.exception(audio.startRecording(), /indisponível/)
  t.alike(box.log, [])
  delete globalThis.MediaRecorder
  t.absent(audio.canRecordMp4())
})

test('web: a refused microphone leaves no session', async (t) => {
  const audio = await web()
  const box = installWeb({ deny: true })
  t.ok(audio.canRecordMp4())
  const err = await audio.startRecording().catch((e) => e)
  t.is(err.code, 'permission')
  t.alike(box.log, ['getUserMedia'])
  t.absent(audio.isRecording())
})

test('web: stop returns audio/mp4 bytes and releases the microphone', async (t) => {
  const audio = await web()
  const box = installWeb()
  await audio.startRecording()
  t.alike(box.recorder.options, { mimeType: 'audio/mp4', audioBitsPerSecond: 64000 })
  const out = await audio.stopRecording()
  t.is(out.mime, 'audio/mp4')
  t.alike(out.bytes, new Uint8Array([9, 8, 7]))
  t.ok(out.ms >= 1 && out.ms <= 120000)
  t.alike(box.log, ['getUserMedia', 'recorder', 'start', 'stop', 'track-stop'])
  t.is(box.recorder.count() + document.count() + window.count() + box.tracks[0].count(), 0, 'every listener removed')
  t.absent(audio.isRecording())
})

test('web: a hidden page, pagehide or an ended track cancels the recording', async (t) => {
  const audio = await web()
  for (const trigger of ['hidden', 'pagehide', 'ended']) {
    const box = installWeb()
    let reason = null
    await audio.startRecording({ onInterrupt: (r) => { reason = r } })
    if (trigger === 'hidden') { document.visibilityState = 'hidden'; document.fire('visibilitychange') }
    if (trigger === 'pagehide') window.fire('pagehide')
    if (trigger === 'ended') box.tracks[0].fire('ended')
    t.is(reason, trigger === 'ended' ? 'error' : 'background', trigger)
    t.ok(box.log.includes('track-stop'), trigger + ': microphone released')
    t.absent(audio.isRecording())
    await t.exception(audio.stopRecording(), /nenhuma/)
  }
})

test('web: cancelRecording during a pending stop does not hang', async (t) => {
  const audio = await web()
  const box = installWeb()
  await audio.startRecording()
  box.recorder.stop = function () { this.state = 'inactive' }
  const pending = audio.stopRecording()
  await audio.cancelRecording()
  const err = await pending.catch((e) => e)
  t.ok(err instanceof Error, 'settles')
})

test('web: cancel while getUserMedia is pending stops the tracks it returns', async (t) => {
  const audio = await web()
  const box = installWeb()
  const hold = deferred()
  const gum = navigator.mediaDevices.getUserMedia
  navigator.mediaDevices.getUserMedia = async () => { await hold.promise; return gum() }
  const starting = audio.startRecording().catch((e) => e)
  await settle()
  const cancelling = audio.cancelRecording()
  t.ok(audio.isRecording(), 'still busy until start lets go')
  hold.resolve()
  await t.exception(audio.startRecording(), /já existe/, 'no second capture')
  t.is((await starting).code, 'cancelled')
  await cancelling
  t.ok(box.log.includes('track-stop'), 'microphone released')
  t.absent(box.log.includes('recorder'))
  t.absent(audio.isRecording())
  navigator.mediaDevices.getUserMedia = gum
  await audio.startRecording()
  await audio.cancelRecording()
})

test('web: the 120 s limit keeps the recording even when the tracks end', async (t) => {
  const audio = await web()
  const box = installWeb()
  const limit = catchLimit()
  let reason = null
  let limited = false
  try {
    await audio.startRecording({ onInterrupt: (r) => { reason = r }, onLimit: () => { limited = true } })
  } finally {
    limit.restore()
  }
  const track = box.tracks[0]
  track.stop = () => { box.log.push('track-stop'); track.fire('ended') }
  limit.fire()
  t.ok(limited)
  t.is(reason, null, 'not an interruption')
  t.ok(audio.isRecording())
  const out = await audio.stopRecording()
  t.alike(out.bytes, new Uint8Array([9, 8, 7]))
  t.is(out.ms, 120000)
  t.absent(audio.isRecording())
})

test('web: a recorder that never fires stop is given up after STOP_WAIT_MS, the microphone released', async (t) => {
  const audio = await web()
  const box = installWeb()
  t.is(audio.STOP_WAIT_MS, 3000)
  await audio.startRecording()
  box.recorder.fire('dataavailable', { data: new Blob([new Uint8Array([5, 6])]) })
  box.recorder.stop = function () { this.state = 'inactive'; box.log.push('stop') }
  const real = globalThis.setTimeout
  let waited = null
  globalThis.setTimeout = (fn, ms) => {
    if (ms === audio.STOP_WAIT_MS) { waited = ms; return real(fn, 0) }
    return real(fn, ms)
  }
  let pending
  try {
    pending = audio.stopRecording()
  } finally {
    globalThis.setTimeout = real
  }
  const out = await Promise.race([pending, new Promise((resolve) => real(() => resolve('hung'), 1000))])
  t.is(waited, 3000)
  t.not(out, 'hung', 'stop settles without the event')
  t.alike(out.bytes, new Uint8Array([5, 6]), 'the chunks gathered so far')
  t.ok(box.log.includes('track-stop'), 'microphone released')
  t.absent(audio.isRecording())

  const box2 = installWeb()
  await audio.startRecording()
  box2.recorder.stop = function () { this.state = 'inactive' }
  globalThis.setTimeout = (fn, ms) => real(fn, ms === audio.STOP_WAIT_MS ? 0 : ms)
  try {
    pending = audio.stopRecording()
  } finally {
    globalThis.setTimeout = real
  }
  const err = await pending.catch((e) => e)
  t.is(err.code, 'empty', 'nothing captured is empty')
  t.ok(box2.log.includes('track-stop'))
  t.absent(audio.isRecording())
})

test('web: hidden while getUserMedia is pending, the recorder and tracks are released', async (t) => {
  const audio = await web()
  const box = installWeb()
  const hold = deferred()
  const gum = navigator.mediaDevices.getUserMedia
  navigator.mediaDevices.getUserMedia = async () => { await hold.promise; return gum() }
  const starting = audio.startRecording().catch((e) => e)
  await settle()
  document.visibilityState = 'hidden'
  document.fire('visibilitychange')
  hold.resolve()
  t.is((await starting).code, 'cancelled')
  t.ok(box.log.includes('track-stop'), 'microphone released')
  t.is(box.recorder.state, 'inactive', 'recorder stopped')
  t.is(box.recorder.count() + document.count() + window.count() + box.tracks[0].count(), 0, 'every listener removed')
  t.absent(audio.isRecording())
})

test('web: the voice cache sweep is a no-op', async (t) => {
  const audio = await web()
  t.is(audio.sweepVoiceCache(), false)
})

test('web: the player takes local URIs only', async (t) => {
  const audio = await web()
  const log = []
  globalThis.Audio = class extends FakeTarget {
    constructor () { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = NaN; globalThis.__el = this }
    play () { log.push('play'); this.paused = false; return Promise.resolve() }
    pause () { log.push('pause'); this.paused = true }
    removeAttribute (name) { log.push('remove-' + name) }
    load () { log.push('load') }
  }
  for (const uri of ['https://example.com/a.m4a', 'javascript:alert(1)', 'data:audio/mp4,', '']) {
    t.exception(() => audio.createPlayer(uri), /áudio inválido/, uri)
  }
  const player = audio.createPlayer('blob:https://varanda.app/abc')
  const el = globalThis.__el
  t.is(el.src, 'blob:https://varanda.app/abc')
  const seen = []
  player.onProgress((u) => seen.push(u))
  player.play()
  el.currentTime = 1.25
  el.fire('timeupdate')
  t.alike(seen[0], { ms: 1250, durationMs: 0, playing: true, ended: false })
  await player.seek(3000)
  t.is(el.currentTime, 3)
  player.release()
  el.fire('timeupdate')
  t.is(seen.length, 1, 'silent after release')
  t.alike(log, ['play', 'pause', 'remove-src', 'load'])
  t.is(el.count(), 0)
})
