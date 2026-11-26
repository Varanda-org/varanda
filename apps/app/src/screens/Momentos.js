// Momentos (docs/rpc.md 5.113): the full-screen viewer, pushed above the tabs
// (App.js stack entry { screen: 'momentos', key: author }). It starts at that
// author's ring and plays the rings in ringOrder (own first, then unseen,
// then seen), each author's items oldest first, starting at the first one
// not yet seen (the mark syncs across the devices of the same passkey where the node is hosted). Black in both themes: the subtree reads the
// dark palette, so every control and sheet in it is drawn for black.
//
// The photo comes only from the node (node.media.read kind 'moment'): a blob
// the node fetched from the seeder and decrypted with the record's public
// key. It is read through the read-ahead store (src/momentPhotos.js), which
// keeps the item on screen, the two after it and the one before it, so a step
// shows the next photo at once; the store owns every URL and read file and
// releases them once no list names them (the ones off screen also after its
// max age). A gone blob (expired, deleted, never
// reached the seeder) reads 'Foto indisponível', never an error banner. The
// text is the author's, so it goes through displayText.
//
// Tap the right half: next; the left half: previous; hold: pause; swipe down
// or the close button: close. Photos advance after five seconds (15 with
// music, counted from audio start), videos after their duration, paused
// while pressed or in a menu, and never
// when the system asks for reduced motion. Past the last item of an author
// the next author in ringOrder plays, then the viewer closes.
//
// No likes, no view counts: 'Responder' (hosted, canReply) opens the private
// conversation with the author through the openMessage contract, with the
// moment as its context. Own moments offer 'Apagar' (moment.delete, after a
// confirmation; as the Page acted as, the Page's own momento goes through
// the page 'delete' action; an uncertain answer says so and the action is not
// offered again on that sheet) and 'Novo momento'. Each item shown is marked seen
// (src/momentSeen.js: no record, nobody told; synced where the node is hosted).
//
// Also exported for A Rua and Diário: useMoments (moments.read on a hosted
// node), useMomentSeen, momentsChanged and the delete confirmation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Easing, AccessibilityInfo, Image, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { pageDmClient } from '../dm-screen'
import { aheadMomentsOf, holdMsOf, momentMusicOf, momentRefOf, canReply, expiresIn, firstUnseenIndex, nextIndex, nextMomentOf, prevMomentOf, progressOf, replyContext, ringOrder, segmentMs, VIDEO_END_GRACE_MS } from '../moments'
import { IMAGE_MIMES, momentPhotoKey, momentPhotosFor } from '../momentPhotos'
import { actAs, pagesDm } from '../pages'
import { choicePage } from '../pageChoice'
import { pagesOn } from '../pageGate'
import { momentDeleteAs, momentPublisher, pageMomentsOf } from '../pageMoment'
import { memberKeyOf, useActing } from './Conversa'
import { canReact, reactionParams, reactionRetry, unsure, REACTION_SENT, REACTION_UNSURE } from '../momentReaction'
import { momentSwipe, swipeRelease, swipeTotal } from '../momentSwipe'
import { QUICK, reactionName } from '../reactions'
import { audiusPolicy, audiusReady } from '../account'
import { musicOriginOf } from '../music'
import { soundMuted, setSoundMuted, onSoundMute, SOUND_MUTE_LABEL, SOUND_UNMUTE_LABEL } from '../soundMute'
import { openExternal } from '../openExternal'
import { MomentMusic, prepareMomentMusic, warmMomentMusicItem } from '../ui/MomentMusic'
import { liveAuthors, liveItems, momentsOf } from '../momentSeen'
import { bindMomentSeen, loadMomentSeen, markMomentSeen, migrateMomentSeenOnce, onMomentSeen } from '../momentSeenStore'
import { cacheGeneration } from '../localCaches'
import { adoptVideoFile, revokeUrl, urlFromBytes } from '../media/display'
import VideoPlayer from '../media/VideoPlayer'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { ConfirmStack, ErrorText, Soft, UNCERTAIN, errorText, useNow } from '../ui'
import { ActionsSheet } from '../ui/ActionsSheet'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { MoreButton } from '../ui/MoreButton'
import { HelpButton, useHelpOpen } from '../ui/Help'
import { tap } from '../ui/haptics'
import { excerptOf } from '../ui/MomentosStrip'
import { Pill } from '../ui/Pill'
import { Scrim, scrimColor } from '../ui/Scrim'
import { Sheet } from '../ui/Sheet'
import { IconAction } from '../ui/TopActions'
import { layout, radius, space, type } from '../ui/theme'
import { ThemeContext, useStyles, useTheme } from '../ui/ThemeProvider'
import { paletteFor } from '../appearance.js'
import { STACK_MS } from '../stackMotion'

export const PHOTO_UNAVAILABLE = 'Foto indisponível'
export const VIDEO_UNAVAILABLE = 'vídeo indisponível'
export const OWN_NOTE = 'O momento sai dos servidores em até 14 dias.'
export const DELETE_TITLE = 'Apagar momento?'
export const DELETE_BODY = 'O momento deixa de aparecer para quem segue você. Cópias que outras pessoas fizeram não voltam.'
// A moment past its 24 hours is already shown to nobody.
export const DELETE_BODY_PAST = 'O momento sai do seu diário. Já não aparece para ninguém.'
export const DELETE_BODY_PAGE = 'O momento deixa de aparecer para quem segue a Página. Cópias que outras pessoas fizeram não voltam.'
export const DELETE_BODY_PAST_PAGE = 'O momento sai do diário da Página. Já não aparece para ninguém.'
export const NONE_TEXT = 'Nenhum momento agora.'
const OFF_TEXT = 'Momentos disponíveis no app hospedado.'
// Owner of the viewer's photo reads: another owner's want() must not end them.
const PHOTO_OWNER = 'viewer'
// A drag down past this many points (or a quick flick) closes the viewer.
const CLOSE_DRAG = 100
const TAP_SLOP = 10
// A drag down from the caption's top this far before the ScrollView claims
// it (Android) is a swipe-down; checked again after the settle time.
const CAPTION_PULL = 4
const CAPTION_PULL_SETTLE_MS = 120
// How often the open viewer checks the 24-hour end of what it shows.
export const EXPIRY_TICK_MS = 15000
// Longer than ActionsSheet's wait before it runs the chosen action.
export const MENU_SETTLE_MS = 1000
export const MUSIC_START_WAIT_MS = 3000
export const LINK_HOLD_GRACE_MS = 1000

// A failure text for a mutating request: an uncertain one may have been
// applied, so it says to check before trying again.
export function failureText (err) {
  return err && err.uncertain === true ? UNCERTAIN : errorText(err)
}

