'use strict'

// src/media/keep.web.js: the main, peek and copy kinds go to the three
// stores of src/media/peekPhotos.web.js. Each store's
// IndexedDB backend is replaced by an in-memory one (its exported methods are
// swapped), so the real stores, registry (src/localCaches.js), keptLoad and
// revokeMedia run end to end.
const test = require('brittle')

const A = 'a1'.repeat(32)
const B = 'b2'.repeat(32)
const ME = 'c4'.repeat(32)
const CORE = 'c3'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ASSOC = 'f6'.repeat(32)
const BIND = { origin: ORIGIN, association: ASSOC, owner: ME }
const desc = (over = {}) => ({ core: CORE, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 4, sha256: 'e5'.repeat(32), width: 10, height: 20, ...over })
const bytesOf = (n, fill = 7) => new Uint8Array(n).fill(fill)

const loadWeb = () => import('../src/media/keep.web.js')
const loadPeek = () => import('../src/media/peekPhotos.web.js')

let db = null
let copyDb = null
let keptDb = null
function swapIn (backend) {
  const db = { binding: null, meta: new Map(), bytes: new Map(), puts: 0 }
  const same = (a, b) => a !== null && b !== null && a.origin === b.origin && a.association === b.association && a.owner === b.owner
  Object.assign(backend, {
    async getBinding () { return db.binding },
    async setBinding (b) { db.binding = { ...b }; return true },
    async list () { return [...db.meta.values()].map((r) => ({ ...r })) },
    async get (name) { const b = db.bytes.get(name); return b ? b.slice() : null },
    async put (row, bytes, binding) {
      if (!same(db.binding, binding || null)) return false
      db.puts++
      db.meta.set(row.name, { ...row })
      db.bytes.set(row.name, bytes.slice())
      return true
    },
    async remove (names) {
      for (const n of names) { db.meta.delete(n); db.bytes.delete(n) }
      return true
    },
    async clear () {
      db.binding = null
      db.meta.clear()
      db.bytes.clear()
      return true
    }
  })
  return db
}

async function memoryBackend () {
  if (db !== null) return db
  const { backend, copyBackend, keptBackend } = await loadPeek()
  db = swapIn(backend)
  copyDb = swapIn(copyBackend)
  keptDb = swapIn(keptBackend)
  return db
}

// Every store call runs in one queue: a read resolves after all before it.
async function settle () {
  const { peekPhotos, copyPhotos, keptPhotos } = await loadPeek()
  await peekPhotos.read('peekPosts', A, desc({ start: 99 }))
  await copyPhotos.read('copyPosts', A, desc({ start: 99 }))
  await keptPhotos.read('posts', A, desc({ start: 99 }))
}

async function fresh () {
  const d = await memoryBackend()
  const { peekPhotos, copyPhotos, keptPhotos } = await loadPeek()
  await peekPhotos.wipe()
  await copyPhotos.wipe()
  await keptPhotos.wipe()
  return d
}

const names = () => [...db.meta.keys()].sort()
const copyNames = () => [...copyDb.meta.keys()].sort()
const keptNames = () => [...keptDb.meta.keys()].sort()

