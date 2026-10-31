// The browser node's public groups (lib/node-store.js group cores, kv
// groupWriters / groupReplicas; lib/member-ops.js group*): create, join,
// post, read with the semantics of @varanda/core lib/group.js, own cores
// keyed by a nonce and derived from the passkey PRF (no secret in any stored
// file), writes refused while locked, the kv caps, lazy 'data' storage, the
// admin rules and leave / rejoin. Cores travel between two in-memory
// storages by direct Hypercore replication (no network).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const grp = require('@varanda/core/lib/group')
const { MAX_GROUPS_PER_DIARY, MAX_GROUP_CUTS } = grp
const { groupJoinRecord } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const CORE_FILES = ['oplog', 'tree', 'bitfield', 'data', 'header']

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function call (file, method, ...args) {
  return new Promise((resolve, reject) => {
    file[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}

async function coreFiles (storage, name) {
  const out = []
  for (const file of CORE_FILES) {
    const f = storage.core(name)(file)
    const { size } = await call(f, 'stat')
    if (size > 0) out.push(await call(f, 'read', 0, size))
    await call(f, 'close')
  }
  return out
}

function holds (buffers, needle) {
  return buffers.some((buf) => b4a.indexOf(buf, needle) !== -1)
}

// A member with block 0 and a profile; groupKeyPair derives from a random
// PRF and records every pair it hands out.
async function member (assocKp, name) {
  const storage = memoryNodeStorage()
  const association = hex(assocKp.publicKey)
  const keyPair = crypto.keyPair()
  const prf = new Uint8Array(32)
  globalThis.crypto.getRandomValues(prf)
  const derived = []
  const groupKeyPair = async (nonce) => {
    const kp = await groupKeyPairFromPrf(prf, nonce)
    derived.push(kp)
    return kp
  }
  const ctx = { storage, association, keyPair, groupKeyPair }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  const locked = { storage, association, keyPair: null }
  return { storage, assocKp, ownHex, prf, derived, ctx, locked }
}

async function pair () {
  const assocKp = generateAssociationKeyPair()
  return { a: await member(assocKp, 'Ana'), b: await member(assocKp, 'Bia') }
}

async function replicate (src, dst) {
  const s1 = src.replicate(true, { keepAlive: false })
  const s2 = dst.replicate(false, { keepAlive: false })
  s1.pipe(s2).pipe(s1)
  try {
    await dst.update({ wait: true })
    for (let i = 0; i < dst.length; i++) await dst.get(i)
  } finally {
    s1.destroy()
    s2.destroy()
  }
}

// Copies a group core (own or held) of `from` into `to` and lists it in
// kv groupReplicas there.
async function shareGroupCore (from, to, key) {
  const src = await store.openGroupCoreReadOnly(from.storage, key)
  const dst = await store.openGroupReplica(to.storage, key)
  try {
    await replicate(src, dst)
  } finally {
    await src.close()
    await dst.close()
  }
  await store.addGroupReplica(to.storage, key)
}

// Copies `from`'s own diary into `to` as a followed replica.
async function shareDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.ownHex)
  try {
    await replicate(src, dst)
  } finally {
    await src.close()
    await dst.close()
  }
}

async function diaryRecords (m) {
  return (await ops.logRead(m.ctx)).entries.map((e) => e.record)
}

test('create: the root is an own core derived from its nonce, bound by the diary', async (t) => {
  const { a } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  t.ok(/^[0-9a-f]{64}$/.test(group))
  const entries = await store.readGroupWriters(a.storage)
  t.is(entries.length, 1)
  t.is(entries[0].group, group)
  t.is(entries[0].key, group, 'the creator writes the root')
  const kp = await groupKeyPairFromPrf(a.prf, new Uint8Array(b4a.from(entries[0].nonce, 'hex')))
  t.is(hex(kp.publicKey), group, 'key deterministic from (PRF, nonce)')
  const join = (await diaryRecords(a)).find((r) => r.type === 'group-join')
  t.alike({ group: join.group, writer: join.writer, on: join.on }, { group, writer: group, on: true })

  const info = await ops.groupInfo(a.ctx, { group })
  t.alike(info, { group, name: 'Horta', join: 'open', creator: a.ownHex, role: 'creator', members: 1, state: 'member', communities: [] })
  t.alike(await ops.groupList(a.ctx), { groups: [{ group, name: 'Horta', join: 'open', role: 'creator', members: 1 }], total: 1 })
  t.alike(await ops.groupInfo(a.locked, { group }), info, 'reads work locked')

  const files = []
  for (const name of [store.groupName(group)]) files.push(...(await coreFiles(a.storage, name)))
  for (const d of a.derived) {
    t.absent(holds(files, d.secretKey.subarray(0, 32)), 'no stored file holds a group secret')
  }

  await t.exception(() => ops.groupInfo(a.ctx, { group: hex(crypto.randomBytes(32)) }), /grupo não encontrado/)
  await t.exception(() => ops.groupCreate(a.ctx, { name: '', join: 'open' }), /registro inválido/)
})

test('post and read: causal order, seen, paging backwards, hide', async (t) => {
  const { a } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const seqs = []
  for (let i = 1; i <= 5; i++) seqs.push((await ops.groupPost(a.ctx, { group, text: 'm' + i })).seq)
  t.alike(seqs, [1, 2, 3, 4, 5], 'the root holds the posts after its header')
  const root = await store.openGroupCoreReadOnly(a.storage, group)
  const third = JSON.parse(b4a.toString(await root.get(3)))
  await root.close()
  t.alike(third.seen, { writer: group, seq: 2 }, 'seen names the last post of the fold')

  const reply = await ops.groupPost(a.ctx, { group, text: 'resposta', replyTo: { writer: group, seq: 1 } })
  t.is(reply.seq, 6)

  const page1 = await ops.groupRead(a.ctx, { group, limit: 4 })
  t.alike(page1.items.map((p) => p.text), ['resposta', 'm5', 'm4', 'm3'], 'newest first')
  t.is(page1.items[0].name, 'Ana')
  t.is(page1.items[0].diary, a.ownHex)
  t.alike(page1.items[0].replyTo, { writer: group, seq: 1 })
  t.is(page1.incomplete, false)
  const last = page1.items[3]
  t.alike(page1.next, { at: last.at, writer: group, seq: 3 })
  const page2 = await ops.groupRead(a.ctx, { group, limit: 4, before: page1.next })
  t.alike(page2.items.map((p) => p.text), ['m2', 'm1'])
  t.is(page2.next, null, 'nothing older')

  t.alike(await ops.groupHide(a.ctx, { group, target: { writer: group, seq: 2 }, on: true }), { ok: true })
  const after = await ops.groupRead(a.locked, { group })
  const hidden = after.items.find((p) => p.seq === 2)
  t.ok(hidden.hidden)
  t.is(hidden.text, '', 'hidden text left out')
  t.is(after.hidden, 1)
})

test('join, post and read across two members match the fold', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'bem-vindas' })

  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' }, 'root not held yet')
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const entries = await store.readGroupWriters(b.storage)
  t.is(entries.length, 1)
  const w = entries[0].key
  t.not(w, group)
  t.is(hex((await groupKeyPairFromPrf(b.prf, new Uint8Array(b4a.from(entries[0].nonce, 'hex')))).publicKey), w, 'writer key from its nonce')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' }, 'idempotent')
  t.alike(await store.readGroupWriters(b.storage), entries, 'no second writer')
  t.is((await diaryRecords(b)).filter((r) => r.type === 'group-join').length, 1, 'one join record')

  t.is((await ops.groupPost(b.ctx, { group, text: 'oi' })).seq, 1)
  const bView = await ops.groupRead(b.ctx, { group })
  t.alike(bView.items.map((p) => [p.text, p.name]), [['oi', 'Bia'], ['bem-vindas', 'Ana']])

  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  const aView = await ops.groupRead(a.ctx, { group })
  t.alike(aView.items.map((p) => [p.text, p.writer, p.seq]), bView.items.map((p) => [p.text, p.writer, p.seq]), 'same fold on both nodes')
  t.is((await ops.groupInfo(a.ctx, { group })).members, 2)
  const members = await ops.groupMembers(a.ctx, { group })
  t.is(members.total, 2)
  t.alike(members.members.map((m) => [m.member, m.admin, m.banned]).sort(), [[a.ownHex, true, false], [b.ownHex, false, false]].sort())
  t.ok(members.members.every((m) => typeof m.joinedAt === 'string'))

  // B's writer without B's diary binds nothing: incomplete, B's post gone.
  const c = await member(generateAssociationKeyPair(), 'Cris')
  await shareGroupCore(a, c, group)
  await shareGroupCore(b, c, w)
  const cView = await ops.groupRead(c.ctx, { group })
  t.alike(cView.items.map((p) => p.text), [], 'no join evidence for anyone')
  t.ok(cView.incomplete)
})

