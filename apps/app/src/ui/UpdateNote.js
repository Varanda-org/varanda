// The release notice shares the install note's quiet layout. Reload and
// session dismissal belong to the shell; observing a release never reloads.
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { UPDATE_ACTION, UPDATE_TEXT } from '../release'
import { NoteBar } from './NoteBar'

export function UpdateNote ({ onUpdate, onClose, inset = false }) {
  const insets = useSafeAreaInsets()
  return (
    <NoteBar
      text={UPDATE_TEXT}
      action={{ label: UPDATE_ACTION, onPress: onUpdate }}
      onClose={onClose}
      closeLabel='fechar'
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
