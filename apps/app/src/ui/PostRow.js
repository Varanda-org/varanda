// One line of a timeline (no card). It receives the RAW peer strings (author
// key, name, username, at, text, replyToName, the quote's and the reposter's
// names) and applies displayText itself, so callers must not pre-escape them.
// Naming follows whoOf (src/who.js): never a key-derived handle.
//
// Props (the shared contract):
// - author, name, username, at, text, replyToName, media, now: the post.
//   `text` null or '' is not rendered (a repost item's text is null; a post
//   with photos may have no text). `media` (descriptors or null) goes to
//   ./MediaGrid with `persist={persistMedia}` (false for authors this device
//   does not follow: their photos are never kept).
// - quote: null | { author, name, username, at, text, media, missing, onOpen }
//   rendered by ./QuoteCard (one level only).
// - repostedBy: null | { author, name, username }: a top line 'Nome
//   republicou' (pressable -> onOpenReposter).
// - counts: null | { replies, likes, reposts, quotes }: the numbers show only
//   when it is an object (and the number is above 0).
// - liked, reposted: the own state; pending: null | 'like' | 'repost' (that
//   button is disabled while its request runs).
// - onOpen (the text, the time ('abrir conversa') and the empty body area;
//   the photos keep their own viewer taps),
//   onOpenAuthor (avatar and name), onOpenParent ('respondendo a X'),
//   onOpenReposter, and the action bar: onReply, onRepost, onQuote, onLike,
//   onReport (each button shows only with its handler).

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { MediaGrid } from './MediaGrid'
import { QuoteCard } from './QuoteCard'
import { colors, type } from './theme'

const ICON = 18

const fn = (f) => (typeof f === 'function' ? f : undefined)

// The number of a count field when counts are known, else null.
function countOf (counts, field) {
  if (!counts || typeof counts !== 'object') return null
  const n = counts[field]
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

// A filled heart: the Feather outline with a solid glyph inside (Feather has
// outline glyphs only). The text-presentation selector keeps it from turning
// into a coloured emoji.
function Heart ({ filled, color }) {
  if (!filled) return <Icon name='coracao' size={ICON} color={color} />
  return (
    <View style={styles.heart}>
      <Text style={[styles.heartFill, { color }]} accessible={false}>♥︎</Text>
      <Icon name='coracao' size={ICON} color={color} style={styles.heartLine} />
    </View>
  )
}

function Action ({ label, onPress, disabled, on, count, children }) {
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!on }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}
    >
      {children}
      {count !== null && count !== undefined
        ? <Text style={[styles.count, on && styles.countOn]}>{displayText(String(count))}</Text>
        : null}
    </Pressable>
  )
}

