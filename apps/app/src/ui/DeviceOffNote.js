// The fixed note of a device the account disconnected (#350), in the slot and
// look of DeletionNote. It has no close button: this device cannot write to
// communities and groups until it connects again. One tap on "Conectar de
// novo" is one device.reconnect; after a failure the shell has read the list
// once to settle the state, and the note says so in plain words. Nothing is
// retried on its own.

import { useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { OFF_NOTE, RECONNECT, RECONNECT_ACCESSIBILITY, reconnectFailure } from '../devices'
import { errorText, useAction } from './index'
import { NoteBar } from './NoteBar'

export function DeviceOffNote ({ onReconnect, inset = false }) {
  const insets = useSafeAreaInsets()
  const act = useAction()
  const [failure, setFailure] = useState('')
  const press = async () => {
    setFailure('')
    const r = await act.run(async () => {
      try {
        await onReconnect()
      } catch (err) {
        setFailure(reconnectFailure(err, (m) => errorText({ message: m })))
        throw err
      }
    })
    if (r.ok) setFailure('')
  }
  return (
    <NoteBar
      text={failure ? OFF_NOTE + '. ' + failure : OFF_NOTE}
      icon='smartphone'
      accessibilityRole='alert'
      action={{ label: RECONNECT, accessibilityLabel: RECONNECT_ACCESSIBILITY, pending: act.pending, onPress: press }}
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
