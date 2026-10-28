const test = require('brittle')
const { EventEmitter } = require('node:events')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const {
  topicFor,
  parseBootstrap,
  generateNoiseKeyPair,
  createSwarm,
  refuseOverConnectionLimit,
  joinAndFlush,
  startRediscovery,
  attachAdmission,
  validateMessage,
  watchFork,
  startQuarantineFetch,
  quarantineGet0,
  MAX_INVENTORY,
  MAX_BAD_MESSAGES,
  MAX_CONNECTIONS,
  MAX_FETCH_ATTACHMENTS,
  MAX_SEND_BACKLOG
} = require('../lib/net')
const { MAX_LOG_BLOCKS } = require('../lib/records')

const DUMMY_SEEDER_CERT = { v: 1, seeder: 'cd'.repeat(32), date: '2026-01-01T00:00:00.000Z', association: 'ab'.repeat(32), signature: 'ef'.repeat(64) }
const TOPIC = topicFor('ab'.repeat(32))

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// Creates a store and a loopback-only swarm; registers swarm.destroy before
// store.close so the swarm goes first. onconnection runs after the store has
// replicated the socket.
async function node (t, bootstrap, onconnection = () => {}) {
  const store = new Corestore(tmpDir(t, 'varanda-net-'))
  await store.ready()
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  swarm.on('connection', (socket, info) => {
    socket.on('error', () => {})
    store.replicate(socket)
    onconnection(socket, info)
  })
  return { store, swarm }
}

// Tests join A then B sequentially: two concurrent first announces both
// look up before either is stored, find nobody and only refresh after ~10 min
// (startRediscovery exists for exactly that case; see its test).

// A raw admission channel on the shared muxer, to send arbitrary payloads.
function rawChannel (socket) {
  const mux = Hypercore.getProtocolMuxer(socket)
  const received = []
  let resolveOpen
  const opened = new Promise((resolve) => { resolveOpen = resolve })
  const channel = mux.createChannel({ protocol: 'varanda/admission/1', onopen: () => resolveOpen() })
  const message = channel.addMessage({ encoding: c.buffer, onmessage: (buf) => received.push(JSON.parse(b4a.toString(buf, 'utf8'))) })
  channel.open()
  return {
    opened,
    received,
    sendBuf: (buf) => message.send(buf),
    sendJson: (obj) => message.send(b4a.from(JSON.stringify(obj), 'utf8')),
    close: () => channel.close()
  }
}

test('admission channel and replication share one socket', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)

  const blocks = [{ n: 0 }, { n: 1 }, { n: 2 }]
  let coreA = null
  let hexA = null
  const gotA = []
  const gotB = []
  let peerA = null
  let peerB = null
  let socketA = null

  const a = await node(t, bootstrap, (socket) => {
    socketA = socket
    peerA = attachAdmission(socket, { role: 'member', have: [{ key: hexA, length: 3 }], onmessage: (msg) => gotA.push(msg) })
  })
  coreA = a.store.get({ name: 'log', valueEncoding: 'json' })
  await coreA.ready()
  await coreA.append(blocks)
  hexA = hex(coreA.key)

  const b = await node(t, bootstrap, (socket) => {
    peerB = attachAdmission(socket, { role: 'seeder', cert: DUMMY_SEEDER_CERT, have: [], onmessage: (msg) => gotB.push(msg) })
  })
  const coreB = b.store.get({ key: coreA.key, valueEncoding: 'json' })
  await coreB.ready()

  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC, TOPIC])
  await until(() => peerA && peerB, { name: 'peers' })

  const helloAtB = await peerB.hello
  t.is(helloAtB.role, 'member')
  t.is(helloAtB.count, 1)
  t.alike(helloAtB.have, [{ key: hexA, length: 3 }])
  t.is(peerB.remoteRole, 'member')
  t.is(peerB.remoteCert, null)
  t.is(peerB.remoteHave.get(hexA), 3)

  const helloAtA = await peerA.hello
  t.is(helloAtA.role, 'seeder')
  t.alike(peerA.remoteCert, DUMMY_SEEDER_CERT)
  t.is(peerA.socket, socketA)
  t.is(peerA.peerKey, hex(b.swarm.keyPair.publicKey))

  t.ok(peerA.send({ type: 'have', key: hexA, length: 3 }))
  await until(() => gotB.some((m) => m.type === 'have'), { name: 'have at B' })
  t.alike(gotB.find((m) => m.type === 'have'), { type: 'have', key: hexA, length: 3 })

  t.ok(peerB.send({ type: 'announce', key: hexA, cert: { dummy: true } }))
  await until(() => gotA.some((m) => m.type === 'announce'), { name: 'announce at A' })
  t.alike(gotA.find((m) => m.type === 'announce').cert, { dummy: true })

  t.is(peerA.send({ type: 'nope', key: hexA }), false, 'invalid send refused')
  t.is(attachAdmission(socketA, { role: 'member' }), peerA, 'same Peer on second attach')

  await coreB.download({ start: 0, end: 3 }).done()
  t.is(coreB.contiguousLength, 3)
  t.alike(await coreB.get(2, { wait: false }), blocks[2])
})

