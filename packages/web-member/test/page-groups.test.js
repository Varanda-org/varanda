'use strict'

// A Página's private groups folded with the page's group box (docs/rpc.md
// 5.114), from local copies only (no socket): a person A creates a private
// group, the page's diary P joins it with a writer whose header box is the
// page's group box (P's member-ops device stands in for the account
// service), and an admin identity B that holds the page secrets reads and
// seals as the page through ./page-groups.js.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const gc = require('@varanda/core/lib/group-crypto')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys } = require('../lib/group-keys')
const { createPageGroupKeys } = require('../lib/page-groups')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
const REKEY_PENDING = 'aguardando nova chave'

async function holder (t, storage, prf) {
  const h = createGroupKeys()
  await h.unlock(storage, prf)
  t.teardown(() => h.close())
  return h
}

async function setup (t, { assoc = generateAssociationKeyPair(), name = 'Ana' } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys: await holder(t, storage, prf) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  await ops.profileSet(ctx, { name, bio: '' })
  return { ctx, key, assoc, storage, prf }
}

async function pipe (source, target) {
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

async function copyCore (from, to, key) {
  await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
  await store.addGroupReplica(to.storage, key)
}

// Copies `from`'s diary and the group cores `keys` (held by `from`) to `to`.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) await copyCore(from, to, key)
  await store.addGroupDiary(to.storage, from.key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function writerHeader (s, key) {
  const core = await store.openGroupCoreReadOnly(s.storage, key)
  try {
    return (await store.readAll(core))[0].record
  } finally {
    await core.close()
  }
}

function copyPair (pair) {
  return { publicKey: b4a.from(pair.publicKey), secretKey: b4a.from(pair.secretKey) }
}

// A: a community and a private open group with a post; P (the page) joins
// with a writer boxed to its group box and A hands it the epoch; B: an
// admin identity holding copies of it all and the page's group box.
async function world (t) {
  const a = await setup(t)
  const p = await setup(t, { assoc: a.assoc, name: 'Padaria' })
  const b = await setup(t, { assoc: a.assoc, name: 'Bia' })
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Conselho', join: 'open', visibility: 'private', community })
  await ops.groupPost(a.ctx, { group, text: 'só para o conselho' })
  await share(a, p, [community, general, group])
  await ops.communityJoin(p.ctx, { community })
  t.is((await ops.groupJoin(p.ctx, { group })).state, 'requested')
  const pw = await ownWriter(p, group)
  await share(p, a, [await ownWriter(p, community), await ownWriter(p, general), pw])
  await ops.groupAdmit(a.ctx, { group, member: p.key, on: true })
  await ops.groupPost(a.ctx, { group, text: 'bem-vinda, padaria' })
  const pageBox = copyPair(p.ctx.groupKeys.boxKeyPair())
  let box = pageBox
  const pageKeys = createPageGroupKeys({ groupBoxOf: (page) => page === p.key ? box : null })
  t.teardown(() => pageKeys.lock())
  const asPage = { ...b.ctx, groupKeys: pageKeys.holderFor(p.key) }
  const refresh = async () => {
    await share(a, b, [community, general, group])
    await share(p, b, [await ownWriter(p, community), await ownWriter(p, general), await ownWriter(p, group)])
  }
  await refresh()
  return { a, p, b, community, general, group, pw, pageBox, pageKeys, asPage, refresh, setBox: (pair) => { box = pair } }
}

test('an admin holding the page secrets reads the private group as the page and seals for its writer', async (t) => {
  const { a, p, b, group, pw, pageBox, pageKeys, asPage } = await world(t)
  t.is((await writerHeader(p, pw)).box, hex(pageBox.publicKey), 'the page writer is boxed to the group box')

  const r = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.alike(r.items.map((x) => [x.diary, x.text]), [[a.key, 'bem-vinda, padaria'], [a.key, 'só para o conselho']])
  t.is(r.state, 'ok')
  t.is(r.role, 'member', 'the page\'s role')
  t.ok(r.epoch !== null)
  t.is(b.ctx.groupKeys.size, 0, 'no page epoch key in the identity\'s own holder')
  t.ok(pageKeys.size > 0, 'the page epochs stay in the page holder')
  t.alike((await ops.groupRead(b.ctx, { group })).items, [], 'the identity\'s own fold reads nothing sealed')

  const s = await ops.pageGroupSeal(asPage, { group, page: p.key, text: 'pão quente às 7h', replyTo: { writer: group, seq: r.items[0].seq } })
  t.is(s.writer, pw, 'the page\'s live writer of the held box')
  t.alike(s.kid, r.epoch)
  t.is(s.seq, (await store.openGroupCoreReadOnly(b.storage, pw).then(async (c) => { try { return c.length } finally { await c.close() } })))
  t.ok(typeof s.at === 'string')
  const key = pageKeys.holderFor(p.key).get(s.kid)
  const inner = gc.openRecord({ nonce: s.nonce, box: s.box }, key)
  t.is(inner.type, 'group-post')
  t.is(inner.text, 'pão quente às 7h')
  t.alike([inner.writer, inner.group, inner.kid], [pw, group, s.kid])
  t.is(inner.at, s.at)
  t.is((await writerHeader(b, inner.writer)).box, hex(pageBox.publicKey), 'opens for the writer under the page box')

  // The service would append it; nothing was written anywhere.
  t.is(await ownWriter(b, group), null)

  pageKeys.lock()
  t.is(pageKeys.size, 0, 'wiped at lock')
})

test('without the page secrets nothing folds as the page', async (t) => {
  const { p, b, group } = await world(t)
  const none = createPageGroupKeys({ groupBoxOf: () => null })
  t.is(none.holds(p.key), false)
  const r = await ops.pageGroupRead({ ...b.ctx, groupKeys: none.holderFor(p.key) }, { group, page: p.key })
  t.is(r.state, 'locked')
  t.alike(r.items, [])
  await t.exception(ops.pageGroupSeal({ ...b.ctx, groupKeys: none.holderFor(p.key) }, { group, page: p.key, text: 'oi' }))
})

test('a root not held here folds to null', async (t) => {
  const { p, asPage } = await world(t)
  t.is(await ops.pageGroupRead(asPage, { group: 'cd'.repeat(32), page: p.key }), null)
  t.is(await ops.pageGroupSeal(asPage, { group: 'cd'.repeat(32), page: p.key, text: 'oi' }), null)
})

test('after a rebox the seal waits for a new epoch, which the old group box cannot open', async (t) => {
  const w = await world(t)
  const { a, p, b, group, pw, pageBox, pageKeys, asPage, refresh } = w
  // The rebox: the old writer leaves, a writer boxed to a new group box joins.
  t.is((await ops.groupLeave(p.ctx, { group })).state, 'left')
  const newPrf = crypto.randomBytes(32)
  p.ctx.groupKeys = await holder(t, p.storage, newPrf)
  t.is((await ops.groupJoin(p.ctx, { group })).state, 'requested')
  const nw = await ownWriter(p, group)
  t.not(nw, pw)
  const newBox = copyPair(p.ctx.groupKeys.boxKeyPair())
  t.is((await writerHeader(p, nw)).box, hex(newBox.publicKey))
  // Admitted again: the admit hands the history only, no epoch covers the
  // old writer's leave yet.
  await share(p, a, [pw, nw])
  await share(p, b, [pw])
  await ops.groupAdmit(a.ctx, { group, member: p.key, on: true })
  await refresh()
  w.setBox(newBox)

  const before = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.is(before.role, 'member')
  t.is(before.state, 'rekey-pending', 'no eligible epoch covers the new writer')
  const err = await ops.pageGroupSeal(asPage, { group, page: p.key, text: 'oi' }).catch((e) => e)
  t.is(err.message, REKEY_PENDING)

  // The distributor opens a new epoch for the entitled writers.
  await ops.groupRekey(a.ctx, { group })
  await refresh()
  const after = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.is(after.state, 'ok')
  const s = await ops.pageGroupSeal(asPage, { group, page: p.key, text: 'de volta' })
  t.is(s.writer, nw)
  t.alike(s.kid, after.epoch)
  t.is(gc.openRecord({ nonce: s.nonce, box: s.box }, pageKeys.holderFor(p.key).get(s.kid)).text, 'de volta')

  // The old group box: its writer left, and the new epoch never opens for it.
  w.setBox(pageBox)
  const old = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.is(pageKeys.holderFor(p.key).get(after.epoch), null, 'the new epoch is not held under the old box')
  t.absent(old.epoch !== null && old.epoch.writer === after.epoch.writer && old.epoch.seq === after.epoch.seq, 'the old box folds no access to the new epoch')
  const oldErr = await ops.pageGroupSeal(asPage, { group, page: p.key, text: 'oi' }).catch((e) => e)
  t.ok(oldErr instanceof Error, 'the old box seals nothing')
})

test('the admin\'s own identity created the group: the page fold reads its diary and writers too', async (t) => {
  const b = await setup(t, { name: 'Bia' })
  const p = await setup(t, { assoc: b.assoc, name: 'Padaria' })
  const { community, group: general } = await ops.communityCreate(b.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(b.ctx, { name: 'Conselho', join: 'open', visibility: 'private', community })
  await share(b, p, [community, general, group])
  await ops.communityJoin(p.ctx, { community })
  t.is((await ops.groupJoin(p.ctx, { group })).state, 'requested')
  const pw = await ownWriter(p, group)
  await share(p, b, [await ownWriter(p, community), await ownWriter(p, general), pw])
  await ops.groupAdmit(b.ctx, { group, member: p.key, on: true })
  await ops.groupPost(b.ctx, { group, text: 'da criadora' })
  const box = copyPair(p.ctx.groupKeys.boxKeyPair())
  const pageKeys = createPageGroupKeys({ groupBoxOf: (page) => page === p.key ? box : null })
  t.teardown(() => pageKeys.lock())
  const asPage = { ...b.ctx, groupKeys: pageKeys.holderFor(p.key) }
  const r = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.alike(r.items.map((x) => [x.diary, x.text]), [[b.key, 'da criadora']], 'the creator\'s post')
  t.is(r.role, 'member')
  t.is(r.state, 'ok')
  const s = await ops.pageGroupSeal(asPage, { group, page: p.key, text: 'oi' })
  t.is(s.writer, pw)
  t.is(gc.openRecord({ nonce: s.nonce, box: s.box }, pageKeys.holderFor(p.key).get(s.kid)).text, 'oi')
})

test('the admin\'s own identity is a plain member: its writer is folded into the page\'s view', async (t) => {
  const { a, p, b, community, general, group, asPage, refresh } = await world(t)
  await ops.communityJoin(b.ctx, { community })
  t.is((await ops.groupJoin(b.ctx, { group })).state, 'requested')
  const bw = await ownWriter(b, group)
  t.absent((await store.readGroupReplicas(b.storage)).includes(bw), 'in groupWriters only')
  await share(b, a, [await ownWriter(b, community), await ownWriter(b, general), bw])
  await ops.groupAdmit(a.ctx, { group, member: b.key, on: true })
  await refresh()
  await ops.groupPost(b.ctx, { group, text: 'da admin' })
  const r = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.is(r.items[0].diary, b.key)
  t.is(r.items[0].text, 'da admin')
  t.is(r.state, 'ok')
  t.ok(await ops.pageGroupSeal(asPage, { group, page: p.key, text: 'oi' }))
})

test('a page fold reports the visibility of the root header it verified', async (t) => {
  const { p, general, group, asPage } = await world(t)
  const priv = await ops.pageGroupRead(asPage, { group, page: p.key })
  t.is(priv.visibility, 'private')
  const pub = await ops.pageGroupRead(asPage, { group: general, page: p.key })
  t.is(pub.visibility, 'public')
  t.is(pub.state, 'ok')
})
