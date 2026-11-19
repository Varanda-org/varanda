// The welcome screen's quiet other sign-in options run directly in the tap:
// Safari user activation requires passkey ceremonies to start there, never
// after a close or timer. The action sheet defers actions until it closes.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { ListGroup, ListRow } from './ListRow'
import { layout, space, type } from './theme'
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
  return <ListGroup>{children}</ListGroup>
}

export function OptionRow ({ icon, label, onPress, disabled, pending, first }) {
  return <ListRow icon={icon} label={label} onPress={onPress} disabled={disabled} pending={pending} first={first} />
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
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  block: { padding: space.lg, gap: space.sm }
})