test('each export delegates to the main, peek or copy store', async (t) => {
  const web = await loadWeb()
  const { peekPhotos, copyPhotos, keptPhotos } = await loadPeek()
  const calls = []
  const promises = {}
  const METHODS = ['bind', 'read', 'put', 'readThumb', 'putThumb', 'dropAuthors', 'dropRanges', 'retain', 'retainThumbs', 'wipe']
  for (const [label, store] of [['kept', keptPhotos], ['peek', peekPhotos], ['copy', copyPhotos]]) {
    const saved = { ...store }
    t.teardown(() => Object.assign(store, saved))
    for (const m of METHODS) {
      promises[label + '.' + m] = Promise.resolve(true)
      store[m] = (...args) => { calls.push([label + '.' + m, ...args]); return promises[label + '.' + m] }
    }
  }

  const d = desc()
  const b = bytesOf(4)
  t.is(web.keptBytes('posts', A, d), promises['kept.read'])
  t.is(web.keptBytes('avatars', A, d), promises['kept.read'])
  t.is(web.keptBytes('peekPosts', A, d), promises['peek.read'])
  t.is(web.keptBytes('peekAvatars', A, d), promises['peek.read'])
  t.is(web.keptBytes('copyPosts', A, d), promises['copy.read'])
  t.is(web.keptBytes('copyAvatars', A, d), promises['copy.read'])
  t.is(web.keptBytes('copyGroupThumbs', A, d), null, 'a group picture is read through keptGroupThumb only')
  t.is(web.keep('posts', A, d, b), null, 'keep hands out no URL')
  t.is(web.keep('avatars', A, d, b, { replace: true }), null)
  t.is(web.keep('peekPosts', A, d, b), null)
  t.is(web.keep('copyAvatars', A, d, b), null)
  t.is(web.keep('copyGroupThumbs', A, d, b), null)
  t.is(await web.wipeKept(), true)
  t.is(await web.dropKeptAuthors([A]), true)
  const ranges = [{ core: CORE, start: 0, blocks: 2 }]
  t.is(await web.dropKeptRanges(ranges), true)
  const entries = [{ kind: 'peekPosts', author: A, d }]
  t.is(web.retainKept(['posts', 'peekPosts', 'copyPosts', 'avatars', 'peekAvatars', 'copyAvatars', 'copyGroupThumbs'], entries), promises['peek.retain'])
  t.is(web.retainKept(['copyPosts', 'copyAvatars', 'copyGroupThumbs'], []), null, 'no peek kind: nothing retained')
  t.is(await web.bindPeek(BIND), true)
  t.is(await web.bindPeek(null), true)
  t.is(await web.bindPeek(), true)
  const SHA = 'e5'.repeat(32)
  t.is(web.keptGroupThumb(A, SHA), promises['copy.readThumb'])
  t.is(web.keepGroupThumb(A, SHA, b, 'image/jpeg'), null)
  const pairs = [{ author: A, sha: SHA }]
  t.is(web.retainGroupThumbs(pairs), promises['copy.retainThumbs'])

  t.alike(calls, [
    ['kept.read', 'posts', A, d],
    ['kept.read', 'avatars', A, d],
    ['peek.read', 'peekPosts', A, d],
    ['peek.read', 'peekAvatars', A, d],
    ['copy.read', 'copyPosts', A, d],
    ['copy.read', 'copyAvatars', A, d],
    ['kept.put', 'posts', A, d, b],
    ['kept.put', 'avatars', A, d, b],
    ['peek.put', 'peekPosts', A, d, b],
    ['copy.put', 'copyAvatars', A, d, b],
    ['kept.wipe'],
    ['peek.wipe'],
    ['copy.wipe'],
    ['kept.dropAuthors', [A]],
    ['peek.dropAuthors', [A]],
    ['copy.dropAuthors', [A]],
    ['kept.dropRanges', ranges],
    ['peek.dropRanges', ranges],
    ['copy.dropRanges', ranges],
    ['peek.retain', ['peekPosts', 'peekAvatars'], entries],
    ['kept.bind', BIND],
    ['peek.bind', BIND],
    ['copy.bind', BIND],
    ['kept.bind', null],
    ['peek.bind', null],
    ['copy.bind', null],
    ['kept.bind', null],
    ['peek.bind', null],
    ['copy.bind', null],
    ['copy.readThumb', A, SHA],
    ['copy.putThumb', A, SHA, b, 'image/jpeg'],
    ['copy.retainThumbs', pairs]
  ])
})

