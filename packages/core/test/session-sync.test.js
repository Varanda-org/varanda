'use strict'

// The node session's sync on an in-process loopback testnet: two sessions
// sync once through a certified seeder, a continuous run preempted by a
// request and restarted, sync.stop, detach, suspend/resume, and the events
// (sync.started, sync.event, sync.stopped, warning) as the client sees them.
// profile.read over synced replicas (names, handles, blocked and unknown keys).
// The sessions get only the bootstrap list: the loopback DHT host is implied.
const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { tmpDir } = require('./helpers/tmp')
const { testnet, localSwarmOptions, until, newSession, connect, failure, scanWire } = require('./helpers/net')
const { initAssociation, issueCertificate, issueSeederCertificate, issueIssuerCertificate, issueModeratorCertificate } = require('../lib/assoc')
const { createUsernameRecord } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist, openStore, openDiary, appendRecord } = require('../lib/store')
const { profileRecords } = require('../lib/records')
const { Seeder } = require('../lib/seeder')

function association (t) {
  const dir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey } = initAssociation(dir)
  return { dir, hex: publicKey }
}

// The CLI's seeder setup, in-process: seed key, assoc certify-seeder, seed cert add.
async function startSeeder (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(issueSeederCertificate(assoc.dir, { seeder: publicKey })))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return seeder
}

// A connected member session with identity and certificate.
async function member (t, bootstrap, assoc, { cert = true } = {}) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  if (cert) await link.call('cert.add', { cert: issueCertificate(assoc.dir, { member: publicKey }) })
  return { dataDir, session, publicKey, ...link }
}

// Lets the in-memory link deliver what was already sent.
const tick = () => new Promise((resolve) => setImmediate(resolve))

function eventOf (m, event, match = () => true) {
  return m.events.find((e) => e.event === event && match(e.data))
}

function waitEvent (m, event, match, name) {
  return until(() => eventOf(m, event, match), { timeoutMs: 60000, name: name || event })
}

test('sync once between two sessions through a certified seeder', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  await startSeeder(t, bootstrap, assoc)

  const a = await member(t, bootstrap, assoc)
  await a.call('profile.set', { name: 'Ana' })
  await a.call('post.create', { text: 'olá de A' })
  const { runId: runA } = await a.call('sync.start', { once: true, timeoutMs: 30000 })
  t.ok(Number.isSafeInteger(runA) && runA >= 1)
  t.ok(eventOf(a, 'sync.started', (d) => d.runId === runA && d.once === true), 'sync.started { runId, once: true }')
  const stoppedA = await waitEvent(a, 'sync.stopped', (d) => d.runId === runA)
  t.is(stoppedA.data.reason, 'done')
  t.is(stoppedA.data.result.ok, true)
  t.is(stoppedA.data.result.seederConfirmed, true)
  t.is(stoppedA.data.result.seeders, 1)
  t.is(stoppedA.data.result.errorsTruncated, 0, 'a capped SyncResult')
  t.ok(eventOf(a, 'sync.event', (d) => d.runId === runA && d.line === 'sync ready'), 'sync ready line')
  t.ok(eventOf(a, 'sync.event', (d) => d.runId === runA && /^peer seeder [0-9a-f]{8}$/.test(d.line)), 'peer seeder line')
  t.ok(eventOf(a, 'sync.event', (d) => d.runId === runA && d.line.startsWith('admitted ' + a.publicKey + ' ')), 'admitted line')
  t.alike(await a.call('sync.status'), { state: 'idle' })

  const b = await member(t, bootstrap, assoc)
  t.alike(await b.call('follow.add', { key: a.publicKey }), { changed: true, followCount: 1 })
  const { runId: runB } = await b.call('sync.start', { once: true })
  const stoppedB = await waitEvent(b, 'sync.stopped', (d) => d.runId === runB)
  t.is(stoppedB.data.reason, 'done')
  t.is(stoppedB.data.result.ok, true)
  t.is(stoppedB.data.result.downloaded[a.publicKey], 3)
  t.ok(eventOf(b, 'sync.event', (d) => d.line === 'downloaded ' + a.publicKey + ' 3'), 'downloaded line')

  const feed = await b.call('feed.read')
  t.alike(feed.items.map((i) => [i.author, i.name, i.text]), [[a.publicKey, 'Ana', 'olá de A']])
  const log = await b.call('log.read', { author: a.publicKey })
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2])
  const info = await b.call('node.info')
  t.alike(info, { publicKey: b.publicKey, memberCert: true, followCount: 1, sync: { state: 'idle' }, publicDht: false })
})

