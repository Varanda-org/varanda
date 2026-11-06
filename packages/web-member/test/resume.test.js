// web/node.js, "stay signed in until 'Sair'": the page entry run from source
// (not bundled: test/node-bundle.test.js covers the bundle) over
// fake-indexeddb, node:crypto's WebCrypto (globalThis.crypto), a WebSocket
// global (ws) and a fake authenticator with the PRF extension, against an
// in-process seeder. Proves: a successful unlock stores the session and a new
// start() resumes it without any WebAuthn call (status().resumed true, writes
// work); lock() keeps it, signOut() and reset() erase it; a MISMATCH saves
// nothing; a tampered record, another public key or another passkey clears
// it and leaves the node locked; the per-device media nonce is drawn once and
// stable across resumes, its key is not the identity key; handle.media.upload
// delegates to the node's mediaUpload. The second test: refused passkeys
// (NO_PRF, NOT_SYNCED, SUPERSEDED) and a pending creation live in kv
// 'passkeyAttempts' across restarts, refused ids stay excluded from creation
// and never block a sign-in, the manager is asked to drop only a passkey this
// page load created, unlock({ any }) and unlock({ phone }) and reset/signOut.
/* global indexedDB */
require('fake-indexeddb/auto')
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const ws = require('ws')
const b4a = require('b4a')
const { testnet, tmpDir, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { keyPairFromPrf, mediaKeyPairFromPrf, toBase64Url } = require('../lib/passkey')
const { createSessionStore, STORE, RECORD_KEY } = require('../lib/session-store')
const nodeModule = require('../lib/node')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const FIXED32 = new Uint8Array(32).map((_, i) => i + 1)
const OTHER32 = new Uint8Array(32).fill(7)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function arrayBufferOf (bytes) {
  return new Uint8Array(bytes).buffer
}

// A fake CredentialsContainer holding at most one passkey, PRF on create.
function fakeAuthenticator () {
  const fake = {
    prf: FIXED32,
    credential: null,
    calls: [],
    create ({ publicKey }) {
      fake.calls.push({ kind: 'create', publicKey })
      const rawId = globalThis.crypto.getRandomValues(new Uint8Array(16))
      fake.credential = { rawId, userId: new Uint8Array(publicKey.user.id) }
      return Promise.resolve(fake.credentialOf({ prf: { enabled: true, results: { first: arrayBufferOf(fake.prf) } } }))
    },
    get ({ publicKey }) {
      fake.calls.push({ kind: 'get', publicKey })
      if (fake.credential === null) return Promise.reject(Object.assign(new Error('none'), { name: 'NotAllowedError' }))
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

// One request on an object store of an IndexedDB database (raw access). A
// database that does not exist yet is not created here (an open without a
// version would create it empty, at version 1, without its object store).
async function idb (dbName, storeName, mode, fn) {
  const dbs = await indexedDB.databases()
  if (!dbs.some((d) => d.name === dbName)) return undefined
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.close()
        resolve(undefined)
        return
      }
      const tx = db.transaction([storeName], mode)
      const r = fn(tx.objectStore(storeName))
      tx.oncomplete = () => {
        db.close()
        resolve(r ? r.result : undefined)
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

const sessionRecord = () => idb('varanda-session', STORE, 'readonly', (s) => s.get(RECORD_KEY))
const putSessionRecord = (record) => idb('varanda-session', STORE, 'readwrite', (s) => s.put(record, RECORD_KEY))

async function kvValue (key) {
  const value = await idb('varanda-node', 'kv', 'readonly', (s) => s.get(key))
  return value === undefined ? undefined : JSON.parse(value)
}

test('the stored session: resume without a passkey, lock keeps it, signOut and reset erase it', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const seederDir = tmpDir(t, 'varanda-resume-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-resume-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
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

  const fake = fakeAuthenticator()
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })

  // Spy on the node web/node.js builds: what setKeyPair receives (copied at
  // once, the caller zeroes it right after) and a stub mediaUpload.
  const pairs = []
  const uploads = []
  const realCreate = nodeModule.createBrowserNode
  nodeModule.createBrowserNode = (options) => {
    t.is(options.leaseHoldMs, 0, 'the hosted page keeps its seeder link while visible (lease off)')
    const node = realCreate(options)
    const setKeyPair = node.setKeyPair
    node.setKeyPair = (pair, extra) => {
      const media = extra && extra.media ? extra.media : null
      pairs.push({ identity: hex(pair.publicKey), media: media ? hex(media.publicKey) : null, mediaSecret: media ? media.secretKey.length : 0 })
      return setKeyPair(pair, extra)
    }
    node.mediaUpload = (args) => {
      uploads.push(args)
      if (args.mode === 'throw') throw Object.assign(new TypeError('mídia inválida'), { code: 'USAGE' })
      if (args.mode === 'reject') return Promise.reject(Object.assign(new Error('identidade bloqueada: entre com a passkey'), { code: 'USAGE' }))
      return Promise.resolve({ core: 'ab'.repeat(32), echo: args.bytes.byteLength })
    }
    return node
  }
  t.teardown(() => {
    nodeModule.createBrowserNode = realCreate
    delete globalThis.VarandaWebNode
  })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode

  const expected = await keyPairFromPrf(new Uint8Array(FIXED32))
  const key = hex(expected.publicKey)
  const start = async () => {
    const handle = await api.start({ association, seederUrl })
    t.teardown(() => handle.close(), { force: true })
    return handle
  }

  // ---- first start: a passkey ceremony unlocks and stores the session ----
  let h = await start()
  t.alike(Object.keys(h).sort(), ['close', 'connect', 'follows', 'identity', 'media'])
  t.ok(Object.isFrozen(h.media), 'media is frozen')
  t.alike(Object.keys(h.identity).sort(), ['addPasskey', 'bindPasskey', 'cancelRecovery', 'complete', 'finishRecovery', 'lock', 'makeRecoveryCode', 'reset', 'signOut', 'status', 'unlock', 'unlockWithCode', 'unlockWrapped'])
  let status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(status.resumed, false)
  t.is(await sessionRecord(), undefined, 'no stored session yet')
  t.alike(await h.identity.unlock({ register: true }), { publicKey: key, created: true })
  status = await h.identity.status()
  t.is(status.unlocked, true)
  t.is(status.resumed, false, 'a ceremony is not a resume')
  const saved = await sessionRecord()
  t.ok(saved, 'the session is stored')
  t.is(saved.rpId, 'localhost')
  t.is(saved.publicKey, key)
  t.is(saved.credentialId, toBase64Url(fake.credential.rawId))
  t.is(b4a.indexOf(b4a.from(saved.ciphertext), b4a.from(FIXED32)), -1, 'the PRF output is not stored in clear')
  const device = await kvValue('mediaDevice')
  t.is(device && device.v, 1, 'the media nonce is drawn')
  t.ok(/^[0-9a-f]{64}$/.test(device.nonce))
  const nonce = device.nonce
  const media = hex((await mediaKeyPairFromPrf(new Uint8Array(FIXED32), new Uint8Array(b4a.from(nonce, 'hex')))).publicKey)
  t.alike(pairs[pairs.length - 1], { identity: key, media, mediaSecret: 64 }, 'setKeyPair gets the identity and the media pair')
  t.not(media, key, 'the media key is not the identity key')
  let web = await connectClient(h, { timeoutMs: 60000 })
  t.is((await web.request('identity.create')).publicKey, key)
  await web.request('cert.add', { cert: createCert({ member: key }, assocKp) })
  await h.close()

  // ---- a reload resumes: no WebAuthn call, unlocked, writes work ----
  fake.calls.length = 0
  h = await start()
  status = await h.identity.status()
  t.is(fake.calls.length, 0, 'no passkey ceremony on resume')
  t.is(status.unlocked, true, 'resumed unlocked')
  t.is(status.resumed, true)
  t.is(status.publicKey, key)
  t.is((await kvValue('mediaDevice')).nonce, nonce, 'the media nonce is stable')
  t.alike(pairs[pairs.length - 1], { identity: key, media, mediaSecret: 64 }, 'the same media key on resume')
  web = await connectClient(h, { timeoutMs: 60000 })
  t.alike(await web.request('post.create', { text: 'depois de recarregar' }), { seq: 1, ref: key + ':1' }, 'a write after the resume')

  // handle.media.upload delegates and keeps the errors' code and message.
  const bytes = new Uint8Array([1, 2, 3])
  const onProgress = () => {}
  t.alike(await h.media.upload({ bytes, mime: 'image/png', width: 1, height: 1, onProgress }), { core: 'ab'.repeat(32), echo: 3 })
  t.is(uploads[0].bytes, bytes, 'the arguments reach the node as given')
  t.is(uploads[0].onProgress, onProgress)
  const thrown = h.media.upload({ bytes, mode: 'throw' })
  t.ok(thrown instanceof Promise, 'a synchronous throw becomes a rejection')
  const e1 = await errorOf(thrown)
  t.is(e1.code, 'USAGE')
  t.is(e1.message, 'mídia inválida')
  const e2 = await errorOf(h.media.upload({ bytes, mode: 'reject' }))
  t.is(e2.code, 'USAGE')
  t.is(e2.message, 'identidade bloqueada: entre com a passkey')

  // lock() is memory-only: the next start resumes.
  await h.identity.lock()
  status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(status.resumed, false)
  t.ok(await sessionRecord(), 'lock keeps the stored session')
  await h.close()
  h = await start()
  status = await h.identity.status()
  t.is(status.unlocked, true, 'resumed after a lock')
  t.is(status.resumed, true)
  t.is(fake.calls.length, 0)

  // ---- signOut ('Sair'): locked and forgotten ----
  await h.identity.signOut()
  status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(status.resumed, false)
  t.is(await sessionRecord(), undefined, 'signOut erases the stored session')
  await h.close()
  h = await start()
  status = await h.identity.status()
  t.is(status.unlocked, false, 'no resume after signOut')
  t.is(status.resumed, false)
  t.is(status.passkeyKnown, true)
  t.is(fake.calls.length, 0)

  // A MISMATCH saves nothing; the right passkey unlocks and saves again.
  fake.prf = OTHER32
  const mismatch = await errorOf(h.identity.unlock())
  t.is(mismatch && mismatch.code, 'MISMATCH')
  t.is((await h.identity.status()).unlocked, false)
  t.is(await sessionRecord(), undefined, 'a MISMATCH saves no session')
  fake.prf = FIXED32
  t.alike(await h.identity.unlock(), { publicKey: key, created: false })
  t.is((await h.identity.status()).resumed, false)
  t.ok(await sessionRecord())
  t.is((await kvValue('mediaDevice')).nonce, nonce, 'still the same nonce')
  await h.close()

  // ---- a tampered record: cleared, locked ----
  const tampered = await sessionRecord()
  tampered.ciphertext = new Uint8Array(tampered.ciphertext)
  tampered.ciphertext[0] ^= 1
  await putSessionRecord(tampered)
  fake.calls.length = 0
  h = await start()
  t.is((await h.identity.status()).unlocked, false, 'a tampered session does not unlock')
  t.is(await sessionRecord(), undefined, 'and is cleared')
  t.is(fake.calls.length, 0)
  await h.identity.unlock()
  await h.close()
  fake.calls.length = 0

  // ---- a session for another public key: cleared, locked ----
  const credentialId = toBase64Url(fake.credential.rawId)
  const sessions = createSessionStore({ indexedDB: globalThis.indexedDB, crypto: globalThis.crypto })
  const otherKey = hex((await keyPairFromPrf(new Uint8Array(OTHER32))).publicKey)
  await sessions.save(new Uint8Array(OTHER32), { rpId: 'localhost', credentialId, publicKey: otherKey })
  h = await start()
  t.is((await h.identity.status()).unlocked, false, 'a session for another identity does not unlock')
  t.is(await sessionRecord(), undefined, 'and is cleared')
  await h.close()

  // ---- a session naming another passkey: cleared, locked ----
  await sessions.save(new Uint8Array(FIXED32), { rpId: 'localhost', credentialId: 'AAECAwQFBgcICQoLDA0ODw', publicKey: key })
  h = await start()
  t.is((await h.identity.status()).unlocked, false, 'a session of another passkey does not unlock')
  t.is(await sessionRecord(), undefined, 'and is cleared')
  t.is(fake.calls.length, 0, 'none of these starts asked for the passkey')

  // ---- reset: the stored session and the media nonce are gone ----
  await h.identity.unlock()
  t.ok(await sessionRecord())
  await h.identity.reset()
  t.is(await sessionRecord(), undefined, 'reset erases the stored session')
  status = await h.identity.status()
  t.is(status.exists, false)
  t.is(status.resumed, false)
  await h.close()
  h = await start()
  status = await h.identity.status()
  t.is(status.unlocked, false, 'no resume after reset')
  t.is(status.exists, false)
  t.alike(await h.identity.unlock({ register: true }), { publicKey: key, created: true })
  const after = await kvValue('mediaDevice')
  t.ok(after && after.nonce !== nonce, 'a new media nonce after reset')

  // A session that cannot be saved still unlocks, and says so.
  await h.identity.signOut()
  const realPut = globalThis.IDBObjectStore.prototype.put
  t.teardown(() => { globalThis.IDBObjectStore.prototype.put = realPut })
  globalThis.IDBObjectStore.prototype.put = function (value, k) {
    if (k === RECORD_KEY) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    return realPut.call(this, value, k)
  }
  t.alike(await h.identity.unlock(), { publicKey: key, created: false, sessionSaved: false })
  globalThis.IDBObjectStore.prototype.put = realPut
  t.is((await h.identity.status()).unlocked, true, 'unlocked without a stored session')
  t.is(await sessionRecord(), undefined)

  // ---- a signOut whose deletions fail: rejected, locked, and never resumed ----
  t.ok(await h.identity.unlock(), 'unlocked again')
  t.ok(await sessionRecord(), 'and saved')
  t.is(await kvValue('signedOut'), null, 'a saved ceremony lifts the sign-out marker')
  const realDelete = globalThis.IDBObjectStore.prototype.delete
  const realDeleteDatabase = indexedDB.deleteDatabase
  const restore = () => {
    globalThis.IDBObjectStore.prototype.delete = realDelete
    indexedDB.deleteDatabase = realDeleteDatabase
  }
  t.teardown(restore)
  globalThis.IDBObjectStore.prototype.delete = function (k) {
    if (k === RECORD_KEY) throw Object.assign(new Error('broken'), { name: 'UnknownError' })
    return realDelete.call(this, k)
  }
  let deletes = 0
  indexedDB.deleteDatabase = () => {
    deletes++
    const req = {}
    setTimeout(() => { if (req.onerror) req.onerror() })
    return req
  }
  const failed = await errorOf(h.identity.signOut())
  restore()
  t.is(failed && failed.code, 'SIGNOUT_INCOMPLETE', 'signOut says it did not finish')
  t.is(failed && failed.message, 'não foi possível sair por completo neste aparelho: tente de novo')
  t.is(deletes, 1, 'the database deletion was tried')
  t.is((await h.identity.status()).unlocked, false, 'locked anyway')
  t.ok(await sessionRecord(), 'the record survived the failed deletions')
  t.alike(await kvValue('signedOut'), { v: 1 }, 'the sign-out marker is set')
  await h.close()
  fake.calls.length = 0
  h = await start()
  status = await h.identity.status()
  t.is(status.unlocked, false, 'the marker refuses the surviving session')
  t.is(status.resumed, false)
  t.is(fake.calls.length, 0)
  t.is(await sessionRecord(), undefined, 'and the resume clears it')
  t.alike(await h.identity.unlock(), { publicKey: key, created: false }, 'a ceremony unlocks')
  t.ok(await sessionRecord(), 'and saves again')
  t.is(await kvValue('signedOut'), null)
  // The diary was reset above: create it again so there is one to resume.
  web = await connectClient(h, { timeoutMs: 60000 })
  t.is((await web.request('identity.create')).publicKey, key)
  await h.close()
  h = await start()
  t.is((await h.identity.status()).resumed, true, 'resumes again after that ceremony')
  await h.close()
})

// 37 bytes of authenticator data: rpIdHash, flags (UP, UV, BE and BS when
// synced), signCount.
function authData (synced) {
  const bytes = new Uint8Array(37)
  bytes[32] = synced ? 0x1d : 0x05
  return arrayBufferOf(bytes)
}

// A fake CredentialsContainer holding many passkeys. createMode: 'results',
// 'pending' or 'disabled' (no PRF); createPrf: the PRF output of a
// 'results' creation; synced: the BE flag of the next
// creation; getPrf: whether a get returns the PRF output. A get with
// allowCredentials answers only for one of those ids; without it
// (discoverable) the newest passkey answers.
function manyAuthenticator () {
  const fake = {
    createMode: 'results',
    createPrf: FIXED32,
    synced: true,
    getPrf: true,
    creds: [],
    calls: [],
    create ({ publicKey }) {
      fake.calls.push({ kind: 'create', publicKey })
      const cred = fake.add(new Uint8Array(publicKey.user.id))
      const ext = fake.createMode === 'results'
        ? { prf: { enabled: true, results: { first: arrayBufferOf(fake.createPrf) } } }
        : { prf: { enabled: fake.createMode === 'pending' } }
      return Promise.resolve(fake.credentialOf(cred, ext, fake.synced))
    },
    get ({ publicKey }) {
      fake.calls.push({ kind: 'get', publicKey })
      const allow = (publicKey.allowCredentials || []).map((c) => toBase64Url(new Uint8Array(c.id)))
      const pool = allow.length > 0 ? fake.creds.filter((c) => allow.includes(toBase64Url(c.rawId))) : fake.creds
      const cred = pool[pool.length - 1]
      if (!cred) return Promise.reject(Object.assign(new Error('none'), { name: 'NotAllowedError' }))
      const ext = fake.getPrf ? { prf: { results: { first: arrayBufferOf(FIXED32) } } } : {}
      return Promise.resolve(fake.credentialOf(cred, ext, false))
    },
    add (userId) {
      const cred = { rawId: globalThis.crypto.getRandomValues(new Uint8Array(16)), userId }
      fake.creds.push(cred)
      return cred
    },
    last () {
      return fake.creds[fake.creds.length - 1]
    },
    remove (cred) {
      fake.creds = fake.creds.filter((c) => c !== cred)
    },
    credentialOf (cred, ext, synced) {
      return {
        type: 'public-key',
        rawId: arrayBufferOf(cred.rawId),
        id: toBase64Url(cred.rawId),
        response: { userHandle: arrayBufferOf(cred.userId), getAuthenticatorData: () => authData(synced) },
        getClientExtensionResults: () => ext
      }
    }
  }
  return fake
}

function deleteDb (name) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

test('passkey attempts: refused and pending ids survive a restart, cleanup only for passkeys this page created', async (t) => {
  t.timeout(60000)
  await deleteDb('varanda-node')
  await deleteDb('varanda-session')
  // A seeder entry that accepts sockets and says nothing: no test here syncs.
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => socket.on('error', () => {}))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  const association = hex(generateAssociationKeyPair().publicKey)

  const fake = manyAuthenticator()
  const signals = []
  let signalMode = 'ok'
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true, hybridTransport: true, userVerifyingPlatformAuthenticator: false })
  PublicKeyCredential.signalUnknownCredential = async (arg) => {
    signals.push(arg)
    if (signalMode === 'throw') throw new Error('not allowed')
  }
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })
  // The first test ran (and cached) web/node.js: load a fresh copy.
  delete require.cache[require.resolve('../web/node.js')]
  t.teardown(() => { delete globalThis.VarandaWebNode })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode
  const key = hex((await keyPairFromPrf(new Uint8Array(FIXED32))).publicKey)
  const start = async () => {
    const handle = await api.start({ association, seederUrl })
    t.teardown(() => handle.close(), { force: true })
    return handle
  }
  const idOf = (cred) => toBase64Url(cred.rawId)
  const excludedOf = (call) => call.publicKey.excludeCredentials.map((c) => toBase64Url(new Uint8Array(c.id)))
  const lastCall = (kind) => fake.calls.filter((c) => c.kind === kind).pop()

  let h = await start()
  t.alike(Object.keys(h.identity).sort(), ['addPasskey', 'bindPasskey', 'cancelRecovery', 'complete', 'finishRecovery', 'lock', 'makeRecoveryCode', 'reset', 'signOut', 'status', 'unlock', 'unlockWithCode', 'unlockWrapped'], 'the identity methods, recovery included')
  let status = await h.identity.status()
  t.is(status.pending, false)
  t.alike(status.refused, [])
  t.is(status.hybrid, 'yes')
  t.is(status.platform, 'no')
  t.is(status.signal, 'yes')

  // ---- a created passkey without PRF: refused, cleaned up, excluded ----
  fake.createMode = 'disabled'
  const noPrf = await errorOf(h.identity.unlock({ register: true }))
  const noPrfCred = fake.last()
  t.is(noPrf.code, 'NO_PRF')
  t.alike(lastCall('create').publicKey.hints, ['client-device', 'hybrid'], 'the default create hints')
  t.is(noPrf.credentialId, idOf(noPrfCred))
  t.is(noPrf.userId, hex(noPrfCred.userId))
  t.is(noPrf.cleaned, true, 'a created NO_PRF passkey is dropped from the manager')
  t.alike(signals, [{ rpId: 'localhost', credentialId: idOf(noPrfCred) }], 'the signal names exactly that passkey')
  status = await h.identity.status()
  t.alike(status.refused, [{ userId: hex(noPrfCred.userId), code: 'NO_PRF', cleaned: true, created: true }], 'refused, without its credential id')
  await h.close()

  // ---- after a restart: excluded; a not synced creation is refused ----
  h = await start()
  fake.createMode = 'results'
  fake.synced = false
  signalMode = 'throw'
  const notSynced = await errorOf(h.identity.unlock({ register: true }))
  const boundCred = fake.last()
  t.ok(excludedOf(lastCall('create')).includes(idOf(noPrfCred)), 'a NO_PRF id stays excluded after a restart')
  t.is(notSynced.code, 'NOT_SYNCED')
  t.is(notSynced.credentialId, idOf(boundCred))
  t.is(notSynced.userId, hex(boundCred.userId))
  t.is(notSynced.cleaned, false, 'a throwing signal gives cleaned false')
  t.alike(signals[1], { rpId: 'localhost', credentialId: idOf(boundCred) })
  status = await h.identity.status()
  t.is(status.unlocked, false, 'nothing is bound')
  t.is(status.passkeyKnown, false)
  t.absent(await kvValue('passkey'), 'no passkey record')
  t.alike(status.refused.filter((e) => e.code === 'NOT_SYNCED'), [{ userId: hex(boundCred.userId), code: 'NOT_SYNCED', cleaned: false, created: true }])
  fake.synced = true
  signalMode = 'ok'
  await h.close()

  // ---- pending creations: the phone hint, a superseded id, a restart ----
  h = await start()
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true, phone: true }), { pending: true })
  const pendingA = fake.last()
  t.alike(lastCall('create').publicKey.hints, ['hybrid'], 'register with phone sends the hybrid hint only')
  t.ok(excludedOf(lastCall('create')).includes(idOf(boundCred)), 'a NOT_SYNCED id is excluded next time')
  const storedA = await kvValue('passkeyAttempts')
  t.is(storedA.pending.credentialId, idOf(pendingA), 'the pending creation is stored before { pending: true }')
  t.is(storedA.pending.phone, true)
  t.alike(await h.identity.unlock({ register: true, phone: true }), { pending: true })
  const pendingB = fake.last()
  t.ok(excludedOf(lastCall('create')).includes(idOf(pendingA)), 'the pending id is excluded from a new creation')
  status = await h.identity.status()
  t.alike(status.refused.filter((e) => e.code === 'SUPERSEDED'), [{ userId: hex(pendingA.userId), code: 'SUPERSEDED', cleaned: false, created: true }], 'the superseded pending id is refused')
  await h.close()

  h = await start()
  status = await h.identity.status()
  t.is(status.pending, true, 'a pending creation survives a restart')
  // A restored pending that fails NO_PRF is not this page's creation: no cleanup.
  fake.getPrf = false
  const signalsBefore = signals.length
  const restoredNoPrf = await errorOf(h.identity.complete())
  t.is(restoredNoPrf.code, 'NO_PRF')
  t.alike(lastCall('get').publicKey.hints, ['hybrid'], 'complete() of a phone creation sends the hybrid hint')
  t.is(signals.length, signalsBefore, 'no signal for a pending restored from kv')
  t.absent(restoredNoPrf.cleaned, 'cleaned absent or false')
  status = await h.identity.status()
  t.is(status.pending, false)
  t.alike(status.refused.find((e) => e.userId === hex(pendingB.userId)), { userId: hex(pendingB.userId), code: 'NO_PRF', cleaned: false, created: true }, 'a restored pending is still a creation of this page')
  fake.getPrf = true

  fake.calls.length = 0
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingC = fake.last()
  t.alike(excludedOf(fake.calls[0]).sort(), [noPrfCred, boundCred, pendingA, pendingB].map(idOf).sort(), 'every refused id is excluded')
  await h.close()
  h = await start()
  t.is((await h.identity.status()).pending, true)
  t.alike(await h.identity.complete(), { publicKey: key, created: true }, 'complete() finishes a restored pending creation')
  t.absent('hints' in lastCall('get').publicKey, 'no hints on a get by default')
  t.is((await kvValue('passkeyAttempts')).pending, null, 'and clears it from the record')
  status = await h.identity.status()
  t.is(status.pending, false)
  t.is(status.unlocked, true)
  t.is((await kvValue('passkey')).credentialId, idOf(pendingC))

  // ---- sign-in: hints, a NO_PRF never cleaned up, BE clear still unlocks ----
  await h.identity.signOut()
  t.ok(await kvValue('passkeyAttempts'), 'signOut keeps the attempts record')
  t.alike(await h.identity.unlock({ phone: true }), { publicKey: key, created: false })
  t.alike(lastCall('get').publicKey.hints, ['hybrid'], 'sign-in with phone sends the hybrid hint')
  await h.identity.signOut()
  t.alike(await h.identity.unlock(), { publicKey: key, created: false }, 'a get whose authenticator data has BE clear still unlocks')
  t.absent('hints' in lastCall('get').publicKey)
  await h.identity.signOut()
  fake.getPrf = false
  const signalsNow = signals.length
  const signInNoPrf = await errorOf(h.identity.unlock())
  fake.getPrf = true
  t.is(signInNoPrf.code, 'NO_PRF')
  t.is(signals.length, signalsNow, 'a sign-in NO_PRF never asks the manager to drop the passkey')
  t.absent(signInNoPrf.cleaned)
  t.alike((await h.identity.status()).refused.find((e) => e.code === 'NO_PRF' && e.userId === hex(pendingC.userId)),
    { userId: hex(pendingC.userId), code: 'NO_PRF', cleaned: false, created: false }, 'a sign-in NO_PRF is not a creation of this page')
  t.is((await h.identity.status()).passkeyKnown, true, 'the known passkey stays known')
  t.alike(await h.identity.unlock(), { publicKey: key, created: false }, 'and still signs in')

  // ---- the known passkey is gone from the manager ----
  await h.identity.signOut()
  fake.remove(pendingC)
  const lost = await errorOf(h.identity.unlock())
  t.is(lost.code, 'CANCELLED')
  t.is((await h.identity.status()).passkeyKnown, true, 'a known passkey whose sign-in fails stays known')
  const other = fake.add(new Uint8Array(32).fill(9))
  t.alike(await h.identity.unlock({ any: true }), { publicKey: key, created: false }, 'unlock({ any: true }) uses the discoverable passkey')
  t.absent('allowCredentials' in lastCall('get').publicKey, 'a discoverable get')
  t.is((await kvValue('passkey')).credentialId, idOf(other))

  // ---- reset drops the record, but the device-bound creation ----
  await h.identity.reset()
  t.alike(await kvValue('passkeyAttempts'), {
    v: 1, rpId: 'localhost', pending: null, refused: [{ credentialId: idOf(boundCred), userId: hex(boundCred.userId), code: 'NOT_SYNCED', cleaned: false, created: true }]
  }, 'reset keeps only the device-bound creation in the attempts record')
  status = await h.identity.status()
  t.alike(status.refused, [{ userId: hex(boundCred.userId), code: 'NOT_SYNCED', cleaned: false, created: true }])
  t.is(status.pending, false)
  await h.close()
})

