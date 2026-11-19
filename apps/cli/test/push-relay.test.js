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

test('one record for two recipients posts both; the exact duplicate is dropped', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  const OTHER = 'c3'.repeat(32)
  const own = ACTOR + ':3'
  t.is(relay.send(event({ kind: 'quote', ref: own })), true)
  t.is(relay.send(event({ kind: 'mention', recipient: OTHER, ref: own })), true)
  t.is(relay.send(event({ kind: 'mention', recipient: OTHER, ref: own })), false)
  await settled(relay)
  t.alike(fake.requests.map((r) => JSON.parse(r.body).recipient), [RECIPIENT, OTHER])
  t.is(relay.stats().duplicate, 1)
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

test('a cancel is posted as is, after the event it recalls, every time, and bounded by maxPending', async (t) => {
  const held = []
  const fake = await fakeAccount(t, (req, res) => held.push(res))
  const relay = relayFor(t, fake.baseUrl, { maxPending: 3 })
  const like = event({ kind: 'like', ref: RECIPIENT + ':7' })
  const undo = { v: 1, op: 'cancel', kind: 'like', actor: ACTOR, recipient: RECIPIENT, ref: RECIPIENT + ':7' }
  t.is(relay.send(like), true)
  await until(() => held.length === 1, { name: 'the like in flight' })
  t.is(relay.send(undo), true)
  t.is(relay.send(event({ kind: 'like', ref: RECIPIENT + ':7', seq: 4 })), true)
  t.is(relay.send(undo), true, 'an identical cancel still waiting is kept: it recalls the newer like')
  t.is(relay.send(undo), false, 'a full queue drops a cancel too')
  t.is(relay.stats().full, 1)
  t.is(relay.stats().duplicate, 0, 'a cancel never enters the dedupe set')
  while (fake.requests.length < 4 || held.length > 0) {
    if (held.length > 0) held.shift().end()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await settled(relay)
  t.alike(fake.requests.map((r) => JSON.parse(r.body)), [like, undo, { ...like, seq: 4 }, undo])
  t.is(fake.requests[1].headers.authorization, 'Bearer ' + TOKEN)
  t.is(fake.requests[1].body, JSON.stringify(undo))
  t.is(relay.send(undo), true, 'the same cancel again is posted again')
  await until(() => held.length === 1, { name: 'repeat in flight' })
  held.shift().end()
  await settled(relay)
  t.is(relay.stats().sent, 5)
})

test('an invalid cancel is dropped without a request', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  const undo = { v: 1, op: 'cancel', kind: 'follow', actor: ACTOR, recipient: RECIPIENT, ref: null }
  t.is(relay.send({ ...undo, kind: 'reply', ref: RECIPIENT + ':2' }), false, 'a reply is never recalled')
  t.is(relay.send({ ...undo, ref: RECIPIENT + ':2' }), false, 'a follow has no ref')
  t.is(relay.send({ ...undo, kind: 'like' }), false, 'a like needs one')
  t.is(relay.send({ ...undo, kind: 'like', ref: ACTOR + ':2' }), false, 'the post must be the recipient\'s')
  t.is(relay.send({ ...undo, op: 'undo' }), false)
  t.is(relay.send({ ...undo, seq: 3 }), false, 'extra key')
  t.is(relay.send({ ...undo, recipient: ACTOR }), false)
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

const BOX_BYTES = 116

function groupEvent (overrides = {}) {
  return { v: 1, kind: 'group', group: ACTOR, visibility: 'public', name: 'Praia', nid: 'ab'.repeat(16), recipients: [RECIPIENT], ...overrides }
}

function groupRelay (t, opts = {}) {
  const requests = []
  const relay = relayFor(t, 'http://127.0.0.1:8790', {
    fetch: async (url, request) => {
      requests.push({ url, ...request })
      return { status: 204 }
    },
    ...opts
  })
  return { relay, requests }
}

test('sendGroup posts validated chunks with the same nid and no event logs', async (t) => {
  const logs = []
  const { relay, requests } = groupRelay(t, { log: (e) => logs.push(e) })
  const first = groupEvent()
  const second = groupEvent({ recipients: ['c3'.repeat(32)] })
  t.is(relay.sendGroup(first), true)
  t.is(relay.sendGroup(second), true)
  await settled(relay)
  t.alike(requests.map((r) => JSON.parse(r.body)), [first, second])
  t.is(requests[0].method, 'POST')
  t.is(requests[0].url, 'http://127.0.0.1:8790/push-event')
  t.is(requests[0].headers.Authorization, 'Bearer ' + TOKEN)
  t.is(requests[0].redirect, 'error')
  t.alike(logs, [])
  relay.close()
  t.is(relay.sendGroup(first), false)
})

test('sendGroup rejects invalid events before making a request', async (t) => {
  const { relay, requests } = groupRelay(t)
  const bad = [null, groupEvent({ visibility: 'private' }), groupEvent({ recipients: [] }),
    groupEvent({ recipients: Array(65).fill(RECIPIENT) }), groupEvent({ nid: 'AB'.repeat(16) }),
    { ...groupEvent(), author: ACTOR }]
  for (const ev of bad) t.is(relay.sendGroup(ev), false)
  t.is(relay.stats().invalid, bad.length)
  t.is(requests.length, 0)
  t.is(relay.sendGroup(groupEvent({ visibility: 'private', name: null })), true)
  await settled(relay)
  t.is(requests.length, 1)
})

test('sendGroup shares the queue bound and timeout without retrying', async (t) => {
  let calls = 0
  const relay = relayFor(t, 'http://127.0.0.1:8790', {
    maxPending: 1,
    timeoutMs: 30,
    fetch: async (url, { signal }) => {
      calls++
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
    }
  })
  t.is(relay.sendGroup(groupEvent()), true)
  t.is(relay.sendGroup(groupEvent()), true)
  t.is(relay.sendGroup(groupEvent()), false)
  await settled(relay)
  t.is(calls, 2)
  t.is(relay.stats().failed, 2)
  t.is(relay.stats().full, 1)
})

function box (fill = 7, n = BOX_BYTES) {
  return Buffer.alloc(n, fill)
}

test('sendDm posts exactly { v: 1, kind: dm, box } with the bearer and logs only a token', async (t) => {
  const fake = await fakeAccount(t)
  const logs = []
  const relay = relayFor(t, fake.baseUrl, { log: (e) => logs.push(e) })
  // Bytes whose base64 has + and /, so base64url is told apart.
  const b = Buffer.alloc(BOX_BYTES, 0xfb)
  t.is(relay.sendDm(b), true)
  await until(() => relay.stats().sent === 1, { name: 'sent' })
  t.is(fake.requests.length, 1)
  const req = fake.requests[0]
  t.is(req.method, 'POST')
  t.is(req.url, '/push-event')
  t.is(req.headers.authorization, 'Bearer ' + TOKEN)
  t.is(req.headers['content-type'], 'application/json')
  t.is(req.body, JSON.stringify({ v: 1, kind: 'dm', box: b.toString('base64url') }))
  const body = JSON.parse(req.body)
  t.alike(Object.keys(body), ['v', 'kind', 'box'])
  t.ok(/^[A-Za-z0-9_-]+$/.test(body.box), 'base64url without padding')
  t.alike(Buffer.from(body.box, 'base64url'), b, 'the same bytes')
  t.is(Buffer.from(body.box, 'base64url').toString('base64url'), body.box, 'canonical')
  t.alike(logs, [{ event: 'push', reason: 'dm' }])
  t.is(relay.sendDmWake, undefined, 'the anonymous wake is gone')
})

test('sendDm refuses a box of the wrong size or type and sends nothing', async (t) => {
  const fake = await fakeAccount(t)
  const relay = relayFor(t, fake.baseUrl)
  const bad = [box(1, BOX_BYTES - 1), box(1, BOX_BYTES + 1), Buffer.alloc(0), new Uint8Array(BOX_BYTES), box(1).toString('base64url'), box(1).toString('base64'), Array.from(box(1)), null, undefined, {}]
  for (const b of bad) t.is(relay.sendDm(b), false)
  t.is(relay.stats().invalid, bad.length)
  t.is(relay.stats().pending, 0)
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(fake.requests.length, 0, 'nothing posted')
})

test('a failed dm notice is never retried', async (t) => {
  const fake = await fakeAccount(t, (req, res) => { res.statusCode = 500; res.end() })
  const relay = relayFor(t, fake.baseUrl)
  relay.sendDm(box())
  await until(() => relay.stats().failed === 1, { name: '500' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(fake.requests.length, 1)

  let calls = 0
  const broken = createPushRelay({ baseUrl: fake.baseUrl, token: TOKEN, fetch: async () => { calls++; throw new Error('ECONNREFUSED') } })
  t.teardown(() => broken.close())
  broken.sendDm(box())
  await settled(broken)
  t.is(calls, 1)
})

test('dm notices are not coalesced; a full queue drops one; closed refuses', async (t) => {
  const held = []
  const fake = await fakeAccount(t, (req, res) => held.push(res))
  const relay = relayFor(t, fake.baseUrl, { maxPending: 2 })
  t.is(relay.send(event({ seq: 1 })), true)
  await until(() => held.length === 1, { name: 'first request arrived' })
  t.is(relay.sendDm(box(1)), true)
  t.is(relay.sendDm(box(1)), true, 'an identical box still queues: each one is its own notice')
  t.is(relay.sendDm(box(2)), false, 'full queue drops the notice')
  t.is(relay.stats().full, 1)
  t.is(relay.stats().duplicate, 0)
  for (let i = 0; i < 3; i++) {
    await until(() => held.length === 1, { name: 'request ' + (i + 1) + ' arrived' })
    held.shift().end()
  }
  await settled(relay)
  t.is(fake.requests.length, 3)
  t.is(fake.requests[1].body, fake.requests[2].body)
  relay.close()
  t.is(relay.sendDm(box()), false)
})
