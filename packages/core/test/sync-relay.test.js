'use strict'

// Follower announce (issue #67), end to end on the local testnet: a member in
// a long-running runSync announces the diaries it follows to verified seeders,
// so a diary reaches a seeder through a follower while its author is offline.
// Real Seeder, real member runs; the seeder's admit() is wrapped to record
// every announce it receives and from which connection.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { makeAssociation, prepareSeederDir, startSeeder } = require('./helpers/seeder-groups')
const { runSync } = require('../lib/sync')
const {
  openStore,
  openDiary,
  openReplica,
  appendRecord,
  writeConfig,
  writeFollows,
  readFollows,
  writeBlocklist
} = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord } = require('../lib/records')
const { createCert, createIssuerCert, createIssuedCert, createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { attachBlocklist } = require('../lib/blocklist-net')
const { createSwarm, topicFor, joinAndFlush, attachAdmission } = require('../lib/net')

const hex = (buf) => b4a.toString(buf, 'hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MOD_DATE = '2026-01-01T00:00:00.000Z'

// A member data dir with its own diary (certificate, profile). The store is
// closed on return, so runSync can open it.
async function makeMember (t, assoc) {
  const dir = tmpDir(t, 'varanda-relay-')
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

// Diaries of authors that never run: written into one plain Corestore, then
// copied into a follower's store by an in-process replication stream, so the
// follower holds them with their authors offline from the start.
class Authors {
  constructor (t, assoc) {
    this.assoc = assoc
    this.store = new Corestore(tmpDir(t, 'varanda-relay-authors-'))
    t.teardown(() => this.store.close(), { force: true })
    this.n = 0
  }

  // -> { key, length }; `issuer` ({ keyPair, cert }) makes block 0 a v2 certificate.
  async make (issuer = null) {
    await this.store.ready()
    const core = this.store.get({ name: 'author-' + this.n++, valueEncoding: 'json' })
    await core.ready()
    const key = hex(core.key)
    const cert = issuer ? createIssuedCert({ member: key }, issuer.keyPair, issuer.cert) : createCert({ member: key }, this.assoc.kp)
    await appendRecord(core, memberCertRecord(cert))
    await appendRecord(core, profileRecord({ name: 'Autor', bio: '' }))
    await appendRecord(core, postRecord({ text: 'post' }))
    return { key, length: core.length }
  }

  // The follower holds every diary in `list` and follows them (its run must
  // not be active meanwhile).
  async give (member, list) {
    const store = await openStore(member.dir)
    try {
      const a = this.store.replicate(true)
      const b = store.replicate(false)
      a.on('error', () => {})
      b.on('error', () => {})
      a.pipe(b).pipe(a)
      for (const d of list) {
        const core = await openReplica(store, d.key)
        await core.update({ wait: true })
        for (let i = 0; i < d.length; i++) await core.get(i)
        await core.close()
      }
      a.destroy()
      b.destroy()
    } finally {
      await store.close()
    }
    writeFollows(member.dir, [...readFollows(member.dir), ...list.map((d) => d.key)])
  }
}

// A long-running run of a member with its events and result.
function startRun (t, bootstrap, member, opts = {}) {
  const controller = new AbortController()
  const events = []
  const logs = []
  t.teardown(() => controller.abort(), { force: true })
  const done = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: member.dir,
    signal: controller.signal,
    onEvent: (ev) => events.push(ev),
    log: (line) => logs.push(line),
    ...opts
  })
  done.catch(() => {})
  return { events, logs, done, stop: () => { controller.abort(); return done } }
}

// A seeder that records every announce it receives: { key, peerKey }.
async function startSpiedSeeder (t, bootstrap, assoc, opts = {}) {
  const { prepare, ...rest } = opts
  const { dataDir } = prepareSeederDir(t, assoc)
  if (prepare) prepare(dataDir)
  const announced = []
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    ...rest,
    beforeStart: (s) => {
      const admit = s.admit.bind(s)
      s.admit = (key, cert, peer) => {
        announced.push({ key, peerKey: peer.peerKey })
        return admit(key, cert, peer)
      }
    }
  })
  const keys = () => announced.map((a) => a.key)
  const holds = (key, length) => {
    const served = seeder._served.get(key)
    return !!served && served.core.contiguousLength >= length
  }
  const drops = (...reasons) => events.filter((e) => e.event === 'peer-dropped' && reasons.includes(e.reason))
  return { seeder, events, announced, keys, holds, drops, dataDir }
}

// A raw node on the association rendezvous that hands every connection one
// blocklist snapshot, as a moderator would.
async function moderator (t, bootstrap, assoc, snapshot) {
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    Hypercore.createProtocolStream(socket)
    attachBlocklist(socket, { current: () => snapshot, offer: async () => ({ adopted: false, reason: 'same' }) })
    attachAdmission(socket, { role: 'member', have: [], onmessage: () => {}, onclose: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(assoc.hex)])
  return swarm
}

