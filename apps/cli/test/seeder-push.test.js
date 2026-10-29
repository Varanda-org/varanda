// Web Push at the seeder (packages/core/lib/seeder.js onPush, push-events.js):
// a per-diary push cursor that starts at the signed length the seeder held
// when it served the diary, so history (at serve, at first admission, after
// a restart, a rebuild or a re-admission) never becomes a push, and every
// follow, reply, like or repost appended past it emits at most once.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const { keyPair: signingKeyPair, randomBytes } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, followRecord, likeRecord, repostRecord, profileRecord } = require('@varanda/core/lib/records')
const { validatePushEvent } = require('@varanda/core/lib/push-events')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
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
  const pushes = []
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
    },
    onPush: (e) => {
      pushes.push(e)
      if (opts.throwing && opts.throwing()) throw new Error('boom')
    },
    ...opts.seeder
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events, pushes }
}

const MINUTE = 60000
function recent () {
  return new Date(Date.now() - MINUTE).toISOString()
}

// A member with a compat diary dialing the seeder directly; `records` are
// appended before it ever connects (history).
async function member (t, bootstrap, assoc, seederKey, records = []) {
  const kp = signingKeyPair()
  const diary = new Hypercore(tmpDir(t, 'varanda-compat-'), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await diary.ready()
  t.teardown(() => diary.close(), { force: true })
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text: 'oi', at: recent() }))
  for (const r of records) await diary.append(typeof r === 'function' ? r(key) : r)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    diary.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const m = { diary, key, kp, messages, peers }
  m.seederPeer = () => until(() => [...peers].reverse().find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  m.message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 30000 })
  return m
}

async function announce (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
}

async function admit (m, assoc) {
  await announce(m, assoc)
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

async function grown (m, record) {
  await m.diary.append(record)
  const seq = m.diary.length - 1
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return seq
}

async function pushBlocklist (t, bootstrap, seederKey, snapshot) {
  const store = new Corestore(tmpDir(t, 'varanda-mod-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    attachBlocklist(socket, {
      current: () => snapshot,
      offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
    })
    attachAdmission(socket, { role: 'member', have: [] })
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  return swarm
}

// Appends a follow of A from `m` as a sentinel and waits for its push: the
// push queue is serial, so every block appended before it was decided.
async function sentinel (pushes, m, A) {
  const seq = await grown(m, followRecord({ key: A.key, on: true, at: recent() }))
  await until(() => pushes.find((p) => p.actor === m.key && p.seq === seq), { name: 'sentinela ' + seq, timeoutMs: 30000 })
  return seq
}

function since (pushes, mark) {
  return pushes.slice(mark)
}

test('push: history never emits, live appends emit once, negatives stay silent', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  let throwAll = false
  const s1 = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex }, throwing: () => throwAll })
  const { seeder, events, pushes } = s1

  // A: the recipient, with a post at 1 and a profile at 2.
  const A = await member(t, bootstrap, assoc, publicKey, [profileRecord({ name: 'Ana', at: recent() })])
  await admit(A, assoc)

  // B already holds a follow, a reply, a like and a repost aimed at A when
  // it is admitted for the first time: its history replicates afterwards.
  const B = await member(t, bootstrap, assoc, publicKey, [
    profileRecord({ name: '@​ Bia ', bio: 'bio secreta', at: recent() }),
    followRecord({ key: A.key, on: true, at: recent() }),
    postRecord({ text: 'resposta antiga', replyTo: { author: A.key, seq: 1 }, at: recent() }),
    likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: recent() }),
    repostRecord({ to: { author: A.key, seq: 1 }, on: true, at: recent() })
  ])
  await admit(B, assoc)
  await until(() => seeder._index.hints(B.key).profileSeq === 2, { name: 'perfil de B indexado' })

  // Live appends: one event each, B's sanitized profile name, never the bio.
  const fSeq = await grown(B, followRecord({ key: A.key, on: true, at: recent() }))
  const rSeq = await grown(B, postRecord({ text: 'concordo', replyTo: { author: A.key, seq: 1 }, at: recent() }))
  const lSeq = await grown(B, likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: recent() }))
  const pSeq = await grown(B, repostRecord({ to: { author: A.key, seq: 1 }, on: true, at: recent() }))
  await until(() => pushes.length >= 4, { name: 'quatro pushes', timeoutMs: 30000 })
  await delay(300)
  const ref = A.key + ':1'
  t.alike(pushes, [
    { v: 1, kind: 'follow', actor: B.key, recipient: A.key, seq: fSeq, ref: null, name: 'Bia' },
    { v: 1, kind: 'reply', actor: B.key, recipient: A.key, seq: rSeq, ref, name: 'Bia' },
    { v: 1, kind: 'like', actor: B.key, recipient: A.key, seq: lSeq, ref, name: 'Bia' },
    { v: 1, kind: 'repost', actor: B.key, recipient: A.key, seq: pSeq, ref, name: 'Bia' }
  ], 'history emitted nothing; live appends emitted once each')
  t.ok(pushes.every(validatePushEvent), 'every event passes validatePushEvent')

  // Silent records, then a sentinel: nothing between.
  let mark = pushes.length
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString()
  await grown(B, followRecord({ key: A.key, on: false, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 1 }, on: false, at: recent() }))
  await grown(B, repostRecord({ to: { author: A.key, seq: 1 }, on: false, at: recent() }))
  await grown(B, postRecord({ text: 'citação', quote: { author: A.key, seq: 1 }, at: recent() }))
  await grown(B, likeRecord({ to: { author: B.key, seq: 1 }, on: true, at: recent() }))
  await grown(B, followRecord({ key: hex(randomBytes(32)), on: true, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 999 }, on: true, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 2 }, on: true, at: recent() }))
  await grown(B, postRecord({ text: 'atrasada', replyTo: { author: A.key, seq: 1 }, at: old }))
  let s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'unfollow, offs, quote, self-like, non-member, missing or non-post target, old reply: silent')

  // A blocked actor: C is dropped on adoption and nothing of it is pushed.
  const C = await member(t, bootstrap, assoc, publicKey)
  await admit(C, assoc)
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [C.key], revokedIssuers: [] }, modKp, modCert))
  await until(() => seeder._isBlocked(C.key) && !seeder._served.has(C.key), { name: 'C bloqueado' })
  mark = pushes.length
  await C.diary.append(followRecord({ key: A.key, on: true, at: recent() }))
  s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => p.actor), [B.key], 'blocked actor: silent')

  // An index rebuild resets the index cursors, never the push cursor.
  mark = pushes.length
  seeder._rebuildIndex()
  await until(() => {
    const e = seeder._served.get(B.key)
    return e && !seeder._indexRebuildQueued && e.indexed >= B.diary.length
  }, { name: 'índice reconstruído' })
  s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'rebuild re-emitted nothing')

  // A throwing onPush breaks neither the push scanner nor scan and index.
  throwAll = true
  mark = pushes.length
  const t1 = await sentinel(pushes, B, A)
  const t2 = await sentinel(pushes, B, A)
  throwAll = false
  t.alike(since(pushes, mark).map((p) => p.seq), [t1, t2], 'pushes keep flowing after throws')
  await until(() => {
    const e = seeder._served.get(B.key)
    return e && e.scanned >= B.diary.length && e.indexed >= B.diary.length
  }, { name: 'scan e índice em dia' })
  t.pass('scan and index reached the length')

  // An append while a first admission is gating emits once after the gate.
  let release
  const hold = new Promise((resolve) => { release = resolve })
  let E = null
  seeder.regateHook = async (key) => { if (E && key === E.key) await hold }
  E = await member(t, bootstrap, assoc, publicKey)
  await announce(E, assoc)
  await until(() => {
    const e = seeder._served.get(E.key)
    return e && e.gating && !e.gated
  }, { name: 'E em gate' })
  mark = pushes.length
  const eSeq = E.diary.length
  await E.diary.append(followRecord({ key: A.key, on: true, at: recent() }))
  await until(() => seeder._served.get(E.key).core.contiguousLength === E.diary.length, { name: 'E replicado em gate' })
  await delay(300)
  t.is(pushes.length, mark, 'nothing while gating')
  release()
  await until(() => pushes.length > mark, { name: 'push de E', timeoutMs: 30000 })
  s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => [p.actor, p.seq, p.name]), [[E.key, eSeq, null], [B.key, s, 'Bia']], 'gating-window append emitted once, no profile means null name')
  seeder.regateHook = null

  // Drop and re-admission: blocks emitted before stay silent.
  mark = pushes.length
  seeder._drop(B.key, 'quota')
  await until(() => !seeder._drops.has(B.key) && !seeder._dropping.has(B.key), { name: 'B purgado' })
  B.messages.length = 0
  await admit(B, assoc)
  s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'drop and re-admit re-emitted nothing')

  t.absent(events.some((e) => JSON.stringify(e).includes('Bia')), 'no log carries a name')
  t.absent(events.some((e) => /push/i.test(e.event || '')), 'no push log events')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)

  // A restart over the same data dir emits nothing for stored blocks.
  await seeder.close()
  const s2 = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex } })
  await until(() => s2.seeder._served.has(B.key) && s2.seeder._served.has(A.key), { name: 'servidos após reinício' })
  B.messages.length = 0
  s = await sentinel(s2.pushes, B, A)
  t.alike(s2.pushes.map((p) => p.seq), [s], 'restart emitted nothing for stored blocks')
})

