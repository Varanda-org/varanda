import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { layout, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function NoteBar ({ text, icon, action, onClose, closeLabel = 'Fechar', hitSlop, style, accessibilityRole, accessibilityLiveRegion, role, 'aria-live': ariaLive = accessibilityLiveRegion }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const pending = action?.pending === true
  const pendingLabel = pending ? action.pendingLabel : undefined
  const actionText = action ? pendingLabel ?? action.label + (pending ? '…' : '') : undefined
  return (
    <View
      style={style ? [styles.note, style] : styles.note}
      accessibilityRole={accessibilityRole}
      accessibilityLiveRegion={accessibilityLiveRegion}
      role={role}
      aria-live={ariaLive}
    >
      {icon
        ? (
          <View accessible={false} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
            <Icon name={icon} size={18} color={colors.soft} />
          </View>
          )
        : null}
      <View style={styles.content}>
        <Text style={styles.text}>{text}</Text>
        {action
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={action.accessibilityLabel ?? actionText}
              hitSlop={hitSlop}
              accessibilityState={{ disabled: pending, busy: pending }}
              aria-disabled={pending}
              aria-busy={pending}
              disabled={pending}
              onPress={pending ? undefined : action.onPress}
              style={({ pressed }) => [styles.action, pressed && styles.pressed, pending && styles.off]}
            >
              <Text style={styles.actionText}>{actionText}</Text>
            </Pressable>
            )
          : null}
      </View>
      {onClose
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={closeLabel}
            hitSlop={hitSlop}
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <Icon name='fechar' size={18} color={colors.soft} />
          </Pressable>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  note: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.xs, backgroundColor: colors.warm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  content: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm },
  text: { ...type.replyMark, color: colors.soft, flexGrow: 1, flexShrink: 1 },
  // The 44 pt targets reach into the bar's own padding, so a bar with a button
  // is 44 pt tall, not 44 plus the padding.
  action: { minHeight: layout.hit, marginVertical: -space.xs, maxWidth: '100%', justifyContent: 'center' },
  actionText: { ...type.replyMark, color: colors.accent, fontWeight: '700', flexShrink: 1 },
  close: { minWidth: layout.hit, minHeight: layout.hit, marginVertical: -space.xs, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.65 },
  off: { opacity: 0.45 }
})
