'use strict'

// RPC and storage are real; the write-gate fixtures drive sync events without
// sockets so each ordering and cancellation can be exercised deterministically.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { verifyReport } = require('@varanda/core/lib/report')
const { createSession } = require('@varanda/core/lib/session')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession, toRpcError } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')
const { tmpDir, until } = require('./helpers/net')
const { METHODS } = require('@varanda/rpc')

const hex = (buf) => b4a.toString(buf, 'hex')
const KEY = 'ab'.repeat(32)
const LOCKED = 'identidade bloqueada: entre com a passkey'
const BEHIND = 'sincronize com o semeador antes de publicar'

async function setup (t, { assoc = generateAssociationKeyPair(), factory = createBrowserNode, writeGate = false, storage = memoryNodeStorage(), keyPair = crypto.keyPair(), prf = crypto.randomBytes(32) } = {}) {
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  if (!(await store.diaryStatus(storage)).exists) {
    await ops.idCreate(ctx)
    await ops.certAdd(ctx, createCert({ member: key }, assoc))
  }
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
  return { node, web, ctx, key, keyPair, prf, assoc, association, storage, internal }
}

async function share (from, to, group) {
  for (const key of [from.key, group]) {
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
  await store.addGroupReplica(to.storage, group)
}

// Reload only the transport and session while substituting the sync boundary.
// Restoring the cache keeps all other tests on the production modules.
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
  const factory = nodeWithSync(async ({ storage, onEvent, signal, once }) => {
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    const result = { ok: true, errors: [], peers: 1, seederConfirmed: true }
    const stop = () => finish(result)
    signal.addEventListener('abort', stop)
    if (signal.aborted) stop()
    const writers = new Map()
    for (const entry of await store.readGroupWriters(storage)) {
      for (const key of new Set([entry.key, ...(entry.rootNonce === null ? [] : [entry.group])])) {
        const core = await store.openGroupCoreReadOnly(storage, key)
        if (core === null) continue
        try { writers.set(key, core.length) } finally { await core.close() }
      }
    }
    const r = { once, writers, emit: onEvent, finish: stop, get aborted () { return signal.aborted } }
    runs.push(r)
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

// A community of `s` written by member-ops (no gate): -> { group } (its
// Geral, a group root of `s` at length 1 like a new group's).
async function geral (s) {
  return { group: (await ops.communityCreate(s.ctx, { name: 'Bairro', join: 'open' })).group }
}

// A community of `s` through the RPC: -> { community, group } (Geral).
function community (s, name = 'Bairro') {
  return s.web.request('community.create', { name, join: 'open' })
}

const COMMUNITY_METHODS = ['community.admin', 'community.admit', 'community.ban', 'community.create', 'community.info', 'community.invitePolicy', 'community.join', 'community.leave', 'community.list', 'community.members', 'community.meta', 'community.removeGroup', 'community.requests']

async function groupLength (s, group) {
  const core = await store.openGroupCoreReadOnly(s.storage, group)
  try { return core.length } finally { await core.close() }
}

test('group and community RPC handler names match the core session and the method table', async (t) => {
  const core = createSession({ dataDir: tmpDir(t), association: KEY, bootstrap: ['127.0.0.1:1'] })
  const browser = createBrowserSession({ storage: memoryNodeStorage(), association: KEY, seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => null })
  t.teardown(() => core.close(), { force: true })
  t.teardown(() => browser.close(), { force: true })
  const keys = (handlers, prefix) => Object.keys(handlers).filter((key) => key.startsWith(prefix)).sort()
  t.is(keys(core.handlers, 'group.').length, 17)
  t.alike(keys(browser.handlers, 'group.'), keys(core.handlers, 'group.'))
  t.alike(keys(browser.handlers, 'community.'), COMMUNITY_METHODS, 'every community method of protocol v2, no community.link')
  t.alike(METHODS.filter((m) => m.startsWith('community.')).sort(), COMMUNITY_METHODS, 'as the rpc method table')
  t.absent('community.link' in browser.handlers)
})

test('groups through connectClient: create, join, post, read and local events', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community: C, group: general } = await community(a)
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open', community: C })
  t.is((await a.web.request('node.info')).groups, true)
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === group)
  const kp = await groupKeyPairFromPrf(a.prf, b4a.from(entry.nonce, 'hex'))
  t.is(hex(kp.publicKey), group, 'the root uses the PRF derivation')
  t.alike(await a.web.request('group.post', { group, text: 'Olá' }), { seq: 1 })
  await share(a, b, C)
  await share(a, b, general)
  await share(a, b, group)
  t.alike(await b.web.request('community.join', { community: C }), { state: 'member', group: general })
  t.alike(await b.web.request('group.join', { group }), { state: 'member' })
  t.alike(await b.web.request('group.post', { group, text: 'Bom dia', replyTo: { writer: group, seq: 1 } }), { seq: 1 })
  const page = await b.web.request('group.read', { group })
  t.alike(page.items.map((p) => [p.diary, p.text]), [[b.key, 'Bom dia'], [a.key, 'Olá']])
  t.alike(page.items[0].replyTo, { writer: group, seq: 1 })
  t.is((await b.web.request('group.list')).total, 2, 'Geral and Horta')
  t.is((await b.web.request('group.info', { group })).members, 2)
  t.is((await b.web.request('group.members', { group })).total, 2)
  t.alike(await a.web.request('group.requests', { group }), { requests: [], total: 0 })
  t.alike(await a.web.request('group.meta', { group, name: 'Jardim' }), { ok: true })
  t.is((await a.web.request('group.info', { group })).name, 'Jardim')
  t.alike(await b.web.request('group.hide', { group, target: { writer: page.items[0].writer, seq: 1 }, on: true }), { ok: true })
  t.is((await b.web.request('group.read', { group })).items[0].hidden, true)
  for (const method of ['group.admin', 'group.ban', 'group.admit']) {
    const err = await errorOf(b.web.request(method, { group, member: a.key, on: true }))
    t.alike([err.code, err.message], ['USAGE', 'sem permissão no grupo'], method)
  }
  t.alike(await b.web.request('group.leave', { group }), { state: 'left' })
  const events = a.web.events.filter((e) => e.name === 'groups.changed')
  t.alike(events.map((e) => e.data), [{ group: C }, { group: general }, { group }, { group: C }, { group }, { group }], 'create (C, Geral), group.create (G, C), post, meta')
  const joined = b.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data.group)
  t.alike(joined.slice(0, 2), [C, general], 'community.join: C, then Geral')
  t.absent(a.web.events.some((e) => e.name === 'sync.started'), 'local reads and writes with the gate disabled never dial')
  t.alike(a.internal.concat(b.internal), [])
})

