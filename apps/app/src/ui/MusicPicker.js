import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import rpc from '@varanda/rpc'
import { audiusPlay, audiusSearch } from '../account'
import { MUSIC_DEBOUNCE_MS, MUSIC_EMPTY_TEXT, MUSIC_SEEK_TEXT, SNIPPET_S, clampStart, maxStart, musicErrorText, musicQuery, snippetTick } from '../music'
import { claimPlayback, playbackEpoch } from '../media/chatMedia'
import { createStreamPlayer } from '../media/stream'
import { Btn } from './index'
import { Icon } from './Icon'
import { Segmented } from './Segmented'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, webInputReset } from './theme'

const { displayText } = rpc
// Keyboard events and tab order are DOM APIs; native uses accessibility actions.
const WEB = Platform.OS === 'web'
const DEFAULT_MODES = ['snippet', 'track', 'playlist']
const SEARCH_KINDS = [{ id: 'track', label: 'Faixas' }, { id: 'playlist', label: 'Playlists' }]

export const musicSearchIdle = { text: '', query: '', kind: 'track', gen: 0, phase: 'idle', items: [], next: null, error: '' }

export function musicSearchStep (state, action) {
  switch (action.type) {
    case 'query': {
      const query = musicQuery(action.text)
      if (state.text === action.text && state.kind === action.kind) return state
      return { ...musicSearchIdle, text: action.text, query, kind: action.kind, gen: state.gen + 1, phase: query ? 'waiting' : 'idle' }
    }
    case 'retry':
      return state.query ? { ...state, gen: state.gen + 1, phase: 'waiting', items: [], next: null, error: '' } : state
    case 'more':
      return state.phase === 'ready' && state.next !== null
        ? { ...state, gen: state.gen + 1, phase: 'more', error: '' }
        : state
    case 'loading':
      return action.gen === state.gen ? { ...state, phase: 'loading' } : state
    case 'page': {
      if (action.gen !== state.gen) return state
      const items = state.phase === 'more' ? [...state.items] : []
      const ids = new Set(items.map((item) => item.id))
      for (const item of action.page.items) {
        if (!ids.has(item.id)) { ids.add(item.id); items.push(item) }
      }
      return { ...state, phase: 'ready', items, next: action.page.next, error: '' }
    }
    case 'fail':
      return action.gen === state.gen ? { ...state, phase: 'error', next: null, error: musicErrorText(action.error) } : state
    default:
      return state
  }
}

