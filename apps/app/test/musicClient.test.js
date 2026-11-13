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
const reads = (calls, path) => calls.filter((c) => c.url.endsWith(path))
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
  t.is(calls[2].init.method + ' ' + calls[2].url, 'POST ' + origin + '/account/audius/search', 'no query string')
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
  t.is(req.init.method + ' ' + req.url, 'POST ' + origin + '/account/audius/item')
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
  t.is(req.url, '/account/audius/resolve', 'the web keeps the page origin')
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
