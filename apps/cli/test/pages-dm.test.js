'use strict'

// apps/cli/lib/account/pages-dm.js through the page routes, loopback only: a
// real Seeder with the dm pool and a test postage key behind seed-ws (local
// DHT), the account service with pages on, and a real browser node
// (packages/web-member lib/node.js over memory storage) as the member who
// writes to the page. The page's box keys are made here, as a device would:
// the service only ever sees their public halves and opaque shares.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept, signMoved, signOrigin } = require('@varanda/core/lib/page')
const { newPageSecrets, pairsOf, sealSecrets, signShare, verifyShare, openSecrets } = require('@varanda/core/lib/page-secrets')
const { postRecord } = require('@varanda/core/lib/records')
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

async function setup (t, { pagesGroups = null, hooks = {}, limits = {} } = {}) {
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
  const pagesDm = createPagesDm({ writer, pagesStore, keys, association, dir, env, log, hooks, limits: { refreshEveryMs: 0, ...limits } })
  t.teardown(() => pagesDm.close(), { force: true })
  await pagesDm.ready()

  const serverOpts = {
    association,
    origin: ORIGIN,
    google: { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } },
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log,
    pages: { keys, writer, pagesStore, dir, pagesDm, pagesGroups, blocklist: { has: () => false } }
  }
  // A fresh account service on the same data dir: the routes' in-memory
  // replay table starts empty, as after a restart.
  async function serve () {
    const l = await createAccountServer(serverOpts).listen({ host: '127.0.0.1', port: 0 })
    t.teardown(() => l.close(), { force: true })
    const base = 'http://127.0.0.1:' + l.port
    return async (pathname, body) => {
      const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    }
  }
  const api = await serve()

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

  async function invite (owner, page, who, share) {
    const row = pagesStore.get(page)
    const { nonce } = await startNonce(owner, 'invite')
    const admins = [...row.admins, who.hex].sort()
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins, prev: row.rosterSeq }, nonce)
    const op = { member: who.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: owner.hex, admins, prev: row.rosterSeq, at: record.at, nonce } }
    if (share !== undefined) op.share = share
    return api('/account/pages/invite', { member: owner.hex, nonce, page, op, signature: sign(owner, 'invite', nonce, page, op), record })
  }

  async function accept (who, page) {
    const inv = pagesStore.listFor(who.hex).invites[0]
    const { nonce } = await startNonce(who, 'accept')
    const f = { page, gen: inv.gen, rosterSignature: inv.rosterSignature, at: new Date().toISOString(), nonce, actor: who.hex }
    return api('/account/pages/accept', { member: who.hex, nonce, page, record: { type: 'page-accept', ...f, signature: signAccept(f, who.kp) } })
  }

  async function remove (owner, page, gone, dmBox) {
    const row = pagesStore.get(page)
    const { nonce } = await startNonce(owner, 'remove')
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins: row.admins.filter((a) => a !== gone), prev: row.rosterSeq }, nonce)
    const body = { member: owner.hex, nonce, page, record }
    if (dmBox !== undefined) body.dmBox = dmBox
    return { ...(await api('/account/pages/remove', body)), sent: body }
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

  async function move (m, page, dmBox) {
    const { nonce, to } = await startNonce(m, 'move')
    const row = pagesStore.get(page)
    const at = new Date().toISOString()
    const mv = { page, to, gen: row.gen, at, nonce, actor: m.hex, association }
    const og = { page: to, from: page, fromSeq: row.length, gen: row.gen, owner: m.hex, admins: row.admins, at, nonce, actor: m.hex, association }
    const body = {
      member: m.hex,
      nonce,
      page,
      record: { type: 'page-moved', ...mv, signature: signMoved(mv, m.kp) },
      origin: { type: 'page-origin', ...og, signature: signOrigin(og, m.kp) },
      roster: roster(m, to, { gen: 1, owner: m.hex, admins: row.admins, prev: null }, nonce)
    }
    if (dmBox !== undefined) body.dmBox = dmBox
    return { ...(await api('/account/pages/move', body)), to, sent: body }
  }

  return { api, serve, association, assocKp, writer, pagesStore, pagesDm, keys, dir, env, seeder, logs, newMember, act, create, invite, accept, remove, move, browserMember, putDrop }
}

// ---- helpers: a device's keys, the rows file of a legacy page --------------

const ROWS_LABEL = 'varanda-page-dm-rows-v1'
const ROWS_AAD = b4a.from('varanda-page-dm-v1')

function rowKey (page) {
  const master = nodeCrypto.createHmac('sha256', Buffer.from(PAGE_KEYS, 'hex')).update(ROWS_LABEL).digest()
  return nodeCrypto.createHmac('sha256', master).update(page).digest()
}

function stateFile (dir, page) {
  return path.join(dir, 'pages-dm', page + '.json')
}

function writeRows (dir, page, s) {
  fs.mkdirSync(path.join(dir, 'pages-dm'), { recursive: true })
  const iv = nodeCrypto.randomBytes(12)
  const c = nodeCrypto.createCipheriv('aes-256-gcm', rowKey(page), iv, { authTagLength: 16 })
  c.setAAD(ROWS_AAD)
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(s))), c.final()])
  fs.writeFileSync(stateFile(dir, page), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 })
}

function boxPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(32)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey, hex: hex(publicKey) }
}

function pairOf (secretKey) {
  const publicKey = b4a.alloc(32)
  sodium.crypto_scalarmult_base(publicKey, secretKey)
  return { publicKey, secretKey }
}

function sealedB64 () {
  return crypto.randomBytes(213).toString('base64')
}

function sigHex () {
  return hex(crypto.randomBytes(64))
}

// What a device sends: fresh boxes, opaque shares (the service never opens
// nor verifies them).
function boxOp ({ expectedGen, members, ownBox, box = boxPair().hex, groupBox = boxPair().hex }) {
  return { expectedGen, box, groupBox, ownBox, shares: members.map((member) => ({ member, sealed: sealedB64(), sig: sigHex() })) }
}

function bundleDir (dir, page) {
  return path.join(dir, 'pages-dm', page + '.legacy')
}

// What the owner's device does with the sealed chunks: opens each with its
// own box pair, checks bundleId, index and count, joins and parses them.
function openChunks (sealedList, pair, id = null) {
  let first = null
  let count = null
  const parts = []
  for (let i = 0; i < sealedList.length; i++) {
    const c = sealedList[i]
    const m = b4a.alloc(c.byteLength - sodium.crypto_box_SEALBYTES)
    if (!sodium.crypto_box_seal_open(m, c, pair.publicKey, pair.secretKey)) throw new Error('chunk does not open')
    const cid = hex(m.subarray(0, 32))
    if (first === null) first = cid
    if (cid !== first || (id !== null && cid !== id)) throw new Error('bundle id')
    if (m.readUInt16BE(32) !== i) throw new Error('index')
    if (count === null) count = m.readUInt16BE(34)
    if (m.readUInt16BE(34) !== count) throw new Error('count')
    parts.push(m.subarray(36))
  }
  if (count !== sealedList.length) throw new Error('missing chunks')
  return JSON.parse(b4a.toString(b4a.concat(parts), 'utf8'))
}

// The bundle as the service keeps it on disk.
function openBundleFiles (dir, page, pair) {
  const d = bundleDir(dir, page)
  const names = fs.readdirSync(d).filter((n) => /^[0-9]+$/.test(n)).sort((a, b) => Number(a) - Number(b))
  return openChunks(names.map((n) => fs.readFileSync(path.join(d, n))), pair)
}

// Every chunk through 'dm-legacy-read', 8 at a time.
async function readBundle (s, m, page) {
  const out = []
  let id = null
  let count = 1
  while (out.length < count) {
    const r = await s.act(m, 'dm-legacy-read', page, { from: out.length })
    if (r.status !== 200) return r
    id = r.body.id
    count = r.body.count
    if (r.body.chunks.length === 0 || r.body.chunks.length > 8) throw new Error('chunk page')
    for (const c of r.body.chunks) {
      if (c.index !== out.length) throw new Error('chunk order')
      out.push(b4a.from(c.sealed, 'base64'))
    }
  }
  return { id, count, sealed: out }
}

