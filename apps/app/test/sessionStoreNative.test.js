'use strict'

// src/sessionStore.native.js (the keychain session of the in-app web node)
// and src/identity.native.js (the handle's identity API over the passkey-prf
// module and the IPC), with expo-secure-store and the native module replaced
// by in-memory stubs. Metro resolves the extensionless relative imports and
// the .native.js files; the hook below does the same for Node.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const secureStore = `
const items = globalThis.__secureItems = globalThis.__secureItems || new Map()
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'wutdo'
function check (options) {
  if (!options || options.keychainAccessible !== 'wutdo') throw new Error('accessibility')
}
export async function getItemAsync (key, options) {
  check(options)
  if (globalThis.__secureGetFails) throw new Error('get failed')
  return items.has(key) ? items.get(key) : null
}
export async function setItemAsync (key, value, options) {
  check(options)
  if (!/^[\\w.-]+$/.test(key)) throw new Error('bad key')
  if (globalThis.__secureSetFails || (globalThis.__secureSetFailsFor && globalThis.__secureSetFailsFor(key))) throw new Error('set failed')
  items.set(key, value)
}
export async function deleteItemAsync (key, options) {
  check(options)
  if (globalThis.__secureDeleteFails) throw new Error('delete failed')
  items.delete(key)
}
`
const passkeyPrf = `
export function isAvailable () { return globalThis.__passkey ? globalThis.__passkey.isAvailable() : false }
export async function create (json) { return globalThis.__passkey.create(json) }
export async function get (json) { return globalThis.__passkey.get(json) }
`
const fileSystem = `
const files = globalThis.__stubFiles = globalThis.__stubFiles || new Map()
export const Paths = { document: { uri: 'file:///stub/Documents/' } }
export class File {
  constructor (dir, name) { this.uri = dir.uri + name }
  get exists () { return files.has(this.uri) }
  create () { if (files.has(this.uri)) throw new Error('exists'); files.set(this.uri, '') }
  // A failed write leaves a torn file, as a real disk can.
  write (text) {
    if (globalThis.__stubWriteFails) { files.set(this.uri, String(text).slice(0, 5)); throw new Error('disk full') }
    files.set(this.uri, String(text))
  }
  textSync () {
    if (globalThis.__stubReadFails) throw new Error('io error')
    if (!files.has(this.uri)) throw new Error('missing')
    return files.get(this.uri)
  }
  delete () { if (!files.has(this.uri)) throw new Error('missing'); files.delete(this.uri) }
  // As the native modules: neither overwrites an existing destination.
  copy (dest) {
    if (!files.has(this.uri) || files.has(dest.uri)) throw new Error('cannot copy')
    files.set(dest.uri, files.get(this.uri))
  }
  move (dest) {
    if (globalThis.__stubMoveFails || !files.has(this.uri) || files.has(dest.uri)) throw new Error('cannot move')
    files.set(dest.uri, files.get(this.uri))
    files.delete(this.uri)
    this.uri = dest.uri
  }
}
`
const hooks = `
const stubs = {
  'expo-secure-store': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(secureStore)}),
  'expo-file-system': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fileSystem)}),
  '../modules/passkey-prf': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(passkeyPrf)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (specifier === './sessionStore' && context.parentURL && context.parentURL.includes('/src/')) {
    return next('./sessionStore.native.js', context)
  }
  if (specifier === './passkeyLocal' && context.parentURL && context.parentURL.includes('/src/')) {
    return next('./passkeyLocal.native.js', context)
  }
  if (/^\\.\\.?\\/[^.]*$/.test(specifier) && context.parentURL && context.parentURL.includes('/src/')) {
    return next(specifier + '.js', context)
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const DAY = 24 * 60 * 60 * 1000
const RP = 'varanda.example'
const PK = 'ab'.repeat(32)
const PRF_HEX = 'cd'.repeat(32)
const CRED = 'Y3JlZA'

const items = () => globalThis.__secureItems
const files = () => globalThis.__stubFiles
const EPOCH = 'file:///stub/Documents/varanda-keychain-epoch'
// The marker of an app that already ran: tests opt into a fresh install.
function resetStubs ({ fresh = false } = {}) {
  if (items()) items().clear()
  if (files()) files().clear()
  globalThis.__stubFiles = globalThis.__stubFiles || new Map()
  if (!fresh) files().set(EPOCH, '1')
  globalThis.__stubWriteFails = false
  globalThis.__stubReadFails = false
  globalThis.__stubMoveFails = false
  globalThis.__secureGetFails = false
  globalThis.__secureSetFails = false
  globalThis.__secureSetFailsFor = null
  globalThis.__secureDeleteFails = false
  globalThis.__passkey = null
}

const loadStore = () => import('../src/sessionStore.native.js')
const loadIdentity = () => import('../src/identity.native.js')

test('session store: save then load, bound to rp.id and public key', async (t) => {
  resetStubs()
  const { createSessionStore, itemKey } = await loadStore()
  const now = 1000 * DAY
  const store = createSessionStore({ now: () => now })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  t.ok(items().has(itemKey(RP, PK)))
  t.alike(await store.load({ rpId: RP, publicKey: PK }), { credentialId: CRED, prfHex: PRF_HEX })

  t.is(await store.load({ rpId: 'other.example', publicKey: PK }), null)
  t.is(await store.load({ rpId: RP, publicKey: 'ef'.repeat(32) }), null)
  t.ok(items().has(itemKey(RP, PK)), 'another binding does not touch the record')

  // A record moved under this key but naming another binding is refused and deleted.
  const moved = JSON.parse(items().get(itemKey(RP, PK)))
  items().set(itemKey(RP, PK), JSON.stringify({ ...moved, rpId: 'other.example' }))
  t.is(await store.load({ rpId: RP, publicKey: PK }), null)
  t.absent(items().has(itemKey(RP, PK)))

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  items().set(itemKey(RP, PK), JSON.stringify({ ...moved, publicKey: 'ef'.repeat(32), usedAt: now }))
  t.is(await store.load({ rpId: RP, publicKey: PK }), null)
  t.absent(items().has(itemKey(RP, PK)))
})

test('session store: idle expiry, refresh, missing and future usedAt', async (t) => {
  resetStubs()
  const { createSessionStore, itemKey } = await loadStore()
  let now = 1000 * DAY
  const store = createSessionStore({ now: () => now })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })

  now += 29 * DAY
  t.ok(await store.load({ rpId: RP, publicKey: PK }), 'within 30 days')
  t.is(JSON.parse(items().get(itemKey(RP, PK))).usedAt, now, 'load refreshes usedAt')
  now += 29 * DAY
  t.ok(await store.load({ rpId: RP, publicKey: PK }), 'refreshed period')
  now += 30 * DAY + 1
  t.is(await store.load({ rpId: RP, publicKey: PK }), null, 'expired')
  t.absent(items().has(itemKey(RP, PK)))

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const rec = JSON.parse(items().get(itemKey(RP, PK)))
  items().set(itemKey(RP, PK), JSON.stringify({ ...rec, usedAt: now + DAY + 1 }))
  t.is(await store.load({ rpId: RP, publicKey: PK }), null, 'more than a day ahead')
  t.absent(items().has(itemKey(RP, PK)))

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  items().set(itemKey(RP, PK), JSON.stringify({ ...rec, usedAt: now + DAY }))
  t.ok(await store.load({ rpId: RP, publicKey: PK }), 'one day ahead is tolerated')

  const { usedAt, ...noUsedAt } = rec
  t.ok(usedAt)
  items().set(itemKey(RP, PK), JSON.stringify(noUsedAt))
  t.is(await store.load({ rpId: RP, publicKey: PK }), null, 'missing usedAt')
  t.absent(items().has(itemKey(RP, PK)))

  items().set(itemKey(RP, PK), JSON.stringify({ ...rec, v: 2, usedAt: now }))
  t.is(await store.load({ rpId: RP, publicKey: PK }), null, 'unknown version')
  items().set(itemKey(RP, PK), '{not json')
  t.is(await store.load({ rpId: RP, publicKey: PK }), null, 'malformed')
  t.absent(items().has(itemKey(RP, PK)))
})

test('session store: clear deletes the item and the index, and throws on failure', async (t) => {
  resetStubs()
  const { createSessionStore, itemKey } = await loadStore()
  const store = createSessionStore({ now: () => 1000 * DAY })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: 'ef'.repeat(32), prfHex: PRF_HEX })
  t.absent(items().has(itemKey(RP, PK)), 'one stored session per device')
  globalThis.__secureDeleteFails = true
  await t.exception(store.clear())
  globalThis.__secureDeleteFails = false
  await store.clear()
  t.is(items().size, 0)

  await t.exception.all(store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: 'zz' }))
  globalThis.__secureSetFails = true
  await t.exception(store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX }))
  t.is(items().size, 0)
})

// The fake IPC: records every request; `answers` overrides per method.
function fakeClient ({ status = {}, answers = {} } = {}) {
  const calls = []
  const st = { exists: false, publicKey: null, legacy: false, unlocked: false, synced: false, resumed: false, passkeyKnown: false, credentialId: null, rpId: null, signedOut: false, ...status }
  const request = async (method, params) => {
    calls.push({ method, params })
    if (answers[method]) return answers[method](params)
    if (method === 'identity.status') return { ...st }
    if (method === 'identity.install') return { publicKey: PK, resumed: params.resumed }
    return {}
  }
  return { request, calls, methods: () => calls.map((c) => c.method) }
}