test('bad payloads, hello cert rules and latest-wins advertisements', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const k1 = '11'.repeat(32)
  const k2 = '22'.repeat(32)

  let peer = null
  const dispatched = []
  const logged = []
  let inventoryEvents = 0
  let raw = null
  // Only the first connection is observed: after the drop at the end the
  // swarms reconnect on their own.
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, { role: 'member', onmessage: (msg) => dispatched.push(msg), oninventory: () => inventoryEvents++, log: (e) => logged.push(e) })
  })
  const b = await node(t, bootstrap, (socket) => { if (!raw) raw = rawChannel(socket) })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer && raw, { name: 'peers' })
  await raw.opened
  await peer.opened

  raw.sendBuf(b4a.alloc(20000, 0x20))
  raw.sendJson({ type: 'mystery', key: k1 })
  raw.sendBuf(b4a.from('{not json', 'utf8'))
  raw.sendJson({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [] })
  raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 0, have: [], cert: DUMMY_SEEDER_CERT })
  await until(() => peer.badMessages === 5, { name: 'bad messages' })
  t.is(dispatched.length, 0, 'nothing dispatched')
  t.is(peer.remoteRole, null)

  raw.sendJson({ type: 'hello', v: 1, role: 'seeder', count: 2, have: [{ key: k1, length: 5 }], cert: DUMMY_SEEDER_CERT })
  const hello = await peer.hello
  t.is(hello.role, 'seeder')
  t.alike(peer.remoteCert, DUMMY_SEEDER_CERT)
  t.is(peer.remoteCount, 2)
  t.is(peer.inventoryComplete, false)

  raw.sendJson({ type: 'have', key: k2, length: 9 })
  await until(() => peer.inventoryComplete, { name: 'inventory complete' })
  t.is(inventoryEvents, 1)
  raw.sendJson({ type: 'have', key: k2, length: 4 })
  await until(() => peer.remoteHave.get(k2) === 4, { name: 'latest wins' })
  t.is(peer.remoteHave.get(k2), 4, 'a smaller have replaces a larger one')

  let seenRejected = null
  const before = dispatched.length
  raw.sendJson({ type: 'rejected', key: k1, reason: 'fork' })
  await until(() => dispatched.length > before, { name: 'rejected' })
  seenRejected = dispatched[dispatched.length - 1]
  t.is(seenRejected.type, 'rejected')
  t.absent(peer.remoteHave.has(k1), 'rejected deletes the key')
  t.is(peer.badMessages, 5)

  // A reason outside the token charset is a bad message, never emitted (S4).
  raw.sendJson({ type: 'rejected', key: k2, reason: 'x\nadmitted ' + k2 + ' 9' })
  raw.sendJson({ type: 'rejected', key: k2, reason: 'fork\u001b[31m' })
  await until(() => peer.badMessages === 7, { name: 'bad reasons counted' })
  t.is(dispatched.filter((m) => m.type === 'rejected').length, 1, 'bad reasons not dispatched')
  t.is(peer.remoteHave.get(k2), 4, 'bad reasons did not delete the key')

  // Our hello reached the raw side.
  await until(() => raw.received.length >= 1, { name: 'hello at raw' })
  t.alike(raw.received[0], { type: 'hello', v: 1, role: 'member', count: 0, have: [] })

  // A second hello on the same connection is a protocol violation (S6): the
  // peer is dropped with reason 'duplicate-hello' and the channel closes.
  let closes = 0
  peer.socket.once('close', () => closes++)
  raw.sendJson({ type: 'hello', v: 1, role: 'seeder', count: 1, have: [{ key: k1, length: 1 }], cert: DUMMY_SEEDER_CERT })
  await until(() => closes === 1, { name: 'dropped on the second hello' })
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [{ event: 'peer-dropped', peerKey: peer.peerKey, reason: 'duplicate-hello' }])
  t.is(peer.remoteCount, 2, 'the second hello was not applied')
  t.is(inventoryEvents, 1, 'oninventory never fired again')
  t.is(peer.send({ type: 'have', key: k1, length: 0 }), false, 'send refused after the drop')
})

test('a hello is dispatched to onmessage before oninventory fires for it', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)

  // Mirrors runSync: onmessage updates per-peer state from the hello, and
  // oninventory must observe that state already updated. One connection per
  // hello (a second hello on a connection is a violation, S6).
  async function pair (order) {
    let peer = null
    let verifiedSeeder = false
    const a = await node(t, bootstrap, (socket) => {
      peer = attachAdmission(socket, {
        role: 'member',
        onmessage: (msg, p) => {
          if (msg.type !== 'hello') return
          verifiedSeeder = msg.role === 'seeder' && p.remoteCert !== null
          order.push('hello:' + msg.role + ':' + (p.inventoryComplete ? 'complete' : 'incomplete'))
        },
        oninventory: (p) => order.push('inventory:' + p.remoteRole + ':' + (verifiedSeeder ? 'verified' : 'unverified'))
      })
    })
    let raw = null
    const b = await node(t, bootstrap, (socket) => { raw = rawChannel(socket) })
    await joinAndFlush(a.swarm, [TOPIC])
    await joinAndFlush(b.swarm, [TOPIC])
    await until(() => peer && raw, { name: 'peers' })
    await raw.opened
    await peer.opened
    return { a, b, raw, peer: () => peer }
  }

  // A member hello with an empty inventory completes at once.
  const order1 = []
  const p1 = await pair(order1)
  p1.raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 0, have: [] })
  await until(() => order1.length === 2, { name: 'first hello and inventory' })
  t.alike(order1, ['hello:member:incomplete', 'inventory:member:unverified'])
  await p1.a.swarm.destroy()
  await p1.b.swarm.destroy()

  // A hello that makes the peer a (verified) seeder with an empty
  // inventory: onmessage sees it before oninventory fires.
  const order2 = []
  const p2 = await pair(order2)
  p2.raw.sendJson({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [], cert: DUMMY_SEEDER_CERT })
  await until(() => order2.length === 2, { name: 'seeder hello and inventory' })
  t.alike(order2, ['hello:seeder:incomplete', 'inventory:seeder:verified'])
  t.is(p2.peer().inventoryComplete, true)
})

