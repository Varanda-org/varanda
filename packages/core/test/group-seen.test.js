'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const member = require('../lib/member')
const store = require('../lib/store')
const { exchange, entryOf, rejects, world } = require('./helpers/community-member')

const seenFile = (ctx) => path.join(ctx.dataDir, 'group-seen.json')

async function rowOf (ctx, community, group) {
  return (await member.communityInfo(ctx, { community })).groups.find((g) => g.group === group)
}

function writeMarks (ctx, marks) {
  fs.writeFileSync(seenFile(ctx), JSON.stringify({ v: 1, marks }))
}

test('community.info: last and unread per group, group.seen marks the newest post', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  t.alike(await rowOf(a, community, geral), { group: geral, name: 'Geral', visibility: 'public', join: 'open', role: 'creator', general: true, last: null, unread: 0 })
  t.absent(fs.existsSync(seenFile(a)), 'community.info creates no file')

  await member.groupPost(a, { group: geral, text: 'oi de Ana' })
  const own = await rowOf(a, community, geral)
  t.is(own.last.mine, true)
  t.is(own.last.preview, 'oi de Ana')
  t.is(own.last.hidden, false)
  t.is(own.unread, 0, 'own posts are never unread')

  await exchange(a, b)
  const foreign = await rowOf(b, community, geral)
  t.is(foreign.unread, 1)
  t.alike({ ...foreign.last, at: null }, { name: 'Ana', username: null, preview: 'oi de Ana', at: null, mine: false, hidden: false })
  t.ok(typeof foreign.last.at === 'string' && new Date(foreign.last.at).toISOString() === foreign.last.at)
  t.absent(fs.existsSync(seenFile(b)), 'still no file after reads')

  t.alike(await member.groupSeen(b, { group: geral }), { ok: true })
  t.is((await rowOf(b, community, geral)).unread, 0)
  const stat = fs.statSync(seenFile(b))
  t.is(stat.mode & 0o777, 0o600)
  const raw = fs.readFileSync(seenFile(b), 'utf8')
  t.absent(raw.includes('oi de Ana'), 'the file holds no post text')
  const data = JSON.parse(raw)
  t.is(data.v, 1)
  t.alike(data.marks.map((m) => Object.keys(m).sort()), [['at', 'group', 'seq', 'writer']])
  t.alike([data.marks[0].group, data.marks[0].writer, data.marks[0].seq], [geral, entryOf(a, geral).writer, 1])
  t.alike(await member.groupSeen(b, { group: geral }), { ok: true })
  const again = fs.statSync(seenFile(b))
  t.alike([again.ino, again.mtimeMs], [stat.ino, stat.mtimeMs], 'an unchanged mark is not written again')

  await member.groupPost(a, { group: geral, text: 'segunda' })
  await exchange(a, b)
  t.is((await rowOf(b, community, geral)).unread, 1, 'a later post is unread')

  const { seq } = await member.groupPost(b, { group: geral, text: 'de Bia' })
  await exchange(b, a)
  t.is((await rowOf(a, community, geral)).unread, 1, 'no mark counts every foreign post')
  await member.groupHide(a, { group: geral, target: { writer: entryOf(b, geral).writer, seq }, on: true })
  const hidden = await rowOf(a, community, geral)
  t.is(hidden.last.hidden, true)
  t.is(hidden.last.preview, '')
  t.is(hidden.last.name, 'Bia')
  t.is(hidden.unread, 0, 'a hidden post is not counted')

  await rejects(t, member.groupSeen(a, { group: 'ab'.repeat(32) }), 'grupo não encontrado', 'NOT_FOUND')
  await rejects(t, member.groupSeen(a, { group: 'x' }), 'grupo não encontrado', 'NOT_FOUND')
  t.absent(fs.existsSync(seenFile(a)), 'an unknown key writes no mark')
})

