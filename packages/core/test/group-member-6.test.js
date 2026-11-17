'use strict'

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createModeratorCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const groupLib = require('../lib/group')
const { readBoundRoots } = require('../lib/sync')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, pair, writerEntries, offlineAppend, rejects, FILL, createGroup, joinGroup, THUMBS, HEART } = require('./helpers/group-member')
const { groupCutRecord } = require('../lib/records')

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
    await store.appendRecord(root, groupLib.groupHeader({ community: FILL, member: FILL, diary: 'cd'.repeat(32), name: 'Solto', join: 'open' }), { validator: (r) => groupLib.validateGroupHeader(r) })
  } finally {
    await s.close()
  }
  await member.groupInfo(c, { group: unbound })
  t.absent(readBoundRoots(c.dataDir).includes(unbound), 'an unbound root is not')
})

test('the members invite flag: creator and group admin write it, a member is refused', async (t) => {
  const { a, b, group } = await pair(t)
  const before = (await writerEntries(b, group)).length
  await rejects(t, member.groupInvitePolicy(b, { group, members: true }), 'sem permissão no grupo')
  t.is((await writerEntries(b, group)).length, before, 'nothing appended')
  t.is((await member.groupInfo(a, { group })).memberInvite, false)
  t.alike(await member.groupInvitePolicy(a, { group, members: true }), { ok: true })
  const info = await member.groupInfo(a, { group })
  t.is(info.memberInvite, true)
  t.is(info.name, 'Horta')
  await rejects(t, member.groupInvitePolicy(a, { group, members: true }), 'nada a alterar')
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await exchange(a, b)
  t.is((await member.groupInfo(b, { group })).memberInvite, true)
  await member.groupInvitePolicy(b, { group, members: false })
  const own = await writerEntries(b, group)
  t.is(own.entries[own.length - 1].record.type, 'group-invites')
  t.is((await member.groupInfo(b, { group })).memberInvite, false)
  await exchange(b, a)
  t.is((await member.groupInfo(a, { group })).memberInvite, false)
})

test('the members invite flag of a private group is stored in the clear', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { group } = await createGroup(a, { name: 'Horta', join: 'approval', visibility: 'private' })
  await member.groupInvitePolicy(a, { group, members: true })
  const root = await writerEntries(a, group)
  const last = root.entries[root.length - 1].record
  t.is(last.type, 'group-invites')
  t.is(last.on, true)
  const info = await member.groupInfo(a, { group })
  t.is(info.memberInvite, true)
  t.is(info.name, 'Horta')
})

test('group.react: react, replace, toggle off and an equal reaction writes nothing', async (t) => {
  const { a, b, group } = await pair(t)
  const { seq } = await member.groupPost(b, { group, text: 'hortelã' })
  const target = { writer: (await writerEntries(b, group)).key, seq }
  await exchange(b, a)
  t.absent('reactions' in (await member.groupRead(a, { group })).items[0], 'absent when empty')
  t.alike(await member.groupReact(a, { group, target, emoji: THUMBS }), { ok: true })
  const root = await writerEntries(a, group)
  const last = root.entries[root.length - 1].record
  t.is(last.type, 'group-react')
  t.alike(last.target, target)
  t.alike(last.seen, target, 'seen from the own fold')
  t.alike((await member.groupRead(a, { group })).items[0].reactions, [{ emoji: THUMBS, count: 1, mine: true }])
  t.alike(await member.groupReact(a, { group, target, emoji: THUMBS }), { ok: true })
  t.is((await writerEntries(a, group)).length, root.length, 'the same emoji again writes nothing')
  await member.groupReact(a, { group, target, emoji: HEART })
  t.alike((await member.groupRead(a, { group })).items[0].reactions, [{ emoji: HEART, count: 1, mine: true }], 'replaced')
  await exchange(a, b)
  t.alike((await member.groupRead(b, { group })).items[0].reactions, [{ emoji: HEART, count: 1, mine: false }])
  await member.groupReact(b, { group, target, emoji: HEART })
  t.alike((await member.groupRead(b, { group })).items[0].reactions, [{ emoji: HEART, count: 2, mine: true }])
  await exchange(b, a)
  t.alike(await member.groupReactors(a, { group, target }), { reactions: [{ emoji: HEART, count: 2, by: [a.key, b.key] }] })
  await member.groupReact(a, { group, target, emoji: '' })
  const off = await writerEntries(a, group)
  t.is(off.entries[off.length - 1].record.emoji, '')
  t.alike((await member.groupRead(a, { group })).items[0].reactions, [{ emoji: HEART, count: 1, mine: false }], 'toggled off')
  await member.groupReact(a, { group, target, emoji: '' })
  t.is((await writerEntries(a, group)).length, off.length, 'removing an absent reaction writes nothing')
  t.alike(await member.groupReactors(a, { group, target }), { reactions: [{ emoji: HEART, count: 1, by: [b.key] }] })
})

