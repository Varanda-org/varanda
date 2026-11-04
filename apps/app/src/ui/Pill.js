// A pill-shaped button: filled (accent) or outlined (ink or danger).

import { Pressable, StyleSheet, Text } from 'react-native'
import { useStyles } from './ThemeProvider'
import { type } from './theme'

export function Pill ({ label, onPress, filled, danger, disabled, pending, accessibilityLabel }) {
  const styles = useStyles(makeStyles)
  const off = disabled === true || pending === true
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      accessibilityLabel={accessibilityLabel}
      disabled={off}
      onPress={onPress}
      hitSlop={4}
      style={[
        styles.pill,
        filled ? styles.filled : styles.outline,
        !filled && danger && styles.outlineDanger,
        off && styles.off
      ]}
    >
      <Text style={[styles.text, filled ? styles.textFilled : danger ? styles.textDanger : styles.textInk]}>
        {pending ? label + '…' : label}
      </Text>
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  pill: { borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  filled: { backgroundColor: colors.accent, paddingVertical: 9, paddingHorizontal: 17 },
  outline: { borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  outlineDanger: { borderColor: colors.danger },
  off: { opacity: 0.45 },
  text: { ...type.pill },
  textFilled: { color: colors.accentInk },
  textInk: { color: colors.ink },
  textDanger: { color: colors.danger }
})
