// The member diary on Hypercore 10 (memory storage): versions, key shape,
// certificate then post, raw block 0 bytes, reopen on the same storage and a
// wrong-association certificate. Also member-ops reads on borrowed cores
// (ctx.cores), readAll's fixed end and what a replica downloading
// newest-first shows (readVisible).
const test = require('brittle')
const { createRequire } = require('node:module')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, createModeratorCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord, postRecord } = require('@varanda/core/lib/records')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createMember, APPEND_MODE } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { memoryNodeStorage } = require('../lib/node-storage')
const { DIARY_OPTIONS } = require('../lib/diary-options')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

const HEX64 = /^[0-9a-f]{64}$/

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

test('hypercore 10 here, hypercore 11 under @varanda/core', async (t) => {
  await testnet(t)
  const here = createRequire(require.resolve('../lib/member'))
  const core = createRequire(require.resolve('@varanda/core/lib/seeder'))
  t.is(here('hypercore/package.json').version, '10.38.2')
  t.is(core('hypercore/package.json').version, '11.39.0')
  t.is(here('compact-encoding/package.json').version, '3.5.2', 'the workspace itself pins compact-encoding 3')
  t.is(here('@hyperswarm/secret-stream/package.json').version, '6.9.2')
})

test('fresh member: certificate, post, raw block 0, reopen', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const storage = memoryStorage()

  const m = await createMember({ storage, association })
  t.teardown(() => m.close(), { force: true })
  t.ok(HEX64.test(m.key), 'key is hex64')
  t.ok(HEX64.test(m.publicKey), 'publicKey is hex64')
  t.comment('APPEND_MODE=' + APPEND_MODE + ' DIARY_OPTIONS=' + JSON.stringify(DIARY_OPTIONS))
  t.comment('key === publicKey: ' + (m.key === m.publicKey) +
    '; manifest version ' + (m.manifest ? m.manifest.version : null) +
    '; core.compat ' + m.core.core.compat)
  t.is(m.core.length, 0)

  await t.exception(() => m.post('cedo demais'), /certificado ausente/, 'no post before the certificate')

  const cert = createCert({ member: m.key }, assocKp)
  await m.setCert(cert)
  t.is(m.core.length, 1)
  await t.exception(() => m.setCert(cert), /certificado já gravado/)
  await m.post('primeiro poste')
  t.is(m.core.length, 2)

  const raw = await m.core.get(0, { valueEncoding: 'binary' })
  t.ok(b4a.isBuffer(raw) || raw instanceof Uint8Array, 'raw bytes')
  const block0 = JSON.parse(b4a.toString(raw, 'utf8'))
  t.is(block0.type, 'member-cert')
  t.is(block0.cert.member, m.key)
  t.alike(block0, await m.block(0))
  const expected = b4a.from(JSON.stringify({ type: 'member-cert', cert }), 'utf8')
  t.ok(b4a.equals(raw, expected), 'block 0 is exactly JSON.stringify bytes (no prefix)')

  const keyPair = m.keyPair
  await m.close()
  const again = await createMember({ storage, keyPair, association })
  t.teardown(() => again.close(), { force: true })
  t.is(again.key, m.key, 'same key after reopen')
  t.is(again.core.length, 2, 'same length after reopen')
  t.ok(again.core.writable, 'still writable')
  await again.post('terceiro registro')
  t.is(again.core.length, 3)
  t.is((await again.block(2)).text, 'terceiro registro')
})