export function musicTime (seconds) {
  const s = Math.max(0, Math.floor(seconds))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

export function musicStartAt (x, width, duration) {
  return width > 0 ? clampStart(Math.round(x / width * maxStart(duration)), duration) : 0
}

export function musicPickStep (kind, modes) {
  if (kind === 'playlist') return modes.includes('playlist') ? 'playlist' : null
  if (modes.includes('snippet')) return modes.includes('track') ? 'choose' : 'snippet'
  return modes.includes('track') ? 'track' : null
}

// The ticket survives start adjustments, but never the picker or its session.
// Each attempt owns its player so a late completion cannot release a newer one.
export function createSnippetPreview (session, notify) {
  let current = null
  let ticket = null

  function dispose (job) {
    job.controller.abort()
    clearTimeout(job.timer)
    for (const off of job.offs.splice(0)) off()
    if (job.player) { job.player.pause(); job.player.release() }
    if (job.unclaim) job.unclaim()
    if (current === job) current = null
  }

  function stop () {
    if (current) dispose(current)
    notify({ phase: 'idle', error: '' })
  }

  function release () {
    if (current) dispose(current)
    ticket = null
  }

  async function play (item, start) {
    const epoch = playbackEpoch()
    stop()
    const startMs = clampStart(start, item.duration) * 1000
    const endMs = Math.min(startMs + SNIPPET_S * 1000, item.duration * 1000)
    const job = { controller: new AbortController(), player: null, offs: [], unclaim: null, timer: null, phase: 'loading' }
    current = job
    notify({ phase: 'loading', error: '' })
    const stale = () => {
      if (current !== job) return true
      if (epoch === playbackEpoch()) return false
      dispose(job)
      notify({ phase: 'idle', error: '' })
      return true
    }
    const fail = (text) => {
      if (stale()) return
      ticket = null
      dispose(job)
      notify({ phase: 'idle', error: text })
    }
    try {
      if (!ticket || ticket.id !== item.id || Date.parse(ticket.expiresAt) <= Date.now()) {
        const answer = await audiusPlay(item.id, { ...session, signal: job.controller.signal })
        if (stale()) return
        ticket = { ...answer, id: item.id }
      }
      const { url, base } = ticket
      const player = job.player = createStreamPlayer(url, { origin: base })
      job.offs.push(player.onError((err) => {
        const seekError = job.phase === 'seeking' && (err?.code === 'seek' || err?.code === 'seek-timeout')
        fail(seekError ? MUSIC_SEEK_TEXT : musicErrorText(err))
      }))
      job.offs.push(player.onProgress((update) => {
        if (stale() || job.phase !== 'playing') return
        clearTimeout(job.timer)
        if (update.ended || snippetTick({ ms: update.ms, startMs, endMs }) === 'stop') return stop()
        if (update.playing && !update.buffering) job.timer = setTimeout(stop, Math.max(0, endMs - update.ms))
      }))
      job.unclaim = claimPlayback({ pause: stop }, { bound: true, epoch })
      job.phase = 'seeking'
      await player.seek(startMs)
      if (stale()) return
      // A resolved seek confirms the target, even without a new progress event.
      if (snippetTick({ ms: startMs, startMs, endMs }) === 'stop') return fail(MUSIC_SEEK_TEXT)
      job.phase = 'playing'
      notify({ phase: 'playing', error: '' })
      await player.play()
      stale()
    } catch (err) {
      if (stale()) return
      if (err?.code === 'superseded' || err?.code === 'released') return stop()
      fail(job.phase === 'seeking' ? MUSIC_SEEK_TEXT : musicErrorText(err))
    }
  }

  return { play, stop, release }
}

export function MusicPicker ({ open, onClose, onPick, member, origin, request, modes = DEFAULT_MODES }) {
  const stopRef = useRef(null)
  const close = () => { stopRef.current?.(); onClose() }
  return (
    <Sheet open={open} onClose={close} title='Música'>
      {open ? <MusicContent onClose={close} onPick={onPick} member={member} origin={origin} request={request} modes={modes} stopRef={stopRef} /> : null}
    </Sheet>
  )
}

function MusicContent ({ onClose, onPick, member, origin, request, modes, stopRef }) {
  const styles = useStyles(makeStyles)
  const [selected, setSelected] = useState(null)
  const [step, setStep] = useState('search')
  const [start, setStart] = useState(0)
  const [status, setStatus] = useState({ phase: 'idle', error: '' })
  const preview = useMemo(() => createSnippetPreview({ member, origin, request }, setStatus), [member, origin, request])
  useEffect(() => {
    stopRef.current = preview.release
    setSelected(null)
    setStep('search')
    setStatus({ phase: 'idle', error: '' })
    return () => { preview.release(); stopRef.current = null }
  }, [preview, stopRef])

  const pick = (kind, item = selected) => {
    preview.release()
    onPick({ ref: { kind, id: item.id, start: kind === 'snippet' ? clampStart(start, item.duration) : null }, item })
    onClose()
  }
  const select = (item, kind) => {
    const next = musicPickStep(kind, modes)
    if (next === null) return
    preview.release()
    setStatus({ phase: 'idle', error: '' })
    if (next === 'playlist' || next === 'track') return pick(next, item)
    setSelected(item)
    setStart(0)
    setStep(next)
  }
  const changeStart = (value) => { preview.stop(); setStart(clampStart(value, selected.duration)) }
  const back = () => { preview.release(); setSelected(null); setStep('search') }
  return (
    <View style={styles.root}>
      <View style={step === 'search' ? styles.search : styles.hidden}>
        <MusicSearch member={member} origin={origin} request={request} modes={modes} onSelect={select} />
      </View>
      {step !== 'search'
        ? (
          <ScrollView contentContainerStyle={styles.detail} keyboardShouldPersistTaps='handled'>
            <Btn label='Voltar à busca' secondary onPress={back} />
            <MusicLabel item={selected} />
            {step === 'choose'
              ? (
                <View style={styles.actions}>
                  <Btn label='Trecho de 15 s' onPress={() => setStep('snippet')} />
                  <Btn label='Faixa inteira' secondary onPress={() => pick('track')} />
                </View>
                )
              : (
                <View style={styles.actions}>
                  <StartPicker duration={selected.duration} start={start} onChange={changeStart} />
                  {status.error ? <Text style={styles.notice} accessibilityLiveRegion='polite'>{status.error}</Text> : null}
                  <Btn label={status.phase === 'idle' ? 'Ouvir trecho' : 'Parar trecho'} secondary onPress={() => status.phase === 'idle' ? preview.play(selected, start) : preview.stop()} />
                  <Btn label='Usar este trecho' onPress={() => pick('snippet')} />
                </View>
                )}
          </ScrollView>
          )
        : null}
      <Text style={styles.footer}>Músicas do Audius</Text>
    </View>
  )
}

function MusicLabel ({ item }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.label}>
      <Icon name='music' color={colors.soft} />
      <View style={styles.words}>
        <Text style={styles.title}>{displayText(item.title)}</Text>
        <Text style={styles.artist}>{displayText(item.artist)}</Text>
        <Text style={styles.artist}>{item.duration !== undefined ? musicTime(item.duration) : item.count + (item.count === 1 ? ' faixa' : ' faixas')}</Text>
      </View>
    </View>
  )
}

