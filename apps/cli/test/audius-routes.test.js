'use strict'

// apps/cli/lib/account/audius-routes.js behind a minimal HTTP harness (the
// account server mounts it separately), against two loopback fixtures: a
// fake Audius API and a storage node the stream redirects to. Both are plain
// HTTP on 127.0.0.1, reached through an injected request (each name mapped
// to its fixture's port), lookup and address allowlist: no socket leaves
// loopback, and every connection made is recorded and checked.

const test = require('brittle')
const http = require('node:http')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { signInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { RECHECK_MS } = require('../lib/account/member-session')
const { parseAudiusConfig } = require('../lib/account/audius-provider')
const {
  createAudiusRoutes,
  USER_AGENT,
  ITEMS_PER_DAY,
  RESOLVES_PER_DAY,
  PLAYS_PER_DAY,
  SEARCHES_PER_DAY,
  OPENS_PER_TICKET,
  TICKET_TTL_MS,
  TICKETS_PER_MEMBER
} = require('../lib/account/audius-routes')

const KEY = 'chave-sentinela-audius-42'
const QUERY = 'samba-sentinela'
const API = 'api.audius.test'
const NODE = 'node.audius.test'
const PRIVATE = 'private.audius.test'
const AUDIO = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
const BIG = Buffer.alloc(300, 7)
const PROVIDER_HEADERS = ['host', 'connection', 'user-agent', 'accept', 'range', 'x-api-key']

// --- the harness the account server provides --------------------------------

const STATUS = {
  'pedido-invalido': 400,
  'assinatura-invalida': 400,
  expirado: 404,
  'nao-encontrado': 404,
  'feature-off': 404,
  'nao-autorizado': 401,
  'nao-vinculado': 403,
  'sem-permissao': 403,
  'termos-pendentes': 409,
  indisponivel: 503
}

class RouteError extends Error {
  constructor (token, status, extra) {
    super(token)
    this.token = token
    this.status = status
    this.extra = extra
  }
}

const refuse = (token) => new RouteError(token, STATUS[token] ?? 400)

function send (res, status, body, headers = {}) {
  const text = JSON.stringify(body) + '\n'
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', () => reject(refuse('pedido-invalido')))
    req.on('end', () => {
      let value
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(refuse('pedido-invalido')) }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject(refuse('pedido-invalido'))
      resolve(value)
    })
  })
}

function checkPost (req) {
  if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) throw refuse('pedido-invalido')
}

const harness = { send, readJsonBody, checkPost, RouteError, refuse }

// --- the fixtures ------------------------------------------------------------

function track (id, extra = {}) {
  return {
    id,
    title: 'Musica ' + id,
    duration: 180,
    permalink: '/artista/musica-' + id.toLowerCase(),
    user: { name: 'Artista', id: 'u1' },
    artwork: { '150x150': 'https://art.example/' + id + '.jpg' },
    is_streamable: true,
    is_stream_gated: false,
    access: { stream: true },
    ...extra
  }
}

function playlist (id, extra = {}) {
  return {
    id,
    playlist_name: 'Lista ' + id,
    permalink: '/artista/playlist/lista-' + id.toLowerCase(),
    user: { name: 'Artista' },
    track_count: 60,
    access: { stream: true },
    ...extra
  }
}

function fixture (name, route) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + name)
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers })
    route(url, req, res)
  })
  return {
    seen,
    port: 0,
    async listen () {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      this.port = server.address().port
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
}

function json (res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// Track ids the fake API answers with an error status.
const ERRORS = { Err500: 500, Err503: 503, Err429: 429, Err403: 403, Err400: 400, Gone410: 410 }

function fakeApi (state) {
  return fixture(API, (url, req, res) => {
    const p = url.pathname
    if (state.mode === 'garbage') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html></html>')
    }
    if (p === '/v1/tracks/search') {
      const code = url.searchParams.get('query').match(/^erro(\d{3})$/)
      if (code) return json(res, Number(code[1]), {})
      const offset = Number(url.searchParams.get('offset'))
      const data = [
        track('Ranged1'),
        track('Gated1', { is_stream_gated: true }),
        track('bad id'),
        track('NoUser1', { user: null }),
        track('Unlisted1', { is_unlisted: true })
      ]
      while (data.length < 12) data.push(track('Fill' + data.length))
      return json(res, 200, { data: offset >= 492 ? data.slice(0, 3) : data })
    }
    if (p === '/v1/playlists/search') {
      return json(res, 200, { data: [playlist('Pl1'), playlist('Pl2', { is_private: true }), playlist('Pl3', { track_count: 0 })] })
    }
    if (p === '/v1/resolve') {
      const target = url.searchParams.get('url')
      const code = target.match(/\/s(\d{3})$/)
      if (code) return json(res, Number(code[1]), {})
      if (target.endsWith('/fora')) {
        res.writeHead(302, { Location: 'https://evil.audius.test/v1/tracks/Ranged1' })
        return res.end()
      }
      if (target.endsWith('/lista')) {
        res.writeHead(302, { Location: '/v1/playlists/Pl1' })
        return res.end()
      }
      res.writeHead(302, { Location: '/v1/tracks/Ranged1?app_name=varanda' })
      return res.end()
    }
    let m = p.match(/^\/v1\/tracks\/([A-Za-z0-9]+)\/stream$/)
    if (m) {
      const id = m[1]
      res.writeHead(302, { Location: id === 'Private1' ? 'https://' + PRIVATE + '/audio/x' : 'https://' + NODE + '/audio/' + id })
      return res.end()
    }
    m = p.match(/^\/v1\/tracks\/([A-Za-z0-9]+)$/)
    if (m) {
      const id = m[1]
      if (id === 'Missing1') return json(res, 404, { error: 'not found' })
      // Held until the test answers it, to keep provider calls in flight.
      if (/^Slow\d+$/.test(id)) return state.slow.push({ id, res })
      if (Object.hasOwn(ERRORS, id)) return json(res, ERRORS[id], { error: 'erro' })
      if (id === 'Gated1') return json(res, 200, { data: track(id, { is_stream_gated: true }) })
      if (id === 'Swap1') return json(res, 200, { data: track('Other1') })
      return json(res, 200, { data: track(id) })
    }
    m = p.match(/^\/v1\/playlists\/([A-Za-z0-9]+)\/tracks$/)
    if (m) {
      const data = []
      for (let i = 0; i < 60; i++) data.push(i % 10 === 3 ? track('Gate' + i, { access: { stream: false } }) : track('Pt' + i))
      return json(res, 200, { data })
    }
    m = p.match(/^\/v1\/playlists\/([A-Za-z0-9]+)$/)
    if (m) return json(res, 200, { data: [playlist(m[1] === 'SwapPl1' ? 'OtherPl1' : m[1])] })
    json(res, 404, {})
  })
}

function fakeNode () {
  const held = new Set()
  const node = fixture(NODE, (url, req, res) => {
    const id = url.pathname.slice('/audio/'.length)
    const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d+)-(\d*)$/) : null
    if (id === 'Ranged1') {
      if (range === null) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes', 'Set-Cookie': 'node=1' })
        return res.end(AUDIO)
      }
      const start = Number(range[1])
      const end = range[2] === '' ? AUDIO.length - 1 : Math.min(Number(range[2]), AUDIO.length - 1)
      res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes ' + start + '-' + end + '/' + AUDIO.length, 'Content-Length': end - start + 1, 'X-Node-Secret': 'nao-repassar' })
      return res.end(AUDIO.subarray(start, end + 1))
    }
    if (id === 'Plain1') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length })
      return res.end(AUDIO)
    }
    if (id === 'Big1') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': BIG.length })
      return res.end(BIG)
    }
    if (id === 'Html1') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<script>alert(1)</script>')
    }
    if (id === 'Skew1') {
      res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 5-9/100', 'Content-Length': 5 })
      return res.end(AUDIO.subarray(5, 10))
    }
    if (id === 'Drop1') {
      // Ignores Range and drops the connection after 30 bytes.
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length })
      res.write(AUDIO.subarray(0, 30))
      return setTimeout(() => res.destroy(), 50)
    }
    if (id === 'Far1' || id === 'FarBad1' || id === 'FarNone1') {
      const headers = { 'Content-Type': 'text/plain' }
      if (id === 'Far1') headers['Content-Range'] = 'bytes */100'
      if (id === 'FarBad1') headers['Content-Range'] = 'bytes */100, bytes 0-1/2'
      res.writeHead(416, headers)
      return res.end()
    }
    if (id === 'Whole1' || id === 'Liar1') {
      // Answers the whole body to any Range; Liar1's length disagrees.
      res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-99/100', 'Content-Length': id === 'Liar1' ? 50 : AUDIO.length })
      return res.end(id === 'Liar1' ? AUDIO.subarray(0, 50) : AUDIO)
    }
    if (id === 'Hold1') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      held.add(res)
      res.on('close', () => held.delete(res))
      return res.write(Buffer.alloc(5, 2))
    }
    res.writeHead(404)
    res.end()
  })
  node.held = held
  return node
}