test('overlapping writes are serialized: one certificate, then ordered posts', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const m = await createMember({ storage: memoryStorage(), association: hex(assocKp.publicKey) })
  t.teardown(() => m.close(), { force: true })
  const cert = createCert({ member: m.key }, assocKp)

  // Both calls start before either append lands: without the write lock both
  // see length 0 and the second certificate ends up in block 1.
  const results = await Promise.allSettled([m.setCert(cert), m.setCert(cert)])
  t.is(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one setCert fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  t.is(rejected.length, 1, 'exactly one setCert rejected')
  t.ok(/certificado já gravado/.test(rejected[0].reason.message), rejected[0].reason.message)
  t.is(m.core.length, 1, 'the certificate is the only block')
  t.is((await m.block(0)).type, 'member-cert')

  const [a, b] = await Promise.all([m.post('poste um'), m.post('poste dois')])
  t.is(a, 1, 'first concurrent post is block 1 (length 2)')
  t.is(b, 2, 'second concurrent post is block 2 (length 3)')
  t.is(m.core.length, 3)
  const block1 = await m.block(1)
  const block2 = await m.block(2)
  t.is(block1.type, 'post')
  t.is(block1.text, 'poste um')
  t.is(block2.type, 'post')
  t.is(block2.text, 'poste dois')
  t.is(validateRecord(block1, 1), null, 'block 1 validates at index 1')
  t.is(validateRecord(block2, 2), null, 'block 2 validates at index 2')
})

test('reopening without a key pair restores the stored identity', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const storage = memoryStorage()
  const original = crypto.keyPair()

  const m = await createMember({ storage, keyPair: original, association })
  t.teardown(() => m.close(), { force: true })
  t.is(m.publicKey, hex(original.publicKey), 'created with the given key pair')
  t.is(m.key, m.publicKey, 'compat: key === publicKey')
  t.ok(b4a.equals(m.core.keyPair.publicKey, original.publicKey), 'core signs with the given key pair')
  await m.setCert(createCert({ member: m.key }, assocKp))
  await m.post('antes de reabrir')
  t.is(m.core.length, 2)
  await m.close()

  const again = await createMember({ storage, association })
  t.teardown(() => again.close(), { force: true })
  t.is(again.key, m.key, 'same key without passing the key pair')
  t.is(again.publicKey, m.key, 'publicKey === key')
  t.is(again.publicKey, hex(again.core.keyPair.publicKey), 'publicKey is the core\'s own public key')
  t.ok(b4a.equals(again.keyPair.publicKey, original.publicKey), 'keyPair.publicKey restored')
  t.ok(b4a.equals(again.keyPair.secretKey, original.secretKey), 'keyPair.secretKey restored')
  t.is(again.core.length, 2)
  t.ok(again.core.writable, 'writable with the restored key pair')
  await again.post('depois de reabrir')
  t.is(again.core.length, 3)
  t.is((await again.block(2)).text, 'depois de reabrir')
  await again.close()

  await t.exception(
    () => createMember({ storage, keyPair: crypto.keyPair(), association }),
    /chave não corresponde ao diário/,
    'another key pair does not open this diary'
  )
  const third = await createMember({ storage, keyPair: original, association })
  t.teardown(() => third.close(), { force: true })
  t.is(third.core.length, 3, 'the storage is intact after the refused open')
})

test('a certificate from another association is rejected', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const otherKp = generateAssociationKeyPair()
  const m = await createMember({ storage: memoryStorage(), association: hex(assocKp.publicKey) })
  t.teardown(() => m.close(), { force: true })
  await t.exception(() => m.setCert(createCert({ member: m.key }, otherKp)), /certificado rejeitado/)
  const other = await createMember({ storage: memoryStorage(), association: hex(assocKp.publicKey) })
  t.teardown(() => other.close(), { force: true })
  await t.exception(() => m.setCert(createCert({ member: other.key }, assocKp)), /certificado rejeitado: member-mismatch/)
  t.is(m.core.length, 0, 'nothing appended')
})

test('the certificate is copied before verification: a later change by the caller is not stored', async (t) => {
  await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const m = await createMember({ storage: memoryStorage(), association, ...DIARY_OPTIONS })
  t.teardown(() => m.close(), { force: true })
  const cert = createCert({ member: m.key }, assocKp)
  const original = cert.ageBand
  const pending = m.setCert(cert)
  cert.ageBand = 'mudou-depois'
  await pending
  const block0 = await m.block(0)
  t.is(block0.cert.ageBand, original, 'block 0 holds the certificate as verified')
  t.is(validateRecord(block0, 0), null, 'block 0 is a valid member-cert record')
})

// ---- borrowed cores (ctx.cores): member-ops reads on the cores a live
// sync run holds, never opening, closing or purging any ----

