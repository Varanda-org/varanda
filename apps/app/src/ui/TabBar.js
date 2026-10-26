// The bottom tab bar: A Rua, Espiadinha, Seguindo and Diário. Pressing the tab
// that is already current calls onReselect (scroll to top / refresh), not
// onSelect.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { colors, layout, type } from './theme'

export const TABS = [
  { id: 'rua', label: 'A Rua', icon: 'casa' },
  { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
  { id: 'seguindo', label: 'Seguindo', icon: 'gente' },
  { id: 'diario', label: 'Diário', icon: 'pessoa' }
]

export function TabBar ({ current, onSelect, onReselect }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { height: layout.tabBar + insets.bottom, paddingBottom: insets.bottom }]} accessibilityRole='tablist'>
      {TABS.map((tab) => {
        const selected = tab.id === current
        const tint = selected ? colors.accent : colors.soft
        return (
          <Pressable
            key={tab.id}
            accessibilityRole='tab'
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (selected) {
                if (onReselect) onReselect(tab.id)
              } else {
                onSelect(tab.id)
              }
            }}
            style={styles.tab}
          >
            <Icon name={tab.icon} size={27} color={tint} />
            <Text style={[styles.label, { color: tint }, selected && styles.labelOn]} numberOfLines={1}>{tab.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // 6 + icon 27 + gap 3 + label 12 + the 1 pt top border = 49.
    paddingTop: 6,
    paddingHorizontal: 8,
    flexDirection: 'row',
    backgroundColor: colors.tabBar,
    borderTopWidth: 1,
    borderTopColor: colors.line
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  label: { ...type.tab },
  labelOn: { fontWeight: '700' }
})
