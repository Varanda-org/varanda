'use strict'

// src/media/keptLoad.js: the kept store read before any fetch, the keep after
// a verified fetch, and the purges (wipe, author drop, range revoke) that
// bump the generation during a fetch. The store is an in-memory fake; the
// registry (src/localCaches.js) and revokeMedia (src/media/cache.js) are real.
const test = require('brittle')

const loadKeptMod = () => import('../src/media/keptLoad.js')
const loadCaches = () => import('../src/localCaches.js')
const loadCache = () => import('../src/media/cache.js')

const A = 'a1'.repeat(32)
const CORE = 'c3'.repeat(32)
const BYTES = new Uint8Array([1, 2, 3, 4])

const desc = (over = {}) => ({
  core: CORE,
  mime: 'image/jpeg',
  start: 1,
  blocks: 1,
  bytes: 4,
  sha256: 'e5'.repeat(32),
  width: 10,
  height: 20,
  ...over
})

function fakeStore () {
  const files = new Map()
  const calls = { keptUrl: 0, keep: 0, dropKeptRanges: [], dropKeptAuthors: [], keepOnlyKeptAuthors: [], wipeKept: 0 }
  const name = (kind, author, d) => kind + '/' + author + '-' + d.core + '-' + d.start
  return {
    files,
    calls,
    keptUrl (kind, author, d) {
      calls.keptUrl++
      return files.get(name(kind, author, d)) || null
    },
    keep (kind, author, d, bytes) {
      calls.keep++
      const uri = 'file:///kept/' + name(kind, author, d)
      files.set(name(kind, author, d), uri)
      return uri
    },
    dropKeptRanges (ranges) { calls.dropKeptRanges.push(ranges); files.clear() },
    dropKeptAuthors (keys) { calls.dropKeptAuthors.push([...keys]); files.clear() },
    keepOnlyKeptAuthors (keys) { calls.keepOnlyKeptAuthors.push([...keys]) },
    wipeKept () { calls.wipeKept++; files.clear() }
  }
}

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

async function setup (over = {}) {
  const { loadKept } = await loadKeptMod()
  const { cacheGeneration } = await loadCaches()
  const store = fakeStore()
  const fetched = { n: 0 }
  const args = {
    kind: 'posts',
    author: A,
    d: desc(),
    persist: true,
    keptUrl: store.keptUrl,
    keep: store.keep,
    fetchBytes: async () => { fetched.n++; return BYTES },
    urlFromBytes: (bytes, mime) => 'blob:fresh-' + mime,
    generation: cacheGeneration,
    ...over
  }
  return { loadKept, store, fetched, args }
}

test('a kept hit calls neither fetchBytes nor keep', async (t) => {
  const { loadKept, store, fetched, args } = await setup()
  store.files.set('posts/' + A + '-' + CORE + '-1', 'file:///kept/hit')
  t.is(await loadKept(args), 'file:///kept/hit')
  t.is(fetched.n, 0)
  t.is(store.calls.keep, 0)
})

test('a miss with persist fetches once, keeps and returns the kept URI', async (t) => {
  const { loadKept, store, fetched, args } = await setup()
  const url = await loadKept(args)
  t.is(url, 'file:///kept/posts/' + A + '-' + CORE + '-1')
  t.is(fetched.n, 1)
  t.is(store.calls.keep, 1)
  t.is(await loadKept(args), url, 'the next load is a hit')
  t.is(fetched.n, 1)
})

test('keep returning null falls back to urlFromBytes', async (t) => {
  const { loadKept, args } = await setup({ keep: () => null })
  t.is(await loadKept(args), 'blob:fresh-image/jpeg')
})

test('persist false never calls keptUrl or keep', async (t) => {
  const { loadKept, store, fetched, args } = await setup({ persist: false })
  t.is(await loadKept(args), 'blob:fresh-image/jpeg')
  t.is(fetched.n, 1)
  t.is(store.calls.keptUrl, 0)
  t.is(store.calls.keep, 0)
})

test('an author that is not lowercase hex64 never touches the store', async (t) => {
  for (const author of [A.toUpperCase(), 'ab', 'zz'.repeat(32), null, undefined, 42]) {
    const { loadKept, store, fetched, args } = await setup({ author })
    t.is(await loadKept(args), 'blob:fresh-image/jpeg')
    t.is(fetched.n, 1)
    t.is(store.calls.keptUrl, 0)
    t.is(store.calls.keep, 0)
  }
})

test('bytes that fail validate are refused and not kept', async (t) => {
  const { loadKept, store, args } = await setup({ kind: 'avatars', validate: () => false })
  await t.exception(loadKept(args), /foto inválida/)
  t.is(store.calls.keep, 0)
  t.is(store.files.size, 0)
})

test('bytes that pass validate are kept', async (t) => {
  const seen = []
  const { loadKept, store, args } = await setup({ kind: 'avatars', validate: (b, d) => { seen.push([b, d]); return true } })
  t.ok((await loadKept(args)).startsWith('file:///kept/avatars/'))
  t.is(seen.length, 1)
  t.is(seen[0][0], BYTES)
  t.is(store.calls.keep, 1)
})