// One node pair per limit: the drop destroys the socket and the swarms would
// reconnect, so each case observes its first connection only and destroys
// both swarms at the end.
test('limits: inventory cap, bad messages, hello timeout, admitted from a member', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)

  async function pair (opts = {}) {
    let peer = null
    let raw = null
    let rawSocket = null
    const logged = []
    const dispatched = []
    let closes = 0
    let sizeAtClose = -1
    const a = await node(t, bootstrap, (socket) => {
      if (peer) return
      // remoteHave is released after onclose (G1): sample it there.
      const onclose = (p) => { closes++; sizeAtClose = p.remoteHave.size }
      peer = attachAdmission(socket, { role: 'member', onmessage: (msg) => dispatched.push(msg), log: (e) => logged.push(e), onclose, ...opts })
    })
    const b = await node(t, bootstrap, (socket) => {
      if (raw) return
      rawSocket = socket
      raw = rawChannel(socket)
    })
    await joinAndFlush(a.swarm, [TOPIC])
    await joinAndFlush(b.swarm, [TOPIC])
    await until(() => peer && raw, { name: 'peers' })
    await raw.opened
    await peer.opened
    return {
      peer,
      raw,
      logged,
      dispatched,
      closes: () => closes,
      sizeAtClose: () => sizeAtClose,
      remoteClosed: () => rawSocket.destroyed,
      dropped: () => logged.filter((e) => e.event === 'peer-dropped'),
      end: async () => { await a.swarm.destroy(); await b.swarm.destroy() }
    }
  }

  // 1. MAX_INVENTORY + 1 distinct keys: dropped, the map never exceeds the cap.
  const inv = await pair()
  inv.raw.sendJson({ type: 'hello', v: 1, role: 'member', count: MAX_INVENTORY, have: [] })
  await until(() => inv.peer.remoteRole === 'member', { name: 'hello' })
  for (let i = 0; i < MAX_INVENTORY + 1; i++) {
    inv.raw.sendJson({ type: 'have', key: (0x10000 + i).toString(16).padStart(64, '0'), length: i % 7 })
  }
  await until(() => inv.closes() === 1, { name: 'dropped on inventory overflow', timeoutMs: 30000 })
  t.alike(inv.dropped(), [{ event: 'peer-dropped', peerKey: inv.peer.peerKey, reason: 'inventory-limit' }])
  t.is(inv.sizeAtClose(), MAX_INVENTORY, 'map capped at MAX_INVENTORY')
  t.ok(inv.peer.inventoryComplete, 'inventory of MAX_INVENTORY keys completed before the overflow')
  await until(() => inv.remoteClosed(), { name: 'remote socket closed' })
  await inv.end()

  // 2. MAX_BAD_MESSAGES + 1 bad messages: dropped.
  const bad = await pair()
  for (let i = 0; i < MAX_BAD_MESSAGES; i++) bad.raw.sendBuf(b4a.from('{nope', 'utf8'))
  await until(() => bad.peer.badMessages === MAX_BAD_MESSAGES, { name: '16 bad messages' })
  t.is(bad.closes(), 0, 'still connected after MAX_BAD_MESSAGES')
  bad.raw.sendBuf(b4a.from('{nope', 'utf8'))
  await until(() => bad.closes() === 1, { name: 'dropped on the 17th' })
  t.is(bad.peer.badMessages, MAX_BAD_MESSAGES + 1)
  t.alike(bad.dropped(), [{ event: 'peer-dropped', peerKey: bad.peer.peerKey, reason: 'bad-messages' }])
  t.is(bad.dispatched.length, 0)
  await bad.end()

  // 3. A silent channel (opened, no hello) is dropped after the hello timeout.
  const silent = await pair({ helloTimeoutMs: 300 })
  const started = Date.now()
  await until(() => silent.closes() === 1, { name: 'dropped on hello timeout', timeoutMs: 10000 })
  t.ok(Date.now() - started < 5000, 'dropped shortly after the timeout')
  t.alike(silent.dropped(), [{ event: 'peer-dropped', peerKey: silent.peer.peerKey, reason: 'hello-timeout' }])
  t.is(await silent.peer.hello, null)
  await silent.end()

  // 4. A valid hello within the timeout keeps the connection; an admitted
  // from a member role is a bad message that never touches remoteHave (S2).
  const member = await pair({ helloTimeoutMs: 1000 })
  member.raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 0, have: [] })
  await until(() => member.peer.remoteRole === 'member', { name: 'member hello' })
  member.raw.sendJson({ type: 'admitted', key: 'aa'.repeat(32), length: 3 })
  await until(() => member.peer.badMessages === 1, { name: 'admitted from a member counted' })
  t.absent(member.peer.remoteHave.has('aa'.repeat(32)))
  t.is(member.dispatched.filter((m) => m.type === 'admitted').length, 0)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  t.is(member.closes(), 0, 'not dropped: the hello arrived in time')
  t.alike(member.dropped(), [])
  await member.end()
})

test('item 2: a have is dispatched to onmessage before oninventory; item 4c: an oversized inventory is never sent', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const k1 = '11'.repeat(32)
  const order = []
  let peer = null
  let raw = null
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, {
      role: 'member',
      onmessage: (msg) => order.push('message:' + msg.type + ':' + (msg.length === undefined ? '' : msg.length)),
      oninventory: (p) => order.push('inventory:' + p.remoteHave.get(k1))
    })
  })
  const b = await node(t, bootstrap, (socket) => { if (!raw) raw = rawChannel(socket) })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer && raw, { name: 'peers' })
  await raw.opened
  await peer.opened
  raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 1, have: [] })
  raw.sendJson({ type: 'have', key: k1, length: 5 })
  await until(() => order.length === 3, { name: 'dispatched' })
  t.alike(order, ['message:hello:', 'message:have:5', 'inventory:5'], 'the completing have reaches onmessage before oninventory')
  // A fresh socket (the first attach above already owns this one) refuses
  // an inventory over MAX_INVENTORY.
  const fake = { noiseStream: null }
  t.exception.all(() => attachAdmission(fake, { role: 'member', have: Array.from({ length: MAX_INVENTORY + 1 }, (_, i) => ({ key: i.toString(16).padStart(64, '0'), length: 0 })) }), /MAX_INVENTORY/)
})

test('refuseOverConnectionLimit destroys a socket over the cap (fake swarm)', async (t) => {
  await testnet(t)
  const logged = []
  const socketOf = (n) => ({ remotePublicKey: b4a.alloc(32, n), destroyed: false, destroy () { this.destroyed = true } })
  const swarm = { connections: new Set() }
  for (let i = 0; i < MAX_CONNECTIONS; i++) swarm.connections.add(socketOf(i))
  const extra = socketOf(99)
  swarm.connections.add(extra)
  t.is(refuseOverConnectionLimit(swarm, extra, { log: (e) => logged.push(e) }), true, 'refused over the cap')
  t.ok(extra.destroyed)
  t.alike(logged, [{ event: 'peer-dropped', peerKey: '63'.repeat(32), reason: 'connection-limit' }])

  // Exactly at the cap, counting the socket itself: accepted.
  swarm.connections.delete(extra)
  const last = [...swarm.connections][0]
  t.is(refuseOverConnectionLimit(swarm, last, { log: (e) => logged.push(e) }), false, 'the socket is not counted against itself')
  t.absent(last.destroyed)
  // An injectable limit (used by the seeder and runSync options).
  const small = { connections: new Set([socketOf(1), socketOf(2)]) }
  const third = socketOf(3)
  small.connections.add(third)
  t.is(refuseOverConnectionLimit(small, third, { limit: 2 }), true)
  t.is(refuseOverConnectionLimit({ connections: new Set([third]) }, third, { limit: 1 }), false)
  t.is(logged.length, 1, 'the default log is silent')
})

