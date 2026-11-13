'use strict'

// apps/cli/lib/account/pages-routes.js end to end, loopback only: the
// account service with pages on (page-keys, pages-store, the pages writer
// linked to a real seeder over seed-ws, local DHT), members linked straight
// through the directory store (the Google step is account-e2e.test.js's),
// and a third member that reads the page diary from the seeder.

const http = require('node:http')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const { videoBounds } = require('@varanda/rpc')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { signRoster, signAccept, signOffer, pageState, pendingOffer } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { followSet } = require('@varanda/core/lib/media')
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
const DAY = 24 * 3600 * 1000

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

// One video sample with complete container tables, so refusal cannot be
// explained by an invalid MPEG-4 container.
function mp4 (width, height) {
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts)
    return Buffer.concat([u32(body.length + 8), Buffer.from(type), body])
  }
  const time = (size) => {
    const b = Buffer.alloc(size)
    b.writeUInt32BE(1000, 12)
    b.writeUInt32BE(3000, 16)
    return b
  }
  const mvhd = time(100)
  for (const offset of [36, 52]) mvhd.writeUInt32BE(0x10000, offset)
  mvhd.writeUInt32BE(0x40000000, 68)
  const tkhd = Buffer.alloc(84)
  tkhd.writeUInt32BE(7, 0)
  tkhd.writeUInt32BE(1, 12)
  tkhd.writeUInt32BE(3000, 20)
  for (const offset of [40, 56]) tkhd.writeUInt32BE(0x10000, offset)
  tkhd.writeUInt32BE(0x40000000, 72)
  tkhd.writeUInt32BE(width * 0x10000, 76)
  tkhd.writeUInt32BE(height * 0x10000, 80)
  const entry = Buffer.alloc(78)
  entry.writeUInt16BE(1, 6)
  entry.writeUInt16BE(width, 24)
  entry.writeUInt16BE(height, 26)
  entry.writeUInt16BE(0x18, 74)
  entry.writeUInt16BE(0xffff, 76)
  const avcC = box('avcC', Buffer.from([1, 100, 0, 40, 255, 225, 0, 4, 103, 100, 0, 40, 1, 0, 1, 104]))
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0), Buffer.from('isommp41'))
  const stbl = box('stbl',
    box('stsd', u32(0), u32(1), box('avc1', entry, avcC)),
    box('stts', u32(0), u32(1), u32(1), u32(3000)),
    box('stsz', u32(0), u32(10), u32(1)),
    box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)),
    box('stco', u32(0), u32(1), u32(ftyp.length + 8)))
  const minf = box('minf', box('vmhd', u32(1), Buffer.alloc(8)),
    box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))), stbl)
  const mdia = box('mdia', box('mdhd', time(24)),
    box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(13)), minf)
  return Buffer.concat([ftyp, box('mdat', Buffer.alloc(10, 1)),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), mdia))])
}