test('locked group writes fail, local reads stay available, and PRF bytes are copied', async (t) => {
  const s = await setup(t)
  const copy = b4a.from(s.prf)
  const unlocking = s.node.setKeyPair(s.keyPair, { prf: copy })
  copy.fill(0)
  await unlocking
  const { community: C } = await community(s)
  const { group } = await s.web.request('group.create', { name: 'Horta', join: 'open', community: C })
  const entry = (await store.readGroupWriters(s.storage)).find((e) => e.group === group)
  t.is(hex((await groupKeyPairFromPrf(s.prf, b4a.from(entry.nonce, 'hex'))).publicKey), group)
  await s.node.clearKeyPair()
  for (const [method, params] of [
    ['group.create', { name: 'Horta', join: 'open', community: C }],
    ['group.join', { group }], ['group.leave', { group }],
    ['community.create', { name: 'Outra', join: 'open' }],
    ['community.join', { community: C }], ['community.leave', { community: C }],
    ['community.meta', { community: C, name: 'x' }],
    ...['community.admit', 'community.ban', 'community.admin'].map((method) => [method, { community: C, member: KEY, on: true }]),
    ['group.post', { group, text: 'x' }], ['group.meta', { group, name: 'x' }],
    ['group.hide', { group, target: { writer: group, seq: 1 }, on: true }],
    ...['group.admit', 'group.ban', 'group.admin'].map((method) => [method, { group, member: KEY, on: true }])
  ]) {
    const err = await errorOf(s.web.request(method, params))
    t.alike([err.code, err.message], ['USAGE', LOCKED], method)
  }
  t.is((await s.web.request('group.read', { group })).items.length, 0)
  t.is((await s.web.request('group.list')).total, 2)
  t.is((await s.web.request('community.info', { community: C })).role, 'creator', 'community reads stay available')
  t.is((await s.web.request('group.info', { group })).state, 'member')
  t.is((await s.web.request('group.members', { group })).total, 1)
  t.is((await s.web.request('group.requests', { group })).total, 0)
  const row = (await s.web.request('community.info', { community: C })).groups.find((g) => g.group === group)
  t.alike([row.last, row.unread], [null, 0], 'community.info answers the private group while locked')
  t.alike(await s.web.request('group.seen', { group }), { ok: true }, 'group.seen answers while locked')
  await s.node.setKeyPair(s.keyPair)
  t.is((await errorOf(s.web.request('group.post', { group, text: 'x' }))).message, LOCKED, 'identity without PRF cannot sign a group writer')
  await s.node.setKeyPair(s.keyPair, { prf: s.prf })
  t.alike(await s.web.request('group.post', { group, text: 'desbloqueado' }), { seq: 1 })
  t.alike(s.internal, [])
})

