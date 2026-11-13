'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const load = () => import('../src/feiraScreen.js')
const A = 'ab'.repeat(32)
const P = 'cd'.repeat(32)
const filters = { uf: 'SP', city: 'São Paulo', kind: 'todos', cat: 'todas', words: '' }
const row = (extra = {}) => ({
  author: A,
  seq: 1,
  kind: 'produto',
  status: 'disponivel',
  title: 'Bicicleta azul',
  text: 'Pouco uso',
  price: 20000,
  unit: null,
  cat: 'esporte',
  place: { uf: 'SP', city: 'São Paulo', bairro: null },
  at: '2026-11-01T12:00:00.000Z',
  media: [],
  ...extra
})
const node = { hosted: true, online: true, request: async () => { throw new Error('unexpected RPC') } }
const page = (items = [], extra = {}) => ({ ok: true, items, next: null, complete: true, ...extra })

test('Feira states: empty, offline, off, incomplete and invalid location', async (t) => {
  const { screenState, loadFeiraPage } = await load()
  const base = { node, filters, result: page() }
  t.is(screenState(base).kind, 'empty')
  t.is(screenState({ ...base, segment: 'meus' }).text, 'Você ainda não tem anúncios.')
  t.is(screenState({ ...base, segment: 'salvos' }).text, 'Você ainda não tem anúncios salvos disponíveis.')
  t.is(screenState({ ...base, node: { ...node, online: false } }).kind, 'offline')
  t.is(screenState({ ...base, node: { ...node, hosted: false } }).kind, 'off')
  t.is(screenState({ ...base, result: { off: true } }).text, 'A Feira não está aberta nesta instalação')
  for (const extra of [{ complete: false }, { indexing: true }, { unavailable: 1 }]) {
    t.is(screenState({ ...base, result: page([], extra) }).kind, 'incomplete')
  }
  t.is(screenState({ ...base, filters: {} }).kind, 'location')
  t.is(screenState({ ...base, filters: { ...filters, words: '!' } }).kind, 'words')
  t.is(screenState({ ...base, loading: true }).kind, 'loading')
  t.is(screenState({ ...base, result: page([row()]) }).kind, 'ready')
  t.is(screenState({ ...base, result: { ok: false } }).kind, 'error')
  let reads = 0
  const deps = { search: async () => { reads++; return page() } }
  await loadFeiraPage({ node: { ...node, online: false }, filters }, deps)
  await loadFeiraPage({ node: { ...node, hosted: false }, filters }, deps)
  await loadFeiraPage({ node, filters: {} }, deps)
  t.is(reads, 0, 'gated reads never reach the index')
  const off = await loadFeiraPage({ node, filters }, { search: async () => ({ off: true }) })
  t.is(screenState({ ...base, result: off }).kind, 'off')
})

test('Feira filters verify city, kind, category and whole words; Todos excludes procura', async (t) => {
  const { rowDecision, searchQuery, savedSearch, filterState } = await load()
  const opts = { filters }
  t.ok(rowDecision(row(), opts))
  t.absent(rowDecision(row({ kind: 'procura' }), opts))
  t.ok(rowDecision(row({ kind: 'servico' }), opts))
  t.absent(rowDecision(row(), { filters: { ...filters, kind: 'procura' } }))
  t.ok(rowDecision(row({ kind: 'procura' }), { filters: { ...filters, kind: 'procura' } }))
  t.absent(rowDecision(row(), { filters: { ...filters, kind: 'servico' } }))
  t.absent(rowDecision(row(), { filters: { ...filters, cat: 'casa' } }))
  t.ok(rowDecision(row(), { filters: { ...filters, cat: 'esporte', words: 'BICICLETA úso' } }))
  t.absent(rowDecision(row(), { filters: { ...filters, words: 'bici' } }))
  t.absent(rowDecision(row(), { filters: { ...filters, city: 'Campinas' } }))
  t.absent(rowDecision(row(), { filters: { ...filters, uf: 'RJ' } }))
  t.alike(searchQuery({ ...filters, city: ' SAO-PAULO ', words: 'azul uso' }), {
    uf: 'SP', cityKey: 'sao-paulo', kind: 'todos', cat: 'todas', tokens: 'azul+uso'
  })
  t.alike(savedSearch(filters), searchQuery(filters), 'PR4 receives the same query')
  t.is(savedSearch({}), null)
  t.alike(filterState({ uf: 'ZZ', kind: 'bad', cat: 'bad' }), { uf: '', city: '', kind: 'todos', cat: 'todas', words: '' })
})

