'use strict'

// The seeder's push relay (apps/cli/lib/push-relay.js) against a fake
// account service on 127.0.0.1 port 0: one POST per event, no retry ever.
const test = require('brittle')
const http = require('node:http')
const { until } = require('./helpers/net')
const { createPushRelay } = require('../lib/push-relay')

const TOKEN = 'd4'.repeat(32)
const ACTOR = 'a1'.repeat(32)
const RECIPIENT = 'b2'.repeat(32)

function event (overrides = {}) {
  return { v: 1, kind: 'follow', actor: ACTOR, recipient: RECIPIENT, seq: 3, ref: null, name: 'Ana', ...overrides }
}

// respond(req, res) decides the answer; omit it for 204.
async function fakeAccount (t, respond = (req, res) => { res.statusCode = 204; res.end() }) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      respond(req, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }), { force: true })
  return { requests, baseUrl: 'http://127.0.0.1:' + server.address().port }
}

function relayFor (t, baseUrl, opts = {}) {
  const relay = createPushRelay({ baseUrl, token: TOKEN, ...opts })
  t.teardown(() => relay.close())
  return relay
}

const settled = (relay) => until(() => relay.stats().pending === 0 && relay.stats().inflight === 0, { name: 'relay idle' })

test('posts the event with the bearer token, body exactly the event JSON', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  const ev = event({ kind: 'like', ref: RECIPIENT + ':7' })
  t.is(relay.send(ev), true)
  await until(() => relay.stats().sent === 1, { name: 'sent' })
  t.is(fake.requests.length, 1)
  const req = fake.requests[0]
  t.is(req.method, 'POST')
  t.is(req.url, '/push-event')
  t.is(req.headers.authorization, 'Bearer ' + TOKEN)
  t.is(req.headers['content-type'], 'application/json')
  t.is(req.body, JSON.stringify(ev))
  t.alike(JSON.parse(req.body), ev)
})

test('a trailing slash on baseUrl still reaches /push-event', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl + '/')
  relay.send(event())
  await until(() => relay.stats().sent === 1, { name: 'sent' })
  t.is(fake.requests[0].url, '/push-event')
})

test('the same actor and seq is posted once', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  t.is(relay.send(event()), true)
  t.is(relay.send(event({ kind: 'reply', ref: RECIPIENT + ':2' })), false)
  t.is(relay.send(event({ seq: 4 })), true)
  await settled(relay)
  t.is(fake.requests.length, 2)
  t.is(relay.stats().duplicate, 1)
  t.is(relay.stats().sent, 2)
})

test('dedupe keys are evicted oldest first past dedupeMax', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl, { dedupeMax: 2 })
  relay.send(event({ seq: 1 }))
  relay.send(event({ seq: 2 }))
  relay.send(event({ seq: 3 }))
  await settled(relay)
  t.is(relay.send(event({ seq: 1 })), true, 'seq 1 was evicted')
  t.is(relay.send(event({ seq: 3 })), false, 'seq 3 is still known')
  await settled(relay)
  t.is(fake.requests.length, 4)
})

test('the queue is bounded: one in flight, extras dropped and counted', async (t) => {
  const held = []
  const fake = await fakeAccount(t, (req, res) => held.push(res))
  const relay = relayFor(t, fake.baseUrl, { maxPending: 2 })
  t.is(relay.send(event({ seq: 1 })), true)
  await until(() => held.length === 1, { name: 'first request arrived' })
  t.is(relay.send(event({ seq: 2 })), true)
  t.is(relay.send(event({ seq: 3 })), true)
  t.is(relay.send(event({ seq: 4 })), false)
  t.is(relay.stats().full, 1)
  t.is(relay.stats().pending, 2)
  t.is(fake.requests.length, 1, 'one POST in flight at a time')
  held.shift().end()
  await until(() => held.length === 1, { name: 'second request arrived' })
  t.is(fake.requests.length, 2)
  held.shift().end()
  await until(() => held.length === 1, { name: 'third request arrived' })
  held.shift().end()
  await settled(relay)
  t.is(fake.requests.length, 3)
  t.alike(fake.requests.map((r) => JSON.parse(r.body).seq), [1, 2, 3])
})

