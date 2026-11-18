'use strict'

// apps/cli/lib/account/audius-routes.js behind a minimal HTTP harness (the
// account server mounts it separately), against two loopback fixtures: a
// fake Audius API and a storage node the stream redirects to. Both are plain
// HTTP on 127.0.0.1, reached through an injected request (each name mapped
// to its fixture's port), lookup and address allowlist: no socket leaves
// loopback, and every connection made is recorded and checked. The request
// also records what the guarded lookup let through and refuses any address
// but 127.0.0.1 itself, so a broken guard fails a test without a real dial.

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
  TICKETS_PER_MEMBER,
  PROVIDER_PER_DAY,
  MEMBER_BUDGET_PER_DAY,
  PROVIDER_CALLS_PER_DAY,
  ARTS_PER_DAY,
  TRENDINGS_PER_DAY,
  TRENDING_ASK,
  TRENDING_RETRY_MS,
  ART_MAX_BYTES,
  MAX_ART_CACHED,
  MAX_ART_INFLIGHT,
  ART_PER_MEMBER,
  ART_RETRY_MS,
  ART_ANSWER_MS,
  UPSTREAM_REUSE_MS,
  STORED_CONNECT_MS,
  DEADLINE_MS
} = require('../lib/account/audius-routes')

const KEY = 'chave-sentinela-audius-42'
const QUERY = 'samba-sentinela'
const API = 'api.audius.test'
const NODE = 'node.audius.test'
const PRIVATE = 'private.audius.test'
// A storage name whose address the test can move (s.dns.moved).
const MOVED = 'moved.audius.test'
const ART = 'art.audius.test'
const CACHE_TTL_MS = 10 * 60 * 1000
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20, 3)])
const ART_HEADERS = ['host', 'connection', 'user-agent', 'accept']
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
    artwork: { '150x150': 'https://' + ART + '/' + id },
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
    artwork: { '150x150': 'https://' + ART + '/' + id },
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
const jsonAnswer = json

// Track ids the fake API answers with an error status.
const ERRORS = { Err500: 500, Err503: 503, Err429: 429, Err403: 403, Err400: 400, Gone410: 410 }

function fakeApi (state) {
  // state.artwork[id], when set, replaces that item's artwork (undefined: none).
  // state.large adds a 480x480 artwork beside any other item's 150x150, and
  // state.info a genre and a release date to every item; state.fields[id]
  // adds its own fields to that item. state.storage[id] names the host the
  // stream of that track redirects to (NODE by default); Signed1's redirect
  // carries a new ?sig= on every walk, as a presigned URL would, and Long1's
  // a query that makes the URL longer than the service keeps. The trending
  // list answers state.trendingStatus when set, holds the request in
  // state.trendingHeld while state.trendingHold is set, and answers
  // state.trendingData when set.
  const withArt = (item) => {
    if (item === null || typeof item !== 'object') return item
    let out = item
    if (Object.hasOwn(state.artwork, item.id)) out = { ...out, artwork: state.artwork[item.id] }
    else if (state.large && out.artwork && typeof out.artwork['150x150'] === 'string') out = { ...out, artwork: { ...out.artwork, '480x480': out.artwork['150x150'] + 'L' } }
    if (state.info) out = { genre: 'Samba', release_date: '2001-02-03', ...out }
    if (Object.hasOwn(state.fields, item.id)) out = { ...out, ...state.fields[item.id] }
    return out
  }
  const json = (res, status, body) => {
    if (status === 200 && body && body.data !== undefined) body = { ...body, data: Array.isArray(body.data) ? body.data.map(withArt) : withArt(body.data) }
    jsonAnswer(res, status, body)
  }
  return fixture(API, (url, req, res) => {
    const p = url.pathname
    if (state.mode === 'garbage') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html></html>')
    }
    if (p === '/v1/tracks/search') {
      if (url.searchParams.get('query') === 'faixas') return json(res, 200, { data: [track('Pt0')] })
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
    if (p === '/v1/tracks/trending') {
      if (state.trendingHold) return state.trendingHeld.push(res)
      if (state.trendingStatus) return json(res, state.trendingStatus, { error: 'erro' })
      if (state.trendingData) return json(res, 200, { data: state.trendingData })
      return json(res, 200, { data: trendingData() })
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
      if (id === 'Direct1') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length })
        return res.end(AUDIO)
      }
      let location = id === 'Private1' ? 'https://' + PRIVATE + '/audio/x' : 'https://' + (state.storage[id] ?? NODE) + '/audio/' + id
      if (id === 'Signed1') location += '?sig=' + (++state.signed)
      if (id === 'Long1') location += '?p=' + 'x'.repeat(2100)
      res.writeHead(302, { Location: location })
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
      if (id === 'NoArt1') return json(res, 200, { data: track(id, { artwork: undefined }) })
      if (id === 'BadArt1') return json(res, 200, { data: track(id, { artwork: { '150x150': 'http://' + ART + '/ArtJpg1' } }) })
      if (id === 'PrivArt1') return json(res, 200, { data: track(id, { artwork: { '150x150': 'https://' + PRIVATE + '/x' } }) })
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

// Two pages of the week's list: the dropped kinds and a duplicate of Hot1
// among them, and more admitted tracks than one page holds.
function trendingData () {
  const data = [
    track('Hot1'),
    track('HotGated1', { is_stream_gated: true }),
    track('HotUnlisted1', { is_unlisted: true }),
    track('bad id'),
    track('HotNoUser1', { user: null }),
    track('Hot1', { title: 'Repetida' })
  ]
  while (data.length < 24) data.push(track('Hot' + data.length))
  return data
}

// `answers` maps a path and query to the { status, headers, body } the node
// gives it instead, as for an expired presigned URL, or to { hang: true }
// for a request held in `waiting` until the test answers it.
function fakeNode () {
  const held = new Set()
  const answers = new Map()
  const node = fixture(NODE, (url, req, res) => {
    const id = url.pathname.slice('/audio/'.length)
    const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d+)-(\d*)$/) : null
    const answer = answers.get(url.pathname + url.search)
    if (answer !== undefined && answer.hang === true) return waiting.push(res)
    if (answer !== undefined) {
      res.writeHead(answer.status, answer.headers)
      return res.end(answer.body ?? '')
    }
    if (id === 'Ranged1' || id === 'Signed1' || id === 'Moved1' || id === 'Long1') {
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
    if (id === 'Hold1' || id === 'Hold2') {
      // Sends 5 bytes (Hold2: 2) and holds the rest.
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      held.add(res)
      res.on('close', () => held.delete(res))
      return res.write(Buffer.alloc(id === 'Hold1' ? 5 : 2, 2))
    }
    // Answers nothing until the test does, to keep an open pending.
    if (id === 'Wait1') return waiting.push(res)
    res.writeHead(404)
    res.end()
  })
  const waiting = []
  node.held = held
  node.answers = answers
  node.waiting = waiting
  return node
}

// The art host: a JPEG for any path but the names below.
function fakeArt () {
  const held = new Set()
  const hold = (res) => {
    held.add(res)
    res.on('close', () => held.delete(res))
  }
  const art = fixture(ART, (url, req, res) => {
    const name = url.pathname.slice(1)
    const image = (type, body) => {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Set-Cookie': 'art=1' })
      res.end(body)
    }
    const redirect = (location) => {
      res.writeHead(302, { Location: location })
      res.end()
    }
    if (name === 'ArtPng1') return image('text/plain', PNG)
    if (name === 'ArtWebp1') return image('image/webp', WEBP)
    if (name === 'ArtGif1') return image('image/gif', Buffer.from('GIF89a' + 'x'.repeat(20)))
    if (name === 'ArtHtml1') return image('image/jpeg', Buffer.from('<svg onload=alert(1)>'))
    if (name === 'ArtWave1') return image('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)]))
    if (name === 'ArtEmpty1') return image('image/jpeg', Buffer.alloc(0))
    if (name === 'ArtExact1') return image('image/jpeg', Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(ART_MAX_BYTES - 4, 9)]))
    if (name === 'ArtBig1') return image('image/jpeg', Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(ART_MAX_BYTES - 3, 9)]))
    if (name === 'ArtGone1') return json(res, 404, {})
    if (name === 'ArtBusy1') return json(res, 429, {})
    if (name === 'ArtErr1') return json(res, 500, {})
    if (name === 'ArtHop1') return redirect('https://' + ART + '/ArtJpg1')
    if (name === 'ArtHop2') return redirect('/ArtHop1')
    if (name === 'ArtLoop1') return redirect('/ArtLoop1')
    if (name === 'ArtPrivate1') return redirect('https://' + PRIVATE + '/x.jpg')
    if (name === 'ArtHttp1') return redirect('http://' + ART + '/ArtJpg1')
    if (name === 'ArtPort1') return redirect('https://' + ART + ':8443/ArtJpg1')
    if (name === 'ArtPartial1') {
      res.writeHead(206, { 'Content-Type': 'image/jpeg', 'Content-Range': 'bytes 0-63/64', 'Content-Length': JPEG.length })
      return res.end(JPEG)
    }
    if (name === 'ArtSlow1') return setTimeout(() => image('image/jpeg', JPEG), 200)
    if (name === 'ArtSlowErr1') return setTimeout(() => json(res, 500, {}), 200)
    if (name === 'ArtSlowGone1') return setTimeout(() => json(res, 404, {}), 250)
    if (name === 'ArtSlowGone2') return setTimeout(() => json(res, 404, {}), 1000)
    if (/^ArtHang\d+$/.test(name)) return hold(res)
    if (name === 'ArtStall1') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length })
      res.write(JPEG.subarray(0, 4))
      return hold(res)
    }
    image('image/jpeg', JPEG)
  })
  art.held = held
  return art
}

async function setup (t, { audius = true, moments = false, covers = false, streams = 16, caps = {}, accepted = true, timers = null } = {}) {
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const state = { mode: 'ok', slow: [], artwork: {}, fields: {}, large: false, info: false, storage: {}, signed: 0, trendingStatus: 0, trendingHold: false, trendingHeld: [], trendingData: null }
  const dns = { moved: '127.0.0.1' }
  const api = fakeApi(state)
  const node = fakeNode()
  const art = fakeArt()
  await api.listen()
  await node.listen()
  await art.listen()
  const ports = { [API]: api.port, [NODE]: node.port, [ART]: art.port, [MOVED]: node.port }
  const looked = []
  const connected = []
  // { host, addresses } for what the guarded lookup let through, or
  // { host, refused } with its error code.
  const dials = []
  const transport = {
    request: (opts) => {
      const guarded = opts.lookup
      const lookup = (host, o, cb) => {
        if (typeof o === 'function') {
          cb = o
          o = {}
        }
        guarded(host, o, (err, address, family) => {
          if (err) {
            dials.push({ host, refused: err.code })
            return cb(err)
          }
          const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address]
          dials.push({ host, addresses })
          if (addresses.some((a) => a !== '127.0.0.1')) {
            const refused = new Error('ETEST')
            refused.code = 'ETEST'
            return cb(refused)
          }
          cb(null, address, family)
        })
      }
      const req = http.request({ ...opts, lookup, port: ports[opts.hostname] })
      req.on('socket', (s) => s.once('connect', () => connected.push(s.remoteAddress)))
      return req
    },
    lookup: (host, opts, cb) => {
      looked.push(host)
      if (host === API || host === NODE || host === ART) return cb(null, [{ address: '127.0.0.1', family: 4 }])
      if (host === PRIVATE) return cb(null, [{ address: '10.0.0.7', family: 4 }])
      if (host === MOVED) return cb(null, [{ address: dns.moved, family: 4 }])
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
  const config = audius ? parseAudiusConfig({ apiKey: KEY, apiUrl: 'https://' + API + '/v1', moments, covers, streams }) : null
  const timerFns = timers === null ? {} : { setTimer: timers.set, clearTimer: timers.clear }
  const routes = createAudiusRoutes({ ...transport, ...timerFns, config, store, terms, blocklist, association, log: (e) => logs.push(e), now, caps, http: harness })

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
    for (const r of art.held) r.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await api.close()
    await node.close()
    await art.close()
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

  // An audio request left open once its headers arrived: `received` counts
  // its body bytes so far, and `ended` resolves on its end or cut with
  // `complete` false for a cut body.
  function hold (path) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, agent: false }, (res) => {
        const held = { status: res.statusCode, headers: res.headers, received: 0, close: () => req.destroy() }
        held.ended = new Promise((resolve) => {
          res.on('end', () => resolve({ complete: res.complete }))
          res.on('close', () => resolve({ complete: res.complete }))
        })
        res.on('error', () => {})
        res.on('data', (c) => { held.received += c.length })
        resolve(held)
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

  return { routes, call, post, audio, hold, login, ticketFor, until, api, node, art, state, dns, logs, responses, looked, connected, dials, clock, linked, blocked, member, other, memberHex, otherHex }
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
  const ta2 = await s.ticketFor(a.token, 'Hold1')
  const ta3 = await s.ticketFor(a.token, 'Hold1')
  const tb = await s.ticketFor(b.token, 'Hold1')
  const a1 = await s.hold('/account/audius/audio/' + ta)
  const a2 = await s.hold('/account/audius/audio/' + ta2)
  t.is(a1.status, 200)
  t.is(a2.status, 200)
  const a3 = await s.audio(ta3)
  t.is(a3.status, 503, 'a third stream of one member, one relay on each of two other tickets')
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

const audioPath = (ticket) => '/account/audius/audio/' + ticket
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

// Resolves `held.ended` into a flag the test can read while it runs.
function watchEnd (held) {
  const w = { ended: false }
  held.ended.then(() => { w.ended = true })
  return w
}

test('audius: a third open of a ticket replaces its oldest relay, cut unended and charged', async (t) => {
  // 15 bytes a day: three relays of Hold1 send 5 each.
  const s = await setup(t, { caps: { dailyBytes: 15 } })
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Hold1')
  const a1 = await s.hold(audioPath(ticket))
  t.ok(await s.until(() => a1.received === 5))
  const a2 = await s.hold(audioPath(ticket))
  t.ok(await s.until(() => a2.received === 5))
  const w2 = watchEnd(a2)
  const a3 = await s.hold(audioPath(ticket))
  t.is(a3.status, 200, 'the third open of the ticket succeeds')
  const cut = await a1.ended
  t.absent(cut.complete, 'the oldest relay is cut without a terminating chunk')
  t.ok(await s.until(() => a3.received === 5))
  t.ok(await s.until(() => s.node.held.size === 2), 'its node socket closes')
  t.absent(w2.ended, 'the newer relay of the ticket keeps running')
  t.is(s.routes.stats().streams, 2)
  a2.close()
  a3.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
  const over = await s.hold(audioPath(ticket))
  over.close()
  t.is(over.status, 429, 'the cut relay was charged its 5 bytes: the 15 of the day are spent')
})

test('audius: at the member cap with one relay on each of two tickets, an open on a third is 503 and counts no open', async (t) => {
  const s = await setup(t, { caps: { opens: 3 } })
  const { token } = await s.login()
  const t1 = await s.ticketFor(token, 'Hold1')
  const t2 = await s.ticketFor(token, 'Hold1')
  const t3 = await s.ticketFor(token, 'Hold1')
  const a1 = await s.hold(audioPath(t1))
  const a2 = await s.hold(audioPath(t2))
  const w1 = watchEnd(a1)
  const w2 = watchEnd(a2)
  const contacts = s.api.seen.length + s.node.seen.length
  for (let i = 0; i < 3; i++) {
    const busy = await s.audio(t3)
    t.is(busy.status, 503)
    t.is(busy.headers['retry-after'], '5')
    t.alike(busy.json, { error: 'indisponivel' })
  }
  t.is(s.routes.stats().streams, 2, 'nobody was cut')
  t.is(s.api.seen.length + s.node.seen.length, contacts, 'nothing was contacted')
  await settle()
  t.absent(w1.ended)
  t.absent(w2.ended)
  a1.close()
  t.ok(await s.until(() => s.routes.stats().streams === 1))
  const a3 = await s.hold(audioPath(t3))
  t.is(a3.status, 200, 'the third open of the day: the refused ones counted none')
  const w3 = watchEnd(a3)
  const over = await s.audio(t3)
  t.is(over.status, 429, 'a fourth open is over the day')
  await settle()
  t.absent(w3.ended, 'an open refused over the day cuts nobody')
  t.is(s.routes.stats().streams, 2)
  a2.close()
  a3.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
})

test('audius: an open on another ticket replaces the older relay of a ticket that holds two', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ta = await s.ticketFor(token, 'Hold1')
  const tb = await s.ticketFor(token, 'Hold1')
  const a1 = await s.hold(audioPath(ta))
  t.ok(await s.until(() => a1.received === 5))
  const a2 = await s.hold(audioPath(ta))
  t.ok(await s.until(() => a2.received === 5))
  const w2 = watchEnd(a2)
  const b1 = await s.hold(audioPath(tb))
  t.is(b1.status, 200, 'the next ticket opens at the member cap')
  t.absent((await a1.ended).complete, 'the older relay of the ticket that held two is cut unended')
  t.ok(await s.until(() => b1.received === 5))
  t.ok(await s.until(() => s.node.held.size === 2))
  t.absent(w2.ended, 'its newer relay keeps running')
  t.is(s.routes.stats().streams, 2)
  a2.close()
  b1.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
})

test('audius: the operator cap answers 503 before any relay is replaced', async (t) => {
  const s = await setup(t, { streams: 2 })
  const a = await s.login()
  const b = await s.login(s.other)
  const ta = await s.ticketFor(a.token, 'Hold1')
  const tb = await s.ticketFor(b.token, 'Hold1')
  const a1 = await s.hold(audioPath(ta))
  const a2 = await s.hold(audioPath(ta))
  t.ok(await s.until(() => a1.received === 5 && a2.received === 5))
  const w1 = watchEnd(a1)
  const w2 = watchEnd(a2)
  const own = await s.audio(ta)
  t.is(own.status, 503, 'the member would replace a relay, but the operator cap is full')
  t.is(own.headers['retry-after'], '5')
  const other = await s.audio(tb)
  t.is(other.status, 503)
  t.is(other.headers['retry-after'], '5')
  t.is(s.routes.stats().streams, 2, 'nobody was cut')
  await settle()
  t.absent(w1.ended)
  t.absent(w2.ended)
  t.is(s.node.held.size, 2)
  a1.close()
  a2.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
})

test('audius: a pending open is never replaced, so it keeps its slot and no extra upstream open starts', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Wait1')
  const first = s.audio(ticket)
  t.ok(await s.until(() => s.node.waiting.length === 1))
  const second = s.audio(ticket)
  t.ok(await s.until(() => s.node.waiting.length === 2))
  t.is(s.routes.stats().streams, 2, 'both pending opens hold a slot')
  const third = await s.audio(ticket)
  t.is(third.status, 503, 'only pending opens at the cap: refused')
  t.alike(third.json, { error: 'indisponivel' })
  await settle()
  t.is(s.node.waiting.length, 2, 'the refused open started no upstream request')
  t.is(s.routes.stats().streams, 2)
  for (const res of s.node.waiting) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length })
    res.end(AUDIO)
  }
  const [a, b] = await Promise.all([first, second])
  t.is(a.status, 200)
  t.ok(a.raw.equals(AUDIO))
  t.is(b.status, 200)
  t.ok(b.raw.equals(AUDIO))
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  await settle()
  t.is(s.routes.stats().streams, 0, 'no slot was given back twice')

  // The member holds no stale relay: two opens on two tickets fit, a third
  // ticket is refused.
  const h1 = await s.ticketFor(token, 'Hold1')
  const h2 = await s.ticketFor(token, 'Hold1')
  const h3 = await s.ticketFor(token, 'Hold1')
  const r1 = await s.hold(audioPath(h1))
  const r2 = await s.hold(audioPath(h2))
  t.is(r1.status, 200)
  t.is(r2.status, 200)
  const busy = await s.audio(h3)
  t.is(busy.status, 503)
  t.is(busy.headers['retry-after'], '5')
  r1.close()
  r2.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
})

