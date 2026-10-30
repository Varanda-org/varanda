'use strict'

// src/outboxStore.native.js with expo-file-system replaced by an in-memory
// stub (registered as a module hook, which also resolves the extensionless
// relative imports of src/ like Metro). Compared with src/outboxStore.web.js
// over a fake localStorage: same format, same refusals.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const fileSystem = `
const files = globalThis.__stubFiles = globalThis.__stubFiles || new Map()
export const Paths = { document: { uri: 'file:///stub/Documents/' } }
export class File {
  constructor (dir, name) { this.uri = dir.uri + name }
  get exists () { return files.has(this.uri) }
  create () { if (files.has(this.uri)) throw new Error('exists'); files.set(this.uri, '') }
  write (text) {
    if (!files.has(this.uri)) throw new Error('no file')
    // Like the real one: truncates in place, then fails part way.
    if (globalThis.__stubWriteFails) { files.set(this.uri, String(text).slice(0, 5)); throw new Error('disk full') }
    files.set(this.uri, String(text))
  }
  textSync () { if (!files.has(this.uri)) throw new Error('missing'); return files.get(this.uri) }
  delete () { files.delete(this.uri) }
  move (dest) {
    if (!files.has(this.uri)) throw new Error('missing')
    if (files.has(dest.uri)) throw new Error('destination exists')
    if (globalThis.__stubMoveFails && globalThis.__stubMoveFails(this.uri, dest.uri)) throw new Error('move failed')
    files.set(dest.uri, files.get(this.uri))
    files.delete(this.uri)
    this.uri = dest.uri
  }
}
`
const hooks = `
const stubs = {
  'expo-file-system': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fileSystem)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (/^\\.\\.?\\/[^.]*$/.test(specifier) && context.parentURL && context.parentURL.includes('/src/')) {
    return next(specifier + '.js', context)
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const DIR = 'file:///stub/Documents/'
const PATH = DIR + 'varanda-outbox.json'
const WEB_KEY = 'varanda-web-outbox'

const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => { storage.set(k, String(v)) },
  removeItem: (k) => { storage.delete(k) }
}

const files = () => globalThis.__stubFiles
const load = async () => ({
  native: await import('../src/outboxStore.native.js'),
  web: await import('../src/outboxStore.web.js'),
  outbox: await import('../src/outbox.js')
})

