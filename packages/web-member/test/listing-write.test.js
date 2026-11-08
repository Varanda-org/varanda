'use strict'

// The Feira writers of the browser node (lib/member-ops.js, lib/session.js):
// photos verified against the own declared media core before a listing is
// published, the cap of live listings, an edit that keeps the root ref and
// retires the edit it replaces (freeing only the photos nothing else shows),
// the expectedRevision check, status and delete, the deal consent (signed
// only for an inbound proposta of that rater), the verified ratings read and
// an append whose outcome is unknown surfacing uncertain, never retried.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createHash } = require('node:crypto')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer, WebSocket } = require('ws')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSnapshot, compareSnapshots } = require('@varanda/core/lib/blocklist')
const { wsStream } = require('../lib/ws-stream')
const { MEDIA_BLOCK_BYTES, listingRateRecord, deleteRecord } = require('@varanda/core/lib/records')
const { verifyConsent } = require('@varanda/core/lib/listing')
const { feira } = require('@varanda/rpc')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')
const { connectClient, errorOf } = require('./helpers/session')

const hex = (buf) => b4a.toString(buf, 'hex')
const DAY = 24 * 60 * 60 * 1000
const OFFER = 'c3'.repeat(16)

const BASE = {
  kind: 'produto',
  title: 'Bicicleta aro 26',
  text: 'Pouco usada',
  price: 25000,
  unit: null,
  cat: 'esporte',
  place: { uf: 'SP', city: 'São Paulo', bairro: null }
}

async function member (storage = memoryNodeStorage()) {
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const keyPair = crypto.keyPair()
  const mediaKeyPair = crypto.keyPair()
  const ctx = { storage, association, keyPair, mediaKeyPair }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  return { storage, assocKp, association, keyPair, ownHex, ctx }
}

