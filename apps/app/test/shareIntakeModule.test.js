'use strict'

// modules/share-intake/index.js (the JS side of the share sheet intake) with
// expo-modules-core replaced by a stub whose native module the tests swap
// through globalThis.__shareNative. Each import is a fresh copy: the module
// binds the native object once, when it loads.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'ShareIntake') throw new Error('unknown module')
  if (!globalThis.__shareNative) throw new Error('missing')
  return globalThis.__shareNative
}
`
const reactNative = `
export const AppState = {
  addEventListener (type, fn) {
    const app = globalThis.__shareApp
    if (!app || typeof app.add !== 'function') throw new Error('no app state')
    return app.add(type, fn)
  }
}
`
const hooks = `
const stubs = {
  'expo-modules-core': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(expoCore)}),
  'react-native': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(reactNative)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (specifier === '../modules/share-intake') return next('../modules/share-intake/index.js', context)
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const HEX = '0123456789abcdef'
const ID = '1731340800000-' + HEX + HEX
const OTHER = '1731340800001-' + HEX + HEX
const moduleHref = pathToFileURL(path.join(__dirname, '../modules/share-intake/index.js')).href
let nonce = 0

const load = () => import(moduleHref + '?n=' + (++nonce))

function uriFor (id, name) {
  return 'file:///data/user/0/app.varanda/cache/varanda-share/' + id + '/' + name
}

function entry (id, name, over) {
  return Object.assign({
    uri: uriFor(id, name),
    mimeType: 'image/jpeg',
    width: 640,
    height: 480
  }, over || {})
}

function payload (over) {
  return Object.assign({
    id: ID,
    at: 1731340800000,
    title: 'Titulo',
    text: 'texto',
    url: 'https://exemplo.test/a',
    total: 1,
    files: [entry(ID, '0.jpg')]
  }, over || {})
}

const GOOD = {
  id: ID,
  at: 1731340800000,
  title: 'Titulo',
  text: 'texto',
  url: 'https://exemplo.test/a',
  total: 1,
  files: [{ uri: uriFor(ID, '0.jpg'), mimeType: 'image/jpeg', width: 640, height: 480 }]
}

function fake ({ answer = null, onPeek, onRelease, onSweep, onListen } = {}) {
  const calls = { peek: 0, release: [], sweep: [], listen: [] }
  globalThis.__shareNative = {
    peek () {
      calls.peek++
      if (onPeek) return onPeek()
      return Promise.resolve(answer)
    },
    release (id) {
      calls.release.push(id)
      if (onRelease) return onRelease(id)
    },
    sweep (ms) {
      calls.sweep.push(ms)
      if (onSweep) return onSweep(ms)
    },
    addListener (event, fn) {
      calls.listen.push({ event, fn })
      if (onListen) return onListen(event, fn)
      return { remove () { calls.listen.push('remove') } }
    }
  }
  return calls
}

async function silence (run) {
  const lines = []
  const log = console.log
  const error = console.error
  const warn = console.warn
  const info = console.info
  const write = (...args) => { lines.push(args.map(String).join(' ')) }
  console.log = write
  console.error = write
  console.warn = write
  console.info = write
  try {
    await run()
  } finally {
    console.log = log
    console.error = error
    console.warn = warn
    console.info = info
  }
  return lines
}

test('share intake: missing module never throws', async (t) => {
  globalThis.__shareNative = null
  const results = []
  let off
  let called = false
  const lines = await silence(async () => {
    const mod = await load()
    results.push(mod.isAvailable(), await mod.peek(), await mod.release(ID), await mod.sweep(1000), await mod.clear())
    off = mod.listen(() => { called = true })
    off()
  })
  t.alike(results, [false, null, undefined, undefined, undefined])
  t.is(typeof off, 'function')
  t.is(called, false)
  t.alike(lines, [])
})

