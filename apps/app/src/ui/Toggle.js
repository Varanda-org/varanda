import { StyleSheet, View } from 'react-native'
import { radius } from './theme'
import { useStyles } from './ThemeProvider'

// The row owns the switch role, so a role here would be a second control.
// The row also fades a disabled switch, so the track has no fade of its own.
export function ToggleTrack ({ on }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={[styles.track, on && styles.trackOn]}>
      <View style={styles.knob} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  track: { width: 44, height: 28, borderRadius: radius.pill, padding: 3, justifyContent: 'center', alignItems: 'flex-start', backgroundColor: colors.controlOff },
  trackOn: { alignItems: 'flex-end', backgroundColor: colors.accent },
  knob: { width: 22, height: 22, borderRadius: radius.pill, backgroundColor: colors.card }
})