test('a purge or bind answers false when any store fails, and never rejects', async (t) => {
  const web = await loadWeb()
  const { peekPhotos, copyPhotos, keptPhotos } = await loadPeek()
  const saved = [{ ...peekPhotos }, { ...copyPhotos }, { ...keptPhotos }]
  t.teardown(() => { Object.assign(peekPhotos, saved[0]); Object.assign(copyPhotos, saved[1]); Object.assign(keptPhotos, saved[2]) })
  for (const m of ['bind', 'wipe', 'dropAuthors', 'dropRanges']) {
    keptPhotos[m] = async () => true
    peekPhotos[m] = async () => true
    copyPhotos[m] = async () => false
  }
  t.is(await web.wipeKept(), false)
  t.is(await web.bindPeek(BIND), false)
  t.is(await web.dropKeptAuthors([A]), false)
  copyPhotos.dropRanges = () => Promise.reject(new Error('boom'))
  t.is(await web.dropKeptRanges([{ core: CORE, start: 0, blocks: 2 }]), false)
  for (const m of ['bind', 'wipe', 'dropAuthors', 'dropRanges']) {
    keptPhotos[m] = async () => false
    copyPhotos[m] = async () => true
  }
  t.is(await web.wipeKept(), false, 'the main store failing fails the wipe')
  t.is(await web.bindPeek(BIND), false)
  t.is(await web.dropKeptAuthors([A]), false)
  t.is(await web.dropKeptRanges([{ core: CORE, start: 0, blocks: 2 }]), false)
  keptPhotos.dropAuthors = () => Promise.reject(new Error('boom'))
  t.is(await web.keepOnlyKeptAuthors(new Set([A])), false, 'a failed keep-only resolves false')
})

test('unknown kinds stay inert; keptUrl is always null and synchronous', async (t) => {
  const web = await loadWeb()
  const { peekPhotos, copyPhotos, keptPhotos } = await loadPeek()
  const calls = []
  const saved = [{ ...peekPhotos }, { ...copyPhotos }, { ...keptPhotos }]
  for (const store of [peekPhotos, copyPhotos, keptPhotos]) {
    for (const m of ['read', 'put', 'retain', 'retainThumbs', 'dropAuthors']) store[m] = (...args) => { calls.push(m); return Promise.resolve(null) }
  }
  t.teardown(() => { Object.assign(peekPhotos, saved[0]); Object.assign(copyPhotos, saved[1]); Object.assign(keptPhotos, saved[2]) })

  for (const kind of ['other', 'copyGroupThumbs', undefined]) {
    t.is(web.keep(kind, A, desc(), bytesOf(4)), null)
    t.is(web.keptBytes(kind, A, desc()), null)
  }
  for (const kind of ['posts', 'avatars', 'peekPosts', 'peekAvatars', 'copyPosts', 'copyAvatars']) t.is(web.keptUrl(kind, A, desc()), null)
  t.is(web.retainKept(['posts', 'avatars'], []), null)
  t.is(web.retainKept(null, []), null)
  t.is(web.retainKept(undefined, []), null)
  for (const fn of ['releaseKept', 'trimKept']) t.is(web[fn](new Set([A])), null)
  for (const allowed of [null, undefined, 'a1', 7]) t.is(web.keepOnlyKeptAuthors(allowed), null, 'not a list of keys: no keep-only')
  t.alike(calls, [], 'the store was never called')
  t.is(web.httpCacheKeeps, false)
})

test('a rejected put never surfaces from keep', async (t) => {
  const web = await loadWeb()
  const { peekPhotos } = await loadPeek()
  const saved = peekPhotos.put
  let unhandled = false
  const onUnhandled = () => { unhandled = true }
  process.on('unhandledRejection', onUnhandled)
  peekPhotos.put = () => Promise.reject(new Error('boom'))
  t.teardown(() => { peekPhotos.put = saved; process.off('unhandledRejection', onUnhandled) })
  t.is(web.keep('peekPosts', A, desc(), bytesOf(4)), null)
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.absent(unhandled)
})

test('real store: bound keep, read back, unbind and rebind to another owner', async (t) => {
  await fresh()
  const web = await loadWeb()
  t.is(await web.bindPeek(BIND), true)
  web.keep('peekPosts', A, desc(), bytesOf(4))
  await settle()
  t.is(db.meta.size, 1)
  t.alike(await web.keptBytes('peekPosts', A, desc()), bytesOf(4))
  t.is(await web.keptBytes('peekAvatars', A, desc()), null, 'a peek post never answers for an avatar')

  await web.bindPeek(null)
  t.is(await web.keptBytes('peekPosts', A, desc()), null, 'unbound (Vitrine, page actor, locked): nothing read')
  web.keep('peekPosts', B, desc(), bytesOf(4))
  await settle()
  t.is(db.meta.size, 1, 'unbound: nothing written')

  t.is(await web.bindPeek({ ...BIND, owner: B }), true)
  t.is(db.meta.size, 0, 'another owner: the store was cleared first')
  t.is(await web.keptBytes('peekPosts', A, desc()), null)
})

