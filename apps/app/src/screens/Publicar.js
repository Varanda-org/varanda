// Publicar: the composer sheet. post.create, post.reply when a post was
// chosen to answer, or post.quote when one was chosen to quote (`quote`, the
// same shape as `reply`: { ref, name, username, text }). Quotes need a
// connection: they are never queued in the outbox, and offline the send and
// the photo button are disabled ('Citações precisam de internet'). The shell keeps this component mounted: the draft lives in
// its state, outside the Modal, so closing the sheet keeps it.
// On the browser node a post that cannot go out now (no network, or the write
// gate could not reach the seeder) is kept in the outbox ('fila de saída',
// ../outboxProvider) and sent later; Diário lists it until then.
// Emoji: an inline panel (../ui/EmojiPicker) inserts at the caret (the
// TextInput selection is tracked) within the MAX_TEXT code-point limit.
// Photos and GIFs (when the node offers `media` and the platform has a
// picker, and online): a 'Foto' button picks files (../media/attach), each is
// encoded at once (../media/encode: photos re-encoded, which strips
// EXIF/GPS; GIFs as they are) and kept ONLY in this page (bytes in memory, a blob: thumbnail): no
// network, no node call. Privacy by construction: the media core is public
// (the seeder serves any range of it), so nothing is uploaded before the
// person presses Publicar; removing an item or closing the composer before
// that discards it with nothing uploaded. On Publicar the items are uploaded
// one at a time (progress per item), then post.create / post.reply carries
// their descriptors; text may then be empty. If an upload fails, the post is
// not sent, the descriptors already obtained are kept (a new Publicar does
// not upload them again) and the item shows 'falhou · tentar de novo'.
// Bytes already uploaded cannot be taken back: if Publicar was pressed and
// the upload or the post then failed, closing the composer leaves those
// blocks unused but public in the own media core. Media is never queued in
// the outbox (it is text-only): offline, attaching is disabled.
// A share (`shared`) uses the same local encode and may attach while
// offline: nothing is uploaded until the person presses Publicar.
// @ suggestions (hosted web, online only): while the caret is inside an
// @token of 2+ characters the member search (../useMemberSearch) lists up to
// 5 verified members under the compose box; tapping one replaces the token
// with '@nome ' (../mentions). No strip on native, offline or non-hosted. The
// text is sent exactly as typed: names are never resolved at send time.
// Momento (docs/rpc.md 5.113, hosted only, when the node offers
// media.putMoment and nothing is being replied to, quoted or posted as a
// page): a Segmented 'Publicação | Momento' at the top. A momento is exactly
// one photo (the chat photo path, ../ui/AttachSheet useChatAttachments) and
// 0..200 code points of text. The post draft stays as it is while Momento is
// shown and comes back on 'Publicação'. Publicar puts the photo
// (media.putMoment, a fresh anonymous blob; it wipes the buffer it is given,
// so it gets a copy and the staged bytes stay for a new try) and then
// publishes moment.create { text, media }. A locked message key answers
// LOCKED: the person is asked to unlock with the passkey. 'prepare a mídia
// de novo' drops the item, so the next press (the person's) puts the photo
// again. An uncertain moment.create holds the draft until the person checks
// in the Diário and discards it: never sent again.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT, activeMention, displayText } from '@varanda/rpc'
import { MENTION_MIN_QUERY, insertMention } from '../mentions'
import { mergeSuggestions } from '../mentionTargets'
import { useMemberSearch } from '../useMemberSearch'
import { MentionSuggest } from '../ui/MentionSuggest'
import { sha256 } from '@noble/hashes/sha2.js'
import { useNode } from '../node'
import { useNames } from '../names'
import * as actingStore from '../actingAs'
import { actAs, pagesMedia, pagesOrigin, pagesStart } from '../pages'
import { memberKeyOf, useActing } from './Conversa'
import { useOutbox } from '../outboxProvider'
import { GATE_MESSAGE, LOCKED_MESSAGE, isQuoteRecord } from '../outbox'
import { countChars } from '../format'
import { whoOf } from '../who'
import { ringState } from '../composeRing'
import { countAfterInsert, insertAt } from '../emoji'
import { MAX_MEDIA_PER_POST } from '../media/plan'
import { validDescriptor } from '../media/fetch'
import { pickImages } from '../media/attach'
import { revokeUrl, urlFromBytes } from '../media/display'
import { encodeFile } from '../media/encode'
import { linkHeld, mergeDraft, shareNote, sharedLinkHold } from '../sharedIntent'
import { moveById } from '../photoOrder'
import { Btn, ErrorText, Soft, errorText, useAction } from '../ui'
import { Avatar } from '../ui/Avatar'
import { EmojiPicker } from '../ui/EmojiPicker'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { LinkDraftCard, useLinkDraft } from '../ui/ChatComposer'
import { LINK_DRAFT_DELAY_MS, cardForSend, withCardFallback } from '../linkCard'
import { fallbackCard, isAudiusLink } from '../musicEmbed'
import { musicOriginOf } from '../music'
import { MUSIC_PHOTOS_TEXT, musicBlocks, musicSnapshot, resolveTarget, useLine } from '../musicDraft'
import { audiusPolicy, audiusReady, audiusResolve } from '../account'
import { playbackEpoch } from '../media/chatMedia'
import { previewTarget } from '../preview'
import { previewsEnabled } from '../previewPref'
import { previewPrefStore } from '../previewBuild'
import { MusicPicker } from '../ui/MusicPicker'
import { useMusicAvailable } from '../ui/MusicPlayerCard'
import { LinkCard } from '../ui/LinkCard'
import { withPreview } from '../attach-plan'
import { refusalOf } from '../wordCheck'
import { Sheet, TEXT_CAP } from '../ui/Sheet'
import { tap } from '../ui/haptics'
import { useKeyboardAvoidEnabled } from '../ui/keyboardAvoid'
import { type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { pagesOn } from '../pageGate'
import { Segmented } from '../ui/Segmented'
import { useChatAttachments } from '../ui/AttachSheet'
import { canPublishMoment } from '../momentSeen'
import { momentMusicOf } from '../moments'
import { momentsChanged } from './Momentos'

export const MOMENT_TEXT_MAX = 200
// maxLength counts UTF-16 units on the web: 200 code points of emoji take 400.
export const MOMENT_FIELD_MAX = 2 * MOMENT_TEXT_MAX
export const MOMENT_COUNTER_WARN = 180
export const MODES = [{ id: 'post', label: 'Publicação' }, { id: 'moment', label: 'Momento' }]
export const MOMENT_LOCKED = 'Desbloqueie com a passkey para publicar um momento.'
export const MOMENT_STALE = 'A foto precisa ser preparada de novo. Toque em Publicar para enviar.'
export const MOMENT_UNCERTAIN = 'Não sabemos se o momento saiu. Confira em Seus momentos, no seu Diário, antes de tentar de novo.'
export const MOMENT_ONE_PHOTO = 'Um momento leva uma foto só.'
export const DRAFT_KEPT = 'Seu rascunho da publicação continua guardado.'
const MEDIA_STALE = 'prepare a mídia de novo'

const momentLength = (text) => (typeof text === 'string' ? [...text].length : 0)
const isLocked = (err) => !!err && (err.code === 'LOCKED' || err.message === LOCKED_MESSAGE)

// A momento is valid with exactly one ready photo and at most 200 code points.
export function momentValid ({ files, ready, text }) {
  return ready === true && Array.isArray(files) && files.length === 1 && momentLength(text) <= MOMENT_TEXT_MAX
}

function useMomentMusicAvailable (node, member, active) {
  const origin = musicOriginOf(node)
  const { epoch, request, hosted } = node
  const capability = useRef(null)
  const [result, setResult] = useState(null)
  useEffect(() => {
    let live = true
    setResult(null)
    if (!active || hosted !== true || origin === null) return undefined
    const load = async () => {
      try {
        const policy = await audiusPolicy({ origin })
        if (!live || policy.moments !== true) return
        // Keep failures too: opening the sheet again must not repeat the probe.
        if (capability.current === null || capability.current.epoch !== epoch) {
          const probe = async () => {
            try {
              const info = await node.request('node.info', {})
              return info?.momentMusic === true
            } catch { return false }
          }
          capability.current = { epoch, answer: probe() }
        }
        const supported = await capability.current.answer
        if (!live || !supported) return
        const ready = await audiusReady({ member, origin })
        if (live) setResult({ epoch, request, member, origin, ok: ready === true })
      } catch {}
    }
    load()
    return () => { live = false }
  }, [active, hosted, epoch, request, member, origin])
  return active && hosted === true && origin !== null && result?.epoch === epoch && result?.request === request && result?.member === member && result?.origin === origin && result?.ok === true
}

// The Momento draft: one staged photo, the text, the put item kept for a new
// press after a failure, and the uncertain hold. send() is one explicit
// attempt; nothing here ever repeats a request.
function useMomentDraft ({ node, member, open, active }) {
  const photo = useChatAttachments()
  const musicAvailable = useMomentMusicAvailable(node, member, active)
  const [music, setMusic] = useState(null)
  const [musicPickerOpen, setMusicPickerOpen] = useState(false)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [held, setHeld] = useState(false)
  const itemRef = useRef(null)
  const busyRef = useRef(false)
  const { items, remove, pick: pickPhoto, clear: clearPhoto } = photo
  // Exactly one photo. 'Trocar foto' keeps the staged one until a new one is
  // really picked (a cancelled picker leaves it): replacingRef holds the ids
  // staged before the pick, dropped only once a new id shows up. A pick of
  // several keeps the first new one.
  const [note, setNote] = useState('')
  const replacingRef = useRef(null)
  useEffect(() => {
    const before = replacingRef.current
    const fresh = before === null ? items.slice(1) : items.filter((it) => !before.includes(it.id))
    if (before !== null && fresh.length > 0) {
      replacingRef.current = null
      itemRef.current = null
      for (const old of items.filter((it) => before.includes(it.id))) remove(old.id)
      for (const extra of fresh.slice(1)) remove(extra.id)
      if (fresh.length > 1) setNote(MOMENT_ONE_PHOTO)
      return
    }
    if (before === null && items.length > 1) {
      for (const extra of items.slice(1)) remove(extra.id)
      setNote(MOMENT_ONE_PHOTO)
    }
  }, [items, remove])
  const pick = useCallback(async () => {
    if (busyRef.current || held) return
    setNote('')
    setError('')
    replacingRef.current = items.length > 0 ? items.map((it) => it.id) : null
    await pickPhoto()
  }, [held, items, pickPhoto])
  const reset = useCallback(() => {
    itemRef.current = null
    clearPhoto()
    setText('')
    setMusic(null)
    setMusicPickerOpen(false)
    setError('')
    setNote('')
    setHeld(false)
  }, [clearPhoto])
  useEffect(() => { if (!open) setError('') }, [open])
  useEffect(() => {
    if (!active || !musicAvailable) setMusicPickerOpen(false)
  }, [active, musicAvailable])
  const pickMusic = (choice) => {
    if (busyRef.current || held || !musicAvailable || choice?.ref?.kind !== 'snippet') return
    const ref = momentMusicOf({ music: { p: 'audius', id: choice.ref.id, start: choice.ref.start } })
    if (ref !== null) setMusic({ ref, item: choice.item })
  }
  // A published moment empties the form on the next opening, not at once:
  // the sheet keeps its photo and text while it slides away.
  const publishedRef = useRef(false)
  const wasOpenRef = useRef(open)
  useEffect(() => {
    if (open && !wasOpenRef.current && publishedRef.current) {
      publishedRef.current = false
      reset()
    }
    wasOpenRef.current = open
  }, [open, reset])
  // A close or a switch to Publicação during the upload cancels that send:
  // the generation moves on and moment.create is never called for it. The
  // item already put is kept for the person's next explicit press.
  const genRef = useRef(0)
  useEffect(() => {
    if (!active) genRef.current++
  }, [active])
  const unlocked = !!(node.passkey && node.passkey.status && node.passkey.status.unlocked === true)
  const valid = !held && unlocked && node.online !== false && momentValid({ files: photo.files, ready: photo.ready, text })
  const send = async () => {
    if (busyRef.current || !valid) return false
    const refused = refusalOf(text)
    if (refused !== '') { setError(refused); return false }
    const file = photo.files[0]
    const gen = genRef.current
    busyRef.current = true
    setPending(true)
    setError('')
    try {
      if (itemRef.current === null) {
        // putMoment wipes the buffer it gets: the staged bytes stay for a retry.
        itemRef.current = await node.media.putMoment({ bytes: file.bytes.slice(), mime: file.mime, width: file.width, height: file.height })
      }
      if (gen !== genRef.current) return false
      const chosen = musicAvailable && music !== null ? { music: { p: 'audius', id: music.ref.id, start: music.ref.start } } : {}
      await node.request('moment.create', { text, media: itemRef.current, ...chosen })
      itemRef.current = null
      momentsChanged()
      publishedRef.current = true
      // Published, but the person closed Momento meanwhile (maybe for another
      // composer): no onPublished, which would close what is open now.
      return gen === genRef.current
    } catch (err) {
      if (isLocked(err)) setError(MOMENT_LOCKED)
      else if (err && err.uncertain === true) {
        // The moment may be published: hold the draft, never resend.
        if (itemRef.current !== null) {
          setHeld(true)
          setError(MOMENT_UNCERTAIN)
          momentsChanged()
        } else {
          setError(errorText(err))
        }
      } else if (err && typeof err.message === 'string' && err.message.includes(MEDIA_STALE)) {
        itemRef.current = null
        setError(MOMENT_STALE)
      } else {
        setError(errorText(err))
      }
      return false
    } finally {
      busyRef.current = false
      setPending(false)
    }
  }
  return { photo, text, setText, pending, error, note, held, valid, unlocked, pick, send, reset, music, setMusic, musicAvailable, musicPickerOpen, setMusicPickerOpen, pickMusic }
}

// The Momento text box: about five lines before its text scrolls inside it,
// six at most (type.compose lineHeight 24 plus the 10 pt padding and the 1 pt
// border each side, so six lines fit without an inner scroll), as the
// depoimento write sheet does.
export const MOMENT_MIN_HEIGHT = 5 * 24 + 20 + 2
export const MOMENT_MAX_HEIGHT = 6 * 24 + 20 + 2

// The Momento box height for a content height (onContentSizeChange): the
// content plus its 1 pt border each side, within the five to six lines.
export function momentFieldHeight (contentHeight) {
  if (!Number.isFinite(contentHeight)) return MOMENT_MIN_HEIGHT
  return Math.min(MOMENT_MAX_HEIGHT, Math.max(MOMENT_MIN_HEIGHT, Math.ceil(contentHeight) + 2))
}
// react-native-web keeps a multiline field at its first height (its first
// line then shows half cut past five lines): there the height follows the
// content. iOS and Android grow the field themselves.
const GROW_BY_CONTENT = Platform.OS === 'web'

// requestAnimationFrame is a global on iOS, Android and the web alike.
const nextFrame = (fn) => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 16))

