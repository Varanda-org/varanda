'use strict'

// Capability bits in the 'varanda/admission/1' open handshake, over two
// in-memory NoiseSecretStreams with the protomux hypercore installs (as the
// groups-net tests do). An "old" peer is a raw protomux channel with no
// handshake encoding, as every peer before capabilities opened it.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  PROTOCOL,
  MAX_HELLO_HAVE,
  CAP_NO_INVENTORY,
  CAP_DISCOVERY,
  attachAdmission
} = require('../lib/admission')
const net = require('../lib/net')
const { until } = require('./helpers/net')

const CERT = { v: 1, seeder: 'cd'.repeat(32), date: '2026-01-01T00:00:00.000Z', association: 'ab'.repeat(32), signature: 'ef'.repeat(64) }
const UNKNOWN_CAP = 64

function keyOf (i) {
  return i.toString(16).padStart(64, '0')
}

function inventory (n) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ key: keyOf(i + 1), length: i + 1 })
  return out
}

function streams (t) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  Hypercore.createProtocolStream(a)
  Hypercore.createProtocolStream(b)
  a.on('error', () => {})
  b.on('error', () => {})
  t.teardown(() => {
    a.destroy()
    b.destroy()
  }, { force: true })
  return { a, b }
}

// A new peer that records every admission message it receives.
function newPeer (stream, opts) {
  const received = []
  const peer = attachAdmission(stream, { ...opts, onmessage: (msg) => received.push(msg) })
  return { peer, received }
}

// An old peer: no handshake encoding (or a raw one, to send arbitrary
// handshake bytes), JSON messages over c.buffer.
function oldPeer (stream, { handshake = null } = {}) {
  const mux = stream.userData
  const received = []
  let resolveOpen
  const opened = new Promise((resolve) => { resolveOpen = resolve })
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    handshake: handshake === null ? null : c.raw,
    onopen: () => resolveOpen()
  })
  const message = channel.addMessage({ encoding: c.buffer, onmessage: (buf) => received.push(JSON.parse(b4a.toString(buf, 'utf8'))) })
  if (handshake === null) channel.open()
  else channel.open(handshake)
  return {
    opened,
    received,
    sendJson: (obj) => message.send(b4a.from(JSON.stringify(obj), 'utf8'))
  }
}

function sendInventory (old, role, have) {
  const hello = { type: 'hello', v: 1, role, count: have.length, have: have.slice(0, MAX_HELLO_HAVE) }
  if (role === 'seeder') hello.cert = CERT
  old.sendJson(hello)
  for (const e of have.slice(MAX_HELLO_HAVE)) old.sendJson({ type: 'have', key: e.key, length: e.length })
}

function haveKeys (received) {
  const keys = new Set()
  for (const m of received) {
    if (m.type === 'hello') for (const e of m.have) keys.add(e.key)
    if (m.type === 'have') keys.add(m.key)
  }
  return keys
}

test('net.js re-exports the capability bits', (t) => {
  t.is(net.CAP_NO_INVENTORY, CAP_NO_INVENTORY)
  t.is(net.CAP_DISCOVERY, CAP_DISCOVERY)
  t.is(CAP_NO_INVENTORY, 1)
  t.is(CAP_DISCOVERY, 2)
})

test('old member against a new lean seeder gets the full inventory', async (t) => {
  const { a, b } = streams(t)
  const have = inventory(300)
  const seeder = newPeer(a, { role: 'seeder', cert: CERT, have, caps: CAP_DISCOVERY, lean: true })
  const old = oldPeer(b)
  await old.opened
  sendInventory(old, 'member', inventory(3))

  await until(() => haveKeys(old.received).size === 300, { name: 'full inventory at the old member' })
  const hello = old.received[0]
  t.is(hello.type, 'hello')
  t.is(hello.count, 300)
  t.is(hello.have.length, MAX_HELLO_HAVE)
  t.alike(hello.cert, CERT)

  await until(() => seeder.peer.inventoryComplete, { name: 'seeder sees the old member inventory' })
  t.is(seeder.peer.remoteCaps, 0)
  t.is(seeder.peer.lean, false)
  t.is(seeder.peer.remoteHave.size, 3)
})

test('new member asking for no inventory against an old seeder gets the full inventory', async (t) => {
  const { a, b } = streams(t)
  const member = newPeer(a, { role: 'member', have: inventory(2), caps: CAP_NO_INVENTORY })
  const old = oldPeer(b)
  await old.opened
  sendInventory(old, 'seeder', inventory(300))

  await until(() => member.peer.inventoryComplete, { name: 'member inventory complete' })
  t.is(member.peer.remoteHave.size, 300)
  t.is(member.peer.remoteRole, 'seeder')
  t.is(member.peer.remoteCaps, 0)
  await until(() => old.received.length >= 1, { name: 'old seeder gets the member hello' })
  t.alike(old.received[0], { type: 'hello', v: 1, role: 'member', count: 2, have: inventory(2) })
})

