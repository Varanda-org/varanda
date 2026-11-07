// web/node.js, member recovery: the page entry run from source over
// fake-indexeddb, node:crypto's WebCrypto and a fake authenticator holding
// many passkeys, each with its own PRF output (the shape of
// test/resume.test.js). A seeder entry that accepts sockets and says
// nothing: no test here syncs. Proves: a recovery (marked) passkey and its
// blob install the original public key on fresh storage; a marked passkey
// never installs its own PRF output (cancelRecovery leaves no diary, a bad
// blob leaves the node locked, a foreign stored diary is a MISMATCH that
// writes nothing); a plain passkey still installs directly; addPasskey and
// makeRecoveryCode wrap the root without changing the installed key;
// bindPasskey moves this device to the new passkey and the session resumes;
// a code recovery ends with finishRecovery and resumes after a reload; late
// results after signOut are dropped; cancelRecovery stops a recovery in
// flight; a failed install zeroes the held wrap key and root; the held root
// waits for 'concluir'; a sign-in drops an armed recovery; a pending add
// survives a failed 'concluir' and a dropped one stays refused;
// finishRecovery binds nothing before the blob exists and refuses a passkey
// whose install failed; a cancelRecovery right after the call arms nothing;
// a second 'concluir' pauses the held root again; a pending add is refused
// ADD_PENDING, so a reload keeps it excluded and offers no 'concluir'; an
// abandoned recovery passkey with no user handle still asks for its blob; a
// cancel or lock while finishRecovery derives refuses the new passkey; a
// wrapping passkey that hit MISMATCH is never chosen after 'recomeçar'; a
// lock after finishRecovery bound undoes the bind and the saved session.
/* global indexedDB */
require('fake-indexeddb/auto')
const test = require('brittle')
const ws = require('ws')
const b4a = require('b4a')
const { connectClient, errorOf } = require('./helpers/session')
const passkeyLib = require('../lib/passkey')
const { keyPairFromPrf, toBase64Url } = passkeyLib
const recovery = require('../lib/recovery')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function arrayBufferOf (bytes) {
  return new Uint8Array(bytes).buffer
}

