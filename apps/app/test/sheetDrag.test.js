'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { runInNewContext } = require('node:vm')

const load = () => import('../src/sheetDrag.js')
const source = fs.readFileSync(path.join(__dirname, '../src/ui/Sheet.js'), 'utf8')

test('claimDrag takes only a mostly vertical downward move over eight points', async (t) => {
  const { claimDrag } = await load()
  for (const [dx, dy, expected] of [
    [0, 0, false], [0, 8, false], [0, 9, true], [0, -50, false],
    [20, 20, false], [-20, 20, false], [20, 30, false],
    [20, 31, true], [-20, 31, true], [100, 20, false],
    [NaN, 20, false], [0, Infinity, false]
  ]) {
    t.is(claimDrag(Object.freeze({ dx, dy })), expected, `dx ${dx}, dy ${dy}`)
  }
})

test('dragVerdict closes past thirty percent of the measured panel height', async (t) => {
  const { dragVerdict } = await load()
  for (const height of [320, 600, 900]) {
    t.is(dragVerdict(Object.freeze({ dy: height * 0.3, vy: 0, height })), 'stay', 'at the threshold')
    t.is(dragVerdict({ dy: height * 0.3 + 1, vy: 0, height }), 'close', 'past the threshold')
    t.is(dragVerdict({ dy: height * 0.1, vy: 0, height }), 'stay', 'short drag')
  }
})

test('a fast downward fling closes but taps and upward flings do not', async (t) => {
  const { dragVerdict } = await load()
  for (const [dy, vy, expected] of [
    [20, 0.8, 'stay'], [20, 0.81, 'close'], [20, -2, 'stay'],
    [8, 2, 'stay'], [0, 2, 'stay'], [-40, 2, 'stay']
  ]) {
    t.is(dragVerdict({ dy, vy, height: 600 }), expected, `dy ${dy}, vy ${vy}`)
  }
})

test('invalid measurements keep the sheet open and the helper stays pure', async (t) => {
  const { dragVerdict } = await load()
  for (const invalid of [{ height: 0 }, { height: -1 }, { height: NaN }, { height: Infinity }, { dy: NaN }, { vy: Infinity }]) {
    t.is(dragVerdict({ dy: 300, vy: 2, height: 600, ...invalid }), 'stay')
  }
  const src = fs.readFileSync(path.join(__dirname, '../src/sheetDrag.js'), 'utf8')
  t.absent(/\b(?:import|require)\s*\(?/.test(src), 'no UI or runtime imports')
  t.absent(src.includes('\u2014'), 'no em dash')
})

async function mount (initial = {}) {
  const helpers = await load()
  const refs = []
  const animations = []
  const writes = []
  const timers = new Map()
  const frames = new Map()
  let nextId = 0
  let cursor = 0
  let effect = null
  let layoutEffect = null
  let cleanup = null
  let dependencies = []
  let closes = 0
  let props = { open: true, dismissable: true, reduceMotion: false, onClose: () => closes++, ...initial }
  class Value {
    constructor (value) { this.value = value }
    setValue (value) { writes.push(value); this.value = value }
    stopAnimation (done) {
      this.pending = null
      if (done) done(this.value)
    }
  }
  const registerEffect = (fn, deps, layout) => {
    if (deps.some((dep, i) => dep !== dependencies[i])) {
      const run = () => {
        if (cleanup) cleanup()
        cleanup = fn()
      }
      if (layout) layoutEffect = run
      else effect = run
      dependencies = deps
    }
  }
  const hook = source.slice(source.indexOf('function usePanelDrag ('), source.indexOf('// `dismissable`'))
  const usePanelDrag = runInNewContext(hook + '\nusePanelDrag', {
    ...helpers,
    useRef: (value) => refs[cursor++] || (refs[cursor - 1] = { current: value }),
    useState: (value) => {
      const state = refs[cursor++] || (refs[cursor - 1] = { value })
      return [state.value, (next) => { state.value = next }]
    },
    useEffect: (fn, deps) => registerEffect(fn, deps, false),
    useLayoutEffect: (fn, deps) => registerEffect(fn, deps, true),
    setTimeout: (fn) => { timers.set(++nextId, fn); return nextId },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => { frames.set(++nextId, fn); return nextId },
    cancelAnimationFrame: (id) => frames.delete(id),
    motion: { fast: 150 },
    Animated: {
      Value,
      timing: (value, config) => ({ start: () => { animations.push(config); value.pending = config } })
    },
    PanResponder: { create: (panHandlers) => ({ panHandlers }) }
  })
  const fixture = {
    animations,
    writes,
    timers,
    frames,
    get closes () { return closes },
    render (next = {}, flushEffects = true) {
      props = { ...props, ...next }
      cursor = 0
      effect = null
      layoutEffect = null
      fixture.drag = usePanelDrag(props)
      if (layoutEffect && flushEffects) layoutEffect()
      fixture.paintedY = fixture.drag.y.value
      if (effect && flushEffects) effect()
      return fixture.drag.panHandlers
    },
    flushTimers () {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn() }
      fixture.render()
    },
    nextFrame () {
      for (const [id, fn] of [...frames]) { frames.delete(id); fn() }
      fixture.render()
    },
    unmount () { if (cleanup) cleanup() }
  }
  fixture.render()
  fixture.drag.handleLayout({ nativeEvent: { layout: { height: 600 } } })
  return fixture
}