test('a channel closed before open or before hello settles opened false / hello null', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)

  // 1. The remote replicates but never opens the admission channel.
  let peer1 = null
  let closes1 = 0
  const a1 = await node(t, bootstrap, (socket) => {
    peer1 = attachAdmission(socket, { role: 'member', onclose: () => closes1++ })
  })
  let socketB1 = null
  const b1 = await node(t, bootstrap, (socket) => { socketB1 = socket })
  await joinAndFlush(a1.swarm, [TOPIC])
  await joinAndFlush(b1.swarm, [TOPIC])
  await until(() => peer1 && socketB1, { name: 'connected (no channel)' })
  socketB1.destroy()
  t.is(await peer1.opened, false, 'opened resolves false when the channel never opened')
  t.is(await peer1.hello, null, 'hello resolves null when no hello arrived')
  await until(() => closes1 === 1, { name: 'onclose' })
  t.is(peer1.send({ type: 'have', key: 'aa'.repeat(32), length: 0 }), false, 'send refused after close')
  await a1.swarm.destroy()
  await b1.swarm.destroy()

  // 2. The channel opens but the remote leaves before sending a valid hello.
  let peer2 = null
  const a2 = await node(t, bootstrap, (socket) => {
    peer2 = attachAdmission(socket, { role: 'member' })
  })
  let raw = null
  let socketB2 = null
  const b2 = await node(t, bootstrap, (socket) => {
    socketB2 = socket
    raw = rawChannel(socket)
  })
  await joinAndFlush(a2.swarm, [TOPIC])
  await joinAndFlush(b2.swarm, [TOPIC])
  await until(() => peer2 && raw, { name: 'connected (raw channel)' })
  t.is(await peer2.opened, true, 'opened resolves true on open')
  raw.sendJson({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [] }) // invalid: no cert
  await until(() => peer2.badMessages === 1, { name: 'bad hello counted' })
  socketB2.destroy()
  t.is(await peer2.hello, null, 'hello resolves null when only an invalid hello arrived')
  t.is(peer2.remoteRole, null)
  await a2.swarm.destroy()
  await b2.swarm.destroy()
})

test('bounded inventory: 250 keys = hello(100) + 150 have', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const inventory = []
  for (let i = 0; i < 250; i++) {
    inventory.push({ key: i.toString(16).padStart(64, '0'), length: i })
  }

  let peerB = null
  const gotB = []
  const a = await node(t, bootstrap, (socket) => {
    attachAdmission(socket, { role: 'member', have: inventory })
  })
  const b = await node(t, bootstrap, (socket) => {
    peerB = attachAdmission(socket, { role: 'seeder', cert: DUMMY_SEEDER_CERT, onmessage: (msg) => gotB.push(msg) })
  })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peerB, { name: 'peer' })

  const hello = await peerB.hello
  t.is(hello.have.length, 100)
  t.is(hello.count, 250)
  await until(() => peerB.inventoryComplete, { name: 'inventory complete' })
  t.is(peerB.remoteHave.size, 250)
  const haves = gotB.filter((m) => m.type === 'have')
  t.is(haves.length, 150)
  t.alike(haves.map((m) => m.key), inventory.slice(100).map((e) => e.key), 'overflow in order')
  t.is(peerB.remoteHave.get(inventory[249].key), 249)
})

test('quarantine fetch is isolated to the offering socket', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)

  const a = await node(t, bootstrap)
  const coreA = a.store.get({ name: 'log', valueEncoding: 'json' })
  await coreA.ready()
  await coreA.append([{ n: 0 }, { n: 1 }, { n: 2 }])
  const hexA = hex(coreA.key)
  const raw0 = await coreA.get(0, { raw: true, wait: false })

  const socketsB = new Map()
  const b = await node(t, bootstrap, (socket) => socketsB.set(hex(socket.remotePublicKey), socket))
  const qstoreB = new Corestore(tmpDir(t, 'varanda-quarantine-'))
  await qstoreB.ready()
  t.teardown(() => qstoreB.close(), { force: true })

  const nodeC = await node(t, bootstrap)
  const coreC = nodeC.store.get({ key: coreA.key })
  await coreC.ready()

  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  nodeC.swarm.joinPeer(b.swarm.keyPair.publicKey)
  const pkA = hex(a.swarm.keyPair.publicKey)
  const pkC = hex(nodeC.swarm.keyPair.publicKey)
  await until(() => socketsB.has(pkA) && socketsB.has(pkC), { name: 'B connected to A and C' })
  t.absent(nodeC.swarm.connections.size > 1, 'C is connected to B only')

  const during = coreC.get(0, { timeout: 1500 }).then(() => null, (err) => err)
  const r = await quarantineGet0(qstoreB, hexA, [socketsB.get(pkA)], 5000)
  t.is(r.error, null)
  t.ok(b4a.equals(r.raw, raw0), 'quarantine got block 0')
  // The upgrade proof that came with block 0 tells the signed length (S3).
  t.is(r.length, 3, 'signed length learned with block 0')
  t.is(r.byteLength, coreA.byteLength, 'signed byteLength learned with block 0')
  const errDuring = await during
  t.is(errDuring && errDuring.code, 'REQUEST_TIMEOUT', 'C could not read during the fetch')

  const errAfter = await coreC.get(0, { timeout: 1500 }).then(() => null, (err) => err)
  t.is(errAfter && errAfter.code, 'REQUEST_TIMEOUT', 'C could not read after the fetch')
  t.is(await b.store.storage.hasCore(Hypercore.discoveryKey(coreA.key)), false, 'main store of B never held the core')

  const missing = 'fe'.repeat(32)
  const started = Date.now()
  const r2 = await quarantineGet0(qstoreB, missing, [socketsB.get(pkA)], 1000)
  t.alike(r2, { raw: null, error: 'timeout', length: 0, byteLength: 0 })
  t.ok(Date.now() - started <= 1500, 'timeout honored')
})

