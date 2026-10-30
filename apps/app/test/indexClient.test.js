// Seeder index client: URL building, transport rules (status, redirect,
// timeout, 64 KiB cap) and strict response validation, with fetch injected
// (no network). Also the request budget: the shared pacer, the 429 cooldown
// and the member cache, on a fake clock (no real waits).
'use strict'

const test = require('brittle')

// Fake clock: timers only fire when everything else is idle (one per
// macrotask), so time jumps straight to the next timer.
function fakeClock (start = Date.parse('2026-10-26T12:00:00Z')) {
  let t = start
  let seq = 0
  const timers = new Map()
  const deps = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, id })
      return id
    },
    clearTimeout: (id) => { timers.delete(id) }
  }
  async function run (promise) {
    const state = { done: false }
    promise.then(() => { state.done = true }, () => { state.done = true })
    let idle = 0
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve))
      if (state.done) break
      if (timers.size === 0) {
        if (++idle > 1000) throw new Error('fake clock: stuck with no timers')
        continue
      }
      idle = 0
      let next = null
      for (const tm of timers.values()) if (next === null || tm.at < next.at || (tm.at === next.at && tm.id < next.id)) next = tm
      timers.delete(next.id)
      t = Math.max(t, next.at)
      next.fn()
    }
    return promise
  }
  return {
    deps,
    run,
    now: () => t,
    advance: (ms) => { t += ms },
    later: (ms, value) => new Promise((resolve) => deps.setTimeout(() => resolve(value), ms))
  }
}

// Fresh module state per test (no cache, pacer or cooldown leaks between
// cases); the fetch* functions run on the fake clock.
const DEPS_AT = { fetchPost: 2, fetchCounts: 1, fetchMember: 2, fetchSearch: 1, fetchTopic: 2, fetchEngagers: 3 }
async function load () {
  const m = await import('../src/indexClient.js')
  m.resetIndexClient()
  const clock = fakeClock()
  const out = { ...m, clock }
  for (const [name, i] of Object.entries(DEPS_AT)) {
    out[name] = (...args) => {
      const a = args.slice()
      a[i] = { ...clock.deps, ...(a[i] || {}) }
      return clock.run(m[name](...a))
    }
  }
  return out
}

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const REF = A + ':5'
const CURSOR = '1761000000000.' + B + '.7'

function response (body, { status = 200, redirected = false, chunked = true, headers = {} } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  let sent = false
  let cancelled = false
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const res = {
    status,
    redirected,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(lower, name.toLowerCase()) ? lower[name.toLowerCase()] : null) },
    get cancelled () { return cancelled }
  }
  if (chunked) {
    res.body = {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true }
          sent = true
          return { done: false, value: bytes }
        },
        cancel: async () => { cancelled = true }
      }),
      cancel: async () => { cancelled = true }
    }
  } else {
    res.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  return res
}

const json = (value, opts) => async () => response(JSON.stringify(value), opts)

function postBody (over = {}) {
  return {
    ref: REF,
    parent: B + ':2',
    replies: [C + ':1', B + ':9'],
    next: CURSOR,
    quotes: [C + ':4'],
    likes: 3,
    reposts: 0,
    repliesTotal: 60,
    quotesTotal: 1,
    authors: {
      [A]: { profileSeq: 1, usernameSeq: null },
      [B]: { profileSeq: null, usernameSeq: 2 },
      [C]: { profileSeq: null, usernameSeq: null }
    },
    indexing: false,
    complete: true,
    ...over
  }
}

function memberBody (over = {}) {
  return { length: 50, profileSeq: 1, usernameSeq: 2, posts: [40, 12, 3], postsTotal: 3, indexing: true, complete: false, ...over }
}

test('URL builders accept good input and refuse anything else', async (t) => {
  const { postUrl, countsUrl, memberUrl } = await load()
  t.is(postUrl(REF), '/index/post/' + A + '/5')
  t.is(postUrl(REF.toUpperCase()), '/index/post/' + A + '/5', 'input lowercased')
  t.is(postUrl(REF, CURSOR), '/index/post/' + A + '/5/' + CURSOR)
  for (const bad of [A + ':0', A + ':05', A, A + ':1/..', 'zz'.repeat(32) + ':1', null, 7, A + ':99999999999999999']) {
    t.is(postUrl(bad), null, 'ref ' + String(bad))
  }
  for (const bad of ['x', '1.' + B + '.0', '1.' + B.toUpperCase() + '.1', '12345678901234567.' + B + '.1', CURSOR + '/x']) {
    t.is(postUrl(REF, bad), null, 'cursor ' + bad)
  }
  t.is(countsUrl([REF, B + ':1', REF]), '/index/counts/' + REF + ',' + B + ':1', 'deduped')
  t.is(countsUrl([]), null)
  t.is(countsUrl([REF, 'bad']), null)
  t.is(countsUrl(Array.from({ length: 31 }, (_, i) => A + ':' + (i + 1))).split(',').length, 31)
  t.is(countsUrl(Array.from({ length: 32 }, (_, i) => A + ':' + (i + 1))), null)
  t.is(countsUrl('x'), null)
  t.is(memberUrl(A), '/index/member/' + A)
  t.is(memberUrl(A, 10), '/index/member/' + A + '/10')
  for (const [author, before] of [['ab', null], [A + '/x', null], [A, 0], [A, 1.5], [A, '10'], [null, null]]) {
    t.is(memberUrl(author, before), null, String(author) + ' ' + String(before))
  }
})

