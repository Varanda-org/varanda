// The browser node's own gate, against a fake seeder (Hypercore 10 over a
// WebSocket, certified by the association) that serves whatever diaries the
// test gives it, including ones a real seeder would never admit: a diary is
// only stored once its block 0 is a member certificate of the trusted
// association and its signed length fits the quota; an endpoint whose seeder
// certificate does not verify gets nothing.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { createBrowserNode } = require('../lib/node')
const { runSync, MAX_PARALLEL_OPENS } = require('../lib/sync')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const { wsStream } = require('../lib/ws-stream')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A Hypercore 10 diary with the given records (block 0 first).
async function diary (t, records) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  return core
}

// A seeder stand-in: role 'seeder' with a certificate signed by `signer`,
// replicating `cores` and advertising them; it answers an announce with
// admitted at the length the member advertised. `spy` cores are replicated
// but not advertised (to see what the member uploads). seen(msg) gets
// every admission message from the member.
async function fakeSeeder (t, { signer, cores = [], spy = [], seen = () => {} }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const announced = []
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      for (const core of [...cores, ...spy]) core.replicate(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: cores.map((core) => ({ key: hex(core.key), length: core.length })),
        onmessage: (msg, peer) => {
          seen(msg)
          if (msg.type !== 'announce') return
          announced.push(msg.key)
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', publicKey: hex(keyPair.publicKey), announced }
}

// A seeder stand-in that speaks the admission channel by hand: its hello
// claims `count` diaries but carries none, and the overflow `have` messages
// never come, so the member's inventory completes only by its timeout
// (lib/admission.js INVENTORY_TIMEOUT_MS). It admits whatever is announced.
async function stallingSeeder (t, { signer, count }) {
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
      const mux = Hypercore.createProtocolStream(noise).userData
      let message = null
      const send = (msg) => message.send(b4a.from(JSON.stringify(msg), 'utf8'))
      const channel = mux.createChannel({
        protocol: 'varanda/admission/1',
        onopen: () => send({ type: 'hello', v: 1, role: 'seeder', count, have: [], cert })
      })
      message = channel.addMessage({
        encoding: c.buffer,
        onmessage: (buf) => {
          const msg = JSON.parse(b4a.toString(buf, 'utf8'))
          if (msg.type === 'announce') send({ type: 'admitted', key: msg.key, length: 0 })
        }
      })
      channel.open()
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The write gate is off unless asked: this file is about the follow gate,
// and the fake seeder never serves the own diary back (passkey-e2e.test.js
// covers it).
async function webNode (t, assoc, url, syncOptions = {}, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), write = true, ...options } = {}) {
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, ...syncOptions },
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  if (write) {
    await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
    await web.request('post.create', { text: 'do navegador' })
  }
  return { node, web, storage, key: publicKey, keyPair }
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

async function onceRun (web, timeoutMs = 10000) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs })
  return stoppedOf(web.events, runId)
}

test('a followed diary is stored only when its block 0 verifies and it fits the quota', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const other = association()
  const good = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name: 'Dani', bio: '' }),
    () => postRecord({ text: 'servido pelo semeador' })
  ])
  const foreign = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, other.kp)),
    () => postRecord({ text: 'de outra associação' })
  ])
  const noCert = await diary(t, [
    () => profileRecord({ name: 'Sem certificado', bio: '' }),
    () => postRecord({ text: 'x' })
  ])
  const big = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => postRecord({ text: 'um' }),
    () => postRecord({ text: 'dois' }),
    () => postRecord({ text: 'três' })
  ])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [good, foreign, noCert, big] })
  const { web, storage, key } = await webNode(t, assoc, seeder.url, { maxLogBlocks: 3 })
  for (const core of [good, foreign, noCert, big]) await web.request('follow.add', { key: hex(core.key) })

  const stopped = await onceRun(web)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.ok, true)
  t.alike(stopped.result.downloaded, { [hex(good.key)]: 3 }, 'only the good diary was downloaded')
  const skipped = Object.fromEntries(stopped.result.skipped.map((s) => [s.key, s.reason]))
  t.alike(skipped, {
    [hex(foreign.key)]: 'untrusted-association',
    [hex(noCert.key)]: 'not-in-log',
    [hex(big.key)]: 'quota'
  })
  t.ok(await storage.hasCore('replica/' + hex(good.key)), 'the good diary is stored')
  for (const core of [foreign, noCert, big]) {
    t.absent(await storage.hasCore('replica/' + hex(core.key)), 'never stored: ' + skipped[hex(core.key)])
  }
  const warnings = web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
  t.ok(warnings.includes('aviso: diário ' + hex(foreign.key).slice(0, 8) + ' ignorado (untrusted-association)'))
  t.ok(seeder.announced.includes(key), 'the own diary was announced to the verified seeder')

  const feed = await wholeFeed(web)
  t.ok(feed.items.some((i) => i.author === hex(good.key) && i.text === 'servido pelo semeador' && i.name === 'Dani'))
  t.absent(feed.items.some((i) => i.author === hex(foreign.key)), 'nothing from the foreign diary')
})

