// The bottom tab bar: icons only, with Comunidades added in hosted mode. The
// Diario tab shows the person's own avatar when `me` is given. Pressing
// the tab that is already current calls onReselect (scroll to top / refresh),
// not onSelect. `badges` maps a tab id to true to show a plain dot on its icon
// (never a count). Screen readers still read each tab's name.

import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout } from './theme'
import { TABS } from '../tabs'

export { TABS, tabsFor } from '../tabs'

export function TabBar ({ current, onSelect, onReselect, badges = {}, tabs = TABS, me }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { height: layout.tabBar + insets.bottom, paddingBottom: insets.bottom }]} accessibilityRole='tablist'>
      {tabs.map((tab) => {
        const selected = tab.id === current
        const tint = selected ? colors.accent : colors.soft
        const badged = badges[tab.id] === true
        const showAvatar = tab.id === 'diario' && me && me.publicKey
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
              {showAvatar
                ? (
                  <View
                    style={[styles.avatarRing, { borderColor: selected ? colors.accent : 'transparent' }]}
                    accessible={false}
                  >
                    <Avatar name={me.name} publicKey={me.publicKey} size={28} picture={me.picture} persist />
                  </View>
                  )
                : <Icon name={tab.icon} size={27} color={tint} />}
              {badged && <View style={styles.dot} />}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // 6 top padding + 1 pt top border + 42 pt for the centred 27 pt icon = 49.
    paddingTop: 6,
    paddingHorizontal: 8,
    flexDirection: 'row',
    backgroundColor: colors.tabBar,
    borderTopWidth: 1,
    borderTopColor: colors.line
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Anchors the dot to the icon's corner rather than the whole tab.
  iconWrap: { position: 'relative' },
  // The border is always 2 pt (transparent when not selected) so the size never shifts.
  avatarRing: { borderWidth: 2, borderRadius: 16 },
  // A plain dot: no text, no number.
  dot: {
    position: 'absolute',
    top: 0,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent
  }
})
