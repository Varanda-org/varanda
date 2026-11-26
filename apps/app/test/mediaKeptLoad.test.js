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

// Every retainKept call of any fake store: the registered one is made by an
// earlier test.
const retained = []

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
    wipeKept () { calls.wipeKept++; files.clear() },
    retainKept (kinds, entries) { retained.push([kinds, entries]); files.clear() }
  }
}

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

async function setup (over = {}) {
  const { loadKept } = await loadKeptMod()
  const { cacheGeneration, setAllowedAuthors } = await loadCaches()
  setAllowedAuthors(null)
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

// Kept-only mode (src/ui/MediaView.js KeptOnlyContext, A Rua's cold-start
// preview): MediaView and Avatar load react-native, so their text is checked.
test('kept-only mode reads keptUrl and never reaches the loader or the fetch', (t) => {
  const fs = require('fs')
  const path = require('path')
  const strip = (src) => src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
  const media = strip(fs.readFileSync(path.join(__dirname, '../src/ui/MediaView.js'), 'utf8'))
  const avatar = strip(fs.readFileSync(path.join(__dirname, '../src/ui/Avatar.js'), 'utf8'))
  t.ok(media.includes('export const KeptOnlyContext = createContext(false)'), 'off by default')
  const helper = media.slice(media.indexOf('export function keptOnlyUrl'), media.indexOf('function useMedia'))
  t.ok(helper.includes('keptStore.keptUrl(kind, author, d)'))
  t.absent(/fetch|loadKept|cache\./.test(helper), 'the helper only reads the kept store')
  t.ok(media.includes('const canFetch = !keptOnly && hosted === true'), 'no fetch, no cache peek in kept-only mode')
  t.ok(media.includes('const hosted = useHosted()'), 'only the hosted flag, not the node value')
  t.ok(media.includes("keptOnlyUrl('posts', author, descriptor, persist)"))
  t.ok(media.includes("if (keptOnly) return kept !== null ? { state: 'ok', url: kept, retry: undefined } : { state: 'loading', url: null, retry: undefined }"), 'a miss is the loading tile')
  t.ok(avatar.includes('const canFetch = !keptOnly && hosted === true'), 'the avatar key stays null, so its loader never runs')
  t.ok(avatar.includes('const hosted = useHosted()'), 'only the hosted flag, not the node value')
  t.ok(avatar.includes("keptOnlyUrl('avatars', publicKey, picture, persist)"))
  t.ok(avatar.includes('if (keptOnly) return { url: kept, key: keptKey, reload: null }'), 'a miss is the initials, and an error never reloads')
})

test('an author outside the known allowed set is shown but not kept', async (t) => {
  const caches = await loadCaches()
  t.teardown(() => caches.setAllowedAuthors(null))
  caches.wipeLocalCaches()
  const { loadKept, store, fetched, args } = await setup()
  caches.setAllowedAuthors(new Set(['b2'.repeat(32)]))
  t.is(await loadKept(args), 'blob:fresh-image/jpeg', 'still shown')
  t.is(fetched.n, 1)
  t.is(store.calls.keep, 0, 'not kept')
  caches.setAllowedAuthors(new Set([A]))
  t.is(await loadKept(args), 'file:///kept/posts/' + A + '-' + CORE + '-1', 'inside the set: kept')
  t.is(store.calls.keep, 1)
  store.files.clear()
  caches.setAllowedAuthors(null)
  t.is(await loadKept(args), 'file:///kept/posts/' + A + '-' + CORE + '-1', 'no set known: kept')
  t.is(store.calls.keep, 2)
})

test('an evicted or cleared URL releases the kept file through the caller\'s store', async (t) => {
  const { registerKeptStore } = await loadKeptMod()
  const caches = await loadCaches()
  const { createMediaCache, onRevokedRanges } = await loadCache()
  const released = []
  const store = { ...fakeStore(), releaseKept: (url) => released.push(url) }
  const cache = createMediaCache({ max: 1, revoke: () => {} })
  const deps = { onRevokedRanges, bumpCacheGeneration: caches.bumpCacheGeneration, registerLocalCache: caches.registerLocalCache, store, cache }
  registerKeptStore(deps)
  registerKeptStore(deps)
  await cache.get('a', async () => 'file:///kept/posts/a')
  await cache.get('b', async () => 'file:///kept/posts/b')
  t.alike(released, ['file:///kept/posts/a'], 'LRU eviction releases once')
  caches.wipeLocalCaches()
  t.alike(released, ['file:///kept/posts/a', 'file:///kept/posts/b'], 'a purge clears and releases')
  const plain = createMediaCache({ max: 1, revoke: () => {} })
  registerKeptStore({ ...deps, store: fakeStore(), cache: plain })
  await plain.get('c', async () => 'file:///kept/posts/c')
  await plain.get('d', async () => 'file:///kept/posts/d')
  t.is(released.length, 2, 'a store without releaseKept is not called')
})

// Avatar persist means 'keep on disk': only the own key or a followed one.
test('source: avatar call sites persist only own or followed keys', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  const pessoas = read('screens/Pessoas.js')
  t.ok(pessoas.includes("picture={pickAvatar(profile, row)} persist={typeof own === 'string' && row.key === own} />"), 'Pessoas: the own row only')
  t.ok(pessoas.includes('<OwnRow row={item} own={own} profile={profile} onOpen={onOpenMember} />'))
  t.ok(read('screens/PaginaAjustes.js').includes('publicKey={personKey} size={40} picture={(profile || {}).avatar} persist={false} />'), 'PaginaAjustes: roster never kept')
  t.ok(read('screens/Paginas.js').includes('publicKey={pageKey} size={44} picture={(profile || {}).avatar} persist={false} />'), 'Paginas: pages never kept')
  for (const file of ['screens/Pessoas.js', 'screens/PaginaAjustes.js', 'screens/Paginas.js']) {
    t.absent(/<Avatar[^>]*\spersist\s*\/>/.test(read(file)), file + ': no bare persist')
  }
  const strip = read('ui/MomentosStrip.js')
  t.ok(strip.includes('liveAuthors(data.authors, now)') && strip.includes('publicKey={ownKey}'), 'MomentosStrip: moments.read authors and the own key')
  t.ok(read('screens/Momentos.js').includes('viewerRings({ authors: data.authors, own: data.own, ownKey: own'), 'Momentos: moments.read authors and the own key')
})

