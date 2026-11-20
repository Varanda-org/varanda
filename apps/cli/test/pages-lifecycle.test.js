'use strict'

// Close, move and the successor statement of apps/cli/lib/account/
// pages-routes.js end to end, loopback only: the account service with pages
// on, the pages writer linked to a real seeder over seed-ws on a local DHT,
// and a third member that reads the page diaries from the seeder. The setup
// follows account-pages.test.js.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { signRoster, signAccept, signClose, signMoved, signOrigin, pageState } = require('@varanda/core/lib/page')
const { pageLifecycle, verifyMoved } = require('@varanda/core/lib/page-lifecycle')
const { postRecord, profileRecords, deleteRecords, latestProfile } = require('@varanda/core/lib/records')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION, signTerms } = require('@varanda/core/lib/terms')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createAccountServer } = require('../lib/account/server')

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

function sha (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
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

function profilesOf (entries) {
  return entries.filter((e) => e.record && e.record.type === 'profile')
}

let subSeq = 100
async function linkDirect (store, ctx, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '50000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
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
    },
    // A closed page's cleared blocks are skipped; its last block must be there.
    // Every block is asked at once on one session. Read one by one, each
    // cleared block cost the whole timeout, and in hypercore 11.39.0 a
    // timed-out get leaves a stale queue entry that can keep the next get
    // from ever being requested (fixed upstream in 11.40.0, holepunchto/
    // hypercore#896), so held blocks timed out too and a pass could eat the
    // caller's deadline.
    async sparse (key, length) {
      if (await read(key, length - 1) === null) return null
      const core = store.get({ key: b4a.from(key, 'hex'), valueEncoding: 'json' })
      await core.ready()
      try {
        const records = await Promise.all(Array.from({ length }, (_, seq) => core.get(seq, { timeout: 3000 }).catch(() => null)))
        return records.flatMap((record, seq) => record === null ? [] : [{ seq, record }])
      } finally {
        await core.close().catch(() => {})
      }
    }
  }
}

async function setup (t, { pagesDelegate = null, pagesGroups = null, pagesNotices = null } = {}) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const ctx = { association, issuerKp, issuerCert, bootstrap, blocked: new Set() }
  const dir = tmpDir(t, 'varanda-account-')
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const logs = []
  const opts = {
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log: (e) => logs.push(e)
  }
  const seeder = new Seeder({ dataDir: prepareSeederDir(t, assocKp), ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  ctx.keys = keys
  ctx.dir = dir

  let listener = null
  let base = null
  async function boot () {
    const writer = createPagesWriter({ dir, keys, association, seederWs: 'http://127.0.0.1:' + ws.port, log: () => {} })
    t.teardown(() => writer.close(), { force: true })
    await writer.ready()
    await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
    ctx.writer = writer
    ctx.pagesStore = openPagesStore(dir)
    opts.pages = { keys, writer, pagesStore: ctx.pagesStore, dir, blocklist: { has: (k) => ctx.blocked.has(k) }, pagesDelegate, pagesGroups, pagesNotices }
    const l = await createAccountServer(opts).listen({ host: '127.0.0.1', port: 0 })
    t.teardown(() => l.close(), { force: true })
    listener = l
    base = 'http://127.0.0.1:' + l.port
  }
  await boot()

  // Everything stops, `between` runs against the data dir, then a new
  // writer, ACL and routes start over it.
  async function restart (between) {
    await listener.close()
    await ctx.writer.close()
    await between()
    await boot()
  }

  async function api (method, pathname, body) {
    const init = { method, headers: {} }
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }

  let termsCount = 0
  async function newMember (username) {
    const m = member()
    if (username) await linkDirect(store, ctx, m, username)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'L'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
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

  async function act (m, action, page, op) {
    const { nonce } = await start(m, action)
    return api('POST', '/account/pages/' + action, { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) })
  }

  function roster (m, page, fields, nonce, at = new Date().toISOString()) {
    const f = { page, ...fields, at, nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  async function create (m, username) {
    const { nonce, page } = await start(m, 'create')
    const record = roster(m, page, { gen: 1, owner: m.hex, admins: [], prev: null }, nonce)
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('POST', '/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    if (r.status !== 200) throw new Error('create ' + r.status + ' ' + JSON.stringify(r.body))
    return page
  }

  function invite (owner, page, who) {
    return start(owner, 'invite').then(({ nonce }) => {
      const row = ctx.pagesStore.get(page)
      const admins = [...row.admins, who.hex].sort()
      const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins, prev: row.rosterSeq }, nonce)
      const op = { member: who.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: owner.hex, admins, prev: row.rosterSeq, at: record.at, nonce } }
      return api('POST', '/account/pages/invite', { member: owner.hex, nonce, page, op, signature: sign(owner, 'invite', nonce, page, op), record })
    })
  }

  async function addAdmin (owner, page, who) {
    const inv = await invite(owner, page, who)
    if (inv.status !== 200) throw new Error('invite ' + JSON.stringify(inv.body))
    const { nonce } = await start(who, 'accept')
    const f = { page, gen: ctx.pagesStore.get(page).gen + 1, rosterSignature: ctx.pagesStore.get(page).invites[who.hex].rosterSignature, at: new Date().toISOString(), nonce, actor: who.hex }
    const r = await api('POST', '/account/pages/accept', { member: who.hex, nonce, page, record: { type: 'page-accept', ...f, signature: signAccept(f, who.kp) } })
    if (r.status !== 200) throw new Error('accept ' + JSON.stringify(r.body))
  }

  // The owner's page.sign 'close' (packages/core/lib/member.js).
  async function close (m, page, { gen = ctx.pagesStore.get(page).gen + 1 } = {}) {
    const { nonce } = await start(m, 'close')
    const f = { page, gen, at: new Date().toISOString(), nonce, actor: m.hex, association }
    return api('POST', '/account/pages/close', { member: m.hex, nonce, page, record: { type: 'page-close', ...f, signature: signClose(f, m.kp) } })
  }

  // The three records of page.sign 'move', each signed by `m`.
  async function move (m, page) {
    const started = await start(m, 'move')
    const { nonce, to } = started
    const row = ctx.pagesStore.get(page)
    const admins = row.admins.filter((a) => a !== m.hex)
    const at = new Date().toISOString()
    const mv = { page, to, gen: row.gen, at, nonce, actor: m.hex, association }
    const og = { page: to, from: page, fromSeq: row.length, gen: row.gen, owner: m.hex, admins, at, nonce, actor: m.hex, association }
    const body = {
      member: m.hex,
      nonce,
      page,
      record: { type: 'page-moved', ...mv, signature: signMoved(mv, m.kp) },
      origin: { type: 'page-origin', ...og, signature: signOrigin(og, m.kp) },
      roster: roster(m, to, { gen: 1, owner: m.hex, admins, prev: null }, nonce, at)
    }
    const r = await api('POST', '/account/pages/move', body)
    return { ...r, to, started, sent: body }
  }

  // The `avatar` action: the raw bytes as the body, the statement in headers.
  async function avatar (m, page, bytes, op) {
    const { nonce } = await start(m, 'avatar')
    const res = await fetch(base + '/account/pages/avatar', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/octet-stream',
        'x-varanda-page-member': m.hex,
        'x-varanda-page-nonce': nonce,
        'x-varanda-page-page': page,
        'x-varanda-page-signature': sign(m, 'avatar', nonce, page, op),
        'x-varanda-page-op': JSON.stringify(op)
      },
      body: bytes
    })
    return { status: res.status, body: await res.json() }
  }

  // The owner's signed roster without `who`.
  async function removeAdmin (owner, page, who) {
    const { nonce } = await start(owner, 'remove')
    const row = ctx.pagesStore.get(page)
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins: row.admins.filter((a) => a !== who.hex), prev: row.rosterSeq }, nonce)
    return api('POST', '/account/pages/remove', { member: owner.hex, nonce, page, record })
  }

  return { ctx, store, api, logs, newMember, start, sign, act, create, addAdmin, removeAdmin, invite, close, move, avatar, restart }
}

