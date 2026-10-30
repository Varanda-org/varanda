'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { groupJoinRecord } = require('../lib/records')
const groupLib = require('../lib/group')
const { readBoundRoots } = require('../lib/sync')
const store = require('../lib/store')
const member = require('../lib/member')
const { tmpDir } = require('./helpers/tmp')

const hex = (key) => b4a.toString(key, 'hex')
const AT = '2026-01-01T00:00:00.000Z'

async function person (t, kp, name = 'Ana', certified = true) {
  const ctx = { dataDir: tmpDir(t), association: hex(kp.publicKey) }
  const { publicKey } = await member.idCreate(ctx)
  if (certified) {
    await member.certAdd(ctx, createCert({ member: publicKey }, kp))
    await member.profileSet(ctx, { name })
  }
  return { ...ctx, key: publicKey }
}

// Corestore replication stays entirely in process, without sockets or a DHT.
async function exchange (from, to) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
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

async function pair (t, join = 'open') {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Horta', join })
  await exchange(a, b)
  const joined = await member.groupJoin(b, { group })
  await exchange(b, a)
  return { a, b, group, kp, joined }
}

async function writerEntries (ctx, group) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const local = store.readGroups(ctx.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    return { key: hex(writer.key), entries: await store.readAll(writer), length: writer.length }
  } finally {
    await s.close()
  }
}

async function offlineAppend (ctx, group, record) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const local = store.readGroups(ctx.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    const seq = await store.appendRecord(writer, record, {
      validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: local.writer === group })
    })
    return { writer: local.writer, seq }
  } finally {
    await s.close()
  }
}

async function rejects (t, promise, message, code = 'USAGE') {
  try {
    await promise
    t.fail('expected rejection')
  } catch (err) {
    t.is(err.message, message)
    t.is(err.code, code)
  }
}

test('create requires a diary genesis and persists a root writer and join', async (t) => {
  const kp = crypto.keyPair()
  const ctx = await person(t, kp, 'Ana', false)
  await t.exception(() => member.groupCreate(ctx, { name: 'Horta', join: 'open' }), /grave o certificado/)
  t.alike(store.readGroups(ctx.dataDir), [])
  await member.certAdd(ctx, createCert({ member: ctx.key }, kp))
  const { group } = await member.groupCreate(ctx, { name: 'Horta', join: 'open' })
  const data = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'groups.json'), 'utf8'))
  t.is(data.v, 1)
  t.is(data.groups.length, 1)
  t.alike(Object.keys(data.groups[0]), ['group', 'writer', 'nonce'])
  t.is(data.groups[0].writer, group)
  t.ok(/^[0-9a-f]{32}$/.test(data.groups[0].nonce))
  const root = await writerEntries(ctx, group)
  t.is(root.key, group)
  t.alike(root.entries[0].record, {
    type: 'group-header',
    v: 1,
    kind: 'group',
    diary: ctx.key,
    visibility: 'public',
    join: 'open',
    name: 'Horta',
    box: null,
    at: root.entries[0].record.at
  })
  const { entries } = await member.logRead(ctx)
  t.alike(entries[1].record, groupJoinRecord({ group, writer: group, on: true, at: entries[1].record.at }))
  t.alike(await member.groupInfo(ctx, { group }), {
    group, name: 'Horta', join: 'open', creator: ctx.key, role: 'creator', members: 1, state: 'member'
  })
  t.alike(await member.groupList(ctx), { groups: [{ group, name: 'Horta', join: 'open', role: 'creator', members: 1 }], total: 1 })
  await rejects(t, member.groupInfo(ctx, { group: 'f'.repeat(64) }), 'grupo não encontrado', 'NOT_FOUND')
})

test('join is idempotent and reads two writers backwards in causal order', async (t) => {
  const { a, b, group, joined } = await pair(t)
  t.alike(joined, { state: 'member' })
  const before = await writerEntries(b, group)
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  t.alike(await writerEntries(b, group), before)
  t.is(before.entries[0].record.diary, b.key)
  t.is(before.entries[0].record.group, group)
  t.is(before.entries[0].record.rejoin, null)
  const first = await member.groupPost(a, { group, text: 'primeira' })
  await exchange(a, b)
  const second = await member.groupPost(b, { group, text: 'segunda', replyTo: { writer: group, seq: first.seq } })
  const bw = await writerEntries(b, group)
  t.alike(bw.entries[second.seq].record.seen, { writer: group, seq: first.seq })
  await exchange(b, a)
  const third = await member.groupPost(a, { group, text: 'terceira' })
  const page = await member.groupRead(a, { group, limit: 2 })
  t.alike(page.items.map((p) => p.text), ['terceira', 'segunda'])
  t.alike(page.items.map((p) => p.name), ['Ana', 'Bia'])
  t.alike(page.items.map((p) => p.username), [null, null])
  t.is(page.items[0].seq, third.seq)
  t.alike(page.next, { at: page.items[1].at, writer: bw.key, seq: second.seq })
  const older = await member.groupRead(a, { group, before: page.next, limit: 2 })
  t.alike(older.items.map((p) => p.text), ['primeira'])
  t.is(older.next, null)
  t.absent(page.incomplete)
  const members = await member.groupMembers(a, { group, limit: 1 })
  t.is(members.total, 2)
  t.is(members.members.length, 1)
  t.ok(members.members[0].joinedAt)
  const bia = (await member.groupMembers(a, { group })).members.find((m) => m.member === b.key)
  t.is(bia.joinedAt, before.entries[0].record.at)
  t.alike((await member.groupMembers(a, { group, offset: 1 })).members.map((m) => m.member), [a.key, b.key].sort().slice(1))
})

test('approval requests, admission cuts, leaving and rejoining', async (t) => {
  const { a, b, group, joined } = await pair(t, 'approval')
  t.alike(joined, { state: 'requested' })
  await rejects(t, member.groupPost(b, { group, text: 'cedo' }), 'sem permissão no grupo')
  await rejects(t, member.groupRequests(b, { group }), 'sem permissão no grupo')
  const requests = await member.groupRequests(a, { group })
  t.is(requests.total, 1)
  t.is(requests.requests[0].member, b.key)
  t.is(requests.requests[0].name, 'Bia')
  t.ok(requests.requests[0].at)
  t.is(requests.requests[0].at, (await writerEntries(b, group)).entries[0].record.at)
  const early = await offlineAppend(b, group, groupLib.groupPost({ text: 'antes', at: AT }))
  await exchange(b, a)
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[1].record.cuts, [{ writer: early.writer, seq: 2 }])
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  await member.groupPost(b, { group, text: 'depois' })
  const read = await member.groupRead(b, { group })
  t.alike(read.items.map((p) => [p.text, p.hidden]), [['depois', false], ['', true]])
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const once = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' }, 'a second leave writes nothing')
  t.alike(await writerEntries(b, group), once)
  t.is((await member.groupInfo(b, { group })).role, 'left')
  const left = await writerEntries(b, group)
  t.is(left.entries[left.length - 1].record.type, 'group-leave')
  t.alike(await member.groupJoin(b, { group }), { state: 'requested' })
  const again = await writerEntries(b, group)
  t.not(again.key, left.key)
  t.alike(again.entries[0].record.rejoin, { writer: left.key, seq: left.length - 1 })
  await exchange(b, a)
  const reqAgain = await member.groupRequests(a, { group })
  t.is(reqAgain.total, 1)
  t.is(reqAgain.requests[0].at, again.entries[0].record.at)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const bia = (await member.groupMembers(a, { group })).members.find((m) => m.member === b.key)
  t.is(bia.joinedAt, left.entries[0].record.at)
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  t.is(store.readGroups(b.dataDir).length, 1)
})

