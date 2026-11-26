'use strict'

// src/configStore.web.js discoverConfig on a hosted page: preferRemembered
// returns the remembered association of this origin at once and revalidates in
// the background. location, localStorage and fetch are stubbed; no network.
const test = require('brittle')
const { register } = require('module')

// The sources import their siblings without an extension (Metro style): map
// relative extensionless specifiers to .js for Node.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve (specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) specifier += '.js'
  return next(specifier, context)
}`))

const ASSOC = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const DISCOVERED_KEY = 'varanda-web-discovered'

const store = new Map()
globalThis.location = { protocol: 'https:', host: 'bora.varanda.app', hostname: 'bora.varanda.app', origin: ORIGIN, hash: '' }
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) }
}

let fetchImpl
globalThis.fetch = (...args) => fetchImpl(...args)

const answer = (body, { status = 200, contentType = 'application/json' } = {}) => async () => ({
  status,
  redirected: false,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  body: null,
  text: async () => body
})
const liveJson = (association) => answer(JSON.stringify({ v: 1, association }))
const remember = (association, origin = ORIGIN) => store.set(DISCOVERED_KEY, JSON.stringify({ v: 1, origin, association }))
const remembered = () => JSON.parse(store.get(DISCOVERED_KEY) || 'null')
const load = () => import('../src/configStore.web.js')

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

test('remembered first: resolves before the fetch settles, then reports same', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC)
  const gate = deferred()
  fetchImpl = async (...args) => { await gate.promise; return liveJson(ASSOC)(...args) }
  const statuses = []
  const verdict = deferred()
  const config = await discoverConfig({ preferRemembered: true, onStatus: (s) => statuses.push(s), onRevalidated: verdict.resolve })
  t.is(config.association, ASSOC)
  t.is(config.seederUrl, 'wss://bora.varanda.app/seeder')
  t.alike(statuses, [{ source: 'remembered' }])
  gate.resolve()
  t.alike(await verdict.promise, { verdict: 'same' })
})

test('a changed association reports changed with the config and is remembered', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC)
  fetchImpl = liveJson(OTHER)
  const verdict = deferred()
  const config = await discoverConfig({ preferRemembered: true, onRevalidated: verdict.resolve })
  t.is(config.association, ASSOC)
  const result = await verdict.promise
  t.is(result.verdict, 'changed')
  t.is(result.config.association, OTHER)
  t.is(remembered().association, OTHER)
})

test('bad JSON reports invalid and forgets the remembered record', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC)
  fetchImpl = answer('not json')
  const verdict = deferred()
  const config = await discoverConfig({ preferRemembered: true, onRevalidated: verdict.resolve })
  t.is(config.association, ASSOC)
  t.alike(await verdict.promise, { verdict: 'invalid' })
  t.is(store.has(DISCOVERED_KEY), false)
})

test('a network error reports transport and keeps the remembered config', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC)
  fetchImpl = async () => { throw new Error('offline') }
  const verdict = deferred()
  const config = await discoverConfig({ preferRemembered: true, onRevalidated: verdict.resolve })
  t.is(config.association, ASSOC)
  t.alike(await verdict.promise, { verdict: 'transport' })
  t.is(remembered().association, ASSOC)
})

test('with nothing remembered the live path runs and onRevalidated is never called', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  fetchImpl = liveJson(ASSOC)
  let called = 0
  const statuses = []
  const config = await discoverConfig({ preferRemembered: true, onStatus: (s) => statuses.push(s), onRevalidated: () => { called++ } })
  t.is(config.association, ASSOC)
  t.alike(statuses, [{ source: 'live', persisted: true }])
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.is(called, 0)
})

test('a record of another origin is ignored', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC, 'https://evil.example')
  fetchImpl = liveJson(OTHER)
  let called = 0
  const config = await discoverConfig({ preferRemembered: true, onRevalidated: () => { called++ } })
  t.is(config.association, OTHER, 'the live answer, not the foreign record')
  t.is(called, 0)
})

test('a stale discovery reports nothing and writes nothing', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC)
  const gate = deferred()
  fetchImpl = async (...args) => { await gate.promise; return liveJson(OTHER)(...args) }
  let stale = 0
  await discoverConfig({ preferRemembered: true, onRevalidated: () => { stale++ } })
  fetchImpl = liveJson(ASSOC)
  const verdict = deferred()
  await discoverConfig({ preferRemembered: true, onRevalidated: verdict.resolve })
  t.alike(await verdict.promise, { verdict: 'same' })
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(stale, 0)
  t.is(remembered().association, ASSOC, 'the older answer did not replace the newer record')
})

test('without preferRemembered the live answer is awaited as before', async (t) => {
  const { discoverConfig } = await load()
  store.clear()
  remember(ASSOC)
  fetchImpl = liveJson(OTHER)
  const config = await discoverConfig({})
  t.is(config.association, OTHER)
})
