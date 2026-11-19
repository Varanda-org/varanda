'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const M = 'ab'.repeat(32)
const N = 'cd'.repeat(32)
const TOKEN = 'ef'.repeat(32)
const NEXT = 'ab'.repeat(32)
const KEY = 'AAAAAAAAAAAAAAAAAAAAAA'
const NONCE = 'n'.repeat(43)
const SIG = 'a'.repeat(128)
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)
const url = (file) => pathToFileURL(path.join(__dirname, '../src', file)).href

// Replace only platform imports; execute the actual native client and hook.
function nativeUrl (secure = dataUrl('export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1')) {
  return dataUrl(fs.readFileSync(path.join(__dirname, '../src/pushClient.native.js'), 'utf8')
    .replace("'../modules/push-device'", JSON.stringify(dataUrl('export const isAvailable = () => false')))
    .replace("'expo-secure-store'", JSON.stringify(secure))
    .replace("'expo-crypto'", JSON.stringify(dataUrl('export const getRandomBytes = () => { throw new Error("unused") }')))
    .replace("'./account'", JSON.stringify(url('account.js')))
    .replace("'./pushDevice.js'", JSON.stringify(url('pushDevice.js'))))
}

async function fixture () {
  const { createPushClient } = await import(nativeUrl())
  const { createNativePushStore } = await import('../src/pushDevice.js')
  const calls = []
  const records = new Map()
  const staged = new Map()
  let installationKey = null
  let randomCalls = 0
  let permission = 'undetermined'
  let token = TOKEN
  let tokenListener = () => {}
  let intentListener = () => {}
  let intent = null
  let registered = true
  let info = { apns: true, fcm: false }
  let fail = false
  let available = true
  let transport = 'apns'
  let prompt = null
  const device = {
    isAvailable: () => available,
    transport: () => transport,
    permission: async () => permission,
    request: async () => { calls.push('permission'); if (prompt) await prompt; permission = 'granted'; return permission },
    token: async () => { calls.push('token'); return token },
    onToken: (fn) => { tokenListener = fn; return () => { tokenListener = () => {} } },
    launchIntent: async () => { const value = intent; intent = null; return value },
    onIntent: (fn) => { intentListener = fn; return () => { intentListener = () => {} } }
  }
  const account = {
    pushDeviceInfo: async () => info,
    pushDeviceStart: async (args) => { calls.push(['start', args]); return { nonce: NONCE } },
    pushDeviceFinish: async (args) => { calls.push(['finish', args]); if (fail) throw new Error('recusado'); return { ok: true, changed: true } },
    pushDeviceCheck: async () => registered === null ? null : { registered }
  }
  const store = {
    loadKey: async () => installationKey,
    saveKey: async (key) => { installationKey = key },
    load: async (member) => ({ record: staged.get(member) || records.get(member) || null, suspended: staged.has(member) }),
    stage: async (member, record) => { calls.push('stage'); staged.set(member, record) },
    save: async (member, record) => { calls.push('save'); records.set(member, record); staged.delete(member) },
    clear: async (member) => { calls.push('clear'); records.delete(member); staged.delete(member) }
  }
  const node = { request: async (method, params) => { calls.push([method, params]); return { signature: SIG } } }
  const random = (size) => new Uint8Array(size).fill(randomCalls++)
  const newClient = () => createPushClient({ device, account, store, random })
  const client = newClient()
  const push = createNativePushStore({ client, getNode: () => node })
  return {
    client,
    device,
    push,
    node,
    account,
    calls,
    records,
    staged,
    newClient,
    get installationKey () { return installationKey },
    get randomCalls () { return randomCalls },
    configure (values) {
      if ('installationKey' in values) installationKey = values.installationKey
      if ('permission' in values) permission = values.permission
      if ('info' in values) info = values.info
      if ('registered' in values) registered = values.registered
      if ('fail' in values) fail = values.fail
      if ('available' in values) available = values.available
      if ('intent' in values) intent = values.intent
      if ('transport' in values) transport = values.transport
      if ('prompt' in values) prompt = values.prompt
    },
    rotate (value) { token = value; tokenListener(value) },
    tap (kind) { intentListener(kind) }
  }
}

const settle = (push) => push.read(M)
const mutations = (f) => f.calls.filter((call) => Array.isArray(call) && call[0] === 'finish')