// A page as an older service left it: a gen 1 box secret in page-keys, its
// dm-key gen 1 on the diary and a sealed rows file.
async function makeLegacy (s, page, peer) {
  const legacy = boxPair()
  const row = s.keys.get(page)
  row.boxSecretKey = b4a.from(legacy.secretKey)
  s.keys.put(page, row)
  await s.writer.ensureDmKey(page, { box: legacy.hex, gen: 1 })
  await s.pagesStore.expectLength(page, s.writer.info(page).length)
  writeRows(s.dir, page, {
    v: 1,
    filed: Date.now(),
    stopped: false,
    messages: [{ id: hex(crypto.randomBytes(16)), peer, from: peer, text: 'mensagem antiga', replyTo: null, at: new Date().toISOString(), mine: false, fwd: 1, filedAt: Date.now() }],
    ops: [],
    seen: [],
    wallet: { items: [], kids: [] },
    sends: {}
  })
  return legacy
}

async function dmKeys (s, page) {
  return (await s.writer.readEntries(page)).filter((e) => e.record && e.record.type === 'dm-key').map((e) => ({ seq: e.seq, box: e.record.box, gen: e.record.gen }))
}

// Every X25519 secret the service holds in page-keys.json, any row, read as
// the operator could: the file decrypted under VARANDA_PAGE_KEYS, each row
// also read through the page-keys module.
function serviceSecrets (s) {
  const outer = JSON.parse(fs.readFileSync(path.join(s.dir, 'page-keys.json'), 'utf8'))
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(PAGE_KEYS, 'hex'), Buffer.from(outer.iv, 'base64'), { authTagLength: 16 })
  d.setAAD(b4a.from('varanda-page-keys-v1'))
  d.setAuthTag(Buffer.from(outer.tag, 'base64'))
  const inner = JSON.parse(Buffer.concat([d.update(Buffer.from(outer.data, 'base64')), d.final()]).toString('utf8'))
  const out = []
  for (const [pageKey, row] of Object.entries(inner.rows)) {
    for (const k of ['boxSecretKey', 'groupBoxSecretKey']) if (typeof row[k] === 'string') out.push(pairOf(b4a.from(row[k], 'hex')))
    const viaModule = s.keys.get(pageKey)
    for (const k of ['boxSecretKey', 'groupBoxSecretKey']) if (viaModule && viaModule[k]) out.push(pairOf(b4a.from(viaModule[k])))
  }
  return out
}

function serviceOpens (sealed, pairs) {
  return pairs.some((pair) => dmCore.openSealed(sealed, pair) !== null)
}

function scanFor (dir, needle) {
  const bytes = b4a.from(needle)
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (scanFor(p, needle)) return true
    } else if (e.isFile() && fs.readFileSync(p).includes(bytes)) {
      return true
    }
  }
  return false
}

test('pages-dm: the service cannot open a member message to the page once its keys moved to devices', async (t) => {
  t.timeout(400000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'padaria')
  t.is(made.status, 200, JSON.stringify(made.body))
  const page = made.page
  await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const own = boxPair()
  const device = boxPair()
  const r = await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex, box: device.hex }))
  t.is(r.status, 200, JSON.stringify(r.body))

  const X = await s.browserMember()
  await X.web.request('sync.start', {})
  await until(async () => {
    try {
      return (await X.web.request('dm.lookup', { member: page })).box === device.hex
    } catch {
      return false
    }
  }, { name: 'the member finds the published box', timeoutMs: 60000 })
  const SENTINEL = 'sentinela-' + hex(crypto.randomBytes(8))
  await X.web.request('dm.send', { to: page, text: SENTINEL })
  let drop = null
  await until(() => {
    for (const item of s.seeder._dm.page({ after: 0, limit: 1000 }).items) {
      const d = dmCore.decodeDrop(item.bytes)
      if (d === null) continue
      const inner = dmCore.openSealed(d.sealed, device)
      if (inner !== null && b4a.from(inner).includes(b4a.from(SENTINEL))) drop = d
    }
    return drop !== null
  }, { name: 'the drop is in the pool', timeoutMs: 30000 })
  t.ok(drop, 'the device box opens the member drop')

  t.absent(s.keys.get(page).boxSecretKey, '(i) the page row holds no box secret')
  t.absent(serviceOpens(drop.sealed, serviceSecrets(s)), '(ii) no X25519 secret the service holds opens the drop')
  t.absent(fs.existsSync(stateFile(s.dir, page)), '(iii) no rows file for the page')
  t.absent(scanFor(s.dir, SENTINEL), '(iv) the sentinel is nowhere in the data dir')

  // Control: a box the service does hold opens what is sealed to it, so
  // the check above would have caught one.
  const injected = boxPair()
  const row = s.keys.get(page)
  row.boxSecretKey = b4a.from(injected.secretKey)
  s.keys.put(page, row)
  const inner = b4a.alloc(dmCore.DM_INNER_BYTES)
  inner.set(b4a.from(SENTINEL))
  const sealed = dmCore.sealInner(inner, injected.hex)
  await s.putDrop(sealed)
  t.ok(serviceOpens(sealed, serviceSecrets(s)), 'control: the helper reports a drop the service can open')
})