function sha (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function mediaGet (port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
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

// A reader on the association topic that never announces anything.
async function thirdMember (t, bootstrap, association) {
  const store = new Corestore(tmpDir(t, 'varanda-reader-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    attachAdmission(socket, { role: 'member', have: [], onmessage: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(association)])
  async function read (key, seq) {
    const core = store.get({ key: b4a.from(key, 'hex'), valueEncoding: 'json' })
    await core.ready()
    try {
      return await core.get(seq, { timeout: 3000 })
    } catch {
      return null
    } finally {
      await core.close().catch(() => {})
    }
  }
  return {
    read,
    async entries (key, length) {
      const out = []
      for (let seq = 0; seq < length; seq++) {
        const record = await read(key, seq)
        if (record === null) return null
        out.push({ seq, record })
      }
      return out
    }
  }
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

  // `to` null: the owner's signed cancel ({ to: null, exp: null }); `exp`
  // set on a cancel replaces it after signing (a shape signOffer refuses).
  async function offer (owner, page, to, gen, { exp } = {}) {
    const { nonce } = await start(owner, 'offer')
    const f = { page, to: to === null ? null : to.hex, exp: to === null ? null : new Date(Date.now() + 24 * 3600 * 1000).toISOString(), gen, at: new Date().toISOString(), nonce, actor: owner.hex }
    const record = { type: 'page-offer', ...f, signature: signOffer(f, owner.kp) }
    if (exp !== undefined) record.exp = exp
    return api('POST', '/account/pages/offer', { member: owner.hex, nonce, page, record })
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

  return { ctx, store, terms, api, logs, newMember, start, sign, act, create, invite, accept, rosterAct, offer, upload, restart }
}

test('account pages: create, admins, transfer, follows, media, replay and the ACL mirror', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const eva = await s.newMember('eva')
  const dani = await s.newMember(null)

  t.alike((await api('GET', '/account/pages/policy')).body, { available: true, maxOwned: 8, maxAdmins: 16 })

  // Create; the name resolves to the page and the seeder serves it.
  const made = await s.create(ana, 'padaria')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  t.is(made.body.page, K)
  const lookup = await api('GET', '/account/username/padaria')
  t.is(lookup.body.kind, 'page')
  t.is(lookup.body.member, K)
  const reader = await thirdMember(t, ctx.bootstrap, ctx.association)
  const served = await until(() => s.ctx.writer && reader.read(K, 2), { name: 'served roster', timeoutMs: 30000 })
  t.is(served.type, 'page-roster', 'a third member reads the page from the seeder')

  // Name collisions, both ways.
  t.is((await s.create(bia, 'ana')).body.error, 'nome-em-uso', 'a page cannot take a person name')
  await t.exception(s.newMember('padaria'), /nome-em-uso/, 'a person cannot take a page name')

  // A creation failing after the directory reserved its name: the page is
  // wiped and the name stays burned.
  ctx.failCreate = true
  const failed = await s.create(bia, 'feira')
  t.is(failed.body.error, 'limite')
  t.exception(() => ctx.writer.info(failed.page), /nao-encontrada/, 'the writer holds nothing of it')
  t.is(ctx.pagesStore.get(failed.page), null, 'no ACL row')
  t.ok(s.logs.some((e) => e.event === 'pagina' && e.reason === 'nome-queimado'))
  t.is((await s.create(caio, 'feira')).body.error, 'nome-em-uso', 'the reserved name is never given out again')
  const feira = await s.create(bia, 'feirinha')
  t.is(feira.status, 200, 'another name works once the writer does')
  const F = feira.page

  // The owner posts and likes.
  const post = await s.act(ana, 'post', K, { text: 'pão quente' })
  t.is(post.status, 200, JSON.stringify(post.body))
  const like = await s.act(ana, 'like', K, { to: K + ':' + post.body.seq, on: true })
  t.is(like.status, 200)

  // Replay: the same request answers the same seq and appends nothing; the
  // same nonce with another body is refused.
  const lengthBefore = ctx.writer.info(K).length
  const again = await api('POST', '/account/pages/post', post.sent)
  t.is(again.status, 200)
  t.is(again.body.seq, post.body.seq)
  t.is(ctx.writer.info(K).length, lengthBefore, 'a replay appends nothing')
  const otherOp = { text: 'outro texto' }
  const forged = { ...post.sent, op: otherOp, signature: s.sign(ana, 'post', post.sent.nonce, K, otherOp) }
  t.is((await api('POST', '/account/pages/post', forged)).body.error, 'expirado')
  t.is(ctx.writer.info(K).length, lengthBefore)

  // Refusals: not an admin, unlinked, blocked.
  t.is((await s.act(caio, 'post', K, { text: 'não sou admin' })).body.error, 'sem-permissao', 'a member who is not an admin cannot post')
  const unlinked = await s.act(dani, 'post', K, { text: 'x' })
  t.is(unlinked.body.error, 'nao-vinculado')
  ctx.blocked.add(eva.hex)
  t.is((await s.act(eva, 'post', K, { text: 'x' })).body.error, 'sem-permissao', 'a blocked member is refused')
  t.is(ctx.writer.info(K).length, lengthBefore, 'refusals append nothing')

  // Invite and accept; the admin posts.
  let row = ctx.pagesStore.get(K)
  const inv = await s.invite(ana, K, bia, row)
  t.is(inv.status, 200, JSON.stringify(inv.body))
  t.is((await s.act(bia, 'post', K, { text: 'antes de aceitar' })).body.error, 'sem-permissao', 'an invite alone grants nothing')
  const invites = ctx.pagesStore.listFor(bia.hex).invites
  t.is(invites.length, 1)
  const acc = await s.accept(bia, K, invites[0].gen, invites[0].rosterSignature)
  t.is(acc.status, 200, JSON.stringify(acc.body))
  t.alike(ctx.pagesStore.get(K).admins, [bia.hex])
  t.is((await s.act(bia, 'post', K, { text: 'sou admin' })).status, 200, 'the admin posts')

  // Remove: the admin's next post is refused and the length did not move.
  row = ctx.pagesStore.get(K)
  const rem = await s.rosterAct('remove', ana, K, { gen: row.gen + 1, owner: ana.hex, admins: [], prev: row.rosterSeq })
  t.is(rem.status, 200, JSON.stringify(rem.body))
  const afterRemove = ctx.writer.info(K).length
  t.is((await s.act(bia, 'post', K, { text: 'removida' })).body.error, 'sem-permissao')
  t.is(ctx.writer.info(K).length, afterRemove, 'the removed admin appended nothing')

  // Offer and transfer: the old owner cannot invite, still posts, and the
  // new owner removes them.
  row = ctx.pagesStore.get(K)
  const off = await s.offer(ana, K, caio, row.gen)
  t.is(off.status, 200, JSON.stringify(off.body))
  row = ctx.pagesStore.get(K)
  const tr = await s.rosterAct('transfer-accept', caio, K, { gen: row.gen + 1, owner: caio.hex, admins: [ana.hex], prev: row.rosterSeq })
  t.is(tr.status, 200, JSON.stringify(tr.body))
  row = ctx.pagesStore.get(K)
  t.is(row.owner, caio.hex)
  t.is((await s.invite(ana, K, bia, row)).body.error, 'sem-permissao', 'the old owner cannot invite')
  t.is((await s.act(ana, 'post', K, { text: 'ainda admin' })).status, 200, 'the old owner still posts')
  row = ctx.pagesStore.get(K)
  t.is((await s.rosterAct('remove', caio, K, { gen: row.gen + 1, owner: caio.hex, admins: [], prev: row.rosterSeq })).status, 200)
  t.is((await s.act(ana, 'post', K, { text: 'fora' })).body.error, 'sem-permissao')

  // Follows: a person and a page; unfollow; a blocked target.
  const person = member()
  const f1 = await s.act(caio, 'follow', K, { key: person.hex, on: true })
  t.is(f1.status, 200, JSON.stringify(f1.body))
  t.is((await s.act(caio, 'follow', K, { key: F, on: true })).status, 200, 'a page may follow a page')
  t.is((await s.act(caio, 'follow', K, { key: eva.hex, on: true })).body.error, 'sem-permissao', 'a blocked target is refused')
  t.is((await s.act(caio, 'follow', K, { key: K, on: true })).body.error, 'pedido-invalido', 'never its own key')
  let length = ctx.writer.info(K).length
  let entries = await until(() => reader.entries(K, length), { name: 'served follows', timeoutMs: 30000 })
  t.alike(followSet(entries, K).sort(), [person.hex, F].sort(), 'the served diary follows both')
  t.is((await s.act(caio, 'follow', K, { key: person.hex, on: false })).status, 200)
  length = ctx.writer.info(K).length
  entries = await until(() => reader.entries(K, length), { name: 'served unfollow', timeoutMs: 30000 })
  t.alike(followSet(entries, K), [F], 'unfollow removes one')
  const follows = await s.act(caio, 'follows', K, {})
  t.alike(follows.body.follows.map((f) => f.key), [F])
  t.is(ctx.pagesStore.get(K).follows, 1)

  // Media: an admin uploads a jpeg and posts it; a third member gets both.
  row = ctx.pagesStore.get(K)
  t.is((await s.invite(caio, K, bia, row)).status, 200)
  const inv2 = ctx.pagesStore.listFor(bia.hex).invites[0]
  t.is((await s.accept(bia, K, inv2.gen, inv2.rosterSignature)).status, 200)
  const img = jpeg(640, 480, 70 * 1024)
  const op = { sha256: sha(img), mime: 'image/jpeg', width: 640, height: 480, bytes: img.length }
  const up = await s.upload(bia, K, img, op)
  t.is(up.status, 200, JSON.stringify(up.body))
  const d = up.body.descriptor
  t.is(d.sha256, op.sha256)
  const video = mp4(640, 480)
  t.alike(videoBounds(video), { width: 640, height: 480, ms: 3000, audio: false }, 'a valid short video container')
  const beforeVideo = ctx.writer.info(K).length
  const beforeItems = ctx.writer.items(K)
  for (const bytes of [video, img]) {
    const refused = await s.upload(bia, K, bytes, { ...op, mime: 'video/mp4', bytes: bytes.length, sha256: sha(bytes) })
    t.is(refused.status, 400, 'an authenticated admin cannot upload video')
    t.is(refused.body.error, 'midia-invalida')
  }
  t.is(ctx.writer.info(K).length, beforeVideo, 'a refused video appends no record')
  t.alike(ctx.writer.items(K), beforeItems, 'a refused video stores no media item')
  t.is((await s.upload(bia, K, img, { ...op, sha256: 'ab'.repeat(32) })).body.error, 'midia-invalida', 'the body must hash to the op')
  t.is((await s.upload(dani, K, img, op)).body.error, 'nao-vinculado')
  const foreign = { ...d, core: F }
  t.is((await s.act(bia, 'post', K, { text: 'foto', media: [foreign] })).body.error, 'midia-invalida', 'a descriptor of another core')
  const photo = await s.act(bia, 'post', K, { text: 'foto', media: [d] })
  t.is(photo.status, 200, JSON.stringify(photo.body))
  const got = await until(() => reader.read(K, photo.body.seq), { name: 'served photo post', timeoutMs: 30000 })
  t.alike(got.media, [d])
  const bytes = await until(async () => {
    const r = await mediaGet(ctx.seedPort, '/media/' + K + '/' + d.core + '/' + d.start + '/' + d.blocks)
    return r.status === 200 ? r.body : null
  }, { name: 'served media', timeoutMs: 30000 })
  t.alike(bytes, img, 'the bytes are served')

  // Status and the public mirror: full-mode pageState equals the ACL.
  const status = await s.act(bia, 'status', K, {})
  t.is(status.status, 200)
  t.is(status.body.owner, caio.hex)
  t.alike(status.body.admins, [bia.hex])
  length = ctx.writer.info(K).length
  entries = await until(() => reader.entries(K, length), { name: 'served diary', timeoutMs: 30000 })
  const st = pageState(entries, K, ctx.association, { full: true })
  row = ctx.pagesStore.get(K)
  t.is(st.page, true)
  t.is(st.owner, row.owner)
  t.alike(st.admins, row.admins)
  t.is(st.gen, row.gen)
  t.is(st.seq, row.rosterSeq)

  // Never a tombstone over a page record (after the mirror check: the
  // seeder clears deleted blocks).
  t.is((await s.act(bia, 'delete', K, { to: K + ':2' })).body.error, 'pedido-invalido')
  t.is((await s.act(bia, 'delete', K, { to: K + ':' + photo.body.seq })).status, 200)

  // Logs carry no key.
  const text = JSON.stringify(s.logs)
  t.absent(text.includes(K) || text.includes(ana.hex) || text.includes(bia.hex), 'logs name no key')
})

test('account pages: off answers 404 and the policy says unavailable', async (t) => {
  const s = await setup(t, { pages: false })
  t.alike((await s.api('GET', '/account/pages/policy')).body, { available: false })
  const m = member()
  const r = await s.api('POST', '/account/pages/start', { member: m.hex, action: 'post' })
  t.is(r.status, 404)
  t.is((await s.api('POST', '/account/pages/post', { member: m.hex })).status, 404)
})

test('account pages: the Vitrine handles shown on varanda.app are refused as page names', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const owner = await s.newMember('dona')
  const handles = ['biblioteca_praca', 'horta_do_bairro', 'lia_oliveira', 'joao_nascimento', 'cecilia_ramos',
    'andre_costa', 'bia_araujo', 'tomas_ferreira']
  for (const username of handles) {
    const r = await s.create(owner, username)
    t.alike([r.status, r.body], [400, { error: 'nome-invalido' }], username)
    t.is(ctx.pagesStore.get(r.page), null, username + ': no ACL row')
    t.is((await api('GET', '/account/username/' + username)).status, 404, username + ': no name reserved for it')
  }
  t.is(ctx.pagesStore.listFor(owner.hex).owned.length, 0)
})

test('account pages: an offer to a non-admin of a page with 16 admins is limite', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const owner = await s.newMember('dona')
  const made = await s.create(owner, 'quitanda')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const admins = []
  for (let i = 0; i < 16; i++) {
    const m = await s.newMember('adm' + i)
    t.is((await s.invite(owner, K, m, ctx.pagesStore.get(K))).status, 200)
    const inv = ctx.pagesStore.listFor(m.hex).invites[0]
    t.is((await s.accept(m, K, inv.gen, inv.rosterSignature)).status, 200)
    admins.push(m)
  }
  t.is(ctx.pagesStore.get(K).admins.length, 16)
  const outsider = await s.newMember('fora')
  const length = ctx.writer.info(K).length
  t.is((await s.offer(owner, K, outsider, ctx.pagesStore.get(K).gen)).body.error, 'limite', 'no room for the old owner')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')
  t.is((await s.offer(owner, K, admins[0], ctx.pagesStore.get(K).gen)).status, 200, 'an admin recipient is fine')
})

test('account pages: a cancelled offer is a signed record on the diary and transfer-accept is refused', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const made = await s.create(ana, 'feira')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const reader = await thirdMember(t, ctx.bootstrap, ctx.association)
  let row = ctx.pagesStore.get(K)
  const off = await s.offer(ana, K, bia, row.gen)
  t.is(off.status, 200, JSON.stringify(off.body))
  let length = ctx.writer.info(K).length
  let entries = await until(() => reader.entries(K, length), { name: 'served offer', timeoutMs: 30000 })
  t.is(pendingOffer(entries, pageState(entries, K, ctx.association, { full: true }), Date.now()).to, bia.hex, 'the diary shows the offer')

  // Mixed shapes never pass; only the owner cancels.
  const at = new Date().toISOString()
  t.is((await s.offer(ana, K, null, row.gen, { exp: at })).body.error, 'assinatura-invalida', 'to null with an exp')
  t.is((await s.offer(bia, K, null, row.gen)).body.error, 'sem-permissao', 'only the owner cancels')
  t.is((await s.offer(ana, K, null, row.gen + 1)).body.error, 'expirado', 'another gen')
  t.is(ctx.writer.info(K).length, length, 'refusals append nothing')

  const cancel = await s.offer(ana, K, null, row.gen)
  t.is(cancel.status, 200, JSON.stringify(cancel.body))
  t.is(cancel.body.cancelled, true)
  t.is(ctx.pagesStore.get(K).offer, null, 'the ACL forgot the offer')
  length = ctx.writer.info(K).length
  t.is(cancel.body.length, length)
  entries = await until(() => reader.entries(K, length), { name: 'served cancel', timeoutMs: 30000 })
  t.is(entries[cancel.body.seq].record.to, null, 'the cancel is on the served diary')
  t.is(pendingOffer(entries, pageState(entries, K, ctx.association, { full: true }), Date.now()), null, 'no pending offer after the cancel')

  row = ctx.pagesStore.get(K)
  const tr = await s.rosterAct('transfer-accept', bia, K, { gen: row.gen + 1, owner: bia.hex, admins: [ana.hex], prev: row.rosterSeq })
  t.is(tr.body.error, 'sem-permissao', 'no offer left to accept')
  t.is(ctx.pagesStore.get(K).owner, ana.hex, 'the owner did not change')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')

  // The old unsigned cancel is gone.
  t.is((await s.api('POST', '/account/pages/start', { member: ana.hex, action: 'offer-cancel' })).body.error, 'pedido-invalido')
  t.is((await s.api('POST', '/account/pages/offer-cancel', { member: ana.hex })).body.error, 'pedido-invalido')
})

test('account pages: concurrent creates of an owner with 7 pages: one succeeds, the other is limite and publishes nothing', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const owner = await s.newMember('sete')
  for (let i = 0; i < 7; i++) await ctx.pagesStore.create({ page: member().hex, owner: owner.hex })
  const [a, b] = await Promise.all([s.create(owner, 'lojaa'), s.create(owner, 'lojab')])
  const won = [a, b].filter((r) => r.status === 200)
  const lost = [a, b].filter((r) => r.status !== 200)
  t.is(won.length, 1, 'exactly one creation succeeds')
  t.is(lost.length, 1)
  t.is(lost[0].status, 503, JSON.stringify(lost[0].body))
  t.is(lost[0].body.error, 'limite')
  const lostName = lost[0] === a ? 'lojaa' : 'lojab'
  t.is((await api('GET', '/account/username/' + lostName)).status, 404, 'no name reserved for it')
  t.exception(() => ctx.writer.info(lost[0].page), /nao-encontrada/, 'no diary for it')
  t.is(ctx.pagesStore.get(lost[0].page), null)
  t.is(ctx.pagesStore.listFor(owner.hex).owned.length, 8)
})

