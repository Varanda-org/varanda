'use strict'

// apps/cli/lib/account/google.js against a loopback node:http fake of the
// Google authorization, token and userinfo endpoints. No socket leaves
// 127.0.0.1: every endpoint, and the default fetch, point at the fake.

const test = require('brittle')
const http = require('node:http')
const crypto = require('node:crypto')
const { createGoogle, pkce } = require('../lib/account/google')

const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
const REDIRECT = 'https://varanda.test/account/google/callback'
const SUB = '109876543210987654321'
const EMAIL = 'membro@example.test'
const ACCESS = 'ya29.access-token-de-teste'

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function idToken (claims = {}) {
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: SUB,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims
  }
  return b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(payload) + '.c2ln'
}

// Fake provider: `routes.token` and `routes.userinfo` are (req, body, res)
// handlers a test may replace; `seen` records every request.
async function fakeGoogle (t) {
  const seen = []
  const routes = {
    token (req, body, res) {
      json(res, 200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3599, id_token: idToken() })
    },
    userinfo (req, body, res) {
      json(res, 200, { sub: SUB, email: EMAIL, email_verified: true })
    }
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      seen.push({ method: req.method, path, headers: req.headers, body })
      if (path === '/token') return routes.token(req, body, res)
      if (path === '/userinfo') return routes.userinfo(req, body, res)
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  const endpoints = { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' }
  return { seen, routes, endpoints, base }
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

// A fetch that refuses any origin other than the fake, so a wrong default can
// never reach the real network.
function loopbackFetch (base) {
  return (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
}

function client (fake, extra = {}) {
  return createGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT,
    endpoints: fake.endpoints,
    fetch: loopbackFetch(fake.base),
    ...extra
  })
}

function noLeak (t, result) {
  const text = JSON.stringify(result)
  for (const secret of [ACCESS, CLIENT_SECRET, EMAIL, SUB]) t.absent(text.includes(secret), 'refusal leaks nothing')
}

async function refused (t, fake, extra) {
  const g = client(fake, extra)
  const result = await g.exchange({ code: 'code-1', codeVerifier: pkce().verifier })
  t.alike(result, { ok: false, reason: 'google-recusado' })
  noLeak(t, result)
}

test('pkce: 32-byte base64url verifier and its S256 challenge', (t) => {
  const { verifier, challenge } = pkce()
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), 'verifier is 43 base64url chars, no padding')
  t.is(Buffer.from(verifier, 'base64url').length, 32)
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
  t.is(challenge, expected)
  t.absent(challenge.includes('='))
  t.not(pkce().verifier, verifier, 'fresh randomness each call')
})

test('authorizeUrl carries exactly the listed parameters and no secret', async (t) => {
  const fake = await fakeGoogle(t)
  const g = client(fake)
  const { challenge } = g.pkce()
  const url = new URL(g.authorizeUrl({ state: 'estado-1', codeChallenge: challenge }))
  t.is(url.origin + url.pathname, fake.endpoints.authUrl)
  const params = [...url.searchParams.entries()]
  t.alike(params.map(([k]) => k).sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'
  ])
  t.alike(Object.fromEntries(params), {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'openid email',
    state: 'estado-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  })
  t.absent(url.toString().includes(CLIENT_SECRET), 'no client secret')
  t.absent(url.searchParams.has('access_type'))
  t.absent(url.searchParams.has('nonce'))
})

test('default endpoints are Google', (t) => {
  const g = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, fetch: () => { throw new Error('no network') } })
  const url = new URL(g.authorizeUrl({ state: 's', codeChallenge: 'c' }))
  t.is(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
})

test('a valid exchange returns sub and email', async (t) => {
  const fake = await fakeGoogle(t)
  const g = client(fake)
  const { verifier } = g.pkce()
  const result = await g.exchange({ code: 'code-1', codeVerifier: verifier })
  t.alike(result, { ok: true, sub: SUB, email: EMAIL })

  const [tok, info] = fake.seen
  t.is(tok.method, 'POST')
  t.is(tok.path, '/token')
  t.ok(tok.headers['content-type'].startsWith('application/x-www-form-urlencoded'))
  t.alike(Object.fromEntries(new URLSearchParams(tok.body)), {
    grant_type: 'authorization_code',
    code: 'code-1',
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: verifier
  })
  t.is(info.method, 'GET')
  t.is(info.path, '/userinfo')
  t.is(info.headers.authorization, 'Bearer ' + ACCESS)
})

test('the shorter issuer spelling is accepted', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.token = (req, body, res) => json(res, 200, { access_token: ACCESS, id_token: idToken({ iss: 'accounts.google.com' }) })
  const result = await client(fake).exchange({ code: 'c', codeVerifier: 'v' })
  t.is(result.ok, true)
})

test('email_verified false is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.userinfo = (req, body, res) => json(res, 200, { sub: SUB, email: EMAIL, email_verified: false })
  await refused(t, fake)
})

test("email_verified as the string 'true' is refused", async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.userinfo = (req, body, res) => json(res, 200, { sub: SUB, email: EMAIL, email_verified: 'true' })
  await refused(t, fake)
})

test('a missing sub is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.userinfo = (req, body, res) => json(res, 200, { email: EMAIL, email_verified: true })
  await refused(t, fake)
})

test('a malformed email is refused', async (t) => {
  for (const email of ['sem-arroba', 'a@b@c', 'a'.repeat(315) + '@x.com', 42]) {
    const fake = await fakeGoogle(t)
    fake.routes.userinfo = (req, body, res) => json(res, 200, { sub: SUB, email, email_verified: true })
    await refused(t, fake)
  }
})

