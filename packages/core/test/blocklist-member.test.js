'use strict'

// B2 enforcement on the core member node (lib/sync.js and lib/member.js) on
// an in-process loopback testnet: members that sync directly, a raw peer
// that speaks only 'varanda/blocklist/1' (plus the admission channel every
// connection needs) and a raw Corestore node that asks a member for a diary
// by key. One scenario, in order, because each phase builds on the stored
// state of the previous one (a restart over the same data dir included).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { tmpDir } = require('./helpers/tmp')
const { testnet, localSwarmOptions, until, newSession, connect, failure } = require('./helpers/net')
const { runSync } = require('../lib/sync')
const member = require('../lib/member')
const {
  openStore,
  openDiary,
  readAll,
  appendRecord,
  writeConfig,
  writeFollows,
  readFollows,
  readBlocklist,
  writeBlocklist,
  purgeReplica,
  replicaStored
} = require('../lib/store')
const { memberCertRecord, profileRecord, postRecord } = require('../lib/records')
const { createCert, createIssuerCert, createIssuedCert, createModeratorCert, generateAssociationKeyPair } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { attachBlocklist } = require('../lib/blocklist-net')
const { createSwarm, topicFor, joinAndFlush, attachAdmission } = require('../lib/net')

const MOD_DATE = '2026-01-01T00:00:00.000Z'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// A member data dir: config.json, block 0 = a v1 member cert, a profile and
// `posts` posts (default 2: length 4); with `issuer` ({ keyPair, cert })
// block 0 is a v2 certificate from that issuer. The store is closed on return.
async function makeMember (t, kp, issuer = null, posts = 2) {
  const dir = tmpDir(t, 'varanda-blm-')
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
    const cert = issuer ? createIssuedCert({ member: key }, issuer.keyPair, issuer.cert) : createCert({ member: key }, kp)
    await appendRecord(diary, memberCertRecord(cert))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    for (let i = 0; i < posts; i++) await appendRecord(diary, postRecord({ text: 'post ' + i }))
    return { dir, key }
  } finally {
    await store.close()
  }
}

async function stored (dir, key) {
  const store = await openStore(dir)
  try {
    return await replicaStored(store, key)
  } finally {
    await store.close()
  }
}

async function ownLength (dir) {
  const store = await openStore(dir)
  try {
    return (await readAll(await openDiary(store))).length
  } finally {
    await store.close()
  }
}

// A raw node on the association rendezvous: every connection gets
// store.replicate, then (unless `blocklist` is null) a blocklist channel that
// holds `blocklist()` and refuses every incoming snapshot, then an admission
// channel (without it the member destroys the socket).
async function rawNode (t, bootstrap, association, { blocklist = null, open = [] } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-blraw-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const cores = []
  for (const key of open) {
    const core = store.get({ key: b4a.from(key, 'hex') })
    await core.ready()
    cores.push(core)
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const handles = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    if (blocklist) {
      handles.push(attachBlocklist(socket, {
        current: blocklist,
        offer: async () => ({ adopted: false, reason: 'same' })
      }))
    }
    attachAdmission(socket, { role: 'member', have: [], onmessage: () => {}, onclose: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(association)])
  return { store, swarm, cores, handles }
}

// A long-running sync with an abort handle, its events, logs and purges.
function longRun (t, bootstrap, dir) {
  const controller = new AbortController()
  const events = []
  const logs = []
  const purged = []
  const done = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: dir,
    signal: controller.signal,
    log: (line) => logs.push(line),
    onEvent: (ev) => events.push(ev),
    purgeHook: async (key, store) => {
      await purgeReplica(store, key)
      purged.push(key)
    }
  })
  t.teardown(() => controller.abort(), { force: true })
  return { done, events, logs, purged, stop: () => { controller.abort(); return done } }
}

function onceRun (bootstrap, dir, extra = {}) {
  const events = []
  const logs = []
  const result = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: dir,
    once: true,
    timeoutMs: 30000,
    log: (line) => logs.push(line),
    onEvent: (ev) => events.push(ev),
    ...extra
  })
  return { result, events, logs }
}

const storedSeq = (dir) => {
  const d = readBlocklist(dir)
  return d === null ? null : d.snapshot.seq
}

