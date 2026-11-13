import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native'
import { loopTiming } from './loopMotion'
import { useStyles, useTheme } from './ThemeProvider'

const durations = [380, 520, 440]

export function MusicEqualizer ({ playing, color, size = 16 }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const bars = useRef(durations.map(() => new Animated.Value(0.6))).current
  const [reduce, setReduce] = useState(null)

  useEffect(() => {
    let live = true
    let sub = null
    try {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((value) => {
        if (live) setReduce(value !== false)
      }, () => {})
      sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
        if (live) setReduce(value !== false)
      })
    } catch {}
    return () => {
      live = false
      try { if (sub && typeof sub.remove === 'function') sub.remove() } catch {}
    }
  }, [])

  useEffect(() => {
    if (!playing || reduce !== false) {
      bars.forEach((value) => value.setValue(0.6))
      return
    }
    const loops = bars.map((value, index) => {
      value.setValue(0.3)
      return Animated.loop(Animated.sequence([
        Animated.timing(value, loopTiming({ toValue: 1, duration: durations[index], useNativeDriver: false })),
        Animated.timing(value, loopTiming({ toValue: 0.3, duration: durations[index], useNativeDriver: false }))
      ]))
    })
    loops.forEach((loop) => loop.start())
    return () => loops.forEach((loop) => loop.stop())
  }, [bars, playing, reduce])

  return (
    <View
      style={[styles.row, { width: size, height: size }]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
    >
      {bars.map((value, index) => (
        <Animated.View
          key={index}
          style={[styles.bar, { width: size / 5, height: size, backgroundColor: color ?? colors.ink, transform: [{ scaleY: value }] }]}
        />
      ))}
    </View>
  )
}

const makeStyles = () => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bar: { borderRadius: 1 }
})