test('ban cuts preserve history, hide offline posts, and unban names the observed ban', async (t) => {
  const { a, b, group } = await pair(t)
  const old = await member.groupPost(b, { group, text: 'histórico' })
  await exchange(b, a)
  await rejects(t, member.groupBan(b, { group, member: a.key, on: true }), 'sem permissão no grupo')
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  const root = await writerEntries(a, group)
  const ban = root.entries[root.length - 1]
  const writer = (await writerEntries(b, group)).key
  t.alike(ban.record.cuts, [{ writer, seq: old.seq + 1 }])
  await member.groupPost(b, { group, text: 'sem ver o ban' })
  await exchange(b, a)
  const banned = await member.groupRead(a, { group })
  t.alike(banned.items.map((p) => [p.text, p.hidden]), [['', true], ['histórico', false]])
  t.is(banned.hidden, 1)
  await exchange(a, b)
  await rejects(t, member.groupPost(b, { group, text: 'bloqueada' }), 'sem permissão no grupo')
  await rejects(t, member.groupJoin(b, { group }), 'sem permissão no grupo')
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const unbanRoot = await writerEntries(a, group)
  t.alike(unbanRoot.entries[unbanRoot.length - 1].record.lifts, { writer: group, seq: ban.seq })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).role, 'member')
  await member.groupPost(b, { group, text: 'de volta' })
  t.alike((await member.groupRead(b, { group })).items.map((p) => [p.text, p.hidden]), [['de volta', false], ['', true], ['histórico', false]])
  await rejects(t, member.groupBan(a, { group, member: a.key, on: false }), 'sem permissão no grupo')
  await rejects(t, member.groupBan(a, { group, member: 'f'.repeat(64), on: false }), 'nada a alterar')
})

test('author and admin hides are independent and charter writes require the root', async (t) => {
  const { a, b, group } = await pair(t)
  const { seq } = await member.groupPost(b, { group, text: 'hortelã' })
  const target = { writer: (await writerEntries(b, group)).key, seq }
  await member.groupHide(b, { group, target, on: true })
  t.is((await member.groupRead(b, { group })).items[0].text, '')
  await exchange(b, a)
  await member.groupHide(a, { group, target, on: true })
  await exchange(a, b)
  await member.groupHide(b, { group, target, on: false })
  t.ok((await member.groupRead(b, { group })).items[0].hidden)
  await exchange(b, a)
  await member.groupHide(a, { group, target, on: false })
  t.is((await member.groupRead(a, { group })).items[0].text, 'hortelã')
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).role, 'admin')
  await rejects(t, member.groupMeta(b, { group, name: 'Outra' }), 'sem permissão no grupo')
  await rejects(t, member.groupAdmin(b, { group, member: 'f'.repeat(64), on: true }), 'sem permissão no grupo')
  await rejects(t, member.groupBan(a, { group, member: b.key, on: true }), 'sem permissão no grupo')
  await member.groupMeta(a, { group, name: 'Jardim' })
  t.is((await member.groupInfo(a, { group })).name, 'Jardim')
  await rejects(t, member.groupMeta(a, { group }), 'nada a alterar')
  await member.groupPost(a, { group, text: 'após a mudança' })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.seen, { writer: group, seq: root.length - 2 }, 'seen includes non-post records')
})

test('a blocked creator is no member or admin: charter writes refuse and members leave it out', async (t) => {
  const { a, b, group, kp } = await pair(t)
  t.is((await member.groupMembers(a, { group })).total, 2)
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [a.key] }, mod, cert))
  const root = await writerEntries(a, group)
  await rejects(t, member.groupMeta(a, { group, name: 'Outra' }), 'sem permissão no grupo')
  await rejects(t, member.groupAdmin(a, { group, member: b.key, on: true }), 'sem permissão no grupo')
  t.alike(await writerEntries(a, group), root, 'nothing appended to the root')
  const members = await member.groupMembers(a, { group })
  t.alike(members.members.map((m) => m.member), [b.key])
  t.is(members.total, 1)
})

test('blocked diaries remove all their writers, including the own diary', async (t) => {
  const { a, b, group, kp } = await pair(t)
  await member.groupPost(a, { group, text: 'Ana' })
  await member.groupPost(b, { group, text: 'Bia antiga' })
  await member.groupLeave(b, { group })
  await member.groupJoin(b, { group })
  await member.groupPost(b, { group, text: 'Bia nova' })
  await exchange(b, a)
  t.is((await member.groupRead(a, { group })).items.length, 3)
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  const snapshot = createSnapshot({ seq: 1, blocked: [b.key] }, mod, cert)
  store.writeBlocklist(a.dataDir, snapshot)
  store.writeBlocklist(b.dataDir, snapshot)
  t.alike((await member.groupRead(a, { group })).items.map((p) => p.text), ['Ana'])
  t.absent((await member.groupMembers(a, { group })).members.some((m) => m.member === b.key))
  t.alike((await member.groupRead(b, { group })).items, [], 'blocked own writers are also excluded')
  const length = (await member.logRead(b)).entries.length
  await rejects(t, member.groupPost(b, { group, text: 'bloqueada' }), 'sem permissão no grupo')
  await rejects(t, member.groupJoin(b, { group }), 'sem permissão no grupo')
  t.is((await member.logRead(b)).entries.length, length, 'no diary join from a blocked own diary')
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 2, blocked: [group] }, mod, cert))
  await rejects(t, member.groupRead(a, { group }), 'grupo não encontrado', 'NOT_FOUND')
})

test('creator rejoin keeps charter writes on the original root', async (t) => {
  const ctx = await person(t, crypto.keyPair())
  const { group } = await member.groupCreate(ctx, { name: 'Horta', join: 'open' })
  await member.groupLeave(ctx, { group })
  t.alike(await member.groupJoin(ctx, { group }), { state: 'member' })
  t.not(store.readGroups(ctx.dataDir)[0].writer, group)
  t.alike(await member.groupMeta(ctx, { group, name: 'Jardim' }), { ok: true })
  t.is((await member.groupInfo(ctx, { group })).name, 'Jardim')
  const s = await store.openStore(ctx.dataDir)
  try {
    const root = s.get({ key: b4a.from(group, 'hex') })
    await root.ready()
    const entries = await store.readAll(root)
    t.is(entries[entries.length - 1].record.type, 'group-meta')
  } finally {
    await s.close()
  }
})

