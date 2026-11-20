// The top of the Diário while a reminder set on this device is due: the
// soonest event that starts within 24 hours, with a tap to open its post and
// a dismiss. Only the reference and the start are stored (eventReminders.js);
// the title is read again from the post's own diary when the banner shows,
// and a post that is gone drops its reminder. In-app only: no notification.
// `now` ticks from the screen. Controls are 44 pt and nothing moves.

import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { eventCard } from '../events'
import { dueReminders } from '../eventReminders'
import { loadReminders, removeReminder } from '../eventRemindersStore'
import { peekAll } from '../screens/Conversa'
import { useReminderScope } from './EventCard'
import { Icon } from './Icon'
import { layout, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const refOf = (e) => e.author + ':' + e.seq

export function leadText (start, now) {
  const minutes = Math.max(0, Math.round((start - now) / 60000))
  if (minutes < 2) return 'começa agora'
  if (minutes < 60) return 'começa em ' + minutes + ' min'
  const hours = Math.round(minutes / 60)
  return 'começa em ' + hours + (hours === 1 ? ' hora' : ' horas')
}

// The title of a diary event post, from a diary.peek entry; a record without
// a valid event falls back to the first line of its text.
function titleOf (record) {
  const card = record && record.event ? eventCard(record.event) : null
  if (card !== null) return card.title
  const text = record && typeof record.text === 'string' ? record.text.split('\n')[0].trim() : ''
  return text === '' ? 'Evento' : text.slice(0, 80)
}

export function ReminderBanner ({ now, onOpenThread }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const scope = useReminderScope()
  const [entries, setEntries] = useState([])
  const [titles, setTitles] = useState({})
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const minute = Math.floor((typeof now === 'number' ? now : Date.now()) / 60000)
  const id = scope === null ? '' : scope.origin + '\n' + scope.key

  useEffect(() => {
    if (scope === null) { setEntries([]); return undefined }
    let live = true
    loadReminders(scope.origin, scope.key).then((list) => { if (live && alive.current) setEntries(Array.isArray(list) ? list : []) }, () => {})
    return () => { live = false }
  }, [id, minute])

  const at = typeof now === 'number' ? now : Date.now()
  const due = dueReminders(entries, at)
  const first = due.length > 0 ? due[0] : null
  const firstRef = first === null ? '' : refOf(first)

  useEffect(() => {
    if (first === null || scope === null || titles[firstRef] !== undefined) return undefined
    let live = true
    const peeked = new Map()
    peekAll(node.request, [{ author: first.author, seqs: [first.seq] }], peeked, () => live && alive.current).then(() => {
      if (!live || !alive.current) return
      const peek = peeked.get(first.author)
      const entry = peek && Array.isArray(peek.entries) ? peek.entries.find((e) => e && e.seq === first.seq && e.record && e.record.type === 'post') : null
      if (entry) {
        setTitles((t) => ({ ...t, [firstRef]: titleOf(entry.record) }))
      } else if (peek) {
        // Only a peek that answered without the post means it is gone; a busy
        // or unreachable diary keeps the reminder for the next minute.
        removeReminder(scope.origin, scope.key, { author: first.author, seq: first.seq }).then(() => {
          if (live && alive.current) setEntries((list) => list.filter((e) => refOf(e) !== firstRef))
        }, () => {})
      }
    }, () => {})
    return () => { live = false }
  }, [firstRef, id, minute])

  if (first === null || scope === null || titles[firstRef] === undefined) return null
  const title = displayText(titles[firstRef])
  const lead = leadText(first.start, at)
  const more = due.length - 1
  const spoken = 'Lembrete: ' + title + ', ' + lead + (more > 0 ? ', e mais ' + more : '')
  return (
    <View style={styles.banner}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={spoken + ', abre a publicação'}
        onPress={() => { if (typeof onOpenThread === 'function') onOpenThread({ ref: firstRef }) }}
        style={({ pressed }) => [styles.body, pressed && styles.pressed]}
      >
        <Icon name='relogio' size={20} color={colors.accent} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={1.3}>{title}</Text>
          <Text style={styles.meta} maxFontSizeMultiplier={1.3}>{lead + (more > 0 ? ' · e mais ' + more : '')}</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='dispensar o lembrete'
        onPress={() => {
          removeReminder(scope.origin, scope.key, { author: first.author, seq: first.seq }).then(() => {
            if (alive.current) setEntries((list) => list.filter((e) => refOf(e) !== firstRef))
          }, () => {})
        }}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
      >
        <Icon name='fechar' size={20} color={colors.soft} />
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginVertical: 8, borderRadius: 14, backgroundColor: colors.accentSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent },
  body: { flex: 1, minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12, paddingVertical: 8 },
  text: { flex: 1, minWidth: 0 },
  title: { ...type.postName, color: colors.ink },
  meta: { ...type.meta, color: colors.soft },
  close: { width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 }
})
