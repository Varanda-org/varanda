'use strict'

// Public post links (src/postLink.js) and the pending-destination stores.
const test = require('brittle')

const load = () => import('../src/postLink.js')
const HEX = 'ab'.repeat(32)
const HOUR = 3600000
const T0 = 1700000000000

test('parsePostPath: both prefixes', async (t) => {
  const { parsePostPath } = await load()
  t.alike(parsePostPath('/publicacao/' + HEX + '/1'), { author: HEX, seq: 1 })
  t.alike(parsePostPath('/p/' + HEX + '/42'), { author: HEX, seq: 42 })
  t.alike(parsePostPath('/p/' + HEX + '/9007199254740991'), { author: HEX, seq: 9007199254740991 })
})

test('parsePostPath: refuses policy, bad seq, length, case, extras and non-strings', async (t) => {
  const { parsePostPath } = await load()
  const bad = [
    '/p/policy',
    '/publicacao/policy',
    '/p/' + HEX + '/0',
    '/publicacao/' + HEX + '/0',
    '/p/' + HEX + '/01',
    '/publicacao/' + HEX + '/01',
    '/p/' + HEX + '/9007199254740992',
    '/publicacao/' + HEX + '/9007199254740992',
    '/p/' + HEX.slice(0, 63) + '/1',
    '/publicacao/' + HEX.slice(0, 63) + '/1',
    '/p/' + HEX.toUpperCase() + '/1',
    '/publicacao/' + HEX.toUpperCase() + '/1',
    '/p/' + HEX + '/1/foto/1',
    '/publicacao/' + HEX + '/1/foto/1',
    '/p/' + HEX + '/1/',
    '/publicacao/' + HEX + '/1/',
    '/p/' + HEX + '/1?x=1',
    '/publicacao/' + HEX + '/1?x=1',
    '/p/' + HEX + '/1#top',
    null,
    undefined,
    1
  ]
  for (const p of bad) t.is(parsePostPath(p), null, String(p))
})

test('postRef output passes isRef and validEntry for conversa', async (t) => {
  const { parsePostPath, postRef } = await load()
  const { isRef, validEntry } = await import('../src/nav.js')
  const ref = postRef(parsePostPath('/publicacao/' + HEX + '/12'))
  t.is(ref, HEX + ':12')
  t.ok(isRef(ref))
  t.ok(validEntry({ screen: 'conversa', key: ref }))
  t.is(postRef({ author: HEX, seq: 0 }), null)
  t.is(postRef({ author: HEX.toUpperCase(), seq: 1 }), null)
  t.is(postRef(null), null)
})

test('postLink: builds the public path and refuses a bad origin or ref', async (t) => {
  const { postRef, postLink } = await load()
  const ref = postRef({ author: HEX, seq: 12 })
  t.is(postLink('https://varanda.example', ref), 'https://varanda.example/p/' + HEX + '/12')
  t.is(postLink('http://127.0.0.1:8790', ref), 'http://127.0.0.1:8790/p/' + HEX + '/12')
  t.is(postLink('', ref), null)
  t.is(postLink('https://varanda.example/app', ref), null)
  t.is(postLink('https://varanda.example/', ref), null)
  t.is(postLink('https://varanda.example', HEX + ':0'), null)
  t.is(postLink('https://varanda.example', HEX + '/12'), null)
})

function exercise (t, mod, readRaw) {
  mod.clearPostLink()
  const dest = { author: HEX, seq: 9 }
  mod.savePostLink()
  mod.savePostLink(null)
  mod.savePostLink({ author: 'nope', seq: 1 }, T0)
  t.is(mod.takePostLink(T0), null, 'invalid input is ignored')
  mod.savePostLink(dest, T0)
  mod.savePostLink({ author: HEX, seq: 0 }, T0 + 1)
  t.alike(mod.takePostLink(T0 + 10), dest)
  t.alike(mod.takePostLink(T0 + 10), dest, 'take peeks')
  if (readRaw) t.is(readRaw(), JSON.stringify({ author: HEX, seq: 9, at: T0 }), 'take does not remove')
  t.alike(mod.takePostLink(T0 + HOUR), dest, 'exactly one hour is still kept')
  t.is(mod.takePostLink(T0 + HOUR + 1), null, 'older than one hour is absent')
  if (readRaw) t.is(readRaw(), null, 'an expired record is removed')
  mod.savePostLink(dest, T0)
  mod.clearPostLink()
  t.is(mod.takePostLink(T0 + 10), null)
  if (readRaw) t.is(readRaw(), null)
}

test('native store: peek, clear and one hour', async (t) => {
  const mod = await import('../src/postLinkStore.native.js')
  t.teardown(() => mod.clearPostLink())
  exercise(t, mod)
})

function installSession (storage) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage
  })
}

function removeSession () {
  delete globalThis.sessionStorage
}

test('web store: peek, clear and one hour against sessionStorage', async (t) => {
  const map = new Map()
  const fake = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
  installSession(fake)
  t.teardown(removeSession)
  const mod = await import('../src/postLinkStore.web.js')
  exercise(t, mod, () => fake.getItem('varanda.postLink'))
})

