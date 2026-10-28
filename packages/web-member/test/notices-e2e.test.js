// Follow notices end to end: a real seeder behind a WebSocket server and
// three real browser nodes (lib/node.js over in-memory storage). A follows B
// through follow.add and a sync, the signed follow record drains to A's diary
// and reaches the seeder, and B's notices.list shows A (verified by B's node
// against A's own diary). C cannot see B's notices. Loopback only.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions, until } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { writeBlocklist, replicaExists } = require('../lib/node-store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

// A storage that records every core opened and every kv key written while
// `recording` is set.
function spyStorage () {
  const base = memoryNodeStorage()
  const spy = { recording: false, cores: [], writes: [] }
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'core') {
        return (name, opts) => {
          if (spy.recording) spy.cores.push(name)
          return target.core(name, opts)
        }
      }
      if (prop === 'writeJson') {
        return (key, value) => {
          if (spy.recording) spy.writes.push(key)
          return target.writeJson(key, value)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  return { storage, spy }
}

async function webNode (t, assoc, url, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), certify = false } = {}) {
  const internal = []
  const sockets = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      sockets.push(ws)
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, keyPair, key: publicKey, sockets, internal }
}

// A confirmed push: a once sync that finished ('done'), succeeded (ok) and
// that the seeder confirmed holding. 'done' alone is not proof (a once run
// that did not time out reports 'done' even when result.ok is false), so a
// run that is not confirmed is retried a bounded number of times and the
// test fails when none is.
async function push (t, n, label, { attempts = 5 } = {}) {
  let stopped = null
  for (let i = 0; i < attempts; i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    stopped = await stoppedOf(n.web.events, runId)
    if (stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true) break
    t.comment(label + ': attempt ' + (i + 1) + ' not confirmed: ' + JSON.stringify(stopped))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  t.is(stopped.reason, 'done', label + ' done')
  t.is(stopped.result && stopped.result.ok, true, label + ' ok')
  t.is(stopped.result && stopped.result.seederConfirmed, true, label + ' seeder confirmed')
  return stopped
}

// A settled notices.list read: supported and complete. An empty list from a
// read that timed out (incomplete) proves nothing, so this polls until a
// read settles and throws (failing the test) when none does in time.
function settled (r) {
  return r.supported === true && r.incomplete === false
}

function settledRead (web, name, ok = () => true) {
  return until(async () => {
    const r = await web.request('notices.list', {})
    return settled(r) && ok(r) ? r : null
  }, { name, intervalMs: 250, timeoutMs: 45000 })
}

test('follow notices end to end: follow, other member, follow back, unfollow, refollow, block, reload', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const modKeys = crypto.keyPair()
  const mod = { keyPair: modKeys, cert: createModeratorCert({ moderator: hex(modKeys.publicKey) }, kp) }

  // The real seeder.
  const seederDir = tmpDir(t, 'varanda-notices-e2e-seed-')
  Seeder.ensureConfig(seederDir, assoc.hex)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-notices-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assoc.kp)))
  Seeder.addCert(seederDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), log: noop })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const s of wss.clients) s.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', noop)
    seeder.acceptStream(raw)
  })
  const url = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  // Three certified browser nodes. B and C are pushed first (an unserved or
  // ungated diary's pages are incomplete, never final).
  const A = await webNode(t, assoc, url, { certify: true })
  const { storage, spy } = spyStorage()
  const B = await webNode(t, assoc, url, { storage, certify: true })
  const C = await webNode(t, assoc, url, { certify: true })
  await A.web.request('profile.set', { name: 'Ana' })
  for (const n of [B, C]) await push(t, n, 'pushed')
  for (const n of [B, C]) {
    await until(() => { const e = seeder._served.get(n.key); return e && e.gated }, { name: 'served', timeoutMs: 30000 })
  }

  let web = B.web
  const rowsOf = (r) => r.notices.map((n) => n.key)
  // One settled read, asserted exactly (for negative checks: no polling
  // until the wanted answer shows up).
  const read = (name) => settledRead(web, name)
  // Settled reads polled until `ok` holds (the seeder index converges).
  const waitFor = (name, ok) => settledRead(web, name, ok)

  // 2-3. A follows B and syncs: B sees exactly A.
  t.alike(await A.web.request('follow.add', { key: B.key }), { changed: true, followCount: 1 })
  await push(t, A, 'A pushed the follow')
  const first = await waitFor('A listed', (r) => r.notices.length === 1)
  t.is(first.notices[0].key, A.key)
  t.is(first.notices[0].name, 'Ana')
  t.is(first.notices[0].avatar, null)
  t.ok(first.notices[0].seq >= 1, 'a seq')
  t.ok(/^[0-9a-f]{32}$/.test(first.notices[0].seen), 'a 32-hex seen token')
  t.absent(A.key.includes(first.notices[0].seen), 'the token is not a slice of the follower key')
  t.is(first.supported, true)
  t.is(first.next, null)
  const firstSeq = first.notices[0].seq

  // 4. C sees nothing: the seeder answers for the key C proved.
  const cList = await settledRead(C.web, 'C settled')
  t.is(cList.supported, true)
  t.is(cList.incomplete, false)
  t.alike(cList.notices, [], 'C cannot see B\'s followers')

  // 5. B follows A back: A is omitted.
  spy.recording = true
  await web.request('follow.add', { key: A.key })
  t.alike(rowsOf(await read('followed settled')), [], 'a followed diary is omitted')

  // 6. B unfollows A: shown again. Then A unfollows B and syncs: gone.
  await web.request('follow.remove', { key: A.key })
  t.alike(rowsOf(await read('unfollowed settled')), [A.key], 'back after the unfollow')
  await A.web.request('follow.remove', { key: B.key })
  await push(t, A, 'A pushed the unfollow')
  const gone = await waitFor('A gone', (r) => r.notices.length === 0)
  t.alike(gone.notices, [])

  // 7. A follows B again: a new, greater seq.
  await A.web.request('follow.add', { key: B.key })
  await push(t, A, 'A pushed the refollow')
  const again = await waitFor('A again', (r) => r.notices.length === 1)
  t.is(again.notices[0].key, A.key)
  t.ok(again.notices[0].seq > firstSeq, 'a new seq: ' + again.notices[0].seq + ' > ' + firstSeq)
  t.ok(/^[0-9a-f]{32}$/.test(again.notices[0].seen), 'a 32-hex seen token')
  t.not(again.notices[0].seen, first.notices[0].seen, 'a new follow is a new seen token')

  // 8. A blocked in B's stored blocklist is dropped.
  await writeBlocklist(storage, createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.keyPair, mod.cert))
  t.alike(rowsOf(await read('blocked settled')), [], 'a blocked diary is dropped')

  // Nothing was stored by the reads and follow changes (the test's own
  // writes aside; follow.add/remove write the follows list).
  const own = spy.writes.filter((k) => k !== 'follows' && k !== 'blocklist' && k !== 'followsMigrated' && k !== 'followsPending')
  t.alike(spy.cores.filter((c) => c.startsWith('replica/')), [], 'no replica core opened')
  t.alike(own, [], 'no notices kv entry written')
  t.is(await replicaExists(storage, A.key), false, 'no replica of A')
  spy.recording = false

  // 9. Reload B over the same storage: still blocked, then back when unblocked.
  await B.node.close()
  const B2 = await webNode(t, assoc, url, { storage, keyPair: B.keyPair })
  t.is(B2.key, B.key, 'same identity')
  web = B2.web
  const reloaded = await read('reload settled')
  t.is(reloaded.incomplete, false, 'a settled read after the reload')
  t.alike(rowsOf(reloaded), [], 'still blocked after the reload')
  await writeBlocklist(storage, createSnapshot({ seq: 2, blocked: [], revokedIssuers: [] }, mod.keyPair, mod.cert))
  const back = await waitFor('A after the reload', (r) => r.notices.length === 1)
  t.is(back.notices[0].key, A.key)
  t.is(back.notices[0].name, 'Ana')
  t.is(back.notices[0].avatar, null)
  t.is(back.notices[0].seq, again.notices[0].seq)
  t.is(back.notices[0].seen, again.notices[0].seen, 'the same seen token after the reload (same identity, same follow)')
  t.is(await replicaExists(storage, A.key), false, 'no replica of A after the reload')
  t.is(await storage.readJson('notices'), null, 'no notices kv key')
  t.is(await storage.hasCore('notices'), false, 'no notices core')

  for (const n of [A, B, B2, C]) t.alike(n.internal, [], 'no internal error')
  for (const n of [A, B, B2, C]) {
    n.web.port.close()
    for (const s of n.sockets) s.terminate()
  }
})