test('a member stores, enforces and relays the blocklist snapshot', async (t) => {
  t.timeout(175000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, kp)

  const alice = await makeMember(t, kp)
  const bob = await makeMember(t, kp)
  const eve = await makeMember(t, kp) // keeps an unfollowed replica of Alice
  writeFollows(bob.dir, [alice.key])
  writeFollows(eve.dir, [alice.key])

  const block1 = createSnapshot({ seq: 1, date: MOD_DATE, blocked: [alice.key] }, modKp, modCert)
  const unblock2 = createSnapshot({ seq: 2, date: MOD_DATE, blocked: [] }, modKp, modCert)
  // Signed for seq 6, claims seq 7: a forged snapshot that would unblock.
  const forged = { ...createSnapshot({ seq: 6, date: MOD_DATE, blocked: [] }, modKp, modCert), seq: 7 }

  // 1. Without any blocklist.json, Bob and Eve fetch Alice's diary.
  {
    // Alice is announced on the DHT before the followers look her up.
    const aliceRun = longRun(t, bootstrap, alice.dir)
    await until(() => aliceRun.events.some((ev) => ev.event === 'ready'), { timeoutMs: 30000, name: 'Alice ready' })
    const runs = [onceRun(bootstrap, bob.dir), onceRun(bootstrap, eve.dir)]
    const [rb, re] = await Promise.all(runs.map((r) => r.result))
    const ra = await aliceRun.stop()
    t.ok(ra.ok && rb.ok && re.ok, 'first sync ok ' + JSON.stringify([ra.errors, rb.errors, re.errors]))
    t.is(rb.downloaded[alice.key], 4, 'Bob holds Alice')
    t.is(re.downloaded[alice.key], 4, 'Eve holds Alice')
    t.is(readBlocklist(bob.dir), null, 'no snapshot yet')
  }

  // 2. A raw peer hands Bob a snapshot blocking Alice: Bob adopts it, skips
  //    and purges Alice, keeps the follow, and no longer serves her diary.
  {
    const moderator = await rawNode(t, bootstrap, association, { blocklist: () => block1 })
    const bobRun = longRun(t, bootstrap, bob.dir)
    await until(() => storedSeq(bob.dir) === 1, { timeoutMs: 30000, name: 'Bob stores seq 1' })
    await until(() => bobRun.purged.includes(alice.key), { timeoutMs: 30000, name: 'Bob purges Alice' })
    t.ok(bobRun.events.some((ev) => ev.event === 'skipped' && ev.key === alice.key && ev.reason === 'blocked'), 'skipped event with reason blocked')

    // A third node asks Bob for Alice's diary by key: nothing is served.
    const carol = await rawNode(t, bootstrap, association, { open: [alice.key] })
    await until(() => carol.swarm.connections.size > 0, { timeoutMs: 30000, name: 'Carol connects' })
    let got = null
    try {
      got = await carol.cores[0].get(0, { timeout: 4000 })
    } catch {}
    t.is(got, null, 'Bob does not serve the blocked diary')
    await carol.swarm.destroy()
    await moderator.swarm.destroy()

    const rb = await bobRun.stop()
    t.ok(rb.skipped.some((s) => s.key === alice.key && s.reason === 'blocked'), 'result skipped blocked')
    t.absent(alice.key in rb.downloaded, 'not reported downloaded')
    t.alike(readFollows(bob.dir), [alice.key], 'follows.json intact')
    t.absent(await stored(bob.dir, alice.key), 'replica purged')
  }

  // 3. Restart over the same data dir: Bob enforces the STORED snapshot,
  //    refuses Alice's own advertisement, and relays the snapshot to Alice,
  //    whose own diary is never deleted.
  {
    const aliceRun = longRun(t, bootstrap, alice.dir)
    const bobOnce = onceRun(bootstrap, bob.dir)
    const rb = await bobOnce.result
    t.ok(rb.ok, 'Bob ok ' + JSON.stringify(rb.errors))
    t.alike(rb.skipped, [{ key: alice.key, reason: 'blocked' }], 'stored snapshot enforced after restart')
    t.absent(bobOnce.events.some((ev) => ev.key === alice.key && (ev.event === 'downloaded' || ev.event === 'have')), 'Alice advertisement ignored')
    t.ok(rb.peers >= 1, 'Alice was connected')
    await until(() => storedSeq(alice.dir) === 1, { timeoutMs: 30000, name: 'Alice receives the snapshot' })
    await until(() => aliceRun.logs.includes('aviso: sua identidade está bloqueada pela associação'), { timeoutMs: 10000, name: 'own warning' })
    await aliceRun.stop()
    t.is(aliceRun.logs.filter((l) => l === 'aviso: sua identidade está bloqueada pela associação').length, 1, 'warned once')
    t.absent(aliceRun.purged.includes(alice.key), 'own diary never purged')
    t.is(await ownLength(alice.dir), 4, 'own diary intact')
    t.absent(await stored(bob.dir, alice.key), 'still nothing stored for Alice')
    const own = await member.logRead({ dataDir: alice.dir })
    t.is(own.entries.length, 4, 'log.read of the own blocked diary works')
  }

  // 4. Eve: a stored replica of Alice, no longer followed, and a stored
  //    snapshot. Reads refuse Alice before any run; the next run purges her.
  {
    writeFollows(eve.dir, [])
    writeBlocklist(eve.dir, block1)
    t.ok(await stored(eve.dir, alice.key), 'Eve still holds the unfollowed replica')
    const session = newSession(t, { dataDir: eve.dir, association, bootstrap })
    const link = await connect(t, session)
    t.alike(await failure(link.call('log.read', { author: alice.key })), { code: 'NOT_FOUND', message: 'sem dados locais para este diário' }, 'log.read of the blocked author')
    t.alike(await failure(link.call('follow.add', { key: alice.key })), { code: 'USAGE', message: 'autor bloqueado' }, 'follow.add of the blocked author')
    t.ok(await stored(eve.dir, alice.key), 'reads opened nothing and purged nothing')
    await session.close()

    // The own feed of a member that still follows a blocked author.
    writeFollows(eve.dir, [alice.key])
    const feed = await member.feedRead({ dataDir: eve.dir })
    t.alike(feed.skipped, [{ key: alice.key, reason: 'blocked' }], 'feed skips the blocked author')
    t.absent(feed.items.some((i) => i.author === alice.key), 'no item of the blocked author')
    writeFollows(eve.dir, [])

    const purged = []
    const re = await runSync({
      ...localSwarmOptions(bootstrap),
      dataDir: eve.dir,
      once: true,
      timeoutMs: 2000,
      purgeHook: async (key, store) => {
        await purgeReplica(store, key)
        purged.push(key)
      }
    })
    t.alike(purged, [alice.key], 'the unfollowed replica of the blocked key is purged at startup')
    t.ok(re.errors.includes('sem pares') || re.ok, 'run ends normally')
    t.absent(await stored(eve.dir, alice.key), 'Eve no longer holds Alice')
  }

  // 5. A forged snapshot changes nothing.
  {
    const forger = await rawNode(t, bootstrap, association, { blocklist: () => forged })
    const bobRun = longRun(t, bootstrap, bob.dir)
    await until(() => forger.handles.some((h) => h.remoteHave !== null), { timeoutMs: 30000, name: 'forger hears Bob' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await forger.swarm.destroy()
    await bobRun.stop()
    t.is(storedSeq(bob.dir), 1, 'Bob keeps seq 1')
    t.alike(readBlocklist(bob.dir).snapshot, block1, 'stored snapshot unchanged')
  }

  // 6. A higher snapshot unblocks Alice; a later sync fetches her again and
  //    Bob serves her diary again (control for phase 2).
  {
    const moderator = await rawNode(t, bootstrap, association, { blocklist: () => unblock2 })
    const bobRun = longRun(t, bootstrap, bob.dir)
    await until(() => storedSeq(bob.dir) === 2, { timeoutMs: 30000, name: 'Bob stores seq 2' })
    await moderator.swarm.destroy()
    await bobRun.stop()

    const bobLong = longRun(t, bootstrap, bob.dir)
    const aliceOnce = onceRun(bootstrap, alice.dir)
    await until(() => bobLong.events.some((ev) => ev.event === 'downloaded' && ev.key === alice.key && ev.length === 4), { timeoutMs: 40000, name: 'Bob fetches Alice again' })
    await aliceOnce.result
    t.is(storedSeq(alice.dir), 2, 'Alice received the unblock too')

    const carol = await rawNode(t, bootstrap, association, { open: [alice.key] })
    const block0 = await carol.cores[0].get(0, { timeout: 20000 })
    t.ok(block0, 'Bob serves Alice again once unblocked')
    await carol.swarm.destroy()
    const rb = await bobLong.stop()
    t.alike(rb.skipped, [], 'nothing skipped')
    t.is(rb.downloaded[alice.key], 4)
  }

  t.absent(fs.existsSync(path.join(bob.dir, 'quarantine')), 'quarantine removed')
})

test('a torn blocklist.json warns once, is kept aside and the snapshot comes back from a peer', async (t) => {
  t.timeout(175000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, kp)
  const bob = await makeMember(t, kp)
  const block1 = createSnapshot({ seq: 1, date: MOD_DATE, blocked: ['c'.repeat(64)] }, modKp, modCert)

  const file = path.join(bob.dir, 'blocklist.json')
  writeBlocklist(bob.dir, block1)
  const whole = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, whole.slice(0, whole.length >> 1))
  fs.rmSync(file + '.prev')

  await rawNode(t, bootstrap, association, { blocklist: () => block1 })
  const bobRun = longRun(t, bootstrap, bob.dir)
  await until(() => storedSeq(bob.dir) === 1, { timeoutMs: 30000, name: 'Bob stores seq 1 again' })
  const warnings = bobRun.logs.filter((line) => line.includes('lista de bloqueio ilegível'))
  t.is(warnings.length, 1, 'one warning')
  const kept = fs.readdirSync(bob.dir).filter((n) => n.startsWith('blocklist.json.ilegivel-'))
  t.is(kept.length, 1, 'the torn copy is kept aside')
  t.ok(warnings[0].includes(kept[0]), 'the warning names it')
  t.alike(readBlocklist(bob.dir), { v: 1, snapshot: block1 }, 'the list is stored again')
  await bobRun.stop()
})

test('a torn blocklist.json is read from the copy kept by the last save, with no peer', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, kp)
  const bob = await makeMember(t, kp)
  const block1 = createSnapshot({ seq: 1, date: MOD_DATE, blocked: ['c'.repeat(64)] }, modKp, modCert)

  const file = path.join(bob.dir, 'blocklist.json')
  writeBlocklist(bob.dir, block1)
  const whole = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, whole.slice(0, whole.length >> 1))

  const bobRun = longRun(t, bootstrap, bob.dir)
  await until(() => bobRun.logs.some((line) => line.includes('lista de bloqueio ilegível')), { timeoutMs: 30000, name: 'the unreadable-list warning' })
  t.is(storedSeq(bob.dir), 1, 'Bob has seq 1 back with no peer')
  const warnings = bobRun.logs.filter((line) => line.includes('lista de bloqueio ilegível'))
  t.is(warnings.length, 1, 'one warning')
  t.ok(warnings[0].includes('usando a cópia anterior'), 'it says the copy was used')
  t.is(fs.readdirSync(bob.dir).filter((n) => n.startsWith('blocklist.json.ilegivel-')).length, 1, 'the torn copy is kept aside')
  t.alike(readBlocklist(bob.dir), { v: 1, snapshot: block1 }, 'the list is stored again')
  await bobRun.stop()
})