test('share intake: throwing native resolves null and never surfaces the error', async (t) => {
  const secret = new Error('secret native detail')
  for (const onPeek of [
    () => { throw secret },
    () => Promise.reject(secret)
  ]) {
    fake({
      onPeek,
      onRelease () { throw secret },
      onSweep () { return Promise.reject(secret) },
      onListen () { throw secret }
    })
    const results = []
    let off
    const lines = await silence(async () => {
      const mod = await load()
      results.push(mod.isAvailable(), await mod.peek(), await mod.release(ID), await mod.release('bad'), await mod.sweep(5), await mod.clear())
      off = mod.listen(() => {})
      off()
    })
    t.alike(results, [true, null, undefined, undefined, undefined, undefined])
    t.is(typeof off, 'function')
    t.alike(lines, [])
  }
})

test('share intake: native property access errors stay inside the facade', async (t) => {
  globalThis.__shareNative = Object.defineProperties({}, Object.fromEntries(
    ['peek', 'release', 'sweep', 'addListener'].map(name => [name, {
      get () { throw new Error('secret native detail') }
    }])
  ))
  const mod = await load()
  t.is(await mod.peek(), null)
  t.is(await mod.release(ID), undefined)
  t.is(await mod.sweep(1), undefined)
  t.is(await mod.clear(), undefined)
  const off = mod.listen(() => t.fail('no native listener'))
  t.is(typeof off, 'function')
  off()
})

test('share intake: bad id or at gives null', async (t) => {
  fake()
  const mod = await load()
  t.is(mod.isAvailable(), true)
  const badIds = [
    null,
    '',
    ID.toUpperCase(),
    '173134080000-' + HEX + HEX,
    '17313408000000-' + HEX + HEX,
    '1731340800000-' + 'a'.repeat(31),
    '1731340800000-' + 'g'.repeat(32),
    '1731340800000_' + HEX + HEX,
    ' ' + ID,
    ID + '\n'
  ]
  for (const id of badIds) {
    globalThis.__shareNative.peek = () => Promise.resolve(payload({ id }))
    t.is(await mod.peek(), null, 'id ' + String(id))
  }
  const badAts = [1.5, '1731340800000', null, undefined, NaN, Infinity, -Infinity, true, Number.MAX_SAFE_INTEGER + 1]
  for (const at of badAts) {
    globalThis.__shareNative.peek = () => Promise.resolve(payload({ at }))
    t.is(await mod.peek(), null, 'at ' + String(at))
  }
  for (const answer of [null, undefined, 'ok', 1, []]) {
    globalThis.__shareNative.peek = () => Promise.resolve(answer)
    t.is(await mod.peek(), null)
  }
  globalThis.__shareNative.peek = () => Promise.resolve(payload({ at: 0, total: 1 }))
  const zero = await mod.peek()
  t.is(zero.at, 0)
  t.is(zero.id, ID)
})

