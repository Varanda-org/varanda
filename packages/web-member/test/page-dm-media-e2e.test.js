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
const { copyDiary, signed } = require('./helpers/page-dm')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
const GONE = 'mídia indisponível'
const NO_PAGE_KEY = 'sem chave da página'
// A 64x48 JPEG header the media bounds accept (a card image is a JPEG).
const JPEG = [255, 216, 255, 192, 0, 17, 8, 0, 48, 0, 64, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 2, 255, 217]

const STALE = 'prepare a mídia de novo'

// A minimal audio-only MPEG-4 file (e2e-media.test.js m4a): a voice note.
function m4a (ms = 3000) {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (str) => Array.from(str, (c) => c.charCodeAt(0))
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  const trak = box('trak', box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii('soun'), be32(0), be32(0), be32(0), [0]), box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 28, 0, 1, 0, 4, 20, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 23, 135, 208, 0, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(ms), be32(1)), box('stsz', [0, 0, 0, 0], be32(1), be32(ms)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(ms), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))))
  return b4a.from([
    ...box('ftyp', ascii('M4A '), be32(0), ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0)), trak),
    ...box('mdat', new Array(ms).fill(9))
  ])
}

// What a reader can compare between two sends of the same content: a media
// item without its blob's id, key, nonce and ciphertext hash.
function shapeOf (item) {
  return item === null ? null : { mime: item.mime, w: item.w, h: item.h, ms: item.ms, chunks: item.chunks, bytes: item.bytes }
}

function rowShape (m) {
  return {
    text: m.text,
    fwd: m.fwd,
    replyTo: m.replyTo,
    mine: m.mine,
    media: Array.isArray(m.media) ? m.media.map(shapeOf) : m.media,
    card: m.card === null ? null : { ...m.card, image: shapeOf(m.card.image) }
  }
}

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