function prfResponse (prf, extra = {}) {
  return JSON.stringify({
    id: CRED,
    rawId: CRED,
    response: { userHandle: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url') },
    clientExtensionResults: prf === null ? {} : { prf },
    ...extra
  })
}

function fakePasskey ({ create, get } = {}) {
  const seen = []
  globalThis.__passkey = {
    isAvailable: () => true,
    create: async (json) => { seen.push({ kind: 'create', options: JSON.parse(json) }); return create() },
    get: async (json) => { seen.push({ kind: 'get', options: JSON.parse(json) }); return get() }
  }
  return seen
}

const PRF_B64 = Buffer.from(PRF_HEX, 'hex').toString('base64url')

function memoryStore ({ saveFails = false, clearFails = false } = {}) {
  const log = []
  return {
    log,
    save: async (rec) => { log.push(['save', rec]); if (saveFails) throw new Error('nope') },
    load: async () => null,
    clear: async () => { log.push(['clear']); if (clearFails) throw new Error('nope') },
    clearAll: async (opts) => { log.push(['clearAll', opts]); if (clearFails) throw new Error('nope') }
  }
}

function deterministicRandom (n) {
  return new Uint8Array(n).fill(3)
}

test('identity: unlock installs with resumed false, then saves, then sessionSaved', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const seen = fakePasskey({ get: () => prfResponse({ results: { first: PRF_B64 } }) })
  const client = fakeClient()
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const out = await id.unlock({})
  t.alike(out, { publicKey: PK, created: false })
  t.is(seen[0].kind, 'get')
  t.is(seen[0].options.rpId, RP)
  const install = client.calls.find((c) => c.method === 'identity.install')
  t.alike(install.params, { prf: PRF_HEX, credentialId: CRED, userId: '01'.repeat(32), rpId: RP, resumed: false })
  t.alike(store.log[0], ['save', { rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX }])
  t.alike(client.methods(), ['identity.status', 'identity.install', 'identity.sessionSaved'])
})

test('identity: a failed save unlocks with sessionSaved false and never calls sessionSaved', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({ get: () => prfResponse({ results: { first: PRF_B64 } }) })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore({ saveFails: true }), random: deterministicRandom })
  t.alike(await id.unlock({}), { publicKey: PK, created: false, sessionSaved: false })
  t.absent(client.methods().includes('identity.sessionSaved'))
})

test('identity: NO_PRF never installs, keeps prf unknown and allows a retry', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { MESSAGES } = await import('../src/passkeyOptions.js')
  fakePasskey({ get: () => prfResponse(null), create: () => prfResponse({ enabled: false }) })
  const client = fakeClient()
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const err = await id.unlock({}).catch((e) => e)
  t.is(err.code, 'NO_PRF')
  t.is(err.credentialId, CRED)
  const created = await id.unlock({ register: true }).catch((e) => e)
  t.is(created.code, 'NO_PRF')
  t.is(created.userId, '03'.repeat(32))
  t.absent(client.methods().includes('identity.install'))
  t.is(store.log.length, 0)
  t.is((await id.status()).prf, 'unknown', 'one passkey without PRF does not block the next try')
  t.is(err.message, MESSAGES.NO_PRF)
})

test('identity: a creation without the output goes pending, then complete gets it', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const seen = fakePasskey({
    create: () => prfResponse({ enabled: true }),
    get: () => prfResponse({ results: { first: PRF_B64 } })
  })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  t.absent(client.methods().includes('identity.install'))
  t.is(seen[0].options.extensions.prf.eval.first, Buffer.from('varanda/member-identity/prf/v1').toString('base64url'))
  t.alike(await id.complete(), { publicKey: PK, created: true })
  t.alike(seen[1].options.allowCredentials, [{ type: 'public-key', id: CRED }])
  const install = client.calls.find((c) => c.method === 'identity.install')
  t.is(install.params.resumed, false)
  t.is((await id.complete().catch((e) => e)).code, 'CANCELLED', 'nothing pending any more')
})

test('identity: ceremony errors keep the web codes and texts', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { MESSAGES } = await import('../src/passkeyOptions.js')
  const failing = (code) => { const e = new Error('native text'); e.code = code; throw e }
  let code = 'CANCELLED'
  fakePasskey({ get: () => failing(code) })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), random: deterministicRandom })
  for (const c of ['CANCELLED', 'UNSUPPORTED', 'WEBAUTHN', 'whatever']) {
    code = c
    const err = await id.unlock({}).catch((e) => e)
    const expected = c === 'whatever' ? 'WEBAUTHN' : c
    t.is(err.code, expected)
    t.is(err.message, MESSAGES[expected])
  }
  const none = createNativeIdentity({ request: client.request, rpId: () => null, store: memoryStore(), random: deterministicRandom })
  t.is((await none.unlock({}).catch((e) => e)).code, 'UNSUPPORTED')
  t.is((await none.status()).webauthn, false)
})

test('identity: a key for another diary is MISMATCH', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({ get: () => prfResponse({ results: { first: PRF_B64 } }) })
  const usage = () => { const e = new Error('passkey não corresponde ao diário guardado'); e.code = 'USAGE'; throw e }
  const client = fakeClient({ status: { legacy: true }, answers: { 'identity.install': usage } })
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const err = await id.unlock({}).catch((e) => e)
  t.is(err.code, 'MISMATCH')
  t.is(err.legacy, true)
  t.is(store.log.length, 0)
})

test('identity: signOut forgets first, then deletes; a failed delete is SIGNOUT_INCOMPLETE', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const order = []
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  const request = (m, p) => { order.push(m); return client.request(m, p) }
  const store = memoryStore()
  store.clear = async () => { order.push('store.clear') }
  const id = createNativeIdentity({ request, rpId: () => RP, store })
  await id.signOut()
  t.alike(order.filter((m) => m !== 'identity.status'), ['identity.forget', 'store.clear'])

  const bad = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore({ clearFails: true }) })
  const err = await bad.signOut().catch((e) => e)
  t.is(err.code, 'SIGNOUT_INCOMPLETE')
  t.ok(client.methods().includes('identity.forget'))

  const forgetFails = fakeClient({ answers: { 'identity.forget': () => { throw new Error('boom') } } })
  const s2 = memoryStore()
  const id2 = createNativeIdentity({ request: forgetFails.request, rpId: () => RP, store: s2 })
  const forgetErr = await id2.signOut().catch((e) => e)
  t.is(forgetErr.code, 'SIGNOUT_INCOMPLETE')
  t.alike(s2.log, [['clear']], 'the item goes even when the marker could not be written')
  const fm = forgetFails.methods()
  t.ok(fm.indexOf('identity.clear') > fm.indexOf('identity.forget'), 'relocked')
})

test('identity: a plain sign-in offers only the bound passkey', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const seen = fakePasskey({ get: () => prfResponse({ results: { first: PRF_B64 } }) })
  const bound = fakeClient({ status: { exists: true, publicKey: PK, passkeyKnown: true, credentialId: CRED, rpId: RP } })
  await createNativeIdentity({ request: bound.request, rpId: () => RP, store: memoryStore(), random: deterministicRandom }).unlock({})
  t.alike(seen[0].options.allowCredentials, [{ type: 'public-key', id: CRED }])

  const elsewhere = fakeClient({ status: { exists: true, publicKey: PK, passkeyKnown: true, credentialId: CRED, rpId: 'other.example' } })
  await createNativeIdentity({ request: elsewhere.request, rpId: () => RP, store: memoryStore(), random: deterministicRandom }).unlock({})
  t.absent(seen[1].options.allowCredentials)
})

test('identity: user ids come from the pending creation, or a 32-byte handle only', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let handle = null
  const assertion = () => JSON.stringify({
    id: CRED,
    rawId: CRED,
    response: handle === null ? {} : { userHandle: handle },
    clientExtensionResults: { prf: { results: { first: PRF_B64 } } }
  })
  fakePasskey({ create: () => prfResponse({ enabled: true }), get: assertion })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  handle = Buffer.from(new Uint8Array(16).fill(9)).toString('base64url')
  await id.complete()
  const installs = () => client.calls.filter((c) => c.method === 'identity.install')
  t.is(installs()[0].params.userId, '03'.repeat(32), 'the pending creation user id')

  await id.unlock({})
  t.is(installs()[1].params.userId, '', 'a handle that is not 32 bytes is dropped')
  handle = null
  await id.unlock({})
  t.is(installs()[2].params.userId, '')
})

