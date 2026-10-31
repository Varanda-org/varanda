'use strict'

// Private groups on the browser node through connectClient (docs/protocol.md
// "Private groups", rpc.md 5.61): sealing, epochs, history on admit,
// rotation and what storage keeps. Mirrors the core node's private tests.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const gc = require('@varanda/core/lib/group-crypto')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf, boxKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')
const { connectClient, errorOf } = require('./helpers/session')

const hex = (buf) => b4a.toString(buf, 'hex')
const CORE_FILES = ['oplog', 'tree', 'bitfield', 'data', 'header']

// A memory storage that remembers every core and kv key it was asked for,
// so a test can scan all of it.
function recordingStorage () {
  const s = memoryNodeStorage()
  const cores = new Set()
  const kv = new Set()
  const wrapped = Object.create(s)
  wrapped.core = (name, opts) => { cores.add(name); return s.core(name, opts) }
  wrapped.writeJson = (k, v) => { kv.add(k); return s.writeJson(k, v) }
  wrapped.cores = cores
  wrapped.kv = kv
  return wrapped
}

function call (file, method, ...args) {
  return new Promise((resolve, reject) => {
    file[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}

async function storedBytes (storage) {
  const out = []
  for (const name of storage.cores) {
    for (const file of CORE_FILES) {
      const f = storage.core(name)(file)
      const { size } = await call(f, 'stat').catch(() => ({ size: 0 }))
      if (size > 0) out.push(await call(f, 'read', 0, size))
      await call(f, 'close').catch(() => {})
    }
  }
  for (const k of storage.kv) out.push(b4a.from(JSON.stringify(await storage.readJson(k)) || ''))
  return out
}

function holds (buffers, needle) {
  const n = typeof needle === 'string' ? b4a.from(needle) : needle
  return buffers.some((buf) => b4a.indexOf(buf, n) !== -1)
}

async function setup (t, { assoc = generateAssociationKeyPair(), storage = recordingStorage(), keyPair = crypto.keyPair(), prf = crypto.randomBytes(32) } = {}) {
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  if (!(await store.diaryStatus(storage)).exists) {
    await ops.idCreate(ctx)
    await ops.certAdd(ctx, createCert({ member: key }, assoc))
  }
  const internal = []
  const node = createBrowserNode({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    onInternalError: (err) => internal.push(err)
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  return { node, web, key, keyPair, prf, assoc, storage, internal }
}

// Copies `from`'s diary and the group core `core` into `to`.
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

const texts = (page) => page.items.map((p) => p.text)

// a creates a private group; b joins and a admits b.
async function admitted (t) {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  await a.web.request('group.post', { group, text: 'antes da entrada' })
  await share(a, b, group)
  t.is((await b.web.request('group.join', { group })).state, 'requested')
  const bw = await writerOf(b, group)
  await share(b, a, bw)
  t.alike(await a.web.request('group.admit', { group, member: b.key, on: true }), { ok: true })
  await share(a, b, group)
  return { a, b, group, bw }
}

test('a private create is never public: sealed name, epoch 1 to the root box, members read', async (t) => {
  const a = await setup(t)
  const c = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  const records = await coreRecords(a, group)
  t.alike(records.map((r) => r.type), ['group-header', 'group-key', 'group-sealed'])
  t.is(records[0].visibility, 'private')
  t.is(records[0].join, 'approval', 'private forces approval')
  t.is(records[0].name, null)
  t.ok(/^[0-9a-f]{64}$/.test(records[0].box))
  t.alike(records[1].keys.map((k) => k.writer), [group])
  const info = await a.web.request('group.info', { group })
  t.alike([info.visibility, info.name, info.join, info.role], ['private', 'Segredo', 'approval', 'creator'])
  t.alike(await a.web.request('group.post', { group, text: 'texto secreto' }), { seq: 3 }, 'after header, key and sealed meta')
  const page = await a.web.request('group.read', { group })
  t.alike(texts(page), ['texto secreto'])
  t.alike([page.sealed, page.state, page.epoch], [0, 'ok', { writer: group, seq: 1 }])
  t.is((await coreRecords(a, await writerOf(a, group)))[3].type, 'group-sealed', 'the post travels sealed')

  // A non-member holding every block sees counts only.
  await share(a, c, group)
  const seen = await c.web.request('group.read', { group })
  t.alike([seen.items, seen.sealed, seen.epoch], [[], 2, null])
  const cInfo = await c.web.request('group.info', { group })
  t.alike([cInfo.visibility, cInfo.name], ['private', null])
  const err = await errorOf(a.web.request('group.meta', { group, visibility: 'public' }))
  t.is(err.code, 'USAGE', 'visibility never changes')
  t.alike(a.internal.concat(c.internal), [])
})

test('an admitted member reads history; a requested one gets no key from a rotation', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  const page = await b.web.request('group.read', { group })
  t.alike(texts(page), ['antes da entrada'], 'history on admit')
  t.is(page.state, 'ok')
  t.alike(page.epoch, { writer: group, seq: 1 })
  t.alike(await b.web.request('group.post', { group, text: 'oi' }), { seq: 1 })
  await share(b, a, bw)
  t.alike(texts(await a.web.request('group.read', { group })), ['oi', 'antes da entrada'])

  const c = await setup(t, { assoc: a.assoc })
  await share(a, c, group)
  t.is((await c.web.request('group.join', { group })).state, 'requested')
  const cw = await writerOf(c, group)
  await share(c, a, cw)
  const { epoch } = await a.web.request('group.rekey', { group })
  const keyBlock = (await coreRecords(a, group))[epoch.seq]
  t.absent(keyBlock.keys.some((k) => k.writer === cw), 'never sealed to a requested writer')
  t.ok(keyBlock.keys.some((k) => k.writer === bw), 'the admitted writer is a recipient')
  await a.web.request('group.post', { group, text: 'nova época' })
  await share(a, c, group)
  const cPage = await c.web.request('group.read', { group })
  t.alike(cPage.items, [])
  t.ok(cPage.sealed >= 3)
  t.alike(a.internal.concat(b.internal, c.internal), [])
})

test('a ban rotates: the banned member cannot read what follows', async (t) => {
  const { a, b, group } = await admitted(t)
  t.alike(await a.web.request('group.ban', { group, member: b.key, on: true }), { ok: true })
  const aPage = await a.web.request('group.read', { group })
  t.is(aPage.state, 'ok')
  t.ok(aPage.epoch.seq > 1, 'a new epoch')
  await a.web.request('group.post', { group, text: 'depois do banimento' })
  await share(a, b, group)
  const bPage = await b.web.request('group.read', { group })
  t.absent(texts(bPage).includes('depois do banimento'))
  t.ok(texts(bPage).includes('antes da entrada'), 'what it already read stays readable')
  t.ok(bPage.sealed >= 1)
})

test('a leave leaves the group rekey-pending until group.rekey', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  t.alike(await b.web.request('group.leave', { group }), { state: 'left' })
  await share(b, a, bw)
  t.is((await a.web.request('group.read', { group })).state, 'rekey-pending')
  for (const [method, params] of [['group.post', { text: 'x' }], ['group.meta', { name: 'Outro' }]]) {
    const err = await errorOf(a.web.request(method, { group, ...params }))
    t.alike([err.code, err.message], ['USAGE', 'aguardando nova chave'], method)
  }
  const r = await a.web.request('group.rekey', { group })
  t.is(r.group, group)
  t.is(r.epoch.writer, group)
  t.alike(Object.keys(r).sort(), ['epoch', 'group'], 'no key in the result')
  t.is((await a.web.request('group.read', { group })).state, 'ok')
  t.ok(Number.isSafeInteger((await a.web.request('group.post', { group, text: 'segue' })).seq))

  const { group: pub } = await a.web.request('group.create', { name: 'Praça', join: 'open' })
  let err = await errorOf(a.web.request('group.rekey', { group: pub }))
  t.alike([err.code, err.message], ['USAGE', 'grupo público não usa chave'])
  t.is((await a.web.request('group.read', { group: pub })).state, 'ok')
  err = await errorOf(b.web.request('group.rekey', { group }))
  t.alike([err.code, err.message], ['USAGE', 'sem permissão no grupo'])
})

test('concurrent rotations by two admins: both epochs read, the creator reads the other admin', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  t.alike(await a.web.request('group.admin', { group, member: b.key, on: true }), { ok: true })
  await share(a, b, group)
  t.is((await b.web.request('group.info', { group })).role, 'admin')
  const ra = await a.web.request('group.rekey', { group })
  const rb = await b.web.request('group.rekey', { group })
  t.not(`${ra.epoch.writer}:${ra.epoch.seq}`, `${rb.epoch.writer}:${rb.epoch.seq}`, 'distinct kids')
  await a.web.request('group.post', { group, text: 'da Ana' })
  await b.web.request('group.post', { group, text: 'da Bia' })
  await share(a, b, group)
  await share(a, b, await writerOf(a, group))
  await share(b, a, bw)
  for (const m of [a, b]) {
    const page = await m.web.request('group.read', { group })
    t.ok(texts(page).includes('da Ana') && texts(page).includes('da Bia'), 'both branches decrypt')
    t.is(page.sealed, 0)
  }
})

test('storage holds no plaintext, no epoch key and no box secret', async (t) => {
  const { a, b, group } = await admitted(t)
  await b.web.request('group.post', { group, text: 'segredo guardado 42' })
  const root = await coreRecords(a, group)
  for (const m of [a, b]) {
    const bytes = await storedBytes(m.storage)
    t.ok(holds(bytes, root[1].keys[0].sealed) || m === b, 'the scan reads the stored blocks')
    t.absent(holds(bytes, 'segredo guardado 42'), 'no post text')
    t.absent(holds(bytes, 'antes da entrada'), 'no post text')
    t.absent(holds(bytes, 'Segredo'), 'no group name')
    const nonce = (await m.storage.readJson('groupBoxDevice')).nonce
    const pair = await boxKeyPairFromPrf(new Uint8Array(m.prf), b4a.from(nonce, 'hex'))
    const writers = m === a ? [group] : [await writerOf(b, group)]
    const entry = root[1].keys.concat(...root.filter((r) => r.type === 'group-key' && r.kid !== null).map((r) => r.keys))
      .find((k) => writers.includes(k.writer))
    const key = gc.openEpochKey(b4a.from(entry.sealed, 'base64'), pair, group, { writer: group, seq: 1 })
    t.ok(key !== null, 'the test opens the epoch key itself')
    for (const secret of [key, pair.secretKey]) {
      t.absent(holds(bytes, secret), 'no raw secret')
      t.absent(holds(bytes, hex(secret)), 'no hex secret')
      t.absent(holds(bytes, b4a.toString(secret, 'base64')), 'no base64 secret')
    }
  }
})

// Appends `record` to `m`'s root of `group` directly, as an older node or a
// write cut short would leave it (no key upkeep after it).
async function appendToRoot (m, group, record) {
  const entry = (await store.readGroupWriters(m.storage)).find((e) => e.group === group)
  const kp = await groupKeyPairFromPrf(m.prf, new Uint8Array(b4a.from(entry.rootNonce, 'hex')))
  const core = await store.openGroupWriter(m.storage, kp)
  try {
    await store.appendGroupRecord(core, record, { root: true, private: true })
  } finally {
    await core.close()
  }
}

const grp = require('@varanda/core/lib/group')

test('group.rekey makes up history an admit without key upkeep never handed', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  await a.web.request('group.post', { group, text: 'antes da entrada' })
  await share(a, b, group)
  await b.web.request('group.join', { group })
  const bw = await writerOf(b, group)
  await share(b, a, bw)
  const len = (await coreRecords(b, bw)).length
  await appendToRoot(a, group, grp.groupAdmit({ member: b.key, on: true, cuts: [{ writer: bw, seq: len }] }))
  await share(a, b, group)
  t.alike(texts(await b.web.request('group.read', { group })), [], 'no key handed yet')
  await a.web.request('group.rekey', { group })
  await share(a, b, group)
  t.alike(texts(await b.web.request('group.read', { group })), ['antes da entrada'], 'the old epoch delivered')
})

test('an unban hands the history again; an epoch from a non-distributor is never handed on', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  await a.web.request('group.ban', { group, member: b.key, on: true })
  await a.web.request('group.post', { group, text: 'durante o banimento' })
  t.alike(await a.web.request('group.ban', { group, member: b.key, on: false }), { ok: true })
  await share(a, b, group)
  t.ok(texts(await b.web.request('group.read', { group })).includes('durante o banimento'), 'unban hands history')

  // b, a plain member, opens an "epoch" of its own sealed to the root box.
  const c = await setup(t, { assoc: a.assoc })
  const entry = (await store.readGroupWriters(b.storage)).find((e) => e.group === group)
  const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(b4a.from(entry.nonce, 'hex')))
  const core = await store.openGroupWriter(b.storage, kp)
  const forged = { writer: bw, seq: core.length }
  const rootBox = (await coreRecords(a, group))[0].box
  const forgedKey = gc.newEpochKey()
  const sealed = b4a.toString(gc.sealEpochKey(forgedKey, group, forged, b4a.from(rootBox, 'hex')), 'base64')
  const commit = hex(gc.keyCommit(forgedKey, group, forged))
  await store.appendGroupRecord(core, grp.groupKey({ kid: null, basis: [], keys: [{ writer: group, sealed }], commit }), { private: true })
  await core.close()
  await share(b, a, bw)
  await share(a, c, group)
  await c.web.request('group.join', { group })
  const cw = await writerOf(c, group)
  await share(c, a, cw)
  t.alike(await a.web.request('group.admit', { group, member: c.key, on: true }), { ok: true })
  const handed = (await coreRecords(a, group)).filter((r) => r.type === 'group-key' && r.kid !== null && r.keys.some((k) => k.writer === cw))
  t.ok(handed.length > 0, 'c gets the real epochs')
  t.absent(handed.some((r) => r.kid.writer === forged.writer && r.kid.seq === forged.seq), 'never the forged one')
})

