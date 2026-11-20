// The profile's destinations as one strip of chips that scrolls sideways and
// never wraps.

import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// items: [{ id, icon, label }]
export function ProfileShortcuts ({ items, onOpen }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps='handled' contentContainerStyle={styles.row}>
        {items.map((item) => (
          <PressScale
            key={item.id}
            onPress={() => onOpen(item.id)}
            accessibilityRole='link'
            accessibilityLabel={item.label}
            style={styles.hit}
          >
            <View style={styles.face}>
              <Icon name={item.icon} size={18} color={colors.accent} />
              <Text style={styles.text} numberOfLines={1}>{item.label}</Text>
            </View>
          </PressScale>
        ))}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { width: '100%', maxWidth: layout.column, alignSelf: 'center' },
  row: { paddingHorizontal: space.xl, paddingVertical: space.sm, gap: space.sm, alignItems: 'center' },
  hit: { minHeight: layout.hit, justifyContent: 'center' },
  face: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs
  },
  text: { ...type.pill, color: colors.ink }
})
