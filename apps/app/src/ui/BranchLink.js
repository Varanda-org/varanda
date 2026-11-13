import { Pressable, StyleSheet, Text } from 'react-native'
import { Icon } from './Icon'
import { layout, radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function BranchLink ({ label, onPress, pending, expanded }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const off = pending === true
  const shown = pending ? label + '…' : label
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off, expanded }}
      // react-native-web does not map accessibilityState.expanded.
      aria-expanded={expanded}
      accessibilityLabel={shown}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.hit, off && styles.off, pressed && styles.pressed]}
    >
      <Text style={styles.text}>{shown}</Text>
      {typeof expanded === 'boolean' ? <Icon name='escolher' size={16} color={colors.accent} style={expanded ? styles.flip : null} /> : null}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  // Plain coloured text needs no box.
  // Web ignores hitSlop, so the invisible box itself is the 44 pt target.
  hit: { alignSelf: 'flex-start', maxWidth: '100%', minHeight: layout.hit, minWidth: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.sm },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.6 },
  text: { ...type.more, color: colors.accent, flexShrink: 1 },
  flip: { transform: [{ rotate: '180deg' }] }
})
