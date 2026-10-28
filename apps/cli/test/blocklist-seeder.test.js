// The seeder enforces the signed moderation snapshot (B2): it stores the
// newest one it accepts, drops and refuses blocked diaries (and diaries
// certified by a revoked issuer), and passes the snapshot on to every peer
// that speaks 'varanda/blocklist/1' while peers from before B2 stay connected.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const {
  createCert,
  createSeederCert,
  createIssuerCert,
  createIssuedCert,
  createModeratorCert,
  generateAssociationKeyPair
} = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { writeBlocklist } = require('@varanda/core/lib/store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function post (text) {
  return { type: 'post', text, at: new Date().toISOString(), replyTo: null }
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function makeModerator (assoc, date) {
  const kp = signingKeyPair()
  return { kp, cert: createModeratorCert({ moderator: hex(kp.publicKey), date }, assoc.kp) }
}

function snapshot (mod, seq, { blocked = [], revokedIssuers = [] } = {}) {
  return createSnapshot({ seq, blocked, revokedIssuers }, mod.kp, mod.cert)
}

function makeIssuer (assoc) {
  const kp = signingKeyPair()
  return { kp, cert: createIssuerCert({ issuer: hex(kp.publicKey) }, assoc.kp), hex: hex(kp.publicKey) }
}

// v1 (association-signed) blocks, or v2 blocks when an issuer is given.
function blocksFor (assoc, issuer = null) {
  const certOf = (key) => issuer ? createIssuedCert({ member: key }, issuer.kp, issuer.cert) : createCert({ member: key }, assoc.kp)
  return (key) => [memberCertRecord(certOf(key)), post('um'), post('dois')]
}

function readAdmitted (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8')).admitted
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

function readStoredSnapshot (dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'blocklist.json'), 'utf8')).snapshot
}

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  const ready = await seeder.start()
  return { seeder, events, ready }
}

// A raw node on the association topic. With `blocks` it authors a diary;
// with `blocklist` it also speaks 'varanda/blocklist/1', holding
// blocklist.snapshot (which it pushes to any peer holding an older one) and
// recording every snapshot offered to it. Without `blocklist` it is a node
// from before B2: admission only.
async function client (t, bootstrap, assoc, { blocks = null, blocklist = null, follow = null, joinPeer = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  let core = null
  let key = null
  if (blocks) {
    core = store.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    key = hex(core.key)
    for (const b of blocks(key)) await core.append(b)
  } else if (follow) {
    core = store.get({ key: b4a.from(follow, 'hex') })
    await core.ready()
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const messages = []
  const peers = []
  const handles = []
  const received = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    if (blocklist) {
      handles.push(attachBlocklist(socket, {
        current: () => blocklist.snapshot,
        offer: async (s) => {
          received.push(s)
          return { adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() }
        }
      }))
    }
    const have = key ? [{ key, length: core.length }] : []
    peers.push(attachAdmission(socket, { role: 'member', have, onmessage: (msg) => messages.push(msg) }))
  })
  if (joinPeer) swarm.joinPeer(b4a.from(joinPeer, 'hex'))
  else await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name, timeoutMs = 20000) => until(() => messages.find(pred), { name, timeoutMs })
  return { store, swarm, core, key, messages, peers, handles, received, seederPeer, message }
}

async function admit (author, cert) {
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert })
  await author.message((m) => m.type === 'have' && m.key === author.key && m.length === 3, 'have 3')
  return peer
}

// Records every offer verdict the seeder reaches (test-only spy on its
// blocklist state: attachBlocklist calls state.offer through the seeder).
function spyOffers (seeder) {
  const verdicts = []
  const offer = seeder._blocklist.offer
  seeder._blocklist.offer = (s) => offer(s).then((r) => {
    verdicts.push(r)
    return r
  })
  return verdicts
}

function nothingWithin (core, ms) {
  return core.get(0, { timeout: ms }).then(() => false, () => true)
}