test('pages lifecycle: close, move, successor and delegate recipients', async (t) => {
  t.timeout(400000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const eva = await s.newMember('eva')
  const reader = await thirdMember(t, ctx.bootstrap, ctx.association)

  // ---- close ----
  const P = await s.create(ana, 'padoca')
  await s.addAdmin(ana, P, bia)
  t.is((await s.act(ana, 'post', P, { text: 'pão' })).status, 200)
  t.is((await s.act(ana, 'follow', P, { key: caio.hex, on: true })).status, 200)
  const before = ctx.writer.info(P).length

  const byAdmin = await s.close(bia, P)
  t.is(byAdmin.body.error, 'sem-permissao', 'an admin cannot close the page')
  t.is(ctx.writer.info(P).length, before, 'a refused close appends nothing')
  t.is((await s.close(ana, P, { gen: ctx.pagesStore.get(P).gen })).body.error, 'expirado', 'gen must be the current plus 1')

  const closed = await s.close(ana, P)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  t.is(closed.body.seq, closed.body.length - 1)
  const offOf = (es) => es.some((e) => e.record.type === 'follow' && e.record.key === caio.hex && e.record.on === false)
  const tombOf = (es) => es.some((e) => e.record.type === 'delete')
  // A block the reader has not replicated yet reads as missing: read again.
  const pEntries = await until(async () => {
    const es = await reader.sparse(P, closed.body.length)
    return es !== null && offOf(es) && tombOf(es) ? es : null
  }, { name: 'closed page served', timeoutMs: 60000 })
  const life = pageLifecycle(pEntries, P, ctx.association)
  t.is(life.closed && life.closed.seq, closed.body.seq, 'pageLifecycle reports the close')
  t.ok(offOf(pEntries), 'the follow is turned off')
  t.ok(tombOf(pEntries), 'posts are tombstoned')
  const lookup = await api('GET', '/account/username/padoca')
  t.is(lookup.body.member, P)
  t.ok(lookup.body.closed, 'the directory reports the page closed')
  t.is((await s.act(ana, 'post', P, { text: 'depois' })).body.error, 'encerrada', 'a later post is refused')
  await t.exception(s.newMember('padoca'), /nome-em-uso/, 'a person still cannot take the name')
  t.is(ctx.keys.get(P), null, 'the page secrets are gone')
  t.ok(s.logs.every((e) => !JSON.stringify(e).includes(P) && !JSON.stringify(e).includes('padoca')), 'logs carry no key or name')

  // ---- move ----
  const M = await s.create(caio, 'mercado')
  await s.addAdmin(caio, M, bia)
  t.is((await s.act(caio, 'post', M, { text: 'aberto' })).status, 200)
  const mBefore = ctx.writer.info(M).length
  const adminMove = await s.move(bia, M)
  t.is(adminMove.body.error, 'sem-permissao', 'an admin cannot move the page')
  t.is(ctx.writer.info(M).length, mBefore, 'a refused move appends nothing')

  const moved = await s.move(caio, M)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const K2 = moved.to
  t.is(moved.started.page, undefined, 'start answers the new key as `to`')
  t.is(moved.body.page, K2)
  t.ok(Number.isSafeInteger(moved.body.seq) && moved.body.seq > 0)
  const k2Entries = await until(() => reader.entries(K2, 4), { name: 'K2 served', timeoutMs: 30000 })
  t.is(k2Entries[1].record.username, 'mercado', 'K2 carries the same @nome')
  t.is(k2Entries[3].record.type, 'page-origin')
  const st = pageState(k2Entries, K2, ctx.association)
  t.is(st.owner, caio.hex)
  t.alike(st.admins, [bia.hex], 'pageState on K2 shows the admins')
  t.is(k2Entries.filter((e) => e.record && e.record.type === 'follow').length, 0, 'nothing is followed for anyone on K2')
  const k1Entries = await until(() => reader.entries(M, moved.body.seq + 1), { name: 'K1 moved served', timeoutMs: 30000 })
  t.is(pageLifecycle(k1Entries, M, ctx.association).movedTo.to, K2, 'K1 reports movedTo K2')
  const late = await s.act(caio, 'post', M, { text: 'tarde' })
  t.is(late.status, 409)
  t.is(late.body.error, 'movida', 'an append to K1 is refused')
  t.is((await api('GET', '/account/username/mercado')).body.member, K2, 'the @nome answers K2')
  t.is((await s.act(caio, 'post', K2, { text: 'nova casa' })).status, 200, 'K2 takes posts')
  const succ = await api('GET', '/account/pages/successor/' + M)
  t.is(succ.status, 200)
  t.is(succ.headers.get('cache-control'), 'no-store')
  t.ok(verifyMoved(succ.body.moved, M, ctx.association, { owner: caio.hex }).ok, 'the successor verifies')
  t.is(succ.body.moved.to, K2)
  const none = await api('GET', '/account/pages/successor/' + K2)
  t.is(none.status, 404, 'a page that did not move has no successor')
  t.is(none.headers.get('cache-control'), 'no-store')
  t.exception(() => ctx.writer.info(caio.hex), /nao-encontrada/, 'no diary of a person is written')

  // ---- a paused K1 ----
  const Q = await s.create(eva, 'quitanda')
  await s.restart(async () => {
    const row = ctx.keys.get(Q)
    const core = new Hypercore(path.join(ctx.dir, 'pages-store', Q), { keyPair: { publicKey: b4a.from(Q, 'hex'), secretKey: row.secretKey }, compat: true, valueEncoding: 'json' })
    await core.ready()
    await core.append(postRecord({ text: 'de fora' }))
    await core.close()
  })
  t.is(ctx.writer.info(Q).paused, true, 'an outside append pauses K1')
  const qLength = ctx.writer.info(Q).length
  const qMoved = await s.move(eva, Q)
  t.is(qMoved.status, 200, JSON.stringify(qMoved.body))
  t.is(qMoved.body.paused, true)
  t.is(ctx.writer.info(Q).length, qLength, 'a paused K1 gets no block')
  const detached = ctx.pagesStore.statement(Q)
  t.is(detached.to, qMoved.to, 'the detached statement is stored')
  const qSucc = await api('GET', '/account/pages/successor/' + Q)
  t.ok(verifyMoved(qSucc.body.moved, Q, ctx.association, { owner: eva.hex }).ok, 'the detached statement verifies')
  t.is((await api('GET', '/account/username/quitanda')).body.member, qMoved.to)

  // ---- rate: 2 closes or moves per owner per day (kept in pages.json) ----
  const rita = await s.newMember('rita')
  for (const name of ['roda', 'rodinha']) t.is((await s.close(rita, await s.create(rita, name))).status, 200)
  const R3 = await s.create(rita, 'rodona')
  t.is((await s.close(rita, R3)).body.error, 'limite', 'a third close in a day is refused')

  // ---- invite by key to a core node's delegate ----
  const D = await s.create(bia, 'doceria')
  const actor = member()
  t.is((await s.invite(bia, D, actor)).body.error, 'nao-vinculado', 'an unknown key is not a recipient')
  await ctx.pagesStore.setDelegate(actor.hex, { diary: 'ab'.repeat(32), length: 3, termsVersion: TERMS_VERSION })
  const inv = await s.invite(bia, D, actor)
  t.is(inv.status, 200, JSON.stringify(inv.body))
  t.is(inv.body.invited, true, 'a delegate with the current terms is a recipient')
  const other = member()
  await ctx.pagesStore.setDelegate(other.hex, { diary: 'ef'.repeat(32), length: 3, termsVersion: TERMS_VERSION - 1 })
  t.is((await s.invite(bia, D, other)).body.error, 'nao-vinculado', 'a delegate on older terms is not')
})

test('pages lifecycle: an admin removed from K2 after a move gets nothing of K1', async (t) => {
  t.timeout(300000)
  const pagesNotices = { read: async () => ({ notices: [], next: null, incomplete: false, activity: [] }) }
  const s = await setup(t, { pagesNotices })
  const ana = await s.newMember('ana')
  const bia = await s.newMember('bia')
  const caio = await s.newMember('caio')
  const K1 = await s.create(ana, 'padaria')
  await s.addAdmin(ana, K1, bia)
  await s.addAdmin(ana, K1, caio)
  const moved = await s.move(ana, K1)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const K2 = moved.to
  t.is((await s.act(bia, 'status', K1, {})).body.movedTo, K2, 'before the remove, K1 answers its admin')
  const rem = await s.removeAdmin(ana, K2, bia)
  t.is(rem.status, 200, JSON.stringify(rem.body))

  const listed = (r) => [...r.body.owned, ...r.body.admin].map((p) => p.page)
  const ofBia = await s.act(bia, 'list', '', {})
  t.is(ofBia.status, 200, JSON.stringify(ofBia.body))
  t.alike(listed(ofBia), [], 'the removed admin is listed neither K1 nor K2')
  for (const action of ['status', 'follows']) {
    const r = await s.act(bia, action, K1, {})
    t.is(r.body.error, 'sem-permissao', action + ' of K1 refuses the removed admin')
  }
  t.is((await s.act(bia, 'notices', K1, {})).body.error, 'movida', 'notices of K1 answer movida')
  t.is((await s.act(bia, 'notices', K2, {})).body.error, 'sem-permissao', 'notices of K2 refuse the removed admin')
  const ofCaio = await s.act(caio, 'list', '', {})
  t.is(ofCaio.body.admin.find((p) => p.page === K1).movedTo, K2, 'a remaining admin still sees K1 as moved')
  t.is((await s.act(caio, 'status', K1, {})).body.movedTo, K2, 'and reads its status')
  t.is((await s.act(caio, 'follows', K1, {})).status, 200)
  t.is((await s.act(ana, 'status', K1, {})).body.movedTo, K2, 'the owner reads K1')
  t.is((await s.act(ana, 'list', '', {})).body.owned.find((p) => p.page === K1).movedTo, K2)
})

test('pages lifecycle: a move that failed after the writer step finishes on its resend, and the lifecycle cap charges a use once', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const M = await s.create(ana, 'mercado')

  const realMove = ctx.pagesStore.move
  ctx.pagesStore.move = async () => { throw new Error('falha injetada') }
  const first = await s.move(ana, M)
  ctx.pagesStore.move = realMove
  t.is(first.status, 202, JSON.stringify(first.body))
  t.is(first.body.uncertain, true, 'a failed ACL step after the writer moved is uncertain')
  t.is(ctx.writer.info(M).movedTo, first.to, 'the writer has moved K1')
  t.is(ctx.pagesStore.get(M).paused, true, 'K1 is paused in the ACL')
  t.ok(s.logs.some((e) => e.action === 'move' && e.reason === 'pausada-incerta'))

  const again = await api('POST', '/account/pages/move', first.sent)
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.page, first.to, 'the same-nonce resend finishes the move')
  t.is(ctx.pagesStore.get(M).movedTo, first.to, 'the ACL points K1 at K2')
  t.ok(ctx.pagesStore.get(first.to) !== null, 'K2 has its ACL row')
  t.is((await api('GET', '/account/username/mercado')).body.member, first.to, 'the @nome answers K2')
  t.is((await s.act(ana, 'post', first.to, { text: 'nova casa' })).status, 200, 'K2 takes posts')
  const replay = await api('POST', '/account/pages/move', first.sent)
  t.is(replay.body.page, first.to, 'a later resend answers the stored move')

  // The move and its two resends are one use; a definite writer refusal
  // gives its use back.
  const P1 = await s.create(ana, 'padoca')
  const P2 = await s.create(ana, 'pastel')
  const realClose = ctx.writer.closePage
  ctx.writer.closePage = async () => { throw Object.assign(new Error('recusa'), { code: 'invalido' }) }
  t.is((await s.close(ana, P1)).body.error, 'pedido-invalido', 'the writer refuses the close')
  ctx.writer.closePage = realClose
  const closed = await s.close(ana, P1)
  t.is(closed.status, 200, 'the second use of the day: ' + JSON.stringify(closed.body))
  t.is((await s.close(ana, P2)).body.error, 'limite', 'a third use in a day is refused')
  t.ok(s.logs.every((e) => !JSON.stringify(e).includes(M) && !JSON.stringify(e).includes('mercado')), 'logs carry no key or name')
})

