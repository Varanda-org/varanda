'use strict'

// The 'varanda/discovery/1' channel over two in-memory NoiseSecretStreams,
// each with the protomux that hypercore's replication stream installs (as
// the notices-net tests do). The seeder's page() is a stand-in inventory that
// keeps snapshots by view id and records what it was asked.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  PROTOCOL,
  MAX_DISCOVERY_MESSAGE,
  MAX_DISCOVERY_LIMIT,
  MAX_BAD_DISCOVERY,
  DISCOVERY_BURST,
  DISCOVERY_RATE,
  DISCOVERY_PACE_MS,
  MAX_DISCOVERY_REQUESTS,
  MAX_PAGES_PER_READ,
  newViewId,
  validateRequest,
  validateAnswer,
  attachDiscovery
} = require('../lib/discovery-net')
const { MAX_LOG_BLOCKS } = require('../lib/records')
const { MAX_INVENTORY } = require('../lib/admission')
const { until } = require('./helpers/net')

const K = (i) => i.toString(16).padStart(64, '0')
const V1 = 'ab'.repeat(16)

function streams (t) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  Hypercore.createProtocolStream(a)
  Hypercore.createProtocolStream(b)
  t.teardown(() => {
    a.destroy()
    b.destroy()
  }, { force: true })
  return { a, b }
}

// An inventory of n diaries, paged by index; each view is a frozen snapshot.
function inventory (n) {
  const entries = []
  for (let i = 0; i < n; i++) entries.push({ key: K(i + 1), length: i })
  const views = new Map()
  const calls = []
  return {
    calls,
    views,
    page: ({ after, limit, view }) => {
      calls.push({ after, limit, view })
      let snap
      if (view === null) {
        view = newViewId()
        snap = entries.slice()
        views.set(view, snap)
      } else {
        snap = views.get(view)
        if (snap === undefined) return { stale: true }
      }
      const start = after === null ? 0 : after.t + 1
      const items = snap.slice(start, start + limit)
      const last = start + items.length - 1
      const next = start + items.length < snap.length ? { t: last, h: snap[last].key } : null
      return { view, items, next, total: snap.length }
    }
  }
}