test('group.react: removing a reaction the full list cuts still writes', async (t) => {
  const { GROUP_REACTIONS_MAX } = require('@varanda/rpc')
  const { a, group } = await pair(t)
  const { seq } = await member.groupPost(a, { group, text: 'vote' })
  const target = { writer: group, seq }
  await member.groupReact(a, { group, target, emoji: THUMBS })
  // The fold kept GROUP_REACTIONS_MAX earlier emojis of other diaries and
  // cut the caller's: the list does not name it.
  const full = Array.from({ length: GROUP_REACTIONS_MAX }, (_, i) => ({ emoji: String.fromCodePoint(0x1f600 + i), count: 1, by: [i.toString(16).padStart(64, '0')] }))
  const build = groupLib.buildGroup
  groupLib.buildGroup = (...args) => {
    const view = build(...args)
    for (const p of view.posts) p.reactions = full
    return view
  }
  try {
    t.absent((await member.groupRead(a, { group })).items[0].reactions.some((r) => r.mine), 'the own reaction is beyond the cap')
    const before = await writerEntries(a, group)
    await member.groupReact(a, { group, target, emoji: '' })
    const after = await writerEntries(a, group)
    t.is(after.length, before.length + 1, 'the removal is written')
    t.is(after.entries[after.length - 1].record.emoji, '')
    full.pop()
    await member.groupReact(a, { group, target, emoji: '' })
    t.is((await writerEntries(a, group)).length, after.length, 'a list with room proves there is nothing to remove')
  } finally {
    groupLib.buildGroup = build
  }
  t.absent('reactions' in (await member.groupRead(a, { group })).items[0], 'the real fold no longer counts it')
})

test('group.react refusals', async (t) => {
  const { a, b, group, kp } = await pair(t)
  const { seq } = await member.groupPost(b, { group, text: 'meu' })
  const target = { writer: (await writerEntries(b, group)).key, seq }
  await exchange(b, a)
  await rejects(t, member.groupReact(a, { group, target: { writer: target.writer, seq: seq + 5 }, emoji: THUMBS }), 'mensagem não encontrada')
  await rejects(t, member.groupReactors(a, { group, target: { writer: target.writer, seq: seq + 5 } }), 'mensagem não encontrada')
  await member.groupHide(b, { group, target, on: true })
  await exchange(b, a)
  const before = await writerEntries(a, group)
  await rejects(t, member.groupReact(a, { group, target, emoji: THUMBS }), 'mensagem não encontrada')
  await rejects(t, member.groupReactors(a, { group, target }), 'mensagem não encontrada')
  await member.groupHide(b, { group, target, on: false })
  await member.groupLeave(b, { group })
  await rejects(t, member.groupReact(b, { group, target, emoji: THUMBS }), 'sem permissão no grupo')
  await exchange(b, a)
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: hex(mod.publicKey) }, kp)
  store.writeBlocklist(a.dataDir, createSnapshot({ seq: 1, blocked: [a.key] }, mod, cert))
  await rejects(t, member.groupReact(a, { group, target, emoji: THUMBS }), 'aguarde a sincronização da comunidade')
  t.alike(await writerEntries(a, group), before, 'nothing appended')
})

test('group.react in a private group is sealed and refused while rekey-pending', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Horta', join: 'approval', visibility: 'private' })
  const { seq } = await member.groupPost(a, { group, text: 'segredo' })
  const target = { writer: group, seq }
  await member.groupReact(a, { group, target, emoji: THUMBS })
  const root = await writerEntries(a, group)
  const last = root.entries[root.length - 1].record
  t.is(last.type, 'group-sealed', 'sealed')
  t.absent(JSON.stringify(last).includes(THUMBS))
  t.alike((await member.groupRead(a, { group })).items[0].reactions, [{ emoji: THUMBS, count: 1, mine: true }])
  await exchange(a, b)
  await joinGroup(b, { group })
  await exchange(b, a)
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await exchange(a, b)
  await member.groupLeave(b, { group })
  await exchange(b, a)
  t.is((await member.groupRead(a, { group })).state, 'rekey-pending')
  await rejects(t, member.groupReact(a, { group, target, emoji: HEART }), 'aguardando nova chave')
})