test('pages lifecycle: a linked member\'s diary never takes a delegate', async (t) => {
  t.timeout(120000)
  const pagesDelegate = { verify: async () => ({ ok: true, length: 3 }) }
  const s = await setup(t, { pagesDelegate })
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  async function terms (actor, diary) {
    const { nonce } = await s.start(actor, 'terms')
    const op = { version: TERMS_VERSION, diary }
    const termsSignature = signTerms({ nonce, member: actor.hex, association: ctx.association, version: TERMS_VERSION }, actor.kp)
    const signature = signPage({ action: 'terms', nonce, member: actor.hex, page: '', association: ctx.association, opHash: opHash(op) }, actor.kp)
    return api('POST', '/account/pages/terms', { member: actor.hex, nonce, page: '', op, signature, termsSignature })
  }
  const actor = member()
  const linked = await terms(actor, ana.hex)
  t.is(linked.body.error, 'pedido-invalido', 'a hosted member cannot register a delegate for its own diary')
  t.is(ctx.pagesStore.delegate(actor.hex), null, 'no delegate row')
  const core = await terms(member(), 'ab'.repeat(32))
  t.is(core.status, 200, 'a core diary still can: ' + JSON.stringify(core.body))
})

test('pages lifecycle: an uncertain move with nothing written finishes on its resend; the successor is read once; a read nonce from before a restart is refused', async (t) => {
  t.timeout(300000)
  const pagesNotices = { read: async () => ({ notices: [], next: null, incomplete: false, activity: [] }) }
  const s = await setup(t, { pagesNotices })
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const M = await s.create(ana, 'feira')

  // One app load follows `next` up to 4 times: five reads in a row answer.
  for (let i = 0; i < 5; i++) t.is((await s.act(ana, 'notices', M, {})).status, 200, 'notices read ' + (i + 1))

  // The writer step fails before anything is written: uncertain. The
  // same-nonce resend derives the same K2 and completes the move.
  const realMove = ctx.writer.movePage
  ctx.writer.movePage = async () => { throw new Error('perdida') }
  const first = await s.move(ana, M)
  ctx.writer.movePage = realMove
  t.is(first.status, 202, JSON.stringify(first.body))
  t.is(ctx.writer.info(M).movedTo, null, 'nothing moved yet')
  const again = await api('POST', '/account/pages/move', first.sent)
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.page, first.to, 'the resend completes the move to the same K2')
  t.is(ctx.pagesStore.get(M).movedTo, first.to)
  const movedNotices = await s.act(ana, 'notices', M, {})
  t.is(movedNotices.body.error, 'movida', 'notices on a moved K1 answer movida')

  // The verified page-moved is kept: a second request reads no diary.
  const realRead = ctx.writer.readEntries
  let reads = 0
  ctx.writer.readEntries = async (...args) => {
    reads++
    return realRead(...args)
  }
  t.is((await api('GET', '/account/pages/successor/' + M)).status, 200)
  const readsAfterFirst = reads
  const second = await api('GET', '/account/pages/successor/' + M)
  ctx.writer.readEntries = realRead
  t.is(second.status, 200)
  t.is(second.body.moved.to, first.to)
  t.is(reads, readsAfterFirst, 'the second request does not read the diary')

  // A signed read minted before a restart is refused after it; a fresh one
  // answers.
  const { nonce } = await s.start(ana, 'list')
  const body = { member: ana.hex, nonce, page: '', op: {}, signature: s.sign(ana, 'list', nonce, '', {}) }
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await s.restart(async () => {})
  const replayed = await api('POST', '/account/pages/list', body)
  t.is(replayed.body && replayed.body.error, 'expirado', 'a read nonce from before the restart is refused')
  t.is((await s.act(ana, 'list', '', {})).status, 200, 'a fresh read answers')
})

