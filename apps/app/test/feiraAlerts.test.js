'use strict'

const test = require('brittle')
const load = () => import('../src/feiraAlerts.js')
const O1 = 'https://bora.varanda.app'
const O2 = 'https://outra.example.org'
const query = { uf: 'SP', cityKey: 'sao-paulo', cityLabel: 'São Paulo', kind: 'todos', cat: 'todas', tokens: ['azul', 'bicicleta'] }
const disk = () => {
  let raw = null
  return { read: () => raw, write: (value) => { raw = value } }
}

test('saved searches cap at ten, dedupe by canonical shape and bound tokens', async (t) => {
  const { add, list, remove } = await load()
  let searches = []
  for (let i = 0; i < 10; i++) searches = add(searches, { ...query, tokens: ['busca' + i] }, 100).searches
  t.is(searches.length, 10)
  t.is(add(searches, query, 200).full, true)
  const duplicate = add(searches, { ...query, cityLabel: 'SAO PAULO', tokens: ['BUSCA0'], label: 'other' }, 200)
  t.is(duplicate.saved, true)
  t.is(duplicate.searches.length, 10)
  t.is(duplicate.searches[0].seenAtMs, 100)
  t.is(remove(searches, searches[0].id).length, 9)
  t.is(list([...searches, { ...query, tokens: ['eleventh'] }]).length, 10)
  t.is(add([], { ...query, tokens: Array.from({ length: 20 }, (_, i) => 'palavra' + i) }, 0).searches[0].tokens.length, 8)
  t.alike(list([null, {}, { ...query, uf: 'ZZ' }, { ...query, cityKey: 'outra' }]), [])
  const a = add([], query, 100).searches
  t.alike(add(a, { ...query, tokens: ['BICICLETA', 'azul', 'azul'] }, 200).searches, a)
})

test('plan throttles runs for fifteen minutes and markSeen never moves backwards', async (t) => {
  const { plan, INTERVAL_MS, add, markSeen } = await load()
  t.ok(plan(0, null))
  t.absent(plan(INTERVAL_MS - 1, 0))
  t.ok(plan(INTERVAL_MS, 0))
  t.absent(plan(99, 100))
  t.absent(plan(NaN, null))
  const searches = add([], query, 100).searches
  const next = markSeen(searches, searches[0].id, 200)
  t.is(next[0].seenAtMs, 200)
  t.is(searches[0].seenAtMs, 100)
  t.is(markSeen(next, next[0].id, 150)[0].seenAtMs, 200)
})

test('countNew ignores sold, future, stale, old, malformed and duplicate rows', async (t) => {
  const { countNew } = await load()
  const row = (seq, at, status = 'disponivel') => ({ author: 'ab'.repeat(32), seq, at: new Date(at).toISOString(), status })
  const page = { items: [row(1, 101), row(1, 101), row(2, 102, 'reservado'), row(3, 103, 'vendido'), row(4, 201), row(5, 100), row(6, 90), { ...row(7, 110), stale: true }, { ...row(8, 110), at: 'invalid' }, { ...row(9, 110), author: 'bad' }, null] }
  t.is(countNew(page, 100, 200), 2)
  t.is(countNew(page, 200, 200), 0)
  t.is(countNew(null, 0, 200), 0)
})

test('JSON storage isolates origins, strips listing text and merges pending counts safely', async (t) => {
  const { createAlertsStore } = await load()
  const d = disk()
  const store = createAlertsStore(d)
  const first = await store.add(O1, { ...query, title: 'seller title', text: 'seller text' }, 100)
  const id = first.searches[0].id
  t.ok(first.persisted)
  t.absent(d.read().includes('seller'))
  t.alike(Object.keys(first.searches[0]).sort(), ['id', 'uf', 'cityKey', 'cityLabel', 'kind', 'cat', 'tokens', 'seenAtMs', 'label'].sort())
  t.alike(await store.list(O2), [])
  await store.add(O2, query, 50)
  t.is((await store.list(O2))[0].seenAtMs, 50)
  const runs = await Promise.all([store.beginRun(O1, 200), store.beginRun(O1, 200)])
  t.ok(runs[0])
  t.is(runs[1], null, 'overlapping runs are throttled')
  await store.recordCounts(O1, [{ id, seenAtMs: 100, count: 3 }])
  t.is((await store.load(O1)).counts[id], 3)
  await store.markSeen(O1, id, 200)
  await store.recordCounts(O1, [{ id, seenAtMs: 100, count: 4 }])
  t.is((await store.load(O1)).counts[id], 0, 'late result cannot restore cleared count')
  t.is((await createAlertsStore(d).load(O1)).lastRun, 200)
  await store.remove(O1, id)
  t.alike(await store.list(O1), [])
  t.is((await store.list(O2)).length, 1)
  t.is((await store.add('http://invalid.example', query, 100)).persisted, false)
})

