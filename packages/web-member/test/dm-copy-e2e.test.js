'use strict'

// Copying the conversation history to another device (docs/protocol.md
// section 11): the real Seeder (dm and blob pools, the copy stamp kind)
// behind a WebSocket server and real browser nodes. Device A makes the copy
// on its own, for the newer device A2 of the same passkey, which imports it
// after the seeder's pool lost the original drops (what a sweep does). Local
// DHT and tmp dirs only.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const dmCore = require('@varanda/core/lib/dm')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const { sealBlob } = require('../lib/blob')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode, rawDm, takeStamps, dropOf, png } = require('./helpers/dm-e2e')
const { account, sibling, ownDrops, claimsOf, copiesOf, kick, idle, manifestOf } = require('./helpers/dm-auto')

const BLOB = { wallet: 16, walletLow: 8, issuePaceMs: 0 }

// Copies `from`'s diary into `to`'s storage as a stored replica (what a
// follow or a peek would have read), in process.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

// The seeder restarts with its dm pool emptied, as after the retention
// sweep: the log goes, the sequence high-water mark (seq.json) stays, so a
// cursor a device holds is never ahead of what the pool hands out.
async function sweepPool (host) {
  await host.current.close()
  host.current = null
  const dir = path.join(host.dataDir, 'dm-pool')
  for (const name of fs.readdirSync(dir)) if (name !== 'seq.json') fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  await host.start()
}

function textsOf (thread) {
  return thread.messages.map((m) => m.text).sort()
}

// The old device A of a new account and its newer device A2 (which knows
// its own device id, as the session tells the engine).
async function devicesOf (t, assoc, host, blob) {
  const acct = await account(t, assoc, host, { old: 1, fresh: 1, blob })
  const A2 = await sibling(t, assoc, host, acct, acct.fresh[0], { blob })
  t.is((await A2.web.request('device.list')).self, acct.fresh[0], 'A2 knows its device id')
  return { acct, A: acct.first, A2 }
}

// The seeder answers nothing for blob `id` from now on (what an expired blob
// looks like); a sweep restarts the seeder, so call it after one.
function forget (host, id) {
  const seeder = host.current
  const chunk = seeder.blobChunk.bind(seeder)
  seeder.blobChunk = (x, index) => (x === id ? null : chunk(x, index))
}

