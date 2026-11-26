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
const DEPS_AT = { fetchPost: 2, fetchRoda: 2, fetchCounts: 1, fetchMember: 2, refetchMember: 1, fetchSearch: 1, fetchTopic: 2, fetchEngagers: 3, fetchFollowCounts: 1, fetchFollows: 3, fetchFans: 2, fetchEvents: 2, fetchPoll: 3, fetchPollVoters: 4, fetchGroup: 2, fetchGroups: 1, fetchCommunity: 1, fetchCommunityGroups: 2, fetchGroupImages: 1, fetchGroupAbouts: 1, fetchDiscoverGroups: 1, fetchDiscoverCommunities: 1, fetchDiscoverSearch: 1, fetchStandaloneGroupsOf: 2, fetchTopicTrend: 0, fetchTestimonials: 1, fetchFeira: 1, fetchFeiraAuthor: 2, fetchFeiraRatings: 2 }
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

test('member cache: refetchMember goes to the index past a fresh cached page', async (t) => {
  const { fetchMember, refetchMember, clock } = await load()
  const { calls, fetch } = recorder(clock, () => response(JSON.stringify(complete())))
  t.alike(await fetchMember(A, null, { fetch }), { ok: true, value: complete() })
  await fetchMember(A, null, { fetch })
  t.is(calls.length, 1, 'fetchMember serves the complete page from the cache')
  t.alike(await refetchMember(A.toUpperCase(), { fetch }), { ok: true, value: complete() })
  t.is(calls.length, 2, 'refetchMember makes a new request')
  await fetchMember(A, null, { fetch })
  t.is(calls.length, 2, 'the refetched page is cached again')
  t.alike(await refetchMember('nope', { fetch }), { ok: false, reason: 'invalid-input' })
  t.is(calls.length, 2)
})

test('fetchMember: 20 same-tick first pages use two batches and populate the cache', async (t) => {
  const m = await load()
  const authors = Array.from({ length: 20 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
  const { calls, fetch } = recorder(m.clock, (url) => {
    const asked = url.split('/').pop().split(',')
    return m.clock.later(100, response(JSON.stringify({ members: asked.map(() => complete()) })))
  })
  const results = await Promise.all(authors.map((a) => m.fetchMember(a, null, { fetch })))
  t.ok(results.every((r) => r.ok))
  t.alike(calls.map((c) => c.url), [
    '/index/members/' + authors.slice(0, 16).join(','),
    '/index/members/' + authors.slice(16).join(',')
  ])
  t.is(calls[0].at, calls[1].at, 'each batch occupies just one in-flight slot')
  await Promise.all(authors.map((a) => m.fetchMember(a, null, { fetch })))
  t.is(calls.length, 2, 'all complete entries cached')
})

test('fetchMember: duplicate authors share a batch entry and receive separate copies', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, () => response(JSON.stringify({ members: [complete(), complete({ posts: [] })] })))
  const results = await Promise.all([A, B, A.toUpperCase()].map((a) => m.fetchMember(a, null, { fetch })))
  t.is(calls.length, 1)
  t.is(calls[0].url, '/index/members/' + A + ',' + B)
  t.alike(results, [complete(), complete({ posts: [] }), complete()].map((value) => ({ ok: true, value })))
  results[0].value.posts.push(1)
  t.alike(results[2].value.posts, complete().posts)
})

test('fetchMember: a lone author and later pages keep the single route', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, () => response(JSON.stringify(memberBody())))
  await m.fetchMember(A, null, { fetch })
  await Promise.all([m.fetchMember(A, null, { fetch }), m.fetchMember(B, 41, { fetch })])
  t.alike(calls.map((c) => c.url), ['/index/member/' + A, '/index/member/' + B + '/41', '/index/member/' + A])
})

test('fetchMember: a batch 404 falls back for this installation for 5 minutes', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, (url) => url.startsWith('/index/members/')
    ? response('', { status: 404 })
    : response(JSON.stringify(memberBody())))
  for (let i = 0; i < 2; i++) {
    const results = await Promise.all([A, B, A].map((a) => m.fetchMember(a, null, { fetch })))
    t.ok(results.every((r) => r.ok))
  }
  t.alike(calls.map((c) => c.url), ['/index/members/' + A + ',' + B, ...[A, B, A, B].map((a) => '/index/member/' + a)])
  await m.clock.run(new Promise((resolve) => m.clock.deps.setTimeout(resolve, 5 * 60 * 1000)))
  await Promise.all([A, B].map((a) => m.fetchMember(a, null, { fetch })))
  t.is(calls.filter((c) => c.url.startsWith('/index/members/')).length, 2, 'the batch route is tried again after the window')
  m.resetIndexClient()
  await Promise.all([A, B].map((a) => m.fetchMember(a, null, { fetch })))
  t.is(calls.filter((c) => c.url.startsWith('/index/members/')).length, 3, 'reset starts a new session')
})

test('fetchMember: batch transport failures reach every waiter and do not disable batches', async (t) => {
  for (const [reply, failure] of [
    [() => response('', { status: 503 }), { ok: false, reason: 'status' }],
    [() => new Promise(() => {}), { ok: false, reason: 'timeout' }],
    [() => { throw new Error('offline') }, { ok: false, reason: 'network' }]
  ]) {
    const m = await load()
    const { calls, fetch } = recorder(m.clock, reply)
    t.alike(await Promise.all([A, B, A].map((a) => m.fetchMember(a, null, { fetch }))), [failure, failure, failure])
    t.is(calls.length, 1, failure.reason + ': only the batch request')
    const next = recorder(m.clock, () => response(JSON.stringify({ members: [complete(), complete()] })))
    t.ok((await Promise.all([A, B].map((a) => m.fetchMember(a, null, { fetch: next.fetch })))).every((r) => r.ok))
    t.is(next.calls[0].url, '/index/members/' + A + ',' + B, 'only 404 disables batches')
  }
})

test('fetchMember: a batch 429 waits out Retry-After and retries like any index GET', async (t) => {
  const m = await load()
  let n = 0
  const { calls, fetch } = recorder(m.clock, () => (n++ === 0 ? tooMany('5') : response(JSON.stringify({ members: [complete(), complete()] }))))
  const results = await Promise.all([A, B].map((a) => m.fetchMember(a, null, { fetch })))
  t.ok(results.every((r) => r.ok), 'both authors answered after the retry')
  t.alike(calls.map((c) => c.url), ['/index/members/' + A + ',' + B, '/index/members/' + A + ',' + B])
  t.is(calls[1].at - calls[0].at, 5000, 'the retry waits the cooldown')
})

test('fetchMember: an unreadable batch envelope falls back to single GETs, without disabling batches', async (t) => {
  for (const body of ['{', ...[{}, { members: null }, { members: [] }, { members: [null, null, null] }, { members: [null], extra: true }].map((b) => JSON.stringify(b))]) {
    const m = await load()
    const { calls, fetch } = recorder(m.clock, (url) => url.startsWith('/index/members/') ? response(body) : response(JSON.stringify(memberBody())))
    const results = await Promise.all([A, B, A].map((a) => m.fetchMember(a, null, { fetch })))
    t.ok(results.every((r) => r.ok), body + ': every author answered')
    t.alike(calls.map((c) => c.url), ['/index/members/' + A + ',' + B, '/index/member/' + A, '/index/member/' + B])
    const next = recorder(m.clock, () => response(JSON.stringify({ members: [complete(), complete()] })))
    await Promise.all([A, B].map((a) => m.fetchMember(a, null, { fetch: next.fetch })))
    t.is(next.calls[0].url, '/index/members/' + A + ',' + B, 'batches stay on')
  }
})

test('fetchMember: null and invalid entries affect only their own waiters and are not cached', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, () => response(JSON.stringify({ members: [null, complete({ posts: [0] }), complete()] })))
  const results = await Promise.all([A, B, C, B].map((a) => m.fetchMember(a, null, { fetch })))
  t.alike(results, [
    { ok: false, reason: 'not-found' },
    { ok: false, reason: 'malformed' },
    { ok: true, value: complete() },
    { ok: false, reason: 'malformed' }
  ])
  await m.fetchMember(C, null, { fetch })
  t.is(calls.length, 1, 'valid entry cached')
  const next = recorder(m.clock, () => response(JSON.stringify({ members: [complete(), memberBody()] })))
  await Promise.all([A, B].map((a) => m.fetchMember(a, null, { fetch: next.fetch })))
  t.is(next.calls[0].url, '/index/members/' + A + ',' + B, 'failed entries fetched again')
  const single = recorder(m.clock, () => response(JSON.stringify(complete())))
  await m.fetchMember(B, null, { fetch: single.fetch })
  t.is(single.calls.length, 1, 'incomplete entry is not cached either')
})

test('fetchMember: trailing entries trimmed by the body cap use single GETs', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, (url) => response(JSON.stringify(url.startsWith('/index/members/')
    ? { members: [complete()] }
    : complete({ posts: [] }))))
  const results = await Promise.all([A, B, C, B].map((a) => m.fetchMember(a, null, { fetch })))
  t.alike(results.map((r) => r.value.posts), [complete().posts, [], [], []])
  t.alike(calls.map((c) => c.url), ['/index/members/' + [A, B, C].join(','), '/index/member/' + B, '/index/member/' + C])
  await Promise.all([A, B, C].map((a) => m.fetchMember(a, null, { fetch })))
  t.is(calls.length, 3)
})

test('fetchMember: invalidation during a batch prevents only that entry from refilling the cache', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, () => {
    m.invalidateMember(A)
    return response(JSON.stringify({ members: [complete(), complete()] }))
  })
  const pending = [A, B].map((a) => m.fetchMember(a, null, { fetch }))
  t.ok((await Promise.all(pending)).every((r) => r.ok))
  await m.fetchMember(B, null, { fetch })
  t.is(calls.length, 1, 'other author stays cached')
  const single = recorder(m.clock, () => response(JSON.stringify(complete({ posts: [] }))))
  t.alike(await m.fetchMember(A, null, { fetch: single.fetch }), { ok: true, value: complete({ posts: [] }) })
  t.is(single.calls.length, 1, 'invalidated author fetched again')
})

test('fetchMembers: returns ordered per-author results using the shared cache and batching', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, () => response(JSON.stringify({ members: [complete(), complete({ posts: [] })] })))
  const results = await m.clock.run(m.fetchMembers([A, B, A.toUpperCase(), 'bad'], { ...m.clock.deps, fetch }))
  t.alike(results, [{ ok: true, value: complete() }, { ok: true, value: complete({ posts: [] }) }, { ok: true, value: complete() }, { ok: false, reason: 'invalid-input' }])
  t.is(calls.length, 1)
  await m.fetchMember(A, null, { fetch })
  t.is(calls.length, 1)
  t.alike(await m.fetchMembers([]), [])
  t.alike(await m.fetchMembers(null), { ok: false, reason: 'invalid-input' })
})

