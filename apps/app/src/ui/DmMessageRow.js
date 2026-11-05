// One private message as a bubble. Props: { item, onReply(), onReport(),
// now }. `item` is a row of dm-screen.js threadRows (text and quote already
// through displayText, deleted quotes already LABELS.deletedQuote, rawText
// the sender's own text) plus `mine` and `from`. The actions sit behind a
// long press / "mais" so a tap does nothing by surprise: only a link in the
// text opens the browser, and mentions stay plain here. Denunciar only
// appears on a row from the other person. Only LABELS.sent shows under an
// own message: no read, delivered or typing state.

import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { relativeTime } from '../format'
import { LABELS } from '../dm'
import { OPEN_INVITE, inviteLinkOf } from '../inviteMessage'
import { MentionText } from './MentionText'
import { Pill } from './Pill'
import { useStyles } from './ThemeProvider'
import { type } from './theme'

export function DmMessageRow ({ item, onReply, onReport, onOpenInvite, origin = '', now = Date.now(), shape = 'single', onMenuChange, menuKey }) {
  const styles = useStyles(makeStyles)
  const [open, setOpen] = useState(false)
  const setMenu = (next) => {
    setOpen(next)
    if (typeof onMenuChange === 'function') onMenuChange(next)
  }
  // Another row's menu replaced this one: close without reporting, the parent
  // already holds the new key.
  useEffect(() => {
    if (open && menuKey !== undefined && menuKey !== item.key) setOpen(false)
  }, [open, menuKey, item.key])
  const mine = item.mine === true
  const time = item.at ? relativeTime(item.at, now) : ''
  const act = (fn) => () => {
    setMenu(false)
    if (typeof fn === 'function') fn()
  }
  // A tap only opens the community or group screen, where the one-tap card lives.
  const link = item.deleted === true || typeof onOpenInvite !== 'function'
    ? null
    : item.inviteLink !== undefined ? item.inviteLink : inviteLinkOf(typeof item.rawText === 'string' ? item.rawText : item.text, origin)
  // Abrir convite is the in-app path, so its URL must not also open the browser.
  const linked = link === null && item.deleted !== true && typeof item.rawText === 'string'
  const actions = []
  if (typeof onReply === 'function') actions.push({ name: 'reply', label: 'Responder a esta mensagem' })
  if (!mine && typeof onReport === 'function') actions.push({ name: 'report', label: 'Denunciar esta mensagem' })
  const shownShape = open ? 'single' : shape
  const hasAbove = shownShape === 'middle' || shownShape === 'last'
  const hasBelow = shownShape === 'first' || shownShape === 'middle'
  const side = mine ? 'Right' : 'Left'
  const corners = {}
  if (hasAbove) corners['borderTop' + side + 'Radius'] = 6
  if (hasBelow) corners['borderBottom' + side + 'Radius'] = 6
  return (
    <View>
      {item.dayMark
        ? <View style={styles.dayRow}><Text style={styles.dayChip} accessibilityRole='header'>{item.dayMark}</Text></View>
        : null}
      <View style={[styles.row, mine && styles.mine, hasAbove && styles.rowTightTop, hasBelow && styles.rowTightBottom]}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='opções da mensagem'
          onLongPress={() => setMenu(!open)}
          accessibilityActions={actions}
          onAccessibilityAction={(e) => {
            const name = e && e.nativeEvent ? e.nativeEvent.actionName : ''
            if (name === 'reply' && typeof onReply === 'function') onReply()
            else if (name === 'report' && !mine && typeof onReport === 'function') onReport()
          }}
          style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs, corners]}
        >
          {item.replyTo !== null && item.replyTo !== undefined
            ? <View style={styles.quote}><Text style={styles.quoteText} numberOfLines={3}>{item.replyTo}</Text></View>
            : null}
          {linked
            ? <MentionText text={item.rawText} style={styles.text} selectable />
            : <Text style={styles.text} selectable>{item.text}</Text>}
          {hasBelow
            ? null
            : <Text style={styles.meta}>{mine ? LABELS.sent + (time ? ' · ' + time : '') : time}</Text>}
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
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 4, alignItems: 'flex-start', gap: 4 },
  rowTightTop: { paddingTop: 1 },
  rowTightBottom: { paddingBottom: 1 },
  mine: { alignItems: 'flex-end' },
  dayRow: { alignItems: 'center', paddingVertical: 8 },
  dayChip: { ...type.chip, color: colors.soft, backgroundColor: colors.skeleton, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
  bubble: { maxWidth: '82%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  bubbleMine: { backgroundColor: colors.accentSoft },
  bubbleTheirs: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 8 },
  quoteText: { fontSize: 13, color: colors.soft },
  text: { fontSize: 16, lineHeight: 22, color: colors.ink },
  meta: { fontSize: 11, color: colors.soft },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
})