test('Feira is on when the seeder answers its index, never by the sign-up policy', async (t) => {
  const { createFeiraProbe, loadFeiraPage } = await load()
  const calls = []
  const answers = [{ off: true }, { ok: true, items: [], next: null }]
  const probe = createFeiraProbe(async (request, author, cursor) => {
    calls.push([author, cursor])
    return answers.shift()
  })
  const request = async () => { throw new Error('unused') }
  t.alike(await probe(request, A), { enabled: false }, 'a 404 from the index is off')
  t.alike(await probe(request, A), { enabled: true }, 'off is asked again: the operator may switch it on')
  t.alike(await probe(request, A), { enabled: true }, 'on is kept')
  t.is(calls.length, 2)
  t.alike(calls[0], [A, null])
  const down = createFeiraProbe(async () => ({ ok: false, reason: 'timeout' }))
  t.is(await down(request, A), null, 'an unreachable seeder is not an answer')
  const thrown = createFeiraProbe(async () => { throw new Error('x') })
  t.is(await thrown(request, A), null)
  t.alike(await createFeiraProbe(async () => { throw new Error('never') })(request, 'nope'), { enabled: true }, 'no key: the index answers decide')
  let probes = 0
  const deps = { policy: async () => { probes++; return { enabled: false } } }
  t.is((await loadFeiraPage({ node, filters: {} }, deps)).off, true)
  t.is((await loadFeiraPage({ node, segment: 'salvos', saved: [] }, deps)).off, true)
  await loadFeiraPage({ node: { ...node, online: false }, filters }, deps)
  t.is(probes, 2, 'offline never probes')
  const failure = await loadFeiraPage({ node, filters }, { policy: async () => null })
  t.is(failure.ok, false, 'an unreachable seeder does not become an empty result')
})

test('Feira drops blocked rows and hides vendido only from the city segment', async (t) => {
  const { rowDecision, loadFeiraPage } = await load()
  const opts = { filters, ownKey: A }
  for (const segment of ['cidade', 'meus', 'salvos']) {
    t.absent(rowDecision(row({ blocked: true }), { ...opts, segment }))
    t.absent(rowDecision(row(), { ...opts, segment, blocked: new Set([A]) }))
    t.absent(rowDecision(row({ reason: 'revoked-issuer' }), { ...opts, segment }))
  }
  t.absent(rowDecision(row({ status: 'vendido' }), opts))
  t.ok(rowDecision(row({ status: 'vendido' }), { ...opts, segment: 'meus' }))
  t.ok(rowDecision(row({ status: 'vendido' }), { ...opts, segment: 'salvos' }))
  const res = await loadFeiraPage({ node, ...opts }, {
    search: async () => page([row(), row({ seq: 2, blocked: true }), row({ seq: 3, status: 'vendido' }), row({ seq: 4, kind: 'procura' })])
  })
  t.alike(res.items.map((r) => r.seq), [1])
})

test('Feira keeps stale rows in every segment and still drops blocked authors', async (t) => {
  const { rowDecision, loadFeiraPage } = await load()
  const stale = row({ author: P, stale: true, status: null, statusLabel: null })
  for (const segment of ['cidade', 'salvos', 'meus']) {
    const opts = { node, filters, segment, ownKey: A, acting: { kind: 'page', key: P }, saved: [{ author: P, seq: 1 }] }
    t.is(rowDecision(stale, opts), stale, segment + ': unknown status stays listed')
    t.absent(rowDecision(stale, { ...opts, blocked: new Set([P]) }), segment + ': blocked author stays hidden')
    t.absent(rowDecision({ ...stale, blocked: true }, opts))
    t.absent(rowDecision({ ...stale, reason: 'revoked-issuer' }, opts))
    const res = await loadFeiraPage(opts, { search: async () => page([stale]), byAuthor: async () => page([stale]) })
    t.alike(res.items, [stale], segment + ': loading preserves the stale row')
  }
  t.absent(rowDecision(row({ status: null }), { filters }), 'unknown status still requires the stale flag')
})

