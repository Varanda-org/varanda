'use strict'

// Core-node delegates on the page routes of
// apps/cli/lib/account/pages-routes.js, end to end on loopback only: the
// account service with pages on and a real pages-delegate client over
// seed-ws (local DHT, never the public one). A core diary (key = manifest
// hash) names an Ed25519 actor in a page-delegate record; the actor
// accepts the terms through the 'terms' action and then acts on pages,
// never entering the directory links.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord } = require('@varanda/core/lib/records')
const { signRoster } = require('@varanda/core/lib/page')
const { verifyLink } = require('@varanda/core/lib/page-lifecycle')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION, signTerms } = require('@varanda/core/lib/terms')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesDelegate } = require('../lib/account/pages-delegate')
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

function delegateRecord (actor) {
  return { type: 'page-delegate', actor, at: AT }
}

function person () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// A core member: a Corestore diary (key = manifest hash) whose block 0 is
// a v2 member-cert, dialing the seeder directly and announcing itself.
async function coreMember (t, bootstrap, ctx, seederKey, records) {
  const store = new Corestore(tmpDir(t, 'varanda-member-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const issued = createIssuedCert({ member: key }, ctx.issuerKp, ctx.issuerCert)
  await diary.append(memberCertRecord(issued))
  for (const r of records) await diary.append(r)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  peer.send({ type: 'announce', key, cert: issued })
  await until(() => messages.find((x) => (x.type === 'have' || x.type === 'admitted') && x.key === key && x.length >= diary.length), { name: 'have ' + diary.length, timeoutMs: 30000 })
  return { key }
}

// A diary with no member-cert copied straight into the seeder's store: a
// seeder that serves it anyway.
async function planted (t, seeder, records) {
  const store = new Corestore(tmpDir(t, 'varanda-planted-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  for (const r of records) await diary.append(r)
  const a = store.replicate(true)
  const b = seeder.store.replicate(false)
  a.on('error', noop)
  b.on('error', noop)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  const copy = seeder.store.get({ key: diary.key })
  await copy.ready()
  t.teardown(() => copy.close(), { force: true })
  await copy.download({ start: 0, end: diary.length }).done()
  return { key: hex(diary.key) }
}

let subSeq = 100
async function linkDirect (store, ctx, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '42000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, ctx.issuerKp, ctx.issuerCert, ctx.association)
}

test('account pages delegate: a core delegate accepts the terms and creates a page with a page-link; no cert, no terms and a linked member refused', async (t) => {
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
  const blocked = new Set()
  const pagesDelegate = createPagesDelegate({ seederWs, association, blocklist: blocked, revokedIssuers: () => [], tmpRoot: tmpDir(t, 'varanda-delegate-tmp-'), limits: { recheckMs: 0 } })
  t.teardown(() => pagesDelegate.close(), { force: true })
  const logs = []
  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log: (e) => logs.push(e),
    pages: { keys, writer, pagesStore, dir, pagesDelegate, blocklist: { has: (k) => blocked.has(k) } }
  })
  const l = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => l.close(), { force: true })
  const base = 'http://127.0.0.1:' + l.port

  async function api (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
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
  async function acceptTerms (m, diary, { badTerms = false } = {}) {
    const { nonce } = await start(m, 'terms')
    const op = { version: TERMS_VERSION, diary }
    const termsSignature = signTerms({ nonce, member: m.hex, association, version: badTerms ? TERMS_VERSION - 1 : TERMS_VERSION }, m.kp)
    return api('/account/pages/terms', { member: m.hex, nonce, page: '', op, signature: sign(m, 'terms', nonce, '', op), termsSignature })
  }
  async function create (m, username) {
    const { nonce, page } = await start(m, 'create')
    const f = { page, gen: 1, owner: m.hex, admins: [], prev: null, at: new Date().toISOString(), nonce, association }
    const record = { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: f.at, nonce } }
    const r = await api('/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    return { ...r, page }
  }
  // The page diary as the seeder serves it.
  async function served (page, length) {
    const core = seeder.store.get({ key: b4a.from(page, 'hex'), valueEncoding: 'json' })
    await core.ready()
    try {
      const out = []
      for (let seq = 0; seq < length; seq++) out.push({ seq, record: await core.get(seq, { timeout: 10000 }) })
      return out
    } finally {
      await core.close().catch(noop)
    }
  }

  const xavi = person()
  const D1 = await coreMember(t, bootstrap, ctx, seederKey, [postRecord({ text: 'oi', at: AT }), delegateRecord(xavi.hex)])

  // Without the terms: refused, no name reserved. With no delegate row the
  // service does not know the diary at all; a row from older terms is
  // 'termos-pendentes'.
  const early = await create(xavi, 'cafe')
  t.is(early.body.error, 'nao-vinculado', 'a delegate that never accepted the terms is refused')
  t.is(store.lookup('cafe'), null, 'no name reserved')
  const wil = person()
  const D3 = await coreMember(t, bootstrap, ctx, seederKey, [delegateRecord(wil.hex)])
  await pagesStore.setDelegate(wil.hex, { diary: D3.key, length: 2, termsVersion: TERMS_VERSION - 1 })
  t.is((await create(wil, 'antigo')).body.error, 'termos-pendentes', 'a delegate of older terms is refused')
  t.is(store.lookup('antigo'), null, 'no name reserved')

  // A terms signature over another version is refused.
  t.is((await acceptTerms(xavi, D1.key, { badTerms: true })).body.error, 'assinatura-invalida', 'the terms signature must match the op')
  t.is(pagesStore.delegate(xavi.hex), null)

  // The delegate accepts the terms: kept under the actor, never a link.
  const accepted = await acceptTerms(xavi, D1.key)
  t.is(accepted.status, 200, JSON.stringify(accepted.body))
  t.is(accepted.body.version, TERMS_VERSION)
  t.alike(pagesStore.delegate(xavi.hex), { diary: D1.key, length: 3, termsVersion: TERMS_VERSION }, 'the delegate row')
  t.ok(terms.list(xavi.hex).some((e) => e.version === TERMS_VERSION), 'the acceptance under the actor')
  t.is(store.status(xavi.hex).linked, false, 'never in the directory links')

  // The delegate creates a page: the page-link follows the genesis roster.
  const made = await create(xavi, 'cafe')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  t.is(pagesStore.get(K).owner, xavi.hex, 'the actor owns the page')
  const entries = await served(K, writer.info(K).length)
  t.is(entries[2].record.type, 'page-roster', 'the genesis roster')
  const link = entries[3].record
  t.is(link.type, 'page-link', 'the page-link right after it')
  t.alike([link.page, link.diary, link.actor], [K, D1.key, xavi.hex])
  t.ok(verifyLink(link, K, association).ok, 'issuer-signed')
  t.is((await act(xavi, 'post', K, { text: 'café passado' })).status, 200, 'the delegate posts')

  // A flood of 'terms' with random diaries the seeder does not serve: the
  // host window and the probe slot leave the delegate's next action a read.
  const flood = []
  for (let i = 0; i < 8; i++) flood.push(acceptTerms(person(), hex(crypto.keyPair().publicKey)))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const during = await act(xavi, 'post', K, { text: 'durante a enxurrada' })
  t.is(during.status, 200, 'a valid delegate is not starved: ' + JSON.stringify(during.body))
  const flooded = await Promise.all(flood)
  t.ok(flooded.every((r) => r.status !== 200), 'no random diary is accepted')

  // A blocked diary stops its delegate.
  blocked.add(D1.key)
  t.is((await act(xavi, 'post', K, { text: 'bloqueado' })).body.error, 'sem-permissao', 'a blocked diary refused')
  blocked.delete(D1.key)

  // No member-cert: the terms are refused, no row, and later no page.
  const yara = person()
  const P = await planted(t, seeder, [postRecord({ text: 'sem certificado', at: AT }), delegateRecord(yara.hex)])
  t.is((await acceptTerms(yara, P.key)).body.error, 'nao-vinculado', 'a diary without a cert is refused')
  t.is(pagesStore.delegate(yara.hex), null, 'no delegate row')
  t.is(terms.list(yara.hex).length, 0, 'no acceptance')
  t.is((await create(yara, 'semcert')).body.error, 'nao-vinculado')
  t.is(store.lookup('semcert'), null, 'no name reserved')

  // A stranger cannot claim a diary that names someone else.
  const zeca = person()
  t.is((await acceptTerms(zeca, D1.key)).body.error, 'nao-vinculado', 'the diary names another actor')
  t.is((await create(zeca, 'zeca')).body.error, 'nao-vinculado', 'no delegate row, no link')

  // A Google-linked member never takes the delegate path, even when a
  // core diary names them: the page carries no page-link.
  const lia = person()
  await linkDirect(store, ctx, lia, 'lia')
  await terms.accept({ member: lia.hex, version: TERMS_VERSION, nonce: 'L'.repeat(43), signature: 'a'.repeat(128) })
  const D2 = await coreMember(t, bootstrap, ctx, seederKey, [delegateRecord(lia.hex)])
  t.is((await acceptTerms(lia, D2.key)).body.error, 'pedido-invalido', 'a linked member accepts the terms elsewhere')
  t.is((await acceptTerms(lia, D1.key)).body.error, 'pedido-invalido', 'nor with a stranger diary')
  t.is(pagesStore.delegate(lia.hex), null, 'no delegate row for a linked member')
  const own = await create(lia, 'loja')
  t.is(own.status, 200, JSON.stringify(own.body))
  const ownEntries = await served(own.page, writer.info(own.page).length)
  t.ok(ownEntries.every((e) => e.record.type !== 'page-link'), 'a linked owner gets no page-link')

  t.ok(logs.filter((e) => e.event === 'pagina').every((e) => ![K, xavi.hex, D1.key, P.key].some((k) => JSON.stringify(e).includes(k))), 'no key in the route logs')
})
