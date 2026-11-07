'use strict'

// apps/cli/lib/account/pages-dm.js through the page routes, loopback only: a
// real Seeder with the dm pool and a test postage key behind seed-ws (local
// DHT), the account service with pages on, and a real browser node
// (packages/web-member lib/node.js over memory storage) as the member who
// writes to the page.

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept, issuerCountersign } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const dmCore = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { createBrowserNode } = require('@varanda/web-member/lib/node')
const { memoryNodeStorage } = require('@varanda/web-member/lib/node-storage')
const { connectClient, stoppedOf } = require('../../../packages/web-member/test/helpers/session')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesDm } = require('../lib/account/pages-dm')
const { createAccountServer } = require('../lib/account/server')

const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const sodium = require(require.resolve('sodium-universal', { paths: [coreDir] }))

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)

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

async function setup (t, { pagesGroups = null } = {}) {
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
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: (e) => { if (process.env.DBG) console.error('SEED', JSON.stringify(e)) }, dm: { postage: { get: async () => ({ keys: [key] }) } } })
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
  const pagesDm = createPagesDm({ writer, pagesStore, keys, association, seederWs, dir, env, log, limits: { pullEveryMs: 0 } })
  t.teardown(() => pagesDm.close(), { force: true })
  await pagesDm.ready()

  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } },
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log,
    pages: { keys, writer, pagesStore, dir, pagesDm, pagesGroups, blocklist: { has: () => false } }
  })
  const l = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => l.close(), { force: true })
  const base = 'http://127.0.0.1:' + l.port

  async function api (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  let subSeq = 100
  async function newMember (username) {
    const kp = crypto.keyPair()
    const m = { kp, hex: hex(kp.publicKey) }
    const row = store.start({ member: m.hex, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: '40000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
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
    const body = { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) }
    return { ...(await api('/account/pages/' + action, body)), body2: body }
  }

  function roster (m, page, fields, nonce) {
    const f = { page, ...fields, at: new Date().toISOString(), nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  async function create (m, username) {
    const { nonce, page } = await startNonce(m, 'create')
    const record = roster(m, page, { gen: 1, owner: m.hex, admins: [], prev: null }, nonce)
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    return { ...r, page }
  }

  async function invite (owner, page, who) {
    const row = pagesStore.get(page)
    const { nonce } = await startNonce(owner, 'invite')
    const admins = [...row.admins, who.hex].sort()
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins, prev: row.rosterSeq }, nonce)
    const op = { member: who.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: owner.hex, admins, prev: row.rosterSeq, at: record.at, nonce } }
    return api('/account/pages/invite', { member: owner.hex, nonce, page, op, signature: sign(owner, 'invite', nonce, page, op), record })
  }

  async function accept (who, page) {
    const inv = pagesStore.listFor(who.hex).invites[0]
    const { nonce } = await startNonce(who, 'accept')
    const f = { page, gen: inv.gen, rosterSignature: inv.rosterSignature, at: new Date().toISOString(), nonce, actor: who.hex }
    return api('/account/pages/accept', { member: who.hex, nonce, page, record: { type: 'page-accept', ...f, signature: signAccept(f, who.kp) } })
  }

  async function remove (owner, page) {
    const row = pagesStore.get(page)
    const { nonce } = await startNonce(owner, 'remove')
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins: [], prev: row.rosterSeq }, nonce)
    return api('/account/pages/remove', { member: owner.hex, nonce, page, record })
  }

  // A page written straight through the writer (a move's K2 before its ACL
  // row), outside the routes.
  async function rawPage (username) {
    const { key, row } = keys.pending(nonce43('k'))
    keys.put(key, row)
    const cert = createIssuedCert({ member: key }, issuerKp, issuerCert)
    const usernameRecord = createUsernameRecord({ member: key, username }, issuerKp, issuerCert)
    const owner = crypto.keyPair()
    const fields = { page: key, gen: 1, owner: hex(owner.publicKey), admins: [], prev: null, at: new Date().toISOString(), nonce: nonce43('r'), association }
    const rosterRecord = issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, owner) }, issuerKp, issuerCert)
    await writer.createPage({ cert, usernameRecord, rosterRecord })
    return key
  }

  const url = 'ws://127.0.0.1:' + ws.port + '/seeder'
  async function push (n) {
    let stopped = null
    for (let i = 0; i < 5; i++) {
      const { runId } = await n.web.request('sync.start', { once: true, timeoutMs: 30000 })
      stopped = await stoppedOf(n.web.events, runId)
      if (stopped.reason === 'done' && stopped.result && stopped.result.seederConfirmed === true) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    t.is(stopped.result && stopped.result.seederConfirmed, true, 'the seeder holds the diary')
  }

  async function browserMember () {
    const storage = memoryNodeStorage()
    const node = createBrowserNode({
      storage,
      association,
      seederUrl: url,
      createSocket: (u) => {
        const s = new WebSocket(u)
        s.on('error', noop)
        return s
      },
      syncOptions: { retryMinMs: 100, retryMaxMs: 200, dm: { topUpRetryMs: 100 } },
      writeGate: false
    })
    t.teardown(() => node.close(), { force: true })
    await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
    const web = await connectClient(node, { timeoutMs: 60000 })
    const { publicKey } = await web.request('identity.create')
    await web.request('cert.add', { cert: createCert({ member: publicKey }, assocKp) })
    const n = { node, web, storage, key: publicKey }
    await push(n)
    await until(() => seeder._served.has(n.key) || seeder._admitted.has(n.key), { name: 'served', timeoutMs: 30000 })
    await web.request('dm.enable')
    // The wallet first: a once run started meanwhile preempts the top-up
    // dm.enable began, and a once run never tops up (no continuous run here).
    await until(async () => {
      const w = await storage.readJson('dmStamps')
      return w && Array.isArray(w.items) && w.items.length >= dmCore.DM_STAMP_WALLET
    }, { name: 'wallet', timeoutMs: 60000 })
    // The dm-key reaches the seeder, where the page service reads it.
    await push(n)
    return n
  }

  // A drop put straight into the pool, stamped with the test postage key.
  async function putDrop (sealed) {
    const n = BigInt(key.n)
    const token = postage.newToken(n)
    const sig = postage.modPow(postage.representative(token), BigInt(key.d), n)
    const drop = dmCore.encodeDrop({ dropId: crypto.randomBytes(32), kid: b4a.from(key.kid, 'hex'), rsaSig: postage.bigToBytes(sig), token, sealed })
    const r = await seeder._dmPut(drop)
    if (r === null || typeof r !== 'object') throw new Error('drop refused')
  }

  // The page's box pair (the test holds the page-keys table).
  function pageBox (page) {
    const row = keys.get(page)
    const secretKey = b4a.from(row.boxSecretKey)
    const publicKey = b4a.alloc(32)
    sodium.crypto_scalarmult_base(publicKey, secretKey)
    return { publicKey, secretKey }
  }

  // Every inner in the pool the page's box opens, as parsed JSON.
  function pageInners (page) {
    const pair = pageBox(page)
    const out = []
    const { items } = seeder._dm.page({ after: 0, limit: 1000 })
    for (const item of items) {
      const drop = dmCore.decodeDrop(item.bytes)
      if (drop === null) continue
      const inner = dmCore.openSealed(drop.sealed, pair)
      if (inner === null) continue
      const len = (inner[0] << 8) | inner[1]
      out.push(JSON.parse(b4a.toString(inner.subarray(2, 2 + len), 'utf8')))
    }
    return out
  }

  return { api, association, assocKp, writer, pagesStore, pagesDm, logs, newMember, act, create, invite, accept, remove, rawPage, browserMember, putDrop, pageBox, pageInners }
}

