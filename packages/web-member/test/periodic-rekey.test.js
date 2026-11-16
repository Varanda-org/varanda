'use strict'

// The periodic rotation of a private group's epoch key on the browser node
// (docs/protocol.md "Rotation", @varanda/core lib/group-rekey.js): the
// member-ops plan and write step with an injected clock, and the session's
// upkeep pass that runs them. Cores move between storages by direct
// replication; the session tests replace the sync boundary as
// session-upkeep.test.js does.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { REKEY_PERIOD_MS, REKEY_OTHER_WAIT_MS, REKEY_JITTER_MS, REKEY_CHECK_MS } = require('@varanda/core/lib/group-rekey')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient } = require('./helpers/session')
const { until } = require('./helpers/net')

const hex = (buf) => b4a.toString(buf, 'hex')
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const texts = (page) => page.items.map((p) => p.text)

// Every group lives in a community: the first group.create of a device
// makes an open one, and a group.join enters it first (as private-ops).
const ownCommunity = new Map()
const owners = new Map()
const groupCommunity = new Map()

async function pipe (source, target) {
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    if (source.length > 0) await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

async function copyCore (from, to, key) {
  const source = await store.openGroupCoreReadOnly(from.storage, key)
  if (source === null) return
  await pipe(source, await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
}

async function copyDiary (from, to) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  await store.addGroupDiary(to.storage, from.key)
}

async function copyCommunityCores (from, to) {
  for (const e of await store.readGroupWriters(from.storage)) {
    if (e.kind !== 'community') continue
    await copyCore(from, to, e.key)
    if (e.key !== e.group) await copyCore(from, to, e.group)
  }
}

// `from`'s diary, the group core `core` and its community cores into `to`.
async function share (from, to, core) {
  await copyDiary(from, to)
  await copyCore(from, to, core)
  await copyCommunityCores(from, to)
}

function inCommunity (m) {
  const request = m.web.request
  m.web.request = async (method, params = {}) => {
    if (method === 'group.create' && params.community === undefined) {
      if (!ownCommunity.has(m.storage)) {
        const { community } = await request('community.create', { name: 'Bairro', join: 'open' })
        ownCommunity.set(m.storage, community)
        owners.set(community, m)
      }
      const community = ownCommunity.get(m.storage)
      const res = await request(method, { ...params, community })
      groupCommunity.set(res.group, community)
      return res
    }
    if (method === 'group.join' && groupCommunity.has(params.group)) {
      const community = groupCommunity.get(params.group)
      const owner = owners.get(community)
      if (owner.storage !== m.storage && !(await store.readGroupWriters(m.storage)).some((e) => e.group === community)) {
        await copyCore(owner, m, community)
        await copyDiary(owner, m)
        await ops.communityJoin(m.ctx, { community })
      }
      return request(method, { community, ...params })
    }
    return request(method, params)
  }
  return m
}

async function setup (t, { assoc = generateAssociationKeyPair(), storage = memoryNodeStorage(), keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), factory = createBrowserNode, ...options } = {}) {
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
    writeGate: false,
    onInternalError: (err) => internal.push(err),
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  return inCommunity({ node, web, ctx, key, keyPair, prf, assoc, storage, internal })
}

// The member-ops context of `m` with an unlocked key holder of its own.
async function opsCtx (t, m, extra = {}) {
  const groupKeys = createGroupKeys()
  await groupKeys.unlock(m.storage, m.prf)
  t.teardown(() => groupKeys.close())
  return { ...m.ctx, groupKeys, ...extra }
}

async function writerOf (m, group) {
  return (await store.readGroupWriters(m.storage)).find((e) => e.group === group).key
}

async function coreRecords (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try {
    return (await store.readAll(core)).map((e) => e.record)
  } finally {
    await core.close()
  }
}

async function coreBytes (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try { return core.byteLength } finally { await core.close() }
}

const firstBlocks = (records) => records.filter((r) => r.type === 'group-key' && r.kid === null).length

// a creates a private group and posts; b joins and a admits it.
async function admitted (t) {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  await a.web.request('group.post', { group, text: 'antes da troca' })
  await share(a, b, group)
  t.is((await b.web.request('group.join', { group })).state, 'requested')
  const bw = await writerOf(b, group)
  await share(b, a, bw)
  t.alike(await a.web.request('group.admit', { group, member: b.key, on: true }), { ok: true })
  await share(a, b, group)
  return { a, b, group, bw }
}