test('fetch errors pass through and nothing is kept', async (t) => {
  const { loadKept, store, args } = await setup({ fetchBytes: async () => { throw new Error('não encontrada') } })
  await t.exception(loadKept(args), /não encontrada/)
  t.is(store.calls.keep, 0)
})

test('registerKeptStore wires the registry and revokeMedia, once', async (t) => {
  const { registerKeptStore } = await loadKeptMod()
  const caches = await loadCaches()
  const { onRevokedRanges, revokeMedia } = await loadCache()
  const store = fakeStore()
  const deps = { onRevokedRanges, bumpCacheGeneration: caches.bumpCacheGeneration, registerLocalCache: caches.registerLocalCache, store }
  t.is(registerKeptStore(deps), true)
  t.is(registerKeptStore(deps), false, 'second call is a no-op')
  t.is(registerKeptStore({ ...deps, store: fakeStore() }), false)

  const g = caches.cacheGeneration()
  revokeMedia([{ core: CORE, start: 0, blocks: 2 }])
  t.is(store.calls.dropKeptRanges.length, 1)
  t.alike(store.calls.dropKeptRanges[0], [{ core: CORE, start: 0, blocks: 2 }])
  t.ok(caches.cacheGeneration() > g, 'a revoke bumps the generation')

  caches.wipeLocalCaches()
  t.is(store.calls.wipeKept, 1)
  caches.dropAuthors([A])
  t.alike(store.calls.dropKeptAuthors, [[A]])
  caches.keepOnlyAuthors(new Set([A]))
  t.alike(store.calls.keepOnlyKeptAuthors, [[A]])
})

// The purges below go through the real registry and revokeMedia; the
// registration from the test above is already in place for the revoke.
async function race (t, purge) {
  const { loadKept, store, args } = await setup()
  const gate = deferred()
  const pending = loadKept({ ...args, fetchBytes: () => gate.promise })
  await purge()
  gate.resolve(BYTES)
  t.is(await pending, 'blob:fresh-image/jpeg', 'shown from memory')
  t.is(store.calls.keep, 0, 'not kept')
  t.is(store.files.size, 0)
}

test('a wipe during the fetch prevents the keep', async (t) => {
  const caches = await loadCaches()
  await race(t, () => caches.wipeLocalCaches())
})

test('an author drop during the fetch prevents the keep', async (t) => {
  const caches = await loadCaches()
  await race(t, () => caches.dropAuthors([A]))
})

test('a range revoke during the fetch prevents the keep', async (t) => {
  const { revokeMedia } = await loadCache()
  await race(t, () => revokeMedia([{ core: CORE, start: 1, blocks: 1 }]))
})

test('a keepOnlyAuthors during the fetch prevents the keep', async (t) => {
  const caches = await loadCaches()
  await race(t, () => caches.keepOnlyAuthors(new Set()))
})

test('a purge clears the in-memory URL cache so the next request loads again', async (t) => {
  const { registerKeptStore } = await loadKeptMod()
  const caches = await loadCaches()
  const { createMediaCache, onRevokedRanges } = await loadCache()
  const released = []
  const cache = createMediaCache({ max: 8, concurrency: 2, revoke: (url) => released.push(url) })
  registerKeptStore({ onRevokedRanges, bumpCacheGeneration: caches.bumpCacheGeneration, registerLocalCache: caches.registerLocalCache, store: fakeStore(), cache })
  const purges = [
    () => caches.wipeLocalCaches(),
    () => caches.dropAuthors([A]),
    () => caches.keepOnlyAuthors(new Set())
  ]
  for (const purge of purges) {
    let loads = 0
    const load = async () => { loads++; return 'file:///kept/posts/x' + loads }
    t.is(await cache.get('k', load), 'file:///kept/posts/x1')
    t.is(await cache.get('k', load), 'file:///kept/posts/x1', 'served from memory')
    purge()
    t.is(cache.peek('k'), null, 'the entry is gone')
    t.is(await cache.get('k', load), 'file:///kept/posts/x2', 'loaded again')
    t.is(loads, 2)
    cache.clear()
  }
  t.ok(released.includes('file:///kept/posts/x1'), 'cleared URLs go through revoke')
})

test('a load queued behind the limit before a wipe does not keep after it', async (t) => {
  const { loadKept } = await loadKeptMod()
  const caches = await loadCaches()
  const { createMediaCache } = await loadCache()
  const cache = createMediaCache({ max: 8, concurrency: 1 })
  const store = fakeStore()
  const gate = deferred()
  const first = cache.get('busy', () => gate.promise)
  t.is(cache.waiting, 0)
  const requestedGeneration = caches.cacheGeneration()
  const queued = cache.get('k', () => loadKept({
    kind: 'posts',
    author: A,
    d: desc(),
    persist: true,
    keptUrl: store.keptUrl,
    keep: store.keep,
    fetchBytes: async () => BYTES,
    urlFromBytes: (bytes, mime) => 'blob:fresh-' + mime,
    generation: caches.cacheGeneration,
    requestedGeneration
  }))
  t.is(cache.waiting, 1, 'the second load waits')
  caches.wipeLocalCaches()
  gate.resolve('blob:busy')
  await first
  t.is(await queued, 'blob:fresh-image/jpeg', 'shown from memory')
  t.is(store.calls.keep, 0, 'not kept')
  t.is(store.files.size, 0)
})
