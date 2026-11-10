import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { priceLabel, statusLabel } from '../feira'
import { UNKNOWN_STATUS } from '../feiraCompose'
import { MediaView } from './MediaView'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

const text = (value) => displayText(typeof value === 'string' ? value : '')

export function ListingCard ({ listing, onPress }) {
  const styles = useStyles(makeStyles)
  const title = text(listing.title)
  const price = text(priceLabel(listing.price, listing.unit, listing.kind))
  const place = listing.place || {}
  const city = text(place.city) + (place.uf ? '/' + text(place.uf) : '')
  const badge = listing.stale === true
    ? UNKNOWN_STATUS
    : listing.status === 'vendido' || listing.status === 'reservado'
      ? statusLabel(listing.status, listing.kind)
      : listing.kind === 'procura' ? 'Procura-se' : ''
  const photo = Array.isArray(listing.media) ? listing.media[0] : null
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={[title, price, city, text(badge)].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {photo
        ? <MediaView author={listing.author} descriptor={photo} label={'Foto de ' + title} style={styles.photo} persist={false} tapRetry={false} />
        : <View style={[styles.photo, styles.placeholder]}><Text style={styles.meta}>Sem foto</Text></View>}
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        <Text style={styles.price}>{price}</Text>
        <Text style={styles.meta} numberOfLines={1}>{city}</Text>
        {badge ? <Text style={styles.badge}>{text(badge)}</Text> : null}
      </View>
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, padding: space.lg, minHeight: layout.hit, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.bg },
  photo: { width: 88, height: 88, borderRadius: radius.sm, overflow: 'hidden' },
  placeholder: { backgroundColor: colors.skeleton, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, gap: space.xs },
  title: { ...type.postText, color: colors.ink, fontWeight: '600' },
  price: { ...type.postText, color: colors.ink, fontWeight: '700' },
  meta: { ...type.postMeta, color: colors.soft },
  badge: { ...type.postMeta, alignSelf: 'flex-start', color: colors.accent, backgroundColor: colors.accentSoft, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm },
  pressed: { opacity: 0.7 }
})