test('group.seen through request: ok twice, no groups.changed, unread cleared, unknown key', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community: C, group } = await community(a)
  await a.web.request('group.post', { group, text: 'Olá' })
  await share(a, b, C)
  await share(a, b, group)
  await b.web.request('community.join', { community: C })
  const unread = async () => (await b.web.request('community.info', { community: C })).groups.find((g) => g.group === group).unread
  t.is(await unread(), 1)
  const before = b.web.events.filter((e) => e.name === 'groups.changed').length
  t.alike(await b.web.request('group.seen', { group }), { ok: true })
  t.alike(await b.web.request('group.seen', { group }), { ok: true })
  t.is(b.web.events.filter((e) => e.name === 'groups.changed').length, before, 'no groups.changed')
  t.is(await unread(), 0)
  const err = await errorOf(b.web.request('group.seen', { group: KEY }))
  t.alike([err.code, err.message], ['NOT_FOUND', 'grupo não encontrado'])
  t.alike(a.internal.concat(b.internal), [])
})

test('group error mapping and report.sign v2 bind writer and group', async (t) => {
  const s = await setup(t)
  const missing = await errorOf(s.web.request('group.read', { group: KEY }))
  t.alike([missing.code, missing.message], ['NOT_FOUND', 'grupo não encontrado'])
  for (const message of ['sem permissão no grupo', 'limite de grupos atingido', 'limite do grupo atingido', 'nada a alterar']) {
    t.is(toRpcError(new Error(message)).code, 'USAGE', message)
  }
  t.is(toRpcError(Object.assign(new Error('grupo não encontrado'), { code: 'NOT_FOUND' })).code, 'NOT_FOUND')
  const params = { nonce: 'A'.repeat(43), target: KEY, seq: 1, reason: 'spam', text: '', quote: 'oi', writer: 'cd'.repeat(32), group: 'ef'.repeat(32) }
  const { signature } = await s.web.request('report.sign', params)
  const fields = { ...params, member: s.key, association: s.association }
  t.alike(verifyReport(fields, signature), { ok: true })
  t.absent(verifyReport({ ...fields, writer: KEY }, signature).ok)
  t.absent(verifyReport({ ...fields, group: KEY }, signature).ok)
  delete params.writer
  delete params.group
  const diary = await s.web.request('report.sign', params)
  t.alike(verifyReport({ ...params, member: s.key, association: s.association }, diary.signature), { ok: true })
  t.absent(s.web.events.some((e) => e.name === 'sync.started'))
  t.alike(s.internal, [])
})

test('group write gate waits for its writer, forwards sync events and pushes the new length', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  const { group } = await geral(s)
  const posting = s.web.request('group.post', { group, text: 'depois da confirmação' })
  const gate = await sync.next(0)
  gate.emit({ event: 'own-synced', length: 2 })
  await new Promise((resolve) => setImmediate(resolve))
  t.absent(gate.aborted, 'the gate stays open until the writer confirmation')
  t.is(await groupLength(s, group), 1, 'a diary confirmation alone cannot release a group write')
  gate.emit({ event: 'groups-changed', group })
  gate.emit({ event: 'group-synced', key: group, length: 1 })
  const push = await sync.next(1)
  t.is(push.writers.get(group), 2, 'the restarted run includes the grown writer')
  push.emit({ event: 'group-pushed', key: group, length: 2 })
  push.finish()
  t.alike(await posting, { seq: 1 })
  t.alike(s.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data), [{ group }, { group }], 'one downloaded change and one local change')
  t.alike(s.web.events.filter((e) => e.name === 'sync.event').map((e) => e.data.line).filter((l) => l === BEHIND), [])
  t.alike(s.internal, [])
})

