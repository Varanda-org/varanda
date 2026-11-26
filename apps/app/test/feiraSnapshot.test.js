'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { compileFunction } = require('vm')

const screen = fs.readFileSync(path.join(__dirname, '../src/screens/Feira.js'), 'utf8')
const OWN = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)
const BLOCKED = 'cc'.repeat(32)
const binding = { owner: OWN, origin: 'https://bora.varanda.app', association: 'dd'.repeat(32), acting: { kind: 'me' } }
const scope = 'cidade:SP:São Paulo'
const cacheScope = 'stable:SP:São Paulo'

function section (start, end) {
  const a = screen.indexOf(start)
  if (a < 0) throw new Error('Missing screen section: ' + start)
  const b = screen.indexOf(end, a + start.length)
  if (b < 0) throw new Error('Missing screen section end: ' + end)
  return screen.slice(a, b)
}

// Execute the screen's non-JSX callbacks with controlled requests and timers.
function evaluate (body, context) {
  return compileFunction(body, Object.keys(context))(...Object.values(context))
}

function screenCallback (name, context) {
  const text = section('const ' + name + ' = useCallback(', '\n  }, [')
  return evaluate('return (' + text.slice(text.indexOf('useCallback(') + 12) + '\n})', context)
}

function readPage (stored) {
  return evaluate(section('function cachedPage (', '// locationStore:') + '\nreturn cachedPage', {
    loadScreenSnapshot: () => stored
  })
}

async function rows (count = 3) {
  const { mineView } = await import('../src/feiraScreen.js')
  return Array.from({ length: count }, (_, i) => mineView(i === 0 ? OWN : i === 1 ? BLOCKED : OTHER, {
    seq: i + 1,
    kind: 'produto',
    title: 'Bicicleta',
    text: 'aro 29',
    price: 50000,
    unit: null,
    cat: 'esporte',
    place: { uf: 'SP', city: 'São Paulo', bairro: null },
    at: new Date(Date.now() - 1000).toISOString(),
    status: 'disponivel',
    editSeq: null,
    editedAt: null
  }))
}

test('only the default root with the exact scope and a member binding seeds the first page', async (t) => {
  const items = await rows()
  const read = readPage({ body: { lists: { feira: { scope: cacheScope, rows: items } } } })
  const input = { byAuthor: null, segment: 'cidade', binding, scope, cacheScope }
  t.alike(read(input), { scope, result: { ok: true, cached: true, items, next: null }, pages: 1 })
  for (const patch of [{ cacheScope: 'another city' }, { cacheScope: cacheScope + ':filtered' }, { cacheScope: null }, { segment: 'salvos' }, { segment: 'buscas' }, { segment: 'meus' }, { byAuthor: OWN }, { binding: null }]) {
    t.is(read({ ...input, ...patch }), null, JSON.stringify(patch))
  }
  t.is(readPage(null)(input), null)
  t.is(readPage({ body: { lists: {} } })(input), null)
  t.ok(screen.includes('useState(() => cachedPage({ byAuthor, segment, binding, scope, cacheScope }))'), 'seeded before the first paint')
  t.ok(screen.includes('if (loaded?.scope !== scope)'), 'the saved place can arrive after mount')
  t.ok(screen.includes('loaded.scope === scope') && screen.includes('sameSnapshotBinding(seedBinding.current, binding)'), 'scope and identity changes hide the old copy')
  t.ok(screen.includes("memberSnapshotBinding({ node, acting, pageKey: acting.kind === 'page' ? acting.key : null })"), 'page actors and locked sessions use the shared binding guard')
})