test('a join by key before the private root arrives is replaced by a boxed writer', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  await a.web.request('group.post', { group, text: 'antes da entrada' })
  t.alike(await b.web.request('group.join', { group }), { state: 'pending' })
  const boxless = await writerOf(b, group)
  t.is((await coreRecords(b, boxless))[0].box, null, 'written before the root was known')
  await share(a, b, group)
  t.alike(await b.web.request('group.join', { group }), { state: 'requested' })
  const bw = await writerOf(b, group)
  t.not(bw, boxless, 'a new writer')
  t.ok(/^[0-9a-f]{64}$/.test((await coreRecords(b, bw))[0].box), 'with this device box')
  const joins = (await ops.logRead({ storage: b.storage, association: hex(b.assoc.publicKey), keyPair: b.keyPair })).entries
    .map((e) => e.record).filter((r) => r.type === 'group-join' && r.writer === boxless)
  t.alike(joins.map((r) => r.on), [true, false], 'the boxless writer is unbound before the new one')
  await share(b, a, bw)
  t.alike(await a.web.request('group.admit', { group, member: b.key, on: true }), { ok: true })
  await share(a, b, group)
  t.alike(texts(await b.web.request('group.read', { group })), ['antes da entrada'])
  t.alike(a.internal.concat(b.internal), [])
})

