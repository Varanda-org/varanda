'use strict'

// The phone gate on the account service's signed member writes
// (apps/cli/lib/account/server.js phoneChecked, passed to push-routes.js,
// seen-routes.js, pages-routes.js and feira-routes.js): with phone
// verification on, a linked member without a checked number turns no push
// on, writes no seen blob, creates no page and gets no Feira code charged to
// it. Loopback only: the Didit fake of helpers/fake-didit.js (never reached
// by these tests), real stores in a tmp dir, a fake push service, a fake
// pages writer and a fake listing reader.

const test = require('brittle')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { signSeen, blobHash, HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { seal, seenKeyFromSeed } = require('@varanda/core/lib/seen-blob')
const { signRoster } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPushStore } = require('../lib/account/push-store')
const { openSeenStore } = require('../lib/account/seen-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { pairInvites } = require('../lib/account/invites-pair')
const { createPhoneClient } = require('../lib/account/phone-client')
const { generateVapidKeys } = require('../lib/account/web-push')
const { createAccountServer } = require('../lib/account/server')
const { startFakeDidit, loopbackFetch } = require('./helpers/fake-didit')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const API_KEY = 'test-phone-key-123'
const PAGE_KEYS = 'cd'.repeat(32)
const FEIRA_OPTS = { file: 'feira-invites.json', ttlMs: 3600 * 1000, capOn: 'use', maxRows: 20000, pruneUnused: true }
const PHONE_A = '+5511987654321'
const PHONE_B = '+5521912345678'
const PHONE_CBS = { linked: () => true, burnable: () => false, deleted: () => false }

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

let subSeq = 100
async function linkDirect (store, iss, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '50000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

function subscription () {
  const ua = nodeCrypto.createECDH('prime256v1')
  ua.generateKeys()
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + nodeCrypto.randomBytes(16).toString('hex'),
    p256dh: ua.getPublicKey().toString('base64url'),
    auth: nodeCrypto.randomBytes(16).toString('base64url')
  }
}

// A pages writer that keeps nothing: it records each createPage and append.
function fakeWriter () {
  const w = { created: [], appended: [] }
  w.nonceRecord = () => {
    const err = new Error('nao-encontrada')
    err.code = 'nao-encontrada'
    throw err
  }
  w.createPage = async (args) => { w.created.push(args) }
  w.append = async (page, records) => {
    w.appended.push({ page, records })
    return { seq: 9, length: 10, pushed: true }
  }
  w.wipe = async () => {}
  return w
}

// `phone: false` runs with phone verification off.
async function setup (t, { phone = true } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const pushStore = openPushStore(dir)
  const seenStore = openSeenStore(dir)
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const phones = phone ? openPhoneStore(dir, { key: nodeCrypto.randomBytes(32) }) : null
  const phoneClient = phone ? createPhoneClient({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) }) : null
  const writer = fakeWriter()
  const pagesStore = openPagesStore(dir)
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const primary = openInvitesStore(dir, { perWeek: 2, isUsed: (id) => store.inviteUsed(id) })
  const feiraStore = openInvitesStore(dir, { ...FEIRA_OPTS, perWeek: 3, isUsed: (id) => store.inviteUsed(id) })
  const reads = []
  const listingReader = {
    readListing: async (author, seq) => {
      reads.push([author, seq])
      return { record: { type: 'listing', kind: 'produto', title: 'Bicicleta' }, author, seq }
    },
    readCurrent: async () => 'ausente'
  }
  const delivered = []
  const vapid = generateVapidKeys()
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    terms,
    push: { pushStore, vapid: { ...vapid, subject: ORIGIN }, send: async (args) => { delivered.push(args); return { ok: true } } },
    seen: seenStore,
    phoneClient,
    phones,
    pages: { keys, writer, pagesStore, dir, blocklist: { has: () => false } },
    invites: pairInvites(primary, feiraStore),
    feiraInvites: feiraStore,
    listingReader,
    log: () => {}
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function post (pathname, body) {
    const res = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  let termsCount = 0
  async function newMember (username) {
    const m = member()
    await linkDirect(store, iss, m, username)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'T'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    return m
  }

  const recordPhone = (m, number) => phones.record({ member: m.hex, phone: number }, PHONE_CBS)

  async function push (m, action, sub) {
    const started = await post('/account/push/start', { member: m.hex, action })
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    const signature = signPush({ nonce, member: m.hex, association: iss.association, action, endpointHash: endpointHash(sub.endpoint), p256dh: sub.p256dh, auth: sub.auth }, m.kp)
    return post('/account/push/finish', { member: m.hex, nonce, action, signature, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
  }

  function sealed (m) {
    const key = seenKeyFromSeed(m.kp.secretKey.subarray(0, 32), iss.association, m.hex)
    return seal({ gen: 1, member: m.hex, association: iss.association, avisos: { own: [], pages: {} }, dm: [], groups: [] }, key)
  }

  async function seen (m, action, prevHash = HASH_NONE, blob = null) {
    const started = await post('/account/seen/start', { member: m.hex, action })
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    const newHash = blob === null ? HASH_NONE : blobHash(blob)
    const signature = signSeen({ nonce, member: m.hex, association: iss.association, action, prevHash, newHash }, m.kp)
    const body = { member: m.hex, nonce, action, signature, prevHash }
    if (blob !== null) body.blob = b4a.toString(blob, 'base64')
    return post('/account/seen/finish', body)
  }

  // The signed body of a page creation, to send (and resend) as is.
  async function createBody (m, username) {
    const started = await post('/account/pages/start', { member: m.hex, action: 'create' })
    if (started.status !== 200) throw new Error('pages start ' + started.status + ' ' + started.text)
    const { nonce, page } = started.body
    const f = { page, gen: 1, owner: m.hex, admins: [], prev: null, at: new Date().toISOString(), nonce, association: iss.association }
    const record = { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const signature = signPage({ action: 'create', nonce, member: m.hex, page, association: iss.association, opHash: opHash(op) }, m.kp)
    return { member: m.hex, nonce, page, op, signature, record }
  }

  const feira = (author, seq = 3) => post('/account/feira/start', { author, seq })

  return { dir, iss, store, terms, pushStore, seenStore, phones, writer, pagesStore, feiraStore, reads, delivered, post, newMember, recordPhone, push, sealed, seen, createBody, feira }
}

test('phone gates: push on is telefone-pendente without a number and stores nothing, then passes', async (t) => {
  const s = await setup(t)
  const m = await s.newMember('ana')
  const sub = subscription()
  const refused = await s.push(m, 'on', sub)
  t.is(refused.status, 403)
  t.alike(refused.body, { error: 'telefone-pendente' })
  t.is(s.pushStore.list(m.hex).length, 0, 'no subscription stored')
  await s.recordPhone(m, PHONE_A)
  const on = await s.push(m, 'on', sub)
  t.is(on.status, 200)
  t.alike(on.body, { ok: true, changed: true })
  t.is(s.pushStore.list(m.hex).length, 1)
})

test('phone gates: push off passes without a number', async (t) => {
  const s = await setup(t)
  const m = await s.newMember('ana')
  const sub = subscription()
  await s.pushStore.put({ member: m.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
  const off = await s.push(m, 'off', sub)
  t.is(off.status, 200)
  t.alike(off.body, { ok: true, changed: true })
  t.is(s.pushStore.list(m.hex).length, 0)
})

test('phone gates: a seen write is telefone-pendente without a number and writes nothing, then passes', async (t) => {
  const s = await setup(t)
  const m = await s.newMember('ana')
  const blob = s.sealed(m)
  const refused = await s.seen(m, 'write', HASH_NONE, blob)
  t.is(refused.status, 403)
  t.alike(refused.body, { error: 'telefone-pendente' })
  t.is(s.seenStore.get(m.hex), null, 'no blob stored')
  await s.recordPhone(m, PHONE_A)
  const wrote = await s.seen(m, 'write', HASH_NONE, blob)
  t.is(wrote.status, 200)
  t.is(wrote.body.hash, blobHash(blob))
})

test('phone gates: a seen read and delete pass without a number', async (t) => {
  const s = await setup(t)
  const m = await s.newMember('ana')
  const read = await s.seen(m, 'read')
  t.is(read.status, 200)
  t.alike(read.body, { hash: null, blob: null })
  const removed = await s.seen(m, 'delete')
  t.is(removed.status, 200)
  t.is(removed.body.ok, true)
})

test('phone gates: a page creation is telefone-pendente without a number and writes nothing, then the same request passes', async (t) => {
  const s = await setup(t)
  const m = await s.newMember('ana')
  const body = await s.createBody(m, 'padaria')
  const refused = await s.post('/account/pages/create', body)
  t.is(refused.status, 403)
  t.alike(refused.body, { error: 'telefone-pendente' })
  t.is(s.writer.created.length, 0, 'no page diary created')
  t.is(s.writer.appended.length, 0, 'nothing appended')
  t.is(s.store.lookup('padaria'), null, 'no name reserved')
  t.is(s.pagesStore.get(body.page), null, 'no ACL row')
  await s.recordPhone(m, PHONE_A)
  const created = await s.post('/account/pages/create', body)
  t.is(created.status, 200)
  t.is(created.body.page, body.page)
  t.is(s.writer.created.length, 1)
  t.is(s.pagesStore.get(body.page).owner, m.hex)
})

test('phone gates: a Feira code for a seller or a page owner without a number answers as for an unlinked owner', async (t) => {
  const s = await setup(t)
  const seller = await s.newMember('ana')
  const stranger = member()
  const unlinked = await s.feira(stranger.hex)
  const refused = await s.feira(seller.hex)
  t.is(refused.status, unlinked.status)
  t.is(refused.text, unlinked.text, 'the same answer as for an unlinked owner')
  t.is(refused.status, 404)
  t.is(s.reads.length, 0, 'no seeder read')
  await s.recordPhone(seller, PHONE_A)
  const ok = await s.feira(seller.hex)
  t.is(ok.status, 200)
  t.ok(typeof ok.body.code === 'string')

  // A page whose owner's number ended: the owner counts as not linked.
  const owner = await s.newMember('bia')
  await s.recordPhone(owner, PHONE_B)
  const body = await s.createBody(owner, 'quitanda')
  t.is((await s.post('/account/pages/create', body)).status, 200)
  t.is((await s.feira(body.page)).status, 200)
  await s.phones.end(owner.hex, 'trocado')
  const reads = s.reads.length
  const ended = await s.feira(body.page)
  t.is(ended.status, 404)
  t.is(ended.text, unlinked.text)
  t.is(s.reads.length, reads, 'no seeder read')
})

test('phone gates: with phone verification off nothing changes', async (t) => {
  const s = await setup(t, { phone: false })
  const m = await s.newMember('ana')
  const on = await s.push(m, 'on', subscription())
  t.is(on.status, 200)
  const wrote = await s.seen(m, 'write', HASH_NONE, s.sealed(m))
  t.is(wrote.status, 200)
  const created = await s.post('/account/pages/create', await s.createBody(m, 'padaria'))
  t.is(created.status, 200)
  const code = await s.feira(m.hex)
  t.is(code.status, 200)
})
