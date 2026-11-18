import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import rpc from '@varanda/rpc'
import { audiusItem, audiusPlay, audiusSearch, audiusTrending } from '../account'
import { MUSIC_DEBOUNCE_MS, MUSIC_EMPTY_TEXT, MUSIC_RECENTS_CLEAR_FAIL_TEXT, MUSIC_RECENTS_CLEAR_LABEL, MUSIC_RECENTS_CLEAR_TEXT, MUSIC_RECENTS_TEXT, MUSIC_SEEK_TEXT, MUSIC_SUGGEST_EMPTY_TEXT, MUSIC_SUGGEST_TEXT, SNIPPET_S, clampStart, musicErrorText, musicGenreChips, musicQuery, musicRowLine, snippetTick } from '../music'
import { MUSIC_RECENTS_SHOWN, musicGenreOrder, musicTopGenre } from '../musicRecents'
import { listMusicRecents, clearMusicRecentsOf } from '../musicRecentsStore'
import { claimPlayback, playbackEpoch } from '../media/chatMedia'
import { createStreamPlayer } from '../media/stream'
import { Btn } from './index'
import { FilterChips } from './FilterChips'
import { tap } from './haptics'
import { Icon } from './Icon'
import { MusicCover } from './MusicCover'
import { useMusicCover } from './useMusicCover'
import { MusicEditor } from './MusicEditor'
import { Pill } from './Pill'
import { Segmented } from './Segmented'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, webInputReset } from './theme'

const { displayText } = rpc
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

export const musicSuggestIdle = { phase: 'idle', gen: 0, key: '', genres: true, items: [], error: '' }

export function musicSuggestStep (state, action) {
  switch (action.type) {
    case 'genre':
      if (state.phase === 'off' || action.key === state.key) return state
      return { ...state, key: action.key, phase: 'loading', gen: state.gen + 1, items: [], error: '' }
    case 'load':
      return state.phase === 'idle' ? { ...state, phase: 'loading', gen: state.gen + 1 } : state
    case 'retry':
      return state.phase === 'error' ? { ...state, phase: 'loading', gen: state.gen + 1, error: '' } : state
    case 'page': {
      if (state.phase !== 'loading' || action.gen !== state.gen) return state
      const items = []
      const ids = new Set()
      for (const item of action.page.items) {
        if (ids.has(item.id)) continue
        ids.add(item.id)
        items.push(item)
      }
      return { ...state, phase: 'ready', items }
    }
    case 'fail':
      if (state.phase !== 'loading' || action.gen !== state.gen) return state
      if (action.extended === true && action.error?.code === 'pedido-invalido') {
        if (state.key !== '') return { ...state, key: '', genres: false, phase: 'idle', items: [], error: '' }
        return { ...state, phase: 'off', items: [], error: '' }
      }
      if (action.error?.code === 'feature-off' || action.error?.code === 'nao-encontrado') {
        return { ...state, phase: 'off', items: [], error: '' }
      }
      return { ...state, phase: 'error', error: musicErrorText(action.error) }
    case 'reset':
      return { ...state, phase: 'idle', key: action.key ?? '', genres: true, items: [], error: '', gen: state.gen + 1 }
    default:
      return state
  }
}

export function musicSuggestShown (search) {
  return search.query === ''
}

