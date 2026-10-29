'use strict'

// Byte clearing end to end on the loopback testnet: node sessions (author,
// followers) through a real dispatcher + client pair, a real certified
// Seeder, and a raw stale peer that keeps every block it ever downloaded.
// After post.delete the block is gone from the seeder and the follower (has
// is false, a fresh raw replica asking for it gets nothing), across a restart
// of both and a reconnection of the stale peer, while later blocks and the
// tombstone keep flowing; a fresh follower that meets the stale peer ends
// without it; a forged tombstone clears nothing; a truncate is still a fork
// on the seeder and the follower; the kill switch keeps the bytes and still
// hides the post.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { tmpDir } = require('./helpers/tmp')
const { testnet, localSwarmOptions, until, newSession, connect } = require('./helpers/net')
const { initAssociation, issueCertificate, issueSeederCertificate } = require('../lib/assoc')
const { createCert, generateAssociationKeyPair, createSeederCert } = require('../lib/cert')
const storeLib = require('../lib/store')
const { memberCertRecord, postRecord, deleteRecord } = require('../lib/records')
const { createSwarm, topicFor, joinAndFlush, attachAdmission, watchContiguous } = require('../lib/net')
const { Seeder } = require('../lib/seeder')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association (t) {
  const dir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey } = initAssociation(dir)
  return { dir, hex: publicKey }
}

function seederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(issueSeederCertificate(assoc.dir, { seeder: publicKey })))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return dataDir
}

async function startSeeder (t, bootstrap, dataDir) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

async function member (t, bootstrap, assoc) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assoc.dir, { member: publicKey }) })
  return { dataDir, session, publicKey, ...link }
}

// A new session on a stopped member's data directory (a restart).
async function reopen (t, bootstrap, assoc, m) {
  await m.session.close()
  const session = newSession(t, { dataDir: m.dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  return { dataDir: m.dataDir, session, publicKey: m.publicKey, ...link }
}

// Appends a record the writer would refuse, past its validation, while the
// session is idle.
async function appendRaw (dataDir, record) {
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    const { length } = await diary.append(record)
    return length - 1
  } finally {
    await s.close()
  }
}

function eventOf (m, event, match = () => true) {
  return m.events.find((e) => e.event === event && match(e.data))
}

async function syncOnce (t, m, label) {
  const { runId } = await m.call('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await until(() => eventOf(m, 'sync.stopped', (d) => d.runId === runId), { timeoutMs: 60000, name: label })
  t.is(stopped.data.reason, 'done', label + ' done')
  t.is(stopped.data.result.ok, true, label + ' ok')
}

async function followerSync (t, b, author, length, label) {
  for (let i = 0; i < 3; i++) {
    await syncOnce(t, b, label + ' #' + (i + 1))
    const log = await b.call('log.read', { author })
    if (log.entries.length + log.invalid.length >= length) return
  }
  t.fail(label + ': the follower never reached length ' + length)
}

function postTexts (feed, author) {
  return feed.items.filter((i) => i.kind === 'post' && i.author === author).map((i) => [i.seq, i.text]).sort((x, y) => x[0] - y[0])
}

// What an idle member's store holds of `key` (the session keeps no store
// open between calls).
async function inspect (dataDir, key, seq) {
  const s = await storeLib.openStore(dataDir)
  try {
    if (!(await storeLib.replicaStored(s, key))) return { stored: false }
    const replica = await storeLib.openReplica(s, key)
    try {
      return { stored: true, length: replica.length, held: await replica.has(seq), entries: await storeLib.readAll(replica) }
    } finally {
      await replica.close()
    }
  } finally {
    await s.close()
  }
}

function seederHolds (seeder, key, seq) {
  const entry = seeder._served.get(key)
  return entry ? entry.core.has(seq) : false
}

function seederLength (seeder, key) {
  const entry = seeder._served.get(key)
  return entry ? entry.core.length : 0
}

// A raw peer that ignores tombstones: it keeps every block of `key` it
// ever downloaded and advertises them. Its store outlives its swarm, so it
// can go offline and come back with the deleted block.
async function stalePeer (t, bootstrap, assocHex, key) {
  const store = new Corestore(tmpDir(t, 'varanda-stale-'))
  await store.ready()
  const core = store.get({ key: b4a.from(key, 'hex') })
  await core.ready()
  const range = core.download({ start: 0, end: -1 })
  const peers = new Set()
  const stopWatch = watchContiguous(core, (length) => {
    for (const p of peers) p.send({ type: 'have', key, length })
  })
  let swarm = null
  const offline = async () => {
    if (swarm === null) return
    const s = swarm
    swarm = null
    peers.clear()
    await s.destroy()
  }
  const online = async () => {
    swarm = createSwarm(localSwarmOptions(bootstrap))
    swarm.on('connection', (socket) => {
      socket.on('error', () => {})
      store.replicate(socket)
      const peer = attachAdmission(socket, {
        role: 'member',
        have: [{ key, length: core.contiguousLength }],
        onmessage: () => {},
        onclose: (p) => peers.delete(p)
      })
      peers.add(peer)
    })
    await joinAndFlush(swarm, [topicFor(assocHex), core.discoveryKey])
  }
  t.teardown(async () => {
    stopWatch()
    range.destroy()
    await offline()
    await store.close()
  }, { force: true })
  await online()
  return { core, online, offline }
}

// A fresh raw replica of `key` that asks the swarm for single blocks.
async function probe (t, bootstrap, assocHex, key) {
  const store = new Corestore(tmpDir(t, 'varanda-probe-'))
  await store.ready()
  const core = store.get({ key: b4a.from(key, 'hex') })
  await core.ready()
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    attachAdmission(socket, { role: 'member', have: [], onmessage: () => {} })
  })
  let closing = null
  const close = () => {
    if (closing === null) closing = swarm.destroy().then(() => store.close())
    return closing
  }
  t.teardown(close, { force: true })
  await joinAndFlush(swarm, [topicFor(assocHex), core.discoveryKey])
  const fetch = async (seq, timeout) => {
    try {
      return await core.get(seq, { timeout })
    } catch {
      return null
    }
  }
  return { fetch, close }
}