test('cached rows use the render gate after every block state change', async (t) => {
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const items = await rows()
  const gate = section('const shownItems = useMemo(', 'const snapshotContext')
  const show = (loadState, keys, cached = true) => evaluate(gate + '\nreturn shownItems', {
    useMemo: (fn) => fn(), result: { cached }, items, blocks: { loadState, keys: new Set(keys) }, binding, cachedRowsShown
  })
  t.alike(show('pending', []).map((r) => r.author), [OWN], 'only own rows while blocks are pending')
  t.alike(show('error', []).map((r) => r.author), [OWN], 'failed block read stays closed')
  t.is(show('ok', []).length, 3)
  t.alike(show('ok', [BLOCKED]).map((r) => r.author), [OWN, OTHER], 'a later block hides its author')
  t.is(show('pending', [], false), items, 'live rows retain the existing filtering')
  t.ok(gate.includes('[items, result?.cached, blocks.loadState, blocks.keys, binding?.owner]'))
  t.ok(screen.includes('shownItems.filter((row) => rowDecision(row, options))'), 'the grid receives the gated rows')
  t.ok(screen.includes('onPress={result?.cached !== true ?'), 'cached tiles offer no open action')
  t.ok(section('async function toggleSave (', 'async function openSearch').includes('if (result?.cached === true) return'), 'no save action from a copy')
  t.ok(screen.includes('const hitFound = cityBrowse && !!result && result.cached !== true'), 'a copy does not write the last successful city')
})

test('a cached paint neither reads nor records a visit nor splits new rows; the live answer records once', async (t) => {
  const { visitStep } = await import('../src/feiraVisits.js')
  const visitSession = { current: null }
  const calls = []
  let visit = null
  const shown = (result) => evaluate(section('const listShown =', 'const narrowed =') + '\nreturn listShown', { result, visitId: 'city' })
  const effect = section('    const step = visitStep(', '  }, [visitId, listShown, narrowed])')
  const run = async (result) => {
    const listShown = shown(result)
    evaluate(effect, {
      visitStep,
      visitSession,
      visitId: 'city',
      listShown,
      narrowed: false,
      setVisit: (value) => { visit = value },
      alive: { current: true },
      savedOrigin: binding.origin,
      visitCity: scope,
      alertsStore: { visitCity: (...args) => { calls.push(args); return { previous: 100 } } }
    })
    await Promise.resolve()
    await Promise.resolve()
    return listShown
  }
  t.is(await run({ ok: true, cached: true }), false)
  t.is(calls.length, 0, 'no visitCity call, including a read-only call')
  t.is(visitSession.current, null)
  const fresh = evaluate(section('const fresh =', 'const grid =') + '\nreturn fresh', {
    listShown: false,
    visitId: 'city',
    result: { cached: true },
    since: 100,
    view: { sort: 'recentes' },
    browsed: [],
    splitNew: () => { throw new Error('cached rows must not split') },
    newRefs: () => new Set(),
    ownKey: OWN,
    actingPage: null
  })
  t.is(fresh, null, 'even a previous visit in memory cannot add a divider to the copy')
  t.is(await run({ ok: true }), true)
  t.is(calls.length, 1)
  t.is(calls[0][3], true, 'the first live answer records the visit')
  t.alike(visit, { id: 'city', since: 100 })
  await run({ ok: true })
  t.is(calls.length, 1, 'refresh does not consume another visit')
})

async function saveHarness () {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const { removeList } = await import('../src/listsSnapshot.js')
  const h = { gen: 7, now: binding, stored: null, writes: [], timers: new Map(), nextTimer: 0, reads: 0 }
  const saveTimer = { current: null }
  h.context = { current: { node: {}, blocks: { loadState: 'ok', keys: new Set() } } }
  h.currentScope = { current: scope }
  const cancelSave = () => { h.timers.delete(saveTimer.current); saveTimer.current = null }
  h.save = screenCallback('savePage', {
    cacheGeneration: () => h.gen,
    cancelSave,
    saveTimer,
    snapshotContext: h.context,
    actingAs: { get: () => ({ kind: 'me' }) },
    memberSnapshotBinding: () => h.now,
    sameSnapshotBinding: (b, now) => now !== null && ['owner', 'origin', 'association'].every((k) => b[k] === now[k]),
    currentScope: h.currentScope,
    loadScreenSnapshot: () => { h.reads++; return h.stored },
    removeList,
    buildScreenSnapshot,
    saveScreenSnapshot: (...args) => { h.writes.push(args); return false },
    setTimeout: (fn, delay) => { const id = ++h.nextTimer; h.timers.set(id, { fn, delay }); return id },
    SAVE_DELAY_MS: 2000
  })
  h.flush = () => {
    const timers = [...h.timers.values()]
    h.timers.clear()
    for (const timer of timers) timer.fn()
  }
  return h
}