test('broken storage is tolerated and a refused write keeps the session change', async (t) => {
  const { createAlertsStore } = await load()
  const store = createAlertsStore({ read: () => '{broken', write: () => { throw new Error('quota') } })
  t.alike(await store.list(O1), [])
  t.is((await store.add(O1, query, 100)).persisted, false)
  t.is((await store.list(O1)).length, 1)
})

test('web adapter persists JSON and reads changes from another store', async (t) => {
  const { createAlertsStore, STORAGE_KEY } = await load()
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, raw) => values.set(key, raw)
  }
  try {
    const { alertsStore } = await import('../src/feiraAlertsStore.web.js')
    await alertsStore.add(O1, query, 100)
    const raw = values.get(STORAGE_KEY)
    t.is(typeof raw, 'string')
    t.is(JSON.parse(raw).v, 1)
    const other = createAlertsStore({ read: () => values.get(STORAGE_KEY), write: (raw) => values.set(STORAGE_KEY, raw) })
    await other.add(O1, { ...query, tokens: ['outra'] }, 200)
    t.is((await alertsStore.list(O1)).length, 2)
    const id = (await alertsStore.list(O1))[0].id
    await alertsStore.markSeen(O1, id, 300)
    t.is((await other.list(O1))[0].seenAtMs, 300)
  } finally {
    delete globalThis.localStorage
  }
})

test('the "+" flag is stored beside the count, survives a fresh load and old records read as no "+"', async (t) => {
  const { createAlertsStore } = await load()
  const { newCountLabel } = await import('../src/feiraScreen.js')
  let raw = null
  const store = createAlertsStore({ read: () => raw, write: (value) => { raw = value } })
  await store.add(O1, query, 100)
  const id = (await store.load(O1)).searches[0].id
  await store.recordCounts(O1, [{ id, seenAtMs: 100, count: 3, more: true }])
  const fresh = await createAlertsStore({ read: () => raw, write: () => {} }).load(O1)
  t.is(newCountLabel(fresh.counts[id], fresh.more[id]), '3+ novos')
  const old = JSON.parse(raw)
  delete old.origins[0].more
  const legacy = await createAlertsStore({ read: () => JSON.stringify(old), write: () => {} }).load(O1)
  t.is(newCountLabel(legacy.counts[id], legacy.more[id]), '3 novos')
  await store.markSeen(O1, id, 200)
  t.is((await store.load(O1)).more[id], false, 'opening a search clears the flag')
})

test('the store keeps the time each city was last shown, per origin, and survives the saved searches changing', async (t) => {
  const { createAlertsStore } = await load()
  const d = disk()
  const store = createAlertsStore(d)
  t.is((await store.visitCity(O1, 'SP/sao-paulo', 100)).previous, null, 'a first visit has no earlier time')
  t.is((await store.visitCity(O1, 'SP/sao-paulo', 200)).previous, 100)
  t.is((await store.visitCity(O1, 'RJ/rio-de-janeiro', 300)).previous, null, 'another city is independent')
  t.is((await store.visitCity(O2, 'SP/sao-paulo', 400)).previous, null, 'another origin is independent')
  t.is((await store.visitCity(O1, 'SP/sao-paulo', 150)).previous, 200)
  t.is((await store.visitCity(O1, 'SP/sao-paulo', 500, false)).previous, 200, 'a read does not move the time')
  t.is((await store.visitCity(O1, 'SP/sao-paulo', 600)).previous, 200, 'and the stored time stayed')
  const saved = await store.add(O1, query, 700)
  await store.markSeen(O1, saved.searches[0].id, 800)
  await store.recordCounts(O1, [{ id: saved.searches[0].id, seenAtMs: 800, count: 2 }])
  await store.beginRun(O1, 900)
  await store.remove(O1, saved.searches[0].id)
  t.alike((await createAlertsStore(d).load(O1)).visits, { 'SP/sao-paulo': 600, 'RJ/rio-de-janeiro': 300 }, 'kept on disk through every other change')
  t.is((await store.visitCity('http://invalid.example', 'SP/sao-paulo', 1)).persisted, false)
})
