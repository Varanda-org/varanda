// The browser node session's RPC handlers (lib/session.js through lib/node.js
// and an in-memory client), on memory storage. No seeder here: the sync runs
// dial a loopback port nothing listens on (session-e2e.test.js,
// sync-gate.test.js and passkey-e2e.test.js cover a seeder), so the
// fixtures turn the write gate off; the one gate test here turns it on to
// see it refuse. The exception is the two-device username.add test, which
// runs the gate against a fake seeder (sync-gate.test.js's stand-in) to see
// the record of another device arrive before the duplicate check.
const test = require('brittle')
const assert = require('node:assert/strict')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocket, WebSocketServer } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { createCert, createIssuerCert, createSeederCert, createModeratorCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { FEED_INCOMPLETE_MAX } = require('@varanda/rpc')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { latestUsername } = require('@varanda/core/lib/username')
const { verifyAccountLink } = require('@varanda/core/lib/account-link')
const { verifyReport } = require('@varanda/core/lib/report')
const { verifyTerms } = require('@varanda/core/lib/terms')
const { verifyInvite } = require('@varanda/core/lib/invite')
const { verifyPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')
const { writeBlocklist } = require('../lib/node-store')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const MISMATCH = 'passkey não corresponde ao diário guardado'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A loopback port with nothing listening (bound, then released).
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// True when some file of the 'diary' core holds `needle`.
async function diaryHolds (storage, needle) {
  let found = false
  for (const name of ['oplog', 'tree', 'bitfield', 'data', 'header']) {
    const file = storage.core('diary')(name)
    const { size } = await new Promise((resolve, reject) => file.stat((err, v) => (err ? reject(err) : resolve(v))))
    if (size > 0) {
      const buf = await new Promise((resolve, reject) => file.read(0, size, (err, v) => (err ? reject(err) : resolve(v))))
      if (b4a.indexOf(buf, needle) !== -1) found = true
    }
    await new Promise((resolve) => file.close(() => resolve()))
  }
  return found
}

// The blocklist fixture of blocklist.test.js: a moderator certified by the
// association and a snapshot it signs.
function moderator (assocKp) {
  const keyPair = crypto.keyPair()
  return { keyPair, cert: createModeratorCert({ moderator: hex(keyPair.publicKey) }, assocKp) }
}

function snapshot (mod, { seq = 1, blocked = [], revokedIssuers = [] }) {
  return createSnapshot({ seq, blocked, revokedIssuers }, mod.keyPair, mod.cert)
}

// Stores a local replica of `source` (a Hypercore 10 core) in the node
// storage, as a sync run would, by replicating in memory; the replica core
// is closed again before the node opens it.
async function storeReplica (storage, source, upto = source.length) {
  const key = hex(source.key)
  const replica = new Hypercore(storage.core('replica/' + key), source.key, { valueEncoding: 'binary' })
  await replica.ready()
  const a = source.replicate(true)
  const b = replica.replicate(false)
  a.pipe(b).pipe(a)
  await replica.download({ start: 0, end: upto }).done()
  if (replica.length !== source.length) await replica.update()
  assert.equal(replica.length, source.length)
  a.destroy()
  b.destroy()
  await replica.close()
  return key
}

// keyPair: the identity pair handed to the node before anything else (null
// = the node stays locked).
async function setup (t, { storage = memoryNodeStorage(), assoc = association(), keyPair = crypto.keyPair(), ...options } = {}) {
  const port = await deadPort()
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  return { node, web, assoc, storage, keyPair, internal }
}

// A seeder stand-in (as sync-gate.test.js): role 'seeder' with a certificate
// signed by `signer`, replicating and advertising `cores`; it admits an
// announced diary at the length the member advertised.
async function fakeSeeder (t, { signer, cores = [] }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of cores) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          if (msg.type !== 'announce') return
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The runs started since event index `from`: [{ runId, lines, stopped }].
async function runsSince (web, from) {
  const out = []
  for (const e of web.events.slice(from)) {
    if (e.name !== 'sync.started') continue
    const { runId } = e.data
    const lines = web.events.filter((x) => x.name === 'sync.event' && x.data.runId === runId).map((x) => x.data.line)
    out.push({ runId, lines, stopped: await stoppedOf(web.events, runId) })
  }
  return out
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

test('configuration is checked before anything starts', async (t) => {
  await testnet(t)
  const base = { storage: memoryNodeStorage(), association: association().hex, seederUrl: 'wss://semeador.example/seeder', createSocket: () => null }
  t.ok(createBrowserSession(base))
  t.exception(() => createBrowserSession({ ...base, association: 'xyz' }), /chave da associação inválida/)
  for (const seederUrl of ['http://semeador.example/seeder', 'ws://user:pw@semeador.example/', 'ws://semeador.example/?a=1', 'ws://semeador.example/#x', 'ws://', '', 42]) {
    t.exception(() => createBrowserSession({ ...base, seederUrl }), /endereço do semeador inválido/, String(seederUrl))
  }
  t.exception.all(() => createBrowserSession({ ...base, createSocket: null }), /createSocket required/)
  t.exception.all(() => createBrowserSession({ ...base, storage: null }), /storage required/)
})

test('before an identity exists', async (t) => {
  await testnet(t)
  const { web, storage } = await setup(t)
  t.alike(await web.request('node.info'), {
    publicKey: null,
    memberCert: false,
    followCount: 0,
    sync: { state: 'idle' },
    publicDht: false
  })
  for (const [method, params] of [['identity.show', {}], ['post.create', { text: 'x' }], ['follow.list', {}], ['sync.start', {}], ['feed.read', {}], ['profile.read', { authors: ['a'.repeat(64)] }], ['peek.read', {}]]) {
    const err = await errorOf(web.request(method, params))
    t.is(err && err.code, 'NOT_FOUND', method)
    t.is(err && err.message, 'identidade não encontrada', method)
  }
  t.absent(await storage.hasCore('diary'), 'nothing was created')
  t.is(await storage.readJson('config'), null)
})

test('identity and member certificate', async (t) => {
  await testnet(t)
  const { web, assoc } = await setup(t)
  const created = await web.request('identity.create')
  t.is(created.association, assoc.hex)
  t.alike(await web.request('identity.create'), created, 'idempotent')
  t.alike(await web.request('identity.show'), created)
  const key = created.publicKey

  const genesis = await errorOf(web.request('post.create', { text: 'cedo demais' }))
  t.is(genesis.code, 'USAGE')
  t.is(genesis.message, 'grave o certificado de membro antes de publicar')

  const other = generateAssociationKeyPair()
  const foreign = await errorOf(web.request('cert.add', { cert: createCert({ member: key }, other) }))
  t.is(foreign.message, 'certificado inválido (untrusted-association)')
  const someoneElse = await errorOf(web.request('cert.add', { cert: createCert({ member: 'ab'.repeat(32) }, assoc.kp) }))
  t.is(someoneElse.code, 'USAGE')
  t.ok(/^certificado inválido \(/.test(someoneElse.message))

  const cert = createCert({ member: key }, assoc.kp)
  t.alike(await web.request('cert.add', { cert }), { seq: 0 })
  t.alike(await web.request('cert.add', { cert }), { seq: 0 }, 'the same certificate again is ok')
  const second = await errorOf(web.request('cert.add', { cert: createCert({ member: key, ageBand: '60+' }, assoc.kp) }))
  t.is(second.message, 'certificado já gravado')
  const info = await web.request('node.info')
  t.is(info.publicKey, key)
  t.is(info.memberCert, true)
})

test('profile, posts, replies, log and feed of the own diary', async (t) => {
  await testnet(t)
  const { web, key } = await certified(t)
  t.alike(await web.request('profile.set', { name: 'Bia', bio: 'oi' }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('post.create', { text: 'primeira' }), { seq: 2, ref: key + ':2' })
  t.alike(await web.request('post.reply', { to: key + ':2', text: 'resposta' }), { seq: 3, ref: key + ':3' })
  const badRecord = await errorOf(web.request('post.create', { text: 'a\u0000b' }))
  t.is(badRecord.message, 'registro inválido: control-chars')

  const log = await web.request('log.read', {})
  t.is(log.key, key)
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2, 3])
  t.is(log.entries[1].record.name, 'Bia')
  t.alike(log.invalid, [])
  t.is(log.entriesTruncated, 0)
  const page = await web.request('log.read', { limit: 2 })
  t.alike(page.entries.map((e) => e.seq), [2, 3])
  t.is(page.entriesTruncated, 2)
  t.alike(await web.request('log.read', { author: key }), log, 'author = own key reads the own diary')

  const feed = await web.request('feed.read', {})
  t.alike(feed.items.map((i) => [i.seq, i.text, i.name]), [[2, 'primeira', 'Bia'], [3, 'resposta', 'Bia']])
  t.alike(feed.items[1].replyTo, { author: key, seq: 2 })
  t.alike(feed.skipped, [])
  t.is(feed.skippedTruncated, 0)
  t.alike(feed.incomplete, [])
  t.is(feed.incompleteTruncated, 0)

  // profile.read of the own key (duplicates folded).
  t.alike(await web.request('profile.read', { authors: [key, key] }), {
    profiles: [{ author: key, name: 'Bia', bio: 'oi', avatar: null, username: null }],
    missing: []
  })

  // log.read pages backwards with `before`, which clamps to the length.
  const back = await web.request('log.read', { limit: 2, before: 3 })
  t.alike(back.entries.map((e) => e.seq), [1, 2])
  t.is(back.entriesTruncated, 1)
  const first = await web.request('log.read', { limit: 2, before: 1 })
  t.alike(first.entries.map((e) => e.seq), [0])
  t.is(first.entriesTruncated, 0)
  t.alike(await web.request('log.read', { limit: 2, before: 99 }), page, 'a before past the length is the newest page')

  // feed.read pages backwards from the oldest item held, without overlap.
  const newest = await web.request('feed.read', { limit: 1 })
  t.alike(newest.items.map((i) => i.seq), [3])
  const oldest = newest.items[0]
  const older = await web.request('feed.read', { limit: 1, before: { at: oldest.at, author: oldest.author, seq: oldest.seq } })
  t.alike(older.items.map((i) => i.seq), [2])
  const last = await web.request('feed.read', { limit: 1, before: { at: older.items[0].at, author: key, seq: 2 } })
  t.alike(last.items, [], 'nothing before the oldest post')
})

test('follows, and reads of diaries with no local data', async (t) => {
  await testnet(t)
  const { web, key, storage } = await certified(t)
  const other = 'cd'.repeat(32)
  const own = await errorOf(web.request('follow.add', { key }))
  t.is(own.message, 'não é possível seguir a própria chave')
  t.alike(await web.request('follow.add', { key: other }), { changed: true, followCount: 1 })
  t.alike(await web.request('follow.add', { key: other }), { changed: false, followCount: 1 })
  t.alike(await web.request('follow.list'), { follows: [other], total: 1 })
  t.alike(await web.request('follow.list', { offset: 1 }), { follows: [], total: 1 })
  t.is((await web.request('node.info')).followCount, 1)

  const feed = await web.request('feed.read', {})
  t.alike(feed.skipped, [{ key: other, reason: 'no-cert' }])
  t.alike(feed.incomplete, [])
  const missing = await errorOf(web.request('log.read', { author: other }))
  t.is(missing.code, 'NOT_FOUND')
  t.is(missing.message, 'sem dados locais para este diário')
  t.absent(await storage.hasCore('replica/' + other), 'no core created by a read')
  t.alike(await web.request('profile.read', { authors: [other, key] }), {
    profiles: [{ author: key, name: null, bio: null, avatar: null, username: null }],
    missing: [other]
  }, 'no profile record: null name and bio; no local data: missing')
  t.absent(await storage.hasCore('replica/' + other), 'no core created by profile.read')

  t.alike(await web.request('follow.remove', { key: other }), { changed: true, followCount: 0 })
  t.alike(await web.request('follow.remove', { key: other }), { changed: false, followCount: 0 })
})

test('feed.read reports incomplete followed diaries until their full download', async (t) => {
  await testnet(t)
  const { web, storage, assoc } = await certified(t)
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  await source.append(memberCertRecord(createCert({ member: hex(source.key) }, assoc.kp)))
  await source.append(profileRecord({ name: 'Autor', at: '2026-01-01T00:00:00.000Z' }))
  for (let i = 1; i <= 4; i++) {
    await source.append(postRecord({ text: 'post ' + i, at: '2026-01-01T00:00:0' + i + '.000Z' }))
  }
  const key = await storeReplica(storage, source, 3)
  await web.request('follow.add', { key })

  const partial = await web.request('feed.read', {})
  t.alike(partial.incomplete, [key])
  t.is(partial.incompleteTruncated, 0)
  t.alike(partial.skipped, [])
  t.alike(partial.items.map((item) => [item.author, item.seq, item.text]), [[key, 2, 'post 1']])

  await storeReplica(storage, source)
  const full = await web.request('feed.read', {})
  t.alike(full.incomplete, [])
  t.is(full.incompleteTruncated, 0)
  t.alike(full.items.map((item) => [item.author, item.seq, item.text]), [
    [key, 2, 'post 1'],
    [key, 3, 'post 2'],
    [key, 4, 'post 3'],
    [key, 5, 'post 4']
  ])
})

test('feed.read caps incomplete followed diaries in follow-list order', async (t) => {
  await testnet(t)
  const { web, storage, assoc } = await certified(t)
  const keys = []
  for (let i = 0; i <= FEED_INCOMPLETE_MAX; i++) {
    const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
    await source.ready()
    t.teardown(() => source.close(), { force: true })
    await source.append(memberCertRecord(createCert({ member: hex(source.key) }, assoc.kp)))
    await source.append(postRecord({ text: 'post', at: '2026-01-01T00:00:00.000Z' }))
    const key = await storeReplica(storage, source, 1)
    keys.push(key)
    await web.request('follow.add', { key })
  }

  const follows = await web.request('follow.list')
  t.alike(follows.follows, keys.sort())
  const feed = await web.request('feed.read', {})
  t.is(feed.incomplete.length, FEED_INCOMPLETE_MAX)
  t.is(feed.incompleteTruncated, 1)
  t.alike(feed.incomplete, follows.follows.slice(0, FEED_INCOMPLETE_MAX))
  t.alike(feed.skipped, [])
  t.alike(feed.items, [])
})

test('the own diary quota is enforced', async (t) => {
  await testnet(t)
  const { web } = await certified(t, { limits: { maxLogBlocks: 3 } })
  await web.request('post.create', { text: 'um' })
  await web.request('post.create', { text: 'dois' })
  const full = await errorOf(web.request('post.create', { text: 'três' }))
  t.is(full.code, 'USAGE')
  t.is(full.message, 'limite do diário atingido')
  const bytes = await certified(t, { limits: { maxBlockBytes: 700 } })
  const big = await errorOf(bytes.web.request('post.create', { text: 'x'.repeat(900) }))
  t.is(big.message, 'limite do diário atingido')
})

test('the storage outlives the node: same identity and diary after a restart', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {} // shared by both nodes below
  const assoc = association()
  const first = await certified(t, { storage, assoc })
  await first.web.request('post.create', { text: 'antes' })
  await first.node.close()
  const err = await errorOf(first.web.request('node.info'))
  t.is(err.code, 'CLOSED', 'the old client is closed with its node')

  const second = await setup(t, { storage, assoc, keyPair: first.keyPair })
  t.alike(await second.web.request('identity.create'), { publicKey: first.key, association: assoc.hex })
  const log = await second.web.request('log.read', {})
  t.is(log.entries[1].record.text, 'antes')

  const changed = await setup(t, { storage, keyPair: first.keyPair })
  const mismatch = await errorOf(changed.web.request('identity.show'))
  t.is(mismatch.message, 'associação diferente da configurada')
})

test('locked: reads work, writes and creation need the key pair', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const { web, node } = await setup(t, { storage, assoc, keyPair: null })
  t.alike(await node.identityStatus(), { exists: false, publicKey: null, legacy: false, unlocked: false, synced: false })
  const create = await errorOf(web.request('identity.create'))
  t.is(create.code, 'USAGE')
  t.is(create.message, LOCKED, 'no diary is created without the key')
  t.absent(await storage.hasCore('diary'))
  t.ok(await storage.readJson('config'), 'the trust root was written')
  const before = await errorOf(web.request('post.create', { text: 'x' }))
  t.is(before.code, 'NOT_FOUND', 'no identity yet: not found, not locked')

  // The same storage with the key: identity, certificate, a post.
  const keyPair = crypto.keyPair()
  const unlocked = await setup(t, { storage, assoc, keyPair })
  const { publicKey } = await unlocked.web.request('identity.create')
  t.is(publicKey, hex(keyPair.publicKey), 'the diary key is the pair\'s public key')
  await unlocked.web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  await unlocked.web.request('post.create', { text: 'com a chave' })
  t.alike(await unlocked.node.identityStatus(), { exists: true, publicKey, legacy: false, unlocked: true, synced: false })
  await unlocked.node.close()

  // Locked again over the stored diary: reads work, every write is refused.
  const locked = await setup(t, { storage, assoc, keyPair: null })
  const info = await locked.web.request('node.info')
  t.is(info.publicKey, publicKey)
  t.is(info.memberCert, true)
  t.is((await locked.web.request('log.read', {})).entries[1].record.text, 'com a chave')
  t.alike(await locked.web.request('identity.create'), { publicKey, association: assoc.hex }, 'opening an existing diary needs no key')
  for (const [method, params] of [['cert.add', { cert: createCert({ member: publicKey }, assoc.kp) }], ['profile.set', { name: 'B' }], ['post.create', { text: 'x' }], ['post.reply', { to: publicKey + ':1', text: 'x' }]]) {
    const err = await errorOf(locked.web.request(method, params))
    t.is(err && err.code, 'USAGE', method)
    t.is(err && err.message, LOCKED, method)
  }
  // Follows are signed into the diary, so a change is refused while locked
  // too: nothing a signed-out browser queues reaches the diary later.
  for (const method of ['follow.add', 'follow.remove']) {
    const err = await errorOf(locked.web.request(method, { key: 'cd'.repeat(32) }))
    t.is(err && err.message, LOCKED, method)
  }
  t.is((await locked.web.request('log.read', {})).entries.length, 2, 'nothing was appended')
  t.is(await storage.readJson('followsPending'), null, 'nothing queued while locked')
  t.alike(await locked.web.request('follow.list'), { follows: [], total: 0 })

  // Unlocking the running node with the right pair: a follow is queued
  // (signed) and drained into the diary at once (seq 2); then locking it.
  await locked.node.setKeyPair(keyPair)
  t.alike(await locked.web.request('follow.add', { key: 'cd'.repeat(32) }), { changed: true, followCount: 1 })
  t.is((await locked.web.request('post.create', { text: 'destrancado' })).seq, 3)
  const drained = await locked.web.request('log.read', {})
  t.alike(drained.entries.slice(2, 3).map((e) => [e.record.type, e.record.key, e.record.on]), [['follow', 'cd'.repeat(32), true]], 'the follow record was appended by the drain')
  t.alike((await storage.readJson('followsPending')).ops, [], 'nothing pending')
  await locked.node.clearKeyPair()
  t.is((await errorOf(locked.web.request('post.create', { text: 'x' }))).message, LOCKED)
  t.is((await locked.node.identityStatus()).unlocked, false)
})

test('account.sign: the unlocked key signs the account-link statement, locked refuses', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const nonce = 'A-_9'.repeat(11)
  const params = { phase: 'reserve', nonce, username: 'ana_1', sub: '' }

  const none = await setup(t, { storage: memoryNodeStorage(), assoc })
  const missing = await errorOf(none.web.request('account.sign', params))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'identidade não encontrada'], 'no identity')

  const s = await certified(t, { storage, assoc, keyPair })
  t.is(s.key, hex(keyPair.publicKey))
  const before = await s.web.request('log.read', {})
  const r = await s.web.request('account.sign', params)
  t.alike(Object.keys(r), ['signature'], 'only the signature')
  t.ok(/^[0-9a-f]{128}$/.test(r.signature))
  const fields = { ...params, member: s.key, association: assoc.hex }
  t.alike(verifyAccountLink(fields, r.signature), { ok: true }, 'verifies against the diary key')
  t.alike(verifyAccountLink({ ...fields, phase: 'rename' }, r.signature), { ok: false, reason: 'bad-signature' })

  const finish = { phase: 'finish', nonce, username: 'ana_1', sub: '1234567890' }
  const f = await s.web.request('account.sign', finish)
  t.alike(verifyAccountLink({ ...finish, member: s.key, association: assoc.hex }, f.signature), { ok: true })
  const rename = await s.web.request('account.sign', { ...params, phase: 'rename', username: 'bia_2' })
  t.alike(verifyAccountLink({ ...params, phase: 'rename', username: 'bia_2', member: s.key, association: assoc.hex }, rename.signature), { ok: true })

  const bad = await errorOf(s.web.request('account.sign', { ...params, member: 'ab'.repeat(32) }))
  t.alike([bad.code, bad.message], ['USAGE', 'parâmetro desconhecido'], 'the caller cannot choose the member')
  t.alike(await s.web.request('log.read', {}), before, 'nothing written')
  t.is((await s.node.identityStatus()).unlocked, true, 'the key stays set')
  t.alike(await s.web.request('sync.status'), { state: 'idle' })

  await s.node.clearKeyPair()
  const locked = await errorOf(s.web.request('account.sign', params))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.alike(await s.web.request('log.read', {}), before, 'nothing written while locked')
  t.alike(s.internal, [], 'no internal error')
})

