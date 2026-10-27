// Seeder index client: URL building, transport rules (status, redirect,
// timeout, 64 KiB cap) and strict response validation, with fetch injected
// (no network).
'use strict'

const test = require('brittle')
const load = () => import('../src/indexClient.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const REF = A + ':5'
const CURSOR = '1761000000000.' + B + '.7'

function response (body, { status = 200, redirected = false, chunked = true } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  let sent = false
  let cancelled = false
  const res = {
    status,
    redirected,
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

function searchBody (over = {}) {
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

test('searchUrl: folded tokens joined by a literal plus, nothing else', async (t) => {
  const { searchUrl } = await load()
  t.is(searchUrl('ceu'), '/index/search/ceu')
  t.is(searchUrl('ceu+azul'), '/index/search/ceu+azul', 'literal plus, not %2B')
  t.is(searchUrl('ceu+azul', CURSOR), '/index/search/ceu+azul/' + CURSOR)
  t.is(searchUrl(Array.from({ length: 8 }, () => 'ab').join('+')), '/index/search/' + Array.from({ length: 8 }, () => 'ab').join('+'))
  t.is(searchUrl('x'.repeat(32)), '/index/search/' + 'x'.repeat(32))
  const nine = Array.from({ length: 9 }, () => 'ab').join('+')
  for (const bad of ['Céu', 'CEU', 'ceu azul', 'ceu%2Bazul', 'ceu?x=1', 'a', 'x'.repeat(33), nine, '', 'ceu+', '+ceu', 'ceu++azul', 'ceu/azul', null, 7, ['ceu']]) {
    t.is(searchUrl(bad), null, 'path ' + String(bad))
  }
  for (const bad of ['x', '1.' + B + '.0', CURSOR + '/x', 7]) {
    t.is(searchUrl('ceu', bad), null, 'cursor ' + String(bad))
  }
})

test('validSearch: exact shape, hints for exactly the items\' authors', async (t) => {
  const { validSearch, SEARCH_MAX } = await load()
  t.is(SEARCH_MAX, 30)
  t.alike(validSearch(searchBody()), searchBody())
  const empty = { items: [], next: null, authors: {}, indexing: true, complete: false }
  t.alike(validSearch(empty), empty, 'empty list')
  const thirty = Array.from({ length: 30 }, (_, i) => A + ':' + (i + 1))
  t.alike(validSearch(searchBody({ items: thirty, authors: { [A]: { profileSeq: null, usernameSeq: null } } })).items, thirty, '30 items')
  const missing = searchBody()
  delete missing.next
  const bad = [
    searchBody({ extra: 1 }),
    missing,
    searchBody({ items: Array.from({ length: 31 }, (_, i) => A + ':' + (i + 1)), authors: { [A]: { profileSeq: null, usernameSeq: null } } }),
    searchBody({ items: [A + ':5', A + ':5'], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    searchBody({ items: [A + ':0'], authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    searchBody({ items: 'x' }),
    searchBody({ next: 'x' }),
    searchBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, ['zz'.repeat(32)]: { profileSeq: null, usernameSeq: 2 } } }),
    searchBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: null, usernameSeq: 2 }, [C]: { profileSeq: null, usernameSeq: null } } }),
    searchBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null } } }),
    searchBody({ authors: { [A]: { profileSeq: 1, usernameSeq: null }, [B]: { profileSeq: 0, usernameSeq: 2 } } }),
    searchBody({ authors: [] }),
    searchBody({ indexing: 'no' }),
    searchBody({ complete: 1 }),
    searchBody({ complete: null }),
    null,
    []
  ]
  for (const body of bad) t.is(validSearch(body), null, JSON.stringify(body).slice(0, 80))
})

test('fetchSearch: transport, contract and a fresh copy', async (t) => {
  const { fetchSearch, validSearch } = await load()
  const calls = []
  const parsed = searchBody()
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    return response(JSON.stringify(parsed))
  }
  const res = await fetchSearch('ceu+azul', CURSOR, { fetch })
  t.is(res.ok, true)
  t.alike(res.value, searchBody())
  t.is(calls[0].url, '/index/search/ceu+azul/' + CURSOR)
  t.is(calls[0].opts.credentials, 'omit')
  t.is(calls[0].opts.redirect, 'error')
  // A fresh copy: mutating the result leaves the parsed body untouched.
  const own = searchBody()
  const copy = validSearch(own)
  copy.items.push(C + ':1')
  copy.authors[A].profileSeq = 99
  t.is(own.items.length, 3, 'items copied')
  t.is(own.authors[A].profileSeq, 1, 'hints copied')
  res.value.items.length = 0
  t.is(parsed.items.length, 3, 'the fetched result is a copy too')
  let called = false
  t.alike(await fetchSearch('Céu', null, { fetch: async () => { called = true } }), { ok: false, reason: 'invalid-input' })
  t.absent(called, 'no request for bad input')
  const text = JSON.stringify(searchBody())
  t.is((await fetchSearch('ceu', null, { fetch: async () => response(text, { status: 404 }) })).reason, 'not-found')
  t.is((await fetchSearch('ceu', null, { fetch: async () => response(text, { redirected: true }) })).reason, 'status')
  t.is((await fetchSearch('ceu', null, { fetch: async () => response(JSON.stringify(searchBody({ pad: 'x'.repeat(70000) }))) })).reason, 'too-large')
  t.is((await fetchSearch('ceu', null, { fetch: json(searchBody({ next: 'x' })) })).reason, 'malformed')
  t.is((await fetchSearch('ceu', null, { fetch: async () => response('not json') })).reason, 'malformed')
})
