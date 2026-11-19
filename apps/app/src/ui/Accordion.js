import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function Accordion ({ title, cueOpen, cueClosed, expanded: shown, onToggle, children }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [own, setOwn] = useState(false)
  // A parent that builds the body only while open (Termos) holds the state and passes expanded and onToggle.
  const expanded = shown ?? own
  const cue = expanded ? cueOpen : cueClosed
  const toggle = () => {
    if (shown == null) setOwn(!expanded)
    if (typeof onToggle === 'function') onToggle(!expanded)
  }

  return (
    <View style={[styles.card, expanded ? styles.open : styles.closed]}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={toggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.title}>{title}</Text>
        {cue ? <Text style={styles.cue}>{cue}</Text> : null}
        <Icon name={expanded ? 'chevron-up' : 'escolher'} size={18} color={colors.soft} />
      </Pressable>
      {expanded ? <View style={styles.body}>{children}</View> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  // Width stays put. Open paints that border with the fill, so the line goes away and the header does not shift.
  card: { borderRadius: radius.bubble, borderWidth: 1 },
  closed: { borderColor: colors.line, backgroundColor: colors.card },
  open: { borderColor: colors.inputOff, backgroundColor: colors.inputOff },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 56, padding: space.lg, gap: space.md },
  pressed: { opacity: 0.8 },
  title: { ...type.rowName, flex: 1, color: colors.ink },
  cue: { ...type.meta, color: colors.soft },
  body: { paddingHorizontal: space.lg, paddingBottom: space.lg }
})