function random32 () {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

// 37 bytes of authenticator data: rpIdHash, flags (UP, UV, BE, BS by
// default), signCount.
function authData (flags = 0x1d) {
  const bytes = new Uint8Array(37)
  bytes[32] = flags
  return arrayBufferOf(bytes)
}

// Many synced passkeys, each with its own PRF output. A get with
// allowCredentials answers only for one of those ids; a discoverable get
// answers with `next` (else the newest). `pendingCreate`: creations report
// PRF enabled without its output (a second click completes them). `omitHandle` drops the user handle
// from get answers; `hold` makes the next get wait for release(); `flags`
// is the flags byte of the get answers' authenticator data.
function authenticator () {
  const fake = {
    creds: [],
    calls: [],
    next: null,
    omitHandle: false,
    hold: null,
    flags: 0x1d,
    pendingCreate: false,
    create ({ publicKey }) {
      fake.calls.push({ kind: 'create', publicKey })
      const cred = fake.add(new Uint8Array(publicKey.user.id))
      const ext = fake.pendingCreate ? { prf: { enabled: true } } : { prf: { enabled: true, results: { first: arrayBufferOf(cred.prf) } } }
      return Promise.resolve(fake.credentialOf(cred, ext))
    },
    get ({ publicKey }) {
      fake.calls.push({ kind: 'get', publicKey })
      const allow = (publicKey.allowCredentials || []).map((c) => toBase64Url(new Uint8Array(c.id)))
      let cred
      if (allow.length > 0) cred = fake.creds.filter((c) => allow.includes(toBase64Url(c.rawId))).pop()
      else cred = fake.next || fake.creds[fake.creds.length - 1]
      if (!cred) return Promise.reject(Object.assign(new Error('none'), { name: 'NotAllowedError' }))
      const answer = fake.credentialOf(cred, { prf: { results: { first: arrayBufferOf(cred.prf) } } })
      if (fake.hold !== null) {
        const gate = fake.hold
        fake.hold = null
        return gate.then(() => answer)
      }
      return Promise.resolve(answer)
    },
    add (userId) {
      const cred = { rawId: globalThis.crypto.getRandomValues(new Uint8Array(16)), userId, prf: random32() }
      fake.creds.push(cred)
      return cred
    },
    find (credentialId) {
      return fake.creds.find((c) => toBase64Url(c.rawId) === credentialId)
    },
    credentialOf (cred, ext) {
      const userHandle = fake.omitHandle ? null : arrayBufferOf(cred.userId)
      return {
        type: 'public-key',
        rawId: arrayBufferOf(cred.rawId),
        id: toBase64Url(cred.rawId),
        response: {
          userHandle,
          authenticatorData: authData(fake.flags),
          getAuthenticatorData: () => authData(),
          // Opaque here: the account service, not this node, checks them.
          clientDataJSON: arrayBufferOf(new TextEncoder().encode('{}')),
          signature: arrayBufferOf(new Uint8Array([1, 2, 3])),
          attestationObject: arrayBufferOf(new Uint8Array([0xa0, ...cred.rawId]))
        },
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

function deleteDb (name) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

async function kvValue (key) {
  const dbs = await indexedDB.databases()
  if (!dbs.some((d) => d.name === 'varanda-node')) return undefined
  const raw = await new Promise((resolve, reject) => {
    const req = indexedDB.open('varanda-node')
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('kv')) {
        db.close()
        resolve(undefined)
        return
      }
      const tx = db.transaction(['kv'], 'readonly')
      const r = tx.objectStore('kv').get(key)
      tx.oncomplete = () => {
        db.close()
        resolve(r.result)
      }
      tx.onerror = () => reject(tx.error)
    }
  })
  return raw === undefined ? undefined : JSON.parse(raw)
}

async function keyOf (prf) {
  return hex((await keyPairFromPrf(new Uint8Array(prf))).publicKey)
}

// The root a blob opens to under a passkey's PRF output or a code secret.
async function openWith (blob, secret, kind, member) {
  const { lookupId, wrapKey } = await recovery.deriveRecoveryKeys(new Uint8Array(secret), kind)
  const opened = recovery.openRoot(blob, wrapKey, { member })
  wrapKey.fill(0)
  return { lookupId, root: opened === null ? null : opened.root }
}

async function setup (t) {
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
  const fake = authenticator()
  function PublicKeyCredential () {}
  PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true })
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
  // Fresh browser storage (another device), the passkeys stay.
  const wipe = async (h) => {
    await h.close()
    await deleteDb('varanda-node')
    await deleteDb('varanda-session')
  }
  return { fake, start, wipe }
}

// The diary on this storage (identity.create): -> its public key. A resume
// needs a stored diary, as after a real first start.
async function createDiary (h) {
  const web = await connectClient(h, { timeoutMs: 60000 })
  return (await web.request('identity.create')).publicKey
}

const allowOf = (call) => (call.publicKey.allowCredentials || []).map((c) => toBase64Url(new Uint8Array(c.id)))

test('recovery passkey: add, wrap, sign in on fresh storage, bind and resume', async (t) => {
  t.timeout(60000)
  const { fake, start, wipe } = await setup(t)
  let h = await start()

  // ---- the original identity, then a recovery passkey and a code ----
  const created = await h.identity.unlock({ register: true })
  const first = fake.creds[0]
  const key = await keyOf(first.prf)
  t.alike(created, { publicKey: key, created: true })
  t.absent(recovery.isWrapUserId(first.userId), 'a new identity has a plain user id')
  t.is(await createDiary(h), key)

  const added = await h.identity.addPasskey()
  const second = fake.find(added.credentialId)
  t.ok(second, 'a second passkey was created')
  t.ok(recovery.isWrapUserId(second.userId), 'with a marked user id')
  t.is(added.userId, hex(second.userId))
  t.ok(excludedHas(fake.calls.filter((c) => c.kind === 'create').pop(), toBase64Url(first.rawId)), 'the bound passkey is excluded')
  const opened = await openWith(added.blob, second.prf, 'passkey', key)
  t.is(added.lookupId, opened.lookupId)
  t.alike(opened.root, first.prf, 'the blob opens to the root under the new passkey')
  let status = await h.identity.status()
  t.is(status.publicKey, key, 'the installed key is unchanged')
  t.is(status.unlocked, true)
  t.is((await kvValue('passkey')).credentialId, toBase64Url(first.rawId), 'this device stays on the original passkey')

  const made = await h.identity.makeRecoveryCode()
  t.ok(/^([0-9a-z]{4}-){8}[0-9a-z]{4}$/.test(made.code))
  const secret = recovery.decodeCode(made.code)
  const viaCode = await openWith(made.blob, secret, 'code', key)
  t.is(made.lookupId, viaCode.lookupId)
  t.alike(viaCode.root, first.prf, 'the code blob opens to the root')

  // ---- another device (fresh storage) signs in with the recovery passkey ----
  await wipe(h)
  h = await start()
  fake.next = second
  const wrapped = await h.identity.unlock({ any: true })
  t.alike(wrapped, { wrapped: true, lookupId: added.lookupId }, 'a marked passkey asks for its blob')
  t.is((await h.identity.status()).unlocked, false, 'nothing installed yet')
  t.is((await kvValue('passkey')), undefined, 'nothing written yet')

  const bad = await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: await keyOf(random32()) }))
  t.is(bad.code, 'RECOVERY_BAD', 'a blob for another member is refused')
  status = await h.identity.status()
  t.is(status.unlocked, false, 'and the node stays locked')
  t.is(status.exists, false, 'no diary')
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'RECOVERY_BAD', 'the held key is spent')

  t.alike(await h.identity.unlock({ any: true }), { wrapped: true, lookupId: added.lookupId })
  t.alike(await h.identity.unlockWrapped({ blob: added.blob, member: key }), { publicKey: key, created: false }, 'the original public key')
  status = await h.identity.status()
  t.is(status.unlocked, true)
  t.is(await createDiary(h), key, 'the diary of the original key')
  const record = await kvValue('passkey')
  t.is(record.credentialId, added.credentialId, 'bound to the recovery passkey')
  t.is(record.userId, added.userId)
  await h.close()

  // The reload resumes with the root, no ceremony.
  fake.calls.length = 0
  h = await start()
  status = await h.identity.status()
  t.is(fake.calls.length, 0)
  t.is(status.resumed, true)
  t.is(status.publicKey, key)

  // A sign-in with the bound recovery passkey goes through its blob again.
  await h.identity.lock()
  fake.next = null
  t.alike(await h.identity.unlock(), { wrapped: true, lookupId: added.lookupId })
  t.alike(allowOf(fake.calls.pop()), [added.credentialId], 'only the bound passkey is asked for')
  t.alike(await h.identity.unlockWrapped({ blob: added.blob, member: key }), { publicKey: key, created: false })

  // ---- 'Trocar': add a third passkey and bind this device to it ----
  const third = await h.identity.addPasskey()
  t.alike(await h.identity.bindPasskey({ credentialId: third.credentialId, userId: third.userId }), {})
  t.is((await kvValue('passkey')).credentialId, third.credentialId)
  t.is((await h.identity.status()).publicKey, key)
  await h.close()
  h = await start()
  status = await h.identity.status()
  t.is(status.resumed, true, 'the re-sealed session resumes after a reload')
  t.is(status.publicKey, key)
  await h.identity.lock()
  t.alike(await h.identity.unlock(), { wrapped: true, lookupId: third.lookupId })
  t.alike(allowOf(fake.calls.pop()), [third.credentialId], 'the next unlock allows only the new passkey')
  t.alike(await h.identity.unlockWrapped({ blob: third.blob, member: key }), { publicKey: key, created: false })
  t.is((await errorOf(h.identity.bindPasskey({ credentialId: first.credentialId, userId: hex(first.userId) }))).code, 'USAGE', 'only a recovery passkey can be bound')
})

function excludedHas (call, id) {
  return call.publicKey.excludeCredentials.some((c) => toBase64Url(new Uint8Array(c.id)) === id)
}

