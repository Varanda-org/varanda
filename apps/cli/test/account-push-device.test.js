'use strict'

const test = require('brittle')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { pushDevicePayload, tokenHash } = require('@varanda/core/lib/push-device-proof')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { sealDmNotice } = require('@varanda/core/lib/dm-notice')
const { openPushDeviceStore } = require('../lib/account/push-device-store')
const { openPushStore } = require('../lib/account/push-store')
const { loadOrCreateWakeKey } = require('../lib/account/push-wake-key')
const { createPushRoutes, NATIVE_PUSH_TERMS_FLOOR, MAX_QUEUE } = require('../lib/account/push-routes')
const { keyedWindow } = require('../lib/account/server')
const { tmpDir, until } = require('./helpers/net')

const association = 'ab'.repeat(32)
const freshKey = () => nodeCrypto.randomBytes(16).toString('base64url')
const device = (transport = 'apns') => ({ transport, token: nodeCrypto.randomBytes(32).toString('hex'), key: freshKey(), createdAt: 1 })

function setup (t, { web = true, native = true, delay = 0, sendNative = null, phoneChecked = () => {}, pagesStore = null } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const kp = crypto.keyPair()
  const member = Buffer.from(kp.publicKey).toString('hex')
  const clock = { t: 1800000000000 }
  const now = () => clock.t
  const state = { versions: [TERMS_VERSION, NATIVE_PUSH_TERMS_FLOOR], linked: true }
  const pushStore = openPushStore(dir, { now })
  const pushDeviceStore = openPushDeviceStore(dir, { now })
  const wakeKey = loadOrCreateWakeKey(dir)
  const calls = []
  const webCalls = []
  const logs = []
  const token = nodeCrypto.randomBytes(32).toString('hex')
  const sender = (transport) => ({
    async send (notice) {
      calls.push({ ...notice, transport })
      return sendNative === null ? 'ok' : sendNative(notice, transport)
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
    pushDeviceStore,
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
  async function subscribeWeb () {
    const ec = nodeCrypto.createECDH('prime256v1')
    ec.generateKeys()
    const row = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: ec.getPublicKey().toString('base64url'), auth: freshKey() }
    await pushStore.put({ member, ...row })
    return row
  }
  return { routes, request, start, sign, finish, check, relay, dm, group, subscribeWeb, pushStore, pushDeviceStore, member, kp, clock, state, calls, webCalls, logs }
}

test('device routes: no native sender leaves Web Push intact', async (t) => {
  const s = setup(t, { native: false })
  t.alike((await s.request('device/info', undefined, 'GET')).body, { apns: false, fcm: false })
  t.is((await s.start()).body.error, 'indisponivel')
  t.is((await s.start('on', 'fcm')).body.error, 'indisponivel')
  const row = device()
  t.is((await s.check(row)).body.error, 'indisponivel')
  const started = await s.start('on', null)
  t.is(started.status, 200)
  t.is((await s.request('device/finish', s.sign(started.body.nonce, row))).body.error, 'indisponivel')
  const sub = await s.subscribeWeb()
  t.alike((await s.request('check', { member: s.member, ...sub })).body, { registered: true })
  await s.dm()
  t.is(s.webCalls.length, 1)
  t.is(s.calls.length, 0)
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
  t.is((await s.request('device/finish', { padding: 'x'.repeat(4096) })).status, 413)
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
    t.alike(s.calls[i], { transport: rows[i].transport, token: rows[i].token, alert: 'Nova mensagem nas Conversas', kind: 'dm', tag: hash.toString('base64url').slice(0, 16) })
  }
  t.not(s.calls[0].tag, s.calls[1].tag)
  t.alike(s.routes.outstanding(s.member), ['varanda-dm'])
  t.is(s.routes.stats().queued, 0)
})

test('native fan-out: social, invite, deletion and seen signals stay web-only', async (t) => {
  const s = setup(t)
  await s.subscribeWeb()
  await s.finish(device())
  await s.relay({ v: 1, kind: 'follow', actor: 'ef'.repeat(32), recipient: s.member, seq: 1, ref: null, name: 'Bia' })
  s.routes.notifyInvite({ member: s.member, topic: 'abc', deadline: s.clock.t + 10000 })
  s.routes.notifyDeletion({ member: s.member })
  s.routes.seenWritten(s.member, [], s.clock.t)
  await until(() => s.routes.stats().inFlight === 0)
  t.is(s.calls.length, 0)
  t.is(s.webCalls.length, 3)
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
  t.alike(Object.keys(s.calls[0]).sort(), ['alert', 'kind', 'tag', 'token', 'transport'])
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

test('native-only: invite room needs usable Web Push', (t) => {
  const native = setup(t, { web: false })
  t.is(native.routes.room(), 0)
  const mixed = setup(t)
  t.ok(mixed.routes.room() > 0)
  mixed.pushStore.fail()
  t.is(mixed.routes.room(), 0)
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
  await s.routes.close()
  t.is(s.calls.length, 1)
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
