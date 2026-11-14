// The quoted post inside a PostRow: a bordered card with a mini avatar, the
// name, @nome and time, up to 6 lines of text and the photos (./MediaGrid).
// `quote` = { author, name, username, at, text, media, missing, onOpen } with
// RAW peer strings (displayText is applied here); optional `persist` (true
// only for own or followed authors; absent = the photos are never cached)
// and `hasQuote` (the quoted post itself quotes another one: shown as the
// line 'cita outra publicação', never a second card). `missing` shows 'Publicação indisponível'; a quote with
// neither text nor photos and not missing is still loading. The whole card
// opens the quoted post (`quote.onOpen`); the photos keep their own taps.
// `quote.onOpenMention(username)`, when a function and the text has an @nome,
// makes the mentions tappable (./MentionText); the card is then not one
// accessible group, so the links stay reachable, and a mention tap never
// calls `quote.onOpen`. Web links in a quote stay plain: the 6 line clamp can
// cut a URL, so the card opens the quoted post, where its links work.
// `quote.preview`, a stored link card of the quoted post (never with photos),
// is drawn by ./LinkCard from that stored data only, or, for a YouTube,
// SoundCloud, Spotify or Apple Music link, by ./MusicEmbedCard, which loads
// the provider player while the card is visible; the quote text then hides
// that card's own link.

import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { compactTime, relativeTime } from '../format'
import { embedOf, sameMusicPage } from '../musicEmbed'
import { textWithoutHrefs } from '../links'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { MediaGrid } from './MediaGrid'
import { LinkCard } from './LinkCard'
import { MusicEmbedCard } from './MusicEmbedCard'
import { hasMention, MentionText } from './MentionText'
import { LARGE_TEXT, type } from './theme'
import { useStyles } from './ThemeProvider'

// The @nome truncates first; the time keeps its own Text and never shrinks.
// Spacing matches PostRow: 6 after the name, and a no-break space before the
// "·" (web drops a plain leading space under numberOfLines).
function Meta ({ handle, time, styles }) {
  if (!handle && !time) return null
  return (
    <>
      {handle ? <Text style={styles.meta} numberOfLines={1}>{handle}</Text> : null}
      {time ? <Text style={styles.time} numberOfLines={1}>{(handle ? '\u00a0· ' : '· ') + time}</Text> : null}
    </>
  )
}

export function quotePlayerOf (quote) {
  const q = quote && typeof quote === 'object' ? quote : {}
  const missing = q.missing === true
  const hasMedia = Array.isArray(q.media) && q.media.length > 0
  return !missing && !hasMedia && q.preview && typeof q.preview === 'object' && typeof q.author === 'string' ? embedOf(q.preview.url) : null
}

