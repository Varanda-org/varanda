// A pill-shaped button: filled (accent), tonal (soft ink on a quiet fill) or
// outlined (ink or danger). `icon` sits left of the label; with no label it is
// a round icon-only pill, 44 pt, or 36 pt when `small` (give it an
// accessibilityLabel). `iconEnd` sits right of the label: the chevron of a
// pill that opens a list of choices.
// `maxFontSizeMultiplier` caps the label, for a pill in a Sheet header whose
// other controls are capped. `iconFilled` draws the icon's solid shape (a
// saved star), so the state is not shown by colour alone. `selected` (a
// boolean) is announced as the pill's selected state, for a pill that is one
// choice of a few (the filled face alone says it to the eye only).

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { PRESSED_OPACITY } from '../pressMotion'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space, type } from './theme'

export function Pill ({ label, icon, iconFilled, iconEnd, onPress, filled, danger, disabled, pending, accessibilityLabel, maxFontSizeMultiplier, weak, link, tonal, selected, small }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const iconOnly = typeof label !== 'string' || label === ''
  const flat = tonal === true && !filled
  const tint = filled ? colors.accentInk : weak || link ? colors.accent : danger ? colors.danger : flat ? colors.soft : colors.ink
  const off = disabled === true || pending === true
  const face = [
    styles.pill,
    filled ? styles.filled : weak ? styles.weak : link ? styles.link : flat ? [styles.tonal, danger && styles.tonalDanger] : styles.outline,
    !filled && !weak && !link && !flat && danger && styles.outlineDanger,
    iconOnly && styles.round,
    small && styles.small,
    small && iconOnly && styles.smallRound
  ]
  const content = (
    <>
      {typeof icon === 'string' ? <Icon name={icon} size={small ? 16 : 18} color={tint} filled={iconFilled === true} style={pending && styles.hidden} /> : null}
      {iconOnly
        ? null
        : (
          <Text style={[styles.text, small && styles.textSmall, filled ? styles.textFilled : weak || link ? styles.textAccent : danger ? styles.textDanger : flat ? styles.textTonal : styles.textInk, pending && styles.hidden]} maxFontSizeMultiplier={maxFontSizeMultiplier}>
            {label}
          </Text>
          )}
      {typeof iconEnd === 'string' && !iconOnly ? <Icon name={iconEnd} size={small ? 16 : 18} color={tint} style={pending && styles.hidden} /> : null}
      {pending ? <View style={styles.loading} pointerEvents='none' aria-hidden accessibilityElementsHidden importantForAccessibility='no-hide-descendants'><ActivityIndicator size='small' color={tint} /></View> : null}
    </>
  )
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={selected === undefined ? { disabled: off, busy: pending === true } : { disabled: off, busy: pending === true, selected: selected === true }}
      // react-native-web drops accessibilityState, so the web reads a pressed
      // state (on a button `aria-selected` does not count) and aria-busy.
      aria-pressed={selected === undefined ? undefined : selected === true}
      aria-busy={pending === true ? true : undefined}
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
  pill: { borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, minHeight: 44 },
  round: { width: 44, height: 44, paddingVertical: 0, paddingHorizontal: 0 },
  // Same height as an outline pill: its 8 padding plus the 1.5 border.
  filled: { backgroundColor: colors.accent, paddingVertical: 9.5, paddingHorizontal: 17 },
  weak: { backgroundColor: colors.accentSoft, paddingVertical: 9.5, paddingHorizontal: 17 },
  link: { paddingHorizontal: space.md, minWidth: layout.hit, minHeight: layout.hit },
  outline: { borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  // Keep tonal as Neutral Weak so existing callers need no new prop.
  tonal: { backgroundColor: colors.inputOff, paddingVertical: 9.5, paddingHorizontal: 17 },
  tonalDanger: { backgroundColor: colors.dangerSoft },
  outlineDanger: { borderColor: colors.danger },
  small: { minHeight: 36, paddingVertical: 0, paddingHorizontal: 12 },
  smallRound: { width: 36, height: 36, minHeight: 36, paddingVertical: 0, paddingHorizontal: 0 },
  // The pressable is layout.hit because the web ignores hitSlop, so a 36 pt
  // face cannot grow to the 44 pt target that way.
  smallHit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.45 },
  pressed: { opacity: PRESSED_OPACITY },
  // Retain the content's dimensions while the spinner sits over the face.
  hidden: { opacity: 0 },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // 1 pt sides: Android rounds the exact-fit label inside the 1.5 pt outline and would
  // wrap its last word out of sight (seen on Btn's "Trocar passkey").
  text: { ...type.rowName, flexShrink: 1, textAlign: 'center', paddingHorizontal: 1 },
  textSmall: { fontSize: 14, lineHeight: 20 },
  textFilled: { color: colors.accentInk },
  textAccent: { color: colors.accent },
  textTonal: { color: colors.soft },
  textInk: { color: colors.ink },
  textDanger: { color: colors.danger }
})
