'use strict'

// src/identity.native.js recovery surface (docs/rpc.md 5.91 to 5.94): marked
// passkeys, recovery codes, add and bind, over a fake worklet that keeps the
// state identity-install.js keeps. The module stubs are those of
// sessionStoreNative.test.js.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const secureStore = `
const items = globalThis.__secureItems = globalThis.__secureItems || new Map()
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'wutdo'
export async function getItemAsync (key) { return items.has(key) ? items.get(key) : null }
export async function setItemAsync (key, value) { items.set(key, value) }
export async function deleteItemAsync (key) { items.delete(key) }
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
  write (text) { files.set(this.uri, String(text)) }
  textSync () { if (!files.has(this.uri)) throw new Error('missing'); return files.get(this.uri) }
  delete () { if (!files.has(this.uri)) throw new Error('missing'); files.delete(this.uri) }
  copy (dest) { if (!files.has(this.uri) || files.has(dest.uri)) throw new Error('cannot copy'); files.set(dest.uri, files.get(this.uri)) }
  move (dest) {
    if (!files.has(this.uri) || files.has(dest.uri)) throw new Error('cannot move')
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

const RP = 'varanda.example'
const ROOT_HEX = 'cd'.repeat(32)
const NEW_PRF_HEX = 'ef'.repeat(32)
const OTHER_PRF_HEX = '12'.repeat(32)
const ORIG = 'b3JpZw'
const MARKED = 'bWFya2Vk'
const FRESH = 'ZnJlc2g'
const LOOKUP = '77'.repeat(32)
const GOOD_CODE = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-JJJJ'
const BAD_ENTRY = 'entrada de recuperação inválida'
const MARK = '766172616e64612d777261702d76310a'
const MARKED_ID = '09'.repeat(16) + MARK
const PLAIN_ID = '01'.repeat(32)

const pkOf = (prf) => 'a0' + prf.slice(2)
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64url')
const EPOCH = 'file:///stub/Documents/varanda-keychain-epoch'

function resetStubs () {
  if (globalThis.__secureItems) globalThis.__secureItems.clear()
  globalThis.__stubFiles = globalThis.__stubFiles || new Map()
  globalThis.__stubFiles.clear()
  globalThis.__stubFiles.set(EPOCH, '1')
  globalThis.__passkey = null
}

const loadIdentity = () => import('../src/identity.native.js')

function rpcError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// The worklet side: a diary key, the bound kv record, the root, the lookups.
function fakeWorklet ({ diary = null, credentialId = null, userId = null, openAs = ROOT_HEX } = {}) {
  const w = { exists: diary !== null, publicKey: diary, unlocked: false, credentialId, rpId: credentialId !== null ? RP : null, userId, root: null, calls: [], openGate: null, wrapGate: null, wrapFail: false }
  w.request = async (method, params) => {
    w.calls.push({ method, params })
    switch (method) {
      case 'identity.status':
        return { exists: w.exists, publicKey: w.publicKey, legacy: false, unlocked: w.unlocked, synced: false, resumed: false, passkeyKnown: w.credentialId !== null, credentialId: w.credentialId, rpId: w.rpId, userId: w.userId, signedOut: false }
      case 'identity.install': {
        const pk = pkOf(params.prf)
        if (w.exists && w.publicKey !== pk) throw rpcError('USAGE', 'passkey não corresponde ao diário guardado')
        w.exists = true
        w.publicKey = pk
        w.unlocked = true
        w.root = params.prf
        if (!params.resumed) {
          w.credentialId = params.credentialId
          w.rpId = params.rpId
          w.userId = params.userId === '' ? null : params.userId
        }
        return { publicKey: pk, resumed: params.resumed }
      }
      case 'identity.clear':
      case 'identity.forget':
        w.unlocked = false
        w.root = null
        return {}
      case 'identity.recoveryLookup':
        if (params.kind === 'code' && params.code !== GOOD_CODE) throw rpcError('USAGE', 'código de recuperação inválido')
        return { lookupId: LOOKUP }
      case 'identity.recoveryOpen':
        if (w.openGate) await w.openGate
        if (!params.blob || params.blob.ok !== true) throw rpcError('USAGE', BAD_ENTRY)
        return { prf: openAs }
      case 'identity.recoveryWrap':
        if (w.wrapGate) await w.wrapGate
        if (w.wrapFail) throw rpcError('USAGE', 'falha ao embrulhar')
        if (!w.unlocked) throw rpcError('USAGE', 'identidade bloqueada: entre com a passkey')
        return params.kind === 'code'
          ? { lookupId: '88'.repeat(32), blob: { v: 1, kind: 'code' }, code: GOOD_CODE }
          : { lookupId: '99'.repeat(32), blob: { v: 1, kind: 'passkey', under: params.secret } }
      case 'identity.recoveryBind':
        if (!w.unlocked) throw rpcError('USAGE', 'identidade bloqueada: entre com a passkey')
        if (typeof params.userId !== 'string' || !/^[0-9a-f]{64}$/.test(params.userId) || !params.userId.endsWith(MARK)) throw rpcError('USAGE', 'passkey de recuperação inválida')
        w.credentialId = params.credentialId
        w.userId = params.userId === '' ? null : params.userId
        return {}
      default:
        return {}
    }
  }
  w.methods = () => w.calls.map((c) => c.method)
  return w
}

function assertion (credentialId, prfHex, handleHex) {
  return JSON.stringify({
    id: credentialId,
    rawId: credentialId,
    response: handleHex === null ? {} : { userHandle: b64(handleHex) },
    clientExtensionResults: { prf: { results: { first: b64(prfHex) } } }
  })
}

function creation (credentialId, prfHex) {
  return JSON.stringify({
    id: credentialId,
    rawId: credentialId,
    response: {},
    clientExtensionResults: prfHex === null ? { prf: { enabled: true } } : { prf: { enabled: true, results: { first: b64(prfHex) } } }
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

function memoryStore () {
  const log = []
  let rec = null
  return {
    log,
    save: async (r) => { log.push(['save', r]); rec = { ...r } },
    load: async ({ rpId, publicKey }) => rec !== null && rec.rpId === rpId && rec.publicKey === publicKey ? { credentialId: rec.credentialId, prfHex: rec.prfHex } : null,
    clear: async () => { log.push(['clear']); rec = null },
    clearAll: async () => { log.push(['clearAll']); rec = null }
  }
}

function memoryLocal () {
  const byRp = new Map()
  return {
    byRp,
    load: async (rp) => byRp.get(rp) || null,
    save: async (rp, rec) => { byRp.set(rp, JSON.parse(JSON.stringify(rec))) },
    clear: async (rp) => { byRp.delete(rp) }
  }
}

const random = (n) => new Uint8Array(n).fill(9)

async function makeIdentity (w, extra = {}) {
  const { createNativeIdentity } = await loadIdentity()
  const store = extra.store || memoryStore()
  const id = createNativeIdentity({ request: w.request, rpId: () => RP, store, local: extra.local || memoryLocal(), random, ...extra })
  return { id, store }
}

test('mark: the duplicated constant matches web-member and only the last 16 bytes count', async (t) => {
  const { WRAP_MARK_HEX, UNKNOWN_WRAP_USER_ID, isWrapUserId } = await loadIdentity()
  t.is(UNKNOWN_WRAP_USER_ID, '00'.repeat(16) + MARK)
  t.ok(isWrapUserId(UNKNOWN_WRAP_USER_ID))
  const recovery = require('@varanda/web-member/lib/recovery')
  t.is(WRAP_MARK_HEX, Buffer.from(recovery.WRAP_MARK).toString('hex'))
  t.ok(isWrapUserId(MARKED_ID))
  t.is(recovery.isWrapUserId(MARKED_ID), true)
  t.absent(isWrapUserId(MARK + '09'.repeat(16)), 'the mark first is not marked')
  t.absent(isWrapUserId(PLAIN_ID))
  t.absent(isWrapUserId(MARK))
  t.absent(isWrapUserId(''))
})

test('marked sign-in: lookup first, never installs the ceremony PRF, then installs the root', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  const { id, store } = await makeIdentity(w)
  const out = await id.unlock({ any: true })
  t.alike(out, { wrapped: true, lookupId: LOOKUP })
  t.absent(w.methods().includes('identity.install'), 'nothing installed before recoveryOpen')
  const lookup = w.calls.find((c) => c.method === 'identity.recoveryLookup')
  t.alike(lookup.params, { kind: 'passkey', secret: NEW_PRF_HEX })

  const opened = await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  t.alike(opened, { publicKey: pkOf(ROOT_HEX), created: false })
  const m = w.methods()
  t.ok(m.indexOf('identity.recoveryOpen') < m.indexOf('identity.install'))
  const install = w.calls.find((c) => c.method === 'identity.install')
  t.is(install.params.prf, ROOT_HEX, 'the root, never the ceremony PRF')
  t.is(install.params.credentialId, MARKED)
  t.is(install.params.userId, MARKED_ID)
  t.is(store.log[0][1].prfHex, ROOT_HEX, 'the stored session holds the root')
  t.ok(m.includes('identity.sessionSaved'))
  t.absent(w.calls.some((c) => c.method === 'identity.install' && c.params.prf === NEW_PRF_HEX))
})

test('marked sign-in: the bound passkey without a handle is checked with status userId', async (t) => {
  resetStubs()
  const seen = fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, null) })
  const w = fakeWorklet({ diary: pkOf(ROOT_HEX), credentialId: MARKED, userId: MARKED_ID })
  const { id } = await makeIdentity(w)
  t.alike(await id.unlock({}), { wrapped: true, lookupId: LOOKUP })
  t.alike(seen[0].options.allowCredentials.map((c) => c.id), [MARKED])
  t.absent(w.methods().includes('identity.install'))
})