async function setup (t, { audius = true, moments = false, streams = 16, caps = {}, accepted = true } = {}) {
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const state = { mode: 'ok', slow: [] }
  const api = fakeApi(state)
  const node = fakeNode()
  await api.listen()
  await node.listen()
  const ports = { [API]: api.port, [NODE]: node.port }
  const looked = []
  const connected = []
  const transport = {
    request: (opts) => {
      const req = http.request({ ...opts, port: ports[opts.hostname] })
      req.on('socket', (s) => s.once('connect', () => connected.push(s.remoteAddress)))
      return req
    },
    lookup: (host, opts, cb) => {
      looked.push(host)
      if (host === API || host === NODE) return cb(null, [{ address: '127.0.0.1', family: 4 }])
      if (host === PRIVATE) return cb(null, [{ address: '10.0.0.7', family: 4 }])
      const err = new Error('ENOTFOUND')
      err.code = 'ENOTFOUND'
      cb(err)
    },
    allowAddress: (ip) => ip === '127.0.0.1'
  }

  const association = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const member = crypto.keyPair()
  const memberHex = b4a.toString(member.publicKey, 'hex')
  const other = crypto.keyPair()
  const otherHex = b4a.toString(other.publicKey, 'hex')
  const linked = new Set([memberHex, otherHex])
  const blocked = new Set()
  const store = { status: (m) => ({ linked: linked.has(m) }) }
  const terms = { available: () => true, list: (m) => (accepted ? [{ version: TERMS_VERSION }] : []) }
  const blocklist = { has: (k) => blocked.has(k) }
  const logs = []
  const config = audius ? parseAudiusConfig({ apiKey: KEY, apiUrl: 'https://' + API + '/v1', moments, streams }) : null
  const routes = createAudiusRoutes({ ...transport, config, store, terms, blocklist, association, log: (e) => logs.push(e), now, caps, http: harness })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const fail = (err) => {
      if (res.headersSent) return res.destroy()
      const e = err instanceof RouteError ? err : refuse('indisponivel')
      send(res, e.status, { error: e.token }, e.headers)
    }
    if (!routes.owns(url.pathname)) return fail(refuse('nao-encontrado'))
    routes.handle(req, res, url).then(() => req.resume(), (err) => { req.resume(); fail(err) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.teardown(async () => {
    for (const r of node.held) r.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await api.close()
    await node.close()
  })

  const responses = []

  // Resolves on end or on a cut, with `complete` false for a cut body.
  function call (method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? null : JSON.stringify(body)
      const h = { ...headers }
      if (text !== null) {
        h['Content-Type'] = 'application/json'
        h['Content-Length'] = Buffer.byteLength(text)
      }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
        const chunks = []
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          const raw = Buffer.concat(chunks)
          let parsed = null
          try { parsed = JSON.parse(raw.toString('utf8')) } catch {}
          const out = { status: res.statusCode, headers: res.headers, raw, json: parsed, complete: res.complete }
          responses.push(out)
          resolve(out)
        }
        res.on('data', (c) => chunks.push(c))
        res.on('end', done)
        res.on('close', done)
        res.on('error', () => {})
      })
      req.on('error', reject)
      if (text !== null) req.write(text)
      req.end()
    })
  }

  // An audio request left open once its headers arrived.
  function hold (path) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, agent: false }, (res) => {
        res.on('error', () => {})
        res.resume()
        resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy() })
      })
      req.on('error', () => {})
      req.end()
    })
  }

  async function login (kp = member) {
    const hex = b4a.toString(kp.publicKey, 'hex')
    const start = await call('POST', '/account/audius/session/start', { body: { member: hex } })
    if (start.status !== 200) return { start }
    const signature = signInvite({ action: 'summary', nonce: start.json.nonce, member: hex, association }, kp)
    const finish = await call('POST', '/account/audius/session/finish', { body: { member: hex, nonce: start.json.nonce, signature } })
    return { start, finish, token: finish.json && finish.json.token }
  }

  const bearer = (token) => (token === null ? {} : { Authorization: 'Bearer ' + token })
  const post = (token, name, body) => call('POST', '/account/audius/' + name, { body, headers: bearer(token) })
  const audio = (ticket, headers = {}) => call('GET', '/account/audius/audio/' + ticket, { headers })

  async function ticketFor (token, id) {
    const res = await post(token, 'play', { id })
    if (res.status !== 200) throw new Error('play ' + res.status + ' ' + JSON.stringify(res.json))
    return res.json.ticket
  }

  async function until (cond) {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    return cond()
  }

  return { routes, call, post, audio, hold, login, ticketFor, until, api, node, state, logs, responses, looked, connected, clock, linked, blocked, member, other, memberHex, otherHex }
}