export function PostRow ({
  author, name, username, at, text, replyToName, media, persistMedia = true, now,
  quote, repostedBy, counts, liked, reposted, pending,
  onOpen, onOpenAuthor, onOpenParent, onOpenReposter,
  onReply, onQuote, onLike, onRepost, onReport
}) {
  const hasMedia = Array.isArray(media) && media.length > 0
  const hasText = typeof text === 'string' && text !== ''
  const time = relativeTime(at, now) ?? displayText(at)
  const who = whoOf({ name, username })
  const title = displayText(who.title)
  const meta = who.subtitle ? displayText(who.subtitle) + ' · ' + time : time
  const open = fn(onOpen)
  const openAuthor = fn(onOpenAuthor)
  const openParent = fn(onOpenParent)
  const reposter = repostedBy && typeof repostedBy === 'object' ? repostedBy : null
  const reposterName = reposter ? displayText(whoOf({ name: reposter.name, username: reposter.username }).title) : ''
  const openReposter = fn(onOpenReposter)
  const bar = fn(onReply) || fn(onRepost) || fn(onQuote) || fn(onLike) || fn(onReport)
  return (
    <View style={styles.row}>
      {reposter
        ? (
          <Pressable
            accessibilityRole={openReposter ? 'link' : 'text'}
            accessibilityLabel={reposterName + ' republicou'}
            disabled={!openReposter}
            onPress={openReposter}
            hitSlop={4}
            style={({ pressed }) => [styles.reposted, pressed && openReposter && styles.pressed]}
          >
            <Icon name='republicar' size={14} color={colors.soft} />
            <Text style={styles.repostedText} numberOfLines={1}>{reposterName + ' republicou'}</Text>
          </Pressable>
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
          <Avatar name={who.avatarName} publicKey={author} size={44} />
        </Pressable>
        {/* The empty area of the body opens the conversation too (photo-only
            posts have no text); the inner links, the photos and the buttons
            keep their own taps. Not a focus stop: the time is the
            accessible 'abrir conversa' link. */}
        <Pressable style={styles.body} onPress={open} disabled={!open} accessible={false} focusable={false}>
          <View style={styles.head}>
            <Pressable
              accessibilityRole='link'
              accessibilityLabel={'ver o perfil de ' + title}
              disabled={!openAuthor}
              onPress={openAuthor}
              style={({ pressed }) => [styles.nameBox, pressed && openAuthor && styles.pressed]}
            >
              <Text style={styles.name} numberOfLines={1}>{title}</Text>
            </Pressable>
            <Pressable
              accessibilityRole={open ? 'link' : 'text'}
              accessibilityLabel={open ? 'abrir conversa' : undefined}
              disabled={!open}
              onPress={open}
              hitSlop={4}
              style={({ pressed }) => [styles.metaBox, pressed && open && styles.pressed]}
            >
              <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
            </Pressable>
          </View>
          {replyToName
            ? (
              <Pressable
                accessibilityRole={openParent ? 'link' : 'text'}
                disabled={!openParent}
                onPress={openParent}
                hitSlop={4}
                style={({ pressed }) => pressed && openParent && styles.pressed}
              >
                <Text style={styles.reply}>
                  respondendo a <Text style={styles.replyName}>{displayText(replyToName)}</Text>
                </Text>
              </Pressable>
              )
            : null}
          {hasText
            ? (
              <Pressable
                accessibilityRole={open ? 'link' : 'text'}
                accessibilityHint={open ? 'abre a conversa' : undefined}
                disabled={!open}
                onPress={open}
              >
                <Text style={styles.text}>{displayText(text, { multiline: true })}</Text>
              </Pressable>
              )
            : null}
          {hasMedia ? <MediaGrid author={author} media={media} persist={persistMedia !== false} /> : null}
          {quote && typeof quote === 'object' ? <QuoteCard quote={quote} now={now} /> : null}
          {bar
            ? (
              <View style={styles.bar}>
                {fn(onReply)
                  ? (
                    <Action label='responder' onPress={onReply} count={countOf(counts, 'replies')}>
                      <Icon name='resposta' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onRepost)
                  ? (
                    <Action
                      label={reposted ? 'desfazer republicação' : 'republicar'}
                      onPress={onRepost}
                      disabled={pending === 'repost'}
                      on={!!reposted}
                      count={countOf(counts, 'reposts')}
                    >
                      <Icon name='republicar' size={ICON} color={reposted ? colors.accent : colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onQuote)
                  ? (
                    <Action label='citar' onPress={onQuote} count={countOf(counts, 'quotes')}>
                      <Icon name='citar' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onLike)
                  ? (
                    <Action
                      label={liked ? 'descurtir' : 'curtir'}
                      onPress={onLike}
                      disabled={pending === 'like'}
                      on={!!liked}
                      count={countOf(counts, 'likes')}
                    >
                      <Heart filled={!!liked} color={liked ? colors.accent : colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onReport)
                  ? (
                    <Action label='denunciar' onPress={onReport}>
                      <Icon name='bandeira' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
              </View>
              )
            : null}
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  reposted: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 26, marginBottom: 4, alignSelf: 'flex-start' },
  repostedText: { ...type.replyMark, color: colors.soft, fontWeight: '600', flexShrink: 1 },
  main: { flexDirection: 'row', gap: 12 },
  body: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  nameBox: { flexShrink: 1 },
  name: { ...type.postName, color: colors.ink },
  metaBox: { flexShrink: 1 },
  meta: { ...type.postMeta, color: colors.soft },
  reply: { ...type.replyMark, color: colors.soft, marginTop: 1 },
  replyName: { color: colors.accent, fontWeight: '600' },
  text: { ...type.postText, color: colors.ink, marginTop: 3 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginLeft: -8, maxWidth: 360 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36, minWidth: 44, paddingHorizontal: 8 },
  count: { ...type.counter, color: colors.soft },
  countOn: { color: colors.accent },
  heart: { width: ICON, height: ICON, alignItems: 'center', justifyContent: 'center' },
  heartFill: { position: 'absolute', fontSize: ICON - 2, lineHeight: ICON, textAlign: 'center' },
  heartLine: { position: 'absolute' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.6 }
})
