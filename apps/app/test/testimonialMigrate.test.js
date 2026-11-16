// Moving the per-device hide list into node decisions.
'use strict'

const test = require('brittle')
const load = () => import('../src/testimonialHide.js')

const K = 'ab'.repeat(32)
const id = (n) => K + ':' + n

test('migrationParams: newest first-kept order, cap and seq bound', async (t) => {
  const { migrationParams } = await load()
  t.alike(migrationParams([id(1), id(2), id(3)], 2), [
    { from: K, seq: 3, state: 'kept', ifNew: true },
    { from: K, seq: 2, state: 'kept', ifNew: true }
  ])
  t.alike(migrationParams([id(1), id(4294967296), 'bad']), [{ from: K, seq: 1, state: 'kept', ifNew: true }])
  const many = Array.from({ length: 100 }, (_, i) => id(i + 1))
  t.is(migrationParams(many).length, 64)
})

test('migrationParams: allowed filters ids, absent keeps all', async (t) => {
  const { migrationParams } = await load()
  t.alike(migrationParams([id(1), id(2)], 64, new Set([id(1)])), [{ from: K, seq: 1, state: 'kept', ifNew: true }])
  t.alike(migrationParams([id(1)], 64, new Set()), [])
  t.is(migrationParams([id(1), id(2)], 64, undefined).length, 2)
})

test('migrateHidden: only allowed refs are sent, the list is still cleared', async (t) => {
  const { migrateHidden } = await load()
  const events = []
  const n = await migrateHidden({
    load: async () => [id(1), id(2), id(3)],
    clear: async () => { events.push('clear'); return true },
    request: async (m, p) => { events.push(p.seq) },
    allowed: new Set([id(2), id(3)])
  })
  t.is(n, 2)
  t.alike(events, ['clear', 3, 2], 'the foreign ref 1 is never sent')
})

test('migrateHidden: an empty allowed set sends nothing and still clears', async (t) => {
  const { migrateHidden } = await load()
  let cleared = 0
  let requests = 0
  const n = await migrateHidden({
    load: async () => [id(1), id(2)],
    clear: async () => { cleared++; return true },
    request: async () => { requests++ },
    allowed: new Set()
  })
  t.is(n, 0)
  t.is(requests, 0)
  t.is(cleared, 1)
})

test('migrateHidden: no allowed set keeps sending every ref', async (t) => {
  const { migrateHidden } = await load()
  const seen = []
  const n = await migrateHidden({
    load: async () => [id(1), id(2)],
    clear: async () => true,
    request: async (m, p) => { seen.push(p.seq) }
  })
  t.is(n, 2)
  t.alike(seen, [2, 1])
})

test('migrateHidden: empty list sends nothing', async (t) => {
  const { migrateHidden } = await load()
  let calls = 0
  const n = await migrateHidden({ load: async () => [], clear: async () => { calls++ }, request: async () => { calls++ } })
  t.is(n, 0)
  t.is(calls, 0)
})

test('migrateHidden: sequential, failures counted, clear always runs', async (t) => {
  const { migrateHidden } = await load()
  const seen = []
  let cleared = 0
  const n = await migrateHidden({
    load: async () => [id(1), id(2), id(3)],
    clear: async () => { cleared++ },
    request: async (m, p) => {
      t.is(m, 'testimonial.decide')
      seen.push(p.seq)
      if (p.seq === 2) throw new Error('x')
    }
  })
  t.alike(seen, [3, 2, 1], 'one call each, no retry')
  t.is(n, 2)
  t.is(cleared, 1)
})

test('migrateHidden: the list is cleared before the first request', async (t) => {
  const { migrateHidden } = await load()
  const events = []
  const n = await migrateHidden({
    load: async () => [id(1), id(2)],
    clear: async () => { events.push('clear'); return true },
    request: async () => { events.push('request') }
  })
  t.is(n, 2)
  t.alike(events, ['clear', 'request', 'request'])
})

test('migrateHidden: a failed clear sends nothing', async (t) => {
  const { migrateHidden } = await load()
  let requests = 0
  const n = await migrateHidden({
    load: async () => [id(1), id(2)],
    clear: async () => false,
    request: async () => { requests++ }
  })
  t.is(n, 0)
  t.is(requests, 0)
})

test('store clear empties memory and persists []', async (t) => {
  const { createTestimonialHideStore } = await load()
  let raw = JSON.stringify([id(1)])
  const store = createTestimonialHideStore({ read: () => raw, write: (r) => { raw = r } })
  t.alike(await store.load(), [id(1)])
  t.is(await store.clear(), true)
  t.is(raw, '[]')
  t.alike(await store.load(), [])
})
