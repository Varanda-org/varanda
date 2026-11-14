// Momentos on A Rua and on the Diário (docs/rpc.md 5.113), hosted only.
//
// MomentosStrip: A Rua's list header. One horizontal row of 56 pt rings: the
// own one first with a '+' badge (it opens the composer in Momento mode when
// there is no own live moment, the own viewer otherwise, where 'Novo
// momento' adds another), then the authors with anything not seen on this
// device (sunset ring), then the fully seen ones (outline ring). Under a ring
// only the first word of the name, on one line with the slot growing with
// font scaling up to 1.3; the full name is in the label. adjustsFontSizeToFit
// shrank without limit on Android and not at all on the web. The own ring
// with '+' opens the composer: no ring, labelled 'novo momento'. Every ring
// is a 44 pt (or larger) target.
//
// DiarioMoments: under the Diário's profile header, never a fourth tab. A
// single row of the own live moments ('Seus momentos (24 h)', a tap opens the
// own viewer) and a collapsed 'Momentos anteriores (N)' row that expands to
// the own expired moments (moments.read `past`), each with its date, an
// excerpt of its text and 'Apagar' behind a MoreButton. Hidden when both are
// empty. The data and the delete sheet come from the caller
// (screens/Momentos.js useMoments, ConfirmMomentDelete).

import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { displayText } from '@varanda/rpc'
import { ringOrder } from '../moments'
import { liveAuthors, liveItems, ringSeen, stripShown } from '../momentSeen'
import { interpolateStops, relativeTime } from '../format'
import { contextDate } from '../privateReply'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { MoreButton } from './MoreButton'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { sunsetStops, type } from './theme'

export const OWN_LIVE_TITLE = 'Seus momentos (24 h)'
const RING = 56
// The sunset from orange to plum, sampled at its stop positions. The night
// blue at its end is about 1.4:1 on the dark background, so a third of the
// ring would vanish there.
const RING_BANDS = interpolateStops(sunsetStops.slice(0, 3), 6)
const EXCERPT = 60

// The cap keeps the ring names and Diário rows within their compact layout.
const ROW_CAP = 1.3

// The first word of a display name for the ring ('Você' for the own one).
export function ringName (title) {
  const first = displayText(typeof title === 'string' ? title : '').trim().split(/\s+/u)[0]
  return first || ''
}

export const PAST_TITLE = 'Momentos anteriores'
export function pastLabel (n) {
  return 'Momentos anteriores (' + n + ')'
}

// One line of the moment's text for a row.
export function excerptOf (text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const line = Array.from(displayText(text.replace(/\s+/gu, ' ').trim()))
  return line.length > EXCERPT ? line.slice(0, EXCERPT).join('') + '…' : line.join('')
}

// persist: a ring is the own key or an author of moments.read, which lists
// followed diaries only (docs/rpc.md 5.113).
function Ring ({ label, name, unseen, onPress, profile, publicKey, plus }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { fontScale } = useWindowDimensions()
  const width = 72 * Math.min(ROW_CAP, Math.max(1, fontScale))
  return (
    <PressScale
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.ringItem, { width }, pressed && styles.pressed]}
    >
      <View style={[styles.ring, { backgroundColor: plus ? 'transparent' : colors.outline }]}>
        {unseen && !plus
          ? (
            <View style={styles.ringStripes}>
              {RING_BANDS.map((color, i) => <View key={i} style={[styles.ringStripe, { backgroundColor: color }]} />)}
            </View>
            )
          : null}
        <View style={styles.ringGap}>
          <Avatar name={profile ? (profile.name || profile.username || null) : null} publicKey={publicKey} size={RING - 8} picture={profile ? profile.avatar : undefined} persist />
        </View>
        {plus
          ? (
            <View style={styles.plus}>
              <Icon name='plus' size={14} color={colors.accentInk} />
            </View>
            )
          : null}
      </View>
      <Text style={styles.ringName} numberOfLines={1} ellipsizeMode='tail' maxFontSizeMultiplier={ROW_CAP}>{name}</Text>
    </PressScale>
  )
}

