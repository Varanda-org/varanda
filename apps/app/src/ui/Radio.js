import { StyleSheet, View } from 'react-native'
import { useStyles } from './ThemeProvider'

export function RadioMark ({ checked, disabled }) {
  const styles = useStyles(makeStyles)

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
      style={[styles.circle, checked ? styles.checked : styles.unchecked, disabled && styles.disabled]}
    >
      {checked ? <View style={styles.dot} /> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  circle: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  unchecked: { backgroundColor: colors.card, borderColor: colors.controlOff, borderWidth: 2 },
  checked: { backgroundColor: colors.accent },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accentInk },
  disabled: { opacity: 0.4 }
})
