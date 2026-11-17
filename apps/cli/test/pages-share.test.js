'use strict'

// A hosted page's posts on the installation's public web page
// ('post-share' and 'post-unshare', apps/cli/lib/account/pages-routes.js;
// pages-writer.js DELETABLE), end to end over loopback with the same
// account service and real pages writer as pages-moment.test.js: the same
// post-share record and the same rules as a person's post.share and
// post.unshare (web-member member-ops.js).

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept, signClose, signMoved, signOrigin } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { postShareRecord, validateRecord } = require('@varanda/core/lib/records')
const { POST_SHARES_PER_DIARY } = require('@varanda/core/lib/post-share')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
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

let subSeq = 900
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

async function setup (t) {
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const ctx = { assocKp, association, issuerKp, issuerCert, bootstrap }

  const dir = tmpDir(t, 'varanda-account-')
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const opts = {
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log: () => {},
    // About 80 requests: past the default global bucket of 100 with starts.
    ratePerSecond: 1000,
    burst: 1000
  }
  const seederDir = prepareSeederDir(t, assocKp)
  const seeder = new Seeder({ dataDir: seederDir, ...localSwarmOptions(bootstrap), associationKey: association, log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })

  let listener = null
  let base = null
  async function boot () {
    const writer = createPagesWriter({ dir, keys, association, seederWs: 'http://127.0.0.1:' + ws.port, log: () => {} })
    t.teardown(() => writer.close(), { force: true })
    await writer.ready()
    await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
    ctx.writer = writer
    ctx.pagesStore = openPagesStore(dir)
    opts.pages = { keys, writer, pagesStore: ctx.pagesStore, dir, blocklist: { has: () => false } }
    const server = createAccountServer(opts)
    listener = await server.listen({ host: '127.0.0.1', port: 0 })
    t.teardown(() => listener.close(), { force: true })
    base = 'http://127.0.0.1:' + listener.port
  }
  await boot()
  ctx.dir = dir

  // Everything stops, `between` runs against the data dir, then a new
  // writer, ACL and routes start over it.
  async function restart (between = async () => {}) {
    await listener.close()
    await ctx.writer.close()
    await between()
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
  async function newMember (username) {
    const m = member()
    await linkDirect(store, ctx, m, username)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'T'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
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
    const body = { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) }
    return api('POST', '/account/pages/' + action, body)
  }

  async function create (m, username) {
    const { nonce, page } = await start(m, 'create')
    const f = { page, gen: 1, owner: m.hex, admins: [], prev: null, at: new Date().toISOString(), nonce, association }
    const record = { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
    const op = { username, name: 'Página ' + username, bio: '', roster: { gen: 1, admins: [], prev: null, at: record.at, nonce } }
    const r = await api('POST', '/account/pages/create', { member: m.hex, nonce, page, op, signature: sign(m, 'create', nonce, page, op), record })
    return { ...r, page }
  }

  async function close (m, page) {
    const { nonce } = await start(m, 'close')
    const f = { page, gen: ctx.pagesStore.get(page).gen + 1, at: new Date().toISOString(), nonce, actor: m.hex, association }
    return api('POST', '/account/pages/close', { member: m.hex, nonce, page, record: { type: 'page-close', ...f, signature: signClose(f, m.kp) } })
  }

  function roster (m, page, fields, nonce, at = new Date().toISOString()) {
    const f = { page, ...fields, at, nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  async function addAdmin (owner, page, who) {
    const { nonce } = await start(owner, 'invite')
    const row = ctx.pagesStore.get(page)
    const admins = [...row.admins, who.hex].sort()
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins, prev: row.rosterSeq }, nonce)
    const op = { member: who.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: owner.hex, admins, prev: row.rosterSeq, at: record.at, nonce } }
    const inv = await api('POST', '/account/pages/invite', { member: owner.hex, nonce, page, op, signature: sign(owner, 'invite', nonce, page, op), record })
    if (inv.status !== 200) throw new Error('invite ' + JSON.stringify(inv.body))
    const acc = await start(who, 'accept')
    const f = { page, gen: ctx.pagesStore.get(page).gen + 1, rosterSignature: ctx.pagesStore.get(page).invites[who.hex].rosterSignature, at: new Date().toISOString(), nonce: acc.nonce, actor: who.hex }
    const r = await api('POST', '/account/pages/accept', { member: who.hex, nonce: acc.nonce, page, record: { type: 'page-accept', ...f, signature: signAccept(f, who.kp) } })
    if (r.status !== 200) throw new Error('accept ' + JSON.stringify(r.body))
  }

  async function removeAdmin (owner, page, who) {
    const { nonce } = await start(owner, 'remove')
    const row = ctx.pagesStore.get(page)
    const record = roster(owner, page, { gen: row.gen + 1, owner: owner.hex, admins: row.admins.filter((a) => a !== who.hex), prev: row.rosterSeq }, nonce)
    return api('POST', '/account/pages/remove', { member: owner.hex, nonce, page, record })
  }

  // The three records of page.sign 'move', each signed by `m`.
  async function move (m, page) {
    const { nonce, to } = await start(m, 'move')
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
    return { ...r, to }
  }

  return { ctx, api, newMember, act, create, close, start, sign, restart, addAdmin, removeAdmin, move }
}