test('approval group: requests, admit, ban and unban, admin rules', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Clube', join: 'approval' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'requested' })
  await t.exception(() => ops.groupPost(b.ctx, { group, text: 'oi' }), /sem permissão no grupo/, 'not admitted yet')
  await t.exception(() => ops.groupRequests(b.ctx, { group }), /sem permissão no grupo/, 'requests are for admins')
  const w = (await store.readGroupWriters(b.storage))[0].key
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  const req = await ops.groupRequests(a.ctx, { group })
  t.is(req.total, 1)
  t.is(req.requests[0].member, b.ownHex)
  t.is(req.requests[0].name, 'Bia')

  await t.exception(() => ops.groupAdmit(b.ctx, { group, member: b.ownHex, on: true }), /sem permissão no grupo/)
  await t.exception(() => ops.groupAdmit(a.ctx, { group, member: a.ownHex, on: true }), /sem permissão no grupo/, 'never the creator')
  t.alike(await ops.groupAdmit(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  const root = await store.openGroupCoreReadOnly(a.storage, group)
  const admit = JSON.parse(b4a.toString(await root.get(root.length - 1)))
  await root.close()
  t.alike(admit.cuts, [{ writer: w, seq: 1 }], 'cuts at the local length of B\'s writer')
  t.is((await ops.groupInfo(a.ctx, { group })).members, 2)
  t.is((await ops.groupRequests(a.ctx, { group })).total, 0)

  await t.exception(() => ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), /nada a alterar/, 'no ban to lift')
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  t.is((await ops.groupMembers(a.ctx, { group })).members.find((m) => m.member === b.ownHex).banned, true)
  await shareGroupCore(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'banned')
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /sem permissão no grupo/)
  await t.exception(() => ops.groupLeave(b.ctx, { group }), /sem permissão no grupo/, 'a banned leave would never take effect')
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), { ok: true })
  t.is((await ops.groupInfo(a.ctx, { group })).members, 2, 'the unban lifted the ban')

  await t.exception(() => ops.groupMeta(b.ctx, { group, name: 'Outro' }), /sem permissão no grupo/, 'meta is the creator\'s')
  await t.exception(() => ops.groupMeta(a.ctx, { group }), /nada a alterar/)
  t.alike(await ops.groupMeta(a.ctx, { group, name: 'Clube novo' }), { ok: true })
  t.alike(await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  const info = await ops.groupInfo(a.ctx, { group })
  t.is(info.name, 'Clube novo')
  t.is(info.join, 'approval', 'join kept')
  await shareGroupCore(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).role, 'admin')
  await t.exception(() => ops.groupAdmin(b.ctx, { group, member: b.ownHex, on: false }), /sem permissão no grupo/, 'only the creator appoints')
})

test('leave and rejoin: the leave stays in the old writer, the new one names it', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w1 = (await store.readGroupWriters(b.storage))[0].key
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' }, 'a second leave writes nothing')
  t.is((await ops.groupInfo(b.ctx, { group })).role, 'left')
  const joins = (await diaryRecords(b)).filter((r) => r.type === 'group-join')
  t.alike(joins.map((j) => [j.writer, j.on]), [[w1, true], [w1, false]])
  t.ok(await store.groupCoreExists(b.storage, w1), 'no local core deleted')

  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const w2 = (await store.readGroupWriters(b.storage))[0].key
  t.not(w2, w1)
  t.ok((await store.readGroupReplicas(b.storage)).includes(w1), 'the old writer stays readable')
  const core = await store.openGroupCoreReadOnly(b.storage, w2)
  const header = JSON.parse(b4a.toString(await core.get(0)))
  await core.close()
  t.alike(header.rejoin, { writer: w1, seq: 1 }, 'rejoin names the leave')
  t.is((await ops.groupInfo(b.ctx, { group })).role, 'member')
})

test('a creator who leaves and rejoins keeps the root for meta and admin', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const rootNonce = (await store.readGroupWriters(a.storage))[0].nonce
  await ops.groupLeave(a.ctx, { group })
  t.alike(await ops.groupJoin(a.ctx, { group }), { state: 'member' })
  const entry = (await store.readGroupWriters(a.storage))[0]
  t.not(entry.key, group, 'writes through a new writer')
  t.is(entry.rootNonce, rootNonce, 'the root nonce survives the rejoin')
  t.is((await ops.groupInfo(a.ctx, { group })).role, 'creator')
  t.alike(await ops.groupMeta(a.ctx, { group, name: 'Horta nova' }), { ok: true })
  t.alike(await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  t.is((await ops.groupInfo(a.ctx, { group })).name, 'Horta nova')
})