test('Meus reads listing.mine with its cursor and formats price units and peer text', async (t) => {
  const { loadFeiraPage } = await load()
  const calls = []
  const unsafe = 'Aula <b>'
  const mine = {
    ...node,
    request: async (method, params) => {
      calls.push({ method, params })
      return { items: [row({ kind: 'servico', title: unsafe, unit: 'hora', status: 'vendido' })], next: 1 }
    }
  }
  const res = await loadFeiraPage({ node: mine, ownKey: A, segment: 'meus', cursor: 8 })
  t.alike(calls, [{ method: 'listing.mine', params: { before: 8 } }])
  t.is(res.items.length, 1)
  t.is(res.items[0].status, 'vendido')
  t.is(res.items[0].title, rpc.displayText(unsafe))
  t.is(res.items[0].priceLabel, 'R$ 200,00/hora')
  t.is(res.next, 1)
})

test('Meus acting as a page uses its author route and never the member diary', async (t) => {
  const { loadFeiraPage, segmentSource } = await load()
  const opts = { node, segment: 'meus', ownKey: A, acting: { kind: 'page', key: P }, cursor: 'cursor' }
  t.alike(segmentSource(opts), { kind: 'author', author: P })
  const calls = []
  const res = await loadFeiraPage(opts, {
    byAuthor: async (request, author, cursor) => {
      calls.push({ author, cursor })
      return page([row({ author: P, status: 'vendido' }), row()], { next: 'next' })
    }
  })
  t.alike(calls, [{ author: P, cursor: 'cursor' }])
  t.alike(res.items.map((r) => r.author), [P])
  t.is(res.next, 'next')
})

test('Meus drops malformed listing text instead of rendering it', async (t) => {
  const { loadFeiraPage } = await load()
  const res = await loadFeiraPage({
    node: { ...node, request: async () => ({ items: [row({ title: 'A\u202eula' })], next: null }) },
    ownKey: A,
    segment: 'meus'
  })
  t.alike(res.items, [])
})

test('Salvos resolves current author pages, preserves saved order and drops missing references', async (t) => {
  const { loadFeiraPage, mergeRows } = await load()
  const calls = []
  const saved = [{ author: A, seq: 2 }, { author: A, seq: 1 }, { author: P, seq: 9 }]
  const res = await loadFeiraPage({ node, segment: 'salvos', saved }, {
    byAuthor: async (request, author, cursor) => {
      calls.push({ author, cursor })
      if (author === P) return page()
      return cursor === null ? page([row()], { next: 'next' }) : page([row({ seq: 2, status: 'vendido' })])
    }
  })
  t.alike(res.items.map((r) => r.seq), [2, 1])
  t.alike(calls, [{ author: A, cursor: null }, { author: A, cursor: 'next' }, { author: P, cursor: null }])
  t.is(res.complete, true)
  const partial = await loadFeiraPage({ node, segment: 'salvos', saved }, { byAuthor: async () => ({ ok: false }) })
  t.is(partial.complete, false)
  const repeated = await loadFeiraPage({ node, segment: 'salvos', saved: saved.slice(0, 1) }, { byAuthor: async () => page([], { next: 'same' }) })
  t.is(repeated.complete, false, 'repeated cursor stops continuation')
  t.alike(mergeRows([row()], [row({ status: 'vendido' }), row({ seq: 2 })]).map((r) => [r.seq, r.status]), [[1, 'vendido'], [2, 'disponivel']])
})

