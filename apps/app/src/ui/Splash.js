/* global document, getComputedStyle */
// Presentational splash while the app decides its first screen: the street
// and the sky band rise, the varanda appears beside its araucária, the chair
// comes up onto its floor (birds cross the sky and a butterfly flutters by
// the plant, by day only), the logo's hand-drawn letters of the name enter
// one by one, then the progress bar fades in and pulses while the calçada
// keeps sliding; the bar's fill follows `progress` (real boot steps,
// src/splashGate.js bootProgress). On native it stays cream in both schemes
// to match the launch screens; on the web it follows the scheme, like the
// pre-splash in index.html.
// On the web, public/index.html paints its own opaque overlay with the same
// composition before the bundle runs; this component then stays silent under
// it and removes it on unmount, so it is neither cut short nor doubled.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, useWindowDimensions } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { light, statusBarStyle } from '../appearance'
import { useStyles, useTheme } from './ThemeProvider'
import { loopTiming } from './loopMotion'
import { BAR_MS, BAR_WIDTH, FLYERS, SPLASH_LABEL, PULSE_MS, flyerMotion, slideMotion, splashMotion } from './splashMotion'
import { sceneLayout, scenePalette, stripLoops } from './splashScene'
import { SplashLettering, SplashScene, hiddenFromReaders } from './SplashSceneView'

const native = Platform.OS !== 'web'

const unit = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

