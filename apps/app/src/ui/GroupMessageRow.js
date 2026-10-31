// One message of a Cadeira. Props: { item, name, username, own, canHide,
// canBan, canReport, onHide(on), onBan(), onReport(), onOpenMember(), now }.
// `item` is a row of groups.js rowsOf (text already through displayText,
// HIDDEN_LABEL when hidden). `name` / `username` are the RAW peer strings the
// screen knows for the author; without them the row shows the 8-hex short key
// rowsOf already computed. A group message is addressed by { writer, seq },
// never by PostRow's diary ref. The actions sit behind a "mais" button so a
// tap on the text does nothing by surprise.

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { Avatar } from './Avatar'
import { Pill } from './Pill'
import { colors, type } from './theme'

function authorLine (item, name, username) {
  const n = typeof name === 'string' ? displayText(name).trim() : ''
  const u = typeof username === 'string' ? displayText(username).trim() : ''
  return { title: n || (u ? '@' + u : item.author), handle: n && u ? '@' + u : '' }
}

export function GroupMessageRow ({ item, name, username, own, canHide, canBan, canReport, onHide, onBan, onReport, onOpenMember, now = Date.now() }) {
  const [open, setOpen] = useState(false)
  const who = authorLine(item, name, username)
  const time = item.at ? relativeTime(item.at, now) : null
  const hasActions = canHide || (canBan && !own) || (canReport && !own && !item.hidden)
  const openMember = typeof onOpenMember === 'function' && item.diary ? onOpenMember : undefined
  const act = (fn) => () => {
    setOpen(false)
    if (typeof fn === 'function') fn()
  }
  return (
    <View style={[styles.row, own && styles.own]}>
      <Pressable
        accessibilityRole='link'
        accessibilityLabel={who.title + ', ver perfil'}
        disabled={!openMember}
        onPress={openMember}
        hitSlop={4}
      >
        <Avatar name={who.title} publicKey={item.diary || item.writer} size={36} persist={false} />
      </Pressable>
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={styles.name} numberOfLines={1}>{who.title}</Text>
          {who.handle ? <Text style={styles.meta} numberOfLines={1}>{who.handle}</Text> : null}
          {time ? <Text style={styles.meta}>{time}</Text> : null}
        </View>
        <Text style={[styles.text, item.hidden && styles.hidden]} selectable={!item.hidden}>{item.text}</Text>
        {open
          ? (
            <View style={styles.actions}>
              {canHide ? <Pill label={item.hidden ? 'mostrar' : 'ocultar'} onPress={act(() => onHide(!item.hidden))} /> : null}
              {canBan && !own ? <Pill label='banir' danger onPress={act(onBan)} /> : null}
              {canReport && !own && !item.hidden ? <Pill label='denunciar' onPress={act(onReport)} /> : null}
            </View>
            )
          : null}
      </View>
      {hasActions
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={open ? 'fechar ações da mensagem' : 'ações da mensagem'}
            accessibilityState={{ expanded: open }}
            hitSlop={10}
            onPress={() => setOpen(!open)}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            <Text style={styles.moreText}>{open ? '×' : '…'}</Text>
          </Pressable>
          )
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 16
  },
  own: { backgroundColor: colors.card },
  body: { flex: 1, minWidth: 0, gap: 2 },
  head: { flexDirection: 'row', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
  name: { ...type.postName, color: colors.ink, flexShrink: 1 },
  meta: { ...type.postMeta, color: colors.soft },
  text: { fontSize: 16, lineHeight: 22, color: colors.ink },
  hidden: { color: colors.soft, fontStyle: 'italic' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 6 },
  more: { paddingHorizontal: 4, alignSelf: 'flex-start' },
  moreText: { fontSize: 20, lineHeight: 22, color: colors.soft },
  pressed: { opacity: 0.6 }
})