test('pages-dm: a legacy page keeps its old rows read only until dm-box, which seals them with the old secret to the owner, publishes gen 2 and keeps only the sealed bundle', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  t.absent(s.keys.get(page).boxSecretKey, 'a new page gets no box secret')
  t.alike(await dmKeys(s, page), [], 'and no dm-key')
  const empty = await s.act(ana, 'dm-box-read', page, {})
  t.is(empty.status, 200, JSON.stringify(empty.body))
  t.is(empty.body.gen, 0)
  t.is(empty.body.box, null)

  const peer = hex(crypto.randomBytes(32))
  const legacy = await makeLegacy(s, page, peer)
  const l = await s.act(ana, 'dm-list', page, { folder: 'request' })
  t.is(l.status, 200, JSON.stringify(l.body))
  t.is(l.body.conversations.length, 1)
  t.is(l.body.conversations[0].legacy, true, 'an old conversation is marked legacy')
  const th = await s.act(ana, 'dm-thread', page, { peer })
  t.alike(th.body.messages.map((m) => [m.text, m.legacy]), [['mensagem antiga', true]])
  const before = await s.act(ana, 'dm-box-read', page, {})
  t.is(before.body.gen, 1)
  t.is(before.body.box, legacy.hex, 'the legacy gen 1 box')
  t.is(before.body.legacy, true)

  t.is(before.body.legacyBundle, null, 'no bundle before dm-box')
  t.is((await s.act(ana, 'dm-legacy-read', page, { from: 0 })).body.error, 'nao-encontrado')
  t.alike((await s.act(ana, 'dm-legacy-done', page, { id: hex(crypto.randomBytes(32)) })).body, { ok: true }, 'done without a bundle is ok')

  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, { ...boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }), imported: true })).body.error, 'pedido-invalido', 'imported is gone')
  const stale = await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))
  t.is(stale.status, 409)
  t.is(stale.body.error, 'conflito')
  t.ok(s.keys.get(page).boxSecretKey, 'a refusal keeps the legacy secret')

  const op = boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex })
  const r = await s.act(ana, 'dm-box', page, op)
  t.is(r.status, 200, JSON.stringify(r.body))
  t.is(r.body.gen, 2)
  const keysNow = await dmKeys(s, page)
  t.alike(keysNow[keysNow.length - 1], { seq: r.body.seq, box: op.box, gen: 2 }, 'dm-key gen 2 published')
  t.alike(Object.keys(r.body).sort(), ['gen', 'reboxPending', 'seq'], 'no legacy field in the answer')
  t.absent(s.keys.get(page).boxSecretKey, 'the legacy secret left page-keys')
  t.absent(fs.existsSync(stateFile(s.dir, page)), 'the rows file is gone')
  t.absent(scanFor(s.dir, 'mensagem antiga'), 'the old text is nowhere in the clear')
  t.is((await s.act(ana, 'dm-list', page, {})).body.error, 'nao-encontrado', 'no old rows to list')
  t.is((await s.act(ana, 'dm-thread', page, { peer })).body.error, 'nao-encontrado')

  const after = await s.act(ana, 'dm-box-read', page, {})
  t.is(after.body.gen, 2)
  t.is(after.body.box, op.box)
  t.is(after.body.groupBox, op.groupBox)
  t.is(after.body.share.sealed, op.shares[0].sealed)
  t.is(after.body.share.by, ana.hex)
  t.is(after.body.legacy, false)
  t.absent('legacyEnvelope' in after.body)
  t.absent('legacyBlocked' in after.body)
  const rec = s.pagesStore.get(page).dm.legacyBundle
  t.alike(after.body.legacyBundle, { id: rec.id, count: rec.count }, 'the owner reads the bundle record')
  t.is(rec.for, ana.hex)
  t.alike(after.body.shared, [ana.hex])
  t.alike(after.body.cert, s.writer.certOf(page))

  const got = await readBundle(s, ana, page)
  t.is(got.id, rec.id)
  const bundle = openChunks(got.sealed, own, rec.id)
  t.alike(Object.keys(bundle).sort(), ['box', 'ops', 'page', 'rows', 'v'])
  t.is(bundle.v, 1)
  t.is(bundle.page, page)
  t.is(bundle.box, hex(legacy.secretKey), 'the old secret travels in the bundle')
  t.alike(bundle.rows.map((x) => [x.from, x.to, x.text, x.replyTo, x.media, x.card, x.fwd, x.n]), [[peer, page, 'mensagem antiga', null, null, null, 1, 0]], 'a forwarded legacy row keeps fwd')
  t.alike(bundle.ops, [])
  t.exception(() => openChunks(got.sealed, boxPair()), 'another box cannot open it')
  t.is((await s.act(ana, 'dm-legacy-read', page, { from: 'x' })).body.error, 'pedido-invalido')
  t.alike((await s.act(ana, 'dm-legacy-read', page, { from: 99 })).body.chunks, [], 'past the end: no chunks')

  t.is((await s.act(ana, 'dm-legacy-done', page, { id: hex(crypto.randomBytes(32)) })).body.error, 'conflito', 'another id')
  t.ok(fs.existsSync(bundleDir(s.dir, page)), 'nothing removed')
  t.alike((await s.act(ana, 'dm-legacy-done', page, { id: rec.id })).body, { ok: true })
  t.absent(fs.existsSync(bundleDir(s.dir, page)), 'the chunks are gone')
  t.is(s.pagesStore.get(page).dm.legacyBundle, null)
  t.is((await s.act(ana, 'dm-box-read', page, {})).body.legacyBundle, null)
  t.alike((await s.act(ana, 'dm-legacy-done', page, { id: rec.id })).body, { ok: true }, 'idempotent')

  const page2 = (await s.create(ana, 'horta')).page
  const fresh = await s.act(ana, 'dm-box', page2, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))
  t.is(fresh.status, 200, JSON.stringify(fresh.body))
  t.is(fresh.body.gen, 1, 'a new page starts at gen 1')
  t.is(s.pagesStore.get(page2).dm.legacyBundle, null, 'a new page has no bundle')
})

test('pages-dm: shares per member, the invite share, dm-sign, and a removed admin who must rotate and is refused', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const page = (await s.create(ana, 'padaria')).page
  const own = boxPair()
  const share = { sealed: sealedB64(), sig: sigHex() }
  const early = await s.invite(ana, page, caio, share)
  t.is(early.body.error, 'pedido-invalido', 'no invite share before the page has device keys')

  const first = boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex })
  t.is((await s.act(bia, 'dm-box', page, first)).body.error, 'sem-permissao', 'not a member of the page')
  t.is((await s.act(ana, 'dm-box', page, { ...first, shares: [{ member: bia.hex, sealed: sealedB64(), sig: sigHex() }] })).body.error, 'pedido-invalido', 'shares must include the owner')
  t.is((await s.act(ana, 'dm-box', page, { ...first, shares: [...first.shares, ...first.shares] })).body.error, 'pedido-invalido', 'a member at most once')
  t.is((await s.act(ana, 'dm-box', page, { ...first, shares: [{ ...first.shares[0], sealed: sealedB64().slice(4) }] })).body.error, 'pedido-invalido', 'a sealed share of another size')
  t.is((await s.act(ana, 'dm-box', page, first)).status, 200)

  t.is((await s.invite(ana, page, bia, share)).status, 200)
  t.is((await s.accept(bia, page)).status, 200)
  const bread = await s.act(bia, 'dm-box-read', page, {})
  t.is(bread.status, 200, JSON.stringify(bread.body))
  t.alike(bread.body.share, { gen: 1, sealed: share.sealed, by: ana.hex, sig: share.sig, at: bread.body.share.at }, 'the invite share is the admin share')
  t.is(bread.body.legacyBundle, null)
  t.absent('shared' in bread.body, 'owner fields stay with the owner')
  const aread = await s.act(ana, 'dm-box-read', page, {})
  t.is(aread.body.share.sealed, first.shares[0].sealed, 'each member reads only its own share')
  t.alike(aread.body.shared, [ana.hex, bia.hex].sort())
  t.is((await s.act(caio, 'dm-box-read', page, {})).body.error, 'sem-permissao')

  const extra = { member: ana.hex, gen: 1, sealed: sealedB64(), sig: sigHex() }
  t.is((await s.act(bia, 'dm-box-share', page, extra)).body.error, 'conflito', 'an admin never writes the owner share')
  t.is(s.pagesStore.get(page).dm.shares[ana.hex].sealed, first.shares[0].sealed, 'nothing written')
  t.is((await s.act(bia, 'dm-box-share', page, { ...extra, member: caio.hex })).body.error, 'pedido-invalido', 'never outside the roster')
  t.is((await s.act(bia, 'dm-box-share', page, { ...extra, gen: 2 })).body.error, 'conflito', 'only the current gen')
  t.is((await s.act(ana, 'dm-box-share', page, extra)).status, 200, 'the owner replaces its own share')
  t.is((await s.act(ana, 'dm-box-read', page, {})).body.share.sealed, extra.sealed)

  const digest = hex(crypto.randomBytes(32))
  const signed = await s.act(bia, 'dm-sign', page, { digest })
  t.is(signed.status, 200, JSON.stringify(signed.body))
  const sig = b4a.from(signed.body.signature, 'hex')
  const pk = b4a.from(page, 'hex')
  const { expiresAt } = signed.body
  t.alike(Object.keys(signed.body).sort(), ['expiresAt', 'signature'])
  t.ok(Number.isSafeInteger(expiresAt), 'expiresAt is an integer')
  t.ok(expiresAt > Date.now() && expiresAt <= Date.now() + dmCore.DM_V3_TTL_MS, 'expiresAt is within the TTL of now')
  const exp = b4a.alloc(8)
  exp.writeUInt32BE(Math.floor(expiresAt / 0x100000000), 0)
  exp.writeUInt32BE(expiresAt % 0x100000000, 4)
  t.ok(crypto.verify(b4a.concat([b4a.from(dmCore.DM_V3_PREFIX), b4a.from(digest, 'hex'), exp]), sig, pk), 'verifies over DM_V3_PREFIX || digest || uint64be(expiresAt) with the page key')
  t.absent(crypto.verify(b4a.concat([b4a.from(dmCore.DM_V3_PREFIX), b4a.from(digest, 'hex')]), sig, pk), 'not without the expiry')
  t.is((await s.act(bia, 'dm-sign', page, { digest, expiresAt: Number.MAX_SAFE_INTEGER })).body.error, 'pedido-invalido', 'the caller never picks expiresAt')
  t.absent(crypto.verify(b4a.from(digest, 'hex'), sig, pk), 'not over the bare digest')
  t.absent(crypto.verify(b4a.from(digest), sig, pk), 'not over its hex')
  t.absent(JSON.stringify(s.logs).includes(digest), 'the digest is never logged')
  t.is((await s.act(caio, 'dm-sign', page, { digest })).body.error, 'sem-permissao')

  const length = s.writer.info(page).length
  const noBox = await s.remove(ana, page, bia.hex)
  t.is(noBox.body.error, 'rotacao-necessaria', 'an activated page rotates with a remove')
  t.is(s.writer.info(page).length, length, 'nothing appended')
  const wrong = await s.remove(ana, page, bia.hex, boxOp({ expectedGen: 1, members: [ana.hex, bia.hex], ownBox: own.hex }))
  t.is(wrong.body.error, 'pedido-invalido', 'never a share for the removed admin')
  t.is((await s.remove(ana, page, bia.hex, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))).body.error, 'conflito')
  t.is(s.writer.info(page).length, length, 'still nothing appended')
  const rot = boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex })
  const removed = await s.remove(ana, page, bia.hex, rot)
  t.is(removed.status, 200, JSON.stringify(removed.body))
  t.is(removed.body.dmGen, 2)
  const row = s.pagesStore.get(page)
  t.alike(row.admins, [])
  t.is(row.dm.gen, 2)
  t.alike(Object.keys(row.dm.shares), [ana.hex], 'only the remaining roster holds a share')
  t.is(row.dm.shares[ana.hex].gen, 2)
  t.is(row.dm.reboxPending, true, 'a new group box marks the groups for a rebox')
  const ks = await dmKeys(s, page)
  t.alike(ks[ks.length - 1].box, rot.box)
  t.is(ks[ks.length - 1].gen, 2)
  t.is(row.length, s.writer.info(page).length, 'the ACL follows the diary')

  t.is((await s.act(bia, 'dm-sign', page, { digest })).body.error, 'sem-permissao', 'a removed admin cannot sign')
  t.is((await s.act(bia, 'dm-box-share', page, { ...extra, gen: 2 })).body.error, 'sem-permissao')
  t.is((await s.act(bia, 'dm-box-read', page, {})).body.error, 'sem-permissao')
})

