import { StyleSheet, Text, View } from 'react-native'
import { useStyles } from './ThemeProvider'
import { space, type } from './theme'

export function Divider ({ label, inset = 0 }) {
  const styles = useStyles(makeStyles)

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
      style={[label ? styles.labeled : styles.rule, { marginHorizontal: inset }]}
    >
      {label
        ? (
          <>
            <View style={[styles.rule, styles.segment]} />
            <Text style={styles.label}>{label}</Text>
            <View style={[styles.rule, styles.segment]} />
          </>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  rule: { height: 1, backgroundColor: colors.line },
  labeled: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  segment: { flex: 1 },
  label: { ...type.caption, color: colors.soft, flexShrink: 1, textAlign: 'center' }
})
