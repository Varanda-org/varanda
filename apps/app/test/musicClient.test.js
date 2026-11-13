'use strict'

// The Audius client in src/account.js. ES module loaded through import();
// fetch is stubbed, nothing touches the network.
const test = require('brittle')

const load = () => import('../src/account.js')
const M = 'ab'.repeat(32)
const NONCE = 'n'.repeat(43)
const TOKEN = 't'.repeat(43)
const LATER = new Date(Date.now() + 12 * 3600 * 1000).toISOString()
const TICKET = 'A'.repeat(21) + '_-' + 'b'.repeat(20)
const PAGE = 'https://audius.co/artista/faixa-boa'
const track = { id: 'T1abc', title: 'Faixa Boa', artist: 'Artista', duration: 200, url: PAGE }
const playlist = { id: 'P9xyz', title: 'Lista Boa', artist: 'Artista', count: 3, url: 'https://audius.co/artista/playlist/lista-boa' }

const json = (status, obj, type = 'application/json') => ({
  ok: status < 400,
  status,
  headers: { get: (h) => (h === 'content-type' ? type : null) },
  text: async () => JSON.stringify(obj)
})

// A fetch that answers by path; `routes[path]` is a response or a function.
function stub (t, routes) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const r = routes[new URL(url, 'https://x.example').pathname]
    if (r === undefined) throw new Error('unexpected ' + url)
    return typeof r === 'function' ? r(init, calls) : r
  }
  t.teardown(() => { globalThis.fetch = real })
  return calls
}
const session = (extra) => ({
  '/account/audius/session/start': json(200, { nonce: NONCE }),
  '/account/audius/session/finish': json(200, { token: TOKEN, expiresAt: LATER }),
  ...extra
})
const signer = (calls) => async (method, args) => { calls.push({ method, args }); return { signature: 'ab'.repeat(64) } }
// By pathname, so a call that carries ?covers=1 still matches its route.
const reads = (calls, path) => calls.filter((c) => new URL(c.url, 'https://x.example').pathname.endsWith(path))
async function code (t, p) {
  try { await p } catch (e) { return e.code }
  t.fail('expected a refusal')
}

test('audiusPolicy: { enabled, moments }, strict, both false on any failure', async (t) => {
  const a = await load()
  const origin = 'https://mus-a.example.org'
  const calls = stub(t, { '/account/audius/policy': json(200, { enabled: true, moments: true }) })
  t.alike(await a.audiusPolicy({ origin }), { enabled: true, moments: true })
  t.alike(await a.audiusPolicy({ origin }), { enabled: true, moments: true })
  t.is(calls.length, 1, 'one probe')
  t.is(calls[0].init.method + ' ' + calls[0].url, 'GET ' + origin + '/account/audius/policy')
  t.ok(Object.isFrozen(await a.audiusPolicy({ origin })))
  const bodies = [
    { enabled: true }, { enabled: 'true', moments: false }, { enabled: true, moments: 1 }, { enabled: true, moments: false, x: 1 },
    {}, [], null
  ]
  for (const [i, body] of bodies.entries()) {
    stub(t, { '/account/audius/policy': json(200, body) })
    t.alike(await a.audiusPolicy({ origin: 'https://mus-b' + i + '.example.org' }), { enabled: false, moments: false }, JSON.stringify(body))
  }
  stub(t, { '/account/audius/policy': json(200, { enabled: false, moments: true }) })
  t.alike(await a.audiusPolicy({ origin: 'https://mus-c.example.org' }), { enabled: false, moments: false }, 'moments only while on')
  stub(t, { '/account/audius/policy': json(200, { enabled: true, moments: false }) })
  t.alike(await a.audiusPolicy({ origin: 'https://mus-d.example.org' }), { enabled: true, moments: false })
  stub(t, { '/account/audius/policy': json(404, { error: 'nao-encontrado' }) })
  t.alike(await a.audiusPolicy({ origin: 'https://mus-e.example.org' }), { enabled: false, moments: false }, 'an older service')
})

test('audiusPolicy: a failed probe is asked again after 30 s, a definite answer is kept', async (t) => {
  const a = await load()
  let clock = 1000000
  const now = () => clock
  const origin = 'https://mus-retry.example.org'
  let answer = () => { throw new Error('offline') }
  const calls = stub(t, { '/account/audius/policy': () => answer() })
  t.is((await a.audiusPolicy({ origin, now })).enabled, false)
  t.is((await a.audiusPolicy({ origin, now })).enabled, false)
  t.is(calls.length, 1, 'not asked again at once')
  clock += a.AUDIUS_POLICY_RETRY_MS - 1
  await a.audiusPolicy({ origin, now })
  t.is(calls.length, 1, 'not before 30 s')
  answer = () => json(200, { enabled: true, moments: false })
  clock += 1
  t.is((await a.audiusPolicy({ origin, now })).enabled, true, 'the policy came back')
  t.is(calls.length, 2)
  clock += 10 * a.AUDIUS_POLICY_RETRY_MS
  t.is((await a.audiusPolicy({ origin, now })).enabled, true)
  t.is(calls.length, 2, 'kept for the session')
})

test('audiusPolicy: its own cache, apart from the GIF policy', async (t) => {
  const a = await load()
  const origin = 'https://mus-own.example.org'
  const calls = stub(t, {
    '/account/gif/policy': json(200, { enabled: true }),
    '/account/audius/policy': json(200, { enabled: false, moments: false })
  })
  t.is(await a.gifPolicy({ origin }), true)
  t.alike(await a.audiusPolicy({ origin }), { enabled: false, moments: false })
  t.is(calls.length, 2)
})