test('pages-dm: a member writes to the page, an admin reads and answers through the routes; removal, stop and enable', async (t) => {
  t.timeout(400000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')

  const made = await s.create(ana, 'padaria')
  t.is(made.status, 200, JSON.stringify(made.body))
  const page = made.page
  await until(async () => (await s.writer.readEntries(page)).some((e) => e.record && e.record.type === 'dm-key' && e.record.gen === 1), { name: 'page dm-key', timeoutMs: 30000 })
  await until(async () => (await s.pagesDm.walletSize(page)) >= 2, { name: 'page wallet', timeoutMs: 60000 })

  t.is((await s.invite(ana, page, bia)).status, 200)
  t.is((await s.accept(bia, page)).status, 200)
  t.alike(s.pagesStore.get(page).admins, [bia.hex])

  // Not an admin: nothing is read for them.
  t.is((await s.act(caio, 'dm-list', page, {})).body.error, 'sem-permissao', 'a member who is not an admin is refused')

  const X = await s.browserMember()
  // A continuous run, so the on-demand read of the page diary has a link.
  await X.web.request('sync.start', {})
  let box = null
  await until(async () => {
    try {
      box = await X.web.request('dm.lookup', { member: page })
    } catch {
      return false
    }
    return box.box !== null
  }, { name: 'page box lookup', timeoutMs: 60000 })
  t.ok(/^[0-9a-f]{64}$/.test(box.box), 'the member finds the page box')
  const TEXT_IN = 'oi padaria, tem pão?'
  await X.web.request('dm.send', { to: page, text: TEXT_IN, fwd: 1 })
  const pulled = await s.pagesDm.pull()
  t.is(pulled.added, 1, 'the page files the message')

  const reqs = await s.act(bia, 'dm-list', page, { folder: 'request' })
  t.is(reqs.status, 200, JSON.stringify(reqs.body))
  t.is(reqs.body.conversations.length, 1)
  t.is(reqs.body.conversations[0].peer, X.key)
  t.is(reqs.body.conversations[0].preview, TEXT_IN)
  t.is(reqs.body.requests, true)
  const th = await s.act(bia, 'dm-thread', page, { peer: X.key })
  t.is(th.status, 200)
  t.is(th.body.messages.length, 1)
  t.is(th.body.messages[0].text, TEXT_IN)
  t.is(th.body.messages[0].fwd, 1, 'incoming text forward')
  t.is(th.body.messages[0].from, X.key)
  t.is(th.body.folder, 'request')
  t.is((await s.act(bia, 'dm-seen', page, { peer: X.key })).status, 200)
  t.is((await s.act(bia, 'dm-set', page, { peer: X.key, state: 'accepted' })).status, 200)
  const inbox = await s.act(ana, 'dm-list', page, {})
  t.is(inbox.body.conversations.length, 1, 'accepted: in the inbox')
  t.is(inbox.body.conversations[0].unread, false)

  // The page answers; the member's node receives it from the page key.
  const TEXT_OUT = 'temos sim, até as 18h'
  const sent = await s.act(bia, 'dm-send', page, { to: X.key, text: TEXT_OUT })
  t.is(sent.status, 200, JSON.stringify(sent.body))
  t.ok(/^[0-9a-f]{32}$/.test(sent.body.id))
  // A resend of the same signed request mints nothing new.
  const again = await s.api('/account/pages/dm-send', sent.body2)
  t.is(again.status, 200)
  t.is(again.body.id, sent.body.id, 'the resend answers the same message')
  const p = await X.web.request('dm.pull')
  t.is(p.added, 1, 'the member files the page answer')
  const xt = await X.web.request('dm.thread', { peer: page })
  const fromPage = xt.messages.filter((m) => m.from === page)
  t.is(fromPage.length, 1)
  t.is(fromPage[0].text, TEXT_OUT)
  t.is(fromPage[0].id, sent.body.id)
  await s.pagesDm.pull()
  const mine = (await s.act(ana, 'dm-thread', page, { peer: X.key })).body.messages
  t.is(mine.length, 2, 'the self copy does not double the answer')
  t.is(mine[1].mine, true)
  t.alike(mine.map(m => m.fwd), [1, 0])
  t.is(fromPage[0].fwd, 0, 'legacy answer')
  // A page answers in text: its inner keeps the v1 key set, so readers from
  // before inner v2 still open it.
  const answer = s.pageInners(page).find((b) => b.id === sent.body.id)
  t.ok(answer, 'the self copy opens with the page box')
  t.is(answer.v, 1)
  t.alike(Object.keys(answer), [...dmCore.INNER_KEYS], 'the legacy key set, no media, card or fwd')

  for (const fwd of [true, false, 2, -1, '1', null]) {
    const bad = await s.act(bia, 'dm-send', page, { to: X.key, text: TEXT_OUT, fwd })
    t.is(bad.body.error, 'pedido-invalido')
  }
  const forwarded = await s.act(bia, 'dm-send', page, { to: X.key, text: TEXT_OUT, fwd: 1 })
  t.is(forwarded.status, 200)
  t.is(s.pageInners(page).find(b => b.id === forwarded.body.id).fwd, 1)
  await X.web.request('dm.pull')
  t.is((await X.web.request('dm.thread', { peer: page })).messages.find(m => m.id === forwarded.body.id).fwd, 1)
  t.is((await s.act(ana, 'dm-thread', page, { peer: X.key })).body.messages.find(m => m.id === forwarded.body.id).fwd, 1)

  // The role is lost during the stamp wait, after the first re-check: the
  // second re-check refuses before anything is filed or delivered.
  const sendOnce = s.pagesDm.send
  s.pagesDm.send = async (pg, params, idem) => {
    let calls = 0
    return sendOnce(pg, params, { ...idem, recheck: () => ++calls === 1 ? idem.recheck() : false })
  }
  const stalled = await s.act(bia, 'dm-send', page, { to: X.key, text: 'durante os selos' })
  s.pagesDm.send = sendOnce
  t.is(stalled.body.error, 'sem-permissao', 'a role lost during the stamp wait files nothing')
  t.is((await X.web.request('dm.pull')).added, 0, 'nothing delivered after the stamp wait')

  // Removed while a send waits on the recipient lookup (after the route's
  // check under the page lock): the send re-checks before sealing, so
  // nothing is sealed, filed or delivered as the page.
  const realSend = s.pagesDm.send
  let removedMidway = null
  s.pagesDm.send = async (pg, params, idem) => {
    removedMidway = await s.remove(ana, page)
    return realSend(pg, params, idem)
  }
  const late = await s.act(bia, 'dm-send', page, { to: X.key, text: 'depois de removida' })
  s.pagesDm.send = realSend
  t.is(removedMidway && removedMidway.status, 200, 'the admin was removed during the send')
  t.is(late.body.error, 'sem-permissao', 'a removed admin cannot send as the page mid-lookup')
  t.is((await X.web.request('dm.pull')).added, 0, 'nothing delivered to the member')

  // Removed: every dm action is refused at once and nothing is written.
  for (const [action, op] of [['dm-list', {}], ['dm-thread', { peer: X.key }], ['dm-send', { to: X.key, text: 'ainda?' }], ['dm-set', { peer: X.key, state: 'blocked' }], ['dm-seen', { peer: X.key }]]) {
    t.is((await s.act(bia, action, page, op)).body.error, 'sem-permissao', 'a removed admin: ' + action)
  }
  t.is((await s.act(ana, 'dm-thread', page, { peer: X.key })).body.messages.length, 3, 'the refused send wrote no drop')

  // A second live page, so the pool is read while the first is stopped.
  const other = (await s.create(ana, 'outra')).page
  await until(async () => (await s.writer.readEntries(other)).some((e) => e.record && e.record.type === 'dm-key'), { name: 'other dm-key', timeoutMs: 30000 })

  // stop: the pool takes no further drop for the page.
  await s.pagesDm.stop(page)
  await X.web.request('dm.send', { to: page, text: 'depois da parada' })
  t.is((await s.pagesDm.pull()).added, 0)
  t.is((await s.act(ana, 'dm-thread', page, { peer: X.key })).body.messages.length, 3, 'nothing filed after stop')
  t.is((await s.act(ana, 'dm-send', page, { to: X.key, text: 'x' })).body.error, 'encerrada', 'a stopped page sends nothing')

  // Enabled again: the drop the other page's pull read past is still the
  // page's to try.
  await s.pagesDm.enable(page)
  t.is((await s.pagesDm.pull()).added, 1, 'a re-enabled page files what came while it was stopped')
  t.is((await s.pagesDm.pull()).added, 0, 'and only once')
  await s.pagesDm.stop(page)

  // enable: a new key gets a fresh box and dm-key gen 1.
  const K2 = await s.rawPage('padaria2')
  t.absent((await s.writer.readEntries(K2)).some((e) => e.record && e.record.type === 'dm-key'))
  const en = await s.pagesDm.enable(K2)
  t.is(en.gen, 1)
  const k2Keys = (await s.writer.readEntries(K2)).filter((e) => e.record && e.record.type === 'dm-key')
  t.is(k2Keys.length, 1)
  t.is(k2Keys[0].record.box, en.box)
  t.not(en.box, box.box, 'K2 has its own box')
  t.is((await s.pagesDm.enable(K2)).seq, null, 'enable twice appends nothing more')

  const text = JSON.stringify(s.logs)
  for (const k of [page, other, K2, X.key, ana.hex, bia.hex, box.box, en.box]) t.absent(text.includes(k), 'no key in the logs')
  for (const w of [TEXT_IN, TEXT_OUT, 'depois da parada']) t.absent(text.includes(w), 'no text in the logs')
  t.ok(s.logs.every((e) => e.event !== 'page-dm' || Object.keys(e).join(',') === 'event,reason'))
})

test('pages-dm: a member message with media (inner v2) opens and its descriptors reach the admin unfetched', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'floricultura')
  t.is(made.status, 200, JSON.stringify(made.body))
  const page = made.page
  let boxHex = null
  await until(async () => {
    const k = (await s.writer.readEntries(page)).find((e) => e.record && e.record.type === 'dm-key' && e.record.gen === 1)
    boxHex = k ? k.record.box : null
    return boxHex !== null
  }, { name: 'page dm-key', timeoutMs: 30000 })
  t.is(hex(s.pageBox(page).publicKey), boxHex)

  // A member who is only a key and a certificate: the page never looks the
  // sender up to open what it receives.
  const mKp = crypto.keyPair()
  const m = hex(mKp.publicKey)
  const cert = createCert({ member: m }, s.assocKp)
  const item = (mime) => ({ id: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(24)), chunks: 1, bytes: 20000, sha256: hex(crypto.randomBytes(32)), mime, w: 640, h: 480, ms: 0 })
  const photo = item('image/jpeg')
  const gif = item('image/gif')
  const CAPTION = 'olha as flores'
  // Distinct times: with one shared `at` the fold orders by the random id.
  const t0 = Date.now()
  const withText = dmCore.buildInner({ kind: 'msg', to: page, text: CAPTION, media: [photo], fwd: 1, cert, at: new Date(t0 - 2000).toISOString() }, mKp)
  const mediaOnly = dmCore.buildInner({ kind: 'msg', to: page, text: '', media: [gif], cert, at: new Date(t0 - 1000).toISOString() }, mKp)
  await s.putDrop(dmCore.sealInner(withText, boxHex))
  t.is((await s.pagesDm.pull()).added, 1, 'the page files a v2 message')

  let l = await s.act(ana, 'dm-list', page, { folder: 'request' })
  t.is(l.status, 200, JSON.stringify(l.body))
  t.is(l.body.conversations[0].preview, CAPTION, 'a caption is the preview')
  let th = await s.act(ana, 'dm-thread', page, { peer: m })
  t.is(th.status, 200)
  t.is(th.body.messages.length, 1)
  t.is(th.body.messages[0].text, CAPTION)
  t.is(th.body.messages[0].fwd, 1)
  t.alike(th.body.messages[0].media, [photo], 'the descriptor reaches the admin device as sent')

  await s.putDrop(dmCore.sealInner(mediaOnly, boxHex))
  t.is((await s.pagesDm.pull()).added, 1)
  l = await s.act(ana, 'dm-list', page, { folder: 'request' })
  t.is(l.body.conversations[0].preview, 'GIF', 'media without text: a fixed label, never a peer string')
  th = await s.act(ana, 'dm-thread', page, { peer: m })
  t.is(th.body.messages.length, 2)
  t.is(th.body.messages[1].text, '')
  t.alike(th.body.messages[1].media, [gif])
  t.is((await s.pagesDm.pull()).added, 0, 'filed once')

  // A text-only member message stays v1 and carries no media.
  const plain = dmCore.buildInner({ kind: 'msg', to: page, text: 'só texto', cert }, mKp)
  await s.putDrop(dmCore.sealInner(plain, boxHex))
  t.is((await s.pagesDm.pull()).added, 1)
  th = await s.act(ana, 'dm-thread', page, { peer: m })
  t.is(th.body.messages[2].media, null, 'a v1 message has no media')
  t.alike(th.body.messages.map(m => m.fwd), [1, 0, 0])

  const text = JSON.stringify(s.logs)
  for (const d of [photo, gif]) {
    for (const k of ['id', 'key', 'nonce', 'sha256']) t.absent(text.includes(d[k]), 'no descriptor field in the logs')
  }
  t.absent(text.includes(CAPTION), 'no text in the logs')
})

