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
// By pathname, so a call that carries ?covers=1&info=1 still matches its route.
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
  t.is(calls[2].init.method + ' ' + calls[2].url, 'POST ' + origin + '/account/audius/search?covers=1&info=1', 'only the covers and info query')
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
  t.is(req.init.method + ' ' + req.url, 'POST ' + origin + '/account/audius/item?covers=1&info=1')
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

test('audiusItem: reuse keeps track answers as independent shallow copies', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, session({ '/account/audius/item': json(200, track) }))
  const opts = { member: M, request: signer([]), reuse: true }
  const first = await a.audiusItem('track', track.id, opts)
  const second = await a.audiusItem('track', track.id, opts)
  t.alike(first, track)
  t.alike(second, first)
  t.not(first, second)
  first.title = 'Changed'
  second.artist = 'Changed'
  t.alike(await a.audiusItem('track', track.id, opts), track, 'callers cannot change the cached answer')
  t.is(reads(calls, '/account/audius/item').length, 1)
  t.is(reads(calls, '/account/audius/session/start').length, 1)
  const before = calls.length
  for (const changes of [{ request: null }, { member: 'zz' }]) {
    t.is(await code(t, a.audiusItem('track', track.id, { ...opts, ...changes })), 'pedido-invalido')
  }
  t.is(await code(t, a.audiusItem('album', track.id, opts)), 'pedido-invalido')
  t.is(calls.length, before, 'validation still precedes a cache hit')
})

test('audiusItem: only reuse === true reads or writes the track cache', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const routes = session({ '/account/audius/item': json(200, track) })
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]) }
  for (const reuse of [undefined, false, 'yes']) {
    await a.audiusItem('track', track.id, { ...opts, reuse })
    await a.audiusItem('track', track.id, { ...opts, reuse })
  }
  t.is(reads(calls, '/account/audius/item').length, 6, 'ordinary calls always ask')
  const cached = { ...track, title: 'Kept' }
  routes['/account/audius/item'] = json(200, cached)
  t.alike(await a.audiusItem('track', track.id, { ...opts, reuse: true }), cached, 'ordinary calls wrote nothing')
  routes['/account/audius/item'] = json(200, track)
  for (const reuse of [undefined, false, 'yes']) {
    t.alike(await a.audiusItem('track', track.id, { ...opts, reuse }), track, 'ordinary calls ignore a warm cache')
  }
  t.alike(await a.audiusItem('track', track.id, { ...opts, reuse: true }), cached, 'ordinary calls did not replace the entry')
  t.is(reads(calls, '/account/audius/item').length, 10)
})

test('audiusItem: reuse expires after ten minutes on the injected clock', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  let clock = 1000000
  const calls = stub(t, session({ '/account/audius/item': json(200, track) }))
  const opts = { member: M, request: signer([]), reuse: true, now: () => clock }
  t.is(a.AUDIUS_ITEM_REUSE_MS, 10 * 60 * 1000)
  await a.audiusItem('track', track.id, opts)
  clock += a.AUDIUS_ITEM_REUSE_MS - 1
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 1, 'still fresh')
  clock++
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 2, 'expired at the boundary')
  clock += a.AUDIUS_ITEM_REUSE_MS + 1
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 3, 'older than ten minutes')
})

test('audiusItem: the reuse timer drops a track after ten minutes with no further ask', async (t) => {
  const a = await load()
  const timers = []
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false, fake: true, unrefed: false }
    timer.unref = () => { timer.unrefed = true }
    timer.close = () => { timer.cleared = true }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (id) => {
    if (id && id.fake === true) id.cleared = true
    else realClear(id)
  }
  t.teardown(() => {
    a.forgetAudiusSession()
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  })
  a.forgetAudiusSession()
  let clock = 1000000
  const calls = stub(t, session({ '/account/audius/item': json(200, track) }))
  const opts = { member: M, request: signer([]), reuse: true, now: () => clock }
  const armed = () => timers.filter((x) => !x.cleared)
  await a.audiusItem('track', track.id, opts)
  t.is(armed().length, 1, 'one timer for the earliest expiry')
  t.is(armed()[0].ms, a.AUDIUS_ITEM_REUSE_MS)
  t.is(armed()[0].unrefed, true, 'the timer does not keep the process alive')
  armed()[0].fn()
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 1, 'a sweep before ten minutes keeps the track')
  t.is(armed().length, 1, 'the timer is armed again for the same entry')
  t.is(armed()[0].ms, a.AUDIUS_ITEM_REUSE_MS)
  clock += a.AUDIUS_ITEM_REUSE_MS
  armed()[0].fn()
  t.is(armed().length, 0, 'an empty map clears the timer')
  // Back inside the original window: a hit would mean the sweep left the entry.
  clock = 1000000 + 1
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 2, 'gone after ten minutes without another ask')
  a.forgetAudiusSession()
  t.is(armed().length, 0, 'forget clears the timer')
  await a.audiusItem('track', track.id, opts)
  const { wipeLocalCaches } = await import('../src/localCaches.js')
  t.is(armed().length, 1)
  wipeLocalCaches()
  t.is(armed().length, 0, 'a wipe clears the timer')
})

