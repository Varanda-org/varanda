'use strict'

// The 'varanda/notices/1' channel over two in-memory NoiseSecretStreams,
// each with the protomux that hypercore's replication stream installs (as
// the blocklist-net tests do). The seeder's page() is a stand-in that
// records what it was asked.
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { PROTOCOL, MESSAGE_BURST, MESSAGE_RATE, attachNotices } = require('../lib/notices-net')
const { NOTICES_PROTOCOL, noticePayload, signNoticeProof } = require('../lib/notices')
const blocklistNet = require('../lib/blocklist-net')
const { until } = require('./helpers/net')

const coreRoot = path.join(__dirname, '..')
const D1 = '2026-01-01T00:00:00.000Z'

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

function member () {
  const kp = hcrypto.keyPair()
  return { kp, ownKey: b4a.toString(kp.publicKey, 'hex'), sign: (payload) => signNoticeProof(payload, kp) }
}

function fakePage () {
  const calls = []
  return {
    calls,
    page: ({ target, after, limit }) => {
      calls.push({ target, after, limit })
      return { items: [{ key: 'ab'.repeat(32), seq: 3, at: D1 }], next: null, incomplete: false }
    }
  }
}

// A hand-driven peer on the notices protocol.
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
    close: () => ch.close(),
    sendJson: (o) => m.send(b4a.from(JSON.stringify(o), 'utf8')),
    sendRaw: (buf) => m.send(buf)
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

test('constants', (t) => {
  t.is(PROTOCOL, NOTICES_PROTOCOL)
  t.is(MESSAGE_BURST, blocklistNet.MESSAGE_BURST)
  t.is(MESSAGE_RATE, blocklistNet.MESSAGE_RATE)
})

test('member proves and reads the page of its own key only', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  const hs = attachNotices(a, { role: 'seeder', page: fp.page })
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.is(await hs.supported, true)
  t.is(await hm.supported, true)
  t.is(await hm.proved, true)

  const p = await hm.requestPage({ after: null, limit: 10 })
  t.alike(p, { items: [{ key: 'ab'.repeat(32), seq: 3, at: D1 }], next: null, incomplete: false })
  t.alike(fp.calls, [{ target: m.ownKey, after: null, limit: 10 }])

  // Requested before the proof completes on a fresh pair: queued after it.
  const { a: a2, b: b2 } = streams(t)
  const fp2 = fakePage()
  attachNotices(a2, { role: 'seeder', page: fp2.page })
  const hm2 = attachNotices(b2, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const p2 = await hm2.requestPage({ after: { at: D1, key: 'cd'.repeat(32) } })
  t.is(p2.items.length, 1)
  t.alike(fp2.calls, [{ target: m.ownKey, after: { at: D1, key: 'cd'.repeat(32) }, limit: 30 }])
  t.is(hs.badMessages + hm.badMessages, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a second concurrent request rejects; a page() throw answers an empty incomplete page', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const logged = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let n = 0
  const page = async () => {
    n++
    if (n === 1) {
      await gate
      throw new Error('storage')
    }
    return { items: [], next: null, incomplete: false }
  }
  attachNotices(a, { role: 'seeder', page, log: (e) => logged.push(e) })
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  await hm.proved
  const first = hm.requestPage({})
  await t.exception(hm.requestPage({}), /in flight/)
  release()
  t.alike(await first, { items: [], next: null, incomplete: true })
  t.is(logged[0].event, 'notices-page-failed')
  t.alike(await hm.requestPage({}), { items: [], next: null, incomplete: false })
})

test('challenge on open; page before proof is bad and the 6th bad message destroys the socket', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const logged = []
  const hs = attachNotices(a, { role: 'seeder', page: fp.page, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'challenge' })
  t.is(raw.received[0].type, 'challenge')
  t.ok(/^[0-9a-f]{64}$/.test(raw.received[0].nonce))

  for (let i = 0; i < 5; i++) raw.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => hs.badMessages === 5, { name: 'five bad messages' })
  await delay(50)
  t.absent(a.destroyed, 'five bad messages are tolerated')
  raw.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.is(hs.badMessages, 6)
  t.is(fp.calls.length, 0, 'page() never called')
  t.is(raw.received.filter((m) => m.type === 'items').length, 0, 'no items')
  t.alike(logged, [{ event: 'peer-dropped', peerKey: hs.peerKey, reason: 'notices' }])
})