test('demoting an admin who left keeps the moderation done before', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'apagar' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true })
  await shareGroupCore(a, b, group)
  await ops.groupHide(b.ctx, { group, target: { writer: group, seq: 1 }, on: true })
  await ops.groupLeave(b.ctx, { group })
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  const before = await ops.groupRead(a.ctx, { group })
  t.ok(before.items.find((p) => p.seq === 1).hidden, 'hidden by the admin')

  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: false })
  const root = await store.openGroupCoreReadOnly(a.storage, group)
  const demotion = JSON.parse(b4a.toString(await root.get(root.length - 1)))
  await root.close()
  t.alike(demotion.cuts, [{ writer: w, seq: 3 }], 'the cut covers the writer whose join is off')
  const after = await ops.groupRead(a.ctx, { group })
  t.ok(after.items.find((p) => p.seq === 1).hidden, 'still hidden after the demotion')
})

test('rejoin names the causal latest leave, not the newest timestamp', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  // W1's leave carries a clock one hour ahead.
  const e1 = (await store.readGroupWriters(b.storage))[0]
  const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(b4a.from(e1.nonce, 'hex')))
  const core = await store.openGroupWriter(b.storage, kp)
  await store.appendGroupRecord(core, { type: 'group-leave', seen: null, cuts: [{ writer: e1.key, seq: 1 }], at: new Date(Date.now() + 3600000).toISOString() })
  await core.close()
  await ops.groupJoin(b.ctx, { group })
  const w2 = (await store.readGroupWriters(b.storage))[0].key
  await ops.groupLeave(b.ctx, { group })
  await ops.groupJoin(b.ctx, { group })
  const w3 = (await store.readGroupWriters(b.storage))[0].key
  const c3 = await store.openGroupCoreReadOnly(b.storage, w3)
  const header = JSON.parse(b4a.toString(await c3.get(0)))
  await c3.close()
  t.alike(header.rejoin, { writer: w2, seq: 1 }, 'the leave of W2, which follows W1\'s')
  t.is((await ops.groupInfo(b.ctx, { group })).role, 'member')
})

test('writes need the unlocked identity and the group key derivation', async (t) => {
  const { a } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const noGroupKeys = { storage: a.storage, association: a.ctx.association, keyPair: a.ctx.keyPair }
  for (const ctx of [a.locked, noGroupKeys]) {
    await t.exception(() => ops.groupCreate(ctx, { name: 'X', join: 'open' }), /identidade bloqueada/)
    await t.exception(() => ops.groupPost(ctx, { group, text: 'oi' }), /identidade bloqueada/)
    await t.exception(() => ops.groupJoin(ctx, { group }), /identidade bloqueada/)
    await t.exception(() => ops.groupLeave(ctx, { group }), /identidade bloqueada/)
    await t.exception(() => ops.groupHide(ctx, { group, target: { writer: group, seq: 1 }, on: true }), /identidade bloqueada/)
    await t.exception(() => ops.groupMeta(ctx, { group, name: 'Y' }), /identidade bloqueada/)
  }
  t.is((await ops.groupRead(a.locked, { group })).items.length, 0, 'reads work locked')

  const core = await store.openGroupWriter(a.storage, { publicKey: b4a.from(group, 'hex') })
  await t.exception(() => store.appendGroupRecord(core, { type: 'group-leave', at: new Date().toISOString() }, { root: true }), /identidade bloqueada/, 'no secret: read-only')
  await core.close()
})

test('a diary banned before it had a writer cannot join', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Fechado', join: 'open' })
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /sem permissão no grupo/)
  t.is((await store.readGroupWriters(b.storage)).length, 0, 'no writer created')
})

test('a leave from another device of the diary ends this device writer too', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(b.ctx, { name: 'Roda', join: 'open' })
  await shareGroupCore(b, a, group)
  await shareDiary(b, a)
  await ops.groupJoin(a.ctx, { group })
  const first = (await store.readGroupWriters(a.storage)).find((e) => e.group === group).key
  // Another device of Ana: its own writer, bound by the same diary, leaves.
  const kp = await groupKeyPairFromPrf(a.prf, new Uint8Array(crypto.randomBytes(32)))
  const other = await store.openGroupWriter(a.storage, kp)
  const otherKey = hex(other.key)
  await store.appendGroupRecord(other, grp.writerHeader({ group, diary: a.ownHex }), { root: false })
  await store.appendGroupRecord(other, grp.groupLeave({}), { root: false })
  await other.close()
  await store.addGroupReplica(a.storage, otherKey)
  const diary = await store.openDiary(a.storage, a.ctx.keyPair)
  await store.appendRecord(diary, groupJoinRecord({ group, writer: otherKey, on: true }))
  await diary.close()
  t.is((await ops.groupInfo(a.ctx, { group })).state, 'left')
  await t.exception(() => ops.groupPost(a.ctx, { group, text: 'oi' }), /sem permissão no grupo/)
  t.alike(await ops.groupJoin(a.ctx, { group }), { state: 'member' }, 'a rejoin, not a no-op')
  const entry = (await store.readGroupWriters(a.storage)).find((e) => e.group === group)
  t.not(entry.key, first, 'a new writer naming the other device leave')
  t.is((await ops.groupPost(a.ctx, { group, text: 'voltei' })).seq, 1)
})

// Another device of `m`: a writer core of m's diary, bound by a join on.
async function otherDevice (m, group, records) {
  const kp = await groupKeyPairFromPrf(m.prf, new Uint8Array(crypto.randomBytes(32)))
  const core = await store.openGroupWriter(m.storage, kp)
  const key = hex(core.key)
  for (const record of records) await store.appendGroupRecord(core, record, { root: false })
  await core.close()
  await store.addGroupReplica(m.storage, key)
  const diary = await store.openDiary(m.storage, m.ctx.keyPair)
  await store.appendRecord(diary, groupJoinRecord({ group, writer: key, on: true }))
  await diary.close()
  return key
}

test('a demotion cuts only writers the fold counted', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'apagar' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  // Writers of the same diary the fold rejects: their rejoin names a post.
  const rejected = []
  for (let i = 0; i < MAX_GROUP_CUTS + 1; i++) {
    rejected.push(await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex, rejoin: { writer: group, seq: 1 } })]))
  }
  for (const key of [w, ...rejected]) await shareGroupCore(b, a, key)
  await shareDiary(b, a)
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true })
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: false })
  const root = await store.openGroupCoreReadOnly(a.storage, group)
  const demotion = JSON.parse(b4a.toString(await root.get(root.length - 1)))
  await root.close()
  t.alike(demotion.cuts.map((c) => c.writer), [w], 'the rejected writers never take a cut slot')
})