test('real store: retainKept keeps only the listed peek photos', async (t) => {
  await fresh()
  const web = await loadWeb()
  const { retainKept } = await import('../src/media/keptLoad.js')
  await web.bindPeek(BIND)
  web.keep('peekPosts', A, desc(), bytesOf(4))
  web.keep('peekPosts', A, desc({ start: 2 }), bytesOf(4))
  web.keep('peekAvatars', B, desc({ start: 3 }), bytesOf(4))
  await settle()
  t.is(db.meta.size, 3)
  await web.retainKept(['peekPosts'], [{ kind: 'peekPosts', author: A, d: desc({ start: 2 }) }])
  t.alike(names(), ['peekAvatars/' + B + '-' + CORE + '-3-1', 'peekPosts/' + A + '-' + CORE + '-2-1'])
  // keptLoad.retainKept does nothing before registerKeptStore (next test).
  retainKept(['peekAvatars'], [])
  await settle()
  t.is(db.meta.size, 2)
})

test('through registerKeptStore and loadKept: block, range revoke, retain and wipe reach the store', async (t) => {
  await fresh()
  const web = await loadWeb()
  const caches = await import('../src/localCaches.js')
  const { onRevokedRanges, revokeMedia } = await import('../src/media/cache.js')
  const { registerKeptStore, loadKept, retainKept } = await import('../src/media/keptLoad.js')
  const cleared = []
  t.is(registerKeptStore({
    onRevokedRanges,
    bumpCacheGeneration: caches.bumpCacheGeneration,
    registerLocalCache: caches.registerLocalCache,
    store: web,
    cache: { clear () { cleared.push(1) } }
  }), true)

  const ready = async () => {
    caches.keepOnlyAuthors(new Set([ME]))
    caches.noteBlocksKnown(caches.wipeEpoch())
    t.is(await web.bindPeek(BIND), true)
  }
  let fetches = 0
  const load = (author, d, bytes = bytesOf(4)) => loadKept({
    kind: 'posts',
    author,
    d,
    persist: 'peek',
    keptUrl: web.keptUrl,
    keptBytes: web.keptBytes,
    keep: web.keep,
    fetchBytes: async () => { fetches++; return bytes },
    urlFromBytes: (b, mime) => 'blob:' + b.join(',') + ':' + mime,
    generation: caches.cacheGeneration
  })

  await ready()
  t.is(cleared.length, 0, 'a keep-only leaves the in-memory URLs (no file URI to forget)')
  t.is(await load(A, desc()), 'blob:7,7,7,7:image/jpeg', 'a miss is fetched')
  t.is(fetches, 1)
  await settle()
  t.alike(names(), ['peekPosts/' + A + '-' + CORE + '-1-1'], 'and stored in the peek kind')
  t.is(await load(A, desc(), bytesOf(4, 9)), 'blob:7,7,7,7:image/jpeg', 'a hit answers from the store')
  t.is(fetches, 1, 'with no fetch')

  await load(B, desc({ start: 2 }))
  await load(B, desc({ start: 5 }))
  await settle()
  t.is(db.meta.size, 3)

  caches.dropAuthors([B])
  await settle()
  t.alike(names(), ['peekPosts/' + A + '-' + CORE + '-1-1'], 'a block drops the author')
  t.ok(cleared.length > 0, 'and clears the in-memory URLs')

  revokeMedia([{ core: CORE, start: 1, blocks: 1 }])
  await settle()
  t.is(db.meta.size, 0, 'a range revoke drops the overlapping photo')

  await load(A, desc({ start: 3 }))
  await load(A, desc({ start: 4 }))
  await settle()
  retainKept(['peekPosts'], [{ kind: 'peekPosts', author: A, d: desc({ start: 4 }) }])
  await settle()
  t.alike(names(), ['peekPosts/' + A + '-' + CORE + '-4-1'], 'keptLoad.retainKept reaches the store')

  caches.wipeLocalCaches()
  await settle()
  t.is(db.meta.size, 0, 'a wipe (lock, Sair, reset, owner change) empties the store')
  t.is(db.binding, null, 'and forgets the binding')
  t.is(await web.keptBytes('peekPosts', A, desc({ start: 4 })), null)
  const before = db.puts
  await load(A, desc({ start: 6 }))
  await settle()
  t.is(db.puts, before, 'after a wipe nothing is written until blocks are known and a new bind succeeds')
})

