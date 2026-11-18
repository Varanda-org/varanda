'use strict'

// Connection slots shared by remote address (issue #32), end to end: a real
// Seeder and real member runs (runSync) on the local testnet, where every
// connection comes from 127.0.0.1, as members behind one shared address
// (CGNAT) would. Many unproven connections from that address cannot take
// the slots of members that proved their diaries, and a member that comes
// back with a new record still gets it to the seeder; with a simulated
// second address, a full table of one address still lets the other in.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { makeAssociation, prepareSeederDir, startSeeder } = require('./helpers/seeder-groups')
const { runSync } = require('../lib/sync')
const { openStore, openDiary, appendRecord, writeConfig } = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord } = require('../lib/records')
const { createCert } = require('../lib/cert')
const { createSwarm, attachAdmission } = require('../lib/net')

const hex = (buf) => b4a.toString(buf, 'hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Long enough for a member's new connection to hello and prove before it
// could be rotated, short enough for the flood to rotate many times.
const PROBATION_MS = 1000

const displaced = (events) => events.filter((e) => e.event === 'peer-dropped' && e.reason === 'connection-displaced')
const limited = (events) => events.filter((e) => e.event === 'peer-dropped' && e.reason === 'connection-limit')

// A member data dir: a certified diary with a profile. The store is closed
// on return, so runSync can open it.
async function makeMember (t, assoc) {
  const dir = tmpDir(t, 'varanda-slots-e2e-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: assoc.hex })
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, assoc.kp)))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    return { dir, key, length: diary.length }
  } finally {
    await store.close()
  }
}

// Appends one post to a member whose run is stopped; returns the new length.
async function appendPost (member, text) {
  const store = await openStore(member.dir)
  try {
    const diary = await openDiary(store)
    await appendRecord(diary, postRecord({ text }))
    member.length = diary.length
    return diary.length
  } finally {
    await store.close()
  }
}

// A long-lived run of a member, stopped by stop() or the teardown.
function startRun (t, bootstrap, member, opts = {}) {
  const controller = new AbortController()
  t.teardown(() => controller.abort(), { force: true })
  const run = runSync({ ...localSwarmOptions(bootstrap), dataDir: member.dir, signal: controller.signal, ...opts })
  return {
    stop: async () => {
      controller.abort()
      return run
    }
  }
}

// The seeder-side admission peers holding a proof for `key`.
function provenPeers (seeder, key) {
  return [...seeder._peers].filter((p) => p.provenKey === key)
}

// The seeder's copy of a diary reached `length`.
function seederHolds (seeder, key, length) {
  const served = seeder._served.get(key)
  return !!served && served.core.contiguousLength >= length
}

// A swarm that dials the seeder by its key (no topic, so it meets nobody
// else) and opens an admission channel as a member that announces nothing
// and never proves. Its Noise key is known before it dials.
function rawClient (t, bootstrap, seederKey) {
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const client = { swarm, key: hex(swarm.keyPair.publicKey), peers: [] }
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    Hypercore.createProtocolStream(socket)
    client.peers.push(attachAdmission(socket, { role: 'member', have: [] }))
  })
  client.dial = () => swarm.joinPeer(b4a.from(seederKey, 'hex'))
  return client
}