// A hand-driven peer on the discovery protocol.
function rawPeer (noise) {
  const received = []
  const ch = noise.userData.createChannel({ protocol: PROTOCOL })
  const m = ch.addMessage({
    encoding: c.buffer,
    onmessage: (buf) => received.push(JSON.parse(b4a.toString(buf, 'utf8')))
  })
  ch.open()
  return {
    received,
    opened: ch.fullyOpened(),
    get closed () { return ch.closed },
    sendJson: (o) => m.send(b4a.from(JSON.stringify(o), 'utf8')),
    sendRaw: (buf) => m.send(buf)
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function answer (id, items = [], extra = {}) {
  return { type: 'page', id, view: V1, items, next: null, total: items.length, ...extra }
}

test('constants', (t) => {
  t.is(PROTOCOL, 'varanda/discovery/1')
  t.is(MAX_DISCOVERY_MESSAGE, 16384)
  t.is(MAX_DISCOVERY_LIMIT, 64)
  t.is(MAX_BAD_DISCOVERY, 5)
  t.is(DISCOVERY_BURST, 8)
  t.is(DISCOVERY_RATE, 4)
  t.is(MAX_DISCOVERY_REQUESTS, 160)
  t.is(MAX_PAGES_PER_READ, 8)
  t.is(DISCOVERY_PACE_MS * DISCOVERY_RATE, 1000, 'the member paces at the bucket refill rate')
  t.ok(/^[0-9a-f]{32}$/.test(newViewId()))
  t.not(newViewId(), newViewId())
})

test('validateRequest: exact keys, types and bounds', (t) => {
  const ok = { type: 'page', id: 1, after: null, limit: 64 }
  t.ok(validateRequest(ok))
  t.ok(validateRequest({ ...ok, view: V1 }))
  t.ok(validateRequest({ ...ok, after: { t: 0, h: K(1) } }))
  t.absent(validateRequest({ ...ok, extra: 1 }))
  t.absent(validateRequest({ type: 'page', id: 1, after: null }))
  t.absent(validateRequest({ ...ok, type: 'items' }))
  t.absent(validateRequest({ ...ok, id: 0 }))
  t.absent(validateRequest({ ...ok, id: 1.5 }))
  t.absent(validateRequest({ ...ok, id: '1' }))
  t.absent(validateRequest({ ...ok, limit: 0 }))
  t.absent(validateRequest({ ...ok, limit: 65 }))
  t.absent(validateRequest({ ...ok, view: null }))
  t.absent(validateRequest({ ...ok, view: 'AB'.repeat(16) }))
  t.absent(validateRequest({ ...ok, view: 'ab'.repeat(15) }))
  t.absent(validateRequest({ ...ok, after: { t: -1, h: K(1) } }))
  t.absent(validateRequest({ ...ok, after: { t: 0, h: K(1).toUpperCase().replace('0', 'A') } }))
  t.absent(validateRequest({ ...ok, after: { t: 0, h: K(1), x: 1 } }))
  t.absent(validateRequest({ ...ok, after: [] }))
  t.absent(validateRequest(null))
  t.absent(validateRequest([ok]))
})

test('validateAnswer: shape, limit, distinct keys, bounds, stale', (t) => {
  const items = [{ key: K(1), length: 0 }, { key: K(2), length: MAX_LOG_BLOCKS }]
  t.ok(validateAnswer(answer(1, items)))
  t.ok(validateAnswer(answer(1, items), 2))
  t.absent(validateAnswer(answer(1, items), 1), 'more items than the limit')
  t.absent(validateAnswer(answer(1, [items[0], items[0]])), 'duplicate keys')
  t.absent(validateAnswer(answer(1, [{ key: K(1), length: MAX_LOG_BLOCKS + 1 }])))
  t.absent(validateAnswer(answer(1, [{ key: K(1), length: -1 }])))
  t.absent(validateAnswer(answer(1, [{ key: K(1), length: 1, seq: 2 }])))
  t.absent(validateAnswer(answer(1, [{ key: 'xy', length: 1 }])))
  t.ok(validateAnswer(answer(1, [], { total: MAX_INVENTORY })))
  t.absent(validateAnswer(answer(1, [], { total: MAX_INVENTORY + 1 })))
  t.absent(validateAnswer(answer(1, [], { total: -1 })))
  t.absent(validateAnswer(answer(1, [], { view: 'zz'.repeat(16) })))
  t.absent(validateAnswer(answer(1, [], { next: { t: 1 } })))
  t.ok(validateAnswer(answer(1, [], { next: { t: 1, h: K(9) } })))
  t.absent(validateAnswer({ ...answer(1), extra: true }))
  const big = []
  for (let i = 0; i < 65; i++) big.push({ key: K(i + 1), length: 1 })
  t.absent(validateAnswer(answer(1, big)), 'over the hard item cap')
  t.ok(validateAnswer({ type: 'page', id: 3, stale: true }), 'a stale answer validates')
  t.absent(validateAnswer({ type: 'page', id: 3, stale: false }))
  t.absent(validateAnswer({ type: 'page', id: 3, stale: true, view: V1 }))
  t.absent(validateAnswer({ type: 'page', id: 0, stale: true }))
})

test('round trip and cursor paging to the end within one view', async (t) => {
  const { a, b } = streams(t)
  const inv = inventory(5)
  const hs = attachDiscovery(a, { role: 'seeder', page: inv.page })
  const hm = attachDiscovery(b, { role: 'member', paceMs: 0 })
  t.is(await hs.supported, true)
  t.is(await hm.supported, true)
  t.is(attachDiscovery(b, { role: 'member' }), hm, 'one handle per socket')

  const p1 = await hm.page({ limit: 2 })
  t.is(p1.total, 5)
  t.alike(p1.items, [{ key: K(1), length: 0 }, { key: K(2), length: 1 }])
  t.alike(p1.next, { t: 1, h: K(2) })
  t.ok(/^[0-9a-f]{32}$/.test(p1.view))

  const seen = p1.items.slice()
  let next = p1.next
  while (next !== null) {
    const p = await hm.page({ after: next, limit: 2, view: p1.view })
    t.is(p.view, p1.view)
    seen.push(...p.items)
    next = p.next
  }
  t.is(seen.length, 5)
  t.alike(seen.map((x) => x.key), [K(1), K(2), K(3), K(4), K(5)])
  t.alike(inv.calls[0], { after: null, limit: 2, view: null })
  t.alike(inv.calls[1], { after: { t: 1, h: K(2) }, limit: 2, view: p1.view })

  const r = await hm.read({ limit: 2 })
  t.is(r.complete, true)
  t.is(r.total, 5)
  t.is(r.items.length, 5)
  t.is(hs.badMessages + hm.badMessages, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('stale answers: a gone view and a failing page() both answer stale; read starts over', async (t) => {
  const { a, b } = streams(t)
  const inv = inventory(3)
  const logged = []
  let fail = false
  const page = (q) => {
    if (fail) throw new Error('storage')
    return inv.page(q)
  }
  attachDiscovery(a, { role: 'seeder', page, log: (e) => logged.push(e) })
  const hm = attachDiscovery(b, { role: 'member', paceMs: 0 })
  t.alike(await hm.page({ view: 'cd'.repeat(16) }), { stale: true })

  fail = true
  t.alike(await hm.page({}), { stale: true })
  t.is(logged[0].event, 'discovery-page-failed')
  fail = false

  // A seeder that forgets the view mid-read: the read stops and keeps what
  // it had; the next read starts over in a fresh view.
  const p = await hm.page({ limit: 1 })
  inv.views.clear()
  t.alike(await hm.page({ after: p.next, limit: 1, view: p.view }), { stale: true })
  let forgetAt = 3
  const { a: a2, b: b2 } = streams(t)
  attachDiscovery(a2, {
    role: 'seeder',
    page: (q) => {
      if (--forgetAt === 0) inv.views.clear()
      return inv.page(q)
    }
  })
  const hm2 = attachDiscovery(b2, { role: 'member', paceMs: 0 })
  const r = await hm2.read({ limit: 1 })
  t.alike(r, { view: null, items: [{ key: K(1), length: 0 }, { key: K(2), length: 1 }], total: 3, complete: false, stale: true })
  const r2 = await hm2.read({ limit: 1 })
  t.is(r2.complete, true)
  t.alike(r2.items.map((x) => x.key), [K(1), K(2), K(3)])
  t.is(hm.badMessages + hm2.badMessages, 0)
})

test('a page() result the member would reject is logged and answered stale', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const results = [
    { view: V1, items: [{ key: K(1), length: 1 }, { key: K(1), length: 2 }], next: null, total: 2 },
    { items: [], next: null, total: 0 },
    { view: V1, items: [{ key: K(1), length: 1 }, { key: K(2), length: 1 }], next: null, total: 2 },
    null
  ]
  let i = 0
  attachDiscovery(a, { role: 'seeder', page: () => results[i++], log: (e) => logged.push(e) })
  const hm = attachDiscovery(b, { role: 'member', paceMs: 0 })
  t.alike(await hm.page({}), { stale: true }, 'duplicate keys')
  t.alike(await hm.page({}), { stale: true }, 'no view')
  t.alike(await hm.page({ limit: 1 }), { stale: true }, 'more than the limit')
  t.alike(await hm.page({}), { stale: true }, 'null')
  t.is(logged.filter((e) => e.event === 'discovery-page-invalid').length, 4)
  t.is(hm.badMessages, 0)
})

test('a page() that answers a named view with another view is answered stale', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  attachDiscovery(a, {
    role: 'seeder',
    page: () => ({ view: 'ef'.repeat(16), items: [], next: null, total: 0 }),
    log: (e) => logged.push(e)
  })
  const hm = attachDiscovery(b, { role: 'member', paceMs: 0, requestTimeoutMs: 1000 })
  t.alike(await hm.page({ view: V1 }), { stale: true })
  t.is(logged[0].event, 'discovery-page-invalid')
  const p = await hm.page({})
  t.is(p.view, 'ef'.repeat(16), 'no view named: any view is fine')
  t.is(hm.badMessages, 0)
})

test('a side that never attaches: supported false, the socket stays up', async (t) => {
  const { a, b } = streams(t)
  const hs = attachDiscovery(a, { role: 'seeder', page: inventory(1).page })
  t.is(await hs.supported, false)
  const { a: a2, b: b2 } = streams(t)
  const hm = attachDiscovery(b2, { role: 'member' })
  t.is(await hm.supported, false)
  await t.exception(hm.page({}), /closed/)
  await delay(100)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
  t.absent(a2.destroyed)
  t.absent(b2.destroyed)
})

test('seeder: malformed requests count as bad and drop the peer past the limit', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const hs = attachDiscovery(a, {
    role: 'seeder',
    page: inventory(1).page,
    log: (e) => logged.push(e),
    messageBurst: 100
  })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendRaw(b4a.from('not json'))
  raw.sendJson({ type: 'page', id: 1, after: null, limit: 65 })
  raw.sendJson({ type: 'page', id: 1, after: null, limit: 1, extra: true })
  raw.sendJson({ type: 'page', id: 1, view: V1, items: [], next: null, total: 0 })
  raw.sendRaw(b4a.alloc(MAX_DISCOVERY_MESSAGE + 1, 0x20))
  await until(() => hs.badMessages === 5, { name: 'five bad messages' })
  t.absent(a.destroyed, 'five are tolerated')
  t.is(raw.received.length, 0, 'the seeder sends nothing unsolicited')
  raw.sendJson({ type: 'page', id: 2, after: null, limit: 1, view: null })
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.alike(logged.find((e) => e.event === 'peer-dropped').reason, 'discovery')
})

test('member: invalid and unsolicited answers count as bad and drop the peer past the limit', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const hm = attachDiscovery(b, { role: 'member', paceMs: 0, log: (e) => logged.push(e) })
  const raw = rawPeer(a)
  await raw.opened
  t.is(await hm.supported, true)

  raw.sendJson(answer(1)) // unsolicited
  await until(() => hm.badMessages === 1, { name: 'unsolicited' })

  const p = hm.page({ limit: 1, view: V1 })
  await until(() => raw.received.length === 1, { name: 'request' })
  const req = raw.received[0]
  t.alike(req, { type: 'page', id: 1, after: null, limit: 1, view: V1 })
  raw.sendJson(answer(req.id + 1)) // wrong id
  raw.sendJson(answer(req.id, [{ key: K(1), length: 1 }, { key: K(2), length: 1 }])) // over the limit
  raw.sendJson(answer(req.id, [], { view: 'cd'.repeat(16) })) // another view
  raw.sendJson({ type: 'page', id: req.id, after: null, limit: 1 }) // a request
  await until(() => hm.badMessages === 5, { name: 'five bad' })
  t.absent(b.destroyed)
  raw.sendJson({ type: 'page', id: req.id, stale: true })
  t.alike(await p, { stale: true }, 'the right answer still lands')
  raw.sendJson({ type: 'page', id: req.id, stale: true }) // a second answer: unsolicited
  await until(() => b.destroyed, { name: 'member drops the peer' })
  t.is(hm.badMessages, 6)
  t.is(logged.find((e) => e.event === 'peer-dropped').reason, 'discovery')
})

test('seeder: a burst over the token bucket drops the peer with message-rate', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const inv = inventory(1)
  attachDiscovery(a, { role: 'seeder', page: inv.page, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  for (let i = 1; i <= DISCOVERY_BURST + 1; i++) raw.sendJson({ type: 'page', id: i, after: null, limit: 1 })
  await until(() => a.destroyed, { name: 'dropped' })
  t.is(logged.find((e) => e.event === 'peer-dropped').reason, 'message-rate')
  t.is(inv.calls.length, DISCOVERY_BURST)
})

test('request cap: the seeder drops past it; the member stops itself at it', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const inv = inventory(1)
  attachDiscovery(a, { role: 'seeder', page: inv.page, log: (e) => logged.push(e), maxRequests: 3, messageBurst: 100 })
  const raw = rawPeer(b)
  await raw.opened
  for (let i = 1; i <= 4; i++) raw.sendJson({ type: 'page', id: i, after: null, limit: 1 })
  await until(() => a.destroyed, { name: 'dropped' })
  t.is(logged.find((e) => e.event === 'peer-dropped').reason, 'discovery-request-cap')
  t.is(inv.calls.length, 3)

  const { a: a2, b: b2 } = streams(t)
  const hs2 = attachDiscovery(a2, { role: 'seeder', page: inventory(1).page })
  const hm2 = attachDiscovery(b2, { role: 'member', paceMs: 0, maxRequests: 2 })
  await hm2.page({})
  await hm2.page({})
  await t.exception(hm2.page({}), /cap/)
  t.absent(a2.destroyed)
  t.is(hs2.badMessages, 0)
})

test('a page asked before the open gets a full timeout from the send', async (t) => {
  const { a, b } = streams(t)
  // The peer holds the open 200 ms (a slow link) through a pair handler.
  let raw = null
  a.userData.pair({ protocol: PROTOCOL }, async () => {
    await delay(200)
    raw = rawPeer(a)
  })
  const hm = attachDiscovery(b, { role: 'member', paceMs: 0, requestTimeoutMs: 300 })
  const asked = hm.page({ limit: 5 })
  await until(() => raw !== null, { name: 'the peer opens late' })
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'the request is sent once open' })
  // 400 ms after the ask, 200 ms after the send: inside the send's timeout.
  await delay(200)
  raw.sendJson(answer(raw.received[0].id))
  const res = await asked
  t.is(res.view, V1)
  t.alike(res.items, [])
  t.is(hm.badMessages, 0)
})

