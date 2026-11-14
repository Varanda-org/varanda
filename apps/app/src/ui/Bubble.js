// One chat message as a bubble, for private chats and groups alike. Own
// bubbles sit on the right in the accent tint, the others on the left on the
// card. Consecutive bubbles of one sender form a run (dm-screen.js
// bubbleShape: 'single' | 'first' | 'middle' | 'last'): their facing corners
// tighten, the sender's name (groups) shows
// on the first one only and the avatar (groups) beside the last one only.
// The time sits small inside the bubble at its bottom right, on the last
// bubble of a run only; "Enviada" joins it, on any bubble, only while an own
// message is pending or uncertain. No read, delivered
// or typing state, ever.
//
// A long press opens the ActionsSheet with `actions`; so does the chevron that
// shows on hover or keyboard focus (web); screen readers get the same actions
// as accessibility actions. A tap does nothing by surprise: only
// a link (or, with onOpenMention, an @nome) in the text reacts, plus a
// spoiler and a code block's own buttons.
//
// Props:
//   item: { key, text, rawText, at, hidden, deleted, dayMark }. rawText (the
//     sender's own text) goes through MentionText, which escapes it, or
//     through RichText when it has style markers (../richText.js); without
//     a rawText string, or when hidden or deleted, `text` is drawn plain
//     (italic and soft when hidden or deleted). Both go through displayText.
//   mine, shape = 'single', now = Date.now()
//   name: the raw sender name for the name line (others only), senderKey:
//     the hex key that picks its colour (ReplyPreview senderColor)
//   avatar: a node drawn beside the last bubble of a run (others only); the
//     other rows of the run keep its width so the bubbles line up
//   quote: { name, text, senderKey, mine, onPress } or null
//   status: 'pending' | 'uncertain' for an own message not yet confirmed
//   actions: [{ icon, label, danger, onPress }], actionsTitle
//   onOpenMention(username), below: a node under the bubble (a Pill)
//   media: a node drawn inside the bubble above the text (ChatMedia); the
//     text is then the caption and may be empty
//   forwarded: true for a message sent with fwd 1 (forward.js): a small
//     "Encaminhada" line with the encaminhar icon at the top. Nothing ever
//     names who wrote the original.
//   item.card: a stored link card (dm.thread / group.read `card`), drawn by
//     ./LinkCard under the text from that data only; cardThumb says where
//     its thumbnail is read ({ kind: 'group', diary, identity }, or
//     { kind: 'dm', from, id, identity }, read as index 'card'). When the text
//     has a spoiler, the card shows only for a link outside every spoiler.
//     A YouTube, SoundCloud, Spotify or Apple Music card shows the provider
//     player while visible (./MusicEmbedCard), and the shown text hides only
//     that card's own link; copy, forward, reply and quote keep the raw text.
//   plainCard: true in a message request, where nothing downloads by
//     itself: the card stays a plain LinkCard and the text keeps its link.

import { cloneElement, isValidElement, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { displayText } from '@varanda/rpc'
import { LABELS } from '../dm'
import { showsMeta } from '../dm-screen'
import { isMomentReaction, reactionLabel } from '../momentReaction'
import { FORWARDED_LABEL } from '../forward'
import { textWithoutHrefs } from '../links'
import { embedOf, sameMusicPage } from '../musicEmbed'
import { hasRich, parseRich } from '../richText'
import { ActionsSheet, usableActions } from './ActionsSheet'
import { chatMediaBlock } from './ChatMedia'
import { Icon } from './Icon'
import { LinkCard } from './LinkCard'
import { MentionText } from './MentionText'
import { MomentReactionPreview } from './MomentReactionPreview'
import { MusicEmbedCard } from './MusicEmbedCard'
import { ReplyPreview, senderColor } from './ReplyPreview'
import { RichText, cardBesideSpoilers } from './RichText'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export { senderColor }

const AVATAR = 32
const JOINED = 4

// -> 'HH:MM' in local time, or '' for a missing or invalid instant. The day
// itself is the day chip's job.
export function bubbleTime (at) {
  if (typeof at !== 'string' && typeof at !== 'number') return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n) => (n < 10 ? '0' : '') + n
  return two(d.getHours()) + ':' + two(d.getMinutes())
}

