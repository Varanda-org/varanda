// Enquetes on the browser node (docs/rpc.md): post.create with a poll,
// choice.set and choice.mine through lib/session.js and an in-memory client,
// on memory storage. Without a seeder link every diary.peek fails: those
// tests cover the refusals before any read (a blocked author), the
// fail-closed poll check, a withdrawal that needs no read and the own pick
// read back. The poll check over a real seeder is the last test.
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
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { Seeder } = require('@varanda/core/lib/seeder')
const { validateRecord, postRecord } = require('@varanda/core/lib/records')
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

test('post.create with a poll writes the poll key set; the dispatcher refuses a bad poll', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await web.request('post.create', { text: 'Qual dia?', poll: ['sábado', 'domingo'] }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('post.create', { text: 'sem enquete' }), { seq: 2, ref: key + ':2' })
  const log = await entries(web)
  t.alike(log[1].record.poll, ['sábado', 'domingo'])
  t.alike(Object.keys(log[1].record).sort(), ['at', 'poll', 'replyTo', 'text', 'type'])
  t.absent('poll' in log[2].record, 'no poll key on a plain post')
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.is((await errorPair(web.request('post.create', { text: 'x', poll: ['só uma'] })))[0], 'USAGE')
  t.is((await errorPair(web.request('post.create', { text: 'x', poll: ['a', 'a'] })))[0], 'USAGE')
  t.alike(typesOf(await entries(web)), ['member-cert', 'post', 'post'], 'nothing more written')
  t.alike(internal, [])
})

test('choice.set: a blocked author is refused before any read, an unreadable poll is unavailable, nothing written', async (t) => {
  const { web, internal } = await certified(t)
  await web.request('block.set', { key: A, on: true })
  t.alike(await errorPair(web.request('choice.set', { to: A + ':3', pick: 0 })), BLOCKED)
  t.alike(await errorPair(web.request('choice.set', { to: B + ':3', pick: 0 })), UNAVAILABLE)
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written')
  t.alike(await web.request('choice.mine', { to: B + ':3' }), { pick: null, seq: null })
  t.is((await errorPair(web.request('choice.set', { to: B + ':3', pick: 4 })))[0], 'USAGE', 'a pick past POLL_MAX never reaches the node')
  t.is((await errorPair(web.request('choice.set', { to: B + ':0', pick: 0 })))[0], 'USAGE')
  t.alike(internal, [])
})

test('choice.set: a withdrawal needs no read, a blocked author too; choice.mine reads the own diary', async (t) => {
  const { web, internal } = await certified(t)
  t.alike(await web.request('choice.set', { to: B + ':3', pick: null }), { seq: 1 })
  await web.request('block.set', { key: A, on: true })
  t.alike(await web.request('choice.set', { to: A + ':2', pick: null }), { seq: 2 })
  const log = await entries(web)
  t.alike(typesOf(log), ['member-cert', 'choice', 'choice'])
  t.alike(log[1].record.to, { author: B, seq: 3 })
  t.is(log[1].record.pick, null)
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.alike(await web.request('choice.mine', { to: B + ':3' }), { pick: null, seq: null }, 'withdrawn is no pick')
  t.alike(internal, [])
})

test('choice.set: a poll the local fold knows deleted is no poll, before any peek; a withdrawal still goes', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await web.request('post.create', { text: 'Qual dia?', poll: ['sábado', 'domingo'] }), { seq: 1, ref: key + ':1' })
  t.is((await web.request('post.delete', { to: key + ':1' })).changed, true)
  t.alike(await errorPair(web.request('choice.set', { to: key + ':1', pick: 0 })), ['USAGE', 'a publicação não é uma enquete'], 'a deleted poll, not an unavailable seeder')
  t.alike(typesOf(await entries(web)), ['member-cert', 'delete'], 'nothing written for the refusal (the deleted post reads as invalid)')
  t.alike(await web.request('choice.set', { to: key + ':1', pick: null }), { seq: 3 }, 'a withdrawal needs no read')
  t.alike(await errorPair(web.request('choice.set', { to: B + ':3', pick: 0 })), UNAVAILABLE, 'a diary not held here is still peeked')
  t.alike(internal, [])
})

// The seeder in this process with a WebSocket entry (as diary-peek.test.js).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-polls-seed-')
  const assocHex = hex(assoc.publicKey)
  Seeder.ensureConfig(dataDir, assocHex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-polls-sc-'), 'seeder-cert.json')
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

test('choice.set reads the poll off the seeder: a poll and an option go through, anything else is refused', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = generateAssociationKeyPair()
  const { url, publicKey: seederKey } = await seederStack(t, bootstrap, assoc)
  const author = await served(t, {
    assoc,
    seederUrl: url,
    seederKey,
    records: [postRecord({ text: 'Qual dia?', poll: ['sábado', 'domingo'] }), postRecord({ text: 'oi' })]
  })
  const { web, internal } = await certified(t, { seederUrl: url, kp: assoc, peekTimeoutMs: 8000 })
  await web.request('sync.start', {})

  t.alike(await errorPair(web.request('choice.set', { to: author.key + ':1', pick: 2 })), ['USAGE', 'opção inválida'])
  t.alike(await errorPair(web.request('choice.set', { to: author.key + ':2', pick: 0 })), ['USAGE', 'a publicação não é uma enquete'])
  t.alike(await errorPair(web.request('choice.set', { to: author.key + ':9', pick: 0 })), ['USAGE', 'a publicação não é uma enquete'], 'past the diary')
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written for a refusal')

  t.alike(await web.request('choice.set', { to: author.key + ':1', pick: 1 }), { seq: 1 })
  t.alike(await web.request('choice.mine', { to: author.key + ':1' }), { pick: 1, seq: 1 })
  t.alike(await web.request('choice.set', { to: author.key + ':1', pick: 0 }), { seq: 2 })
  t.alike(await web.request('choice.mine', { to: author.key + ':1' }), { pick: 0, seq: 2 }, 'the last pick wins')
  const log = await entries(web)
  t.alike(log.slice(1).map((e) => [e.record.type, e.record.to, e.record.pick]), [['choice', { author: author.key, seq: 1 }, 1], ['choice', { author: author.key, seq: 1 }, 0]])
  t.alike(internal, [])
})