test('community.info: no last for a non-reader, nothing sealed leaks', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const { group: feira } = await member.groupCreate(a, { name: 'Feira', join: 'open', community })
  await member.groupPost(a, { group: feira, text: 'feira aberta' })
  const { group: segredo } = await member.groupCreate(a, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  await member.groupPost(a, { group: segredo, text: 'texto secreto' })
  t.is((await rowOf(a, community, segredo)).last.preview, 'texto secreto', 'the creator reads it')
  await exchange(a, b)
  t.is((await member.groupRead(b, { group: feira })).items.length, 1, 'the public post is visible to b')
  const row = await rowOf(b, community, feira)
  t.alike([row.role, row.last, row.unread], ['left', null, 0])
  const info = await member.communityInfo(b, { community })
  const sealed = info.groups.find((g) => g.group === segredo)
  t.alike([sealed.last, sealed.unread], [null, 0])
  t.absent(JSON.stringify(info).includes('texto secreto'), 'no plaintext of the private group')
})

test('community.info: unread stops at 99, the preview at 140 code points', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  for (let i = 0; i < 99; i++) await member.groupPost(a, { group: geral, text: 'p' + i })
  await member.groupPost(a, { group: geral, text: '\u{1F600}'.repeat(150) })
  await exchange(a, b)
  const row = await rowOf(b, community, geral)
  t.is(row.unread, 99)
  t.is(row.last.preview, '\u{1F600}'.repeat(140))
})

test('group.seen: forward only, malformed files read as none, 512 marks at most', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  await member.groupPost(a, { group: geral, text: 'oi' })
  await exchange(a, b)
  writeMarks(b, [{ group: geral, at: '2099-01-01T00:00:00.000Z', writer: 'ff'.repeat(32), seq: 3 }])
  const before = fs.readFileSync(seenFile(b), 'utf8')
  t.is((await rowOf(b, community, geral)).unread, 0, 'a newer absent mark leaves nothing unread')
  await member.groupSeen(b, { group: geral })
  t.is(fs.readFileSync(seenFile(b), 'utf8'), before, 'a newer stored cursor is not replaced by an older post')

  fs.writeFileSync(seenFile(b), 'not json')
  t.is((await rowOf(b, community, geral)).unread, 1, 'a malformed file reads as no marks')
  writeMarks(b, [{ group: geral, at: null, writer: null, seq: null }])
  t.is((await rowOf(b, community, geral)).unread, 1, 'an invalid mark is dropped')

  const others = []
  for (let i = 0; i < 512; i++) others.push({ group: i.toString(16).padStart(64, '0'), at: '2020-01-01T00:00:00.000Z', writer: 'ee'.repeat(32), seq: 1 })
  writeMarks(b, [{ group: geral, at: '2000-01-01T00:00:00.000Z', writer: 'ee'.repeat(32), seq: 1 }, ...others])
  t.is((await rowOf(b, community, geral)).unread, 1, 'an older absent mark counts the posts after it')
  await member.groupSeen(b, { group: geral })
  const marks = JSON.parse(fs.readFileSync(seenFile(b), 'utf8')).marks
  t.is(marks.length, 512)
  t.is(marks[marks.length - 1].group, geral, 'the updated group moves to the end')
  t.is(marks[0].group, others[1].group, 'the least recently marked is dropped')
  t.is((await rowOf(b, community, geral)).unread, 0)
})