test('audius: an open that replaces a relay gets no room the replaced relay already took', async (t) => {
  // Hold1 sends 5 bytes and holds. Two relays may each start from the same
  // remainder (7), but a third that replaces the first has 7 - 5 left.
  for (const caps of [{ dailyBytes: 7 }, { ticketBytes: 7 }]) {
    const label = Object.keys(caps)[0]
    const s = await setup(t, { caps })
    const { token } = await s.login()
    const ticket = await s.ticketFor(token, 'Hold1')
    const a1 = await s.hold(audioPath(ticket))
    t.ok(await s.until(() => a1.received === 5))
    const a2 = await s.hold(audioPath(ticket))
    t.ok(await s.until(() => a2.received === 5))
    const a3 = await s.hold(audioPath(ticket))
    const w3 = watchEnd(a3)
    t.is(a3.status, 200, label + ': the replacing open is admitted')
    t.absent((await a1.ended).complete, label + ': the oldest relay was replaced')
    t.ok(await s.until(() => a3.received >= 2))
    await settle()
    t.is(a3.received, 2, label + ': only what the replaced relay had not taken')
    t.ok(await s.until(() => w3.ended), label + ': cut at that room')
    a2.close()
    a3.close()
    t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
  }

  // The replaced relay took more than the day has left (9 - 5 charged): the
  // open is refused for the limit and cuts nobody.
  const s = await setup(t, { caps: { dailyBytes: 9 } })
  const { token } = await s.login()
  const five = await s.ticketFor(token, 'Hold1')
  const two = await s.ticketFor(token, 'Hold2')
  const v = await s.hold(audioPath(five))
  t.ok(await s.until(() => v.received === 5))
  const w = await s.hold(audioPath(five))
  t.ok(await s.until(() => w.received === 5))
  w.close()
  t.ok(await s.until(() => s.routes.stats().streams === 1), 'its 5 bytes are charged: 4 left of the day')
  const x = await s.hold(audioPath(two))
  t.ok(await s.until(() => x.received === 2))
  const wv = watchEnd(v)
  const wx = watchEnd(x)
  const over = await s.audio(five)
  t.is(over.status, 429, 'the 4 left are fewer than the 5 the relay it would replace took')
  t.alike(over.json, { error: 'limite-musica' })
  await settle()
  t.absent(wv.ended, 'nobody was cut')
  t.absent(wx.ended)
  t.is(s.routes.stats().streams, 2)
  v.close()
  x.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
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
  t.is(streamHops(s), 1, 'the first open walked, the later ones asked the kept storage URL')
  t.is(s.node.seen.length, 5, 'one upstream open per counted open, walked or direct')

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

// --- kept storage URLs ------------------------------------------------------

const streamHops = (s) => s.api.seen.filter((r) => r.path.endsWith('/stream')).length

test('audius: a later open of a ticket asks the storage URL its walk ended on, with the Range and without the key', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Ranged1')
  const first = await s.audio(ticket)
  t.is(first.status, 200)
  t.ok(first.raw.equals(AUDIO))
  t.is(streamHops(s), 1)
  const asked = s.api.seen.length

  const part = await s.audio(ticket, { Range: 'bytes=10-19' })
  t.is(part.status, 206)
  t.ok(part.raw.equals(AUDIO.subarray(10, 20)))
  t.is(part.headers['content-range'], 'bytes 10-19/100')
  t.is(part.headers['content-length'], '10')
  t.absent(part.headers['x-node-secret'])
  t.is(s.api.seen.length, asked, 'the API host was not asked again')
  t.is(s.node.seen.length, 2)
  const direct = s.node.seen[1]
  t.is(direct.path, '/audio/Ranged1')
  t.is(direct.headers.range, 'bytes=10-19', 'the Range reaches the storage URL')
  t.absent(direct.headers['x-api-key'], 'no key at the kept storage URL')
  t.ok(Object.keys(direct.headers).every((h) => PROVIDER_HEADERS.includes(h) && h !== 'x-api-key'))
  t.absent(JSON.stringify(direct).includes(KEY))
  t.absent(JSON.stringify(direct).includes(ticket))

  const other = await s.ticketFor(token, 'Ranged1')
  t.is((await s.audio(other)).status, 200)
  t.is(streamHops(s), 2, 'another ticket of the same track walks: the URL is kept per ticket')

  for (const r of s.responses) {
    t.absent(r.raw.toString('latin1').includes(NODE), 'no storage URL in a body')
    t.absent(JSON.stringify(r.headers).includes(NODE), 'no storage URL in a header')
  }
  t.absent(JSON.stringify(s.logs).includes(NODE), 'no storage URL in a log line')
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: a kept storage URL that fails falls back to the walk in the same request', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const cases = [
    ['403', { status: 403, headers: { 'Content-Type': 'application/xml' }, body: '<Error>expired</Error>' }],
    ['a redirect', { status: 302, headers: { Location: 'https://' + NODE + '/audio/Ranged1' } }],
    ['another type', { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<script>alert(1)</script>' }]
  ]
  for (const [label, answer] of cases) {
    const ticket = await s.ticketFor(token, 'Signed1')
    t.is((await s.audio(ticket)).status, 200, label + ': the first open walks')
    const kept = s.node.seen.at(-1)
    s.node.answers.set(kept.path + '?sig=' + kept.query.sig, answer)
    const hops = streamHops(s)
    const seen = s.node.seen.length

    const part = await s.audio(ticket, { Range: 'bytes=10-19' })
    t.is(part.status, 206, label)
    t.ok(part.raw.equals(AUDIO.subarray(10, 20)), label + ': the asked bytes')
    t.absent(part.raw.toString('latin1').includes('script'), label + ': nothing of the failed answer')
    t.is(streamHops(s), hops + 1, label + ': walked again in the same request')
    t.is(s.node.seen.length, seen + 2, label + ': the kept URL once, then the fresh one')
    t.is(s.node.seen.at(-2).query.sig, kept.query.sig)
    t.is(s.node.seen.at(-1).query.sig, String(s.state.signed))
    t.is(s.node.seen.at(-1).headers.range, 'bytes=10-19')

    t.is((await s.audio(ticket, { Range: 'bytes=0-9' })).status, 206)
    t.is(streamHops(s), hops + 1, label + ': the fresh URL is kept')
    t.is(s.node.seen.at(-1).query.sig, String(s.state.signed))
  }
  t.absent(s.node.seen.some((r) => r.path === '/audio/Ranged1'), 'a redirect from a kept URL is not followed')

  // A 416 from the kept URL is the answer: relayed, with no walk, and the URL
  // stays kept.
  const far = await s.ticketFor(token, 'Signed1')
  t.is((await s.audio(far)).status, 200)
  const path = '/audio/Signed1?sig=' + s.state.signed
  s.node.answers.set(path, { status: 416, headers: { 'Content-Range': 'bytes */100' } })
  const hops = streamHops(s)
  const past = await s.audio(far, { Range: 'bytes=500-' })
  t.is(past.status, 416)
  t.is(past.headers['content-range'], 'bytes */100')
  t.is(past.raw.length, 0)
  t.is(streamHops(s), hops, 'a 416 from the kept URL does not walk')
  s.node.answers.delete(path)
  t.is((await s.audio(far, { Range: 'bytes=0-9' })).status, 206)
  t.is(streamHops(s), hops, 'the URL stays kept after a 416')

  // A kept URL that failed is forgotten even when the walk fails too.
  const lost = await s.ticketFor(token, 'Signed1')
  t.is((await s.audio(lost)).status, 200)
  s.node.answers.set('/audio/Signed1?sig=' + s.state.signed, { status: 403 })
  s.state.mode = 'garbage'
  const seen = s.node.seen.length
  t.is((await s.audio(lost)).status, 503, 'the kept URL and the walk both failed')
  t.is(s.node.seen.length, seen + 1, 'the kept URL was asked once')
  s.state.mode = 'ok'
  t.is((await s.audio(lost)).status, 200)
  t.is(s.node.seen.length, seen + 2, 'the next open walks without asking the failed URL again')
  t.is(s.node.seen.at(-1).query.sig, String(s.state.signed))
  t.absent(s.node.seen.some((r) => r.headers['x-api-key'] !== undefined), 'no key at the node, ever')
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: a kept storage URL is not used after UPSTREAM_REUSE_MS or once the clock steps back', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Ranged1')
  t.is((await s.audio(ticket)).status, 200)
  s.clock.offset += UPSTREAM_REUSE_MS - 1000
  t.is((await s.audio(ticket)).status, 200)
  t.is(streamHops(s), 1, 'still kept just inside the window')
  s.clock.offset += 1000
  t.is((await s.audio(ticket)).status, 200)
  t.is(streamHops(s), 2, 'walked again once the window ended')
  t.is(s.node.seen.length, 3, 'the expired URL was not asked')
  s.clock.offset -= 1000
  t.is((await s.audio(ticket)).status, 200)
  t.is(streamHops(s), 3, 'a clock that stepped back walks again')
  t.is(s.node.seen.length, 4, 'the URL kept before the step was not asked')
  t.is((await s.audio(ticket)).status, 200)
  t.is(streamHops(s), 3, 'the walk after the step is kept')
  t.is(s.node.seen.length, 5)
})

test('audius: nothing is kept when the API host answers the audio itself or the storage URL is too long', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Direct1')
  for (let i = 0; i < 2; i++) {
    const res = await s.audio(ticket)
    t.is(res.status, 200)
    t.ok(res.raw.equals(AUDIO))
  }
  const hops = s.api.seen.filter((r) => r.path.endsWith('/stream'))
  t.is(hops.length, 2, 'every open walked from the API host')
  t.ok(hops.every((r) => r.headers['x-api-key'] === KEY), 'each one a walk with the key, not a direct open of the API URL')
  t.is(s.node.seen.length, 0)

  const long = await s.ticketFor(token, 'Long1')
  for (let i = 0; i < 2; i++) t.is((await s.audio(long)).status, 200)
  t.is(streamHops(s), 4, 'a storage URL over the length cap is not kept')
  t.is(s.node.seen.length, 2)
})

