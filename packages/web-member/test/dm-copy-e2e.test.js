'use strict'

// Copying the conversation history to another device (docs/protocol.md
// section 11, docs/rpc.md 5.150): the real Seeder (dm and blob pools, the
// copy stamp kind) behind a WebSocket server and real browser nodes. Device
// A makes the copy; device A2 of the same passkey imports it after the
// seeder's pool lost the original drops (what a sweep does). Local DHT and
// tmp dirs only.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair, createCert, createIssuerCert } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const dmCore = require('@varanda/core/lib/dm')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const { sealBlob } = require('../lib/blob')
const store = require('../lib/node-store')
const { errorOf } = require('./helpers/session')
const { hex, seederHost, memberNode, rawDm, takeStamps, dropOf, png } = require('./helpers/dm-e2e')

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

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
const NO_PAGE_KEY = 'sem chave da página'

// A Página diary (its certificate, a roster naming `ownerKp` as owner and a
// dm-key with `box`), copied into each of `nodes` as a stored replica, which
// is how dm.lookup and the page store find it. -> the page key (hex).
async function pageDiary (t, assoc, issuer, pageKp, ownerKp, box, nodes) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc.kp))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box, gen: 1, at: AT })
  const hold = async (n) => {
    const dst = await store.openReplica(n.storage, m.key)
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
  }
  for (const n of nodes) await hold(n)
  return { page, hold }
}

// The page's gen 1 secrets, made by `A`, and the call that adopts them on a
// device of the same identity.
function adopt (N, page, made, assoc) {
  const s = made.shares[0]
  return N.web.request('dm.pageSecrets', { page, gen: 1, sealed: s.sealed, by: N.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc.kp) })
}

function textsOf (thread) {
  return thread.messages.map((m) => m.text).sort()
}

test('a history copy made on one device is imported by another of the same passkey', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const A = await memberNode(t, assoc, host, { blob: BLOB })
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  const Q = await memberNode(t, assoc, host, { blob: BLOB })
  const A2 = await memberNode(t, assoc, host, { keyPair: A.keyPair, prf: A.prf, enable: false, blob: BLOB })
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

  // The pool forgets the originals; Q writes again after the delete.
  await sweepPool(host)
  await Q.web.request('dm.send', { to: A.key, text: 'nova do Q' })

  const made = await A.web.request('dm.historyCopy')
  t.alike(Object.keys(made).sort(), ['id', 'leftOut', 'messages', 'notCached', 'photos'], 'the result')
  t.is(made.messages, 3, 'the rows the fold still shows: two sent and one received')
  t.is(made.photos, 1, 'the photo of the deleted conversation stays out')
  t.is(made.notCached, 0)
  t.is(made.leftOut, 0)
  const progress = A.web.events.filter((e) => e.name === 'dm.copyProgress').map((e) => e.data)
  t.ok(progress.length >= 2 && progress[progress.length - 1].done === progress[progress.length - 1].total, 'progress ran to the end')
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

  // The photo reads from the copy's own blob, after the pool forgot the first.
  const mine = withP.messages.find((m) => m.text === 'segunda')
  t.not(mine.media[0].id, item.id, 'the photo travelled as a new blob')
  await until(async () => ((await A2.storage.readJson('dmMediaIndex')) || { items: [] }).items.length > 0, { name: 'prefetch', timeoutMs: 60000 })
  host.blobGone = true
  t.ok(b4a.equals((await A2.node.dmReadMedia({ from: A.key, id: second.id, index: 0 })).bytes, photo), 'the prefetched photo opens')
  host.blobGone = false

  // A skips the pointer it made: with its cursor rewound it files nothing new.
  await store.writeDmCursor(A.storage, 0)
  await A.web.request('dm.pull')
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
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true, copyStampsPerWeek: 2 })
  const A = await memberNode(t, assoc, host, { blob: BLOB })
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  const A2 = await memberNode(t, assoc, host, { keyPair: A.keyPair, prf: A.prf, enable: false, blob: BLOB })
  await copyDiary(P, A)
  await copyDiary(A, P)
  const sent = []
  for (const n of [1, 2, 3]) {
    const it = await A.node.dmPutMedia({ bytes: png(500 + n), mime: 'image/png', width: 64, height: 48, to: P.key })
    sent.push(await A.web.request('dm.send', { to: P.key, text: 'foto ' + n, media: [it] }))
  }
  await sweepPool(host)
  const made = await A.web.request('dm.historyCopy')
  t.is(made.photos, 2, 'the newest two fit the allowance')
  t.is(made.leftOut, 1, 'the oldest is left out')
  t.is(made.notCached, 0)
  t.is(made.messages, 3, 'every message text still travels')
  await A2.web.request('dm.pull')
  await until(() => A2.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['foto 1', 'foto 2', 'foto 3'])
})

