import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export function Chip ({ label, selected = false, onPress, disabled = false, icon, role = 'button', accessibilityLabel }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const radio = role === 'radio'

  // React Native Web's Pressable does not activate radio roles on Space.
  const onRadioKeyDown = (event) => {
    if (event.key !== ' ' && event.key !== 'Spacebar') return
    event.preventDefault()
    if (!event.repeat) onPress?.()
  }

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={radio ? { checked: selected, disabled } : { selected, disabled }}
      aria-checked={radio ? selected : undefined}
      aria-pressed={radio ? undefined : selected}
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      onKeyDown={radio && !disabled ? onRadioKeyDown : undefined}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <View style={[styles.chip, selected && styles.chipOn]}>
        {icon ? <Icon name={icon} size={16} color={selected ? colors.bg : colors.ink} /> : null}
        <Text style={[styles.label, selected && styles.labelOn]} numberOfLines={1}>{label}</Text>
      </View>
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  hit: { minHeight: layout.hit, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.45 },
  chip: {
    minHeight: 32,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    flexDirection: 'row',
    alignItems: 'center',
    // A caller's minimum width (EventCard answers) keeps the label centred.
    justifyContent: 'center',
    gap: space.xs
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  label: { ...type.pill, color: colors.ink, flexShrink: 1 },
  labelOn: { color: colors.bg }
})
