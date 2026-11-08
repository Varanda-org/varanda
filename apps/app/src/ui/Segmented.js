// Full-width underline tabs (Fotos, Posts, ...). One is selected, marked by a
// 2 pt accent line; each tab is a 44 pt tall touch target.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useStyles } from './ThemeProvider'
import { layout, space, type } from './theme'

// options: [{ id, label }]. Three tabs at large text get narrow. Shrinking
// fits each label on its own, so three tabs would show three sizes: with
// three or more the text scale is capped lower (segmentedCap) so all fit at
// one size on a 390 pt phone, and shrinking down to 70% is only the narrow
// phone fallback, never '…'.
export const SEGMENTED_CAP_TWO = 1.5
export const SEGMENTED_CAP_MANY = 1.2

export function segmentedCap (count) {
  return count >= 3 ? SEGMENTED_CAP_MANY : SEGMENTED_CAP_TWO
}

export function Segmented ({ options, selected, onSelect }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(options) ? options : []
  const cap = segmentedCap(list.length)
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
            <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1} maxFontSizeMultiplier={cap} adjustsFontSizeToFit minimumFontScale={0.7}>{option.label}</Text>
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
  // A shrunk label stays centred in the tab instead of riding low.
  label: { ...type.pill, color: colors.soft, textAlign: 'center', textAlignVertical: 'center', includeFontPadding: false },
  labelOn: { color: colors.ink, fontWeight: '700' }
})