test('continuous sync: preempted by a request and restarted, then sync.stop', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)

  const { runId: r1 } = await m.call('sync.start')
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === r1 && d.once === false))
  t.alike(await m.call('sync.status'), { state: 'running', runId: r1, once: false })
  t.alike(await failure(m.call('sync.start')), { code: 'USAGE', message: 'sincronização já em andamento' })
  t.alike(await failure(m.call('sync.start', { once: true })), { code: 'USAGE', message: 'sincronização já em andamento' })
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 && d.line === 'sync ready', 'sync ready')

  const before = m.events.length
  t.alike(await m.call('post.create', { text: 'durante a sincronização' }), { seq: 1, ref: m.publicKey + ':1' })
  const after = m.events.slice(before)
  const stopped = after.findIndex((e) => e.event === 'sync.stopped' && e.data.runId === r1)
  const started = after.findIndex((e) => e.event === 'sync.started' && e.data.runId === r1 + 1)
  t.ok(stopped >= 0, 'the run was stopped')
  t.alike(after[stopped].data, { runId: r1, reason: 'preempted' }, 'reason preempted, no result for a continuous run')
  t.ok(started > stopped, 'then restarted with a new runId')
  t.alike(after[started].data, { runId: r1 + 1, once: false })
  t.alike(await m.call('sync.status'), { state: 'running', runId: r1 + 1, once: false })
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 + 1 && d.line === 'sync ready', 'restarted run ready')

  // node.info (identity cached) does not preempt the run.
  const n = m.events.length
  t.alike((await m.call('node.info')).sync, { state: 'running', runId: r1 + 1, once: false })
  t.absent(m.events.slice(n).some((e) => e.event === 'sync.stopped'), 'node.info did not stop the run')

  t.alike(await m.call('sync.stop'), { stopped: true })
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === r1 + 1 && d.reason === 'stopped'))
  t.alike(await m.call('sync.status'), { state: 'idle' })
  t.alike(await m.call('sync.stop'), { stopped: false })

  // A stopped run is not restarted by a later request.
  const k = m.events.length
  await m.call('post.create', { text: 'depois de parar' })
  t.absent(m.events.slice(k).some((e) => e.event === 'sync.started'))
  t.alike(await m.call('sync.status'), { state: 'idle' })
})

test('a preempted once run ends (with its result) and is not restarted', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)
  const { runId } = await m.call('sync.start', { once: true, timeoutMs: 60000 })
  const before = m.events.length
  await m.call('post.create', { text: 'interrompe' })
  const stopped = eventOf(m, 'sync.stopped', (d) => d.runId === runId)
  t.ok(stopped, 'stopped before the response')
  t.is(stopped.data.reason, 'preempted')
  t.is(typeof stopped.data.result, 'object', 'a resolved once run carries its result')
  t.is(stopped.data.result.ok, false)
  t.absent(m.events.slice(before).some((e) => e.event === 'sync.started'), 'not restarted')
  t.alike(await m.call('sync.status'), { state: 'idle' })
})

test('a once run with no peers ends with reason timeout', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)
  const { runId } = await m.call('sync.start', { once: true, timeoutMs: 1000 })
  const stopped = await waitEvent(m, 'sync.stopped', (d) => d.runId === runId)
  t.is(stopped.data.reason, 'timeout')
  t.is(stopped.data.result.ok, false)
  t.is(stopped.data.result.errors[0], 'sem pares')
})