test('ordinary sign-in: installs the ceremony PRF and never calls recoveryLookup', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID) })
  const w = fakeWorklet()
  const { id, store } = await makeIdentity(w)
  t.alike(await id.unlock({ any: true }), { publicKey: pkOf(ROOT_HEX), created: false })
  t.absent(w.methods().includes('identity.recoveryLookup'))
  t.is(store.log[0][1].prfHex, ROOT_HEX)

  // The bound passkey with no handle stays the direct path too.
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, null) })
  await id.lock()
  const { id: again } = await makeIdentity(w)
  t.alike(await again.unlock({}), { publicKey: pkOf(ROOT_HEX), created: false })
  t.absent(w.methods().includes('identity.recoveryLookup'))
})

test('cancel after the lookup installs nothing and a later open is refused', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  const { id, store } = await makeIdentity(w)
  await id.unlock({ any: true })
  id.cancelRecovery()
  const err = await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }).catch((e) => e)
  t.is(err.code, 'RECOVERY_BAD')
  t.absent(w.methods().includes('identity.install'))
  t.absent(w.methods().includes('identity.recoveryOpen'))
  t.is(store.log.length, 0)
  t.is(w.exists, false, 'a marked credential with no blob never creates a diary')
})

test('a blob that does not open rejects RECOVERY_BAD and stays locked', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  await id.unlock({ any: true })
  const err = await id.unlockWrapped({ blob: { ok: false }, member: pkOf(ROOT_HEX) }).catch((e) => e)
  t.is(err.code, 'RECOVERY_BAD')
  t.is(err.message, BAD_ENTRY)
  t.absent(w.methods().includes('identity.install'))
  t.is((await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }).catch((e) => e)).code, 'RECOVERY_BAD', 'the wait is consumed')
})