test('group.seen: a cut-off marks exactly that post, never past it, never an unlisted one', async (t) => {
  const { a, others: [b], community, geral } = await world(t, { names: ['Bia'] })
  for (const text of ['um', 'dois', 'tres']) await member.groupPost(a, { group: geral, text })
  await exchange(a, b)
  const items = (await member.groupRead(b, { group: geral })).items
  const mid = items[1]
  const cut = (post, at = '2026-01-01T00:00:00.000Z') => ({ group: geral, upTo: { at, writer: post.writer, seq: post.seq } })
  const markOf = () => JSON.parse(fs.readFileSync(seenFile(b), 'utf8')).marks.filter((m) => m.group === geral)
  const bytes = () => fs.readFileSync(seenFile(b), 'utf8')

  t.alike(await member.groupSeen(b, cut(mid)), { ok: true })
  const row = await rowOf(b, community, geral)
  t.is(row.unread, 1, 'only the post after the cut-off stays unread')
  t.is(row.last.preview, 'tres', 'last is still the newest post')
  const [mark] = markOf()
  t.alike(Object.keys(mark).sort(), ['at', 'group', 'seq', 'writer'])
  t.alike([mark.at, mark.writer, mark.seq], [mid.at, mid.writer, mid.seq], 'the listed post own at, not the passed one')
  const stat = fs.statSync(seenFile(b))
  t.is(stat.mode & 0o777, 0o600)
  t.absent(bytes().includes('dois'), 'the file holds no post text')

  t.alike(await member.groupSeen(b, cut(mid)), { ok: true })
  const again = fs.statSync(seenFile(b))
  t.alike([again.ino, again.mtimeMs], [stat.ino, stat.mtimeMs], 'the same cut-off is not written again')

  const settled = bytes()
  t.alike(await member.groupSeen(b, cut(items[2])), { ok: true })
  t.is(bytes(), settled, 'an older cut-off does not move the mark back')

  t.alike(await member.groupSeen(b, { group: geral, upTo: { at: mid.at, writer: 'ff'.repeat(32), seq: 7 } }), { ok: true })
  t.alike(await member.groupSeen(b, { group: geral, upTo: { at: mid.at, writer: mid.writer, seq: 99 } }), { ok: true })
  t.is(bytes(), settled, 'an unlisted cut-off writes nothing')
  t.is((await rowOf(b, community, geral)).unread, 1)

  writeMarks(b, [{ group: geral, at: '2099-01-01T00:00:00.000Z', writer: 'ff'.repeat(32), seq: 3 }])
  const ahead = bytes()
  await member.groupSeen(b, cut(items[0], '3999-01-01T00:00:00.000Z'))
  t.is(bytes(), ahead, 'the listed at is compared, not the caller one')

  writeMarks(b, [{ group: geral, at: '2000-01-01T00:00:00.000Z', writer: 'ee'.repeat(32), seq: 3 }])
  await member.groupSeen(b, cut(mid))
  t.alike(markOf().map((m) => [m.at, m.writer, m.seq]), [[mid.at, mid.writer, mid.seq]], 'an unlisted mark behind everything moves to the cut-off, not the newest')

  const { seq } = await member.groupPost(b, { group: geral, text: 'escondida' })
  await exchange(b, a)
  await member.groupHide(a, { group: geral, target: { writer: entryOf(b, geral).writer, seq }, on: true })
  await exchange(a, b)
  const hiddenPost = (await member.groupRead(b, { group: geral })).items[0]
  t.is(hiddenPost.seq, seq)
  await member.groupSeen(b, cut(hiddenPost))
  t.alike(markOf().map((m) => [m.writer, m.seq]), [[hiddenPost.writer, seq]], 'a hidden post can be the cut-off')

  const own = await member.groupPost(b, { group: geral, text: 'de Bia' })
  await exchange(b, a)
  await member.groupPost(a, { group: geral, text: 'quatro' })
  await exchange(a, b)
  const ownItem = (await member.groupRead(b, { group: geral })).items.find((i) => i.writer === entryOf(b, geral).writer && i.seq === own.seq)
  await member.groupSeen(b, cut(ownItem))
  t.alike(markOf().map((m) => [m.writer, m.seq]), [[ownItem.writer, own.seq]], 'an own post can be the cut-off')
  t.is((await rowOf(b, community, geral)).unread, 1, 'only quatro is unread')

  t.alike(await member.groupSeen(b, { group: geral }), { ok: true })
  t.is((await rowOf(b, community, geral)).unread, 0, 'no cut-off marks the newest')
})

test('group.seen: a cut-off for an unknown or not yet held group writes nothing', async (t) => {
  const { a, others: [b], community } = await world(t, { names: ['Bia'] })
  const upTo = { at: '2026-01-01T00:00:00.000Z', writer: 'cd'.repeat(32), seq: 1 }
  await rejects(t, member.groupSeen(b, { group: 'ab'.repeat(32), upTo }), 'grupo não encontrado', 'NOT_FOUND')
  t.absent(fs.existsSync(seenFile(b)), 'an unknown group creates no file')

  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  await store.purgeReplica(s, group)
  await s.close()
  t.alike(await member.groupJoin(b, { group, community }), { state: 'pending' })
  t.alike(await member.groupSeen(b, { group, upTo }), { ok: true })
  t.absent(fs.existsSync(seenFile(b)), 'a pending group writes no file')
})