test('location persistence keeps only UF and city, survives bad storage and serializes writes', async (t) => {
  const { createLocationStore, LOCATION_KEY, filterState } = await load()
  const writes = []
  let stored = null
  const store = createLocationStore({
    read: async (key) => { t.is(key, LOCATION_KEY); return stored },
    write: async (key, raw) => { writes.push({ key, raw }); stored = raw }
  })
  t.alike(await store.load(), filterState())
  t.is(await store.save({ ...filters, words: 'bicicleta' }), true)
  t.alike(JSON.parse(stored), { v: 1, uf: 'SP', city: 'São Paulo' })
  t.alike(await store.load(), filterState(filters))
  await Promise.all([store.save({ uf: 'RJ', city: 'Rio de Janeiro' }), store.save(filters)])
  t.is(writes.length, 3)
  t.is((await store.load()).uf, 'SP')
  stored = '{broken'
  t.alike(await store.load(), filterState())
  stored = JSON.stringify({ v: 1, uf: 'SP', city: 'São Paulo', kind: 'procura', cat: 'casa', words: 'bicicleta' })
  t.alike(await store.load(), filterState(filters), 'stored extra fields never change the search')
  const failed = createLocationStore({ read: () => { throw new Error('refused') }, write: () => { throw new Error('refused') } })
  t.alike(await failed.load(), filterState())
  t.is(await failed.save(filters), false)
})

test('autor segment lists one author, keeps sold and stale rows, drops blocked ones', async (t) => {
  const { segmentSource, rowDecision, screenState, loadFeiraPage, TEXTS, SEGMENT_OPTIONS } = await load()
  t.absent(SEGMENT_OPTIONS.some((o) => o.id === 'autor'))
  t.alike(segmentSource({ segment: 'autor', author: P }), { kind: 'author', author: P })
  const opts = { node, segment: 'autor', author: P }
  t.ok(rowDecision(row({ author: P }), opts))
  t.ok(rowDecision(row({ author: P, status: 'vendido' }), opts), 'sold stays')
  t.ok(rowDecision(row({ author: P, stale: true, status: null, statusLabel: null }), opts), 'stale stays')
  t.absent(rowDecision(row({ author: A }), opts), 'other author dropped')
  t.absent(rowDecision(row({ author: P }), { ...opts, blocked: new Set([P]) }), 'blocked dropped')
  t.is(TEXTS.autor, 'Nenhum anúncio por aqui.')
  const empty = screenState({ node, segment: 'autor', result: page() })
  t.is(empty.kind, 'empty')
  t.is(empty.text, TEXTS.autor)
  const calls = []
  const byAuthor = async (request, author, cursor) => { calls.push(author); return page([row({ author: P }), row({ author: A, seq: 2 })]) }
  const res = await loadFeiraPage(opts, { byAuthor })
  t.alike(res.items.map((r) => r.author), [P])
  for (const author of [undefined, 'zz', P.toUpperCase()]) {
    const bad = await loadFeiraPage({ node, segment: 'autor', author }, { byAuthor })
    t.is(bad.ok, false)
    t.alike(bad.items, [])
  }
  t.alike(calls, [P], 'a bad key never reaches the request')
})

test('alert badge requires saved new items and an enabled Feira, keeps offline counts', async (t) => {
  const { alertsBadge, runFeiraAlerts } = await load()
  const state = { searches: [{ id: 'search' }], counts: { search: 2 } }
  t.ok(alertsBadge({ node, enabled: true, ...state }))
  t.ok(alertsBadge({ node: { ...node, online: false }, enabled: true, ...state }))
  t.absent(alertsBadge({ node, enabled: false, ...state }))
  t.absent(alertsBadge({ node: { ...node, hosted: false }, enabled: true, ...state }))
  t.absent(alertsBadge({ node, enabled: true, ...state, counts: { search: 0, removed: 2 } }))
  t.absent(alertsBadge({ node, enabled: true, ...state, searches: [] }))
  const store = { load: async () => state, beginRun: () => { throw new Error('must not run') } }
  for (const opts of [{ node: { ...node, online: false } }, { node: { ...node, visible: false } }, { enabled: false }, { isActive: () => false }]) {
    t.alike(await runFeiraAlerts({ node, enabled: true, isActive: () => true, store, ...opts }), state)
  }
})

