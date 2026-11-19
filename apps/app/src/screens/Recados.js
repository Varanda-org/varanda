// Recados (entry { screen: 'recados', key: owner hex64 }): the notes people
// leave on one page, newest first, pushed above the tabs from a profile (Membro)
// and from the own page (Diário). Hosted nodes only. The seeder index gives
// pointers; every pointer is re-read with diary.peek and judged by the pure
// model in src/scraps.js, so a seeder cannot make a recado appear. The reader
// sees no count: the index may be partial. Nothing here repeats a write: an
// uncertain result holds the composer until the person says they checked.
// Also exports WallSetting, the 'Quem pode deixar recado' screen of Ajustes.

import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useBlocks } from '../blocksProvider'
import { diaryPeekSlots } from '../engagement'
import { fetchFollowPair, fetchScraps } from '../indexClient'
import { useNames } from '../names'
import { useNode } from '../node'
import {
  CHECKED_LABEL, COMPOSE_LABEL, COMPOSE_PLACEHOLDER, DELETE_BODY, DELETE_CONFIRM, DELETE_TITLE, HIDE_BODY, HIDE_CONFIRM, HIDE_TITLE,
  HOSTED_ONLY, MORE_LABEL, RECADOS_TITLE, REPLY_TITLE, SEND_LABEL, SENT_TOAST, WALL_PUBLIC, WALL_TITLE, WALL_UNREAD,
  composerShown, counterA11y, emptyBody, emptyKind, mergeIndex, pageNotice, validWall, wallLine, wallNote, wallOptions, withoutReadHides
} from '../recadosView'
import {
  NOTICES, assemblePage, beginSend, composeGate, composerView, initialComposer, markChecked, planPeeks, planReplyPeeks,
  replyDraft, sendFailed, sendSucceeded, setText
} from '../scraps'
import { refusalOf } from '../wordCheck'
import { ErrorText, Page, Soft, errorText, useBottomPad, useNow } from '../ui'
import { Divider } from '../ui/Divider'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RadioMark } from '../ui/Radio'
import { RefreshableList } from '../ui/RefreshableList'
import { ScrapRow } from '../ui/ScrapRow'
import { Sheet } from '../ui/Sheet'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { radius, space, type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { ConfirmTestimonialSheet } from './Depoimentos'

const OFFLINE = 'Sem conexão. Tente de novo quando a internet voltar.'
const UNAVAILABLE = 'Não deu para abrir os recados agora.'

// A failed index read, as the person reads it.
function indexFailure (reason) {
  if (reason === 'not-found') return NOTICES.unreachable
  if (reason === 'network' || reason === 'timeout') return OFFLINE
  return UNAVAILABLE
}

// The diary.peek reads of a plan, one at a time through the app-wide slots,
// each answer filed under its author. A diary the node cannot reach is left
// unread (the page says it is incomplete); any other failure stops the read.
async function peekInto (request, plan, peeks, alive) {
  for (const params of plan) {
    if (!alive()) return
    try {
      const peek = await diaryPeekSlots.run(() => (alive() ? request('diary.peek', params) : null), { front: true })
      if (!alive() || !peek || typeof peek.key !== 'string') continue
      const list = peeks.get(peek.key) || []
      list.push(peek)
      peeks.set(peek.key, list)
    } catch (err) {
      if (err && typeof err.message === 'string' && /di[aá]rio indispon[ií]vel/i.test(err.message)) continue
      throw err
    }
  }
}

// Does the page owner follow `self`? true, false, or null when it cannot be
// told (the seeder is still indexing or unreachable): the node then decides.
async function ownerFollows (request, owner, self, alive) {
  const res = await fetchFollowPair(owner, self)
  if (!res.ok || !alive()) return null
  if (res.value.seq === null) return res.value.indexing ? null : false
  const peeks = new Map()
  await peekInto(request, [{ author: owner, seqs: [res.value.seq] }], peeks, alive)
  const read = (peeks.get(owner) || []).flatMap((p) => (Array.isArray(p.entries) ? p.entries : []))
  const hit = read.find((e) => e && e.seq === res.value.seq)
  if (!hit || !hit.record) return null
  return hit.record.type === 'follow' && hit.record.on === true && hit.record.key === self
}

function Composer ({ state, onText, onSend, onChecked, label, placeholder }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const view = composerView(state)
  return (
    <View style={styles.composer}>
      <Text style={styles.composeLabel}>{label}</Text>
      <TextInput
        style={[styles.input, state.sending && styles.inputOff]}
        value={state.text}
        onChangeText={onText}
        multiline
        editable={!state.sending && !state.needsCheck}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={label}
      />
      <Text style={[styles.counter, view.over && styles.counterOver]} accessibilityLabel={counterA11y(view.count)}>{view.counter}</Text>
      {state.notice ? <ErrorText>{state.notice}</ErrorText> : null}
      <View style={styles.composeActions}>
        {state.needsCheck
          ? <Pill label={CHECKED_LABEL} onPress={onChecked} />
          : <Pill label={SEND_LABEL} filled pending={state.sending} disabled={!view.canSend} onPress={onSend} />}
      </View>
    </View>
  )
}

export default function Recados ({ entry, ownKey, onBack, onOpenMember, onReport, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const { request } = node
  const hosted = node.hosted === true
  const names = useNames()
  const blocks = useBlocks()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has
  const blocksKnown = blocks.loadState !== 'pending'
  const owner = typeof entry.key === 'string' ? entry.key : ''
  const self = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const own = self !== null && owner === self
  const [view, setView] = useState({ phase: 'loading', page: null, next: null, error: null, more: false, followed: null })
  const [composer, setComposer] = useState(() => initialComposer(owner))
  const [reply, setReply] = useState(null)
  const [hiding, setHiding] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const held = useRef({ index: null, peeks: new Map() })
  const seq = useRef(0)
  const requestRef = useRef(request)
  requestRef.current = request

  const load = useCallback(async (more) => {
    if (!hosted || !blocksKnown || owner === '') return
    const mine = ++seq.current
    const alive = () => mine === seq.current
    const isBlocked = (key) => blockedRef.current(key)
    if (!more) held.current = { index: null, peeks: new Map() }
    const cursor = more ? held.current.index.next : null
    setView((v) => ({ ...v, phase: v.page ? v.phase : 'loading', more, error: null }))
    try {
      const res = await fetchScraps(owner, cursor)
      if (!alive()) return
      if (!res.ok) { setView((v) => ({ ...v, phase: v.page ? 'ready' : 'error', more: false, error: indexFailure(res.reason) })); return }
      const { peeks } = held.current
      await peekInto(requestRef.current, planPeeks(more ? withoutReadHides(res.value, peeks, owner) : res.value, owner, isBlocked, self), peeks, alive)
      if (!alive()) return
      const merged = mergeIndex(held.current.index, res.value)
      await peekInto(requestRef.current, planReplyPeeks(merged, owner, peeks, isBlocked, Date.now(), self), peeks, alive)
      if (!alive()) return
      held.current.index = merged
      const page = assemblePage({ index: merged, owner, self, peeks, isBlocked, now: Date.now() })
      let followed = null
      if (!more && self !== null && self !== owner && page.wall === 'following') followed = await ownerFollows(requestRef.current, owner, self, alive).catch(() => null)
      if (!alive()) return
      if (names) names.resolveMany([...new Set(page.rows.map((r) => r.author))])
      setView((v) => ({ phase: 'ready', page, next: merged.next, error: null, more: false, followed: more ? v.followed : followed }))
    } catch (err) {
      if (!alive()) return
      const message = err && typeof err.message === 'string' && /indispon[ií]vel/i.test(err.message) ? NOTICES.unreachable : errorText(err)
      setView((v) => ({ ...v, phase: v.page ? 'ready' : 'error', more: false, error: message }))
    }
  }, [hosted, blocksKnown, owner, self, names])

  useEffect(() => {
    load(false)
    return () => { seq.current += 1 }
  }, [load])

  const submit = async (state, setState, onOk) => {
    if (state.sending || state.needsCheck) return
    const refused = refusalOf(state.text.trim())
    if (refused !== '') { setState({ ...state, notice: refused }); return }
    const { state: next, params } = beginSend(state)
    setState(next)
    if (params === null) return
    try {
      await requestRef.current('scrap.write', params)
      setState(sendSucceeded(next))
      onOk(true)
    } catch (err) {
      setState(sendFailed(next, err))
      onOk(false, err)
    }
  }
  const sendComposer = () => submit(composer, setComposer, (ok) => {
    if (!ok) return
    if (typeof onToast === 'function') onToast(SENT_TOAST)
    load(false)
  })
  const sendReply = () => submit(reply, setReply, (ok, err) => {
    if (ok) {
      setReply(null)
      if (typeof onToast === 'function') onToast(SENT_TOAST)
    } else if (err && err.uncertain === true) {
      setReply(null)
      if (typeof onToast === 'function') onToast(NOTICES.uncertain)
    }
  })

  const openReply = (row) => {
    const draft = replyDraft(row, { owner, self, isBlocked: blockedRef.current })
    if (draft !== null) setReply(draft)
  }
  const writerName = (row) => {
    const p = names ? names.profileOf(row.author) : null
    return displayText((p && (p.name || p.username)) || 'esta pessoa')
  }

  const page = view.page
  const notice = view.phase === 'ready' ? pageNotice(page, view.error) : null
  const gate = composeGate({ owner, self, isBlocked: blockedRef.current, wall: page ? page.wall : null, followedByOwner: view.followed, reachable: view.phase === 'ready' && !!page && page.notice !== NOTICES.unreachable })
  const showComposer = self !== null && view.phase === 'ready' && composerShown(gate, owner, self)
  const gateNotice = self !== null && !own && view.phase === 'ready' && page && !gate.ok && gate.reason !== 'unreachable' ? gate.notice : null
  const rows = page ? page.rows : []

  const renderItem = ({ item }) => (
    <ScrapRow
      row={item}
      profile={names ? names.profileOf(item.author) : null}
      now={now}
      owner={owner}
      self={self}
      isBlocked={blockedRef.current}
      onOpenMember={onOpenMember}
      onReply={openReply}
      onHide={setHiding}
      onDelete={setDeleting}
      onReport={typeof onReport === 'function' ? onReport : undefined}
    />
  )

  const head = (
    <View>
      {showComposer
        ? (
          <View>
            <Composer
              state={composer}
              onText={(text) => setComposer((s) => setText(s, text))}
              onSend={sendComposer}
              onChecked={() => setComposer((s) => markChecked(s))}
              label={COMPOSE_LABEL}
              placeholder={COMPOSE_PLACEHOLDER}
            />
            {wallLine(page ? page.wall : null) ? <View style={styles.note}><Soft>{wallLine(page.wall)}</Soft></View> : null}
          </View>
          )
        : null}
      {gateNotice ? <View style={styles.note}><Soft>{gateNotice}</Soft></View> : null}
      {own && page && wallLine(page.wall, true) ? <View style={styles.note}><Soft>{wallLine(page.wall, true)}</Soft></View> : null}
      {notice && notice !== gateNotice ? <View style={styles.note}><Soft>{notice}</Soft></View> : null}
    </View>
  )

  const bar = <TopBar title={RECADOS_TITLE} onBack={onBack} />
  if (!hosted) {
    return (
      <View style={styles.root}>
        {bar}
        <View style={styles.note}><Soft>{HOSTED_ONLY}</Soft></View>
      </View>
    )
  }
  const kind = emptyKind(page, own)
  const empty = view.phase === 'loading'
    ? <Skeleton rows={3} />
    : view.phase === 'error'
      ? <ErrorState message={view.error || UNAVAILABLE} onRetry={() => load(false)} />
      : kind === 'blocked' || kind === 'nobody' || kind === 'unread'
        ? null
        : <EmptyState icon='mensagem' title='Nenhum recado ainda' body={emptyBody(kind)} />
  const footer = view.next && view.phase === 'ready'
    ? <View style={styles.more}><Pill label={MORE_LABEL} pending={view.more} onPress={() => load(true)} /></View>
    : null

  return (
    <View style={styles.root}>
      {bar}
      <OfflineNote />
      <RefreshableList
        data={rows}
        keyExtractor={(item) => item.ref}
        renderItem={renderItem}
        extraData={{ now, composer, followed: view.followed, notice }}
        ListHeaderComponent={head}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={async () => {
          setRefreshing(true)
          try { await load(false) } finally { setRefreshing(false) }
        }}
        refreshing={refreshing}
        atEnd
      />
      <ConfirmTestimonialSheet
        open={hiding !== null}
        title={HIDE_TITLE}
        body={HIDE_BODY}
        confirmLabel={HIDE_CONFIRM}
        onConfirm={async () => { await requestRef.current('scrap.hide', { from: hiding.author, seq: hiding.seq }); load(false) }}
        onClose={() => setHiding(null)}
      />
      <ConfirmTestimonialSheet
        open={deleting !== null}
        title={DELETE_TITLE}
        body={DELETE_BODY}
        confirmLabel={DELETE_CONFIRM}
        onConfirm={async () => { await requestRef.current('scrap.delete', { seq: deleting.seq }); load(false) }}
        onClose={() => setDeleting(null)}
      />
      <Sheet
        open={reply !== null}
        onClose={reply && reply.sending ? () => {} : () => setReply(null)}
        title={REPLY_TITLE}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='interactive'>
            {reply
              ? (
                <Composer
                  state={reply}
                  onText={(text) => setReply((s) => setText(s, text))}
                  onSend={sendReply}
                  onChecked={() => setReply((s) => markChecked(s))}
                  label={'Responder a ' + writerName({ author: reply.to })}
                  placeholder={COMPOSE_PLACEHOLDER}
                />
                )
              : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </Sheet>
    </View>
  )
}

// Ajustes > Quem pode deixar recado: the page's wall, three choices. The
// current one is read the same way a reader reads it (the seeder names the
// block, the node verifies it with diary.peek); a read that fails says so and
// offers no guess. A change is one scrap.wall, never repeated by itself.
export function WallSetting ({ active }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const hosted = node.hosted === true
  const [state, setState] = useState({ wall: null, loading: true, failed: false })
  const [saving, setSaving] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!active || !hosted) return undefined
    let alive = true
    setState((s) => ({ ...s, loading: true, failed: false }))
    ;(async () => {
      try {
        const info = await requestRef.current('node.info', {})
        const key = info && typeof info.publicKey === 'string' ? info.publicKey : null
        if (key === null) throw new Error('sem chave')
        const res = await fetchScraps(key, null)
        if (!res.ok) throw new Error('índice')
        const peeks = new Map()
        if (res.value.wall !== null) await peekInto(requestRef.current, [{ author: key, seqs: [res.value.wall] }], peeks, () => alive)
        const page = assemblePage({ index: { ...res.value, rows: [], hides: [] }, owner: key, self: key, peeks })
        if (alive) setState({ wall: validWall(page.wall) ? page.wall : null, loading: false, failed: !validWall(page.wall) })
      } catch {
        if (alive) setState({ wall: null, loading: false, failed: true })
      }
    })()
    return () => { alive = false }
  }, [active, hosted, tick])

  const choose = async (who) => {
    if (saving !== null || who === state.wall) return
    setSaving(who)
    setError('')
    try {
      await requestRef.current('scrap.wall', { who })
      setState({ wall: who, loading: false, failed: false })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <Page>
      <View style={styles.group} accessibilityRole='radiogroup' accessibilityLabel={WALL_TITLE}>
        {wallOptions().map((o, i) => (
          <WallOption
            key={o.id}
            first={i === 0}
            label={o.label}
            checked={state.wall === o.id}
            pending={saving === o.id}
            disabled={saving !== null || state.loading}
            onPress={() => choose(o.id)}
          />
        ))}
      </View>
      {wallNote(state.wall) ? <Soft>{wallNote(state.wall)}</Soft> : null}
      <Soft>{WALL_PUBLIC}</Soft>
      {state.failed ? <ErrorText>{WALL_UNREAD}</ErrorText> : null}
      {state.failed ? <Pill label='Tentar de novo' onPress={() => setTick((n) => n + 1)} /> : null}
      <ErrorText>{error}</ErrorText>
    </Page>
  )
}

function WallOption ({ label, checked, pending, disabled, onPress, first }) {
  const styles = useStyles(makeStyles)
  return (
    <View>
      {first ? null : <Divider />}
      <Pressable
        style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
        accessibilityRole='radio'
        accessibilityLabel={label}
        accessibilityState={{ checked, disabled }}
        aria-checked={checked}
        disabled={disabled}
        onPress={onPress}
      >
        <Text style={styles.optionLabel}>{pending ? label + '…' : label}</Text>
        <RadioMark checked={checked} />
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  note: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  more: { paddingHorizontal: space.lg, paddingVertical: space.md, alignItems: 'flex-start' },
  composer: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  composeLabel: { ...type.postName, color: colors.ink },
  composeActions: { flexDirection: 'row', justifyContent: 'flex-end' },
  input: {
    minHeight: 5 * 22 + 20,
    maxHeight: 6 * 22 + 20,
    textAlignVertical: 'top',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  inputOff: { backgroundColor: colors.inputOff, color: colors.soft },
  counter: { ...type.postMeta, color: colors.soft, textAlign: 'right' },
  counterOver: { color: colors.danger },
  group: { backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.md },
  optionPressed: { opacity: 0.6 },
  optionLabel: { ...type.postName, color: colors.ink, flex: 1 }
})
