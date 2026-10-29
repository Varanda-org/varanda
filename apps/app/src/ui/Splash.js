// Presentational splash while the app decides its first screen. The cream
// background matches the native launch screens, so the hand-off stays
// seamless. The entrance runs only after reduced motion is confirmed off.

import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, Image, Platform, StyleSheet, Text } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, fonts, motion, type } from './theme'

const mark = require('../../assets/cadeira.png')

const WORDMARK = 'Varanda'
const DEFAULT_HINT = 'conectando…'

const native = Platform.OS !== 'web'

export function Splash ({ sidePad = 0, edges, hint = DEFAULT_HINT }) {
  const markFade = useRef(new Animated.Value(0)).current
  const markScale = useRef(new Animated.Value(0.92)).current
  const copyFade = useRef(new Animated.Value(0)).current
  const running = useRef(null)

  useEffect(() => {
    let cancelled = false
    const settle = () => {
      markFade.setValue(1)
      markScale.setValue(1)
      copyFade.setValue(1)
    }
    const play = () => {
      // The chair leads; the name starts a short beat later.
      const anim = Animated.parallel([
        Animated.timing(markFade, { toValue: 1, duration: motion.normal * 2, useNativeDriver: native }),
        Animated.timing(markScale, { toValue: 1, duration: motion.normal * 2, useNativeDriver: native }),
        Animated.timing(copyFade, {
          toValue: 1,
          duration: motion.normal * 2,
          delay: motion.fast,
          useNativeDriver: native
        })
      ])
      running.current = anim
      anim.start()
    }
    const skip = () => {
      if (!cancelled) settle()
    }
    try {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((reduce) => {
        if (cancelled) return
        if (reduce === true) settle()
        else play()
      }, skip)
    } catch {
      settle()
    }
    return () => {
      cancelled = true
      if (running.current) running.current.stop()
    }
  }, [markFade, markScale, copyFade])

  return (
    <SafeAreaView style={[styles.root, { paddingHorizontal: sidePad }]} edges={edges}>
      <Animated.View style={{ opacity: markFade, transform: [{ scale: markScale }] }}>
        <Image source={mark} style={styles.mark} accessible={false} accessibilityIgnoresInvertColors />
      </Animated.View>
      <Animated.View style={[styles.copy, { opacity: copyFade }]}>
        <Text style={styles.wordmark}>{WORDMARK}</Text>
        <Text style={styles.hint} accessibilityLiveRegion='polite'>{hint}</Text>
      </Animated.View>
      <StatusBar style='dark' />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.bg
  },
  mark: { width: 72, height: 72 },
  copy: { alignItems: 'center', gap: 8 },
  wordmark: {
    ...type.profileName,
    fontFamily: fonts.title,
    color: colors.accent,
    textAlign: 'center'
  },
  hint: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.soft,
    textAlign: 'center'
  }
})
