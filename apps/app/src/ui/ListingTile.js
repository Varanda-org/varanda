import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { priceLabel, statusLabel } from '../feira'
import { CATEGORY_ICONS, placeLabel } from '../feiraBrowse'
import { UNKNOWN_STATUS } from '../feiraCompose'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { PressScale } from './PressScale'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

const text = (value) => displayText(typeof value === 'string' ? value : '')

export function ListingTile ({ listing, width, onPress }) {
  const styles = useStyles(makeStyles)
  const title = text(listing.title)
  const price = text(priceLabel(listing.price, listing.unit, listing.kind))
  const city = placeLabel(listing.place || {})
  const badge = listing.stale === true
    ? UNKNOWN_STATUS
    : listing.status === 'vendido' || listing.status === 'reservado'
      ? statusLabel(listing.status, listing.kind)
      : listing.kind === 'procura' ? 'Procura' : ''
  const photo = Array.isArray(listing.media) ? listing.media[0] : null
  const icon = Object.prototype.hasOwnProperty.call(CATEGORY_ICONS, listing.cat) ? CATEGORY_ICONS[listing.cat] : CATEGORY_ICONS.outros
  const content = (
    <View>
      {photo
        ? <MediaView author={listing.author} descriptor={photo} label={'Foto de ' + title} style={styles.photo} persist={false} tapRetry={false} />
        : <View style={[styles.photo, styles.placeholder]}><Icon name={icon} size={40} /></View>}
      <View style={styles.content}>
        <Text style={styles.price}>{price}</Text>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        <Text style={styles.city} numberOfLines={1}>{city}</Text>
        {badge ? <Text style={styles.badge}>{text(badge)}</Text> : null}
      </View>
    </View>
  )
  if (typeof onPress !== 'function') {
    return <View style={[styles.tile, { width }]}>{content}</View>
  }
  return (
    <PressScale
      accessibilityRole='button'
      accessibilityLabel={[title, price, city, text(badge)].filter(Boolean).join(', ')}
      onPress={onPress}
      style={[styles.tile, { width }]}
    >
      <View pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
        {content}
      </View>
    </PressScale>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  tile: { minHeight: layout.hit, backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden' },
  photo: { width: '100%', aspectRatio: 1, overflow: 'hidden' },
  placeholder: { backgroundColor: colors.skeleton, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space.md, gap: space.xs },
  price: { ...type.price, color: colors.ink },
  title: { ...type.tileTitle, color: colors.ink },
  city: { ...type.caption, color: colors.soft },
  badge: { ...type.chip, alignSelf: 'flex-start', color: colors.accent, backgroundColor: colors.accentSoft, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm }
})
