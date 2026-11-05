/* global document, getComputedStyle */
// Presentational splash while the app decides its first screen: the chair
// rises and settles, the letters of the name enter one by one, then the
// progress bar fades in and pulses; its fill follows `progress` (real boot
// steps, src/splashGate.js bootProgress). On native it stays cream in both schemes to match the
// launch screens (their raster chair has an ink frame that vanishes on dark);
// on the web it follows the scheme, like the pre-splash in index.html.
// On the web, public/index.html paints its own opaque overlay with the same
// composition before the bundle runs; this component then stays silent under
// it and removes it on unmount, so it is neither cut short nor doubled.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Image, Platform, StyleSheet, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView } from 'react-native-safe-area-context'
import { light, statusBarStyle } from '../appearance'
import { useStyles, useTheme } from './ThemeProvider'
import { fonts, type } from './theme'
import { loopTiming } from './loopMotion'
import { BAR_MS, BAR_WIDTH, SPLASH_LABEL, SPLASH_WORD, PULSE_MS, splashMotion } from './splashMotion'

const mark = require('../../assets/cadeira.png')

const native = Platform.OS !== 'web'

// react-native-web 0.21 reads only aria-hidden; native reads the other two.
const hiddenFromReaders = {
  'aria-hidden': true,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants'
}

const unit = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

export function Splash ({ sidePad = 0, edges, progress = 0 }) {
  const themed = useStyles(makeStyles)
  const theme = useTheme()
  const styles = nativeStyles || themed
  const scheme = native ? 'light' : theme.scheme
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
    const stopAll = () => {
      if (composite) composite.stop()
      if (loop) loop.stop()
      composite = null
      loop = null
    }
    const settle = () => {
      reduced = true
      stillRef.current = true
      stopAll()
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
    const play = () => {
      const c = chair.current
      const chairEase = Easing.bezier(0.22, 1, 0.36, 1)
      const ease = Easing.out(Easing.quad)
      const timing = (value, toValue, duration, delay, easing) =>
        Animated.timing(value, { toValue, duration, delay, easing, useNativeDriver: native })
      const steps = [
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
            else startPulse()
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

  const c = chair.current
  const rotate = c.rotate.interpolate({ inputRange: [-6, 0], outputRange: ['-6deg', '0deg'] })

  return (
    <SafeAreaView
      style={[styles.root, { paddingHorizontal: sidePad }]}
      edges={edges}
      {...(underShell ? { 'aria-hidden': true } : null)}
    >
      <Animated.View
        style={[styles.chair, scheme === 'dark' && styles.chairDisc, {
          opacity: c.opacity,
          transform: [{ translateY: c.translateY }, { scale: c.scale }, { rotate }]
        }]}
      >
        <Image source={mark} style={styles.mark} accessible={false} accessibilityIgnoresInvertColors />
      </Animated.View>
      <View accessible accessibilityRole='header' accessibilityLabel={SPLASH_LABEL} style={styles.word}>
        {Array.from(SPLASH_WORD).map((ch, i) => (
          <Animated.Text
            key={i}
            {...hiddenFromReaders}
            style={[styles.letter, {
              opacity: letters.current[i].opacity,
              transform: [{ translateY: letters.current[i].translateY }]
            }]}
          >
            {ch}
          </Animated.Text>
        ))}
      </View>
      <Animated.View {...hiddenFromReaders} style={[styles.bar, { opacity: hintOpacity.current }]}>
        <Animated.View style={[styles.barFill, { width: fill.current.interpolate({ inputRange: [0, 1], outputRange: [0, BAR_WIDTH] }) }]} />
      </Animated.View>
      <StatusBar style={statusBarStyle(scheme)} />
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg
  },
  chair: { marginBottom: 12 },
  // The ink frame of the chair art vanishes on the dark background, so it
  // sits on the cream it was drawn for.
  chairDisc: { backgroundColor: '#fbf8f3', borderRadius: 28, padding: 8 },
  mark: { width: 96, height: 96 },
  word: { flexDirection: 'row', marginBottom: 8 },
  letter: {
    ...type.profileName,
    fontFamily: fonts.title,
    color: colors.accent
  },
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