test('watchFork fires once on a rewritten history', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)

  const a = await node(t, bootstrap)
  const coreA = a.store.get({ name: 'log', valueEncoding: 'json' })
  await coreA.ready()
  await coreA.append([{ n: 0 }, { n: 1 }, { n: 2 }])

  const b = await node(t, bootstrap)
  const coreB = b.store.get({ key: coreA.key, valueEncoding: 'json' })
  await coreB.ready()
  let fired = 0
  let reason = null
  const stop = watchFork(coreB, (r) => { fired++; reason = r })
  t.teardown(stop, { force: true })
  const range = coreB.download({ start: 0, end: -1 })
  t.teardown(() => range.destroy(), { force: true })

  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => coreB.contiguousLength === 3, { name: 'replicated' })

  await coreA.truncate(1, { fork: 1 })
  await coreA.append([{ n: 'x' }, { n: 'y' }])
  await until(() => coreB.fork === 1 && fired >= 1, { name: 'fork seen' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(fired, 1)
  t.is(reason, 'fork')
  t.is(coreB.fork, 1)
})

test('startRediscovery connects two swarms that joined at the same moment', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const topic = topicFor('ee'.repeat(32))

  const a = await node(t, bootstrap)
  const b = await node(t, bootstrap)
  await Promise.all([joinAndFlush(a.swarm, [topic]), joinAndFlush(b.swarm, [topic])])

  const stops = [a, b].map(({ swarm }) => startRediscovery(swarm, [topic], {
    intervalMs: 250,
    hasPeer: () => swarm.connections.size > 0
  }))
  for (const stop of stops) t.teardown(stop, { force: true })

  const started = Date.now()
  await until(() => a.swarm.connections.size > 0 && b.swarm.connections.size > 0, { timeoutMs: 5000, name: 'rediscovered' })
  t.ok(Date.now() - started <= 5000, 'connected within 5 s')
  t.exception.all(() => startRediscovery(a.swarm, [b4a.alloc(3)]), TypeError)
})

test('pure helpers: topics, bootstrap, swarm binding, key pairs, validation', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)

  const assoc = 'AB'.repeat(32)
  t.is(topicFor(assoc).byteLength, 32)
  t.alike(topicFor(assoc), topicFor(assoc.toLowerCase()), 'deterministic, case-insensitive')
  t.unlike(topicFor(assoc), topicFor('cd'.repeat(32)))
  t.exception.all(() => topicFor('ab'), TypeError)
  t.exception.all(() => topicFor(42), TypeError)

  t.is(parseBootstrap(undefined), undefined)
  t.is(parseBootstrap(null), undefined)
  t.is(parseBootstrap(''), undefined)
  t.is(parseBootstrap([]), undefined)
  t.alike(parseBootstrap('a.example:1, 0.0.0.0:2'), ['a.example:1', '127.0.0.1:2'])
  t.alike(parseBootstrap(['h:10', ':::20']), ['h:10', '127.0.0.1:20'])
  t.alike(parseBootstrap([{ host: '0.0.0.0', port: 49737 }, { host: '10.0.0.1', port: 5 }]), ['127.0.0.1:49737', '10.0.0.1:5'])
  t.exception.all(() => parseBootstrap('nohost'), TypeError)
  t.exception.all(() => parseBootstrap(':80'), TypeError)
  t.exception.all(() => parseBootstrap('h:0'), TypeError)
  t.exception.all(() => parseBootstrap('h:65536'), TypeError)
  t.exception.all(() => parseBootstrap([{ host: '', port: 1 }]), TypeError)
  t.exception.all(() => parseBootstrap([{ host: 'h', port: 1.5 }]), TypeError)

  const kp = generateNoiseKeyPair()
  t.ok(b4a.isBuffer(kp.publicKey) && kp.publicKey.byteLength === 32)
  t.ok(b4a.isBuffer(kp.secretKey) && kp.secretKey.byteLength === 64)

  const swarm = createSwarm({ bootstrap, host: '127.0.0.1' })
  t.teardown(() => swarm.destroy(), { force: true })
  await swarm.dht.ready()
  t.is(swarm.dht.io.serverSocket.address().host, '127.0.0.1')
  t.alike(swarm.dht.io.portRange, [0, 0])
  t.is(swarm.dht.firewalled, false, 'loopback host: firewall detection off')
  // A private bootstrap on a non-loopback host says nothing about
  // reachability: hyperdht's own detection stays on (never bound: destroyed
  // before ready, so nothing listens outside loopback).
  const other = createSwarm({ bootstrap })
  t.is(other.dht.firewalled, true, 'no host: firewalled is not forced')
  t.alike(other.dht.io.portRange, [0, 0])
  const v6 = createSwarm({ bootstrap, host: '::1' })
  t.is(v6.dht.firewalled, false, '::1 is loopback too')
  await Promise.all([other.destroy(), v6.destroy()])

  const k = 'aa'.repeat(32)
  const have101 = []
  for (let i = 0; i < 101; i++) have101.push({ key: k, length: 0 })
  t.ok(validateMessage({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: k, length: 0 }] }))
  t.ok(validateMessage({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [], cert: {} }))
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [] }), 'seeder without cert')
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', count: 0, have: [], cert: {} }), 'member with cert')
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'seeder', count: 0, have: [], cert: [] }), 'cert not plain object')
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', count: 101, have: have101 }), '101 entries')
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', count: 0, have: [{ key: k, length: 0 }] }), 'count < have.length')
  t.absent(validateMessage({ type: 'hello', v: 2, role: 'member', count: 0, have: [] }))
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'admin', count: 0, have: [] }))
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: k, length: 0, x: 1 }] }))
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', have: [] }), 'missing count')
  t.ok(validateMessage({ type: 'have', key: k, length: 0 }))
  t.ok(validateMessage({ type: 'admitted', key: k, length: 7 }))
  t.absent(validateMessage({ type: 'have', key: k.toUpperCase(), length: 0 }), 'uppercase hex')
  t.absent(validateMessage({ type: 'have', key: k, length: -1 }))
  t.absent(validateMessage({ type: 'have', key: k, length: 1.5 }))
  t.absent(validateMessage({ type: 'have', key: k, length: 1, extra: true }))
  t.ok(validateMessage({ type: 'announce', key: k, cert: {} }))
  t.absent(validateMessage({ type: 'announce', key: k, cert: null }))
  t.ok(validateMessage({ type: 'rejected', key: k, reason: 'fork' }))
  t.ok(validateMessage({ type: 'rejected', key: k, reason: 'x'.repeat(64) }))
  t.absent(validateMessage({ type: 'rejected', key: k, reason: 'x'.repeat(65) }))
  t.absent(validateMessage({ type: 'rejected', key: k, reason: 3 }))
  // Reason charset (S4): lowercase token only.
  t.absent(validateMessage({ type: 'rejected', key: k, reason: '' }))
  t.absent(validateMessage({ type: 'rejected', key: k, reason: 'x\nadmitted' }))
  t.absent(validateMessage({ type: 'rejected', key: k, reason: 'fork\u001b' }))
  t.absent(validateMessage({ type: 'rejected', key: k, reason: 'Fork' }))
  t.absent(validateMessage({ type: 'rejected', key: k, reason: 'not in log' }))
  t.ok(validateMessage({ type: 'rejected', key: k, reason: 'admission-failed' }))
  // Length and inventory caps (S1).
  t.ok(validateMessage({ type: 'have', key: k, length: MAX_LOG_BLOCKS }))
  t.absent(validateMessage({ type: 'have', key: k, length: MAX_LOG_BLOCKS + 1 }), 'length over MAX_LOG_BLOCKS')
  t.absent(validateMessage({ type: 'admitted', key: k, length: 9007199254740991 }))
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: k, length: MAX_LOG_BLOCKS + 1 }] }))
  t.ok(validateMessage({ type: 'hello', v: 1, role: 'member', count: 4096, have: [] }))
  t.absent(validateMessage({ type: 'hello', v: 1, role: 'member', count: 4097, have: [] }), 'count over MAX_INVENTORY')
  t.absent(validateMessage({ type: 'unknown' }))
  t.absent(validateMessage(null))
  t.absent(validateMessage([]))
  t.absent(validateMessage('hello'))
})