test('a snapshot drops and refuses a blocked diary; a forged one does nothing; an unblock lets it back', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  let gates = 0
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    gateHook: async () => { gates++ }
  })
  const verdicts = spyOffers(seeder)
  t.alike({ blocked: seeder.stats().blocked, blocklistSeq: seeder.stats().blocklistSeq }, { blocked: 0, blocklistSeq: 0 })

  const author = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc) })
  const cert = createCert({ member: author.key }, assoc.kp)
  const authorPeer = await admit(author, cert)
  t.alike(seeder.admittedKeys(), [author.key])
  t.is(gates, 1)

  // Forged: a moderator certified by another association. The moderator
  // clients dial the seeder only (joinPeer), so whatever they receive came
  // through the seeder.
  const forger = makeModerator(makeAssociation(), '2026-01-01T00:00:00.000Z')
  const forged = await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snapshot(forger, 9, { blocked: [author.key] }) } })
  await until(() => verdicts.some((v) => v.reason === 'bad-moderator-signature'), { name: 'snapshot forjado recusado' })
  t.alike(seeder.admittedKeys(), [author.key], 'a forged snapshot drops nothing')
  t.is(seeder.stats().blocklistSeq, 0)
  t.absent(fs.existsSync(path.join(dataDir, 'blocklist.json')))

  // Valid: the diary is dropped (rejected 'blocked', purged, un-listed).
  const mod = makeModerator(assoc, '2026-06-01T00:00:00.000Z')
  const block = snapshot(mod, 1, { blocked: [author.key] })
  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: block } })
  await author.message((m) => m.type === 'rejected' && m.key === author.key && m.reason === 'blocked', 'rejected blocked')
  await until(async () => seeder.stats().dropping === 0 && !(author.key in readAdmitted(dataDir)) && !(await seeder._stored(author.key)), { name: 'purgado' })
  t.ok(events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'blocked'))
  t.ok(events.some((e) => e.event === 'blocklist' && e.seq === 1))
  t.alike(seeder.admittedKeys(), [])
  t.alike(readStoredSnapshot(dataDir), block, 'blocklist.json holds the adopted snapshot')
  t.absent(JSON.stringify(readAdmitted(dataDir)).includes(block.signature), 'the snapshot is not in admitted.json')
  t.is(seeder.stats().blocked, 1)
  t.is(seeder.stats().blocklistSeq, 1)
  // C4 fan-out: the forger's connection is told the newer snapshot.
  await until(() => forged.received.some((s) => s.signature === block.signature), { name: 'repasse ao outro par' })

  // A further announce is refused before any fetch.
  const before = author.messages.filter((m) => m.type === 'rejected' && m.reason === 'blocked').length
  authorPeer.send({ type: 'announce', key: author.key, cert })
  await until(() => author.messages.filter((m) => m.type === 'rejected' && m.reason === 'blocked').length > before, { name: 'novo rejected blocked' })
  t.is(gates, 1, 'no quarantine fetch for a blocked key')
  t.alike(seeder.admittedKeys(), [])

  // Unblock: nothing is re-admitted by itself; the next announce passes.
  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snapshot(mod, 2) } })
  await until(() => seeder.stats().blocklistSeq === 2, { name: 'seq 2' })
  t.is(seeder.stats().blocked, 0)
  t.alike(seeder.admittedKeys(), [], 'no re-admission on unblock')
  const admittedBefore = author.messages.filter((m) => m.type === 'admitted' && m.key === author.key).length
  authorPeer.send({ type: 'announce', key: author.key, cert })
  await until(() => author.messages.filter((m) => m.type === 'admitted' && m.key === author.key).length > admittedBefore, { name: 'admitted de novo' })
  await until(() => seeder.admittedKeys().includes(author.key), { name: 'admitido de novo' })
  t.is(gates, 2)
})

