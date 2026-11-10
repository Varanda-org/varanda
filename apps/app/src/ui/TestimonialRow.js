// One depoimento: the writer's avatar (44 pt), name and verified @nome open
// their profile; the relative time; the text as plain multiline text. The
// "mais ações" sheet offers 'Remover do perfil' on the owner's own profile
// and 'Denunciar a conta' (the writer); on a depoimento the viewer wrote it
// offers only 'Retirar depoimento', never a report against themself. No
// likes and no counts.
// Every peer string goes through displayText; never a key.

import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { MoreButton } from './MoreButton'
import { LARGE_TEXT, type } from './theme'
import { useStyles } from './ThemeProvider'

// The viewer's own depoimento: 'Retirar depoimento' (when there is a
// handler), and nothing else. Exported for the tests.
export function isOwnTestimonial (row, ownKey) {
  return !!row && typeof ownKey === 'string' && typeof row.from === 'string' && row.from === ownKey.toLowerCase()
}

export function TestimonialRow ({ row, profile, now, ownKey, onOpenMember, onRemove, onReport, onRetract, children }) {
  const styles = useStyles(makeStyles)
  const { fontScale } = useWindowDimensions()
  const who = whoOf(profile || { name: row.name, username: row.username })
  const title = displayText(who.title)
  // As on PostRow: the @nome gives way first and hides at large text; the
  // date is its own Text and is never cut.
  const handle = who.subtitle && !(fontScale >= LARGE_TEXT) ? displayText(who.subtitle) : null
  const time = relativeTime(row.at, now) ?? displayText(row.at)
  const open = typeof onOpenMember === 'function'
    ? () => onOpenMember(row.from, { name: profile ? profile.name : row.name, username: profile ? profile.username : row.username })
    : undefined
  const mine = isOwnTestimonial(row, ownKey)
  const actions = (mine
    ? [typeof onRetract === 'function' ? { icon: 'lixeira', label: 'Retirar depoimento', danger: true, onPress: () => onRetract(row) } : null]
    : [
        typeof onRemove === 'function' ? { icon: 'lixeira', label: 'Remover do perfil', danger: true, onPress: () => onRemove(row) } : null,
        typeof onReport === 'function' ? { icon: 'bandeira', label: 'Denunciar a conta', danger: true, onPress: () => onReport({ author: row.from, name: profile ? profile.name : row.name, username: profile ? profile.username : row.username }) } : null
      ]).filter(Boolean)
  const picture = profile && profile.avatar !== undefined ? profile.avatar : row.avatar
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
          <Avatar name={who.avatarName} publicKey={row.from} size={44} picture={picture} />
          <View style={styles.who}>
            <Text style={styles.name} numberOfLines={1}>{title}</Text>
            <View style={styles.metaRow}>
              {handle ? <Text style={styles.handle} numberOfLines={1}>{handle}</Text> : null}
              <Text style={styles.time} numberOfLines={1}>{(handle ? '\u00a0· ' : '') + time}</Text>
            </View>
          </View>
        </Pressable>
        <MoreButton title={title} actions={actions} />
      </View>
      <Text style={styles.text}>{displayText(row.text, { multiline: true })}</Text>
      {children ? <View style={styles.actions}>{children}</View> : null}
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
  // The handle shrinks (minWidth keeps "@jo…", never a sliver); the time
  // never shrinks, so the date always shows.
  metaRow: { flexDirection: 'row', alignItems: 'baseline' },
  handle: { ...type.postMeta, color: colors.soft, flexShrink: 1, minWidth: 32 },
  time: { ...type.postMeta, color: colors.soft, flexShrink: 0 },
  text: { ...type.postText, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
})