test('a request past timeoutMs is aborted and not retried', async (t) => {
  const fake = await fakeAccount(t, () => {})
  const relay = relayFor(t, fake.baseUrl, { timeoutMs: 100 })
  relay.send(event())
  await until(() => relay.stats().failed === 1, { name: 'timed out' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(fake.requests.length, 1)
  t.is(relay.stats().sent, 0)
})

test('no second POST after a 500, a 404, a 429 or a network error', async (t) => {
  const statuses = [500, 404, 429]
  const fake = await fakeAccount(t, (req, res) => { res.statusCode = statuses.shift() || 204; res.end() })
  const relay = relayFor(t, fake.baseUrl)
  relay.send(event({ seq: 1 }))
  await until(() => relay.stats().failed === 1, { name: '500' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(fake.requests.length, 1, 'the 500 is not retried')
  relay.send(event({ seq: 2 }))
  relay.send(event({ seq: 3 }))
  await settled(relay)
  t.is(fake.requests.length, 3)
  t.is(relay.stats().failed, 3)
  t.is(relay.send(event({ seq: 1 })), false, 'a failed event is not resent either')

  let calls = 0
  const broken = createPushRelay({ baseUrl: fake.baseUrl, token: TOKEN, fetch: async () => { calls++; throw new Error('ECONNREFUSED') } })
  t.teardown(() => broken.close())
  broken.send(event())
  await settled(broken)
  t.is(calls, 1)
  t.is(broken.stats().failed, 1)
})

test('oversized or invalid events are dropped without a request', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  t.is(relay.send(event({ name: 'x'.repeat(65) })), false, 'name over 64')
  t.is(relay.send({ ...event(), extra: 'y'.repeat(100000) }), false, 'extra key')
  t.is(relay.send(event({ v: 2 })), false)
  t.is(relay.send(event({ recipient: ACTOR })), false)
  t.is(relay.send(event({ kind: 'like', ref: null })), false)
  t.is(relay.send(null), false)
  t.is(relay.send('{}'), false)
  t.is(relay.stats().invalid, 7)
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(fake.requests.length, 0)
})

test('a non-loopback baseUrl or a bad token is refused', async (t) => {
  for (const baseUrl of ['http://example.com:8790', 'https://127.0.0.1:8790', 'http://10.0.0.1:8790', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:8790/x', 'http://127.0.0.1:8790//', undefined]) {
    t.exception.all(() => createPushRelay({ baseUrl, token: TOKEN }), TypeError, String(baseUrl))
  }
  for (const token of ['', 'D4'.repeat(32), 'd4'.repeat(31), undefined]) {
    t.exception.all(() => createPushRelay({ baseUrl: 'http://127.0.0.1:8790', token }), TypeError, 'token ' + String(token))
  }
  t.ok(createPushRelay({ baseUrl: 'http://[::1]:8790', token: TOKEN }))
  t.ok(createPushRelay({ baseUrl: 'http://localhost:8790/', token: TOKEN }))
})

test('close aborts the request in flight and empties the queue', async (t) => {
  const fake = await fakeAccount(t, () => {})
  const relay = relayFor(t, fake.baseUrl)
  relay.send(event({ seq: 1 }))
  relay.send(event({ seq: 2 }))
  await until(() => fake.requests.length === 1, { name: 'in flight' })
  relay.close()
  t.is(relay.stats().pending, 0)
  await until(() => relay.stats().inflight === 0, { name: 'aborted' })
  t.is(relay.send(event({ seq: 3 })), false)
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(fake.requests.length, 1)
})

test('stats carry counts only', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  relay.send(event())
  await settled(relay)
  const stats = relay.stats()
  for (const value of Object.values(stats)) t.is(typeof value, 'number')
  t.absent(JSON.stringify(stats).includes(ACTOR))
})
