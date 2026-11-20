// Web Push at the seeder (packages/core/lib/seeder.js onPush, push-events.js):
// a per-diary push cursor that starts at the signed length the seeder held
// when it served the diary, so history (at serve, at first admission, after
// a restart, a rebuild or a re-admission) never becomes a push, and every
// follow, reply, quote, @mention, like or repost appended past it emits at
// most once per recipient.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const { keyPair: signingKeyPair, randomBytes } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair, createIssuerCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, followRecord, likeRecord, repostRecord, profileRecord, deleteRecord } = require('@varanda/core/lib/records')
const { validatePushEvent, validatePushCancel } = require('@varanda/core/lib/push-events')

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

  // A quote of A's post pushes 'quote' to A; its ref is B's own post.
  let mark = pushes.length
  const qSeq = await grown(B, postRecord({ text: 'citação', quote: { author: A.key, seq: 1 }, at: recent() }))
  let s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark), [
    { v: 1, kind: 'quote', actor: B.key, recipient: A.key, seq: qSeq, ref: B.key + ':' + qSeq, name: 'Bia' },
    { v: 1, kind: 'follow', actor: B.key, recipient: A.key, seq: s, ref: null, name: 'Bia' }
  ], 'a quote pushes once to the quoted author')
  t.ok(since(pushes, mark).every(validatePushEvent), 'the quote event passes validatePushEvent')

  // Undoing a like, a follow or a repost emits a cancel of the queued push.
  const cancel = (kind, r) => ({ v: 1, op: 'cancel', kind, actor: B.key, recipient: A.key, ref: r })
  for (const [kind, on] of [
    ['like', (v) => likeRecord({ to: { author: A.key, seq: 1 }, on: v, at: recent() })],
    ['follow', (v) => followRecord({ key: A.key, on: v, at: recent() })],
    ['repost', (v) => repostRecord({ to: { author: A.key, seq: 1 }, on: v, at: recent() })]
  ]) {
    mark = pushes.length
    const onSeq = await grown(B, on(true))
    await grown(B, on(false))
    s = await sentinel(pushes, B, A)
    const r = kind === 'follow' ? null : ref
    t.alike(since(pushes, mark), [
      { v: 1, kind, actor: B.key, recipient: A.key, seq: onSeq, ref: r, name: 'Bia' },
      cancel(kind, r),
      { v: 1, kind: 'follow', actor: B.key, recipient: A.key, seq: s, ref: null, name: 'Bia' }
    ], kind + ' off: exactly one cancel')
  }

  // Silent records, then a sentinel: nothing between.
  mark = pushes.length
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  await grown(B, likeRecord({ to: { author: B.key, seq: 1 }, on: false, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 1 }, on: false, at: old }))
  await grown(B, followRecord({ key: hex(randomBytes(32)), on: false, at: recent() }))
  await grown(B, postRecord({ text: 'autocitação', quote: { author: B.key, seq: 1 }, at: recent() }))
  await grown(B, postRecord({ text: 'citação de perfil', quote: { author: A.key, seq: 2 }, at: recent() }))
  await grown(B, likeRecord({ to: { author: B.key, seq: 1 }, on: true, at: recent() }))
  await grown(B, followRecord({ key: hex(randomBytes(32)), on: true, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 999 }, on: true, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 2 }, on: true, at: recent() }))
  await grown(B, postRecord({ text: 'atrasada', replyTo: { author: A.key, seq: 1 }, at: old }))
  s = await sentinel(pushes, B, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'self-target, stale and non-member offs, self-quote, non-post quote, self-like, non-member, missing or non-post target, old reply: silent')

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

  t.ok(pushes.every((p) => validatePushEvent(p) || validatePushCancel(p)), 'every emitted object is a valid event or cancel')
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

