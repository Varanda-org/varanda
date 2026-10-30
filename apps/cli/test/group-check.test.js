'use strict'

// The account-side group confirmation (apps/cli/lib/account/group-check.js)
// against a local http fixture standing in for the seeder's public
// /index/group route. No DHT, no network beyond 127.0.0.1.
const test = require('brittle')
const http = require('node:http')
const { createGroupCheck, MAX_PAGES, MAX_RUNNING, CACHE_MS } = require('../lib/account/group-check')

const G = 'a1'.repeat(32)
const W = 'b2'.repeat(32)
const D = 'c3'.repeat(32)
const OTHER = 'd4'.repeat(32)
const TOKEN = 'e5'.repeat(32)

function groupBody (over = {}) {
  return { kind: 'grupo', visibility: 'publico', join: 'aberto', name: 'Horta', creator: OTHER, rootServed: true, writers: [], next: null, indexing: false, complete: true, ...over }
}

// The token-gated message route: by default the seeder decodes a group-post
// of G bound to D at any seq, for the right token only. `requests` keeps
// the index reads, `posts` the message reads.
function goodPost (req, res) {
  const m = /^\/moderation-group-post\/([0-9a-f]{64})\/([0-9]{1,15})$/.exec(req.url)
  if (m === null || req.headers.authorization !== 'Bearer ' + TOKEN) return res.writeHead(404).end()
  json({ group: G, diary: D, seq: Number(m[2]), texto: 'mensagem lida', resposta: null })(req, res)
}

async function fixture (t) {
  const state = { handler: (req, res) => res.writeHead(404).end(), post: goodPost, requests: [], posts: [] }
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    if (req.url.startsWith('/moderation-group-post/')) {
      state.posts.push(req.url)
      return state.post(req, res)
    }
    state.requests.push(req.url)
    state.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  state.baseUrl = 'http://127.0.0.1:' + server.address().port
  return state
}

function json (obj) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
}

test('group-check: confirms a listed writer of a served root', async (t) => {
  const f = await fixture(t)
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  const r = await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 })
  t.alike(r, { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' })
  t.alike(f.requests, ['/index/group/' + G])
})

test('group-check: a key that is not a served root (kind null) is ausente', async (t) => {
  const f = await fixture(t)
  f.handler = json(groupBody({ kind: null, name: null, creator: null }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'ausente' })
  f.handler = (req, res) => res.writeHead(404).end()
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'ausente' })
})

test('group-check: a writer listed with another diary, or missing, is nao-membro', async (t) => {
  const f = await fixture(t)
  f.handler = json(groupBody({ writers: [{ key: W, diary: OTHER, length: 3, seq: 1, left: false }] }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'nao-membro' })
  f.handler = json(groupBody())
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'nao-membro' })
})

test('group-check: pages through the cursor, at most MAX_PAGES pages', async (t) => {
  const f = await fixture(t)
  // Each page names a fresh cursor; the writer sits on page 3.
  f.handler = (req, res) => {
    const n = f.requests.length
    const writers = n === 3 ? [{ key: W, diary: D, length: 2, seq: 0, left: false }] : []
    json(groupBody({ writers, next: n.toString(16).padStart(2, '0').repeat(32) }))(req, res)
  }
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' })
  t.is(f.requests.length, 3)
  t.is(f.requests[1], '/index/group/' + G + '/' + '01'.repeat(32))

  f.requests.length = 0
  f.handler = (req, res) => json(groupBody({ next: (f.requests.length).toString(16).padStart(2, '0').repeat(32) }))(req, res)
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'nao-membro' })
  t.is(f.requests.length, MAX_PAGES)
})

