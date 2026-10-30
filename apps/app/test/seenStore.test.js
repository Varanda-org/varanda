'use strict'

// The Avisos seen-token store (src/seenStore.*.js): web over a fake
// globalThis.localStorage, native over an in-memory expo-file-system stub
// registered as a module hook.
const test = require('brittle')
const { register } = require('node:module')

const hooks = `
const SRC = 'export const Paths = { document: { uri: "file:///stub/Documents/" } }\\n' +
  'export class File {\\n' +
  '  constructor (dir, name) { this.uri = dir.uri + name }\\n' +
  '  get exists () { return globalThis.__files.has(this.uri) }\\n' +
  '  create () { globalThis.__files.set(this.uri, "") }\\n' +
  '  write (text) {\\n' +
  '    if (!globalThis.__files.has(this.uri)) throw new Error("no file")\\n' +
  '    if (globalThis.__crash) { globalThis.__files.set(this.uri, text.slice(0, 5)); throw new Error("disk full") }\\n' +
  '    globalThis.__files.set(this.uri, text)\\n' +
  '  }\\n' +
  '  textSync () { return globalThis.__files.get(this.uri) }\\n' +
  '  delete () { globalThis.__files.delete(this.uri) }\\n' +
  '  move (dest) { if (globalThis.__files.has(dest.uri)) throw new Error("exists"); globalThis.__files.set(dest.uri, globalThis.__files.get(this.uri)); globalThis.__files.delete(this.uri); this.uri = dest.uri }\\n' +
  '}\\n'
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: 'data:text/javascript,' + encodeURIComponent(SRC), shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const loadWeb = () => import('../src/seenStore.web.js')
const loadNative = () => import('../src/seenStore.native.js')
const loadNotices = () => import('../src/notices.js')

function fakeStorage () {
  const map = new Map()
  return {
    map,
    getItem: (k) => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

const OWN = 'ab'.repeat(32)
const ids = (n) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(32, '0'))

test('web store round trips on the unchanged key with the unchanged bytes', async (t) => {
  const { loadSeenText, saveSeenText, clearSeenText } = await loadWeb()
  const { SEEN_STORAGE_KEY, SEEN_MAX, serializeSeen, parseSeen } = await loadNotices()
  const ls = fakeStorage()
  globalThis.localStorage = ls
  t.teardown(() => { delete globalThis.localStorage })
  t.is(loadSeenText(), null)
  const text = serializeSeen(OWN, ids(SEEN_MAX))
  saveSeenText(text)
  t.is(SEEN_STORAGE_KEY, 'varanda-notices-seen')
  t.is(ls.map.get(SEEN_STORAGE_KEY), text, 'same key, same bytes')
  t.is(loadSeenText(), text)
  t.alike(parseSeen(loadSeenText(), OWN), ids(SEEN_MAX))
  clearSeenText()
  t.is(ls.map.has(SEEN_STORAGE_KEY), false)
  t.is(loadSeenText(), null)
})

test('web store never throws when localStorage is missing or throws', async (t) => {
  const { loadSeenText, saveSeenText, clearSeenText } = await loadWeb()
  delete globalThis.localStorage
  t.is(loadSeenText(), null)
  saveSeenText('x')
  clearSeenText()
  globalThis.localStorage = {
    getItem () { throw new Error('denied') },
    setItem () { throw new Error('denied') },
    removeItem () { throw new Error('denied') }
  }
  t.teardown(() => { delete globalThis.localStorage })
  t.is(loadSeenText(), null)
  saveSeenText('x')
  clearSeenText()
  t.pass()
})

test('native store round trips through a file in the document dir and deletes it', async (t) => {
  globalThis.__files = new Map()
  t.teardown(() => { delete globalThis.__files })
  const { loadSeenText, saveSeenText, clearSeenText } = await loadNative()
  const { SEEN_MAX, serializeSeen, parseSeen } = await loadNotices()
  t.is(loadSeenText(), null, 'no file yet')
  const text = serializeSeen(OWN, ids(SEEN_MAX))
  saveSeenText(text)
  t.alike([...globalThis.__files.keys()], ['file:///stub/Documents/varanda-avisos-vistos.json'], 'no .tmp or .bak left behind')
  t.is(loadSeenText(), text)
  t.alike(parseSeen(loadSeenText(), OWN), ids(SEEN_MAX))
  saveSeenText('second')
  t.is(loadSeenText(), 'second', 'overwrites')
  clearSeenText()
  t.is(globalThis.__files.size, 0)
  t.is(loadSeenText(), null)
  clearSeenText()
})

test('native store never throws when the file system fails', async (t) => {
  globalThis.__files = null
  t.teardown(() => { delete globalThis.__files })
  const { loadSeenText, saveSeenText, clearSeenText } = await loadNative()
  t.is(loadSeenText(), null)
  saveSeenText('x')
  clearSeenText()
  t.pass()
})

test('native store keeps the old list when a write fails after truncating', async (t) => {
  globalThis.__files = new Map()
  t.teardown(() => { delete globalThis.__files; delete globalThis.__crash })
  const { loadSeenText, saveSeenText } = await loadNative()
  const { SEEN_MAX, serializeSeen, parseSeen } = await loadNotices()
  const old = serializeSeen(OWN, ids(SEEN_MAX))
  saveSeenText(old)
  globalThis.__crash = true
  saveSeenText(serializeSeen(OWN, ids(SEEN_MAX).reverse()))
  globalThis.__crash = false
  t.is(loadSeenText(), old, 'old content survives')
  t.alike(parseSeen(loadSeenText(), OWN), ids(SEEN_MAX))
  t.alike([...globalThis.__files.keys()], ['file:///stub/Documents/varanda-avisos-vistos.json'], 'tmp removed')
})

test('native store falls back to .bak when the main file is missing and clear removes all', async (t) => {
  globalThis.__files = new Map([['file:///stub/Documents/varanda-avisos-vistos.json.bak', 'kept']])
  t.teardown(() => { delete globalThis.__files })
  const { loadSeenText, saveSeenText, clearSeenText } = await loadNative()
  t.is(loadSeenText(), 'kept')
  saveSeenText('fresh')
  t.is(loadSeenText(), 'fresh')
  t.is(globalThis.__files.size, 1)
  globalThis.__files.set('file:///stub/Documents/varanda-avisos-vistos.json.bak', 'x')
  globalThis.__files.set('file:///stub/Documents/varanda-avisos-vistos.json.tmp', 'y')
  clearSeenText()
  t.is(globalThis.__files.size, 0)
})
