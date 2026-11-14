// The invitation any press in the shared post preview opens
// (./PostLinkOpen.js): create an account or sign in. Both buttons lead to
// the same next step as the old card's Entrar (onEnter), where the post card
// and the destination wait.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { CREATE_LABEL, ENTRAR_LABEL } from '../entrarCard'
import { HOW_LABEL } from '../inviteCardCopy'
import { SHEET_BODY, SHEET_TITLE } from '../postPreviewCopy'
import { Btn, ConfirmStack, Soft } from './index'
import { Sheet } from './Sheet'
import { layout, space } from './theme'
import { useStyles } from './ThemeProvider'

export function PostLinkSheet ({ open, onClose, onEnter, onHow }) {
  const styles = useStyles(makeStyles)
  const enter = () => {
    onClose()
    onEnter()
  }
  const how = () => {
    onClose()
    onHow()
  }
  return (
    <Sheet open={open} onClose={onClose} title={SHEET_TITLE}>
      <View style={styles.body}>
        <Soft>{SHEET_BODY}</Soft>
        <ConfirmStack
          confirm={<Btn label={CREATE_LABEL} onPress={enter} />}
          cancel={<Btn label={ENTRAR_LABEL} secondary onPress={enter} />}
        />
        {typeof onHow === 'function'
          ? (
            <Pressable accessibilityRole='button' onPress={how} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
              <Text style={styles.linkText}>{HOW_LABEL}</Text>
            </Pressable>
            )
          : null}
      </View>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg },
  link: { alignSelf: 'center', minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.xs },
  linkText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  pressed: { opacity: 0.6 }
})
