'use strict'

// apps/cli/lib/account/liveness-tokens.js: the in-memory store that keeps the
// validateLivenessToken away from the device, the disk and the logs.

const test = require('brittle')
const { createLivenessTokens, DEFAULT_TTL_MS, DEFAULT_MAX } = require('../lib/account/liveness-tokens')

const TOKEN = 'vlt_SEGREDO-token-de-teste'
const MEMBER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const DOC = 'doc-1'

function clock (start = 1000) {
  const c = { t: start, now: () => c.t }
  return c
}

test('defaults are 30 minutes and 4096 entries', function (t) {
  t.is(DEFAULT_TTL_MS, 30 * 60 * 1000)
  t.is(DEFAULT_MAX, 4096)
})

test('put then get returns the token for the same documentId', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, DOC, TOKEN)
  t.is(store.get(MEMBER, DOC), TOKEN)
  t.is(store.get(OTHER, DOC), null)
})

test('put replaces the member entry', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, DOC, TOKEN)
  store.put(MEMBER, 'doc-2', 'vlt_second')
  t.is(store.get(MEMBER, DOC), null)
  t.is(store.get(MEMBER, 'doc-2'), 'vlt_second')
  t.is(store.size, 1)
})

test('documentId mismatch returns null and keeps the entry', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, DOC, TOKEN)
  t.is(store.get(MEMBER, 'doc-other'), null)
  t.is(store.get(MEMBER, DOC), TOKEN)
})

test('entries expire at the ttl and are deleted', function (t) {
  const c = clock()
  const store = createLivenessTokens({ now: c.now, ttlMs: 100 })
  store.put(MEMBER, DOC, TOKEN)
  c.t += 99
  t.is(store.get(MEMBER, DOC), TOKEN)
  c.t += 1
  t.is(store.get(MEMBER, DOC), null)
  t.is(store.size, 0)
})

test('drop removes the member entry', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, DOC, TOKEN)
  store.put(OTHER, DOC, 'vlt_other')
  store.drop(MEMBER)
  t.is(store.get(MEMBER, DOC), null)
  t.is(store.get(OTHER, DOC), 'vlt_other')
  store.drop(MEMBER)
  t.is(store.size, 1)
})

test('the oldest entry is evicted at the cap', function (t) {
  const c = clock()
  const store = createLivenessTokens({ now: c.now, max: 2 })
  store.put('m1', DOC, 't1')
  c.t++
  store.put('m2', DOC, 't2')
  c.t++
  store.put('m3', DOC, 't3')
  t.is(store.size, 2)
  t.is(store.get('m1', DOC), null)
  t.is(store.get('m2', DOC), 't2')
  t.is(store.get('m3', DOC), 't3')
})

test('replacing an entry makes it the newest for eviction', function (t) {
  const store = createLivenessTokens({ now: clock().now, max: 2 })
  store.put('m1', DOC, 't1')
  store.put('m2', DOC, 't2')
  store.put('m1', DOC, 't1b')
  store.put('m3', DOC, 't3')
  t.is(store.get('m1', DOC), 't1b')
  t.is(store.get('m2', DOC), null)
  t.is(store.get('m3', DOC), 't3')
})

test('uncertain flag is set and cleared by a new put', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  t.is(store.isUncertain(MEMBER), false)
  store.markUncertain(MEMBER)
  t.is(store.isUncertain(MEMBER), false, 'no entry, nothing to mark')
  store.put(MEMBER, DOC, TOKEN)
  t.is(store.isUncertain(MEMBER), false)
  store.markUncertain(MEMBER)
  t.is(store.isUncertain(MEMBER), true)
  t.is(store.isUncertain(OTHER), false)
  t.is(store.get(MEMBER, DOC), TOKEN, 'marking keeps the token')
  store.put(MEMBER, DOC, 'vlt_new')
  t.is(store.isUncertain(MEMBER), false)
})

test('uncertain flag goes with drop and expiry', function (t) {
  const c = clock()
  const store = createLivenessTokens({ now: c.now, ttlMs: 10 })
  store.put(MEMBER, DOC, TOKEN)
  store.markUncertain(MEMBER)
  store.drop(MEMBER)
  t.is(store.isUncertain(MEMBER), false)
  store.put(MEMBER, DOC, TOKEN)
  store.markUncertain(MEMBER)
  c.t += 10
  t.is(store.isUncertain(MEMBER), false)
})

test('the store serializes to nothing', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, DOC, TOKEN)
  const json = JSON.stringify(store)
  t.absent(json.includes(TOKEN))
  t.absent(json.includes(DOC))
  t.absent(json.includes(MEMBER))
  t.absent(require('util').inspect(store, { depth: 5 }).includes(TOKEN))
})

test('bad arguments throw a TypeError without the value', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  const cases = [
    () => store.put(MEMBER, DOC, { token: TOKEN }),
    () => store.put(MEMBER, DOC, ''),
    () => store.put(TOKEN.length, DOC, TOKEN),
    () => store.put(MEMBER, [TOKEN], TOKEN),
    () => store.put({ m: TOKEN }, DOC, TOKEN),
    () => store.get(MEMBER, { d: TOKEN }),
    () => store.get(null, DOC),
    () => store.drop([TOKEN]),
    () => store.markUncertain({ m: TOKEN }),
    () => store.isUncertain(undefined)
  ]
  for (const fn of cases) {
    let err = null
    try { fn() } catch (e) { err = e }
    t.ok(err instanceof TypeError)
    t.absent(String(err && err.message).includes(TOKEN))
    t.absent(String(err && err.stack).includes(TOKEN))
  }
  t.is(store.size, 0)
})

test('bad options throw a TypeError', function (t) {
  t.exception.all(() => createLivenessTokens({ ttlMs: 0 }), TypeError)
  t.exception.all(() => createLivenessTokens({ max: -1 }), TypeError)
  t.exception.all(() => createLivenessTokens({ max: 1.5 }), TypeError)
  t.exception.all(() => createLivenessTokens({ now: 5 }), TypeError)
  t.ok(createLivenessTokens())
})

test('drop with a documentId removes only an entry for that selfie', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, 'doc-2', 'vlt_newer')
  store.drop(MEMBER, DOC)
  t.is(store.get(MEMBER, 'doc-2'), 'vlt_newer', 'a newer selfie is untouched')
  store.drop(MEMBER, 'doc-2')
  t.is(store.get(MEMBER, 'doc-2'), null)
  t.is(store.size, 0)
  store.drop(MEMBER, DOC)
  t.is(store.size, 0, 'no entry, nothing to drop')
})

test('markUncertain with a documentId marks only an entry for that selfie', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  store.put(MEMBER, 'doc-2', 'vlt_newer')
  store.markUncertain(MEMBER, DOC)
  t.is(store.isUncertain(MEMBER), false, 'a newer selfie is untouched')
  store.markUncertain(MEMBER, 'doc-2')
  t.is(store.isUncertain(MEMBER), true)
  t.is(store.get(MEMBER, 'doc-2'), 'vlt_newer', 'marking keeps the token')
})

test('scoped drop and markUncertain check the documentId argument', function (t) {
  const store = createLivenessTokens({ now: clock().now })
  for (const bad of ['', 5, null]) {
    t.exception.all(() => store.drop(MEMBER, bad), /documentId must be a non-empty string/)
    t.exception.all(() => store.markUncertain(MEMBER, bad), /documentId must be a non-empty string/)
  }
})
