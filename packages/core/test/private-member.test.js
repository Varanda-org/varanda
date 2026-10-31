'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('../lib/cert')
const store = require('../lib/store')
const member = require('../lib/member')
const groupCrypto = require('../lib/group-crypto')
const groupLib = require('../lib/group')
const { groupJoinRecord } = require('../lib/records')
const { tmpDir } = require('./helpers/tmp')

const hex = (key) => b4a.toString(key, 'hex')

async function person (t, kp, name) {
  const ctx = { dataDir: tmpDir(t), association: hex(kp.publicKey) }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  await member.profileSet(ctx, { name })
  return { ...ctx, key: publicKey }
}

// Corestore replication in process, without sockets or a DHT.
async function exchange (from, to, skip = null) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
      if (skip !== null && skip.has(hex(source.key))) {
        await source.close()
        continue
      }
      const target = b.get({ key: source.key, writable: false })
      await target.ready()
      copies.push({ source, target })
    }
    left = a.replicate(true)
    right = b.replicate(false)
    left.pipe(right).pipe(left)
    for (const { source, target } of copies) {
      for (let seq = 0; seq < source.contiguousLength; seq++) {
        await target.get(seq, { raw: true, timeout: 10000 })
      }
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

async function sync (...people) {
  for (const x of people) for (const y of people) if (x !== y) await exchange(x, y)
}

async function rootEntries (ctx, group) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(group, 'hex'), writable: false })
    await core.ready()
    return await store.readAll(core)
  } finally {
    await s.close()
  }
}

function filesOf (dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.lstatSync(p)
    if (st.isDirectory()) out.push(...filesOf(p))
    else if (st.isFile()) out.push(p)
  }
  return out
}

// Appends to this device's writer of `group` with no record check.
async function rawAppend (ctx, group, record) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const local = store.readGroups(ctx.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    return await store.appendRecord(writer, record, { validator: () => null })
  } finally {
    await s.close()
  }
}

// A writer of `group` made by hand with header `box`, recorded in
// groups.json, and bound by the diary only when `bind` is true.
async function plantWriter (ctx, group, box, bind) {
  const nonce = hex(crypto.randomBytes(16))
  const key = await member.withIdentity(ctx, async ({ store: s, diary }) => {
    const writer = await store.openGroupWriter(s, nonce)
    // Built raw: the builder refuses a low-order box.
    const header = { type: 'group-writer', v: 1, group, diary: ctx.key, box, rejoin: null, at: new Date().toISOString() }
    await store.appendRecord(writer, header, { validator: () => null })
    const k = hex(writer.key)
    if (bind) await store.appendRecord(diary, groupJoinRecord({ group, writer: k, on: true }))
    return k
  })
  store.writeGroups(ctx.dataDir, [...store.readGroups(ctx.dataDir).filter((g) => g.group !== group), { group, writer: key, nonce }])
  return key
}

function ownWriter (ctx, group) {
  return store.readGroups(ctx.dataDir).find((g) => g.group === group).writer
}

function texts (r) {
  return r.items.filter((p) => !p.hidden).map((p) => p.text).sort()
}

async function privateGroup (t) {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await exchange(a, b)
  await member.groupJoin(b, { group })
  await exchange(b, a)
  return { kp, a, b, group }
}

test('private create: sealed root, never public, creator reads its name', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  const entries = await rootEntries(a, group)
  const header = entries[0].record
  t.is(header.visibility, 'private', 'header is private')
  t.is(header.join, 'approval', 'approval forced')
  t.is(header.name, null, 'no plaintext name')
  t.is(entries[1].record.type, 'group-key', 'epoch 1 next')
  t.is(entries[1].record.kid, null)
  t.is(entries[1].record.keys[0].writer, group, 'sealed to the root')
  t.is(entries[2].record.type, 'group-sealed', 'name sealed')
  t.ok(!JSON.stringify(entries).includes('Segredo'), 'name not in plaintext')
  const info = await member.groupInfo(a, { group })
  t.is(info.visibility, 'private')
  t.is(info.name, 'Segredo')
  const read = await member.groupRead(a, { group })
  t.is(read.state, 'ok')
  t.alike(read.epoch, { writer: group, seq: 1 })
  t.is(read.sealed, 0)
  const pub = await member.groupCreate(a, { name: 'Praça', join: 'open' })
  t.is((await member.groupInfo(a, { group: pub.group })).visibility, 'public')
  t.alike((await member.groupRead(a, { group: pub.group })).epoch, null)
})

