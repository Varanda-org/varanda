// The floating "publicar" button above the tab bar.

import { Animated, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChromeMotion } from './chromeMotion'
import { chromeHiddenProps } from '../chromeScroll'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { elevation, layout } from './theme'

export function Fab ({ onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { progress, hidden, show } = useChromeMotion()
  const offset = insets.bottom + layout.tabBar + layout.fabAboveTabs
  // Leaves with the tab bar: its own offset plus the fab's height.
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, offset + layout.fabSize] })
  const hiddenProps = hidden ? chromeHiddenProps(show) : null
  return (
    <Animated.View
      {...hiddenProps}
      pointerEvents={hidden ? 'none' : 'box-none'}
      style={[styles.layer, { transform: [{ translateY }] }]}
    >
      <PressScale
        accessibilityRole='button'
        accessibilityLabel='publicar'
        onPress={onPress}
        style={({ pressed }) => [styles.fab, { bottom: insets.bottom + layout.tabBar + layout.fabAboveTabs }, pressed && styles.pressed]}
      >
        <Icon name='lapis' size={26} color={colors.accentInk} />
      </PressScale>
    </Animated.View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  fab: {
    position: 'absolute',
    right: layout.fabRight,
    width: layout.fabSize,
    height: layout.fabSize,
    borderRadius: layout.fabSize / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    // react-native 0.83 (new architecture) accepts the CSS string;
    // react-native-web maps it to CSS box-shadow.
    boxShadow: `${elevation.raised} ${colors.shadow}`
  },
  pressed: { opacity: 0.85 }
})