test('audius: a kept storage URL whose name now resolves to a non-public address opens no socket and falls back', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  s.state.storage.Moved1 = MOVED
  const ticket = await s.ticketFor(token, 'Moved1')
  t.is((await s.audio(ticket)).status, 200)
  t.ok(s.dials.some((d) => d.host === MOVED && d.addresses !== undefined), 'the walk ended at the movable name')
  s.dns.moved = '10.0.0.8'
  delete s.state.storage.Moved1
  const connects = s.connected.length
  const dials = s.dials.length

  const part = await s.audio(ticket, { Range: 'bytes=10-19' })
  t.is(part.status, 206)
  t.ok(part.raw.equals(AUDIO.subarray(10, 20)))
  const now = s.dials.slice(dials)
  t.ok(now.some((d) => d.host === MOVED && d.refused !== undefined), 'the guarded lookup refused the moved name')
  t.absent(now.some((d) => d.host === MOVED && d.addresses !== undefined), 'no address of it was let through')
  t.is(s.connected.length - connects, 2, 'only the API host and the node were dialled')
  t.is(streamHops(s), 2, 'the walk ran in the same request')
  onlyLoopback(t, s)
  noKeyAnywhere(t, s)
})

test('audius: an audio answer refused here or a body cut short forgets the storage URL, and the next open walks', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()

  // A walk whose storage answer is refused keeps nothing.
  const skew = await s.ticketFor(token, 'Skew1')
  t.is((await s.audio(skew, { Range: 'bytes=10-19' })).status, 503, 'a Content-Range that does not match')
  t.is(streamHops(s), 1)
  t.is((await s.audio(skew, { Range: 'bytes=10-19' })).status, 503)
  t.is(streamHops(s), 2, 'the refused storage URL was not kept: walked again')

  // A kept URL whose audio answer is refused is forgotten.
  const signed = await s.ticketFor(token, 'Signed1')
  t.is((await s.audio(signed)).status, 200)
  const kept = '/audio/Signed1?sig=' + s.state.signed
  s.node.answers.set(kept, { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 5-9/100', 'Content-Length': 5 }, body: AUDIO.subarray(5, 10) })
  let hops = streamHops(s)
  let seen = s.node.seen.length
  t.is((await s.audio(signed, { Range: 'bytes=10-19' })).status, 503, 'the kept URL answered a range that was not asked')
  t.is(streamHops(s), hops, 'an audio answer does not walk in the same request')
  t.is(s.node.seen.length, seen + 1)
  s.node.answers.delete(kept)
  const part = await s.audio(signed, { Range: 'bytes=10-19' })
  t.is(part.status, 206)
  t.ok(part.raw.equals(AUDIO.subarray(10, 20)))
  t.is(streamHops(s), hops + 1, 'the next open walks, though the old URL would answer again')
  t.is(s.node.seen.at(-1).query.sig, String(s.state.signed))
  t.is(s.node.seen.filter((r) => r.path + '?sig=' + r.query.sig === kept).length, 2, 'the refused URL was asked once after its walk')

  // A body the storage node cuts short forgets the URL it came from.
  const drop = await s.ticketFor(token, 'Drop1')
  const cut = await s.audio(drop)
  t.is(cut.status, 200)
  t.absent(cut.complete, 'the node dropped the body')
  t.ok(await s.until(() => s.routes.stats().streams === 0))
  hops = streamHops(s)
  seen = s.node.seen.length
  t.absent((await s.audio(drop)).complete)
  t.is(streamHops(s), hops + 1, 'the next open walks')
  t.is(s.node.seen.length, seen + 1)
  t.ok(await s.until(() => s.routes.stats().streams === 0))

  // A relay this service cuts, replaced at the member cap, keeps the URL.
  const hold = await s.ticketFor(token, 'Hold1')
  const a1 = await s.hold(audioPath(hold))
  t.ok(await s.until(() => a1.received === 5))
  hops = streamHops(s)
  const a2 = await s.hold(audioPath(hold))
  const a3 = await s.hold(audioPath(hold))
  t.absent((await a1.ended).complete, 'the oldest relay was replaced')
  a2.close()
  a3.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
  const a4 = await s.hold(audioPath(hold))
  t.is(a4.status, 200)
  t.is(streamHops(s), hops, 'every later open asked the kept URL: a replaced relay says nothing of the node')
  a4.close()
  t.ok(await s.until(() => s.routes.stats().streams === 0 && s.node.held.size === 0))
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: a kept storage URL that never answers gives up after STORED_CONNECT_MS, and the walk gets what is left of the deadline', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Signed1')
  t.is((await s.audio(ticket)).status, 200)
  s.node.answers.set('/audio/Signed1?sig=' + s.state.signed, { hang: true })
  const hops = streamHops(s)
  // Every connect deadline the stream fetch arms goes through setTimeout.
  const delays = []
  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn, ms, ...args) => {
    delays.push(ms)
    return realSetTimeout(fn, ms, ...args)
  }
  let part
  let elapsed
  try {
    const started = Date.now()
    part = await s.audio(ticket, { Range: 'bytes=10-19' })
    elapsed = Date.now() - started
  } finally {
    global.setTimeout = realSetTimeout
  }
  t.is(part.status, 206, 'the walk answered in the same request')
  t.ok(part.raw.equals(AUDIO.subarray(10, 20)))
  t.is(s.node.waiting.length, 1, 'the kept URL was asked once')
  t.is(streamHops(s), hops + 1)
  t.ok(delays.includes(STORED_CONNECT_MS), 'the kept URL had STORED_CONNECT_MS')
  t.absent(delays.includes(DEADLINE_MS), 'no open of this request had the whole deadline')
  t.ok(elapsed >= STORED_CONNECT_MS - 50 && elapsed < DEADLINE_MS, 'answered after the kept URL gave up, inside the deadline: ' + elapsed)
  // The relay's own timers are 1 s or less, or the stall and total deadlines.
  const walk = delays.filter((ms) => ms > STORED_CONNECT_MS && ms < DEADLINE_MS)
  t.is(walk.length, 1, 'one walk deadline')
  t.ok(walk[0] <= DEADLINE_MS - STORED_CONNECT_MS && walk[0] >= DEADLINE_MS - elapsed, 'the walk had what was left: ' + walk[0])
  t.is((await s.audio(ticket, { Range: 'bytes=0-9' })).status, 206)
  t.is(streamHops(s), hops + 1, 'the walked URL is kept')
})

test('audius: a kept URL that fails does not forget a newer one a concurrent open kept', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const ticket = await s.ticketFor(token, 'Signed1')
  t.is((await s.audio(ticket)).status, 200)
  const first = '/audio/Signed1?sig=' + s.state.signed
  s.node.answers.set(first, { hang: true })
  const slow = s.audio(ticket, { Range: 'bytes=0-9' })
  t.ok(await s.until(() => s.node.waiting.length === 1), 'the first open waits on the kept URL')
  s.node.answers.set(first, { status: 403 })
  const fast = await s.audio(ticket, { Range: 'bytes=10-19' })
  t.is(fast.status, 206, 'the second open fell back to a walk')
  const newer = String(s.state.signed)
  t.not(newer, '1')
  const hops = streamHops(s)
  // The first open's kept URL fails now, and its own walk fails too.
  s.state.mode = 'garbage'
  const held = s.node.waiting[0]
  held.writeHead(403)
  held.end()
  t.is((await slow).status, 503)
  t.is(streamHops(s), hops + 1, 'the first open walked')
  s.state.mode = 'ok'
  const next = await s.audio(ticket, { Range: 'bytes=20-29' })
  t.is(next.status, 206)
  t.ok(next.raw.equals(AUDIO.subarray(20, 30)))
  t.is(streamHops(s), hops + 1, 'the newer URL survived: no walk')
  t.is(s.node.seen.at(-1).query.sig, newer)
  t.ok(await s.until(() => s.routes.stats().streams === 0))
})

test('audius: a direct or fallen-back open spends one member open, one ticket open and one budget unit, as a walk does', async (t) => {
  const b = await setup(t, { caps: { budget: 4 } })
  const login = await b.login()
  // The play's lookup is the first unit.
  const ticket = await b.ticketFor(login.token, 'Plain1')
  for (let i = 0; i < 3; i++) t.is((await b.audio(ticket, { Range: 'bytes=100-' })).status, 416, 'open ' + i)
  t.is(streamHops(b), 1)
  t.is(b.node.seen.length, 3)
  const broke = await b.audio(ticket, { Range: 'bytes=100-' })
  t.is(broke.status, 503)
  t.alike(broke.json, { error: 'indisponivel' })
  t.ok(b.logs.some((e) => e.reason === 'orcamento'))
  t.is(b.node.seen.length, 3, 'no upstream open past the budget')

  const p = await setup(t)
  const own = await p.login()
  const kept = await p.ticketFor(own.token, 'Plain1')
  let wrong = 0
  for (let i = 0; i < OPENS_PER_TICKET; i++) if ((await p.audio(kept, { Range: 'bytes=100-' })).status !== 416) wrong++
  t.is(wrong, 0)
  t.is(streamHops(p), 1, 'only the first open walked')
  t.is(p.node.seen.length, OPENS_PER_TICKET)
  t.is((await p.audio(kept)).status, 404, 'direct opens retire the ticket at OPENS_PER_TICKET too')
  t.is(p.node.seen.length, OPENS_PER_TICKET)

  const f = await setup(t, { caps: { opens: 2 } })
  const mine = await f.login()
  const signed = await f.ticketFor(mine.token, 'Signed1')
  t.is((await f.audio(signed)).status, 200)
  f.node.answers.set('/audio/Signed1?sig=1', { status: 403 })
  t.is((await f.audio(signed, { Range: 'bytes=0-9' })).status, 206, 'a kept URL that failed, then the walk')
  t.is(streamHops(f), 2)
  const over = await f.audio(signed, { Range: 'bytes=0-9' })
  t.is(over.status, 429, 'the fallen-back request was one open, not two')
  t.alike(over.json, { error: 'limite-musica' })
})

// --- covers ------------------------------------------------------------------

const TRACK_KEYS = ['artist', 'duration', 'id', 'title', 'url']
const PLAYLIST_KEYS = ['artist', 'count', 'id', 'title', 'url']

function artOk (t, res, mime, bytes) {
  t.is(res.status, 200)
  t.alike(Object.keys(res.json).sort(), ['bytes', 'mime'])
  t.is(res.json.mime, mime)
  t.alike(Buffer.from(res.json.bytes, 'base64'), bytes)
  t.is(Buffer.from(res.json.bytes, 'base64').toString('base64'), res.json.bytes, 'canonical base64')
}

function artPaths (s) {
  return s.art.seen.map((r) => r.path)
}

function fakeTimers () {
  const live = new Map()
  let n = 0
  return {
    live,
    cleared: [],
    set (fn, ms) {
      const handle = { id: ++n, ms, unrefed: false, unref () { this.unrefed = true } }
      live.set(handle.id, { fn, handle })
      return handle
    },
    clear (handle) {
      if (handle === null || handle === undefined) return
      this.cleared.push(handle.id)
      live.delete(handle.id)
    },
    fireAll () {
      for (const [id, { fn }] of [...live]) {
        live.delete(id)
        fn()
      }
    }
  }
}
// clear() reads `this.cleared`; the routes call it unbound.
function boundTimers () {
  const tm = fakeTimers()
  tm.clear = tm.clear.bind(tm)
  return tm
}

test('audius: answers are unchanged without the covers query and when the switch is off', async (t) => {
  const off = await setup(t)
  const on = await setup(t, { covers: true })
  const a = await off.login()
  const b = await on.login()
  const bodies = [
    ['search', { q: QUERY, kind: 'track' }],
    ['search', { q: QUERY, kind: 'playlist' }],
    ['item', { kind: 'track', id: 'Plain1' }],
    ['item', { kind: 'playlist', id: 'Pl1' }],
    ['resolve', { url: 'https://audius.co/artista/musica' }],
    ['resolve', { url: 'https://audius.co/artista/playlist/lista' }]
  ]
  for (const [name, body] of bodies) {
    const today = await on.post(b.token, name, body)
    const asked = await off.post(a.token, name + '?covers=1', body)
    const zero = await on.post(b.token, name + '?covers=0', body)
    t.is(today.status, 200, name)
    t.alike(asked.raw, today.raw, name + ': the switch off ignores the query, byte for byte')
    t.alike(zero.raw, today.raw, name + ': covers=0 is not covers=1')
    t.absent(today.raw.toString('utf8').includes('"cover"'), name + ': no cover key')
  }
  const one = await on.post(b.token, 'item', { kind: 'track', id: 'Plain1' })
  t.alike(Object.keys(one.json).sort(), TRACK_KEYS)
  const pl = await on.post(b.token, 'item', { kind: 'playlist', id: 'Pl1' })
  t.alike(Object.keys(pl.json).sort(), [...PLAYLIST_KEYS, 'tracks'].sort())
  for (const it of pl.json.tracks) t.alike(Object.keys(it).sort(), TRACK_KEYS)
})

test('audius: answers carry a cover boolean with the query and the switch on', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  const tracks = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'track' })
  t.is(tracks.status, 200)
  for (const it of tracks.json.items) {
    t.alike(Object.keys(it).sort(), [...TRACK_KEYS, 'cover'].sort())
    t.is(it.cover, true)
  }
  const lists = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'playlist' })
  t.alike(lists.json.items[0], { id: 'Pl1', title: 'Lista Pl1', artist: 'Artista', count: 60, url: 'https://audius.co/artista/playlist/lista-pl1', cover: true })
  const none = await s.post(token, 'item?covers=1', { kind: 'track', id: 'NoArt1' })
  t.is(none.json.cover, false, 'no artwork: false')
  const bad = await s.post(token, 'item?covers=1', { kind: 'track', id: 'BadArt1' })
  t.is(bad.status, 200, 'a bad artwork URL keeps the track')
  t.is(bad.json.cover, false, 'a bad artwork URL: false')
  const cached = await s.post(token, 'item?covers=1', { kind: 'track', id: 'Ranged1' })
  t.is(cached.json.cover, true, 'a cached track still knows its cover')
  const pl = await s.post(token, 'item?covers=1', { kind: 'playlist', id: 'Pl1' })
  t.is(pl.json.cover, true)
  t.ok(pl.json.tracks.length > 0)
  for (const it of pl.json.tracks) {
    t.alike(Object.keys(it).sort(), [...TRACK_KEYS, 'cover'].sort())
    t.is(it.cover, true)
  }
  const resolved = await s.post(token, 'resolve?covers=1', { url: 'https://audius.co/artista/musica' })
  t.alike(resolved.json, { kind: 'track', item: { id: 'Ranged1', title: 'Musica Ranged1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-ranged1', cover: true } })
  const resolvedList = await s.post(token, 'resolve?covers=1', { url: 'https://audius.co/artista/playlist/lista' })
  t.is(resolvedList.json.item.cover, true)
  t.is(s.art.seen.length, 0, 'answering cover flags never contacts the art host')
})

