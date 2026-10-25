// One step of a multi-step flow: "Passo N de T", progress dots, a title, a
// hint and the step's content. Presentational only; callers pass text that
// is already safe to render.

import { StyleSheet, Text, View } from 'react-native'
import { Soft } from './index'
import { colors, fonts, layout, type } from './theme'

export function Stepper ({ index, total, title, hint, children }) {
  const dots = []
  for (let i = 0; i < total; i++) {
    dots.push(<View key={i} style={[styles.dot, i === index ? styles.dotActive : i < index ? styles.dotDone : styles.dotPending]} />)
  }
  return (
    <View style={styles.column}>
      <Text style={styles.step}>{'Passo ' + (index + 1) + ' de ' + total}</Text>
      <View style={styles.dots} accessible={false} importantForAccessibility='no-hide-descendants'>{dots}</View>
      <Text style={styles.title} accessibilityRole='header'>{title}</Text>
      {hint ? <Soft>{hint}</Soft> : null}
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center', padding: 16, gap: 12 },
  step: { ...type.stepLabel, color: colors.soft },
  dots: { flexDirection: 'row', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { backgroundColor: colors.accent },
  dotDone: { backgroundColor: colors.accent, opacity: 0.5 },
  dotPending: { backgroundColor: colors.line },
  title: { ...type.profileName, color: colors.ink, fontFamily: fonts.title }
})
