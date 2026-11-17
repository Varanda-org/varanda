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
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, AT, person, exchange, pair, writerEntries, offlineAppend, rejects, communityOfGroup, FILL, createGroup, joinGroup } = require('./helpers/group-member')

test('create requires a diary genesis and persists a root writer and join', async (t) => {
  const kp = crypto.keyPair()
  const ctx = await person(t, kp, 'Ana', false)
  await t.exception(() => createGroup(ctx, { name: 'Horta', join: 'open' }), /grave o certificado/)
  t.alike(store.readGroups(ctx.dataDir), [])
  await member.certAdd(ctx, createCert({ member: ctx.key }, kp))
  const { group } = await createGroup(ctx, { name: 'Horta', join: 'open' })
  const community = communityOfGroup.get(group)
  const data = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'groups.json'), 'utf8'))
  t.is(data.v, 1)
  t.is(data.groups.length, 3, 'the community, Geral and the group')
  const own = data.groups[2]
  t.alike(Object.keys(own), ['group', 'writer', 'nonce'])
  t.is(own.writer, group)
  t.ok(/^[0-9a-f]{32}$/.test(own.nonce))
  const root = await writerEntries(ctx, group)
  t.is(root.key, group)
  t.alike(root.entries[0].record, {
    type: 'group-header',
    v: 2,
    kind: 'group',
    diary: ctx.key,
    community,
    member: community,
    visibility: 'public',
    join: 'open',
    name: 'Horta',
    box: null,
    at: root.entries[0].record.at
  })
  const { entries } = await member.logRead(ctx)
  const last = entries[entries.length - 1]
  t.alike(last.record, groupJoinRecord({ group, writer: group, on: true, at: last.record.at }))
  t.alike(await member.groupInfo(ctx, { group }), {
    group, name: 'Horta', join: 'open', creator: ctx.key, role: 'creator', members: 1, state: 'member', community, orphan: false, visibility: 'public', memberInvite: false
  })
  const list = await member.groupList(ctx)
  t.is(list.total, 2)
  t.alike(list.groups.find((g) => g.group === group), { group, name: 'Horta', join: 'open', role: 'creator', members: 1, community })
  await rejects(t, member.groupInfo(ctx, { group: 'f'.repeat(64) }), 'grupo não encontrado', 'NOT_FOUND')
})

test('join is idempotent and reads two writers backwards in causal order', async (t) => {
  const { a, b, group, joined } = await pair(t)
  t.alike(joined, { state: 'member' })
  const before = await writerEntries(b, group)
  t.alike(await joinGroup(b, { group }), { state: 'member' })
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
  t.alike(await joinGroup(b, { group }), { state: 'requested' })
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
  t.is(store.readGroups(b.dataDir).length, 3, 'the CW, Geral and the group')
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
  await rejects(t, joinGroup(b, { group }), 'sem permissão no grupo')
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
  await rejects(t, member.groupMeta(a, { group, name: 'Outra' }), 'aguarde a sincronização da comunidade')
  await rejects(t, member.groupAdmin(a, { group, member: b.key, on: true }), 'aguarde a sincronização da comunidade')
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
  await joinGroup(b, { group })
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
  await rejects(t, joinGroup(b, { group }), 'sem permissão na comunidade')
  t.is((await member.logRead(b)).entries.length, length, 'no diary join from a blocked own diary')
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 2, blocked: [group] }, mod, cert))
  await rejects(t, member.groupRead(a, { group }), 'grupo não encontrado', 'NOT_FOUND')
})

test('creator rejoin keeps charter writes on the original root', async (t) => {
  const ctx = await person(t, crypto.keyPair())
  const { group } = await createGroup(ctx, { name: 'Horta', join: 'open' })
  await member.groupLeave(ctx, { group })
  t.alike(await joinGroup(ctx, { group }), { state: 'member' })
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
  const { group } = await createGroup(a, { name: 'Novo', join: 'open' })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  try {
    const diary = await store.openDiary(s)
    const locals = []
    for (let i = 0; i < 64; i++) {
      const nonce = i.toString(16).padStart(32, '0')
      const writer = await store.openGroupWriter(s, nonce)
      const key = hex(writer.key)
      await store.appendRecord(writer, groupLib.groupHeader({ community: FILL, member: FILL, diary: b.key, name: 'Grupo ' + i }), {
        validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true })
      })
      await store.appendRecord(diary, groupJoinRecord({ group: key, writer: key, on: true }))
      locals.push({ group: key, writer: key, nonce })
    }
    store.writeGroups(b.dataDir, locals)
  } finally {
    await s.close()
  }
  await rejects(t, createGroup(b, { name: 'Demais', join: 'open' }), 'limite de grupos atingido')
  await rejects(t, joinGroup(b, { group }), 'limite de grupos atingido')
  const existing = store.readGroups(b.dataDir)[0].group
  await rejects(t, joinGroup(b, { group: existing }), 'aguarde a sincronização da comunidade')
  await member.groupLeave(b, { group: existing })
  await rejects(t, joinGroup(b, { group }), 'limite de grupos atingido')
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