test('group-check: bad config, malformed answers and a dead seeder never throw', async (t) => {
  t.alike(await createGroupCheck({ baseUrl: 'http://example.com:80' }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'config' })
  const f = await fixture(t)
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  t.alike(await check.check(null), { ok: false, code: 'config' })
  t.alike(await check.check({ group: 'x', writer: W, diary: D, seq: 1 }), { ok: false, code: 'config' })
  f.handler = (req, res) => res.writeHead(200).end('{nope')
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' })
  f.handler = json(groupBody({ next: 'zz' }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' })
  f.handler = (req, res) => res.writeHead(302, { location: '/elsewhere' }).end()
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' })
  f.handler = () => {}
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl, timeoutMs: 100 }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'timeout' })
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: 'http://127.0.0.1:1' }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' })
})

test('group-check: the reported seq must exist on the writer (block 0 is its header); the answer is cached per seq', async (t) => {
  const f = await fixture(t)
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  const c = { t: 0 }
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl, now: () => c.t })
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 2 })).ok, true, 'block 2 of 3')
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 3 }), { ok: false, code: 'sem-mensagem' }, 'beyond the length')
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 3 }), { ok: false, code: 'sem-mensagem' })
  t.is(f.requests.length, 2, 'one read per seq, sem-mensagem cached')
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 1, seq: 0, left: false }] }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'sem-mensagem' }, 'a header-only writer holds no message')
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 'x', seq: 0, left: false }] }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'sem-mensagem' }, 'a length that is not an integer')
  t.alike(await check.check({ group: G, writer: W, diary: D }), { ok: false, code: 'config' }, 'seq is required')
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 0 }), { ok: false, code: 'config' })
})

test('group-check: ok only once the seeder hands out the message itself, of this group and diary, with the token', async (t) => {
  const f = await fixture(t)
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  const r = await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 })
  t.alike(r, { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' })
  t.alike(f.posts, ['/moderation-group-post/' + W + '/2'])

  t.alike(await createGroupCheck({ baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'config' }, 'no token: refused before any read')
  t.is(f.posts.length, 1)
  const wrong = 'f6'.repeat(32)
  t.alike(await createGroupCheck({ token: wrong, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'nao-lida' }, 'a wrong token gets the generic 404')

  const answer = (body) => { f.post = json(body) }
  answer({ group: G, diary: OTHER, seq: 2, texto: 'x', resposta: null })
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'recusado' }, 'another diary')
  answer({ group: OTHER, diary: D, seq: 2, texto: 'x', resposta: null })
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'recusado' }, 'another group')
  answer({ group: G, diary: D, seq: 1, texto: 'x', resposta: null })
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'recusado' }, 'another seq')
  answer({ group: G, diary: D, seq: 2, resposta: null })
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'recusado' }, 'no text')

  // A 404 (not held yet) is asked again, not cached.
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  f.post = (req, res) => res.writeHead(404).end()
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'nao-lida' })
  f.post = goodPost
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 2 })).ok, true, 'asked again')
})

test('group-check: an absence on an index still being built is recusado (asked again), never a cached ausente or nao-membro', async (t) => {
  const f = await fixture(t)
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  f.handler = json(groupBody({ kind: null, name: null, creator: null, indexing: true, complete: false }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' }, 'root not listed yet')
  f.handler = json(groupBody({ writers: [], complete: false }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' }, 'writer not listed yet')
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 1 })).ok, true, 'asked again once complete')
  t.is(f.requests.length, 3)
})

test('group-check: a writer row and its message confirm the diary without the root header, as root false', async (t) => {
  const f = await fixture(t)
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  // The root purged or withheld (or an older seeder not serving it): the
  // page has no kind but still lists the writer bound to D.
  f.handler = json(groupBody({ kind: null, visibility: null, join: null, name: null, creator: null, rootServed: false, writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: true, root: false, name: null, creator: null, texto: 'mensagem lida' })
  t.is(f.posts.length, 1, 'the message itself was read')
  // A writer listed with another diary is still nao-membro, and no writer
  // at all without a header is ausente.
  f.handler = json(groupBody({ kind: null, name: null, creator: null, writers: [{ key: W, diary: OTHER, length: 3, seq: 1, left: false }] }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'nao-membro' })
  f.handler = json(groupBody({ kind: null, name: null, creator: null, writers: [{ key: OTHER, diary: D, length: 3, seq: 1, left: false }] }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 3 }), { ok: false, code: 'ausente' })
  // The message must still be handed out.
  f.post = (req, res) => res.writeHead(404).end()
  f.handler = json(groupBody({ kind: null, name: null, creator: null, writers: [{ key: W, diary: D, length: 9, seq: 1, left: false }] }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 4 }), { ok: false, code: 'nao-lida' })
})