test('fetchMember: batches share the pacer with other routes and each consume one start', async (t) => {
  const m = await load()
  const t0 = m.clock.now()
  const authors = Array.from({ length: 48 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
  let out = 0
  let maxOut = 0
  const { calls, fetch } = recorder(m.clock, async (url) => {
    out++
    maxOut = Math.max(maxOut, out)
    await m.clock.later(100)
    out--
    return response(JSON.stringify(url.startsWith('/index/members/')
      ? { members: Array.from({ length: 16 }, () => complete()) }
      : { counts: {}, indexing: false, complete: true }))
  })
  const pending = authors.map((a) => m.fetchMember(a, null, { fetch }))
  for (let i = 0; i < 16; i++) pending.push(m.fetchCounts([REF], { fetch }))
  t.ok((await Promise.all(pending)).every((r) => r.ok))
  t.is(calls.length, 19, 'three batches and sixteen counts requests')
  t.is(calls.filter((c) => c.at < t0 + m.WINDOW_MS).length, m.MAX_STARTS)
  t.ok(calls[18].at >= t0 + m.WINDOW_MS, 'nineteenth request waits for the next window')
  t.is(maxOut, m.MAX_IN_FLIGHT, 'one shared in-flight limit')
})

test('fetchMember: invalidation before the batch flush still deduplicates the path', async (t) => {
  const m = await load()
  const { calls, fetch } = recorder(m.clock, () => response(JSON.stringify({ members: [complete(), complete()] })))
  const first = m.fetchMember(A, null, { fetch })
  m.invalidateMember(A)
  const results = await Promise.all([first, m.fetchMember(A, null, { fetch }), m.fetchMember(B, null, { fetch })])
  t.ok(results.every((r) => r.ok))
  t.is(calls.length, 1)
  t.is(calls[0].url, '/index/members/' + A + ',' + B)
  t.not(results[0].value.posts, results[1].value.posts)
  await m.fetchMember(A, null, { fetch })
  t.is(calls.length, 1, 'the new epoch can fill the cache')
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

const AT1 = '2026-10-20T10:00:00.000Z'
const AT2 = '2026-10-19T09:30:00.000Z'
// Newer than AT1, so the fixture's rows come after it in the index order.
const FCURSOR = { atMs: 1800000000000, key: C }

function followsBody (over = {}) {
  return {
    author: A,
    kind: 'seguidores',
    items: [{ key: B, seq: 9, at: AT1 }, { key: C, seq: 4, at: AT2 }],
    next: { atMs: Date.parse(AT2), key: C },
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

const countsBody = (over = {}) => ({ seguindo: 3, seguidores: 12, indexing: false, complete: true, ...over })

test('followCountsUrl and followsUrl: exact paths, an invalid cursor is null', async (t) => {
  const { followCountsUrl, followsUrl, fetchFollows, fetchFollowCounts, FOLLOWS_MAX } = await load()
  t.is(FOLLOWS_MAX, 20)
  t.is(followCountsUrl(A), '/index/follows/' + A)
  t.is(followCountsUrl(A.toUpperCase()), '/index/follows/' + A, 'author lowercased')
  t.is(followsUrl(A, 'seguindo'), '/index/follows/' + A + '/seguindo')
  t.is(followsUrl(A, 'seguidores'), '/index/follows/' + A + '/seguidores')
  t.is(followsUrl(A, 'seguidores', FCURSOR), '/index/follows/' + A + '/seguidores/1800000000000.' + C)
  t.is(followsUrl(A, 'seguindo', { atMs: 0, key: B }), '/index/follows/' + A + '/seguindo/0.' + B, 'atMs 0')
  for (const author of [A + 'a', 'zz'.repeat(32), A + '/x', '', null, 7]) {
    t.is(followCountsUrl(author), null, 'author ' + String(author))
    t.is(followsUrl(author, 'seguindo'), null, 'author ' + String(author))
  }
  for (const kind of ['Seguindo', 'seguidor', '', ' seguindo', 'likes', null, undefined, 7]) {
    t.is(followsUrl(A, kind), null, 'kind ' + String(kind))
  }
  const badCursors = [
    'x',
    '1760000000000.' + C,
    { atMs: -1, key: C },
    { atMs: 1.5, key: C },
    { atMs: Number.MAX_SAFE_INTEGER + 1, key: C },
    { atMs: '1', key: C },
    { atMs: 1, key: C.toUpperCase() },
    { atMs: 1, key: C + '/x' },
    { atMs: 1, key: C, extra: 1 },
    { atMs: 1 },
    [],
    7
  ]
  for (const cursor of badCursors) t.is(followsUrl(A, 'seguindo', cursor), null, 'cursor ' + JSON.stringify(cursor))
  let called = false
  const fetch = async () => { called = true }
  t.alike(await fetchFollowCounts('nope', { fetch }), { ok: false, reason: 'invalid-input' })
  for (const [author, kind, cursor] of [[A, 'Seguindo', null], ['nope', 'seguindo', null], [A, 'seguindo', { atMs: -1, key: C }], [A, 'seguidores', 'x']]) {
    t.alike(await fetchFollows(author, kind, cursor, { fetch }), { ok: false, reason: 'invalid-input' }, author + ' ' + kind + ' ' + JSON.stringify(cursor))
  }
  t.absent(called, 'no request for bad input')
})

test('validFollowCounts: exact keys, counts and flags', async (t) => {
  const { validFollowCounts } = await load()
  t.alike(validFollowCounts(countsBody()), countsBody())
  t.alike(validFollowCounts(countsBody({ seguindo: 0, seguidores: 0, indexing: true, complete: false })), countsBody({ seguindo: 0, seguidores: 0, indexing: true, complete: false }))
  const missing = countsBody()
  delete missing.seguindo
  const bad = [
    countsBody({ extra: 1 }),
    missing,
    countsBody({ seguindo: -1 }),
    countsBody({ seguidores: 2.5 }),
    countsBody({ seguidores: '3' }),
    countsBody({ seguindo: Number.MAX_SAFE_INTEGER + 1 }),
    countsBody({ indexing: 'no' }),
    countsBody({ complete: null }),
    null,
    []
  ]
  for (const body of bad) t.is(validFollowCounts(body), null, JSON.stringify(body))
})

test('validFollows: exact shape, distinct items, hints for exactly the item keys', async (t) => {
  const { validFollows } = await load()
  t.alike(validFollows(followsBody(), A, 'seguidores'), followsBody())
  t.alike(validFollows(followsBody({ kind: 'seguindo' }), A, 'seguindo'), followsBody({ kind: 'seguindo' }))
  const empty = { author: A, kind: 'seguindo', items: [], next: null, total: 0, authors: {}, indexing: false, complete: true }
  t.alike(validFollows(empty, A, 'seguindo'), empty, 'empty page')
  const moon = { items: [{ key: B, seq: 9, at: '1969-07-20T20:17:40.000Z' }], authors: { [B]: { profileSeq: 1, usernameSeq: null } }, total: 3, next: { atMs: 0, key: B } }
  t.alike(validFollows(followsBody(moon), A, 'seguidores').next, { atMs: 0, key: B }, 'a pre-1970 row clamps to atMs 0')
  t.alike(validFollows(followsBody(), A, 'seguidores', FCURSOR), followsBody(), 'rows after the request cursor')
  const keyOf = (i) => (i + 16).toString(16).padStart(2, '0').repeat(32)
  const page = (n) => {
    const items = Array.from({ length: n }, (_, i) => ({ key: keyOf(i), seq: 1, at: AT1 }))
    const authors = Object.fromEntries(items.map((it) => [it.key, { profileSeq: null, usernameSeq: 1 }]))
    return followsBody({ items, authors, total: n, next: null })
  }
  t.is(validFollows(page(20), A, 'seguidores').items.length, 20, '20 items')
  const missingKey = followsBody()
  delete missingKey.total
  const hintsBC = { [B]: { profileSeq: 1, usernameSeq: null }, [C]: { profileSeq: null, usernameSeq: null } }
  const bad = [
    followsBody({ extra: 1 }),
    missingKey,
    followsBody({ author: B }),
    followsBody({ author: A.toUpperCase() }),
    followsBody({ kind: 'seguindo' }),
    followsBody({ kind: 'Seguidores' }),
    page(21),
    followsBody({ items: [{ key: B, seq: 9, at: AT1 }, { key: B, seq: 3, at: AT2 }], authors: { [B]: hintsBC[B] } }),
    followsBody({ items: [{ key: A, seq: 9, at: AT1 }, { key: C, seq: 4, at: AT2 }], authors: { [A]: hintsBC[B], [C]: hintsBC[C] } }),
    followsBody({ items: [{ key: B.toUpperCase(), seq: 9, at: AT1 }, { key: C, seq: 4, at: AT2 }], authors: { [B.toUpperCase()]: hintsBC[B], [C]: hintsBC[C] } }),
    followsBody({ items: [{ key: 'zz'.repeat(32), seq: 9, at: AT1 }, { key: C, seq: 4, at: AT2 }], authors: { ['zz'.repeat(32)]: hintsBC[B], [C]: hintsBC[C] } }),
    followsBody({ items: [{ key: B, seq: 0, at: AT1 }, { key: C, seq: 4, at: AT2 }] }),
    followsBody({ items: [{ key: B, seq: 1.5, at: AT1 }, { key: C, seq: 4, at: AT2 }] }),
    followsBody({ items: [{ key: B, seq: 9, at: '2026-10-20T10:00:00Z' }, { key: C, seq: 4, at: AT2 }] }),
    followsBody({ items: [{ key: B, seq: 9, at: 'x' }, { key: C, seq: 4, at: AT2 }] }),
    followsBody({ items: [{ key: B, seq: 9, at: AT1, extra: 1 }, { key: C, seq: 4, at: AT2 }] }),
    followsBody({ items: [{ key: B, seq: 9 }, { key: C, seq: 4, at: AT2 }] }),
    followsBody({ items: [B + ':9', C + ':4'] }),
    followsBody({ items: 'x' }),
    followsBody({ next: 'x' }),
    followsBody({ next: { atMs: -1, key: C } }),
    followsBody({ next: { atMs: 1.5, key: C } }),
    followsBody({ next: { atMs: 1, key: 'zz'.repeat(32) } }),
    followsBody({ next: { atMs: 1, key: C, extra: 1 } }),
    followsBody({ total: -1 }),
    followsBody({ total: 2.5 }),
    followsBody({ total: '7' }),
    followsBody({ total: 1 }),
    followsBody({ indexing: 'no' }),
    followsBody({ complete: null }),
    followsBody({ authors: { [B]: hintsBC[B] } }),
    followsBody({ authors: { ...hintsBC, [A]: { profileSeq: 1, usernameSeq: 1 } } }),
    followsBody({ authors: { [B]: { profileSeq: 1, usernameSeq: null, extra: 1 }, [C]: hintsBC[C] } }),
    followsBody({ authors: { [B]: { profileSeq: 0, usernameSeq: null }, [C]: hintsBC[C] } }),
    followsBody({ authors: [] }),
    null,
    []
  ]
  for (const body of bad) t.is(validFollows(body, A, 'seguidores'), null, JSON.stringify(body).slice(0, 100))

  // A seeder cannot make the reader page backwards or forever.
  const backwards = [
    followsBody({ next: { atMs: Date.parse(AT1), key: B } }),
    followsBody({ next: { atMs: Date.parse(AT2) + 1, key: C } }),
    followsBody({ items: [], authors: {}, total: 7 }),
    followsBody({ items: [{ key: C, seq: 4, at: AT2 }, { key: B, seq: 9, at: AT1 }], next: { atMs: Date.parse(AT1), key: B } }),
    followsBody({ items: [{ key: C, seq: 4, at: AT1 }, { key: B, seq: 9, at: AT1 }], next: { atMs: Date.parse(AT1), key: B } })
  ]
  for (const body of backwards) t.is(validFollows(body, A, 'seguidores'), null, 'order ' + JSON.stringify(body.items.map((i) => i.key.slice(0, 2))) + ' next ' + JSON.stringify(body.next))
  t.is(validFollows(followsBody(), A, 'seguidores', { atMs: Date.parse(AT2), key: A }), null, 'rows before the request cursor')
  t.is(validFollows(followsBody(), A, 'seguidores', { atMs: Date.parse(AT1), key: B }), null, 'the cursor row itself again')
})

test('fetchFollowCounts and fetchFollows: request options, contract, a fresh copy and transport', async (t) => {
  const { fetchFollowCounts, fetchFollows, validFollows } = await load()
  const calls = []
  const counts = await fetchFollowCounts(A.toUpperCase(), {
    fetch: async (url, opts) => {
      calls.push({ url, opts })
      return response(JSON.stringify(countsBody()))
    }
  })
  t.alike(counts, { ok: true, value: countsBody() })
  t.is(calls[0].url, '/index/follows/' + A)
  const parsed = followsBody()
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(parsed))
  }
  const res = await fetchFollows(A.toUpperCase(), 'seguidores', FCURSOR, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, followsBody())
  t.is(calls[1].url, '/index/follows/' + A + '/seguidores/1800000000000.' + C)
  for (const c of calls) {
    t.is(c.opts.method, 'GET')
    t.is(c.opts.credentials, 'omit')
    t.is(c.opts.redirect, 'error')
    t.is(c.opts.cache, 'no-store')
    t.ok(c.opts.signal, 'abortable')
  }
  const own = followsBody()
  const copy = validFollows(own, A, 'seguidores')
  copy.items[0].seq = 99
  copy.next.atMs = 1
  copy.authors[B].profileSeq = 99
  t.is(own.items[0].seq, 9, 'items copied')
  t.is(own.next.atMs, Date.parse(AT2), 'cursor copied')
  t.is(own.authors[B].profileSeq, 1, 'hints copied')
  for (const body of [followsBody({ extra: 1 }), followsBody({ author: B }), followsBody({ kind: 'seguindo' }), followsBody({ total: 1 })]) {
    t.alike(await fetchFollows(A, 'seguidores', null, { fetch: json(body) }), { ok: false, reason: 'malformed' }, JSON.stringify(body).slice(0, 80))
  }
  t.alike(await fetchFollowCounts(A, { fetch: json(countsBody({ extra: 1 })) }), { ok: false, reason: 'malformed' })
  const text = JSON.stringify(followsBody())
  t.is((await fetchFollows(A, 'seguidores', null, { fetch: async () => response(text, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchFollows(A, 'seguidores', null, { fetch: async () => response(text, { redirected: true }) })).reason, 'status')
  const big = response(JSON.stringify(followsBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchFollows(A, 'seguidores', null, { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled, 'oversized read is cancelled')
  const bigCounts = response(JSON.stringify(countsBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchFollowCounts(A, { fetch: async () => bigCounts })).reason, 'too-large')
  // Last: the cooldown a 429 sets outlives the remaining calls.
  const limited = await fetchFollows(A, 'seguindo', null, { fetch: async () => response(text, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs), 'with the cooldown left')
  const limitedCounts = await fetchFollowCounts(A, { fetch: async () => response('', { status: 429 }) })
  t.is(limitedCounts.reason, 'rate-limited', 'counts share the cooldown')
})

test('with an installation set, every index URL is absolute on that origin only', async (t) => {
  const { postUrl, countsUrl, memberUrl, topicUrl, engagersUrl, searchUrl, communityGroupsUrl, fetchCounts, fetchMember } = await load()
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
  t.is(communityGroupsUrl(C, A), O + '/index/community/' + C + '/groups/' + A)
  t.is(postUrl('bad'), null, 'bad input still refused')
  const urls = []
  const good = { counts: {}, indexing: false, complete: true }
  await fetchCounts([REF], { fetch: async (url) => { urls.push(url); return response(JSON.stringify(good)) } })
  t.alike(urls, [O + '/index/counts/' + REF])
  const fetch = async (url) => { urls.push(url); return response(JSON.stringify({ members: [complete(), complete()] })) }
  t.ok((await Promise.all([A, B].map((a) => fetchMember(a, null, { fetch })))).every((r) => r.ok))
  t.is(urls[1], O + '/index/members/' + A + ',' + B)
  setInstallation(null)
  t.is(postUrl(REF), '/index/post/' + A + '/5', 'relative again once cleared')
})

function groupBody (over = {}) {
  return {
    kind: 'group',
    visibility: 'public',
    join: 'open',
    name: 'Praia',
    creator: A,
    rootServed: true,
    community: null,
    attached: false,
    writers: [
      { key: A, diary: A, length: 4, signed: 5, seq: 1, left: false },
      { key: B, diary: C, length: 2, signed: 2, seq: 3, left: true }
    ],
    next: null,
    indexing: false,
    complete: true,
    ...over
  }
}

test('group URL builders lowercase and refuse anything else', async (t) => {
  const { groupUrl, groupsUrl, communityUrl, communityGroupsUrl, groupSearchUrl } = await load()
  t.is(groupUrl(A), '/index/group/' + A)
  t.is(groupUrl(A.toUpperCase(), B), '/index/group/' + A + '/' + B)
  t.is(groupsUrl(A.toUpperCase()), '/index/groups/' + A)
  t.is(communityUrl(C), '/index/community/' + C)
  t.is(communityGroupsUrl(C.toUpperCase(), A.toUpperCase()), '/index/community/' + C + '/groups/' + A)
  t.is(groupSearchUrl('praia-azul'), '/index/group-search/praia-azul')
  for (const bad of [null, 7, 'zz'.repeat(32), A + '/..', A.slice(2)]) {
    t.is(groupUrl(bad), null)
    t.is(groupsUrl(bad), null)
    t.is(communityUrl(bad), null)
    t.is(communityGroupsUrl(bad, A), null)
    t.is(communityGroupsUrl(C, bad), null)
  }
  t.is(communityGroupsUrl(C), null, 'a cursor is required')
  t.is(communityGroupsUrl(C, A + '/x'), null)
  t.is(groupUrl(A, 'nope'), null)
  t.is(groupUrl(A, A + '/x'), null)
  for (const bad of ['a', 'Praia', 'a-', 'x y', '', 'a--b', null, 'a-b-c-d-e']) t.is(groupSearchUrl(bad), null, String(bad))
})

test('fetchGroup: request, exact shape, older seeder without signed', async (t) => {
  const { fetchGroup } = await load()
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(groupBody({ next: C })))
  }
  const res = await fetchGroup(A, null, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, groupBody({ next: C }))
  t.is(calls[0].url, '/index/group/' + A)
  t.is(calls[0].opts.credentials, 'omit')
  t.is((await fetchGroup(A, null, { fetch: json(groupBody({ community: C, attached: true })) })).value.attached, true)
  const old = groupBody()
  old.writers = old.writers.map(({ signed, ...w }) => w)
  const res2 = await fetchGroup(A, null, { fetch: json(old) })
  t.is(res2.value.writers[0].signed, 4, 'signed defaults to length')
  const paged = await fetchGroup(A, A, { fetch: json(groupBody({ writers: [{ key: B, diary: B, length: 1, signed: 1, seq: 1, left: false }] })) })
  t.is(paged.ok, true)
  t.is((await fetchGroup(A, 'bad', { fetch })).reason, 'invalid-input')
})

test('fetchGroup refuses malformed JSON whole', async (t) => {
  const { fetchGroup } = await load()
  const w = (over) => ({ key: A, diary: A, length: 1, signed: 1, seq: 1, left: false, ...over })
  const bad = [
    groupBody({ extra: 1 }),
    groupBody({ kind: 'other' }),
    groupBody({ visibility: 'secret' }),
    groupBody({ join: 'closed' }),
    groupBody({ visibility: 'private', name: 'Segredo' }),
    groupBody({ name: 7 }),
    groupBody({ name: '' }),
    groupBody({ name: 'x'.repeat(81) }),
    groupBody({ creator: A.toUpperCase() }),
    groupBody({ community: 'ab' }),
    groupBody({ attached: null }),
    groupBody({ attached: 1 }),
    groupBody({ attached: 'true' }),
    groupBody({ attached: undefined }),
    groupBody({ next: 'ab' }),
    groupBody({ rootServed: 'yes' }),
    groupBody({ indexing: 1 }),
    groupBody({ writers: 'x' }),
    groupBody({ writers: Array.from({ length: 65 }, (_, i) => w({ key: String(i).padStart(64, '0') })) }),
    groupBody({ writers: [w({ extra: 1 })] }),
    groupBody({ writers: [w({ key: 'ab' })] }),
    groupBody({ writers: [w({ diary: 7 })] }),
    groupBody({ writers: [w({ left: 0 })] }),
    groupBody({ writers: [w({ length: -1 })] }),
    groupBody({ writers: [w({ seq: 0 })] }),
    groupBody({ writers: [w({ length: 5, signed: 4 })] }),
    groupBody({ writers: [w({ key: B }), w({ key: A })] }),
    groupBody({ writers: [w({ key: A }), w({ key: A })] })
  ]
  for (const body of bad) t.is((await fetchGroup(A, null, { fetch: json(body) })).reason, 'malformed', JSON.stringify(body).slice(0, 90))
  const mixed = groupBody({ writers: [w(), { key: B, diary: B, length: 1, seq: 1, left: false }] })
  t.is((await fetchGroup(A, null, { fetch: json(mixed) })).ok, true, 'older rows may omit signed')
  t.is((await fetchGroup(A, B, { fetch: json(groupBody()) })).reason, 'malformed', 'a row at or before the cursor is refused')
  t.is((await fetchGroup(A, null, { fetch: json([]) })).reason, 'malformed')
  t.is((await fetchGroup(A, null, { fetch: async () => response('{') })).reason, 'malformed')
  t.is((await fetchGroup(A, null, { fetch: json(groupBody(), { status: 404 }) })).reason, 'not-found')
  const nulls = groupBody({ kind: null, visibility: null, join: null, name: null, creator: null, rootServed: false, writers: [], complete: false })
  t.is((await fetchGroup(A, null, { fetch: json(nulls) })).ok, true, 'an unverified root has null header fields')
})

test('fetchGroups: one row per group, caps, distinct', async (t) => {
  const { fetchGroups } = await load()
  const body = { groups: [{ group: A, writer: B, seq: 2, left: false }, { group: C, writer: B, seq: 1, left: true }], indexing: false, complete: true }
  const calls = []
  const res = await fetchGroups(A, { fetch: async (url) => { calls.push(url); return response(JSON.stringify(body)) } })
  t.alike(res, { ok: true, value: body })
  t.is(calls[0], '/index/groups/' + A)
  const row = (i) => ({ group: String(i).padStart(64, '0'), writer: B, seq: 1, left: false })
  t.is((await fetchGroups(A, { fetch: json({ ...body, groups: Array.from({ length: 64 }, (_, i) => row(i)) }) })).ok, true)
  const bad = [
    { ...body, groups: Array.from({ length: 65 }, (_, i) => row(i)) },
    { ...body, groups: [row(1), row(1)] },
    { ...body, groups: [{ ...row(1), extra: 1 }] },
    { ...body, groups: [{ ...row(1), seq: 0 }] },
    { ...body, groups: [{ ...row(1), left: 'no' }] },
    { ...body, groups: [{ group: A, writer: 'x', seq: 1, left: false }] },
    { ...body, complete: 'yes' },
    { groups: body.groups, indexing: false }
  ]
  for (const b of bad) t.is((await fetchGroups(A, { fetch: json(b) })).reason, 'malformed', JSON.stringify(b).slice(0, 80))
  t.is((await fetchGroups('x', { fetch: json(body) })).reason, 'invalid-input')
})

test('validGroupSearch: public hits only, cap 20, null name allowed', async (t) => {
  const { validGroupSearch } = await load()
  const body = { groups: [{ group: A, name: 'Praia', writerCount: 3 }, { group: B, name: null, writerCount: 0 }], more: false, indexing: false, complete: true }
  t.alike(validGroupSearch(body), body)
  const hit = (i) => ({ group: String(i).padStart(64, '0'), name: 'n', writerCount: 1 })
  t.ok(validGroupSearch({ ...body, groups: Array.from({ length: 20 }, (_, i) => hit(i)) }))
  const bad = [
    { ...body, groups: Array.from({ length: 21 }, (_, i) => hit(i)) },
    { ...body, groups: [hit(1), hit(1)] },
    { ...body, groups: [{ ...hit(1), visibility: 'private' }] },
    { ...body, groups: [{ group: A, visibility: 'private' }] },
    { ...body, groups: [{ ...hit(1), writerCount: -1 }] },
    { ...body, groups: [{ ...hit(1), name: 4 }] },
    { ...body, groups: [{ ...hit(1), creator: A }] },
    { ...body, more: 'no' },
    { groups: body.groups, indexing: false, complete: true }
  ]
  for (const b of bad) t.is(validGroupSearch(b), null, JSON.stringify(b).slice(0, 80))
})

function communityRow (over = {}) {
  return { group: A, visibility: 'public', join: 'open', name: 'Praia', writerCount: 3, ...over }
}

function communityBody (over = {}) {
  return {
    name: 'Cais',
    join: 'open',
    creator: C,
    members: 2,
    groups: [communityRow(), communityRow({ group: B, visibility: 'private', join: 'approval', name: null, writerCount: null })],
    next: B,
    indexing: false,
    complete: true,
    ...over
  }
}

function badCommunityRows () {
  const row = communityRow()
  return [
    null,
    'x',
    Array.from({ length: 33 }, (_, i) => communityRow({ group: i.toString(16).padStart(64, '0') })),
    [row, row],
    [communityRow({ group: B }), row],
    [null],
    [{ ...row, extra: 1 }],
    [{ group: A, visibility: 'private' }],
    [{ group: A, name: 'Praia', writerCount: 3 }],
    [{ group: A }],
    ...['group', 'visibility', 'join', 'name', 'writerCount'].map((key) => [Object.fromEntries(Object.entries(row).filter(([k]) => k !== key))]),
    ...['ab', A.toUpperCase(), null, 7].map((group) => [communityRow({ group })]),
    ...['secret', null, 7].map((visibility) => [communityRow({ visibility })]),
    ...['closed', null, 7].map((join) => [communityRow({ join })]),
    ...[3, '', 'x'.repeat(81)].map((name) => [communityRow({ name })]),
    ...[-1, 0.5, '3', null, Number.MAX_SAFE_INTEGER + 1].map((writerCount) => [communityRow({ writerCount })]),
    [communityRow({ visibility: 'private', name: 'Segredo', writerCount: null })],
    [communityRow({ visibility: 'private', name: null, writerCount: 2 })]
  ]
}

test('fetchCommunity: uniform public and private rows, exact response and copies', async (t) => {
  const { fetchCommunity, validCommunity } = await load()
  const body = communityBody()
  const calls = []
  const res = await fetchCommunity(C, { fetch: async (url) => { calls.push(url); return response(JSON.stringify(body)) } })
  t.alike(res, { ok: true, value: body })
  t.is(calls[0], '/index/community/' + C)
  const copy = validCommunity(body)
  copy.groups[0].name = 'Outra'
  copy.groups.push(communityRow({ group: C }))
  t.is(body.groups.length, 2)
  t.is(body.groups[0].name, 'Praia')
  for (const groups of badCommunityRows()) {
    t.is((await fetchCommunity(C, { fetch: json(communityBody({ groups })) })).reason, 'malformed')
  }
  t.is((await fetchCommunity('nope', { fetch: json(body) })).reason, 'invalid-input')
})

test('validCommunity: nullable header, counts, flags, cursor and exact keys', async (t) => {
  const { validCommunity, COMMUNITY_GROUPS_MAX } = await load()
  t.is(COMMUNITY_GROUPS_MAX, 32)
  const full = Array.from({ length: 32 }, (_, i) => communityRow({ group: i.toString(16).padStart(64, '0') }))
  for (const body of [communityBody(), communityBody({ name: null, join: null, creator: null, members: 0, next: null, groups: [], indexing: true, complete: false }), communityBody({ join: 'approval', groups: full, next: full[31].group }), communityBody({ groups: [communityRow({ name: null, writerCount: 0 })], next: A })]) {
    t.alike(validCommunity(body), body)
  }
  const body = communityBody()
  const bad = [
    null, [], { ...body, extra: 1 },
    ...Object.keys(body).map((key) => Object.fromEntries(Object.entries(body).filter(([k]) => k !== key))),
    ...[4, '', 'x'.repeat(81)].map((name) => communityBody({ name })),
    ...['closed', 7].map((join) => communityBody({ join })),
    ...[A.toUpperCase(), 'ab', 7].map((creator) => communityBody({ creator })),
    ...[-1, 0.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map((members) => communityBody({ members })),
    ...['ab', A.toUpperCase(), 7].map((next) => communityBody({ next })),
    communityBody({ next: A }), communityBody({ next: C }), communityBody({ groups: [], next: B }),
    communityBody({ indexing: 'no' }), communityBody({ complete: 1 }),
    ...badCommunityRows().map((groups) => communityBody({ groups }))
  ]
  for (const value of bad) t.is(validCommunity(value), null, JSON.stringify(value).slice(0, 100))
})

test('validCommunityGroups: bounded sorted rows strictly after the cursor', async (t) => {
  const { validCommunityGroups } = await load()
  const body = { groups: [communityRow({ group: B })], next: B, indexing: false, complete: true }
  t.alike(validCommunityGroups(body, A), body)
  const empty = { groups: [], next: null, indexing: true, complete: false }
  t.alike(validCommunityGroups(empty, A), empty)
  const fullRows = Array.from({ length: 32 }, (_, i) => communityRow({ group: (i + 1).toString(16).padStart(64, '0') }))
  const full = { ...body, groups: fullRows, next: fullRows[31].group }
  t.alike(validCommunityGroups(full, '0'.repeat(64)), full)
  const privatePage = { ...body, groups: [communityRow({ group: B, visibility: 'private', join: 'approval', name: null, writerCount: null })] }
  t.alike(validCommunityGroups(privatePage, A), privatePage)
  const copy = validCommunityGroups(body, A)
  copy.groups[0].name = 'Outra'
  copy.groups.push(communityRow({ group: C }))
  t.is(body.groups[0].name, 'Praia')
  t.is(body.groups.length, 1)
  const bad = [
    null, [], { ...body, extra: 1 },
    ...Object.keys(body).map((key) => Object.fromEntries(Object.entries(body).filter(([k]) => k !== key))),
    ...badCommunityRows().map((groups) => ({ ...body, groups })),
    { ...body, groups: [communityRow()] },
    { ...body, indexing: 1 }, { ...body, complete: 'yes' },
    ...['ab', B.toUpperCase(), 7].map((next) => ({ ...body, next })),
    { ...body, next: C }, { ...empty, next: B }
  ]
  for (const value of bad) t.is(validCommunityGroups(value, A), null)
  t.is(validCommunityGroups(body, B), null, 'equal to cursor')
  t.is(validCommunityGroups(body, C), null, 'before cursor')
  for (const cursor of [undefined, null, 7, 'ab', A.toUpperCase()]) t.is(validCommunityGroups(empty, cursor), null, 'invalid cursor')
})

test('fetchCommunityGroups: request options, validation, transport and timeout', async (t) => {
  const { fetchCommunityGroups } = await load()
  const body = { groups: [communityRow({ group: B })], next: B, indexing: false, complete: true }
  const calls = []
  const fetch = async (url, opts) => { calls.push({ url, opts }); return response(JSON.stringify(body)) }
  t.alike(await fetchCommunityGroups(C.toUpperCase(), A.toUpperCase(), { fetch }), { ok: true, value: body })
  t.is(calls[0].url, '/index/community/' + C + '/groups/' + A)
  const opts = calls[0].opts
  t.is(opts.method, 'GET')
  t.is(opts.credentials, 'omit')
  t.is(opts.redirect, 'error')
  t.is(opts.cache, 'no-store')
  t.is(opts.headers.Accept, 'application/json')
  t.ok(opts.signal)
  t.is((await fetchCommunityGroups(C, A, { fetch })).ok, true)
  t.is(calls.length, 2, 'never cached')
  for (const [community, cursor] of [['bad', A], [C, null], [C, 'bad']]) {
    t.alike(await fetchCommunityGroups(community, cursor, { fetch }), { ok: false, reason: 'invalid-input' })
  }
  t.is(calls.length, 2, 'invalid input makes no request')
  t.is((await fetchCommunityGroups(C, B, { fetch })).reason, 'malformed', 'response is checked against the cursor')
  t.is((await fetchCommunityGroups(C, A, { fetch: async () => response('{') })).reason, 'malformed')
  t.is((await fetchCommunityGroups(C, A, { fetch: json(body, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchCommunityGroups(C, A, { fetch: json(body, { redirected: true }) })).reason, 'status')
  t.is((await fetchCommunityGroups(C, A, { fetch: async () => { throw new Error('offline') } })).reason, 'network')
  const big = response('x'.repeat(70000))
  t.is((await fetchCommunityGroups(C, A, { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled)
  let signal
  const timeout = await fetchCommunityGroups(C, A, { timeoutMs: 10, fetch: (url, opts) => { signal = opts.signal; return new Promise(() => {}) } })
  t.is(timeout.reason, 'timeout')
  t.ok(signal.aborted)
  const limited = await fetchCommunityGroups(C, A, { fetch: json(body, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs))
})

const hexOf = (i) => String(i).padStart(64, '0')

function browseRow (over = {}) {
  return { group: A, name: 'Geral', creator: B, community: C, communityName: 'Praia', writerCount: 3, created: null, active: null, ...over }
}

function publicRow (over = {}) {
  return { group: A, name: 'Geral', creator: B, community: C, communityName: 'Praia', writerCount: 3, ...over }
}

test('discovery URL builders: browse orders, public groups of a diary, topic trend', async (t) => {
  const { groupBrowseUrl, publicGroupsUrl, topicTrendUrl } = await load()
  for (const order of ['members', 'recent', 'trending']) t.is(groupBrowseUrl(order), '/index/group-browse/' + order)
  for (const bad of ['Members', 'popular', '', null, 7, 'members/..', undefined]) t.is(groupBrowseUrl(bad), null, String(bad))
  t.is(publicGroupsUrl(A.toUpperCase()), '/index/public-groups/' + A)
  t.is(publicGroupsUrl(A, B.toUpperCase()), '/index/public-groups/' + A + '/' + B)
  for (const bad of [null, 7, 'zz'.repeat(32), A + '/..', A.slice(2)]) {
    t.is(publicGroupsUrl(bad), null)
    t.is(publicGroupsUrl(A, bad === null ? 'nope' : bad), null)
  }
  t.is(topicTrendUrl(), '/index/topic-trend')
})

test('validGroupBrowse: members order, exact rows, cap 20', async (t) => {
  const { validGroupBrowse } = await load()
  const body = {
    groups: [
      browseRow({ group: C, writerCount: 9, created: 1761000000000 }),
      browseRow({ group: A, writerCount: 4, communityName: 'Feira' }),
      browseRow({ group: B, writerCount: 4 })
    ],
    more: true,
    indexing: false,
    complete: true
  }
  t.alike(validGroupBrowse(body, 'members'), body)
  const copy = validGroupBrowse(body, 'members')
  t.not(copy.groups[0], body.groups[0], 'fresh copy')
  const full = { ...body, groups: Array.from({ length: 20 }, (_, i) => browseRow({ group: hexOf(i), writerCount: 1 })) }
  t.alike(validGroupBrowse(full, 'members'), full)
  const empty = { groups: [], more: false, indexing: true, complete: false }
  t.alike(validGroupBrowse(empty, 'members'), empty)
  const bad = [
    { ...body, extra: 1 },
    { groups: body.groups, indexing: false, complete: true },
    { ...body, more: 'no' },
    { ...body, indexing: 1 },
    { ...body, groups: Array.from({ length: 21 }, (_, i) => browseRow({ group: hexOf(i), writerCount: 1 })) },
    { ...body, groups: [{ ...browseRow(), extra: 1 }] },
    { ...body, groups: [(() => { const r = browseRow(); delete r.active; return r })()] },
    { ...body, groups: [browseRow({ name: null })] },
    { ...body, groups: [browseRow({ name: '' })] },
    { ...body, groups: [browseRow({ communityName: null })] },
    { ...body, groups: [browseRow({ name: 'x'.repeat(81) })] },
    { ...body, groups: [browseRow({ writerCount: 0 })] },
    { ...body, groups: [browseRow({ writerCount: 1.5 })] },
    { ...body, groups: [browseRow({ group: A.toUpperCase() })] },
    { ...body, groups: [browseRow({ creator: 'x' })] },
    { ...body, groups: [browseRow({ community: null })] },
    { ...body, groups: [browseRow({ created: -1 })] },
    { ...body, groups: [browseRow({ created: '1' })] },
    { ...body, groups: [browseRow({ created: 8640000000000001 })] },
    { ...body, groups: [browseRow({ active: 1 })] },
    { ...body, groups: [browseRow(), browseRow()] },
    { ...body, groups: [browseRow({ group: A, writerCount: 2 }), browseRow({ group: B, writerCount: 3 })] },
    { ...body, groups: [browseRow({ group: B, writerCount: 3 }), browseRow({ group: A, writerCount: 3 })] },
    { ...body, groups: {} },
    null,
    []
  ]
  for (const b of bad) t.is(validGroupBrowse(b, 'members'), null, JSON.stringify(b).slice(0, 80))
  for (const order of ['popular', null, undefined]) t.is(validGroupBrowse(body, order), null, 'unknown order')
})

test('validGroupBrowse: recent order, at most 2 per creator', async (t) => {
  const { validGroupBrowse } = await load()
  const body = {
    groups: [
      browseRow({ group: C, created: 1761000300000 }),
      browseRow({ group: A, created: 1761000000000 }),
      browseRow({ group: B, created: 1761000000000, creator: C }),
      browseRow({ group: hexOf(1), created: 0, creator: C })
    ],
    more: false,
    indexing: false,
    complete: true
  }
  t.alike(validGroupBrowse(body, 'recent'), body)
  t.is(validGroupBrowse(body, 'members'), null, 'members: ties by group key up')
  const bad = [
    { ...body, groups: [browseRow({ group: A, created: 1 }), browseRow({ group: B, created: 2 })] },
    { ...body, groups: [browseRow({ group: B, created: 2 }), browseRow({ group: A, created: 2 })] },
    { ...body, groups: [browseRow({ created: null })] },
    { ...body, groups: [browseRow({ created: 5, active: 1 })] },
    { ...body, groups: [browseRow({ group: A, created: 3 }), browseRow({ group: B, created: 2 }), browseRow({ group: C, created: 1 })] },
    { ...body, groups: [browseRow({ created: 8640000000000001 })] }
  ]
  for (const b of bad) t.is(validGroupBrowse(b, 'recent'), null, JSON.stringify(b).slice(0, 80))
  t.ok(validGroupBrowse(bad[4], 'members'), 'three of one creator are fine outside recent')
})

test('validGroupBrowse: trending order, 1 <= active <= writerCount', async (t) => {
  const { validGroupBrowse } = await load()
  const body = {
    groups: [
      browseRow({ group: C, active: 5, writerCount: 9 }),
      browseRow({ group: A, active: 2, writerCount: 2, created: 1761000000000 }),
      browseRow({ group: B, active: 2, writerCount: 7 })
    ],
    more: false,
    indexing: false,
    complete: true
  }
  t.alike(validGroupBrowse(body, 'trending'), body)
  t.is(validGroupBrowse(body, 'members'), null)
  t.is(validGroupBrowse(body, 'recent'), null)
  const bad = [
    { ...body, groups: [browseRow({ active: 4, writerCount: 3 })] },
    { ...body, groups: [browseRow({ active: 0 })] },
    { ...body, groups: [browseRow({ active: null })] },
    { ...body, groups: [browseRow({ active: 1.5 })] },
    { ...body, groups: [browseRow({ active: 1, created: 'x' })] },
    { ...body, groups: [browseRow({ group: A, active: 1 }), browseRow({ group: B, active: 2 })] },
    { ...body, groups: [browseRow({ group: B, active: 2 }), browseRow({ group: A, active: 2 })] }
  ]
  for (const b of bad) t.is(validGroupBrowse(b, 'trending'), null, JSON.stringify(b).slice(0, 80))
})

test('validPublicGroups: ascending rows after the cursor, next, hidden', async (t) => {
  const { validPublicGroups } = await load()
  const body = { groups: [publicRow({ group: A }), publicRow({ group: B, communityName: 'Feira' })], next: B, hidden: false, indexing: false, complete: true }
  t.alike(validPublicGroups(body), body)
  t.alike(validPublicGroups(body, hexOf(1)), body)
  const copy = validPublicGroups(body)
  t.not(copy.groups[0], body.groups[0], 'fresh copy')
  const last = { ...body, next: null }
  t.alike(validPublicGroups(last), last)
  const hidden = { groups: [], next: null, hidden: true, indexing: false, complete: true }
  t.alike(validPublicGroups(hidden), hidden)
  const full = { ...body, groups: Array.from({ length: 32 }, (_, i) => publicRow({ group: hexOf(i) })), next: hexOf(31) }
  t.alike(validPublicGroups(full), full)
  const bad = [
    { ...body, extra: 1 },
    (() => { const b = { ...body }; delete b.hidden; return b })(),
    { ...body, hidden: 'no' },
    { ...body, hidden: true },
    { ...hidden, next: A },
    { ...body, complete: null },
    { ...body, next: C },
    { ...body, next: A },
    { ...body, next: 'x' },
    { ...body, groups: [], next: A },
    { ...body, groups: Array.from({ length: 33 }, (_, i) => publicRow({ group: hexOf(i) })), next: null },
    { ...body, groups: [publicRow({ group: B }), publicRow({ group: A })], next: null },
    { ...body, groups: [publicRow({ group: A }), publicRow({ group: A })], next: null },
    { ...body, groups: [{ ...publicRow(), created: 1 }], next: null },
    { ...body, groups: [publicRow({ name: null })], next: null },
    { ...body, groups: [publicRow({ communityName: '' })], next: null },
    { ...body, groups: [publicRow({ writerCount: 0 })], next: null },
    { ...body, groups: [publicRow({ creator: null })], next: null },
    null
  ]
  for (const b of bad) t.is(validPublicGroups(b), null, JSON.stringify(b).slice(0, 80))
  t.is(validPublicGroups(body, A), null, 'row equal to the cursor')
  t.is(validPublicGroups(body, C), null, 'row before the cursor')
  t.is(validPublicGroups(body, 'x'), null, 'invalid cursor')
})

test('validTopicTrend: folded tags, authors down, cap 10', async (t) => {
  const { validTopicTrend } = await load()
  const body = { topics: [{ tag: 'feira', authors: 3 }, { tag: 'praia', authors: 1 }, { tag: 'sol2026', authors: 1 }], indexing: false, complete: true }
  t.alike(validTopicTrend(body), body)
  t.not(validTopicTrend(body).topics[0], body.topics[0], 'fresh copy')
  const empty = { topics: [], indexing: true, complete: false }
  t.alike(validTopicTrend(empty), empty)
  const tag = (i) => 'tag' + String(i).padStart(2, '0')
  const full = { ...body, topics: Array.from({ length: 10 }, (_, i) => ({ tag: tag(i), authors: 1 })) }
  t.alike(validTopicTrend(full), full)
  const bad = [
    { ...body, extra: 1 },
    { topics: body.topics, indexing: false },
    { ...body, indexing: 'no' },
    { ...body, topics: Array.from({ length: 11 }, (_, i) => ({ tag: tag(i), authors: 1 })) },
    { ...body, topics: [{ tag: '#feira', authors: 1 }] },
    { ...body, topics: [{ tag: 'a', authors: 1 }] },
    { ...body, topics: [{ tag: 'Feira', authors: 1 }] },
    { ...body, topics: [{ tag: 'x'.repeat(33), authors: 1 }] },
    { ...body, topics: [{ tag: 7, authors: 1 }] },
    { ...body, topics: [{ tag: 'feira', authors: 0 }] },
    { ...body, topics: [{ tag: 'feira', authors: 1.5 }] },
    { ...body, topics: [{ tag: 'feira', authors: 1, at: 1 }] },
    { ...body, topics: [{ tag: 'praia', authors: 1 }, { tag: 'feira', authors: 2 }] },
    { ...body, topics: [{ tag: 'praia', authors: 1 }, { tag: 'feira', authors: 1 }] },
    { ...body, topics: [{ tag: 'feira', authors: 2 }, { tag: 'feira', authors: 1 }] },
    { ...body, topics: [{ tag: 'feira', authors: 1 }, { tag: 'feira', authors: 1 }] },
    { ...body, topics: {} },
    null
  ]
  for (const b of bad) t.is(validTopicTrend(b), null, JSON.stringify(b).slice(0, 80))
})

test('fetchTopicTrend: request, validation, transport', async (t) => {
  const { fetchTopicTrend } = await load()
  const body = { topics: [{ tag: 'feira', authors: 2 }], indexing: false, complete: true }
  const calls = []
  const fetch = async (url, opts) => { calls.push({ url, opts }); return response(JSON.stringify(body)) }
  t.alike(await fetchTopicTrend({ fetch }), { ok: true, value: body })
  t.is(calls[0].url, '/index/topic-trend')
  t.is(calls[0].opts.credentials, 'omit')
  t.is((await fetchTopicTrend({ fetch: json({ ...body, topics: [{ tag: '#feira', authors: 2 }] }) })).reason, 'malformed')
  t.is((await fetchTopicTrend({ fetch: json(body, { status: 404 }) })).reason, 'not-found')
  const limited = await fetchTopicTrend({ fetch: json(body, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs))
})

const testimonialsBody = (over = {}) => ({
  shown: [{ seq: 9, from: B, wseq: 4 }, { seq: 7, from: C, wseq: 2 }],
  pending: [{ from: B, seq: 6 }],
  indexing: false,
  complete: true,
  ...over
})

test('testimonialsUrl: exact path, owner lowercased, bad owner is null', async (t) => {
  const { testimonialsUrl, fetchTestimonials, TESTIMONIALS_MAX } = await load()
  t.is(TESTIMONIALS_MAX, 64)
  t.is(testimonialsUrl(A), '/index/testimonials/' + A)
  t.is(testimonialsUrl(A.toUpperCase()), '/index/testimonials/' + A, 'owner lowercased')
  for (const owner of [A + 'a', 'zz'.repeat(32), A + '/x', '', null, 7]) {
    t.is(testimonialsUrl(owner), null, 'owner ' + String(owner))
  }
  let called = false
  t.alike(await fetchTestimonials('nope', { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.absent(called, 'no request for bad input')
})

test('validTestimonials: exact shape, lowercase keys, positive seqs, caps and no repeats', async (t) => {
  const { validTestimonials } = await load()
  t.alike(validTestimonials(testimonialsBody(), A), testimonialsBody())
  t.alike(validTestimonials(testimonialsBody({ shown: [], pending: [], indexing: true, complete: false })), testimonialsBody({ shown: [], pending: [], indexing: true, complete: false }))
  const full = []
  for (let i = 1; i <= 64; i++) full.push({ seq: i, from: B, wseq: i })
  t.ok(validTestimonials(testimonialsBody({ shown: full, pending: [] })), '64 rows pass')
  const fullPending = []
  for (let i = 1; i <= 64; i++) fullPending.push({ from: C, seq: i + 100 })
  t.ok(validTestimonials(testimonialsBody({ pending: fullPending })), '64 pending pass')
  const missing = testimonialsBody()
  delete missing.pending
  const shown = (row) => testimonialsBody({ shown: [row] })
  const pending = (row) => testimonialsBody({ pending: [row] })
  const bad = [
    testimonialsBody({ extra: 1 }),
    missing,
    testimonialsBody({ indexing: 'no' }),
    testimonialsBody({ complete: null }),
    testimonialsBody({ shown: null }),
    testimonialsBody({ shown: {} }),
    testimonialsBody({ pending: 'x' }),
    testimonialsBody({ shown: full.concat([{ seq: 65, from: B, wseq: 65 }]) }),
    testimonialsBody({ pending: fullPending.concat([{ from: C, seq: 165 }]) }),
    shown({ seq: 1, from: B }),
    shown({ seq: 1, from: B, wseq: 1, text: 'oi' }),
    shown({ seq: 1, from: B.toUpperCase(), wseq: 1 }),
    shown({ seq: 1, from: B + 'a', wseq: 1 }),
    shown({ seq: 1, from: A, wseq: 1 }),
    shown({ seq: 0, from: B, wseq: 1 }),
    shown({ seq: 1, from: B, wseq: 0 }),
    shown({ seq: 1.5, from: B, wseq: 1 }),
    shown({ seq: '1', from: B, wseq: 1 }),
    shown({ seq: 1, from: B, wseq: Number.MAX_SAFE_INTEGER + 1 }),
    shown(null),
    shown([]),
    testimonialsBody({ shown: [{ seq: 1, from: B, wseq: 1 }, { seq: 1, from: C, wseq: 2 }] }),
    testimonialsBody({ shown: [{ seq: 1, from: B, wseq: 1 }, { seq: 2, from: B, wseq: 1 }] }),
    pending({ from: B }),
    pending({ from: B, seq: 1, wseq: 1 }),
    pending({ from: B.toUpperCase(), seq: 1 }),
    pending({ from: A, seq: 1 }),
    pending({ from: B, seq: 0 }),
    pending({ from: B, seq: -1 }),
    pending({ from: B, seq: '1' }),
    pending(null),
    testimonialsBody({ pending: [{ from: B, seq: 4 }] }),
    testimonialsBody({ pending: [{ from: C, seq: 1 }, { from: C, seq: 1 }] }),
    null,
    []
  ]
  for (const body of bad) t.is(validTestimonials(body, A), null, JSON.stringify(body).slice(0, 120))
  const own = testimonialsBody()
  const copy = validTestimonials(own, A)
  copy.shown[0].seq = 99
  copy.pending[0].seq = 99
  t.is(own.shown[0].seq, 9, 'shown copied')
  t.is(own.pending[0].seq, 6, 'pending copied')
})

const scrapsBody = (over = {}) => ({
  scraps: [{ author: B, seq: 9, followSeq: 4 }, { author: C, seq: 7, followSeq: null }],
  hides: [3, 2],
  wall: 5,
  next: null,
  indexing: false,
  complete: true,
  ...over
})

test('scrapsUrl and followPairUrl: exact paths, lowercase keys, bad input is null', async (t) => {
  const { scrapsUrl, followPairUrl, fetchScraps, fetchFollowPair, SCRAPS_MAX, SCRAP_HIDES_MAX } = await load()
  t.is(SCRAPS_MAX, 50)
  t.is(SCRAP_HIDES_MAX, 1000)
  t.is(scrapsUrl(A), '/index/scraps/' + A)
  t.is(scrapsUrl(A.toUpperCase(), '50'), '/index/scraps/' + A + '/50')
  for (const owner of [A + 'a', 'zz'.repeat(32), A + '/x', '', null, 7]) t.is(scrapsUrl(owner), null, 'owner ' + String(owner))
  for (const cursor of ['', 'a/b', '../x', '.', '..', '.x', 'a?b', 'x'.repeat(129), 5, {}, [], Symbol('x')]) t.is(scrapsUrl(A, cursor), null, 'cursor ' + String(cursor))
  t.is(followPairUrl(A, B), '/index/follow/' + A + '/' + B)
  t.is(followPairUrl(A.toUpperCase(), B.toUpperCase()), '/index/follow/' + A + '/' + B)
  for (const [x, y] of [[A, 'nope'], ['nope', B], [A, null], [null, null], [A + 'a', B]]) t.is(followPairUrl(x, y), null)
  let called = false
  t.alike(await fetchScraps('nope', null, { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchFollowPair(A, 'nope', { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.absent(called, 'no request for bad input')
})

test('validScraps: exact shape, hex writers, int ranges, caps and no repeats', async (t) => {
  const { validScraps } = await load()
  t.alike(validScraps(scrapsBody(), A), { rows: scrapsBody().scraps, hides: [3, 2], wall: 5, next: null, indexing: false, complete: true })
  t.is(validScraps(scrapsBody({ wall: null, next: 'abc.def-1', scraps: [], hides: [] }), A).wall, null)
  const full = []
  for (let i = 1; i <= 50; i++) full.push({ author: i.toString(16).padStart(64, '0'), seq: i, followSeq: null })
  t.ok(validScraps(scrapsBody({ scraps: full }), A), '50 rows pass')
  const hides = []
  for (let i = 1; i <= 1000; i++) hides.push(i)
  t.ok(validScraps(scrapsBody({ hides }), A), '1000 hides pass')
  const missing = scrapsBody()
  delete missing.hides
  const row = (r) => scrapsBody({ scraps: [r] })
  const bad = [
    scrapsBody({ extra: 1 }),
    missing,
    scrapsBody({ indexing: 'no' }),
    scrapsBody({ complete: null }),
    scrapsBody({ scraps: null }),
    scrapsBody({ scraps: {} }),
    scrapsBody({ hides: 'x' }),
    scrapsBody({ scraps: full.concat([{ author: C, seq: 51, followSeq: null }]) }),
    scrapsBody({ hides: hides.concat([1001]) }),
    scrapsBody({ wall: 0 }),
    scrapsBody({ wall: '5' }),
    scrapsBody({ wall: 1.5 }),
    scrapsBody({ wall: undefined }),
    scrapsBody({ next: 7 }),
    scrapsBody({ next: 'a/b' }),
    scrapsBody({ next: '.' }),
    scrapsBody({ next: '..' }),
    scrapsBody({ next: '' }),
    scrapsBody({ hides: [0] }),
    scrapsBody({ hides: [-1] }),
    scrapsBody({ hides: ['1'] }),
    scrapsBody({ hides: [1.5] }),
    scrapsBody({ hides: [Number.MAX_SAFE_INTEGER + 1] }),
    scrapsBody({ hides: [2, 2] }),
    row({ author: B, seq: 1 }),
    row({ author: B, seq: 1, followSeq: null, text: 'oi' }),
    row({ author: B.toUpperCase(), seq: 1, followSeq: null }),
    row({ author: B + 'a', seq: 1, followSeq: null }),
    row({ author: 'zz'.repeat(32), seq: 1, followSeq: null }),
    row({ author: A, seq: 1, followSeq: null }),
    row({ author: B, seq: 0, followSeq: null }),
    row({ author: B, seq: 1.5, followSeq: null }),
    row({ author: B, seq: '1', followSeq: null }),
    row({ author: B, seq: Number.MAX_SAFE_INTEGER + 1, followSeq: null }),
    row({ author: B, seq: 1, followSeq: 0 }),
    row({ author: B, seq: 1, followSeq: '2' }),
    row({ author: B, seq: 1, followSeq: undefined }),
    row(null),
    row([]),
    scrapsBody({ scraps: [{ author: B, seq: 1, followSeq: null }, { author: B, seq: 1, followSeq: 2 }] }),
    null,
    []
  ]
  for (const body of bad) t.is(validScraps(body, A), null, JSON.stringify(body).slice(0, 120))
  for (const o of [null, undefined, '', 'nope', B.toUpperCase()]) t.is(validScraps(scrapsBody(), o), null, 'owner ' + String(o))
  const many = []
  for (let i = 1; i <= 21; i++) many.push({ author: B, seq: i, followSeq: null })
  t.is(validScraps(scrapsBody({ scraps: many }), A), null, '21 rows of one author')
  t.ok(validScraps(scrapsBody({ scraps: many.slice(0, 20).concat([{ author: C, seq: 1, followSeq: null }]) }), A), '20 per author pass')
  const stuck = validScraps(scrapsBody({ next: 'abc' }), A, 'abc')
  t.is(stuck.next, null, 'a next equal to the cursor stops paging')
  t.is(stuck.complete, false, 'and marks the read incomplete')
  t.is(validScraps(scrapsBody({ next: 'abd' }), A, 'abc').next, 'abd')
  const own = scrapsBody()
  const copy = validScraps(own, A)
  copy.rows[0].seq = 99
  copy.hides[0] = 99
  t.is(own.scraps[0].seq, 9, 'rows copied')
  t.is(own.hides[0], 3, 'hides copied')
})

test('validFollowPair: exact keys, seq null or positive int', async (t) => {
  const { validFollowPair } = await load()
  t.alike(validFollowPair({ seq: 4, indexing: false }), { seq: 4, indexing: false })
  t.alike(validFollowPair({ seq: null, indexing: true }), { seq: null, indexing: true })
  for (const body of [{ seq: 0, indexing: false }, { seq: '4', indexing: false }, { seq: 1.5, indexing: false }, { seq: -1, indexing: false }, { seq: Number.MAX_SAFE_INTEGER + 1, indexing: false }, { seq: 4 }, { indexing: false }, { seq: undefined, indexing: false }, { seq: 4, indexing: 'no' }, { seq: 4, indexing: false, complete: true }, null, [], 'x']) {
    t.is(validFollowPair(body), null, JSON.stringify(body))
  }
})

test('fetchScraps and fetchFollowPair: request, contract and malformed answers', async (t) => {
  const { fetchScraps, fetchFollowPair } = await load()
  const calls = []
  const res = await fetchScraps(A.toUpperCase(), null, { fetch: async (url, opts) => { calls.push({ url, opts }); return response(JSON.stringify(scrapsBody())) } })
  t.is(res.ok, true)
  t.alike(res.value.rows, scrapsBody().scraps)
  t.is(calls[0].url, '/index/scraps/' + A)
  t.is(calls[0].opts.method, 'GET')
  const own = await fetchScraps(A, null, { fetch: async () => response(JSON.stringify(scrapsBody({ scraps: [{ author: A, seq: 1, followSeq: null }] }))) })
  t.alike(own, { ok: false, reason: 'malformed' }, 'the owner is never a writer')
  const paged = await fetchScraps(A, 'abc', { fetch: async (url) => { calls.push({ url }); return response(JSON.stringify(scrapsBody({ next: 'abc' }))) } })
  t.alike([paged.value.next, paged.value.complete], [null, false], 'a next that repeats the cursor stops')
  t.is(calls[calls.length - 1].url, '/index/scraps/' + A + '/abc')
  const pair = await fetchFollowPair(A, B, { fetch: async (url) => { calls.push({ url }); return response(JSON.stringify({ seq: 3, indexing: false })) } })
  t.alike(pair, { ok: true, value: { seq: 3, indexing: false } })
  t.is(calls[calls.length - 1].url, '/index/follow/' + A + '/' + B)
  t.alike(await fetchFollowPair(A, B, { fetch: async () => response(JSON.stringify({ seq: 0, indexing: false })) }), { ok: false, reason: 'malformed' })
})

test('fetchTestimonials: request options, contract and transport', async (t) => {
  const { fetchTestimonials } = await load()
  const calls = []
  const res = await fetchTestimonials(A.toUpperCase(), {
    fetch: async (url, opts) => {
      calls.push({ url, opts })
      return response(JSON.stringify(testimonialsBody()))
    }
  })
  t.alike(res, { ok: true, value: testimonialsBody() })
  t.is(calls[0].url, '/index/testimonials/' + A)
  t.is(calls[0].opts.method, 'GET')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is(calls[0].opts.cache, 'no-store')
  t.ok(calls[0].opts.signal, 'abortable')
  t.alike(await fetchTestimonials(A, { fetch: json(testimonialsBody({ extra: 1 })) }), { ok: false, reason: 'malformed' })
  t.alike(await fetchTestimonials(A, { fetch: json(testimonialsBody({ shown: [{ seq: 1, from: A, wseq: 1 }] })) }), { ok: false, reason: 'malformed' }, 'the owner as writer')
  const text = JSON.stringify(testimonialsBody())
  t.is((await fetchTestimonials(A, { fetch: async () => response(text, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchTestimonials(A, { fetch: async () => response(text, { redirected: true }) })).reason, 'status')
  const big = response(JSON.stringify(testimonialsBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchTestimonials(A, { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled, 'oversized read is cancelled')
  const limited = await fetchTestimonials(A, { fetch: async () => response(text, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs), 'with the cooldown left')
})

// --- Feira ---

function feiraBody (over = {}) {
  return {
    items: [
      { ref: A + ':5', status: 'disponivel', statusSeq: null, editSeq: 8 },
      { ref: B + ':2', status: 'reservado', statusSeq: 4, editSeq: null }
    ],
    next: CURSOR,
    authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 3, page: true, closed: false, moved: false } },
    indexing: false,
    complete: true,
    ...over
  }
}

test('feiraUrl: the search route grammar, nothing coerced', async (t) => {
  const { feiraUrl } = await load()
  t.is(feiraUrl({ uf: 'SP', cityKey: 'sao-paulo' }), '/index/feira/sp/sao-paulo/todos/todas', 'uf sent lower case')
  t.is(feiraUrl({ uf: 'RJ', cityKey: 'rio-de-janeiro', kind: 'servico', cat: 'reparos' }), '/index/feira/rj/rio-de-janeiro/servico/reparos')
  t.is(feiraUrl({ uf: 'MG', cityKey: 'bh', kind: 'procura', cat: 'todas', tokens: 'bicicleta+aro' }), '/index/feira/mg/bh/procura/todas/bicicleta+aro', 'literal plus')
  t.is(feiraUrl({ uf: 'MG', cityKey: 'bh', tokens: 'sofa', cursor: CURSOR }), '/index/feira/mg/bh/todos/todas/sofa/' + CURSOR)
  t.is(feiraUrl({ uf: 'MG', cityKey: 'bh', cursor: CURSOR }), '/index/feira/mg/bh/todos/todas/' + CURSOR)
  const bad = [
    {},
    { uf: 'sp', cityKey: 'bh' },
    { uf: 'XX', cityKey: 'bh' },
    { uf: 'SP', cityKey: 'b' },
    { uf: 'SP', cityKey: 'x'.repeat(49) },
    { uf: 'SP', cityKey: 'São Paulo' },
    { uf: 'SP', cityKey: 'sao/paulo' },
    { uf: 'SP', cityKey: '-bh' },
    { uf: 'SP', cityKey: 'bh', kind: 'Produto' },
    { uf: 'SP', cityKey: 'bh', kind: 'todas' },
    { uf: 'SP', cityKey: 'bh', cat: 'todos' },
    { uf: 'SP', cityKey: 'bh', cat: 'carros' },
    { uf: 'SP', cityKey: 'bh', tokens: 'Sofá' },
    { uf: 'SP', cityKey: 'bh', tokens: 'a' },
    { uf: 'SP', cityKey: 'bh', tokens: 'ab%2Bcd' },
    { uf: 'SP', cityKey: 'bh', cursor: 'x' },
    { uf: 'SP', cityKey: 'bh', cursor: '1.' + A + '.0' }
  ]
  for (const q of bad) t.is(feiraUrl(q), null, JSON.stringify(q))
  t.is(feiraUrl(), null)
})

test('feiraAuthorUrl and feiraRatingsUrl: hex64 lowercased, optional cursor', async (t) => {
  const { feiraAuthorUrl, feiraRatingsUrl } = await load()
  t.is(feiraAuthorUrl(A), '/index/feira/autor/' + A)
  t.is(feiraAuthorUrl(A.toUpperCase(), CURSOR), '/index/feira/autor/' + A + '/' + CURSOR)
  t.is(feiraRatingsUrl(A), '/index/feira/avaliacoes/' + A)
  t.is(feiraRatingsUrl(A, CURSOR), '/index/feira/avaliacoes/' + A + '/' + CURSOR)
  for (const fn of [feiraAuthorUrl, feiraRatingsUrl]) {
    t.is(fn('ab'), null)
    t.is(fn(A + ':1'), null)
    t.is(fn(null), null)
    t.is(fn(A, 'bad'), null)
  }
})

test('validFeira: exact keys, hints after the root, one author hint per item author', async (t) => {
  const { validFeira } = await load()
  t.alike(validFeira(feiraBody()), feiraBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 3, page: true, closed: false, moved: false } } }))
  t.alike(validFeira(feiraBody({ items: [], next: CURSOR, authors: {} })).items, [], 'an empty page with next')
  t.alike(validFeira(feiraBody({ items: [{ ref: A + ':5', status: null, statusSeq: null, editSeq: null }], authors: { [A]: { profileSeq: null, usernameSeq: null } } })).items[0].status, null, 'stale on the author route')
  const item = feiraBody().items[0]
  const bad = [
    feiraBody({ extra: 1 }),
    feiraBody({ items: [{ ...item, extra: 1 }] }),
    feiraBody({ items: [{ ref: item.ref }] }),
    feiraBody({ items: [item, item] }),
    feiraBody({ items: [{ ...item, status: 'perdido' }] }),
    feiraBody({ items: [{ ...item, status: null, statusSeq: 9 }], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    feiraBody({ items: [{ ...item, editSeq: 5 }], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    feiraBody({ items: [{ ...item, statusSeq: 3 }], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    feiraBody({ items: [{ ...item, editSeq: '8' }], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    feiraBody({ items: Array.from({ length: 31 }, (_, i) => ({ ref: A + ':' + (i + 1), status: 'disponivel', statusSeq: null, editSeq: null })), authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    feiraBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    feiraBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 3 }, [C]: { profileSeq: 1, usernameSeq: 1 } } }),
    feiraBody({ authors: { [A]: { profileSeq: 1 }, [B]: { profileSeq: null, usernameSeq: 3 } } }),
    feiraBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null, page: 'yes' }, [B]: { profileSeq: null, usernameSeq: 3 } } }),
    feiraBody({ next: 'x' }),
    feiraBody({ indexing: 1 }),
    null,
    []
  ]
  for (const body of bad) t.is(validFeira(body), null, JSON.stringify(body).slice(0, 80))
  t.is(validFeira(feiraBody(), { author: A }), null, 'author route: another author is refused')
  const ratings = { items: [{ ref: C + ':40' }], next: null, authors: { [C]: { profileSeq: null, usernameSeq: null } }, indexing: false, complete: true }
  t.alike(validFeira(ratings, { ratings: true }).items, [{ ref: C + ':40' }])
  t.is(validFeira(ratings), null, 'a rating row is no listing row')
  t.is(validFeira(feiraBody(), { ratings: true }), null, 'a listing row is no rating row')
})

test('fetchFeira, fetchFeiraAuthor, fetchFeiraRatings: transport, contract, 404 and the scheduler', async (t) => {
  const m = await load()
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('/avaliacoes/')) return response(JSON.stringify({ items: [{ ref: C + ':40' }], next: null, authors: { [C]: { profileSeq: null, usernameSeq: null } }, indexing: false, complete: true }))
    if (url.includes('/autor/')) return response(JSON.stringify(feiraBody({ items: [feiraBody().items[0]], authors: { [A]: { profileSeq: 1, usernameSeq: null } } })))
    return response(JSON.stringify(feiraBody()))
  }
  const res = await m.fetchFeira({ uf: 'SP', cityKey: 'campinas', kind: 'produto', cat: 'esporte' }, { fetch })
  t.is(res.ok, true)
  t.is(res.value.items.length, 2)
  t.is(calls[0].url, '/index/feira/sp/campinas/produto/esporte')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is((await m.fetchFeiraAuthor(A, null, { fetch })).ok, true)
  t.is(calls[1].url, '/index/feira/autor/' + A)
  t.alike((await m.fetchFeiraRatings(A, CURSOR, { fetch })).value.items, [{ ref: C + ':40' }])
  t.is(calls[2].url, '/index/feira/avaliacoes/' + A + '/' + CURSOR)
  t.is((await m.fetchFeiraAuthor(B, null, { fetch })).reason, 'malformed', 'a row of another author')
  let called = false
  t.alike(await m.fetchFeira({ uf: 'SP', cityKey: 'São Paulo' }, { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.absent(called, 'no request for bad input')
  t.is((await m.fetchFeira({ uf: 'SP', cityKey: 'bh' }, { fetch: async () => response('{}', { status: 404 }) })).reason, 'not-found', 'Feira off')

  // Through the shared pacer: a burst of Feira requests stays within 2 in flight.
  const m2 = await load()
  let out = 0
  let maxOut = 0
  const burst = async () => {
    out++
    maxOut = Math.max(maxOut, out)
    await m2.clock.later(100)
    out--
    return response(JSON.stringify(feiraBody()))
  }
  const deps = { ...m2.clock.deps, fetch: burst }
  const all = Array.from({ length: 6 }, () => m2.fetchFeira({ uf: 'SP', cityKey: 'bh' }, deps))
  const results = await m2.clock.run(Promise.all(all))
  t.ok(results.every((r) => r.ok), 'all settle ok')
  t.ok(maxOut <= 2, 'at most 2 in flight: ' + maxOut)
})

test('profileUrl and validProfile: tolerant of unknown keys, strict on known ones', async (t) => {
  const { profileUrl, validProfile, fetchProfile } = await load()
  const A = 'a'.repeat(64)
  t.is(profileUrl(A), '/index/profile/' + A)
  t.is(profileUrl(A.toUpperCase()), '/index/profile/' + A, 'author lowercased')
  for (const author of [null, undefined, '', 'abc', A + 'a', 7]) t.is(profileUrl(author), null, 'author ' + String(author))
  const flags = { indexing: false, complete: true }
  t.alike(validProfile({ about: 3, mood: null, ...flags }), { about: 3, mood: null, visits: null, garden: null, fans: null, top: null, ...flags })
  t.alike(validProfile({ ...flags }), { about: null, mood: null, visits: null, garden: null, fans: null, top: null, ...flags }, 'missing pointers read as null')
  t.alike(validProfile({ about: 1, mood: 2, later: { x: 1 }, ...flags }), { about: 1, mood: 2, visits: null, garden: null, fans: null, top: null, ...flags }, 'unknown keys ignored')
  t.is(validProfile({ visits: 4, ...flags }).visits, 4, 'visits pointer read')
  for (const bad of [0, '1', 1.5]) t.is(validProfile({ visits: bad, ...flags }), null, 'visits ' + String(bad))
  t.is(validProfile({ garden: 6, ...flags }).garden, 6, 'garden pointer read')
  t.is(validProfile({ ...flags }).garden, null, 'garden absent reads as null')
  for (const bad of [0, '1', 1.5]) t.is(validProfile({ garden: bad, ...flags }), null, 'garden ' + String(bad))
  const K = 'b'.repeat(64)
  const good = { fans: { count: 3, indexing: false }, top: { seq: 5, back: { [K]: 7, ['c'.repeat(64)]: null } } }
  t.alike(validProfile({ ...good, ...flags }), { about: null, mood: null, visits: null, garden: null, ...good, ...flags }, 'fans and top read')
  t.alike(validProfile({ fans: null, top: null, ...flags }), { about: null, mood: null, visits: null, garden: null, fans: null, top: null, ...flags })
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i.toString(16).repeat(64), null]))
  for (const bad of [{ fans: { count: -1, indexing: false } }, { fans: { count: 1.5, indexing: false } }, { fans: { count: 1 } }, { fans: { count: 1, indexing: false, x: 1 } }, { top: { seq: 0, back: {} } }, { top: { seq: 1 } }, { top: { seq: 1, back: { [K.toUpperCase()]: 1 } } }, { top: { seq: 1, back: { [K]: 0 } } }, { top: { seq: 1, back: many } }, { top: { seq: 1, back: {}, x: 1 } }]) {
    t.is(validProfile({ ...bad, ...flags }), null, JSON.stringify(bad))
  }
  for (const bad of [null, [], 'x', { about: 0, ...flags }, { about: 1.5, ...flags }, { mood: '2', ...flags }, { about: 1, mood: Number.MAX_SAFE_INTEGER + 1, ...flags }, { about: 1, indexing: 'no', complete: true }, { about: 1, indexing: false }]) {
    t.is(validProfile(bad), null, JSON.stringify(bad))
  }
  t.alike(await fetchProfile('nope'), { ok: false, reason: 'invalid-input' })
})

test('fansUrl and validFans: cursor like the followers, rows and flags checked', async (t) => {
  const { fansUrl, validFans, fetchFans } = await load()
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  t.is(fansUrl(A), '/index/fans/' + A)
  t.is(fansUrl(A, { atMs: 5, key: B }), '/index/fans/' + A + '/5.' + B)
  t.is(fansUrl(A, 'x'), null)
  t.is(fansUrl('nope'), null)
  const row = { key: B, seq: 3, at: '2026-01-01T00:00:00.000Z' }
  const body = { author: A, items: [row], total: 1, next: null, authors: { [B]: { profileSeq: 1, usernameSeq: null } }, indexing: false, complete: true }
  t.alike(validFans(body, A), body)
  t.is(validFans({ ...body, kind: 'seguidores' }, A), null, 'no kind')
  t.is(validFans({ ...body, items: [{ ...row, key: A }] }, A), null, 'never itself')
  t.is(validFans({ ...body, total: 0 }, A), null)
  t.alike(await fetchFans('nope', null, {}), { ok: false, reason: 'invalid-input' })
})

test('pollUrl and pollVotersUrl: inputs checked, never a dropped cursor', async (t) => {
  const { pollUrl, pollVotersUrl } = await load()
  t.is(pollUrl(A.toUpperCase(), 5), '/index/poll/' + A + '/5')
  t.is(pollUrl(A, 0), null)
  t.is(pollUrl(A, 1.5), null)
  t.is(pollUrl(A, '5'), null)
  t.is(pollUrl('nope', 5), null)
  t.is(pollVotersUrl(A, 5, 2), '/index/poll/' + A + '/5/2')
  t.is(pollVotersUrl(A, 5, 0, { atMs: 7, key: B }), '/index/poll/' + A + '/5/0/7.' + B)
  for (const pick of [-1, 4, '1', null, 0.5]) t.is(pollVotersUrl(A, 5, pick), null, 'pick ' + String(pick))
  t.is(pollVotersUrl(A, 5, 0, 'x'), null, 'a bad cursor is null, not dropped')
  t.is(pollVotersUrl(A, 5, 0, { atMs: 0, key: B }), '/index/poll/' + A + '/5/0/0.' + B, 'atMs 0')
  t.is(pollVotersUrl(A, 5, 0, { atMs: 7, key: B, x: 1 }), null)
  t.is(pollVotersUrl(A, 0, 0), null)
})

test('validPoll: exact keys, 2 to 4 counts, the expected size', async (t) => {
  const { validPoll, fetchPoll } = await load()
  const body = { totals: [3, 0, 1], indexing: false, complete: true }
  t.alike(validPoll(body), body)
  t.alike(validPoll(body, 3), body)
  t.is(validPoll(body, 2), null, 'size differs from the poll')
  const indexing = { totals: [], indexing: true, complete: false }
  t.alike(validPoll(indexing), indexing, 'no totals while the seeder indexes')
  t.alike(validPoll(indexing, 3), indexing, 'whatever the expected size')
  for (const bad of [{ totals: [], indexing: false, complete: true }, { totals: [], indexing: false, complete: false }, { totals: [], indexing: true, complete: true }]) {
    t.is(validPoll(bad), null, 'empty totals only while indexing: ' + JSON.stringify(bad))
  }
  const fresh = validPoll(body)
  fresh.totals[0] = 9
  t.is(body.totals[0], 3, 'a copy is returned')
  for (const bad of [{ ...body, totals: [1] }, { ...body, totals: [1, 2, 3, 4, 5] }, { ...body, totals: [1, -1] }, { ...body, totals: [1, 1.5] }, { ...body, totals: [1, '2'] }, { ...body, totals: [1, null] }, { ...body, totals: { 0: 1, 1: 2, length: 2 } }, { ...body, totals: [1, 2], x: 1 }, { ...body, indexing: 'no' }, { totals: [1, 2], indexing: false }, { ...body, totals: Object.assign([1, 0, 2], { 1: undefined }) }, null, [], 'x']) {
    t.is(validPoll(bad), null, JSON.stringify(bad))
  }
  t.alike(await fetchPoll('nope', 5, 3, {}), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchPoll(A, 0, 3, {}), { ok: false, reason: 'invalid-input' })
  for (const bad of [undefined, 1, 5, 2.5, '3', null]) t.alike(await fetchPoll(A, 5, bad, {}), { ok: false, reason: 'invalid-input' }, 'the option count is required: ' + String(bad))
  const answer = (totals) => ({ fetch: json({ totals, indexing: false, complete: true }) })
  t.alike(await fetchPoll(A, 5, 3, answer([3, 0, 1])), { ok: true, value: { totals: [3, 0, 1], indexing: false, complete: true } })
  t.alike(await fetchPoll(A, 5, 3, answer([3, 0, 1, 2])), { ok: false, reason: 'malformed' }, 'a 3-option poll with 4 totals is rejected')
  t.alike(await fetchPoll(A, 5, 3, answer([3, 0])), { ok: false, reason: 'malformed' }, 'and one with 2')
})

test('validPollVoters: pointers only, newest first, next names the last row', async (t) => {
  const { validPollVoters, fetchPollVoters } = await load()
  const row = (key, at, seq = 3) => ({ key, seq, at })
  const r1 = row(B, '2026-01-02T00:00:00.000Z')
  const r2 = row(C, '2026-01-01T00:00:00.000Z', 4)
  const hints = { [B]: { profileSeq: 3, usernameSeq: null }, [C]: { profileSeq: null, usernameSeq: 5 } }
  const body = { items: [r1, r2], next: null, total: 2, authors: hints, indexing: false, complete: true }
  t.alike(validPollVoters(body), body)
  const empty = { items: [], next: null, total: 0, authors: {}, indexing: true, complete: false }
  t.alike(validPollVoters(empty), empty, 'an empty page while indexing')
  t.is(validPollVoters({ ...body, items: [r2, r1] }), null, 'oldest first')
  t.is(validPollVoters({ ...body, items: [r1, { ...r2, key: B }] }), null, 'a duplicate key')
  t.is(validPollVoters({ ...body, items: [r1, { ...r2, extra: 1 }] }), null)
  t.is(validPollVoters({ ...body, items: [{ ...r1, seq: 0 }] }), null)
  t.is(validPollVoters({ ...body, items: [{ ...r1, at: '2026-01-02' }] }), null)
  t.is(validPollVoters({ ...body, items: [{ ...r1, key: 'zz' }] }), null)
  t.is(validPollVoters({ ...body, authors: {} }), null, 'a hint missing for an item')
  t.is(validPollVoters({ ...body, authors: { ...hints, [A]: hints[B] } }), null, 'a hint for no item')
  t.is(validPollVoters({ ...body, authors: { [B]: hints[B], [C]: { profileSeq: 0, usernameSeq: null } } }), null, 'a bad hint')
  t.is(validPollVoters({ ...body, authors: { [B]: hints[B], [C]: { profileSeq: null } } }), null, 'a hint with missing keys')
  const noAuthors = { ...body }
  delete noAuthors.authors
  t.is(validPollVoters(noAuthors), null, 'no authors key')
  t.is(validPollVoters({ ...body, total: 1 }), null, 'total below the rows')
  t.is(validPollVoters({ ...body, items: Array.from({ length: 21 }, (_, i) => row(i.toString(16).padStart(64, '0'), '2026-01-02T00:00:00.000Z')), total: 21 }), null, 'over a page')
  const next = { atMs: Date.parse(r2.at), key: C }
  t.alike(validPollVoters({ ...body, next, total: 9 }).next, next)
  const drawn = validPollVoters({ ...body, next, total: 9 })
  drawn.authors[B].profileSeq = 99
  t.is(body.authors[B].profileSeq, 3, 'a copy is returned')
  t.is(validPollVoters({ ...body, next: { atMs: Date.parse(r2.at), key: B }, total: 9 }), null, 'next must name the last row')
  t.is(validPollVoters({ ...body, items: [], next, total: 9 }), null, 'a cursor with no rows')
  t.is(validPollVoters({ ...body, next: { atMs: 1, key: C, x: 1 } }), null)
  t.is(validPollVoters(body, { atMs: Date.parse(r1.at), key: B }), null, 'a row at or before the request cursor')
  t.ok(validPollVoters({ ...body, items: [r2], authors: { [C]: hints[C] }, total: 2 }, { atMs: Date.parse(r1.at), key: B }), 'after the request cursor')
  t.alike(await fetchPollVoters(A, 5, 4, null, {}), { ok: false, reason: 'invalid-input' })
})

// A roda answer asked for A:5, a reply under the comment B:3 of the post C:1.
const RODA_CURSOR = '1761000000000.' + C + '.8'
function rodaBody (over = {}) {
  return {
    ref: REF,
    root: C + ':1',
    top: B + ':3',
    items: [{ ref: REF, to: B + ':3' }, { ref: C + ':8', to: REF }],
    next: RODA_CURSOR,
    total: 7,
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

test('rodaUrl: exact path, input lowercased, everything else refused', async (t) => {
  const { rodaUrl } = await load()
  t.is(rodaUrl(REF), '/index/roda/' + A + '/5')
  t.is(rodaUrl(REF.toUpperCase()), '/index/roda/' + A + '/5', 'input lowercased')
  t.is(rodaUrl(REF, CURSOR), '/index/roda/' + A + '/5/' + CURSOR)
  for (const bad of [A + ':0', A + ':05', A, A + ':1/..', 'zz'.repeat(32) + ':1', null, 7, A + ':1234567890123456']) {
    t.is(rodaUrl(bad), null, 'ref ' + String(bad))
  }
  t.is(rodaUrl(A + ':123456789012345'), '/index/roda/' + A + '/123456789012345', '15 digits, as the seeder route')
  for (const bad of ['x', '1.' + B + '.0', '1.' + B.toUpperCase() + '.1', '12345678901234567.' + B + '.1', CURSOR + '/x', 5]) {
    t.is(rodaUrl(REF, bad), null, 'cursor ' + String(bad))
  }
})

test('validRoda: the exact shape, returned as a fresh copy', async (t) => {
  const { validRoda, RODA_MAX } = await load()
  t.is(RODA_MAX, 50)
  const body = rodaBody()
  const v = validRoda(body, REF)
  t.alike(v, rodaBody())
  t.not(v, body)
  t.not(v.items, body.items)
  t.not(v.items[0], body.items[0])
  t.not(v.authors, body.authors)
  t.not(v.authors[A], body.authors[A])
  body.items[0].to = 'changed'
  body.authors[A].profileSeq = 99
  t.is(v.items[0].to, B + ':3', 'the copy does not track the input')
  t.is(v.authors[A].profileSeq, 1)
  t.ok(validRoda(rodaBody({ ref: B + ':3', items: [], next: null, total: 0, authors: { [B]: { profileSeq: null, usernameSeq: 2 }, [C]: { profileSeq: null, usernameSeq: null } } }), B + ':3'), 'asked for the comment itself, no replies yet')
  const fifty = Array.from({ length: 50 }, (_, i) => ({ ref: A + ':' + (i + 10), to: B + ':3' }))
  t.ok(validRoda(rodaBody({ items: fifty, next: null, total: 50 }), REF), '50 rows')
})

test('fetchRoda: request options, the exact shape and a 404 from an older seeder', async (t) => {
  const { fetchRoda } = await load()
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(rodaBody()))
  }
  const res = await fetchRoda(REF.toUpperCase(), CURSOR, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, rodaBody())
  t.is(calls[0].url, '/index/roda/' + A + '/5/' + CURSOR)
  t.is(calls[0].opts.method, 'GET')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is(calls[0].opts.cache, 'no-store')
  t.ok(calls[0].opts.signal, 'abortable')
  t.alike(await fetchRoda(REF, null, { fetch: async () => response('{}', { status: 404 }) }), { ok: false, reason: 'not-found' })
  t.alike(await fetchRoda(REF, null, { fetch: async () => response('{}', { status: 503 }) }), { ok: false, reason: 'status' })
  t.alike(await fetchRoda(REF, null, { fetch: async () => response('x'.repeat(65537)) }), { ok: false, reason: 'too-large' })
  let called = false
  t.alike(await fetchRoda('nope', null, { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchRoda(REF, 'x', { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.absent(called, 'no request for bad input')
})

test('fetchRoda rejects anything outside the contract', async (t) => {
  const { fetchRoda } = await load()
  const top = B + ':3'
  const many = Array.from({ length: 51 }, (_, i) => ({ ref: A + ':' + (i + 10), to: top }))
  const bad = [
    ['extra key', { extra: true }],
    ['wrong ref', { ref: B + ':5' }],
    ['ref upper case', { ref: REF.toUpperCase() }],
    ['root equal to top', { root: top, items: [], next: null, authors: { [A]: rodaBody().authors[A], [B]: rodaBody().authors[B] } }],
    ['ref equal to root', { root: REF, top: C + ':1', items: [], next: null, authors: { [A]: rodaBody().authors[A], [C]: rodaBody().authors[C] } }],
    ['bad root', { root: C + ':0' }],
    ['bad top', { top: 'x' }],
    ['51 items', { items: many, next: null, total: 51 }],
    ['items not an array', { items: {} }],
    ['duplicate item', { items: [{ ref: REF, to: top }, { ref: REF, to: top }], next: null }],
    ['item equal to top', { items: [{ ref: top, to: REF }], next: null }],
    ['item equal to root', { items: [{ ref: C + ':1', to: top }], next: null }],
    ['item ref equal to its to', { items: [{ ref: REF, to: REF }], next: null }],
    ['item answering the root', { items: [{ ref: REF, to: C + ':1' }], next: null }],
    ['child before its parent', { items: [{ ref: C + ':8', to: REF }, { ref: REF, to: top }], next: '1.' + A + '.5' }],
    ['item extra key', { items: [{ ref: REF, to: top, at: 1 }], next: null }],
    ['item missing to', { items: [{ ref: REF }], next: null }],
    ['item bad ref', { items: [{ ref: A + ':0', to: top }], next: null }],
    ['bad cursor', { next: 'x' }],
    ['cursor with a bad time naming the last row', { next: 'abc.' + C + '.8' }],
    ['cursor naming another row', { next: '1761000000000.' + A + '.5' }],
    ['cursor on an empty page', { items: [], next: CURSOR, authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 2 }, [C]: { profileSeq: null, usernameSeq: null } } }],
    ['total below length', { total: 1 }],
    ['total not a count', { total: -1 }],
    ['indexing not boolean', { indexing: 'no' }],
    ['complete not boolean', { complete: 1 }],
    ['authors missing one', { authors: { [A]: { profileSeq: 1, usernameSeq: null }, [C]: { profileSeq: null, usernameSeq: null } } }],
    ['authors with an unrelated key', { authors: { ...rodaBody().authors, ['12'.repeat(32)]: { profileSeq: null, usernameSeq: null } } }],
    ['authors upper case', { authors: { ...rodaBody().authors, [A.toUpperCase()]: { profileSeq: 1, usernameSeq: null } } }],
    ['authors bad hint', { authors: { ...rodaBody().authors, [A]: { profileSeq: 0, usernameSeq: null } } }],
    ['authors not an object', { authors: [] }]
  ]
  for (const [name, over] of bad) {
    t.alike(await fetchRoda(REF, null, { fetch: json(rodaBody(over)) }), { ok: false, reason: 'malformed' }, name)
  }
  const missing = rodaBody()
  delete missing.top
  t.is((await fetchRoda(REF, null, { fetch: json(missing) })).reason, 'malformed', 'missing key')
  for (const body of ['null', '[]', 'not json']) {
    t.is((await fetchRoda(REF, null, { fetch: async () => response(body) })).reason, 'malformed', body)
  }
})

test('fetchRoda shares the scheduler: a 429 on it cools every index request', async (t) => {
  const m = await load()
  const { clock } = m
  const t0 = clock.now()
  const { calls, fetch } = recorder(clock, (url, n) => {
    if (n === 1) return tooMany('5')
    return url.startsWith('/index/roda/') ? response(JSON.stringify(rodaBody())) : response(JSON.stringify(postBody()))
  })
  const deps = { ...clock.deps, fetch }
  const roda = m.fetchRoda(REF, null, deps)
  const post = clock.later(1000).then(() => m.fetchPost(REF, null, deps))
  const [a, b] = await clock.run(Promise.all([roda, post]))
  t.is(a.ok, true, 'retried after the cooldown')
  t.is(b.ok, true)
  t.is(calls.length, 3)
  for (const c of calls.slice(1)) t.ok(c.at >= t0 + 5000, 'no request during the cooldown: ' + (c.at - t0))

  const m2 = await load()
  let out = 0
  let maxOut = 0
  const timed = recorder(m2.clock, async () => {
    out++
    maxOut = Math.max(maxOut, out)
    await m2.clock.later(100)
    out--
    return response(JSON.stringify(rodaBody()))
  })
  const deps2 = { ...m2.clock.deps, fetch: timed.fetch }
  const results = await m2.clock.run(Promise.all(Array.from({ length: 24 }, () => m2.fetchRoda(REF, null, deps2))))
  t.ok(results.every((r) => r.ok), 'all settle ok')
  t.ok(maxOut <= 2, 'at most 2 in flight: ' + maxOut)
  let worst = 0
  for (const c of timed.calls) worst = Math.max(worst, timed.calls.filter((d) => d.at >= c.at && d.at < c.at + 10000).length)
  t.ok(worst <= 18, 'starts per rolling 10 s: ' + worst)
})

test('fetchRoda with an installation set goes to that origin only', async (t) => {
  const { rodaUrl, fetchRoda } = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  t.ok(setInstallation('https://example.test'))
  const O = 'https://example.test'
  t.is(rodaUrl(REF, CURSOR), O + '/index/roda/' + A + '/5/' + CURSOR)
  t.is(rodaUrl('bad'), null)
  const urls = []
  const res = await fetchRoda(REF, null, { fetch: async (url) => { urls.push(url); return response(JSON.stringify(rodaBody())) } })
  t.is(res.ok, true)
  t.alike(urls, [O + '/index/roda/' + A + '/5'])
  setInstallation(null)
  t.is(rodaUrl(REF), '/index/roda/' + A + '/5', 'relative again once cleared')
})

test('events: URL builder and body contract', async (t) => {
  const { eventsUrl, validEvents } = await load()
  t.is(eventsUrl(A), '/index/events/' + A)
  t.is(eventsUrl(A, 10), '/index/events/' + A + '/10')
  for (const bad of ['x', null, A + '/x']) t.is(eventsUrl(bad), null, String(bad))
  for (const bad of [0, -1, 1.5, '3']) t.is(eventsUrl(A, bad), null, String(bad))
  const good = { posts: [9, 4], next: null, total: 2, indexing: false, complete: true }
  t.alike(validEvents(good), good)
  t.alike(validEvents({ ...good, next: 4 }), { ...good, next: 4 })
  for (const bad of [null, { ...good, extra: 1 }, { ...good, posts: [4, 9] }, { ...good, posts: [4, 4] }, { ...good, next: 9 }, { ...good, posts: [], next: 3 }, { ...good, total: -1 }, { ...good, indexing: 1 }, { ...good, posts: Array.from({ length: 31 }, (_, i) => 40 - i) }]) {
    t.is(validEvents(bad), null)
  }
  t.is(validEvents(good, 9), null, 'not below before')
  t.alike(validEvents(good, 10), good)
})

const gflags = { indexing: false, complete: true }
const hx = (i) => i.toString(16).padStart(64, '0')
const gardenGood = (over = {}) => ({ on: 2, state: null, helps: [{ author: B, seq: 3, followSeq: 4 }], given: [1, 2], ...gflags, ...over })
const streetGood = (over = {}) => ({ items: [{ key: B, on: 1, state: null }], next: null, ...gflags, ...over })

test('gardenUrl and gardenStreetUrl: lowercase hex64 only', async (t) => {
  const { gardenUrl, gardenStreetUrl } = await load()
  t.is(gardenUrl(A), '/index/garden/' + A)
  t.is(gardenStreetUrl(A), '/index/garden/' + A + '/rua')
  t.is(gardenStreetUrl(A, B), '/index/garden/' + A + '/rua/' + B)
  for (const bad of [A.toUpperCase(), 'abc', A + 'a', 7, null, undefined]) {
    t.is(gardenUrl(bad), null, 'owner ' + String(bad))
    t.is(gardenStreetUrl(bad), null, 'street owner ' + String(bad))
  }
  for (const bad of [B.toUpperCase(), 'abc', B + 'a', 7, '']) t.is(gardenStreetUrl(A, bad), null, 'cursor ' + String(bad))
})

test('validGarden: exact shape, bounds and copies', async (t) => {
  const { validGarden } = await load()
  const worst = gardenGood({ helps: Array.from({ length: 24 }, (_, i) => ({ author: hx(i + 1), seq: 1, followSeq: 1 })), given: Array.from({ length: 24 }, (_, i) => i + 1) })
  const out = validGarden(worst, A)
  t.alike(out, worst)
  t.not(out.helps, worst.helps)
  t.not(out.given, worst.given)
  t.not(out.helps[0], worst.helps[0])
  const row = { author: B, seq: 3, followSeq: 4 }
  const bads = [
    { ...gardenGood(), extra: 1 },
    gardenGood({ helps: [{ ...row, extra: 1 }] }),
    gardenGood({ helps: [{ ...row, pot: {} }] }),
    gardenGood({ helps: [{ author: B, seq: 3 }] }),
    (() => { const b = gardenGood(); delete b.given; return b })(),
    gardenGood({ helps: [{ ...row, author: A }] }),
    gardenGood({ helps: [{ ...row, author: B.toUpperCase() }] }),
    gardenGood({ helps: [{ ...row, seq: 0 }] }),
    gardenGood({ helps: [{ ...row, followSeq: null }] }),
    gardenGood({ helps: [row, row] }),
    gardenGood({ given: [1, 1] }),
    gardenGood({ helps: Array.from({ length: 25 }, (_, i) => ({ author: hx(i + 1), seq: 1, followSeq: 1 })) }),
    gardenGood({ given: Array.from({ length: 25 }, (_, i) => i + 1) }),
    gardenGood({ on: '1' }),
    gardenGood({ state: 0 }),
    gardenGood({ indexing: 'no' }),
    gardenGood({ complete: 1 }),
    gardenGood({ on: null, state: 3, helps: [], given: [] }),
    gardenGood({ on: null, helps: [row], given: [] }),
    gardenGood({ on: null, helps: [], given: [4] }),
    null,
    []
  ]
  bads.forEach((b, i) => t.is(validGarden(b, A), null, 'bad ' + i))
  const outside = gardenGood({ on: null, state: null, helps: [], given: [] })
  t.alike(validGarden(outside, A), outside, 'no garden block: empty lists')
  t.is(validGarden(gardenGood(), 'nope'), null, 'bad owner')
})

test('validGardenStreet: exact shape, page bound and stuck cursor', async (t) => {
  const { validGardenStreet } = await load()
  const page = streetGood({ items: Array.from({ length: 20 }, (_, i) => ({ key: hx(i + 1), on: 1, state: i === 0 ? null : 2 })), next: C })
  t.alike(validGardenStreet(page), page)
  const it = { key: B, on: 1, state: null }
  const bads = [
    streetGood({ items: Array.from({ length: 21 }, (_, i) => ({ key: hx(i + 1), on: 1, state: null })) }),
    streetGood({ items: [it, it] }),
    streetGood({ items: [{ ...it, on: null }] }),
    streetGood({ items: [{ ...it, state: 0 }] }),
    streetGood({ items: [{ ...it, extra: 1 }] }),
    { ...streetGood(), extra: 1 },
    streetGood({ next: 'abc' }),
    streetGood({ next: C.toUpperCase() }),
    streetGood({ complete: 'yes' }),
    streetGood({ items: [{ ...it, key: C }, it] }),
    streetGood({ items: [{ ...it, key: C }], next: B })
  ]
  bads.forEach((b, i) => t.is(validGardenStreet(b), null, 'bad ' + i))
  t.alike(validGardenStreet(streetGood({ items: [], next: C }), C), { items: [], next: null, indexing: false, complete: false })
  t.is(validGardenStreet(streetGood({ next: C }), C), null, 'an item at or before the cursor')
  t.is(validGardenStreet(streetGood({ items: [], next: A }), B), null, 'a next before the cursor walks back')
  t.alike(validGardenStreet(streetGood({ items: [{ ...it, key: C }], next: C }), B), streetGood({ items: [{ ...it, key: C }], next: C }), 'next may equal the last item')
})

test('fetchGarden and fetchGardenStreet: request, contract and failures', async (t) => {
  const { fetchGarden, fetchGardenStreet } = await load()
  const calls = []
  const g = await fetchGarden(A, { fetch: async (url, opts) => { calls.push({ url, opts }); return response(JSON.stringify(gardenGood())) } })
  t.is(g.ok, true)
  t.alike(g.value, gardenGood())
  t.is(calls[0].url, '/index/garden/' + A)
  t.is(calls[0].opts.method, 'GET')
  const s = await fetchGardenStreet(A, B, { fetch: async (url) => { calls.push({ url }); return response(JSON.stringify(streetGood({ items: [], next: B }))) } })
  t.alike([s.ok, s.value.next, s.value.complete], [true, null, false])
  t.is(calls[1].url, '/index/garden/' + A + '/rua/' + B)
  t.alike(await fetchGarden(A, { fetch: async () => response(JSON.stringify({ ...gardenGood(), pot: 1 })) }), { ok: false, reason: 'malformed' })
  t.alike(await fetchGardenStreet(A, null, { fetch: async () => response(JSON.stringify([])) }), { ok: false, reason: 'malformed' })
  const down = await fetchGarden(A, { fetch: async () => response('', { status: 500 }) })
  t.is(down.ok, false)
  let called = false
  const noFetch = { fetch: async () => { called = true } }
  t.alike(await fetchGarden('nope', noFetch), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchGardenStreet('nope', null, noFetch), { ok: false, reason: 'invalid-input' })
  t.alike(await fetchGardenStreet(A, 'abc', noFetch), { ok: false, reason: 'invalid-input' })
  t.is(called, false)
})

const stallGood = (over = {}) => ({ decor: 5, pending: [{ author: B, seq: 3, followSeq: 4 }], shelf: [{ seq: 7, from: C, gseq: 9 }], ...gflags, ...over })

test('gardenStallUrl: lowercase hex64 only', async (t) => {
  const { gardenStallUrl } = await load()
  t.is(gardenStallUrl(A), '/index/garden/' + A + '/mimos')
  for (const bad of [A.toUpperCase(), 'abc', A + 'a', 7, null, undefined]) t.is(gardenStallUrl(bad), null, 'owner ' + String(bad))
})

test('validGardenStall: exact shape, bounds and copies', async (t) => {
  const { validGardenStall } = await load()
  const worst = stallGood({
    pending: Array.from({ length: 12 }, (_, i) => ({ author: hx(i + 1), seq: 1, followSeq: 1 })),
    shelf: Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, from: hx(i + 1), gseq: 2 }))
  })
  const out = validGardenStall(worst, A)
  t.alike(out, worst)
  t.not(out.pending, worst.pending)
  t.not(out.shelf, worst.shelf)
  t.not(out.pending[0], worst.pending[0])
  t.not(out.shelf[0], worst.shelf[0])
  t.alike(validGardenStall(stallGood({ decor: null, pending: [], shelf: [] }), A), stallGood({ decor: null, pending: [], shelf: [] }))
  t.alike(validGardenStall(stallGood({ pending: [{ author: B, seq: 3, followSeq: 4 }, { author: B, seq: 4, followSeq: 4 }] }), A).pending.length, 2, 'one giver, two gifts')
  const row = { author: B, seq: 3, followSeq: 4 }
  const shelfRow = { seq: 7, from: C, gseq: 9 }
  const getter = stallGood()
  Object.defineProperty(getter, 'decor', { enumerable: true, get () { throw new Error('boom') } })
  const hiddenKey = stallGood()
  Object.defineProperty(hiddenKey, 'later', { enumerable: false, value: 1 })
  const symbolKey = stallGood()
  symbolKey[Symbol('x')] = 1
  const proto = Object.assign(Object.create({ decor: 5 }), { pending: [], shelf: [], ...gflags })
  const rowGetter = { author: B, seq: 3 }
  Object.defineProperty(rowGetter, 'followSeq', { enumerable: true, get () { return 4 } })
  const sparse = [row]
  sparse.length = 2
  const throwingProxy = new Proxy(stallGood(), { ownKeys () { throw new Error('boom') } })
  const { proxy: revoked, revoke } = Proxy.revocable(stallGood(), {})
  revoke()
  const bads = [
    { ...stallGood(), extra: 1 },
    (() => { const b = stallGood(); delete b.shelf; return b })(),
    { ...stallGood(), __proto__: null, constructor: 1 },
    stallGood({ pending: Array.from({ length: 13 }, (_, i) => ({ author: hx(i + 1), seq: 1, followSeq: 1 })) }),
    stallGood({ shelf: Array.from({ length: 9 }, (_, i) => ({ seq: i + 1, from: hx(i + 1), gseq: 1 })) }),
    stallGood({ pending: [row, row] }),
    stallGood({ pending: [{ ...row, extra: 1 }] }),
    stallGood({ pending: [{ author: B, seq: 3 }] }),
    stallGood({ pending: [{ ...row, author: A }] }),
    stallGood({ pending: [{ ...row, author: B.toUpperCase() }] }),
    stallGood({ pending: [{ ...row, seq: 0 }] }),
    stallGood({ pending: [{ ...row, followSeq: null }] }),
    stallGood({ pending: [{ ...row, seq: 1.5 }] }),
    stallGood({ shelf: [shelfRow, { ...shelfRow, from: B }] }),
    stallGood({ shelf: [{ ...shelfRow, from: A }] }),
    stallGood({ shelf: [{ ...shelfRow, extra: 1 }] }),
    stallGood({ shelf: [{ ...shelfRow, gseq: '9' }] }),
    stallGood({ shelf: [{ seq: 7, from: C }] }),
    stallGood({ decor: 0 }),
    stallGood({ decor: '5' }),
    stallGood({ pending: null }),
    stallGood({ shelf: {} }),
    stallGood({ indexing: 'no' }),
    stallGood({ complete: 1 }),
    stallGood({ pending: sparse }),
    stallGood({ pending: [rowGetter] }),
    getter,
    hiddenKey,
    symbolKey,
    proto,
    throwingProxy,
    revoked,
    null,
    [],
    'x'
  ]
  bads.forEach((b, i) => t.is(validGardenStall(b, A), null, 'bad ' + i))
  t.is(validGardenStall(stallGood(), 'nope'), null, 'bad owner')
})

test('fetchGardenStall: request, contract and failures', async (t) => {
  const { fetchGardenStall } = await load()
  const calls = []
  const g = await fetchGardenStall(A, { fetch: async (url, opts) => { calls.push({ url, opts }); return response(JSON.stringify(stallGood())) } })
  t.is(g.ok, true)
  t.alike(g.value, stallGood())
  t.is(calls[0].url, '/index/garden/' + A + '/mimos')
  t.is(calls[0].opts.method, 'GET')
  t.alike(await fetchGardenStall(A, { fetch: async () => response(JSON.stringify({ ...stallGood(), on: 1 })) }), { ok: false, reason: 'malformed' })
  t.alike(await fetchGardenStall(A, { fetch: async () => response('', { status: 404 }) }), { ok: false, reason: 'not-found' }, 'an older seeder')
  t.is((await fetchGardenStall(A, { fetch: async () => response('', { status: 400 }) })).ok, false, 'a 400 is a failure')
  let called = false
  t.alike(await fetchGardenStall('nope', { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.is(called, false)
})

function groupImage () {
  return { core: B, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: C, width: 512, height: 512 }
}

test('group images: bounded keys, configured origin and public images mapped by group', async (t) => {
  const { groupImagesUrl, fetchGroupImages, validGroupImages } = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  t.is(groupImagesUrl([A.toUpperCase(), B, A]), '/index/group-image/' + A + ',' + B)
  const keys = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(64, '0'))
  t.is(groupImagesUrl(keys), '/index/group-image/' + keys.join(','))
  for (const bad of [null, A, [], [null], new Array(1), ['bad'], [A + '/x'], [...keys, C]]) {
    t.is(groupImagesUrl(bad), null)
    t.alike(await fetchGroupImages(bad, { fetch: () => t.fail('invalid input reached fetch') }), new Map())
  }
  t.ok(setInstallation('https://example.test'))
  const image = groupImage()
  const body = { images: [{ group: A, image, author: B }], indexing: false }
  const calls = []
  const mapped = await fetchGroupImages([A.toUpperCase(), C], {
    fetch: async (url, init) => { calls.push({ url, init }); return response(JSON.stringify(body)) }
  })
  t.alike(mapped, new Map([[A, { image, author: B }]]))
  t.is(calls[0].url, 'https://example.test/index/group-image/' + A + ',' + C)
  t.is(calls[0].init.credentials, 'omit')
  t.is(calls[0].init.redirect, 'error')
  t.is(calls[0].init.cache, 'no-store')
  const copy = validGroupImages(body, [A])
  copy.get(A).image.bytes = 99
  t.is(image.bytes, 100, 'validated images are copied')
  t.alike(await fetchGroupImages(keys, { fetch: json({ images: keys.map((group) => ({ group, image, author: B })), indexing: true }) }),
    new Map(keys.map((group) => [group, { image, author: B }])))
})

test('group images: doubtful bodies and transport failures return an empty Map', async (t) => {
  const { fetchGroupImages, MAX_BODY_BYTES } = await load()
  const image = groupImage()
  const row = { group: A, image, author: B }
  const body = { images: [row], indexing: false }
  const privateImage = { core: B, mime: 'application/octet-stream', start: 1, blocks: 1, bytes: 32768, sha256: C, key: A, nonce: 'ab'.repeat(24), plainMime: 'image/jpeg', plainSha256: C, w: 512, h: 512, ms: 0 }
  for (const bad of [
    null, [], {}, { ...body, extra: true }, { images: [row] }, { ...body, indexing: 1 },
    { ...body, images: {} },
    ...[
      { ...row, extra: true }, { ...row, group: C }, { ...row, group: A.toUpperCase() },
      { ...row, author: 'bad' }, { ...row, author: B.toUpperCase() },
      { ...row, image: { ...image, mime: 'image/webp' } }, { ...row, image: privateImage },
      { ...row, image: { ...image, extra: true } }, { ...row, image: null }
    ].map((badRow) => ({ ...body, images: [badRow] })),
    { ...body, images: [row, row] },
    { ...body, images: [row, { ...row, group: B, author: 'bad' }] }
  ]) t.alike(await fetchGroupImages([A, B], { fetch: json(bad) }), new Map())
  for (const opts of [{ status: 404 }, { status: 500 }, { status: 302 }, { redirected: true }]) {
    t.alike(await fetchGroupImages([A], { fetch: json(body, opts) }), new Map())
  }
  t.alike(await fetchGroupImages([A], { fetch: async () => { throw new Error('offline') } }), new Map())
  t.alike(await fetchGroupImages([A], { fetch: async () => response('{') }), new Map())
  t.alike(await fetchGroupImages([A], { fetch: async () => response(' '.repeat(MAX_BODY_BYTES + 1)) }), new Map())
  t.alike(await fetchGroupImages([A], { fetch: () => new Promise(() => {}), timeoutMs: 1 }), new Map())
  t.alike(await fetchGroupImages([A], { fetch: json({ images: [], indexing: true }) }), new Map())
})

test('group abouts: bounded keys, normalized URL and descriptions mapped by group', async (t) => {
  const { groupAboutsUrl, fetchGroupAbouts } = await load()
  const keys = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(64, '0'))
  t.is(groupAboutsUrl(keys), '/index/group-about/' + keys.join(','))
  for (const bad of [null, A, [], [null], new Array(1), [A + '/x'], [...keys, C]]) {
    t.is(groupAboutsUrl(bad), null)
    t.alike(await fetchGroupAbouts(bad, { fetch: () => t.fail('invalid input reached fetch') }), new Map())
  }
  const about = '🌿'.repeat(280)
  const body = { abouts: [{ group: A, about }, { group: B, about: 'Leitura' }], indexing: true }
  const descriptions = await fetchGroupAbouts([A.toUpperCase(), B, A, C], {
    fetch: async (url) => {
      t.is(url, '/index/group-about/' + [A, B, C].join(','))
      return response(JSON.stringify(body))
    }
  })
  t.alike(descriptions, new Map([[A, about], [B, 'Leitura']]))
})

test('group abouts: one invalid row discards the response', async (t) => {
  const { fetchGroupAbouts } = await load()
  const row = { group: A, about: 'Leitura' }
  const other = { group: B, about: 'Passeios' }
  const body = { abouts: [row], indexing: false }
  for (const [label, bad] of [
    ['extra body key', { ...body, complete: true }],
    ['missing indexing flag', { abouts: [row] }],
    ['non-boolean indexing flag', { ...body, indexing: 1 }],
    ['non-array abouts', { ...body, abouts: {} }],
    ...[
      ['extra row key', { ...other, name: 'Grupo' }],
      ['foreign group', { ...other, group: C }],
      ['duplicate group', row],
      ['empty description', { ...other, about: '' }],
      ['non-string description', { ...other, about: 1 }],
      ['oversize description', { ...other, about: '🌿'.repeat(279) + 'ab' }],
      ...['\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029'].map((lineBreak) => ['line break', { ...other, about: 'um' + lineBreak + 'dois' }])
    ].map(([label, badRow]) => [label, { ...body, abouts: [row, badRow] }])
  ]) t.alike(await fetchGroupAbouts([A, B], { fetch: json(bad) }), new Map(), label)
})

test('group abouts: older seeders and failed requests leave the description absent', async (t) => {
  const { fetchGroupAbouts } = await load()
  const body = { abouts: [{ group: A, about: 'Leitura' }], indexing: false }
  t.alike(await fetchGroupAbouts([A], { fetch: json(body, { status: 404 }) }), new Map())
  t.alike(await fetchGroupAbouts([A], { fetch: async () => { throw new Error('offline') } }), new Map())
  t.alike(await fetchGroupAbouts([A], { fetch: json({ abouts: [], indexing: true }) }), new Map())
})

function standaloneRow (over = {}) {
  return { group: A, name: 'Leitura', creator: B, writerCount: 3, created: null, active: null, ...over }
}

function discoverCommunityRow (over = {}) {
  return { community: A, name: 'Praia', creator: B, join: 'open', members: 3, created: null, ...over }
}

function ofRow (over = {}) {
  return { group: A, name: 'Leitura', creator: B, writerCount: 3, ...over }
}

test('discover URL builders: orders, search segment, groups of a diary', async (t) => {
  const { discoverGroupsUrl, discoverCommunitiesUrl, discoverSearchUrl, discoverOfUrl } = await load()
  for (const order of ['members', 'recent', 'trending']) t.is(discoverGroupsUrl(order), '/index/discover/groups/' + order)
  for (const bad of ['Members', 'popular', '', null, 7, 'members/..', undefined]) t.is(discoverGroupsUrl(bad), null, String(bad))
  for (const order of ['members', 'recent']) t.is(discoverCommunitiesUrl(order), '/index/discover/communities/' + order)
  for (const bad of ['trending', 'Recent', '', null, 'recent/..', undefined]) t.is(discoverCommunitiesUrl(bad), null, String(bad))
  t.is(discoverSearchUrl('leitura'), '/index/discover/search/leitura')
  t.is(discoverSearchUrl('clube-de-leitura'), '/index/discover/search/clube-de-leitura')
  for (const bad of ['a', 'a-', '-ab', 'Leitura', 'clube de', 'clube%20de', 'ab/..', 'a'.repeat(21), 'ab-cd-ef-gh-ij', '', null, 7]) {
    t.is(discoverSearchUrl(bad), null, String(bad))
  }
  t.is(discoverOfUrl(A.toUpperCase()), '/index/discover/of/' + A)
  t.is(discoverOfUrl(A, B.toUpperCase()), '/index/discover/of/' + A + '/' + B)
  for (const bad of [null, 7, 'zz'.repeat(32), A + '/..', A.slice(2)]) {
    t.is(discoverOfUrl(bad), null)
    t.is(discoverOfUrl(A, bad === null ? 'nope' : bad), null)
  }
})

test('validDiscoverGroups: members order, exact standalone rows, cap 20', async (t) => {
  const { validDiscoverGroups } = await load()
  const body = {
    groups: [
      standaloneRow({ group: C, writerCount: 9, created: 1761000000000 }),
      standaloneRow({ group: A, writerCount: 4 }),
      standaloneRow({ group: B, writerCount: 4, creator: C })
    ],
    more: true,
    indexing: false,
    complete: true
  }
  t.alike(validDiscoverGroups(body, 'members'), body)
  const copy = validDiscoverGroups(body, 'members')
  t.not(copy.groups[0], body.groups[0], 'fresh copy')
  const full = { ...body, groups: Array.from({ length: 20 }, (_, i) => standaloneRow({ group: hexOf(i), writerCount: 1 })) }
  t.alike(validDiscoverGroups(full, 'members'), full)
  const empty = { groups: [], more: false, indexing: true, complete: false }
  t.alike(validDiscoverGroups(empty, 'members'), empty)
  const bad = [
    { ...body, extra: 1 },
    { groups: body.groups, indexing: false, complete: true },
    { ...body, more: 'no' },
    { ...body, indexing: 1 },
    { ...body, complete: null },
    { ...body, groups: Array.from({ length: 21 }, (_, i) => standaloneRow({ group: hexOf(i), writerCount: 1 })) },
    { ...body, groups: [{ ...standaloneRow(), extra: 1 }] },
    { ...body, groups: [{ ...standaloneRow(), community: C }] },
    { ...body, groups: [{ ...standaloneRow(), community: null }] },
    { ...body, groups: [{ ...standaloneRow(), communityName: 'Praia' }] },
    { ...body, groups: [browseRow()] },
    { ...body, groups: [(() => { const r = standaloneRow(); delete r.active; return r })()] },
    { ...body, groups: [(() => { const r = standaloneRow(); delete r.created; return r })()] },
    { ...body, groups: [standaloneRow({ name: null })] },
    { ...body, groups: [standaloneRow({ name: '' })] },
    { ...body, groups: [standaloneRow({ name: 7 })] },
    { ...body, groups: [standaloneRow({ name: 'x'.repeat(81) })] },
    { ...body, groups: [standaloneRow({ writerCount: 0 })] },
    { ...body, groups: [standaloneRow({ writerCount: 1.5 })] },
    { ...body, groups: [standaloneRow({ writerCount: '3' })] },
    { ...body, groups: [standaloneRow({ group: A.toUpperCase() })] },
    { ...body, groups: [standaloneRow({ group: A.slice(2) })] },
    { ...body, groups: [standaloneRow({ creator: 'x' })] },
    { ...body, groups: [standaloneRow({ creator: null })] },
    { ...body, groups: [standaloneRow({ created: -1 })] },
    { ...body, groups: [standaloneRow({ created: '1' })] },
    { ...body, groups: [standaloneRow({ created: 8640000000000001 })] },
    { ...body, groups: [standaloneRow({ active: 1 })] },
    { ...body, groups: [standaloneRow(), standaloneRow()] },
    { ...body, groups: [standaloneRow({ writerCount: 4 }), standaloneRow({ writerCount: 3 })] },
    { ...body, groups: [standaloneRow({ group: A, writerCount: 2 }), standaloneRow({ group: B, writerCount: 3 })] },
    { ...body, groups: [standaloneRow({ group: B, writerCount: 3 }), standaloneRow({ group: A, writerCount: 3 })] },
    { ...body, groups: [standaloneRow(), null] },
    { ...body, groups: {} },
    null,
    []
  ]
  for (const b of bad) t.is(validDiscoverGroups(b, 'members'), null, JSON.stringify(b).slice(0, 80))
  for (const order of ['popular', null, undefined]) t.is(validDiscoverGroups(body, order), null, 'unknown order')
})

test('validDiscoverGroups: recent at most 2 per creator, trending 2 <= active <= writerCount', async (t) => {
  const { validDiscoverGroups } = await load()
  const recent = {
    groups: [
      standaloneRow({ group: C, created: 1761000300000 }),
      standaloneRow({ group: A, created: 1761000000000 }),
      standaloneRow({ group: B, created: 1761000000000, creator: C }),
      standaloneRow({ group: hexOf(1), created: 0, creator: C })
    ],
    more: false,
    indexing: false,
    complete: true
  }
  t.alike(validDiscoverGroups(recent, 'recent'), recent)
  t.is(validDiscoverGroups(recent, 'members'), null, 'members: ties by group key up')
  const badRecent = [
    { ...recent, groups: [standaloneRow({ group: A, created: 1 }), standaloneRow({ group: B, created: 2 })] },
    { ...recent, groups: [standaloneRow({ group: B, created: 2 }), standaloneRow({ group: A, created: 2 })] },
    { ...recent, groups: [standaloneRow({ created: null })] },
    { ...recent, groups: [standaloneRow({ created: 5, active: 1 })] },
    { ...recent, groups: [standaloneRow({ group: A, created: 3 }), standaloneRow({ group: B, created: 2 }), standaloneRow({ group: C, created: 1 })] }
  ]
  for (const b of badRecent) t.is(validDiscoverGroups(b, 'recent'), null, JSON.stringify(b).slice(0, 80))
  t.ok(validDiscoverGroups(badRecent[4], 'members'), 'three of one creator are fine outside recent')
  const trending = {
    groups: [
      standaloneRow({ group: C, active: 5, writerCount: 9 }),
      standaloneRow({ group: A, active: 2, writerCount: 2, created: 1761000000000 }),
      standaloneRow({ group: B, active: 2, writerCount: 7 })
    ],
    more: false,
    indexing: false,
    complete: true
  }
  t.alike(validDiscoverGroups(trending, 'trending'), trending)
  t.is(validDiscoverGroups(trending, 'members'), null)
  t.is(validDiscoverGroups(trending, 'recent'), null)
  const badTrending = [
    { ...trending, groups: [standaloneRow({ active: 4, writerCount: 3 })] },
    { ...trending, groups: [standaloneRow({ active: 0 })] },
    { ...trending, groups: [standaloneRow({ active: null })] },
    { ...trending, groups: [standaloneRow({ active: 1.5 })] },
    { ...trending, groups: [standaloneRow({ active: 2, created: 'x' })] },
    { ...trending, groups: [standaloneRow({ group: A, active: 2 }), standaloneRow({ group: B, active: 3 })] },
    { ...trending, groups: [standaloneRow({ group: B, active: 2 }), standaloneRow({ group: A, active: 2 })] }
  ]
  const lone = { ...trending, groups: [standaloneRow({ active: 2, writerCount: 2 })] }
  t.alike(validDiscoverGroups(lone, 'trending'), lone, 'two active diaries list')
  t.is(validDiscoverGroups({ ...trending, groups: [standaloneRow({ active: 1, writerCount: 2 })] }, 'trending'), null, 'one active diary never lists')
  t.is(validDiscoverGroups({ ...trending, groups: [standaloneRow({ group: C, active: 5 }), standaloneRow({ group: A, active: 1 })] }, 'trending'), null, 'one bad row fails the answer')
  for (const b of badTrending) t.is(validDiscoverGroups(b, 'trending'), null, JSON.stringify(b).slice(0, 80))
})

test('validDiscoverCommunities: members and recent, exact rows, join, cap 20', async (t) => {
  const { validDiscoverCommunities } = await load()
  const body = {
    communities: [
      discoverCommunityRow({ community: C, members: 9, created: 1761000000000 }),
      discoverCommunityRow({ community: A, members: 4, join: 'approval' }),
      discoverCommunityRow({ community: B, members: 4, creator: C })
    ],
    more: true,
    indexing: false,
    complete: true
  }
  t.alike(validDiscoverCommunities(body, 'members'), body)
  const copy = validDiscoverCommunities(body, 'members')
  t.not(copy.communities[0], body.communities[0], 'fresh copy')
  const full = { ...body, communities: Array.from({ length: 20 }, (_, i) => discoverCommunityRow({ community: hexOf(i), members: 1 })) }
  t.alike(validDiscoverCommunities(full, 'members'), full)
  const empty = { communities: [], more: false, indexing: true, complete: false }
  t.alike(validDiscoverCommunities(empty, 'members'), empty)
  const recent = {
    communities: [
      discoverCommunityRow({ community: C, created: 1761000300000 }),
      discoverCommunityRow({ community: A, created: 1761000000000 }),
      discoverCommunityRow({ community: B, created: 1761000000000, creator: C }),
      discoverCommunityRow({ community: hexOf(1), created: 0, creator: C })
    ],
    more: false,
    indexing: false,
    complete: true
  }
  t.alike(validDiscoverCommunities(recent, 'recent'), recent)
  t.is(validDiscoverCommunities(body, 'recent'), null, 'recent never lists a null created')
  const bad = [
    { ...body, extra: 1 },
    { communities: body.communities, indexing: false, complete: true },
    { ...body, groups: [] },
    { ...body, more: 1 },
    { ...body, indexing: 'no' },
    { ...body, communities: Array.from({ length: 21 }, (_, i) => discoverCommunityRow({ community: hexOf(i), members: 1 })) },
    { ...body, communities: [{ ...discoverCommunityRow(), extra: 1 }] },
    { ...body, communities: [{ ...discoverCommunityRow(), group: C }] },
    { ...body, communities: [(() => { const r = discoverCommunityRow(); delete r.join; return r })()] },
    { ...body, communities: [ofRow()] },
    { ...body, communities: [discoverCommunityRow({ join: 'closed' })] },
    { ...body, communities: [discoverCommunityRow({ join: null })] },
    { ...body, communities: [discoverCommunityRow({ name: null })] },
    { ...body, communities: [discoverCommunityRow({ name: '' })] },
    { ...body, communities: [discoverCommunityRow({ name: 'x'.repeat(81) })] },
    { ...body, communities: [discoverCommunityRow({ members: 0 })] },
    { ...body, communities: [discoverCommunityRow({ members: -1 })] },
    { ...body, communities: [discoverCommunityRow({ community: 'x' })] },
    { ...body, communities: [discoverCommunityRow({ creator: A.toUpperCase() })] },
    { ...body, communities: [discoverCommunityRow({ created: -1 })] },
    { ...body, communities: [discoverCommunityRow({ created: 8640000000000001 })] },
    { ...body, communities: [discoverCommunityRow(), discoverCommunityRow()] },
    { ...body, communities: [discoverCommunityRow({ members: 4 }), discoverCommunityRow({ members: 3 })] },
    { ...body, communities: [discoverCommunityRow({ community: A, members: 2 }), discoverCommunityRow({ community: B, members: 3 })] },
    { ...body, communities: [discoverCommunityRow({ community: B, members: 3 }), discoverCommunityRow({ community: A, members: 3 })] },
    { ...body, communities: null },
    null
  ]
  for (const b of bad) t.is(validDiscoverCommunities(b, 'members'), null, JSON.stringify(b).slice(0, 80))
  const badRecent = [
    { ...recent, communities: [discoverCommunityRow({ community: A, created: 1 }), discoverCommunityRow({ community: B, created: 2 })] },
    { ...recent, communities: [discoverCommunityRow({ community: B, created: 2 }), discoverCommunityRow({ community: A, created: 2 })] },
    { ...recent, communities: [discoverCommunityRow({ community: A, created: 3 }), discoverCommunityRow({ community: B, created: 2 }), discoverCommunityRow({ community: C, created: 1 })] }
  ]
  for (const b of badRecent) t.is(validDiscoverCommunities(b, 'recent'), null, JSON.stringify(b).slice(0, 80))
  t.ok(validDiscoverCommunities({ ...badRecent[2], communities: badRecent[2].communities.map((r) => ({ ...r, created: null })) }, 'members'), 'three of one creator are fine outside recent')
  for (const order of ['trending', 'popular', null]) t.is(validDiscoverCommunities(body, order), null, 'no such order')
})

test('validDiscoverSearch: two capped lists, exact rows, every key once', async (t) => {
  const { validDiscoverSearch } = await load()
  const body = {
    groups: [{ group: A, name: 'Leitura', creator: B, writerCount: 3 }, { group: B, name: 'Clube de leitura', creator: B, writerCount: 9 }],
    communities: [{ community: C, name: 'Leitores', creator: A, members: 4 }, { community: hexOf(1), name: 'Leitura viva', creator: C, members: 1 }],
    moreGroups: true,
    moreCommunities: false,
    indexing: false,
    complete: true
  }
  t.alike(validDiscoverSearch(body), body)
  const copy = validDiscoverSearch(body)
  t.not(copy.groups[0], body.groups[0], 'fresh copy')
  t.not(copy.communities[0], body.communities[0], 'fresh copy')
  const empty = { groups: [], communities: [], moreGroups: false, moreCommunities: false, indexing: true, complete: false }
  t.alike(validDiscoverSearch(empty), empty)
  const full = {
    ...body,
    groups: Array.from({ length: 20 }, (_, i) => ({ group: hexOf(i), name: 'g', creator: A, writerCount: 1 })),
    communities: Array.from({ length: 20 }, (_, i) => ({ community: hexOf(100 + i), name: 'c', creator: A, members: 1 }))
  }
  t.alike(validDiscoverSearch(full), full)
  const bad = [
    { ...body, extra: 1 },
    { ...body, more: true },
    (() => { const b = { ...body }; delete b.moreGroups; return b })(),
    (() => { const b = { ...body }; delete b.communities; return b })(),
    { ...body, moreCommunities: 'no' },
    { ...body, complete: 1 },
    { ...body, groups: [{ group: A, name: 'Leitura', creator: B, writerCount: 3, community: C }] },
    { ...body, groups: [{ group: A, name: 'Leitura', writerCount: 3 }] },
    { ...body, groups: [{ group: A, name: 'Leitura', creator: null, writerCount: 3 }] },
    { ...body, groups: [{ group: A, name: 'Leitura', creator: 'x', writerCount: 3 }] },
    { ...body, groups: [{ group: A, name: 'Leitura', creator: B.toUpperCase(), writerCount: 3 }] },
    { ...body, groups: [{ group: A, name: 'Leitura', creator: B, members: 3 }] },
    { ...body, groups: [{ group: A, name: null, creator: B, writerCount: 3 }] },
    { ...body, groups: [{ group: A, name: '', creator: B, writerCount: 3 }] },
    { ...body, groups: [{ group: A, name: 'Leitura', creator: B, writerCount: 0 }] },
    { ...body, groups: [{ group: 'x', name: 'Leitura', creator: B, writerCount: 3 }] },
    { ...body, groups: [body.groups[0], body.groups[0]] },
    { ...body, groups: Array.from({ length: 21 }, (_, i) => ({ group: hexOf(i), name: 'g', creator: A, writerCount: 1 })) },
    { ...body, groups: {} },
    { ...body, communities: [{ community: C, name: 'Leitores', creator: A, members: 4, join: 'open' }] },
    { ...body, communities: [{ community: C, name: 'Leitores', members: 4 }] },
    { ...body, communities: [{ community: C, name: 'Leitores', creator: null, members: 4 }] },
    { ...body, communities: [{ community: C, name: 'Leitores', creator: 'x', members: 4 }] },
    { ...body, communities: [{ community: C, name: 'Leitores', creator: A.toUpperCase(), members: 4 }] },
    { ...body, communities: [{ community: C, name: 'Leitores', creator: A, writerCount: 4 }] },
    { ...body, communities: [{ group: C, name: 'Leitores', creator: A, members: 4 }] },
    { ...body, communities: [{ community: C, name: null, creator: A, members: 4 }] },
    { ...body, communities: [{ community: C, name: 'Leitores', creator: A, members: 0 }] },
    { ...body, communities: [{ community: C.toUpperCase(), name: 'Leitores', creator: A, members: 4 }] },
    { ...body, communities: [body.communities[0], body.communities[0]] },
    { ...body, communities: Array.from({ length: 21 }, (_, i) => ({ community: hexOf(100 + i), name: 'c', creator: A, members: 1 })) },
    { ...body, communities: [{ community: A, name: 'Leitura', creator: B, members: 3 }] },
    null,
    []
  ]
  for (const b of bad) t.is(validDiscoverSearch(b), null, JSON.stringify(b).slice(0, 80))
})

test('validDiscoverOf: ascending rows after the cursor, full-page next, hidden', async (t) => {
  const { validDiscoverOf } = await load()
  const body = { groups: [ofRow({ group: A }), ofRow({ group: B, creator: C })], next: null, hidden: false, indexing: false, complete: true }
  t.alike(validDiscoverOf(body), body)
  t.alike(validDiscoverOf(body, hexOf(1)), body)
  const copy = validDiscoverOf(body)
  t.not(copy.groups[0], body.groups[0], 'fresh copy')
  const hidden = { groups: [], next: null, hidden: true, indexing: false, complete: true }
  t.alike(validDiscoverOf(hidden), hidden)
  const pending = { groups: [], next: null, hidden: false, indexing: true, complete: false }
  t.alike(validDiscoverOf(pending), pending)
  const full = { ...body, groups: Array.from({ length: 32 }, (_, i) => ofRow({ group: hexOf(i) })), next: hexOf(31) }
  t.alike(validDiscoverOf(full), full)
  t.alike(validDiscoverOf({ ...full, next: null }), { ...full, next: null })
  const bad = [
    { ...body, extra: 1 },
    (() => { const b = { ...body }; delete b.hidden; return b })(),
    { ...body, hidden: 'no' },
    { ...body, hidden: true },
    { ...hidden, next: A },
    { ...body, complete: null },
    { ...body, next: B },
    { ...body, next: 'x' },
    { ...body, groups: [], next: A },
    { ...full, next: hexOf(30) },
    { ...full, groups: full.groups.slice(0, 31), next: hexOf(30) },
    { ...body, groups: Array.from({ length: 33 }, (_, i) => ofRow({ group: hexOf(i) })) },
    { ...body, groups: [ofRow({ group: B }), ofRow({ group: A })] },
    { ...body, groups: [ofRow({ group: A }), ofRow({ group: A })] },
    { ...body, groups: [{ ...ofRow(), community: C }] },
    { ...body, groups: [{ ...ofRow(), communityName: 'Praia' }] },
    { ...body, groups: [publicRow()] },
    { ...body, groups: [{ ...ofRow(), created: 1 }] },
    { ...body, groups: [ofRow({ name: null })] },
    { ...body, groups: [ofRow({ name: '' })] },
    { ...body, groups: [ofRow({ writerCount: 0 })] },
    { ...body, groups: [ofRow({ creator: null })] },
    { ...body, groups: [ofRow({ group: A.toUpperCase() })] },
    { ...body, groups: null },
    null
  ]
  for (const b of bad) t.is(validDiscoverOf(b), null, JSON.stringify(b).slice(0, 80))
  t.is(validDiscoverOf(body, A), null, 'row equal to the cursor')
  t.is(validDiscoverOf(body, C), null, 'row before the cursor')
  t.is(validDiscoverOf(body, 'x'), null, 'invalid cursor')
})

test('discover fetchers: requests, validation, 404 stays not-found with no legacy fallback', async (t) => {
  const { fetchDiscoverGroups, fetchDiscoverCommunities, fetchDiscoverSearch, fetchStandaloneGroupsOf } = await load()
  const groups = { groups: [standaloneRow({ active: 2 })], more: false, indexing: false, complete: true }
  const communities = { communities: [discoverCommunityRow({ created: 1761000000000 })], more: false, indexing: false, complete: true }
  const search = { groups: [{ group: A, name: 'Leitura', creator: B, writerCount: 3 }], communities: [], moreGroups: false, moreCommunities: false, indexing: false, complete: true }
  const of = { groups: [ofRow({ group: B })], next: null, hidden: false, indexing: false, complete: true }
  const calls = []
  const serve = (body) => async (url, opts) => { calls.push({ url, opts }); return response(JSON.stringify(body)) }

  t.alike(await fetchDiscoverGroups('trending', { fetch: serve(groups) }), { ok: true, value: groups })
  t.is(calls[0].url, '/index/discover/groups/trending')
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  t.is((await fetchDiscoverGroups('members', { fetch: serve(groups) })).reason, 'malformed', 'checked against the order asked')
  t.is((await fetchDiscoverGroups('trending', { fetch: serve({ ...groups, groups: [{ ...groups.groups[0], community: C }] }) })).reason, 'malformed')
  t.alike(await fetchDiscoverGroups('popular', { fetch: serve(groups) }), { ok: false, reason: 'invalid-input' })

  t.alike(await fetchDiscoverCommunities('recent', { fetch: serve(communities) }), { ok: true, value: communities })
  t.is(calls[3].url, '/index/discover/communities/recent')
  t.alike(await fetchDiscoverCommunities('trending', { fetch: serve(communities) }), { ok: false, reason: 'invalid-input' })

  t.alike(await fetchDiscoverSearch('clube-de-leitura', { fetch: serve(search) }), { ok: true, value: search })
  t.is(calls[4].url, '/index/discover/search/clube-de-leitura')
  t.absent(calls[4].opts.body, 'the words travel only in the path')
  t.alike(await fetchDiscoverSearch('Clube de leitura', { fetch: serve(search) }), { ok: false, reason: 'invalid-input' })

  t.alike(await fetchStandaloneGroupsOf(C.toUpperCase(), null, { fetch: serve(of) }), { ok: true, value: of })
  t.is(calls[5].url, '/index/discover/of/' + C)
  t.alike(await fetchStandaloneGroupsOf(C, A.toUpperCase(), { fetch: serve(of) }), { ok: true, value: of })
  t.is(calls[6].url, '/index/discover/of/' + C + '/' + A)
  t.is((await fetchStandaloneGroupsOf(C, B, { fetch: serve(of) })).reason, 'malformed', 'response is checked against the cursor')
  for (const [diary, after] of [['bad', null], [C, 'bad'], [null, null]]) {
    t.alike(await fetchStandaloneGroupsOf(diary, after, { fetch: serve(of) }), { ok: false, reason: 'invalid-input' })
  }
  t.is(calls.length, 8, 'invalid input makes no request')

  const notFound = []
  const missing = async (url) => { notFound.push(url); return response('{}', { status: 404 }) }
  t.alike(await fetchDiscoverGroups('members', { fetch: missing }), { ok: false, reason: 'not-found' })
  t.alike(await fetchDiscoverCommunities('members', { fetch: missing }), { ok: false, reason: 'not-found' })
  t.alike(await fetchDiscoverSearch('leitura', { fetch: missing }), { ok: false, reason: 'not-found' })
  t.alike(await fetchStandaloneGroupsOf(C, null, { fetch: missing }), { ok: false, reason: 'not-found' })
  t.alike(notFound, ['/index/discover/groups/members', '/index/discover/communities/members', '/index/discover/search/leitura', '/index/discover/of/' + C], 'one request each, never a legacy route')

  t.is((await fetchDiscoverSearch('leitura', { fetch: json(search, { status: 500 }) })).reason, 'status')
  t.is((await fetchStandaloneGroupsOf(C, null, { fetch: json(of, { redirected: true }) })).reason, 'status')
  t.is((await fetchDiscoverCommunities('members', { fetch: async () => { throw new Error('offline') } })).reason, 'network')
  const limited = await fetchDiscoverGroups('members', { fetch: json(groups, { status: 429 }) })
  t.is(limited.reason, 'rate-limited')
  t.ok(Number.isFinite(limited.retryAfterMs))
})