test('passkey attempts: an immediate-PRF replacement keeps the old pending until bound, a stale pending never resolves', async (t) => {
  t.timeout(60000)
  await deleteDb('varanda-node')
  await deleteDb('varanda-session')
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => socket.on('error', () => {}))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  const association = hex(generateAssociationKeyPair().publicKey)

  const fake = manyAuthenticator()
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  PublicKeyCredential.signalUnknownCredential = async () => {}
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })
  // A hook run inside the kv write of 'passkeyAttempts', before it settles.
  let onAttemptsWrite = null
  const put = globalThis.IDBObjectStore.prototype.put
  globalThis.IDBObjectStore.prototype.put = function (value, key) {
    if (key === 'passkeyAttempts' && onAttemptsWrite !== null) {
      const hook = onAttemptsWrite
      onAttemptsWrite = null
      hook()
    }
    return put.apply(this, arguments)
  }
  t.teardown(() => { globalThis.IDBObjectStore.prototype.put = put })
  delete require.cache[require.resolve('../web/node.js')]
  t.teardown(() => { delete globalThis.VarandaWebNode })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode
  const key = hex((await keyPairFromPrf(new Uint8Array(FIXED32))).publicKey)
  const h = await api.start({ association, seederUrl })
  t.teardown(() => h.close(), { force: true })
  const idOf = (cred) => toBase64Url(cred.rawId)
  const excludedOf = (call) => call.publicKey.excludeCredentials.map((c) => toBase64Url(new Uint8Array(c.id)))
  const lastCall = (kind) => fake.calls.filter((c) => c.kind === kind).pop()

  // A diary of the FIXED32 key, then signed out.
  t.alike(await h.identity.unlock({ register: true }), { publicKey: key, created: true })
  const web = await connectClient(h, { timeoutMs: 60000 })
  t.is((await web.request('identity.create')).publicKey, key)
  await h.identity.signOut()

  // ---- a replacement whose install fails: the old pending stays ----
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingA = fake.last()
  fake.createMode = 'results'
  fake.createPrf = OTHER32
  const mismatch = await errorOf(h.identity.unlock({ register: true }))
  const failed = fake.last()
  fake.createPrf = FIXED32
  t.is(mismatch && mismatch.code, 'MISMATCH', 'the new passkey is another identity')
  let status = await h.identity.status()
  t.is(status.pending, true, 'the old pending survives a failed replacement')
  t.alike(status.refused, [{ userId: hex(failed.userId), code: 'INSTALL_FAILED', cleaned: false, created: true }], 'the new passkey is refused, the old one is not superseded')
  const stored = await kvValue('passkeyAttempts')
  t.is(stored.pending.credentialId, idOf(pendingA), 'the old pending is still stored')
  t.alike(stored.refused.map((e) => e.credentialId), [idOf(failed)], 'and the failed one is stored refused')
  t.alike(await h.identity.complete(), { publicKey: key, created: true }, "'concluir' still finishes the old pending")
  await h.identity.signOut()

  // ---- a replacement that binds: only then the old pending is superseded ----
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingB = fake.last()
  fake.createMode = 'results'
  t.alike(await h.identity.unlock({ register: true }), { publicKey: key, created: true })
  t.ok(excludedOf(lastCall('create')).includes(idOf(failed)), 'the INSTALL_FAILED passkey is excluded from creation')
  status = await h.identity.status()
  t.is(status.pending, false)
  t.alike(status.refused.find((e) => e.code === 'SUPERSEDED'), { userId: hex(pendingB.userId), code: 'SUPERSEDED', cleaned: false, created: true })
  const after = await kvValue('passkeyAttempts')
  t.is(after.pending, null)
  t.ok(after.refused.some((e) => e.credentialId === idOf(pendingB) && e.code === 'SUPERSEDED' && e.created === true), 'the superseded id is stored')
  await h.identity.signOut()

  // ---- a reset during the pending write: rejects, nothing resurrected ----
  fake.createMode = 'pending'
  let resetting = null
  onAttemptsWrite = () => { resetting = h.identity.reset() }
  const stale = await errorOf(h.identity.unlock({ register: true }))
  t.is(stale && stale.code, 'CANCELLED', 'a pending made stale by a reset never resolves { pending: true }')
  await resetting
  status = await h.identity.status()
  t.is(status.pending, false, 'the cleared pending is not resurrected')
  t.alike(status.refused, [])
  t.is(await kvValue('passkeyAttempts'), null)

  // ---- a lock during the pending write rejects too ----
  onAttemptsWrite = () => { h.identity.lock() }
  const locked = await errorOf(h.identity.unlock({ register: true }))
  t.is(locked && locked.code, 'CANCELLED', 'a lock during the write cancels the pending answer')
  await h.close()

  // ---- an entry stored before `created` existed reads as not created ----
  const legacyId = toBase64Url(new Uint8Array(16).fill(3))
  await idb('varanda-node', 'kv', 'readwrite', (s) => s.put(JSON.stringify({
    v: 1, rpId: 'localhost', pending: null, refused: [{ credentialId: legacyId, userId: 'ab', code: 'NO_PRF', cleaned: false }]
  }), 'passkeyAttempts'))
  const h2 = await api.start({ association, seederUrl })
  t.teardown(() => h2.close(), { force: true })
  t.alike((await h2.identity.status()).refused, [{ userId: 'ab', code: 'NO_PRF', cleaned: false, created: false }])
  await h2.close()
})

