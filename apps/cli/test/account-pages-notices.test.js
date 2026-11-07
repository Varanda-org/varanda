'use strict'

// The 'notices' route of apps/cli/lib/account/pages-routes.js end to end,
// loopback only: the account service with pages on and a real
// pages-notices reader over seed-ws (local DHT, never the public one). An
// admin reads a verified follow of the page; a removed admin is refused
// before any socket opens.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, followRecord, profileRecord } = require('@varanda/core/lib/records')
const { signRoster, signAccept } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesNotices } = require('../lib/account/pages-notices')
const { createAccountServer } = require('../lib/account/server')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)
const AT = new Date(Date.now() - 3600000).toISOString()

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

function googleStub () {
  return { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } }
}

let subSeq = 100
async function linkDirect (store, ctx, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '41000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, ctx.issuerKp, ctx.issuerCert, ctx.association)
}

// Counts the WebSocket links seed-ws hands to the seeder.
function countLinks (seeder) {
  const counter = { connections: 0 }
  const accept = seeder.acceptStream.bind(seeder)
  seeder.acceptStream = (...args) => {
    counter.connections++
    return accept(...args)
  }
  return counter
}

// A member diary (compat, its key is its Ed25519 key) that dials the seeder
// over the local DHT and announces itself.
async function follower (t, bootstrap, ctx, seederKey, name) {
  const kp = crypto.keyPair()
  const diary = new Hypercore(tmpDir(t, 'varanda-member-'), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await diary.ready()
  t.teardown(() => diary.close(), { force: true })
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, ctx.assocKp)))
  await diary.append(profileRecord({ name, bio: '', at: AT }))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    diary.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const seen = (length) => until(() => messages.find((x) => (x.type === 'have' || x.type === 'admitted') && x.key === key && x.length >= length), { name: 'have ' + length, timeoutMs: 30000 })
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  peer.send({ type: 'announce', key, cert: createCert({ member: key }, ctx.assocKp) })
  await seen(diary.length)
  return {
    key,
    async add (record) {
      await diary.append(record)
      await seen(diary.length)
      return diary.length - 1
    }
  }
}

