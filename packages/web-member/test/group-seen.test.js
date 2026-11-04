'use strict'

// The browser node's group seen marks (rpc.md 5.59 last/unread rows, 5.82
// group.seen, kv groupSeen in lib/node-store.js). Mirrors the core node's
// group-seen tests; cores move between storages by direct replication.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')

async function setup (t, { assoc = generateAssociationKeyPair(), name = 'Ana' } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  await ops.profileSet(ctx, { name, bio: '' })
  return { ctx, key, assoc, storage, prf }
}

async function share (from, to, keys) {
  for (const key of [from.key, ...keys]) {
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
    if (!diary) await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

// Ana creates the community; Bia joins it and Geral, and her writers reach Ana.
async function world (t) {
  const a = await setup(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  await share(a, b, [community, general])
  await ops.communityJoin(b.ctx, { community })
  const bw = await ownWriter(b, general)
  await share(b, a, [await ownWriter(b, community), bw])
  return { a, b, community, general, bw }
}

async function row (s, community, group) {
  return (await ops.communityInfo(s.ctx, { community })).groups.find((g) => g.group === group)
}

// Every kv write of `s` from now on.
function spyWrites (s) {
  const writes = []
  const writeJson = s.storage.writeJson.bind(s.storage)
  s.storage.writeJson = (k, v) => { writes.push(k); return writeJson(k, v) }
  return writes
}

const mark = (group, seq = 1, at = '2026-01-01T00:00:00.000Z', writer = 'ab'.repeat(32)) => ({ group, at, writer, seq })

test('kv groupSeen: valid marks only, one per group, newest last, at most 512', async (t) => {
  const s = await setup(t)
  t.alike(await store.readGroupSeen(s.storage), [], 'empty')
  await s.storage.writeJson('groupSeen', { v: 2, marks: [mark('aa'.repeat(32))] })
  t.alike(await store.readGroupSeen(s.storage), [], 'another version reads as empty')
  const g1 = 'a1'.repeat(32)
  const g2 = 'a2'.repeat(32)
  await store.writeGroupSeen(s.storage, [
    mark(g1, 1),
    mark('A1'.repeat(32)),
    mark(g2, -1),
    mark('a3'.repeat(32), 0),
    mark(g2, 1.5),
    { ...mark(g2), at: '2026-01-01' },
    { ...mark(g2), writer: 'xyz' },
    null,
    mark(g2, 3),
    mark(g1, 2)
  ])
  t.alike(await store.readGroupSeen(s.storage), [mark(g2, 3), mark(g1, 2)], 'the last mark of a group kept, at its place')
  t.alike(await s.storage.readJson('groupSeen'), { v: 1, marks: [mark(g2, 3), mark(g1, 2)] }, 'only keys, an ISO and a seq')
  t.is(store.MAX_GROUP_SEEN, 512)
  const many = []
  for (let i = 0; i < 520; i++) many.push(mark(i.toString(16).padStart(64, '0'), i + 1))
  await store.writeGroupSeen(s.storage, many)
  const kept = await store.readGroupSeen(s.storage)
  t.is(kept.length, 512)
  t.alike([kept[0].seq, kept[511].seq], [9, 520], 'the least recently marked dropped first')
})

test('community.info rows: last and unread for readers, causal order, own and hidden not counted', async (t) => {
  const { a, b, community, general, bw } = await world(t)
  t.alike(await row(a, community, general), { group: general, name: 'Geral', visibility: 'public', join: 'open', role: 'creator', general: true, last: null, unread: 0 }, 'no post yet')

  await ops.groupPost(a.ctx, { group: general, text: 'oi' })
  let r = await row(a, community, general)
  t.alike({ ...r.last, at: null }, { name: 'Ana', username: null, preview: 'oi', at: null, mine: true, hidden: false })
  t.ok(typeof r.last.at === 'string' && new Date(r.last.at).toISOString() === r.last.at, 'a canonical ISO')
  t.is(r.unread, 0, 'own posts are never unread')

  const long = '😀'.repeat(150)
  await share(a, b, [general])
  await ops.groupPost(b.ctx, { group: general, text: 'um' })
  await ops.groupPost(b.ctx, { group: general, text: long })
  await share(b, a, [bw])
  r = await row(a, community, general)
  t.alike([r.last.name, r.last.mine, r.last.preview], ['Bia', false, '😀'.repeat(140)], 'preview cut to 140 code points')
  t.is(r.unread, 3 - 1, 'no mark: every post of others')

  await ops.groupHide(a.ctx, { group: general, target: { writer: bw, seq: 2 }, on: true })
  r = await row(a, community, general)
  t.alike([r.last.preview, r.last.hidden, r.unread], ['', true, 1], 'a hidden newest post: empty preview, not counted')

  t.alike(await row(b, community, general).then((x) => [x.role, x.last.mine, x.unread]), ['member', true, 1], 'the member: its own post is newest, Ana\'s is unread')
  const info = await ops.communityInfo(b.ctx, { community })
  t.ok(info.groups.every((g) => 'last' in g && 'unread' in g))
})

test('group.seen: marks the newest post, forward only, write only on change', async (t) => {
  const { a, b, community, general, bw } = await world(t)
  let writes = spyWrites(a)
  t.alike(await ops.groupSeen(a.ctx, { group: general }), { ok: true }, 'no readable post')
  t.alike(writes, [], 'nothing written')
  t.alike(await store.readGroupSeen(a.storage), [])

  for (const text of ['um', 'dois', 'tres']) await ops.groupPost(b.ctx, { group: general, text })
  await share(b, a, [bw])
  t.is((await row(a, community, general)).unread, 3)
  t.alike(await ops.groupSeen(a.ctx, { group: general }), { ok: true })
  const first = await store.readGroupSeen(a.storage)
  t.is(first.length, 1)
  t.alike({ ...first[0], at: null }, { group: general, at: null, writer: bw, seq: 3 }, 'the newest post')
  t.is((await row(a, community, general)).unread, 0)

  writes = spyWrites(a)
  t.alike(await ops.groupSeen(a.ctx, { group: general }), { ok: true })
  t.alike(writes, [], 'a repeat writes nothing')

  await ops.groupPost(b.ctx, { group: general, text: 'quatro' })
  await ops.groupPost(a.ctx, { group: general, text: 'minha' })
  await share(b, a, [bw])
  t.is((await row(a, community, general)).unread, 1, 'after the marked post, own excluded')

  // A mark on a post no longer listed: the group order decides.
  const ahead = { group: general, at: '2999-01-01T00:00:00.000Z', writer: 'ee'.repeat(32), seq: 9 }
  await store.writeGroupSeen(a.storage, [ahead])
  t.is((await row(a, community, general)).unread, 0, 'nothing above an unlisted mark ahead of every post')
  writes = spyWrites(a)
  await ops.groupSeen(a.ctx, { group: general })
  t.alike(writes, [], 'a mark ahead is never moved backward')
  t.alike(await store.readGroupSeen(a.storage), [ahead])

  const behind = { ...ahead, at: '2000-01-01T00:00:00.000Z' }
  await store.writeGroupSeen(a.storage, [behind])
  t.is((await row(a, community, general)).unread, 4, 'every post above an unlisted mark behind them')
  await ops.groupSeen(a.ctx, { group: general })
  const moved = await store.readGroupSeen(a.storage)
  const newest = (await ops.groupRead(a.ctx, { group: general, limit: 1 })).items[0]
  t.alike(moved, [{ group: general, at: newest.at, writer: newest.writer, seq: newest.seq }], 'moved forward to the newest post, own included')
  t.is((await row(a, community, general)).unread, 0)
})

test('group.seen: the cap drops the least recently marked, which then counts as never seen', async (t) => {
  const { a, b, community, general, bw } = await world(t)
  await ops.groupPost(b.ctx, { group: general, text: 'um' })
  await share(b, a, [bw])
  await ops.groupSeen(a.ctx, { group: general })
  t.is((await row(a, community, general)).unread, 0)
  const others = []
  for (let i = 0; i < 512; i++) others.push(mark(i.toString(16).padStart(64, '0'), i + 1))
  await store.writeGroupSeen(a.storage, [...await store.readGroupSeen(a.storage), ...others])
  t.absent((await store.readGroupSeen(a.storage)).some((m) => m.group === general), 'dropped')
  t.is((await row(a, community, general)).unread, 1, 'counted as never seen')
})

test('unread stops at 99', async (t) => {
  const { a, b, community, general, bw } = await world(t)
  for (let i = 0; i < 100; i++) await ops.groupPost(b.ctx, { group: general, text: 'm' + i })
  await share(b, a, [bw])
  t.is((await row(a, community, general)).unread, 99)
})

test('rows of non-readers and unheld roots answer last null, unread 0; reads never write', async (t) => {
  const { a, b, community, general, bw } = await world(t)
  await ops.groupPost(b.ctx, { group: general, text: 'um' })
  await share(b, a, [bw])
  const c = await setup(t, { assoc: a.assoc, name: 'Caio' })
  await share(a, c, [community, general, bw])
  await share(b, c, [])
  const r = await row(c, community, general)
  t.alike([r.role, r.last, r.unread], ['left', null, 0], 'a diary that never joined')

  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  await share(a, b, [community])
  const writes = spyWrites(b)
  const unheld = await row(b, community, horta)
  t.alike([unheld.name, unheld.last, unheld.unread], [null, null, 0], 'an unheld root')
  t.alike(writes, [], 'community.info writes nothing')
})

test('group.seen: pending, unknown and malformed roots', async (t) => {
  const { b, community } = await world(t)
  const pending = 'cd'.repeat(32)
  t.alike(await ops.groupJoin(b.ctx, { group: pending, community }), { state: 'pending' })
  const writes = spyWrites(b)
  t.alike(await ops.groupSeen(b.ctx, { group: pending }), { ok: true }, 'a pending own root')
  t.alike(writes, [], 'nothing written')
  await t.exception(() => ops.groupSeen(b.ctx, { group: 'ef'.repeat(32) }), /grupo não encontrado/, 'unknown')
  // As every group operation here: the rpc layer refuses a malformed key first.
  await t.exception(() => ops.groupSeen(b.ctx, { group: 'xyz' }), /chave inválida/, 'malformed')
})

test('deleteGroupData removes kv groupSeen', async (t) => {
  const s = await setup(t)
  await store.writeGroupSeen(s.storage, [mark('a1'.repeat(32))])
  await store.deleteGroupData(s.storage)
  t.is(await s.storage.readJson('groupSeen'), null)
  t.alike(await store.readGroupSeen(s.storage), [])
})

test('a private group: no preview while locked or never opened, the preview once unlocked', async (t) => {
  const { a, community } = await world(t)
  a.ctx.groupKeys = createGroupKeys()
  await a.ctx.groupKeys.unlock(a.storage, new Uint8Array(a.prf))
  const { group: priv } = await ops.groupCreate(a.ctx, { name: 'Segredo', join: 'approval', visibility: 'private', community })
  const secret = 'texto-secreto-' + hex(crypto.randomBytes(8))
  await ops.groupPost(a.ctx, { group: priv, text: secret })
  const open = await row(a, community, priv)
  t.alike([open.last.preview, open.last.mine, open.unread], [secret, true, 0], 'unlocked: the preview')
  await ops.groupSeen(a.ctx, { group: priv })
  const marked = await store.readGroupSeen(a.storage)

  for (const [label, keys] of [['locked', () => { a.ctx.groupKeys.lock(); return a.ctx.groupKeys }], ['never opened', () => createGroupKeys()]]) {
    a.ctx.groupKeys = keys()
    const info = await ops.communityInfo(a.ctx, { community })
    const r = info.groups.find((g) => g.group === priv)
    t.alike([r.last, r.unread], [null, 0], label)
    t.absent(JSON.stringify(info).includes(secret), label + ': no plaintext')
    const writes = spyWrites(a)
    t.alike(await ops.groupSeen(a.ctx, { group: priv }), { ok: true }, label + ': nothing readable')
    t.alike(writes, [], label + ': nothing written')
  }
  t.alike(await store.readGroupSeen(a.storage), marked)
})