test('pages-dm: dm-box-share: an admin only adds a missing share, the owner replaces any', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const page = (await s.create(ana, 'padaria')).page
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: boxPair().hex }))).status, 200)
  const biaShare = { sealed: sealedB64(), sig: sigHex() }
  t.is((await s.invite(ana, page, bia, biaShare)).status, 200)
  t.is((await s.accept(bia, page)).status, 200)
  t.is((await s.invite(ana, page, caio)).status, 200, 'an invite without a share')
  t.is((await s.accept(caio, page)).status, 200)
  const shares = () => s.pagesStore.get(page).dm.shares
  t.absent(shares()[caio.hex], 'caio holds no share yet')

  const ownerBefore = shares()[ana.hex].sealed
  const overOwner = await s.act(caio, 'dm-box-share', page, { member: ana.hex, gen: 1, sealed: sealedB64(), sig: sigHex() })
  t.is(overOwner.body.error, 'conflito', 'an admin overwriting the owner share')
  t.is(shares()[ana.hex].sealed, ownerBefore, 'the owner share is untouched')

  const overAdmin = await s.act(caio, 'dm-box-share', page, { member: bia.hex, gen: 1, sealed: sealedB64(), sig: sigHex() })
  t.is(overAdmin.body.error, 'conflito', 'an admin overwriting another admin share')
  t.is(shares()[bia.hex].sealed, biaShare.sealed, 'bia share is untouched')
  t.is((await s.act(bia, 'dm-box-share', page, { member: bia.hex, gen: 1, sealed: sealedB64(), sig: sigHex() })).body.error, 'conflito', 'nor its own existing one')

  const add = { member: caio.hex, gen: 1, sealed: sealedB64(), sig: sigHex() }
  t.is((await s.act(bia, 'dm-box-share', page, add)).status, 200, 'an admin adds a missing share')
  t.is(shares()[caio.hex].sealed, add.sealed)
  t.is(shares()[caio.hex].by, bia.hex)
  t.is((await s.act(bia, 'dm-box-share', page, { ...add, sealed: sealedB64(), sig: sigHex() })).body.error, 'conflito', 'and only once')

  const replace = { member: bia.hex, gen: 1, sealed: sealedB64(), sig: sigHex() }
  t.is((await s.act(ana, 'dm-box-share', page, replace)).status, 200, 'the owner replaces a share')
  t.is(shares()[bia.hex].sealed, replace.sealed)
  t.is(shares()[bia.hex].by, ana.hex)
})

test('pages-dm: of two concurrent dm-box with the same expectedGen exactly one wins', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const own = boxPair()
  const res = await Promise.all([0, 1].map(() => s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))))
  t.alike(res.map((r) => r.status).sort(), [200, 409])
  t.ok(res.some((r) => r.body.error === 'conflito'))
  const ks = await dmKeys(s, page)
  t.is(ks.length, 1, 'one dm-key appended')
  t.is(s.pagesStore.get(page).dm.box, ks[0].box, 'the winner is on record')
})

test('pages-dm: the legacy bundle is recorded before the secret goes and survives a crash between the two', async (t) => {
  t.timeout(200000)
  let crash = true
  const s = await setup(t, { hooks: { afterLegacyPersist: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const legacy = await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const own = boxPair()
  const r = await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))
  t.is(r.status, 202, 'the crash leaves the answer uncertain')
  const rec = s.pagesStore.get(page).dm.legacyBundle
  t.ok(rec, 'the bundle was recorded first')
  t.ok(s.keys.get(page).boxSecretKey, 'the crash came before the secret was deleted')
  t.ok(fs.existsSync(stateFile(s.dir, page)))

  // The service stops and starts again on the same data dir.
  await s.pagesDm.close()
  crash = false
  const again = createPagesDm({ writer: s.writer, pagesStore: s.pagesStore, keys: s.keys, association: s.association, dir: s.dir, env: s.env, limits: { refreshEveryMs: 0 } })
  t.teardown(() => again.close(), { force: true })
  await again.ready()
  t.absent(s.keys.get(page).boxSecretKey, 'the restart finishes the wipe')
  t.absent(fs.existsSync(stateFile(s.dir, page)))
  const read = await again.read(page, { member: ana.hex, owner: true })
  t.alike(read.legacyBundle, { id: rec.id, count: rec.count }, 'dm-box-read still answers the bundle')
  t.is(openBundleFiles(s.dir, page, own).box, hex(legacy.secretKey), 'the start never deletes a recorded bundle')
  t.is(read.gen, 2)
})

test('pages-dm: the refresh tick re-appends the stored dm-key once it leaves the window', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const op = boxOp({ expectedGen: 0, members: [ana.hex], ownBox: boxPair().hex })
  t.is((await s.act(ana, 'dm-box', page, op)).status, 200)
  t.is(await s.pagesDm.refresh(), 0, 'inside the window nothing is appended')
  for (let i = 0; i < 33; i++) await s.writer.append(page, Array.from({ length: 8 }, (_, j) => postRecord({ text: 'p' + i + '-' + j })))
  t.is(await s.pagesDm.refresh(), 1, 'out of the window: appended again')
  const ks = await dmKeys(s, page)
  t.is(ks.length, 2)
  t.alike({ box: ks[1].box, gen: ks[1].gen }, { box: op.box, gen: 1 }, 'the same stored public box and gen')
  t.is(s.pagesStore.get(page).length, s.writer.info(page).length)
  t.is(await s.pagesDm.refresh(), 0)
})

