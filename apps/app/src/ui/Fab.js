// The floating "publicar" button above the tab bar.

import { Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout } from './theme'

export function Fab ({ onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel='publicar'
      onPress={onPress}
      style={({ pressed }) => [
        styles.fab,
        { bottom: insets.bottom + layout.tabBar + layout.fabAboveTabs },
        pressed && styles.pressed
      ]}
    >
      <Icon name='lapis' size={26} color={colors.accentInk} />
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
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
    boxShadow: '0px 6px 16px rgba(29,107,79,0.35)'
  },
  pressed: { opacity: 0.85 }
})
