'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/soundMute.js')

async function session (t) {
  const sound = await load()
  t.teardown(() => {
    sound.setSoundMuted(false)
  })
  return sound
}

test('sound mute defaults to unmuted with Portuguese labels', async (t) => {
  const { SOUND_MUTE_LABEL, SOUND_UNMUTE_LABEL, soundMuted } = await load()
  t.is(soundMuted(), false)
  t.is(SOUND_MUTE_LABEL, 'Silenciar som')
  t.is(SOUND_UNMUTE_LABEL, 'Ativar som')
})

test('sound mute can be muted and unmuted', async (t) => {
  const { setSoundMuted, soundMuted } = await session(t)
  setSoundMuted(true)
  t.is(soundMuted(), true)
  setSoundMuted(false)
  t.is(soundMuted(), false)
})

test('non-booleans preserve either sound state without notifying', async (t) => {
  const { setSoundMuted, soundMuted, onSoundMute } = await session(t)
  const observed = []
  const off = onSoundMute(() => { observed.push(soundMuted()) })
  t.teardown(off)
  for (const muted of [false, true]) {
    setSoundMuted(muted)
    observed.length = 0
    for (const value of [1, 'true', undefined, null]) {
      setSoundMuted(value)
      t.is(soundMuted(), muted)
      t.alike(observed, [])
    }
  }
})

test('sound listeners fire only after a change', async (t) => {
  const { setSoundMuted, soundMuted, onSoundMute } = await session(t)
  const observed = []
  const off = onSoundMute(() => { observed.push(soundMuted()) })
  t.teardown(off)
  t.alike(observed, [], 'subscribing does not notify')
  setSoundMuted(false)
  t.alike(observed, [])
  setSoundMuted(true)
  t.alike(observed, [true])
  setSoundMuted(true)
  t.alike(observed, [true])
  setSoundMuted(false)
  t.alike(observed, [true, false])
  setSoundMuted(false)
  t.alike(observed, [true, false])
})

test('unsubscribed sound listeners receive no more notices', async (t) => {
  const { setSoundMuted, onSoundMute } = await session(t)
  let calls = 0
  const off = onSoundMute(() => { calls++ })
  t.teardown(off)
  setSoundMuted(true)
  t.is(calls, 1)
  off()
  off()
  setSoundMuted(false)
  t.is(calls, 1)
})

test('a throwing sound listener does not stop the next listener', async (t) => {
  const { setSoundMuted, soundMuted, onSoundMute } = await session(t)
  const calls = []
  t.teardown(onSoundMute(() => {
    calls.push('throw')
    throw new Error('listener failed')
  }))
  t.teardown(onSoundMute(() => { calls.push(soundMuted()) }))
  setSoundMuted(true)
  setSoundMuted(false)
  t.alike(calls, ['throw', true, 'throw', false])
})

test('sound notifications use a snapshot of the listeners', async (t) => {
  const { setSoundMuted, onSoundMute } = await session(t)
  const calls = []
  const late = () => { calls.push('late') }
  let offLate = () => {}
  t.teardown(() => offLate())
  t.teardown(onSoundMute(() => {
    calls.push('first')
    offSecond()
    offLate = onSoundMute(late)
  }))
  const offSecond = onSoundMute(() => { calls.push('second') })
  t.teardown(offSecond)
  setSoundMuted(true)
  t.alike(calls, ['first', 'second'])
  setSoundMuted(false)
  t.alike(calls, ['first', 'second', 'first', 'late'])
})

test('non-function sound listeners return a no-op unsubscribe', async (t) => {
  const { onSoundMute } = await load()
  for (const value of [null, undefined, false, 1, 'listener', {}]) {
    const off = onSoundMute(value)
    t.is(typeof off, 'function')
    t.is(off(), undefined)
  }
})

test('sound mute source has no imports or em dash', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/soundMute.js'), 'utf8')
  t.absent(/\bimport\b/.test(source))
  t.absent(source.includes('\u2014'))
})

let fresh = 0
const loadFresh = () => import('../src/soundMute.js?n=' + (++fresh))
const fakeStore = (entries = new Map()) => ({
  entries,
  getItem: (k) => entries.has(k) ? entries.get(k) : null,
  setItem: (k, v) => { entries.set(k, v) }
})
const RECORD = (m) => JSON.stringify({ v: 1, muted: m })

test('soundMuteOf reads only the exact record', async (t) => {
  const { soundMuteOf } = await loadFresh()
  t.is(soundMuteOf(null), false)
  t.is(soundMuteOf(undefined), false)
  t.is(soundMuteOf('{"v":1,"muted":true}'), true)
  t.is(soundMuteOf('{"v":1,"muted":false}'), false)
  for (const raw of ['{"v":1,"muted":false,"x":1}', '{"v":2,"muted":false}', '{"v":1,"muted":"no"}', 'nope', '', '[]', 'null']) {
    t.is(soundMuteOf(raw), true, raw)
  }
})

test('bindSoundMute reads the store once and notifies nobody', async (t) => {
  const { bindSoundMute, soundMuted, onSoundMute, SOUND_MUTE_KEY } = await loadFresh()
  let calls = 0
  onSoundMute(() => { calls++ })
  bindSoundMute(fakeStore(new Map([[SOUND_MUTE_KEY, RECORD(true)]])))
  t.is(soundMuted(), true)
  t.is(calls, 0)
  bindSoundMute(fakeStore(new Map([[SOUND_MUTE_KEY, RECORD(false)]])))
  t.is(soundMuted(), true, 'second bind ignored')
})

