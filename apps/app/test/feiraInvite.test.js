// Feira entry helpers (src/feiraInvite.js): policy and start shapes. Pure;
// no network.
'use strict'

const test = require('brittle')

const load = () => import('../src/feiraInvite.js')
const A = 'ab'.repeat(32)
const CODE = 'A'.repeat(40) + '_-9'

test('policyUrl and startUrl: the two account routes, same origin or an https origin', async (t) => {
  const { policyUrl, startUrl } = await load()
  t.is(policyUrl(), '/account/feira/policy')
  t.is(startUrl(), '/account/feira/start')
  t.is(policyUrl('https://conta.varanda.app'), 'https://conta.varanda.app/account/feira/policy')
  t.is(startUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/account/feira/start')
  for (const bad of ['http://conta.varanda.app', 'https://conta.varanda.app/', 'https://x/y', 'javascript:alert(1)', 5]) {
    t.is(policyUrl(bad), null, String(bad))
    t.is(startUrl(bad), null, String(bad))
  }
})

test('parsePolicy accepts exactly { enabled: boolean }', async (t) => {
  const { parsePolicy } = await load()
  t.alike(parsePolicy({ enabled: true }), { enabled: true })
  t.alike(parsePolicy({ enabled: false }), { enabled: false })
  const bad = [{ enabled: true, extra: 1 }, { enabled: 'true' }, { enabled: 1 }, {}, { on: true }, null, [], 'x', [true]]
  for (const body of bad) t.is(parsePolicy(body), null, JSON.stringify(body))
  const copy = { enabled: true }
  t.not(parsePolicy(copy), copy, 'a fresh copy')
})

test('startBody is exactly { author, seq }', async (t) => {
  const { startBody } = await load()
  t.alike(startBody({ author: A, seq: 3 }), { author: A, seq: 3 })
  t.alike(Object.keys(startBody({ author: A.toUpperCase(), seq: 3, extra: 'x' })), ['author', 'seq'], 'extra input keys are not copied')
  t.is(startBody({ author: A.toUpperCase(), seq: 3 }).author, A, 'lowercased')
  for (const bad of [{ author: A, seq: 0 }, { author: A, seq: 1.5 }, { author: A, seq: '3' }, { author: 'ab', seq: 3 }, { author: A + ':3', seq: 3 }, { seq: 3 }, {}]) {
    t.is(startBody(bad), null, JSON.stringify(bad))
  }
  t.is(startBody(), null)
})

test('parseStart takes only { code } matching CODE_RE', async (t) => {
  const { parseStart, CODE_RE } = await load()
  t.ok(CODE_RE.test(CODE))
  t.is(parseStart({ code: CODE }), CODE)
  const bad = [{ code: CODE, extra: 1 }, { code: CODE + 'x' }, { code: CODE.slice(1) }, { code: 'A'.repeat(42) + '=' }, { code: 5 }, {}, null]
  for (const body of bad) t.is(parseStart(body), null, JSON.stringify(body))
})
