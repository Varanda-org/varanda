// A voice note inside its chat bubble (DMs and groups): a play / pause
// button, a progress bar that seeks on a tap, and the time left while
// playing and the total when paused.
// ChatMedia hands over the source state of the item (../media/chatMedia.js
// sourceFor): the player opens only that device-local URI (blob: or
// file://), never a network address, and no third-party player is involved
// (../media/audio createPlayer). One note plays at a time (claimPlayback
// pauses the one before). No waveform is drawn: one computed from the bytes
// would need them after they were wiped, and none is ever fetched.
//
// In a message request (state 'held') nothing is read until a tap, as with
// photos. 'Mídia indisponível' when the item cannot be opened; a read that
// may work later retries on a tap (a read, never a send).
//
// The total shown and the playback bound come from durationMs, the item's
// ms that chatMedia held to the container's samples, never from the player:
// a player may read another timeline from the file (an index, a decode
// time), so playback pauses once it passes durationMs + AUDIO_MS_TOLERANCE
// and no total above MAX_AUDIO_MS is ever shown. A player that reports no
// position, or a stuck one, cannot hold the note open: a wall-clock timer
// started with play() stops it once the time left to that bound has passed.
//
// Props: { state: 'held' | 'loading' | 'ok' | 'off', uri, retry, show,
//   durationMs, mine, onLongPress }

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { createPlayer } from '../media/audio'
import { claimPlayback } from '../media/chatMedia'
import { durationLabel } from '../media/voice'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { space } from './theme'

export const VOICE_WIDTH = 240
export const VOICE_HEIGHT = 52
export const VOICE_LABEL = 'Mensagem de voz'
const VOICE_UNAVAILABLE = 'Mídia indisponível'
const VOICE_TAP_TO_LOAD = 'Toque para ouvir'
const BUTTON = 36

// The checked ms, at most MAX_AUDIO_MS; 0 when there is none.
function checkedMs (ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), rpc.MAX_AUDIO_MS) : 0
}