test('real stores: copy photos live in their own database and survive every retain', async (t) => {
  await fresh()
  const web = await loadWeb()
  t.is(await web.bindPeek(BIND), true)
  t.alike(copyDb.binding, BIND, 'one bind binds the three stores')
  t.alike(keptDb.binding, BIND)
  web.keep('peekPosts', A, desc(), bytesOf(4))
  web.keep('copyPosts', A, desc({ start: 2 }), bytesOf(4))
  web.keep('copyAvatars', B, desc({ start: 3 }), bytesOf(4))
  const SHA = 'e5'.repeat(32)
  web.keepGroupThumb(B, SHA, bytesOf(9), 'image/jpeg')
  await settle()
  t.alike(names(), ['peekPosts/' + A + '-' + CORE + '-1-1'], 'the peek database holds only the peek photo')
  t.alike(copyNames(), ['copyAvatars/' + B + '-' + CORE + '-3-1', 'copyGroupThumbs/' + B + '-' + SHA, 'copyPosts/' + A + '-' + CORE + '-2-1'], 'the copy database holds the copy kinds')
  t.alike(await web.keptBytes('copyPosts', A, desc({ start: 2 })), bytesOf(4))
  t.is(await web.keptBytes('peekPosts', A, desc({ start: 2 })), null, 'a copy photo never answers for a peek entry')
  t.is(await web.keptBytes('copyPosts', A, desc()), null, 'nor a peek photo for a copy entry')
  t.alike(await web.keptGroupThumb(B, SHA), bytesOf(9))

  await web.retainKept(['peekAvatars', 'peekPosts'], [])
  await web.retainKept(['copyPosts', 'copyAvatars', 'copyGroupThumbs'], [])
  await settle()
  t.alike(names(), [], 'a peek file is still deleted by its retain')
  t.is(copyDb.meta.size, 3, 'no retain reaches the copy database')

  await web.retainGroupThumbs([{ author: B, sha: 'f0'.repeat(32) }])
  t.alike(copyNames(), ['copyAvatars/' + B + '-' + CORE + '-3-1', 'copyPosts/' + A + '-' + CORE + '-2-1'], 'retainGroupThumbs prunes only unlisted group pictures')

  web.keepGroupThumb(B, SHA, bytesOf(9), 'image/jpeg')
  web.keep('peekPosts', A, desc(), bytesOf(4))
  await settle()
  t.is(await web.keepOnlyKeptAuthors(new Set()), true)
  t.is(copyDb.meta.size, 3, 'a follow reconcile leaves copy photos')
  t.is(db.meta.size, 1, 'and peek photos')
  t.is(await web.dropKeptAuthors([B]), true)
  t.alike(copyNames(), ['copyPosts/' + A + '-' + CORE + '-2-1'], 'a block removes the author\'s copy photos and group pictures')
  t.is(await web.dropKeptRanges([{ core: CORE, start: 2, blocks: 1 }]), true)
  t.is(copyDb.meta.size, 0, 'a range revoke reaches the copy database')
  t.is(db.meta.size, 1, 'and leaves the peek photo of another range')

  web.keep('copyPosts', A, desc({ start: 4 }), bytesOf(4))
  await settle()
  t.is(await web.wipeKept(), true)
  t.is(db.meta.size + copyDb.meta.size, 0, 'a wipe empties both databases')
  t.is(copyDb.binding, null, 'and forgets both bindings')
  t.is(db.binding, null)
  t.is(keptDb.binding, null)
})