async function recordAt (ctx, page, seq) {
  const e = (await ctx.writer.readEntries(page)).find((x) => x.seq === seq)
  return e ? e.record : null
}

async function seqOfType (ctx, page, type) {
  const e = (await ctx.writer.readEntries(page)).find((x) => x.record && x.record.type === type)
  return e ? e.seq : null
}

async function tombstonesOf (ctx, page) {
  return (await ctx.writer.readEntries(page)).filter((e) => e.record && e.record.type === 'delete').map((e) => e.record.seq)
}

function momentMedia () {
  return { id: 'a'.repeat(64), key: 'b'.repeat(64), nonce: 'c'.repeat(48), chunks: 2, bytes: 40000, sha256: 'd'.repeat(64), mime: 'image/jpeg', w: 1080, h: 1350, ms: 0 }
}

test('page web share: a live post, a reply or a quote, the record a person writes, refusals, unshare, delete and close', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const caio = await s.newMember('caio')
  const made = await s.create(ana, 'padaria')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const other = await s.create(caio, 'outra')
  t.is(other.status, 200, JSON.stringify(other.body))

  const post = await s.act(ana, 'post', K, { text: 'Pão quentinho' })
  t.is(post.status, 200, JSON.stringify(post.body))
  const reply = await s.act(ana, 'reply', K, { to: K + ':' + post.body.seq, text: 'Às 7h' })
  t.is(reply.status, 200, JSON.stringify(reply.body))
  const quote = await s.act(ana, 'quote', K, { to: K + ':' + post.body.seq, text: 'Olha só' })
  t.is(quote.status, 200, JSON.stringify(quote.body))
  const poll = await s.act(ana, 'post', K, { text: 'Qual pão?', poll: ['Francês', 'Integral'] })
  t.is(poll.status, 200, JSON.stringify(poll.body))
  const choice = await s.act(ana, 'choice', K, { to: K + ':' + poll.body.seq, pick: 1 })
  t.is(choice.status, 200, JSON.stringify(choice.body))
  const moment = await s.act(ana, 'moment', K, { text: 'Bom dia', media: momentMedia() })
  t.is(moment.status, 200, JSON.stringify(moment.body))
  const gone = await s.act(ana, 'post', K, { text: 'Errei' })
  t.is(gone.status, 200, JSON.stringify(gone.body))
  const goneDel = await s.act(ana, 'delete', K, { to: K + ':' + gone.body.seq })
  t.is(goneDel.status, 200, JSON.stringify(goneDel.body))
  const theirs = await s.act(caio, 'post', other.page, { text: 'Deles' })
  t.is(theirs.status, 200, JSON.stringify(theirs.body))

  // The person's record for the same post, byte for byte, and valid.
  const shared = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.is(shared.status, 200, JSON.stringify(shared.body))
  t.is(shared.body.created, true)
  const rec = await recordAt(ctx, K, shared.body.shareSeq)
  const person = postShareRecord({ seq: post.body.seq, at: rec.at })
  t.is(JSON.stringify(rec), JSON.stringify(person), 'the person\'s record byte for byte')
  t.is(validateRecord(rec, shared.body.shareSeq), null, 'valid')
  t.is(ctx.writer.info(K).length, shared.body.shareSeq + 1, 'one block')

  // Already live: the same share answered, nothing appended.
  const length = ctx.writer.info(K).length
  const again = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.is(again.status, 200, JSON.stringify(again.body))
  t.alike(again.body, { shareSeq: shared.body.shareSeq, created: false })
  t.is(ctx.writer.info(K).length, length, 'nothing new written')

  // The same request sent again answers the stored result.
  const { nonce } = await s.start(ana, 'post-share')
  const op = { seq: reply.body.seq }
  const body = { member: ana.hex, nonce, page: K, op, signature: s.sign(ana, 'post-share', nonce, K, op) }
  const replyShare = await s.api('POST', '/account/pages/post-share', body)
  t.is(replyShare.status, 200, JSON.stringify(replyShare.body))
  t.is(replyShare.body.created, true, 'a reply is a post')
  const resent = await s.api('POST', '/account/pages/post-share', body)
  t.alike(resent.body, replyShare.body, 'a resend answers the first use')
  const quoteShare = await s.act(ana, 'post-share', K, { seq: quote.body.seq })
  t.is(quoteShare.body.created, true, 'a quote is a post')
  t.is((await recordAt(ctx, K, quoteShare.body.shareSeq)).seq, quote.body.seq)

  // Refusals append nothing.
  const before = ctx.writer.info(K).length
  const profileSeq = await seqOfType(ctx, K, 'profile')
  t.ok(profileSeq !== null, 'the page has a profile block')
  const refusals = [
    [{ seq: profileSeq }, 'nao-encontrado', 'a profile'],
    [{ seq: moment.body.seq }, 'nao-encontrado', 'a momento'],
    [{ seq: choice.body.seq }, 'nao-encontrado', 'a choice'],
    [{ seq: shared.body.shareSeq }, 'nao-encontrado', 'a share'],
    [{ seq: gone.body.seq }, 'nao-encontrado', 'a deleted post'],
    [{ seq: before + theirs.body.seq }, 'nao-encontrado', 'a seq past the page\'s diary'],
    [{ seq: 0 }, 'pedido-invalido', 'block 0'],
    [{ seq: -1 }, 'pedido-invalido', 'a negative seq'],
    [{ seq: '3' }, 'pedido-invalido', 'a seq that is not a number'],
    [{ seq: 1.5 }, 'pedido-invalido', 'a fractional seq'],
    [{}, 'pedido-invalido', 'no seq'],
    [{ seq: post.body.seq, to: K + ':' + post.body.seq }, 'pedido-invalido', 'an extra key']
  ]
  for (const [o, error, name] of refusals) {
    const r = await s.act(ana, 'post-share', K, o)
    t.is(r.body.error, error, name)
  }
  const theirShare = await s.act(ana, 'post-share', other.page, { seq: theirs.body.seq })
  t.is(theirShare.body.error, 'sem-permissao', 'another page\'s post')
  const stranger = await s.act(caio, 'post-share', K, { seq: poll.body.seq })
  t.is(stranger.body.error, 'sem-permissao', 'a member who is not an admin')
  const strangerOff = await s.act(caio, 'post-unshare', K, { seq: post.body.seq })
  t.is(strangerOff.body.error, 'sem-permissao', 'a stranger cannot unshare')
  t.is(ctx.writer.info(K).length, before, 'no refusal appends')

  async function sharedNow () {
    const st = await s.act(ana, 'status', K, {})
    t.is(st.status, 200, JSON.stringify(st.body))
    return st.body.shared
  }
  t.alike(await sharedNow(), [post.body.seq, reply.body.seq, quote.body.seq], 'status lists the live shares, ascending')

  // Unshare: one plain tombstone of the share, then nothing to do.
  const off = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.is(off.status, 200, JSON.stringify(off.body))
  t.alike(off.body, { ok: true, changed: true })
  const tomb = await recordAt(ctx, K, ctx.writer.info(K).length - 1)
  t.is(tomb.type, 'delete')
  t.is(tomb.seq, shared.body.shareSeq, 'the share is tombstoned')
  t.absent('media' in tomb, 'no media range')
  const offLength = ctx.writer.info(K).length
  const offAgain = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.alike(offAgain.body, { ok: true, changed: false })
  t.is(ctx.writer.info(K).length, offLength, 'a second unshare writes nothing')
  t.alike(await sharedNow(), [reply.body.seq, quote.body.seq], 'the unshared post left the list')
  const unshareRefused = await s.act(ana, 'post-unshare', K, { seq: moment.body.seq })
  t.is(unshareRefused.body.error, 'nao-encontrado', 'unshare of a momento')

  // Shared again: a new share block.
  const reshared = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.is(reshared.body.created, true)
  t.ok(reshared.body.shareSeq > shared.body.shareSeq, 'a new block')
  t.alike(await sharedNow(), [post.body.seq, reply.body.seq, quote.body.seq])

  // Deleting the post through the page delete action still works, and its
  // share is no longer listed.
  const del = await s.act(ana, 'delete', K, { to: K + ':' + reply.body.seq })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.alike(await sharedNow(), [post.body.seq, quote.body.seq], 'a deleted post is not listed')
  const deletedShare = await s.act(ana, 'post-share', K, { seq: reply.body.seq })
  t.is(deletedShare.body.error, 'nao-encontrado', 'a deleted post cannot be shared again')

  // A member without a role gets no list.
  const refusedStatus = await s.act(caio, 'status', K, {})
  t.is(refusedStatus.body.error, 'sem-permissao')
  t.absent('shared' in refusedStatus.body)

  // Closing tombstones every live share with the posts.
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  const dels = await tombstonesOf(ctx, K)
  t.ok(dels.includes(reshared.body.shareSeq), 'close tombstones the post\'s share')
  t.ok(dels.includes(quoteShare.body.shareSeq), 'close tombstones the quote\'s share')
  t.ok(dels.includes(replyShare.body.shareSeq), 'close tombstones the deleted reply\'s share')
  const after = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.is(after.body.error, 'encerrada', 'a closed page shares nothing')
  const afterOff = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.is(afterOff.body.error, 'encerrada', 'a closed page unshares nothing')
})