test('64 live groups limit creation and joining, and leaving a created group keeps the slot', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp)
  const { group } = await member.groupCreate(a, { name: 'Novo', join: 'open' })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  try {
    const diary = await store.openDiary(s)
    const locals = []
    for (let i = 0; i < 64; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      const key = hex(writer.key)
      await store.appendRecord(writer, groupLib.groupHeader({ diary: b.key, name: 'Grupo ' + i }), {
        validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true })
      })
      await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
      locals.push({ group: key, writer: key, nonce })
    }
    store.writeGroups(b.dataDir, locals)
  } finally {
    await s.close()
  }
  await rejects(t, member.groupCreate(b, { name: 'Demais', join: 'open' }), 'limite de grupos atingido')
  await rejects(t, member.groupJoin(b, { group }), 'limite de grupos atingido')
  const existing = store.readGroups(b.dataDir)[0].group
  t.alike(await member.groupJoin(b, { group: existing }), { state: 'member' }, 'idempotence still works at the limit')
  await member.groupLeave(b, { group: existing })
  await rejects(t, member.groupJoin(b, { group }), 'limite de grupos atingido')
  t.ok(store.readGroups(b.dataDir).some((g) => g.group === existing))
  t.is((await member.groupList(b, { offset: 63, limit: 1 })).groups.length, 1)
})

test('causal pagination and seen ignore clock skew across writers', async (t) => {
  const { a, b, group } = await pair(t)
  const first = await offlineAppend(a, group, groupLib.groupPost({ text: 'primeira', at: '2026-01-02T00:00:00.000Z' }))
  await exchange(a, b)
  const second = await offlineAppend(b, group, groupLib.groupPost({ text: 'segunda', seen: first, at: AT }))
  await exchange(b, a)
  await member.groupHide(a, { group, target: second, on: false })
  await exchange(a, b)
  const root = await writerEntries(a, group)
  await member.groupPost(b, { group, text: 'terceira' })
  const writer = await writerEntries(b, group)
  t.alike(writer.entries[writer.length - 1].record.seen, { writer: group, seq: root.length - 1 })
  const newest = await member.groupRead(b, { group, limit: 1 })
  t.is(newest.items[0].text, 'terceira')
  const middle = await member.groupRead(b, { group, limit: 1, before: newest.next })
  t.is(middle.items[0].text, 'segunda')
  const oldest = await member.groupRead(b, { group, limit: 1, before: middle.next })
  t.is(oldest.items[0].text, 'primeira')
  t.is(oldest.next, null)
})

test('observed cuts and rejoin ignore writers rejected by the fold', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(a, { group, text: 'not a leave' })
  await exchange(a, b)
  const before = await writerEntries(b, group)
  await member.groupLeave(b, { group })
  const left = await writerEntries(b, group)
  const s = await store.openStore(b.dataDir)
  let rejected
  try {
    const writer = await store.openGroupWriter(s, 'ef'.repeat(16))
    rejected = hex(writer.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(writer, groupLib.writerHeader({ group, diary: b.key, rejoin: { writer: group, seq: 1 } }), { validator })
    await store.appendRecord(writer, groupLib.groupLeave({ at: new Date(Date.now() + 60000).toISOString() }), { validator })
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: rejected, on: true }))
  } finally {
    await s.close()
  }
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  const rejoined = await writerEntries(b, group)
  t.alike(rejoined.entries[0].record.rejoin, { writer: before.key, seq: left.length - 1 })
  await exchange(b, a)
  await member.groupBan(a, { group, member: b.key, on: true })
  const root = await writerEntries(a, group)
  const cuts = root.entries[root.length - 1].record.cuts
  t.alike(cuts.map((c) => c.writer), [before.key, rejoined.key].sort())
  t.absent(cuts.some((c) => c.writer === rejected))
})

test('unban ignores a later ban written beyond a demoted admin cut', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const c = await person(t, kp, 'Caio')
  await exchange(a, c)
  await member.groupJoin(c, { group })
  await exchange(c, a)
  await member.groupAdmin(a, { group, member: c.key, on: true })
  await exchange(a, c)
  await member.groupBan(c, { group, member: b.key, on: true })
  const valid = await writerEntries(c, group)
  await exchange(c, a)
  await member.groupAdmin(a, { group, member: c.key, on: false })
  await member.groupBan(c, { group, member: b.key, on: true })
  await exchange(c, a)
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.lifts, { writer: valid.key, seq: valid.length - 1 })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
})

test('a diary that fails feed admission contributes no group posts', async (t) => {
  const a = await person(t, crypto.keyPair())
  const b = await person(t, crypto.keyPair(), 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open' })
  await exchange(a, b)
  await member.groupJoin(b, { group })
  await member.groupPost(b, { group, text: 'outra associação' })
  await exchange(b, a)
  t.alike((await member.groupRead(a, { group })).items, [])
  t.alike((await member.groupMembers(a, { group })).members.map((m) => m.member), [a.key])
})

test('local join evidence flags a missing writer without blocking known posts', async (t) => {
  const { a, group, kp } = await pair(t)
  const c = await person(t, kp, 'Caio')
  await member.groupPost(a, { group, text: 'disponível' })
  const s = await store.openStore(c.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: 'f'.repeat(64), on: true }))
  } finally {
    await s.close()
  }
  await exchange(c, a)
  const result = await member.groupRead(a, { group })
  t.ok(result.incomplete)
  t.alike(result.items.map((p) => p.text), ['disponível'])
})

test('a post names the fold last node, including a rejoin at seq 0', async (t) => {
  const { b, group } = await pair(t)
  await member.groupLeave(b, { group })
  const left = await writerEntries(b, group)
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  const again = await writerEntries(b, group)
  t.alike(again.entries[0].record.rejoin, { writer: left.key, seq: left.length - 1 })
  const posted = await member.groupPost(b, { group, text: 'voltei' })
  const after = await writerEntries(b, group)
  t.alike(after.entries[posted.seq].record.seen, { writer: again.key, seq: 0 })
})

test('an unban lifts the ban of a diary that has no local writer', async (t) => {
  const { a, group } = await pair(t)
  const stranger = 'ab'.repeat(32)
  t.alike(await member.groupBan(a, { group, member: stranger, on: true }), { ok: true })
  const banned = await writerEntries(a, group)
  const ban = banned.entries[banned.length - 1]
  t.is(ban.record.type, 'group-ban')
  t.absent((await member.groupMembers(a, { group })).members.some((m) => m.member === stranger))
  t.alike(await member.groupBan(a, { group, member: stranger, on: false }), { ok: true })
  const unban = (await writerEntries(a, group)).entries[banned.length]
  t.alike(unban.record.lifts, { writer: group, seq: ban.seq })
})