test('a dropped author is shown but not kept, even when the allowed set lists them', async (t) => {
  const caches = await loadCaches()
  t.teardown(() => caches.wipeLocalCaches())
  caches.wipeLocalCaches()
  const { loadKept, store, args } = await setup()
  caches.dropAuthors([A])
  caches.keepOnlyAuthors(new Set([A]))
  t.is(await loadKept(args), 'blob:fresh-image/jpeg', 'shown')
  t.is(store.calls.keep, 0, 'not kept again')
})

test('storeKindOf sends peek photos to their own kinds', async (t) => {
  const { storeKindOf } = await loadKeptMod()
  t.is(storeKindOf('posts', 'peek'), 'peekPosts')
  t.is(storeKindOf('avatars', 'peek'), 'peekAvatars')
  t.is(storeKindOf('posts', true), 'posts')
  t.is(storeKindOf('avatars', true), 'avatars')
  t.is(storeKindOf('posts', false), 'posts')
})

const STRANGER = 'b2'.repeat(32)

async function peekSetup (over = {}) {
  const lc = await loadCaches()
  lc.wipeLocalCaches()
  const s = await setup({ author: STRANGER, persist: 'peek', ...over })
  lc.setAllowedAuthors([A])
  return { ...s, lc }
}

test('a peek photo is kept in the peek kind only once block.list answered', async (t) => {
  const { loadKept, store, fetched, args, lc } = await peekSetup()
  t.teardown(() => lc.wipeLocalCaches())
  t.is(await loadKept(args), 'blob:fresh-image/jpeg', 'blocks unknown: shown, not kept')
  t.is(store.calls.keep, 0)
  t.is(fetched.n, 1)
  lc.noteBlocksKnown(lc.wipeEpoch())
  const uri = await loadKept(args)
  t.is(uri, 'file:///kept/peekPosts/' + STRANGER + '-' + CORE + '-1', 'kept under peekPosts')
  t.is(await loadKept(args), uri, 'read back from the peek kind')
  t.is(fetched.n, 2, 'the hit needs no fetch')
  t.is(await loadKept({ ...args, kind: 'avatars', persist: true }), 'blob:fresh-image/jpeg', 'persist true for a stranger outside the allowed set is not kept')
  t.absent(store.files.has('posts/' + STRANGER + '-' + CORE + '-1'), 'nothing in the main kinds')
})