test('page web share: the owner, with shares already in the diary from elsewhere', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'feira')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page

  const post = await s.act(ana, 'post', K, { text: 'Feira no sábado' })
  t.is(post.status, 200, JSON.stringify(post.body))
  // Two live shares of one post (a writer elsewhere could leave them): an
  // unshare tombstones both, and a share answers the newest.
  const two = await ctx.writer.append(K, [postShareRecord({ seq: post.body.seq }), postShareRecord({ seq: post.body.seq })])
  await ctx.pagesStore.expectLength(K, ctx.writer.info(K).length)
  const again = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.alike(again.body, { shareSeq: two.seq, created: false }, 'the newest live share')
  const off = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.alike(off.body, { ok: true, changed: true })
  const dels = await tombstonesOf(ctx, K)
  t.ok(dels.includes(two.seq) && dels.includes(two.seq - 1), 'both shares tombstoned')
  t.alike((await s.act(ana, 'status', K, {})).body.shared, [], 'nothing shared')
})

// The writer's own append of these records, the ACL told the new length
// as the service's append would.
async function seed (ctx, page, records) {
  let res = null
  for (let i = 0; i < records.length; i += 8) res = await ctx.writer.append(page, records.slice(i, i + 8))
  await ctx.pagesStore.expectLength(page, ctx.writer.info(page).length)
  return res
}

