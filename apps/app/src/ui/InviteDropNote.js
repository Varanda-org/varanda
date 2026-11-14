// The in-app note for a surprise invite. `inset` adds the top safe-area
// padding for a screen without a top bar (Diário), like OfflineNote.
import { useEffect } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { INVITE_DROP_TITLE, INVITE_DROP_BODY } from '../signupInvite'
import { NoteBar } from './NoteBar'
import { useStyles } from './ThemeProvider'

export function InviteDropNote ({ record, onShown, onOpen, inset = false }) {
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  useEffect(() => { onShown(record) }, [record, onShown])
  return (
    <NoteBar
      text={<><Text style={styles.title}>{INVITE_DROP_TITLE}</Text>{'\n'}{INVITE_DROP_BODY}</>}
      action={{ label: 'Convidar pessoas', onPress: onOpen }}
      accessibilityLiveRegion='polite'
      style={inset && { paddingTop: 12 + insets.top }}
    />
  )
}

const makeStyles = (colors) => StyleSheet.create({
  title: { color: colors.ink, fontWeight: '700' }
})