test('create and rejoin push writers created after the gate run snapshot', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  const { community: C } = await ops.communityCreate(s.ctx, { name: 'Bairro', join: 'open' })
  const creating = s.web.request('group.create', { name: 'Horta', join: 'open', community: C })
  const gate = await sync.next(0)
  t.is(gate.writers.size, 2, 'C and Geral roots')
  gate.emit({ event: 'own-synced', length: 3 })
  gate.emit({ event: 'group-synced', key: C, length: 2 })
  const push = await sync.next(1)
  t.is(push.writers.size, 3)
  t.is(push.writers.get(C), 3, 'the group-create in C\'s root is pushed')
  push.finish()
  const { group } = await creating
  t.is(push.writers.get(group), 1)
  t.alike(s.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data), [{ group }, { group: C }], 'group.create: G and C')
  await ops.groupLeave(s.ctx, { group })
  const joining = s.web.request('group.join', { group })
  const joiningGate = await sync.next(2)
  joiningGate.emit({ event: 'own-synced', length: 5 })
  joiningGate.emit({ event: 'group-synced', key: group, length: 2 })
  const joiningPush = await sync.next(3)
  t.is(joiningPush.writers.size, 4, 'the new writer and the retained creator root are both pushed, with C and Geral')
  joiningPush.finish()
  t.alike(await joining, { state: 'member' })
  t.alike(s.internal, [])
})

test('a behind or unconfirmed group writer refuses the write without retry', async (t) => {
  for (const behind of [true, false]) {
    const sync = controlledSync()
    const s = await setup(t, { factory: sync.factory, writeGate: true })
    const { group } = await geral(s)
    const pending = errorOf(s.web.request('group.post', { group, text: 'não gravado' }))
    const gate = await sync.next(0)
    gate.emit({ event: 'own-synced', length: 2 })
    if (behind) gate.emit({ event: 'group-behind', key: group, length: 1, theirs: 2 })
    else gate.finish()
    const err = await pending
    t.alike([err.code, err.message], ['USAGE', BEHIND])
    t.is(await groupLength(s, group), 1)
    t.is(sync.runs.length, 1, 'no push or automatic retry')
    t.alike(s.internal, [])
  }
})

test('a group-synced at a length shorter than the writer holds never releases a group write', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  const { group } = await geral(s)
  const pending = errorOf(s.web.request('group.post', { group, text: 'não gravado' }))
  const gate = await sync.next(0)
  gate.emit({ event: 'own-synced', length: 2 })
  gate.emit({ event: 'group-synced', key: group, length: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  t.absent(gate.aborted, 'a stale confirmation keeps the gate open')
  gate.finish()
  const err = await pending
  t.alike([err.code, err.message], ['USAGE', BEHIND])
  t.is(await groupLength(s, group), 1, 'nothing appended')
  t.is(sync.runs.length, 1, 'no push or automatic retry')
  t.alike(s.internal, [])
})

test('lock, reset and close cancel pending group writes and queued writes', async (t) => {
  for (const action of ['clearKeyPair', 'reset', 'close']) {
    const sync = controlledSync()
    const s = await setup(t, { factory: sync.factory, writeGate: true })
    const { group } = await geral(s)
    const first = errorOf(s.web.request('group.post', { group, text: 'pendente' }))
    await sync.next(0)
    const second = errorOf(s.web.request('group.post', { group, text: 'na fila' }))
    await new Promise((resolve) => setImmediate(resolve))
    await s.node[action]()
    t.ok(await first, action + ' cancels the gate')
    t.ok(await second, action + ' cancels the queue')
    t.is(sync.runs.length, 1, 'no push or new gate after ' + action)
    t.absent(s.web.events.some((e) => e.name === 'groups.changed'))
    if (action === 'clearKeyPair') t.is(await groupLength(s, group), 1)
    if (action === 'reset') t.absent(await store.groupCoreExists(s.storage, group), 'reset removes the group core')
    t.alike(s.internal, [])
  }
})

test('a continuous run confirms the group gate until the link closes', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  const { group } = await geral(s)
  await s.web.request('sync.start')
  const live = await sync.next(0)
  live.emit({ event: 'own-synced', length: 2 })
  live.emit({ event: 'group-synced', key: group, length: 1 })
  t.alike(await s.web.request('group.post', { group, text: 'primeiro' }), { seq: 1 })
  const restarted = await sync.next(1)
  t.is(restarted.once, false, 'the wanted continuous run restarts to push')
  t.is(restarted.writers.get(group), 2)
  t.is(sync.runs.length, 2, 'no internal gate or push was needed')
  restarted.emit({ event: 'own-synced', length: 2 })
  restarted.emit({ event: 'group-synced', key: group, length: 2 })
  restarted.emit({ event: 'link-closed' })
  restarted.emit({ event: 'own-synced', length: 2 })
  const pending = errorOf(s.web.request('group.post', { group, text: 'sem confirmação nova' }))
  const gate = await sync.next(2)
  t.is(gate.once, true, 'the old group confirmation cannot survive a reconnect')
  gate.emit({ event: 'own-synced', length: 2 })
  gate.finish()
  t.is((await pending).message, BEHIND)
  t.is(await groupLength(s, group), 2)
  await sync.next(3)
  await s.web.request('sync.stop')
  t.alike(s.internal, [])
})