// React Native's Modal claims any touch start nobody below it took and then
// never offers the moves to the header (found on the Android emulator).
test('an open dismissable sheet takes a touch that starts on the empty header', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  t.ok(pan.onStartShouldSetPanResponder(), 'the header, not the Modal, holds the touch')
  t.absent(pan.onStartShouldSetPanResponderCapture, 'buttons inside the header still claim their taps first')
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dx: 0, dy: 40 })
  t.is(fixture.drag.y.value, 40, 'the panel follows from the first move')
  pan.onPanResponderRelease(null, { dx: 0, dy: 0, vy: 0 })
  t.is(fixture.closes, 0, 'a tap on the empty header does not close')
  fixture.render({ open: false })
  t.absent(pan.onStartShouldSetPanResponder(), 'a closed sheet takes no touch')
})

// Holding the touch from its start skips claimDrag, so the header checks the
// direction itself before the panel moves or closes.
test('a sideways swipe that starts on the empty header neither moves nor closes the sheet', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  t.ok(pan.onStartShouldSetPanResponder())
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dx: 200, dy: 20 })
  t.is(fixture.drag.y.value, 0, 'a mostly horizontal move does not pull the panel')
  t.ok(pan.onPanResponderTerminationRequest(), 'an unclaimed touch may still be taken over')
  pan.onPanResponderRelease(null, { dx: 200, dy: 20, vy: 1 })
  t.is(fixture.closes, 0, 'a sideways fling does not close')
  t.ok(pan.onStartShouldSetPanResponder())
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dx: 120, dy: 10 })
  t.is(fixture.drag.y.value, 0, 'still sideways')
  pan.onPanResponderMove(null, { dx: 10, dy: 60 })
  t.is(fixture.drag.y.value, 60, 'once the move turns downward the panel follows')
  t.absent(pan.onPanResponderTerminationRequest(), 'a claimed drag keeps the gesture')
  pan.onPanResponderRelease(null, { dx: 10, dy: 60, vy: 1 })
  t.is(fixture.closes, 1, 'a downward fling then closes')
})

test('a non-dismissable sheet cannot claim, move or close through the responder', async (t) => {
  const fixture = await mount({ dismissable: false })
  const pan = fixture.drag.panHandlers
  const gesture = { dx: 0, dy: 300, vy: 2 }
  t.absent(pan.onStartShouldSetPanResponder(), 'a locked sheet takes no touch')
  t.absent(pan.onMoveShouldSetPanResponder(null, gesture))
  t.absent(pan.onMoveShouldSetPanResponderCapture(null, gesture))
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, gesture)
  pan.onPanResponderRelease(null, gesture)
  t.is(fixture.closes, 0)
  t.is(fixture.drag.y.value, 0)
})

test('locking or closing during a drag cancels it, including after reopening', async (t) => {
  for (const change of [{ dismissable: false }, { open: false }]) {
    const fixture = await mount()
    const pan = fixture.drag.panHandlers
    const gesture = { dx: 0, dy: 300, vy: 2 }
    pan.onPanResponderGrant()
    pan.onPanResponderMove(null, gesture)
    t.is(fixture.drag.y.value, 300)
    fixture.render(change)
    t.is(fixture.drag.y.value, change.open === false ? 300 : 0, 'a lock resets the panel; closing preserves its position')
    pan.onPanResponderRelease(null, gesture)
    t.is(fixture.closes, 0, 'release cannot close a locked or hidden sheet')
    fixture.render({ dismissable: true, open: true })
    t.is(fixture.paintedY, 0, 'reopening resets before paint')
    pan.onPanResponderRelease(null, gesture)
    t.is(fixture.closes, 0, 'the old gesture is no longer active')
  }
})