test('the debounce saves only thirty unblocked live rows and preserves the latest other lists', async (t) => {
  const h = await saveHarness()
  const items = await rows(35)
  h.save(7, binding, scope, { ok: true, items }, cacheScope)
  t.is(h.reads, 0, 'the shared body is not read before the debounce')
  t.is([...h.timers.values()][0].delay, 2000)
  h.context.current.blocks.keys = new Set([BLOCKED])
  const other = { savedAt: Date.now() - 100, scope: '', rows: [OTHER], total: 1 }
  h.stored = { body: { lists: { seguindo: other } } }
  h.flush()
  t.is(h.writes.length, 1)
  const [kind, snapshot, gen] = h.writes[0]
  t.is(kind, 'listas')
  t.is(gen, 7)
  t.alike(snapshot.body.lists.seguindo, other)
  t.is(snapshot.body.lists.feira.scope, cacheScope)
  t.alike(snapshot.body.lists.feira.rows.map((r) => r.seq), items.filter((r) => r.author !== BLOCKED).slice(0, 30).map((r) => r.seq))
  t.is(h.timers.size, 0, 'a refused save is not retried')
})

test('off removes only the Feira entry and cancels a pending page save', async (t) => {
  const h = await saveHarness()
  const items = await rows()
  const other = { savedAt: Date.now() - 100, scope: '', rows: [OTHER], total: 1 }
  h.stored = { body: { lists: { feira: { savedAt: Date.now(), scope, rows: items }, seguindo: other } } }
  h.save(7, binding, scope, { ok: true, items }, cacheScope)
  h.save(7, binding, scope, { off: true, items: [] }, cacheScope)
  t.is(h.writes.length, 1)
  t.alike(h.writes[0][1].body.lists, { seguindo: other })
  h.flush()
  t.is(h.writes.length, 1, 'the cancelled page cannot resurrect Feira')
})

test('purges, identity changes, a new scope or unread blocks prevent a delayed write', async (t) => {
  const items = await rows()
  for (const change of [
    (h) => { h.gen++ },
    (h) => { h.now = null },
    (h) => { h.now = { ...binding, owner: OTHER } },
    (h) => { h.now = { ...binding, association: OTHER } },
    (h) => { h.now = { ...binding, origin: 'https://other.example' } },
    (h) => { h.currentScope.current = 'other city' },
    (h) => { h.context.current.blocks.loadState = 'pending' }
  ]) {
    const h = await saveHarness()
    h.save(7, binding, scope, { ok: true, items }, cacheScope)
    change(h)
    h.flush()
    t.is(h.writes.length, 0)
    t.is(h.timers.size, 0)
  }
  const h = await saveHarness()
  h.save(6, binding, scope, { ok: true, items }, cacheScope)
  h.save(7, null, scope, { ok: true, items }, cacheScope)
  t.is(h.timers.size, 0, 'an invalid generation or binding never arms a save')
  t.ok(section('const write = () => {', 'if (answer.off) write()').includes('const now = memberSnapshotBinding('), 'binding is recomputed at write time')
})

