// The bottom tab bar, with Cadeiras added in hosted mode. Pressing
// the tab that is already current calls onReselect (scroll to top / refresh),
// not onSelect. `badges` maps a tab id to true to show a plain dot on its icon
// (never a count).

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { colors, layout, type } from './theme'
import { TABS } from '../tabs'

export { TABS, tabsFor } from '../tabs'

export function TabBar ({ current, onSelect, onReselect, badges = {}, tabs = TABS }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { height: layout.tabBar + insets.bottom, paddingBottom: insets.bottom }]} accessibilityRole='tablist'>
      {tabs.map((tab) => {
        const selected = tab.id === current
        const tint = selected ? colors.accent : colors.soft
        const badged = badges[tab.id] === true
        return (
          <Pressable
            key={tab.id}
            accessibilityRole='tab'
            accessibilityState={{ selected }}
            accessibilityLabel={badged ? `${tab.label}, novidades` : tab.label}
            onPress={() => {
              if (selected) {
                if (onReselect) onReselect(tab.id)
              } else {
                onSelect(tab.id)
              }
            }}
            style={styles.tab}
          >
            <View style={styles.iconWrap}>
              <Icon name={tab.icon} size={27} color={tint} />
              {badged && <View style={styles.dot} />}
            </View>
            <Text style={[styles.label, tabs.length === 6 && styles.labelCompact, { color: tint }, selected && styles.labelOn]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{tab.label}</Text>
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
  // Anchors the dot to the icon's corner rather than the whole tab.
  iconWrap: { position: 'relative' },
  // A plain dot: no text, no number.
  dot: {
    position: 'absolute',
    top: 0,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent
  },
  label: { ...type.tab },
  labelCompact: { fontSize: 9, letterSpacing: -0.2 },
  labelOn: { fontWeight: '700' }
})
