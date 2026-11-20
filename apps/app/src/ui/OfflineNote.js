// A calm one-line note under the top bar while the device has no internet
// (node.online === false: the browser's network hint; native is always
// online). Nothing shows while online: no "connected" or "syncing" state.
// It sits in the layout above the content, never over it. `inset` adds the
// top safe-area padding for a screen without a top bar (Diário).

import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNode } from '../node'
import { NoteBar } from './NoteBar'

export function OfflineNote ({ inset = false }) {
  const { online } = useNode()
  const insets = useSafeAreaInsets()
  if (online !== false) return null
  return (
    <NoteBar
      text='Sem internet'
      icon='semconexao'
      accessibilityRole='alert'
      accessibilityLiveRegion='polite'
      style={inset && { paddingTop: 6 + insets.top }}
    />
  )
}
