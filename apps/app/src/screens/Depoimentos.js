// Depoimentos (docs/rpc.md 5.100): a profile's approved depoimentos, pushed
// above the tabs (App.js stack entry { screen: 'depoimentos', key: owner }).
// For the own key the screen also lists the ones waiting for approval
// (testimonial.pending), each with 'Mostrar no perfil' (testimonial.show)
// and 'Agora não' (a hide on this device only, src/testimonialHide.js: no
// record), and 'Enviados', the own live testimonial blocks (sentRows) with
// 'Retirar' (testimonial.delete of that block).
//
// The shown rows come from the seeder index (pointers only) and are read
// with diary.peek: the node verifies every show against the live writer
// block and leaves failed ones out, and rowsFrom keeps only a show whose
// writer block is live and addressed to the owner. Everything here runs only
// on a hosted node (node.hosted === true): the core node has no diary.peek.
// No mutating request is ever resent automatically: after a failure (or an
// uncertain outcome) the state is read again and the person decides.
//
// Also exported for Membro and Diario: the profile's Depoimentos tab
// (useTestimonialTab), the hook that loads it, the write sheet and the
// confirmation sheet.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { LOG_LIMIT_MAX, PEEK_SEQS_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { fetchTestimonials } from '../indexClient'
import { pendingIncomplete, pendingRows, rowsFrom, sentRows } from '../testimonials'
import { visiblePending } from '../testimonialHide'
import { hideTestimonial, loadTestimonialHidden } from '../testimonialHideStore'
import { relativeTime } from '../format'
import { diaryPeekSlots } from '../engagement'
import { whoOf } from '../who'
import { ConfirmStack, ErrorText, Label, Soft, UNCERTAIN, errorText, useBottomPad, useNow } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet, TEXT_CAP } from '../ui/Sheet'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TestimonialRow } from '../ui/TestimonialRow'
import { TopBar } from '../ui/TopBar'
import { type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { KeyboardForm } from './Perfil'

export const TESTIMONIAL_TEXT_MAX = 400
// The field's maxLength counts UTF-16 units on the web: 400 code points take
// up to 800 of them (emoji). The counter and Enviar enforce the real limit.
export const TESTIMONIAL_FIELD_MAX = 2 * TESTIMONIAL_TEXT_MAX
export const APPROVAL_NOTE = 'Só aparece no perfil depois que a pessoa aprovar.'
// Own log pages read for 'Enviados' (LOG_LIMIT_MAX blocks each) per read:
// the first load and each 'Ver mais'.
const SENT_PAGES = 8
// Show pointers the seeder index carries per owner (docs/rpc.md 5.100).
const SHOWN_POINTERS_MAX = 64
// The own tab's way into the screen, where the sent ones are managed.
export const SENT_LABEL = 'Enviados'
// The profile tab, shown only on a hosted node (node.hosted === true).
export const TESTIMONIALS_TAB = { id: 'depoimentos', label: 'Depoimentos' }
export const EMPTY_TITLE = 'Nenhum depoimento ainda'
export const WRITE_HINT = 'Toque em ⋯ no perfil para escrever um depoimento.'
// Sheet titles stay short and fixed (a name would be cut on a phone); the
// person's name goes in the body.
export const WRITE_TITLE = 'Escrever depoimento'
export const RETRACT_TITLE = 'Retirar depoimento?'
export const REMOVE_TITLE = 'Remover do perfil?'
// The write sheet's counter turns to the warning colour from here.
export const COUNTER_WARN = 380
const UNAVAILABLE = 'Depoimentos indisponíveis agora.'
// A short or empty list while the seeder was still indexing, or the pending
// read skipped a writer: never presented as everything.
export const INCOMPLETE_NOTE = 'Alguns depoimentos podem faltar.'
// A write that may have gone out: the sheet closes and the profile stops
// offering 'Escrever depoimento' for this visit, so a second tap cannot
// publish a duplicate (testimonial.write does not deduplicate).
export const WRITE_UNCERTAIN = 'Não sabemos se o depoimento foi enviado. Confira em Enviados, no seu Diário.'

const HEX64 = /^[0-9a-f]{64}$/

// A failure text for a mutating request: an uncertain one may have been
// applied, so it says to check before trying again.
export function failureText (err) {
  return err && err.uncertain === true ? UNCERTAIN : errorText(err)
}

// The seeder index's own word that it may be short (docs/rpc.md 5.100).
export function indexIncomplete (index) {
  return !!index && (index.indexing === true || index.complete === false)
}

// The tab's footer: the hosted-only note, an incomplete note with its retry
// (never 'Fim' or the empty state while the index is short), the end of a
// list, a failure, the skeleton or the empty state.
export function tabFooterKind ({ enabled, rowCount, failed, phase, incomplete }) {
  if (!enabled) return 'off'
  if (phase === 'ready' && incomplete === true && !failed) return 'incomplete'
  if (rowCount > 0) return 'end'
  if (failed || phase === 'error') return 'error'
  if (phase !== 'ready') return 'loading'
  return 'empty'
}

export function pendingLabel (n) {
  return 'Depoimentos para aprovar (' + n + ')'
}

// Code points, as the node counts the 400 limit (not UTF-16 units).
export function textLength (text) {
  return typeof text === 'string' ? [...text].length : 0
}

// The write box: five 22 pt lines to start (as Field lines={5}), and it
// scrolls inside itself past about six.
export const WRITE_MIN_HEIGHT = 5 * 22 + 20
export const WRITE_MAX_HEIGHT = 6 * 22 + 20

export function counterLabel (n) {
  return n + '/' + TESTIMONIAL_TEXT_MAX
}

const named = (name) => typeof name === 'string' && name.length > 0

// The write field's label names the person.
export function writeLabel (name) {
  return named(name) ? 'Para ' + name : 'Depoimento'
}

export const RETRACT_BODY = 'O depoimento deixa de valer e some do perfil da pessoa, se estiver lá.'

export function retractBody (name) {
  return named(name) ? 'O depoimento para ' + name + ' deixa de valer e some do perfil da pessoa, se estiver lá.' : RETRACT_BODY
}

export function removeBody (name) {
  return named(name) ? 'O depoimento de ' + name + ' deixa de aparecer no seu perfil.' : 'O depoimento deixa de aparecer no seu perfil.'
}

// The empty tab's line: only on someone else's profile, and only when the
// viewer can write one there.
export function emptyBody ({ own, canWrite }) {
  return !own && canWrite === true ? WRITE_HINT : undefined
}

// The tab's rows, in order: on the own profile the pinned approval row
// (N > 0) and 'Enviados'; a failed read that kept rows on screen, with its
// retry; then every shown depoimento, newest first (rowsFrom's order).
export function tabItems ({ rows, pendingCount = 0, own, failed = false, error = null, canOpen = false }) {
  const items = []
  if (own && pendingCount > 0 && canOpen) items.push({ kind: 'link', key: 'l:pending', label: pendingLabel(pendingCount), icon: 'mensagem' })
  if (own && canOpen) items.push({ kind: 'link', key: 'l:sent', label: SENT_LABEL, icon: 'encaminhar' })
  const list = Array.isArray(rows) ? rows : []
  if (failed && list.length > 0) items.push({ kind: 'retry', key: 'e:shown', text: error })
  for (const row of list) items.push({ kind: 'row', key: 's:' + row.ref, row })
  return items
}

// The own live block among the index pointers, as the ref to delete, or
// null. A hint from an untrusted seeder: every retract passes `about` (the
// person the depoimento is to), so the node refuses a ref to any other own
// block (a show, or a depoimento to someone else).
export function ownBlockRef (index, ownKey) {
  if (!index || typeof ownKey !== 'string' || !HEX64.test(ownKey)) return null
  const shown = Array.isArray(index.shown) ? index.shown.find((r) => r && r.from === ownKey) : null
  if (shown) return ownKey + ':' + shown.wseq
  const pending = Array.isArray(index.pending) ? index.pending.find((r) => r && r.from === ownKey) : null
  return pending ? ownKey + ':' + pending.seq : null
}

// Profile sections reload after a show, a removal or a write elsewhere.
const listeners = new Set()
export function testimonialsChanged () {
  for (const fn of [...listeners]) {
    try { fn() } catch {}
  }
}
function useChanged () {
  const [n, setN] = useState(0)
  useEffect(() => {
    const fn = () => setN((x) => x + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return n
}

// The node answers 'ocupado' beyond its peek limit (docs/rpc.md 5.27), so
// every peek of this module (and testimonial.pending, which peeks inside the
// node) goes through the app-wide diaryPeekSlots, one at a time, as Conversa
// and A Rua do.
// One diary.peek caps the seqs at PEEK_SEQS_MAX (docs/rpc.md 5.27): read
// them in serial chunks and merge the entries, `invalid` and `unverified`
// into the first answer (which carries the profile and username hints). A
// failed chunk throws.
const seqList = (v) => Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x) && x >= 1) : []
export function mergePeek (merged, page) {
  const entries = page && Array.isArray(page.entries) ? page.entries : []
  const invalid = seqList(page && page.invalid)
  const unverified = seqList(page && page.unverified)
  if (merged === null) return { ...page, entries: entries.slice(), invalid, unverified }
  return { ...merged, entries: merged.entries.concat(entries), invalid: merged.invalid.concat(invalid), unverified: merged.unverified.concat(unverified) }
}

async function peekAll (request, author, seqs) {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b)
  let merged = null
  for (let i = 0; i < sorted.length; i += PEEK_SEQS_MAX) {
    const page = await diaryPeekSlots.run(() => request('diary.peek', { author, seqs: sorted.slice(i, i + PEEK_SEQS_MAX) }))
    merged = mergePeek(merged, page)
  }
  return merged
}

// A show whose writer's diary could not be read is `unverified` (docs/rpc.md
// 5.27): the list is not everything, never "no depoimento".
export function shownIncomplete (indexIncomplete, peek) {
  return indexIncomplete === true || (!!peek && Array.isArray(peek.unverified) && peek.unverified.length > 0)
}

// Two readers, each peek through diaryPeekSlots (one at a time), so the app
// stays within the node's limit (docs/rpc.md 5.27 answers 'ocupado' beyond); testimonial.pending
// waits for the shown reads. A failed writer read is never 'no testimonial': the
// queue stops, the reads in flight end and the first failure is thrown, so
// the tab shows the error with 'Tentar de novo'.
async function peekWriters (request, byWriter) {
  const out = new Map()
  const queue = [...byWriter]
  let failure = null
  const worker = async () => {
    while (queue.length > 0 && failure === null) {
      const [from, set] = queue.shift()
      try {
        out.set(from, await peekAll(request, from, [...set]))
      } catch (err) {
        if (failure === null) failure = err || new Error(UNAVAILABLE)
      }
    }
  }
  await Promise.all([worker(), worker()])
  if (failure !== null) throw failure
  return out
}

async function readShown (request, owner) {
  const res = await fetchTestimonials(owner)
  if (!res.ok) throw new Error(UNAVAILABLE)
  const index = res.value
  const incomplete = indexIncomplete(index)
  const shown = index.shown.slice().sort((a, b) => b.seq - a.seq).slice(0, SHOWN_POINTERS_MAX)
  if (shown.length === 0) return { index, rows: [], incomplete }
  const peek = await peekAll(request, owner, shown.map((s) => s.seq))
  const byWriter = new Map()
  for (const e of Array.isArray(peek && peek.entries) ? peek.entries : []) {
    const r = e && e.record
    if (!r || r.type !== 'testimonial-show' || typeof r.from !== 'string' || !HEX64.test(r.from) || r.from === owner) continue
    if (!Number.isSafeInteger(r.seq) || r.seq < 1) continue
    if (!byWriter.has(r.from)) byWriter.set(r.from, new Set())
    byWriter.get(r.from).add(r.seq)
  }
  const writers = await peekWriters(request, byWriter)
  return { index, rows: rowsFrom(peek, owner, writers), incomplete: shownIncomplete(incomplete, peek) }
}

// Up to SENT_PAGES own log pages from `start` (undefined: the newest).
// `before` is the cursor for 'Ver mais' while more of the log remains,
// null once it ended.
async function readSentPages (request, start) {
  const pages = []
  let before = start
  for (let i = 0; i < SENT_PAGES; i++) {
    const page = await request('log.read', before === undefined ? { limit: LOG_LIMIT_MAX } : { limit: LOG_LIMIT_MAX, before })
    pages.push(page)
    const seqs = [...(page.entries || []).map((e) => e.seq), ...(page.invalid || []).map((e) => e.seq)]
    if (!(page.entriesTruncated > 0) || seqs.length === 0) return { pages, before: null }
    before = Math.min(...seqs)
  }
  return { pages, before }
}

// The data behind the profile tab or the screen. `withPending` (own key)
// also reads testimonial.pending and the device hides; `withSent` the own
// sent blocks. Nothing runs unless the node is hosted.
export function useTestimonials (owner, { ownKey = null, withPending = false, withSent = false, tick = 0, active = true } = {}) {
  const node = useNode()
  const { request } = node
  // A ref: the names context changes whenever a profile resolves, and the
  // loads must not run again (and reset 'Ver mais') when one does.
  const names = useNames()
  const namesRef = useRef(names)
  namesRef.current = names
  const hosted = node.hosted === true
  const online = node.online !== false
  const changed = useChanged()
  const [state, setState] = useState({ phase: 'idle', rows: [], index: null, error: null })
  const [pending, setPending] = useState({ rows: [], error: null, loaded: false })
  const [hidden, setHidden] = useState([])
  const [sent, setSent] = useState({ rows: [], error: null, loaded: false, more: false, loadingMore: false })
  // Every own log page read so far (a delete on a newer page hides a block
  // on an older one) and the cursor of the next 'Ver mais'.
  const sentLogRef = useRef({ pages: [], before: null })
  const runRef = useRef(0)
  const enabled = hosted && online && active && typeof owner === 'string' && HEX64.test(owner)

  const load = useCallback(async () => {
    if (!enabled) return
    const run = ++runRef.current
    const live = () => run === runRef.current
    setState((s) => ({ ...s, phase: s.phase === 'ready' ? 'ready' : 'loading', error: null }))
    const resolve = (keys) => {
      const names = namesRef.current
      if (keys.length > 0 && names && typeof names.resolveMany === 'function') names.resolveMany(keys)
    }
    const shown = readShown(request, owner).then((v) => {
      if (!live()) return
      setState({ phase: 'ready', rows: v.rows, index: v.index, incomplete: v.incomplete === true, error: null })
      resolve(v.rows.map((r) => r.from))
    }, (err) => {
      if (live()) setState((s) => ({ ...s, phase: s.phase === 'ready' ? 'ready' : 'error', error: errorText(err) }))
    })
    const tasks = [shown]
    if (withPending) {
      tasks.push(loadTestimonialHidden().then((list) => { if (live()) setHidden(list) }, () => {}))
      // After the shown reads (which settle either way): testimonial.pending
      // peeks the writers too, so it takes a diaryPeekSlots slot as well.
      tasks.push(shown.then(() => live() ? diaryPeekSlots.run(() => request('testimonial.pending', {})) : null).then((r) => {
        if (!live() || r === null) return
        const rows = pendingRows(r)
        setPending({ rows, incomplete: pendingIncomplete(r), error: null, loaded: true })
        resolve(rows.map((p) => p.from))
      }, (err) => {
        if (live()) setPending((p) => ({ ...p, error: errorText(err), loaded: true }))
      }))
    }
    if (withSent && typeof ownKey === 'string') {
      tasks.push(readSentPages(request, undefined).then((log) => {
        if (!live()) return
        sentLogRef.current = log
        const rows = sentRows(log.pages, ownKey)
        setSent({ rows, error: null, loaded: true, more: log.before !== null, loadingMore: false })
        resolve(rows.map((r) => r.to))
      }, (err) => {
        if (live()) setSent((s) => ({ ...s, error: errorText(err), loaded: true, loadingMore: false }))
      }))
    }
    await Promise.all(tasks)
  }, [enabled, request, owner, ownKey, withPending, withSent])

  // 'Ver mais' at the end of 'Enviados': the next SENT_PAGES pages of the
  // own log, only on that press (never on scroll), until the log ends.
  const loadingMoreRef = useRef(false)
  const loadMoreSent = useCallback(async () => {
    if (!enabled || !withSent || typeof ownKey !== 'string' || loadingMoreRef.current) return
    const start = sentLogRef.current.before
    if (start === null) return
    const run = runRef.current
    loadingMoreRef.current = true
    setSent((s) => ({ ...s, error: null, loadingMore: true }))
    try {
      const log = await readSentPages(request, start)
      if (run !== runRef.current) return
      const pages = sentLogRef.current.pages.concat(log.pages)
      sentLogRef.current = { pages, before: log.before }
      const rows = sentRows(pages, ownKey)
      setSent({ rows, error: null, loaded: true, more: log.before !== null, loadingMore: false })
      const names = namesRef.current
      if (rows.length > 0 && names && typeof names.resolveMany === 'function') names.resolveMany(rows.map((r) => r.to))
    } catch (err) {
      if (run === runRef.current) setSent((s) => ({ ...s, error: errorText(err), loadingMore: false }))
    } finally {
      loadingMoreRef.current = false
    }
  }, [enabled, withSent, ownKey, request])

  useEffect(() => { load() }, [load, tick, changed, node.epoch])
  useEffect(() => () => { runRef.current++ }, [])

  // 'Agora não': this device only. No request, no record.
  const notNow = useCallback(async (row) => {
    setHidden((list) => list.includes(row.ref) ? list : list.concat([row.ref]))
    await hideTestimonial(row.ref)
    // Every instance (the Diário's pinned row too) reads the hidden list again.
    testimonialsChanged()
  }, [])

  return {
    enabled,
    owner,
    phase: enabled ? state.phase : 'off',
    rows: state.rows,
    error: state.error,
    index: state.index,
    incomplete: state.incomplete === true,
    pending: visiblePending(pending.rows, hidden),
    pendingIncomplete: pending.incomplete === true,
    pendingError: pending.error,
    pendingLoaded: pending.loaded,
    sent: sent.rows,
    sentError: sent.error,
    sentLoaded: sent.loaded,
    sentMore: sent.more === true,
    sentLoadingMore: sent.loadingMore === true,
    loadMoreSent,
    reload: load,
    notNow
  }
}

// A mutating action with its own pending flag and error text. Never retried:
// the state is read again after any outcome.
function useMutation (after) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const run = useCallback(async (fn) => {
    if (pending) return false
    setPending(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(failureText(err))
      return false
    } finally {
      setPending(false)
      testimonialsChanged()
      if (typeof after === 'function') after()
    }
  }, [pending, after])
  return { pending, error, setError, run }
}

