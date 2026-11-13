import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { audiusItem, audiusPlay, audiusReady } from '../account'
import { MUSIC_FULL_LIST_TEXT, MUSIC_SEEK_TEXT, MUSIC_SOURCE, SNIPPET_BADGE, clampStart, musicErrorText, musicOriginOf, musicPartialText, queueIdle, queueStep, seekReached, snippetEndMs, snippetTick } from '../music'
import { claimPlayback, playbackEpoch } from '../media/chatMedia'
import { createStreamPlayer } from '../media/stream'
import { useHosted, useNode } from '../node'
import { openExternal } from '../openExternal'
import { LinkCard } from './LinkCard'
import { Icon } from './Icon'
import { MusicCover } from './MusicCover'
import { tap } from './haptics'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space } from './theme'
import { useMusicCover } from './useMusicCover'

// Keyboard events and tab order are DOM APIs; native uses accessibility actions.
const WEB = Platform.OS === 'web'

export const musicPlayerIdle = { item: null, queue: queueIdle, phase: 'idle', ms: 0, error: '', fallback: false }

export function musicPlayerTime (ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

// The claim covers pending requests too. Taking it aborts that attempt, so
// another card cannot be interrupted by an older ticket arriving late.
export function createMusicPlayback (session, music, notify) {
  let state = musicPlayerIdle
  let current = null
  let ticket = null
  let ready = false
  let live = true
  const snippet = music.kind === 'snippet'
  const playlist = music.kind === 'playlist'
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
    publish({ phase: 'idle' })
  }

  function stale (job) {
    if (!live || current !== job) return true
    if (job.epoch === playbackEpoch()) return false
    stop()
    return true
  }

  function fail (job, error) {
    if (stale(job)) return
    ticket = null
    dispose(job)
    publish({ phase: 'idle', error })
  }

  function begin (epoch) {
    if (current) dispose(current)
    if (!live || epoch !== playbackEpoch()) return null
    const job = { epoch, controller: new AbortController(), player: null, offs: [], unclaim: null, timer: null, phase: 'loading' }
    current = job
    const player = { pause: stop }
    job.unclaim = claimPlayback(player, { bound: true, epoch })
    publish({ phase: 'loading', error: '' })
    return job
  }

  async function start (epoch, fresh = false) {
    const job = begin(epoch)
    if (!job) return
    const opts = { ...session, signal: job.controller.signal }
    try {
      if (!ready) {
        const available = session.enabled && await audiusReady(opts)
        if (stale(job)) return
        if (!available) { stop(); publish({ fallback: true }); return }
        ready = true
      }
      if (!state.item) {
        const item = await audiusItem(playlist ? 'playlist' : 'track', music.id, opts)
        if (stale(job)) return
        publish({ item, queue: playlist ? queueStep(queueIdle, { type: 'load', tracks: item.tracks }) : queueIdle })
      }
      const item = playlist ? state.queue.tracks[state.queue.index] : state.item
      if (!item) return fail(job, musicErrorText())
      // A forged fragment cannot silently turn into a snippet from zero.
      if (snippet && clampStart(music.start, item.duration) !== music.start) return fail(job, MUSIC_SEEK_TEXT)
      const startMs = snippet ? music.start * 1000 : state.ms
      const endMs = snippet ? snippetEndMs(music.start, item.duration) : item.duration * 1000
      if (fresh || !ticket || ticket.id !== item.id || Date.parse(ticket.expiresAt) <= Date.now()) {
        const answer = await audiusPlay(item.id, opts)
        if (stale(job)) return
        ticket = { ...answer, id: item.id }
      }
      const { url, base } = ticket
      const player = job.player = createStreamPlayer(url, { origin: base })
      job.offs.push(player.onError((err) => {
        const seekError = job.phase === 'seeking' && (err?.code === 'seek' || err?.code === 'seek-timeout')
        fail(job, seekError ? MUSIC_SEEK_TEXT : musicErrorText(err))
      }))
      job.offs.push(player.onProgress((update) => {
        if (stale(job) || job.phase !== 'playing') return
        publish({ ms: update.ms })
        clearTimeout(job.timer)
        if (snippet) {
          if (!seekReached(update.ms, startMs)) return fail(job, MUSIC_SEEK_TEXT)
          if (update.ended || snippetTick({ ms: update.ms, startMs, endMs }) === 'stop') return stop()
          if (update.playing && !update.buffering) {
            job.timer = setTimeout(() => {
              if (!stale(job)) { publish({ ms: endMs }); stop() }
            }, Math.max(0, endMs - update.ms))
          }
        } else if (update.ended) {
          const epoch = job.epoch
          stop()
          if (playlist) {
            const queue = queueStep(state.queue, { type: 'ended' })
            publish({ queue, ms: 0 })
            if (!queue.done) start(epoch, true)
          } else publish({ ms: 0 })
        }
      }))
      if (snippet || startMs > 0) {
        job.phase = 'seeking'
        await player.seek(startMs)
        if (stale(job)) return
        // A resolved seek confirms the target, even without a new progress event.
        if (snippet && snippetTick({ ms: startMs, startMs, endMs }) === 'stop') return fail(job, MUSIC_SEEK_TEXT)
      }
      job.phase = 'playing'
      publish({ phase: 'playing', ms: startMs })
      await player.play()
      stale(job)
    } catch (err) {
      if (stale(job)) return
      if (err?.code === 'superseded' || err?.code === 'released') return stop()
      fail(job, job.phase === 'seeking' ? MUSIC_SEEK_TEXT : musicErrorText(err))
    }
  }

  async function press (epoch = playbackEpoch()) {
    if (!live || epoch !== playbackEpoch()) return
    if (current && state.phase === 'loading') return stop()
    if (current && state.phase === 'playing') {
      if (snippet) return stop()
      current.phase = 'paused'
      clearTimeout(current.timer)
      current.player.pause()
      publish({ phase: 'paused' })
      return
    }
    if (current && state.phase === 'paused' && Date.parse(ticket.expiresAt) > Date.now()) {
      const job = current
      if (stale(job)) return
      job.phase = 'playing'
      publish({ phase: 'playing' })
      await job.player.play()
      stale(job)
      return
    }
    if (playlist && state.queue.done) publish({ queue: queueStep(state.queue, { type: 'select', index: 0 }), ms: 0 })
    return start(epoch)
  }

  function pressStep (type) {
    const epoch = playbackEpoch()
    const queue = queueStep(state.queue, { type })
    if (queue === state.queue) return
    stop()
    publish({ queue, ms: 0 })
    return start(epoch, true)
  }

  async function pressSeek (ms) {
    if (snippet || state.phase === 'loading' || !Number.isFinite(ms)) return
    const item = playlist ? state.queue.tracks[state.queue.index] : state.item
    if (!item) return
    const target = Math.max(0, Math.min(ms, item.duration * 1000))
    publish({ ms: target })
    const job = current
    if (!job || stale(job)) return
    const resume = job.phase === 'playing'
    job.phase = 'seeking'
    job.player.pause()
    publish({ phase: 'loading' })
    try {
      await job.player.seek(target)
      if (stale(job)) return
      job.phase = resume ? 'playing' : 'paused'
      publish({ phase: job.phase, ms: target })
      if (resume) {
        await job.player.play()
        stale(job)
      }
    } catch (err) {
      if (stale(job)) return
      if (err?.code === 'superseded' || err?.code === 'released') return stop()
      fail(job, MUSIC_SEEK_TEXT)
    }
  }

  function release () {
    live = false
    if (current) dispose(current)
    ticket = null
  }

  return { press, pressStep, pressSeek, release }
}

