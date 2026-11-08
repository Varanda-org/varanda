'use strict'

// apps/cli/lib/account/pages-dm.js keeps a member's link card (a Feira
// listing or offer): a real Seeder with the dm pool behind seed-ws (local
// DHT), the account service with pages on, loopback only.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const dmCore = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesDm } = require('../lib/account/pages-dm')
const { createAccountServer } = require('../lib/account/server')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)
const CARD_HOST = 'feira.varanda.test'

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

function rsaKey () {
  const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const n = fromBase64url(jwk.n)
  return { kid: postage.kidOf(n), n: n.toString(10), e: '65537', d: fromBase64url(jwk.d).toString(10) }
}

let seqNo = 0
function nonce43 (c) {
  seqNo++
  return (String(seqNo) + c.repeat(43)).slice(0, 43)
}

function jpegItem () {
  return { id: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(24)), chunks: 1, bytes: 20000, sha256: hex(crypto.randomBytes(32)), mime: 'image/jpeg', w: 640, h: 480, ms: 0 }
}

function offerCard () {
  return { url: 'https://' + CARD_HOST + '/l/abc#oferta=' + 'x'.repeat(20), host: CARD_HOST, title: 'Bicicleta aro 26', desc: 'Oferta: R$ 300', image: jpegItem() }
}

async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)

  const seederDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp)))
  Seeder.addCert(seederDir, certFile, association)
  const key = rsaKey()
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: noop, dm: { postage: { get: async () => ({ keys: [key] }) } } })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + ws.port

  const dir = tmpDir(t, 'varanda-account-')
  const env = { VARANDA_PAGE_KEYS: PAGE_KEYS }
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const keys = openPageKeys({ dir, env })
  const writer = createPagesWriter({ dir, keys, association, seederWs, log: noop })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
  const pagesStore = openPagesStore(dir)
  const logs = []
  const log = (e) => logs.push(e)

  // The server holds one object; a restart swaps the instance behind it.
  let current = null
  async function openDm () {
    const d = createPagesDm({ writer, pagesStore, keys, association, seederWs, dir, env, log, limits: { pullEveryMs: 0 } })
    t.teardown(() => d.close(), { force: true })
    await d.ready()
    current = d
    return d
  }
  await openDm()
  const pagesDm = new Proxy({}, { get: (_, k) => current[k] })

  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } },
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log,
    pages: { keys, writer, pagesStore, dir, pagesDm, pagesGroups: null, blocklist: { has: () => false } }
  })
  const l = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => l.close(), { force: true })
  const base = 'http://127.0.0.1:' + l.port

  async function api (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  async function newMember (username) {
    const kp = crypto.keyPair()
    const m = { kp, hex: hex(kp.publicKey) }
    const row = store.start({ member: m.hex, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: '4000000000000000000100', email: 'p@example.test' })
    await store.finish(row.id, { signature: 'a'.repeat(128) }, issuerKp, issuerCert, association)
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: nonce43('T'), signature: 'a'.repeat(128) })
    return m
  }

  async function startNonce (m, action) {
    const r = await api('/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status)
    return r.body
  }

  function sign (m, action, nonce, page, op) {
    return signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  }

  async function act (m, action, page, op) {
    const { nonce } = await startNonce(m, action)
    return api('/account/pages/' + action, { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) })
  }

  async function create (m, username) {
    const { nonce, page } = await startNonce(m, 'create')
    const f = { page, gen: 1, owner: m.hex, admins: [], prev: null, at: new Date().toISOString(), nonce, association }
    const record = { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    return { ...r, page }
  }

  async function putDrop (sealed) {
    const n = BigInt(key.n)
    const token = postage.newToken(n)
    const sig = postage.modPow(postage.representative(token), BigInt(key.d), n)
    const drop = dmCore.encodeDrop({ dropId: crypto.randomBytes(32), kid: b4a.from(key.kid, 'hex'), rsaSig: postage.bigToBytes(sig), token, sealed })
    const r = await seeder._dmPut(drop)
    if (r === null || typeof r !== 'object') throw new Error('drop refused')
  }

  return { assocKp, writer, logs, openDm, current: () => current, newMember, act, create, putDrop }
}

