// The Mural: a profile's photos as square tiles, 2 pt apart. A FlatList of
// ROWS (never the whole grid in one cell) so a long Mural stays virtualised.
// Each tile shows media[0] through MediaView (descriptors untouched, MediaView
// validates them); persist goes to every tile: false for authors the device
// does not follow. No counts of likes or views. More photos load only by the
// explicit 'Ver mais' button, never on scroll.

import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { relativeTime } from '../format'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { Pill } from './Pill'
import { Soft } from './index'
import { EmptyState } from './States'
import { useStyles, useTheme } from './ThemeProvider'
import { space } from './theme'

function toRows (tiles, columns) {
  const rows = []
  for (let i = 0; i < tiles.length; i += columns) rows.push({ key: 'r' + i, items: tiles.slice(i, i + columns) })
  return rows
}

function tileLabel (tile) {
  const n = Array.isArray(tile.media) ? tile.media.length : 0
  const when = relativeTime(tile.at)
  return (n > 1 ? n + ' fotos' : 'foto') + (when ? ', ' + when : '')
}

// One grid row, for a host list that renders rows itself (the profile screens
// keep their single RefreshableList). item is a row from muralGridRows.
export function MuralRow ({ item, onOpen, persist, columns = 3 }) {
  const styles = useStyles(makeStyles)
  const cols = Number.isInteger(columns) && columns > 0 ? columns : 3
  // Each row carries its own 2 pt gap below (host lists have no separator),
  // and the first one 2 pt above, off the tab underline.
  return (
    <View style={[styles.row, item.key === 'r0' && styles.first]}>
      {item.items.map((tile, i) => (
        // The whole tile opens the post, even when the cover failed to load:
        // MediaView would turn a failed cover into its own retry button (a
        // second focus stop on the web), so it gets no touches and no retry
        // button here (the post view retries its photos).
        <Pressable
          key={tile.ref || i}
          style={({ pressed, hovered }) => [styles.tile, (pressed || hovered) && styles.pressed]}
          accessibilityRole='button'
          accessibilityLabel={tileLabel(tile)}
          onPress={() => onOpen && onOpen(tile)}
        >
          {/* The tile button already says what the photo is: the image inside
              stays out of the accessibility tree, or each tile reads twice. */}
          <View
            style={styles.fill}
            pointerEvents='none'
            accessibilityElementsHidden
            importantForAccessibility='no-hide-descendants'
            aria-hidden
          >
            <MediaView
              author={tile.author}
              descriptor={tile.media && tile.media[0]}
              persist={persist}
              label={tileLabel(tile)}
              style={styles.fill}
              tapRetry={false}
            />
          </View>
          {Array.isArray(tile.media) && tile.media.length > 1
            ? <View style={styles.badge} pointerEvents='none'><Icon name='copiar' size={14} color='#ffffff' /></View>
            : null}
        </Pressable>
      ))}
      {item.items.length < cols ? Array.from({ length: cols - item.items.length }, (_, i) => <View key={'pad' + i} style={styles.pad} />) : null}
    </View>
  )
}

export function muralGridRows (tiles, columns = 3) {
  const cols = Number.isInteger(columns) && columns > 0 ? columns : 3
  return toRows(Array.isArray(tiles) ? tiles : [], cols)
}

// emptyBody: the line under 'Nenhuma foto ainda' (the own Diário says where
// published photos appear).
export function MuralFooter ({ count = 0, state, complete = true, onMore, footer, emptyBody }) {
  const styles = useStyles(makeStyles)
  if (state === 'end' && count === 0) {
    // An incomplete index may still hold photos: say so under the empty state.
    return (
      <View>
        <EmptyState icon='imagem' title='Nenhuma foto ainda' body={emptyBody} />
        {complete === false ? <View style={styles.foot}><Soft>Algumas fotos podem faltar</Soft></View> : null}
        {footer || null}
      </View>
    )
  }
  return (
    <View style={styles.foot}>
      {state === 'more' || state === 'capped' || state === 'loading'
        ? <Pill label='Ver mais' onPress={onMore} pending={state === 'loading'} />
        : null}
      {state === 'end' && count > 0 ? <Soft>Fim do Mural</Soft> : null}
      {complete === false ? <Soft>Algumas fotos podem faltar</Soft> : null}
      {footer || null}
    </View>
  )
}

// state: 'more' | 'capped' | 'end' | 'loading' | 'error' (a failed page: the
// caller's footer carries the retry, so no Ver mais). complete false: the index
// knows some photos may be missing.
export function MuralGrid ({ tiles, onOpen, persist, columns = 3, header, footer, state, complete = true, onMore, emptyBody }) {
  const { colors } = useTheme()
  const list = Array.isArray(tiles) ? tiles : []
  const rows = muralGridRows(list, columns)
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => <MuralRow item={item} onOpen={onOpen} persist={persist} columns={columns} />}
      ListHeaderComponent={header || null}
      ListFooterComponent={<MuralFooter count={list.length} state={state} complete={complete} onMore={onMore} footer={footer} emptyBody={emptyBody} />}
      initialNumToRender={6}
      windowSize={7}
      removeClippedSubviews
      style={{ backgroundColor: colors.bg }}
    />
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', gap: 2, marginBottom: 2 },
  first: { marginTop: 2 },
  tile: { flex: 1, aspectRatio: 1, backgroundColor: colors.card },
  // The cells that square off a short last row: empty space, never a box.
  pad: { flex: 1, aspectRatio: 1 },
  fill: { width: '100%', height: '100%' },
  pressed: { opacity: 0.85 },
  // A fixed scrim, not a theme colour: it sits on a photo, whatever the theme.
  badge: { position: 'absolute', top: space.xs, right: space.xs, padding: 4, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.45)' },
  foot: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg }
})
