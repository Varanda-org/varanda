import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export function Toast ({ text, actionLabel, onAction, style }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={[styles.toast, style]} pointerEvents='box-none'>
      <View pointerEvents='none' style={styles.label}>
        <Text style={styles.text} accessibilityRole='alert'>{text}</Text>
      </View>
      {actionLabel && onAction
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel={actionLabel} onPress={onAction} style={styles.action}>
            <Text style={[styles.text, styles.actionText]}>{actionLabel}</Text>
          </Pressable>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.bubble,
    minHeight: 36,
    // A long text wraps to several lines: the 8 pt keeps it off the edge of the pill.
    paddingVertical: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.md,
    backgroundColor: colors.toastBg,
    borderWidth: 1,
    borderColor: colors.line
  },
  label: { flexShrink: 1 },
  text: { ...type.counter, color: colors.toastInk },
  action: { minWidth: layout.hit, minHeight: layout.hit, marginLeft: space.sm, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontWeight: '800' }
})
