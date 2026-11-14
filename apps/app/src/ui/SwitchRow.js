import { useId } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { tap } from './haptics'
import { layout, space, type } from './theme'
import { useStyles } from './ThemeProvider'

export function SwitchRow ({ label, caption, value = false, onValueChange, disabled = false }) {
  const styles = useStyles(makeStyles)
  const captionId = useId()
  const off = disabled || typeof onValueChange !== 'function'
  function change (next) {
    if (off || next === value) return
    tap('select')
    onValueChange(next)
  }
  // react-native-web only presses button roles on Space.
  const keys = !off
    ? (e) => {
        if (e.key !== ' ' && e.key !== 'Spacebar') return
        e.preventDefault()
        if (e.repeat) return
        change(!value)
      }
    : undefined
  return (
    <Pressable
      accessible
      accessibilityRole='switch'
      accessibilityLabel={label}
      accessibilityHint={caption}
      aria-describedby={caption ? captionId : undefined}
      accessibilityState={{ checked: value, disabled: off }}
      aria-checked={value}
      aria-disabled={off}
      disabled={off}
      onPress={() => change(!value)}
      onKeyDown={keys}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, off && styles.off]}
    >
      <View style={styles.copy}>
        <Text style={styles.label}>{label}</Text>
        {caption ? <Text nativeID={captionId} style={styles.caption}>{caption}</Text> : null}
      </View>
      <View style={[styles.track, value && styles.trackOn]} pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
        <View style={styles.thumb} />
      </View>
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, padding: space.lg },
  copy: { flex: 1, minWidth: 0, gap: space.xs },
  label: { ...type.postText, color: colors.ink },
  caption: { ...type.replyMark, color: colors.soft },
  track: { width: 51, height: 31, borderRadius: 16, padding: 2, justifyContent: 'center', alignItems: 'flex-start', backgroundColor: colors.line },
  trackOn: { alignItems: 'flex-end', backgroundColor: colors.accent },
  thumb: { width: 27, height: 27, borderRadius: 14, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  pressed: { backgroundColor: colors.skeleton },
  off: { opacity: 0.45 }
})