test('runSync log lines are warnings; detach stops the run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc, { cert: false })
  const { runId } = await m.call('sync.start')
  await waitEvent(m, 'warning', (d) => d.line === 'sem certificado válido no bloco 0: o diário não será anunciado', 'no-cert warning')
  await waitEvent(m, 'sync.event', (d) => d.runId === runId && d.line === 'sync ready', 'sync ready')
  const n = m.events.length
  await m.session.detach()
  t.is(m.events.length, n, 'no event after detach (the sync.stopped is not delivered)')
  t.alike(await m.call('sync.status'), { state: 'idle' }, 'the run stopped')
  // A later request does not restart it.
  await m.call('identity.show')
  t.alike(await m.call('sync.status'), { state: 'idle' })
  // Re-attached: events flow again.
  m.session.attach(m.dispatcher.emit)
  const { runId: next } = await m.call('sync.start')
  t.is(next, runId + 1)
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === next))
  await m.call('sync.stop')
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === next && d.reason === 'stopped'))
})

test('suspend pauses a continuous run, resume restarts it; close stops it', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)
  const { runId: r1 } = await m.call('sync.start')
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 && d.line === 'sync ready', 'sync ready')

  await m.session.suspend()
  await tick()
  t.is(m.session.state, 'suspended')
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === r1 && d.reason === 'preempted'), 'paused')
  let answered = false
  const status = m.call('sync.status').then((s) => { answered = true; return s })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.absent(answered, 'requests queue while suspended')
  t.absent(eventOf(m, 'sync.started', (d) => d.runId === r1 + 1), 'no restart while suspended')

  m.session.resume()
  t.alike(await status, { state: 'running', runId: r1 + 1, once: false }, 'restarted on resume')
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === r1 + 1 && d.once === false))

  // resume with nothing queued restarts at once.
  await m.session.suspend()
  await tick()
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === r1 + 1 && d.reason === 'preempted'))
  m.session.resume()
  await tick()
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === r1 + 2), 'restarted')
  t.alike(await m.call('sync.status'), { state: 'running', runId: r1 + 2, once: false })

  await m.session.close()
  await tick()
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === r1 + 2 && d.reason === 'stopped'), 'close stops the run')
  t.alike(await failure(m.call('sync.status')), { code: 'LOCKED', message: 'sessão encerrada' })
})

test('LOCKED while restarting a sync: error event, then the error state', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)
  const { runId: r1 } = await m.call('sync.start')
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 && d.line === 'sync ready', 'sync ready')
  await m.session.suspend()
  // Another opener takes the dir while the app is in the background.
  const { openStore } = require('../lib/store')
  const other = await openStore(m.dataDir)
  t.teardown(() => other.close(), { force: true })
  m.session.resume()
  const stopped = await waitEvent(m, 'sync.stopped', (d) => d.runId === r1 + 1)
  t.is(stopped.data.reason, 'error')
  t.ok(eventOf(m, 'warning', (d) => d.line === 'erro: diretório de dados em uso'), 'erro: warning before sync.stopped')
  t.is(m.session.state, 'error')
  t.alike(await failure(m.call('sync.status')), { code: 'LOCKED', message: 'diretório de dados em uso' })
})