// Opens a new raw client every intervalMs until stop(); each one leaves
// after lifeMs, so the table stays under pressure with a bounded number of
// swarms alive.
function flood (t, bootstrap, seederKey, { intervalMs = 120, lifeMs = 2500 } = {}) {
  const keys = new Set()
  const timers = new Set()
  let stopped = false
  const tick = () => {
    if (stopped) return
    const c = rawClient(t, bootstrap, seederKey)
    keys.add(c.key)
    c.dial()
    const leave = setTimeout(() => {
      timers.delete(leave)
      c.swarm.destroy().catch(() => {})
    }, lifeMs)
    timers.add(leave)
    const next = setTimeout(() => {
      timers.delete(next)
      tick()
    }, intervalMs)
    timers.add(next)
  }
  const stop = () => {
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
  t.teardown(stop, { force: true })
  tick()
  return { keys, stop }
}

test('slots e2e: members behind one shared address keep syncing while many unproven connections arrive', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey: seederKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { maxConnections: 4, probationMs: PROBATION_MS })

  const a = await makeMember(t, assoc)
  const b = await makeMember(t, assoc)
  const runA = startRun(t, bootstrap, a)
  let runB = startRun(t, bootstrap, b)
  await until(() => provenPeers(seeder, a.key).length === 1 && provenPeers(seeder, b.key).length === 1, { timeoutMs: 60000, name: 'both members proved' })
  await until(() => seederHolds(seeder, a.key, a.length) && seederHolds(seeder, b.key, b.length), { timeoutMs: 30000, name: 'the seeder holds both diaries' })
  const [peerA] = provenPeers(seeder, a.key)
  const [peerB] = provenPeers(seeder, b.key)
  t.is(seeder._swarmSlots.count('127.0.0.1'), seeder._swarmSlots.size, 'every connection shares one address group')
  // Past probation, the members' connections could be rotated out by any
  // newcomer of their address if their proofs did not protect them.
  await sleep(PROBATION_MS + 200)

  // Every Noise key the seeder ever saw prove a member diary.
  const memberKeys = new Set([peerA.peerKey, peerB.peerKey])
  const watch = setInterval(() => {
    for (const p of [...provenPeers(seeder, a.key), ...provenPeers(seeder, b.key)]) memberKeys.add(p.peerKey)
  }, 25)
  t.teardown(() => clearInterval(watch), { force: true })

  const f = flood(t, bootstrap, seederKey)
  await until(() => displaced(events).length >= 1 && limited(events).length >= 1, { timeoutMs: 30000, name: 'unproven connections rotated and refused' })
  await sleep(PROBATION_MS)
  t.ok(seeder._peers.has(peerA) && seeder._peers.has(peerB), 'both members keep their connections under pressure')

  // B comes back with a new record while the flood goes on: its new
  // connection gets a slot, proves, and the seeder copies the record.
  const before = b.length
  await runB.stop()
  const length = await appendPost(b, 'depois da enxurrada')
  t.is(length, before + 1)
  runB = startRun(t, bootstrap, b)
  await until(() => seederHolds(seeder, b.key, length), { timeoutMs: 60000, name: 'the new record reached the seeder' })
  await until(() => provenPeers(seeder, b.key).length === 1, { timeoutMs: 30000, name: 'B proved again' })
  const [peerB2] = provenPeers(seeder, b.key)
  t.not(peerB2, peerB, 'on a new connection')

  // The pressure goes on after B's new connection is past probation too.
  const mark = displaced(events).length + limited(events).length
  await sleep(2 * PROBATION_MS + 500)
  await until(() => displaced(events).length + limited(events).length >= mark + 3, { timeoutMs: 30000, name: 'more flood connections handled' })
  f.stop()
  clearInterval(watch)

  t.ok(seeder._peers.has(peerA), 'A kept its first connection throughout')
  t.ok(seeder._peers.has(peerB2), 'B keeps its new connection')
  t.ok(seeder._swarmSlots.size <= 4, 'never above maxConnections')
  const hits = displaced(events).filter((e) => memberKeys.has(e.peerKey))
  t.alike(hits, [], 'no member connection was displaced')
  const floodDisplaced = displaced(events).filter((e) => f.keys.has(e.peerKey)).length
  const floodLimited = limited(events).filter((e) => f.keys.has(e.peerKey)).length
  t.ok(floodDisplaced >= 1, 'unproven connections were rotated (' + floodDisplaced + ')')
  t.ok(floodLimited >= 1, 'unproven connections were refused (' + floodLimited + ')')
  t.ok([...seeder._peers].every((p) => p.badMessages === 0), 'no bad messages')

  const [ra, rb] = await Promise.all([runA.stop(), runB.stop()])
  t.is(ra.ok, true, 'A run ok')
  t.is(rb.ok, true, 'B run ok')
})

test('slots e2e: a flood from one address cannot take the slots of another address', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey: seederKey } = prepareSeederDir(t, assoc)
  const floodKeys = new Set()
  const addressOf = (socket) => floodKeys.has(hex(socket.remotePublicKey)) ? '198.51.100.1' : '198.51.100.2'
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { maxConnections: 3, probationMs: 60000, addressOf })

  const clients = []
  for (let i = 0; i < 3; i++) {
    const c = rawClient(t, bootstrap, seederKey)
    floodKeys.add(c.key)
    c.dial()
    clients.push(c)
  }
  await until(() => seeder._swarmSlots.size === 3, { timeoutMs: 30000, name: 'the flood fills the table' })
  t.is(seeder._swarmSlots.count('198.51.100.1'), 3, 'all from one address')

  const m = await makeMember(t, assoc)
  const run = startRun(t, bootstrap, m)
  await until(() => seederHolds(seeder, m.key, m.length), { timeoutMs: 60000, name: 'the member synced' })
  t.is(seeder._swarmSlots.count('198.51.100.2'), 1, 'the other address holds a slot')
  t.ok(seeder._swarmSlots.size <= 3, 'never above maxConnections')
  const drops = displaced(events)
  t.ok(drops.length >= 1, 'a flood connection made room')
  t.ok(drops.every((e) => floodKeys.has(e.peerKey)), 'only flood connections displaced')

  const r = await run.stop()
  t.is(r.ok, true)
})