// ---- offline: a fake writer and key table, no seeder, loopback only ------

const ROWS_LABEL = 'varanda-page-dm-rows-v1'
const ROWS_AAD = b4a.from('varanda-page-dm-v1')

function rowKey (page) {
  const master = nodeCrypto.createHmac('sha256', Buffer.from(PAGE_KEYS, 'hex')).update(ROWS_LABEL).digest()
  return nodeCrypto.createHmac('sha256', master).update(page).digest()
}

function stateFile (dir, page) {
  return path.join(dir, 'pages-dm', page + '.json')
}

function readRows (dir, page) {
  const outer = JSON.parse(fs.readFileSync(stateFile(dir, page), 'utf8'))
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', rowKey(page), Buffer.from(outer.iv, 'base64'), { authTagLength: 16 })
  d.setAAD(ROWS_AAD)
  d.setAuthTag(Buffer.from(outer.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(outer.data, 'base64')), d.final()]).toString('utf8'))
}

function writeRows (dir, page, s) {
  fs.mkdirSync(path.join(dir, 'pages-dm'), { recursive: true })
  const iv = nodeCrypto.randomBytes(12)
  const c = nodeCrypto.createCipheriv('aes-256-gcm', rowKey(page), iv, { authTagLength: 16 })
  c.setAAD(ROWS_AAD)
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(s))), c.final()])
  fs.writeFileSync(stateFile(dir, page), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 })
}

