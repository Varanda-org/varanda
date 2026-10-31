'use strict'

// The write gate of a private group joined by key before its root arrived:
// the boxless writer that join created is one no seeder admits, so neither
// the gate nor the push confirmation may wait for it (docs/protocol.md
// "Private groups", rpc.md 6.1). Sync events are driven without sockets.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient } = require('./helpers/session')
const { until } = require('./helpers/net')

const hex = (buf) => b4a.toString(buf, 'hex')

async function setup (t, { assoc = generateAssociationKeyPair(), factory = createBrowserNode, writeGate = false, storage = memoryNodeStorage() } = {}) {
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  const internal = []
  const node = factory({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate,
    onInternalError: (err) => internal.push(err)
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  return { node, web, key, assoc, storage, internal }
}

async function share (from, to, core) {
  for (const key of [from.key, core]) {
    const diary = key === from.key
    const source = diary ? await store.openDiary(from.storage) : await store.openGroupCoreReadOnly(from.storage, key)
    const target = diary ? await store.openReplica(to.storage, key) : await store.openGroupReplica(to.storage, key)
    const a = source.replicate(true, { keepAlive: false })
    const b = target.replicate(false, { keepAlive: false })
    a.pipe(b).pipe(a)
    try {
      await target.download({ start: 0, end: source.length }).done()
    } finally {
      a.destroy()
      b.destroy()
      await source.close()
      await target.close()
    }
  }
  await store.addGroupDiary(to.storage, from.key)
  await store.addGroupReplica(to.storage, core)
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

function controlledSync () {
  const runs = []
  const factory = nodeWithSync(async ({ onEvent, signal, once }) => {
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    const result = { ok: true, errors: [], peers: 1, seederConfirmed: true }
    const stop = () => finish(result)
    signal.addEventListener('abort', stop)
    if (signal.aborted) stop()
    runs.push({ once, emit: onEvent, finish: stop, get aborted () { return signal.aborted } })
    try { return await done } finally { signal.removeEventListener('abort', stop) }
  })
  return {
    runs,
    factory,
    async next (index) {
      await until(() => runs[index], { name: 'sync run', timeoutMs: 2000 })
      return runs[index]
    }
  }
}

async function writerOf (m, group) {
  return (await store.readGroupWriters(m.storage)).find((e) => e.group === group).key
}

test('a boxless writer of a private group never holds the gate of the rejoin that replaces it', async (t) => {
  const a = await setup(t)
  const sync = controlledSync()
  const b = await setup(t, { assoc: a.assoc, factory: sync.factory, writeGate: true })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })

  const first = b.web.request('group.join', { group })
  const gate = await sync.next(0)
  gate.emit({ event: 'own-synced', length: 1 })
  const push = await sync.next(1)
  push.finish() // the seeder never takes the boxless writer: no group-pushed
  t.alike(await first, { state: 'pending' }, 'joined before the root was held')
  const boxless = await writerOf(b, group)

  await share(a, b, group)
  const second = b.web.request('group.join', { group }).catch((err) => err)
  const gate2 = await sync.next(2)
  gate2.emit({ event: 'own-synced', length: 2 })
  const push2 = await sync.next(3)
  push2.finish()
  t.alike(await second, { state: 'requested' }, 'the rejoin is not held by the refused writer')
  t.not(await writerOf(b, group), boxless, 'a boxed writer replaced it')
  t.alike(a.internal.concat(b.internal), [])
})