test('restart keeps the snapshot and purges blocked and revoked-issuer diaries in step 3 without serving them', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuer = makeIssuer(assoc)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const blockedAuthor = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc) })
  const revokedAuthor = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc, issuer) })
  const keptAuthor = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc) })
  await admit(blockedAuthor, createCert({ member: blockedAuthor.key }, assoc.kp))
  await admit(revokedAuthor, createIssuedCert({ member: revokedAuthor.key }, issuer.kp, issuer.cert))
  await admit(keptAuthor, createCert({ member: keptAuthor.key }, assoc.kp))
  t.is(first.seeder.admittedKeys().length, 3)
  await first.seeder.close()
  for (const c of [blockedAuthor, revokedAuthor, keptAuthor]) await c.swarm.destroy()

  // Written while the seeder is stopped (as an earlier run would have).
  const mod = makeModerator(assoc)
  const snap = snapshot(mod, 5, { blocked: [blockedAuthor.key], revokedIssuers: [issuer.hex] })
  writeBlocklist(dataDir, snap)

  const second = await startSeeder(t, bootstrap, dataDir)
  const readyAt = second.events.findIndex((e) => e.event === 'ready')
  const reasonOf = (key) => {
    const i = second.events.findIndex((e) => e.event === 'rejected' && e.key === key)
    t.ok(i >= 0 && i < readyAt, 'dropped before ready: ' + key.slice(0, 8))
    return second.events[i] && second.events[i].reason
  }
  t.is(reasonOf(blockedAuthor.key), 'blocked')
  t.is(reasonOf(revokedAuthor.key), 'revoked-issuer')
  t.alike(second.ready.admitted, [keptAuthor.key])
  t.alike(Object.keys(readAdmitted(dataDir)), [keptAuthor.key])
  t.is(second.seeder.stats().blocklistSeq, 5, 'the stored snapshot is kept')
  t.is(second.seeder.stats().blocked, 1)
  t.absent(await second.seeder._stored(blockedAuthor.key))
  t.absent(await second.seeder._stored(revokedAuthor.key))

  // The restarted seeder also refuses a fresh announce from the stored
  // snapshot (blocklist.json is the { v, snapshot } wrapper: a load that
  // did not unwrap it would fail open here).
  const sent = []
  const fakePeer = { peerKey: null, socket: { destroy () {} }, send: (m) => sent.push(m) }
  await second.seeder.admit(blockedAuthor.key, createCert({ member: blockedAuthor.key }, assoc.kp), fakePeer)
  await second.seeder.admit(revokedAuthor.key, createIssuedCert({ member: revokedAuthor.key }, issuer.kp, issuer.cert), fakePeer)
  t.alike(sent, [
    { type: 'rejected', key: blockedAuthor.key, reason: 'blocked' },
    { type: 'rejected', key: revokedAuthor.key, reason: 'revoked-issuer' }
  ], 'refused after restart')
  t.absent(fakePeer.seederDropped)

  const reader = await client(t, bootstrap, assoc, { follow: blockedAuthor.key, joinPeer: publicKey })
  await reader.seederPeer()
  t.ok(await nothingWithin(reader.core, 3000), 'a blocked replica is never served')
})

test('a torn blocklist.json warns once, is kept aside and the snapshot comes back from a peer', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const file = path.join(dataDir, 'blocklist.json')
  const mod = makeModerator(assoc)
  const snap = snapshot(mod, 4, { blocked: ['c'.repeat(64)] })
  writeBlocklist(dataDir, snap)
  const whole = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, whole.slice(0, whole.length >> 1))

  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const warnings = events.filter((e) => e.event === 'warning' && e.reason === 'blocklist-unreadable')
  t.is(warnings.length, 1, 'one warning')
  t.is(seeder.stats().blocklistSeq, 0, 'nothing enforced yet')
  const kept = fs.readdirSync(dataDir).filter((n) => n.startsWith('blocklist.json.ilegivel-'))
  t.alike(kept, [warnings[0].aside], 'the torn copy is kept aside')
  t.absent(fs.existsSync(file), 'the torn file is out of the way')

  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snap } })
  await until(() => seeder.stats().blocklistSeq === 4, { name: 'seq 4 de volta' })
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, snapshot: snap }, 'stored again')
  t.is(events.filter((e) => e.reason === 'blocklist-unreadable').length, 1, 'no second warning')
})

test('an admission-only peer stays connected; a newer peer receives the snapshot; a revocation drops a v2 diary', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuer = makeIssuer(assoc)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A node from before B2 (no blocklist channel) authoring a v2 diary.
  const old = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc, issuer) })
  const v2cert = createIssuedCert({ member: old.key }, issuer.kp, issuer.cert)
  const oldPeer = await admit(old, v2cert)
  // A newer node holding nothing yet.
  const newer = await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: null } })
  await newer.seederPeer()

  // The moderator client dials the seeder only: the newer node can receive
  // the snapshot through the seeder alone (C4 fan-out).
  const mod = makeModerator(assoc)
  const snap = snapshot(mod, 1, { revokedIssuers: [issuer.hex] })
  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snap } })
  await until(() => seeder.stats().blocklistSeq === 1, { name: 'seq 1' })
  await until(() => newer.received.some((s) => s.signature === snap.signature), { name: 'snapshot repassado' })

  // The revocation drops the v2-certified diary and refuses its certificate.
  await old.message((m) => m.type === 'rejected' && m.key === old.key && m.reason === 'revoked-issuer', 'rejected revoked-issuer')
  await until(() => !(old.key in readAdmitted(dataDir)) && seeder.stats().dropping === 0, { name: 'purgado' })
  t.ok(events.some((e) => e.event === 'rejected' && e.key === old.key && e.reason === 'revoked-issuer'))
  oldPeer.send({ type: 'announce', key: old.key, cert: v2cert })
  await until(() => old.messages.filter((m) => m.type === 'rejected' && m.reason === 'revoked-issuer').length >= 2, { name: 'anúncio recusado' })

  t.absent(oldPeer.socket.destroyed, 'the admission-only peer stays connected')
  t.ok(seeder._peers.size >= 3)
  t.alike(seeder.admittedKeys(), [])
})

