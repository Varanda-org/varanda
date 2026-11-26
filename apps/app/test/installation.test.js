'use strict'

// The installation origin (src/installation.js). It is an ES module bundled
// by Metro; import() loads it here through Node's module syntax detection.
const test = require('brittle')
const { register } = require('module')

// configStore.web.js imports its siblings without an extension (Metro style).
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve (specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) specifier += '.js'
  return next(specifier, context)
}`))

test('setInstallation accepts an https origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(installationOrigin(), 'https://example.test')
    // A default port is not part of the origin.
    t.is(setInstallation('https://example.test:443'), true)
    t.is(installationOrigin(), 'https://example.test')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation drops a trailing slash', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test/'), true)
    t.is(installationOrigin(), 'https://example.test')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation refuses a value that is not an installation origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    const refused = [
      'http://example.test',
      'https://ada:secret@example.test',
      'https://example.test/a',
      'https://example.test?q=1',
      'https://example.test#top',
      'https://Example.test',
      42,
      ''
    ]
    for (const value of refused) {
      t.is(setInstallation(value), false, 'refuses ' + JSON.stringify(value))
      t.is(installationOrigin(), 'https://example.test', 'keeps origin after ' + JSON.stringify(value))
    }
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation accepts http on localhost and 127.0.0.1', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('http://localhost:8080'), true)
    t.is(installationOrigin(), 'http://localhost:8080')
    t.is(setInstallation('http://127.0.0.1:8080'), true)
    t.is(installationOrigin(), 'http://127.0.0.1:8080')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation(null) clears the origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(setInstallation(null), true)
    t.is(installationOrigin(), null)
    t.is(setInstallation(null), true)
    t.is(installationOrigin(), null)
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation is idempotent', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(setInstallation('https://example.test'), true)
    t.is(installationOrigin(), 'https://example.test')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('resolveUrl returns the path when no installation is set', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin, resolveUrl } = await load()
  t.is(setInstallation(null), true)
  t.is(installationOrigin(), null)
  t.is(resolveUrl('/account/start'), '/account/start')
  t.is(resolveUrl('/index/search?q=a%20b'), '/index/search?q=a%20b')
  for (const path of ['x', '//evil.test/a', 42, '/\\evil.test/a', '/\t/evil.test/a', '/\n/evil.test', '/a b']) {
    let err = null
    try { resolveUrl(path) } catch (e) { err = e }
    t.is(err instanceof TypeError, true, 'TypeError for ' + JSON.stringify(path))
  }
})

test('resolveUrl prefixes the installation origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, resolveUrl } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(resolveUrl('/account/start'), 'https://example.test/account/start')
    t.is(resolveUrl('/'), 'https://example.test/')
    for (const path of ['x', '//evil.test/a', 42, '/\\evil.test/a', '/\t/evil.test/a']) {
      let err = null
      try { resolveUrl(path) } catch (e) { err = e }
      t.is(err instanceof TypeError, true, 'TypeError for ' + JSON.stringify(path))
    }
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('rpIdOf is the host, without a port', async (t) => {
  const load = () => import('../src/installation.js')
  const { rpIdOf } = await load()
  t.is(rpIdOf('https://example.test'), 'example.test')
  t.is(rpIdOf('https://example.test:8443'), 'example.test')
  t.is(rpIdOf('http://localhost:8080'), 'localhost')
  t.is(rpIdOf('https://Example.TEST'), 'example.test')
})

test('rpIdOf refuses an IP literal and a bad character', async (t) => {
  const load = () => import('../src/installation.js')
  const { rpIdOf } = await load()
  for (const origin of ['https://127.0.0.1', 'https://[::1]', 'https://bad_host.test']) {
    let err = null
    try { rpIdOf(origin) } catch (e) { err = e }
    t.is(err instanceof TypeError, true, 'TypeError for ' + origin)
  }
})

test('hostOf keeps a non-default port', async (t) => {
  const load = () => import('../src/installation.js')
  const { hostOf } = await load()
  t.is(hostOf('https://example.test'), 'example.test')
  t.is(hostOf('https://example.test:8443'), 'example.test:8443')
  t.is(hostOf('http://localhost:8080'), 'localhost:8080')
  let err = null
  try { hostOf('https://example.test/a') } catch (e) { err = e }
  t.is(err instanceof TypeError, true)
})

test('mediaOrigin is memory only: valid origins are kept, anything else clears it', async (t) => {
  const { mediaOrigin, setMediaOrigin } = await import('../src/installation.js')
  try {
    t.is(mediaOrigin(), null, 'off by default')
    t.is(setMediaOrigin('https://cdn.example'), true)
    t.is(mediaOrigin(), 'https://cdn.example')
    t.is(setMediaOrigin('https://cdn.example/'), true)
    t.is(mediaOrigin(), 'https://cdn.example', 'the bare slash is dropped')
    for (const value of ['http://cdn.example', 'https://cdn.example/x', 'https://cdn.example/?q', 'https://u:p@cdn.example',
      'https://CDN.example', 'https://cdn.example:443', undefined, null, 5, {}]) {
      t.is(setMediaOrigin('https://cdn.example'), true)
      t.is(setMediaOrigin(value), false, 'refused: ' + JSON.stringify(value))
      t.is(mediaOrigin(), null, 'cleared by ' + JSON.stringify(value))
    }
  } finally {
    setMediaOrigin(null)
  }
})

test('mediaOrigin refuses what the build and service worker regex refuses, even from a lax URL parser', async (t) => {
  const { mediaOrigin, setMediaOrigin, validMediaOrigin } = await import('../src/installation.js')
  const Real = globalThis.URL
  // A parser that keeps the host as written, like some native polyfills:
  // raw non-ASCII, a zero-width space or a soft hyphen survive in origin.
  class Lax {
    constructor (text) {
      const m = /^(https|http):\/\/([^/?#@]*)(\/)?$/.exec(String(text))
      if (m === null) return new Real(text)
      this.protocol = m[1] + ':'
      this.host = m[2]
      this.hostname = m[2].replace(/:[0-9]*$/, '').replace(/^\[|\]$/g, '')
      this.origin = this.protocol + '//' + this.host
      this.username = ''
      this.password = ''
      this.pathname = m[3] || ''
      this.search = ''
      this.hash = ''
    }
  }
  try {
    for (const lax of [false, true]) {
      globalThis.URL = lax ? Lax : Real
      const tag = lax ? ' (lax parser)' : ''
      for (const ok of ['https://cdn.example', 'https://a-b.cdn.example', 'https://cdn.example:8443', 'https://cdn.example:1', 'https://cdn.example:65535']) {
        t.is(validMediaOrigin(ok), ok, 'kept: ' + ok + tag)
      }
      for (const bad of [
        'https://cdn.exämple', 'https://cdn.exa​mple', 'https://cdn.exa­mple', 'https://cдn.example',
        'https://cdn.example:0', 'https://cdn.example:65536', 'https://cdn.example:99999',
        'https://127.0.0.1', 'https://10.0.0.1:8443', 'https://[::1]', 'https://[2001:db8::1]:8443',
        'https://localhost', 'https://localhost:8443', 'https://edge.localhost',
        'https://-cdn.example', 'https://cdn-.example', 'https://cdn..example', 'https://cdn.example.', 'https://cdn_x.example'
      ]) {
        t.is(validMediaOrigin(bad), null, 'refused: ' + JSON.stringify(bad) + tag)
        t.is(setMediaOrigin(bad), false)
        t.is(mediaOrigin(), null)
      }
    }
  } finally {
    globalThis.URL = Real
    setMediaOrigin(null)
  }
})

test('choosing another installation drops the media origin', async (t) => {
  const { mediaOrigin, setMediaOrigin, setInstallation } = await import('../src/installation.js')
  try {
    t.is(setInstallation('https://one.test'), true)
    setMediaOrigin('https://cdn.example')
    t.is(setInstallation('https://one.test'), true)
    t.is(mediaOrigin(), 'https://cdn.example', 'the same installation keeps it')
    t.is(setInstallation('http://evil'), false)
    t.is(mediaOrigin(), 'https://cdn.example', 'a refused value changes nothing')
    t.is(setInstallation('https://two.test'), true)
    t.is(mediaOrigin(), null)
    setMediaOrigin('https://cdn.example')
    t.is(setInstallation(null), true)
    t.is(mediaOrigin(), null)
  } finally {
    setInstallation(null)
    setMediaOrigin(null)
  }
})

test('web discovery sets the media origin from each live answer and never remembers it', async (t) => {
  const ASSOC = 'ab'.repeat(32)
  const ORIGIN = 'https://bora.varanda.app'
  const store = new Map()
  globalThis.location = { protocol: 'https:', host: 'bora.varanda.app', hostname: 'bora.varanda.app', origin: ORIGIN, hash: '' }
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) }
  }
  const answer = (body) => async () => ({
    status: 200,
    redirected: false,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    body: null,
    text: async () => body
  })
  const { discoverConfig } = await import('../src/configStore.web.js')
  const { mediaOrigin, setMediaOrigin } = await import('../src/installation.js')
  const record = () => JSON.parse(store.get('varanda-web-discovered'))
  try {
    globalThis.fetch = answer(JSON.stringify({ v: 1, association: ASSOC, media: 'https://cdn.example' }))
    const config = await discoverConfig({})
    t.is(config.media, 'https://cdn.example')
    t.is(mediaOrigin(), 'https://cdn.example')
    t.alike(record(), { v: 1, origin: ORIGIN, association: ASSOC }, 'the record is only v, origin and association')

    globalThis.fetch = answer(JSON.stringify({ v: 1, association: ASSOC }))
    await discoverConfig({})
    t.is(mediaOrigin(), null, 'no media key: today\'s behaviour')

    globalThis.fetch = answer(JSON.stringify({ v: 1, association: ASSOC, media: 'https://cdn.example/path' }))
    setMediaOrigin('https://old.example')
    const ignored = await discoverConfig({})
    t.is('media' in ignored, false)
    t.is(mediaOrigin(), null, 'an invalid origin clears the old one')

    setMediaOrigin('https://old.example')
    globalThis.fetch = answer('not json')
    t.is(await discoverConfig({}), null)
    t.is(mediaOrigin(), null, 'an invalid answer clears it')

    globalThis.fetch = answer(JSON.stringify({ v: 1, association: ASSOC, media: 'https://cdn.example' }))
    await discoverConfig({})
    globalThis.fetch = async () => { throw new Error('offline') }
    const fromMemory = await discoverConfig({})
    t.is(fromMemory.association, ASSOC)
    t.is('media' in fromMemory, false, 'the remembered answer carries no media')
    t.is(mediaOrigin(), 'https://cdn.example', 'a transport failure keeps the live one')
  } finally {
    setMediaOrigin(null)
  }
})

test('web discovery: a live answer is applied unless a newer live answer already was, whatever happened in between', async (t) => {
  const ASSOC = 'ab'.repeat(32)
  const store = new Map()
  globalThis.location = { protocol: 'https:', host: 'bora.varanda.app', hostname: 'bora.varanda.app', origin: 'https://bora.varanda.app', hash: '' }
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) }
  }
  const reply = (body) => ({
    status: 200,
    redirected: false,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    body: null,
    text: async () => body
  })
  const withMedia = (media) => reply(JSON.stringify(media ? { v: 1, association: ASSOC, media } : { v: 1, association: ASSOC }))
  const { discoverConfig } = await import('../src/configStore.web.js')
  const { mediaOrigin, setMediaOrigin } = await import('../src/installation.js')
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const deferred = () => {
    let settle
    const promise = new Promise((resolve) => { settle = resolve })
    return { promise, resolve: settle }
  }
  try {
    // A is slow and answers without media; B started later and failed in transport.
    setMediaOrigin('https://old.example')
    const a = deferred()
    globalThis.fetch = () => a.promise
    const pa = discoverConfig({})
    await tick()
    globalThis.fetch = async () => { throw new Error('offline') }
    await discoverConfig({})
    t.is(mediaOrigin(), 'https://old.example', 'a transport failure changes nothing')
    a.resolve(withMedia(null))
    await pa
    t.is(mediaOrigin(), null, 'the late live answer without media is not lost')

    // The same with an answer that names one.
    const a2 = deferred()
    globalThis.fetch = () => a2.promise
    const pa2 = discoverConfig({})
    await tick()
    globalThis.fetch = async () => { throw new Error('offline') }
    await discoverConfig({})
    a2.resolve(withMedia('https://cdn.example'))
    await pa2
    t.is(mediaOrigin(), 'https://cdn.example', 'and a late live answer with media is kept')

    // An older live answer never undoes a newer one.
    const slow = deferred()
    globalThis.fetch = () => slow.promise
    const old = discoverConfig({})
    await tick()
    globalThis.fetch = async () => withMedia('https://new.example')
    await discoverConfig({})
    t.is(mediaOrigin(), 'https://new.example')
    slow.resolve(withMedia('https://stale.example'))
    await old
    t.is(mediaOrigin(), 'https://new.example', 'the older answer, arriving last, is ignored')
  } finally {
    setMediaOrigin(null)
  }
})
