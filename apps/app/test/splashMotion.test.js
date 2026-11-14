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
  t.is(m.SPLASH_HINT, undefined, 'no connecting text any more')
  t.is(m.SPLASH_LABEL, 'Varanda, carregando')
  t.is(m.BAR_WIDTH, 120)
  t.is(m.BAR_MS, 400)
  t.is(m.PULSE_MS, 1200)
  t.is(m.ENTRANCE_MS, 1280)
})

test('splashMotion: full choreography', async (t) => {
  const { splashMotion, ENTRANCE_MS } = await load()
  const { SPLASH_MIN_MS } = await import('../src/splashGate.js')
  const m = splashMotion(false)
  t.alike(m.ground, {
    delay: 0,
    duration: 360,
    from: { opacity: 0, translateY: 24 },
    to: { opacity: 1, translateY: 0 }
  })
  t.alike(m.varanda, {
    delay: 120,
    duration: 420,
    from: { opacity: 0, translateY: 12 },
    to: { opacity: 1, translateY: 0 }
  })
  t.is(m.letters.length, 7)
  t.alike(m.letters.map((l) => l.delay), [520, 560, 600, 640, 680, 720, 760])
  t.ok(m.letters.every((l) => l.duration === 280))
  t.is(m.chair.delay, 260)
  t.is(m.chair.duration, 700)
  t.alike(m.chair.from, { opacity: 0, translateY: 28, scale: 0.92, rotate: -6 })
  t.alike(m.chair.to, { opacity: 1, translateY: 0, scale: 1, rotate: 0 })
  t.is(m.hint.delay, 960)
  t.is(m.hint.duration, 320)
  const steps = [m.ground, m.varanda, m.chair, ...m.letters, m.hint]
  t.is(ENTRANCE_MS, Math.max(...steps.map((s) => s.delay + s.duration)))
  t.ok(ENTRANCE_MS <= SPLASH_MIN_MS, 'the entrance fits within the minimum splash')
  t.ok(m.chair.delay + m.chair.duration > m.varanda.delay + m.varanda.duration, 'the chair lands after the varanda is in')
})

test('slideMotion: continuous slide speeds match the landing page', async (t) => {
  const { SLIDES, slideMotion } = await load()
  t.alike(SLIDES, { near: { tile: 96, ms: 4800 }, far: { tile: 128, ms: 20800 } })
  t.is(slideMotion(false), SLIDES)
  t.ok(Math.abs(SLIDES.near.tile / SLIDES.near.ms - 320 / 16000) < 1e-9)
  t.ok(Math.abs(SLIDES.far.tile / SLIDES.far.ms - 160 / 26000) < 1e-9)
  t.is(slideMotion(true), null, 'reduced motion has no slides')
})

test('splashMotion: reduced motion settles at once', async (t) => {
  const { splashMotion } = await load()
  const m = splashMotion(true)
  t.is(m.letters.length, 7)
  for (const s of [m.ground, m.varanda, m.chair, ...m.letters, m.hint]) {
    t.is(s.delay, 0)
    t.is(s.duration, 0)
    t.alike(s.from, s.to)
  }
})

test('flyers: birds cross slowly, the butterfly flaps fast', async (t) => {
  const { FLYERS, flyerMotion, birdBob, butterflyDrift } = await load()
  t.is(FLYERS.birds.length, 3)
  const phases = FLYERS.birds.map((b) => b.phase)
  t.is(new Set(phases).size, 3, 'different phases')
  for (const b of FLYERS.birds) {
    t.ok(b.ms >= 28000 && b.ms <= 40000, 'a crossing takes 28 to 40 s')
    t.ok(b.phase > 0 && b.phase < 1)
    t.ok(Number.isInteger(b.bobs) && b.bobs > 0, 'whole bobs per crossing, so the loop is seamless')
    t.ok(b.bob >= 2 && b.bob <= 4, 'about 3 px of bob')
    const bob = birdBob(b)
    t.is(bob.input[0], 0)
    t.is(bob.input[bob.input.length - 1], 1)
    t.is(bob.output[0], 0, 'rest at the start')
    t.is(bob.output[bob.output.length - 1], 0, 'rest at the end')
    t.ok(Math.max(...bob.output.map(Math.abs)) <= b.bob)
  }
  const f = FLYERS.butterfly
  t.is(f.flapMs, 240)
  t.is(f.fold, 0.35)
  t.is(f.driftMs, 6000)
  t.alike([f.dx, f.dy], [24, 10])
  const d = butterflyDrift(f)
  t.alike([d.x[0], d.y[0], d.x[d.x.length - 1], d.y[d.y.length - 1]], [0, 0, 0, 0], 'the drift loops through its rest point')
  t.ok(Math.max(...d.x.map(Math.abs)) <= f.dx && Math.max(...d.y.map(Math.abs)) <= f.dy)
  t.is(flyerMotion(false), FLYERS)
  t.is(flyerMotion(true), null, 'reduced motion keeps the flyers still')
})

test('splashMotion: stays pure', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/splashMotion.js'), 'utf8')
  for (const bad of ["from 'react", 'require(', 'node:', './theme']) {
    t.absent(src.includes(bad), bad)
  }
})