function loadHarness (result, segment = 'cidade', byAuthor = null) {
  const h = { gen: 7, commits: [], saves: [], requestGen: null }
  const answer = new Promise((resolve) => { h.resolve = resolve })
  const context = {
    active: true,
    locationReady: true,
    pending: { current: null },
    result,
    cacheGeneration: () => h.gen,
    byAuthor,
    segment,
    binding,
    cancelSave: () => {},
    loaded: { scope, result, pages: 1 },
    scope,
    cacheScope,
    seedBinding: { current: binding },
    setLoaded: (state) => h.commits.push(state),
    cachedPage: () => null,
    readSaved: () => {},
    generation: { current: 0 },
    setBusy: () => {},
    savedOrigin: binding.origin,
    listSaved: async () => [],
    loadFeiraPage: () => { h.requestGen = h.gen; return answer },
    node: { online: true, hosted: true },
    applied: {},
    ownKey: OWN,
    acting: { kind: 'me' },
    blocked: new Set(),
    probe: { current: () => {} },
    currentScope: { current: scope },
    createFeiraProbe: () => {},
    setAvailability: () => {},
    alertScope: 'alerts',
    mergeRows: () => { throw new Error('first page must replace') },
    savePage: (...args) => h.saves.push(args)
  }
  h.load = screenCallback('load', context)
  return h
}

test('the live first page replaces the copy and carries the generation captured before the request', async (t) => {
  const items = await rows()
  const cached = { ok: true, cached: true, items, next: null }
  const h = loadHarness(cached)
  const pending = h.load(false)
  t.is(h.requestGen, 7)
  h.gen = 8
  const answer = { ok: true, items: [{ ...items[0], title: 'Updated' }, items[2]], next: null }
  h.resolve(answer)
  await pending
  t.alike(h.commits, [{ scope, result: answer, pages: 1 }], 'deleted or sold rows leave; matching keys update in place')
  t.absent(h.commits[0].result.cached)
  t.is(h.saves[0][0], 7, 'the request generation survives a purge during the request')
  t.is(h.saves[0][1], binding)
  t.is(h.saves[0][4], cacheScope, 'the read carries the persistent scope to the save')
  t.ok(screen.includes('key={listing.author + \':\' + listing.seq}'), 'stable listing keys')
  for (const [segment, author] of [['salvos', null], ['buscas', null], ['meus', null], ['autor', OWN]]) {
    const h = loadHarness(cached, segment, author)
    const pending = h.load(false)
    h.resolve(answer)
    await pending
    t.is(h.saves[0][1], null, segment + ': no cache binding')
  }
  const off = loadHarness(cached)
  const pendingOff = off.load(false)
  off.resolve({ off: true, items: [], next: null })
  await pendingOff
  t.is(off.saves[0][3].off, true, 'off reaches the removal branch')
  const load = section('const load = useCallback(', 'const loadRef')
  t.ok(load.indexOf('const gen = cacheGeneration()') < load.indexOf('await loadFeiraPage('))
  t.ok(load.indexOf('const b =') < load.indexOf('await loadFeiraPage('))
})

function scopes (patch = {}) {
  const persistentScope = evaluate(section('function persistentScope (', 'function cachedPage (') + '\nreturn persistentScope', { LIST_SCOPE_MAX: 256 })
  return evaluate(section('const scope = JSON.stringify([applied, segment,', 'const currentScope =') + '\nreturn { scope, cacheScope }', {
    persistentScope,
    applied: { uf: 'SP', city: 'São Paulo', kind: 'todos', cat: 'todas', words: '' },
    segment: 'cidade',
    ownKey: OWN,
    acting: { kind: 'me' },
    savedOrigin: binding.origin,
    byAuthor: null,
    node: { epoch: 12, hosted: true, online: true },
    ...patch
  })
}

test('typed search words are never stored', (t) => {
  const persistentScope = evaluate(section('function persistentScope (', 'function cachedPage (') + '\nreturn persistentScope', { LIST_SCOPE_MAX: 256 })
  const base = { applied: { uf: 'SP', city: 'São Paulo', kind: 'todos', cat: 'todas', words: '' }, segment: 'cidade', ownKey: OWN, savedOrigin: binding.origin }
  t.ok(persistentScope(base), 'no words: a stored scope')
  t.is(persistentScope({ ...base, applied: { ...base.applied, words: 'bicicleta' } }), null, 'words: nothing stored')
  t.ok(persistentScope({ ...base, applied: { ...base.applied, words: '   ' } }), 'blank words count as none')
})

