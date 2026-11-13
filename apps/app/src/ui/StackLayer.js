// One pushed screen of the stack layer, sliding in on a push and out on a
// pop, plus the hook that tells App.js which screen is leaving. The stack in
// App.js changes at once (history and hardware back stay as they were), so
// the departing screen is kept here, under its old index and key, until its
// slide ends. Animated and PanResponder only: no extra native modules.

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, PanResponder, Platform, StyleSheet, View, useWindowDimensions } from 'react-native'
import { STACK_MS, claimSwipe, popPlan, pushPlan, stackChange, swipeVerdict } from '../stackMotion'
import { createStackLock } from '../stackLock'
import { layout } from './theme'
import { useStyles } from './ThemeProvider'
import { ScreenCovered, ScreenVisible } from './screenVisible'

// The native driver is a platform API react-native-web does not have (it warns
// and falls back), so this picks the driver, never the behaviour.
const NATIVE_DRIVER = Platform.OS !== 'web'

// One transition at a time: a back press, Escape or a second swipe that lands
// while a screen is moving or being dragged is dropped. Each slide and each
// drag holds the lock under its own token, so an overtaken slide finishing
// late cannot free the stack under a newer one. The margin past each slide
// is the deadline that frees the stack if an end is never reported.
const lock = createStackLock()
const MARGIN_MS = 100
// A drag has no known length; the hold is renewed by nothing, so this is only
// the bound on a gesture whose end never arrives.
const DRAG_HOLD_MS = 10000
// The drag's own token while it hands its pop to App.js: the pop it asks for
// is the end of that drag, not a second transition.
let handoff = 0
export function stackBusy () {
  const holder = lock.holder(Date.now())
  return holder !== 0 && holder !== handoff
}

export function useReduceMotion () {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let live = true
    let sub = null
    try {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((value) => {
        if (live) setReduce(value === true)
      }, () => {})
      sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
        if (live) setReduce(value === true)
      })
    } catch {}
    return () => {
      live = false
      try { if (sub && typeof sub.remove === 'function') sub.remove() } catch {}
    }
  }, [])
  return reduce
}

export function useStackMotion (stack) {
  const reduce = useReduceMotion()
  const [seen, setSeen] = useState(stack)
  const [leaving, setLeaving] = useState(null)
  const [entering, setEntering] = useState(null)
  const [peek, setPeek] = useState(false)
  // Decided while rendering, not in an effect: an effect would let one frame
  // render without the departing screen, unmounting it before its slide.
  if (seen !== stack) {
    const change = stackChange(seen, stack)
    setSeen(stack)
    setPeek(false)
    setLeaving(change.kind === 'pop' ? { entry: change.entry, index: change.index } : null)
    setEntering(change.kind === 'push' ? change.entry : null)
  }
  const onLeft = useCallback((entry) => {
    setLeaving((l) => (l && l.entry === entry ? null : l))
  }, [])
  const onEntered = useCallback((entry) => {
    setEntering((e) => (e === entry ? null : e))
  }, [])
  // Safety net: a slide ends within its duration plus the margin even if its
  // callback was dropped, so a screen that left the stack never stays mounted
  // over the UI and a screen that arrived never stays untouchable.
  const limit = (reduce ? 0 : STACK_MS) + MARGIN_MS
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => onLeft(leaving.entry), limit)
    return () => clearTimeout(timer)
  }, [leaving])
  useEffect(() => {
    if (entering === null) return
    const timer = setTimeout(() => onEntered(entering), limit)
    return () => clearTimeout(timer)
  }, [entering])
  const depth = Array.isArray(stack) ? stack.length : 0
  return { depth, leaving, entering, peek, reduce, setPeek, onLeft, onEntered }
}

function roleOf (motion, index) {
  if (motion.leaving && motion.leaving.index === index && index >= motion.depth) return 'leaving'
  if (index === motion.depth - 1) return 'top'
  if (index === motion.depth - 2) return 'under'
  return 'buried'
}