test('group-check: a verified header whose root is not served (rootServed false) is still a group root', async (t) => {
  const f = await fixture(t)
  f.handler = json(groupBody({ rootServed: false, creator: null, writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: true, root: true, name: 'Horta', creator: null, texto: 'mensagem lida' })
  // An older seeder sends no rootServed at all.
  const { rootServed, ...old } = groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] })
  f.handler = json(old)
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 }), { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' })
})

test('group-check: root false on an index still being built is not cached, so a header arriving later is seen', async (t) => {
  const f = await fixture(t)
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  const writers = [{ key: W, diary: D, length: 3, seq: 1, left: false }]
  f.handler = json(groupBody({ kind: null, name: null, creator: null, writers, indexing: true, complete: false }))
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 1 })).root, false)
  f.handler = json(groupBody({ writers }))
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 1 })).root, true, 'asked again')
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 1 })).root, true)
  t.is(f.requests.length, 2, 'the complete answer is cached')
})

test('group-check: a short length on a partial index is recusado (asked again); on a complete one sem-mensagem stays', async (t) => {
  const f = await fixture(t)
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 2, seq: 1, left: false }], indexing: true, complete: false }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'recusado' })
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 2 })).ok, true, 'asked again once the index caught up')
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 2, seq: 1, left: false }] }))
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 5 }), { ok: false, code: 'sem-mensagem' }, 'complete index: still definite')
})

test('group-check: below the signed length a hole in the downloaded prefix still reads the message; past it sem-mensagem stays', async (t) => {
  const f = await fixture(t)
  // The author withheld block 2: the seeder holds blocks 0 and 1 in a row
  // (length 2) and block 3 past the hole, of 5 signed.
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 2, signed: 5, seq: 1, left: false }] }))
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 3 }), { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' }, 'stored past the hole')
  t.alike(f.posts, ['/moderation-group-post/' + W + '/3'])
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 3 })).ok, true)
  t.is(f.requests.length, 1, 'the confirmation is cached')

  f.post = (req, res) => res.writeHead(404).end()
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'nao-lida' }, 'the withheld block is not handed out')
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 2 }), { ok: false, code: 'nao-lida' })
  t.is(f.requests.length, 3, 'not cached: asked again')
  f.post = goodPost
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 2 })).ok, true, 'seen once the block arrives')

  const posts = f.posts.length
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 5 }), { ok: false, code: 'sem-mensagem' }, 'past the signed length')
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 5 }), { ok: false, code: 'sem-mensagem' })
  t.is(f.posts.length, posts, 'no message read past the signed length')
  t.is(f.requests.length, 5, 'sem-mensagem cached')

  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 2, signed: 'x', seq: 1, left: false }] }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 3 }), { ok: false, code: 'recusado' }, 'a signed length that is not an integer')
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 2, signed: 5, seq: 1, left: false }], indexing: true, complete: false }))
  t.alike(await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 3 }), { ok: false, code: 'recusado' }, 'a partial index still answers recusado')
})

test('group-check: index reads carry the token when configured, and none without it', async (t) => {
  const auth = []
  const f = await fixture(t)
  f.handler = (req, res) => {
    auth.push(req.headers.authorization ?? null)
    if (req.url.startsWith('/index/groups/')) return json({ groups: [], indexing: false, complete: true })(req, res)
    json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))(req, res)
  }
  t.is((await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).check({ group: G, writer: W, diary: D, seq: 1 })).ok, true)
  t.is((await createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl }).checkDiary({ diary: D })).ok, true)
  t.alike(auth, ['Bearer ' + TOKEN, 'Bearer ' + TOKEN], '/index/group and /index/groups')
  auth.length = 0
  t.is((await createGroupCheck({ baseUrl: f.baseUrl }).checkDiary({ diary: D })).ok, true, 'still works without a token')
  t.alike(auth, [null])
})