// A followed diary served by `seeder`, 2 + `posts` blocks: block 0, a
// profile, then posts one second apart.
async function longDiary (t, assoc, posts = 298) {
  return diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => profileRecord({ name: 'Dani', bio: '' }),
    ...Array.from({ length: posts }, (_, i) => () => postRecord({
      text: 'post ' + i,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    }))
  ])
}

// Math.random within 0.4..0.6 until restored: a random-order range would
// start near the middle of a diary. The values stay varied (HyperDHT draws
// stream ids from Math.random and retries on a collision).
function middleRandom (t) {
  const random = Math.random
  const restore = () => { Math.random = random }
  t.teardown(restore, { force: true })
  let seed = 1
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return 0.4 + 0.2 * (seed / 2147483647)
  }
  return restore
}

function range (start, end) {
  return Array.from({ length: end - start }, (_, i) => start + i)
}

test('a followed diary downloads block 0, then its newest window, then the rest in block order', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const served = await longDiary(t, assoc)
  const uploads = []
  served.on('upload', (index) => uploads.push(index))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [served] })
  const { node, web, storage } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key: hex(served.key) })

  const restore = middleRandom(t)
  const stopped = await onceRun(web)
  restore()
  t.is(stopped.reason, 'done')
  const order = [...new Set(uploads)]
  t.is(order[0], 0, 'block 0 first')
  t.alike(order.slice(0, 35).sort((a, b) => a - b), [0, 1, 2, ...range(268, 300)], 'then blocks 1 and 2 and the newest 32, nothing else')
  const rest = order.slice(35)
  t.alike([...rest].sort((a, b) => a - b), range(3, 268), 'then the history')
  // Requests in flight complete out of order, so only the window is checked.
  t.ok(rest.slice(0, 32).every((i) => i < 64), 'the history starts at block 3')
  t.is((await web.request('feed.read', { limit: 31 })).items.length, 31)

  await node.close()
  const replica = new Hypercore(storage.core('replica/' + hex(served.key)), served.key, { valueEncoding: 'json' })
  t.teardown(() => replica.close(), { force: true })
  await replica.ready()
  t.is(replica.length, served.length, 'the stored replica has the full diary length')
  t.is(replica.contiguousLength, served.length, 'every block is stored locally')
})