export function useMusicAvailable (node, member, refreshKey) {
  const enabled = musicOriginOf(node) !== null
  const origin = node?.accountOrigin || musicOriginOf(node)
  const [result, setResult] = useState(null)
  useEffect(() => {
    let live = true
    setResult((previous) => previous?.member === member && previous?.origin === origin ? previous : null)
    if (enabled) {
      audiusReady({ member, origin }).then((ok) => {
        if (live) setResult({ member, origin, ok: ok === true })
      }, () => {
        if (live) setResult({ member, origin, ok: false })
      })
    }
    return () => { live = false }
  }, [enabled, member, origin, refreshKey])
  if (!enabled) return false
  return result?.member === member && result?.origin === origin ? result.ok : null
}

export function MusicPlayerCard ({ card, music, onLongPress }) {
  const hosted = useHosted()
  if (hosted !== true) return <LinkCard card={card} onLongPress={onLongPress} />
  return <MusicPlayerEntry key={card.url} card={card} music={music} onLongPress={onLongPress} />
}

function MusicPlayerEntry ({ card, music, onLongPress }) {
  const [epoch, setEpoch] = useState(null)
  if (epoch !== null) return <ActiveMusicPlayer card={card} music={music} onLongPress={onLongPress} epoch={epoch} />
  return <MusicCardView card={card} music={music} onLongPress={onLongPress} onPress={() => setEpoch(playbackEpoch())} />
}