test('private: non-member reads only sealed counts; admitted member reads history', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupPost(a, { group, text: 'antes da entrada' })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  const outsider = await member.groupRead(c, { group })
  t.is(outsider.items.length, 0, 'outsider sees no post')
  t.ok(outsider.sealed >= 2, 'outsider counts sealed records')
  t.is((await member.groupInfo(c, { group })).name, null, 'no name for outsider')

  t.is((await member.groupInfo(b, { group })).state, 'requested')
  await exchange(a, b)
  t.is((await member.groupRead(b, { group })).items.length, 0, 'requested member reads nothing')
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await exchange(a, b)
  const read = await member.groupRead(b, { group })
  t.alike(texts(read), ['antes da entrada'], 'history readable after admit')
  t.is((await member.groupInfo(b, { group })).name, 'Segredo')
  await member.groupPost(b, { group, text: 'oi de Bia' })
  await exchange(b, a)
  t.alike(texts(await member.groupRead(a, { group })), ['antes da entrada', 'oi de Bia'])
})

test('private: ban rotates, banned member cannot read new posts, restart keeps keys, nothing plain on disk', async (t) => {
  const { a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await exchange(a, b)
  await member.groupPost(b, { group, text: 'antes do banimento' })
  await exchange(b, a)
  const before = (await member.groupRead(a, { group })).epoch
  await member.groupBan(a, { group, member: b.key, on: true })
  const after = (await member.groupRead(a, { group }))
  t.is(after.state, 'ok', 'creator not pending after its own ban')
  t.not(after.epoch.seq, before.seq, 'new epoch after the ban')
  await member.groupPost(a, { group, text: 'depois do banimento' })
  await exchange(a, b)
  const banned = await member.groupRead(b, { group })
  t.ok(!texts(banned).includes('depois do banimento'), 'banned member cannot read the new post')
  t.ok(banned.sealed >= 1, 'it stays sealed for the banned member')

  // A fresh read is a restart: keys come back from the envelopes alone.
  const again = await member.groupRead(a, { group })
  t.ok(texts(again).includes('depois do banimento'), 'creator reads after reload')
  for (const ctx of [a, b]) {
    for (const file of filesOf(ctx.dataDir)) {
      const raw = fs.readFileSync(file)
      t.ok(raw.indexOf('depois do banimento') === -1, 'no post text in ' + path.basename(file))
    }
  }
})

test('private: rekey-pending refuses posts until a distributor rotates; group.rekey rules', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await exchange(a, b)
  await member.groupLeave(b, { group })
  await exchange(b, a)
  const pending = await member.groupRead(a, { group })
  t.is(pending.state, 'rekey-pending', 'a leave leaves the group pending')
  await t.exception(member.groupPost(a, { group, text: 'x' }), /aguardando nova chave/)
  await t.exception(member.groupMeta(a, { group, name: 'Outro' }), /aguardando nova chave/)
  const r = await member.groupRekey(a, { group })
  t.is(r.group, group)
  t.alike((await member.groupRead(a, { group })).epoch, r.epoch, 'new epoch in use')
  await member.groupPost(a, { group, text: 'de novo' })
  t.alike(texts(await member.groupRead(a, { group })), ['de novo'])

  const pub = await member.groupCreate(a, { name: 'Praça', join: 'open' })
  await t.exception(member.groupRekey(a, { group: pub.group }), /grupo público não usa chave/)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await t.exception(member.groupRekey(c, { group }), /sem permissão no grupo/)
})

test('private: pending new device gets no key; concurrent admin rotations both decrypt; creator reads after admin rotation', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).role, 'admin')
  t.is((await member.groupRead(b, { group })).state, 'ok')

  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await sync(a, b, c)
  // Both admins rotate from the same state.
  const ra = await member.groupRekey(a, { group })
  const rb = await member.groupRekey(b, { group })
  t.not(ra.epoch.writer, rb.epoch.writer, 'distinct kids')
  await sync(a, b, c)
  await member.groupPost(a, { group, text: 'ramo de Ana' })
  await member.groupPost(b, { group, text: 'ramo de Bia' })
  await sync(a, b, c)
  t.alike(texts(await member.groupRead(a, { group })), ['ramo de Ana', 'ramo de Bia'], 'creator reads both branches')
  t.alike(texts(await member.groupRead(b, { group })), ['ramo de Ana', 'ramo de Bia'], 'admin reads both branches')
  const pendingRead = await member.groupRead(c, { group })
  t.is(pendingRead.items.length, 0, 'a pending writer received no key')
  t.is(pendingRead.epoch, null)

  // The creator reads what is sealed under the other admin's newest epoch.
  await member.groupRekey(b, { group })
  await exchange(b, a)
  await member.groupPost(b, { group, text: 'depois da rotação de Bia' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group })).includes('depois da rotação de Bia'))
})