// Confirmation before a removal or a revocation (ConfirmStack).
export function ConfirmTestimonialSheet ({ open, title, body, confirmLabel, onConfirm, onClose }) {
  const styles = useStyles(makeStyles)
  const action = useMutation(null)
  const { setError } = action
  useEffect(() => { if (open) setError(null) }, [open, setError])
  // The caller clears its target on close, which empties `body` while the
  // sheet still slides out: keep the last text so it never jumps.
  const lastBody = useRef(body)
  if (open && body) lastBody.current = body
  const shownBody = open ? body : lastBody.current
  const confirm = async () => {
    const ok = await action.run(onConfirm)
    if (ok) onClose()
  }
  return (
    <Sheet open={open} onClose={action.pending ? () => {} : onClose} title={title}>
      <View style={styles.sheetBody}>
        {shownBody ? <Soft>{shownBody}</Soft> : null}
        <ErrorText>{action.error}</ErrorText>
        <ConfirmStack
          confirm={{ label: confirmLabel, danger: true, pending: action.pending, onPress: confirm }}
          cancel={{ onPress: onClose, disabled: action.pending }}
        />
      </View>
    </Sheet>
  )
}

// 'Escrever depoimento': a sealed testimonial.write to `to`. The node's
// refusal text is shown as is; nothing is sent again by itself.
export function WriteTestimonialSheet ({ open, to, name, onClose, onSent, onUncertain }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { request } = useNode()
  const [text, setText] = useState('')
  const count = textLength(text)
  const action = useMutation(null)
  const { setError } = action
  useEffect(() => {
    if (open) { setText(''); setError(null) }
  }, [open, setError])
  const body = text.trim()
  const over = textLength(body) > TESTIMONIAL_TEXT_MAX
  const send = async () => {
    let result = null
    let uncertain = false
    const ok = await action.run(async () => {
      try {
        result = await request('testimonial.write', { to, text: body })
      } catch (err) {
        uncertain = !!err && err.uncertain === true
        throw err
      }
    })
    if (ok) {
      if (typeof onSent === 'function') onSent(result)
      onClose()
    } else if (uncertain) {
      // Never left on screen with Enviar live: the write may be published.
      if (typeof onUncertain === 'function') onUncertain()
      onClose()
    }
  }
  const label = writeLabel(name)
  // Enviar sits in the header, as Publicar does: the iPhone keyboard has no
  // dismiss key, so a bottom button could stay behind it.
  return (
    <Sheet
      open={open}
      onClose={action.pending ? () => {} : onClose}
      title={WRITE_TITLE}
      right={<Pill label='Enviar' filled pending={action.pending} disabled={body.length === 0 || over} onPress={send} maxFontSizeMultiplier={TEXT_CAP} />}
    >
      <KeyboardForm>
        <ScrollView style={styles.flex} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps='handled' keyboardDismissMode='interactive'>
          <View style={styles.writeField}>
            <Label>{label}</Label>
            {/* Field has no height cap: past about six lines the text scrolls
                inside the box, so the counter and the note stay reachable. */}
            <TextInput
              style={[styles.writeInput, action.pending && styles.writeInputOff]}
              value={text}
              onChangeText={setText}
              multiline
              maxLength={TESTIMONIAL_FIELD_MAX}
              editable={!action.pending}
              placeholderTextColor={colors.placeholder}
              accessibilityLabel={label}
            />
          </View>
          <Text
            style={[styles.counter, count >= COUNTER_WARN && styles.counterWarn, count > TESTIMONIAL_TEXT_MAX && styles.counterOver]}
            accessibilityLabel={count + ' de ' + TESTIMONIAL_TEXT_MAX + ' caracteres'}
          >
            {counterLabel(count)}
          </Text>
          <Soft>{APPROVAL_NOTE}</Soft>
          <ErrorText>{action.error}</ErrorText>
        </ScrollView>
      </KeyboardForm>
    </Sheet>
  )
}

