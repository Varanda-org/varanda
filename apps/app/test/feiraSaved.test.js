'use strict'

// Saved Feira listings (src/feiraSaved.js and the web store). ES modules
// loaded through import(); read and write are in-memory fakes.
const test = require('brittle')

const load = () => import('../src/feiraSaved.js')
const O1 = 'https://bora.varanda.app'
const O2 = 'https://outra.example.org'
const key = (i) => i.toString(16).padStart(64, '0')
const ref = (i, seq = 1) => ({ author: key(i), seq })

function disk (initial = null) {
  const d = { raw: initial, writes: 0 }
  d.read = async () => d.raw
  d.write = async (raw) => { d.writes++; d.raw = raw }
  return d
}

test('toggle, has, list and clear', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  t.alike(await store.list(O1), [])
  t.alike(await store.toggle(O1, ref(1)), { saved: true, full: false, persisted: true })
  t.alike(await store.toggle(O1, ref(2, 5)), { saved: true, full: false, persisted: true })
  t.ok(await store.has(O1, ref(1)))
  t.absent(await store.has(O1, ref(1, 2)))
  t.alike(await store.list(O1), [ref(2, 5), ref(1)], 'newest first')
  t.alike(await store.toggle(O1, ref(1)), { saved: false, full: false, persisted: true })
  t.alike(await store.list(O1), [ref(2, 5)])
  t.ok(await store.remove(O1, ref(2, 5)))
  t.alike(await store.list(O1), [])
  await store.toggle(O1, ref(3))
  t.ok(await store.clear(O1))
  t.alike(await store.list(O1), [])

  const again = s.createSavedStore({ read: d.read, write: d.write })
  t.alike(await again.list(O1), [], 'the cleared list was persisted')
})

test('cap: at most 100 refs per origin', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk())
  for (let i = 1; i <= s.MAX_SAVED; i++) t.is((await store.toggle(O1, ref(i))).saved, true)
  t.alike(await store.toggle(O1, ref(500)), { saved: false, full: true, persisted: false })
  t.is((await store.list(O1)).length, 100)
  t.absent(await store.has(O1, ref(500)))
  t.ok((await store.toggle(O2, ref(500))).saved, 'another origin has its own cap')
  await store.toggle(O1, ref(1))
  t.ok((await store.toggle(O1, ref(500))).saved, 'room again after removing one')

  const crowded = JSON.stringify({ v: 1, origins: [{ origin: O1, refs: Array.from({ length: 150 }, (_, i) => ref(i + 1)) }] })
  t.is(s.decodeSaved(crowded).get(O1).length, 100, 'a crowded file is cut on read')
})

test('no title or other peer text is stored', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.toggle(O1, { ...ref(1), title: 'Bicicleta', text: 'segredo' })
  t.absent(d.raw.includes('Bicicleta'))
  t.absent(d.raw.includes('segredo'))
  t.alike(JSON.parse(d.raw), { v: 1, origins: [{ origin: O1, refs: [ref(1)] }] })
  const hostile = JSON.stringify({ v: 1, origins: [{ origin: O1, refs: [{ ...ref(2), title: 'x' }], note: 'y' }] })
  const back = s.createSavedStore(disk(hostile))
  await back.toggle(O1, ref(3))
  t.alike(await back.list(O1), [ref(3), ref(2)])
})

test('origin isolation', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.toggle(O1, ref(1))
  await store.toggle(O2, ref(2))
  t.alike(await store.list(O1), [ref(1)])
  t.alike(await store.list(O2), [ref(2)])
  t.absent(await store.has(O2, ref(1)))
  await store.clear(O2)
  t.alike(await store.list(O1), [ref(1)], 'clearing one origin keeps the other')
  for (const bad of ['http://bora.varanda.app', O1 + '/', 'javascript:x', null]) {
    t.alike(await store.list(bad), [])
    t.is((await store.toggle(bad, ref(9))).saved, false)
  }
  for (let i = 0; i < s.MAX_ORIGINS + 2; i++) await store.toggle('https://o' + i + '.example.org', ref(1))
  const reread = s.decodeSaved(d.raw)
  t.is(reread.size, s.MAX_ORIGINS, 'the oldest origins are forgotten')
  t.absent(reread.has(O1))
})

test('bad refs and broken storage', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk('{not json'))
  t.alike(await store.list(O1), [])
  for (const bad of [null, { author: key(1) }, { author: key(171).toUpperCase(), seq: 1 }, { author: key(1), seq: 0 }, { author: key(1), seq: '1' }]) {
    t.is((await store.toggle(O1, bad)).saved, false)
    t.is(await store.has(O1, bad), false)
  }
  const failing = s.createSavedStore({ read: async () => { throw new Error('denied') }, write: async () => { throw new Error('quota') } })
  const out = await failing.toggle(O1, ref(1))
  t.alike(out, { saved: true, full: false, persisted: false }, 'a refused write is reported')
  t.ok(await failing.has(O1, ref(1)), 'memory keeps the change for this run')
  t.alike([...s.decodeSaved(JSON.stringify({ v: 2, origins: [] }))], [])
})

test('web store persists through localStorage', async (t) => {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) }
  }
  try {
    const web = await import('../src/feiraSavedStore.web.js')
    const s = await load()
    t.ok((await web.toggleSaved(O1, ref(1))).saved)
    t.ok(await web.isSaved(O1, ref(1)))
    t.alike(await web.listSaved(O1), [ref(1)])
    t.alike(JSON.parse(map.get(s.STORAGE_KEY)), { v: 1, origins: [{ origin: O1, refs: [ref(1)] }] })
    t.ok(await web.clearSaved(O1))
  } finally {
    delete globalThis.localStorage
  }
})

test('two stores over one storage keep each other\'s saves', async (t) => {
  const s = await load()
  const d = disk()
  const tab1 = s.createSavedStore({ read: d.read, write: d.write })
  const tab2 = s.createSavedStore({ read: d.read, write: d.write })
  t.alike(await tab1.list(O1), [])
  t.alike(await tab2.list(O1), [])
  await tab1.toggle(O1, ref(1))
  await tab2.toggle(O1, ref(2))
  t.alike(s.decodeSaved(d.raw).get(O1), [ref(2), ref(1)], 'both saves are stored')
  t.alike(await tab1.list(O1), [ref(2), ref(1)], 'a read sees the other store')
  t.ok(await tab1.has(O1, ref(2)))
  await tab2.toggle(O2, ref(3))
  t.ok(await tab1.remove(O1, ref(1)))
  t.alike(await tab2.list(O1), [ref(2)], 'a remove neither resurrects nor drops the other entries')
  t.alike(await tab2.list(O2), [ref(3)])
  await tab2.toggle(O1, ref(4))
  t.ok(await tab1.clear(O2))
  t.alike(await tab1.list(O1), [ref(4), ref(2)])
  t.alike(await tab2.list(O2), [])
})