test('private: the epoch key never lands on disk in the clear', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await member.groupPost(a, { group, text: 'texto secreto' })
  const entries = await rootEntries(a, group)
  const box = store.ensureBoxKeyPair(a.dataDir)
  const key = groupCrypto.openEpochKey(b4a.from(entries[1].record.keys[0].sealed, 'base64'), box, group, { writer: group, seq: 1 })
  t.ok(key !== null && key.byteLength === 32, 'test opens epoch 1')
  const forms = [key, b4a.from(hex(key)), b4a.from(b4a.toString(key, 'base64'))]
  for (const file of filesOf(a.dataDir)) {
    const raw = fs.readFileSync(file)
    t.ok(forms.every((f) => raw.indexOf(f) === -1), 'no epoch key in ' + path.basename(file))
    t.ok(raw.indexOf('texto secreto') === -1, 'no text in ' + path.basename(file))
  }
  groupCrypto.wipe(key)
  groupCrypto.wipe(box.secretKey)
})

test('private: community admins with power get keys; demotion rotates them out', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  await member.communityLink(a, { community, group, on: true })
  await member.groupPost(a, { group, text: 'antes' })
  await exchange(a, b)
  await member.groupJoin(b, { group })
  await exchange(b, a)
  t.is((await member.groupRead(b, { group })).items.length, 0, 'requested: no key')
  await member.communityAdmin(a, { community, member: b.key, on: true })
  await exchange(a, b)
  t.alike(texts(await member.groupRead(b, { group })), ['antes'], 'community admin reads history')
  t.is((await member.groupRead(b, { group })).state, 'ok')
  await member.communityAdmin(a, { community, member: b.key, on: false })
  t.is((await member.groupRead(a, { group })).state, 'ok', 'demotion rotated')
  await member.groupPost(a, { group, text: 'depois' })
  await exchange(a, b)
  t.ok(!texts(await member.groupRead(b, { group })).includes('depois'), 'demoted admin cannot read')
})

test('private: an epoch from an admin later demoted still goes to a newly admitted member', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  await member.groupRekey(b, { group })
  await member.groupPost(b, { group, text: 'sob a chave de Bia' })
  await exchange(b, a)
  await member.groupAdmin(a, { group, member: b.key, on: false })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await exchange(c, a)
  await member.groupAdmit(a, { group, member: c.key, on: true })
  await exchange(a, c)
  t.ok(texts(await member.groupRead(c, { group })).includes('sob a chave de Bia'), 'history under the demoted admin epoch')
})

test('private: a delivery that never happened is recovered by group.rekey', async (t) => {
  const { a, b, group } = await privateGroup(t)
  await member.groupPost(a, { group, text: 'antes' })
  // An admit written without its key blocks, as after a failed append.
  await rawAppend(a, group, groupLib.groupAdmit({ member: b.key, on: true, cuts: [{ writer: ownWriter(b, group), seq: 1 }] }))
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member', 'admitted')
  t.is((await member.groupRead(b, { group })).items.length, 0, 'no key yet')
  await member.groupRekey(a, { group })
  await exchange(a, b)
  const read = await member.groupRead(b, { group })
  t.alike(texts(read), ['antes'], 'the missing epoch arrived')
  t.is(read.state, 'ok')
})

test('private: a malformed group-key in a counted writer breaks neither admission nor history', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupPost(a, { group, text: 'histórico' })
  await exchange(a, b)
  await rawAppend(b, group, { type: 'group-key' })
  await exchange(b, a)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await exchange(c, a)
  t.alike(await member.groupAdmit(a, { group, member: c.key, on: true }), { ok: true })
  await exchange(a, c)
  t.is((await member.groupInfo(c, { group })).state, 'member')
  t.alike(texts(await member.groupRead(c, { group })), ['histórico'])
})

