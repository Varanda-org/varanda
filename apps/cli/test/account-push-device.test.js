'use strict'

const test = require('brittle')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { pushDevicePayload, tokenHash } = require('@varanda/core/lib/push-device-proof')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { tagHash } = require('@varanda/core/lib/notice-tags')
const { sealDmNotice } = require('@varanda/core/lib/dm-notice')
const { openPushDeviceStore } = require('../lib/account/push-device-store')
const { openPushCapsStore } = require('../lib/account/push-caps-store')
const { openPushStore } = require('../lib/account/push-store')
const { loadOrCreateWakeKey } = require('../lib/account/push-wake-key')
const { createPushRoutes, NATIVE_PUSH_TERMS_FLOOR, NATIVE_SEEN_TERMS, NATIVE_SOCIAL_TERMS, SEEN_SIGNAL_MS, SEEN_SIGNAL_MAX, OUTSTANDING_MS, PUSH_PAD_TO, MAX_QUEUE } = require('../lib/account/push-routes')
const { createAccountServer, keyedWindow } = require('../lib/account/server')
const { tmpDir, until } = require('./helpers/net')

const association = 'ab'.repeat(32)
const freshKey = () => nodeCrypto.randomBytes(16).toString('base64url')
const device = (transport = 'apns') => ({ transport, token: nodeCrypto.randomBytes(32).toString('hex'), key: freshKey(), createdAt: 1 })

function setup (t, { web = true, native = true, delay = 0, sendNative = null, sendSilent = null, seenSignal = false, seenDelay = 0, fakeTimers = false, phoneChecked = () => {}, pagesStore = null, dataDir = null, keyPair = null } = {}) {
  const dir = dataDir || path.join(tmpDir(t), 'account')
  const kp = keyPair || crypto.keyPair()
  const member = Buffer.from(kp.publicKey).toString('hex')
  const clock = { t: 1800000000000 }
  const now = () => clock.t
  const state = { versions: [TERMS_VERSION, NATIVE_PUSH_TERMS_FLOOR], linked: true }
  const pushStore = openPushStore(dir, { now })
  const pushCapsStore = openPushCapsStore(dir)
  const timers = new Set()
  const pushDeviceStore = openPushDeviceStore(dir, { now })
  const wakeKey = loadOrCreateWakeKey(dir)
  const calls = []
  const webCalls = []
  const silentCalls = []
  const logs = []
  const token = nodeCrypto.randomBytes(32).toString('hex')
  const sender = (transport) => ({
    async send (notice) {
      calls.push({ ...notice, transport })
      return sendNative === null ? 'ok' : sendNative(notice, transport)
    },
    async sendSilent (notice) {
      silentCalls.push({ ...notice, transport })
      return sendSilent === null ? 'ok' : sendSilent(notice, transport)
    }
  })
  class RouteError extends Error {
    constructor (code, status = 400) {
      super(code)
      this.status = status
    }
  }
  const routes = createPushRoutes({
    association,
    accounts: { status: () => ({ linked: state.linked }) },
    terms: { available: () => true, list: () => state.versions.map((version) => ({ version })) },
    pushStore,
    pushCapsStore,
    pushDeviceStore,
    seenSignal,
    seenDelayMs: () => seenDelay,
    ...(fakeTimers
      ? {
          setTimer: (fn, ms) => { const timer = { fn, at: clock.t + ms }; timers.add(timer); return timer },
          clearTimer: (timer) => timers.delete(timer)
        }
      : {}),
    vapid: web ? {} : null,
    apns: native === true || native === 'apns' ? sender('apns') : null,
    fcm: native === true || native === 'fcm' ? sender('fcm') : null,
    wakeKey,
    pagesStore,
    phoneChecked,
    relayTokenHash: nodeCrypto.createHash('sha256').update(token).digest(),
    send: async (args) => { webCalls.push(args); return 'ok' },
    delayMs: () => delay,
    now,
    log: (entry) => logs.push(entry),
    http: {
      send: (res, status, body) => Object.assign(res, { status, body }),
      sendError: (res, err) => Object.assign(res, { status: err.status }),
      readJsonBody: async (req, max) => {
        if (Buffer.byteLength(JSON.stringify(req.body)) > max) throw new RouteError('pedido-invalido', 413)
        return req.body
      },
      checkPost: () => {},
      refuse: (code) => new RouteError(code),
      fromStore: (err) => err,
      RouteError,
      keyedWindow
    }
  })
  t.teardown(() => routes.close(), { force: true })
  async function request (pathname, body, method = 'POST') {
    const res = {}
    try {
      await routes.handle({ method, body }, res, { pathname: '/account/push/' + pathname })
    } catch (err) {
      return { status: err.status, body: { error: err.message } }
    }
    return res
  }
  const start = (action = 'on', transport = 'apns') => request('start', { member, action, ...(transport === null ? {} : { transport }) })
  function sign (nonce, row, action = 'on', over = {}) {
    const { transport, token, key } = row
    const fields = { nonce, member, association, action, transport, tokenHash: tokenHash(transport, token), key, ...over }
    const signature = Buffer.from(crypto.sign(pushDevicePayload(fields), kp.secretKey)).toString('hex')
    return { nonce, member, action, transport, token, key, signature }
  }
  const finish = async (row, action = 'on') => {
    const res = await start(action, row.transport)
    return request('device/finish', sign(res.body.nonce, row, action))
  }
  const check = (row, extra = {}) => request('device/check', { member, transport: row.transport, token: row.token, key: row.key, ...extra })
  const relay = async (event) => {
    const res = {}
    await routes.handleRelay({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: event }, res)
    await until(() => routes.stats().inFlight === 0)
    return res
  }
  const dm = (recipient = member) => relay({ v: 1, kind: 'dm', box: sealDmNotice(recipient, wakeKey.publicKey).toString('base64url') })
  const group = (visibility = 'public', name = null, key = 'cd'.repeat(32)) => relay({ v: 1, kind: 'group', group: key, visibility, name, nid: nodeCrypto.randomBytes(16).toString('hex'), recipients: [member] })
  async function subscribeWeb (caps = []) {
    const ec = nodeCrypto.createECDH('prime256v1')
    ec.generateKeys()
    const row = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: ec.getPublicKey().toString('base64url'), auth: freshKey() }
    await pushStore.put({ member, ...row })
    await pushCapsStore.put({ member, hash: endpointHash(row.endpoint), caps })
    return row
  }
  async function advance (ms) {
    const end = clock.t + ms
    for (;;) {
      const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      clock.t = next.at
      timers.delete(next)
      next.fn()
      await until(() => routes.stats().inFlight === 0)
    }
    clock.t = end
  }
  return { advance, timers, silentCalls, dir, routes, request, start, sign, finish, check, relay, dm, group, subscribeWeb, pushStore, pushDeviceStore, member, kp, clock, state, calls, webCalls, logs }
}