function moderator (assocKp) {
  const keyPair = crypto.keyPair()
  return { keyPair, cert: createModeratorCert({ moderator: hex(keyPair.publicKey) }, assocKp) }
}

async function copyCore (from, to) {
  const a = from.replicate(true)
  const b = to.replicate(false)
  a.pipe(b).pipe(a)
  await to.download({ start: 0, end: from.length }).done()
  a.destroy()
  b.destroy()
}

// A certified member of `assoc` on its own storage, with a profile and
// `texts` as posts. noClear: a deletion keeps the bytes, so a copy still
// fetches every block.
async function author (assoc, name, texts) {
  const ctx = { storage: memoryNodeStorage(), association: assoc.hex, keyPair: crypto.keyPair(), noClear: true }
  const { publicKey } = await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: publicKey }, assoc.kp))
  await ops.profileSet(ctx, { name })
  const seqs = []
  for (const text of texts) seqs.push((await ops.postCreate(ctx, { text })).seq)
  return { ctx, key: publicKey, seqs }
}

// The reader's storage: its own diary (one post, a like of A's 2nd post),
// full replicas of A (whose 1st post is deleted) and B, both followed.
// A and B are sorted by key, so A is scanned first.
async function readerFixture () {
  const assoc = association()
  const me = await author(assoc, 'Eu', ['minha'])
  const [A, B] = (await Promise.all([author(assoc, 'Ana', ['a1', 'a2']), author(assoc, 'Bia', ['b1', 'b2'])]))
    .sort((x, y) => (x.key < y.key ? -1 : 1))
  await ops.postDelete(A.ctx, { to: { author: A.key, seq: A.seqs[0] } })
  const storage = me.ctx.storage
  for (const other of [A, B]) {
    const source = await store.openDiary(other.ctx.storage)
    const local = await store.openReplica(storage, other.key)
    await copyCore(source, local)
    await local.close()
    await source.close()
  }
  await store.writeFollows(storage, [A.key, B.key])
  await ops.likeSet(me.ctx, { to: { author: A.key, seq: A.seqs[1] }, on: true })
  const ctx = { storage, association: assoc.hex }
  return { assoc, me, A, B, storage, ctx }
}

// The cores a run would hold: the diary read-only and the given replicas.
async function borrow (t, storage, keys) {
  const diary = await store.openDiary(storage)
  const replicas = new Map()
  for (const key of keys) replicas.set(key, await store.openReplica(storage, key))
  t.teardown(async () => {
    for (const core of [diary, ...replicas.values()]) await core.close().catch(() => {})
  }, { force: true })
  return { diary, replicas, cores: { diary, replica: (key) => replicas.get(key) || null } }
}

// Holds core.get(index) until release(); hit settles once it is reached.
function hang (core, index) {
  let release
  let reached
  const gate = new Promise((resolve) => { release = resolve })
  const hit = new Promise((resolve) => { reached = resolve })
  const get = core.get.bind(core)
  core.get = async (i, opts) => {
    if (i === index) {
      reached()
      await gate
    }
    return get(i, opts)
  }
  return { hit, release }
}

async function readAllOps (ctx, f) {
  return {
    feed: await ops.feedRead(ctx),
    ownLog: await ops.logRead(ctx),
    logA: await ops.logRead(ctx, { author: f.A.key }),
    logB: await ops.logRead(ctx, { author: f.B.key }),
    profiles: await ops.profileRead(ctx, { authors: [f.me.key, f.A.key, f.B.key, 'ab'.repeat(32)] }),
    engagement: await ops.engagementRead(ctx, { refs: [f.A.key + ':' + f.A.seqs[1], f.B.key + ':' + f.B.seqs[0]] })
  }
}

