// Startup phase timing on the seeder `ready` event (observability only).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')
const { Seeder, startupPhases } = require('../lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('../lib/cert')
const { memberCertRecord } = require('../lib/records')

const PHASE_KEYS = ['configMs', 'storeMs', 'stateMs', 'diariesMs', 'mediaMs', 'groupsMs', 'prepareMs', 'swarmMs', 'flushMs', 'totalMs', 'acceptingMs']

test('startupPhases subtracts the marks of each step', (t) => {
  const phases = startupPhases({ t0: 100, config: 101, store: 105, state: 106, diaries: 110, media: 112, groups: 115, prepare: 120, swarm: 121, accepting: 122, flush: 130 })
  t.alike(phases, { configMs: 1, storeMs: 4, stateMs: 1, diariesMs: 4, mediaMs: 2, groupsMs: 3, prepareMs: 5, swarmMs: 1, flushMs: 9, totalMs: 30, acceptingMs: 22 })
  t.alike(startupPhases({ t0: 5, config: 4, store: 4, state: 4, diaries: 4, media: 4, groups: 4, prepare: 4, swarm: 4, accepting: 4, flush: 4 }).totalMs, 0, 'never negative')
  t.is(startupPhases({ t0: 5, config: 4, store: 4, state: 4, diaries: 4, media: 4, groups: 4, prepare: 4, swarm: 4, flush: 4 }).acceptingMs, 0, 'a missing mark counts as 0, not NaN')
})

test('the ready event carries phases and core counts, without keys', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assocHex = b4a.toString(kp.publicKey, 'hex')
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assocHex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, kp)))
  Seeder.addCert(dataDir, certFile, assocHex)

  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: assocHex, log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  const started = await seeder.start()

  const ready = events.find((e) => e.event === 'ready')
  t.ok(ready, 'ready logged')
  t.is(ready.topic, started.topic)
  t.alike(Object.keys(ready.phases), PHASE_KEYS)
  for (const k of PHASE_KEYS) t.ok(Number.isInteger(ready.phases[k]) && ready.phases[k] >= 0, k + ' is an integer >= 0')
  const sum = PHASE_KEYS.slice(0, -2).reduce((n, k) => n + ready.phases[k], 0)
  t.ok(ready.phases.totalMs >= sum - 9, 'total covers the phases')
  t.alike(ready.cores, {
    diaries: { kept: 0, dropped: 0 },
    media: { kept: 0, dropped: 0 },
    groups: { kept: 0, dropped: 0 }
  })
  t.absent(/[0-9a-f]{64}/.test(JSON.stringify({ phases: ready.phases, cores: ready.cores })), 'no key in the fields')
})

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

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
}

function validBlocks (assoc) {
  return (key) => [memberCertRecord(validCert(assoc, key)), post('um'), post('dois')]
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

async function localStore (t) {
  const store = new Corestore(tmpDir(t, 'varanda-local-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  return store
}

async function localCore (store, name, records) {
  const core = store.get({ name, valueEncoding: 'json' })
  await core.ready()
  for (const r of records(hex(core.key))) await core.append(r)
  return core
}

// Copies blocks of srcCore into the (stopped) seeder's main store directly.
async function preload (dataDir, srcStore, key, length) {
  const store = new Corestore(path.join(dataDir, 'store'))
  await store.ready()
  const replica = store.get({ key: b4a.from(key, 'hex') })
  await replica.ready()
  const s1 = srcStore.replicate(true)
  const s2 = store.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  await replica.download({ start: 0, end: length }).done()
  return {
    replica,
    async close () {
      s1.destroy()
      s2.destroy()
      await store.close()
    }
  }
}

// One listed diary whose core is present, one listed diary whose core is
// missing (startup re-gate purges it as no-cert, seeder.test.js), and one
// listed media core with no bytes (purged as no-header). media-rejected is
// step 3b, after the diary counts are fixed and before ready copies
// admittedKeys(). The log inserts one more diary there. The old formula
// (kept = admittedKeys().length, dropped = max(0, before - kept)) then
// reports kept 2 and dropped 0, which cancels the purge.
test('ready cores count the re-gate, including a diary it drops', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const src = await localStore(t)
  const good = await localCore(src, 'good', validBlocks(assoc))
  const goodKey = hex(good.key)
  const missingKey = 'cd'.repeat(32)
  const missingMedia = 'ab'.repeat(32)
  const extra = 'ee'.repeat(32)
  await (await preload(dataDir, src, goodKey, 3)).close()
  await src.close()
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify({
    v: 1,
    admitted: {
      [goodKey]: validCert(assoc, goodKey),
      [missingKey]: validCert(assoc, missingKey)
    },
    media: {
      [missingMedia]: { diary: goodKey, seq: 1 }
    }
  }))

  const events = []
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    associationKey: assoc.hex,
    log: (e) => {
      events.push(e)
      if (e.event === 'media-rejected' && e.key === missingMedia && e.reason === 'no-header') {
        seeder._admitted.set(extra, validCert(assoc, extra))
      }
    }
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()

  const ready = events.find((e) => e.event === 'ready')
  t.ok(ready, 'ready logged')
  t.ok(events.some((e) => e.event === 'rejected' && e.key === missingKey && e.reason === 'no-cert'), 'missing diary purged by the re-gate')
  t.ok(events.some((e) => e.event === 'media-rejected' && e.key === missingMedia && e.reason === 'no-header'), 'missing media purged by the re-gate')
  t.alike(ready.cores, {
    diaries: { kept: 1, dropped: 1 },
    media: { kept: 0, dropped: 1 },
    groups: { kept: 0, dropped: 0 }
  })
  t.ok(seeder.admittedKeys().includes(goodKey), 'the preloaded diary survived')
  t.absent(seeder.admittedKeys().includes(missingKey), 'the missing diary left the list')
  t.ok(seeder.admittedKeys().includes(extra), 'a diary added after the diary re-gate stays listed')
  t.is(ready.admitted.length, 2, 'ready.admitted is the post-flush list')
  t.is(ready.cores.diaries.kept, 1, 'cores.diaries.kept is not that list')
  t.absent(/[0-9a-f]{64}/.test(JSON.stringify({ phases: ready.phases, cores: ready.cores })), 'no key in the fields')
})
