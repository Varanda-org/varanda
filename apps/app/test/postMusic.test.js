'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/postMusic.js')
const loadEmbed = () => import('../src/embedLive.js')
const loadSound = () => import('../src/soundMute.js')

function memoryStore (entries = new Map()) {
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) }
  }
}

test('music defaults to on and explains the preference in Portuguese', async (t) => {
  const { MUSIC_AUTO_PREF_LABEL, MUSIC_AUTO_PREF_NOTE, musicAutoEnabled } = await load()
  t.is(MUSIC_AUTO_PREF_LABEL, 'Tocar música sozinha')
  t.is(MUSIC_AUTO_PREF_NOTE, 'Ligada, a música de uma publicação toca quando aparece na tela, e o app pede a faixa ao serviço de conta. Desligada, só toca quando você toca no cartão.')
  t.is(musicAutoEnabled(memoryStore()), true)
})

test('music preference persists off and on across store instances', async (t) => {
  const { musicAutoEnabled, setMusicAutoEnabled } = await load()
  const entries = new Map([['unrelated', 'keep']])
  t.is(setMusicAutoEnabled(memoryStore(entries), false), true)
  t.is(entries.get('varanda-musica-sozinha'), '{"v":1,"enabled":false}')
  t.is(musicAutoEnabled(memoryStore(entries)), false)
  t.is(entries.get('unrelated'), 'keep')
  t.is(entries.size, 2)
  t.is(setMusicAutoEnabled(memoryStore(entries), true), true)
  t.is(entries.get('varanda-musica-sozinha'), '{"v":1,"enabled":true}')
  t.is(musicAutoEnabled(memoryStore(entries)), true)
  t.is(musicAutoEnabled(memoryStore()), true, 'device stores are independent')
})

test('missing records and unavailable stores read as on', async (t) => {
  const { musicAutoEnabled, setMusicAutoEnabled } = await load()
  const broken = {
    getItem () { throw new Error('unavailable') },
    setItem () { throw new Error('unavailable') }
  }
  for (const store of [null, undefined, {}, broken]) {
    t.is(musicAutoEnabled(store), true)
    t.is(setMusicAutoEnabled(store, false), false)
  }
  for (const raw of [undefined, null, false]) {
    t.is(musicAutoEnabled({ getItem: () => raw }), true)
  }
})

test('present music records enable autoplay only with the exact valid schema', async (t) => {
  const { musicAutoEnabled } = await load()
  for (const raw of ['', '{', 'null', '[]', 'false', '1', '"on"', '{}',
    '{"enabled":false}', '{"v":2,"enabled":false}', '{"v":2,"enabled":true}',
    '{"v":1,"enabled":"false"}', '{"v":1,"enabled":"no"}', '{"v":1,"enabled":0}',
    '{"v":1,"enabled":true,"extra":1}']) {
    t.is(musicAutoEnabled({ getItem: () => raw }), false, raw)
  }
  t.is(musicAutoEnabled({ getItem: () => '{"v":1,"enabled":true}' }), true)
  t.is(musicAutoEnabled({ getItem: () => '{"v":1,"enabled":false}' }), false)
})