test('recovery passkey: never a second diary, plain passkeys sign in as before', async (t) => {
  t.timeout(60000)
  const { fake, start, wipe } = await setup(t)
  let h = await start()
  t.alike(await h.identity.unlock({ register: true }), { publicKey: await keyOf(fake.creds[0].prf), created: true })
  const first = fake.creds[0]
  const key = await keyOf(first.prf)
  t.is(await createDiary(h), key)
  const added = await h.identity.addPasskey()
  const second = fake.find(added.credentialId)

  // ---- an add whose PRF comes only at 'concluir' ----
  fake.pendingCreate = true
  t.alike(await h.identity.addPasskey(), { pending: true })
  fake.pendingCreate = false
  t.is((await h.identity.status()).pending, true)
  const lateCred = fake.creds[fake.creds.length - 1]
  const concluded = await h.identity.complete()
  t.is(concluded.credentialId, toBase64Url(lateCred.rawId), 'complete() ends the add')
  t.alike((await openWith(concluded.blob, lateCred.prf, 'passkey', key)).root, first.prf)
  let status = await h.identity.status()
  t.is(status.pending, false)
  t.is(status.publicKey, key, 'the installed key is unchanged')

  // ---- an existing member with no blobs signs in exactly as before ----
  await h.identity.lock()
  t.alike(await h.identity.unlock(), { publicKey: key, created: false }, 'a plain passkey installs directly')
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'RECOVERY_BAD', 'no blob is awaited')
  await h.identity.lock()
  fake.omitHandle = true
  t.alike(await h.identity.unlock(), { publicKey: key, created: false }, 'the bound plain passkey without a handle installs directly')
  fake.omitHandle = false

  // ---- fresh storage: a marked passkey + cancelRecovery creates no diary ----
  await wipe(h)
  h = await start()
  fake.next = second
  t.alike(await h.identity.unlock({ any: true }), { wrapped: true, lookupId: added.lookupId })
  await h.identity.cancelRecovery()
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'RECOVERY_BAD')
  t.absent(h.identity.unlockDirect, 'no direct install of a held PRF output')
  status = await h.identity.status()
  t.is(status.exists, false, 'no diary')
  t.is(status.unlocked, false)
  t.is(await kvValue('passkey'), undefined)

  // ---- an unbound plain passkey without a handle installs directly ----
  // No lookup id is derived from its PRF output (the member root) and
  // nothing is fetched: the account service never decides it is a diary.
  const derive = recovery.deriveRecoveryKeys
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let derived = 0
  let fetched = 0
  recovery.deriveRecoveryKeys = (...args) => { derived++; return derive(...args) }
  Object.defineProperty(globalThis, 'fetch', { value: () => { fetched++; return Promise.reject(new Error('no network')) }, configurable: true, writable: true })
  try {
    fake.next = first
    fake.omitHandle = true
    const direct = await h.identity.unlock({ any: true })
    fake.omitHandle = false
    t.alike(direct, { publicKey: key, created: false }, 'installs as before recovery')
  } finally {
    fake.omitHandle = false
    recovery.deriveRecoveryKeys = derive
    if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch)
    else delete globalThis.fetch
  }
  t.is(derived, 0, 'no lookup id derived from its PRF output')
  t.is(fetched, 0, 'nothing fetched')
  t.is((await h.identity.status()).unlocked, true)

  // ---- a foreign stored diary: MISMATCH, nothing written ----
  await wipe(h)
  h = await start()
  const other = await h.identity.unlock({ register: true })
  const otherCred = fake.creds[fake.creds.length - 1]
  t.not(other.publicKey, key)
  t.is(await createDiary(h), other.publicKey)
  await h.identity.lock()
  fake.next = second
  t.alike(await h.identity.unlock({ any: true }), { wrapped: true, lookupId: added.lookupId })
  const mismatch = await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))
  t.is(mismatch.code, 'MISMATCH')
  status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(status.publicKey, other.publicKey, 'the stored diary is untouched')
  t.is((await kvValue('passkey')).credentialId, toBase64Url(otherCred.rawId), 'the record is untouched')

  // ---- late results after signOut are dropped ----
  let release
  fake.hold = new Promise((resolve) => { release = resolve })
  fake.next = second
  const late = h.identity.unlock({ any: true })
  await h.identity.signOut()
  release()
  t.is((await errorOf(late)).code, 'CANCELLED', 'the late sign-in is dropped')
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'RECOVERY_BAD', 'and holds nothing')
  t.is((await h.identity.status()).unlocked, false)
  t.is((await errorOf(h.identity.addPasskey())).code, 'USAGE', 'adding needs an unlocked identity')
  t.is((await errorOf(h.identity.makeRecoveryCode())).code, 'USAGE')
})

test('recovery code: unlockWithCode, finishRecovery, resume after reload', async (t) => {
  t.timeout(60000)
  const { fake, start, wipe } = await setup(t)
  let h = await start()
  await h.identity.unlock({ register: true })
  const first = fake.creds[0]
  const key = await keyOf(first.prf)
  const made = await h.identity.makeRecoveryCode()

  await wipe(h)
  h = await start()
  t.is((await errorOf(h.identity.unlockWithCode({ code: 'abcd-efgh' }))).code, 'USAGE', 'a malformed code')
  t.is((await errorOf(h.identity.finishRecovery())).code, 'RECOVERY_BAD', 'nothing to finish yet')
  t.alike(await h.identity.unlockWithCode({ code: made.code.toUpperCase() }), { wrapped: true, lookupId: made.lookupId })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  let status = await h.identity.status()
  t.is(status.unlocked, false, 'the root is held, not installed')
  t.is(await kvValue('passkey'), undefined)

  const finished = await h.identity.finishRecovery()
  const created = fake.find(finished.credentialId)
  t.ok(created && recovery.isWrapUserId(created.userId), 'a recovery passkey was created')
  t.is(finished.userId, hex(created.userId))
  const opened = await openWith(finished.blob, created.prf, 'passkey', key)
  t.is(finished.lookupId, opened.lookupId)
  t.alike(opened.root, first.prf, 'its blob opens to the root')
  status = await h.identity.status()
  t.is(status.unlocked, true)
  t.is(await createDiary(h), key, 'the original identity')
  t.is((await kvValue('passkey')).credentialId, finished.credentialId, 'bound to the new passkey')
  t.is((await errorOf(h.identity.finishRecovery())).code, 'RECOVERY_BAD', 'the held root is spent')
  await h.close()

  fake.calls.length = 0
  h = await start()
  status = await h.identity.status()
  t.is(fake.calls.length, 0)
  t.is(status.resumed, true, 'resumes after a reload')
  t.is(status.publicKey, key)
  await h.identity.lock()
  t.alike(await h.identity.unlock(), { wrapped: true, lookupId: finished.lookupId })
  t.alike(await h.identity.unlockWrapped({ blob: finished.blob, member: key }), { publicKey: key, created: false })
})