// The probe gets the later blocks (so it reached a holder) and never the
// deleted one.
async function probeServes (t, bootstrap, assocHex, key, { later, deleted }, label) {
  const p = await probe(t, bootstrap, assocHex, key)
  try {
    for (const seq of later) t.ok(await p.fetch(seq, 30000), label + ': block ' + seq + ' is served')
    t.is(await p.fetch(deleted, 3000), null, label + ': the deleted block ' + deleted + ' is not served')
  } finally {
    await p.close()
  }
}

test('deleted bytes stay gone across restarts, a stale peer and a fresh follower; later blocks keep flowing', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const sDir = seederDir(t, assoc)
  let s = await startSeeder(t, bootstrap, sDir)

  const a = await member(t, bootstrap, assoc)
  await a.call('profile.set', { name: 'Ana' })
  const post = await a.call('post.create', { text: 'apagar' })
  const keep = await a.call('post.create', { text: 'fica' })
  t.alike([post.seq, keep.seq], [2, 3])
  await syncOnce(t, a, 'author sync')
  await until(() => seederLength(s.seeder, a.publicKey) === 4, { timeoutMs: 60000, name: 'the seeder holds 4' })

  const c = await stalePeer(t, bootstrap, assoc.hex, a.publicKey)
  await until(() => c.core.contiguousLength === 4, { timeoutMs: 60000, name: 'the stale peer holds 4' })

  let b = await member(t, bootstrap, assoc)
  await b.call('follow.add', { key: a.publicKey })
  await followerSync(t, b, a.publicKey, 4, 'follower first sync')
  t.ok((await inspect(b.dataDir, a.publicKey, 2)).held, 'the follower holds block 2')

  const d = await a.call('post.delete', { to: post.ref })
  t.alike([d.seq, d.deleted], [4, [2]])
  await syncOnce(t, a, 'author sync after delete')
  await until(async () => seederLength(s.seeder, a.publicKey) === 5 && !(await seederHolds(s.seeder, a.publicKey, 2)), { timeoutMs: 60000, name: 'the seeder cleared block 2' })
  await until(() => c.core.contiguousLength === 5, { timeoutMs: 60000, name: 'the stale peer holds the tombstone' })
  t.ok(await c.core.has(2), 'the stale peer keeps block 2')

  await followerSync(t, b, a.publicKey, 5, 'follower sync after delete')
  const cleared = await inspect(b.dataDir, a.publicKey, 2)
  t.absent(cleared.held, 'the follower cleared block 2')
  t.ok(cleared.entries[2].deleted, 'and reads it as deleted')
  {
    // The probe does get a block someone still holds.
    const p = await probe(t, bootstrap, assoc.hex, a.publicKey)
    t.ok(await p.fetch(2, 30000), 'control: the stale peer serves block 2 to the probe')
    await p.close()
  }
  await c.offline()

  // Seeder down, stale peer and author offline: the restarted follower is
  // the only holder.
  await s.seeder.close()
  b = await reopen(t, bootstrap, assoc, b)
  await b.call('sync.start')
  await probeServes(t, bootstrap, assoc.hex, a.publicKey, { later: [3, 4], deleted: 2 }, 'restarted follower')
  await b.call('sync.stop')

  s = await startSeeder(t, bootstrap, sDir)
  t.absent(await seederHolds(s.seeder, a.publicKey, 2), 'the restarted seeder still lacks block 2')
  await probeServes(t, bootstrap, assoc.hex, a.publicKey, { later: [3, 4], deleted: 2 }, 'restarted seeder')

  // The stale peer comes back with block 2; the author writes on.
  await c.online()
  const later = await a.call('post.create', { text: 'depois' })
  t.is(later.seq, 5)
  await syncOnce(t, a, 'author sync after the restart')
  await until(() => seederLength(s.seeder, a.publicKey) === 6, { timeoutMs: 60000, name: 'the seeder holds 6' })
  await until(() => c.core.contiguousLength === 6, { timeoutMs: 60000, name: 'the stale peer holds 6' })
  await followerSync(t, b, a.publicKey, 6, 'follower sync with the stale peer back')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.ok(await c.core.has(2), 'the stale peer still offers block 2')
  t.absent(await seederHolds(s.seeder, a.publicKey, 2), 'the seeder never fetched it back')
  const after = await inspect(b.dataDir, a.publicKey, 2)
  t.absent(after.held, 'the follower never fetched it back')
  t.is(after.length, 6)
  t.alike(postTexts(await b.call('feed.read'), a.publicKey), [[3, 'fica'], [5, 'depois']], 'the follower shows the later post, not the deleted one')
  const log = await b.call('log.read', { author: a.publicKey })
  t.ok(log.entries.some((e) => e.seq === 4 && e.record.type === 'delete'), 'the tombstone is readable')
  t.ok(log.invalid.some((e) => e.seq === 2 && e.reason === 'deleted'), 'the hole reads as deleted')

  // A fresh follower, author offline: the seeder and the stale peer are the
  // only sources, one of them holding block 2.
  const f = await member(t, bootstrap, assoc)
  await f.call('follow.add', { key: a.publicKey })
  await followerSync(t, f, a.publicKey, 6, 'fresh follower sync')
  const fresh = await inspect(f.dataDir, a.publicKey, 2)
  t.absent(fresh.held, 'the fresh follower does not keep block 2 after its scan')
  t.is(fresh.length, 6)
  t.ok(fresh.entries[2].deleted, 'it reads it as deleted')
  t.alike(postTexts(await f.call('feed.read'), a.publicKey), [[3, 'fica'], [5, 'depois']])

  // A forged tombstone: another member's diary naming the author's seq 3,
  // and invalid in that diary too (its target is past its own seq).
  const e = await member(t, bootstrap, assoc)
  await e.call('post.create', { text: 'e1' })
  t.is(await appendRaw(e.dataDir, deleteRecord({ seq: 3 })), 2)
  await syncOnce(t, e, 'forger sync')
  await b.call('follow.add', { key: e.publicKey })
  await followerSync(t, b, e.publicKey, 3, 'follower sync of the forger')
  await until(() => seederLength(s.seeder, e.publicKey) === 3, { timeoutMs: 60000, name: 'the seeder holds the forged tombstone' })
  const feed = await b.call('feed.read')
  t.alike(postTexts(feed, a.publicKey), [[3, 'fica'], [5, 'depois']], 'the author\'s post 3 is still shown')
  t.alike(postTexts(feed, e.publicKey), [[1, 'e1']], 'the forger\'s own post is not deleted either')
  t.ok((await inspect(b.dataDir, a.publicKey, 3)).held, 'the follower keeps the bytes of block 3')
  t.ok((await inspect(b.dataDir, e.publicKey, 1)).held, 'and of the forger\'s block 1')
  t.ok(await seederHolds(s.seeder, a.publicKey, 3), 'the seeder keeps block 3')
  t.ok(await s.seeder.postBlock(a.publicKey, 3), 'and serves it')

  for (const m of [a, b, f, e]) t.alike(m.session.internal, [], 'no internal error')
})