function ActiveMusicPlayer ({ card, music, onLongPress, epoch }) {
  const node = useNode()
  const member = node.passkey && node.passkey.status && typeof node.passkey.status.publicKey === 'string'
    ? node.passkey.status.publicKey.toLowerCase()
    : null
  const enabled = musicOriginOf(node) !== null
  const origin = node.accountOrigin || musicOriginOf(node)
  const request = node.request
  const [state, setState] = useState(musicPlayerIdle)
  const initialTap = useRef(true)
  const playback = useMemo(() => {
    // The reset effect below lands on the next render. Stamp the playback
    // that produced this state so the render that first sees a new account
    // does not ask for the previous item.
    const coverOf = { member, origin, kind: music.kind, id: music.id, start: music.start }
    return createMusicPlayback({ member, origin, request, enabled }, music, (next) => setState({ ...next, coverOf }))
  }, [member, origin, request, enabled, music.kind, music.id, music.start])
  useEffect(() => {
    setState(musicPlayerIdle)
    // Mounting consumes the tap once; changing account never starts playback.
    if (initialTap.current) { initialTap.current = false; playback.press(epoch) }
    return () => playback.release()
  }, [playback, epoch])
  // Protocol rule: nothing before the tap. After it the card may ask the
  // association for the cover and shows it while it is active; the cover is
  // never stored. The item is the answer to the tap's request, and only when
  // it belongs to this member, origin and music.
  const owned = state.coverOf
  const samePlayback = owned && owned.member === member && owned.origin === origin && owned.kind === music.kind && owned.id === music.id && owned.start === music.start
  const cover = useMusicCover(music.kind === 'playlist' ? 'playlist' : 'track', samePlayback ? state.item : null, { member, origin, request })
  if (!enabled || state.fallback) return <LinkCard card={card} onLongPress={onLongPress} />
  return <MusicCardView card={card} music={music} onLongPress={onLongPress} coverUri={cover} state={state} onPress={() => playback.press()} onStep={(type) => playback.pressStep(type)} onSeek={(ms) => playback.pressSeek(ms)} />
}

