'use strict'

// The 'varanda/groups/1' channel over two in-memory NoiseSecretStreams, each
// with the protomux that hypercore's replication stream installs (as the
// notices-net tests do). The seeder's page() is a stand-in that records what
// it was asked.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  PROTOCOL,
  GROUPS_PROTOCOL,
  MAX_GROUPS_MESSAGE,
  MAX_BAD_GROUPS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  validateGroupsMessage,
  attachGroups
} = require('../lib/groups-net')
const blocklistNet = require('../lib/blocklist-net')
const { until } = require('./helpers/net')

const G = 'aa'.repeat(32)
const W1 = '01'.repeat(32)
const W2 = '02'.repeat(32)
const D1 = 'd1'.repeat(32)

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

function fakePage () {
  const calls = []
  return {
    calls,
    page: ({ group, after, limit }) => {
      calls.push({ group, after, limit })
      return {
        items: [{ key: W1, diary: D1, length: 4, seq: 2 }, { key: W2, diary: D1, length: 0, seq: 3 }],
        next: after === null ? W2 : null,
        incomplete: false
      }
    }
  }
}

// A hand-driven peer on the groups protocol.
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

function noop () {}

const REQ = { type: 'writers', group: G, after: null, limit: 5 }

test('constants', (t) => {
  t.is(PROTOCOL, 'varanda/groups/1')
  t.is(GROUPS_PROTOCOL, PROTOCOL)
  t.is(MAX_GROUPS_MESSAGE, 16384)
  t.is(MAX_BAD_GROUPS, 5)
  t.is(MESSAGE_BURST, blocklistNet.MESSAGE_BURST)
  t.is(MESSAGE_RATE, blocklistNet.MESSAGE_RATE)
})

test('validateGroupsMessage: exact keys, hex64 and bounds', (t) => {
  const item = { key: W1, diary: D1, length: 0, seq: 1 }
  t.ok(validateGroupsMessage(REQ))
  t.ok(validateGroupsMessage({ ...REQ, after: W1, limit: 64 }))
  t.absent(validateGroupsMessage({ ...REQ, limit: 0 }))
  t.absent(validateGroupsMessage({ ...REQ, limit: 65 }))
  t.absent(validateGroupsMessage({ ...REQ, limit: 1.5 }))
  t.absent(validateGroupsMessage({ ...REQ, after: 'AB'.repeat(32) }))
  t.absent(validateGroupsMessage({ ...REQ, group: 'abc' }))
  t.absent(validateGroupsMessage({ ...REQ, extra: 1 }))
  t.absent(validateGroupsMessage({ type: 'writers', group: G, after: null }))
  t.absent(validateGroupsMessage({ ...REQ, type: 'page' }))
  t.absent(validateGroupsMessage(null))
  t.absent(validateGroupsMessage([]))

  const reply = { type: 'writers', group: G, items: [item], next: null, incomplete: false }
  t.ok(validateGroupsMessage(reply))
  t.ok(validateGroupsMessage({ ...reply, next: W2, incomplete: true }))
  t.absent(validateGroupsMessage({ ...reply, items: [{ ...item, extra: 1 }] }))
  t.absent(validateGroupsMessage({ ...reply, items: [{ ...item, length: -1 }] }))
  t.absent(validateGroupsMessage({ ...reply, items: [{ ...item, seq: 1.5 }] }))
  t.absent(validateGroupsMessage({ ...reply, items: [{ ...item, seq: 0 }] }))
  t.absent(validateGroupsMessage({ ...reply, items: [{ ...item, diary: 'x' }] }))
  t.absent(validateGroupsMessage({ ...reply, items: new Array(65).fill(item) }))
  t.ok(validateGroupsMessage({ ...reply, items: new Array(64).fill(item) }))
  t.absent(validateGroupsMessage({ ...reply, incomplete: 'no' }))
  t.absent(validateGroupsMessage({ ...reply, next: 'zz' }))
  t.absent(validateGroupsMessage({ ...reply, group: undefined }))
})