test('share intake: text is cut to 4000 UTF-16 units and total covers the files', async (t) => {
  fake()
  const mod = await load()
  globalThis.__shareNative.peek = () => Promise.resolve(payload())
  t.alike(await mod.peek(), GOOD)

  const emoji = '😀'.repeat(2001)
  const split = 'a' + '😀'.repeat(2000)
  globalThis.__shareNative.peek = () => Promise.resolve(payload({
    title: 'é'.repeat(4500),
    text: emoji,
    url: split,
    extra: 'secret native detail',
    total: 0
  }))
  const cut = await mod.peek()
  t.is(cut.title, 'é'.repeat(4000))
  t.is(cut.title.length, 4000)
  t.is(cut.text, '😀'.repeat(2000))
  t.is(cut.text.length, 4000)
  t.is(cut.url, 'a' + '😀'.repeat(1999))
  t.is(cut.url.length, 3999)
  t.is(cut.total, 1)
  t.is(Object.hasOwn(cut, 'extra'), false)
  t.is(JSON.stringify(cut).includes('secret native detail'), false)

  globalThis.__shareNative.peek = () => Promise.resolve(payload({
    title: null,
    text: 5,
    url: undefined,
    total: '3'
  }))
  const blank = await mod.peek()
  t.is(blank.title, '')
  t.is(blank.text, '')
  t.is(blank.url, '')
  t.is(blank.total, 1)

  globalThis.__shareNative.peek = () => Promise.resolve(payload({
    total: -3,
    files: [entry(ID, '0.jpg'), entry(ID, '1.gif', { mimeType: 'image/gif', width: 32, height: 32 })]
  }))
  const raised = await mod.peek()
  t.is(raised.files.length, 2)
  t.is(raised.files[1].mimeType, 'image/gif')
  t.is(raised.total, 2)

  globalThis.__shareNative.peek = () => Promise.resolve(payload({ total: 8, files: [entry(ID, '0.jpg')] }))
  t.is((await mod.peek()).total, 8)

  globalThis.__shareNative.peek = () => Promise.resolve(payload({ total: 4, files: null }))
  const noFiles = await mod.peek()
  t.alike(noFiles.files, [])
  t.is(noFiles.total, 4)

  globalThis.__shareNative.peek = () => Promise.resolve(payload({ total: null, files: [] }))
  t.is((await mod.peek()).total, 0)
})

test('share intake: a uri outside the share directory is dropped', async (t) => {
  const outside = [
    { uri: 'file:///tmp/0.jpg', mimeType: 'image/jpeg', width: 10, height: 10 },
    { uri: uriFor(OTHER, '0.jpg'), mimeType: 'image/jpeg', width: 10, height: 10 },
    { uri: 'content://media/varanda-share/' + ID + '/0.jpg', mimeType: 'image/jpeg', width: 10, height: 10 },
    { uri: '/data/varanda-share/' + ID + '/0.jpg', mimeType: 'image/jpeg', width: 10, height: 10 },
    { uri: 'FILE:///data/varanda-share/' + ID + '/0.jpg', mimeType: 'image/jpeg', width: 10, height: 10 },
    { uri: uriFor(ID, '0.jpg').replace('/' + ID + '/', '/' + ID + 'x/'), mimeType: 'image/jpeg', width: 10, height: 10 },
    { uri: uriFor(ID, '0.jpg'), mimeType: 1, width: 10, height: 10 },
    null
  ]
  fake()
  const mod = await load()
  globalThis.__shareNative.peek = () => Promise.resolve(payload({
    total: 1,
    files: [entry(ID, '0.jpg'), ...outside, entry(ID, '1.gif', { mimeType: 'image/gif' })]
  }))
  const got = await mod.peek()
  t.alike(got.files.map((file) => file.uri), [uriFor(ID, '0.jpg'), uriFor(ID, '1.gif')])
  t.is(got.total, 2)
  t.alike(Object.keys(got.files[0]).sort(), ['height', 'mimeType', 'uri', 'width'])
})

