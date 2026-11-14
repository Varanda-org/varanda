// Momentos (docs/rpc.md 5.113): the full-screen viewer, pushed above the tabs
// (App.js stack entry { screen: 'momentos', key: author }). It starts at that
// author's ring and plays the rings in ringOrder (own first, then unseen,
// then seen), each author's items oldest first, starting at the first one
// not yet seen on this device. Black in both themes: the subtree reads the
// dark palette, so every control and sheet in it is drawn for black.
//
// The photo comes only from the node (node.media.read kind 'moment'): a blob
// the node fetched from the seeder and decrypted with the record's public
// key. A gone blob (expired, deleted, never reached the seeder) reads 'Foto
// indisponível', never an error banner. The text is the author's, so it goes
// through displayText.
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
// confirmation; an uncertain answer says so and the action is not offered
// again on that sheet) and 'Novo momento'. Each item shown is marked seen on
// this device only (src/momentSeen.js: no record, nobody told).
//
// Also exported for A Rua and Diário: useMoments (moments.read on a hosted
// node), useMomentSeen, momentsChanged and the delete confirmation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Easing, AccessibilityInfo, Image, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { holdMsOf, momentMusicOf, canReply, expiresIn, firstUnseenIndex, nextIndex, nextMomentOf, progressOf, replyContext, ringOrder, segmentMs, VIDEO_END_GRACE_MS } from '../moments'
import { canReact, reactionParams, unsure, REACTION_SENT, REACTION_UNSURE } from '../momentReaction'
import { QUICK, reactionName } from '../reactions'
import { audiusPolicy, audiusReady } from '../account'
import { musicOriginOf } from '../music'
import { soundMuted, setSoundMuted, onSoundMute, SOUND_MUTE_LABEL, SOUND_UNMUTE_LABEL } from '../soundMute'
import { openExternal } from '../openExternal'
import { MomentMusic, prepareMomentMusic } from '../ui/MomentMusic'
import { liveAuthors, liveItems, momentsOf } from '../momentSeen'
import { loadMomentSeen, markMomentSeen, onMomentSeen } from '../momentSeenStore'
import { adoptVideoFile, revokeUrl, urlFromBytes } from '../media/display'
import VideoPlayer from '../media/VideoPlayer'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { ConfirmStack, ErrorText, Soft, UNCERTAIN, errorText, useNow } from '../ui'
import { ActionsSheet } from '../ui/ActionsSheet'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { Scrim, scrimColor } from '../ui/Scrim'
import { Sheet } from '../ui/Sheet'
import { IconAction } from '../ui/TopActions'
import { layout, space, type } from '../ui/theme'
import { ThemeContext, useStyles, useTheme } from '../ui/ThemeProvider'
import { paletteFor } from '../appearance.js'
import { STACK_MS } from '../stackMotion'

export const PHOTO_UNAVAILABLE = 'Foto indisponível'
export const VIDEO_UNAVAILABLE = 'vídeo indisponível'
export const OWN_NOTE = 'O momento sai dos servidores em até 7 dias.'
export const DELETE_TITLE = 'Apagar momento?'
export const DELETE_BODY = 'O momento deixa de aparecer para quem segue você. Cópias que outras pessoas fizeram não voltam.'
// A moment past its 24 hours is already shown to nobody.
export const DELETE_BODY_PAST = 'O momento sai do seu diário. Já não aparece para ninguém.'
export const NONE_TEXT = 'Nenhum momento agora.'
const OFF_TEXT = 'Momentos disponíveis no app hospedado.'
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
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

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

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
export function useMoments ({ ownKey = null, active = true, tick = 0 } = {}) {
  const node = useNode()
  const { request } = node
  const hosted = node.hosted === true
  const changed = useMomentsChanged()
  const [state, setState] = useState({ phase: 'idle', authors: [], own: [], past: [], error: null })
  const runRef = useRef(0)
  const enabled = hosted && active !== false
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const load = useCallback(async () => {
    if (!enabled) return
    const run = ++runRef.current
    try {
      const answer = await request('moments.read', {})
      if (run !== runRef.current) return
      setState({ phase: 'ready', ...momentsOf(answer, own), error: null })
    } catch (err) {
      if (run === runRef.current) setState((s) => ({ ...s, phase: s.phase === 'ready' ? 'ready' : 'error', error: errorText(err) }))
    }
  }, [enabled, request, own])
  useEffect(() => { load() }, [load, tick, changed, node.epoch])
  useEffect(() => () => { runRef.current++ }, [])
  return { ...state, enabled: hosted, phase: hosted ? state.phase : 'off', reload: load }
}

