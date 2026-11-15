// One recado: the writer's avatar (44 pt), name and verified @nome open their
// profile; the relative time; the text as plain multiline text through
// displayText. 'Responder' sits under the text; the other actions (Tirar da
// minha página, Apagar recado, Denunciar a conta) are in "mais ações". Which
// actions a viewer gets is src/recadosView.js rowActions. No counts, no likes.

import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { BLOCKED_ROW, rowActions } from '../recadosView'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { MoreButton } from './MoreButton'
import { Pill } from './Pill'
import { LARGE_TEXT, type } from './theme'
import { useStyles } from './ThemeProvider'

export function ScrapRow ({ row, profile, now, owner, self, isBlocked, onOpenMember, onReply, onHide, onDelete, onReport }) {
  const styles = useStyles(makeStyles)
  const { fontScale } = useWindowDimensions()
  const who = whoOf(profile || {})
  const title = displayText(who.title)
  const handle = who.subtitle && !(fontScale >= LARGE_TEXT) ? displayText(who.subtitle) : null
  const time = relativeTime(row.at, now) ?? displayText(row.at)
  const open = typeof onOpenMember === 'function'
    ? () => onOpenMember(row.author, { name: profile ? profile.name : undefined, username: profile ? profile.username : undefined })
    : undefined
  const handlers = {
    reply: onReply,
    hide: onHide,
    delete: onDelete,
    report: typeof onReport === 'function' ? () => onReport({ author: row.author, name: profile ? profile.name : undefined, username: profile ? profile.username : undefined }) : undefined
  }
  const allowed = rowActions(row, { owner, self, isBlocked }).filter((a) => typeof handlers[a.id] === 'function')
  const reply = allowed.find((a) => a.id === 'reply')
  const more = allowed.filter((a) => a.id !== 'reply').map((a) => ({
    icon: a.id === 'report' ? 'bandeira' : 'lixeira',
    label: a.label,
    danger: a.danger === true,
    onPress: () => handlers[a.id](row)
  }))
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Pressable
          style={({ pressed }) => [styles.open, pressed && open && styles.pressed]}
          accessibilityRole='link'
          accessibilityLabel={'ver o perfil de ' + title}
          disabled={!open}
          onPress={open}
        >
          <Avatar name={who.avatarName} publicKey={row.author} size={44} picture={profile && profile.avatar !== undefined ? profile.avatar : null} />
          <View style={styles.who}>
            <Text style={styles.name} numberOfLines={1}>{title}</Text>
            <View style={styles.metaRow}>
              {handle ? <Text style={styles.handle} numberOfLines={1}>{handle}</Text> : null}
              <Text style={styles.time} numberOfLines={1}>{(handle ? ' · ' : '') + time}</Text>
            </View>
          </View>
        </Pressable>
        <MoreButton title='Recado' actions={more} />
      </View>
      {row.blocked === true
        ? <Text style={styles.reply}>{BLOCKED_ROW}</Text>
        : (
          <>
            {row.replyTo !== null ? <Text style={styles.reply}>Em resposta a um recado</Text> : null}
            <Text style={styles.text}>{displayText(row.text, { multiline: true })}</Text>
          </>
          )}
      {reply && row.blocked !== true ? <View style={styles.actions}><Pill small label={reply.label} onPress={() => handlers.reply(row)} /></View> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  open: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  metaRow: { flexDirection: 'row', alignItems: 'baseline' },
  handle: { ...type.postMeta, color: colors.soft, flexShrink: 1, minWidth: 32 },
  time: { ...type.postMeta, color: colors.soft, flexShrink: 0 },
  reply: { ...type.postMeta, color: colors.soft },
  text: { ...type.postText, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
})
