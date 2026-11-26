'use strict'

// The per-screen snapshot store (src/screenSnapshotStore.*.js): native over
// an in-memory expo-file-system stub registered as a module hook, web over a
// fake globalThis.localStorage, and the registration with src/localCaches.js
// (wipe, prune, and saves prepared before a wipe).
const test = require('brittle')
const { register } = require('node:module')

const hooks = `
const SRC = 'export const Paths = { document: { uri: "file:///stub/Documents/" }, cache: { uri: "file:///stub/Caches/" } }\\n' +
  'export class File {\\n' +
  '  constructor (dir, name) { this.uri = dir.uri + name }\\n' +
  '  get exists () { return globalThis.__files.has(this.uri) }\\n' +
  '  create () { if (globalThis.__files.has(this.uri)) throw new Error("exists"); globalThis.__files.set(this.uri, "") }\\n' +
  '  write (text) {\\n' +
  '    if (!globalThis.__files.has(this.uri)) throw new Error("no file")\\n' +
  '    if (globalThis.__crash) { globalThis.__files.set(this.uri, text.slice(0, 5)); throw new Error("disk full") }\\n' +
  '    globalThis.__files.set(this.uri, text)\\n' +
  '  }\\n' +
  '  textSync () { if (!globalThis.__files.has(this.uri)) throw new Error("missing"); return globalThis.__files.get(this.uri) }\\n' +
  '  delete () { globalThis.__files.delete(this.uri) }\\n' +
  '  move (dest) {\\n' +
  '    if (globalThis.__files.has(dest.uri)) throw new Error("exists")\\n' +
  '    if (globalThis.__moveFails && globalThis.__moveFails(this.uri, dest.uri)) throw new Error("move failed")\\n' +
  '    globalThis.__files.set(dest.uri, globalThis.__files.get(this.uri)); globalThis.__files.delete(this.uri); this.uri = dest.uri\\n' +
  '  }\\n' +
  '}\\n'
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: 'data:text/javascript,' + encodeURIComponent(SRC), shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const loadNative = () => import('../src/screenSnapshotStore.native.js')
const loadWeb = () => import('../src/screenSnapshotStore.web.js')
const loadRules = () => import('../src/screenSnapshot.js')
const loadCaches = () => import('../src/localCaches.js')

const DIR = 'file:///stub/Caches/'
const pathOf = (kind) => DIR + 'varanda-screen-' + kind + '.json'

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const OTHER = 'dd'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ME = Object.freeze({ kind: 'me' })
const PAGE = Object.freeze({ kind: 'page', key: 'ff'.repeat(32), name: '', username: '' })
const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const binding = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, ...extra })

function post (author, seq) {
  return { kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 'texto ' + seq, replyTo: null, quote: null, media: null, preview: null }
}

async function perfil () {
  const { buildScreenSnapshot } = await loadRules()
  return buildScreenSnapshot('perfil', { ...binding(), profile: { name: 'Eu', username: 'eu_mesmo', bio: null, avatar: null } })
}

async function membro (previous, author, followed) {
  const { buildScreenSnapshot } = await loadRules()
  return buildScreenSnapshot('membro', {
    ...binding(),
    previous,
    author,
    header: { name: 'Bia', username: 'bia', bio: null, avatar: null },
    items: [post(author, 2), post(author, 1)],
    before: null,
    atEnd: true,
    originals: null,
    followed
  })
}

// The Momentos strip as useMoments holds it, an hour old now.
async function momentos () {
  const { buildScreenSnapshot } = await loadRules()
  const item = (author, seq) => ({ seq, ref: author + ':' + seq, text: 'm' + seq, at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), media: { mime: 'image/jpeg', w: 100, h: 100, ms: 0 } })
  return buildScreenSnapshot('momentos', {
    ...binding(),
    authors: [{ author: FOLLOW, items: [item(FOLLOW, 1)] }, { author: OTHER, items: [item(OTHER, 1)] }],
    own: [item(OWN, 1)],
    names: [{ author: OTHER, name: 'Leo', username: null, avatar: null }],
    followed: [FOLLOW, OTHER]
  })
}

function fresh (t, entries = []) {
  globalThis.__files = new Map(entries)
  t.teardown(() => {
    delete globalThis.__files
    delete globalThis.__crash
    delete globalThis.__moveFails
  })
}

function fakeStorage () {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

test('native: save and load one file per kind, no .tmp or .bak left', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration } = await loadCaches()
  t.is(store.previewCapable, true)
  t.is(store.loadScreenSnapshot('perfil', binding()), null)
  const snap = await perfil()
  t.is(store.saveScreenSnapshot('perfil', snap, cacheGeneration()), true)
  t.alike([...globalThis.__files.keys()], [pathOf('perfil')])
  t.alike(store.loadScreenSnapshot('perfil', binding()), snap)
  t.is(store.saveScreenSnapshot('diario', snap, cacheGeneration()), false, 'a snapshot of another kind is refused')
  t.is(store.saveScreenSnapshot('grupos', snap, cacheGeneration()), false, 'an unknown kind is refused')
  t.alike([...globalThis.__files.keys()], [pathOf('perfil')])
})

test('native: a page actor reads nothing and removes nothing', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration } = await loadCaches()
  store.saveScreenSnapshot('perfil', await perfil(), cacheGeneration())
  t.is(store.loadScreenSnapshot('perfil', binding({ acting: PAGE })), null)
  t.ok(globalThis.__files.has(pathOf('perfil')))
})

test('native: a text of another owner is refused and removed', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration } = await loadCaches()
  store.saveScreenSnapshot('perfil', await perfil(), cacheGeneration())
  t.is(store.loadScreenSnapshot('perfil', binding({ owner: FOLLOW })), null)
  t.is(globalThis.__files.size, 0)
})

test('native: a failed move restores the .bak, and a lone .bak is read', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration } = await loadCaches()
  const snap = await perfil()
  store.saveScreenSnapshot('perfil', snap, cacheGeneration())
  globalThis.__moveFails = (from) => from.endsWith('.tmp')
  store.saveScreenSnapshot('perfil', { ...snap, body: { ...snap.body, name: 'Outro' } }, cacheGeneration())
  delete globalThis.__moveFails
  t.is(store.loadScreenSnapshot('perfil', binding()).body.name, 'Eu', 'restored from .bak')
  globalThis.__files = new Map([[pathOf('perfil') + '.bak', JSON.stringify(snap)]])
  t.alike(store.loadScreenSnapshot('perfil', binding()), snap)
  globalThis.__crash = true
  store.saveScreenSnapshot('perfil', { ...snap, body: { ...snap.body, name: 'Rasgado' } }, cacheGeneration())
  globalThis.__crash = false
  t.is(store.loadScreenSnapshot('perfil', binding()).body.name, 'Eu', 'a torn write keeps the previous one')
})

test('native: clear removes one kind; clear all removes every kind', async (t) => {
  fresh(t, [[pathOf('perfil'), 'a'], [pathOf('perfil') + '.bak', 'b'], [pathOf('perfil') + '.tmp', 'c'], [pathOf('membro'), 'd']])
  const store = await loadNative()
  store.clearScreenSnapshot('perfil')
  t.alike([...globalThis.__files.keys()], [pathOf('membro')])
  store.clearScreenSnapshots()
  t.is(globalThis.__files.size, 0)
})

test('native: never throws when the file system fails', async (t) => {
  fresh(t)
  const store = await loadNative()
  delete globalThis.__files
  t.is(store.loadScreenSnapshot('perfil', binding()), null)
  t.is(store.loadScreenSnapshotText('perfil'), null)
  t.execution(() => store.saveScreenSnapshot('perfil', { v: 1, kind: 'perfil' }, 0))
  t.execution(() => store.clearScreenSnapshots())
})

test('registry: a wipe removes every kind', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration, wipeLocalCaches } = await loadCaches()
  store.saveScreenSnapshot('perfil', await perfil(), cacheGeneration())
  store.saveScreenSnapshot('membro', await membro(null, FOLLOW, [FOLLOW]), cacheGeneration())
  t.is(globalThis.__files.size, 2)
  wipeLocalCaches()
  t.is(globalThis.__files.size, 0)
})

test('registry: a save prepared before a wipe is discarded', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration, wipeLocalCaches, dropAuthors } = await loadCaches()
  const snap = await perfil()
  const gen = cacheGeneration()
  wipeLocalCaches()
  t.is(store.saveScreenSnapshot('perfil', snap, gen), false)
  t.is(globalThis.__files.size, 0)
  const gen2 = cacheGeneration()
  dropAuthors([OTHER])
  t.is(store.saveScreenSnapshot('perfil', snap, gen2), false, 'a prune discards it too')
  t.is(store.saveScreenSnapshot('perfil', snap, cacheGeneration()), true)
})

test('registry: a block or an unfollow rewrites membro', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration, dropAuthors, keepOnlyAuthors } = await loadCaches()
  const both = await membro(await membro(null, FOLLOW, [FOLLOW, OTHER]), OTHER, [FOLLOW, OTHER])
  t.is(store.saveScreenSnapshot('membro', both, cacheGeneration()), true)
  dropAuthors([OTHER])
  t.alike(Object.keys(store.loadScreenSnapshot('membro', binding()).body.authors), [FOLLOW])
  keepOnlyAuthors(new Set([OWN]))
  t.alike(store.loadScreenSnapshot('membro', binding()).body.authors, {})
})

test('registry: momentos is wiped with every kind and rewritten by a block or an unfollow', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration, wipeLocalCaches, dropAuthors, keepOnlyAuthors } = await loadCaches()
  const snap = await momentos()
  t.is(store.saveScreenSnapshot('momentos', snap, cacheGeneration()), true)
  t.alike([...globalThis.__files.keys()], [pathOf('momentos')])
  t.alike(store.loadScreenSnapshot('momentos', binding()), snap)
  dropAuthors([OTHER])
  const blocked = store.loadScreenSnapshot('momentos', binding())
  t.alike(blocked.body.authors.map((a) => a.author), [FOLLOW])
  t.alike(blocked.body.names, [], 'the blocked author\'s name goes too')
  keepOnlyAuthors(new Set([OWN]))
  const unfollowed = store.loadScreenSnapshot('momentos', binding())
  t.alike(unfollowed.body.authors, [])
  t.is(unfollowed.body.own.length, 1, 'the own moments stay')
  wipeLocalCaches()
  t.is(globalThis.__files.size, 0, 'a wipe removes it with no screen mounted')

  const ls = fakeStorage()
  globalThis.localStorage = ls
  t.teardown(() => { delete globalThis.localStorage })
  const web = await loadWeb()
  t.is(web.saveScreenSnapshot('momentos', await momentos(), cacheGeneration()), true)
  t.alike([...ls.map.keys()], ['varanda-screen-momentos'])
  wipeLocalCaches()
  t.is(ls.map.size, 0)
})

test('web: one key per kind, missing reads as null, registry wipe', async (t) => {
  const ls = fakeStorage()
  globalThis.localStorage = ls
  t.teardown(() => { delete globalThis.localStorage })
  const store = await loadWeb()
  const { cacheGeneration, wipeLocalCaches } = await loadCaches()
  t.is(store.previewCapable, false)
  t.is(store.loadScreenSnapshot('perfil', binding()), null)
  const snap = await perfil()
  t.is(store.saveScreenSnapshot('perfil', snap, cacheGeneration()), true)
  t.alike([...ls.map.keys()], ['varanda-screen-perfil'])
  t.alike(store.loadScreenSnapshot('perfil', binding()), snap)
  t.is(store.loadScreenSnapshot('perfil', binding({ acting: PAGE })), null)
  store.clearScreenSnapshot('perfil')
  t.is(ls.map.size, 0)
  store.saveScreenSnapshot('perfil', snap, cacheGeneration())
  wipeLocalCaches()
  t.is(ls.map.size, 0)
})

test('web: never throws when localStorage is missing or throws', async (t) => {
  const store = await loadWeb()
  delete globalThis.localStorage
  t.is(store.loadScreenSnapshot('perfil', binding()), null)
  globalThis.localStorage = {
    getItem () { throw new Error('denied') },
    setItem () { throw new Error('denied') },
    removeItem () { throw new Error('denied') }
  }
  t.teardown(() => { delete globalThis.localStorage })
  t.is(store.loadScreenSnapshot('perfil', binding()), null)
  const snap = await perfil()
  t.execution(() => store.saveScreenSnapshot('perfil', snap, 0))
  t.execution(() => store.clearScreenSnapshots())
})

const STRANGER = 'cc'.repeat(32)

function peekRow (author, seq, extra = {}) {
  return { ...post(author, seq), avatar: null, round: 0, ...extra }
}

async function espiadinha () {
  const { buildScreenSnapshot } = await loadRules()
  return buildScreenSnapshot('espiadinha', {
    ...binding(),
    rows: [peekRow(STRANGER, 3), peekRow(OTHER, 2, { quote: { author: STRANGER, seq: 1 } }), peekRow(OTHER, 1)],
    meta: { diaries: 3, skipped: 0, incomplete: false },
    blocked: [],
    followed: new Set([FOLLOW])
  })
}

test('registry: espiadinha is wiped though its screen never loaded it', async (t) => {
  await loadNative()
  const { wipeLocalCaches } = await loadCaches()
  const { SCREEN_SNAPSHOT_KINDS } = await loadRules()
  t.ok(SCREEN_SNAPSHOT_KINDS.includes('espiadinha'))
  // Written by an earlier run: nothing in this one loaded or saved it.
  fresh(t, [[pathOf('espiadinha'), JSON.stringify(await espiadinha())], [pathOf('espiadinha') + '.bak', '{}']])
  wipeLocalCaches()
  t.is(globalThis.__files.size, 0)

  const ls = fakeStorage()
  ls.map.set('varanda-screen-espiadinha', JSON.stringify(await espiadinha()))
  globalThis.localStorage = ls
  t.teardown(() => { delete globalThis.localStorage })
  await loadWeb()
  wipeLocalCaches()
  t.is(ls.map.size, 0, 'web too')
})

test('registry: a block or a follow rewrites espiadinha with the purge generation', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration, dropAuthors, keepOnlyAuthors } = await loadCaches()
  const snap = await espiadinha()
  t.is(store.saveScreenSnapshot('espiadinha', snap, cacheGeneration()), true)
  t.alike(store.loadScreenSnapshot('espiadinha', binding()), snap)
  const before = cacheGeneration()
  dropAuthors([STRANGER])
  t.ok(cacheGeneration() > before)
  const blocked = store.loadScreenSnapshot('espiadinha', binding())
  t.alike(blocked.body.rows.map((r) => r.seq), [1], 'the poster and the quoting row go')
  keepOnlyAuthors(new Set([OWN, OTHER]))
  t.is(store.loadScreenSnapshot('espiadinha', binding()).body.rows.length, 0, 'a followed author leaves the Espiadinha copy')
  t.is(store.loadScreenSnapshot('espiadinha', binding({ owner: FOLLOW })), null, 'another owner reads nothing')
  t.is(globalThis.__files.size, 0, 'and the text is removed')
  t.is(store.saveScreenSnapshot('espiadinha', snap, cacheGeneration()), true)
  t.is(store.loadScreenSnapshot('espiadinha', binding({ acting: PAGE })), null, 'a page actor reads nothing')
  t.is(globalThis.__files.size, 1, 'and removes nothing')
})

test('registry: a block whose rewrite cannot be written leaves no old copy (native and web)', async (t) => {
  fresh(t)
  const store = await loadNative()
  const { cacheGeneration, dropAuthors } = await loadCaches()
  const kinds = {
    membro: await membro(await membro(null, FOLLOW, [FOLLOW, OTHER]), OTHER, [FOLLOW, OTHER]),
    momentos: await momentos(),
    espiadinha: await espiadinha()
  }
  for (const [kind, snap] of Object.entries(kinds)) t.is(store.saveScreenSnapshot(kind, snap, cacheGeneration()), true, kind)
  globalThis.__crash = true
  dropAuthors([OTHER])
  delete globalThis.__crash
  for (const kind of Object.keys(kinds)) t.is(store.loadScreenSnapshot(kind, binding()), null, 'native ' + kind + ': nothing of the blocked author is readable')
  t.is(globalThis.__files.size, 0, 'no file, .bak or .tmp left')

  const ls = fakeStorage()
  globalThis.localStorage = ls
  t.teardown(() => { delete globalThis.localStorage })
  const web = await loadWeb()
  for (const [kind, snap] of Object.entries(kinds)) t.is(web.saveScreenSnapshot(kind, snap, cacheGeneration()), true, kind)
  const setItem = ls.setItem
  ls.setItem = () => { throw new Error('quota') }
  dropAuthors([OTHER])
  ls.setItem = setItem
  for (const kind of Object.keys(kinds)) t.is(web.loadScreenSnapshot(kind, binding()), null, 'web ' + kind + ': nothing of the blocked author is readable')
  t.is(ls.map.size, 0)
})