test('account pages notices: an admin reads a verified follow of the page; a removed admin is refused before any socket', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const ctx = { assocKp, association, issuerKp, issuerCert }

  const seederDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
  Seeder.addCert(seederDir, certFile, association)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: noop })
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
  const pagesNotices = createPagesNotices({ keys, writer, seederWs, association, blocklist: new Set(), revokedIssuers: () => [], env, tmpRoot: tmpDir(t, 'varanda-notices-tmp-'), limits: { cacheTtlMs: 0 } })
  t.teardown(() => pagesNotices.close(), { force: true })
  const logs = []
  // The per-page window, switched by the test (the reader caches nothing,
  // so every read that passes opens a seeder link).
  const window = { open: true, charged: 0 }
  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log: (e) => logs.push(e),
    pages: { keys, writer, pagesStore, dir, pagesNotices, blocklist: { has: () => false }, limits: { notices: () => { window.charged++; return window.open } } }
  })
  const l = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => l.close(), { force: true })
  const base = 'http://127.0.0.1:' + l.port

  async function api (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  let termsCount = 0
  async function newMember (username) {
    const kp = crypto.keyPair()
    const m = { kp, hex: hex(kp.publicKey) }
    await linkDirect(store, ctx, m, username)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'T'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    return m
  }
  async function start (m, action) {
    const r = await api('/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status + ' ' + JSON.stringify(r.body))
    return r.body
  }
  const sign = (m, action, nonce, page, op) => signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  async function act (m, action, page, op) {
    const { nonce } = await start(m, action)
    return api('/account/pages/' + action, { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) })
  }
  function roster (m, page, fields, nonce) {
    const f = { page, ...fields, at: new Date().toISOString(), nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  const ana = await newMember('ana')
  const bia = await newMember('bia')
  const caio = await newMember('caio')

  // Ana creates the page; Bia becomes an admin.
  const made = await (async () => {
    const { nonce, page } = await start(ana, 'create')
    const record = roster(ana, page, { gen: 1, owner: ana.hex, admins: [], prev: null }, nonce)
    const op = { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('/account/pages/create', { member: ana.hex, nonce, page, op, signature: sign(ana, 'create', nonce, page, op), record })
    return { ...r, page }
  })()
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  let row = pagesStore.get(K)
  {
    const { nonce } = await start(ana, 'invite')
    const admins = [bia.hex]
    const record = roster(ana, K, { gen: row.gen + 1, owner: ana.hex, admins, prev: row.rosterSeq }, nonce)
    const op = { member: bia.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: ana.hex, admins, prev: row.rosterSeq, at: record.at, nonce } }
    const inv = await api('/account/pages/invite', { member: ana.hex, nonce, page: K, op, signature: sign(ana, 'invite', nonce, K, op), record })
    t.is(inv.status, 200, JSON.stringify(inv.body))
  }
  {
    const invite = pagesStore.listFor(bia.hex).invites[0]
    const { nonce } = await start(bia, 'accept')
    const f = { page: K, gen: invite.gen, rosterSignature: invite.rosterSignature, at: new Date().toISOString(), nonce, actor: bia.hex }
    const record = { type: 'page-accept', ...f, signature: signAccept(f, bia.kp) }
    const acc = await api('/account/pages/accept', { member: bia.hex, nonce, page: K, record })
    t.is(acc.status, 200, JSON.stringify(acc.body))
  }
  t.alike(pagesStore.get(K).admins, [bia.hex])

  // Fabi follows the page from her own diary.
  const fabi = await follower(t, bootstrap, ctx, seederKey, 'Fabi')
  const seqFollow = await fabi.add(followRecord({ key: K, on: true, at: AT }))

  const links = countLinks(seeder)
  let read = null
  await until(async () => {
    read = await act(bia, 'notices', K, { limit: 30 })
    return read.status === 200 && read.body.notices.some((n) => n.key === fabi.key)
  }, { name: 'follow notice', timeoutMs: 120000 })
  t.is(read.status, 200, JSON.stringify(read.body))
  const row0 = read.body.notices.find((n) => n.key === fabi.key)
  t.is(row0.kind, 'follow', 'a follow notice')
  t.is(row0.seq, seqFollow, 'at the seq of the signed follow')
  t.is(row0.name, 'Fabi', 'with the follower profile')
  t.is(read.body.supported, true)
  t.ok(typeof read.body.incomplete === 'boolean' && 'next' in read.body && 'activity' in read.body, 'the notices.list shape')
  t.ok(links.connections >= 1, 'the read opened a seeder link')

  // Not an admin; a bad op.
  t.is((await act(caio, 'notices', K, {})).body.error, 'sem-permissao', 'a member who is not an admin is refused')
  t.is((await act(bia, 'notices', K, { limit: 30, extra: 1 })).body.error, 'pedido-invalido', 'an op with another key is refused')

  // The owner removes Bia: her next read is refused and opens no socket.
  row = pagesStore.get(K)
  {
    const { nonce } = await start(ana, 'remove')
    const record = roster(ana, K, { gen: row.gen + 1, owner: ana.hex, admins: [], prev: row.rosterSeq }, nonce)
    const rem = await api('/account/pages/remove', { member: ana.hex, nonce, page: K, record })
    t.is(rem.status, 200, JSON.stringify(rem.body))
  }
  const before = links.connections
  const charged = window.charged
  t.is((await act(bia, 'notices', K, { limit: 30 })).body.error, 'sem-permissao', 'a removed admin is refused')
  t.is(links.connections, before, 'no socket opened for the removed admin')
  t.is(window.charged, charged, 'nor the page window charged')

  // The owner reads, opening a link; past the window the read is refused.
  const owner = await act(ana, 'notices', K, { limit: 30 })
  t.is(owner.status, 200, 'the owner reads')
  t.is(links.connections, before + 1, 'one link for the owner read')
  window.open = false
  t.is((await act(ana, 'notices', K, { limit: 30 })).body.error, 'limite', 'past the page window')
  t.is(links.connections, before + 1, 'no link past the window')
  t.ok(logs.filter((e) => e.event === 'pagina').every((e) => !JSON.stringify(e).includes(K) && !JSON.stringify(e).includes(bia.hex)), 'no key in the route logs')
})

test('account pages notices: no reader wired answers indisponivel', async (t) => {
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const dir = tmpDir(t, 'varanda-account-')
  const env = { VARANDA_PAGE_KEYS: PAGE_KEYS }
  const keys = openPageKeys({ dir, env })
  const writer = createPagesWriter({ dir, keys, association, log: noop })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: googleStub(),
    store: openAccountStore(dir),
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms: openTermsStore(dir),
    pages: { keys, writer, pagesStore: openPagesStore(dir), dir, blocklist: { has: () => false } }
  })
  const l = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => l.close(), { force: true })
  const kp = crypto.keyPair()
  const res = await fetch('http://127.0.0.1:' + l.port + '/account/pages/start', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ member: hex(kp.publicKey), action: 'notices' }) })
  t.is((await res.json()).error, 'indisponivel')
})