function MusicCardView ({ card, music, onLongPress, coverUri, state = musicPlayerIdle, onPress, onStep, onSeek }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [expanded, setExpanded] = useState(false)
  const { item, queue, phase, error, ms } = state
  const playlist = music.kind === 'playlist'
  const snippet = music.kind === 'snippet'
  const track = playlist ? queue.tracks[queue.index] : item
  const partial = musicPartialText(item)
  const durationMs = snippet ? snippetEndMs(music.start, track?.duration) - music.start * 1000 : (track?.duration || 0) * 1000
  // A short track plays less than the stored 15 s, but only after it loads.
  const badgeText = snippet && item && durationMs < 15000 ? Math.max(1, Math.round(durationMs / 1000)) + ' s' : SNIPPET_BADGE
  const elapsed = snippet ? Math.max(0, ms - music.start * 1000) : ms
  const label = phase === 'loading' ? 'Cancelar' : phase === 'playing' ? (snippet ? 'Parar trecho' : 'Pausar') : error ? 'Tentar de novo' : snippet ? 'Ouvir trecho' : playlist ? 'Ouvir playlist' : 'Ouvir'
  const Title = typeof onLongPress === 'function' ? Pressable : View
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <MusicCover size={56} uri={coverUri} />
        <Title style={styles.details} {...(typeof onLongPress === 'function' ? { onLongPress, delayLongPress: 350 } : null)}>
          <Text style={styles.title} numberOfLines={1}>{item ? displayText(item.title) : displayText(card.title)}</Text>
          <Text style={styles.text} numberOfLines={1}>{item ? displayText(item.artist) : displayText(card.desc)}</Text>
          <View style={styles.meta}>
            {snippet ? <Text style={styles.badge}>{badgeText}</Text> : null}
            <Text style={styles.text}>{MUSIC_SOURCE}</Text>
          </View>
        </Title>
        <MusicButton label={label} round busy={phase === 'loading'} icon={phase === 'playing' ? (snippet ? 'parar' : 'pausar') : 'tocar'} onPress={() => { tap('select'); onPress() }} />
      </View>
      {playlist && track
        ? <View><Text style={styles.title}>{displayText(track.title)}</Text><Text style={styles.text}>{displayText(track.artist)}</Text></View>
        : null}
      {track
        ? <MusicProgress ms={elapsed} durationMs={durationMs} onSeek={snippet ? undefined : onSeek} />
        : null}
      {error ? <Text style={styles.text} accessibilityLiveRegion='polite'>{error}</Text> : null}
      <Pressable accessibilityRole='link' onPress={() => openExternal(item ? item.url : card.url)} onLongPress={onLongPress} style={styles.external}>
        <Icon name='externo' size={14} color={colors.accent} />
        <Text style={styles.externalText}>Abrir no Audius</Text>
      </Pressable>
      {playlist && item
        ? (
          <View style={styles.actions}>
            <MusicButton label='Anterior' icon='anterior' disabled={queue.index <= 0} onPress={() => onStep('prev')} />
            <MusicButton label='Próxima' icon='proxima' disabled={queue.index < 0 || queue.index >= queue.tracks.length - 1} onPress={() => onStep('next')} />
          </View>
          )
        : null}
      {playlist && item
        ? (
          <View>
            <MusicButton label={expanded ? 'Ocultar faixas' : 'Mostrar faixas'} onPress={() => setExpanded(!expanded)} expanded={expanded} />
            {expanded ? queue.tracks.map((entry, index) => <Text key={index} style={styles.text}>{displayText(entry.title)}</Text>) : null}
            {partial
              ? <View><Text style={styles.text}>{partial}</Text><Pressable accessibilityRole='link' onPress={() => openExternal(item.url)} style={styles.button}><Text style={styles.link}>{MUSIC_FULL_LIST_TEXT}</Text></Pressable></View>
              : null}
          </View>
          )
        : null}
    </View>
  )
}

function MusicButton ({ label, onPress, disabled = false, expanded, icon, round = false, busy = false }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const color = round ? colors.accentInk : colors.accent
  return (
    <Pressable accessibilityRole='button' accessibilityLabel={label} accessibilityState={{ disabled, expanded }} aria-expanded={expanded} disabled={disabled} onPress={onPress} style={[styles.button, icon && !round && !busy && styles.iconOnly, round && styles.round, disabled && styles.disabled]}>
      {busy ? <ActivityIndicator color={color} /> : icon ? <Icon name={icon} size={20} color={color} /> : <Text style={styles.link}>{label}</Text>}
    </Pressable>
  )
}