test('a valid proof binds; a second proof and a failed proof are bad; oversized frame is bad', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  const hs = attachNotices(a, { role: 'seeder', page: fp.page, maxBytes: 1024 })
  const raw = rawPeer(b)
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'challenge' })
  const nonce = raw.received[0].nonce
  const sig = hex(m.sign(noticePayload(nonce, hex(b.publicKey), m.ownKey)))
  raw.sendJson({ type: 'proof', key: m.ownKey, sig })
  raw.sendJson({ type: 'proof', key: m.ownKey, sig })
  await until(() => hs.badMessages === 1, { name: 'second proof is bad' })
  raw.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => raw.received.length === 2, { name: 'items' })
  t.is(raw.received[1].type, 'items')
  t.alike(fp.calls, [{ target: m.ownKey, after: null, limit: 5 }])

  raw.sendRaw(b4a.alloc(2048, 0x20))
  await until(() => hs.badMessages === 2, { name: 'oversized is bad' })

  // A proof signed for another connection's Noise key fails.
  const { a: a2, b: b2 } = streams(t)
  const hs2 = attachNotices(a2, { role: 'seeder', page: fp.page })
  const raw2 = rawPeer(b2)
  await raw2.opened
  await until(() => raw2.received.length === 1, { name: 'challenge 2' })
  const wrong = hex(m.sign(noticePayload(raw2.received[0].nonce, hex(b.publicKey), m.ownKey)))
  raw2.sendJson({ type: 'proof', key: m.ownKey, sig: wrong })
  await until(() => hs2.badMessages === 1, { name: 'failed proof is bad' })
  raw2.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => hs2.badMessages === 2, { name: 'page after failed proof is bad' })
  t.is(fp.calls.length, 1)
  t.absent(a.destroyed)
  t.absent(a2.destroyed)
})

test('a member whose sign throws rejects proved; the socket stays up', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  const logged = []
  attachNotices(a, { role: 'seeder', page: fp.page })
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: () => { throw new Error('identity locked') }, log: (e) => logged.push(e) })
  await t.exception(hm.proved, /identity locked/)
  await t.exception(hm.requestPage({}), /closed/)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
  t.is(fp.calls.length, 0)
})

test('member: unsolicited items and a second challenge are bad', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const raw = rawPeer(a)
  await raw.opened
  raw.sendJson({ type: 'challenge', nonce: 'ab'.repeat(32) })
  t.is(await hm.proved, true)
  await until(() => raw.received.length === 1, { name: 'proof' })
  t.is(raw.received[0].type, 'proof')
  t.is(raw.received[0].key, m.ownKey)
  raw.sendJson({ type: 'challenge', nonce: 'cd'.repeat(32) })
  raw.sendJson({ type: 'items', items: [], next: null, incomplete: false })
  await until(() => hm.badMessages === 2, { name: 'two bad messages' })
  t.absent(b.destroyed)
})

test('a side that never opens the channel: supported false, the socket stays up', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const hs = attachNotices(a, { role: 'seeder', page: fp.page })
  t.is(await hs.supported, false)
  await delay(100)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('requestPage timeout is terminal for the channel, never the socket', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign, requestTimeoutMs: 100 })
  const raw = rawPeer(a)
  await raw.opened
  raw.sendJson({ type: 'challenge', nonce: 'ab'.repeat(32) })
  await hm.proved
  await t.exception(hm.requestPage({ limit: 5 }), /timed out/)
  t.is(raw.received[1].type, 'page')
  // The channel is closed by the timeout; no "already in flight" afterwards.
  await t.exception(hm.requestPage({}), /closed/)
  await until(() => raw.closed, { name: 'channel closed on the peer' })
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
  t.is(hm.badMessages, 0)
})

test('a seeder whose page() never settles: timeout rejects, closes the channel, keeps the socket', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  let calls = 0
  attachNotices(a, { role: 'seeder', page: () => { calls++; return new Promise(noop) } })
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign, requestTimeoutMs: 100 })
  t.is(await hm.proved, true)
  await t.exception(hm.requestPage({}), /timed out/)
  await t.exception(hm.requestPage({}), /closed/, 'second request rejects closed at once')
  t.is(calls, 1)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
  // Recovery is by the caller: a fresh attach on the same socket opens a
  // fresh channel; the seeder starts clean and challenges again.
  const hm2 = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign, requestTimeoutMs: 100 })
  t.not(hm2, hm)
  t.is(await hm2.proved, true)
  t.absent(a.destroyed)
})