test('audiusItem: reuse never keeps a failed or aborted answer', async (t) => {
  const a = await load()
  const opts = { member: M, request: signer([]), reuse: true }
  for (const failure of [json(503, { error: 'indisponivel' }), json(200, { ...track, id: 'Other1' }), json(200, { ...track, x: 1 }), (init) => {
    t.ok(init.signal.aborted, 'the caller abort reached fetch')
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }]) {
    a.forgetAudiusSession()
    const ctl = new AbortController()
    if (typeof failure === 'function') ctl.abort()
    const routes = session({ '/account/audius/item': failure })
    const calls = stub(t, routes)
    t.is(await code(t, a.audiusItem('track', track.id, { ...opts, signal: ctl.signal })), 'indisponivel')
    routes['/account/audius/item'] = json(200, track)
    t.alike(await a.audiusItem('track', track.id, opts), track)
    t.alike(await a.audiusItem('track', track.id, opts), track)
    t.is(reads(calls, '/account/audius/item').length, 2, 'only the successful answer is kept')
  }
})

test('audiusItem: concurrent reuse calls have independent requests and abort signals', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const pending = []
  const routes = session({ '/account/audius/item': (init) => new Promise((resolve) => { pending.push({ init, resolve }) }) })
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]), reuse: true }
  const ctl = new AbortController()
  const first = a.audiusItem('track', track.id, { ...opts, signal: ctl.signal })
  const second = a.audiusItem('track', track.id, opts)
  await flushAll()
  t.is(pending.length, 2, 'item requests are never shared')
  ctl.abort()
  t.ok(pending[0].init.signal.aborted)
  t.absent(pending[1].init.signal.aborted, 'the other caller stays live')
  pending[0].resolve(json(200, track))
  t.alike(await first, track, 'even a fetch that ignores abort may settle')
  routes['/account/audius/item'] = json(200, track)
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 3, 'the aborted answer was not kept')
  pending[1].resolve(json(200, track))
  t.alike(await second, track)
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 3, 'the live answer is reusable')
})

test('audiusItem: reuse separates members, origins and ids', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, session({ '/account/audius/item': (init) => json(200, { ...track, id: JSON.parse(init.body).id }) }))
  const opts = { member: M, origin: 'https://mus-reuse.example.org', request: signer([]), reuse: true }
  for (const changes of [{}, { member: 'cd'.repeat(32) }, { origin: 'https://mus-reuse-other.example.org' }, { id: 'T2abc' }]) {
    const { id = track.id, ...overrides } = changes
    const local = { ...opts, ...overrides }
    t.alike(await a.audiusItem('track', id, local), { ...track, id })
    t.alike(await a.audiusItem('track', id, local), { ...track, id })
  }
  t.is(reads(calls, '/account/audius/item').length, 4)
})

test('audiusItem: forgetting a session drops only its entries, or all without a member', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, session({ '/account/audius/item': json(200, track) }))
  const opts = { member: M, origin: 'https://mus-forget.example.org', request: signer([]), reuse: true }
  const sessions = [opts, { ...opts, member: 'cd'.repeat(32) }, { ...opts, origin: 'https://mus-forget-other.example.org' }]
  for (const s of sessions) await a.audiusItem('track', track.id, s)
  a.forgetAudiusSession(opts)
  for (const s of sessions) await a.audiusItem('track', track.id, s)
  t.is(reads(calls, '/account/audius/item').length, 4, 'other members and origins keep their entries')
  a.forgetAudiusSession()
  for (const s of sessions) await a.audiusItem('track', track.id, s)
  for (const s of sessions) await a.audiusItem('track', track.id, s)
  t.is(reads(calls, '/account/audius/item').length, 7, 'forget all clears every entry')
})

