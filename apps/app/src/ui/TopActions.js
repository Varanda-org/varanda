// The right corner of the top bar: the help button, then the Avisos bell in
// the corner. The bell shows a plain dot for news (never a count). IconAction
// is the 44 pt icon button a screen's TopBar draws for each { icon, label,
// onPress, badge } it passes as `right`.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { HelpButton } from './Help'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout } from './theme'

export function BellButton ({ onPress, badged, active, color, style }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const tint = color === undefined ? colors.soft : color
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={badged ? 'Avisos, novidades' : 'Avisos'}
      // A caller's own style (Diário's 34 pt band discs) keeps its size and
      // reaches 44 pt through hitSlop; in the bar the button itself is 44 pt.
      hitSlop={style ? 5 : undefined}
      onPress={onPress}
      style={({ pressed }) => [style || styles.hit, pressed && styles.pressed]}
    >
      <View style={styles.iconWrap}>
        <Icon name='sino' size={22} color={active ? colors.accent : tint} />
        {badged ? <View style={styles.dot} /> : null}
      </View>
    </Pressable>
  )
}

// `badge`: true draws a dot, a positive number a count (99+ past that). The
// label says the same, since a screen reader never sees the dot.
export function IconAction ({ icon, label, onPress, badge, color, disabled }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const count = Number.isSafeInteger(badge) && badge > 0 ? badge : 0
  const dot = badge === true
  const countText = count > 99 ? '99+' : String(count)
  const spoken = typeof label === 'string' ? label + (count > 0 ? ', ' + countText : dot ? ', novidades' : '') : undefined
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={spoken}
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled === true}
      onPress={onPress}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <View style={styles.iconWrap}>
        <Icon name={icon} size={24} color={color === undefined ? colors.ink : color} />
        {count > 0
          ? <View style={styles.count}><Text style={styles.countText} numberOfLines={1}>{countText}</Text></View>
          : dot ? <View style={styles.dot} /> : null}
      </View>
    </Pressable>
  )
}

export function TopActions ({ help, onAvisos, avisosNew, avisosActive }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.row}>
      {help ? <HelpButton doc={help} /> : null}
      {typeof onAvisos === 'function'
        ? <BellButton onPress={onAvisos} badged={avisosNew === true} active={avisosActive === true} />
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  hit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  // Anchors the dot to the icon's corner, as in the tab bar.
  iconWrap: { position: 'relative' },
  dot: {
    position: 'absolute',
    top: 0,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent
  },
  count: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent
  },
  countText: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: colors.accentInk }
})
