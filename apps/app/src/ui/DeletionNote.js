// The note of a deletion waiting for its date (Excluir conta asked without a
// passkey the account service could verify), with the look and slot of
// PushNote. It has no close button: a person who did not ask must see it on
// every signed-in device until the date or a cancel. onOpen leads to Ajustes
// > Excluir conta, where CancelarExclusao cancels it. Presentational only:
// the shell reads the date from /account/status.

import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleDate } from '../accountDeletion'
import { NoteBar } from './NoteBar'

export function DeletionNote ({ scheduled, onOpen, inset = false }) {
  const insets = useSafeAreaInsets()
  return (
    <NoteBar
      text={'Exclusão da conta agendada para ' + scheduleDate(scheduled)}
      icon='lixeira'
      action={{ label: 'Ver', accessibilityLabel: 'Ver ou cancelar a exclusão da conta', onPress: onOpen }}
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
