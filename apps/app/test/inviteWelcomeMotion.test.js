'use strict'

// Welcome choreography (src/inviteWelcomeMotion.js), a pure ES module;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { REGIONS } = require('@varanda/rpc')

const load = () => import('../src/inviteWelcomeMotion.js')

const REST = { opacity: 1, translateX: 0, translateY: 0, scale: 1, rotate: 0 }
const TEXT_TO = { opacity: 1, translateY: 0 }

function clock () {
  let t = 0
  let id = 0
  const timers = new Map()
  return {
    setTimer (fn, ms) {
      const handle = ++id
      timers.set(handle, { at: t + ms, fn, ms })
      return handle
    },
    clearTimer (handle) { timers.delete(handle) },
    pending () { return timers.size },
    advance (ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [k, v] of timers) {
          if (v.at <= end && (next === null || v.at < timers.get(next).at)) next = k
        }
        if (next === null) break
        const entry = timers.get(next)
        timers.delete(next)
        t = entry.at
        entry.fn()
      }
      t = end
    }
  }
}

// A thenable the test resolves by hand, so the entrance stays synchronous.
function manualPromise () {
  let onOk = null
  let onErr = null
  return {
    promise: {
      then (ok, err) {
        onOk = ok
        onErr = err
      }
    },
    resolve (value) { onOk(value) },
    reject (err) { onErr(err) }
  }
}

function fakeEnv (options = {}) {
  const time = clock()
  const box = manualPromise()
  const calls = { play: 0, settle: 0, haptic: 0, unsubscribe: 0 }
  const delayArgs = []
  const leaked = []
  let listener = null
  let handed = null
  let finished = null
  let sealed = false
  function note (name) {
    if (sealed) leaked.push(name)
  }
  const deps = {
    query () {
      note('query')
      if (options.throwQuery) throw new Error('query failed')
      return box.promise
    },
    subscribe (cb) {
      note('subscribe')
      handed = cb
      listener = cb
      return () => {
        note('unsubscribe')
        calls.unsubscribe++
        listener = null
      }
    },
    setTimer (fn, ms) {
      note('setTimer')
      delayArgs.push(ms)
      return time.setTimer(fn, ms)
    },
    clearTimer (handle) {
      note('clearTimer')
      time.clearTimer(handle)
    },
    play (cb) {
      note('play')
      calls.play++
      finished = cb
    },
    settle () {
      note('settle')
      calls.settle++
    },
    haptic () {
      note('haptic')
      calls.haptic++
    }
  }
  return {
    deps,
    calls,
    delayArgs,
    leaked,
    pending: () => time.pending(),
    advance: (ms) => time.advance(ms),
    seal () { sealed = true },
    resolve: (value) => box.resolve(value),
    reject: (err) => box.reject(err),
    emit (value) { if (listener) listener(value) },
    // The callback the producer was given, even after unsubscribe dropped it.
    callListener (value) { handed(value) },
    finish (value) { finished(value) }
  }
}

test('welcome motion constants', async (t) => {
  const m = await load()
  t.alike([...m.WELCOME_BEZIER], [0.22, 1, 0.36, 1])
  t.ok(Object.isFrozen(m.WELCOME_BEZIER))
  t.is(m.MOTIF_MS, 720)
  t.is(m.MOTIF_DELAY_MS, 80)
  t.is(m.MAX_MOTIFS, 9)
  t.is(m.WELCOME_MS, 1500)
  t.is(m.HAPTIC_MS, 420)
  t.is(m.PREF_WAIT_MS, 300)
})