test('release checks the current dismissal lock before effects have run', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 300 })
  fixture.render({ dismissable: false }, false)
  pan.onPanResponderRelease(null, { dy: 300, vy: 2 })
  t.is(fixture.closes, 0, 'a send that just started cannot be dismissed')
  t.is(fixture.drag.y.pending.toValue, 0, 'the panel returns')
})

test('a resized panel uses its new height for dismissal', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  fixture.drag.handleLayout({ nativeEvent: { layout: { height: 300 } } })
  pan.onPanResponderGrant()
  pan.onPanResponderRelease(null, { dy: 91, vy: 0 })
  t.is(fixture.closes, 1, 'threshold follows the actual panel, not the window')
})

test('distance and fling releases call the latest onClose once and return only if refused', async (t) => {
  for (const gesture of [{ dx: 0, dy: 181, vy: 0 }, { dx: 0, dy: 20, vy: 1 }]) {
    const fixture = await mount()
    const pan = fixture.drag.panHandlers
    t.ok(pan.onMoveShouldSetPanResponder(null, gesture))
    t.ok(pan.onMoveShouldSetPanResponderCapture(null, gesture))
    pan.onPanResponderGrant()
    pan.onPanResponderMove(null, gesture)
    let latestCloses = 0
    fixture.render({ onClose: () => latestCloses++ })
    fixture.writes.length = 0
    pan.onPanResponderRelease(null, gesture)
    pan.onPanResponderRelease(null, gesture)
    t.is(latestCloses, 1)
    t.is(fixture.closes, 0, 'no stale callback')
    t.is(fixture.drag.y.value, gesture.dy, 'close preserves the release position')
    t.alike(fixture.writes, [], 'close never sets y to zero')
    t.is(fixture.animations.length, 0, 'no return animation before the next frame')
    fixture.nextFrame()
    t.is(fixture.animations.length, 1, 'a refused close returns on the next frame')
    t.is(fixture.drag.y.pending?.toValue, 0, 'still usable if the caller keeps the sheet open')
  }
})

test('accepted close keeps the release position through exit and resets before reopening paints', async (t) => {
  for (const reduceMotion of [false, true]) {
    const fixture = await mount({ reduceMotion })
    const pan = fixture.drag.panHandlers
    const gesture = { dy: 300, vy: 0 }
    pan.onPanResponderGrant()
    pan.onPanResponderMove(null, gesture)
    fixture.writes.length = 0
    pan.onPanResponderRelease(null, gesture)
    t.is(fixture.closes, 1)
    fixture.render({ open: false })
    fixture.nextFrame()
    t.is(fixture.drag.y.value, 300, 'the exiting panel stays where it was released')
    t.alike(fixture.writes, [], 'closing never resets y')
    t.is(fixture.animations.length, 0, 'no return animation during exit')
    fixture.render({ dismissable: false, reduceMotion: !reduceMotion })
    t.alike(fixture.writes, [], 'preference changes while closed do not reset y')
    fixture.render({ open: true, dismissable: true })
    t.is(fixture.paintedY, 0, 'the first reopened paint starts at rest')
  }
  t.ok(/import \{[^}]*useLayoutEffect[^}]*\} from 'react'/.test(source), 'the reset uses the React layout effect')
})

test('a refused close with reduced motion returns on the next frame without animating', async (t) => {
  const fixture = await mount({ reduceMotion: true })
  const pan = fixture.drag.panHandlers
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 300 })
  pan.onPanResponderRelease(null, { dy: 300, vy: 0 })
  t.is(fixture.closes, 1)
  t.is(fixture.drag.y.value, 300)
  fixture.nextFrame()
  t.is(fixture.drag.y.value, 0)
  t.is(fixture.animations.length, 0)
})