// The 120 s recovery timers, fired by hand: expire() is those 120 s passing.
// Every other timer runs as usual.
function recoveryClock (t) {
  const live = new Set()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  installGlobals(t, {
    setTimeout: (fn, ms, ...rest) => {
      if (ms !== 120000) return realSet(fn, ms, ...rest)
      const timer = { fn, unref () { return timer } }
      live.add(timer)
      return timer
    },
    clearTimeout: (timer) => {
      if (live.delete(timer)) return
      if (timer && typeof timer === 'object' && typeof timer.fn === 'function') return
      return realClear(timer)
    }
  })
  return {
    expire () {
      const all = [...live]
      live.clear()
      for (const timer of all) timer.fn()
    },
    get live () { return live.size }
  }
}

// The identity, a recovery passkey and a code, then fresh storage.
async function recoverable (t) {
  const ctx = await setup(t)
  let h = await ctx.start()
  await h.identity.unlock({ register: true })
  const first = ctx.fake.creds[0]
  const key = await keyOf(first.prf)
  const added = await h.identity.addPasskey()
  const second = ctx.fake.find(added.credentialId)
  const made = await h.identity.makeRecoveryCode()
  await ctx.wipe(h)
  h = await ctx.start()
  return { ...ctx, h, first, second, key, added, made }
}

test('recovery: cancelRecovery stops a recovery already in flight', async (t) => {
  t.timeout(60000)
  const { fake, start, h: h0, second, key, added, made } = await recoverable(t)
  let h = h0

  // ---- a valid passkey blob, cancelled at once: nothing installs ----
  fake.next = second
  t.alike(await h.identity.unlock({ any: true }), { wrapped: true, lookupId: added.lookupId })
  const inFlight = h.identity.unlockWrapped({ blob: added.blob, member: key })
  await h.identity.cancelRecovery()
  t.is((await errorOf(inFlight)).code, 'CANCELLED', 'the in-flight recovery is dropped')
  let status = await h.identity.status()
  t.is(status.unlocked, false, 'the node stays locked')
  t.is(status.exists, false, 'no diary')
  t.is(await kvValue('passkey'), undefined, 'no passkey record')
  await h.close()
  h = await start()
  t.is((await h.identity.status()).resumed, false, 'no session was saved')

  // ---- a code blob in flight: no root is held after the cancel ----
  await h.identity.unlockWithCode({ code: made.code })
  const codeFlight = h.identity.unlockWrapped({ blob: made.blob, member: key })
  await h.identity.cancelRecovery()
  t.is((await errorOf(codeFlight)).code, 'CANCELLED')
  t.is((await errorOf(h.identity.finishRecovery())).code, 'RECOVERY_BAD', 'nothing held')

  // ---- finishRecovery cancelled during its ceremony ----
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  const finishing = h.identity.finishRecovery()
  await h.identity.cancelRecovery()
  t.is((await errorOf(finishing)).code, 'CANCELLED')
  const orphan = fake.creds[fake.creds.length - 1]
  status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(await kvValue('passkey'), undefined)
  t.ok(status.refused.some((e) => e.userId === hex(orphan.userId) && e.code === 'SUPERSEDED' && e.created), 'the orphaned passkey stays excluded')
})

test('recovery: a failed install zeroes the held wrap key and root', async (t) => {
  t.timeout(60000)
  const { fake, h, second, key, added, made } = await recoverable(t)
  const roots = []
  const wrapKeys = []
  const openRoot = recovery.openRoot
  const derive = recovery.deriveRecoveryKeys
  const keyPair = passkeyLib.keyPairFromPrf
  let calls = 0
  let failAt = 0
  recovery.openRoot = (...args) => {
    const out = openRoot(...args)
    if (out !== null) roots.push(out.root)
    return out
  }
  recovery.deriveRecoveryKeys = async (...args) => {
    const out = await derive(...args)
    wrapKeys.push(out.wrapKey)
    return out
  }
  passkeyLib.keyPairFromPrf = (prf) => {
    calls++
    if (calls === failAt) return Promise.reject(new Error('falha de teste'))
    return keyPair(prf)
  }
  t.teardown(() => {
    recovery.openRoot = openRoot
    recovery.deriveRecoveryKeys = derive
    passkeyLib.keyPairFromPrf = keyPair
  })
  const zeroed = (bytes) => bytes.every((b) => b === 0)

  // ---- a passkey recovery whose install fails ----
  fake.next = second
  await h.identity.unlock({ any: true })
  calls = 0
  failAt = 2 // the check in unlockWrapped passes, the install fails
  t.ok(await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key })))
  t.ok(zeroed(wrapKeys[wrapKeys.length - 1]), 'the wrap key is zeroed')
  t.ok(zeroed(roots[roots.length - 1]), 'the opened root is zeroed')
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'RECOVERY_BAD', 'nothing awaited')
  t.is((await h.identity.status()).unlocked, false)
  t.is(await kvValue('passkey'), undefined)

  // ---- a code recovery whose finishRecovery install fails ----
  failAt = 0
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  t.ok(zeroed(wrapKeys[wrapKeys.length - 1]), 'the code wrap key is zeroed')
  const heldRoot = roots[roots.length - 1]
  t.absent(zeroed(heldRoot), 'the root is held')
  calls = 0
  failAt = 1
  t.ok(await errorOf(h.identity.finishRecovery()))
  t.ok(zeroed(heldRoot), 'the held root is zeroed')
  t.is((await errorOf(h.identity.finishRecovery())).code, 'RECOVERY_BAD', 'the held root is dropped')
  t.is((await h.identity.status()).unlocked, false)
  t.is(await kvValue('passkey'), undefined)
})