test('passkey attempts: device-bound creations never sign in, other sign-ins supersede the pending, a reset is final', async (t) => {
  t.timeout(60000)
  await deleteDb('varanda-node')
  await deleteDb('varanda-session')
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => socket.on('error', () => {}))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  const association = hex(generateAssociationKeyPair().publicKey)

  const fake = manyAuthenticator()
  const signals = []
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  // A throwing signal: refused entries keep cleaned false.
  PublicKeyCredential.signalUnknownCredential = async (arg) => {
    signals.push(arg)
    throw new Error('not allowed')
  }
  // A hook run inside navigator.credentials.get, before it answers.
  let onGet = null
  installGlobals(t, {
    navigator: {
      credentials: {
        create: (o) => fake.create(o),
        get: async (o) => {
          if (onGet !== null) {
            const hook = onGet
            onGet = null
            await hook()
          }
          return fake.get(o)
        }
      }
    },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })
  let failAttemptsWrite = false
  const put = globalThis.IDBObjectStore.prototype.put
  globalThis.IDBObjectStore.prototype.put = function (value, key) {
    if (key === 'passkeyAttempts' && failAttemptsWrite) throw new Error('disk full')
    return put.apply(this, arguments)
  }
  t.teardown(() => { globalThis.IDBObjectStore.prototype.put = put })
  delete require.cache[require.resolve('../web/node.js')]
  t.teardown(() => { delete globalThis.VarandaWebNode })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode
  const key = hex((await keyPairFromPrf(new Uint8Array(FIXED32))).publicKey)
  const h = await api.start({ association, seederUrl })
  t.teardown(() => h.close(), { force: true })
  const idOf = (cred) => toBase64Url(cred.rawId)
  const refusedOf = async (cred) => (await kvValue('passkeyAttempts')).refused.find((e) => e.credentialId === idOf(cred))

  // ---- a creation refused NOT_SYNCED here never signs in ----
  fake.synced = false
  const created = await errorOf(h.identity.unlock({ register: true }))
  const bound = fake.last()
  fake.synced = true
  t.is(created.code, 'NOT_SYNCED')
  t.alike(await refusedOf(bound), { credentialId: idOf(bound), userId: hex(bound.userId), code: 'NOT_SYNCED', cleaned: false, created: true })
  const signalsBefore = signals.length
  const blocked = await errorOf(h.identity.unlock({ any: true }))
  t.is(blocked && blocked.code, 'NOT_SYNCED', 'signing in with a device-bound passkey made here is refused')
  t.is(blocked.credentialId, idOf(bound))
  t.is(blocked.userId, hex(bound.userId))
  t.is(blocked.cleaned, false)
  t.is(signals.length, signalsBefore, 'no request to drop it')
  let status = await h.identity.status()
  t.is(status.unlocked, false, 'nothing is installed')
  t.is(status.passkeyKnown, false)
  t.absent(await kvValue('passkey'), 'no passkey record')
  t.alike(await refusedOf(bound), { credentialId: idOf(bound), userId: hex(bound.userId), code: 'NOT_SYNCED', cleaned: false, created: true }, 'the entry stays a creation of this page')

  // ---- a sign-in NO_PRF keeps an entry's created true ----
  fake.getPrf = false
  const boundNoPrf = await errorOf(h.identity.unlock({ any: true }))
  fake.getPrf = true
  t.is(boundNoPrf.code, 'NO_PRF')
  t.is((await refusedOf(bound)).created, true, 'a sign-in NO_PRF never turns created true into false')
  t.is((await refusedOf(bound)).code, 'NOT_SYNCED', 'a sign-in NO_PRF never downgrades a device-bound refusal')
  const boundAgain = await errorOf(h.identity.unlock({ any: true }))
  t.is(boundAgain && boundAgain.code, 'NOT_SYNCED', 'once the manager returns PRF, the device-bound passkey is still refused')
  status = await h.identity.status()
  t.is(status.unlocked, false, 'nothing is installed after the NO_PRF either')
  t.absent(await kvValue('passkey'), 'still no passkey record')

  // ---- a sign-in NO_PRF of the pending creation: created true ----
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingA = fake.last()
  fake.getPrf = false
  const pendingNoPrf = await errorOf(h.identity.unlock({ any: true }))
  fake.getPrf = true
  t.is(pendingNoPrf.code, 'NO_PRF')
  t.is(pendingNoPrf.credentialId, idOf(pendingA))
  t.is((await h.identity.status()).pending, false, 'the pending creation is cleared')
  t.alike(await refusedOf(pendingA), { credentialId: idOf(pendingA), userId: hex(pendingA.userId), code: 'NO_PRF', cleaned: false, created: true }, 'the pending creation was made here')

  // ---- signing in with another passkey supersedes the pending ----
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingB = fake.last()
  const elsewhere = fake.add(new Uint8Array(32).fill(5))
  const signalsNow = signals.length
  t.alike(await h.identity.unlock({ any: true }), { publicKey: key, created: false }, 'a passkey made elsewhere signs in')
  t.is(signals.length, signalsNow, 'no request to drop the superseded pending')
  status = await h.identity.status()
  t.is(status.pending, false)
  const storedAfter = await kvValue('passkeyAttempts')
  t.is(storedAfter.pending, null)
  t.alike(await refusedOf(pendingB), { credentialId: idOf(pendingB), userId: hex(pendingB.userId), code: 'SUPERSEDED', cleaned: false, created: true }, 'the pending creation is kept as superseded')
  t.is((await kvValue('passkey')).credentialId, idOf(elsewhere))

  // ---- signing in with the pending passkey itself just clears it ----
  await h.identity.signOut()
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingC = fake.last()
  t.alike(await h.identity.unlock({ any: true }), { publicKey: key, created: false })
  t.is((await h.identity.status()).pending, false)
  t.absent(await refusedOf(pendingC), 'the pending passkey is not refused')
  fake.createMode = 'results'

  // ---- a reset whose attempts write fails changes nothing ----
  const before = await h.identity.status()
  failAttemptsWrite = true
  const resetErr = await errorOf(h.identity.reset())
  failAttemptsWrite = false
  t.ok(resetErr, 'reset rejects when the attempts record cannot be cleared')
  status = await h.identity.status()
  t.is(status.unlocked, true, 'still unlocked')
  t.is(status.passkeyKnown, true)
  t.alike(status.refused, before.refused, 'the refused passkeys are kept')
  t.ok(await kvValue('passkey'), 'the passkey record is kept')

  // ---- a ceremony that fails after a reset records nothing ----
  await h.identity.signOut()
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  fake.createMode = 'results'
  fake.getPrf = false
  onGet = () => h.identity.reset()
  const stale = await errorOf(h.identity.complete())
  fake.getPrf = true
  t.is(stale && stale.code, 'NO_PRF')
  status = await h.identity.status()
  t.is(status.pending, false)
  const boundEntry = { credentialId: idOf(bound), userId: hex(bound.userId), code: 'NOT_SYNCED', cleaned: false, created: true }
  t.alike(status.refused, [{ userId: hex(bound.userId), code: 'NOT_SYNCED', cleaned: false, created: true }], 'only the device-bound creation survives the reset')
  t.alike(await kvValue('passkeyAttempts'), { v: 1, rpId: 'localhost', pending: null, refused: [boundEntry] }, 'and nothing else is written back')

  // ---- after the reset the device-bound passkey still never signs in ----
  fake.creds = [bound]
  const afterReset = await errorOf(h.identity.unlock({ any: true }))
  t.is(afterReset && afterReset.code, 'NOT_SYNCED', 'a reset never lets a device-bound creation sign in')
  t.is((await h.identity.status()).unlocked, false)
  await h.close()
})