test('a malformed group-key in a counted writer breaks neither admission nor history', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  await a.web.request('group.post', { group, text: 'antes da entrada' })
  await share(a, b, group)
  t.is((await b.web.request('group.join', { group })).state, 'requested')
  const entry = (await store.readGroupWriters(b.storage)).find((e) => e.group === group)
  const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(b4a.from(entry.nonce, 'hex')))
  const core = await store.openGroupWriter(b.storage, kp)
  await core.append({ type: 'group-key' })
  await core.close()
  await share(b, a, entry.key)
  t.alike(await a.web.request('group.admit', { group, member: b.key, on: true }), { ok: true })
  t.ok((await coreRecords(a, group)).some((r) => r.type === 'group-key' && r.kid !== null), 'history handed on')
  await share(a, b, group)
  t.alike(texts(await b.web.request('group.read', { group })), ['antes da entrada'])
  t.alike(a.internal.concat(b.internal), [])
})

const { createGroupKeys } = require('../lib/group-keys')
const { groupJoinRecord } = require('@varanda/core/lib/records')

// A member-ops context over `m`'s storage with its own unlocked holder.
async function opsCtx (t, m, { groupKeyPair } = {}) {
  const groupKeys = createGroupKeys()
  await groupKeys.unlock(m.storage, new Uint8Array(m.prf))
  t.teardown(() => groupKeys.close())
  return {
    storage: m.storage,
    association: hex(m.assoc.publicKey),
    keyPair: m.keyPair,
    groupKeyPair: groupKeyPair || ((nonce) => groupKeyPairFromPrf(m.prf, nonce)),
    groupKeys
  }
}