// Where a composer body scrolls to keep its focused field in view: the end
// (the counter and what follows it) when everything from the field's top
// fits; else the field pinned KEEP_GAP under the top, so its first line (the
// caret line after a paste) and the counter right under it show; null when
// the field alone is taller than the view, where the native caret tracking
// keeps the caret, unless the caret is at the end of the text (`atEnd`):
// then the end, so the caret line sits just above the toolbar and counter
// (a reopened long draft). With the caret at the end and the field fitting
// but not the row under it (`tailBottom`, the toolbar and N/1000 row's
// bottom): scrolled so that row shows, never past the caret line at the
// field's bottom (photos between them). Unmeasured: the end, as before.
// -> 'end' | y | null
export const KEEP_GAP = 8
const CARET_LINE = 32
export function keepInView ({ fieldY, fieldHeight, contentHeight, viewHeight, atEnd = false, tailBottom = NaN }) {
  if (![fieldY, fieldHeight, contentHeight, viewHeight].every(Number.isFinite) || viewHeight <= 0) return 'end'
  const top = Math.max(0, fieldY - KEEP_GAP)
  if (contentHeight - top <= viewHeight) return 'end'
  if (fieldY + fieldHeight - top > viewHeight) return atEnd ? 'end' : null
  if (atEnd && Number.isFinite(tailBottom)) {
    return Math.max(top, Math.min(tailBottom - viewHeight, fieldY + fieldHeight - CARET_LINE))
  }
  return top
}

const layoutOf = (e) => (e && e.nativeEvent && e.nativeEvent.layout) || null
const keyboardHeight = (e) => {
  const h = e && e.endCoordinates ? e.endCoordinates.height : 0
  return Number.isFinite(h) ? h : 0
}

// iOS: inside the page sheet measureInWindow starts at the sheet's own top,
// so the measured padding came out about 45 pt short. There the composer
// ScrollViews inset themselves for the keyboard instead
// (automaticallyAdjustKeyboardInsets, an iOS ScrollView API) and nothing
// pads. Android keeps the measured padding below.
const IOS_SCROLL_INSETS = Platform.OS === 'ios'
// Both composer ScrollViews: the keyboard insets on iOS, taps that reach the
// fields and pills with the keyboard open, a drag that lowers the keyboard.
export const COMPOSER_SCROLL = {
  keyboardShouldPersistTaps: 'handled',
  keyboardDismissMode: 'interactive',
  ...(IOS_SCROLL_INSETS ? { automaticallyAdjustKeyboardInsets: true } : {})
}

// Both composers avoid the keyboard on iOS and Android with padding (Android
// draws edge to edge, so nothing resizes for it there). KeyboardAvoidingView
// compares its parent-relative frame with the keyboard's screen position, so
// inside a sheet it padded too little by the sheet's own top (and on iOS by
// the page sheet's top and header, about 100 pt): the measured window top goes
// back in as keyboardVerticalOffset. Measured again when the keyboard opens,
// as the iOS page sheet may still be sliding in at the first layout.
// The web only (a native getScrollableNode answers a number, so null there):
// react-native-web reports onLayout on size changes alone, so a photo tile
// that moves the field without resizing it leaves the measured y stale. Read
// the positions from the page when scrolling instead.
export function livePositions (view, fieldNode, tailNode) {
  const scroll = view && typeof view.getScrollableNode === 'function' ? view.getScrollableNode() : null
  if (!scroll || typeof scroll.getBoundingClientRect !== 'function') return null
  if (!fieldNode || typeof fieldNode.getBoundingClientRect !== 'function') return null
  const origin = scroll.getBoundingClientRect().top - scroll.scrollTop
  const field = fieldNode.getBoundingClientRect()
  const tail = tailNode && typeof tailNode.getBoundingClientRect === 'function' ? tailNode.getBoundingClientRect() : null
  return { fieldY: field.top - origin, fieldHeight: field.height, tailBottom: tail ? tail.bottom - origin : NaN }
}

// One composer body kept in view (keepInView) while its field has focus:
// deferred a frame after the keyboard inset or padding applied, on the
// keyboard opening and on every keystroke; directly on the body's layout and
// content size. The field's y in the body sums the onLayout y of each
// wrapper down to the field (at(key)). On iOS the ScrollView insets itself
// by the keyboard, so the keyboard's height leaves the visible part.
function useKeepInView (on, caretAtEnd = null, givenFieldRef = null) {
  const scrollRef = useRef(null)
  const ownFieldRef = useRef(null)
  const fieldRef = givenFieldRef || ownFieldRef
  const tailRef = useRef(null)
  const focusRef = useRef(false)
  const m = useRef({ parts: {}, fieldHeight: NaN, content: NaN, view: NaN, keyboard: 0, tailBottom: NaN })
  const scrollIntoView = useCallback(() => {
    const view = scrollRef.current
    if (!view) return
    // Each mode keeps its own ScrollView (key): react-native-web binds the
    // ref once, so a reused one kept the other mode's unmounted node. Still,
    // never scroll a view whose node is gone.
    if (typeof view.getScrollableNode === 'function' && !view.getScrollableNode()) return
    const s = m.current
    const live = livePositions(view, fieldRef.current, tailRef.current)
    const fieldY = live ? live.fieldY : Object.keys(s.parts).reduce((sum, k) => sum + s.parts[k], 0)
    const fieldHeight = live ? live.fieldHeight : s.fieldHeight
    const tailBottom = live ? live.tailBottom : s.tailBottom
    const atEnd = typeof caretAtEnd === 'function' && caretAtEnd() === true
    const to = keepInView({ fieldY, fieldHeight, contentHeight: s.content, viewHeight: s.view - s.keyboard, atEnd, tailBottom })
    if (to === 'end') {
      if (typeof view.scrollToEnd === 'function') view.scrollToEnd({ animated: true })
    } else if (to !== null && typeof view.scrollTo === 'function') {
      view.scrollTo({ y: to, animated: true })
    }
  }, [caretAtEnd, fieldRef])
  const keep = useCallback(() => {
    const view = scrollRef.current
    if (!focusRef.current || !view) return
    scrollIntoView()
  }, [scrollIntoView])
  const reveal = useCallback(() => {
    scrollIntoView()
  }, [scrollIntoView])
  const defer = useCallback(() => {
    if (!focusRef.current) return
    nextFrame(() => keep())
  }, [keep])
  useEffect(() => {
    if (!on) return undefined
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      m.current.keyboard = IOS_SCROLL_INSETS ? keyboardHeight(e) : 0
      defer()
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => { m.current.keyboard = 0 })
    return () => {
      for (const sub of [show, hide]) if (sub && typeof sub.remove === 'function') sub.remove()
    }
  }, [on, defer])
  const at = useCallback((key) => (e) => {
    const l = layoutOf(e)
    if (!l) return
    m.current.parts[key] = l.y
    if (key === 'field') m.current.fieldHeight = l.height
  }, [])
  // The post row is a direct child of the ScrollView content; the Momento
  // counter needs its body's offset to reach content coordinates.
  const handleTailLayout = useCallback((e, parent = null) => {
    const l = layoutOf(e)
    if (l) m.current.tailBottom = l.y + l.height + (m.current.parts[parent] || 0)
  }, [])
  const handleLayout = useCallback((e) => {
    const l = layoutOf(e)
    if (l) m.current.view = l.height
    keep()
  }, [keep])
  const handleContentSizeChange = useCallback((_w, h) => {
    if (Number.isFinite(h)) m.current.content = h
    keep()
  }, [keep])
  const handleFocus = useCallback(() => { focusRef.current = true }, [])
  const handleBlur = useCallback(() => { focusRef.current = false }, [])
  return { scrollRef, fieldRef, tailRef, reveal, defer, at, handleTailLayout, handleLayout, handleContentSizeChange, handleFocus, handleBlur }
}