test('a due group rotates once, and every member reads after the rotation', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  const ctx = await opsCtx(t, a)
  const before = (await a.web.request('group.read', { group })).epoch
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE

  const plan = await ops.periodicRekeyPlan(ctx, { now })
  t.alike(plan.rekey, [{ group, writer: group }], 'the creator\'s root is due')
  t.alike(plan.checked, [group])
  const res = await ops.periodicRekey(ctx, { groups: plan.rekey, now })
  t.alike(res, { rotated: [group], failed: [] })
  const after = (await a.web.request('group.read', { group }))
  t.is(after.state, 'ok')
  t.not(after.epoch.seq, before.seq, 'a new epoch in use')
  const records = await coreRecords(a, group)
  t.is(firstBlocks(records), 2, 'one rotation')
  t.ok(records[after.epoch.seq].keys.some((k) => k.writer === bw), 'sealed to the member too')

  // The new epoch is idle and young: nothing more is due.
  t.alike((await ops.periodicRekeyPlan(ctx, { now })).rekey, [])
  t.alike(await ops.periodicRekey(ctx, { groups: [group], now }), { rotated: [], failed: [] })
  t.is(firstBlocks(await coreRecords(a, group)), 2, 'still one rotation')

  await a.web.request('group.post', { group, text: 'depois da troca' })
  await share(a, b, group)
  const page = await b.web.request('group.read', { group })
  t.is(page.state, 'ok')
  t.alike(page.epoch, after.epoch, 'the member sends under the new epoch')
  t.alike(texts(page).sort(), ['antes da troca', 'depois da troca'])
  await b.web.request('group.post', { group, text: 'da Bia' })
  await share(b, a, bw)
  t.ok(texts(await a.web.request('group.read', { group })).includes('da Bia'), 'the creator reads the member')
  t.alike(a.internal.concat(b.internal), [])
})

test('a group not due yet does not rotate, and says when it will be', async (t) => {
  const { a, group } = await admitted(t)
  const ctx = await opsCtx(t, a)
  const opened = Date.parse((await coreRecords(a, group))[1].at)
  const now = opened + REKEY_PERIOD_MS - MINUTE
  const plan = await ops.periodicRekeyPlan(ctx, { now })
  t.alike(plan.rekey, [])
  t.alike(plan.checked, [group])
  t.is(plan.next, opened + REKEY_PERIOD_MS, 'due at T after the first block')
  t.alike(await ops.periodicRekey(ctx, { groups: [group], now }), { rotated: [], failed: [] })
  t.is(firstBlocks(await coreRecords(a, group)), 1)
  // ready() skips a group the caller checked recently.
  t.alike((await ops.periodicRekeyPlan(ctx, { now: now + 2 * MINUTE, ready: () => false })).checked, [])
})

test('a failed rotation writes nothing and leaves the group not rekey-pending', async (t) => {
  const { a, group } = await admitted(t)
  // Room above the 10% reserve, but less than the rotation needs.
  const bytes = await coreBytes(a, group)
  const free = Math.ceil(bytes / 9) + 1
  const ctx = await opsCtx(t, a, { limits: { maxLogBytes: bytes + free } })
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE
  const plan = await ops.periodicRekeyPlan(ctx, { now })
  t.alike(plan.rekey, [{ group, writer: group }], 'due, the reserve is kept')
  const res = await ops.periodicRekey(ctx, { groups: [group], now })
  t.alike(res.rotated, [])
  t.alike(res.failed.map((f) => f.group), [group])
  t.is(res.failed[0].message, 'rotação grande demais para o espaço do diário')
  t.is(firstBlocks(await coreRecords(a, group)), 1, 'no block written')
  const page = await a.web.request('group.read', { group })
  t.is(page.state, 'ok', 'not rekey-pending')
  t.ok(Number.isSafeInteger((await a.web.request('group.post', { group, text: 'segue' })).seq), 'still posts under the old epoch')
})

// `from`'s diary blocks [start, end) into `to`'s replica, nothing else: the
// blocks before start that `to` lacks stay a hole.
async function copyDiaryRange (from, to, start, end) {
  const source = await store.openDiary(from.storage)
  const target = await store.openReplica(to.storage, from.key)
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start, end }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