test('pages-dm: dm-sign is rate limited per page and per host', async (t) => {
  const dir = tmpDir(t, 'varanda-pdm-')
  const kps = [crypto.keyPair(), crypto.keyPair()]
  const writer = { ready: async () => {}, pageKeys: () => [], ensureDmKey: async () => ({ seq: null, length: 0 }), follows: () => [] }
  const keys = {
    get: (page) => {
      const kp = kps.find((k) => hex(k.publicKey) === page)
      return kp ? { secretKey: b4a.from(kp.secretKey), mediaSecretKey: b4a.alloc(64) } : null
    },
    put: noop
  }
  const logs = []
  const pagesDm = createPagesDm({ writer, keys, association: 'ab'.repeat(32), dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS }, log: (e) => logs.push(e), limits: { refreshEveryMs: 0, signPerPage: 2, signPerHost: 3 } })
  t.teardown(() => pagesDm.close(), { force: true })
  await pagesDm.ready()
  const [a, b] = kps.map((k) => hex(k.publicKey))
  const digest = hex(crypto.randomBytes(32))
  const code = async (page) => {
    try {
      await pagesDm.signDigest(page, digest)
      return 'ok'
    } catch (err) {
      return err.code
    }
  }
  t.alike([await code(a), await code(a), await code(a)], ['ok', 'ok', 'limite'], 'per page')
  t.alike([await code(b), await code(b)], ['ok', 'limite'], 'per host')
  t.alike(logs, [{ event: 'page-dm', reason: 'limite' }, { event: 'page-dm', reason: 'limite' }], 'only the reason is logged')
})

test('pages-dm: a remove whose rotation crashed fails closed until its resend or a start completes it', async (t) => {
  t.timeout(200000)
  const crash = { before: false, after: false }
  const hooks = {
    beforePublish: async () => { if (crash.before) throw new Error('crash') },
    afterPublish: async () => { if (crash.after) throw new Error('crash') }
  }
  const s = await setup(t, { hooks })
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const page = (await s.create(ana, 'padaria')).page
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))).status, 200)
  t.is((await s.invite(ana, page, bia, { sealed: sealedB64(), sig: sigHex() })).status, 200)
  t.is((await s.accept(bia, page)).status, 200)

  crash.before = true
  const rot = boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex })
  const cut = await s.remove(ana, page, bia.hex, rot)
  t.is(cut.status, 202, 'the crash leaves the remove uncertain')
  const row = s.pagesStore.get(page)
  t.alike(row.admins, [], 'the removal is on record')
  t.is(row.dm.rotatePending.box, rot.box, 'with its prepared rotation')
  t.is(row.dm.gen, 1)
  const digest = hex(crypto.randomBytes(32))
  t.is((await s.act(ana, 'dm-sign', page, { digest })).body.error, 'rotacao-necessaria', 'no signature while the rotation is pending')
  t.is((await s.act(ana, 'dm-box-share', page, { member: ana.hex, gen: 1, sealed: sealedB64(), sig: sigHex() })).body.error, 'rotacao-necessaria')
  const mid = await s.act(ana, 'dm-box-read', page, {})
  t.is(mid.status, 200, 'dm-box-read still answers')
  t.is(mid.body.rotatePending, true)
  t.is(mid.body.gen, 1)
  t.is(mid.body.share, null)

  crash.before = false
  const again = await s.api('/account/pages/remove', cut.sent)
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.dmGen, 2, 'the resend completes the rotation')
  const done = s.pagesStore.get(page)
  t.is(done.dm.rotatePending, null)
  t.is(done.dm.box, rot.box)
  t.alike(Object.keys(done.dm.shares), [ana.hex], 'shares for the remaining roster only')
  const ks = await dmKeys(s, page)
  t.alike(ks.filter((k) => k.gen === 2).map((k) => k.box), [rot.box], 'published once')
  t.is((await s.act(ana, 'dm-sign', page, { digest })).status, 200)

  // Between publish and promote: the start promotes the published box.
  crash.after = true
  const next = boxOp({ expectedGen: 2, members: [ana.hex], ownBox: own.hex })
  t.is((await s.act(ana, 'dm-box', page, next)).status, 202)
  t.is(s.pagesStore.get(page).dm.gen, 2, 'not promoted yet')
  t.is((await dmKeys(s, page)).pop().box, next.box, 'but published')
  const between = await s.act(ana, 'dm-box-read', page, {})
  t.is(between.body.share, null, 'no share that may not match the newest published box')
  t.is(between.body.rotatePending, true)
  crash.after = false
  await s.pagesDm.close()
  const restarted = createPagesDm({ writer: s.writer, pagesStore: s.pagesStore, keys: s.keys, association: s.association, dir: s.dir, env: s.env, limits: { refreshEveryMs: 0 } })
  t.teardown(() => restarted.close(), { force: true })
  await restarted.ready()
  const promoted = s.pagesStore.get(page).dm
  t.is(promoted.gen, 3, 'the start promotes it')
  t.is(promoted.box, next.box)
  t.is(promoted.rotatePending, null)
  t.is((await dmKeys(s, page)).filter((k) => k.gen === 3).length, 1, 'without publishing it twice')
})

test('pages-dm: dm-box persisted but not published completes on the resend of the same request', async (t) => {
  t.timeout(200000)
  let crash = true
  const s = await setup(t, { hooks: { beforePublish: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const op = boxOp({ expectedGen: 0, members: [ana.hex], ownBox: boxPair().hex })
  const first = await s.act(ana, 'dm-box', page, op)
  t.is(first.status, 202)
  t.alike(await dmKeys(s, page), [], 'nothing published')
  const mid = await s.act(ana, 'dm-box-read', page, {})
  t.is(mid.body.gen, 0)
  t.is(mid.body.share, null, 'no share for a box not yet published')
  t.is(mid.body.rotatePending, true)
  crash = false
  const again = await s.api('/account/pages/dm-box', first.body2)
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.gen, 1)
  t.is((await dmKeys(s, page)).length, 1)
  t.is((await s.act(ana, 'dm-box-read', page, {})).body.share.sealed, op.shares[0].sealed)
})

test('pages-dm: a legacy cleanup cut between the rows and the secret finishes, keyed off the bundle', async (t) => {
  t.timeout(200000)
  let crash = true
  const s = await setup(t, { hooks: { afterRowsDropped: () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const r = await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: boxPair().hex }))
  t.is(r.status, 202)
  t.absent(fs.existsSync(stateFile(s.dir, page)), 'the rows went first')
  t.ok(s.keys.get(page).boxSecretKey, 'the crash left the secret')
  crash = false
  const read = await s.act(ana, 'dm-box-read', page, {})
  t.is(read.body.legacy, false, 'no rows: not legacy')
  t.ok(read.body.legacyBundle)
  t.absent(s.keys.get(page).boxSecretKey, 'the secret goes too')
  t.is(read.body.gen, 2)
})

test('pages-dm: a move carries the box to K2 as its gen 1 with the shares, also after a crash and resend', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))).status, 200)
  t.is((await s.move(ana, page)).body.error, 'rotacao-necessaria', 'an activated page moves with its box')
  t.is((await s.move(ana, page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))).body.error, 'conflito', 'K2 starts at gen 0')

  const box = boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex })
  const orig = s.pagesStore.move
  s.pagesStore.move = async () => {
    s.pagesStore.move = orig
    throw new Error('crash')
  }
  const cut = await s.move(ana, page, box)
  t.is(cut.status, 202, 'the crash leaves the move uncertain')
  const k2 = cut.to
  t.alike((await dmKeys(s, k2)).map((k) => [k.box, k.gen]), [[box.box, 1]], 'K2 got its dm-key gen 1 before it was announced')
  // A restart forgets the replay hash: a retry with another box is refused.
  const after = await s.serve()
  const other = await after('/account/pages/move', { ...cut.sent, dmBox: boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }) })
  t.is(other.status, 409)
  t.is(other.body.error, 'conflito', 'the box must be the one already on K2')
  t.is(s.pagesStore.get(k2), null, 'nothing stored')
  // That use's hash is held in memory now; a later start takes the original.
  const later = await s.serve()
  const again = await later('/account/pages/move', cut.sent)
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.page, k2)
  const row = s.pagesStore.get(k2)
  t.is(row.dm.gen, 1)
  t.is(row.dm.box, box.box)
  t.is(row.length, s.writer.info(k2).length)
  t.absent('dm' in s.pagesStore.get(page), 'K1 keeps no shares')
  const read = await s.act(ana, 'dm-box-read', k2, {})
  t.is(read.status, 200, JSON.stringify(read.body))
  t.is(read.body.gen, 1)
  t.is(read.body.share.sealed, box.shares[0].sealed, 'the shares are readable on K2')
  t.alike((await dmKeys(s, k2)).length, 1, 'published once')
})