test('audiusSearch: session, then the token in the header and the text in the body', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  a.forgetGifSession()
  const origin = 'https://mus-search.example.org'
  const signs = []
  const calls = stub(t, session({
    '/account/audius/search': (init) => (JSON.parse(init.body).kind === 'track' ? json(200, { items: [track], next: '12' }) : json(200, { items: [playlist], next: null }))
  }))
  const opts = { kind: 'track', origin, member: M, request: signer(signs) }
  t.alike(await a.audiusSearch(' samba ', opts), { items: [track], next: '12' })
  t.alike(signs, [{ method: 'invite.sign', args: { action: 'summary', nonce: NONCE } }])
  t.is(calls[0].init.method + ' ' + calls[0].url, 'POST ' + origin + '/account/audius/session/start')
  t.is(calls[0].init.body, JSON.stringify({ member: M }))
  t.is(calls[1].url, origin + '/account/audius/session/finish')
  t.is(calls[1].init.body, JSON.stringify({ member: M, nonce: NONCE, signature: 'ab'.repeat(64) }))
  t.is(calls[2].init.method + ' ' + calls[2].url, 'POST ' + origin + '/account/audius/search?covers=1', 'only the covers query')
  t.is(calls[2].init.body, JSON.stringify({ q: 'samba', kind: 'track' }))
  t.is(calls[2].init.headers.authorization, 'Bearer ' + TOKEN)
  for (const c of calls) t.absent(c.url.includes(TOKEN) || c.url.includes('samba'), 'nothing secret in a URL')
  t.alike(await a.audiusSearch('samba', { ...opts, kind: 'playlist', cursor: '12' }), { items: [playlist], next: null })
  t.is(calls.length, 4, 'the session is reused')
  t.is(calls[3].init.body, JSON.stringify({ q: 'samba', kind: 'playlist', cursor: '12' }))
  t.is(signs.length, 1)
})

test('audiusSearch: invalid input never fetches', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, session())
  const opts = { member: M, request: signer([]) }
  for (const [q, kind, cursor] of [['', 'track'], ['a', 'album'], ['a', 'track', '501'], ['a', 'track', '012'], ['a\nb', 'track']]) {
    t.is(await code(t, a.audiusSearch(q, { ...opts, kind, cursor })), 'pedido-invalido', JSON.stringify([q, kind, cursor]))
  }
  t.is(await code(t, a.audiusSearch('a', { kind: 'track', member: 'zz', request: signer([]) })), 'pedido-invalido')
  t.is(calls.length, 0)
})

test('audiusSearch: a page that is not the exact shape is unavailable', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const routes = session()
  stub(t, routes)
  const opts = { kind: 'track', member: M, request: signer([]) }
  for (const body of [
    { items: [{ ...track, stream: 'https://evil.example/a.mp3' }], next: null },
    { items: [{ ...track, url: 'https://evil.example/a/b' }], next: null },
    { items: [playlist], next: null },
    { items: [], next: '9999' },
    { items: [], next: null, x: 1 }
  ]) {
    routes['/account/audius/search'] = json(200, body)
    t.is(await code(t, a.audiusSearch('a', opts)), 'indisponivel', JSON.stringify(body))
  }
  routes['/account/audius/search'] = json(200, { items: [], next: null }, 'text/html')
  t.is(await code(t, a.audiusSearch('a', opts)), 'indisponivel', 'not JSON')
})

test('audiusSearch: one fresh session and one more try after a 401 only', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  let n = 0
  const calls = stub(t, session({ '/account/audius/search': () => (++n === 1 ? json(401, { error: 'nao-autorizado' }) : json(200, { items: [], next: null })) }))
  t.alike(await a.audiusSearch('a', { kind: 'track', member: M, request: signer([]) }), { items: [], next: null })
  t.is(reads(calls, '/session/start').length, 2, 'a second session')
  t.is(reads(calls, '/search').length, 2)
  a.forgetAudiusSession()
  const again = stub(t, session({ '/account/audius/search': json(401, { error: 'nao-autorizado' }) }))
  t.is(await code(t, a.audiusSearch('a', { kind: 'track', member: M, request: signer([]) })), 'nao-autorizado')
  t.is(reads(again, '/search').length, 2, 'only one renewal')
  t.is(reads(again, '/session/start').length, 2)
})

test('audiusSearch: a 500, a timeout or any other refusal is never fetched again', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const routes = session()
  const calls = stub(t, routes)
  const opts = { kind: 'track', member: M, request: signer([]) }
  const cases = [
    [json(500, { error: 'indisponivel' }), 'indisponivel', '500'],
    [json(503, { error: 'indisponivel' }), 'indisponivel', '503'],
    [json(502, '<html>', 'text/html'), 'indisponivel', 'a proxy page'],
    [() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }, 'indisponivel', 'a timeout'],
    [() => { throw new TypeError('network') }, 'indisponivel', 'a network error'],
    [json(429, { error: 'limite-musica' }), 'limite-musica', 'the daily limit'],
    [json(404, { error: 'feature-off' }), 'indisponivel', 'the feature off'],
    [json(404, { error: 'nao-encontrado' }), 'indisponivel', 'not found'],
    [json(400, { error: 'pedido-invalido' }), 'pedido-invalido', 'a bad request']
  ]
  routes['/account/audius/search'] = json(200, { items: [], next: null })
  await a.audiusSearch('a', opts)
  for (const [res, want, why] of cases) {
    routes['/account/audius/search'] = res
    const before = calls.length
    t.is(await code(t, a.audiusSearch('a', opts)), want, why)
    t.is(calls.length - before, 1, why + ': one fetch, no retry and no new session')
  }
  const { musicErrorText, MUSIC_LIMIT_TEXT, MUSIC_UNAVAILABLE_TEXT } = await import('../src/music.js')
  t.is(musicErrorText(a.toError('limite-musica')), MUSIC_LIMIT_TEXT)
  t.is(musicErrorText(a.toError('feature-off')), MUSIC_UNAVAILABLE_TEXT)
  t.is(a.toError('limite-musica').message, 'Limite de músicas por hoje.')
})

test('audiusSearch: a session refused with the daily limit says so', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, {
    '/account/audius/session/start': json(200, { nonce: NONCE }),
    '/account/audius/session/finish': json(429, { error: 'limite-musica' })
  })
  t.is(await code(t, a.audiusSearch('a', { kind: 'track', member: M, request: signer([]) })), 'limite-musica')
  t.is(calls.length, 2, 'no search, no retry')
})