test('device routes: no native sender leaves Web Push intact', async (t) => {
  const s = setup(t, { native: false })
  t.alike((await s.request('device/info', undefined, 'GET')).body, { apns: false, fcm: false })
  t.is((await s.start()).body.error, 'indisponivel')
  t.is((await s.start('on', 'fcm')).body.error, 'indisponivel')
  const row = device()
  t.alike((await s.check(row)).body, { registered: false })
  for (const transport of ['apns', 'fcm']) {
    const started = await s.start('on', null)
    t.is(started.status, 200)
    t.is((await s.request('device/finish', s.sign(started.body.nonce, device(transport)))).body.error, 'indisponivel')
  }
  const sub = await s.subscribeWeb()
  t.alike((await s.request('check', { member: s.member, ...sub })).body, { registered: true })
  await s.dm()
  t.is(s.webCalls.length, 1)
  t.is(s.calls.length, 0)
})

test('device routes: check and opt-out survive removal of transport configuration', async (t) => {
  const before = setup(t, { web: false })
  const rows = [device('apns'), device('fcm')]
  for (const row of rows) t.is((await before.finish(row)).status, 200)
  await before.routes.close()
  const s = setup(t, { web: false, native: false, dataDir: before.dir, keyPair: before.kp })
  s.state.versions = []
  for (const row of rows) {
    t.is((await s.start('on', row.transport)).body.error, 'indisponivel')
    t.alike((await s.check(row)).body, { registered: true })
    t.alike((await s.check(row, { key: freshKey() })).body, { registered: false })
    t.alike((await s.check(row, { token: device(row.transport).token })).body, { registered: false })
    const started = await s.start('off', row.transport)
    t.is(started.status, 200)
    if (started.status !== 200) continue
    t.alike((await s.request('device/finish', s.sign(started.body.nonce, row, 'off'))).body, { ok: true, changed: true })
    t.alike((await s.check(row)).body, { registered: false })
  }
  t.is(s.pushDeviceStore.devices(s.member), 0)
})

test('device routes: opt-out and check still require a usable store', async (t) => {
  const s = setup(t, { native: false })
  const row = device()
  const nonce = (await s.start('off', null)).body.nonce
  s.pushDeviceStore.fail()
  t.is((await s.start('off')).body.error, 'indisponivel')
  t.is((await s.check(row)).body.error, 'indisponivel')
  t.is((await s.request('device/finish', s.sign(nonce, row, 'off'))).body.error, 'indisponivel')
})

test('device routes: maximum FCM token fits finish and check, with bounded bodies', async (t) => {
  const s = setup(t)
  const row = { ...device('fcm'), token: 'a'.repeat(4096) }
  const nonce = (await s.start('on', 'fcm')).body.nonce
  const body = s.sign(nonce, row)
  t.is(Buffer.byteLength(JSON.stringify({ ...body, action: 'off' })), 4445, 'maximum finish fields with compact JSON')
  t.is(Buffer.byteLength(JSON.stringify({ member: s.member, transport: row.transport, token: row.token, key: row.key })), 4233, 'maximum check fields with compact JSON')
  t.alike((await s.request('device/finish', body)).body, { ok: true, changed: true })
  t.alike((await s.check(row)).body, { registered: true })
  for (const route of ['device/finish', 'device/check']) {
    t.is((await s.request(route, { padding: 'x'.repeat(8192) })).status, 413)
    t.not((await s.request(route, { padding: 'x'.repeat(8192 - 14) })).status, 413, 'exactly 8192 bytes reaches field validation')
  }
  for (const route of ['start', 'finish', 'check']) {
    t.is((await s.request(route, { padding: 'x'.repeat(4096) })).status, 413, 'web body limit is unchanged')
  }
})