test('a private group refuses a meta whose join is not approval', async (t) => {
  const a = await setup(t)
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  const err = await errorOf(a.web.request('group.meta', { group, join: 'open' }))
  t.alike([err.code, err.message], ['USAGE', 'grupo privado exige aprovação'])
  t.alike(await a.web.request('group.meta', { group, join: 'approval', name: 'Outro' }), { ok: true })
})

test('a rotation that fails after a ban is no error of the ban: rekey-pending, group.rekey repairs', async (t) => {
  const { a, b, group } = await admitted(t)
  let calls = 0
  const ctx = await opsCtx(t, a, {
    groupKeyPair: (nonce) => {
      if (++calls > 1) throw new Error('falha simulada')
      return groupKeyPairFromPrf(a.prf, nonce)
    }
  })
  t.alike(await ops.groupBan(ctx, { group, member: b.key, on: true }), { ok: true })
  t.is((await a.web.request('group.read', { group })).state, 'rekey-pending')
  await a.web.request('group.rekey', { group })
  t.is((await a.web.request('group.read', { group })).state, 'ok')
})

test('a writer with a weak box key is never sealed to', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  await share(a, b, group)
  // The builder refuses a weak box: written raw, as a hostile peer would.
  const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(crypto.randomBytes(32)))
  const core = await store.openGroupWriter(b.storage, kp)
  await core.append({ type: 'group-writer', v: 1, group, diary: b.key, box: '00'.repeat(32), rejoin: null, at: new Date().toISOString() })
  await core.close()
  const bw = hex(kp.publicKey)
  const diary = await store.openDiary(b.storage, b.keyPair)
  await store.appendRecord(diary, groupJoinRecord({ group, writer: bw, on: true }))
  await diary.close()
  await share(b, a, bw)
  await a.web.request('group.admit', { group, member: b.key, on: true }).catch(() => null)
  await a.web.request('group.rekey', { group })
  const keyed = (await coreRecords(a, group)).filter((r) => r.type === 'group-key' && r.keys.some((k) => k.writer === bw))
  t.alike(keyed, [], 'no key sealed to the weak box')
  t.alike(a.internal, [])
})

