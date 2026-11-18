// The fixed note while the seeder's storage budget keeps the own diary out
// (storageFullShown in syncSignals.js), in the slot and look of OfflineNote.
// It has no button and no close: nothing on this device makes room on the
// seeder, and the note goes away on its own once the seeder admits the diary.

import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { STORAGE_FULL_NOTE } from '../syncSignals'
import { NoteBar } from './NoteBar'

export function StorageFullNote ({ inset = false }) {
  const insets = useSafeAreaInsets()
  return (
    <NoteBar
      text={STORAGE_FULL_NOTE}
      icon='sinc'
      accessibilityRole='alert'
      accessibilityLiveRegion='polite'
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
