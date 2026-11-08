// A pill-shaped button: filled (accent) or outlined (ink or danger). `icon`
// sits left of the label; with no label it is a 40 pt round icon-only pill
// (give it an accessibilityLabel). `iconEnd` sits right of the label: the
// chevron of a pill that opens a list of choices. `maxFontSizeMultiplier` caps
// the label, for a pill in a Sheet header whose other controls are capped.

import { Pressable, StyleSheet, Text } from 'react-native'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { type } from './theme'

export function Pill ({ label, icon, iconEnd, onPress, filled, danger, disabled, pending, accessibilityLabel, maxFontSizeMultiplier }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const iconOnly = typeof label !== 'string' || label === ''
  const tint = filled ? colors.accentInk : danger ? colors.danger : colors.ink
  const off = disabled === true || pending === true
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      // A worded pill is read by its label: with an icon beside it a screen
      // reader otherwise joined both (", Mensagem").
      accessibilityLabel={accessibilityLabel || (iconOnly ? undefined : label)}
      disabled={off}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.pill,
        filled ? styles.filled : styles.outline,
        !filled && danger && styles.outlineDanger,
        iconOnly && styles.round,
        off && styles.off,
        pressed && styles.pressed
      ]}
    >
      {typeof icon === 'string' ? <Icon name={icon} size={18} color={tint} /> : null}
      {iconOnly
        ? null
        : (
          <Text style={[styles.text, filled ? styles.textFilled : danger ? styles.textDanger : styles.textInk]} maxFontSizeMultiplier={maxFontSizeMultiplier}>
            {pending ? label + '…' : label}
          </Text>
          )}
      {typeof iconEnd === 'string' && !iconOnly ? <Icon name={iconEnd} size={18} color={tint} /> : null}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  pill: { borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, minHeight: 40 },
  round: { width: 40, height: 40, paddingVertical: 0, paddingHorizontal: 0 },
  // Same height as an outline pill: its 8 padding plus the 1.5 border.
  filled: { backgroundColor: colors.accent, paddingVertical: 9.5, paddingHorizontal: 17 },
  outline: { borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  outlineDanger: { borderColor: colors.danger },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
  // 1 pt sides: Android rounds the exact-fit label inside the 1.5 pt outline and would
  // wrap its last word out of sight (seen on Btn's "Trocar passkey").
  text: { ...type.pill, flexShrink: 1, textAlign: 'center', paddingHorizontal: 1 },
  textFilled: { color: colors.accentInk },
  textInk: { color: colors.ink },
  textDanger: { color: colors.danger }
})