test('audiusItem: { kind, id } in the body, strict answer', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const origin = 'https://mus-item.example.org'
  const full = { ...playlist, tracks: [track] }
  const routes = session({ '/account/audius/item': json(200, track) })
  const calls = stub(t, routes)
  const opts = { origin, member: M, request: signer([]) }
  t.alike(await a.audiusItem('track', 'T1abc', opts), track)
  const req = reads(calls, '/account/audius/item')[0]
  t.is(req.init.method + ' ' + req.url, 'POST ' + origin + '/account/audius/item?covers=1')
  t.is(req.init.body, JSON.stringify({ kind: 'track', id: 'T1abc' }))
  t.is(req.init.headers.authorization, 'Bearer ' + TOKEN)
  routes['/account/audius/item'] = json(200, full)
  t.alike(await a.audiusItem('playlist', 'P9xyz', opts), full)
  for (const [body, why] of [
    [{ ...track, id: 'Other1' }, 'another id'],
    [playlist, 'a playlist without tracks'],
    [{ ...full, tracks: Array.from({ length: 51 }, () => track) }, 'more than 50 tracks'],
    [{ ...track, x: 1 }, 'an extra key']
  ]) {
    routes['/account/audius/item'] = json(200, body)
    t.is(await code(t, a.audiusItem(body === playlist || body.tracks ? 'playlist' : 'track', body === playlist || body.tracks ? 'P9xyz' : 'T1abc', opts)), 'indisponivel', why)
  }
  const before = calls.length
  for (const [kind, id] of [['album', 'T1abc'], ['track', 'a/b'], ['track', ''], ['track', 'a'.repeat(33)], ['track', 5]]) {
    t.is(await code(t, a.audiusItem(kind, id, opts)), 'pedido-invalido', String(kind) + ' ' + String(id))
  }
  t.is(calls.length, before, 'nothing fetched for a bad request')
})

test('audiusResolve: only an audius.co page leaves the device, to the account origin', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const routes = session({ '/account/audius/resolve': json(200, { kind: 'track', item: track }) })
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]) }
  t.alike(await a.audiusResolve(PAGE, opts), { kind: 'track', item: track })
  const req = reads(calls, '/account/audius/resolve')[0]
  t.is(req.url, '/account/audius/resolve?covers=1', 'the web keeps the page origin')
  t.is(req.init.body, JSON.stringify({ url: PAGE }))
  routes['/account/audius/resolve'] = json(200, { kind: 'playlist', item: playlist })
  t.alike(await a.audiusResolve(PAGE, opts), { kind: 'playlist', item: playlist })
  routes['/account/audius/resolve'] = json(200, { kind: 'playlist', item: { ...playlist, tracks: [] } })
  t.is(await code(t, a.audiusResolve(PAGE, opts)), 'indisponivel')
  const before = calls.length
  for (const url of ['https://evil.example/a/b', PAGE + '?x=1', PAGE + '#x', 'http://audius.co/a/b', 'https://audius.co/a', null]) {
    t.is(await code(t, a.audiusResolve(url, opts)), 'pedido-invalido', String(url))
  }
  t.is(calls.length, before)
})

test('audiusPlay: a ticket becomes an audio URL on the origin the request went to', async (t) => {
  const a = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  a.forgetAudiusSession()
  const at = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const routes = session({ '/account/audius/play': json(200, { ticket: TICKET, expiresAt: at }) })
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]) }
  t.alike(await a.audiusPlay('T1abc', opts), { url: '/account/audius/audio/' + TICKET, base: null, expiresAt: at }, 'the web: relative')
  const req = reads(calls, '/account/audius/play')[0]
  t.is(req.init.method + ' ' + req.url, 'POST /account/audius/play')
  t.is(req.init.body, JSON.stringify({ id: 'T1abc' }), 'no track in the URL')
  t.is(req.init.headers.authorization, 'Bearer ' + TOKEN)
  const origin = 'https://conta.example.org'
  t.alike(await a.audiusPlay('T1abc', { ...opts, origin }), { url: origin + '/account/audius/audio/' + TICKET, base: origin, expiresAt: at })
  t.is(reads(calls, '/account/audius/play')[1].url, origin + '/account/audius/play')
  for (const body of [{ ticket: 'x', expiresAt: at }, { ticket: TICKET, expiresAt: 'logo' }, { ticket: TICKET, expiresAt: at, url: 'https://evil.example/a.mp3' }]) {
    routes['/account/audius/play'] = json(200, body)
    t.is(await code(t, a.audiusPlay('T1abc', opts)), 'indisponivel', JSON.stringify(body))
  }
  routes['/account/audius/play'] = json(404, { error: 'nao-encontrado' })
  t.is(await code(t, a.audiusPlay('T1abc', opts)), 'indisponivel', 'a member who lost standing')
  const before = calls.length
  t.is(await code(t, a.audiusPlay('../x', opts)), 'pedido-invalido')
  t.is(calls.length, before)
})

test('audiusPlay: a hosted node on the installed app gets the installation origin', async (t) => {
  const a = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  t.ok(setInstallation('https://bora.example.org'))
  a.forgetAudiusSession()
  const at = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const calls = stub(t, session({ '/account/audius/play': json(200, { ticket: TICKET, expiresAt: at }) }))
  // musicOriginOf answers undefined for a hosted node.
  const got = await a.audiusPlay('T1abc', { origin: undefined, member: M, request: signer([]) })
  t.is(got.base, 'https://bora.example.org')
  t.is(got.url, 'https://bora.example.org/account/audius/audio/' + TICKET, 'absolute')
  for (const c of calls) t.ok(c.url.startsWith('https://bora.example.org/account/audius/'), 'only the account origin: ' + c.url)
})

test('audiusPlay: the audio URL stays on the installation the ticket came from', async (t) => {
  const a = await load()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => setInstallation(null))
  t.ok(setInstallation('https://bora.example.org'))
  a.forgetAudiusSession()
  const at = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  stub(t, session({
    '/account/audius/play': () => {
      setInstallation('https://outra.example.org')
      return json(200, { ticket: TICKET, expiresAt: at })
    }
  }))
  const got = await a.audiusPlay('T1abc', { origin: undefined, member: M, request: signer([]) })
  t.is(got.base, 'https://bora.example.org', 'a switch during the request does not move the ticket')
  t.is(got.url, 'https://bora.example.org/account/audius/audio/' + TICKET)
})