test('private: a recipient box sodium refuses is skipped, never failing rotation or history', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await plantWriter(c, group, '00'.repeat(32), true)
  await exchange(c, a)
  // The fold refuses a low-order box as an invalid header, so that writer
  // is never held or entitled; the per-recipient skip stays as a guard.
  await t.exception(member.groupAdmit(a, { group, member: c.key, on: true }), /aguarde a sincronização/)
  await member.groupPost(a, { group, text: 'antes' })
  const r = await member.groupRekey(a, { group })
  t.ok(r.epoch, 'group.rekey succeeds')
  await member.groupPost(a, { group, text: 'depois' })
  await exchange(a, b)
  const read = await member.groupRead(b, { group })
  t.alike(texts(read), ['antes', 'depois'], 'the other recipients still get the keys')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('private: fake bans from an unadmitted writer never inflate a rotation', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  const s = await store.openStore(c.dataDir)
  try {
    const local = store.readGroups(c.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    const target = hex(crypto.randomBytes(32))
    for (let i = 0; i < 5000; i++) {
      await store.appendRecord(writer, groupLib.groupBan({ member: target, on: true, cuts: [] }), { validator: () => null })
    }
  } finally {
    await s.close()
  }
  await exchange(c, a)
  const firsts = async () => (await rootEntries(a, group)).filter((e) => e.seq >= 1 && e.record.type === 'group-key' && e.record.kid === null)
  const before = (await firsts()).length
  await member.groupBan(a, { group, member: b.key, on: true })
  const after = await firsts()
  t.is(after.length, before + 1, 'exactly one new epoch')
  t.ok(after[after.length - 1].record.basis.length <= 2, 'basis from the fold removals only')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('private: an own writer created but never bound is rebound, not replaced', async (t) => {
  const { kp, a, group } = await privateGroup(t)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  const box = hex(store.ensureBoxKeyPair(c.dataDir).publicKey)
  const writer = await plantWriter(c, group, box, false)
  t.alike(await member.groupJoin(c, { group }), { state: 'requested' })
  t.is(ownWriter(c, group), writer, 'same writer kept in groups.json')
  const { entries } = await member.logRead(c)
  t.alike(groupLib.groupJoinHistory(entries, group).map((j) => [j.writer, j.on]), [[writer, true]], 'bound once')
})

test('private: a join by key before the root arrives is replaced by a writer with a box', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  const boxless = ownWriter(b, group)
  await exchange(a, b)
  t.alike(await member.groupJoin(b, { group }), { state: 'requested' })
  t.not(ownWriter(b, group), boxless, 'a new writer')
  const { entries } = await member.logRead(b)
  t.alike(groupLib.groupJoinHistory(entries, group).filter((j) => j.writer === boxless).map((j) => j.on), [true, false], 'boxless writer unbound')
  // Seeders and sync never carry a boxless writer of a private group.
  await exchange(b, a, new Set([boxless]))
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupPost(a, { group, text: 'bem-vinda' })
  await exchange(a, b)
  t.alike(texts(await member.groupRead(b, { group })), ['bem-vinda'])
})

test('private: a multi-chunk rotation seals earlier epochs to the distributor only, the last to every entitled writer', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await exchange(c, a)
  const leavers = []
  for (let i = 0; i <= groupLib.MAX_KEY_BASIS; i++) {
    const x = await person(t, kp, 'Pessoa ' + i)
    await exchange(a, x)
    await member.groupJoin(x, { group })
    await exchange(x, a)
    leavers.push(x)
  }
  for (const x of [b, c, ...leavers]) await member.groupAdmit(a, { group, member: x.key, on: true })
  // One leave per writer core: more uncovered removals than one basis holds.
  for (const x of leavers) {
    await exchange(a, x)
    await member.groupLeave(x, { group })
    await exchange(x, a)
  }
  t.is((await member.groupRead(a, { group })).state, 'rekey-pending')
  const from = (await rootEntries(a, group)).length
  const { epoch } = await member.groupRekey(a, { group })
  t.is(epoch.writer, group, 'the creator rotates on the root')
  const firsts = (await rootEntries(a, group)).filter((e) => e.seq >= from && e.record.type === 'group-key' && e.record.kid === null)
  t.is(firsts.length, 2, 'two basis chunks, two epochs')
  t.alike(firsts[0].record.keys.map((k) => k.writer), [group], 'the earlier epoch only to the distributor')
  t.alike(firsts[1].record.keys.map((k) => k.writer).sort(), [group, ownWriter(b, group), ownWriter(c, group)].sort(), 'the last epoch to every entitled writer')
  t.is(firsts[1].seq, epoch.seq)
  await exchange(a, b)
  await member.groupPost(b, { group, text: 'sob a última chave' })
  await exchange(b, a)
  await exchange(a, c)
  t.ok(texts(await member.groupRead(a, { group })).includes('sob a última chave'), 'the creator reads')
  t.ok(texts(await member.groupRead(c, { group })).includes('sob a última chave'), 'another member reads')
  t.is((await member.groupRead(c, { group })).state, 'ok')
})

test('private: a community ref in an earlier own basis is listed again in the next rotation', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  await member.communityLink(a, { community, group, on: true })
  await member.communityAdmin(a, { community, member: b.key, on: true })
  await member.communityAdmin(a, { community, member: b.key, on: false })
  const lastBasis = async () => (await rootEntries(a, group)).filter((e) => e.seq >= 1 && e.record.type === 'group-key' && e.record.kid === null).pop().record.basis
  await member.groupRekey(a, { group })
  const first = (await lastBasis()).filter((r) => r.writer === community)
  t.is(first.length, 1, 'the community removal is in the basis')
  await member.groupRekey(a, { group })
  t.alike((await lastBasis()).filter((r) => r.writer === community), first, 'listed again, never subtracted')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('private: a history hand-off that does not fit the log appends nothing', async (t) => {
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await member.groupRekey(a, { group })
  await member.groupRekey(a, { group })
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await exchange(c, a)
  const before = (await rootEntries(a, group)).length
  // Room for the admit and one more block; three epochs to hand.
  t.alike(await member.groupAdmit({ ...a, limits: { maxLogBlocks: before + 2 } }, { group, member: c.key, on: true }), { ok: true })
  t.is((await rootEntries(a, group)).length, before + 1, 'only the admit was written')
  await member.groupRekey(a, { group })
  await exchange(a, c)
  t.is((await member.groupRead(c, { group })).state, 'ok', 'group.rekey with room hands it later')
})

test('private: every first key block commits to the key its members open', async (t) => {
  const { a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const { epoch } = await member.groupRekey(a, { group })
  await exchange(a, b)
  const entries = await rootEntries(a, group)
  const firsts = entries.filter((e) => e.seq >= 1 && e.record.type === 'group-key' && e.record.kid === null)
  t.ok(firsts.length >= 2, 'the create epoch and the rotation')
  for (const e of entries) {
    if (e.record.type === 'group-key' && e.record.kid !== null) t.absent('commit' in e.record, 'no commit on a continuation')
  }
  const kid = { writer: epoch.writer, seq: epoch.seq }
  const first = firsts.find((e) => e.seq === epoch.seq)
  const entry = first.record.keys.find((k) => k.writer === ownWriter(b, group))
  const key = groupCrypto.openEpochKey(b4a.from(entry.sealed, 'base64'), store.ensureBoxKeyPair(b.dataDir), group, kid)
  t.ok(key !== null, 'the member opens the key')
  t.is(first.record.commit, hex(groupCrypto.keyCommit(key, group, kid)), 'the commit matches that key')
  const created = firsts[0]
  const own = created.record.keys[0]
  const createdKid = { writer: group, seq: created.seq }
  const createdKey = groupCrypto.openEpochKey(b4a.from(own.sealed, 'base64'), store.ensureBoxKeyPair(a.dataDir), group, createdKid)
  t.is(created.record.commit, hex(groupCrypto.keyCommit(createdKey, group, createdKid)), 'the create epoch commits too')
  groupCrypto.wipe(key)
  groupCrypto.wipe(createdKey)
  await member.groupPost(b, { group, text: 'sob a chave comprometida' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group })).includes('sob a chave comprometida'), 'members still read and send')
})

test('private: relinking a community whose admin was demoted while unlinked leaves no rekey-pending', async (t) => {
  const { a, b, group } = await privateGroup(t)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const { community } = await member.communityCreate(a, { name: 'Bairro' })
  await member.communityLink(a, { community, group, on: true })
  await member.communityAdmin(a, { community, member: b.key, on: true })
  await member.communityLink(a, { community, group, on: false })
  await member.communityAdmin(a, { community, member: b.key, on: false })
  await member.communityLink(a, { community, group, on: true })
  t.is((await member.groupRead(a, { group })).state, 'ok', 'not rekey-pending after the relink')
  await exchange(a, b)
  await member.groupPost(b, { group, text: 'depois do religamento' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group })).includes('depois do religamento'), 'a member sends')
})
