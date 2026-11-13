'use strict'

// The group and community fold memo (member-ops.js memoFold): a repeated
// read decodes no group block, and every input the fold reads invalidates
// it. Every ctx runs in check mode, so a stale fold throws.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const { createBrowserSession } = require('../lib/session')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')

// Block decodes of group cores (readBlocks) and diary replicas
// (readVisible), the work the memo saves.
const reads = { n: 0 }
for (const name of ['readBlocks', 'readVisible']) {
  const original = store[name]
  store[name] = (...args) => {
    reads.n++
    return original(...args)
  }
}

// Check mode off while counting: its recompute reads every block again.
async function counted (s, fn) {
  s.ctx.memoCheck = false
  try {
    reads.n = 0
    const value = await fn()
    return { value, n: reads.n }
  } finally {
    s.ctx.memoCheck = true
  }
}

async function setup (t, { assoc = generateAssociationKeyPair(), name = 'Ana' } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const groupKeys = createGroupKeys()
  await groupKeys.unlock(storage, prf)
  t.teardown(() => groupKeys.close())
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys, memo: new Map(), memoCheck: true }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  await ops.profileSet(ctx, { name, bio: '' })
  return { ctx, key, assoc, storage, prf, keyPair }
}

// Copies blocks [start, end) of `source` into `target` (both closed after).
async function pipe (source, target, ranges = null) {
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    for (const [start, end] of ranges || [[0, source.length]]) await target.download({ start, end }).done()
    if (ranges !== null) await target.update({ wait: true })
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

async function copyCore (from, to, key, ranges = null) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key), ranges)
  await store.addGroupReplica(to.storage, key)
}

async function copyDiary (from, to, ranges = null) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key), ranges)
  await store.addGroupDiary(to.storage, from.key)
}

async function coreLength (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try {
    return core.length
  } finally {
    await core.close()
  }
}

async function heldRange (s, key, replica) {
  const core = replica ? await store.openReplica(s.storage, key) : await store.openGroupCoreReadOnly(s.storage, key)
  try {
    return { contiguous: core.contiguousLength, length: core.length }
  } finally {
    await core.close()
  }
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function texts (s, group) {
  return (await ops.groupRead(s.ctx, { group })).items.filter((p) => !p.hidden).map((p) => p.text).sort()
}

async function memberKeys (s, group) {
  return (await ops.groupMembers(s.ctx, { group })).members.filter((m) => !m.banned).map((m) => m.member).sort()
}

// A: a community with an open public group and a post; B joins both, and
// A holds B's diary and writers.
async function world (t, { visibility = 'public' } = {}) {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', visibility, community })
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  const toB = async () => {
    await copyDiary(a, b)
    for (const key of [community, general, group]) await copyCore(a, b, key)
  }
  const toA = async () => {
    await copyDiary(b, a)
    for (const root of [community, general, group]) {
      const w = await ownWriter(b, root)
      if (w !== null) await copyCore(b, a, w)
    }
  }
  await toB()
  return { a, b, community, general, group, toA, toB }
}

test('the entries stamp follows the seq of a sparse read', (t) => {
  const { entriesStamp } = require('../lib/member-ops')
  const rec = { type: 'post' }
  const dense = [{ seq: 0, record: rec }, { seq: 1, record: rec }]
  const sparseA = [{ seq: 0, record: rec }, { seq: 10, record: rec }]
  const sparseB = [{ seq: 0, record: rec }, { seq: 12, record: rec }]
  t.is(entriesStamp(dense), entriesStamp([{ seq: 0, record: rec }, { seq: 1, record: rec }]))
  t.not(entriesStamp(sparseA), entriesStamp(sparseB), 'same length, other blocks shown')
  t.not(entriesStamp(dense), entriesStamp(sparseA))
  t.not(entriesStamp([{ seq: 0, record: rec }, { seq: 1, record: null }]), entriesStamp(dense), 'a hole is stamped')
})

test('a second group.list decodes no block and answers the same', async (t) => {
  const { a } = await world(t)
  const first = await counted(a, () => ops.groupList(a.ctx))
  t.ok(first.n > 0, 'the first list reads the cores')
  const second = await counted(a, () => ops.groupList(a.ctx))
  t.is(second.n, 0, 'the second list reads no block')
  t.alike(second.value, first.value)
  const info = await counted(a, () => ops.communityList(a.ctx))
  t.is(info.n, 0, 'the community fold is reused too')
})

test('a post, a join, a hide, a leave, a block each invalidate', async (t) => {
  const { a, b, community, group, toA } = await world(t)
  await ops.communityJoin(b.ctx, { community })
  t.alike(await memberKeys(a, group), [a.key])
  await ops.groupList(a.ctx)
  t.is((await counted(a, () => ops.groupList(a.ctx))).n, 0, 'memo warm')

  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  await toA()
  const joined = await counted(a, () => memberKeys(a, group))
  t.ok(joined.n > 0, 'a join is read again')
  t.alike(joined.value, [a.key, b.key].sort())

  const { seq } = await ops.groupPost(b.ctx, { group, text: 'da Bia' })
  await toA()
  const posted = await counted(a, () => texts(a, group))
  t.ok(posted.n > 0, 'a post on a writer is read again')
  t.alike(posted.value, ['da Bia', 'oi'])
  await ops.groupPost(a.ctx, { group, text: 'da Ana' })
  t.alike(await texts(a, group), ['da Ana', 'da Bia', 'oi'], 'a post on the root')

  const writer = await ownWriter(b, group)
  await ops.groupHide(a.ctx, { group, target: { writer, seq }, on: true })
  t.alike(await texts(a, group), ['da Ana', 'oi'], 'a hide')

  await ops.groupLeave(b.ctx, { group })
  await toA()
  const left = await counted(a, () => memberKeys(a, group))
  t.ok(left.n > 0, 'a leave is read again')
  t.alike(left.value, [a.key])

  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assoc)
  await store.writeBlocklist(a.storage, createSnapshot({ seq: 1, blocked: [group] }, modKp, modCert))
  t.absent((await ops.groupList(a.ctx)).groups.some((g) => g.group === group), 'a block')
})