test('two peers exchange pages', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const hs = attachGroups(a, { role: 'seeder', page: fp.page })
  const hm = attachGroups(b, { role: 'member' })
  t.is(await hs.supported, true)
  t.is(await hm.supported, true)

  const p = await hm.requestWriters({ group: G, after: null, limit: 10 })
  t.alike(p, {
    group: G,
    items: [{ key: W1, diary: D1, length: 4, seq: 2 }, { key: W2, diary: D1, length: 0, seq: 3 }],
    next: W2,
    incomplete: false
  })
  const p2 = await hm.requestWriters({ group: G, after: W2 })
  t.is(p2.next, null)
  t.alike(fp.calls, [
    { group: G, after: null, limit: 10 },
    { group: G, after: W2, limit: 64 }
  ])
  t.is(hs.badMessages + hm.badMessages, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a second concurrent request rejects; a page() throw answers an empty incomplete page', async (t) => {
  const { a, b } = streams(t)
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
  attachGroups(a, { role: 'seeder', page, log: (e) => logged.push(e) })
  const hm = attachGroups(b, { role: 'member' })
  const first = hm.requestWriters({ group: G })
  await t.exception(hm.requestWriters({ group: G }), /in flight/)
  release()
  t.alike(await first, { group: G, items: [], next: null, incomplete: true })
  t.is(logged[0].event, 'groups-page-failed')
  t.alike(await hm.requestWriters({ group: G }), { group: G, items: [], next: null, incomplete: false })
})

test('an invalid request is refused locally', async (t) => {
  const { a, b } = streams(t)
  attachGroups(a, { role: 'seeder', page: fakePage().page })
  const hm = attachGroups(b, { role: 'member' })
  await t.exception(hm.requestWriters({ group: 'nope' }), /invalid/)
  await t.exception(hm.requestWriters({ group: G, limit: 65 }), /invalid/)
  t.is(await hm.supported, true)
})

test('the fifth bad message is tolerated and the sixth drops the socket', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const logged = []
  const hs = attachGroups(a, { role: 'seeder', page: fp.page, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened

  for (let i = 0; i < 5; i++) raw.sendJson({ type: 'writers', group: G, after: null, limit: 0 })
  await until(() => hs.badMessages === 5, { name: 'five bad messages' })
  await delay(50)
  t.absent(a.destroyed, 'five bad messages are tolerated')
  raw.sendJson({ type: 'writers', group: G, after: null, limit: 0 })
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.is(hs.badMessages, 6)
  t.is(fp.calls.length, 0, 'page() never called')
  t.is(raw.received.length, 0, 'nothing answered')
  t.alike(logged, [{ event: 'peer-dropped', peerKey: hs.peerKey, reason: 'groups' }])
})

test('an oversized frame and malformed JSON are bad before any parsing', async (t) => {
  const { a, b } = streams(t)
  const fp = fakePage()
  const hs = attachGroups(a, { role: 'seeder', page: fp.page, maxBytes: 1024 })
  const raw = rawPeer(b)
  await raw.opened

  raw.sendRaw(b4a.alloc(2048, 0x20))
  await until(() => hs.badMessages === 1, { name: 'oversized is bad' })
  raw.sendRaw(b4a.from('{not json', 'utf8'))
  await until(() => hs.badMessages === 2, { name: 'bad json is bad' })
  raw.sendRaw(b4a.alloc(0))
  await until(() => hs.badMessages === 3, { name: 'empty is bad' })

  raw.sendJson(REQ)
  await until(() => raw.received.length === 1, { name: 'reply' })
  t.is(raw.received[0].group, G)
  t.alike(fp.calls, [{ group: G, after: null, limit: 5 }])
  t.absent(a.destroyed)
})

test('seeder: a reply sent to it, and a second request while one is unanswered, are bad', async (t) => {
  const { a, b } = streams(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const hs = attachGroups(a, {
    role: 'seeder',
    page: async () => {
      calls++
      await gate
      return { items: [], next: null, incomplete: false }
    }
  })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'writers', group: G, items: [], next: null, incomplete: false })
  await until(() => hs.badMessages === 1, { name: 'reply is bad' })
  raw.sendJson(REQ)
  await until(() => calls === 1, { name: 'first request' })
  raw.sendJson(REQ)
  await until(() => hs.badMessages === 2, { name: 'second request is bad' })
  release()
  await until(() => raw.received.length === 1, { name: 'one reply' })
  t.is(calls, 1)
  t.absent(a.destroyed)
})

test('seeder: an invalid page() result answers an empty incomplete page', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  attachGroups(a, {
    role: 'seeder',
    page: () => ({ items: [{ key: 'short', diary: D1, length: 0, seq: 0 }], next: null, incomplete: false }),
    log: (e) => logged.push(e)
  })
  const hm = attachGroups(b, { role: 'member' })
  t.alike(await hm.requestWriters({ group: G }), { group: G, items: [], next: null, incomplete: true })
  t.is(logged[0].event, 'groups-page-invalid')
  t.absent(a.destroyed)
})