// The refs seen on this device, kept current across screens.
export function useMomentSeen () {
  const [seen, setSeen] = useState(null)
  useEffect(() => {
    let live = true
    loadMomentSeen().then((list) => { if (live) setSeen(list) }, () => { if (live) setSeen([]) })
    const off = onMomentSeen((list) => { if (live) setSeen(list) })
    return () => { live = false; off() }
  }, [])
  return { loaded: seen !== null, seen: seen || [], mark: markMomentSeen }
}

// Confirmation before moment.delete (ConfirmStack). An uncertain answer says
// so and takes the confirm button away: the person checks before trying.
export function ConfirmMomentDelete ({ open, target, onClose, onDeleted }) {
  const styles = useStyles(makeStyles)
  const { request } = useNode()
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
      await request('moment.delete', { to: target.ref })
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
        <Soft>{target && expiresIn(target.at) === 0 ? DELETE_BODY_PAST : DELETE_BODY}</Soft>
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

function wipe (bytes) {
  try { if (bytes instanceof Uint8Array) bytes.fill(0) } catch {}
}

// The media of author:seq -> { phase: 'loading' | 'ok' | 'off', uri }. The
// URL is released when the item changes or the viewer closes.
function useMomentPhoto (author, seq, expected) {
  const node = useNode()
  const media = node.media && typeof node.media.read === 'function' ? node.media : null
  const mime = expected?.mime
  const ms = expected?.ms
  const key = author + ':' + seq
  const [state, setState] = useState({ key: null, phase: 'loading', uri: null })
  useEffect(() => {
    if (media === null || typeof author !== 'string' || !Number.isSafeInteger(seq)) {
      setState({ key, phase: 'off', uri: null })
      return undefined
    }
    let alive = true
    let release = null
    setState({ key, phase: 'loading', uri: null })
    media.read({ kind: 'moment', author, seq }).then((got) => {
      const forget = () => {
        if (!isObject(got) || typeof got.uri !== 'string') return
        const name = got.uri.slice(got.uri.lastIndexOf('/') + 1)
        try { if (typeof media.forgetReadFile === 'function') media.forgetReadFile(name) } catch {}
      }
      const video = isObject(got) && got.mime === 'video/mp4'
      const valid = isObject(got) && got.mime === mime && (video
        ? got.ms === ms && [got.w, got.h, got.ms].every((n) => Number.isSafeInteger(n) && n > 0)
        : IMAGE_MIMES.includes(got.mime))
      if (!alive || !valid) {
        forget()
        if (isObject(got)) wipe(got.bytes)
        if (alive) setState({ key, phase: 'off', uri: null })
        return
      }
      let uri = null
      try {
        if (got.bytes instanceof Uint8Array) {
          uri = urlFromBytes(got.bytes, got.mime)
          forget()
        } else if (typeof got.uri === 'string' && got.uri.startsWith('file://')) {
          if (video) {
            uri = adoptVideoFile(got.uri)
            forget()
          } else {
            uri = got.uri
            release = forget
          }
        } else {
          forget()
        }
      } catch {
        forget()
      } finally {
        wipe(got.bytes)
      }
      if (typeof uri === 'string' && uri !== '' && release === null) {
        const shown = uri
        release = () => revokeUrl(shown)
      }
      if (!alive) {
        if (release) release()
        release = null
        return
      }
      setState({ key, phase: typeof uri === 'string' && uri !== '' ? 'ok' : 'off', uri, ms: got.ms })
    }, () => {
      // NOT_FOUND 'foto indisponível': the blob is gone or the moment ended.
      if (alive) setState({ key, phase: 'off', uri: null })
    })
    return () => {
      alive = false
      if (release) release()
      release = null
    }
  }, [key, author, seq, media, mime, ms])
  // Bytes that pass every check but do not decode: 'Foto indisponível', not a
  // blank moment (the Image's onError).
  const fail = useCallback(() => setState((s) => (s.key === key ? { key, phase: 'off', uri: null } : s)), [key])
  const shown = state.key === key ? state : { key, phase: 'loading', uri: null }
  return { ...shown, fail }
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
  const photo = useMomentPhoto(author, item ? item.seq : null, item?.media)
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
  const reactionAvailable = !mine && canReact(node) && item !== null
  const reactionVisible = !mine && item !== null
  const reaction = reactionStates[itemKey]
  const react = async (emoji) => {
    if (!mounted.current || reactionBusy.current || !reactionAvailable || reactionUncertain.current.has(item.ref)) return
    const ref = item.ref
    reactionBusy.current = true
    setReacting(true)
    setReactionStates((states) => ({ ...states, [ref]: null }))
    try {
      await request('dm.send', reactionParams(item, author, emoji))
      if (mounted.current) setReactionStates((states) => ({ ...states, [ref]: { text: REACTION_SENT } }))
    } catch (err) {
      const uncertain = unsure(err)
      if (uncertain) reactionUncertain.current.add(ref)
      if (mounted.current) setReactionStates((states) => ({ ...states, [ref]: { uncertain, text: uncertain ? REACTION_UNSURE : errorText(err) } }))
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
  const preloadStream = music === null
  const musicSettled = preloadStream || musicStarted || (musicState?.key === itemKey && musicState.phase === 'fallback')
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
      // A playing snippet can occupy both relays while seeking; only POSTs
      // for the next track and ticket may overlap it.
      const handle = prepareMomentMusic({ member: own, origin: musicOrigin, request: node.request }, nextMusic, { stream: preloadStream })
      ahead.current = { key: nextKey, handle, own, origin: musicOrigin, epoch: node.epoch }
      handle.done.then((result) => {
        if (!result.ok && result.code === 'limite-musica') musicQuota.current = true
      })
    }
  }, [itemKey, nextKey, nextMusic?.id, nextMusic?.start, own, musicOrigin, node.epoch, node.request, musicOn, isTop, covered, node.visible, musicClosed, soundOff, photo.phase, musicSettled, preloadStream])
  useEffect(() => () => {
    ahead.current?.handle.release()
    handed.current?.handle.release()
    ahead.current = null
    handed.current = null
  }, [])

  // Seen on this device as soon as it is on screen.
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
  const video = item !== null && item.media?.mime === 'video/mp4'
  const videoControl = useRef(null)
  const playback = useMomentPlayback({
    itemKey,
    ms: video ? segmentMs(item, photo.ms) : holdMsOf(item, musicStarted),
    video: video && photo.phase === 'ok',
    loaded: photo.phase !== 'loading',
    active: isTop && node.visible !== false && item !== null && !held && !dragging && !menuOpen && deleting === null && !musicClosed && !linkHeld && !reacting && !musicWaiting && !captionExpanded,
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
  const paused = !isTop || node.visible === false || item === null || photo.phase === 'loading' || held || dragging || menuOpen || deleting !== null || musicClosed || linkHeld || reacting || captionExpanded
  const musicWaitRemaining = useRef(MUSIC_START_WAIT_MS)
  useEffect(() => { musicWaitRemaining.current = MUSIC_START_WAIT_MS }, [itemKey, playback.restartTick, node.epoch])
  useEffect(() => {
    if (!musicWaiting || paused) return undefined
    // Policy and audio share one budget, spent only while playback can run.
    const started = Date.now()
    const timer = setTimeout(() => setMusicState({ key: itemKey, phase: 'fallback' }), musicWaitRemaining.current)
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
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_e, g) => g.dy > 12 && g.dy > Math.abs(g.dx) * 1.5 && !(captionTouchRef.current && captionOffsetRef.current > 0),
    onPanResponderGrant: () => {
      draggedRef.current = true
      setDragging(true)
    },
    onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > CLOSE_DRAG || g.vy > 0.8) {
        close()
        return
      }
      drag.setValue(0)
      setDragging(false)
    },
    onPanResponderTerminate: () => {
      drag.setValue(0)
      setDragging(false)
    }
  }), [drag, close])

  const handleCaptionTouchStart = (e) => {
    captionTouchRef.current = true
    captionStartRef.current = { y: e.nativeEvent.pageY, atTop: captionOffsetRef.current <= 0 }
  }
  const handleCaptionTouchEnd = (e) => {
    captionTouchRef.current = false
    const start = captionStartRef.current
    captionStartRef.current = null
    if (start !== null && start.atTop && captionOffsetRef.current <= 0 && e.nativeEvent.pageY - start.y > CLOSE_DRAG) close()
  }
  const handleCaptionTouchMove = (e) => {
    const start = captionStartRef.current
    if (start !== null) start.lastY = e.nativeEvent.pageY
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

  const reply = !mine && canReply(node) && typeof onMessage === 'function' && item !== null
    ? () => onMessage(author, { context: replyContext(item, author) })
    : null
  const openProfile = author !== null && typeof onOpenMember === 'function'
    ? () => onOpenMember(author, profile ? { name: profile.name, username: profile.username } : undefined)
    : undefined

  // Items leave (a delete, the 24-hour end): see pruneRings. The photo of a
  // removed item is released when the shown item changes.
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

  const closeButton = <IconAction icon='fechar' label='fechar momentos' color='#ffffff' onPress={close} />

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
  const menuActions = mine
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
          {photo.phase === 'ok'
            ? video
              ? (
                <View style={styles.photo} accessible accessibilityLabel={'momento de ' + name}>
                  <VideoPlayer key={itemKey + ':' + playback.restartTick} uri={photo.uri} playing={playback.playing} muted={playback.muted || soundOff} controls={false} fit='contain' style={styles.photo} onReady={playback.handleReady} onProgress={playback.handleProgress} onEnd={playback.handleEnd} onError={handlePhotoError} onSoundRefused={playback.handleSoundRefused} onPlayBlocked={playback.handlePlayBlocked} control={videoControl} />
                </View>
                )
              : <Image source={{ uri: photo.uri }} style={styles.photo} resizeMode='contain' onError={handlePhotoError} accessibilityIgnoresInvertColors accessible accessibilityRole='image' accessibilityLabel={'momento de ' + name} />
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
        <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents='box-none' onLayout={(e) => setTopEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
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
              ? <IconAction icon={silent ? 'mudo' : 'som'} label={silent ? SOUND_UNMUTE_LABEL : SOUND_MUTE_LABEL} color='#ffffff' onPress={toggleSound} />
              : null}
            {mine
              ? (
                <>
                  <IconAction icon='mais' label='mais ações' color='#ffffff' onPress={openMenu} />
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
                <Soft style={styles.note}>{OWN_NOTE}</Soft>
                {typeof onCreate === 'function' ? <Pill label='Novo momento' icon='plus' onPress={onCreate} /> : null}
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
                                  onPress={(e) => { e.stopPropagation(); return react(emoji) }}
                                  style={({ pressed }) => [styles.reactionHit, pressed && styles.pressed]}
                                >
                                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                                </Pressable>
                              ))}
                            </View>
                            )}
                        {reaction ? <Text style={styles.reactionNote} accessibilityLiveRegion='polite'>{reaction.text}</Text> : null}
                        {reaction?.uncertain && typeof onMessage === 'function'
                          ? (
                            <Pressable
                              accessibilityRole='button'
                              accessibilityLabel='Ver conversa'
                              onPress={(e) => { e.stopPropagation(); onMessage(author) }}
                              style={({ pressed }) => [styles.reactionHit, pressed && styles.pressed]}
                            >
                              <Text style={styles.text}>Ver conversa</Text>
                            </Pressable>
                            )
                          : null}
                      </View>
                      )
                    : null}
                  <Pill label='Responder' icon='mensagem' onPress={reply} />
                </View>
                )
              : null}
        </View>
      </Animated.View>
      <ConfirmMomentDelete open={deleting !== null} target={deleting} onClose={() => setDeleting(null)} onDeleted={removed} />
    </View>
  )
}

