// Recados on the browser node (docs/rpc.md): scrap.write, scrap.hide,
// scrap.wall and scrap.delete through lib/session.js and an in-memory
// client, on memory storage. The node dials a loopback port nothing listens
// on (no seeder link, so every diary.peek fails) with the write gate off,
// and the seeder index routes are stubbed through fetchMedia: these tests
// cover the refusals before any read, the fail-closed answers when the
// evidence cannot be read, and the owner's own records. The wall check over
// a real seeder is in session-e2e.test.js.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const { createBrowserNode } = require('../lib/node')

const OTHER = 'ab'.repeat(32)
const UNAVAILABLE = ['NOT_FOUND', 'semeador indisponível']
const BAD_REF = ['USAGE', 'referência inválida']

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

// answer(url) -> a Response or undefined (404); every URL asked is recorded.
async function certified (t, { answer = () => undefined } = {}) {
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const asked = []
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: hex(kp.publicKey),
    seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    peekTimeoutMs: 300,
    fetchMedia: async (url) => {
      asked.push(url)
      return (await answer(url)) || new Response('não encontrado', { status: 404 })
    }
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, kp) })
  return { web, key: publicKey, asked, internal }
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

async function entries (web) {
  return (await web.request('log.read', {})).entries
}

test('scrap.write: self, a blocked person, a bad record and a reply to another page are refused before any read', async (t) => {
  const { web, key, asked, internal } = await certified(t)
  t.alike(await errorPair(web.request('scrap.write', { to: key, text: 'eu mesma' })), ['USAGE', 'não pode deixar recado para si'])
  t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: '   ' + '\u0007' })), ['USAGE', 'registro inválido: text-length'], 'a control character')
  t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: 'oi', replyTo: 'cd'.repeat(32) + ':3' })), BAD_REF, 'replyTo names another diary')
  await web.request('block.set', { key: OTHER, on: true })
  t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: 'oi' })), ['USAGE', 'você bloqueou esta pessoa'])
  t.alike(asked, [], 'no seeder index asked')
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('scrap.write: evidence that cannot be read is unavailable, never a write', async (t) => {
  let body = null
  const { web, key, asked, internal } = await certified(t, {
    answer: (url) => body === null ? undefined : new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  })
  t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: 'oi' })), UNAVAILABLE, 'a 404 for the owner')
  t.alike(asked.map((u) => u.replace(/^http:\/\/127\.0\.0\.1:[0-9]+/, '')).sort(), ['/index/follow/' + OTHER + '/' + key, '/index/scraps/' + OTHER], 'the owner\'s recados and follow routes on the own seeder, asked together')
  for (const bad of [[], 'não é json', '[]', { wall: 0, scraps: [] }, { wall: 'x', scraps: [] }, { wall: 1.5, scraps: [] }]) {
    body = bad
    t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: 'oi' })), UNAVAILABLE, 'malformed: ' + JSON.stringify(bad))
  }
  // A well-formed answer: the owner's blocks are peeked, and with no seeder
  // link the peek fails, so the wall stays unverified.
  body = { scraps: [], hides: [], wall: null, next: null, indexing: false, complete: true }
  t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: 'oi' })), UNAVAILABLE, 'the owner\'s diary cannot be read')
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('scrap.write: one deadline for the whole evidence phase; a seeder that never answers is unavailable', async (t) => {
  const { web, internal } = await certified(t, { answer: () => new Promise(() => {}) })
  const started = Date.now()
  t.alike(await errorPair(web.request('scrap.write', { to: OTHER, text: 'oi' })), UNAVAILABLE)
  t.ok(Date.now() - started < 5000, 'answered by the deadline (' + (Date.now() - started) + ' ms)')
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('scrap.hide and scrap.wall append owner records; a repeat answers the record in effect', async (t) => {
  const { web, key, asked, internal } = await certified(t)
  t.alike(await errorPair(web.request('scrap.hide', { from: key, seq: 1 })), ['USAGE', 'não pode tirar o próprio recado da sua página'])

  const hide = await web.request('scrap.hide', { from: OTHER, seq: 4 })
  t.alike(hide, { seq: 1, ref: key + ':1' })
  t.alike(await web.request('scrap.hide', { from: OTHER, seq: 4 }), hide, 'the same block again writes nothing')
  const second = await web.request('scrap.hide', { from: OTHER, seq: 5 })
  t.alike(second, { seq: 2, ref: key + ':2' }, 'another block is another hide')

  const wall = await web.request('scrap.wall', { who: 'everyone' })
  t.alike(wall, { seq: 3, ref: key + ':3' })
  t.alike(await web.request('scrap.wall', { who: 'everyone' }), wall, 'the wall in effect writes nothing')
  t.alike(await web.request('scrap.wall', { who: 'nobody' }), { seq: 4, ref: key + ':4' })
  t.alike(await web.request('scrap.wall', { who: 'following' }), { seq: 5, ref: key + ':5' }, 'the default is written when chosen')

  const log = await entries(web)
  t.alike(log.map((e) => e.record.type), ['member-cert', 'scrap-hide', 'scrap-hide', 'scrap-wall', 'scrap-wall', 'scrap-wall'])
  t.alike([log[1].record.from, log[1].record.seq], [OTHER, 4], 'the hide names the writer block')
  t.alike(log.slice(3).map((e) => e.record.who), ['everyone', 'nobody', 'following'])
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.alike(asked, [], 'no seeder index asked')
  t.alike(internal, [])
})

test('scrap.delete tombstones an own scrap-hide or scrap-wall; anything else is refused; a repeat answers its tombstone', async (t) => {
  const { web, key, internal } = await certified(t)
  const post = await web.request('post.create', { text: 'não é recado' })
  const hide = await web.request('scrap.hide', { from: OTHER, seq: 2 })
  const everyone = await web.request('scrap.wall', { who: 'everyone' })
  const nobody = await web.request('scrap.wall', { who: 'nobody' })

  t.alike(await errorPair(web.request('scrap.delete', { seq: post.seq })), BAD_REF, 'a post')
  t.alike(await errorPair(web.request('scrap.delete', { seq: 99 })), BAD_REF, 'past the diary')

  const unhide = await web.request('scrap.delete', { seq: hide.seq })
  t.alike(unhide, { seq: nobody.seq + 1, deleted: [hide.seq] })
  t.alike(await web.request('scrap.delete', { seq: hide.seq }), unhide, 'the repeat writes nothing')
  t.alike(await web.request('scrap.hide', { from: OTHER, seq: 2 }), { seq: unhide.seq + 1, ref: key + ':' + (unhide.seq + 1) }, 'an undone hide can be written again')

  const back = await web.request('scrap.delete', { seq: nobody.seq })
  t.alike(back.deleted, [nobody.seq])
  t.alike(await web.request('scrap.wall', { who: 'everyone' }), everyone, 'the earlier wall is in effect again')
  t.alike(await errorPair(web.request('scrap.delete', { seq: back.seq })), BAD_REF, 'a tombstone')
  t.alike(internal, [])
})
