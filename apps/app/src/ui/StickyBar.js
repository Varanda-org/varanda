import { StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { LARGE_TEXT, layout, radius, space, type } from './theme'

export function StickyBar ({ actions, onAction, onHeightChange, message }) {
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const { fontScale } = useWindowDimensions()
  if (actions.length === 0) return null
  return (
    <View
      onLayout={(event) => onHeightChange?.(event.nativeEvent.layout.height)}
      style={[styles.bar, { paddingBottom: insets.bottom + space.md }]}
    >
      {message?.text ? <Text style={styles.message} accessibilityLiveRegion='polite' accessibilityRole='text'>{displayText(message.text)}</Text> : null}
      {message?.error ? <Text style={[styles.message, styles.error]} accessibilityLiveRegion='polite' accessibilityRole='alert'>{displayText(message.error)}</Text> : null}
      <View style={[styles.buttons, fontScale >= LARGE_TEXT && styles.stacked]}>
        {actions.map((action) => (
          <PressScale
            key={action.id}
            onPress={() => onAction(action.id)}
            disabled={action.disabled || action.pending}
            accessibilityLabel={action.label}
            accessibilityState={{ busy: !!action.pending }}
            style={[styles.button, action.primary && styles.primary, (action.disabled || action.pending) && styles.disabled]}
          >
            <Text style={[styles.label, action.primary && styles.primaryLabel]}>{action.pending ? action.label + '…' : action.label}</Text>
          </PressScale>
        ))}
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  bar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: space.md, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.line },
  message: { ...type.caption, color: colors.soft, marginBottom: space.sm, width: '100%', maxWidth: layout.column, alignSelf: 'center' },
  error: { color: colors.danger },
  buttons: { flexDirection: 'row', gap: space.sm, width: '100%', maxWidth: layout.column, alignSelf: 'center' },
  stacked: { flexDirection: 'column' },
  button: { minHeight: layout.hit, flexGrow: 1, flexShrink: 1, justifyContent: 'center', alignItems: 'center', padding: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.outline },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  label: { ...type.pill, color: colors.ink, textAlign: 'center' },
  primaryLabel: { color: colors.accentInk },
  disabled: { opacity: 0.45 }
})
