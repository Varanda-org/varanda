// Varandinha (entry { screen: 'varandinha', key: owner hex64 }): one balcony of
// the cozy pot game, the own one or a neighbour's. Hosted nodes only. All
// state is signed records in each member's own diary; the seeder index only
// points at them, so every block shown here was read with diary.peek by the
// node and judged by the pure model in src/garden.js (a forged pointer never
// shows a pot). Growth runs on the reader clock: a 60 s tick redraws and no
// request is made for it. Writes are garden.set, garden.play and garden.help,
// each behind an explicit tap, never repeated by the screen: an uncertain
// answer re-reads garden.state and offers nothing again by itself. No text is
// typed anywhere, and a visitor sees only a count of who watered; the names
// are for the owner's own balcony.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import rpc, { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useBlocks } from '../blocksProvider'
import { diaryPeekSlots } from '../engagement'
import { readFollowKeys } from '../follow'
import { assembleBalcony, closeConsent, discard, initialConsent, nextLoadStep, openConsent, pendingCount, pendingStart, planPeeks, provenOff, queue, reloadDelay, revalidate, startConsent, toggleConsent, wantsReload } from '../garden'
import { HELP } from '../help'
import { gardenTime } from '../gardenClock'
import { fetchGarden } from '../indexClient'
import { useNames } from '../names'
import { useNode } from '../node'
import {
  ACTIONS, CONSENT_LINES, CONSENT_SWITCH_LABEL, NOTICES, SOIL_LABELS, STAGE_LABELS, TITLE, STREET_TITLE, WHO_WATERED,
  harvestVerb, pendingLabel, plantLabel, readyIn, refusalNotice, visitorLine, wateredDay
} from '../varandinhaView'
import { whoOf } from '../who'
import { Btn, ConfirmStack, ErrorText, Soft, errorText, useAction, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { GardenSceneView } from '../ui/GardenSceneView'
import { Icon } from '../ui/Icon'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet } from '../ui/Sheet'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { SwitchRow } from '../ui/SwitchRow'
import { TopActions } from '../ui/TopActions'
import { TopBar } from '../ui/TopBar'
import { layout, space, type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const HEX64 = /^[0-9a-f]{64}$/
const { GARDEN_POTS, GARDEN_HELP_PER_POT, GARDEN_SAVES_DAILY_MAX, GARDEN_HELP_ROWS } = rpc.garden

// Texts the shared module has no place for.
const BEGIN_LABEL = 'Começar'
const LEAVE_LABEL = 'Sair da Varandinha'
const LEAVE_TITLE = 'Sair da Varandinha?'
const UNSAVED_TITLE = 'Sair sem guardar?'
const OWNER_PREFIX = 'Varanda de '
const UNSAVED_BODY = 'As ações que você ainda não guardou serão descartadas.'
const UNSAVED_CONFIRM = 'Descartar e sair'
const UNSAVED_STAY = 'Continuar na varanda'
const SAVED_TOAST = 'Varanda guardada.'
const WATERED_TOAST = 'Você regou esta varanda.'
const OFFLINE = 'Sem conexão. Tente de novo quando a internet voltar.'
const UNAVAILABLE = 'Não deu para abrir esta varanda agora.'
const POT_WORD = 'Vaso '
const EMPTY_POT = 'vazio'

// A failed index read, as the person reads it.
function indexFailure (reason) {
  if (reason === 'not-found') return NOTICES.unreachable
  if (reason === 'network' || reason === 'timeout') return OFFLINE
  return UNAVAILABLE
}

// A refused or failed write, as the person reads it: an uncertain answer
// says so, a refusal with one of the node's own sentences shows it, anything
// else goes through errorText (never the raw message).
function failureText (err) {
  if (err && err.uncertain === true) return NOTICES.uncertain
  const known = refusalNotice(err && err.message)
  return known !== null ? known : errorText(err)
}

// The diary.peek reads of a plan, one at a time through the app-wide slots,
// each answer handed to `sink`. A diary the node cannot reach is left unread
// (the balcony then says it may be incomplete); any other failure stops it.
async function peekInto (request, plan, sink, alive) {
  for (const params of plan) {
    if (!alive()) return
    try {
      const peek = await diaryPeekSlots.run(() => (alive() ? request('diary.peek', params) : null), { front: true })
      if (!alive() || !peek || typeof peek.key !== 'string') continue
      sink(peek)
    } catch (err) {
      if (err && typeof err.message === 'string' && /di[aá]rio indispon[ií]vel/i.test(err.message)) continue
      throw err
    }
  }
}

// One balcony, read progressively: the owner's blocks first (the pots show as
// soon as they are judged), then each helper's, one at a time. One index
// refetch at most when a pointer does not resolve (nextLoadStep); a second
// miss only marks the balcony incomplete. `onStage(result, forced)` gets each
// state. Returns { ok: true } or { ok: false, message }; null when stale.
async function readBalcony ({ request, owner, isBlocked, alive, onStage }) {
  let attempt = 0
  for (;;) {
    const res = await fetchGarden(owner)
    if (!alive()) return null
    if (!res.ok) return { ok: false, message: indexFailure(res.reason) }
    const index = res.value
    const plan = planPeeks({ owner, index, isBlocked })
    const ownerReads = []
    await peekInto(request, plan.owner, (p) => ownerReads.push(p), alive)
    if (!alive()) return null
    const helperReads = new Map()
    const assemble = () => assembleBalcony({ owner, index, ownerReads, helperReads, now: gardenTime(), isBlocked })
    const first = assemble()
    const step = nextLoadStep({ attempt, result: first })
    if (step === 'refetch') {
      attempt += 1
      continue
    }
    const forced = step === 'incomplete'
    onStage(first, forced)
    if (first.isPage || !first.on) return { ok: true }
    for (const helper of plan.helpers) {
      const answers = []
      try {
        await peekInto(request, helper.batches, (p) => answers.push(p), alive)
      } catch {
        // A helper whose blocks cannot be read counts for nothing; the
        // balcony reads as incomplete.
      }
      if (!alive()) return null
      helperReads.set(helper.author, answers)
      onStage(assemble(), forced)
    }
    return { ok: true }
  }
}

// The own balcony as the node reads it from the own diary (garden.state).
async function readMine (request) {
  const r = await request('garden.state', {})
  const base = r && r.state && Array.isArray(r.state.pots) && r.state.pots.length === GARDEN_POTS ? r.state.pots : null
  // An unreadable count reads as every save spent, never as a fresh budget.
  const saves = r && Number.isSafeInteger(r.savesToday) && r.savesToday >= 0 ? r.savesToday : GARDEN_SAVES_DAILY_MAX
  const given = r && Array.isArray(r.given) ? r.given.filter((g) => !!g && typeof g === 'object').slice(0, GARDEN_HELP_ROWS) : []
  return { on: !!r && r.on === true, base, savesToday: saves, given }
}

// The counts the reducer judges with: the node's own bound for helps
// received (it cannot see other diaries), the own helps given as foldGiven
// reads them.
function countsOf (owner, base, given, now) {
  const rows = given.map((g) => ({ seq: g.seq, record: { type: 'garden-help', to: g.to, pot: g.pot, at: g.at } }))
  const perPot = rpc.garden.foldGiven({ self: owner, pots: base, given: rows, now }).perPot
  return { received: new Array(GARDEN_POTS).fill(GARDEN_HELP_PER_POT), given: perPot }
}

// The own pots the node holds under the queued acts: acts that still apply
// stay queued, the others are dropped (revalidate).
function rebased (p, state, owner, now) {
  if (pendingCount(p) === 0) return pendingStart(state.base)
  const base = state.base === null ? pendingStart(null).base : state.base
  return revalidate({ ...p, base }, now, countsOf(owner, state.base, state.given, now))
}

// The views of the own pots with the queued acts applied. A pot an act
// touched is drawn without helps (they were counted against the saved pot and
// the saved state decides after Guardar); the others use the helps verified
// in the helpers' diaries, counted per pot as the fold counts them.
function ownViews (pending, received, givenPer, now) {
  const touched = new Set(pending.acts.map((a) => a.pot))
  return pending.pots.map((pot, i) => {
    const r = Array.isArray(received) && Number.isSafeInteger(received[i]) ? Math.min(Math.max(received[i], 0), GARDEN_HELP_PER_POT) : 0
    return rpc.garden.potView(pot, now, touched.has(i) ? null : { received: r, given: givenPer[i] })
  })
}

function potLabel (index, view, occupied) {
  const head = POT_WORD + (index + 1) + ', '
  if (view) return head + plantLabel(view.plant) + ', ' + STAGE_LABELS[view.stage]
  return head + (occupied ? STAGE_LABELS[0] : EMPTY_POT)
}

function PotInfo ({ view, now }) {
  const { colors } = useTheme()
  const styles = useStyles(makeStyles)
  if (!view) return null
  return (
    <View style={styles.potInfo}>
      <Text style={[styles.potName, { color: colors.ink }]}>{plantLabel(view.plant)}</Text>
      <Soft>{[STAGE_LABELS[view.stage], 'terra ' + SOIL_LABELS[view.dry ? 'dry' : 'wet'], view.ripe ? null : readyIn(view.ripeAt, now)].filter(Boolean).join(' · ')}</Soft>
    </View>
  )
}

function HelperRow ({ author, at, now, profile }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  return (
    <View style={styles.helper} accessibilityLabel={title + ', ' + wateredDay(at, now)}>
      <Avatar name={who.avatarName} publicKey={author} size={40} picture={(profile || {}).avatar} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        <Text style={styles.when} numberOfLines={1}>{wateredDay(at, now)}</Text>
      </View>
    </View>
  )
}

// On someone else's balcony, whose it is.
function OwnerRow ({ owner, profile }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  return (
    <View style={styles.helper} accessibilityRole='header' accessibilityLabel={OWNER_PREFIX + title}>
      <Avatar name={who.avatarName} publicKey={owner} size={40} picture={(profile || {}).avatar} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {who.subtitle ? <Text style={styles.when} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
      </View>
    </View>
  )
}

export default function Varandinha ({ entry, ownKey, onBack, onOpenStreet, onToast, registerBackGuard }) {
  const styles = useStyles(makeStyles)
  const { scheme, colors } = useTheme()
  const node = useNode()
  const hosted = node.hosted === true
  const names = useNames()
  const blocks = useBlocks()
  const now = gardenTime(useNow(60000))
  const bottomPad = useBottomPad()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const act = useAction()
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const namesRef = useRef(names)
  namesRef.current = names
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has
  const blocksKnown = blocks.loadState !== 'pending'
  const owner = entry && typeof entry.key === 'string' ? entry.key.toLowerCase() : ''
  const self = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const own = self !== null && owner === self

  const [view, setView] = useState({ phase: 'loading', error: null, mine: null, following: null })
  const [bal, setBal] = useState({ phase: 'idle', result: null, forced: false, error: null })
  const [pending, setPending] = useState(() => pendingStart(null))
  const [consent, setConsent] = useState(initialConsent)
  const [potOpen, setPotOpen] = useState(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [unsaved, setUnsaved] = useState(null)
  const [helped, setHelped] = useState(false)
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    if (!own && HEX64.test(owner) && namesRef.current) namesRef.current.resolveMany([owner])
  }, [own, owner])

  const load = useCallback(async () => {
    if (!hosted || !blocksKnown || !HEX64.test(owner)) return
    const mine = ++seq.current
    const alive = () => mine === seq.current
    const request = requestRef.current
    setView((v) => ({ ...v, phase: v.mine ? v.phase : 'loading', error: null }))
    let state
    try {
      state = await readMine(request)
    } catch (err) {
      if (alive()) setView((v) => ({ ...v, phase: v.mine ? v.phase : 'error', error: errorText(err) }))
      return
    }
    if (!alive()) return
    // A fresh read settles an uncertain watering: garden.state lists it when
    // it was written, and the writer rule then hides Regar.
    setHelped((h) => (h === 'uncertain' ? false : h))
    // A refresh keeps the queued acts that still hold on the freshly read pots.
    if (own) setPending((p) => rebased(p, state, owner, gardenTime()))
    if (!state.on) {
      setView({ phase: 'ready', error: null, mine: state, following: null })
      setBal({ phase: 'idle', result: null, forced: false, error: null })
      return
    }
    setView((v) => ({ phase: 'ready', error: null, mine: state, following: own ? null : v.following }))
    setBal((b) => ({ ...b, phase: b.result ? 'ready' : 'loading', error: null }))
    if (!own) {
      readFollowKeys(request, FOLLOW_LIMIT_MAX).then((set) => {
        if (alive()) setView((v) => ({ ...v, following: set === null ? null : set.has(owner) }))
      }, () => {})
    }
    let out
    try {
      out = await readBalcony({
        request,
        owner,
        isBlocked: (key) => blockedRef.current(key),
        alive,
        onStage: (result, forced) => {
          if (!alive()) return
          if (own && namesRef.current) namesRef.current.resolveMany(result.helpers.map((h) => h.author))
          setBal({ phase: 'ready', result, forced, error: null })
        }
      })
    } catch (err) {
      if (alive()) setBal((b) => ({ ...b, phase: b.result ? 'ready' : 'error', error: errorText(err) }))
      return
    }
    if (out && !out.ok && alive()) setBal((b) => ({ ...b, phase: b.result ? 'ready' : 'error', error: out.message }))
  }, [hosted, blocksKnown, owner, self, own])

  useEffect(() => {
    load()
    return () => { seq.current += 1 }
  }, [load])

  // A read that failed, or a balcony the seeder is still indexing (an update
  // restarts it), is read again by itself on the reload ladder while the
  // screen is open; a clean answer starts the ladder over. Reads only, and
  // never while a write is in flight (its own reread settles the screen).
  const reloadable = !act.pending && wantsReload({ view, bal, own })
  const reloads = useRef(0)
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    if (!reloadable) {
      if (view.phase === 'ready' && bal.phase !== 'loading') reloads.current = 0
      return
    }
    const delay = reloadDelay(reloads.current)
    if (delay === null) return
    const timer = setTimeout(() => {
      reloads.current += 1
      setReloadTick((n) => n + 1)
      load()
    }, delay)
    return () => clearTimeout(timer)
  }, [reloadable, reloadTick, load, view.phase, bal.phase])

  const mine = view.mine
  const counts = useMemo(
    () => (own && mine ? countsOf(owner, mine.base, mine.given, now) : null),
    [own, owner, mine, now]
  )

  // Growth moves on the reader clock: queued acts are judged again at every
  // tick, and the longest prefix that still holds is kept.
  useEffect(() => {
    if (counts === null) return
    setPending((p) => (pendingCount(p) === 0 ? p : revalidate(p, now, counts)))
  }, [now, counts])

  const toast = (text) => { if (typeof onToast === 'function') onToast(text) }

  // One write at a time. A failure is filed as the notice and rethrown, so
  // useAction knows whether it was uncertain; nothing is sent again.
  const write = (method, params) => act.run(async () => {
    try {
      return await requestRef.current(method, params)
    } catch (err) {
      setNotice(failureText(err))
      throw err
    }
  })

  // The own balcony as the node holds it after a write. A failed read keeps
  // the write's own notice (an uncertain answer says to check first).
  const reread = async () => {
    try {
      const state = await readMine(requestRef.current)
      setView((v) => ({ ...v, mine: state }))
      return state
    } catch (err) {
      setNotice((n) => n || errorText(err))
      return null
    }
  }

  const begin = async () => {
    if (act.pending) return
    const next = startConsent(consent)
    if (next === consent) return
    setConsent(next)
    setNotice('')
    const r = await write('garden.set', { on: true })
    if (r.ok) {
      setConsent(closeConsent())
      setNotice('')
      load()
      return
    }
    setConsent((c) => ({ ...c, busy: false }))
    if (r.uncertain) {
      const state = await reread()
      if (state && state.on) {
        setConsent(closeConsent())
        load()
      }
    }
  }

  const leave = async () => {
    if (act.pending) return
    setNotice('')
    const r = await write('garden.set', { on: false })
    if (!r.ok && !r.uncertain) return
    const state = r.ok ? { on: false, base: null, savesToday: 0, given: [] } : await reread()
    if (state === null) return
    setLeaveOpen(false)
    if (state.on) {
      // The node still reads the balcony as on: the leave may have stopped
      // halfway. The uncertain notice stays and the balcony is read again,
      // with the queued acts that still hold.
      load()
      return
    }
    setView((v) => ({ ...v, mine: state }))
    setPending(pendingStart(null))
    setBal({ phase: 'idle', result: null, forced: false, error: null })
  }

  const exhausted = mine !== null && mine.savesToday >= GARDEN_SAVES_DAILY_MAX

  const save = async () => {
    if (act.pending || pendingCount(pending) === 0 || exhausted) return
    setNotice('')
    const r = await write('garden.play', { acts: pending.acts })
    if (!r.ok && !r.uncertain) return
    // The batch leaves the queue whatever the read below finds, so it is
    // never sent twice. A saved batch shows the pots the node answered with.
    const saved = r.ok && r.value && r.value.state && Array.isArray(r.value.state.pots) && r.value.state.pots.length === GARDEN_POTS ? r.value.state.pots : null
    setPending((p) => pendingStart(saved !== null ? saved : p.base))
    if (r.ok) toast(SAVED_TOAST)
    const state = await reread()
    if (state !== null) setPending((p) => rebased(p, state, owner, gardenTime()))
  }

  const tap = (op, index, plant) => {
    if (act.pending) return
    const action = plant === undefined ? { op, pot: index } : { op, pot: index, plant }
    const next = queue(pending, action, gardenTime(), counts)
    setPending(next)
    setNotice(next.refused === null ? '' : NOTICES.invalid)
    if (next.refused === null) setPotOpen(null)
  }

  const water = async (index) => {
    if (act.pending || helped) return
    setNotice('')
    const r = await write('garden.help', { to: owner, pot: index })
    if (r.ok) {
      setHelped('ok')
      setPotOpen(null)
      toast(WATERED_TOAST)
    } else if (r.uncertain) {
      // The help may have been written: no second button for it.
      setHelped('uncertain')
    }
  }

  // Leaving with queued acts asks first; nothing is written either way. A
  // batch already on its way to the node is not unsaved: leaving then asks
  // nothing, and the write goes on.
  const unsavedActs = () => pendingCount(pending) > 0 && !act.pending
  const guard = (go) => {
    if (typeof go !== 'function') return
    if (unsavedActs()) setUnsaved({ go })
    else go()
  }
  // Android Back and Escape ask the same way. The native swipe back and the
  // browser Back consult no guard, as for Anunciar.
  const backRef = useRef(null)
  backRef.current = () => {
    if (!unsavedActs() || typeof onBack !== 'function') return false
    setUnsaved({ go: onBack })
    return true
  }
  useEffect(() => {
    if (typeof registerBackGuard !== 'function') return
    return registerBackGuard(() => backRef.current())
  }, [registerBackGuard])

  const bar = <TopBar title={TITLE} onBack={() => guard(onBack)} right={<TopActions help={HELP.varandinha} />} />
  if (!hosted) {
    return (
      <View style={styles.screen}>
        {bar}
        <EmptyState icon='gente' title={TITLE} body={NOTICES.notHosted} />
      </View>
    )
  }
  if (!HEX64.test(owner)) {
    return (
      <View style={styles.screen}>
        {bar}
        <ErrorState message={UNAVAILABLE} />
      </View>
    )
  }
  if (view.phase === 'loading') {
    return (
      <View style={styles.screen}>
        {bar}
        <OfflineNote />
        <Skeleton rows={3} />
      </View>
    )
  }
  if (view.phase === 'error') {
    return (
      <View style={styles.screen}>
        {bar}
        <OfflineNote />
        <ErrorState message={view.error || UNAVAILABLE} onRetry={load} />
      </View>
    )
  }

  const consentSheet = (
    <Sheet open={consent.open} onClose={() => setConsent(closeConsent())} dismissable={!consent.busy && !act.pending} title={TITLE}>
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.sheetBody}>
        {CONSENT_LINES.map((line) => <Soft key={line}>{line}</Soft>)}
        <SwitchRow label={CONSENT_SWITCH_LABEL} value={consent.visible} onValueChange={() => setConsent(toggleConsent(consent))} disabled={consent.busy} />
        <ErrorText>{notice}</ErrorText>
        <Btn label={BEGIN_LABEL} onPress={begin} pending={consent.busy} disabled={!consent.visible || consent.busy} />
      </ScrollView>
    </Sheet>
  )

  if (!mine || !mine.on) {
    return (
      <View style={styles.screen}>
        {bar}
        <OfflineNote />
        <EmptyState icon='gente' title={TITLE} body={CONSENT_LINES[0]} actionLabel={BEGIN_LABEL} onAction={() => { setNotice(''); setConsent(openConsent()) }} />
        {consentSheet}
      </View>
    )
  }

  const result = bal.result
  const page = !!result && result.isPage
  // A balcony reads as off only when its blocks were read in full: an unread
  // or stale block, or an index still being built, proves nothing.
  const away = provenOff(result, bal.forced) && bal.phase === 'ready'
  const unproven = !!result && !result.isPage && !result.on && !provenOff(result, bal.forced)
  if (!own && (page || away)) {
    return (
      <View style={styles.screen}>
        {bar}
        <OfflineNote />
        <EmptyState icon='gente' title={TITLE} body={page ? NOTICES.page : NOTICES.notPlaying} />
      </View>
    )
  }
  if (!own && unproven) {
    return (
      <View style={styles.screen}>
        {bar}
        <OfflineNote />
        <ErrorState message={result.indexing ? NOTICES.indexing : NOTICES.incomplete} onRetry={load} />
      </View>
    )
  }

  // A neighbour's pots are shown only once the owner's blocks were judged.
  if (!own && !result) {
    return (
      <View style={styles.screen}>
        {bar}
        <OfflineNote />
        {bal.phase === 'error' ? <ErrorState message={bal.error || UNAVAILABLE} onRetry={load} /> : <Skeleton rows={3} />}
      </View>
    )
  }

  const pending6 = pendingCount(pending)
  const helpers = result && !page ? result.helpers : []
  const givenPer = own && counts ? counts.given : new Array(GARDEN_POTS).fill(0)
  const views = own
    ? ownViews(pending, result && !page ? result.received : null, givenPer, now)
    : (result && !page && result.on ? result.pots : new Array(GARDEN_POTS).fill(null))
  const labels = views.map((v, i) => potLabel(i, v, own ? !!pending.pots[i] : false))
  const notes = []
  if (result && !page) {
    if (result.indexing) notes.push(NOTICES.indexing)
    else if (!result.loading && (result.incomplete || result.stale || bal.forced)) notes.push(NOTICES.incomplete)
  }
  if (exhausted && own) notes.push(NOTICES.saves)

  // The node's own writer rule over the waterings garden.state listed: a
  // balcony already watered today, or a spent daily budget, offers no Regar.
  const allowed = !own && mine && self !== null && view.following === true &&
    rpc.garden.helpAllowed({ self, to: owner, follows: new Set([owner]), own: mine.given, now }).ok === true
  const canHelp = allowed && result !== null && result.on === true && mine.on && !helped
  const sheetView = potOpen === null ? null : views[potOpen]
  const occupied = potOpen !== null && own ? !!pending.pots[potOpen] : !!sheetView

  const scene = (
    <View style={styles.scene}>
      <GardenSceneView width={width} pots={views} scheme={scheme} labels={labels} onPressPot={(i) => { setNotice(''); setPotOpen(i) }} />
    </View>
  )

  const header = (
    <View>
      {!own ? <OwnerRow owner={owner} profile={names ? names.profileOf(owner) : null} /> : null}
      {scene}
      {notes.map((n) => <View key={n} style={styles.note}><Soft>{n}</Soft></View>)}
      {notice ? <View style={styles.note}><ErrorText>{notice}</ErrorText></View> : null}
      {!own && result && !result.loading && !page ? <View style={styles.note}><Text style={[styles.count, { color: colors.ink }]}>{visitorLine(result.helpers.length + (helped === 'ok' && !result.helpers.some((h) => h.author === self) ? 1 : 0))}</Text></View> : null}
      {own && typeof onOpenStreet === 'function'
        ? (
          <Pressable
            accessibilityRole='link'
            accessibilityLabel={STREET_TITLE}
            onPress={() => guard(onOpenStreet)}
            style={({ pressed }) => [styles.streetRow, pressed && styles.pressed]}
          >
            <Icon name='gente' size={22} color={colors.ink} />
            <Text style={styles.streetLabel}>{STREET_TITLE}</Text>
            <Icon name='seta' size={18} color={colors.soft} />
          </Pressable>
          )
        : null}
      {own ? <Text style={styles.section} accessibilityRole='header'>{WHO_WATERED}</Text> : null}
    </View>
  )

  let empty = null
  if (own) {
    if (bal.phase === 'error') empty = <ErrorState message={bal.error || UNAVAILABLE} onRetry={load} />
    else if (!result || result.loading) empty = <Skeleton rows={1} />
    else empty = <View style={styles.note}><Soft>{visitorLine(0)}</Soft></View>
  }
  const footer = own
    ? <View style={styles.more}><Pill label={LEAVE_LABEL} danger onPress={() => { setNotice(''); setLeaveOpen(true) }} /></View>
    : null

  return (
    <View style={styles.screen}>
      {bar}
      <OfflineNote />
      <RefreshableList
        data={own ? helpers : []}
        keyExtractor={(h) => h.author + ':' + h.seq}
        renderItem={({ item }) => <HelperRow author={item.author} at={item.at} now={now} profile={names ? names.profileOf(item.author) : null} />}
        extraData={{ now, notice, names }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={async () => {
          setRefreshing(true)
          try { await load() } finally { setRefreshing(false) }
        }}
        refreshing={refreshing}
        atEnd
      />
      {own && pending6 > 0
        ? (
          <View style={[styles.pendingBar, { paddingBottom: insets.bottom + space.sm }]}>
            <Text style={[styles.pendingText, { color: colors.ink }]}>{pendingLabel(pending6)}</Text>
            <View style={styles.pendingActions}>
              <Pill label={ACTIONS.discard} disabled={act.pending} onPress={() => { setPending(discard(pending)); setNotice('') }} />
              <Pill label={ACTIONS.save} filled pending={act.pending} disabled={exhausted} onPress={save} />
            </View>
          </View>
          )
        : null}
      <Sheet open={potOpen !== null} onClose={() => setPotOpen(null)} dismissable={!act.pending} title={potOpen === null ? '' : POT_WORD + (potOpen + 1)}>
        <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.sheetBody}>
          <PotInfo view={sheetView} now={now} />
          {own && potOpen !== null && !occupied
            ? (
              <>
                <Text style={styles.section} accessibilityRole='header'>{ACTIONS.plant}</Text>
                {rpc.garden.GARDEN_PLANTS.map((p) => (
                  <Btn key={p.id} label={plantLabel(p.id)} accessibilityLabel={ACTIONS.plant + ' ' + plantLabel(p.id)} secondary disabled={exhausted} onPress={() => tap('plant', potOpen, p.id)} />
                ))}
              </>
              )
            : null}
          {own && potOpen !== null && occupied
            ? (
              <>
                {sheetView && sheetView.canWater ? <Btn label={ACTIONS.water} disabled={exhausted} onPress={() => tap('water', potOpen)} /> : null}
                {sheetView && sheetView.ripe ? <Btn label={harvestVerb(sheetView.plant)} disabled={exhausted} onPress={() => tap('harvest', potOpen)} /> : null}
                <Btn label={ACTIONS.clear} danger disabled={exhausted} onPress={() => tap('clear', potOpen)} />
              </>
              )
            : null}
          {!own && potOpen !== null && canHelp && sheetView && !sheetView.ripe
            ? <Btn label={ACTIONS.water} pending={act.pending} onPress={() => water(potOpen)} />
            : null}
          <ErrorText>{notice}</ErrorText>
        </ScrollView>
      </Sheet>
      <Sheet open={leaveOpen} onClose={() => setLeaveOpen(false)} dismissable={!act.pending} title={LEAVE_TITLE}>
        <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.sheetBody}>
          <Soft>{CONSENT_LINES[4]}</Soft>
          <ErrorText>{notice}</ErrorText>
          <ConfirmStack
            confirm={<Btn label={LEAVE_LABEL} danger onPress={leave} pending={act.pending} />}
            cancel={<Btn label='Cancelar' secondary onPress={() => setLeaveOpen(false)} disabled={act.pending} />}
          />
        </ScrollView>
      </Sheet>
      <Sheet open={unsaved !== null} onClose={() => setUnsaved(null)} title={UNSAVED_TITLE}>
        <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.sheetBody}>
          <Soft>{UNSAVED_BODY}</Soft>
          <ConfirmStack
            confirm={<Btn label={UNSAVED_CONFIRM} danger onPress={() => { const go = unsaved.go; setUnsaved(null); setPending(discard(pending)); go() }} />}
            cancel={<Btn label={UNSAVED_STAY} secondary onPress={() => setUnsaved(null)} />}
          />
        </ScrollView>
      </Sheet>
      {consentSheet}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scene: { alignItems: 'center' },
  note: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  count: { ...type.rowName },
  more: { paddingHorizontal: space.lg, paddingVertical: space.lg, alignItems: 'flex-start' },
  section: { ...type.section, color: colors.soft, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs },
  streetRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, paddingVertical: space.sm, paddingHorizontal: space.lg },
  streetLabel: { ...type.rowName, color: colors.ink, flex: 1 },
  pressed: { opacity: 0.6 },
  helper: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, paddingVertical: space.sm, paddingHorizontal: space.lg },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.rowName, color: colors.ink },
  when: { ...type.caption, color: colors.soft },
  pendingBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.card },
  pendingText: { ...type.rowName, flexShrink: 1 },
  pendingActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  potInfo: { gap: space.xs },
  potName: { ...type.postName },
  sheetBody: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg }
})
