// Pinch, double tap and drag to close for one photo of a viewer; the math is
// in ../zoom.js. It sits inside a page of a native paging ScrollView, so at
// scale 1 a one-finger sideways move stays the pager's: an inner view takes
// that touch only to see taps, never blocks the native scroll from stealing
// it, and gives it up whenever asked. The outer view claims a second finger,
// any touch on a zoomed photo and a clearly downward drag (only with
// onDismiss), each as a new grant that already knows its mode. Android reads
// the block flag only at a grant: an outer view that held the first finger
// would have said no then, and the pager or the page could still take a
// pinch from it. None of these lets go while it runs, and the parent also
// turns paging off from onZoomChange(true). A single tap does nothing here;
// a child's own press (a failed photo's retry) still gets it.

import { useEffect, useRef, useState } from 'react'
import { Animated, PanResponder, StyleSheet, View } from 'react-native'
import { tapKind } from '../doubleTap'
import { TAP_SLOP, clampPan, clampScale, dismissVerdict, doubleTapTarget, fitSize, focalPan, gestureMode, isZoomed, nearTap, panClaim, pinchScale, touchDistance, touchFocal } from '../zoom'
import { useReduceMotion } from './StackLayer'
import { motion } from './theme'

const IDLE = { mode: 'none' }
const ACTIVE = new Set(['pinch', 'pan', 'dismiss'])
// While these run the pager holds still, even at scale 1.
const HOLD = new Set(['pinch', 'dismiss'])

function touchPoints (event) {
  const list = event && event.nativeEvent && event.nativeEvent.touches
  if (!list || typeof list.length !== 'number') return []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const touch = list[i]
    if (touch && Number.isFinite(touch.pageX) && Number.isFinite(touch.pageY)) out.push({ x: touch.pageX, y: touch.pageY })
  }
  return out
}

const touchCount = (event) => touchPoints(event).length

