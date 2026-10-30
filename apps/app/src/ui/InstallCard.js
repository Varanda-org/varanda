// The install offer shown once right after sign-up (hosted web). Presentational
// only: the install state lives in src/install. `kind` is 'prompt' (browser
// install popup) or 'ios' (Share menu instruction); anything else renders
// nothing. `inset` adds the top safe-area padding for a screen without a top bar.

import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './Icon'
import { Btn, Row, Soft } from './index'
import { colors, type } from './theme'
import { INSTALL_CARD_TEXT, INSTALL_CARD_TITLE } from '../install-offer'

export function InstallCard ({ kind, onInstall, onClose, inset = false }) {
  const insets = useSafeAreaInsets()
  if (kind !== 'prompt' && kind !== 'ios') return null
  return (
    <View style={[styles.card, inset && { paddingTop: 16 + insets.top }]}>
      <View style={styles.title}>
        <Icon name='smartphone' size={16} color={colors.soft} />
        <Text accessibilityRole='header' style={{ ...type.postName, color: colors.ink }}>{INSTALL_CARD_TITLE}</Text>
      </View>
      <Soft>{INSTALL_CARD_TEXT[kind]}</Soft>
      <Row>
        {kind === 'prompt'
          ? (
            <>
              <Btn label='Instalar' onPress={onInstall} />
              <Btn secondary label='Agora não' onPress={onClose} />
            </>
            )
          : <Btn secondary label='Entendi' onPress={onClose} />}
      </Row>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 8
  },
  title: { flexDirection: 'row', alignItems: 'center', gap: 8 }
})
