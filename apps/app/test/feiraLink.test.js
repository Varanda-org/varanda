'use strict'

// Feira listing links (src/feiraLink.js). ES module loaded through import();
// storage, location and history are in-memory fakes.
const test = require('brittle')

const load = () => import('../src/feiraLink.js')
const A = 'ab'.repeat(32)
const NOW = 1_800_000_000_000
const HOUR = 3600000

function memoryStorage (initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

function fakeBrowser (pathname, search = '', hash = '') {
  const calls = []
  return {
    location: { pathname, search, hash },
    history: { state: { idx: 2 }, replaceState (s, title, url) { calls.push({ s, title, url }) } },
    calls
  }
}

test('parseListingPath: both paths, uppercase hex, fragment ignored', async (t) => {
  const l = await load()
  t.alike(l.parseListingPath('/anuncio/' + A + '/7'), { author: A, seq: 7 })
  t.alike(l.parseListingPath('/f/' + A + '/12'), { author: A, seq: 12 })
  t.alike(l.parseListingPath('/f/' + A.toUpperCase() + '/12'), { author: A, seq: 12 }, 'uppercase hex is folded to the canonical key')
  t.alike(l.parseListingPath('/f/' + A + '/12#oferta=5000'), { author: A, seq: 12 })
})

test('parseListingPath: refuses anything else', async (t) => {
  const l = await load()
  const bad = [
    '/f/' + A + '/12/foto/1',
    '/anuncio/' + A + '/7/',
    '/anuncio/' + A,
    '/f/' + A + '/0',
    '/f/' + A + '/07',
    '/f/' + A + '/99999999999999999',
    '/f/' + A.slice(2) + '/1',
    '/f/' + A + 'ab/1',
    '/f/' + A + '/1?x=1',
    '/f//' + A + '/1',
    '/F/' + A + '/1',
    '/f/%61' + A.slice(2) + '/1',
    '/x/f/' + A + '/1',
    null,
    42
  ]
  for (const p of bad) t.is(l.parseListingPath(p), null, String(p))
})

test('shareUrlOf: https origin only, root seq', async (t) => {
  const l = await load()
  t.is(l.shareUrlOf('https://bora.varanda.app', A, 3), 'https://bora.varanda.app/f/' + A + '/3')
  t.is(l.shareUrlOf('http://bora.varanda.app', A, 3), null)
  t.is(l.shareUrlOf('https://bora.varanda.app/', A, 3), null)
  t.is(l.shareUrlOf('https://u@bora.varanda.app', A, 3), null)
  t.is(l.shareUrlOf('javascript:alert(1)', A, 3), null)
  t.is(l.shareUrlOf('https://bora.varanda.app', A.toUpperCase(), 3), null)
  t.is(l.shareUrlOf('https://bora.varanda.app', A, 0), null)
  t.is(l.shareUrlOf('https://bora.varanda.app', A, 1.5), null)
})

test('captureListingLink: stores the listing and cleans the path', async (t) => {
  const l = await load()
  const storage = memoryStorage()
  const b = fakeBrowser('/anuncio/' + A + '/7', '?conta=1', '#token=x')
  const rec = l.captureListingLink(b.location, b.history, storage, NOW)
  t.alike({ ...rec }, { v: 1, author: A, seq: 7, at: NOW })
  t.is(b.calls.length, 1)
  t.is(b.calls[0].url, '/?conta=1#token=x', 'path cleaned, search and hash kept')
  t.alike(b.calls[0].s, { idx: 2 })
  t.alike({ ...l.readListingLink(storage, NOW + 1000) }, { v: 1, author: A, seq: 7, at: NOW })
})

test('captureListingLink: expires after one hour', async (t) => {
  const l = await load()
  const storage = memoryStorage()
  const b = fakeBrowser('/f/' + A + '/7')
  l.captureListingLink(b.location, b.history, storage, NOW)
  t.ok(l.readListingLink(storage, NOW + HOUR))
  t.is(l.readListingLink(storage, NOW + HOUR + 1), null)
  t.is(storage.map.size, 0, 'an expired record is removed')
})

test('captureListingLink: an invalid listing path clears an older record', async (t) => {
  const l = await load()
  const storage = memoryStorage()
  l.captureListingLink(fakeBrowser('/f/' + A + '/7').location, fakeBrowser('/').history, storage, NOW)
  const b = fakeBrowser('/f/' + A + '/7/extra')
  t.is(l.captureListingLink(b.location, b.history, storage, NOW), null)
  t.is(storage.map.size, 0)
  t.is(b.calls[0].url, '/')
})

test('captureListingLink: another path only reads; storage failures are survived', async (t) => {
  const l = await load()
  const storage = memoryStorage()
  const other = fakeBrowser('/@ana')
  t.is(l.captureListingLink(other.location, other.history, storage, NOW), null)
  t.is(other.calls.length, 0, 'other paths are not touched')
  const throwing = { getItem () { throw new Error('x') }, setItem () { throw new Error('x') }, removeItem () { throw new Error('x') } }
  const b = fakeBrowser('/f/' + A + '/7')
  t.alike({ ...l.captureListingLink(b.location, b.history, throwing, NOW) }, { v: 1, author: A, seq: 7, at: NOW })
  t.is(l.captureListingLink(b.location, b.history, null, NOW).seq, 7)
  t.is(l.readListingLink(null, NOW), null)
})

test('decodeListingLink: rebuilds only a well formed record', async (t) => {
  const l = await load()
  const ok = { v: 1, author: A, seq: 7, at: NOW }
  t.ok(l.decodeListingLink(JSON.stringify(ok), NOW))
  t.is(l.decodeListingLink(JSON.stringify({ ...ok, at: NOW + 120000 }), NOW), null, 'from the future')
  t.is(l.decodeListingLink(JSON.stringify({ ...ok, v: 2 }), NOW), null)
  t.is(l.decodeListingLink(JSON.stringify({ ...ok, author: A.toUpperCase() }), NOW), null)
  t.is(l.decodeListingLink(JSON.stringify({ ...ok, seq: '7' }), NOW), null)
  t.is(l.decodeListingLink('{', NOW), null)
  t.is(l.decodeListingLink('x'.repeat(300), NOW), null)
  const rec = l.decodeListingLink(JSON.stringify({ ...ok, __proto__: { evil: 1 }, extra: 1 }), NOW)
  t.alike(Object.keys(rec), ['v', 'author', 'seq', 'at'])
})