test('web music opt-out survives unavailable storage for the whole session', async (t) => {
  const { musicAutoEnabled, setMusicAutoEnabled } = await load()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const unavailable = () => { throw new Error('unavailable') }
  const scenarios = [
    undefined,
    { configurable: true, value: { getItem: unavailable, setItem: unavailable } },
    { configurable: true, get: unavailable }
  ]
  try {
    for (const [session, descriptor] of scenarios.entries()) {
      delete globalThis.localStorage
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      const { musicAutoStore } = await import('../src/musicAutoStore.web.js?unavailable=' + session)
      const store = musicAutoStore()
      t.is(musicAutoEnabled(store), true)
      t.is(setMusicAutoEnabled(store, false), true)
      t.is(musicAutoEnabled(musicAutoStore()), false, 'a new reader sees the session opt-out')
      t.is(setMusicAutoEnabled(store, true), true)
      t.is(musicAutoEnabled(musicAutoStore()), true)
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
})

test('web music preference persists when storage works and survives write failures', async (t) => {
  const { musicAutoEnabled, setMusicAutoEnabled } = await load()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const entries = new Map([['varanda-musica-sozinha', '{"v":1,"enabled":false}']])
  const storage = memoryStore(entries)
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    const { musicAutoStore } = await import('../src/musicAutoStore.web.js?working')
    const store = musicAutoStore()
    t.is(musicAutoEnabled(store), false, 'reads the persisted opt-out before a session write')
    t.is(setMusicAutoEnabled(store, true), true)
    t.is(entries.get('varanda-musica-sozinha'), '{"v":1,"enabled":true}')
    const reloaded = await import('../src/musicAutoStore.web.js?reload')
    t.is(musicAutoEnabled(reloaded.musicAutoStore()), true, 'a fresh session reads the saved choice')
    storage.setItem = () => { throw new Error('quota') }
    t.is(setMusicAutoEnabled(store, false), true)
    t.is(musicAutoEnabled(musicAutoStore()), false, 'the session opt-out overrides stale storage')
    t.is(entries.get('varanda-musica-sozinha'), '{"v":1,"enabled":true}', 'failed persistence keeps the old disk value')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
})

test('native music preference replaces whole files and recovers the backup', (t) => {
  const native = fs.readFileSync(path.join(__dirname, '../src/musicAutoStore.native.js'), 'utf8')
  t.ok(/file\('\.tmp'\)\.create\(\)/.test(native))
  t.alike(native.match(/^\s*.*\.write\(.*$/gm)?.map(line => line.trim()), ["file('.tmp').write(value)"], 'only the temporary file is written')
  t.ok(native.includes("file().move(file('.bak'))"), 'the current file is set aside')
  const install = native.indexOf("file('.tmp').move(file())")
  t.ok(install >= 0, 'the complete temporary file is moved into place')
  t.ok(native.indexOf("removeQuietly(file('.bak'))", install) > install, 'backup cleanup follows installation')
  t.ok(/for \(const suffix of \['', '\.bak'\]\)/.test(native), 'a missing or unreadable main file reads the backup')
  t.ok(/try \{\s+const f = file\(suffix\)\s+if \(!f\.exists\) continue\s+present = true\s+return f\.textSync\(\)\s+\} catch \{\}/.test(native), 'each copy is read on its own')
  t.ok(native.includes("return present ? '' : null"), 'a file that exists but cannot be read is not taken for a missing one')
  const lazy = native.indexOf("require('expo-file-system')")
  t.ok(lazy > native.indexOf('export function musicAutoStore () {'), 'filesystem loading stays lazy')
  t.absent(/import\s.*['"]expo-file-system['"]/.test(native))
})

test('invalid preference values preserve an explicit opt-out', async (t) => {
  const { musicAutoEnabled, setMusicAutoEnabled } = await load()
  const store = memoryStore()
  setMusicAutoEnabled(store, false)
  for (const value of [null, undefined, 0, 1, 'false', {}, []]) {
    t.is(setMusicAutoEnabled(store, value), false)
    t.is(musicAutoEnabled(store), false)
  }
})

test('preference listeners observe successful writes and isolate failures', async (t) => {
  const { musicAutoEnabled, setMusicAutoEnabled, onMusicAutoChange } = await load()
  const store = memoryStore()
  const observed = []
  let throwingCalls = 0
  const unthrow = onMusicAutoChange(() => {
    throwingCalls++
    throw new Error('listener failed')
  })
  const unsubscribe = onMusicAutoChange(() => { observed.push(musicAutoEnabled(store)) })
  try {
    t.is(setMusicAutoEnabled(store, false), true)
    t.is(setMusicAutoEnabled(store, true), true)
    t.alike(observed, [false, true], 'notification follows persistence')
    t.is(throwingCalls, 2)
    t.is(setMusicAutoEnabled(store, 'false'), false)
    t.is(setMusicAutoEnabled({ setItem () { throw new Error('unavailable') } }, false), false)
    t.alike(observed, [false, true], 'failed writes do not notify')
    t.is(throwingCalls, 2)
    unsubscribe()
    unsubscribe()
    t.is(setMusicAutoEnabled(store, false), true)
    t.alike(observed, [false, true], 'unsubscribed listener stays silent')
    t.is(throwingCalls, 3)
    for (const fn of [null, undefined, false, {}]) t.is(typeof onMusicAutoChange(fn), 'function')
  } finally {
    unsubscribe()
    unthrow()
  }
})

test('only snippets and tracks qualify for ambient music', async (t) => {
  const { ambientKind } = await load()
  t.is(ambientKind({ kind: 'snippet' }), true)
  t.is(ambientKind({ kind: 'track' }), true)
  for (const music of [{ kind: 'playlist' }, null, undefined, false, 1, 'track', [], {}, { kind: 'other' }]) {
    t.is(ambientKind(music), false)
  }
})

test('autoplay refusal is recognized directly and through a cause', async (t) => {
  const { autoplayRefused } = await load()
  t.is(autoplayRefused({ name: 'NotAllowedError' }), true)
  t.is(autoplayRefused({ cause: { name: 'NotAllowedError' } }), true)
  for (const err of [null, undefined, 'NotAllowedError', {}, new Error('NotAllowedError'), { name: 'AbortError' }, { cause: { name: 'AbortError' } }]) {
    t.is(autoplayRefused(err), false)
  }
})

test('music hold is a session latch that can be cleared', async (t) => {
  const { holdMusicAuto, musicAutoHeld, clearMusicAutoHold, setMusicAutoEnabled } = await load()
  t.is(musicAutoHeld(), false)
  try {
    holdMusicAuto()
    holdMusicAuto()
    t.is(musicAutoHeld(), true)
    setMusicAutoEnabled(memoryStore(), true)
    t.is(musicAutoHeld(), true, 'preference writes do not clear the latch')
    clearMusicAutoHold()
    t.is(musicAutoHeld(), false)
    clearMusicAutoHold()
    t.is(musicAutoHeld(), false)
  } finally {
    clearMusicAutoHold()
  }
})

test('music hold tells listeners only when it changes', async (t) => {
  const { holdMusicAuto, clearMusicAutoHold, onMusicAutoHold } = await load()
  const calls = []
  const offA = onMusicAutoHold(() => { calls.push('a') })
  const offThrow = onMusicAutoHold(() => { throw new Error('boom') })
  const offB = onMusicAutoHold(() => { calls.push('b') })
  try {
    holdMusicAuto()
    t.alike(calls, ['a', 'b'], 'a hold reaches every listener, a throwing one included')
    holdMusicAuto()
    t.alike(calls, ['a', 'b'], 'a second hold changes nothing')
    clearMusicAutoHold()
    t.alike(calls, ['a', 'b', 'a', 'b'], 'a clear reaches every listener')
    clearMusicAutoHold()
    t.alike(calls, ['a', 'b', 'a', 'b'], 'a second clear changes nothing')
    offA()
    holdMusicAuto()
    t.alike(calls, ['a', 'b', 'a', 'b', 'b'], 'unsubscribed listeners hear nothing')
    const noop = onMusicAutoHold('nope')
    t.is(typeof noop, 'function', 'a non-function returns a no-op')
    noop()
  } finally {
    offA()
    offThrow()
    offB()
    clearMusicAutoHold()
  }
})

test('session mute changes the effective music hold only once', async (t) => {
  const { musicAutoHeld, clearMusicAutoHold, onMusicAutoHold } = await load()
  const { setSoundMuted } = await loadSound()
  t.teardown(() => {
    setSoundMuted(false)
    clearMusicAutoHold()
  })
  const observed = []
  t.teardown(onMusicAutoHold(() => { observed.push(musicAutoHeld()) }))
  setSoundMuted(true)
  t.is(musicAutoHeld(), true)
  t.alike(observed, [true])
  setSoundMuted(true)
  t.alike(observed, [true])
  setSoundMuted(false)
  t.is(musicAutoHeld(), false)
  t.alike(observed, [true, false])
})

test('clearing an involuntary music hold preserves the session mute', async (t) => {
  const { holdMusicAuto, musicAutoHeld, clearMusicAutoHold, onMusicAutoHold } = await load()
  const { setSoundMuted, soundMuted } = await loadSound()
  t.teardown(() => {
    setSoundMuted(false)
    clearMusicAutoHold()
  })
  const observed = []
  t.teardown(onMusicAutoHold(() => { observed.push(musicAutoHeld()) }))
  setSoundMuted(true)
  holdMusicAuto()
  clearMusicAutoHold()
  t.is(soundMuted(), true)
  t.is(musicAutoHeld(), true)
  t.alike(observed, [true], 'the effective hold has not changed')
  setSoundMuted(false)
  t.is(musicAutoHeld(), false, 'the involuntary hold was cleared')
  t.alike(observed, [true, false])
})

test('an involuntary music hold masks session mute changes', async (t) => {
  const { holdMusicAuto, musicAutoHeld, clearMusicAutoHold, onMusicAutoHold } = await load()
  const { setSoundMuted } = await loadSound()
  t.teardown(() => {
    setSoundMuted(false)
    clearMusicAutoHold()
  })
  const observed = []
  t.teardown(onMusicAutoHold(() => { observed.push(musicAutoHeld()) }))
  holdMusicAuto()
  t.alike(observed, [true])
  setSoundMuted(true)
  t.is(musicAutoHeld(), true)
  t.alike(observed, [true])
  setSoundMuted(false)
  t.is(musicAutoHeld(), true)
  t.alike(observed, [true])
})

test('muted ambient music cannot start and keeps an already live visible row', async (t) => {
  const { ambientStep, clearMusicAutoHold } = await load()
  const { EMBED_IDLE, EMBED_LIVE } = await loadEmbed()
  const { setSoundMuted } = await loadSound()
  t.teardown(() => {
    setSoundMuted(false)
    clearMusicAutoHold()
  })
  setSoundMuted(true)
  let state = EMBED_IDLE
  for (let i = 0; i < 4; i++) {
    const next = ambientStep(state, { hidden: false })
    t.is(next.action, null)
    t.is(next.state.live, false)
    state = next.state
  }
  const live = ambientStep(EMBED_LIVE, { hidden: false })
  t.is(live.action, null)
  t.is(live.state, EMBED_LIVE)
  setSoundMuted(false)
  t.is(ambientStep(state, { hidden: false }).action, 'start', 'unmuting permits the accumulated dwell')
})

test('automatic failures are remembered for the session, at most 500', async (t) => {
  const { markMusicAutoFailed, musicAutoFailed } = await load()
  markMusicAutoFailed('falhou-a')
  t.is(musicAutoFailed('falhou-a'), true, 'a marked key')
  t.is(musicAutoFailed('falhou-b'), false, 'another key')
  markMusicAutoFailed(42)
  markMusicAutoFailed(null)
  t.is(musicAutoFailed(42), false, 'a non-string is ignored')
  t.is(musicAutoFailed(undefined), false)
  markMusicAutoFailed('falhou-a')
  for (let i = 0; i < 499; i++) markMusicAutoFailed('cheio-' + i)
  t.is(musicAutoFailed('falhou-a'), true, '500 keys fit')
  markMusicAutoFailed('cheio-499')
  t.is(musicAutoFailed('falhou-a'), false, 'the oldest key goes first')
  t.is(musicAutoFailed('cheio-0'), true)
  t.is(musicAutoFailed('cheio-499'), true)
})

test('ambient music starts after two seen checks and restarts only after hiding', async (t) => {
  const { ambientStep } = await load()
  const { EMBED_IDLE } = await loadEmbed()
  const seen = { hidden: false, busy: false, failed: false }
  const first = ambientStep(EMBED_IDLE, seen)
  t.alike(first, { state: { live: false, seen: 1 }, action: null })
  t.ok(Object.isFrozen(first))
  t.ok(Object.isFrozen(first.state))
  t.alike(EMBED_IDLE, { live: false, seen: 0 }, 'input state is unchanged')
  const started = ambientStep(first.state, seen)
  t.alike(started, { state: { live: true, seen: 2 }, action: 'start' })
  t.ok(Object.isFrozen(started))
  t.ok(Object.isFrozen(started.state))
  const live = ambientStep(started.state, seen)
  t.is(live.state, started.state)
  t.is(live.action, null, 'an ended snippet is not started again while still seen')
  const hidden = ambientStep(live.state, { hidden: true })
  t.is(hidden.state, EMBED_IDLE)
  t.is(hidden.action, 'stop')
  t.ok(Object.isFrozen(hidden))
  t.is(ambientStep(hidden.state, { hidden: true }).action, null)
  const returning = ambientStep(hidden.state, seen)
  t.is(returning.action, null)
  t.is(returning.state.seen, 1)
  t.is(ambientStep(returning.state, seen).action, 'start')
})

test('busy, failed and held rows cannot start but live rows stay live', async (t) => {
  const { ambientStep, holdMusicAuto, clearMusicAutoHold } = await load()
  const { EMBED_IDLE, EMBED_LIVE } = await loadEmbed()
  for (const reason of ['busy', 'failed', 'held']) {
    const sample = { hidden: false, busy: reason === 'busy', failed: reason === 'failed' }
    if (reason === 'held') holdMusicAuto()
    try {
      let state = EMBED_IDLE
      for (let i = 0; i < 3; i++) {
        const blocked = ambientStep(state, sample)
        t.is(blocked.action, null, reason + ' prevents start')
        t.is(blocked.state.live, false)
        state = blocked.state
      }
      const live = ambientStep(EMBED_LIVE, sample)
      t.is(live.state, EMBED_LIVE, reason + ' does not evict a live row')
      t.is(live.action, null)
      const hidden = ambientStep(live.state, { ...sample, hidden: true })
      t.is(hidden.state, EMBED_IDLE)
      t.is(hidden.action, 'stop')
      clearMusicAutoHold()
      t.is(ambientStep(state, { hidden: false }).action, 'start', 'available rows use the accumulated dwell')
    } finally {
      clearMusicAutoHold()
    }
  }
})

test('malformed ambient inputs return idle and stop a previously live row', async (t) => {
  const { ambientStep } = await load()
  const { EMBED_IDLE, EMBED_LIVE } = await loadEmbed()
  for (const state of [null, undefined, false, 'live', [], {}, { live: 'true', seen: 2 }, { live: false, seen: NaN }, { live: false, seen: Infinity }]) {
    const result = ambientStep(state, { hidden: false })
    t.is(result.state, EMBED_IDLE)
    t.is(result.action, null)
    t.ok(Object.isFrozen(result))
  }
  for (const sample of [null, undefined, false, 'seen', [], {}, { hidden: 'false' }, { get hidden () { throw new Error('unavailable') } }]) {
    const idle = ambientStep(EMBED_IDLE, sample)
    t.is(idle.state, EMBED_IDLE)
    t.is(idle.action, null)
    const live = ambientStep(EMBED_LIVE, sample)
    t.is(live.state, EMBED_IDLE)
    t.is(live.action, 'stop')
    t.ok(Object.isFrozen(live))
  }
  const invalidLive = ambientStep({ live: true, seen: NaN }, { hidden: false })
  t.is(invalidLive.state, EMBED_IDLE)
  t.is(invalidLive.action, 'stop')
})

test('platform stores keep the music preference separate from link previews', (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  const web = read('musicAutoStore.web.js')
  const native = read('musicAutoStore.native.js')
  t.ok(web.includes('globalThis.localStorage'))
  t.absent(native.includes('localStorage'))
  t.ok(native.includes('varanda-musica-sozinha.json'))
  t.absent(web.includes('varanda-previas-links'))
  t.absent(native.includes('varanda-previas-links'))
})