test('audius: no answer ever carries an artwork URL', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  for (const q of ['', '?covers=1']) {
    await s.post(token, 'search' + q, { q: QUERY, kind: 'track' })
    await s.post(token, 'search' + q, { q: QUERY, kind: 'playlist' })
    await s.post(token, 'item' + q, { kind: 'track', id: 'Plain1' })
    await s.post(token, 'item' + q, { kind: 'playlist', id: 'Pl1' })
    await s.post(token, 'resolve' + q, { url: 'https://audius.co/artista/musica' })
  }
  await s.post(token, 'art', { kind: 'track', id: 'Plain1' })
  await s.post(token, 'art', { kind: 'playlist', id: 'Pl1' })
  t.ok(s.responses.length >= 12)
  for (const r of s.responses) {
    const text = r.raw.toString('latin1')
    t.absent(text.includes(ART), 'no art host in a body')
    t.absent(text.includes('artwork'), 'no artwork key')
    t.absent(text.includes('"art"'), 'no art key')
    t.absent(JSON.stringify(r.headers).includes(ART), 'no art host in a header')
  }
  t.absent(JSON.stringify(s.logs).includes(ART), 'no art URL in a log line')
  t.absent(JSON.stringify(s.logs).includes('Plain1'), 'no id in a log line')
  noKeyAnywhere(t, s)
})

test('audius: the policy answer keeps exactly enabled and moments', async (t) => {
  for (const [opts, expected] of [[{ covers: true }, { enabled: true, moments: false }], [{ covers: true, moments: true }, { enabled: true, moments: true }], [{ covers: false }, { enabled: true, moments: false }]]) {
    const s = await setup(t, opts)
    const policy = await s.call('GET', '/account/audius/policy?covers=1')
    t.is(policy.status, 200)
    t.alike(Object.keys(policy.json).sort(), ['enabled', 'moments'])
    t.alike(policy.json, expected)
  }
})

test('audius: art answers validated bytes with nosniff and no-store', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  const jpeg = await s.post(token, 'art', { kind: 'track', id: 'Plain1' })
  artOk(t, jpeg, 'image/jpeg', JPEG)
  t.is(jpeg.headers['x-content-type-options'], 'nosniff')
  t.is(jpeg.headers['cache-control'], 'no-store')
  t.is(jpeg.headers['content-type'], 'application/json; charset=utf-8', 'the bytes ride in JSON, never as an image response')
  t.absent(jpeg.headers['set-cookie'], 'nothing of the art host is relayed')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'ArtPng1' }), 'image/png', PNG)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'ArtWebp1' }), 'image/webp', WEBP)
  artOk(t, await s.post(token, 'art', { kind: 'playlist', id: 'Pl1' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/Plain1', '/ArtPng1', '/ArtWebp1', '/Pl1'])
  t.ok(s.logs.some((e) => e.reason === 'capa'), 'logged as capa')
  t.is(s.routes.stats().covers, 4, 'stats count the cached covers')
  t.is(s.routes.stats().inflight, 0)
  const bad = [
    { kind: 'track' },
    { id: 'Plain1' },
    { kind: 'album', id: 'Plain1' },
    { kind: 'track', id: 'bad id' },
    { kind: 'track', id: 'Plain1', size: '480x480' },
    { kind: 'track', id: 'Plain1', url: 'https://' + ART + '/x' }
  ]
  for (const body of bad) {
    const res = await s.post(token, 'art', body)
    t.is(res.status, 400, JSON.stringify(body))
    t.alike(res.json, { error: 'pedido-invalido' })
  }
  t.is((await s.post(null, 'art', { kind: 'track', id: 'Plain1' })).status, 401, 'a session is needed')
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: art is feature-off before any counter unless covers are on', async (t) => {
  const s = await setup(t, { covers: false, caps: { arts: 1 } })
  const { token } = await s.login()
  for (let i = 0; i < 5; i++) {
    const res = await s.post(token, 'art', { kind: 'track', id: 'Plain1' })
    t.is(res.status, 404)
    t.alike(res.json, { error: 'feature-off' })
  }
  t.is((await s.post(token, 'art', { kind: 'track', id: 'bad id' })).status, 400, 'the shape is checked first')
  t.is(s.api.seen.length, 0, 'the provider was never asked')
  t.is(s.art.seen.length, 0, 'the art host was never asked')

  const off = await setup(t, { audius: false })
  const res = await off.post(null, 'art', { kind: 'track', id: 'Plain1' })
  t.is(res.status, 404)
  t.alike(res.json, { error: 'feature-off' })

  const on = await setup(t, { covers: true, caps: { arts: 1 } })
  const b = await on.login()
  for (let i = 0; i < 5; i++) t.is((await on.post(b.token, 'art', { kind: 'track', id: 'bad id' })).status, 400)
  artOk(t, await on.post(b.token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  const over = await on.post(b.token, 'art', { kind: 'track', id: 'Plain1' })
  t.is(over.status, 429, 'the member cap counts once covers are on')
  t.alike(over.json, { error: 'limite-musica' })
})

test('audius: art refuses bytes that are not JPEG, PNG or WebP by magic', async (t) => {
  const s = await setup(t, { covers: true, caps: { arts: 10 } })
  const { token } = await s.login()
  const ids = ['ArtGif1', 'ArtHtml1', 'ArtWave1', 'ArtEmpty1', 'ArtGone1']
  for (const id of ids) {
    const res = await s.post(token, 'art', { kind: 'track', id })
    t.is(res.status, 404, id)
    t.alike(res.json, { error: 'nao-encontrado' })
  }
  const contacts = s.art.seen.length
  t.is(contacts, ids.length)
  for (const id of ids) t.is((await s.post(token, 'art', { kind: 'track', id })).status, 404, id + ' again')
  t.is(s.art.seen.length, contacts, 'a miss is remembered: the host is not asked again')
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Plain1' })).status, 429, 'every refusal kept its use')
  t.absent(s.responses.some((r) => r.raw.toString('latin1').includes('GIF89a') || r.raw.toString('latin1').includes('svg')), 'nothing of a refused body is relayed')
})

test('audius: art stops at the size cap', async (t) => {
  t.is(ART_MAX_BYTES, 131072)
  const s = await setup(t, { covers: true, caps: { arts: 2 } })
  const { token } = await s.login()
  const exact = await s.post(token, 'art', { kind: 'track', id: 'ArtExact1' })
  t.is(exact.status, 200, 'exactly the cap passes')
  t.is(Buffer.from(exact.json.bytes, 'base64').length, ART_MAX_BYTES)
  const big = await s.post(token, 'art', { kind: 'track', id: 'ArtBig1' })
  t.is(big.status, 404, 'one byte over is refused')
  t.alike(big.json, { error: 'nao-encontrado' })
  t.is(s.routes.stats().covers, 2, 'the cover and the oversize miss')
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Plain1' })).status, 429, 'the oversize answer kept its use')
})

test('audius: an oversize cover is remembered as a miss', async (t) => {
  const s = await setup(t, { covers: true, caps: { arts: 10 } })
  const { token } = await s.login()
  for (let i = 0; i < 3; i++) {
    const big = await s.post(token, 'art', { kind: 'track', id: 'ArtBig1' })
    t.is(big.status, 404, 'round ' + i)
    t.alike(big.json, { error: 'nao-encontrado' })
  }
  t.is(artPaths(s).filter((p) => p === '/ArtBig1').length, 1, 'the host is asked once')
  t.absent(s.responses.some((r) => r.raw.length > ART_MAX_BYTES), 'nothing of the body is relayed')
})

test('audius: art never sends the API key or member headers to the art host', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  const headers = { Authorization: 'Bearer ' + token, Cookie: 'sessao=sentinela', 'X-Forwarded-For': '203.0.113.5', Referer: 'https://varanda.test/' }
  for (const id of ['Plain1', 'ArtHop1']) {
    const res = await s.call('POST', '/account/audius/art', { body: { kind: 'track', id }, headers })
    t.is(res.status, 200, id)
  }
  t.is(s.art.seen.length, 3, 'the first hop and the redirect hop')
  for (const r of s.art.seen) {
    t.ok(Object.keys(r.headers).every((h) => ART_HEADERS.includes(h)), 'User-Agent and Accept only: ' + Object.keys(r.headers).join(','))
    t.is(r.headers['user-agent'], USER_AGENT)
    t.is(r.headers.accept, 'image/jpeg, image/png, image/webp')
    t.alike(r.query, {}, 'no app name or key in the URL')
    const text = JSON.stringify(r)
    t.absent(text.includes(KEY), 'never the key')
    t.absent(text.includes(token), 'never the token')
    t.absent(text.includes(s.memberHex), 'never the member')
    t.absent(text.includes('sentinela'), 'never the member cookie')
    t.absent(text.includes('203.0.113.5'), 'never the member address')
  }
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: art host must be public https and redirects are re-checked', async (t) => {
  const s = await setup(t, { covers: true, caps: { artMs: 1000 } })
  const { token } = await s.login()
  for (const id of ['ArtPrivate1', 'ArtHttp1', 'ArtPort1', 'ArtLoop1', 'PrivArt1']) {
    const res = await s.post(token, 'art', { kind: 'track', id })
    t.is(res.status, 503, id)
    t.alike(res.json, { error: 'indisponivel' })
  }
  t.ok(s.looked.includes(PRIVATE), 'the private name was looked up')
  t.absent(s.connected.includes('10.0.0.7'), 'and never dialled')
  const privateDials = s.dials.filter((d) => d.host === PRIVATE)
  t.is(privateDials.length, 2, 'ArtPrivate1 and PrivArt1 each reached the lookup once')
  t.ok(privateDials.every((d) => d.refused === 'EBLOCKED'), 'the guard refused the private address before any dial')
  t.is(artPaths(s).filter((p) => p === '/ArtLoop1').length, 4, 'at most 3 redirects')
  const before = s.art.seen.length
  const bad = await s.post(token, 'art', { kind: 'track', id: 'BadArt1' })
  t.is(bad.status, 404, 'an http artwork URL is no cover at all')
  t.alike(bad.json, { error: 'nao-encontrado' })
  t.is(s.art.seen.length, before, 'and the host is not asked')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'ArtHop2' }), 'image/jpeg', JPEG)
  onlyLoopback(t, s)
})

test('audius: art charges the member cap and one budget token per host contact, not provider calls; a cache hit spends no budget', async (t) => {
  t.is(PROVIDER_CALLS_PER_DAY, 1760)
  t.is(PROVIDER_PER_DAY, 12000)
  t.is(ARTS_PER_DAY, 600)
  // Budget 3: the search, then two art host contacts.
  const s = await setup(t, { covers: true, caps: { budget: 3, calls: 1, arts: 10 } })
  const { token } = await s.login()
  t.is((await s.post(token, 'search?covers=1', { q: QUERY, kind: 'track' })).status, 200)
  t.is((await s.post(token, 'search', { q: 'outra', kind: 'track' })).status, 429, 'the member spent its one provider call')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  for (let i = 0; i < 4; i++) artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, 1, 'a cache hit contacts no host')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill6' }), 'image/jpeg', JPEG)
  const spent = await s.post(token, 'art', { kind: 'track', id: 'Fill7' })
  t.is(spent.status, 503, 'the budget is spent')
  t.alike(spent.json, { error: 'indisponivel' })
  t.ok(s.logs.some((e) => e.reason === 'orcamento'))
  t.is(s.art.seen.length, 2)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)

  const c = await setup(t, { covers: true, caps: { arts: 2 } })
  const m = await c.login()
  await c.post(m.token, 'search', { q: QUERY, kind: 'track' })
  t.is((await c.post(m.token, 'art', { kind: 'track', id: 'Fill5' })).status, 200)
  t.is((await c.post(m.token, 'art', { kind: 'track', id: 'Fill5' })).status, 200, 'a cache hit spends the member use')
  const over = await c.post(m.token, 'art', { kind: 'track', id: 'Fill6' })
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-musica' })
  t.is(c.art.seen.length, 1)
  const other = await c.login(c.other)
  t.is((await c.post(other.token, 'art', { kind: 'track', id: 'Fill6' })).status, 200, 'another member has its own cap')
})

test('audius: each redirect hop spends one budget token, and a spent budget answers 503 and gives the use back only before any host contact', async (t) => {
  // ArtHop2 is three host contacts after one provider call: four tokens.
  const enough = await setup(t, { covers: true, caps: { budget: 4 } })
  const a = await enough.login()
  artOk(t, await enough.post(a.token, 'art', { kind: 'track', id: 'ArtHop2' }), 'image/jpeg', JPEG)
  t.alike(artPaths(enough), ['/ArtHop2', '/ArtHop1', '/ArtJpg1'])
  t.is((await enough.post(a.token, 'art', { kind: 'track', id: 'Plain1' })).status, 503, 'nothing is left')

  const short = await setup(t, { covers: true, caps: { budget: 3, arts: 1 } })
  const b = await short.login()
  const res = await short.post(b.token, 'art', { kind: 'track', id: 'ArtHop2' })
  t.is(res.status, 503)
  t.alike(res.json, { error: 'indisponivel' })
  t.alike(artPaths(short), ['/ArtHop2', '/ArtHop1'], 'the third hop is never sent')
  t.ok(short.logs.some((e) => e.reason === 'orcamento'), 'logged as orcamento')
  const again = await short.post(b.token, 'art', { kind: 'track', id: 'ArtHop2' })
  t.is(again.status, 429, 'the host was contacted: the use is kept')
  t.alike(again.json, { error: 'limite-musica' })
  const c = await short.login(short.other)
  for (let i = 0; i < 3; i++) {
    const before = await short.post(c.token, 'art', { kind: 'track', id: 'ArtHop2' })
    t.is(before.status, 503, 'spent before the first hop: 503 again, not 429')
    t.alike(before.json, { error: 'indisponivel' })
  }
  t.is(short.art.seen.length, 2, 'and no host was contacted')
  t.is(short.routes.stats().artInflight, 0)
  t.is(short.routes.stats().covers, 0)
})