export function musicPickStep (kind, modes) {
  if (kind === 'playlist') return modes.includes('playlist') ? 'edit' : null
  return modes.includes('snippet') || modes.includes('track') ? 'edit' : null
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

export function MusicPicker ({ open, onClose, onPick, member, origin, request, modes = DEFAULT_MODES, initial = null }) {
  const stopRef = useRef(null)
  const editRef = useRef(null)
  // The search stays mounted behind the editor, so a late item must also match the last navigation.
  const turn = useRef(0)
  useEffect(() => () => { turn.current++ }, [open])
  const [edit, setEdit] = useState(() => open ? initialEdit(initial, modes) : null)
  const [prevOpen, setPrevOpen] = useState(open)
  // Read on opening only: a later initial from the caller never moves an open editor.
  if (open !== prevOpen) {
    setPrevOpen(open)
    setEdit(open ? initialEdit(initial, modes) : null)
  }
  const close = () => { stopRef.current?.(); onClose() }
  const back = () => { turn.current++; editRef.current?.(); setEdit(null) }
  const done = () => {
    if (!edit) return
    tap('select')
    stopRef.current?.()
    const { item, kind, start } = edit
    onPick({ ref: { kind, id: item.id, start: kind === 'snippet' ? clampStart(start, item.duration) : null }, item })
    onClose()
  }
  const editing = edit !== null
  return (
    <Sheet
      open={open}
      onClose={close}
      title='Música'
      left={editing ? <Pill label='Voltar' icon='voltar' onPress={back} /> : undefined}
      right={editing ? <Pill label='Concluído' filled onPress={done} /> : undefined}
      onBack={editing ? back : undefined}
    >
      {open
        ? (
          <MusicContent
            onEdit={setEdit}
            edit={edit}
            onKind={(kind) => setEdit({ ...edit, kind })}
            onStart={(start) => setEdit({ ...edit, start: clampStart(start, edit.item.duration) })}
            member={member}
            origin={origin}
            request={request}
            modes={modes}
            stopRef={stopRef}
            editRef={editRef}
            turn={turn}
          />
          )
        : null}
    </Sheet>
  )
}

function initialEdit (initial, modes) {
  const ref = initial?.ref
  const item = initial?.item
  if (!ref || !item || item.id !== ref.id || !modes.includes(ref.kind)) return null
  if (ref.kind !== 'playlist' && ref.kind !== 'snippet' && ref.kind !== 'track') return null
  return { item, kind: ref.kind, start: ref.kind === 'snippet' ? clampStart(ref.start ?? 0, item.duration) : 0 }
}

function MusicContent ({ onEdit, edit, onKind, onStart, member, origin, request, modes, stopRef, editRef, turn }) {
  const styles = useStyles(makeStyles)
  const [status, setStatus] = useState({ phase: 'idle', error: '' })
  const [active, setActive] = useState(null)
  const session = useMemo(() => ({ member, origin, request }), [member, origin, request])
  const preview = useMemo(() => createSnippetPreview(session, setStatus), [session])
  useEffect(() => {
    stopRef.current = () => { turn.current++; preview.release(); editRef.current?.() }
    setActive(null)
    setStatus({ phase: 'idle', error: '' })
    return () => { preview.release(); stopRef.current = null }
  }, [preview, stopRef, turn])

  const stopPreview = () => { preview.release(); setActive(null); setStatus({ phase: 'idle', error: '' }) }
  const select = (item, kind) => {
    turn.current++
    if (musicPickStep(kind, modes) === null) return
    stopPreview()
    onEdit({ item, kind: kind === 'playlist' ? 'playlist' : modes.includes('snippet') ? 'snippet' : 'track', start: 0 })
  }
  const toggle = (item) => {
    if (active === item.id && status.phase !== 'idle') return preview.stop()
    setActive(item.id)
    preview.play(item, 0)
  }
  return (
    <View style={styles.root}>
      <View style={edit ? styles.hidden : styles.search}>
        <MusicSearch member={member} origin={origin} request={request} modes={modes} turn={turn} onSelect={select} onStop={stopPreview} onToggle={toggle} active={status.phase === 'idle' ? null : active} phase={status.phase} previewError={status.error} visible={!edit} />
      </View>
      {edit ? <MusicEditor item={edit.item} kind={edit.kind} start={edit.start} modes={modes} session={session} onKind={onKind} onStart={onStart} stopRef={editRef} /> : null}
      <Text style={styles.footer}>Músicas do Audius</Text>
    </View>
  )
}

function useMusicSuggest ({ eligible, kind, initialKey = '', session, sessionChanged }) {
  const [suggest, dispatchSuggest] = useReducer(musicSuggestStep, { ...musicSuggestIdle, key: initialKey })
  const canLoad = eligible && !sessionChanged
  useEffect(() => {
    if (canLoad && suggest.phase === 'idle') dispatchSuggest({ type: 'load' })
  }, [suggest.phase, canLoad])
  useEffect(() => {
    // A new session must finish its reset before starting its own request.
    if (sessionChanged || suggest.phase !== 'loading') return
    const gen = suggest.gen
    const controller = new AbortController()
    const { signal } = controller
    const filter = kind === 'track' ? { genre: suggest.key || undefined } : {}
    audiusTrending({ kind, ...filter, ...session, signal }).then(
      (page) => { if (!signal.aborted) dispatchSuggest({ type: 'page', gen, page }) },
      (error) => { if (!signal.aborted) dispatchSuggest({ type: 'fail', gen, error, extended: kind === 'playlist' || suggest.key !== '' }) }
    )
    return () => controller.abort()
  }, [suggest.gen, session])
  return [suggest, dispatchSuggest]
}

function MusicSearch ({ member, origin, request, modes, turn, onSelect, onStop, onToggle, active, phase: previewPhase, previewError, visible }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const track = modes.includes('snippet') || modes.includes('track')
  const playlist = modes.includes('playlist')
  const [state, dispatch] = useReducer(musicSearchStep, { ...musicSearchIdle, kind: track ? 'track' : 'playlist' })
  const { gen, query, kind, phase, next } = state
  const shown = musicSuggestShown(state)
  const tracksEligible = visible && track && shown && kind === 'track'
  const playlistsEligible = visible && playlist && shown && kind === 'playlist'
  const [recents, setRecents] = useState(() => listMusicRecents(member))
  const [opening, setOpening] = useState(null)
  const [recentError, setRecentError] = useState('')
  const pending = useRef(null)
  const session = useMemo(() => ({ member, origin, request }), [member, origin, request])
  const previousSession = useRef(session)
  const sessionChanged = previousSession.current !== session
  const initialKey = useMemo(() => musicTopGenre(recents) ?? '', [recents])
  const tracks = useMusicSuggest({ eligible: tracksEligible, kind: 'track', initialKey, session, sessionChanged })
  const playlists = useMusicSuggest({ eligible: playlistsEligible, kind: 'playlist', session, sessionChanged })
  const [suggest, dispatchSuggest] = kind === 'playlist' ? playlists : tracks
  const eligible = tracksEligible || playlistsEligible
  useEffect(() => {
    if (previousSession.current === session) return
    previousSession.current = session
    const next = listMusicRecents(member)
    setRecents(next)
    tracks[1]({ type: 'reset', key: musicTopGenre(next) ?? '' })
    playlists[1]({ type: 'reset' })
  }, [session])
  useEffect(() => {
    setOpening(null)
    setRecentError('')
    return () => { pending.current?.abort(); pending.current = null }
  }, [session, visible])
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
  const cancelRecent = () => {
    pending.current?.abort()
    pending.current = null
    setOpening(null)
  }
  const search = (text, kind) => {
    if (text !== state.text || kind !== state.kind) {
      cancelRecent()
      onStop()
      setRecentError('')
    }
    dispatch({ type: 'query', text, kind })
  }
  const openRecent = async (item) => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    const token = turn.current
    setOpening(item)
    setRecentError('')
    try {
      const answer = await audiusItem(item.kind, item.id, { ...session, signal: controller.signal })
      if (controller.signal.aborted || token !== turn.current) return
      const { tracks, ...fresh } = answer
      onSelect(fresh, item.kind)
    } catch (err) {
      if (!controller.signal.aborted && token === turn.current) setRecentError(musicErrorText(err))
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setOpening(null)
      }
    }
  }
  const clearRecents = () => {
    if (!clearMusicRecentsOf(member)) return setRecentError(MUSIC_RECENTS_CLEAR_FAIL_TEXT)
    cancelRecent()
    setRecents([])
    setRecentError('')
  }
  const recentItems = eligible && !sessionChanged && state.text === '' ? recents.filter((item) => item.kind === kind).slice(0, MUSIC_RECENTS_SHOWN) : []
  const results = eligible && !sessionChanged ? suggest : state
  const emptyText = eligible ? MUSIC_SUGGEST_EMPTY_TEXT : MUSIC_EMPTY_TEXT
  const notice = state.error || previewError || results.error || (results.phase === 'ready' && results.items.length === 0 ? emptyText : '')
  const showHeading = eligible && (results.phase === 'loading' || (results.phase === 'ready' && results.items.length > 0))
  const listStatus = (
    <>
      {showHeading ? <Text accessibilityRole='header' style={styles.heading}>{MUSIC_SUGGEST_TEXT}</Text> : null}
      {notice && !recentError ? <Text style={styles.notice} accessibilityLiveRegion='polite'>{notice}</Text> : null}
      {results.phase === 'error' ? <Btn label='Tentar de novo' secondary onPress={() => (eligible ? dispatchSuggest : dispatch)({ type: 'retry' })} /> : null}
      {results.phase === 'loading' ? <ActivityIndicator style={styles.spinner} color={colors.soft} /> : null}
    </>
  )
  return (
    <View style={styles.search}>
      <View style={styles.searchRow}>
        <Icon name='lupa' size={18} color={colors.soft} />
        <TextInput
          value={state.text}
          onChangeText={(text) => search(text, kind)}
          style={[styles.input, webInputReset]}
          placeholder='Buscar música'
          placeholderTextColor={colors.placeholder}
          accessibilityLabel='Buscar música'
          autoCapitalize='none'
          autoCorrect={false}
          autoFocus={false}
          returnKeyType='search'
        />
      </View>
      {playlist ? <Segmented options={track ? SEARCH_KINDS : SEARCH_KINDS.slice(1)} selected={kind} onSelect={(kind) => search(state.text, kind)} /> : null}
      {tracksEligible && !sessionChanged && suggest.phase !== 'off' && suggest.genres
        ? (
          <View style={styles.genreChips}>
            <FilterChips
              options={musicGenreChips(musicGenreOrder(recents))}
              selected={suggest.key}
              onSelect={(key) => {
                if (key === suggest.key) return
                cancelRecent()
                onStop()
                dispatchSuggest({ type: 'genre', key })
              }}
            />
          </View>
          )
        : null}
      {recentError ? <Text style={styles.notice} accessibilityLiveRegion='polite'>{recentError}</Text> : null}
      {recentItems.length === 0 ? listStatus : null}
      <FlatList
        data={results.items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps='handled'
        onEndReachedThreshold={0.6}
        onEndReached={() => dispatch({ type: 'more' })}
        ListHeaderComponent={recentItems.length ? <MusicRecents items={recentItems} opening={opening} onOpen={openRecent} onClear={clearRecents} listStatus={listStatus} /> : null}
        ListFooterComponent={phase === 'more' ? <ActivityIndicator style={styles.spinner} color={colors.soft} /> : null}
        renderItem={({ item }) => (
          <MusicRow item={item} kind={kind} member={member} origin={origin} request={request} onOpen={onSelect} onToggle={onToggle} phase={active === item.id ? previewPhase : 'idle'} />
        )}
      />
    </View>
  )
}

