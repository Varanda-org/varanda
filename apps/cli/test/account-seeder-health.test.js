'use strict'

// The account-side reader of the seeder's /health counts
// (apps/cli/lib/account/seeder-health.js) against a local http fixture
// server on 127.0.0.1:0, plus the shared loopback URL parser.
const test = require('brittle')
const http = require('node:http')
const {
  DEFAULT_SEEDER_HEALTH,
  FIELDS,
  MAX_BODY,
  parseSeederHealthUrl,
  createSeederHealthReader
} = require('../lib/account/seeder-health')

const PLANTED = 'ab'.repeat(32)

const GOOD = {
  status: 'ok',
  uptimeSeconds: 120,
  admitted: 7,
  dropping: false,
  activeDay: 3,
  activeWeek: 5,
  blocks: 1000,
  bytes: 123456,
  mediaBytes: 4096,
  topicPosts: 12,
  connections: 4,
  external: 2,
  firewalled: false,
  blocked: 1,
  blocklistSeq: 9,
  maxConnections: 256
}

// A fixture server: `handler(req, res)` is swapped per case; every request
// is recorded (path and headers).
async function fixture (t) {
  const state = { handler: (req, res) => res.writeHead(404).end(), requests: [] }
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    state.requests.push({ url: req.url, method: req.method, headers: req.headers })
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

function serveJson (status, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(text)
  }
}

test('a good body returns exactly the FIELDS counts, extra keys dropped', async (t) => {
  const f = await fixture(t)
  f.handler = serveJson(200, { ...GOOD, association: PLANTED, extra: { key: PLANTED } })
  const { read } = createSeederHealthReader({ baseUrl: f.baseUrl })
  const out = await read()
  t.alike(Object.keys(out), FIELDS)
  t.alike(out, {
    uptimeSeconds: 120,
    admitted: 7,
    activeDay: 3,
    activeWeek: 5,
    blocks: 1000,
    bytes: 123456,
    mediaBytes: 4096,
    topicPosts: 12,
    connections: 4,
    external: 2
  })
  t.absent(JSON.stringify(out).includes(PLANTED), 'no planted hex')
  t.is(f.requests.length, 1)
  t.is(f.requests[0].url, '/health')
  t.is(f.requests[0].method, 'GET')
  t.is(f.requests[0].headers.accept, 'application/json')
  t.absent(f.requests[0].headers.authorization, 'no token sent')
  t.absent(f.requests[0].headers.cookie, 'no credentials sent')
})

test('an older seeder without activeDay/activeWeek gives those null', async (t) => {
  const f = await fixture(t)
  const old = { ...GOOD }
  delete old.activeDay
  delete old.activeWeek
  f.handler = serveJson(200, old)
  const out = await createSeederHealthReader({ baseUrl: f.baseUrl }).read()
  t.is(out.activeDay, null)
  t.is(out.activeWeek, null)
  t.is(out.admitted, 7)
  t.alike(Object.keys(out), FIELDS)
})

test('a negative, float or string count gives that field null', async (t) => {
  const f = await fixture(t)
  f.handler = serveJson(200, { ...GOOD, blocks: -1, bytes: 1.5, mediaBytes: '4096', topicPosts: Number.MAX_SAFE_INTEGER + 2, connections: null })
  const out = await createSeederHealthReader({ baseUrl: f.baseUrl }).read()
  t.is(out.blocks, null)
  t.is(out.bytes, null)
  t.is(out.mediaBytes, null)
  t.is(out.topicPosts, null)
  t.is(out.connections, null)
  t.is(out.external, 2)
})

test('status or admitted invalid gives null', async (t) => {
  const f = await fixture(t)
  const { read } = createSeederHealthReader({ baseUrl: f.baseUrl })
  f.handler = serveJson(200, { ...GOOD, status: 'starting' })
  t.is(await read(), null)
  f.handler = serveJson(200, { ...GOOD, admitted: -1 })
  t.is(await read(), null)
  const noAdmitted = { ...GOOD }
  delete noAdmitted.admitted
  f.handler = serveJson(200, noAdmitted)
  t.is(await read(), null)
  f.handler = serveJson(200, [GOOD])
  t.is(await read(), null)
  f.handler = serveJson(200, 'null')
  t.is(await read(), null)
})