test('audiusPlay: a 401 renews the session once', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const at = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  let n = 0
  const calls = stub(t, session({ '/account/audius/play': () => (++n === 1 ? json(401, { error: 'nao-autorizado' }) : json(200, { ticket: TICKET, expiresAt: at })) }))
  t.is((await a.audiusPlay('T1abc', { member: M, request: signer([]) })).expiresAt, at)
  t.is(reads(calls, '/account/audius/play').length, 2)
  t.is(reads(calls, '/session/start').length, 2)
})

test('audius sessions are their own: a GIF token never rides an Audius read', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  a.forgetGifSession()
  const GIF = 'g'.repeat(43)
  const calls = stub(t, {
    '/account/gif/session/start': json(200, { nonce: NONCE }),
    '/account/gif/session/finish': json(200, { token: GIF, expiresAt: LATER }),
    '/account/gif/search': json(200, { items: [], next: null }),
    ...session({ '/account/audius/search': json(200, { items: [], next: null }) })
  })
  const opts = { member: M, request: signer([]) }
  await a.gifSearch('a', opts)
  await a.audiusSearch('a', { ...opts, kind: 'track' })
  t.is(reads(calls, '/account/audius/search')[0].init.headers.authorization, 'Bearer ' + TOKEN)
  t.is(reads(calls, '/account/audius/session/start').length, 1, 'an own session')
})

test('audiusReady: policy on and the member linked, kept 5 minutes', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  let clock = 9000000
  const now = () => clock
  const origin = 'https://mus-ready.example.org'
  const routes = { '/account/audius/policy': json(200, { enabled: true, moments: false }), '/account/status': json(200, { linked: true }) }
  const calls = stub(t, routes)
  const statuses = () => reads(calls, '').filter((c) => c.url.includes('/account/status')).length
  t.is(await a.audiusReady({ member: M, origin, now }), true)
  t.is(await a.audiusReady({ member: M, origin, now }), true)
  t.is(statuses(), 1)
  clock += 5 * 60 * 1000
  routes['/account/status'] = json(200, { linked: false })
  t.is(await a.audiusReady({ member: M, origin, now }), false)
  routes['/account/status'] = json(503, { error: 'indisponivel' })
  t.is(await a.audiusReady({ member: M, origin, now }), false)
  t.is(await a.audiusReady({ member: 'zz', origin, now }), false)
  stub(t, { '/account/audius/policy': json(200, { enabled: false, moments: false }) })
  t.is(await a.audiusReady({ member: M, origin: 'https://mus-ready-off.example.org', now }), false)
})

test('search, item and resolve ask covers by query with unchanged bodies', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const origin = 'https://mus-covers.example.org'
  const lit = { ...track, cover: true }
  const dark = { ...playlist, cover: false }
  const calls = stub(t, session({
    '/account/audius/search': json(200, { items: [lit], next: null }),
    '/account/audius/item': json(200, { ...dark, tracks: [lit, { ...track, id: 'T2abc', cover: false }] }),
    '/account/audius/resolve': json(200, { kind: 'track', item: lit })
  }))
  const opts = { origin, member: M, request: signer([]) }
  t.alike(await a.audiusSearch('samba', { ...opts, kind: 'track' }), { items: [lit], next: null })
  t.alike(await a.audiusItem('playlist', 'P9xyz', opts), { ...dark, tracks: [lit, { ...track, id: 'T2abc', cover: false }] })
  t.alike(await a.audiusResolve(PAGE, opts), { kind: 'track', item: lit })
  const [search] = reads(calls, '/account/audius/search')
  const [item] = reads(calls, '/account/audius/item')
  const [resolve] = reads(calls, '/account/audius/resolve')
  for (const [req, route, body] of [
    [search, 'search', { q: 'samba', kind: 'track' }],
    [item, 'item', { kind: 'playlist', id: 'P9xyz' }],
    [resolve, 'resolve', { url: PAGE }]
  ]) {
    const url = new URL(req.url)
    t.is(url.origin + url.pathname, origin + '/account/audius/' + route)
    t.is(url.search, '?covers=1', route + ': the covers query and nothing else')
    t.is(req.init.body, JSON.stringify(body), route + ': the body is unchanged')
  }
  t.is(calls.length, 5, 'one request each after the session, no fallback')
})

test('an older service\'s answer parses without a cover field', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, session({
    '/account/audius/search': json(200, { items: [track], next: null }),
    '/account/audius/item': json(200, { ...playlist, tracks: [track] }),
    '/account/audius/resolve': json(200, { kind: 'playlist', item: playlist })
  }))
  const opts = { member: M, request: signer([]) }
  const page = await a.audiusSearch('a', { ...opts, kind: 'track' })
  const full = await a.audiusItem('playlist', 'P9xyz', opts)
  const resolved = await a.audiusResolve(PAGE, opts)
  t.alike(page, { items: [track], next: null })
  t.alike(full, { ...playlist, tracks: [track] })
  t.alike(resolved, { kind: 'playlist', item: playlist })
  for (const it of [page.items[0], full, full.tracks[0], resolved.item]) t.absent(Object.hasOwn(it, 'cover'), 'no cover field')
  t.is(reads(calls, '/account/audius/search').length + reads(calls, '/account/audius/item').length + reads(calls, '/account/audius/resolve').length, 3, 'never asked again without the query')
})

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 9, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56])
const b64 = (bytes) => Buffer.from(bytes).toString('base64')