test('account pages: a resend after a lost answer or a restart appends once', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'reenvio')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page

  // The ACL commit fails after the append: the answer is uncertain, and the
  // resend answers what the writer recorded.
  ctx.failExpect = true
  const first = await s.act(ana, 'post', K, { text: 'perdida' })
  t.is(first.status, 202)
  t.alike(first.body, { uncertain: true })
  const length = ctx.writer.info(K).length
  const again = await api('POST', '/account/pages/post', first.sent)
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.seq, length - 1)
  t.is(ctx.writer.info(K).length, length, 'the resend appended nothing')

  // The service dies between the append and the answer.
  ctx.failAppend = 'after'
  const second = await s.act(ana, 'post', K, { text: 'reinicio' })
  t.is(second.status, 202)
  const length2 = ctx.writer.info(K).length
  t.is(length2, length + 1)
  await s.restart()
  const resent = await api('POST', '/account/pages/post', second.sent)
  t.is(resent.status, 200, JSON.stringify(resent.body))
  t.is(resent.body.seq, length2 - 1)
  t.is(ctx.writer.info(K).length, length2, 'the resend after a restart appended nothing')
  const fresh = await s.act(ana, 'post', K, { text: 'nova' })
  t.is(fresh.status, 200, 'a new request after the restart still writes')
  t.is(ctx.writer.info(K).length, length2 + 1)

  // Another body with a nonce already used appends nothing.
  const otherOp = { text: 'outro' }
  const forged = { ...second.sent, op: otherOp, signature: s.sign(ana, 'post', second.sent.nonce, K, otherOp) }
  await api('POST', '/account/pages/post', forged)
  t.is(ctx.writer.info(K).length, length2 + 1, 'a reused nonce never appends')

  const file = path.join(ctx.dir, 'page-nonce-key.json')
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'the nonce key file is 0600')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.absent(JSON.stringify(s.logs).includes(saved.key), 'the nonce key is never logged')
})

