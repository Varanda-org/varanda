// Likes, reposts, quotes and engagement.read of the browser node session
// (lib/session.js through lib/node.js and an in-memory client) on memory
// storage, with the write gate off as session.test.js does (no seeder here).
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')

const LOCKED = 'identidade bloqueada: entre com a passkey'

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

async function setup (t, { storage = memoryNodeStorage(), assoc = association(), keyPair = crypto.keyPair() } = {}) {
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
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  return { node, web, assoc, storage, keyPair, internal }
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

async function logTypes (web) {
  return (await web.request('log.read', {})).entries.map((e) => [e.seq, e.record.type])
}

test('like.set: idempotent toggles, one record per change, self-likes allowed', async (t) => {
  await testnet(t)
  const { web, key, internal } = await certified(t)
  const other = 'ab'.repeat(32)
  t.alike(await web.request('like.set', { to: other + ':7', on: true }), { seq: 1, on: true, changed: true })
  t.alike(await web.request('like.set', { to: other + ':7', on: true }), { seq: 1, on: true, changed: false }, 'already liked: nothing written')
  t.alike(await logTypes(web), [[0, 'member-cert'], [1, 'like']], 'one record')
  t.alike(await web.request('like.set', { to: other + ':7', on: false }), { seq: 2, on: false, changed: true })
  t.alike(await web.request('like.set', { to: other + ':7', on: false }), { seq: 2, on: false, changed: false }, 'the effective record is the off one')
  t.alike(await web.request('like.set', { to: other + ':8', on: false }), { seq: null, on: false, changed: false }, 'never engaged: seq null')
  t.alike(await web.request('like.set', { to: other + ':7', on: true }), { seq: 3, on: true, changed: true }, 'liked again')

  // A self-target is allowed and counted.
  await web.request('post.create', { text: 'meu poste' })
  t.alike(await web.request('like.set', { to: key + ':4', on: true }), { seq: 5, on: true, changed: true })
  const log = await web.request('log.read', {})
  const like = log.entries[5].record
  t.alike(Object.keys(like), ['type', 'to', 'on', 'at'])
  t.alike(like.to, { author: key, seq: 4 })
  t.is(log.invalid.length, 0, 'every record valid for the reader')

  // The RPC layer refuses a block-0 target and a malformed ref.
  t.is((await errorOf(web.request('like.set', { to: other + ':0', on: true }))).code, 'USAGE')
  t.is((await errorOf(web.request('like.set', { to: 'x', on: true }))).code, 'USAGE')
  t.alike(internal, [])
})

test('repost.set: toggles as like.set, read back by the feed as repost items', async (t) => {
  await testnet(t)
  const { web, key } = await certified(t)
  await web.request('post.create', { text: 'original' })
  const other = 'cd'.repeat(32)
  t.alike(await web.request('repost.set', { to: other + ':3', on: true }), { seq: 2, on: true, changed: true })
  t.alike(await web.request('repost.set', { to: other + ':3', on: true }), { seq: 2, on: true, changed: false })
  t.alike(await web.request('repost.set', { to: key + ':1', on: true }), { seq: 3, on: true, changed: true }, 'self-repost allowed')
  t.alike(await web.request('repost.set', { to: other + ':3', on: false }), { seq: 4, on: false, changed: true })
  t.alike(await web.request('repost.set', { to: other + ':3', on: false }), { seq: 4, on: false, changed: false })

  const feed = await web.request('feed.read', {})
  t.alike(feed.items.map((i) => [i.kind, i.seq]), [[1, 'post'], [3, 'repost']].map(([seq, kind]) => [kind, seq]), 'the post and the one repost still on')
  const repost = feed.items.find((i) => i.kind === 'repost')
  t.alike(repost.to, { author: key, seq: 1 })
  t.is(repost.text, null)
  t.is(repost.quote, null)
  t.is(repost.replyTo, null)
  t.is(feed.items[0].quote, null, 'a plain post has no quote')
})

test('post.quote: a post with a quote target, readable through log.read and feed.read', async (t) => {
  await testnet(t)
  const { web, key } = await certified(t)
  await web.request('post.create', { text: 'citado' })
  const other = 'ef'.repeat(32)
  t.alike(await web.request('post.quote', { to: other + ':5', text: 'olha isso' }), { seq: 2 })
  t.alike(await web.request('post.quote', { to: key + ':1', text: 'me cito' }), { seq: 3 }, 'quoting an own post')

  const log = await web.request('log.read', {})
  t.alike(log.invalid, [])
  const quote = log.entries[2].record
  t.alike(Object.keys(quote), ['type', 'text', 'at', 'replyTo', 'quote'])
  t.is(quote.type, 'post')
  t.is(quote.replyTo, null)
  t.alike(quote.quote, { author: other, seq: 5 })

  const feed = await web.request('feed.read', {})
  t.alike(feed.items.map((i) => [i.kind, i.seq, i.text]), [['post', 1, 'citado'], ['post', 2, 'olha isso'], ['post', 3, 'me cito']])
  t.alike(feed.items[1].quote, { author: other, seq: 5 })
  t.alike(feed.items[2].quote, { author: key, seq: 1 })
  t.is(feed.items[1].replyTo, null)

  // The RPC layer: a quote needs text, and a block-0 target is refused.
  t.is((await errorOf(web.request('post.quote', { to: other + ':5', text: '' }))).code, 'USAGE')
  t.is((await errorOf(web.request('post.quote', { to: other + ':0', text: 'x' }))).code, 'USAGE')
  // A quote with media not held by this device is refused before any write.
  const descriptor = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 10, sha256: '34'.repeat(32), width: 1, height: 1 }
  const bad = await errorOf(web.request('post.quote', { to: other + ':5', text: 'foto', media: [descriptor] }))
  t.is(bad.message, 'mídia inválida')
  t.is((await web.request('log.read', {})).entries.length, 4, 'nothing appended')
})

