'use strict'

// device.* through the node session (docs/rpc.md 5.152 to 5.155):
// devices.changed and groups.changed, errors on the wire.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createClient, createServerDispatcher } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession } = require('./helpers/net')
const { createCert } = require('../lib/cert')
const member = require('../lib/member')
const store = require('../lib/store')
const devices = require('../lib/devices')
const { groupJoinRecord, groupCutRecord } = require('../lib/records')

const hex = (key) => b4a.toString(key, 'hex')
const rand = () => hex(crypto.randomBytes(32))

async function person (t) {
  const kp = crypto.keyPair()
  const dataDir = tmpDir(t)
  const association = hex(kp.publicKey)
  const session = newSession(t, { dataDir, association, bootstrap: ['127.0.0.1:49737'] })
  const events = []
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send (message, text) {
      if (message.event) events.push([message.event, message.data])
      queueMicrotask(() => client.receive(JSON.parse(text)))
    },
    onProtocolError: () => t.fail('unexpected protocol error')
  })
  const client = createClient({
    timeoutMs: 90000,
    send (message, text) { queueMicrotask(() => dispatcher.receive(JSON.parse(text))) }
  })
  session.attach(dispatcher.emit)
  t.teardown(() => {
    client.close()
    dispatcher.close()
  }, { force: true })
  await client.request('session.open')
  const { publicKey } = await client.request('identity.create')
  await client.request('cert.add', { cert: createCert({ member: publicKey }, kp) })
  return { ctx: { dataDir, association }, session, events, call: (method, params) => client.request(method, params) }
}

// Appends records to the own diary between requests (the session closes
// the store after each one).
async function onDiary (ctx, fn) {
  return member.withIdentity(ctx, async ({ diary }) => {
    const key = devices.deviceKey(diary.keyPair.secretKey, diary.key)
    try {
      return await fn({ diary, key })
    } finally {
      devices.wipeKey(key)
    }
  })
}

const named = (events, name) => events.filter(([e]) => e === name).map(([, d]) => d)

// The disconnect waits for its refresh run (up to 15 s with no peer here).
test('session: hello, list and disconnect, with their events', { timeout: 120000 }, async (t) => {
  const p = await person(t)
  const hello = await p.call('device.hello', { name: 'Celular' })
  t.alike(hello, { id: hello.id, registered: true, off: false })
  t.alike(named(p.events, 'devices.changed'), [], 'never off: nothing to say')
  await p.call('device.hello', { name: 'Celular' })
  await p.call('device.list')
  t.alike(named(p.events, 'devices.changed'), [], 'sent on a change only')

  const lost = rand()
  const pair = { group: rand(), writer: rand() }
  await onDiary(p.ctx, async ({ diary, key }) => {
    await store.appendRecord(diary, groupJoinRecord({ ...pair, on: true }))
    await store.appendRecord(diary, devices.sealedRecord({ v: 1, id: lost, name: 'Perdido', on: true, writers: [pair] }, key))
  })
  const list = await p.call('device.list')
  t.alike(list.devices.map((d) => [d.name, d.self, d.on, d.writers]), [['Celular', true, true, 0], ['Perdido', false, true, 1]])

  t.alike(await p.call('device.disconnect', { id: lost }), { cut: 1, empty: 1 })
  t.alike(named(p.events, 'groups.changed'), [{ group: pair.group }])
  t.alike([named(p.events, 'sync.started'), named(p.events, 'sync.stopped')], [[], []], 'the refresh run is internal')
  t.alike(await p.call('sync.status'), { state: 'idle' }, 'and the user sync intent untouched')
  const e = await p.call('device.disconnect', { id: hello.id }).catch((err) => err)
  t.is(e.code, 'USAGE')
  t.is(e.message, devices.SELF_REFUSED)
  const nf = await p.call('device.disconnect', { id: lost }).catch((err) => err)
  t.is(nf.message, devices.NOT_FOUND)
  const both = await p.call('device.disconnect', { id: lost, previous: true }).catch((err) => err)
  t.is(both.code, 'USAGE', 'id and previous together')
})

test('session: a disconnected device is told so, refuses to disconnect, and reconnects', async (t) => {
  const p = await person(t)
  const mine = { group: rand(), writer: rand() }
  store.writeGroups(p.ctx.dataDir, [...store.readGroups(p.ctx.dataDir), { ...mine, nonce: hex(crypto.randomBytes(16)) }])
  await onDiary(p.ctx, async ({ diary }) => {
    await store.appendRecord(diary, groupJoinRecord({ ...mine, on: true }))
    await store.appendRecord(diary, groupCutRecord({ ...mine, cut: 0 }))
  })
  t.alike(await p.call('device.hello', { name: 'Celular' }), { id: null, registered: false, off: true })
  t.alike(named(p.events, 'devices.changed'), [{ off: true }])
  const refused = await p.call('device.disconnect', { previous: true }).catch((err) => err)
  t.is(refused.code, 'USAGE')
  t.is(refused.message, devices.OFF_REFUSED)
  const back = await p.call('device.reconnect', { name: 'Celular' })
  t.alike(back, { id: back.id, registered: true, off: false })
  t.alike(named(p.events, 'devices.changed'), [{ off: true }, { off: false }])
  const again = await p.call('device.reconnect', { name: 'Celular' }).catch((err) => err)
  t.is(again.message, devices.NOT_OFF)
})

// detach() lands during the refresh run (or, under load, just before it):
// either way the run did not finish for this connection, so no mark.
test('session: a disconnect whose refresh is cut by detach refuses and writes nothing', { timeout: 120000 }, async (t) => {
  const p = await person(t)
  await p.call('device.hello', { name: 'Celular' })
  const lost = rand()
  const pair = { group: rand(), writer: rand() }
  const before = await onDiary(p.ctx, async ({ diary, key }) => {
    await store.appendRecord(diary, groupJoinRecord({ ...pair, on: true }))
    await store.appendRecord(diary, devices.sealedRecord({ v: 1, id: lost, name: 'Perdido', on: true, writers: [pair] }, key))
    return diary.length
  })
  const pending = p.call('device.disconnect', { id: lost }).catch((err) => err)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  await p.session.detach()
  const e = await pending
  t.is(e.code, 'USAGE')
  t.is(e.message, 'conexão encerrada')
  t.is(await onDiary(p.ctx, async ({ diary }) => diary.length), before, 'no group-cut written')
  t.alike(named(p.events, 'groups.changed'), [])
})