test('at the writer cap a boxed rejoin does not count the boxless writer it unbinds', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  t.alike(await b.web.request('group.join', { group }), { state: 'pending' })
  await share(a, b, group)
  for (let i = 1; i < grp.MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(crypto.randomBytes(32)))
    const core = await store.openGroupWriter(b.storage, kp)
    await store.appendGroupRecord(core, grp.writerHeader({ group, diary: b.key, box: hex(crypto.randomBytes(32)) }), { root: false })
    await core.close()
    await store.addGroupReplica(b.storage, hex(kp.publicKey))
    const diary = await store.openDiary(b.storage, b.keyPair)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(kp.publicKey), on: true }))
    await diary.close()
  }
  t.alike(await b.web.request('group.join', { group }), { state: 'requested' })
})

test('weak box keys, the top bit included, are never sealed to', async (t) => {
  for (const weak of ['00'.repeat(31) + '80', '00'.repeat(32), 'ec' + 'ff'.repeat(30) + '7f', 'ec' + 'ff'.repeat(31), 'ee' + 'ff'.repeat(31)]) {
    t.absent(ops.canSealTo(weak), weak)
  }
  t.ok(ops.canSealTo(hex(gc.newBoxKeyPair().publicKey)), 'a real box key')
})

test('fake bans from an unadmitted writer never inflate a rotation: one new epoch', async (t) => {
  const { a, b, group } = await admitted(t)
  const c = await setup(t, { assoc: a.assoc })
  await share(a, c, group)
  t.is((await c.web.request('group.join', { group })).state, 'requested')
  const entry = (await store.readGroupWriters(c.storage)).find((e) => e.group === group)
  const kp = await groupKeyPairFromPrf(c.prf, new Uint8Array(b4a.from(entry.nonce, 'hex')))
  const core = await store.openGroupWriter(c.storage, kp)
  const fake = grp.groupBan({ member: b.key, on: true, cuts: [] })
  await core.append(new Array(5000).fill(fake))
  await core.close()
  await share(c, a, entry.key)
  const firsts = async () => (await coreRecords(a, group)).filter((r) => r.type === 'group-key' && r.kid === null).length
  const before = await firsts()
  t.alike(await a.web.request('group.ban', { group, member: b.key, on: true }), { ok: true })
  t.is(await firsts(), before + 1, 'exactly one new epoch')
  t.is((await a.web.request('group.read', { group })).state, 'ok')
})