test('H1 (cycle 3): a flood of one valid have is dropped with message-rate', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const k = '77'.repeat(32)
  let peer = null
  let raw = null
  const logged = []
  const dispatched = []
  let closes = 0
  let sizeAtClose = -1 // remoteHave is released after onclose (G1)
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, {
      role: 'member',
      messageBurst: 50,
      messageRate: 10,
      onmessage: (msg) => dispatched.push(msg),
      log: (e) => logged.push(e),
      onclose: (p) => { closes++; sizeAtClose = p.remoteHave.size }
    })
  })
  const b = await node(t, bootstrap, (socket) => {
    if (raw) return
    raw = rawChannel(socket)
  })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer && raw, { name: 'peers' })
  await raw.opened
  raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 1, have: [{ key: k, length: 1 }] })
  for (let i = 0; i < 10000; i++) raw.sendJson({ type: 'have', key: k, length: 1 })
  await until(() => closes === 1, { name: 'dropped on message rate', timeoutMs: 30000 })
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [{ event: 'peer-dropped', peerKey: peer.peerKey, reason: 'message-rate' }])
  t.ok(dispatched.length <= 50, 'at most the burst was dispatched (' + dispatched.length + ')')
  t.is(peer.badMessages, 0, 'valid messages never count as bad')
  t.is(sizeAtClose, 1)
})

test('H1 (cycle 3): an honest seeder with a large inventory and per-block growth is not dropped', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  // A bucket sized like the default ratio: burst = inventory + 64.
  const INVENTORY = 300
  const limits = { messageBurst: INVENTORY + 64, messageRate: 100 }
  const inventory = []
  for (let i = 0; i < INVENTORY; i++) inventory.push({ key: (0x20000 + i).toString(16).padStart(64, '0'), length: 1 })
  const grow = inventory[0].key
  let seeder = null
  let member = null
  const logged = []
  const received = []
  let closes = 0
  const a = await node(t, bootstrap, (socket) => {
    if (seeder) return
    seeder = attachAdmission(socket, { role: 'seeder', cert: DUMMY_SEEDER_CERT, have: inventory, log: (e) => logged.push(e), ...limits })
  })
  const b = await node(t, bootstrap, (socket) => {
    if (member) return
    member = attachAdmission(socket, {
      role: 'member',
      onmessage: (msg) => received.push(msg),
      log: (e) => logged.push(e),
      onclose: () => closes++,
      ...limits
    })
  })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => seeder && member, { name: 'peers' })
  await until(() => member.inventoryComplete, { name: 'inventory complete' })
  t.is(member.remoteHave.size, INVENTORY)
  // Growth advertised block by block, as watchContiguous does during a bulk
  // download: coalesced by the sender, never over the receiver's bucket.
  for (let length = 2; length <= 2000; length++) seeder.send({ type: 'have', key: grow, length })
  await until(() => member.remoteHave.get(grow) === 2000, { name: 'latest growth arrives', timeoutMs: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(closes, 0, 'not dropped')
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [])
  const growth = received.filter((m) => m.type === 'have' && m.key === grow)
  t.ok(growth.length < 1999, 'growth coalesced (' + growth.length + ' have messages)')
  t.is(growth[growth.length - 1].length, 2000, 'the latest length wins')
})