function item (n, seed) {
  const bytes = b4a.alloc(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 7 + seed) & 0xff
  const blocks = []
  for (let at = 0; at < n; at += MEDIA_BLOCK_BYTES) blocks.push(bytes.subarray(at, Math.min(n, at + MEDIA_BLOCK_BYTES)))
  return { blocks, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function photo (m, seed) {
  const { core, declared } = await ops.mediaPrepare(m.ctx)
  if (!declared) await ops.declareMediaCore(m.ctx, core)
  const it = item(1000 + seed, seed)
  return ops.mediaCommit(m.ctx, { blocks: it.blocks, mime: 'image/jpeg', width: 640, height: 480, sha256: it.sha256 })
}

async function raw (m) {
  return ops.withIdentity(m.ctx, ({ diary }) => store.readRaw(diary))
}

function range (d) {
  return { core: d.core, start: d.start, blocks: d.blocks }
}

function snapshot (extra = {}) {
  const { kind, ...rest } = BASE
  return { ...rest, ...extra }
}

test('listingCreate verifies own media, refuses a foreign core or a bad hash, and caps live listings', async (t) => {
  const m = await member()
  const a = await photo(m, 1)
  const r = await ops.listingCreate(m.ctx, { ...BASE, media: [a] })
  t.is(r.ref, m.ownHex + ':' + r.seq, 'ref names the root')
  const mine = await ops.listingMine(m.ctx, {})
  t.is(mine.items.length, 1)
  t.alike(mine.items[0].media, [a], 'the photo is published')
  t.is(mine.items[0].status, 'disponivel')

  const before = (await raw(m)).length
  const foreign = { ...a, core: hex(crypto.keyPair().publicKey) }
  await t.exception(ops.listingCreate(m.ctx, { ...BASE, media: [foreign] }), /mídia inválida/, 'a foreign core is refused')
  await t.exception(ops.listingCreate(m.ctx, { ...BASE, media: [{ ...a, sha256: 'ff'.repeat(32) }] }), /mídia inválida/, 'a bad hash is refused')
  t.is((await raw(m)).length, before, 'nothing appended')

  for (let i = 1; i < feira.MAX_LISTINGS; i++) await ops.listingCreate(m.ctx, { ...BASE, title: 'Item ' + i })
  await t.exception(ops.listingCreate(m.ctx, BASE), /limite/, 'the 31st live listing is refused')
  const page = await ops.listingMine(m.ctx, {})
  t.is(page.items.length, 20, 'mine pages at 20')
  const rest = await ops.listingMine(m.ctx, { before: page.next })
  t.is(rest.items.length, 10, 'before is exclusive')
  t.is(rest.next, null)
})

test('listingEdit supersedes, frees only the unshared photos of the previous edit, and refuses a stale revision', async (t) => {
  const m = await member()
  const a = await photo(m, 1)
  const b = await photo(m, 2)
  const c = await photo(m, 3)
  const root = await ops.listingCreate(m.ctx, { ...BASE, media: [a] })
  const to = { author: m.ownHex, seq: root.seq }

  const e1 = await ops.listingEdit(m.ctx, { to, expectedRevision: 0, ...snapshot({ title: 'Bicicleta nova', media: [a, b] }) })
  t.is(e1.ref, root.ref, 'the root ref stays')
  t.is(e1.last, e1.seq, 'a first edit is one record')
  let mine = (await ops.listingMine(m.ctx, {})).items[0]
  t.is(mine.title, 'Bicicleta nova')
  t.is(mine.editSeq, e1.seq)

  const e2 = await ops.listingEdit(m.ctx, { to, expectedRevision: e1.seq, ...snapshot({ title: 'Bicicleta azul', media: [a, c] }) })
  t.is(e2.last, e2.seq + 1, 'the edit and the tombstone in one append')
  const entries = await raw(m)
  const tomb = entries[e2.last].record
  t.is(tomb.type, 'delete')
  t.is(tomb.seq, e1.seq, 'the previous edit is retired')
  t.alike(tomb.media, [range(b)], 'only the photo nothing else shows is freed')
  mine = (await ops.listingMine(m.ctx, {})).items[0]
  t.is(mine.title, 'Bicicleta azul')
  t.alike(mine.media, [a, c])

  const length = entries.length
  const stale = await errorOf(ops.listingEdit(m.ctx, { to, expectedRevision: e1.seq, ...snapshot({ title: 'Outra' }) }))
  t.is(stale && stale.message, 'conflito', 'a stale revision is refused')
  t.is((await raw(m)).length, length, 'and appends nothing')
  const unit = await errorOf(ops.listingEdit(m.ctx, { to, expectedRevision: e2.seq, ...snapshot({ unit: 'hora' }) }))
  t.is(unit && unit.message, 'parâmetro inválido: unit', 'the unit is checked against the root kind')
  const post = await ops.postCreate(m.ctx, { text: 'oi' })
  const notListing = await errorOf(ops.listingEdit(m.ctx, { to: { author: m.ownHex, seq: post.seq }, expectedRevision: 0, ...snapshot() }))
  t.is(notListing && notListing.message, 'o registro não é um anúncio')
})

test('listingStatus folds, procura is never reservado, and delete clears the root and its edit', async (t) => {
  const m = await member()
  const a = await photo(m, 1)
  const b = await photo(m, 2)
  const root = await ops.listingCreate(m.ctx, { ...BASE, media: [a] })
  const to = { author: m.ownHex, seq: root.seq }
  const s = await ops.listingStatus(m.ctx, { to, status: 'vendido' })
  t.is(s.ref, root.ref)
  let mine = (await ops.listingMine(m.ctx, {})).items[0]
  t.is(mine.status, 'vendido')
  t.is(mine.statusSeq, s.seq)
  const procura = await ops.listingCreate(m.ctx, { ...BASE, kind: 'procura', price: null })
  await t.exception(ops.listingStatus(m.ctx, { to: { author: m.ownHex, seq: procura.seq }, status: 'reservado' }), /uma procura não fica reservada/)
  const post = await ops.postCreate(m.ctx, { text: 'oi' })
  await t.exception(ops.listingStatus(m.ctx, { to: { author: m.ownHex, seq: post.seq }, status: 'vendido' }), /o registro não é um anúncio/)

  const e1 = await ops.listingEdit(m.ctx, { to, expectedRevision: 0, ...snapshot({ media: [a, b] }) })
  const d = await ops.listingDelete(m.ctx, { to })
  t.ok(d.changed)
  t.alike(d.deleted, [root.seq, e1.seq], 'the root and its live edit')
  const entries = await raw(m)
  const tombs = entries.slice(-2).map((e) => e.record)
  t.alike(tombs.map((r) => [r.type, r.seq]), [['delete', root.seq], ['delete', e1.seq]])
  t.alike(tombs.flatMap((r) => r.media || []), [range(a), range(b)], 'each photo freed once')
  t.is(entries[root.seq].record, null, 'the root block is cleared')
  mine = await ops.listingMine(m.ctx, {})
  t.alike(mine.items.map((i) => i.seq), [procura.seq], 'the listing is gone')
  const again = await ops.listingDelete(m.ctx, { to })
  t.is(again.changed, false, 'a second delete writes nothing')
  await t.exception(ops.listingDelete(m.ctx, { to: { author: m.ownHex, seq: post.seq } }), /o registro não é um anúncio/)
})

test('a second listingDelete while the root block is still readable writes nothing', async (t) => {
  const m = await member()
  const root = await ops.listingCreate(m.ctx, BASE)
  const to = { author: m.ownHex, seq: root.seq }
  // The local clear did not happen (it failed, or another device's
  // tombstone replicated before the bytes were cleared).
  const kept = { ...m.ctx, noClear: true }
  const first = await ops.listingDelete(kept, { to })
  t.ok(first.changed)
  t.not((await raw(m))[root.seq].record, null, 'the root block is still readable')
  const length = (await raw(m)).length
  const again = await ops.listingDelete(kept, { to })
  t.alike([again.changed, again.seq, again.deleted], [false, first.seq, [root.seq]], 'answers the existing tombstone')
  t.is((await raw(m)).length, length, 'nothing appended')
})

test('listingRate needs the author consent for the own key', async (t) => {
  const seller = crypto.keyPair()
  const sellerHex = hex(seller.publicKey)
  const m = await member()
  const want = { own: sellerHex, seq: 5, rater: m.ownHex, offer: OFFER }
  const consent = ops.signConsent(seller, want)
  const to = { author: sellerHex, seq: 5 }
  await t.exception(ops.listingRate(m.ctx, { to, offer: OFFER, consent: 'ab'.repeat(64), stars: 5, text: 'Ótimo' }), /consentimento inválido/)
  await t.exception(ops.listingRate(m.ctx, { to: { author: sellerHex, seq: 6 }, offer: OFFER, consent, stars: 5, text: '' }), /consentimento inválido/, 'bound to the listing')
  const r = await ops.listingRate(m.ctx, { to, offer: OFFER, consent, stars: 5, text: 'Ótimo' })
  t.is((await raw(m))[r.seq].record.type, 'listing-rate')
})

test('listingRate writes one rating per offer and never rewrites it, even after a tombstone', async (t) => {
  const seller = crypto.keyPair()
  const sellerHex = hex(seller.publicKey)
  const m = await member()
  const to = { author: sellerHex, seq: 5 }
  const consent = ops.signConsent(seller, { own: sellerHex, seq: 5, rater: m.ownHex, offer: OFFER })
  const first = await ops.listingRate(m.ctx, { to, offer: OFFER, consent, stars: 5, text: 'Ótimo' })
  const length = (await raw(m)).length
  await t.exception(ops.listingRate(m.ctx, { to, offer: OFFER, consent, stars: 1, text: 'Mudei' }), /avaliação já enviada para esta oferta/)
  t.is((await raw(m)).length, length, 'nothing appended')
  // A tombstone left by another client: the offer is still spent.
  await ops.withIdentity(m.ctx, ({ diary }) => store.appendRecord(diary, deleteRecord({ seq: first.seq, at: new Date().toISOString() })))
  await t.exception(ops.listingRate(m.ctx, { to, offer: OFFER, consent, stars: 1, text: 'Mudei' }), /avaliação já enviada para esta oferta/, 'delete then rate cannot rewrite')
  const other = 'd4'.repeat(16)
  const next = await ops.listingRate(m.ctx, { to, offer: other, consent: ops.signConsent(seller, { own: sellerHex, seq: 5, rater: m.ownHex, offer: other }), stars: 4, text: 'Outra compra' })
  t.ok(next.seq > first.seq, 'another offer is another deal')
})

test('consent: signed only for an inbound proposta from that rater naming the listing', (t) => {
  const seller = crypto.keyPair()
  const own = hex(seller.publicKey)
  const rater = hex(crypto.keyPair().publicKey)
  const url = 'https://varanda.app/f/' + own + '/4#oferta=20000'
  const want = { own, seq: 4, rater, offer: OFFER }
  const msg = { id: OFFER, from: rater, mine: false, text: 'Olá', card: { url } }
  t.ok(ops.offerReceived([msg], want), 'a card offer')
  t.ok(ops.offerReceived([{ ...msg, card: null, text: url }], want), 'an offer in the text')
  t.absent(ops.offerReceived([], want), 'no history')
  t.absent(ops.offerReceived([{ ...msg, from: hex(crypto.keyPair().publicKey) }], want), 'another sender')
  t.absent(ops.offerReceived([{ ...msg, mine: true }], want), 'an own message')
  t.absent(ops.offerReceived([{ ...msg, id: 'd4'.repeat(16) }], want), 'another message id')
  t.absent(ops.offerReceived([{ ...msg, card: { url: 'https://varanda.app/f/' + own + '/5#oferta=20000' } }], want), 'another listing')
  t.absent(ops.offerReceived([{ ...msg, card: { url: 'https://varanda.app/f/' + own + '/4#oferta=20000&resposta=recusada' } }], want), 'an answer, not a proposta')
  const consent = ops.signConsent(seller, want)
  t.ok(/^[0-9a-f]{128}$/.test(consent))
  t.ok(verifyConsent({ listingAuthor: own, listingSeq: 4, rater, offerId: OFFER, consent }), 'verifies')
  t.absent(verifyConsent({ listingAuthor: own, listingSeq: 4, rater: hex(crypto.keyPair().publicKey), offerId: OFFER, consent }), 'fails for a swapped rater')
})

test('ratingsOf keeps verified ratings of one listing, drops the invalid ones and flags what it could not read', (t) => {
  const seller = crypto.keyPair()
  const author = hex(seller.publicKey)
  const now = Date.parse('2026-11-07T12:00:00.000Z')
  const old = new Date(now - 8 * DAY).toISOString()
  const young = new Date(now - 6 * DAY).toISOString()
  const rate = (rater, listingSeq, stars, at = '2026-11-06T10:00:00.000Z', consent, offer = OFFER) =>
    listingRateRecord({ to: { author, seq: listingSeq }, offer, consent: consent || ops.signConsent(seller, { own: author, seq: listingSeq, rater, offer }), stars, text: 'Bom', at })
  const O1 = 'e1'.repeat(16)
  const O2 = 'e2'.repeat(16)
  const good = hex(crypto.keyPair().publicKey)
  const bad = hex(crypto.keyPair().publicKey)
  const fresh = hex(crypto.keyPair().publicKey)
  const peeks = [
    { rater: good, certDate: old, entries: [{ seq: 3, record: rate(good, 4, 2, '2026-11-01T10:00:00.000Z', undefined, O1) }, { seq: 9, record: rate(good, 4, 5, undefined, undefined, O2) }, { seq: 11, record: rate(good, 5, 1) }], invalid: [], missing: [] },
    { rater: bad, certDate: old, entries: [{ seq: 2, record: rate(bad, 4, 1, undefined, 'ab'.repeat(64)) }], invalid: [], missing: [] },
    { rater: fresh, certDate: young, entries: [{ seq: 2, record: rate(fresh, 4, 1) }], invalid: [], missing: [] },
    { rater: author, certDate: old, entries: [{ seq: 2, record: rate(author, 4, 5) }], invalid: [], missing: [] }
  ]
  const refs = [{ rater: good, seq: 3 }, { rater: good, seq: 9 }, { rater: good, seq: 11 }, { rater: bad, seq: 2 }, { rater: fresh, seq: 2 }, { rater: author, seq: 2 }]
  const r = ops.ratingsOf({ author, seq: 4, refs, peeks, nowMs: now })
  t.alike(r.items, [{ rater: good, seq: 9, listingSeq: 4, stars: 5, text: 'Bom', at: '2026-11-06T10:00:00.000Z' }], 'of two offers for this listing, the newest per rater')
  t.is(r.dropped, 4, 'another listing, a bad consent, a young certificate and a self-rating')
  t.is(r.incomplete, false)
  const other = ops.ratingsOf({ author: hex(crypto.keyPair().publicKey), seq: 4, refs, peeks, nowMs: now })
  t.is(other.items.length, 0, 'a rating about another author never counts')
  const unhinted = ops.ratingsOf({ author, seq: 4, refs: [{ rater: good, seq: 1 }], peeks, nowMs: now })
  t.alike([unhinted.items.length, unhinted.dropped, unhinted.incomplete], [0, 0, true], 'a block not read is incomplete, not dropped')

  // A later block naming an offer an earlier block of that rater holds is
  // a rewrite: dropped, the first one stays.
  const rewritten = [{ rater: good, certDate: old, entries: [{ seq: 3, record: rate(good, 4, 5, '2026-11-01T10:00:00.000Z', undefined, O1) }, { seq: 9, record: rate(good, 4, 1, undefined, undefined, O1) }], invalid: [], missing: [] }]
  const once = ops.ratingsOf({ author, seq: 4, refs: [{ rater: good, seq: 9 }, { rater: good, seq: 3 }], peeks: rewritten, nowMs: now })
  t.alike(once.items.map((i) => [i.seq, i.stars]), [[3, 5]], 'one rating per offer')
  t.is(once.dropped, 1, 'the rewrite is dropped')

  const slow = hex(crypto.keyPair().publicKey)
  const gone = hex(crypto.keyPair().publicKey)
  const partial = ops.ratingsOf({
    author,
    seq: 4,
    refs: [{ rater: good, seq: 9 }, { rater: slow, seq: 2 }, { rater: gone, seq: 2 }, { rater: bad, seq: 7 }],
    peeks: [peeks[0], { rater: slow, failed: true }, { rater: gone, hidden: true }, { rater: bad, certDate: old, entries: [], invalid: [], missing: [7] }],
    nowMs: now
  })
  t.is(partial.items.length, 1)
  t.is(partial.dropped, 1, 'only the hidden diary counts as dropped')
  t.is(partial.incomplete, true, 'a transient failure or a missing block marks the answer incomplete')
})

async function node (t, { timeoutMs, prf = crypto.randomBytes(32), ...options } = {}) {
  const m = await member()
  const internal = []
  const n = createBrowserNode({
    storage: m.storage,
    association: m.association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    onInternalError: (err) => internal.push(err),
    ...options
  })
  t.teardown(() => n.close(), { force: true })
  await n.setKeyPair(m.keyPair, prf === null ? { media: m.ctx.mediaKeyPair } : { media: m.ctx.mediaKeyPair, prf })
  const web = await connectClient(n, timeoutMs === undefined ? {} : { timeoutMs })
  return { ...m, node: n, web, internal }
}

test('session: the listing methods write through the post.create path and listing.consent needs the proposta', async (t) => {
  const s = await node(t)
  const created = await s.web.request('listing.create', BASE)
  t.is(created.ref, s.ownHex + ':' + created.seq)
  const edit = await s.web.request('listing.edit', { to: created.ref, expectedRevision: 0, ...snapshot({ title: 'Nova', media: null }) })
  t.is(edit.ref, created.ref)
  const status = await s.web.request('listing.status', { to: created.ref, status: 'reservado' })
  t.is(status.ref, created.ref)
  const mine = await s.web.request('listing.mine', {})
  t.alike(mine.items.map((i) => [i.title, i.status, i.editSeq, i.statusSeq]), [['Nova', 'reservado', edit.seq, status.seq]])
  const rater = hex(crypto.keyPair().publicKey)
  const missing = await errorOf(s.web.request('listing.consent', { to: created.ref, rater, offer: OFFER }))
  t.alike(missing && [missing.code, missing.message], ['USAGE', 'oferta-ausente'], 'no inbound proposta')
  const foreign = await errorOf(s.web.request('listing.consent', { to: rater + ':1', rater, offer: OFFER }))
  t.alike(foreign && [foreign.code, foreign.message], ['USAGE', 'referência inválida'], 'another author\'s ref, as the core node')
  const past = await errorOf(s.web.request('listing.consent', { to: s.ownHex + ':999', rater, offer: OFFER }))
  t.alike(past && [past.code, past.message], ['USAGE', 'referência inválida'], 'a seq past the diary')
  const before = (await raw(s)).length
  const del = await s.web.request('listing.delete', { to: created.ref })
  t.ok(del.changed)
  t.is((await raw(s)).length, before + 2, 'root and edit tombstones')
  const gone = await errorOf(s.web.request('listing.consent', { to: created.ref, rater, offer: OFFER }))
  t.is(gone && gone.message, 'o registro não é um anúncio', 'a deleted listing is no live root')
  t.alike(s.internal, [])
})

test('session: an append whose outcome is lost surfaces uncertain and is not retried', async (t) => {
  const s = await node(t, { timeoutMs: 300 })
  const real = store.appendRecord
  let calls = 0
  store.appendRecord = (...args) => {
    calls++
    return new Promise((resolve, reject) => setTimeout(() => reject(new Error('disco cheio')), 800))
  }
  t.teardown(() => { store.appendRecord = real })
  const err = await errorOf(s.web.request('listing.create', BASE))
  t.is(err && err.uncertain, true, 'uncertain')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  t.is(calls, 1, 'one append, never retried')
  store.appendRecord = real
  t.is((await s.web.request('listing.mine', {})).items.length, 0, 'nothing published')
})

test('session: listing.consent with the DM store locked is the locked error, not oferta-ausente', async (t) => {
  const s = await node(t, { prf: null })
  const created = await s.web.request('listing.create', BASE)
  const err = await errorOf(s.web.request('listing.consent', { to: created.ref, rater: hex(crypto.keyPair().publicKey), offer: OFFER }))
  t.alike(err && [err.code, err.message], ['USAGE', 'identidade bloqueada: entre com a passkey'])
})

test('session: listing.ratings shares one deadline across raters and answers incomplete', async (t) => {
  const s = await node(t, { peekTimeoutMs: 5000, ratingsTimeoutMs: 300 })
  const refs = [1, 2, 3].map((seq) => ({ rater: hex(crypto.keyPair().publicKey), seq }))
  const started = Date.now()
  const r = await s.web.request('listing.ratings', { author: hex(crypto.keyPair().publicKey), seq: 4, refs })
  t.ok(Date.now() - started < 2500, 'bounded by the shared deadline')
  t.alike(r, { items: [], dropped: 0, incomplete: true }, 'nothing read is not dropped')
})

// A seeder stand-in (as test/diary-peek.test.js): certified by the
// association, it admits what is announced and advertises `have` without
// holding those cores, so a peek of them waits for block 0 until its
// deadline.
async function fakeSeeder (t, { signer, have }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', () => {})
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachBlocklist(noise, { current: () => null, offer: async () => ({ adopted: false, reason: 'same' }), compare: compareSnapshots, minIntervalMs: 0 })
      attachAdmission(noise, {
        role: 'seeder',
        cert,
        have,
        onmessage: (msg, peer) => {
          if (msg.type === 'announce') peer.send({ type: 'admitted', key: msg.key, length: peer.remoteHave.get(msg.key) || 0 })
        }
      })
    })
  })
  return 'ws://127.0.0.1:' + wss.address().port + '/seeder'
}