test('page web share: an admin who is not the owner shares and unshares; a removed admin cannot', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const caio = await s.newMember('caio')
  const made = await s.create(ana, 'horta')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  await s.addAdmin(ana, K, caio)
  t.ok(s.ctx.pagesStore.get(K).admins.includes(caio.hex), 'caio is an admin')
  const post = await s.act(ana, 'post', K, { text: 'Mudas novas' })
  t.is(post.status, 200, JSON.stringify(post.body))
  const on = await s.act(caio, 'post-share', K, { seq: post.body.seq })
  t.is(on.status, 200, JSON.stringify(on.body))
  t.is(on.body.created, true, 'the admin shares')
  const off = await s.act(caio, 'post-unshare', K, { seq: post.body.seq })
  t.alike(off.body, { ok: true, changed: true }, 'the admin unshares')
  const again = await s.act(caio, 'post-share', K, { seq: post.body.seq })
  t.is(again.body.created, true)
  const removed = await s.removeAdmin(ana, K, caio)
  t.is(removed.status, 200, JSON.stringify(removed.body))
  const length = s.ctx.writer.info(K).length
  t.is((await s.act(caio, 'post-unshare', K, { seq: post.body.seq })).body.error, 'sem-permissao', 'a removed admin cannot unshare')
  t.is((await s.act(caio, 'post-share', K, { seq: post.body.seq })).body.error, 'sem-permissao', 'a removed admin cannot share')
  t.is(s.ctx.writer.info(K).length, length, 'nothing appended')
})