test('no handle and not known: installs directly, no lookup and no fetch', async (t) => {
  resetStubs()
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => { fetched++; throw new Error('no network in this test') }
  try {
    fakePasskey({ get: () => assertion(ORIG, OTHER_PRF_HEX, null) })
    const w = fakeWorklet()
    const { id } = await makeIdentity(w)
    t.alike(await id.unlock({ any: true }), { publicKey: pkOf(OTHER_PRF_HEX), created: false })
    t.absent(w.methods().includes('identity.recoveryLookup'), 'its PRF never leaves for a lookup id')
    const install = w.calls.find((c) => c.method === 'identity.install')
    t.is(install.params.prf, OTHER_PRF_HEX)
    t.is(install.params.userId, '')
    t.is(fetched, 0)
    const err = await id.unlockDirect().catch((e) => e)
    t.is(err.code, 'USAGE', 'no direct install after a lookup exists any more')
    t.is(w.calls.filter((c) => c.method === 'identity.install').length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('code: a bad code keeps its text; a good one needs a passkey, then installs the root', async (t) => {
  resetStubs()
  const seen = fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const { id, store } = await makeIdentity(w)
  const bad = await id.unlockWithCode({ code: 'nope' }).catch((e) => e)
  t.is(bad.message, 'código de recuperação inválido')

  t.alike(await id.unlockWithCode({ code: GOOD_CODE }), { wrapped: true, lookupId: LOOKUP })
  const lookup = w.calls.filter((c) => c.method === 'identity.recoveryLookup').pop()
  t.alike(lookup.params, { kind: 'code', code: GOOD_CODE })
  t.alike(await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }), { needsPasskey: true })
  t.absent(w.methods().includes('identity.install'), 'nothing installed before the new passkey')

  const out = await id.finishRecovery()
  t.is(seen[0].kind, 'create')
  const userHex = Buffer.from(seen[0].options.user.id, 'base64url').toString('hex')
  t.is(userHex, MARKED_ID, 'a marked user id')
  t.is(out.credentialId, FRESH)
  t.is(out.userId, MARKED_ID)
  t.is(out.lookupId, '99'.repeat(32))
  t.alike(out.blob, { v: 1, kind: 'passkey', under: NEW_PRF_HEX })
  t.is(out.publicKey, pkOf(ROOT_HEX))
  const install = w.calls.find((c) => c.method === 'identity.install')
  t.alike(install.params, { prf: ROOT_HEX, credentialId: FRESH, userId: MARKED_ID, rpId: RP, resumed: false })
  t.is(store.log[0][1].prfHex, ROOT_HEX, 'the session holds the root, not the new PRF')
  t.is(store.log[0][1].credentialId, FRESH)
  t.absent(w.calls.some((c) => c.method === 'identity.install' && c.params.prf === NEW_PRF_HEX))
})

test('code: a pending creation finishes through complete() with the held root', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(FRESH, null), get: () => assertion(FRESH, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  await id.unlockWithCode({ code: GOOD_CODE })
  await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  t.alike(await id.finishRecovery(), { pending: true })
  const out = await id.complete()
  t.is(out.credentialId, FRESH)
  t.is(out.publicKey, pkOf(ROOT_HEX))
  const install = w.calls.find((c) => c.method === 'identity.install')
  t.is(install.params.prf, ROOT_HEX)
})

test('code: finishRecovery after the hold expired creates nothing', async (t) => {
  resetStubs()
  const seen = fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  let clock = 1000
  const w = fakeWorklet()
  const { id } = await makeIdentity(w, { now: () => clock })
  await id.unlockWithCode({ code: GOOD_CODE })
  await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  clock += 121 * 1000
  t.is((await id.finishRecovery().catch((e) => e)).code, 'RECOVERY_BAD')
  t.is(seen.length, 0)
  t.absent(w.methods().includes('identity.install'))
})

test('add: a marked passkey that excludes the bound one, wraps the root, installs nothing', async (t) => {
  resetStubs()
  const seen = fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID), create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  await id.unlock({ any: true })
  const installs = () => w.calls.filter((c) => c.method === 'identity.install').length
  t.is(installs(), 1)
  const out = await id.addPasskey()
  t.alike(out, { credentialId: FRESH, userId: MARKED_ID, lookupId: '99'.repeat(32), blob: { v: 1, kind: 'passkey', under: NEW_PRF_HEX } })
  const create = seen.find((s) => s.kind === 'create')
  t.alike(create.options.excludeCredentials.map((c) => c.id), [ORIG])
  t.is(Buffer.from(create.options.user.id, 'base64url').toString('hex'), MARKED_ID)
  t.is(installs(), 1, 'the session stays the original one')
  t.is(w.credentialId, ORIG)
})

test('add: a pending creation returns the add result from complete()', async (t) => {
  resetStubs()
  let getCred = ORIG
  fakePasskey({
    get: () => getCred === ORIG ? assertion(ORIG, ROOT_HEX, PLAIN_ID) : assertion(FRESH, NEW_PRF_HEX, MARKED_ID),
    create: () => creation(FRESH, null)
  })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  await id.unlock({ any: true })
  t.alike(await id.addPasskey(), { pending: true })
  getCred = FRESH
  const out = await id.complete()
  t.alike(out, { credentialId: FRESH, userId: MARKED_ID, lookupId: '99'.repeat(32), blob: { v: 1, kind: 'passkey', under: NEW_PRF_HEX } })
  t.is(w.calls.filter((c) => c.method === 'identity.install').length, 1)
})

test('add while locked reports the passkey the manager stored', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  const err = await id.addPasskey().catch((e) => e)
  t.is(err.message, 'identidade bloqueada: entre com a passkey')
  t.is(err.credentialId, FRESH)
  t.absent(w.methods().includes('identity.install'))
})