test('audius: art releases inflight on failure and timeout', async (t) => {
  t.timeout(30 * 1000)
  const ids = ['ArtHang1', 'ArtStall1', 'ArtErr1', 'ArtBusy1', 'ArtPartial1']
  const s = await setup(t, { covers: true, caps: { artMs: 300, arts: ids.length + 1 } })
  const { token } = await s.login()
  for (const id of ids) {
    const started = Date.now()
    const res = await s.post(token, 'art', { kind: 'track', id })
    t.is(res.status, 503, id)
    t.alike(res.json, { error: 'indisponivel' })
    t.ok(Date.now() - started < 5000, id + ' ends within the deadline')
    t.is(s.routes.stats().artInflight, 0, id + ' released inflight')
  }
  t.is(s.routes.stats().covers, ids.length, 'each failure after a host contact is remembered for a while')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)

  // Held fetches of two members fill the cover slots: the next, from a third
  // member, is busy and keeps its use.
  const h = await setup(t, { covers: true, caps: { artMs: 1500 } })
  const m = await h.login()
  const n = await h.login(h.other)
  const third = crypto.keyPair()
  h.linked.add(b4a.toString(third.publicKey, 'hex'))
  const o = await h.login(third)
  for (let i = 1; i <= MAX_ART_INFLIGHT; i++) t.is((await h.post(m.token, 'item', { kind: 'track', id: 'ArtHang' + i })).status, 200)
  t.is((await h.post(m.token, 'item', { kind: 'track', id: 'Plain1' })).status, 200)
  const held = []
  for (let i = 1; i <= MAX_ART_INFLIGHT; i++) held.push(h.post(i % 2 === 0 ? m.token : n.token, 'art', { kind: 'track', id: 'ArtHang' + i }))
  t.ok(await h.until(() => h.routes.stats().artInflight === MAX_ART_INFLIGHT), 'every cover slot in flight')
  const busy = await h.post(o.token, 'art', { kind: 'track', id: 'Plain1' })
  t.is(busy.status, 503)
  t.is(busy.headers['retry-after'], '5')
  t.is(h.art.seen.filter((r) => r.path === '/Plain1').length, 0, 'a busy refusal contacts no host')
  for (const res of await Promise.all(held)) t.is(res.status, 503)
  t.is(h.routes.stats().artInflight, 0, 'every slot came back')
  artOk(t, await h.post(m.token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
})

test('audius: a failing art host keeps the art use and cannot drain the shared budget', async (t) => {
  const s = await setup(t, { covers: true, caps: { arts: 2, calls: 5, budget: 50 } })
  const { token } = await s.login()
  let over = null
  for (let i = 0; i < 40 && over === null; i++) {
    const res = await s.post(token, 'art', { kind: 'track', id: i % 2 === 0 ? 'ArtLoop1' : 'ArtErr1' })
    if (res.status === 429) over = res
    else if (res.status !== 503) t.fail('round ' + i + ': ' + res.status)
  }
  t.ok(over !== null, 'the member reaches its art cap')
  t.alike(over && over.json, { error: 'limite-musica' })
  t.ok(s.art.seen.length <= 2 * (1 + 3), 'art host contacts stay within arts x (1 + max redirects): ' + s.art.seen.length)
  const other = await s.login(s.other)
  const search = await s.post(other.token, 'search', { q: QUERY, kind: 'track' })
  t.is(search.status, 200, 'another member still searches')
})

test('audius: a cover fetch that failed after a host contact is answered 503 for ART_RETRY_MS, with no contact and the use given back', async (t) => {
  t.is(ART_RETRY_MS, 60 * 1000)
  const timers = boundTimers()
  const s = await setup(t, { covers: true, timers, caps: { arts: 3 } })
  const { token } = await s.login()
  const first = await s.post(token, 'art', { kind: 'track', id: 'ArtErr1' })
  t.is(first.status, 503)
  t.alike(first.json, { error: 'indisponivel' })
  t.ok([...timers.live.values()].some(({ handle }) => handle.ms === ART_RETRY_MS), 'the failure expires after ART_RETRY_MS')
  for (let i = 0; i < 5; i++) {
    const again = await s.post(token, 'art', { kind: 'track', id: 'ArtErr1' })
    t.is(again.status, 503, 'remembered: 503, never the 404 the app keeps for the session')
    t.alike(again.json, { error: 'indisponivel' })
  }
  t.alike(artPaths(s), ['/ArtErr1'], 'no new host contact while remembered')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  s.clock.offset += ART_RETRY_MS
  t.is((await s.post(token, 'art', { kind: 'track', id: 'ArtErr1' })).status, 503)
  t.alike(artPaths(s), ['/ArtErr1', '/Plain1', '/ArtErr1'], 'asked again once the failure expired')
  const over = await s.post(token, 'art', { kind: 'track', id: 'ArtErr1' })
  t.is(over.status, 429, 'the two contacted fetches kept their uses: the cap of 3 is reached')
  t.alike(over.json, { error: 'limite-musica' })
})

test('audius: each member spends at most MEMBER_BUDGET_PER_DAY of the shared budget, and past it gets 429 while others still play', async (t) => {
  t.is(MEMBER_BUDGET_PER_DAY, PROVIDER_PER_DAY / 10)
  t.is(MEMBER_BUDGET_PER_DAY, 1200)

  // JSON calls: one unit each.
  const j = await setup(t, { caps: { share: 2 } })
  const ja = await j.login()
  const jb = await j.login(j.other)
  t.is((await j.post(ja.token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  t.is((await j.post(ja.token, 'search', { q: 'outra', kind: 'track' })).status, 200)
  const asked = j.api.seen.length
  const spent = await j.post(ja.token, 'search', { q: 'terceira', kind: 'track' })
  t.is(spent.status, 429, 'the share is spent')
  t.alike(spent.json, { error: 'limite-musica' })
  t.is(j.api.seen.length, asked, 'and the provider is not asked')
  t.is((await j.post(jb.token, 'search', { q: QUERY, kind: 'track' })).status, 200, 'another member has its own share')

  // Art host contacts: one unit each, the use given back when none was made.
  const a = await setup(t, { covers: true, caps: { share: 2, arts: 2 } })
  const aa = await a.login()
  const ab = await a.login(a.other)
  t.is((await a.post(aa.token, 'search?covers=1', { q: QUERY, kind: 'track' })).status, 200)
  artOk(t, await a.post(aa.token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  const art = await a.post(aa.token, 'art', { kind: 'track', id: 'Fill6' })
  t.is(art.status, 429, 'the share is spent before the art host is contacted')
  t.alike(art.json, { error: 'limite-musica' })
  t.alike(artPaths(a), ['/Fill5'])
  t.is(a.routes.stats().covers, 1, 'a fetch the share stopped is not remembered')
  artOk(t, await a.post(aa.token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  artOk(t, await a.post(ab.token, 'art', { kind: 'track', id: 'Fill6' }), 'image/jpeg', JPEG)
  t.absent(a.logs.some((e) => e.reason === 'orcamento'), 'a spent share is not the spent budget')

  // A redirect hop past the share: the starter gets 429 and keeps the use.
  const h = await setup(t, { covers: true, caps: { share: 2 } })
  const ha = await h.login()
  const hop = await h.post(ha.token, 'art', { kind: 'track', id: 'ArtHop2' })
  t.is(hop.status, 429)
  t.alike(hop.json, { error: 'limite-musica' })
  t.alike(artPaths(h), ['/ArtHop2'], 'the provider call and the first hop spent the share')
  t.is(h.routes.stats().covers, 0)

  // Audio opens: one unit each, the open given back past the share.
  const o = await setup(t, { caps: { share: 2 } })
  const oa = await o.login()
  const ob = await o.login(o.other)
  const ticket = await o.ticketFor(oa.token, 'Ranged1')
  t.is(o.api.seen.length, 1, 'the play spent one unit on the track lookup')
  const played = await o.audio(ticket)
  t.is(played.status, 200)
  const streamed = o.node.seen.length
  const cut = await o.audio(ticket)
  t.is(cut.status, 429, 'the share is spent')
  t.alike(cut.json, { error: 'limite-musica' })
  t.is(o.node.seen.length, streamed, 'and no storage node is contacted')
  t.is(o.api.seen.length, 2, 'nor the provider')
  const other = await o.ticketFor(ob.token, 'Ranged1')
  t.is((await o.audio(other)).status, 200, 'another member still plays')
})

test('audius: covers have their own slot pool', async (t) => {
  t.is(MAX_ART_INFLIGHT, 6)
  const s = await setup(t, { covers: true, caps: { artMs: 2000, arts: MAX_ART_INFLIGHT + 1 } })
  const { token } = await s.login()
  const other = await s.login(s.other)
  const third = crypto.keyPair()
  s.linked.add(b4a.toString(third.publicKey, 'hex'))
  const last = await s.login(third)
  const held = []
  for (let i = 1; i <= MAX_ART_INFLIGHT; i++) held.push(s.post(i % 2 === 0 ? token : other.token, 'art', { kind: 'track', id: 'ArtHang' + i }))
  t.ok(await s.until(() => s.routes.stats().artInflight === MAX_ART_INFLIGHT && s.art.held.size === MAX_ART_INFLIGHT), 'the cover slots are full')
  t.is(s.routes.stats().inflight, 0, 'covers hold no provider slot')
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 200, 'search still answers')
  const busy = await s.post(last.token, 'art', { kind: 'track', id: 'Plain1' })
  t.is(busy.status, 503, 'one more cover is lotado')
  t.alike(busy.json, { error: 'indisponivel' })
  t.is(busy.headers['retry-after'], '5')
  t.is(artPaths(s).filter((p) => p === '/Plain1').length, 0, 'a busy refusal contacts no host')
  for (const res of await Promise.all(held)) t.is(res.status, 503)
  t.is(s.routes.stats().artInflight, 0)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
})

test('audius: one member cannot hold every cover slot', async (t) => {
  t.is(ART_PER_MEMBER, 3)
  const s = await setup(t, { covers: true, caps: { artMs: 1500, arts: ART_PER_MEMBER + 2 } })
  const a = await s.login()
  const b = await s.login(s.other)
  for (let i = 1; i <= ART_PER_MEMBER + 1; i++) t.is((await s.post(a.token, 'item', { kind: 'track', id: 'ArtHang' + i })).status, 200)
  const held = []
  for (let i = 1; i <= ART_PER_MEMBER; i++) held.push(s.post(a.token, 'art', { kind: 'track', id: 'ArtHang' + i }))
  t.ok(await s.until(() => s.art.held.size === ART_PER_MEMBER), 'the member waits on its fetches')
  const next = 'ArtHang' + (ART_PER_MEMBER + 1)
  const busy = await s.post(a.token, 'art', { kind: 'track', id: next })
  t.is(busy.status, 503, 'one more cover of the same member is busy')
  t.alike(busy.json, { error: 'indisponivel' })
  t.is(busy.headers['retry-after'], '5')
  t.is(artPaths(s).filter((p) => p === '/' + next).length, 0, 'a busy refusal contacts no host')
  const joined = await s.post(a.token, 'art', { kind: 'track', id: 'ArtHang1' })
  t.is(joined.status, 503, 'joining a shared fetch counts too')
  t.is(joined.headers['retry-after'], '5')
  t.is(artPaths(s).filter((p) => p === '/ArtHang1').length, 1)

  const own = s.post(b.token, 'art', { kind: 'track', id: next })
  t.ok(await s.until(() => artPaths(s).includes('/' + next)), 'another member still starts a fetch')
  const shared = s.post(b.token, 'art', { kind: 'track', id: 'ArtHang1' })
  for (const res of await Promise.all([...held, own, shared])) t.is(res.status, 503)
  t.is(artPaths(s).filter((p) => p === '/ArtHang1').length, 1, 'and joins the shared fetch')
  t.is(s.routes.stats().artInflight, 0)
  artOk(t, await s.post(a.token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(a.token, 'art', { kind: 'track', id: 'Plain2' }), 'image/jpeg', JPEG)
  t.is((await s.post(a.token, 'art', { kind: 'track', id: 'Plain3' })).status, 429, 'the busy answers gave the use back, and only those')
})

test('audius: the cover flag lives in the item row', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  const tracks = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'track' })
  t.is(tracks.status, 200)
  t.ok(tracks.json.items.length > 0)
  t.is(s.routes.stats().cached, tracks.json.items.length, 'one row per track')
  const lists = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'playlist' })
  t.ok(lists.json.items.length > 0)
  t.is(s.routes.stats().cached, tracks.json.items.length + lists.json.items.length, 'one row per playlist')
  const asked = s.api.seen.length
  const cached = await s.post(token, 'item?covers=1', { kind: 'track', id: tracks.json.items[0].id })
  t.is(cached.json.cover, true, 'a cached track keeps its cover')
  artOk(t, await s.post(token, 'art', { kind: 'playlist', id: lists.json.items[0].id }), 'image/jpeg', JPEG)
  t.is(s.api.seen.length, asked, 'both answered from the item rows')
  const full = await s.post(token, 'item?covers=1', { kind: 'playlist', id: lists.json.items[0].id })
  t.is(full.status, 200)
  t.ok(full.json.tracks.length > 0, 'a playlist seen in a search still gets its tracks')
  t.is(full.json.cover, true)
})

test('audius: a cover flag always matches what the art route serves', async (t) => {
  // A playlist opened without a cover, then found by a search with one.
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  s.state.artwork.Pl1 = undefined
  const opened = await s.post(token, 'item?covers=1', { kind: 'playlist', id: 'Pl1' })
  t.is(opened.status, 200)
  t.is(opened.json.cover, false)
  delete s.state.artwork.Pl1
  const found = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'playlist' })
  t.is(found.json.items.find((x) => x.id === 'Pl1').cover, true)
  artOk(t, await s.post(token, 'art', { kind: 'playlist', id: 'Pl1' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/Pl1'], 'the art route fetches what the search promised')
  const again = await s.post(token, 'item?covers=1', { kind: 'playlist', id: 'Pl1' })
  t.is(again.json.cover, true, 'the full row took the newest art')
  t.ok(again.json.tracks.length > 0, 'and kept its tracks')

  // The reverse: a playlist opened with a cover, then found without one.
  const r = await setup(t, { covers: true })
  const m = await r.login()
  t.is((await r.post(m.token, 'item?covers=1', { kind: 'playlist', id: 'Pl1' })).json.cover, true)
  r.state.artwork.Pl1 = undefined
  const bare = await r.post(m.token, 'search?covers=1', { q: QUERY, kind: 'playlist' })
  t.is(bare.json.items.find((x) => x.id === 'Pl1').cover, false)
  const miss = await r.post(m.token, 'art', { kind: 'playlist', id: 'Pl1' })
  t.is(miss.status, 404)
  t.alike(miss.json, { error: 'nao-encontrado' })
  t.is(r.art.seen.length, 0, 'no host contact for a cover the answer denied')

  // A track listed in a cached playlist answer: its flag is its own row's.
  r.state.artwork.Pt0 = undefined
  const tracks = await r.post(m.token, 'search?covers=1', { q: 'faixas', kind: 'track' })
  t.alike(tracks.json.items.map((x) => [x.id, x.cover]), [['Pt0', false]])
  const listed = await r.post(m.token, 'item?covers=1', { kind: 'playlist', id: 'Pl1' })
  t.is(listed.json.tracks.find((x) => x.id === 'Pt0').cover, false, 'the newer track row wins')
  t.is(listed.json.tracks.find((x) => x.id === 'Pt1').cover, true)
  const plain = await r.post(m.token, 'item', { kind: 'playlist', id: 'Pl1' })
  t.ok(plain.json.tracks.every((x) => !Object.hasOwn(x, 'cover')), 'no flag without the query')
  const none = await r.post(m.token, 'art', { kind: 'track', id: 'Pt0' })
  t.is(none.status, 404)
  t.is(r.art.seen.length, 0)
})

test('audius: a new artwork url replaces a remembered cover', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  s.state.artwork.Fill5 = { '150x150': 'https://' + ART + '/ArtGif1' }
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Fill5' })).status, 200)
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Fill5' })).status, 404)
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Fill5' })).status, 404)
  t.alike(artPaths(s), ['/ArtGif1'], 'a remembered miss')
  delete s.state.artwork.Fill5
  const found = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'track' })
  t.is(found.json.items.find((x) => x.id === 'Fill5').cover, true)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/ArtGif1', '/Fill5'], 'the new url is fetched once, then held')

  s.state.artwork.Fill5 = undefined
  const bare = await s.post(token, 'search?covers=1', { q: QUERY, kind: 'track' })
  t.is(bare.json.items.find((x) => x.id === 'Fill5').cover, false)
  const gone = await s.post(token, 'art', { kind: 'track', id: 'Fill5' })
  t.is(gone.status, 404, 'a served cover whose row now says null is not served')
  t.alike(gone.json, { error: 'nao-encontrado' })
  t.is(s.art.seen.length, 2, 'and no host is contacted')
})

test('audius: concurrent loads of one cover contact the host once', async (t) => {
  // Four uses each: three waiters and one more for a, one waiter and three
  // failing waiters for b.
  const s = await setup(t, { covers: true, caps: { arts: 4 } })
  const a = await s.login()
  const b = await s.login(s.other)
  t.is((await s.post(a.token, 'item', { kind: 'track', id: 'ArtSlow1' })).status, 200)
  t.is((await s.post(a.token, 'item', { kind: 'track', id: 'ArtSlowErr1' })).status, 200)
  const loads = []
  for (let i = 0; i < 3; i++) loads.push(s.post(a.token, 'art', { kind: 'track', id: 'ArtSlow1' }))
  loads.push(s.post(b.token, 'art', { kind: 'track', id: 'ArtSlow1' }))
  for (const res of await Promise.all(loads)) artOk(t, res, 'image/jpeg', JPEG)
  t.is(artPaths(s).filter((p) => p === '/ArtSlow1').length, 1, 'one host contact')

  const fails = []
  for (let i = 0; i < 3; i++) fails.push(s.post(b.token, 'art', { kind: 'track', id: 'ArtSlowErr1' }))
  for (const res of await Promise.all(fails)) {
    t.is(res.status, 503, 'every waiter gets the same failure')
    t.alike(res.json, { error: 'indisponivel' })
  }
  t.is(artPaths(s).filter((p) => p === '/ArtSlowErr1').length, 1, 'one host contact for the failure too')

  artOk(t, await s.post(a.token, 'art', { kind: 'track', id: 'ArtSlow1' }), 'image/jpeg', JPEG)
  t.is((await s.post(a.token, 'art', { kind: 'track', id: 'ArtSlow1' })).status, 429, 'each waiter spent its own member use')
  t.is((await s.post(b.token, 'art', { kind: 'track', id: 'ArtSlow1' })).status, 429, 'the waiters of a failure kept theirs')
})

test('audius: an expired cover is not served', async (t) => {
  const timers = boundTimers()
  const s = await setup(t, { covers: true, timers })
  const { token } = await s.login()
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, 1, 'served from memory inside the TTL')
  s.clock.offset += CACHE_TTL_MS
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, 2, 'past the TTL the host is asked again, even with the timer not fired')
  s.clock.offset -= 2 * CACHE_TTL_MS
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, 3, 'a row from the future is dropped too')
})

