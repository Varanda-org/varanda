// The right corner of the top bar: the help button, then the Avisos bell in
// the corner. The bell shows a plain dot for news (never a count).

import { Pressable, StyleSheet, View } from 'react-native'
import { HelpButton } from './Help'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'

export function BellButton ({ onPress, badged, active, color, style }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const tint = color === undefined ? colors.soft : color
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={badged ? 'Avisos, novidades' : 'Avisos'}
      hitSlop={8}
      onPress={onPress}
      style={style}
    >
      <View style={styles.iconWrap}>
        <Icon name='sino' size={22} color={active ? colors.accent : tint} />
        {badged ? <View style={styles.dot} /> : null}
      </View>
    </Pressable>
  )
}

export function TopActions ({ help, onAvisos, avisosNew, avisosActive }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.row}>
      {help ? <HelpButton doc={help} /> : null}
      {typeof onAvisos === 'function'
        ? <BellButton onPress={onAvisos} badged={avisosNew === true} active={avisosActive === true} />
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Anchors the dot to the icon's corner, as in the tab bar.
  iconWrap: { position: 'relative' },
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
