import { StyleSheet, View } from 'react-native'
import { radius, space } from './theme'
import { useStyles } from './ThemeProvider'

export function ProgressBar ({ value, height = space.sm, trackColor }) {
  const styles = useStyles(makeStyles)
  // A non-finite percent is dropped, and the stretched fill then paints the whole track.
  const fraction = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  return (
    <View style={[styles.track, { height }, trackColor === undefined ? null : { backgroundColor: trackColor }]}>
      <View style={[styles.fill, { width: (fraction * 100) + '%' }]} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  track: { borderRadius: radius.pill, backgroundColor: colors.inputOff, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.accent }
})