test('device finish: signed registration, check, rotation and removal for both transports', async (t) => {
  const s = setup(t)
  t.alike((await s.request('device/info', undefined, 'GET')).body, { apns: true, fcm: true })
  for (const transport of ['apns', 'fcm']) {
    const row = device(transport)
    t.alike((await s.finish(row)).body, { ok: true, changed: true })
    t.alike((await s.check(row)).body, { registered: true })
    t.alike((await s.check(row, { key: freshKey() })).body, { registered: false })
    const rotated = { ...row, token: device(transport).token }
    t.alike((await s.finish(rotated)).body, { ok: true, changed: true })
    t.is(s.pushDeviceStore.devices(s.member), 1)
    t.alike((await s.check(row)).body, { registered: false })
    t.alike((await s.check(rotated)).body, { registered: true })
    t.alike(Object.keys(s.pushDeviceStore.list(s.member)[0]).sort(), ['createdAt', 'key', 'token', 'transport'])
    s.state.versions = []
    t.alike((await s.finish(rotated, 'off')).body, { ok: true, changed: true })
    t.is(s.pushDeviceStore.devices(s.member), 0)
    s.state.versions = [TERMS_VERSION, 101]
  }
})

for (const http of [false, true]) {
  test('device finish: another member needs the same device key' + (http ? ' over HTTP' : ''), async (t) => {
    const s = setup(t)
    const other = crypto.keyPair()
    const member = Buffer.from(other.publicKey).toString('hex')
    let request = s.request
    if (http) {
      const origin = 'https://account.example.test'
      const server = createAccountServer({
        association,
        origin,
        store: { start: () => {}, status: () => ({ linked: true }) },
        terms: { available: () => true, list: () => [{ version: TERMS_VERSION }] },
        push: { pushStore: s.pushStore, pushDeviceStore: s.pushDeviceStore, apns: { send: async () => 'ok' } },
        now: () => s.clock.t
      })
      const listener = await server.listen({ host: '127.0.0.1', port: 0 })
      t.teardown(() => listener.close(), { force: true })
      request = async (pathname, body) => {
        const res = await fetch('http://127.0.0.1:' + listener.port + '/account/push/' + pathname, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        return { status: res.status, body: await res.json() }
      }
    }
    const row = device()
    const first = await request('start', { member: s.member, action: 'on', transport: row.transport })
    t.alike((await request('device/finish', s.sign(first.body.nonce, row))).body, { ok: true, changed: true })
    const { nonce } = (await request('start', { member, action: 'on', transport: row.transport })).body
    const { transport, token } = row
    const key = freshKey()
    const signature = Buffer.from(crypto.sign(pushDevicePayload({ nonce, member, association, action: 'on', transport, tokenHash: tokenHash(transport, token), key }), other.secretKey)).toString('hex')
    const body = { nonce, member, action: 'on', transport, token, key, signature }
    const refused = await request('device/finish', body)
    if (http) t.is(refused.status, 400)
    t.alike(refused.body, { error: 'pedido-invalido' })
    t.alike((await request('device/finish', body)).body, { error: 'expirado' })
    t.alike((await request('device/check', { member: s.member, transport, token, key: row.key })).body, { registered: true })
    t.alike((await request('device/check', { member, transport, token, key })).body, { registered: false })
  })
}

test('device finish: exact fields, single use, binding and proof domain', async (t) => {
  const s = setup(t)
  const row = device()
  async function refused (mutate, error, signed = {}) {
    const nonce = (await s.start()).body.nonce
    const body = s.sign(nonce, row, 'on', signed)
    t.is((await s.request('device/finish', mutate(body))).body.error, error)
    t.is((await s.request('device/finish', body)).body.error, 'expirado')
  }
  await refused((body) => ({ ...body, extra: true }), 'pedido-invalido')
  await refused((body) => ({ ...body, token: device().token }), 'assinatura-invalida')
  await refused((body) => ({ ...body, key: freshKey() }), 'assinatura-invalida')
  await refused((body) => body, 'assinatura-invalida', { association: 'ff'.repeat(32) })
  await refused((body) => ({ ...body, action: 'off' }), 'expirado')
  await refused((body) => ({ ...body, transport: 'fcm' }), 'expirado')
  const sub = await s.subscribeWeb()
  await refused((body) => ({ ...body, signature: signPush({ nonce: body.nonce, member: s.member, association, action: 'on', endpointHash: endpointHash(sub.endpoint), p256dh: sub.p256dh, auth: sub.auth }, s.kp) }), 'assinatura-invalida')
  const nonce = (await s.start()).body.nonce
  s.clock.t += 600001
  t.is((await s.request('device/finish', s.sign(nonce, row))).body.error, 'expirado')
  t.is((await s.start('on', 'web')).body.error, 'pedido-invalido')
  t.is((await s.request('device/finish', { padding: 'x'.repeat(8192) })).status, 413)
  t.is((await s.check(row, { signature: 'a'.repeat(128) })).body.error, 'pedido-invalido')
  t.is(s.pushDeviceStore.devices(s.member), 0)
})

test('device finish: current Terms, phone gate and shared finish limit', async (t) => {
  let phone = false
  const s = setup(t, { phoneChecked: () => { if (!phone) throw new Error('telefone-pendente') } })
  const row = device()
  t.is((await s.finish(row)).body.error, 'telefone-pendente')
  phone = true
  s.state.versions = []
  t.is((await s.finish(row)).body.error, 'termos-pendentes')
  s.state.versions = [TERMS_VERSION]
  for (let i = 0; i < 8; i++) t.is((await s.finish(row)).status, 200)
  t.is((await s.finish(row)).status, 429)
  s.clock.t += 600001
  s.state.linked = false
  t.is((await s.start()).body.error, 'nao-vinculado')
})

test('native fan-out: DM reaches web and every native row once with keyed tags', async (t) => {
  const s = setup(t)
  await s.subscribeWeb()
  const rows = [device('apns'), device('fcm')]
  for (const row of rows) await s.finish(row)
  await s.dm()
  await s.dm()
  t.is(s.webCalls.length, 1)
  t.is(s.calls.length, 2)
  for (let i = 0; i < rows.length; i++) {
    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, Buffer.from('varanda-dm'), Buffer.from(rows[i].key, 'base64url'))
    t.alike(s.calls[i], { transport: rows[i].transport, token: rows[i].token, alert: 'Nova mensagem nas Conversas', kind: 'dm', tag: hash.toString('base64url').slice(0, 16), g: s.clock.t })
  }
  t.not(s.calls[0].tag, s.calls[1].tag)
  t.alike(s.routes.outstanding(s.member), ['varanda-dm'])
  t.is(s.routes.stats().queued, 0)
})