test('session: listing.ratings counts an unread certificate as incomplete and a blocked rater as dropped', async (t) => {
  t.timeout(60000)
  const assocKp = generateAssociationKeyPair()
  const slow = hex(crypto.keyPair().publicKey)
  const blocked = hex(crypto.keyPair().publicKey)
  const seederUrl = await fakeSeeder(t, { signer: assocKp, have: [{ key: slow, length: 5 }, { key: blocked, length: 5 }] })
  const storage = memoryNodeStorage()
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assocKp)
  await store.writeBlocklist(storage, createSnapshot({ seq: 1, blocked: [blocked] }, modKp, modCert))
  const keyPair = crypto.keyPair()
  const n = createBrowserNode({
    storage,
    association: hex(assocKp.publicKey),
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 300 },
    writeGate: false,
    peekTimeoutMs: 1500
  })
  t.teardown(() => n.close(), { force: true })
  await n.setKeyPair(keyPair)
  const web = await connectClient(n, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assocKp) })
  await web.request('sync.start', {})
  const author = hex(crypto.keyPair().publicKey)
  const timedOut = await web.request('listing.ratings', { author, seq: 1, refs: [{ rater: slow, seq: 2 }] })
  t.alike(timedOut, { items: [], dropped: 0, incomplete: true }, 'a certificate that never arrived is not a refusal')
  const refused = await web.request('listing.ratings', { author, seq: 1, refs: [{ rater: blocked, seq: 2 }] })
  t.alike(refused, { items: [], dropped: 1, incomplete: false }, 'a blocked rater is dropped')
})
