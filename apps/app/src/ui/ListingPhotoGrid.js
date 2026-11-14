import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { moveById } from '../photoOrder'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// Callers keep encoding, upload and pending state; this only shows the list
// and reports a removal, an add or a move. A move is reported as the photo and
// the step, not a list from this render, so the caller applies it to its newest
// list and a photo that lands between the render and the tap is kept.
export function ListingPhotoGrid ({ photos, max, locked = false, canAdd = true, onAdd, onRemove, onMove }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const list = Array.isArray(photos) ? photos : []
  const full = typeof max === 'number' && list.length >= max
  const move = (id, delta) => {
    if (moveById(list, id, delta) !== list && typeof onMove === 'function') onMove(id, delta)
  }
  if (list.length === 0) {
    return (
      <Pressable accessibilityRole='button' accessibilityLabel='Adicionar fotos' disabled={locked || !canAdd} onPress={onAdd} style={styles.empty}>
        <Icon name='imagem' size={24} color={colors.soft} />
        <Text style={styles.emptyText}>Adicionar fotos</Text>
      </Pressable>
    )
  }
  return (
    <View style={styles.grid}>
      {list.map((p, i) => (
        <View key={p.id} style={styles.cell}>
          <View style={styles.photo}>
            {p.thumb
              ? <Image source={{ uri: p.thumb }} style={styles.img} accessibilityLabel={'Foto ' + (i + 1)} />
              : <View style={styles.kept}><Icon name='imagem' size={20} color={colors.soft} /><Text style={styles.keptText}>atual</Text></View>}
            {i === 0 ? <Text style={styles.cover}>Capa</Text> : null}
            {!locked
              ? (
                <>
                  <Pressable accessibilityRole='button' accessibilityLabel={'Remover foto ' + (i + 1)} onPress={() => onRemove && onRemove(p.id)} style={[styles.btn, styles.topRight]}>
                    <View style={styles.dot}><Icon name='fechar' size={16} color={colors.ink} /></View>
                  </Pressable>
                  <Pressable accessibilityRole='button' accessibilityLabel={'Mover foto ' + (i + 1) + ' para antes'} disabled={i === 0} onPress={() => move(p.id, -1)} style={[styles.btn, styles.bottomLeft, i === 0 && styles.off]}>
                    <View style={styles.dot}><Icon name='voltar' size={16} color={colors.ink} /></View>
                  </Pressable>
                  <Pressable accessibilityRole='button' accessibilityLabel={'Mover foto ' + (i + 1) + ' para depois'} disabled={i === list.length - 1} onPress={() => move(p.id, 1)} style={[styles.btn, styles.bottomRight, i === list.length - 1 && styles.off]}>
                    <View style={styles.dot}><Icon name='seta' size={16} color={colors.ink} /></View>
                  </Pressable>
                </>
                )
              : null}
          </View>
        </View>
      ))}
      {!full && canAdd
        ? (
          <View style={styles.cell}>
            <Pressable accessibilityRole='button' accessibilityLabel='Adicionar fotos' disabled={locked} onPress={onAdd} style={[styles.photo, styles.add]}>
              <Icon name='imagem' size={22} color={colors.soft} />
            </Pressable>
          </View>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cell: { width: '31%', gap: space.xs },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.skeleton },
  img: { width: '100%', height: '100%' },
  // A photo already on the listing has no local thumb (the edit screen).
  kept: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  keptText: { ...type.caption, color: colors.soft },
  cover: { ...type.chip, position: 'absolute', left: space.xs, top: space.xs, color: colors.accent, backgroundColor: colors.accentSoft, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, overflow: 'hidden' },
  // Each 44 pt target sits inside its own square (about 111 pt wide), so none
  // spills into the next cell or overlaps another.
  btn: { position: 'absolute', width: layout.hit, height: layout.hit, alignItems: 'center', justifyContent: 'center' },
  topRight: { top: 0, right: 0 },
  bottomLeft: { bottom: 0, left: 0 },
  bottomRight: { bottom: 0, right: 0 },
  dot: { width: 28, height: 28, borderRadius: radius.pill, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.35 },
  add: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  empty: { minHeight: layout.hit * 2, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, alignItems: 'center', justifyContent: 'center', gap: space.xs },
  emptyText: { ...type.caption, color: colors.soft }
})