test('native fan-out: social and invite stay web-only below the native social Terms', async (t) => {
  const s = setup(t)
  await s.subscribeWeb()
  await s.finish(device())
  s.state.versions = [110, NATIVE_PUSH_TERMS_FLOOR]
  await s.relay({ v: 1, kind: 'follow', actor: 'ef'.repeat(32), recipient: s.member, seq: 1, ref: null, name: 'Bia' })
  s.routes.notifyInvite({ member: s.member, topic: 'abc', deadline: s.clock.t + 10000 })
  s.routes.notifyDeletion({ member: s.member })
  s.routes.seenWritten(s.member, [], s.clock.t)
  await until(() => s.routes.stats().inFlight === 0)
  t.is(s.calls.length, 0)
  t.is(s.webCalls.length, 3)
})

test('native fan-out: social and invite carry a fixed sentence, a keyed tag and nobody', async (t) => {
  t.is(NATIVE_SOCIAL_TERMS, 112)
  const s = setup(t)
  s.state.versions = [TERMS_VERSION, NATIVE_SOCIAL_TERMS]
  await s.subscribeWeb()
  const rows = [device('apns'), device('fcm')]
  for (const row of rows) await s.finish(row)
  const actor = 'ef'.repeat(32)
  const ref = s.member + ':3'
  await s.relay({ v: 1, kind: 'like', actor, recipient: s.member, seq: 7, ref, name: 'Bia' })
  t.is(s.webCalls.length, 1)
  t.ok(JSON.parse(s.webCalls[0].payload).body.startsWith('Bia'))
  t.is(s.calls.length, 2)
  for (let i = 0; i < rows.length; i++) {
    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, Buffer.from('varanda-like-' + ref), Buffer.from(rows[i].key, 'base64url'))
    t.alike(s.calls[i], { transport: rows[i].transport, token: rows[i].token, alert: 'Você tem um aviso novo na Varanda', kind: 'social', tag: hash.toString('base64url').slice(0, 16), g: s.clock.t })
    t.absent(JSON.stringify(s.calls[i]).includes(actor), 'no actor reaches Apple or Google')
    t.absent(JSON.stringify(s.calls[i]).includes('Bia'), 'no name reaches Apple or Google')
  }
  t.alike(s.routes.outstanding(s.member), ['varanda-like-' + ref])
  t.is(s.routes.notifyInvite({ member: s.member, topic: 'abc', deadline: s.clock.t + 10000 }), 'queued')
  await until(() => s.routes.stats().inFlight === 0)
  t.is(s.calls.length, 4)
  for (let i = 0; i < rows.length; i++) {
    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, Buffer.from('varanda-invite-drop'), Buffer.from(rows[i].key, 'base64url'))
    t.alike(s.calls[2 + i], { transport: rows[i].transport, token: rows[i].token, alert: 'Chegou um convite pra sua varanda', kind: 'invite-drop', tag: hash.toString('base64url').slice(0, 16), g: s.clock.t })
  }
  s.routes.notifyDeletion({ member: s.member })
  await until(() => s.routes.stats().inFlight === 0)
  t.is(s.calls.length, 4, 'deletion stays web-only')
})