test('share intake: only direct intake file paths are kept', async (t) => {
  fake()
  const mod = await load()
  const invalid = [
    'file:///etc/hosts?/varanda-share/' + ID + '/0.jpg',
    'file:///etc/hosts#/varanda-share/' + ID + '/0.jpg',
    'file:///etc/%00/varanda-share/' + ID + '/0.jpg',
    'file:///etc/\u0001/varanda-share/' + ID + '/0.jpg',
    'file:///etc/\u007f/varanda-share/' + ID + '/0.jpg',
    'file:///data/other/' + ID + '/0.jpg',
    uriFor(ID, '../0.jpg'),
    uriFor(ID, './0.jpg'),
    uriFor(ID, 'other/path/0.jpg'),
    uriFor(ID, '0.jpg/unrelated/1.jpg'),
    uriFor(ID, '0.jpg').replace('/cache/', '/cache/../'),
    uriFor(ID, '0.jpg').replace('/cache/', '/cache/./'),
    uriFor(ID, '0.jpg').replace('/cache/', '/cache%2f/'),
    uriFor(ID, '0.jpg').replace('/cache/', '/cache%2F/'),
    uriFor(ID, '0.jpg').replace('/cache/', '/cache%2e/'),
    uriFor(ID, '0.jpg').replace('/cache/', '/cache%2E/'),
    uriFor(ID, '%2e%2e/0.jpg'),
    uriFor(ID, '0%2Ejpg'),
    uriFor(ID, '0.jpg%2f1.jpg'),
    ...['photo.jpg', '100.jpg', '0.mp4', '0.JPG', '0.jpg\n', '0.jpg?x=1', '0.jpg#x'].map(name => uriFor(ID, name))
  ]
  for (const uri of invalid) {
    globalThis.__shareNative.peek = () => payload({ files: [entry(ID, '0.jpg', { uri })] })
    t.alike((await mod.peek()).files, [], JSON.stringify(uri))
  }
  const files = ['0.jpg', '01.png', '2.gif', '3.webp', '4.heic', '99.img'].map(name => entry(ID, name))
  globalThis.__shareNative.peek = () => payload({ files })
  t.alike((await mod.peek()).files, files)
})

test('share intake: non-positive sizes are dropped', async (t) => {
  const bad = [
    { width: 0, height: 10 },
    { width: 10, height: -1 },
    { width: 1.5, height: 10 },
    { width: '10', height: 10 },
    { width: 10, height: Infinity },
    { width: 10, height: undefined },
    { width: true, height: 10 },
    { width: 10, height: Number.NaN }
  ].map((over) => entry(ID, '2.jpg', over))
  fake()
  const mod = await load()
  globalThis.__shareNative.peek = () => Promise.resolve(payload({
    total: 0,
    files: [bad[0], entry(ID, '0.jpg', { width: 1, height: 2 }), ...bad.slice(1)]
  }))
  const got = await mod.peek()
  t.alike(got.files, [{ uri: uriFor(ID, '0.jpg'), mimeType: 'image/jpeg', width: 1, height: 2 }])
  t.is(got.total, 1)
})

test('share intake: more than 10 files are cut', async (t) => {
  const files = [{ uri: 'file:///tmp/nope.jpg', mimeType: 'image/jpeg', width: 8, height: 8 }]
  for (let i = 0; i < 11; i++) files.push(entry(ID, i + '.jpg', { width: i + 1, height: i + 2 }))
  fake()
  const mod = await load()
  globalThis.__shareNative.peek = () => Promise.resolve(payload({ total: 1, files }))
  const got = await mod.peek()
  t.is(got.files.length, 10)
  t.alike(got.files.map((file) => file.uri), Array.from({ length: 10 }, (_, i) => uriFor(ID, i + '.jpg')))
  t.is(got.files[0].width, 1)
  t.is(got.files[9].height, 11)
  t.is(got.total, 10)
})

test('share intake: callers during a peek wait for one fresh native read', async (t) => {
  const pending = []
  const calls = fake({
    onPeek () {
      return new Promise((resolve) => { pending.push(resolve) })
    }
  })
  const mod = await load()
  const first = mod.peek()
  const second = mod.peek()
  const third = mod.peek()
  t.not(first, second)
  t.is(second, third)
  t.is(calls.peek, 1)
  pending[0](payload({ text: 'older', total: 4 }))
  t.is((await first).text, 'older')
  t.is(calls.peek, 2)
  pending[1](payload({ text: 'newer', total: 5 }))
  const expected = Object.assign({}, GOOD, { text: 'newer', total: 5 })
  t.alike(await second, expected)
  t.alike(await third, expected)
  t.is(calls.peek, 2)
})

