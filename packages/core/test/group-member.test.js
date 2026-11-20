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
    group, name: 'Horta', image: null, imageAuthor: null, join: 'open', creator: ctx.key, role: 'creator', members: 1, state: 'member', community, orphan: false, visibility: 'public', memberInvite: false
  })
  const list = await member.groupList(ctx)
  t.is(list.total, 2)
  t.alike(list.groups.find((g) => g.group === group), { group, name: 'Horta', image: null, imageAuthor: null, join: 'open', role: 'creator', members: 1, community })
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

// Copies the blocks `from`'s own diary holds into the store of `to`: a block
// `from` cleared never reaches `to`.
async function copyHeldDiary (from, to) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const key = b4a.from(from.key, 'hex')
    const source = a.get({ key, writable: false })
    await source.ready()
    const target = b.get({ key, writable: false })
    await target.ready()
    left = a.replicate(true)
    right = b.replicate(false)
    left.pipe(right).pipe(left)
    for (let seq = 0; seq < source.length; seq++) {
      if (await source.has(seq)) await target.get(seq, { raw: true, timeout: 10000 })
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

test('a group fold reads no gap in the cut history of a member diary for a deleted block this replica never read', async (t) => {
  const { a, b, group } = await pair(t)
  const { seq } = await member.postCreate(b, { text: 'apagado' })
  await member.postDelete(b, { to: { author: b.key, seq } })
  await copyHeldDiary(b, a)
  const s = await store.openStore(a.dataDir)
  const replica = s.get({ key: b4a.from(b.key, 'hex'), writable: false })
  await replica.ready()
  t.absent(await replica.has(seq), 'fixture: the deleted post never reached A')
  t.ok(await replica.has(seq + 1), 'fixture: its tombstone did')
  await s.close()
  const real = groupLib.groupCutHistory
  const seen = []
  groupLib.groupCutHistory = (entries, g, ...rest) => {
    const out = real(entries, g, ...rest)
    if (g === group && entries.some((e) => e.record && e.record.type === 'delete' && e.record.seq === seq)) seen.push(out)
    return out
  }
  try {
    await member.groupInfo(a, { group })
  } finally {
    groupLib.groupCutHistory = real
  }
  t.ok(seen.length > 0, 'the fold read B\'s diary')
  t.ok(seen.every((out) => !out.some((m) => m.gap === true)), 'B\'s cut history has no gap')
})

test('a group fold on the core node reads no gap in the own diary for a deleted post cleared with nothing remembered', async (t) => {
  const { a, group } = await pair(t)
  const { seq } = await member.postCreate(a, { text: 'apagado' })
  await member.postDelete(a, { to: { author: a.key, seq } })
  const s = await store.openStore(a.dataDir)
  try {
    const diary = await store.openDiary(s)
    t.absent(await diary.has(seq), 'fixture: the deleted post is cleared')
    // As an older node cleared it: nothing remembers the read.
    await diary.setUserData('varanda/page-read', b4a.alloc(0))
  } finally {
    await s.close()
  }
  const real = groupLib.groupCutHistory
  const seen = []
  groupLib.groupCutHistory = (entries, g, ...rest) => {
    const out = real(entries, g, ...rest)
    if (g === group && entries.some((e) => e.record && e.record.type === 'delete' && e.record.seq === seq)) seen.push(out)
    return out
  }
  try {
    await member.groupInfo(a, { group })
  } finally {
    groupLib.groupCutHistory = real
  }
  t.ok(seen.length > 0, 'the fold read the own diary')
  t.ok(seen.every((out) => !out.some((m) => m.gap === true)), 'the own cut history has no gap')
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

test('core and browser group projections agree on an image side record', async (t) => {
  const webOps = require('../../web-member/lib/member-ops')
  const webStore = require('../../web-member/lib/node-store')
  const { memoryNodeStorage } = require('../../web-member/lib/node-storage')
  const { a, b, group } = await pair(t)
  const community = communityOfGroup.get(group)
  const image = { core: 'ab'.repeat(32), start: 1, blocks: 1, bytes: 27, sha256: 'cd'.repeat(32), mime: 'image/jpeg', width: 512, height: 512 }
  await offlineAppend(a, group, groupLib.groupImage({ image }))
  await exchange(a, b)
  const ctx = { storage: memoryNodeStorage(), association: b.association, keyPair: crypto.keyPair() }
  await webOps.idCreate(ctx)
  const src = await store.openStore(a.dataDir)
  try {
    for (const [key, diary] of [[a.key, true], [b.key, true], [community, false], [group, false]]) {
      const source = src.get({ key: b4a.from(key, 'hex'), writable: false })
      await source.ready()
      const target = diary ? await webStore.openReplica(ctx.storage, key) : await webStore.openGroupReplica(ctx.storage, key)
      const left = src.replicate(true)
      const right = target.replicate(false, { keepAlive: false })
      left.pipe(right).pipe(left)
      try {
        await target.download({ start: 0, end: source.length }).done()
      } finally {
        left.destroy()
        right.destroy()
        await target.close()
        await source.close()
      }
      if (diary) await webStore.addGroupDiary(ctx.storage, key)
      else await webStore.addGroupReplica(ctx.storage, key)
    }
  } finally {
    await src.close()
  }
  const core = await member.groupInfo(b, { group })
  const browser = await webOps.groupInfo(ctx, { group })
  const projection = ({ name, image, imageAuthor, creator, community, visibility }) => ({ name, image, imageAuthor, creator, community, visibility })
  t.alike(projection(browser), projection(core))
  t.alike([core.image, core.imageAuthor], [image, a.key])
  const coreRow = (await member.communityInfo(b, { community })).groups.find((r) => r.group === group)
  const browserRow = (await webOps.communityInfo(ctx, { community })).groups.find((r) => r.group === group)
  t.alike(projection(browserRow), projection(coreRow))
  t.alike([coreRow.image, coreRow.imageAuthor], [image, a.key])
})

test('core and browser project the same private group image and hide it while pending', async (t) => {
  const webOps = require('../../web-member/lib/member-ops')
  const webStore = require('../../web-member/lib/node-store')
  const { memoryNodeStorage } = require('../../web-member/lib/node-storage')
  const { createGroupKeys } = require('../../web-member/lib/group-keys')
  const gc = require('../lib/group-crypto')
  const { sealMedia } = require('../lib/group-media')
  const association = crypto.keyPair()
  const a = await person(t, association)
  const b = await person(t, association, 'Bia')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'approval', visibility: 'private' })
  const community = communityOfGroup.get(group)
  await exchange(a, b)
  await joinGroup(b, { group })
  await exchange(b, a)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  const bw = await writerEntries(b, group)
  const root = await writerEntries(a, group)
  const box = store.ensureBoxKeyPair(a.dataDir)
  const kid = { writer: group, seq: 1 }
  const key = gc.openEpochKey(b4a.from(root.entries[1].record.keys[0].sealed, 'base64'), box, group, kid)
  const jpeg = b4a.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 0, 2, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9])
  const image = { core: 'ab'.repeat(32), start: 1, ...sealMedia(jpeg, { plainMime: 'image/jpeg', w: 512, h: 512 }).item }
  const record = { ...groupLib.groupImage({ image: null, seen: { writer: group, seq: root.length - 1 } }), image }
  const sealed = gc.sealRecord(groupLib.sealedInner(record, { writer: group, group, kid }), key)
  gc.wipe(key)
  const source = await store.openStore(a.dataDir)
  const ctx = { storage: memoryNodeStorage(), association: a.association, keyPair: crypto.keyPair() }
  const holder = createGroupKeys()
  t.teardown(async () => {
    holder.close()
    gc.wipe(box.secretKey)
    await source.close()
  })
  await webOps.idCreate(ctx)
  await holder.unlock(ctx.storage, crypto.randomBytes(32))
  ctx.groupKeys = Object.create(holder)
  ctx.groupKeys.boxPublicKey = () => holder.unlocked ? b4a.from(box.publicKey) : null
  ctx.groupKeys.boxKeyPair = () => holder.unlocked ? box : null
  const local = store.readGroups(a.dataDir).find((g) => g.group === group)
  const writer = await store.openGroupWriter(source, local.nonce)
  await writer.append(groupLib.groupSealed({ kid, ...sealed, at: record.at }))
  const held = new Map()
  for await (const dk of source.list()) {
    const core = source.get({ discoveryKey: dk, writable: false })
    await core.ready()
    held.set(hex(core.key), core)
  }
  // The browser's borrowed-core path reads the same signed logs and identity.
  ctx.keyPair = null
  ctx.cores = { diary: held.get(a.key), group: (key) => held.get(key) || null, replica: (key) => held.get(key) || null }
  const project = ({ image, imageAuthor }) => ({ image, imageAuthor })
  const compare = async (expected) => {
    const open = store.openStore
    store.openStore = async () => source.session()
    try {
      const core = await member.groupInfo(a, { group })
      const browser = await webOps.groupInfo(ctx, { group })
      t.alike(project(browser), project(core))
      t.alike(project(core), expected)
      const browserRow = (await webOps.groupList(ctx)).groups.find((r) => r.group === group)
      const coreRow = (await member.groupList(a)).groups.find((r) => r.group === group)
      t.alike(project(browserRow), expected)
      t.alike(project(coreRow), expected)
      const browserCommunityRow = (await webOps.communityInfo(ctx, { community })).groups.find((r) => r.group === group)
      const coreCommunityRow = (await member.communityInfo(a, { community })).groups.find((r) => r.group === group)
      t.alike(project(browserCommunityRow), project(coreCommunityRow))
      t.alike(project(browserCommunityRow), expected)
      t.alike(project(coreCommunityRow), expected)
    } finally {
      store.openStore = open
    }
  }

  for (const key of held.keys()) await webStore.addGroupReplica(ctx.storage, key)
  await compare({ image, imageAuthor: a.key })
  holder.lock()
  t.alike(project(await webOps.groupInfo(ctx, { group })), { image: null, imageAuthor: null })
  const lockedRow = (await webOps.communityInfo(ctx, { community })).groups.find((r) => r.group === group)
  t.alike(project(lockedRow), { image: null, imageAuthor: null })
  await holder.unlock(ctx.storage, crypto.randomBytes(32))
  await writer.append(groupLib.groupBan({ member: b.key, on: true, cuts: [{ writer: bw.key, seq: bw.length }], seen: { writer: group, seq: writer.length - 1 } }))
  await compare({ image: null, imageAuthor: null })
})