test('audius: an expired cover is removed without another request', async (t) => {
  const timers = boundTimers()
  const s = await setup(t, { covers: true, timers })
  const { token } = await s.login()
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  t.is((await s.post(token, 'art', { kind: 'track', id: 'ArtGif1' })).status, 404)
  t.is(s.routes.stats().covers, 2, 'a cover and a miss are held')
  t.is(timers.live.size, 2, 'each with its own timer')
  for (const { handle } of timers.live.values()) {
    t.is(handle.ms, CACHE_TTL_MS)
    t.ok(handle.unrefed, 'the timer does not hold the process open')
  }
  timers.fireAll()
  t.is(s.routes.stats().covers, 0, 'gone after the TTL with no request')
  t.is(s.art.seen.length, 2)
})

test('audius: a full cover cache evicts the oldest and clears its timer', async (t) => {
  t.timeout(60 * 1000)
  t.is(MAX_ART_CACHED, 128)
  const timers = boundTimers()
  const s = await setup(t, { covers: true, timers })
  const { token } = await s.login()
  for (let i = 0; i <= MAX_ART_CACHED; i++) {
    const res = await s.post(token, 'art', { kind: 'track', id: 'Many' + i })
    if (res.status !== 200) t.fail('Many' + i + ' ' + res.status)
  }
  t.is(s.routes.stats().covers, MAX_ART_CACHED, 'never more than MAX_ART_CACHED')
  t.is(timers.live.size, MAX_ART_CACHED, 'the evicted row lost its timer')
  t.alike(timers.cleared, [1], 'the oldest was the one cleared')
  const before = s.art.seen.length
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Many1' })).status, 200)
  t.is(s.art.seen.length, before, 'a recent cover is still held')
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Many0' })).status, 200)
  t.is(s.art.seen.length, before + 1, 'the evicted one is fetched again')
  for (let i = 0; i < 2; i++) t.is((await s.post(token, 'art', { kind: 'track', id: 'ArtErr1' })).status, 503)
  t.is(artPaths(s).filter((p) => p === '/ArtErr1').length, 2, 'with the cache full, a failure is not remembered')
  t.is(s.routes.stats().covers, MAX_ART_CACHED)
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Many' + MAX_ART_CACHED })).status, 200)
  t.is(s.art.seen.length, before + 3, 'and pushes no good cover out')
})

test('audius: a failed fetch of an older href leaves the newer cover held', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  s.state.artwork.Fill7 = { '150x150': 'https://' + ART + '/ArtHang1' }
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  const old = s.post(token, 'art', { kind: 'track', id: 'Fill7' })
  t.ok(await s.until(() => s.art.held.size === 1), 'the old href is in flight')
  s.state.artwork.Fill7 = { '150x150': 'https://' + ART + '/Fill7' }
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill7' }), 'image/jpeg', JPEG)
  for (const res of s.art.held) json(res, 500, {})
  t.is((await old).status, 503, 'the old fetch failed after the newer one landed')
  const before = s.art.seen.length
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill7' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, before, 'the newer cover is still held')
  t.is(s.routes.stats().covers, 1)
})

// --- the 480 cover and song info ---------------------------------------------

const INFO_KEYS = [...TRACK_KEYS, 'genre', 'year'].sort()
const SMALL_LARGE = (small, large) => ({ '150x150': 'https://' + ART + '/' + small, '480x480': 'https://' + ART + '/' + large })

test('audius: art without the size query is unchanged, and size=480 fetches the 480 href cached apart', async (t) => {
  const s = await setup(t, { covers: true, caps: { arts: 10 } })
  const { token } = await s.login()
  s.state.artwork.Fill5 = SMALL_LARGE('Fill5', 'ArtPng1')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/Fill5'], 'no query: the 150x150 href only')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill5' }), 'image/png', PNG)
  t.alike(artPaths(s), ['/Fill5', '/ArtPng1'], 'size=480: the 480x480 href')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill5' }), 'image/png', PNG)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, 2, 'each size is held under its own key')
  t.is(s.routes.stats().covers, 2)
  for (const q of ['?size=48', '?size=0', '?size=480x480', '?size=4800', '?size=', '?Size=480']) {
    artOk(t, await s.post(token, 'art' + q, { kind: 'track', id: 'Fill5' }), 'image/jpeg', JPEG)
  }
  t.is(s.art.seen.length, 2, 'any other size is the small path')
  t.is((await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill5' })).status, 429, 'each request spent one art use, the large ones included')

  // A fresh service: the first size=48 asks the small href only.
  const f = await setup(t, { covers: true })
  const m = await f.login()
  f.state.artwork.Fill6 = SMALL_LARGE('Fill6', 'ArtPng1')
  artOk(t, await f.post(m.token, 'art?size=48', { kind: 'track', id: 'Fill6' }), 'image/jpeg', JPEG)
  artOk(t, await f.post(m.token, 'art?size=0', { kind: 'track', id: 'Fill6' }), 'image/jpeg', JPEG)
  t.alike(artPaths(f), ['/Fill6'])
  // A playlist has a large cover too, and the large path finds its row by id.
  f.state.artwork.Pl7 = SMALL_LARGE('Pl7', 'ArtWebp1')
  artOk(t, await f.post(m.token, 'art?size=480', { kind: 'playlist', id: 'Pl7' }), 'image/webp', WEBP)
  t.alike(artPaths(f), ['/Fill6', '/ArtWebp1'], 'the lookup by id fed the large href')
  t.ok(f.api.seen.some((r) => r.path === '/v1/playlists/Pl7'))
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: a 480 miss answers the small cover in the same art use, and both failing is 404', async (t) => {
  const s = await setup(t, { covers: true, caps: { arts: 7 } })
  const { token } = await s.login()
  s.state.artwork.Big480 = SMALL_LARGE('Small1', 'ArtBig1')
  s.state.artwork.Gif480 = SMALL_LARGE('Small2', 'ArtGif1')
  s.state.artwork.Gone480 = SMALL_LARGE('Small3', 'ArtGone1')
  s.state.artwork.Both480 = SMALL_LARGE('ArtHtml1', 'ArtWave1')
  // Only150 has its fixture's 150x150 artwork and no 480x480.
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Only150' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/Only150'], 'no 480: the small path')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Big480' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Gif480' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Gone480' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/Only150', '/ArtBig1', '/Small1', '/ArtGif1', '/Small2', '/ArtGone1', '/Small3'], 'the 480 first, then the small one')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Big480' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, 7, 'a remembered 480 miss and the held small cover: no host contact')
  const both = await s.post(token, 'art?size=480', { kind: 'track', id: 'Both480' })
  t.is(both.status, 404)
  t.alike(both.json, { error: 'nao-encontrado' })
  t.alike(artPaths(s).slice(7), ['/ArtWave1', '/ArtHtml1'])
  t.is((await s.post(token, 'art?size=480', { kind: 'track', id: 'Both480' })).status, 404, 'both misses are remembered')
  t.is(s.art.seen.length, 9)
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Only150' })).status, 429, 'one art use per request, the fallbacks included')
  t.absent(s.responses.some((r) => r.raw.length > ART_MAX_BYTES), 'nothing of an oversize body is relayed')

  // The same href at both sizes: no second try of what just missed.
  const d = await setup(t, { covers: true })
  const m = await d.login()
  d.state.artwork.Same480 = SMALL_LARGE('ArtBig1', 'ArtBig1')
  t.is((await d.post(m.token, 'art?size=480', { kind: 'track', id: 'Same480' })).status, 404)
  t.alike(artPaths(d), ['/ArtBig1'])
})

test('audius: the sizes never answer each other', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  s.state.artwork.Fill5 = SMALL_LARGE('ArtGif1', 'ArtPng1')
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Fill5' })).status, 404, 'a small miss')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill5' }), 'image/png', PNG)
  t.is((await s.post(token, 'art', { kind: 'track', id: 'Fill5' })).status, 404, 'the large cover never answers the small request')
  s.state.artwork.Fill6 = SMALL_LARGE('Fill6', 'ArtPng1')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill6' }), 'image/png', PNG)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Fill6' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/ArtGif1', '/ArtPng1', '/ArtPng1', '/Fill6'], 'the pending and cached keys are per item and size')

  // A new 480 href replaces the held large cover; a row without one drops it.
  s.state.artwork.Fill6 = SMALL_LARGE('Fill6', 'ArtWebp1')
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill6' }), 'image/webp', WEBP)
  s.state.artwork.Fill6 = { '150x150': 'https://' + ART + '/Fill6' }
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  const before = s.art.seen.length
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Fill6' }), 'image/jpeg', JPEG)
  t.is(s.art.seen.length, before, 'the held small cover, not the dropped large one')
  t.is(s.routes.stats().covers, 3, 'the stale large row was dropped')
})

test('audius: every cached row keeps the 480 href, so the large cover needs no lookup', async (t) => {
  const s = await setup(t, { covers: true })
  s.state.large = true
  const { token } = await s.login()
  const lookups = () => s.api.seen.length
  t.is((await s.post(token, 'resolve', { url: 'https://audius.co/artista/musica' })).status, 200)
  let before = lookups()
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Ranged1' }), 'image/jpeg', JPEG)
  t.is(lookups(), before, 'a resolved track row')
  t.is((await s.post(token, 'resolve', { url: 'https://audius.co/artista/playlist/lista' })).status, 200)
  before = lookups()
  artOk(t, await s.post(token, 'art?size=480', { kind: 'playlist', id: 'Pl1' }), 'image/jpeg', JPEG)
  t.is(lookups(), before, 'a resolved playlist row')
  t.is((await s.post(token, 'item', { kind: 'playlist', id: 'Pl2' })).status, 200)
  before = lookups()
  artOk(t, await s.post(token, 'art?size=480', { kind: 'playlist', id: 'Pl2' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Pt1' }), 'image/jpeg', JPEG)
  t.is(lookups(), before, 'a full playlist row and its tracks')
  t.alike(artPaths(s), ['/Ranged1L', '/Pl1L', '/Pl2L', '/Pt1L'], 'each the 480 href')

  // A kept full playlist row takes the newer 480 href of a search.
  s.state.artwork.Pl1 = SMALL_LARGE('Pl1', 'ArtPng1')
  t.is((await s.post(token, 'item', { kind: 'playlist', id: 'Pl1' })).status, 200)
  s.state.artwork.Pl1 = SMALL_LARGE('Pl1', 'ArtWebp1')
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'playlist' })).status, 200)
  artOk(t, await s.post(token, 'art?size=480', { kind: 'playlist', id: 'Pl1' }), 'image/webp', WEBP)
  const full = await s.post(token, 'item', { kind: 'playlist', id: 'Pl1' })
  t.ok(full.json.tracks.length > 0, 'and kept its tracks')
})

test('audius: the small fallback fetch starts only while a whole art fetch fits in the answer deadline', async (t) => {
  // answerMs 500 and artMs 300: no fallback fetch starts past 200 ms, and the
  // 480 miss alone takes 250 ms.
  const s = await setup(t, { covers: true, caps: { artMs: 300, answerMs: 500, arts: 3 } })
  const { token } = await s.login()
  s.state.artwork.Late480 = SMALL_LARGE('Small1', 'ArtSlowGone1')
  const late = await s.post(token, 'art?size=480', { kind: 'track', id: 'Late480' })
  t.is(late.status, 404, 'too late for another fetch: a miss')
  t.alike(late.json, { error: 'nao-encontrado' })
  t.alike(artPaths(s), ['/ArtSlowGone1'], 'the small cover is not fetched')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Late480' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/ArtSlowGone1', '/Small1'], 'the remembered miss leaves time for the small fetch')
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Late480' }), 'image/jpeg', JPEG)
  t.is((await s.post(token, 'art?size=480', { kind: 'track', id: 'Late480' })).status, 429, 'the late 404 kept its use')

  // A held small cover answers whatever the time.
  const h = await setup(t, { covers: true, caps: { artMs: 300, answerMs: 500 } })
  const m = await h.login()
  h.state.artwork.Late480 = SMALL_LARGE('Small1', 'ArtSlowGone1')
  artOk(t, await h.post(m.token, 'art', { kind: 'track', id: 'Late480' }), 'image/jpeg', JPEG)
  artOk(t, await h.post(m.token, 'art?size=480', { kind: 'track', id: 'Late480' }), 'image/jpeg', JPEG)
  t.alike(artPaths(h), ['/Small1', '/ArtSlowGone1'])

  // With room left, the same slow miss falls back to a fetch.
  const r = await setup(t, { covers: true, caps: { artMs: 300, answerMs: 5000 } })
  const n = await r.login()
  r.state.artwork.Late480 = SMALL_LARGE('Small1', 'ArtSlowGone1')
  artOk(t, await r.post(n.token, 'art?size=480', { kind: 'track', id: 'Late480' }), 'image/jpeg', JPEG)
  t.alike(artPaths(r), ['/ArtSlowGone1', '/Small1'])
  t.is(ART_ANSWER_MS, 20000, 'under the app timeout of 25 s')
})