test('no request is made for bad input', async (t) => {
  const { fetchPost, fetchCounts, fetchMember } = await load()
  let called = false
  const fetch = async () => { called = true }
  t.alike(await fetchPost('nope', null, { fetch }), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchCounts([], { fetch }), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchMember(A, -1, { fetch }), { ok: false, reason: 'invalid-input' })
  t.absent(called)
})

test('app client: index requests carry no cache option and the same URL', async (t) => {
  const { fetchPost } = await load()
  const { setAppClient } = await import('../src/appClient.js')
  t.teardown(() => setAppClient(false))
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(postBody()))
  }
  setAppClient(true)
  t.is((await fetchPost(REF, CURSOR, { fetch })).ok, true)
  t.absent('cache' in calls[0].opts, 'no cache option')
  t.is(calls[0].url, '/index/post/' + A + '/5/' + CURSOR, 'url unchanged')
  t.is(calls[0].opts.redirect, 'error')
  setAppClient(false)
  t.is((await fetchPost(REF, null, { fetch })).ok, true)
  t.is(calls[1].opts.cache, 'no-store', 'the web keeps no-store')
})

test('fetchPost: request options and the exact shape', async (t) => {
  const { fetchPost } = await load()
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(postBody()))
  }
  const res = await fetchPost(REF, CURSOR, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, postBody())
  t.is(calls[0].url, '/index/post/' + A + '/5/' + CURSOR)
  t.is(calls[0].opts.method, 'GET')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is(calls[0].opts.cache, 'no-store')
  t.is(calls[0].opts.headers.Accept, 'application/json')
  t.ok(calls[0].opts.signal, 'abortable')
  const empty = await fetchPost(REF, null, { fetch: json(postBody({ parent: null, replies: [], next: null, quotes: [], authors: {} })) })
  t.is(empty.ok, true)
  const plain = await fetchPost(REF, null, { fetch: async () => response(JSON.stringify(postBody()), { chunked: false }) })
  t.is(plain.ok, true, 'arrayBuffer fallback')
})

test('fetchPost rejects anything outside the contract', async (t) => {
  const { fetchPost } = await load()
  const manyRefs = Array.from({ length: 51 }, (_, i) => B + ':' + (i + 1))
  const bad = [
    { ref: B + ':5' },
    { ref: REF.toUpperCase() },
    { parent: B.toUpperCase() + ':2' },
    { parent: B + ':0' },
    { replies: [C + ':1', C + ':1'] },
    { replies: [C.toUpperCase() + ':1'] },
    { replies: manyRefs },
    { quotes: manyRefs },
    { replies: 'x' },
    { next: 'x' },
    { likes: -1 },
    { reposts: 1.5 },
    { repliesTotal: '3' },
    { quotesTotal: null },
    { indexing: 'no' },
    { complete: 1 },
    { authors: [] },
    { authors: { [A.toUpperCase()]: { profileSeq: 1, usernameSeq: null } } },
    { authors: { [A]: { profileSeq: 0, usernameSeq: null } } },
    { authors: { [A]: { profileSeq: 1 } } },
    { authors: { [A]: { profileSeq: 1, usernameSeq: null, extra: 1 } } },
    { extra: true }
  ]
  for (const over of bad) {
    const res = await fetchPost(REF, null, { fetch: json(postBody(over)) })
    t.alike(res, { ok: false, reason: 'malformed' }, JSON.stringify(over).slice(0, 80))
  }
  const missing = postBody()
  delete missing.quotes
  t.is((await fetchPost(REF, null, { fetch: json(missing) })).reason, 'malformed', 'missing key')
  for (const body of ['null', '[]', '"x"', '42', 'not json', '\xff']) {
    t.is((await fetchPost(REF, null, { fetch: async () => response(body) })).reason, 'malformed', body)
  }
  t.is((await fetchPost(REF, null, { fetch: async () => response(new Uint8Array([0x7b, 0xff, 0x7d])) })).reason, 'malformed', 'invalid utf-8')
})

