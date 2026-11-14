// The still cover drawn at a music player's size while the real player loads
// under it. Built from stored data only (the card or the composer's draft):
// it never contacts the provider, and a tap on it does nothing, so the person
// cannot reach the provider page before the player is there. Title, provider
// name and play badge draw from the first commit; only the picture waits.
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { coverLabel, coverLayout, coverSource } from '../embedCover'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { useChatThumb } from './LinkCard'
import { useStyles, useTheme } from './ThemeProvider'
import { space } from './theme'

const textOf = (v) => (typeof v === 'string' ? displayText(v).trim() : '')
const ROW_TEXT_MIN = 120
const ROW_INSET = 24

export function EmbedCover ({ provider, name, card, draft, imageUri, thumb, width, height, onLongPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const data = draft || card
  const stored = !draft && card && typeof card === 'object' ? card.image : null
  const chatUri = useChatThumb(draft ? null : thumb, stored)
  const src = coverSource({ draft, imageUri, card, thumb })
  const layout = coverLayout(provider, width, height)
  const provName = textOf(name)
  const rawTitle = data && typeof data === 'object' ? textOf(data.title) : ''
  const title = rawTitle === provName ? '' : rawTitle
  const label = coverLabel(provName, title)

  let picture = null
  if (src.kind === 'uri') {
    picture = <MediaView uri={src.uri} label='capa' fit='cover' tapRetry={false} style={styles.fill} />
  } else if (src.kind === 'post') {
    picture = <MediaView author={src.author} descriptor={src.descriptor} persist={src.persist} label='capa' fit='cover' tapRetry={false} style={styles.fill} />
  } else if (src.kind === 'chat' && typeof chatUri === 'string') {
    picture = <MediaView uri={chatUri} label='capa' fit='cover' tapRetry={false} style={styles.fill} />
  }
  const note = <Icon name='musica' size={32} color={colors.soft} />

  let body
  if (layout.kind === 'full') {
    body = (
      <>
        {picture || <View style={styles.center}>{note}</View>}
        <View style={styles.scrim} />
        <View style={styles.center} pointerEvents='none'>
          <View style={styles.badgeBig}><Icon name='tocar' size={28} color='#ffffff' /></View>
        </View>
        <View style={styles.bottom}>
          {title ? <Text style={styles.lightTitle} numberOfLines={1}>{title}</Text> : null}
          {provName ? <Text style={styles.lightName} numberOfLines={1}>{provName}</Text> : null}
        </View>
      </>
    )
  } else if (layout.kind === 'row') {
    const art = Math.max(0, Math.min(layout.art, (width || 0) - ROW_INSET - ROW_TEXT_MIN))
    body = (
      <View style={styles.row}>
        <View style={[styles.art, { width: art, height: art }]}>{picture || note}</View>
        <View style={styles.words}>
          {title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}
          {provName ? <Text style={styles.name} numberOfLines={1}>{provName}</Text> : null}
        </View>
        <View style={styles.badgeSmall}><Icon name='tocar' size={20} color='#ffffff' /></View>
      </View>
    )
  } else {
    body = (
      <View style={styles.stack}>
        <View style={[styles.art, { width: layout.art, height: layout.art }]}>{picture || note}</View>
        <View style={styles.stackText}>
          <View style={styles.words}>
            {title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}
            {provName ? <Text style={styles.name} numberOfLines={1}>{provName}</Text> : null}
          </View>
          <View style={styles.badgeSmall}><Icon name='tocar' size={20} color='#ffffff' /></View>
        </View>
      </View>
    )
  }

  return (
    <Pressable
      accessibilityRole='image'
      accessibilityLabel={label}
      onLongPress={typeof onLongPress === 'function' ? onLongPress : undefined}
      delayLongPress={350}
      style={styles.tile}
    >
      {body}
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  tile: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.skeleton, overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFillObject },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '45%', backgroundColor: 'rgba(0,0,0,0.45)' },
  bottom: { position: 'absolute', left: space.sm, right: space.sm, bottom: space.sm, gap: 2 },
  lightTitle: { color: '#ffffff', fontSize: 15, lineHeight: 20, fontWeight: '700' },
  lightName: { color: '#ffffff', fontSize: 12, lineHeight: 16, opacity: 0.85 },
  badgeBig: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' },
  badgeSmall: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: space.sm, gap: space.sm },
  stack: { flex: 1, alignItems: 'center', padding: space.sm, gap: space.sm },
  stackText: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: space.sm },
  art: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 6, backgroundColor: colors.skeleton },
  words: { flex: 1, gap: 2 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.ink },
  name: { fontSize: 12, lineHeight: 16, color: colors.soft }
})
