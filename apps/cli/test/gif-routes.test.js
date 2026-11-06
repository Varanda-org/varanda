'use strict'

// apps/cli/lib/account/gif-routes.js through the real account server, against
// a loopback fake provider that speaks the Giphy-compatible search shape. The
// provider is plain HTTP on 127.0.0.1 reached through an injected request,
// lookup and address check: no socket leaves loopback, and the production
// address check is shown to refuse that same loopback provider.

const test = require('brittle')
const http = require('node:http')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { signInvite } = require('@varanda/core/lib/invite')
const { createAccountServer } = require('../lib/account/server')
const { openTermsStore } = require('../lib/account/terms-store')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseGifConfig, publicAddress, fromProvider, createGifRoutes, TINY_CAP, SEARCHES_PER_DAY, FULL_PER_DAY, FINISH_LIMIT, USER_AGENT } = require('../lib/account/gif-routes')

const ORIGIN = 'https://varanda.test'
const KEY = 'chave-sentinela-gif-42'
const QUERY = 'gatinho-sentinela'
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 1)])

function fakeProvider () {
  const seen = []
  let port = 0
  let mode = 'ok'
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://gif.test')
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers })
    if (url.pathname === '/v1/gifs/search') {
      if (mode === 'fail') {
        res.writeHead(500)
        return res.end()
      }
      const base = 'https://gif.test:' + port + '/media/'
      const item = (id, extra = {}) => ({
        id,
        url: 'https://provider.example/' + id,
        images: {
          fixed_width_small: { url: base + id + '/tiny.gif', width: '100', height: '80', size: '2048' },
          original: { url: base + id + '/full.gif', width: 480, height: 384, size: '90000' }
        },
        ...extra
      })
      const evil = item('evilhost')
      evil.images.original.url = 'https://evil.test/x.gif'
      const plain = item('plainhttp')
      plain.images.fixed_width_small.url = 'http://gif.test:' + port + '/media/plainhttp/tiny.gif'
      const badId = item('bad id')
      const badSize = item('badsize')
      badSize.images.original.size = '12.5'
      const body = {
        data: [item('abc123'), item('notgif'), item('huge'), item('hop'), item('away'), evil, plain, badId, badSize],
        pagination: { offset: Number(url.searchParams.get('offset')), count: 9, total_count: 100 }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(body))
    }
    const m = url.pathname.match(/^\/media\/([^/]+)\/(tiny|full)\.gif$/)
    if (m) {
      const [, id] = m
      if (id === 'notgif') {
        res.writeHead(200, { 'Content-Type': 'image/gif' })
        return res.end('<html>not a gif</html>')
      }
      if (id === 'huge') {
        res.writeHead(200, { 'Content-Type': 'image/gif' })
        return res.end(Buffer.concat([GIF, Buffer.alloc(TINY_CAP)]))
      }
      if (id === 'hop') {
        res.writeHead(302, { Location: '/media/abc123/' + m[2] + '.gif' })
        return res.end()
      }
      if (id === 'away') {
        res.writeHead(302, { Location: 'https://evil.test/x.gif' })
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end(GIF)
    }
    res.writeHead(404)
    res.end()
  })
  return {
    seen,
    setMode (m) { mode = m },
    async listen () {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = server.address().port
      return port
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
}

const loopbackTransport = {
  request: (opts) => http.request(opts),
  lookup: (host, opts, cb) => {
    if (host === 'gif.test') return cb(null, [{ address: '127.0.0.1', family: 4 }])
    const err = new Error('ENOTFOUND')
    err.code = 'ENOTFOUND'
    cb(err)
  },
  allowAddress: (ip) => ip === '127.0.0.1'
}

async function setup (t, { gif = true, transport = loopbackTransport, accepted = true } = {}) {
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const provider = fakeProvider()
  const port = await provider.listen()
  const association = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const member = crypto.keyPair()
  const memberHex = b4a.toString(member.publicKey, 'hex')
  const logs = []
  const linked = new Set([memberHex])
  const blocked = new Set()
  const store = {
    start () {},
    status: (m) => ({ linked: linked.has(m) })
  }
  const moderation = { blocked: () => [...blocked].map((m) => ({ member: m })) }
  const google = { authorizeUrl () {}, exchange () {} }
  const config = gif ? parseGifConfig({ apiUrl: 'https://gif.test:' + port + '/v1', apiKey: KEY }) : null
  // The GIF session needs the current terms (v20 describes the provider).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-gif-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const terms = openTermsStore(dir)
  if (accepted) terms.accept({ member: memberHex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const server = createAccountServer({ association, origin: ORIGIN, google, store, terms, log: (e) => logs.push(e), gif: config, gifTransport: transport, moderation, now, ratePerSecond: 10000, burst: 10000 })
  const svc = await server.listen({ port: 0 })
  t.teardown(async () => {
    await svc.close()
    await provider.close()
  })

  function call (method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? null : JSON.stringify(body)
      const h = { ...headers }
      if (text !== null) {
        h['Content-Type'] = 'application/json'
        h.Origin = ORIGIN
        h['Content-Length'] = Buffer.byteLength(text)
      }
      const req = http.request({ host: '127.0.0.1', port: svc.port, method, path, headers: h }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let json = null
          try { json = JSON.parse(raw.toString('utf8')) } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json })
        })
      })
      req.on('error', reject)
      if (text !== null) req.write(text)
      req.end()
    })
  }

  async function login (kp = member) {
    const hex = b4a.toString(kp.publicKey, 'hex')
    const start = await call('POST', '/account/gif/session/start', { body: { member: hex } })
    if (start.status !== 200) return { start }
    const signature = signInvite({ action: 'summary', nonce: start.json.nonce, member: hex, association }, kp)
    const finish = await call('POST', '/account/gif/session/finish', { body: { member: hex, nonce: start.json.nonce, signature } })
    return { start, finish, token: finish.json && finish.json.token }
  }

  function search (token, body) {
    return call('POST', '/account/gif/search', { body, headers: token === null ? {} : { Authorization: 'Bearer ' + token } })
  }

  return { provider, port, call, login, search, logs, server, member, memberHex, association, linked, blocked, clock, terms }
}

