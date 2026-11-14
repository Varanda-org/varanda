import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, View } from 'react-native'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { motion } from './theme'
import { useReduceMotion } from './StackLayer'

export function JumpToEnd ({ count = 0, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const reduce = useReduceMotion()
  const fade = useRef(new Animated.Value(reduce ? 1 : 0)).current
  useEffect(() => {
    if (reduce) fade.setValue(1)
    else Animated.timing(fade, { toValue: 1, duration: motion.fast, useNativeDriver: false }).start()
  }, [fade, reduce])
  return (
    <Animated.View pointerEvents='box-none' style={[styles.anchor, { opacity: fade }]}>
      <Pressable accessibilityRole='button' accessibilityLabel='ir para o fim' accessibilityHint={count > 0 ? count + ' novas' : undefined} hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Icon name='escolher' size={20} color={colors.accent} />
        {count > 0 ? <View style={styles.dot} /> : null}
      </Pressable>
    </Animated.View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  anchor: { height: 0, zIndex: 2, alignItems: 'flex-end' },
  button: { position: 'absolute', right: 16, bottom: 12, width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: 0, right: 0, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  pressed: { opacity: 0.65 }
})