// Accepts TCP and never answers: a seeder that hangs.
async function holdServer (t) {
  const held = []
  const server = net.createServer((sock) => { held.push(sock) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => {
    for (const s of held) s.destroy()
    return new Promise((resolve) => server.close(resolve))
  }, { force: true })
  return server.address().port
}

async function offline (t, { port = 1, limits = {}, revokedIssuers = null, prepare = null } = {}) {
  const dir = tmpDir(t, 'varanda-pdm-')
  const page = hex(crypto.randomBytes(32))
  if (prepare !== null) prepare(dir, page)
  const writer = {
    ready: async () => {},
    pageKeys: () => [page],
    ensureDmKey: async () => ({ seq: null, length: 0 }),
    readEntries: async () => [],
    follows: () => [],
    certOf: () => { throw new Error('unused') }
  }
  const keys = { get: () => null, put: noop }
  const pagesDm = createPagesDm({ writer, keys, association: 'ab'.repeat(32), seederWs: 'http://127.0.0.1:' + port, dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS }, revokedIssuers, limits: { pullEveryMs: 0, ...limits } })
  t.teardown(() => pagesDm.close(), { force: true })
  await pagesDm.ready()
  return { dir, page, pagesDm }
}

function msgId () {
  return hex(crypto.randomBytes(16))
}