test('hiding an own post works after leaving and a non-object target is usage', async (t) => {
  const { a, b, group } = await pair(t)
  const { seq } = await member.groupPost(b, { group, text: 'meu' })
  const target = { writer: (await writerEntries(b, group)).key, seq }
  t.alike(await member.groupHide(b, { group, target, on: true }), { ok: true })
  await exchange(b, a)
  const other = await member.groupPost(a, { group, text: 'de Ana' })
  await exchange(a, b)
  await member.groupLeave(b, { group })
  t.alike(await member.groupHide(b, { group, target, on: false }), { ok: true })
  const left = await writerEntries(b, group)
  t.is(left.entries[left.length - 1].record.type, 'group-hide', 'written to the own bound writer that left')
  await rejects(t, member.groupHide(b, { group, target: { writer: group, seq: other.seq }, on: true }), 'sem permissão no grupo')
  await exchange(b, a)
  const read = await member.groupRead(a, { group })
  t.alike(read.items.map((p) => [p.text, p.hidden]), [['de Ana', false], ['meu', false]])
  await rejects(t, member.groupHide(a, { group, target: null, on: true }), 'sem permissão no grupo')
  await rejects(t, member.groupHide(a, { group, target: 'post', on: true }), 'sem permissão no grupo')
})

test('a cursor for a missing post keeps paging by causal order', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const older = await offlineAppend(a, group, groupLib.groupPost({ text: 'antiga', at: '2026-01-01T00:00:00.000Z' }))
  await exchange(a, b)
  await offlineAppend(b, group, groupLib.groupPost({ text: 'nova', seen: older, at: '2026-01-02T00:00:00.000Z' }))
  await exchange(b, a)
  const page = await member.groupRead(a, { group, limit: 1 })
  t.is(page.items[0].text, 'nova')
  const shifted = { at: '2026-01-03T00:00:00.000Z', writer: page.next.writer, seq: page.next.seq }
  const anchored = await member.groupRead(a, { group, limit: 1, before: shifted })
  t.is(anchored.items[0].text, 'antiga')
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [b.key] }, mod, cert))
  const continued = await member.groupRead(a, { group, limit: 1, before: page.next })
  t.is(continued.items[0].text, 'antiga')
  t.is(continued.next, null)
})

test('a diary failure after the root append keeps the root nonce recorded', async (t) => {
  const ctx = await person(t, crypto.keyPair())
  const realAppend = store.appendRecord
  store.appendRecord = async function (core, record, limits) {
    if (record && record.type === 'group-join') {
      store.appendRecord = realAppend
      throw new Error('falha de teste')
    }
    return realAppend(core, record, limits)
  }
  const memberPath = require.resolve('../lib/member')
  delete require.cache[memberPath]
  try {
    const fresh = require('../lib/member')
    await t.exception(() => fresh.groupCreate(ctx, { name: 'Horta', join: 'open' }), /falha de teste/)
  } finally {
    store.appendRecord = realAppend
    delete require.cache[memberPath]
  }
  const data = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'groups.json'), 'utf8'))
  t.is(data.groups.length, 1)
  t.is(data.groups[0].writer, data.groups[0].group)
  t.ok(/^[0-9a-f]{32}$/.test(data.groups[0].nonce))
  const s = await store.openStore(ctx.dataDir)
  try {
    const writer = await store.openGroupWriter(s, data.groups[0].nonce)
    t.is(hex(writer.key), data.groups[0].group)
    t.ok(writer.writable)
    const seq = await store.appendRecord(writer, groupLib.groupPost({ text: 'ainda escreve' }), {
      validator: (r, n) => groupLib.validateGroupRecord(r, n, { root: true })
    })
    t.is(seq, 1)
  } finally {
    await s.close()
  }
  const { entries } = await member.logRead(ctx)
  t.is(entries.filter((e) => e.record && e.record.type === 'group-join').length, 0)
})

test('a leave from another device ends this device writer', async (t) => {
  const { b, group } = await pair(t)
  const posted = await member.groupPost(b, { group, text: 'oi' })
  const first = (await writerEntries(b, group)).key
  const target = { writer: first, seq: posted.seq }
  const s = await store.openStore(b.dataDir)
  let otherKey
  try {
    const writer = await store.openGroupWriter(s, 'cd'.repeat(16))
    otherKey = hex(writer.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(writer, groupLib.writerHeader({ group, diary: b.key }), { validator })
    await store.appendRecord(writer, groupLib.groupLeave(), { validator })
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: otherKey, on: true }))
  } finally {
    await s.close()
  }
  t.is((await member.groupInfo(b, { group })).state, 'left')
  await rejects(t, member.groupPost(b, { group, text: 'ainda' }), 'sem permissão no grupo')
  t.alike(await member.groupHide(b, { group, target, on: true }), { ok: true }, 'an author hide needs only a bound writer')
  const kept = { writer: await writerEntries(b, group), log: (await member.logRead(b)).entries.length }
  t.alike(await member.groupLeave(b, { group }), { state: 'left' }, 'left through another device: nothing written')
  t.alike({ writer: await writerEntries(b, group), log: (await member.logRead(b)).entries.length }, kept)
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  const again = await writerEntries(b, group)
  t.not(again.key, first)
  t.alike(again.entries[0].record.rejoin, { writer: otherKey, seq: 1 })
  t.is((await member.groupPost(b, { group, text: 'voltei' })).seq, 1)
})

test('a joined group left through another device gives way and leaving it again writes nothing', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group: joined } = await member.groupCreate(b, { name: 'de Bia', join: 'open' })
  await exchange(b, a)
  await member.groupJoin(a, { group: joined })
  const s = await store.openStore(a.dataDir)
  try {
    const diary = await store.openDiary(s)
    const locals = store.readGroups(a.dataDir)
    for (let i = 1; i < 64; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      const key = hex(writer.key)
      await store.appendRecord(writer, groupLib.groupHeader({ diary: a.key, name: 'Grupo ' + i }), {
        validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true })
      })
      await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
      locals.push({ group: key, writer: key, nonce })
    }
    store.writeGroups(a.dataDir, locals)
    // Another device of Ana leaves the joined group.
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const other = await store.openGroupWriter(s, 'cd'.repeat(16))
    await store.appendRecord(other, groupLib.writerHeader({ group: joined, diary: a.key }), { validator })
    await store.appendRecord(other, groupLib.groupLeave(), { validator })
    await store.appendRecord(diary, groupJoinRecord({ group: joined, writer: hex(other.key), on: true }))
  } finally {
    await s.close()
  }
  t.is((await member.groupInfo(a, { group: joined })).state, 'left')
  const kept = { writer: await writerEntries(a, joined), log: (await member.logRead(a)).entries.length }
  t.alike(await member.groupLeave(a, { group: joined }), { state: 'left' })
  t.alike({ writer: await writerEntries(a, joined), log: (await member.logRead(a)).entries.length }, kept, 'nothing written')
  const { group } = await member.groupCreate(a, { name: 'cabe', join: 'open' })
  const groups = store.readGroups(a.dataDir)
  t.is(groups.length, 64)
  t.absent(groups.some((g) => g.group === joined), 'the group left elsewhere gave way')
  t.ok(groups.some((g) => g.group === group))
})