test('identity: resume keeps the item on a transient refusal', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore, itemKey } = await loadStore()
  const store = createSessionStore({ now: () => 1000 * DAY })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const busy = () => { const e = new Error('pedidos demais em andamento'); e.code = 'USAGE'; throw e }
  const client = fakeClient({ status: { exists: true, publicKey: PK }, answers: { 'identity.install': busy } })
  await createNativeIdentity({ request: client.request, rpId: () => RP, store }).resume()
  t.ok(items().has(itemKey(RP, PK)))

  const mismatch = () => { const e = new Error('passkey não corresponde ao diário guardado'); e.code = 'USAGE'; throw e }
  const other = fakeClient({ status: { exists: true, publicKey: PK }, answers: { 'identity.install': mismatch } })
  await createNativeIdentity({ request: other.request, rpId: () => RP, store }).resume()
  t.absent(items().has(itemKey(RP, PK)))
})

test('session store: a failed index write keeps the previous record of the same key', async (t) => {
  resetStubs()
  const { createSessionStore, itemKey } = await loadStore()
  let now = 1000 * DAY
  const store = createSessionStore({ now: () => now })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  now += DAY
  globalThis.__secureSetFailsFor = (key) => key === 'varanda-session.index'
  await t.exception(store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: 'ef'.repeat(32) }))
  globalThis.__secureSetFailsFor = null
  t.alike(await store.load({ rpId: RP, publicKey: PK }), { credentialId: CRED, prfHex: PRF_HEX })

  globalThis.__secureSetFailsFor = (key) => key === 'varanda-session.index'
  await t.exception(store.save({ rpId: RP, credentialId: CRED, publicKey: 'ef'.repeat(32), prfHex: PRF_HEX }))
  globalThis.__secureSetFailsFor = null
  t.absent(items().has(itemKey(RP, 'ef'.repeat(32))), 'a new key is removed')
})

test('identity: reset deletes the stored session whatever the answer', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const client = fakeClient({ answers: { 'identity.reset': () => { throw new Error('boom') } } })
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store })
  await t.exception(id.reset())
  t.alike(store.log, [['clear']])
  const ok = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore({ clearFails: true }) })
  t.is((await ok.reset().catch((e) => e)).code, 'SIGNOUT_INCOMPLETE')
})

test('identity: resume installs the stored session without a ceremony', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore } = await loadStore()
  const seen = fakePasskey({ get: () => { throw new Error('no ceremony expected') } })
  const store = createSessionStore({ now: () => 1000 * DAY })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const client = fakeClient({ status: { exists: true, publicKey: PK, passkeyKnown: true, credentialId: CRED } })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store })
  await id.resume()
  const install = client.calls.find((c) => c.method === 'identity.install')
  t.alike(install.params, { prf: PRF_HEX, credentialId: CRED, userId: '', rpId: RP, resumed: true })
  t.is(seen.length, 0)
})

test('identity: resume skips and deletes on signedOut, refusal, or another key', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore, itemKey } = await loadStore()
  const store = createSessionStore({ now: () => 1000 * DAY })

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const signedOut = fakeClient({ status: { exists: true, publicKey: PK, signedOut: true } })
  await createNativeIdentity({ request: signedOut.request, rpId: () => RP, store }).resume()
  t.absent(signedOut.methods().includes('identity.install'))
  t.absent(items().has(itemKey(RP, PK)))

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const refuse = () => { const e = new Error('sessão encerrada neste aparelho: entre com a passkey'); e.code = 'USAGE'; throw e }
  const refused = fakeClient({ status: { exists: true, publicKey: PK }, answers: { 'identity.install': refuse } })
  await createNativeIdentity({ request: refused.request, rpId: () => RP, store }).resume()
  t.ok(refused.methods().includes('identity.install'))
  t.absent(items().has(itemKey(RP, PK)))

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const legacy = fakeClient({ status: { exists: true, publicKey: PK, legacy: true } })
  await createNativeIdentity({ request: legacy.request, rpId: () => RP, store }).resume()
  t.absent(legacy.methods().includes('identity.install'))
  t.absent(items().has(itemKey(RP, PK)), 'a legacy diary leaves no stored session')

  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })

  const other = fakeClient({ status: { exists: true, publicKey: 'ef'.repeat(32) } })
  await createNativeIdentity({ request: other.request, rpId: () => RP, store }).resume()
  t.absent(other.methods().includes('identity.install'))

  const otherCred = fakeClient({ status: { exists: true, publicKey: PK, credentialId: 'b3RoZXI' } })
  await createNativeIdentity({ request: otherCred.request, rpId: () => RP, store }).resume()
  t.absent(otherCred.methods().includes('identity.install'))
  t.absent(items().has(itemKey(RP, PK)))
})

function deferred () {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, resolve: settle }
}

test('identity: a retry after NO_PRF can still unlock', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let withPrf = false
  fakePasskey({ get: () => prfResponse(withPrf ? { results: { first: PRF_B64 } } : null) })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), random: deterministicRandom })
  t.is((await id.unlock({}).catch((e) => e)).code, 'NO_PRF')
  withPrf = true
  t.alike(await id.unlock({}), { publicKey: PK, created: false })
})

test('identity: signOut during the ceremony installs and saves nothing', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore } = await loadStore()
  const gate = deferred()
  fakePasskey({ get: async () => { await gate.promise; return prfResponse({ results: { first: PRF_B64 } }) } })
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  const store = createSessionStore({ now: () => 1000 * DAY })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const unlocking = id.unlock({}).catch((e) => e)
  await new Promise((resolve) => setImmediate(resolve))
  await id.signOut()
  gate.resolve()
  const err = await unlocking
  t.is(err.code, 'CANCELLED')
  t.is(err.message, 'entrada com a passkey cancelada')
  t.absent(client.methods().includes('identity.install'))
  t.absent(client.methods().includes('identity.sessionSaved'))
  t.is(items().size, 0, 'nothing stored')
})

test('identity: signOut during the save relocks and deletes the item afterwards', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore } = await loadStore()
  fakePasskey({ get: () => prfResponse({ results: { first: PRF_B64 } }) })
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  const real = createSessionStore({ now: () => 1000 * DAY })
  const saving = deferred()
  const release = deferred()
  const order = []
  const store = {
    load: real.load,
    save: async (rec) => { saving.resolve(); await release.promise; await real.save(rec); order.push('saved') },
    clear: async (args) => { await real.clear(args); order.push('cleared') }
  }
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const unlocking = id.unlock({}).catch((e) => e)
  await saving.promise
  const signingOut = id.signOut()
  release.resolve()
  await signingOut
  const err = await unlocking
  t.is(err.code, 'CANCELLED')
  t.alike(order, ['saved', 'cleared'], 'the item is deleted after the save settled')
  t.is(items().size, 0)
  t.absent(client.methods().includes('identity.sessionSaved'))
  const methods = client.methods()
  const install = methods.indexOf('identity.install')
  const relock = methods.indexOf('identity.clear')
  const forget = methods.indexOf('identity.forget')
  t.ok(install !== -1 && relock > install, 'relocked after the install')
  t.ok(forget > relock, 'Sair writes the barrier after the save settled')
})

test('identity: lock during the install relocks without saving', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({ get: () => prfResponse({ results: { first: PRF_B64 } }) })
  const installing = deferred()
  const release = deferred()
  const client = fakeClient({
    answers: {
      'identity.install': async (p) => { installing.resolve(); await release.promise; return { publicKey: PK, resumed: p.resumed } }
    }
  })
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const unlocking = id.unlock({}).catch((e) => e)
  await installing.promise
  await id.lock()
  release.resolve()
  t.is((await unlocking).code, 'CANCELLED')
  t.is(store.log.length, 0)
  t.is(client.methods().filter((m) => m === 'identity.clear').length, 2, 'lock plus the relock')
})

test('session store: clearAll deletes the indexed session, of one rp.id when given', async (t) => {
  resetStubs()
  const { createSessionStore, itemKey } = await loadStore()
  const store = createSessionStore({ now: () => 1000 * DAY })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  await store.clearAll({ rpId: 'other.example' })
  t.ok(items().has(itemKey(RP, PK)), 'another rp.id is left alone')
  await store.clearAll({ rpId: RP })
  t.is(items().size, 0, 'any public key of this rp.id, and the index')
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  globalThis.__secureDeleteFails = true
  await t.exception(store.clearAll())
  globalThis.__secureDeleteFails = false
  await store.clearAll()
  t.is(items().size, 0)
})

test('identity: a fresh install deletes every stored session, then writes the marker', async (t) => {
  resetStubs({ fresh: true })
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore, itemKey } = await loadStore()
  const store = createSessionStore({ now: () => 1000 * DAY })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  t.absent(files().has(EPOCH))
  const client = fakeClient({ status: { exists: true, publicKey: PK, credentialId: CRED } })
  await createNativeIdentity({ request: client.request, rpId: () => RP, store }).resume()
  t.absent(items().has(itemKey(RP, PK)), 'the item of the deleted app is gone')
  t.absent(client.methods().includes('identity.install'), 'nothing resumed from it')
  t.ok(files().has(EPOCH), 'marker written')

  // The next start (marker present) keeps and resumes a valid item.
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const next = fakeClient({ status: { exists: true, publicKey: PK, credentialId: CRED } })
  await createNativeIdentity({ request: next.request, rpId: () => RP, store }).resume()
  t.ok(items().has(itemKey(RP, PK)))
  t.ok(next.methods().includes('identity.install'))
})