test('a hole in an entitled member\'s diary keeps the periodic rotation waiting, and once it fills it runs', async (t) => {
  const { a, b, group } = await admitted(t)
  const ctx = await opsCtx(t, a)
  const held = await diaryLength(b)
  await b.web.request('post.create', { text: 'um' })
  await b.web.request('post.create', { text: 'dois' })
  // a gets the second post but not the first: a hole that may hide a cut on
  // the member's writer.
  await copyDiaryRange(b, a, held + 1, held + 2)
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE
  const plan = await ops.periodicRekeyPlan(ctx, { now })
  t.alike(plan.rekey, [], 'due, but the cut is unknown')
  t.alike(plan.checked, [group])
  t.is(plan.next, now + REKEY_CHECK_MS, 'checked again at the next check')
  t.alike(await ops.periodicRekey(ctx, { groups: [group], now }), { rotated: [], failed: [] })
  t.is(firstBlocks(await coreRecords(a, group)), 1, 'nothing written')

  await copyDiaryRange(b, a, held, held + 1)
  const later = now + REKEY_CHECK_MS
  const filled = await ops.periodicRekeyPlan(ctx, { now: later })
  t.alike(filled.rekey, [{ group, writer: group }], 'the hole filled: due')
  t.alike(await ops.periodicRekey(ctx, { groups: filled.rekey, now: later }), { rotated: [group], failed: [] })
  t.is(firstBlocks(await coreRecords(a, group)), 2, 'rotated once')
})

test('a plain member never rotates', async (t) => {
  const { b, group } = await admitted(t)
  const ctx = await opsCtx(t, b)
  const now = Date.now() + 365 * DAY
  const plan = await ops.periodicRekeyPlan(ctx, { now })
  t.alike([plan.rekey, plan.checked, plan.next], [[], [], null])
  t.alike(await ops.periodicRekey(ctx, { groups: [group], now }), { rotated: [], failed: [] })
  t.is(firstBlocks(await coreRecords(b, group)), 1)
  t.is(firstBlocks(await coreRecords(b, await writerOf(b, group))), 0)
})

test('locked: nothing is planned', async (t) => {
  const { a } = await admitted(t)
  const plan = await ops.periodicRekeyPlan({ ...a.ctx, groupKeys: createGroupKeys() }, { now: Date.now() + 365 * DAY })
  t.alike(plan, { rekey: [], checked: [], next: null })
})

test('two distributors: the opener rotates at once, the other waits 48 h plus its jitter', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  t.alike(await a.web.request('group.admin', { group, member: b.key, on: true }), { ok: true })
  await share(a, b, group)
  t.is((await b.web.request('group.info', { group })).role, 'admin')
  const actx = await opsCtx(t, a)
  const bctx = await opsCtx(t, b)
  const opened = Date.parse((await coreRecords(a, group))[1].at)
  const due = opened + REKEY_PERIOD_MS
  const jitter = () => 0.5
  const wait = due + REKEY_OTHER_WAIT_MS + Math.floor(0.5 * REKEY_JITTER_MS)

  const bPlan = await ops.periodicRekeyPlan(bctx, { now: due, jitter })
  t.alike(bPlan.rekey, [], 'the other admin waits')
  t.is(bPlan.next, wait)
  t.alike(await ops.periodicRekey(bctx, { groups: [group], now: due, jitter }), { rotated: [], failed: [] })
  t.alike((await ops.periodicRekeyPlan(actx, { now: due, jitter })).rekey, [{ group, writer: group }], 'the opener is due')

  // Had the opener stayed away, the other admin rotates after its wait.
  t.alike((await ops.periodicRekeyPlan(bctx, { now: wait, jitter })).rekey, [{ group, writer: bw }])

  // The opener rotates; once that reaches the other admin, nothing is due.
  t.alike((await ops.periodicRekey(actx, { groups: [group], now: due, jitter })).rotated, [group])
  await share(a, b, group)
  t.alike((await ops.periodicRekeyPlan(bctx, { now: wait, jitter })).rekey, [], 'the new epoch is idle')
  t.alike(await ops.periodicRekey(bctx, { groups: [group], now: wait, jitter }), { rotated: [], failed: [] })
  t.is(firstBlocks(await coreRecords(b, bw)), 0, 'the other admin never rotated')
  t.is(firstBlocks(await coreRecords(a, group)), 2)
})