test('audiusArt refuses a mime that does not match the bytes, an oversize body and extra keys', async (t) => {
  const a = await load()
  const { MUSIC_ART_MAX_BYTES } = await import('../src/music.js')
  a.forgetAudiusSession()
  const routes = session()
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]) }
  for (const [mime, bytes] of [['image/jpeg', JPEG], ['image/png', PNG], ['image/webp', WEBP]]) {
    routes['/account/audius/art'] = json(200, { mime, bytes: b64(bytes) })
    t.alike(await a.audiusArt('track', 'T1abc', opts), { mime, base64: b64(bytes) }, mime)
  }
  const big = Buffer.alloc(MUSIC_ART_MAX_BYTES + 1)
  JPEG.copy(big)
  const atCap = Buffer.alloc(MUSIC_ART_MAX_BYTES)
  JPEG.copy(atCap)
  routes['/account/audius/art'] = json(200, { mime: 'image/jpeg', bytes: b64(atCap) })
  t.is((await a.audiusArt('track', 'T1abc', opts)).base64.length, b64(atCap).length, 'exactly the cap is a cover')
  const GIF = Buffer.from('GIF89a' + 'x'.repeat(10))
  for (const [body, why] of [
    [{ mime: 'image/png', bytes: b64(JPEG) }, 'a JPEG called PNG'],
    [{ mime: 'image/jpeg', bytes: b64(PNG) }, 'a PNG called JPEG'],
    [{ mime: 'image/webp', bytes: b64(Buffer.from('RIFF0000WAVE')) }, 'a RIFF that is not WebP'],
    [{ mime: 'image/gif', bytes: b64(GIF) }, 'a GIF'],
    [{ mime: 'image/svg+xml', bytes: b64(Buffer.from('<svg/>')) }, 'an SVG'],
    [{ mime: 'image/jpeg', bytes: b64(big) }, 'one byte past the cap'],
    [{ mime: 'image/jpeg', bytes: b64(Buffer.alloc(MUSIC_ART_MAX_BYTES * 2)) }, 'a body past maxBody'],
    [{ mime: 'image/jpeg', bytes: '' }, 'no bytes'],
    [{ mime: 'image/jpeg', bytes: b64(JPEG).replace(/=+$/, '') + '\n' }, 'not canonical base64'],
    [{ mime: 'image/jpeg', bytes: b64(JPEG), url: 'https://evil.example/a.jpg' }, 'an extra key'],
    [{ mime: 'image/jpeg' }, 'a missing key'],
    [{ bytes: b64(JPEG) }, 'no mime'],
    [{ mime: ['image/jpeg'], bytes: b64(JPEG) }, 'a mime that is not a string'],
    [[], 'an array']
  ]) {
    routes['/account/audius/art'] = json(200, body)
    const before = calls.length
    t.is(await code(t, a.audiusArt('track', 'T1abc', opts)), 'indisponivel', why)
    t.is(calls.length - before, 1, why + ': no retry')
  }
  for (const [res, want] of [
    [json(404, { error: 'feature-off' }), 'indisponivel'],
    [json(404, { error: 'nao-encontrado' }), 'indisponivel'],
    [json(429, { error: 'limite-musica' }), 'limite-musica'],
    [json(503, { error: 'indisponivel' }), 'indisponivel']
  ]) {
    routes['/account/audius/art'] = res
    const before = calls.length
    t.is(await code(t, a.audiusArt('track', 'T1abc', opts)), want, String(res.status))
    t.is(calls.length - before, 1, res.status + ': one fetch')
  }
  const before = calls.length
  for (const [kind, id] of [['album', 'T1abc'], ['snippet', 'T1abc'], ['track', 'a/b'], ['track', ''], ['track', 'a'.repeat(33)], ['track', 5]]) {
    t.is(await code(t, a.audiusArt(kind, id, opts)), 'pedido-invalido', String(kind) + ' ' + String(id))
  }
  t.is(calls.length, before, 'nothing fetched for a bad request')
})

test('audiusArt uses only the account session and origin', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  a.forgetGifSession()
  const origin = 'https://mus-art.example.org'
  let n = 0
  const calls = stub(t, session({
    '/account/audius/art': () => (++n === 1 ? json(401, { error: 'nao-autorizado' }) : json(200, { mime: 'image/png', bytes: b64(PNG) }))
  }))
  t.alike(await a.audiusArt('playlist', 'P9xyz', { origin, member: M, request: signer([]) }), { mime: 'image/png', base64: b64(PNG) })
  const arts = reads(calls, '/account/audius/art')
  t.is(arts.length, 2, 'a 401 renews the session once')
  t.is(reads(calls, '/account/audius/session/start').length, 2)
  for (const req of arts) {
    t.is(req.init.method + ' ' + req.url, 'POST ' + origin + '/account/audius/art', 'no query, nothing in the URL')
    t.is(req.init.body, JSON.stringify({ kind: 'playlist', id: 'P9xyz' }))
    t.ok(/^Bearer t{43}$/.test(req.init.headers.authorization))
  }
  for (const c of calls) t.ok(c.url.startsWith(origin + '/account/audius/'), 'only the account origin: ' + c.url)
  const web = stub(t, session({ '/account/audius/art': json(200, { mime: 'image/png', bytes: b64(PNG) }) }))
  a.forgetAudiusSession()
  await a.audiusArt('track', 'T1abc', { member: M, request: signer([]) })
  for (const c of web) t.ok(c.url.startsWith('/account/audius/'), 'the web keeps the page origin: ' + c.url)
})