test('REGION_MOTION is the region list, deep frozen, with pinned arrivals', async (t) => {
  const { REGION_MOTION, NEUTRAL_MOTION } = await load()
  t.alike(Object.keys(REGION_MOTION).sort(), REGIONS.map((region) => region.id).sort())
  t.ok(Object.isFrozen(REGION_MOTION))
  t.ok(Object.isFrozen(NEUTRAL_MOTION))
  t.ok(Object.isFrozen(NEUTRAL_MOTION.from))
  const pinned = {
    norte: { from: { translateX: 12, translateY: 48, scale: 0.8, rotate: 0 }, mirror: true, stagger: 70 },
    nordeste: { from: { translateX: 0, translateY: -56, scale: 1, rotate: 14 }, mirror: true, stagger: 60 },
    'centro-oeste': { from: { translateX: -24, translateY: -64, scale: 0.7, rotate: -20 }, mirror: false, stagger: 80 },
    sudeste: { from: { translateX: 0, translateY: 0, scale: 0.2, rotate: 0 }, mirror: false, stagger: 50 },
    sul: { from: { translateX: 64, translateY: 0, scale: 0.9, rotate: 8 }, mirror: false, stagger: 70 }
  }
  for (const id of Object.keys(pinned)) {
    const entry = REGION_MOTION[id]
    t.ok(Object.isFrozen(entry), id)
    t.ok(Object.isFrozen(entry.from), id)
    t.alike({ ...entry.from }, pinned[id].from, id)
    t.is(entry.mirror, pinned[id].mirror, id)
    t.is(entry.stagger, pinned[id].stagger, id)
  }
  t.alike({ ...NEUTRAL_MOTION.from }, { translateX: 0, translateY: 16, scale: 1, rotate: 0 })
  t.is(NEUTRAL_MOTION.mirror, false)
  t.is(NEUTRAL_MOTION.stagger, 70)
})

test('motifMotion mirrors only regions that swing, and keeps -0 off the result', async (t) => {
  const { motifMotion } = await load()
  t.is(motifMotion('norte', 0, -1, false).from.translateX, -12)
  t.is(motifMotion('norte', 0, 1, false).from.translateX, 12)
  t.is(motifMotion('norte', 0, 0, false).from.translateX, 12)
  t.alike(motifMotion('norte', 0, -1, false).from, {
    opacity: 0, translateX: -12, translateY: 48, scale: 0.8, rotate: 0
  })
  t.is(motifMotion('nordeste', 1, -1, false).from.rotate, -14)
  t.alike(motifMotion('nordeste', 0, -1, false).from, {
    opacity: 0, translateX: 0, translateY: -56, scale: 1, rotate: -14
  })
  t.is(Object.is(motifMotion('nordeste', 0, -1, false).from.translateX, 0), true)
  t.is(Object.is(motifMotion('norte', 0, -1, false).from.rotate, 0), true)
  t.is(motifMotion('sul', 3, -1, false).from.translateX, 64)
  const slant = motifMotion('centro-oeste', 0, -1, false).from
  t.is(slant.translateX, -24)
  t.is(slant.rotate, -20)
})

test('motif delays are 80 plus order times stagger and finish within the welcome', async (t) => {
  const { motifMotion, REGION_MOTION, MOTIF_DELAY_MS, MOTIF_MS, WELCOME_MS, MAX_MOTIFS } = await load()
  const regions = [...Object.keys(REGION_MOTION), null]
  for (const region of regions) {
    const stagger = region === null ? 70 : REGION_MOTION[region].stagger
    for (let order = 0; order < MAX_MOTIFS; order++) {
      const motion = motifMotion(region, order, 1, false)
      t.is(motion.delay, MOTIF_DELAY_MS + order * stagger, String(region) + ' ' + order)
      t.is(motion.duration, MOTIF_MS)
      t.ok(motion.delay + motion.duration <= WELCOME_MS, String(region) + ' ' + order)
      t.alike(motion.to, REST)
    }
  }
})