test('native fan-out: social Terms are checked again at send, invites past the deadline drop', async (t) => {
  const s = setup(t, { web: false, delay: 1000, fakeTimers: true })
  s.state.versions = [TERMS_VERSION, NATIVE_SOCIAL_TERMS]
  await s.finish(device())
  await s.relay({ v: 1, kind: 'follow', actor: 'ef'.repeat(32), recipient: s.member, seq: 1, ref: null, name: null })
  s.state.versions = [110, NATIVE_PUSH_TERMS_FLOOR]
  await s.advance(1000)
  t.is(s.calls.length, 0)
  t.ok(s.logs.some((e) => e.kind === 'social' && e.reason === 'termos-pendentes'))
  s.state.versions = [TERMS_VERSION, NATIVE_SOCIAL_TERMS]
  t.is(s.routes.notifyInvite({ member: s.member, topic: 'abc', deadline: s.clock.t + 500 }), 'queued')
  await s.advance(1000)
  t.is(s.calls.length, 0)
})

test('native fan-out: social and invite alerts carry the dispatch time, not the queue time', async (t) => {
  const s = setup(t, { web: false, delay: 1000, fakeTimers: true })
  s.state.versions = [TERMS_VERSION, NATIVE_SOCIAL_TERMS]
  await s.finish(device())
  const queued = s.clock.t
  await s.relay({ v: 1, kind: 'follow', actor: 'ef'.repeat(32), recipient: s.member, seq: 1, ref: null, name: null })
  t.is(s.routes.notifyInvite({ member: s.member, topic: 'abc', deadline: s.clock.t + 60000 }), 'queued')
  await s.advance(1000)
  t.is(s.calls.length, 2)
  for (const call of s.calls) t.is(call.g, queued + 1000, call.kind + ' leaves the queue time out')
})

test('native fan-out: group sentences omit private names and hash the web group tag', async (t) => {
  const s = setup(t, { web: false })
  const row = device()
  await s.finish(row)
  await s.group('private')
  await s.group('public', 'Jardim', 'ab'.repeat(32))
  await s.group('public', null, 'ef'.repeat(32))
  t.alike(s.calls.map((c) => c.alert), ['Nova mensagem num grupo privado', 'Nova mensagem em Jardim', 'Nova mensagem num grupo'])
  const digest = Buffer.alloc(32)
  sodium.crypto_generichash(digest, Buffer.from('varanda-group-' + 'ab'.repeat(32)), Buffer.from(row.key, 'base64url'))
  t.is(s.calls[1].tag, digest.toString('base64url').slice(0, 16))
  t.alike(Object.keys(s.calls[0]).sort(), ['alert', 'g', 'kind', 'tag', 'token', 'transport'])
})

test('native fan-out: page DM uses the page sentence', async (t) => {
  const page = 'cd'.repeat(32)
  const s = setup(t, { web: false, pagesStore: { get: (key) => key === page ? { owner, admins: [], closed: null, movedTo: null } : null } })
  const owner = s.member
  await s.finish(device('fcm'))
  await s.dm(page)
  t.is(s.calls.length, 1)
  t.is(s.calls[0].alert, 'Nova mensagem para uma página que você administra')
  t.is(s.calls[0].kind, 'dm-page')
})

test('native fan-out: gone removes one token, an in-flight rotation survives', async (t) => {
  let rotate = false
  const s = setup(t, {
    sendNative: async (notice, transport) => {
      if (transport === 'fcm') return 'ok'
      if (rotate) await s.pushDeviceStore.add(s.member, replacement)
      return 'gone'
    }
  })
  const row = device()
  const other = device('fcm')
  await s.finish(row)
  await s.finish(other)
  await s.dm()
  t.is(s.pushDeviceStore.devices(s.member), 1)
  t.is(s.pushDeviceStore.list(s.member)[0].transport, 'fcm')
  await s.finish(row)
  const replacement = { ...row, token: device().token }
  rotate = true
  s.clock.t += 900001
  await s.dm()
  t.is(s.pushDeviceStore.devices(s.member), 2)
  t.ok(s.pushDeviceStore.list(s.member).some((r) => r.token === replacement.token))
})

test('native fan-out: late gone preserves the same token registered with a new key', async (t) => {
  const row = device()
  const replacement = { ...row, key: freshKey() }
  const s = setup(t, {
    sendNative: async () => {
      s.clock.t++
      t.alike((await s.finish(replacement)).body, { ok: true, changed: true })
      return 'gone'
    }
  })
  await s.finish(row)
  await s.dm()
  t.is(s.calls.length, 1)
  t.alike((await s.check(replacement)).body, { registered: true })
  t.alike((await s.check(row)).body, { registered: false })
})

