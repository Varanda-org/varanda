import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { motion } from './theme'
import { useReduceMotion } from './StackLayer'

// `text`: the unread count below ('' for none, '99+' past that), drawn on the
// button's corner. `hint` says it for a screen reader.
export function JumpToEnd ({ text = '', hint, onPress }) {
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
      <Pressable accessibilityRole='button' accessibilityLabel='ir para o fim' accessibilityHint={hint} hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Icon name='escolher' size={20} color={colors.accent} />
        {text !== ''
          ? <View style={styles.count} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden><Text style={styles.countText} numberOfLines={1}>{text}</Text></View>
          : null}
      </Pressable>
    </Animated.View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  anchor: { height: 48, marginTop: -48, zIndex: 2, alignItems: 'flex-end', justifyContent: 'flex-end' },
  button: { marginRight: 16, marginBottom: 12, width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  // The count sits on the corner like IconAction's (TopActions.js).
  count: {
    position: 'absolute',
    top: -8,
    right: -8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent
  },
  countText: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: colors.accentInk },
  pressed: { opacity: 0.65 }
})