test('transport: status, redirect, size cap, network and timeout', async (t) => {
  const { fetchPost } = await load()
  const body = JSON.stringify(postBody())
  t.is((await fetchPost(REF, null, { fetch: async () => response(body, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchPost(REF, null, { fetch: async () => response(body, { status: 500 }) })).reason, 'status')
  t.is((await fetchPost(REF, null, { fetch: async () => response(body, { status: 204 }) })).reason, 'status')
  t.is((await fetchPost(REF, null, { fetch: async () => response(body, { redirected: true }) })).reason, 'status')
  t.is((await fetchPost(REF, null, { fetch: async () => { throw new TypeError('redirect') } })).reason, 'network')
  t.is((await fetchPost(REF, null, { fetch: async () => null })).reason, 'status')
  const big = response(JSON.stringify(postBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchPost(REF, null, { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled, 'oversized read is cancelled')
  const bigPlain = response('x'.repeat(65537), { chunked: false })
  t.is((await fetchPost(REF, null, { fetch: async () => bigPlain })).reason, 'too-large')
  let aborted = false
  const hang = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
  })
  t.is((await fetchPost(REF, null, { fetch: hang, timeoutMs: 20 })).reason, 'timeout')
  t.ok(aborted, 'request aborted')
  const deaf = () => new Promise(() => {})
  t.is((await fetchPost(REF, null, { fetch: deaf, timeoutMs: 20 })).reason, 'timeout', 'even if the signal is ignored')
})

test('fetchCounts: exact shape, requested refs only', async (t) => {
  const { fetchCounts } = await load()
  const c = { replies: 1, likes: 2, reposts: 0, quotes: 3 }
  const good = { counts: { [REF]: c }, indexing: false, complete: true }
  const res = await fetchCounts([REF, B + ':1'], { fetch: json(good) })
  t.alike(res, { ok: true, value: good })
  const bad = [
    { counts: { [B + ':7']: c }, indexing: false, complete: true },
    { counts: { [REF.toUpperCase()]: c }, indexing: false, complete: true },
    { counts: { [REF]: { ...c, likes: -1 } }, indexing: false, complete: true },
    { counts: { [REF]: { ...c, extra: 0 } }, indexing: false, complete: true },
    { counts: { [REF]: { replies: 1, likes: 2, reposts: 0 } }, indexing: false, complete: true },
    { counts: [], indexing: false, complete: true },
    { counts: {}, indexing: false },
    { counts: {}, indexing: false, complete: true, more: 1 }
  ]
  for (const body of bad) t.is((await fetchCounts([REF, B + ':1'], { fetch: json(body) })).reason, 'malformed', JSON.stringify(body).slice(0, 80))
})

test('fetchMember: exact shape, descending seqs under before and length', async (t) => {
  const { fetchMember } = await load()
  t.alike(await fetchMember(A, null, { fetch: json(memberBody()) }), { ok: true, value: memberBody() })
  t.is((await fetchMember(A, 41, { fetch: json(memberBody()) })).ok, true)
  t.is((await fetchMember(A, 40, { fetch: json(memberBody()) })).reason, 'malformed', 'not below before')
  const bad = [
    { posts: [3, 12] },
    { posts: [12, 12] },
    { posts: [0] },
    { posts: [50] },
    { posts: Array.from({ length: 101 }, (_, i) => 200 - i), length: 300 },
    { length: -1 },
    { profileSeq: 0 },
    { usernameSeq: '2' },
    { postsTotal: 1.5 },
    { complete: null },
    { extra: 1 }
  ]
  for (const over of bad) t.is((await fetchMember(A, null, { fetch: json(memberBody(over)) })).reason, 'malformed', JSON.stringify(over).slice(0, 80))
})

// --- request budget ---

const complete = (over = {}) => memberBody({ complete: true, indexing: false, ...over })

// A fetch that records each call (url + fake time) and answers via `reply`.
function recorder (clock, reply) {
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, at: clock.now() })
    return reply(url, calls.length, opts)
  }
  return { calls, fetch }
}

const tooMany = (retryAfter) => response('', { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } })

test('parseRetryAfter: seconds, dates, defaults and the sanity cap', async (t) => {
  const { parseRetryAfter } = await load()
  const now = Date.parse('2026-10-26T12:00:00Z')
  t.is(parseRetryAfter('5', now), 5000)
  t.is(parseRetryAfter(' 120 ', now), 120000, 'never shortened')
  t.is(parseRetryAfter('0', now), 0)
  t.is(parseRetryAfter(new Date(now + 7000).toUTCString(), now), 7000)
  t.is(parseRetryAfter(new Date(now - 7000).toUTCString(), now), 0, 'past date')
  for (const bad of [null, undefined, '', 'soon', '1.5', '-3', '5s']) t.is(parseRetryAfter(bad, now), 10000, String(bad))
  t.is(parseRetryAfter('99999999', now), 600000, 'absurd value capped at 10 min')
})

test('member cache: a hit avoids a second fetch and returns fresh copies', async (t) => {
  const { fetchMember, clock } = await load()
  const { calls, fetch } = recorder(clock, () => response(JSON.stringify(complete())))
  const first = await fetchMember(A, null, { fetch })
  t.alike(first, { ok: true, value: complete() })
  first.value.posts.push(1)
  const second = await fetchMember(A.toUpperCase(), null, { fetch })
  t.alike(second, { ok: true, value: complete() }, 'same key, untouched by the caller\'s edit')
  t.is(calls.length, 1)
  t.is((await fetchMember(A, 41, { fetch })).ok, true)
  t.is(calls.length, 2, 'before is part of the key')
  clock.advance(5 * 60 * 1000 - 1)
  await fetchMember(A, null, { fetch })
  t.is(calls.length, 2, 'still fresh just under the TTL')
  clock.advance(1)
  await fetchMember(A, null, { fetch })
  t.is(calls.length, 3, 'miss after the TTL')
})

test('member cache: failures, incomplete pages and counts are never cached', async (t) => {
  const { fetchMember, fetchCounts, fetchPost, clock } = await load()
  const notFound = recorder(clock, () => response('', { status: 404 }))
  t.is((await fetchMember(A, null, { fetch: notFound.fetch })).reason, 'not-found')
  t.is((await fetchMember(A, null, { fetch: notFound.fetch })).reason, 'not-found')
  t.is(notFound.calls.length, 2, '404 not cached')
  const partial = recorder(clock, () => response(JSON.stringify(memberBody())))
  await fetchMember(B, null, { fetch: partial.fetch })
  await fetchMember(B, null, { fetch: partial.fetch })
  t.is(partial.calls.length, 2, 'complete: false not cached')
  const bad = recorder(clock, () => response(JSON.stringify(complete({ extra: 1 }))))
  await fetchMember(C, null, { fetch: bad.fetch })
  await fetchMember(C, null, { fetch: bad.fetch })
  t.is(bad.calls.length, 2, 'malformed not cached')
  const counts = recorder(clock, () => response(JSON.stringify({ counts: {}, indexing: false, complete: true })))
  await fetchCounts([REF], { fetch: counts.fetch })
  await fetchCounts([REF], { fetch: counts.fetch })
  t.is(counts.calls.length, 2, 'counts not cached')
  const posts = recorder(clock, () => response(JSON.stringify(postBody())))
  await fetchPost(REF, null, { fetch: posts.fetch })
  await fetchPost(REF, null, { fetch: posts.fetch })
  t.is(posts.calls.length, 2, 'post pages not cached')
})

