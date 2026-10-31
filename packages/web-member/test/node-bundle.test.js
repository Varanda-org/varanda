// The built browser node (scripts/build.js --node, the varanda-node.js the
// app's web build serves) run as a browser would run it: evaluated as a
// script that defines VarandaWebNode, over IndexedDB (fake-indexeddb) and a
// WebSocket global (ws), against an in-process seeder behind a WebSocket
// entry, with the page's WebAuthn globals faked (navigator.credentials, a
// fake authenticator with the PRF extension, PublicKeyCredential,
// isSecureContext, location). Proves the bundle's whole graph (Hypercore 10,
// the sodium shim, the session, the dispatcher and the passkey identity) runs:
// the diary opens only with the key derived from the passkey, the storage
// survives a restart and never holds the secret.
/* global indexedDB */
require('fake-indexeddb/auto')
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const ws = require('ws')
const b4a = require('b4a')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { keyPairFromPrf, toBase64Url } = require('../lib/passkey')
const { Seeder } = require('@varanda/core/lib/seeder')
const coreSync = require('@varanda/core/lib/sync')
const coreMember = require('@varanda/core/lib/member')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const BUILD = path.join(__dirname, '..', 'scripts', 'build.js')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

const FIXED32 = new Uint8Array(32).map((_, i) => i + 1)
const OTHER32 = new Uint8Array(32).fill(7)

function arrayBufferOf (bytes) {
  return new Uint8Array(bytes).buffer
}

// A fake CredentialsContainer holding at most one passkey. createMode:
// 'results' (PRF output on create), 'pending' (enabled only: the PRF comes
// on the next get) or 'disabled' (no PRF). prf: the output the
// authenticator gives (a fresh copy each time: passkey.js wipes it).
function fakeAuthenticator () {
  const fake = {
    createMode: 'results',
    prf: FIXED32,
    credential: null, // { rawId: Uint8Array, userId: Uint8Array }
    calls: [],
    create ({ publicKey }) {
      fake.calls.push({ kind: 'create', publicKey })
      const rawId = globalThis.crypto.getRandomValues(new Uint8Array(16))
      fake.credential = { rawId, userId: new Uint8Array(publicKey.user.id) }
      const ext = fake.createMode === 'results'
        ? { prf: { enabled: true, results: { first: arrayBufferOf(fake.prf) } } }
        : { prf: { enabled: fake.createMode === 'pending' } }
      return Promise.resolve(fake.credentialOf(ext))
    },
    get ({ publicKey }) {
      fake.calls.push({ kind: 'get', publicKey })
      if (fake.credential === null) return Promise.reject(Object.assign(new Error('none'), { name: 'NotAllowedError' }))
      // get() reports no `enabled`, only the output.
      return Promise.resolve(fake.credentialOf({ prf: { results: { first: arrayBufferOf(fake.prf) } } }))
    },
    credentialOf (ext) {
      const { rawId, userId } = fake.credential
      return {
        type: 'public-key',
        rawId: arrayBufferOf(rawId),
        id: toBase64Url(rawId),
        response: { userHandle: arrayBufferOf(userId) },
        getClientExtensionResults: () => ext
      }
    }
  }
  return fake
}

// Defines the page globals on globalThis (Node 24's navigator is a getter
// without a setter) and restores the original descriptors in teardown.
function installGlobals (t, values) {
  const saved = {}
  for (const [name, value] of Object.entries(values)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, enumerable: true, writable: true })
  }
  t.teardown(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
}

