'use strict'

// The stored block and mute lists (src/quietLists.js): the 'bloqueios' and
// 'silenciados' codecs, the two kinds through the screen snapshot store (web,
// over a fake localStorage) and the boot hand-off the providers read.
const test = require('brittle')

const load = () => import('../src/quietLists.js')
const loadRules = () => import('../src/screenSnapshot.js')
const loadWeb = () => import('../src/screenSnapshotStore.web.js')
const loadCaches = () => import('../src/localCaches.js')

const OWN = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const DAY = 24 * 60 * 60 * 1000
const ME = Object.freeze({ kind: 'me' })
const binding = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, ...extra })

// n distinct lowercase hex64 keys, ascending.
function keys (n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(i.toString(16).padStart(64, '0'))
  return out
}

function fakeStorage (t) {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
  t.teardown(() => { delete globalThis.localStorage })
  return map
}

test('codecs: a full list round-trips, one key more builds nothing', async (t) => {
  const { bloqueiosCodec, silenciadosCodec } = await load()
  const rpc = require('@varanda/rpc')
  t.is(rpc.BLOCK_MAX, 500)
  t.is(rpc.MUTE_MAX, 500)
  for (const codec of [bloqueiosCodec, silenciadosCodec]) {
    t.ok(Object.isFrozen(codec), codec.KIND + ' is frozen')
    t.is(codec.maxAgeMs, 14 * DAY)
    const full = keys(500)
    const body = codec.build({ keys: full.slice().reverse() })
    t.alike(body, { keys: full }, codec.KIND + ': sorted')
    t.alike(codec.parse(JSON.parse(JSON.stringify(body))), body, codec.KIND + ': round trip of 500 keys')
    t.is(codec.build({ keys: keys(501) }), null, codec.KIND + ': 501 keys build nothing')
    t.is(codec.parse({ keys: keys(501) }), null, codec.KIND + ': 501 keys fail parse')
    t.alike(codec.build({ keys: new Set() }), { keys: [] }, codec.KIND + ': an empty list is a body')
    t.alike(codec.parse({ keys: [] }), { keys: [] }, codec.KIND + ': and parses')
    t.is(codec.build({}), null, codec.KIND + ': no list, no body')
    t.is(codec.build(null), null)
  }
})

test('codecs: build cleans, parse is strict', async (t) => {
  const { bloqueiosCodec: codec } = await load()
  const upper = OTHER.toUpperCase()
  t.alike(codec.build({ keys: [upper, OTHER, 'nope', 7, null, OWN] }), { keys: [OWN, OTHER] }, 'lowercased, deduplicated, bad keys skipped')
  t.alike(codec.build({ keys: [...keys(500), keys(1)[0], 'x'] }).keys.length, 500, 'duplicates and bad keys do not count')
  t.is(codec.build({ keys: [OWN] }, { fits: () => false }), null, 'over the size cap')
  t.is(codec.parse({ keys: [OTHER, OWN] }), null, 'unsorted')
  t.is(codec.parse({ keys: [OWN, OWN] }), null, 'duplicated')
  t.is(codec.parse({ keys: [upper] }), null, 'uppercase')
  t.is(codec.parse({ keys: ['zz'.repeat(32)] }), null, 'not hex')
  t.is(codec.parse({ keys: [OWN.slice(1)] }), null, 'too short')
  t.is(codec.parse({ keys: [7] }), null, 'not a string')
  t.is(codec.parse({ keys: [OWN], extra: 1 }), null, 'an extra body key')
  t.is(codec.parse({}), null, 'no keys')
  t.is(codec.parse({ keys: 'x' }), null, 'not an array')
  t.is(codec.parse([OWN]), null, 'not an object')
  const body = { keys: [OWN] }
  t.is(codec.withoutAuthors(body, [OWN]), body, 'withoutAuthors returns the same body')
  t.absent('keepOnlyAuthors' in codec)
})