// ---- the session ----

// Reload only the transport and session while substituting the sync boundary.
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

// Each run lends the own diary and waits for its abort; the test drives its
// events by hand.
function controlledSync ({ lendGroups = false } = {}) {
  const runs = []
  const factory = nodeWithSync(async ({ storage, onEvent, signal, once, reader }) => {
    const diary = await store.openDiary(storage)
    // The stored group cores, as the real run lends them to withCores.
    const lent = new Map()
    if (lendGroups) {
      for (const entry of await store.readGroupWriters(storage)) {
        for (const key of new Set([entry.key, ...(entry.rootNonce === null ? [] : [entry.group])])) {
          const core = await store.openGroupCoreReadOnly(storage, key)
          if (core !== null) lent.set(key, core)
        }
      }
    }
    if (reader) reader.set({ diary, replica: () => null, ...(lendGroups ? { group: (key) => lent.get(key) || null } : {}), hold: () => true, release: () => {} })
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    const stop = () => finish({ ok: true, errors: [], peers: 1, seederConfirmed: true })
    signal.addEventListener('abort', stop)
    if (signal.aborted) stop()
    runs.push({ once, emit: onEvent, get aborted () { return signal.aborted } })
    try {
      return await done
    } finally {
      signal.removeEventListener('abort', stop)
      if (reader) reader.clear()
      diary.close().catch(() => {})
      for (const core of lent.values()) core.close().catch(() => {})
    }
  })
  return { runs, factory, last: () => runs[runs.length - 1] }
}

async function diaryLength (s) {
  const core = await store.openDiary(s.storage)
  try { return core.length } finally { await core.close() }
}