test('alerts run sequentially, at most ten index calls, never follow cursors and throttle', async (t) => {
  const { runFeiraAlerts } = await load()
  const { createAlertsStore, INTERVAL_MS } = await import('../src/feiraAlerts.js')
  let raw = null
  const store = createAlertsStore({ read: () => raw, write: (value) => { raw = value } })
  const origin = 'https://bora.varanda.app'
  const now = Date.parse(row().at) + 100
  for (let i = 0; i < 10; i++) await store.add(origin, { uf: 'SP', cityKey: 'sao-paulo', cityLabel: 'São Paulo', kind: 'todos', cat: 'todas', tokens: ['busca' + i] }, now - 200)
  let calls = 0
  let pending = 0
  let maxPending = 0
  const search = async (request, query) => {
    calls++
    pending++
    maxPending = Math.max(maxPending, pending)
    t.is(query.cursor, null)
    await Promise.resolve()
    pending--
    return page([row({ title: query.tokens }), row({ seq: 2, title: 'unrelated' }), row({ seq: 3, title: query.tokens, status: 'vendido' }), row({ seq: 4, title: query.tokens, author: P })], { next: 'more' })
  }
  const options = { node, enabled: true, origin, store, now, isActive: () => true, blocked: new Set([P]) }
  const state = await runFeiraAlerts(options, { search })
  t.is(calls, 10)
  t.is(maxPending, 1)
  t.alike(Object.values(state.counts), Array(10).fill(1), 'only matching live unblocked rows count')
  await runFeiraAlerts(options, { search })
  t.is(calls, 10, 'same opening is throttled')
  let active = true
  await runFeiraAlerts({ ...options, now: now + INTERVAL_MS, isActive: () => active }, { search: async () => { calls++; active = false; return page([row()]) } })
  t.is(calls, 11, 'closing the tab stops remaining calls')
})

test('alerts keep previous counts on errors and stop on an off index', async (t) => {
  const { runFeiraAlerts } = await load()
  const searches = [1, 2].map((id) => ({ id, uf: 'SP', cityLabel: 'São Paulo', kind: 'todos', cat: 'todas', tokens: [], seenAtMs: 0 }))
  const state = { searches, counts: { 1: 3, 2: 4 } }
  let recorded = null
  const store = {
    load: async () => state,
    beginRun: async () => state,
    recordCounts: async (origin, results) => {
      recorded = results
      return { searches, counts: Object.fromEntries(results.map((r) => [r.id, r.count])) }
    }
  }
  const options = { node, enabled: true, store, isActive: () => true }
  let calls = 0
  const off = await runFeiraAlerts(options, { search: async () => { calls++; return { off: true } } })
  t.ok(off.off)
  t.alike(off.counts, { 1: 0, 2: 0 }, 'an off Feira clears the counts, so the tab dot goes out')
  t.alike(recorded.map((r) => r.count), [0, 0])
  t.is(calls, 1)
  recorded = null
  t.alike(await runFeiraAlerts(options, { search: async () => ({ ok: false }) }), state)
  t.alike(await runFeiraAlerts(options, { search: async () => { throw new Error('offline') } }), state)
  t.is(recorded, null, 'errors keep the previous counts')
})

test('saved-search segment probes availability without a city query; runner bounds even oversized input', async (t) => {
  const { loadFeiraPage, runFeiraAlerts } = await load()
  let probes = 0
  const result = await loadFeiraPage({ node, segment: 'buscas' }, {
    policy: async () => { probes++; return { enabled: true } },
    search: () => { throw new Error('no city query') }
  })
  t.is(result.ok, true)
  t.is(probes, 1)
  const state = { searches: Array.from({ length: 15 }, (_, id) => ({ id, uf: 'SP', cityLabel: 'São Paulo', kind: 'todos', cat: 'todas', tokens: [], seenAtMs: 0 })) }
  const store = { beginRun: async () => state, recordCounts: async () => state }
  let calls = 0
  await runFeiraAlerts({ node, enabled: true, store, isActive: () => true }, { search: async () => { calls++; return page() } })
  t.is(calls, 10)
})

