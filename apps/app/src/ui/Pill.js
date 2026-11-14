// A pill-shaped button: filled (accent), tonal (soft ink on a quiet fill) or
// outlined (ink or danger). `icon` sits left of the label; with no label it is
// a round icon-only pill, 40 pt, or 32 pt when `small` (give it an
// accessibilityLabel). `iconEnd` sits right of the label: the chevron of a
// pill that opens a list of choices.
// `maxFontSizeMultiplier` caps the label, for a pill in a Sheet header whose
// other controls are capped. `iconFilled` draws the icon's solid shape (a
// saved star), so the state is not shown by colour alone.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { PRESSED_OPACITY } from '../pressMotion'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, type } from './theme'

export function Pill ({ label, icon, iconFilled, iconEnd, onPress, filled, danger, disabled, pending, accessibilityLabel, maxFontSizeMultiplier, tonal, small }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const iconOnly = typeof label !== 'string' || label === ''
  const flat = tonal === true && !filled
  const tint = filled ? colors.accentInk : flat ? colors.soft : danger ? colors.danger : colors.ink
  const off = disabled === true || pending === true
  const face = [
    styles.pill,
    filled ? styles.filled : flat ? styles.tonal : styles.outline,
    !filled && !flat && danger && styles.outlineDanger,
    iconOnly && styles.round,
    small && styles.small,
    small && iconOnly && styles.smallRound
  ]
  const content = (
    <>
      {typeof icon === 'string' ? <Icon name={icon} size={18} color={tint} filled={iconFilled === true} /> : null}
      {iconOnly
        ? null
        : (
          <Text style={[styles.text, small && styles.textSmall, filled ? styles.textFilled : flat ? styles.textTonal : danger ? styles.textDanger : styles.textInk]} maxFontSizeMultiplier={maxFontSizeMultiplier}>
            {pending ? label + '…' : label}
          </Text>
          )}
      {typeof iconEnd === 'string' && !iconOnly ? <Icon name={iconEnd} size={18} color={tint} /> : null}
    </>
  )
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      // A worded pill is read by its label: with an icon beside it a screen
      // reader otherwise joined both (", Mensagem").
      accessibilityLabel={accessibilityLabel || (iconOnly ? undefined : label)}
      disabled={off}
      onPress={onPress}
      hitSlop={small ? undefined : 4}
      style={({ pressed }) => [
        small ? styles.smallHit : face,
        off && styles.off,
        pressed && styles.pressed
      ]}
    >
      {small ? <View style={face}>{content}</View> : content}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  pill: { borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, minHeight: 40 },
  round: { width: 40, height: 40, paddingVertical: 0, paddingHorizontal: 0 },
  // Same height as an outline pill: its 8 padding plus the 1.5 border.
  filled: { backgroundColor: colors.accent, paddingVertical: 9.5, paddingHorizontal: 17 },
  outline: { borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  tonal: { backgroundColor: colors.inputOff, paddingVertical: 9.5, paddingHorizontal: 17 },
  outlineDanger: { borderColor: colors.danger },
  small: { minHeight: 32, paddingVertical: 0, paddingHorizontal: 12 },
  smallRound: { width: 32, height: 32, minHeight: 32, paddingVertical: 0, paddingHorizontal: 0 },
  // The pressable is layout.hit because the web ignores hitSlop, so a 32 pt
  // face cannot grow to the 44 pt target that way.
  smallHit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.45 },
  pressed: { opacity: PRESSED_OPACITY },
  // 1 pt sides: Android rounds the exact-fit label inside the 1.5 pt outline and would
  // wrap its last word out of sight (seen on Btn's "Trocar passkey").
  text: { ...type.pill, flexShrink: 1, textAlign: 'center', paddingHorizontal: 1 },
  textSmall: { fontSize: 13, lineHeight: 16 },
  textFilled: { color: colors.accentInk },
  textTonal: { color: colors.soft },
  textInk: { color: colors.ink },
  textDanger: { color: colors.danger }
})
