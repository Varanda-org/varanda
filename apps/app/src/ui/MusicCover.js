import { StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { radius } from './theme'

// The tile is generated on the device: a cover is never stored and never
// fetched from the provider.
export function MusicCover ({ size = 48, uri, label = 'Capa da música' }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View
      style={[styles.tile, { width: size, height: size, borderRadius: size >= 96 ? radius.md : radius.sm }]}
      accessibilityLabel={displayText(label)}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      aria-hidden
    >
      <Icon name='musica' size={Math.round(size * 0.42)} color={colors.soft} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: colors.skeleton }
})