test('motif order clamps to an integer 0..8', async (t) => {
  const { motifMotion } = await load()
  t.alike(motifMotion('sul', -1, -1, false), motifMotion('sul', 0, -1, false))
  t.alike(motifMotion('sul', 2.5, 1, false), motifMotion('sul', 0, 1, false))
  t.alike(motifMotion('sul', 99, 1, false), motifMotion('sul', 8, 1, false))
  t.is(motifMotion('norte', -1, 1, false).delay, motifMotion('norte', 0, 1, false).delay)
  t.is(motifMotion('norte', 2.5, 1, false).delay, motifMotion('norte', 0, 1, false).delay)
  t.is(motifMotion('norte', 99, -1, false).delay, motifMotion('norte', 8, -1, false).delay)
})

test('an unknown region matches the null region, and each call is a fresh copy', async (t) => {
  const { motifMotion } = await load()
  t.alike(motifMotion('nao-existe', 4, -1, false), motifMotion(null, 4, -1, false))
  t.alike(motifMotion(undefined, 2, 1, false), motifMotion(null, 2, 1, false))
  const a = motifMotion('norte', 1, 1, false)
  const b = motifMotion('norte', 1, 1, false)
  t.ok(a !== b)
  t.ok(a.from !== b.from)
  t.ok(a.to !== b.to)
  t.ok(a.from !== a.to)
  a.from.translateX = 999
  a.to.opacity = 0
  t.is(b.from.translateX, 12)
  t.is(b.to.opacity, 1)
  const reduced = motifMotion('norte', 0, -1, true)
  reduced.from.opacity = 0
  t.is(motifMotion('norte', 0, -1, true).from.opacity, 1)
  t.is(reduced.to.opacity, 1)
})

test('reduced motion settles motifs and header beats with no haptic', async (t) => {
  const { motifMotion, welcomeMotion, REGION_MOTION } = await load()
  for (const region of [...Object.keys(REGION_MOTION), null, 'nao-existe']) {
    for (let order = 0; order < 9; order++) {
      const motion = motifMotion(region, order, -1, true)
      t.is(motion.delay, 0)
      t.is(motion.duration, 0)
      t.alike(motion.from, motion.to)
      t.alike(motion.to, REST)
    }
  }
  const still = welcomeMotion(true)
  for (const beat of [still.tag, still.title, still.line]) {
    t.is(beat.delay, 0)
    t.is(beat.duration, 0)
    t.alike(beat.from, beat.to)
    t.alike(beat.to, TEXT_TO)
  }
  t.is(still.hapticAt, null)
  still.tag.from.opacity = 0
  t.is(welcomeMotion(true).tag.from.opacity, 1)
})

test('welcomeMotion plays unless reduced is exactly true, with no card beat', async (t) => {
  const { welcomeMotion } = await load()
  const playing = {
    tag: { delay: 120, duration: 360, from: { opacity: 0, translateY: 10 }, to: { opacity: 1, translateY: 0 } },
    title: { delay: 220, duration: 420, from: { opacity: 0, translateY: 10 }, to: { opacity: 1, translateY: 0 } },
    line: { delay: 380, duration: 420, from: { opacity: 0, translateY: 10 }, to: { opacity: 1, translateY: 0 } },
    hapticAt: 420
  }
  t.alike(welcomeMotion(false), playing)
  t.alike(welcomeMotion(undefined), playing)
  t.alike(welcomeMotion(), playing)
  t.alike(welcomeMotion(null), playing)
  t.alike(welcomeMotion(0), playing)
  for (const reduced of [true, false, undefined]) {
    const motion = welcomeMotion(reduced)
    t.absent(Object.hasOwn(motion, 'card'))
    t.absent(Object.hasOwn(motion, 'sway'))
    t.absent(Object.hasOwn(motion, 'loop'))
  }
  const a = welcomeMotion(false)
  a.tag.from.opacity = 1
  a.title.delay = 0
  t.is(welcomeMotion(false).tag.from.opacity, 0)
  t.is(welcomeMotion(false).title.delay, 220)
})

