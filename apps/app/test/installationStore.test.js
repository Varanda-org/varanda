'use strict'

// src/configStore.native.js (the saved installation address) and
// src/cryptoPolyfill.native.js with expo-file-system and expo-crypto replaced
// by in-memory stubs. Metro resolves the extensionless relative imports of
// these native modules; the hook below does the same for Node.
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
    // Like the real one: truncates in place, then fails part way.
    if (globalThis.__stubWriteFails) { files.set(this.uri, String(text).slice(0, 5)); throw new Error('disk full') }
    files.set(this.uri, String(text))
  }
  async text () { if (!files.has(this.uri)) throw new Error('missing'); return files.get(this.uri) }
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
const expoCrypto = `
export function getRandomValues (array) { return globalThis.__stubRandom(array) }
`
const hooks = `
const stubs = {
  'expo-file-system': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fileSystem)}),
  'expo-crypto': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(expoCrypto)})
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

const CONFIG = 'file:///stub/Documents/varanda-config.json'
const INSTALLATION = 'file:///stub/Documents/varanda-installation.json'

const files = () => globalThis.__stubFiles
const load = async () => ({
  store: await import('../src/configStore.native.js'),
  installation: await import('../src/installation.js'),
  appClient: await import('../src/appClient.js')
})

async function reset () {
  const { installation, appClient } = await load()
  files().clear()
  installation.setInstallation(null)
  appClient.setAppClient(false)
  delete process.env.EXPO_PUBLIC_VARANDA_INSTALLATION
  globalThis.__stubWriteFails = false
  globalThis.__stubMoveFails = null
}

test('no saved installation and no build-time value: null, app flag off', async (t) => {
  const { store, installation, appClient } = await load()
  await reset()
  t.is(await store.loadInstallation(), null)
  t.is(installation.installationOrigin(), null)
  t.is(appClient.isAppClient(), false)
  t.is(installation.resolveUrl('/account/status'), '/account/status')
})

test('save writes its own file, never the core config, and load reads it back', async (t) => {
  const { store, installation, appClient } = await load()
  await reset()
  t.is(await store.saveInstallation('https://example.test/'), true)
  t.is(files().has(CONFIG), false, 'varanda-config.json untouched')
  t.alike(JSON.parse(files().get(INSTALLATION)), { v: 1, origin: 'https://example.test' })
  t.is(appClient.isAppClient(), true)

  installation.setInstallation(null)
  appClient.setAppClient(false)
  t.is(await store.loadInstallation(), 'https://example.test')
  t.is(installation.installationOrigin(), 'https://example.test')
  t.is(appClient.isAppClient(), true)
  t.is(installation.resolveUrl('/index/search/ab'), 'https://example.test/index/search/ab')
  t.is(await store.loadConfig(), null, 'no core config appears')
  await reset()
})

test('save refuses an invalid origin and changes nothing', async (t) => {
  const { store, installation, appClient } = await load()
  await reset()
  t.is(await store.saveInstallation('https://example.test'), true)
  for (const bad of ['http://example.test', 'https://example.test/x', 'https://u:p@example.test',
    'https://Example.test', 'javascript:alert(1)', '', 'example.test', 42, undefined, {}]) {
    t.is(await store.saveInstallation(bad), false, JSON.stringify(bad))
  }
  t.is(installation.installationOrigin(), 'https://example.test')
  t.alike(JSON.parse(files().get(INSTALLATION)), { v: 1, origin: 'https://example.test' })
  t.is(appClient.isAppClient(), true)
  await reset()
})

test('a failed write keeps the previous installation', async (t) => {
  const { store, installation } = await load()
  await reset()
  await store.saveInstallation('https://one.test')
  globalThis.__stubWriteFails = true
  await t.exception(store.saveInstallation('https://two.test'), /disk full/)
  t.is(installation.installationOrigin(), 'https://one.test')
  t.alike(JSON.parse(files().get(INSTALLATION)), { v: 1, origin: 'https://one.test' }, 'the saved file survives a write failing mid-way')
  t.alike([...files().keys()], [INSTALLATION], 'no temporary file is left behind')

  installation.setInstallation(null)
  t.is(await store.loadInstallation(), 'https://one.test', 'the next launch still has it')
  await reset()
})

test('a failed replace keeps the old file; a later save succeeds', async (t) => {
  const { store, installation } = await load()
  await reset()
  await store.saveInstallation('https://one.test')
  globalThis.__stubMoveFails = (from, to) => from.endsWith('.tmp') && to === INSTALLATION
  await t.exception(store.saveInstallation('https://two.test'), /move failed/)
  t.is(installation.installationOrigin(), 'https://one.test')
  t.alike([...files().keys()], [INSTALLATION])
  t.alike(JSON.parse(files().get(INSTALLATION)), { v: 1, origin: 'https://one.test' })

  globalThis.__stubMoveFails = null
  t.is(await store.saveInstallation('https://two.test'), true)
  t.alike([...files().keys()], [INSTALLATION])
  t.alike(JSON.parse(files().get(INSTALLATION)), { v: 1, origin: 'https://two.test' })
  await reset()
})

test('interrupted between the moves, the set-aside file still loads', async (t) => {
  const { store } = await load()
  await reset()
  files().set(INSTALLATION + '.bak', JSON.stringify({ v: 1, origin: 'https://one.test' }))
  files().set(INSTALLATION + '.tmp', '{"v":1,"origin":"https://tw')
  t.is(await store.loadInstallation(), 'https://one.test')
  t.is(await store.saveInstallation('https://two.test'), true)
  t.alike([...files().keys()], [INSTALLATION], 'stale files cleaned up')
  t.alike(JSON.parse(files().get(INSTALLATION)), { v: 1, origin: 'https://two.test' })
  await reset()
})

test('a malformed or hand-edited file is ignored', async (t) => {
  const { store, installation, appClient } = await load()
  for (const text of ['{', 'null', '[]', '{"v":2,"origin":"https://example.test"}', '{"v":1}',
    '{"v":1,"origin":"http://evil.test"}', '{"v":1,"origin":"https://example.test/path"}']) {
    await reset()
    files().set(INSTALLATION, text)
    t.is(await store.loadInstallation(), null, text)
    t.is(installation.installationOrigin(), null)
    t.is(appClient.isAppClient(), false)
  }
  await reset()
})

test('the build-time value is the fallback; empty or invalid means none', async (t) => {
  const { store, installation, appClient } = await load()
  await reset()
  process.env.EXPO_PUBLIC_VARANDA_INSTALLATION = 'https://built.test'
  t.is(await store.loadInstallation(), 'https://built.test')
  t.is(appClient.isAppClient(), true)

  await reset()
  process.env.EXPO_PUBLIC_VARANDA_INSTALLATION = 'https://built.test'
  files().set(INSTALLATION, JSON.stringify({ v: 1, origin: 'https://saved.test' }))
  t.is(await store.loadInstallation(), 'https://saved.test', 'the saved choice wins')

  for (const value of ['', 'http://built.test', 'not a url']) {
    await reset()
    process.env.EXPO_PUBLIC_VARANDA_INSTALLATION = value
    t.is(await store.loadInstallation(), null, JSON.stringify(value))
    t.is(installation.installationOrigin(), null)
    t.is(appClient.isAppClient(), false)
  }
  await reset()
})

test('saving null forgets the choice and falls back to the build-time value', async (t) => {
  const { store, installation, appClient } = await load()
  await reset()
  await store.saveInstallation('https://saved.test')
  t.is(await store.saveInstallation(null), true)
  t.is(files().has(INSTALLATION), false)
  t.is(installation.installationOrigin(), null)
  t.is(appClient.isAppClient(), false)

  process.env.EXPO_PUBLIC_VARANDA_INSTALLATION = 'https://built.test'
  await store.saveInstallation('https://saved.test')
  await store.saveInstallation(null)
  t.is(installation.installationOrigin(), 'https://built.test')
  await reset()
})

// Discovery reads <installation>/varanda.json through a stubbed fetch: the
// tests never reach a network.
test('discovery on native asks the installation, never the network in tests', async (t) => {
  const { store } = await load()
  const realFetch = globalThis.fetch
  const asked = []
  try {
    await reset()
    t.is(await store.discoverConfig(), null, 'no installation, no discovery')

    await store.saveInstallation('https://example.test')
    globalThis.fetch = async (url, init) => {
      asked.push({ url, credentials: init && init.credentials, cache: init && init.cache })
      throw new Error('offline')
    }
    const statuses = []
    t.is(await store.discoverConfig({ onStatus: (s) => statuses.push(s.source) }), null)
    // No cache mode: React Native's fetch would append ?_=<time> for no-store.
    t.alike(asked, [{ url: 'https://example.test/varanda.json', credentials: 'omit', cache: undefined }])
    t.alike(statuses, ['none'])
    t.is(store.hostedPage, false)

    const association = 'ab'.repeat(32)
    globalThis.fetch = async () => ({
      status: 200,
      redirected: false,
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ v: 1, association })
    })
    const config = await store.discoverConfig({ onStatus: (s) => statuses.push(s.source) })
    t.is(config && config.kind, 'hosted')
    t.is(config && config.association, association)
    t.is(config && config.seederUrl, 'wss://example.test/seeder')
    t.is(statuses[statuses.length - 1], 'live')
  } finally {
    globalThis.fetch = realFetch
    await reset()
  }
})

const ASSOC_A = 'ab'.repeat(32)
const ASSOC_B = 'cd'.repeat(32)
const jsonAnswer = (association, url) => async () => ({
  status: 200,
  redirected: false,
  url,
  headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify({ v: 1, association })
})
const stored = () => JSON.parse(files().get(INSTALLATION))

test('discovery: a redirect is never remembered and keeps the remembered answer', async (t) => {
  const { store } = await load()
  const realFetch = globalThis.fetch
  try {
    await reset()
    await store.saveInstallation('https://example.test')
    globalThis.fetch = jsonAnswer(ASSOC_A, 'https://example.test/varanda.json')
    t.is((await store.discoverConfig()).association, ASSOC_A, 'same-origin url accepted')
    t.is(stored().discovered.association, ASSOC_A)

    for (const url of ['https://evil.test/varanda.json', 'https://example.test/other.json', 'not a url']) {
      globalThis.fetch = jsonAnswer(ASSOC_B, url)
      const statuses = []
      const config = await store.discoverConfig({ onStatus: (s) => statuses.push(s.source) })
      t.is(config && config.association, ASSOC_A, url + ': the remembered answer stands in')
      t.alike(statuses, ['remembered'], url)
      t.is(stored().discovered.association, ASSOC_A, url + ': not remembered')
    }

    // A redirect to HTML is a redirect too: the remembered answer is kept.
    globalThis.fetch = async () => ({
      status: 200,
      redirected: false,
      url: 'https://example.test/index.html',
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => '<html></html>'
    })
    t.is((await store.discoverConfig()).association, ASSOC_A)
    t.is(stored().discovered.association, ASSOC_A)
  } finally {
    globalThis.fetch = realFetch
    await reset()
  }
})

test('saving the same installation keeps its remembered answer; another drops it', async (t) => {
  const { store } = await load()
  const realFetch = globalThis.fetch
  try {
    await reset()
    await store.saveInstallation('https://a.test')
    globalThis.fetch = jsonAnswer(ASSOC_A, 'https://a.test/varanda.json')
    await store.discoverConfig()
    t.is(stored().discovered.association, ASSOC_A)

    t.is(await store.saveInstallation('https://a.test'), true)
    t.is(stored().discovered.association, ASSOC_A, 'same origin: kept')
    globalThis.fetch = async () => { throw new Error('offline') }
    t.is((await store.discoverConfig()).association, ASSOC_A, 'still usable offline')

    t.is(await store.saveInstallation('https://b.test'), true)
    t.alike(stored(), { v: 1, origin: 'https://b.test' }, 'another origin: dropped')
    t.is(await store.discoverConfig(), null)
  } finally {
    globalThis.fetch = realFetch
    await reset()
  }
})

test('crypto polyfill: installs only when missing, Web Crypto contract', async (t) => {
  const calls = []
  globalThis.__stubRandom = (array) => {
    calls.push(array.byteLength)
    for (let i = 0; i < array.length; i++) array[i] = 0xab
    return array
  }
  const { installGetRandomValues } = await import('../src/cryptoPolyfill.native.js')
  t.ok(typeof globalThis.crypto.getRandomValues === 'function', 'the global one is kept')

  const existing = { getRandomValues: () => 'mine' }
  t.is(installGetRandomValues({ crypto: existing }, globalThis.__stubRandom), false)
  t.is(existing.getRandomValues(), 'mine', 'never clobbered')

  const subtle = {}
  const keep = { subtle }
  const scope = { crypto: keep }
  t.is(installGetRandomValues(scope, globalThis.__stubRandom), true)
  t.is(scope.crypto, keep, 'the existing crypto object is kept')
  t.is(scope.crypto.subtle, subtle)

  const bare = {}
  t.is(installGetRandomValues(bare, globalThis.__stubRandom), true)
  const a = new Uint32Array(4)
  t.is(bare.crypto.getRandomValues(a), a, 'returns the same array')
  t.is(a[0], 0xabababab, 'every byte of a wider element is filled')
  const backing = new Uint8Array(8)
  const view = new Uint8Array(backing.buffer, 2, 4)
  bare.crypto.getRandomValues(view)
  t.alike([...backing], [0, 0, 0xab, 0xab, 0xab, 0xab, 0, 0], 'only the view is filled')
  t.ok(bare.crypto.getRandomValues(new Uint8Array(65536)), '65536 bytes allowed')
  t.exception.all(() => bare.crypto.getRandomValues(new Uint8Array(65537)), /65536/)
  t.exception.all(() => bare.crypto.getRandomValues(new Float64Array(2)), /integer/)
  t.exception.all(() => bare.crypto.getRandomValues([1, 2]), /integer/)
  t.exception.all(() => bare.crypto.getRandomValues(new DataView(new ArrayBuffer(4))), /integer/)

  const broken = {}
  installGetRandomValues(broken, () => undefined)
  t.exception(() => broken.crypto.getRandomValues(new Uint8Array(4)), /no random source/)
  t.ok(calls.length > 0)
})