test('member cache: in-flight dedupe and invalidateMember', async (t) => {
  const m = await load()
  const { clock } = m
  const { calls, fetch } = recorder(clock, () => clock.later(500, response(JSON.stringify(complete()))))
  const deps = { ...clock.deps, fetch }
  const [x, y] = await clock.run(Promise.all([m.fetchMember(A, null, deps), m.fetchMember(A, null, deps)]))
  t.is(calls.length, 1, 'one request for two concurrent asks')
  t.alike(x, y)
  t.not(x.value, y.value, 'separate copies')
  m.invalidateMember(A.toUpperCase())
  await m.fetchMember(A, null, { fetch })
  t.is(calls.length, 2, 'invalidated: back to the index')
  m.invalidateMember(A)
  const pending = m.fetchMember(A, null, deps)
  m.invalidateMember(A)
  await clock.run(pending)
  await m.fetchMember(A, null, { fetch })
  t.is(calls.length, 4, 'a request out during invalidation does not refill the cache')
  m.invalidateMember('nope')
})

test('429 with delta-seconds: shared cooldown, no network until it ends, then retry', async (t) => {
  const m = await load()
  const { clock } = m
  const t0 = clock.now()
  const { calls, fetch } = recorder(clock, (url, n) => {
    if (n === 1) return tooMany('5')
    return url.startsWith('/index/counts/')
      ? response(JSON.stringify({ counts: {}, indexing: false, complete: true }))
      : response(JSON.stringify(complete()))
  })
  const deps = { ...clock.deps, fetch }
  const member = m.fetchMember(A, null, deps)
  const counts = clock.later(1000).then(() => m.fetchCounts([REF], deps))
  const [a, b] = await clock.run(Promise.all([member, counts]))
  t.is(a.ok, true, 'retried after the cooldown')
  t.is(b.ok, true)
  t.is(calls.length, 3)
  t.is(calls[0].at, t0)
  for (const c of calls.slice(1)) t.ok(c.at >= t0 + 5000, 'no request during the cooldown: ' + (c.at - t0))
})

test('429 with an HTTP date', async (t) => {
  const { fetchMember, clock } = await load()
  const t0 = clock.now()
  const { calls, fetch } = recorder(clock, (url, n) => n === 1 ? tooMany(new Date(t0 + 7000).toUTCString()) : response(JSON.stringify(complete())))
  t.is((await fetchMember(A, null, { fetch })).ok, true)
  t.is(calls.length, 2)
  t.is(calls[1].at - t0, 7000)
})

test('429 without Retry-After cools for 10 s; other statuses are not retried', async (t) => {
  const { fetchMember, fetchPost, clock } = await load()
  const t0 = clock.now()
  const { calls, fetch } = recorder(clock, (url, n) => n === 1 ? tooMany() : response(JSON.stringify(complete())))
  t.is((await fetchMember(A, null, { fetch })).ok, true)
  t.is(calls[1].at - t0, 10000)
  const err = recorder(clock, () => response('', { status: 503, headers: { 'Retry-After': '5' } }))
  t.alike(await fetchPost(REF, null, { fetch: err.fetch }), { ok: false, reason: 'status' })
  t.is(err.calls.length, 1)
})

test('a valid long Retry-After is honoured in full across calls', async (t) => {
  const { fetchMember, fetchCounts, clock } = await load()
  const { calls, fetch } = recorder(clock, (url, n) => n === 1 ? tooMany('120') : response(JSON.stringify(complete())))
  t.alike(await fetchMember(A, null, { fetch }), { ok: false, reason: 'rate-limited', retryAfterMs: 120000 }, 'cannot outlast it within 45 s: fails at once')
  clock.advance(30000)
  t.alike(await fetchCounts([REF], { fetch }), { ok: false, reason: 'rate-limited', retryAfterMs: 90000 }, 'later calls keep the remaining cooldown')
  t.is(calls.length, 1, 'nothing reached the network')
  clock.advance(80000)
  const late = await fetchMember(A, null, { fetch })
  t.is(late.ok, true, 'waited out the last 10 s, then fetched')
  t.is(calls[1].at - calls[0].at, 120000)
})

test('the 45 s deadline: retries stop and report rate-limited', async (t) => {
  const { fetchMember, clock } = await load()
  const t0 = clock.now()
  const short = recorder(clock, () => tooMany('5'))
  t.alike(await fetchMember(A, null, { fetch: short.fetch }), { ok: false, reason: 'rate-limited', retryAfterMs: 5000 })
  t.alike(short.calls.map((c) => c.at - t0), [0, 5000, 10000, 15000], 'first try + 3 retries')
  const t1 = clock.now() + 5000
  const long = recorder(clock, () => tooMany('20'))
  t.alike(await fetchMember(B, null, { fetch: long.fetch }), { ok: false, reason: 'rate-limited', retryAfterMs: 20000 })
  t.alike(long.calls.map((c) => c.at - t1), [0, 20000, 40000], 'a fourth try would fall past 45 s')
})