test('report.sign: the unlocked key signs the report statement, locked and self reports refused', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const target = hex(crypto.keyPair().publicKey)
  const nonce = 'A-_9'.repeat(11)
  const account = { nonce, target, reason: 'spam' }
  const post = { nonce, target, seq: 4, reason: 'assedio', text: 'me ofendeu', quote: 'linha 1\nlinha 2' }

  const none = await setup(t, { storage: memoryNodeStorage(), assoc })
  const missing = await errorOf(none.web.request('report.sign', account))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'identidade não encontrada'], 'no identity')

  const s = await certified(t, { storage, assoc, keyPair })
  const before = await s.web.request('log.read', {})
  const marker = b4a.from('me ofendeu')
  const r = await s.web.request('report.sign', post)
  t.alike(Object.keys(r), ['signature'], 'only the signature')
  t.ok(/^[0-9a-f]{128}$/.test(r.signature))
  const fields = { ...post, member: s.key, association: assoc.hex }
  t.alike(verifyReport(fields, r.signature), { ok: true }, 'verifies against the diary key')
  t.alike(verifyReport({ ...fields, seq: 5 }, r.signature), { ok: false, reason: 'bad-signature' })

  const a = await s.web.request('report.sign', account)
  t.alike(verifyReport({ ...account, seq: null, text: '', quote: '', member: s.key, association: assoc.hex }, a.signature), { ok: true }, 'an account report')

  // A post that holds a lone surrogate is reported through its well-formed quote.
  const odd = { ...post, quote: 'antes \ud800 depois'.toWellFormed() }
  const o = await s.web.request('report.sign', odd)
  t.alike(verifyReport({ ...odd, member: s.key, association: assoc.hex }, o.signature), { ok: true })

  const self = await errorOf(s.web.request('report.sign', { ...account, target: s.key }))
  t.alike([self.code, self.message], ['USAGE', 'não é possível denunciar a própria chave'])
  for (const params of [{ ...post, text: 'a\u202eb' }, { ...post, quote: 'x\ud800' }, { ...post, text: '\ud800' }]) {
    const invalid = await errorOf(s.web.request('report.sign', params))
    t.alike([invalid.code, invalid.message], ['USAGE', 'denúncia inválida'])
  }
  for (const k of ['member', 'association']) {
    const extra = await errorOf(s.web.request('report.sign', { ...account, [k]: 'ab'.repeat(32) }))
    t.alike([extra.code, extra.message], ['USAGE', 'parâmetro desconhecido'], 'the caller cannot choose the ' + k)
  }
  t.alike(await s.web.request('log.read', {}), before, 'nothing written')
  t.absent(await diaryHolds(storage, marker), 'the report text is not in the diary')
  t.is((await s.node.identityStatus()).unlocked, true, 'the key stays set')
  t.alike(await s.web.request('sync.status'), { state: 'idle' })

  await s.node.clearKeyPair()
  const locked = await errorOf(s.web.request('report.sign', post))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.alike(await s.web.request('log.read', {}), before, 'nothing written while locked')
  t.alike(s.internal, [], 'no internal error')
})