test('a leave orders after another device rejoin whose clock is ahead', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(b.ctx, { name: 'Roda', join: 'open' })
  await shareGroupCore(b, a, group)
  await shareDiary(b, a)
  await ops.groupJoin(a.ctx, { group })
  const o1 = await otherDevice(a, group, [grp.writerHeader({ group, diary: a.ownHex }), grp.groupLeave({})])
  const ahead = new Date(Date.now() + 3600000).toISOString()
  await otherDevice(a, group, [grp.writerHeader({ group, diary: a.ownHex, rejoin: { writer: o1, seq: 1 }, at: ahead })])
  t.is((await ops.groupInfo(a.ctx, { group })).state, 'member', 'the other device rejoined')
  t.alike(await ops.groupLeave(a.ctx, { group }), { state: 'left' })
  t.is((await ops.groupInfo(a.ctx, { group })).state, 'left', 'the fold agrees')
})

test('moderation orders after another device rejoin whose clock is ahead', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Roda', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true })
  await shareGroupCore(a, b, group)
  const o1 = await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex }), grp.groupLeave({})])
  const ahead = new Date(Date.now() + 3600000).toISOString()
  await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex, rejoin: { writer: o1, seq: 1 }, at: ahead })])
  t.is((await ops.groupInfo(b.ctx, { group })).role, 'admin', 'the other device rejoined')
  const stranger = 'ab'.repeat(32)
  t.alike(await ops.groupBan(b.ctx, { group, member: stranger, on: true }), { ok: true })
  t.alike(await ops.groupBan(b.ctx, { group, member: stranger, on: false }), { ok: true }, 'the ban took effect')
  const core = await store.openGroupCoreReadOnly(b.storage, w)
  const ban = JSON.parse(b4a.toString(await core.get(1)))
  await core.close()
  t.ok(ban.seen !== null, 'the ban names the fold last node')
})

test('an author hides their own post after leaving', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await ops.groupPost(b.ctx, { group, text: 'meu' })
  await ops.groupLeave(b.ctx, { group })
  await t.exception(() => ops.groupHide(b.ctx, { group, target: { writer: group, seq: 1 }, on: true }), /sem permissão no grupo/, 'not someone else\'s')
  t.alike(await ops.groupHide(b.ctx, { group, target: { writer: w, seq: 1 }, on: true }), { ok: true })
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  const post = (await ops.groupRead(a.ctx, { group })).items.find((p) => p.writer === w && p.seq === 1)
  t.ok(post.hidden, 'hidden by its author')
})

async function lastRecord (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try {
    return JSON.parse(b4a.toString(await core.get(core.length - 1)))
  } finally {
    await core.close()
  }
}

test('a leave cuts every counted writer of the own diary at its local length', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'raiz' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await ops.groupPost(b.ctx, { group, text: 'meu' })
  const o = await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex })])
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  const leave = await lastRecord(b, w)
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts, [{ writer: w, seq: 2 }, { writer: o, seq: 1 }].sort((x, y) => x.writer < y.writer ? -1 : 1))
  t.alike(await ops.groupLeave(a.ctx, { group }), { state: 'left' })
  t.alike((await lastRecord(a, group)).cuts, [{ writer: group, seq: 2 }], 'the creator lists the root')
})

test('an admin grant cuts the promoted writers at their local length', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await ops.groupPost(b.ctx, { group, text: 'antes' })
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true })
  t.alike((await lastRecord(a, group)).cuts, [{ writer: w, seq: 2 }], 'never seq 0')
})

test('a join refuses a new writer when the own diary has the most writers it can count', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  for (let i = 1; i < grp.MAX_GROUP_WRITERS_PER_DIARY; i++) {
    await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex })])
  }
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  const before = (await store.readGroupWriters(b.storage))[0].key
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /limite do grupo atingido/)
  t.is((await store.readGroupWriters(b.storage))[0].key, before, 'no writer created')
})

test('info and list answer left for a diary the fold does not list', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  const info = await ops.groupInfo(b.ctx, { group })
  t.is(info.state, 'left')
  t.is(info.role, 'left')
})

test('a group operation reads only that group\'s cores and the diaries binding them', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const { group: other } = await ops.groupCreate(a.ctx, { name: 'Feira', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareGroupCore(a, b, other)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  await ops.groupJoin(b.ctx, { group: other })
  const wOther = (await store.readGroupWriters(b.storage)).find((e) => e.group === other).key
  await shareGroupCore(b, a, wOther)
  await shareDiary(b, a)
  await store.writeFollows(a.storage, [b.ownHex])
  const read = store.readAll
  const lengths = []
  store.readAll = async (core) => {
    lengths.push(core.length)
    return read(core)
  }
  let info
  try {
    info = await ops.groupInfo(a.ctx, { group })
  } finally {
    store.readAll = read
  }
  t.is(info.members, 1, 'B\'s diary binds no core of this group here')
  // The own diary and this group's root: never B's diary nor the writer
  // core of the other group.
  t.is(lengths.length, 2, 'only the own diary and the root are decoded')
  t.is((await ops.groupInfo(a.ctx, { group: other })).members, 2, 'the other group still reads B')
})

test('a group blocked in the stored snapshot reads as unknown, its cores stay', async (t) => {
  const { a } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const other = await ops.groupCreate(a.ctx, { name: 'Roda', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'oi' })
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assocKp)
  await store.writeBlocklist(a.storage, createSnapshot({ seq: 1, blocked: [group] }, modKp, modCert))
  for (const run of [
    () => ops.groupRead(a.ctx, { group }),
    () => ops.groupInfo(a.ctx, { group }),
    () => ops.groupMembers(a.ctx, { group }),
    () => ops.groupPost(a.ctx, { group, text: 'de novo' }),
    () => ops.groupMeta(a.ctx, { group, name: 'Outro' }),
    () => ops.groupLeave(a.ctx, { group })
  ]) {
    await t.exception(run, /grupo não encontrado/)
  }
  const list = await ops.groupList(a.ctx)
  t.alike(list.groups.map((g) => g.group), [other.group], 'left out of the list')
  t.is(list.total, 1)
  t.ok(await store.groupCoreExists(a.storage, group), 'local cores kept')
})