test('pages lifecycle: a close whose group leaves failed is refused before any terminal record, and the use is given back', async (t) => {
  t.timeout(300000)
  let failures = 1
  const pagesGroups = { leaveAll: async () => ({ left: 0, failures, communities: [] }) }
  const s = await setup(t, { pagesGroups })
  const { ctx } = s
  const ana = await s.newMember('ana')
  const P1 = await s.create(ana, 'quitanda')
  const P2 = await s.create(ana, 'armazem')
  const length = ctx.writer.info(P1).length
  const refused = await s.close(ana, P1)
  t.is(refused.body.error, 'indisponivel', 'a group not left refuses the close')
  t.is(ctx.pagesStore.get(P1).closed, null, 'P1 stays live')
  t.is(ctx.writer.info(P1).length, length, 'no terminal record')
  failures = 0
  t.is((await s.close(ana, P1)).status, 200, 'the close runs once the leaves succeed')
  t.is((await s.close(ana, P2)).status, 200, 'the refused attempt did not use the day cap')
})

test('pages lifecycle: the 2 per 24 h cap survives a restart, and a charged use resent after it is not charged twice', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const [P1, P2, P3] = [await s.create(ana, 'pastelaria'), await s.create(ana, 'barbearia'), await s.create(ana, 'mercearia')]
  t.is((await s.close(ana, P1)).status, 200)
  // An uncertain close keeps its charge.
  const realClose = ctx.writer.closePage
  ctx.writer.closePage = async () => { throw new Error('falha injetada') }
  const { nonce } = await s.start(ana, 'close')
  const f = { page: P2, gen: ctx.pagesStore.get(P2).gen + 1, at: new Date().toISOString(), nonce, actor: ana.hex, association: ctx.association }
  const body = { member: ana.hex, nonce, page: P2, record: { type: 'page-close', ...f, signature: signClose(f, ana.kp) } }
  const first = await api('POST', '/account/pages/close', body)
  ctx.writer.closePage = realClose
  t.is(first.body.uncertain, true, 'the close is uncertain: ' + JSON.stringify(first.body))

  await s.restart(async () => {})
  t.is((await s.close(ana, P3)).body.error, 'limite', 'a third use after the restart is refused')
  // The nonce binds the member and the action, not the page: reusing the
  // uncertain close's nonce on another page is a new use.
  const { nonce: n3 } = await s.start(ana, 'close')
  const crafted = { page: P3, gen: ctx.pagesStore.get(P3).gen + 1, at: new Date().toISOString(), nonce: n3, actor: ana.hex, association: ctx.association }
  const first3 = await api('POST', '/account/pages/close', { member: ana.hex, nonce: n3, page: P3, record: { type: 'page-close', ...crafted, signature: signClose(crafted, ana.kp) } })
  t.is(first3.body.error, 'limite', 'a fresh nonce on a third page is refused')
  const reuse = { ...f, page: P3, gen: ctx.pagesStore.get(P3).gen + 1 }
  const swapped = await api('POST', '/account/pages/close', { member: ana.hex, nonce, page: P3, record: { type: 'page-close', ...reuse, signature: signClose(reuse, ana.kp) } })
  t.is(swapped.body.error, 'limite', "an uncertain close's nonce on another page is a new use")
  await s.restart(async () => {})
  const again = await api('POST', '/account/pages/close', body)
  t.is(again.status, 200, 'the resend of the charged use is not charged again: ' + JSON.stringify(again.body))
})