test('pages-dm: while a rotation is pending a remove and an invite share are refused; once it completes, the remove seals for exactly expectedGen + 1', async (t) => {
  t.timeout(200000)
  const ctl = { crash: false, gate: null, paused: null }
  const hooks = {
    beforePublish: async () => {
      if (ctl.crash) throw new Error('crash')
      if (ctl.gate !== null) {
        const g = ctl.gate
        ctl.gate = null
        ctl.paused()
        await g
      }
    }
  }
  const s = await setup(t, { hooks })
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const page = (await s.create(ana, 'padaria')).page
  const anaBox = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: anaBox.hex }))).status, 200)
  t.is((await s.invite(ana, page, bia, { sealed: sealedB64(), sig: sigHex() })).status, 200)
  t.is((await s.accept(bia, page)).status, 200)

  // A dm-box cut before its publish: a rotation to gen 2 is left pending.
  ctl.crash = true
  const pending = boxOp({ expectedGen: 1, members: [ana.hex, bia.hex], ownBox: anaBox.hex })
  t.is((await s.act(ana, 'dm-box', page, pending)).status, 202)
  ctl.crash = false
  t.is(s.pagesStore.get(page).dm.rotatePending.gen, 2)

  // An invite share now would carry an unsettled gen: refused, nothing
  // written, and the store stays usable.
  const seqBefore = s.pagesStore.snapshot().seq
  t.is((await s.invite(ana, page, caio, { sealed: sealedB64(), sig: sigHex() })).body.error, 'rotacao-necessaria')
  t.is(s.pagesStore.snapshot().seq, seqBefore, 'nothing written')
  t.ok(s.pagesStore.available())

  // The tick's recovery pauses at its publish; a remove meanwhile is refused.
  let release
  ctl.gate = new Promise((resolve) => { release = resolve })
  const paused = new Promise((resolve) => { ctl.paused = resolve })
  const recovery = s.pagesDm.refresh()
  await paused
  const length = s.writer.info(page).length
  const early = await s.remove(ana, page, bia.hex, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: anaBox.hex }))
  t.is(early.body.error, 'rotacao-necessaria', 'no remove over a pending rotation')
  t.is(s.writer.info(page).length, length, 'nothing appended')
  t.alike(s.pagesStore.get(page).admins, [bia.hex])
  release()
  await recovery
  const d2 = s.pagesStore.get(page).dm
  t.is(d2.rotatePending, null, 'the recovery completed the pending rotation')
  t.is(d2.gen, 2)
  t.is(d2.box, pending.box)

  // The device seals for gen 3 = expectedGen + 1, with the real envelopes.
  const secrets = newPageSecrets()
  const pairs = pairsOf(secrets)
  const sealed = sealSecrets(secrets, { page, gen: 3, member: ana.hex, box: anaBox.hex })
  const sig = signShare({ page, gen: 3, member: ana.hex, sealed }, ana.kp)
  const rot = { expectedGen: 2, box: hex(pairs.dmBox.publicKey), groupBox: hex(pairs.groupBox.publicKey), ownBox: anaBox.hex, shares: [{ member: ana.hex, sealed, sig }] }
  const removed = await s.remove(ana, page, bia.hex, rot)
  t.is(removed.status, 200, JSON.stringify(removed.body))
  t.is(removed.body.dmGen, 3)
  const read = await s.act(ana, 'dm-box-read', page, {})
  t.is(read.body.gen, 3)
  t.is(read.body.box, rot.box)
  const share = read.body.share
  t.ok(verifyShare({ page, gen: share.gen, member: ana.hex, sealed: share.sealed }, share.sig, ana.hex), 'the share verifies for its gen')
  const opened = openSecrets(share.sealed, anaBox, { page, gen: share.gen, member: ana.hex })
  t.ok(opened, 'and opens for that gen')
  t.alike(opened.dmSeed, secrets.dmSeed)
  const ks = await dmKeys(s, page)
  t.alike([ks[ks.length - 1].box, ks[ks.length - 1].gen], [rot.box, 3])
  t.is((await s.act(ana, 'dm-sign', page, { digest: hex(crypto.randomBytes(32)) })).status, 200)
})

test('pages-dm: a dm-box-share replayed after a restart answers from its spent nonce and never overwrites a newer share', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: boxPair().hex }))).status, 200)
  const A = await s.act(ana, 'dm-box-share', page, { member: ana.hex, gen: 1, sealed: sealedB64(), sig: sigHex() })
  t.is(A.status, 200)
  const B = await s.act(ana, 'dm-box-share', page, { member: ana.hex, gen: 1, sealed: sealedB64(), sig: sigHex() })
  t.is(B.status, 200)
  const after = await s.serve()
  const replay = await after('/account/pages/dm-box-share', A.body2)
  t.is(replay.status, 200, JSON.stringify(replay.body))
  t.is(replay.body.ok, true)
  t.is(replay.body.replay, true, 'answered from the spent nonce')
  t.is(s.pagesStore.get(page).dm.shares[ana.hex].sealed, B.body2.op.sealed, 'the stored share stays B')
})

test('pages-dm: a legacy cleanup cut after promotion survives a further rotation and finishes at the next start', async (t) => {
  t.timeout(200000)
  let crash = true
  const s = await setup(t, { hooks: { afterLegacyPersist: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const legacy = await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))).status, 202)
  const rec = s.pagesStore.get(page).dm.legacyBundle
  t.is(s.pagesStore.get(page).dm.gen, 2, 'promoted, cleanup cut')
  t.ok(s.keys.get(page).boxSecretKey)
  // A further rotation, its cleanup cut too: the bundle goes on with it.
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 2, members: [ana.hex], ownBox: own.hex }))).status, 202)
  const d3 = s.pagesStore.get(page).dm
  t.is(d3.gen, 3)
  t.alike(d3.legacyBundle, rec, 'the bundle is carried forward')
  const read = await s.act(ana, 'dm-box-read', page, {})
  t.alike(read.body.legacyBundle, { id: rec.id, count: rec.count }, 'still readable by the owner')
  crash = false
  await s.pagesDm.close()
  const again = createPagesDm({ writer: s.writer, pagesStore: s.pagesStore, keys: s.keys, association: s.association, dir: s.dir, env: s.env, limits: { refreshEveryMs: 0 } })
  t.teardown(() => again.close(), { force: true })
  await again.ready()
  t.absent(s.keys.get(page).boxSecretKey, 'the start removes the secret')
  t.absent(fs.existsSync(stateFile(s.dir, page)), 'and the rows')
  t.alike((await again.read(page, { member: ana.hex, owner: true })).legacyBundle, { id: rec.id, count: rec.count })
  t.is(openBundleFiles(s.dir, page, own).box, hex(legacy.secretKey), 'the bundle still opens')
})

test('pages-dm: a page with a pending rotation it cannot publish can still move; K2 starts at gen 1 with its shares', async (t) => {
  t.timeout(200000)
  let crash = false
  const s = await setup(t, { hooks: { beforePublish: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex }))).status, 200)
  crash = true
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))).status, 202)
  t.ok(s.pagesStore.get(page).dm.rotatePending, 'a rotation is stuck pending')
  await s.pagesStore.pause(page)
  const box = boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex })
  const moved = await s.move(ana, page, box)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const k2 = moved.to
  const row = s.pagesStore.get(k2)
  t.is(row.dm.gen, 1)
  t.is(row.dm.box, box.box)
  t.is(row.dm.rotatePending, null)
  t.absent('dm' in s.pagesStore.get(page), 'K1 pending rotation dropped with the move')
  t.alike((await dmKeys(s, k2)).map((k) => [k.box, k.gen]), [[box.box, 1]])
  crash = false
  const read = await s.act(ana, 'dm-box-read', k2, {})
  t.is(read.body.share.sealed, box.shares[0].sealed)
})