test('a Página sends a photo, a voice note, a card and a forward with media; its reader gets what a person sends', async (t) => {
  t.timeout(240000)
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

  // A owns page P and holds its gen 1 secrets; A finds C's dm-key locally.
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: boxA }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s = made.shares[0]
  t.alike(await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, kp) }), { ok: true })
  await copyDiary(C, A)

  const photo = png(40000)
  const voice = m4a()
  const thumb = new Uint8Array(JPEG)
  const fwdPhoto = png(500)
  const url = 'https://example.org/anuncio'
  // Each content once as the Página (pageDraft, the page key's signature,
  // pageSend) and once as A the person (dm.send), every blob put for C.
  // by: { page: P } puts the items for the Página, {} for the person.
  const contents = [
    async (by) => ({ text: 'foto', media: [await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: C.key, ...by })] }),
    async (by) => ({ text: '', media: [await A.node.dmPutMedia({ bytes: voice, mime: 'audio/mp4', width: 0, height: 0, ms: 3000, kind: 'voice', to: C.key, ...by })] }),
    async (by) => ({ text: url, card: { url, host: 'example.org', title: 'Anúncio', desc: 'R$ 10,00', image: await A.node.dmPutMedia({ bytes: thumb, mime: 'image/jpeg', width: 64, height: 48, to: C.key, ...by }) } }),
    async (by) => ({ text: 'encaminhada', fwd: 1, media: [await A.node.dmPutMedia({ bytes: fwdPhoto, mime: 'image/png', width: 64, height: 48, to: C.key, ...by })] })
  ]
  const asPage = []
  const asPerson = []
  for (const content of contents) {
    const fields = await content({ page: P })
    const d = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, ...fields })
    t.alike(await A.web.request('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) }), { id: d.id, at: d.at })
    asPage.push(d.id)
    asPerson.push((await A.web.request('dm.send', { to: C.key, ...(await content({})), ...(fields.fwd ? { fwd: 1 } : {}) })).id)
  }

  await C.web.request('dm.pull')
  const fromPage = (await C.web.request('dm.thread', { peer: P })).messages
  const fromPerson = (await C.web.request('dm.thread', { peer: A.key })).messages
  t.alike(fromPage.map((m) => m.id), asPage, 'the reader holds every page message')
  t.alike(fromPerson.map((m) => m.id), asPerson)
  t.alike(fromPage.map(rowShape), fromPerson.map(rowShape), 'the Página\'s messages read as the person\'s')
  t.is(fromPage[2].card.title, 'Anúncio')
  t.is(fromPage[3].fwd, 1)

  // The bytes the reader opens: the same as the person's, and the photos exact.
  const read = async (from, id, index) => (await C.node.dmReadMedia({ from, id, index })).bytes
  for (const [i, index] of [[0, 0], [1, 0], [2, 'card'], [3, 0]]) {
    const got = await read(P, asPage[i], index)
    t.ok(b4a.equals(got, await read(A.key, asPerson[i], index)), 'item ' + i + ' opens as the person\'s')
    if (i === 0) t.ok(b4a.equals(got, photo), 'the photo')
    if (i === 2) t.ok(b4a.equals(got, thumb), 'the card thumbnail')
    if (i === 3) t.ok(b4a.equals(got, fwdPhoto), 'the forwarded photo')
  }
  t.is((await C.node.dmReadMedia({ from: P, id: asPage[1], index: 0 })).mime, 'audio/mp4', 'the voice note')

  // The Página's own thread lists them, and its copies come from its own
  // cache, put from the bytes it sent: nothing fetched for them.
  const own = (await A.web.request('dm.thread', { page: P, peer: C.key })).messages
  t.alike(own.map(rowShape), fromPage.map((m) => ({ ...rowShape(m), mine: true })), 'the Página\'s own rows')
  const gets = host.blobGets
  host.blobGone = true
  t.ok(b4a.equals((await A.node.dmReadMedia({ from: P, id: asPage[0], index: 0, page: P })).bytes, photo), 'the sent photo, from the Página\'s cache')
  t.ok(b4a.equals((await A.node.dmReadMedia({ from: P, id: asPage[2], index: 'card', page: P })).bytes, thumb))
  t.is(host.blobGets, gets, 'nothing fetched')
  const pageIndex = await A.storage.readJson(store.pageDmPrefix(P) + 'dmMediaIndex')
  t.is(pageIndex && pageIndex.items.length, 4, 'one cache entry per page message with media')
  host.blobGone = false

  // Refused before anything is signed: no draft, so no digest to sign.
  const other = hex(crypto.keyPair().publicKey)
  const elsewhere = await A.node.dmPutMedia({ bytes: png(600), mime: 'image/png', width: 64, height: 48, to: other, page: P })
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: '', media: [elsewhere] }))).message, STALE, 'an item put for another conversation')
  const sentItem = fromPage[0].media[0]
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: '', media: [sentItem] }))).message, STALE, 'an item already sent')
  const forged = { ...sentItem, id: 'ab'.repeat(32) }
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: '', media: [forged] }))).message, STALE, 'an item this node never put')
  const fresh = await A.node.dmPutMedia({ bytes: png(700), mime: 'image/png', width: 64, height: 48, to: C.key, page: P })
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: '', media: [{ ...fresh, w: 0 }] }))).message, 'parâmetro inválido: media', 'an invalid item')
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: url, card: { url, host: 'example.org', title: 'x', desc: '', image: { ...fresh, mime: 'image/png' } } }))).message, 'parâmetro inválido: card', 'a card image that is not a JPEG')
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: url, media: [fresh], card: { url, host: 'example.org', title: 'x', desc: '', image: null } }))).message, 'parâmetro inválido: media', 'media and a card')
  t.is((await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'accepted', peer: C.key, media: [fresh] }))).message, 'parâmetro inválido: kind', 'a ctl with media')
  const longCard = async (by) => ({ url: url + '?' + 'a'.repeat(300 - url.length - 1), host: 'example.org', title: '😀'.repeat(80), desc: '😀'.repeat(160), image: await A.node.dmPutMedia({ bytes: new Uint8Array(JPEG), mime: 'image/jpeg', width: 64, height: 48, to: C.key, ...by }) })
  const refusedLong = await rejection(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: '😀'.repeat(1000), card: await longCard({ page: P }) }))
  const refusedLongPerson = await rejection(A.web.request('dm.send', { to: C.key, text: '😀'.repeat(1000), card: await longCard({}) }))
  t.is(refusedLong && refusedLong.message, 'mensagem longa demais', 'a text and card past the inner budget')
  t.is(refusedLongPerson && refusedLongPerson.message, 'mensagem longa demais', 'as for a person')
  // The item still goes once it is valid.
  const d = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: '', media: [fresh] })
  t.alike(await A.web.request('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) }), { id: d.id, at: d.at })
})