export function SheetKeyboard ({ children }) {
  const styles = useStyles(makeStyles)
  const ref = useRef(null)
  const avoidKeyboard = useKeyboardAvoidEnabled()
  const [top, setTop] = useState(0)
  const measure = useCallback(() => {
    const view = ref.current
    if (!view || typeof view.measureInWindow !== 'function') return
    view.measureInWindow((x, y) => { if (Number.isFinite(y)) setTop((was) => (was === y ? was : y)) })
  }, [])
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', measure)
    return () => { if (sub && typeof sub.remove === 'function') sub.remove() }
  }, [measure])
  if (IOS_SCROLL_INSETS) return <View style={styles.flex}>{children}</View>
  return (
    <View ref={ref} style={styles.flex} onLayout={measure} collapsable={false}>
      <KeyboardAvoidingView style={styles.flex} behavior='padding' keyboardVerticalOffset={top} enabled={avoidKeyboard}>
        {children}
      </KeyboardAvoidingView>
    </View>
  )
}

// Clock slack when an uncertain send is matched by its `at` timestamp. The
// node stamps `at` while it handles the request, from the same clock as the
// app (the device natively, the same machine for varanda-serve on the web),
// so this send's post cannot predate `startedAt` beyond rounding. A wider
// window would take an identical earlier post for this one. An identical post
// confirmed within the slack is excluded by seq: a match must also be newer
// than the last own post this composer confirmed (lastSeqRef).
const MATCH_SLACK_MS = 2000

// The seq of a post.create / post.reply result, or null.
function seqOf (value) {
  return value && Number.isInteger(value.seq) ? value.seq : null
}

// A reply reference as 'author:seq' (lowercase author), or null.
function refOf (replyTo) {
  if (!replyTo || typeof replyTo.author !== 'string') return null
  return replyTo.author.toLowerCase() + ':' + String(replyTo.seq)
}

function sameRef (a, b) {
  if (a === null || b === null) return a === b
  return String(a).toLowerCase() === String(b).toLowerCase()
}

// True when a record's media is the list that was sent (null: none).
function sameMedia (recorded, sent) {
  const list = Array.isArray(recorded) && recorded.length > 0 ? recorded : null
  if (list === null || sent === null) return list === sent
  const id = (d) => d && d.core + ':' + d.start + ':' + d.blocks + ':' + d.sha256
  return list.length === sent.length && list.every((d, i) => id(d) === id(sent[i]))
}

// An upload progress report as a fraction 0..1: a number, or an object with
// done/loaded/uploaded and total.
function fractionOf (p) {
  let f = 0
  if (typeof p === 'number') f = p
  else if (p && typeof p === 'object') {
    const done = [p.done, p.loaded, p.uploaded].find((n) => typeof n === 'number')
    const total = [p.total, p.blocks].find((n) => typeof n === 'number')
    if (done !== undefined && total > 0) f = done / total
  }
  return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0
}

const PAGE_KEY = /^[0-9a-f]{64}$/
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

let lastItemId = 0
const nextItemId = () => ++lastItemId

// Progress ring: a grey track and a toned arc drawn with two half masks.
// Each half (10x20, overflow hidden) holds a 20x20 circle whose top and right
// borders take the tone colour; rotating the circle slides its half-circle arc into view.
function Ring ({ progress, tone }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const arcColor = colors[tone] || colors.accent
  const deg = Math.max(0, Math.min(1, progress)) * 360
  const rightDeg = -135 + Math.min(deg, 180)
  const leftDeg = 45 + Math.max(0, deg - 180)
  return (
    <View style={styles.ring} accessible={false} importantForAccessibility='no-hide-descendants'>
      <View style={styles.track} />
      {deg > 0
        ? (
          <View style={[styles.half, styles.halfRight]}>
            <View style={[styles.arc, styles.arcInRight, { borderTopColor: arcColor, borderRightColor: arcColor, transform: [{ rotate: rightDeg + 'deg' }] }]} />
          </View>
          )
        : null}
      {deg > 180
        ? (
          <View style={[styles.half, styles.halfLeft]}>
            <View style={[styles.arc, styles.arcInLeft, { borderTopColor: arcColor, borderRightColor: arcColor, transform: [{ rotate: leftDeg + 'deg' }] }]} />
          </View>
          )
        : null}
    </View>
  )
}