// A seeder's copy of `from` holding only the blocks of `ranges` ([start,
// end) pairs) at its full signed length; fill() fetches the rest, fetch(list)
// more ranges.
async function sparseCopy (t, from, ranges) {
  const core = new Hypercore(memoryStorage(), from.key, { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  const fetch = async (list) => {
    const a = from.replicate(true)
    const b = core.replicate(false)
    a.pipe(b).pipe(a)
    for (const [start, end] of list) await core.download({ start, end }).done()
    a.destroy()
    b.destroy()
  }
  await fetch(ranges)
  return { core, fetch, fill: () => fetch([[0, from.length]]) }
}

async function until (fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function postsOf (feed, key) {
  return feed.items.filter((i) => i.author === key).map((i) => i.text)
}

// Every page of feed.read (at most 31 items each) -> { items, incomplete }
// of the last page.
async function wholeFeed (web) {
  const items = []
  let before = null
  for (;;) {
    const page = await web.request('feed.read', before === null ? { limit: 31 } : { limit: 31, before })
    items.unshift(...page.items)
    if (page.items.length < 31) return { items, incomplete: page.incomplete }
    before = { at: page.items[0].at, author: page.items[0].author, seq: page.items[0].seq }
  }
}

function posts (from, to) {
  return range(from, to).map((i) => 'post ' + i)
}

test('a seeder missing the middle of a followed diary: the feed shows its newest posts, then the history when it arrives', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const served = await longDiary(t, assoc)
  const key = hex(served.key)
  const partial = await sparseCopy(t, served, [[0, 3], [268, 300]])
  t.is(partial.core.length, 300, 'fixture: the seeder knows the signed length')
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [partial.core] })
  const { web } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key })
  await web.request('sync.start', {})

  // Blocks 268..299 hold posts 266..297; block 2 holds post 0.
  const newest = ['post 0', ...posts(266, 298)].sort()
  let feed = null
  const shown = await until(async () => {
    feed = await wholeFeed(web)
    return postsOf(feed, key).length === newest.length
  })
  t.ok(shown, 'the newest posts were shown')
  t.alike(postsOf(feed, key).sort(), newest, 'block 0\'s prefix and the newest run, nothing else')
  t.alike(feed.incomplete, [key])
  t.ok(feed.items.filter((i) => i.author === key).every((i) => i.name === 'Dani'), 'named by the profile at block 1')

  await partial.fill()
  const filled = await until(async () => {
    feed = await wholeFeed(web)
    return postsOf(feed, key).length === 298
  })
  t.ok(filled, 'the history arrived once the seeder had it')
  t.alike(postsOf(feed, key).sort(), posts(0, 298).sort())
  t.alike(feed.incomplete, [])
  await web.request('sync.stop')
})

