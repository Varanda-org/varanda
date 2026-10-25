// A calm one-line note under the top bar while the device has no internet
// (node.online === false: the browser's network hint; native is always
// online). Nothing shows while online: no "connected" or "syncing" state.
// It sits in the layout above the content, never over it. `inset` adds the
// top safe-area padding for a screen without a top bar (Diário).

import { Platform, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNode } from '../node'
import { Icon } from './Icon'
import { colors, type } from './theme'

export function OfflineNote ({ inset = false }) {
  const { online } = useNode()
  const insets = useSafeAreaInsets()
  if (online !== false) return null
  return (
    <View
      style={[styles.note, inset && { paddingTop: 6 + insets.top }]}
      accessibilityRole='alert'
      accessibilityLiveRegion='polite'
      {...(Platform.OS === 'web' ? { 'aria-live': 'polite' } : null)}
    >
      <Icon name='wifi-off' size={14} color={colors.soft} />
      <Text style={styles.text} numberOfLines={1}>Sem internet</Text>
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
  text: { ...type.chip, color: colors.soft }
})