test('native transport off or unavailable keeps the exact NONE snapshot', async (t) => {
  const none = { member: null, state: null, pending: false, error: '', note: 'none' }
  for (const configuration of [{ info: { apns: false, fcm: true } }, { available: false }, { info: null }]) {
    const f = await fixture()
    f.configure(configuration)
    await f.push.read(M)
    t.alike(f.push.getSnapshot(), none)
    t.ok(Object.isFrozen(f.push.getSnapshot()))
    t.is(f.push.toggle({ node: f.node, member: M }), false)
    t.is(f.push.activate({ node: f.node, member: M }), false)
    t.is(mutations(f).length, 0)
  }
})

test('native hook retains its eight exports, stable snapshot and web shape', async (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/usePush.native.js'), 'utf8')
  const hook = await import(dataUrl(source
    .replace("'react'", JSON.stringify(dataUrl('export const useSyncExternalStore = (subscribe, get) => get()')))
    .replace("'./client'", JSON.stringify(dataUrl('export const currentClient = () => null')))
    .replace("'./pushClient'", JSON.stringify(nativeUrl()))
    .replace("'./pushDevice.js'", JSON.stringify(url('pushDevice.js')))))
  t.alike(Object.keys(hook).sort(), ['activatePush', 'dismissPush', 'getPush', 'readPush', 'subscribePush', 'togglePush', 'turnOffPush', 'usePush'])
  t.is(hook.getPush(), hook.getPush())
  const view = hook.usePush()
  t.alike(Object.keys(view).sort(), ['member', 'state', 'pending', 'error', 'note', 'readPush', 'activatePush', 'togglePush', 'turnOffPush', 'dismissPush'].sort())
  await hook.readPush(M)
  t.is(hook.getPush().state, null)
  t.absent(source.includes('\u2014'))
})

test('enable and disable use permission, token, start, sign, finish and persistence in order', async (t) => {
  const f = await fixture()
  await f.push.read(M)
  t.ok(f.push.toggle({ node: f.node, member: M }))
  t.absent(f.push.toggle({ node: f.node, member: M }), 'only one operation in flight')
  await settle(f.push)
  const next = { transport: 'apns', token: TOKEN, key: KEY }
  t.alike(f.calls.slice(0, 7), [
    'permission', 'token', 'stage',
    ['start', { member: M, action: 'on', transport: 'apns' }],
    ['pushDevice.sign', { nonce: NONCE, action: 'on', ...next }],
    ['finish', { member: M, nonce: NONCE, action: 'on', ...next, signature: SIG }], 'save'
  ])
  t.alike(f.records.get(M), next)
  t.is(f.push.getSnapshot().state.deviceState, 'on')
  f.calls.length = 0
  t.ok(f.push.toggle({ node: f.node, member: M }))
  await settle(f.push)
  t.alike(f.calls.slice(0, 5), [
    'stage', ['start', { member: M, action: 'off', transport: 'apns' }],
    ['pushDevice.sign', { nonce: NONCE, action: 'off', ...next }],
    ['finish', { member: M, nonce: NONCE, action: 'off', ...next, signature: SIG }], 'clear'
  ])
  t.is(f.records.has(M), false)
  t.is(f.push.getSnapshot().state.deviceState, 'off')
})

test('onToken rotates in place with the same key and duplicate events never renew', async (t) => {
  const f = await fixture()
  const keptKey = Buffer.alloc(16, 1).toString('base64url')
  f.configure({ permission: 'granted' })
  f.records.set(M, { transport: 'apns', token: TOKEN, key: keptKey })
  await f.push.read(M)
  f.rotate(NEXT)
  await settle(f.push)
  t.is(mutations(f).length, 1)
  t.is(mutations(f)[0][1].key, keptKey)
  t.is(mutations(f)[0][1].token, NEXT)
  t.is(f.records.get(M).key, keptKey)
  f.rotate(NEXT)
  await settle(f.push)
  t.is(mutations(f).length, 1)
})

test('members on the same installation reuse one key across clients', async (t) => {
  const f = await fixture()
  t.ok((await f.client.enablePush({ node: f.node, member: M })).ok)
  t.ok((await f.newClient().enablePush({ node: f.node, member: N })).ok)
  t.alike(mutations(f).map(([, args]) => [args.member, args.key]), [[M, KEY], [N, KEY]])
  t.is(f.installationKey, KEY)
  t.is(f.randomCalls, 1)
})