test('identity: a failed purge writes no marker and resumes nothing', async (t) => {
  resetStubs({ fresh: true })
  const { createNativeIdentity } = await loadIdentity()
  const store = memoryStore({ clearFails: true })
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  await createNativeIdentity({ request: client.request, rpId: () => RP, store }).resume()
  t.alike(store.log, [['clearAll', undefined]])
  t.absent(files().has(EPOCH))
  t.absent(client.methods().includes('identity.status'))
})

test('identity: a status with no diary deletes the stored session of this rp.id', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createSessionStore, itemKey } = await loadStore()
  const store = createSessionStore({ now: () => 1000 * DAY })
  await store.save({ rpId: RP, credentialId: CRED, publicKey: PK, prfHex: PRF_HEX })
  const client = fakeClient({ status: { exists: false, publicKey: null } })
  await createNativeIdentity({ request: client.request, rpId: () => RP, store }).resume()
  t.absent(items().has(itemKey(RP, PK)))
  t.absent(client.methods().includes('identity.install'))
})

// The pending creation and refused passkeys (src/passkeyLocal.native.js), in
// memory: the same three functions, shared across identities like the file.
function memoryLocal () {
  const byRp = new Map()
  const copy = (v) => JSON.parse(JSON.stringify(v))
  return {
    byRp,
    load: (rpId) => byRp.has(rpId) ? copy(byRp.get(rpId)) : { pending: null, refused: [] },
    save: (rpId, rec) => { byRp.set(rpId, copy(rec)) },
    clear: (rpId) => { byRp.delete(rpId) }
  }
}

// A 37-byte authenticator data with the given flags byte.
function authData (flags) {
  const bytes = new Uint8Array(37)
  bytes[32] = flags
  return bytes
}

// A CBOR attestationObject { fmt: 'none', attStmt: {}, authData }, by hand.
function attestationObject (data) {
  const text = (s) => [0x60 + s.length, ...Buffer.from(s)]
  return Buffer.from([0xa3, ...text('fmt'), ...text('none'), ...text('attStmt'), 0xa0, ...text('authData'), 0x58, data.length, ...data]).toString('base64url')
}

const BE_CLEAR = 0x45
const ID_A = 'QUFBQQ'
const ID_B = 'QkJCQg'
const ID_C = 'Q0NDQw'

function credResponse (id, prf, inner = {}) {
  return JSON.stringify({
    id,
    rawId: id,
    response: { userHandle: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'), ...inner },
    clientExtensionResults: prf === null ? {} : { prf }
  })
}

const excluded = (entry) => entry.options.excludeCredentials.map((d) => d.id)

test('identity: a passkey bound to one device is NOT_SYNCED, never installed, then excluded', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { MESSAGES } = await import('../src/passkeyOptions.js')
  const seen = fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) }) })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  const err = await id.unlock({ register: true }).catch((e) => e)
  t.is(err.code, 'NOT_SYNCED')
  t.is(err.message, MESSAGES.NOT_SYNCED)
  t.is(err.credentialId, ID_A)
  t.is(err.userId, '03'.repeat(32))
  t.absent(client.methods().includes('identity.install'))
  t.alike(seen[0].options.excludeCredentials, [])
  await id.unlock({ register: true }).catch((e) => e)
  t.alike(excluded(seen[1]), [ID_A])
  const st = await id.status()
  t.is(st.pending, false)
  t.alike(st.refused, [{ userId: '03'.repeat(32), code: 'NOT_SYNCED', cleaned: false, created: true }])
})

test('identity: a malformed PRF output on create is NO_PRF, never pending', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const short = Buffer.from(new Uint8Array(16).fill(7)).toString('base64url')
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: short } }) })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  const err = await id.unlock({ register: true }).catch((e) => e)
  t.is(err.code, 'NO_PRF')
  t.is(err.credentialId, ID_A)
  t.absent(client.methods().includes('identity.install'))
  t.is((await id.status()).pending, false)
  t.is((await id.complete().catch((e) => e)).code, 'CANCELLED', 'nothing pending')
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code]), [[ID_A, 'NO_PRF']])
})

test('identity: pending and refused passkeys survive a restart; a cancelled replacement keeps the pending one', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let next = null
  const seen = fakePasskey({ create: () => next(), get: () => credResponse(ID_B, { results: { first: PRF_B64 } }) })
  const local = memoryLocal()
  const id1 = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  next = () => credResponse(ID_A, { enabled: true })
  t.alike(await id1.unlock({ register: true }), { pending: true })
  next = () => credResponse(ID_B, { enabled: true })
  t.alike(await id1.unlock({ register: true }), { pending: true })
  t.alike(excluded(seen[1]), [ID_A], 'the pending creation is excluded')
  next = () => credResponse(ID_C, { enabled: false })
  t.is((await id1.unlock({ register: true }).catch((e) => e)).code, 'NO_PRF')

  const client = fakeClient()
  const id2 = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  const st = await id2.status()
  t.is(st.pending, true)
  t.alike(st.refused.map((r) => r.code), ['SUPERSEDED', 'NO_PRF'])
  next = () => { const e = new Error('x'); e.code = 'CANCELLED'; throw e }
  t.is((await id2.unlock({ register: true }).catch((e) => e)).code, 'CANCELLED')
  t.alike(excluded(seen[3]).sort(), [ID_A, ID_B, ID_C].sort())
  t.is((await id2.status()).pending, true, 'a cancelled replacement keeps the pending creation')

  t.alike(await id2.complete(), { publicKey: PK, created: true })
  t.alike(seen[4].options.allowCredentials, [{ type: 'public-key', id: ID_B }])
  t.is((await id2.status()).pending, false)
  t.is(local.byRp.get(RP).pending, null)
  t.alike(local.byRp.get(RP).refused.map((r) => r.credentialId), [ID_A, ID_C])
})

test('identity: an immediate PRF creation supersedes the pending one, which stays excluded', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let next = () => credResponse(ID_A, { enabled: true })
  const seen = fakePasskey({ create: () => next() })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  next = () => credResponse(ID_B, { enabled: true, results: { first: PRF_B64 } })
  t.alike(await id.unlock({ register: true }), { publicKey: PK, created: true })
  t.is(client.calls.find((c) => c.method === 'identity.install').params.credentialId, ID_B)
  const st = await id.status()
  t.is(st.pending, false)
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code]), [[ID_A, 'SUPERSEDED']])
  const again = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  next = () => { const e = new Error('x'); e.code = 'CANCELLED'; throw e }
  await again.unlock({ register: true }).catch(() => {})
  t.alike(excluded(seen[2]), [ID_A])
})

test('identity: a create handing back an excluded sign-in passkey refuses it as not created here', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const cases = [
    ['NOT_SYNCED', () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) })],
    ['NO_PRF', () => credResponse(ID_A, { enabled: false })]
  ]
  for (const [code, create] of cases) {
    const seen = fakePasskey({ get: () => credResponse(ID_A, null), create })
    const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
    t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF', code + ': the sign-in passkey has no PRF')
    t.alike((await id.status()).refused.map((r) => [r.code, r.created]), [['NO_PRF', false]])
    const err = await id.unlock({ register: true }).catch((e) => e)
    t.alike(excluded(seen[1]), [ID_A], code + ': the sign-in passkey is excluded')
    t.is(err.code, code)
    t.is(err.created, false, code + ': the error says not created here')
    t.alike((await id.status()).refused.map((r) => [r.code, r.created]), [[code, false]], code + ': never upgraded to created')
  }
})

test('identity: any sign-in skips the bound passkey; NONE keeps its code; a bound sign-in passkey still installs', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { MESSAGES } = await import('../src/passkeyOptions.js')
  let get = () => credResponse(CRED, { results: { first: PRF_B64 } }, { authenticatorData: Buffer.from(authData(BE_CLEAR)).toString('base64url') })
  const seen = fakePasskey({ get: () => get() })
  const bound = fakeClient({ status: { exists: true, publicKey: PK, passkeyKnown: true, credentialId: CRED, rpId: RP } })
  const id = createNativeIdentity({ request: bound.request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
  t.alike(await id.unlock({ any: true }), { publicKey: PK, created: false }, 'BE clear on sign-in still installs')
  t.absent(seen[0].options.allowCredentials)
  get = () => { const e = new Error('native'); e.code = 'NONE'; throw e }
  const err = await id.unlock({}).catch((e) => e)
  t.is(err.code, 'NONE')
  t.is(err.message, MESSAGES.NONE)
  t.alike(seen[1].options.allowCredentials, [{ type: 'public-key', id: CRED }])
  const st = await id.status()
  t.alike(st.refused, [], 'a bound sign-in NONE refuses nothing')
  t.is(st.hybrid, 'unknown')
  t.is(st.platform, 'unknown')
  t.is(st.signal, 'no')
})

test('identity: reset clears the local record, signOut keeps it', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true }) })
  const local = memoryLocal()
  const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  await id.signOut()
  t.is(local.byRp.get(RP).pending.credentialId, ID_A)
  t.is((await id.status()).pending, true)
  await id.reset()
  t.absent(local.byRp.has(RP))
  const st = await id.status()
  t.is(st.pending, false)
  t.alike(st.refused, [])
})

