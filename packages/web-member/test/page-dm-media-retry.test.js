'use strict'

// A Página's photo whose deliver failed: the copies of its plaintext kept for
// the retry of the same draft, cached on that retry, and zeroed by a lock;
// a draft whose step after the inner failed leaves no inner behind. The real
// Seeder with blobs behind a WebSocket (helpers/dm-e2e.js), real browser
// nodes over memory storage. Local DHT only.

// Every page holder the engines make, so a test reads a draft's entry.
// Wrapped before ../lib/dm is first loaded (it keeps the function it got).
const pageDm = require('../lib/page-dm')
const holders = []
const realHolder = pageDm.createPageHolder
pageDm.createPageHolder = (...args) => {
  const h = realHolder(...args)
  holders.push(h)
  return h
}

// Every dm link the engines open, so a test can have the seeder refuse one
// drop ('cheio') without sending it. Wrapped before ../lib/dm is loaded too.
const dmLink = require('../lib/dm-link')
const linkFaults = { refuse: null }
const realOpenDmLink = dmLink.openDmLink
dmLink.openDmLink = async (...args) => {
  const link = await realOpenDmLink(...args)
  const put = link.put
  link.put = async (drop, prefix) => {
    if (linkFaults.refuse !== null && linkFaults.refuse(drop)) return { ok: false, reason: 'cheio' }
    return put(drop, prefix)
  }
  return link
}

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode, png, rejection } = require('./helpers/dm-e2e')
const { pageDiary, hold, copyDiary, signed } = require('./helpers/page-dm')

const isZero = (buf) => buf.every((x) => x === 0)
const STALE = 'prepare a mídia de novo'
const UNSURE = 'não deu para confirmar o envio'
const NO_PAGE_KEY = 'sem chave da página'
// A 64x48 JPEG header the media bounds accept (a card image is a JPEG).
const JPEG = [255, 216, 255, 192, 0, 17, 8, 0, 48, 0, 64, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 2, 255, 217]

// A owns page P (gen 1 secrets held, both diaries copied); A goes offline
// while off() answers true. -> { A, C, P, pageKp, host, holder }
async function setup (t) {
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const net = { off: false }
  const before = holders.length
  const A = await memberNode(t, assoc, host, { blob, offline: () => net.off })
  t.ok(holders.length > before, 'the page holder of A is seen')
  const holder = holders[holders.length - 1]
  const C = await memberNode(t, assoc, host, { blob })
  const boxA = hex((await dmBoxKeyPairFromPrf(A.prf, 1)).publicKey)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: boxA }] })
  const diary = await pageDiary(t, { assoc: kp, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s = made.shares[0]
  t.alike(await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, kp) }), { ok: true })
  await copyDiary(C, A)
  return { A, C, P, pageKp, host, holder, net }
}

test('a Página photo whose first send failed: the retry of the same draft caches it for the Página\'s own thread', async (t) => {
  t.timeout(170000)
  const { A, C, P, pageKp, host, holder, net } = await setup(t)
  const photo = png(40000)
  const item = await A.node.dmPutMedia({ bytes: new Uint8Array(photo), mime: 'image/png', width: 64, height: 48, to: C.key, page: P })
  const d = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'foto', media: [item] })
  const sig = signed(d.digest, pageKp)

  net.off = true
  t.ok(await rejection(A.web.request('dm.pageSend', { page: P, id: d.id, ...sig })), 'the first send fails')
  const draft = holder.draftOf(P, d.id)
  t.ok(draft && draft.entry, 'the draft keeps its entry')
  t.ok(Array.isArray(draft.entry.plains) && draft.entry.plains.length === 1, 'and the copy of the photo')
  t.ok(b4a.equals(draft.entry.plains[0], photo), 'the real bytes')

  net.off = false
  t.alike(await A.web.request('dm.pageSend', { page: P, id: d.id, ...sig }), { id: d.id, at: d.at }, 'the retry of the same draft goes')
  t.is(holder.draftOf(P, d.id), null, 'the draft is gone')

  // The Página's own thread opens the photo from its cache: nothing fetched.
  const own = (await A.web.request('dm.thread', { page: P, peer: C.key })).messages
  t.alike(own.map((m) => m.id), [d.id])
  const gets = host.blobGets
  host.blobGone = true
  t.ok(b4a.equals((await A.node.dmReadMedia({ from: P, id: d.id, index: 0, page: P })).bytes, photo), 'from the Página\'s cache')
  t.is(host.blobGets, gets, 'nothing fetched')
  const pageIndex = await A.storage.readJson(store.pageDmPrefix(P) + 'dmMediaIndex')
  t.is(pageIndex && pageIndex.items.length, 1, 'cached in the Página\'s store')
  host.blobGone = false

  // The reader gets it too.
  await C.web.request('dm.pull')
  t.ok(b4a.equals((await C.node.dmReadMedia({ from: P, id: d.id, index: 0 })).bytes, photo), 'the reader opens the photo')
})