function urlKeys (value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => urlKeys(v, path + '[' + i + ']', out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/url/i.test(k)) out.push(path + '.' + k)
      urlKeys(v, path + '.' + k, out)
    }
  } else if (typeof value === 'string' && /^https?:|\/\//.test(value)) out.push(path)
  return out
}

test('gif: off answers the policy and 404 feature-off everywhere else', async (t) => {
  const { call } = await setup(t, { gif: false })
  const policy = await call('GET', '/account/gif/policy')
  t.is(policy.status, 200)
  t.alike(policy.json, { enabled: false })
  for (const [method, path, body] of [['POST', '/account/gif/search', { q: 'a' }], ['GET', '/account/gif/image/abc?size=tiny'], ['POST', '/account/gif/session/start', { member: 'a'.repeat(64) }], ['GET', '/account/gif/other']]) {
    const res = await call(method, path, { body })
    t.is(res.status, 404, method + ' ' + path)
    t.alike(res.json, { error: 'feature-off' })
  }
})

test('gif: a session needs a linked member and its invite summary signature', async (t) => {
  const { call, login, search, logs } = await setup(t)
  t.alike((await call('GET', '/account/gif/policy')).json, { enabled: true })

  const stranger = await login(crypto.keyPair())
  t.is(stranger.start.status, 403)
  t.is(stranger.start.json.error, 'nao-vinculado')

  const ok = await login()
  t.is(ok.finish.status, 200)
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(ok.token), 'opaque token')

  const noToken = await search(null, { q: 'gato' })
  t.is(noToken.status, 401)
  t.is(noToken.json.error, 'nao-autorizado')
  t.is((await search('A'.repeat(43), { q: 'gato' })).status, 401, 'unknown token')
  t.absent(JSON.stringify(logs).includes(ok.token), 'token never logged')
})

