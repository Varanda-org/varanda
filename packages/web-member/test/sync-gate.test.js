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