test('pages-dm card: a member card reaches the admin after a restart, unfetched; a page still sends text only', async (t) => {
  t.timeout(200000)
  const fetched = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (u, o) => {
    fetched.push(String(u))
    return realFetch(u, o)
  }
  t.teardown(() => { globalThis.fetch = realFetch })

  const s = await setup(t)
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'feirinha')
  t.is(made.status, 200, JSON.stringify(made.body))
  const page = made.page
  let boxHex = null
  await until(async () => {
    const k = (await s.writer.readEntries(page)).find((e) => e.record && e.record.type === 'dm-key' && e.record.gen === 1)
    boxHex = k ? k.record.box : null
    return boxHex !== null
  }, { name: 'page dm-key', timeoutMs: 30000 })

  const mKp = crypto.keyPair()
  const m = hex(mKp.publicKey)
  const cert = createCert({ member: m }, s.assocKp)
  const card = offerCard()
  const TEXT = 'tenho interesse na bicicleta'
  const t0 = Date.now()
  const withCard = dmCore.buildInner({ kind: 'msg', to: page, text: TEXT, card, cert, at: new Date(t0 - 2000).toISOString() }, mKp)
  const plain = dmCore.buildInner({ kind: 'msg', to: page, text: 'só texto', cert, at: new Date(t0 - 1000).toISOString() }, mKp)
  await s.putDrop(dmCore.sealInner(withCard, boxHex))
  t.is((await s.current().pull()).added, 1, 'the page files the v2 message with a card')

  const l = await s.act(ana, 'dm-list', page, { folder: 'request' })
  t.is(l.status, 200, JSON.stringify(l.body))
  t.is(l.body.conversations[0].preview, TEXT, 'the preview is the text')

  let th = await s.act(ana, 'dm-thread', page, { peer: m })
  t.is(th.status, 200)
  t.alike(th.body.messages[0].card, card, 'the card reaches the admin device as sent, image item included')
  t.ok(th.body.messages[0].card.url.includes('#oferta='), 'the fragment is kept')
  t.is(th.body.messages[0].media, null)

  await s.putDrop(dmCore.sealInner(plain, boxHex))
  t.is((await s.current().pull()).added, 1)

  // Restart: a new instance reads the sealed rows back.
  await s.current().close()
  await s.openDm()
  th = await s.act(ana, 'dm-thread', page, { peer: m })
  t.is(th.status, 200, JSON.stringify(th.body))
  t.is(th.body.messages.length, 2)
  t.alike(th.body.messages[0].card, card, 'the card survives a restart')
  t.is(th.body.messages[1].card, null, 'a v1 message has no card')
  t.is(th.body.messages[1].text, 'só texto')

  const sent = await s.act(ana, 'dm-send', page, { to: m, text: 'oi', card: { ...card, image: null } })
  t.is(sent.status, 400)
  t.is(sent.body.error, 'pedido-invalido', 'a page answers in text only')

  t.absent(fetched.some((u) => u.includes(CARD_HOST)), 'the card URL is never fetched')
  const text = JSON.stringify(s.logs)
  t.absent(text.includes(CARD_HOST), 'no card URL in the logs')
  for (const k of ['id', 'key', 'nonce', 'sha256']) t.absent(text.includes(card.image[k]), 'no image descriptor field in the logs')
})

// ---- offline: a fake writer and key table, rows written by the test -------

const ROWS_LABEL = 'varanda-page-dm-rows-v1'
const ROWS_AAD = b4a.from('varanda-page-dm-v1')

function rowKey (page) {
  const master = nodeCrypto.createHmac('sha256', Buffer.from(PAGE_KEYS, 'hex')).update(ROWS_LABEL).digest()
  return nodeCrypto.createHmac('sha256', master).update(page).digest()
}

function writeRows (dir, page, s) {
  fs.mkdirSync(path.join(dir, 'pages-dm'), { recursive: true })
  const iv = nodeCrypto.randomBytes(12)
  const c = nodeCrypto.createCipheriv('aes-256-gcm', rowKey(page), iv, { authTagLength: 16 })
  c.setAAD(ROWS_AAD)
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(s))), c.final()])
  fs.writeFileSync(path.join(dir, 'pages-dm', page + '.json'), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 })
}

test('pages-dm card: stored rows load with a missing, bad or half bad card and keep their text', async (t) => {
  const dir = tmpDir(t, 'varanda-pdm-')
  const page = hex(crypto.randomBytes(32))
  const peer = hex(crypto.randomBytes(32))
  const good = offerCard()
  const badImage = { ...offerCard(), image: { ...jpegItem(), mime: 'image/gif' } }
  const at = (i) => '2026-11-01T10:0' + i + ':00.000Z'
  const row = (i, extra) => ({ id: hex(crypto.randomBytes(16)), peer, from: peer, text: 'm' + i, replyTo: null, at: at(i), mine: false, filedAt: i + 1, ...extra })
  writeRows(dir, page, {
    v: 1,
    filed: 5,
    stopped: false,
    messages: [
      row(0, {}),
      row(1, { card: 'https://' + CARD_HOST }),
      row(2, { card: { ...good, host: 'outro.test' } }),
      row(3, { card: badImage }),
      row(4, { card: good })
    ],
    ops: [],
    seen: [],
    wallet: { items: [], kids: [] },
    sends: {}
  })
  const writer = {
    ready: async () => {},
    pageKeys: () => [page],
    ensureDmKey: async () => ({ seq: null, length: 0 }),
    readEntries: async () => [],
    follows: () => [],
    certOf: () => { throw new Error('unused') }
  }
  const pagesDm = createPagesDm({ writer, keys: { get: () => null, put: noop }, association: 'ab'.repeat(32), seederWs: 'http://127.0.0.1:1', dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS }, limits: { pullEveryMs: 0 } })
  t.teardown(() => pagesDm.close(), { force: true })
  await pagesDm.ready()

  const th = await pagesDm.thread(page, { peer })
  t.alike(th.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3', 'm4'], 'every message is kept')
  t.is(th.messages[0].card, null, 'an old row without a card reads null')
  t.is(th.messages[1].card, null, 'a card that is not an object is dropped')
  t.is(th.messages[2].card, null, 'a card with a wrong host is dropped')
  t.alike(th.messages[3].card, { ...badImage, image: null }, 'a bad image drops only the image')
  t.alike(th.messages[4].card, good, 'a valid card is kept with its image')

  const l = await pagesDm.list(page, { folder: 'request' })
  t.is(l.conversations[0].preview, 'm4', 'the preview is the text, never the card')
})