test('gif: the token travels only as Authorization Bearer, the search only as a POST body', async (t) => {
  const { call, login, search } = await setup(t)
  const { token } = await login()
  const body = { q: 'gato' }
  t.is((await call('POST', '/account/gif/search', { body, headers: { 'x-varanda-gif': token } })).status, 401, 'the old header is not read')
  t.is((await call('POST', '/account/gif/search', { body, headers: { Authorization: 'bearer ' + token } })).status, 200, 'scheme is case-insensitive')
  t.is((await call('POST', '/account/gif/search', { body, headers: { Authorization: 'Bearer  ' + token } })).status, 401, 'exactly one space')
  t.is((await call('POST', '/account/gif/search', { body, headers: { Authorization: 'Basic ' + token } })).status, 401, 'other scheme')
  t.is((await call('POST', '/account/gif/search', { body, headers: { Authorization: 'Bearer ' + token + 'x' } })).status, 401, 'token rules unchanged')
  t.is((await search(token, body)).status, 200)

  const get = await call('GET', '/account/gif/search?q=gato', { headers: { Authorization: 'Bearer ' + token } })
  t.is(get.status, 404, 'GET search no longer exists')
  t.alike(get.json, { error: 'nao-encontrado' })

  t.is((await search(token, { q: 'gato', extra: 1 })).status, 400, 'only q and cursor')
  const big = await search(token, { q: 'gato', cursor: 'x'.repeat(5000) })
  t.is(big.status, 413, 'body bounded like the other JSON routes')
})

test('gif: a wrong signature does not spend the nonce, and a verified nonce works once', async (t) => {
  const { call, member, memberHex, association } = await setup(t)
  const start = await call('POST', '/account/gif/session/start', { body: { member: memberHex } })
  const other = crypto.keyPair()
  const forged = signInvite({ action: 'summary', nonce: start.json.nonce, member: memberHex, association }, other)
  const bad = await call('POST', '/account/gif/session/finish', { body: { member: memberHex, nonce: start.json.nonce, signature: forged } })
  t.is(bad.status, 400)
  t.is(bad.json.error, 'assinatura-invalida')
  const signature = signInvite({ action: 'summary', nonce: start.json.nonce, member: memberHex, association }, member)
  const body = { member: memberHex, nonce: start.json.nonce, signature }
  t.is((await call('POST', '/account/gif/session/finish', { body })).status, 200, 'a forged attempt left the nonce usable')
  const again = await call('POST', '/account/gif/session/finish', { body })
  t.is(again.status, 404, 'a verified nonce is single-use')
  t.is(again.json.error, 'expirado')
})

