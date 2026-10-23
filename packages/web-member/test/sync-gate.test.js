// The browser node's own gate, against a fake seeder (Hypercore 10 over a
// WebSocket, certified by the association) that serves whatever diaries the
// test gives it, including ones a real seeder would never admit: a diary is
// only stored once its block 0 is a member certificate of the trusted
// association and its signed length fits the quota; an endpoint whose seeder
// certificate does not verify gets nothing.
const test = require('brittle')
const b4a = require('b4a')
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
// but not advertised (to see what the member uploads).
async function fakeSeeder (t, { signer, cores = [], spy = [] }) {
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
          if (msg.type !== 'announce') return
          announced.push(msg.key)
          peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', publicKey: hex(keyPair.publicKey), announced }
}

async function webNode (t, assoc, url, syncOptions = {}) {
  const storage = memoryNodeStorage()
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, ...syncOptions }
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  await web.request('post.create', { text: 'do navegador' })
  return { web, storage, key: publicKey }
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

  const feed = await web.request('feed.read', {})
  t.ok(feed.items.some((i) => i.author === hex(good.key) && i.text === 'servido pelo semeador' && i.name === 'Dani'))
  t.absent(feed.items.some((i) => i.author === hex(foreign.key)), 'nothing from the foreign diary')
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