// data: useMoments() output; seen: the refs seen on this device; me: the own
// profile; canPublish: canPublishMoment(node).
export function MomentosStrip ({ hosted, data, seen, ownKey, me, profileOf, canPublish, now = Date.now(), onOpen, onCreate }) {
  const styles = useStyles(makeStyles)
  if (hosted !== true || !data || data.phase === 'off') return null
  const authors = liveAuthors(data.authors, now)
  const own = liveItems(data.own, now)
  if (!stripShown({ hosted, authors, own, canPublish })) return null
  const seenSet = new Set(Array.isArray(seen) ? seen : [])
  const ordered = ringOrder(authors, seenSet, ownKey)
  const ownOpen = own.length > 0
    ? () => onOpen(ownKey)
    : canPublish === true && typeof onCreate === 'function' ? onCreate : null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} style={styles.stripWrap}>
      {typeof ownKey === 'string' && ownOpen !== null
        ? (
          <Ring
            label={own.length === 0 ? 'novo momento' : 'seu momento'}
            name='Você'
            unseen={own.length > 0 && !ringSeen(own, seenSet)}
            onPress={ownOpen}
            profile={me}
            publicKey={ownKey}
            plus={own.length === 0}
          />
          )
        : null}
      {ordered.map((a) => {
        const profile = typeof profileOf === 'function' ? profileOf(a.author) : null
        const name = displayText(whoOf(profile || {}).title)
        return (
          <Ring
            key={a.author}
            label={'momentos de ' + name}
            name={ringName(name)}
            unseen={!ringSeen(a.items, seenSet)}
            onPress={() => onOpen(a.author)}
            profile={profile}
            publicKey={a.author}
          />
        )
      })}
    </ScrollView>
  )
}

export function DiarioMoments ({ hosted, data, now = Date.now(), onOpenOwn, onDelete }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [expanded, setExpanded] = useState(false)
  if (hosted !== true || !data || data.phase !== 'ready') return null
  const own = liveItems(data.own, now)
  const past = Array.isArray(data.past) ? data.past : []
  if (own.length === 0 && past.length === 0) return null
  return (
    <View style={styles.section}>
      {own.length > 0
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={OWN_LIVE_TITLE + ', ' + own.length + (own.length === 1 ? ' momento' : ' momentos')}
            onPress={onOpenOwn}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Icon name='camera' size={20} color={colors.accent} />
            <Text style={styles.rowText} numberOfLines={1} maxFontSizeMultiplier={ROW_CAP}>{OWN_LIVE_TITLE}</Text>
            <Text style={styles.meta} maxFontSizeMultiplier={ROW_CAP}>{String(own.length)}</Text>
            <Icon name='seta' size={20} color={colors.soft} />
          </Pressable>
          )
        : null}
      {past.length > 0
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityState={{ expanded }}
            // react-native-web does not map accessibilityState.expanded.
            aria-expanded={expanded}
            accessibilityLabel={pastLabel(past.length)}
            onPress={() => setExpanded((v) => !v)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Icon name='imagem' size={20} color={colors.soft} />
            {/* The count apart, as on the row above: a long title never cuts it. */}
            <Text style={styles.rowText} numberOfLines={1} maxFontSizeMultiplier={ROW_CAP}>{PAST_TITLE}</Text>
            <Text style={styles.meta} maxFontSizeMultiplier={ROW_CAP}>{String(past.length)}</Text>
            <Icon name='escolher' size={20} color={colors.soft} style={expanded ? styles.flip : null} />
          </Pressable>
          )
        : null}
      {expanded
        ? past.map((m) => {
          const excerpt = excerptOf(m.text)
          return (
            <View key={m.ref} style={styles.pastRow}>
              <View style={styles.pastText}>
                <Text style={styles.meta} numberOfLines={1}>{contextDate(m.at, now) || relativeTime(m.at, now) || ''}</Text>
                <Text style={styles.excerpt} numberOfLines={2}>{excerpt !== '' ? excerpt : 'Momento com foto'}</Text>
              </View>
              <MoreButton
                label='mais ações do momento'
                actions={[{ icon: 'lixeira', label: 'Apagar', danger: true, onPress: () => onDelete(m) }]}
              />
            </View>
          )
        })
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  stripWrap: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
  strip: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  ringItem: { width: 72, minHeight: 44, alignItems: 'center', gap: 4 },
  pressed: { opacity: 0.6 },
  ring: { width: RING, height: RING, borderRadius: RING / 2, alignItems: 'center', justifyContent: 'center' },
  ringStripes: { ...StyleSheet.absoluteFillObject, borderRadius: RING / 2, overflow: 'hidden' },
  ringStripe: { flex: 1 },
  ringGap: { width: RING - 4, height: RING - 4, borderRadius: (RING - 4) / 2, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  plus: { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  ringName: { ...type.caption, color: colors.ink, width: '100%', textAlign: 'center' },
  section: { borderBottomWidth: 1, borderBottomColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 16, paddingVertical: 10 },
  rowText: { ...type.postName, color: colors.ink, flex: 1 },
  meta: { ...type.postMeta, color: colors.soft },
  flip: { transform: [{ rotate: '180deg' }] },
  pastRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 48, paddingRight: 8, paddingVertical: 6 },
  pastText: { flex: 1, minWidth: 0 },
  excerpt: { ...type.postText, color: colors.ink }
})
