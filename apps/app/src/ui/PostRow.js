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
//   republicou' (pressable -> onOpenReposter). onFollowReposter, when also
//   given, is a small 'seguir' on that line (disabled while followPending).
//   It follows the reposter; the action bar's onFollow follows the author.
// - counts: null | { replies, likes, reposts, quotes }: the numbers show only
//   when it is an object (and the number is above 0).
// - liked, reposted: the own state; pending: null | 'like' | 'repost' (that
//   button is disabled while its request runs).
// - onOpen (the text, the time ('abrir conversa') and the empty body area;
//   the photos keep their own viewer taps),
//   onOpenAuthor (avatar and name), onOpenParent ('respondendo a X'),
//   onOpenReposter, and the action bar: onReply, onRepost, onQuote, onLike,
//   onFollow ('seguir', disabled while followPending), onReport (each button
//   shows only with its handler).
// - onOpenMention(username): makes the @nome in the text and in the quote
//   tappable (./MentionText). A text or quote with a mention is rendered
//   outside the body's single accessible element, so the link is reachable by
//   assistive tech and a tap on it never opens the conversation.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { MediaGrid } from './MediaGrid'
import { hasMention, MentionText } from './MentionText'
import { QuoteCard } from './QuoteCard'
import { colors, type } from './theme'

const ICON = 18
// A split toggle and its number never share touch area: a mis-tap on the
// toggle writes a public signed record.
const SPLIT_SLOP = { top: 6, bottom: 6, left: 6, right: 0 }
const COUNT_SLOP = { top: 6, bottom: 6, left: 0, right: 6 }

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

function Action ({ label, onPress, disabled, on, count, split, children }) {
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
      {count !== null && count !== undefined
        ? <Text style={[styles.count, on && styles.countOn]}>{displayText(String(count))}</Text>
        : null}
    </Pressable>
  )
}

