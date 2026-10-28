// The quoted post inside a PostRow: a bordered card with a mini avatar, the
// name, @nome and time, up to 6 lines of text and the photos (./MediaGrid).
// `quote` = { author, name, username, at, text, media, missing, onOpen } with
// RAW peer strings (displayText is applied here); optional `persist` (true
// only for own or followed authors; absent = the photos are never cached)
// and `hasQuote` (the quoted post itself quotes another one: shown as the
// line 'cita outra publicação', never a second card). `missing` shows 'Publicação indisponível'; a quote with
// neither text nor photos and not missing is still loading. The whole card
// opens the quoted post (`quote.onOpen`); the photos keep their own taps.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { relativeTime } from '../format'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { MediaGrid } from './MediaGrid'
import { colors, type } from './theme'

export function QuoteCard ({ quote, now }) {
  const q = quote && typeof quote === 'object' ? quote : {}
  const open = typeof q.onOpen === 'function' ? q.onOpen : undefined
  const missing = q.missing === true
  const hasText = typeof q.text === 'string' && q.text !== ''
  const hasMedia = Array.isArray(q.media) && q.media.length > 0
  const loading = !missing && !hasText && !hasMedia
  const who = whoOf({ name: q.name, username: q.username })
  const title = displayText(who.title)
  const time = typeof q.at === 'string' ? (relativeTime(q.at, now) ?? displayText(q.at)) : null
  const meta = [who.subtitle ? displayText(who.subtitle) : null, time].filter(Boolean).join(' · ')
  return (
    <Pressable
      accessibilityRole={open ? 'link' : 'text'}
      accessibilityLabel={missing ? 'Publicação indisponível' : 'publicação citada de ' + title}
      disabled={!open}
      onPress={open}
      style={({ pressed }) => [styles.card, pressed && open && styles.pressed]}
    >
      {missing
        ? <Text style={styles.soft}>Publicação indisponível</Text>
        : (
          <>
            <View style={styles.head}>
              {typeof q.author === 'string' ? <Avatar name={who.avatarName} publicKey={q.author} size={20} picture={q.avatar} persist={q.persist === true} /> : null}
              <Text style={styles.name} numberOfLines={1}>{title}</Text>
              {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
            </View>
            {loading ? <View style={styles.skeleton} accessible={false} /> : null}
            {hasText
              ? <Text style={styles.text} numberOfLines={6}>{displayText(q.text, { multiline: true })}</Text>
              : null}
            {hasMedia
              ? <View style={styles.media}><MediaGrid author={q.author} media={q.media} persist={q.persist === true} /></View>
              : null}
            {q.hasQuote === true ? <Text style={styles.soft}>cita outra publicação</Text> : null}
          </>
          )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 12,
    gap: 4
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { ...type.postName, fontSize: 14, color: colors.ink, flexShrink: 1 },
  meta: { ...type.postMeta, fontSize: 14, color: colors.soft, flexShrink: 1 },
  text: { ...type.postText, fontSize: 14.5, lineHeight: 20, color: colors.ink },
  media: { marginTop: 2 },
  soft: { ...type.replyMark, color: colors.soft },
  skeleton: { height: 12, width: '70%', borderRadius: 6, backgroundColor: colors.skeleton },
  pressed: { opacity: 0.6 }
})
