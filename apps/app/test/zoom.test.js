'use strict'

// Zoom math (src/zoom.js), a pure ES module loaded through import(). The
// responder rules of src/ui/ZoomView.js are pinned from its source.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/zoom.js')

test('zoom.js imports nothing', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/zoom.js'), 'utf8')
  t.absent(/^\s*import\s/m.test(src), 'no import statement')
  t.absent(src.includes('require('), 'no require')
})

test('clampScale keeps the scale between 1 and 4', async (t) => {
  const { clampScale, MIN_SCALE, MAX_SCALE } = await load()
  t.is(MIN_SCALE, 1)
  t.is(MAX_SCALE, 4)
  t.is(clampScale(1), 1)
  t.is(clampScale(2.2), 2.2)
  t.is(clampScale(4), 4)
  t.is(clampScale(0.4), 1, 'below 1 clamps up')
  t.is(clampScale(-3), 1)
  t.is(clampScale(9), 4, 'above 4 clamps down')
  for (const bad of [NaN, Infinity, -Infinity, '2', null, undefined, {}]) t.is(clampScale(bad), 1)
})

test('isZoomed ignores a hair above 1', async (t) => {
  const { isZoomed, ZOOM_EPSILON } = await load()
  t.is(isZoomed(1), false)
  t.is(isZoomed(1 + ZOOM_EPSILON / 2), false)
  t.is(isZoomed(1.2), true)
  t.is(isZoomed(4), true)
  t.is(isZoomed(NaN), false)
  t.is(isZoomed(undefined), false)
})