test('group-check: checkDiary confirms a served diary through /index/groups; 404 is ausente and cached, a 503 is not', async (t) => {
  const f = await fixture(t)
  f.handler = (req, res) => res.writeHead(404).end()
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  t.alike(await check.checkDiary({ diary: G }), { ok: false, code: 'ausente' })
  t.alike(await check.checkDiary({ diary: G }), { ok: false, code: 'ausente' })
  t.alike(f.requests, ['/index/groups/' + G], 'the definite answer is cached')
  f.handler = (req, res) => res.writeHead(503).end()
  t.alike(await check.checkDiary({ diary: D }), { ok: false, code: 'recusado' })
  f.handler = json({ groups: [], indexing: false, complete: true })
  t.alike(await check.checkDiary({ diary: D }), { ok: true }, 'asked again after a transient failure')
  f.handler = json({ nope: true })
  t.alike(await check.checkDiary({ diary: W }), { ok: false, code: 'recusado' }, 'a malformed body')
  t.alike(await check.checkDiary({ diary: 'x' }), { ok: false, code: 'config' })
  t.alike(await createGroupCheck({ baseUrl: 'http://example.com:80' }).checkDiary({ diary: D }), { ok: false, code: 'config' })
})

test('group-check: concurrent checks of one triple share a single seeder read, then the answer is reused for a while', async (t) => {
  const f = await fixture(t)
  const listed = { writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }
  const held = []
  f.handler = (req, res) => held.push(() => json(groupBody(listed))(req, res))
  const c = { t: 0 }
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl, now: () => c.t })
  const all = Promise.all(Array.from({ length: 5 }, () => check.check({ group: G, writer: W, diary: D, seq: 1 })))
  while (held.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  held.shift()()
  for (const r of await all) t.alike(r, { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' })
  t.is(f.requests.length, 1, 'one fetch for five concurrent checks')
  f.handler = json(groupBody(listed))
  c.t += CACHE_MS - 1
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: true, root: true, name: 'Horta', creator: OTHER, texto: 'mensagem lida' })
  t.is(f.requests.length, 1, 'cached')
  c.t += 1
  await check.check({ group: G, writer: W, diary: D, seq: 1 })
  t.is(f.requests.length, 2, 'read again once the cache expired')
})

test('group-check: a refused read is not cached, and at most MAX_RUNNING reads run at once', async (t) => {
  const f = await fixture(t)
  f.handler = (req, res) => res.writeHead(500).end()
  const check = createGroupCheck({ token: TOKEN, baseUrl: f.baseUrl })
  t.alike(await check.check({ group: G, writer: W, diary: D, seq: 1 }), { ok: false, code: 'recusado' })
  f.handler = json(groupBody({ writers: [{ key: W, diary: D, length: 3, seq: 1, left: false }] }))
  t.is((await check.check({ group: G, writer: W, diary: D, seq: 1 })).ok, true, 'asked again')

  const held = []
  f.handler = (req, res) => held.push(() => json(groupBody())(req, res))
  const groups = ['01', '02', '03', '04', '05'].map((b) => b.repeat(32))
  const all = Promise.all(groups.map((group) => check.check({ group, writer: W, diary: D, seq: 1 })))
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(held.length, MAX_RUNNING, 'the others wait')
  let most = 0
  while (f.requests.length < 2 + groups.length || held.length > 0) {
    most = Math.max(most, held.length)
    if (held.length > 0) held.shift()()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.ok(most <= MAX_RUNNING, 'never more than MAX_RUNNING at once')
  for (const r of await all) t.alike(r, { ok: false, code: 'nao-membro' })
})