test('pages-dm: filedAt is local ms, and an older file of counters keeps its times and order', async (t) => {
  const peer = hex(crypto.randomBytes(32))
  const AT1 = '2026-11-01T10:00:00.000Z'
  const AT2 = '2026-11-01T10:05:00.000Z'
  const { dir, page, pagesDm } = await offline(t, {
    prepare: (d, p) => writeRows(d, p, {
      v: 1,
      filed: 2,
      stopped: false,
      messages: [
        { id: msgId(), peer, from: peer, text: 'um', replyTo: null, at: AT1, mine: false, filedAt: 1 },
        { id: msgId(), peer, from: peer, text: 'dois', replyTo: null, fwd: 1, at: AT2, mine: false, filedAt: 2 }
      ],
      ops: [],
      seen: [],
      wallet: { items: [], kids: [] },
      sends: {}
    })
  })
  const l = await pagesDm.list(page, { folder: 'request' })
  t.is(l.conversations.length, 1)
  t.is(l.conversations[0] && l.conversations[0].at, AT2, 'a counter row does not read as 1970')
  const th = await pagesDm.thread(page, { peer })
  t.alike(th.messages.map((m) => m.text), ['um', 'dois'], 'the old order is kept')
  t.alike(th.messages.map((m) => m.at), [AT1, AT2])
  t.alike(th.messages.map(m => m.fwd), [0, 1], 'legacy and forward flags survive reopening')

  const before = Date.now()
  await pagesDm.set(page, { peer: hex(crypto.randomBytes(32)), state: 'accepted' })
  const s = readRows(dir, page)
  const op = s.ops[s.ops.length - 1]
  t.ok(op.filedAt >= before && op.filedAt <= Date.now(), 'a new row is filed at the local time in ms')
  t.ok(s.messages.every((m) => m.filedAt > 1e12 && m.filedAt < op.filedAt), 'migrated rows are ms and sort before it')
  t.is(s.filed, op.filedAt)
  await pagesDm.set(page, { peer, state: 'accepted' })
  const s2 = readRows(dir, page)
  t.ok(s2.ops[1].filedAt > s2.ops[0].filedAt, 'strictly increasing')
})