test('share intake: JS and Android use the shared id pattern and file cap', async (t) => {
  const { SHARE_ID } = await import('../src/sharedIntent.js')
  const { MAX_MEDIA_PER_POST } = await import('../src/media/plan.js')
  const js = fs.readFileSync(path.join(__dirname, '../modules/share-intake/index.js'), 'utf8')
  const kotlin = fs.readFileSync(path.join(__dirname, '../modules/share-intake/android/src/main/java/app/varanda/shareintake/ShareInbox.kt'), 'utf8')
  const jsId = js.match(/const\s+ID_RE\s*=\s*\/([^/\n]+)\//)
  const kotlinId = kotlin.match(/\bID\s*=\s*Regex\s*\(\s*"([^"]+)"\s*\)/)
  const jsCap = js.match(/const\s+FILE_MAX\s*=\s*(\d+)/)
  const kotlinCap = kotlin.match(/const\s+val\s+MAX_FILES\s*=\s*(\d+)/)
  t.ok(jsId)
  t.ok(kotlinId)
  t.ok(jsCap)
  t.ok(kotlinCap)
  t.is(jsId[1], SHARE_ID.source)
  t.is(kotlinId[1], SHARE_ID.source)
  t.is(Number(jsCap[1]), MAX_MEDIA_PER_POST)
  t.is(Number(kotlinCap[1]), MAX_MEDIA_PER_POST)
})

test('share intake: release with a bad id never reaches native', async (t) => {
  const calls = fake({
    onRelease () { throw new Error('secret native detail') },
    onSweep () { throw new Error('secret native detail') }
  })
  const mod = await load()
  const bad = [null, undefined, '', 1, ID.toUpperCase(), ID + ' ', ID + '\n', ID.slice(1), '1731340800000-' + 'g'.repeat(32)]
  for (const id of bad) t.is(await mod.release(id), undefined, 'release ' + String(id))
  t.alike(calls.release, [])
  t.is(await mod.release(ID), undefined)
  t.alike(calls.release, [ID])
  for (const ms of [0, -1, 1.5, NaN, Infinity, '10', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(await mod.sweep(ms), undefined, 'sweep ' + String(ms))
  }
  t.alike(calls.sweep, [])
  t.is(await mod.sweep(1), undefined)
  t.is(await mod.sweep(Number.MAX_SAFE_INTEGER), undefined)
  t.alike(calls.sweep, [1, Number.MAX_SAFE_INTEGER])
})

test('share intake: clear releases the share peek offers, then sweeps every older one', async (t) => {
  const order = []
  const calls = fake({
    onPeek () { order.push('peek'); return Promise.resolve(payload()) },
    onRelease (id) { order.push('release ' + id) },
    onSweep (ms) { order.push('sweep ' + ms) }
  })
  const mod = await load()
  t.is(await mod.clear(), undefined)
  t.alike(order, ['peek', 'release ' + ID, 'sweep 1'])
  t.alike(calls.release, [ID])
  t.alike(calls.sweep, [1])

  const empty = fake()
  const none = await load()
  t.is(await none.clear(), undefined)
  t.alike(empty.release, [], 'nothing pending, nothing released')
  t.alike(empty.sweep, [1], 'the sweep still runs')

  const failing = fake({ onPeek () { return Promise.reject(new Error('secret native detail')) } })
  const broken = await load()
  t.is(await broken.clear(), undefined)
  t.alike(failing.sweep, [1], 'a failed peek still sweeps')

  const releaseFails = fake({ answer: payload(), onRelease () { throw new Error('secret native detail') } })
  const stubborn = await load()
  t.is(await stubborn.clear(), undefined)
  t.alike(releaseFails.sweep, [1], 'a failed release still sweeps')

  globalThis.__shareNative = { peek () { return Promise.resolve(payload()) } }
  const partial = await load()
  t.is(await partial.clear(), undefined, 'a module without release or sweep is a no-op')
})

test('share intake: listen and its unsubscribe', async (t) => {
  const calls = fake()
  const mod = await load()
  let hits = 0
  const off = mod.listen(() => { hits++ })
  t.is(calls.listen[0].event, 'onPending')
  calls.listen[0].fn()
  t.is(hits, 1)
  off()
  t.ok(calls.listen.includes('remove'))
  const removes = calls.listen.filter((item) => item === 'remove').length
  off()
  t.is(calls.listen.filter((item) => item === 'remove').length, removes)

  fake({ onListen () { return null } })
  const bare = await load()
  const offBare = bare.listen(() => t.fail('no subscription'))
  offBare()

  fake({ onListen () { throw new Error('secret native detail') } })
  const broken = await load()
  const offBroken = broken.listen(() => {})
  offBroken()

  fake({
    onListen () {
      return { remove () { throw new Error('secret native detail') } }
    }
  })
  const throwing = await load()
  throwing.listen(() => {})()

  globalThis.__shareNative = { peek () { return Promise.resolve(null) } }
  const quiet = await load()
  const offQuiet = quiet.listen(() => t.fail('no addListener'))
  t.is(typeof offQuiet, 'function')
  offQuiet()
})

// Behaviour with Cache Storage is in shareIntakeWeb.test.js. Without it (Node
// here) the web intake is inert, and it never reaches for a page API.
test('share intake web: inert without Cache Storage, no page APIs', async (t) => {
  const web = await import('../src/shareIntake.web.js')
  for (const name of ['peek', 'release', 'sweep', 'listen', 'clear']) t.is(typeof web[name], 'function', name)
  t.is(await web.peek(), null)
  t.is(await web.clear(), undefined)
  t.is(await web.release(ID), undefined)
  t.is(await web.sweep(1000), undefined)
  let called = false
  const off = web.listen(() => { called = true })
  t.is(typeof off, 'function')
  off()
  t.is(called, false)
  const src = fs.readFileSync(path.join(__dirname, '../src/shareIntake.web.js'), 'utf8')
  t.is(/\b(window|document|navigator|localStorage|sessionStorage|self)\b/.test(src), false)
  t.is(src.split('globalThis.').length - 1, src.split('globalThis.caches').length - 1, 'globalThis only for caches')
})

test('share intake native: listen follows onPending and the app becoming active', async (t) => {
  const calls = { peek: 0, release: [], sweep: [], listen: 0, remove: 0 }
  let pendingFn = null
  globalThis.__shareNative = {
    peek () {
      calls.peek++
      return Promise.resolve(null)
    },
    release (id) { calls.release.push(id) },
    sweep (ms) { calls.sweep.push(ms) },
    addListener (event, fn) {
      calls.listen++
      t.is(event, 'onPending')
      pendingFn = fn
      return { remove () { calls.remove++ } }
    }
  }
  const app = { type: null, fn: null, remove: 0 }
  globalThis.__shareApp = {
    add (type, fn) {
      app.type = type
      app.fn = fn
      return { remove () { app.remove++ } }
    }
  }
  const mod = await import('../src/shareIntake.native.js')
  t.is(await mod.peek(), null)
  t.is(calls.peek, 1)
  await mod.release('nope')
  await mod.sweep(0)
  t.alike(calls.release, [])
  t.alike(calls.sweep, [])
  await mod.release(ID)
  await mod.sweep(2500)
  t.alike(calls.release, [ID])
  t.alike(calls.sweep, [2500])
  t.is(typeof mod.clear, 'function', 'clear is re-exported')
  await mod.clear()
  t.alike(calls.sweep, [2500, 1])
  let hits = 0
  const off = mod.listen(() => { hits++ })
  t.is(calls.listen, 1)
  t.is(app.type, 'change')
  pendingFn()
  t.is(hits, 1)
  app.fn('background')
  app.fn('inactive')
  t.is(hits, 1)
  app.fn('active')
  t.is(hits, 2)
  off()
  t.is(calls.remove, 1)
  t.is(app.remove, 1)
  off()
  t.is(calls.remove, 1)
  t.is(app.remove, 1)
  const offBad = mod.listen(null)
  t.is(typeof offBad, 'function')
  offBad()
  t.is(calls.listen, 1)
})