export function StackLayer ({ motion, index, entry, onPop, children }) {
  const styles = useStyles(makeStyles)
  const role = roleOf(motion, index)
  const enter = role === 'top' && motion.entering === entry
  // Only the top entry is the screen the person sees; entries under it, and
  // one leaving, stay mounted but load no provider player.
  const covered = useContext(ScreenCovered)
  const screen = useWindowDimensions()
  // The layer sits in the shell's column, never wider than layout.column, so
  // the first frames before onLayout already slide by about the right width.
  const [width, setWidth] = useState(() => Math.max(1, Math.min(screen.width || layout.column, layout.column)))
  const [dragging, setDragging] = useState(false)
  const x = useRef(new Animated.Value(enter ? 1 : 0)).current
  const xNow = useRef(enter ? 1 : 0)
  const anim = useRef(null)
  // Bumped by every start and every deliberate stop: a callback from an
  // animation that is no longer the latest must not touch the stack.
  const gen = useRef(0)
  // The lock token this layer last took. Releasing it is always safe: once a
  // newer transition took the lock, this token is stale and changes nothing.
  const held = useRef(0)
  const dragActive = useRef(false)
  const popCheck = useRef(null)
  const touchStartX = useRef(null)
  const live = useRef(true)
  const leftDone = useRef(false)
  const frame = useRef(null)
  const pageLeft = useRef(0)
  const latest = useRef({})
  latest.current = { role, motion, entry, onPop, width }

  const holdFor = (ms) => {
    held.current = lock.acquire(Date.now(), ms)
    return held.current
  }
  const letGo = () => {
    if (held.current) lock.release(held.current)
    held.current = 0
  }

  // measure() includes transforms, so it reads the still frame around the
  // sliding view: measured mid-slide, the moving view would report a page
  // left that is off by the slide and stays wrong once it ends.
  const measureEdge = useCallback(() => {
    const node = frame.current
    if (!node || typeof node.measure !== 'function') return
    try {
      node.measure((_x, _y, _w, _h, pageX) => {
        if (typeof pageX === 'number' && Number.isFinite(pageX)) pageLeft.current = pageX
      })
    } catch {}
  }, [])

  // A centred column at its maximum width moves when the window is resized
  // without changing its own size, so onLayout does not fire: re-measure on
  // every window size change or the edge check reads a stale page left.
  useEffect(() => { measureEdge() }, [screen.width, screen.height, measureEdge])

  const run = useCallback((toX, duration, done) => {
    const mine = ++gen.current
    if (anim.current) {
      anim.current.stop()
      anim.current = null
    }
    let token = 0
    if (duration > 0) token = holdFor(duration + MARGIN_MS)
    else letGo()
    const complete = () => {
      anim.current = null
      xNow.current = toX
      if (token) {
        lock.release(token)
        if (held.current === token) held.current = 0
      }
      if (!live.current) return
      measureEdge()
      if (typeof done === 'function') done()
    }
    if (duration <= 0) {
      x.setValue(toX)
      complete()
      return
    }
    const a = Animated.timing(x, { toValue: toX, duration, useNativeDriver: NATIVE_DRIVER })
    anim.current = a
    a.start((result) => {
      if (mine !== gen.current) return
      if (!result || result.finished !== true) {
        // Stopped by nobody in this file and handed to nobody: end where the
        // slide was going, so a leaving screen cannot stay mounted half way.
        if (!live.current) return
        x.setValue(toX)
      }
      complete()
    })
  }, [x, measureEdge])

  // Stops whatever is running without letting its callback finish anything.
  const interrupt = useCallback(() => {
    gen.current++
    if (anim.current) {
      anim.current.stop()
      anim.current = null
    }
  }, [])

  const endDrag = () => {
    dragActive.current = false
    if (live.current) setDragging(false)
  }

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      interrupt()
      letGo()
      if (popCheck.current) clearTimeout(popCheck.current)
    }
  }, [])

  useEffect(() => {
    if (!enter) return
    const plan = pushPlan(motion.reduce)
    x.setValue(plan.fromX)
    xNow.current = plan.fromX
    run(plan.toX, plan.duration, () => motion.onEntered(entry))
  }, [enter])

  // A newer push covered this screen: whatever it was doing (sliding in, a
  // drag settling) stops where a covered screen rests, and its hold goes.
  useEffect(() => {
    if (role !== 'under' && role !== 'buried') return
    interrupt()
    x.setValue(0)
    xNow.current = 0
    letGo()
    if (dragActive.current || dragging) endDrag()
  }, [role])

  useEffect(() => {
    if (role !== 'leaving' || leftDone.current) return
    leftDone.current = true
    // A pop that lands mid-drag (the browser's Back) ends the drag here; the
    // drag handlers check the role and leave the slide alone from now on.
    if (dragActive.current || dragging) endDrag()
    const plan = popPlan(motion.reduce)
    const leave = (value) => {
      // A swipe that committed halfway, or a push still sliding in, finishes
      // the rest of the distance at the same speed.
      const now = Number.isFinite(value) ? value : xNow.current
      const from = Math.max(plan.fromX, Math.min(plan.toX, now))
      const duration = Math.round(plan.duration * (plan.toX - from))
      run(plan.toX, duration, () => latest.current.motion.onLeft(entry))
    }
    interrupt()
    if (plan.duration <= 0) {
      leave(plan.toX)
      return
    }
    // With the native driver the JS side never sees the frames, so the real
    // position comes from stopAnimation, asynchronously on iOS and Android.
    // The lock covers the wait.
    const mine = gen.current
    holdFor(plan.duration + MARGIN_MS)
    x.stopAnimation((value) => {
      if (mine !== gen.current || !live.current) return
      leave(value)
    })
  }, [role])

  useEffect(() => {
    if (role !== 'leaving') leftDone.current = false
  }, [role])

  function settle () {
    const back = Math.round(STACK_MS * xNow.current)
    run(0, latest.current.motion.reduce ? 0 : back, () => {
      endDrag()
      latest.current.motion.setPeek(false)
    })
  }

  // Browsers own their own back gesture (Safari's edge swipe walks history,
  // which the app follows already); this one only answers a pointer that
  // starts on the leading edge of the screen itself.
  // PanResponder fills gestureState.x0 only on grant (0 before it), so the
  // start is read from the touch itself, in the capture phase that sees every
  // touch first. Returning false leaves taps to the children.
  // The drag holds the lock from grant to the end of its settle (or to the
  // pop it hands over), and every handler stops acting once this screen is no
  // longer the top: a pop that arrived mid-gesture owns the slide.
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponderCapture: (e) => {
      const ne = e && e.nativeEvent
      if (ne && Array.isArray(ne.touches) && ne.touches.length > 1) return false
      touchStartX.current = ne && Number.isFinite(ne.pageX) ? ne.pageX : null
      return false
    },
    onMoveShouldSetPanResponderCapture: (_e, g) => {
      const { role, onPop } = latest.current
      if (role !== 'top' || typeof onPop !== 'function' || stackBusy()) return false
      // moveX - dx is the same start, for a touch whose start skipped us.
      const startX = touchStartX.current !== null ? touchStartX.current : g.moveX - g.dx
      return claimSwipe({ startX, pageLeft: pageLeft.current, dx: g.dx, dy: g.dy })
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      if (latest.current.role !== 'top') return
      interrupt()
      if (popCheck.current) {
        clearTimeout(popCheck.current)
        popCheck.current = null
      }
      holdFor(DRAG_HOLD_MS)
      dragActive.current = true
      setDragging(true)
      latest.current.motion.setPeek(true)
    },
    onPanResponderMove: (_e, g) => {
      if (!dragActive.current || latest.current.role !== 'top') return
      const w = latest.current.width || 1
      const v = Math.max(0, Math.min(1, g.dx / w))
      xNow.current = v
      x.setValue(v)
    },
    onPanResponderRelease: (_e, g) => {
      if (!dragActive.current) return
      dragActive.current = false
      const { role, width: w, onPop } = latest.current
      if (role !== 'top') return
      // swipeVerdict pops on speed alone, so a flick that ends leftwards of
      // where it started never reaches it.
      if (g.dx > 0 && swipeVerdict({ dx: g.dx, vx: g.vx, width: w }) === 'pop') {
        const token = held.current
        handoff = token
        try { onPop() } finally { handoff = 0 }
        // The pop's slide takes its own token once it starts; until then a
        // short hold keeps a second back out. If no pop came of it (refused,
        // or a browser that never answered), the screen settles back.
        if (token && lock.holder(Date.now()) === token) holdFor(STACK_MS + MARGIN_MS)
        popCheck.current = setTimeout(() => {
          popCheck.current = null
          if (!live.current || latest.current.role !== 'top' || dragActive.current || anim.current) return
          settle()
        }, STACK_MS + MARGIN_MS)
        return
      }
      settle()
    },
    onPanResponderTerminate: () => {
      if (!dragActive.current) return
      dragActive.current = false
      if (latest.current.role !== 'top') return
      settle()
    }
  })).current

  const onLayout = (e) => {
    const w = e.nativeEvent.layout.width
    if (w > 0 && w !== width) setWidth(w)
    measureEdge()
  }

  const shown = role === 'top' || role === 'leaving' || (role === 'under' && (motion.peek || motion.entering !== null))
  // While this screen slides in or out its frame takes every touch over the
  // whole column and its content takes none, so a tap mid-slide reaches no
  // screen (neither the departing one nor the one under it). While it is
  // dragged the frame blocks the uncovered strip and the content keeps the
  // gesture.
  const sliding = role === 'leaving' || enter
  const blocking = sliding || dragging
  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [0, width] })
  return (
    <View
      ref={frame}
      collapsable={false}
      onLayout={onLayout}
      pointerEvents={blocking ? 'auto' : 'box-none'}
      style={[styles.frame, shown ? null : styles.hidden]}
    >
      <Animated.View
        pointerEvents={sliding ? 'none' : 'auto'}
        style={[styles.layer, (role === 'top' || role === 'leaving') && { transform: [{ translateX }] }]}
        {...(role === 'top' ? responder.panHandlers : null)}
      >
        <ScreenVisible.Provider value={!covered && role === 'top'}>
          {children}
        </ScreenVisible.Provider>
      </Animated.View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  frame: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg },
  hidden: { display: 'none' }
})