function noKeyAnywhere (t, { logs, responses }) {
  for (const r of responses) {
    t.absent(r.raw.toString('latin1').includes(KEY), 'no key in a body')
    t.absent(JSON.stringify(r.headers).includes(KEY), 'no key in a header')
  }
  t.absent(JSON.stringify(logs).includes(KEY), 'no key in a log line')
  t.absent(JSON.stringify(logs).includes(QUERY), 'no query in a log line')
  for (const e of logs) t.alike(Object.keys(e).sort(), ['event', 'reason'], 'logs carry the reason only')
}

function onlyLoopback (t, { connected }) {
  t.ok(connected.length > 0, 'something was contacted')
  t.ok(connected.every((a) => a === '127.0.0.1'), 'nothing but loopback was contacted')
}

// --- tests -------------------------------------------------------------------

test('audius: off answers the policy and 404 feature-off on every other route', async (t) => {
  const { call } = await setup(t, { audius: false })
  const policy = await call('GET', '/account/audius/policy')
  t.is(policy.status, 200)
  t.alike(policy.json, { enabled: false, moments: false })
  const routes = [
    ['POST', '/account/audius/session/start', { member: 'a'.repeat(64) }],
    ['POST', '/account/audius/session/finish', { member: 'a'.repeat(64) }],
    ['POST', '/account/audius/search', { q: 'a', kind: 'track' }],
    ['POST', '/account/audius/item', { kind: 'track', id: 'abc' }],
    ['POST', '/account/audius/resolve', { url: 'https://audius.co/a/b' }],
    ['POST', '/account/audius/play', { id: 'abc' }],
    ['GET', '/account/audius/audio/' + 'A'.repeat(43)],
    ['POST', '/account/audius/audio/' + 'A'.repeat(43)],
    ['GET', '/account/audius/other']
  ]
  for (const [method, path, body] of routes) {
    const res = await call(method, path, { body })
    t.is(res.status, 404, method + ' ' + path)
    t.alike(res.json, { error: 'feature-off' })
  }
})

test('audius: the policy names moments only when the feature is on and the operator allows them', async (t) => {
  const on = await setup(t)
  t.alike((await on.call('GET', '/account/audius/policy')).json, { enabled: true, moments: false })
  const withMoments = await setup(t, { moments: true })
  t.alike((await withMoments.call('GET', '/account/audius/policy')).json, { enabled: true, moments: true })
})

test('audius: every member route needs a session, and a refused request spends nothing', async (t) => {
  const s = await setup(t, { caps: { budget: 2 } })
  const stranger = await s.login(crypto.keyPair())
  t.is(stranger.start.status, 403, 'a member that is not linked gets no nonce')
  const bodies = {
    search: { q: QUERY, kind: 'track' },
    item: { kind: 'track', id: 'Ranged1' },
    resolve: { url: 'https://audius.co/artista/musica' },
    play: { id: 'Ranged1' }
  }
  for (let i = 0; i < 10; i++) {
    for (const [name, body] of Object.entries(bodies)) {
      const none = await s.post(null, name, body)
      t.is(none.status, 401, name + ' without a token')
      t.is((await s.post('A'.repeat(43), name, body)).status, 401, name + ' with an unknown token')
    }
  }
  t.is(s.api.seen.length, 0, 'the provider was never asked')

  const { token } = await s.login()
  t.is((await s.post(token, 'search', bodies.search)).status, 200, 'the budget was untouched')
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Plain1' })).status, 200, 'an id the search did not cache')
  const over = await s.post(token, 'search', { q: 'outra', kind: 'track' })
  t.is(over.status, 503, 'a spent budget refuses')
  t.is(over.json.error, 'indisponivel')
  t.ok(s.logs.some((e) => e.reason === 'orcamento'), 'logged as orcamento')
  t.is(s.api.seen.length, 2, 'no call past the budget')
})

test('audius: body shapes are exact and refused before any provider call', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const bad = [
    ['search', { q: 'a' }],
    ['search', { q: 'a', kind: 'album' }],
    ['search', { q: 'a', kind: 'track', extra: 1 }],
    ['search', { q: '', kind: 'track' }],
    ['search', { q: '   ', kind: 'track' }],
    ['search', { q: 'a\u0007b', kind: 'track' }],
    ['search', { q: 'x'.repeat(65), kind: 'track' }],
    ['search', { q: 'a', kind: 'track', cursor: '501' }],
    ['search', { q: 'a', kind: 'track', cursor: 12 }],
    ['search', { q: 'a', kind: 'track', cursor: '012' }],
    ['search', { q: 'a', kind: 'track', cursor: null }],
    ['item', { kind: 'track' }],
    ['item', { kind: 'track', id: 'bad id' }],
    ['item', { kind: 'user', id: 'abc' }],
    ['item', { kind: 'track', id: 'abc', more: true }],
    ['resolve', { url: 'https://example.com/a/b' }],
    ['resolve', { url: 'https://audius.co/a/b?x=1' }],
    ['resolve', { url: 'http://audius.co/a/b' }],
    ['resolve', { url: 'https://audius.co/a/b', kind: 'track' }],
    ['play', { id: 'a/b' }],
    ['play', { id: 'abc', start: 1 }],
    ['play', {}]
  ]
  for (const [name, body] of bad) {
    const res = await s.post(token, name, body)
    t.is(res.status, 400, name + ' ' + JSON.stringify(body))
    t.alike(res.json, { error: 'pedido-invalido' })
  }
  t.is(s.api.seen.length, 0, 'nothing reached the provider')
  t.is((await s.post(token, 'search', { q: '🎵'.repeat(64), kind: 'track' })).status, 200, '64 code points pass')
})