test('a community ref in an earlier own basis is listed again in the next rotation', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { group } = await a.web.request('group.create', { name: 'Segredo', join: 'open', visibility: 'private' })
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  await a.web.request('community.link', { community, group, on: true })
  await a.web.request('community.admin', { community, member: b.key, on: true })
  await a.web.request('community.admin', { community, member: b.key, on: false })
  const lastBasis = async () => (await coreRecords(a, group)).filter((r) => r.type === 'group-key' && r.kid === null).pop().basis
  await a.web.request('group.rekey', { group })
  const first = (await lastBasis()).filter((r) => r.writer === community)
  t.is(first.length, 1, 'the community removal is in the basis')
  await a.web.request('group.rekey', { group })
  t.alike((await lastBasis()).filter((r) => r.writer === community), first, 'listed again, never subtracted')
  t.is((await a.web.request('group.read', { group })).state, 'ok')
})

test('a history hand-off that does not fit the log appends nothing', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  await a.web.request('group.rekey', { group })
  await a.web.request('group.rekey', { group })
  const c = await setup(t, { assoc: a.assoc })
  await share(a, c, group)
  t.is((await c.web.request('group.join', { group })).state, 'requested')
  await share(c, a, await writerOf(c, group))
  const before = (await coreRecords(a, group)).length
  // Room for the admit and one more block; three epochs to hand.
  const ctx = { ...(await opsCtx(t, a)), limits: { maxLogBlocks: before + 2 } }
  t.alike(await ops.groupAdmit(ctx, { group, member: c.key, on: true }), { ok: true })
  t.is((await coreRecords(a, group)).length, before + 1, 'only the admit was written')
  await a.web.request('group.rekey', { group })
  await share(a, c, group)
  await share(b, c, bw)
  t.is((await c.web.request('group.read', { group })).state, 'ok', 'group.rekey with room hands it later')
})

test('every first key block commits to the key its members open', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  const { epoch } = await a.web.request('group.rekey', { group })
  await share(a, b, group)
  const records = await coreRecords(a, group)
  for (const r of records) {
    if (r.type === 'group-key' && r.kid !== null) t.absent('commit' in r, 'no commit on a continuation')
  }
  const kid = { writer: epoch.writer, seq: epoch.seq }
  t.is(kid.writer, group)
  const first = records[kid.seq]
  t.is(first.kid, null, 'the epoch is a first block')
  const nonce = (await b.storage.readJson('groupBoxDevice')).nonce
  const pair = await boxKeyPairFromPrf(new Uint8Array(b.prf), b4a.from(nonce, 'hex'))
  const entry = first.keys.find((k) => k.writer === bw)
  const key = gc.openEpochKey(b4a.from(entry.sealed, 'base64'), pair, group, kid)
  t.ok(key !== null, 'the member opens the key')
  t.is(first.commit, hex(gc.keyCommit(key, group, kid)), 'the commit matches that key')
  t.is(records[1].type, 'group-key')
  t.ok(typeof records[1].commit === 'string', 'the create epoch commits too')
  gc.wipe(key)
  gc.wipe(pair.secretKey)
  await b.web.request('group.post', { group, text: 'sob a chave comprometida' })
  await share(b, a, bw)
  t.ok(texts(await a.web.request('group.read', { group })).includes('sob a chave comprometida'), 'members still read and send')
})

test('relinking a community whose admin was demoted while unlinked leaves no rekey-pending', async (t) => {
  const { a, b, group, bw } = await admitted(t)
  const { community } = await a.web.request('community.create', { name: 'Bairro' })
  await a.web.request('community.link', { community, group, on: true })
  await a.web.request('community.admin', { community, member: b.key, on: true })
  await a.web.request('community.link', { community, group, on: false })
  await a.web.request('community.admin', { community, member: b.key, on: false })
  await a.web.request('community.link', { community, group, on: true })
  t.is((await a.web.request('group.read', { group })).state, 'ok', 'not rekey-pending after the relink')
  await share(a, b, group)
  await b.web.request('group.post', { group, text: 'depois do religamento' })
  await share(b, a, bw)
  t.ok(texts(await a.web.request('group.read', { group })).includes('depois do religamento'), 'a member sends')
})
