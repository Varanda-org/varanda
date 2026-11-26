'use strict'

// src/media/keep.web.js: the peek kinds go to src/media/peekPhotos.web.js,
// the followed kinds stay inert. The store's IndexedDB backend is replaced by
// an in-memory one (its exported methods are swapped), so the real store,
// registry (src/localCaches.js), keptLoad and revokeMedia run end to end.
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
async function memoryBackend () {
  if (db !== null) return db
  const { backend } = await loadPeek()
  db = { binding: null, meta: new Map(), bytes: new Map(), puts: 0 }
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

// Every store call runs in one queue: a read resolves after all before it.
async function settle () {
  const { peekPhotos } = await loadPeek()
  await peekPhotos.read('peekPosts', A, desc({ start: 99 }))
}

async function fresh () {
  const d = await memoryBackend()
  const { peekPhotos } = await loadPeek()
  await peekPhotos.wipe()
  return d
}

const names = () => [...db.meta.keys()].sort()

test('each export delegates to the peek store and returns its promise', async (t) => {
  const web = await loadWeb()
  const { peekPhotos } = await loadPeek()
  const calls = []
  const saved = { ...peekPhotos }
  const promises = {}
  for (const m of ['bind', 'read', 'put', 'dropAuthors', 'dropRanges', 'retain', 'wipe']) {
    promises[m] = Promise.resolve(m)
    peekPhotos[m] = (...args) => { calls.push([m, ...args]); return promises[m] }
  }
  t.teardown(() => Object.assign(peekPhotos, saved))

  const d = desc()
  const b = bytesOf(4)
  t.is(web.keptBytes('peekPosts', A, d), promises.read)
  t.is(web.keptBytes('peekAvatars', A, d), promises.read)
  t.is(web.keep('peekPosts', A, d, b), null, 'keep hands out no URL')
  t.is(web.wipeKept(), promises.wipe)
  t.is(web.dropKeptAuthors([A]), promises.dropAuthors)
  const ranges = [{ core: CORE, start: 0, blocks: 2 }]
  t.is(web.dropKeptRanges(ranges), promises.dropRanges)
  const entries = [{ kind: 'peekPosts', author: A, d }]
  t.is(web.retainKept(['posts', 'peekPosts', 'avatars', 'peekAvatars'], entries), promises.retain)
  t.is(web.bindPeek(BIND), promises.bind)
  t.is(web.bindPeek(null), promises.bind)
  t.is(web.bindPeek(), promises.bind)

  t.alike(calls, [
    ['read', 'peekPosts', A, d],
    ['read', 'peekAvatars', A, d],
    ['put', 'peekPosts', A, d, b],
    ['wipe'],
    ['dropAuthors', [A]],
    ['dropRanges', ranges],
    ['retain', ['peekPosts', 'peekAvatars'], entries],
    ['bind', BIND],
    ['bind', null],
    ['bind', null]
  ])
})

test('followed kinds stay inert; keptUrl is always null and synchronous', async (t) => {
  const web = await loadWeb()
  const { peekPhotos } = await loadPeek()
  const calls = []
  const saved = { ...peekPhotos }
  for (const m of ['read', 'put', 'retain']) peekPhotos[m] = (...args) => { calls.push(m); return Promise.resolve(null) }
  t.teardown(() => Object.assign(peekPhotos, saved))

  for (const kind of ['posts', 'avatars', 'other', undefined]) {
    t.is(web.keep(kind, A, desc(), bytesOf(4)), null)
    t.is(web.keptBytes(kind, A, desc()), null)
  }
  for (const kind of ['posts', 'avatars', 'peekPosts', 'peekAvatars']) t.is(web.keptUrl(kind, A, desc()), null)
  t.is(web.retainKept(['posts', 'avatars'], []), null)
  t.is(web.retainKept(null, []), null)
  t.is(web.retainKept(undefined, []), null)
  for (const fn of ['keepOnlyKeptAuthors', 'releaseKept', 'trimKept']) t.is(web[fn](new Set([A])), null)
  t.alike(calls, [], 'the store was never called')
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
