'use strict'

// src/discoverHosted.js: the native app's reading of the installation's
// /varanda.json, with the hosted web page's rules.
const test = require('brittle')

const ASSOC = 'ab'.repeat(32)
const ORIGIN = 'https://varanda.example'
const load = () => import('../src/discoverHosted.js')
const ok = (text, extra = {}) => ({ kind: 'response', status: 200, contentType: 'application/json', text, redirected: false, ...extra })

test('a valid answer gives the hosted configuration of the installation', async (t) => {
  const { discoverHosted } = await load()
  const config = discoverHosted(ok(JSON.stringify({ v: 1, association: ASSOC })), { installation: ORIGIN })
  t.alike(config, {
    kind: 'hosted',
    installationUrl: ORIGIN,
    association: ASSOC,
    seederUrl: 'wss://varanda.example/seeder',
    rpId: 'varanda.example'
  })
})

test('an answer that is not a configuration is refused', async (t) => {
  const { discoverHosted, hostedOutcome, MAX_DISCOVERY_BYTES } = await load()
  const opts = { installation: ORIGIN }
  const cases = [
    ['version', ok(JSON.stringify({ v: 2, association: ASSOC }))],
    ['short key', ok(JSON.stringify({ v: 1, association: 'ab' }))],
    ['not json', ok('<html></html>')],
    ['html type', ok(JSON.stringify({ v: 1, association: ASSOC }), { contentType: 'text/html' })],
    ['404', ok('', { status: 404 })],
    ['array', ok('[]')],
    ['oversized flag', ok('', { oversized: true })],
    ['oversized text', ok(JSON.stringify({ v: 1, association: ASSOC, pad: 'x'.repeat(MAX_DISCOVERY_BYTES) }))],
    ['invalid utf-8', ok('', { invalidText: true })]
  ]
  for (const [name, result] of cases) {
    t.is(discoverHosted(result, opts), null, name)
    t.is(hostedOutcome(result, opts).verdict, 'invalid', name)
  }
})

test('no answer is a transport failure, never a configuration', async (t) => {
  const { discoverHosted, hostedOutcome } = await load()
  const opts = { installation: ORIGIN }
  for (const result of [{ kind: 'threw' }, ok('', { status: 503 }), ok('', { status: 429 }), ok('', { redirected: true }), null]) {
    t.is(discoverHosted(result, opts), null)
    t.is(hostedOutcome(result, opts).verdict, 'transport')
  }
})

test('an installation that is not a canonical https origin gives nothing', async (t) => {
  const { discoverHosted } = await load()
  const body = ok(JSON.stringify({ v: 1, association: ASSOC }))
  for (const installation of [undefined, null, 'http://varanda.example', 'https://Varanda.example', 'https://varanda.example/x', 'https://127.0.0.1']) {
    t.is(discoverHosted(body, { installation }), null, String(installation))
  }
})

test('an answer from anywhere but the installation\'s /varanda.json is a redirect', async (t) => {
  const { redirectedAway } = await load()
  const opts = { installation: ORIGIN }
  t.is(redirectedAway({ redirected: false, url: ORIGIN + '/varanda.json' }, opts), false, 'same origin and path')
  t.is(redirectedAway({ url: '' }, opts), false, 'an engine that reports no url')
  t.is(redirectedAway({}, opts), false)
  t.is(redirectedAway({ redirected: true, url: ORIGIN + '/varanda.json' }, opts), true, 'redirected flag')
  t.is(redirectedAway({ url: 'https://evil.example/varanda.json' }, opts), true, 'cross origin')
  t.is(redirectedAway({ url: 'http://varanda.example/varanda.json' }, opts), true, 'cleartext')
  t.is(redirectedAway({ url: ORIGIN + '/index.html' }, opts), true, 'another path')
  t.is(redirectedAway({ url: ORIGIN + '/varanda.json?x=1' }, opts), true, 'a query')
  t.is(redirectedAway({ url: 'not a url' }, opts), true, 'malformed url')
})

test('a remembered answer is used only for the same installation', async (t) => {
  const { rememberedHosted } = await load()
  const stored = { v: 1, origin: ORIGIN, association: ASSOC }
  t.is(rememberedHosted(stored, { installation: ORIGIN }).seederUrl, 'wss://varanda.example/seeder')
  t.is(rememberedHosted(stored, { installation: 'https://other.example' }), null)
  t.is(rememberedHosted({ ...stored, association: 'zz' }, { installation: ORIGIN }), null)
  t.is(rememberedHosted({ ...stored, v: 2 }, { installation: ORIGIN }), null)
  t.is(rememberedHosted(null, { installation: ORIGIN }), null)
})