function MusicProgress ({ ms, durationMs, onSeek }) {
  const styles = useStyles(makeStyles)
  const width = useRef(0)
  const anchor = useRef(0)
  const value = Math.min(durationMs, Math.max(0, ms))
  const latest = useRef(null)
  latest.current = { durationMs, onSeek }
  const responder = useRef(null)
  if (!responder.current) {
    responder.current = PanResponder.create({
      onStartShouldSetPanResponder: () => !!latest.current.onSeek,
      onMoveShouldSetPanResponder: () => !!latest.current.onSeek,
      onPanResponderGrant: (event) => { anchor.current = event.nativeEvent.locationX },
      onPanResponderRelease: (event, gesture) => {
        const { onSeek, durationMs } = latest.current
        if (onSeek && width.current > 0) onSeek(Math.max(0, Math.min(1, (anchor.current + gesture.dx) / width.current)) * durationMs)
      }
    })
  }
  const text = musicPlayerTime(value) + ' / ' + musicPlayerTime(durationMs)
  const onKeyDown = (event) => {
    const key = event.nativeEvent ? event.nativeEvent.key : event.key
    const targets = { ArrowLeft: value - 5000, ArrowDown: value - 5000, ArrowRight: value + 5000, ArrowUp: value + 5000, Home: 0, End: durationMs }
    if (!Object.hasOwn(targets, key)) return
    try { event.preventDefault() } catch {}
    try { event.stopPropagation() } catch {}
    onSeek(Math.max(0, Math.min(durationMs, targets[key])))
  }
  return (
    <View>
      <View
        {...responder.current.panHandlers}
        accessible
        accessibilityRole={onSeek ? 'adjustable' : 'progressbar'}
        accessibilityLabel='Progresso da música'
        accessibilityValue={{ min: 0, max: durationMs, now: value, text }}
        aria-valuemin={0}
        aria-valuemax={durationMs}
        aria-valuenow={value}
        aria-valuetext={musicPlayerTime(value) + ' de ' + musicPlayerTime(durationMs)}
        {...(WEB && onSeek ? { tabIndex: 0, onKeyDown } : null)}
        accessibilityActions={onSeek ? [{ name: 'increment', label: 'Avançar cinco segundos' }, { name: 'decrement', label: 'Voltar cinco segundos' }] : []}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName
          if (onSeek && (action === 'increment' || action === 'decrement')) onSeek(Math.max(0, Math.min(durationMs, value + (action === 'increment' ? 5000 : -5000))))
        }}
        onLayout={(event) => { width.current = event.nativeEvent.layout.width }}
        style={styles.slider}
      >
        <View pointerEvents='none' style={styles.rail}><View style={[styles.fill, { width: (durationMs > 0 ? value / durationMs * 100 : 0) + '%' }]} /></View>
      </View>
      <Text style={styles.text}>{text}</Text>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { marginTop: space.sm, padding: space.md, gap: space.xs, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.card },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  details: { flex: 1, minWidth: 0 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  badge: { fontSize: 11, lineHeight: 16, paddingHorizontal: space.xs, borderRadius: radius.sm, backgroundColor: colors.bg, color: colors.soft },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', backgroundColor: colors.accent },
  external: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: layout.hit },
  externalText: { fontSize: 13, color: colors.accent },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.ink },
  text: { fontSize: 13, lineHeight: 18, color: colors.soft },
  link: { fontSize: 14, color: colors.accent },
  button: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.sm },
  iconOnly: { minWidth: layout.hit, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  disabled: { opacity: 0.4 },
  slider: { minHeight: layout.hit, justifyContent: 'center' },
  rail: { height: 3, borderRadius: 2, backgroundColor: colors.line },
  fill: { height: 3, borderRadius: 2, backgroundColor: colors.accent }
})