test('a newly revoked issuer drops the followed diaries it certified', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, kp)
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuer = { keyPair: issuerKp, cert: createIssuerCert({ issuer: issuerHex }, kp) }

  const dana = await makeMember(t, kp, issuer) // v2, from the issuer to revoke
  const bob = await makeMember(t, kp)
  writeFollows(bob.dir, [dana.key])

  const danaRun = longRun(t, bootstrap, dana.dir)
  await until(() => danaRun.events.some((ev) => ev.event === 'ready'), { timeoutMs: 30000, name: 'Dana ready' })
  const rb = await onceRun(bootstrap, bob.dir).result
  await danaRun.stop()
  t.ok(rb.ok, 'Bob ok ' + JSON.stringify(rb.errors))
  t.is(rb.downloaded[dana.key], 4, 'Bob holds the v2 diary')

  // An active follow, then a snapshot that revokes its issuer arrives.
  const revoke = createSnapshot({ seq: 1, date: MOD_DATE, revokedIssuers: [issuerHex] }, modKp, modCert)
  const moderator = await rawNode(t, bootstrap, association, { blocklist: () => revoke })
  const bobRun = longRun(t, bootstrap, bob.dir)
  await until(() => storedSeq(bob.dir) === 1, { timeoutMs: 30000, name: 'Bob stores the revocation' })
  await until(() => bobRun.purged.includes(dana.key), { timeoutMs: 30000, name: 'Bob purges Dana' })
  await moderator.swarm.destroy()
  const r2 = await bobRun.stop()
  t.ok(r2.skipped.some((s) => s.key === dana.key && s.reason === 'revoked-issuer'), 'skipped revoked-issuer')
  t.absent(await stored(bob.dir, dana.key), 'replica purged')
  t.alike(readFollows(bob.dir), [dana.key], 'follows.json intact')

  // The next run refuses the diary at its gate, and the feed skips it.
  const danaAgain = longRun(t, bootstrap, dana.dir)
  await until(() => danaAgain.events.some((ev) => ev.event === 'ready'), { timeoutMs: 30000, name: 'Dana ready again' })
  const r3 = await onceRun(bootstrap, bob.dir).result
  await danaAgain.stop()
  t.ok(r3.skipped.some((s) => s.key === dana.key && s.reason === 'revoked-issuer'), 'the remote gate refuses a revoked issuer')
  t.absent(await stored(bob.dir, dana.key), 'nothing stored')
  t.ok(r3.errors.every((e) => !e.startsWith('bloco 0 divergente')), 'not reported as a divergent block 0')
})