test('gif: a nonce is bound to its member, its bytes and its expiry', async (t) => {
  const { call, member, memberHex, linked, association, terms, clock } = await setup(t)
  const b = crypto.keyPair()
  const bHex = b4a.toString(b.publicKey, 'hex')
  linked.add(bHex)
  terms.accept({ member: bHex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const finish = (kp, hex, nonce) => call('POST', '/account/gif/session/finish', { body: { member: hex, nonce, signature: signInvite({ action: 'summary', nonce, member: hex, association }, kp) } })

  const forA = (await call('POST', '/account/gif/session/start', { body: { member: memberHex } })).json.nonce
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(forA), '43 base64url characters')
  const crossed = await finish(b, bHex, forA)
  t.is(crossed.status, 404, 'a nonce minted for A does not verify for B')
  t.is(crossed.json.error, 'expirado')

  const bytes = Buffer.from(forA, 'base64url')
  for (const i of [0, 12, 31]) {
    const copy = Buffer.from(bytes)
    copy[i] ^= 1
    const res = await finish(member, memberHex, copy.toString('base64url'))
    t.is(res.status, 404, 'byte ' + i + ' tampered')
    t.is(res.json.error, 'expirado')
  }
  const later = Buffer.from(bytes)
  later.writeUInt32BE(later.readUInt32BE(12) + 3600, 12)
  t.is((await finish(member, memberHex, later.toString('base64url'))).status, 404, 'a pushed-out expiry fails the MAC')
  t.is((await finish(member, memberHex, 'A'.repeat(43))).status, 404, 'a random nonce')

  clock.offset += 601 * 1000
  const expired = await finish(member, memberHex, forA)
  t.is(expired.status, 404, 'expired after 600 s')
  t.is(expired.json.error, 'expirado')
})

test('gif: search returns ids and sizes only, never a provider URL, and nothing of the member reaches the provider', async (t) => {
  const { call, login, search, provider, logs } = await setup(t)
  const { token } = await login()
  const res = await call('POST', '/account/gif/search', { body: { q: QUERY, cursor: '' }, headers: { Authorization: 'Bearer ' + token, Cookie: '__Host-varanda-link=x' } })
  t.is(res.status, 200)
  t.alike(Object.keys(res.json).sort(), ['items', 'next'])
  t.alike(res.json.items.map((i) => i.id), ['abc123', 'notgif', 'huge', 'hop', 'away'], 'evil host, http URL, bad id and bad size dropped')
  t.alike(res.json.items[0], { id: 'abc123', width: 480, height: 384, bytes: 90000 })
  t.alike(urlKeys(res.json), [], 'no URL key or URL value anywhere')
  t.absent(res.raw.toString().includes('gif.test'), 'no provider host in the body')
  t.is(res.json.next, '9')

  const hit = provider.seen.find((s) => s.path === '/v1/gifs/search')
  t.is(hit.query.api_key, KEY)
  t.is(hit.query.q, QUERY)
  t.is(hit.query.offset, '0')
  t.is(hit.query.rating, 'g')
  t.is(hit.headers['user-agent'], USER_AGENT)
  for (const name of ['cookie', 'authorization', 'x-varanda-gif', 'referer', 'origin', 'x-forwarded-for']) t.absent(hit.headers[name], 'no ' + name + ' forwarded')

  const page2 = await search(token, { q: 'gato', cursor: '9' })
  t.is(page2.status, 200)
  t.is(provider.seen.filter((s) => s.path === '/v1/gifs/search')[1].query.offset, '9')

  provider.setMode('fail')
  t.is((await search(token, { q: QUERY })).status, 503)

  const text = JSON.stringify(logs)
  t.absent(text.includes(QUERY), 'query never logged')
  t.absent(text.includes(KEY), 'key never logged')
  t.absent(text.includes(token), 'token never logged')
  t.ok(logs.filter((e) => e.event === 'gif').every((e) => Object.keys(e).every((k) => k === 'event' || k === 'reason')), 'count events only')
  t.ok(logs.some((e) => e.event === 'gif' && e.reason === 'busca'), 'count event logged')
})

test('gif: query and cursor are bounded', async (t) => {
  const { login, search } = await setup(t)
  const { token } = await login()
  for (const q of ['', '   ', 'a'.repeat(65), 'linha\nquebrada', 7, null]) {
    const res = await search(token, { q })
    t.is(res.status, 400, JSON.stringify(q))
  }
  t.is((await search(token, {})).status, 400, 'missing q')
  t.is((await search(token, { q: '🐱'.repeat(64) })).status, 200, '64 code points pass')
  for (const cursor of ['-1', '01', '5000', 'abc', 9]) {
    t.is((await search(token, { q: 'a', cursor })).status, 400, 'cursor ' + cursor)
  }
})

test('gif: images come only from remembered results, as checked GIF bytes', async (t) => {
  const { call, login, search } = await setup(t)
  const { token } = await login()
  const headers = { Authorization: 'Bearer ' + token }
  t.is((await call('GET', '/account/gif/image/abc123?size=tiny', { headers })).status, 404, 'unknown before a search')
  await search(token, { q: 'gato' })

  const tiny = await call('GET', '/account/gif/image/abc123?size=tiny', { headers })
  t.is(tiny.status, 200)
  t.is(tiny.headers['content-type'], 'image/gif')
  t.is(tiny.headers['x-content-type-options'], 'nosniff')
  t.ok(tiny.headers['cache-control'].startsWith('private'))
  t.is(tiny.headers['content-security-policy'], "default-src 'none'; sandbox")
  t.ok(tiny.raw.equals(GIF))
  t.is((await call('GET', '/account/gif/image/abc123?size=full', { headers })).status, 200)

  t.is((await call('GET', '/account/gif/image/abc123?size=big', { headers })).status, 400)
  t.is((await call('GET', '/account/gif/image/abc123', { headers })).status, 400)
  t.is((await call('GET', '/account/gif/image/evilhost?size=full', { headers })).status, 404, 'a dropped item was never remembered')
  t.is((await call('GET', '/account/gif/image/abc123?size=tiny')).status, 401, 'session required')
  t.is((await call('GET', '/account/gif/image/abc123?size=tiny', { headers: { 'x-varanda-gif': token } })).status, 401, 'the old header is not read')

  const notGif = await call('GET', '/account/gif/image/notgif?size=tiny', { headers })
  t.is(notGif.status, 503)
  t.is(notGif.json.error, 'indisponivel')
  t.is((await call('GET', '/account/gif/image/huge?size=tiny', { headers })).status, 503, 'over the tiny cap')
  const hop = await call('GET', '/account/gif/image/hop?size=tiny', { headers })
  t.is(hop.status, 200, 'redirect on the provider host followed')
  t.ok(hop.raw.equals(GIF))
  t.is((await call('GET', '/account/gif/image/away?size=tiny', { headers })).status, 503, 'redirect to another host refused')
})

test('gif: provider failure answers 503 indisponivel', async (t) => {
  const { login, search, provider } = await setup(t)
  const { token } = await login()
  provider.setMode('fail')
  const res = await search(token, { q: 'gato' })
  t.is(res.status, 503)
  t.alike(res.json, { error: 'indisponivel' })
})

test('gif: the production address check refuses a provider on loopback', async (t) => {
  const { login, search, provider } = await setup(t, { transport: { ...loopbackTransport, allowAddress: undefined } })
  const { token } = await login()
  const res = await search(token, { q: 'gato' })
  t.is(res.status, 503)
  t.is(provider.seen.length, 0, 'no socket reached the provider')
})

test('gif: searches are capped per member per day', async (t) => {
  const { login, search } = await setup(t)
  const { token } = await login()
  for (let i = 0; i < SEARCHES_PER_DAY; i++) {
    const res = await search(token, { q: 'gato' })
    if (res.status !== 200) {
      t.fail('search ' + i + ' answered ' + res.status)
      return
    }
  }
  const over = await search(token, { q: 'gato' })
  t.is(over.status, 429)
  t.is(over.json.error, 'limite-gif')
})

test('gif: a failed provider call gives the search back', async (t) => {
  const { login, search, provider } = await setup(t)
  const { token } = await login()
  provider.setMode('fail')
  for (let i = 0; i < SEARCHES_PER_DAY; i++) {
    const res = await search(token, { q: 'gato' })
    if (res.status !== 503) {
      t.fail('failing search ' + i + ' answered ' + res.status)
      return
    }
  }
  provider.setMode('ok')
  t.is((await search(token, { q: 'gato' })).status, 200, 'failures did not spend the day')
})

test('gif: a failed image fetch gives the image back', async (t) => {
  const { call, login, search } = await setup(t)
  const { token } = await login()
  const headers = { Authorization: 'Bearer ' + token }
  await search(token, { q: 'gato' })
  for (let i = 0; i < FULL_PER_DAY; i++) {
    const res = await call('GET', '/account/gif/image/away?size=full', { headers })
    if (res.status !== 503) {
      t.fail('failing image ' + i + ' answered ' + res.status)
      return
    }
  }
  t.is((await call('GET', '/account/gif/image/abc123?size=full', { headers })).status, 200, 'failures did not spend the day')
})

test('gif: a session is re-checked, and an unlinked or blocked member loses it', async (t) => {
  const { login, search, linked, blocked, clock, memberHex, logs } = await setup(t)
  const first = await login()
  t.is((await search(first.token, { q: 'gato' })).status, 200)

  blocked.add(memberHex)
  clock.offset += 61 * 1000
  const refused = await search(first.token, { q: 'gato' })
  t.is(refused.status, 401)
  t.alike(refused.json, { error: 'nao-autorizado' })
  const blockedStart = await login()
  t.is(blockedStart.start.status, 403, 'a blocked member gets no nonce')
  blocked.delete(memberHex)
  t.is((await search(first.token, { q: 'gato' })).status, 401, 'the session was dropped')

  const second = await login()
  t.is((await search(second.token, { q: 'gato' })).status, 200)
  linked.delete(memberHex)
  clock.offset += 61 * 1000
  t.is((await search(second.token, { q: 'gato' })).status, 401, 'unlinked')
  linked.add(memberHex)
  t.is((await search(second.token, { q: 'gato' })).status, 401, 'the session was dropped')
  t.ok(logs.some((e) => e.reason === 'sessao-revogada'))
})

test('gif: anyone can call start for a member key, and it never invalidates the member\'s nonce', async (t) => {
  const { call, member, memberHex, association } = await setup(t)
  const held = (await call('POST', '/account/gif/session/start', { body: { member: memberHex } })).json.nonce
  const statuses = new Set()
  for (let i = 0; i < 50; i++) statuses.add((await call('POST', '/account/gif/session/start', { body: { member: memberHex } })).status)
  t.alike([...statuses], [200], 'start is not limited per member')
  const signature = signInvite({ action: 'summary', nonce: held, member: memberHex, association }, member)
  const res = await call('POST', '/account/gif/session/finish', { body: { member: memberHex, nonce: held, signature } })
  t.is(res.status, 200, 'the nonce the member already held still works')
})

test('gif: forged finishes for a member key never block the member', async (t) => {
  const { call, member, memberHex, association } = await setup(t)
  const start = await call('POST', '/account/gif/session/start', { body: { member: memberHex } })
  const forged = (await call('POST', '/account/gif/session/start', { body: { member: memberHex } })).json.nonce
  const statuses = new Set()
  for (let i = 0; i < FINISH_LIMIT * 3; i++) {
    const random = crypto.randomBytes(32).toString('base64url')
    statuses.add((await call('POST', '/account/gif/session/finish', { body: { member: memberHex, nonce: random, signature: 'b'.repeat(128) } })).status)
    statuses.add((await call('POST', '/account/gif/session/finish', { body: { member: memberHex, nonce: forged, signature: 'b'.repeat(128) } })).status)
  }
  t.alike([...statuses].sort(), [400, 404], 'refused as expirado or assinatura-invalida, never 429')
  const signature = signInvite({ action: 'summary', nonce: start.json.nonce, member: memberHex, association }, member)
  const res = await call('POST', '/account/gif/session/finish', { body: { member: memberHex, nonce: start.json.nonce, signature } })
  t.is(res.status, 200)
})

test('gif: the finish limit counts verified finishes, and one over it keeps the nonce', async (t) => {
  const { call, member, memberHex, association, server } = await setup(t)
  const signed = async () => {
    const nonce = (await call('POST', '/account/gif/session/start', { body: { member: memberHex } })).json.nonce
    return { member: memberHex, nonce, signature: signInvite({ action: 'summary', nonce, member: memberHex, association }, member) }
  }
  for (let i = 0; i < FINISH_LIMIT; i++) {
    const res = await call('POST', '/account/gif/session/finish', { body: await signed() })
    if (res.status !== 200) {
      t.fail('finish ' + i + ' answered ' + res.status)
      return
    }
  }
  t.is(server.gifStats().spent, FINISH_LIMIT)
  const over = await call('POST', '/account/gif/session/finish', { body: await signed() })
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-gif' })
  t.is(server.gifStats().spent, FINISH_LIMIT, 'the nonce over the limit was not spent')
})

test('gif: a full spent-nonce table refuses instead of evicting', async (t) => {
  class RouteError extends Error {
    constructor (code, status) {
      super(code)
      this.code = code
      this.status = status
    }
  }
  const http = {
    send: (res, status, body) => { res.status = status; res.body = body },
    readJsonBody: async (req) => req.body,
    checkPost: () => {},
    RouteError,
    refuse: (code) => new RouteError(code, code === 'expirado' ? 404 : code === 'indisponivel' ? 503 : 400)
  }
  const association = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const terms = { available: () => true, list: () => [{ version: TERMS_VERSION }] }
  const store = { status: () => ({ linked: true }) }
  const routes = createGifRoutes({ config: parseGifConfig({ apiUrl: 'https://gif.test/v1', apiKey: KEY }), store, terms, association, maxSpent: 2, http })
  const post = async (path, body) => {
    const res = {}
    try {
      await routes.handle({ method: 'POST', body, headers: {} }, res, new URL('https://varanda.test' + path))
    } catch (err) {
      if (!(err instanceof RouteError)) throw err
      return { status: err.status, error: err.code }
    }
    return res
  }
  const signedFor = async (kp) => {
    const hex = b4a.toString(kp.publicKey, 'hex')
    const nonce = (await post('/account/gif/session/start', { member: hex })).body.nonce
    return { member: hex, nonce, signature: signInvite({ action: 'summary', nonce, member: hex, association }, kp) }
  }
  const first = await signedFor(crypto.keyPair())
  t.is((await post('/account/gif/session/finish', first)).status, 200)
  t.is((await post('/account/gif/session/finish', await signedFor(crypto.keyPair()))).status, 200)
  const full = await post('/account/gif/session/finish', await signedFor(crypto.keyPair()))
  t.is(full.status, 503)
  t.is(full.error, 'indisponivel')
  const replay = await post('/account/gif/session/finish', first)
  t.is(replay.error, 'expirado', 'the oldest spent nonce was not evicted')
  t.is(routes.stats().spent, 2)
})

test('gif: publicAddress refuses internal ranges', (t) => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'not-an-ip']) {
    t.absent(publicAddress(ip), ip)
  }
  // IPv6 forms that carry an IPv4 address, site-local, 6to4 and Teredo.
  for (const ip of ['::127.0.0.1', '::10.1.2.3', '::169.254.169.254', '::8.8.8.8', '::ffff:0:10.0.0.1', '::ffff:0:a00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::a00:1', 'fec0::1', 'feff::1', '2002:a00:1::1', '2001::1', '2001:0:4136:e378::1']) {
    t.absent(publicAddress(ip), ip)
  }
  for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888', 'fe00::1']) t.ok(publicAddress(ip), ip)
})