test('a request with no answer times out, closes the channel and keeps the socket', async (t) => {
  const { a, b } = streams(t)
  const hm = attachDiscovery(b, { role: 'member', requestTimeoutMs: 100 })
  const raw = rawPeer(a)
  await raw.opened
  await t.exception(hm.page({ limit: 5 }), /timed out/)
  t.is(raw.received[0].type, 'page')
  await t.exception(hm.page({}), /closed/)
  await until(() => raw.closed, { name: 'channel closed on the peer' })
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
  t.is(hm.badMessages, 0)
  t.not(attachDiscovery(b, { role: 'member' }), hm, 'a fresh attach after the close')
})

test('close during a request rejects it; a second concurrent request rejects', async (t) => {
  const { a, b } = streams(t)
  const hm = attachDiscovery(b, { role: 'member' })
  const raw = rawPeer(a)
  await raw.opened
  const p = hm.page({})
  await t.exception(hm.page({}), /in flight/)
  await until(() => raw.received.length === 1, { name: 'request' })
  hm.close()
  await t.exception(p, /closed/)
  await t.exception(hm.page({}), /closed/)
  await until(() => raw.closed, { name: 'channel closed on the peer' })
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('12 back to back pages are paced and never trip the seeder bucket; read stops at 8 pages', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  const inv = inventory(20)
  const at = []
  const hs = attachDiscovery(a, {
    role: 'seeder',
    page: (q) => {
      at.push(Date.now())
      return inv.page(q)
    },
    log: (e) => logged.push(e)
  })
  const hm = attachDiscovery(b, { role: 'member' })
  const start = Date.now()
  for (let i = 0; i < 12; i++) await hm.page({ limit: 1 })
  const elapsed = Date.now() - start
  t.is(at.length, 12)
  t.ok(elapsed >= 11 * DISCOVERY_PACE_MS - 30, 'paced: ' + elapsed + ' ms')
  t.absent(logged.some((e) => e.event === 'peer-dropped'))
  t.absent(a.destroyed)

  const r = await hm.read({ limit: 1 })
  t.is(r.complete, false)
  t.is(r.items.length, MAX_PAGES_PER_READ)
  t.is(r.total, 20)
  t.is(at.length, 12 + MAX_PAGES_PER_READ)
  await t.exception.all(hm.read({ maxPages: 0 }), /maxPages/)
  t.is(hs.badMessages + hm.badMessages, 0)
  t.absent(logged.some((e) => e.event === 'peer-dropped'))
})

test('attachDiscovery rejects bad options', (t) => {
  const { a } = streams(t)
  t.exception.all(() => attachDiscovery(a, { role: 'other' }), /role/)
  t.exception.all(() => attachDiscovery(a, { role: 'seeder' }), /page/)
  t.exception.all(() => attachDiscovery(a, { role: 'member', requestTimeoutMs: 0 }), /requestTimeoutMs/)
  t.exception.all(() => attachDiscovery({}, { role: 'member' }), /replicate/)
})