test('engagement.read: subsets of the refs in request order, from the own diary', async (t) => {
  await testnet(t)
  const { web, key } = await certified(t)
  const a = 'aa'.repeat(32)
  const b = 'bb'.repeat(32)
  await web.request('like.set', { to: a + ':1', on: true })
  await web.request('like.set', { to: b + ':2', on: true })
  await web.request('repost.set', { to: b + ':2', on: true })
  await web.request('like.set', { to: a + ':1', on: false })
  await web.request('post.create', { text: 'x' })
  await web.request('repost.set', { to: key + ':5', on: true })
  t.alike(await web.request('engagement.read', { refs: [key + ':5', b + ':2', a + ':1', a + ':9'] }), {
    liked: [b + ':2'],
    reposted: [key + ':5', b + ':2']
  })
  t.alike(await web.request('engagement.read', { refs: [a + ':9'] }), { liked: [], reposted: [] })
  t.is((await errorOf(web.request('engagement.read', { refs: [] }))).code, 'USAGE', 'at least one ref')
})

test('locked: like.set, repost.set and post.quote are refused, engagement.read works', async (t) => {
  await testnet(t)
  const storage = memoryNodeStorage()
  storage.close = async () => {}
  const assoc = association()
  const keyPair = crypto.keyPair()
  const unlocked = await certified(t, { storage, assoc, keyPair })
  const other = 'ab'.repeat(32)
  await unlocked.web.request('like.set', { to: other + ':1', on: true })
  await unlocked.node.close()

  const locked = await setup(t, { storage, assoc, keyPair: null })
  for (const [method, params] of [
    ['like.set', { to: other + ':2', on: true }],
    ['repost.set', { to: other + ':2', on: true }],
    ['post.quote', { to: other + ':2', text: 'x' }]
  ]) {
    const err = await errorOf(locked.web.request(method, params))
    t.is(err && err.code, 'USAGE', method)
    t.is(err && err.message, LOCKED, method)
  }
  t.alike(await locked.web.request('engagement.read', { refs: [other + ':1', other + ':2'] }), { liked: [other + ':1'], reposted: [] }, 'reads work locked')
  t.is((await locked.web.request('log.read', {})).entries.length, 2, 'nothing was appended')
  t.alike(locked.internal, [])
})
