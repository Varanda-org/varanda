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
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 429 }) })).reason, 'status')
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 503 }) })).reason, 'status')
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { redirected: true }) })).reason, 'status')
  t.is((await fetchSearch('ana', { fetch: async () => response(body, { status: 404, redirected: true }) })).reason, 'status')
  const big = response(JSON.stringify(searchBody({ pad: 'x'.repeat(70000) })))
  t.is((await fetchSearch('ana', { fetch: async () => big })).reason, 'too-large')
  t.ok(big.cancelled, 'oversized read is cancelled')
})
