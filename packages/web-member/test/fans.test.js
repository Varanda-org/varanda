// Fas e Melhores amigos on the browser node (docs/rpc.md): fan.set and
// top.set through lib/session.js and an in-memory client, on memory storage.
// The node dials a loopback port nothing listens on (no seeder link, so every
// diary.peek fails): these tests cover the refusals before any read (self, a
// blocked person), the fail-closed page check when the target's blocks cannot
// be read, the writes that need no read (a fan mark withdrawn, the list
// cleared), the newest top-friends record replacing the older one, and a
// bad record never written. The page check over a real seeder is the last
// test.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { WebSocketServer, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { Seeder } = require('@varanda/core/lib/seeder')
const { validateRecord, postRecord } = require('@varanda/core/lib/records')
const { foldFans } = require('@varanda/core/lib/fans')
const { memoryNodeStorage } = require('../lib/node-storage')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const UNAVAILABLE = ['NOT_FOUND', 'semeador indisponível']
const BLOCKED = ['USAGE', 'você bloqueou esta pessoa']

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function certified (t, { seederUrl = null, kp = generateAssociationKeyPair(), peekTimeoutMs = 300 } = {}) {
  await testnet(t)
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: hex(kp.publicKey),
    seederUrl: seederUrl || 'ws://127.0.0.1:' + (await deadPort()) + '/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    peekTimeoutMs
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, kp) })
  return { web, key: publicKey, internal }
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

async function entries (web) {
  return (await web.request('log.read', {})).entries
}

function typesOf (log) {
  return log.map((e) => e.record.type)
}

test('fan.set: self and a blocked person are refused before any read, nothing written', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await errorPair(web.request('fan.set', { key, on: true })), ['USAGE', 'não pode ser fã de si'])
  t.alike(await errorPair(web.request('fan.set', { key, on: false })), ['USAGE', 'não pode ser fã de si'], 'off as well')
  await web.request('block.set', { key: A, on: true })
  t.alike(await errorPair(web.request('fan.set', { key: A, on: true })), BLOCKED)
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('fan.set: a target whose blocks cannot be read is unavailable, never a write', async (t) => {
  const { web, internal } = await certified(t)
  t.alike(await errorPair(web.request('fan.set', { key: B, on: true })), UNAVAILABLE)
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('fan.set: withdrawing a mark needs no read and appends the record; a blocked person can still be withdrawn', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await web.request('fan.set', { key: A, on: false }), { seq: 1, ref: key + ':1' })
  await web.request('block.set', { key: A, on: true })
  t.alike(await web.request('fan.set', { key: A, on: false }), { seq: 2, ref: key + ':2' })
  const log = await entries(web)
  t.alike(typesOf(log), ['member-cert', 'fan', 'fan'])
  t.alike(log.slice(1).map((e) => [e.record.key, e.record.on]), [[A, false], [A, false]])
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.alike(internal, [])
})

test('top.set: self, a blocked person and a repeated key are refused, nothing written', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await errorPair(web.request('top.set', { keys: [A, key] })), ['USAGE', 'não pode listar a si entre os melhores amigos'], 'self among the keys')
  t.alike(await errorPair(web.request('top.set', { keys: [key] })), ['USAGE', 'não pode listar a si entre os melhores amigos'])
  await web.request('block.set', { key: B, on: true })
  t.alike(await errorPair(web.request('top.set', { keys: [A, B] })), BLOCKED)
  t.alike(await errorPair(web.request('top.set', { keys: [A, A] })), ['USAGE', 'parâmetro inválido: keys'])
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('top.set: a list is unavailable while the pages cannot be ruled out, an empty list clears and the newest record wins', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await errorPair(web.request('top.set', { keys: [A] })), UNAVAILABLE)
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')

  t.alike(await web.request('top.set', { keys: [] }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('top.set', { keys: [] }), { seq: 3, ref: key + ':3' }, 'the older one is tombstoned (block 2), the new one lands after it')
  const log = await entries(web)
  t.alike(typesOf(log), ['member-cert', 'delete', 'top-friends'], 'log.read hides the tombstoned first list')
  t.alike(log.map((e) => e.seq), [0, 2, 3])
  t.is(log[1].record.seq, 1, 'the tombstone names the first list')
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  const fold = foldFans({ author: key, entries: log })
  t.alike(fold.top && fold.top.keys, [], 'the newest record is the list in effect')
  t.is(fold.top && fold.top.seq, 3)
  t.alike(internal, [])
})

test('fan.set and top.set: shapes are refused by the dispatcher', async (t) => {
  const { web } = await certified(t)
  t.alike(await errorPair(web.request('fan.set', { key: 'zz', on: true })), ['USAGE', 'parâmetro inválido: key'])
  t.alike(await errorPair(web.request('fan.set', { key: A, on: 'sim' })), ['USAGE', 'parâmetro inválido: on'])
  t.alike(await errorPair(web.request('top.set', { keys: Array.from({ length: 9 }, (_, i) => String(i).repeat(64)) })), ['USAGE', 'parâmetro inválido: keys'])
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')
})