// A loaded group as member.js keeps it, from the fold fixtures: X binds
// eight writers, then maybe cuts the first, then binds a 9th (#350).
const slot = (() => {
  const { K, AT: at } = require('./helpers/groups')
  const ws = []
  for (let i = 0; i < 8; i++) ws.push(K(0x4100 + i))
  return { K, at, Z: K(0x9), X: K(0x4), G1: K(0x100), ws, ninth: K(0x4200) }
})()

function slotLoaded ({ cut = null, drop = [] } = {}) {
  const { community, groupIn } = require('./helpers/groups')
  const { K, Z, X, G1, ws, ninth } = slot
  const C = community({ creator: Z, members: [{ diary: X, cw: K(0x40), status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  for (let i = 0; i < ws.length; i++) {
    g.add(X, ws[i])
    g.push(ws[i], groupLib.groupPost({ text: 'p' + i, at: slot.at(10 + i) }))
  }
  if (cut !== null) g.mark(X, ws[0], cut)
  g.add(X, ninth)
  const input = g.input({ drop })
  const view = groupLib.buildGroup(input)
  const logs = input.writers.map((l) => ({ key: l.key, diary: l.diary, length: l.entries.length, signed: l.entries.length }))
  return { group: G1, logs, view, input }
}

test('countedCuts: a frozen writer stays in admissions at its cut, out of leaves and grants (#350)', (t) => {
  const { X, ws, ninth } = slot
  t.is(member.countedCuts(slotLoaded(), X).length, 8, 'control: eight counted writers')
  const loaded = slotLoaded({ cut: 1 })
  const all = member.countedCuts(loaded, X)
  t.is(all.length, 9, 'eight live and the frozen one')
  t.alike(all.find((c) => c.writer === ws[0]), { writer: ws[0], seq: 1 }, 'the frozen writer at its cut, below its length')
  t.ok(all.some((c) => c.writer === ninth))
  const leave = member.countedCuts(loaded, X, { frozen: false })
  t.is(leave.length, 8, 'a leave or a grant names the live ones only')
  t.absent(leave.some((c) => c.writer === ws[0]))
  t.is(groupLib.validateGroupRecord(groupLib.groupLeave({ cuts: leave, at: slot.at(40) }), 1), null, 'so a new leave stays valid')
  const released = slotLoaded({ cut: 0 })
  t.ok(released.view.writers.has(ws[0]), 'a released writer still counts for its block 0, leaves and key blocks')
  t.absent(member.countedCuts(released, X).some((c) => c.writer === ws[0]), 'but no admission names it')
  t.is(member.countedCuts(released, X).length, 8, 'seven live and the 9th')
})

test('unheldCountedWriters follows the slot walk (#350)', (t) => {
  const { X, ws, ninth } = slot
  t.alike(member.unheldCountedWriters(slotLoaded(), X), [], 'control: all held, the 9th never counts')
  t.alike(member.unheldCountedWriters(slotLoaded({ drop: [ninth] }), X), [], 'an unheld writer past the cap is never awaited')
  t.alike(member.unheldCountedWriters(slotLoaded({ cut: 1, drop: [ninth] }), X), [ninth], 'after a freeze the 9th is awaited')
  t.alike(member.unheldCountedWriters(slotLoaded({ cut: 1, drop: [ws[0]] }), X), [ws[0]], 'and so is an unheld frozen writer')
  t.alike(member.unheldCountedWriters(slotLoaded({ cut: 0, drop: [ws[0]] }), X), [ws[0]], 'a released writer is awaited: it may hold a leave')
})

test('groupCuts: an admit or a ban never names a writer past the diary\'s cut on it (#350)', (t) => {
  const { X, ws } = slot
  // ws[0] holds two blocks and is cut at 3, past what it holds: a post it
  // adds at seq 2 still counts, so a probe keeps it among the cuts.
  const loaded = slotLoaded({ cut: 3 })
  const w0 = loaded.logs.find((l) => l.key === ws[0])
  w0.signed = 6
  const signed = member.groupCuts(loaded, X, { signed: true })
  t.alike(signed.find((c) => c.writer === ws[0]), { writer: ws[0], seq: 3 }, 'the signed length past the cut stops at the cut')
  t.alike(member.groupCuts(loaded, X).find((c) => c.writer === ws[0]), { writer: ws[0], seq: 2 }, 'a local length below the cut stays')
  t.alike(member.groupCuts(slotLoaded(), X).find((c) => c.writer === ws[1]), { writer: ws[1], seq: 2 }, 'control: an uncut writer at its length')
})
