'use strict'

// Second part of the dm end-to-end tests (split from dm-e2e.test.js to keep
// each file well under the runner limit): momento reactions. Setup as there,
// through helpers/dm-e2e.js.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { stoppedOf } = require('./helpers/session')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const dmCore = require('@varanda/core/lib/dm')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { MOMENT_TTL_MS, MOMENT_SKEW_MS } = require('@varanda/core/lib/moments')
const { hex, seederHost, memberNode, rawDm, takeStamps, dropOf, png, rejection, push, wallet } = require('./helpers/dm-e2e')

// Runs fn with Date.now moved `ms` ahead (every node here shares the clock).
async function later (ms, fn) {
  const realNow = Date.now
  Date.now = () => realNow() + ms
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

// Once-runs of `n` until ready() answers true.
async function caughtUp (t, n, host, ready) {
  for (let i = 0; i < 10 && !(await ready()); i++) {
    const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
    await stoppedOf(n.web.events, runId)
  }
  t.ok(await ready(), 'caught up through the seeder')
}

async function momentOf (n) {
  const item = await n.node.momentPutMedia({ bytes: png(1000), mime: 'image/png', width: 64, height: 48 })
  return n.web.request('moment.create', { text: 'agora', media: item })
}

test('dm moment reaction end to end: sent only to a showing momento, filed with its seq, previewed, retried with the same drops', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  let offline = false
  const A = await memberNode(t, assoc, host, { blob, offline: () => offline })
  const B = await memberNode(t, assoc, host, { blob })
  const m1 = await momentOf(B)
  const m2 = await momentOf(B)
  const m3 = await momentOf(B)
  await B.web.request('moment.delete', { to: m3.ref })
  const post = await B.web.request('post.create', { text: 'publicação' })
  // A follows B and reads B's momentos through the seeder.
  await push(t, B, host)
  await A.web.request('follow.add', { key: B.key })
  await caughtUp(t, A, host, () => A.web.request('moment.lookup', { author: B.key, seq: m2.seq }).then(() => true, () => false))
  const refusal = async (params) => {
    const err = await rejection(A.web.request('dm.send', params))
    return err === null ? null : [err.code, err.message]
  }

  // A plain message through the same path carries no moment key.
  const plain = await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.absent('moment' in (await A.web.request('dm.thread', { peer: B.key })).messages.find((m) => m.id === plain.id), 'a plain row has no moment')
  t.is((await B.web.request('dm.pull')).added, 1)
  t.absent('moment' in (await B.web.request('dm.thread', { peer: A.key })).messages[0])

  // A momento not showing here: refused before anything is signed or stamped.
  const w0 = await wallet(A.storage)
  const NOT_FOUND = ['USAGE', 'momento não encontrado']
  t.alike(await refusal({ to: B.key, text: '❤️', moment: m3.seq }), NOT_FOUND, 'a deleted momento')
  t.alike(await refusal({ to: B.key, text: '❤️', moment: post.seq }), NOT_FOUND, 'a post')
  t.alike(await refusal({ to: B.key, text: '❤️', moment: post.seq + 50 }), NOT_FOUND, 'an unknown seq')
  await later(MOMENT_TTL_MS + 1000, async () => {
    t.alike(await refusal({ to: B.key, text: '❤️', moment: m1.seq }), NOT_FOUND, 'an expired momento')
  })
  await later(-(MOMENT_SKEW_MS + 60000), async () => {
    t.alike(await refusal({ to: B.key, text: '❤️', moment: m1.seq }), NOT_FOUND, 'a momento too far in the future')
  })
  t.alike(await refusal({ to: A.key, text: '❤️', moment: m1.seq }), ['USAGE', 'não é possível enviar para si'], 'self keeps its refusal')
  t.is(await wallet(A.storage), w0, 'nothing stamped')
  t.is((await B.web.request('dm.pull')).added, 0, 'nothing put')

  const sent = await A.web.request('dm.send', { to: B.key, text: '❤️', moment: m1.seq })
  t.alike(Object.keys(sent), ['id', 'at'])
  t.is(await wallet(A.storage), w0 - 2, 'two stamps, as a message')
  t.is((await B.web.request('dm.pull')).added, 1, 'B files the reaction')
  const conv = (await B.web.request('dm.list', { folder: 'request' })).conversations.find((c) => c.peer === A.key)
  t.ok(conv, 'from a peer B does not follow: a request')
  t.is(conv.preview, 'Reagiu a um momento ❤️')
  t.ok(conv.preview.startsWith('Reagiu a um momento'))
  t.is(conv.unread, true, 'the thread is unread')
  const atB = (await B.web.request('dm.thread', { peer: A.key })).messages.find((m) => m.id === sent.id)
  t.alike([atB.text, atB.moment, atB.mine, atB.media, atB.card, atB.replyTo, atB.fwd], ['❤️', m1.seq, false, null, null, null, 0], 'filed with its seq')
  const atA = (await A.web.request('dm.thread', { peer: B.key })).messages.find((m) => m.id === sent.id)
  t.alike([atA.moment, atA.mine], [m1.seq, true], 'the own copy too')
  t.is((await A.web.request('dm.list', {})).conversations.find((c) => c.peer === B.key).preview, 'Reagiu a um momento ❤️')

  // The same emoji to another momento is another message.
  const sent2 = await A.web.request('dm.send', { to: B.key, text: '❤️', moment: m2.seq })
  t.not(sent2.id, sent.id)
  t.is((await B.web.request('dm.pull')).added, 1)
  const reacted = (await B.web.request('dm.thread', { peer: A.key })).messages.filter((m) => m.moment !== undefined)
  t.alike(reacted.map((m) => m.moment), [m1.seq, m2.seq], 'one message per momento')

  // An uncertain send, then the user's retry with the same params: the
  // stamped drops of the first are put, no new stamps.
  const w1 = await wallet(A.storage)
  offline = true
  t.ok(await refusal({ to: B.key, text: '😂', moment: m1.seq }) !== null, 'the seeder is unreachable')
  offline = false
  t.is(await wallet(A.storage), w1 - 2, 'the first try stamped its drops')
  const retried = await A.web.request('dm.send', { to: B.key, text: '😂', moment: m1.seq })
  t.is(await wallet(A.storage), w1 - 2, 'the retry put the same drops')
  t.is((await B.web.request('dm.pull')).added, 1, 'filed once')
  t.is((await B.web.request('dm.thread', { peer: A.key })).messages.find((m) => m.id === retried.id).moment, m1.seq)

  // Another momento is another send, never the pending one.
  offline = true
  t.ok(await refusal({ to: B.key, text: '😮', moment: m1.seq }) !== null)
  offline = false
  const other = await A.web.request('dm.send', { to: B.key, text: '😮', moment: m2.seq })
  t.is(await wallet(A.storage), w1 - 6, 'new stamps for the other momento')
  t.is((await B.web.request('dm.pull')).added, 1)
  t.is((await B.web.request('dm.thread', { peer: A.key })).messages.find((m) => m.id === other.id).moment, m2.seq, 'it names its own momento')

  // A pending send resumes after its momento is gone; a new one is refused.
  offline = true
  t.ok(await refusal({ to: B.key, text: '🔥', moment: m2.seq }) !== null)
  offline = false
  await B.web.request('moment.delete', { to: m2.ref })
  await push(t, B, host)
  await caughtUp(t, A, host, () => A.web.request('moment.lookup', { author: B.key, seq: m2.seq }).then(() => false, () => true))
  t.alike(await refusal({ to: B.key, text: '👏', moment: m2.seq }), NOT_FOUND, 'a new send to the deleted momento')
  const resumed = await A.web.request('dm.send', { to: B.key, text: '🔥', moment: m2.seq })
  t.is((await B.web.request('dm.pull')).added, 1, 'the pending one is put')
  t.is((await B.web.request('dm.thread', { peer: A.key })).messages.find((m) => m.id === resumed.id).moment, m2.seq)

  // Blocked keeps its refusal.
  await A.web.request('dm.set', { peer: B.key, state: 'blocked' })
  t.alike(await refusal({ to: B.key, text: '❤️', moment: m1.seq }), ['USAGE', 'você bloqueou esta pessoa'], 'blocked keeps its refusal')

  // A peer with a showing momento and no dm-key keeps its refusal too.
  const D = await memberNode(t, assoc, host, { blob, enable: false })
  await push(t, D, host)
  const md = await momentOf(D)
  await push(t, D, host)
  await A.web.request('dm.set', { peer: B.key, state: 'unblocked' })
  await A.web.request('follow.add', { key: D.key })
  await caughtUp(t, A, host, () => A.web.request('moment.lookup', { author: D.key, seq: md.seq }).then(() => true, () => false))
  const noKey = await refusal({ to: D.key, text: '❤️', moment: md.seq })
  t.ok(noKey !== null, 'refused')
  t.alike(noKey, await refusal({ to: D.key, text: 'oi' }), 'no dm-key keeps the dm.send refusal')
})