async function reset () {
  await load()
  files().clear()
  storage.clear()
  globalThis.__stubWriteFails = false
  globalThis.__stubMoveFails = null
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ASSOC = 'c'.repeat(64)

function sample (outbox) {
  let items = []
  items = outbox.enqueue(items, { author: A, association: ASSOC, kind: 'post', text: 'olá, mundo', now: 1000, id: '0123456789abcdef' })
  items = outbox.enqueue(items, { author: A, association: ASSOC, kind: 'reply', to: B + ':3', text: 'resposta\ncom linha', now: 2000, id: 'fedcba9876543210' })
  items = outbox.enqueue(items, { author: B, association: ASSOC, kind: 'post', text: 'outra pessoa', now: 3000, id: '00000000000000ff' })
  return outbox.claim(items, '0123456789abcdef', { now: 4000, floorSeq: 7 })
}

test('native store: available, empty without a file', async (t) => {
  const { native } = await load()
  await reset()
  t.is(native.outboxAvailable, true)
  t.alike(native.loadOutbox(), [])
})

test('round trip: same serialized text as the web store, same items back', async (t) => {
  const { native, web, outbox } = await load()
  await reset()
  const items = sample(outbox)
  t.is(native.saveOutbox(items), true)
  t.is(web.saveOutbox(items), true)
  t.is(files().get(PATH), storage.get(WEB_KEY))
  t.is(files().get(PATH), outbox.serializeOutbox(items))
  t.alike(native.loadOutbox(), items)
  t.alike(native.loadOutbox(), web.loadOutbox())
  t.is(files().has(PATH + '.tmp'), false)
  t.is(files().has(PATH + '.bak'), false)
  t.alike([...files().keys()], [PATH], 'one file, in the document dir, never in the node data dir')
})

test('refuses what the web refuses: malformed, oversized, unknown version', async (t) => {
  const { native, web, outbox } = await load()
  await reset()
  const good = sample(outbox)[1]
  const bad = [
    { ...good, id: '0000000000000001', text: 'x'.repeat(outbox.MAX_TEXT + 1) },
    { ...good, id: '0000000000000002', text: '' },
    { ...good, id: '0000000000000003', text: 'bidi ‮' },
    { ...good, id: '0000000000000004', author: 'A'.repeat(64) },
    { ...good, id: '0000000000000005', association: 'nope' },
    { ...good, id: 'short' },
    { ...good, id: '0000000000000006', kind: 'quote' },
    { ...good, id: '0000000000000007', kind: 'post', to: B + ':1' },
    { ...good, id: '0000000000000008', to: B + ':0' },
    { ...good, id: '0000000000000009', v: 2 },
    { ...good, id: '000000000000000a', state: 'sent' },
    { ...good, id: '000000000000000b', writtenAt: 'ontem' },
    { ...good, id: '000000000000000c', lastError: null },
    null,
    'texto'
  ]
  const text = JSON.stringify({ v: 1, items: [...bad, good] })
  files().set(PATH, text)
  storage.set(WEB_KEY, text)
  t.alike(native.loadOutbox(), [good])
  t.alike(native.loadOutbox(), web.loadOutbox())

  for (const whole of ['{"v":2,"items":[]}', 'not json', '[]', 'null', '{"v":1,"items":{}}']) {
    files().set(PATH, whole)
    storage.set(WEB_KEY, whole)
    t.alike(native.loadOutbox(), [], 'whole file refused: ' + whole)
    t.alike(native.loadOutbox(), web.loadOutbox())
  }
})

test('a sending item without a floor loads as uncertain, like the web', async (t) => {
  const { native, web, outbox } = await load()
  await reset()
  const raw = { ...sample(outbox)[0], floorSeq: null }
  const text = JSON.stringify({ v: 1, items: [raw] })
  files().set(PATH, text)
  storage.set(WEB_KEY, text)
  const [item] = native.loadOutbox()
  t.is(item.state, 'uncertain')
  t.is(item.lastError, outbox.UNCERTAIN_MESSAGE)
  t.alike(native.loadOutbox(), web.loadOutbox())
})

test('a failing write keeps the previous file and reports not saved', async (t) => {
  const { native, outbox } = await load()
  await reset()
  const items = sample(outbox)
  t.is(native.saveOutbox(items), true)
  const before = files().get(PATH)
  globalThis.__stubWriteFails = true
  t.is(native.saveOutbox(items.slice(0, 1)), false)
  globalThis.__stubWriteFails = false
  t.is(files().get(PATH), before)
  t.is(files().has(PATH + '.tmp'), false)
  t.alike(native.loadOutbox(), items)
})

test('a failing move into place keeps the previous queue', async (t) => {
  const { native, outbox } = await load()
  await reset()
  const items = sample(outbox)
  t.is(native.saveOutbox(items), true)
  globalThis.__stubMoveFails = (from, to) => from === PATH + '.tmp' && to === PATH
  t.is(native.saveOutbox([]), false)
  globalThis.__stubMoveFails = null
  t.is(files().has(PATH + '.tmp'), false)
  t.alike(native.loadOutbox(), items)
})

test('interrupted after setting the old file aside: load falls back to .bak', async (t) => {
  const { native, outbox } = await load()
  await reset()
  const items = sample(outbox)
  files().set(PATH + '.bak', outbox.serializeOutbox(items))
  t.alike(native.loadOutbox(), items)
  t.is(native.saveOutbox(items.slice(0, 1)), true)
  t.alike(native.loadOutbox(), items.slice(0, 1))
  t.is(files().has(PATH + '.bak'), false)
})

test('randomId: 16 hex from crypto.getRandomValues, never Math.random', async (t) => {
  const { native } = await load()
  const original = globalThis.crypto
  const realRandom = Math.random
  let calls = 0
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues (array) {
        calls++
        t.ok(array instanceof Uint8Array)
        t.is(array.length, 8)
        for (let i = 0; i < array.length; i++) array[i] = i * 17
        return array
      }
    }
  })
  Math.random = () => { throw new Error('Math.random used') }
  try {
    t.is(native.randomId(), '00112233445566' + '77')
    t.is(calls, 1)
  } finally {
    Math.random = realRandom
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original })
  }
  t.ok(/^[0-9a-f]{16}$/.test(native.randomId()))
})