test('recovery: the held root waits for concluir, a sign-in drops an armed recovery', async (t) => {
  t.timeout(60000)
  const clock = recoveryClock(t)
  const { fake, h, first, key, made } = await recoverable(t)

  // ---- a pending creation keeps the held root past 120 s ----
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  fake.pendingCreate = true
  t.alike(await h.identity.finishRecovery(), { pending: true })
  fake.pendingCreate = false
  t.is(clock.live, 0, 'the hold is paused while concluir is owed')
  clock.expire()
  const done = await h.identity.complete()
  t.is((await h.identity.status()).unlocked, true, 'concluir still finds the root')
  t.is((await kvValue('passkey')).credentialId, done.credentialId)

  // ---- a failed finishRecovery gives the root a fresh 120 s ----
  await h.identity.lock()
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  const create = globalThis.navigator.credentials.create
  globalThis.navigator.credentials.create = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
  t.is((await errorOf(h.identity.finishRecovery())).code, 'CANCELLED')
  globalThis.navigator.credentials.create = create
  t.is(clock.live, 1, 'the hold runs again')

  // ---- a plain sign-in drops the held root and the awaited key ----
  fake.next = first
  t.alike(await h.identity.unlock({ any: true }), { publicKey: key, created: false })
  t.is((await errorOf(h.identity.finishRecovery())).code, 'RECOVERY_BAD', 'the held root is gone')
  await h.identity.lock()
  t.alike(await h.identity.unlockWithCode({ code: made.code }), { wrapped: true, lookupId: made.lookupId })
  t.alike(await h.identity.unlock({ any: true }), { publicKey: key, created: false })
  t.is((await errorOf(h.identity.unlockWrapped({ blob: made.blob, member: key }))).code, 'RECOVERY_BAD', 'the awaited key is gone')
})

test('recovery: a pending add survives a failed concluir, a dropped one stays refused', async (t) => {
  t.timeout(60000)
  const { fake, start } = await setup(t)
  let h = await start()
  await h.identity.unlock({ register: true })
  const key = await keyOf(fake.creds[0].prf)

  // ---- concluir fails after the ceremony: the add can be concluded again ----
  fake.pendingCreate = true
  t.alike(await h.identity.addPasskey(), { pending: true })
  fake.pendingCreate = false
  const late = fake.creds[fake.creds.length - 1]
  const derive = recovery.deriveRecoveryKeys
  recovery.deriveRecoveryKeys = () => {
    recovery.deriveRecoveryKeys = derive
    return Promise.reject(new Error('falha de teste'))
  }
  t.teardown(() => { recovery.deriveRecoveryKeys = derive })
  t.ok(await errorOf(h.identity.complete()))
  t.is((await h.identity.status()).pending, true, 'still pending')
  const concluded = await h.identity.complete()
  t.is(concluded.credentialId, toBase64Url(late.rawId))
  t.alike((await openWith(concluded.blob, late.prf, 'passkey', key)).root, fake.creds[0].prf)

  // ---- a pending add replaced by another, then dropped by lock ----
  fake.pendingCreate = true
  t.alike(await h.identity.addPasskey(), { pending: true })
  const replaced = fake.creds[fake.creds.length - 1]
  t.alike(await h.identity.addPasskey(), { pending: true })
  const dropped = fake.creds[fake.creds.length - 1]
  fake.pendingCreate = false
  const superseded = (refused, cred) => refused.some((e) => e.userId === hex(cred.userId) && e.code === 'SUPERSEDED' && e.created && !e.cleaned)
  t.ok(superseded((await h.identity.status()).refused, replaced), 'the replaced add is refused')
  await h.identity.lock()
  const status = await h.identity.status()
  t.is(status.pending, false)
  t.ok(superseded(status.refused, dropped), 'the dropped add is refused')
  await h.close()
  const attempts = await kvValue('passkeyAttempts')
  const ids = attempts.refused.map((e) => e.credentialId)
  t.ok(ids.includes(toBase64Url(replaced.rawId)) && ids.includes(toBase64Url(dropped.rawId)), 'kept across reloads')
  h = await start()
  await h.identity.unlock()
  await h.identity.addPasskey()
  const call = fake.calls.filter((c) => c.kind === 'create').pop()
  t.ok(excludedHas(call, toBase64Url(replaced.rawId)) && excludedHas(call, toBase64Url(dropped.rawId)), 'and excluded from later creations')
})

test('recovery: finishRecovery builds the blob before it binds, a failed install refuses the passkey', async (t) => {
  t.timeout(60000)
  const { fake, start, h: h0, key, made } = await recoverable(t)
  let h = h0
  const derive = recovery.deriveRecoveryKeys
  const keyPair = passkeyLib.keyPairFromPrf
  t.teardown(() => {
    recovery.deriveRecoveryKeys = derive
    passkeyLib.keyPairFromPrf = keyPair
  })

  // ---- deriving the new passkey's keys fails: nothing bound, nothing saved ----
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  recovery.deriveRecoveryKeys = (secret, kind) => {
    if (kind !== 'passkey') return derive(secret, kind)
    recovery.deriveRecoveryKeys = derive
    return Promise.reject(new Error('falha de teste'))
  }
  t.ok(await errorOf(h.identity.finishRecovery()))
  let status = await h.identity.status()
  t.is(status.unlocked, false, 'nothing installed')
  t.is(await kvValue('passkey'), undefined, 'nothing bound')
  await h.close()
  h = await start()
  t.is((await h.identity.status()).resumed, false, 'no session was saved')

  // ---- the blob exists, the install fails: the new passkey is refused ----
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  let calls = 0
  passkeyLib.keyPairFromPrf = (prf) => {
    calls++
    if (calls === 1) return Promise.reject(new Error('falha de teste'))
    return keyPair(prf)
  }
  t.ok(await errorOf(h.identity.finishRecovery()))
  passkeyLib.keyPairFromPrf = keyPair
  const failed = fake.creds[fake.creds.length - 1]
  status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(await kvValue('passkey'), undefined)
  t.ok(status.refused.some((e) => e.userId === hex(failed.userId) && e.code === 'INSTALL_FAILED' && e.created), 'refused INSTALL_FAILED')
  t.ok((await kvValue('passkeyAttempts')).refused.some((e) => e.credentialId === toBase64Url(failed.rawId) && e.code === 'INSTALL_FAILED'), 'and kept across reloads')
})