test('terms.sign: the unlocked key signs the terms-acceptance statement, locked refuses', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const nonce = 'A-_9'.repeat(11)
  const params = { nonce, version: 1 }

  const none = await setup(t, { storage: memoryNodeStorage(), assoc })
  const missing = await errorOf(none.web.request('terms.sign', params))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'identidade não encontrada'], 'no identity')

  const s = await certified(t, { storage, assoc, keyPair })
  const before = await s.web.request('log.read', {})
  const r = await s.web.request('terms.sign', params)
  t.alike(Object.keys(r), ['signature'], 'only the signature')
  t.ok(/^[0-9a-f]{128}$/.test(r.signature))
  const fields = { ...params, member: s.key, association: assoc.hex }
  t.alike(verifyTerms(fields, r.signature), { ok: true }, 'verifies against the diary key')
  t.alike(verifyTerms({ ...fields, version: 2 }, r.signature), { ok: false, reason: 'bad-signature' })

  const v = await s.web.request('terms.sign', { nonce, version: 9999 })
  t.alike(verifyTerms({ ...fields, version: 9999 }, v.signature), { ok: true })

  for (const k of ['member', 'association']) {
    const extra = await errorOf(s.web.request('terms.sign', { ...params, [k]: 'ab'.repeat(32) }))
    t.alike([extra.code, extra.message], ['USAGE', 'parâmetro desconhecido'], 'the caller cannot choose the ' + k)
  }
  const after = await s.web.request('log.read', {})
  t.is(after.entries.length, before.entries.length, 'diary length unchanged')
  t.alike(after, before, 'nothing written')
  t.is((await s.node.identityStatus()).unlocked, true, 'the key stays set')
  t.alike(await s.web.request('sync.status'), { state: 'idle' })

  await s.node.clearKeyPair()
  const locked = await errorOf(s.web.request('terms.sign', params))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.alike(await s.web.request('log.read', {}), before, 'nothing written while locked')
  t.alike(s.internal, [], 'no internal error')
})