test('bind then restart: the allow list names the new passkey and the session resumes', async (t) => {
  resetStubs()
  const { createSessionStore } = await import('../src/sessionStore.native.js')
  const store = createSessionStore()
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID), create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const local = memoryLocal()
  const { id } = await makeIdentity(w, { store, local })
  await id.unlock({ any: true })
  const added = await id.addPasskey()
  t.alike(await id.bindPasskey({ credentialId: added.credentialId, userId: added.userId }), {})
  t.alike(w.calls.find((c) => c.method === 'identity.recoveryBind').params, { credentialId: FRESH, userId: MARKED_ID })
  t.alike(await store.load({ rpId: RP, publicKey: pkOf(ROOT_HEX) }), { credentialId: FRESH, prfHex: ROOT_HEX }, 'the old item replaced, root kept')

  // Restart: the worklet starts locked; the stored session resumes.
  w.unlocked = false
  w.root = null
  const { id: next } = await makeIdentity(w, { store, local })
  await next.resume()
  const resumed = w.calls.filter((c) => c.method === 'identity.install').pop()
  t.alike(resumed.params, { prf: ROOT_HEX, credentialId: FRESH, userId: '', rpId: RP, resumed: true })
  t.ok(w.unlocked)

  // The next ceremony offers only the new passkey (marked: wrapped flow).
  const seen = fakePasskey({ get: () => assertion(FRESH, NEW_PRF_HEX, null) })
  await next.lock()
  t.alike(await next.unlock({}), { wrapped: true, lookupId: LOOKUP })
  t.alike(seen[0].options.allowCredentials.map((c) => c.id), [FRESH])
})