test('recovery: a cancelRecovery right after the call leaves nothing armed', async (t) => {
  t.timeout(60000)
  const { fake, h, second, key, added, made } = await recoverable(t)

  // ---- unlockWithCode, cancelled before its hold runs ----
  const viaCode = h.identity.unlockWithCode({ code: made.code })
  await h.identity.cancelRecovery()
  t.is((await errorOf(viaCode)).code, 'CANCELLED', 'the code step is dropped')
  t.is((await errorOf(h.identity.unlockWrapped({ blob: made.blob, member: key }))).code, 'RECOVERY_BAD', 'no wrap key held')

  // ---- a recovery passkey sign-in, cancelled during its ceremony ----
  let release
  fake.hold = new Promise((resolve) => { release = resolve })
  fake.next = second
  const signIn = h.identity.unlock({ any: true })
  await h.identity.cancelRecovery()
  release()
  t.is((await errorOf(signIn)).code, 'CANCELLED', 'the sign-in is dropped')
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'RECOVERY_BAD', 'no wrap key held')
  t.is((await h.identity.status()).unlocked, false)
})

test('recovery: concluir pauses the held root again after a failed one', async (t) => {
  t.timeout(60000)
  const clock = recoveryClock(t)
  const { fake, h, key, made } = await recoverable(t)
  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  fake.pendingCreate = true
  t.alike(await h.identity.finishRecovery(), { pending: true })
  fake.pendingCreate = false

  const get = globalThis.navigator.credentials.get
  globalThis.navigator.credentials.get = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
  t.is((await errorOf(h.identity.complete())).code, 'CANCELLED')
  globalThis.navigator.credentials.get = get
  t.is(clock.live, 1, 'a failed concluir rearms the hold')

  let release
  fake.hold = new Promise((resolve) => { release = resolve })
  const concluding = h.identity.complete()
  t.is(clock.live, 0, 'the next concluir pauses it during its ceremony')
  clock.expire()
  release()
  const done = await concluding
  t.is((await h.identity.status()).unlocked, true, 'the root was still held')
  t.is((await kvValue('passkey')).credentialId, done.credentialId)
})

test('recovery: a pending add stays excluded across a reload, never offered for concluir', async (t) => {
  t.timeout(60000)
  const { fake, start } = await setup(t)
  let h = await start()
  await h.identity.unlock({ register: true })
  const pendingOf = (attempts, cred) => attempts !== undefined && attempts !== null && attempts.refused.some((e) => e.credentialId === toBase64Url(cred.rawId) && e.code === 'ADD_PENDING' && e.created && !e.cleaned)

  // ---- concluded: the entry leaves refused ----
  fake.pendingCreate = true
  t.alike(await h.identity.addPasskey(), { pending: true })
  fake.pendingCreate = false
  const concludedCred = fake.creds[fake.creds.length - 1]
  t.ok(pendingOf(await kvValue('passkeyAttempts'), concludedCred), 'recorded ADD_PENDING')
  await h.identity.complete()
  t.absent(pendingOf(await kvValue('passkeyAttempts'), concludedCred), 'gone once concluded')
  t.absent((await h.identity.status()).refused.some((e) => e.userId === hex(concludedCred.userId)))

  // ---- left pending, then a reload ----
  fake.pendingCreate = true
  t.alike(await h.identity.addPasskey(), { pending: true })
  fake.pendingCreate = false
  const waiting = fake.creds[fake.creds.length - 1]
  t.ok(pendingOf(await kvValue('passkeyAttempts'), waiting), 'recorded ADD_PENDING')
  await h.close()
  h = await start()
  t.is((await h.identity.status()).pending, false, 'a reload offers no concluir')
  t.is((await errorOf(h.identity.complete())).code, 'CANCELLED')
  await h.identity.unlock()
  await h.identity.addPasskey()
  t.ok(excludedHas(fake.calls.filter((c) => c.kind === 'create').pop(), toBase64Url(waiting.rawId)), 'excluded from later creations')
})

test('recovery: an abandoned recovery passkey with no user handle is never taken for a plain one', async (t) => {
  t.timeout(60000)
  const { fake, start } = await setup(t)
  const h = await start()
  await h.identity.unlock({ register: true })
  fake.pendingCreate = true
  t.alike(await h.identity.addPasskey(), { pending: true })
  fake.pendingCreate = false
  const dropped = fake.creds[fake.creds.length - 1]
  await h.identity.lock()
  t.ok((await h.identity.status()).refused.some((e) => e.userId === hex(dropped.userId) && e.code === 'SUPERSEDED'), 'the dropped add is refused')

  fake.next = dropped
  fake.omitHandle = true
  const out = await h.identity.unlock({ any: true })
  fake.omitHandle = false
  t.is(out.wrapped, true, 'it asks for its blob')
  t.alike(Object.keys(out).sort(), ['lookupId', 'wrapped'], 'never a direct install')
  t.is(out.lookupId, (await recovery.deriveRecoveryKeys(new Uint8Array(dropped.prf), 'passkey')).lookupId)
  t.is((await h.identity.status()).unlocked, false)
})

test('recovery: a cancel or lock while finishRecovery derives keeps the new passkey excluded', async (t) => {
  t.timeout(60000)
  const { fake, start, h: h0, key, made } = await recoverable(t)
  let h = h0
  const derive = recovery.deriveRecoveryKeys
  t.teardown(() => { recovery.deriveRecoveryKeys = derive })
  const supersededIn = (refused, cred) => refused.some((e) => e.credentialId === toBase64Url(cred.rawId) && e.code === 'SUPERSEDED' && e.created && !e.cleaned)

  for (const stop of ['cancelRecovery', 'lock']) {
    await h.identity.unlockWithCode({ code: made.code })
    t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
    recovery.deriveRecoveryKeys = async (secret, kind) => {
      if (kind !== 'passkey') return derive(secret, kind)
      recovery.deriveRecoveryKeys = derive
      await h.identity[stop]()
      return derive(secret, kind)
    }
    t.is((await errorOf(h.identity.finishRecovery())).code, 'CANCELLED', stop + ' cancels it')
    const orphan = fake.creds[fake.creds.length - 1]
    const status = await h.identity.status()
    t.is(status.unlocked, false)
    t.is(status.pending, false, 'never offered for concluir')
    t.is(await kvValue('passkey'), undefined, 'nothing bound')
    t.ok(status.refused.some((e) => e.userId === hex(orphan.userId) && e.code === 'SUPERSEDED' && e.created), 'refused SUPERSEDED')
    await h.close()
    t.ok(supersededIn((await kvValue('passkeyAttempts')).refused, orphan), 'kept across reloads')
    h = await start()
    t.is((await h.identity.status()).pending, false)
  }
})