test("passkey attempts: a NO_PRF at 'concluir' is refused but never signalled, even for a creation of this start", async (t) => {
  t.timeout(60000)
  await deleteDb('varanda-node')
  await deleteDb('varanda-session')
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => socket.on('error', () => {}))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  const association = hex(generateAssociationKeyPair().publicKey)

  const fake = manyAuthenticator()
  const signals = []
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  PublicKeyCredential.signalUnknownCredential = async (arg) => { signals.push(arg) }
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })
  delete require.cache[require.resolve('../web/node.js')]
  t.teardown(() => { delete globalThis.VarandaWebNode })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode
  const h = await api.start({ association, seederUrl })
  t.teardown(() => h.close(), { force: true })

  // Created in this very start, so the create ceremony could have signalled
  // it; by 'concluir' the synced passkey may be the account on another device.
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const created = fake.last()
  fake.createMode = 'results'
  fake.getPrf = false
  const err = await errorOf(h.identity.complete())
  fake.getPrf = true
  t.is(err && err.code, 'NO_PRF')
  t.is(err.userId, hex(created.userId))
  t.absent(err.cleaned, 'cleaned absent or false')
  t.alike(signals, [], 'complete() never calls signalUnknownCredential')
  const status = await h.identity.status()
  t.is(status.pending, false)
  t.alike(status.refused, [{ userId: hex(created.userId), code: 'NO_PRF', cleaned: false, created: true }], 'still refused as a creation of this page')
  await h.close()
})

