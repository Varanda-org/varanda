// One line of a timeline (no card): avatar, name, handle and time, an
// optional reply mark, the text and the reply action. It receives the RAW
// peer strings (author key, name, at, text, replyToName) and applies
// displayText itself, so callers must not pre-escape them. `onReport`
// (optional) adds a second action, 'denunciar', after the reply one.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { atHandle, relativeTime } from '../format'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { colors, type } from './theme'

export function PostRow ({ author, name, username, at, text, replyToName, now, onReply, onReport }) {
  const time = relativeTime(at, now) ?? displayText(at)
  const hasName = typeof name === 'string' && name.trim() !== ''
  const handle = displayText(atHandle(username, author))
  const shown = hasName ? displayText(name) : handle
  return (
    <View style={styles.row}>
      <Avatar name={name} publicKey={author} size={44} />
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={styles.name} numberOfLines={1}>
            {shown}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {hasName ? handle + ' · ' + time : time}
          </Text>
        </View>
        {replyToName
          ? (
            <Text style={styles.reply}>
              respondendo a <Text style={styles.replyName}>{displayText(replyToName)}</Text>
            </Text>
            )
          : null}
        <Text style={styles.text}>{displayText(text, { multiline: true })}</Text>
        {onReply
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={'responder a ' + shown}
              hitSlop={8}
              onPress={onReply}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Icon name='resposta' size={19} color={colors.soft} />
            </Pressable>
            )
          : null}
        {typeof onReport === 'function'
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={'denunciar ' + shown}
              hitSlop={8}
              onPress={onReport}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Icon name='bandeira' size={19} color={colors.soft} />
            </Pressable>
            )
          : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  body: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  name: { ...type.postName, color: colors.ink, flexShrink: 1 },
  meta: { ...type.postMeta, color: colors.soft, flexShrink: 1 },
  reply: { ...type.replyMark, color: colors.soft, marginTop: 1 },
  replyName: { color: colors.accent, fontWeight: '600' },
  text: { ...type.postText, color: colors.ink, marginTop: 3 },
  action: { marginTop: 8, marginLeft: -2, alignSelf: 'flex-start' },
  pressed: { opacity: 0.6 }
})