test('recovery: a wrapping passkey that hit MISMATCH is never the chosen passkey after recomeçar', async (t) => {
  t.timeout(60000)
  const { fake, h: h0, second, key, added } = await recoverable(t)
  const h = h0
  const other = await h.identity.unlock({ register: true })
  t.not(other.publicKey, key)
  t.is(await createDiary(h), other.publicKey)
  await h.identity.lock()
  fake.next = second
  t.alike(await h.identity.unlock({ any: true }), { wrapped: true, lookupId: added.lookupId })
  t.is((await errorOf(h.identity.unlockWrapped({ blob: added.blob, member: key }))).code, 'MISMATCH')

  // 'recomeçar', then 'entrar': discoverable (the handle routes the wrapping
  // passkey to its blob), never an allow list naming it, whose answer may
  // omit the handle and install its own PRF output as a diary.
  await h.identity.reset()
  t.alike(await h.identity.unlock(), { wrapped: true, lookupId: added.lookupId }, 'asks for its blob again')
  t.alike(allowOf(fake.calls.filter((c) => c.kind === 'get').pop()), [], 'the wrapping passkey is not the chosen one')
  const status = await h.identity.status()
  t.is(status.unlocked, false)
  t.is(status.exists, false, 'no diary from its own PRF output')
})

test('recovery: a lock after finishRecovery bound the new passkey undoes the bind and the session', async (t) => {
  t.timeout(60000)
  // The session save is the step after the bind: a lock landing there
  // leaves a bound record and a saved session unless the install undoes them.
  const sessionLib = require('../lib/session-store')
  const createSessionStore = sessionLib.createSessionStore
  let onSave = null
  sessionLib.createSessionStore = (opts) => {
    const inner = createSessionStore(opts)
    return {
      ...inner,
      async save (...args) {
        const hook = onSave
        onSave = null
        if (hook !== null) await hook()
        return inner.save(...args)
      }
    }
  }
  t.teardown(() => { sessionLib.createSessionStore = createSessionStore })
  const { fake, start, h: h0, key, made } = await recoverable(t)
  let h = h0

  await h.identity.unlockWithCode({ code: made.code })
  t.alike(await h.identity.unlockWrapped({ blob: made.blob, member: key }), { needsPasskey: true })
  onSave = () => h.identity.lock()
  t.is((await errorOf(h.identity.finishRecovery())).code, 'CANCELLED', 'the lock cancels it')
  const created = fake.creds[fake.creds.length - 1]
  const createdId = toBase64Url(created.rawId)
  let status = await h.identity.status()
  t.is(status.unlocked, false)
  const record = await kvValue('passkey')
  t.ok(record === undefined || record === null, 'the bind is undone')
  t.ok(status.refused.some((e) => e.userId === hex(created.userId) && e.code === 'INSTALL_FAILED' && e.created && !e.cleaned), 'refused INSTALL_FAILED')
  await h.close()
  t.ok((await kvValue('passkeyAttempts')).refused.some((e) => e.credentialId === createdId && e.code === 'INSTALL_FAILED'), 'kept across reloads')
  fake.calls.length = 0
  h = await start()
  status = await h.identity.status()
  t.is(status.resumed, false, 'no session survives')
  t.is(status.unlocked, false)
})

// Every kv write of the node's storage and every session save or clear, for
// the handles started after this call (setup requires web/node.js fresh).
function spyWrites (t) {
  const storageLib = require('../lib/node-storage')
  const sessionLib = require('../lib/session-store')
  const idbNodeStorage = storageLib.idbNodeStorage
  const createSessionStore = sessionLib.createSessionStore
  const log = []
  storageLib.idbNodeStorage = async (...args) => {
    const storage = await idbNodeStorage(...args)
    const writeJson = storage.writeJson
    storage.writeJson = (key, value) => {
      log.push('kv:' + key)
      return writeJson.call(storage, key, value)
    }
    return storage
  }
  sessionLib.createSessionStore = (opts) => {
    const inner = createSessionStore(opts)
    return {
      ...inner,
      save: (...args) => { log.push('session:save'); return inner.save(...args) },
      clear: (...args) => { log.push('session:clear'); return inner.clear(...args) }
    }
  }
  t.teardown(() => {
    storageLib.idbNodeStorage = idbNodeStorage
    sessionLib.createSessionStore = createSessionStore
  })
  return log
}