test('passkey local: one file per installation, malformed reads empty, capped', async (t) => {
  resetStubs()
  const { createPasskeyLocal, MAX_REFUSED } = await import('../src/passkeyLocal.native.js')
  const FILE = 'file:///stub/Documents/varanda-passkey-attempts.json'
  const local = createPasskeyLocal()
  t.alike(local.load(RP), { pending: null, refused: [] })
  const userId = 'ab'.repeat(32)
  const refused = []
  for (let i = 0; i < MAX_REFUSED + 3; i++) refused.push({ credentialId: 'id' + i, userId, code: 'NO_PRF', cleaned: true })
  local.save(RP, { pending: { credentialId: ID_A, userId }, refused })
  local.save('other.example', { pending: null, refused: [] })
  const loaded = local.load(RP)
  t.alike(loaded.pending, { credentialId: ID_A, userId })
  t.is(loaded.refused.length, MAX_REFUSED)
  t.is(loaded.refused[0].credentialId, 'id3', 'the oldest go first')
  t.is(loaded.refused[0].cleaned, false)
  t.absent(files().get(FILE).includes('prf'))
  local.clear(RP)
  t.alike(local.load(RP), { pending: null, refused: [] })
  t.ok(JSON.parse(files().get(FILE)).byRp['other.example'], 'other rp.id kept')
  files().set(FILE, '{not json')
  t.alike(local.load('other.example'), { pending: null, refused: [] })
  files().set(FILE, JSON.stringify({ v: 1, byRp: { [RP]: { pending: { credentialId: 'bad id!', userId }, refused: [{ credentialId: ID_A, userId, code: 'NO_PRF' }, 'junk'] } } }))
  t.alike(local.load(RP), { pending: null, refused: [{ credentialId: ID_A, userId, code: 'NO_PRF', cleaned: false, created: false }] }, 'an old entry without created reads as created false')
})

const ATTEMPTS = 'file:///stub/Documents/varanda-passkey-attempts.json'
const ATTEMPTS_TMP = ATTEMPTS + '.tmp'

test('passkey local: a write that fails leaves the previous content', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  const userId = 'ab'.repeat(32)
  const local = createPasskeyLocal()
  local.save(RP, { pending: { credentialId: ID_A, userId }, refused: [] })
  const before = files().get(ATTEMPTS)
  t.absent(files().has(ATTEMPTS_TMP), 'the temporary file was moved into place')
  globalThis.__stubWriteFails = true
  t.exception(() => local.save(RP, { pending: { credentialId: ID_B, userId }, refused: [] }))
  globalThis.__stubWriteFails = false
  t.is(files().get(ATTEMPTS), before)
  t.is(createPasskeyLocal().load(RP).pending.credentialId, ID_A)
  // Deleted original, temporary file not moved yet: the temporary file is read.
  globalThis.__stubMoveFails = true
  t.exception(() => local.save(RP, { pending: { credentialId: ID_C, userId }, refused: [] }))
  globalThis.__stubMoveFails = false
  t.absent(files().has(ATTEMPTS))
  t.is(createPasskeyLocal().load(RP).pending.credentialId, ID_C)
  local.save('other.example', { pending: null, refused: [] })
  t.absent(files().has(ATTEMPTS_TMP))
  t.is(JSON.parse(files().get(ATTEMPTS)).byRp[RP].pending.credentialId, ID_C)
})

test('passkey local: a failed read never drops another rp.id', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  const userId = 'ab'.repeat(32)
  const local = createPasskeyLocal()
  local.save('other.example', { pending: null, refused: [{ credentialId: ID_A, userId, code: 'NO_PRF', created: true }] })
  local.save(RP, { pending: { credentialId: ID_B, userId }, refused: [] })
  const before = files().get(ATTEMPTS)
  globalThis.__stubReadFails = true
  t.is(local.load(RP).pending.credentialId, ID_B, 'the memory copy, not an empty record')
  t.exception(() => local.save(RP, { pending: null, refused: [] }), 'the write is skipped')
  t.is(files().get(ATTEMPTS), before)
  t.is(local.load(RP).pending, null, 'the memory copy has the skipped save')
  t.exception(() => local.clear(RP))
  t.is(files().get(ATTEMPTS), before)
  globalThis.__stubReadFails = false
  t.alike(local.load('other.example').refused.map((r) => [r.credentialId, r.created]), [[ID_A, true]])
  local.clear(RP)
  const doc = JSON.parse(files().get(ATTEMPTS))
  t.absent(doc.byRp[RP], 'clear after a failed read still removes the rp.id')
  t.ok(doc.byRp['other.example'])
})

test('passkey local: an id of length 1 mod 4 is dropped', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  const userId = 'ab'.repeat(32)
  files().set(ATTEMPTS, JSON.stringify({ v: 1, byRp: { [RP]: { pending: { credentialId: 'QUFBQ', userId }, refused: [{ credentialId: 'QUFBQUF', userId, code: 'NO_PRF' }, { credentialId: 'QUFBQ', userId, code: 'NO_PRF' }] } } }))
  t.alike(createPasskeyLocal().load(RP), { pending: null, refused: [{ credentialId: 'QUFBQUF', userId, code: 'NO_PRF', cleaned: false, created: false }] })
})

test('identity: a malformed restored id is dropped, never thrown at the creation', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const seen = fakePasskey({ create: () => credResponse(ID_B, { enabled: true }) })
  const local = memoryLocal()
  local.byRp.set(RP, { pending: { credentialId: 'QUFBQ', userId: '' }, refused: [{ credentialId: 'Q0NDQ', userId: '', code: 'NO_PRF' }, { credentialId: ID_C, userId: '', code: 'NO_PRF' }] })
  const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  t.alike(excluded(seen[0]), [ID_C])
  t.alike(local.byRp.get(RP).refused.map((r) => r.credentialId), [ID_C])
})

test('identity: a sign-in passkey without PRF is refused with created false and excluded next', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let get = () => credResponse(ID_A, null)
  const seen = fakePasskey({ get: () => get(), create: () => { const e = new Error('x'); e.code = 'CANCELLED'; throw e } })
  const client = fakeClient({ status: { exists: true, publicKey: PK, passkeyKnown: true, credentialId: CRED, rpId: RP } })
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF')
  get = () => credResponse(CRED, null)
  t.is((await id.unlock({}).catch((e) => e)).code, 'NO_PRF')
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NO_PRF', false], [CRED, 'NO_PRF', false]])
  t.alike((await id.status()).refused, [{ userId: '01'.repeat(32), code: 'NO_PRF', cleaned: false, created: false }, { userId: '01'.repeat(32), code: 'NO_PRF', cleaned: false, created: false }])
  t.absent(client.methods().some((m) => m === 'identity.install' || m === 'identity.reset' || m === 'identity.forget'), 'the bound record is untouched')
  await id.unlock({ register: true }).catch(() => {})
  t.alike(excluded(seen[2]).sort(), [CRED, ID_A].sort())
})

test('identity: an immediate PRF creation supersedes the pending one only after the install', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let next = () => credResponse(ID_A, { enabled: true })
  fakePasskey({ create: () => next() })
  const local = memoryLocal()
  let duringInstall = null
  const client = fakeClient({
    answers: {
      'identity.install': (params) => {
        duringInstall = local.byRp.get(RP)
        return { publicKey: PK, resumed: params.resumed }
      }
    }
  })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  next = () => credResponse(ID_B, { enabled: true, results: { first: PRF_B64 } })
  t.alike(await id.unlock({ register: true }), { publicKey: PK, created: true })
  t.is(duringInstall.pending.credentialId, ID_A, 'still pending while the install runs')
  t.alike(duringInstall.refused, [])
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'SUPERSEDED', true]])
})

test('identity: a failed install keeps the pending creation and refuses the new passkey', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let next = () => credResponse(ID_A, { enabled: true })
  const seen = fakePasskey({ create: () => next() })
  const local = memoryLocal()
  const client = fakeClient({ answers: { 'identity.install': () => { throw new Error('connection lost') } } })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  next = () => credResponse(ID_B, { enabled: true, results: { first: PRF_B64 } })
  t.is((await id.unlock({ register: true }).catch((e) => e)).message, 'connection lost')
  t.is(local.byRp.get(RP).pending.credentialId, ID_A)
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_B, 'INSTALL_FAILED', true]])
  const st = await id.status()
  t.is(st.pending, true)
  t.alike(st.refused, [{ userId: '03'.repeat(32), code: 'INSTALL_FAILED', cleaned: false, created: true }])
  next = () => { const e = new Error('x'); e.code = 'CANCELLED'; throw e }
  await id.unlock({ register: true }).catch(() => {})
  t.alike(excluded(seen[2]).sort(), [ID_A, ID_B].sort())
})

test('identity: complete with the pending passkey missing refuses it as MISSING', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({
    create: () => credResponse(ID_A, { enabled: true }),
    get: () => { const e = new Error('native'); e.code = 'NONE'; throw e }
  })
  const local = memoryLocal()
  const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  const err = await id.complete().catch((e) => e)
  t.is(err.code, 'WEBAUTHN')
  t.is(err.message, 'a passkey criada não foi encontrada; toque em Criar passkey de novo')
  t.is(local.byRp.get(RP).pending, null)
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'MISSING', true]])
  const st = await id.status()
  t.is(st.pending, false)
  t.alike(st.refused, [{ userId: '03'.repeat(32), code: 'MISSING', cleaned: false, created: true }])
})

