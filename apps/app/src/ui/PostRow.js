// One line of a timeline (no card). It receives the RAW peer strings (author
// key, name, username, at, text, replyToName, each reply preview's name and
// text, the quote's and the reposter's names) and applies displayText itself
// (the parent chip through replyChip, which escapes on its own), so callers
// must not pre-escape them.
// Naming follows whoOf (src/who.js): never a key-derived handle.
//
// Props (the shared contract):
// - author, name, username, at, text, replyToName, media, now: the post.
//   `text` null or '' is not rendered (a repost item's text is null; a post
//   with photos may have no text). `media` (descriptors or null) goes to
//   ./MediaGrid with `persist={persistMedia}` (false for authors this device
//   does not follow: their photos are never kept).
// - expanded: shows the full caption without a clamp control (default false).
// - preview: null | a stored link card (the post's `preview`), drawn by
//   ./LinkCard from that data only, its thumbnail read like a post photo. A
//   card whose URL carries an Audius music ref uses ./PostMusic (a sticker
//   that plays a track or snippet by itself while seen, or ./MusicPlayerCard
//   for a playlist or with the Ajustes switch off); other allowlisted music
//   links (embedOf) use ./MusicEmbedCard. A link only in the text never gets
//   a player.
// - replyPreviews: optional [{ key, name, text }], not the link card above.
//   Under the action bar, 'Respostas' and one line per preview ('Nome:
//   texto'), at most two with text. Absent or empty renders nothing. Raw
//   peer strings go through displayText here.
// - quote: null | { author, name, username, at, text, media, missing, onOpen }
//   rendered by ./QuoteCard (one level only).
// - repostedBy: null | { author, name, username }: a top line 'Nome
//   republicou' (pressable -> onOpenReposter). onFollowReposter, when also
//   given, is a small 'seguir' on that line (disabled while followPending).
//   It follows the reposter; the head's onFollow follows the author.
// - counts: null | { replies, likes, reposts, quotes }: the numbers show only
//   when it is an object (and the number is above 0).
// - liked, reposted: the own state; pending: null | 'like' | 'repost' (that
//   button is disabled while its request runs).
// - onOpen (the text, the time ('abrir conversa') and the empty body area;
//   the photos keep their own viewer taps),
//   onOpenAuthor (avatar and name), onOpenParent (the reply chip; plain text
//   when absent), onOpenPreviews (one button for replyPreviews; plain text
//   when absent), onOpenReposter, and the action bar: onReply, onRepost,
//   onQuote, onLike,
//   onFollow ('seguir', disabled while followPending), onReport, onDelete.
//   The bar is reply, repost, like and share; follow and 'mais' sit at the head.
//   The repost button opens
//   a small sheet (Republicar, and Citar with onQuote); report and delete live
//   in the 'mais' sheet next to Copiar link, each only with its handler.
// - onMessage(author, { context }), with the post's `seq`: 'Mensagem em
//   particular' in the 'mais' sheet, only on a hosted node. The caller passes
//   it only for someone else's post that is not a page (rowProps,
//   socialRowProps); the context is the post as shown, never sent by itself.
// - link: a public http(s) URL of the post (postActions.shareLink decides);
//   without one there is no Compartilhar. onNotice(text) shows the toast of
//   a copy to the clipboard.
// - publishable: the member's own diary post, so 'Página pública na web' may
//   open the publish sheet (only the own diary's writer accepts a post-share).
// - onOpenMention(username): makes the @nome in the text and in the quote
//   tappable (./MentionText). The post text with an http(s)/www link or a
//   handled mention is rendered outside the body's single accessible element,
//   so the link is reachable by assistive tech and a tap on it opens the
//   browser or the profile, never the conversation. A quote is lifted out only
//   for a handled mention; its web links stay plain (./QuoteCard).

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { displayText } from '@varanda/rpc'
import { doubleTapPlan, pendingOpen, tapKind } from '../doubleTap'
import { compactTime, formatCount, relativeTime } from '../format'
import { hasLink, textWithoutHrefs } from '../links'
import { embedOf, sameMusicPage } from '../musicEmbed'
import { musicRefOf } from '../music'
import { moreActions, repostActions, shareLink } from '../postActions'
import { usePostPublic } from '../postPublicContext'
import { useBlocks } from '../blocksProvider'
import { blockedRowView } from '../memberBlocks'
import { canShare, copyText, shareUrl } from '../share'
import { shareNav } from '../shareNav'
import { replyChip } from '../threadRows'
import { whoOf } from '../who'
import { ActionsSheet } from './ActionsSheet'
import { Avatar } from './Avatar'
import { ClampControl, useClamp } from './ClampText'
import { Icon } from './Icon'
import { LinkCard } from './LinkCard'
import { MusicEmbedCard } from './MusicEmbedCard'
import PostMusic from './PostMusic'
import { MediaGrid } from './MediaGrid'
import { tap } from './haptics'
import { hasMention, MentionText } from './MentionText'
import { useHosted } from '../node'
import { QuoteCard, quotePlayerOf } from './QuoteCard'
import { screenReaderOn } from './screenReader'
import { LARGE_TEXT, layout, radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const ICON = 20
// A split toggle and its number never share touch area: a mis-tap on the
// toggle writes a public signed record.
const SPLIT_SLOP = { top: 6, bottom: 6, left: 6, right: 0 }
const COUNT_SLOP = { top: 6, bottom: 6, left: 0, right: 6 }
// 'seguir' at the counter size plus its padding, until it is measured.
const FOLLOW_GUESS = 64
// (44 - 20) / 2: the 44 pt targets centre on the 20 pt name line, so a post
// with only ⋯ is no taller than its text.
const HEAD_LIFT = 12

const fn = (f) => (typeof f === 'function' ? f : undefined)

// The number of a count field when counts are known, else null.
function countOf (counts, field) {
  if (!counts || typeof counts !== 'object') return null
  const n = counts[field]
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

// formatCount returns null for a value that is not a count. displayText(null)
// would paint the word "null", so that result stays off the row.
function countLabel (n) {
  const shown = formatCount(n)
  return shown === null ? null : displayText(shown)
}

// multiline so a line break stays a space after the collapse, not U+FFFD.
function oneLine (value) {
  if (typeof value !== 'string') return ''
  return displayText(value, { multiline: true }).replace(/\s+/g, ' ').trim()
}

// Peer text stays escaped. A bad entry is not a preview.
function replyPreviewLines (replyPreviews) {
  if (!Array.isArray(replyPreviews)) return []
  const lines = []
  for (const entry of replyPreviews) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const text = oneLine(entry.text)
    if (text === '') continue
    lines.push({
      key: typeof entry.key === 'string' && entry.key !== '' ? entry.key : 'p' + lines.length,
      name: oneLine(entry.name),
      text
    })
  }
  return lines.slice(0, 2)
}

function previewLineText (line) {
  return line.name !== '' ? line.name + ': ' + line.text : line.text
}

const NATIVE_DRIVER = Platform.OS !== 'web'
const BURST_MS = 600

// Read once for the module, not per row mount: a feed mounts many rows and
// each query is a bridge call. The listener keeps a changed setting current.
let reduceMotionOn = false
try {
  Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((reduce) => { reduceMotionOn = reduce === true }, () => {})
  AccessibilityInfo.addEventListener('reduceMotionChanged', (reduce) => { reduceMotionOn = reduce === true })
} catch {}

// The pop when a toggle turns on: the scale is owned by the row, so the icon
// keeps it when the bar swaps between its split and plain layouts (the first
// like gives the count that brings the split in).
function pop (scale) {
  scale.setValue(1)
  Animated.sequence([
    Animated.spring(scale, { toValue: 1.35, speed: 40, bounciness: 0, useNativeDriver: NATIVE_DRIVER }),
    Animated.spring(scale, { toValue: 1, friction: 4, useNativeDriver: NATIVE_DRIVER })
  ]).start()
}

function Bump ({ scale, children }) {
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>
}

function Action ({ label, onPress, disabled, on, count, split, children }) {
  const styles = useStyles(makeStyles)
  const shown = countLabel(count)
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!on }}
      disabled={disabled}
      hitSlop={split ? SPLIT_SLOP : 6}
      onPress={onPress}
      style={({ pressed }) => [styles.action, split && styles.actionSplit, disabled && styles.disabled, pressed && styles.pressed]}
    >
      {children}
      {shown !== null
        ? <Text style={[styles.count, on && styles.countOn]}>{shown}</Text>
        : null}
    </Pressable>
  )
}

