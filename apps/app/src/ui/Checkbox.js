import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { layout, radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function CheckboxMark ({ checked, disabled }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
      style={[styles.box, checked ? styles.checked : styles.unchecked, disabled && styles.disabled]}
    >
      {checked ? <Icon name='ok' size={16} color={colors.accentInk} /> : null}
    </View>
  )
}

export function CheckRow ({ checked, label, onPress, disabled = false }) {
  const styles = useStyles(makeStyles)

  // React Native Web's Pressable handles Space only for button-like roles.
  const onKeyDown = (e) => {
    if (disabled || (e.key !== ' ' && e.key !== 'Spacebar')) return
    e.preventDefault()
    // A held Space repeats keydown. Swallow the repeat so one press toggles once.
    if (e.repeat) return
    if (typeof onPress === 'function') onPress()
  }

  return (
    <Pressable
      accessibilityRole='checkbox'
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      onKeyDown={onKeyDown}
      style={[styles.row, disabled && styles.rowOff]}
    >
      <CheckboxMark checked={checked} />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  box: { width: 24, height: 24, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  unchecked: { backgroundColor: colors.card, borderColor: colors.controlOff, borderWidth: 2 },
  checked: { backgroundColor: colors.accent },
  disabled: { opacity: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit },
  // As in SwitchRow, the whole row fades, so the mark inside it does not fade a second time.
  rowOff: { opacity: 0.45 },
  label: { ...type.postText, color: colors.ink, flexShrink: 1 }
})