test('retry item 1: closing only the admission channel destroys the socket and frees its slot', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  let peer = null
  let serverSocket = null
  let closes = 0
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    serverSocket = socket
    peer = attachAdmission(socket, { role: 'member', onclose: () => closes++ })
  })
  let raw = null
  const b = await node(t, bootstrap, (socket) => {
    if (raw) return
    raw = rawChannel(socket)
  })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer && raw, { name: 'peers' })
  await raw.opened
  t.ok(a.swarm.connections.has(serverSocket), 'the connection holds a slot')
  raw.close() // the transport (replication) would otherwise stay up
  await until(() => closes === 1, { name: 'onclose' })
  await until(() => serverSocket.destroyed, { name: 'socket destroyed' })
  await until(() => !a.swarm.connections.has(serverSocket), { name: 'slot released' })
  t.is(await peer.hello, null)
})

test('retry item 3: sends before the channel opens are merged per key and bounded', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const k = '88'.repeat(32)
  let peer = null
  let queuedAfterHaves = null
  let queuedAfterKeys = null
  const logged = []
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, { role: 'member', helloTimeoutMs: 60000, log: (e) => logged.push(e) })
    for (let i = 0; i < 10000; i++) peer.send({ type: 'have', key: k, length: 1 + (i % 5) })
    queuedAfterHaves = peer.queued()
    for (let i = 0; i < MAX_SEND_BACKLOG; i++) peer.send({ type: 'have', key: (0x30000 + i).toString(16).padStart(64, '0'), length: 1 })
    queuedAfterKeys = peer.queued()
  })
  // The remote replicates but never opens the admission channel.
  const b = await node(t, bootstrap, () => {})
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer, { name: 'peer' })
  t.is(queuedAfterHaves, 1, '10 000 have sends for one key leave one queued entry')
  t.ok(queuedAfterKeys <= MAX_SEND_BACKLOG, 'the queue never exceeds MAX_SEND_BACKLOG')
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [{ event: 'peer-dropped', peerKey: peer.peerKey, reason: 'send-backlog' }])
})

test('item 3: queued have/rejected merge per key in order; admitted is never merged away', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const k = '99'.repeat(32)
  const m = 'aa'.repeat(32)
  let peer = null
  let raw = null
  let maxQueued = 0
  const logged = []
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, { role: 'member', helloTimeoutMs: 60000, log: (e) => logged.push(e) })
    // (a) 10 000 alternating have/rejected sends for one key, then two haves.
    for (let i = 0; i < 10000; i++) {
      if (i % 2 === 0) peer.send({ type: 'have', key: k, length: 1 + i })
      else peer.send({ type: 'rejected', key: k, reason: 'r-' + i })
      maxQueued = Math.max(maxQueued, peer.queued())
    }
    peer.send({ type: 'have', key: k, length: 20000 })
    peer.send({ type: 'have', key: k, length: 20001 })
    maxQueued = Math.max(maxQueued, peer.queued())
    // (d) an admitted between haves for one key is kept, and a later
    // rejected never moves before it.
    peer.send({ type: 'have', key: m, length: 1 })
    peer.send({ type: 'have', key: m, length: 2 })
    peer.send({ type: 'admitted', key: m, length: 2 })
    peer.send({ type: 'have', key: m, length: 3 })
    peer.send({ type: 'have', key: m, length: 4 })
    peer.send({ type: 'rejected', key: m, reason: 'late' })
    peer.send({ type: 'have', key: m, length: 5 })
  })
  const b = await node(t, bootstrap, (socket) => {
    if (raw) return
    raw = rawChannel(socket)
  })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer && raw, { name: 'peers' })
  await raw.opened
  await until(() => raw.received.length >= 7, { name: 'backlog flushed' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.ok(maxQueued <= 2, 'at most 2 entries queued for one key (' + maxQueued + ')')
  t.is(raw.received[0].type, 'hello')
  t.alike(raw.received.slice(1), [
    { type: 'rejected', key: k, reason: 'r-9999' },
    { type: 'have', key: k, length: 20001 },
    { type: 'have', key: m, length: 2 },
    { type: 'admitted', key: m, length: 2 },
    { type: 'rejected', key: m, reason: 'late' },
    { type: 'have', key: m, length: 5 }
  ])
  t.is(peer.queued(), 0)
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [])
})

test('item 3: a have and a rejected per key for MAX_INVENTORY keys fit the send backlog', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  let peer = null
  let queued = null
  const logged = []
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, { role: 'member', helloTimeoutMs: 60000, log: (e) => logged.push(e) })
    for (let i = 0; i < MAX_INVENTORY; i++) peer.send({ type: 'have', key: (0x40000 + i).toString(16).padStart(64, '0'), length: 1 })
    for (let i = 0; i < MAX_INVENTORY; i++) peer.send({ type: 'rejected', key: (0x50000 + i).toString(16).padStart(64, '0'), reason: 'invalid-log' })
    queued = peer.queued()
  })
  // The remote replicates but never opens the admission channel.
  const b = await node(t, bootstrap, () => {})
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer, { name: 'peer' })
  t.is(MAX_SEND_BACKLOG, 2 * MAX_INVENTORY + 64)
  t.is(queued, 2 * MAX_INVENTORY, 'every distinct key stays queued')
  t.alike(logged.filter((e) => e.event === 'peer-dropped'), [], 'not dropped')
})