// P1 of the B2 review: a revocation purges every STORED diary of the revoked
// issuer, not only the active follows (store.replicate serves any stored core
// on demand), at adoption and at startup.
test('a revoked issuer purges the unfollowed and failed replicas it certified', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: MOD_DATE }, kp)
  const issuerKp = crypto.keyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuer = { keyPair: issuerKp, cert: createIssuerCert({ issuer: issuerHex }, kp) }
  const otherKp = crypto.keyPair()
  const other = { keyPair: otherKp, cert: createIssuerCert({ issuer: hex(otherKp.publicKey) }, kp) }

  const dana = await makeMember(t, kp, issuer) // revoked issuer, will be unfollowed
  const fay = await makeMember(t, kp, issuer, 4) // revoked issuer, length 6: its follow fails on quota
  const gus = await makeMember(t, kp, other) // another issuer: stays
  // Bob and Hal are themselves certified by the issuer to revoke: the sweep
  // must still never touch their own diary.
  const bob = await makeMember(t, kp, issuer)
  const hal = await makeMember(t, kp, issuer)
  writeFollows(bob.dir, [dana.key, fay.key, gus.key])
  writeFollows(hal.dir, [dana.key])

  // 1. Bob and Hal replicate every diary.
  {
    const authors = [longRun(t, bootstrap, dana.dir), longRun(t, bootstrap, fay.dir), longRun(t, bootstrap, gus.dir)]
    for (const a of authors) await until(() => a.events.some((ev) => ev.event === 'ready'), { timeoutMs: 30000, name: 'author ready' })
    const runs = [onceRun(bootstrap, bob.dir), onceRun(bootstrap, hal.dir)]
    const [rb, rh] = await Promise.all(runs.map((r) => r.result))
    for (const a of authors) await a.stop()
    t.ok(rb.ok && rh.ok, 'first sync ok ' + JSON.stringify([rb.errors, rh.errors]))
    t.alike(rb.downloaded, { [dana.key]: 4, [fay.key]: 6, [gus.key]: 4 }, 'Bob holds the three diaries')
    t.is(rh.downloaded[dana.key], 4, 'Hal holds Dana')
  }

  // 2. Bob unfollows Dana (her replica stays stored) and runs with a quota
  //    Fay is over (her active replica keeps its blocks, follow failed).
  //    Sync startup already purges the unfollowed replica; a snapshot
  //    revoking the issuer then purges Fay, and nothing else.
  {
    writeFollows(bob.dir, [fay.key, gus.key])
    t.ok(await stored(bob.dir, dana.key), 'the unfollowed replica is still stored')
    const revoke = createSnapshot({ seq: 1, date: MOD_DATE, revokedIssuers: [issuerHex] }, modKp, modCert)
    const controller = new AbortController()
    const events = []
    const logs = []
    const purged = []
    const done = runSync({
      ...localSwarmOptions(bootstrap),
      dataDir: bob.dir,
      signal: controller.signal,
      maxLogBlocks: 5,
      log: (line) => logs.push(line),
      onEvent: (ev) => events.push(ev),
      purgeHook: async (key, store) => {
        await purgeReplica(store, key)
        purged.push(key)
      }
    })
    t.teardown(() => controller.abort(), { force: true })
    await until(() => events.some((ev) => ev.event === 'skipped' && ev.key === fay.key && ev.reason === 'quota'), { timeoutMs: 30000, name: 'Fay fails on quota' })
    await until(() => purged.includes(dana.key), { timeoutMs: 30000, name: 'startup purge of the unfollowed replica' })
    t.alike(purged, [dana.key], 'before the revocation only the unfollowed replica is purged (a quota failure keeps the blocks)')

    const moderator = await rawNode(t, bootstrap, association, { blocklist: () => revoke })
    await until(() => storedSeq(bob.dir) === 1, { timeoutMs: 30000, name: 'Bob stores the revocation' })
    await until(() => purged.includes(dana.key) && purged.includes(fay.key), { timeoutMs: 30000, name: 'Bob purges Dana and Fay' })
    await moderator.swarm.destroy()

    // A raw third node asks Bob for each diary by key: Gus (control) is
    // served, the revoked ones are not.
    const carol = await rawNode(t, bootstrap, association, { open: [gus.key, dana.key, fay.key] })
    t.ok(await carol.cores[0].get(0, { timeout: 20000 }), 'Bob still serves the non-revoked diary')
    for (const core of carol.cores.slice(1)) {
      let got = null
      try {
        got = await core.get(0, { timeout: 3000 })
      } catch {}
      t.is(got, null, 'Bob no longer serves a revoked diary')
    }
    await carol.swarm.destroy()

    controller.abort()
    const r = await done
    t.ok(r.skipped.some((s) => s.key === fay.key && s.reason === 'quota'), 'Fay stays skipped')
    t.absent(r.skipped.some((s) => s.key === gus.key), 'Gus not skipped')
    t.is(r.downloaded[gus.key], 4, 'Gus still downloaded')
    t.alike(purged.slice().sort(), [dana.key, fay.key].sort(), 'only the revoked diaries are purged')
    t.ok(logs.includes('aviso: o emissor do seu certificado foi revogado pela associação'), 'own revocation warned')
    t.absent(await stored(bob.dir, dana.key), 'unfollowed replica purged')
    t.absent(await stored(bob.dir, fay.key), 'failed replica purged')
    t.ok(await stored(bob.dir, gus.key), 'non-revoked replica kept')
    t.is(await ownLength(bob.dir), 4, 'own diary intact')
    t.alike(readFollows(bob.dir), [fay.key, gus.key].sort(), 'follows.json intact (stored sorted by key)')
  }

  // 3. Hal: an unfollowed replica of Dana and the stored snapshot, no peer.
  //    The startup sweep purges it before anything is served.
  {
    writeFollows(hal.dir, [])
    writeBlocklist(hal.dir, createSnapshot({ seq: 1, date: MOD_DATE, revokedIssuers: [issuerHex] }, modKp, modCert))
    t.ok(await stored(hal.dir, dana.key), 'Hal still holds the unfollowed replica')
    const purged = []
    const rh = await runSync({
      ...localSwarmOptions(bootstrap),
      dataDir: hal.dir,
      once: true,
      timeoutMs: 2000,
      purgeHook: async (key, store) => {
        await purgeReplica(store, key)
        purged.push(key)
      }
    })
    t.alike(purged, [dana.key], 'the revoked replica is purged at startup')
    t.ok(rh.errors.includes('sem pares') || rh.ok, 'run ends normally')
    t.absent(await stored(hal.dir, dana.key), 'Hal no longer holds Dana')
    t.is(await ownLength(hal.dir), 4, 'own diary intact')
  }
})
