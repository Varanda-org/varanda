'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/soundMute.js')

async function session (t) {
  const sound = await load()
  const { clearMusicAutoHold } = await import('../src/postMusic.js')
  t.teardown(() => {
    sound.setSoundMuted(false)
    clearMusicAutoHold()
  })
  return sound
}

test('session sound defaults to unmuted with Portuguese labels', async (t) => {
  const { SOUND_MUTE_LABEL, SOUND_UNMUTE_LABEL, soundMuted } = await load()
  t.is(soundMuted(), false)
  t.is(SOUND_MUTE_LABEL, 'Silenciar som')
  t.is(SOUND_UNMUTE_LABEL, 'Ativar som')
})

test('session sound can be muted and unmuted', async (t) => {
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
