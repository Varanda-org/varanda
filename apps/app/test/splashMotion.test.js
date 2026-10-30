'use strict'

// The splash timings (src/ui/splashMotion.js), a pure ES module; import()
// loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/ui/splashMotion.js')

test('splashMotion: constants', async (t) => {
  const m = await load()
  t.is(m.SPLASH_WORD, 'Varanda')
  t.ok(m.SPLASH_HINT.endsWith('…'))
  t.absent(m.SPLASH_HINT.includes('...'))
  t.is(m.SPLASH_LABEL, 'Varanda, conectando')
  t.is(m.PULSE_MS, 1200)
  t.is(m.ENTRANCE_MS, 1180)
})

test('splashMotion: full choreography', async (t) => {
  const { splashMotion, ENTRANCE_MS } = await load()
  const m = splashMotion(false)
  t.is(m.letters.length, 7)
  t.alike(m.letters.map((l) => l.delay), [420, 460, 500, 540, 580, 620, 660])
  t.ok(m.letters.every((l) => l.duration === 280))
  t.is(m.chair.delay, 0)
  t.is(m.chair.duration, 700)
  t.alike(m.chair.from, { opacity: 0, translateY: 16, scale: 0.92, rotate: -6 })
  t.alike(m.chair.to, { opacity: 1, translateY: 0, scale: 1, rotate: 0 })
  t.is(m.hint.delay, 860)
  t.is(m.hint.duration, 320)
  t.is(ENTRANCE_MS, m.hint.delay + m.hint.duration)
})

test('splashMotion: reduced motion settles at once', async (t) => {
  const { splashMotion } = await load()
  const m = splashMotion(true)
  t.is(m.letters.length, 7)
  for (const s of [m.chair, ...m.letters, m.hint]) {
    t.is(s.delay, 0)
    t.is(s.duration, 0)
    t.alike(s.from, s.to)
  }
})

test('splashMotion: stays pure', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/splashMotion.js'), 'utf8')
  for (const bad of ["from 'react", 'require(', 'node:', './theme']) {
    t.absent(src.includes(bad), bad)
  }
})