// A page diary owned by `owner` (block 0 its certificate, a roster, its
// dm-key), held by `owner` as a stored replica, its gen 1 secrets adopted
// there -> { page, box }.
async function heldPage (t, assoc, owner) {
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const pageKp = crypto.keyPair()
  const page = hex(pageKp.publicKey)
  const ownBox = hex((await dmBoxKeyPairFromPrf(owner.prf, 1)).publicKey)
  const made = await owner.web.request('dm.pageGenerate', { page, gen: 1, recipients: [{ member: owner.key, box: ownBox }] })
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: page }, assoc.kp))
  const at = new Date().toISOString()
  const fields = { page, gen: 1, owner: owner.key, admins: [], prev: null, at, nonce: 'r'.repeat(43), association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, owner.keyPair) }, issuerKp, issuerCert))
  await m.core.append({ type: 'dm-key', box: made.box, gen: 1, at })
  const dst = await store.openReplica(owner.storage, m.key)
  const a = m.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    await dst.download({ start: 0, end: m.core.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
  const sh = made.shares[0]
  await owner.web.request('dm.pageSecrets', { page, gen: 1, sealed: sh.sealed, by: owner.key, sig: sh.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc.kp) })
  return { page, box: made.box }
}

test('a moment reaction sealed to a Página box is never filed, and the pull goes on past it', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)
  const A = await memberNode(t, assoc, host)
  const C = await memberNode(t, assoc, host)
  const { page, box } = await heldPage(t, assoc, A)
  const ch = await rawDm(t, host.url)
  const put = async (fields) => {
    const sealed = dmCore.sealInner(dmCore.buildInner({ kind: 'msg', id: dmCore.newMessageId(), to: page, replyTo: null, cert: C.cert, ...fields }, C.keyPair), box)
    const [stamp] = await takeStamps(C, 1)
    t.alike(await ch.put(dropOf(sealed, stamp)), { ok: true, reason: null }, 'the pool takes the drop')
  }
  await put({ text: '❤️', moment: 1 })
  await put({ text: 'para a página' })
  await A.web.request('dm.pull')
  const th = await A.web.request('dm.thread', { page, peer: C.key })
  t.alike(th.messages.map((m) => m.text), ['para a página'], 'only the message after it is filed')
  t.absent(th.messages.some((m) => m.moment !== undefined), 'no moment row in the page conversation')
})