test('pages-dm: chunks written before a crash without their record are removed; the next dm-box seals a fresh bundle', async (t) => {
  t.timeout(200000)
  let crash = true
  const s = await setup(t, { hooks: { afterBundleChunks: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const legacy = await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))).status, 202)
  t.ok(fs.existsSync(bundleDir(s.dir, page)), 'stray chunks on disk')
  t.absent(s.pagesStore.get(page).dm, 'no record, no rotation')
  t.ok(s.keys.get(page).boxSecretKey, 'the legacy secret stays')
  t.ok(fs.existsSync(stateFile(s.dir, page)), 'and the rows')
  await s.pagesDm.close()
  const again = createPagesDm({ writer: s.writer, pagesStore: s.pagesStore, keys: s.keys, association: s.association, dir: s.dir, env: s.env, limits: { refreshEveryMs: 0 } })
  t.teardown(() => again.close(), { force: true })
  await again.ready()
  t.absent(fs.existsSync(bundleDir(s.dir, page)), 'the start removes the stray chunks')
  crash = false
  const own2 = boxPair()
  const done = await again.applyBox(page, { by: ana.hex, dmBox: boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own2.hex }), idem: { member: ana.hex, nonce: 'n'.repeat(43) } })
  t.is(done.gen, 2)
  t.is(openBundleFiles(s.dir, page, own2).box, hex(legacy.secretKey), 'a fresh bundle, sealed to the new own box')
  t.absent(s.keys.get(page).boxSecretKey)
})

test('pages-dm: the legacy bundle holds every old row and op, no cap; rotations and a remove keep it; a transfer hides it from the new owner; done removes it', async (t) => {
  t.timeout(400000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const page = (await s.create(ana, 'padaria')).page
  t.is((await s.invite(ana, page, bia)).status, 200)
  t.is((await s.accept(bia, page)).status, 200)
  const legacy = await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const t0 = Date.now() - 100000
  const peers = Array.from({ length: 101 }, () => hex(crypto.randomBytes(32)))
  const media = [{ id: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(24)), chunks: 1, bytes: 20000, sha256: hex(crypto.randomBytes(32)), mime: 'image/jpeg', w: 640, h: 480, ms: 0 }]
  const messages = peers.map((peer, i) => ({ id: hex(crypto.randomBytes(16)), peer, from: peer, text: 'pedido ' + i + ' ' + 'x'.repeat(900), replyTo: null, at: new Date(t0 + i).toISOString(), mine: false, ...(i === 7 ? { fwd: 1 } : {}), filedAt: t0 + i * 10 }))
  messages.push({ id: hex(crypto.randomBytes(16)), peer: peers[0], from: page, text: '', replyTo: messages[0].id, media, at: new Date(t0 + 5000).toISOString(), mine: true, filedAt: t0 + 5000 })
  // Filed out of array order: the bundle follows filedAt.
  messages.unshift({ id: hex(crypto.randomBytes(16)), peer: peers[1], from: peers[1], text: 'primeira', replyTo: null, at: new Date(t0 - 1).toISOString(), mine: false, filedAt: t0 - 1 })
  const ctl = (o, peer, i) => ({ t: 'ctl', id: hex(crypto.randomBytes(16)), op: o, peer, at: new Date(t0 + 6000 + i).toISOString(), filedAt: t0 + 6000 + i })
  const ops = [ctl('accepted', peers[0], 1), ctl('declined', peers[1], 2), ctl('blocked', peers[2], 3), ctl('blocked', peers[3], 4), ctl('unblocked', peers[3], 5), ctl('deleted', peers[4], 6), ctl('blocked', page, 7), { t: 'ctl', op: 'outro', peer: peers[5], filedAt: t0 + 6008 }]
  // peers[4] writes again after its conversation was deleted.
  const late = { id: hex(crypto.randomBytes(16)), peer: peers[4], from: peers[4], text: 'depois do apagar', replyTo: null, at: new Date(t0 + 6100).toISOString(), mine: false, filedAt: t0 + 6100 }
  messages.splice(3, 0, late)
  writeRows(s.dir, page, { v: 1, filed: t0 + 7000, stopped: false, messages, ops, seen: [], wallet: { items: [], kids: [] }, sends: {} })

  const own = boxPair()
  const r = await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex, bia.hex], ownBox: own.hex }))
  t.is(r.status, 200, JSON.stringify(r.body))
  const rec = s.pagesStore.get(page).dm.legacyBundle
  t.ok(rec.count > 1, 'more than one chunk: ' + rec.count)
  const files = fs.readdirSync(bundleDir(s.dir, page))
  t.is(files.length, rec.count, 'one file per chunk, no temporary file left')
  for (const f of files) t.is(fs.statSync(path.join(bundleDir(s.dir, page), f)).mode & 0o777, 0o600)
  t.absent(fs.existsSync(stateFile(s.dir, page)), 'the rows file is gone')
  t.absent(s.keys.get(page).boxSecretKey, 'the secret is gone')
  t.absent(scanFor(s.dir, 'pedido 100 '), 'no old text in the clear')

  const got = await readBundle(s, ana, page)
  const bundle = openChunks(got.sealed, own, rec.id)
  t.is(bundle.box, hex(legacy.secretKey))
  const ordered = [...messages].sort((a, b) => a.filedAt - b.filedAt)
  t.is(bundle.rows.length, 104, 'every row, none capped')
  // Expected n: rows filed before the ops are 0..102, the ops 103..108,
  // the late row 109.
  const early = ordered.filter((m) => m !== late)
  t.alike(bundle.rows, [...early, late].map((m, i) => ({ id: m.id, from: m.from, to: m.mine ? m.peer : page, text: m.text, at: m.at, replyTo: m.replyTo, media: m.media || null, card: null, fwd: m.fwd === 1 ? 1 : 0, n: m === late ? 109 : i })), 'exactly the rows, in filing order, with their filing position')
  t.alike(bundle.ops, [['accepted', peers[0]], ['declined', peers[1]], ['blocked', peers[2]], ['blocked', peers[3]], ['unblocked', peers[3]], ['deleted', peers[4]]].map(([op, peer], i) => ({ op, peer, n: 103 + i })), 'every folder, block and delete op in order, nothing else')
  const deleted = bundle.ops.find((o) => o.op === 'deleted')
  const after = bundle.rows.find((x) => x.id === late.id)
  t.ok(after.n > deleted.n, 'a row filed after a deleted op keeps a larger n')
  const ns = [...bundle.rows, ...bundle.ops].map((x) => x.n)
  t.is(new Set(ns).size, ns.length, 'n unique across rows and ops')
  t.alike(Object.keys(bundle.rows[0]).sort(), ['at', 'card', 'from', 'fwd', 'id', 'media', 'n', 'replyTo', 'text', 'to'])
  t.is(bundle.rows.filter((x) => x.fwd === 1).length, 1, 'a forwarded row keeps fwd 1, the others 0')
  t.alike(Object.keys(bundle.ops[0]).sort(), ['n', 'op', 'peer'])
  t.is((await s.act(bia, 'dm-legacy-read', page, { from: 0 })).body.error, 'nao-encontrado', 'an admin it is not sealed to gets nothing')
  t.is((await s.act(bia, 'dm-box-read', page, {})).body.legacyBundle, null)
  t.is((await s.act(bia, 'dm-legacy-done', page, { id: rec.id })).body.error, 'conflito', 'nor can it drop it')

  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 2, members: [ana.hex, bia.hex], ownBox: own.hex }))).status, 200)
  t.alike(s.pagesStore.get(page).dm.legacyBundle, rec, 'a rotation keeps it')
  const removed = await s.remove(ana, page, bia.hex, boxOp({ expectedGen: 3, members: [ana.hex], ownBox: own.hex }))
  t.is(removed.status, 200, JSON.stringify(removed.body))
  t.alike(s.pagesStore.get(page).dm.legacyBundle, rec, 'a remove keeps it')
  t.is(openBundleFiles(s.dir, page, own).box, hex(legacy.secretKey), 'the chunks are untouched')

  // A transfer to bia, ana staying as admin (the ACL step of transfer-accept).
  const row = s.pagesStore.get(page)
  await s.pagesStore.setRoster(page, { gen: row.gen + 1, seq: row.rosterSeq + 1, owner: bia.hex, admins: [ana.hex] })
  t.is((await s.pagesDm.read(page, { member: bia.hex, owner: true })).legacyBundle, null, 'the new owner does not see it')
  t.alike((await s.pagesDm.read(page, { member: ana.hex, owner: false })).legacyBundle, { id: rec.id, count: rec.count }, 'the old owner, now admin, still does')
  await t.exception(s.pagesDm.legacyRead(page, { member: bia.hex, from: 0 }), /nao-encontrado/)
  t.is((await s.pagesDm.legacyRead(page, { member: ana.hex, from: 0 })).id, rec.id)
  await t.exception(s.pagesDm.legacyDone(page, { member: bia.hex, id: rec.id }), /conflito/)
  t.alike(await s.pagesDm.legacyDone(page, { member: ana.hex, id: rec.id }), { ok: true })
  t.absent(fs.existsSync(bundleDir(s.dir, page)), 'done removes the chunks')
  t.is(s.pagesStore.get(page).dm.legacyBundle, null)
})