test('a returning visit downloads the newest window first and never advertises a length it does not hold', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const served = await longDiary(t, assoc, 98)
  const key = hex(served.key)
  const uploads = []
  const haves = []
  served.on('upload', (index) => uploads.push(index))
  const seeder = await fakeSeeder(t, {
    signer: assoc.kp,
    cores: [served],
    seen: (msg) => {
      if (msg.type === 'have' && msg.key === key) haves.push({ length: msg.length, uploaded: new Set(uploads) })
    }
  })
  const { web } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key })
  const first = await onceRun(web)
  t.is(first.reason, 'done')
  t.is(first.result.downloaded[key], 100, 'fixture: the first visit holds 100 blocks')

  for (let i = 98; i < 298; i++) {
    await served.append(postRecord({ text: 'post ' + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
  }
  uploads.length = 0
  haves.length = 0
  const restore = middleRandom(t)
  const again = await onceRun(web)
  restore()
  t.is(again.reason, 'done')
  t.is(again.result.downloaded[key], 300)
  const order = [...new Set(uploads)]
  t.ok(order[0] >= 268 && order[0] < 300, 'the first upload is in the newest window (' + order[0] + ')')
  t.alike(order.slice(0, 32).sort((a, b) => a - b), range(268, 300), 'the newest window comes first')
  t.ok(haves.length > 0, 'fixture: the member advertised the key')
  for (const { length, uploaded } of haves) {
    t.ok(range(100, length).every((i) => uploaded.has(i)), 'have ' + length + ' covers only stored blocks')
  }
})

test('the newest window of a followed diary is announced once, before its present length grows', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const served = await longDiary(t, assoc, 98)
  const key = hex(served.key)
  const partial = await sparseCopy(t, served, [[0, 100]])
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [partial.core] })
  const { web } = await webNode(t, assoc, seeder.url)
  await web.request('follow.add', { key })
  const first = await onceRun(web)
  t.is(first.result.downloaded[key], 100, 'fixture: the first visit holds 100 blocks')
  for (let i = 98; i < 298; i++) {
    await served.append(postRecord({ text: 'post ' + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
  }
  // The seeder has the new tip but not the blocks between.
  await partial.fetch([[268, 300]])
  t.is(partial.core.length, 300, 'fixture: the seeder knows the signed length')

  const from = web.events.length
  await web.request('sync.start', {})
  const lines = () => web.events.slice(from).filter((e) => e.name === 'sync.event').map((e) => e.data.line)
  const newest = 'newest ' + key + ' 300'
  t.ok(await until(() => lines().includes(newest)), 'the window is announced')
  t.absent(lines().some((l) => l.startsWith('downloaded ' + key + ' ')), 'no growth while the history is missing')
  const feed = await wholeFeed(web)
  t.ok(postsOf(feed, key).includes('post 297'), 'the newest post is in the feed')

  await partial.fill()
  t.ok(await until(() => lines().includes('downloaded ' + key + ' 300')), 'the history arrived')
  const all = lines()
  t.ok(all.indexOf(newest) < all.findIndex((l) => l.startsWith('downloaded ' + key + ' ')), 'before the first growth')
  t.is(all.filter((l) => l.startsWith('newest ')).length, 1, 'once')
  await web.request('sync.stop')
})

// A follower that stored [0, 3) and the window [68, 100) of a 100-block
// diary (its seeder never had the middle), then the author posts 40 more and
// the seeder gets only [108, 140) of them for now (partial.fetch the rest).
// The head never stalls into the body here (headStallMs).
async function tailFixture (t, syncOptions = {}) {
  const assoc = association()
  const served = await longDiary(t, assoc, 98)
  const key = hex(served.key)
  const partial = await sparseCopy(t, served, [[0, 3], [68, 100]])
  const uploads = new Set()
  partial.core.on('upload', (index) => uploads.add(index))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [partial.core] })
  const { web } = await webNode(t, assoc, seeder.url, { headStallMs: 60000, ...syncOptions })
  await web.request('follow.add', { key })
  await web.request('sync.start', {})
  t.ok(await until(async () => postsOf(await wholeFeed(web), key).length === 33), 'fixture: the first visit shows the old window')
  await web.request('sync.stop')
  for (let i = 98; i < 138; i++) {
    await served.append(postRecord({ text: 'post ' + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
  }
  await partial.fetch([[108, 140]])
  t.is(partial.core.length, 140, 'fixture: the seeder knows the signed length')
  uploads.clear()
  const lines = () => web.events.filter((e) => e.name === 'sync.event').map((e) => e.data.line)
  return { web, key, uploads, partial, lines }
}

test('a follower coming back fetches the whole new tail, so the stored window reconnects', async (t) => {
  t.timeout(90000)
  await testnet(t)
  const { web, key, uploads, partial, lines } = await tailFixture(t)
  const newest = 'newest ' + key + ' 140'
  await web.request('sync.start', {})
  t.ok(await until(() => range(108, 140).every((i) => uploads.has(i))), 'the newest 32 blocks arrived')
  // Without the tail rule the window [108, 140) is complete now.
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.absent(lines().includes(newest), 'the head still waits for [100, 108)')
  await partial.fetch([[100, 108]])
  // Blocks 68..139 hold posts 66..137; the middle never arrives.
  const want = ['post 0', ...posts(66, 138)].sort()
  let feed = null
  const shown = await until(async () => {
    feed = await wholeFeed(web)
    return postsOf(feed, key).length === want.length
  })
  t.ok(shown, 'the old window is shown again with the tail')
  t.alike(postsOf(feed, key).sort(), want)
  t.ok(range(100, 108).every((i) => uploads.has(i)), 'every block of the tail was requested')
  t.ok(lines().includes(newest), 'the window [100, 140) completed')
  await web.request('sync.stop')
})

test('a tail longer than tailBlocks gets only the newest window', async (t) => {
  t.timeout(90000)
  await testnet(t)
  const { web, key, uploads, lines } = await tailFixture(t, { tailBlocks: 16 })
  await web.request('sync.start', {})
  t.ok(await until(() => lines().includes('newest ' + key + ' 140')), 'the window [108, 140) completed without [100, 108)')
  t.absent(range(100, 108).some((i) => uploads.has(i)), 'fixture: the seeder had none of [100, 108)')
  // Blocks 108..139 hold posts 106..137: the run does not reach the old window.
  const want = ['post 0', ...posts(106, 138)].sort()
  let feed = null
  t.ok(await until(async () => {
    feed = await wholeFeed(web)
    return postsOf(feed, key).length === want.length
  }), 'the newest window is shown')
  t.alike(postsOf(feed, key).sort(), want, 'the old window is not, until the history arrives')
  await web.request('sync.stop')
})

test('a followed diary whose seeder withholds the newest blocks still downloads its history', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const served = await longDiary(t, assoc)
  const key = hex(served.key)
  const partial = await sparseCopy(t, served, [[0, 268]])
  t.is(partial.core.length, 300, 'fixture: the seeder knows the signed length')
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [partial.core] })
  const { web } = await webNode(t, assoc, seeder.url, { headStallMs: 200 })
  await web.request('follow.add', { key })
  await web.request('sync.start', {})
  let feed = null
  const filled = await until(async () => {
    feed = await wholeFeed(web)
    return postsOf(feed, key).length === 266
  })
  t.ok(filled, 'the history arrived although the window never did')
  t.alike(postsOf(feed, key).sort(), posts(0, 266).sort())
  t.alike(feed.incomplete, [key])
  await web.request('sync.stop')
})

