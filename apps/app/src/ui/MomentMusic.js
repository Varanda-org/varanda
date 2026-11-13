import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { audiusItem, audiusPlay } from '../account'
import { momentMusicOf } from '../moments'
import { MUSIC_SEEK_TEXT, MUSIC_SOURCE, clampStart, musicErrorText, seekReached, snippetEndMs, snippetTick } from '../music'
import { onSoundMute, setSoundMuted, soundMuted } from '../soundMute'
import { claimPlayback, playbackEpoch } from '../media/chatMedia'
import { createStreamPlayer } from '../media/stream'
import { Icon } from './Icon'
import { MusicCover } from './MusicCover'
import { useMusicCover } from './useMusicCover'
import { MusicEqualizer } from './MusicEqualizer'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space } from './theme'

export const momentMusicIdle = { item: null, phase: 'idle', error: '' }

export function createMomentPlayback (session, music, notify, { onStart, onUnavailable } = {}) {
  let state = momentMusicIdle
  let current = null
  let live = true
  let attempted = false
  let started = false
  let paused = false
  const publish = (patch) => {
    state = { ...state, ...patch }
    if (live) notify(state)
  }

  function dispose (job) {
    if (current === job) current = null
    job.controller.abort()
    clearTimeout(job.timer)
    for (const off of job.offs.splice(0)) off()
    if (job.player) { job.player.pause(); job.player.release() }
    if (job.unclaim) job.unclaim()
  }

  function stop () {
    if (current) dispose(current)
    publish({ phase: 'ended' })
  }

  function interrupt () {
    if (!current) return
    dispose(current)
    publish({ phase: 'gesture', error: '' })
  }

  function stale (job) {
    if (!live || current !== job) return true
    if (job.epoch === playbackEpoch()) return false
    interrupt()
    return true
  }

  function fail (job, error) {
    if (stale(job)) return
    dispose(job)
    publish({ phase: 'unavailable', error })
    onUnavailable?.(error)
  }

  function playbackError (job, err) {
    if (stale(job)) return
    // The stream reports autoplay refusals through onError, with the cause.
    if (job.phase === 'playing' && (err?.name === 'NotAllowedError' || err?.cause?.name === 'NotAllowedError')) {
      job.phase = 'gesture'
      clearTimeout(job.timer)
      job.player.pause()
      publish({ phase: 'gesture', error: '' })
      if (!started) onUnavailable?.(musicErrorText(err))
      return
    }
    const seekError = job.phase === 'seeking' && (err?.code === 'seek' || err?.code === 'seek-timeout')
    fail(job, seekError ? MUSIC_SEEK_TEXT : musicErrorText(err))
  }

  async function play (job) {
    if (stale(job) || paused || job.phase === 'playing') return
    job.phase = 'playing'
    publish({ phase: 'starting', error: '' })
    try {
      await job.player.play()
      if (stale(job)) return
      if (paused) job.player.pause()
    } catch (err) {
      playbackError(job, err)
    }
  }

  async function start (epoch = playbackEpoch()) {
    if (!live || attempted || epoch !== playbackEpoch()) return
    attempted = true
    const job = { epoch, controller: new AbortController(), player: null, offs: [], unclaim: null, timer: null, phase: 'loading' }
    current = job
    // Claim while loading too, so a late ticket cannot interrupt newer audio.
    const player = { pause: interrupt }
    job.unclaim = claimPlayback(player, { bound: true, epoch })
    publish({ phase: 'loading' })
    const ref = momentMusicOf({ music })
    if (!ref || session.origin === null) return fail(job, musicErrorText())
    const opts = { ...session, signal: job.controller.signal }
    try {
      const item = await audiusItem('track', ref.id, opts)
      if (stale(job)) return
      publish({ item })
      if (clampStart(ref.start, item.duration) !== ref.start) return fail(job, MUSIC_SEEK_TEXT)
      const startMs = ref.start * 1000
      const endMs = snippetEndMs(ref.start, item.duration)
      const { url, base } = await audiusPlay(ref.id, opts)
      if (stale(job)) return
      const stream = job.player = createStreamPlayer(url, { origin: base })
      job.offs.push(stream.onError((err) => playbackError(job, err)))
      job.offs.push(stream.onProgress((update) => {
        if (stale(job) || job.phase !== 'playing') return
        clearTimeout(job.timer)
        if (!seekReached(update.ms, startMs)) return fail(job, MUSIC_SEEK_TEXT)
        if (update.ended || snippetTick({ ms: update.ms, startMs, endMs }) === 'stop') return stop()
        if (update.playing && !update.buffering) {
          if (!started) { started = true; onStart?.() }
          if (stale(job)) return
          publish({ phase: 'playing' })
          job.timer = setTimeout(() => { if (!stale(job)) stop() }, Math.max(0, endMs - update.ms))
        }
      }))
      job.phase = 'seeking'
      await stream.seek(startMs)
      if (stale(job)) return
      // The resolved seek is the landing; an older progress sample is stale.
      if (snippetTick({ ms: startMs, startMs, endMs }) === 'stop') return fail(job, MUSIC_SEEK_TEXT)
      job.phase = 'paused'
      publish({ phase: 'paused' })
      await play(job)
      stale(job)
    } catch (err) {
      if (stale(job)) return
      if (err?.code === 'superseded' || err?.code === 'released') return stop()
      fail(job, job.phase === 'seeking' ? MUSIC_SEEK_TEXT : musicErrorText(err))
    }
  }

  function setPaused (value) {
    paused = value === true
    const job = current
    if (!job || stale(job) || !job.player || job.phase === 'seeking') return
    if (paused) {
      clearTimeout(job.timer)
      if (job.phase === 'playing') {
        job.phase = 'paused'
        job.player.pause()
        publish({ phase: 'paused' })
      }
    } else if (job.phase === 'paused') return play(job)
  }

  function press (epoch = playbackEpoch()) {
    if (!live || paused || epoch !== playbackEpoch()) return
    const job = current
    if (job && stale(job)) return
    if (state.phase !== 'gesture') return
    if (job) return play(job)
    attempted = false
    return start(epoch)
  }

  function release () {
    live = false
    if (current) dispose(current)
  }

  return { start, press, setPaused, release }
}