test('the cover cache loads once per key, bounds parallel loads, keeps failures, evicts past max and clears', async (t) => {
  const { coverKey, coverUri, createCoverCache } = await import('../src/musicCover.js')
  const s1 = { member: M, origin: 'https://a.example.org', request: () => {} }
  const s2 = { member: 'cd'.repeat(32), origin: 'https://a.example.org', request: () => {} }
  t.is(coverKey('track', 'T1', s1), 'https://a.example.org|' + M + '|track|T1')
  t.is(coverKey('track', 'T1', { member: M }), '|' + M + '|track|T1')
  t.not(coverKey('track', 'T1', s1), coverKey('track', 'T1', s2), 'another member, another key')
  t.not(coverKey('track', 'T1', s1), coverKey('playlist', 'T1', s1))
  t.is(coverUri('image/png', 'AAAA'), 'data:image/png;base64,AAAA')
  t.is(coverUri('image/jpeg', 'AAAA'), 'data:image/jpeg;base64,AAAA')
  t.is(coverUri('image/webp', 'AAAA'), 'data:image/webp;base64,AAAA')
  for (const [mime, base64] of [['image/gif', 'AAAA'], ['image/svg+xml', 'AAAA'], ['text/html', 'AAAA'], ['image/png', ''], ['image/png', 'AA"A'], ['image/png', 5], [null, 'AAAA']]) {
    t.is(coverUri(mime, base64), null, String(mime) + ' ' + String(base64))
  }

  const pending = []
  const load = (kind, id, session) => new Promise((resolve, reject) => { pending.push({ kind, id, session, resolve, reject }) })
  const flushAll = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
  const cache = createCoverCache({ load, max: 4, parallel: 2 })
  const a1 = cache.get('track', 'A', s1)
  const a2 = cache.get('track', 'A', s1)
  t.is(a1, a2, 'in-flight loads are shared')
  const b = cache.get('track', 'B', s1)
  const c = cache.get('track', 'C', s1)
  await flushAll()
  t.is(pending.length, 2, 'at most two at once')
  t.alike(pending.map((p) => p.id), ['A', 'B'])
  t.is(pending[0].session, s1, 'the load gets the session')
  pending[0].resolve('data:image/png;base64,AAAA')
  await flushAll()
  t.is(await a1, 'data:image/png;base64,AAAA')
  t.is(pending.length, 3, 'the queued load starts when a slot frees')
  pending[1].resolve(null)
  pending[2].resolve('https://evil.example/c.jpg')
  t.is(await b, null, 'a definite no cover is null')
  t.is(await c, null, 'anything but a data:image/ URI is null')
  t.is(await cache.get('track', 'A', s1), 'data:image/png;base64,AAAA', 'a hit')
  t.is(await cache.get('track', 'B', s1), null, 'a definite no cover is kept')
  t.is(pending.length, 3, 'nothing loaded again')
  const other = cache.get('track', 'A', s2)
  await flushAll()
  t.is(pending.length, 4, 'another member loads its own')
  pending[3].resolve('data:image/jpeg;base64,BBBB')
  t.is(await other, 'data:image/jpeg;base64,BBBB')
  // Entries now, least recently used first: C, A, B, A(s2). A fifth evicts C.
  const d = cache.get('track', 'D', s1)
  await flushAll()
  pending[4].resolve('data:image/png;base64,DDDD')
  t.is(await d, 'data:image/png;base64,DDDD')
  const cAgain = cache.get('track', 'C', s1)
  await flushAll()
  t.is(pending.length, 6, 'the oldest was evicted and loads again')
  t.is(pending[5].id, 'C')
  pending[5].resolve(null)
  t.is(await cAgain, null)
  // C pushed out A(s1), the least recently used of A, B, A(s2), D.
  cache.get('track', 'A', s1)
  await flushAll()
  t.is(pending.length, 7, 'the least recently used went next')
  pending[6].resolve('data:image/png;base64,AAAA')
  await flushAll()

  const e = cache.get('track', 'E', s1)
  const f = cache.get('track', 'F', s1)
  const g = cache.get('track', 'G', s1)
  await flushAll()
  t.is(pending.length, 9, 'two running, one queued')
  cache.clear()
  pending[7].resolve('data:image/png;base64,EEEE')
  pending[8].resolve('data:image/png;base64,FFFF')
  t.is(await e, null, 'a late load resolves null after clear')
  t.is(await f, null)
  t.is(await g, null, 'a queued load never runs')
  await flushAll()
  t.is(pending.length, 9)
  const again = cache.get('track', 'A', s1)
  await flushAll()
  t.is(pending.length, 10, 'clear empties every entry')
  pending[9].resolve('data:image/png;base64,AAAA')
  t.is(await again, 'data:image/png;base64,AAAA')
  t.is(await cache.get('track', 'A', null), null, 'no session, no load')
  t.is(pending.length, 10)
})

const flushAll = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }

test('a pending cover is never loaded twice', async (t) => {
  const { createCoverCache } = await import('../src/musicCover.js')
  const s1 = { member: M, origin: 'https://a.example.org', request: () => {} }
  const pending = []
  const load = (kind, id) => new Promise((resolve) => { pending.push({ id, resolve }) })
  const cache = createCoverCache({ load, max: 2, parallel: 1 })
  const first = cache.get('track', 'A', s1)
  const rest = ['B', 'C', 'D'].map((id) => cache.get('track', id, s1))
  t.is(cache.get('track', 'A', s1), first, 'more pending loads than max: the first is still shared')
  t.is(cache.get('track', 'D', s1), rest[2], 'a queued one too')
  for (let i = 0; i < 4; i++) {
    await flushAll()
    pending[i].resolve('data:image/png;base64,' + pending[i].id + 'AAA')
  }
  t.is(await first, 'data:image/png;base64,AAAA')
  t.is(await rest[2], 'data:image/png;base64,DAAA')
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A', 'B', 'C', 'D'], 'one load per key')
})