test('pages lifecycle: a move is charged to the cap that survives a restart', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const [M, P, Q] = [await s.create(ana, 'mercado'), await s.create(ana, 'padaria'), await s.create(ana, 'quitanda')]
  const moved = await s.move(ana, M)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  t.is((await s.close(ana, P)).status, 200)
  await s.restart(async () => {})
  t.is((await s.move(ana, Q)).body.error, 'limite', 'a third use after the restart is refused')
})

test('pages lifecycle: a move carries the page profile (name, bio and photo) to K2', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const reader = await thirdMember(t, ctx.bootstrap, ctx.association)
  const M = await s.create(ana, 'padaria')
  // Three media blocks, so the copy joins more than one.
  const photo = jpeg(512, 512, 70000)
  const op = { sha256: sha(photo), mime: 'image/jpeg', bytes: photo.length, name: 'Padaria do Lab', bio: 'Pão quente às 7h' }
  const up = await s.avatar(ana, M, photo, op)
  t.is(up.status, 200, JSON.stringify(up.body))

  const moved = await s.move(ana, M)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const K2 = moved.to
  const entries = await ctx.writer.readEntries(K2)
  const profile = latestProfile(entries)
  t.ok(profile !== null, 'K2 carries a profile')
  t.is(profile && profile.name, 'Padaria do Lab', 'the same name')
  t.is(profile && profile.bio, 'Pão quente às 7h', 'the same bio')
  const avatar = profile && profile.avatar
  t.ok(avatar && avatar.core !== up.body.descriptor.core, "the photo is stored in K2's own media core")
  t.is(avatar && avatar.sha256, op.sha256)
  t.is(avatar && sha(await ctx.writer.itemBytes(K2, avatar)), op.sha256, 'the copied bytes hash to the photo K1 shows')
  const copies = profilesOf(entries)
  t.is(copies.length, 2, 'one copy: the plain profile, then the same with the photo')
  t.ok(copies.every((e) => e.seq >= 4), 'after the genesis')
  t.is(moved.body.length, ctx.writer.info(K2).length, 'the answer counts the copy')
  t.is(ctx.pagesStore.get(K2).length, moved.body.length, "the ACL expects K2's length")
  t.is(ctx.pagesStore.get(K2).media.items, 1, 'the ACL counts the copied photo')
  const served = await until(() => reader.entries(K2, moved.body.length), { name: 'K2 served', timeoutMs: 30000 })
  t.is((latestProfile(served) || {}).name, 'Padaria do Lab', 'a reader sees the name on K2')
  t.ok(s.logs.every((e) => !JSON.stringify(e).includes(M) && !JSON.stringify(e).includes(K2) && !JSON.stringify(e).includes('Padaria')), 'logs carry no key or name')
})