test('stored and pending records keep their key when the installation key differs', async (t) => {
  const installationKey = Buffer.alloc(16, 1).toString('base64url')
  for (const pending of [false, true]) {
    const f = await fixture()
    f.configure({ installationKey })
    const records = pending ? f.staged : f.records
    records.set(M, { transport: 'apns', token: TOKEN, key: KEY })
    t.ok((await f.client.enablePush({ node: f.node, member: M, token: NEXT })).ok)
    t.is(mutations(f)[0][1].key, KEY)
    t.is(f.records.get(M).key, KEY)
    t.is(f.installationKey, installationKey)
    t.is(f.randomCalls, 0)
  }
})

test('an invalid installation key is replaced and reused', async (t) => {
  for (const installationKey of ['', 'invalid', 'A'.repeat(21) + 'B']) {
    const f = await fixture()
    f.configure({ installationKey })
    t.ok((await f.client.enablePush({ node: f.node, member: M })).ok)
    t.is(f.installationKey, KEY)
    t.ok((await f.newClient().enablePush({ node: f.node, member: N })).ok)
    t.alike(mutations(f).map(([, args]) => args.key), [KEY, KEY])
    t.is(f.randomCalls, 1)
  }
})

test('pedido-invalido stays a plain failure and is never retried automatically', async (t) => {
  const f = await fixture()
  const finish = f.account.pushDeviceFinish
  f.account.pushDeviceFinish = async (args) => {
    await finish(args)
    throw Object.assign(new Error('pedido inválido'), { code: 'pedido-invalido' })
  }
  t.alike(await f.client.enablePush({ node: f.node, member: M }), { ok: false, reason: 'failed' })
  await f.push.read(M)
  f.rotate(NEXT)
  await settle(f.push)
  await f.push.read(null)
  await f.push.read(M)
  t.is(mutations(f).length, 1)
  t.absent(f.records.has(M))
  t.is(f.staged.get(M).key, KEY)
})

test('not registered renews only once per unlocked launch', async (t) => {
  const f = await fixture()
  f.configure({ permission: 'granted', registered: false })
  f.records.set(M, { transport: 'apns', token: TOKEN, key: KEY })
  await f.push.read(M)
  await f.push.read(M)
  await f.push.read(M)
  t.is(mutations(f).length, 1)
  await f.push.read(null)
  await f.push.read(M)
  t.is(mutations(f).length, 2)
})

test('a refused finish stays off and uncertain, across reads, rotations and unlocks', async (t) => {
  const f = await fixture()
  f.configure({ fail: true })
  await f.push.read(M)
  f.push.toggle({ node: f.node, member: M })
  await settle(f.push)
  const { PUSH_UNCERTAIN } = await import('../src/push-state.js')
  t.is(f.push.getSnapshot().state.deviceState, 'off')
  t.is(f.push.getSnapshot().error, PUSH_UNCERTAIN)
  t.absent(f.records.has(M), 'never commits an unconfirmed registration')
  t.ok(f.staged.has(M), 'retains the key for an explicit action')
  await f.push.read(M)
  f.rotate(NEXT)
  await settle(f.push)
  await f.push.read(null)
  await f.push.read(M)
  t.is(mutations(f).length, 1, 'no automatic retry')
  f.configure({ fail: false })
  f.push.toggle({ node: f.node, member: M })
  await settle(f.push)
  t.is(mutations(f).length, 2, 'a manual tap may renew')
  t.is(f.records.get(M).key, KEY)
  t.is(f.push.getSnapshot().error, '')
})

test('permission refusal, missing token and unknown check do not mutate', async (t) => {
  const f = await fixture()
  f.configure({ permission: 'denied' })
  t.alike(await f.client.enablePush({ node: f.node, member: M }), { ok: false, reason: 'denied' })
  f.configure({ permission: 'granted' })
  f.rotate(null)
  t.is((await f.client.enablePush({ node: f.node, member: M })).ok, false)
  f.rotate(TOKEN)
  f.records.set(M, { transport: 'apns', token: TOKEN, key: KEY })
  f.configure({ registered: null })
  await f.push.read(M)
  t.is(f.push.getSnapshot().state.registered, null)
  t.is(mutations(f).length, 0)
})