test('a missing cursor pages by order key over the causal order, never by a count', async (t) => {
  const { a } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  const base = Date.now() - 3600000
  const at = (s) => new Date(base + s * 1000).toISOString()
  const entry = (await store.readGroupWriters(a.storage))[0]
  const kp = await groupKeyPairFromPrf(a.prf, new Uint8Array(b4a.from(entry.rootNonce, 'hex')))
  const root = await store.openGroupWriter(a.storage, kp)
  // Same writer, so seq order: causal [100, 10] while the clocks say 10 < 100.
  await store.appendGroupRecord(root, grp.groupPost({ text: 'cem', at: at(100) }), { root: true })
  await store.appendGroupRecord(root, grp.groupPost({ text: 'dez', at: at(10) }), { root: true })
  await root.close()
  const page = await ops.groupRead(a.ctx, { group, before: { at: at(50), writer: hex(crypto.randomBytes(32)), seq: 1 } })
  t.alike(page.items.map((p) => p.text), ['dez'], 'only the post older than the cursor')
  t.is(page.next, null)
})

test('kv caps: at most 64 groups that still write; a left joined group gives way, a created one never', async (t) => {
  const { a, b } = await pair()
  const { group: joined } = await ops.groupCreate(b.ctx, { name: 'de Bia', join: 'open' })
  await shareGroupCore(b, a, joined)
  await shareDiary(b, a)
  await ops.groupJoin(a.ctx, { group: joined })
  const joinedWriter = (await store.readGroupWriters(a.storage)).find((e) => e.group === joined).key
  const groups = []
  for (let i = 1; i < MAX_GROUPS_PER_DIARY; i++) groups.push((await ops.groupCreate(a.ctx, { name: 'g' + i, join: 'open' })).group)
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'demais', join: 'open' }), /limite de grupos atingido/)
  await t.exception(() => store.putGroupWriter(a.storage, { group: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(32)) }), /limite de grupos atingido/)
  await ops.groupLeave(a.ctx, { group: groups[3] })
  await t.exception(() => ops.groupCreate(a.ctx, { name: 'ainda não', join: 'open' }), /limite de grupos atingido/, 'a created group keeps its root nonce')
  await ops.groupLeave(a.ctx, { group: joined })
  const { group } = await ops.groupCreate(a.ctx, { name: 'cabe', join: 'open' })
  const entries = await store.readGroupWriters(a.storage)
  t.is(entries.length, MAX_GROUPS_PER_DIARY)
  t.absent(entries.some((e) => e.group === joined), 'the left joined group gave way')
  t.ok(entries.some((e) => e.group === groups[3]), 'the left created group stays')
  t.ok(entries.some((e) => e.group === group))
  t.ok((await store.readGroupReplicas(a.storage)).includes(joinedWriter), 'its writer stays readable')
  t.is((await ops.groupList(a.ctx, { offset: 60, limit: 10 })).groups.length, 4)
  t.is((await ops.groupList(a.ctx)).total, MAX_GROUPS_PER_DIARY)

  const planted = Array.from({ length: 70 }, () => ({ group: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(32)) }))
  await a.storage.writeJson('groupWriters', { v: 1, entries: [...planted, { group: 'zz', key: 1, nonce: null }] })
  t.is((await store.readGroupWriters(a.storage)).length, MAX_GROUPS_PER_DIARY, 'read capped')
  await a.storage.writeJson('groupReplicas', { v: 1, keys: ['x', planted[0].key, planted[0].key.toUpperCase()] })
  t.alike(await store.readGroupReplicas(a.storage), [planted[0].key], 'invalid and duplicate keys dropped')
  await a.storage.writeJson('groupWriters', '{torn')
  t.alike(await store.readGroupWriters(a.storage), [])
})

test('a joined group left through another device gives way and leaving it again writes nothing', async (t) => {
  const { a, b } = await pair()
  const { group: joined } = await ops.groupCreate(b.ctx, { name: 'de Bia', join: 'open' })
  await shareGroupCore(b, a, joined)
  await shareDiary(b, a)
  await ops.groupJoin(a.ctx, { group: joined })
  const own = (await store.readGroupWriters(a.storage)).find((e) => e.group === joined)
  for (let i = 1; i < MAX_GROUPS_PER_DIARY; i++) await ops.groupCreate(a.ctx, { name: 'g' + i, join: 'open' })
  await otherDevice(a, joined, [grp.writerHeader({ group: joined, diary: a.ownHex }), grp.groupLeave({})])
  t.is((await ops.groupInfo(a.ctx, { group: joined })).state, 'left')
  const records = (await diaryRecords(a)).length
  const length = async () => {
    const core = await store.openGroupCoreReadOnly(a.storage, own.key)
    try {
      return core.length
    } finally {
      await core.close()
    }
  }
  const before = await length()
  t.alike(await ops.groupLeave(a.ctx, { group: joined }), { state: 'left' })
  t.is(await length(), before, 'nothing written to the own writer')
  t.is((await diaryRecords(a)).length, records, 'no diary join')
  const { group } = await ops.groupCreate(a.ctx, { name: 'cabe', join: 'open' })
  const entries = await store.readGroupWriters(a.storage)
  t.is(entries.length, MAX_GROUPS_PER_DIARY)
  t.absent(entries.some((e) => e.group === joined), 'the group left elsewhere gave way')
  t.ok(entries.some((e) => e.group === group))
})

test('group cores are stored with a lazy data file', async (t) => {
  const storage = memoryNodeStorage()
  const seen = new Map()
  const core = storage.core.bind(storage)
  storage.core = (name, opts) => {
    seen.set(name, opts)
    return core(name, opts)
  }
  const kp = crypto.keyPair()
  const own = await store.openGroupWriter(storage, kp)
  await own.close()
  const key = hex(crypto.randomBytes(32))
  const replica = await store.openGroupReplica(storage, key)
  await replica.close()
  t.alike(seen.get(store.groupName(hex(kp.publicKey))), { lazy: ['data'] })
  t.alike(seen.get(store.groupName(key)), { lazy: ['data'] }, 'replica opened lazily')
  t.is(store.groupName(key), 'group/' + key)
  t.is(await store.openGroupCoreReadOnly(storage, 'xyz'), null)
})