test('page web share: a lost answer is answered again after a restart, from the writer or from the spent nonce alone', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'bazar')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const post = await s.act(ana, 'post', K, { text: 'Bazar no domingo' })
  t.is(post.status, 200, JSON.stringify(post.body))

  async function sent (action, op) {
    const { nonce } = await s.start(ana, action)
    return { member: ana.hex, nonce, page: K, op, signature: s.sign(ana, action, nonce, K, op) }
  }
  const shareBody = await sent('post-share', { seq: post.body.seq })
  const shared = await s.api('POST', '/account/pages/post-share', shareBody)
  t.is(shared.status, 200, JSON.stringify(shared.body))
  const unshareBody = await sent('post-unshare', { seq: post.body.seq })
  const unshared = await s.api('POST', '/account/pages/post-unshare', unshareBody)
  t.alike(unshared.body, { ok: true, changed: true })
  const length = ctx.writer.info(K).length

  // The in-memory answers are gone; the writer's nonce records answer.
  await s.restart()
  t.alike((await s.api('POST', '/account/pages/post-share', shareBody)).body, { shareSeq: shared.body.shareSeq, created: true, replay: true }, 'share, from the writer')
  t.alike((await s.api('POST', '/account/pages/post-unshare', unshareBody)).body, { ok: true, changed: true, replay: true }, 'unshare, from the writer')

  // The writer's nonce records gone too: the ACL's spent nonce answers in
  // the same shape.
  await s.restart(async () => {
    const file = path.join(ctx.dir, 'pages-store', K + '.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.nonces = {}
    fs.writeFileSync(file, JSON.stringify(state))
  })
  t.alike((await s.api('POST', '/account/pages/post-share', shareBody)).body, { shareSeq: shared.body.shareSeq, created: true, replay: true }, 'share, from the spent nonce')
  t.alike((await s.api('POST', '/account/pages/post-unshare', unshareBody)).body, { ok: true, changed: true, replay: true }, 'unshare, from the spent nonce')
  t.is(ctx.writer.info(K).length, length, 'no resend appends')
})

test('page web share: more than 8 live shares of one post go in two unshares', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'sebo')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const post = await s.act(ana, 'post', K, { text: 'Livros usados' })
  t.is(post.status, 200, JSON.stringify(post.body))
  const last = await seed(ctx, K, Array.from({ length: 10 }, () => postShareRecord({ seq: post.body.seq })))
  const shareSeqs = Array.from({ length: 10 }, (_, i) => last.seq - 9 + i)
  const first = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.alike(first.body, { ok: true, changed: true })
  let dels = await tombstonesOf(ctx, K)
  t.alike(shareSeqs.filter((x) => dels.includes(x)), shareSeqs.slice(2), 'the newest 8 first')
  t.alike((await s.act(ana, 'status', K, {})).body.shared, [post.body.seq], 'still shared while one is live')
  const second = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.alike(second.body, { ok: true, changed: true }, 'a repeat finishes the rest')
  dels = await tombstonesOf(ctx, K)
  t.ok(shareSeqs.every((x) => dels.includes(x)), 'every share tombstoned')
  t.alike((await s.act(ana, 'post-unshare', K, { seq: post.body.seq })).body, { ok: true, changed: false })
  t.alike((await s.act(ana, 'status', K, {})).body.shared, [])
})

test('page web share: a moved page refuses both actions', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'oficina')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const post = await s.act(ana, 'post', K, { text: 'Consertos' })
  t.is(post.status, 200, JSON.stringify(post.body))
  const moved = await s.move(ana, K)
  t.is(moved.status, 200, JSON.stringify(moved.body))
  t.is((await s.act(ana, 'post-share', K, { seq: post.body.seq })).body.error, 'movida', 'share on a moved page')
  t.is((await s.act(ana, 'post-unshare', K, { seq: post.body.seq })).body.error, 'movida', 'unshare on a moved page')
})

test('page web share: a new post past the fold bound is refused, tombstoned shares counting', async (t) => {
  t.timeout(600000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'armazem')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  const early = await s.act(ana, 'post', K, { text: 'Primeira' })
  t.is(early.status, 200, JSON.stringify(early.body))
  // POST_SHARES_PER_DIARY shares of distinct posts, the first of them the
  // real post `early`: each share names the block right before it.
  const base = ctx.writer.info(K).length
  t.is(base, early.body.seq + 1)
  const records = Array.from({ length: POST_SHARES_PER_DIARY }, (_, i) => postShareRecord({ seq: base + i - 1 }))
  await seed(ctx, K, records)
  const late = await s.act(ana, 'post', K, { text: 'Depois do limite' })
  t.is(late.status, 200, JSON.stringify(late.body))
  t.is((await s.act(ana, 'post-share', K, { seq: late.body.seq })).body.error, 'limite', 'a new post past the bound')

  // Withdrawn, the first share still counts toward the bound.
  const off = await s.act(ana, 'post-unshare', K, { seq: early.body.seq })
  t.alike(off.body, { ok: true, changed: true })
  const length = ctx.writer.info(K).length
  t.is((await s.act(ana, 'post-share', K, { seq: late.body.seq })).body.error, 'limite', 'a tombstoned share still counts')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')
  // A post the fold already holds always takes a new share.
  const back = await s.act(ana, 'post-share', K, { seq: early.body.seq })
  t.is(back.body.created, true, 'a post already in the fold is shared again')
  t.alike((await s.act(ana, 'status', K, {})).body.shared, [early.body.seq])
})