test('audiusItem: a 401 on a read or session opening clears the member cache', async (t) => {
  const a = await load()
  for (const duringSession of [false, true]) {
    a.forgetAudiusSession()
    const routes = session({ '/account/audius/item': json(200, track), '/account/audius/search': json(401, { error: 'nao-autorizado' }) })
    const calls = stub(t, routes)
    const opts = { member: M, request: signer([]), reuse: true }
    await a.audiusItem('track', track.id, opts)
    await a.audiusItem('track', track.id, opts)
    t.is(reads(calls, '/account/audius/item').length, 1)
    if (duringSession) {
      routes['/account/audius/session/start'] = json(401, { error: 'nao-autorizado' })
      const realNow = Date.now
      Date.now = () => new Date(LATER).getTime()
      try {
        t.is(await code(t, a.audiusSearch('a', { ...opts, kind: 'track' })), 'nao-autorizado')
      } finally {
        Date.now = realNow
      }
    } else {
      t.is(await code(t, a.audiusSearch('a', { ...opts, kind: 'track' })), 'nao-autorizado')
    }
    routes['/account/audius/session/start'] = json(200, { nonce: NONCE })
    await a.audiusItem('track', track.id, opts)
    await a.audiusItem('track', track.id, opts)
    t.is(reads(calls, '/account/audius/item').length, 2, 'the 401 dropped the track')
  }
})

test('audiusItem: wiping local caches clears reusable tracks', async (t) => {
  const a = await load()
  const { wipeLocalCaches } = await import('../src/localCaches.js')
  a.forgetAudiusSession()
  const calls = stub(t, session({ '/account/audius/item': json(200, track) }))
  const opts = { member: M, request: signer([]), reuse: true }
  await a.audiusItem('track', track.id, opts)
  wipeLocalCaches()
  await a.audiusItem('track', track.id, opts)
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 2)
})

test('audiusItem: a late answer after invalidation is returned but never stored', async (t) => {
  const a = await load()
  const { wipeLocalCaches, bumpCacheGeneration } = await import('../src/localCaches.js')
  for (const invalidate of ['wipe', 'forget', 'forget all', '401', 'generation']) {
    a.forgetAudiusSession()
    let finish
    const routes = session({
      '/account/audius/item': () => new Promise((resolve) => { finish = resolve }),
      '/account/audius/search': json(401, { error: 'nao-autorizado' })
    })
    const calls = stub(t, routes)
    const opts = { member: M, request: signer([]), reuse: true }
    const pending = a.audiusItem('track', track.id, opts)
    await flushAll()
    t.is(reads(calls, '/account/audius/item').length, 1, 'request started before ' + invalidate)
    if (invalidate === 'wipe') wipeLocalCaches()
    else if (invalidate === 'forget') a.forgetAudiusSession(opts)
    else if (invalidate === 'forget all') a.forgetAudiusSession()
    else if (invalidate === 'generation') bumpCacheGeneration()
    else t.is(await code(t, a.audiusSearch('a', { ...opts, kind: 'track' })), 'nao-autorizado')
    finish(json(200, track))
    t.alike(await pending, track, 'the original caller still gets its answer after ' + invalidate)
    routes['/account/audius/item'] = json(200, track)
    await a.audiusItem('track', track.id, opts)
    await a.audiusItem('track', track.id, opts)
    t.is(reads(calls, '/account/audius/item').length, 2, 'the late answer was not kept after ' + invalidate)
  }
})

