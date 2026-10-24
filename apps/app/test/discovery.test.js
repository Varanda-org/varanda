'use strict'

const test = require('brittle')

const ASSOC = 'ab'.repeat(32)
const load = () => import('../src/discovery.js')
const ok = (json) => ({ config: { association: json.association } })
const res = (over) => ({ kind: 'response', status: 200, contentType: 'application/json', text: JSON.stringify({ v: 1, association: ASSOC }), redirected: false, ...over })

test('discoveryOutcome: transport failures', async (t) => {
  const { discoveryOutcome } = await load()
  t.alike(discoveryOutcome({ kind: 'threw' }, ok), { verdict: 'transport' })
  t.alike(discoveryOutcome(res({ redirected: true }), ok), { verdict: 'transport' })
  for (const status of [408, 429, 500, 503]) t.alike(discoveryOutcome(res({ status }), ok), { verdict: 'transport' }, String(status))
})

test('discoveryOutcome: an answer that is not a configuration is invalid', async (t) => {
  const { discoveryOutcome, MAX_DISCOVERY_BYTES } = await load()
  t.is(discoveryOutcome(res({ status: 404 }), ok).verdict, 'invalid')
  t.is(discoveryOutcome(res({ status: 401 }), ok).verdict, 'invalid')
  t.is(discoveryOutcome(res({ contentType: 'text/html' }), ok).verdict, 'invalid')
  t.is(discoveryOutcome(res({ text: JSON.stringify({ pad: 'x'.repeat(MAX_DISCOVERY_BYTES) }) }), ok).verdict, 'invalid')
  t.is(discoveryOutcome(res({ text: '{' }), ok).verdict, 'invalid')
  t.is(discoveryOutcome(res({ text: '[]' }), ok).verdict, 'invalid')
  t.alike(discoveryOutcome(res(), () => ({ error: 'nope' })), { verdict: 'invalid', error: 'nope' })
})

test('discoveryOutcome: read flags', async (t) => {
  const { discoveryOutcome } = await load()
  t.alike(discoveryOutcome(res({ oversized: true }), ok), { verdict: 'invalid', error: 'size' })
  t.alike(discoveryOutcome(res({ invalidText: true }), ok), { verdict: 'invalid', error: 'text' })
  t.alike(discoveryOutcome(res({ status: 503, oversized: true }), ok), { verdict: 'transport' })
  t.alike(discoveryOutcome(res({ redirected: true, oversized: true }), ok), { verdict: 'transport' })
  t.is(discoveryOutcome(res({ status: 404, text: '' }), ok).verdict, 'invalid')
  t.is(discoveryOutcome(res({ contentType: 'text/html', text: '' }), ok).verdict, 'invalid')
})

test('discoveryOutcome: a valid answer is live', async (t) => {
  const { discoveryOutcome } = await load()
  t.alike(discoveryOutcome(res(), ok), { verdict: 'live', config: { association: ASSOC } })
})

test('rememberedHostedConfig', async (t) => {
  const { rememberedHostedConfig } = await load()
  const origin = 'https://app.example'
  let seen
  const validate = (json) => { seen = json; return { config: { association: json.association } } }
  t.alike(rememberedHostedConfig({ v: 1, origin, association: ASSOC }, { origin }, validate), { association: ASSOC })
  t.is(rememberedHostedConfig({ v: 1, origin: 'https://other.example', association: ASSOC }, { origin }, validate), null)
  t.is(rememberedHostedConfig(null, { origin }, validate), null)
  t.is(rememberedHostedConfig('x', { origin }, validate), null)
  t.is(rememberedHostedConfig({ origin, association: ASSOC }, { origin }, validate), null)
  t.is(rememberedHostedConfig({ v: 1, origin, association: 'zz' }, { origin }, validate), null)
  t.is(rememberedHostedConfig({ v: 1, origin, association: ASSOC }, { origin }, () => ({ error: 'x' })), null)
  rememberedHostedConfig({ v: 1, origin, association: ASSOC, seederUrl: 'wss://evil.example/seeder' }, { origin }, validate)
  t.alike(seen, { v: 1, association: ASSOC })
})
