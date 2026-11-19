// The bottom tab bar: icons only, with a pill behind the active icon and
// Comunidades added in hosted mode. The Diario tab shows the person's own
// avatar when `me` is given. Pressing the tab that is already current calls
// onReselect (scroll to top / refresh), not onSelect. `badges` maps a tab id
// to true to show a plain dot on its icon (never a count). Screen readers
// still read each tab's name. No label is drawn.
//
// The opaque dark pill stays consistent across schemes and matches the
// installed web app's system navigation colour.

import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { tap } from './haptics'
import { Avatar } from './Avatar'
import { Badge } from './Badge'
import { Icon } from './Icon'
import { useChromeMotion } from './chromeMotion'
import { chromeHiddenProps } from '../chromeScroll'
import { useReduceMotion } from './StackLayer'
import { elevation, layout, motion, radius, space } from './theme'
import { paletteFor } from '../appearance'
import { TABS } from '../tabs'
import { pendingOpen } from '../doubleTap'

export { TABS, tabsFor } from '../tabs'

const DARK = paletteFor('dark')
const TAB_ICON = 24

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
  const colors = DARK
  const reduceMotion = useReduceMotion()
  const insets = useSafeAreaInsets()
  const { progress, hidden, show } = useChromeMotion()
  const barHeight = layout.tabBar + insets.bottom
  // Translate, never resize: the layout stays put while the bar slides away.
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, barHeight] })
  const hiddenProps = hidden
    ? { pointerEvents: 'none', ...chromeHiddenProps(show) }
    : null
  return (
    <Animated.View
      pointerEvents='box-none'
      {...hiddenProps}
      style={[styles.bar, { height: barHeight, paddingBottom: insets.bottom + space.lg, transform: [{ translateY }] }]}
      accessibilityRole='tablist'
    >
      <View style={styles.floating}>
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
                  tap('select')
                  onSelect(tab.id)
                }
              }}
              style={styles.tab}
              android_ripple={{ color: colors.line, borderless: true }}
            >
              {({ pressed }) => (
                <>
                  {!showAvatar && <TabPill selected={selected} reduceMotion={reduceMotion} style={styles.pill} />}
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
                      : <Icon name={tab.icon} size={TAB_ICON} color={tint} />}
                    {badged && <View style={styles.dotPosition}><Badge color={colors.accent} /></View>}
                  </View>
                </>
              )}
            </Pressable>
          )
        })}
      </View>
    </Animated.View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    alignItems: 'center'
  },
  floating: {
    height: 62,
    padding: 2,
    width: '100%',
    maxWidth: layout.column,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.tabBar,
    borderWidth: 1,
    borderColor: colors.line,
    boxShadow: elevation.lg
  },
  tab: { flex: 1, height: 58, alignItems: 'center', justifyContent: 'center' },
  // Anchors the dot to the icon's corner rather than the whole tab.
  iconWrap: { position: 'relative' },
  pill: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft
  },
  pressed: { opacity: 0.65 },
  // The border is always 2 pt (transparent when not selected) so the size never shifts.
  avatarRing: { borderWidth: 2, borderRadius: 16 },
  // Badge draws the dot and has no position of its own.
  dotPosition: {
    position: 'absolute',
    top: 0,
    right: -2
  }
})

const styles = makeStyles({ ...DARK, tabBar: DARK.bg })