test('audiusItem: an invalidation while the session opens keeps the answer out', async (t) => {
  const a = await load()
  const { wipeLocalCaches, bumpCacheGeneration } = await import('../src/localCaches.js')
  for (const invalidate of ['wipe', 'forget', 'forget all', 'generation']) {
    a.forgetAudiusSession()
    let opened
    const routes = session({
      '/account/audius/session/finish': () => new Promise((resolve) => { opened = resolve }),
      '/account/audius/item': json(200, track)
    })
    const calls = stub(t, routes)
    const opts = { member: M, request: signer([]), reuse: true }
    const pending = a.audiusItem('track', track.id, opts)
    await flushAll()
    t.is(reads(calls, '/account/audius/session/finish').length, 1, 'session opening before ' + invalidate)
    t.is(reads(calls, '/account/audius/item').length, 0)
    if (invalidate === 'wipe') wipeLocalCaches()
    else if (invalidate === 'forget') a.forgetAudiusSession(opts)
    else if (invalidate === 'forget all') a.forgetAudiusSession()
    else bumpCacheGeneration()
    opened(json(200, { token: TOKEN, expiresAt: LATER }))
    t.alike(await pending, track, 'the caller still gets its answer after ' + invalidate)
    await a.audiusItem('track', track.id, opts)
    t.is(reads(calls, '/account/audius/item').length, 2, 'the answer was not kept after ' + invalidate)
  }
})

test('audiusItem: a forget while the 401 retry opens its session keeps the answer out', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  let n = 0
  let finishes = 0
  let opened = null
  const routes = session({
    '/account/audius/item': () => (++n === 1 ? json(401, { error: 'nao-autorizado' }) : json(200, track))
  })
  routes['/account/audius/session/finish'] = () => (++finishes === 1
    ? json(200, { token: TOKEN, expiresAt: LATER })
    : new Promise((resolve) => { opened = resolve }))
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]), reuse: true }
  const pending = a.audiusItem('track', track.id, opts)
  for (let i = 0; i < 10; i++) await flushAll()
  t.ok(opened, 'the retry is opening its session')
  a.forgetAudiusSession(opts)
  opened(json(200, { token: TOKEN, expiresAt: LATER }))
  t.alike(await pending, track, 'the caller still gets its answer')
  t.is(reads(calls, '/account/audius/item').length, 2)
  await a.audiusItem('track', track.id, opts)
  t.is(reads(calls, '/account/audius/item').length, 3, 'the answer was not kept')
})

test('audiusItem: a 401 retry is returned and stored for reuse', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  let n = 0
  const calls = stub(t, session({
    '/account/audius/item': () => (++n === 1 ? json(401, { error: 'nao-autorizado' }) : json(200, track))
  }))
  const opts = { member: M, request: signer([]), reuse: true }
  t.alike(await a.audiusItem('track', track.id, opts), track)
  t.is(reads(calls, '/account/audius/item').length, 2, 'the 401 was retried once')
  t.alike(await a.audiusItem('track', track.id, opts), track)
  t.is(reads(calls, '/account/audius/item').length, 2, 'the retried answer is reused within ten minutes')
})

test('audiusItem: the 33rd reusable track evicts the oldest insertion', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const calls = stub(t, session({ '/account/audius/item': (init) => json(200, { ...track, id: JSON.parse(init.body).id }) }))
  const opts = { member: M, request: signer([]), reuse: true }
  for (let i = 0; i < 32; i++) await a.audiusItem('track', 'T' + i, opts)
  await a.audiusItem('track', 'T0', opts)
  t.is(reads(calls, '/account/audius/item').length, 32, 'a hit keeps its insertion order')
  await a.audiusItem('track', 'T32', opts)
  await a.audiusItem('track', 'T1', opts)
  t.is(reads(calls, '/account/audius/item').length, 33, 'the second entry survives')
  await a.audiusItem('track', 'T0', opts)
  t.is(reads(calls, '/account/audius/item').length, 34, 'the oldest entry was dropped')
})

test('audiusItem: playlists never reuse or populate the track cache', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const full = { ...playlist, id: track.id, tracks: [track] }
  const calls = stub(t, session({ '/account/audius/item': (init) => json(200, JSON.parse(init.body).kind === 'track' ? track : full) }))
  const opts = { member: M, request: signer([]), reuse: true }
  t.alike(await a.audiusItem('playlist', track.id, opts), full)
  t.alike(await a.audiusItem('playlist', track.id, opts), full)
  t.alike(await a.audiusItem('track', track.id, opts), track)
  t.alike(await a.audiusItem('playlist', track.id, opts), full)
  t.alike(await a.audiusItem('track', track.id, opts), track)
  t.is(reads(calls, '/account/audius/item').length, 4)
})