test('a truncate is still a fork on the seeder and the follower', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assocHex = hex(kp.publicKey)
  const sDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(sDir, assocHex)
  const { publicKey: seederKey } = Seeder.createKey(sDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, kp)))
  Seeder.addCert(sDir, certFile, assocHex)
  const s = await startSeeder(t, bootstrap, sDir)

  // A fresh raw test diary with a deleted and cleared block.
  const store = new Corestore(tmpDir(t, 'varanda-raw-'))
  await store.ready()
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const cert = createCert({ member: key }, kp)
  await diary.append(memberCertRecord(cert))
  await diary.append(postRecord({ text: 'um' }))
  await diary.append(postRecord({ text: 'dois' }))
  await diary.append(deleteRecord({ seq: 1 }))
  await diary.clear(1, 2)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(async () => {
    await swarm.destroy()
    await store.close()
  }, { force: true })
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: () => {} }))
  })
  await joinAndFlush(swarm, [topicFor(assocHex), diary.discoveryKey])
  const seederPeer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { timeoutMs: 30000, name: 'hello do semeador' })
  seederPeer.send({ type: 'announce', key, cert })
  await until(() => seederLength(s.seeder, key) === 4, { timeoutMs: 60000, name: 'the seeder holds 4' })
  t.absent(await seederHolds(s.seeder, key, 1), 'the seeder never holds the deleted block')

  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assocHex, bootstrap })
  const b = await connect(t, session)
  const { publicKey } = await b.call('identity.create')
  await b.call('cert.add', { cert: createCert({ member: publicKey }, kp) })
  await b.call('follow.add', { key })
  await b.call('sync.start')
  await until(() => eventOf(b, 'sync.event', (d) => d.line === 'downloaded ' + key + ' 4'), { timeoutMs: 60000, name: 'downloaded 4' })

  await diary.truncate(2, { fork: 1 })
  await diary.append(postRecord({ text: 'reescrito' }))
  await until(() => s.events.find((e) => e.event === 'rejected' && e.key === key && e.reason === 'fork'), { timeoutMs: 60000, name: 'seeder fork' })
  t.pass('the seeder rejected the fork')
  const fork = 'aviso: diário ' + key.slice(0, 8) + ' ignorado (fork)'
  await until(() => eventOf(b, 'warning', (d) => d.line === fork), { timeoutMs: 60000, name: 'follower fork warning' })
  t.pass('the follower reported the fork')
  await b.call('sync.stop')
  t.absent(postTexts(await b.call('feed.read'), key).some(([, text]) => text === 'reescrito'), 'the rewritten history is never shown')
  t.alike(session.internal, [], 'no internal error')
})

