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
// delegates to the node's mediaUpload.
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
  t.alike(Object.keys(h.identity).sort(), ['complete', 'lock', 'reset', 'signOut', 'status', 'unlock'])
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
