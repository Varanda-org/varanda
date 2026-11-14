// The calm note offering Web Push on this device, with the same look and slot
// as InstallNote. It always renders when mounted because the shell decides
// mounting. Presentational only: the state and the turn-on live in
// src/push-offer.js through src/usePush. onEnable is called straight from the
// press because Safari spends the user activation on any await before
// pushManager.subscribe().

import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NoteBar } from './NoteBar'

export function PushNote ({
  text = 'Receber avisos neste aparelho',
  pending = false,
  onEnable,
  onClose,
  inset = false
}) {
  const insets = useSafeAreaInsets()
  return (
    <NoteBar
      text={text}
      icon='sino'
      action={{ label: 'Ativar', accessibilityLabel: 'Ativar avisos neste aparelho', pendingLabel: 'Ativar', pending, onPress: onEnable }}
      onClose={onClose}
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
