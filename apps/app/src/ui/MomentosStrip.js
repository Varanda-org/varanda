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
// Own momentos and those of followed people use MomentRing on the profile
// photo to keep profiles compact. There is no expired momentos list because
// the author's app deletes its own 48 h after publication. A Página's
// momentos remain in Ajustes da página so they can be managed there.

import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { displayText } from '@varanda/rpc'
import { ringOrder } from '../moments'
import { liveAuthors, liveItems, ringSeen, stripShown } from '../momentSeen'
import { interpolateStops } from '../format'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { sunsetStops, type } from './theme'

const RING = 64
// The sunset from orange to plum, sampled at its stop positions. The night
// blue at its end is about 1.4:1 on the dark background, so a third of the
// ring would vanish there.
const RING_BANDS = interpolateStops(sunsetStops.slice(0, 3), 6)
const EXCERPT = 60

// The cap keeps ring names within their compact layout.
const ROW_CAP = 1.3

// The first word of a display name for the ring ('Você' for the own one).
export function ringName (title) {
  const first = displayText(typeof title === 'string' ? title : '').trim().split(/\s+/u)[0]
  return first || ''
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
      {/* collapsable: the own ring mounts as '+' (transparent) and takes the
          outline once moments load. Android flattens the transparent View away
          and, when it later becomes a real view, draws the outline without the
          radius: a grey square behind the avatar. */}
      <View collapsable={false} style={[styles.ring, { backgroundColor: plus ? 'transparent' : colors.outline }]}>
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

// The ring on a profile photo: the strip's ring geometry around any child.
export function MomentRing ({ size, unseen, children }) {
  const { colors } = useTheme()
  const outer = size + 8
  const gap = size + 4
  return (
    <View collapsable={false} style={{ width: outer, height: outer, borderRadius: outer / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.outline }}>
      {unseen
        ? (
          <View style={{ ...StyleSheet.absoluteFillObject, borderRadius: outer / 2, overflow: 'hidden' }}>
            {RING_BANDS.map((color, i) => <View key={i} style={{ flex: 1, backgroundColor: color }} />)}
          </View>
          )
        : null}
      <View style={{ width: gap, height: gap, borderRadius: gap / 2, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
    </View>
  )
}

// data: useMoments() output; seen: the refs seen (synced where the node is hosted, on this device otherwise); me: the own
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

const makeStyles = (colors) => StyleSheet.create({
  stripWrap: { flexGrow: 0 },
  strip: { flexDirection: 'row', gap: 8, paddingHorizontal: 24, paddingVertical: 12 },
  ringItem: { width: 72, minHeight: 44, alignItems: 'center', gap: 4 },
  pressed: { opacity: 0.6 },
  ring: { width: RING, height: RING, borderRadius: RING / 2, alignItems: 'center', justifyContent: 'center' },
  ringStripes: { ...StyleSheet.absoluteFillObject, borderRadius: RING / 2, overflow: 'hidden' },
  ringStripe: { flex: 1 },
  ringGap: { width: RING - 4, height: RING - 4, borderRadius: (RING - 4) / 2, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  plus: { position: 'absolute', right: -2, bottom: -2, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  ringName: { ...type.caption, color: colors.soft, width: '100%', textAlign: 'center' }
})