test('audius: the fallback never joins a small fetch that started past its deadline', async (t) => {
  t.timeout(30 * 1000)
  // artMs 1500 and answerMs 1800: the fallback joins no fetch started more
  // than 300 ms into the request. The 480 miss takes 1000 ms; another
  // member starts the small fetch, held by the host, at 700 ms.
  const s = await setup(t, { covers: true, caps: { artMs: 1500, answerMs: 1800 } })
  const a = await s.login()
  const b = await s.login(s.other)
  s.state.artwork.Join480 = SMALL_LARGE('ArtHang9', 'ArtSlowGone2')
  t.is((await s.post(a.token, 'item', { kind: 'track', id: 'Join480' })).status, 200)
  const started = Date.now()
  const large = s.post(a.token, 'art?size=480', { kind: 'track', id: 'Join480' }).then((res) => ({ res, at: Date.now() - started }))
  await new Promise((resolve) => setTimeout(resolve, 700))
  const small = s.post(b.token, 'art', { kind: 'track', id: 'Join480' }).then((res) => ({ res, at: Date.now() - started }))
  t.ok(await s.until(() => artPaths(s).includes('/ArtHang9')), 'the late small fetch is running')
  const late = await large
  t.is(late.res.status, 404, 'not joined: a miss')
  t.alike(late.res.json, { error: 'nao-encontrado' })
  t.ok(late.at < 1800, 'answered within the deadline: ' + late.at + ' ms')
  t.is((await small).res.status, 503, 'the held fetch fails on its own')
  t.is(artPaths(s).filter((p) => p === '/ArtHang9').length, 1, 'one small fetch, started by the other member')
})

test('audius: a remembered 480 miss with an expired item row is the small request, from the cache', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  s.state.artwork.Big480 = SMALL_LARGE('Small1', 'ArtBig1')
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Big480' })).status, 200)
  // The covers are stored later than the row, so they outlive it.
  s.clock.offset += CACHE_TTL_MS / 2
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Big480' }), 'image/jpeg', JPEG)
  t.alike(artPaths(s), ['/ArtBig1', '/Small1'])
  s.clock.offset += CACHE_TTL_MS / 2 + 1000
  s.state.mode = 'garbage'
  const asked = s.api.seen.length
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Big480' }), 'image/jpeg', JPEG)
  artOk(t, await s.post(token, 'art?size=480', { kind: 'track', id: 'Big480' }), 'image/jpeg', JPEG)
  t.is(s.api.seen.length, asked, 'no lookup: the provider is not asked')
  t.alike(artPaths(s), ['/ArtBig1', '/Small1'], 'nor the art host')
  t.is((await s.post(token, 'item', { kind: 'track', id: 'Big480' })).status, 503, 'the item row is gone and the provider is down')
})

test('audius: a failed 480 fetch answers as is, with no fallback', async (t) => {
  const s = await setup(t, { covers: true, caps: { artMs: 1000, arts: 10 } })
  const { token } = await s.login()
  for (const [id, large] of [['Err480', 'ArtErr1'], ['Busy480', 'ArtBusy1'], ['Loop480', 'ArtLoop1'], ['Part480', 'ArtPartial1']]) {
    s.state.artwork[id] = SMALL_LARGE('Small' + id, large)
    const res = await s.post(token, 'art?size=480', { kind: 'track', id })
    t.is(res.status, 503, id)
    t.alike(res.json, { error: 'indisponivel' })
    t.absent(artPaths(s).includes('/Small' + id), id + ': the small cover is not tried')
  }
  t.is(s.routes.stats().covers, 4, 'each failed 480 is remembered under its own key')
  const seen = artPaths(s).length
  for (const id of ['Err480', 'Busy480', 'Loop480', 'Part480']) {
    const res = await s.post(token, 'art?size=480', { kind: 'track', id })
    t.is(res.status, 503, id + ' remembered')
    t.absent(artPaths(s).includes('/Small' + id), id + ': still no fallback')
  }
  t.is(artPaths(s).length, seen, 'a remembered failure contacts no host')

  // The 480 contact spent the last budget token: the fallback finds the
  // budget spent, answers 503 and keeps the use, as the host was contacted.
  const b = await setup(t, { covers: true, caps: { budget: 2, arts: 1 } })
  const m = await b.login()
  b.state.artwork.Big480 = SMALL_LARGE('Small1', 'ArtBig1')
  const spent = await b.post(m.token, 'art?size=480', { kind: 'track', id: 'Big480' })
  t.is(spent.status, 503)
  t.alike(spent.json, { error: 'indisponivel' })
  t.alike(artPaths(b), ['/ArtBig1'])
  t.is((await b.post(m.token, 'art?size=480', { kind: 'track', id: 'Big480' })).status, 429, 'the use is kept')

  // A remembered 480 miss contacts no host: then a fallback refused before
  // any contact gives the use back.
  const r = await setup(t, { covers: true, caps: { budget: 2, arts: 2 } })
  const n = await r.login()
  r.state.artwork.Big480 = SMALL_LARGE('Small1', 'ArtBig1')
  t.is((await r.post(n.token, 'item', { kind: 'track', id: 'Big480' })).status, 200)
  t.is((await r.post(n.token, 'art?size=480', { kind: 'track', id: 'Big480' })).status, 503, 'budget 2: the item, the 480, then none for the small one')
  const o = await r.login(r.other)
  for (let i = 0; i < 3; i++) t.is((await r.post(o.token, 'art?size=480', { kind: 'track', id: 'Big480' })).status, 503, 'remembered miss, then no budget: 503, not 429')
  t.alike(artPaths(r), ['/ArtBig1'])
})