test('web store: refused tab storage keeps the post in page memory, never throws', async (t) => {
  t.teardown(removeSession)
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get () { throw new Error('blocked') }
  })
  const mod = await import('../src/postLinkStore.web.js')
  t.teardown(() => mod.clearPostLink())
  mod.savePostLink({ author: HEX, seq: 4 }, T0)
  t.alike(mod.takePostLink(T0), { author: HEX, seq: 4 }, 'a blocked getter keeps it in memory')
  t.alike(mod.takePostLink(T0), { author: HEX, seq: 4 }, 'take only peeks')
  mod.clearPostLink()
  t.is(mod.takePostLink(T0), null, 'clear empties memory')
  removeSession()
  // Quota: reads work but the write is refused, and an older record is there.
  const older = JSON.stringify({ author: HEX, seq: 9, at: T0 })
  installSession({
    getItem () { return older },
    setItem () { throw new Error('QuotaExceededError') },
    removeItem () { throw new Error('denied') }
  })
  mod.savePostLink({ author: HEX, seq: 4 }, T0)
  t.alike(mod.takePostLink(T0), { author: HEX, seq: 4 }, 'the newer post in memory wins')
  t.is(mod.takePostLink(T0 + 3600001), null, 'memory also expires after one hour')
  mod.clearPostLink()
})

test('web store: a tampered stored value gives null', async (t) => {
  const map = new Map()
  const fake = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
  installSession(fake)
  t.teardown(removeSession)
  const mod = await import('../src/postLinkStore.web.js')
  for (const raw of [
    JSON.stringify({ author: 'tampered', seq: 1, at: T0 }),
    '{',
    JSON.stringify({ author: HEX, seq: '01', at: T0 }),
    JSON.stringify({ author: HEX.toUpperCase(), seq: 4, at: T0 }),
    JSON.stringify({ author: HEX, seq: 4 })
  ]) {
    fake.setItem('varanda.postLink', raw)
    t.is(mod.takePostLink(T0), null, raw)
  }
})

test('capturePostPath: saves a valid post, cleans every post path, leaves others', async (t) => {
  const { capturePostPath } = await load()
  const run = (pathname, { search = '', hash = '', replace } = {}) => {
    const saved = []
    const replaced = []
    const history = {
      state: { s: 1 },
      replaceState: replace || ((state, title, url) => replaced.push({ state, title, url }))
    }
    const out = capturePostPath({ pathname, search, hash }, history, (target) => saved.push(target))
    return { out, saved, replaced }
  }

  let r = run('/publicacao/' + HEX + '/7', { search: '?conta=1', hash: '#token=x' })
  t.alike(r.out, { author: HEX, seq: 7 })
  t.alike(r.saved, [{ author: HEX, seq: 7 }])
  t.alike(r.replaced, [{ state: { s: 1 }, title: '', url: '/?conta=1#token=x' }], 'search and hash kept byte for byte')

  r = run('/p/' + HEX + '/3')
  t.alike(r.saved, [{ author: HEX, seq: 3 }])
  t.is(r.replaced[0].url, '/')

  for (const bad of ['/publicacao/x', '/publicacao/' + HEX + '/0', '/p/policy', '/p/' + HEX + '/1/foto/1']) {
    r = run(bad)
    t.is(r.out, null, bad)
    t.is(r.saved.length, 0, 'nothing saved for ' + bad)
    t.is(r.replaced.length, 1, 'cleaned ' + bad)
  }

  for (const other of ['/', '/g/' + HEX, '/f/' + HEX + '/1', '/publicacao', '/pagina/x']) {
    r = run(other)
    t.is(r.out, null, other)
    t.is(r.saved.length + r.replaced.length, 0, 'left alone ' + other)
  }

  r = run('/publicacao/' + HEX + '/5', { replace: () => { throw new Error('denied') } })
  t.alike(r.out, { author: HEX, seq: 5 }, 'a refused replaceState still keeps the post')
  t.alike(r.saved, [{ author: HEX, seq: 5 }])

  t.is(capturePostPath(null, null, () => t.fail('no save')), null)
  t.is(capturePostPath({ pathname: 42 }, null, () => t.fail('no save')), null)
})

test('postOpeningGate: only a first visit with a post and nothing else pending', async (t) => {
  const { postOpeningGate } = await load()
  const base = { introShow: true, ageReturn: false, inviteOpening: 'none', otherLink: false, post: { author: 'a'.repeat(64), seq: 3 }, dismissed: false }
  t.is(postOpeningGate(base), true)
  t.is(postOpeningGate(), false)
  const flips = [
    { introShow: false },
    { ageReturn: true },
    { inviteOpening: 'card' },
    { inviteOpening: 'wait' },
    { otherLink: true },
    { post: null },
    { post: { author: 'a'.repeat(64), seq: 0 } },
    { post: { author: 'zz', seq: 3 } },
    { dismissed: true }
  ]
  for (const flip of flips) t.is(postOpeningGate({ ...base, ...flip }), false, JSON.stringify(flip))
})