test('pages-dm: a close removes the legacy bundle', async (t) => {
  t.timeout(200000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: boxPair().hex }))).status, 200)
  t.ok(fs.existsSync(bundleDir(s.dir, page)))
  await s.pagesStore.close(page)
  await s.pagesDm.forget(page)
  t.absent(fs.existsSync(bundleDir(s.dir, page)), 'the chunks go with the page')
})

test('pages-dm: a move before dm-legacy-done carries the bundle to K2, readable there by its member, also after a restart', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const legacy = await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))).status, 200)
  const rec = s.pagesStore.get(page).dm.legacyBundle
  t.ok(rec, 'the bundle is on record')
  const box = boxOp({ expectedGen: 0, members: [ana.hex], ownBox: own.hex })
  const moved = await s.move(ana, page, box)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const k2 = moved.to
  t.alike(s.pagesStore.get(k2).dm.legacyBundle, rec, 'K2 names the same bundle, still for ana')
  t.is(s.pagesStore.get(k2).dm.gen, 1)
  t.is(fs.readdirSync(bundleDir(s.dir, k2)).length, rec.count, 'every chunk copied to K2')
  await until(() => !fs.existsSync(bundleDir(s.dir, page)), { name: 'K1 chunks gone', timeoutMs: 10000 })
  t.alike((await s.act(ana, 'dm-box-read', k2, {})).body.legacyBundle, { id: rec.id, count: rec.count })
  const got = await readBundle(s, ana, k2)
  t.is(got.id, rec.id)
  t.is(openChunks(got.sealed, own, rec.id).box, hex(legacy.secretKey), 'the bundle opens with the owner box on K2')

  await s.pagesDm.close()
  const again = createPagesDm({ writer: s.writer, pagesStore: s.pagesStore, keys: s.keys, association: s.association, dir: s.dir, env: s.env, limits: { refreshEveryMs: 0 } })
  t.teardown(() => again.close(), { force: true })
  await again.ready()
  t.ok(fs.existsSync(bundleDir(s.dir, k2)), 'a restart keeps the bundle K2 names')
  const after = await again.legacyRead(k2, { member: ana.hex, from: 0 })
  t.is(openChunks(after.chunks.map((c) => b4a.from(c.sealed, 'base64')), own, rec.id).box, hex(legacy.secretKey))
  t.alike(await again.legacyDone(k2, { member: ana.hex, id: rec.id }), { ok: true })
  t.absent(fs.existsSync(bundleDir(s.dir, k2)))
  t.is(s.pagesStore.get(k2).dm.legacyBundle, null)
})

test('pages-dm: a first dm-box that never published does not block a move; the bundle rides alone in a gen 0 row', async (t) => {
  t.timeout(300000)
  let crash = true
  const s = await setup(t, { hooks: { beforePublish: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  const legacy = await makeLegacy(s, page, hex(crypto.randomBytes(32)))
  const own = boxPair()
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: own.hex }))).status, 202)
  const d = s.pagesStore.get(page).dm
  t.is(d.gen, 0)
  t.ok(d.rotatePending, 'the first rotation is persisted, not published')
  const rec = d.legacyBundle
  t.ok(rec)
  t.is((await s.act(ana, 'dm-box-read', page, {})).body.rotatePending, true, 'dm-box-read tells the app a rotation is pending')
  const moved = await s.move(ana, page)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const k2 = moved.to
  const row = s.pagesStore.get(k2)
  t.alike(row.dm, { gen: 0, box: null, groupBox: null, shares: {}, pending: {}, reboxPending: false, legacyBundle: rec, rotatePending: null }, 'K2 holds the bundle alone')
  t.alike(await dmKeys(s, k2), [], 'no dm-key on K2 yet')
  crash = false
  await until(() => s.keys.get(page) === null || !s.keys.get(page).boxSecretKey, { name: 'K1 legacy secret gone', timeoutMs: 10000 })
  const read = (await s.act(ana, 'dm-box-read', k2, {})).body
  t.is(read.gen, 0)
  t.is(read.rotatePending, false)
  t.alike(read.legacyBundle, { id: rec.id, count: rec.count })
  t.is(openChunks((await readBundle(s, ana, k2)).sealed, own, rec.id).box, hex(legacy.secretKey))
  t.is(await s.pagesDm.refresh(), 0, 'the refresh tick skips a row without a box')
  // The owner activates K2: no legacy check, the bundle is kept.
  const first = await s.act(ana, 'dm-box', k2, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: boxPair().hex }))
  t.is(first.status, 200, JSON.stringify(first.body))
  t.is(s.pagesStore.get(k2).dm.gen, 1)
  t.alike(s.pagesStore.get(k2).dm.legacyBundle, rec, 'the rotation keeps it')
  t.is((await s.act(ana, 'dm-legacy-done', k2, { id: rec.id })).status, 200)
  t.is(s.pagesStore.get(k2).dm.legacyBundle, null)
})

test('pages-dm: a gen 0 page with a first rotation pending moves without a dmBox; done on a bundle-only row leaves no dm', async (t) => {
  t.timeout(300000)
  let crash = true
  const s = await setup(t, { hooks: { beforePublish: async () => { if (crash) throw new Error('crash') } } })
  const ana = await s.newMember('ana')
  const page = (await s.create(ana, 'padaria')).page
  t.is((await s.act(ana, 'dm-box', page, boxOp({ expectedGen: 0, members: [ana.hex], ownBox: boxPair().hex }))).status, 202)
  t.is(s.pagesStore.get(page).dm.gen, 0)
  const moved = await s.move(ana, page)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  t.absent('dm' in s.pagesStore.get(moved.to), 'no bundle, no keys: K2 starts without dm')
  crash = false

  // A bundle-only K2 whose import is confirmed keeps no dm row at all.
  const p2 = (await s.create(ana, 'quitanda')).page
  await makeLegacy(s, p2, hex(crypto.randomBytes(32)))
  crash = true
  t.is((await s.act(ana, 'dm-box', p2, boxOp({ expectedGen: 1, members: [ana.hex], ownBox: boxPair().hex }))).status, 202)
  const rec = s.pagesStore.get(p2).dm.legacyBundle
  const m2 = await s.move(ana, p2)
  t.is(m2.status, 200, JSON.stringify(m2.body))
  crash = false
  t.is((await s.act(ana, 'dm-legacy-done', m2.to, { id: rec.id })).status, 200)
  t.absent('dm' in s.pagesStore.get(m2.to), 'nothing is left')
  t.absent(fs.existsSync(bundleDir(s.dir, m2.to)))
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