// A device with a private group P holding one post, reopened on a
// controlled sync with the clock `clock`.
async function creator (t, clock, { lendGroups = false } = {}) {
  const a0 = await setup(t)
  const { community } = await a0.web.request('community.create', { name: 'Bairro', join: 'open' })
  const { group } = await a0.web.request('group.create', { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await a0.web.request('group.post', { group, text: 'antes' })
  await a0.node.close()
  const sync = controlledSync({ lendGroups })
  const a = await setup(t, { assoc: a0.assoc, storage: a0.storage, keyPair: a0.keyPair, prf: a0.prf, factory: sync.factory, upkeepDelayMs: 20, rekeyClock: clock, rekeyRandom: () => 0 })
  await a.web.request('sync.start')
  return { a, sync, group }
}

const changedOf = (s) => s.web.events.filter((e) => e.name === 'groups.changed').map((e) => e.data.group)
const warningsOf = (s) => s.web.events.filter((e) => e.name === 'warning').map((e) => e.data.line)

// A new own length on the live run: the upkeep arms and runs a pass.
async function armPass (a, sync, length) {
  await until(() => sync.last() && !sync.last().aborted && !sync.last().once, { name: 'a live run', timeoutMs: 5000 })
  sync.last().emit({ event: 'own-synced', length })
}

test('session: a due group rotates once in the upkeep pass', async (t) => {
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE
  const { a, sync, group } = await creator(t, () => now)
  const length = await diaryLength(a)
  await armPass(a, sync, length)
  await until(async () => firstBlocks(await coreRecords(a, group)) === 2, { name: 'the rotation', timeoutMs: 10000 })
  await until(() => changedOf(a).includes(group), { name: 'groups.changed', timeoutMs: 5000 })
  const page = await a.web.request('group.read', { group })
  t.is(page.state, 'ok')
  t.is(page.epoch.writer, group)
  t.ok(page.epoch.seq > 1, 'the new epoch is in use')

  // Another pass in the same hour, and later: the new epoch is idle.
  await armPass(a, sync, length + 1)
  await pause(300)
  t.is(firstBlocks(await coreRecords(a, group)), 2, 'rotated once')
  t.alike(warningsOf(a), [])
  await a.web.request('sync.stop')
  t.alike(a.internal, [])
})

test('session: a group not due is left alone', async (t) => {
  const now = Date.now() + REKEY_PERIOD_MS - DAY
  const { a, sync, group } = await creator(t, () => now)
  const spy = []
  const plan = ops.periodicRekeyPlan
  ops.periodicRekeyPlan = async function () {
    const out = await plan.apply(this, arguments)
    spy.push(out)
    return out
  }
  t.teardown(() => { ops.periodicRekeyPlan = plan })
  await armPass(a, sync, await diaryLength(a))
  await until(() => spy.length > 0, { name: 'the plan', timeoutMs: 5000 })
  await pause(200)
  t.alike(spy[0].rekey, [])
  t.alike(spy[0].checked, [group])
  t.is(firstBlocks(await coreRecords(a, group)), 1)
  await a.web.request('sync.stop')
})

test('session: a failed rotation is not retried within the hour, and the group stays not rekey-pending', async (t) => {
  let now = Date.now() + REKEY_PERIOD_MS + MINUTE
  const { a, sync, group } = await creator(t, () => now)
  const write = ops.periodicRekey
  let calls = 0
  let fail = true
  ops.periodicRekey = async function () {
    calls++
    if (fail) throw new Error('falha simulada')
    return write.apply(this, arguments)
  }
  t.teardown(() => { ops.periodicRekey = write })
  const length = await diaryLength(a)
  await armPass(a, sync, length)
  await until(() => calls === 1, { name: 'the failed write', timeoutMs: 5000 })
  await pause(200)
  t.is((await a.web.request('group.read', { group })).state, 'ok', 'not rekey-pending')
  t.is(firstBlocks(await coreRecords(a, group)), 1)
  t.alike(warningsOf(a), [], 'a failure is no warning')

  now += REKEY_CHECK_MS - MINUTE
  fail = false
  await armPass(a, sync, length + 1)
  await pause(400)
  t.is(calls, 1, 'not retried within the hour')

  now += 2 * MINUTE
  await armPass(a, sync, length + 2)
  await until(() => calls === 2, { name: 'the next check', timeoutMs: 5000 })
  await until(async () => firstBlocks(await coreRecords(a, group)) === 2, { name: 'the rotation', timeoutMs: 10000 })
  await a.web.request('sync.stop')
})

test('session: a grown group starts a rotation-only pass on the run\'s cores, at most once an hour', async (t) => {
  let offset = REKEY_PERIOD_MS - DAY
  const clock = () => Date.now() + offset
  const { a, sync, group } = await creator(t, clock, { lendGroups: true })
  const spy = []
  const plan = ops.periodicRekeyPlan
  ops.periodicRekeyPlan = async function (c, opts) {
    spy.push({ now: opts.now })
    return plan.apply(this, arguments)
  }
  t.teardown(() => { ops.periodicRekeyPlan = plan })
  const live = () => until(() => sync.last() && !sync.last().aborted && !sync.last().once, { name: 'a live run', timeoutMs: 5000 })
  await armPass(a, sync, await diaryLength(a))
  await until(() => spy.length === 1, { name: 'the first plan', timeoutMs: 5000 })
  await pause(200)
  t.is(firstBlocks(await coreRecords(a, group)), 1, 'not due yet')

  // Due: the first growth starts a pass at once.
  offset += DAY + 2 * REKEY_CHECK_MS
  await live()
  const grew = clock()
  sync.last().emit({ event: 'groups-changed', group })
  await until(async () => firstBlocks(await coreRecords(a, group)) === 2, { name: 'the rotation', timeoutMs: 10000 })
  t.is(spy.length, 2, 'one pass for the growth')

  // 5 s before that hour ends, another group grows twice: its first growth
  // starts a pass, its second waits a full hour.
  await live()
  offset += grew + REKEY_CHECK_MS - 5000 - clock()
  const other = 'cd'.repeat(32)
  sync.last().emit({ event: 'groups-changed', group: other })
  await until(() => spy.length === 3, { name: 'the other group\'s pass', timeoutMs: 10000 })
  await live()
  sync.last().emit({ event: 'groups-changed', group: other })

  // Two more growths of the group, deferred after the other's: one pass,
  // when the group's hour ends, not the other's.
  sync.last().emit({ event: 'groups-changed', group })
  await pause(100)
  sync.last().emit({ event: 'groups-changed', group })
  await until(() => spy.length === 4, { name: 'the pass when the hour ends', timeoutMs: 10000 })
  t.ok(spy[3].now >= grew + REKEY_CHECK_MS, 'not before the hour ends')
  await a.web.request('sync.stop')
  t.is(spy.length, 4, 'two growths, one pass')
  t.is(firstBlocks(await coreRecords(a, group)), 2, 'still rotated once')
})
