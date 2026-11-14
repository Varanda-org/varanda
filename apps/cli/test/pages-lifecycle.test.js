'use strict'

// Close, move and the successor statement of apps/cli/lib/account/
// pages-routes.js end to end, loopback only: the account service with pages
// on, the pages writer linked to a real seeder over seed-ws on a local DHT,
// and a third member that reads the page diaries from the seeder. The setup
// follows account-pages.test.js.

const fs = require('node:fs')
const path = require('node:path')
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
const { postRecord } = require('@varanda/core/lib/records')
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
    // Every block is asked at once on one session: a cleared block never
    // arrives, and read one by one each of them (and any block the seeder is
    // slow to serve right after the close) cost the whole timeout, so on a
    // loaded runner a single pass could eat the caller's deadline.
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

  return { ctx, store, api, logs, newMember, start, sign, act, create, addAdmin, invite, close, move, restart }
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

  // ---- rate: 2 closes or moves per owner per day (the window is in
  // memory, and the restart above began a new one) ----
  for (const name of ['roda', 'rodinha']) t.is((await s.close(ana, await s.create(ana, name))).status, 200)
  const R3 = await s.create(ana, 'rodona')
  t.is((await s.close(ana, R3)).body.error, 'limite', 'a third close in a day is refused')

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