function PostRowView ({
  author, name, username, avatar, at, text, replyToName, replyPreviews, media, preview, persistMedia = true, now,
  quote, repostedBy, counts, liked, reposted, pending, expanded = false,
  onOpen, onOpenAuthor, onOpenParent, onOpenPreviews, onOpenReposter, onFollowReposter, onOpenMention,
  onReply, onQuote, onLike, onRepost, onOpenLikes, onOpenReposts, onFollow, followPending, onReport, onBlock, onDelete, link, onNotice,
  seq, onMessage, publishable
}) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const likes = countOf(counts, 'likes')
  const reposts = countOf(counts, 'reposts')
  const likeText = countLabel(likes)
  const repostText = countLabel(reposts)
  const hasMedia = Array.isArray(media) && media.length > 0
  const embed = preview && typeof preview === 'object' ? embedOf(preview.url) : null
  const music = preview && typeof preview === 'object' ? musicRefOf(preview.url) : null
  const ownLink = !hasMedia && music === null && embed !== null
  // The card already shows this link, so its raw address is hidden from the shown text only.
  const body = useMemo(() => (ownLink && typeof text === 'string' ? textWithoutHrefs(text, (href) => sameMusicPage(href, preview.url)) : text), [ownLink, text, preview])
  const hasText = typeof body === 'string' && body !== ''
  // The body label, the plain text and the label without the text all use it.
  const shownText = useMemo(() => (hasText ? displayText(body, { multiline: true }) : null), [hasText, body])
  const [captionWidth, setCaptionWidth] = useState(undefined)
  const [headActionsSize, setHeadActionsSize] = useState({ width: 0, height: 0 })
  // Measure the targets so larger text reserves its actual space in the head.
  const measureHeadActions = (event) => {
    const { width, height } = event.nativeEvent.layout
    setHeadActionsSize((prev) => prev.width === width && prev.height === height ? prev : { width, height })
  }
  const { numberOfLines, control, onTextLayout, toggle } = useClamp({
    text: shownText,
    hasMedia,
    width: captionWidth,
    forceExpanded: expanded
  })
  const measureCaption = (event) => {
    const width = event.nativeEvent.layout.width
    setCaptionWidth(Number.isFinite(width) && width > 0 ? width : undefined)
  }
  // compactTime has no word for under a minute or a clock ahead of ours;
  // relativeTime says 'agora' or the date there, never the raw timestamp.
  const time = compactTime(at, now) ?? relativeTime(at, now) ?? displayText(at)
  // Read aloud as words: "3 h" or "5 nov", never "3h".
  const spokenTime = relativeTime(at, now) ?? displayText(at)
  const who = whoOf({ name, username })
  const title = displayText(who.title)
  // At large text there is no room for the @nome beside the name and the
  // date: iOS shrank it to a clipped sliver ("( · 5 nov"), so it is left out.
  // Android's 1.3 step arrives as 1.2999999523 (a 32-bit float), so the
  // threshold sits just under it.
  const { fontScale } = useWindowDimensions()
  const handle = who.subtitle && !(fontScale >= LARGE_TEXT) ? displayText(who.subtitle) : null
  const open = fn(onOpen)
  const like = fn(onLike)
  const heartScale = useRef(new Animated.Value(1)).current
  const repostScale = useRef(new Animated.Value(1)).current
  const burstScale = useRef(new Animated.Value(0.6)).current
  const burstOpacity = useRef(new Animated.Value(0)).current
  const [burstOn, setBurstOn] = useState(false)
  const [sheet, setSheet] = useState(null)
  const rowId = useRef({}).current
  const previousTap = useRef(null)
  useEffect(() => () => pendingOpen.cancelOwn(rowId), [])
  const cancelPendingOpen = () => {
    pendingOpen.cancel()
    previousTap.current = null
  }
  const otherPress = (handler) => fn(handler) && ((...args) => {
    cancelPendingOpen()
    return handler(...args)
  })
  // Touch start also sees links and photos whose press handlers belong to
  // children. Only a subsequent body press can complete the double tap.
  const startTouch = () => {
    const prev = pendingOpen.armedAt(rowId)
    cancelPendingOpen()
    previousTap.current = prev
  }
  const feedback = (scale) => {
    tap('light')
    if (!reduceMotionOn) pop(scale)
  }
  const pressLike = otherPress(like && (() => {
    if (pending === 'like') return
    if (!liked) feedback(heartScale)
    return like()
  }))
  const doRepost = () => {
    if (pending === 'repost') return
    if (!reposted) feedback(repostScale)
    return onRepost()
  }
  // With a quote handler the button asks Republicar or Citar; without one
  // it keeps toggling the repost at once.
  const pressRepost = otherPress(fn(onRepost) && (fn(onQuote) ? () => setSheet('repost') : doRepost))
  // A screen reader hears that the button opens a choice, not a direct toggle.
  const repostLabel = (reposted ? 'desfazer republicação' : 'republicar') + (fn(onQuote) ? ' ou citar' : '')
  const href = shareLink(null, { link })
  const pressShare = otherPress(href !== null && (async () => {
    // Capability, not platform: the system sheet when the runtime has one,
    // else the clipboard and a note.
    const nav = shareNav()
    if (canShare(nav)) {
      await shareUrl(nav, { url: href, title: 'Varanda' })
      return
    }
    const ok = await copyText(nav, href)
    if (fn(onNotice)) onNotice(ok ? 'Link copiado' : 'Não foi possível copiar o link')
  }))
  // The hosted flag alone: the full node value is rebuilt on every sync flag.
  const hosted = useHosted()
  const messageable = fn(onMessage) && hosted === true && Number.isSafeInteger(seq) && seq > 0
  const postPublic = usePostPublic()
  const publicRow = publishable === true && postPublic.enabled === true && fn(postPublic.open) && Number.isSafeInteger(seq) && seq > 0
  const moreRows = [
    ...(messageable ? [{ id: 'message', icon: 'mensagem', label: 'Mensagem em particular' }] : []),
    ...moreActions(null, { link, onReport: fn(onReport) ? true : null, onBlock: fn(onBlock) ? true : null }),
    ...(publicRow ? [{ id: 'public', icon: 'link', label: 'Página pública na web' }] : []),
    ...(fn(onDelete) ? [{ id: 'delete', icon: 'lixeira', label: 'Apagar', danger: true }] : [])
  ]
  const runMore = (row) => {
    if (row.id === 'copy') {
      return async () => {
        const ok = await copyText(shareNav(), href)
        if (fn(onNotice)) onNotice(ok ? 'Link copiado' : 'Não foi possível copiar o link')
      }
    }
    if (row.id === 'message') return () => onMessage(author, { context: { author, seq, at, text, hasMedia } })
    if (row.id === 'public') return () => postPublic.open(String(author).toLowerCase() + ':' + seq)
    if (row.id === 'report') return onReport
    if (row.id === 'block') return onBlock
    if (row.id === 'delete') return onDelete
    return undefined
  }
  const moreSheet = moreRows.map((row) => ({ icon: row.icon, label: row.label, danger: row.danger, onPress: runMore(row) }))
  const repostSheet = repostActions(null, { link }).filter((row) => row.id !== 'repost' || fn(onRepost)).map((row) => ({
    icon: row.icon,
    label: row.id === 'repost' && reposted ? 'Desfazer republicação' : row.label,
    onPress: row.id === 'repost' ? doRepost : fn(onQuote)
  }))
  const hasMore = moreSheet.length > 0
  const headActions = !!fn(onFollow) || hasMore
  // Until the targets report their size, reserve what they usually take, so a
  // row never paints them over the name for a frame.
  const headReserve = headActionsSize.width > 0 ? headActionsSize : { width: (fn(onFollow) ? FOLLOW_GUESS : 0) + (hasMore ? layout.hit : 0), height: layout.hit }
  // At large text the date cannot shrink and would run under the targets on a
  // narrow screen, so the name keeps the first line and the date moves below.
  const stackHead = headActions && fontScale >= LARGE_TEXT
  const longPress = () => {
    if (!hasMore || screenReaderOn()) return
    cancelPendingOpen()
    tap('light')
    setSheet('more')
  }
  const bodyLongPress = hasMore && !screenReaderOn() ? longPress : undefined
  const burst = () => {
    if (reduceMotionOn) return
    burstScale.setValue(0.6)
    burstOpacity.setValue(0)
    setBurstOn(true)
    Animated.parallel([
      Animated.timing(burstScale, { toValue: 1.2, duration: BURST_MS, useNativeDriver: NATIVE_DRIVER }),
      Animated.sequence([
        Animated.timing(burstOpacity, { toValue: 1, duration: BURST_MS / 3, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(burstOpacity, { toValue: 0, duration: (BURST_MS * 2) / 3, useNativeDriver: NATIVE_DRIVER })
      ])
    ]).start(() => setBurstOn(false))
  }
  // Web double clicks select text and must never publish a signed like.
  const doubleTap = open && like && Platform.OS !== 'web'
  const openTap = doubleTap
    ? () => {
        const now = Date.now()
        const kind = tapKind(previousTap.current, now)
        cancelPendingOpen()
        if (screenReaderOn()) {
          open()
          return
        }
        if (kind === 'double') {
          // Never unlikes, and never doubles a like already on its way.
          const plan = doubleTapPlan({ liked, pending })
          if (plan.like) pressLike()
          if (plan.burst) burst()
          return
        }
        pendingOpen.arm(open, rowId, now)
      }
    : otherPress(onOpen)
  // Screen reader activation opens at once and never likes (the heart is its
  // like control). iOS VoiceOver activates through onAccessibilityTap; without
  // it the activation becomes a synthetic touch through openTap, and two quick
  // activations would publish a like. TalkBack uses the 'activate' action.
  const openNow = () => {
    cancelPendingOpen()
    open()
  }
  const a11yOpen = doubleTap
    ? {
        onAccessibilityTap: openNow,
        accessibilityActions: [{ name: 'activate' }],
        onAccessibilityAction: (event) => {
          if (event.nativeEvent.actionName === 'activate') openNow()
        }
      }
    : null
  const openAuthor = otherPress(onOpenAuthor)
  const openParent = otherPress(onOpenParent)
  const openPreviews = otherPress(onOpenPreviews)
  const reposter = repostedBy && typeof repostedBy === 'object' ? repostedBy : null
  const reposterName = reposter ? displayText(whoOf({ name: reposter.name, username: reposter.username }).title) : ''
  const openReposter = otherPress(onOpenReposter)
  // On the reposter's line, never the author's head: that 'seguir' follows the
  // original's author, and under their name it would read as the wrong person.
  const followReposter = reposter ? otherPress(onFollowReposter) : undefined
  const bar = fn(onReply) || fn(onRepost) || fn(onQuote) || fn(onLike) || href !== null
  // Composed label for the post body element: author, reply-to, text, date.
  // The avatar link already provides profile access, so name here is context.
  const bodyParts = [
    title,
    replyToName !== null ? ('respondendo a ' + displayText(replyToName)) : null,
    shownText,
    spokenTime
  ].filter(Boolean)
  const bodyLabel = bodyParts.join('. ')
  const replyLabel = replyToName ? replyChip({ name: replyToName }) : ''
  const previewLines = replyPreviewLines(replyPreviews)
  const previewsLabel = 'Respostas. ' + previewLines.map(previewLineText).join('. ')
  const openMention = otherPress(onOpenMention)
  const quoteOn = quote && typeof quote === 'object'
  const textOut = hasText && numberOfLines === 0 && (hasLink(body) || (!!openMention && hasMention(body)))
  // The screen gives a quote its own handler carrying the quoted author.
  const quoteMention = (quoteOn && otherPress(quote.onOpenMention)) || openMention
  const quoteOut = quoteOn && ((typeof quote.text === 'string' && !!quoteMention && hasMention(quote.text)) || quotePlayerOf(quote) !== null)
  const quoteProp = quoteOn ? { ...quote, onOpen: otherPress(quote.onOpen), onOpenMention: quoteMention } : quote
  const label = textOut ? bodyParts.filter((part) => part !== shownText).join('. ') : bodyLabel
  const textNode = hasText
    ? textOut
      ? <MentionText text={body} onOpenMention={openMention} onOpenPlain={openTap} onLongPress={bodyLongPress} onTextLayout={onTextLayout} style={styles.text} />
      : (
        <Pressable
          accessibilityRole={open ? 'link' : 'text'}
          accessibilityHint={open ? 'abre a conversa' : undefined}
          disabled={!open && !bodyLongPress}
          onPress={openTap}
          onLongPress={bodyLongPress}
          delayLongPress={350}
          {...a11yOpen}
        >
          <Text style={styles.text} numberOfLines={numberOfLines} onTextLayout={onTextLayout}>{shownText}</Text>
        </Pressable>
        )
    : null
  const mediaNode = hasMedia ? <MediaGrid author={author} media={media} persist={persistMedia !== false} /> : null
  const quoteNode = quoteOn ? <QuoteCard quote={quoteProp} now={now} /> : null
  // Outside the row's open area: a tap on the card opens the link, never the conversation.
  const previewNode = !hasMedia && preview && typeof preview === 'object'
    ? music !== null
      ? <PostMusic card={preview} music={music} />
      : embed !== null
        ? <MusicEmbedCard embed={embed} card={preview} thumb={{ kind: 'post', author, persist: persistMedia !== false }} />
        : <LinkCard card={preview} thumb={{ kind: 'post', author, persist: persistMedia !== false }} />
    : null
  const previewsBody = previewLines.length === 0
    ? null
    : (
      <>
        <Text style={styles.previewsLabel}>Respostas</Text>
        {previewLines.map((line, index) => (
          <Text key={index + ':' + line.key} style={styles.previewLine} numberOfLines={1}>{previewLineText(line)}</Text>
        ))}
      </>
      )
  return (
    <View style={styles.row} onTouchStart={Platform.OS !== 'web' ? startTouch : undefined}>
      {reposter
        ? (
          <View style={styles.reposted}>
            <Pressable
              accessibilityRole={openReposter ? 'link' : 'text'}
              accessibilityLabel={reposterName + ' republicou'}
              disabled={!openReposter}
              onPress={openReposter}
              hitSlop={4}
              style={({ pressed }) => [styles.repostedLink, pressed && openReposter && styles.pressed]}
            >
              <Icon name='republicar' size={14} color={colors.soft} />
              <Text style={styles.repostedText} numberOfLines={1}>{reposterName + ' republicou'}</Text>
            </Pressable>
            {followReposter
              ? (
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel={'seguir ' + reposterName}
                  accessibilityState={{ disabled: !!followPending }}
                  disabled={!!followPending}
                  onPress={followReposter}
                  hitSlop={6}
                  style={({ pressed }) => [styles.repostedFollow, followPending && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.repostedFollowText}>seguir</Text>
                </Pressable>
                )
              : null}
          </View>
          )
        : null}
      <View style={styles.main}>
        <Pressable
          accessibilityRole='link'
          accessibilityLabel={'ver o perfil de ' + title}
          disabled={!openAuthor}
          onPress={openAuthor}
          style={({ pressed }) => pressed && openAuthor && styles.pressed}
        >
          <Avatar name={who.avatarName} publicKey={author} size={40} picture={avatar} persist={persistMedia !== false} />
        </Pressable>
        {/* Body: a single accessible element (author, text, date) so screen
            readers read in the order: avatar → post content → actions.
            All visual children are hidden from accessibility; sighted users
            interact with them directly (name, reply-to and text tap targets). */}
        <View style={styles.body} onLayout={measureCaption}>
          <Pressable
            onPress={openTap}
            onLongPress={bodyLongPress}
            delayLongPress={350}
            disabled={!open && !bodyLongPress}
            accessible
            accessibilityRole={open ? 'link' : 'text'}
            accessibilityLabel={label}
            accessibilityHint={open ? 'abre a conversa' : undefined}
            {...a11yOpen}
          >
            <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
              <View style={[styles.head, stackHead && styles.headStacked, headActions && !stackHead && { paddingRight: headReserve.width }, headActions && !stackHead && fn(onFollow) && { minHeight: headReserve.height - HEAD_LIFT }]}>
                <Pressable
                  accessibilityRole='link'
                  accessibilityLabel={'ver o perfil de ' + title}
                  disabled={!openAuthor}
                  onPress={openAuthor}
                  onLongPress={bodyLongPress}
                  delayLongPress={350}
                  style={({ pressed }) => [styles.nameBox, handle && styles.nameBeside, stackHead && { width: '100%', paddingRight: headReserve.width, minHeight: headReserve.height, justifyContent: 'center' }, pressed && openAuthor && styles.pressed]}
                >
                  <Text style={styles.name} numberOfLines={1}>{title}</Text>
                </Pressable>
                {handle
                  ? (
                    <Pressable
                      accessible={false}
                      disabled={!open}
                      onPress={openTap}
                      onLongPress={bodyLongPress}
                      delayLongPress={350}
                      hitSlop={4}
                      style={({ pressed }) => [styles.metaBox, pressed && open && styles.pressed]}
                    >
                      <Text style={styles.handle} numberOfLines={1}>{handle}</Text>
                    </Pressable>
                    )
                  : null}
                <Pressable
                  accessibilityRole={open ? 'link' : 'text'}
                  accessibilityLabel={open ? 'abrir conversa' : undefined}
                  disabled={!open}
                  onPress={openTap}
                  onLongPress={bodyLongPress}
                  delayLongPress={350}
                  {...a11yOpen}
                  hitSlop={4}
                  style={({ pressed }) => [styles.timeBox, pressed && open && styles.pressed]}
                >
                  <Text style={styles.time} numberOfLines={1}>{(handle ? '\u00a0· ' : stackHead ? '' : '· ') + time}</Text>
                </Pressable>
              </View>
              {replyToName
                ? openParent
                  ? (
                    <Pressable
                      accessibilityRole='link'
                      accessibilityLabel={replyLabel}
                      onPress={openParent}
                      onLongPress={bodyLongPress}
                      delayLongPress={350}
                      style={({ pressed }) => [styles.replyChip, pressed && styles.pressed]}
                    >
                      <Text style={styles.replyChipText} numberOfLines={1}>{replyLabel}</Text>
                    </Pressable>
                    )
                  : <Text style={styles.replyChipText} numberOfLines={1}>{replyLabel}</Text>
                : null}
              {mediaNode}
              {textOut ? null : textNode}
            </View>
          </Pressable>
          {textOut ? textNode : null}
          <ClampControl control={control} onPress={otherPress(toggle)} />
          {quoteNode && !quoteOut
            ? (
              <Pressable accessible={false} tabIndex={-1} onPress={openTap} disabled={!open}>
                <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
                  {quoteNode}
                </View>
              </Pressable>
              )
            : null}
          {previewNode}
          {quoteOut ? quoteNode : null}
          {/* After the content, so a screen reader reads the caption before
              them; the position is absolute, so they still draw at the top. */}
          {headActions
            ? (
              <View style={[styles.headActions, !stackHead && { top: -HEAD_LIFT }]} onLayout={measureHeadActions}>
                {fn(onFollow)
                  ? (
                    <Pressable
                      accessibilityRole='button'
                      accessibilityLabel={'seguir ' + title}
                      accessibilityState={{ disabled: !!followPending }}
                      disabled={!!followPending}
                      onPress={otherPress(onFollow)}
                      style={({ pressed }) => [styles.follow, followPending && styles.disabled, pressed && styles.pressed]}
                    >
                      <View style={styles.followFace}><Text style={styles.followText}>seguir</Text></View>
                    </Pressable>
                    )
                  : null}
                {hasMore
                  ? (
                    <Action label='mais ações' onPress={otherPress(() => setSheet('more'))}>
                      <Icon name='mais' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
              </View>
              )
            : null}
          {bar
            ? (
              <View style={styles.bar}>
                {fn(onReply)
                  ? (
                    <Action label={'responder a ' + title} onPress={otherPress(onReply)} count={countOf(counts, 'replies')}>
                      <Icon name='resposta' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onRepost)
                  ? fn(onOpenReposts) && reposts !== null
                    ? (
                      <View style={styles.splitAction}>
                        <Action
                          label={repostLabel}
                          onPress={pressRepost}
                          disabled={pending === 'repost'}
                          on={!!reposted}
                          count={null}
                          split
                        >
                          <Bump scale={repostScale}><Icon name='republicar' size={ICON} color={reposted ? colors.accent : colors.soft} /></Bump>
                        </Action>
                        <Pressable
                          accessibilityRole='button'
                          accessibilityLabel={'ver quem republicou, ' + reposts}
                          hitSlop={COUNT_SLOP}
                          onPress={otherPress(onOpenReposts)}
                          style={styles.countAction}
                        >
                          {repostText !== null
                            ? <Text style={[styles.count, reposted && styles.countOn]}>{repostText}</Text>
                            : null}
                        </Pressable>
                      </View>
                      )
                    : (
                      <Action
                        label={repostLabel}
                        onPress={pressRepost}
                        disabled={pending === 'repost'}
                        on={!!reposted}
                        count={reposts}
                      >
                        <Bump scale={repostScale}><Icon name='republicar' size={ICON} color={reposted ? colors.accent : colors.soft} /></Bump>
                      </Action>
                      )
                  // Without reposting (offline, a node that is not hosted) the same
                  // button opens the sheet with Citar alone, so quoting never
                  // disappears and the row keeps one look.
                  : fn(onQuote)
                    ? (
                      <Action label='citar' onPress={otherPress(() => setSheet('repost'))} count={null}>
                        <Icon name='republicar' size={ICON} color={colors.soft} />
                      </Action>
                      )
                    : null}
                {fn(onLike)
                  ? fn(onOpenLikes) && likes !== null
                    ? (
                      <View style={styles.splitAction}>
                        <Action
                          label={liked ? 'descurtir' : 'curtir'}
                          onPress={pressLike}
                          disabled={pending === 'like'}
                          on={!!liked}
                          count={null}
                          split
                        >
                          <Bump scale={heartScale}><Icon name='coracao' filled={!!liked} size={ICON} color={liked ? colors.accent : colors.soft} /></Bump>
                        </Action>
                        <Pressable
                          accessibilityRole='button'
                          accessibilityLabel={'ver quem curtiu, ' + likes}
                          hitSlop={COUNT_SLOP}
                          onPress={otherPress(onOpenLikes)}
                          style={styles.countAction}
                        >
                          {likeText !== null
                            ? <Text style={[styles.count, liked && styles.countOn]}>{likeText}</Text>
                            : null}
                        </Pressable>
                      </View>
                      )
                    : (
                      <Action
                        label={liked ? 'descurtir' : 'curtir'}
                        onPress={pressLike}
                        disabled={pending === 'like'}
                        on={!!liked}
                        count={likes}
                      >
                        <Bump scale={heartScale}><Icon name='coracao' filled={!!liked} size={ICON} color={liked ? colors.accent : colors.soft} /></Bump>
                      </Action>
                      )
                  : null}
                {href !== null
                  ? (
                    <Action label='compartilhar' onPress={pressShare}>
                      <Icon name='compartilhar' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
              </View>
              )
            : null}
          {previewLines.length > 0
            ? openPreviews
              ? (
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel={previewsLabel}
                  onPress={openPreviews}
                  style={({ pressed }) => [styles.previews, pressed && styles.pressed]}
                >
                  {/* The label already names every preview, so the lines are not their own controls. */}
                  <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
                    {previewsBody}
                  </View>
                </Pressable>
                )
              : <View style={styles.previews}>{previewsBody}</View>
            : null}
          <ActionsSheet open={sheet === 'repost'} onClose={() => setSheet(null)} actions={repostSheet} />
          <ActionsSheet open={sheet === 'more'} onClose={() => setSheet(null)} actions={moreSheet} />
          {burstOn
            ? (
              <Animated.View
                pointerEvents='none'
                accessibilityElementsHidden
                importantForAccessibility='no-hide-descendants'
                style={[styles.burst, { opacity: burstOpacity, transform: [{ scale: burstScale }] }]}
              >
                <Icon name='coracao' filled size={64} color={colors.accent} />
              </Animated.View>
              )
            : null}
        </View>
      </View>
    </View>
  )
}

// Default shallow comparison: the screens keep each row's props stable while
// what it shows did not change (socialRowProps with a row cache).
// The block gate in front of every timeline: the node already leaves a blocked
// author out of each read, and this clears rows that are already on screen.
// Bloquear goes where Denunciar goes, so a row that can be reported can be
// blocked and the two rules stay one.
function BlockGate (props) {
  const blocks = useBlocks()
  const view = blockedRowView(props, blocks.has)
  if (view === null) return null
  const onBlock = blocks.available && typeof props.onReport === 'function'
    ? () => blocks.ask({ author: props.author, name: props.name, username: props.username })
    : undefined
  return <PostRowView {...props} quote={view.quote} onBlock={onBlock} />
}

export const PostRow = memo(BlockGate)

const makeStyles = (colors) => StyleSheet.create({
  row: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  reposted: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 26, marginBottom: 4, maxWidth: '100%' },
  repostedLink: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  repostedText: { ...type.replyMark, color: colors.soft, fontWeight: '600', flexShrink: 1 },
  repostedFollow: { flexShrink: 0, minHeight: 28, justifyContent: 'center', paddingHorizontal: 2 },
  repostedFollowText: { ...type.counter, color: colors.accent },
  main: { flexDirection: 'row', gap: 12 },
  body: { flex: 1, minWidth: 0 },
  // No gap: the name keeps 6 pt on its right and the time starts with a
  // no-break space (web drops a plain leading space under numberOfLines), so
  // the "·" has one space on each side.
  head: { flexDirection: 'row', alignItems: 'baseline' },
  headStacked: { flexWrap: 'wrap' },
  headActions: { position: 'absolute', top: 0, right: 0, flexDirection: 'row', alignItems: 'center' },
  follow: { minHeight: layout.hit, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  followFace: { minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.accentSoft, justifyContent: 'center' },
  followText: { ...type.counter, color: colors.accent },
  // The @nome gives way first and the date never does (as on X): one Text for
  // both cut the date to "· 5…", or dropped it at large text.
  nameBox: { flexShrink: 1, marginRight: 6 },
  // Shrink weights: Yoga and CSS share an overflow by basis x flexShrink. The
  // handle (10000 against the name's 1) takes all but a thousandth of a pixel,
  // so a name that fits is never cut. The name keeps flexShrink 1: CSS shares
  // only part of the overflow when the factors left sum to less than 1, so a
  // smaller one would push the date out once the handle is at its floor. The handle stops at 32 pt ("@jo…", never a clipped sliver);
  // past that the name gives way, so the date always fits, even a 320 pt
  // screen with "· 31 dez 2025".
  nameBeside: { flexShrink: 1 },
  name: { ...type.postName, color: colors.ink },
  // The time sits outside the shrinking box: a box that shrinks can go below
  // a child's width in Yoga, so a non-shrinking time inside it still clipped.
  metaBox: { flexShrink: 10000, minWidth: 32 },
  timeBox: { flexShrink: 0 },
  handle: { ...type.meta, color: colors.soft, flexShrink: 1 },
  time: { ...type.meta, color: colors.soft, flexShrink: 0 },
  // Web ignores hitSlop, so the invisible box itself is the 44 pt target.
  // Negative margin pulls that target in: the line costs about 32 pt.
  replyChip: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: layout.hit,
    minWidth: layout.hit,
    marginVertical: -6,
    justifyContent: 'center'
  },
  replyChipText: { ...type.meta, color: colors.soft, flexShrink: 1 },
  previews: { marginTop: 8, minHeight: layout.hit, justifyContent: 'center' },
  previewsLabel: { ...type.replyMark, color: colors.soft, fontWeight: '700' },
  previewLine: { ...type.replyMark, color: colors.ink },
  text: { ...type.postText, color: colors.ink, marginTop: 3 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 0, marginBottom: -4, marginLeft: -8, maxWidth: 360 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: layout.hit, minWidth: 44, paddingHorizontal: 8 },
  // A split pair is as wide as the combined button (8 + icon + gap + digits +
  // 8), so the bar still fits a 320 pt screen.
  actionSplit: { gap: 0, minWidth: 0, paddingRight: 2 },
  splitAction: { flexDirection: 'row', alignItems: 'center' },
  countAction: { minHeight: layout.hit, paddingLeft: 3, paddingRight: 8, justifyContent: 'center' },
  count: { ...type.counter, color: colors.soft },
  countOn: { color: colors.accent },
  burst: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.6 }
})
