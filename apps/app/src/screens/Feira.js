import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import * as actingAs from '../actingAs'
import { installationOrigin } from '../installation'
import { listSaved, toggleSaved } from '../feiraSavedStore'
import { SAVED_FULL_TEXT } from '../feiraSaved'
import { ownerDest } from '../feiraCompose'
import { alertsStore } from '../feiraAlertsStore'
import { PARTIAL_NOTE, browseListings, columnsFor, gridRows, placeLabel } from '../feiraBrowse'
import {
  SEGMENT_OPTIONS, UF_OPTIONS, TEXTS,
  createFeiraProbe, filterState, filtersDot, loadFeiraPage, mergeRows, partialNoteVisible, placeMissing, rowDecision, runFeiraAlerts, savedSearch, screenState, viewFilters
} from '../feiraScreen'
import { Btn, Field, Soft, useBottomPad } from '../ui'
import { CategoryTiles } from '../ui/CategoryTiles'
import { FeiraFilters } from '../ui/FeiraFilters'
import { FilterChips } from '../ui/FilterChips'
import { Icon } from '../ui/Icon'
import { ListingTile } from '../ui/ListingTile'
import { PlaceSheet } from '../ui/PlaceSheet'
import { PressScale } from '../ui/PressScale'
import { RefreshableList } from '../ui/RefreshableList'
import { SearchField } from '../ui/SearchField'
import { Segmented } from '../ui/Segmented'
import { TEXT_CAP } from '../ui/Sheet'
import { EmptyState, SkeletonTile } from '../ui/States'
import { useStyles } from '../ui/ThemeProvider'
import { elevation, fonts, LARGE_TEXT, layout, radius, space, type } from '../ui/theme'

const NO_BLOCKS = new Set()
const newLabel = (n) => (n === 1 ? '1 novo' : n + ' novos')
// Submit can fire before the last keystroke has been rendered into state.
const fieldText = (event, fallback) => {
  const text = event?.nativeEvent?.text
  return typeof text === 'string' ? text : fallback
}
let rememberedLocation = {}
const HEX64 = /^[0-9a-f]{64}$/
const SAVE_FAILED = 'Não foi possível salvar neste aparelho.'
const listingId = (listing) => listing.author + ':' + listing.seq

// locationStore: { load, save }, backed by createLocationStore at integration.
// Photos nearly touch, as in the other grids.
const GRID_GAP = 2