test('a follower gets a diary to a seeder while its author is offline', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const a = await makeMember(t, assoc)
  const f = await makeMember(t, assoc)
  writeFollows(f.dir, [a.key])

  // F and A sync directly, no seeder; then A never runs again.
  const runA = startRun(t, bootstrap, a)
  const runF1 = startRun(t, bootstrap, f)
  await until(() => runF1.events.some((e) => e.event === 'downloaded' && e.key === a.key && e.length >= a.length), { timeoutMs: 60000, name: 'F holds A' })
  const ra = await runA.stop()
  const rf1 = await runF1.stop()
  t.is(ra.ok, true, 'A run ok')
  t.is(rf1.ok, true, 'F first run ok')

  // A seeder that never saw A starts; only F can bring the diary.
  const s = await startSpiedSeeder(t, bootstrap, assoc)
  t.absent(s.seeder._served.has(a.key), 'the seeder never saw A')
  const runF2 = startRun(t, bootstrap, f)
  await until(() => s.holds(a.key, a.length), { timeoutMs: 90000, name: 'the seeder serves A at its full length' })
  await until(() => s.events.some((e) => e.event === 'admitted' && e.key === a.key), { timeoutMs: 30000, name: 'A admitted' })
  t.pass('A admitted through F')
  t.ok(s.announced.some((x) => x.key === a.key), 'the announce came from F')
  const rf2 = await runF2.stop()
  t.is(rf2.ok, true, 'F second run ok')
  t.is(s.drops('announce-rate', 'bad-announces').length, 0, 'F was never dropped')

  // A third member, with only the seeder online, gets A.
  const g = await makeMember(t, assoc)
  writeFollows(g.dir, [a.key])
  const rg = await runSync({ ...localSwarmOptions(bootstrap), dataDir: g.dir, once: true, timeoutMs: 60000 })
  t.is(rg.ok, true, 'G run ok ' + JSON.stringify(rg.errors))
  t.is(rg.downloaded[a.key], a.length, 'G got A from the seeder')
})

test('a --once run announces only its own diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const f = await makeMember(t, assoc)
  const a = await authors.make()
  await authors.give(f, [a])
  const s = await startSpiedSeeder(t, bootstrap, assoc)

  const r = await runSync({ ...localSwarmOptions(bootstrap), dataDir: f.dir, once: true, timeoutMs: 60000 })
  t.is(r.ok, true, 'run ok ' + JSON.stringify(r.errors))
  await sleep(500)
  t.alike(s.keys(), [f.key], 'only the own announce')
  t.absent(s.seeder._served.has(a.key), 'the followed diary was not taken')
})

test('a diary the seeder already lists is not announced', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const a = await makeMember(t, assoc)
  const f = await makeMember(t, assoc)
  writeFollows(f.dir, [a.key])

  // F holds A, with no seeder around.
  const runA1 = startRun(t, bootstrap, a)
  const runF1 = startRun(t, bootstrap, f)
  await until(() => runF1.events.some((e) => e.event === 'downloaded' && e.key === a.key && e.length >= a.length), { timeoutMs: 60000, name: 'F holds A' })
  await runF1.stop()
  await runA1.stop()

  // A reaches the seeder through its own run, then goes offline.
  const s = await startSpiedSeeder(t, bootstrap, assoc)
  const runA2 = startRun(t, bootstrap, a)
  await until(() => s.holds(a.key, a.length), { timeoutMs: 60000, name: 'the seeder holds A' })
  await runA2.stop()

  // F also holds B, which the seeder does not have.
  const b = await authors.make()
  await authors.give(f, [b])
  const before = s.announced.length
  const runF2 = startRun(t, bootstrap, f)
  await until(() => s.holds(b.key, b.length), { timeoutMs: 90000, name: 'the seeder serves B' })
  await sleep(500)
  const mine = s.announced.slice(before).map((x) => x.key).sort()
  t.alike(mine, [f.key, b.key].sort(), 'F announced itself and B, not A')
  t.is((await runF2.stop()).ok, true, 'run ok')
})

test('blocked and revoked follows are never announced', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, assoc.kp)
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuer = { keyPair: issuerKp, cert: createIssuerCert({ issuer: issuerHex }, assoc.kp) }

  // 1. A follow that becomes blocked while active leaves nothing to announce.
  {
    const f = await makeMember(t, assoc)
    const blocked = await authors.make()
    const clean = await authors.make()
    await authors.give(f, [blocked, clean])
    // F activates both replicas from its store, then adopts the snapshot.
    const mod = await moderator(t, bootstrap, assoc, createSnapshot({ seq: 1, date: MOD_DATE, blocked: [blocked.key] }, modKp, modCert))
    const run = startRun(t, bootstrap, f)
    await until(() => run.events.some((e) => e.event === 'skipped' && e.key === blocked.key && e.reason === 'blocked'), { timeoutMs: 60000, name: 'F skips the blocked diary' })
    await mod.destroy()
    const s = await startSpiedSeeder(t, bootstrap, assoc)
    await until(() => s.holds(clean.key, clean.length), { timeoutMs: 90000, name: 'the seeder serves the clean diary' })
    await sleep(500)
    t.absent(s.keys().includes(blocked.key), 'the blocked diary was not announced')
    t.is((await run.stop()).ok, true, 'run ok')
    await s.seeder.close()
  }

  // 2. A stored snapshot that blocks one diary and revokes the issuer of another.
  {
    const f = await makeMember(t, assoc)
    const blocked = await authors.make()
    const revoked = await authors.make(issuer)
    const clean = await authors.make()
    await authors.give(f, [blocked, revoked, clean])
    writeBlocklist(f.dir, createSnapshot({ seq: 1, date: MOD_DATE, blocked: [blocked.key], revokedIssuers: [issuerHex] }, modKp, modCert))
    const s = await startSpiedSeeder(t, bootstrap, assoc)
    const run = startRun(t, bootstrap, f)
    await until(() => s.holds(clean.key, clean.length), { timeoutMs: 90000, name: 'the seeder serves the clean diary' })
    await sleep(500)
    const keys = s.keys()
    t.ok(keys.includes(clean.key), 'the clean diary was announced')
    t.absent(keys.includes(blocked.key), 'the blocked diary was not announced')
    t.absent(keys.includes(revoked.key), 'the diary of the revoked issuer was not announced')
    t.is((await run.stop()).ok, true, 'run ok')
  }
})