test('bind without a stored session changes only the binding', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID) })
  const w = fakeWorklet()
  const store = memoryStore()
  store.save = async (r) => { store.log.push(['save', r]); throw new Error('keychain') }
  const { id } = await makeIdentity(w, { store })
  await id.unlock({ any: true })
  t.alike(await id.bindPasskey({ credentialId: FRESH, userId: MARKED_ID }), { sessionSaved: false })
  t.is(w.credentialId, FRESH)
  t.is(store.log.length, 1, 'only the failed first save')
})

test('makeRecoveryCode returns the code only in its result', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  await id.unlock({ any: true })
  t.alike(await id.makeRecoveryCode(), { code: GOOD_CODE, lookupId: '88'.repeat(32), blob: { v: 1, kind: 'code' } })
  t.alike(w.calls.find((c) => c.method === 'identity.recoveryWrap').params, { kind: 'code' })
})

test('a late open after signOut is dropped: nothing installed', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  let release
  w.openGate = new Promise((resolve) => { release = resolve })
  const { id } = await makeIdentity(w)
  await id.unlock({ any: true })
  const opening = id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }).catch((e) => e)
  await new Promise((resolve) => setImmediate(resolve))
  const out = id.signOut()
  release()
  t.is((await opening).code, 'CANCELLED')
  await out
  t.absent(w.methods().includes('identity.install'))
})

test('iOS without the module: the recovery entries surface UNSUPPORTED', async (t) => {
  resetStubs()
  globalThis.__passkey = { isAvailable: () => false }
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  t.is((await id.addPasskey().catch((e) => e)).code, 'UNSUPPORTED')
  t.is((await id.unlockWithCode({ code: GOOD_CODE }).catch((e) => e)).code, 'UNSUPPORTED')
})

test('no handle, credential refused with a marked user id: wrapped, then bound marked', async (t) => {
  resetStubs()
  const local = memoryLocal()
  // An abandoned add: its creation was superseded and kept refused.
  local.byRp.set(RP, { pending: null, refused: [{ credentialId: MARKED, userId: MARKED_ID, code: 'SUPERSEDED', cleaned: false, created: true }] })
  fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, null) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w, { local })
  t.alike(await id.unlock({ any: true }), { wrapped: true, lookupId: LOOKUP })
  t.absent(w.methods().includes('identity.install'), 'its PRF is never a diary key')
  const lookup = w.calls.find((c) => c.method === 'identity.recoveryLookup')
  t.alike(lookup.params, { kind: 'passkey', secret: NEW_PRF_HEX })
  t.alike(await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }), { publicKey: pkOf(ROOT_HEX), created: false })
  const install = w.calls.find((c) => c.method === 'identity.install')
  t.is(install.params.prf, ROOT_HEX)
  t.is(install.params.userId, MARKED_ID, 'bound with the marked user id it was refused with')
  t.is(w.userId, MARKED_ID)

  await id.signOut()
  const seen = fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, null) })
  t.alike(await id.unlock({}).catch((e) => e.code), { wrapped: true, lookupId: LOOKUP }, 'the bound record keeps it wrapped')
  t.alike(seen[0].options.allowCredentials.map((c) => c.id), [MARKED])
  t.absent(w.calls.some((c) => c.method === 'identity.install' && c.params.prf === NEW_PRF_HEX), 'the passkey PRF is never a diary key')
  t.is(w.calls.filter((c) => c.method === 'identity.install').length, 1)
})

test('no handle, refused with an unmarked user id: installs directly', async (t) => {
  resetStubs()
  const local = memoryLocal()
  local.byRp.set(RP, { pending: null, refused: [{ credentialId: ORIG, userId: PLAIN_ID, code: 'SUPERSEDED', cleaned: false, created: true }] })
  fakePasskey({ get: () => assertion(ORIG, OTHER_PRF_HEX, null) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w, { local })
  t.alike(await id.unlock({ any: true }), { publicKey: pkOf(OTHER_PRF_HEX), created: false })
  t.absent(w.methods().includes('identity.recoveryLookup'))
})

test('bindPasskey refuses an empty or unmarked user id before asking the worklet', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  await id.unlock({ any: true })
  for (const userId of [undefined, '', PLAIN_ID, MARK + '09'.repeat(16)]) {
    const err = await id.bindPasskey({ credentialId: FRESH, userId }).catch((e) => e)
    t.is(err.code, 'USAGE', String(userId))
  }
  t.absent(w.methods().includes('identity.recoveryBind'))
  t.is(w.credentialId, ORIG)
})