// Literal black and white: the viewer is black in both themes.
const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  flex: { flex: 1 },
  stage: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' },
  photo: { ...StyleSheet.absoluteFillObject },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 },
  unavailable: { ...type.postName, color: '#ffffff' },
  taps: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  half: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 8, gap: 4 },
  // Solid down to the bottom of the header row, then the fade past it.
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -TOP_SCRIM.fade },
  segments: { flexDirection: 'row', gap: 4, paddingHorizontal: 8 },
  segment: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
  segmentFill: { height: 3, backgroundColor: '#ffffff' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 },
  who: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8 },
  whoText: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: '#ffffff', ...TEXT_SHADOW },
  time: { ...type.postMeta, color: 'rgba(255,255,255,0.8)', ...TEXT_SHADOW },
  pressed: { opacity: 0.6 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  bottomScrim: { position: 'absolute', top: -BOTTOM_SCRIM.fade, left: 0, right: 0, bottom: 0 },
  fullScrim: { ...StyleSheet.absoluteFillObject },
  caption: { flexGrow: 0 },
  captionToggle: { minHeight: layout.hit, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: space.sm },
  text: { ...type.postText, color: '#ffffff', ...TEXT_SHADOW },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  reactionBlock: { width: '100%', gap: space.xs },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between' },
  reactionHit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' },
  reactionEmoji: { fontSize: 24, color: '#ffffff' },
  reactionNote: { ...type.postMeta, color: '#ffffff', ...TEXT_SHADOW },
  note: { flex: 1, minWidth: 160, color: 'rgba(255,255,255,0.8)', ...TEXT_SHADOW },
  sheetBody: { gap: 12, paddingHorizontal: 16, paddingBottom: 16 }
})