test('pacer: a burst never exceeds 18 starts per 10 s or 2 in flight, and all settle', async (t) => {
  const m = await load()
  const { clock } = m
  let out = 0
  let maxOut = 0
  const { calls, fetch } = recorder(clock, async (url) => {
    out++
    maxOut = Math.max(maxOut, out)
    await clock.later(100)
    out--
    return url.startsWith('/index/counts/')
      ? response(JSON.stringify({ counts: {}, indexing: false, complete: true }))
      : response(JSON.stringify(memberBody({ posts: [] })))
  })
  const deps = { ...clock.deps, fetch }
  const all = Array.from({ length: 30 }, (_, i) => m.fetchMember(A, 100 + i, deps))
  all.push(m.fetchCounts([REF], deps))
  const results = await clock.run(Promise.all(all))
  t.ok(results.every((r) => r.ok), 'all settle ok')
  t.is(calls.length, 31)
  t.ok(maxOut <= 2, 'at most 2 in flight: ' + maxOut)
  let worst = 0
  for (const c of calls) worst = Math.max(worst, calls.filter((d) => d.at >= c.at && d.at < c.at + 10000).length)
  t.ok(worst <= 18, 'starts per rolling 10 s: ' + worst)
})

test('a queued request still gets the full 8 s fetch budget', async (t) => {
  const m = await load()
  const { clock } = m
  const t0 = clock.now()
  const { calls, fetch } = recorder(clock, (url, n) => n <= 18
    ? response(JSON.stringify(memberBody({ posts: [] })))
    : clock.later(n === 19 ? 7900 : 8100, response(JSON.stringify(memberBody({ posts: [] })))))
  const deps = { ...clock.deps, fetch }
  const all = Array.from({ length: 20 }, (_, i) => m.fetchMember(A, 100 + i, deps))
  const results = await clock.run(Promise.all(all))
  t.ok(calls[18].at - t0 >= 10000, 'the 19th waited for the window')
  t.is(results[18].ok, true, '7.9 s answer after a 10 s wait is not a timeout')
  t.is(results[19].reason, 'timeout', 'the attempt timeout itself still applies')
})

function searchBody (over = {}) {
  return {
    members: [
      { author: B, profileSeq: 3, usernameSeq: null },
      { author: A, profileSeq: null, usernameSeq: 1 },
      { author: C, profileSeq: 2, usernameSeq: 4 }
    ],
    more: true,
    indexing: false,
    complete: true,
    ...over
  }
}

test('searchUrl: only the folded segment grammar, never a fetch otherwise', async (t) => {
  const { searchUrl, fetchSearch } = await load()
  for (const good of ['ana', 'ana-silva', 'a-b', 'joao-da-silva-x', 'x'.repeat(20)]) {
    t.is(searchUrl(good), '/index/search/' + good, good)
  }
  let called = false
  const fetch = async () => { called = true }
  const bad = ['Ana', 'ANA-silva', 'a', 'x'.repeat(21), 'ana-b-c-d-e', '-ana', 'ana-', 'ana--b', 'ana_silva', '/', '@ana', 'ana silva', ' ana', '', null, undefined, 7, ['ana'], { s: 'ana' }]
  for (const s of bad) {
    t.is(searchUrl(s), null, 'url ' + JSON.stringify(s))
    t.alike(await fetchSearch(s, { fetch }), { ok: false, reason: 'invalid-input' }, 'fetch ' + JSON.stringify(s))
  }
  t.absent(called)
})

test('fetchSearch: request options, order kept, a fresh copy', async (t) => {
  const { fetchSearch } = await load()
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(searchBody()))
  }
  const res = await fetchSearch('ana-silva', { fetch })
  t.is(res.ok, true)
  t.alike(res.value, searchBody())
  t.alike(res.value.members.map((m) => m.author), [B, A, C], 'ranking order preserved')
  t.is(calls.length, 1)
  t.is(calls[0].url, '/index/search/ana-silva')
  t.is(calls[0].opts.method, 'GET')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is(calls[0].opts.cache, 'no-store')
  t.is(calls[0].opts.headers.Accept, 'application/json')
  t.ok(calls[0].opts.signal, 'abortable')
  const empty = await fetchSearch('ana', { fetch: json(searchBody({ members: [], more: false })) })
  t.alike(empty, { ok: true, value: searchBody({ members: [], more: false }) })
})

test('validSearch returns a copy that does not track the input', async (t) => {
  const { validSearch } = await load()
  const input = searchBody()
  const out = validSearch(input)
  t.alike(out, searchBody())
  t.not(out, input)
  t.not(out.members, input.members)
  t.not(out.members[0], input.members[0])
  input.members[0].profileSeq = 99
  input.members.push({ author: 'aa'.repeat(32), profileSeq: 1, usernameSeq: 1 })
  input.more = false
  t.alike(out, searchBody(), 'unchanged by mutating the input')
})

