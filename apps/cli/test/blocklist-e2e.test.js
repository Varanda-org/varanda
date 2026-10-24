'use strict'

// End-to-end B2 moderation flow on a loopback hyperdht testnet: the
// association and the moderation key are set up with the real CLI (`assoc
// init`, `mod init`, `assoc certify-moderator`, `mod cert add`) and every
// list change is signed and published by `mod` in a child process; the
// seeder and the members run in-process (lib/seeder.js, lib/sync.js runSync).
// It shows that a blocked author, and a diary certified by a revoked issuer,
// cannot pass content through an updated seeder or an updated honest member,
// also while the seeder is down (the snapshot travels member to member), and
// that a later unblock lets the author back in through a restarted seeder.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { runSync } = require('@varanda/core/lib/sync')
const { createIssuedCert } = require('@varanda/core/lib/cert')
const assoc = require('@varanda/core/lib/assoc')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const {
  openStore,
  openDiary,
  appendRecord,
  writeConfig,
  writeFollows,
  readFollows,
  readBlocklist,
  purgeReplica,
  replicaStored
} = require('@varanda/core/lib/store')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const WAIT = { timeoutMs: 45000 }

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function cli (args) {
  return spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
}

// Publishing commands run asynchronously: the seeder and the members live in
// this process and must keep answering while the child publishes.
function cliAsync (args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function readAdmitted (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8')).admitted
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

function storedSeq (dir) {
  const d = readBlocklist(dir)
  return d === null ? null : d.snapshot.seq
}

// The seeder setup of the CLI (seed key, assoc certify-seeder, seed cert add).
function prepareSeederDir (t, assocDir, association) {
  const dataDir = tmpDir(t, 'varanda-ble-seed-')
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-ble-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(assoc.issueSeederCertificate(assocDir, { seeder: publicKey })))
  Seeder.addCert(dataDir, certFile, association)
  return { dataDir, publicKey }
}

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

// A member data dir whose block 0 is certFor(key), then a profile and a post.
async function makeMember (t, association, certFor) {
  const dir = tmpDir(t, 'varanda-ble-member-')
  writeConfig(dir, { v: 1, role: 'member', association })
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    await appendRecord(diary, memberCertRecord(certFor(key)))
    await appendRecord(diary, profileRecord({ name: 'Membro', bio: '' }))
    await appendRecord(diary, postRecord({ text: 'olá' }))
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

function onceRun (bootstrap, dir) {
  const events = []
  return runSync({ ...localSwarmOptions(bootstrap), dataDir: dir, once: true, timeoutMs: 30000, onEvent: (e) => events.push(e) })
    .then((r) => ({ ...r, events }))
}

// A long-running member sync: its events, the keys it purged and stop().
function longRun (t, bootstrap, dir) {
  const controller = new AbortController()
  const events = []
  const purged = []
  const done = runSync({
    ...localSwarmOptions(bootstrap),
    dataDir: dir,
    signal: controller.signal,
    onEvent: (e) => events.push(e),
    purgeHook: async (key, store) => {
      await purgeReplica(store, key)
      purged.push(key)
    }
  })
  t.teardown(() => controller.abort(), { force: true })
  return { events, purged, done, stop: () => { controller.abort(); return done } }
}

const skippedAs = (run, key, reason) => run.events.some((e) => e.event === 'skipped' && e.key === key && e.reason === reason)
const rejectedAs = (events, key, reason) => events.filter((e) => e.event === 'rejected' && e.key === key && e.reason === reason).length

test('e2e: a blocked author and a revoked issuer are dropped by the seeder and honest members, also with the seeder down', async (t) => {
  t.timeout(175000)
  const { bootstrap } = await testnet(t)
  const flags = bootstrapFlags(bootstrap)
  const root = tmpDir(t, 'varanda-ble-')

  // Association and moderation key, through the CLI.
  const assocDir = path.join(root, 'assoc')
  const modDir = path.join(root, 'mod')
  const init = cli(['assoc', 'init', '--data', assocDir])
  t.is(init.status, 0, init.stderr)
  const association = /([0-9a-f]{64})/.exec(init.stdout)[1]
  const modInit = cli(['mod', 'init', '--association', association, '--data', modDir])
  t.is(modInit.status, 0, modInit.stderr)
  const moderator = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(modInit.stdout)[1]
  const modCertFile = path.join(root, 'moderator-cert.json')
  const certify = cli(['assoc', 'certify-moderator', '--moderator', moderator, '--out', modCertFile, '--data', assocDir])
  t.is(certify.status, 0, certify.stderr)
  const certAdd = cli(['mod', 'cert', 'add', '--cert-file', modCertFile, '--data', modDir])
  t.is(certAdd.status, 0, certAdd.stderr)

  // An issuer the association delegated to (B1); Dave holds a v2 certificate from it.
  const issuerKp = crypto.keyPair()
  const issuer = hex(issuerKp.publicKey)
  const issuerCert = assoc.issueIssuerCertificate(assocDir, { issuer })

  // The publisher dials the seeder by this key (`seed status` shows it).
  const { dataDir: seedDir, publicKey: seederKey } = prepareSeederDir(t, assocDir, association)
  const publishTo = ['--seeder', seederKey]
  let { seeder, events: seedEvents } = await startSeeder(t, bootstrap, seedDir, { associationKey: association })

  const v1 = (key) => assoc.issueCertificate(assocDir, { member: key })
  const alice = await makeMember(t, association, v1)
  const dave = await makeMember(t, association, (key) => createIssuedCert({ member: key }, issuerKp, issuerCert))
  const bob = await makeMember(t, association, v1)
  const carol = await makeMember(t, association, v1)
  writeFollows(bob.dir, [alice.key, dave.key])
  writeFollows(carol.dir, [alice.key])

  // 1. Alice and Dave publish through the seeder and go offline; Bob gets both from it.
  const ra = await onceRun(bootstrap, alice.dir)
  t.ok(ra.ok && ra.admitted, 'Alice admitted ' + JSON.stringify(ra.errors))
  const rd = await onceRun(bootstrap, dave.dir)
  t.ok(rd.ok && rd.admitted, 'Dave (v2 certificate) admitted ' + JSON.stringify(rd.errors))
  const rb = await onceRun(bootstrap, bob.dir)
  t.ok(rb.ok, 'Bob sync ok ' + JSON.stringify(rb.errors))
  t.is(rb.downloaded[alice.key], 3, 'Bob holds Alice')
  t.is(rb.downloaded[dave.key], 3, 'Bob holds Dave')

  // 2. Bob stays online; `mod block` publishes to the seeder only (by its
  //    key, never through the topic). The seeder drops Alice and Bob purges
  //    her once the seeder fans the snapshot out to him.
  const bobRun = longRun(t, bootstrap, bob.dir)
  await until(() => bobRun.events.some((e) => e.event === 'ready'), { ...WAIT, name: 'Bob pronto' })
  const block = await cliAsync(['mod', 'block', alice.key, '--new-list', ...publishTo, '--data', modDir, '--timeout-ms', '45000', ...flags])
  t.is(block.status, 0, block.stderr)
  t.ok(block.stdout.endsWith('lista seq 1 gravada\nlista publicada\n'), 'published')

  await until(() => seeder.stats().blocklistSeq === 1, { ...WAIT, name: 'semeador adota seq 1' })
  await until(() => rejectedAs(seedEvents, alice.key, 'blocked') > 0, { ...WAIT, name: 'semeador rejeita Alice' })
  await until(() => seeder.stats().dropping === 0 && !(alice.key in readAdmitted(seedDir)), { ...WAIT, name: 'Alice fora do semeador' })
  t.absent(seeder.admittedKeys().includes(alice.key), 'the seeder dropped Alice')
  t.is(seeder.stats().blocked, 1, 'blocked gauge')
  await until(() => storedSeq(bob.dir) === 1, { ...WAIT, name: 'Bob grava seq 1' })
  await until(() => bobRun.purged.includes(alice.key) && skippedAs(bobRun, alice.key, 'blocked'), { ...WAIT, name: 'Bob descarta Alice' })
  t.pass('Bob skipped and purged Alice (blocked)')

  // 3. Alice announces again: rejected 'blocked', nothing fetched.
  const before = rejectedAs(seedEvents, alice.key, 'blocked')
  const ra2 = await onceRun(bootstrap, alice.dir)
  t.is(ra2.ok, false)
  t.is(ra2.rejected, 'blocked', 'Alice is refused by the seeder')
  t.ok(rejectedAs(seedEvents, alice.key, 'blocked') > before)
  t.absent(seeder.admittedKeys().includes(alice.key))

  // 4. R5: the issuer is revoked; the seeder and Bob drop Dave's v2 diary.
  const revoke = await cliAsync(['mod', 'revoke-issuer', issuer, ...publishTo, '--data', modDir, '--timeout-ms', '45000', ...flags])
  t.is(revoke.status, 0, revoke.stderr)
  t.ok(revoke.stdout.includes('emissor revogado: '), 'revoked')
  await until(() => seeder.stats().blocklistSeq === 2, { ...WAIT, name: 'semeador adota seq 2' })
  await until(() => rejectedAs(seedEvents, dave.key, 'revoked-issuer') > 0, { ...WAIT, name: 'semeador rejeita Dave' })
  await until(() => seeder.stats().dropping === 0 && !(dave.key in readAdmitted(seedDir)), { ...WAIT, name: 'Dave fora do semeador' })
  t.alike(seeder.admittedKeys().filter((k) => k === alice.key || k === dave.key), [], 'neither is admitted')
  await until(() => storedSeq(bob.dir) === 2, { ...WAIT, name: 'Bob grava seq 2' })
  await until(() => bobRun.purged.includes(dave.key) && skippedAs(bobRun, dave.key, 'revoked-issuer'), { ...WAIT, name: 'Bob descarta Dave' })
  t.pass('Bob skipped and purged Dave (revoked-issuer)')

  // 5. The seeder goes down. Carol (fresh, follows Alice) gets the snapshot
  //    from Bob alone, then Alice comes online and advertises directly:
  //    Carol never fetches her.
  await seeder.close()
  const carolRun = longRun(t, bootstrap, carol.dir)
  await until(() => storedSeq(carol.dir) === 2, { ...WAIT, name: 'Carol recebe seq 2 de Bob' })
  await until(() => skippedAs(carolRun, alice.key, 'blocked'), { ...WAIT, name: 'Carol ignora Alice' })
  t.absent(carolRun.events.some((e) => e.event === 'peer' && e.role === 'seeder'), 'no seeder involved')

  const aliceRun = longRun(t, bootstrap, alice.dir)
  const memberPeers = () => new Set(carolRun.events.filter((e) => e.event === 'peer' && e.role === 'member').map((e) => e.peerKey)).size
  await until(() => memberPeers() >= 2, { ...WAIT, name: 'Carol conectada a Bob e Alice' })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.absent(carolRun.events.some((e) => (e.event === 'downloaded' || e.event === 'have') && e.key === alice.key), 'Carol ignores Alice\'s advertisement')
  const rc = await carolRun.stop()
  await aliceRun.stop()
  t.ok(rc.skipped.some((s) => s.key === alice.key && s.reason === 'blocked'), 'Carol result: skipped blocked')
  t.absent(alice.key in rc.downloaded)
  t.absent(await stored(carol.dir, alice.key), 'Carol stores nothing of Alice')
  t.ok(readFollows(carol.dir).includes(alice.key), 'the follow is kept')

  await bobRun.stop()
  t.absent(await stored(bob.dir, alice.key), 'Bob stores nothing of Alice')
  t.absent(await stored(bob.dir, dave.key), 'Bob stores nothing of Dave')

  // 6. Unblock without publishing: written locally, nobody hears of it. The
  //    seeder restarts with seq 2 and still refuses Alice; the next publish
  //    of the unblock lets her back in.
  const unblockLocal = cli(['mod', 'unblock', alice.key, '--no-publish', '--data', modDir])
  t.is(unblockLocal.status, 0, unblockLocal.stderr)
  t.ok(unblockLocal.stdout.endsWith('lista seq 3 gravada\nlista não publicada (--no-publish)\n'))
  t.is(storedSeq(bob.dir), 2, 'an unpublished change reaches no node')

  ;({ seeder, events: seedEvents } = await startSeeder(t, bootstrap, seedDir))
  t.is(seeder.stats().blocklistSeq, 2, 'the restarted seeder keeps seq 2')
  t.absent(seeder.admittedKeys().includes(alice.key))

  const unblock = await cliAsync(['mod', 'unblock', alice.key, ...publishTo, '--data', modDir, '--timeout-ms', '45000', ...flags])
  t.is(unblock.status, 0, unblock.stderr)
  t.ok(unblock.stdout.endsWith('lista seq 4 gravada\nlista publicada\n'), 'the unblock is published')
  await until(() => seeder.stats().blocklistSeq === 4, { ...WAIT, name: 'semeador adota seq 4' })
  t.is(seeder.stats().blocked, 0)

  const ra3 = await onceRun(bootstrap, alice.dir)
  t.ok(ra3.ok && ra3.admitted, 'Alice admitted again ' + JSON.stringify(ra3.errors))
  t.ok(seeder.admittedKeys().includes(alice.key))
  t.absent(seeder.admittedKeys().includes(dave.key), 'the revoked issuer stays revoked')
  await seeder.close()
})