test('push: @mentions reach verified holders, one push per recipient, a revoked issuer\'s names never match', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuerKp = signingKeyPair()
  const issuerHex = hex(issuerKp.publicKey)
  const issuerCert = createIssuerCert({ issuer: issuerHex, date: recent() }, assoc.kp)
  const username = (key, name) => createUsernameRecord({ member: key, username: name, date: recent() }, issuerKp, issuerCert)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, pushes } = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex } })

  const A = await member(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, publicKey)
  await admit(B, assoc)
  const C = await member(t, bootstrap, assoc, publicKey, [profileRecord({ name: 'Caio', at: recent() })])
  await admit(C, assoc)
  await until(() => seeder._index.hints(C.key).profileSeq === 2, { name: 'perfil de C indexado' })

  // A name pushes only once its holder is verified in the post notice index.
  await grown(A, username(A.key, 'anapaula'))
  await grown(B, username(B.key, 'bianca'))
  const holds = (name, key) => seeder._postNotices.holders(name, () => true).includes(key)
  await until(() => holds('anapaula', A.key) && holds('bianca', B.key), { name: 'nomes verificados' })

  const ref = (seq) => C.key + ':' + seq
  const ev = (kind, recipient, seq, r) => ({ v: 1, kind, actor: C.key, recipient, seq, ref: r, name: 'Caio' })

  // A plain mention: 'mention' to the holder, ref the mentioning post.
  let mark = pushes.length
  const m1 = await grown(C, postRecord({ text: 'oi @anapaula', at: recent() }))
  let s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('mention', A.key, m1, ref(m1)), ev('follow', A.key, s, null)], 'mention pushes to the verified holder')

  // Quoting A and mentioning B: two events, distinct recipients.
  mark = pushes.length
  const m2 = await grown(C, postRecord({ text: 'olha isso @bianca', quote: { author: A.key, seq: 1 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('quote', A.key, m2, ref(m2)), ev('mention', B.key, m2, ref(m2)), ev('follow', A.key, s, null)], 'quote of A and mention of B: one push each')

  // Quoting A and mentioning A: one 'quote'.
  mark = pushes.length
  const m3 = await grown(C, postRecord({ text: 'olha @anapaula', quote: { author: A.key, seq: 1 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('quote', A.key, m3, ref(m3)), ev('follow', A.key, s, null)], 'quote and mention of the same member: one quote')

  // A reply that also mentions the replied author: one 'reply'.
  mark = pushes.length
  const m4 = await grown(C, postRecord({ text: '@anapaula concordo', replyTo: { author: A.key, seq: 1 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('reply', A.key, m4, A.key + ':1'), ev('follow', A.key, s, null)], 'reply and mention of the same member: one reply')

  // A reply to one of A's blocks that is not a post (A:2 is the username
  // record) that also mentions A: the in-app notice is a mention, so is the push.
  mark = pushes.length
  const m5 = await grown(C, postRecord({ text: '@anapaula viu?', replyTo: { author: A.key, seq: 2 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('mention', A.key, m5, ref(m5)), ev('follow', A.key, s, null)], 'reply to a non-post of A plus a mention of A: one mention')

  // A quote of a seq A never wrote that also mentions A: one 'mention'. (A
  // post cannot both reply and quote: records.js refuses quote-with-reply.)
  mark = pushes.length
  const m6 = await grown(C, postRecord({ text: 'olha @anapaula', quote: { author: A.key, seq: 999 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('mention', A.key, m6, ref(m6)), ev('follow', A.key, s, null)], 'quote of a missing seq of A plus a mention of A: one mention')

  // A quote of a post of A that A's replica cannot read now, plus a mention
  // of A: silent for A, never a mislabelled 'mention'.
  const eA = seeder._served.get(A.key)
  eA.core.get = async () => { throw new Error('leitura falhou') }
  mark = pushes.length
  await grown(C, postRecord({ text: 'olha @anapaula', quote: { author: A.key, seq: 1 }, at: recent() }))
  delete eA.core.get
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'unreadable target plus a mention of A: silent, no fallback')

  // A quote of a post A deleted that also mentions A: one 'mention', as
  // the in-app notice (a deleted post is no post).
  const gone = await grown(A, postRecord({ text: 'vou apagar', at: recent() }))
  await grown(A, deleteRecord({ seq: gone }))
  await until(() => seeder._served.get(A.key).deleted.has(gone), { name: 'apagado indexado' })
  mark = pushes.length
  const m7 = await grown(C, postRecord({ text: 'olha @anapaula', quote: { author: A.key, seq: gone }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark), [ev('mention', A.key, m7, ref(m7)), ev('follow', A.key, s, null)], 'quote of a deleted post of A plus a mention of A: one mention')

  // A reply to a missing seq of A with no other hit on A stays silent.
  mark = pushes.length
  await grown(C, postRecord({ text: 'resposta perdida', replyTo: { author: A.key, seq: 999 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'reply to a missing seq of A alone: silent')

  // A name nobody holds and a self-mention stay silent.
  mark = pushes.length
  await grown(C, postRecord({ text: 'oi @ninguem', at: recent() }))
  await grown(A, postRecord({ text: 'eu sou @anapaula', at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'unheld name and self-mention: silent')
  t.ok(pushes.every(validatePushEvent), 'every event passes validatePushEvent')

  // The issuer is revoked: its names stop matching at once.
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuerHex] }, modKp, modCert))
  await until(() => seeder._certOpts().revokedIssuers.has(issuerHex), { name: 'emissor revogado' })
  mark = pushes.length
  await grown(C, postRecord({ text: 'oi de novo @anapaula e @bianca', at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark).map((p) => [p.kind, p.seq]), [['follow', s]], 'a revoked issuer\'s holders get no mention push')
})

test('push: a mention of a name verified after the cursor passed pushes once when it settles, within the gates', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuerKp = signingKeyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey), date: recent() }, assoc.kp)
  const username = (key, name) => createUsernameRecord({ member: key, username: name, date: recent() }, issuerKp, issuerCert)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, pushes } = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex } })

  const A = await member(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, publicKey)
  await admit(B, assoc)
  const C = await member(t, bootstrap, assoc, publicKey, [profileRecord({ name: 'Caio', at: recent() })])
  await admit(C, assoc)
  await until(() => seeder._index.hints(C.key).profileSeq === 2, { name: 'perfil de C indexado' })

  const holds = (name, key) => seeder._postNotices.holders(name, () => true).includes(key)
  const held = (seq, token) => seeder._pushPending.has(C.key + ':' + seq + ':' + token)
  const mentions = (mark) => since(pushes, mark).filter((p) => p.kind === 'mention')
  const ev = (recipient, seq) => ({ v: 1, kind: 'mention', actor: C.key, recipient, seq, ref: C.key + ':' + seq, name: 'Caio' })
  const verified = async (m, name) => {
    await grown(m, username(m.key, name))
    await until(() => holds(name, m.key), { name: name + ' verificado' })
  }

  // C mentions @anapaula before A holds it: nothing then, one push once A's
  // username record settles.
  let mark = pushes.length
  const m1 = await grown(C, postRecord({ text: 'oi @anapaula', at: recent() }))
  let s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark).map((p) => p.seq), [s], 'unheld name: no push when the cursor passes')
  t.ok(held(m1, 'anapaula'), 'the mention waits')
  await verified(A, 'anapaula')
  await until(() => mentions(mark).length > 0, { name: 'menção assentada', timeoutMs: 30000 })
  t.alike(mentions(mark), [ev(A.key, m1)], 'one mention push once the name settles')
  t.ok(mentions(mark).every(validatePushEvent), 'the settled event passes validatePushEvent')
  t.ok(held(m1, 'anapaula'), 'the entry stays until it expires: another holder may settle later')

  // A second settle, the hook again and another record of the same name:
  // nothing more.
  seeder._postNotices.settle(A.key)
  seeder._pushSettle('anapaula', [A.key])
  await grown(A, username(A.key, 'anapaula'))
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [ev(A.key, m1)], 'settled once, never again')

  // Quoting B and mentioning @bianca before B holds it: the quote is B's
  // push for that post, the later settle adds nothing.
  mark = pushes.length
  const m2 = await grown(C, postRecord({ text: 'olha @bianca', quote: { author: B.key, seq: 1 }, at: recent() }))
  s = await sentinel(pushes, C, A)
  t.alike(since(pushes, mark).map((p) => [p.kind, p.recipient, p.seq]), [['quote', B.key, m2], ['follow', A.key, s]], 'the quote pushes on the normal path')
  await verified(B, 'bianca')
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [], 'already pushed for this post: the settle is silent')

  // A self-mention of a name C verifies later stays silent, and goes: the
  // notice index dropped its rows, so another holder later gets no push.
  mark = pushes.length
  const m3 = await grown(C, postRecord({ text: 'eu sou @caio', at: recent() }))
  await sentinel(pushes, C, A)
  t.ok(held(m3, 'caio'), 'the mention waits')
  await verified(C, 'caio')
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [], 'self-mention: silent')
  t.absent(held(m3, 'caio'), 'the author gaining the name drops the waiting mention')
  await verified(B, 'caio')
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [], 'a later holder of the author\'s own name gets nothing')

  // A name settled while the block is still read (the actor name read is
  // held): pushed once, after the block's own pass, with the actor name.
  const H = await member(t, bootstrap, assoc, publicKey)
  await admit(H, assoc)
  const readName = seeder._pushActorName.bind(seeder)
  let holdNext = true
  let entered = false
  let release
  const hold = new Promise((resolve) => { release = resolve })
  seeder._pushActorName = async (key, entry) => {
    if (holdNext && key === C.key) {
      holdNext = false
      entered = true
      await hold
    }
    return readName(key, entry)
  }
  mark = pushes.length
  const m4 = C.diary.length
  await C.diary.append(postRecord({ text: 'oi @helena', at: recent() }))
  await until(() => entered, { name: 'leitura do nome em espera', timeoutMs: 30000 })
  await verified(H, 'helena')
  t.alike(mentions(mark), [], 'nothing while the block is read')
  release()
  await until(() => mentions(mark).length > 0, { name: 'menção após a passagem', timeoutMs: 30000 })
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [ev(H.key, m4)], 'a gain during the read pushes once, after the pass')
  seeder._pushActorName = readName

  // Past 24 h, by the record's at or by when it was held: silent, dropped.
  const F = await member(t, bootstrap, assoc, publicKey)
  await admit(F, assoc)
  mark = pushes.length
  const m5 = await grown(C, postRecord({ text: 'oi @fabiana', at: recent() }))
  const m6 = await grown(C, postRecord({ text: 'oi @fabi', at: recent() }))
  s = await sentinel(pushes, C, A)
  const DAY = 24 * 3600 * 1000
  seeder._pushPending.get(C.key + ':' + m5 + ':fabiana').at -= DAY
  seeder._pushPending.get(C.key + ':' + m6 + ':fabi').added -= DAY
  await verified(F, 'fabiana')
  await verified(F, 'fabi')
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [], 'an entry past 24 h never pushes')
  t.absent(held(m5, 'fabiana') || held(m6, 'fabi'), 'and is dropped')

  // A post C deleted before the name settles: silent, dropped.
  mark = pushes.length
  const m8 = await grown(C, postRecord({ text: 'oi @fabiola', at: recent() }))
  await grown(C, deleteRecord({ seq: m8 }))
  await until(() => seeder._served.get(C.key).deleted.has(m8), { name: 'apagado indexado' })
  t.absent(held(m8, 'fabiola'), 'the tombstone drops the waiting mention')
  await verified(F, 'fabiola')
  s = await sentinel(pushes, C, A)
  t.alike(mentions(mark), [], 'a deleted post never pushes')

  // The push cursor passes the tombstone before the scan applies it (scans
  // run one at a time): the waiting mention goes all the same.
  mark = pushes.length
  const applyDelete = seeder._applyDelete
  seeder._applyDelete = async (key, ...rest) => key === C.key ? true : applyDelete.call(seeder, key, ...rest)
  const m9 = await grown(C, postRecord({ text: 'oi @fatima', at: recent() }))
  await sentinel(pushes, C, A)
  t.ok(held(m9, 'fatima'), 'the mention waits')
  await grown(C, deleteRecord({ seq: m9 }))
  await sentinel(pushes, C, A)
  t.absent(seeder._served.get(C.key).deleted.has(m9), 'the scan has not applied the tombstone')
  t.absent(held(m9, 'fatima'), 'the push cursor drops the waiting mention')
  await verified(F, 'fatima')
  s = await sentinel(pushes, C, A)
  seeder._applyDelete = applyDelete
  t.alike(mentions(mark), [], 'a post deleted before the scan saw it never pushes')

  // At most 1024 entries, the oldest out first; at most 32 per actor, its
  // own oldest out first, so one actor cannot evict another's.
  const gone1 = [...seeder._pushPending.keys()]
  const Z = hex(randomBytes(32))
  seeder._pushHold(Z, 1, { type: 'post', text: '@ninguem', at: recent() }, Date.now())
  const X = hex(randomBytes(32))
  for (let i = 1; i <= 1030; i++) seeder._pushHold(X, i, { type: 'post', text: '@ninguem', at: recent() }, Date.now())
  t.is([...seeder._pushPending.values()].filter((e) => e.actor === X).length, 32, 'bounded per actor')
  t.absent(seeder._pushPending.has(X + ':998:ninguem'), 'the actor\'s own oldest went first')
  t.ok(seeder._pushPending.has(X + ':1030:ninguem'), 'its newest stays')
  t.ok(seeder._pushPending.has(Z + ':1:ninguem'), 'another actor\'s older entry stays')
  const actors = []
  for (let i = 0; i < 1030; i++) {
    actors.push(hex(randomBytes(32)))
    seeder._pushHold(actors[i], 1, { type: 'post', text: '@ninguem', at: recent() }, Date.now())
  }
  t.is(seeder._pushPending.size, 1024, 'bounded')
  t.absent(seeder._pushPending.has(Z + ':1:ninguem') || gone1.some((id) => seeder._pushPending.has(id)), 'the oldest went first')
  t.ok(seeder._pushPending.has(actors[1029] + ':1:ninguem'), 'the newest stays')

  // A blocked actor: its waiting mention never pushes.
  const E = await member(t, bootstrap, assoc, publicKey)
  await admit(E, assoc)
  mark = pushes.length
  const m7 = await grown(C, postRecord({ text: 'oi @eduarda', at: recent() }))
  await sentinel(pushes, C, A)
  t.ok(held(m7, 'eduarda'), 'the mention waits')
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [C.key], revokedIssuers: [] }, modKp, modCert))
  await until(() => seeder._isBlocked(C.key) && !seeder._served.has(C.key), { name: 'C bloqueado' })
  await verified(E, 'eduarda')
  await sentinel(pushes, E, A)
  t.alike(mentions(mark), [], 'blocked actor: silent')
  t.ok(pushes.every(validatePushEvent), 'every event passes validatePushEvent')
})

