// The event of a post: a date badge, the title, when and where (the reader's
// local time), and, on a hosted node, 'Vou' and 'Talvez' (the same one again
// takes the answer back), 'quem vai' and a reminder kept on this device. The
// calendar file ('Adicionar à agenda') is offered only where the platform can
// hand one over (calendarExportAvailable).
//
// Two sources, told apart by `group`: a diary event (group null) reads the own
// answer from the own diary and the totals from the seeder (a claim, said
// so); a group event gets totals and `mine` from the member's own node, which
// folded them, and answers with the group's own methods. An answer is public
// (it sits in the diary), so the notice shows before the first one. An answer
// is never resent: a failure tells the person and they decide. Title, place
// and names are peer text and go through displayText. No motion.
//
// Acting as a Page (diary events only), the answer is the page's: its own
// answer comes from the page's status read and it answers with the page
// action 'choice'; after an unknown outcome the same answer tapped again
// resends the signed one.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { installationOrigin } from '../installation'
import { validOrigin } from '../feiraLink'
import { fetchPoll, fetchPollVoters } from '../indexClient'
import { eventCard, isPast, whenText } from '../events'
import { buildIcs } from '../ics'
import { calendarExportAvailable, exportCalendar } from '../calendarExport'
import { hasReminder, removeReminder, setReminder } from '../eventRemindersStore'
import { whoOf } from '../who'
import { confirmedVoters, voterSeqs } from './pollVoters'
import { learnPeeked, peekAll, readPagePick, setPagePick, useActing } from '../screens/Conversa'
import { PAGE_PICK_UNREAD, PAGE_RSVP_NOTICE, PAGE_RSVP_UNCERTAIN, choiceNotice, choicePage, pickRef, refusalText, tapAfterUncertain } from '../pageChoice'
import { Icon } from './Icon'
import { tap } from './haptics'
import { layout, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const HEX64 = /^[0-9a-f]{64}$/
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const GOING = 0
const MAYBE = 1
const NOTICE = 'Sua resposta é pública: quem vê o seu diário pode ver se você vai.'
const FAILED = 'Não deu para registrar a resposta. Tente de novo.'
const VOTERS_FAILED = 'Não deu para ver quem vai agora.'
const NO_VOTERS = 'Ninguém conferido ainda.'
const NOT_HOSTED = 'Para responder, use a versão web do Varanda.'
const CLAIM = 'A contagem vem do semeador e pode estar incompleta.'
const REMINDER_NOTE = 'O lembrete aparece no seu Diário nas 24 horas antes do evento. Fica só neste aparelho.'
const REMINDER_FULL = 'Você já tem muitos lembretes. Tire algum para criar outro.'
const REMINDER_FAILED = 'Não deu para guardar o lembrete neste aparelho.'
const CALENDAR_FAILED = 'Não deu para gerar o arquivo da agenda.'

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// { origin, key } of this installation and the own diary, or null where no
// reminder can be kept (not hosted, or the account is not known yet).
export function useReminderScope () {
  const node = useNode()
  const status = node.passkey && node.passkey.status ? node.passkey.status : null
  const key = status && typeof status.publicKey === 'string' ? status.publicKey.toLowerCase() : ''
  if (node.hosted !== true || !HEX64.test(key)) return null
  const origin = installationOrigin() || (globalThis.location && globalThis.location.origin) || null
  return validOrigin(origin) ? { origin, key } : null
}

function counts (totals) {
  if (!Array.isArray(totals) || totals.length !== 2) return ''
  const [going, maybe] = totals
  if (!Number.isSafeInteger(going) || !Number.isSafeInteger(maybe)) return ''
  if (going === 0 && maybe === 0) return 'Ninguém respondeu ainda'
  return (going === 1 ? '1 pessoa vai' : going + ' pessoas vão') + (maybe > 0 ? ' · ' + maybe + ' talvez' : '')
}

// author: the post's diary key; seq: its seq; event: the event value.
// Group mode: group (hex64), writer (hex64), totals [going, maybe], mine
// (0, 1 or null) and onChanged() to re-read after an answer.
export function EventCard ({ author, seq, event, group = null, writer = null, totals = null, mine = null, onChanged, now }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const names = useNames()
  const scope = useReminderScope()
  const key = typeof author === 'string' ? author.toLowerCase() : ''
  const grouped = group !== null && HEX64.test(String(group)) && HEX64.test(String(writer))
  const valid = HEX64.test(key) && Number.isSafeInteger(seq) && seq > 0
  const hosted = node.hosted === true && valid
  const page = choicePage(useActing())
  const ref = pickRef(key, seq)
  const online = node.online !== false
  const { request } = node
  const card = eventCard(event)
  const [own, setOwn] = useState(undefined)
  const [claim, setClaim] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unread, setUnread] = useState(false)
  const [open, setOpen] = useState(null)
  const [voters, setVoters] = useState({ phase: 'idle', rows: [] })
  const [reminder, setReminderOn] = useState(false)
  const [note, setNote] = useState('')
  // A group event's seq is on the group writer core, not on a diary, and the
  // banner resolves reminders with diary.peek, so group events keep none.
  const remindable = scope !== null && valid && !grouped
  const gen = useRef(0)
  const retryRef = useRef(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const nodeRef = useRef(node)
  nodeRef.current = node
  const pageRef = useRef(page)
  pageRef.current = page

  // Another identity's answer is never shown: unread until this one's is.
  useEffect(() => { setOwn(undefined); setError(''); setUnread(false); retryRef.current = null }, [page])

  const readClaim = useCallback(async () => {
    if (grouped || !hosted || !online) return
    const res = await fetchPoll(key, seq, 2)
    if (alive.current && res.ok) setClaim(res.value)
  }, [grouped, hosted, online, key, seq])

  useEffect(() => {
    if (grouped || !hosted || !online) return undefined
    let live = true
    if (page !== null) {
      // Two picks: 0 'vou', 1 'talvez'.
      readPagePick(nodeRef.current, page, ref, 2).then((pick) => {
        if (live && alive.current) { setUnread(false); setOwn(pick) }
      }, () => { if (live && alive.current) setUnread(true) })
    } else {
      request('choice.mine', { to: { author: key, seq } }).then((r) => {
        if (live && alive.current && isObject(r)) setOwn(Number.isSafeInteger(r.pick) ? r.pick : null)
      }, () => {})
    }
    readClaim()
    return () => { live = false }
  }, [grouped, hosted, online, request, key, seq, readClaim, page, ref])

  useEffect(() => {
    if (!remindable) return undefined
    let live = true
    hasReminder(scope.origin, scope.key, { author: key, seq }).then((v) => { if (live && alive.current) setReminderOn(v === true) }, () => {})
    return () => { live = false }
  }, [scope && scope.origin, scope && scope.key, key, seq, remindable])

  if (card === null) return null
  const at = typeof now === 'number' ? now : Date.now()
  const past = isPast(card, at)
  const pick = grouped ? (Number.isSafeInteger(mine) ? mine : null) : own
  const known = grouped || own !== undefined
  const shownTotals = grouped ? totals : claim && claim.totals.length === 2 ? claim.totals : null
  const start = new Date(card.startMs)
  const when = whenText(card)
  const title = displayText(card.title)
  const place = card.place === '' ? '' : displayText(card.place)

  const answer = async (index) => {
    if (busy || !known) return
    const next = pick === index ? null : index
    setBusy(true)
    setError('')
    tap('light')
    const pending = retryRef.current
    retryRef.current = null
    const asPage = !grouped && page !== null
    try {
      if (grouped) await request('group.choose', { group, target: { writer, seq }, pick: next })
      else if (asPage) await (tapAfterUncertain(pending, { page, ref, pick: next }) === 'resend' ? pending.retry() : setPagePick(nodeRef.current, page, ref, next))
      else await request('choice.set', { to: { author: key, seq }, pick: next })
      // The identity changed while it was in flight: the answer is not this one's.
      if (!alive.current || (!grouped && pageRef.current !== page)) return
      if (!grouped) { setOwn(next); readClaim() }
      if (typeof onChanged === 'function') onChanged()
    } catch (err) {
      if (!alive.current || (!grouped && pageRef.current !== page)) return
      if (asPage && err && err.uncertain === true) {
        if (typeof err.retry === 'function') retryRef.current = { page, ref, pick: next, retry: err.retry }
        setError(PAGE_RSVP_UNCERTAIN)
      } else {
        setError(asPage ? refusalText(err, FAILED) : FAILED)
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const showVoters = async (index) => {
    if (open === index) { gen.current++; setOpen(null); return }
    const mineGen = ++gen.current
    setOpen(index)
    setVoters({ phase: 'loading', rows: [] })
    const fail = () => { if (mineGen === gen.current) setVoters({ phase: 'error', rows: [] }) }
    try {
      if (grouped) {
        const res = await request('group.voters', { group, target: { writer, seq } })
        if (mineGen !== gen.current) return
        const list = res && Array.isArray(res.voters) ? res.voters.find((v) => v && v.pick === index) : null
        const keys = list && Array.isArray(list.by) ? list.by.filter((k) => typeof k === 'string' && HEX64.test(k)) : []
        if (keys.length > 0 && names && typeof names.resolveMany === 'function') names.resolveMany(keys)
        setVoters({ phase: 'ready', rows: keys.map((k) => ({ key: k })) })
        return
      }
      const res = await fetchPollVoters(key, seq, index)
      if (mineGen !== gen.current) return
      if (!res.ok) return fail()
      const peeked = new Map()
      for (const it of res.value.items) await peekAll(request, [{ author: it.key, seqs: voterSeqs(it.seq) }], peeked, () => mineGen === gen.current)
      if (mineGen !== gen.current) return
      learnPeeked(names.learnMany, peeked)
      setVoters({ phase: 'ready', rows: confirmedVoters(res.value.items, peeked, key, seq, index) })
    } catch {
      fail()
    }
  }

  const toggleReminder = async () => {
    if (!remindable) return
    setNote('')
    tap('light')
    if (reminder) {
      const ok = await removeReminder(scope.origin, scope.key, { author: key, seq })
      if (alive.current) { if (ok) setReminderOn(false); else setNote(REMINDER_FAILED) }
      return
    }
    const r = await setReminder(scope.origin, scope.key, { author: key, seq }, card.startMs)
    if (!alive.current) return
    if (r.ok && r.persisted) setReminderOn(true)
    else setNote(r.reason === 'full' || r.reason === 'scopes' ? REMINDER_FULL : REMINDER_FAILED)
  }

  const addToCalendar = () => {
    setNote('')
    const done = exportCalendar(buildIcs({ card, uid: key + '-' + seq }))
    if (!done || done.ok !== true) setNote(CALENDAR_FAILED)
  }

  const canAnswer = hosted && online && known && !busy && !past
  const chip = (index, label) => (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label + (pick === index ? (page !== null && !grouped ? ', resposta da Página, toque para tirar' : ', sua resposta, toque para tirar') : '')}
      accessibilityState={{ selected: pick === index, disabled: !canAnswer }}
      disabled={!canAnswer}
      onPress={() => answer(index)}
      style={({ pressed }) => [styles.chip, pick === index && styles.chipOn, !canAnswer && styles.chipOff, pressed && styles.pressed]}
    >
      {pick === index ? <Icon name='ok' size={16} color={colors.accent} /> : null}
      <Text style={[styles.chipText, pick === index && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  )
  const total = counts(shownTotals)
  const spoken = title + ', ' + when + (place ? ', ' + place : '') + (past ? ', já passou' : '')

  return (
    <View style={styles.card} accessibilityLabel={spoken}>
      <View style={styles.top}>
        <View style={[styles.badge, past && styles.badgePast]} importantForAccessibility='no-hide-descendants' accessibilityElementsHidden>
          <Text style={[styles.badgeMonth, past && styles.badgeTextPast]}>{MONTHS[start.getMonth()]}</Text>
          <Text style={[styles.badgeDay, past && styles.badgeTextPast]}>{start.getDate()}</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={3} maxFontSizeMultiplier={1.3}>{title}</Text>
          <Text style={styles.meta} maxFontSizeMultiplier={1.3}>{when}</Text>
          {place ? <Text style={styles.meta} numberOfLines={2} maxFontSizeMultiplier={1.3}>{place}</Text> : null}
          {past ? <Text style={styles.past}>já passou</Text> : null}
        </View>
      </View>
      {hosted && !past
        ? (
          <View style={styles.row}>
            {chip(GOING, 'Vou')}
            {chip(MAYBE, 'Talvez')}
          </View>
          )
        : null}
      {!hosted ? <Text style={styles.note}>{NOT_HOSTED}</Text> : null}
      {hosted && online && !past && pick === null && known ? <Text style={styles.note}>{!grouped && page !== null ? choiceNotice(page, NOTICE, PAGE_RSVP_NOTICE) : NOTICE}</Text> : null}
      {!grouped && page !== null && unread && hosted && online ? <Text style={styles.note} accessibilityLiveRegion='polite'>{PAGE_PICK_UNREAD}</Text> : null}
      {hosted && online && total ? <Text style={styles.note}>{total + (grouped ? '' : '. ' + CLAIM)}</Text> : null}
      {hosted && online && shownTotals !== null
        ? (
          <View style={styles.row}>
            {shownTotals[GOING] > 0 ? <Pressable accessibilityRole='button' accessibilityLabel='quem vai' accessibilityState={{ expanded: open === GOING }} onPress={() => showVoters(GOING)} style={({ pressed }) => [styles.link, pressed && styles.pressed]}><Text style={styles.linkText}>quem vai</Text></Pressable> : null}
            {shownTotals[MAYBE] > 0 ? <Pressable accessibilityRole='button' accessibilityLabel='quem talvez vá' accessibilityState={{ expanded: open === MAYBE }} onPress={() => showVoters(MAYBE)} style={({ pressed }) => [styles.link, pressed && styles.pressed]}><Text style={styles.linkText}>quem talvez</Text></Pressable> : null}
          </View>
          )
        : null}
      {open !== null ? <Voters state={voters} names={names} grouped={grouped} /> : null}
      {remindable && !past
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={reminder ? 'Lembrete ligado neste aparelho, toque para desligar' : 'Lembrar neste aparelho'}
            accessibilityState={{ selected: reminder }}
            onPress={toggleReminder}
            style={({ pressed }) => [styles.link, styles.linkRow, pressed && styles.pressed]}
          >
            <Icon name='relogio' size={16} color={colors.accent} />
            <Text style={styles.linkText}>{reminder ? 'Lembrete ligado' : 'Lembrar neste aparelho'}</Text>
          </Pressable>
          )
        : null}
      {remindable && !past && !reminder ? <Text style={styles.note}>{REMINDER_NOTE}</Text> : null}
      {calendarExportAvailable && valid
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel='Adicionar à agenda' onPress={addToCalendar} style={({ pressed }) => [styles.link, styles.linkRow, pressed && styles.pressed]}>
            <Icon name='evento' size={16} color={colors.accent} />
            <Text style={styles.linkText}>Adicionar à agenda</Text>
          </Pressable>
          )
        : null}
      {note ? <Text style={styles.error} accessibilityLiveRegion='polite'>{note}</Text> : null}
      {error ? <Text style={styles.error} accessibilityLiveRegion='polite'>{error}</Text> : null}
    </View>
  )
}

function Voters ({ state, names, grouped }) {
  const styles = useStyles(makeStyles)
  if (state.phase === 'loading') return <Text style={styles.note}>Conferindo…</Text>
  if (state.phase === 'error') return <Text style={styles.note}>{VOTERS_FAILED}</Text>
  if (state.rows.length === 0) return <Text style={styles.note}>{NO_VOTERS}</Text>
  return (
    <View style={styles.voters}>
      {state.rows.map((row) => {
        const known = names.profileOf(row.key)
        const who = whoOf(known && (known.name || known.username) ? known : { name: grouped ? null : row.name, username: grouped ? null : row.username })
        return <Text key={row.key} style={styles.voter} numberOfLines={1}>{displayText(who.title)}</Text>
      })}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { marginTop: 8, padding: 12, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.card },
  top: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  badge: { width: 52, paddingVertical: 6, borderRadius: 12, alignItems: 'center', backgroundColor: colors.accentSoft },
  badgePast: { backgroundColor: colors.line },
  badgeMonth: { ...type.section, color: colors.accent },
  badgeDay: { ...type.price, color: colors.accent },
  badgeTextPast: { color: colors.soft },
  info: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...type.tileTitle, color: colors.ink },
  meta: { ...type.meta, color: colors.soft },
  past: { ...type.meta, color: colors.soft, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: layout.hit, minWidth: 96, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.bg },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipOff: { opacity: 0.55 },
  chipText: { ...type.pill, color: colors.ink },
  chipTextOn: { color: colors.accent },
  link: { minHeight: layout.hit, justifyContent: 'center', alignSelf: 'flex-start' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkText: { ...type.more, color: colors.accent },
  note: { ...type.meta, color: colors.soft },
  error: { ...type.meta, color: colors.danger },
  voters: { gap: 2, paddingLeft: 12 },
  voter: { ...type.meta, color: colors.ink },
  pressed: { opacity: 0.6 }
})
