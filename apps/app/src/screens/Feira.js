import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import * as actingAs from '../actingAs'
import { installationOrigin } from '../installation'
import { listSaved } from '../feiraSavedStore'
import {
  CATEGORY_OPTIONS, KIND_OPTIONS, SEGMENT_OPTIONS, UF_OPTIONS, TEXTS,
  createFeiraProbe, filterState, loadFeiraPage, mergeRows, rowDecision, savedSearch, screenState
} from '../feiraScreen'
import { Btn, Field, Soft, useBottomPad } from '../ui'
import { FilterChips } from '../ui/FilterChips'
import { ListingCard } from '../ui/ListingCard'
import { RefreshableList } from '../ui/RefreshableList'
import { useStyles } from '../ui/ThemeProvider'
import { layout, radius, space, type } from '../ui/theme'

const NO_BLOCKS = new Set()
let rememberedLocation = {}

// locationStore: { load, save }, backed by createLocationStore at integration.
// onSaveSearch receives the canonical query for PR4; no alert is enabled here.
export default function Feira ({
  active = true, ownKey, origin, blocked = NO_BLOCKS, locationStore,
  onOpenListing, onAnnounce, onSaveSearch, scrollToTop, author
}) {
  const byAuthor = typeof author === 'string' && /^[0-9a-f]{64}$/.test(author) ? author : null
  const node = useNode()
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const bottomPad = useBottomPad()
  const acting = useSyncExternalStore(actingAs.subscribe, actingAs.get, actingAs.get)
  const [filters, setFilters] = useState(() => filterState(rememberedLocation))
  const [applied, setApplied] = useState(filters)
  const [segmentChoice, setSegment] = useState('cidade')
  const segment = byAuthor ? 'autor' : segmentChoice
  const [choosingUf, setChoosingUf] = useState(false)
  const [locationReady, setLocationReady] = useState(!locationStore)
  const [storageFailed, setStorageFailed] = useState(false)
  const [loaded, setLoaded] = useState(null)
  const [busy, setBusy] = useState(null)
  const generation = useRef(0)
  const pending = useRef(null)
  const storageGeneration = useRef(0)
  const probe = useRef(null)
  if (probe.current === null) probe.current = createFeiraProbe()
  // The same origin Anuncio saves under: the hosted web keeps no installation
  // record, so the page's own origin stands for it.
  const savedOrigin = origin || installationOrigin() || globalThis.location?.origin || node.accountOrigin
  const scope = JSON.stringify([applied, segment, ownKey, acting.kind, acting.key, savedOrigin, byAuthor, node.epoch, node.hosted, node.online])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const result = loaded && loaded.scope === scope ? loaded.result : null
  const loading = busy && busy.scope === scope

  useEffect(() => {
    if (!locationStore) return
    let alive = true
    setLocationReady(false)
    Promise.resolve().then(() => locationStore.load()).then((value) => {
      if (!alive) return
      const next = filterState(value || {})
      setFilters(next)
      setApplied(next)
    }, () => { if (alive) setStorageFailed(true) }).finally(() => { if (alive) setLocationReady(true) })
    return () => { alive = false }
  }, [locationStore])

  const load = useCallback(async (more = false) => {
    if (!active || !locationReady) return
    if (more && (pending.current || !result || result.next === null)) return
    const ticket = ++generation.current
    const cursor = more ? result.next : null
    pending.current = ticket
    setBusy({ scope, more })
    let answer
    try {
      const saved = segment === 'salvos' ? await listSaved(savedOrigin) : []
      answer = await loadFeiraPage({ node, filters: applied, segment, ownKey, acting, blocked, cursor, saved, author: byAuthor }, {
        policy: () => probe.current((...args) => node.request(...args), byAuthor || ownKey)
      })
    } catch {
      answer = { ok: false, items: [], next: null }
    }
    if (generation.current !== ticket || currentScope.current !== scope) return
    if (more && answer.ok) {
      answer = { ...answer, items: mergeRows(result.items, answer.items), next: answer.next === cursor ? null : answer.next }
    } else if (more && !answer.off) {
      answer = { ...result, ok: false }
    }
    setLoaded({ scope, result: answer })
    pending.current = null
    setBusy(null)
  }, [active, locationReady, scope, segment, byAuthor, savedOrigin, node, applied, ownKey, acting, blocked, result])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    loadRef.current()
    return () => {
      generation.current++
      pending.current = null
    }
  }, [scope, active, locationReady])

  function applyFilters (next = filters) {
    const value = filterState(next)
    setFilters(value)
    setApplied(value)
    if (JSON.stringify(value) === JSON.stringify(applied)) loadRef.current()
    rememberedLocation = { uf: value.uf, city: value.city }
    const ticket = ++storageGeneration.current
    if (locationStore) {
      Promise.resolve().then(() => locationStore.save(value)).then((ok) => {
        if (ticket === storageGeneration.current) setStorageFailed(ok === false)
      }, () => { if (ticket === storageGeneration.current) setStorageFailed(true) })
    } else {
      setStorageFailed(true)
    }
  }

  const state = screenState({ node, filters: applied, segment, result, loading: !!loading || !locationReady })
  const options = { filters: applied, segment, acting, ownKey, blocked, author: byAuthor }
  const rows = state.kind === 'off' ? [] : (result ? result.items.filter((row) => rowDecision(row, options)) : [])
  const query = savedSearch(applied)
  const controls = state.kind !== 'off'
  const filtering = controls && !byAuthor
  const header = (
    <View>
      {filtering
        ? (
          <>
            <FilterChips options={SEGMENT_OPTIONS} selected={segment} onSelect={setSegment} />
            {segment === 'cidade'
              ? (
                <>
                  <View style={styles.fields}>
                    <Pressable
                      accessibilityRole='button'
                      accessibilityLabel={'Escolher estado' + (filters.uf ? ', ' + displayText(filters.uf) : '')}
                      accessibilityState={{ expanded: choosingUf, disabled: !locationReady }}
                      disabled={!locationReady}
                      onPress={() => setChoosingUf(!choosingUf)}
                      style={styles.select}
                    >
                      <Text style={styles.selectText}>{filters.uf ? 'Estado: ' + displayText(filters.uf) : 'Escolher estado'}</Text>
                    </Pressable>
                    {choosingUf
                      ? <FilterChips options={UF_OPTIONS} selected={filters.uf} onSelect={(uf) => { setFilters({ ...filters, uf }); setChoosingUf(false) }} />
                      : null}
                    <Field label='Cidade' value={filters.city} maxLength={40} editable={locationReady} onChangeText={(city) => setFilters({ ...filters, city })} onSubmitEditing={() => applyFilters()} />
                    <Field label='Palavras (opcional)' value={filters.words} maxLength={100} editable={locationReady} onChangeText={(words) => setFilters({ ...filters, words })} onSubmitEditing={() => applyFilters()} returnKeyType='search' />
                    <Btn label='Buscar' onPress={() => applyFilters()} disabled={!locationReady} />
                  </View>
                  <FilterChips options={KIND_OPTIONS} selected={filters.kind} onSelect={(kind) => applyFilters({ ...filters, kind })} />
                  <FilterChips options={CATEGORY_OPTIONS} selected={filters.cat} onSelect={(cat) => applyFilters({ ...filters, cat })} />
                  {onSaveSearch && query ? <View style={styles.note}><Btn label='Salvar busca' secondary onPress={() => onSaveSearch(query)} /></View> : null}
                </>
                )
              : null}
          </>
          )
        : null}
      {storageFailed ? <View style={styles.note}><Soft>{TEXTS.storage}</Soft></View> : null}
      {state.text ? <View style={styles.note} accessibilityLiveRegion='polite'><Text style={styles.message}>{displayText(state.text)}</Text></View> : null}
    </View>
  )

  return (
    <View style={styles.screen}>
      <RefreshableList
        data={rows}
        keyExtractor={(item) => item.author + ':' + item.seq}
        renderItem={({ item }) => <ListingCard listing={item} onPress={() => onOpenListing && onOpenListing({ author: item.author, seq: item.seq })} />}
        ListHeaderComponent={header}
        ListFooterComponent={result && result.next !== null && controls
          ? <View style={styles.note}><Btn label={rows.length ? 'Carregar mais' : 'Continuar busca'} secondary pending={!!loading} onPress={() => load(true)} /></View>
          : null}
        contentContainerStyle={{ paddingBottom: bottomPad + layout.fabSize }}
        onRefresh={() => load()}
        refreshing={!!loading && !busy.more}
        loadingMore={!!loading && busy.more}
        atEnd={!result || result.next === null}
        scrollToTopSignal={scrollToTop}
      />
      {state.canAnnounce && onAnnounce && !byAuthor
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='Anunciar'
            onPress={onAnnounce}
            style={({ pressed }) => [styles.fab, { bottom: insets.bottom + layout.tabBar + layout.fabAboveTabs }, pressed && styles.pressed]}
          >
            <Text style={styles.fabText}>Anunciar</Text>
          </Pressable>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  fields: { padding: space.lg, gap: space.sm },
  select: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line },
  selectText: { ...type.postText, color: colors.ink },
  note: { paddingHorizontal: space.lg, paddingVertical: space.md },
  message: { ...type.postText, color: colors.soft },
  fab: { position: 'absolute', right: layout.fabRight, minHeight: layout.fabSize, paddingHorizontal: space.xl, borderRadius: radius.pill, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  fabText: { ...type.pill, color: colors.accentInk },
  pressed: { opacity: 0.7 }
})