test('push: a waiting mention goes with its author, and each holder settling later gets one push', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuerKp = signingKeyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey), date: recent() }, assoc.kp)
  const username = (key, name) => createUsernameRecord({ member: key, username: name, date: recent() }, issuerKp, issuerCert)
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, pushes } = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex } })

  const A = await member(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  const B = await member(t, bootstrap, assoc, publicKey)
  await admit(B, assoc)
  const C = await member(t, bootstrap, assoc, publicKey, [profileRecord({ name: 'Caio', at: recent() })])
  await admit(C, assoc)
  await until(() => seeder._index.hints(C.key).profileSeq === 2, { name: 'perfil de C indexado' })

  const holds = (name, key) => seeder._postNotices.holders(name, () => true).includes(key)
  const held = (seq, token) => seeder._pushPending.has(C.key + ':' + seq + ':' + token)
  const mentions = (mark) => since(pushes, mark).filter((p) => p.kind === 'mention')
  const ev = (recipient, seq) => ({ v: 1, kind: 'mention', actor: C.key, recipient, seq, ref: C.key + ':' + seq, name: 'Caio' })
  const verified = async (m, name) => {
    await grown(m, username(m.key, name))
    await until(() => holds(name, m.key), { name: name + ' verificado' })
  }

  // Two holders of one name settling at different times: one push each.
  let mark = pushes.length
  const m1 = await grown(C, postRecord({ text: 'oi @antiga', at: recent() }))
  await sentinel(pushes, C, A)
  t.ok(held(m1, 'antiga'), 'the mention waits')
  await verified(A, 'antiga')
  await until(() => mentions(mark).length > 0, { name: 'primeira menção', timeoutMs: 30000 })
  await verified(B, 'antiga')
  await until(() => mentions(mark).length > 1, { name: 'segunda menção', timeoutMs: 30000 })
  await sentinel(pushes, C, A)
  t.alike(mentions(mark), [ev(A.key, m1), ev(B.key, m1)], 'each holder got one push')
  seeder._pushSettle('antiga', [A.key, B.key])
  t.alike(mentions(mark), [ev(A.key, m1), ev(B.key, m1)], 'never a second one')

  // The author's diary is dropped and served again before the name
  // settles: the waiting mention is gone, nothing pushes.
  mark = pushes.length
  const m2 = await grown(C, postRecord({ text: 'oi @sumida', at: recent() }))
  await sentinel(pushes, C, A)
  t.ok(held(m2, 'sumida'), 'the mention waits')
  seeder._drop(C.key, 'quota')
  t.absent(held(m2, 'sumida'), 'the drop forgets it')
  await until(() => !seeder._drops.has(C.key) && !seeder._dropping.has(C.key), { name: 'C purgado' })
  C.messages.length = 0
  await admit(C, assoc)
  await verified(A, 'sumida')
  await sentinel(pushes, C, A)
  t.alike(mentions(mark), [], 'a dropped author\'s waiting mention never pushes')
  t.ok(pushes.every(validatePushEvent), 'every event passes validatePushEvent')
})

