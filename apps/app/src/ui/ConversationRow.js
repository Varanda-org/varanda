// One row of the unified Conversas list (WhatsApp/Telegram style): avatar (round for
// a person, rounded square for a group or community) on the left, bold title, one grey preview line, the time at the
// top right and the unread badge at the bottom right. A person's title comes
// from the row's own name, then the names cache, then the @username; never
// "sem nome" while any of them is known. The own marker (OWN_LABEL) is drawn
// apart from the preview, never joined to it, so a peer named "Você" never
// reads as the member.

import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { OWN_LABEL, unreadLabel } from '../groups'
import { useNames } from '../names'
import { UNNAMED, whoOf } from '../who'
import { Avatar } from './Avatar'
import { useStyles } from './ThemeProvider'
import { radius, space, type } from './theme'

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
  const count = Number.isInteger(item.unread) ? item.unread : 0
  const dot = item.unread === true
  const unread = dot || count > 0
  const badge = unreadLabel(count)
  const unreadText = item.unread === true
    ? 'mensagens novas'
    : count === 1 ? '1 mensagem nova' : count >= 99 ? '99 ou mais mensagens novas' : count + ' mensagens novas'
  const label = title + (unread ? ', ' + unreadText : '')
  return (
    <Pressable
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
        <View style={styles.line}>
          <Text style={styles.preview} numberOfLines={1}>
            {own ? <Text style={styles.own}>{OWN_LABEL + ': '}</Text> : null}
            {preview}
          </Text>
          {unread ? <View style={[styles.badge, dot && styles.dot]}>{!dot ? <Text style={styles.badgeText}>{badge}</Text> : null}</View> : null}
        </View>
      </View>
    </Pressable>
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
  title: { ...type.postName, fontSize: 16, fontWeight: '600', lineHeight: 21, flex: 1, minWidth: 0, color: colors.ink },
  titleUnread: { fontWeight: '700' },
  time: { ...type.replyMark, color: colors.soft },
  timeUnread: { color: colors.accent, fontWeight: '600' },
  preview: { ...type.postMeta, fontSize: 14, lineHeight: 19, flex: 1, minWidth: 0, color: colors.soft },
  own: { color: colors.accent, fontWeight: '600' },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent
  },
  dot: { minWidth: 12, width: 12, height: 12, paddingHorizontal: 0 },
  badgeText: { ...type.chip, color: colors.accentInk }
})