test('the conversations of a Página come along: filed at once on a device that holds it, kept sealed until a device adopts it', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const A = await memberNode(t, assoc, host, { blob: BLOB })
  const C = await memberNode(t, assoc, host, { blob: BLOB })
  const A2 = await memberNode(t, assoc, host, { keyPair: A.keyPair, prf: A.prf, enable: false, blob: BLOB })
  await copyDiary(C, A)
  await copyDiary(A, C)
  const boxA = hex((await dmBoxKeyPairFromPrf(A.prf, 1)).publicKey)

  // Two Páginas owned by this identity, adopted on A. A2 will hold the first
  // when the copy arrives and the second only later.
  const pages = []
  for (const text of ['para a primeira', 'para a segunda']) {
    const pageKp = crypto.keyPair()
    const made = await A.web.request('dm.pageGenerate', { page: hex(pageKp.publicKey), gen: 1, recipients: [{ member: A.key, box: boxA }] })
    const diary = await pageDiary(t, assoc, issuer, pageKp, A.keyPair, made.box, [A, C])
    t.alike(await adopt(A, diary.page, made, assoc), { ok: true })
    pages.push({ ...diary, made, text })
  }
  const [P1, P2] = pages
  for (const p of pages) await C.web.request('dm.send', { to: p.page, text: p.text })
  await A.web.request('dm.send', { to: C.key, text: 'oi pessoal' })
  await A.web.request('dm.pull')
  for (const p of pages) t.alike(textsOf(await A.web.request('dm.thread', { page: p.page, peer: C.key })), [p.text], 'the Página holds its message on A')

  // A2 adopts the first Página before the copy exists, and pulls nothing.
  await P1.hold(A2)
  t.alike(await adopt(A2, P1.page, P1.made, assoc), { ok: true })
  await sweepPool(host)

  const made = await A.web.request('dm.historyCopy')
  t.is(made.messages, 3, 'the own conversation and the two Páginas')

  await A2.web.request('dm.pull')
  await until(() => A2.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.is(A2.web.events.find((e) => e.name === 'dm.copyImported').data.messages, 2, 'the own conversation and the held Página')
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: C.key })), ['oi pessoal'], 'the own conversation')
  t.alike(textsOf(await A2.web.request('dm.thread', { page: P1.page, peer: C.key })), [P1.text], 'the held Página is filed in its own store')
  t.ok(A2.web.events.some((e) => e.name === 'dm.changed' && e.data.page === P1.page), 'dm.changed names the Página')
  t.is((await A2.web.request('dm.list', {})).conversations.length, 1, 'the Página rows stay out of the own inbox')

  // The other Página is not held here: nothing readable, one sealed entry.
  t.is((await errorOf(A2.web.request('dm.list', { page: P2.page }))).message, NO_PAGE_KEY, 'not held, so not readable')
  t.is((await store.readCopyPend(A2.storage)).length, 1, 'its conversations wait sealed')
  t.absent(JSON.stringify(await store.readCopyPend(A2.storage)).includes(P2.text), 'no text in the entry list')

  // Adopting it, and the next pull, files them.
  const imports = A2.web.events.filter((e) => e.name === 'dm.copyImported').length
  await P2.hold(A2)
  t.alike(await adopt(A2, P2.page, P2.made, assoc), { ok: true })
  await A2.web.request('dm.pull')
  await until(() => A2.web.events.filter((e) => e.name === 'dm.copyImported').length > imports, { name: 'copyImported after adoption', timeoutMs: 60000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { page: P2.page, peer: C.key })), [P2.text], 'filed after adoption')
  t.ok(A2.web.events.some((e) => e.name === 'dm.changed' && e.data.page === P2.page), 'dm.changed names the adopted Página')
  t.is((await store.readCopyPend(A2.storage)).length, 0, 'the sealed entry is gone')
})