test('borrowed cores: every read answers exactly as the exclusive path', async (t) => {
  await testnet(t)
  const f = await readerFixture()
  const exclusive = await readAllOps(f.ctx, f)
  t.ok(exclusive.logA.entries.some((e) => e.deleted === true), 'fixture: A holds a deleted post')
  t.is(exclusive.engagement.liked.length, 1, 'fixture: one like')
  const { cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
  // The answer must come from the borrowed cores alone.
  const saved = { openDiary: store.openDiary, openReplica: store.openReplica }
  t.teardown(() => Object.assign(store, saved), { force: true })
  store.openDiary = store.openReplica = async () => { throw new Error('opened a core') }
  const borrowed = await readAllOps({ ...f.ctx, cores }, f)
  Object.assign(store, saved)
  t.alike(borrowed, exclusive)
})

test('borrowed cores: nothing is opened, closed or purged', async (t) => {
  await testnet(t)
  const f = await readerFixture()
  const C = hex(crypto.keyPair().publicKey)
  const empty = await store.openReplica(f.storage, C)
  await empty.close()
  t.ok(await store.replicaExists(f.storage, C), 'fixture: an empty stored replica')
  await store.writeFollows(f.storage, [f.A.key, f.B.key, C])
  const { diary, replicas, cores } = await borrow(t, f.storage, [f.A.key, f.B.key, C])

  const calls = []
  const saved = { openDiary: store.openDiary, openReplica: store.openReplica, purgeReplica: store.purgeReplica }
  t.teardown(() => Object.assign(store, saved), { force: true })
  for (const name of Object.keys(saved)) {
    store[name] = (...args) => {
      calls.push(name)
      return saved[name](...args)
    }
  }
  const core = f.storage.core
  f.storage.core = (...args) => {
    calls.push('core')
    return core(...args)
  }
  const ctx = { ...f.ctx, cores }
  const feed = await ops.feedRead(ctx)
  await ops.logRead(ctx, { author: C })
  await ops.profileRead(ctx, { authors: [f.A.key, C] })
  await ops.engagementRead(ctx, { refs: [] })
  await ops.ownNoticeContext(ctx)
  Object.assign(store, saved)
  f.storage.core = core
  t.alike(calls, [], 'no open, no purge')
  t.ok([diary, ...replicas.values()].every((c) => !c.closing), 'no borrowed core closed')
  t.ok(await store.replicaExists(f.storage, C), 'the empty replica is not purged')
  t.alike(feed.skipped, [{ key: C, reason: 'no-cert' }])
})

test('borrowed cores: no local data reads as today, a stored replica the run does not hold needs the exclusive path', async (t) => {
  await testnet(t)
  const f = await readerFixture()
  const D = hex(crypto.keyPair().publicKey)
  await store.writeFollows(f.storage, [f.A.key, f.B.key, D])
  const held = await borrow(t, f.storage, [f.A.key, f.B.key])
  const ctx = { ...f.ctx, cores: held.cores }
  t.alike((await ops.feedRead(ctx)).skipped, [{ key: D, reason: 'no-cert' }])
  await t.exception(() => ops.logRead(ctx, { author: D }), /sem dados locais para este diário/)
  t.alike((await ops.profileRead(ctx, { authors: [D] })).missing, [D])
  t.absent(await store.replicaExists(f.storage, D), 'nothing created')

  const partial = { ...f.ctx, cores: { diary: held.diary, replica: (key) => (key === f.A.key ? held.replicas.get(key) : null) } }
  const needs = async (p) => {
    try {
      await p
    } catch (err) {
      return ops.isNeedsExclusive(err)
    }
    return false
  }
  t.ok(await needs(ops.feedRead(partial)), 'feedRead')
  t.ok(await needs(ops.logRead(partial, { author: f.B.key })), 'logRead')
  t.ok(await needs(ops.profileRead(partial, { authors: [f.B.key] })), 'profileRead')
  t.ok(ops.isNeedsExclusive(Object.assign(new Error('x'), { code: 'NEEDS_EXCLUSIVE' })))
  t.absent(ops.isNeedsExclusive(new Error('x')))
  t.absent(ops.isNeedsExclusive(null))
})

test('borrowed cores: a key pair of another identity needs the exclusive path, which refuses it', async (t) => {
  await testnet(t)
  const f = await readerFixture()
  const { cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
  const own = await ops.logRead({ ...f.ctx, keyPair: f.me.ctx.keyPair, cores })
  t.is(own.key, f.me.key, 'the matching pair reads on the borrowed diary')
  const other = { ...f.ctx, keyPair: crypto.keyPair() }
  await t.exception(() => ops.logRead(other), /passkey não corresponde ao diário guardado/, 'exclusive path')
  let err = null
  try {
    await ops.logRead({ ...other, cores })
  } catch (e) {
    err = e
  }
  t.ok(ops.isNeedsExclusive(err), 'borrowed path defers to the exclusive one')
})

test('borrowed cores: a core closed under the read needs the exclusive path', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const f = await readerFixture()
  const { diary, replicas, cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
  const ctx = { ...f.ctx, cores }

  const b = replicas.get(f.B.key)
  const held = hang(b, 1)
  const feed = ops.feedRead(ctx).then(() => null, (err) => err)
  await held.hit
  await b.close()
  held.release()
  t.ok(ops.isNeedsExclusive(await feed), 'feedRead: the replica closed')

  const own = hang(diary, 1)
  const engagement = ops.engagementRead(ctx, { refs: [] }).then(() => null, (err) => err)
  await own.hit
  await diary.close()
  own.release()
  t.ok(ops.isNeedsExclusive(await engagement), 'engagementRead: the diary closed')
})

test('borrowed cores: a blocklist snapshot adopted during the read decides the answer', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const f = await readerFixture()
  const mod = moderator(f.assoc.kp)
  const { replicas, cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
  const ctx = { ...f.ctx, cores }
  const b = replicas.get(f.B.key)
  const a = replicas.get(f.A.key)
  const block = (seq) => store.writeBlocklist(f.storage, createSnapshot({ seq, blocked: [f.A.key], revokedIssuers: [] }, mod.keyPair, mod.cert))
  const unblock = (seq) => store.writeBlocklist(f.storage, createSnapshot({ seq, blocked: [], revokedIssuers: [] }, mod.keyPair, mod.cert))

  let held = hang(b, 1)
  const feedP = ops.feedRead(ctx)
  await held.hit
  await block(1)
  held.release()
  const feed = await feedP
  delete b.get
  t.absent(feed.items.some((item) => item.author === f.A.key), 'no item of the blocked author')
  t.alike(feed.skipped, [{ key: f.A.key, reason: 'blocked' }])

  await unblock(2)
  held = hang(b, 1)
  const profileP = ops.profileRead(ctx, { authors: [f.A.key, f.B.key] })
  await held.hit
  await block(3)
  held.release()
  const profiles = await profileP
  delete b.get
  t.alike(profiles.missing, [f.A.key])
  t.alike(profiles.profiles.map((p) => p.author), [f.B.key])

  await unblock(4)
  held = hang(a, 1)
  const logP = ops.logRead(ctx, { author: f.A.key }).then(() => null, (err) => err)
  await held.hit
  await block(5)
  held.release()
  const err = await logP
  t.ok(err && /sem dados locais para este diário/.test(err.message), 'logRead of the blocked author')
})

test('borrowed cores: a followed key with no local data blocked during the reads is skipped as blocked', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const f = await readerFixture()
  const mod = moderator(f.assoc.kp)
  const D = hex(crypto.keyPair().publicKey)
  await store.writeFollows(f.storage, [f.A.key, f.B.key, D])
  const { replicas, cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
  const held = hang(replicas.get(f.B.key), 1)
  const feedP = ops.feedRead({ ...f.ctx, cores })
  await held.hit
  await store.writeBlocklist(f.storage, createSnapshot({ seq: 1, blocked: [D], revokedIssuers: [] }, mod.keyPair, mod.cert))
  held.release()
  t.alike((await feedP).skipped, [{ key: D, reason: 'blocked' }])
})

// Runs op while B's read hangs, after A's read is done: change(a) then
// release.
async function underRead (f, replicas, op, change) {
  const b = replicas.get(f.B.key)
  const held = hang(b, 1)
  const p = op().then((value) => ({ value }), (err) => ({ err }))
  await held.hit
  await change(replicas.get(f.A.key))
  held.release()
  const out = await p
  delete b.get
  return out
}

test('borrowed cores: a fork seen after the read is judged as a fork', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const f = await readerFixture()
  const { replicas, cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
  const ctx = { ...f.ctx, cores }
  const a = replicas.get(f.A.key)
  t.teardown(() => { delete a.fork }, { force: true })
  const fork = async (core) => { Object.defineProperty(core, 'fork', { value: 1, configurable: true }) }

  const feed = await underRead(f, replicas, () => ops.feedRead(ctx), fork)
  t.alike(feed.value.skipped, [{ key: f.A.key, reason: 'fork' }])
  t.absent(feed.value.items.some((item) => item.author === f.A.key), 'no item of the forked author')
  delete a.fork

  const profiles = await underRead(f, replicas, () => ops.profileRead(ctx, { authors: [f.A.key, f.B.key] }), fork)
  t.alike(profiles.value.missing, [f.A.key])
  t.alike(profiles.value.profiles.map((p) => p.author), [f.B.key])
})

test('borrowed cores: a core closed after its read needs the exclusive path', async (t) => {
  t.timeout(30000)
  await testnet(t)
  for (const name of ['feedRead', 'profileRead']) {
    const f = await readerFixture()
    const { replicas, cores } = await borrow(t, f.storage, [f.A.key, f.B.key])
    const ctx = { ...f.ctx, cores }
    const op = name === 'feedRead' ? () => ops.feedRead(ctx) : () => ops.profileRead(ctx, { authors: [f.A.key, f.B.key] })
    const out = await underRead(f, replicas, op, (core) => core.close())
    t.ok(ops.isNeedsExclusive(out.err), name)
  }
})

test('readAll returns the blocks present when it started, not those appended under it', async (t) => {
  await testnet(t)
  const assoc = association()
  const me = await author(assoc, 'Eu', ['um', 'dois'])
  const diary = await store.openDiary(me.ctx.storage, me.ctx.keyPair)
  t.teardown(() => diary.close(), { force: true })
  const length = diary.length
  const get = diary.get.bind(diary)
  let appended = false
  diary.get = async (i, opts) => {
    if (!appended) {
      appended = true
      await store.appendRecord(diary, postRecord({ text: 'durante' }))
    }
    return get(i, opts)
  }
  const entries = await store.readAll(diary)
  t.ok(appended && diary.length === length + 1, 'fixture: a block was appended under the read')
  t.is(entries.length, length, 'only the prefix present at the start')
})

// ---- newest-first replicas (store.readVisible): block 0 and the newest
// run of a followed diary are shown while the middle is still missing ----

// A certified member with posts t0..t{n-1}; `name` null writes no profile
// first; `issuer` ({ kp, cert }) certifies it instead of the association.
async function longAuthor (assoc, { name = 'Ana', posts = 40, issuer = null } = {}) {
  const ctx = { storage: memoryNodeStorage(), association: assoc.hex, keyPair: crypto.keyPair(), noClear: true }
  const { publicKey } = await ops.idCreate(ctx)
  const cert = issuer === null ? createCert({ member: publicKey }, assoc.kp) : createIssuedCert({ member: publicKey }, issuer.kp, issuer.cert)
  await ops.certAdd(ctx, cert)
  if (name !== null) await ops.profileSet(ctx, { name })
  const seqs = []
  for (let i = 0; i < posts; i++) seqs.push((await ops.postCreate(ctx, { text: 't' + i })).seq)
  return { ctx, key: publicKey, seqs }
}

// Copies only the blocks of `ranges` ([start, end) pairs) of W's diary into
// a replica on `storage`, then clears `clear` there: what a newest-first
// download leaves while the history is on its way.
async function windowed (storage, W, ranges, clear = []) {
  const source = await store.openDiary(W.ctx.storage)
  const local = await store.openReplica(storage, W.key)
  const a = source.replicate(true)
  const b = local.replicate(false)
  a.pipe(b).pipe(a)
  for (const [start, end] of ranges) await local.download({ start, end }).done()
  a.destroy()
  b.destroy()
  for (const seq of clear) await local.clear(seq)
  const length = local.length
  await local.close()
  await source.close()
  return length
}

// The reader (one own post) following W, whose replica holds [0, 3) and
// the blocks from `from` (counted back from the end) up to its length.
async function newestFixture (W, assoc, { back = 12, top = true, clear = [] } = {}) {
  const me = await author(assoc, 'Eu', ['minha'])
  const source = await store.openDiary(W.ctx.storage)
  const length = source.length
  await source.close()
  const ranges = [[0, 3], [length - back, top ? length : length - 1]]
  t0ok(await windowed(me.ctx.storage, W, ranges, clear) === length)
  await store.writeFollows(me.ctx.storage, [W.key])
  return { me, storage: me.ctx.storage, ctx: { storage: me.ctx.storage, association: assoc.hex }, length }
}

function t0ok (ok) {
  if (!ok) throw new Error('fixture: the replica does not know the signed length')
}

function textsOf (feed, key) {
  return feed.items.filter((i) => i.author === key).map((i) => i.text).sort()
}

function texts (from, to) {
  return Array.from({ length: to - from }, (_, i) => 't' + (from + i)).sort()
}

test('newest-first: the feed shows block 0\'s prefix and the newest run, never the middle, also borrowed', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  const f = await newestFixture(W, assoc)
  // Blocks 0..2: certificate, profile, t0; the run: the last 12 posts.
  const want = ['t0', ...texts(28, 40)].sort()
  const exclusive = await ops.feedRead(f.ctx)
  t.alike(textsOf(exclusive, W.key), want)
  t.alike(exclusive.incomplete, [W.key])
  t.ok(exclusive.items.filter((i) => i.author === W.key).every((i) => i.name === 'Ana'))
  const { cores } = await borrow(t, f.storage, [W.key])
  const borrowed = await ops.feedRead({ ...f.ctx, cores })
  t.alike(borrowed, exclusive, 'the borrowed path answers the same')
})

test('newest-first: a run that does not reach the signed length shows the prefix only', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  const f = await newestFixture(W, assoc, { top: false })
  const feed = await ops.feedRead(f.ctx)
  t.alike(textsOf(feed, W.key), ['t0'])
  t.alike(feed.incomplete, [W.key])
})