test('pages-dm: past the op cap a peer keeps its newest block', async (t) => {
  t.timeout(120000)
  const { page, pagesDm } = await offline(t)
  const p = hex(crypto.randomBytes(32))
  const q = hex(crypto.randomBytes(32))
  await pagesDm.set(page, { peer: p, state: 'blocked' })
  for (let i = 0; i < 2001; i++) await pagesDm.set(page, { peer: q, state: i % 2 ? 'accepted' : 'declined' })
  t.is((await pagesDm.thread(page, { peer: p })).blocked, true, 'the block outlives 2001 newer ops')
})

test('pages-dm: the recipient lookup runs off the page chain and within one deadline', async (t) => {
  const port = await holdServer(t)
  const { page, pagesDm } = await offline(t, { port, limits: { connectTimeoutMs: 6000, deadlineMs: 1000 } })
  const to = hex(crypto.randomBytes(32))
  const t0 = Date.now()
  const sending = pagesDm.send(page, { to, text: 'oi' }, { member: 'm', nonce: 'n' })
  sending.catch(noop)
  await pagesDm.list(page, {})
  t.ok(Date.now() - t0 < 500, 'list does not wait on the lookup')
  let code = null
  try {
    await sending
  } catch (err) {
    code = err.code
  }
  t.ok(code === 'indisponivel' || code === 'sem-semeador', 'the send is refused')
  t.ok(Date.now() - t0 < 3000, 'within the deadline')
})