function gate () {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

const kvState = async () => [await kvValue('passkey'), await kvValue('passkeyAttempts'), await kvValue('signedOut')]

test('confirm: a fresh user check with the bound passkey, nothing changes', async (t) => {
  t.timeout(60000)
  const writes = spyWrites(t)
  const { fake, start } = await setup(t)
  const h = await start()

  const locked = await errorOf(h.identity.confirm())
  t.is(locked.code, 'LOCKED', 'refused while locked')
  t.is(locked.message, 'identidade bloqueada: entre com a passkey')
  t.is(fake.calls.length, 0, 'no ceremony while locked')

  await h.identity.unlock({ register: true })
  const bound = toBase64Url(fake.creds[0].rawId)
  await createDiary(h)
  const before = await h.identity.status()
  t.is(before.unlocked, true)
  t.ok(writes.includes('kv:passkey') && writes.includes('session:save'), 'the spy sees the unlock bind and save')
  const kvBefore = await kvState()
  const logged = writes.length

  const realGet = fake.get
  let answered = null
  fake.get = (o) => realGet(o).then((cred) => {
    answered = cred.getClientExtensionResults().prf.results.first
    return cred
  })
  const calls = fake.calls.length
  const confirming = h.identity.confirm()
  t.is(fake.calls.length, calls + 1, 'navigator.credentials.get runs in the call, before any await')
  const confirmed = await confirming
  t.is(confirmed.ok, true)
  t.is(confirmed.assertion.credentialId, bound, 'the assertion of the bound passkey goes to the account service')
  t.alike(Object.keys(confirmed.assertion).sort(), ['authenticatorData', 'clientDataJSON', 'credentialId', 'signature'])
  const call = fake.calls[fake.calls.length - 1]
  t.is(call.kind, 'get')
  t.alike(allowOf(call), [bound], 'restricted to the bound passkey')
  t.is(call.publicKey.userVerification, 'required')
  t.absent('extensions' in call.publicKey, 'no PRF asked for')
  t.ok(answered !== null && new Uint8Array(answered).every((b) => b === 0), 'a PRF output handed back anyway is wiped')
  fake.get = realGet

  const nonce = toBase64Url(new Uint8Array(32).fill(0x42))
  t.is((await h.identity.confirm({ challenge: nonce })).ok, true, 'a second check runs once the first settled')
  t.is(toBase64Url(new Uint8Array(fake.calls[fake.calls.length - 1].publicKey.challenge)), nonce, 'the account service nonce is the challenge')
  const n = fake.calls.length
  t.is((await errorOf(h.identity.confirm({ challenge: 'abc' }))).code, 'USAGE', 'a bad challenge is refused')
  t.is(fake.calls.length, n, 'and runs no ceremony')
  t.alike(await h.identity.status(), before, 'the status is unchanged')
  t.alike(writes.slice(logged), [], 'no kv write, no session save or clear')
  t.alike(await kvState(), kvBefore, 'the passkey record, attempts and sign-out marker are unchanged')
})

test('confirm: CANCELLED, MISMATCH, no UV, one ceremony at a time, lock and Sair cancel it', async (t) => {
  t.timeout(60000)
  const writes = spyWrites(t)
  const { fake, start } = await setup(t)
  const h = await start()
  await h.identity.unlock({ register: true })
  await createDiary(h)
  const before = await h.identity.status()
  const kvBefore = await kvState()
  const logged = writes.length
  const realGet = fake.get

  fake.get = (o) => {
    fake.calls.push({ kind: 'get', publicKey: o.publicKey })
    return Promise.reject(Object.assign(new Error('browser text'), { name: 'NotAllowedError' }))
  }
  const cancelled = await errorOf(h.identity.confirm())
  t.is(cancelled.code, 'CANCELLED', 'the person dismissed the prompt')
  t.is(cancelled.message, passkeyLib.MESSAGES.CANCELLED)

  // An authenticator that ignores allowCredentials and answers with another passkey.
  const other = fake.add(random32())
  fake.get = (o) => Promise.resolve(fake.credentialOf(other, { prf: { results: { first: arrayBufferOf(other.prf) } } }))
  const mismatch = await errorOf(h.identity.confirm())
  t.is(mismatch.code, 'MISMATCH', 'another passkey is refused')
  t.is(mismatch.message, 'passkey não corresponde ao diário guardado')
  fake.get = realGet

  fake.flags = 0x19
  const unverified = await errorOf(h.identity.confirm())
  t.is(unverified.code, 'WEBAUTHN', 'an answer without the UV flag is refused')
  t.is(unverified.message, passkeyLib.MESSAGES.WEBAUTHN)
  fake.flags = 0x1d

  t.alike(await h.identity.status(), before, 'still unlocked, unchanged')
  t.alike(writes.slice(logged), [], 'a failed check writes nothing either')
  t.alike(await kvState(), kvBefore)

  // One ceremony at a time, both ways.
  let held = gate()
  fake.hold = held.promise
  const first = h.identity.confirm()
  const second = await errorOf(h.identity.confirm())
  t.is(second.code, 'LOCKED', 'a second confirm waits its turn')
  t.is(second.message, 'outra entrada com a passkey em andamento')
  t.is((await errorOf(h.identity.unlock())).code, 'LOCKED', 'so does an unlock')
  held.release()
  t.is((await first).ok, true)

  held = gate()
  fake.hold = held.promise
  const unlocking = h.identity.unlock()
  t.is((await errorOf(h.identity.confirm())).code, 'LOCKED', 'an unlock in flight refuses a confirm')
  held.release()
  t.is((await unlocking).publicKey, before.publicKey)

  // lock() during the ceremony: CANCELLED, and the node is locked.
  held = gate()
  fake.hold = held.promise
  const locking = h.identity.confirm()
  await h.identity.lock()
  held.release()
  t.is((await errorOf(locking)).code, 'CANCELLED', 'a lock cancels it')
  t.is((await h.identity.status()).unlocked, false)
  t.is((await errorOf(h.identity.confirm())).code, 'LOCKED')

  // signOut() during the ceremony: CANCELLED too.
  await h.identity.unlock()
  held = gate()
  fake.hold = held.promise
  const leaving = h.identity.confirm()
  await h.identity.signOut()
  held.release()
  t.is((await errorOf(leaving)).code, 'CANCELLED', 'Sair cancels it')
  t.is((await h.identity.status()).unlocked, false)
})

test('enrolment: a passkey created here keeps its attestation object for the account service until dropped', async (t) => {
  t.timeout(60000)
  const { fake, start } = await setup(t)
  const h = await start()
  t.is(await h.identity.enrolment(), null, 'nothing while locked')
  await h.identity.unlock({ register: true })
  const id = toBase64Url(fake.creds[0].rawId)
  const enrol = await h.identity.enrolment()
  t.is(enrol.credentialId, id)
  t.is(enrol.attestationObject, toBase64Url(new Uint8Array([0xa0, ...fake.creds[0].rawId])))
  await h.identity.lock()
  t.is(await h.identity.enrolment(), null, 'answered only while unlocked')
  await h.identity.unlock()
  t.is((await h.identity.enrolment()).credentialId, id, 'a sign-in with the same passkey still has it')
  await h.identity.dropEnrolment()
  t.is(await h.identity.enrolment(), null, 'gone once the service stored it')
  t.is(await kvValue('passkeyEnrol'), null)
})