test('account pages: a resend while the first post is in flight is em-andamento and the page gets one post', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'devagar')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const length = ctx.writer.info(K).length

  let release
  ctx.holdAppend = new Promise((resolve) => { release = resolve })
  const { nonce } = await s.start(ana, 'post')
  const op = { text: 'lenta' }
  const sent = { member: ana.hex, nonce, page: K, op, signature: s.sign(ana, 'post', nonce, K, op) }
  const first = api('POST', '/account/pages/post', sent)
  await until(() => ctx.holdAppend === null, { name: 'append held' })
  const busy = await api('POST', '/account/pages/post', sent)
  t.is(busy.status, 409, JSON.stringify(busy.body))
  t.alike(busy.body, { error: 'em-andamento' })
  release()
  const done = await first
  t.is(done.status, 200, JSON.stringify(done.body))
  const later = await api('POST', '/account/pages/post', sent)
  t.is(later.status, 200, JSON.stringify(later.body))
  t.is(later.body.seq, done.body.seq, 'the stored seq')
  t.is(ctx.writer.info(K).length, length + 1, 'exactly one post')
})

test('account pages: status answers the newest 4096 engagement refs and says when it cut', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'curtidas')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const ref = (i) => 'ab'.repeat(32) + ':' + i
  const liked = new Set()
  const reposted = new Map()
  for (let i = 1; i <= 5000; i++) {
    liked.add(ref(i))
    reposted.set(ref(i), { seq: i, at: '2026-01-01T00:00:00.000Z' })
  }
  ctx.engagement = { liked, reposted }
  const cut = await s.act(ana, 'status', K, {})
  t.is(cut.status, 200, JSON.stringify(cut.body).slice(0, 200))
  t.is(cut.body.engagement.liked.length, 4096)
  t.is(cut.body.engagement.reposted.length, 4096)
  t.is(cut.body.engagement.liked[4095], ref(5000), 'the newest kept')
  t.is(cut.body.engagement.liked[0], ref(5000 - 4095))
  t.is(cut.body.engagement.truncated, true)
  t.ok(Buffer.byteLength(JSON.stringify(cut.body)) < 1024 * 1024, 'inside the app read cap')

  ctx.engagement = { liked: new Set([ref(1)]), reposted: new Map() }
  const small = await s.act(ana, 'status', K, {})
  t.alike(small.body.engagement, { liked: [ref(1)], reposted: [], truncated: false })
})

