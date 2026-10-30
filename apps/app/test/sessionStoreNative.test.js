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
const hooks = `
const stubs = {
  'expo-secure-store': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(secureStore)}),
  '../modules/passkey-prf': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(passkeyPrf)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (specifier === './sessionStore' && context.parentURL && context.parentURL.includes('/src/')) {
    return next('./sessionStore.native.js', context)
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
function resetStubs () {
  if (items()) items().clear()
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
    clear: async () => { log.push(['clear']); if (clearFails) throw new Error('nope') }
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