export function PostRow ({
  author, name, username, avatar, at, text, replyToName, media, persistMedia = true, now,
  quote, repostedBy, counts, liked, reposted, pending,
  onOpen, onOpenAuthor, onOpenParent, onOpenReposter, onFollowReposter, onOpenMention,
  onReply, onQuote, onLike, onRepost, onOpenLikes, onOpenReposts, onFollow, followPending, onReport
}) {
  const likes = countOf(counts, 'likes')
  const reposts = countOf(counts, 'reposts')
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
  // On the reposter's line, never the action bar: that 'seguir' follows the
  // original's author, and under their name it would read as the wrong person.
  const followReposter = reposter ? fn(onFollowReposter) : undefined
  const bar = fn(onReply) || fn(onRepost) || fn(onQuote) || fn(onLike) || fn(onFollow) || fn(onReport)
  // Composed label for the post body element: author, reply-to, text, date.
  // The avatar link already provides profile access, so name here is context.
  const bodyParts = [
    title,
    replyToName !== null ? ('respondendo a ' + displayText(replyToName)) : null,
    hasText ? displayText(text, { multiline: true }) : null,
    time
  ].filter(Boolean)
  const bodyLabel = bodyParts.join('. ')
  const openMention = fn(onOpenMention)
  const quoteOn = quote && typeof quote === 'object'
  const textOut = !!openMention && hasText && hasMention(text)
  // The screen gives a quote its own handler carrying the quoted author.
  const quoteMention = (quoteOn && fn(quote.onOpenMention)) || openMention
  const quoteOut = !!quoteMention && quoteOn && typeof quote.text === 'string' && hasMention(quote.text)
  const quoteProp = quoteMention && quoteOn ? { ...quote, onOpenMention: quoteMention } : quote
  const label = textOut ? bodyParts.filter((part) => part !== displayText(text, { multiline: true })).join('. ') : bodyLabel
  const textNode = hasText
    ? textOut
      ? <MentionText text={text} onOpenMention={openMention} onOpenPlain={open} style={styles.text} />
      : (
        <Pressable
          accessibilityRole={open ? 'link' : 'text'}
          accessibilityHint={open ? 'abre a conversa' : undefined}
          disabled={!open}
          onPress={open}
        >
          <Text style={styles.text}>{displayText(text, { multiline: true })}</Text>
        </Pressable>
        )
    : null
  const mediaNode = hasMedia ? <MediaGrid author={author} media={media} persist={persistMedia !== false} /> : null
  const quoteNode = quoteOn ? <QuoteCard quote={quoteProp} now={now} /> : null
  return (
    <View style={styles.row}>
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
          <Avatar name={who.avatarName} publicKey={author} size={44} picture={avatar} persist={persistMedia !== false} />
        </Pressable>
        {/* Body: a single accessible element (author, text, date) so screen
            readers read in the order: avatar → post content → actions.
            All visual children are hidden from accessibility; sighted users
            interact with them directly (name, reply-to and text tap targets). */}
        <View style={styles.body}>
          <Pressable
            onPress={open}
            disabled={!open}
            accessible
            accessibilityRole={open ? 'link' : 'text'}
            accessibilityLabel={label}
            accessibilityHint={open ? 'abre a conversa' : undefined}
          >
            <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
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
              {textOut ? null : textNode}
              {textOut ? null : mediaNode}
              {quoteOut || textOut ? null : quoteNode}
            </View>
          </Pressable>
          {textOut ? textNode : null}
          {textOut && (mediaNode || (quoteNode && !quoteOut))
            ? (
              <Pressable accessible={false} tabIndex={-1} onPress={open} disabled={!open}>
                <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
                  {mediaNode}
                  {quoteOut ? null : quoteNode}
                </View>
              </Pressable>
              )
            : null}
          {quoteOut ? quoteNode : null}
          {bar
            ? (
              <View style={styles.bar}>
                {fn(onReply)
                  ? (
                    <Action label={'responder a ' + title} onPress={onReply} count={countOf(counts, 'replies')}>
                      <Icon name='resposta' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onRepost)
                  ? fn(onOpenReposts) && reposts !== null
                    ? (
                      <View style={styles.splitAction}>
                        <Action
                          label={reposted ? 'desfazer republicação' : 'republicar'}
                          onPress={onRepost}
                          disabled={pending === 'repost'}
                          on={!!reposted}
                          count={null}
                          split
                        >
                          <Icon name='republicar' size={ICON} color={reposted ? colors.accent : colors.soft} />
                        </Action>
                        <Pressable
                          accessibilityRole='button'
                          accessibilityLabel={'ver quem republicou, ' + reposts}
                          hitSlop={COUNT_SLOP}
                          onPress={onOpenReposts}
                          style={styles.countAction}
                        >
                          <Text style={[styles.count, reposted && styles.countOn]}>{displayText(String(reposts))}</Text>
                        </Pressable>
                      </View>
                      )
                    : (
                      <Action
                        label={reposted ? 'desfazer republicação' : 'republicar'}
                        onPress={onRepost}
                        disabled={pending === 'repost'}
                        on={!!reposted}
                        count={reposts}
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
                  ? fn(onOpenLikes) && likes !== null
                    ? (
                      <View style={styles.splitAction}>
                        <Action
                          label={liked ? 'descurtir' : 'curtir'}
                          onPress={onLike}
                          disabled={pending === 'like'}
                          on={!!liked}
                          count={null}
                          split
                        >
                          <Heart filled={!!liked} color={liked ? colors.accent : colors.soft} />
                        </Action>
                        <Pressable
                          accessibilityRole='button'
                          accessibilityLabel={'ver quem curtiu, ' + likes}
                          hitSlop={COUNT_SLOP}
                          onPress={onOpenLikes}
                          style={styles.countAction}
                        >
                          <Text style={[styles.count, liked && styles.countOn]}>{displayText(String(likes))}</Text>
                        </Pressable>
                      </View>
                      )
                    : (
                      <Action
                        label={liked ? 'descurtir' : 'curtir'}
                        onPress={onLike}
                        disabled={pending === 'like'}
                        on={!!liked}
                        count={likes}
                      >
                        <Heart filled={!!liked} color={liked ? colors.accent : colors.soft} />
                      </Action>
                      )
                  : null}
                {fn(onFollow)
                  ? (
                    <Action label={'seguir ' + title} onPress={onFollow} disabled={!!followPending}>
                      <Icon name='seguir' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
                {fn(onReport)
                  ? (
                    <Action label={'denunciar publicação de ' + title} onPress={onReport}>
                      <Icon name='bandeira' size={ICON} color={colors.soft} />
                    </Action>
                    )
                  : null}
              </View>
              )
            : null}
        </View>
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
  reposted: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 26, marginBottom: 4, maxWidth: '100%' },
  repostedLink: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  repostedText: { ...type.replyMark, color: colors.soft, fontWeight: '600', flexShrink: 1 },
  repostedFollow: { flexShrink: 0, minHeight: 28, justifyContent: 'center', paddingHorizontal: 2 },
  repostedFollowText: { ...type.counter, color: colors.accent },
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
  // A split pair is as wide as the combined button (8 + icon + gap + digits +
  // 8), so the bar still fits a 320 pt screen.
  actionSplit: { gap: 0, minWidth: 0, paddingRight: 2 },
  splitAction: { flexDirection: 'row', alignItems: 'center' },
  countAction: { minHeight: 36, paddingLeft: 3, paddingRight: 8, justifyContent: 'center' },
  count: { ...type.counter, color: colors.soft },
  countOn: { color: colors.accent },
  heart: { width: ICON, height: ICON, alignItems: 'center', justifyContent: 'center' },
  heartFill: { position: 'absolute', fontSize: ICON - 2, lineHeight: ICON, textAlign: 'center' },
  heartLine: { position: 'absolute' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.6 }
})