test('push: a recall cancels only a push emitted within PUSH_RECALL_MS', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, pushes } = await startSeeder(t, bootstrap, dataDir, { seeder: { associationKey: assoc.hex } })

  const A = await member(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  const D = await member(t, bootstrap, assoc, publicKey)
  await admit(D, assoc)
  const E = await member(t, bootstrap, assoc, publicKey)
  await admit(E, assoc)
  // B already follows and likes A, D and E when it is admitted: history,
  // never pushed, so their undoing (a page closing) recalls nothing.
  const B = await member(t, bootstrap, assoc, publicKey, [
    followRecord({ key: A.key, on: true, at: recent() }),
    followRecord({ key: D.key, on: true, at: recent() }),
    followRecord({ key: E.key, on: true, at: recent() }),
    likeRecord({ to: { author: A.key, seq: 1 }, on: true, at: recent() })
  ])
  await admit(B, assoc)
  const cancels = (mark) => since(pushes, mark).filter((p) => p.op === 'cancel')

  let mark = pushes.length
  for (const m of [A, D, E]) await grown(B, followRecord({ key: m.key, on: false, at: recent() }))
  await grown(B, likeRecord({ to: { author: A.key, seq: 1 }, on: false, at: recent() }))
  await sentinel(pushes, B, A)
  t.alike(cancels(mark), [], 'a burst of offs for history: no cancel')

  // A push emitted longer than PUSH_RECALL_MS ago: past the send delay, so
  // its undoing recalls nothing.
  mark = pushes.length
  await grown(B, likeRecord({ to: { author: D.key, seq: 1 }, on: true, at: recent() }))
  await until(() => since(pushes, mark).some((p) => p.kind === 'like'), { name: 'curtida emitida', timeoutMs: 30000 })
  for (const id of seeder._pushSent.keys()) seeder._pushSent.set(id, Date.now() - 6 * MINUTE)
  await grown(B, likeRecord({ to: { author: D.key, seq: 1 }, on: false, at: recent() }))
  await sentinel(pushes, B, A)
  t.alike(cancels(mark), [], 'an old push is not recalled')

  // A recent push, then its recipient is blocked, then the undoing: the
  // cancel still goes out (it only drops a queued job).
  mark = pushes.length
  await grown(B, followRecord({ key: E.key, on: true, at: recent() }))
  await until(() => since(pushes, mark).some((p) => p.kind === 'follow' && p.recipient === E.key), { name: 'seguir emitido', timeoutMs: 30000 })
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [E.key], revokedIssuers: [] }, modKp, modCert))
  await until(() => seeder._isBlocked(E.key) && !seeder._served.has(E.key), { name: 'E bloqueado' })
  await grown(B, followRecord({ key: E.key, on: false, at: recent() }))
  await sentinel(pushes, B, A)
  t.alike(cancels(mark), [{ v: 1, op: 'cancel', kind: 'follow', actor: B.key, recipient: E.key, ref: null }], 'a recent push is recalled after a block')
  t.ok(pushes.every((p) => validatePushEvent(p) || validatePushCancel(p)), 'every emitted object is a valid event or cancel')
})