test('pages-dm: an unreadable revocation list refuses instead of judging', async (t) => {
  for (const revokedIssuers of [() => { throw new Error('x') }, () => 'x', 42]) {
    const { page, pagesDm } = await offline(t, { revokedIssuers })
    let code = null
    try {
      await pagesDm.send(page, { to: hex(crypto.randomBytes(32)), text: 'oi' }, { member: 'm', nonce: 'n' })
    } catch (err) {
      code = err.code
    }
    t.is(code, 'indisponivel')
  }
})

test('pages-dm: forget removes a closed page rows for good; a later stop does not bring them back', async (t) => {
  const { dir, page, pagesDm } = await offline(t)
  const peer = hex(crypto.randomBytes(32))
  await pagesDm.set(page, { peer, state: 'accepted' })
  t.ok(fs.existsSync(stateFile(dir, page)), 'DM activity saved the rows')

  // The writer's own removal alone: the cached rows come back at the stop.
  fs.rmSync(stateFile(dir, page))
  await pagesDm.stop(page)
  t.ok(fs.existsSync(stateFile(dir, page)), 'a stop re-saves the cached rows')

  const pending = pagesDm.set(page, { peer, state: 'declined' }).catch(noop)
  t.alike(await pagesDm.forget(page), { ok: true })
  await pending
  t.absent(fs.existsSync(stateFile(dir, page)), 'forget waits for in-flight work, then removes the rows')
  await pagesDm.stop(page)
  await pagesDm.set(page, { peer, state: 'accepted' }).catch(noop)
  t.absent(fs.existsSync(stateFile(dir, page)), 'a later stop or op does not recreate them')
  t.alike(await pagesDm.forget(page), { ok: true }, 'idempotent')
})