export default function Feira ({
  active = true, ownKey, origin, blocked = NO_BLOCKS, locationStore,
  onOpenListing, onAnnounce, onSaveSearch, scrollToTop, author
}) {
  const byAuthor = typeof author === 'string' && /^[0-9a-f]{64}$/.test(author) ? author : null
  const node = useNode()
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  const bottomPad = useBottomPad()
  const { fontScale } = useWindowDimensions()
  const acting = useSyncExternalStore(actingAs.subscribe, actingAs.get, actingAs.get)
  const [filters, setFilters] = useState(() => filterState(rememberedLocation))
  const [applied, setApplied] = useState(filters)
  // Sort and price narrow the rows already loaded. They stay out of the index query and out of saved searches.
  const [view, setView] = useState(() => viewFilters())
  const [segmentChoice, setSegment] = useState('cidade')
  const segment = byAuthor ? 'autor' : segmentChoice
  const [placeOpen, setPlaceOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [placeError, setPlaceError] = useState('')
  const [width, setWidth] = useState(0)
  const [locationReady, setLocationReady] = useState(!locationStore)
  const [storageFailed, setStorageFailed] = useState(false)
  const [loaded, setLoaded] = useState(null)
  const [busy, setBusy] = useState(null)
  const [alertData, setAlertData] = useState(null)
  const [alertNotice, setAlertNotice] = useState('')
  const [availability, setAvailability] = useState(null)
  const [savedKeys, setSavedKeys] = useState(null)
  const [saveNotice, setSaveNotice] = useState(null)
  const alive = useRef(true)
  const generation = useRef(0)
  const pending = useRef(null)
  const storageGeneration = useRef(0)
  const probe = useRef(null)
  const saving = useRef(new Set())
  const savedRead = useRef(0)
  if (probe.current === null) probe.current = createFeiraProbe()
  // The same origin Anuncio saves under: the hosted web keeps no installation
  // record, so the page's own origin stands for it.
  const savedOrigin = origin || installationOrigin() || globalThis.location?.origin || node.accountOrigin
  const alertScope = JSON.stringify([savedOrigin, node.epoch])
  const currentAlertScope = useRef(alertScope)
  currentAlertScope.current = alertScope
  const alerts = alertData?.scope === alertScope ? alertData.value : { searches: [], counts: {} }
  const alertsEnabled = availability?.scope === alertScope && availability.enabled === true
  const alertActive = useRef(false)
  alertActive.current = active && !byAuthor && node.visible !== false && node.online !== false && node.hosted === true && alertsEnabled
  const scope = JSON.stringify([applied, segment, ownKey, acting.kind, acting.key, savedOrigin, byAuthor, node.epoch, node.hosted, node.online])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const result = loaded && loaded.scope === scope ? loaded.result : null
  const loading = busy && busy.scope === scope
  const savedIds = savedKeys && savedKeys.scope === scope ? savedKeys.keys : null
  const starNotice = saveNotice && saveNotice.scope === scope ? saveNotice.text : ''
  const actingPage = acting.kind === 'page' ? acting.key : null
  const ownerKnown = HEX64.test(actingPage || ownKey || '')
  // A new array on every render would redraw every tile on each keystroke.
  const listExtra = useMemo(() => [savedIds, ownerKnown, actingPage, ownKey], [savedIds, ownerKnown, actingPage, ownKey])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    let live = true
    probe.current = createFeiraProbe()
    setAlertNotice('')
    alertsStore.load(savedOrigin).then((value) => {
      if (live) setAlertData({ scope: alertScope, value })
    })
    return () => { live = false }
  }, [savedOrigin, alertScope])

  useEffect(() => {
    if (!alertActive.current) return
    let live = true
    runFeiraAlerts({
      node,
      enabled: alertsEnabled,
      origin: savedOrigin,
      store: alertsStore,
      blocked,
      isActive: () => live && alive.current && alertActive.current && currentAlertScope.current === alertScope
    }).then(async (answer) => {
      const value = await alertsStore.load(savedOrigin)
      if (!live) return
      setAlertData({ scope: alertScope, value })
      if (answer.off) {
        probe.current = createFeiraProbe()
        setAvailability({ scope: alertScope, enabled: false })
      }
      if (answer.persisted === false) setAlertNotice('Não foi possível guardar as buscas neste aparelho.')
    })
    return () => { live = false }
  }, [active, byAuthor, node.visible, node.online, node.hosted, alertScope, alertsEnabled, savedOrigin, blocked])

  useEffect(() => {
    if (!locationStore) return
    let alive = true
    setLocationReady(false)
    Promise.resolve().then(() => locationStore.load()).then((value) => {
      if (!alive) return
      const next = filterState(value || {})
      setFilters(next)
      setApplied(next)
      setView(viewFilters())
    }, () => { if (alive) setStorageFailed(true) }).finally(() => { if (alive) setLocationReady(true) })
    return () => { alive = false }
  }, [locationStore])

  // Anuncio saves through the same store while this screen stays mounted
  // under the stack, so the set is read again on every load, not once. Only
  // the newest read for the current scope lands; a failed read leaves every
  // star hollow.
  function readSaved () {
    const at = currentScope.current
    const ticket = ++savedRead.current
    Promise.resolve().then(() => listSaved(savedOrigin)).then((refs) => new Set(refs.map(listingId)), () => new Set()).then((keys) => {
      if (alive.current && ticket === savedRead.current && currentScope.current === at) setSavedKeys({ scope: at, keys })
    })
  }

  const load = useCallback(async (more = false) => {
    if (!active || !locationReady) return
    if (more && (pending.current || !result || result.next === null)) return
    if (!more) readSaved()
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
    if (answer.off || (answer.ok && node.online !== false && node.hosted === true)) {
      if (answer.off) probe.current = createFeiraProbe()
      setAvailability({ scope: alertScope, enabled: !answer.off })
    }
    if (more && answer.ok) {
      answer = { ...answer, items: mergeRows(result.items, answer.items), next: answer.next === cursor ? null : answer.next }
    } else if (more && !answer.off) {
      answer = { ...result, ok: false }
    }
    setLoaded({ scope, result: answer })
    pending.current = null
    setBusy(null)
  }, [active, locationReady, scope, segment, byAuthor, savedOrigin, alertScope, node, applied, ownKey, acting, blocked, result])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    loadRef.current()
    return () => {
      generation.current++
      pending.current = null
    }
  }, [scope, active, locationReady])

  function confirmPlace (event) {
    const next = { ...filters, city: fieldText(event, filters.city) }
    if (placeMissing(next)) {
      setFilters(next)
      setPlaceError(TEXTS.location)
      return
    }
    applyFilters(next)
  }

  function clearFilters () {
    setView(viewFilters())
    applyFilters({ uf: applied.uf, city: applied.city, kind: 'todos', cat: 'todas', words: '' })
  }

  function applyFilters (next = filters) {
    Keyboard.dismiss()
    setPlaceError('')
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

  async function saveSearch () {
    const answer = await alertsStore.add(savedOrigin, { ...query, cityLabel: applied.city })
    if (!alive.current || currentAlertScope.current !== alertScope) return
    setAlertData({ scope: alertScope, value: answer })
    setAlertNotice(answer.full ? 'Você já tem 10 buscas salvas. Remova uma para salvar outra.' : answer.saved !== true || answer.persisted === false ? 'Não foi possível guardar a busca neste aparelho.' : 'Busca salva neste aparelho.')
    if (answer.saved && onSaveSearch) onSaveSearch(query)
  }

  // One local write per press, never repeated: a refused write only shows the
  // notice. A press on a tile whose write is still pending is dropped.
  async function toggleSave (listing) {
    const id = listingId(listing)
    if (saving.current.has(id)) return
    saving.current.add(id)
    const at = currentScope.current
    setSaveNotice(null)
    let answer = null
    try {
      answer = await toggleSaved(savedOrigin, { author: listing.author, seq: listing.seq })
    } catch {} finally {
      saving.current.delete(id)
    }
    if (!alive.current) return
    if (!answer) { setSaveNotice({ scope: at, text: SAVE_FAILED }); readSaved(); return }
    if (answer.full) { setSaveNotice({ scope: at, text: SAVED_FULL_TEXT }); return }
    setSaveNotice(answer.persisted === false ? { scope: at, text: SAVE_FAILED } : null)
    // The store is the truth: read it again rather than flip what was on
    // screen, which may be stale (saved elsewhere, another segment, a read
    // still pending). The read starts after this write, so it includes it.
    readSaved()
  }

  async function openSearch (saved) {
    const answer = await alertsStore.markSeen(savedOrigin, saved.id)
    if (!alive.current || currentAlertScope.current !== alertScope) return
    setAlertData({ scope: alertScope, value: answer })
    setAlertNotice(answer.persisted === false ? 'Não foi possível guardar a leitura desta busca neste aparelho.' : '')
    setSegment('cidade')
    setView(viewFilters())
    setPlaceOpen(false)
    setFiltersOpen(false)
    applyFilters({ uf: saved.uf, city: saved.cityLabel, kind: saved.kind, cat: saved.cat, words: saved.tokens.join(' ') })
  }

  async function removeSearch (id) {
    const answer = await alertsStore.remove(savedOrigin, id)
    if (!alive.current || currentAlertScope.current !== alertScope) return
    setAlertData({ scope: alertScope, value: answer })
    setAlertNotice(answer.persisted === false ? 'Não foi possível guardar a remoção neste aparelho.' : '')
  }

  const state = screenState({ node, filters: applied, segment, result, loading: !!loading || !locationReady })
  const options = { filters: applied, segment, acting, ownKey, blocked, author: byAuthor }
  const rows = state.kind === 'off' ? [] : (result ? result.items.filter((row) => rowDecision(row, options)) : [])
  const query = savedSearch(applied)
  const controls = state.kind !== 'off' && !(availability?.scope === alertScope && availability.enabled === false)
  const filtering = controls && !byAuthor
  const showHero = filtering && segment === 'cidade' && locationReady && placeMissing(applied)
  const cityBrowse = filtering && segment === 'cidade' && locationReady && !showHero
  const columns = columnsFor(width, fontScale >= LARGE_TEXT)
  const browsed = browseListings(rows, cityBrowse ? view : viewFilters())
  const gap = GRID_GAP
  const inner = Math.max(0, width)
  const tileWidth = columns > 1 ? Math.floor((inner - gap * (columns - 1)) / columns) : inner
  const grid = gridRows(controls && !showHero ? browsed : [], columns)
  const note = cityBrowse && partialNoteVisible(view, !!(result && result.next !== null))
  // The load effect starts after paint. Until this scope is busy, the empty
  // actions would flash for a query that has not answered. A hidden tab does
  // not load, so it keeps the quiet status line instead of a running skeleton.
  const pagePending = active && cityBrowse && !result && state.kind === 'empty'
  const showEmpty = cityBrowse && browsed.length === 0 && result !== null && (state.kind === 'empty' || state.kind === 'ready')
  const showSkeletons = segment !== 'buscas' && browsed.length === 0 && !showHero && (state.kind === 'loading' || pagePending)
  const hideStatus = showEmpty || showSkeletons || (segment === 'buscas' && state.kind === 'empty') || (showHero && (state.kind === 'location' || state.kind === 'loading'))
  const skeletonRows = []
  if (showSkeletons) {
    const count = columns * 2
    for (let i = 0; i < count; i += columns) {
      const ids = []
      for (let n = 0; n < columns && i + n < count; n++) ids.push(i + n)
      skeletonRows.push(ids)
    }
  }
  const header = (
    <View>
      {filtering
        ? (
          <>
            <Segmented options={SEGMENT_OPTIONS} selected={segment} onSelect={(id) => { setSegment(id); setPlaceOpen(false); setFiltersOpen(false) }} />
            {showHero
              ? (
                <View style={styles.hero}>
                  <View style={styles.heroPad}>
                    <Text accessibilityRole='header' style={styles.heroTitle}>Onde você quer comprar e vender?</Text>
                    <Text style={styles.fieldLabel}>Estado</Text>
                  </View>
                  <FilterChips options={UF_OPTIONS} selected={filters.uf} onSelect={(uf) => { setPlaceError(''); setFilters({ ...filters, uf }) }} />
                  <View style={styles.heroPad}>
                    <Field label='Cidade' value={filters.city} maxLength={40} editable={locationReady} onChangeText={(city) => { setPlaceError(''); setFilters({ ...filters, city }) }} onSubmitEditing={confirmPlace} returnKeyType='search' />
                    {placeError ? <Text style={styles.message} accessibilityLiveRegion='polite'>{placeError}</Text> : null}
                    <Btn label='Ver anúncios' onPress={confirmPlace} disabled={!locationReady} block />
                    <Text accessibilityRole='header' style={styles.howTitle}>Como funciona</Text>
                    <View style={styles.steps}>
                      {[['lapis', 'Anuncie'], ['conversas', 'Converse'], ['ok', 'Combine'], ['estrela', 'Avalie']].map(([icon, label]) => (
                        <View key={label} style={styles.step}>
                          <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
                            <Icon name={icon} size={18} />
                          </View>
                          <Text style={styles.stepLabel}>{label}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
                )
              : null}
            {cityBrowse
              ? (
                <>
                  <View style={styles.fields}>
                    <SearchField
                      label='Palavras'
                      placeholder='Buscar na Feira'
                      value={filters.words}
                      maxLength={100}
                      onChangeText={(words) => setFilters({ ...filters, words })}
                      onSubmitEditing={(event) => applyFilters({ ...filters, words: fieldText(event, filters.words) })}
                      right={(
                        <Pressable
                          accessibilityRole='button'
                          accessibilityLabel='Filtros'
                          accessibilityState={{ selected: filtersDot(view, applied.kind) }}
                          onPress={() => setFiltersOpen(true)}
                          hitSlop={space.sm}
                          style={({ pressed }) => [styles.filterBtn, pressed && styles.pressed]}
                        >
                          <View pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
                            <Icon name='filtro' size={20} />
                            {filtersDot(view, applied.kind) ? <View style={styles.dot} /> : null}
                          </View>
                        </Pressable>
                      )}
                    />
                    <View style={styles.toolRow}>
                      <Pressable
                        accessibilityRole='button'
                        accessibilityLabel={'Trocar cidade, agora ' + placeLabel({ city: applied.city, uf: applied.uf })}
                        onPress={() => setPlaceOpen(true)}
                        style={({ pressed }) => [styles.placeChip, pressed && styles.pressed]}
                      >
                        <View style={[styles.toolInner, styles.toolFill]} pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
                          <Icon name='mapa' size={18} />
                          <Text style={styles.chipLabel} numberOfLines={1}>{placeLabel({ city: applied.city, uf: applied.uf })}</Text>
                        </View>
                      </Pressable>
                    </View>
                  </View>
                  <CategoryTiles value={filters.cat} onChange={(cat) => applyFilters({ ...filters, cat })} />
                  {query ? <View style={styles.note}><Btn label='Salvar busca' secondary onPress={saveSearch} /></View> : null}
                  <PlaceSheet
                    open={placeOpen}
                    onClose={() => setPlaceOpen(false)}
                    uf={applied.uf}
                    city={applied.city}
                    onPick={(place) => applyFilters({ ...filters, uf: place.uf, city: place.city })}
                  />
                  <FeiraFilters
                    open={filtersOpen}
                    onClose={() => setFiltersOpen(false)}
                    value={{ sort: view.sort, min: view.min, max: view.max, kind: applied.kind }}
                    onApply={(next) => {
                      setView(viewFilters(next))
                      if (next.kind !== applied.kind) applyFilters({ ...filters, kind: next.kind })
                    }}
                  />
                </>
                )
              : null}
            {segment === 'buscas'
              ? (
                <View style={styles.fields}>
                  <Soft>As contagens mostram o que a consulta desta abertura viu, na primeira página de cada busca. A atualização ocorre ao abrir a Feira ou voltar ao aplicativo, com intervalo mínimo de 15 minutos. Offline, ficam as últimas contagens.</Soft>
                  {alerts.searches.length === 0 ? <Soft>Você ainda não tem buscas salvas neste aparelho.</Soft> : null}
                  {alerts.searches.map((saved) => (
                    <View key={saved.id} style={styles.search}>
                      <Pressable accessibilityRole='button' onPress={() => openSearch(saved)} style={styles.select}>
                        <Text style={styles.selectText}>{displayText(saved.label)}</Text>
                        <Text style={styles.chip}>{newLabel(alerts.counts[saved.id] || 0)}</Text>
                      </Pressable>
                      <Btn label='Remover busca' secondary onPress={() => removeSearch(saved.id)} />
                    </View>
                  ))}
                </View>
                )
              : null}
          </>
          )
        : null}
      {storageFailed ? <View style={styles.note}><Soft>{TEXTS.storage}</Soft></View> : null}
      {alertNotice ? <View style={styles.note} accessibilityLiveRegion='polite'><Soft>{alertNotice}</Soft></View> : null}
      {!controls ? <View style={styles.note}><Soft>{TEXTS.off}</Soft></View> : state.text && !hideStatus ? <View style={styles.note} accessibilityLiveRegion='polite'><Text style={styles.message}>{displayText(state.text)}</Text></View> : null}
      {note ? <View style={styles.note}><Soft>{PARTIAL_NOTE}</Soft></View> : null}
      {skeletonRows.map((ids) => (
        <View key={'sk-' + ids[0]} style={styles.gridRow}>
          {ids.map((id) => (
            <View key={id} style={{ width: tileWidth }}>
              <SkeletonTile />
            </View>
          ))}
        </View>
      ))}
      {showEmpty
        ? (
          <EmptyState
            icon='feira'
            title={TEXTS.empty}
            actionLabel='Limpar filtros'
            onAction={clearFilters}
            secondaryLabel='Trocar cidade'
            onSecondary={() => setPlaceOpen(true)}
          />
          )
        : null}
    </View>
  )

  return (
    <View
      style={styles.screen}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width
        if (next > 0 && next !== width) setWidth(next)
      }}
    >
      {starNotice ? <View style={styles.note} accessibilityLiveRegion='polite' aria-live='polite'><Soft>{starNotice}</Soft></View> : null}
      <RefreshableList
        data={grid}
        extraData={listExtra}
        keyExtractor={(item) => item.map((listing) => listing.author + ':' + listing.seq).join('|')}
        renderItem={({ item }) => (
          <View style={styles.gridRow}>
            {item.map((listing) => (
              <ListingTile
                key={listing.author + ':' + listing.seq}
                listing={listing}
                width={tileWidth}
                onPress={() => onOpenListing && onOpenListing({ author: listing.author, seq: listing.seq })}
                saved={savedIds !== null && savedIds.has(listingId(listing))}
                onSave={ownerKnown && HEX64.test(listing.author) && ownerDest(listing, { me: ownKey, actingPage }) === null ? () => toggleSave(listing) : undefined}
              />
            ))}
          </View>
        )}
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
      {controls && state.canAnnounce && onAnnounce && !byAuthor
        ? (
          <PressScale
            accessibilityRole='button'
            accessibilityLabel='Anunciar'
            onPress={onAnnounce}
            style={({ pressed }) => [styles.fab, { bottom: insets.bottom + layout.tabBar + layout.fabAboveTabs }, pressed && styles.pressed]}
          >
            <Text style={styles.fabText} maxFontSizeMultiplier={TEXT_CAP}>+</Text>
          </PressScale>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hero: { paddingTop: space.lg, gap: space.md },
  heroPad: { paddingHorizontal: space.lg, gap: space.md },
  heroTitle: { ...type.heroTitle, fontFamily: fonts.title, color: colors.ink, textAlign: 'center' },
  fieldLabel: { ...type.postName, color: colors.ink },
  howTitle: { ...type.emptyTitle, color: colors.ink, textAlign: 'center' },
  steps: { flexDirection: 'row', gap: space.sm },
  step: { flex: 1, minWidth: 0, alignItems: 'center', gap: space.xs },
  stepLabel: { ...type.chip, color: colors.ink, textAlign: 'center' },
  fields: { padding: space.lg, gap: space.sm },
  toolRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  toolInner: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toolFill: { flex: 1, minWidth: 0 },
  placeChip: { flex: 1, minWidth: 0, minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  filterBtn: { minWidth: layout.hit, minHeight: layout.hit, marginVertical: -1.5, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { ...type.postText, color: colors.ink, flexShrink: 1 },
  dot: { position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.accent },
  gridRow: { flexDirection: 'row', gap: GRID_GAP, marginBottom: GRID_GAP, alignItems: 'flex-start' },
  search: { gap: space.sm },
  chip: { ...type.pill, color: colors.accent, backgroundColor: colors.accentSoft, borderRadius: radius.pill, padding: space.sm, alignSelf: 'flex-start' },
  select: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line },
  selectText: { ...type.postText, color: colors.ink },
  note: { paddingHorizontal: space.lg, paddingVertical: space.md },
  message: { ...type.postText, color: colors.soft },
  fab: { position: 'absolute', right: layout.fabRight, width: layout.fabSize, height: layout.fabSize, borderRadius: layout.fabSize / 2, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', boxShadow: `${elevation.raised} ${colors.shadow}` },
  fabText: { ...type.heroTitle, color: colors.accentInk },
  pressed: { opacity: 0.7 }
})