test('a cover loading through a wipe is not loaded twice', async (t) => {
  const { createCoverCache } = await import('../src/musicCover.js')
  const s1 = { member: M, origin: 'https://a.example.org', request: () => {} }
  const s2 = { member: 'cd'.repeat(32), origin: 'https://a.example.org', request: () => {} }
  const pending = []
  const load = (kind, id, session) => new Promise((resolve) => { pending.push({ id, session, resolve }) })
  const cache = createCoverCache({ load, parallel: 2 })
  const before = cache.get('track', 'A', s1)
  const lone = cache.get('track', 'B', s1)
  const queued = cache.get('track', 'C', s1)
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A', 'B'])
  cache.clear()
  t.is(await queued, null, 'a queued load is dropped')
  const after = cache.get('track', 'A', s1)
  const other = cache.get('track', 'A', s2)
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A', 'B'], 'A joins the running load; the slots are still taken')
  pending[0].resolve('data:image/png;base64,AAAA')
  t.is(await Promise.race([after, flushAll().then(() => 'still waiting')]), 'data:image/png;base64,AAAA', 'the caller after the wipe gets the cover')
  t.is(await before, null, 'the caller from before the wipe does not')
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A', 'B', 'A'], 'another member loads its own')
  t.is(pending[2].session, s2)
  pending[2].resolve('data:image/png;base64,ZZZZ')
  t.is(await other, 'data:image/png;base64,ZZZZ')
  t.is(await cache.get('track', 'A', s1), 'data:image/png;base64,AAAA', 'the adopted load is kept')
  pending[1].resolve('data:image/png;base64,BBBB')
  t.is(await lone, null, 'a running load nobody joined is dropped')
  await flushAll()
  const bAgain = cache.get('track', 'B', s1)
  await flushAll()
  t.is(pending.length, 4, 'and nothing was stored: B loads again')
  t.is(pending[3].id, 'B')
  pending[3].resolve(null)
  t.is(await bAgain, null)
  t.is(pending.filter((p) => p.id === 'A' && p.session === s1).length, 1, 'A for this member loaded once')
})

// What src/ui/useMusicCover.js gives the cache: a refusal marked noCover is
// a definite "no cover", anything else rejects.
const artLoad = (a, coverUri) => async (kind, id, session) => {
  try {
    const { mime, base64 } = await a.audiusArt(kind, id, session)
    return coverUri(mime, base64)
  } catch (err) {
    if (err && err.noCover === true) return null
    throw err
  }
}

test('a transient cover failure is not remembered', async (t) => {
  const a = await load()
  const { coverUri, createCoverCache } = await import('../src/musicCover.js')
  a.forgetAudiusSession()
  const routes = session()
  const calls = stub(t, routes)
  const s = { member: M, request: signer([]) }
  const cache = createCoverCache({ load: artLoad(a, coverUri) })
  const arts = () => reads(calls, '/account/audius/art').length
  for (const [res, why] of [
    [json(503, { error: 'indisponivel' }), 'a 503'],
    [json(503, { error: 'lotado' }), 'a 503 with the service full'],
    [() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }, 'a timeout'],
    [() => { throw new TypeError('network') }, 'a network error'],
    [json(404, { error: 'feature-off' }), 'the feature off']
  ]) {
    routes['/account/audius/art'] = res
    const before = arts()
    t.is(await cache.get('track', 'T1abc', s), null, why + ' is no cover now')
    t.is(arts() - before, 1, why + ': one request, no retry')
    try {
      await a.audiusArt('track', 'T1abc', s)
      t.fail(why + ': expected a refusal')
    } catch (err) {
      t.absent(err.noCover, why + ' is not marked')
    }
  }
  routes['/account/audius/art'] = json(200, { mime: 'image/png', bytes: b64(PNG) })
  const before = arts()
  t.is(await cache.get('track', 'T1abc', s), 'data:image/png;base64,' + b64(PNG), 'the next get asks again')
  t.is(arts() - before, 1)
  t.is(await cache.get('track', 'T1abc', s), 'data:image/png;base64,' + b64(PNG))
  t.is(arts() - before, 1, 'a cover is kept')
})

test('a missing cover is remembered', async (t) => {
  const a = await load()
  const { coverUri, createCoverCache } = await import('../src/musicCover.js')
  a.forgetAudiusSession()
  const routes = session()
  const calls = stub(t, routes)
  const s = { member: M, request: signer([]) }
  const cache = createCoverCache({ load: artLoad(a, coverUri) })
  const arts = () => reads(calls, '/account/audius/art').length
  for (const [id, res, want, why] of [
    ['N404', json(404, { error: 'nao-encontrado' }), 'indisponivel', 'a 404'],
    ['L429', json(429, { error: 'limite-musica' }), 'limite-musica', 'the day used up'],
    ['Mbad', json(200, { mime: 'image/png', bytes: b64(JPEG) }), 'indisponivel', 'bytes the client refuses'],
    ['Kbad', json(200, { mime: 'image/png', bytes: b64(PNG), url: 'https://evil.example/a.png' }), 'indisponivel', 'an extra key']
  ]) {
    routes['/account/audius/art'] = res
    try {
      await a.audiusArt('track', id, s)
      t.fail(why + ': expected a refusal')
    } catch (err) {
      t.is(err.code, want, why)
      t.is(err.noCover, true, why + ' is marked')
    }
    const before = arts()
    t.is(await cache.get('track', id, s), null, why + ' is no cover')
    t.is(arts() - before, 1)
    routes['/account/audius/art'] = json(200, { mime: 'image/png', bytes: b64(PNG) })
    t.is(await cache.get('track', id, s), null, why + ' is kept')
    t.is(arts() - before, 1, why + ': the next get does not load')
  }
  // A session refused with the limit is its finish throttle, not the day used
  // up: the next get starts a session again.
  a.forgetAudiusSession()
  routes['/account/audius/session/start'] = json(429, { error: 'limite-musica' })
  const before = calls.length
  t.is(await cache.get('track', 'S429', s), null)
  t.is(await cache.get('track', 'S429', s), null)
  t.is(calls.length - before, 2, 'not kept: one session start per get')
})

