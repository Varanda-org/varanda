import { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, StyleSheet } from 'react-native'
import { pressScale, pressTiming } from '../pressMotion'
import { useReduceMotion } from './StackLayer'
import { motion } from './theme'

// The native driver is a platform API react-native-web does not have (it warns
// and falls back), so this picks the driver, never the behaviour.
const NATIVE_DRIVER = Platform.OS !== 'web'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export function PressScale ({ children, onPress, onLongPress, disabled, style, hitSlop, accessibilityLabel, accessibilityRole = 'button', accessibilityState }) {
  const reduceMotion = useReduceMotion()
  const [pressed, setPressed] = useState(false)
  const scale = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (disabled) setPressed(false)
    const toValue = pressScale({ pressed: pressed && !disabled, reduceMotion })
    const duration = pressTiming(reduceMotion, motion.press)
    if (duration === 0) {
      scale.setValue(toValue)
      return
    }
    const run = Animated.timing(scale, { toValue, duration, useNativeDriver: NATIVE_DRIVER })
    run.start()
    return () => run.stop()
  }, [pressed, disabled, reduceMotion, scale])
  // Pressable invokes a style function only when `style` itself is that function
  // (an array drops it). A later transform replaces an earlier one, so the
  // caller's transform is copied and the press scale is appended.
  const resolved = typeof style === 'function' ? style({ pressed: pressed && !disabled }) : style
  const flat = resolved === null || resolved === undefined || resolved === false ? null : StyleSheet.flatten(resolved)
  const callerTransform = flat && Array.isArray(flat.transform) ? flat.transform : null
  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled: !!disabled }}
      style={[resolved, { transform: callerTransform ? [...callerTransform, { scale }] : [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  )
}