export function QuoteCard ({ quote, now }) {
  const styles = useStyles(makeStyles)
  const q = quote && typeof quote === 'object' ? quote : {}
  const open = typeof q.onOpen === 'function' ? q.onOpen : undefined
  const missing = q.missing === true
  const hasText = typeof q.text === 'string' && q.text !== ''
  const hasMedia = Array.isArray(q.media) && q.media.length > 0
  const embed = quotePlayerOf(q)
  const shownText = embed !== null && hasText ? textWithoutHrefs(q.text, (href) => sameMusicPage(href, q.preview.url)) : q.text
  const preview = !missing && !hasMedia && q.preview && typeof q.preview === 'object' && typeof q.author === 'string'
    ? embed !== null
      ? <MusicEmbedCard embed={embed} card={q.preview} thumb={{ kind: 'post', author: q.author, persist: q.persist === true }} />
      : <LinkCard card={q.preview} thumb={{ kind: 'post', author: q.author, persist: q.persist === true }} />
    : null
  const loading = !missing && !hasText && !hasMedia
  const who = whoOf({ name: q.name, username: q.username })
  const title = displayText(who.title)
  // Same date as the post row: compact under a week, the date after.
  const time = typeof q.at === 'string' ? (compactTime(q.at, now) ?? relativeTime(q.at, now) ?? displayText(q.at)) : null
  // At large text the @nome is left out, as in PostRow.
  const { fontScale } = useWindowDimensions()
  const handle = who.subtitle && !(fontScale >= LARGE_TEXT) ? displayText(who.subtitle) : null
  const openMention = typeof q.onOpenMention === 'function' ? q.onOpenMention : undefined
  const label = missing ? 'Publicação indisponível' : 'publicação citada de ' + title
  const mentioned = !missing && openMention && hasText && shownText !== '' && hasMention(shownText)
  if (embed !== null || mentioned) {
    return (
      <View style={styles.card}>
        <Pressable
          accessibilityRole={open ? 'link' : 'text'}
          accessibilityLabel={label}
          disabled={!open}
          onPress={open}
          style={({ pressed }) => [styles.head, pressed && open && styles.pressed]}
        >
          {typeof q.author === 'string' ? <View style={styles.avatarBox}><Avatar name={who.avatarName} publicKey={q.author} size={20} picture={q.avatar} persist={q.persist === true} /></View> : null}
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          <Meta handle={handle} time={time} styles={styles} />
        </Pressable>
        {loading ? <View style={styles.skeleton} accessible={false} /> : null}
        {hasText && shownText !== ''
          ? mentioned
            ? <MentionText text={shownText} onOpenMention={openMention} onOpenPlain={open} style={styles.text} numberOfLines={6} />
            : <Text onPress={open} style={styles.text} numberOfLines={6}>{displayText(shownText, { multiline: true })}</Text>
          : null}
        {preview}
        {hasMedia || q.hasQuote === true
          ? (
            <Pressable accessible={false} tabIndex={-1} disabled={!open} onPress={open}>
              {hasMedia
                ? <View style={styles.media}><MediaGrid author={q.author} media={q.media} persist={q.persist === true} mosaic /></View>
                : null}
              {q.hasQuote === true ? <Text style={styles.soft}>cita outra publicação</Text> : null}
            </Pressable>
            )
          : null}
      </View>
    )
  }
  return (
    <Pressable
      accessibilityRole={open ? 'link' : 'text'}
      accessibilityLabel={label}
      disabled={!open}
      onPress={open}
      style={({ pressed }) => [styles.card, pressed && open && styles.pressed]}
    >
      {missing
        ? <Text style={styles.soft}>Publicação indisponível</Text>
        : (
          <>
            <View style={styles.head}>
              {typeof q.author === 'string' ? <View style={styles.avatarBox}><Avatar name={who.avatarName} publicKey={q.author} size={20} picture={q.avatar} persist={q.persist === true} /></View> : null}
              <Text style={styles.name} numberOfLines={1}>{title}</Text>
              <Meta handle={handle} time={time} styles={styles} />
            </View>
            {loading ? <View style={styles.skeleton} accessible={false} /> : null}
            {hasText && shownText !== ''
              ? <Text style={styles.text} numberOfLines={6}>{displayText(shownText, { multiline: true })}</Text>
              : null}
            {hasMedia
              ? <View style={styles.media}><MediaGrid author={q.author} media={q.media} persist={q.persist === true} mosaic /></View>
              : null}
            {preview}
            {q.hasQuote === true ? <Text style={styles.soft}>cita outra publicação</Text> : null}
          </>
          )}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    borderRadius: 12,
    gap: 4
  },
  head: { flexDirection: 'row', alignItems: 'center' },
  avatarBox: { marginRight: 6 },
  // As in PostRow: the handle gives way first and stops at 32, then the name.
  name: { ...type.postName, fontSize: 14, color: colors.ink, flexShrink: 1, marginRight: 6 },
  meta: { ...type.meta, color: colors.soft, flexShrink: 10000, minWidth: 32 },
  time: { ...type.meta, color: colors.soft, flexShrink: 0 },
  text: { ...type.postText, fontSize: 14.5, lineHeight: 20, color: colors.ink },
  media: { marginTop: 2 },
  soft: { ...type.replyMark, color: colors.soft },
  skeleton: { height: 12, width: '70%', borderRadius: 6, backgroundColor: colors.skeleton },
  pressed: { opacity: 0.6 }
})