test('touchDistance and touchFocal', async (t) => {
  const { touchDistance, touchFocal } = await load()
  t.is(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
  t.is(touchDistance({ x: 0, y: 0 }, null), 0)
  t.is(touchDistance({ x: NaN, y: 0 }, { x: 1, y: 1 }), 0)
  t.alike(touchFocal({ x: 10, y: 20 }, { x: 30, y: 60 }), { x: 20, y: 40 })
  t.is(touchFocal({ x: 1, y: 1 }, undefined), null)
})

test('pinchScale follows the finger distance from the start scale', async (t) => {
  const { pinchScale } = await load()
  t.is(pinchScale(100, 200, 1), 2, 'fingers twice as far apart')
  t.is(pinchScale(100, 150, 2), 3, 'a second pinch continues from 2')
  t.is(pinchScale(200, 100, 3), 1.5, 'pinching in')
  t.is(pinchScale(100, 100, 2.5), 2.5, 'no change in distance')
  t.is(pinchScale(100, 50, 1), 1, 'never below 1')
  t.is(pinchScale(100, 900, 1), 4, 'never above 4')
  t.is(pinchScale(100, 300, 3), 4)
  t.is(pinchScale(0, 200, 2), 2, 'a zero start distance keeps the start scale')
  t.is(pinchScale(-5, 200, 2), 2)
  t.is(pinchScale(NaN, 200, 2), 2)
  t.is(pinchScale(100, NaN, 2), 2)
  t.is(pinchScale(100, 200, NaN), 2, 'a bad start scale is read as 1')
  t.is(pinchScale(100, 200, 9), 4, 'a start scale past 4 is clamped first')
})

test('fitSize contains the photo in the frame', async (t) => {
  const { fitSize } = await load()
  const frame = { width: 400, height: 800 }
  t.alike(fitSize(frame, 2), { width: 400, height: 200 }, 'landscape fills the width')
  t.alike(fitSize(frame, 0.25), { width: 200, height: 800 }, 'tall fills the height')
  t.alike(fitSize(frame, 0.5), { width: 400, height: 800 }, 'same ratio fills both')
  for (const bad of [0, -1, NaN, Infinity, undefined, '2']) t.alike(fitSize(frame, bad), frame, 'no ratio fills the frame')
  t.alike(fitSize({ width: 0, height: 100 }, 1), { width: 0, height: 100 })
  t.alike(fitSize(null, 1), { width: 0, height: 0 })
})

test('clampPan keeps the zoomed photo covering its frame', async (t) => {
  const { clampPan, panBounds, fitSize } = await load()
  const frame = { width: 400, height: 800 }
  const content = fitSize(frame, 2)
  t.alike(panBounds({ scale: 1, frame, content }), { x: 0, y: 0 }, 'nothing to pan at 1')
  t.alike(clampPan({ x: 50, y: -70 }, { scale: 1, frame, content }), { x: 0, y: 0 }, 'pan is centred at 1')
  // 400 x 200 at 2x is 800 x 400: 200 pt of slack each side, and the height
  // still fits inside 800, so it stays centred vertically.
  t.alike(panBounds({ scale: 2, frame, content }), { x: 200, y: 0 })
  t.alike(clampPan({ x: 150, y: 90 }, { scale: 2, frame, content }), { x: 150, y: 0 })
  t.alike(clampPan({ x: 999, y: 0 }, { scale: 2, frame, content }), { x: 200, y: 0 }, 'the left edge never comes inside')
  t.alike(clampPan({ x: -999, y: 0 }, { scale: 2, frame, content }), { x: -200, y: 0 }, 'nor the right one')
  // At 4x: 1600 x 800, exactly the frame height, still no vertical slack.
  t.alike(clampPan({ x: 0, y: 500 }, { scale: 4, frame, content }), { x: 0, y: 0 })
  const square = { width: 400, height: 400 }
  t.alike(clampPan({ x: -999, y: 999 }, { scale: 4, frame: square, content: square }), { x: -600, y: 600 })
  t.alike(clampPan({ x: 10, y: 10 }, { scale: 9, frame: square, content: square }), { x: 10, y: 10 }, 'scale past 4 reads as 4')
  const out = clampPan({ x: -0, y: NaN }, { scale: 2, frame: square, content: square })
  t.ok(Object.is(out.x, 0) && Object.is(out.y, 0), 'no -0 or NaN')
  t.alike(clampPan(null, { scale: 2, frame: square, content: square }), { x: 0, y: 0 })
  t.alike(panBounds({ scale: 2, frame: square }), { x: 200, y: 200 }, 'no content box: the frame')
})

test('focalPan keeps the point under the fingers in place', async (t) => {
  const { focalPan } = await load()
  t.alike(focalPan({ startPan: { x: 0, y: 0 }, startScale: 1, startFocal: { x: 0, y: 0 }, focal: { x: 0, y: 0 }, scale: 2 }), { x: 0, y: 0 }, 'centre pinch keeps the centre')
  // Tap 100 pt right of centre at 1x, zoom to 2.5x: that point is drawn at
  // pan + 2.5 * 100, so pan is -150 to keep it at 100.
  t.alike(focalPan({ startPan: { x: 0, y: 0 }, startScale: 1, startFocal: { x: 100, y: -40 }, focal: { x: 100, y: -40 }, scale: 2.5 }), { x: -150, y: 60 })
  t.alike(focalPan({ startPan: { x: 0, y: 0 }, startScale: 2, startFocal: { x: 0, y: 0 }, focal: { x: 30, y: -20 }, scale: 2 }), { x: 30, y: -20 }, 'two fingers moving together pan')
  const start = { startPan: { x: -40, y: 10 }, startScale: 2, startFocal: { x: 60, y: 20 } }
  const pan = focalPan({ ...start, focal: { x: 60, y: 20 }, scale: 3 })
  const photoPoint = { x: (60 - -40) / 2, y: (20 - 10) / 2 }
  t.alike({ x: pan.x + 3 * photoPoint.x, y: pan.y + 3 * photoPoint.y }, { x: 60, y: 20 }, 'the photo point stays under the focal')
  t.alike(focalPan({ startPan: null, startScale: NaN, startFocal: null, focal: null, scale: 2 }), { x: 0, y: 0 })
})

test('doubleTapTarget toggles between 1 and 2.5', async (t) => {
  const { doubleTapTarget, DOUBLE_TAP_SCALE } = await load()
  t.is(DOUBLE_TAP_SCALE, 2.5)
  t.is(doubleTapTarget(1), 2.5, 'from 1 zooms in')
  t.is(doubleTapTarget(1.001), 2.5, 'a hair above 1 is still 1')
  t.is(doubleTapTarget(2.5), 1, 'from 2.5 zooms out')
  t.is(doubleTapTarget(1.6), 1, 'any zoom zooms out')
  t.is(doubleTapTarget(4), 1)
  t.is(doubleTapTarget(NaN), 2.5)
})

test('nearTap: the second tap lands near the first', async (t) => {
  const { nearTap, DOUBLE_TAP_SLOP } = await load()
  t.is(nearTap({ x: 10, y: 10 }, { x: 10, y: 10 }), true)
  t.is(nearTap({ x: 0, y: 0 }, { x: DOUBLE_TAP_SLOP, y: 0 }), true, 'on the edge')
  t.is(nearTap({ x: 0, y: 0 }, { x: DOUBLE_TAP_SLOP + 1, y: 0 }), false)
  t.is(nearTap(null, { x: 0, y: 0 }), false)
  t.is(nearTap({ x: NaN, y: 0 }, { x: 0, y: 0 }), false)
})

test('dismissVerdict closes past 120 pt or on a fast fling, only at scale 1', async (t) => {
  const { dismissVerdict, DISMISS_DISTANCE, DISMISS_FLING, DISMISS_FLING_MIN } = await load()
  t.is(DISMISS_DISTANCE, 120)
  t.is(dismissVerdict({ dy: 119, vy: 0, scale: 1 }), 'stay', 'just short of 120')
  t.is(dismissVerdict({ dy: 120, vy: 0, scale: 1 }), 'close', 'on 120')
  t.is(dismissVerdict({ dy: 300, vy: 0, scale: 1 }), 'close')
  t.is(dismissVerdict({ dy: 40, vy: DISMISS_FLING, scale: 1 }), 'close', 'a fast fling')
  t.is(dismissVerdict({ dy: 40, vy: DISMISS_FLING - 0.1, scale: 1 }), 'stay', 'a slow drag')
  t.is(dismissVerdict({ dy: DISMISS_FLING_MIN - 1, vy: 3, scale: 1 }), 'stay', 'a flick inside a tap')
  t.is(dismissVerdict({ dy: -200, vy: -3, scale: 1 }), 'stay', 'upward never closes')
  t.is(dismissVerdict({ dy: 300, vy: 3, scale: 2 }), 'stay', 'never while zoomed')
  t.is(dismissVerdict({ dy: 300, vy: 3, scale: 1.5 }), 'stay')
  t.is(dismissVerdict({ dy: NaN, vy: 3, scale: 1 }), 'stay')
  t.is(dismissVerdict({ dy: 200, vy: NaN, scale: undefined }), 'close', 'an unknown scale is 1')
  t.is(dismissVerdict(), 'stay')
})

test('panClaim leaves sideways moves at scale 1 to the pager', async (t) => {
  const { panClaim, PAN_SLOP } = await load()
  t.is(panClaim({ dx: 80, dy: 5, scale: 1 }), false, 'horizontal at 1 pages')
  t.is(panClaim({ dx: -80, dy: 10, scale: 1 }), false)
  t.is(panClaim({ dx: 40, dy: 40, scale: 1 }), false, 'a diagonal pages')
  t.is(panClaim({ dx: 10, dy: 60, scale: 1 }), true, 'mostly downward drags to close')
  t.is(panClaim({ dx: 0, dy: PAN_SLOP, scale: 1 }), false, 'inside the slop')
  t.is(panClaim({ dx: 0, dy: PAN_SLOP + 1, scale: 1 }), true)
  t.is(panClaim({ dx: 0, dy: -60, scale: 1 }), false, 'upward at 1 is not ours')
  t.is(panClaim({ dx: 80, dy: 0, scale: 2 }), true, 'always while zoomed, sideways')
  t.is(panClaim({ dx: 0, dy: -60, scale: 2 }), true, 'always while zoomed, upward')
  t.is(panClaim({ dx: 0, dy: 0, scale: 3 }), true)
  t.is(panClaim({ dx: 80, dy: 0, scale: 1, touches: 2 }), true, 'two fingers always')
  t.is(panClaim({ dx: NaN, dy: 60, scale: 1 }), false)
  t.is(panClaim(), false)
})

test('gestureMode: a move that won the touch is already a drag to close', async (t) => {
  const { gestureMode } = await load()
  t.is(gestureMode({ touches: 1, scale: 1, fresh: true, moved: true, canDismiss: true }), 'dismiss', 'granted by a downward move')
  t.is(gestureMode({ touches: 1, scale: 1, fresh: true, moved: true, canDismiss: false }), 'ignore', 'no drag to close without onDismiss')
  t.is(gestureMode({ touches: 1, scale: 1, fresh: true }), 'tap')
  t.is(gestureMode({ touches: 1, scale: 1, fresh: false }), 'ignore', 'the finger left over from a pinch')
  t.is(gestureMode({ touches: 1, scale: 2, fresh: true, moved: true, canDismiss: true }), 'pan', 'a zoomed photo pans, never closes')
  t.is(gestureMode({ touches: 2, scale: 1, moved: true, canDismiss: true }), 'pinch')
  t.is(gestureMode({ touches: 3, scale: 2 }), 'pinch')
  t.is(gestureMode({ touches: 0, scale: 1, fresh: true }), 'none')
  t.is(gestureMode({ touches: NaN }), 'none')
  t.is(gestureMode(), 'none')
})

// ZoomView is React Native, so its wiring is read from disk.
const VIEW = path.join(__dirname, '../src/ui/ZoomView.js')
const viewSource = () => fs.readFileSync(VIEW, 'utf8')

test('ZoomView claims two touches and refuses sideways moves at scale 1', (t) => {
  const src = viewSource()
  t.ok(src.includes('return !latest.current.disabled && (touchCount(event) >= 2 || isZoomed(view.current.scale))'), 'a second finger or a touch on a zoomed photo is claimed from any child')
  t.ok(src.includes('onMoveShouldSetPanResponderCapture: claimMove'), 'moves are negotiated by claimMove')
  t.ok(src.includes('const won = panClaim({ dx: gestureState.dx, dy: gestureState.dy, scale: view.current.scale, touches })'), 'claimMove asks panClaim')
  t.ok(src.includes("if (!isZoomed(view.current.scale) && touches < 2 && typeof latest.current.onDismiss !== 'function') return false"), 'without onDismiss nothing at scale 1 is claimed on a move')
  t.ok(src.includes("gst.mode = latest.current.onDismiss && panClaim({ dx, dy, scale: view.current.scale }) ? 'dismiss' : 'ignore'"), 'a sideways move it already holds is ignored, not panned')
})

test('ZoomView never blocks the native pager at scale 1 and holds a pinch or zoomed pan', (t) => {
  const src = viewSource()
  t.ok(src.includes('const active = () => isZoomed(view.current.scale) || ACTIVE.has(gesture.current.mode)'), 'active is a zoomed photo, a pinch, a zoomed pan or a drag to close')
  t.ok(src.includes("const ACTIVE = new Set(['pinch', 'pan', 'dismiss'])"), 'a drag to close refuses to let go too')
  t.ok(src.includes('onPanResponderTerminationRequest: () => !active()'), 'termination refused while active')
  t.ok(src.includes('onShouldBlockNativeResponder: () => active()'), 'Android native scroll is blocked only while active')
})

// Found on the Android emulator: an outer view that held the first finger was
// granted with "do not block", Android never asks again, and the page's own
// claim took the second finger, so a pinch did nothing.
test('ZoomView takes a pinch or a drag to close as a new grant', (t) => {
  const src = viewSource()
  t.absent(src.includes('onStartShouldSetPanResponder:'), 'the outer view never holds a lone finger at scale 1')
  t.ok(src.includes('onStartShouldSetResponder: (event) => !latest.current.disabled && touchCount(event) === 1'), 'the inner view takes one finger for taps')
  t.ok(src.includes('onResponderTerminationRequest: () => true'), 'the inner view always lets go')
  const taps = src.slice(src.indexOf('const tapHandlers = {'), src.indexOf('if (handlers.current === null)'))
  t.absent(/return true|onShouldBlock/.test(taps.replace('onResponderTerminationRequest: () => true', '')), 'the inner view never blocks the native pager')
  t.ok(/<Animated\.View [^>]*\{\.\.\.tapHandlers\}>/.test(src), 'the inner view is the transformed photo')
  t.ok(src.includes('moveClaim.current = won && touches === 1 ? { dx: gestureState.dx, dy: gestureState.dy } : null'), 'a one-finger move claim is kept for its grant')
  t.ok(/onStartShouldSetPanResponderCapture: \(event\) => \{\s+moveClaim\.current = null/.test(src), 'a new touch drops a stale move claim')
  t.ok(/const claim = moveClaim\.current\s+moveClaim\.current = null\s+freeze\(\)\s+measure\(\)\s+begin\(event, true, claim\)/.test(src), 'the grant starts from the move claim')
  t.ok(src.includes("const mode = gestureMode({ touches: points.length, scale: start.scale, fresh, moved: !!claim, canDismiss: typeof latest.current.onDismiss === 'function' })"), 'begin asks gestureMode')
  t.ok(src.includes('tap: fresh && !claim'), 'a drag to close is never a tap')
  // Without a frame origin the first double tap zoomed around the centre.
  t.ok(/onResponderGrant: \(event\) => \{\s+measure\(\)\s+const p = touchPoints\(event\)\[0\]/.test(taps), 'the tap grant measures the frame, so a double tap zooms at the tapped point')
})

test('ZoomView sets values without animation under reduce motion', (t) => {
  const src = viewSource()
  t.ok(src.includes("import { useReduceMotion } from './StackLayer'"))
  t.ok(src.includes('if (!animate || latest.current.reduce) {'), 'reduce motion jumps')
  t.ok(/latest\.current = \{[^}]*reduce[^}]*\}/.test(src), 'the reduce flag reaches the handlers')
  t.absent(src.includes('useNativeDriver: true'), 'the native driver is never forced')
})

test('ZoomView locks the web touch action only while zoomed', (t) => {
  const src = viewSource()
  t.ok(src.includes('style={[styles.root, style, zoomed ? styles.locked : styles.free]}'))
  t.ok(src.includes("locked: { touchAction: 'none' }"))
  t.ok(src.includes("free: { touchAction: 'pan-x' }"), 'at rest the browser keeps sideways paging only')
  for (const api of ['window.', 'document.', 'navigator.', 'Platform.OS']) t.absent(src.includes(api), 'no ' + api)
})

test('ZoomView reports each change of zoomed state once', (t) => {
  const src = viewSource()
  t.ok(src.includes('if (zoomedRef.current === next) return'), 'no repeat for the same state')
  t.ok(/zoomedRef\.current = next\s+setZoomed\(next\)\s+const cb = latest\.current\.onZoomChange\s+if \(typeof cb === 'function'\) cb\(next\)/.test(src), 'each change calls onZoomChange')
  t.ok(src.includes('report(isZoomed(view.current.scale) || HOLD.has(gesture.current.mode))'), 'a pinch or a drag to close holds the pager like a zoomed photo')
  t.ok(src.includes("const HOLD = new Set(['pinch', 'dismiss'])"), 'the pager stops under two fingers and during a drag to close')
  t.ok(/\? 'dismiss' : 'ignore'\n\s*if \(gst\.mode === 'dismiss'\) sync\(\)/.test(src), 'the pager stops as soon as a drag to close starts')
})

test('ZoomView resets to scale 1 when resetKey or disabled changes', (t) => {
  const src = viewSource()
  t.ok(/useEffect\(\(\) => \{\s+gesture\.current = IDLE\s+lastTap\.current = null\s+apply\(\{ scale: 1, x: 0, y: 0 \}, false\)\s+report\(false\)\s+\}, \[resetKey, disabled\]\)/.test(src))
})

test('ZoomView double tap toggles around the tap and closes on the verdict', (t) => {
  const src = viewSource()
  t.ok(src.includes("tapKind(prev.at, tap.at) === 'double' && nearTap(prev, tap)"), 'two taps in time and place')
  t.ok(src.includes('const target = doubleTapTarget(view.current.scale)'))
  t.ok(src.includes("dismissVerdict({ dy: gst.dy, vy: gestureState ? gestureState.vy : 0, scale: view.current.scale }) === 'close'"))
  const finish = src.slice(src.indexOf('const finish = '), src.indexOf('const active = '))
  t.ok(/onTap\(gst\.startTouch\)\n(\s*\/\/[^\n]*\n)*\s*settle\(\)\n\s*sync\(\)/.test(finish), 'a tap that froze an animation still settles the photo back in frame')
})
