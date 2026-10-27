// The calm 'Instalar o Varanda' note under the top bar (hosted web, phones and
// iPad), with the same look as OfflineNote. It sits in the layout and never
// over the content, and it is not an alert. Presentational only: the install
// logic lives in src/install. `kind` is 'prompt' (Chrome's install popup, with
// an 'Instalar' button) or 'ios' (the Share menu instruction); anything else
// renders nothing. `inset` adds the top safe-area padding for a screen
// without a top bar (Diário).

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { colors, type } from './theme'

export function InstallNote ({ kind, onInstall, onClose, inset = false }) {
  const insets = useSafeAreaInsets()
  if (kind !== 'prompt' && kind !== 'ios') return null
  return (
    <View style={[styles.note, inset && { paddingTop: 6 + insets.top }]}>
      <View style={styles.content}>
        <Icon name='smartphone' size={14} color={colors.soft} />
        {kind === 'prompt'
          ? (
            <>
              <Text style={[styles.text, styles.grow]} numberOfLines={1}>Instalar o Varanda</Text>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel='Instalar o Varanda'
                hitSlop={12}
                style={styles.fixed}
                onPress={onInstall}
              >
                <Text style={styles.action}>Instalar</Text>
              </Pressable>
            </>
            )
          : (
            <Text style={[styles.text, styles.grow]} numberOfLines={2}>Compartilhar → Adicionar à Tela de Início</Text>
            )}
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
