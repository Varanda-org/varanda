// The release notice shares the install note's quiet layout. Reload and
// session dismissal belong to the shell; observing a release never reloads.
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { UPDATE_ACTION, UPDATE_TEXT } from '../release'
import { Icon } from './Icon'
import { colors, type } from './theme'

export function UpdateNote ({ onUpdate, onClose, inset = false }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.note, inset && { paddingTop: 6 + insets.top }]}>
      <View style={styles.content}>
        <Text style={[styles.text, styles.grow]}>{UPDATE_TEXT}</Text>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={UPDATE_ACTION}
          hitSlop={12}
          style={styles.fixed}
          onPress={onUpdate}
        >
          <Text style={styles.action}>{UPDATE_ACTION}</Text>
        </Pressable>
      </View>
      {onClose
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='fechar'
            hitSlop={12}
            style={styles.fixed}
            onPress={onClose}
          >
            <Icon name='fechar' size={14} color={colors.soft} />
          </Pressable>
          )
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 16,
    backgroundColor: colors.warm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  text: { ...type.chip, color: colors.soft },
  action: { ...type.chip, color: colors.accent, fontWeight: '700' },
  grow: { flexShrink: 1 },
  fixed: { flexShrink: 0 }
})