test('a revocation sweep that cannot read block 0 drops the diary (fail closed)', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuer = makeIssuer(assoc)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const author = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc, issuer) })
  const v2cert = createIssuedCert({ member: author.key }, issuer.kp, issuer.cert)
  await admit(author, v2cert)
  const entry = seeder._served.get(author.key)
  t.ok(entry && entry.gated, 'the v2 diary is served and gated')

  // The next block-0 read fails once (a transient storage error).
  const get = entry.core.get.bind(entry.core)
  let failed = 0
  entry.core.get = (...args) => {
    if (failed++ === 0) return Promise.reject(new Error('leitura falhou'))
    return get(...args)
  }

  const mod = makeModerator(assoc)
  const snap = snapshot(mod, 1, { revokedIssuers: [issuer.hex] })
  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snap } })
  await until(() => seeder.stats().blocklistSeq === 1, { name: 'seq 1' })

  await until(() => !(author.key in readAdmitted(dataDir)) && seeder.stats().dropping === 0, { name: 'purgado' })
  t.ok(failed >= 1, 'the sweep hit the failing read')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === author.key), 'the diary is dropped, not kept gated')
  t.absent(seeder._served.has(author.key), 'no longer served')
})

test('C6: a snapshot adopted while an admission is in flight refuses it and un-lists the key', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  let release
  const held = new Promise((resolve) => { release = resolve })
  let reachedOpen = false
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    admitHook: async (key, step) => {
      if (step !== 'open') return
      reachedOpen = true
      await held
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: createCert({ member: author.key }, assoc.kp) })
  await until(() => reachedOpen, { name: 'admissão em andamento' })
  t.ok(author.key in readAdmitted(dataDir), 'listed before the open step')

  const mod = makeModerator(assoc)
  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snapshot(mod, 1, { blocked: [author.key] }) } })
  await until(() => seeder.stats().blocklistSeq === 1, { name: 'seq 1' })
  release()

  // Checked in the seeder's log: the announcer's connection may have been
  // replaced by a duplicate (hyperswarm de-duplication) while it was held.
  await until(() => events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'blocked'), { name: 'rejected blocked' })
  await until(() => !(author.key in readAdmitted(dataDir)), { name: 'fora do admitted.json' })
  t.absent(await seeder._stored(author.key), 'purged')
  t.alike(seeder.admittedKeys(), [])
  t.absent(events.some((e) => e.event === 'admitted'), 'never admitted')
})

test('a revocation adopted while a block-0 verdict is in flight drops the diary instead of gating it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuer = makeIssuer(assoc)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  let release
  const held = new Promise((resolve) => { release = resolve })
  let heldKey = null
  const verdicts = []
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, {
    associationKey: assoc.hex,
    // The first local verdict (computed with no revoked issuer) is held
    // after it is computed and before it is applied.
    regateHook: async (key, reason) => {
      verdicts.push(reason)
      if (heldKey !== null) return
      heldKey = key
      await held
    }
  })

  const author = await client(t, bootstrap, assoc, { blocks: blocksFor(assoc, issuer) })
  const peer = await author.seederPeer()
  peer.send({ type: 'announce', key: author.key, cert: createIssuedCert({ member: author.key }, issuer.kp, issuer.cert) })
  await until(() => heldKey === author.key, { name: 'veredito em andamento' })
  t.alike(verdicts, [null], 'the held verdict is a pass computed before the revocation')

  const mod = makeModerator(assoc)
  await client(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot: snapshot(mod, 1, { revokedIssuers: [issuer.hex] }) } })
  await until(() => seeder.stats().blocklistSeq === 1, { name: 'seq 1' })
  release()

  await until(() => events.some((e) => e.event === 'rejected' && e.key === author.key && e.reason === 'revoked-issuer'), { name: 'rejected revoked-issuer' })
  await until(async () => seeder.stats().dropping === 0 && !(author.key in readAdmitted(dataDir)) && !(await seeder._stored(author.key)), { name: 'purgado' })
  t.alike(verdicts, [null, 'revoked-issuer'], 'the gate ran again with the adopted snapshot')
  t.alike(seeder.admittedKeys(), [])
  t.absent(events.some((e) => e.event === 'have' && e.key === author.key), 'no have was broadcast for it')
  t.absent(author.messages.some((m) => m.type === 'have' && m.key === author.key && m.length > 0), 'no have reached the author')
})