test('locking during the push preserves the appended group post and cancels the request', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  const { group } = await geral(s)
  const pending = errorOf(s.web.request('group.post', { group, text: 'gravado antes do bloqueio' }))
  const gate = await sync.next(0)
  gate.emit({ event: 'own-synced', length: 2 })
  gate.emit({ event: 'group-synced', key: group, length: 1 })
  await sync.next(1)
  await s.node.clearKeyPair()
  t.is((await pending).message, LOCKED)
  t.is((await s.web.request('group.read', { group })).items[0].text, 'gravado antes do bloqueio')
  t.is(sync.runs.length, 2, 'the cancelled write is never retried')
  t.alike(s.internal, [])
})

test('reset removes a group core no group list names', async (t) => {
  const s = await setup(t)
  // A re-gate core left by a closed tab and a key sliced off a full list:
  // neither is in kv groupWriters, groupReplicas nor groupDiaries.
  const stray = await store.openGroupReplica(s.storage, hex(crypto.keyPair().publicKey))
  const kp = crypto.keyPair()
  const own = await store.openGroupWriter(s.storage, kp)
  await own.append({ type: 'x' })
  await stray.close()
  await own.close()
  const keys = [hex(stray.key), hex(kp.publicKey)]
  t.ok(await store.groupCoreExists(s.storage, keys[1]), 'stored before the reset')
  await s.node.reset()
  for (const key of keys) t.absent(await store.groupCoreExists(s.storage, key), 'unlisted group core removed')
  t.alike(await store.readGroupCoreKeys(s.storage), [])
  t.alike(s.internal, [])
})

test('reset removes every group core, the group kv lists and unfollowed binding replicas', async (t) => {
  const a = await setup(t)
  const c = await setup(t, { assoc: a.assoc })
  const b = await setup(t, { assoc: a.assoc })
  const { community: ca, group: ga } = await community(a, 'Horta')
  const { community: cc, group: gc } = await community(c, 'Feira')
  const { community: cb, group: gb } = await community(b, 'Própria')
  await share(a, b, ca)
  await share(a, b, ga)
  await share(c, b, gc)
  await store.writeFollows(b.storage, [c.key])
  t.alike(await b.web.request('community.join', { community: ca }), { state: 'member', group: ga })
  const own = (await store.readGroupWriters(b.storage)).find((e) => e.group === ga)
  const cw = (await store.readGroupWriters(b.storage)).find((e) => e.group === ca)
  const cores = [ga, gc, gb, cb, ca, own.key, cw.key]
  t.absent(await store.groupCoreExists(b.storage, cc), 'C of c never shared')
  for (const key of cores) t.ok(await store.groupCoreExists(b.storage, key), 'stored before the reset')
  await b.node.reset()
  for (const key of cores) t.absent(await store.groupCoreExists(b.storage, key), 'group core removed')
  t.alike(await store.readGroupWriters(b.storage), [])
  t.alike(await store.readGroupReplicas(b.storage), [])
  t.alike(await store.readGroupDiaries(b.storage), [])
  t.absent(await store.replicaExists(b.storage, a.key), 'an unfollowed binding replica goes')
  t.ok(await store.replicaExists(b.storage, c.key), 'a followed one stays with its follow')
  t.alike(b.internal, [])
})

