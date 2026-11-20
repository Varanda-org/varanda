// The event editor of the composer and of Novo tópico: a title (1 to 80
// characters), when it starts, an optional end and an optional place (up to
// 120). The state lives with the screen (eventEditorInit); eventEditorEvent
// turns it into the { title, start, end, place } of the contract or says what
// is wrong, in pt-BR. Instants go out as UTC ISO strings and are shown to
// readers in their own local time. An event is never edited later: to change
// or cancel it the post is deleted. Every control is a 44 pt target.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { PLACE_MAX, TITLE_MAX, eventCard, instantMs } from '../events'
import { DateTimeField, fieldsOf, fieldsToMs } from './DateTimeField'
import { Field } from './index'
import { Icon } from './Icon'
import { layout, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// The contract keeps an event within 366 days (EVENT_MAX_SPAN_MS), by hand.
const SPAN_MS = 366 * DAY_MS

export const EVENT_NOTICE = 'O evento é público: quem vê o seu diário vê o evento e quem responde que vai.'

// Tomorrow at 19:00, so a first tap already has a valid event to write.
export function eventEditorInit (now = Date.now()) {
  const d = new Date(now + DAY_MS)
  d.setHours(19, 0, 0, 0)
  return { title: '', place: '', start: fieldsOf(d.getTime()), end: null }
}

// -> { ok: true, event } | { ok: false, error }
export function eventEditorEvent (state, now = Date.now()) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'Preencha o evento.' }
  const title = typeof state.title === 'string' ? state.title.trim() : ''
  const place = typeof state.place === 'string' ? state.place.trim() : ''
  if (title === '') return { ok: false, error: 'Dê um nome ao evento.' }
  if ([...title].length > TITLE_MAX) return { ok: false, error: 'O nome tem no máximo ' + TITLE_MAX + ' caracteres.' }
  if ([...place].length > PLACE_MAX) return { ok: false, error: 'O lugar tem no máximo ' + PLACE_MAX + ' caracteres.' }
  const startMs = fieldsToMs(state.start)
  if (startMs === null) return { ok: false, error: 'Confira a data e a hora de início.' }
  if (startMs <= now) return { ok: false, error: 'O início precisa ser no futuro.' }
  let endMs = null
  if (state.end !== null && state.end !== undefined) {
    endMs = fieldsToMs(state.end)
    if (endMs === null) return { ok: false, error: 'Confira a data e a hora de término.' }
    if (endMs <= startMs) return { ok: false, error: 'O término precisa ser depois do início.' }
    if (endMs - startMs > SPAN_MS) return { ok: false, error: 'O evento pode durar no máximo um ano.' }
  }
  const start = new Date(startMs).toISOString()
  const end = endMs === null ? null : new Date(endMs).toISOString()
  if (instantMs(start) === null || (end !== null && instantMs(end) === null)) return { ok: false, error: 'Use datas entre 2020 e 2099.' }
  const event = { title, start, end, place }
  return eventCard(event) === null ? { ok: false, error: 'Confira os dados do evento.' } : { ok: true, event }
}

// The texts a word check must read before sending.
export function eventEditorTexts (state) {
  return state && typeof state === 'object' ? [state.title, state.place].filter((x) => typeof x === 'string') : []
}

// state: eventEditorInit; onChange(next); onClose removes the event from the
// draft; disabled while a send runs.
export function EventEditor ({ state, onChange, onClose, disabled = false, now }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const change = typeof onChange === 'function' ? onChange : () => {}
  const s = state && typeof state === 'object' ? state : eventEditorInit()
  const check = eventEditorEvent(s)
  const touched = typeof s.title === 'string' && s.title.trim() !== ''
  const startMs = fieldsToMs(s.start)
  return (
    <View style={styles.box}>
      <View style={styles.head}>
        <View style={styles.headTitle}>
          <Icon name='evento' size={18} color={colors.accent} />
          <Text style={styles.title} accessibilityRole='header'>Evento</Text>
        </View>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='remover o evento'
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled || typeof onClose !== 'function'}
          onPress={onClose}
          hitSlop={4}
          style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
        >
          <Icon name='fechar' size={20} color={colors.soft} />
        </Pressable>
      </View>
      <Field
        value={s.title}
        editable={!disabled}
        maxLength={TITLE_MAX}
        placeholder='Nome do evento'
        inputProps={{ accessibilityLabel: 'nome do evento', placeholderTextColor: colors.placeholder }}
        onChangeText={(text) => change({ ...s, title: text.replace(/[\r\n]+/g, ' ') })}
      />
      <Field
        value={s.place}
        editable={!disabled}
        maxLength={PLACE_MAX}
        placeholder='Onde (opcional)'
        inputProps={{ accessibilityLabel: 'lugar do evento', placeholderTextColor: colors.placeholder }}
        onChangeText={(text) => change({ ...s, place: text.replace(/[\r\n]+/g, ' ') })}
      />
      <DateTimeField label='Começa' value={s.start} disabled={disabled} now={now} onChange={(start) => change({ ...s, start })} />
      {s.end === null || s.end === undefined
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='adicionar horário de término'
            accessibilityState={{ disabled: !!disabled }}
            disabled={disabled}
            onPress={() => change({ ...s, end: fieldsOf((startMs === null ? Date.now() : startMs) + 2 * HOUR_MS) })}
            style={({ pressed }) => [styles.add, pressed && styles.pressed]}
          >
            <Text style={styles.addText}>Adicionar término</Text>
          </Pressable>
          )
        : (
          <View style={styles.endBox}>
            <DateTimeField label='Termina' value={s.end} disabled={disabled} now={now} onChange={(end) => change({ ...s, end })} />
            <Pressable
              accessibilityRole='button'
              accessibilityLabel='tirar o horário de término'
              accessibilityState={{ disabled: !!disabled }}
              disabled={disabled}
              onPress={() => change({ ...s, end: null })}
              style={({ pressed }) => [styles.add, pressed && styles.pressed]}
            >
              <Text style={styles.addText}>Tirar término</Text>
            </Pressable>
          </View>
          )}
      <Text style={styles.hint}>{EVENT_NOTICE}</Text>
      {!check.ok && touched ? <Text style={styles.error} accessibilityLiveRegion='polite'>{check.error}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  box: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 12, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { ...type.postName, color: colors.ink },
  icon: { width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center' },
  endBox: { gap: 4 },
  add: { minHeight: layout.hit, justifyContent: 'center', alignSelf: 'flex-start' },
  addText: { ...type.more, color: colors.accent },
  hint: { ...type.meta, color: colors.soft },
  error: { ...type.meta, color: colors.danger },
  pressed: { opacity: 0.6 }
})