test('motionPref allows only a successful false', async (t) => {
  const { motionPref } = await load()
  t.is(motionPref(false, false), 'allow')
  t.is(motionPref(true, false), 'reduce')
  t.is(motionPref(undefined, false), 'reduce')
  t.is(motionPref('no', false), 'reduce')
  t.is(motionPref(false, true), 'reduce')
})

test('welcomeStep table, including a preference that never answers', async (t) => {
  const { welcomeStep } = await load()
  const rows = [
    ['unknown', true, 'idle', false, 'none'],
    ['unknown', true, 'idle', true, 'settle'],
    ['unknown', true, 'playing', false, 'none'],
    ['unknown', true, 'playing', true, 'settle'],
    ['unknown', true, 'done', false, 'none'],
    ['unknown', true, 'done', true, 'none'],
    ['unknown', false, 'idle', false, 'none'],
    ['unknown', false, 'idle', true, 'settle'],
    ['unknown', false, 'playing', false, 'none'],
    ['unknown', false, 'playing', true, 'settle'],
    ['unknown', false, 'done', false, 'none'],
    ['unknown', false, 'done', true, 'none'],
    ['allow', true, 'idle', false, 'play'],
    ['allow', true, 'idle', true, 'play'],
    ['allow', true, 'playing', false, 'none'],
    ['allow', true, 'playing', true, 'none'],
    ['allow', true, 'done', false, 'none'],
    ['allow', true, 'done', true, 'none'],
    ['allow', false, 'idle', false, 'none'],
    ['allow', false, 'idle', true, 'none'],
    ['allow', false, 'playing', false, 'none'],
    ['allow', false, 'playing', true, 'none'],
    ['allow', false, 'done', false, 'none'],
    ['allow', false, 'done', true, 'none'],
    ['reduce', true, 'idle', false, 'settle'],
    ['reduce', true, 'idle', true, 'settle'],
    ['reduce', true, 'playing', false, 'settle'],
    ['reduce', true, 'playing', true, 'settle'],
    ['reduce', true, 'done', false, 'none'],
    ['reduce', true, 'done', true, 'none'],
    ['reduce', false, 'idle', false, 'settle'],
    ['reduce', false, 'idle', true, 'settle'],
    ['reduce', false, 'playing', false, 'settle'],
    ['reduce', false, 'playing', true, 'settle'],
    ['reduce', false, 'done', false, 'none'],
    ['reduce', false, 'done', true, 'none']
  ]
  t.is(rows.length, 36)
  for (const [pref, measured, phase, waited, wanted] of rows) {
    t.is(welcomeStep({ pref, measured, phase, waited }), wanted, [pref, measured, phase, waited].join(' '))
  }
})

test('deferred allow then measure plays once and haptics at 420', async (t) => {
  const { createEntrance, PREF_WAIT_MS, HAPTIC_MS } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  t.alike(env.delayArgs, [PREF_WAIT_MS])
  env.resolve(false)
  t.is(env.calls.play, 0, 'not before measure')
  entrance.measure(true)
  t.is(env.calls.play, 1)
  t.is(env.calls.settle, 0)
  t.alike(env.delayArgs, [PREF_WAIT_MS, HAPTIC_MS])
  env.advance(HAPTIC_MS - 1)
  t.is(env.calls.haptic, 0, 'not before 420')
  env.advance(1)
  t.is(env.calls.haptic, 1)
  env.advance(2000)
  t.is(env.calls.haptic, 1, 'once')
  t.is(env.calls.play, 1)
  entrance.measure(true)
  t.is(env.calls.play, 1, 'no replay')
})

test('measure then allow plays once', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  entrance.measure(true)
  t.is(env.calls.play, 0)
  env.resolve(false)
  t.is(env.calls.play, 1)
  t.is(env.calls.settle, 0)
  env.advance(420)
  t.is(env.calls.haptic, 1)
  t.is(env.calls.play, 1)
})