test('audius: search, item and resolve answer only the mapped fields, and no key leaks', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()

  const tracks = await s.post(token, 'search', { q: QUERY, kind: 'track' })
  t.is(tracks.status, 200)
  t.alike(Object.keys(tracks.json).sort(), ['items', 'next'])
  t.is(tracks.json.next, '12', 'a full page has a next cursor')
  const ids = tracks.json.items.map((i) => i.id)
  t.ok(ids.includes('Ranged1'))
  for (const dropped of ['Gated1', 'bad id', 'NoUser1', 'Unlisted1']) t.absent(ids.includes(dropped), dropped + ' dropped')
  for (const it of tracks.json.items) t.alike(Object.keys(it).sort(), ['artist', 'duration', 'id', 'title', 'url'])
  t.alike(tracks.json.items[0], { id: 'Ranged1', title: 'Musica Ranged1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-ranged1' })
  const asked = s.api.seen[0]
  t.is(asked.path, '/v1/tracks/search')
  t.is(asked.query.query, QUERY)
  t.is(asked.query.limit, '12')
  t.is(asked.query.offset, '0')
  t.is(asked.query.app_name, 'varanda')
  t.absent(JSON.stringify(asked.query).includes(KEY), 'the key never rides the URL')
  t.is(asked.headers['x-api-key'], KEY, 'the key rides a header')
  t.is(asked.headers['user-agent'], USER_AGENT)
  t.ok(Object.keys(asked.headers).every((h) => PROVIDER_HEADERS.includes(h)), 'nothing else of ours')
  t.absent(JSON.stringify(asked).includes(s.memberHex), 'never the member key')
  t.absent(JSON.stringify(asked).includes(token), 'never the token')

  const last = await s.post(token, 'search', { q: QUERY, kind: 'track', cursor: '492' })
  t.is(last.json.next, null, 'a short page is the last')
  const near = await s.post(token, 'search', { q: QUERY, kind: 'track', cursor: '490' })
  t.is(near.json.next, null, 'no cursor past 500')

  const lists = await s.post(token, 'search', { q: QUERY, kind: 'playlist' })
  t.alike(lists.json, { items: [{ id: 'Pl1', title: 'Lista Pl1', artist: 'Artista', count: 60, url: 'https://audius.co/artista/playlist/lista-pl1' }], next: null })

  const one = await s.post(token, 'item', { kind: 'track', id: 'Plain1' })
  t.alike(one.json, { id: 'Plain1', title: 'Musica Plain1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-plain1' })
  const gated = await s.post(token, 'item', { kind: 'track', id: 'Gated1' })
  t.is(gated.status, 404)
  t.is(gated.json.error, 'nao-encontrado')
  const missing = await s.post(token, 'item', { kind: 'track', id: 'Missing1' })
  t.is(missing.status, 404, 'a provider 404 is not found')

  const pl = await s.post(token, 'item', { kind: 'playlist', id: 'Pl1' })
  t.is(pl.status, 200)
  t.alike(Object.keys(pl.json).sort(), ['artist', 'count', 'id', 'title', 'tracks', 'url'])
  t.ok(pl.json.tracks.length > 0 && pl.json.tracks.length <= 50, 'at most 50 tracks')
  t.absent(pl.json.tracks.some((x) => x.id.startsWith('Gate')), 'tracks that fail fromTrack are dropped')
  for (const it of pl.json.tracks) t.alike(Object.keys(it).sort(), ['artist', 'duration', 'id', 'title', 'url'])

  const resolved = await s.post(token, 'resolve', { url: 'https://audius.co/artista/musica' })
  t.alike(resolved.json, { kind: 'track', item: { id: 'Ranged1', title: 'Musica Ranged1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-ranged1' } })
  const resolvedList = await s.post(token, 'resolve', { url: 'https://audius.co/artista/playlist/lista' })
  t.is(resolvedList.json.kind, 'playlist')
  t.alike(resolvedList.json.item, { id: 'Pl1', title: 'Lista Pl1', artist: 'Artista', count: 60, url: 'https://audius.co/artista/playlist/lista-pl1' })
  const before = s.api.seen.length
  const away = await s.post(token, 'resolve', { url: 'https://audius.co/artista/fora' })
  t.is(away.status, 503, 'a redirect off the API host is refused')
  t.is(s.api.seen.length, before + 1)
  t.absent(s.looked.includes('evil.audius.test'), 'the off-host name is never even looked up')
  t.ok(['busca', 'item', 'resolve'].every((r) => s.logs.some((e) => e.reason === r)))

  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: resolve refuses a link that is not an audius.co page without a provider call', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  for (const url of ['https://audius.co.evil.test/a/b', 'https://open.spotify.com/track/x', 'https://audius.co/only']) {
    t.is((await s.post(token, 'resolve', { url })).status, 400, url)
  }
  t.is(s.api.seen.length, 0)
})