test('moderation orders after another device rejoin whose clock is ahead', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  try {
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const diary = await store.openDiary(s)
    const o1 = await store.openGroupWriter(s, 'c1'.repeat(16))
    await store.appendRecord(o1, groupLib.writerHeader({ group, diary: b.key }), { validator })
    await store.appendRecord(o1, groupLib.groupLeave(), { validator })
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(o1.key), on: true }))
    const ahead = new Date(Date.now() + 3600000).toISOString()
    const o2 = await store.openGroupWriter(s, 'c2'.repeat(16))
    await store.appendRecord(o2, groupLib.writerHeader({ group, diary: b.key, rejoin: { writer: hex(o1.key), seq: 1 }, at: ahead }), { validator })
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(o2.key), on: true }))
  } finally {
    await s.close()
  }
  t.is((await member.groupInfo(b, { group })).role, 'admin', 'the other device rejoined')
  const stranger = 'ab'.repeat(32)
  t.alike(await member.groupBan(b, { group, member: stranger, on: true }), { ok: true })
  t.alike(await member.groupBan(b, { group, member: stranger, on: false }), { ok: true }, 'the ban took effect')
  const { entries } = await writerEntries(b, group)
  t.ok(entries[1].record.seen !== null, 'the ban names the fold last node')
})

test('a left joined group gives way and a created group never does', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group: joined } = await member.groupCreate(b, { name: 'de Bia', join: 'open' })
  await exchange(b, a)
  await member.groupJoin(a, { group: joined })
  const joinedEntry = store.readGroups(a.dataDir).find((g) => g.group === joined)
  const s = await store.openStore(a.dataDir)
  const created = []
  try {
    const diary = await store.openDiary(s)
    const locals = store.readGroups(a.dataDir)
    for (let i = 1; i < 64; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      const key = hex(writer.key)
      await store.appendRecord(writer, groupLib.groupHeader({ diary: a.key, name: 'Grupo ' + i }), {
        validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true })
      })
      await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
      locals.push({ group: key, writer: key, nonce })
      created.push(key)
    }
    store.writeGroups(a.dataDir, locals)
  } finally {
    await s.close()
  }
  await rejects(t, member.groupCreate(a, { name: 'demais', join: 'open' }), 'limite de grupos atingido')
  await member.groupLeave(a, { group: created[0] })
  await rejects(t, member.groupCreate(a, { name: 'ainda não', join: 'open' }), 'limite de grupos atingido')
  t.ok(store.readGroups(a.dataDir).some((g) => g.group === created[0]))
  await member.groupLeave(a, { group: joined })
  const { group } = await member.groupCreate(a, { name: 'cabe', join: 'open' })
  const groups = store.readGroups(a.dataDir)
  t.is(groups.length, 64)
  t.absent(groups.some((g) => g.group === joined))
  t.ok(groups.some((g) => g.group === created[0]))
  t.ok(groups.some((g) => g.group === group))
  const kept = await store.openStore(a.dataDir)
  try {
    const core = await store.openGroupWriter(kept, joinedEntry.nonce)
    t.is(hex(core.key), joinedEntry.writer)
    const entries = await store.readAll(core)
    t.is(entries[entries.length - 1].record.type, 'group-leave')
  } finally {
    await kept.close()
  }
})

test('a leave names the fold last node as seen', async (t) => {
  const { a, b, group } = await pair(t)
  const first = await member.groupPost(a, { group, text: 'oi' })
  await exchange(a, b)
  await member.groupLeave(b, { group })
  const left = await writerEntries(b, group)
  const leave = left.entries[left.length - 1].record
  t.is(leave.type, 'group-leave')
  t.alike(leave.seen, { writer: group, seq: first.seq })
})

test('a missing cursor pages by order key over the causal order, never by a count', async (t) => {
  const ctx = await person(t, crypto.keyPair())
  const { group } = await member.groupCreate(ctx, { name: 'Horta', join: 'open' })
  // Same writer, so seq order: causal [cem, dez] while the clocks say dez < cem.
  await offlineAppend(ctx, group, groupLib.groupPost({ text: 'cem', at: '2026-01-03T00:00:00.000Z' }))
  await offlineAppend(ctx, group, groupLib.groupPost({ text: 'dez', at: '2026-01-01T00:00:00.000Z' }))
  const before = { at: '2026-01-02T00:00:00.000Z', writer: 'ab'.repeat(32), seq: 1 }
  const page = await member.groupRead(ctx, { group, before })
  t.alike(page.items.map((p) => p.text), ['dez'], 'only the post older than the cursor')
  t.is(page.next, null)
})

test('a diary banned before it had a writer cannot join and gets no writer', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open' })
  await member.groupBan(a, { group, member: b.key, on: true })
  await exchange(a, b)
  await rejects(t, member.groupJoin(b, { group }), 'sem permissão no grupo')
  t.alike(store.readGroups(b.dataDir), [])
  const { entries } = await member.logRead(b)
  t.absent(entries.some((e) => e.record && e.record.type === 'group-join'))
})

test('a banned diary cannot leave', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupBan(a, { group, member: b.key, on: true })
  await exchange(a, b)
  const before = await writerEntries(b, group)
  await rejects(t, member.groupLeave(b, { group }), 'sem permissão no grupo')
  t.alike(await writerEntries(b, group), before)
})

test('enforcing a group block makes the group unknown and keeps its cores', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const { group: other } = await member.groupCreate(a, { name: 'Outro', join: 'open' })
  const target = { writer: group, seq: (await member.groupPost(a, { group, text: 'oi' })).seq }
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [group] }, mod, cert))
  const ops = [
    () => member.groupRead(a, { group }),
    () => member.groupRead(a, { group: group.toUpperCase() }),
    () => member.groupInfo(a, { group }),
    () => member.groupMembers(a, { group }),
    () => member.groupRequests(a, { group }),
    () => member.groupJoin(a, { group }),
    () => member.groupLeave(a, { group }),
    () => member.groupPost(a, { group, text: 'não' }),
    () => member.groupHide(a, { group, target, on: true }),
    () => member.groupAdmit(a, { group, member: b.key, on: true }),
    () => member.groupBan(a, { group, member: b.key, on: true }),
    () => member.groupAdmin(a, { group, member: b.key, on: true }),
    () => member.groupMeta(a, { group, name: 'Outra' })
  ]
  for (const run of ops) await rejects(t, run(), 'grupo não encontrado', 'NOT_FOUND')
  const list = await member.groupList(a)
  t.alike(list.groups.map((g) => g.group), [other])
  t.is(list.total, 1)
  t.ok(store.readGroups(a.dataDir).some((g) => g.group === group), 'the local entry is kept')
  const s = await store.openStore(a.dataDir)
  try {
    t.ok(await store.replicaStored(s, group), 'the root core is kept')
  } finally {
    await s.close()
  }
})

