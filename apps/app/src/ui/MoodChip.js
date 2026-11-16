// The mood of the day: an emoji and a short text in a chip, with how long it
// stays up. `mood` comes from moodView (already through displayText). With
// onPress (the own profile) the chip opens the editor and is a 44 pt target.

import { StyleSheet, Text, View } from 'react-native'
import { moodLabel, moodRemaining } from '../profileExtraView.js'
import { themeColors } from '../profileThemes.js'
import { PressScale } from './PressScale'
import { layout, radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function MoodChip ({ mood, now, theme = null, onPress }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  if (!mood) return null
  const c = theme === null ? null : themeColors(theme, scheme)
  const left = moodRemaining(mood, now)
  const label = 'Humor do dia: ' + moodLabel(mood) + (left ? ', ' + left : '')
  const body = (
    <View style={[styles.chip, c !== null && { backgroundColor: c.tint }]}>
      {mood.emoji ? <Text style={styles.emoji}>{mood.emoji}</Text> : null}
      <View style={styles.texts}>
        {mood.text ? <Text style={[styles.text, c !== null && { color: c.bandInk }]}>{mood.text}</Text> : null}
        {left ? <Text style={[styles.left, c !== null && { color: c.bandInk }]}>{left}</Text> : null}
      </View>
    </View>
  )
  if (typeof onPress !== 'function') return <View accessible accessibilityLabel={label} style={styles.wrap}>{body}</View>
  return (
    <PressScale accessibilityRole='button' accessibilityLabel={label} accessibilityHint='Editar o humor do dia' onPress={onPress} style={styles.wrap}>
      {body}
    </PressScale>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { alignSelf: 'flex-start', maxWidth: '100%', minHeight: layout.hit, justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.warm, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.md, maxWidth: '100%' },
  emoji: { fontSize: 20, lineHeight: 26 },
  texts: { flexShrink: 1 },
  text: { ...type.postName, color: colors.ink },
  left: { ...type.caption, color: colors.soft }
})