test('fetchSearch rejects anything outside the contract', async (t) => {
  const { fetchSearch, SEARCH_MAX } = await load()
  t.is(SEARCH_MAX, 20)
  const hit = (i) => ({ author: i.toString(16).padStart(64, '0'), profileSeq: 1, usernameSeq: null })
  t.is((await fetchSearch('ana', { fetch: json(searchBody({ members: Array.from({ length: 20 }, (_, i) => hit(i + 1)) })) })).ok, true, '20 members')
  const m = { author: A, profileSeq: 1, usernameSeq: null }
  const bad = [
    { extra: 1 },
    { name: 'Ana' },
    { members: Array.from({ length: 21 }, (_, i) => hit(i + 1)) },
    { members: [m, { ...m, profileSeq: 2 }] },
    { members: [{ ...m, author: A.toUpperCase() }] },
    { members: [{ ...m, author: 'ab' }] },
    { members: [{ ...m, profileSeq: null }] },
    { members: [{ ...m, profileSeq: 0 }] },
    { members: [{ ...m, usernameSeq: 0 }] },
    { members: [{ ...m, profileSeq: 1.5 }] },
    { members: [{ ...m, usernameSeq: '2' }] },
    { members: [{ ...m, name: 'Ana' }] },
    { members: [{ ...m, username: 'ana' }] },
    { members: [{ ...m, bio: 'oi' }] },
    { members: [{ author: A, profileSeq: 1 }] },
    { members: [[A, 1, null]] },
    { members: [null] },
    { members: {} },
    { members: 'x' },
    { more: 'yes' },
    { indexing: 0 },
    { complete: null }
  ]
  for (const over of bad) {
    t.alike(await fetchSearch('ana', { fetch: json(searchBody(over)) }), { ok: false, reason: 'malformed' }, JSON.stringify(over).slice(0, 80))
  }
  for (const key of ['members', 'more', 'indexing', 'complete']) {
    const body = searchBody()
    delete body[key]
    t.is((await fetchSearch('ana', { fetch: json(body) })).reason, 'malformed', 'missing ' + key)
  }
  for (const body of ['null', '[]', '"x"', 'not json']) {
    t.is((await fetchSearch('ana', { fetch: async () => response(body) })).reason, 'malformed', body)
  }
})

test('fetchSearch transport: 404, 429, 503, redirect, size cap', async (t) => {
  const { fetchSearch } = await load()
  const body = JSON.stringify(searchBody())
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 404 }) })).reason, 'not-found')
  // A 429 is the shared cooldown with retries (see the request budget tests),
  // never a plain status failure.
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 429 }) })).reason, 'rate-limited')
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 503 }) })).reason, 'status')
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { redirected: true }) })).reason, 'status')
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 404, redirected: true }) })).reason, 'status')
  const big = response(JSON.stringify(searchBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchSearch('ana', { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled, 'oversized read is cancelled')
})

function topicBody (over = {}) {
  return {
    items: [A + ':5', B + ':2', A + ':3'],
    next: CURSOR,
    authors: {
      [A]: { profileSeq: 1, usernameSeq: null },
      [B]: { profileSeq: null, usernameSeq: 2 }
    },
    indexing: false,
    complete: true,
    ...over
  }
}

test('topicUrl: folded tokens joined by a literal plus, nothing else', async (t) => {
  const { topicUrl } = await load()
  t.is(topicUrl('ceu'), '/index/topic/ceu')
  t.is(topicUrl('ceu+azul'), '/index/topic/ceu+azul', 'literal plus, not %2B')
  t.is(topicUrl('ceu+azul', CURSOR), '/index/topic/ceu+azul/' + CURSOR)
  t.is(topicUrl(Array.from({ length: 8 }, () => 'ab').join('+')), '/index/topic/' + Array.from({ length: 8 }, () => 'ab').join('+'))
  t.is(topicUrl('x'.repeat(32)), '/index/topic/' + 'x'.repeat(32))
  const nine = Array.from({ length: 9 }, () => 'ab').join('+')
  for (const bad of ['Céu', 'CEU', 'ceu azul', 'ceu%2Bazul', 'ceu?x=1', 'a', 'x'.repeat(33), nine, '', 'ceu+', '+ceu', 'ceu++azul', 'ceu/azul', null, 7, ['ceu']]) {
    t.is(topicUrl(bad), null, 'path ' + String(bad))
  }
  for (const bad of ['x', '1.' + B + '.0', CURSOR + '/x', 7]) {
    t.is(topicUrl('ceu', bad), null, 'cursor ' + String(bad))
  }
})

test('validTopic: exact shape, hints for exactly the items\' authors', async (t) => {
  const { validTopic, TOPIC_MAX } = await load()
  t.is(TOPIC_MAX, 30)
  t.alike(validTopic(topicBody()), topicBody())
  const empty = { items: [], next: null, authors: {}, indexing: true, complete: false }
  t.alike(validTopic(empty), empty, 'empty list')
  const thirty = Array.from({ length: 30 }, (_, i) => A + ':' + (i + 1))
  t.alike(validTopic(topicBody({ items: thirty, authors: { [A]: { profileSeq: null, usernameSeq: null } } })).items, thirty, '30 items')
  const missing = topicBody()
  delete missing.next
  const bad = [
    topicBody({ extra: 1 }),
    missing,
    topicBody({ items: Array.from({ length: 31 }, (_, i) => A + ':' + (i + 1)), authors: { [A]: { profileSeq: null, usernameSeq: null } } }),
    topicBody({ items: [A + ':5', A + ':5'], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    topicBody({ items: [A + ':0'], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    topicBody({ items: 'x' }),
    topicBody({ next: 'x' }),
    topicBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, ['zz'.repeat(32)]: { profileSeq: null, usernameSeq: 2 } } }),
    topicBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 2 }, [C]: { profileSeq: null, usernameSeq: null } } }),
    topicBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    topicBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: 0, usernameSeq: 2 } } }),
    topicBody({ authors: [] }),
    topicBody({ indexing: 'no' }),
    topicBody({ complete: 1 }),
    topicBody({ complete: null }),
    null,
    []
  ]
  for (const body of bad) t.is(validTopic(body), null, JSON.stringify(body).slice(0, 80))
})