test('lean seeder sends a member that asks a hello with no inventory, also after growth', async (t) => {
  const { a, b } = streams(t)
  const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(300), caps: CAP_DISCOVERY, lean: true })
  const member = newPeer(b, { role: 'member', have: inventory(5), caps: CAP_NO_INVENTORY })

  const hello = await member.peer.hello
  t.alike(hello, { type: 'hello', v: 1, role: 'seeder', count: 0, have: [], cert: CERT })
  await until(() => member.peer.inventoryComplete, { name: 'member inventory complete' })
  t.is(member.peer.remoteHave.size, 0)
  t.is(member.peer.remoteCaps, CAP_DISCOVERY)

  await until(() => seeder.peer.inventoryComplete, { name: 'seeder sees the member inventory' })
  t.is(seeder.peer.lean, true)
  t.is(seeder.peer.remoteCaps, CAP_NO_INVENTORY)
  t.is(seeder.peer.remoteHave.size, 5, 'the member still sends its own inventory')

  // A growth broadcast is dropped for this peer; admitted and rejected pass.
  t.is(seeder.peer.send({ type: 'have', key: keyOf(301), length: 1 }), true)
  t.ok(seeder.peer.send({ type: 'admitted', key: keyOf(1), length: 1 }))
  t.ok(seeder.peer.send({ type: 'rejected', key: keyOf(2), reason: 'quota' }))
  await until(() => member.received.some((m) => m.type === 'rejected'), { name: 'rejected arrives' })
  t.ok(member.received.some((m) => m.type === 'admitted'))
  t.is(member.received.filter((m) => m.type === 'have').length, 0)
  t.is(member.received.filter((m) => m.type === 'hello').length, 1)
})

test('haves queued before the channel opens are dropped for a lean peer', async (t) => {
  const { a, b } = streams(t)
  const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(3), lean: true })
  seeder.peer.send({ type: 'have', key: keyOf(400), length: 2 })
  seeder.peer.send({ type: 'admitted', key: keyOf(401), length: 1 })
  const member = newPeer(b, { role: 'member', caps: CAP_NO_INVENTORY })

  await until(() => member.received.some((m) => m.type === 'admitted'), { name: 'admitted arrives' })
  t.is(member.received.filter((m) => m.type === 'have').length, 0)
  t.is(member.peer.remoteCount, 0)
  t.is(seeder.peer.queued(), 0)
})

test('seeder with lean false sends the full inventory to a member that asks', async (t) => {
  const { a, b } = streams(t)
  const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(300), caps: CAP_DISCOVERY })
  const member = newPeer(b, { role: 'member', caps: CAP_NO_INVENTORY })

  await until(() => member.peer.inventoryComplete, { name: 'member inventory complete' })
  t.is(member.peer.remoteCount, 300)
  t.is(member.peer.remoteHave.size, 300)
  t.is(seeder.peer.lean, false)
  t.is(seeder.peer.remoteCaps, CAP_NO_INVENTORY)
})

test('a member that does not ask gets the full inventory from a lean seeder', async (t) => {
  const { a, b } = streams(t)
  const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(300), caps: CAP_DISCOVERY, lean: true })
  const member = newPeer(b, { role: 'member' })

  await until(() => member.peer.inventoryComplete, { name: 'member inventory complete' })
  t.is(member.peer.remoteHave.size, 300)
  t.is(seeder.peer.lean, false)

  seeder.peer.send({ type: 'have', key: keyOf(301), length: 1 })
  await until(() => member.peer.remoteHave.has(keyOf(301)), { name: 'growth arrives' })
  t.pass('growth reaches a member that did not ask')
})

test('lean is honoured for the seeder role only', async (t) => {
  const { a, b } = streams(t)
  const left = newPeer(a, { role: 'member', have: inventory(150), lean: true, caps: CAP_NO_INVENTORY })
  const right = newPeer(b, { role: 'member', caps: CAP_NO_INVENTORY })

  await until(() => right.peer.inventoryComplete, { name: 'inventory complete' })
  t.is(right.peer.remoteHave.size, 150)
  t.is(left.peer.lean, false)
})

test('unknown capability bits are ignored', async (t) => {
  {
    const { a, b } = streams(t)
    const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(300), lean: true })
    const member = newPeer(b, { role: 'member', caps: UNKNOWN_CAP })
    await until(() => member.peer.inventoryComplete, { name: 'full inventory with an unknown bit only' })
    t.is(member.peer.remoteHave.size, 300)
    t.is(seeder.peer.remoteCaps, UNKNOWN_CAP)
    t.is(seeder.peer.lean, false)
  }
  {
    const { a, b } = streams(t)
    const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(300), lean: true })
    const member = newPeer(b, { role: 'member', caps: CAP_NO_INVENTORY | UNKNOWN_CAP })
    const hello = await member.peer.hello
    t.is(hello.count, 0)
    t.is(seeder.peer.lean, true)
  }
})

test('handshake bytes that do not parse read as no capabilities', async (t) => {
  const { a, b } = streams(t)
  const seeder = newPeer(a, { role: 'seeder', cert: CERT, have: inventory(300), lean: true })
  // 0xfd announces a 2-byte uint that never follows.
  const old = oldPeer(b, { handshake: b4a.from([0xfd]) })
  await old.opened
  sendInventory(old, 'member', [])
  await until(() => haveKeys(old.received).size === 300, { name: 'full inventory' })
  t.is(seeder.peer.remoteCaps, 0)
  t.is(seeder.peer.lean, false)
})

test('invalid caps option throws', async (t) => {
  const { a } = streams(t)
  await t.exception.all(() => attachAdmission(a, { role: 'member', caps: -1 }), /caps/)
  await t.exception.all(() => attachAdmission(a, { role: 'member', caps: 1.5 }), /caps/)
})