test('a peek photo of a followed or blocked author is never kept', async (t) => {
  const { loadKept, store, args, lc } = await peekSetup()
  t.teardown(() => lc.wipeLocalCaches())
  lc.noteBlocksKnown(lc.wipeEpoch())
  t.is(await loadKept({ ...args, author: A }), 'blob:fresh-image/jpeg', 'followed: main kinds only')
  lc.dropAuthors([STRANGER])
  t.is(await loadKept(args), 'blob:fresh-image/jpeg', 'blocked: not kept')
  t.is(store.calls.keep, 0)
})

test('a blocked author\'s peek copy is not read back', async (t) => {
  const { loadKept, store, fetched, args, lc } = await peekSetup()
  t.teardown(() => lc.wipeLocalCaches())
  store.files.set('peekPosts/' + STRANGER + '-' + CORE + '-1', 'file:///kept/old')
  t.is(await loadKept(args), 'blob:fresh-image/jpeg', 'blocks unknown: the copy is not read')
  t.is(store.calls.keptUrl, 0)
  t.is(fetched.n, 1)
})

test('a purge during a peek fetch prevents the keep', async (t) => {
  const gate = deferred()
  const { loadKept, store, args, lc } = await peekSetup({ fetchBytes: () => gate.promise })
  t.teardown(() => lc.wipeLocalCaches())
  lc.noteBlocksKnown(lc.wipeEpoch())
  const pending = loadKept(args)
  await new Promise((resolve) => setImmediate(resolve))
  lc.dropAuthors(['d4'.repeat(32)])
  gate.resolve(BYTES)
  t.is(await pending, 'blob:fresh-image/jpeg')
  t.is(store.calls.keep, 0)
})

test('keptBytes: a hit of the right size makes no fetch; a wrong size or failure falls through', async (t) => {
  const urls = []
  const reads = []
  const answer = { value: new Uint8Array([9, 9, 9, 9]) }
  const { loadKept, fetched, args } = await setup({
    keptBytes: async (kind, author, d) => { reads.push(kind); return answer.value },
    urlFromBytes: (bytes, mime) => { urls.push([...bytes]); return 'blob:held-' + mime }
  })
  t.is(await loadKept(args), 'blob:held-image/jpeg')
  t.is(fetched.n, 0, 'no fetch')
  t.alike(urls, [[9, 9, 9, 9]])
  t.alike(reads, ['posts'])
  answer.value = new Uint8Array([9, 9, 9])
  t.is(await loadKept(args), 'file:///kept/posts/' + A + '-' + CORE + '-1', 'wrong size: fetched and kept')
  t.is(fetched.n, 1)
  const failing = await setup({ keptBytes: async () => { throw new Error('idb') } })
  t.is(await failing.loadKept(failing.args), 'file:///kept/posts/' + A + '-' + CORE + '-1', 'a failed read falls through to the fetch')
  t.is(failing.fetched.n, 1)
  const invalid = await setup({ keptBytes: async () => new Uint8Array(4), validate: (bytes) => bytes[0] !== 0 })
  await invalid.loadKept(invalid.args)
  t.is(invalid.fetched.n, 1, 'held bytes that fail validate fall through')
  const off = await setup({ persist: false, keptBytes: async () => { throw new Error('must not read') } })
  t.is(await off.loadKept(off.args), 'blob:fresh-image/jpeg', 'persist false reads nothing')
})

test('keptBytes: a purge during the read discards its bytes', async (t) => {
  const lc = await loadCaches()
  const gate = deferred()
  const { loadKept, fetched, args } = await setup({ keptBytes: () => gate.promise })
  t.teardown(() => lc.wipeLocalCaches())
  const pending = loadKept(args)
  await new Promise((resolve) => setImmediate(resolve))
  lc.bumpCacheGeneration()
  gate.resolve(new Uint8Array(4))
  await pending
  t.is(fetched.n, 1, 'fetched instead')
})