test('an oversized body is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.userinfo = (req, body, res) => json(res, 200, { sub: SUB, email: EMAIL, email_verified: true, pad: 'x'.repeat(70000) })
  await refused(t, fake)
})

test('an oversized chunked body (no content-length) is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.token = (req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"pad":"')
    for (let i = 0; i < 20; i++) res.write('x'.repeat(4096))
    res.end('"}')
  }
  await refused(t, fake)
})

test('a non-JSON body is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.token = (req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html>' + ACCESS + '</html>')
  }
  await refused(t, fake)
})

// A 200 whose headers already disqualify it (wrong content type, declared
// length over the cap): the server streams a first chunk and then holds the
// response open; the client must close it rather than leave it hanging.
function heldOpen (headers) {
  const closed = new Promise((resolve) => {
    heldOpen.handler = (req, body, res) => {
      res.on('close', () => resolve(!res.writableFinished))
      res.writeHead(200, headers)
      res.write('{"pad":"' + 'x'.repeat(1024))
    }
  })
  return { handler: heldOpen.handler, closed }
}

test('a non-JSON streaming 200 is refused and the response is closed', async (t) => {
  const fake = await fakeGoogle(t)
  const held = heldOpen({ 'Content-Type': 'text/html' })
  fake.routes.token = held.handler
  await refused(t, fake)
  t.is(await held.closed, true, 'server saw the client close before the body ended')
})

test('a 200 declaring Content-Length over the cap is refused and closed', async (t) => {
  const fake = await fakeGoogle(t)
  const held = heldOpen({ 'Content-Type': 'application/json', 'Content-Length': String(70000) })
  fake.routes.userinfo = held.handler
  await refused(t, fake)
  t.is(await held.closed, true, 'server saw the client close before the body ended')
})

test('invalid JSON under a JSON content type is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.userinfo = (req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"sub":')
  }
  await refused(t, fake)
})

test('a 4xx token response is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.token = (req, body, res) => json(res, 400, { error: 'invalid_grant', error_description: EMAIL })
  await refused(t, fake)
  t.is(fake.seen.length, 1, 'userinfo never called')
})

test('a redirect is not followed', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.token = (req, body, res) => {
    res.writeHead(302, { Location: fake.base + '/userinfo' })
    res.end()
  }
  await refused(t, fake)
  t.is(fake.seen.length, 1)
})

test('a timeout is refused', async (t) => {
  const fake = await fakeGoogle(t)
  fake.routes.token = () => {} // never answers
  const started = Date.now()
  await refused(t, fake, { timeoutMs: 200 })
  t.ok(Date.now() - started < 5000, 'aborted at the deadline')
})

test('id_token claim checks', async (t) => {
  const cases = [
    ['missing id_token', { id_token: undefined }],
    ['not a JWS', { id_token: 'abc' }],
    ['oversized', { id_token: idToken({ pad: 'x'.repeat(9000) }) }],
    ['wrong issuer', { id_token: idToken({ iss: 'https://evil.example' }) }],
    ['wrong audience', { id_token: idToken({ aud: 'outro-cliente' }) }],
    ['audience as array', { id_token: idToken({ aud: [CLIENT_ID] }) }],
    ['expired', { id_token: idToken({ exp: Math.floor(Date.now() / 1000) - 10 }) }],
    ['exp as string', { id_token: idToken({ exp: String(Math.floor(Date.now() / 1000) + 3600) }) }],
    ['sub differs from userinfo', { id_token: idToken({ sub: '1' }) }],
    ['missing access_token', { access_token: undefined }]
  ]
  for (const [name, override] of cases) {
    const fake = await fakeGoogle(t)
    fake.routes.token = (req, body, res) => json(res, 200, { access_token: ACCESS, id_token: idToken(), ...override })
    const result = await client(fake).exchange({ code: 'c', codeVerifier: 'v' })
    t.alike(result, { ok: false, reason: 'google-recusado' }, name)
  }
})

test('exp is checked against the injected clock', async (t) => {
  const fake = await fakeGoogle(t)
  const exp = Math.floor(Date.now() / 1000) + 60
  fake.routes.token = (req, body, res) => json(res, 200, { access_token: ACCESS, id_token: idToken({ exp }) })
  t.is((await client(fake, { now: () => exp * 1000 - 1 }).exchange({ code: 'c', codeVerifier: 'v' })).ok, true)
  t.is((await client(fake, { now: () => exp * 1000 }).exchange({ code: 'c', codeVerifier: 'v' })).ok, false)
})

test('missing code or verifier is refused without a request', async (t) => {
  const fake = await fakeGoogle(t)
  const g = client(fake)
  t.alike(await g.exchange({ code: '', codeVerifier: 'v' }), { ok: false, reason: 'google-recusado' })
  t.alike(await g.exchange({ code: 'c' }), { ok: false, reason: 'google-recusado' })
  t.is(fake.seen.length, 0)
})

test('createGoogle refuses a missing configuration without echoing values', (t) => {
  t.exception(() => createGoogle({ clientId: CLIENT_ID, redirectUri: REDIRECT }), /clientSecret ausente/)
  try {
    createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  } catch (err) {
    t.absent(err.message.includes(CLIENT_SECRET))
    t.absent(err.message.includes(CLIENT_ID))
  }
})