test('real stores: a queued group picture put lands when a retain called after it names it', async (t) => {
  await fresh()
  const web = await loadWeb()
  t.is(await web.bindPeek(BIND), true)
  const KEEP = 'e5'.repeat(32)
  const LEFT = 'f0'.repeat(32)
  web.keepGroupThumb(B, KEEP, bytesOf(9), 'image/jpeg')
  web.keepGroupThumb(B, LEFT, bytesOf(9), 'image/jpeg')
  t.is(await web.retainGroupThumbs([{ author: B, sha: KEEP }]), true)
  await settle()
  t.alike(copyNames(), ['copyGroupThumbs/' + B + '-' + KEEP], 'the listed pair lands, the other is dropped')
  t.alike(await web.keptGroupThumb(B, KEEP), bytesOf(9))

  await fresh()
  t.is(await web.bindPeek(BIND), true)
  web.keepGroupThumb(B, KEEP, bytesOf(9), 'image/jpeg')
  web.retainGroupThumbs([{ author: B, sha: KEEP }])
  web.dropKeptAuthors([A])
  await settle()
  t.alike(copyNames(), [], 'any other purge after it still cancels the put')
})

test('real stores: followed photos round trip in their own database', async (t) => {
  await fresh()
  const web = await loadWeb()
  t.is(await web.bindPeek(BIND), true)
  web.keep('posts', A, desc(), bytesOf(4))
  web.keep('avatars', B, desc({ start: 2 }), bytesOf(4, 3))
  await settle()
  t.alike(keptNames(), ['avatars/' + B + '-' + CORE + '-2-1', 'posts/' + A + '-' + CORE + '-1-1'], 'the main database holds the main kinds')
  t.is(db.meta.size + copyDb.meta.size, 0, 'and nothing else does')
  t.alike(await web.keptBytes('posts', A, desc()), bytesOf(4))
  t.alike(await web.keptBytes('avatars', B, desc({ start: 2 })), bytesOf(4, 3))
  t.is(await web.keptBytes('avatars', A, desc()), null, 'a post photo never answers for an avatar')
  t.is(await web.keptBytes('peekPosts', A, desc()), null, 'nor for a peek entry')
  t.is(await web.keptBytes('copyPosts', A, desc()), null, 'nor for a copy entry')
  web.keep('avatars', B, desc({ start: 2 }), bytesOf(4, 5), { replace: true })
  await settle()
  t.alike(await web.keptBytes('avatars', B, desc({ start: 2 })), bytesOf(4, 5), 'a replace overwrites the entry')
  t.is(keptDb.meta.size, 2)
  t.is(await web.keptBytes('posts', A, desc({ sha256: 'f0'.repeat(32) })), null, 'another hash is a miss')
  t.is(keptDb.meta.size, 1, 'and the stale entry is deleted')

  await web.bindPeek(null)
  t.is(await web.keptBytes('posts', A, desc()), null, 'unbound: nothing read')
  t.is(await web.bindPeek({ ...BIND, owner: B }), true)
  t.is(keptDb.meta.size, 0, 'another owner: the main store was cleared first')
})

test('real stores: author and range drops and the wipe reach the main store; keep-only prunes it alone', async (t) => {
  await fresh()
  const web = await loadWeb()
  t.is(await web.bindPeek(BIND), true)
  web.keep('posts', A, desc(), bytesOf(4))
  web.keep('posts', B, desc({ start: 2 }), bytesOf(4))
  web.keep('avatars', ME, desc({ start: 3 }), bytesOf(4))
  web.keep('peekPosts', B, desc({ start: 5 }), bytesOf(4))
  web.keep('copyPosts', B, desc({ start: 6 }), bytesOf(4))
  await settle()
  t.is(keptDb.meta.size, 3)

  t.is(await web.keepOnlyKeptAuthors(new Set([A, ME.toUpperCase(), 'not a key'])), true)
  t.alike(keptNames(), ['avatars/' + ME + '-' + CORE + '-3-1', 'posts/' + A + '-' + CORE + '-1-1'], 'keep-only drops the main photos of everyone else')
  t.alike(names(), ['peekPosts/' + B + '-' + CORE + '-5-1'], 'and leaves the peek photo')
  t.alike(copyNames(), ['copyPosts/' + B + '-' + CORE + '-6-1'], 'and the copy photo')
  t.is(await web.keepOnlyKeptAuthors([A, ME]), true, 'nothing to drop')
  t.is(keptDb.meta.size, 2)

  t.is(await web.dropKeptAuthors([A]), true)
  t.alike(keptNames(), ['avatars/' + ME + '-' + CORE + '-3-1'], 'an author drop reaches the main store')
  t.is(await web.dropKeptRanges([{ core: CORE, start: 3, blocks: 1 }]), true)
  t.is(keptDb.meta.size, 0, 'a range drop reaches the main store')

  web.keep('posts', A, desc(), bytesOf(4))
  await settle()
  t.is(keptDb.meta.size + db.meta.size + copyDb.meta.size, 3)
  t.is(await web.wipeKept(), true)
  t.is(keptDb.meta.size + db.meta.size + copyDb.meta.size, 0, 'a wipe empties the three databases')
  t.alike([keptDb.binding, db.binding, copyDb.binding], [null, null, null], 'and forgets the three bindings')
})