test('G1: a pending quarantine fetch drops closed sockets and bounds its open attachments', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const socketsB = new Map()
  const b = await node(t, bootstrap, (socket) => socketsB.set(hex(socket.remotePublicKey), socket))
  const qstoreB = new Corestore(tmpDir(t, 'varanda-quarantine-'))
  await qstoreB.ready()
  t.teardown(() => qstoreB.close(), { force: true })
  await joinAndFlush(b.swarm, [TOPIC])
  const remotes = []
  for (let i = 0; i < 4; i++) {
    const x = await node(t, bootstrap)
    x.swarm.joinPeer(b.swarm.keyPair.publicKey)
    remotes.push(hex(x.swarm.keyPair.publicKey))
  }
  await until(() => remotes.every((pk) => socketsB.has(pk)), { name: 'B connected to 4 remotes' })
  const [s1, s2, s3, s4] = remotes.map((pk) => socketsB.get(pk))
  t.is(MAX_FETCH_ATTACHMENTS, MAX_CONNECTIONS)

  // Nobody holds these keys: both fetches stay pending until the timeout.
  const fetch1 = startQuarantineFetch(qstoreB, 'fe'.repeat(32), [s1, s2], 5000)
  const fetch2 = startQuarantineFetch(qstoreB, 'fd'.repeat(32), [s1], 5000, { maxAttachments: 3 })
  let pending = 2
  fetch1.promise.finally(() => pending--)
  fetch2.promise.finally(() => pending--)
  await until(() => fetch1.attachedCount() === 2 && fetch2.attachedCount() === 1, { name: 'initial sockets attached' })
  t.ok(fetch2.addSocket(s2), '2nd socket attached')
  t.ok(fetch2.addSocket(s3), '3rd socket attached')
  t.absent(fetch2.addSocket(s3), 'a socket already attached is refused')
  t.is(fetch2.attachedCount(), 3)
  t.absent(fetch2.addSocket(s4), 'a 4th socket is refused while 3 are attached')

  s1.destroy()
  await until(() => fetch1.attachedCount() === 1 && fetch2.attachedCount() === 2, { name: 'closed socket released' })
  t.ok(fetch2.addSocket(s4), 'the 4th socket is accepted once one of them closed')
  s2.destroy()
  s3.destroy()
  await until(() => fetch1.attachedCount() === 0 && fetch2.attachedCount() === 1, { name: 'closed sockets released' })
  t.is(pending, 2, 'both fetches are still pending')
  t.absent(fetch2.addSocket(s1), 'a closed socket is not attached again')
  // Capture the one-shot close listener the fetch registers on s4.
  const onceClose = []
  const once = s4.once
  s4.once = function (name, fn) {
    if (name === 'close') onceClose.push(fn)
    return once.call(this, name, fn)
  }
  t.ok(fetch1.addSocket(s4), 'the default cap still admits a new socket')
  s4.once = once
  t.is(fetch1.attachedCount(), 1)
  t.is(onceClose.length, 1, 'one close listener registered')
  t.ok(s4.listeners('close').includes(onceClose[0]), 'registered while attached')

  t.alike(await fetch1.promise, { raw: null, error: 'timeout', length: 0, byteLength: 0 })
  t.alike(await fetch2.promise, { raw: null, error: 'timeout', length: 0, byteLength: 0 })
  t.is(fetch1.attachedCount(), 0, 'settling clears the attachments')
  t.absent(s4.listeners('close').includes(onceClose[0]), 'settling removes the close listener of a live socket')
  t.absent(fetch1.addSocket(s4), 'a settled fetch attaches nothing')
})

test('G1: a closed admission peer releases its advertised keys', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  let peer = null
  let sizeInOnclose = -1
  const a = await node(t, bootstrap, (socket) => {
    if (peer) return
    peer = attachAdmission(socket, { role: 'member', onclose: (p) => { sizeInOnclose = p.remoteHave.size } })
  })
  let raw = null
  const b = await node(t, bootstrap, (socket) => {
    if (raw) return
    raw = rawChannel(socket)
  })
  await joinAndFlush(a.swarm, [TOPIC])
  await joinAndFlush(b.swarm, [TOPIC])
  await until(() => peer && raw, { name: 'peers' })
  await raw.opened
  raw.sendJson({ type: 'hello', v: 1, role: 'member', count: 2, have: [{ key: 'ab'.repeat(32), length: 1 }, { key: 'cd'.repeat(32), length: 2 }] })
  await until(() => peer.remoteHave.size === 2, { name: 'inventory received' })
  raw.close()
  await until(() => sizeInOnclose !== -1, { name: 'onclose' })
  t.is(sizeInOnclose, 2, 'onclose still sees the advertised keys')
  t.is(peer.remoteHave.size, 0, 'the advertised keys are released after close')
})

// A fake quarantine store whose core opens when the test says so and records
// every socket it is asked to replicate.
function fakeQuarantine () {
  let open
  const opened = new Promise((resolve) => { open = resolve })
  let serve
  const served = new Promise((resolve) => { serve = resolve })
  const replicated = []
  const core = {
    length: 0,
    byteLength: 0,
    ready: () => opened,
    replicate: (s) => { replicated.push(s) },
    get: () => served,
    purge: async () => {}
  }
  return { qstore: { get: () => core }, open, serve, replicated }
}

function fakeSocket () {
  const s = new EventEmitter()
  s.destroyed = false
  s.destroy = () => {
    if (s.destroyed) return
    s.destroyed = true
    s.emit('close')
  }
  return s
}

test('G1: a destroyed socket is refused, and one that closes before the core is ready is never replicated', async (t) => {
  const q = fakeQuarantine()
  const first = fakeSocket()
  const early = fakeSocket()
  const stays = fakeSocket()
  const dead = fakeSocket()
  dead.destroy()
  const dying = fakeSocket()
  dying.destroying = true
  const fetch = startQuarantineFetch(q.qstore, 'fe'.repeat(32), [first], 1000)
  t.absent(fetch.addSocket(dead), 'a destroyed socket is refused')
  t.absent(fetch.addSocket(dying), 'a socket being destroyed is refused')
  t.is(fetch.attachedCount(), 0)
  t.ok(fetch.addSocket(early), 'added while the core opens')
  t.ok(fetch.addSocket(stays), 'added while the core opens')
  t.is(q.replicated.length, 0, 'nothing replicated before ready')
  early.destroy()
  t.is(fetch.attachedCount(), 1, 'the socket that closed meanwhile is dropped')
  q.open()
  await until(() => q.replicated.length === 2, { name: 'replicated after ready' })
  t.alike(q.replicated, [stays, first], 'only the sockets still open are replicated')
  t.absent(fetch.addSocket(dead), 'a destroyed socket is still refused after ready')
  t.is(fetch.attachedCount(), 2)
  q.serve(null)
  t.alike(await fetch.promise, { raw: null, error: 'timeout', length: 0, byteLength: 0 })
  t.is(fetch.attachedCount(), 0)
  t.is(stays.listenerCount('close'), 0, 'no close listener left behind')
  t.is(q.replicated.includes(early) || q.replicated.includes(dead) || q.replicated.includes(dying), false)
})