test('the own diary still downloads in block order', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const keyPair = crypto.keyPair()
  const writer = { storage: memoryNodeStorage(), association: assoc.hex, keyPair, mediaKeyPair: crypto.keyPair() }
  const { publicKey } = await ops.idCreate(writer)
  await ops.certAdd(writer, createCert({ member: publicKey }, assoc.kp))
  for (let i = 0; i < 199; i++) await ops.postCreate(writer, { text: 'meu ' + i })
  const source = await store.openDiary(writer.storage)
  const held = new Hypercore(memoryStorage(), keyPair.publicKey)
  await held.ready()
  t.teardown(() => held.close(), { force: true })
  const a = source.replicate(true)
  const b = held.replicate(false)
  a.pipe(b).pipe(a)
  await held.download({ start: 0, end: source.length }).done()
  a.destroy()
  b.destroy()
  await source.close()
  const uploads = []
  held.on('upload', (index) => uploads.push(index))
  const seeder = await fakeSeeder(t, { signer: assoc.kp, cores: [held] })

  // A fresh device of the same identity: an empty diary.
  const fresh = { storage: memoryNodeStorage(), association: assoc.hex, keyPair, mediaKeyPair: crypto.keyPair() }
  await ops.idCreate(fresh)
  const restore = middleRandom(t)
  const ac = new AbortController()
  const run = runSync({ storage: fresh.storage, seederUrl: seeder.url, createSocket: (u) => new WebSocket(u), signal: ac.signal })
  t.ok(await until(() => new Set(uploads).size === 200), 'the diary came back')
  ac.abort()
  await run
  restore()
  const order = [...new Set(uploads)]
  t.is(order.length, 200, 'every block was uploaded')
  t.is(order[0], 0, 'block 0 first')
  t.ok(order.slice(0, 32).every((i) => i < 64), 'from the start of the diary, not its newest blocks')
})

test('an endpoint whose seeder certificate does not verify gets nothing', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const impostorSigner = generateAssociationKeyPair()
  const served = await diary(t, [
    (key) => memberCertRecord(createCert({ member: key }, assoc.kp)),
    () => postRecord({ text: 'nunca deveria chegar' })
  ])
  // The impostor also holds an empty replica of the web diary: anything the
  // web node uploaded would land in it.
  const nodeShell = await webNode(t, assoc, 'ws://127.0.0.1:9/seeder')
  const spy = new Hypercore(memoryStorage(), b4a.from(nodeShell.key, 'hex'))
  await spy.ready()
  t.teardown(() => spy.close(), { force: true })
  spy.download({ start: 0, end: -1 })
  const impostor = await fakeSeeder(t, { signer: impostorSigner, cores: [served], spy: [spy] })

  // The same storage, now pointed at the impostor.
  const node = createBrowserNode({
    storage: nodeShell.storage,
    association: assoc.hex,
    seederUrl: impostor.url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 }
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(nodeShell.keyPair) // follows need the key (signed ops)
  const web = await connectClient(node, { timeoutMs: 30000 })
  await web.request('follow.add', { key: hex(served.key) })
  const stopped = await onceRun(web, 2000)
  t.is(stopped.reason, 'timeout')
  t.is(stopped.result.ok, false)
  t.alike(stopped.result.errors, ['sem pares'])
  t.ok(stopped.result.errorsSoft.includes('semeador não verificado'))
  t.alike(stopped.result.downloaded, {})
  const lines = web.events.filter((e) => e.name === 'sync.event').map((e) => e.data.line)
  t.ok(lines.includes('peer seeder ' + impostor.publicKey.slice(0, 8) + ' não verificado'))
  t.absent(lines.some((l) => l.startsWith('admitted ')), 'never admitted')
  t.is(impostor.announced.length, 0, 'never announced to it')
  t.is(spy.contiguousLength, 0, 'no block of the web diary reached it')
  t.absent(await nodeShell.storage.hasCore('replica/' + hex(served.key)), 'nothing stored from it')
})

