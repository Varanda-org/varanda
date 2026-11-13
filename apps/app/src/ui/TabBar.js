// The bottom tab bar: icons only, with a pill behind the active icon and
// Comunidades added in hosted mode. The Diario tab shows the person's own
// avatar when `me` is given. Pressing the tab that is already current calls
// onReselect (scroll to top / refresh), not onSelect. `badges` maps a tab id
// to true to show a plain dot on its icon (never a count). Screen readers
// still read each tab's name. No label is drawn.
//
// On the web the bar is dark and opaque in both schemes: under it, the
// installed web app shows the system navigation bar in the manifest's single
// theme_color (#1c2622; a manifest has no light and dark pair), so the two
// match. The native app draws behind the system bar itself and sets its
// buttons for the scheme, so there the bar follows the scheme.

import { useEffect, useRef } from 'react'
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { useReduceMotion } from './StackLayer'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, motion, radius } from './theme'
import { paletteFor } from '../appearance'
import { TABS } from '../tabs'
import { pendingOpen } from '../doubleTap'

export { TABS, tabsFor } from '../tabs'

const alwaysDark = Platform.OS === 'web'
const DARK = paletteFor('dark')
const TAB_ICON = 27
const PILL_WIDTH = 48
const PILL_HEIGHT = 32

// Fades in with the selection. Reduced motion snaps: the pill never travels.
// The JS driver keeps web (no native driver) on the same timing.
function TabPill ({ selected, reduceMotion, style }) {
  const opacity = useRef(new Animated.Value(selected ? 1 : 0)).current
  useEffect(() => {
    const toValue = selected ? 1 : 0
    const duration = reduceMotion ? 0 : motion.fast
    if (duration === 0) {
      opacity.stopAnimation()
      opacity.setValue(toValue)
      return
    }
    const run = Animated.timing(opacity, { toValue, duration, useNativeDriver: false })
    run.start()
    return () => run.stop()
  }, [selected, reduceMotion, opacity])
  return (
    <Animated.View
      pointerEvents='none'
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      style={[style, { opacity }]}
    />
  )
}

export function TabBar ({ current, onSelect, onReselect, badges = {}, tabs = TABS, me }) {
  const themed = useStyles(makeStyles)
  const theme = useTheme()
  const styles = alwaysDark ? webStyles : themed
  const colors = alwaysDark ? DARK : theme.colors
  const reduceMotion = useReduceMotion()
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
            // On touch down too: a finger held past the double tap window
            // would otherwise let the post open under the tab.
            onPressIn={() => pendingOpen.cancel()}
            onPress={() => {
              pendingOpen.cancel()
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
                {!showAvatar && <TabPill selected={selected} reduceMotion={reduceMotion} style={styles.pill} />}
                {showAvatar
                  ? (
                    <View
                      style={[styles.avatarRing, { borderColor: selected ? colors.accent : 'transparent' }]}
                      accessible={false}
                    >
                      <Avatar name={me.name} publicKey={me.publicKey} size={28} picture={me.picture} persist />
                    </View>
                    )
                  : <Icon name={tab.icon} size={TAB_ICON} color={tint} />}
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
    // The 1 pt top border plus 48 pt of tabs make the 49 pt bar (layout.tabBar).
    paddingHorizontal: 8,
    flexDirection: 'row',
    backgroundColor: colors.tabBar,
    borderTopWidth: 1,
    borderTopColor: colors.line
  },
  // 48 pt tall, the full height inside the bar's 1 pt border, so the whole
  // strip under each icon is a tap target (Apple HIG: at least 44 pt).
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: layout.tabBar - 1 },
  // Anchors the dot to the icon's corner rather than the whole tab.
  iconWrap: { position: 'relative' },
  // 48 by 32 pt, centred on the icon: it stays inside the 48 pt tab, including
  // six tabs on a 320 pt screen. Absolute, so the tap target does not shrink.
  // Offsets from the icon's own size: on iOS and Android a 50% inset with a
  // negative margin left the pill shifted right by half its width.
  pill: {
    position: 'absolute',
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    left: (TAB_ICON - PILL_WIDTH) / 2,
    top: (TAB_ICON - PILL_HEIGHT) / 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft
  },
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