// A Rua and Diário read again after a moment is created or deleted.
const listeners = new Set()
export function momentsChanged () {
  for (const fn of [...listeners]) {
    try { fn() } catch {}
  }
}
function useMomentsChanged () {
  const [n, setN] = useState(0)
  useEffect(() => {
    const fn = () => setN((x) => x + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return n
}

// moments.read (local replicas only, no network) on a hosted node. Nothing
// runs elsewhere: the core node answers USAGE for every Momentos method.
// A seed whose authors and own are arrays is the validated copy and paints
// at once. The hook does not filter it by blocks or mutes: the caller
// derives what is visible on every render, so an author hidden while
// block.list is pending comes back when it answers and a later block hides
// a seeded author. The live answer replaces that strip in place. Seen
// migration runs only after a live answer, never from the seed.
export function useMoments ({ ownKey = null, active = true, tick = 0, seed = null } = {}) {
  const node = useNode()
  const { request } = node
  const hosted = node.hosted === true
  const changed = useMomentsChanged()
  const [state, setState] = useState(() => {
    if (seed !== null && typeof seed === 'object' && Array.isArray(seed.authors) && Array.isArray(seed.own)) {
      return { phase: 'ready', authors: seed.authors, own: seed.own, past: [], error: null, seeded: true, live: false, readGen: null }
    }
    return { phase: 'idle', authors: [], own: [], past: [], error: null, seeded: false, live: false, readGen: null }
  })
  const runRef = useRef(0)
  const enabled = hosted && active !== false
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const load = useCallback(async () => {
    if (!enabled) return
    const run = ++runRef.current
    try {
      // Taken before the request: the answer is stamped with the generation
      // it was read under, so a purge during the wait stays visible.
      const g = cacheGeneration()
      const answer = await request('moments.read', {})
      if (run !== runRef.current) return
      const next = momentsOf(answer, own)
      setState({ phase: 'ready', ...next, error: null, seeded: false, live: true, readGen: g })
      // Once per node: the per-device list of the moments answered now moves
      // into the seen document (a node without one keeps it here). A seed
      // is not an answer and must not mark anything seen.
      migrateMomentSeenOnce(new Set(next.authors.flatMap((a) => a.items.map((item) => item.ref)))).catch(() => {})
    } catch (err) {
      if (run === runRef.current) setState((s) => ({ ...s, phase: s.phase === 'ready' ? 'ready' : 'error', error: errorText(err) }))
    }
  }, [enabled, request, own])
  useEffect(() => { load() }, [load, tick, changed, node.epoch])
  useEffect(() => () => { runRef.current++ }, [])
  return { ...state, enabled: hosted, phase: hosted ? state.phase : 'off', reload: load }
}

// The refs seen, kept current across screens: the node's list on a hosted
// node that keeps one, this device's otherwise.
export function useMomentSeen () {
  const node = useNode()
  const hosted = node.hosted === true
  const [seen, setSeen] = useState(null)
  useEffect(() => {
    bindMomentSeen(hosted ? { key: node.epoch, request: node.request } : null)
  }, [hosted, node.epoch, node.request])
  useEffect(() => {
    let live = true
    loadMomentSeen().then((list) => { if (live) setSeen(list) }, () => { if (live) setSeen([]) })
    const off = onMomentSeen((list) => { if (live) setSeen(list) })
    return () => { live = false; off() }
  }, [])
  return { loaded: seen !== null, seen: seen || [], mark: markMomentSeen }
}

// The delete sheet's text: past 24 hours it is already shown to nobody, and a
// Page's momento sits in the Page's diary.
export function deleteBody (target, page) {
  const past = !!target && expiresIn(target.at) === 0
  if (page !== null) return past ? DELETE_BODY_PAST_PAGE : DELETE_BODY_PAGE
  return past ? DELETE_BODY_PAST : DELETE_BODY
}

// Confirmation before moment.delete (ConfirmStack), or before the page
// 'delete' when `page` (the page acted as) owns the momento. An uncertain
// answer says so and takes the confirm button away: the person checks before
// trying.
export function ConfirmMomentDelete ({ open, target, page = null, onClose, onDeleted }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const { request } = node
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [uncertain, setUncertain] = useState(false)
  useEffect(() => {
    if (open) { setError(null); setUncertain(false) }
  }, [open])
  const confirm = async () => {
    if (pending || uncertain || !target) return
    setPending(true)
    setError(null)
    let ok = false
    try {
      const as = momentDeleteAs(target.ref, page)
      if (as === null) await request('moment.delete', { to: target.ref })
      else await actAs(node, { member: await memberKeyOf(request, node), action: 'delete', page: as, op: { to: target.ref } })
      ok = true
    } catch (err) {
      setError(failureText(err))
      if (err && err.uncertain === true) setUncertain(true)
    } finally {
      setPending(false)
      momentsChanged()
    }
    if (ok) {
      if (typeof onDeleted === 'function') onDeleted(target)
      onClose()
    }
  }
  return (
    // No iOS swipe-down while the delete runs: it would hide the sheet and
    // leave the viewer paused with nothing to close. Any other dismissal runs
    // onClose, which clears the viewer's `deleting`.
    <Sheet open={open} onClose={pending ? () => {} : onClose} dismissable={!pending} title={DELETE_TITLE}>
      <View style={styles.sheetBody}>
        <Soft>{deleteBody(target, page)}</Soft>
        <Soft>{OWN_NOTE}</Soft>
        <ErrorText>{error}</ErrorText>
        {uncertain
          ? <ConfirmStack confirm={null} cancel={{ label: 'Fechar', onPress: onClose }} />
          : (
            <ConfirmStack
              confirm={{ label: 'Apagar', danger: true, pending, onPress: confirm }}
              cancel={{ onPress: onClose, disabled: pending }}
            />
            )}
      </View>
    </Sheet>
  )
}

export const PAGE_MOMENTS_TITLE = 'Momentos da Página'
export const PAGE_MOMENTS_FAILED = 'Não foi possível ler os momentos da Página.'

// The Page's own momentos, live and past, for whoever acts as that Page: the
// node's rings cover only followed diaries for 24 h, so an admin who does not
// follow the Page, or a momento past 24 hours, is reached only through the
// service's signed page 'status'. Each row deletes through the page action.
// A failed read says so and the list is read again on 'Tentar de novo'
// (a read, never a repeat of a delete).
export function PageMoments ({ page, now = Date.now(), tick = 0, active = true }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const key = momentPublisher(page)
  const changed = useMomentsChanged()
  // Rows and the open delete sheet belong to the Page and node epoch they were
  // read for: a lock, sign-out or another identity drops them.
  const epoch = node.epoch
  const owner = key === null ? null : key + '|' + epoch
  const [state, setState] = useState({ owner: null, phase: 'idle', status: null })
  const [reads, setReads] = useState(0)
  const [deleting, setDeleting] = useState(null)
  const nodeRef = useRef(node)
  nodeRef.current = node
  const hosted = node.hosted === true
  useEffect(() => {
    if (owner === null || !hosted || active === false) return undefined
    let live = true
    setState((s) => ({ owner, phase: 'loading', status: s.owner === owner ? s.status : null }))
    ;(async () => {
      try {
        const member = await memberKeyOf(nodeRef.current.request, nodeRef.current)
        const status = await actAs(nodeRef.current, { member, action: 'status', page: key })
        if (live) setState({ owner, phase: 'ready', status })
      } catch {
        if (live) setState((s) => ({ owner, phase: 'error', status: s.owner === owner ? s.status : null }))
      }
    })()
    return () => { live = false }
  }, [owner, key, hosted, active, reads, changed, tick])
  if (key === null || !hosted) return null
  const phase = state.owner === owner ? state.phase : 'idle'
  // Split at render, against the screen's clock, so a momento that passes 24 h
  // while the list is open moves to the past ones.
  const mine = { phase, ...pageMomentsOf(state.owner === owner ? state.status : null, key, now) }
  const target = deleting !== null && deleting.page === owner ? deleting.target : null
  const row = (m, past) => {
    const text = excerptOf(m.text)
    return (
      <View key={m.ref} style={styles.pageRow}>
        <View style={styles.pageText}>
          <Text style={styles.pageMeta} numberOfLines={1}>{(past ? 'Anterior, ' : '24 h, ') + (relativeTime(m.at, now) || '')}</Text>
          <Text style={styles.pageExcerpt} numberOfLines={2}>{text !== '' ? text : 'Momento com foto'}</Text>
        </View>
        <MoreButton
          label='mais ações do momento'
          actions={[{ icon: 'lixeira', label: 'Apagar', danger: true, onPress: () => setDeleting({ page: owner, target: { ref: m.ref, at: m.at } }) }]}
        />
      </View>
    )
  }
  let body = null
  if (mine.phase === 'error') {
    body = (
      <View style={styles.pageSection}>
        <ErrorText>{PAGE_MOMENTS_FAILED}</ErrorText>
        <Pill label='Tentar de novo' onPress={() => setReads((n) => n + 1)} />
      </View>
    )
  } else if (mine.live.length > 0 || mine.past.length > 0) {
    body = (
      <View style={styles.pageSection}>
        <Text style={styles.pageTitle} accessibilityRole='header'>{PAGE_MOMENTS_TITLE}</Text>
        {mine.live.map((m) => row(m, false))}
        {mine.past.map((m) => row(m, true))}
      </View>
    )
  }
  // Mounted in every branch and closed only by the sheet itself: a reload
  // that fails or comes back empty must not hide the delete's outcome.
  return (
    <>
      {body}
      <ConfirmMomentDelete open={target !== null} target={target} page={key} onClose={() => setDeleting(null)} />
    </>
  )
}

// null until known, then whether the system asks for reduced motion.
function useMotionReduced () {
  const [reduce, setReduce] = useState(null)
  useEffect(() => {
    let live = true
    let sub = null
    try {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((value) => {
        if (live) setReduce(value === true)
      }, () => { if (live) setReduce(false) })
      sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
        if (live) setReduce(value === true)
      })
    } catch {
      setReduce(false)
    }
    return () => {
      live = false
      try { if (sub && typeof sub.remove === 'function') sub.remove() } catch {}
    }
  }, [])
  return reduce
}

// Auto-advance runs only when the system is known not to reduce motion.
export function autoAdvanceOn (reduce) {
  return reduce === false
}

// One store per node.media and epoch: a lock, sign-out or another identity
// clears the old one, so no photo of the last session survives.
function photoStoreOf (node) {
  return momentPhotosFor(node.media, node.epoch, { urlFromBytes, revokeUrl, adoptVideoFile })
}

const PHOTO_LOADING = { phase: 'loading', uri: null }
const PHOTO_OFF = { phase: 'off', uri: null }

// The media of an author's item -> { phase: 'loading' | 'ok' | 'off', uri }.
// The store owns the URL: the hook never releases it.
function useMomentPhoto (author, item) {
  const node = useNode()
  const store = photoStoreOf(node)
  const ref = momentRefOf(author, item)
  const key = ref === null ? '' : momentPhotoKey(ref.author, ref.seq)
  const seq = ref?.seq
  const mime = ref?.expected.mime
  const ms = ref?.expected.ms
  const until = ref?.until
  const [state, setState] = useState({ key: null, store: null, ...PHOTO_LOADING })
  // The store is the truth for what may be shown: it revokes a URL when it
  // drops the entry, so an 'ok' kept in state may name a dead URL.
  const settled = store !== null && key !== '' ? store.peek(key) : null
  const mine = state.key === key && state.store === store
  // The store dropped the photo this hook showed: read it again, once per loss.
  const lost = mine && state.phase === 'ok' && settled === null
  const [again, setAgain] = useState(0)
  useEffect(() => {
    if (lost) setAgain((n) => n + 1)
  }, [lost])
  useEffect(() => {
    if (store === null || key === '') {
      setState({ key, store, ...PHOTO_OFF })
      return undefined
    }
    let alive = true
    // Also for a settled entry: read() holds it until the viewer's next list.
    store.read({ author, seq, expected: { mime, ms }, until }, PHOTO_OWNER).then((got) => {
      if (alive) setState({ key, store, phase: got.phase, uri: got.phase === 'ok' ? got.uri : null, ms: got.ms })
    })
    return () => { alive = false }
  }, [store, key, mime, ms, until, again])
  // Bytes that pass every check but do not decode: 'Foto indisponível', not a
  // blank moment (the Image's onError). The store keeps 'off' so the next
  // visit does not read them again. Only for the URL the store still holds:
  // a late error from a dropped or replaced source says nothing about it.
  const fail = useCallback((uri) => {
    const held = store !== null && key !== '' ? store.peek(key) : null
    if (held === null || held.phase !== 'ok' || held.uri !== uri) return
    store.fail(key)
    setState((s) => (s.key === key && s.store === store ? { key, store, ...PHOTO_OFF } : s))
  }, [store, key])
  let shown
  if (store === null || key === '') shown = PHOTO_OFF
  // An entry read ahead shows on the first render of its item, never a
  // spinner frame before the effect runs.
  else if (settled !== null) shown = { phase: settled.phase, uri: settled.phase === 'ok' ? settled.uri : null, ms: settled.ms }
  // A failed read is not cached by the store: state alone remembers it.
  else if (mine && state.phase === 'off') shown = PHOTO_OFF
  else shown = PHOTO_LOADING
  const shownUri = shown.uri
  const failShown = useCallback(() => fail(shownUri), [fail, shownUri])
  return { key, phase: shown.phase, uri: shown.uri, ms: shown.ms, fail: failShown }
}

// Each visit has its own token: a queued player event or animation completion
// from an earlier visit must never advance the current item. control is the
// player's { play, unmute }: a press calls it in its own handler, because a
// browser that wants a gesture may not count the player's later effect.
function useMomentPlayback ({ itemKey, ms, video, loaded, active, autoOn, step, control }) {
  const progress = useRef(new Animated.Value(0)).current
  const [restartTick, setRestartTick] = useState(0)
  const visit = useMemo(() => ({ remaining: ms, position: null, moving: false, advanced: false }), [itemKey, ms, restartTick])
  const [ready, setReady] = useState(null)
  const [manual, setManual] = useState(null)
  const [ended, setEnded] = useState(null)
  const [muted, setMuted] = useState(null)
  const [blocked, setBlocked] = useState(null)
  const running = active && loaded && autoOn && blocked !== visit && (!video || ready === visit)
  const playing = video && active && loaded && blocked !== visit && ended !== visit && (running || (!autoOn && manual === visit))
  // What playing becomes once a press clears the block and sets manual: the
  // player is started only when the props will agree.
  const canPlay = video && active && loaded && ended !== visit && (!autoOn || ready === visit)
  const current = useRef(null)
  current.current = { visit, running, autoOn, step, canPlay }
  useEffect(() => {
    progress.setValue(0)
  }, [visit, progress])
  useEffect(() => {
    if (!video || !loaded) return undefined
    const timer = setTimeout(() => setReady(visit), 2000)
    return () => clearTimeout(timer)
  }, [video, loaded, visit])
  const advance = () => {
    if (current.current.visit !== visit || !current.current.running || visit.advanced) return
    visit.advanced = true
    current.current.step('next')
  }
  useEffect(() => {
    if (!running) return undefined
    // A close ignored during a stack slide may run again after a hold.
    visit.advanced = false
    let live = true
    let grace = null
    const anim = Animated.timing(progress, { toValue: 1, duration: Math.max(0, visit.remaining), easing: Easing.linear, useNativeDriver: false })
    anim.start(({ finished }) => {
      if (!live || !finished) return
      // The player can trail the clock or run past the clamped segment: onEnd
      // advances, and the timer bounds the wait.
      if (video && visit.moving) grace = setTimeout(advance, VIDEO_END_GRACE_MS)
      else advance()
    })
    return () => {
      live = false
      clearTimeout(grace)
      anim.stop()
      progress.stopAnimation((value) => {
        if (current.current.visit !== visit) return
        visit.remaining = Math.max(0, video && visit.position !== null ? ms - visit.position : (1 - value) * ms)
        progress.setValue(1 - visit.remaining / ms)
      })
    }
  }, [running, visit, progress, ms, video])
  const handleProgress = ({ ms: position, playing: moving }) => {
    if (current.current.visit !== visit || !Number.isFinite(position)) return
    visit.position = Math.max(0, Math.min(ms, position))
    // The pause a hold causes says nothing about the player once released.
    if (current.current.running) visit.moving = moving === true
    if (!current.current.running || moving === false) visit.remaining = ms - visit.position
    if (!current.current.running) progress.setValue(visit.position / ms)
  }
  return {
    progress,
    playing,
    blocked: blocked === visit,
    muted: muted === visit,
    ended: ended === visit,
    started: manual === visit,
    restartTick,
    restart: () => setRestartTick((n) => n + 1),
    handlePlay: () => {
      if (current.current.visit !== visit) return
      if (current.current.canPlay) control?.current?.play()
      setBlocked(null)
      setManual(visit)
    },
    handleUnmute: () => {
      if (current.current.visit !== visit) return
      control?.current?.unmute()
      setMuted(null)
    },
    handleReady: () => { if (current.current.visit === visit) setReady(visit) },
    handleSoundRefused: () => { if (current.current.visit === visit) setMuted(visit) },
    handlePlayBlocked: () => { if (current.current.visit === visit) setBlocked(visit) },
    handleProgress,
    handleEnd: () => {
      if (current.current.visit !== visit) return
      visit.moving = false
      setEnded(visit)
      if (current.current.autoOn) advance()
      else progress.setValue(1)
    }
  }
}

// The rings the viewer plays, fixed when it opens so marking items seen does
// not reorder them under the person: own first (when there are own live
// items), then unseen, then seen; each ring oldest first.
export function viewerRings ({ authors, own, ownKey, seen, now = Date.now() }) {
  const list = liveAuthors(authors, now)
  const ownItems = liveItems(own, now)
  const all = typeof ownKey === 'string' && ownItems.length > 0 ? [{ author: ownKey, items: ownItems }].concat(list) : list
  return ringOrder(all, seen, ownKey).map((ring) => {
    const items = ring.items.slice().reverse()
    return { author: ring.author, items, start: firstUnseenIndex(items, seen) }
  })
}

// The scrims (src/ui/Scrim.js): solid behind the header and behind the
// caption, note and pills, so the text reads over a white photo, and a real
// gradient to clear only past the text (32 pt below the header, 48 pt above
// the bottom content).
export const TOP_SCRIM = { alpha: 0.55, fade: 32 }
export const BOTTOM_SCRIM = { alpha: 0.6, fade: 48 }
// When the bottom block (a long caption, large text) comes within both fades
// of the header, the light strip left between them reads as a band: then one
// solid scrim covers the photo instead. topEnd is the header block's bottom,
// bottomStart the bottom block's top, both from onLayout.
// SCRIM_MIN_CLEAR: a gap of photo narrower than this between the two fades
// still reads as a light band (short or landscape windows), so it merges too.
const SCRIM_MIN_CLEAR = 96
export function scrimsMeet (topEnd, bottomStart) {
  if (!Number.isFinite(topEnd) || !Number.isFinite(bottomStart)) return false
  return bottomStart - topEnd < TOP_SCRIM.fade + BOTTOM_SCRIM.fade + SCRIM_MIN_CLEAR
}
// The caption scrolls inside at most this share of the window height, so a
// caption of many short lines never covers the header controls.
export const CAPTION_MAX_SHARE = 0.4
// At the largest text sizes 40% can still reach the header (a two-line pill,
// the note): the cap also leaves the header, the bar and CAPTION_CLEAR free,
// never below CAPTION_MIN (about three lines, still scrollable).
const CAPTION_CLEAR = 24
const CAPTION_MIN = 72
export function captionCap ({ height, topEnd, barHeight = 0, bottomPad = 0 }) {
  const share = Math.round(height * CAPTION_MAX_SHARE)
  if (!Number.isFinite(topEnd)) return share
  const room = Math.round(height - topEnd - barHeight - bottomPad - CAPTION_CLEAR)
  return Math.max(CAPTION_MIN, Math.min(share, room))
}
export function captionLayout ({ max, fontScale, lineHeight, hit, height }) {
  const collapsedHeight = lineHeight * fontScale * 3
  if (max < collapsedHeight + hit || height <= collapsedHeight) {
    return { collapsedHeight: max, expandedHeight: max, long: false }
  }
  return { collapsedHeight, expandedHeight: max - hit, long: true }
}
// A close the stack ignored (goBack during a slide) frees the latch after
// the slide's time, so the next close works.
const CLOSE_RELEASE_MS = STACK_MS + 150
// A backstop for a bright spot the scrim leaves lighter than expected.
const TEXT_SHADOW = { textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 }

// The refs the node's last answer lists (own and followed), or null before
// one arrived.
export function listedRefs (data) {
  if (!data || data.phase !== 'ready') return null
  const refs = new Set()
  for (const it of data.own || []) refs.add(it.ref)
  for (const a of data.authors || []) for (const it of a.items || []) refs.add(it.ref)
  return refs
}

// A delete from the own viewer that empties the own ring closes the viewer
// instead of moving on to someone else's moments.
export function closesAfterDelete (ring, own, target) {
  if (!ring || !target || typeof own !== 'string' || ring.author !== own) return false
  return ring.items.every((it) => it.ref === target.ref)
}

// The rings after dropping the items `keep` refuses, and where to stand:
// the same item when it stays, else the next one of that ring, else the next
// ring's start; { close: true } when nothing is left to show there.
// -> null (nothing dropped) | { close: true } | { rings, pos }
export function pruneRings (rings, pos, keep) {
  let ringAt = null
  let itemAt = 0
  let gone = -1
  let dropped = false
  const next = []
  rings.forEach((r, i) => {
    const items = r.items.filter(keep)
    if (items.length !== r.items.length) dropped = true
    if (i === pos.ring) {
      if (items.length > 0) {
        ringAt = next.length
        itemAt = Math.min(r.items.slice(0, pos.item).filter(keep).length, items.length - 1)
      } else {
        gone = next.length
      }
    }
    // The start moves back by the items dropped before it, so it still names
    // the same first unseen item.
    if (items.length > 0) next.push({ ...r, items, start: Math.min(r.items.slice(0, r.start).filter(keep).length, items.length - 1) })
  })
  if (!dropped) return null
  if (next.length === 0) return { close: true }
  if (ringAt !== null) return { rings: next, pos: { ring: ringAt, item: itemAt } }
  if (gone < 0 || gone >= next.length) return { close: true }
  return { rings: next, pos: { ring: gone, item: next[gone].start } }
}

export default function Momentos (props) {
  const theme = useTheme()
  const darkTheme = useMemo(() => ({ ...theme, scheme: 'dark', colors: paletteFor('dark') }), [theme])
  return (
    <ThemeContext.Provider value={darkTheme}>
      <Viewer {...props} />
    </ThemeContext.Provider>
  )
}

function useMomentMusicPolicy (node, member, active) {
  const origin = musicOriginOf(node)
  const epoch = node.epoch
  const [result, setResult] = useState(null)
  useEffect(() => {
    let live = true
    setResult(null)
    if (!active || origin === null) return undefined
    const load = async () => {
      try {
        const policy = await audiusPolicy({ origin })
        if (!live) return
        if (policy.moments !== true) {
          setResult({ epoch, member, origin, ok: false })
          return
        }
        const ready = await audiusReady({ member, origin })
        if (live) setResult({ epoch, member, origin, ok: ready === true })
      } catch {
        if (live) setResult({ epoch, member, origin, ok: false })
      }
    }
    load()
    return () => { live = false }
  }, [active, epoch, member, origin])
  if (!active || origin === null) return false
  if (result?.epoch !== epoch || result?.member !== member || result?.origin !== origin) return null
  return result.ok
}

function Viewer ({ entry, ownKey, isTop = true, covered = false, onBack, onOpenMember, onMessage, onCreate }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const { request } = node
  const names = useNames()
  const insets = useSafeAreaInsets()
  const win = useWindowDimensions()
  // Often enough that a moment never shows long past its 24 hours.
  const now = useNow(EXPIRY_TICK_MS)
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const data = useMoments({ ownKey: own })
  const seenState = useMomentSeen()
  const reduce = useMotionReduced()
  const autoOn = autoAdvanceOn(reduce)
  const helpOpen = useHelpOpen()
  const [soundOff, setSoundOff] = useState(soundMuted())
  useEffect(() => {
    const sync = () => setSoundOff(soundMuted())
    sync()
    return onSoundMute(sync)
  }, [])

  // Fixed on the first answer (see viewerRings); a delete removes its item.
  const [rings, setRings] = useState(null)
  const [pos, setPos] = useState({ ring: 0, item: 0 })
  useEffect(() => {
    if (rings !== null || data.phase !== 'ready' || !seenState.loaded) return
    const next = viewerRings({ authors: data.authors, own: data.own, ownKey: own, seen: seenState.seen, now: Date.now() })
    const at = next.findIndex((r) => r.author === entry.key)
    setRings(next)
    setPos(at === -1 ? { ring: -1, item: 0 } : { ring: at, item: next[at].start })
  }, [rings, data.phase, data.authors, data.own, own, seenState.loaded, seenState.seen, entry.key])

  const ring = rings !== null && pos.ring >= 0 ? rings[pos.ring] : null
  const item = ring ? ring.items[pos.item] : null
  // The own key or a followed author: viewerRings reads moments.read only,
  // so the avatar below may persist.
  const author = ring ? ring.author : null
  const mine = author !== null && author === own
  // The momento of the Page acted as: deleted through the page 'delete'.
  const actingPage = choicePage(useActing())
  const pageOwn = !mine && author !== null && actingPage === author
  const photo = useMomentPhoto(author, item)
  const handlePhotoError = photo.fail
  const itemKey = item ? item.ref : ''
  const [reactionStates, setReactionStates] = useState({})
  const [reacting, setReacting] = useState(false)
  const reactionBusy = useRef(false)
  const reactionUncertain = useRef(new Set())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const reactionAvailable = !mine && !pageOwn && canReact(node) && item !== null
  const reactionVisible = !mine && !pageOwn && item !== null
  const reaction = reactionStates[itemKey]
  // Acting as a Página, the reaction to a person's momento is the page's
  // signed one-emoji message with moment (inner v12): dm.pageDraft, the page
  // statement, dm.pageSend, as the page's other Conversas sends. With Páginas
  // off (pagesOn), as in Mensagem, it reacts as the person.
  const reactPage = actingPage !== null && author !== actingPage && pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) ? actingPage : null
  const react = async (emoji, retry = null) => {
    if (!mounted.current || reactionBusy.current || !reactionAvailable || (retry === null && reactionUncertain.current.has(item.ref))) return
    const ref = item.ref
    reactionBusy.current = true
    setReacting(true)
    setReactionStates((states) => ({ ...states, [ref]: null }))
    try {
      if (retry !== null) await retry()
      else if (reactPage === null) await request('dm.send', reactionParams(item, author, emoji))
      else {
        const sign = async (digest) => pagesDm(node, { member: await memberKeyOf(request, node), page: reactPage, action: 'dm-sign', op: { digest } })
        await pageDmClient({ request, sign, page: reactPage })('dm.send', reactionParams(item, author, emoji))
      }
      reactionUncertain.current.delete(ref)
      if (mounted.current) setReactionStates((states) => ({ ...states, [ref]: { text: REACTION_SENT } }))
    } catch (err) {
      const uncertain = unsure(err)
      if (uncertain) reactionUncertain.current.add(ref)
      else reactionUncertain.current.delete(ref)
      const again = uncertain ? reactionRetry(err, reactPage !== null) || retry : null
      if (mounted.current) setReactionStates((states) => ({ ...states, [ref]: { uncertain, retry: again, text: uncertain ? REACTION_UNSURE : errorText(err) } }))
    } finally {
      reactionBusy.current = false
      if (mounted.current) setReacting(false)
    }
  }
  const music = momentMusicOf(item)
  const nextItem = nextMomentOf(rings, pos)
  const nextKey = nextItem ? nextItem.ref : ''
  const nextMusic = momentMusicOf(nextItem)
  const musicOrigin = musicOriginOf(node)
  const musicOn = useMomentMusicPolicy(node, own, music !== null || nextMusic !== null)

  // Photos are read while the person looks: the item on screen, the two a
  // step forward reaches and the one a step back reaches. Hidden (under a
  // sheet, another screen or in the background) only the item on screen.
  const photoStore = photoStoreOf(node)
  const photoAhead = isTop && !covered && node.visible !== false
  const ahead2 = aheadMomentsOf(rings, pos, 2)
  // Nulls keep their place: the store reads the first entry as the item on
  // screen and the second as the next one, so the list is always [current,
  // next, after next, previous], even at the last momento.
  const wanted = item === null
    ? []
    : [{ author, item }].concat(photoAhead ? [ahead2[0] || null, ahead2[1] || null, prevMomentOf(rings, pos)] : []).map((m) => (m ? momentRefOf(m.author, m.item) : null))
  const wantKey = wanted.map((ref) => (ref ? momentPhotoKey(ref.author, ref.seq) : '-')).join(',')
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const nextRef = photoAhead && wanted.length > 1 ? wanted[1] : null
  const nextImage = nextRef !== null && IMAGE_MIMES.includes(nextRef.expected.mime)
  const nextPhotoKey = nextImage ? momentPhotoKey(nextRef.author, nextRef.seq) : ''
  // Bumped when the queue settles the next photo, so its hidden decode below
  // renders. No read() of its own: that would start a read past the store's
  // cap and hold the photo beyond the item on screen.
  const [, setNextLanded] = useState(0)
  useEffect(() => {
    if (photoStore === null || nextPhotoKey === '') return undefined
    return photoStore.subscribe((key, got) => {
      if (key === nextPhotoKey && got.phase === 'ok') setNextLanded((n) => n + 1)
    })
  }, [photoStore, nextPhotoKey])
  useEffect(() => {
    if (photoStore === null) return undefined
    photoStore.want(PHOTO_OWNER, wantedRef.current)
  }, [photoStore, wantKey])
  useEffect(() => {
    if (photoStore === null) return undefined
    return () => photoStore.want(PHOTO_OWNER, [])
  }, [photoStore])
  const nextSettled = nextPhotoKey !== '' && photoStore !== null ? photoStore.peek(nextPhotoKey) : null
  const warmUri = nextSettled?.phase === 'ok' ? nextSettled.uri : null

  const [musicState, setMusicState] = useState(null)
  const musicStarted = musicOn === true && musicState?.key === itemKey && musicState.phase === 'playing'
  // Opened muted: use photo time until unmuted, then wait up to 3 s for
  // audio. Its first start restarts the bar at 15 s, even after photo time.
  const musicWaiting = music !== null && musicOn !== false && (musicState?.key !== itemKey || musicState.phase === 'waiting') && !soundOff
  const [musicClosed, setMusicClosed] = useState(false)
  useEffect(() => { setMusicState(null) }, [itemKey, node.epoch])

  const ahead = useRef(null)
  const handed = useRef(null)
  // One preload per momento-and-next pair for the life of this viewer.
  // The last pair alone would be tried again after a step back.
  const tried = useRef(new Set())
  const musicQuota = useRef(false)
  const prepared = ahead.current?.key === itemKey ? ahead.current.handle : handed.current?.key === itemKey ? handed.current.handle : null
  const musicFallback = musicState?.key === itemKey && musicState.phase === 'fallback'
  const musicSettled = music === null || musicStarted || musicFallback
  // After the 3 s timer the current audio may still be loading: opening the
  // next one then would race it for the link and for the member's relays.
  const streamNext = music === null || musicStarted || (musicFallback && musicState.timer !== true)
  useEffect(() => {
    // Cleanups run before setups, so releasing there could cancel a handoff.
    if (ahead.current?.key === itemKey) {
      handed.current?.handle.release()
      handed.current = { key: itemKey, handle: ahead.current.handle }
      ahead.current = null
    }
    if (handed.current && handed.current.key !== itemKey) {
      handed.current.handle.release()
      handed.current = null
    }
    // Muted, a momento spends no request or play use, and neither does the next one.
    // A sheet over the stack (Ajustes, a report, help) covers the viewer without moving isTop.
    const allowed = musicOn === true && isTop && !covered && node.visible !== false && !musicClosed && !soundOff
    if (ahead.current && (!allowed || ahead.current.key !== nextKey || ahead.current.own !== own || ahead.current.origin !== musicOrigin || ahead.current.epoch !== node.epoch)) {
      ahead.current.handle.release()
      ahead.current = null
    }
    const pair = itemKey + '>' + nextKey
    if (allowed && nextMusic !== null && itemKey !== '' && photo.phase !== 'loading' && musicSettled && ahead.current === null && !musicQuota.current && !tried.current.has(pair)) {
      tried.current.add(pair)
      // The next momento's audio opens once the current one has started,
      // is unavailable or has none; the service replaces a stale relay at the member cap.
      const handle = prepareMomentMusic({ member: own, origin: musicOrigin, request: node.request }, nextMusic, { stream: streamNext })
      ahead.current = { key: nextKey, handle, own, origin: musicOrigin, epoch: node.epoch, pair, stream: streamNext, upgraded: false }
      handle.done.then((result) => {
        if (!result.ok && result.code === 'limite-musica') musicQuota.current = true
      })
    } else if (ahead.current !== null && ahead.current.pair === pair && ahead.current.stream === false && !ahead.current.upgraded && streamNext) {
      // Opened as a ticket only while the current audio was still loading:
      // once it started, the next audio opens from that ticket, no new load.
      ahead.current.upgraded = true
      ahead.current.handle.upgrade()
    }
  }, [itemKey, nextKey, nextMusic?.id, nextMusic?.start, own, musicOrigin, node.epoch, node.request, musicOn, isTop, covered, node.visible, musicClosed, soundOff, photo.phase, musicSettled, streamNext])
  // The next track's item answer is fetched as soon as music may play, so
  // its ticket and audio start from a settled item later. It opens no ticket
  // or stream, so it waits for neither the photo nor the current audio.
  // { key, session, abort, done } of the last warm-up, and every warm-up
  // still in flight: a step can start one while the previous one runs.
  const warmedMusic = useRef(null)
  const warmingMusic = useRef(new Set())
  useEffect(() => {
    // The limite-musica latch stops the warm-up too: it is a request to the
    // service that would only be refused again.
    const allowed = musicOn === true && isTop && !covered && node.visible !== false && !musicClosed && !soundOff && !musicQuota.current
    const session = own + '|' + musicOrigin + '|' + node.epoch
    const live = warmingMusic.current
    // Closed, muted, covered or another session: every warm-up still in
    // flight stops, and may run again once music may play. A step alone
    // leaves them running: its item is now the one on screen, whose load
    // joins it.
    if (live.size > 0 && (!allowed || [...live].some((run) => run.session !== session))) {
      for (const run of live) run.abort.abort()
      live.clear()
      if (warmedMusic.current !== null && !warmedMusic.current.done) warmedMusic.current = null
    }
    if (!allowed || nextItem === null || nextMusic === null) return
    const warm = nextKey + '|' + session
    if (warmedMusic.current?.key === warm) return
    const run = { key: warm, session, abort: new AbortController(), done: false }
    warmedMusic.current = run
    live.add(run)
    const finish = () => {
      run.done = true
      live.delete(run)
    }
    Promise.resolve(warmMomentMusicItem({ member: own, origin: musicOrigin, request: node.request }, nextItem.music, { signal: run.abort.signal })).then(finish, finish)
  }, [nextKey, nextMusic?.id, nextMusic?.start, own, musicOrigin, node.epoch, node.request, musicOn, isTop, covered, node.visible, musicClosed, soundOff])
  useEffect(() => () => {
    ahead.current?.handle.release()
    handed.current?.handle.release()
    ahead.current = null
    handed.current = null
    for (const run of warmingMusic.current) run.abort.abort()
    warmingMusic.current.clear()
    warmedMusic.current = null
  }, [])

  // Marked seen as soon as it is on screen (synced where the node is hosted,
  // kept on this device otherwise).
  const { mark } = seenState
  // Only while the viewer is the top screen: under Responder's conversation
  // or a profile it is hidden, so nothing there counts as seen.
  useEffect(() => {
    if (itemKey !== '' && isTop && photo.phase !== 'loading') mark(itemKey)
  }, [itemKey, mark, isTop, photo.phase])

  // goBack pops the top screen: only the viewer on top may close itself, never
  // the conversation or profile opened from it.
  const isTopRef = useRef(isTop)
  isTopRef.current = isTop
  // Once: a swipe down's release and the click that follows its mouseup on
  // the web would otherwise go back twice and leave the page.
  // Latched only while a close is in flight: goBack is ignored during a stack
  // slide (an auto-advance close while a profile slides away), so the latch
  // frees when the viewer is the top screen again and, if it still is a
  // moment later, after the slide's time; it never stays latched on top.
  const closingRef = useRef(false)
  const closeTimer = useRef(null)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useEffect(() => {
    if (isTop) {
      closingRef.current = false
      setMusicClosed(false)
    }
  }, [isTop])
  // Swipe down closes; the photo follows the finger until then. dragging
  // holds playback while a drag runs (the pan cancels the press that holds).
  const drag = useRef(new Animated.Value(0)).current
  const [dragging, setDragging] = useState(false)
  const close = useCallback(() => {
    if (closingRef.current || !isTopRef.current || typeof onBack !== 'function') return
    closingRef.current = true
    setMusicClosed(true)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!isTopRef.current) return
      closingRef.current = false
      setMusicClosed(false)
      drag.setValue(0)
      setDragging(false)
    }, CLOSE_RELEASE_MS)
    onBack()
  }, [onBack, drag])
  // Set while a drag runs (cleared on the next press): the halves ignore the
  // press a drag ends with, so a swipe never also steps.
  const draggedRef = useRef(false)
  const swipeAxis = useRef(null)
  const swipeFrom = useRef({ dx: 0, dy: 0 })
  // A press that moved more than TAP_SLOP (a quick mouse drag on the web,
  // which no pan claimed) is not a tap: it never steps.
  const pressStartRef = useRef(null)
  const handleTapPressIn = (e) => {
    draggedRef.current = false
    pressStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }
    setHeld(true)
  }
  const movedSincePressIn = (e) => {
    const start = pressStartRef.current
    if (start === null || !Number.isFinite(start.x) || !Number.isFinite(start.y)) return false
    return Math.abs(e.nativeEvent.pageX - start.x) > TAP_SLOP || Math.abs(e.nativeEvent.pageY - start.y) > TAP_SLOP
  }

  // Holding pauses both the player and the segment's single clock.
  const [held, setHeld] = useState(false)
  const [linkHeld, setLinkHeld] = useState(false)
  const linkHidden = useRef(false)
  const openMusicLink = (url) => {
    linkHidden.current = false
    setLinkHeld(true)
    openExternal(url)
  }
  useEffect(() => {
    if (!linkHeld) return undefined
    if (node.visible === false) {
      linkHidden.current = true
      return undefined
    }
    if (node.visible === true && linkHidden.current) {
      setLinkHeld(false)
      return undefined
    }
    // A popup or a blocked open may never hide the viewer.
    const timer = setTimeout(() => setLinkHeld(false), LINK_HOLD_GRACE_MS)
    return () => clearTimeout(timer)
  }, [linkHeld, node.visible])
  const [captionExpanded, setCaptionExpanded] = useState(false)
  const captionScrollRef = useRef(null)
  useEffect(() => {
    if (!captionExpanded) {
      captionOffsetRef.current = 0
      if (captionScrollRef.current) captionScrollRef.current.scrollTo({ y: 0, animated: false })
    }
  }, [captionExpanded])
  // menuShown is the sheet; menuOpen holds playback from the menu's opening
  // until its action ran (ActionsSheet runs it up to 700 ms after closing) or
  // MENU_SETTLE_MS after a close without one, so 'Apagar' always finds the
  // viewer still on this item and its confirmation opens.
  const [menuShown, setMenuShown] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuTimer = useRef(null)
  // The item the menu opened on: 'Apagar' and its confirmation act on it even
  // if the viewer moved meanwhile.
  const menuTargetRef = useRef(null)
  useEffect(() => () => clearTimeout(menuTimer.current), [])
  const openMenu = () => {
    clearTimeout(menuTimer.current)
    menuTargetRef.current = item
    setMenuOpen(true)
    setMenuShown(true)
  }
  const closeMenu = () => {
    setMenuShown(false)
    clearTimeout(menuTimer.current)
    menuTimer.current = setTimeout(() => setMenuOpen(false), MENU_SETTLE_MS)
  }
  const [deleting, setDeleting] = useState(null)
  const restart = useRef(() => {})
  // Next / previous item; past the end of an author, the next author in
  // ringOrder from its first unseen item, and past the last author, close.
  const step = useCallback((dir) => {
    setCaptionExpanded(false)
    if (rings === null || pos.ring < 0) return
    const current = rings[pos.ring]
    const to = nextIndex(pos.item, current.items.length, dir)
    if (to !== null) return setPos({ ring: pos.ring, item: to })
    if (dir === 'next') {
      const r = pos.ring + 1
      if (r < rings.length) return setPos({ ring: r, item: rings[r].start })
      return close()
    }
    if (pos.ring > 0) {
      const r = pos.ring - 1
      return setPos({ ring: r, item: rings[r].items.length - 1 })
    }
    // Already at the very first item: play it from the start.
    setPos({ ring: pos.ring, item: 0 })
    restart.current()
  }, [rings, pos, close])
  const jump = useCallback((dir) => {
    setCaptionExpanded(false)
    if (rings === null || pos.ring < 0) return
    // No one before the first person: replay the moment on screen, wherever
    // the taps left it.
    if (dir === 'prev' && pos.ring === 0) return restart.current()
    const r = dir === 'next' ? pos.ring + 1 : pos.ring - 1
    if (r >= rings.length) return close()
    setPos({ ring: r, item: rings[r].start })
    tap('light')
  }, [rings, pos, close])
  const video = item !== null && item.media?.mime === 'video/mp4'
  const videoControl = useRef(null)
  const playback = useMomentPlayback({
    itemKey,
    ms: video ? segmentMs(item, photo.ms) : holdMsOf(item, musicStarted),
    video: video && photo.phase === 'ok',
    loaded: photo.phase !== 'loading',
    active: isTop && node.visible !== false && item !== null && !held && !dragging && !menuOpen && deleting === null && !helpOpen && !musicClosed && !linkHeld && !reacting && !musicWaiting && !captionExpanded,
    autoOn,
    step,
    control: videoControl
  })
  const { progress } = playback
  const silent = soundOff || playback.muted
  const toggleSound = () => {
    if (silent) {
      playback.handleUnmute()
      setSoundMuted(false)
    } else setSoundMuted(true)
  }
  restart.current = () => {
    setMusicState(null)
    playback.restart()
  }
  const paused = !isTop || node.visible === false || item === null || photo.phase === 'loading' || held || dragging || menuOpen || deleting !== null || musicClosed || helpOpen || linkHeld || reacting || captionExpanded
  const musicWaitRemaining = useRef(MUSIC_START_WAIT_MS)
  useEffect(() => { musicWaitRemaining.current = MUSIC_START_WAIT_MS }, [itemKey, playback.restartTick, node.epoch])
  useEffect(() => {
    if (!musicWaiting || paused) return undefined
    // Policy and audio share one budget, spent only while playback can run.
    const started = Date.now()
    const timer = setTimeout(() => setMusicState({ key: itemKey, phase: 'fallback', timer: true }), musicWaitRemaining.current)
    return () => {
      clearTimeout(timer)
      musicWaitRemaining.current = Math.max(0, musicWaitRemaining.current - (Date.now() - started))
    }
  }, [musicWaiting, paused, itemKey, playback.restartTick, node.epoch])

  useEffect(() => {
    setCaptionExpanded(false)
    // A new moment's caption starts at its top (the ScrollView is keyed too).
    setLinkHeld(false)
    captionOffsetRef.current = 0
    captionTouchRef.current = false
    // A caption tap that stepped unmounted its keyed Pressable before the
    // delayed press-out ran: never carry its hold into the new moment.
    setHeld(false)
  }, [itemKey])
  // A caption scrolled away from its top keeps a downward drag that starts
  // on it (it scrolls back); otherwise a drag down closes, as everywhere.
  const captionTouchRef = useRef(false)
  const captionOffsetRef = useRef(0)
  // Android: a scrolling caption's native ScrollView takes the vertical
  // gesture before the pan capture runs, so a drag down that starts with the
  // caption at its top and stays there closes from the touch itself.
  const captionStartRef = useRef(null)
  const captionPullTimer = useRef(null)
  useEffect(() => () => clearTimeout(captionPullTimer.current), [])
  // A sheet over the viewer (help, menu, delete) keeps its own touches.
  const overlayRef = useRef(false)
  overlayRef.current = helpOpen || menuOpen || deleting !== null
  // On the web a click still reaches a button where a mouse swipe began and
  // ended, right after the release and before any timer: the flag holds until
  // then, so the viewer's buttons skip that click, and clears for the next
  // press, a key press included.
  const settleDrag = () => setTimeout(() => { draggedRef.current = false }, 0)
  const pan = useMemo(() => PanResponder.create({
    // The axis is read here: the grant gets dx and dy reset to 0.
    onMoveShouldSetPanResponderCapture: (_e, g) => {
      if (overlayRef.current || (captionTouchRef.current && captionOffsetRef.current > 0)) return false
      const axis = momentSwipe(g)
      if (axis === null) return false
      swipeAxis.current = axis
      swipeFrom.current = { dx: g.dx, dy: g.dy }
      return true
    },
    onPanResponderGrant: () => {
      draggedRef.current = true
      captionStartRef.current = null
      clearTimeout(captionPullTimer.current)
      setDragging(true)
    },
    onPanResponderMove: (_e, g) => drag.setValue(swipeAxis.current === 'down' ? Math.max(0, g.dy) : 0),
    onPanResponderRelease: (_e, g) => {
      settleDrag()
      const action = swipeRelease(swipeAxis.current, swipeTotal(swipeFrom.current, g), CLOSE_DRAG)
      swipeAxis.current = null
      if (action === 'close') {
        close()
        return
      }
      drag.setValue(0)
      setDragging(false)
      if (action === 'next' || action === 'prev') jump(action)
    },
    onPanResponderTerminate: () => {
      settleDrag()
      swipeAxis.current = null
      drag.setValue(0)
      setDragging(false)
    }
  }), [drag, close, jump])

  const handleCaptionTouchStart = (e) => {
    captionTouchRef.current = true
    captionStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, atTop: captionOffsetRef.current <= 0 }
  }
  const handleCaptionTouchEnd = (e) => {
    captionTouchRef.current = false
    const start = captionStartRef.current
    captionStartRef.current = null
    if (start !== null && start.atTop && captionOffsetRef.current <= 0 && e.nativeEvent.pageY - start.y > CLOSE_DRAG && momentSwipe({ dx: e.nativeEvent.pageX - start.x, dy: e.nativeEvent.pageY - start.y }) === 'down') close()
  }
  const handleCaptionTouchMove = (e) => {
    const start = captionStartRef.current
    if (start !== null) {
      start.lastX = e.nativeEvent.pageX
      start.lastY = e.nativeEvent.pageY
    }
  }
  // Android: once the caption's native ScrollView claims the vertical drag,
  // JS gets a cancel instead of the end, after only the first few pixels of
  // movement. A drag that went down from the top (the caption cannot scroll
  // that way) is the swipe-down: it closes, once the caption shows it did
  // not scroll. A drag up scrolls the caption as usual.
  const handleCaptionTouchCancel = () => {
    captionTouchRef.current = false
    const start = captionStartRef.current
    captionStartRef.current = null
    if (start === null || !start.atTop || !Number.isFinite(start.lastY) || start.lastY - start.y <= CAPTION_PULL) return
    if (start.lastY - start.y <= Math.abs(start.lastX - start.x) * 1.5) return
    clearTimeout(captionPullTimer.current)
    captionPullTimer.current = setTimeout(() => { if (captionOffsetRef.current <= 0) close() }, CAPTION_PULL_SETTLE_MS)
  }
  // The header block's bottom and the bottom block's top (see scrimsMeet).
  const [topEnd, setTopEnd] = useState(NaN)
  // The bottom block is pinned to the bottom: its top is the frame's height
  // minus its own height. Both sizes fire onLayout on every resize, while
  // its y alone does not on the web when only the window height changes.
  const [frameHeight, setFrameHeight] = useState(NaN)
  const [bottomHeight, setBottomHeight] = useState(NaN)
  const bottomStart = frameHeight - bottomHeight
  const [barHeight, setBarHeight] = useState(0)
  const [playbackHeight, setPlaybackHeight] = useState(0)
  const showPlay = playback.blocked || (reduce === true && !playback.started && !playback.ended)
  const playbackControls = video && photo.phase === 'ok' && (playback.muted || showPlay || (reduce === true && playback.ended))
  const measureBar = (e) => setBarHeight(e.nativeEvent.layout.height)
  // The caption box: scrolls only when its text overflows the cap.
  const captionMax = captionCap({ height: win.height, topEnd, barHeight: barHeight + (playbackControls ? playbackHeight + 12 : 0), bottomPad: insets.bottom + 12 })
  const [captionHeight, setCaptionHeight] = useState(0)
  const { collapsedHeight: captionCollapsedHeight, expandedHeight: captionExpandedHeight, long: captionLong } = captionLayout({ max: captionMax, fontScale: win.fontScale, lineHeight: type.postText.lineHeight, hit: layout.hit, height: captionHeight })
  const captionScrolls = captionHeight > captionMax - (captionLong ? layout.hit : 0) && (!captionLong || captionExpanded)
  const meet = scrimsMeet(topEnd, bottomStart)

  const profile = author !== null && names ? names.profileOf(author) : null
  const name = mine ? 'Você' : displayText(whoOf(profile || {}).title)
  const time = item ? relativeTime(item.at, now) : null

  const reply = !mine && !pageOwn && canReply(node) && typeof onMessage === 'function' && item !== null
    ? () => onMessage(author, { context: replyContext(item, author) })
    : null
  const openProfile = author !== null && typeof onOpenMember === 'function'
    ? () => onOpenMember(author, profile ? { name: profile.name, username: profile.username } : undefined)
    : undefined

  // Items leave (a delete, the 24-hour end): see pruneRings. The store
  // releases the photo of a removed item once the viewer's list drops it.
  const prune = useCallback((keep) => {
    if (rings === null) return
    const r = pruneRings(rings, pos, keep)
    if (r === null) return
    if (r.close) return close()
    setRings(r.rings)
    setPos(r.pos)
  }, [rings, pos, close])
  const removed = useCallback((target) => {
    if (!target) return
    if (rings !== null && closesAfterDelete(rings[pos.ring], own, target)) return close()
    prune((it) => it.ref !== target.ref)
  }, [prune, rings, pos, own, close])
  // Every clock tick drops what passed its 24 hours, the shown item too
  // (reduced motion or a held press would otherwise keep it on screen), and
  // every new answer from the node drops what it no longer lists (a delete
  // whose answer was lost). The item under an open menu or delete sheet stays
  // until they close, so the viewer never moves under them.
  const hold = deleting !== null ? deleting.ref : menuOpen ? itemKey : null
  const listed = useMemo(() => listedRefs({ phase: data.phase, authors: data.authors, own: data.own }), [data.phase, data.authors, data.own])
  useEffect(() => {
    // Closing: the viewer stays as it is while it slides away (deleting your
    // only moment must not show the next person's name for a moment).
    if (rings === null || closingRef.current) return
    const keep = (it) => it.ref === hold || (expiresIn(it.at, now) > 0 && (listed === null || listed.has(it.ref)))
    if (rings.some((r) => r.items.some((it) => !keep(it)))) prune(keep)
  }, [now, rings, prune, hold, listed])

  const closeButton = <IconAction icon='fechar' label='fechar momentos' color={colors.onMedia} onPress={close} />

  if (node.hosted !== true || data.phase === 'off') {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.headRow}>{closeButton}</View>
        <View style={styles.center}><Soft>{OFF_TEXT}</Soft></View>
      </View>
    )
  }
  if (rings === null) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.headRow}><View style={styles.flex} />{closeButton}</View>
        <View style={styles.center}>
          {data.phase === 'error' ? <ErrorText>{data.error}</ErrorText> : <ActivityIndicator color={colors.ink} />}
        </View>
      </View>
    )
  }
  if (item === null) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.headRow}><View style={styles.flex} />{closeButton}</View>
        <View style={styles.center}><Soft>{NONE_TEXT}</Soft></View>
      </View>
    )
  }

  const segments = progressOf(pos.item, ring.items.length)
  const fill = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
  const text = item.text !== '' ? displayText(item.text, { multiline: true }) : ''
  const menuActions = mine || pageOwn
    ? [{
        icon: 'lixeira',
        label: 'Apagar',
        danger: true,
        onPress: () => {
          clearTimeout(menuTimer.current)
          setDeleting(menuTargetRef.current || item)
          setMenuOpen(false)
        }
      }]
    : []

  const frameCaption = (content) => content === null
    ? null
    : (
      <>
        <View style={{ maxHeight: captionExpanded ? captionExpandedHeight : captionCollapsedHeight, overflow: 'hidden' }}>{content}</View>
        {captionLong
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={captionExpanded ? 'recolher a legenda' : 'mostrar a legenda inteira'}
              accessibilityState={{ expanded: captionExpanded }}
              onPress={() => setCaptionExpanded((value) => !value)}
              style={({ pressed }) => [styles.captionToggle, pressed && styles.pressed]}
            >
              <Text style={styles.text}>{captionExpanded ? 'menos' : 'mais'}</Text>
            </Pressable>
            )
          : null}
      </>
      )

  return (
    // key: a fresh element, so react-native-web observes its size (the root
    // of the loading branch above had no onLayout, and the browser only
    // starts observing an element that had one when it mounted).
    <View key='stage' style={styles.root} onLayout={(e) => setFrameHeight(e.nativeEvent.layout.height)}>
      <Animated.View style={[styles.flex, { transform: [{ translateY: drag }] }]} {...pan.panHandlers}>
        <View style={styles.stage}>
          {/* The next photo, already read, decodes at display size out of
              sight, so a step shows it without a blank frame. Never a video:
              a hidden player would hold a decoder. */}
          {warmUri !== null
            ? (
              <View style={[styles.photo, styles.warm]} pointerEvents='none' accessible={false} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
                <Image key={warmUri} source={{ uri: warmUri }} style={styles.photo} resizeMode='contain' accessible={false} />
              </View>
              )
            : null}
          {photo.phase === 'ok'
            ? video
              ? (
                <View style={styles.photo} accessible accessibilityLabel={'momento de ' + name}>
                  <VideoPlayer key={itemKey + ':' + playback.restartTick + ':' + photo.uri} uri={photo.uri} playing={playback.playing} muted={playback.muted || soundOff} controls={false} fit='contain' style={styles.photo} onReady={playback.handleReady} onProgress={playback.handleProgress} onEnd={playback.handleEnd} onError={handlePhotoError} onSoundRefused={playback.handleSoundRefused} onPlayBlocked={playback.handlePlayBlocked} control={videoControl} />
                </View>
                )
              : <Image key={photo.uri} source={{ uri: photo.uri }} style={styles.photo} resizeMode='contain' onError={handlePhotoError} accessibilityIgnoresInvertColors accessible accessibilityRole='image' accessibilityLabel={'momento de ' + name} />
            : photo.phase === 'loading'
              ? <View style={styles.center}><ActivityIndicator color={colors.ink} accessibilityLabel={video ? 'carregando o vídeo' : 'carregando a foto'} /></View>
              : (
                <View style={styles.center}>
                  <Icon name='imagem' size={28} color={colors.soft} />
                  <Text style={styles.unavailable}>{video ? VIDEO_UNAVAILABLE : PHOTO_UNAVAILABLE}</Text>
                </View>
                )}
        </View>
        {/* Left half back, right half forward; holding pauses without moving. */}
        <View style={styles.taps}>
          <Pressable
            style={styles.half}
            accessibilityRole='button'
            accessibilityLabel='momento anterior'
            onPress={(e) => { if (!draggedRef.current && !movedSincePressIn(e)) step('prev') }}
            onLongPress={() => {}}
            delayLongPress={250}
            delayPressIn={0}
            onPressIn={handleTapPressIn}
            onPressOut={() => setHeld(false)}
          />
          <Pressable
            style={styles.half}
            accessibilityRole='button'
            accessibilityLabel='próximo momento'
            onPress={(e) => { if (!draggedRef.current && !movedSincePressIn(e)) step('next') }}
            onLongPress={() => {}}
            delayLongPress={250}
            delayPressIn={0}
            onPressIn={handleTapPressIn}
            onPressOut={() => setHeld(false)}
          />
        </View>
        {meet ? <View style={[styles.fullScrim, { backgroundColor: scrimColor(BOTTOM_SCRIM.alpha) }]} pointerEvents='none' /> : null}
        <View style={[styles.top, { paddingTop: insets.top + 12 }]} pointerEvents='box-none' onLayout={(e) => setTopEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
          {meet ? null : <Scrim edge='top' alpha={TOP_SCRIM.alpha} fade={TOP_SCRIM.fade} style={styles.topScrim} />}
          <View style={styles.segments} accessible accessibilityLabel={'momento ' + (pos.item + 1) + ' de ' + ring.items.length}>
            {segments.map((done, n) => (
              <View key={n} style={styles.segment}>
                {n === pos.item
                  ? <Animated.View style={[styles.segmentFill, { width: autoOn || (video && photo.phase === 'ok') ? fill : '100%' }]} />
                  : <View style={[styles.segmentFill, { width: done === 1 ? '100%' : '0%' }]} />}
              </View>
            ))}
          </View>
          <View style={styles.headRow}>
            <Pressable
              accessibilityRole='link'
              accessibilityLabel={mine ? 'seu perfil' : 'ver o perfil de ' + name}
              delayPressIn={0}
              onPressIn={(e) => { pressStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } }}
              onPress={(e) => { if (!movedSincePressIn(e)) openProfile() }}
              style={({ pressed }) => [styles.who, pressed && styles.pressed]}
            >
              <Avatar name={profile ? (profile.name || profile.username || null) : null} publicKey={author} size={32} picture={profile ? profile.avatar : undefined} persist />
              <View style={styles.whoText}>
                <Text style={styles.name} numberOfLines={1} selectable={false}>{name}</Text>
                {time ? <Text style={styles.time} numberOfLines={1} selectable={false}>{time}</Text> : null}
              </View>
            </Pressable>
            {video || musicOn === true
              ? <IconAction icon={silent ? 'mudo' : 'som'} label={silent ? SOUND_UNMUTE_LABEL : SOUND_MUTE_LABEL} color={colors.onMedia} onPress={toggleSound} />
              : null}
            {mine || pageOwn
              ? (
                <>
                  <IconAction icon='mais' label='mais ações' color={colors.onMedia} onPress={openMenu} />
                  <ActionsSheet open={menuShown} onClose={closeMenu} actions={menuActions} />
                </>
                )
              : null}
            {closeButton}
          </View>
        </View>
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]} pointerEvents='box-none' onLayout={(e) => setBottomHeight(e.nativeEvent.layout.height)}>
          {meet ? null : <Scrim edge='bottom' alpha={BOTTOM_SCRIM.alpha} fade={BOTTOM_SCRIM.fade} style={styles.bottomScrim} />}
          {musicOn && music !== null
            ? (
              <MomentMusic
                key={itemKey + ':' + playback.restartTick}
                music={music}
                prepared={prepared}
                member={own}
                origin={musicOrigin}
                request={node.request}
                paused={paused}
                onStart={() => setMusicState({ key: itemKey, phase: 'playing' })}
                onUnavailable={() => setMusicState({ key: itemKey, phase: 'fallback' })}
                onOpenExternal={openMusicLink}
              />
              )
            : null}
          {playbackControls
            ? (
              <View style={styles.bar} onLayout={(e) => setPlaybackHeight(e.nativeEvent.layout.height)}>
                {showPlay ? <Pill label='Reproduzir' onPress={playback.handlePlay} /> : null}
                {!autoOn && playback.ended ? <Pill label='Próximo momento' onPress={() => step('next')} /> : null}
                {playback.muted ? <Pill label='Ativar som' onPress={toggleSound} /> : null}
              </View>
              )
            : null}
          {frameCaption(text !== ''
            ? (
              <ScrollView
                key={itemKey}
                ref={captionScrollRef}
                style={[styles.caption, { maxHeight: captionMax }]}
                scrollEnabled={captionScrolls}
                showsVerticalScrollIndicator={captionScrolls}
                scrollEventThrottle={16}
                onScroll={(e) => { captionOffsetRef.current = e.nativeEvent.contentOffset.y }}
                onContentSizeChange={(_w, h) => setCaptionHeight(h)}
                onTouchStart={handleCaptionTouchStart}
                onTouchEnd={handleCaptionTouchEnd}
                onTouchMove={handleCaptionTouchMove}
                onTouchCancel={handleCaptionTouchCancel}
              >
                {/* The caption is a tap zone too: left half previous, right half
                    next, a hold pauses, as the halves behind it (a scroll or a
                    drag cancels the press). Not selectable: a mouse drag must
                    close or scroll, never select. */}
                <Pressable
                  accessible={false}
                  onPress={(e) => { if (!draggedRef.current && !movedSincePressIn(e)) step(e.nativeEvent.pageX < win.width / 2 ? 'prev' : 'next') }}
                  onLongPress={() => {}}
                  delayLongPress={250}
                  delayPressIn={0}
                  onPressIn={handleTapPressIn}
                  onPressOut={() => setHeld(false)}
                >
                  <Text style={styles.text} selectable={false}>{text}</Text>
                </Pressable>
              </ScrollView>
              )
            : null)}
          {mine
            ? (
              <View style={styles.bar} onLayout={measureBar}>
                <HelpButton doc={{ title: 'Sobre seus momentos', paragraphs: [OWN_NOTE] }} color='rgba(255,255,255,0.8)' style={{ margin: 0 }} />
                {typeof onCreate === 'function' ? <Pill label='Novo momento' icon='plus' onPress={() => { if (!draggedRef.current) onCreate() }} /> : null}
              </View>
              )
            : reply !== null
              ? (
                <View style={styles.bar} onLayout={measureBar}>
                  {reactionVisible
                    ? (
                      <View style={styles.reactionBlock} onStartShouldSetResponder={() => true}>
                        {reaction?.uncertain || !reactionAvailable
                          ? null
                          : (
                            <View style={styles.reactionRow}>
                              {QUICK.map((emoji) => (
                                <Pressable
                                  key={emoji}
                                  accessibilityRole='button'
                                  accessibilityLabel={'Reagir com ' + reactionName(emoji)}
                                  accessibilityState={{ disabled: reacting }}
                                  disabled={reacting}
                                  onPress={(e) => { e.stopPropagation(); if (!draggedRef.current) return react(emoji) }}
                                  style={({ pressed }) => [styles.reactionHit, pressed && styles.pressed]}
                                >
                                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                                </Pressable>
                              ))}
                            </View>
                            )}
                        {reaction ? <Text style={styles.reactionNote} accessibilityLiveRegion='polite'>{reaction.text}</Text> : null}
                        {reaction?.uncertain && typeof reaction.retry === 'function'
                          ? (
                            <Pressable
                              accessibilityRole='button'
                              accessibilityLabel='Tentar de novo'
                              accessibilityState={{ disabled: reacting }}
                              disabled={reacting}
                              onPress={(e) => { e.stopPropagation(); if (!draggedRef.current) return react('', reaction.retry) }}
                              style={({ pressed }) => [styles.reactionHit, pressed && styles.pressed]}
                            >
                              <Text style={styles.text}>Tentar de novo</Text>
                            </Pressable>
                            )
                          : null}
                        {reaction?.uncertain && typeof onMessage === 'function'
                          ? (
                            <Pressable
                              accessibilityRole='button'
                              accessibilityLabel='Ver conversa'
                              onPress={(e) => { e.stopPropagation(); if (!draggedRef.current) onMessage(author) }}
                              style={({ pressed }) => [styles.reactionHit, pressed && styles.pressed]}
                            >
                              <Text style={styles.text}>Ver conversa</Text>
                            </Pressable>
                            )
                          : null}
                      </View>
                      )
                    : null}
                  <Pill label='Responder' icon='mensagem' onPress={() => { if (!draggedRef.current) reply() }} />
                </View>
                )
              : null}
        </View>
      </Animated.View>
      <ConfirmMomentDelete open={deleting !== null} target={deleting} page={pageOwn ? actingPage : null} onClose={() => setDeleting(null)} onDeleted={removed} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mediaBg },
  flex: { flex: 1 },
  stage: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.mediaBg },
  photo: { ...StyleSheet.absoluteFillObject },
  warm: { opacity: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 },
  unavailable: { ...type.postName, color: colors.onMedia },
  taps: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  half: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: space.xl, paddingVertical: 12, gap: 12 },
  // Solid down to the bottom of the header row, then the fade past it.
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -TOP_SCRIM.fade },
  segments: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1, height: 2, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.4)', overflow: 'hidden' },
  segmentFill: { height: 2, backgroundColor: colors.onMedia },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 },
  who: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8 },
  whoText: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.onMedia, ...TEXT_SHADOW },
  time: { ...type.postMeta, color: 'rgba(255,255,255,0.8)', ...TEXT_SHADOW },
  pressed: { opacity: 0.6 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  bottomScrim: { position: 'absolute', top: -BOTTOM_SCRIM.fade, left: 0, right: 0, bottom: 0 },
  fullScrim: { ...StyleSheet.absoluteFillObject },
  caption: { flexGrow: 0 },
  captionToggle: { minHeight: layout.hit, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: space.sm },
  text: { ...type.postText, color: colors.onMedia, ...TEXT_SHADOW },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  reactionBlock: { width: '100%', gap: space.xs },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between' },
  reactionHit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' },
  reactionEmoji: { fontSize: 24, color: colors.onMedia },
  reactionNote: { ...type.postMeta, color: colors.onMedia, ...TEXT_SHADOW },
  sheetBody: { gap: 12, paddingHorizontal: 16, paddingBottom: 16 },
  pageSection: { gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  pageTitle: { ...type.postName, color: colors.ink, paddingHorizontal: 16, minHeight: 44, textAlignVertical: 'center' },
  pageRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8, paddingVertical: 6 },
  pageText: { flex: 1, minWidth: 0 },
  pageMeta: { ...type.postMeta, color: colors.soft },
  pageExcerpt: { ...type.postText, color: colors.ink }
})