test('store: bound to owner, origin and association, kept 14 days, wiped with the rest', async (t) => {
  const map = fakeStorage(t)
  const store = await loadWeb()
  const { buildScreenSnapshot, parseScreenSnapshot } = await loadRules()
  const { cacheGeneration, wipeLocalCaches, dropAuthors } = await loadCaches()
  for (const kind of ['bloqueios', 'silenciados']) {
    const snap = buildScreenSnapshot(kind, { ...binding(), keys: [OTHER] })
    t.alike(snap.body, { keys: [OTHER] })
    t.is(store.saveScreenSnapshot(kind, snap, cacheGeneration()), true, kind + ' saved')
    t.alike(store.loadScreenSnapshot(kind, binding()), snap, kind + ' loads')
    dropAuthors([OTHER])
    t.alike(store.loadScreenSnapshot(kind, binding()), snap, kind + ': a block keeps the stored list')
    for (const other of [{ owner: OTHER }, { origin: 'https://outro.app' }, { association: 'ab'.repeat(32) }]) {
      t.is(parseScreenSnapshot(JSON.stringify(snap), kind, binding(other)), null, kind + ' refused for ' + Object.keys(other)[0])
    }
    t.is(store.loadScreenSnapshot(kind, binding({ owner: OTHER })), null, kind + ': another owner does not load')
    t.absent(map.has('varanda-screen-' + kind), 'and the copy goes')

    const gen = cacheGeneration()
    wipeLocalCaches()
    t.is(store.saveScreenSnapshot(kind, snap, gen), false, kind + ': a save prepared before a wipe is dropped')

    const old = buildScreenSnapshot(kind, { ...binding(), now: Date.now() - 15 * DAY, keys: [OTHER] })
    t.is(store.saveScreenSnapshot(kind, old, cacheGeneration()), true)
    t.is(store.loadScreenSnapshot(kind, binding()), null, kind + ': older than 14 days does not load')
    t.absent(map.has('varanda-screen-' + kind))

    const empty = buildScreenSnapshot(kind, { ...binding(), keys: [] })
    t.is(store.saveScreenSnapshot(kind, empty, cacheGeneration()), true)
    t.alike(store.loadScreenSnapshot(kind, binding()).body, { keys: [] }, kind + ': an empty list is a copy')

    const hand = { ...snap, body: { keys: [OTHER], extra: true } }
    t.is(store.saveScreenSnapshot(kind, hand, cacheGeneration()), false, kind + ': a hand-built body is refused')
  }
  for (const kind of ['bloqueios', 'silenciados']) {
    t.is(store.saveScreenSnapshot(kind, buildScreenSnapshot(kind, { ...binding(), keys: [OTHER] }), cacheGeneration()), true)
  }
  t.ok(map.has('varanda-screen-bloqueios') && map.has('varanda-screen-silenciados'))
  wipeLocalCaches()
  t.absent(map.has('varanda-screen-bloqueios'), 'a wipe removes bloqueios')
  t.absent(map.has('varanda-screen-silenciados'), 'a wipe removes silenciados')
})

test('boot hand-off: notifies on every change and keeps the reference until then', async (t) => {
  const q = await load()
  q.clearBootLists()
  q.setQuietListsMayStore(false)
  let calls = 0
  const off = q.subscribeQuietLists(() => { calls++ })
  t.teardown(off)
  t.is(q.bootLists(), null)

  t.is(q.publishBootLists({ owner: OWN, origin: ORIGIN, association: ASSOC, blocks: [OTHER.toUpperCase(), 'nope'], mutes: new Set([OWN]), wipe: 3 }), true)
  t.is(calls, 1)
  const first = q.bootLists()
  t.ok(Object.isFrozen(first))
  t.is(first.owner, OWN)
  t.is(first.origin, ORIGIN)
  t.is(first.association, ASSOC)
  t.is(first.wipe, 3)
  t.ok(first.blocks instanceof Set && first.mutes instanceof Set)
  t.alike([...first.blocks], [OTHER], 'lowercase hex64 only')
  t.alike([...first.mutes], [OWN])
  t.is(q.bootLists(), first, 'the same reference until the next change')

  t.is(q.publishBootLists({ owner: OWN, origin: ORIGIN, association: ASSOC, blocks: [], wipe: 3 }), false, 'without both lists nothing is published')
  t.is(calls, 1)
  t.is(q.bootLists(), first)

  q.publishBootLists({ owner: OWN, origin: ORIGIN, association: ASSOC, blocks: [], mutes: [], wipe: 4 })
  t.is(calls, 2)
  t.not(q.bootLists(), first, 'a new publish is a new reference')

  q.clearBootLists()
  t.is(calls, 3)
  t.is(q.bootLists(), null)
  q.clearBootLists()
  t.is(calls, 3, 'clearing nothing changes nothing')

  t.is(q.mayStoreQuietLists(), false)
  q.setQuietListsMayStore(true)
  t.is(q.mayStoreQuietLists(), true)
  t.is(calls, 4)
  q.setQuietListsMayStore(true)
  t.is(calls, 4, 'the same value is no change')
  q.setQuietListsMayStore(false)
  t.is(calls, 5)

  let other = 0
  const offThrow = q.subscribeQuietLists(() => { throw new Error('boom') })
  const offOther = q.subscribeQuietLists(() => { other++ })
  q.setQuietListsMayStore(true)
  t.is(other, 1, 'a throwing subscriber does not stop the others')
  offThrow()
  offOther()
  off()
  q.setQuietListsMayStore(false)
  t.is(calls, 6, 'unsubscribed')
  t.is(other, 1)
})