test('audius: play mints a ticket and audio relays 200 and 206 without the key reaching the node', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const played = await s.post(token, 'play', { id: 'Ranged1' })
  t.is(played.status, 200)
  t.alike(Object.keys(played.json).sort(), ['expiresAt', 'ticket'])
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(played.json.ticket))
  t.ok(Date.parse(played.json.expiresAt) > Date.now())
  const ticket = played.json.ticket

  const full = await s.audio(ticket)
  t.is(full.status, 200)
  t.ok(full.raw.equals(AUDIO), 'the whole body')
  t.is(full.headers['content-type'], 'audio/mpeg')
  t.is(full.headers['content-length'], '100')
  t.is(full.headers['accept-ranges'], 'bytes')
  t.is(full.headers['cache-control'], 'no-store')
  t.is(full.headers['x-content-type-options'], 'nosniff')
  t.is(full.headers['content-security-policy'], "default-src 'none'; sandbox")
  t.is(full.headers['referrer-policy'], 'no-referrer')
  t.absent(full.headers['set-cookie'], 'nothing else of the node is relayed')

  const part = await s.audio(ticket, { Range: 'bytes=10-19' })
  t.is(part.status, 206)
  t.ok(part.raw.equals(AUDIO.subarray(10, 20)))
  t.is(part.headers['content-range'], 'bytes 10-19/100')
  t.is(part.headers['content-length'], '10')
  t.absent(part.headers['x-node-secret'])

  const streamHop = s.api.seen.find((r) => r.path === '/v1/tracks/Ranged1/stream')
  t.is(streamHop.headers['x-api-key'], KEY, 'the key goes to the API host')
  t.ok(s.node.seen.length >= 2)
  for (const r of s.node.seen) {
    t.absent(r.headers['x-api-key'], 'no key header at the storage node')
    t.absent(JSON.stringify(r).includes(KEY), 'no key anywhere in the node request')
    t.absent(JSON.stringify(r).includes(ticket), 'no ticket at the node')
    t.ok(Object.keys(r.headers).every((h) => PROVIDER_HEADERS.includes(h) && h !== 'x-api-key'))
  }
  t.is(s.node.seen[1].headers.range, 'bytes=10-19', 'the Range is relayed')
  t.ok(s.logs.some((e) => e.reason === 'toque'))
  t.ok(s.logs.some((e) => e.reason === 'audio'))

  const post = await s.call('POST', '/account/audius/audio/' + ticket)
  t.is(post.status, 405)
  t.is(post.headers.allow, 'GET')

  const gated = await s.post(token, 'play', { id: 'Gated1' })
  t.is(gated.status, 404, 'a track that fails fromTrack gets no ticket')
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: a node that ignores Range gets a 206 built here, and a start past the end is 416', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Plain1')
  const part = await s.audio(ticket, { Range: 'bytes=10-19' })
  t.is(part.status, 206)
  t.ok(part.raw.equals(AUDIO.subarray(10, 20)))
  t.is(part.headers['content-range'], 'bytes 10-19/100')
  t.is(part.headers['content-length'], '10')
  t.ok(s.logs.some((e) => e.reason === 'sem-range'))

  const tail = await s.audio(ticket, { Range: 'bytes=90-' })
  t.is(tail.status, 206)
  t.ok(tail.raw.equals(AUDIO.subarray(90)))
  t.is(tail.headers['content-range'], 'bytes 90-99/100')

  const past = await s.audio(ticket, { Range: 'bytes=100-' })
  t.is(past.status, 416)
  t.is(past.headers['content-range'], 'bytes */100')

  const plain = await s.audio(ticket, { Range: 'items=1-2' })
  t.is(plain.status, 200, 'a Range that is not a byte range is ignored')
  t.ok(plain.raw.equals(AUDIO))

  const skew = await s.ticketFor(token, 'Skew1')
  t.is((await s.audio(skew, { Range: 'bytes=0-9' })).status, 503, 'a 206 that does not start at the asked byte is refused')
  t.is((await s.audio(skew)).status, 503, 'a 206 nobody asked for is refused')
})

test('audius: wrong, expired and retired tickets are 404', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  for (const bad of ['A'.repeat(43), 'short', 'A'.repeat(44), 'A'.repeat(42) + '=']) {
    const res = await s.audio(bad)
    t.is(res.status, 404, bad)
    t.is(res.json.error, 'nao-encontrado')
  }
  const ticket = await s.ticketFor(token, 'Plain1')
  t.is((await s.audio(ticket)).status, 200)
  t.is((await s.audio(ticket + 'x')).status, 404)
  s.clock.offset += TICKET_TTL_MS
  t.is((await s.audio(ticket)).status, 404, 'expired')
  s.clock.offset = 0

  const first = await s.ticketFor(token, 'Plain1')
  for (let i = 0; i < TICKETS_PER_MEMBER; i++) await s.ticketFor(token, 'Plain1')
  t.is((await s.audio(first)).status, 404, 'a ninth live ticket retires the oldest')
})

test('audius: a ticket dies once its member is blocked', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Plain1')
  t.is((await s.audio(ticket)).status, 200)
  s.blocked.add(s.memberHex)
  t.is((await s.audio(ticket)).status, 200, 'the standing is re-checked at most every minute')
  s.clock.offset += RECHECK_MS
  t.is((await s.audio(ticket)).status, 404, 'blocked')
  s.blocked.delete(s.memberHex)
  t.is((await s.audio(ticket)).status, 404, 'the ticket stays gone')
})

test('audius: a member blocked after the session check gets no ticket, and the play stays spent', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  s.blocked.add(s.memberHex)
  let wrong = 0
  for (let i = 0; i < PLAYS_PER_DAY; i++) {
    const res = await s.post(token, 'play', { id: 'Plain1' })
    if (res.status !== 404 || res.json.error !== 'nao-encontrado') wrong++
  }
  t.is(wrong, 0, 'every play is nao-encontrado while the session check is still fresh')
  t.is(s.routes.stats().tickets, 0, 'no ticket was stored')
  s.blocked.delete(s.memberHex)
  t.is((await s.post(token, 'play', { id: 'Plain1' })).status, 429, 'no refused play was given back')
})

test('audius: two streams per member and the operator cap in all', async (t) => {
  const s = await setup(t, { streams: 3 })
  const a = await s.login()
  const b = await s.login(s.other)
  const ta = await s.ticketFor(a.token, 'Hold1')
  const tb = await s.ticketFor(b.token, 'Hold1')
  const a1 = await s.hold('/account/audius/audio/' + ta)
  const a2 = await s.hold('/account/audius/audio/' + ta)
  t.is(a1.status, 200)
  t.is(a2.status, 200)
  const a3 = await s.audio(ta)
  t.is(a3.status, 503, 'a third stream of one member')
  t.is(a3.headers['retry-after'], '5')
  const b1 = await s.hold('/account/audius/audio/' + tb)
  t.is(b1.status, 200, 'another member still streams')
  const b2 = await s.audio(tb)
  t.is(b2.status, 503, 'the operator cap')
  t.is(b2.headers['retry-after'], '5')
  a1.close()
  t.ok(await s.until(() => s.routes.stats().streams === 2), 'a closed stream frees its slot')
  const b3 = await s.hold('/account/audius/audio/' + tb)
  t.is(b3.status, 200)
  a2.close()
  b1.close()
  b3.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0), 'the node sockets close too')
})