test('account pages: rename refuses a paused diary first and pauses the page when the record is not appended', async (t) => {
  t.timeout(300000)
  let shift = 0
  const s = await setup(t, { storeNow: () => Date.now() + shift })
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'antigo')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  shift = 8 * DAY

  ctx.pausedInfo = true
  const paused = await s.act(ana, 'rename', K, { username: 'recente' })
  ctx.pausedInfo = false
  t.is(paused.body.error, 'pausada')
  t.is((await api('GET', '/account/username/recente')).status, 404, 'the directory did not change')
  t.is((await api('GET', '/account/username/antigo')).body.member, K)

  ctx.failAppend = 'before'
  const lost = await s.act(ana, 'rename', K, { username: 'recente' })
  t.is(lost.status, 202, JSON.stringify(lost.body))
  t.alike(lost.body, { uncertain: true })
  t.is((await api('GET', '/account/username/recente')).body.member, K, 'the directory change is committed')
  t.is(ctx.pagesStore.get(K).paused, true, 'the page is paused for an operator')
  t.is((await s.act(ana, 'post', K, { text: 'x' })).body.error, 'pausada')
})

test('account pages: 300 anonymous create and move starts do not stop a linked member start and create', async (t) => {
  t.timeout(300000)
  // The host token bucket (burst 100) is not what is under test here.
  const s = await setup(t, { serverOpts: { burst: 1000, ratePerSecond: 1000 } })
  const { api } = s
  let ok = 0
  for (let i = 0; i < 300; i++) {
    const r = await api('POST', '/account/pages/start', { member: member().hex, action: i % 2 ? 'move' : 'create' })
    if (r.status === 200) ok++
  }
  t.is(ok, 300, 'every anonymous start answers')
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'depois')
  t.is(made.status, 200, JSON.stringify(made.body))
})

