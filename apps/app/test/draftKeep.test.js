'use strict'

const test = require('brittle')

const load = () => import('../src/draftKeep.web.js')
const loadNative = () => import('../src/draftKeep.native.js')
const KEY = 'varanda.publicarRascunho'
const OWNER = 'a'.repeat(64)
const NOW = 1700000000000

function replaceGlobal (t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  t.teardown(() => {
    if (original) Object.defineProperty(globalThis, name, original)
    else delete globalThis[name]
  })
}

function fakeStorage (t, { failSet = false } = {}) {
  const map = new Map()
  const store = {
    getItem (k) { return map.has(k) ? map.get(k) : null },
    setItem (k, v) {
      if (failSet) throw new Error('QuotaExceededError')
      map.set(k, String(v))
    },
    removeItem (k) { map.delete(k) }
  }
  replaceGlobal(t, 'sessionStorage', store)
  return map
}

function fakePage (t) {
  const listeners = { doc: new Map(), win: new Map() }
  const on = (where) => ({
    addEventListener (type, fn) { where.set(type, fn) },
    removeEventListener (type, fn) { if (where.get(type) === fn) where.delete(type) }
  })
  const doc = { visibilityState: 'visible', ...on(listeners.doc) }
  replaceGlobal(t, 'document', doc)
  replaceGlobal(t, 'window', on(listeners.win))
  const hide = () => { doc.visibilityState = 'hidden'; listeners.doc.get('visibilitychange')() }
  const show = () => { doc.visibilityState = 'visible'; listeners.doc.get('visibilitychange')() }
  return { listeners, hide, show }
}

function record (fields = {}) {
  return JSON.stringify({ v: 1, owner: OWNER, at: NOW, text: 'meu rascunho', ...fields })
}

test('draft keep saves the text while hidden and drops it once visible again', async (t) => {
  const { watchDraft } = await load()
  const map = fakeStorage(t)
  const page = fakePage(t)
  let draft = { owner: OWNER, text: 'olá\nmundo' }
  const stop = watchDraft(() => draft)
  t.absent(map.has(KEY), 'nothing while visible')
  page.hide()
  const saved = JSON.parse(map.get(KEY))
  t.alike(Object.keys(saved).sort(), ['at', 'owner', 'text', 'v'])
  t.is(saved.owner, OWNER)
  t.is(saved.text, 'olá\nmundo')
  t.is(saved.v, 1)
  page.show()
  t.absent(map.has(KEY), 'a page that came back keeps its draft in memory')
  page.listeners.win.get('pagehide')()
  t.ok(map.has(KEY), 'leaving the page keeps it too')
  draft = { owner: OWNER, text: '   ' }
  page.hide()
  t.absent(map.has(KEY), 'a blank draft removes what was kept')
  draft = null
  page.listeners.win.get('pagehide')()
  t.absent(map.has(KEY), 'no draft keeps nothing')
  stop()
  t.is(page.listeners.doc.size, 0, 'stop removes the visibility listener')
  t.is(page.listeners.win.size, 0, 'and the pagehide one')
})

test('draft keep never saves without an owner or past the size cap', async (t) => {
  const { watchDraft } = await load()
  const map = fakeStorage(t)
  const page = fakePage(t)
  let draft = { owner: '', text: 'x' }
  watchDraft(() => draft)
  page.hide()
  t.absent(map.has(KEY), 'no owner')
  draft = { owner: OWNER, text: 'x'.repeat(50001) }
  page.hide()
  t.absent(map.has(KEY), 'over the cap')
  draft = { owner: OWNER, text: 'x'.repeat(50000) }
  page.hide()
  t.ok(map.has(KEY), 'at the cap')
})

test('draft keep takes the text once, for the same account only', async (t) => {
  const { takeDraft } = await load()
  const map = fakeStorage(t)
  map.set(KEY, record())
  t.is(takeDraft(OWNER, NOW + 1000), 'meu rascunho')
  t.absent(map.has(KEY), 'read once')
  t.is(takeDraft(OWNER, NOW + 1000), '', 'gone')

  map.set(KEY, record())
  t.is(takeDraft('b'.repeat(64), NOW), '', 'another account never sees it')
  t.absent(map.has(KEY), 'and it is dropped')
})

test('draft keep ignores an expired, future or malformed record', async (t) => {
  const { takeDraft } = await load()
  const map = fakeStorage(t)
  const cases = [
    [record(), NOW + 3600000, 'meu rascunho', 'exactly one hour still counts'],
    [record(), NOW + 3600001, '', 'older than one hour'],
    [record(), NOW - 1, '', 'from the future'],
    [record({ v: 2 }), NOW, '', 'another version'],
    [record({ text: 7 }), NOW, '', 'text not a string'],
    [record({ text: '  ' }), NOW, '', 'blank text'],
    [record({ text: 'x'.repeat(50001) }), NOW, '', 'over the cap'],
    [record({ at: 'agora' }), NOW, '', 'bad time'],
    [record({ owner: undefined }), NOW, '', 'no owner'],
    ['[]', NOW, '', 'an array'],
    ['{', NOW, '', 'not JSON']
  ]
  for (const [raw, now, want, label] of cases) {
    map.set(KEY, raw)
    t.is(takeDraft(OWNER, now), want, label)
    t.absent(map.has(KEY), label + ': removed')
  }
  t.is(takeDraft('', NOW), '', 'no owner asked')
})

test('draft keep survives missing or failing storage', async (t) => {
  const { takeDraft, watchDraft, dropDraft } = await load()
  replaceGlobal(t, 'sessionStorage', undefined)
  const page = fakePage(t)
  watchDraft(() => ({ owner: OWNER, text: 'x' }))
  page.hide()
  t.is(takeDraft(OWNER, NOW), '')
  dropDraft()

  const map = fakeStorage(t, { failSet: true })
  map.set(KEY, record())
  page.hide()
  t.absent(map.has(KEY), 'a refused write leaves no stale record behind')

  replaceGlobal(t, 'document', undefined)
  const stop = watchDraft(() => ({ owner: OWNER, text: 'x' }))
  t.is(typeof stop, 'function', 'no document, no listener')
  stop()
})

test('draft keep dropDraft removes the record', async (t) => {
  const { dropDraft } = await load()
  const map = fakeStorage(t)
  map.set(KEY, record())
  dropDraft()
  t.absent(map.has(KEY))
})

test('draft keep goes with the local caches on a lock, Sair or another account', async (t) => {
  await load()
  const { wipeLocalCaches } = await import('../src/localCaches.js')
  const map = fakeStorage(t)
  map.set(KEY, record())
  wipeLocalCaches()
  t.absent(map.has(KEY), 'the wipe removes the kept text')
})

test('draft keep on native keeps nothing', async (t) => {
  const native = await loadNative()
  t.alike(Object.keys(native).sort(), ['dropDraft', 'takeDraft', 'watchDraft'])
  t.is(native.takeDraft(OWNER), '')
  const stop = native.watchDraft(() => ({ owner: OWNER, text: 'x' }))
  t.is(typeof stop, 'function')
  t.is(stop(), undefined)
  t.is(native.dropDraft(), undefined)
})