test('a session throttle does not hide a cover for the session', async (t) => {
  const a = await load()
  const { coverUri, createCoverCache } = await import('../src/musicCover.js')
  a.forgetAudiusSession()
  const routes = session({ '/account/audius/art': json(200, { mime: 'image/png', bytes: b64(PNG) }) })
  const calls = stub(t, routes)
  const s = { member: M, request: signer([]) }
  const cache = createCoverCache({ load: artLoad(a, coverUri) })
  const starts = () => reads(calls, '/account/audius/session/start').length
  routes['/account/audius/session/start'] = json(429, { error: 'limite-musica' })
  try {
    await a.audiusArt('track', 'T1abc', s)
    t.fail('expected a refusal')
  } catch (err) {
    t.is(err.code, 'limite-musica')
    t.absent(err.noCover, 'a session start refusal is not marked')
  }
  const before = starts()
  t.is(await cache.get('track', 'T1abc', s), null, 'no cover now')
  t.is(starts() - before, 1)
  t.is(reads(calls, '/account/audius/art').length, 0, 'the art route was never asked')
  routes['/account/audius/session/start'] = json(200, { nonce: NONCE })
  t.is(await cache.get('track', 'T1abc', s), 'data:image/png;base64,' + b64(PNG), 'the next get loads again')
  t.is(starts() - before, 2)
  t.is(reads(calls, '/account/audius/art').length, 1)

  routes['/account/audius/art'] = json(429, { error: 'limite-musica' })
  try {
    await a.audiusArt('track', 'L429', s)
    t.fail('expected a refusal')
  } catch (err) {
    t.is(err.code, 'limite-musica')
    t.is(err.noCover, true, 'the art route\'s own limit is marked')
  }
  t.is(await cache.get('track', 'L429', s), null)
  routes['/account/audius/art'] = json(200, { mime: 'image/png', bytes: b64(PNG) })
  const arts = reads(calls, '/account/audius/art').length
  t.is(await cache.get('track', 'L429', s), null, 'the day used up is kept')
  t.is(reads(calls, '/account/audius/art').length, arts, 'not asked again')
})

test('audiusArt waits 25 s', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const timers = []
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (!(ms >= 1000)) return realSet(fn, ms, ...args)
    const timer = { fn, ms, cleared: false, fake: true }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (id) => { if (id && id.fake === true) id.cleared = true; else realClear(id) }
  t.teardown(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear })
  let aborted = false
  const calls = stub(t, session({
    '/account/audius/art': (init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
  }))
  const caught = a.audiusArt('track', 'T1abc', { member: M, request: signer([]) }).catch((err) => err)
  for (let i = 0; i < 50 && reads(calls, '/account/audius/art').length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
  t.is(reads(calls, '/account/audius/art').length, 1)
  const live = timers.filter((x) => !x.cleared)
  t.is(live.length, 1, 'only the art request is waiting')
  t.is(live[0].ms, 25000, 'its own deadline')
  for (const x of live) if (x.ms <= 15000) x.fn()
  await flushAll()
  t.absent(aborted, 'still waiting at 15 s')
  for (const x of live) if (x.ms <= 25000) x.fn()
  const err = await caught
  t.ok(aborted, 'aborted at 25 s')
  t.is(err.code, 'indisponivel')
  t.absent(err.noCover, 'a timeout is not kept')
})

test('a queued cover nobody waits for is never loaded', async (t) => {
  const { createCoverCache } = await import('../src/musicCover.js')
  const s1 = { member: M, origin: 'https://a.example.org', request: () => {} }
  const pending = []
  const load = (kind, id) => new Promise((resolve) => { pending.push({ id, resolve }) })
  const cache = createCoverCache({ load, parallel: 1 })
  const a = cache.get('track', 'A', s1)
  const leaveB = new AbortController()
  const b = cache.get('track', 'B', s1, { signal: leaveB.signal })
  const leaveC1 = new AbortController()
  const leaveC2 = new AbortController()
  cache.get('track', 'C', s1, { signal: leaveC1.signal })
  const c2 = cache.get('track', 'C', s1, { signal: leaveC2.signal })
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A'], 'one at a time')
  leaveB.abort()
  leaveC1.abort()
  t.is(await Promise.race([b, flushAll().then(() => 'still waiting')]), null, 'a load left before it started is null')
  pending[0].resolve('data:image/png;base64,AAAA')
  t.is(await a, 'data:image/png;base64,AAAA')
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A', 'C'], 'B is never sent; C still has a waiter')
  pending[1].resolve('data:image/png;base64,CCCC')
  t.is(await c2, 'data:image/png;base64,CCCC', 'the waiter left alone gets its cover')

  const leaveD = new AbortController()
  const d = cache.get('track', 'D', s1, { signal: leaveD.signal })
  await flushAll()
  t.is(pending.at(-1).id, 'D')
  leaveD.abort()
  pending.at(-1).resolve('data:image/png;base64,DDDD')
  t.is(await d, 'data:image/png;base64,DDDD', 'a load already started runs to the end')
  t.is(await cache.get('track', 'D', s1), 'data:image/png;base64,DDDD', 'and is kept')
  const gone = new AbortController()
  gone.abort()
  t.is(await cache.get('track', 'E', s1, { signal: gone.signal }), null, 'a caller already gone loads nothing')
  const bAgain = cache.get('track', 'B', s1)
  await flushAll()
  t.alike(pending.map((p) => p.id), ['A', 'C', 'D', 'B'], 'B was not remembered: a later get loads it')
  pending.at(-1).resolve(null)
  t.is(await bAgain, null)
})

test('cover files keep covers in memory only', (t) => {
  const fs = require('fs')
  const path = require('path')
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')
  const pure = strip(fs.readFileSync(path.join(__dirname, '../src/musicCover.js'), 'utf8'))
  const hook = strip(fs.readFileSync(path.join(__dirname, '../src/ui/useMusicCover.js'), 'utf8'))
  t.absent(/\bimport\b|\brequire\s*\(/.test(pure), 'musicCover.js imports nothing')
  for (const src of [pure, hook]) {
    t.absent(/urlFromBytes|AsyncStorage|indexedDB|expo-file-system|localStorage|\bfetch\s*\(|https?:\/\//.test(src))
    t.absent(/\u2014/.test(src))
  }
  t.ok(hook.includes("from '../localCaches'"))
  t.ok(/registerLocalCache\(\{ wipe: \(\) => cache\.clear\(\) \}\)/.test(hook))
  t.ok(hook.includes("from '../account'") && hook.includes('audiusArt('))
  t.ok(hook.includes('[kind, id, cover, member, origin, enabled]'), 'the effect keys on primitives only')
  t.ok(hook.includes('{ signal: ctl.signal }') && hook.includes('ctl.abort()'), 'an unmounted row leaves its queued load')
  t.ok(hook.includes('if (err && err.noCover === true) return null'), 'only a definite refusal is kept')
})