test('member records stay separate and locking unsubscribes token events', async (t) => {
  const f = await fixture()
  f.configure({ permission: 'granted' })
  f.records.set(M, { transport: 'apns', token: TOKEN, key: KEY })
  await f.push.read(M)
  await f.push.read(null)
  f.rotate(NEXT)
  await f.push.read(N)
  t.is(mutations(f).length, 0)
  t.is(f.push.getSnapshot().member, N)
  t.is(f.push.getSnapshot().state.deviceState, 'off')
  t.is(f.records.get(M).token, TOKEN)
})

test('cold and live taps use the web launch shape, once and without identity', async (t) => {
  const f = await fixture()
  f.configure({ intent: 'dm-page' })
  t.is(f.client.captureLaunch(), null, 'the App initializer stays synchronous')
  const intents = []
  const stop = f.client.listenLaunch((intent) => intents.push(intent))
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(intents, [{ kind: 'dm-page' }])
  t.is(f.client.captureLaunch(), null)
  for (const kind of ['dm', 'group', 'group-private', 'invalid']) f.tap(kind)
  t.alike(intents, [{ kind: 'dm-page' }, { kind: 'dm' }, { kind: 'group' }, { kind: 'group' }])
  stop()
  f.tap('dm')
  t.is(intents.length, 4)
})

test('capture queues the latest valid tap until JS subscribes and flushes it once', async (t) => {
  const f = await fixture()
  t.is(f.client.captureLaunch(), null)
  await new Promise((resolve) => setImmediate(resolve))
  f.tap('dm')
  f.tap('group-private')
  f.tap('invalid')
  const intents = []
  const stop = f.client.listenLaunch((intent) => intents.push(intent))
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(intents, [{ kind: 'group' }])
  stop()
  const again = f.client.listenLaunch((intent) => intents.push(intent))
  t.alike(intents, [{ kind: 'group' }], 'the queued tap was consumed')
  f.tap('group-private')
  t.alike(intents, [{ kind: 'group' }, { kind: 'group' }], 'a later tap of the same kind is distinct')
  again()
})

test('capture subscribes before reading and deduplicates a launch read and event for the same tap', async (t) => {
  const f = await fixture()
  const order = []
  const onIntent = f.device.onIntent
  f.device.onIntent = (fn) => { order.push('subscribe'); return onIntent(fn) }
  let finishRead
  f.device.launchIntent = () => {
    order.push('read')
    return new Promise((resolve) => { finishRead = resolve })
  }
  f.client.captureLaunch()
  const intents = []
  const stop = f.client.listenLaunch((intent) => intents.push(intent))
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(order, ['subscribe', 'read'])
  f.tap('dm')
  finishRead('dm')
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(intents, [{ kind: 'dm' }])
  t.is(f.client.captureLaunch(), null)
  f.tap('dm')
  t.alike(intents, [{ kind: 'dm' }, { kind: 'dm' }], 'deduplication ends with the launch read')
  stop()
})

const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) })

test('device account helpers send exact routes and bodies and validate exact answers', async (t) => {
  const account = await import('../src/account.js')
  const original = globalThis.fetch
  t.teardown(() => { globalThis.fetch = original })
  const calls = []
  let response
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response }
  const args = { member: M, action: 'on', transport: 'apns' }
  const record = { transport: 'apns', token: TOKEN, key: KEY }
  const finish = { member: M, nonce: NONCE, action: 'on', ...record, signature: SIG }
  for (const [name, body, answer, route, method] of [
    ['pushDeviceInfo', undefined, { apns: true, fcm: false }, '/account/push/device/info', 'GET'],
    ['pushDeviceStart', args, { nonce: NONCE }, '/account/push/start', 'POST'],
    ['pushDeviceFinish', finish, { ok: true, changed: false }, '/account/push/device/finish', 'POST'],
    ['pushDeviceCheck', { member: M, ...record }, { registered: false }, '/account/push/device/check', 'POST']
  ]) {
    response = json(200, answer)
    t.alike(await account[name](body), answer)
    const call = calls.at(-1)
    t.is(call.url, route)
    t.is(call.init.method, method)
    if (body) t.alike(JSON.parse(call.init.body), body)
    for (const bad of [{ ...answer, extra: true }, {}, []]) {
      response = json(200, bad)
      if (name === 'pushDeviceInfo' || name === 'pushDeviceCheck') t.is(await account[name](body), null)
      else await t.exception(account[name](body))
    }
  }
  response = json(200, { nonce: 'short' })
  await t.exception(account.pushDeviceStart(args))
})

