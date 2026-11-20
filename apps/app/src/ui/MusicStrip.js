import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, PanResponder, StyleSheet, Text, View } from 'react-native'
import { clampStart, maxStart, musicClock, musicWindowText } from '../music.js'
import { BAR_PITCH, BAR_WIDTH, PX_PER_S, barHeight, startFromDrag, stripOffset, stripPx, visibleBars, windowPx } from '../musicStrip.js'
import { tap } from './haptics'
import { stepKeyProps } from './musicKeys'
import { useStyles, useTheme } from './ThemeProvider'
import { radius } from './theme'

const HEIGHT = 72
const BAR_MAX = 48
const TOP = 20

// The bars are decorative, so the value announces times, not loudness.
export function MusicStrip ({ id, duration, start, progress, onChange, onCommit }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [viewport, setViewport] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)
  const translate = useRef(null)
  if (!translate.current) translate.current = new Animated.Value(0)
  const head = useRef(null)
  if (!head.current) head.current = new Animated.Value(0)
  const drag = useRef({ active: false, origin: 0, latest: 0 })
  const lastProgress = useRef(null)
  const live = useRef({})
  const max = maxStart(duration)
  const s = clampStart(start, duration)
  const win = windowPx(duration)
  live.current = { duration, viewport, s, onChange, onCommit }

  useEffect(() => {
    let on = true
    try {
      const pending = AccessibilityInfo.isReduceMotionEnabled()
      if (pending && typeof pending.then === 'function') {
        pending.then((value) => { if (on && value === true) setReduceMotion(true) }, () => {})
      }
    } catch {}
    return () => { on = false }
  }, [])

  // A re-render mid drag must not pull the strip back under the finger.
  useEffect(() => {
    if (!drag.current.active) translate.current.setValue(stripOffset(s, viewport, duration))
  }, [s, viewport, duration])

  useEffect(() => {
    if (typeof progress !== 'number' || !Number.isFinite(progress)) { lastProgress.current = null; return }
    const p = Math.min(1, Math.max(0, progress))
    const target = p * win
    const previous = lastProgress.current
    lastProgress.current = p
    if (reduceMotion || previous === null || p < previous) { head.current.setValue(target); return }
    Animated.timing(head.current, { toValue: target, duration: 250, easing: Easing.linear, useNativeDriver: false }).start()
  }, [progress, win, reduceMotion])

  const bars = useMemo(() => visibleBars(stripOffset(s, viewport, duration), viewport, duration), [s, viewport, duration])

  const responder = useMemo(() => {
    const enabled = () => maxStart(live.current.duration) > 0
    const end = () => {
      const d = drag.current
      if (!d.active) return
      d.active = false
      const { viewport, duration } = live.current
      translate.current.setValue(stripOffset(d.latest, viewport, duration))
      live.current.onCommit?.(d.latest)
      tap('select')
    }
    return PanResponder.create({
      onStartShouldSetPanResponder: enabled,
      onMoveShouldSetPanResponder: enabled,
      onPanResponderGrant: () => {
        drag.current = { active: true, origin: live.current.s, latest: live.current.s }
      },
      onPanResponderMove: (_event, gesture) => {
        const d = drag.current
        if (!d.active) return
        const { viewport, duration } = live.current
        const dx = gesture && Number.isFinite(gesture.dx) ? gesture.dx : 0
        const low = stripOffset(maxStart(duration), viewport, duration)
        const high = stripOffset(0, viewport, duration)
        translate.current.setValue(Math.min(high, Math.max(low, stripOffset(d.origin, viewport, duration) + dx)))
        const next = startFromDrag(d.origin, dx, duration)
        if (next !== d.latest) {
          d.latest = next
          live.current.onChange?.(next)
        }
      },
      onPanResponderRelease: end,
      onPanResponderTerminate: end
    })
  }, [])

  const step = (delta) => {
    let next
    if (delta === 'min') next = 0
    else if (delta === 'max') next = max
    else next = clampStart(s + delta, duration)
    onChange?.(next)
    onCommit?.(next)
  }

  const onAction = (event) => {
    const name = event && event.nativeEvent && event.nativeEvent.actionName
    if (name === 'increment') step(1)
    else if (name === 'decrement') step(-1)
  }

  const left = Math.max(0, (viewport - win) / 2)
  const windowLeft = s * PX_PER_S
  const items = []
  for (let i = 0; i < bars.count; i++) {
    const index = bars.first + i
    const x = index * BAR_PITCH
    const h = barHeight(id, index) * BAR_MAX
    const inside = x >= windowLeft && x + BAR_WIDTH <= windowLeft + win
    items.push(
      <View
        key={index}
        style={[styles.bar, { left: x, height: h, top: (BAR_MAX - h) / 2, backgroundColor: inside ? colors.accent : colors.line }]}
      />
    )
  }
  const text = musicWindowText(s, duration)
  const showHead = typeof progress === 'number' && Number.isFinite(progress)

  return (
    <View
      style={styles.root}
      onLayout={(e) => setViewport(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole='adjustable'
      accessibilityLabel='Início do trecho'
      accessibilityValue={{ min: 0, max, now: s, text }}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={s}
      aria-valuetext={text}
      accessibilityActions={[{ name: 'increment', label: 'Avançar um segundo' }, { name: 'decrement', label: 'Voltar um segundo' }]}
      onAccessibilityAction={onAction}
      {...stepKeyProps(step)}
      {...responder.panHandlers}
    >
      <Text style={styles.clock} accessibilityElementsHidden importantForAccessibility='no' aria-hidden>{musicClock(s)}</Text>
      <Animated.View
        style={[styles.strip, { width: stripPx(duration), transform: [{ translateX: translate.current }] }]}
        pointerEvents='none'
        accessibilityElementsHidden
        importantForAccessibility='no-hide-descendants'
        aria-hidden
      >
        {items}
      </Animated.View>
      <View style={[styles.window, { left, width: win }]} pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
        {showHead ? <Animated.View style={[styles.head, { left: head.current }]} /> : null}
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { height: HEIGHT, overflow: 'hidden' },
  clock: { position: 'absolute', top: 0, left: 0, right: 0, textAlign: 'center', fontSize: 12, color: colors.soft },
  strip: { position: 'absolute', top: TOP, left: 0, height: BAR_MAX },
  bar: { position: 'absolute', width: BAR_WIDTH, borderRadius: 1 },
  window: { position: 'absolute', top: TOP - 2, height: BAR_MAX + 4, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.sm },
  head: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.accent }
})
