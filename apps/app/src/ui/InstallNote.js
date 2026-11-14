// The calm 'Instalar o Varanda' note under the top bar (hosted web, phones and
// iPad), with the same look as OfflineNote. It sits in the layout and never
// over the content, and it is not an alert. Presentational only: the install
// logic lives in src/install. `kind` is 'prompt' (Chrome's install popup, with
// an 'Instalar' button) or 'ios' (the Share menu instruction); anything else
// renders nothing. `inset` adds the top safe-area padding for a screen
// without a top bar (Diário).

import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NoteBar } from './NoteBar'

export function InstallNote ({ kind, onInstall, onClose, inset = false }) {
  const insets = useSafeAreaInsets()
  if (kind !== 'prompt' && kind !== 'ios') return null
  return (
    <NoteBar
      text={kind === 'prompt' ? 'Instalar o Varanda' : 'Compartilhar → Adicionar à Tela de Início'}
      icon='smartphone'
      action={kind === 'prompt' ? { label: 'Instalar', accessibilityLabel: 'Instalar o Varanda', onPress: onInstall } : undefined}
      onClose={onClose}
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
