'use strict'

// src/media/streamUrl.js, plus src/media/stream.native.js with expo-audio
// replaced by a stub (a module hook) and src/media/stream.web.js with a fake
// Audio element. The stubs record calls in order on globalThis.
const { register } = require('node:module')
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const expoAudio = `
const box = globalThis.__stream
export async function setAudioModeAsync (mode) {
  box.log.push('mode ' + JSON.stringify(mode))
  if (box.modeThrows) throw new Error('mode')
}
export function createAudioPlayer (source, options) {
  box.log.push('player ' + source.uri)
  box.options = options
  const p = {
    listeners: {},
    get isLoaded () { return box.isLoaded },
    get currentTime () { return box.time },
    get duration () { return box.duration },
    addListener (type, fn) { p.listeners[type] = fn; return { remove: () => { box.log.push('unlisten'); delete p.listeners[type] } } },
    play () { box.log.push('play'); if (box.playThrows) throw new Error('play') },
    pause () { box.log.push('pause') },
    seekTo (s, before, after) { box.log.push('seek ' + s); box.seekArgs = [s, before, after]; return box.seekResult },
    remove () { box.log.push('remove') }
  }
  box.player = p
  return p
}
`
const hooks = `
const stubs = { 'expo-audio': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(expoAudio)}) }
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const urls = () => import('../src/media/streamUrl.js')
const native = () => import('../src/media/stream.native.js')
const web = () => import('../src/media/stream.web.js')
const installation = () => import('../src/installation.js')

const TICKET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_9'
const PATH = '/account/audius/audio/' + TICKET
const BASE = 'https://bora.varanda.app'

const settle = () => new Promise((resolve) => setImmediate(resolve))

function resetNative () {
  const box = globalThis.__stream = globalThis.__stream || {}
  Object.assign(box, { log: [], options: null, player: null, modeThrows: false, playThrows: false, seekResult: Promise.resolve(), isLoaded: false, time: 0, duration: 0 })
  return box
}
resetNative()

class FakeTarget {
  constructor () { this.handlers = {} }
  addEventListener (type, fn) { (this.handlers[type] = this.handlers[type] || new Set()).add(fn) }
  removeEventListener (type, fn) { this.handlers[type]?.delete(fn) }
  fire (type, e = {}) { for (const fn of [...(this.handlers[type] || [])]) fn(e) }
  count () { let n = 0; for (const set of Object.values(this.handlers)) n += set.size; return n }
}

function installFakeAudio ({ readyState = 1, playResult } = {}) {
  const log = []
  globalThis.Audio = class extends FakeTarget {
    constructor () {
      super()
      this.paused = true
      this.ended = false
      this._time = 0
      this.duration = NaN
      this.readyState = readyState
      this.crossOrigin = null
      this.seeking = false
      globalThis.__el = this
    }

    get currentTime () { return this._time }
    set currentTime (v) {
      log.push('currentTime ' + v)
      this.seeking = true
      this._time = Number.isFinite(this.duration) ? Math.min(v, this.duration) : v
    }

    fire (type, e) {
      if (type === 'seeked') this.seeking = false
      super.fire(type, e)
    }

    play () {
      log.push('play')
      if (playResult) return playResult()
      this.paused = false
      return Promise.resolve()
    }

    pause () { log.push('pause'); this.paused = true }
    removeAttribute (name) { log.push('remove-' + name) }
    load () { log.push('load') }
  }
  return log
}

test('ticket is 43 base64url characters', (t) => {
  t.is(TICKET.length, 43)
})

test('isStreamUrl: the same-origin path without a base', async (t) => {
  const { isStreamUrl } = await urls()
  t.ok(isStreamUrl(PATH, null))
  t.ok(isStreamUrl(PATH, undefined))
  t.ok(isStreamUrl(PATH))
})

test('isStreamUrl: the base joined to the path', async (t) => {
  const { isStreamUrl } = await urls()
  t.ok(isStreamUrl(BASE + PATH, BASE))
  t.ok(isStreamUrl('https://varanda.example:8443' + PATH, 'https://varanda.example:8443'))
})

test('isStreamUrl: refuses everything else', async (t) => {
  const { isStreamUrl } = await urls()
  const refusedNoBase = [
    BASE + PATH,
    'http://bora.varanda.app' + PATH,
    '//bora.varanda.app' + PATH,
    PATH + '?x=1',
    PATH + '?',
    PATH + '#t=1',
    PATH + '/',
    PATH.slice(0, -1),
    PATH + 'A',
    '/account/audius/audio/' + TICKET.slice(0, 42) + '=',
    '/account/audius/audio/' + TICKET.slice(0, 42) + '.',
    '/account/audius/audio/../audio/' + TICKET,
    '/account/audius/./audio/' + TICKET,
    '/account/audius/audio/%2e%2e/' + TICKET,
    '/account/audius/item',
    '/account/gif/image/' + TICKET,
    '/ACCOUNT/audius/audio/' + TICKET,
    ' ' + PATH,
    PATH + '\n',
    'blob:' + BASE + '/' + TICKET,
    'file:///data/' + TICKET,
    'data:audio/mp4;base64,AAAA',
    'javascript:alert(1)',
    '',
    null,
    undefined,
    42,
    { toString: () => PATH }
  ]
  for (const url of refusedNoBase) t.absent(isStreamUrl(url, null), 'no base: ' + String(url))

  const refusedWithBase = [
    PATH,
    'https://evil.example' + PATH,
    'https://bora.varanda.app.evil.example' + PATH,
    'https://user:pw@bora.varanda.app' + PATH,
    'https://bora.varanda.app:443' + PATH,
    BASE + '/' + PATH,
    BASE + PATH + '?x=1',
    BASE + PATH + '#x',
    BASE + '/account/audius/audio/../audio/' + TICKET,
    BASE + '/account/audius/item'
  ]
  for (const url of refusedWithBase) t.absent(isStreamUrl(url, BASE), 'base: ' + url)

  const badBases = [
    'http://bora.varanda.app',
    'http://localhost:8080',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1:8443',
    'https://10.0x7f',
    'https://[::1]',
    'https://Bora.Varanda.App',
    'https://bora.varanda.app/',
    'https://bora.varanda.app/x',
    'https://bora.varanda.app:443',
    'https://bora.varanda.app:0',
    'https://bora.varanda.app:70000',
    'https://user@bora.varanda.app',
    'https://-bad.example',
    'https://bad-.example',
    'blob:https://bora.varanda.app',
    'file://',
    'data:',
    '',
    42
  ]
  for (const base of badBases) {
    t.absent(isStreamUrl(base + PATH, base), 'bad base: ' + String(base))
  }

  t.absent(isStreamUrl('https://evil.example' + PATH, BASE), 'origin mismatch')
  t.absent(isStreamUrl(BASE + PATH, 'https://evil.example'), 'origin mismatch, reversed')
  t.absent(isStreamUrl(BASE + PATH, null), 'an absolute url with no base')
})

test('installed app: the installation origin is the base of an absolute url', async (t) => {
  const inst = await installation()
  const { isStreamUrl } = await urls()
  t.ok(inst.setInstallation(BASE))
  try {
    const base = inst.installationOrigin()
    const url = inst.resolveUrl(PATH)
    t.is(url, BASE + PATH)
    t.ok(isStreamUrl(url, base))
    t.absent(isStreamUrl(url, null), 'a null base refuses the absolute url')

    const box = resetNative()
    const n = await native()
    const player = n.createStreamPlayer(url, { origin: base })
    t.is(box.log[0], 'player ' + url)
    player.release()

    const w = await web()
    installFakeAudio()
    const wp = w.createStreamPlayer(url, { origin: base })
    t.is(globalThis.__el.src, url)
    wp.release()
    t.exception(() => w.createStreamPlayer(url, { origin: null }), /áudio inválido/)
    t.exception(() => n.createStreamPlayer(url, { origin: null }), /áudio inválido/)
  } finally {
    inst.setInstallation(null)
  }
})

test('native: refuses a relative path, another host and a missing base', async (t) => {
  const n = await native()
  const box = resetNative()
  for (const [url, origin] of [
    [PATH, null],
    [PATH, undefined],
    [BASE + PATH, null],
    [BASE + PATH, undefined],
    ['https://evil.example' + PATH, BASE],
    ['http://bora.varanda.app' + PATH, 'http://bora.varanda.app'],
    ['file:///cache/a.m4a', BASE],
    ['blob:' + BASE + '/x', BASE]
  ]) {
    t.exception(() => n.createStreamPlayer(url, { origin }), /áudio inválido/, String(url) + ' ' + String(origin))
  }
  t.exception(() => n.createStreamPlayer(BASE + PATH), /áudio inválido/, 'no options')
  t.alike(box.log, [], 'no player was created')
})

test('native: streams the url, sets the playback mode before play, reports progress', async (t) => {
  const n = await native()
  const box = resetNative()
  const player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  t.is(box.log[0], 'player ' + BASE + PATH)
  t.alike(box.options, { updateInterval: 250 })
  const seen = []
  const off = player.onProgress((u) => seen.push(u))
  await player.play()
  t.alike(box.log.slice(1), ['mode {"allowsRecording":false,"playsInSilentMode":true}', 'play'])
  box.player.listeners.playbackStatusUpdate({ currentTime: 1.25, duration: 30, playing: true, isBuffering: true, playbackState: 'buffering' })
  t.alike(seen[0], { ms: 1250, durationMs: 30000, playing: true, ended: false, buffering: true })
  box.player.listeners.playbackStatusUpdate({ currentTime: 30, duration: 30, playing: false, didJustFinish: true, playbackState: 'ended' })
  t.alike(seen[1], { ms: 30000, durationMs: 30000, playing: false, ended: true, buffering: false })
  off()
  box.player.listeners.playbackStatusUpdate({ currentTime: 1, duration: 30, playing: true })
  t.is(seen.length, 2, 'unsubscribed')
  player.release()
  t.alike(box.log.slice(-3), ['unlisten', 'pause', 'remove'])
})

test('native: a failing playback mode still plays; a pause during it wins', async (t) => {
  const n = await native()
  let box = resetNative()
  box.modeThrows = true
  let player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  await player.play()
  t.ok(box.log.includes('play'))
  player.release()

  box = resetNative()
  player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  const pending = player.play()
  player.pause()
  await pending
  t.absent(box.log.includes('play'), 'paused before the mode was set')
  player.release()
})

test('native: seek waits for expo-audio and the position, never plays', async (t) => {
  const n = await native()
  const box = resetNative()
  let resolveSeek
  box.seekResult = new Promise((resolve) => { resolveSeek = resolve })
  const player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  let resolved = false
  const p = player.seek(12000).then(() => { resolved = true })
  await settle()
  t.absent(resolved, 'waits for expo-audio')
  box.isLoaded = true
  box.time = 12
  resolveSeek()
  await p
  t.ok(resolved)
  t.ok(box.log.includes('seek 12'))
  t.absent(box.log.includes('play'))

  const errors = []
  player.onError((e) => errors.push(e))
  box.seekResult = Promise.reject(new Error('seek'))
  await t.exception(player.seek(1000))
  await settle()
  t.is(errors.length, 1, 'a failed seek is reported')
  player.release()
  await t.exception(player.seek(0), /áudio encerrado/)
})

test('native: a failure is reported once, until playback resumes', async (t) => {
  const n = await native()
  const box = resetNative()
  const player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  const errors = []
  player.onError((e) => errors.push(e))
  const status = box.player.listeners.playbackStatusUpdate
  status({ playbackState: 'idle' })
  t.is(errors.length, 0, 'idle before loading is not a failure')
  status({ playbackState: 'ready', isLoaded: true })
  status({ playbackState: 'idle' })
  t.is(errors.length, 1, 'android: idle after loading')
  status({ playbackState: 'failed' })
  t.is(errors.length, 1, 'reported once')
  status({ playbackState: 'ready', playing: true })
  status({ playbackState: 'failed' })
  t.is(errors.length, 2, 'ios: failed, after playback had resumed')

  box.playThrows = true
  const other = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  const otherErrors = []
  other.onError((e) => otherErrors.push(e))
  await other.play()
  t.is(otherErrors.length, 1, 'a play that throws is reported')
  await other.play()
  t.is(otherErrors.length, 2, 'a second failed play reports again before any playing status')
  box.player.listeners.playbackStatusUpdate({ playbackState: 'failed' })
  t.is(otherErrors.length, 2, 'duplicate failures in the same attempt are suppressed')
  other.release()
  player.release()
  status({ playbackState: 'failed' })
  t.is(errors.length, 2, 'silent after release')
})

test('web: refuses another host, an absolute url with no base and local URIs', async (t) => {
  const w = await web()
  const log = installFakeAudio()
  for (const [url, origin] of [
    [BASE + PATH, null],
    ['https://evil.example' + PATH, BASE],
    [PATH + '?a=1', null],
    ['blob:' + BASE + '/x', null],
    ['file:///x', null],
    ['data:audio/mp4,', null],
    ['', null]
  ]) {
    t.exception(() => w.createStreamPlayer(url, { origin }), /áudio inválido/, String(url))
  }
  t.alike(log, [])
})

test('web: the source is set at creation, with metadata preload and no crossOrigin', async (t) => {
  const w = await web()
  const log = installFakeAudio()
  const player = w.createStreamPlayer(PATH, { origin: null })
  const el = globalThis.__el
  t.is(el.src, PATH)
  t.is(el.preload, 'metadata')
  t.is(el.crossOrigin, null, 'crossOrigin left unset')
  t.alike(log, [], 'nothing played')
  player.release()
})

test('web: seek(12000) before play sets 12 s and resolves on seeked', async (t) => {
  const w = await web()
  const log = installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  let resolved = false
  const p = player.seek(12000).then(() => { resolved = true })
  t.is(el.currentTime, 12)
  await settle()
  t.absent(resolved, 'waits for seeked')
  el.fire('seeked')
  await p
  t.ok(resolved)
  t.absent(log.includes('play'), 'seek never plays')
  t.is(el.count(), 10, 'the seek listeners are removed')
  player.release()
})

test('web: seek resolves at once on the current position', async (t) => {
  const w = await web()
  const log = installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  await player.seek(0)
  t.alike(log, [], 'no currentTime write')
  player.release()
})

test('web: seek before metadata waits for loadedmetadata', async (t) => {
  const w = await web()
  const log = installFakeAudio({ readyState: 0 })
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  const p = player.seek(12000)
  t.alike(log, [], 'no position yet')
  el.readyState = 1
  el.fire('loadedmetadata')
  t.is(el.currentTime, 12)
  el.fire('seeked')
  await p
  player.release()
})

test('web: seek rejects on error and after SEEK_WAIT_MS, and reports it', async (t) => {
  const w = await web()
  installFakeAudio()
  let player = w.createStreamPlayer(PATH)
  let el = globalThis.__el
  const errors = []
  player.onError((e) => errors.push(e))
  const p = player.seek(12000)
  el.fire('error')
  await t.exception(p, /falha no áudio/)
  t.is(errors.length, 1, 'reported once, for the seek and the element')
  player.release()

  const real = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== w.SEEK_WAIT_MS) return real(fn, ms, ...args)
    timers.push(ms)
    return real(fn, 0)
  }
  try {
    installFakeAudio()
    player = w.createStreamPlayer(PATH)
    el = globalThis.__el
    const timeoutErrors = []
    player.onError((e) => timeoutErrors.push(e))
    await t.exception(player.seek(12000), /falha no áudio/)
    t.alike(timers, [w.SEEK_WAIT_MS])
    t.is(timeoutErrors.length, 1)
    t.is(timeoutErrors[0]?.code, 'seek-timeout')
  } finally {
    globalThis.setTimeout = real
  }
  player.release()
})

test('web: a newer seek or a release rejects the pending one', async (t) => {
  const w = await web()
  installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  const errors = []
  player.onError((e) => errors.push(e))
  const first = player.seek(5000)
  const second = player.seek(8000)
  await t.exception(first, /busca substituída/)
  el.fire('seeked')
  await second
  const third = player.seek(9000)
  player.release()
  await t.exception(third, /áudio encerrado/)
  t.is(errors.length, 0, 'neither is a failure')
  t.is(el.count(), 0, 'every listener removed')
})

test('web: play rejections are reported, an AbortError is not', async (t) => {
  const w = await web()
  installFakeAudio({ playResult: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) })
  let player = w.createStreamPlayer(PATH)
  const errors = []
  player.onError((e) => errors.push(e))
  await player.play()
  t.is(errors.length, 1)
  t.is(errors[0].cause.name, 'NotAllowedError')
  await player.play()
  t.is(errors.length, 2, 'a second refused play reports again before any playing event')
  t.is(errors[1]?.cause.name, 'NotAllowedError')
  globalThis.__el.fire('error')
  t.is(errors.length, 2, 'duplicate failures in the same attempt are suppressed')
  player.release()

  installFakeAudio({ playResult: () => Promise.reject(Object.assign(new Error('paused'), { name: 'AbortError' })) })
  player = w.createStreamPlayer(PATH)
  const aborts = []
  player.onError((e) => aborts.push(e))
  await player.play()
  t.is(aborts.length, 0)
  player.release()
})

test('web: progress, buffering and the error event; a playing event clears the failure', async (t) => {
  const w = await web()
  installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  const seen = []
  const errors = []
  player.onProgress((u) => seen.push(u))
  player.onError((e) => errors.push(e))
  await player.play()
  el._time = 1.25
  el.duration = 30
  el.readyState = 2
  el.fire('waiting')
  t.alike(seen[0], { ms: 1250, durationMs: 30000, playing: true, ended: false, buffering: true })
  el.readyState = 4
  el.fire('playing')
  t.is(seen[1].buffering, false)
  el.fire('error')
  el.fire('error')
  t.is(errors.length, 1)
  el.fire('playing')
  el.fire('error')
  t.is(errors.length, 2)
  el.ended = true
  el.fire('ended')
  t.is(seen[seen.length - 1].ended, true)
  player.release()
})

test('web: release removes the source, calls load and goes silent', async (t) => {
  const w = await web()
  const log = installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  const seen = []
  player.onProgress((u) => seen.push(u))
  player.release()
  el.fire('timeupdate')
  t.is(seen.length, 0)
  t.alike(log, ['pause', 'remove-src', 'load'])
  t.is(el.count(), 0)
  player.release()
  await player.play()
  t.alike(log, ['pause', 'remove-src', 'load'], 'calls after release do nothing')
})

// setTimeout and setInterval for one delay are held, to be fired by hand.
function holdTimers (delays) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const held = new Map()
  let next = 0
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (!delays.includes(ms)) return realSet(fn, ms, ...args)
    const id = { held: ++next, ms }
    held.set(id, fn)
    return id
  }
  globalThis.clearTimeout = (id) => {
    if (id && typeof id === 'object' && 'held' in id) held.delete(id)
    else realClear(id)
  }
  return {
    pending: (ms) => [...held.keys()].filter((id) => id.ms === ms).length,
    fire: (ms) => {
      for (const [id, fn] of [...held]) {
        if (id.ms !== ms) continue
        held.delete(id)
        fn()
      }
    },
    restore: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  }
}

test('A native: a stream that never loads, or stops moving, is reported once', async (t) => {
  const n = await native()
  t.ok(n.LOAD_WAIT_MS >= 20000, 'covers the service connect wait')
  const timers = holdTimers([n.LOAD_WAIT_MS])
  try {
    // iOS: a failed item emits no status at all.
    let box = resetNative()
    let player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
    let errors = []
    player.onError((e) => errors.push(e))
    await player.play()
    t.is(timers.pending(n.LOAD_WAIT_MS), 1, 'watching from the play request')
    timers.fire(n.LOAD_WAIT_MS)
    t.is(errors.length, 1)
    t.is(errors[0]?.code, 'load-timeout')
    timers.fire(n.LOAD_WAIT_MS)
    t.is(errors.length, 1, 'reported once')
    player.release()

    box = resetNative()
    player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
    errors = []
    player.onError((e) => errors.push(e))
    await player.play()
    const status = box.player.listeners.playbackStatusUpdate
    status({ playbackState: 'ready', isLoaded: true, playing: true, currentTime: 1, duration: 30 })
    status({ playbackState: 'ready', isLoaded: true, playing: true, currentTime: 2, duration: 30 })
    t.is(timers.pending(n.LOAD_WAIT_MS), 1, 'progress restarts the watch')
    status({ playbackState: 'buffering', isLoaded: true, playing: true, currentTime: 2, duration: 30 })
    timers.fire(n.LOAD_WAIT_MS)
    t.is(errors.length, 1)
    t.is(errors[0]?.code, 'stall')
    player.release()

    box = resetNative()
    player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
    await player.play()
    player.pause()
    t.is(timers.pending(n.LOAD_WAIT_MS), 0, 'pause clears the watch')
    await player.play()
    box.player.listeners.playbackStatusUpdate({ playbackState: 'ended', isLoaded: true, didJustFinish: true, currentTime: 30, duration: 30 })
    t.is(timers.pending(n.LOAD_WAIT_MS), 0, 'the end clears the watch')
    await player.play()
    player.release()
    t.is(timers.pending(n.LOAD_WAIT_MS), 0, 'release clears the watch')
  } finally {
    timers.restore()
  }
})

test('B native: seek resolves only at the target, after a newer seek or release it rejects', async (t) => {
  const n = await native()
  const timers = holdTimers([n.SEEK_WAIT_MS])
  try {
    let box = resetNative()
    let player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
    const errors = []
    player.onError((e) => errors.push(e))
    let resolved = false
    const p = player.seek(12000).then(() => { resolved = true })
    await settle()
    t.absent(resolved, 'expo-audio resolved, the player is not there yet')
    const status = box.player.listeners.playbackStatusUpdate
    status({ playbackState: 'buffering', isLoaded: false, currentTime: 12 })
    await settle()
    t.absent(resolved, 'not loaded')
    status({ playbackState: 'ready', isLoaded: true, currentTime: 0.5 })
    await settle()
    t.absent(resolved, 'off target')
    status({ playbackState: 'ready', isLoaded: true, currentTime: 12.4 })
    await p
    t.ok(resolved)

    const first = player.seek(5000)
    const second = player.seek(8000)
    await t.exception(first, /busca substituída/)
    player.release()
    await t.exception(second, /áudio encerrado/)
    t.is(errors.length, 0, 'neither is a failure')

    box = resetNative()
    player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
    const timeoutErrors = []
    player.onError((e) => timeoutErrors.push(e))
    const late = player.seek(12000)
    await settle()
    timers.fire(n.SEEK_WAIT_MS)
    await t.exception(late, /falha no áudio/)
    t.is(timeoutErrors.length, 1)
    t.is(timeoutErrors[0]?.code, 'seek-timeout')
    player.release()

    box = resetNative()
    player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
    const rangeErrors = []
    player.onError((e) => rangeErrors.push(e))
    const far = player.seek(60000)
    await settle()
    box.player.listeners.playbackStatusUpdate({ playbackState: 'ready', isLoaded: true, currentTime: 30, duration: 30 })
    const err = await far.catch((e) => e)
    t.is(err?.code, 'seek-range')
    t.is(rangeErrors.length, 0, 'the audio itself is fine')
    t.absent(box.log.includes('play'), 'seek never plays')
    player.release()
  } finally {
    timers.restore()
  }
})

test('C web: a repeated seek while the element is seeking waits for seeked', async (t) => {
  const w = await web()
  installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  const first = player.seek(12000)
  t.ok(el.seeking)
  let resolved = false
  const second = player.seek(12000).then(() => { resolved = true })
  await t.exception(first, /busca substituída/)
  await settle()
  t.absent(resolved, 'currentTime already shows the target, but the seek is pending')
  el.fire('seeked')
  await second
  t.ok(resolved)
  player.release()
})

test('D web: the seek bound covers the connect wait; a clamped seek rejects', async (t) => {
  const w = await web()
  t.ok(w.SEEK_WAIT_MS >= 20000, 'covers the service connect wait')
  installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  const errors = []
  player.onError((e) => errors.push(e))
  el.duration = 30
  const far = player.seek(60000)
  t.is(el.currentTime, 30, 'the element clamped')
  el.fire('seeked')
  const err = await far.catch((e) => e)
  t.is(err?.code, 'seek-range')
  t.is(errors.length, 0, 'the audio itself is fine')
  const near = player.seek(12000)
  el._time = 12.3
  el.fire('seeked')
  await near
  player.release()
})

test('E native: seekTo gets tolerances inside SEEK_TOLERANCE_MS', async (t) => {
  const n = await native()
  const box = resetNative()
  box.isLoaded = true
  box.time = 12
  const player = n.createStreamPlayer(BASE + PATH, { origin: BASE })
  await player.seek(12000)
  const [seconds, before, after] = box.seekArgs
  t.is(seconds, 12)
  t.ok(Number.isFinite(before) && before >= 0 && before <= n.SEEK_TOLERANCE_MS, 'tolerance before: ' + before)
  t.ok(Number.isFinite(after) && after >= 0 && after <= n.SEEK_TOLERANCE_MS, 'tolerance after: ' + after)
  t.ok(before + after <= 2 * n.SEEK_TOLERANCE_MS)
  player.release()
})

test('F web: a stale seeked while the element is still seeking is ignored', async (t) => {
  const w = await web()
  installFakeAudio()
  const player = w.createStreamPlayer(PATH)
  const el = globalThis.__el
  let resolved = false
  const p = player.seek(12000).then(() => { resolved = true })
  t.ok(el.seeking)
  // The earlier seek's event, dispatched while this one is still running.
  FakeTarget.prototype.fire.call(el, 'seeked')
  await settle()
  t.absent(resolved, 'still seeking')
  el.fire('seeked')
  await p
  t.ok(resolved)
  player.release()
})

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

test('neither stream file downloads the track or asks for background playback', (t) => {
  const MEDIA = path.join(__dirname, '../src/media')
  for (const name of ['stream.native.js', 'stream.web.js', 'streamUrl.js']) {
    const src = withoutComments(fs.readFileSync(path.join(MEDIA, name), 'utf8'))
    for (const banned of ['FileSystem', 'expo-file-system', 'Paths.cache', 'URL.createObjectURL', 'createObjectURL', 'Blob', 'mediaSession', 'shouldPlayInBackground', 'setActiveForLockScreen', 'XMLHttpRequest']) {
      t.absent(src.includes(banned), name + ': no ' + banned)
    }
    t.absent(/\bfetch\s*\(/.test(src), name + ': no fetch call')
    t.absent(/\bfetch\b/.test(src), name + ': no fetch reference')
  }
})
