'use strict'

// apps/cli/lib/account/audius-routes.js mounted in the real account server,
// against two loopback fixtures: a fake Audius API and a storage node the
// stream redirects to. Both are plain HTTP on 127.0.0.1, reached through the
// injected audiusTransport (each name mapped to its fixture's port): no
// socket leaves loopback. The route behaviour itself is covered by
// audius-routes.test.js; this file checks what the server adds around it.

const test = require('brittle')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { signInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { createAccountServer, ERROR_STATUS } = require('../lib/account/server')
const { openTermsStore } = require('../lib/account/terms-store')
const { parseAudiusConfig } = require('../lib/account/audius-provider')

const ORIGIN = 'https://varanda.test'
const KEY = 'chave-sentinela-audius-42'
const API = 'api.audius.test'
const NODE = 'node.audius.test'
const ART = 'art.audius.test'
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)])
const AUDIO = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
// Longer than the server's REQUEST_TIMEOUT_MS (10 s) plus one check interval.
const SLOW_CHUNKS = 12
const SLOW_EVERY_MS = 1000

function track (id) {
  return {
    id,
    title: 'Musica ' + id,
    duration: 180,
    permalink: '/artista/musica-' + id.toLowerCase(),
    user: { name: 'Artista', id: 'u1' },
    artwork: { '150x150': 'https://' + ART + '/' + id },
    is_streamable: true,
    is_stream_gated: false,
    access: { stream: true }
  }
}

function fixture (route) {
  const server = http.createServer(route)
  return {
    port: 0,
    async listen () {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      this.port = server.address().port
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
}

function fakeApi () {
  return fixture((req, res) => {
    const url = new URL(req.url, 'http://' + API)
    let m = url.pathname.match(/^\/v1\/tracks\/([A-Za-z0-9]+)\/stream$/)
    if (m) {
      res.writeHead(302, { Location: 'https://' + NODE + '/audio/' + m[1] })
      return res.end()
    }
    m = url.pathname.match(/^\/v1\/tracks\/([A-Za-z0-9]+)$/)
    if (m) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ data: track(m[1]) }))
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
}

function fakeNode () {
  const timers = new Set()
  const node = fixture((req, res) => {
    const id = new URL(req.url, 'http://' + NODE).pathname.slice('/audio/'.length)
    const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d+)-(\d*)$/) : null
    if (id === 'Ranged1') {
      if (range === null) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes' })
        return res.end(AUDIO)
      }
      const start = Number(range[1])
      const end = range[2] === '' ? AUDIO.length - 1 : Math.min(Number(range[2]), AUDIO.length - 1)
      res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes ' + start + '-' + end + '/' + AUDIO.length, 'Content-Length': end - start + 1, 'Cache-Control': 'public, max-age=3600' })
      return res.end(AUDIO.subarray(start, end + 1))
    }
    if (id === 'Slow1') {
      // One byte a second, so the stall timer never fires but the response
      // outlives the server's request timeout.
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': SLOW_CHUNKS })
      let sent = 0
      const timer = setInterval(() => {
        res.write(Buffer.from([sent]))
        if (++sent === SLOW_CHUNKS) {
          clearInterval(timer)
          timers.delete(timer)
          res.end()
        }
      }, SLOW_EVERY_MS)
      timers.add(timer)
      res.on('close', () => { clearInterval(timer); timers.delete(timer) })
      return
    }
    res.writeHead(404)
    res.end()
  })
  node.timers = timers
  return node
}

function fakeArt () {
  const art = fixture((req, res) => {
    art.seen.push(req.headers)
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length })
    res.end(JPEG)
  })
  art.seen = []
  return art
}