test('private groups: locked state wipes keys and reads sealed, unlock and a reload read again, reset drops the box nonce', async (t) => {
  const a = await setup(t)
  const { community: C } = await community(a)
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private', community: C })
  await a.web.request('group.post', { group, text: 'só para membros' })
  t.alike((await a.web.request('group.read', { group })).items.map((p) => p.text), ['só para membros'])

  await a.node.clearKeyPair()
  const locked = await a.web.request('group.read', { group })
  t.alike([locked.state, locked.items, locked.sealed, locked.epoch], ['locked', [], 2, null], 'keys wiped: sealed while locked')
  t.is((await a.web.request('group.info', { group })).name, null)
  let err = await errorOf(a.web.request('group.post', { group, text: 'x' }))
  t.alike([err.code, err.message], ['USAGE', LOCKED])
  err = await errorOf(a.web.request('group.rekey', { group }))
  t.alike([err.code, err.message], ['USAGE', LOCKED])

  await a.node.setKeyPair(a.keyPair, { prf: a.prf })
  const again = await a.web.request('group.read', { group })
  t.alike([again.state, again.items.map((p) => p.text)], ['ok', ['só para membros']], 'readable after unlock')

  // A reload: a new node over the same storage with the persistent session's PRF.
  await a.node.close()
  const b = await setup(t, { assoc: a.assoc, storage: a.storage, keyPair: a.keyPair, prf: a.prf })
  t.alike((await b.web.request('group.read', { group })).items.map((p) => p.text), ['só para membros'], 'keys reopened from the blocks')
  t.is((await b.web.request('group.info', { group })).name, 'Segredo')
  t.ok(await a.storage.readJson('groupBoxDevice'))
  await b.node.reset()
  t.is(await a.storage.readJson('groupBoxDevice'), null, 'reset clears the box nonce')
  t.alike(a.internal.concat(b.internal), [])
})

async function diaryLength (s) {
  const diary = await store.openDiary(s.storage)
  try { return diary.length } finally { await diary.close() }
}

test('a community-authority ban waits for the caller\'s community writer and pushes it', async (t) => {
  const sync = controlledSync()
  const a = await setup(t)
  const s = await setup(t, { assoc: a.assoc, factory: sync.factory, writeGate: true })
  // A creates C and G (only the creator creates groups); S joins C and is
  // made admin: it holds G but no writer in it, so its ban goes to its CW.
  const { community: C } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group: G } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community: C })
  await share(a, s, C)
  t.is((await ops.communityJoin(s.ctx, { community: C })).state, 'member')
  const cw = (await store.readGroupWriters(s.storage)).find((e) => e.group === C).key
  await share(s, a, cw)
  await ops.communitySetAdmin(a.ctx, { community: C, member: s.key, on: true })
  await share(a, s, C)
  await share(a, s, G)
  t.absent((await store.readGroupWriters(s.storage)).some((e) => e.group === G), 'S holds no writer in G')

  const before = await groupLength(s, cw)
  const banning = s.web.request('group.ban', { group: G, member: KEY, on: true })
  const gate = await sync.next(0)
  t.is(gate.writers.get(cw), before, 'the gate run holds the CW')
  gate.emit({ event: 'own-synced', length: await diaryLength(s) })
  await new Promise((resolve) => setImmediate(resolve))
  t.absent(gate.aborted, 'the gate waits for the community writer')
  t.is(sync.runs.length, 1, 'nothing written yet')
  gate.emit({ event: 'group-synced', key: cw, length: before })
  const push = await sync.next(1)
  t.is(push.writers.get(cw), before + 1, 'the ban went to the CW and the push carries its new length')
  push.emit({ event: 'group-pushed', key: cw, length: before + 1 })
  push.finish()
  t.alike(await banning, { ok: true })
  t.alike(s.internal, [])
})