test('503 starting gives null', async (t) => {
  const f = await fixture(t)
  f.handler = serveJson(503, { status: 'starting' })
  t.is(await createSeederHealthReader({ baseUrl: f.baseUrl }).read(), null)
})

test('non-JSON gives null', async (t) => {
  const f = await fixture(t)
  f.handler = serveJson(200, 'not json {')
  t.is(await createSeederHealthReader({ baseUrl: f.baseUrl }).read(), null)
})

test('a body over MAX_BODY gives null (declared and streamed)', async (t) => {
  const f = await fixture(t)
  t.is(MAX_BODY, 16384)
  const { read } = createSeederHealthReader({ baseUrl: f.baseUrl })
  const big = JSON.stringify({ ...GOOD, pad: 'x'.repeat(20000 - JSON.stringify(GOOD).length - 10) })
  t.ok(big.length > MAX_BODY)
  f.handler = serveJson(200, big)
  t.is(await read(), null, 'declared content-length')
  f.handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(big.slice(0, 10000))
    res.end(big.slice(10000))
  }
  t.is(await read(), null, 'chunked, no content-length')
})

test('a redirect gives null', async (t) => {
  const f = await fixture(t)
  f.handler = (req, res) => {
    if (req.url === '/health') {
      res.writeHead(302, { location: '/elsewhere' })
      res.end()
    } else {
      serveJson(200, GOOD)(req, res)
    }
  }
  t.is(await createSeederHealthReader({ baseUrl: f.baseUrl }).read(), null)
  t.is(f.requests.length, 1, 'the redirect was not followed')
})

test('a silent server times out to null', async (t) => {
  const f = await fixture(t)
  f.handler = () => {}
  const started = Date.now()
  t.is(await createSeederHealthReader({ baseUrl: f.baseUrl, timeoutMs: 200 }).read(), null)
  t.ok(Date.now() - started < 1000, 'within about 1 s')
})

test('a refused connection gives null', async (t) => {
  // Listen then close, so the port refuses.
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  t.is(await createSeederHealthReader({ baseUrl: 'http://127.0.0.1:' + port }).read(), null)
})

test('a throwing injected fetch resolves null', async (t) => {
  const { read } = createSeederHealthReader({ baseUrl: DEFAULT_SEEDER_HEALTH, fetch: () => { throw new Error('boom') } })
  t.is(await read(), null)
})

test('parseSeederHealthUrl', (t) => {
  t.is(DEFAULT_SEEDER_HEALTH, 'http://127.0.0.1:8788')
  t.is(parseSeederHealthUrl(undefined), DEFAULT_SEEDER_HEALTH)
  t.is(parseSeederHealthUrl(''), DEFAULT_SEEDER_HEALTH)
  t.is(parseSeederHealthUrl('http://localhost:9000/'), 'http://localhost:9000')
  t.is(parseSeederHealthUrl('http://[::1]:8788'), 'http://[::1]:8788')
  t.is(parseSeederHealthUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788')
  for (const bad of [
    'http://10.0.0.1:8788',
    'https://127.0.0.1:8788',
    'http://127.0.0.1:0',
    'http://127.0.0.1:70000',
    'http://127.0.0.1:8788/health',
    'http://user@127.0.0.1:8788',
    'http://127.0.0.1',
    5,
    null,
    {}
  ]) {
    t.is(parseSeederHealthUrl(bad), null, String(bad))
  }
})

test('an invalid configuration never calls fetch', async (t) => {
  let calls = 0
  const spy = async () => { calls++; throw new Error('should not be called') }
  for (const baseUrl of ['http://10.0.0.1:8788', 'https://127.0.0.1:8788', 'http://127.0.0.1:0', 5, null]) {
    t.is(await createSeederHealthReader({ baseUrl, fetch: spy }).read(), null)
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, '200', Infinity]) {
    t.is(await createSeederHealthReader({ baseUrl: DEFAULT_SEEDER_HEALTH, timeoutMs, fetch: spy }).read(), null)
  }
  t.is(calls, 0)
})

test('read is a closure without `this`', async (t) => {
  const f = await fixture(t)
  f.handler = serveJson(200, GOOD)
  const { read } = createSeederHealthReader({ baseUrl: f.baseUrl + '/' })
  const holder = { read }
  const out = await Reflect.apply(holder.read, null, [])
  t.is(out.admitted, 7)
})