test('push: onPush must be a function or null', async (t) => {
  t.exception.all(() => new Seeder({ dataDir: tmpDir(t, 'varanda-seed-'), onPush: 'x' }), /onPush/)
  t.ok(new Seeder({ dataDir: tmpDir(t, 'varanda-seed-'), onPush: null }))
})

test('push: a recipient dropped while the actor name read is pending gets nothing', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, pushes } = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex } })

  const A = await member(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  const D = await member(t, bootstrap, assoc, publicKey)
  await admit(D, assoc)
  const B = await member(t, bootstrap, assoc, publicKey, [profileRecord({ name: 'Bia', at: recent() })])
  await admit(B, assoc)
  await until(() => seeder._index.hints(B.key).profileSeq === 2, { name: 'perfil de B indexado' })

  // Hold the next actor name read; D leaves while it is pending.
  const readName = seeder._pushActorName.bind(seeder)
  let holdNext = true
  let entered = false
  let release
  const hold = new Promise((resolve) => { release = resolve })
  seeder._pushActorName = async (key, entry) => {
    if (holdNext) {
      holdNext = false
      entered = true
      await hold
    }
    return readName(key, entry)
  }
  const mark = pushes.length
  const dSeq = B.diary.length
  await B.diary.append(followRecord({ key: D.key, on: true, at: recent() }))
  await until(() => entered, { name: 'leitura do nome em espera', timeoutMs: 30000 })
  seeder._drop(D.key, 'quota')
  t.absent(seeder._served.has(D.key) || seeder._admitted.has(D.key), 'D is no longer a member')
  release()

  const s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => [p.recipient, p.seq]), [[A.key, s]], 'nothing for the dropped recipient, the cursor moved on')
  t.absent(pushes.some((p) => p.seq === dSeq), 'the held follow never emitted')
  seeder._pushActorName = readName
})
