import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { audiusPlay } from '../account'
import { musicRowLine, snippetEndMs, snippetProgress } from '../music'
import { createSnippetLoop, loopIdle } from '../musicLoop'
import { claimPlayback, playbackEpoch } from '../media/chatMedia'
import { createStreamPlayer } from '../media/stream'
import { tap } from './haptics'
import { Icon } from './Icon'
import { MusicCover } from './MusicCover'
import { MusicStrip } from './MusicStrip'
import { Segmented } from './Segmented'
import { useStyles, useTheme } from './ThemeProvider'
import { space } from './theme'

const { displayText } = rpc
const KINDS = [{ id: 'snippet', label: '15 s' }, { id: 'track', label: 'Faixa inteira' }]

export function MusicEditor ({ item, kind, start, modes, session, onKind, onStart, stopRef }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [state, setState] = useState(loopIdle)
  const loop = useMemo(() => createSnippetLoop({ audiusPlay, createStreamPlayer, claimPlayback, playbackEpoch }, session, setState), [item.id, session])
  const opened = useRef(false)
  useEffect(() => {
    opened.current = false
    stopRef.current = loop.release
    return () => { loop.release(); stopRef.current = null }
  }, [loop, stopRef])
  useEffect(() => {
    if (kind !== 'snippet') { loop.stop(); return }
    // Only the first visit starts by itself; coming back from Faixa inteira waits for a tap.
    if (opened.current) return
    opened.current = true
    loop.open(item, start)
  }, [loop, kind])
  const choose = modes.includes('snippet') && modes.includes('track') && kind !== 'playlist'
  const select = (next) => {
    if (next === kind) return
    tap('select')
    onKind(next)
  }
  const playing = state.phase === 'playing'
  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps='handled'>
      <View style={styles.cover}><MusicCover size={160} /></View>
      <Text style={styles.title}>{displayText(item.title)}</Text>
      {kind === 'playlist'
        ? <Text style={styles.artist}>{displayText(musicRowLine(item))}</Text>
        : <Text style={styles.artist}>{displayText(item.artist)}</Text>}
      {choose ? <Segmented options={KINDS} selected={kind} onSelect={select} /> : null}
      {kind === 'snippet'
        ? (
          <View style={styles.snippet}>
            <MusicStrip
              id={item.id}
              duration={item.duration}
              start={start}
              progress={playing ? snippetProgress(state.ms, start * 1000, snippetEndMs(start, item.duration)) : null}
              onChange={onStart}
              onCommit={(s) => { onStart(s); loop.setStart(s) }}
            />
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={playing ? 'Pausar trecho' : 'Ouvir trecho'}
              onPress={() => loop.toggle()}
              style={({ pressed }) => [styles.play, pressed && styles.pressed]}
            >
              {state.phase === 'loading' ? <ActivityIndicator color={colors.ink} /> : <Icon name={playing ? 'pausar' : 'tocar'} color={colors.ink} />}
            </Pressable>
          </View>
          )
        : null}
      {kind === 'track' ? <Text style={styles.notice}>A faixa inteira toca na publicação</Text> : null}
      {state.error ? <Text style={styles.notice} accessibilityLiveRegion='polite'>{state.error}</Text> : null}
    </ScrollView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { gap: space.md, paddingVertical: space.lg, alignItems: 'stretch' },
  cover: { alignItems: 'center' },
  title: { fontSize: 18, color: colors.ink, fontWeight: '700', textAlign: 'center' },
  artist: { fontSize: 15, color: colors.soft, textAlign: 'center' },
  snippet: { gap: space.md, alignItems: 'stretch' },
  play: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', backgroundColor: colors.bg },
  notice: { fontSize: 15, color: colors.soft, textAlign: 'center', paddingVertical: space.sm },
  pressed: { opacity: 0.7 }
})