test('Feira source pins: large-text Anunciar, chip padding and keyboard dismissed on search', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Feira.js'), 'utf8')
  const chips = readFileSync(join(__dirname, '../src/ui/FilterChips.js'), 'utf8')
  t.ok(screen.includes("import { TEXT_CAP } from '../ui/Sheet'"), 'the Anunciar label uses the shared text cap')
  t.ok(screen.includes('<Text style={styles.fabText} maxFontSizeMultiplier={TEXT_CAP}>Anunciar</Text>'), 'the Anunciar label is capped at large text')
  const body = screen.slice(screen.indexOf('function applyFilters'), screen.indexOf('async function saveSearch'))
  t.ok(body.startsWith('function applyFilters (next = filters) {\n    Keyboard.dismiss()\n'), 'applyFilters closes the keyboard first')
  t.ok(/import \{[^}]*\bKeyboard\b[^}]*\} from 'react-native'/.test(screen), 'Keyboard comes from react-native')
  t.ok(/row: \{[^}]*paddingVertical: space\.sm/.test(chips), 'filter chips have vertical padding')
})

test('view filters stay local: the dot, the partial note and a missing place', async (t) => {
  const { viewFilters, viewFiltersActive, filtersDot, partialNoteVisible, placeMissing, screenState } = await load()
  t.alike(viewFilters(), { sort: 'recentes', min: '', max: '', minCents: null, maxCents: null })
  t.alike(viewFilters(null), viewFilters())
  t.alike(viewFilters({ sort: 'nope', min: 1, max: null, minCents: -1, maxCents: 1.5 }), viewFilters())
  t.alike(viewFilters({ sort: 'menor', min: '1,00', max: '9', minCents: 0, maxCents: 900 }), {
    sort: 'menor', min: '1,00', max: '9', minCents: 0, maxCents: 900
  })
  t.alike(viewFilters({ sort: 'maior', minCents: 100, maxCents: 200 }), {
    sort: 'maior', min: '', max: '', minCents: 100, maxCents: 200
  })
  t.absent(viewFiltersActive(viewFilters()))
  t.ok(viewFiltersActive({ sort: 'menor' }))
  t.ok(viewFiltersActive({ sort: 'maior' }))
  t.ok(viewFiltersActive({ minCents: 0 }))
  t.ok(viewFiltersActive({ maxCents: 0 }))
  t.absent(viewFiltersActive({ min: '10', max: '20' }))
  t.absent(filtersDot(viewFilters(), 'todos'))
  t.absent(filtersDot(viewFilters(), ''))
  t.ok(filtersDot(viewFilters(), 'produto'))
  t.ok(filtersDot(viewFilters(), 'servico'))
  t.ok(filtersDot(viewFilters(), 'procura'))
  t.ok(filtersDot({ sort: 'menor' }, 'todos'))
  t.ok(filtersDot({ maxCents: 50 }, 'todos'))
  t.absent(partialNoteVisible(viewFilters(), true))
  t.absent(partialNoteVisible({ sort: 'menor' }, false))
  t.absent(partialNoteVisible({ sort: 'menor' }, null))
  t.absent(partialNoteVisible({ sort: 'menor' }, 1))
  t.ok(partialNoteVisible({ sort: 'menor' }, true))
  t.ok(partialNoteVisible({ sort: 'maior' }, true))
  t.ok(partialNoteVisible({ minCents: 0 }, true))
  t.ok(partialNoteVisible({ maxCents: 10 }, true))
  t.absent(partialNoteVisible({ sort: 'recentes', minCents: null, maxCents: null }, true))
  const samples = [
    {},
    { uf: 'SP' },
    { uf: 'SP', city: '  ' },
    { uf: 'ZZ', city: 'Recife' },
    filters,
    { ...filters, city: 'Campinas' },
    { ...filters, words: '!' }
  ]
  for (const sample of samples) {
    const kind = screenState({ node, filters: sample, result: page() }).kind
    t.is(placeMissing(sample), kind === 'location', 'place gate matches kind ' + kind)
  }
})