test('an own writer beyond the writer cap refuses to post, hide, moderate or leave', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Cheia', join: 'open' })
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  // Other devices of Bia hold the lowest keys, so the cap counts them and
  // leaves out the writer this device lists.
  const cores = []
  for (let i = 0; i < grp.MAX_GROUP_WRITERS; i++) {
    const nonce = crypto.randomBytes(32)
    const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(nonce))
    const core = await store.openGroupWriter(b.storage, kp)
    await store.appendGroupRecord(core, grp.writerHeader({ group, diary: b.ownHex }), { root: false })
    cores.push({ key: hex(core.key), nonce: hex(nonce), core })
  }
  cores.sort((x, y) => (x.key < y.key ? -1 : 1))
  const target = { writer: cores[0].key, seq: await store.appendGroupRecord(cores[0].core, grp.groupPost({ text: 'meu' }), { root: false }) }
  for (const c of cores) await c.core.close()
  const local = cores[cores.length - 1]
  const diary = await store.openDiary(b.storage, b.ctx.keyPair)
  for (const c of cores) await store.appendRecord(diary, groupJoinRecord({ group, writer: c.key, on: true }))
  await diary.close()
  await b.storage.writeJson('groupReplicas', { v: 1, keys: cores.slice(0, -1).map((c) => c.key) })
  await store.putGroupWriter(b.storage, { group, key: local.key, nonce: local.nonce, rootNonce: null })
  const info = await ops.groupInfo(b.ctx, { group })
  t.is(info.state, 'member', 'the counted writers keep the diary a member')
  t.is(info.role, 'admin')
  const length = async () => {
    const core = await store.openGroupCoreReadOnly(b.storage, local.key)
    try {
      return core.length
    } finally {
      await core.close()
    }
  }
  t.is(await length(), 1)
  await t.exception(() => ops.groupPost(b.ctx, { group, text: 'perdida' }), /limite do grupo atingido/)
  await t.exception(() => ops.groupHide(b.ctx, { group, target, on: true }), /limite do grupo atingido/)
  await t.exception(() => ops.groupBan(b.ctx, { group, member: 'ab'.repeat(32), on: true }), /limite do grupo atingido/)
  await t.exception(() => ops.groupLeave(b.ctx, { group }), /limite do grupo atingido/)
  t.is(await length(), 1, 'nothing written to the uncounted writer')
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member')
  const records = (await diaryRecords(b)).length
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /limite do grupo atingido/, 'a join never reports an uncounted writer as a member')
  t.is(await length(), 1)
  t.is((await diaryRecords(b)).length, records)
})

test('a join refuses before creating a writer when the fold already counts the writer cap', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Cheia', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  // Other devices of Bia fill every counted slot; this device has none.
  const keys = []
  const diary = await store.openDiary(b.storage, b.ctx.keyPair)
  for (let i = 0; i < grp.MAX_GROUP_WRITERS - 1; i++) {
    const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(crypto.randomBytes(32)))
    const core = await store.openGroupWriter(b.storage, kp)
    await store.appendGroupRecord(core, grp.writerHeader({ group, diary: b.ownHex }), { root: false })
    keys.push(hex(core.key))
    await core.close()
    await store.appendRecord(diary, groupJoinRecord({ group, writer: keys[i], on: true }))
  }
  await diary.close()
  await b.storage.writeJson('groupReplicas', { v: 1, keys })
  const records = (await diaryRecords(b)).length
  const derived = b.derived.length
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /limite do grupo atingido/)
  t.alike(await store.readGroupWriters(b.storage), [], 'no local entry')
  t.is(b.derived.length, derived, 'no writer created')
  t.is((await diaryRecords(b)).length, records, 'no diary join')
})

test('a blocked creator is no member or admin: charter writes refuse and members leave it out', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  await shareGroupCore(b, a, (await store.readGroupWriters(b.storage))[0].key)
  await shareDiary(b, a)
  t.is((await ops.groupMembers(a.ctx, { group })).total, 2)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, a.assocKp)
  await store.writeBlocklist(a.storage, createSnapshot({ seq: 1, blocked: [a.ownHex] }, modKp, modCert))
  const rootLength = async () => {
    const core = await store.openGroupCoreReadOnly(a.storage, group)
    try {
      return core.length
    } finally {
      await core.close()
    }
  }
  const before = await rootLength()
  await t.exception(() => ops.groupMeta(a.ctx, { group, name: 'Outra' }), /sem permissão no grupo/)
  await t.exception(() => ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true }), /sem permissão no grupo/)
  t.is(await rootLength(), before, 'nothing appended to the root')
  const members = await ops.groupMembers(a.ctx, { group })
  t.alike(members.members.map((m) => m.member), [b.ownHex])
  t.is(members.total, 1)
})

test('a blocked own diary drops its writers from the fold and group writes refuse', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'Ana' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  await ops.groupPost(b.ctx, { group, text: 'Bia' })
  t.is((await ops.groupRead(b.ctx, { group })).items.length, 2)
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, b.assocKp)
  await store.writeBlocklist(b.storage, createSnapshot({ seq: 1, blocked: [b.ownHex] }, modKp, modCert))
  t.alike((await ops.groupRead(b.ctx, { group })).items.map((p) => p.text), ['Ana'], 'blocked own writers are excluded')
  t.absent((await ops.groupMembers(b.ctx, { group })).members.some((m) => m.member === b.ownHex))
  const records = (await diaryRecords(b)).length
  await t.exception(() => ops.groupPost(b.ctx, { group, text: 'bloqueada' }), /sem permissão no grupo/)
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /sem permissão no grupo/)
  t.is((await diaryRecords(b)).length, records, 'no diary join from a blocked own diary')
})

function groupJoins (records, group) {
  return records.filter((r) => r.type === 'group-join' && r.group === group)
}

async function pendingPair (join = 'open', { ban = false } = {}) {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join })
  if (ban) await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true })
  return { a, b, group }
}

async function rootArrives (a, b, group) {
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
}

