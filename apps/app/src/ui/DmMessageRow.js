// One private message as a bubble. Props: { item, onReply(), onReport(),
// now }. `item` is a row of dm.js threadOf (text and quote already through
// displayText, deleted quotes already LABELS.deletedQuote) plus `mine` and
// `from`. The actions sit behind a long press / "mais" so a tap does nothing
// by surprise. Denunciar only appears on a row from the other person. Only
// LABELS.sent shows under an own message: no read, delivered or typing state.

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { relativeTime } from '../format'
import { LABELS } from '../dm'
import { OPEN_INVITE, inviteLinkOf } from '../inviteMessage'
import { Pill } from './Pill'
import { colors } from './theme'

export function DmMessageRow ({ item, onReply, onReport, onOpenInvite, origin = '', now = Date.now() }) {
  const [open, setOpen] = useState(false)
  const mine = item.mine === true
  const time = item.at ? relativeTime(item.at, now) : ''
  const act = (fn) => () => {
    setOpen(false)
    if (typeof fn === 'function') fn()
  }
  // A tap only opens the community or group screen, where the one-tap card lives.
  const link = item.deleted === true || typeof onOpenInvite !== 'function'
    ? null
    : inviteLinkOf(typeof item.rawText === 'string' ? item.rawText : item.text, origin)
  const actions = []
  if (typeof onReply === 'function') actions.push({ name: 'reply', label: 'Responder a esta mensagem' })
  if (!mine && typeof onReport === 'function') actions.push({ name: 'report', label: 'Denunciar esta mensagem' })
  return (
    <View style={[styles.row, mine && styles.mine]}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='opções da mensagem'
        onLongPress={() => setOpen((v) => !v)}
        accessibilityActions={actions}
        onAccessibilityAction={(e) => {
          const name = e && e.nativeEvent ? e.nativeEvent.actionName : ''
          if (name === 'reply' && typeof onReply === 'function') onReply()
          else if (name === 'report' && !mine && typeof onReport === 'function') onReport()
        }}
        style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}
      >
        {item.replyTo !== null && item.replyTo !== undefined
          ? <View style={styles.quote}><Text style={styles.quoteText} numberOfLines={3}>{item.replyTo}</Text></View>
          : null}
        <Text style={styles.text} selectable>{item.text}</Text>
        <Text style={styles.meta}>{mine ? LABELS.sent + (time ? ' · ' + time : '') : time}</Text>
      </Pressable>
      {link !== null ? <Pill label={OPEN_INVITE} accessibilityLabel={OPEN_INVITE + (link.kind === 'grupo' ? ', abre o grupo' : ', abre a comunidade')} onPress={() => onOpenInvite(link)} /> : null}
      {open
        ? (
          <View style={styles.actions}>
            {typeof onReply === 'function' ? <Pill label={LABELS.reply} onPress={act(onReply)} /> : null}
            {!mine && typeof onReport === 'function' ? <Pill label={LABELS.report} danger onPress={act(onReport)} /> : null}
          </View>
          )
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 4, alignItems: 'flex-start', gap: 4 },
  mine: { alignItems: 'flex-end' },
  bubble: { maxWidth: '82%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  bubbleMine: { backgroundColor: colors.accentSoft },
  bubbleTheirs: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 8 },
  quoteText: { fontSize: 13, color: colors.soft },
  text: { fontSize: 16, lineHeight: 22, color: colors.ink },
  meta: { fontSize: 11, color: colors.soft },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
})
