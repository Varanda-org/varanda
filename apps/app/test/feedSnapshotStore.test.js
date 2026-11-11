'use strict'

// A Rua's snapshot store (src/feedSnapshotStore.*.js): native over an
// in-memory expo-file-system stub registered as a module hook (with the
// synchronous textSync the store reads, which helpers/stub-file-system.mjs
// does not have), web over a fake globalThis.localStorage.
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

const loadNative = () => import('../src/feedSnapshotStore.native.js')
const loadWeb = () => import('../src/feedSnapshotStore.web.js')

const PATH = 'file:///stub/Caches/varanda-rua-snapshot.json'

function fresh (t, entries = []) {
  globalThis.__files = new Map(entries)
  t.teardown(() => {
    delete globalThis.__files
    delete globalThis.__crash
    delete globalThis.__moveFails
  })
}

test('native: a missing file reads as null', async (t) => {
  fresh(t)
  const { loadSnapshotText, previewCapable } = await loadNative()
  t.is(loadSnapshotText(), null)
  t.is(previewCapable, true)
})

test('native: save, load and overwrite in the cache dir (never backed up), no .tmp or .bak left', async (t) => {
  fresh(t)
  const { loadSnapshotText, saveSnapshotText } = await loadNative()
  saveSnapshotText('{"v":1}')
  t.alike([...globalThis.__files.keys()], [PATH])
  t.is(loadSnapshotText(), '{"v":1}')
  saveSnapshotText('{"v":1,"x":2}')
  t.is(loadSnapshotText(), '{"v":1,"x":2}')
  t.alike([...globalThis.__files.keys()], [PATH])
})

test('native: a torn write keeps the previous snapshot', async (t) => {
  fresh(t)
  const { loadSnapshotText, saveSnapshotText } = await loadNative()
  saveSnapshotText('previous snapshot')
  globalThis.__crash = true
  saveSnapshotText('next snapshot, never finished')
  globalThis.__crash = false
  t.is(loadSnapshotText(), 'previous snapshot')
  t.alike([...globalThis.__files.keys()], [PATH], 'the partial .tmp is gone')
})

test('native: a crash between the two moves leaves the .bak, which is read', async (t) => {
  fresh(t)
  const { loadSnapshotText, saveSnapshotText } = await loadNative()
  saveSnapshotText('previous snapshot')
  // The .tmp -> current move fails after current was set aside as .bak; the
  // store puts the .bak back. Then a state where only the .bak survived.
  globalThis.__moveFails = (from) => from.endsWith('.tmp')
  saveSnapshotText('next')
  delete globalThis.__moveFails
  t.is(loadSnapshotText(), 'previous snapshot', 'restored from .bak')
  globalThis.__files = new Map([[PATH + '.bak', 'only the bak']])
  t.is(loadSnapshotText(), 'only the bak')
  saveSnapshotText('after recovery')
  t.is(loadSnapshotText(), 'after recovery')
  t.alike([...globalThis.__files.keys()], [PATH])
})

test('native: clear removes the file, .bak and .tmp', async (t) => {
  fresh(t, [[PATH, 'a'], [PATH + '.bak', 'b'], [PATH + '.tmp', 'c']])
  const { loadSnapshotText, clearSnapshot } = await loadNative()
  clearSnapshot()
  t.is(globalThis.__files.size, 0)
  t.is(loadSnapshotText(), null)
  clearSnapshot()
})

test('native: never throws when the file system fails', async (t) => {
  globalThis.__files = null
  t.teardown(() => { delete globalThis.__files })
  const { loadSnapshotText, saveSnapshotText, clearSnapshot } = await loadNative()
  t.is(loadSnapshotText(), null)
  saveSnapshotText('x')
  clearSnapshot()
  t.pass()
})

function fakeStorage () {
  const map = new Map()
  return {
    map,
    getItem: (k) => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

test('web: save, load, clear on its own key; missing reads as null', async (t) => {
  const ls = fakeStorage()
  globalThis.localStorage = ls
  t.teardown(() => { delete globalThis.localStorage })
  const { loadSnapshotText, saveSnapshotText, clearSnapshot, previewCapable } = await loadWeb()
  t.is(previewCapable, false)
  t.is(loadSnapshotText(), null)
  saveSnapshotText('{"v":1}')
  t.is(ls.map.get('varanda-rua-snapshot'), '{"v":1}')
  t.is(loadSnapshotText(), '{"v":1}')
  clearSnapshot()
  t.is(ls.map.size, 0)
  t.is(loadSnapshotText(), null)
})

test('web: never throws when localStorage is missing or throws', async (t) => {
  const { loadSnapshotText, saveSnapshotText, clearSnapshot } = await loadWeb()
  delete globalThis.localStorage
  t.is(loadSnapshotText(), null)
  saveSnapshotText('x')
  clearSnapshot()
  globalThis.localStorage = {
    getItem () { throw new Error('denied') },
    setItem () { throw new Error('denied') },
    removeItem () { throw new Error('denied') }
  }
  t.teardown(() => { delete globalThis.localStorage })
  t.is(loadSnapshotText(), null)
  saveSnapshotText('x')
  clearSnapshot()
  t.pass()
})