test('audius: a ticket and a member day are bounded in bytes', async (t) => {
  const s = await setup(t, { caps: { ticketBytes: 150 } })
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Big1')
  const cut = await s.audio(ticket)
  t.is(cut.status, 200)
  t.is(cut.raw.length, 150, 'cut at the ticket cap')
  t.absent(cut.complete)
  t.is((await s.audio(ticket)).status, 404, 'a spent ticket is gone')

  const d = await setup(t, { caps: { dailyBytes: 150 } })
  const login = await d.login()
  const first = await d.audio(await d.ticketFor(login.token, 'Plain1'))
  t.is(first.raw.length, 100)
  t.ok(first.complete)
  const second = await d.audio(await d.ticketFor(login.token, 'Plain1'))
  t.is(second.raw.length, 50, 'cut at what is left of the day')
  t.absent(second.complete)
  const third = await d.audio(await d.ticketFor(login.token, 'Plain1'))
  t.is(third.status, 429)
  t.is(third.json.error, 'limite-musica')
  d.clock.offset += 24 * 3600 * 1000
  const again = await d.login()
  const fresh = await d.ticketFor(again.token, 'Plain1')
  t.is((await d.audio(fresh)).raw.length, 100, 'a new day')
})

test('audius: a stalled node is cut', async (t) => {
  const s = await setup(t, { caps: { stallMs: 200 } })
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Hold1')
  const started = Date.now()
  const res = await s.audio(ticket)
  t.is(res.status, 200)
  t.is(res.raw.length, 5)
  t.absent(res.complete)
  t.ok(Date.now() - started < 5000, 'cut long before any test timeout')
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
})

test('audius: daily limits count, and a failed provider call gives the use back', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const url = 'https://audius.co/artista/musica'
  s.state.mode = 'garbage'
  for (let i = 0; i < 3; i++) t.is((await s.post(token, 'resolve', { url })).status, 503, 'a provider answer that is not JSON')
  s.state.mode = 'ok'
  for (let i = 0; i < RESOLVES_PER_DAY; i++) {
    const res = await s.post(token, 'resolve', { url })
    if (res.status !== 200) {
      t.fail('resolve ' + i + ' answered ' + res.status)
      return
    }
  }
  const seen = s.api.seen.length
  const over = await s.post(token, 'resolve', { url })
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-musica' })
  t.is(s.api.seen.length, seen, 'no provider call over the limit')
  const other = await s.login(s.other)
  t.is((await s.post(other.token, 'resolve', { url })).status, 200, 'per member')
  s.clock.offset += 24 * 3600 * 1000
  const later = await s.login()
  t.is((await s.post(later.token, 'resolve', { url })).status, 200, 'a new day')
})

test('audius: a non-audio type and a redirect to a private address are refused', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const html = await s.audio(await s.ticketFor(token, 'Html1'))
  t.is(html.status, 503)
  t.alike(html.json, { error: 'indisponivel' })
  t.absent(html.raw.toString().includes('script'))

  const priv = await s.audio(await s.ticketFor(token, 'Private1'))
  t.is(priv.status, 503)
  t.ok(s.looked.includes(PRIVATE), 'the name was looked up')
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  onlyLoopback(t, s)
  noKeyAnywhere(t, s)
})

test('audius: an interrupted seek on a node that ignores Range charges only what arrived', async (t) => {
  const s = await setup(t, { caps: { dailyBytes: 100 } })
  const { token } = await s.login()
  // Nothing was sent, so not even the headers left: the client sees a hang-up.
  let drop = null
  try {
    drop = await s.audio(await s.ticketFor(token, 'Drop1'), { Range: 'bytes=50-' })
  } catch (err) {
    t.is(err.code, 'ECONNRESET')
  }
  t.ok(drop === null || (drop.raw.length === 0 && !drop.complete), 'no audio byte reached the client')
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  const next = await s.audio(await s.ticketFor(token, 'Plain1'))
  t.is(next.raw.length, 70, 'the 30 bytes that arrived were charged, not the 50 of the planned skip')
})

test('audius: a provider 4xx about the id is nao-encontrado on a lookup by id, and any other error status indisponivel', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const cases = [
    ['500', 503, 'indisponivel'],
    ['503', 503, 'indisponivel'],
    ['429', 503, 'indisponivel'],
    ['403', 503, 'indisponivel'],
    ['404', 404, 'nao-encontrado'],
    ['410', 404, 'nao-encontrado'],
    ['400', 404, 'nao-encontrado']
  ]
  const ids = { 500: 'Err500', 503: 'Err503', 429: 'Err429', 403: 'Err403', 404: 'Missing1', 410: 'Gone410', 400: 'Err400' }
  for (const [code, status, error] of cases) {
    const item = await s.post(token, 'item', { kind: 'track', id: ids[code] })
    t.is(item.status, status, 'item ' + code)
    t.alike(item.json, { error })
    const play = await s.post(token, 'play', { id: ids[code] })
    t.is(play.status, status, 'play ' + code)
    t.alike(play.json, { error })
    const resolved = await s.post(token, 'resolve', { url: 'https://audius.co/artista/s' + code })
    t.is(resolved.status, status, 'resolve ' + code)
    t.alike(resolved.json, { error })
  }
})

