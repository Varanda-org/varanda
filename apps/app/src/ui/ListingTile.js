import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { priceLabel, statusLabel } from '../feira'
import { CATEGORY_ICONS, placeLabel } from '../feiraBrowse'
import { UNKNOWN_STATUS } from '../feiraCompose'
import { tap } from './haptics'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { elevation, layout, radius, space, type } from './theme'

const text = (value) => displayText(typeof value === 'string' ? value : '')

export function ListingTile ({ listing, width, onPress, saved, onSave }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
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
      <View>
        {photo
          ? <MediaView author={listing.author} descriptor={photo} label={'Foto de ' + title} style={styles.photo} persist={false} tapRetry={false} />
          : <View style={[styles.photo, styles.placeholder]}><Icon name={icon} size={40} /></View>}
        {badge ? <View style={styles.badgeRow}><Text style={styles.badge} numberOfLines={1}>{text(badge)}</Text></View> : null}
      </View>
      <View style={styles.details}>
        <Text style={styles.price}>{price}</Text>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
      </View>
    </View>
  )
  if (typeof onPress !== 'function') {
    return <View style={[styles.tile, { width }]}>{content}</View>
  }
  const tile = (
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
  if (typeof onSave !== 'function') return tile
  // A sibling of the tile, never its child, so a press on the star cannot
  // reach the tile's onPress and open the listing.
  return (
    <View style={{ width }}>
      {tile}
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={saved === true ? 'Salvo' : 'Salvar'}
        accessibilityState={{ selected: saved === true }}
        // On the web `selected` becomes aria-selected, which a button cannot carry.
        aria-pressed={saved === true}
        onPress={() => { tap('select'); onSave() }}
        style={styles.save}
      >
        <View style={styles.saveDisc}>
          <Icon name='estrela' size={20} color={colors.onMedia} filled={saved === true} />
        </View>
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  tile: { minHeight: layout.hit, borderRadius: radius.bubble, borderWidth: 1, borderColor: colors.line, padding: space.sm, boxShadow: elevation.xs, backgroundColor: colors.card },
  photo: { width: '100%', aspectRatio: 4 / 5, borderRadius: 16, overflow: 'hidden' },
  placeholder: { backgroundColor: colors.skeleton, alignItems: 'center', justifyContent: 'center' },
  details: { padding: space.md, gap: space.xs },
  price: { ...type.price, color: colors.ink },
  title: { ...type.tileTitle, color: colors.ink },
  // Top left, stopping short of the save star in the top right corner.
  badgeRow: { position: 'absolute', top: space.xs, left: space.xs, right: layout.hit, flexDirection: 'row' },
  badge: { ...type.chip, flexShrink: 1, color: colors.accent, backgroundColor: colors.accentSoft, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, overflow: 'hidden' },
  // Past the tile's 1 pt border and its padding, so the target starts at the photo corner.
  save: { position: 'absolute', top: space.sm + 1, right: space.sm + 1, width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center' },
  saveDisc: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' }
})