test('invite.sign: the unlocked key signs the signup-invite request, locked and mismatched refuse', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const nonce = 'A-_9'.repeat(11)
  const params = { action: 'issue', nonce }

  const none = await setup(t, { storage: memoryNodeStorage(), assoc })
  const missing = await errorOf(none.web.request('invite.sign', params))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'identidade não encontrada'], 'no identity')

  const s = await certified(t, { storage, assoc, keyPair })
  const before = await s.web.request('log.read', {})
  const r = await s.web.request('invite.sign', params)
  t.alike(Object.keys(r), ['signature'], 'only the signature')
  t.ok(/^[0-9a-f]{128}$/.test(r.signature))
  const fields = { ...params, member: s.key, association: assoc.hex }
  t.alike(verifyInvite(fields, r.signature), { ok: true }, 'verifies against the diary key')
  t.alike(verifyInvite({ ...fields, nonce: 'B'.repeat(43) }, r.signature), { ok: false, reason: 'bad-signature' })
  t.alike(verifyTerms({ nonce, member: s.key, association: assoc.hex, version: 1 }, r.signature), { ok: false, reason: 'bad-signature' }, 'not a terms acceptance')

  for (const k of ['member', 'association']) {
    const extra = await errorOf(s.web.request('invite.sign', { ...params, [k]: 'ab'.repeat(32) }))
    t.alike([extra.code, extra.message], ['USAGE', 'parâmetro desconhecido'], 'the caller cannot choose the ' + k)
  }
  const after = await s.web.request('log.read', {})
  t.is(after.entries.length, before.entries.length, 'diary length unchanged')
  t.alike(after, before, 'nothing written')
  t.is((await s.node.identityStatus()).unlocked, true, 'the key stays set')
  t.alike(await s.web.request('sync.status'), { state: 'idle' })

  await s.node.clearKeyPair()
  const locked = await errorOf(s.web.request('invite.sign', params))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.alike(await s.web.request('log.read', {}), before, 'nothing written while locked')
  t.alike(s.internal, [], 'no internal error')
  await s.node.close()

  const other = await setup(t, { storage, assoc, keyPair: crypto.keyPair() })
  const mismatch = await errorOf(other.web.request('invite.sign', params))
  t.is(mismatch && mismatch.message, MISMATCH, 'a pair that does not match the stored diary signs nothing')
})