test('a history copy made on one device is imported by another of the same passkey', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const { acct, A, A2 } = await devicesOf(t, assoc, host, BLOB)
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  const Q = await memberNode(t, assoc, host, { blob: BLOB })
  for (const [x, y] of [[A, P], [P, A], [A, Q], [Q, A]]) await copyDiary(x, y)

  // A talks to P (a photo, a reply, a reaction, an accept) and to Q, then
  // deletes the conversation with Q. A2 pulls once, early.
  const photo = png(3000)
  await A.web.request('dm.send', { to: P.key, text: 'oi' })
  t.is((await A2.web.request('dm.pull')).added, 1, 'A2 already holds the first message')
  const item = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: P.key })
  const second = await A.web.request('dm.send', { to: P.key, text: 'segunda', media: [item] })
  await P.web.request('dm.pull')
  const reply = await P.web.request('dm.send', { to: A.key, text: 'resposta' })
  await A.web.request('dm.pull')
  await A.web.request('dm.set', { peer: P.key, state: 'accepted' })
  await A.web.request('dm.react', { to: P.key, target: { from: P.key, id: reply.id }, emoji: '❤️' })
  const itemQ = await A.node.dmPutMedia({ bytes: png(2000), mime: 'image/png', width: 64, height: 48, to: Q.key })
  await A.web.request('dm.send', { to: Q.key, text: 'sobre o Q', media: [itemQ] })
  await A.web.request('dm.set', { peer: Q.key, state: 'deleted' })

  // The pool forgets the originals and the seeder the photo's first blob;
  // Q writes again after the delete.
  await sweepPool(host)
  forget(host, item.id)
  await Q.web.request('dm.send', { to: A.key, text: 'nova do Q' })

  await kick(A)
  await idle(t, A)
  const drops = await ownDrops(t, host, acct)
  t.alike(claimsOf(drops).map((c) => c.body.for), [[acct.fresh[0]]], 'one claim, for A2')
  const copies = copiesOf(drops)
  t.is(copies.length, 2, 'the text, then one photo batch')
  const text = await manifestOf(host, copies[0])
  t.is(text.v, 3, 'the text manifest first')
  t.alike(text.for, [acct.fresh[0]], 'it names A2')
  t.alike(text.stores.map((s) => s.page), [null], 'the own store')
  const batch = await manifestOf(host, copies[1])
  t.is(batch.v, 2, 'then the photo batch')
  t.alike(batch.for, [acct.fresh[0]], 'for A2')
  t.alike(batch.photos.map((x) => x.id), [second.id], 'the photo of the deleted conversation stays out')
  const week = JSON.parse(fs.readFileSync(path.join(host.dataDir, 'copy-stamps.json'), 'utf8'))
  t.ok(Object.keys(week).length > 0, 'the seeder counted the copy against its own weekly file')

  // A2 pulls: Q's new message and the pointer. The import files below it.
  const gets = host.blobGets
  const p = await A2.web.request('dm.pull')
  t.is(p.added, 1, 'the pool only holds the new message from Q')
  await until(() => A2.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.is(A2.web.events.find((e) => e.name === 'dm.copyImported').data.messages, 2, 'two messages were new here')
  t.ok(host.blobGets > gets, 'the manifest and parts came from the seeder')

  const withP = await A2.web.request('dm.thread', { peer: P.key })
  t.alike(textsOf(withP), ['oi', 'resposta', 'segunda'], 'no duplicate of the message A2 already held')
  t.is(withP.folder, 'inbox', 'the accept came along')
  const imported = withP.messages.find((m) => m.text === 'resposta')
  t.alike(imported.reactions, [{ emoji: '❤️', mine: true }], 'the reaction came along')
  const withQ = await A2.web.request('dm.thread', { peer: Q.key })
  t.alike(textsOf(withQ), ['nova do Q'], 'the imported delete does not hide a message received here since')

  // The photo came in the batch's own blob, after the seeder forgot the
  // first: the row keeps its descriptor and the batch fills the cache.
  const mine = withP.messages.find((m) => m.text === 'segunda')
  t.is(mine.media[0].id, item.id, 'the row keeps the original descriptor')
  await until(async () => ((await A2.storage.readJson('dmMediaIndex')) || { items: [] }).items.length > 0, { name: 'batch cached', timeoutMs: 60000 })
  host.blobGone = true
  t.ok(b4a.equals((await A2.node.dmReadMedia({ from: A.key, id: second.id, index: 0 })).bytes, photo), 'the prefetched photo opens')
  host.blobGone = false

  // A skips the pointer it made: with its cursor rewound it files nothing new.
  await store.writeDmCursor(A.storage, 0)
  const getsBeforeA = host.blobGets
  await A.web.request('dm.pull')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.is(host.blobGets, getsBeforeA, 'the maker fetched nothing: it skipped its own pointers')
  t.alike(textsOf(await A.web.request('dm.thread', { peer: P.key })), ['oi', 'resposta', 'segunda'])
  t.absent(A.web.events.some((e) => e.name === 'dm.copyImported'), 'no import notice on the maker')

  // A pointer sealed to A's box but signed by another key opens as nothing.
  const boxA = await dmBoxKeyPairFromPrf(A.prf, 1)
  const stranger = crypto.keyPair()
  const forgedInner = dmCore.buildInner({ kind: 'copy', copy: sealBlob(b4a.from('x')).descriptor }, stranger)
  const [stamp] = await takeStamps(P, 1)
  const ch = await rawDm(t, host.url)
  const sealed = dmCore.sealInner(forgedInner, hex(boxA.publicKey))
  t.alike(await ch.put(dropOf(sealed, stamp)), { ok: true, reason: null }, 'the pool takes the forged drop')
  const before = host.blobGets
  await store.writeDmCursor(A2.storage, 0)
  await A2.web.request('dm.pull')
  t.is(host.blobGets, before, 'nothing was fetched for a forged pointer')
})

test('the weekly copy allowance ends: the older photos are left out and counted', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true, copyStampsPerWeek: 5 })
  const { acct, A, A2 } = await devicesOf(t, assoc, host, BLOB)
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  await copyDiary(P, A)
  await copyDiary(A, P)
  const sent = []
  for (const n of [1, 2, 3]) {
    const it = await A.node.dmPutMedia({ bytes: png(500 + n), mime: 'image/png', width: 64, height: 48, to: P.key })
    sent.push(await A.web.request('dm.send', { to: P.key, text: 'foto ' + n, media: [it] }))
  }
  await sweepPool(host)
  await kick(A)
  await idle(t, A)
  const copies = copiesOf(await ownDrops(t, host, acct))
  t.is(copies.length, 2, 'the text and one photo batch')
  const batch = await manifestOf(host, copies[1])
  t.alike(batch.photos.map((x) => x.id), [sent[2].id, sent[1].id], 'the newest two fit the allowance, the oldest is left out')
  await A2.web.request('dm.pull')
  await until(() => A2.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['foto 1', 'foto 2', 'foto 3'])
})