test('code: a stored diary of another identity is refused MISMATCH before any ceremony', async (t) => {
  resetStubs()
  const seen = fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet({ diary: pkOf(OTHER_PRF_HEX), credentialId: ORIG, userId: PLAIN_ID })
  const { id } = await makeIdentity(w)
  await id.unlockWithCode({ code: GOOD_CODE })
  t.alike(await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }), { needsPasskey: true })
  const err = await id.finishRecovery().catch((e) => e)
  t.is(err.code, 'MISMATCH')
  t.is(seen.length, 0, 'no passkey created')
  t.absent(w.methods().includes('identity.install'))
  t.is((await id.finishRecovery().catch((e) => e)).code, 'RECOVERY_BAD', 'the held root is dropped')
})

test('complete: a marked pending creation with no held root and locked is refused and cleared', async (t) => {
  resetStubs()
  const seen = fakePasskey({ get: () => assertion(FRESH, NEW_PRF_HEX, MARKED_ID) })
  const local = memoryLocal()
  // A restart: the pending creation survived, the held root did not. Kept
  // pending, it would hide the code entry behind a 'concluir' that cannot
  // finish, so it is refused SUPERSEDED and the person can start over.
  local.byRp.set(RP, { pending: { credentialId: FRESH, userId: MARKED_ID }, refused: [] })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w, { local })
  const err = await id.complete().catch((e) => e)
  t.is(err.code, 'RECOVERY_BAD')
  t.is(err.message, 'essa passkey não pôde ser concluída: entre com a sua passkey ou com o código de recuperação')
  t.is(seen.length, 0, 'no ceremony')
  t.absent(w.methods().includes('identity.recoveryWrap'))
  t.absent(w.methods().includes('identity.install'))
  const rec = local.byRp.get(RP)
  t.is(rec.pending, null, 'the pending creation cleared on disk')
  t.alike(rec.refused.map((r) => ({ credentialId: r.credentialId, code: r.code, cleaned: r.cleaned, created: r.created })), [{ credentialId: FRESH, code: 'SUPERSEDED', cleaned: false, created: true }])
  const st = await id.status()
  t.is(st.pending, false)
  t.alike(st.refused.map((r) => r.code), ['SUPERSEDED'])
  t.is((await id.complete().catch((e) => e)).code, 'CANCELLED', 'nothing left to complete')

  // Unlocked, the same pending creation is an add.
  resetStubs()
  fakePasskey({ get: () => assertion(FRESH, NEW_PRF_HEX, MARKED_ID) })
  const local2 = memoryLocal()
  local2.byRp.set(RP, { pending: { credentialId: FRESH, userId: MARKED_ID }, refused: [] })
  const w2 = fakeWorklet({ diary: pkOf(ROOT_HEX), credentialId: ORIG, userId: PLAIN_ID })
  w2.unlocked = true
  const { id: id2 } = await makeIdentity(w2, { local: local2 })
  const out = await id2.complete()
  t.alike(out, { credentialId: FRESH, userId: MARKED_ID, lookupId: '99'.repeat(32), blob: { v: 1, kind: 'passkey', under: NEW_PRF_HEX } })
})

test('code: cancelRecovery after a pending finishRecovery refuses that creation', async (t) => {
  resetStubs()
  const seen = fakePasskey({ create: () => creation(FRESH, null), get: () => assertion(FRESH, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  const local = memoryLocal()
  const { id } = await makeIdentity(w, { local })
  await id.unlockWithCode({ code: GOOD_CODE })
  t.alike(await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }), { needsPasskey: true })
  t.alike(await id.finishRecovery(), { pending: true })
  t.is((await id.status()).pending, true)
  t.alike(await id.cancelRecovery(), {})
  const st = await id.status()
  t.is(st.pending, false, 'concluir no longer shows, the code entry comes back')
  t.alike(st.refused.map((r) => ({ code: r.code, created: r.created })), [{ code: 'SUPERSEDED', created: true }])
  const rec = local.byRp.get(RP)
  t.is(rec.pending, null)
  t.alike(rec.refused.map((r) => ({ credentialId: r.credentialId, code: r.code, cleaned: r.cleaned, created: r.created })), [{ credentialId: FRESH, code: 'SUPERSEDED', cleaned: false, created: true }])
  const before = seen.length
  t.is((await id.complete().catch((e) => e)).code, 'CANCELLED', 'nothing left to complete')
  t.is(seen.length, before, 'no ceremony')
  t.absent(w.methods().includes('identity.install'))

  // A plain pending creation is not the recovery's: cancelRecovery keeps it.
  resetStubs()
  fakePasskey({ create: () => creation(ORIG, null) })
  const w2 = fakeWorklet()
  const local2 = memoryLocal()
  const { id: id2 } = await makeIdentity(w2, { local: local2 })
  t.alike(await id2.unlock({ register: true }), { pending: true })
  await id2.unlockWithCode({ code: GOOD_CODE })
  await id2.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  await id2.cancelRecovery()
  t.is((await id2.status()).pending, true, 'an unmarked pending creation stays')
})

test('cancelRecovery stops an unlockWrapped already in flight', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(MARKED, NEW_PRF_HEX, MARKED_ID) })
  const w = fakeWorklet()
  let release
  w.openGate = new Promise((resolve) => { release = resolve })
  const { id, store } = await makeIdentity(w)
  await id.unlock({ any: true })
  const opening = id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }).catch((e) => e)
  await new Promise((resolve) => setImmediate(resolve))
  id.cancelRecovery()
  release()
  t.is((await opening).code, 'CANCELLED')
  t.absent(w.methods().includes('identity.install'))
  t.is(store.log.length, 0)
})