test('audius: an outage or a refused key gives the use back, and a 4xx about the id does not', async (t) => {
  const routes = [
    ['item', ITEMS_PER_DAY, (id) => ({ kind: 'track', id }), 'Plain1'],
    ['play', PLAYS_PER_DAY, (id) => ({ id }), 'Plain1'],
    ['resolve', RESOLVES_PER_DAY, (id) => ({ url: 'https://audius.co/artista/' + id }), 'musica']
  ]
  const failing = {
    item: { 500: 'Err500', 429: 'Err429', 403: 'Err403', 404: 'Missing1', 410: 'Gone410', 400: 'Err400' },
    play: { 500: 'Err500', 429: 'Err429', 403: 'Err403', 404: 'Missing1', 410: 'Gone410', 400: 'Err400' },
    resolve: { 500: 's500', 429: 's429', 403: 's403', 404: 's404', 410: 's410', 400: 's400' }
  }
  for (const [name, limit, body, good] of routes) {
    // One member a code: PROVIDER_CALLS_PER_DAY is sized for the route
    // limits, not for several days of them.
    for (const code of ['500', '429', '403']) {
      const s = await setup(t)
      const { token } = await s.login()
      let wrong = 0
      for (let i = 0; i < limit; i++) {
        const res = await s.post(token, name, body(failing[name][code]))
        if (res.status !== 503 || res.json.error !== 'indisponivel') wrong++
      }
      t.is(wrong, 0, name + ' ' + code + ' answered 503 indisponivel every time')
      t.is((await s.post(token, name, body(good))).status, 200, name + ' ' + code + ': every use was given back')
    }

    const n = await setup(t)
    const fresh = await n.login()
    let wrong = 0
    const codes = ['404', '410', '400']
    for (let i = 0; i < limit; i++) {
      const res = await n.post(fresh.token, name, body(failing[name][codes[i % 3]]))
      if (res.status !== 404 || res.json.error !== 'nao-encontrado') wrong++
    }
    t.is(wrong, 0, name + ': 404, 410 and 400 are nao-encontrado')
    const over = await n.post(fresh.token, name, body(good))
    t.is(over.status, 429, name + ': a 4xx about the id is not given back')
  }
})

test('audius: a search the provider refuses with a 4xx is indisponivel and not given back, a refused key is given back', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  let wrong = 0
  for (let i = 0; i < SEARCHES_PER_DAY; i++) {
    const res = await s.post(token, 'search', { q: 'erro400', kind: 'track' })
    if (res.status !== 503 || res.json.error !== 'indisponivel') wrong++
  }
  t.is(wrong, 0, 'a 400 is indisponivel')
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 429, 'and was not given back')

  const k = await setup(t)
  const own = await k.login()
  wrong = 0
  for (let i = 0; i < SEARCHES_PER_DAY; i++) {
    if ((await k.post(own.token, 'search', { q: 'erro403', kind: 'track' })).status !== 503) wrong++
  }
  t.is(wrong, 0, 'a 403 is indisponivel')
  t.is((await k.post(own.token, 'search', { q: QUERY, kind: 'track' })).status, 200, 'and was given back')
})

test('audius: a member looping a failing lookup is stopped by its provider allowance, and other members still get answers', async (t) => {
  for (const [id, code, first] of [['Err400', 400, 404], ['Err503', 503, 503]]) {
    // Without the allowance this member alone would spend the shared budget.
    const s = await setup(t, { caps: { calls: 5, budget: 8 } })
    const { token } = await s.login()
    const statuses = []
    let refusal = null
    for (let i = 0; i < 20; i++) {
      const res = await s.post(token, 'item', { kind: 'track', id })
      statuses.push(res.status)
      if (res.status === 429) refusal = res.json
    }
    t.is(s.api.seen.filter((r) => r.path === '/v1/tracks/' + id).length, 5, code + ': the provider was asked only within the allowance')
    t.alike(statuses, [...Array(5).fill(first), ...Array(15).fill(429)], code + ': then limite-musica')
    t.alike(refusal, { error: 'limite-musica' })
    const other = await s.login(s.other)
    t.is((await s.post(other.token, 'item', { kind: 'track', id: 'Plain1' })).status, 200, code + ': another member still gets answers')
    t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 429, code + ': the allowance covers every route')
  }
})

test('audius: a playlist item spends two provider calls of the allowance', async (t) => {
  const s = await setup(t, { caps: { calls: 3 } })
  const { token } = await s.login()
  t.is((await s.post(token, 'item', { kind: 'playlist', id: 'Pl1' })).status, 200, 'two calls')
  const over = await s.post(token, 'item', { kind: 'playlist', id: 'Pl2' })
  t.is(over.status, 429, 'the second call of the next playlist is over the allowance')
  t.alike(over.json, { error: 'limite-musica' })
  t.is(s.api.seen.length, 3, 'only the first call of it reached the provider')
  t.is((await s.post(token, 'item', { kind: 'playlist', id: 'Pl1' })).status, 200, 'a cached playlist spends nothing')
})

test('audius: a call refused while the provider is busy does not spend the allowance', async (t) => {
  const s = await setup(t, { caps: { calls: 17 } })
  const { token } = await s.login()
  const held = []
  for (let i = 0; i < 16; i++) held.push(s.post(token, 'item', { kind: 'track', id: 'Slow' + i }))
  t.ok(await s.until(() => s.routes.stats().inflight === 16 && s.state.slow.length === 16), 'sixteen calls in flight')
  const busy = await s.post(token, 'item', { kind: 'track', id: 'Plain1' })
  t.is(busy.status, 503, 'lotado')
  t.alike(busy.json, { error: 'indisponivel' })
  for (const { id, res } of s.state.slow) json(res, 200, { data: track(id) })
  for (const res of await Promise.all(held)) t.is(res.status, 200)
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Plain1' })).status, 200, 'the refused call left its unit')
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Plain2' })).status, 429, 'and the allowance still holds')
})

test('audius: an upstream 416 is relayed as 416, with its Content-Range only when well formed', async (t) => {
  const s = await setup(t, { caps: { dailyBytes: 100 } })
  const { token } = await s.login()
  const far = await s.audio(await s.ticketFor(token, 'Far1'), { Range: 'bytes=500-' })
  t.is(far.status, 416)
  t.is(far.headers['content-range'], 'bytes */100')
  t.is(far.headers['content-length'], '0')
  t.is(far.headers['cache-control'], 'no-store')
  t.is(far.headers['x-content-type-options'], 'nosniff')
  t.is(far.headers['content-security-policy'], "default-src 'none'; sandbox")
  t.is(far.headers['referrer-policy'], 'no-referrer')
  t.is(far.raw.length, 0)
  for (const id of ['FarBad1', 'FarNone1']) {
    const res = await s.audio(await s.ticketFor(token, id), { Range: 'bytes=500-' })
    t.is(res.status, 416, id)
    t.is(res.headers['content-range'], undefined, id + ': no Content-Range relayed')
    t.is(res.raw.length, 0)
  }
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  const full = await s.audio(await s.ticketFor(token, 'Plain1'))
  t.is(full.raw.length, 100, 'nothing was charged')
})