test('push.sign: the unlocked key signs the push-subscription statement, locked refuses', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const nonce = 'A-_9'.repeat(11)
  const b64url = (buf) => b4a.toString(buf, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const point = b4a.alloc(65, 7)
  point[0] = 0x04
  const endpoint = 'https://push.example/send/abc?x=1'
  const params = { nonce, action: 'on', endpoint, p256dh: b64url(point), auth: b64url(b4a.alloc(16, 9)) }

  const none = await setup(t, { storage: memoryNodeStorage(), assoc })
  const missing = await errorOf(none.web.request('push.sign', params))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'identidade não encontrada'], 'no identity')

  const s = await certified(t, { storage, assoc, keyPair })
  const before = await s.web.request('log.read', {})
  const r = await s.web.request('push.sign', params)
  t.alike(Object.keys(r), ['signature'], 'only the signature')
  t.ok(/^[0-9a-f]{128}$/.test(r.signature))
  const { endpoint: _, ...rest } = params
  const fields = { ...rest, member: s.key, association: assoc.hex, endpointHash: endpointHash(endpoint) }
  t.alike(verifyPush(fields, r.signature), { ok: true }, 'verifies over the hash of the raw endpoint')
  t.alike(verifyPush({ ...fields, action: 'off' }, r.signature), { ok: false, reason: 'bad-signature' }, 'another action')
  t.alike(verifyPush({ ...fields, endpointHash: endpointHash(endpoint + '2') }, r.signature), { ok: false, reason: 'bad-signature' }, 'another endpoint')

  const off = await s.web.request('push.sign', { ...params, action: 'off' })
  t.alike(verifyPush({ ...fields, action: 'off' }, off.signature), { ok: true })

  // Keys the RPC layer accepts but the statement refuses.
  for (const bad of [{ p256dh: 'abc' }, { auth: 'abc' }]) {
    const invalid = await errorOf(s.web.request('push.sign', { ...params, ...bad }))
    t.alike([invalid.code, invalid.message], ['USAGE', 'inscrição de notificação inválida'], Object.keys(bad)[0])
  }
  // A non-canonical endpoint never reaches the signer: the RPC refuses it.
  const shouty = await errorOf(s.web.request('push.sign', { ...params, endpoint: 'HTTPS://push.example/send' }))
  t.alike([shouty.code, shouty.message], ['USAGE', 'parâmetro inválido: endpoint'])
  for (const k of ['member', 'association', 'endpointHash']) {
    const extra = await errorOf(s.web.request('push.sign', { ...params, [k]: 'ab'.repeat(32) }))
    t.alike([extra.code, extra.message], ['USAGE', 'parâmetro desconhecido'], 'the caller cannot choose the ' + k)
  }
  const after = await s.web.request('log.read', {})
  t.is(after.entries.length, before.entries.length, 'diary length unchanged')
  t.alike(after, before, 'nothing written')
  t.is((await s.node.identityStatus()).unlocked, true, 'the key stays set')
  t.alike(await s.web.request('sync.status'), { state: 'idle' })

  await s.node.clearKeyPair()
  const locked = await errorOf(s.web.request('push.sign', params))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.alike(await s.web.request('log.read', {}), before, 'nothing written while locked')
  t.alike(s.internal, [], 'no internal error')
})