test('real stores: the main store has the phone main caps and 30-day expiry', async (t) => {
  await fresh()
  const web = await loadWeb()
  const peek = await loadPeek()
  const { keptPhotos } = peek
  t.is(peek.KEPT_PHOTO_MAX_BYTES, web.KEEP_MAX_BYTES)
  t.is(peek.KEPT_PHOTO_MAX_FILES, web.KEEP_MAX_FILES)
  t.is(peek.KEPT_PHOTO_MAX_AGE_MS, web.KEEP_MAX_AGE_MS)
  t.is(web.KEEP_MAX_BYTES, 64 * 1024 * 1024)
  t.is(web.KEEP_MAX_FILES, 2000)
  t.is(web.KEEP_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000)
  t.alike(peek.KEPT_PHOTO_KINDS, ['avatars', 'posts'])
  t.is(await web.bindPeek(BIND), true)

  // 8 MiB is the largest photo a descriptor allows: eight fill the 64 MiB.
  const item = 256 * 32768
  const big = new Uint8Array(item)
  const bigDesc = (i) => desc({ start: 1 + i * 256, blocks: 256, bytes: item })
  for (let i = 0; i < 8; i++) t.is(await keptPhotos.put('posts', A, bigDesc(i), big), true)
  t.is(keptDb.meta.size, 8, 'eight 8 MiB photos fit the byte cap')
  t.is(await keptPhotos.put('posts', A, bigDesc(8), big), true)
  t.is(keptDb.meta.size, 8, 'a ninth evicts one')
  t.absent(keptDb.meta.has('posts/' + A + '-' + CORE + '-1-256'), 'the oldest')
  await keptPhotos.wipe()
  t.is(await web.bindPeek(BIND), true)

  for (let i = 0; i < web.KEEP_MAX_FILES + 1; i++) await keptPhotos.put('posts', A, desc({ start: 100 + i }), bytesOf(4))
  t.is(keptDb.meta.size, web.KEEP_MAX_FILES, 'the file cap holds')
  t.absent(keptDb.meta.has('posts/' + A + '-' + CORE + '-100-1'), 'the oldest went first')
  t.ok(keptDb.meta.has('posts/' + A + '-' + CORE + '-' + (100 + web.KEEP_MAX_FILES) + '-1'))
  await keptPhotos.wipe()
  t.is(await web.bindPeek(BIND), true)

  // The store reads its clock through Date.now captured at creation, so the
  // rows are aged instead.
  t.is(await keptPhotos.put('posts', A, desc(), bytesOf(4)), true)
  t.is(await keptPhotos.put('posts', A, desc({ start: 2 }), bytesOf(4)), true)
  const age = (start, ms) => { keptDb.meta.get('posts/' + A + '-' + CORE + '-' + start + '-1').savedAt = Date.now() - ms }
  age(1, web.KEEP_MAX_AGE_MS - 60000)
  age(2, web.KEEP_MAX_AGE_MS + 60000)
  t.alike(await web.keptBytes('posts', A, desc()), bytesOf(4), 'younger than 30 days: read back')
  t.is(await web.keptBytes('posts', A, desc({ start: 2 })), null, 'older than 30 days: gone')
  t.alike(keptNames(), ['posts/' + A + '-' + CORE + '-1-1'], 'and deleted')
})