test('Feira home source: hero, grid, place sheet and filters', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Feira.js'), 'utf8')
  const start = screen.indexOf('{filtering')
  const end = screen.indexOf('{storageFailed')
  const gated = start >= 0 && end > start ? screen.slice(start, end) : ''
  t.ok(gated.includes('Onde você quer comprar e vender?'), 'hero is inside the header byAuthor skips')
  t.ok(gated.includes('Como funciona'))
  t.ok(gated.includes('<PlaceSheet'))
  t.ok(gated.includes('<FeiraFilters'))
  t.ok(gated.includes('<CategoryTiles'))
  t.ok(gated.includes("label='Palavras'"))
  t.ok(gated.includes("accessibilityLabel={'Trocar cidade, agora ' + placeLabel({ city: applied.city, uf: applied.uf })}"), 'the screen reader hears the current city')
  t.ok(screen.includes("const showSkeletons = segment !== 'buscas' &&"), 'no listing skeletons under the saved searches')
  t.ok(gated.includes("name='filtro'"))
  t.ok(screen.indexOf('Onde você quer comprar e vender?') < screen.indexOf('Como funciona'))
  t.ok(screen.indexOf('Como funciona') < screen.indexOf('Anuncie'))
  t.ok(screen.indexOf('Anuncie') < screen.indexOf('Converse'))
  t.ok(screen.indexOf('Converse') < screen.indexOf('Combine'))
  t.ok(screen.indexOf('Combine') < screen.indexOf('Avalie'))
  t.ok(screen.includes("label='Ver anúncios'"))
  t.ok(screen.includes('placeLabel({ city: applied.city, uf: applied.uf })'))
  t.ok(screen.includes("accessibilityLabel='Filtros'"))
  t.ok(screen.includes('>Filtros<'))
  t.ok(screen.includes('filtersDot(view, applied.kind)'))
  t.ok(screen.includes('onPick={(place) => applyFilters({ ...filters, uf: place.uf, city: place.city })}'))
  t.ok(screen.includes('setView(viewFilters(next))'))
  t.ok(screen.includes('applyFilters({ ...filters, kind: next.kind })'))
  t.ok(screen.includes('onChange={(cat) => applyFilters({ ...filters, cat })}'))
  t.ok(screen.includes('const showHero = filtering && segment === \'cidade\' && locationReady && placeMissing(applied)'))
  t.ok(screen.includes('const columns = columnsFor(width, fontScale >= LARGE_TEXT)'))
  t.ok(screen.includes('const browsed = browseListings(rows, cityBrowse ? view : viewFilters())'))
  t.ok(screen.includes('const grid = gridRows(controls && !showHero ? browsed : [], columns)'))
  t.ok(screen.includes('data={grid}'))
  t.ok(screen.includes('<ListingTile'))
  t.ok(screen.includes('width={tileWidth}'))
  t.ok(screen.includes('const note = cityBrowse && partialNoteVisible(view, !!(result && result.next !== null))'))
  t.ok(screen.includes('const pagePending = active && cityBrowse && !result && state.kind === \'empty\''))
  t.ok(screen.includes('const showEmpty = cityBrowse && browsed.length === 0 && result !== null && (state.kind === \'empty\' || state.kind === \'ready\')'))
  t.ok(screen.includes('const showSkeletons = segment !== \'buscas\' && browsed.length === 0 && !showHero && (state.kind === \'loading\' || pagePending)'))
  t.ok(screen.includes('fieldText(event, filters.words)'))
  t.ok(screen.includes('city: fieldText(event, filters.city)'))
  const applyBody = screen.slice(screen.indexOf('function applyFilters'), screen.indexOf('async function saveSearch'))
  t.ok(applyBody.includes("setPlaceError('')"), 'a new search clears the hero place error')
  t.ok(screen.includes('{PARTIAL_NOTE}'))
  t.ok(screen.includes('<SkeletonTile'))
  t.ok(screen.includes('<EmptyState'))
  t.ok(screen.includes("actionLabel='Limpar filtros'"))
  t.ok(screen.includes("secondaryLabel='Trocar cidade'"))
  t.ok(screen.includes('useWindowDimensions'))
  t.ok(screen.includes('onLayout={(event) =>'))
  t.ok(screen.includes('event.nativeEvent.layout.width'))
  t.ok(/import \{[^}]*\bLARGE_TEXT\b[^}]*\} from '\.\.\/ui\/theme'/.test(screen))
  t.absent(screen.includes('<ListingCard'))
  t.absent(screen.includes("label='Palavras (opcional)'"))
})