test('native fan-out: floor 101 applies at enqueue and again at send', async (t) => {
  t.is(NATIVE_PUSH_TERMS_FLOOR, 101)
  const s = setup(t, { delay: 60000 })
  await s.subscribeWeb()
  await s.finish(device())
  s.state.versions = [100]
  await s.dm()
  t.is(s.routes.stats().queued, 1, 'only web queued below the native floor')
  s.clock.t += 900001
  s.state.versions = [101]
  await s.dm()
  t.is(s.routes.stats().queued, 2, 'both rows queued at the native floor')
  s.state.versions = [100]
  await s.routes.close()
  t.is(s.calls.length, 0)
  t.ok(s.logs.some((e) => e.kind === 'dm' && e.reason === 'termos-pendentes'))
})

test('native-only: push key exposes only the wake key', async (t) => {
  const s = setup(t, { web: false })
  const res = await s.request('key', undefined, 'GET')
  t.is(res.status, 200)
  t.alike(Object.keys(res.body), ['wake'])
  t.ok(typeof res.body.wake === 'string' && /^[A-Za-z0-9_-]{43}$/.test(res.body.wake))
})

test('native-only: invite room needs a usable transport', (t) => {
  const native = setup(t, { web: false })
  t.ok(native.routes.room() > 0)
  native.pushDeviceStore.fail()
  t.is(native.routes.room(), 0)
  const web = setup(t, { native: false })
  t.ok(web.routes.room() > 0)
  web.pushStore.fail()
  t.is(web.routes.room(), 0)
  const both = setup(t)
  both.pushStore.fail()
  t.is(both.routes.room(), 0, 'a broken web store claims nothing, so web-only members keep their slot')
})

test('native-only: start, delay, outstanding, seen recall, refund and shutdown flush', async (t) => {
  const s = setup(t, { web: false, delay: 60000 })
  t.is((await s.start()).status, 200)
  t.is((await s.start('on', null)).body.error, 'indisponivel', 'start without a transport keeps the web gate')
  t.is((await s.request('key', undefined, 'GET')).status, 200)
  await s.finish(device())
  await s.dm()
  t.is(s.routes.stats().queued, 1)
  t.is(s.calls.length, 0)
  t.alike(s.routes.outstanding(s.member), ['varanda-dm'])
  s.routes.seenWritten(s.member, ['varanda-dm'], s.clock.t)
  t.is(s.routes.stats().queued, 0)
  await s.dm()
  t.is(s.routes.stats().queued, 1, 'recall refunded the DM cooldown')
  const g = s.clock.t
  s.clock.t += 1000
  await s.routes.close()
  t.is(s.calls.length, 1)
  t.is(s.calls[0].g, g, 'native alert keeps the enqueue time')
  t.is(s.webCalls.length, 0)
})

test('native-only: recipient budget is shared and seen recall removes every row', async (t) => {
  const s = setup(t, { web: false, delay: 60000 })
  await s.finish(device())
  await s.finish(device('fcm'))
  for (let i = 0; i < 60; i++) {
    await s.group('public', null, i.toString(16).padStart(64, '0'))
  }
  t.is(s.routes.stats().queued, 120)
  await s.group('public', null, 'ff'.repeat(32))
  t.is(s.routes.stats().queued, 120, 'recipient budget is shared by both rows')
  t.ok(s.logs.some((e) => e.reason === 'teto'))
  t.ok(s.routes.stats().queued < MAX_QUEUE)
  s.routes.seenWritten(s.member, s.routes.outstanding(s.member).slice(0, 16), s.clock.t)
  t.is(s.routes.stats().queued, 88, 'seen recall removes both copies')
})

test('native send failures log only the allowed fields, never sender error text', async (t) => {
  const s = setup(t, { sendNative: async () => { throw new Error('private sender failure') } })
  const row = device()
  await s.finish(row)
  await s.dm()
  t.alike(s.logs, [{ event: 'push', kind: 'dm', transport: 'apns', reason: 'falhou' }])
  t.absent(JSON.stringify(s.logs).includes(row.token))
  t.absent(JSON.stringify(s.logs).includes(row.key))
  t.is(s.pushDeviceStore.devices(s.member), 1)
})

test('native-only: a start is bound to the configured transport, unavailable web store is independent', async (t) => {
  const s = setup(t, { web: false, native: 'fcm' })
  s.pushStore.fail()
  t.alike((await s.request('device/info', undefined, 'GET')).body, { apns: false, fcm: true })
  t.is((await s.start('on', 'apns')).body.error, 'indisponivel')
  const row = device('fcm')
  t.is((await s.finish(row)).status, 200)
  await s.dm()
  t.is(s.calls.length, 1)
  t.is(s.calls[0].transport, 'fcm')
})

