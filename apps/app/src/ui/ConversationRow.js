// One row of the unified Conversas list (WhatsApp/Telegram style): avatar (round for
// a person, rounded square for a group or community) on the left, bold title, one grey preview line, the time at the
// top right and an unread dot at the bottom right. A person's title comes
// from the names cache only (name, then @username), never from the row; never
// "sem nome" while any of them is known. The own marker (OWN_LABEL) is drawn
// apart from the preview, never joined to it, so a peer named "Você" never
// reads as the member.

import { pictureProps } from '../groupImage'
import { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { handleLine } from '../conversas'
import { OWN_LABEL } from '../groups'
import { useNames } from '../names'
import { UNNAMED, readsAs, whoOf } from '../who'
import { Avatar } from './Avatar'
import { Badge } from './Badge'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { space, type } from './theme'

const SIZE = 48
const HEX64 = /^[0-9a-f]{64}$/

// The Avatar props of a group row's private picture. A live picture
// (`pictured`, from pictureProps) is its own pair, and the row keeps its
// plaintext. A row seeded from the stored copy (thumb and thumbAuthor set
// only by Conversas, never with an image) draws the pair kept before. Any
// other row, a live one without a picture included, gets none: a removed
// picture never shows again.
export function groupThumbProps (item, pictured) {
  if (pictured && pictured.privateItem) {
    return { groupThumb: { author: pictured.mediaAuthor, sha: pictured.privateItem.plainSha256 }, keepGroupThumb: true }
  }
  if (item && item.image === undefined && item.imageAuthor === undefined && typeof item.thumb === 'string' && HEX64.test(item.thumb) &&
    typeof item.thumbAuthor === 'string' && HEX64.test(item.thumbAuthor)) {
    return { groupThumb: { author: item.thumbAuthor, sha: item.thumb }, keepGroupThumb: false }
  }
  return { groupThumb: null, keepGroupThumb: false }
}

// The visible title of a person: the whoOf rule, "Pessoa" when unnamed. The
// Conversas search compares against this same text.
export function personTitle (profile) {
  const who = whoOf(profile)
  return displayText(who.title === UNNAMED ? 'Pessoa' : who.title)
}

// item: { kind: 'dm' | 'group' | 'community', key, name?, username?, preview?,
// mine?, at?, unread? (boolean or a count), thumb?, thumbAuthor? (a seeded
// private group's stored picture pair) }
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
  const handle = person ? handleLine(profile) : null
  const avatarName = person ? who.avatarName : title
  const avatar = cached && cached.avatar ? cached.avatar : undefined
  const pictured = person ? null : pictureProps(item)
  const thumbProps = person ? null : groupThumbProps(item, pictured)
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
      <Avatar name={avatarName} publicKey={key} size={SIZE} {...(person ? { picture: avatar } : { ...pictured, ...thumbProps })} persist='copy' shape={person ? 'circle' : 'square'} />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>{title}</Text>
          {time ? <Text style={[styles.time, unread && styles.timeUnread]}>{time}</Text> : null}
        </View>
        {handle ? <Text style={styles.handle} numberOfLines={1}>{displayText(handle)}</Text> : null}
        {/* No preview and nothing unread: no empty second line, so the title
            centres against the avatar. */}
        {preview !== '' || unread
          ? (
            <View style={styles.line}>
              <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
                {own ? <Text style={styles.own}>{OWN_LABEL + ': '}</Text> : null}
                {preview}
              </Text>
              {unread ? <Badge /> : null}
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
  handle: { ...type.postMeta, fontSize: 13, lineHeight: 18, color: colors.soft },
  preview: { ...type.postMeta, fontSize: 14, lineHeight: 20, flex: 1, minWidth: 0, color: colors.soft },
  own: { color: colors.accent, fontWeight: '600' },
  previewUnread: { color: colors.ink, fontWeight: '700' }
})