// `quote` takes precedence over `reply` (the shell keeps them exclusive);
// `onClearQuote` (optional) adds 'cancelar citação'. onPublished(kind, ref)
// with kind 'post' | 'reply' | 'quote' | 'queued-post' | 'queued-reply'.
// `shared` (optional) prefills this post once per id. `onSharedDone(id)`
// releases the shell's copy of the files. A lock unmounts this screen, so
// done is skipped then and the shell hands the same share back after unlock.
export default function Publicar ({ open, reply: replyProp, quote = null, momentRequest = 0, me, onClose, onClearReply, onClearQuote, onPublished, shared = null, onSharedDone = () => {}, onSharedTaken = () => {} }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const reply = quote ? null : replyProp
  const node = useNode()
  const outbox = useOutbox()
  const [text, setText] = useState('')
  // True while the own diary is re-read after an uncertain publish.
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  // A message about the text ends when the text changes.
  useEffect(() => { setCheckError('') }, [text])
  const action = useAction()
  // Highest own seq this composer confirmed in this session (a successful
  // publish, or a reconciliation that found it), or null.
  const lastSeqRef = useRef(null)
  const confirm = (seq) => {
    if (seq === null) return
    if (lastSeqRef.current === null || seq > lastSeqRef.current) lastSeqRef.current = seq
  }
  // Emoji panel and the caret: selRef follows the TextInput selection;
  // forcedSel places the caret once after an insert.
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [forcedSel, setForcedSel] = useState(null)
  const selRef = useRef(null)
  const inputRef = useRef(null)
  // Re-renders on a caret move so the active @token follows it.
  const [caret, setCaret] = useState(0)
  // A range selection has no single caret, so it gets no suggestions: a pick
  // there would be refused by insertMention.
  const [collapsed, setCollapsed] = useState(true)
  const [note, setNote] = useState('')
  // The composer stays mounted with its draft while closed: no searches then.
  const suggestOn = open === true && node.hosted === true && node.online !== false
  const search = useMemberSearch({
    request: node.request,
    hosted: node.hosted === true,
    online: node.online !== false,
    ownKey: me ? me.publicKey : null
  })
  // `caret` only forces the re-render; the live position is selRef.
  const caretAt = selRef.current && caret >= 0 ? Math.min(selRef.current.start, text.length) : text.length
  const active = suggestOn && collapsed ? activeMention(text, caretAt) : null
  const mentionQuery = active !== null && active.query.length >= MENTION_MIN_QUERY ? active.query : ''
  const { setQuery: searchSet, clear: searchClear } = search
  useEffect(() => {
    if (mentionQuery !== '') searchSet(mentionQuery)
    else searchClear()
  }, [mentionQuery, searchSet, searchClear])
  const suggestions = mentionQuery !== ''
    ? mergeSuggestions(search.hits, [], mentionQuery, me ? me.publicKey : null)
    : []
  // Attached items: { id, status: 'encoding' | 'invalid' | 'ready' |
  // 'uploading' | 'failed' | 'done', progress, thumb, encoded, descriptor,
  // error }. liveRef holds the ids still attached (updated synchronously),
  // thumbsRef the blob: URL of each thumbnail, genRef bumps on discard.
  const [items, setItems] = useState([])
  const liveRef = useRef(new Set())
  const thumbsRef = useRef(new Map())
  const genRef = useRef(0)
  // True while Publicar uploads the items (one send at a time).
  const uploadingRef = useRef(false)
  const [uploading, setUploading] = useState(false)
  const media = node.media && typeof node.media.upload === 'function' ? node.media : null
  const mediaOnline = node.online !== false

  // Publicar como: the page chosen (hosted only), whose posts, replies and
  // quotes go through the service and never the outbox.
  const names = useNames()
  const acting = useActing()
  const asPage = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && acting.kind === 'page' ? acting.key : null
  // Momento mode: hosted, with media.putMoment, and a plain post (no reply,
  // quote or page). The post draft is untouched while it shows.
  const momentOn = canPublishMoment(node) && !replyProp && !quote && asPage === null
  const [mode, setMode] = useState('post')
  const momentMode = momentOn && mode === 'moment'
  const moment = useMomentDraft({ node, member: me?.publicKey, open, active: open === true && momentMode })
  // Only an increase is a request: the shell resets the counter to 0 when a
  // post is published, and that must not reopen the composer in Momento.
  const lastMomentRequest = useRef(momentRequest)
  const momentAskedRef = useRef(false)
  useEffect(() => {
    const was = lastMomentRequest.current
    lastMomentRequest.current = momentRequest
    if (momentRequest > was) {
      momentAskedRef.current = true
      setMode('moment')
    }
  }, [momentRequest])
  // Each opening starts in Publicação (the publish button opens a post)
  // unless a moment request came with it. Reset on the opening, not on the
  // close: the sheet keeps its content while it slides away, so a reset there
  // flipped the closing sheet to the post composer.
  const wasOpenRef = useRef(open)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (!momentAskedRef.current) setMode('post')
      momentAskedRef.current = false
    }
    wasOpenRef.current = open
  }, [open])
  // Set by a momento publish, which closes the sheet: that close keeps the
  // post draft and its photos, as the Momento screen promised (DRAFT_KEPT).
  const keepPostOnCloseRef = useRef(false)
  const [roster, setRoster] = useState([])
  const [rosterFailed, setRosterFailed] = useState(false)
  // A sent-but-unknown page post ({ retry, page, sent, reply, quote, ids }):
  // retry() resends the same signed bytes. While it is set the draft is
  // locked and nothing new is signed.
  const pageRetryRef = useRef(null)
  const [pageRetry, setPageRetryState] = useState(null)
  const setPageRetry = (next) => {
    pageRetryRef.current = next
    setPageRetryState(next)
  }
  const locked = pageRetry !== null
  // True from the moment a page publish is sent until it settles: the draft
  // (text, photos, the chips) is then exactly what gets signed, so a retry
  // resends what is on screen.
  const pageSendingRef = useRef(false)
  const [pageSending, setPageSendingState] = useState(false)
  const setPageSending = (next) => {
    pageSendingRef.current = next
    setPageSendingState(next)
  }
  const frozen = locked || pageSending
  const openRef = useRef(open)
  openRef.current = open
  const asPageRef = useRef(asPage)
  asPageRef.current = asPage
  const canAttach = typeof pickImages === 'function' && (media !== null || asPage !== null)
  const { request: nodeRequest, hosted: nodeHosted } = node
  // Read at call time: on a core node the page statements go to its account
  // origin through the node (pages.js pagesOrigin).
  const nodeRef = useRef(node)
  nodeRef.current = node
  const pagesShown = pagesOn({ hosted: nodeHosted, accountOrigin: node.accountOrigin })
  const { resolveMany } = names
  useEffect(() => {
    if (!open || !pagesShown || node.online === false) return undefined
    let live = true
    const load = async () => {
      let rows
      try {
        const member = await memberKeyOf(nodeRequest, nodeRef.current)
        const data = await actAs(nodeRef.current, { member, action: 'list' })
        rows = [...(Array.isArray(data.owned) ? data.owned : []), ...(Array.isArray(data.admin) ? data.admin : [])]
          .filter((p) => p && PAGE_KEY.test(p.page) && p.closed !== true && !p.movedTo)
          .map((p) => p.page)
      } catch {
        // The last roster and the acting choice stay; only a list that was
        // read can say a page is no longer run.
        if (live) setRosterFailed(true)
        return
      }
      if (!live) return
      setRoster(rows)
      setRosterFailed(false)
      resolveMany(rows)
      // A page the person no longer runs is never acted as.
      const now = actingStore.get()
      if (now.kind === 'page' && !rows.includes(now.key)) actingStore.me()
    }
    load()
    return () => { live = false }
  }, [open, pagesShown, node.online, nodeRequest, resolveMany])
  // Photos uploaded for one identity are not valid for another. A post
  // being sent or waiting for its retry keeps its photos: they are in the
  // signed bytes.
  useEffect(() => {
    if (asPage !== null) setMusicDraft(null)
    if (pageRetryRef.current !== null || pageSendingRef.current) return
    genRef.current++
    removeItems(Array.from(liveRef.current))
  }, [asPage])
  // Drops the post waiting for its retry and unlocks the draft. Its photos
  // stay only for the page they were uploaded for.
  const discardRetry = () => {
    const pending = pageRetryRef.current
    if (pending === null || busy) return
    setPageRetry(null)
    action.clearError()
    if (pending.page !== asPage) {
      genRef.current++
      removeItems(Array.from(liveRef.current))
    }
  }

  const len = countChars(text)
  const hasMedia = items.length > 0
  // Every item encoded (or already uploaded by an earlier Publicar).
  const mediaReady = hasMedia && items.every((item) => item.descriptor || (item.encoded && item.status !== 'uploading'))
  const busy = action.pending || checking || uploading
  const self = me || { publicKey: null, name: null }
  // Natively only the installation's node needs the queue: the manual (core)
  // node writes its own diary offline.
  const canQueue = outbox.available && (Platform.OS === 'web' || node.hosted === true) &&
    typeof self.publicKey === 'string' && /^[0-9a-f]{64}$/.test(self.publicKey) &&
    !!(node.config && node.config.association)
  // Quotes are never queued: offline they wait for the network.
  const offlineQueue = canQueue && asPage === null && node.online === false && !quote
  const quoteOffline = !!quote && node.online === false
  // The draft link card (not as a page: its posts are signed statements).
  // cardRef keeps the card a Publicar already built from a snapshot, so a
  // new press after a failure never uploads its thumbnail again.
  // linkHold: the text a share left in the field while its link waits for
  // "Mostrar prévia do link"; any edit drops it.
  const [linkHold, setLinkHold] = useState(null)
  const shareLinkHeld = linkHeld(linkHold, text)
  useEffect(() => {
    if (linkHold !== null && linkHold !== text) setLinkHold(null)
  }, [linkHold, text])
  const member = self.publicKey
  const musicAvailable = useMusicAvailable(node, member, open)
  const musicOrigin = node.accountOrigin || musicOriginOf(node)
  const [musicDraft, setMusicDraftState] = useState(null)
  const musicDraftRef = useRef(null)
  const setMusicDraft = (draft) => {
    musicDraftRef.current = draft
    setMusicDraftState(draft)
  }
  const [musicPickerOpen, setMusicPickerOpen] = useState(false)
  const musicTried = useRef(new Set())
  const musicResolveOn = musicAvailable === true && node.online !== false && previewsEnabled(previewPrefStore())
  const musicResolveTarget = resolveTarget(text, musicTried.current)
  // Wait for the music policy before allowing an Audius page fetch on the device.
  const linkDraft = useLinkDraft({ text, enabled: open === true && asPage === null && !shareLinkHeld && !musicDraft && !(musicAvailable !== false && isAudiusLink(previewTarget(text))), photos: hasMedia, member: self.publicKey, fallback: fallbackCard })
  useEffect(() => {
    if (!open || momentMode || asPage !== null || hasMedia || musicDraft || busy || frozen || musicPickerOpen || shareLinkHeld || !musicResolveOn) return undefined
    const url = musicResolveTarget
    if (url === null) return undefined
    const controller = new AbortController()
    const epoch = playbackEpoch()
    const timer = setTimeout(async () => {
      if (epoch !== playbackEpoch()) return
      try {
        const { kind, item } = await audiusResolve(url, { member, origin: musicOrigin, request: nodeRequest, signal: controller.signal })
        if (controller.signal.aborted || epoch !== playbackEpoch() || liveRef.current.size > 0 || musicDraftRef.current !== null) return
        const draft = { ref: { kind, id: item.id, start: null }, item }
        if (musicSnapshot(draft) !== null) setMusicDraft(draft)
      } catch {
        // A failed resolve keeps the text and any other link's ordinary card.
      } finally {
        if (!controller.signal.aborted) musicTried.current.add(url)
      }
    }, LINK_DRAFT_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [musicResolveTarget, open, momentMode, asPage, hasMedia, musicDraft, busy, frozen, musicPickerOpen, shareLinkHeld, musicResolveOn, member, musicOrigin, nodeRequest])
  useEffect(() => {
    if (!open || momentMode || asPage !== null) setMusicPickerOpen(false)
  }, [open, momentMode, asPage])
  const pickMusic = (draft) => {
    if (busy || frozen || asPage !== null) return
    if (liveRef.current.size > 0) { setNote(MUSIC_PHOTOS_TEXT); return }
    if (musicSnapshot(draft) === null) return
    setNote('')
    setMusicDraft(draft)
  }
  const cardRef = useRef(null)
  // A page never queues: it needs the service.
  const pageOffline = asPage !== null && node.online === false
  // Media is never queued: offline, a post with photos waits for the network.
  // A quote always needs text (1..MAX_TEXT), photos or not.
  // A post waiting for its retry only needs the network: its bytes are signed.
  const valid = locked
    ? node.online !== false
    : len <= MAX_TEXT && !quoteOffline && !pageOffline && (quote ? len >= 1 : true) &&
      (hasMedia ? mediaReady && mediaOnline && (media !== null || asPage !== null) : len >= 1)

  const patch = (id, fields) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...fields } : item)))
  }

  const removeItems = (ids) => {
    const gone = new Set(ids)
    for (const id of gone) {
      liveRef.current.delete(id)
      revokeUrl(thumbsRef.current.get(id))
      thumbsRef.current.delete(id)
    }
    setItems((list) => list.filter((item) => !gone.has(item.id)))
  }

  // Closing the composer discards the pending items (the text draft stays);
  // a late encode or upload result of a discarded item is ignored. Nothing
  // was uploaded unless Publicar was pressed (see the header). A page post
  // being sent or waiting for its retry keeps its photos with its text: only
  // 'Descartar' frees them (or the send settling, see settledAsPage).
  useEffect(() => {
    if (open) return
    setEmojiOpen(false)
    setNote('')
    if (keepPostOnCloseRef.current) {
      keepPostOnCloseRef.current = false
      return
    }
    if (pageRetryRef.current !== null || pageSendingRef.current) return
    setMusicDraft(null)
    musicTried.current.clear()
    genRef.current++
    removeItems(Array.from(liveRef.current))
  }, [open])

  useEffect(() => () => {
    genRef.current++
    for (const url of thumbsRef.current.values()) revokeUrl(url)
    thumbsRef.current.clear()
  }, [])

  // One photo as the page: its own statement (start, page.sign) and the raw
  // bytes to the service. -> the descriptor.
  const uploadForPage = async (page, item) => {
    if (typeof item.retry === 'function') return (await item.retry()).descriptor
    const { encoded } = item
    const member = await memberKeyOf(nodeRequest, nodeRef.current)
    const origin = pagesOrigin(nodeRef.current)
    const { nonce } = await pagesStart({ member, action: 'media', page, origin })
    const op = { sha256: hexOf(sha256(encoded.bytes)), mime: encoded.mime, width: encoded.width, height: encoded.height, bytes: encoded.bytes.byteLength }
    const signed = await nodeRequest('page.sign', { action: 'media', nonce, page, op })
    const res = await pagesMedia({ member, nonce, page, op, signature: signed.signature, bytes: encoded.bytes, origin })
    return res.descriptor
  }

  // Uploads, on Publicar only, the items that have no descriptor yet, one at
  // a time. -> the descriptors in item order, or null when it stopped (an
  // upload failed, the item was removed or the composer was closed).
  const uploadAll = async (list, page = null) => {
    const gen = genRef.current
    const out = []
    for (const item of list) {
      if (item.descriptor) {
        out.push(item.descriptor)
        continue
      }
      if (!item.encoded || (media === null && page === null)) return null
      const { id, encoded } = item
      const live = () => gen === genRef.current && liveRef.current.has(id)
      patch(id, { status: 'uploading', progress: 0, error: '' })
      let descriptor
      try {
        descriptor = page !== null
          ? await uploadForPage(page, item)
          : await media.upload({
            bytes: encoded.bytes,
            mime: encoded.mime,
            width: encoded.width,
            height: encoded.height,
            onProgress: (p) => { if (live()) patch(id, { progress: fractionOf(p) }) }
          })
      } catch (err) {
        // After an unknown outcome the next try resends the same signed upload.
        const retry = err && err.uncertain === true && typeof err.retry === 'function' ? err.retry : null
        if (live()) patch(id, { status: 'failed', progress: 0, error: errorText(err), retry })
        return null
      }
      if (!live()) return null
      if (!validDescriptor(descriptor) || descriptor.mime !== encoded.mime) {
        patch(id, { status: 'failed', progress: 0, error: 'resposta inválida' })
        return null
      }
      patch(id, { status: 'done', progress: 1, descriptor })
      out.push(descriptor)
    }
    return gen === genRef.current ? out : null
  }

  // Reported before the encode: a full draft returns here, and the note still
  // has to say the new files did not fit.
  const addFiles = async (files, onRoom) => {
    const room = Math.max(0, MAX_MEDIA_PER_POST - liveRef.current.size)
    onRoom(Math.max(0, files.length - room))
    const chosen = files.slice(0, room).map((file) => ({ id: nextItemId(), file }))
    if (chosen.length === 0) return
    if (musicDraftRef.current !== null) {
      setMusicDraft(null)
      setNote(MUSIC_PHOTOS_TEXT)
    }
    const gen = genRef.current
    for (const { id } of chosen) liveRef.current.add(id)
    setItems((list) => [...list, ...chosen.map(({ id }) => ({
      id, status: 'encoding', progress: 0, thumb: null, encoded: null, descriptor: null, error: ''
    }))])
    // One at a time: decoding big photos in parallel would use a lot of memory.
    for (const { id, file } of chosen) {
      if (gen !== genRef.current) return
      let encoded
      try {
        encoded = await encodeFile(file)
      } catch (err) {
        if (gen === genRef.current && liveRef.current.has(id)) patch(id, { status: 'invalid', error: errorText(err) })
        continue
      }
      if (gen !== genRef.current || !liveRef.current.has(id)) continue
      let thumb = null
      try {
        thumb = urlFromBytes(encoded.bytes, encoded.mime)
        thumbsRef.current.set(id, thumb)
      } catch {}
      patch(id, { status: 'ready', encoded, thumb })
    }
  }

  const attach = async () => {
    if (!canAttach || !mediaOnline || busy || frozen) return
    setNote('')
    let files
    try {
      files = await pickImages()
    } catch {
      return
    }
    if (!Array.isArray(files) || files.length === 0) return
    await addFiles(files, (n) => {
      if (n > 0) setNote('até ' + MAX_MEDIA_PER_POST + ' fotos por publicação')
    })
  }

  // Done after unmount would drop the shell's files: a lock unmounts Publicar
  // and hands the same share back once the screen is mounted again.
  const mountedRef = useRef(false)
  const appliedShareRef = useRef(null)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    if (!(open && shared && shared.id !== appliedShareRef.current && !frozen && !busy && !moment.pending)) return
    appliedShareRef.current = shared.id
    onSharedTaken(shared.id)
    setMode('post')
    const merged = mergeDraft(text, shared.text, MAX_TEXT)
    if (merged.text !== text) setText(merged.text)
    setLinkHold((hold) => sharedLinkHold(text, merged.text, hold))
    if (shared.files.length === 0 || !canAttach) {
      setNote(shareNote({
        canAttach,
        hadFiles: shared.files.length > 0,
        noRoom: 0,
        dropped: shared.dropped,
        failed: shared.failed || 0,
        kept: merged.kept,
        clipped: shared.clipped
      }))
      onSharedDone(shared.id)
      return
    }
    const done = () => {
      if (mountedRef.current) onSharedDone(shared.id)
    }
    addFiles(shared.files, (n) => setNote(shareNote({
      canAttach: true,
      hadFiles: true,
      noRoom: n,
      dropped: shared.dropped,
      failed: shared.failed || 0,
      kept: merged.kept,
      clipped: shared.clipped
    }))).then(done, done)
  }, [open, shared && shared.id, frozen, busy, moment.pending])

  const pickEmoji = (emoji) => {
    if (frozen) return
    const next = insertAt(text, selRef.current, emoji)
    if (!countAfterInsert(next.text, '', MAX_TEXT).allowed) {
      setNote('limite de ' + MAX_TEXT + ' caracteres')
      tap('warn')
      return
    }
    setNote('')
    setText(next.text)
    selRef.current = next.selection
    setForcedSel(next.selection)
  }

  const pickMention = (hit) => {
    if (frozen) return
    // The suggestion was computed for this token: refuse it silently if the
    // text or the caret moved to another one, or a range got selected, since.
    const sel = selRef.current || { start: text.length, end: text.length }
    if (sel.start !== sel.end) return
    const now = activeMention(text, sel.start)
    if (active === null || now === null || now.start !== active.start || now.end !== active.end ||
      now.query !== active.query) return
    const r = insertMention(text, sel, hit.username)
    if (!r.changed) {
      // Selection and token were checked above and rows carry valid names,
      // so the only refusal left is the length limit.
      setNote('limite de ' + MAX_TEXT + ' caracteres')
      tap('warn')
      return
    }
    setNote('')
    setText(r.text)
    selRef.current = r.selection
    setCaret(r.selection.start)
    setForcedSel(r.selection)
    setCollapsed(true)
    searchClear()
    // Pressing a row moves focus to it (web) and the strip then unmounts, so
    // typing would go nowhere: give the editor focus back once the new text
    // and selection are rendered, with the caret after the name.
    const caretSel = r.selection
    setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      try {
        if (typeof input.focus === 'function') input.focus()
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caretSel.start, caretSel.end)
      } catch {}
    }, 0)
  }

  // Clears only what was sent (an edit made meanwhile stays) and tells the
  // shell, which shows the toast and clears the reply or quote if it still
  // matches.
  const published = (sent, sentReply, sentIds = [], sentQuote = null) => {
    tap('success')
    setMusicDraft(null)
    musicTried.current.clear()
    setText((current) => (current === sent ? '' : current))
    if (sentIds.length > 0) removeItems(sentIds)
    if (sentQuote) return onPublished('quote', sentQuote.ref)
    onPublished(sentReply ? 'reply' : 'post', sentReply ? sentReply.ref : null)
  }

  // Keeps the post in the outbox (the reply target verbatim). True when it
  // was stored; otherwise the draft stays with the reason.
  const queue = (sent, sentReply) => {
    try {
      outbox.add({
        author: self.publicKey,
        association: node.config.association,
        kind: sentReply ? 'reply' : 'post',
        to: sentReply ? sentReply.ref : null,
        text: sent
      })
    } catch (err) {
      setCheckError(errorText(err))
      return false
    }
    setText((current) => (current === sent ? '' : current))
    onPublished(sentReply ? 'queued-reply' : 'queued-post', sentReply ? sentReply.ref : null)
    return true
  }

  // The post as the page: start, page.sign, POST (never the outbox). After an
  // unknown outcome the draft locks and 'Tentar de novo' resends the same
  // signed bytes (retry), to the page they were signed for.
  // A page send settled with nothing waiting for a retry: photos kept only
  // because it was in flight go now if the composer closed meanwhile or the
  // identity changed (they were uploaded for `page`).
  const settledAsPage = (page) => {
    if (pageRetryRef.current !== null || pageSendingRef.current) return
    if (openRef.current && asPageRef.current === page) return
    genRef.current++
    removeItems(Array.from(liveRef.current))
  }

  const sendAsPage = async () => {
    const page = asPage
    const pending = pageRetryRef.current
    if (pending !== null) {
      const r = await action.run(() => pending.retry())
      if (pageRetryRef.current !== pending) return
      if (r.ok) {
        setPageRetry(null)
        published(pending.sent, pending.reply, pending.ids, pending.quote)
      } else if (!r.uncertain) {
        // Refused for sure: nothing was published, the draft is free again.
        setPageRetry(null)
      }
      settledAsPage(pending.page)
      return
    }
    if (page === null) return
    const sent = text
    const sentReply = reply
    const sentQuote = quote
    if (sentQuote && countChars(sent) < 1) return
    setPageSending(true)
    try {
      await sendNewAsPage(page, sent, sentReply, sentQuote)
    } finally {
      setPageSending(false)
    }
    settledAsPage(page)
  }

  const sendNewAsPage = async (page, sent, sentReply, sentQuote) => {
    const sentIds = items.map((item) => item.id)
    let sentMedia = null
    if (hasMedia) {
      if (!mediaReady || !mediaOnline) return
      uploadingRef.current = true
      setUploading(true)
      try {
        sentMedia = await uploadAll(items, page)
      } finally {
        uploadingRef.current = false
        setUploading(false)
      }
      if (sentMedia === null) return
    }
    const kind = sentQuote ? 'quote' : sentReply ? 'reply' : 'post'
    const op = { text: sent }
    if (sentQuote) op.to = sentQuote.ref
    else if (sentReply) op.to = sentReply.ref
    if (sentMedia !== null) op.media = sentMedia
    let raw = null
    const r = await action.run(async () => {
      try {
        return await actAs(nodeRef.current, { member: await memberKeyOf(nodeRequest, nodeRef.current), action: kind, page, op })
      } catch (err) {
        raw = err
        throw err
      }
    })
    if (r.ok) return published(sent, sentReply, sentIds, sentQuote)
    if (r.uncertain && raw && typeof raw.retry === 'function') {
      setPageRetry({ retry: raw.retry, page, sent, reply: sentReply, quote: sentQuote, ids: sentIds })
    }
  }

  const send = async () => {
    if (busy || uploadingRef.current) return
    setCheckError('')
    // Before every path below (photos, the outbox, a page's signature). The
    // draft is kept, so the person can edit it. A signed post waiting for its
    // retry passed this when it was first sent.
    const refused = pageRetryRef.current === null ? refusalOf(text) : ''
    if (refused !== '') {
      setCheckError(refused)
      return
    }
    const sentMusic = musicDraft
    if (sentMusic !== null) {
      const blocked = musicBlocks({ hasMedia, asPage, online: node.online, textLength: len })
      if (blocked !== '') { setCheckError(blocked); return }
    }
    // Never a new signature while a signed post waits for its retry.
    if (pageRetryRef.current !== null || asPage !== null) return sendAsPage()
    const sent = text
    const sentReply = reply
    const sentQuote = quote
    if (sentQuote && (node.online === false || countChars(sent) < 1)) return
    const sentIds = items.map((item) => item.id)
    let sentMedia = null
    if (hasMedia) {
      if (!mediaReady || !mediaOnline || media === null) return
      uploadingRef.current = true
      setUploading(true)
      try {
        sentMedia = await uploadAll(items)
      } finally {
        uploadingRef.current = false
        setUploading(false)
      }
      if (sentMedia === null) return
    } else if (offlineQueue && !sentQuote && sentMusic === null) {
      queue(sent, sentReply)
      return
    }
    // The node stamps `at` from the same clock: a match must be this send's.
    const startedAt = Date.now()
    const base = sentMedia !== null ? { text: sent, media: sentMedia } : { text: sent }
    const method = sentQuote ? 'post.quote' : sentReply ? 'post.reply' : 'post.create'
    const to = sentQuote ? { to: sentQuote.ref } : sentReply ? { to: sentReply.ref } : {}
    // A link card goes with text only; its thumbnail joins the public media
    // core like a post photo, uploaded once per snapshot.
    let card = null
    const snapshot = sentMedia === null ? (musicSnapshot(sentMusic) ?? linkDraft.take(sent)) : null
    if (snapshot !== null) {
      const prev = cardRef.current
      if (prev && prev.url === snapshot.url && prev.thumb === (snapshot.thumb ? snapshot.thumb.bytes : null)) {
        card = prev.card
      } else {
        const upload = media !== null
          ? async (t) => {
            const d = await media.upload({ bytes: t.bytes, mime: t.mime, width: t.width, height: t.height })
            if (!validDescriptor(d) || d.mime !== t.mime) throw new Error('resposta inválida')
            return d
          }
          : null
        uploadingRef.current = true
        setUploading(true)
        try {
          card = await cardForSend(snapshot, { upload })
        } finally {
          uploadingRef.current = false
          setUploading(false)
        }
        cardRef.current = { url: snapshot.url, thumb: snapshot.thumb ? snapshot.thumb.bytes : null, card }
      }
    }
    const built = withCardFallback((c) => (c ? withPreview(method, { ...to, ...base }, c) : { ...to, ...base }), card)
    if (sentMusic !== null && built.card === null) {
      setCheckError('A música não coube: encurte o texto')
      return
    }
    const params = built.op
    // The draft is kept on any failure; a request is never resent.
    let raw = null
    const call = () => node.request(method, params)
    const r = await action.run(() => call().catch((err) => {
      raw = err
      throw err
    }))
    if (r.ok) {
      confirm(seqOf(r.value))
      return published(sent, sentReply, sentIds, sentQuote)
    }
    // The write gate could not reach the seeder: nothing was written, so the
    // post waits in the outbox (text only: a post with photos or a quote
    // stays here).
    if (sentMusic === null && sentMedia === null && !sentQuote && canQueue && raw && raw.uncertain !== true && raw.message === GATE_MESSAGE) {
      if (queue(sent, sentReply)) action.clearError()
      return
    }
    if (!r.uncertain) return
    // Uncertain: re-read the own diary before offering the action again
    // (docs/rpc.md section 9). A match has the same text and reply target,
    // an `at` within the slack of `startedAt`, and a seq above the last one
    // this composer confirmed (so an identical post published just before is
    // not taken for this one). Found = published; otherwise the draft and the
    // uncertain message stay and the person decides. A quote matches only a
    // record quoting the same post; a post or reply never matches a quote.
    setChecking(true)
    try {
      const res = await node.request('log.read', {})
      const wanted = sentReply ? sentReply.ref : null
      const floor = lastSeqRef.current
      const found = (res.entries || []).find((entry) => {
        const record = entry && entry.record
        const quoteOk = sentQuote
          ? isQuoteRecord(record) && sameRef(refOf(record.quote), sentQuote.ref)
          : !isQuoteRecord(record)
        return record && record.type === 'post' && record.text === sent && quoteOk &&
          sameRef(refOf(record.replyTo), wanted) && sameMedia(record.media, sentMedia) &&
          (sentMusic === null || (record.preview && typeof record.preview === 'object' && !Array.isArray(record.preview) && record.preview.url === built.card.url)) &&
          Date.parse(record.at) >= startedAt - MATCH_SLACK_MS &&
          (floor === null || (Number.isInteger(entry.seq) && entry.seq > floor))
      })
      if (found) {
        confirm(Number.isInteger(found.seq) ? found.seq : null)
        action.clearError()
        published(sent, sentReply, sentIds, sentQuote)
      }
    } catch (err) {
      setCheckError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  const replyName = reply ? displayText(whoOf({ name: reply.name, username: reply.username }).title) : ''
  const quoteName = quote ? displayText(whoOf({ name: quote.name, username: quote.username }).title) : ''
  const ring = ringState(len, MAX_TEXT)
  const selfWho = whoOf({ name: self.name, username: self.username })
  const attachOff = !mediaOnline || quoteOffline
  // Locked: the draft is what was signed and waits for its retry. Frozen
  // also covers a page send in flight.
  const held = busy || frozen
  let pillLabel = offlineQueue && !hasMedia && musicDraft === null ? 'Guardar' : 'Publicar'
  if (locked) pillLabel = 'Tentar de novo'

  const sendMoment = async () => {
    if (await moment.send()) {
      tap('success')
      // The mode goes back to Publicação once the sheet has closed (the
      // close effect), so the sliding sheet never flips to the post composer.
      keepPostOnCloseRef.current = true
      onPublished('moment', null)
    }
  }
  const handlePickMoment = moment.pick
  const handleMomentText = moment.setText
  const handleDiscardMoment = moment.reset
  const postDraft = text !== '' || items.length > 0
  const momentCount = momentLength(moment.text)
  // While a text box has focus it stays in view with its counter (see
  // keepInView): every keystroke, also at the six-line maximum where the
  // body's content size no longer changes, and the keyboard opening.
  const momentView = useKeepInView(momentMode)
  const staged = moment.photo.items[0] || null
  const revealedMomentPhotoRef = useRef(null)
  useEffect(() => {
    if (!open || !momentMode || !staged || !moment.photo.ready || revealedMomentPhotoRef.current === staged) return
    let cancelled = false
    nextFrame(() => {
      if (cancelled) return
      momentView.reveal()
      revealedMomentPhotoRef.current = staged
    })
    return () => { cancelled = true }
  }, [open, momentMode, staged, moment.photo.ready, momentView.reveal])
  // The post caret at the end of its text (a reopened long draft): the body
  // scrolls to its end so the caret line sits above the toolbar and counter.
  const postTextRef = useRef(text)
  postTextRef.current = text
  const postCaretAtEnd = useCallback(() => {
    // The web's own field is current; its selection event lags a keystroke.
    const node = inputRef.current
    if (node && typeof node.selectionStart === 'number' && typeof node.value === 'string') return node.selectionStart >= node.value.length
    const sel = selRef.current
    return !sel || sel.start >= postTextRef.current.length
  }, [])
  const postView = useKeepInView(open && !momentMode, postCaretAtEnd, inputRef)
  // The web only (a textarea has selectionStart): each mode mounts its own
  // field, and a new textarea with a saved draft puts the caret at the start,
  // so typing would land before the old text. It starts at the end instead,
  // as the phones' autofocus does.
  const postShown = open === true && !momentMode
  const postShownRef = useRef(false)
  useEffect(() => {
    if (postShown && !postShownRef.current) {
      const node = inputRef.current
      const end = postTextRef.current.length
      if (end > 0 && node && typeof node.selectionStart === 'number') {
        selRef.current = { start: end, end }
        setForcedSel({ start: end, end })
        // A long draft: show the caret line, not the top of the text.
        node.scrollTop = node.scrollHeight
      }
    }
    postShownRef.current = postShown
  }, [postShown])
  const typeMoment = (value) => {
    handleMomentText(value)
    momentView.defer()
  }
  const typePost = (value) => {
    setText(value)
    postView.defer()
  }
  const [momentHeight, setMomentHeight] = useState(MOMENT_MIN_HEIGHT)
  useEffect(() => { if (moment.text === '') setMomentHeight(MOMENT_MIN_HEIGHT) }, [moment.text])
  const growMoment = GROW_BY_CONTENT
    ? (e) => {
        const size = e && e.nativeEvent && e.nativeEvent.contentSize
        if (size) setMomentHeight(momentFieldHeight(size.height))
      }
    : undefined
  const modeSwitch = momentOn
    ? <Segmented options={MODES} selected={momentMode ? 'moment' : 'post'} onSelect={(id) => { if (!busy && !moment.pending) setMode(id) }} />
    : null

  if (momentMode) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        grabber
        right={<Pill label='Publicar' filled onPress={sendMoment} pending={moment.pending} disabled={!moment.valid} maxFontSizeMultiplier={TEXT_CAP} />}
      >
        <SheetKeyboard>
          <ScrollView
            key='moment'
            ref={momentView.scrollRef}
            style={styles.flex}
            {...COMPOSER_SCROLL}
            onLayout={momentView.handleLayout}
            onContentSizeChange={momentView.handleContentSizeChange}
          >
            {modeSwitch}
            <View style={styles.momentBody} onLayout={momentView.at('body')}>
              {staged
                ? (
                  <View style={styles.momentPhoto} accessible accessibilityRole='image' accessibilityLabel='foto do momento'>
                    {staged.thumb
                      ? <Image source={{ uri: staged.thumb }} style={styles.thumbImg} resizeMode='cover' />
                      : <View style={[styles.thumbImg, styles.thumbEmpty]}><Icon name='image' size={24} color={colors.soft} /></View>}
                  </View>
                  )
                : null}
              {/* Under the tile, never clipped by its rounded corner. */}
              {staged && staged.status === 'invalid' ? <ErrorText>{staged.error || 'não foi possível abrir a foto'}</ErrorText> : null}
              <Pill label={staged ? 'Trocar foto' : 'Escolher foto'} icon='imagem' onPress={handlePickMoment} disabled={moment.pending || moment.held} />
              {moment.musicAvailable
                ? <Pill label='Música' onPress={() => moment.setMusicPickerOpen(true)} disabled={moment.pending || moment.held || node.online === false} />
                : null}
              {moment.musicAvailable && moment.music !== null
                ? (
                  <View style={styles.momentMusicChip}>
                    <Text style={[styles.counter, styles.flex]} numberOfLines={2}>{displayText(moment.music.item.title)}, {displayText(moment.music.item.artist)} · Audius</Text>
                    <Pill icon='fechar' accessibilityLabel='Remover música' onPress={() => moment.setMusic(null)} disabled={moment.pending || moment.held} />
                  </View>
                  )
                : null}
              <TextInput
                ref={momentView.fieldRef}
                style={[styles.momentInput, GROW_BY_CONTENT && { height: momentHeight }]}
                value={moment.text}
                onChangeText={typeMoment}
                onLayout={momentView.at('field')}
                onContentSizeChange={growMoment}
                editable={!moment.pending && !moment.held}
                multiline
                maxLength={MOMENT_FIELD_MAX}
                placeholder='Uma frase sobre o momento (opcional)'
                placeholderTextColor={colors.placeholder}
                textAlignVertical='top'
                onFocus={momentView.handleFocus}
                onBlur={momentView.handleBlur}
                accessibilityLabel='texto do momento'
              />
              <Text
                ref={momentView.tailRef}
                onLayout={(e) => momentView.handleTailLayout(e, 'body')}
                style={[styles.counter, styles.momentCounter, momentCount >= MOMENT_COUNTER_WARN && styles.counterWarn, momentCount > MOMENT_TEXT_MAX && styles.counterFull]}
                accessibilityLabel={momentCount + ' de ' + MOMENT_TEXT_MAX + ' caracteres'}
              >
                {momentCount + '/' + MOMENT_TEXT_MAX}
              </Text>
              <Soft>Fica 24 horas para quem segue você. Responder abre uma conversa privada.</Soft>
              {!moment.unlocked ? <Soft>{MOMENT_LOCKED}</Soft> : null}
              {node.online === false ? <Soft>Momentos precisam de internet</Soft> : null}
              {moment.photo.note || moment.note ? <Soft>{moment.note || moment.photo.note}</Soft> : null}
              {postDraft ? <Soft>{DRAFT_KEPT}</Soft> : null}
              <ErrorText>{moment.error}</ErrorText>
              {moment.held
                ? (
                  <View style={styles.retryRow}>
                    <Btn label='Descartar' secondary onPress={handleDiscardMoment} />
                  </View>
                  )
                : null}
            </View>
          </ScrollView>
          <MusicPicker
            open={open === true && moment.musicAvailable && moment.musicPickerOpen && !moment.pending && !moment.held}
            onClose={() => moment.setMusicPickerOpen(false)}
            onPick={(choice) => moment.pickMusic(choice)}
            member={me?.publicKey}
            origin={musicOriginOf(node)}
            request={nodeRequest}
            modes={['snippet']}
          />
        </SheetKeyboard>
      </Sheet>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      grabber
      right={<Pill label={pillLabel} filled onPress={send} pending={busy} disabled={!valid} maxFontSizeMultiplier={TEXT_CAP} />}
    >
      <SheetKeyboard>
        <ScrollView
          key='post'
          ref={postView.scrollRef}
          style={styles.flex}
          {...COMPOSER_SCROLL}
          onLayout={postView.handleLayout}
          onContentSizeChange={postView.handleContentSizeChange}
        >
          {modeSwitch}
          {pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && roster.length > 0
            ? (
              <View style={styles.asRow} accessibilityRole='radiogroup'>
                <Text style={styles.asLabel}>Publicar como</Text>
                <Chip label='Você' on={asPage === null} disabled={held} onPress={() => actingStore.me()} />
                {roster.map((key) => {
                  const p = names.profileOf(key)
                  return (
                    <Chip
                      key={key}
                      label={pageLabel(p)}
                      on={asPage === key}
                      disabled={held}
                      onPress={() => actingStore.asPage({ key, name: p && p.name, username: p && p.username })}
                    />
                  )
                })}
              </View>
              )
            : null}
          {reply
            ? (
              <>
                <View style={styles.markRow}>
                  <Text style={styles.mark}>
                    {'respondendo a '}
                    <Text style={styles.markName}>{replyName}</Text>
                  </Text>
                  <Pressable
                    accessibilityRole='button'
                    accessibilityState={{ disabled: busy }}
                    disabled={held}
                    onPress={onClearReply}
                    hitSlop={8}
                  >
                    <Text style={styles.markCancel}>cancelar resposta</Text>
                  </Pressable>
                </View>
                <Text style={styles.quote} numberOfLines={2}>{displayText(reply.text, { multiline: true })}</Text>
              </>
              )
            : null}
          {quote
            ? (
              <>
                <View style={styles.markRow}>
                  <Text style={styles.mark}>
                    {'citando '}
                    <Text style={styles.markName}>{quoteName}</Text>
                  </Text>
                  {typeof onClearQuote === 'function'
                    ? (
                      <Pressable
                        accessibilityRole='button'
                        accessibilityState={{ disabled: busy }}
                        disabled={held}
                        onPress={onClearQuote}
                        hitSlop={8}
                      >
                        <Text style={styles.markCancel}>cancelar citação</Text>
                      </Pressable>
                      )
                    : null}
                </View>
                <View style={styles.quoteCard}>
                  <Text style={styles.quoteCardName} numberOfLines={1}>{quoteName}</Text>
                  {typeof quote.text === 'string' && quote.text !== ''
                    ? <Text style={styles.quote} numberOfLines={3}>{displayText(quote.text, { multiline: true })}</Text>
                    : null}
                </View>
              </>
              )
            : null}
          <View style={styles.compose} onLayout={postView.at('compose')}>
            <Avatar name={self.name || self.username || null} publicKey={self.publicKey || ''} size={40} picture={self.avatar} persist />
            <View style={styles.composeBody} onLayout={postView.at('composeBody')}>
              <Text style={styles.author} numberOfLines={1}>
                <Text style={styles.authorName}>{displayText(selfWho.title)}</Text>
                {selfWho.subtitle ? <Text style={styles.authorMeta}>{'  ' + displayText(selfWho.subtitle)}</Text> : null}
              </Text>
              <TextInput
                ref={inputRef}
                style={styles.input}
                value={text}
                onChangeText={typePost}
                onLayout={postView.at('field')}
                onFocus={postView.handleFocus}
                onBlur={postView.handleBlur}
                editable={!frozen}
                selection={forcedSel || undefined}
                onSelectionChange={(event) => {
                  selRef.current = event.nativeEvent.selection
                  setCaret(event.nativeEvent.selection.start)
                  setCollapsed(event.nativeEvent.selection.start === event.nativeEvent.selection.end)
                  if (forcedSel) setForcedSel(null)
                }}
                multiline
                placeholder='O que está rolando na varanda?'
                placeholderTextColor={colors.placeholder}
                autoFocus
                textAlignVertical='top'
                accessibilityLabel='texto da publicação'
              />
            </View>
          </View>
          {hasMedia
            ? (
              <View style={styles.thumbs}>
                {items.map((item, i) => (
                  <Thumb
                    key={item.id}
                    item={item}
                    index={i}
                    count={items.length}
                    busy={held}
                    onRemove={() => removeItems([item.id])}
                    onRetry={send}
                    onMoveBefore={() => setItems((list) => moveById(list, item.id, -1))}
                    onMoveAfter={() => setItems((list) => moveById(list, item.id, 1))}
                  />
                ))}
              </View>
              )
            : musicDraft !== null
              ? (
                <View style={styles.errors}>
                  <LinkCard draft={musicSnapshot(musicDraft)} onDismiss={held ? undefined : () => setMusicDraft(null)} />
                  <Soft>{useLine(musicDraft.ref)}</Soft>
                </View>
                )
              : shareLinkHeld && open === true && asPage === null && previewsEnabled(previewPrefStore())
                ? (
                  <Pressable
                    accessibilityRole='button'
                    accessibilityLabel='Mostrar prévia do link'
                    accessibilityState={{ disabled: frozen }}
                    disabled={frozen}
                    onPress={() => setLinkHold(null)}
                    hitSlop={6}
                    style={({ pressed }) => [styles.linkAsk, pressed && styles.toolPressed]}
                  >
                    <Text style={styles.linkAskText}>Mostrar prévia do link</Text>
                  </Pressable>
                  )
                : <LinkDraftCard draft={linkDraft} />}
          <MentionSuggest rows={frozen ? [] : suggestions} loading={!frozen && mentionQuery !== '' && search.phase === 'loading'} onPick={pickMention} />
          <View ref={postView.tailRef} style={styles.counterRow} onLayout={postView.handleTailLayout}>
            <View style={styles.tools}>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={emojiOpen ? 'fechar emojis' : 'emojis'}
                accessibilityState={{ expanded: emojiOpen, disabled: frozen }}
                disabled={frozen}
                onPress={() => setEmojiOpen((v) => !v)}
                hitSlop={6}
                style={({ pressed }) => [styles.tool, pressed && styles.toolPressed]}
              >
                <Icon name='smile' size={21} color={emojiOpen ? colors.accent : colors.soft} />
              </Pressable>
              {canAttach
                ? (
                  <Pressable
                    accessibilityRole='button'
                    accessibilityLabel='Foto'
                    accessibilityState={{ disabled: attachOff || held }}
                    disabled={attachOff || held}
                    onPress={() => {
                      if (items.length >= MAX_MEDIA_PER_POST) setNote('até ' + MAX_MEDIA_PER_POST + ' fotos por publicação')
                      else attach()
                    }}
                    hitSlop={6}
                    style={({ pressed }) => [styles.tool, attachOff && styles.toolOff, pressed && styles.toolPressed]}
                  >
                    <Icon name='image' size={21} color={colors.soft} />
                  </Pressable>
                  )
                : null}
              {musicAvailable === true && asPage === null
                ? (
                  <Pressable
                    accessibilityRole='button'
                    accessibilityLabel='Música'
                    accessibilityState={{ disabled: held }}
                    disabled={held}
                    onPress={() => setMusicPickerOpen(true)}
                    hitSlop={6}
                    style={({ pressed }) => [styles.tool, pressed && styles.toolPressed]}
                  >
                    <Text style={styles.counter}>Música</Text>
                  </Pressable>
                  )
                : null}
            </View>
            <View style={styles.count}>
              <Ring progress={ring.progress} tone={ring.tone} />
              <Text style={[styles.counter, ring.tone === 'warn' && styles.counterWarn, ring.tone === 'danger' && styles.counterFull]}>
                {ring.remaining === null ? len + '/' + MAX_TEXT : String(ring.remaining)}
              </Text>
            </View>
          </View>
          <MusicPicker
            open={open === true && !momentMode && asPage === null && musicAvailable === true && musicPickerOpen && !held}
            onClose={() => setMusicPickerOpen(false)}
            onPick={pickMusic}
            member={member}
            origin={musicOrigin}
            request={nodeRequest}
            modes={['snippet', 'track', 'playlist']}
          />
          <EmojiPicker open={emojiOpen && !frozen} onPick={pickEmoji} />
          {quoteOffline
            ? <View style={styles.errors}><Soft>Citações precisam de internet</Soft></View>
            : null}
          {pageOffline && !quoteOffline
            ? <View style={styles.errors}><Soft>Publicar como página precisa de internet</Soft></View>
            : null}
          {canAttach && !mediaOnline && !quoteOffline
            ? <View style={styles.errors}><Soft>Fotos precisam de internet</Soft></View>
            : null}
          {note ? <View style={styles.errors}><Soft>{note}</Soft></View> : null}
          {offlineQueue && !hasMedia && musicDraft === null
            ? <View style={styles.errors}><Soft>Sem rede: a publicação fica aguardando envio e sai sozinha quando a conexão voltar.</Soft></View>
            : null}
          {rosterFailed && roster.length > 0
            ? <View style={styles.errors}><Soft>Não deu para atualizar suas páginas</Soft></View>
            : null}
          {locked
            ? (
              <View style={styles.errors}>
                <Soft>Não sabemos se a publicação saiu. Toque em Tentar de novo para reenviar a mesma, ou descarte.</Soft>
                <View style={styles.retryRow}>
                  <Btn label='Descartar' secondary onPress={discardRetry} disabled={busy} />
                </View>
              </View>
              )
            : null}
          <View style={styles.errors}>
            <ErrorText>{action.error}</ErrorText>
            <ErrorText>{checkError}</ErrorText>
          </View>
        </ScrollView>
      </SheetKeyboard>
    </Sheet>
  )
}