test('join evidence comes from every followed diary held locally', async (t) => {
  const { a, group, kp } = await pair(t)
  const c = await person(t, kp, 'Caio')
  await member.groupPost(a, { group, text: 'disponível' })
  const s = await store.openStore(c.dataDir)
  try {
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: 'e'.repeat(64), on: true }))
  } finally {
    await s.close()
  }
  store.writeFollows(a.dataDir, [c.key])
  await exchange(c, a)
  const result = await member.groupRead(a, { group })
  t.ok(result.incomplete, 'a known join whose writer core has not arrived')
  t.alike(result.items.map((p) => p.text), ['disponível'])
})

test('an own writer beyond the writer cap refuses to post, hide, moderate or leave', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Cheia', join: 'open' })
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  // Other devices of Bia hold the lowest keys, so the cap counts them and
  // leaves out the writer this device lists.
  const s = await store.openStore(b.dataDir)
  let local
  let target
  try {
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const cores = []
    for (let i = 0; i < groupLib.MAX_GROUP_WRITERS; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      await store.appendRecord(writer, groupLib.writerHeader({ group, diary: b.key }), { validator })
      cores.push({ key: hex(writer.key), nonce, writer })
    }
    cores.sort((x, y) => x.key.localeCompare(y.key))
    target = { writer: cores[0].key, seq: await store.appendRecord(cores[0].writer, groupLib.groupPost({ text: 'meu' }), { validator }) }
    const diary = await store.openDiary(s)
    for (const c of cores) await store.appendRecord(diary, groupJoinRecord({ group, writer: c.key, on: true }))
    local = cores[cores.length - 1]
    store.writeGroups(b.dataDir, [{ group, writer: local.key, nonce: local.nonce }])
  } finally {
    await s.close()
  }
  const info = await member.groupInfo(b, { group })
  t.is(info.state, 'member', 'the counted writers keep the diary a member')
  t.is(info.role, 'admin')
  const before = await writerEntries(b, group)
  t.is(before.key, local.key)
  await rejects(t, member.groupPost(b, { group, text: 'perdida' }), 'limite do grupo atingido')
  await rejects(t, member.groupHide(b, { group, target, on: true }), 'limite do grupo atingido')
  await rejects(t, member.groupBan(b, { group, member: 'ab'.repeat(32), on: true }), 'limite do grupo atingido')
  await rejects(t, member.groupLeave(b, { group }), 'limite do grupo atingido')
  t.alike(await writerEntries(b, group), before, 'nothing written to the uncounted writer')
  t.is((await member.groupInfo(b, { group })).state, 'member')
  const joins = (await member.logRead(b)).entries.length
  await rejects(t, member.groupJoin(b, { group }), 'limite do grupo atingido')
  t.alike(await writerEntries(b, group), before, 'a join never reports an uncounted writer as a member')
  t.is((await member.logRead(b)).entries.length, joins)
})

test('a join refuses before creating a writer when the fold already counts the writer cap', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Cheia', join: 'open' })
  await exchange(a, b)
  // Other devices of Bia fill every counted slot; this device has none.
  const s = await store.openStore(b.dataDir)
  try {
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    const diary = await store.openDiary(s)
    for (let i = 0; i < groupLib.MAX_GROUP_WRITERS - 1; i++) {
      const writer = await store.openGroupWriter(s, i.toString(16).padStart(32, '0'))
      await store.appendRecord(writer, groupLib.writerHeader({ group, diary: b.key }), { validator })
      await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(writer.key), on: true }))
    }
  } finally {
    await s.close()
  }
  const length = (await member.logRead(b)).entries.length
  await rejects(t, member.groupJoin(b, { group }), 'limite do grupo atingido')
  t.alike(store.readGroups(b.dataDir), [], 'no local entry')
  t.is((await member.logRead(b)).entries.length, length, 'no diary join')
})

async function groupJoins (ctx, group) {
  const { entries } = await member.logRead(ctx)
  return entries.filter((e) => e.record && e.record.type === 'group-join' && e.record.group === group).map((e) => e.record)
}

async function heldWriters (ctx, group) {
  const s = await store.openStore(ctx.dataDir)
  let n = 0
  try {
    for await (const dk of s.list()) {
      const core = s.get({ discoveryKey: dk, writable: false, active: false })
      try {
        await core.ready()
        if (core.contiguousLength === 0) continue
        const h = (await store.readAll(core))[0].record
        if (h && h.type === 'group-writer' && h.group === group) n++
      } finally {
        await core.close()
      }
    }
  } finally {
    await s.close()
  }
  return n
}

async function pendingPair (t, join = 'open', { ban = false } = {}) {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Horta', join })
  if (ban) await member.groupBan(a, { group, member: b.key, on: true })
  return { a, b, group }
}

test('a join by key before the root arrives is pending until a sync brings it', async (t) => {
  const { a, b, group } = await pendingPair(t)
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  t.is(store.readGroups(b.dataDir).length, 1)
  t.is(await heldWriters(b, group), 1)
  const joins = await groupJoins(b, group)
  t.is(joins.length, 1)
  t.is(joins[0].on, true)
  t.is(joins[0].writer, store.readGroups(b.dataDir)[0].writer)
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' }, 'a second join stays pending')
  t.is(await heldWriters(b, group), 1, 'no second writer')
  t.is((await groupJoins(b, group)).length, 1, 'no second diary join')
  t.alike(await member.groupList(b), { groups: [{ group, name: null, join: null, role: 'pending', members: 0 }], total: 1 })
  t.alike(await member.groupInfo(b, { group }), { group, name: null, join: null, creator: null, role: 'pending', members: 0, state: 'pending' })
  t.alike(await member.groupRead(b, { group }), { items: [], next: null, hidden: 0, incomplete: true })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  t.is(await heldWriters(b, group), 1)
  t.ok((await member.groupPost(b, { group, text: 'oi' })).seq >= 1)
})

test('a pending join of an approval group becomes a request', async (t) => {
  const { a, b, group } = await pendingPair(t, 'approval')
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'requested')
  t.is((await member.groupList(b)).groups[0].role, 'requested')
})

test('a ban written before a pending join shows once the root arrives', async (t) => {
  const { a, b, group } = await pendingPair(t, 'open', { ban: true })
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'banned')
})