// Every raw row of an object store of the node's IndexedDB database.
function idbRows (store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('varanda-node')
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction([store], 'readonly')
      const all = tx.objectStore(store).getAll()
      const keys = tx.objectStore(store).getAllKeys()
      tx.oncomplete = () => {
        db.close()
        resolve(keys.result.map((key, i) => ({ key, value: all.result[i] })))
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

function holds (rows, needle) {
  return rows.some(({ value }) => {
    const buf = typeof value === 'string' ? b4a.from(value) : new Uint8Array(value)
    return b4a.indexOf(buf, needle) !== -1
  })
}

test('the built node bundle serves the RPC over IndexedDB and syncs with a seeder', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const out = path.join(tmpDir(t, 'varanda-node-bundle-'), 'varanda-node.js')
  const r = spawnSync(process.execPath, [BUILD, '--node', out], { encoding: 'utf8', timeout: 110000 })
  t.is(r.status, 0, 'build exits 0: ' + (r.stderr || '').trim())
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('NODE_BUNDLE '))
  t.ok(line && /^NODE_BUNDLE \d+ GZIP \d+$/.test(line), 'prints NODE_BUNDLE <bytes> GZIP <bytes>')
  t.comment(line)
  const code = fs.readFileSync(out, 'utf8')
  t.ok(code.includes('failed to derive shared secret'), 'carries the sodium shim')
  t.absent(code.includes('sodium-native'), 'no sodium-native')
  t.absent(code.includes('rocksdb'), 'no rocksdb')

  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const seederDir = tmpDir(t, 'varanda-node-bundle-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-node-bundle-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp)))
  Seeder.addCert(seederDir, certFile, association)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (socket) => {
    const raw = ws.createWebSocketStream(socket)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  // The page's globals: WebSocket (ws), IndexedDB (fake-indexeddb, above)
  // and WebAuthn (a fake authenticator).
  const fake = fakeAuthenticator()
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' }
  })
  const savedWs = globalThis.WebSocket
  globalThis.WebSocket = ws.WebSocket
  t.teardown(() => {
    globalThis.WebSocket = savedWs
    delete globalThis.VarandaWebNode
  })
  t.ok(code.includes('varanda/member-identity/prf/v1'), 'carries the passkey derivation')
  vm.runInThisContext(code, { filename: out })
  const api = globalThis.VarandaWebNode
  t.is(api.version, 1)
  t.ok(Object.isFrozen(api), 'the global is frozen')

  const bad = await api.start({ association: 'xyz', seederUrl }).then(() => null, (err) => err)
  t.is(bad && bad.message, 'chave da associação inválida', 'configuration errors reach the page in pt-BR')

  const expected = await keyPairFromPrf(new Uint8Array(FIXED32))
  const key = hex(expected.publicKey)
  const secret = b4a.from(expected.secretKey)

  const handle = await api.start({ association, seederUrl })
  t.alike(Object.keys(handle).sort(), ['close', 'connect', 'follows', 'identity', 'media'], 'only connect, close, follows, identity and media are exposed')
  t.ok(Object.isFrozen(handle) && Object.isFrozen(handle.identity) && Object.isFrozen(handle.media) && Object.isFrozen(handle.follows), 'the handle, identity, media and follows are frozen')
  t.alike(Object.keys(handle.identity).sort(), ['complete', 'lock', 'reset', 'signOut', 'status', 'unlock'], 'no getter, no signer')
  t.alike(Object.keys(handle.media), ['upload'])
  t.alike(Object.keys(handle.follows).sort(), ['confirmLegacy', 'legacy'])
  const badKeys = await errorOf(handle.follows.confirmLegacy('x'))
  t.ok(badKeys instanceof TypeError, 'a sync throw becomes a rejection')
  const web = await connectClient(handle, { timeoutMs: 60000 })

  const first = await handle.identity.status()
  t.is(first.unlocked, false, 'locked at start')
  t.is(first.exists, false)
  t.is(first.webauthn, true)
  t.is(first.prf, 'yes')
  t.is(first.rpId, 'localhost')
  t.is(first.passkeyKnown, false)
  t.absent('rpIdError' in first)
  const locked = await errorOf(web.request('identity.create'))
  t.is(locked && locked.code, 'USAGE')
  t.is(locked && locked.message, 'identidade bloqueada: entre com a passkey', 'identity.create needs the passkey')

  // No PRF: blocked, still locked, no diary.
  fake.createMode = 'disabled'
  const noPrf = await errorOf(handle.identity.unlock({ register: true }))
  t.is(noPrf && noPrf.code, 'NO_PRF', 'an authenticator without PRF is refused')
  const unusable = fake.credential
  t.is(noPrf && noPrf.credentialId, toBase64Url(unusable.rawId), 'the error names the unusable passkey')
  t.is(noPrf && noPrf.userId, hex(unusable.userId))
  const afterNoPrf = await handle.identity.status()
  t.is(afterNoPrf.unlocked, false)
  t.is(afterNoPrf.exists, false)
  t.is(afterNoPrf.passkeyKnown, false)

  // PRF only enabled on create: pending, then complete() fetches it.
  fake.createMode = 'pending'
  fake.calls.length = 0
  const pendingCall = handle.identity.unlock({ register: true })
  t.is(fake.calls.length, 1, 'create() is called synchronously, inside the click')
  t.is(fake.calls[0].publicKey.rp.id, 'localhost')
  t.ok(fake.calls[0].publicKey.excludeCredentials.every((c) => c.id instanceof Uint8Array))
  t.alike(fake.calls[0].publicKey.excludeCredentials.map((c) => new Uint8Array(c.id)), [unusable.rawId],
    'the unusable passkey is excluded from the next creation')
  t.alike(await pendingCall, { pending: true }, 'a creation without the PRF output is pending')
  t.is((await handle.identity.status()).unlocked, false, 'still locked while pending')

  // A second creation while one is pending excludes the pending passkey
  // (and, when the manager creates another anyway, replaces it).
  const firstPending = fake.credential
  fake.calls.length = 0
  t.alike(await handle.identity.unlock({ register: true }), { pending: true })
  t.alike(fake.calls[0].publicKey.excludeCredentials.map((c) => new Uint8Array(c.id)).sort(byBytes),
    [unusable.rawId, firstPending.rawId].sort(byBytes), 'the pending passkey is excluded from a new creation')

  // The record is published only with a successful unlock: a failed kv
  // write, or a lock() during it, leaves no record and keeps the pending
  // creation (complete() still works afterwards).
  const realPut = globalThis.IDBObjectStore.prototype.put
  t.teardown(() => { globalThis.IDBObjectStore.prototype.put = realPut })
  globalThis.IDBObjectStore.prototype.put = function (value, key) {
    if (key === 'passkey') throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    return realPut.call(this, value, key)
  }
  const writeFailed = await errorOf(handle.identity.complete())
  globalThis.IDBObjectStore.prototype.put = realPut
  t.ok(writeFailed, 'complete() fails when the record cannot be written')
  const afterWriteFailed = await handle.identity.status()
  t.is(afterWriteFailed.unlocked, false, 'locked after a failed record write')
  t.is(afterWriteFailed.passkeyKnown, false, 'no passkey remembered after a failed record write')
  t.absent(await kvValue('passkey'), 'no record stored')
  let lockOnce = true
  globalThis.IDBObjectStore.prototype.put = function (value, key) {
    if (key === 'passkey' && lockOnce) {
      lockOnce = false
      handle.identity.lock()
    }
    return realPut.call(this, value, key)
  }
  const lockedDuringWrite = await errorOf(handle.identity.complete())
  globalThis.IDBObjectStore.prototype.put = realPut
  t.is(lockedDuringWrite && lockedDuringWrite.code, 'CANCELLED', 'a lock() during the record write cancels')
  const afterLockedWrite = await handle.identity.status()
  t.is(afterLockedWrite.unlocked, false)
  t.is(afterLockedWrite.passkeyKnown, false, 'the record is rolled back after a lock() during its write')
  t.absent(await kvValue('passkey'), 'the stored record is rolled back')

  const completing = handle.identity.complete()
  const concurrent = await errorOf(handle.identity.unlock())
  t.is(concurrent && concurrent.code, 'LOCKED', 'one passkey ceremony at a time')
  t.is(concurrent && concurrent.message, 'outra entrada com a passkey em andamento')
  const done = await completing
  t.alike(done, { publicKey: key, created: true }, 'complete() unlocks with the derived key')
  const getCall = fake.calls.find((c) => c.kind === 'get')
  t.ok(getCall.publicKey.allowCredentials[0].id instanceof Uint8Array, 'allowCredentials ids are bytes')
  t.alike(new Uint8Array(getCall.publicKey.allowCredentials[0].id), fake.credential.rawId, 'restricted to the new passkey')

  const kv = await idbRows('kv')
  const stored = JSON.parse(kv.find((r) => r.key === 'passkey').value)
  t.alike(Object.keys(stored).sort(), ['credentialId', 'rpId', 'userId', 'v'], 'the passkey record holds no secret')
  t.is(stored.credentialId, toBase64Url(fake.credential.rawId))
  t.is(stored.rpId, 'localhost')
  t.is(stored.userId, hex(fake.credential.userId))

  const unlocked = await handle.identity.status()
  t.is(unlocked.unlocked, true)
  t.is(unlocked.passkeyKnown, true)
  const { publicKey: created } = await web.request('identity.create')
  t.is(created, key, 'the diary key is the passkey-derived key')
  await web.request('cert.add', { cert: createCert({ member: key }, assocKp) })
  await web.request('post.create', { text: 'do pacote do nó' })
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped = await stoppedOf(web.events, runId)
  if (stopped.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped.reason, 'done')
  t.is(stopped.result.admitted, true)
  t.is(stopped.result.seederConfirmed, true)
  t.ok(seeder.admittedKeys().includes(key), 'the seeder admitted the diary')

  // The superseded pending passkey stays excluded, with the unusable one
  // and the current one (the creation is cancelled right away).
  const current = fake.credential
  fake.calls.length = 0
  const extra = handle.identity.unlock({ register: true })
  t.alike(fake.calls[0].publicKey.excludeCredentials.map((c) => new Uint8Array(c.id)).sort(byBytes),
    [unusable.rawId, firstPending.rawId, current.rawId].sort(byBytes), 'the unusable, superseded and current passkeys are excluded')
  await handle.identity.lock()
  t.is((await errorOf(extra)).code, 'CANCELLED')
  fake.credential = current
  t.alike(await kvValue('passkey'), stored, 'the stored record is untouched')
  await handle.close()
  t.absent(holds(await idbRows('pages'), secret), 'no IndexedDB page holds the secret')
  t.absent(holds(await idbRows('kv'), secret), 'no kv entry holds the secret')
  t.absent(holds(await idbRows('kv'), b4a.from(hex(secret))), 'nor its hex')

  // A new start (a page reload) resumes the stored session (lock() kept it)
  // without asking for the passkey; after signOut ('Sair') the diary is
  // locked and the stored passkey opens it again (signIn restricted to its id).
  fake.calls.length = 0
  const again = await api.start({ association, seederUrl })
  t.teardown(() => again.close(), { force: true })
  const web2 = await connectClient(again)
  const reloaded = await again.identity.status()
  t.is(reloaded.unlocked, true, 'resumed after a reload')
  t.is(reloaded.resumed, true)
  t.is(fake.calls.length, 0, 'without a passkey ceremony')
  t.is(reloaded.exists, true)
  t.is(reloaded.publicKey, key)
  t.is(reloaded.passkeyKnown, true)
  await again.identity.signOut()
  const signedOut = await again.identity.status()
  t.is(signedOut.unlocked, false, 'locked after signOut')
  t.is(signedOut.resumed, false)
  t.alike(await web2.request('identity.show'), { publicKey: key, association }, 'reads work locked')

  // Another PRF (another passkey) does not open this diary.
  fake.prf = OTHER32
  const mismatch = await errorOf(again.identity.unlock())
  t.is(mismatch && mismatch.code, 'MISMATCH')
  t.is(mismatch && mismatch.message, 'passkey não corresponde ao diário guardado')
  t.is(mismatch && mismatch.legacy, false)
  t.is((await again.identity.status()).unlocked, false, 'still locked after a mismatch')
  fake.prf = FIXED32

  // lock() during a ceremony cancels its result.
  const racing = again.identity.unlock()
  await again.identity.lock()
  const cancelled = await errorOf(racing)
  t.is(cancelled && cancelled.code, 'CANCELLED', 'a ceremony that outlives lock() is discarded')
  t.is((await again.identity.status()).unlocked, false)

  fake.calls.length = 0
  t.alike(await again.identity.unlock(), { publicKey: key, created: false }, 'sign in gives the same key')
  const signIn = fake.calls[0]
  t.is(signIn.kind, 'get')
  t.ok(signIn.publicKey.allowCredentials[0].id instanceof Uint8Array)
  t.alike(new Uint8Array(signIn.publicKey.allowCredentials[0].id), fake.credential.rawId, 'restricted to the stored passkey')
  t.is((await again.identity.status()).unlocked, true)
  const log = await web2.request('log.read', {})
  t.is(log.entries[1].record.text, 'do pacote do nó')

  await again.identity.lock()
  t.is((await again.identity.status()).unlocked, false, 'lock() locks')
  const lockedPost = await errorOf(web2.request('post.create', { text: 'bloqueado' }))
  t.is(lockedPost && lockedPost.message, 'identidade bloqueada: entre com a passkey')

  // reset() forgets the diary and the passkey record; a new passkey with
  // the PRF on create starts over.
  await again.identity.reset()
  const empty = await again.identity.status()
  t.is(empty.exists, false)
  t.is(empty.passkeyKnown, false)
  t.is(empty.unlocked, false)
  t.is(await kvValue('passkey'), null, 'the passkey record is gone')
  fake.createMode = 'results'
  t.alike(await again.identity.unlock({ register: true }), { publicKey: key, created: true }, 'PRF on create unlocks at once')
  t.is((await web2.request('identity.create')).publicKey, key)
  t.absent(holds(await idbRows('pages'), secret), 'still no page holds the secret')
})