test('with the kill switch (VARANDA_NO_CLEAR=1) the bytes stay on the seeder and the follower, the post stays hidden', async (t) => {
  t.timeout(300000)
  const before = process.env.VARANDA_NO_CLEAR
  process.env.VARANDA_NO_CLEAR = '1'
  t.teardown(() => {
    if (before === undefined) delete process.env.VARANDA_NO_CLEAR
    else process.env.VARANDA_NO_CLEAR = before
  }, { order: Infinity })
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const s = await startSeeder(t, bootstrap, seederDir(t, assoc))

  const a = await member(t, bootstrap, assoc)
  await a.call('profile.set', { name: 'Ana' })
  const post = await a.call('post.create', { text: 'guardado' })
  await a.call('post.create', { text: 'fica' })
  await syncOnce(t, a, 'author sync')
  const b = await member(t, bootstrap, assoc)
  await b.call('follow.add', { key: a.publicKey })
  await followerSync(t, b, a.publicKey, 4, 'follower first sync')

  await a.call('post.delete', { to: post.ref })
  await syncOnce(t, a, 'author sync after delete')
  await until(() => seederLength(s.seeder, a.publicKey) === 5, { timeoutMs: 60000, name: 'the seeder holds the tombstone' })
  await followerSync(t, b, a.publicKey, 5, 'follower sync after delete')

  t.ok(await seederHolds(s.seeder, a.publicKey, 2), 'the seeder keeps the bytes')
  t.is(await s.seeder.postBlock(a.publicKey, 2), null, 'but postBlock refuses the deleted seq')
  const kept = await inspect(b.dataDir, a.publicKey, 2)
  t.ok(kept.held, 'the follower keeps the bytes')
  t.ok(kept.entries[2].deleted, 'and reads the block as deleted')
  t.alike(postTexts(await b.call('feed.read'), a.publicKey), [[3, 'fica']], 'the feed hides the deleted post')
  t.alike(postTexts(await a.call('feed.read'), a.publicKey), [[3, 'fica']], 'on the author\'s node too')
  for (const m of [a, b]) t.alike(m.session.internal, [], 'no internal error')
})
