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
const DEPS_AT = { fetchPost: 2, fetchCounts: 1, fetchMember: 2 }
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
