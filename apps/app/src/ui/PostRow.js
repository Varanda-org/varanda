// One line of a timeline (no card): avatar, name, handle and time, an
// optional reply mark, the text and the reply action. It receives the RAW
// peer strings (author key, name, username, at, text, replyToName) and
// applies displayText itself, so callers must not pre-escape them. Naming
// follows whoOf (src/who.js): never a key-derived handle. `onFollow`
// (optional) adds an action, 'seguir', after the reply one; `followPending`
// disables it while the follow is being written. `onReport` (optional) adds
// the last action, 'denunciar'. The order is reply, follow, report.
// `media` (an array of media descriptors, or null) adds the photos under the
// text (./MediaGrid, which verifies every byte before showing it); a post
// with photos may have no text.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { MediaGrid } from './MediaGrid'
import { colors, type } from './theme'

export function PostRow ({ author, name, username, at, text, replyToName, now, onReply, onFollow, followPending, onReport, media }) {
  const hasMedia = Array.isArray(media) && media.length > 0
  const time = relativeTime(at, now) ?? displayText(at)
  const who = whoOf({ name, username })
  const title = displayText(who.title)
  const meta = who.subtitle ? displayText(who.subtitle) + ' · ' + time : time
  return (
    <View style={styles.row}>
      <Avatar name={who.avatarName} publicKey={author} size={44} />
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        {replyToName
          ? (
            <Text style={styles.reply}>
              respondendo a <Text style={styles.replyName}>{displayText(replyToName)}</Text>
            </Text>
            )
          : null}
        {text || !hasMedia
          ? <Text style={styles.text}>{displayText(text, { multiline: true })}</Text>
          : null}
        {hasMedia ? <MediaGrid author={author} media={media} /> : null}
        {onReply
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={'responder a ' + title}
              hitSlop={8}
              onPress={onReply}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Icon name='resposta' size={19} color={colors.soft} />
            </Pressable>
            )
          : null}
        {typeof onFollow === 'function'
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={'seguir ' + title}
              accessibilityState={{ disabled: !!followPending }}
              disabled={!!followPending}
              hitSlop={8}
              onPress={onFollow}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Icon name='seguir' size={19} color={colors.soft} />
            </Pressable>
            )
          : null}
        {typeof onReport === 'function'
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={'denunciar ' + title}
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