test('pages-dm: a folder op queued behind other work re-checks the role on its turn', async (t) => {
  const { dir, page, pagesDm } = await offline(t)
  const peer = hex(crypto.randomBytes(32))
  let code = null
  try {
    await pagesDm.set(page, { peer, state: 'blocked' }, { recheck: () => false })
  } catch (err) {
    code = err.code
  }
  t.is(code, 'sem-permissao', 'a lost role files no op')
  t.absent(fs.existsSync(stateFile(dir, page)), 'nothing saved')
  t.alike(await pagesDm.set(page, { peer, state: 'blocked' }, { recheck: () => true }), { ok: true })
  t.is(readRows(dir, page).ops.length, 1, 'a kept role files the op')
})

test('page group-post routes accept numeric forward flags and pass them to the writer', async (t) => {
  t.timeout(200000)
  const posts = []
  const group = 'ab'.repeat(32)
  const s = await setup(t, {
    pagesGroups: {
      groupPost: async (page, key, params) => {
        t.is(key, group)
        posts.push(params)
        return { seq: posts.length }
      }
    }
  })
  const ana = await s.newMember('ana')
  const { page } = await s.create(ana, 'horta')
  for (const fwd of [true, false, 2, -1, '1', null]) {
    const bad = await s.act(ana, 'group-post', page, { group, text: 'oi', fwd })
    t.is(bad.body.error, 'pedido-invalido')
  }
  t.is(posts.length, 0, 'invalid flags never reach the writer')
  for (const op of [{ group, text: 'oi' }, { group, text: 'oi', fwd: 0 }, { group, text: 'oi', fwd: 1 }]) {
    const out = await s.act(ana, 'group-post', page, op)
    t.is(out.status, 200, JSON.stringify(out.body))
  }
  t.alike(posts, [0, 0, 1].map(fwd => ({ text: 'oi', replyTo: null, fwd })))
})