// The profile's Depoimentos tab, for the one RefreshableList of Diario and
// Membro: its items, renderItem and footer (the empty, loading and error
// states, as the Mural tab does), and the confirmation sheets to render
// beside the list. `own`: the owner's Diário, which starts with the pinned
// approval row (N > 0) and 'Enviados', both opening the screen (onOpenAll),
// and offers 'Remover do perfil' on each row. On someone else's profile
// `ownKey` is the viewer's key: the viewer's own depoimento offers 'Retirar
// depoimento' (the writer block, ownBlockRef) instead of a report;
// `ownerName` names the person in that confirmation and `canWrite` adds the
// empty tab's hint.
export function useTestimonialTab ({ data, own, ownKey, ownerName, canWrite, onOpenAll, onOpenMember, onReport, onRemoved, onRetracted }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const names = useNames()
  const { request } = useNode()
  const now = useNow(60000)
  const [removing, setRemoving] = useState(null)
  const [retracting, setRetracting] = useState(null)
  const enabled = !!data && data.enabled === true
  const rows = enabled ? data.rows : []
  // A failed read (index or a writer's diary) says so with a retry, never an
  // empty or shorter list read as everything.
  const failed = enabled && typeof data.error === 'string' && data.error.length > 0
  const items = enabled
    ? tabItems({ rows, pendingCount: own ? data.pending.length : 0, own, failed, error: data.error, canOpen: typeof onOpenAll === 'function' })
    : []
  const retractRef = own || !enabled ? null : ownBlockRef(data.index, typeof ownKey === 'string' ? ownKey.toLowerCase() : null)
  const handleRetry = enabled ? data.reload : undefined
  const profileOf = names ? names.profileOf : null
  const writerName = (row) => displayText(whoOf((profileOf ? profileOf(row.from) : null) || { name: row.name, username: row.username }).title)

  const renderItem = ({ item }) => {
    if (item.kind === 'link') {
      return (
        <Pressable
          accessibilityRole='link'
          accessibilityLabel={item.label}
          onPress={onOpenAll}
          style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        >
          {item.icon ? <Icon name={item.icon} size={20} color={colors.accent} /> : null}
          <Text style={styles.linkText}>{item.label}</Text>
          <Icon name='seta' size={20} color={colors.soft} />
        </Pressable>
      )
    }
    if (item.kind === 'retry') {
      return <View style={styles.more}><ErrorText>{item.text}</ErrorText><Pill label='Tentar de novo' onPress={handleRetry} /></View>
    }
    return (
      <TestimonialRow
        row={item.row}
        profile={profileOf ? profileOf(item.row.from) : null}
        now={now}
        ownKey={ownKey}
        onOpenMember={onOpenMember}
        onRemove={own ? setRemoving : undefined}
        onReport={onReport}
        onRetract={retractRef !== null ? () => setRetracting(retractRef) : undefined}
      />
    )
  }

  const footerKind = tabFooterKind({ enabled, rowCount: rows.length, failed, phase: enabled ? data.phase : 'off', incomplete: enabled && data.incomplete === true })
  let footer
  if (footerKind === 'off') footer = <View style={styles.note}><Soft>{UNAVAILABLE}</Soft></View>
  else if (footerKind === 'incomplete') footer = <View style={styles.more}><Soft>{INCOMPLETE_NOTE}</Soft><Pill label='Tentar de novo' onPress={handleRetry} /></View>
  else if (footerKind === 'end') footer = <View style={styles.foot}><Soft>Fim dos depoimentos</Soft></View>
  else if (footerKind === 'error') footer = <ErrorState message={data.error || UNAVAILABLE} onRetry={handleRetry} />
  else if (footerKind === 'loading') footer = <Skeleton rows={3} />
  else footer = <EmptyState icon='mensagem' title={EMPTY_TITLE} body={emptyBody({ own, canWrite })} />

  const sheets = (
    <>
      <ConfirmTestimonialSheet
        open={removing !== null}
        title={REMOVE_TITLE}
        body={removing !== null ? removeBody(writerName(removing)) : null}
        confirmLabel='Remover'
        onConfirm={() => request('testimonial.delete', { to: removing.ref })}
        onClose={() => { setRemoving(null); if (typeof onRemoved === 'function') onRemoved() }}
      />
      <ConfirmTestimonialSheet
        open={retracting !== null}
        title={RETRACT_TITLE}
        body={retractBody(ownerName)}
        confirmLabel='Retirar'
        onConfirm={async () => {
          const ref = retracting
          await request('testimonial.delete', { to: ref, about: data.owner })
          if (typeof onRetracted === 'function') onRetracted(ref)
        }}
        onClose={() => setRetracting(null)}
      />
    </>
  )

  return { items, keyExtractor: tabKey, renderItem, footer, sheets, extraData: { now, profileOf, retractRef, own } }
}