test('pages lifecycle: a deleted profile carries nothing, and a failed copy or photo leaves the move standing', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')

  // Every profile version tombstoned: readers show none, so K2 gets none.
  const P = await s.create(ana, 'padaria')
  const own = profilesOf(await ctx.writer.readEntries(P))
  t.is(own.length, 1)
  const del = await ctx.writer.append(P, deleteRecords({ seq: own[0].seq }))
  await ctx.pagesStore.expectLength(P, del.length)
  t.is(latestProfile(await ctx.writer.readEntries(P)), null, 'K1 shows no profile')
  const moved = await s.move(ana, P)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  t.is(profilesOf(await ctx.writer.readEntries(moved.to)).length, 0, 'K2 gets no profile')
  t.is(moved.body.length, ctx.writer.info(moved.to).length)

  // The profile append fails after the photo was stored on K2.
  const Q = await s.create(ana, 'quitanda')
  const photo = jpeg(512, 512, 5000)
  const up = await s.avatar(ana, Q, photo, { sha256: sha(photo), mime: 'image/jpeg', bytes: photo.length, name: 'Quitanda', bio: '' })
  t.is(up.status, 200, JSON.stringify(up.body))
  const realAppend = ctx.writer.append
  ctx.writer.append = async (key, records, opts) => {
    if (records.some((r) => r.type === 'profile')) throw new Error('falha injetada')
    return realAppend(key, records, opts)
  }
  const failed = await s.move(ana, Q)
  ctx.writer.append = realAppend
  t.is(failed.status, 200, 'the move stands: ' + JSON.stringify(failed.body))
  const K2 = failed.to
  t.is(ctx.pagesStore.get(Q).movedTo, K2, 'the ACL points K1 at K2')
  t.is(profilesOf(await ctx.writer.readEntries(K2)).length, 0, 'no profile on K2')
  t.ok(s.logs.some((e) => e.action === 'move' && e.reason === 'perfil-pendente'), 'the failure is logged')
  t.is(failed.body.length, ctx.writer.info(K2).length, "the answer counts the stored photo's media-core record")
  t.is(ctx.pagesStore.get(K2).length, failed.body.length, "the ACL expects K2's length")
  t.is(ctx.pagesStore.get(K2).media.items, 1, 'the ACL counts the stored photo')
  t.is((await s.act(ana, 'profile', K2, { name: 'Quitanda', bio: '' })).status, 200, 'the owner sets the profile on K2 by hand')

  // The photo cannot be stored on K2: name and bio still arrive.
  const bia = await s.newMember('bia')
  const B = await s.create(bia, 'banca')
  const flower = jpeg(512, 512, 5000)
  const upB = await s.avatar(bia, B, flower, { sha256: sha(flower), mime: 'image/jpeg', bytes: flower.length, name: 'Banca da Bia', bio: 'Flores' })
  t.is(upB.status, 200, JSON.stringify(upB.body))
  const realAvatar = ctx.writer.avatarItem
  ctx.writer.avatarItem = async () => { throw new Error('falha injetada') }
  const mark = s.logs.length
  const noPhoto = await s.move(bia, B)
  ctx.writer.avatarItem = realAvatar
  t.is(noPhoto.status, 200, JSON.stringify(noPhoto.body))
  const kept = latestProfile(await ctx.writer.readEntries(noPhoto.to))
  t.is(kept && kept.name, 'Banca da Bia', 'the name arrives without the photo')
  t.is(kept && kept.bio, 'Flores', 'the bio arrives without the photo')
  t.is(kept && kept.avatar, null, 'no photo on K2')
  const since = s.logs.slice(mark)
  t.ok(since.some((e) => e.action === 'move' && e.reason === 'foto-pendente'), 'the photo failure is logged')
  t.absent(since.some((e) => e.action === 'move' && e.reason === 'perfil-pendente'), 'the profile itself did not fail')
  t.is(noPhoto.body.length, ctx.writer.info(noPhoto.to).length)
  t.is(ctx.pagesStore.get(noPhoto.to).length, noPhoto.body.length, "the ACL expects K2's length")
  t.is(ctx.pagesStore.get(noPhoto.to).media.items, 0, 'no media item on K2')
})

