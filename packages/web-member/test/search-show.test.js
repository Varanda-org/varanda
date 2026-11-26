'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createClient } = require('@varanda/rpc')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord } = require('@varanda/core/lib/records')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { openDiary } = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')

async function certified (t, { factory = createBrowserNode, writeGate = false } = {}) {
  const association = generateAssociationKeyPair()
  const node = factory({
    storage: memoryNodeStorage(),
    association: b4a.toString(association.publicKey, 'hex'),
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('no network in this test') },
    writeGate
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node)
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, association) })
  return { node, web }
}

function nodeWithSync (runSync) {
  const sync = require('../lib/sync')
  const original = sync.runSync
  const ids = [require.resolve('../lib/node'), require.resolve('../lib/session')]
  const cached = ids.map((id) => require.cache[id])
  try {
    sync.runSync = runSync
    for (const id of ids) delete require.cache[id]
    return require('../lib/node').createBrowserNode
  } finally {
    sync.runSync = original
    ids.forEach((id, i) => { require.cache[id] = cached[i] })
  }
}

test('search.show writes only changes and tombstones the superseded setting', async (t) => {
  const { web } = await certified(t)
  const show = (on) => web.request('search.show', { on })
  const log = () => web.request('log.read')
  const initial = await log()
  t.alike(await show(true), { seq: null, on: true, changed: false })
  t.alike(await log(), initial, 'shown by default')
  t.alike(await web.request('search.state'), { on: true, seq: null }, 'state: shown by default')

  t.alike(await show(false), { seq: 1, on: false, changed: true })
  const hidden = await log()
  const off = hidden.entries[1]
  t.alike([off.record.type, off.record.on], ['search-show', false])
  t.is(validateRecord(off.record, off.seq), null, 'the node supplies a valid timestamp')
  t.alike(await show(false), { seq: 1, on: false, changed: false })
  t.alike(await log(), hidden)
  t.alike(await web.request('search.state'), { on: false, seq: 1 })

  t.alike(await show(true), { seq: 3, on: true, changed: true })
  const shown = await log()
  t.alike(shown.entries.map((e) => [e.seq, e.record.type]), [[0, 'member-cert'], [2, 'delete'], [3, 'search-show']])
  t.is(shown.entries[1].record.seq, off.seq)
  t.is(shown.entries[2].record.on, true)
  t.alike(await show(true), { seq: 3, on: true, changed: false })
  t.alike(await log(), shown)
  t.alike(await web.request('search.state'), { on: true, seq: 3 })
})

test('a repeat search.show pushes the hide the seeder has not confirmed', async (t) => {
  const factory = nodeWithSync(async ({ storage, onEvent }) => {
    const diary = await openDiary(storage)
    const length = diary.length
    await diary.close()
    onEvent({ event: 'own-synced', length })
    return { ok: true, errors: [], peers: 1, seederConfirmed: false }
  })
  const { web } = await certified(t, { factory, writeGate: true })
  t.alike(await web.request('search.show', { on: false }), { seq: 1, on: false, changed: true })
  const stopped = web.events.findLast((e) => e.name === 'sync.stopped')
  t.is(stopped?.data.result?.seederConfirmed, false, 'the hide is still unconfirmed')

  const from = web.events.length
  t.alike(await web.request('search.show', { on: false }), { seq: 1, on: false, changed: false })
  const events = web.events.slice(from)
  const runs = events.filter((e) => e.name === 'sync.started').map(({ data: { runId, once } }) => {
    const first = events.find((e) => e.name === 'sync.event' && e.data.runId === runId)
    return [once, first?.data.line]
  })
  t.alike(runs, [[true, 'sincronizando antes de publicar'], [true, 'enviando ao semeador']], 'the repeat starts a push after the write gate')
})

test('search.show refuses a locked identity', async (t) => {
  const { node, web } = await certified(t)
  await node.clearKeyPair()
  const err = await errorOf(web.request('search.show', { on: false }))
  t.alike([err.code, err.message], ['USAGE', 'identidade bloqueada: entre com a passkey'])
})

test('search.show is uncertain when the connection closes after sending', async (t) => {
  const sent = []
  const client = createClient({ send: (message) => sent.push(message.method) })
  const pending = errorOf(client.request('search.show', { on: false }))
  client.close()
  const err = await pending
  t.alike([err.code, err.uncertain], ['CLOSED', true])
  t.alike(sent, ['search.show'])
})