test('passkey local: a temporary file left by a write is promoted first; a failed promotion keeps it', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  const userId = 'ab'.repeat(32)
  const local = createPasskeyLocal()
  local.save('other.example', { pending: { credentialId: ID_A, userId }, refused: [] })
  const old = files().get(ATTEMPTS)
  files().set(ATTEMPTS_TMP, old)
  files().delete(ATTEMPTS)
  globalThis.__stubMoveFails = true
  t.exception(() => local.save(RP, { pending: { credentialId: ID_B, userId }, refused: [] }))
  t.exception(() => local.clear('other.example'))
  globalThis.__stubMoveFails = false
  t.is(files().get(ATTEMPTS_TMP), old, 'the temporary file is never replaced while it is the only copy')
  t.absent(files().has(ATTEMPTS))
  t.is(local.load(RP).pending, null, 'the skipped save is not on disk')
  local.save(RP, { pending: { credentialId: ID_B, userId }, refused: [] })
  t.absent(files().has(ATTEMPTS_TMP))
  const doc = JSON.parse(files().get(ATTEMPTS))
  t.is(doc.byRp['other.example'].pending.credentialId, ID_A)
  t.is(doc.byRp[RP].pending.credentialId, ID_B)
})

test('passkey local: a failed read of the temporary file is unreadable, never empty', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  const userId = 'ab'.repeat(32)
  const local = createPasskeyLocal()
  local.save('other.example', { pending: { credentialId: ID_A, userId }, refused: [] })
  files().set(ATTEMPTS_TMP, files().get(ATTEMPTS))
  files().delete(ATTEMPTS)
  globalThis.__stubReadFails = true
  globalThis.__stubMoveFails = true
  t.is(local.load('other.example').pending?.credentialId, ID_A, 'the memory copy, not an empty record')
  globalThis.__stubMoveFails = false
  const tmp = files().get(ATTEMPTS_TMP)
  t.exception(() => local.save(RP, { pending: null, refused: [] }), 'the write is skipped')
  globalThis.__stubReadFails = false
  t.is(files().get(ATTEMPTS) || files().get(ATTEMPTS_TMP), tmp)
  t.is(createPasskeyLocal().load('other.example').pending.credentialId, ID_A)
  files().set(ATTEMPTS, 'garbage')
  t.alike(createPasskeyLocal().load('other.example'), { pending: null, refused: [] }, 'content that does not parse still reads empty')
})

test('identity: reset rejects before any change when the local record cannot be cleared', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true }) })
  const local = memoryLocal()
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  const boom = new Error('disk')
  local.clear = () => { throw boom }
  t.is(await id.reset().catch((e) => e), boom)
  t.absent(client.methods().includes('identity.reset'))
  t.absent(store.log.some((e) => e[0] === 'clear'))
  t.is((await id.status()).pending, true)
  t.is(local.byRp.get(RP).pending.credentialId, ID_A)
})

test('identity: a sign-in with another passkey supersedes the pending creation', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true }), get: () => credResponse(ID_B, { results: { first: PRF_B64 } }) })
  const local = memoryLocal()
  const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  t.alike(await id.unlock({ any: true }), { publicKey: PK, created: false })
  t.is(local.byRp.get(RP).pending, null)
  t.alike(local.byRp.get(RP).refused, [{ credentialId: ID_A, userId: '03'.repeat(32), code: 'SUPERSEDED', cleaned: false, created: true }])
  t.is((await id.status()).pending, false)
})

test('identity: a passkey created here and refused as NOT_SYNCED never signs in', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) }), get: () => get() })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
  const err = await id.unlock({ any: true }).catch((e) => e)
  t.is(err.code, 'NOT_SYNCED')
  t.is(err.credentialId, ID_A)
  t.is(err.userId, '03'.repeat(32))
  t.absent(client.methods().includes('identity.install'))
  get = () => credResponse(ID_B, { results: { first: PRF_B64 } })
  t.alike(await id.unlock({ any: true }), { publicKey: PK, created: false }, 'another passkey still signs in')
})

test('identity: a sign-in NO_PRF of the pending creation is refused as created; created is never downgraded', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let create = () => credResponse(ID_A, { enabled: true })
  let get = () => credResponse(ID_A, null)
  fakePasskey({ create: () => create(), get: () => get() })
  const local = memoryLocal()
  const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.alike(await id.unlock({ register: true }), { pending: true })
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF')
  t.is(local.byRp.get(RP).pending, null)
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NO_PRF', true]])
  create = () => credResponse(ID_B, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) })
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
  get = () => credResponse(ID_B, null)
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF')
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NO_PRF', true], [ID_B, 'NOT_SYNCED', true]], 'a device-bound refusal stays NOT_SYNCED')
  get = () => credResponse(ID_C, null)
  await id.unlock({ any: true }).catch(() => {})
  t.alike(local.byRp.get(RP).refused.at(-1).created, false, 'any other sign-in passkey stays created false')
})

test('identity: a sign-in NO_PRF never downgrades a device-bound refusal; a later PRF still installs nothing', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let get = () => credResponse(ID_A, null)
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) }), get: () => get() })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF')
  t.alike(local.byRp.get(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NOT_SYNCED', true]], 'still refused as bound to one device')
  get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
  const err = await id.unlock({ any: true }).catch((e) => e)
  t.is(err.code, 'NOT_SYNCED', 'once PRF comes back the passkey is still refused')
  t.is(err.credentialId, ID_A)
  t.absent(client.methods().includes('identity.install'), 'nothing installed')
  t.alike((await id.status()).refused.map((r) => [r.code, r.created]), [['NOT_SYNCED', true]])
})

test('identity: a reset while complete waits writes nothing back when the ceremony then fails', async (t) => {
  for (const code of ['NONE', 'NO_PRF']) {
    resetStubs()
    const { createNativeIdentity } = await loadIdentity()
    const gate = deferred()
    fakePasskey({
      create: () => credResponse(ID_A, { enabled: true }),
      get: async () => { await gate.promise; const e = new Error('native'); e.code = code; throw e }
    })
    const local = memoryLocal()
    const id = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
    t.alike(await id.unlock({ register: true }), { pending: true })
    const completing = id.complete().catch((e) => e)
    await new Promise((resolve) => setImmediate(resolve))
    await id.reset()
    t.absent(local.byRp.has(RP), code + ': the reset cleared the local record')
    gate.resolve()
    t.is((await completing).code, code, code + ': the late rejection keeps its code')
    const st = await id.status()
    t.is(st.pending, false)
    t.alike(st.refused, [], code + ': nothing refused after the reset')
    t.absent(local.byRp.has(RP), code + ': nothing written back for this rp.id')
  }
})

// The attempts file of an earlier run: a passkey refused as bound to one
// device (created here) and a pending creation, both for RP.
function seedAttempts () {
  const userId = '03'.repeat(32)
  files().set(ATTEMPTS, JSON.stringify({
    v: 1,
    byRp: {
      [RP]: { pending: { credentialId: ID_B, userId }, refused: [{ credentialId: ID_A, userId, code: 'NOT_SYNCED', cleaned: false, created: true }] },
      'other.example': { pending: null, refused: [] }
    }
  }))
}

test('passkey local: an unreadable file with no earlier read of the rp.id throws, never reads empty', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  seedAttempts()
  const before = files().get(ATTEMPTS)
  globalThis.__stubReadFails = true
  t.exception(() => createPasskeyLocal().load(RP), /unreadable/)
  const local = createPasskeyLocal()
  globalThis.__stubReadFails = false
  t.is(local.load('other.example').pending, null)
  globalThis.__stubReadFails = true
  t.is(local.load(RP).pending.credentialId, ID_B, 'an earlier read holds the rp.id')
  t.exception(() => local.load('third.example'), /unreadable/, 'an rp.id the earlier read did not hold')
  globalThis.__stubReadFails = false
  t.is(files().get(ATTEMPTS), before)
})

test('identity: a failed first read is read again, and its refusals survive the next save', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  seedAttempts()
  let get = null
  const seen = fakePasskey({ create: () => credResponse(ID_C, { enabled: false }), get: () => get() })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local: createPasskeyLocal(), random: deterministicRandom })
  globalThis.__stubReadFails = true
  await id.status()
  globalThis.__stubReadFails = false
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NO_PRF')
  t.alike(excluded(seen[0]).sort(), [ID_A, ID_B].sort(), 'the record was read again before the ceremony')
  const rec = JSON.parse(files().get(ATTEMPTS)).byRp[RP]
  t.is(rec.pending.credentialId, ID_B, 'the old pending creation is kept')
  t.alike(rec.refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NOT_SYNCED', true], [ID_C, 'NO_PRF', true]])
  get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NOT_SYNCED')
  t.absent(client.methods().includes('identity.install'))
})