test('a join by key before the root arrives is pending until a sync brings it', async (t) => {
  const { a, b, group } = await pendingPair()
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' })
  const entries = await store.readGroupWriters(b.storage)
  t.is(entries.length, 1)
  t.alike({ group: entries[0].group, rootNonce: entries[0].rootNonce }, { group, rootNonce: null })
  t.is(b.derived.length, 1, 'exactly one writer created')
  t.ok((await store.readGroupReplicas(b.storage)).includes(group), 'the next sync fetches the root')
  const header = (await readGroupCoreEntries(b, entries[0].key))[0].record
  t.alike({ type: header.type, group: header.group, diary: header.diary, rejoin: header.rejoin }, { type: 'group-writer', group, diary: b.ownHex, rejoin: null })
  const joins = groupJoins(await diaryRecords(b), group)
  t.alike(joins.map((j) => [j.writer, j.on]), [[entries[0].key, true]])

  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' }, 'a second join stays pending')
  t.alike(await store.readGroupWriters(b.storage), entries, 'no second writer')
  t.is(b.derived.length, 1)
  t.is(groupJoins(await diaryRecords(b), group).length, 1, 'no second diary join')
  t.alike(await ops.groupList(b.ctx), { groups: [{ group, name: null, join: null, role: 'pending', members: 0 }], total: 1 })
  t.alike(await ops.groupInfo(b.ctx, { group }), { group, name: null, join: null, creator: null, role: 'pending', members: 0, state: 'pending', communities: [] })
  t.alike(await ops.groupInfo(b.locked, { group }), { group, name: null, join: null, creator: null, role: 'pending', members: 0, state: 'pending', communities: [] }, 'reads work locked')
  t.alike(await ops.groupRead(b.ctx, { group }), { items: [], next: null, hidden: 0, incomplete: true })

  await rootArrives(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  t.alike(await store.readGroupWriters(b.storage), entries)
  t.is((await ops.groupPost(b.ctx, { group, text: 'oi' })).seq, 1)
})

async function readGroupCoreEntries (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  try {
    return await store.readAll(core)
  } finally {
    await core.close()
  }
}

test('a pending join of an approval group becomes a request', async (t) => {
  const { a, b, group } = await pendingPair('approval')
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' })
  await rootArrives(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'requested')
  t.is((await ops.groupList(b.ctx)).groups[0].role, 'requested')
})

test('a ban written before a pending join shows once the root arrives', async (t) => {
  const { a, b, group } = await pendingPair('open', { ban: true })
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' })
  await rootArrives(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'banned')
})

test('a pending group can be left and refuses every other write', async (t) => {
  const { a, b, group } = await pendingPair()
  const unknown = 'f'.repeat(64)
  await t.exception(() => ops.groupLeave(b.ctx, { group }), /grupo não encontrado/)
  await t.exception(() => ops.groupInfo(b.ctx, { group: unknown }), /grupo não encontrado/)
  await t.exception(() => ops.groupRead(b.ctx, { group: unknown }), /grupo não encontrado/)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' })
  const refused = [
    () => ops.groupMembers(b.ctx, { group }),
    () => ops.groupRequests(b.ctx, { group }),
    () => ops.groupPost(b.ctx, { group, text: 'não' }),
    () => ops.groupHide(b.ctx, { group, target: { writer: group, seq: 1 }, on: true }),
    () => ops.groupAdmit(b.ctx, { group, member: a.ownHex, on: true }),
    () => ops.groupBan(b.ctx, { group, member: a.ownHex, on: true }),
    () => ops.groupAdmin(b.ctx, { group, member: a.ownHex, on: true }),
    () => ops.groupMeta(b.ctx, { group, name: 'Outra' })
  ]
  for (const run of refused) await t.exception(run, /grupo não encontrado/)
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  const own = (await store.readGroupWriters(b.storage))[0]
  const leave = (await readGroupCoreEntries(b, own.key))[1].record
  t.alike(leave, { type: 'group-leave', seen: null, cuts: [{ writer: own.key, seq: 1 }], at: leave.at })
  t.alike(groupJoins(await diaryRecords(b), group).map((j) => j.on), [true, false])
  await t.exception(() => ops.groupLeave(b.ctx, { group }), /nada a alterar/)
  t.is((await ops.groupList(b.ctx)).groups[0].role, 'pending')
  await rootArrives(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'left')
})

test('a pending leave waits when the own diary binds another writer of the group', async (t) => {
  const { b, group } = await pendingPair()
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'pending' })
  const diary = await store.openDiary(b.storage, b.ctx.keyPair)
  await store.appendRecord(diary, groupJoinRecord({ group, writer: 'cd'.repeat(32), on: true }))
  await diary.close()
  await t.exception(() => ops.groupLeave(b.ctx, { group }), /aguarde a sincronização do grupo para sair/)
  const own = (await store.readGroupWriters(b.storage))[0]
  t.is((await readGroupCoreEntries(b, own.key)).length, 1, 'no leave written')
})

test('a grant cuts a writer at its signed length when blocks are missing locally', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await ops.groupPost(b.ctx, { group, text: 'um' })
  await ops.groupPost(b.ctx, { group, text: 'dois' })
  // Only blocks 0 and 1 reach Ana: the signed length is 3.
  const src = await store.openGroupCoreReadOnly(b.storage, w)
  const dst = await store.openGroupReplica(a.storage, w)
  const s1 = src.replicate(true, { keepAlive: false })
  const s2 = dst.replicate(false, { keepAlive: false })
  s1.pipe(s2).pipe(s1)
  try {
    await dst.update({ wait: true })
    await dst.get(0)
    await dst.get(1)
  } finally {
    s1.destroy()
    s2.destroy()
  }
  t.alike([dst.length, dst.contiguousLength], [3, 2])
  await src.close()
  await dst.close()
  await store.addGroupReplica(a.storage, w)
  await shareDiary(b, a)
  await ops.groupAdmin(a.ctx, { group, member: b.ownHex, on: true })
  t.alike((await lastRecord(a, group)).cuts, [{ writer: w, seq: 3 }], 'the unseen signed record stays below the cut')
})

test('an unban cuts a writer at its signed length when blocks are missing locally', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await ops.groupPost(b.ctx, { group, text: 'um' })
  await ops.groupPost(b.ctx, { group, text: 'dois' })
  const src = await store.openGroupCoreReadOnly(b.storage, w)
  const dst = await store.openGroupReplica(a.storage, w)
  const s1 = src.replicate(true, { keepAlive: false })
  const s2 = dst.replicate(false, { keepAlive: false })
  s1.pipe(s2).pipe(s1)
  try {
    await dst.update({ wait: true })
    await dst.get(0)
    await dst.get(1)
  } finally {
    s1.destroy()
    s2.destroy()
  }
  t.alike([dst.length, dst.contiguousLength], [3, 2])
  await src.close()
  await dst.close()
  await store.addGroupReplica(a.storage, w)
  await shareDiary(b, a)
  await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true })
  await ops.groupBan(a.ctx, { group, member: b.ownHex, on: false })
  t.alike((await lastRecord(a, group)).cuts, [{ writer: w, seq: 3 }], 'the unseen signed record stays below the cut')
})

async function bindForeign (m, group, writer) {
  const diary = await store.openDiary(m.storage, m.ctx.keyPair)
  await store.appendRecord(diary, groupJoinRecord({ group, writer, on: true }))
  await diary.close()
}

test('a non-creator leaves at once although another device of the diary is not held here', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  await ops.groupJoin(b.ctx, { group })
  await bindForeign(b, group, 'cd'.repeat(32))
  const own = (await store.readGroupWriters(b.storage))[0]
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  const leave = await lastRecord(b, own.key)
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts, [{ writer: own.key, seq: 1 }], 'only the held counted writer is cut')
})