test('member: a rejected open or a close before the challenge settles proved false promptly', async (t) => {
  // The other side never pairs the protocol (old peer): rejected open.
  const { a, b } = streams(t)
  const m = member()
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  t.is(await hm.supported, false)
  t.is(await hm.proved, false, 'proved settles without a socket close')
  await t.exception(hm.requestPage({}), /closed/)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)

  // The seeder opens and closes the channel before any challenge.
  const { a: a2, b: b2 } = streams(t)
  const hm2 = attachNotices(b2, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const raw = rawPeer(a2)
  await raw.opened
  t.is(await hm2.supported, true)
  raw.close()
  t.is(await hm2.proved, false)
  await t.exception(hm2.requestPage({}), /closed/)
  await delay(50)
  t.absent(a2.destroyed)
  t.absent(b2.destroyed)
})

test('member: a channel close rejects the in-flight request and finishes the handle', async (t) => {
  const { a, b } = streams(t)
  const m = member()
  const hm = attachNotices(b, { role: 'member', ownKey: m.ownKey, sign: m.sign })
  const raw = rawPeer(a)
  await raw.opened
  raw.sendJson({ type: 'challenge', nonce: 'ab'.repeat(32) })
  t.is(await hm.proved, true)
  const p = hm.requestPage({})
  await until(() => raw.received.length === 2, { name: 'page sent' })
  raw.close()
  await t.exception(p, /closed/)
  await t.exception(hm.requestPage({}), /closed/)
  t.absent(b._varandaNotices, 'the finished handle is released')
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('seeder: a peer that reopens the channel starts clean (fresh challenge, no binding)', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const m = member()
  const hs = attachNotices(a, { role: 'seeder', page: fp.page })
  const raw1 = rawPeer(b)
  await raw1.opened
  await until(() => raw1.received.length === 1, { name: 'challenge 1' })
  const nonce1 = raw1.received[0].nonce
  raw1.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(noticePayload(nonce1, hex(b.publicKey), m.ownKey))) })
  raw1.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => raw1.received.length === 2, { name: 'items 1' })
  raw1.close()
  await until(() => raw1.closed, { name: 'closed 1' })

  const raw2 = rawPeer(b)
  await raw2.opened
  await until(() => raw2.received.length === 1, { name: 'challenge 2' })
  const nonce2 = raw2.received[0].nonce
  t.not(nonce2, nonce1, 'fresh challenge')
  // The old binding is gone: a page before the new proof is bad, and the
  // old nonce no longer proves anything.
  raw2.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => hs.badMessages === 1, { name: 'page before new proof is bad' })
  raw2.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(noticePayload(nonce1, hex(b.publicKey), m.ownKey))) })
  await until(() => hs.badMessages === 2, { name: 'stale nonce is bad' })
  t.is(fp.calls.length, 1)
  raw2.close()
  await until(() => raw2.closed, { name: 'closed 2' })

  const raw3 = rawPeer(b)
  await raw3.opened
  await until(() => raw3.received.length === 1, { name: 'challenge 3' })
  const nonce3 = raw3.received[0].nonce
  raw3.sendJson({ type: 'proof', key: m.ownKey, sig: hex(m.sign(noticePayload(nonce3, hex(b.publicKey), m.ownKey))) })
  raw3.sendJson({ type: 'page', after: null, limit: 5 })
  await until(() => raw3.received.length === 2, { name: 'items 3' })
  t.is(raw3.received[1].type, 'items')
  t.is(fp.calls.length, 2)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('notices modules load without node-only modules, hypercore or crypto', (t) => {
  for (const mod of ['./lib/notices.js', './lib/notices-net.js']) {
    const code = "require('" + mod + "'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
    const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
    t.is(r.status, 0, r.stderr)
    const cached = JSON.parse(r.stdout)
    for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/', '/protomux/']) {
      t.absent(cached.some((p) => p.includes(frag)), mod + ' does not load ' + frag)
    }
  }
})
