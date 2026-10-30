'use strict'

// The token-gated loopback route GET /moderation-post/<D>/<seq> of the seeder
// HTTP listener (apps/cli/lib/seed-ws.js) and Seeder#postBlock behind it
// (packages/core/lib/seeder.js): the account service's report triage reads
// the raw blocks the author signed, never the reporter's quote. Real
// Corestore + Seeder + startSeedWs on 127.0.0.1 port 0, over a local testnet.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, profileRecord, deleteRecord } = require('@varanda/core/lib/records')
const { startSeedWs, POST_RE } = require('../lib/seed-ws')

const TOKEN = 'c3'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
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

async function startSeeder (t, bootstrap, dataDir, opts) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

// A member on the swarm with a diary holding the certificate and
// `records(key)`; `blocklist` offers a snapshot on every connection and
// `joinPeer` dials the seeder directly.
async function member (t, bootstrap, assoc, { records = () => [], blocklist = null, joinPeer = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  for (const r of records(key)) await diary.append(r)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    if (blocklist) {
      attachBlocklist(socket, {
        current: () => blocklist.snapshot,
        offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
      })
    }
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  if (joinPeer) swarm.joinPeer(b4a.from(joinPeer, 'hex'))
  else await joinAndFlush(swarm, [topicFor(assoc.hex)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 20000 })
  return { store, diary, key, swarm, seederPeer, message }
}

// Admits m and waits until the seeder holds every block of it, gated.
async function admit (seeder, m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  await until(() => {
    const entry = seeder._served.get(m.key)
    // The present length: a cleared deleted block keeps contiguousLength at the hole.
    return entry && entry.gated && entry.present === m.diary.length
  }, { name: 'diário local e aprovado' })
}

function request (port, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const auth = (token = TOKEN) => ({ Authorization: 'Bearer ' + token })

function notFound (t, res, name) {
  t.is(res.status, 404, name)
  t.is(res.body, 'não encontrado\n', name + ': generic body')
  t.is(res.headers['cache-control'], 'no-store')
  t.is(res.headers['x-content-type-options'], 'nosniff')
}

test('POST_RE: canonical keys and sequence numbers only', (t) => {
  const k = 'a'.repeat(64)
  t.ok(POST_RE.test('/moderation-post/' + k + '/1'))
  t.ok(POST_RE.test('/moderation-post/' + k + '/123456789012345'))
  for (const url of [
    '/moderation-post/' + k + '/0', '/moderation-post/' + k + '/01', '/moderation-post/' + k + '/1234567890123456',
    '/moderation-post/' + k.toUpperCase() + '/1', '/moderation-post/' + k + '/1/', '/moderation-post/' + k + '/1?x=1',
    '/moderation-post/' + k, '/moderation-post/' + k.slice(1) + '/1'
  ]) t.absent(POST_RE.test(url), url)
})

test('startSeedWs: an invalid triageToken throws without echoing it', (t) => {
  for (const triageToken of ['x', 'AB'.repeat(32), 'ab'.repeat(31), 42]) {
    try {
      startSeedWs({ port: 0, seeder: {}, triageToken })
      t.fail('should throw')
    } catch (err) {
      t.is(err.message, 'triageToken inválido')
    }
  }
})

test('GET /moderation-post: raw local blocks with the token, the generic 404 otherwise', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  // The budget is tested on its own below; here it is lifted so the ~10
  // authorized requests never depend on how fast the token bucket refills.
  const ws = await startSeedWs({ port: 0, seeder, triageToken: TOKEN, post: { rate: 1000, burst: 1000 } })
  t.teardown(() => ws.close(), { force: true })
  const plain = await startSeedWs({ port: 0, seeder })
  t.teardown(() => plain.close(), { force: true })
  const get = (url, headers = auth()) => request(ws.port, 'GET', url, headers)

  const A = await member(t, bootstrap, assoc, {
    records: () => [profileRecord({ name: 'Ana', at: '2026-03-01T12:00:00.000Z' }), postRecord({ text: 'olá varanda', at: '2026-03-01T12:00:01.000Z' })]
  })
  await admit(seeder, A, assoc)
  const admittedSize = seeder._admitted.size
  const servedSize = seeder._served.size

  // A known post: exact keys, raw blocks as hypercore stored them.
  const hit = await get('/moderation-post/' + A.key + '/2')
  t.is(hit.status, 200)
  t.is(hit.headers['content-type'], 'application/json; charset=utf-8')
  t.is(hit.headers['cache-control'], 'no-store')
  t.is(hit.headers['x-content-type-options'], 'nosniff')
  const body = JSON.parse(hit.body)
  t.alike(Object.keys(body), ['v', 'fork', 'length', 'block0', 'block'], 'exact keys')
  t.is(body.v, 1)
  t.is(body.fork, 0)
  t.is(body.length, 3)
  t.alike(b4a.from(body.block0, 'base64'), await A.diary.get(0, { raw: true }), 'block 0 decodes to the stored bytes')
  t.alike(b4a.from(body.block, 'base64'), await A.diary.get(2, { raw: true }), 'block 2 decodes to the stored bytes')
  t.is(JSON.parse(b4a.toString(b4a.from(body.block, 'base64'))).text, 'olá varanda')

  // A profile at that seq is still 200: the account service classifies it.
  const profile = await get('/moderation-post/' + A.key + '/1')
  t.is(profile.status, 200)
  t.alike(b4a.from(JSON.parse(profile.body).block, 'base64'), await A.diary.get(1, { raw: true }))

  // Refusals: all the same generic 404.
  const unknown = 'e'.repeat(64)
  notFound(t, await get('/moderation-post/' + unknown + '/1'), 'unknown diary')
  notFound(t, await get('/moderation-post/' + A.key + '/3'), 'seq == length')
  notFound(t, await get('/moderation-post/' + A.key + '/999999'), 'seq > length')
  notFound(t, await get('/moderation-post/' + A.key + '/0'), 'seq 0')
  notFound(t, await get('/moderation-post/' + A.key + '/2?x=1'), 'query string')
  notFound(t, await get('/moderation-post/' + A.key + '/2/'), 'trailing slash')
  notFound(t, await get('/moderation-post/' + A.key + '/2', {}), 'missing token')
  notFound(t, await get('/moderation-post/' + A.key + '/2', auth('d4'.repeat(32))), 'wrong token')
  notFound(t, await get('/moderation-post/' + A.key + '/2', auth('short')), 'wrong-length token')
  notFound(t, await get('/moderation-post/' + A.key + '/2', { Authorization: TOKEN }), 'no Bearer scheme')
  notFound(t, await get('/moderation-post/' + A.key + '/2', { Authorization: 'bearer ' + TOKEN }), 'scheme is case-sensitive here')
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
    const res = await request(ws.port, method, '/moderation-post/' + A.key + '/2', auth())
    t.is(res.status, 405, method + ' is 405')
    t.is(res.headers.allow, 'GET')
  }
  const misdirected = await request(ws.port, 'GET', '/moderation-post/' + A.key + '/2', { ...auth(), Host: 'evil.example:' + ws.port })
  t.is(misdirected.status, 421, 'Host check first')

  // Without a token the route does not exist.
  notFound(t, await request(plain.port, 'GET', '/moderation-post/' + A.key + '/2', auth()), 'no triageToken: 404')
  notFound(t, await request(plain.port, 'POST', '/moderation-post/' + A.key + '/2', auth()), 'no triageToken: not even 405')

  t.is(seeder._admitted.size, admittedSize, 'requests admit nothing')
  t.is(seeder._served.size, servedSize, 'requests serve nothing')
  t.absent(seeder._served.has(unknown))

  // A diary blocked by an adopted snapshot is 404.
  const B = await member(t, bootstrap, assoc, { records: () => [postRecord({ text: 'b', at: '2026-03-01T12:00:02.000Z' })] })
  await admit(seeder, B, assoc)
  t.is((await get('/moderation-post/' + B.key + '/1')).status, 200, 'B served before the block')
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  const snapshot = createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, modKp, modCert)
  await member(t, bootstrap, assoc, { joinPeer: publicKey, blocklist: { snapshot } })
  await until(() => seeder._isBlocked(B.key), { name: 'B bloqueado', timeoutMs: 30000 })
  notFound(t, await get('/moderation-post/' + B.key + '/1'), 'blocked diary')
  t.is(await seeder.postBlock(B.key, 1), null)

  // A block that is not local: A goes offline, the seeder clears block 2.
  await A.swarm.destroy()
  const entry = seeder._served.get(A.key)
  await entry.core.clear(2)
  t.absent(await entry.core.has(2))
  notFound(t, await get('/moderation-post/' + A.key + '/2'), 'non-local block')
  t.is((await get('/moderation-post/' + A.key + '/1')).status, 200, 'other local blocks still served')

  // postBlock refuses malformed input directly.
  t.is(await seeder.postBlock(A.key.toUpperCase(), 1), null)
  t.is(await seeder.postBlock(A.key, 0), null)
  t.is(await seeder.postBlock(A.key, 1.5), null)
  t.is(await seeder.postBlock(A.key, '1'), null)
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('GET /moderation-post and /index: a post its author deleted is the generic 404 and leaves the index', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const ws = await startSeedWs({ port: 0, seeder, triageToken: TOKEN, post: { rate: 1000, burst: 1000 } })
  t.teardown(() => ws.close(), { force: true })
  const get = (url, headers = auth()) => request(ws.port, 'GET', url, headers)

  const A = await member(t, bootstrap, assoc, {
    records: () => [
      postRecord({ text: 'apagado', at: '2026-03-01T12:00:00.000Z' }),
      postRecord({ text: 'mantido', at: '2026-03-01T12:00:01.000Z' }),
      deleteRecord({ seq: 1, at: '2026-03-01T12:00:02.000Z' })
    ]
  })
  await admit(seeder, A, assoc)
  await until(() => {
    const entry = seeder._served.get(A.key)
    return entry.scanned === 4 && entry.indexed === 4
  }, { name: 'diário varrido e indexado' })

  notFound(t, await get('/moderation-post/' + A.key + '/1'), 'deleted post')
  t.is((await get('/moderation-post/' + A.key + '/2')).status, 200, 'the surviving post is served')
  t.is(await seeder.postBlock(A.key, 1), null)

  notFound(t, await get('/index/post/' + A.key + '/1', {}), 'no thread page for the deleted post')
  t.is((await get('/index/post/' + A.key + '/2', {})).status, 200)
  const timeline = await get('/index/member/' + A.key, {})
  t.is(timeline.status, 200)
  t.alike(JSON.parse(timeline.body).posts, [2], 'the timeline omits the deleted post')
  const counts = JSON.parse((await get('/index/counts/' + A.key + ':1,' + A.key + ':2', {})).body).counts
  t.alike(Object.keys(counts), [A.key + ':2'], 'counts omit the deleted post')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('GET /moderation-post: own budget (503 beyond it), a seeder without postBlock or with a bad answer is 404', async (t) => {
  const key = 'a'.repeat(64)
  let calls = 0
  let answer = null
  const seeder = {
    stats: () => ({ status: 'ok' }),
    postBlock: async (diary, seq) => {
      calls++
      return typeof answer === 'function' ? answer(diary, seq) : answer
    }
  }
  const ws = await startSeedWs({ port: 0, seeder, triageToken: TOKEN, post: { burst: 3, rate: 0.001 } })
  t.teardown(() => ws.close(), { force: true })
  const url = '/moderation-post/' + key + '/7'

  // Unauthenticated requests never reach the seeder or spend the budget.
  for (let i = 0; i < 5; i++) notFound(t, await request(ws.port, 'GET', url, auth('00'.repeat(32))), 'wrong token')
  t.is(calls, 0)

  answer = (diary, seq) => ({ fork: 0, length: 9, block0: b4a.from('zero'), block: b4a.from(diary + ':' + seq) })
  const ok = await request(ws.port, 'GET', url, auth())
  t.is(ok.status, 200)
  t.is(b4a.toString(b4a.from(JSON.parse(ok.body).block, 'base64')), key + ':7', 'arguments: diary hex and a number')

  answer = { fork: 1, length: 9, block0: b4a.from('a'), block: b4a.from('b') }
  notFound(t, await request(ws.port, 'GET', url, auth()), 'fork != 0')
  answer = { fork: 0, length: 9, block0: b4a.alloc(40000), block: b4a.alloc(10000) }
  notFound(t, await request(ws.port, 'GET', url, auth()), 'body over 65536 bytes')
  const busy = await request(ws.port, 'GET', url, auth())
  t.is(busy.status, 503, 'bucket empty')
  t.is(busy.headers['retry-after'], '1')

  const bare = await startSeedWs({ port: 0, seeder: { stats: () => ({ status: 'ok' }) }, triageToken: TOKEN })
  t.teardown(() => bare.close(), { force: true })
  notFound(t, await request(bare.port, 'GET', url, auth()), 'no postBlock')

  // In-flight cap: two stalled calls hold both slots; the deadline frees them.
  let release
  const stalled = new Promise((resolve) => { release = resolve })
  const capped = await startSeedWs({
    port: 0,
    seeder: { stats: () => ({ status: 'ok' }), postBlock: () => stalled },
    triageToken: TOKEN,
    post: { deadlineMs: 300 }
  })
  t.teardown(() => capped.close(), { force: true })
  const first = request(capped.port, 'GET', url, auth()).catch(() => 'destroyed')
  const second = request(capped.port, 'GET', url, auth()).catch(() => 'destroyed')
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is((await request(capped.port, 'GET', url, auth())).status, 503, 'third concurrent request is 503')
  t.is(await first, 'destroyed', 'destroyed at the deadline')
  t.is(await second, 'destroyed')
  release(null)
  await new Promise((resolve) => setTimeout(resolve, 50))
  notFound(t, await request(capped.port, 'GET', url, auth()), 'slots freed once the calls settle')
})
