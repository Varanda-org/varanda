import { StyleSheet, View } from 'react-native'
import { useStyles } from './ThemeProvider'

const DOT_SIZE = 6

export function Badge ({ color } = {}) {
  const styles = useStyles(makeStyles)
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
      style={[styles.dot, color === undefined ? null : { backgroundColor: color }]}
    />
  )
}

const makeStyles = (colors) => StyleSheet.create({
  dot: { width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2, backgroundColor: colors.accent }
})