test('passkey attempts: device-bound entries survive the cap, corrupt ids are dropped, refusals hold the lock, a re-created bound passkey is refused', async (t) => {
  t.timeout(60000)
  await deleteDb('varanda-node')
  await deleteDb('varanda-session')
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => socket.on('error', () => {}))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  const association = hex(generateAssociationKeyPair().publicKey)

  const fake = manyAuthenticator()
  const signals = []
  // A signal held open by the test: the refusal bookkeeping waits on it.
  let holdSignal = null
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  PublicKeyCredential.signalUnknownCredential = async (arg) => {
    signals.push(arg)
    if (holdSignal !== null) await holdSignal()
  }
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })
  delete require.cache[require.resolve('../web/node.js')]
  t.teardown(() => { delete globalThis.VarandaWebNode })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode
  const start = async () => {
    const handle = await api.start({ association, seederUrl })
    t.teardown(() => handle.close(), { force: true })
    return handle
  }
  const idOf = (cred) => toBase64Url(cred.rawId)
  const fakeId = (n) => toBase64Url(new Uint8Array(16).fill(n))
  const putAttempts = (value) => idb('varanda-node', 'kv', 'readwrite', (s) => s.put(JSON.stringify(value), 'passkeyAttempts'))
  const boundOf = (credentialId) => ({ credentialId, userId: 'ab', code: 'NOT_SYNCED', cleaned: false, created: true })
  const fillerOf = (n) => ({ credentialId: fakeId(n), userId: 'cd', code: 'NO_PRF', cleaned: false, created: false })

  // ---- corrupt stored ids are dropped: creation still works ----
  let h = await start()
  await h.close()
  await putAttempts({
    v: 1,
    rpId: 'localhost',
    pending: { credentialId: 'a+b', userId: 'ab', phone: false },
    refused: [boundOf('abcde'), boundOf('a/b='), fillerOf(1)]
  })
  h = await start()
  let status = await h.identity.status()
  t.is(status.pending, false, 'a corrupt pending id reads as no pending')
  t.alike(status.refused, [{ userId: 'cd', code: 'NO_PRF', cleaned: false, created: false }], 'corrupt refused ids are dropped')
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true }, 'a creation after a corrupt record reaches WebAuthn')
  fake.createMode = 'results'
  await h.close()

  // ---- the cap never evicts a device-bound creation ----
  const fillers = []
  for (let i = 0; i < 32; i++) fillers.push(fillerOf(i + 10))
  await putAttempts({ v: 1, rpId: 'localhost', pending: null, refused: [boundOf(fakeId(2)), ...fillers] })
  h = await start()
  status = await h.identity.status()
  t.is(status.refused.length, 32, 'the loader caps at 32')
  t.is(status.refused.filter((e) => e.code === 'NOT_SYNCED').length, 1, 'the loader keeps the oldest device-bound entry')
  fake.createMode = 'disabled'
  const noPrf = await errorOf(h.identity.unlock({ register: true }))
  fake.createMode = 'results'
  t.is(noPrf.code, 'NO_PRF')
  let stored = await kvValue('passkeyAttempts')
  t.is(stored.refused.length, 32, 'a new refusal keeps the cap')
  t.ok(stored.refused.some((e) => e.credentialId === fakeId(2) && e.code === 'NOT_SYNCED'), 'a new refusal never evicts the device-bound entry')
  t.ok(stored.refused.some((e) => e.credentialId === noPrf.credentialId), 'the new refusal is stored')
  t.absent(stored.refused.some((e) => e.credentialId === fakeId(10)), 'the oldest other entry is evicted')
  await h.close()

  // ---- device-bound entries alone over the cap: every one stays ----
  const many = []
  for (let i = 0; i < 34; i++) many.push(boundOf(fakeId(i + 60)))
  await putAttempts({ v: 1, rpId: 'localhost', pending: null, refused: [fillerOf(50), ...many] })
  h = await start()
  status = await h.identity.status()
  t.is(status.refused.length, 34, 'no device-bound entry is evicted')
  t.ok(status.refused.every((e) => e.code === 'NOT_SYNCED'), 'only device-bound entries stay')
  await h.close()
  await putAttempts(null)

  // ---- the refusal bookkeeping holds the ceremony lock ----
  h = await start()
  const releases = []
  let reached = null
  const signalReached = new Promise((resolve) => { reached = resolve })
  holdSignal = () => {
    reached()
    return new Promise((resolve) => { releases.push(resolve) })
  }
  fake.createMode = 'disabled'
  const first = errorOf(h.identity.unlock({ register: true }))
  await signalReached
  const secondP = errorOf(h.identity.unlock({ register: true }))
  const second = await Promise.race([secondP, new Promise((resolve) => setTimeout(() => resolve('still running'), 2000))])
  t.is(second && second.code, 'LOCKED', 'a ceremony is LOCKED while the previous refusal is still being recorded')
  holdSignal = null
  for (const release of releases) release()
  await secondP
  const firstErr = await first
  t.is(firstErr.code, 'NO_PRF')
  t.is(firstErr.cleaned, true)
  fake.createMode = 'results'

  // ---- a creation handing back a device-bound passkey is refused ----
  fake.synced = false
  const boundErr = await errorOf(h.identity.unlock({ register: true }))
  const bound = fake.last()
  fake.synced = true
  t.is(boundErr.code, 'NOT_SYNCED')
  t.is(boundErr.cleaned, true)
  const signalsBefore = signals.length
  const create = fake.create
  let prfGiven = null
  fake.create = ({ publicKey }) => {
    fake.calls.push({ kind: 'create', publicKey })
    prfGiven = new Uint8Array(FIXED32)
    return Promise.resolve(fake.credentialOf(bound, { prf: { enabled: true, results: { first: prfGiven.buffer } } }, true))
  }
  const again = await errorOf(h.identity.unlock({ register: true }))
  fake.create = create
  t.is(again && again.code, 'NOT_SYNCED', 'a re-created device-bound passkey is refused')
  t.is(again.credentialId, idOf(bound))
  t.is(again.userId, hex(bound.userId))
  t.is(again.cleaned, false)
  t.is(signals.length, signalsBefore, 'no request to drop it')
  status = await h.identity.status()
  t.is(status.unlocked, false, 'nothing is installed')
  t.is(status.passkeyKnown, false)
  t.absent(await kvValue('passkey'), 'no passkey record')
  stored = await kvValue('passkeyAttempts')
  t.alike(stored.refused.find((e) => e.credentialId === idOf(bound)), { credentialId: idOf(bound), userId: hex(bound.userId), code: 'NOT_SYNCED', cleaned: true, created: true }, 'the entry stays as it was')
  await h.close()
})