test('newest-first: a tombstone in the run hides its target in the prefix and in the run, cleared or not', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  const run = W.seqs[30]
  const kept = W.seqs[33]
  await ops.postDelete(W.ctx, { to: { author: W.key, seq: W.seqs[0] } })
  await ops.postDelete(W.ctx, { to: { author: W.key, seq: run } })
  await ops.postDelete(W.ctx, { to: { author: W.key, seq: kept } })
  // The run is the last 12 posts and the 3 tombstones; t33's block is
  // cleared here, t30's is still held.
  const f = await newestFixture(W, assoc, { back: 15, clear: [kept] })
  const feed = await ops.feedRead(f.ctx)
  t.alike(textsOf(feed, W.key), texts(28, 40).filter((x) => x !== 't30' && x !== 't33'))
  const { cores } = await borrow(t, f.storage, [W.key])
  t.alike(await ops.feedRead({ ...f.ctx, cores }), feed, 'borrowed')
})

test('newest-first: blocked and revoked authors stay hidden from feed and profile, borrowed included', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const assoc = association()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp) }
  const W = await longAuthor(assoc, { issuer })
  const f = await newestFixture(W, assoc)
  t.alike(textsOf(await ops.feedRead(f.ctx), W.key).length, 13, 'fixture: shown before any snapshot')
  const mod = moderator(assoc.kp)
  const snapshots = [
    { seq: 1, blocked: [W.key], revokedIssuers: [], reason: 'blocked' },
    { seq: 2, blocked: [], revokedIssuers: [hex(issuerKp.publicKey)], reason: 'revoked-issuer' }
  ]
  for (const { seq, blocked, revokedIssuers, reason } of snapshots) {
    await store.writeBlocklist(f.storage, createSnapshot({ seq, blocked, revokedIssuers }, mod.keyPair, mod.cert))
    // The exclusive reads first: they open and close the replica.
    for (const path of ['exclusive', 'borrowed']) {
      const held = path === 'borrowed' ? await borrow(t, f.storage, [W.key]) : null
      const ctx = held === null ? f.ctx : { ...f.ctx, cores: held.cores }
      const feed = await ops.feedRead(ctx)
      t.absent(feed.items.some((i) => i.author === W.key), reason + ', ' + path + ': no item')
      t.alike(feed.skipped, [{ key: W.key, reason }])
      t.alike(feed.incomplete, [])
      t.alike((await ops.profileRead(ctx, { authors: [W.key] })).missing, [W.key], reason + ', ' + path + ': no profile')
      if (held !== null) {
        for (const core of [held.diary, ...held.replicas.values()]) await core.close()
      }
    }
  }
})