test('gif: parseGifConfig and fromProvider refuse what they must', (t) => {
  t.is(parseGifConfig({ apiUrl: 'http://gif.test', apiKey: KEY }), null, 'http')
  t.is(parseGifConfig({ apiUrl: 'https://127.0.0.1', apiKey: KEY }), null, 'IP literal')
  t.is(parseGifConfig({ apiUrl: 'https://u:p@gif.test', apiKey: KEY }), null, 'credentials')
  t.is(parseGifConfig({ apiUrl: 'https://gif.test/?k=1', apiKey: KEY }), null, 'query')
  t.is(parseGifConfig({ apiUrl: 'https://gif.test', apiKey: 'com espaço' }), null, 'key')
  t.is(parseGifConfig({ apiUrl: 'https://gif.test', apiKey: KEY, mediaHosts: ['10.0.0.1'] }), null, 'IP media host')
  const ok = parseGifConfig({ apiUrl: 'https://gif.test/v1/', apiKey: KEY, mediaHosts: ['media.gif.test'] })
  t.is(ok.base, 'https://gif.test/v1')
  t.ok(ok.hosts.has('gif.test') && ok.hosts.has('media.gif.test'))

  t.alike(fromProvider(null), [])
  t.alike(fromProvider({ data: 'x' }), [])
  const good = { id: 'a1', images: { fixed_width_small: { url: 'https://h/t.gif', size: 10 }, original: { url: 'https://h/f.gif', width: 2, height: 3, size: 20 } } }
  t.alike(fromProvider({ data: [good] }), [{ id: 'a1', width: 2, height: 3, bytes: 20, tinyUrl: 'https://h/t.gif', fullUrl: 'https://h/f.gif' }])
  const without = (mut) => { const c = JSON.parse(JSON.stringify(good)); mut(c); return fromProvider({ data: [c] }).length }
  t.is(without((c) => { c.images.original.url = 'javascript:alert(1)' }), 0)
  t.is(without((c) => { delete c.images.fixed_width_small }), 0)
  t.is(without((c) => { c.images.original.size = 9 * 1024 * 1024 }), 0)
  t.is(without((c) => { c.images.original.width = 0 }), 0)
  t.is(without((c) => { c.id = 'x'.repeat(65) }), 0)
  // A side the app refuses is dropped here, one item, not the page.
  t.is(without((c) => { c.images.original.width = 4097 }), 0, 'a side over 4096')
  t.is(without((c) => { c.images.original.width = 4096 }), 1, 'a side of 4096')
  const wide = JSON.parse(JSON.stringify(good))
  wide.id = 'a2'
  wide.images.original.height = 5000
  t.is(fromProvider({ data: [good, wide] }).length, 1, 'the rest of the page stays')
})

test('gif: a session needs the current terms (v20 describes the provider)', async (t) => {
  const s = await setup(t, { accepted: false })
  const { finish } = await s.login()
  t.is(finish.status, 409)
  t.alike(finish.json, { error: 'termos-pendentes' })
})