test('an inventory completed only by the timeout leaves the own diary unknown: no done, no write', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  // Claims 3 diaries, sends none: the own key's advertisement never comes.
  const seeder = await stallingSeeder(t, { signer: assoc.kp, count: 3 })
  const { web, key } = await webNode(t, assoc, seeder.url, {}, { write: false, writeGate: true, writeGateTimeoutMs: 7000 })
  const stopped = await onceRun(web, 7000)
  t.is(stopped.reason, 'timeout', 'a once run cannot end done')
  t.is(stopped.result.ok, false)
  t.is(stopped.result.seeders, 1, 'the seeder verified')
  t.alike(stopped.result.errors, ['tempo esgotado: ' + key + ':0/?'], 'the own diary is the unmet goal, unknown')
  const warnings = web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)
  t.ok(warnings.some((l) => l.startsWith('aviso: inventário incompleto')), 'the inventory timed out')
  t.absent(web.events.some((e) => e.name === 'sync.event' && /^diário próprio sincronizado/.test(e.data.line)), 'never own-synced')

  const from = web.events.length
  const refused = await web.request('cert.add', { cert: createCert({ member: key }, assoc.kp) }).catch((err) => err)
  t.is(refused.code, 'USAGE')
  t.is(refused.message, 'sincronize com o semeador antes de publicar', 'the gate does not pass on an unknown inventory')
  const runs = await runsSince(web, from)
  t.is(runs.length, 1)
  t.is(runs[0].lines[0], 'sincronizando antes de publicar')
  t.is(runs[0].stopped.reason, 'timeout')
  t.is((await web.request('node.info')).memberCert, false, 'nothing written')
})

test('a write handler pushes while the seeder has not confirmed the local length, an idempotent cert.add included', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const seeder = await fakeSeeder(t, { signer: assoc.kp })
  // The certificate was written without a push (as after a push that
  // timed out, or in a previous session); the storage outlives the node.
  const first = await webNode(t, assoc, seeder.url, {}, { write: false })
  const cert = createCert({ member: first.key }, assoc.kp)
  t.alike(await first.web.request('cert.add', { cert }), { seq: 0 })
  t.absent(first.web.events.some((e) => e.name === 'sync.started'), 'no push with the gate off')
  first.storage.close = async () => {}
  await first.node.close()

  const { web } = await webNode(t, assoc, seeder.url, {}, { storage: first.storage, keyPair: first.keyPair, write: false, writeGate: true })
  const from = web.events.length
  t.alike(await web.request('cert.add', { cert }), { seq: 0 }, 'the same certificate again')
  const runs = await runsSince(web, from)
  t.is(runs.length, 2, 'the gate run and a push run although nothing was appended')
  t.is(runs[0].lines[0], 'sincronizando antes de publicar')
  t.is(runs[1].lines[0], 'enviando ao semeador')
  t.is(runs[1].stopped.reason, 'done')
  t.is(runs[1].stopped.result.seederConfirmed, true, 'the seeder confirmed the local length')
  t.ok(seeder.announced.includes(first.key), 'announced (the gate run announces too: block 0 holds the certificate)')

  const again = web.events.length
  t.alike(await web.request('cert.add', { cert }), { seq: 0 })
  const later = await runsSince(web, again)
  t.is(later.length, 1, 'confirmed: only the gate run this time')
  t.is(later[0].lines[0], 'sincronizando antes de publicar')
})

// A certified member on a fresh storage following `count` stored replicas
// (block 0 and a post each), in kv order; the ones at `bad` carry a
// certificate of another association.
async function startupFixture (t, assoc, count, bad) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: assoc.hex, keyPair, mediaKeyPair: crypto.keyPair() }
  await ops.idCreate(ctx)
  const own = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: own }, assoc.kp))
  const other = association()
  const keys = []
  const badKeys = []
  for (let i = 0; i < count; i++) {
    const signer = bad.includes(i) ? other.kp : assoc.kp
    const source = await diary(t, [(k) => memberCertRecord(createCert({ member: k }, signer)), () => postRecord({ text: 'poste ' + i })])
    const key = hex(source.key)
    const replica = await store.openReplica(storage, key)
    const a = source.replicate(true)
    const b = replica.replicate(false)
    a.pipe(b).pipe(a)
    await replica.download({ start: 0, end: source.length }).done()
    a.destroy()
    b.destroy()
    await replica.close()
    keys.push(key)
    if (bad.includes(i)) badKeys.push(key)
  }
  await store.writeFollows(storage, keys)
  await store.writeFollowsMigrated(storage)
  return { storage, own, badKeys, list: await store.readFollows(storage) }
}

