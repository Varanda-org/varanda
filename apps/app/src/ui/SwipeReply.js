import { useEffect, useRef } from 'react'
import { Animated, PanResponder, StyleSheet, View } from 'react-native'
import { swipePlan } from '../chatGestures'
import { Icon } from './Icon'
import { useTheme } from './ThemeProvider'
import { useReduceMotion } from './StackLayer'
import { tap } from './haptics'
import { RowShift } from './screenVisible'

export function SwipeReply ({ children, onReply, disabled = false }) {
  const { colors } = useTheme()
  const reduce = useReduceMotion()
  const x = useRef(new Animated.Value(0)).current
  const latest = useRef(null)
  latest.current = { onReply, disabled, reduce }
  const active = useRef(false)
  const start = useRef(null)
  const responder = useRef(null)
  if (responder.current === null) {
    const touchOnly = (event) => {
      const touch = event.nativeEvent
      // RN Web also synthesizes touches for mouse events.
      const mouse = (touch.type || '').startsWith('mouse') || (touch.pointerType && touch.pointerType !== 'touch')
      return !latest.current.disabled && !mouse && touch.touches?.length === 1
    }
    const delta = (gesture) => ({ dx: gesture.moveX - start.current.x, dy: gesture.moveY - start.current.y })
    const plan = (gesture) => {
      if (!start.current) return 'ignore'
      const { dx, dy } = delta(gesture)
      return swipePlan(dx, dy, start.current.x)
    }
    const accepts = (event, gesture) => touchOnly(event) && plan(gesture) !== 'ignore'
    const reset = () => {
      active.current = false
      x.stopAnimation()
      if (latest.current.reduce) x.setValue(0)
      else Animated.timing(x, { toValue: 0, duration: 120, useNativeDriver: false }).start()
    }
    responder.current = PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => {
        const touch = event.nativeEvent.touches?.[0]
        start.current = touchOnly(event) ? { x: touch.pageX, y: touch.pageY } : null
        return false
      },
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: accepts,
      onMoveShouldSetPanResponderCapture: accepts,
      onPanResponderGrant: () => { active.current = true; x.stopAnimation() },
      onPanResponderStart: (event) => { if (!touchOnly(event)) reset() },
      onPanResponderMove: (event, gesture) => {
        if (!active.current || !start.current) return
        if (!touchOnly(event)) return reset()
        const { dx, dy } = delta(gesture)
        // The same ratio as swipePlan: a swipe that could not reply is let go.
        if (Math.abs(dx) < 2 * Math.abs(dy)) return reset()
        x.setValue(Math.max(0, Math.min(72, dx)))
      },
      onPanResponderRelease: (event, gesture) => {
        const reply = active.current && !latest.current.disabled && plan(gesture) === 'reply'
        reset()
        if (reply && typeof latest.current.onReply === 'function') {
          tap('light')
          latest.current.onReply()
        }
      },
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => true
    })
  }
  useEffect(() => {
    if (disabled) { x.stopAnimation(); x.setValue(0) }
    if (disabled) active.current = false
  }, [disabled, reduce, x])
  useEffect(() => () => x.stopAnimation(), [x])
  return (
    <View {...responder.current.panHandlers}>
      <Animated.View pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' style={[styles.icon, { opacity: x.interpolate({ inputRange: [0, 56], outputRange: [0, 1], extrapolate: 'clamp' }) }]}>
        <Icon name='responder' size={22} color={colors.accent} />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: reduce ? 0 : x }] }}>
        <RowShift.Provider value={reduce ? null : x}>{children}</RowShift.Provider>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  icon: { position: 'absolute', left: 16, top: 0, bottom: 0, justifyContent: 'center' }
})