test('username.add: appends a verified username record once, locked and foreign records refused', async (t) => {
  await testnet(t)
  const assoc = association()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const s = await certified(t, { assoc })
  const issue = (member, username, date) => createUsernameRecord({ member, username, date }, issuerKp, issuerCert)
  const before = await s.web.request('log.read', {})

  const foreign = await errorOf(s.web.request('username.add', { record: issue('ab'.repeat(32), 'ana') }))
  t.alike([foreign.code, foreign.message], ['USAGE', 'registro de nome inválido'], 'a record for another member')
  const otherAssoc = association()
  const otherIssuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, otherAssoc.kp)
  const untrusted = createUsernameRecord({ member: s.key, username: 'ana' }, issuerKp, otherIssuerCert)
  const untrustedErr = await errorOf(s.web.request('username.add', { record: untrusted }))
  t.alike([untrustedErr.code, untrustedErr.message], ['USAGE', 'registro de nome inválido'], 'another association')
  const tampered = { ...issue(s.key, 'ana'), username: 'bia' }
  t.is((await errorOf(s.web.request('username.add', { record: tampered }))).message, 'registro de nome inválido', 'a tampered record')
  t.alike(await s.web.request('log.read', {}), before, 'nothing written')

  const record = issue(s.key, 'ana', '2026-10-24T10:00:00.000Z')
  t.alike(await s.web.request('username.add', { record }), { changed: true, username: 'ana', seq: 1 })
  const log = await s.web.request('log.read', {})
  t.alike(log.entries.map((e) => e.seq), [0, 1])
  t.alike(log.entries[1].record, record, 'the record as given')
  t.is(latestUsername(log.entries, s.key, assoc.hex), 'ana')

  t.alike(await s.web.request('username.add', { record }), { changed: false, username: 'ana' }, 'the same record again')
  t.alike(await s.web.request('log.read', {}), log, 'no new block')

  const rename = issue(s.key, 'ana_2', '2026-10-24T11:00:00.000Z')
  t.alike(await s.web.request('username.add', { record: rename }), { changed: true, username: 'ana_2', seq: 2 })
  const after = await s.web.request('log.read', {})
  t.is(latestUsername(after.entries, s.key, assoc.hex), 'ana_2')
  const older = await errorOf(s.web.request('username.add', { record }))
  t.alike([older.code, older.message], ['USAGE', 'registro de nome antigo'], 'an older record would revert the rename')
  const sameDate = issue(s.key, 'ana_3', '2026-10-24T11:00:00.000Z')
  const sameDateErr = await errorOf(s.web.request('username.add', { record: sameDate }))
  t.alike([sameDateErr.code, sameDateErr.message], ['USAGE', 'registro de nome antigo'], 'a different record of the same instant')
  t.alike(await s.web.request('log.read', {}), after, 'nothing appended')
  t.alike(await s.web.request('username.add', { record: rename }), { changed: false, username: 'ana_2' }, 'the latest record is still accepted')

  const named = { profiles: [{ author: s.key, name: null, bio: null, avatar: null, username: 'ana_2' }], missing: [] }
  t.alike(await s.web.request('profile.read', { authors: [s.key] }), named, 'the verified username')

  await s.node.clearKeyPair()
  const locked = await errorOf(s.web.request('username.add', { record: rename }))
  t.alike([locked.code, locked.message], ['USAGE', LOCKED])
  t.is((await s.web.request('log.read', {})).entries.length, 3, 'nothing written while locked')
  t.alike(await s.web.request('profile.read', { authors: [s.key] }), named, 'locked: the same answer')
  t.alike(s.internal, [], 'no internal error')
})

test('profile.read: a readable replica is named, a blocked one is missing', async (t) => {
  await testnet(t)
  const assoc = association()
  const s = await certified(t, { assoc })
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  await source.append(memberCertRecord(createCert({ member: hex(source.key) }, assoc.kp)))
  await source.append(profileRecord({ name: 'Autor', bio: 'de longe' }))
  const A = await storeReplica(s.storage, source)

  // Not followed: still named when its diary would be shown.
  t.alike(await s.web.request('profile.read', { authors: [A, A] }), {
    profiles: [{ author: A, name: 'Autor', bio: 'de longe', avatar: null, username: null }],
    missing: []
  })

  await writeBlocklist(s.storage, snapshot(moderator(assoc.kp), { blocked: [A] }))
  t.alike(await s.web.request('profile.read', { authors: [A, s.key] }), {
    profiles: [{ author: s.key, name: null, bio: null, avatar: null, username: null }],
    missing: [A]
  }, 'blocked: missing, before any purge')
  t.ok(await s.storage.hasCore('replica/' + A), 'still stored: the read hides it, the sync purges it')
  t.alike(s.internal, [], 'no internal error')
})

test('username.add across devices: the gate precedes the duplicate check, and a duplicate retries an outstanding push', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const keyPair = crypto.keyPair()
  const keyHex = hex(keyPair.publicKey)
  const issue = (username, date) => createUsernameRecord({ member: keyHex, username, date }, issuerKp, issuerCert)
  const cert = createCert({ member: keyHex }, assoc.kp)
  const first = issue('ana', '2026-10-24T10:00:00.000Z')
  const gated = { writeGate: true, writeGateTimeoutMs: 15000, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } }

  // ---- a push that failed after the append: the same record pushes again ----
  // The record was written with no push (as after a push that timed out, or
  // in a previous session); the storage outlives the node.
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  const a = await certified(t, { assoc, keyPair, seederUrl: seeder.url })
  t.alike(await a.web.request('username.add', { record: first }), { changed: true, username: 'ana', seq: 1 })
  t.absent(a.web.events.some((e) => e.name === 'sync.started'), 'no push with the gate off')
  a.storage.close = async () => {}
  await a.node.close()

  const again = await setup(t, { assoc, keyPair, storage: a.storage, seederUrl: seeder.url, ...gated })
  let from = again.web.events.length
  t.alike(await again.web.request('username.add', { record: first }), { changed: false, username: 'ana' }, 'the same record again')
  let runs = await runsSince(again.web, from)
  t.is(runs.length, 2, 'the gate run and a push run although nothing was appended')
  t.is(runs[0].lines[0], 'sincronizando antes de publicar')
  t.is(runs[1].lines[0], 'enviando ao semeador')
  t.is(runs[1].stopped.reason, 'done')
  t.is(runs[1].stopped.result.seederConfirmed, true, 'the seeder confirmed the local length')
  t.alike((await again.web.request('log.read', {})).entries.map((e) => e.seq), [0, 1], 'no new block')

  from = again.web.events.length
  t.alike(await again.web.request('username.add', { record: first }), { changed: false, username: 'ana' })
  runs = await runsSince(again.web, from)
  t.is(runs.length, 1, 'confirmed: only the gate run this time')
  t.is(runs[0].lines[0], 'sincronizando antes de publicar')
  t.alike(again.internal, [], 'no internal error')

  // ---- the record another device published arrives with the gate ----
  // The seeder holds the own diary as that device left it: the certificate,
  // the first record and a rename. This device knows none of it yet.
  const rename = issue('ana_2', '2026-10-24T11:00:00.000Z')
  const published = new Hypercore(memoryStorage(), { keyPair, valueEncoding: 'json' })
  await published.ready()
  t.teardown(() => published.close(), { force: true })
  await published.append(memberCertRecord(cert))
  await published.append(first)
  await published.append(rename)
  const holder = await fakeSeeder(t, { signer: assoc.kp, cores: [published] })
  const b = await setup(t, { assoc, keyPair, seederUrl: holder.url, ...gated })
  t.alike(await b.web.request('identity.create'), { publicKey: keyHex, association: assoc.hex }, 'the same key on an empty device')
  t.alike((await b.web.request('log.read', {})).entries, [], 'nothing before the gate')
  from = b.web.events.length
  t.alike(await b.web.request('username.add', { record: rename }), { changed: false, username: 'ana_2' }, 'the record arrived with the gate: not appended again')
  runs = await runsSince(b.web, from)
  t.is(runs[0].lines[0], 'sincronizando antes de publicar')
  t.ok(runs[0].lines.includes('diário próprio atrasado (0/3)'), 'the device saw itself behind')
  t.ok(runs[0].lines.includes('diário próprio sincronizado (3)'), 'and caught up before the duplicate check')
  const log = await b.web.request('log.read', {})
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2], 'no duplicate block')
  t.alike(log.entries[2].record, rename)
  t.is(latestUsername(log.entries, keyHex, assoc.hex), 'ana_2')

  // An older record (after the gate) is refused: it would revert the rename.
  from = b.web.events.length
  const older = await errorOf(b.web.request('username.add', { record: first }))
  t.alike([older.code, older.message], ['USAGE', 'registro de nome antigo'])
  runs = await runsSince(b.web, from)
  t.is(runs.length, 1, 'the gate run only, no push')
  t.is(runs[0].lines[0], 'sincronizando antes de publicar')
  t.is((await b.web.request('log.read', {})).entries.length, 3, 'nothing appended')
  t.alike(b.internal, [], 'no internal error')
})