// A second session over a member dir that already has an identity: its
// identity is not cached yet, so identity() opens the store (an await).
async function reopened (t, bootstrap, assoc, { cert = true } = {}) {
  const first = await member(t, bootstrap, assoc, { cert })
  await first.session.close()
  const session = newSession(t, { dataDir: first.dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  return { dataDir: first.dataDir, session, publicKey: first.publicKey, ...link }
}

const count = (events, event, match = () => true) => events.filter((e) => e.event === event && match(e.data)).length

test('regression: detach while sync.start awaits the identity starts no run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await reopened(t, bootstrap, assoc)
  // Called on the handler directly, then detached before its identity() settles.
  const pending = m.session.handlers['sync.start']({ once: false })
  await m.session.detach()
  const outcome = await pending.then(() => 'started', (err) => err.code + ' ' + err.message)
  t.is(outcome, 'USAGE conexão encerrada', 'the request of the closed connection starts nothing')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.alike(await m.session.handlers['sync.status']({}), { state: 'idle' }, 'no run without a connection')
  // Nothing restarts it either.
  await m.session.handlers['identity.show']({})
  t.alike(await m.session.handlers['sync.status']({}), { state: 'idle' })
  // A new sync.start (new connection) works.
  m.session.attach(m.dispatcher.emit)
  const { runId } = await m.call('sync.start')
  t.alike(await m.call('sync.status'), { state: 'running', runId, once: false })
  await m.call('sync.stop')
})

test('regression: a run unwinding after detach does not report to the next connection', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc, { cert: false })
  const { runId } = await m.call('sync.start')
  await waitEvent(m, 'sync.event', (d) => d.runId === runId && d.line === 'sync ready', 'sync ready')
  const n = m.events.length
  // The transport does not await detach(): the next socket may attach while the run stops.
  const detached = m.session.detach()
  m.session.attach(m.dispatcher.emit)
  await detached
  t.is(m.events.length, n, 'neither a warning nor the sync.stopped of the old run reaches the new connection')
  t.alike(await m.call('sync.status'), { state: 'idle' })
  const { runId: next } = await m.call('sync.start')
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === next), 'a run of the new connection reports normally')
  await m.call('sync.stop')
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === next && d.reason === 'stopped'))
})

test('regression: resume() before suspend() finished still restarts the run', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)
  const { runId: r1 } = await m.call('sync.start')
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 && d.line === 'sync ready', 'sync ready')
  const suspending = m.session.suspend()
  m.session.resume() // while the run is still stopping
  await suspending
  await tick()
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === r1 && d.reason === 'preempted'))
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === r1 + 1), 'restarted once the stop completed')
  t.alike(await m.call('sync.status'), { state: 'running', runId: r1 + 1, once: false })
  await m.call('sync.stop')
})

test('regression: node.info reports the restarted run, matching the events', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  // No certificate: memberCert is never cached, so node.info opens the store.
  const m = await reopened(t, bootstrap, assoc, { cert: false })
  const { runId: r1 } = await m.call('sync.start')
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 && d.line === 'sync ready', 'sync ready')
  const info = await m.call('node.info')
  t.ok(eventOf(m, 'sync.stopped', (d) => d.runId === r1 && d.reason === 'preempted'), 'node.info preempted the run')
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === r1 + 1), 'and it was restarted before the response')
  t.alike(info.sync, { state: 'running', runId: r1 + 1, once: false }, 'the response matches the events')
  t.is(info.memberCert, false)
  t.alike(await m.call('sync.status'), info.sync)
  await m.call('sync.stop')
})

test('regression: requests queued during a continuous run preempt it once', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const m = await member(t, bootstrap, assoc)
  const { runId: r1 } = await m.call('sync.start')
  await waitEvent(m, 'sync.event', (d) => d.runId === r1 && d.line === 'sync ready', 'sync ready')
  const before = m.events.length
  const posts = await Promise.all(['a', 'b', 'c', 'd'].map((text) => m.call('post.create', { text })))
  t.alike(posts.map((p) => p.seq), [1, 2, 3, 4])
  await tick()
  const after = m.events.slice(before)
  t.is(count(after, 'sync.stopped'), 1, 'one stop')
  t.is(count(after, 'sync.stopped', (d) => d.runId === r1 && d.reason === 'preempted'), 1)
  t.is(count(after, 'sync.started'), 1, 'one restart, by the last request')
  t.ok(eventOf(m, 'sync.started', (d) => d.runId === r1 + 1))
  t.alike(await m.call('sync.status'), { state: 'running', runId: r1 + 1, once: false })
  await m.call('sync.stop')
})

