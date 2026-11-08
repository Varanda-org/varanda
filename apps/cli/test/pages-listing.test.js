'use strict'

// Feira listings as a hosted page (apps/cli/lib/account/pages-routes.js
// listing, listing-edit, listing-status, listing-consent, delete and close),
// end to end over loopback: the same account service and real pages writer
// as account-pages.test.js, with a fake page inbox for the consent.

const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept, signClose } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { foldListings, verifyConsent } = require('@varanda/core/lib/listing')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createAccountServer } = require('../lib/account/server')

const fs = require('node:fs')
const path = require('node:path')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function googleStub () {
  return { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } }
}

let subSeq = 100
async function linkDirect (store, ctx, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '40000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, ctx.issuerKp, ctx.issuerCert, ctx.association)
}

function be16 (n) {
  return [(n >> 8) & 0xff, n & 0xff]
}

function jpeg (width, height, size) {
  const head = b4a.from([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  const out = b4a.alloc(size, 0x5a)
  head.copy(out, 0)
  out[size - 2] = 0xff
  out[size - 1] = 0xd9
  return out
}

function sha (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function prepareSeederDir (t, assocKp) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp)))
  Seeder.addCert(dataDir, certFile, association)
  return dataDir
}

async function setup (t, { pages = true, storeNow = Date.now, serverOpts = {} } = {}) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const ctx = { assocKp, association, issuerKp, issuerCert, bootstrap }
  // Faults the tests switch on: each fires once.
  ctx.failCreate = false
  ctx.failAppend = null
  ctx.failExpect = false
  ctx.pausedInfo = false
  ctx.holdAppend = null
  ctx.engagement = null

  const dir = tmpDir(t, 'varanda-account-')
  const store = openAccountStore(dir, { now: storeNow })
  const terms = openTermsStore(dir)
  const logs = []
  const opts = {
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log: (e) => logs.push(e),
    ...serverOpts
  }
  ctx.dir = dir
  let keys = null
  let wsPort = null
  if (pages) {
    const seederDir = prepareSeederDir(t, assocKp)
    const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
    t.teardown(() => seeder.close(), { force: true })
    await seeder.start()
    const ws = await startSeedWs({ port: 0, seeder })
    t.teardown(() => ws.close(), { force: true })
    ctx.seedPort = ws.port
    wsPort = ws.port
    keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
    ctx.blocked = new Set()
  }

  // A writer and an ACL whose next call can be made to fail.
  function faulty (real, pagesStore) {
    const writer = Object.assign({}, real, {
      createPage: (args) => {
        if (ctx.failCreate) {
          ctx.failCreate = false
          const err = new Error('limite')
          err.code = 'limite'
          return Promise.reject(err)
        }
        return real.createPage(args)
      },
      append: async (key, records, idem) => {
        const when = ctx.failAppend
        ctx.failAppend = null
        const hold = ctx.holdAppend
        ctx.holdAppend = null
        if (hold) await hold
        if (when === 'before') throw new Error('perdida')
        const res = await real.append(key, records, idem)
        if (when === 'after') throw new Error('perdida')
        return res
      },
      info: (key) => ctx.pausedInfo ? { ...real.info(key), paused: true } : real.info(key),
      engagement: (key) => ctx.engagement ? Promise.resolve(ctx.engagement) : real.engagement(key)
    })
    const acl = Object.assign({}, pagesStore, {
      expectLength: (...args) => {
        if (ctx.failExpect) {
          ctx.failExpect = false
          return Promise.reject(new Error('perdida'))
        }
        return pagesStore.expectLength(...args)
      }
    })
    return { writer, acl }
  }

  let listener = null
  let base = null
  async function boot () {
    if (pages) {
      const real = createPagesWriter({ dir, keys, association, seederWs: 'http://127.0.0.1:' + wsPort, log: () => {} })
      t.teardown(() => real.close(), { force: true })
      await real.ready()
      await until(() => real.connected(), { name: 'link up', timeoutMs: 20000 })
      ctx.writer = real
      ctx.pagesStore = openPagesStore(dir)
      const { writer, acl } = faulty(real, ctx.pagesStore)
      opts.pages = { keys, writer, pagesStore: acl, dir, blocklist: { has: (k) => ctx.blocked.has(k) }, pagesDm: fakeDm(ctx) }
    }
    const server = createAccountServer(opts)
    const l = await server.listen({ host: '127.0.0.1', port: 0 })
    t.teardown(() => l.close(), { force: true })
    listener = l
    base = 'http://127.0.0.1:' + l.port
  }
  await boot()

  // A new routes instance, writer and ACL over the same data dir, as after
  // a crash: nothing in memory survives.
  async function restart () {
    await listener.close()
    await ctx.writer.close()
    await boot()
  }

  async function api (method, pathname, body, headers = {}) {
    const init = { method, headers: { ...headers } }
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      if (b4a.isBuffer(body)) {
        init.headers['content-type'] = 'application/octet-stream'
        init.body = body
      } else {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  let termsCount = 0
  async function newMember (username, { accept = true } = {}) {
    const m = member()
    if (username) await linkDirect(store, ctx, m, username)
    if (accept) {
      termsCount++
      await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'T'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    }
    return m
  }

  async function start (m, action) {
    const r = await api('POST', '/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status + ' ' + JSON.stringify(r.body))
    return r.body
  }

  function sign (m, action, nonce, page, op) {
    return signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  }

  // A statement action from start to the answer.
  async function act (m, action, page, op, extra = {}) {
    const { nonce } = await start(m, action)
    const body = { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op), ...extra }
    const r = await api('POST', '/account/pages/' + action, body)
    return { ...r, sent: body }
  }

  function roster (m, page, fields, nonce) {
    const f = { page, ...fields, at: new Date().toISOString(), nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  async function create (m, username) {
    const { nonce, page } = await start(m, 'create')
    const record = roster(m, page, { gen: 1, owner: m.hex, admins: [], prev: null }, nonce)
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('POST', '/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    return { ...r, page }
  }

  async function invite (owner, page, who, row) {
    const { nonce } = await start(owner, 'invite')
    const admins = [...row.admins.filter((a) => a !== owner.hex), who.hex].sort()
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins, prev: row.rosterSeq }, nonce)
    const op = { member: who.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: owner.hex, admins, prev: row.rosterSeq, at: record.at, nonce } }
    return api('POST', '/account/pages/invite', { member: owner.hex, nonce, page, op, signature: sign(owner, 'invite', nonce, page, op), record })
  }

  async function accept (who, page, gen, rosterSignature) {
    const { nonce } = await start(who, 'accept')
    const f = { page, gen, rosterSignature, at: new Date().toISOString(), nonce, actor: who.hex }
    const record = { type: 'page-accept', ...f, signature: signAccept(f, who.kp) }
    return api('POST', '/account/pages/accept', { member: who.hex, nonce, page, record })
  }

  async function rosterAct (action, m, page, fields) {
    const { nonce } = await start(m, action)
    const record = roster(m, page, fields, nonce)
    return api('POST', '/account/pages/' + action, { member: m.hex, nonce, page, record })
  }

  async function upload (m, page, bytes, op) {
    const { nonce } = await start(m, 'media')
    return api('POST', '/account/pages/media', bytes, {
      'x-varanda-page-member': m.hex,
      'x-varanda-page-nonce': nonce,
      'x-varanda-page-page': page,
      'x-varanda-page-signature': sign(m, 'media', nonce, page, op),
      'x-varanda-page-op': JSON.stringify(op)
    })
  }

  async function close (m, page) {
    const { nonce } = await start(m, 'close')
    const f = { page, gen: ctx.pagesStore.get(page).gen + 1, at: new Date().toISOString(), nonce, actor: m.hex, association }
    return api('POST', '/account/pages/close', { member: m.hex, nonce, page, record: { type: 'page-close', ...f, signature: signClose(f, m.kp) } })
  }

  return { ctx, store, terms, api, logs, newMember, start, sign, act, create, invite, accept, rosterAct, upload, close, restart }
}
// The page inbox listing-consent reads (pages-dm.js thread shape): newest
// last, `next` the id of the oldest row returned when older ones exist.
function fakeDm (ctx) {
  ctx.inbox = []
  return {
    enable: async () => {},
    stop: async () => {},
    forget: async () => {},
    thread: async (page, { peer, before = null, limit = 30 }) => {
      const all = ctx.inbox.filter((m) => m.page === page && m.from === peer).map(({ page, ...m }) => m)
      let end = all.length
      if (before !== null) {
        const i = all.findIndex((m) => m.id === before)
        if (i !== -1) end = i
      }
      const startAt = Math.max(0, end - limit)
      const rows = all.slice(startAt, end)
      return { messages: rows, next: startAt > 0 && rows.length > 0 ? rows[0].id : null, folder: 'inbox', blocked: false }
    }
  }
}

const PLACE = { uf: 'SP', city: 'São Paulo', bairro: null }

function listingOp (fields = {}) {
  return { kind: 'servico', title: 'Conserto de bicicleta', text: 'Na garagem', price: 5000, unit: 'hora', cat: 'reparos', place: PLACE, ...fields }
}

function editOp (to, expectedRevision, fields = {}) {
  return { to, expectedRevision, title: 'Conserto rápido', text: 'Na garagem', price: 6000, unit: 'hora', cat: 'reparos', place: PLACE, media: null, ...fields }
}

async function fold (ctx, page) {
  return foldListings(await ctx.writer.readEntries(page))
}

async function deletesOf (ctx, page) {
  return (await ctx.writer.readEntries(page)).filter((e) => e.record && e.record.type === 'delete').map((e) => e.record)
}

test('page listings: create, edit, status, consent, delete, close, cap and replay', async (t) => {
  t.timeout(300000)
  // About 150 requests: past the default global bucket of 100.
  const s = await setup(t, { serverOpts: { ratePerSecond: 1000, burst: 1000 } })
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const dani = member()

  const made = await s.create(ana, 'oficina')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  let row = ctx.pagesStore.get(K)
  t.is((await s.invite(ana, K, bia, row)).status, 200)
  const inv = ctx.pagesStore.listFor(bia.hex).invites[0]
  t.is((await s.accept(bia, K, inv.gen, inv.rosterSignature)).status, 200)

  // The owner posts a listing with a photo and a unit; the page signs it.
  const img = jpeg(640, 480, 20 * 1024)
  const up = await s.upload(ana, K, img, { sha256: sha(img), mime: 'image/jpeg', width: 640, height: 480, bytes: img.length })
  t.is(up.status, 200, JSON.stringify(up.body))
  const d = up.body.descriptor
  const created = await s.act(ana, 'listing', K, listingOp({ media: [d] }))
  t.is(created.status, 200, JSON.stringify(created.body))
  const L = created.body.seq
  let item = (await fold(ctx, K)).bySeq.get(L)
  t.is(item.record.unit, 'hora')
  t.alike(item.record.media, [d])
  t.is(item.status, 'disponivel')

  // A repeated nonce answers the same seq and appends nothing.
  let length = ctx.writer.info(K).length
  const again = await api('POST', '/account/pages/listing', created.sent)
  t.is(again.status, 200)
  t.is(again.body.seq, L)
  t.is(ctx.writer.info(K).length, length, 'a replay appends nothing')

  // Refusals append nothing: a media descriptor the page never stored, a
  // unit the kind refuses, a stranger.
  t.is((await s.act(ana, 'listing', K, listingOp({ media: [{ ...d, sha256: 'ab'.repeat(32) }] }))).body.error, 'midia-invalida')
  t.is((await s.act(ana, 'listing', K, listingOp({ kind: 'produto' }))).body.error, 'pedido-invalido', 'a produto has no hourly price')
  t.is((await s.act(caio, 'listing', K, listingOp())).body.error, 'sem-permissao', 'a stranger cannot post a listing')
  t.is(ctx.writer.info(K).length, length)

  // The admin edits twice; the second edit retires the first in the same
  // append, and the public seq of the listing stays L.
  const e1 = await s.act(bia, 'listing-edit', K, editOp(K + ':' + L, 0, { media: [d] }))
  t.is(e1.status, 200, JSON.stringify(e1.body))
  const E1 = e1.body.seq
  t.is((await fold(ctx, K)).bySeq.get(L).editSeq, E1)
  const before2 = ctx.writer.info(K).length
  const e2 = await s.act(bia, 'listing-edit', K, editOp(K + ':' + L, E1, { title: 'Conserto e revisão' }))
  t.is(e2.status, 200, JSON.stringify(e2.body))
  t.is(ctx.writer.info(K).length, before2 + 2, 'the edit and the tombstone of the previous edit')
  item = (await fold(ctx, K)).bySeq.get(L)
  t.is(item.seq, L, 'the public seq is unchanged')
  t.is(item.record.title, 'Conserto e revisão')
  const E2 = item.editSeq
  t.is(E2, before2)
  t.is(e2.body.seq, E2, 'the answer is the edit block, the next expectedRevision')
  t.is((await api('POST', '/account/pages/listing-edit', e2.sent)).body.seq, E2, 'a replay answers the same edit seq')
  // The answer is the next expectedRevision: an edit built on it works.
  const e3 = await s.act(bia, 'listing-edit', K, editOp(K + ':' + L, e2.body.seq, { title: 'Conserto e revisão' }))
  t.is(e3.status, 200, JSON.stringify(e3.body))
  const E3 = e3.body.seq
  t.is((await fold(ctx, K)).bySeq.get(L).editSeq, E3)
  t.is((await api('POST', '/account/pages/listing-edit', e3.sent)).body.seq, E3, 'a replay answers the same edit seq')
  await s.restart()
  t.is((await api('POST', '/account/pages/listing-edit', e3.sent)).body.seq, E3, 'a replay after a restart answers the edit seq')
  t.ok((await deletesOf(ctx, K)).some((r) => r.seq === E1), 'the previous edit is tombstoned')
  t.is(item.record.media, undefined, 'the new edit dropped the photo')

  // A stale expectedRevision appends nothing.
  length = ctx.writer.info(K).length
  const stale = await s.act(bia, 'listing-edit', K, editOp(K + ':' + L, E1))
  t.is(stale.status, 409)
  t.is(stale.body.error, 'conflito')
  t.is((await s.act(bia, 'listing-edit', K, editOp(K + ':' + L, E3, { unit: 'a-partir', price: 0 }))).body.error, 'pedido-invalido', 'a unit with no price')
  t.is(ctx.writer.info(K).length, length)

  // Status: reservado on a servico, never on a procura, never at a post.
  const st = await s.act(bia, 'listing-status', K, { to: K + ':' + L, status: 'reservado' })
  t.is(st.status, 200, JSON.stringify(st.body))
  t.is((await fold(ctx, K)).bySeq.get(L).status, 'reservado')
  const wanted = await s.act(ana, 'listing', K, listingOp({ kind: 'procura', title: 'Procuro bicicleta', price: null, unit: null, cat: 'esporte' }))
  t.is(wanted.status, 200, JSON.stringify(wanted.body))
  const P = wanted.body.seq
  const post = await s.act(ana, 'post', K, { text: 'oficina aberta' })
  t.is(post.status, 200)
  length = ctx.writer.info(K).length
  t.is((await s.act(ana, 'listing-status', K, { to: K + ':' + P, status: 'reservado' })).body.error, 'pedido-invalido', 'a procura is never reserved')
  t.is((await s.act(ana, 'listing-status', K, { to: K + ':' + post.body.seq, status: 'vendido' })).body.error, 'pedido-invalido', 'status at a post')
  t.is((await s.act(ana, 'listing-edit', K, editOp(K + ':' + post.body.seq, 0))).body.error, 'pedido-invalido', 'edit at a post')
  t.is((await s.act(caio, 'listing-status', K, { to: K + ':' + L, status: 'vendido' })).body.error, 'sem-permissao')
  t.is(ctx.writer.info(K).length, length)

  // Consent: refused until the page inbox holds the member's offer for this
  // listing, then the page key signs a deal naming the member as rater.
  const offer = 'a1'.repeat(16)
  const consentOp = { to: K + ':' + L, rater: dani.hex, offer }
  t.is((await s.act(bia, 'listing-consent', K, consentOp)).body.error, 'oferta-ausente')
  ctx.inbox.push({ page: K, id: offer, from: dani.hex, text: 'Topa?', replyTo: null, fwd: 0, media: [], card: { url: ORIGIN + '/f/' + K + '/' + L + '#oferta=4500&aceite=' + 'b'.repeat(128) }, at: new Date().toISOString(), mine: false })
  t.is((await s.act(bia, 'listing-consent', K, consentOp)).body.error, 'oferta-ausente', 'an answer is not an offer')
  ctx.inbox.push({ page: K, id: 'c3'.repeat(16), from: dani.hex, text: ORIGIN + '/f/' + K + '/' + P + '#oferta=4500', replyTo: null, fwd: 0, media: [], card: null, at: new Date().toISOString(), mine: false })
  t.is((await s.act(bia, 'listing-consent', K, { ...consentOp, offer: 'c3'.repeat(16) })).body.error, 'oferta-ausente', 'an offer for another listing')
  ctx.inbox.length = 0
  for (let i = 0; i < 60; i++) {
    ctx.inbox.push({ page: K, id: (i.toString(16).padStart(2, '0')).repeat(16), from: dani.hex, text: 'oi', replyTo: null, fwd: 0, media: [], card: null, at: new Date().toISOString(), mine: false })
  }
  ctx.inbox.splice(5, 0, { page: K, id: offer, from: dani.hex, text: ORIGIN + '/f/' + K + '/' + L + '#oferta=4500', replyTo: null, fwd: 0, media: [], card: null, at: new Date().toISOString(), mine: false })
  t.is((await s.act(bia, 'listing-consent', K, { ...consentOp, rater: K })).body.error, 'pedido-invalido', 'the page never rates itself')
  length = ctx.writer.info(K).length
  const signed = await s.act(bia, 'listing-consent', K, consentOp)
  t.is(signed.status, 200, JSON.stringify(signed.body))
  t.ok(verifyConsent({ listingAuthor: K, listingSeq: L, rater: dani.hex, offerId: offer, consent: signed.body.consent }), 'verifies for the page key and the member')
  t.absent(verifyConsent({ listingAuthor: K, listingSeq: L, rater: caio.hex, offerId: offer, consent: signed.body.consent }), 'names only that rater')
  ctx.inbox.length = 0
  const resent = await api('POST', '/account/pages/listing-consent', signed.sent)
  t.is(resent.status, 200)
  t.is(resent.body.consent, signed.body.consent, 'a repeated nonce answers the same signature')
  t.is(ctx.writer.info(K).length, length, 'consent appends nothing')
  t.is((await s.act(caio, 'listing-consent', K, consentOp)).body.error, 'sem-permissao')

  // A removed admin is refused.
  row = ctx.pagesStore.get(K)
  t.is((await s.rosterAct('remove', ana, K, { gen: row.gen + 1, owner: ana.hex, admins: [], prev: row.rosterSeq })).status, 200)
  t.is((await s.act(bia, 'listing-status', K, { to: K + ':' + L, status: 'vendido' })).body.error, 'sem-permissao')
  t.is((await s.act(bia, 'listing', K, listingOp())).body.error, 'sem-permissao')

  // Delete removes the root and its live edit, with the photo's range.
  const del = await s.act(ana, 'delete', K, { to: K + ':' + L })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.absent((await fold(ctx, K)).bySeq.has(L), 'the listing is gone')
  const dels = await deletesOf(ctx, K)
  t.ok(dels.some((r) => r.seq === L), 'the root is tombstoned')
  t.ok(dels.some((r) => r.seq === E3), 'the live edit is tombstoned')
  t.ok(dels.some((r) => (r.seq === L || r.seq === E3) && Array.isArray(r.media) && r.media.some((m) => m.core === d.core && m.start === d.start)), 'the photo range is freed')
  t.is((await s.act(ana, 'delete', K, { to: K + ':' + E3 })).body.error, 'pedido-invalido', 'an edit is not deleted on its own')
  ctx.inbox.push({ page: K, id: offer, from: dani.hex, text: ORIGIN + '/f/' + K + '/' + L + '#oferta=4500', replyTo: null, fwd: 0, media: [], card: null, at: new Date().toISOString(), mine: false })
  t.is((await s.act(ana, 'listing-consent', K, consentOp)).body.error, 'pedido-invalido', 'no consent for a deleted listing')
  t.is((await s.act(ana, 'listing-consent', K, { ...consentOp, to: K + ':' + post.body.seq })).body.error, 'pedido-invalido', 'no consent for a post')
  t.is((await s.act(ana, 'listing-consent', K, { ...consentOp, to: caio.hex + ':' + L })).body.error, 'pedido-invalido', 'no consent for another diary')

  // At most 30 live listings: the 31st is limite and appends nothing.
  let live = (await fold(ctx, K)).items.length
  while (live < 30) {
    const r = await s.act(ana, 'listing', K, listingOp({ title: 'Anúncio ' + live }))
    t.is(r.status, 200, JSON.stringify(r.body))
    live++
  }
  length = ctx.writer.info(K).length
  const over = await s.act(ana, 'listing', K, listingOp({ title: 'Anúncio 31' }))
  t.is(over.body.error, 'limite')
  t.is(ctx.writer.info(K).length, length)

  // Close tombstones every live listing.
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  const roots = (await fold(ctx, K)).items
  t.is(roots.length, 0, 'no listing survives the close')
})