test('account pages: a post, reply or quote takes up to 10 photos, a listing 4, and deleting 10 splits the tombstone', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'dezfotos')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page

  // Eleven distinct photos, all in the page's item table.
  const ds = []
  for (let i = 0; i < 11; i++) {
    const img = jpeg(64, 48, 2048 + i)
    const up = await s.upload(ana, K, img, { sha256: sha(img), mime: 'image/jpeg', width: 64, height: 48, bytes: img.length })
    t.is(up.status, 200, JSON.stringify(up.body))
    ds.push(up.body.descriptor)
  }
  const ten = ds.slice(0, 10)

  t.is((await s.act(ana, 'post', K, { text: 'onze', media: ds })).body.error, 'midia-invalida', 'a post with 11 photos')
  const post = await s.act(ana, 'post', K, { text: 'dez', media: ten })
  t.is(post.status, 200, JSON.stringify(post.body))
  const to = K + ':' + post.body.seq
  t.is((await s.act(ana, 'reply', K, { to, text: 'onze', media: ds })).body.error, 'midia-invalida', 'a reply with 11 photos')
  t.is((await s.act(ana, 'reply', K, { to, text: 'dez', media: ten })).status, 200, 'a reply with 10 photos')
  t.is((await s.act(ana, 'quote', K, { to, text: 'onze', media: ds })).body.error, 'midia-invalida', 'a quote with 11 photos')
  t.is((await s.act(ana, 'quote', K, { to, text: 'dez', media: ten })).status, 200, 'a quote with 10 photos')

  const listing = { kind: 'servico', title: 'Conserto de bicicleta', text: 'Na garagem', price: 5000, unit: 'hora', cat: 'reparos', place: { uf: 'SP', city: 'São Paulo', bairro: null } }
  t.is((await s.act(ana, 'listing', K, { ...listing, media: ds.slice(0, 5) })).body.error, 'midia-invalida', 'a listing with 5 photos')
  t.is((await s.act(ana, 'listing', K, { ...listing, media: ds.slice(0, 4) })).status, 200, 'a listing with 4 photos')

  // The tombstones of one post: three, at most 4 ranges each.
  const before = ctx.writer.info(K).length
  const del = await s.act(ana, 'delete', K, { to })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.is(ctx.writer.info(K).length, before + 3, 'three tombstones')
  const tail = (await ctx.writer.readEntries(K)).slice(before).map((e) => e.record)
  t.alike(tail.map((r) => [r.type, r.seq, r.media.length]), [['delete', post.body.seq, 4], ['delete', post.body.seq, 4], ['delete', post.body.seq, 2]])
  t.is(new Set(tail.map((r) => r.at)).size, 1, 'one at')
  t.alike(tail.flatMap((r) => r.media), ten.map((d) => ({ core: d.core, start: d.start, blocks: d.blocks })), 'every range once')
})