// The same built bundle, driven only through its RPC, exchanges a public and a
// private group with a core node through a local seeder (loopback DHT).
test('the built node bundle exchanges public and private group messages with a core node', async (t) => {
  t.timeout(150000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const out = path.join(tmpDir(t, 'varanda-node-bundle-g-'), 'varanda-node.js')
  const r = spawnSync(process.execPath, [BUILD, '--node', out], { encoding: 'utf8', timeout: 110000 })
  t.is(r.status, 0, 'build exits 0: ' + (r.stderr || '').trim())
  const code = fs.readFileSync(out, 'utf8')

  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const seederDir = tmpDir(t, 'varanda-node-bundle-gseed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-node-bundle-gsc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
  Seeder.addCert(seederDir, certFile, association)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (socket) => {
    const raw = ws.createWebSocketStream(socket)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'

  const fake = fakeAuthenticator()
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  // A fresh IndexedDB: the first test left another association in the shared one.
  installGlobals(t, {
    indexedDB: new (require('fake-indexeddb').IDBFactory)(),
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' }
  })
  const savedWs = globalThis.WebSocket
  globalThis.WebSocket = ws.WebSocket
  t.teardown(() => {
    globalThis.WebSocket = savedWs
    delete globalThis.VarandaWebNode
  })
  vm.runInThisContext(code, { filename: out })
  const handle = await globalThis.VarandaWebNode.start({ association, seederUrl })
  t.teardown(() => handle.close(), { force: true })
  const web = await connectClient(handle, { timeoutMs: 60000 })
  const unlocked = await handle.identity.unlock({ register: true })
  const bKey = unlocked.publicKey
  await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: bKey }, assocKp) })
  await web.request('profile.set', { name: 'Bia', bio: '' })

  const coreCtx = { dataDir: tmpDir(t, 'varanda-node-bundle-gcore-'), association }
  const { publicKey: cKey } = await coreMember.idCreate(coreCtx)
  await coreMember.certAdd(coreCtx, createCert({ member: cKey }, assocKp))
  await coreMember.profileSet(coreCtx, { name: 'Caio' })

  async function syncWeb () {
    const { runId } = await web.request('sync.start', { once: true, timeoutMs: 30000 })
    return (await stoppedOf(web.events, runId)).result
  }
  const syncCore = () => coreSync.runSync({ dataDir: coreCtx.dataDir, ...localSwarmOptions(bootstrap), once: true, timeoutMs: 30000, onEvent: () => {} })
  const texts = (read) => read.items.filter((p) => !p.hidden).map((p) => p.text)
  const rootOnSeeder = (group) => until(() => seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === group && it.length > 0), { name: 'root on the seeder' })

  // Public group: the core node creates and posts, the bundle joins and reads,
  // posts, and the core node reads it back.
  const { group: pub } = await coreMember.groupCreate(coreCtx, { name: 'Praia', join: 'open', visibility: 'public' })
  await coreMember.groupPost(coreCtx, { group: pub, text: 'publica-c1' })
  t.ok((await syncCore()).ok, 'core pushes the public group')
  await rootOnSeeder(pub)
  t.is((await web.request('group.join', { group: pub })).state, 'pending', 'join before the root is pending')
  await syncWeb()
  const infoPub = await web.request('group.info', { group: pub })
  t.is(infoPub.state, 'member', 'the bundle is a member of the open group')
  t.alike(texts(await web.request('group.read', { group: pub })), ['publica-c1'], 'the bundle reads the core post')
  await web.request('group.post', { group: pub, text: 'publica-b1' })
  await syncWeb()
  t.ok((await syncCore()).ok, 'core fetches')
  t.alike(texts(await coreMember.groupRead(coreCtx, { group: pub })).sort(), ['publica-b1', 'publica-c1'], 'the core node reads the bundle post')

  // Private group, the core node as creator: the bundle joins by key before
  // it holds the root (a boxless writer no seeder admits), syncs, joins
  // again with a boxed writer, reads only a sealed count until admitted, then
  // the history, and posts.
  const { group: priv } = await coreMember.groupCreate(coreCtx, { name: 'Conselho', join: 'open', visibility: 'private' })
  await coreMember.groupPost(coreCtx, { group: priv, text: 'privada-c1' })
  t.ok((await syncCore()).ok, 'core pushes the private group')
  await rootOnSeeder(priv)
  t.is(seeder.indexGroup(priv).header.name, null, 'the index never names a private group')

  t.is((await web.request('group.join', { group: priv })).state, 'pending', 'join before the root is pending')
  const first = await syncWeb()
  t.ok(first.ok, 'the boxless writer is no push goal once the private root arrives' + (first.ok ? '' : ': ' + first.errors.join('; ')))
  t.is((await web.request('group.join', { group: priv })).state, 'requested', 'a boxed rejoin requests entry')
  t.ok((await syncWeb()).ok, 'the bundle pushes the request')
  const sealedRead = await web.request('group.read', { group: priv })
  t.alike(texts(sealedRead), [], 'a non-member reads no text')
  t.ok(sealedRead.sealed >= 1, 'it only counts sealed messages')

  t.ok((await syncCore()).ok, 'core fetches the request')
  t.alike((await coreMember.groupRequests(coreCtx, { group: priv })).requests.map((q) => q.member), [bKey], 'the core node sees the request')
  t.alike(await coreMember.groupAdmit(coreCtx, { group: priv, member: bKey, on: true }), { ok: true })
  t.ok((await syncCore()).ok, 'core pushes the admission and keys')
  await syncWeb()
  t.is((await web.request('group.info', { group: priv })).state, 'member', 'admitted')
  const openRead = await web.request('group.read', { group: priv })
  t.alike(texts(openRead), ['privada-c1'], 'the admitted bundle reads the history')
  t.is(openRead.sealed, 0)
  await web.request('group.post', { group: priv, text: 'privada-b1' })
  t.ok((await syncWeb()).ok, 'the bundle pushes its post')
  t.ok((await syncCore()).ok, 'core fetches')
  t.alike(texts(await coreMember.groupRead(coreCtx, { group: priv })).sort(), ['privada-b1', 'privada-c1'], 'the core node reads the bundle post')
  t.absent(holds(await idbRows('pages'), b4a.from('privada-b1')), 'the browser store never holds the private text in clear')
  t.comment('group exchange took ' + (Date.now() - started) + ' ms')
})

function byBytes (a, b) {
  return b4a.compare(a, b)
}

async function kvValue (key) {
  const row = (await idbRows('kv')).find((r) => r.key === key)
  return row ? JSON.parse(row.value) : undefined
}