test('identity: a save after a failed load merges the record on disk first', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  seedAttempts()
  let get = null
  // The read fails at the load before the ceremony and works again by the save.
  fakePasskey({
    create: () => { globalThis.__stubReadFails = false; return credResponse(ID_C, { enabled: false }) },
    get: () => get()
  })
  const client = fakeClient()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local: createPasskeyLocal(), random: deterministicRandom })
  globalThis.__stubReadFails = true
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NO_PRF')
  t.is(globalThis.__stubReadFails, false)
  const rec = JSON.parse(files().get(ATTEMPTS)).byRp[RP]
  t.is(rec.pending.credentialId, ID_B, 'the old pending creation is kept')
  t.alike(rec.refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NOT_SYNCED', true], [ID_C, 'NO_PRF', true]])
  t.ok(JSON.parse(files().get(ATTEMPTS)).byRp['other.example'], 'another rp.id is kept')
  t.is((await id.status()).pending, true)
  get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NOT_SYNCED', 'the merged refusal still refuses')
  t.absent(client.methods().includes('identity.install'))
})

test('identity: reset drops an unreadable attempts file when the store can, else rejects', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  seedAttempts()
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, local: createPasskeyLocal(), random: deterministicRandom })
  globalThis.__stubReadFails = true
  t.alike(await id.reset(), {})
  globalThis.__stubReadFails = false
  t.ok(client.methods().includes('identity.reset'))
  t.ok(store.log.some((e) => e[0] === 'clear'))
  t.absent(files().has(ATTEMPTS), 'the attempts file is gone')
  t.absent(files().has(ATTEMPTS_TMP))
  t.alike((await id.status()).refused, [])

  resetStubs()
  seedAttempts()
  const before = files().get(ATTEMPTS)
  const real = createPasskeyLocal()
  const noDrop = { load: (rpId) => real.load(rpId), save: (rpId, rec) => real.save(rpId, rec), clear: (rpId) => real.clear(rpId) }
  const client2 = fakeClient({ status: { exists: true, publicKey: PK } })
  const store2 = memoryStore()
  const id2 = createNativeIdentity({ request: client2.request, rpId: () => RP, store: store2, local: noDrop, random: deterministicRandom })
  globalThis.__stubReadFails = true
  await t.exception(id2.reset(), /unreadable/)
  globalThis.__stubReadFails = false
  t.absent(client2.methods().includes('identity.reset'))
  t.absent(store2.log.some((e) => e[0] === 'clear'))
  t.is(files().get(ATTEMPTS), before, 'nothing changed')
})

const BE_SET = 0x5d
const credId = (i) => Buffer.from('cred-' + i).toString('base64url')
const bound = (list) => list.filter((r) => r.code === 'NOT_SYNCED' && r.created === true).map((r) => r.credentialId)

test('passkey local: the cap never evicts a device-bound refusal', async (t) => {
  resetStubs()
  const { createPasskeyLocal, MAX_REFUSED } = await import('../src/passkeyLocal.native.js')
  const userId = 'ab'.repeat(32)
  const local = createPasskeyLocal()
  const refused = [{ credentialId: ID_A, userId, code: 'NOT_SYNCED', created: true }]
  for (let i = 0; i < MAX_REFUSED + 3; i++) refused.push({ credentialId: credId(i), userId, code: 'NO_PRF', created: true })
  local.save(RP, { pending: null, refused })
  const loaded = local.load(RP).refused
  t.is(loaded.length, MAX_REFUSED)
  t.is(loaded[0].credentialId, ID_A, 'the bound entry stays, the oldest others go')
  t.is(loaded[1].credentialId, credId(4))
  t.is(loaded.at(-1).credentialId, credId(MAX_REFUSED + 2))

  const many = []
  for (let i = 0; i < MAX_REFUSED + 2; i++) many.push({ credentialId: credId(i), userId, code: 'NOT_SYNCED', created: true })
  many.push({ credentialId: ID_B, userId, code: 'NO_PRF', created: false })
  local.save(RP, { pending: null, refused: many })
  const only = local.load(RP).refused
  t.is(only.length, MAX_REFUSED + 2, 'no bound entry is dropped')
  t.alike(only.map((r) => r.credentialId), many.slice(0, MAX_REFUSED + 2).map((r) => r.credentialId), 'every bound entry stays')
})

test('identity: refusals past the cap never evict a device-bound refusal', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { MAX_REFUSED } = await import('../src/passkeyLocal.native.js')
  let get = null
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) }), get: () => get() })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
  for (let i = 0; i < MAX_REFUSED + 2; i++) {
    get = () => credResponse(credId(i), null)
    t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF')
  }
  t.is(local.byRp.get(RP).refused.length, MAX_REFUSED)
  t.alike(bound(local.byRp.get(RP).refused), [ID_A], 'still on disk')
  get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NOT_SYNCED')
  t.absent(client.methods().includes('identity.install'))
})

test('passkey local: clear with keepBound keeps only the device-bound refusals', async (t) => {
  resetStubs()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  seedAttempts()
  const local = createPasskeyLocal()
  const userId = '03'.repeat(32)
  local.save('other.example', { pending: { credentialId: ID_C, userId }, refused: [{ credentialId: ID_B, userId, code: 'NO_PRF', created: true }] })
  local.clear(RP, { keepBound: true })
  t.alike(local.load(RP), { pending: null, refused: [{ credentialId: ID_A, userId, code: 'NOT_SYNCED', cleaned: false, created: true }] })
  local.clear('other.example', { keepBound: true })
  t.absent(JSON.parse(files().get(ATTEMPTS)).byRp['other.example'], 'an rp.id with no bound entry is removed')
  const before = files().get(ATTEMPTS)
  globalThis.__stubReadFails = true
  t.exception(() => local.clear(RP, { keepBound: true }), /unreadable/)
  t.is(files().get(ATTEMPTS), before, 'a failed read leaves the file intact')
  t.alike(bound(local.load(RP).refused), [ID_A], 'the memory copy keeps the bound entry')
  globalThis.__stubReadFails = false
})

test('identity: reset keeps the device-bound refusals, on disk and after a restart', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
  let create = () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) })
  let get = null
  fakePasskey({ create: () => create(), get: () => get() })
  const client = fakeClient({ status: { exists: true, publicKey: PK } })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local: createPasskeyLocal(), random: deterministicRandom })
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
  create = () => credResponse(ID_B, { enabled: true })
  t.alike(await id.unlock({ register: true }), { pending: true })
  get = () => credResponse(ID_C, null)
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NO_PRF')
  t.alike(await id.reset(), {})
  const rec = createPasskeyLocal().load(RP)
  t.is(rec.pending, null)
  t.alike(rec.refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NOT_SYNCED', true]])
  const st = await id.status()
  t.is(st.pending, false)
  t.alike(st.refused.map((r) => [r.code, r.created]), [['NOT_SYNCED', true]])
  get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
  t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NOT_SYNCED')
  const restarted = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local: createPasskeyLocal(), random: deterministicRandom })
  t.is((await restarted.unlock({ any: true }).catch((e) => e)).code, 'NOT_SYNCED', 'after a restart too')
  t.absent(client.methods().includes('identity.install'))
})

test('identity: a reset that drops an unreadable file writes the bound refusals back, else keeps them in memory', async (t) => {
  for (const writeFails of [false, true]) {
    resetStubs()
    const { createNativeIdentity } = await loadIdentity()
    const { createPasskeyLocal } = await import('../src/passkeyLocal.native.js')
    let get = null
    fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(BE_CLEAR)) }), get: () => get() })
    const client = fakeClient({ status: { exists: true, publicKey: PK } })
    const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local: createPasskeyLocal(), random: deterministicRandom })
    t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
    globalThis.__stubReadFails = true
    globalThis.__stubWriteFails = writeFails
    t.alike(await id.reset(), {})
    globalThis.__stubReadFails = false
    globalThis.__stubWriteFails = false
    t.ok(client.methods().includes('identity.reset'))
    if (writeFails) {
      t.alike(createPasskeyLocal().load(RP).refused, [], 'no usable fresh record when the write fails')
    } else {
      const doc = files().has(ATTEMPTS) ? JSON.parse(files().get(ATTEMPTS)) : { byRp: {} }
      t.alike(Object.keys(doc.byRp), [RP], 'a fresh file with only this rp.id')
      t.alike(createPasskeyLocal().load(RP).refused.map((r) => [r.credentialId, r.code, r.created]), [[ID_A, 'NOT_SYNCED', true]])
    }
    get = () => credResponse(ID_A, { results: { first: PRF_B64 } })
    t.is((await id.unlock({ any: true }).catch((e) => e)).code, 'NOT_SYNCED', 'writeFails ' + writeFails + ': the sign-in guard still applies')
    t.absent(client.methods().includes('identity.install'))
  }
})

test('identity: a creation that returns a device-bound refusal again is refused, entry kept', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let flags = BE_CLEAR
  fakePasskey({ create: () => credResponse(ID_A, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: attestationObject(authData(flags)) }) })
  const client = fakeClient()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local, random: deterministicRandom })
  t.is((await id.unlock({ register: true }).catch((e) => e)).code, 'NOT_SYNCED')
  flags = BE_SET
  const err = await id.unlock({ register: true }).catch((e) => e)
  t.is(err.code, 'NOT_SYNCED')
  t.is(err.credentialId, ID_A)
  t.is(err.userId, '03'.repeat(32))
  t.absent(client.methods().includes('identity.install'), 'never installed')
  t.alike(bound(local.byRp.get(RP).refused), [ID_A], 'the entry stays')
  t.is((await id.status()).pending, false)
})