async function setup (t, { audius = true, moments = false, covers = false, caps } = {}) {
  const api = fakeApi()
  const node = fakeNode()
  const art = fakeArt()
  await api.listen()
  await node.listen()
  await art.listen()
  const ports = { [API]: api.port, [NODE]: node.port, [ART]: art.port }
  const audiusTransport = {
    request: (opts) => http.request({ ...opts, port: ports[opts.hostname] }),
    lookup: (host, opts, cb) => {
      if (host === API || host === NODE || host === ART) return cb(null, [{ address: '127.0.0.1', family: 4 }])
      const err = new Error('ENOTFOUND')
      err.code = 'ENOTFOUND'
      cb(err)
    },
    allowAddress: (ip) => ip === '127.0.0.1'
  }
  if (caps !== undefined) audiusTransport.caps = caps

  const association = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const member = crypto.keyPair()
  const memberHex = b4a.toString(member.publicKey, 'hex')
  const store = {
    start () {},
    status: (m) => ({ linked: m === memberHex })
  }
  const moderation = { blocked: () => [] }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-audius-server-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const terms = openTermsStore(dir)
  terms.accept({ member: memberHex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const logs = []
  const config = audius ? parseAudiusConfig({ apiKey: KEY, apiUrl: 'https://' + API + '/v1', moments, covers }) : null
  const opts = { association, origin: ORIGIN, store, terms, log: (e) => logs.push(e), moderation, ratePerSecond: 10000, burst: 10000 }
  if (config !== null) {
    opts.audius = config
    opts.audiusTransport = audiusTransport
  }
  const server = createAccountServer(opts)
  const svc = await server.listen({ port: 0 })
  t.teardown(async () => {
    for (const timer of node.timers) clearInterval(timer)
    await svc.close()
    await api.close()
    await node.close()
    await art.close()
  })

  // Resolves on end or on a cut, with `complete` false for a cut body.
  function call (method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? null : JSON.stringify(body)
      const h = { ...headers }
      if (text !== null) {
        h['Content-Type'] = 'application/json'
        h.Origin = ORIGIN
        h['Content-Length'] = Buffer.byteLength(text)
      }
      const req = http.request({ host: '127.0.0.1', port: svc.port, method, path, headers: h, agent: false }, (res) => {
        const chunks = []
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          const raw = Buffer.concat(chunks)
          let json = null
          try { json = JSON.parse(raw.toString('utf8')) } catch {}
          resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, raw, json, complete: res.complete })
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

  async function login () {
    const start = await call('POST', '/account/audius/session/start', { body: { member: memberHex } })
    if (start.status !== 200) throw new Error('session/start ' + start.status + ' ' + JSON.stringify(start.json))
    const signature = signInvite({ action: 'summary', nonce: start.json.nonce, member: memberHex, association }, member)
    const finish = await call('POST', '/account/audius/session/finish', { body: { member: memberHex, nonce: start.json.nonce, signature } })
    if (finish.status !== 200) throw new Error('session/finish ' + finish.status + ' ' + JSON.stringify(finish.json))
    return finish.json.token
  }

  async function ticketFor (token, id) {
    const res = await call('POST', '/account/audius/play', { body: { id }, headers: { Authorization: 'Bearer ' + token } })
    if (res.status !== 200) throw new Error('play ' + res.status + ' ' + JSON.stringify(res.json))
    return res.json.ticket
  }

  const audio = (ticket, headers = {}) => call('GET', '/account/audius/audio/' + ticket, { headers })

  return { server, svc, call, login, ticketFor, audio, logs, art }
}

function headerCount (rawHeaders, name) {
  let n = 0
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) n++
  return n
}

test('audius server: off by default, the policy answers and every other route is 404 feature-off', async (t) => {
  const { call } = await setup(t, { audius: false })
  const policy = await call('GET', '/account/audius/policy')
  t.is(policy.status, 200)
  t.alike(policy.json, { enabled: false, moments: false })
  for (const [method, path, body] of [
    ['POST', '/account/audius/session/start', { member: 'a'.repeat(64) }],
    ['POST', '/account/audius/search', { q: 'samba', kind: 'track' }],
    ['GET', '/account/audius/audio/' + 'A'.repeat(43)],
    ['GET', '/account/audius/other']
  ]) {
    const res = await call(method, path, { body })
    t.is(res.status, 404, method + ' ' + path)
    t.alike(res.json, { error: 'feature-off' })
  }
})

test('audius server: a config turns the policy on', async (t) => {
  const on = await setup(t)
  t.alike((await on.call('GET', '/account/audius/policy')).json, { enabled: true, moments: false })
  const withMoments = await setup(t, { moments: true })
  t.alike((await withMoments.call('GET', '/account/audius/policy')).json, { enabled: true, moments: true })
})

test('audius server: an unknown /account/audius path is 404', async (t) => {
  const { call } = await setup(t)
  for (const [method, path] of [['GET', '/account/audius'], ['GET', '/account/audius/other'], ['POST', '/account/audius/other'], ['GET', '/account/audius/search']]) {
    const res = await call(method, path, method === 'POST' ? { body: {} } : {})
    t.is(res.status, 404, method + ' ' + path)
    t.alike(res.json, { error: 'nao-encontrado' })
  }
})

test('audius server: limite-musica answers 429, and a capped stream is cut without a JSON tail', async (t) => {
  t.is(ERROR_STATUS['limite-musica'], 429, 'the token is in the error table')
  const { login, ticketFor, audio } = await setup(t, { caps: { dailyBytes: 40 } })
  const token = await login()
  const ticket = await ticketFor(token, 'Ranged1')
  const cut = await audio(ticket)
  t.is(cut.status, 200)
  t.is(cut.complete, false, 'the body is cut at the daily cap')
  t.alike(cut.raw, AUDIO.subarray(0, 40), 'only audio bytes, nothing appended')
  const over = await audio(ticket)
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-musica' })
})

test('audius server: a ranged audio request answers 206 with Content-Range and one Cache-Control', async (t) => {
  const { login, ticketFor, audio } = await setup(t)
  const token = await login()
  const ticket = await ticketFor(token, 'Ranged1')
  const res = await audio(ticket, { Range: 'bytes=10-19' })
  t.is(res.status, 206)
  t.is(res.headers['content-range'], 'bytes 10-19/100')
  t.is(res.headers['content-type'], 'audio/mpeg')
  t.is(res.headers['cache-control'], 'no-store')
  t.is(headerCount(res.rawHeaders, 'cache-control'), 1, 'Cache-Control is sent once')
  t.ok(res.complete)
  t.alike(res.raw, AUDIO.subarray(10, 20))
})

test('audius server: an audio response longer than the request timeout is not cut', async (t) => {
  t.timeout(60 * 1000)
  const { server, login, ticketFor, audio } = await setup(t)
  const token = await login()
  const ticket = await ticketFor(token, 'Slow1')
  const started = Date.now()
  const res = await audio(ticket)
  const elapsed = Date.now() - started
  t.is(res.status, 200)
  t.ok(elapsed > 11000, 'the stream lasted ' + elapsed + ' ms')
  t.ok(res.complete, 'the whole body arrived')
  t.alike(res.raw, Buffer.from(Array.from({ length: SLOW_CHUNKS }, (_, i) => i)))
  t.is(server.audiusStats().streams, 0, 'the stream slot was released')
})

test('audius server: the Host check still applies', async (t) => {
  const { login, ticketFor, call } = await setup(t)
  const token = await login()
  const ticket = await ticketFor(token, 'Ranged1')
  for (const path of ['/account/audius/policy', '/account/audius/audio/' + ticket]) {
    const res = await call('GET', path, { headers: { Host: 'evil.test' } })
    t.is(res.status, 421, path)
    t.alike(res.json, { error: 'pedido-invalido' })
  }
})

test('audius server: the GIF routes are unaffected', async (t) => {
  const { call } = await setup(t)
  const policy = await call('GET', '/account/gif/policy')
  t.is(policy.status, 200)
  t.alike(policy.json, { enabled: false })
  const other = await call('GET', '/account/gif/other')
  t.is(other.status, 404)
  t.alike(other.json, { error: 'feature-off' })
})

test('audius server: covers ride the query, the policy keeps its keys, and art sends nosniff and no-store once', async (t) => {
  const { server, call, login, art } = await setup(t, { covers: true })
  const policy = await call('GET', '/account/audius/policy')
  t.alike(policy.json, { enabled: true, moments: false }, 'installed apps parse the policy with exact keys')
  const token = await login()
  const auth = { Authorization: 'Bearer ' + token }
  const plain = await call('POST', '/account/audius/item', { body: { kind: 'track', id: 'Plain1' }, headers: auth })
  t.alike(Object.keys(plain.json).sort(), ['artist', 'duration', 'id', 'title', 'url'])
  const covered = await call('POST', '/account/audius/item?covers=1', { body: { kind: 'track', id: 'Plain1' }, headers: auth })
  t.is(covered.json.cover, true)
  t.absent(covered.raw.toString('latin1').includes(ART), 'no artwork URL in the answer')
  const res = await call('POST', '/account/audius/art', { body: { kind: 'track', id: 'Plain1' }, headers: auth })
  t.is(res.status, 200)
  t.alike(res.json, { mime: 'image/jpeg', bytes: JPEG.toString('base64') })
  t.is(res.headers['x-content-type-options'], 'nosniff')
  t.is(res.headers['cache-control'], 'no-store')
  t.is(headerCount(res.rawHeaders, 'x-content-type-options'), 1, 'nosniff is sent once')
  t.is(headerCount(res.rawHeaders, 'cache-control'), 1, 'Cache-Control is sent once')
  t.is(art.seen.length, 1)
  t.absent(JSON.stringify(art.seen).includes(KEY), 'the key never reaches the art host')
  t.absent(JSON.stringify(art.seen).includes(token), 'nor the member token')
  t.is(server.audiusStats().covers, 1)
})

test('audius server: art is feature-off while covers are off', async (t) => {
  const { call, login, art } = await setup(t)
  const token = await login()
  const res = await call('POST', '/account/audius/art', { body: { kind: 'track', id: 'Plain1' }, headers: { Authorization: 'Bearer ' + token } })
  t.is(res.status, 404)
  t.alike(res.json, { error: 'feature-off' })
  const covered = await call('POST', '/account/audius/item?covers=1', { body: { kind: 'track', id: 'Plain1' }, headers: { Authorization: 'Bearer ' + token } })
  t.absent('cover' in covered.json, 'no cover key while the switch is off')
  t.is(art.seen.length, 0)
})