test('code: the held root outlives a pending creation past the hold', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(FRESH, null), get: () => assertion(FRESH, NEW_PRF_HEX, MARKED_ID) })
  let clock = 1000
  const w = fakeWorklet()
  const { id } = await makeIdentity(w, { now: () => clock })
  await id.unlockWithCode({ code: GOOD_CODE })
  await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  t.alike(await id.finishRecovery(), { pending: true })
  clock += 10 * 60 * 1000
  const out = await id.complete().catch((e) => e)
  t.is(out.publicKey, pkOf(ROOT_HEX), 'the root, not an add')
  t.ok(w.calls.some((c) => c.method === 'identity.install' && c.params.prf === ROOT_HEX))
})

test('code: the held root outlives a slow creation ceremony', async (t) => {
  resetStubs()
  let clock = 1000
  fakePasskey({ create: () => { clock += 10 * 60 * 1000; return creation(FRESH, NEW_PRF_HEX) } })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w, { now: () => clock })
  await id.unlockWithCode({ code: GOOD_CODE })
  await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  const out = await id.finishRecovery().catch((e) => e)
  t.is(out.publicKey, pkOf(ROOT_HEX))
})

test('a successful plain install drops an armed code recovery', async (t) => {
  resetStubs()
  const seen = fakePasskey({ create: () => creation(ORIG, null), get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID) })
  const w = fakeWorklet()
  const { id } = await makeIdentity(w)
  t.alike(await id.unlock({ register: true }), { pending: true })
  await id.unlockWithCode({ code: GOOD_CODE })
  t.alike(await id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) }), { needsPasskey: true })
  t.alike(await id.complete(), { publicKey: pkOf(ROOT_HEX), created: true })
  const before = seen.length
  t.is((await id.finishRecovery().catch((e) => e)).code, 'RECOVERY_BAD')
  t.is(seen.length, before, 'no creation for a dropped recovery')
})

test('a marked pending creation replaced by a newer add stays excluded', async (t) => {
  resetStubs()
  let next = 'pending'
  fakePasskey({
    get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID),
    create: () => next === 'pending' ? creation(MARKED, null) : creation(FRESH, NEW_PRF_HEX)
  })
  const w = fakeWorklet()
  const local = memoryLocal()
  const { id } = await makeIdentity(w, { local })
  await id.unlock({ any: true })
  t.alike(await id.addPasskey(), { pending: true })
  next = 'direct'
  const out = await id.addPasskey()
  t.is(out.credentialId, FRESH)
  const rec = local.byRp.get(RP)
  t.is(rec.pending, null)
  t.alike(rec.refused.map((r) => ({ credentialId: r.credentialId, code: r.code, cleaned: r.cleaned, created: r.created })), [{ credentialId: MARKED, code: 'SUPERSEDED', cleaned: false, created: true }])
})

async function waitFor (ready) {
  while (!ready()) await new Promise((resolve) => setImmediate(resolve))
}

async function heldCodeRoot (w, extra = {}) {
  const made = await makeIdentity(w, extra)
  await made.id.unlockWithCode({ code: GOOD_CODE })
  await made.id.unlockWrapped({ blob: { ok: true }, member: pkOf(ROOT_HEX) })
  return made
}

function assertRolledBack (t, err, w, store, local) {
  t.is(err.code, 'RECOVERY_BAD')
  t.is(err.message, 'não deu para concluir a recuperação: entre com o código de novo')
  t.is(err.credentialId, FRESH)
  t.absent(w.unlocked, 'relocked')
  t.is(w.root, null)
  t.ok(store.log.some((l) => l[0] === 'clear'), 'the keychain session deleted')
  const rec = local.byRp.get(RP)
  t.alike(rec.refused.map((r) => ({ credentialId: r.credentialId, code: r.code, cleaned: r.cleaned, created: r.created })), [{ credentialId: FRESH, code: 'INSTALL_FAILED', cleaned: false, created: true }])
}

