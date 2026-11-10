// The welcome screen's quiet other sign-in options run directly in the tap:
// Safari user activation requires passkey ceremonies to start there, never
// after a close or timer. The action sheet defers actions until it closes.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { layout, radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function OptionsToggle ({ label, open, onPress, disabled }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ expanded: open, disabled: !!disabled }}
      // react-native-web does not map accessibilityState.expanded.
      aria-expanded={open}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed, disabled && styles.off]}
    >
      <Text style={styles.toggleText}>{label}</Text>
      <Icon name={open ? 'chevron-up' : 'escolher'} size={18} color={colors.accent} />
    </Pressable>
  )
}

export function OptionList ({ children }) {
  const styles = useStyles(makeStyles)
  return <View style={styles.list}>{children}</View>
}

export function OptionRow ({ icon, label, onPress, disabled, pending, first }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const off = disabled === true || pending === true
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.rowPressed, off && styles.off]}
    >
      <Icon name={icon} size={22} color={colors.soft} />
      <Text style={styles.rowText}>{label + (pending ? '…' : '')}</Text>
      <Icon name='seta' size={20} color={colors.soft} />
    </Pressable>
  )
}

export function OptionBlock ({ children, first }) {
  const styles = useStyles(makeStyles)
  return <View style={[styles.block, !first && styles.divider]}>{children}</View>
}

const makeStyles = (colors) => StyleSheet.create({
  toggle: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 4, minHeight: layout.hit, paddingHorizontal: space.md },
  toggleText: { ...type.pill, color: colors.accent },
  togglePressed: { opacity: 0.6 },
  off: { opacity: 0.45 },
  list: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit + space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowPressed: { backgroundColor: colors.skeleton },
  rowText: { fontSize: 16, lineHeight: 22, color: colors.ink, flex: 1 },
  block: { padding: space.lg, gap: space.sm }
})