export function Splash ({ sidePad = 0, edges, progress = 0 }) {
  const themed = useStyles(makeStyles)
  const theme = useTheme()
  const styles = nativeStyles || themed
  const scheme = native ? 'light' : theme.scheme
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const layout = useMemo(() => sceneLayout({ width, height }), [width, height])
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const palette = scenePalette(scheme)
  const full = useRef(null)
  if (full.current === null) full.current = splashMotion(false)
  const shellRef = useRef(undefined)
  if (shellRef.current === undefined) {
    let el = !native && typeof document !== 'undefined'
      ? document.getElementById('varanda-pre-splash')
      : null
    // Past its 20 s CSS expiry the overlay is invisible and out of the
    // accessibility tree, so this splash must be the one people see and hear.
    if (el && typeof getComputedStyle === 'function' && getComputedStyle(el).visibility === 'hidden') {
      el.remove()
      el = null
    }
    shellRef.current = el
  }
  // Drops once the overlay expires, so the splash enters the accessibility tree.
  const [underShell, setUnderShell] = useState(() => shellRef.current !== null)
  const chair = useRef(null)
  if (chair.current === null) {
    const f = full.current.chair.from
    chair.current = {
      opacity: new Animated.Value(f.opacity),
      translateY: new Animated.Value(f.translateY),
      scale: new Animated.Value(f.scale),
      rotate: new Animated.Value(f.rotate)
    }
  }
  const ground = useRef(null)
  if (ground.current === null) {
    const f = full.current.ground.from
    ground.current = { opacity: new Animated.Value(f.opacity), translateY: new Animated.Value(f.translateY) }
  }
  const varanda = useRef(null)
  if (varanda.current === null) {
    const f = full.current.varanda.from
    varanda.current = { opacity: new Animated.Value(f.opacity), translateY: new Animated.Value(f.translateY) }
  }
  const slideNear = useRef(null)
  if (slideNear.current === null) slideNear.current = new Animated.Value(0)
  const slideFar = useRef(null)
  if (slideFar.current === null) slideFar.current = new Animated.Value(0)
  // The sky's flyers: one 0..1 crossing per bird, the butterfly's wing beat
  // and its drift. At 0 every flyer stands at its visible rest pose.
  const flyers = useRef(null)
  if (flyers.current === null) {
    flyers.current = {
      birds: FLYERS.birds.map(() => new Animated.Value(0)),
      flap: new Animated.Value(0),
      drift: new Animated.Value(0)
    }
  }
  const letters = useRef(null)
  if (letters.current === null) {
    letters.current = full.current.letters.map((l) => ({
      opacity: new Animated.Value(l.from.opacity),
      translateY: new Animated.Value(l.from.translateY)
    }))
  }
  const hintOpacity = useRef(null)
  if (hintOpacity.current === null) hintOpacity.current = new Animated.Value(full.current.hint.from.opacity)
  const fill = useRef(null)
  if (fill.current === null) fill.current = new Animated.Value(unit(progress))
  // Reduce motion (or the silent splash under the web overlay): the fill
  // jumps instead of sliding.
  const stillRef = useRef(false)
  // The web overlay (public/index.html) draws its own bar from this variable.
  useEffect(() => {
    const p = unit(progress)
    const shell = shellRef.current
    if (shell && shell.style && typeof shell.style.setProperty === 'function') shell.style.setProperty('--varanda-progress', String(p))
    if (stillRef.current) {
      fill.current.setValue(p)
      return
    }
    const anim = Animated.timing(fill.current, { toValue: p, duration: BAR_MS, easing: Easing.out(Easing.quad), useNativeDriver: false, isInteraction: false })
    anim.start()
    return () => anim.stop()
  }, [progress])

  useEffect(() => {
    const shell = shellRef.current
    const m = full.current
    let cancelled = false
    let reduced = false
    let composite = null
    let loop = null
    let slides = []
    let flights = []
    const stopAll = () => {
      if (composite) composite.stop()
      if (loop) loop.stop()
      slides.forEach((s) => s.stop())
      flights.forEach((f) => f.stop())
      composite = null
      loop = null
      slides = []
      flights = []
    }
    const settle = () => {
      reduced = true
      stillRef.current = true
      stopAll()
      const pose = (v, to) => {
        v.opacity.setValue(to.opacity)
        v.translateY.setValue(to.translateY)
      }
      pose(ground.current, m.ground.to)
      pose(varanda.current, m.varanda.to)
      slideNear.current.setValue(0)
      slideFar.current.setValue(0)
      flyers.current.birds.forEach((v) => v.setValue(0))
      flyers.current.flap.setValue(0)
      flyers.current.drift.setValue(0)
      const c = chair.current
      c.opacity.setValue(m.chair.to.opacity)
      c.translateY.setValue(m.chair.to.translateY)
      c.scale.setValue(m.chair.to.scale)
      c.rotate.setValue(m.chair.to.rotate)
      letters.current.forEach((v, i) => {
        v.opacity.setValue(m.letters[i].to.opacity)
        v.translateY.setValue(m.letters[i].to.translateY)
      })
      hintOpacity.current.setValue(m.hint.to.opacity)
    }
    const startPulse = () => {
      const pulse = (toValue) => Animated.timing(hintOpacity.current, loopTiming({
        toValue,
        duration: PULSE_MS,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: native
      }))
      // Without this the loop resets the hint to its initial 0 before each pass.
      loop = Animated.loop(Animated.sequence([pulse(0.6), pulse(1)]), { resetBeforeIteration: false })
      loop.start()
    }
    const startSlides = () => {
      if (!slideMotion(reduced)) return
      const loops = stripLoops(layoutRef.current.k)
      const near = Animated.loop(Animated.timing(slideNear.current, loopTiming({ toValue: 1, duration: loops.near.ms, easing: Easing.linear, useNativeDriver: native })))
      const far = Animated.loop(Animated.timing(slideFar.current, loopTiming({ toValue: 1, duration: loops.far.ms, easing: Easing.linear, useNativeDriver: native })))
      slides = [near, far]
      near.start()
      far.start()
    }
    const startFlyers = () => {
      const f = flyerMotion(reduced)
      if (!f) return
      const v = flyers.current
      const birds = v.birds.map((b, i) => Animated.loop(Animated.timing(b, loopTiming({ toValue: 1, duration: f.birds[i].ms, easing: Easing.linear, useNativeDriver: native }))))
      const flap = Animated.loop(Animated.timing(v.flap, loopTiming({ toValue: 1, duration: f.butterfly.flapMs, easing: Easing.linear, useNativeDriver: native })))
      const drift = Animated.loop(Animated.timing(v.drift, loopTiming({ toValue: 1, duration: f.butterfly.driftMs, easing: Easing.linear, useNativeDriver: native })))
      flights = [...birds, flap, drift]
      flights.forEach((a) => a.start())
    }
    const play = () => {
      const c = chair.current
      const chairEase = Easing.bezier(0.22, 1, 0.36, 1)
      const ease = Easing.out(Easing.quad)
      const timing = (value, toValue, duration, delay, easing) =>
        Animated.timing(value, { toValue, duration, delay, easing, useNativeDriver: native })
      const g = ground.current
      const v = varanda.current
      const steps = [
        timing(g.opacity, m.ground.to.opacity, m.ground.duration, m.ground.delay, ease),
        timing(g.translateY, m.ground.to.translateY, m.ground.duration, m.ground.delay, ease),
        timing(v.opacity, m.varanda.to.opacity, m.varanda.duration, m.varanda.delay, ease),
        timing(v.translateY, m.varanda.to.translateY, m.varanda.duration, m.varanda.delay, ease),
        timing(c.opacity, m.chair.to.opacity, m.chair.duration, m.chair.delay, chairEase),
        timing(c.translateY, m.chair.to.translateY, m.chair.duration, m.chair.delay, chairEase),
        timing(c.scale, m.chair.to.scale, m.chair.duration, m.chair.delay, chairEase),
        timing(c.rotate, m.chair.to.rotate, m.chair.duration, m.chair.delay, chairEase)
      ]
      letters.current.forEach((v, i) => {
        const l = m.letters[i]
        steps.push(timing(v.opacity, l.to.opacity, l.duration, l.delay, ease))
        steps.push(timing(v.translateY, l.to.translateY, l.duration, l.delay, ease))
      })
      steps.push(timing(hintOpacity.current, m.hint.to.opacity, m.hint.duration, m.hint.delay, ease))
      const anim = Animated.parallel(steps)
      composite = anim
      anim.start(({ finished } = {}) => {
        if (finished !== true || cancelled || reduced) return
        startPulse()
      })
      startSlides()
      startFlyers()
    }
    const skip = () => {
      if (!cancelled) settle()
    }

    const watchReduceMotion = () => {
      try {
        sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (r) => {
          if (r === true) settle()
        })
      } catch {}
    }
    let sub = null
    let onExpire = null
    if (shell) {
      settle()
      // The overlay hides itself at 20 s; from then on this splash is the
      // visible one, so it must be readable and keep its hint pulse.
      onExpire = (event) => {
        if (event.animationName !== 'vps-expire') return
        shell.remove()
        if (cancelled) return
        setUnderShell(false)
        reduced = false
        stillRef.current = false
        watchReduceMotion()
        try {
          Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((reduce) => {
            if (cancelled || reduced) return
            if (reduce === true) settle()
            else {
              startPulse()
              // The strips and the flyers restart from 0 here: on this 20 s
              // failure path a one-off hop against the overlay's last frame
              // is acceptable.
              startSlides()
              startFlyers()
            }
          }, skip)
        } catch {
          settle()
        }
      }
      shell.addEventListener('animationend', onExpire)
    } else {
      try {
        Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((reduce) => {
          if (cancelled) return
          if (reduce === true) settle()
          else play()
        }, skip)
      } catch {
        settle()
      }
      watchReduceMotion()
    }
    return () => {
      cancelled = true
      stopAll()
      sub?.remove?.()
      if (shell) {
        if (onExpire) shell.removeEventListener('animationend', onExpire)
        shell.remove()
      }
    }
  }, [])

  return (
    <SafeAreaView
      style={[styles.root, { paddingHorizontal: sidePad }]}
      edges={edges}
      {...(underShell ? { 'aria-hidden': true } : null)}
    >
      {!underShell && (
        // App.js pads the splash wrapper by the side insets; the scene undoes
        // that so the pavement reaches both screen edges.
        <View style={[styles.scene, { left: -Math.max(insets.left, insets.right), right: -Math.max(insets.left, insets.right) }]}>
          <SplashScene
            layout={layout}
            palette={palette}
            bottomInset={insets.bottom}
            ground={ground.current}
            varanda={varanda.current}
            chair={chair.current}
            slideNear={slideNear.current}
            slideFar={slideFar.current}
            flyers={flyers.current}
          />
        </View>
      )}
      <View style={[styles.top, { marginBottom: layout.height }]}>
        <View accessible accessibilityRole='header' accessibilityLabel={SPLASH_LABEL} style={styles.word}>
          <SplashLettering palette={palette} letters={letters.current} />
        </View>
        <Animated.View {...hiddenFromReaders} style={[styles.bar, { opacity: hintOpacity.current }]}>
          <Animated.View style={[styles.barFill, { width: fill.current.interpolate({ inputRange: [0, 1], outputRange: [0, BAR_WIDTH] }) }]} />
        </Animated.View>
      </View>
      <StatusBar style={statusBarStyle(scheme)} />
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg
  },
  scene: { position: 'absolute', bottom: 0 },
  top: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  word: { flexDirection: 'row', marginBottom: 8 },
  bar: {
    width: BAR_WIDTH,
    height: 4,
    marginTop: 8,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.line
  },
  barFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent
  }
})

// Built once: native always paints the light splash (see the header).
const nativeStyles = native ? makeStyles(light) : null