// One `once` run that must end 'done' with ok: true.
async function syncOnce (t, m) {
  const { runId } = await m.call('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await waitEvent(m, 'sync.stopped', (d) => d.runId === runId)
  t.is(stopped.data.reason, 'done')
  t.is(stopped.data.result.ok, true)
}

test('profile.read over synced replicas: names, usernames, blocked and unknown keys', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  await startSeeder(t, bootstrap, assoc)

  const a = await member(t, bootstrap, assoc)
  await a.call('profile.set', { name: 'Ana', bio: 'oi' })
  await a.call('post.create', { text: 'olá de A' })
  await syncOnce(t, a)
  const c = await member(t, bootstrap, assoc)
  await c.call('profile.set', { name: 'Cris' })
  await c.call('post.create', { text: 'olá de C' })
  // A photo pair as the browser node writes it.
  const avatar = { core: 'ab'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: 'e'.repeat(64), width: 512, height: 512 }
  const s = await openStore(c.dataDir)
  try {
    const diary = await openDiary(s)
    for (const r of profileRecords({ name: 'Cris', avatar })) await appendRecord(diary, r)
  } finally {
    await s.close()
  }
  await syncOnce(t, c)

  const b = await member(t, bootstrap, assoc)
  await b.call('follow.add', { key: a.publicKey })
  await b.call('follow.add', { key: c.publicKey })
  await syncOnce(t, b)
  const unknown = 'f'.repeat(64)
  t.alike(await b.call('profile.read', { authors: [a.publicKey, unknown, c.publicKey, a.publicKey] }), {
    profiles: [
      { author: a.publicKey, name: 'Ana', bio: 'oi', avatar: null, username: null },
      { author: c.publicKey, name: 'Cris', bio: '', avatar, username: null }
    ],
    missing: [unknown]
  })

  // An issuer-signed username record on A's diary reaches B with one more sync.
  const issuerKp = crypto.keyPair()
  const issuerCert = issueIssuerCertificate(assoc.dir, { issuer: b4a.toString(issuerKp.publicKey, 'hex') })
  const record = createUsernameRecord({ member: a.publicKey, username: 'ana_1' }, issuerKp, issuerCert)
  t.alike(await a.call('username.add', { record }), { changed: true, username: 'ana_1', seq: 3 })
  t.alike((await a.call('profile.read', { authors: [a.publicKey] })).profiles[0].username, 'ana_1', 'the own diary')
  await syncOnce(t, a)
  await syncOnce(t, b)
  t.alike(await b.call('profile.read', { authors: [a.publicKey] }), {
    profiles: [{ author: a.publicKey, name: 'Ana', bio: 'oi', avatar: null, username: 'ana_1' }],
    missing: []
  })

  // A key the enforced blocklist names is missing, as in feed.read.
  const modKp = crypto.keyPair()
  const modCert = issueModeratorCertificate(assoc.dir, { moderator: b4a.toString(modKp.publicKey, 'hex') })
  writeBlocklist(b.dataDir, createSnapshot({ seq: 1, blocked: [c.publicKey] }, modKp, modCert))
  t.alike(await b.call('profile.read', { authors: [c.publicKey, a.publicKey] }), {
    profiles: [{ author: a.publicKey, name: 'Ana', bio: 'oi', avatar: null, username: 'ana_1' }],
    missing: [c.publicKey]
  })
  t.alike((await b.call('feed.read')).skipped, [{ key: c.publicKey, reason: 'blocked' }], 'the same rule as feed.read')
  t.alike([a.session.internal, b.session.internal, c.session.internal], [[], [], []], 'no internal error')
})

test('no response or event of this file carries a path', (t) => {
  scanWire(t, process.env.VARANDA_TEST_TMPDIR || os.tmpdir())
})