test('account.sign right after an unlock does not preempt a running sync', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const first = await certified(t, { storage, assoc, keyPair })
  await first.node.close()

  // The app's flow: the handle reads identityStatus on connection, a locked
  // node starts a once (recovery) sync, the passkey unlocks it, the handle
  // reads identityStatus again, and the member signs.
  const { node, web } = await setup(t, { storage, assoc, keyPair: null, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  t.alike(await node.identityStatus(), { exists: true, publicKey: first.key, legacy: false, unlocked: false, synced: false })
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 5000 })
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: true })
  await node.setKeyPair(keyPair)
  t.alike(await node.identityStatus(), { exists: true, publicKey: first.key, legacy: false, unlocked: true, synced: false })

  const params = { phase: 'reserve', nonce: 'A-_9'.repeat(11), username: 'ana_1', sub: '' }
  const r = await web.request('account.sign', params)
  t.alike(verifyAccountLink({ ...params, member: first.key, association: assoc.hex }, r.signature), { ok: true }, 'signs with the diary key')
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: true }, 'the once run is still running')
  t.absent(web.events.some((e) => e.name === 'sync.stopped'), 'no run was preempted')
  t.is(web.events.filter((e) => e.name === 'sync.started').length, 1, 'and none restarted')
  await web.request('sync.stop')
})

test('a pair that does not match the stored diary is refused', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const first = await certified(t, { storage, assoc })
  await first.node.close()

  const other = await setup(t, { storage, assoc, keyPair: crypto.keyPair() })
  const status = await other.node.identityStatus()
  t.alike(status, { exists: true, publicKey: first.key, legacy: false, unlocked: true, synced: false }, 'the status reports the stored key, it does not throw')
  for (const [method, params] of [['identity.show', {}], ['identity.create', {}], ['node.info', {}], ['post.create', { text: 'x' }]]) {
    const err = await errorOf(other.web.request(method, params))
    t.is(err && err.code, 'USAGE', method)
    t.is(err && err.message, MISMATCH, method)
  }
  t.is((await other.web.request('log.read', {}).catch((err) => err)).message, MISMATCH, 'reads with the wrong pair are refused too')
  await other.node.clearKeyPair()
  t.is((await other.web.request('node.info')).publicKey, first.key, 'locked, the stored diary reads again')
  t.ok(crypto.validateKeyPair(first.keyPair), 'the caller\'s buffers were copied, not zeroed')
})

test('a legacy store (secret in the header) is wiped on first use, refused for writing and removed by reset', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  const assoc = association()
  // A diary created before the key moved to memory, with its trust root.
  await storage.writeJson('config', { v: 1, role: 'member', association: assoc.hex })
  const legacy = new (require('hypercore'))(storage.core('diary'), { valueEncoding: 'json' })
  await legacy.ready()
  const legacyKey = hex(legacy.key)
  const secret = b4a.from(legacy.keyPair.secretKey)
  await legacy.append({ type: 'member-cert', cert: createCert({ member: legacyKey }, assoc.kp) })
  await legacy.close()
  t.ok(await diaryHolds(storage, secret), 'the legacy store holds its secret')

  const { web, node } = await setup(t, { storage, assoc, keyPair: null })
  // Opening an existing diary through identity.create caches nothing about
  // its header: the first open wipes the secret and reports legacy.
  t.alike(await web.request('identity.create'), { publicKey: legacyKey, association: assoc.hex })
  t.absent(await diaryHolds(storage, secret), 'the secret is gone from the storage on the first open')
  t.alike(await node.identityStatus(), { exists: true, publicKey: legacyKey, legacy: true, unlocked: false, synced: false })
  const info = await web.request('node.info')
  t.is(info.publicKey, legacyKey)
  t.is(info.memberCert, true, 'the legacy diary still reads')
  t.is((await errorOf(web.request('post.create', { text: 'x' }))).message, LOCKED, 'writes stay refused')
  await node.setKeyPair(crypto.keyPair())
  t.is((await errorOf(web.request('post.create', { text: 'x' }))).message, MISMATCH, 'the passkey never matches a legacy store')
  await node.reset()
  t.alike(await node.identityStatus(), { exists: false, publicKey: null, legacy: false, unlocked: false, synced: false })
  t.absent(await storage.hasCore('diary'), 'the diary is gone')
})