test('a rekey invalidates a private fold, and the holder keeps its epochs', async (t) => {
  const { a, group } = await world(t, { visibility: 'private' })
  t.alike(await texts(a, group), ['oi'])
  const before = (await ops.groupRead(a.ctx, { group })).epoch
  t.ok(before !== null)
  await ops.groupRead(a.ctx, { group })
  await ops.groupRekey(a.ctx, { group })
  const after = await counted(a, () => ops.groupRead(a.ctx, { group }))
  t.ok(after.n > 0, 'the rekey is read again')
  t.not(JSON.stringify(after.value.epoch), JSON.stringify(before), 'a new epoch')
  t.alike(await texts(a, group), ['oi'], 'still opens the old epoch')
  await ops.groupPost(a.ctx, { group, text: 'nova época' })
  t.alike(await texts(a, group), ['nova época', 'oi'])
})

test('a hide downloaded into a hole of the root invalidates', async (t) => {
  const { a, b, group } = await world(t)
  const { seq } = await ops.groupPost(a.ctx, { group, text: 'some' })
  await ops.groupHide(a.ctx, { group, target: { writer: group, seq }, on: true })
  await ops.groupPost(a.ctx, { group, text: 'depois' })
  const length = await coreLength(a, group)
  await copyCore(a, b, group, [[0, length - 2], [length - 1, length]])
  t.alike(await heldRange(b, group, false), { contiguous: length - 2, length }, 'a hole at the hide')
  t.alike(await texts(b, group), ['oi', 'some'])
  t.is((await counted(b, () => texts(b, group))).n, 0, 'memo warm')
  await copyCore(a, b, group)
  t.alike(await heldRange(b, group, false), { contiguous: length, length }, 'same length, hole filled')
  t.alike(await texts(b, group), ['depois', 'oi'], 'the hide counts')
})

test('a binding diary filling a hole invalidates', async (t) => {
  const { a, b, community, group } = await world(t)
  await ops.communityJoin(b.ctx, { community })
  await ops.groupJoin(b.ctx, { group })
  const entries = (await ops.logRead(b.ctx)).entries
  const at = entries.findIndex((e) => e.record.type === 'group-join' && e.record.group === group)
  await ops.profileSet(b.ctx, { name: 'Bia', bio: 'depois' })
  const length = entries.length + 1
  await copyDiary(b, a, [[0, at], [at + 1, length]])
  for (const root of [community, group]) await copyCore(b, a, await ownWriter(b, root))
  t.alike(await heldRange(a, b.key, true), { contiguous: at, length }, 'a hole at the join')
  t.alike(await memberKeys(a, group), [a.key], 'no join evidence yet')
  t.is((await counted(a, () => memberKeys(a, group))).n, 0, 'memo warm')
  await copyDiary(b, a)
  t.alike(await heldRange(a, b.key, true), { contiguous: length, length })
  t.alike(await memberKeys(a, group), [a.key, b.key].sort(), 'the join counts')
})

test('a change of the parent community alone invalidates the group', async (t) => {
  const { a, b, community, group, toA } = await world(t)
  await ops.communityJoin(b.ctx, { community })
  await ops.groupJoin(b.ctx, { group })
  await toA()
  t.alike(await memberKeys(b, group), [a.key, b.key].sort())
  t.is((await counted(b, () => memberKeys(b, group))).n, 0, 'memo warm')
  const groupLength = await coreLength(a, group)
  await ops.communityBan(a.ctx, { community, member: b.key, on: true })
  t.is(await coreLength(a, group), groupLength, 'nothing written on the group')
  await copyCore(a, b, community)
  const banned = await counted(b, () => memberKeys(b, group))
  t.ok(banned.n > 0, 'read again')
  t.alike(banned.value, [a.key], 'the community ban reaches the group')
})

test('an entry expires after 30 s', async (t) => {
  const { a } = await world(t)
  await ops.groupList(a.ctx)
  t.is((await counted(a, () => ops.groupList(a.ctx))).n, 0)
  const now = Date.now
  const start = now()
  Date.now = () => start + 30001
  try {
    t.ok((await counted(a, () => ops.groupList(a.ctx))).n > 0, 'read again')
  } finally {
    Date.now = now
  }
})

test('the session memo goes with clearKeyPair and setKeyPair', async (t) => {
  const s = await setup(t)
  const { community } = await ops.communityCreate(s.ctx, { name: 'Bairro', join: 'open' })
  await ops.groupCreate(s.ctx, { name: 'Horta', join: 'open', community })
  const groupMemo = new Map()
  const session = createBrowserSession({
    storage: s.storage,
    association: hex(s.assoc.publicKey),
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    memoCheck: true,
    groupMemo
  })
  t.teardown(() => session.close(), { force: true })
  await session.setKeyPair(s.keyPair, { prf: s.prf })
  const list = () => session.handlers['group.list']({})
  const first = await list()
  t.ok(groupMemo.size > 0, 'folds kept')
  t.alike(await list(), first)
  await session.clearKeyPair()
  t.is(groupMemo.size, 0, 'clearKeyPair empties it')
  await list()
  t.ok(groupMemo.size > 0)
  await session.setKeyPair(s.keyPair, { prf: s.prf })
  t.is(groupMemo.size, 0, 'setKeyPair empties it')
})
