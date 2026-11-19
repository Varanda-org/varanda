import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Divider } from './Divider'
import { Icon } from './Icon'
import { RadioMark } from './Radio'
import { useStyles, useTheme } from './ThemeProvider'
import { radius, space, type } from './theme'

export function ListRow ({ icon, label, caption, trailing = 'seta', trailingText, checked, expanded, onPress, role = 'button', disabled = false, pending = false, danger, first, accessibilityLabel, action }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const off = disabled || pending
  const choice = role === 'radio' || role === 'switch' || role === 'checkbox'
  // The mark and the announced state follow the role together: a choice row
  // always has both, any other row neither.
  const checkedState = choice ? checked === true : undefined
  const expandedState = role === 'button' ? expanded : undefined
  const endText = choice ? undefined : trailingText
  const rowLabel = accessibilityLabel ?? [label, caption, endText].filter((text) => text != null && text !== '').join(', ')

  // React Native Web's Pressable does not activate these roles on Space.
  const onChoiceKeyDown = (event) => {
    if (event.key !== ' ' && event.key !== 'Spacebar') return
    event.preventDefault()
    if (!event.repeat) onPress?.()
  }

  let end = null
  if (choice) {
    end = <RadioMark checked={checkedState} />
  } else if (endText != null) {
    end = <Text style={styles.trailing}>{endText}</Text>
  } else if (trailing) {
    end = <Icon name={trailing} size={20} color={colors.soft} />
  }

  return (
    <View>
      {first ? null : <Divider />}
      <View style={styles.lineup}>
        <Pressable
          accessibilityRole={role}
          accessibilityLabel={rowLabel}
          accessibilityState={{ checked: checkedState, expanded: expandedState, disabled: off, busy: pending }}
          aria-checked={checkedState}
          aria-expanded={expandedState}
          aria-disabled={off}
          aria-busy={pending}
          disabled={off}
          onPress={off ? undefined : onPress}
          onKeyDown={choice && !off ? onChoiceKeyDown : undefined}
          style={({ pressed }) => [styles.row, caption && styles.withCaption, pressed && styles.pressed, off && styles.off]}
        >
          {icon
            ? (
              <View style={styles.icon} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
                <Icon name={icon} size={22} color={danger ? colors.danger : colors.soft} />
              </View>
              )
            : null}
          <View style={styles.copy}>
            <Text style={[styles.label, danger && styles.danger]}>{pending ? label + '…' : label}</Text>
            {caption ? <Text style={styles.caption}>{caption}</Text> : null}
          </View>
          {end}
        </Pressable>
        {action}
      </View>
    </View>
  )
}

export function ListGroup ({ children, style, ...accessibility }) {
  const styles = useStyles(makeStyles)
  return <View {...accessibility} style={[styles.group, style]}>{children}</View>
}

const makeStyles = (colors) => StyleSheet.create({
  group: { borderRadius: radius.bubble, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, overflow: 'hidden' },
  lineup: { flexDirection: 'row', alignItems: 'center' },
  row: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    gap: space.md
  },
  withCaption: { minHeight: 76 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  copy: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  label: { ...type.rowName, color: colors.ink },
  danger: { color: colors.danger },
  caption: { ...type.caption, color: colors.soft },
  trailing: { ...type.meta, color: colors.soft, flexShrink: 1 },
  pressed: { backgroundColor: colors.skeleton },
  off: { opacity: 0.45 }
})
