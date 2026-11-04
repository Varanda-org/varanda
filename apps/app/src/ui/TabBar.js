// The bottom tab bar: icons only, with Comunidades added in hosted mode. The
// Diario tab shows the person's own avatar when `me` is given. Pressing
// the tab that is already current calls onReselect (scroll to top / refresh),
// not onSelect. `badges` maps a tab id to true to show a plain dot on its icon
// (never a count). Screen readers still read each tab's name.
//
// On the web the bar is dark and opaque in both schemes: under it, the
// installed web app shows the system navigation bar in the manifest's single
// theme_color (#1c2622; a manifest has no light and dark pair), so the two
// match. The native app draws behind the system bar itself and sets its
// buttons for the scheme, so there the bar follows the scheme.

import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout } from './theme'
import { paletteFor } from '../appearance'
import { TABS } from '../tabs'

export { TABS, tabsFor } from '../tabs'

const alwaysDark = Platform.OS === 'web'
const DARK = paletteFor('dark')

export function TabBar ({ current, onSelect, onReselect, badges = {}, tabs = TABS, me }) {
  const themed = useStyles(makeStyles)
  const theme = useTheme()
  const styles = alwaysDark ? webStyles : themed
  const colors = alwaysDark ? DARK : theme.colors
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
            android_ripple={{ color: colors.line, borderless: true }}
          >
            {({ pressed }) => (
              <View style={[styles.iconWrap, pressed && styles.pressed]}>
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
            )}
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
  pressed: { opacity: 0.65 },
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

const webStyles = alwaysDark ? makeStyles({ ...DARK, tabBar: DARK.bg }) : null