test('the write gate: no seeder reached, no write', async (t) => {
  await testnet(t)
  const assoc = association()
  const { web, node } = await setup(t, { assoc, writeGate: true, writeGateTimeoutMs: 1500, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { publicKey } = await web.request('identity.create')
  t.absent(web.events.some((e) => e.name === 'sync.started'), 'creating the identity is not gated')
  const cert = createCert({ member: publicKey }, assoc.kp)
  const refused = await errorOf(web.request('cert.add', { cert }))
  t.is(refused.code, 'USAGE')
  t.is(refused.message, 'sincronize com o semeador antes de publicar')
  const started = web.events.filter((e) => e.name === 'sync.started')
  t.is(started.length, 1, 'one internal once run')
  t.is(started[0].data.once, true)
  const { runId } = started[0].data
  const lines = web.events.filter((e) => e.name === 'sync.event' && e.data.runId === runId).map((e) => e.data.line)
  t.is(lines[0], 'sincronizando antes de publicar', 'the run names itself')
  const stopped = await stoppedOf(web.events, runId)
  t.is(stopped.reason, 'timeout')
  t.alike(stopped.result.errors, ['sem pares'])
  t.is((await web.request('node.info')).memberCert, false, 'nothing was written')
  t.alike(await web.request('sync.status'), { state: 'idle' })

  // A user's continuous intent survives a failed gate: the run restarts.
  const { runId: continuous } = await web.request('sync.start', {})
  const again = await errorOf(web.request('cert.add', { cert }))
  t.is(again.message, 'sincronize com o semeador antes de publicar')
  t.ok(web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === continuous && e.data.reason === 'preempted'), 'the continuous run was preempted by the gate')
  const status = await web.request('sync.status')
  t.is(status.state, 'running', 'and restarted after the failed gate')
  t.is(status.once, false)
  await web.request('sync.stop')

  // Locked: refused before any run.
  const runs = web.events.filter((e) => e.name === 'sync.started').length
  await node.clearKeyPair()
  const locked = await errorOf(web.request('cert.add', { cert }))
  t.is(locked.message, LOCKED)
  t.is(web.events.filter((e) => e.name === 'sync.started').length, runs, 'no run for a locked identity')
})

test('a client that detaches during the gate: nothing is written and no run is restarted', async (t) => {
  await testnet(t)
  const assoc = association()
  const { web, node } = await setup(t, { assoc, writeGate: true, writeGateTimeoutMs: 1500, syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { publicKey } = await web.request('identity.create')
  const cert = createCert({ member: publicKey }, assoc.kp)
  await web.request('sync.start', {})
  const pending = errorOf(web.request('cert.add', { cert }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.ok(web.events.some((e) => e.name === 'sync.event' && e.data.line === 'sincronizando antes de publicar'), 'the gate run is under way')
  web.port.close() // the page's connection goes (detach): the continuous intent is dropped with it
  t.is((await pending).code, 'CLOSED', 'the client side is closed')
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const second = await connectClient(node)
  t.alike(await second.request('sync.status'), { state: 'idle' }, 'no continuous run was restarted for a client that is gone')
  t.is((await second.request('node.info')).memberCert, false, 'the certificate was not written after the detach')
  t.is((await second.request('log.read', {})).entries.length, 0)
})

test('reset removes the diary and locks; config and follows stay', async (t) => {
  await testnet(t)
  const { web, node, storage, key, keyPair } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  await web.request('post.create', { text: 'apagado' })
  await web.request('follow.add', { key: 'cd'.repeat(32) })
  const { runId } = await web.request('sync.start', {})
  await node.reset()
  t.absent(await storage.hasCore('diary'), 'the diary is gone')
  t.alike(await node.identityStatus(), { exists: false, publicKey: null, legacy: false, unlocked: false, synced: false })
  t.ok(web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === runId && e.data.reason === 'stopped'))
  t.alike(await web.request('sync.status'), { state: 'idle' }, 'the continuous run was stopped and not restarted')
  const info = await web.request('node.info')
  t.is(info.publicKey, null)
  t.is(info.memberCert, false)
  t.is(info.followCount, 1, 'follows stay')
  t.ok(await storage.readJson('config'), 'config stays')
  t.is((await errorOf(web.request('identity.create'))).message, LOCKED, 'locked after the reset')
  await node.setKeyPair(keyPair)
  t.is((await web.request('identity.create')).publicKey, key, 'the same pair recreates the same key, empty')
  t.alike((await web.request('log.read', {})).entries, [])
})

test('a once run with no seeder ends in timeout, naming no address', async (t) => {
  await testnet(t)
  const { web, internal } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 1000 })
  t.ok(web.events.some((e) => e.name === 'sync.started' && e.data.runId === runId && e.data.once === true), 'sync.started first')
  const stopped = await stoppedOf(web.events, runId)
  t.is(stopped.reason, 'timeout')
  t.is(stopped.result.ok, false)
  t.alike(stopped.result.errors, ['sem pares'])
  t.is(stopped.result.peers, 0)
  const warnings = web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
  t.ok(warnings.some((l) => /^aviso: sem conexão com o semeador; nova tentativa em \d+ s$/.test(l)), 'retry warning')
  t.absent(JSON.stringify(web.events).includes('127.0.0.1'), 'no address in any event')
  t.is(internal.length, 0)
  t.alike(await web.request('sync.status'), { state: 'idle' })
})

test('a continuous run is preempted by a member request and restarted', async (t) => {
  await testnet(t)
  const { web } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { runId } = await web.request('sync.start', {})
  t.alike(await web.request('sync.status'), { state: 'running', runId, once: false })
  const busy = await errorOf(web.request('sync.start', { once: true }))
  t.is(busy.message, 'sincronização já em andamento')
  const usage = await errorOf(web.request('sync.start', { timeoutMs: 5000 }))
  t.is(usage.message, 'timeoutMs só com once')

  await web.request('post.create', { text: 'durante a sincronização' })
  const names = web.events.filter((e) => e.name !== 'warning' && e.name !== 'sync.event').map((e) => e.name + ' ' + e.data.runId + (e.data.reason ? ' ' + e.data.reason : ''))
  t.alike(names, ['sync.started ' + runId, 'sync.stopped ' + runId + ' preempted', 'sync.started ' + (runId + 1)])
  const info = await web.request('node.info')
  t.alike(info.sync, { state: 'running', runId: runId + 1, once: false }, 'a cached node.info does not preempt')

  t.alike(await web.request('sync.stop'), { stopped: true })
  t.ok(web.events.some((e) => e.name === 'sync.stopped' && e.data.runId === runId + 1 && e.data.reason === 'stopped'))
  t.alike(await web.request('sync.stop'), { stopped: false })
  t.alike(await web.request('sync.status'), { state: 'idle' })
  await web.request('post.create', { text: 'depois de parar' })
  t.alike(await web.request('sync.status'), { state: 'idle' }, 'a stopped run is not restarted')
})

test('regression: a run unwinding after a connection closed does not report to the next connection', async (t) => {
  await testnet(t)
  const { node, web } = await certified(t, { syncOptions: { retryMinMs: 100, retryMaxMs: 200 } })
  const { runId } = await web.request('sync.start', {})
  // The transport does not await detach(): the next page attaches while the run stops.
  const second = await connectClient(node)
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.alike(await second.request('sync.status'), { state: 'idle' })
  t.absent(second.events.some((e) => e.data.runId === runId || e.name === 'warning'), 'neither a warning nor the sync.stopped of the old run reaches the new connection')
  t.ok(web.events.some((e) => e.name === 'sync.started' && e.data.runId === runId))

  const { runId: next } = await second.request('sync.start', {})
  t.ok(second.events.some((e) => e.name === 'sync.started' && e.data.runId === next), 'a run of the new connection reports normally')
  await second.request('sync.stop')
  t.is((await stoppedOf(second.events, next)).reason, 'stopped')
})

test('connections: one at a time, protocol errors close, a closed session refuses', async (t) => {
  await testnet(t)
  const { node, web } = await certified(t)
  const second = await connectClient(node)
  t.ok(web.client.closed, 'the first client was replaced')
  t.is((await second.request('identity.show')).association.length, 64)

  second.port.receive('{ not json')
  t.ok(second.port.closed, 'a bad frame closes the connection')
  const third = await connectClient(node)
  third.port.receive(JSON.stringify({ v: 1, method: 'node.info', params: {} }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.ok(third.port.closed, 'an envelope without a usable id closes it too')

  const assoc = association()
  const session = createBrowserSession({ storage: memoryNodeStorage(), association: assoc.hex, seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => null })
  await session.close()
  const closed = await errorOf(session.handlers['node.info']({}))
  t.is(closed.code, 'LOCKED')
  t.is(closed.message, 'sessão encerrada')
})