test('fetchTopic: transport, contract and a fresh copy', async (t) => {
  const { fetchTopic, validTopic } = await load()
  const calls = []
  const parsed = topicBody()
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(parsed))
  }
  const res = await fetchTopic('ceu+azul', CURSOR, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, topicBody())
  t.is(calls[0].url, '/index/topic/ceu+azul/' + CURSOR)
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  // A fresh copy: mutating the result leaves the parsed body untouched.
  const own = topicBody()
  const copy = validTopic(own)
  copy.items.push(C + ':1')
  copy.authors[A].profileSeq = 99
  t.is(own.items.length, 3, 'items copied')
  t.is(own.authors[A].profileSeq, 1, 'hints copied')
  res.value.items.length = 0
  t.is(parsed.items.length, 3, 'the fetched result is a copy too')
  let called = false
  t.alike(await fetchTopic('Céu', null, { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.absent(called, 'no request for bad input')
  const text = JSON.stringify(topicBody())
  t.is((await fetchTopic('ceu', null, { fetch: async () => response(text, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchTopic('ceu', null, { fetch: async () => response(text, { redirected: true }) })).reason, 'status')
  t.is((await fetchTopic('ceu', null, { fetch: async () => response(JSON.stringify(topicBody({ pad: 'x'.repeat(70000) }))) })).reason, 'too-large')
  t.is((await fetchTopic('ceu', null, { fetch: json(topicBody({ next: 'x' })) })).reason, 'malformed')
  t.is((await fetchTopic('ceu', null, { fetch: async () => response('not json') })).reason, 'malformed')
  // A 429 is the shared cooldown with retries, as on every /index route
  // (last here: the cooldown it sets outlives the remaining calls).
  const limited = await fetchTopic('ceu', null, { fetch: async () => response(text, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs), 'with the cooldown left')
})

function engagersBody (over = {}) {
  return {
    ref: REF,
    kind: 'likes',
    items: [B + ':9', C + ':4'],
    next: CURSOR,
    total: 7,
    authors: {
      [B]: { profileSeq: 1, usernameSeq: null },
      [C]: { profileSeq: null, usernameSeq: null }
    },
    indexing: false,
    complete: true,
    ...over
  }
}

test('engagersUrl: both kinds, exact paths, everything else refused', async (t) => {
  const { engagersUrl, fetchEngagers, ENGAGERS_MAX } = await load()
  t.is(ENGAGERS_MAX, 20)
  t.is(engagersUrl('likes', REF), '/index/likes/' + A + '/5')
  t.is(engagersUrl('reposts', REF), '/index/reposts/' + A + '/5')
  t.is(engagersUrl('likes', REF, CURSOR), '/index/likes/' + A + '/5/' + CURSOR)
  t.is(engagersUrl('reposts', REF, CURSOR), '/index/reposts/' + A + '/5/' + CURSOR)
  t.is(engagersUrl('likes', REF.toUpperCase()), '/index/likes/' + A + '/5', 'ref lowercased')
  t.is(engagersUrl('likes', A + ':' + '9'.repeat(15)), '/index/likes/' + A + '/' + '9'.repeat(15), 'seq of 15 places')
  for (const kind of ['Likes', 'like', '', ' likes', 'likes ', 'repost', 'post', null, undefined, 7]) {
    t.is(engagersUrl(kind, REF), null, 'kind ' + String(kind))
  }
  for (const ref of [A + ':0', A + ':05', A, 'zz'.repeat(32) + ':1', A + ':1/..', A + ':1000000000000000', A + ':9007199254740991', null, 7]) {
    t.is(engagersUrl('likes', ref), null, 'ref ' + String(ref))
  }
  for (const cursor of ['x', '1.' + B + '.0', CURSOR + '/x', CURSOR + '?a=1', 7]) {
    t.is(engagersUrl('likes', REF, cursor), null, 'cursor ' + String(cursor))
  }
  let called = false
  const fetch = async () => { called = true }
  for (const [kind, ref, cursor] of [['Likes', REF, null], ['like', REF, null], ['', REF, null], ['likes', 'nope', null], ['likes', A + ':0', null], ['reposts', A + ':1000000000000000', null], ['likes', REF, 'x']]) {
    t.alike(await fetchEngagers(kind, ref, cursor, { fetch }), { ok: false, reason: 'invalid-input' }, kind + ' ' + ref + ' ' + cursor)
  }
  t.absent(called, 'no request for bad input')
})

test('validEngagers: exact shape, one item per engager, hints for exactly their authors', async (t) => {
  const { validEngagers } = await load()
  t.alike(validEngagers(engagersBody(), REF, 'likes'), engagersBody())
  t.alike(validEngagers(engagersBody({ kind: 'reposts' }), REF, 'reposts'), engagersBody({ kind: 'reposts' }))
  const empty = { ref: REF, kind: 'likes', items: [], next: null, total: 0, authors: {}, indexing: false, complete: true }
  t.alike(validEngagers(empty, REF, 'likes'), empty, 'empty page')
  const emptyWithNext = { ...empty, next: CURSOR, total: 3, indexing: true, complete: false }
  t.alike(validEngagers(emptyWithNext, REF, 'likes'), emptyWithNext, 'empty page that carries a next')
  const keyOf = (i) => i.toString(16).padStart(2, '0').repeat(32)
  const page = (n) => {
    const items = Array.from({ length: n }, (_, i) => keyOf(i) + ':1')
    const authors = Object.fromEntries(items.map((r) => [r.split(':')[0], { profileSeq: null, usernameSeq: 1 }]))
    return engagersBody({ items, authors, total: n })
  }
  t.is(validEngagers(page(20), REF, 'likes').items.length, 20, '20 items')
  const missingKey = engagersBody()
  delete missingKey.total
  const bad = [
    engagersBody({ extra: 1 }),
    missingKey,
    engagersBody({ ref: B + ':5' }),
    engagersBody({ ref: REF.toUpperCase() }),
    engagersBody({ ref: A + ':0' }),
    engagersBody({ kind: 'reposts' }),
    engagersBody({ kind: 'Likes' }),
    page(21),
    engagersBody({ items: [B + ':9', B + ':9'], authors: { [B]: { profileSeq: 1, usernameSeq: null } } }),
    engagersBody({ items: [B + ':9', B + ':3'], authors: { [B]: { profileSeq: 1, usernameSeq: null } } }),
    engagersBody({ items: [B + ':0', C + ':4'] }),
    engagersBody({ items: 'x' }),
    engagersBody({ next: 'x' }),
    engagersBody({ next: CURSOR + '/x' }),
    engagersBody({ total: -1 }),
    engagersBody({ total: 2.5 }),
    engagersBody({ total: '7' }),
    engagersBody({ total: 1 }),
    engagersBody({ indexing: 'no' }),
    engagersBody({ complete: 1 }),
    engagersBody({ complete: null }),
    engagersBody({ authors: { [B]: { profileSeq: 1, usernameSeq: null } } }),
    engagersBody({ authors: { [B]: { profileSeq: 1, usernameSeq: null }, [C]: { profileSeq: null, usernameSeq: null }, [A]: { profileSeq: 1, usernameSeq: 1 } } }),
    engagersBody({ authors: { [B]: { profileSeq: 1, usernameSeq: null, extra: 1 }, [C]: { profileSeq: null, usernameSeq: null } } }),
    engagersBody({ authors: { [B]: { profileSeq: 0, usernameSeq: null }, [C]: { profileSeq: null, usernameSeq: null } } }),
    engagersBody({ authors: [] }),
    null,
    []
  ]
  for (const body of bad) t.is(validEngagers(body, REF, 'likes'), null, JSON.stringify(body).slice(0, 80))
})

test('fetchEngagers: request options, contract, a fresh copy and transport', async (t) => {
  const { fetchEngagers, validEngagers } = await load()
  const calls = []
  const parsed = engagersBody()
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(parsed))
  }
  const res = await fetchEngagers('likes', REF.toUpperCase(), CURSOR, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, engagersBody())
  t.is(calls[0].url, '/index/likes/' + A + '/5/' + CURSOR)
  t.is(calls[0].opts.method, 'GET')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is(calls[0].opts.cache, 'no-store')
  t.is(calls[0].opts.headers.Accept, 'application/json')
  t.ok(calls[0].opts.signal, 'abortable')
  const reposts = await fetchEngagers('reposts', REF, null, { fetch: json(engagersBody({ kind: 'reposts' })) })
  t.is(reposts.ok, true)
  t.is(reposts.value.kind, 'reposts')
  const own = engagersBody()
  const copy = validEngagers(own, REF, 'likes')
  copy.items.push(A + ':1')
  copy.authors[B].profileSeq = 99
  t.is(own.items.length, 2, 'items copied')
  t.is(own.authors[B].profileSeq, 1, 'hints copied')
  res.value.items.length = 0
  t.is(parsed.items.length, 2, 'the fetched result is a copy too')
  const malformed = [
    engagersBody({ extra: 1 }),
    engagersBody({ ref: B + ':5' }),
    engagersBody({ kind: 'reposts' }),
    engagersBody({ total: 1 })
  ]
  for (const body of malformed) {
    t.alike(await fetchEngagers('likes', REF, null, { fetch: json(body) }), { ok: false, reason: 'malformed' }, JSON.stringify(body).slice(0, 80))
  }
  t.is((await fetchEngagers('likes', REF, null, { fetch: async () => response('not json') })).reason, 'malformed')
  const text = JSON.stringify(engagersBody())
  t.is((await fetchEngagers('likes', REF, null, { fetch: async () => response(text, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchEngagers('likes', REF, null, { fetch: async () => response(text, { redirected: true }) })).reason, 'status')
  const big = response(JSON.stringify(engagersBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchEngagers('likes', REF, null, { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled, 'oversized read is cancelled')
  // Last: the cooldown a 429 sets outlives the remaining calls.
  const limited = await fetchEngagers('reposts', REF, null, { fetch: async () => response(text, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs), 'with the cooldown left')
})

test('with an installation set, every index URL is absolute on that origin only', async (t) => {
  const { postUrl, countsUrl, memberUrl, topicUrl, engagersUrl, searchUrl, fetchCounts } = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  t.ok(setInstallation('https://example.test'))
  const O = 'https://example.test'
  t.is(postUrl(REF, CURSOR), O + '/index/post/' + A + '/5/' + CURSOR)
  t.is(countsUrl([REF, B + ':1']), O + '/index/counts/' + REF + ',' + B + ':1')
  t.is(memberUrl(A, 10), O + '/index/member/' + A + '/10')
  t.is(topicUrl('ab+cd'), O + '/index/topic/ab+cd')
  t.is(engagersUrl('likes', REF), O + '/index/likes/' + A + '/5')
  t.is(searchUrl('ana-bia'), O + '/index/search/ana-bia')
  t.is(postUrl('bad'), null, 'bad input still refused')
  const urls = []
  const good = { counts: {}, indexing: false, complete: true }
  await fetchCounts([REF], { fetch: async (url) => { urls.push(url); return response(JSON.stringify(good)) } })
  t.alike(urls, [O + '/index/counts/' + REF])
  setInstallation(null)
  t.is(postUrl(REF), '/index/post/' + A + '/5', 'relative again once cleared')
})