test('newest-first: profile.read takes the newest profile in the run; one only in the middle is not read', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  await ops.profileSet(W.ctx, { name: 'Ana Nova' })
  const f = await newestFixture(W, assoc)
  const read = await ops.profileRead(f.ctx, { authors: [W.key] })
  t.is(read.profiles[0].name, 'Ana Nova', 'the run\'s profile wins over the prefix one')
  t.ok((await ops.feedRead(f.ctx)).items.filter((i) => i.author === W.key).every((i) => i.name === 'Ana Nova'), 'the feed names it the same')

  const N = await longAuthor(assoc, { name: null, posts: 20 })
  await ops.profileSet(N.ctx, { name: 'Meio' })
  for (let i = 0; i < 20; i++) await ops.postCreate(N.ctx, { text: 'u' + i })
  const g = await newestFixture(N, assoc)
  const nameless = await ops.profileRead(g.ctx, { authors: [N.key] })
  t.alike(nameless.missing, [])
  t.is(nameless.profiles[0].name, null, 'a profile only in the middle reads null')
})

test('newest-first: paging with before goes through the run, then the prefix, without overlap', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  const f = await newestFixture(W, assoc)
  const all = (await ops.feedRead(f.ctx)).items
  const pages = []
  let before = null
  for (;;) {
    const page = (await ops.feedRead(f.ctx, { limit: 5, before })).items
    if (page.length === 0) break
    pages.unshift(...page)
    before = { at: page[0].at, author: page[0].author, seq: page[0].seq }
  }
  t.alike(pages, all, 'the pages put together are the whole feed')
  const own = pages.filter((i) => i.author === W.key).map((i) => i.text)
  t.alike(own, ['t0', ...Array.from({ length: 12 }, (_, i) => 't' + (28 + i))], 'the prefix, then the run, in time order')
})