// Runs after the registerKeptStore test above, which registered keep.web.js.
test('through loadKept on the web: persist true and copy keep followed photos in the main store, no HTTP cache', async (t) => {
  await fresh()
  const web = await loadWeb()
  const caches = await import('../src/localCaches.js')
  const { loadKept, fetchPersist } = await import('../src/media/keptLoad.js')
  t.teardown(() => caches.wipeLocalCaches())
  caches.setAllowedAuthors([ME, A])
  caches.noteBlocksKnown(caches.wipeEpoch())
  t.is(await web.bindPeek(BIND), true)
  for (const mode of [true, 'copy', 'peek', false]) {
    t.is(fetchPersist(mode, A), false, 'no HTTP cache on the web, followed, ' + mode)
    t.is(fetchPersist(mode, B), false, 'nor for a stranger, ' + mode)
  }
  let fetches = 0
  const load = (persist, kind, author, d, bytes = bytesOf(4)) => loadKept({
    kind,
    author,
    d,
    persist,
    keptUrl: web.keptUrl,
    keptBytes: web.keptBytes,
    keep: web.keep,
    fetchBytes: async () => { fetches++; return bytes },
    urlFromBytes: (b, mime) => 'blob:' + b.join(',') + ':' + mime,
    generation: caches.cacheGeneration
  })
  t.is(await load(true, 'posts', A, desc()), 'blob:7,7,7,7:image/jpeg', 'a miss is fetched')
  await settle()
  t.alike(keptNames(), ['posts/' + A + '-' + CORE + '-1-1'], 'and kept in the main store')
  t.is(await load(true, 'posts', A, desc(), bytesOf(4, 9)), 'blob:7,7,7,7:image/jpeg', 'a restart reads it back')
  t.is(fetches, 1, 'with no fetch')
  t.is(await load('copy', 'posts', A, desc(), bytesOf(4, 9)), 'blob:7,7,7,7:image/jpeg', 'a copy-mode load finds the main hit through keptBytes')
  t.is(fetches, 1)

  await load('copy', 'avatars', ME, desc({ start: 2 }))
  await load('copy', 'avatars', B, desc({ start: 3 }))
  await settle()
  t.alike(keptNames(), ['avatars/' + ME + '-' + CORE + '-2-1', 'posts/' + A + '-' + CORE + '-1-1'], 'a followed author in copy mode goes to the main store')
  t.alike(copyNames(), ['copyAvatars/' + B + '-' + CORE + '-3-1'], 'a stranger to the copy store')

  caches.denyAuthors([A])
  t.is(await load('copy', 'posts', A, desc(), bytesOf(4, 9)), 'blob:9,9,9,9:image/jpeg', 'a denied author is never read from the main store')
  t.is(await load(true, 'posts', A, desc(), bytesOf(4, 9)), 'blob:9,9,9,9:image/jpeg')
  t.is(fetches, 5)
})

test('App.js binds the peek store to the member binding, null when there is none', (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(/^import \{ bindPeek \} from '\.\/src\/media\/keep'$/m.test(src), 'bindPeek from media/keep, resolved per platform')
  t.ok(/^import \{[^}]*\bbindingKeyOf\b[^}]*\bmemberSnapshotBinding\b[^}]*\} from '\.\/src\/screens\/Comunidades'$/m.test(src), 'the group snapshots binding rule')
  t.ok(src.includes('const peekBinding = memberSnapshotBinding({ node, acting, pageKey })'), 'built from the acting member')
  t.ok(src.includes('const peekBindingKey = bindingKeyOf(peekBinding)'))
  const effect = /useEffect\(\(\) => \{\n\s+bindPeek\(peekBinding === null \? null : \{ origin: peekBinding\.origin, association: peekBinding\.association, owner: peekBinding\.owner \}\)\n\s+\}, \[peekBindingKey\]\)/
  t.ok(effect.test(src), 'keyed on the binding key; null unbinds; only origin, association and owner')
  t.is(src.split('bindPeek(').length - 1, 1, 'one call site')
})