// store.openReplica delayed so later keys in the list finish first; counts
// the opens per key, the peak in flight and the closes of the opened cores.
function slowOpens (t, list, { onOpen = () => {} } = {}) {
  const original = store.openReplica
  const n = { perKey: new Map(), inflight: 0, peak: 0, opens: 0, closes: 0 }
  store.openReplica = async function (storage, key) {
    n.opens++
    n.perKey.set(key, (n.perKey.get(key) || 0) + 1)
    n.peak = Math.max(n.peak, ++n.inflight)
    onOpen(key)
    try {
      await new Promise((resolve) => setTimeout(resolve, 10 * (list.length - list.indexOf(key))))
      const core = await original.call(this, storage, key)
      const close = core.close.bind(core)
      let counted = false
      core.close = (...args) => {
        if (!counted) n.closes++
        counted = true
        return close(...args)
      }
      return core
    } finally {
      n.inflight--
    }
  }
  t.teardown(() => { store.openReplica = original }, { force: true })
  return { counters: n, restore: () => { store.openReplica = original } }
}

// A seeder stand-in that only records the member's hello inventory, in order.
async function inventorySeeder (t, signer) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seen = { have: null }
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have: [],
        onmessage: (msg, peer) => {
          if (seen.have === null) seen.have = [...peer.remoteHave.keys()]
          if (msg.type === 'announce') peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', seen }
}

test('stored follows open a few at a time at run start; states, skips and inventory stay in list order', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const { storage, own, badKeys: bad, list } = await startupFixture(t, assoc, 12, [3, 8])
  const seeder = await inventorySeeder(t, assoc.kp)
  const slow = slowOpens(t, list)
  const events = []
  const ac = new AbortController()
  const run = runSync({
    storage,
    seederUrl: seeder.url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    signal: ac.signal,
    onEvent: (ev) => events.push(ev)
  })
  const end = Date.now() + 15000
  while (seeder.seen.have === null && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25))
  ac.abort()
  await run
  slow.restore()
  const n = slow.counters
  t.ok(n.peak > 1, 'opens overlap (peak ' + n.peak + ')')
  t.ok(n.peak <= MAX_PARALLEL_OPENS, 'at most ' + MAX_PARALLEL_OPENS + ' at once')
  t.alike([...n.perKey.keys()].sort(), [...list].sort(), 'every stored follow was opened')
  t.ok([...n.perKey.values()].every((times) => times === 1), 'each key once')
  const skips = events.filter((e) => e.event === 'skipped')
  t.alike(skips.map((e) => e.key), list.filter((k) => bad.includes(k)), 'skipped in list order')
  t.ok(skips.every((e) => typeof e.reason === 'string' && e.reason === skips[0].reason), 'with the gate reason (' + (skips[0] && skips[0].reason) + ')')
  t.alike(seeder.seen.have, [own, ...list.filter((k) => !bad.includes(k))], 'the inventory follows the list')
  t.is(n.closes, n.opens, 'every opened core was closed')
})

test('a run aborted while the stored follows open closes every core it opened', async (t) => {
  t.timeout(60000)
  await testnet(t)
  const assoc = association()
  const { storage, list } = await startupFixture(t, assoc, 12, [])
  const ac = new AbortController()
  const slow = slowOpens(t, list, { onOpen: () => ac.abort() })
  const result = await runSync({
    storage,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    retryMinMs: 100,
    retryMaxMs: 200,
    socketCloseMs: 50,
    signal: ac.signal
  })
  slow.restore()
  t.ok(result.ok, 'a continuous run ended by its signal')
  t.ok(slow.counters.opens >= 1, 'fixture: an open was in flight at the abort')
  t.ok(slow.counters.opens < list.length, 'no new opens once ending')
  t.is(slow.counters.closes, slow.counters.opens, 'opens equal closes')
})
