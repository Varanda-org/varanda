'use strict'

// A photo and a link card sent to a Página, opened by its admin acting as the
// Página (docs/rpc.md 5.89 `page`): the real Seeder with the dm and blob
// options behind a WebSocket server (helpers/dm-e2e.js), real browser nodes
// over in-memory storage, and a page diary (its certificate, a roster naming
// A as owner and its dm-key) copied into each node's storage as a stored
// replica, as page-dm.test.js does. Local DHT and tmp dirs only.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode, png, rejection } = require('./helpers/dm-e2e')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
const GONE = 'mídia indisponível'
const NO_PAGE_KEY = 'sem chave da página'
// A 64x48 JPEG header the media bounds accept (a card image is a JPEG).
const JPEG = [255, 216, 255, 192, 0, 17, 8, 0, 48, 0, 64, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 2, 255, 217]

// A page diary: block 0 its certificate, then a roster naming `owner` and
// its gen 1 dm-key `box`.
async function pageDiary (t, { assoc, issuer, pageKp, ownerKp, box }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc.kp))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box, gen: 1, at: AT })
  return m
}

// Copies the page diary into `storage` as a stored replica, whole.
async function hold (m, storage) {
  const dst = await store.openReplica(storage, m.key)
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

test('a photo and a card sent to a Página open as the Página, from its own store; never as the person', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const A = await memberNode(t, assoc, host, { blob })
  const C = await memberNode(t, assoc, host, { blob })
  const boxA = hex((await dmBoxKeyPairFromPrf(A.prf, 1)).publicKey)

  // A owns page P and holds its gen 1 secrets; both hold its diary.
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: boxA }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s = made.shares[0]
  t.alike(await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, kp) }), { ok: true })

  // C sends the Página a photo and an ad link whose card has a thumbnail.
  t.alike(await C.web.request('dm.lookup', { member: P }), { box: made.box, gen: 1 })
  const photo = png(40000)
  const item = await C.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: P })
  const sent = await C.web.request('dm.send', { to: P, text: 'foto', media: [item] })
  const thumb = new Uint8Array(JPEG)
  const image = await C.node.dmPutMedia({ bytes: new Uint8Array(thumb), mime: 'image/jpeg', width: 64, height: 48, to: P })
  const card = { url: 'https://example.org/anuncio', host: 'example.org', title: 'Anúncio', desc: '', image }
  const linked = await C.web.request('dm.send', { to: P, text: 'https://example.org/anuncio', card })

  await A.web.request('dm.pull')
  const gets = host.blobGets
  const th = await A.web.request('dm.thread', { page: P, peer: C.key })
  t.alike(th.messages.map((m) => [m.id, m.media]), [[sent.id, [item]], [linked.id, null]], 'the Página\'s thread lists the items')
  t.alike(th.messages[1].card.image, image)
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(host.blobGets, gets, 'a Página\'s thread opens nothing by itself')

  // As the person, the message is not in any conversation: unavailable.
  t.is((await rejection(A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0 }))).message, GONE, 'without page: not the person\'s')
  t.is((await rejection(A.node.dmReadMedia({ from: C.key, id: linked.id, index: 'card' }))).message, GONE)
  t.is(host.blobGets, gets, 'nothing fetched for it')

  // As the Página: the exact bytes, fetched once, then from its own cache.
  const got = await A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0, page: P })
  t.ok(b4a.equals(got.bytes, photo), 'the photo opens as the Página')
  t.is(got.mime, 'image/png')
  const fetched = host.blobGets
  t.ok(fetched > gets, 'fetched from the seeder')
  const cardGot = await A.node.dmReadMedia({ from: C.key, id: linked.id, index: 'card', page: P })
  t.ok(b4a.equals(cardGot.bytes, thumb), 'the card thumbnail opens as the Página')
  const both = host.blobGets
  host.blobGone = true
  t.ok(b4a.equals((await A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0, page: P })).bytes, photo), 'again, from the cache')
  t.ok(b4a.equals((await A.node.dmReadMedia({ from: C.key, id: linked.id, index: 'card', page: P })).bytes, thumb))
  t.is(host.blobGets, both, 'nothing fetched twice')
  const pageIndex = await A.storage.readJson(store.pageDmPrefix(P) + 'dmMediaIndex')
  t.is(pageIndex && pageIndex.items.length, 2, 'cached in the Página\'s store')
  const ownIndex = await A.storage.readJson('dmMediaIndex')
  t.ok(ownIndex === null || ownIndex.items.length === 0, 'not in the person\'s')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages[0].media, [item], 'the cached photo still lists')

  // Still not the person's after the Página read.
  t.is((await rejection(A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0 }))).message, GONE, 'the Página cache never answers the person')

  // A blob gone before any read: unavailable, and the Página's thread says so.
  const late = await C.node.dmPutMedia({ bytes: png(500), mime: 'image/png', width: 64, height: 48, to: P })
  const lateSent = await C.web.request('dm.send', { to: P, text: 'tarde', media: [late] })
  await A.web.request('dm.pull')
  t.is((await rejection(A.node.dmReadMedia({ from: C.key, id: lateSent.id, index: 0, page: P }))).message, GONE)
  const tl = await A.web.request('dm.thread', { page: P, peer: C.key })
  t.alike(tl.messages.find((m) => m.id === lateSent.id).media, { unavailable: true }, 'the Página\'s row is unavailable')
  t.ok(A.web.events.some((e) => e.name === 'dm.changed' && e.data.page === P && e.data.added === 0), 'dm.changed names the page')

  // A page this node holds no secrets of, and a malformed page.
  const other = hex(crypto.keyPair().publicKey)
  t.is((await rejection(A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0, page: other }))).message, NO_PAGE_KEY, 'an unheld page is refused')
  t.ok((await rejection(A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0, page: P.toUpperCase() }))) instanceof TypeError, 'a malformed page is refused')

  // Locked: nothing readable, cached or not; a lock keeps the sealed cache.
  await A.node.clearKeyPair({ keepMedia: true })
  t.is((await rejection(A.node.dmReadMedia({ from: C.key, id: sent.id, index: 0, page: P }))).message, store.LOCKED, 'locked: refused')
  t.ok(await A.storage.readJson(store.pageDmPrefix(P) + 'dmMediaIndex'), 'a lock keeps the Página\'s cache')

  // A sign-out deletes it, as the person's.
  await A.node.clearKeyPair()
  t.is(await A.storage.readJson(store.pageDmPrefix(P) + 'dmMediaIndex'), null, 'sign-out wipes the Página\'s cache index')
  for (const e of pageIndex.items) {
    for (let i = 0; i < e.c; i++) t.is(await A.storage.readJson(store.pageDmPrefix(P) + 'dmMedia/' + e.n + '/' + i), null, 'and its items')
  }
})