test('member: unsolicited replies, requests and replies for another group are bad', async (t) => {
  const { a, b } = streams(t)
  const hm = attachGroups(b, { role: 'member', requestTimeoutMs: 5000 })
  const raw = rawPeer(a)
  await raw.opened
  const reply = (group) => ({ type: 'writers', group, items: [], next: null, incomplete: false })

  raw.sendJson(reply(G))
  raw.sendJson(REQ)
  await until(() => hm.badMessages === 2, { name: 'two bad messages' })

  const p = hm.requestWriters({ group: G })
  await until(() => raw.received.length === 1, { name: 'request sent' })
  t.alike(raw.received[0], { type: 'writers', group: G, after: null, limit: 64 })
  raw.sendJson(reply(W1))
  await until(() => hm.badMessages === 3, { name: 'wrong group is bad' })
  raw.sendJson(reply(G))
  t.alike(await p, { group: G, items: [], next: null, incomplete: false })
  t.absent(b.destroyed)
})

test('a peer without the pair: supported false and the socket survives', async (t) => {
  const { a, b } = streams(t)
  const hs = attachGroups(a, { role: 'seeder', page: fakePage().page })
  t.is(await hs.supported, false)
  const { a: a2, b: b2 } = streams(t)
  const hm = attachGroups(b2, { role: 'member' })
  t.is(await hm.supported, false)
  await t.exception(hm.requestWriters({ group: G }), /closed/)
  await delay(100)
  t.absent(a2.destroyed)
  t.absent(b2.destroyed)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a request made before the channel opens is sent once it does', async (t) => {
  const { a, b } = streams(t)
  const hm = attachGroups(b, { role: 'member' })
  const p = hm.requestWriters({ group: G, limit: 3 })
  const fp = fakePage()
  attachGroups(a, { role: 'seeder', page: fp.page })
  t.is((await p).items.length, 2)
  t.alike(fp.calls, [{ group: G, after: null, limit: 3 }])
})

test('request timeout is terminal for the channel, never the socket', async (t) => {
  const { a, b } = streams(t)
  const hm = attachGroups(b, { role: 'member', requestTimeoutMs: 100 })
  const raw = rawPeer(a)
  await raw.opened
  await t.exception(hm.requestWriters({ group: G, limit: 5 }), /timed out/)
  t.is(raw.received[0].type, 'writers')
  await t.exception(hm.requestWriters({ group: G }), /closed/)
  await until(() => raw.closed, { name: 'channel closed on the peer' })
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
  t.is(hm.badMessages, 0)
  t.absent(b._varandaGroups, 'the finished handle is released')
})

test('a seeder whose page() never settles: timeout rejects and the socket stays', async (t) => {
  const { a, b } = streams(t)
  attachGroups(a, { role: 'seeder', page: () => new Promise(noop) })
  const hm = attachGroups(b, { role: 'member', requestTimeoutMs: 100 })
  await t.exception(hm.requestWriters({ group: G }), /timed out/)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a channel close rejects the in-flight request and finishes the handle', async (t) => {
  const { a, b } = streams(t)
  const hm = attachGroups(b, { role: 'member' })
  const raw = rawPeer(a)
  await raw.opened
  const p = hm.requestWriters({ group: G })
  await until(() => raw.received.length === 1, { name: 'request sent' })
  raw.close()
  await t.exception(p, /closed/)
  await t.exception(hm.requestWriters({ group: G }), /closed/)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('message rate: a peer out of tokens is dropped before parsing', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  attachGroups(a, { role: 'seeder', page: fakePage().page, messageBurst: 3, messageRate: 0.001, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  for (let i = 0; i < 6; i++) raw.sendRaw(b4a.from('x', 'utf8'))
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.ok(logged.some((e) => e.reason === 'message-rate'))
})

test('attachGroups validates its options and needs a replicated store', (t) => {
  const { a } = streams(t)
  t.exception.all(() => attachGroups(a, { role: 'other' }), /role/)
  t.exception.all(() => attachGroups(a, { role: 'seeder' }), /page/)
  t.exception.all(() => attachGroups({}, { role: 'member' }), /replicate/)
  const h = attachGroups(a, { role: 'member' })
  t.is(attachGroups(a, { role: 'member' }), h, 'cached per socket')
  t.is(typeof h.requestWriters, 'function')
})