test('a rejected preference settles with no play and no haptic', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  createEntrance(env.deps)
  env.reject(new Error('preference failed'))
  t.is(env.calls.settle, 1)
  t.is(env.calls.play, 0)
  t.is(env.calls.haptic, 0)
  env.advance(5000)
  t.is(env.calls.settle, 1)
  t.is(env.calls.play, 0)
  t.is(env.calls.haptic, 0)
})

test('a throwing preference query settles', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv({ throwQuery: true })
  const entrance = createEntrance(env.deps)
  t.is(env.calls.settle, 1)
  t.is(env.calls.play, 0)
  t.is(env.calls.haptic, 0)
  entrance.measure(true)
  env.emit(false)
  t.is(env.calls.play, 0, 'allow after settle does not play')
  t.is(env.calls.settle, 1)
  env.advance(5000)
  t.is(env.calls.haptic, 0)
})

test('a preference that never answers settles at 300 ms and a later allow does not play', async (t) => {
  const { createEntrance, PREF_WAIT_MS } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  env.advance(PREF_WAIT_MS - 1)
  t.is(env.calls.settle, 0)
  t.is(env.calls.play, 0)
  env.advance(1)
  t.is(env.calls.settle, 1)
  t.is(env.calls.play, 0)
  t.is(env.calls.haptic, 0)
  env.resolve(false)
  entrance.measure(true)
  t.is(env.calls.play, 0, 'late allow does not play')
  t.is(env.calls.settle, 1)
  t.alike(env.delayArgs, [PREF_WAIT_MS])
})

test('a reduce event during play settles and the pending haptic never fires', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  env.resolve(false)
  entrance.measure(true)
  t.is(env.calls.play, 1)
  t.is(env.pending(), 2)
  env.emit(true)
  t.is(env.calls.settle, 1)
  t.is(env.pending(), 1, 'haptic timer cleared')
  env.advance(5000)
  t.is(env.calls.haptic, 0)
  t.is(env.calls.play, 1)
  t.is(env.calls.settle, 1)
})

test('an allow event after done does not replay', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  env.resolve(false)
  entrance.measure(true)
  env.finish(true)
  env.emit(false)
  t.is(env.calls.play, 1)
  t.is(env.calls.settle, 0)
  entrance.measure(true)
  env.emit(false)
  t.is(env.calls.play, 1)
})

test('an event wins over a later query answer', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  entrance.measure(true)
  env.emit(false)
  t.is(env.calls.play, 1)
  env.resolve(true)
  t.is(env.calls.settle, 0, 'stale reduce does not cancel')
  t.is(env.calls.play, 1)
})

test('dispose before the answer calls nothing afterwards', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  entrance.dispose()
  t.is(env.calls.unsubscribe, 1)
  t.is(env.pending(), 0)
  entrance.dispose()
  t.is(env.calls.unsubscribe, 1, 'unsubscribe once')
  env.seal()
  env.resolve(false)
  env.callListener(false)
  env.advance(1000)
  entrance.measure(true)
  t.alike(env.leaked, [])
  t.is(env.calls.play, 0)
  t.is(env.calls.settle, 0)
  t.is(env.calls.haptic, 0)
})

test('unmeasured never plays', async (t) => {
  const { createEntrance } = await load()
  const env = fakeEnv()
  const entrance = createEntrance(env.deps)
  env.resolve(false)
  env.advance(5000)
  t.is(env.calls.play, 0)
  t.is(env.calls.haptic, 0)
  t.is(env.calls.settle, 0)
  entrance.measure(false)
  t.is(env.calls.play, 0)
  entrance.measure(true)
  t.is(env.calls.play, 1)
})

test('welcome motion module stays pure', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/inviteWelcomeMotion.js'), 'utf8')
  t.absent(source.includes('\u2014'))
  t.absent(source.includes("from 'react"))
  t.absent(source.includes('react-native'))
  t.absent(source.includes('Platform'))
  t.absent(source.includes('Math.random'))
  t.absent(source.includes('require('))
  t.absent(source.includes('node:'))
  t.absent(source.includes('Date'))
})