test('passkey attempts: an excluded id handed back by a creation is never signalled', async (t) => {
  t.timeout(60000)
  await deleteDb('varanda-node')
  await deleteDb('varanda-session')
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => socket.on('error', () => {}))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const seederUrl = 'ws://127.0.0.1:' + wss.address().port + '/seeder'
  const association = hex(generateAssociationKeyPair().publicKey)

  const fake = manyAuthenticator()
  const signals = []
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
  PublicKeyCredential.signalUnknownCredential = async (arg) => { signals.push(arg) }
  installGlobals(t, {
    navigator: { credentials: { create: (o) => fake.create(o), get: (o) => fake.get(o) } },
    PublicKeyCredential,
    isSecureContext: true,
    location: { hostname: 'localhost', host: 'localhost' },
    WebSocket: ws.WebSocket
  })
  delete require.cache[require.resolve('../web/node.js')]
  t.teardown(() => { delete globalThis.VarandaWebNode })
  require('../web/node.js')
  const api = globalThis.VarandaWebNode
  const start = async () => {
    const handle = await api.start({ association, seederUrl })
    t.teardown(() => handle.close(), { force: true })
    return handle
  }
  const idOf = (cred) => toBase64Url(cred.rawId)
  const excludedOf = (call) => call.publicKey.excludeCredentials.map((c) => toBase64Url(new Uint8Array(c.id)))
  const lastCall = (kind) => fake.calls.filter((c) => c.kind === kind).pop()
  // An authenticator that ignores excludeCredentials and hands back `cred`.
  const handBack = (cred, ext, synced) => {
    const create = fake.create
    fake.create = ({ publicKey }) => {
      fake.calls.push({ kind: 'create', publicKey })
      fake.create = create
      return Promise.resolve(fake.credentialOf(cred, ext, synced))
    }
  }

  // ---- (a) the pending creation, handed back NO_PRF by a later Criar ----
  let h = await start()
  fake.createMode = 'pending'
  t.alike(await h.identity.unlock({ register: true }), { pending: true })
  const pendingP = fake.last()
  await h.close()
  // A new page load: P is pending from kv, not created by this page load.
  h = await start()
  t.is((await h.identity.status()).pending, true)
  handBack(pendingP, { prf: { enabled: false } }, true)
  const noPrf = await errorOf(h.identity.unlock({ register: true }))
  t.ok(excludedOf(lastCall('create')).includes(idOf(pendingP)), 'the pending id was on the exclude list')
  t.is(noPrf.code, 'NO_PRF')
  t.is(noPrf.credentialId, idOf(pendingP))
  t.absent(noPrf.cleaned, 'cleaned absent or false for an excluded id')
  t.alike(signals.filter((s) => s.credentialId === idOf(pendingP)), [], 'no signalUnknownCredential for the pending passkey')
  await h.close()

  // ---- (b) a sign-in passkey refused NO_PRF, handed back NOT_SYNCED ----
  h = await start()
  const signInS = fake.add(new Uint8Array(32).fill(5))
  fake.getPrf = false
  const refusedS = await errorOf(h.identity.unlock({ any: true }))
  fake.getPrf = true
  t.is(refusedS.code, 'NO_PRF')
  t.is(refusedS.credentialId, idOf(signInS))
  t.is((await kvValue('passkeyAttempts')).refused.find((e) => e.credentialId === idOf(signInS)).created, false, 'refused at sign-in, not a creation')
  handBack(signInS, { prf: { enabled: true, results: { first: arrayBufferOf(FIXED32) } } }, false)
  const notSynced = await errorOf(h.identity.unlock({ register: true }))
  t.ok(excludedOf(lastCall('create')).includes(idOf(signInS)), 'the refused sign-in id was on the exclude list')
  t.is(notSynced.code, 'NOT_SYNCED')
  t.is(notSynced.credentialId, idOf(signInS))
  t.absent(notSynced.cleaned, 'cleaned absent or false for an excluded id')
  t.alike(signals.filter((s) => s.credentialId === idOf(signInS)), [], 'no signalUnknownCredential for the sign-in passkey')
  t.alike(signals, [], 'no signal at all')
  await h.close()
})