// Never a raw key as a label.
function pageLabel (profile) {
  const name = profile && profile.name ? displayText(profile.name).trim() : ''
  if (name !== '') return name
  const username = profile && profile.username ? displayText(profile.username).trim() : ''
  return username !== '' ? '@' + username : 'Página'
}

function Chip ({ label, on, disabled, onPress }) {
  const styles = useStyles(makeStyles)
  return (
    <Pressable
      accessibilityRole='radio'
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

// One attached item: the thumbnail of the encoded bytes, a remove button, a
// progress bar while uploading and the retry line after a failure. With two
// or more photos, arrows move this one earlier or later: the first is the
// cover, so it sets the carousel frame and the Mural tile.
function Thumb ({ item, index, count, busy, onRemove, onRetry, onMoveBefore, onMoveAfter }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const label = 'foto ' + (index + 1) + ' de ' + count
  const failed = item.status === 'failed'
  const invalid = item.status === 'invalid'
  const showBar = item.status === 'uploading'
  const canMove = count >= 2
  const cover = canMove && index === 0
  // On the web, a move takes the pressed arrow out of the page (React moves
  // the photo, or the arrow disappears at an end) and the sheet's focus trap
  // sends the focus to Cancelar, where a second Enter would discard the draft.
  // The focus comes back to this photo's arrow, the other one at an end.
  // Native nodes have no activeElement, so nothing happens there.
  const beforeRef = useRef(null)
  const afterRef = useRef(null)
  const refocus = useRef(0)
  const hadFocus = (ref) => {
    const node = ref.current
    const doc = node && node.ownerDocument
    return !!(doc && doc.activeElement && doc.activeElement === node)
  }
  useEffect(() => {
    const dir = refocus.current
    refocus.current = 0
    if (!dir) return
    const first = dir < 0 ? beforeRef.current : afterRef.current
    const target = first || (dir < 0 ? afterRef.current : beforeRef.current)
    if (target && typeof target.focus === 'function') target.focus()
  }, [index])
  const move = (dir) => {
    refocus.current = hadFocus(dir < 0 ? beforeRef : afterRef) ? dir : 0
    if (dir < 0) onMoveBefore()
    else onMoveAfter()
  }
  return (
    <View style={[styles.thumbWrap, canMove && styles.thumbWrapWide]}>
      {/* The X stays on the 80 image. The wider wrap is only for the arrows. */}
      <View style={styles.thumbFrame}>
        <View style={styles.thumb} accessible accessibilityRole='image' accessibilityLabel={cover ? label + ', capa' : label}>
          {item.thumb
            ? <Image source={{ uri: item.thumb }} style={styles.thumbImg} resizeMode='cover' />
            : <View style={[styles.thumbImg, styles.thumbEmpty]}><Icon name='image' size={20} color={colors.soft} /></View>}
          {showBar
            ? (
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: Math.round(item.progress * 100) + '%' }]} />
              </View>
              )
            : null}
          {cover
            ? <Text style={styles.capa} accessibilityElementsHidden importantForAccessibility='no'>capa</Text>
            : null}
        </View>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={'remover ' + label}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onRemove}
          hitSlop={6}
          style={styles.remove}
        >
          <Icon name='x' size={14} color='#ffffff' />
        </Pressable>
      </View>
      {canMove
        ? (
          <View style={styles.moveRow}>
            {index > 0
              ? (
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel={'mover ' + label + ' para antes'}
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={() => move(-1)}
                  ref={beforeRef}
                  style={styles.move}
                >
                  <Icon name='chevron-left' size={18} color={colors.soft} />
                </Pressable>
                )
              : null}
            {index < count - 1
              ? (
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel={'mover ' + label + ' para depois'}
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={() => move(1)}
                  ref={afterRef}
                  style={[styles.move, styles.moveAfter]}
                >
                  <Icon name='chevron-right' size={18} color={colors.soft} />
                </Pressable>
                )
              : null}
          </View>
          )
        : null}
      {failed
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel={label + ': falhou, tentar de novo'} disabled={busy} onPress={onRetry} hitSlop={4}>
            <Text style={styles.thumbError}>falhou · tentar de novo</Text>
          </Pressable>
          )
        : null}
      {invalid ? <Text style={styles.thumbError} numberOfLines={2}>{item.error || 'falhou'}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 10, paddingLeft: 68, paddingRight: 16 },
  thumbWrap: { width: 80, gap: 4 },
  thumbWrapWide: { width: 88 },
  thumbFrame: { width: 80 },
  capa: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    paddingHorizontal: 4,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.55)',
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 14
  },
  moveRow: { flexDirection: 'row' },
  move: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  // On the cover there is no "antes" arrow; "depois" keeps its right-hand place.
  moveAfter: { marginLeft: 'auto' },
  thumb: { width: 80, height: 80, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.skeleton },
  thumbImg: { ...StyleSheet.absoluteFillObject },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  bar: { position: 'absolute', left: 6, right: 6, bottom: 6, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.6)', overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: colors.accent },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)'
  },
  thumbError: { fontSize: 12, lineHeight: 15, color: colors.danger },
  momentBody: { gap: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, alignItems: 'flex-start' },
  momentPhoto: { width: 160, height: 200, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.skeleton },
  momentMusicChip: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  momentInput: { ...type.compose, alignSelf: 'stretch', color: colors.ink, minHeight: MOMENT_MIN_HEIGHT, maxHeight: MOMENT_MAX_HEIGHT, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.card },
  momentCounter: { alignSelf: 'flex-end', marginTop: -4 },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  linkAsk: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginLeft: 60, paddingHorizontal: 8, borderRadius: 22 },
  linkAskText: { ...type.replyMark, color: colors.accent, fontWeight: '600' },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, minWidth: 44, paddingHorizontal: 8, borderRadius: 22, justifyContent: 'center' },
  toolOff: { opacity: 0.45 },
  toolPressed: { backgroundColor: colors.accentSoft },
  count: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  retryRow: { flexDirection: 'row', marginTop: 8 },
  asRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  asLabel: { ...type.replyMark, color: colors.soft },
  chip: { minHeight: 36, maxWidth: 200, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: colors.soft },
  chipTextOn: { color: colors.accent },
  markRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 4
  },
  mark: { ...type.replyMark, color: colors.soft, flexShrink: 1 },
  markName: { color: colors.accent, fontWeight: '600' },
  markCancel: { ...type.replyMark, color: colors.soft },
  quote: { fontSize: 14, lineHeight: 20, color: colors.soft, paddingHorizontal: 16 },
  quoteCard: {
    marginTop: 8,
    marginHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    gap: 2
  },
  quoteCardName: { ...type.postName, color: colors.ink, paddingHorizontal: 16 },
  compose: { flexDirection: 'row', gap: 12, paddingTop: 10, paddingHorizontal: 16 },
  // minWidth 0 so a long name ellipsizes instead of widening the row on native.
  composeBody: { flex: 1, minWidth: 0 },
  author: { paddingTop: 2 },
  authorName: { ...type.postName, color: colors.ink },
  authorMeta: { ...type.postMeta, color: colors.soft },
  // Bare text on the sheet (no box); on the web the caret shows focus, so the
  // browser outline is dropped. No flex: inside the author column a basis-0
  // flex would pin the field at minHeight instead of growing with the draft.
  input: {
    ...type.compose,
    color: colors.ink,
    minHeight: 120,
    paddingTop: 8,
    borderWidth: 0,
    backgroundColor: 'transparent',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null)
  },
  counterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
    // The tools pad their own 8, so icons and counter both sit 16 from the edges.
    paddingLeft: 8,
    paddingRight: 16
  },
  counter: { ...type.counter, color: colors.soft },
  counterWarn: { color: colors.warn },
  counterFull: { color: colors.danger },
  errors: { paddingHorizontal: 16, gap: 4 },
  ring: { width: 20, height: 20 },
  track: { ...StyleSheet.absoluteFillObject, borderRadius: 10, borderWidth: 2.5, borderColor: colors.ring },
  half: { position: 'absolute', top: 0, width: 10, height: 20, overflow: 'hidden' },
  halfRight: { left: 10 },
  halfLeft: { left: 0 },
  arc: {
    position: 'absolute',
    top: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2.5,
    borderTopColor: colors.accent,
    borderRightColor: colors.accent,
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent'
  },
  arcInRight: { left: -10 },
  arcInLeft: { left: 0 }
})