export function VoiceBubble ({ state, uri, retry, show, durationMs = 0, mine = false, onLongPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const playerRef = useRef(null)
  const releaseClaim = useRef(() => {})
  const [pos, setPos] = useState(0)
  const total = checkedMs(durationMs)
  // Read by the progress listener, which lives as long as the player.
  const stopAt = useRef(0)
  stopAt.current = (total > 0 ? total : rpc.MAX_AUDIO_MS) + rpc.AUDIO_MS_TOLERANCE
  const [playing, setPlaying] = useState(false)
  const [trackWidth, setTrackWidth] = useState(0)
  const [ready, setReady] = useState(false)
  // The last finite position, the wall-clock backstop timer and its deadline
  // (0 when none runs), and what the backstop runs, set per player.
  const posRef = useRef(0)
  const backstop = useRef(null)
  const deadline = useRef(0)
  const stopRef = useRef(() => {})
  const claimRef = useRef(null)

  const clearBackstop = () => {
    if (backstop.current !== null) clearTimeout(backstop.current)
    backstop.current = null
    deadline.current = 0
  }

  const startBackstop = () => {
    clearBackstop()
    const left = Math.max(0, stopAt.current - posRef.current)
    deadline.current = Date.now() + left
    backstop.current = setTimeout(() => stopRef.current(), left)
  }

  useEffect(() => {
    if (state !== 'ok' || typeof uri !== 'string') return undefined
    let player
    try {
      player = createPlayer(uri)
    } catch {
      return undefined
    }
    playerRef.current = player
    // claimPlayback and stopPlayback pause through this, so the backstop of
    // a note paused by another one never fires later.
    claimRef.current = { pause: () => { clearBackstop(); player.pause() } }
    const finish = () => {
      clearBackstop()
      setPlaying(false)
      setPos(0)
      posRef.current = 0
      player.seek(0)
      releaseClaim.current()
    }
    stopRef.current = () => {
      player.pause()
      finish()
    }
    setReady(true)
    const off = player.onProgress((p) => {
      // Without a position, the wall clock decides.
      const over = Number.isFinite(p.ms) ? p.ms > stopAt.current : deadline.current > 0 && Date.now() >= deadline.current
      if (over && p.ended !== true) player.pause()
      setPlaying(p.playing === true && p.ended !== true && !over)
      if (p.ended === true || over) {
        finish()
      } else {
        if (Number.isFinite(p.ms)) posRef.current = p.ms
        setPos(p.ms)
      }
    })
    return () => {
      off()
      clearBackstop()
      stopRef.current = () => {}
      claimRef.current = null
      posRef.current = 0
      releaseClaim.current()
      releaseClaim.current = () => {}
      playerRef.current = null
      setReady(false)
      player.release()
      setPlaying(false)
      setPos(0)
    }
  }, [state, uri])

  const toggle = () => {
    const player = playerRef.current
    if (player === null) return
    if (playing) {
      clearBackstop()
      player.pause()
      releaseClaim.current()
      releaseClaim.current = () => {}
      return
    }
    // The pause of the previous note comes from claimPlayback; its own
    // progress event then flips its button back.
    releaseClaim.current = claimPlayback(claimRef.current)
    startBackstop()
    player.play()
  }

  const seek = (event) => {
    const player = playerRef.current
    const x = event && event.nativeEvent ? event.nativeEvent.locationX : NaN
    if (player === null || !(trackWidth > 0) || !(total > 0) || !Number.isFinite(x)) return
    const ms = Math.round(Math.max(0, Math.min(1, x / trackWidth)) * total)
    setPos(ms)
    posRef.current = ms
    player.seek(ms)
    // The time left to the bound changed with the position.
    if (backstop.current !== null) startBackstop()
  }

  const frame = [styles.box, mine && styles.boxMine]
  if (state === 'held' || (state === 'off' && typeof retry === 'function')) {
    const held = state === 'held'
    return (
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={held ? VOICE_LABEL + ', ' + VOICE_TAP_TO_LOAD.toLowerCase() : VOICE_UNAVAILABLE + ', toque para tentar de novo'}
        onPress={held ? show : retry}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({ pressed }) => [...frame, pressed && styles.pressed]}
      >
        <Icon name='microfone' size={20} color={colors.soft} />
        <Text style={styles.soft} numberOfLines={1}>{held ? VOICE_TAP_TO_LOAD : VOICE_UNAVAILABLE}</Text>
      </Pressable>
    )
  }
  if (state === 'off') {
    return (
      <View style={frame} accessible accessibilityLabel={VOICE_UNAVAILABLE}>
        <Icon name='microfone' size={20} color={colors.soft} />
        <Text style={styles.soft} numberOfLines={1}>{VOICE_UNAVAILABLE}</Text>
      </View>
    )
  }
  // Playing shows the time left, paused the total; with no known total, the
  // elapsed time as before.
  const shown = Math.min(pos, total > 0 ? total : rpc.MAX_AUDIO_MS)
  const left = Math.max(0, total - pos)
  const fill = total > 0 ? Math.max(0, Math.min(1, pos / total)) : 0
  return (
    <View style={frame} accessibilityLabel={VOICE_LABEL}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={playing ? 'Pausar' : 'Reproduzir'}
        accessibilityState={{ disabled: !(ready && state === 'ok'), busy: state === 'loading' }}
        disabled={!(ready && state === 'ok')}
        onPress={toggle}
        onLongPress={onLongPress}
        delayLongPress={350}
        hitSlop={4}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        {state === 'loading'
          ? <ActivityIndicator size='small' color={colors.accentInk} />
          : <Icon name={playing ? 'pausar' : 'tocar'} size={16} color={colors.accentInk} />}
      </Pressable>
      <View style={styles.body}>
        <Pressable
          accessible={false}
          onPress={seek}
          onLongPress={onLongPress}
          delayLongPress={350}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          style={styles.trackHit}
        >
          <View style={styles.track} pointerEvents='none'>
            <View style={[styles.fill, { width: (fill * 100) + '%' }]} />
          </View>
        </Pressable>
        <Text style={styles.time} accessibilityLabel={total > 0 ? (playing ? durationLabel(left) + ' restantes' : durationLabel(total)) : durationLabel(shown)}>
          {total > 0 ? durationLabel(playing ? left : total) : durationLabel(shown)}
        </Text>
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  box: {
    width: VOICE_WIDTH,
    height: VOICE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm
  },
  boxMine: { alignSelf: 'flex-end' },
  button: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: { flex: 1, minWidth: 0, justifyContent: 'center' },
  trackHit: { height: 20, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent },
  time: { fontSize: 12, lineHeight: 16, color: colors.soft, fontVariant: ['tabular-nums'] },
  soft: { flex: 1, fontSize: 13, lineHeight: 17, color: colors.soft },
  pressed: { opacity: 0.7 }
})
