// The fixed note of a device the account disconnected (#350), in the slot and
// look of DeletionNote. It has no close button: this device cannot write to
// communities and groups until it connects again. One tap on "Conectar de
// novo" is one device.reconnect; a failure shows the error text in the note
// and is never retried on its own.

import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { OFF_NOTE, RECONNECT, RECONNECT_ACCESSIBILITY } from '../devices'
import { useAction } from './index'
import { NoteBar } from './NoteBar'

export function DeviceOffNote ({ onReconnect, inset = false }) {
  const insets = useSafeAreaInsets()
  const act = useAction()
  return (
    <NoteBar
      text={act.error ? OFF_NOTE + '. ' + act.error : OFF_NOTE}
      icon='smartphone'
      accessibilityRole='alert'
      action={{ label: RECONNECT, accessibilityLabel: RECONNECT_ACCESSIBILITY, pending: act.pending, onPress: () => { act.run(onReconnect) } }}
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