test('pages lifecycle: a resend after an uncertain move carries the profile once', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx, api } = s
  const ana = await s.newMember('ana')
  const realMove = ctx.pagesStore.move
  async function uncertain (page) {
    ctx.pagesStore.move = async () => { throw new Error('falha injetada') }
    const first = await s.move(ana, page)
    ctx.pagesStore.move = realMove
    return first
  }

  const M = await s.create(ana, 'mercado')
  const photo = jpeg(512, 512, 5000)
  const up = await s.avatar(ana, M, photo, { sha256: sha(photo), mime: 'image/jpeg', bytes: photo.length, name: 'Página mercado', bio: '' })
  t.is(up.status, 200, JSON.stringify(up.body))
  const first = await uncertain(M)
  t.is(first.status, 202, JSON.stringify(first.body))
  t.is(profilesOf(await ctx.writer.readEntries(first.to)).length, 0, 'nothing is copied before the move commits')
  // The resend reads K1's photo with K1's keys already gone.
  await until(() => ctx.keys.get(M) === null, { name: "K1's keys wiped", timeoutMs: 30000 })
  const again = await api('POST', '/account/pages/move', first.sent)
  t.is(again.status, 200, JSON.stringify(again.body))
  const copied = profilesOf(await ctx.writer.readEntries(first.to))
  t.is(copied.length, 2, 'the resend carries the profile: the plain one, then the same with the photo')
  t.is(copied.length > 0 && copied[0].record.name, 'Página mercado')
  const resent = latestProfile(await ctx.writer.readEntries(first.to))
  t.is(resent && resent.avatar && resent.avatar.sha256, sha(photo), "the resend carries K1's photo")
  t.is(resent && resent.avatar && sha(await ctx.writer.itemBytes(first.to, resent.avatar)), sha(photo), "stored in K2's own media core")
  t.is(again.body.length, ctx.writer.info(first.to).length)
  const replay = await api('POST', '/account/pages/move', first.sent)
  t.is(replay.body.page, first.to)
  t.is(profilesOf(await ctx.writer.readEntries(first.to)).length, 2, 'a later resend appends nothing')

  // K2 already holds a profile when the resend runs: none is added.
  const Q = await s.create(ana, 'quitanda')
  const second = await uncertain(Q)
  t.is(second.status, 202, JSON.stringify(second.body))
  await ctx.writer.append(second.to, profileRecords({ name: 'Já copiado' }))
  const resentQ = await api('POST', '/account/pages/move', second.sent)
  t.is(resentQ.status, 200, JSON.stringify(resentQ.body))
  const held = profilesOf(await ctx.writer.readEntries(second.to))
  t.is(held.length, 1, 'never a second copy')
  t.is(held.length > 0 && held[0].record.name, 'Já copiado')
})

test("pages lifecycle: a core delegate owner's K2 gets the page-link and the page's own profile", async (t) => {
  t.timeout(300000)
  const pagesDelegate = { verify: async () => ({ ok: true, length: 3 }) }
  const s = await setup(t, { pagesDelegate })
  const { ctx, api } = s
  const actor = member()
  const diary = 'ab'.repeat(32)
  const { nonce } = await s.start(actor, 'terms')
  const op = { version: TERMS_VERSION, diary }
  const termsSignature = signTerms({ nonce, member: actor.hex, association: ctx.association, version: TERMS_VERSION }, actor.kp)
  const signature = signPage({ action: 'terms', nonce, member: actor.hex, page: '', association: ctx.association, opHash: opHash(op) }, actor.kp)
  const accepted = await api('POST', '/account/pages/terms', { member: actor.hex, nonce, page: '', op, signature, termsSignature })
  t.is(accepted.status, 200, JSON.stringify(accepted.body))
  const P = await s.create(actor, 'doceria')
  const moved = await s.move(actor, P)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  const entries = await ctx.writer.readEntries(moved.to)
  const links = pageLifecycle(entries, moved.to, ctx.association).links
  t.alike(links.map((l) => [l.actor, l.diary]), [[actor.hex, diary]], "the link shows the delegate's diary for the owner")
  const copied = profilesOf(entries)
  t.is(copied.length, 1, 'the page keeps its own profile')
  t.ok(copied.length === 1 && links.length === 1 && copied[0].seq > links[0].seq, 'after the link')
  t.is((latestProfile(entries) || {}).name, 'Página doceria')
})