export function MomentMusic ({ music, member, origin, request, paused, onStart, onUnavailable, onOpenExternal }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [state, setState] = useState(momentMusicIdle)
  const [muted, setMuted] = useState(soundMuted())
  const [played, setPlayed] = useState(false)
  // Which playback set state and played. The reset effect lands on the next
  // render, so the render that first sees a new account still holds the old latch.
  const [coverOf, setCoverOf] = useState(null)
  const playback = useRef(null)
  const latest = useRef(null)
  latest.current = { paused: paused === true || muted, onStart, onUnavailable }
  const id = music?.id
  const start = music?.start
  useEffect(() => {
    const sync = () => setMuted(soundMuted())
    sync()
    return onSoundMute(sync)
  }, [])
  useEffect(() => {
    setState(momentMusicIdle)
    setPlayed(false)
    setCoverOf(null)
    const owner = { member, origin, id, start }
    const controller = createMomentPlayback({ member, origin, request }, { id, start }, (next) => {
      setState(next)
      setCoverOf(owner)
      if (next.phase === 'playing') setPlayed(true)
    }, {
      onStart: () => latest.current.onStart?.(),
      onUnavailable: (error) => latest.current.onUnavailable?.(error)
    })
    playback.current = controller
    controller.setPaused(latest.current.paused)
    // A muted momento spends no request and no daily play use.
    if (!soundMuted()) controller.start()
    return () => { controller.release(); playback.current = null }
  }, [id, start, member, origin, request])
  useEffect(() => {
    playback.current?.setPaused(paused === true || muted)
    if (!muted && paused !== true) playback.current?.start()
  }, [paused, muted])
  const { item, phase, error } = state
  // Mounted only when the operator's moments switch is on; a momento record
  // carries no image. Covers wait for playback, and a cover failure must never
  // call onUnavailable or touch the viewer's timers. The latch counts only
  // for the member, origin and track that set it.
  const samePlayback = coverOf !== null && coverOf.member === member && coverOf.origin === origin && coverOf.id === id && coverOf.start === start
  const uri = useMusicCover('track', samePlayback ? item : null, { member, origin, request }, samePlayback && played)
  const muteLabel = muted ? 'Ativar música' : 'Silenciar música'
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole='button' accessibilityLabel={muteLabel} accessibilityHint={item ? displayText(item.title) + ', ' + displayText(item.artist) : undefined} accessibilityState={{ selected: muted }} onPress={() => setSoundMuted(!muted)} style={item ? styles.sticker : styles.mute}>
        {item
          ? (
            <>
              <MusicCover size={36} uri={uri} />
              <View style={styles.meta}>
                <Text style={styles.title} numberOfLines={1}>{displayText(item.title)}</Text>
                <Text style={styles.artist} numberOfLines={1}>{displayText(item.artist)}</Text>
              </View>
              {muted
                ? <Icon name='mudo' size={16} color={colors.ink} />
                : <MusicEqualizer playing={phase === 'playing' && !muted} />}
            </>
            )
          : muted
            ? <Icon name='mudo' size={16} color={colors.ink} />
            : <Icon name='som' size={16} color={colors.ink} />}
      </Pressable>
      {item
        ? (
          <Pressable accessibilityRole='link' accessibilityLabel='Abrir no Audius' onPress={() => onOpenExternal?.(item.url)} style={styles.source}>
            <Icon name='externo' size={16} color={colors.ink} />
            <Text style={styles.text}>{MUSIC_SOURCE}</Text>
          </Pressable>
          )
        : null}
      {phase === 'gesture'
        ? <Pressable accessibilityRole='button' disabled={paused === true || muted} onPress={() => playback.current?.press(playbackEpoch())} style={styles.chip}><Text style={styles.text}>Tocar música</Text></Pressable>
        : null}
      {error ? <Text style={styles.text} accessibilityLiveRegion='polite'>{error}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  sticker: {
    flexShrink: 1,
    minHeight: layout.hit,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.card
  },
  // minWidth 0 lets a long title ellipsize instead of stretching the row.
  meta: { flexShrink: 1, minWidth: 0, flexDirection: 'column' },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: colors.ink },
  artist: { fontSize: 12, lineHeight: 16, color: colors.soft },
  source: {
    minWidth: layout.hit,
    minHeight: layout.hit,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.card
  },
  mute: {
    width: layout.hit,
    height: layout.hit,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    backgroundColor: colors.card
  },
  chip: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: colors.card },
  text: { fontSize: 13, lineHeight: 18, color: colors.ink }
})
