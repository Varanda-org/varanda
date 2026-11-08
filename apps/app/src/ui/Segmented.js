// Full-width underline tabs (Fotos, Posts, ...). One is selected, marked by a
// 2 pt accent line; each tab is a 44 pt tall touch target.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useStyles } from './ThemeProvider'
import { layout, space, type } from './theme'

// options: [{ id, label }]
export function Segmented ({ options, selected, onSelect }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(options) ? options : []
  return (
    <View style={styles.wrap} accessibilityRole='tablist'>
      {list.map((option) => {
        const on = option.id === selected
        return (
          <Pressable
            key={option.id}
            accessibilityRole='tab'
            accessibilityState={{ selected: on }}
            aria-selected={on}
            accessibilityLabel={option.label}
            onPress={() => onSelect(option.id)}
            style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && styles.pressed]}
          >
            <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1} maxFontSizeMultiplier={1.5}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line },
  tab: { flex: 1, minHeight: layout.hit, paddingHorizontal: space.sm, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
  tabOn: { borderBottomColor: colors.accent },
  pressed: { opacity: 0.6 },
  label: { ...type.pill, color: colors.soft },
  labelOn: { color: colors.ink, fontWeight: '700' }
})