test('audius: a 206 past the asked end is clamped to the asked range', async (t) => {
  const s = await setup(t, { caps: { dailyBytes: 100 } })
  const { token } = await s.login()
  const one = await s.audio(await s.ticketFor(token, 'Whole1'), { Range: 'bytes=0-0' })
  t.is(one.status, 206)
  t.is(one.headers['content-range'], 'bytes 0-0/100')
  t.is(one.headers['content-length'], '1')
  t.alike(one.raw, AUDIO.subarray(0, 1))
  t.ok(one.complete, 'the clamped body is complete')
  const liar = await s.audio(await s.ticketFor(token, 'Liar1'), { Range: 'bytes=0-0' })
  t.is(liar.status, 503, 'a Content-Range and Content-Length that disagree are refused')
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  const next = await s.audio(await s.ticketFor(token, 'Plain1'))
  t.is(next.raw.length, 99, 'one byte was charged')
})

test('audius: audio opens are counted per member and per ticket before the budget is spent', async (t) => {
  const streamHops = (s) => s.api.seen.filter((r) => r.path.endsWith('/stream')).length
  const s = await setup(t, { caps: { opens: 5 } })
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Plain1')
  for (let i = 0; i < 5; i++) t.is((await s.audio(ticket, { Range: 'bytes=100-' })).status, 416, 'open ' + i)
  const over = await s.audio(ticket, { Range: 'bytes=100-' })
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-musica' })
  t.is((await s.audio(await s.ticketFor(token, 'Plain1'))).status, 429, 'per member, not per ticket')
  t.is(streamHops(s), 5, 'the budget was spent once per counted open')

  const p = await setup(t)
  const own = await p.login()
  const far = await p.ticketFor(own.token, 'Far1')
  let wrong = 0
  for (let i = 0; i < OPENS_PER_TICKET; i++) if ((await p.audio(far, { Range: 'bytes=500-' })).status !== 416) wrong++
  t.is(wrong, 0, 'every open up to the ticket limit reached the provider')
  const spent = await p.audio(far, { Range: 'bytes=500-' })
  t.is(spent.status, 404)
  t.alike(spent.json, { error: 'nao-encontrado' })
  t.is((await p.audio(far)).status, 404, 'the ticket is retired')
  t.is(streamHops(p), OPENS_PER_TICKET, 'no provider call past the ticket limit')
  t.is((await p.audio(await p.ticketFor(own.token, 'Plain1'))).status, 200, 'a new ticket still plays')
})

test('audius: a backward clock step keeps the bytes counted that day', async (t) => {
  const s = await setup(t, { caps: { dailyBytes: 150 } })
  const { token } = await s.login()
  const first = await s.ticketFor(token, 'Plain1')
  const second = await s.ticketFor(token, 'Plain1')
  t.is((await s.audio(first)).raw.length, 100)
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  s.clock.offset -= 60 * 1000
  const after = await s.audio(second)
  t.is(after.raw.length, 50, 'what is left of the day')
})

test('audius: a lookup answered with another id is nao-encontrado, issues no ticket and caches nothing', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const asked = (path) => s.api.seen.filter((r) => r.path === path).length

  for (let round = 1; round <= 2; round++) {
    const item = await s.post(token, 'item', { kind: 'track', id: 'Swap1' })
    t.is(item.status, 404, 'item, round ' + round)
    t.alike(item.json, { error: 'nao-encontrado' })
    const play = await s.post(token, 'play', { id: 'Swap1' })
    t.is(play.status, 404, 'play, round ' + round)
    t.alike(play.json, { error: 'nao-encontrado' }, 'no ticket')
    t.is(asked('/v1/tracks/Swap1'), round * 2, 'every request reached the provider')
  }

  for (let round = 1; round <= 2; round++) {
    const list = await s.post(token, 'item', { kind: 'playlist', id: 'SwapPl1' })
    t.is(list.status, 404, 'playlist, round ' + round)
    t.alike(list.json, { error: 'nao-encontrado' })
    t.is(asked('/v1/playlists/SwapPl1'), round, 'every playlist request reached the provider')
  }
  t.is(asked('/v1/playlists/SwapPl1/tracks'), 0, 'the tracks of a wrong playlist are not fetched')

  // The track the provider swapped in was not cached under its own id either.
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Other1' })).status, 200)
  t.is(asked('/v1/tracks/Other1'), 1, 'Other1 came from the provider, not the cache')
})

test('audius: a member blocked while audio is relayed is cut within a re-check and loses the ticket', async (t) => {
  const s = await setup(t, { caps: { recheckMs: 100, totalMs: 3000 } })
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Hold1')
  const pending = s.audio(ticket)
  t.ok(await s.until(() => s.routes.stats().streams === 1 && s.node.held.size === 1), 'the relay runs')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const blockedAt = Date.now()
  s.blocked.add(s.memberHex)
  const res = await pending
  t.is(res.status, 200)
  t.is(res.raw.length, 5, 'what was relayed arrived')
  t.absent(res.complete, 'cut, never ended')
  t.ok(Date.now() - blockedAt < 2000, 'cut long before the total deadline: ' + (Date.now() - blockedAt) + ' ms')
  t.is(s.routes.stats().tickets, 0, 'the ticket is gone')
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0), 'the node socket closes too')
  s.blocked.delete(s.memberHex)
  t.is((await s.audio(ticket)).status, 404, 'the ticket stays gone')

  // A member in good standing keeps a relay that outlives several re-checks.
  const g = await setup(t, { caps: { recheckMs: 50, stallMs: 2000 } })
  const own = await g.login()
  const live = g.hold('/account/audius/audio/' + await g.ticketFor(own.token, 'Hold1'))
  const open = await live
  t.is(open.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(g.routes.stats().streams, 1, 'still relaying after six re-checks')
  t.is(g.routes.stats().tickets, 1)
  open.close()
  t.ok(await g.until(() => g.routes.stats().streams === 0))
})
