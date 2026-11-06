// The in-app note for a surprise invite. `inset` adds the top safe-area
// padding for a screen without a top bar (Diário), like OfflineNote.
import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { INVITE_DROP_TITLE, INVITE_DROP_BODY } from '../signupInvite'
import { useStyles } from './ThemeProvider'
import { type } from './theme'

export function InviteDropNote ({ record, onShown, onOpen, inset = false }) {
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  useEffect(() => { onShown(record) }, [record, onShown])
  return (
    <View style={[styles.note, inset && { paddingTop: 12 + insets.top }]} accessibilityLiveRegion='polite'>
      <Text style={styles.title}>{INVITE_DROP_TITLE}</Text>
      <Text style={styles.body}>{INVITE_DROP_BODY}</Text>
      <Pressable accessibilityRole='button' onPress={onOpen} hitSlop={8} style={styles.button}>
        <Text style={styles.action}>Convidar pessoas</Text>
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  note: {
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: colors.warm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  title: { ...type.chip, color: colors.ink, fontWeight: '700' },
  body: { ...type.chip, color: colors.soft },
  button: { alignSelf: 'flex-start', paddingVertical: 6 },
  action: { ...type.chip, color: colors.accent, fontWeight: '700' }
})