test('header children stop receiving pointers until the tick after release or termination', async (t) => {
  const panel = source.slice(source.indexOf('<Animated.View style={[styles.panel'))
  const header = panel.slice(panel.indexOf('<View style={[styles.dragHeader'), panel.indexOf('<View style={[styles.children'))
  t.ok(/<View pointerEvents=\{drag.dragging \? 'none' : 'auto'\}>\s*\{grabber[^\n]+\n\s*<TopRow[^\n]+\n\s*<\/View>/.test(header), 'a plain wrapper gates both header children without changing row layout')
  for (const end of ['onPanResponderRelease', 'onPanResponderTerminate']) {
    for (const dy of [60, 300]) {
      const fixture = await mount()
      const pan = fixture.drag.panHandlers
      fixture.flushTimers()
      t.absent(fixture.drag.dragging, 'buttons receive ordinary taps')
      pan.onPanResponderGrant()
      pan.onPanResponderMove(null, { dy })
      fixture.render()
      t.is(fixture.drag.dragging, true, 'header children are not pointer targets during drag')
      pan[end](null, { dy, vy: 0 })
      fixture.render()
      t.is(fixture.drag.dragging, true, 'release dispatch still cannot target a header button')
      fixture.flushTimers()
      t.is(fixture.drag.dragging, false, 'header children receive pointers again next tick')
    }
  }
})

test('a new drag or unmount cancels deferred work from the previous drag', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 300 })
  pan.onPanResponderRelease(null, { dy: 300, vy: 0 })
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 40 })
  fixture.flushTimers()
  fixture.nextFrame()
  t.is(fixture.drag.dragging, true, 'the old timer cannot enable buttons in the new drag')
  t.is(fixture.drag.y.value, 340, 'the new drag continues from where the panel was')
  t.is(fixture.animations.length, 0, 'the old frame cannot return the new drag')
  pan.onPanResponderRelease(null, { dy: 300, vy: 0 })
  fixture.unmount()
  t.is(fixture.timers.size, 0, 'no state update after unmount')
  t.is(fixture.frames.size, 0, 'no return animation after unmount')
})

test('a grab during the return continues from the panel position instead of jumping', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 120 })
  pan.onPanResponderRelease(null, { dy: 120, vy: 0 })
  t.is(fixture.drag.y.pending.toValue, 0, 'a short drag starts its return')
  fixture.drag.y.value = 90
  pan.onPanResponderGrant()
  t.is(fixture.drag.y.pending, null, 'the grab stops the return')
  pan.onPanResponderMove(null, { dy: 10 })
  t.is(fixture.drag.y.value, 100, 'the panel moves from 90, not from the finger origin')
  pan.onPanResponderMove(null, { dy: -200 })
  t.is(fixture.drag.y.value, 0, 'still cannot pull above the resting position')
  pan.onPanResponderRelease(null, { dy: 100, vy: 0 })
  t.is(fixture.closes, 1, 'the verdict counts the whole travel: 90 + 100 is past 30% of 600')
})

test('an active drag refuses termination requests, so a web text selection cannot end it', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  t.ok(pan.onPanResponderTerminationRequest(), 'idle: another responder may take over')
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 60 })
  t.absent(pan.onPanResponderTerminationRequest(), 'dragging: the header keeps the gesture')
  pan.onPanResponderRelease(null, { dy: 60, vy: 0 })
  t.ok(pan.onPanResponderTerminationRequest(), 'released: termination is allowed again')
  t.ok(source.includes("dragHeader: Platform.select({ web: { touchAction: 'pan-x', userSelect: 'none' }, default: {} })"), 'the web header neither scrolls the page nor selects text')
})

test('a short or interrupted drag returns, reduced motion never starts an animation', async (t) => {
  for (const reduceMotion of [false, true]) {
    for (const end of ['onPanResponderRelease', 'onPanResponderTerminate']) {
      const fixture = await mount({ reduceMotion })
      const pan = fixture.drag.panHandlers
      pan.onPanResponderGrant()
      pan.onPanResponderMove(null, { dy: -20 })
      t.is(fixture.drag.y.value, 0, 'cannot pull above the resting position')
      pan.onPanResponderMove(null, { dy: 60 })
      t.is(fixture.drag.y.value, 60)
      pan[end](null, { dy: 60, vy: 0 })
      t.is(fixture.closes, 0)
      t.is(fixture.animations.length, reduceMotion ? 0 : 1)
      if (reduceMotion) t.is(fixture.drag.y.value, 0)
      else t.is(fixture.drag.y.pending.toValue, 0)
    }
  }
})

test('motion preference changes and unmount stop a pending return animation', async (t) => {
  const fixture = await mount()
  const pan = fixture.drag.panHandlers
  pan.onPanResponderGrant()
  pan.onPanResponderMove(null, { dy: 60 })
  pan.onPanResponderRelease(null, { dy: 60, vy: 0 })
  t.ok(fixture.drag.y.pending)
  fixture.render({ reduceMotion: true })
  t.is(fixture.drag.y.pending, null)
  t.is(fixture.drag.y.value, 0)
  fixture.render({ reduceMotion: false })
  pan.onPanResponderGrant()
  pan.onPanResponderTerminate()
  t.ok(fixture.drag.y.pending)
  fixture.unmount()
  t.is(fixture.drag.y.pending, null)
  pan.onPanResponderRelease(null, { dy: 300, vy: 2 })
  t.is(fixture.closes, 0)
})