test('a pending group can be left and refuses every other write', async (t) => {
  const { a, b, group } = await pendingPair(t)
  const unknown = 'f'.repeat(64)
  await rejects(t, member.groupLeave(b, { group }), 'grupo não encontrado', 'NOT_FOUND')
  await rejects(t, member.groupInfo(b, { group: unknown }), 'grupo não encontrado', 'NOT_FOUND')
  await rejects(t, member.groupRead(b, { group: unknown }), 'grupo não encontrado', 'NOT_FOUND')
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  const ops = [
    () => member.groupMembers(b, { group }),
    () => member.groupRequests(b, { group }),
    () => member.groupPost(b, { group, text: 'não' }),
    () => member.groupHide(b, { group, target: { writer: group, seq: 1 }, on: true }),
    () => member.groupAdmit(b, { group, member: a.key, on: true }),
    () => member.groupBan(b, { group, member: a.key, on: true }),
    () => member.groupAdmin(b, { group, member: a.key, on: true }),
    () => member.groupMeta(b, { group, name: 'Outra' })
  ]
  for (const run of ops) await rejects(t, run(), 'grupo não encontrado', 'NOT_FOUND')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const { key, entries } = await writerEntries(b, group)
  t.alike(entries[1].record, { type: 'group-leave', seen: null, cuts: [{ writer: key, seq: 1 }], at: entries[1].record.at })
  t.alike((await groupJoins(b, group)).map((j) => j.on), [true, false])
  await rejects(t, member.groupLeave(b, { group }), 'nada a alterar')
  t.is((await member.groupList(b)).groups[0].role, 'pending')
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'left')
})

async function otherDevice (ctx, group, nonce, records = []) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const writer = await store.openGroupWriter(s, nonce)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(writer, groupLib.writerHeader({ group, diary: ctx.key }), { validator })
    for (const r of records) await store.appendRecord(writer, r, { validator })
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(writer.key), on: true }))
    return { key: hex(writer.key), length: writer.length }
  } finally {
    await s.close()
  }
}

test('a leave lists every counted writer of the own diary at its local length', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(b, { group, text: 'deste' })
  const other = await otherDevice(b, group, 'ab'.repeat(16), [groupLib.groupPost({ text: 'do outro' })])
  const own = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const left = await writerEntries(b, group)
  const leave = left.entries[left.length - 1].record
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts, [{ writer: own.key, seq: own.length }, { writer: other.key, seq: other.length }].sort((x, y) => x.writer.localeCompare(y.writer)))
  await exchange(b, a)
  const read = await member.groupRead(a, { group })
  t.alike(read.items.map((p) => [p.text, p.hidden]).sort(), [['', true], ['deste', false]], 'a leave withdraws the other device records from seq 0')
  // The creator's leave lists the root.
  await member.groupPost(a, { group, text: 'raiz' })
  const root = await writerEntries(a, group)
  await member.groupLeave(a, { group })
  const after = await writerEntries(a, group)
  t.alike(after.entries[after.length - 1].record.cuts, [{ writer: group, seq: root.length }])
})

test('a grant lists every counted writer of the promoted diary at its local length', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(b, { group, text: 'antes' })
  await member.groupLeave(b, { group })
  const first = await writerEntries(b, group)
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  await member.groupPost(b, { group, text: 'de novo' })
  const second = await writerEntries(b, group)
  await exchange(b, a)
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: true }), { ok: true })
  const root = await writerEntries(a, group)
  const cuts = root.entries[root.length - 1].record.cuts
  t.alike(cuts, [{ writer: first.key, seq: first.length }, { writer: second.key, seq: second.length }].sort((x, y) => x.writer.localeCompare(y.writer)))
  t.absent(cuts.some((c) => c.seq === 0))
})

test('a join refuses before creating a writer when the own diary binds the per-diary writer cap', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Cheia', join: 'open' })
  await exchange(a, b)
  for (let i = 0; i < groupLib.MAX_GROUP_WRITERS_PER_DIARY; i++) {
    await otherDevice(b, group, (i + 1).toString(16).padStart(32, '0'), [groupLib.groupLeave()])
  }
  const length = (await member.logRead(b)).entries.length
  const held = await heldWriters(b, group)
  await rejects(t, member.groupJoin(b, { group }), 'limite do grupo atingido')
  t.alike(store.readGroups(b.dataDir), [], 'no local entry')
  t.is((await member.logRead(b)).entries.length, length, 'no diary join')
  t.is(await heldWriters(b, group), held, 'no new writer')
})

test('a pending leave refuses while the own diary binds another writer of the group', async (t) => {
  const { b, group } = await pendingPair(t)
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  await otherDevice(b, group, 'ab'.repeat(16))
  const before = (await member.logRead(b)).entries.length
  await rejects(t, member.groupLeave(b, { group }), 'aguarde a sincronização do grupo para sair')
  t.is((await member.logRead(b)).entries.length, before, 'no diary leave')
  t.is((await writerEntries(b, group)).length, 1, 'no leave record')
})

test('admission and grant cuts sit at the signed length, past blocks not downloaded', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  await offlineAppend(b, group, groupLib.groupPost({ text: 'um', at: AT }))
  await offlineAppend(b, group, groupLib.groupPost({ text: 'dois', at: AT }))
  await exchange(b, a)
  const bw = await writerEntries(b, group)
  const s = await store.openStore(a.dataDir)
  try {
    const replica = s.get({ key: b4a.from(bw.key, 'hex'), writable: false })
    await replica.ready()
    await replica.clear(2, 3)
    t.is(replica.contiguousLength, 2)
    t.is(replica.length, 3)
    await replica.close()
  } finally {
    await s.close()
  }
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  let root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 3 }], 'admit cut at the signed length')
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: true }), { ok: true })
  root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 3 }], 'grant cut at the signed length')
  t.alike(await member.groupAdmin(a, { group, member: b.key, on: false }), { ok: true })
  root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 2 }], 'a demotion keeps the contiguous length')
})

test('an unban cuts a writer at its signed length, past blocks not downloaded', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  await offlineAppend(b, group, groupLib.groupPost({ text: 'um', at: AT }))
  await offlineAppend(b, group, groupLib.groupPost({ text: 'dois', at: AT }))
  await exchange(b, a)
  const bw = await writerEntries(b, group)
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  const s = await store.openStore(a.dataDir)
  try {
    const replica = s.get({ key: b4a.from(bw.key, 'hex'), writable: false })
    await replica.ready()
    await replica.clear(2, 3)
    t.is(replica.contiguousLength, 2)
    t.is(replica.length, 3)
    await replica.close()
  } finally {
    await s.close()
  }
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts, [{ writer: bw.key, seq: 3 }], 'unban cut at the signed length')
})

// Another device of the diary bound `writer`, whose core never reached here.
async function bindElsewhere (ctx, group, writer) {
  const s = await store.openStore(ctx.dataDir)
  try {
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer, on: true }))
  } finally {
    await s.close()
  }
}

test('a member leaves at once while another device of the diary bound a writer not held here', async (t) => {
  const { b, group } = await pair(t)
  await bindElsewhere(b, group, 'cd'.repeat(32))
  const own = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const left = await writerEntries(b, group)
  const leave = left.entries[left.length - 1].record
  t.is(leave.type, 'group-leave')
  t.alike(leave.cuts, [{ writer: own.key, seq: own.length }], 'cuts name the held counted writers')
})