test('pages lifecycle: a paused K1 carries the profile the service wrote, whatever a leaked key appended', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const eva = await s.newMember('eva')
  const Q = await s.create(eva, 'quitanda')
  const photo = jpeg(512, 512, 5000)
  const up = await s.avatar(eva, Q, photo, { sha256: sha(photo), mime: 'image/jpeg', bytes: photo.length, name: 'Quitanda da Eva', bio: 'Frutas' })
  t.is(up.status, 200, JSON.stringify(up.body))
  const own = profilesOf(await ctx.writer.readEntries(Q)).slice(-2)
  t.is(own.length, 2)
  // The leaked key adds its own profile and deletes the two the avatar
  // action wrote.
  await s.restart(async () => {
    const row = ctx.keys.get(Q)
    const core = new Hypercore(path.join(ctx.dir, 'pages-store', Q), { keyPair: { publicKey: b4a.from(Q, 'hex'), secretKey: row.secretKey }, compat: true, valueEncoding: 'json' })
    await core.ready()
    for (const r of profileRecords({ name: 'Golpe', bio: 'de fora' })) await core.append(r)
    for (const e of own) for (const r of deleteRecords({ seq: e.seq })) await core.append(r)
    await core.close()
  })
  t.is(ctx.writer.info(Q).paused, true, 'an outside append pauses K1')
  t.is((latestProfile(await ctx.writer.readEntries(Q)) || {}).name, 'Golpe', 'a fold over the whole log shows the leaked profile')

  const moved = await s.move(eva, Q)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  t.is(moved.body.paused, true)
  const entries = await ctx.writer.readEntries(moved.to)
  const profile = latestProfile(entries)
  t.is(profile && profile.name, 'Quitanda da Eva', 'K2 carries the name the service wrote')
  t.is(profile && profile.bio, 'Frutas')
  t.is(profile && profile.avatar && profile.avatar.sha256, sha(photo), 'and its photo')
  t.absent(profilesOf(entries).some((e) => e.record.name === 'Golpe'), 'nothing the leaked key wrote reaches K2')
})

test("pages lifecycle: the copy reads only K1's own media items", async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const gil = await s.newMember('gil')
  // The same photo on two pages: the same blocks at the same place in two
  // media cores.
  const photo = jpeg(512, 512, 5000)
  const op = (name) => ({ sha256: sha(photo), mime: 'image/jpeg', bytes: photo.length, name, bio: 'Bio' })
  const P = await s.create(ana, 'padaria')
  const upP = await s.avatar(ana, P, photo, op('Padaria'))
  t.is(upP.status, 200, JSON.stringify(upP.body))
  const R = await s.create(gil, 'rotisseria')
  const upR = await s.avatar(gil, R, photo, op('Rotisseria'))
  t.is(upR.status, 200, JSON.stringify(upR.body))
  const dP = upP.body.descriptor
  t.is(upR.body.descriptor.start, dP.start)

  // A leaked media key appends a valid photo to P's media core, outside
  // P's item table.
  const outside = jpeg(512, 512, 3000)
  let foreign = null
  await s.restart(async () => {
    const msk = ctx.keys.get(P).mediaSecretKey
    const media = new Hypercore(path.join(ctx.dir, 'pages-store', P + '-media'), { keyPair: { publicKey: msk.subarray(32), secretKey: msk }, compat: true })
    await media.ready()
    foreign = { core: dP.core, mime: 'image/jpeg', start: media.length, blocks: 1, bytes: outside.length, sha256: sha(outside), width: 512, height: 512 }
    await media.append(outside)
    await media.close()
  })
  t.is(sha(await ctx.writer.itemBytes(P, dP)), sha(photo), "P's own item reads back")
  await t.exception(ctx.writer.itemBytes(P, foreign), /midia-invalida/, "an item outside P's table is refused")
  await t.exception(ctx.writer.itemBytes(R, dP), /midia-invalida/, "an item of another page's core is refused")

  // No validated write points a profile outside its page's table, so the
  // stub stands in for one: the move still carries name and bio.
  const realOwn = ctx.writer.readOwn
  async function moveWith (m, page, avatar) {
    ctx.writer.readOwn = async (key) => {
      const entries = await realOwn(key)
      if (key !== page) return entries
      return entries.map((e) => e.record && e.record.type === 'profile' && e.record.avatar ? { seq: e.seq, record: { ...e.record, avatar } } : e)
    }
    const mark = s.logs.length
    const moved = await s.move(m, page)
    ctx.writer.readOwn = realOwn
    t.is(moved.status, 200, JSON.stringify(moved.body))
    t.ok(s.logs.slice(mark).some((e) => e.action === 'move' && e.reason === 'foto-pendente'), 'the refused photo is logged')
    return latestProfile(await ctx.writer.readEntries(moved.to))
  }
  const fromP = await moveWith(ana, P, foreign)
  t.is(fromP && fromP.name, 'Padaria', 'the name arrives')
  t.is(fromP && fromP.avatar, null, "an item outside K1's table carries no photo")
  const fromR = await moveWith(gil, R, dP)
  t.is(fromR && fromR.name, 'Rotisseria', 'the name arrives')
  t.is(fromR && fromR.avatar, null, 'an item of another core carries no photo')
})