// A get answer with authenticator data whose flags byte is `flags` (0x05:
// UP and UV) and, as the module always returns, a PRF output.
function verifiedAssertion (id = CRED, flags = 0x05) {
  return credResponse(id, { results: { first: PRF_B64 } }, { authenticatorData: Buffer.from(authData(flags)).toString('base64url'), clientDataJSON: 'e30', signature: 'AQID' })
}

const UNLOCKED = { exists: true, publicKey: PK, unlocked: true, passkeyKnown: true, credentialId: CRED, rpId: RP }

test('identity: a created identity keeps its attestation object for the enrolment; a pending one binds it at concluir', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const att = attestationObject(authData(BE_SET))
  // Direct: the PRF came with the creation.
  fakePasskey({ create: () => credResponse(CRED, { enabled: true, results: { first: PRF_B64 } }, { attestationObject: att }) })
  const client = fakeClient({ status: UNLOCKED })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
  await id.unlock({ register: true })
  t.alike(await id.enrolment(), { credentialId: CRED, attestationObject: att })
  const other = createNativeIdentity({ request: fakeClient({ status: { ...UNLOCKED, publicKey: 'cd'.repeat(32) } }).request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
  t.is(await other.enrolment(), null, 'another identity never sees it')
  const locked = createNativeIdentity({ request: fakeClient().request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
  t.is(await locked.enrolment(), null, 'nothing while locked')
  await id.dropEnrolment()
  t.is(await id.enrolment(), null, 'gone once the service stored it')

  // Pending: kept without a diary key until 'concluir' installs it.
  resetStubs()
  fakePasskey({
    create: () => credResponse(CRED, { enabled: true }, { attestationObject: att }),
    get: () => prfResponse({ results: { first: PRF_B64 } })
  })
  const pendingClient = fakeClient({ status: UNLOCKED })
  const p = createNativeIdentity({ request: pendingClient.request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
  t.alike(await p.unlock({ register: true }), { pending: true })
  t.is(await p.enrolment(), null, 'no diary key named yet')
  await p.complete()
  t.alike(await p.enrolment(), { credentialId: CRED, attestationObject: att })
  await p.reset().catch(() => {})
  t.is(await p.enrolment(), null, 'recomeçar forgets it')
})

test('identity: confirm checks the bound passkey with user verification and changes nothing', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const seen = fakePasskey({ get: () => verifiedAssertion() })
  const client = fakeClient({ status: UNLOCKED })
  const store = memoryStore()
  const local = memoryLocal()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, local, random: deterministicRandom })
  const before = await id.status()
  client.calls.length = 0
  const nonce = Buffer.alloc(32, 0x42).toString('base64url')
  const confirmed = await id.confirm({ challenge: nonce })
  t.alike(confirmed, { ok: true, assertion: { credentialId: CRED, clientDataJSON: 'e30', authenticatorData: Buffer.from(authData(0x05)).toString('base64url'), signature: 'AQID' } }, 'the assertion the account service verifies, no extension results')
  t.is(seen[0].options.challenge, nonce, 'the account service nonce is the challenge')
  t.is(seen.length, 1)
  t.is(seen[0].kind, 'get')
  t.is(seen[0].options.rpId, RP)
  t.is(seen[0].options.userVerification, 'required')
  t.alike(seen[0].options.allowCredentials, [{ type: 'public-key', id: CRED }], 'restricted to the bound passkey')
  t.alike(client.methods(), ['identity.status'], 'no install, clear, forget or sessionSaved')
  t.is(store.log.length, 0, 'no session save or clear')
  t.is(local.byRp.size, 0, 'no attempts record written')
  t.alike(await id.status(), before, 'the status is unchanged')
  t.is((await id.confirm()).ok, true, 'a second check runs once the first settled')
  t.is((await id.confirm({ challenge: 'abc' }).catch((e) => e)).code, 'USAGE', 'a bad challenge')
  t.is(seen.length, 2, 'runs no ceremony')

  // No bound record: refused, never a discoverable get any passkey could answer.
  const unbound = fakeClient({ status: { ...UNLOCKED, credentialId: null, rpId: null } })
  const seenFree = fakePasskey({ get: () => verifiedAssertion(ID_A) })
  const free = createNativeIdentity({ request: unbound.request, rpId: () => RP, store: memoryStore(), local: memoryLocal(), random: deterministicRandom })
  const err = await free.confirm().catch((e) => e)
  t.is(err.code, 'NONE')
  t.is(err.message, 'nenhuma passkey ligada a esta sessão: entre de novo com a passkey')
  t.is(seenFree.length, 0, 'no ceremony without a bound record')
})

test('identity: confirm is LOCKED while locked, maps CANCELLED, MISMATCH, no UV and UNSUPPORTED', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  const { MESSAGES } = await import('../src/passkeyOptions.js')
  let answer = () => verifiedAssertion()
  const seen = fakePasskey({ get: () => answer() })
  const store = memoryStore()

  const lockedClient = fakeClient({ status: { ...UNLOCKED, unlocked: false } })
  const locked = createNativeIdentity({ request: lockedClient.request, rpId: () => RP, store, random: deterministicRandom })
  const lockedErr = await locked.confirm().catch((e) => e)
  t.is(lockedErr.code, 'LOCKED')
  t.is(lockedErr.message, 'identidade bloqueada: entre com a passkey')
  t.is(seen.length, 0, 'no ceremony while locked')

  const client = fakeClient({ status: UNLOCKED })
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, random: deterministicRandom })
  const failing = (code) => () => { const e = new Error('native text'); e.code = code; throw e }
  for (const [code, expected] of [['CANCELLED', 'CANCELLED'], ['UNSUPPORTED', 'UNSUPPORTED'], ['whatever', 'WEBAUTHN']]) {
    answer = failing(code)
    const err = await id.confirm().catch((e) => e)
    t.is(err.code, expected)
    t.is(err.message, MESSAGES[expected])
  }
  answer = () => verifiedAssertion(ID_B)
  const mismatch = await id.confirm().catch((e) => e)
  t.is(mismatch.code, 'MISMATCH', 'another passkey is refused')
  t.is(mismatch.message, 'passkey não corresponde ao diário guardado')
  answer = () => verifiedAssertion(CRED, 0x01)
  const unverified = await id.confirm().catch((e) => e)
  t.is(unverified.code, 'WEBAUTHN', 'an answer without the UV flag is refused')
  answer = () => credResponse(CRED, { results: { first: PRF_B64 } })
  t.is((await id.confirm().catch((e) => e)).code, 'WEBAUTHN', 'no authenticator data is refused')
  t.absent(client.methods().some((m) => m !== 'identity.status'), 'only the status was read')
  t.is(store.log.length, 0)

  const none = createNativeIdentity({ request: client.request, rpId: () => null, store, random: deterministicRandom })
  t.is((await none.confirm().catch((e) => e)).code, 'UNSUPPORTED')
})

test('identity: confirm is one ceremony at a time; lock and signOut cancel it', async (t) => {
  resetStubs()
  const { createNativeIdentity } = await loadIdentity()
  let hold = null
  fakePasskey({
    get: async () => {
      if (hold !== null) await hold.promise
      return verifiedAssertion()
    }
  })
  const client = fakeClient({ status: UNLOCKED })
  const store = memoryStore()
  const id = createNativeIdentity({ request: client.request, rpId: () => RP, store, local: memoryLocal(), random: deterministicRandom })

  hold = deferred()
  const first = id.confirm()
  await new Promise((resolve) => setImmediate(resolve))
  const second = await id.confirm().catch((e) => e)
  t.is(second.code, 'LOCKED', 'a second confirm waits its turn')
  t.is(second.message, 'outra entrada com a passkey em andamento')
  t.is((await id.unlock({}).catch((e) => e)).code, 'LOCKED', 'so does an unlock')
  hold.resolve()
  t.is((await first).ok, true)

  hold = deferred()
  const unlocking = id.unlock({}).catch((e) => e)
  await new Promise((resolve) => setImmediate(resolve))
  t.is((await id.confirm().catch((e) => e)).code, 'LOCKED', 'an unlock in flight refuses a confirm')
  hold.resolve()
  await unlocking

  hold = deferred()
  const locking = id.confirm().catch((e) => e)
  await new Promise((resolve) => setImmediate(resolve))
  await id.lock()
  hold.resolve()
  const cancelled = await locking
  t.is(cancelled.code, 'CANCELLED', 'a lock cancels it')
  t.is(cancelled.message, 'entrada com a passkey cancelada')

  hold = deferred()
  const leaving = id.confirm().catch((e) => e)
  await new Promise((resolve) => setImmediate(resolve))
  await id.signOut()
  hold.resolve()
  t.is((await leaving).code, 'CANCELLED', 'Sair cancels it')
  const installs = client.methods().filter((m) => m === 'identity.install').length
  t.is(installs, 1, 'only the unlock installed')
})