function MusicSearch ({ member, origin, request, modes, onSelect }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const track = modes.includes('snippet') || modes.includes('track')
  const playlist = modes.includes('playlist')
  const [state, dispatch] = useReducer(musicSearchStep, { ...musicSearchIdle, kind: track ? 'track' : 'playlist' })
  const { gen, query, kind, phase, next } = state
  useEffect(() => { dispatch({ type: 'retry' }) }, [member, origin, request])
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'more') return
    let live = true
    const controller = new AbortController()
    const load = () => {
      if (phase !== 'more') dispatch({ type: 'loading', gen })
      audiusSearch(query, { kind, cursor: phase === 'more' ? next : undefined, member, origin, request, signal: controller.signal }).then(
        (page) => { if (live) dispatch({ type: 'page', gen, page }) },
        (error) => { if (live) dispatch({ type: 'fail', gen, error }) }
      )
    }
    const timer = setTimeout(load, phase === 'more' ? 0 : MUSIC_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer); controller.abort() }
    // A generation starts at the keystroke, before the debounce can finish.
  }, [gen, member, origin, request])
  const notice = state.error || (phase === 'ready' && state.items.length === 0 ? MUSIC_EMPTY_TEXT : '')
  return (
    <View style={styles.search}>
      <View style={styles.searchRow}>
        <Icon name='lupa' size={18} color={colors.soft} />
        <TextInput
          value={state.text}
          onChangeText={(text) => dispatch({ type: 'query', text, kind })}
          style={[styles.input, webInputReset]}
          placeholder='Buscar música'
          placeholderTextColor={colors.placeholder}
          accessibilityLabel='Buscar música'
          autoCapitalize='none'
          autoCorrect={false}
          autoFocus
          returnKeyType='search'
        />
      </View>
      {playlist ? <Segmented options={track ? SEARCH_KINDS : SEARCH_KINDS.slice(1)} selected={kind} onSelect={(kind) => dispatch({ type: 'query', text: state.text, kind })} /> : null}
      {notice ? <Text style={styles.notice} accessibilityLiveRegion='polite'>{notice}</Text> : null}
      {phase === 'error' ? <Btn label='Tentar de novo' secondary onPress={() => dispatch({ type: 'retry' })} /> : null}
      {phase === 'loading' ? <ActivityIndicator style={styles.spinner} color={colors.soft} /> : null}
      <FlatList
        data={state.items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps='handled'
        onEndReachedThreshold={0.6}
        onEndReached={() => dispatch({ type: 'more' })}
        ListFooterComponent={phase === 'more' ? <ActivityIndicator style={styles.spinner} color={colors.soft} /> : null}
        renderItem={({ item }) => (
          <Pressable accessibilityRole='button' onPress={() => onSelect(item, kind)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <MusicLabel item={item} />
          </Pressable>
        )}
      />
    </View>
  )
}

function StartPicker ({ duration, start, onChange }) {
  const styles = useStyles(makeStyles)
  const width = useRef(0)
  const anchor = useRef(0)
  const latest = useRef(null)
  const responder = useRef(null)
  latest.current = { duration, onChange }
  const max = maxStart(duration)
  const end = Math.min(start + SNIPPET_S, duration)
  const windowText = musicTime(start) + ' - ' + musicTime(end)
  const onKeyDown = (event) => {
    const key = event.nativeEvent ? event.nativeEvent.key : event.key
    const targets = { ArrowLeft: start - 1, ArrowDown: start - 1, ArrowRight: start + 1, ArrowUp: start + 1, Home: 0, End: max }
    if (!Object.hasOwn(targets, key)) return
    try { event.preventDefault() } catch {}
    try { event.stopPropagation() } catch {}
    onChange(clampStart(targets[key], duration))
  }
  if (responder.current === null) {
    const move = (x) => latest.current.onChange(musicStartAt(x, width.current, latest.current.duration))
    responder.current = PanResponder.create({
      onStartShouldSetPanResponder: () => maxStart(latest.current.duration) > 0,
      onMoveShouldSetPanResponder: () => maxStart(latest.current.duration) > 0,
      onPanResponderGrant: (event) => {
        anchor.current = event.nativeEvent.locationX
        move(anchor.current)
      },
      onPanResponderMove: (event, gesture) => move(anchor.current + gesture.dx)
    })
  }
  return (
    <View>
      <Text style={styles.notice}>{windowText}</Text>
      <View
        {...responder.current.panHandlers}
        accessible
        accessibilityRole='adjustable'
        accessibilityLabel='Início do trecho'
        accessibilityValue={{ min: 0, max, now: start, text: windowText }}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={start}
        aria-valuetext={windowText}
        {...(WEB ? { tabIndex: 0, onKeyDown } : null)}
        accessibilityActions={[{ name: 'increment', label: 'Avançar um segundo' }, { name: 'decrement', label: 'Voltar um segundo' }]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName
          if (action === 'increment' || action === 'decrement') onChange(clampStart(start + (action === 'increment' ? 1 : -1), duration))
        }}
        onLayout={(event) => { width.current = event.nativeEvent.layout.width }}
        style={styles.slider}
      >
        <View pointerEvents='none' style={styles.rail} />
        <View pointerEvents='none' style={[styles.thumb, { left: (max > 0 ? start / max * 100 : 0) + '%' }]} />
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.lg },
  search: { flex: 1 },
  hidden: { display: 'none' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: layout.hit, paddingHorizontal: space.md, borderRadius: radius.lg, backgroundColor: colors.bg },
  input: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: space.sm, color: colors.ink },
  list: { paddingVertical: space.sm },
  row: { minHeight: layout.hit, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  label: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  words: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, color: colors.ink, fontWeight: '600' },
  artist: { fontSize: 14, color: colors.soft },
  notice: { fontSize: 15, color: colors.soft, textAlign: 'center', paddingVertical: space.md },
  footer: { fontSize: 13, color: colors.soft, textAlign: 'center', paddingVertical: space.md },
  spinner: { paddingVertical: space.md },
  detail: { gap: space.lg, paddingVertical: space.md },
  actions: { gap: space.md },
  slider: { minHeight: layout.hit, justifyContent: 'center', marginHorizontal: space.md },
  rail: { height: 4, borderRadius: 2, backgroundColor: colors.line },
  thumb: { position: 'absolute', width: 24, height: 24, marginLeft: -12, borderRadius: 12, backgroundColor: colors.accent },
  pressed: { opacity: 0.7 }
})