test('persistent Feira scope survives a cold launch and rejects other filters or oversized scopes', async (t) => {
  const { LIST_SCOPE_MAX } = await import('../src/listsSnapshot.js')
  const first = scopes()
  const items = await rows()
  const h = await saveHarness()
  h.currentScope.current = first.scope
  h.save(7, binding, first.scope, { ok: true, items }, first.cacheScope)
  h.flush()
  const stored = h.writes[0][1]
  t.ok(stored.body.lists.feira, 'the scope fits in a stored list')
  if (!stored.body.lists.feira) return
  t.is(stored.body.lists.feira.scope, first.cacheScope)
  t.ok(first.cacheScope.length <= LIST_SCOPE_MAX)
  for (const node of [{ epoch: 0, hosted: true, online: false }, { epoch: 1, hosted: true, online: true }]) {
    const reopened = scopes({ node })
    t.not(reopened.scope, first.scope, 'in-memory scope still tracks the connection')
    t.is(reopened.cacheScope, first.cacheScope)
    const page = readPage(stored)({ ...reopened, binding, segment: 'cidade', byAuthor: null })
    t.alike(page?.result.items, stored.body.lists.feira.rows, 'a new launch can use the stored page')
    t.is(page?.scope, reopened.scope, 'the page uses the current in-memory scope')
  }
  const applied = { uf: 'SP', city: 'São Paulo', kind: 'todos', cat: 'todas', words: '' }
  for (const patch of [
    ...Object.entries({ uf: 'RJ', city: 'Santos', kind: 'servico', cat: 'casa', words: 'bike' }).map(([key, value]) => ({ applied: { ...applied, [key]: value } })),
    { segment: 'salvos' }, { ownKey: OTHER }, { savedOrigin: 'https://other.test' }
  ]) {
    const changed = scopes(patch)
    t.not(changed.cacheScope, first.cacheScope)
    t.is(readPage(stored)({ ...changed, binding, segment: 'cidade', byAuthor: null }), null)
  }
  for (const patch of [{ applied: { ...applied, words: 'x'.repeat(300) } }, { savedOrigin: 'https://example.test/' + 'x'.repeat(300) }]) {
    const oversized = scopes(patch)
    t.is(oversized.cacheScope, null, 'oversized scopes are refused, never truncated')
    t.is(readPage(stored)({ ...oversized, binding, segment: 'cidade', byAuthor: null }), null)
    h.currentScope.current = oversized.scope
    h.save(7, binding, oversized.scope, { ok: true, items }, oversized.cacheScope)
    h.flush()
    t.is(h.writes.length, 1, 'an oversized scope does not arm a silent rejected save')
  }
})

test('new-since-visit divider remains after a failed load more but never appears on a copy', async (t) => {
  const { splitNew, newRefs } = await import('../src/feiraVisits.js')
  const items = await rows()
  const browsed = items.filter((row) => row.author !== OWN)
  const context = {
    visitId: 'city',
    since: Date.now() - 10000,
    view: { sort: 'recentes' },
    browsed,
    splitNew,
    newRefs,
    ownKey: OWN,
    actingPage: null
  }
  const fresh = (result, patch = {}) => evaluate(section('const fresh =', 'const grid =') + '\nreturn fresh', {
    ...context, result, listShown: result.ok !== false && result.cached !== true, ...patch
  })
  const before = fresh({ ok: true, items })
  t.is(before.fresh.length, browsed.length)
  const h = loadHarness({ ok: true, items, next: 'next-page' })
  const more = h.load(true)
  h.resolve({ ok: false, items: [], next: null })
  await more
  t.alike(fresh(h.commits[0].result), before, 'the failed page keeps the divider and visible rows')
  t.is(fresh({ ok: true, cached: true, items }), null)
  t.is(fresh({ ok: false, items }, { visitId: null }), null)
  t.is(fresh({ ok: true, items }, { view: { sort: 'menor' } }), null)
})
