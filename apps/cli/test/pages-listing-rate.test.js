'use strict'

// A hosted page rates another member's Feira listing (apps/cli/lib/account/
// pages-routes.js listing-rate), end to end over loopback with the real
// pages writer: the listing author's consent names the page as the rater,
// one rating per offer, never a listing of the page's own people.

const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept, signClose } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { verifyConsent } = require('@varanda/core/lib/listing')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { feira, BLOCKED_TERMS } = require('@varanda/rpc')
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
  ctx.failRaw = false
  ctx.extraRaw = null

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
      readRawBlocks: (key) => {
        if (ctx.failRaw) {
          ctx.failRaw = false
          const err = new Error('fechado')
          err.code = 'fechado'
          return Promise.reject(err)
        }
        const extra = ctx.extraRaw
        ctx.extraRaw = null
        return extra === null ? real.readRawBlocks(key) : real.readRawBlocks(key).then((raw) => [...raw, extra])
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
      opts.pages = { keys, writer, pagesStore: acl, dir, blocklist: { has: (k) => ctx.blocked.has(k) } }
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

// The listing author's consent to `rater` for one offer, as listing.consent
// signs it.
function consentOf (author, listingSeq, rater, offer) {
  const payload = feira.dealPayload({ listingAuthor: author.hex, listingSeq, rater, offerId: offer })
  return hex(crypto.sign(b4a.from(payload), author.kp.secretKey))
}

const PLACE = { uf: 'SP', city: 'São Paulo', bairro: null }

function listingOp (fields = {}) {
  return { kind: 'servico', title: 'Conserto de bicicleta', text: 'Na garagem', price: 5000, unit: 'hora', cat: 'reparos', place: PLACE, ...fields }
}

function offerId (n) {
  return nodeCrypto.createHash('sha256').update('offer ' + n).digest('hex').slice(0, 32)
}

async function ratingsOf (ctx, page) {
  return (await ctx.writer.readEntries(page)).filter((e) => e.record && e.record.type === 'listing-rate')
}

test('a page rates a listing it dealt with, once per offer, never its own people', async (t) => {
  t.timeout(300000)
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

  // dani's listing 5, an offer the page made in its Conversas and dani's
  // consent naming the page as the rater.
  const o1 = offerId(1)
  const op = { to: dani.hex + ':5', offer: o1, consent: consentOf(dani, 5, K, o1), stars: 5, text: 'Ótimo atendimento' }
  const rated = await s.act(bia, 'listing-rate', K, op)
  t.is(rated.status, 200, JSON.stringify(rated.body))
  const R = rated.body.seq
  let ratings = await ratingsOf(ctx, K)
  t.is(ratings.length, 1)
  t.is(ratings[0].seq, R)
  t.alike(ratings[0].record.to, { author: dani.hex, seq: 5 })
  t.is(ratings[0].record.offer, o1)
  t.is(ratings[0].record.stars, 5)
  t.is(ratings[0].record.text, 'Ótimo atendimento')
  t.ok(verifyConsent({ listingAuthor: dani.hex, listingSeq: 5, rater: K, offerId: o1, consent: ratings[0].record.consent }), 'the reader verifies it with the page as the rater')

  // The same statement again answers the stored result, also after a
  // restart, and appends nothing.
  const length = ctx.writer.info(K).length
  const again = await api('POST', '/account/pages/listing-rate', rated.sent)
  t.is(again.status, 200)
  t.is(again.body.seq, R)
  await s.restart()
  // After the restart only the block holds the body: the same nonce with
  // another body is refused, not answered as the stored rating.
  const resign = (fields) => {
    const o = { ...op, ...fields }
    return { ...rated.sent, op: o, signature: s.sign(bia, 'listing-rate', rated.sent.nonce, K, o) }
  }
  for (const [fields, why] of [[{ stars: 1 }, 'other stars'], [{ text: 'Outro texto' }, 'another text'], [{ to: dani.hex + ':6' }, 'another listing']]) {
    const other = await api('POST', '/account/pages/listing-rate', resign(fields))
    t.is(other.body.error, 'expirado', 'the same nonce after a restart with ' + why)
  }
  ctx.failRaw = true
  t.is((await api('POST', '/account/pages/listing-rate', rated.sent)).body.error, 'indisponivel', 'an unreadable diary answers no replay')
  const later = await api('POST', '/account/pages/listing-rate', rated.sent)
  t.is(later.status, 200, JSON.stringify(later.body))
  t.is(later.body.seq, R, 'a resend after a restart answers the same seq')
  t.is(ctx.writer.info(K).length, length, 'a resend appends nothing')

  // One rating per offer: a new statement for the same offer is refused,
  // whatever it says.
  const second = await s.act(ana, 'listing-rate', K, { ...op, stars: 1, text: 'Mudei de ideia' })
  t.is(second.body.error, 'avaliacao-enviada', JSON.stringify(second.body))

  // No tombstone for a rating, as a person's node never writes one.
  t.is((await s.act(ana, 'delete', K, { to: K + ':' + R })).body.error, 'pedido-invalido', 'a rating cannot be deleted')

  // A consent that does not name this page and offer: for the admin's own
  // key, for another offer, signed by someone else, for the page's own
  // listing.
  const o2 = offerId(2)
  const refusals = [
    [{ ...op, offer: o2, consent: consentOf(dani, 5, bia.hex, o2) }, 'consentimento-invalido', 'consent for the admin, not the page'],
    [{ ...op, offer: o2 }, 'consentimento-invalido', 'consent for another offer'],
    [{ ...op, offer: o2, consent: consentOf(caio, 5, K, o2) }, 'consentimento-invalido', 'consent by another key'],
    [{ ...op, to: dani.hex + ':6', offer: o2, consent: consentOf(dani, 5, K, o2) }, 'consentimento-invalido', 'consent for another listing'],
    [{ ...op, offer: o2, consent: 'ab'.repeat(32) }, 'pedido-invalido', 'a consent of the wrong length'],
    [{ ...op, offer: 'xyz', consent: consentOf(dani, 5, K, o2) }, 'pedido-invalido', 'a bad offer id'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), stars: 6 }, 'pedido-invalido', 'six stars'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), stars: 0 }, 'pedido-invalido', 'no star'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), text: 'x'.repeat(feira.MAX_RATE_TEXT + 1) }, 'pedido-invalido', 'a text past the cap'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), text: undefined }, 'pedido-invalido', 'no text'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), extra: 1 }, 'pedido-invalido', 'an unknown key'],
    [{ ...op, to: dani.hex + ':0', offer: o2, consent: consentOf(dani, 5, K, o2) }, 'pedido-invalido', 'block 0 is no listing'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), text: BLOCKED_TERMS[0] }, 'termo-recusado', 'the word check'],
    [{ ...op, offer: o2, consent: consentOf(dani, 5, K, o2), text: 'Bom, ' + BLOCKED_TERMS[0] }, 'termo-recusado', 'the word check inside the text']
  ]
  for (const [bad, token, why] of refusals) {
    if (bad.text === undefined) delete bad.text
    t.is((await s.act(bia, 'listing-rate', K, bad)).body.error, token, why)
  }
  t.is((await s.act(bia, 'listing-rate', K, { ...op, to: K + ':1', offer: o2, consent: consentOf({ hex: K, kp: { secretKey: crypto.keyPair().secretKey } }, 1, K, o2) })).body.error,
    'consentimento-invalido', 'the page never rates its own listing')

  // Self-rating: a listing by the acting admin, or by the owner, with a
  // consent that verifies.
  const o3 = offerId(3)
  t.is((await s.act(bia, 'listing-rate', K, { ...op, to: bia.hex + ':2', offer: o3, consent: consentOf(bia, 2, K, o3) })).body.error, 'avaliacao-propria', 'the acting admin\'s own listing')
  t.is((await s.act(bia, 'listing-rate', K, { ...op, to: ana.hex + ':2', offer: o3, consent: consentOf(ana, 2, K, o3) })).body.error, 'avaliacao-propria', 'the owner\'s listing')
  t.is((await s.act(ana, 'listing-rate', K, { ...op, to: bia.hex + ':2', offer: o3, consent: consentOf(bia, 2, K, o3) })).body.error, 'avaliacao-propria', 'an admin\'s listing')
  t.is((await s.act(ana, 'listing-rate', K, { ...op, to: bia.hex.toUpperCase() + ':2', offer: o3, consent: consentOf(bia, 2, K, o3) })).body.error, 'avaliacao-propria', 'an uppercase author is normalized, then refused')

  // The diary an admin's core delegate row names is the admin's own.
  const deleg = member()
  await ctx.pagesStore.setDelegate(ana.hex, { diary: deleg.hex, length: 1, termsVersion: TERMS_VERSION })
  t.is((await s.act(bia, 'listing-rate', K, { ...op, to: deleg.hex + ':2', offer: o3, consent: consentOf(deleg, 2, K, o3) })).body.error, 'avaliacao-propria', 'the owner\'s delegate diary')
  await ctx.pagesStore.setDelegate(ana.hex, null)

  // A sibling page that shares an admin: caio's page, where bia is an
  // admin too, consents through its own key.
  const banca = await s.create(caio, 'banca')
  t.is(banca.status, 200, JSON.stringify(banca.body))
  const K2 = banca.page
  t.is((await s.invite(caio, K2, bia, ctx.pagesStore.get(K2))).status, 200)
  const inv2 = ctx.pagesStore.listFor(bia.hex).invites.find((i) => i.page === K2)
  t.is((await s.accept(bia, K2, inv2.gen, inv2.rosterSignature)).status, 200)
  const posted = await s.act(caio, 'listing', K2, listingOp())
  t.is(posted.status, 200, JSON.stringify(posted.body))
  const L2 = posted.body.seq
  const signed = await s.act(caio, 'listing-consent', K2, { to: K2 + ':' + L2, rater: K, offer: o3 })
  t.is(signed.status, 200, JSON.stringify(signed.body))
  t.ok(verifyConsent({ listingAuthor: K2, listingSeq: L2, rater: K, offerId: o3, consent: signed.body.consent }), 'the sibling\'s consent verifies')
  const siblingOp = { ...op, to: K2 + ':' + L2, offer: o3, consent: signed.body.consent }
  t.is((await s.act(ana, 'listing-rate', K, siblingOp)).body.error, 'avaliacao-propria', 'a sibling page run by an admin')

  // A rating only the raw blocks still show (a tombstone written with a
  // leaked key, which this writer never appends) still holds its offer.
  const o8 = offerId(8)
  ctx.extraRaw = { seq: ctx.writer.info(K).length, record: { ...ratings[0].record, offer: o8 } }
  t.is((await s.act(bia, 'listing-rate', K, { ...op, offer: o8, consent: consentOf(dani, 5, K, o8) })).body.error, 'avaliacao-enviada', 'a rating in the raw blocks counts')

  // A raw read that fails refuses rather than counting as no rating.
  ctx.failRaw = true
  t.is((await s.act(bia, 'listing-rate', K, { ...op, offer: o3, consent: consentOf(dani, 5, K, o3) })).body.error, 'indisponivel', 'an unreadable diary fails closed')

  // A stranger, and a blocked author.
  const o4 = offerId(4)
  const fresh = { ...op, offer: o4, consent: consentOf(dani, 5, K, o4) }
  t.is((await s.act(caio, 'listing-rate', K, fresh)).body.error, 'sem-permissao', 'a stranger cannot rate as the page')
  ctx.blocked.add(dani.hex)
  t.is((await s.act(bia, 'listing-rate', K, fresh)).body.error, 'sem-permissao', 'never a blocked author')
  ctx.blocked.delete(dani.hex)
  t.is(ctx.writer.info(K).length, length, 'no refusal appends')

  // Another offer of the same deal partner is another rating.
  const other = await s.act(ana, 'listing-rate', K, fresh)
  t.is(other.status, 200, JSON.stringify(other.body))
  ratings = await ratingsOf(ctx, K)
  t.is(ratings.length, 2)

  // Once bia is removed, she cannot rate for the page.
  row = ctx.pagesStore.get(K)
  t.is((await s.rosterAct('remove', ana, K, { gen: row.gen + 1, owner: ana.hex, admins: [], prev: row.rosterSeq })).status, 200)
  const o5 = offerId(5)
  t.is((await s.act(bia, 'listing-rate', K, { ...op, offer: o5, consent: consentOf(dani, 5, K, o5) })).body.error, 'sem-permissao', 'a removed admin')
  // A former admin's own listing is no longer the page's people.
  const exAdmin = await s.act(ana, 'listing-rate', K, { ...op, to: bia.hex + ':2', offer: o5, consent: consentOf(bia, 2, K, o5) })
  t.is(exAdmin.status, 200, JSON.stringify(exAdmin.body))

  // A member with a pending invite, and the target of a pending transfer,
  // are about to be the page's people.
  const eva = await s.newMember('eva')
  const fil = await s.newMember('fil')
  row = ctx.pagesStore.get(K)
  t.is((await s.invite(ana, K, eva, row)).status, 200)
  const o7 = offerId(7)
  t.is((await s.act(ana, 'listing-rate', K, { ...op, to: eva.hex + ':2', offer: o7, consent: consentOf(eva, 2, K, o7) })).body.error, 'avaliacao-propria', 'a pending invitee')
  await ctx.pagesStore.offer(K, fil.hex, new Date(Date.now() + 3600000).toISOString())
  t.is((await s.act(ana, 'listing-rate', K, { ...op, to: fil.hex + ':2', offer: o7, consent: consentOf(fil, 2, K, o7) })).body.error, 'avaliacao-propria', 'a pending transfer target')
  await ctx.pagesStore.cancel(K)

  // A closed page rates nothing.
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  const o6 = offerId(6)
  t.is((await s.act(ana, 'listing-rate', K, { ...op, offer: o6, consent: consentOf(dani, 5, K, o6) })).body.error, 'encerrada')
})