test('newest-first: log.read of a followed author still ends at the present length', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  const f = await newestFixture(W, assoc)
  const log = await ops.logRead(f.ctx, { author: W.key })
  t.is(log.entries.length, 3)
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2])
  const { cores } = await borrow(t, f.storage, [W.key])
  t.alike(await ops.logRead({ ...f.ctx, cores }, { author: W.key }), log, 'borrowed')
})

test('newest-first: a tombstone that arrives after the scan never bridges the run to the post it deletes', async (t) => {
  await testnet(t)
  const assoc = association()
  const W = await longAuthor(assoc)
  const target = W.seqs[37]
  const { seq: D } = await ops.postDelete(W.ctx, { to: { author: W.key, seq: target } })
  await ops.postCreate(W.ctx, { text: 'u1' })
  await ops.postCreate(W.ctx, { text: 'u2' })
  const me = await author(assoc, 'Eu', ['minha'])
  const source = await store.openDiary(W.ctx.storage)
  const length = source.length
  await source.close()
  // Everything of the newest run but the tombstone itself.
  t0ok(await windowed(me.ctx.storage, W, [[0, 3], [length - 12, D], [D + 1, length]]) === length)
  await store.writeFollows(me.ctx.storage, [W.key])
  const ctx = { storage: me.ctx.storage, association: assoc.hex }
  const held = await borrow(t, me.ctx.storage, [W.key])
  // The live core now answers that the tombstone is stored (it arrived
  // after the scan); the scan itself still found a hole there.
  const core = held.replicas.get(W.key)
  const has = core.has.bind(core)
  core.has = async (i) => (i === D ? true : has(i))
  const feed = await ops.feedRead({ ...ctx, cores: held.cores })
  t.absent(textsOf(feed, W.key).includes('t37'), 'the deleted post is not shown')
  t.alike(textsOf(feed, W.key), ['t0', 'u1', 'u2'])
})