test('a refused announce leaves the run healthy and is not repeated on the connection', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, assoc.kp)
  const f = await makeMember(t, assoc)
  const refused = await authors.make()
  const fine = await authors.make()
  await authors.give(f, [refused, fine])

  // The seeder blocks `refused`, so it answers the announce with 'rejected'.
  const { seeder, events, announced } = await startSpiedSeeder(t, bootstrap, assoc, {
    prepare: (dir) => writeBlocklist(dir, createSnapshot({ seq: 1, date: MOD_DATE, blocked: [refused.key] }, modKp, modCert))
  })
  const run = startRun(t, bootstrap, f)
  await until(() => events.some((e) => e.event === 'rejected' && e.key === refused.key && e.reason === 'blocked'), { timeoutMs: 90000, name: 'the seeder refuses the diary' })
  await until(() => seeder._served.has(fine.key) && seeder._served.get(fine.key).core.contiguousLength >= fine.length, { timeoutMs: 90000, name: 'the seeder serves the other diary' })
  await sleep(1000)
  const mine = announced.filter((x) => x.key === refused.key)
  t.is(mine.length, 1, 'announced once on its connection')
  t.is(new Set(announced.filter((x) => x.key === fine.key).map((x) => x.peerKey)).size, 1, 'one connection')
  t.absent(seeder._served.has(refused.key), 'the seeder does not serve the refused diary')
  t.is(events.filter((e) => e.event === 'peer-dropped').length, 0, 'nobody was dropped')
  const r = await run.stop()
  t.is(r.ok, true, 'the run is healthy ' + JSON.stringify(r.errors))
  t.is(run.events.filter((e) => e.event === 'rejected').length, 0, 'no own-key rejection')
})

test('25 followed diaries reach a seeder with default limits and no drop', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const f = await makeMember(t, assoc)
  const list = []
  for (let i = 0; i < 25; i++) list.push(await authors.make())
  await authors.give(f, list)
  const s = await startSpiedSeeder(t, bootstrap, assoc)
  const run = startRun(t, bootstrap, f)
  await until(() => list.every((d) => s.holds(d.key, d.length)), { timeoutMs: 120000, name: 'the seeder serves all 25 diaries' })
  t.is(list.filter((d) => s.events.some((e) => e.event === 'admitted' && e.key === d.key)).length, 25, 'all admitted')
  t.is(s.drops('announce-rate', 'bad-announces').length, 0, 'no announce drop')
  t.is(s.events.filter((e) => e.event === 'peer-dropped').length, 0, 'no drop at all')
  t.is((await run.stop()).ok, true, 'run ok')
})

test('an unpaced relay is dropped for its announce rate', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const f = await makeMember(t, assoc)
  const list = []
  for (let i = 0; i < 25; i++) list.push(await authors.make())
  await authors.give(f, list)
  const s = await startSpiedSeeder(t, bootstrap, assoc)
  const run = startRun(t, bootstrap, f, { relayBurst: 64, relayRate: 1000 })
  await until(() => s.drops('announce-rate').length >= 1, { timeoutMs: 60000, name: 'the seeder drops the burst' })
  t.ok(s.drops('announce-rate').length >= 1, 'dropped with announce-rate')
  t.is((await run.stop()).ok, true, 'a drop does not fail the run')
})

test('announceFollows: false announces only the own diary', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const authors = new Authors(t, assoc)
  const f = await makeMember(t, assoc)
  const a = await authors.make()
  await authors.give(f, [a])
  const s = await startSpiedSeeder(t, bootstrap, assoc)
  const run = startRun(t, bootstrap, f, { announceFollows: false })
  await until(() => s.holds(f.key, f.length), { timeoutMs: 60000, name: 'the seeder holds F' })
  await sleep(1500)
  t.alike(s.keys(), [f.key], 'only the own announce')
  t.absent(s.seeder._served.has(a.key), 'the followed diary was not taken')
  t.is((await run.stop()).ok, true, 'run ok')
})