test('native-only: half-queue cap counts every row, refused batches leave cooldown unspent', async (t) => {
  const s = setup(t, { web: false, delay: 60000 })
  const members = []
  for (let i = 0; i < 65; i++) {
    const member = nodeCrypto.randomBytes(32).toString('hex')
    members.push(member)
    for (let j = 0; j < 4; j++) await s.pushDeviceStore.add(member, device())
  }
  const group = 'ef'.repeat(32)
  const event = (recipients) => ({ v: 1, kind: 'group', group, visibility: 'private', name: null, nid: nodeCrypto.randomBytes(16).toString('hex'), recipients })
  await s.relay(event(members.slice(0, 64)))
  t.is(s.routes.stats().queued, MAX_QUEUE / 2)
  await s.relay(event(members.slice(64)))
  t.is(s.routes.stats().queued, MAX_QUEUE / 2)
  t.is(s.routes.stats().dropped, 4)
  s.routes.seenWritten(members[0], ['varanda-group-private'], s.clock.t)
  t.is(s.routes.stats().queued, MAX_QUEUE / 2 - 4)
  await s.relay(event(members.slice(64)))
  t.is(s.routes.stats().queued, MAX_QUEUE / 2, 'the refused member can enter as soon as there is room')
})

test('native-only: removed or rotated rows waiting in the queue are not sent', async (t) => {
  const s = setup(t, { web: false, delay: 60000 })
  const row = device()
  const other = device('fcm')
  await s.finish(row)
  await s.finish(other)
  await s.dm()
  await s.finish(row, 'off')
  await s.finish({ ...other, token: device('fcm').token })
  await s.routes.close()
  t.is(s.calls.length, 0)
  t.is(s.routes.stats().dropped, 2)
})

test('native-only: skipped Terms floor does not spend the DM cooldown', async (t) => {
  const s = setup(t, { web: false })
  await s.finish(device())
  s.state.versions = [100]
  await s.dm()
  t.is(s.calls.length, 0)
  s.state.versions = [101]
  await s.dm()
  t.is(s.calls.length, 1)
})

function derivedTags (row, tags) {
  return tags.map((tag) => {
    const digest = Buffer.alloc(32)
    sodium.crypto_generichash(digest, Buffer.from(tag), Buffer.from(row.key, 'base64url'))
    return digest.toString('base64url').slice(0, 16)
  })
}

test('native seen-sync: five writes coalesce per row with outstanding tags and the earliest cutoff', async (t) => {
  const s = setup(t, { web: false, seenSignal: true, fakeTimers: true })
  t.is(NATIVE_SEEN_TERMS, 102)
  s.state.versions = [TERMS_VERSION, 102]
  const rows = [device(), device('fcm')]
  for (const row of rows) await s.finish(row)
  await s.dm()
  await s.group('private')
  await s.group('public', 'Jardim', 'ab'.repeat(32))
  const tags = s.routes.outstanding(s.member)
  const asOf = s.clock.t
  for (let i = 0; i < 5; i++) {
    s.routes.seenWritten(s.member, [tags[i % tags.length], 'varanda-dm-page'], s.clock.t)
    if (i < 4) await s.advance(1000)
  }
  await s.advance(SEEN_SIGNAL_MS - 1)
  t.is(s.silentCalls.length, 0)
  await s.advance(1)
  t.is(s.silentCalls.length, 2)
  for (const row of rows) {
    t.alike(s.silentCalls.find((call) => call.transport === row.transport), {
      transport: row.transport,
      token: row.token,
      close: derivedTags(row, tags),
      asOf
    })
  }
  t.not(s.silentCalls[0].close[0], s.silentCalls[1].close[0])
  t.is(s.webCalls.length, 0)
  t.is(s.calls.length, 6, 'silent sends do not send alert text')
})

test('native seen-sync: switch, Terms and nonempty outstanding tags gate delivery', async (t) => {
  for (const mode of ['off', 'terms', 'empty', 'expired', 'unconfigured']) {
    const s = setup(t, { web: false, native: mode === 'unconfigured' ? 'fcm' : true, seenSignal: mode !== 'off', fakeTimers: true })
    const row = device('fcm')
    await s.finish(row)
    await s.dm()
    s.state.versions = [mode === 'terms' ? 101 : 102]
    s.routes.seenWritten(s.member, mode === 'empty' ? ['varanda-dm-page'] : ['varanda-dm'], s.clock.t)
    if (mode === 'expired') s.clock.t += OUTSTANDING_MS
    if (mode === 'unconfigured') {
      await s.finish(row, 'off')
      await s.pushDeviceStore.add(s.member, device('apns'))
    }
    if (mode === 'expired') {
      const timer = [...s.timers][0]
      s.timers.delete(timer)
      timer.fn()
      await until(() => s.routes.stats().inFlight === 0)
    } else await s.advance(SEEN_SIGNAL_MS)
    t.is(s.silentCalls.length, 0, mode)
    if (mode === 'off' || mode === 'terms') {
      const enabled = setup(t, { web: false, seenSignal: true, fakeTimers: true })
      await enabled.finish(device())
      enabled.state.versions = [102]
      await enabled.dm()
      enabled.routes.seenWritten(enabled.member, ['varanda-dm'], enabled.clock.t)
      await enabled.advance(SEEN_SIGNAL_MS)
      t.is(enabled.silentCalls.length, 1, 'accepted Terms and enabled switch send')
    }
  }
})