test('audiusResolve: only an audius.co page leaves the device, to the account origin', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const routes = session({ '/account/audius/resolve': json(200, { kind: 'track', item: track }) })
  const calls = stub(t, routes)
  const opts = { member: M, request: signer([]) }
  t.alike(await a.audiusResolve(PAGE, opts), { kind: 'track', item: track })
  const req = reads(calls, '/account/audius/resolve')[0]
  t.is(req.url, '/account/audius/resolve?covers=1&info=1', 'the web keeps the page origin')
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

test('search, item and resolve ask covers and info by query with unchanged bodies', async (t) => {
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
    t.is(url.search, '?covers=1&info=1', route + ': the covers and info query and nothing else')
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

test('audiusArt with large asks the 480 cover by query, with the same body and checks', async (t) => {
  const a = await load()
  a.forgetAudiusSession()
  const origin = 'https://mus-art-large.example.org'
  const routes = session({ '/account/audius/art': json(200, { mime: 'image/jpeg', bytes: b64(JPEG) }) })
  const calls = stub(t, routes)
  const opts = { origin, member: M, request: signer([]) }
  t.alike(await a.audiusArt('track', 'T1abc', { ...opts, large: true }), { mime: 'image/jpeg', base64: b64(JPEG) })
  t.alike(await a.audiusArt('track', 'T1abc', opts), { mime: 'image/jpeg', base64: b64(JPEG) })
  t.alike(await a.audiusArt('track', 'T1abc', { ...opts, large: 'yes' }), { mime: 'image/jpeg', base64: b64(JPEG) })
  t.alike(await a.audiusArt('track', 'T1abc', { ...opts, large: false }), { mime: 'image/jpeg', base64: b64(JPEG) })
  const [big, small, truthy, off] = reads(calls, '/account/audius/art')
  t.is(big.init.method + ' ' + big.url, 'POST ' + origin + '/account/audius/art?size=480')
  t.is(small.init.method + ' ' + small.url, 'POST ' + origin + '/account/audius/art', 'without large: the old path')
  t.is(truthy.url, origin + '/account/audius/art', 'only large === true asks the large cover')
  t.is(off.url, origin + '/account/audius/art')
  for (const req of [big, small, truthy, off]) t.is(req.init.body, JSON.stringify({ kind: 'track', id: 'T1abc' }), 'the same body')

  // The same refusals hold for the large cover.
  routes['/account/audius/art'] = json(200, { mime: 'image/png', bytes: b64(JPEG) })
  let err = await a.audiusArt('track', 'T1abc', { ...opts, large: true }).catch((e) => e)
  t.is(err.code, 'indisponivel', 'a mime that does not match the bytes')
  t.is(err.noCover, true)
  routes['/account/audius/art'] = json(404, { error: 'nao-encontrado' })
  err = await a.audiusArt('track', 'T1abc', { ...opts, large: true }).catch((e) => e)
  t.is(err.noCover, true, 'a 404 is no cover')
  const { MUSIC_ART_MAX_BYTES } = await import('../src/music.js')
  const past = Buffer.alloc(MUSIC_ART_MAX_BYTES + 1)
  JPEG.copy(past)
  routes['/account/audius/art'] = json(200, { mime: 'image/jpeg', bytes: b64(past) })
  err = await a.audiusArt('track', 'T1abc', { ...opts, large: true }).catch((e) => e)
  t.is(err.code, 'indisponivel', 'the same byte cap')
  t.is(err.noCover, true)
  for (const req of reads(calls, '/account/audius/art').slice(4)) t.is(req.url, origin + '/account/audius/art?size=480')
})

test('the cover cache loads once per key, bounds parallel loads, keeps failures, evicts past max and clears', async (t) => {
  const { coverKey, coverUri, createCoverCache } = await import('../src/musicCover.js')
  const s1 = { member: M, origin: 'https://a.example.org', request: () => {} }
  const s2 = { member: 'cd'.repeat(32), origin: 'https://a.example.org', request: () => {} }
  t.is(coverKey('track', 'T1', s1), 'https://a.example.org|' + M + '|track|T1')
  t.is(coverKey('track', 'T1', { member: M }), '|' + M + '|track|T1')
  t.not(coverKey('track', 'T1', s1), coverKey('track', 'T1', s2), 'another member, another key')
  t.not(coverKey('track', 'T1', s1), coverKey('playlist', 'T1', s1))
  t.is(coverKey('track', 'T1', { ...s1, large: true }), 'https://a.example.org|' + M + '|track|T1|480')
  t.is(coverKey('track', 'T1', { ...s1, large: false }), coverKey('track', 'T1', s1), 'small is the old key')
  t.is(coverKey('track', 'T1', { ...s1, large: 'yes' }), coverKey('track', 'T1', s1), 'only large === true')
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

test('peek reads a settled cover and never loads', async (t) => {
  const { createCoverCache } = await import('../src/musicCover.js')
  const s = { member: 'm', origin: 'o' }
  const loads = []
  let finish = null
  const cache = createCoverCache({ load: (kind, id) => { loads.push(id); return new Promise((resolve) => { finish = resolve }) } })
  t.is(cache.peek('track', 'T1', s), null, 'nothing in memory')
  t.is(loads.length, 0, 'a peek loads nothing')
  const got = cache.get('track', 'T1', s)
  await new Promise((resolve) => setImmediate(resolve))
  t.is(cache.peek('track', 'T1', s), null, 'a load in flight is not a cover yet')
  finish('data:image/png;base64,AAAA')
  await got
  t.is(cache.peek('track', 'T1', s), 'data:image/png;base64,AAAA')
  t.is(cache.peek('track', 'T1', { member: 'other', origin: 'o' }), null, 'never another member')
  t.is(cache.peek('track', 'T1', { ...s, large: true }), null, 'the large cover is its own')
  t.is(cache.peek('track', 'T1', null), null)
  t.is(loads.length, 1)
})

test('useMusicCover in cached mode shows memory only and starts no load', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/useMusicCover.js'), 'utf8')
  const body = source.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const gets = []
  const memory = new Map()
  const fakeCache = {
    get: (kind, id, session, opts) => { gets.push(id); return Promise.resolve('data:image/png;base64,BBBB') },
    peek: (kind, id, session) => memory.get(id) ?? null,
    clear: () => {}
  }
  const slots = []
  let cursor = 0
  const hooks = {
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = initial
      return [slots[at], (next) => { slots[at] = next }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useEffect: (fn, deps) => {
      const at = cursor++
      const before = slots[at]
      if (before && deps.every((v, i) => Object.is(v, before.deps[i]))) return
      if (before && typeof before.cleanup === 'function') before.cleanup()
      slots[at] = { deps, cleanup: fn() }
    }
  }
  // eslint-disable-next-line no-new-func
  const { useMusicCover } = new Function('useEffect', 'useRef', 'useState', 'audiusArt', 'registerLocalCache', 'coverUri', 'createCoverCache', body + '\nreturn { useMusicCover }')(
    hooks.useEffect, hooks.useRef, hooks.useState, () => {}, () => {}, () => null, () => fakeCache)
  const use = (...args) => { cursor = 0; return useMusicCover(...args) }
  const item = { id: 'T1', cover: true }
  const session = { member: 'm', origin: 'o' }
  t.is(use('track', item, session, 'cached'), null, 'nothing in memory, nothing shown')
  t.is(gets.length, 0, 'cached mode never loads')
  memory.set('T1', 'data:image/png;base64,AAAA')
  t.is(use('track', item, session, 'cached'), 'data:image/png;base64,AAAA', 'a cover in memory shows')
  t.is(gets.length, 0)
  use('track', item, session, true)
  t.is(gets.length, 1, 'enabled true loads as before')
  t.is(use('track', item, session, 'cached'), 'data:image/png;base64,AAAA', 'turning cached keeps the cover on screen')
  t.is(gets.length, 1)
  use('track', item, session, false)
  t.is(gets.length, 1, 'false loads nothing, as before')
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
  t.ok(hook.includes('}, [kind, id, cover, member, origin, enabled, large])'), 'the effect keys on primitives only')
  t.ok(hook.includes('const stamp = [kind, id, cover, member, origin, enabled, large]'), 'the uri is stamped with every input')
  t.ok(hook.includes('setLoaded({ stamp, uri: value })'), 'a loaded uri carries its stamp')
  t.ok(hook.includes('loaded.stamp.every((v, i) => v === stamp[i]) ? loaded.uri : null'), 'returned only under the matching stamp')
  t.ok(hook.includes('{ member, origin, request: s && s.request, large }'), 'the cache session carries large')
  t.ok(hook.includes('{ signal: ctl.signal }') && hook.includes('ctl.abort()'), 'an unmounted row leaves its queued load')
  t.ok(hook.includes('if (err && err.noCover === true) return null'), 'only a definite refusal is kept')
})

test('the cover cache keeps the small and the large cover of one item apart', async (t) => {
  const { createCoverCache } = await import('../src/musicCover.js')
  const s1 = { member: M, origin: 'https://a.example.org', request: () => {} }
  const loads = []
  const cache = createCoverCache({ load: async (kind, id, session) => { loads.push(session); return session.large === true ? 'data:image/jpeg;base64,LARGE' : 'data:image/jpeg;base64,SMALL' } })
  t.is(await cache.get('track', 'T1', s1), 'data:image/jpeg;base64,SMALL')
  t.is(await cache.get('track', 'T1', { ...s1, large: true }), 'data:image/jpeg;base64,LARGE', 'the small cover never answers a large ask')
  t.is(loads.length, 2)
  t.is(loads[1].large, true, 'the load gets large in its session')
  t.is(await cache.get('track', 'T1', s1), 'data:image/jpeg;base64,SMALL', 'nor the large a small one')
  t.is(await cache.get('track', 'T1', { ...s1, large: true }), 'data:image/jpeg;base64,LARGE')
  t.is(loads.length, 2, 'each size kept under its own key')
})

// Runs the hook body with stubbed React hooks and a stubbed cache: React,
// the account module and the network never load.
async function coverHook () {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/useMusicCover.js'), 'utf8')
  const body = src.slice(src.indexOf('export function useMusicCover')).replace(/\bexport /g, '')
  const slots = []
  let cursor = 0
  let effects = []
  const useState = (initial) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = initial
    return [slots[at], (next) => { slots[at] = next }]
  }
  const useRef = (initial) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = { current: initial }
    return slots[at]
  }
  const useEffect = (fn, deps) => {
    const at = cursor++
    const prev = slots[at]
    if (!prev || deps.some((v, i) => v !== prev.deps[i])) effects.push(() => { if (prev && prev.cleanup) prev.cleanup(); slots[at] = { deps, cleanup: fn() } })
    else effects.push(() => {})
  }
  const asks = []
  const cache = {
    get: (kind, id, session, opts) => {
      asks.push({ kind, id, session, opts })
      return Promise.resolve('data:image/png;base64,' + id + (session.large === true ? 'L' : ''))
    }
  }
  // eslint-disable-next-line no-new-func
  const useMusicCover = new Function('useState', 'useEffect', 'useRef', 'cache', body + '\nreturn useMusicCover')(useState, useEffect, useRef, cache)
  const render = (...args) => {
    cursor = 0
    effects = []
    return useMusicCover(...args)
  }
  const commit = async () => {
    for (const run of effects) run()
    await flushAll()
  }
  return { render, commit, asks }
}

test('useMusicCover never returns the previous item\'s cover', async (t) => {
  const { render, commit, asks } = await coverHook()
  const s = { member: M, origin: 'https://a.example.org', request: () => {} }
  const A = { id: 'TA', cover: true }
  const B = { id: 'TB', cover: true }
  t.is(render('track', A, s), null, 'nothing while it loads')
  await commit()
  t.is(render('track', A, s), 'data:image/png;base64,TA')
  t.is(render('track', B, s), null, 'the first render after the item changes is not the previous cover')
  await commit()
  t.is(render('track', B, s), 'data:image/png;base64,TB')
  t.is(render('track', B, { ...s, member: 'cd'.repeat(32) }), null, 'another member')
  await commit()
  t.is(render('track', B, s), null, 'back to the first member: the other member\'s uri is not reused')
  await commit()
  t.is(render('track', B, s), 'data:image/png;base64,TB')
  t.is(render('track', B, { ...s, origin: 'https://b.example.org' }), null, 'another origin')
  await commit()
  t.is(render('track', B, s, true, true), null, 'the large size is another stamp')
  await commit()
  t.is(render('track', B, s, true, true), 'data:image/png;base64,TBL')
  t.is(asks.at(-1).session.large, true, 'large reaches the cache session')
  t.is(render('track', B, s, false, true), null, 'disabled')
  await commit()
  t.is(render('track', { ...B, cover: false }, s), null, 'no cover')
  const before = asks.length
  t.is(render('track', { ...B, cover: false }, { ...s, request: () => {} }), null)
  await commit()
  t.is(asks.length, before, 'a new session object with the same primitives loads nothing again')
})
