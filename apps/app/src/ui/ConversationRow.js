// One row of the unified Conversas list (WhatsApp/Telegram style): avatar (round for
// a person, rounded square for a group or community) on the left, bold title, one grey preview line, the time at the
// top right and an unread dot at the bottom right. A person's title comes
// from the row's own name, then the names cache, then the @username; never
// "sem nome" while any of them is known. The own marker (OWN_LABEL) is drawn
// apart from the preview, never joined to it, so a peer named "Você" never
// reads as the member.

import { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { OWN_LABEL } from '../groups'
import { useNames } from '../names'
import { UNNAMED, readsAs, whoOf } from '../who'
import { Avatar } from './Avatar'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { space, type } from './theme'

const SIZE = 48

// The visible title of a person: the whoOf rule, "Pessoa" when unnamed. The
// Conversas search compares against this same text.
export function personTitle (profile) {
  const who = whoOf(profile)
  return displayText(who.title === UNNAMED ? 'Pessoa' : who.title)
}

// item: { kind: 'dm' | 'group' | 'community', key, name?, username?, preview?,
// mine?, at?, unread? (boolean or a count) }
export function ConversationRow ({ item, now, onPress }) {
  const styles = useStyles(makeStyles)
  const names = useNames()
  const person = item.kind === 'dm'
  const key = item.key
  const resolve = names ? names.resolve : null
  useEffect(() => {
    if (person && resolve && typeof key === 'string') resolve(key)
  }, [person, resolve, key])
  const cached = person && names ? names.profileOf(key) : undefined
  // A person is named only by the names cache (profile.read, or a verified
  // search hit), never by fields riding on a list row.
  const profile = person
    ? { name: cached ? cached.name : null, username: cached ? cached.username : null }
    : { name: item.name }
  const who = whoOf(profile)
  // A group sits in the same list as people, so its name follows the same
  // anti-impersonation rule: no leading at-sign or invisible character, and a
  // group called "@alice" never reads like the member whose @nome is alice.
  const groupName = person ? UNNAMED : whoOf({ name: typeof item.name === 'string' ? item.name : '' }).title
  const groupTitle = groupName === UNNAMED ? '' : displayText(groupName).trim()
  const title = person ? personTitle(profile) : (groupTitle || 'Sem título')
  const avatarName = person ? who.avatarName : title
  const avatar = cached && cached.avatar ? cached.avatar : undefined
  const time = typeof item.at === 'string' ? relativeTime(item.at, now) : null
  const preview = typeof item.preview === 'string' && item.preview !== '' ? displayText(item.preview) : ''
  const own = preview !== '' && item.mine === true
  const spokenPreview = !person && !own && readsAs(preview.split(':')[0], OWN_LABEL) ? preview.replace(/^[^:]+:/, 'Pessoa:') : preview
  const count = Number.isInteger(item.unread) ? item.unread : 0
  const dot = item.unread === true
  const unread = dot || count > 0
  const unreadText = item.unread === true
    ? 'mensagens novas'
    : count === 1 ? '1 mensagem nova' : count >= 99 ? '99 ou mais mensagens novas' : count + ' mensagens novas'
  const label = [title, own ? OWN_LABEL + ': ' + spokenPreview : spokenPreview, time, unread ? unreadText : ''].filter(Boolean).join(', ')
  return (
    <PressScale
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar name={avatarName} publicKey={key} size={SIZE} picture={avatar} persist={false} shape={person ? 'circle' : 'square'} />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>{title}</Text>
          {time ? <Text style={[styles.time, unread && styles.timeUnread]}>{time}</Text> : null}
        </View>
        {/* No preview and nothing unread: no empty second line, so the title
            centres against the avatar. */}
        {preview !== '' || unread
          ? (
            <View style={styles.line}>
              <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
                {own ? <Text style={styles.own}>{OWN_LABEL + ': '}</Text> : null}
                {preview}
              </Text>
              {unread ? <View style={styles.dot} /> : null}
            </View>
            )
          : null}
      </View>
    </PressScale>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 72,
    paddingVertical: 10,
    paddingHorizontal: space.lg
  },
  pressed: { backgroundColor: colors.line },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...type.rowName, flex: 1, minWidth: 0, color: colors.ink },
  titleUnread: { fontWeight: '700' },
  time: { ...type.replyMark, color: colors.soft, flexShrink: 0, textAlign: 'right' },
  timeUnread: { color: colors.accent, fontWeight: '600' },
  preview: { ...type.postMeta, fontSize: 14, lineHeight: 20, flex: 1, minWidth: 0, color: colors.soft },
  own: { color: colors.accent, fontWeight: '600' },
  previewUnread: { color: colors.ink, fontWeight: '700' },
  // A plain 8 pt disc: the spoken label already carries the count.
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: colors.accent }
})
