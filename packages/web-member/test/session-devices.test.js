'use strict'

// device.* through the browser node's session (docs/rpc.md 5.152 to
// 5.155): devices.changed, the refusals of a disconnected device, and
// device.reconnect only after a passkey ceremony in this open (`fresh`).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const devices = require('@varanda/core/lib/devices')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')

const hex = (buf) => b4a.toString(buf, 'hex')
const RECONNECT_PASSKEY = 'para conectar de novo, entre com a passkey'

// An account whose device id `store` turned off from another device.
async function offAccount () {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  const { id } = await ops.deviceHello(ctx, { name: 'Celular' })
  const diary = await store.openDiary(storage, keyPair)
  const k = devices.deviceKey(keyPair.secretKey, b4a.from(key, 'hex'))
  try {
    await store.appendRecord(diary, devices.sealedRecord({ v: 1, id, name: null, on: false, writers: [] }, k))
  } finally {
    devices.wipeKey(k)
    await diary.close()
  }
  return { storage, keyPair, prf, association, id }
}

async function open (t, account, options) {
  const node = createBrowserNode({
    storage: account.storage,
    association: account.association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(account.keyPair, { prf: account.prf, ...options })
  return connectClient(node)
}

const changed = (events) => events.filter((e) => e.name === 'devices.changed').map((e) => e.data)

test('session: hello registers and says so once', async (t) => {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const association = hex(assoc.publicKey)
  await ops.idCreate({ storage, association, keyPair })
  await ops.certAdd({ storage, association, keyPair }, createCert({ member: hex(keyPair.publicKey) }, assoc))
  const web = await open(t, { storage, keyPair, prf: crypto.randomBytes(32), association })
  const hello = await web.request('device.hello', { name: 'Celular' })
  t.alike(hello, { id: hello.id, registered: true, off: false })
  t.alike(await web.request('device.hello', { name: 'Outro' }), { id: hello.id, registered: false, off: false })
  const list = await web.request('device.list')
  t.alike(list.devices.map((d) => [d.name, d.self]), [['Celular', true]])
  t.alike(changed(web.events), [], 'a device never told it is off hears nothing')
})

test('session: a disconnected device is told so and cannot reconnect from a kept session', async (t) => {
  const account = await offAccount()
  const web = await open(t, account, {})
  t.alike(await web.request('device.hello', { name: 'Celular' }), { id: account.id, registered: false, off: true })
  t.alike(changed(web.events), [{ off: true }])
  const refused = await errorOf(web.request('device.disconnect', { previous: true }))
  t.is(refused.code, 'USAGE')
  t.is(refused.message, devices.OFF_REFUSED)
  const kept = await errorOf(web.request('device.reconnect', { name: 'Celular' }))
  t.is(kept.code, 'USAGE')
  t.is(kept.message, RECONNECT_PASSKEY)
  t.is((await web.request('device.list')).off, true, 'nothing written')
})

test('session: after a passkey ceremony in this open, reconnect registers a new id', async (t) => {
  const account = await offAccount()
  const web = await open(t, account, { fresh: true })
  t.is((await web.request('device.hello', { name: 'Celular' })).off, true)
  const back = await web.request('device.reconnect', { name: 'Celular' })
  t.alike(back, { id: back.id, registered: true, off: false })
  t.not(back.id, account.id)
  t.alike(changed(web.events), [{ off: true }, { off: false }])
  const again = await errorOf(web.request('device.reconnect', { name: 'Celular' }))
  t.is(again.message, devices.NOT_OFF)
})