test('a creator leaves from a device that stores the root without its key, listing the root', async (t) => {
  const { a } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await ops.groupPost(a.ctx, { group, text: 'regra' })
  // Another device of the creator's diary: its own writer, no root nonce.
  const nonce = crypto.randomBytes(32)
  const kp = await groupKeyPairFromPrf(a.prf, new Uint8Array(nonce))
  const core = await store.openGroupWriter(a.storage, kp)
  await store.appendGroupRecord(core, grp.writerHeader({ group, diary: a.ownHex }), { root: false })
  await core.close()
  await bindForeign(a, group, hex(kp.publicKey))
  await a.storage.writeJson('groupWriters', { v: 1, entries: [{ group, key: hex(kp.publicKey), nonce: hex(nonce), rootNonce: null }] })
  t.alike(await ops.groupLeave(a.ctx, { group }), { state: 'left' })
  const leave = await lastRecord(a, hex(kp.publicKey))
  t.is(leave.type, 'group-leave')
  t.ok(leave.cuts.some((c) => c.writer === group && c.seq === 2), 'the root is listed at its local length')
})

test('a held writer the fold drops never makes an admit wait', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Fechada', join: 'approval' })
  await ops.groupPost(a.ctx, { group, text: 'raiz' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'requested' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  // Its rejoin names a post, not a leave: the fold rejects it, yet it is held.
  const r = await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex, rejoin: { writer: group, seq: 1 } })])
  for (const key of [w, r]) await shareGroupCore(b, a, key)
  await shareDiary(b, a)
  t.alike(await ops.groupAdmit(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
})

test('an admit waits for every counted writer of the member', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Fechada', join: 'approval' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'requested' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await bindForeign(b, group, 'cd'.repeat(32))
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  await t.exception(() => ops.groupAdmit(a.ctx, { group, member: b.ownHex, on: true }), /aguarde a sincronização do grupo para admitir/)
  t.is((await lastRecord(a, group)).type, 'group-header', 'no admit written')
})

test('a private root never folds and its entry gives up its slot', async (t) => {
  const { b } = await pair()
  for (let i = 0; i < MAX_GROUPS_PER_DIARY - 1; i++) await ops.groupCreate(b.ctx, { name: 'G' + i, join: 'open' })
  const rootKp = crypto.keyPair()
  const root = await store.openGroupWriter(b.storage, rootKp)
  await root.append({ type: 'group-header', v: 1, kind: 'group', diary: 'ef'.repeat(32), visibility: 'private', join: 'approval', name: null, box: 'ab'.repeat(32), at: new Date().toISOString() })
  await root.close()
  const group = hex(rootKp.publicKey)
  const nonce = crypto.randomBytes(32)
  const kp = await groupKeyPairFromPrf(b.prf, new Uint8Array(nonce))
  const own = await store.openGroupWriter(b.storage, kp)
  await store.appendGroupRecord(own, grp.writerHeader({ group, diary: b.ownHex }), { root: false })
  await own.close()
  await store.putGroupWriter(b.storage, { group, key: hex(kp.publicKey), nonce: hex(nonce), rootNonce: null })
  await t.exception(() => ops.groupInfo(b.ctx, { group }), /grupo não encontrado/, 'never folds')
  const { group: last } = await ops.groupCreate(b.ctx, { name: 'Nova', join: 'open' })
  const groups = (await store.readGroupWriters(b.storage)).map((e) => e.group)
  t.ok(groups.includes(last), 'the new group has a slot')
  t.absent(groups.includes(group), 'the private root gave it up')
})

test('an admitted member with a writer the admit did not list is requested again and can be admitted again', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Fechada', join: 'approval' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'requested' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  t.alike(await ops.groupAdmit(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  t.is((await ops.groupRequests(a.ctx, { group })).total, 0)
  const second = await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex }), grp.groupPost({ text: 'outro' })])
  await shareGroupCore(b, a, second)
  await shareDiary(b, a)
  t.alike((await ops.groupRead(a.ctx, { group })).items.map((p) => p.hidden), [true], 'the unlisted writer stays hidden')
  const requests = await ops.groupRequests(a.ctx, { group })
  t.alike(requests.requests.map((r) => r.member), [b.ownHex], 'listed for the admins')
  t.alike(await ops.groupAdmit(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  t.alike((await lastRecord(a, group)).cuts.map((c) => c.writer), [w, second].sort())
  t.is((await ops.groupRequests(a.ctx, { group })).total, 0)
})

test('an unban that missed a writer can be repeated citing the same ban', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  const root = await store.openGroupCoreReadOnly(a.storage, group)
  const ban = { writer: group, seq: root.length - 1 }
  await root.close()
  const second = await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex }), grp.groupPost({ text: 'durante' })])
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), { ok: true }, 'an unban before the second writer arrives')
  await shareGroupCore(b, a, second)
  await shareDiary(b, a)
  t.alike((await ops.groupRead(a.ctx, { group })).items.map((p) => p.hidden), [true], 'the unlisted writer stays banned')
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), { ok: true })
  const unban = await lastRecord(a, group)
  t.alike(unban.lifts, ban)
  t.ok(unban.cuts.some((c) => c.writer === second), 'the new unban lists the writer')
  await t.exception(() => ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), /nada a alterar/)
})

test('a member whose unban missed another writer leaves from a writer that is not banned, and still cannot join', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  const w = (await store.readGroupWriters(b.storage))[0].key
  await shareGroupCore(b, a, w)
  await shareDiary(b, a)
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  const second = await otherDevice(b, group, [grp.writerHeader({ group, diary: b.ownHex }), grp.groupPost({ text: 'durante' })])
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), { ok: true })
  await shareGroupCore(b, a, second)
  await shareDiary(b, a)
  await shareGroupCore(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member')
  await t.exception(() => ops.groupJoin(b.ctx, { group }), /sem permissão no grupo/)
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'left')
})

test('a member whose own writer an unban missed can still leave', async (t) => {
  const { a, b } = await pair()
  const { group } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open' })
  await shareGroupCore(a, b, group)
  await shareDiary(a, b)
  t.alike(await ops.groupJoin(b.ctx, { group }), { state: 'member' })
  // Ban and unban before Bia's writer arrives: the unban lists none of hers.
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: true }), { ok: true })
  t.alike(await ops.groupBan(a.ctx, { group, member: b.ownHex, on: false }), { ok: true })
  await shareGroupCore(a, b, group)
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'member')
  t.alike(await ops.groupLeave(b.ctx, { group }), { state: 'left' })
  t.is((await ops.groupInfo(b.ctx, { group })).state, 'left')
})