test('retainKept goes through the registered store and leaves the generation and memory alone', async (t) => {
  const { registerKeptStore, retainKept } = await loadKeptMod()
  const caches = await loadCaches()
  const { createMediaCache, onRevokedRanges } = await loadCache()
  const cache = createMediaCache({ max: 8, revoke: () => {} })
  registerKeptStore({ onRevokedRanges, bumpCacheGeneration: caches.bumpCacheGeneration, registerLocalCache: caches.registerLocalCache, store: fakeStore(), cache })
  t.is(await cache.get('k', async () => 'file:///kept/posts/x'), 'file:///kept/posts/x')
  const g = caches.cacheGeneration()
  const before = retained.length
  const entries = [{ kind: 'peekPosts', author: A, d: desc() }]
  retainKept(['peekPosts', 'peekAvatars'], entries)
  t.is(retained.length, before + 1, 'the store retains')
  t.alike(retained[retained.length - 1], [['peekPosts', 'peekAvatars'], entries])
  t.is(caches.cacheGeneration(), g, 'the global generation stays, so other screens\' saves in flight still land')
  t.is(cache.peek('k'), 'file:///kept/posts/x', 'the in-memory cache keeps its entries')
})

test('a retain during a peek fetch prevents the keep', async (t) => {
  const { retainKept } = await loadKeptMod()
  const gate = deferred()
  const { loadKept, store, args, lc } = await peekSetup({ fetchBytes: () => gate.promise })
  t.teardown(() => lc.wipeLocalCaches())
  lc.noteBlocksKnown(lc.wipeEpoch())
  const pending = loadKept(args)
  await new Promise((resolve) => setImmediate(resolve))
  retainKept(['peekPosts', 'peekAvatars'], [])
  gate.resolve(BYTES)
  t.is(await pending, 'blob:fresh-image/jpeg', 'shown from memory')
  t.is(store.calls.keep, 0, 'not kept')
})

test('a main-kind keep in flight survives a retain', async (t) => {
  const { retainKept } = await loadKeptMod()
  const gate = deferred()
  const { loadKept, store, args } = await setup({ fetchBytes: () => gate.promise })
  const pending = loadKept(args)
  await new Promise((resolve) => setImmediate(resolve))
  retainKept(['peekPosts', 'peekAvatars'], [])
  gate.resolve(BYTES)
  t.is(await pending, 'file:///kept/posts/' + A + '-' + CORE + '-1', 'kept as before')
  t.is(store.calls.keep, 1)
})

test('a peek fetch that overlapped a retain still keeps an entry the retain named', async (t) => {
  const { retainKept } = await loadKeptMod()
  const gate = deferred()
  const { loadKept, store, args, lc } = await peekSetup({ fetchBytes: () => gate.promise })
  t.teardown(() => lc.wipeLocalCaches())
  lc.noteBlocksKnown(lc.wipeEpoch())
  const pending = loadKept(args)
  await new Promise((resolve) => setImmediate(resolve))
  retainKept(['peekPosts', 'peekAvatars'], [{ kind: 'peekPosts', author: STRANGER, d: desc() }])
  gate.resolve(BYTES)
  t.is(await pending, 'file:///kept/peekPosts/' + STRANGER + '-' + CORE + '-1', 'kept: the saved page names it')
  t.is(store.calls.keep, 1)
})

test('a retain forgets only the memory entries of the peek files it deleted', async (t) => {
  const { registerKeptStore, retainKept } = await loadKeptMod()
  const caches = await loadCaches()
  const { createMediaCache, onRevokedRanges } = await loadCache()
  const cache = createMediaCache({ max: 8, revoke: () => {} })
  registerKeptStore({ onRevokedRanges, bumpCacheGeneration: caches.bumpCacheGeneration, registerLocalCache: caches.registerLocalCache, store: fakeStore(), cache })
  const { loadKept, args, lc } = await peekSetup()
  t.teardown(() => lc.wipeLocalCaches())
  lc.noteBlocksKnown(lc.wipeEpoch())
  const gone = desc({ start: 1 })
  const stays = desc({ start: 2 })
  const u1 = await cache.get('gone', () => loadKept({ ...args, d: gone }))
  const u2 = await cache.get('stays', () => loadKept({ ...args, d: stays }))
  t.ok(u1.startsWith('file:///kept/peekPosts/') && u2.startsWith('file:///kept/peekPosts/'))
  t.is(await cache.get('main', async () => 'file:///kept/posts/m'), 'file:///kept/posts/m')
  retainKept(['peekPosts', 'peekAvatars'], [{ kind: 'peekPosts', author: STRANGER, d: stays }])
  t.is(cache.peek('gone'), null, 'the deleted file\'s entry is forgotten, so it loads again')
  t.is(cache.peek('stays'), u2, 'a retained entry stays')
  t.is(cache.peek('main'), 'file:///kept/posts/m', 'other entries stay')
})