export function ZoomView ({ children, style, ratio, resetKey, disabled = false, onZoomChange, onDismiss }) {
  const reduce = useReduceMotion()
  const scale = useRef(new Animated.Value(1)).current
  const x = useRef(new Animated.Value(0)).current
  const y = useRef(new Animated.Value(0)).current
  const [zoomed, setZoomed] = useState(false)
  const latest = useRef(null)
  latest.current = { disabled, onZoomChange, onDismiss, reduce, ratio }
  const rootRef = useRef(null)
  const view = useRef({ scale: 1, x: 0, y: 0 })
  const frame = useRef({ width: 0, height: 0 })
  // The frame's top-left on the page, read at each grant: a page of a strip
  // moves on the page as the strip scrolls.
  const origin = useRef(null)
  const gesture = useRef(IDLE)
  // The distance a downward move had travelled when it won the touch, for
  // the grant that follows.
  const moveClaim = useRef(null)
  // A one-finger touch at scale 1, held by the inner view.
  const tapStart = useRef(null)
  const lastTap = useRef(null)
  const zoomedRef = useRef(false)
  const handlers = useRef(null)

  const report = (next) => {
    if (zoomedRef.current === next) return
    zoomedRef.current = next
    setZoomed(next)
    const cb = latest.current.onZoomChange
    if (typeof cb === 'function') cb(next)
  }

  const box = (s) => ({ scale: s, frame: frame.current, content: fitSize(frame.current, latest.current.ratio) })

  // Gesture moves write these values from JS, so animations stay on JS too: a
  // native copy would disagree with the JS one when a touch stops it midway.
  const apply = (next, animate) => {
    view.current = next
    scale.stopAnimation()
    x.stopAnimation()
    y.stopAnimation()
    if (!animate || latest.current.reduce) {
      scale.setValue(next.scale)
      x.setValue(next.x)
      y.setValue(next.y)
      return
    }
    const timing = (value, toValue) => Animated.timing(value, { toValue, duration: motion.fast, useNativeDriver: false })
    Animated.parallel([timing(scale, next.scale), timing(x, next.x), timing(y, next.y)]).start()
  }

  // A touch that lands mid-animation continues from what is on screen.
  const freeze = () => {
    const now = { ...view.current }
    scale.stopAnimation((v) => { if (Number.isFinite(v)) now.scale = v })
    x.stopAnimation((v) => { if (Number.isFinite(v)) now.x = v })
    y.stopAnimation((v) => { if (Number.isFinite(v)) now.y = v })
    view.current = now
  }

  const sync = () => report(isZoomed(view.current.scale) || HOLD.has(gesture.current.mode))

  const settle = () => {
    const s = isZoomed(view.current.scale) ? clampScale(view.current.scale) : 1
    const pan = clampPan(view.current, box(s))
    const cur = view.current
    if (cur.scale !== s || cur.x !== pan.x || cur.y !== pan.y) apply({ scale: s, ...pan }, true)
  }

  // From the centre of the frame. Before the first measure the start focal
  // stands in for the centre, so a pinch still scales in place.
  const fromCentre = (point, fallback) => {
    const o = origin.current
    const f = frame.current
    if (!o) return { x: point.x - fallback.x, y: point.y - fallback.y }
    return { x: point.x - (o.x + f.width / 2), y: point.y - (o.y + f.height / 2) }
  }

  const measure = () => {
    const node = rootRef.current
    if (!node || typeof node.measure !== 'function') return
    try {
      node.measure((fx, fy, width, height, pageX, pageY) => {
        if (Number.isFinite(pageX) && Number.isFinite(pageY)) origin.current = { x: pageX, y: pageY }
      })
    } catch {}
  }

  // Called at the grant and whenever a finger lands or lifts, so each finger
  // count starts from where the photo is. Only a fresh one-finger touch can
  // still be a tap; one granted by a downward move (claim) starts where that
  // finger first landed.
  const begin = (event, fresh, claim) => {
    const points = touchPoints(event)
    const start = { scale: view.current.scale, x: view.current.x, y: view.current.y }
    const mode = gestureMode({ touches: points.length, scale: start.scale, fresh, moved: !!claim, canDismiss: typeof latest.current.onDismiss === 'function' })
    if (mode === 'pinch') {
      const focal = touchFocal(points[0], points[1])
      gesture.current = { mode, touches: points.length, startDistance: touchDistance(points[0], points[1]), startFocal: focal, start, tap: false }
    } else if (points.length === 1) {
      const from = claim ? { x: points[0].x - claim.dx, y: points[0].y - claim.dy } : points[0]
      gesture.current = { mode, touches: 1, startTouch: from, start, dy: claim ? claim.dy : 0, moved: claim ? Math.hypot(claim.dx, claim.dy) : 0, tap: fresh && !claim }
    } else {
      gesture.current = IDLE
    }
    sync()
  }

  const toggleAt = (point) => {
    const target = doubleTapTarget(view.current.scale)
    if (target === 1) {
      apply({ scale: 1, x: 0, y: 0 }, true)
    } else {
      const focal = fromCentre(point, point)
      const pan = focalPan({ startPan: view.current, startScale: view.current.scale, startFocal: focal, focal, scale: target })
      apply({ scale: target, ...clampPan(pan, box(target)) }, true)
    }
    sync()
  }

  const onTap = (point) => {
    const tap = { at: Date.now(), x: point.x, y: point.y }
    const prev = lastTap.current
    if (prev && tapKind(prev.at, tap.at) === 'double' && nearTap(prev, tap)) {
      lastTap.current = null
      toggleAt(point)
      return
    }
    lastTap.current = tap
  }

  const finish = (gestureState, terminated) => {
    const gst = gesture.current
    gesture.current = IDLE
    if (gst.mode === 'dismiss') {
      const dismiss = latest.current.onDismiss
      if (!terminated && typeof dismiss === 'function' && dismissVerdict({ dy: gst.dy, vy: gestureState ? gestureState.vy : 0, scale: view.current.scale }) === 'close') {
        dismiss()
        return
      }
      apply({ scale: 1, x: 0, y: 0 }, true)
      sync()
      return
    }
    if (!terminated && gst.tap && gst.moved <= TAP_SLOP) onTap(gst.startTouch)
    // Also after a tap: one that landed mid-animation froze the photo where it
    // was. After a double tap the target is already in view.current, so this
    // does nothing.
    settle()
    sync()
  }

  const active = () => isZoomed(view.current.scale) || ACTIVE.has(gesture.current.mode)

  const claimMove = (event, gestureState) => {
    if (latest.current.disabled) return false
    const touches = touchCount(event)
    if (!isZoomed(view.current.scale) && touches < 2 && typeof latest.current.onDismiss !== 'function') return false
    const won = panClaim({ dx: gestureState.dx, dy: gestureState.dy, scale: view.current.scale, touches })
    moveClaim.current = won && touches === 1 ? { dx: gestureState.dx, dy: gestureState.dy } : null
    return won
  }

  // The inner view's one-finger touch at scale 1: a plain responder that
  // never blocks the native pager and always lets go, so a sideways swipe
  // still pages and a downward drag or a second finger goes to the outer view.
  // It measures too: without a frame origin a double tap would zoom around
  // the centre instead of the tapped point.
  const tapHandlers = {
    onStartShouldSetResponder: (event) => !latest.current.disabled && touchCount(event) === 1,
    onResponderGrant: (event) => {
      measure()
      const p = touchPoints(event)[0]
      tapStart.current = p ? { x: p.x, y: p.y, moved: 0 } : null
    },
    onResponderMove: (event) => {
      const t = tapStart.current
      const p = touchPoints(event)[0]
      if (t && p) t.moved = Math.max(t.moved, Math.hypot(p.x - t.x, p.y - t.y))
    },
    onResponderRelease: () => {
      const t = tapStart.current
      tapStart.current = null
      if (t && t.moved <= TAP_SLOP) onTap(t)
    },
    onResponderTerminate: () => { tapStart.current = null },
    onResponderTerminationRequest: () => true
  }

  const move = (event) => {
    const points = touchPoints(event)
    const gst = gesture.current
    if (gst.mode === 'none' || latest.current.disabled) return
    if (points.length !== gst.touches) return begin(event, false)
    if (gst.mode === 'pinch') {
      const s = pinchScale(gst.startDistance, touchDistance(points[0], points[1]), gst.start.scale)
      const focal = touchFocal(points[0], points[1])
      const pan = focalPan({
        startPan: gst.start,
        startScale: gst.start.scale,
        startFocal: fromCentre(gst.startFocal, gst.startFocal),
        focal: fromCentre(focal, gst.startFocal),
        scale: s
      })
      apply({ scale: s, ...clampPan(pan, box(s)) }, false)
      return
    }
    const dx = points[0].x - gst.startTouch.x
    const dy = points[0].y - gst.startTouch.y
    gst.moved = Math.max(gst.moved, Math.hypot(dx, dy))
    gst.dy = dy
    if (gst.mode === 'pan') {
      const s = view.current.scale
      apply({ scale: s, ...clampPan({ x: gst.start.x + dx, y: gst.start.y + dy }, box(s)) }, false)
      return
    }
    if (gst.mode === 'tap') {
      if (gst.moved <= TAP_SLOP) return
      gst.mode = latest.current.onDismiss && panClaim({ dx, dy, scale: view.current.scale }) ? 'dismiss' : 'ignore'
      if (gst.mode === 'dismiss') sync()
    }
    if (gst.mode === 'dismiss') apply({ scale: 1, x: 0, y: Math.max(0, dy) }, false)
  }

  if (handlers.current === null) {
    handlers.current = PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => {
        moveClaim.current = null
        return !latest.current.disabled && (touchCount(event) >= 2 || isZoomed(view.current.scale))
      },
      onMoveShouldSetPanResponderCapture: claimMove,
      onPanResponderGrant: (event) => {
        const claim = moveClaim.current
        moveClaim.current = null
        freeze()
        measure()
        begin(event, true, claim)
      },
      onPanResponderStart: (event) => { if (touchCount(event) !== gesture.current.touches) begin(event, false) },
      onPanResponderEnd: (event) => { if (touchCount(event) > 0) begin(event, false) },
      onPanResponderMove: move,
      onPanResponderRelease: (event, gestureState) => finish(gestureState, false),
      onPanResponderTerminate: () => finish(null, true),
      onPanResponderTerminationRequest: () => !active(),
      onShouldBlockNativeResponder: () => active()
    }).panHandlers
  }

  useEffect(() => {
    gesture.current = IDLE
    lastTap.current = null
    apply({ scale: 1, x: 0, y: 0 }, false)
    report(false)
  }, [resetKey, disabled])

  // A page unmounted while zoomed must not leave the pager locked.
  useEffect(() => () => {
    scale.stopAnimation()
    x.stopAnimation()
    y.stopAnimation()
    if (!zoomedRef.current) return
    zoomedRef.current = false
    const notify = latest.current.onZoomChange
    if (typeof notify === 'function') notify(false)
  }, [scale, x, y])

  const onLayout = (event) => {
    const layout = event && event.nativeEvent && event.nativeEvent.layout
    if (!layout || !Number.isFinite(layout.width) || !Number.isFinite(layout.height)) return
    frame.current = { width: layout.width, height: layout.height }
    if (gesture.current.mode === 'dismiss') return
    const s = view.current.scale
    const pan = clampPan(view.current, box(s))
    if (pan.x !== view.current.x || pan.y !== view.current.y) apply({ scale: s, ...pan }, false)
  }

  // Only the web knows touch-action; native ignores the key. While zoomed the
  // browser must not scroll or zoom the page under the fingers; at rest it
  // keeps the sideways scroll that pages, and leaves pinch and the downward
  // drag to this view.
  return (
    <View
      ref={rootRef}
      collapsable={false}
      onLayout={onLayout}
      style={[styles.root, style, zoomed ? styles.locked : styles.free]}
      {...handlers.current}
    >
      <Animated.View style={[styles.fill, { transform: [{ translateX: x }, { translateY: y }, { scale }] }]} {...tapHandlers}>
        {children}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFillObject },
  locked: { touchAction: 'none' },
  free: { touchAction: 'pan-x' }
})