const tabKey = (item) => item.key

function SentRow ({ row, profile, now, onOpenMember, onRetract }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile || {})
  const title = displayText(who.title)
  const time = relativeTime(row.at, now) ?? displayText(row.at)
  return (
    <View style={styles.sentRow}>
      <Pressable
        accessibilityRole='link'
        accessibilityLabel={'ver o perfil de ' + title}
        onPress={typeof onOpenMember === 'function' ? () => onOpenMember(row.to, profile ? { name: profile.name, username: profile.username } : undefined) : undefined}
        style={({ pressed }) => [styles.sentWho, pressed && styles.pressed]}
      >
        <Text style={styles.name} numberOfLines={2}>{'Para ' + title}</Text>
        <Text style={styles.meta} numberOfLines={1}>{time}</Text>
      </Pressable>
      <Pill label='Retirar' accessibilityLabel={'retirar depoimento para ' + title} onPress={() => onRetract({ ref: row.ref, name: title, about: row.to })} />
    </View>
  )
}

export default function Depoimentos ({ entry, ownKey, onBack, onOpenMember, onReport }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const { request } = node
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const owner = entry.key
  const own = typeof ownKey === 'string' && ownKey.toLowerCase() === owner
  const data = useTestimonials(owner, { ownKey: own ? owner : null, withPending: own, withSent: own })
  const [refreshing, setRefreshing] = useState(false)
  const [removing, setRemoving] = useState(null)
  const [retracting, setRetracting] = useState(null)
  const [showing, setShowing] = useState(null)
  const [showError, setShowError] = useState(null)

  useEffect(() => {
    if (data.rows.length > 0 && names) names.resolveMany(data.rows.map((r) => r.from))
  }, [data.rows, names])
  // The viewer's own depoimento on someone else's profile: 'Retirar' the
  // writer block, never a report against themself.
  const ownRef = own ? null : ownBlockRef(data.index, typeof ownKey === 'string' ? ownKey.toLowerCase() : null)
  const ownerName = displayText(whoOf((names ? names.profileOf(owner) : null) || {}).title)
  const writerName = (row) => displayText(whoOf((names ? names.profileOf(row.from) : null) || { name: row.name, username: row.username }).title)

  // 'Mostrar no perfil': one testimonial.show, never repeated by itself.
  const show = useCallback(async (row) => {
    if (showing !== null) return
    setShowing(row.ref)
    setShowError(null)
    try {
      await request('testimonial.show', { from: row.from, seq: row.seq })
    } catch (err) {
      setShowError(failureText(err))
    } finally {
      setShowing(null)
      testimonialsChanged()
    }
  }, [request, showing])

  const bar = <TopBar title='Depoimentos' onBack={onBack} />
  if (node.hosted !== true) {
    return (
      <View style={styles.root}>
        {bar}
        <View style={styles.note}><Soft>Depoimentos disponíveis na versão web, com internet.</Soft></View>
      </View>
    )
  }

  const items = []
  // A failed approved-list read always shows with its retry, also on a first
  // load when other sections have rows (the empty state would not render).
  const shownFailed = !!data.error && (data.phase === 'ready' || data.phase === 'error')
  if (shownFailed) items.push({ kind: 'retry', key: 'e:shown', text: data.error })
  if (own && data.pending.length > 0) {
    items.push({ kind: 'title', key: 't:pending', label: 'Para aprovar' })
    if (showError) items.push({ kind: 'error', key: 'e:show', text: showError })
    for (const row of data.pending) items.push({ kind: 'pending', key: 'p:' + row.ref, row })
  }
  // The seeder was still indexing, or a writer's diary could not be read:
  // say so (with a retry) instead of letting a short or empty list read as
  // everything; the item also keeps the empty state away.
  if (data.incomplete || (own && data.pendingIncomplete)) items.push({ kind: 'incomplete', key: 'n:incomplete', text: INCOMPLETE_NOTE })
  if (own && data.pendingError) items.push({ kind: 'error', key: 'e:pending', text: data.pendingError })
  if (data.rows.length > 0) {
    if (own) items.push({ kind: 'title', key: 't:shown', label: 'No seu perfil' })
    for (const row of data.rows) items.push({ kind: 'shown', key: 's:' + row.ref, row })
  }
  if (own && (data.sent.length > 0 || data.sentMore)) {
    items.push({ kind: 'title', key: 't:sent', label: 'Enviados' })
    for (const row of data.sent) items.push({ kind: 'sent', key: 'w:' + row.ref, row })
    if (data.sentMore) items.push({ kind: 'more', key: 'm:sent' })
  }
  if (own && data.sentError) items.push({ kind: 'error', key: 'e:sent', text: data.sentError })

  const handleMoreSent = data.loadMoreSent
  const handleRetry = data.reload
  const renderItem = ({ item }) => {
    if (item.kind === 'title') return <Text style={styles.title}>{item.label}</Text>
    if (item.kind === 'error') return <View style={styles.note}><ErrorText>{item.text}</ErrorText></View>
    if (item.kind === 'incomplete') return <View style={styles.more}><Soft>{item.text}</Soft><Pill label='Tentar de novo' onPress={handleRetry} /></View>
    if (item.kind === 'retry') return <View style={styles.more}><ErrorText>{item.text}</ErrorText><Pill label='Tentar de novo' onPress={handleRetry} /></View>
    if (item.kind === 'more') return <View style={styles.more}><Pill label='Ver mais' pending={data.sentLoadingMore} onPress={handleMoreSent} /></View>
    if (item.kind === 'sent') {
      return <SentRow row={item.row} profile={names ? names.profileOf(item.row.to) : null} now={now} onOpenMember={onOpenMember} onRetract={setRetracting} />
    }
    if (item.kind === 'pending') {
      const row = item.row
      return (
        <TestimonialRow row={row} profile={names ? names.profileOf(row.from) : null} now={now} ownKey={ownKey} onOpenMember={onOpenMember} onReport={onReport}>
          <Pill label='Mostrar no perfil' filled pending={showing === row.ref} disabled={showing !== null && showing !== row.ref} onPress={() => show(row)} />
          <Pill label='Agora não' onPress={() => data.notNow(row)} />
        </TestimonialRow>
      )
    }
    return (
      <TestimonialRow
        row={item.row}
        profile={names ? names.profileOf(item.row.from) : null}
        now={now}
        ownKey={ownKey}
        onOpenMember={onOpenMember}
        onRemove={own ? setRemoving : undefined}
        onReport={onReport}
        onRetract={ownRef !== null ? () => setRetracting({ ref: ownRef, name: ownerName, about: owner }) : undefined}
      />
    )
  }

  const empty = data.phase === 'loading' || data.phase === 'idle'
    ? <Skeleton rows={3} />
    : data.phase === 'error'
      ? <ErrorState message={data.error || UNAVAILABLE} onRetry={handleRetry} />
      : <EmptyState icon='mensagem' title={EMPTY_TITLE} body={own ? 'Quando alguém escrever um depoimento para você, ele aparece aqui para você aprovar.' : 'Os depoimentos que esta pessoa aprovar aparecem aqui.'} />

  return (
    <View style={styles.root}>
      {bar}
      <RefreshableList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        extraData={{ now, showing, profileOf: names ? names.profileOf : null, sentLoadingMore: data.sentLoadingMore }}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={async () => {
          setRefreshing(true)
          try { await data.reload() } finally { setRefreshing(false) }
        }}
        refreshing={refreshing}
        atEnd
      />
      <ConfirmTestimonialSheet
        open={removing !== null}
        title={REMOVE_TITLE}
        body={removing !== null ? removeBody(writerName(removing)) : null}
        confirmLabel='Remover'
        onConfirm={() => request('testimonial.delete', { to: removing.ref })}
        onClose={() => setRemoving(null)}
      />
      <ConfirmTestimonialSheet
        open={retracting !== null}
        title={RETRACT_TITLE}
        body={retractBody(retracting !== null ? retracting.name : null)}
        confirmLabel='Retirar'
        onConfirm={() => request('testimonial.delete', { to: retracting.ref, about: retracting.about })}
        onClose={() => setRetracting(null)}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
  foot: { alignItems: 'center', paddingVertical: 24 },
  title: { ...type.postName, color: colors.ink, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  // A full-width 44 pt row link: the label wraps, never cut nor a pill.
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  linkText: { ...type.postName, color: colors.ink, flex: 1 },
  pressed: { opacity: 0.6 },
  more: { paddingHorizontal: 16, paddingVertical: 10, alignItems: 'flex-start' },
  counter: { ...type.postMeta, color: colors.soft, textAlign: 'right', marginTop: -4 },
  counterWarn: { color: colors.warn },
  counterOver: { color: colors.danger },
  sheetBody: { gap: 12, paddingHorizontal: 16, paddingBottom: 16 },
  flex: { flex: 1 },
  writeField: { gap: 4 },
  writeInput: {
    minHeight: WRITE_MIN_HEIGHT,
    maxHeight: WRITE_MAX_HEIGHT,
    textAlignVertical: 'top',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  writeInputOff: { backgroundColor: colors.inputOff, color: colors.soft },
  sentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  sentWho: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  name: { ...type.postName, color: colors.ink },
  meta: { ...type.postMeta, color: colors.soft }
})