// -> what the bubble's corner shows: the time, prefixed by "Enviada" while an
// own message waits for its answer or came back uncertain.
export function bubbleMeta ({ at, mine, status }) {
  const time = bubbleTime(at)
  if (mine && (status === 'pending' || status === 'uncertain')) return time ? LABELS.sent + ' · ' + time : LABELS.sent
  return time
}

// The photos sit this close to the bubble's edge.
const MEDIA_INSET = 4

export function Bubble ({ item, mine = false, shape = 'single', name, handle, senderKey, avatar, quote, status, actions, actionsTitle, actionsHeader, onOpenMention, below, media, moment, forwarded, cardThumb, plainCard }) {
  const styles = useStyles(makeStyles)
  const { colors, scheme } = useTheme()
  const { width: screen } = useWindowDimensions()
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const rows = usableActions(actions)
  const hasAbove = shape === 'middle' || shape === 'last'
  const hasBelow = shape === 'first' || shape === 'middle'
  const last = !hasBelow
  const side = mine ? 'Right' : 'Left'
  const corners = {}
  if (hasAbove) corners['borderTop' + side + 'Radius'] = JOINED
  if (hasBelow) corners['borderBottom' + side + 'Radius'] = JOINED
  const fill = mine ? colors.bubbleMine : colors.card
  const muted = item.hidden === true || item.deleted === true
  const momentReaction = !muted && moment && isMomentReaction({ ...item, moment: moment.seq })
  const rich = !muted && typeof item.rawText === 'string'
  const meta = bubbleMeta({ at: item.at, mine, status })
  const showMeta = showsMeta({ meta, shape, mine, status })
  const shownName = !mine && !hasAbove && typeof name === 'string' ? displayText(name).trim() : ''
  const nameKey = typeof senderKey === 'string' ? senderKey : ''
  const withAvatar = !mine && avatar !== undefined && avatar !== null
  const openQuote = quote && typeof quote.onPress === 'function' ? quote.onPress : undefined
  const withMedia = media !== undefined && media !== null && !muted
  // With photos the bubble is as wide as the block (styles.media leaves
  // MEDIA_INSET on each side, plus the hairline border of theirs), so the
  // caption wraps under the photos.
  const block = withMedia && isValidElement(media) ? chatMediaBlock(media.props.refs, screen) : null
  const hug = block ? { width: block.width + 2 * MEDIA_INSET + (mine ? 0 : 2 * StyleSheet.hairlineWidth) } : null
  const empty = rich ? item.rawText === '' : typeof item.text !== 'string' || item.text === ''
  // Markers in the raw text: RichText draws it, with its code blocks as Views
  // beside its paragraphs, since a View cannot sit inside a Text.
  const styled = rich && !empty && hasRich(item.rawText)
  // Parsed once here, for the card check and for RichText.
  const blocks = useMemo(() => (styled ? parseRich(item.rawText) : null), [styled, item.rawText])
  const card = !muted && item.card && typeof item.card === 'object' ? cardBesideSpoilers(blocks, item.card) : null
  // Only the stored card's link picks a player, never a link in the text.
  const embed = card !== null && plainCard !== true ? embedOf(card.url) : null
  // The player stands for its own link, so the text drops that link; a
  // styled message keeps its text as RichText draws it.
  const shown = rich && !styled && embed !== null ? textWithoutHrefs(item.rawText, (href) => sameMusicPage(href, card.url)) : item.rawText
  const shownEmpty = rich ? shown === '' : empty
  // A momento reaction draws its emoji in its own block; the plain path then
  // keeps only the time spacer.
  const body = (withMedia || embed !== null) && shownEmpty
    ? null
    : momentReaction
      ? null
      : rich
        ? <MentionText text={shown} onOpenMention={onOpenMention} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} style={styles.text} />
        : <Text style={[styles.text, muted && styles.muted]}>{displayText(typeof item.text === 'string' ? item.text : '', { multiline: true })}</Text>
  const spacer = showMeta && !card ? <Text style={[styles.metaSpace, { color: fill }]}>{'   ' + meta}</Text> : null
  return (
    <View>
      {item.dayMark
        ? <View style={styles.dayRow}><Text style={styles.dayText} accessibilityRole='header'>{displayText(item.dayMark)}</Text></View>
        : null}
      <View style={[styles.row, mine && styles.rowMine, hasAbove ? styles.rowJoinedTop : styles.rowTop]}>
        {withAvatar
          ? <View style={styles.avatar}>{last ? avatar : null}</View>
          : null}
        <View style={[styles.column, mine && styles.columnMine]}>
          {/* On the web the column's children size to their content, and a
              code block's sideways scroll or a long link counts its longest
              line there, so without this cap the bubble ran past the column
              and the screen. Photo and voice bubbles keep their own width. */}
          <View style={hug ? null : styles.stack}>
            <Pressable
              accessibilityRole={rows.length > 0 ? 'button' : undefined}
              accessibilityHint={rows.length > 0 ? 'toque longo para ações' : undefined}
              accessibilityActions={rows.map((a, i) => ({ name: 'a' + i, label: a.label }))}
              onAccessibilityAction={(e) => {
                const at = e && e.nativeEvent ? Number(String(e.nativeEvent.actionName).slice(1)) : -1
                if (rows[at]) rows[at].onPress()
              }}
              onLongPress={rows.length > 0 ? () => setOpen(true) : undefined}
              onHoverIn={rows.length > 0 ? () => setHover(true) : undefined}
              onHoverOut={rows.length > 0 ? () => setHover(false) : undefined}
              delayLongPress={350}
              style={[styles.bubble, { backgroundColor: fill }, !mine && styles.bubbleTheirs, corners, hug]}
            >
              {/* The verified @nome rides beside the free-form name, so a member who
                  copies someone else's display name still shows their own handle. */}
              {shownName
                ? (
                  <Text style={[styles.name, { color: senderColor(nameKey, scheme) }]} numberOfLines={1}>
                    {shownName}
                    {typeof handle === 'string' && handle !== '' ? <Text style={styles.handle}>{' ' + displayText(handle)}</Text> : null}
                  </Text>
                  )
                : null}
              {forwarded === true && !muted
                ? (
                  <View style={styles.forwarded} accessibilityLabel={FORWARDED_LABEL}>
                    <Icon name='encaminhar' size={12} color={colors.soft} />
                    <Text style={styles.forwardedText} numberOfLines={1}>{FORWARDED_LABEL}</Text>
                  </View>
                  )
                : null}
              {quote
                ? (
                  <View style={[styles.quote, rows.length > 0 && styles.quoteWithChevron]}>
                    <ReplyPreview name={quote.name} handle={quote.handle} text={quote.text} senderKey={quote.senderKey} mine={quote.mine} onPress={openQuote} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} />
                  </View>
                  )
                : null}
              {/* The media's own presses would swallow the long press: it gets
                  the bubble's, so holding a photo opens the actions too. */}
              {withMedia
                ? <View style={styles.media}>{isValidElement(media) && rows.length > 0 ? cloneElement(media, { onLongPress: () => setOpen(true) }) : media}</View>
                : null}
              {momentReaction
                ? (
                  <View style={styles.moment}>
                    <Text style={styles.momentLabel}>{reactionLabel(mine)}</Text>
                    <MomentReactionPreview author={moment.author} seq={moment.seq} identity={moment.identity} folder={moment.folder} />
                    <Text style={styles.momentEmoji}>{displayText(item.rawText)}</Text>
                  </View>
                  )
                : null}
              {/* The hidden copy of the time keeps the last line clear for the
                  real one, which floats at the bottom right as in WhatsApp. It is
                  painted in the bubble's own fill: Android ignores a transparent
                  color on a nested Text and would draw the time twice. */}
              {styled
                ? <RichText text={item.rawText} onOpenMention={onOpenMention} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} style={styles.text} trailer={spacer} blocks={blocks} />
                : body !== null || spacer !== null
                  ? (
                    <Text style={styles.text}>
                      {body}
                      {spacer}
                    </Text>
                    )
                  : null}
              {card
                ? (
                  <View style={[styles.cardBox, showMeta && styles.cardWithMeta]}>
                    {embed !== null
                      ? <MusicEmbedCard embed={embed} card={card} thumb={cardThumb} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} />
                      : <LinkCard card={card} thumb={cardThumb} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} />}
                  </View>
                  )
                : null}
              {showMeta
                ? <Text style={styles.meta} accessibilityElementsHidden importantForAccessibility='no'>{meta}</Text>
                : null}
            </Pressable>
            {/* The pointer and keyboard path to the actions (a long press is
                touch only). Hidden until the bubble is hovered or the control
                has focus, and it takes no touches while hidden, so a tap on a
                phone never lands on an invisible button. */}
            {rows.length > 0
              ? (
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel='ações da mensagem'
                  onPress={() => setOpen(true)}
                  onHoverIn={() => setHover(true)}
                  onHoverOut={() => setHover(false)}
                  onFocus={() => setFocus(true)}
                  onBlur={() => setFocus(false)}
                  hitSlop={10}
                  pointerEvents={hover || focus ? 'auto' : 'none'}
                  style={[styles.chevron, !(hover || focus) && styles.chevronHidden]}
                >
                  <Icon name='chevron-down' size={18} color={colors.soft} />
                </Pressable>
                )
              : null}
          </View>
          {below || null}
        </View>
      </View>
      {rows.length > 0
        ? <ActionsSheet open={open} onClose={() => setOpen(false)} title={actionsTitle} actions={rows} header={actionsHeader} />
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  dayRow: { alignItems: 'center', paddingVertical: space.sm },
  dayText: { ...type.meta, color: colors.soft, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: space.md, gap: space.xs + 2 },
  rowMine: { justifyContent: 'flex-end' },
  rowTop: { paddingTop: space.sm - 2 },
  rowJoinedTop: { paddingTop: 2 },
  avatar: { width: AVATAR, alignSelf: 'flex-end' },
  column: { maxWidth: '80%', alignItems: 'flex-start', gap: space.xs },
  columnMine: { alignItems: 'flex-end' },
  stack: { maxWidth: '100%' },
  bubble: {
    borderRadius: radius.bubble,
    paddingHorizontal: space.md,
    paddingTop: 7,
    paddingBottom: 7,
    minWidth: 64
  },
  bubbleTheirs: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  name: { ...type.counter, marginBottom: 2 },
  handle: { fontWeight: '400', color: colors.soft },
  quote: { marginBottom: space.xs + 2 },
  // The hover chevron sits in the top right corner; the quote keeps clear of it.
  quoteWithChevron: { paddingRight: layout.hit - 16 },
  forwarded: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: 2 },
  forwardedText: { fontSize: 12, lineHeight: 16, fontStyle: 'italic', color: colors.soft },
  media: { marginHorizontal: -(space.md - MEDIA_INSET), marginTop: -3 },
  text: { fontSize: 16, lineHeight: 22, color: colors.ink },
  moment: { gap: space.xs },
  momentLabel: { ...type.caption, color: colors.soft },
  momentEmoji: { ...type.heroTitle, color: colors.ink },
  muted: { color: colors.soft, fontStyle: 'italic' },
  // The card ends the bubble, so the time gets its own line under it.
  cardBox: { width: 260, maxWidth: '100%' },
  cardWithMeta: { paddingBottom: 16 },
  metaSpace: { fontSize: 11, lineHeight: 22, color: 'transparent' },
  meta: { position: 'absolute', right: space.md - 2, bottom: 5, fontSize: 11, lineHeight: 14, color: colors.soft },
  chevron: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: layout.hit - 20,
    height: layout.hit - 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.card
  },
  chevronHidden: { opacity: 0 }
})