test('native seen-sync: web and native share thirty hourly signal slots', async (t) => {
  const s = setup(t, { seenSignal: true, fakeTimers: true })
  s.state.versions = [TERMS_VERSION, 102]
  await s.subscribeWeb(['seen-sync'])
  const rows = [device(), device('fcm')]
  for (const row of rows) await s.finish(row)
  await s.dm()
  for (let i = 0; i <= SEEN_SIGNAL_MAX; i++) {
    s.routes.seenWritten(s.member, ['varanda-dm'], s.clock.t)
    await s.advance(SEEN_SIGNAL_MS)
  }
  const signals = s.webCalls.filter((call) => JSON.parse(call.payload).kind === 'seen-sync')
  t.is(signals.length, SEEN_SIGNAL_MAX)
  t.is(s.silentCalls.length, SEEN_SIGNAL_MAX * rows.length)
  t.alike(JSON.parse(signals[0].payload), { v: 1, kind: 'seen-sync', close: [tagHash('varanda-dm')], asOf: s.calls[0].g })
  t.is(signals[0].padTo, PUSH_PAD_TO)
  s.clock.t += 3600000
  s.routes.seenWritten(s.member, ['varanda-dm'], s.clock.t)
  await s.advance(SEEN_SIGNAL_MS)
  t.is(s.silentCalls.length, (SEEN_SIGNAL_MAX + 1) * rows.length)
})

test('native seen-sync: late gone removes only the exact row and preserves rotations', async (t) => {
  for (const rotation of [null, 'token', 'key', 'createdAt']) {
    const row = device()
    const other = device('fcm')
    let replacement
    const s = setup(t, {
      web: false,
      seenSignal: true,
      fakeTimers: true,
      sendSilent: async (notice, transport) => {
        if (transport === 'fcm') return 'ok'
        if (rotation) {
          s.clock.t++
          if (rotation === 'createdAt') await s.pushDeviceStore.remove(s.member, row.key)
          replacement = { ...row, [rotation]: rotation === 'token' ? device().token : rotation === 'key' ? freshKey() : s.clock.t }
          await s.pushDeviceStore.add(s.member, replacement)
        }
        return 'gone'
      }
    })
    s.state.versions = [TERMS_VERSION, 102]
    await s.finish(row)
    await s.finish(other)
    await s.dm()
    s.routes.seenWritten(s.member, ['varanda-dm'], s.clock.t)
    await s.advance(SEEN_SIGNAL_MS)
    const remaining = s.pushDeviceStore.list(s.member)
    t.is(s.silentCalls.length, 2)
    t.is(remaining.length, rotation ? 2 : 1)
    t.ok(remaining.some((r) => r.token === other.token))
    if (rotation) t.ok(remaining.some((r) => r.token === replacement.token && r.key === replacement.key))
    t.absent(JSON.stringify(s.logs).includes(row.token))
    t.absent(JSON.stringify(s.logs).includes(row.key))
    t.absent(JSON.stringify(s.logs).includes(s.silentCalls[0].close[0]))
  }
})

test('native seen-sync: queued sends recheck Terms and registration after the coalesced timer', async (t) => {
  for (const change of ['terms', 'remove', 'rotate']) {
    const s = setup(t, { web: false, seenSignal: true, seenDelay: 5000, fakeTimers: true })
    s.state.versions = [TERMS_VERSION, 102]
    const row = device()
    await s.finish(row)
    await s.dm()
    s.routes.seenWritten(s.member, ['varanda-dm'], s.clock.t)
    await s.advance(SEEN_SIGNAL_MS)
    t.is(s.routes.stats().queued, 1)
    if (change === 'terms') s.state.versions = [101]
    else if (change === 'remove') await s.finish(row, 'off')
    else await s.finish({ ...row, key: freshKey() })
    await s.advance(5000)
    t.is(s.silentCalls.length, 0, change)
  }
})

test('native seen-sync: expired tags leave the signal while a newer generation keeps its enqueue time', async (t) => {
  const s = setup(t, { web: false, seenSignal: true, fakeTimers: true })
  s.state.versions = [TERMS_VERSION, 102]
  const row = device()
  await s.finish(row)
  await s.dm()
  s.clock.t += OUTSTANDING_MS - 10000
  await s.group('private')
  const asOf = s.clock.t
  s.routes.seenWritten(s.member, ['varanda-dm', 'varanda-group-private'], asOf)
  await s.advance(SEEN_SIGNAL_MS)
  t.alike(s.silentCalls, [{ token: row.token, transport: row.transport, close: derivedTags(row, ['varanda-group-private']), asOf }])
  s.clock.t += 600001
  s.routes.seenWritten(s.member, ['varanda-group-private'], s.clock.t)
  s.clock.t += 1000
  await s.group('private')
  const g = s.clock.t
  await s.advance(SEEN_SIGNAL_MS)
  t.is(s.calls.at(-1).g, g)
  t.ok(s.silentCalls.at(-1).asOf < g)
})
