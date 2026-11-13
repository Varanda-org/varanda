import { Pressable, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { musicStickerLine } from '../music'
import { MusicCover } from './MusicCover'
import { Pill } from './Pill'
import { useMusicCover } from './useMusicCover'
import { useStyles } from './ThemeProvider'
import { layout, radius, space } from './theme'

const { displayText } = rpc

export function MusicSticker ({ choice, onPress, onRemove, disabled, session }) {
  const styles = useStyles(makeStyles)
  // The cover is only drawn here, in memory: the stored card keeps image null.
  const uri = useMusicCover(choice.ref.kind === 'playlist' ? 'playlist' : 'track', choice.item, session ?? {})
  const off = !!disabled || typeof onPress !== 'function'
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='Editar música'
        accessibilityHint={displayText(choice.item.title) + ', ' + displayText(musicStickerLine(choice.ref, choice.item))}
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={off ? undefined : onPress}
        style={({ pressed }) => [styles.main, off && styles.off, pressed && styles.pressed]}
      >
        <MusicCover size={44} uri={uri} />
        <View style={styles.words}>
          <Text style={styles.title} numberOfLines={1}>{displayText(choice.item.title)}</Text>
          <Text style={styles.line} numberOfLines={1}>{displayText(musicStickerLine(choice.ref, choice.item))}</Text>
        </View>
      </Pressable>
      {typeof onRemove === 'function' ? <Pill icon='fechar' accessibilityLabel='Remover música' onPress={onRemove} disabled={disabled} /> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, minHeight: layout.hit, gap: space.sm, padding: space.sm },
  main: { flex: 1, minWidth: 0, minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  words: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontWeight: '700', fontSize: 16 },
  line: { color: colors.soft, fontSize: 14 },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 }
})