function MusicRecents ({ items, opening, onOpen, onClear, listStatus }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View>
      <View style={styles.recentsHeading}>
        <Text accessibilityRole='header' style={styles.heading}>{MUSIC_RECENTS_TEXT}</Text>
        <Pressable accessibilityRole='button' accessibilityLabel={MUSIC_RECENTS_CLEAR_LABEL} onPress={onClear} style={styles.clear}>
          <Text style={styles.artist}>{MUSIC_RECENTS_CLEAR_TEXT}</Text>
        </Pressable>
      </View>
      {items.map((item) => (
        <View key={item.id} style={styles.row}>
          <Pressable accessibilityRole='button' disabled={opening !== null} onPress={() => onOpen(item)} style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
            <MusicCover size={48} uri={null} />
            <View style={styles.words}>
              <Text style={styles.title} numberOfLines={1}>{displayText(item.title)}</Text>
              <Text style={styles.artist} numberOfLines={1}>{displayText(item.kind === 'track' ? item.artist : musicRowLine(item))}</Text>
            </View>
            {opening === item ? <ActivityIndicator color={colors.soft} /> : null}
          </Pressable>
        </View>
      ))}
      {listStatus}
    </View>
  )
}

// Sibling Pressables: a nested button inside the row would swallow or double the tap.
function MusicRow ({ item, kind, member, origin, request, onOpen, onToggle, phase }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const uri = useMusicCover(kind, item, { member, origin, request })
  const playing = phase === 'playing'
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole='button' onPress={() => onOpen(item, kind)} style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
        <MusicCover size={48} uri={uri} />
        <View style={styles.words}>
          <Text style={styles.title} numberOfLines={1}>{displayText(item.title)}</Text>
          <Text style={styles.artist} numberOfLines={1}>{displayText(musicRowLine(item))}</Text>
        </View>
      </Pressable>
      {kind === 'track'
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={phase === 'idle' ? 'Ouvir prévia' : 'Parar prévia'}
            onPress={() => onToggle(item)}
            style={({ pressed }) => [styles.play, pressed && styles.pressed]}
          >
            {phase === 'loading' ? <ActivityIndicator color={colors.ink} /> : <Icon name={playing ? 'parar' : 'tocar'} color={colors.ink} />}
          </Pressable>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.lg },
  genreChips: { marginHorizontal: -space.lg },
  search: { flex: 1 },
  hidden: { display: 'none' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: layout.hit, paddingHorizontal: space.md, borderRadius: radius.lg, backgroundColor: colors.bg },
  input: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: space.sm, color: colors.ink },
  list: { paddingVertical: space.sm },
  recentsHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clear: { minHeight: layout.hit, minWidth: layout.hit, justifyContent: 'center', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  main: { flex: 1, minWidth: 0, minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  play: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  words: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, color: colors.ink, fontWeight: '600' },
  artist: { fontSize: 14, color: colors.soft },
  heading: { fontSize: 14, fontWeight: '600', color: colors.ink, paddingTop: space.md },
  notice: { fontSize: 15, color: colors.soft, textAlign: 'center', paddingVertical: space.md },
  footer: { fontSize: 13, color: colors.soft, textAlign: 'center', paddingVertical: space.md },
  spinner: { paddingVertical: space.md },
  pressed: { opacity: 0.7 }
})