test('audius: no answer ever carries art, artLarge or an artwork URL, and answers are byte-identical with a 480 cover and song info', async (t) => {
  const plain = await setup(t, { covers: true })
  const rich = await setup(t, { covers: true })
  rich.state.large = true
  rich.state.info = true
  const a = await plain.login()
  const b = await rich.login()
  const bodies = [
    ['search', { q: QUERY, kind: 'track' }],
    ['search', { q: QUERY, kind: 'playlist' }],
    ['item', { kind: 'track', id: 'Plain1' }],
    ['item', { kind: 'playlist', id: 'Pl1' }],
    ['resolve', { url: 'https://audius.co/artista/musica' }],
    ['resolve', { url: 'https://audius.co/artista/playlist/lista' }]
  ]
  for (const q of ['', '?covers=1', '?covers=1&size=480', '?info=0']) {
    for (const [name, body] of bodies) {
      const today = await plain.post(a.token, name + q, body)
      const now = await rich.post(b.token, name + q, body)
      t.is(now.status, 200, name + q)
      t.alike(now.raw, today.raw, name + q + ': unchanged, byte for byte')
    }
  }
  artOk(t, await rich.post(b.token, 'art?size=480', { kind: 'track', id: 'Plain1' }), 'image/jpeg', JPEG)
  artOk(t, await rich.post(b.token, 'art?size=480', { kind: 'playlist', id: 'Pl1' }), 'image/jpeg', JPEG)
  t.ok(artPaths(rich).includes('/Plain1L'), 'the 480 href was fetched')
  for (const q of ['?info=1', '?covers=1&info=1']) {
    for (const [name, body] of bodies) t.is((await rich.post(b.token, name + q, body)).status, 200)
  }
  t.ok(rich.responses.length >= 30)
  for (const r of rich.responses) {
    const text = r.raw.toString('latin1')
    t.absent(text.includes(ART), 'no art host in a body')
    t.absent(text.includes('artwork'), 'no artwork key')
    t.absent(text.includes('"art"'), 'no art key')
    t.absent(text.includes('artLarge'), 'no artLarge key')
    t.absent(text.includes('release_date'), 'no provider date')
    const urls = text.match(/https?:\/\/[^"]*/g) || []
    t.ok(urls.every((u) => u.startsWith('https://audius.co/')), 'no URL but the audius.co page')
    t.absent(JSON.stringify(r.headers).includes(ART), 'no art host in a header')
  }
  t.absent(JSON.stringify(rich.logs).includes(ART), 'no art URL in a log line')
  t.absent(JSON.stringify(rich.logs).includes('Samba'), 'no song info in a log line')
  noKeyAnywhere(t, rich)
})

test('audius: info=1 adds a track genre and year, never to a playlist, and combines with covers', async (t) => {
  const s = await setup(t, { covers: true })
  s.state.info = true
  const { token } = await s.login()
  const tracks = await s.post(token, 'search?info=1', { q: QUERY, kind: 'track' })
  t.is(tracks.status, 200)
  t.ok(tracks.json.items.length > 0)
  for (const it of tracks.json.items) {
    t.alike(Object.keys(it).sort(), INFO_KEYS)
    t.is(it.genre, 'Samba')
    t.is(it.year, 2001)
  }
  const lists = await s.post(token, 'search?info=1', { q: QUERY, kind: 'playlist' })
  for (const it of lists.json.items) t.alike(Object.keys(it).sort(), PLAYLIST_KEYS, 'a playlist never carries song info')
  const one = await s.post(token, 'item?info=1', { kind: 'track', id: 'Plain1' })
  t.alike(one.json, { id: 'Plain1', title: 'Musica Plain1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-plain1', genre: 'Samba', year: 2001 })
  const pl = await s.post(token, 'item?info=1', { kind: 'playlist', id: 'Pl1' })
  t.alike(Object.keys(pl.json).sort(), [...PLAYLIST_KEYS, 'tracks'].sort())
  t.ok(pl.json.tracks.length > 0)
  for (const it of pl.json.tracks) t.alike(Object.keys(it).sort(), INFO_KEYS, 'its tracks do')
  const resolved = await s.post(token, 'resolve?info=1', { url: 'https://audius.co/artista/musica' })
  t.alike(resolved.json.item, { id: 'Ranged1', title: 'Musica Ranged1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-ranged1', genre: 'Samba', year: 2001 })
  const resolvedList = await s.post(token, 'resolve?info=1', { url: 'https://audius.co/artista/playlist/lista' })
  t.alike(Object.keys(resolvedList.json.item).sort(), PLAYLIST_KEYS)

  const both = await s.post(token, 'item?covers=1&info=1', { kind: 'track', id: 'Plain1' })
  t.alike(both.json, { id: 'Plain1', title: 'Musica Plain1', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-plain1', cover: true, genre: 'Samba', year: 2001 })
  const bothList = await s.post(token, 'item?info=1&covers=1', { kind: 'playlist', id: 'Pl1' })
  t.alike(Object.keys(bothList.json).sort(), [...PLAYLIST_KEYS, 'cover', 'tracks'].sort())
  for (const it of bothList.json.tracks) t.alike(Object.keys(it).sort(), [...INFO_KEYS, 'cover'].sort())

  for (const q of ['', '?info=0', '?info=true', '?covers=1']) {
    const plainOne = await s.post(token, 'item' + q, { kind: 'track', id: 'Plain1' })
    t.absent(Object.hasOwn(plainOne.json, 'genre') || Object.hasOwn(plainOne.json, 'year'), 'no song info with ' + JSON.stringify(q))
    const plainList = await s.post(token, 'search' + q, { q: QUERY, kind: 'track' })
    t.absent(plainList.raw.toString('utf8').includes('genre'), 'no genre key with ' + JSON.stringify(q))
  }

  // Each key only when the provider had a usable value.
  s.state.fields.Fill5 = { genre: '  ', release_date: '2001-02-03' }
  s.state.fields.Fill6 = { genre: 'Forró', release_date: 'em breve' }
  s.state.fields.Fill7 = { genre: 7, release_date: '1850-01-01' }
  const mixed = await s.post(token, 'search?info=1', { q: QUERY, kind: 'track' })
  const by = (id) => mixed.json.items.find((x) => x.id === id)
  t.alike(by('Fill5'), { id: 'Fill5', title: 'Musica Fill5', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-fill5', year: 2001 })
  t.alike(by('Fill6'), { id: 'Fill6', title: 'Musica Fill6', artist: 'Artista', duration: 180, url: 'https://audius.co/artista/musica-fill6', genre: 'Forró' })
  t.alike(Object.keys(by('Fill7')).sort(), TRACK_KEYS)
  const cached = await s.post(token, 'item?info=1', { kind: 'track', id: 'Fill6' })
  t.is(cached.json.genre, 'Forró', 'the cached row keeps the song info')

  // Without covers on, info still works and adds no cover.
  const off = await setup(t)
  off.state.info = true
  const m = await off.login()
  const noCovers = await off.post(m.token, 'item?covers=1&info=1', { kind: 'track', id: 'Plain1' })
  t.alike(Object.keys(noCovers.json).sort(), INFO_KEYS)
})

// --- the week's trending list --------------------------------------------------

const trendingCalls = (s) => s.api.seen.filter((r) => r.path === '/v1/tracks/trending').length
const HOT_IDS = ['Hot1', 'Hot6', 'Hot7', 'Hot8', 'Hot9', 'Hot10', 'Hot11', 'Hot12', 'Hot13', 'Hot14', 'Hot15', 'Hot16']

test('audius: trending constants, and the provider allowance formula is unchanged', async (t) => {
  t.is(TRENDINGS_PER_DAY, 200)
  t.is(TRENDING_ASK, 24)
  t.is(TRENDING_RETRY_MS, 60 * 1000)
  t.is(PROVIDER_CALLS_PER_DAY, 1760)
})

test('audius: trending is feature-off when off, and needs a session before any counter', async (t) => {
  const off = await setup(t, { audius: false })
  const res = await off.post(null, 'trending', {})
  t.is(res.status, 404)
  t.alike(res.json, { error: 'feature-off' })

  const s = await setup(t, { caps: { trendings: 1 } })
  for (let i = 0; i < 5; i++) {
    t.is((await s.post(null, 'trending', {})).status, 401, 'without a token')
    t.is((await s.post('A'.repeat(43), 'trending', {})).status, 401, 'with an unknown token')
  }
  t.is(s.api.seen.length, 0, 'the provider was never asked')
  const { token } = await s.login()
  t.is((await s.post(token, 'trending', {})).status, 200, 'the one use was untouched')
})

test('audius: a trending body with any key is refused before any counter or provider call', async (t) => {
  const s = await setup(t, { caps: { trendings: 1 } })
  const { token } = await s.login()
  for (const body of [{ q: 'a' }, { cursor: '0' }, { kind: 'track' }, { time: 'month' }, { limit: 100 }, []]) {
    const res = await s.post(token, 'trending', body)
    t.is(res.status, 400, JSON.stringify(body))
    t.alike(res.json, { error: 'pedido-invalido' })
  }
  t.is(s.api.seen.length, 0, 'nothing reached the provider')
  t.is((await s.post(token, 'trending', {})).status, 200, 'and no use was spent')
  t.is((await s.post(token, 'search', { q: '', kind: 'track' })).status, 400, 'search still refuses a blank query')
})

test('audius: trending answers one page of mapped tracks and asks the provider only the fixed week list', async (t) => {
  const s = await setup(t)
  const { token } = await s.login()
  const res = await s.post(token, 'trending', {})
  t.is(res.status, 200)
  t.alike(Object.keys(res.json).sort(), ['items', 'next'])
  t.is(res.json.next, null)
  t.alike(res.json.items.map((i) => i.id), HOT_IDS, 'the first PAGE_SIZE admitted tracks, each once, in order')
  for (const it of res.json.items) t.alike(Object.keys(it).sort(), TRACK_KEYS)
  t.is(res.json.items[0].title, 'Musica Hot1', 'the first of a duplicate is kept')
  const ids = res.json.items.map((i) => i.id)
  for (const dropped of ['HotGated1', 'HotUnlisted1', 'bad id', 'HotNoUser1']) t.absent(ids.includes(dropped), dropped + ' dropped')

  t.is(s.api.seen.length, 1)
  const asked = s.api.seen[0]
  t.is(asked.path, '/v1/tracks/trending')
  t.alike(asked.query, { time: 'week', limit: '24', offset: '0', app_name: 'varanda' }, 'nothing else rides the URL')
  t.is(asked.headers['x-api-key'], KEY, 'the key rides a header')
  t.is(asked.headers['user-agent'], USER_AGENT)
  t.ok(Object.keys(asked.headers).every((h) => PROVIDER_HEADERS.includes(h)), 'nothing else of ours')
  t.absent(JSON.stringify(asked).includes(s.memberHex), 'never the member key')
  t.absent(JSON.stringify(asked).includes(token), 'never the token')

  t.ok(s.logs.some((e) => e.reason === 'em-alta'), 'logged as em-alta')
  t.absent(JSON.stringify(s.logs).includes(s.memberHex), 'no member in a log line')
  t.absent(JSON.stringify(s.logs).includes('Hot1'), 'no id in a log line')
  noKeyAnywhere(t, s)
  onlyLoopback(t, s)
})

test('audius: trending carries covers and song info only as search does', async (t) => {
  const s = await setup(t, { covers: true })
  s.state.info = true
  const { token } = await s.login()
  const plain = await s.post(token, 'trending', {})
  for (const it of plain.json.items) t.alike(Object.keys(it).sort(), TRACK_KEYS, 'no query, no extra key')
  const withCovers = await s.post(token, 'trending?covers=1', {})
  for (const it of withCovers.json.items) {
    t.alike(Object.keys(it).sort(), [...TRACK_KEYS, 'cover'].sort())
    t.is(it.cover, true)
  }
  const withInfo = await s.post(token, 'trending?info=1', {})
  for (const it of withInfo.json.items) t.alike(Object.keys(it).sort(), INFO_KEYS)
  const both = await s.post(token, 'trending?covers=1&info=1', {})
  for (const it of both.json.items) t.alike(Object.keys(it).sort(), [...INFO_KEYS, 'cover'].sort())
  t.is(trendingCalls(s), 1, 'every variant came from the one list')
  for (const r of s.responses) {
    const text = r.raw.toString('latin1')
    t.absent(text.includes(ART), 'no art host in a body')
    t.absent(text.includes('artLarge') || text.includes('"art"'), 'no art key')
  }

  const off = await setup(t)
  const m = await off.login()
  const res = await off.post(m.token, 'trending?covers=1', {})
  for (const it of res.json.items) t.alike(Object.keys(it).sort(), TRACK_KEYS, 'covers off adds no cover')
})

test('audius: one trending list serves every member for CACHE_TTL_MS, and a clock step back drops it', async (t) => {
  const s = await setup(t)
  const a = await s.login()
  const b = await s.login(s.other)
  for (let i = 0; i < 3; i++) {
    t.is((await s.post(a.token, 'trending', {})).status, 200)
    t.is((await s.post(b.token, 'trending', {})).status, 200)
  }
  t.is(trendingCalls(s), 1, 'one provider call for two members and six requests')
  s.clock.offset += CACHE_TTL_MS - 1000
  t.is((await s.post(b.token, 'trending', {})).status, 200)
  t.is(trendingCalls(s), 1, 'still valid just before the TTL')
  s.clock.offset += 1000
  t.alike((await s.post(a.token, 'trending', {})).json.items.map((i) => i.id), HOT_IDS)
  t.is(trendingCalls(s), 2, 'a new call once the TTL passed')
  s.clock.offset -= CACHE_TTL_MS + 60 * 1000
  t.is((await s.post(a.token, 'trending', {})).status, 200)
  t.is(trendingCalls(s), 3, 'a list too far ahead after a step back is absent')
})

test('audius: an empty admitted trending list is kept and answered', async (t) => {
  const s = await setup(t)
  s.state.trendingData = [track('HotGated1', { is_stream_gated: true }), track('HotUnlisted1', { is_unlisted: true })]
  const { token } = await s.login()
  for (let i = 0; i < 3; i++) {
    const res = await s.post(token, 'trending', {})
    t.is(res.status, 200)
    t.alike(res.json, { items: [], next: null })
  }
  t.is(trendingCalls(s), 1)
})

test('audius: concurrent cold trending requests share one provider call, charged to the member that started it', async (t) => {
  const s = await setup(t, { caps: { calls: 1 } })
  const a = await s.login()
  const b = await s.login(s.other)
  s.state.trendingHold = true
  const first = s.post(a.token, 'trending', {})
  t.ok(await s.until(() => s.state.trendingHeld.length === 1), 'the first request reached the provider')
  const second = s.post(b.token, 'trending', {})
  await settle()
  t.is(s.state.trendingHeld.length, 1, 'the second request joined it')
  s.state.trendingHold = false
  json(s.state.trendingHeld[0], 200, { data: trendingData() })
  const [ra, rb] = await Promise.all([first, second])
  t.is(ra.status, 200)
  t.is(rb.status, 200)
  t.alike(rb.json, ra.json, 'the same list')
  t.is(trendingCalls(s), 1)
  t.is((await s.post(a.token, 'search', { q: QUERY, kind: 'track' })).status, 429, 'the first member paid the call')
  t.is((await s.post(b.token, 'search', { q: QUERY, kind: 'track' })).status, 200, 'the joiner did not')
})

test('audius: a joiner of a failed trending call gets 503, never 429, and its use back', async (t) => {
  const s = await setup(t, { caps: { trendings: 1 } })
  const a = await s.login()
  const b = await s.login(s.other)
  s.state.trendingHold = true
  const first = s.post(a.token, 'trending', {})
  t.ok(await s.until(() => s.state.trendingHeld.length === 1))
  const second = s.post(b.token, 'trending', {})
  await settle()
  s.state.trendingHold = false
  json(s.state.trendingHeld[0], 500, { error: 'erro' })
  const [ra, rb] = await Promise.all([first, second])
  t.is(ra.status, 503)
  t.alike(ra.json, { error: 'indisponivel' })
  t.is(rb.status, 503)
  t.alike(rb.json, { error: 'indisponivel' })
  s.clock.offset += TRENDING_RETRY_MS + 1
  t.is((await s.post(a.token, 'trending', {})).status, 200, 'the leader got its use back')
  t.is((await s.post(b.token, 'trending', {})).status, 200, 'the joiner got its use back')
  t.is(trendingCalls(s), 2, 'the failure cached nothing')
})

test('audius: a leader over its own provider calls gets 429 with its use back and starts no hold', async (t) => {
  const s = await setup(t, { caps: { calls: 1, trendings: 1 } })
  const a = await s.login()
  const b = await s.login(s.other)
  t.is((await s.post(a.token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  const over = await s.post(a.token, 'trending', {})
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-musica' })
  t.is(trendingCalls(s), 0, 'no provider call')
  t.is((await s.post(b.token, 'trending', {})).status, 200, 'another member asks at once: no hold')
  t.is(trendingCalls(s), 1)
  t.is((await s.post(a.token, 'trending', {})).status, 200, 'the use was given back, and the list is a hit')
})

test('audius: the trendings cap answers 429 with no provider call, apart from the search cap', async (t) => {
  const s = await setup(t, { caps: { trendings: 2 } })
  const { token } = await s.login()
  t.is((await s.post(token, 'trending', {})).status, 200)
  t.is((await s.post(token, 'trending', {})).status, 200, 'a hit spends a use too')
  const seen = s.api.seen.length
  const over = await s.post(token, 'trending', {})
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-musica' })
  t.is(s.api.seen.length, seen, 'no provider call over the cap')
  t.is((await s.post(token, 'search', { q: QUERY, kind: 'track' })).status, 200, 'a member at the trendings cap still searches')
  const other = await s.login(s.other)
  t.is((await s.post(other.token, 'trending', {})).status, 200, 'per member')

  const q = await setup(t)
  const m = await q.login()
  let wrong = 0
  for (let i = 0; i < SEARCHES_PER_DAY; i++) if ((await q.post(m.token, 'search', { q: QUERY, kind: 'track' })).status !== 200) wrong++
  t.is(wrong, 0)
  t.is((await q.post(m.token, 'search', { q: QUERY, kind: 'track' })).status, 429, 'at the search cap')
  t.is((await q.post(m.token, 'trending', {})).status, 200, 'the list still answers')
})

test('audius: a trending outage or garbage answers 503, gives the use back, caches nothing and holds for TRENDING_RETRY_MS', async (t) => {
  for (const fail of ['status', 'garbage']) {
    const s = await setup(t, { caps: { trendings: 1 } })
    const { token } = await s.login()
    if (fail === 'status') s.state.trendingStatus = 503
    else s.state.mode = 'garbage'
    const res = await s.post(token, 'trending', {})
    t.is(res.status, 503, fail)
    t.alike(res.json, { error: 'indisponivel' })
    t.is(s.api.seen.length, 1)
    s.state.trendingStatus = 0
    s.state.mode = 'ok'
    const held = await s.post(token, 'trending', {})
    t.is(held.status, 503, fail + ': held')
    t.is(s.api.seen.length, 1, fail + ': no provider call during the hold')
    s.clock.offset += TRENDING_RETRY_MS
    t.is((await s.post(token, 'trending', {})).status, 200, fail + ': the uses were given back')
    t.is(trendingCalls(s), 2, fail + ': nothing was cached')
    noKeyAnywhere(t, s)
  }
})

test('audius: a provider 4xx to the trending list is 503 with the use back, and the hold spares the provider', async (t) => {
  for (const code of [400, 404, 403, 429]) {
    const s = await setup(t, { caps: { trendings: 1 } })
    const a = await s.login()
    const b = await s.login(s.other)
    s.state.trendingStatus = code
    const res = await s.post(a.token, 'trending', {})
    t.is(res.status, 503, code + ': never 400 or 404')
    t.alike(res.json, { error: 'indisponivel' })
    t.is(trendingCalls(s), 1)
    s.state.trendingStatus = 0
    const held = await s.post(b.token, 'trending', {})
    t.is(held.status, 503, code + ': another member during the hold')
    t.alike(held.json, { error: 'indisponivel' })
    t.is(trendingCalls(s), 1, code + ': with no provider call')
    s.clock.offset += TRENDING_RETRY_MS - 1000
    t.is((await s.post(b.token, 'trending', {})).status, 503, code + ': still held')
    t.is(trendingCalls(s), 1)
    s.clock.offset += 1000
    const ok = await s.post(b.token, 'trending', {})
    t.is(ok.status, 200, code + ': the joiner of the hold had its use back')
    t.is(trendingCalls(s), 2, code + ': the provider is asked again after the hold')
    t.is((await s.post(a.token, 'trending', {})).status, 200, code + ': the leader had its use back, and the list is cached')
    t.is(trendingCalls(s), 2)
  }
})

test('audius: a trending miss refused before any provider contact starts no hold', async (t) => {
  const s = await setup(t, { caps: { calls: 18, trendings: 1 } })
  const { token } = await s.login()
  const held = []
  for (let i = 0; i < 16; i++) held.push(s.post(token, 'item', { kind: 'track', id: 'Slow' + i }))
  t.ok(await s.until(() => s.routes.stats().inflight === 16 && s.state.slow.length === 16), 'sixteen calls in flight')
  const busy = await s.post(token, 'trending', {})
  t.is(busy.status, 503, 'lotado')
  t.alike(busy.json, { error: 'indisponivel' })
  for (const { id, res } of s.state.slow) json(res, 200, { data: track(id) })
  await Promise.all(held)
  t.is((await s.post(token, 'trending', {})).status, 200, 'no hold, and the use was given back')
  t.is(trendingCalls(s), 1)

  const b = await setup(t, { caps: { budget: 1 } })
  const m = await b.login()
  t.is((await b.post(m.token, 'search', { q: QUERY, kind: 'track' })).status, 200)
  const spent = await b.post(m.token, 'trending', {})
  t.is(spent.status, 503, 'a spent budget')
  t.ok(b.logs.some((e) => e.reason === 'orcamento'), 'logged as orcamento')
  t.is(trendingCalls(b), 0)
})

test('audius: a listed track plays and shows its cover with no new lookup, and a hit does not extend its row', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  t.is((await s.post(token, 'trending?covers=1', {})).status, 200)
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Hot7' }), 'image/jpeg', JPEG)
  t.ok(await s.ticketFor(token, 'Hot8'))
  t.absent(s.api.seen.some((r) => r.path === '/v1/tracks/Hot7' || r.path === '/v1/tracks/Hot8'), 'no lookup by id')

  s.clock.offset += CACHE_TTL_MS / 2
  t.is((await s.post(token, 'trending', {})).status, 200, 'a hit')
  s.clock.offset += CACHE_TTL_MS / 2 - 5000
  t.is((await s.post(token, 'trending', {})).status, 200, 'still a hit')
  t.is(trendingCalls(s), 1)
  s.clock.offset += 6000
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Hot9' }), 'image/jpeg', JPEG)
  t.ok(s.api.seen.some((r) => r.path === '/v1/tracks/Hot9'), 'the row expired with the list: the hits did not refresh it')
})

test('audius: a trending hit reads each cover flag from the track row a later search replaced', async (t) => {
  const s = await setup(t, { covers: true })
  const { token } = await s.login()
  s.state.trendingData = [track('Pt0')]
  s.state.artwork.Pt0 = undefined
  const first = await s.post(token, 'trending?covers=1', {})
  t.alike(first.json.items.map((x) => [x.id, x.cover]), [['Pt0', false]])
  delete s.state.artwork.Pt0
  const found = await s.post(token, 'search?covers=1', { q: 'faixas', kind: 'track' })
  t.alike(found.json.items.map((x) => [x.id, x.cover]), [['Pt0', true]])
  const hit = await s.post(token, 'trending?covers=1', {})
  t.alike(hit.json.items.map((x) => [x.id, x.cover]), [['Pt0', true]], 'the newer row wins, as the art route reads it')
  t.is(trendingCalls(s), 1, 'still a hit')
  artOk(t, await s.post(token, 'art', { kind: 'track', id: 'Pt0' }), 'image/jpeg', JPEG)
})