// Opens the gate of `gate` for every own core but `held`: the write must
// still wait for `held`.
async function gateWaitsFor (t, sync, gate, s, others, held, label) {
  gate.emit({ event: 'own-synced', length: await diaryLength(s) })
  for (const [key, length] of others) gate.emit({ event: 'group-synced', key, length })
  await new Promise((resolve) => setImmediate(resolve))
  t.absent(gate.aborted, label)
  t.is(sync.runs.length, 1, 'nothing written yet')
  gate.emit({ event: 'group-synced', key: held, length: gate.writers.get(held) })
}

test('community.leave waits for the device\'s group writers before appending to them', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  const a = await setup(t, { assoc: s.assoc })
  const { community: C, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  await share(a, s, C)
  await share(a, s, general)
  t.alike(await ops.communityJoin(s.ctx, { community: C }), { state: 'member', group: general })
  const kv = await store.readGroupWriters(s.storage)
  const cw = kv.find((e) => e.group === C).key
  const gw = kv.find((e) => e.group === general).key
  const leaving = s.web.request('community.leave', { community: C })
  const gate = await sync.next(0)
  await gateWaitsFor(t, sync, gate, s, [[cw, gate.writers.get(cw)]], gw, 'the gate waits for the Geral writer')
  const push = await sync.next(1)
  t.ok(push.writers.has(gw) && push.writers.has(cw), 'the push carries the CW and the Geral writer')
  push.finish()
  t.alike(await leaving, { state: 'left' })
  t.alike(s.internal, [])
})

test('community.ban waits for a private group root before rotating its key', async (t) => {
  // Built through the RPC without the gate (private groups need the box),
  // then reopened with it.
  const s0 = await setup(t)
  const m = await setup(t, { assoc: s0.assoc })
  const { community: C, group: general } = await s0.web.request('community.create', { name: 'Bairro', join: 'open' })
  const { group: P } = await s0.web.request('group.create', { name: 'Conselho', join: 'open', visibility: 'private', community: C })
  await s0.web.request('group.post', { group: P, text: 'segredo' })
  await share(s0, m, C)
  t.is((await m.web.request('community.join', { community: C })).state, 'member')
  await share(m, s0, (await store.readGroupWriters(m.storage)).find((e) => e.group === C).key)
  await share(s0, m, P)
  t.is((await m.web.request('group.join', { group: P })).state, 'requested')
  await share(m, s0, (await store.readGroupWriters(m.storage)).find((e) => e.group === P).key)
  t.alike(await s0.web.request('group.admit', { group: P, member: m.key, on: true }), { ok: true })
  await s0.node.close()
  const sync = controlledSync()
  const s = await setup(t, { assoc: s0.assoc, storage: s0.storage, keyPair: s0.keyPair, prf: s0.prf, factory: sync.factory, writeGate: true })
  const before = await groupLength(s, P)
  const banning = s.web.request('community.ban', { community: C, member: m.key, on: true })
  const gate = await sync.next(0)
  await gateWaitsFor(t, sync, gate, s, [[C, gate.writers.get(C)], [general, gate.writers.get(general)]], P, 'the gate waits for the private root')
  const push = await sync.next(1)
  t.ok(push.writers.get(P) > before, 'the rotation went to the private root and is pushed')
  push.finish()
  t.alike(await banning, { ok: true })
  t.alike(s.internal, [])
})

test('a resumed community.create waits for the roots of its plan', async (t) => {
  const sync = controlledSync()
  const s = await setup(t, { factory: sync.factory, writeGate: true })
  let calls = 0
  const failing = { ...s.ctx, groupKeyPair: (nonce) => { if (++calls === 5) throw new Error('falha injetada'); return s.ctx.groupKeyPair(nonce) } }
  await t.exception(() => ops.communityCreate(failing, { name: 'Bairro', join: 'open' }), /falha injetada/)
  const plan = await store.readCommunityCreate(s.storage)
  t.is(await groupLength(s, plan.community), 1, 'stopped before the group-create')
  const creating = s.web.request('community.create', { name: 'Bairro', join: 'open' })
  const gate = await sync.next(0)
  await gateWaitsFor(t, sync, gate, s, [[plan.group, gate.writers.get(plan.group)]], plan.community, 'the gate waits for the community root')
  const push = await sync.next(1)
  t.is(push.writers.get(plan.community), 2, 'the resumed group-create is pushed')
  push.finish()
  t.alike(await creating, { community: plan.community, group: plan.group })
  t.alike(s.internal, [])
})