test('a creator leaves from a device that holds the root without its key, and the leave lists the root', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  // A root written elsewhere naming Bia as creator: her diary binds it, but
  // this device cannot write it.
  const s = await store.openStore(a.dataDir)
  let group
  try {
    const root = await store.openGroupWriter(s, 'ef'.repeat(16))
    group = hex(root.key)
    await store.appendRecord(root, groupLib.groupHeader({ diary: b.key, name: 'Horta', join: 'open' }), { validator: (r) => groupLib.validateGroupHeader(r) })
  } finally {
    await s.close()
  }
  await exchange(a, b)
  await bindElsewhere(b, group, group)
  t.alike(await member.groupJoin(b, { group }), { state: 'member' })
  t.is((await member.groupInfo(b, { group })).role, 'creator')
  const own = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  const left = await writerEntries(b, group)
  t.alike(left.entries[left.length - 1].record.cuts, [{ writer: group, seq: 1 }, { writer: own.key, seq: own.length }].sort((x, y) => x.writer.localeCompare(y.writer)))
})

test('an admit refuses while the member diary binds a writer not held here', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  await bindElsewhere(b, group, 'cd'.repeat(32))
  await exchange(b, a)
  const before = (await writerEntries(a, group)).length
  await rejects(t, member.groupAdmit(a, { group, member: b.key, on: true }), 'aguarde a sincronização do grupo para admitir')
  t.is((await writerEntries(a, group)).length, before, 'nothing written')
})

// Another device of ctx's diary: a writer core bound by a join on, with
// `posts` group posts after its header.
async function otherWriter (ctx, group, nonce, posts = 0) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = await store.openGroupWriter(s, nonce)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(core, groupLib.writerHeader({ group, diary: ctx.key, rejoin: null }), { validator })
    for (let i = 0; i < posts; i++) await store.appendRecord(core, groupLib.groupPost({ text: 'outro ' + i }), { validator })
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer: hex(core.key), on: true }))
    return hex(core.key)
  } finally {
    await s.close()
  }
}

test('an admitted member with a writer the admit did not list is requested again and can be admitted again', async (t) => {
  const { a, b, group } = await pair(t, 'approval')
  const first = (await writerEntries(b, group)).key
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  const second = await otherWriter(b, group, 'ab'.repeat(16), 1)
  await exchange(b, a)
  t.is((await member.groupRead(a, { group })).items.filter((p) => !p.hidden).length, 0, 'the unlisted writer stays hidden')
  const requests = await member.groupRequests(a, { group })
  t.is(requests.total, 1, 'listed for the admins')
  t.alike(requests.requests.map((r) => r.member), [b.key])
  t.alike(await member.groupAdmit(a, { group, member: b.key, on: true }), { ok: true })
  const root = await writerEntries(a, group)
  t.alike(root.entries[root.length - 1].record.cuts.map((c) => c.writer), [first, second].sort())
  t.is((await member.groupRequests(a, { group })).total, 0)
})

test('an unban that missed a writer can be repeated citing the same ban', async (t) => {
  const { a, b, group } = await pair(t)
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  const ban = (await writerEntries(a, group)).length - 1
  const second = await otherWriter(b, group, 'ab'.repeat(16), 1)
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true }, 'an unban before the second writer arrives')
  await exchange(b, a)
  t.alike((await member.groupRead(a, { group })).items.map((p) => p.hidden), [true], 'the unlisted writer stays banned')
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  const root = await writerEntries(a, group)
  const unban = root.entries[root.length - 1].record
  t.alike(unban.lifts, { writer: group, seq: ban })
  t.ok(unban.cuts.some((c) => c.writer === second), 'the new unban lists the writer')
  await rejects(t, member.groupBan(a, { group, member: b.key, on: false }), 'nada a alterar')
})

test('a member whose unban missed another writer leaves from a writer that is not banned, and still cannot join', async (t) => {
  const { a, b, group } = await pair(t)
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  await otherWriter(b, group, 'ab'.repeat(16), 1)
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  await exchange(b, a)
  await exchange(a, b)
  const view = await member.groupInfo(b, { group })
  t.is(view.state, 'member')
  await rejects(t, member.groupJoin(b, { group }), 'sem permissão no grupo')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.is((await member.groupInfo(b, { group })).state, 'left')
})

test('a member whose own writer an unban missed can still leave', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open' })
  await exchange(a, b)
  await member.groupJoin(b, { group })
  // Ban and unban before Bia's writer arrives: the unban lists none of hers.
  t.alike(await member.groupBan(a, { group, member: b.key, on: true }), { ok: true })
  t.alike(await member.groupBan(a, { group, member: b.key, on: false }), { ok: true })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).state, 'member')
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.is((await member.groupInfo(b, { group })).state, 'left')
})

test('a joined root this node never folds keeps no slot: leaving drops its entry', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const s = await store.openStore(a.dataDir)
  let group
  try {
    const root = await store.openGroupWriter(s, 'ef'.repeat(16))
    group = hex(root.key)
    await store.appendRecord(root, groupLib.groupHeader({ kind: 'community', diary: a.key, name: 'Comunidade', join: 'open' }), { validator: (r) => groupLib.validateGroupHeader(r) })
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer: group, on: true }))
  } finally {
    await s.close()
  }
  t.alike(await member.groupJoin(b, { group }), { state: 'pending' })
  await exchange(a, b)
  const writer = await writerEntries(b, group)
  t.alike(await member.groupLeave(b, { group }), { state: 'left' })
  t.absent(store.readGroups(b.dataDir).some((g) => g.group === group), 'the entry is gone')
  const s2 = await store.openStore(b.dataDir)
  try {
    const core = s2.get({ key: b4a.from(writer.key, 'hex'), valueEncoding: 'json' })
    await core.ready()
    const entries = await store.readAll(core)
    t.is(entries[entries.length - 1].record.type, 'group-leave', 'the writer holds a leave')
    await core.close()
  } finally {
    await s2.close()
  }
  t.alike((await groupJoins(b, group)).map((j) => j.on), [true, false], 'the diary turns the writer off')
})

test('loading a group records a root its creator bound, and not one it never bound', async (t) => {
  const { b, group } = await pair(t)
  await member.groupInfo(b, { group })
  t.ok(readBoundRoots(b.dataDir).includes(group), 'a bound root is recorded')
  const kp = crypto.keyPair()
  const c = await person(t, kp, 'Cida')
  const s = await store.openStore(c.dataDir)
  let unbound
  try {
    const root = await store.openGroupWriter(s, 'ab'.repeat(16))
    unbound = hex(root.key)
    await store.appendRecord(root, groupLib.groupHeader({ diary: 'cd'.repeat(32), name: 'Solto', join: 'open' }), { validator: (r) => groupLib.validateGroupHeader(r) })
  } finally {
    await s.close()
  }
  await member.groupInfo(c, { group: unbound })
  t.absent(readBoundRoots(c.dataDir).includes(unbound), 'an unbound root is not')
})
