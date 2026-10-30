// The calm note offering Web Push on this device, with the same look and slot
// as InstallNote. It always renders when mounted because the shell decides
// mounting. Presentational only: the state and the turn-on live in
// src/push-offer.js through src/usePush. onEnable is called straight from the
// press because Safari spends the user activation on any await before
// pushManager.subscribe().

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { colors, type } from './theme'

export function PushNote ({
  text = 'Receber avisos neste aparelho',
  pending = false,
  onEnable,
  onClose,
  inset = false
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.note, inset && { paddingTop: 6 + insets.top }]}>
      <View style={styles.content}>
        <Icon name='sino' size={14} color={colors.soft} />
        <Text style={[styles.text, styles.grow]} numberOfLines={2}>{text}</Text>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='Ativar avisos neste aparelho'
          hitSlop={12}
          style={styles.fixed}
          disabled={pending}
          accessibilityState={{ disabled: pending }}
          onPress={onEnable}
        >
          <Text style={[styles.action, pending && { opacity: 0.5 }]}>Ativar</Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='Fechar'
        hitSlop={12}
        style={styles.fixed}
        onPress={onClose}
      >
        <Icon name='fechar' size={14} color={colors.soft} />
      </Pressable>
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