test('group.read sends the compact reaction summary, never the reactor lists', async (t) => {
  const { MAX_MESSAGE, utf8ByteLength, GROUP_LIMIT_MAX } = require('@varanda/rpc')
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const { group } = await createGroup(a, { name: 'Horta', join: 'open' })
  for (let i = 0; i < GROUP_LIMIT_MAX; i++) await member.groupPost(a, { group, text: 'post ' + i })
  // 200 reactors per post: forwarding `by` would weigh 26 x 200 x 67 bytes.
  const by = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(64, '0'))
  const build = groupLib.buildGroup
  groupLib.buildGroup = (...args) => {
    const view = build(...args)
    for (const p of view.posts) p.reactions = [{ emoji: THUMBS, count: by.length + 1, by: [...by, a.key] }]
    return view
  }
  try {
    const read = await member.groupRead(a, { group, limit: GROUP_LIMIT_MAX })
    t.is(read.items.length, GROUP_LIMIT_MAX)
    t.ok(read.items.every((p) => p.reactions.length === 1 && !('by' in p.reactions[0])))
    t.alike(read.items[0].reactions, [{ emoji: THUMBS, count: 201, mine: true }])
    t.ok(utf8ByteLength(JSON.stringify(read)) <= MAX_MESSAGE, 'fits one message')
  } finally {
    groupLib.buildGroup = build
  }
})

test('group.read leaves out the fold\'s forum keys: no topic, poll voters or thread, hidden root or not', async (t) => {
  const { a, b, group } = await pair(t)
  const root = await member.groupPost(a, { group, text: 'Vamos?' })
  const target = { writer: group, seq: root.seq }
  await offlineAppend(a, group, groupLib.groupTopic({ target }))
  await offlineAppend(a, group, groupLib.groupPoll({ target, options: ['Sim', 'Não'] }))
  await exchange(a, b)
  await member.groupPost(b, { group, text: 'Sim!', replyTo: target })
  await offlineAppend(b, group, groupLib.groupChoice({ target, pick: 0 }))
  await exchange(b, a)
  const keys = (page) => page.items.map((p) => [p.text, 'topic' in p, 'thread' in p, 'poll' in p])
  const read = await member.groupRead(a, { group })
  t.alike(keys(read), [['Sim!', false, false, false], ['Vamos?', false, false, false]])
  t.alike(await member.groupHide(a, { group, target, on: true }), { ok: true })
  const hidden = await member.groupRead(a, { group })
  t.alike(keys(hidden), [['Sim!', false, false, false], ['', false, false, false]], 'a hidden root shows no poll')
})

// A seeder keeps a cut writer sparse (#350): below the cut, then only its
// leaves and key blocks. A node holding such a copy folds it as the whole one.
test('a cut writer held sparse folds like the whole copy (#350)', async (t) => {
  const { a, b, group } = await pair(t)
  await member.groupPost(b, { group, text: 'antes' })
  const own = await writerEntries(b, group)
  const cut = own.length
  await offlineAppend(b, group, groupLib.groupPost({ text: 'depois' }))
  await offlineAppend(b, group, groupLib.groupPost({ text: 'depois 2' }))
  const leave = await offlineAppend(b, group, groupLib.groupLeave({ seen: null, cuts: [{ writer: own.key, seq: cut + 2 }] }))
  const s = await store.openStore(b.dataDir)
  try {
    await store.appendRecord(await store.openDiary(s), groupCutRecord({ group, writer: own.key, cut }))
  } finally {
    await s.close()
  }
  await exchange(b, a)
  const view = async () => {
    const info = await member.groupInfo(a, { group })
    const page = await member.groupRead(a, { group })
    const members = await member.groupMembers(a, { group })
    return JSON.stringify({ info, members, posts: page.items.map((p) => [p.writer, p.seq, p.text]) })
  }
  const whole = await view()
  t.ok(JSON.parse(whole).posts.some((p) => p[2] === 'antes'), 'control: the post below the cut counts')
  t.absent(JSON.parse(whole).posts.some((p) => p[2] === 'depois'), 'control: the posts past the cut do not')
  t.absent(JSON.parse(whole).members.members.some((m) => m.member === b.key), 'control: the leave past the cut counts')
  const sa = await store.openStore(a.dataDir)
  try {
    const core = sa.get({ key: Buffer.from(own.key, 'hex'), writable: false })
    await core.ready()
    await core.clear(cut, leave.seq)
    t.is(core.contiguousLength, cut, 'a sparse copy: a hole at the cut')
    t.ok(await core.has(leave.seq), 'the leave past it is held')
    await core.close()
  } finally {
    await sa.close()
  }
  t.is(await view(), whole, 'the sparse copy folds like the whole one')
})