// The seeder in this process with a WebSocket entry (as diary-peek.test.js).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-fans-seed-')
  const assocHex = hex(assoc.publicKey)
  Seeder.ensureConfig(dataDir, assocHex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-fans-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc)))
  Seeder.addCert(dataDir, certFile, assocHex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { publicKey, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// A certified diary with `records` (json values, or functions of its key),
// announced to the seeder and served whole; its link is closed afterwards.
async function served (t, { assoc, seederUrl, seederKey, records }) {
  const m = await createMember({ storage: memoryStorage(), association: hex(assoc.publicKey) })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc))
  for (const record of records) await m.core.append(typeof record === 'function' ? record(m.key) : record)
  const link = connectSeeder({ member: m, socket: new WebSocket(seederUrl), association: hex(assoc.publicKey), seederPublicKey: seederKey, timeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
  return m
}

test('fan.set and top.set read the target off the seeder: a person goes through, a page is refused', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = generateAssociationKeyPair()
  const { url, publicKey: seederKey } = await seederStack(t, bootstrap, assoc)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc)
  const ownerKp = crypto.keyPair()

  const person = await served(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'oi' })] })
  const page = await served(t, {
    assoc,
    seederUrl: url,
    seederKey,
    records: [(key) => {
      const fields = { page: key, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: '2026-11-03T12:00:00.000Z', nonce: 'r'.repeat(43), association: hex(assoc.publicKey) }
      return issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuerKp, issuerCert)
    }]
  })

  const { web, key, internal } = await certified(t, { seederUrl: url, kp: assoc, peekTimeoutMs: 8000 })
  await web.request('sync.start', {})

  t.alike(await errorPair(web.request('fan.set', { key: page.key, on: true })), ['USAGE', 'páginas não têm fãs'])
  t.alike(await errorPair(web.request('top.set', { keys: [person.key, page.key] })), ['USAGE', 'páginas não entram nos melhores amigos'])
  const other = await served(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'oi de novo' })] })
  t.alike(await errorPair(web.request('top.set', { keys: [person.key, other.key, page.key] })), ['USAGE', 'páginas não entram nos melhores amigos'], 'one page among several keys, the last one')
  t.alike(await errorPair(web.request('top.set', { keys: [page.key, person.key, other.key] })), ['USAGE', 'páginas não entram nos melhores amigos'], 'one page among several keys, the first one')
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written for a page')

  t.alike(await web.request('fan.set', { key: person.key, on: true }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('top.set', { keys: [person.key] }), { seq: 2, ref: key + ':2' })
  const log = await entries(web)
  t.alike(typesOf(log), ['member-cert', 'fan', 'top-friends'])
  t.alike([log[1].record.key, log[1].record.on], [person.key, true])
  t.alike(log[2].record.keys, [person.key])
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.alike(internal, [])
})

test('top.set: a blocked person already listed may stay (reorder, drop), a newly added blocked one is refused', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = generateAssociationKeyPair()
  const { url, publicKey: seederKey } = await seederStack(t, bootstrap, assoc)
  const x = await served(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'x' })] })
  const y = await served(t, { assoc, seederUrl: url, seederKey, records: [postRecord({ text: 'y' })] })

  const { web, key, internal } = await certified(t, { seederUrl: url, kp: assoc, peekTimeoutMs: 8000 })
  await web.request('sync.start', {})

  t.alike(await web.request('top.set', { keys: [x.key, y.key] }), { seq: 1, ref: key + ':1' })
  await web.request('block.set', { key: x.key, on: true })
  const reorder = await web.request('top.set', { keys: [y.key, x.key] })
  t.is(reorder.seq, 3, 'a listed blocked friend does not lock the list: reorder written')
  t.alike((await entries(web)).at(-1).record.keys, [y.key, x.key])
  t.is((await web.request('top.set', { keys: [y.key] })).seq, 5, 'and it can be dropped')
  t.alike(await errorPair(web.request('top.set', { keys: [y.key, x.key] })), BLOCKED, 'a blocked key no longer listed is new: refused')
  t.alike((await entries(web)).at(-1).record.keys, [y.key], 'nothing written for the refusal')
  t.alike(internal, [])
})

test('top.set: peeks in flight (the app\'s own) do not make the page check fail with ocupado', async (t) => {
  const { web, internal } = await certified(t, { peekTimeoutMs: 600 })
  const busy = [A, B, A, B].map((author) => errorPair(web.request('diary.peek', { author, seqs: [1] })))
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.alike(await errorPair(web.request('diary.peek', { author: A, seqs: [1] })), ['USAGE', 'ocupado'], 'the fifth peek is refused')
  const got = await errorPair(web.request('top.set', { keys: [A, B, 'ef'.repeat(32)] }))
  t.alike(got, UNAVAILABLE, 'waits for a slot inside the shared deadline, then the usual refusal')
  await Promise.all(busy)
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})