test('finishRecovery: a wrap that fails after the install rolls back', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const local = memoryLocal()
  const { id, store } = await heldCodeRoot(w, { local })
  w.wrapFail = true
  const err = await id.finishRecovery().catch((e) => e)
  t.ok(w.methods().includes('identity.install'), 'the root was installed first')
  assertRolledBack(t, err, w, store, local)
  t.is(await store.load({ rpId: RP, publicKey: pkOf(ROOT_HEX) }), null)
  t.alike((await id.status()).refused, [{ userId: MARKED_ID, code: 'INSTALL_FAILED', cleaned: false, created: true }])
  t.is((await id.finishRecovery().catch((e) => e)).code, 'RECOVERY_BAD', 'the held root is dropped')
})

test('finishRecovery: a cancelRecovery during the wrap rolls back', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const local = memoryLocal()
  const { id, store } = await heldCodeRoot(w, { local })
  let release
  w.wrapGate = new Promise((resolve) => { release = resolve })
  const running = id.finishRecovery().catch((e) => e)
  await waitFor(() => w.methods().includes('identity.recoveryWrap'))
  id.cancelRecovery()
  release()
  assertRolledBack(t, await running, w, store, local)
  t.is(await store.load({ rpId: RP, publicKey: pkOf(ROOT_HEX) }), null)
})

test('finishRecovery: a cancelRecovery during the session save rolls back', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(FRESH, NEW_PRF_HEX) })
  const w = fakeWorklet()
  const local = memoryLocal()
  const store = memoryStore()
  const save = store.save
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let saving = false
  store.save = async (r) => { saving = true; await gate; return save(r) }
  const { id } = await heldCodeRoot(w, { local, store })
  const running = id.finishRecovery().catch((e) => e)
  await waitFor(() => saving)
  id.cancelRecovery()
  release()
  const err = await running
  assertRolledBack(t, err, w, store, local)
  t.is(await store.load({ rpId: RP, publicKey: pkOf(ROOT_HEX) }), null, 'the saved item deleted after the save')
  t.absent(w.methods().includes('identity.recoveryWrap'))
})

test('bindPasskey: signOut waits for its keychain save', async (t) => {
  resetStubs()
  fakePasskey({ get: () => assertion(ORIG, ROOT_HEX, PLAIN_ID) })
  const w = fakeWorklet()
  const store = memoryStore()
  const { id } = await makeIdentity(w, { store })
  await id.unlock({ any: true })
  const save = store.save
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let saving = false
  store.save = async (r) => { saving = true; await gate; return save(r) }
  const binding = id.bindPasskey({ credentialId: FRESH, userId: MARKED_ID }).catch((e) => e)
  await waitFor(() => saving)
  const leaving = id.signOut()
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await binding
  t.alike(await leaving, {})
  t.is(await store.load({ rpId: RP, publicKey: pkOf(ROOT_HEX) }), null, 'no root secret left after Sair')
})

test('status: an unreadable attempts file leaves pending unknown, not false', async (t) => {
  resetStubs()
  const local = memoryLocal()
  local.byRp.set(RP, { pending: { credentialId: FRESH, userId: PLAIN_ID }, refused: [] })
  const load = local.load
  local.load = async () => { throw new Error('keychain') }
  const { id } = await makeIdentity(fakeWorklet(), { local })
  t.is((await id.status()).pending, null, 'a pending creation may be on disk')
  local.load = load
  t.is((await id.status()).pending, true, 'read again on the next call')
})

test('status: a creation held in memory stays pending while the attempts file is unreadable', async (t) => {
  resetStubs()
  fakePasskey({ create: () => creation(ORIG, null) })
  const local = memoryLocal()
  local.load = async () => { throw new Error('keychain') }
  const { id } = await makeIdentity(fakeWorklet(), { local })
  t.alike(await id.unlock({ register: true }), { pending: true })
  t.is((await id.status()).pending, true, 'concluir still shows')
})

test('status: a read still in flight is not taken as read', async (t) => {
  resetStubs()
  const local = memoryLocal()
  local.byRp.set(RP, { pending: { credentialId: FRESH, userId: PLAIN_ID }, refused: [] })
  const load = local.load
  let release
  const slow = new Promise((resolve) => { release = resolve })
  let calls = 0
  local.load = async (rp) => {
    calls++
    if (calls === 1) throw new Error('keychain')
    await slow
    return load(rp)
  }
  const w = fakeWorklet()
  const request = w.request
  let open
  const gate = new Promise((resolve) => { open = resolve })
  let gated = true
  w.request = async (method, params) => {
    if (method === 'identity.status' && gated) {
      gated = false
      await gate
    }
    return request(method, params)
  }
  const { id } = await makeIdentity(w, { local })
  const first = id.status()
  await new Promise((resolve) => setImmediate(resolve))
  const second = id.status()
  await new Promise((resolve) => setImmediate(resolve))
  open()
  t.is((await first).pending, null, 'the second read has not finished')
  release()
  t.is((await second).pending, true)
})