test('a lock after a failed Página send zeroes the photo copies its draft kept', async (t) => {
  t.timeout(170000)
  const { A, C, P, pageKp, holder, net } = await setup(t)
  const failed = async () => {
    const item = await A.node.dmPutMedia({ bytes: png(500), mime: 'image/png', width: 64, height: 48, to: C.key, page: P })
    const d = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'foto', media: [item] })
    net.off = true
    t.ok(await rejection(A.web.request('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) })), 'the send fails')
    net.off = false
    const draft = holder.draftOf(P, d.id)
    const plains = draft.entry.plains
    t.ok(plains.length === 1 && !isZero(plains[0]), 'the copy is held')
    return { draft, plains }
  }

  const locked = await failed()
  await A.node.clearKeyPair({ keepMedia: true })
  t.ok(locked.plains.every(isZero), 'lock: every copy zero-filled')
  t.is(locked.draft.entry.plains, null, 'and dropped')
  t.ok(isZero(locked.draft.json), 'the inner too')
})

test('the page holder zeroes a draft\'s entry copies on drop, forget, expiry and lock', async (t) => {
  const { createPageHolder, PENDING_MS } = pageDm
  const { memoryNodeStorage } = require('../lib/node-storage')
  let clock = 1000
  const assoc = generateAssociationKeyPair()
  const h = createPageHolder({ storage: memoryNodeStorage(), association: hex(assoc.publicKey), now: () => clock })
  await h.unlock(crypto.randomBytes(32))
  const page = hex(crypto.keyPair().publicKey)
  const draftWith = (id) => {
    const plains = [crypto.randomBytes(64), crypto.randomBytes(32)]
    const json = crypto.randomBytes(48)
    h.putDraft(id, { page, kind: 'msg', json, body: {}, box: null, entry: { plains }, blobs: [] })
    return { plains, json, draft: h.draftOf(page, id) }
  }
  const zeroed = (x, how) => {
    t.ok(x.plains.every(isZero), how + ': copies zero-filled')
    t.is(x.draft.entry.plains, null, how + ': dropped')
    t.ok(isZero(x.json), how + ': inner zero-filled')
  }

  const dropped = draftWith('a')
  h.dropDraft('a')
  zeroed(dropped, 'drop')

  const forgotten = draftWith('b')
  await h.forget(page)
  zeroed(forgotten, 'forget')

  const expired = draftWith('c')
  clock += PENDING_MS
  t.is(h.draftOf(page, 'c'), null, 'expired')
  zeroed(expired, 'expiry')

  const atLock = draftWith('d')
  h.lock()
  zeroed(atLock, 'lock')
})

test('a Página draft refused after its inner is built wipes that inner', async (t) => {
  t.timeout(170000)
  const { A, C, P, holder } = await setup(t)
  const item = await A.node.dmPutMedia({ bytes: png(800), mime: 'image/png', width: 64, height: 48, to: C.key, page: P })
  // The holder locks as the draft is filed, after its blobs were acked:
  // the step refuses, as a failed upload or a lock during it does.
  const realPut = holder.putDraft
  const built = []
  holder.putDraft = (id, draft) => {
    built.push(draft.json)
    holder.lock()
    return realPut(id, draft)
  }
  t.teardown(() => { holder.putDraft = realPut })
  const err = await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'foto', media: [item] }))
  holder.putDraft = realPut
  t.is(err && err.message, store.LOCKED, 'the draft is refused')
  t.is(built.length, 1, 'one inner built')
  t.ok(isZero(built[0]), 'and zero-filled')
})