test('setSoundMuted writes the record text', async (t) => {
  const { bindSoundMute, setSoundMuted, SOUND_MUTE_KEY } = await loadFresh()
  const store = fakeStore()
  bindSoundMute(store)
  setSoundMuted(true)
  t.is(store.entries.get(SOUND_MUTE_KEY), '{"v":1,"muted":true}')
  setSoundMuted(false)
  t.is(store.entries.get(SOUND_MUTE_KEY), '{"v":1,"muted":false}')
})

test('a throwing read leaves sound on', async (t) => {
  const { bindSoundMute, soundMuted } = await loadFresh()
  bindSoundMute({ getItem: () => { throw new Error('read') }, setItem () {} })
  t.is(soundMuted(), false)
})

test('a throwing write still mutes and notifies', async (t) => {
  const { bindSoundMute, setSoundMuted, soundMuted, onSoundMute } = await loadFresh()
  bindSoundMute({ getItem: () => null, setItem: () => { throw new Error('write') } })
  let calls = 0
  onSoundMute(() => { calls++ })
  setSoundMuted(true)
  t.is(soundMuted(), true)
  t.is(calls, 1)
})

test('the saved choice survives a restart', async (t) => {
  for (const value of [true, false]) {
    const store = fakeStore()
    const first = await loadFresh()
    first.bindSoundMute(store)
    first.setSoundMuted(!value)
    first.setSoundMuted(value)
    const second = await loadFresh()
    second.bindSoundMute(store)
    t.is(second.soundMuted(), value)
  }
})

test('web sound mute store keeps a session value when storage throws', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const unavailable = () => { throw new Error('unavailable') }
  const scenarios = [
    undefined,
    { configurable: true, value: { getItem: unavailable, setItem: unavailable } },
    { configurable: true, get: unavailable }
  ]
  try {
    for (const [n, descriptor] of scenarios.entries()) {
      delete globalThis.localStorage
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      const { soundMuteStore } = await import('../src/soundMuteStore.web.js?unavailable=' + n)
      const store = soundMuteStore()
      t.is(store.getItem('k'), null)
      store.setItem('k', RECORD(true))
      t.is(soundMuteStore().getItem('k'), RECORD(true))
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
})

test('web sound mute store persists through localStorage', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const entries = new Map([['varanda-som-mudo', RECORD(true)]])
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeStore(entries) })
    const { soundMuteStore } = await import('../src/soundMuteStore.web.js?working')
    t.is(soundMuteStore().getItem('varanda-som-mudo'), RECORD(true))
    soundMuteStore().setItem('varanda-som-mudo', RECORD(false))
    t.is(entries.get('varanda-som-mudo'), RECORD(false))
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
})

test('native sound mute store source pins', (t) => {
  const native = fs.readFileSync(path.join(__dirname, '../src/soundMuteStore.native.js'), 'utf8')
  t.ok(/file\('\.tmp'\)\.create\(\)/.test(native))
  t.alike(native.match(/^\s*.*\.write\(.*$/gm)?.map(line => line.trim()), ["file('.tmp').write(value)"], 'only the temporary file is written')
  t.ok(native.includes("file().move(file('.bak'))"), 'the current file is set aside')
  t.ok(native.includes("return present ? '' : null"))
  t.ok(native.includes('varanda-som-mudo.json'))
  t.ok(native.indexOf("require('expo-file-system')") > native.indexOf('export function soundMuteStore () {'), 'filesystem loading stays lazy')
  t.absent(/import\s.*['"]expo-file-system['"]/.test(native))
})

function fakeFs () {
  const files = new Map()
  const state = { failWrite: false, unreadable: false }
  class File {
    constructor (dir, name) { this.name = name }
    get exists () { return files.has(this.name) }
    create () { files.set(this.name, '') }
    write (v) { if (state.failWrite) throw new Error('disk'); files.set(this.name, v) }
    delete () { files.delete(this.name) }
    move (to) {
      if (files.has(to.name)) throw new Error('exists')
      files.set(to.name, files.get(this.name)); files.delete(this.name)
    }

    textSync () { if (state.unreadable) throw new Error('read'); return files.get(this.name) }
  }
  return { files, state, mod: { File, Paths: { document: 'doc' } } }
}

function nativeStore (mod) {
  const source = fs.readFileSync(path.join(__dirname, '../src/soundMuteStore.native.js'), 'utf8')
    .replace('export function', 'function')
  // eslint-disable-next-line no-new-func
  return new Function('require', source + '\nreturn soundMuteStore')((id) => mod)()
}

test('native sound mute store behaviour on an in-memory file system', (t) => {
  const a = fakeFs()
  t.is(nativeStore(a.mod).getItem('k'), null, 'no file reads as absent')

  const b = fakeFs()
  const sb = nativeStore(b.mod)
  sb.setItem('k', 'one')
  t.is(sb.getItem('k'), 'one')
  b.state.failWrite = true
  t.exception(() => sb.setItem('k', 'two'))
  b.state.failWrite = false
  t.is(sb.getItem('k'), 'one', 'a failed write leaves the old value')
  sb.setItem('k', 'three')
  t.is(sb.getItem('k'), 'three')
  b.state.unreadable = true
  t.is(sb.getItem('k'), '', 'unreadable file reads as present but invalid')

  const c = fakeFs()
  c.files.set('varanda-som-mudo.json.bak', 'saved')
  t.is(nativeStore(c.mod).getItem('k'), 'saved', 'a backup alone is read')
})

test('App binds the saved sound choice at module top level', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(/^bindSoundMute\(soundMuteStore\(\)\)$/m.test(source))
})