test('device finish reports unknown outcomes and never resends; definite HTTP refusal stays definite', async (t) => {
  const account = await import('../src/account.js')
  const original = globalThis.fetch
  t.teardown(() => { globalThis.fetch = original })
  const args = { member: M, nonce: NONCE, action: 'on', transport: 'apns', token: TOKEN, key: KEY, signature: SIG }
  for (const response of [null, json(503, { error: 'indisponivel' }), json(200, { ok: false }), json(200, { ok: true, changed: true, extra: 1 })]) {
    let calls = 0
    globalThis.fetch = async () => { calls++; if (!response) throw new Error('rede'); return response }
    try { await account.pushDeviceFinish(args); t.fail() } catch (err) { t.is(err.uncertain, true) }
    t.is(calls, 1)
  }
  globalThis.fetch = async () => json(400, { error: 'assinatura-invalida' })
  try { await account.pushDeviceFinish(args); t.fail() } catch (err) { t.absent(err.uncertain) }
})

test('FCM uses its own capability and token in both signed actions', async (t) => {
  const f = await fixture()
  f.configure({ transport: 'fcm', info: { apns: false, fcm: true } })
  f.rotate('fcm:fixture_token-1')
  await f.push.read(M)
  t.ok(f.push.toggle({ node: f.node, member: M }))
  await settle(f.push)
  t.is(f.records.get(M).transport, 'fcm')
  t.is(mutations(f)[0][1].transport, 'fcm')
  t.is(mutations(f)[0][1].token, 'fcm:fixture_token-1')
  await f.push.offHere({ node: f.node, member: M })
  t.is(mutations(f)[1][1].action, 'off')
  t.absent(f.records.has(M))
})

test('lock during permission cancels the old member without overwriting the new view', async (t) => {
  const f = await fixture()
  let release
  const prompt = new Promise((resolve) => { release = resolve })
  f.configure({ prompt })
  await f.push.read(M)
  f.push.toggle({ node: f.node, member: M })
  await new Promise((resolve) => setImmediate(resolve))
  await f.push.read(null)
  const reading = f.push.read(N)
  release()
  await reading
  t.is(mutations(f).length, 0)
  t.absent(f.staged.has(M))
  t.is(f.push.getSnapshot().member, N)
  t.is(f.push.getSnapshot().pending, false)
})

test('native SecureStore retains pending records across clients and clears only after signed off', async (t) => {
  const secureUrl = dataUrl(`
    export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 17
    export const items = new Map()
    export const accesses = []
    export async function getItemAsync (key, options) { accesses.push(options); return items.get(key) ?? null }
    export async function setItemAsync (key, value, options) { accesses.push(options); items.set(key, value) }
    export async function deleteItemAsync (key, options) { accesses.push(options); items.delete(key) }
  `)
  const secure = await import(secureUrl)
  const { createPushClient } = await import(nativeUrl(secureUrl))
  const f = await fixture()
  const device = {
    isAvailable: () => true,
    transport: () => 'apns',
    permission: async () => 'granted',
    token: async () => TOKEN
  }
  const options = { device, account: f.account, random: () => new Uint8Array(16) }
  f.configure({ fail: true })
  const first = createPushClient(options)
  const result = await first.enablePush({ member: M, node: f.node })
  t.is(result.uncertain, true)
  const restored = createPushClient(options)
  const state = await restored.getPushState(M)
  t.is(state.deviceState, 'off')
  t.is(state.suspended, true)
  t.is(state.record.key, KEY)
  t.is((await restored.getPushState(N)).record, null)
  t.absent((await restored.enablePush({ member: M, node: f.node, automatic: true })).ok)
  t.is(mutations(f).length, 1)
  f.configure({ fail: false })
  t.ok((await restored.disablePush({ member: M, node: f.node })).ok)
  t.is(mutations(f)[1][1].key, KEY)
  t.is(mutations(f)[1][1].action, 'off')
  t.alike([...secure.items], [['varanda.push-device.key', KEY]])
  t.ok(secure.accesses.every((options) => options.keychainAccessible === 17))
})