test('the same photo put as the person and as the Página: two blobs, and each sender refuses the other\'s item', async (t) => {
  t.timeout(170000)
  const { A, C, P, pageKp, net } = await setup(t)
  const photo = png(3000)
  const args = { mime: 'image/png', width: 64, height: 48, to: C.key }

  // The person's send fails: its blob stays kept for that retry.
  const mine = await A.node.dmPutMedia({ bytes: new Uint8Array(photo), ...args })
  net.off = true
  t.ok(await rejection(A.web.request('dm.send', { to: C.key, text: 'foto', media: [mine] })), 'the person\'s send fails')
  net.off = false

  // The same bytes for the same reader, as the Página: never that blob.
  const asPage = await A.node.dmPutMedia({ bytes: new Uint8Array(photo), ...args, page: P })
  t.not(asPage.id, mine.id, 'a blob id of its own')
  t.not(asPage.key, mine.key, 'a key of its own')
  t.not(asPage.nonce, mine.nonce, 'a nonce of its own')
  const again = await A.node.dmPutMedia({ bytes: new Uint8Array(photo), ...args, page: P })
  t.is(again.id, asPage.id, 'the same sender still reuses its own blob')

  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'foto', media: [mine] }))).message, STALE, 'a page draft refuses an item put for the person')
  t.is((await rejection(A.web.request('dm.send', { to: C.key, text: 'outra', media: [asPage] }))).message, STALE, 'dm.send refuses an item put for the Página')
  const image = await A.node.dmPutMedia({ bytes: new Uint8Array(JPEG), mime: 'image/jpeg', width: 64, height: 48, to: C.key })
  const url = 'https://example.org/anuncio'
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: url, card: { url, host: 'example.org', title: 'x', desc: '', image } }))).message, STALE, 'and a card image put for the person')

  // A page this node holds no secrets of, and a malformed one.
  const other = hex(crypto.keyPair().publicKey)
  t.is((await rejection(A.node.dmPutMedia({ bytes: new Uint8Array(photo), ...args, page: other }))).message, NO_PAGE_KEY, 'an unheld page is refused')
  t.ok((await rejection((async () => A.node.dmPutMedia({ bytes: new Uint8Array(photo), ...args, page: P.toUpperCase() }))())) instanceof TypeError, 'a malformed page is refused (TypeError, before any await)')

  // Each goes as its own sender, and the reader sees two different blobs.
  const d = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'foto', media: [asPage] })
  t.alike(await A.web.request('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) }), { id: d.id, at: d.at })
  const sent = await A.web.request('dm.send', { to: C.key, text: 'foto', media: [mine] })
  await C.web.request('dm.pull')
  const fromPage = (await C.web.request('dm.thread', { peer: P })).messages
  const fromPerson = (await C.web.request('dm.thread', { peer: A.key })).messages
  t.alike(fromPage.map((m) => m.id), [d.id])
  t.alike(fromPerson.map((m) => m.id), [sent.id])
  t.not(fromPage[0].media[0].id, fromPerson[0].media[0].id, 'nothing the reader holds ties the two senders')
  t.not(fromPage[0].media[0].key, fromPerson[0].media[0].key)
  t.ok(b4a.equals((await C.node.dmReadMedia({ from: P, id: d.id, index: 0 })).bytes, photo), 'both open to the same photo')
  t.ok(b4a.equals((await C.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })).bytes, photo))
})

test('a Página send whose own copy is refused after the reader\'s drop landed is uncertain, and the re-put of that draft makes no second message', async (t) => {
  t.timeout(170000)
  const { A, C, P, pageKp, holder } = await setup(t)
  const item = await A.node.dmPutMedia({ bytes: png(900), mime: 'image/png', width: 64, height: 48, to: C.key, page: P })
  const d = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'foto', media: [item] })
  const sig = signed(d.digest, pageKp)

  // The seeder refuses only the Página's own copy, 'cheio'.
  linkFaults.refuse = (drop) => {
    const x = holder.draftOf(P, d.id)
    return !!(x && x.entry && drop === x.entry.drops[1])
  }
  t.teardown(() => { linkFaults.refuse = null })
  const err = await rejection(A.web.request('dm.pageSend', { page: P, id: d.id, ...sig }))
  linkFaults.refuse = null
  t.is(err && err.message, UNSURE, 'uncertain, never the plain refusal')
  const draft = holder.draftOf(P, d.id)
  t.ok(draft && draft.entry, 'the signed draft is kept')
  t.alike(draft.entry.acked, [true, false], 'the reader\'s drop acked, the own copy not')

  t.alike(await A.web.request('dm.pageSend', { page: P, id: d.id, ...sig }), { id: d.id, at: d.at }, 'the re-put of the same draft goes')
  t.is(holder.draftOf(P, d.id), null, 'the draft is gone')
  await C.web.request('dm.pull')
  t.alike((await C.web.request('dm.thread', { peer: P })).messages.map((m) => m.id), [d.id], 'the reader holds one message')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.id), [d.id], 'so does the Página')
})
