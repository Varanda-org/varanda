'use strict'

// A hosted page's posts on the installation's public web page
// ('post-share' and 'post-unshare', apps/cli/lib/account/pages-routes.js;
// pages-writer.js DELETABLE), end to end over loopback with the same
// account service and real pages writer as pages-moment.test.js: the same
// post-share record and the same rules as a person's post.share and
// post.unshare (web-member member-ops.js), and a shared post's cover
// ('post-cover', a person's post.cover).

const nodeCrypto = require('node:crypto')
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
const { postShareRecord, postCoverRecord, validateRecord } = require('@varanda/core/lib/records')
const { applyDeletes } = require('@varanda/core/lib/deletion')
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

function be16 (n) {
  return [(n >> 8) & 0xff, n & 0xff]
}

// A baseline JPEG header the strict parser accepts (pages-media.test.js).
function jpeg (width, height, size, fill = 0x5a) {
  const head = b4a.from([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  const out = b4a.alloc(size, fill)
  head.copy(out, 0)
  out[size - 2] = 0xff
  out[size - 1] = 0xd9
  return out
}

function photoOp (bytes, width, height) {
  return { sha256: nodeCrypto.createHash('sha256').update(bytes).digest('hex'), mime: 'image/jpeg', width, height, bytes: bytes.length }
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

  return { ctx, api, newMember, act, create, close, start, sign, restart, addAdmin, removeAdmin, move, upload }
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
  t.alike((await s.act(ana, 'status', K, {})).body.shared, [], 'the highest share is gone: off the public page, as the seeder reads it')
  const back = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.is(back.body.created, true, 'a new share even beside the two older live ones')
  t.ok(back.body.shareSeq > last.seq, 'the new highest share')
  t.alike((await s.act(ana, 'status', K, {})).body.shared, [post.body.seq], 'listed again')
  const again = await s.act(ana, 'post-share', K, { seq: post.body.seq })
  t.alike(again.body, { shareSeq: back.body.shareSeq, created: false }, 'the live highest share answers')
  const second = await s.act(ana, 'post-unshare', K, { seq: post.body.seq })
  t.alike(second.body, { ok: true, changed: true }, 'a repeat finishes the rest')
  dels = await tombstonesOf(ctx, K)
  t.ok([...shareSeqs, back.body.shareSeq].every((x) => dels.includes(x)), 'every share tombstoned')
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

// The live post-cover blocks of the page, tombstones applied.
async function liveCovers (ctx, page) {
  return applyDeletes(await ctx.writer.readEntries(page)).filter((e) => e && !e.deleted && e.record && e.record.type === 'post-cover')
}

// The media ranges of the tombstone of block `seq`, or null for none.
async function tombRanges (ctx, page, seq) {
  const e = (await ctx.writer.readEntries(page)).find((x) => x.record && x.record.type === 'delete' && x.record.seq === seq)
  return e ? e.record.media : null
}

function rangeOf (d) {
  return { core: d.core, start: d.start, blocks: d.blocks }
}

test('page web share: a cover for a shared post, its replacement, refusals, a resend, unshare, delete and close', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const caio = await s.newMember('caio')
  const made = await s.create(ana, 'quitanda')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page

  async function item (width, height, size, fill) {
    const bytes = jpeg(width, height, size, fill)
    const r = await s.upload(ana, K, bytes, photoOp(bytes, width, height))
    t.is(r.status, 200, JSON.stringify(r.body))
    return r.body.descriptor
  }
  const d1 = await item(1200, 630, 40 * 1024, 0x11)
  const d2 = await item(1200, 630, 50 * 1024, 0x22)
  const wide = await item(1600, 900, 40 * 1024, 0x33)
  const post = await s.act(ana, 'post', K, { text: 'Frutas da estação', media: [wide] })
  t.is(post.status, 200, JSON.stringify(post.body))
  const P = post.body.seq

  async function status () {
    const st = await s.act(ana, 'status', K, {})
    t.is(st.status, 200, JSON.stringify(st.body))
    return { shared: st.body.shared, covered: st.body.covered }
  }

  // Before the share: refused, nothing written.
  let length = ctx.writer.info(K).length
  t.is((await s.act(ana, 'post-cover', K, { seq: P, image: d1 })).body.error, 'pedido-invalido', 'a post not shared')
  t.is(ctx.writer.info(K).length, length, 'nothing appended before the share')
  const shared = await s.act(ana, 'post-share', K, { seq: P })
  t.is(shared.body.created, true)
  t.alike(await status(), { shared: [P], covered: [] }, 'shared without a cover')

  // The person's record, byte for byte.
  const first = await s.act(ana, 'post-cover', K, { seq: P, image: d1 })
  t.is(first.status, 200, JSON.stringify(first.body))
  t.is(first.body.created, true)
  const rec = await recordAt(ctx, K, first.body.coverSeq)
  t.is(JSON.stringify(rec), JSON.stringify(postCoverRecord({ seq: P, image: d1, at: rec.at })), 'the person\'s record byte for byte')
  t.is(validateRecord(rec, first.body.coverSeq), null, 'valid')
  t.alike(await status(), { shared: [P], covered: [P] }, 'covered once the cover is written')

  // The same image again: answered, nothing appended.
  length = ctx.writer.info(K).length
  t.alike((await s.act(ana, 'post-cover', K, { seq: P, image: d1 })).body, { coverSeq: first.body.coverSeq, created: false }, 'a repeat is a no-op')
  t.is(ctx.writer.info(K).length, length, 'nothing new written')

  // Refusals append nothing.
  const profileSeq = await seqOfType(ctx, K, 'profile')
  const refusals = [
    [{ seq: P, image: { ...d1, core: 'ab'.repeat(32) } }, 'midia-invalida', 'a core the page did not declare'],
    [{ seq: P, image: { ...d1, sha256: 'ee'.repeat(32) } }, 'midia-invalida', 'a bad hash'],
    [{ seq: P, image: { ...d1, start: d1.start + 1 } }, 'midia-invalida', 'a range the page never stored'],
    [{ seq: P, image: wide }, 'midia-invalida', 'a stored photo too large for a cover'],
    [{ seq: P, image: { ...d1, mime: 'image/png' } }, 'midia-invalida', 'not a JPEG'],
    [{ seq: P, image: { ...d1, extra: 1 } }, 'midia-invalida', 'an extra descriptor key'],
    [{ seq: profileSeq, image: d1 }, 'nao-encontrado', 'a profile'],
    [{ seq: 0, image: d1 }, 'pedido-invalido', 'block 0'],
    [{ seq: P }, 'pedido-invalido', 'no image'],
    [{ seq: P, image: d1, to: K + ':' + P }, 'pedido-invalido', 'an extra key']
  ]
  for (const [o, error, name] of refusals) {
    t.is((await s.act(ana, 'post-cover', K, o)).body.error, error, name)
  }
  t.is((await s.act(caio, 'post-cover', K, { seq: P, image: d2 })).body.error, 'sem-permissao', 'a member who is not an admin')
  const person = await s.act(caio, 'post-cover', caio.hex, { seq: 1, image: d1 })
  t.is(person.body.error, 'pedido-invalido', 'a person\'s diary is not writable through this action')
  t.is(ctx.writer.info(K).length, length, 'no refusal appends')

  // A second cover replaces the first in one append: the first is
  // tombstoned with its range, so exactly one cover stays live and a clear
  // frees the first image while the live one keeps its own.
  const second = await s.act(ana, 'post-cover', K, { seq: P, image: d2 })
  t.is(second.body.created, true)
  t.is(ctx.writer.info(K).length, length + 2, 'one tombstone and the cover')
  t.alike(await tombRanges(ctx, K, first.body.coverSeq), [rangeOf(d1)], 'the first cover\'s range goes with it')
  t.alike((await liveCovers(ctx, K)).map((e) => e.seq), [second.body.coverSeq], 'exactly one live cover')
  await ctx.writer.clearDeleted(K)
  const items = ctx.writer.items(K)
  t.absent(items.some((it) => it.sha256 === d1.sha256), 'the first image is freed')
  t.ok(items.some((it) => it.sha256 === d2.sha256), 'the live cover keeps its image')
  t.is((await s.act(ana, 'post-cover', K, { seq: P, image: d1 })).body.error, 'midia-invalida', 'a freed image is no longer the page\'s')

  // The same request sent again answers the stored result, in memory and
  // from the writer after a restart.
  const d3 = await item(800, 800, 30 * 1024, 0x44)
  const { nonce } = await s.start(ana, 'post-cover')
  const op = { seq: P, image: d3 }
  const body = { member: ana.hex, nonce, page: K, op, signature: s.sign(ana, 'post-cover', nonce, K, op) }
  const third = await s.api('POST', '/account/pages/post-cover', body)
  t.is(third.status, 200, JSON.stringify(third.body))
  length = ctx.writer.info(K).length
  t.alike((await s.api('POST', '/account/pages/post-cover', body)).body, third.body, 'a resend answers the first use')
  await s.restart()
  t.alike((await s.api('POST', '/account/pages/post-cover', body)).body, { coverSeq: third.body.coverSeq, created: true, replay: true }, 'from the writer after a restart')
  t.is(ctx.writer.info(K).length, length, 'no resend appends')

  // Unshare: the share and the live cover, with its range.
  const off = await s.act(ana, 'post-unshare', K, { seq: P })
  t.alike(off.body, { ok: true, changed: true })
  t.alike(await tombRanges(ctx, K, third.body.coverSeq), [rangeOf(d3)], 'the cover is tombstoned with its range')
  t.alike(await liveCovers(ctx, K), [], 'no live cover after an unshare')
  t.alike(await status(), { shared: [], covered: [] })
  t.alike((await s.act(ana, 'post-unshare', K, { seq: P })).body, { ok: true, changed: false })

  // Shared and covered again, then the post deleted: its cover goes with it.
  t.is((await s.act(ana, 'post-share', K, { seq: P })).body.created, true)
  t.alike(await status(), { shared: [P], covered: [] }, 'a new share starts with no cover')
  const d4 = await item(1200, 1200, 60 * 1024, 0x55)
  const fourth = await s.act(ana, 'post-cover', K, { seq: P, image: d4 })
  t.is(fourth.body.created, true)
  t.alike(await status(), { shared: [P], covered: [P] })
  const del = await s.act(ana, 'delete', K, { to: K + ':' + P })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.alike(await tombRanges(ctx, K, fourth.body.coverSeq), [rangeOf(d4)], 'the delete tombstones the cover with its range')
  t.alike(await liveCovers(ctx, K), [], 'no live cover after the post is deleted')
  t.alike(await status(), { shared: [], covered: [] })

  // Close: every live cover, with its range.
  const other = await s.act(ana, 'post', K, { text: 'Cesta da semana', media: [await item(640, 480, 20 * 1024, 0x77)] })
  t.is((await s.act(ana, 'post-share', K, { seq: other.body.seq })).body.created, true)
  const d5 = await item(1000, 500, 20 * 1024, 0x66)
  const fifth = await s.act(ana, 'post-cover', K, { seq: other.body.seq, image: d5 })
  t.is(fifth.body.created, true)
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  t.alike(await tombRanges(ctx, K, fifth.body.coverSeq), [rangeOf(d5)], 'close tombstones the cover with its range')
  t.alike(await liveCovers(ctx, K), [], 'no live cover after a close')
  t.is((await s.act(ana, 'post-cover', K, { seq: other.body.seq, image: d5 })).body.error, 'encerrada', 'a closed page sets no cover')
})

test('page web share: the same cover again finishes the cleanup of older live covers a writer left', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'mercearia')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  async function item (fill) {
    const bytes = jpeg(1200, 630, 30 * 1024, fill)
    const r = await s.upload(ana, K, bytes, photoOp(bytes, 1200, 630))
    t.is(r.status, 200, JSON.stringify(r.body))
    return r.body.descriptor
  }
  const old1 = await item(0x11)
  const old2 = await item(0x22)
  const top = await item(0x33)
  const post = await s.act(ana, 'post', K, { text: 'Café moído na hora', media: [await item(0x44)] })
  const P = post.body.seq
  t.is((await s.act(ana, 'post-share', K, { seq: P })).body.created, true)
  // Three live covers of one post, as a writer elsewhere could leave them.
  const last = await seed(ctx, K, [old1, old2, top].map((image) => postCoverRecord({ seq: P, image })))
  t.is((await liveCovers(ctx, K)).length, 3)

  const { nonce } = await s.start(ana, 'post-cover')
  const op = { seq: P, image: top }
  const body = { member: ana.hex, nonce, page: K, op, signature: s.sign(ana, 'post-cover', nonce, K, op) }
  const length = ctx.writer.info(K).length
  const r = await s.api('POST', '/account/pages/post-cover', body)
  t.alike(r.body, { coverSeq: last.seq, created: false }, 'the live highest cover answers')
  t.is(ctx.writer.info(K).length, length + 2, 'only the two older covers are tombstoned')
  t.alike(await tombRanges(ctx, K, last.seq - 2), [rangeOf(old1)])
  t.alike(await tombRanges(ctx, K, last.seq - 1), [rangeOf(old2)])
  t.alike((await liveCovers(ctx, K)).map((e) => e.seq), [last.seq], 'exactly one live cover')
  t.alike((await s.act(ana, 'status', K, {})).body.covered, [P])

  // Nothing left to clean: a plain no-op.
  t.alike((await s.act(ana, 'post-cover', K, op)).body, { coverSeq: last.seq, created: false })
  t.is(ctx.writer.info(K).length, length + 2, 'nothing appended')

  // The cleanup's answer survives a restart: the kept cover, not a tombstone.
  await s.restart()
  t.alike((await s.api('POST', '/account/pages/post-cover', body)).body, { coverSeq: last.seq, created: false, replay: true }, 'from the writer after a restart')
  t.is(ctx.writer.info(K).length, length + 2, 'no resend appends')

  // The spent nonce alone names the last tombstone: the kept cover is the
  // post's cover below it.
  await s.restart(async () => {
    const file = path.join(ctx.dir, 'pages-store', K + '.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.nonces = {}
    fs.writeFileSync(file, JSON.stringify(state))
  })
  t.alike((await s.api('POST', '/account/pages/post-cover', body)).body, { coverSeq: last.seq, created: false, replay: true }, 'from the spent nonce after a restart')
  t.is(ctx.writer.info(K).length, length + 2, 'no resend appends')
})

// Covers that do not fit the post's own delete: the delete tombstones the
// oldest, a repeat delete (after a restart) the rest, and a third answers
// the post's tombstone with nothing appended.
async function coversPastDelete (t, { photos, covers }) {
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'sobras' + photos)
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  async function item (width, height, size, fill) {
    const bytes = jpeg(width, height, size, fill)
    const r = await s.upload(ana, K, bytes, photoOp(bytes, width, height))
    t.is(r.status, 200, JSON.stringify(r.body))
    return r.body.descriptor
  }
  const media = []
  for (let i = 0; i < photos; i++) media.push(await item(64, 48, 2048 + i, 0x70 + i))
  const images = []
  for (let i = 0; i < covers; i++) images.push(await item(1200, 630, 30 * 1024 + i, 0x10 + i))
  const post = await s.act(ana, 'post', K, photos > 0 ? { text: 'Feira de sábado', media } : { text: 'Feira de sábado' })
  t.is(post.status, 200, JSON.stringify(post.body))
  const P = post.body.seq
  t.is((await s.act(ana, 'post-share', K, { seq: P })).body.created, true)
  // Live covers of one post, as another client could leave them.
  await seed(ctx, K, images.map((image) => postCoverRecord({ seq: P, image })))
  const seqs = (await liveCovers(ctx, K)).map((e) => e.seq)
  t.is(seqs.length, covers)
  const own = photos === 0 ? 1 : Math.ceil(photos / 4)
  const fit = 8 - own

  let length = ctx.writer.info(K).length
  const del = await s.act(ana, 'delete', K, { to: K + ':' + P })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.is(ctx.writer.info(K).length, length + 8, 'one full append')
  for (let i = 0; i < fit; i++) t.alike(await tombRanges(ctx, K, seqs[i]), [rangeOf(images[i])], 'cover ' + i + ' goes first, with its range')
  t.alike((await liveCovers(ctx, K)).map((e) => e.seq), seqs.slice(fit), 'the newest covers are left, oldest first tombstoned')
  t.is((await s.act(ana, 'post-cover', K, { seq: P, image: images[0] })).body.error, 'nao-encontrado', 'a deleted post takes no cover')

  // After a restart, from the diary alone: a repeat delete takes the rest.
  await s.restart()
  length = ctx.writer.info(K).length
  const again = await s.act(ana, 'delete', K, { to: K + ':' + P })
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(ctx.writer.info(K).length, length + covers - fit, 'only the covers left')
  t.is(again.body.seq, length + covers - fit - 1, 'answered as a delete that appended')
  for (let i = fit; i < covers; i++) t.alike(await tombRanges(ctx, K, seqs[i]), [rangeOf(images[i])], 'cover ' + i + ' with its range')
  t.alike(await liveCovers(ctx, K), [], 'no live cover left')

  // Nothing left: the post's own tombstone answers, nothing appended.
  length = ctx.writer.info(K).length
  const third = await s.act(ana, 'delete', K, { to: K + ':' + P })
  t.alike(third.body, { seq: del.body.seq - fit, length, pushed: false }, 'the post\'s own last tombstone, as an already deleted post')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')

  await ctx.writer.clearDeleted(K)
  const items = ctx.writer.items(K)
  t.absent(items.some((it) => [...images, ...media].some((d) => d.sha256 === it.sha256)), 'every range is freed')
}

test('page web share: a text post with 9 live covers is deleted in two deletes, oldest covers first', async (t) => {
  t.timeout(300000)
  await coversPastDelete(t, { photos: 0, covers: 9 })
})

test('page web share: a 10-photo post with 6 live covers is deleted in two deletes, oldest covers first', async (t) => {
  t.timeout(300000)
  await coversPastDelete(t, { photos: 10, covers: 6 })
})

test('page web share: a cleanup-only cover replays its kept cover, never a tombstone, after the cover is deleted and cleared', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'armazem')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  async function item (fill) {
    const bytes = jpeg(1200, 630, 30 * 1024, fill)
    const r = await s.upload(ana, K, bytes, photoOp(bytes, 1200, 630))
    t.is(r.status, 200, JSON.stringify(r.body))
    return r.body.descriptor
  }
  const old = await item(0x11)
  const top = await item(0x22)
  const post = await s.act(ana, 'post', K, { text: 'Queijo da serra', media: [await item(0x33)] })
  const P = post.body.seq
  t.is((await s.act(ana, 'post-share', K, { seq: P })).body.created, true)
  const last = await seed(ctx, K, [old, top].map((image) => postCoverRecord({ seq: P, image })))

  const { nonce } = await s.start(ana, 'post-cover')
  const op = { seq: P, image: top }
  const body = { member: ana.hex, nonce, page: K, op, signature: s.sign(ana, 'post-cover', nonce, K, op) }
  const r = await s.api('POST', '/account/pages/post-cover', body)
  t.alike(r.body, { coverSeq: last.seq, created: false }, 'only the older cover is tombstoned')
  const tomb = ctx.writer.info(K).length - 1

  // The kept cover tombstoned and its block cleared.
  t.alike((await s.act(ana, 'post-unshare', K, { seq: P })).body, { ok: true, changed: true })
  await ctx.writer.clearDeleted(K)
  t.is((await ctx.writer.readRawBlocks(K)).find((e) => e.seq === last.seq).record, null, 'the kept cover is cleared')

  // The writer's nonce record keeps the original answer.
  await s.restart()
  t.alike((await s.api('POST', '/account/pages/post-cover', body)).body, { coverSeq: last.seq, created: false, replay: true }, 'from the writer')

  // The spent nonce alone names the tombstone: the kept cover cannot be
  // told, so a refusal, never that tombstone as a created cover.
  await s.restart(async () => {
    const file = path.join(ctx.dir, 'pages-store', K + '.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.nonces = {}
    fs.writeFileSync(file, JSON.stringify(state))
  })
  const spent = await s.api('POST', '/account/pages/post-cover', body)
  t.is(spent.body.error, 'pedido-invalido', JSON.stringify(spent.body))
  t.not(spent.body.coverSeq, tomb, 'no deletion block named')
  t.not(spent.body.created, true, 'nothing claimed as created')
})

test('page web share: a cover shares no range with live or freed media, and no tombstone frees a range a live record shows', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const made = await s.create(ana, 'padaria')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page
  async function item (fill) {
    const bytes = jpeg(1200, 630, 30 * 1024, fill)
    const r = await s.upload(ana, K, bytes, photoOp(bytes, 1200, 630))
    t.is(r.status, 200, JSON.stringify(r.body))
    return r.body.descriptor
  }
  const photo = await item(0x11)
  const a = await item(0x22)
  const b = await item(0x33)
  const c = await item(0x44)
  const withPhoto = await s.act(ana, 'post', K, { text: 'Pão de queijo', media: [photo] })
  t.is(withPhoto.status, 200, JSON.stringify(withPhoto.body))
  const P = withPhoto.body.seq
  const Q = (await s.act(ana, 'post', K, { text: 'Broa de milho', media: [photo] })).body.seq
  for (const seq of [P, Q]) t.is((await s.act(ana, 'post-share', K, { seq })).body.created, true)

  // The person's rule (docs/rpc.md 5.169): no bytes shared with live media.
  let length = ctx.writer.info(K).length
  t.is((await s.act(ana, 'post-cover', K, { seq: P, image: photo })).body.error, 'midia-invalida', 'the post\'s own photo')
  t.is((await s.act(ana, 'post-cover', K, { seq: Q, image: photo })).body.error, 'midia-invalida', 'another live post\'s photo')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')
  t.is((await s.act(ana, 'post-cover', K, { seq: P, image: a })).body.created, true)
  length = ctx.writer.info(K).length
  t.is((await s.act(ana, 'post-cover', K, { seq: Q, image: a })).body.error, 'midia-invalida', 'another post\'s live cover')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')

  // A, then B, then A again: the first tombstone freed A, and seeders
  // cleared it for good, though the item table keeps it until a clear.
  const second = await s.act(ana, 'post-cover', K, { seq: P, image: b })
  t.is(second.body.created, true)
  t.ok(ctx.writer.items(K).some((it) => it.sha256 === a.sha256), 'no clear ran: the freed item is still listed')
  length = ctx.writer.info(K).length
  t.is((await s.act(ana, 'post-cover', K, { seq: P, image: a })).body.error, 'midia-invalida', 'a range a tombstone freed')
  t.is(ctx.writer.info(K).length, length, 'nothing appended')

  // A cover another writer left sharing a range with a live post: an
  // unshare keeps the range the post still shows.
  const qPhoto = await seed(ctx, K, [postCoverRecord({ seq: Q, image: photo })])
  t.alike((await s.act(ana, 'post-unshare', K, { seq: Q })).body, { ok: true, changed: true })
  t.is(await tombRanges(ctx, K, qPhoto.seq), undefined, 'the photo post P shows is not freed')

  // The same image again keeps the range of the cover it keeps.
  t.is((await s.act(ana, 'post-share', K, { seq: Q })).body.created, true)
  const top = await seed(ctx, K, [postCoverRecord({ seq: Q, image: c }), postCoverRecord({ seq: Q, image: c })])
  t.alike((await s.act(ana, 'post-cover', K, { seq: Q, image: c })).body, { coverSeq: top.seq, created: false })
  t.is(await tombRanges(ctx, K, top.seq - 1), undefined, 'the older cover\'s tombstone leaves the kept cover\'s range')
  t.alike((await liveCovers(ctx, K)).filter((e) => e.record.seq === Q).map((e) => e.seq), [top.seq], 'exactly one live cover of Q')
  t.alike((await s.act(ana, 'post-unshare', K, { seq: Q })).body, { ok: true, changed: true })
  t.alike(await tombRanges(ctx, K, top.seq), [rangeOf(c)], 'freed once no live record shows it')

  // A delete of the post frees its cover's range, which nothing else shows.
  const del = await s.act(ana, 'delete', K, { to: K + ':' + P })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.alike(await tombRanges(ctx, K, second.body.coverSeq), [rangeOf(b)], 'the post\'s cover goes with its range')
})

// Exercise signed route decisions without transport or a seeder. The writer
// keeps raw holes and tombstones so a cleanup is judged against the whole log.
function localRoutes (t, records, items = []) {
  const { createPagesRoutes } = require('../lib/account/pages-routes')
  const owner = member()
  const page = hex(crypto.keyPair().publicKey)
  const assoc = generateAssociationKeyPair()
  const association = hex(assoc.publicKey)
  const issuer = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuer.publicKey) }, assoc)
  const raw = [{ seq: 0, record: null }, ...records.map((record, i) => ({ seq: i + 1, record }))]
  const row = { owner: owner.hex, admins: [], invites: {}, movedTo: null, closed: null, paused: false, gen: 1, length: raw.length, rosterSeq: 0 }
  const state = { spent: null, lost: false, closed: null }
  class Refusal extends Error {
    constructor (token, status = 400) {
      super(token)
      this.token = token
      this.status = status
    }
  }
  const writer = {
    readEntries: async () => applyDeletes(raw),
    readOwn: async (_, { required = false } = {}) => {
      if (state.lost && required) throw Object.assign(new Error('fechado'), { code: 'fechado' })
      return state.lost ? [] : raw
    },
    nonceRecord: () => null,
    info: () => ({ length: raw.length, paused: state.lost }),
    items: () => items,
    follows: () => [],
    engagement: async () => ({ liked: new Set(), reposted: new Map() }),
    append: async (_, records) => {
      for (const record of records) raw.push({ seq: raw.length, record })
      return { seq: raw.length - 1, length: raw.length, pushed: false }
    },
    closePage: async (_, plan) => {
      state.closed = plan
      return { length: raw.length + plan.deletes.length + 1, pushed: false }
    }
  }
  const routes = createPagesRoutes({
    association,
    origin: ORIGIN,
    issuerKeyPair: issuer,
    issuerCert,
    keys: { enabled: true },
    writer,
    store: { status: () => ({ linked: true }), closePage: async () => {} },
    pagesStore: { role: (_, who) => who === owner.hex ? 'owner' : null, charge: async () => {}, get: () => row, spent: () => state.spent, expectLength: async () => {}, close: async () => {} },
    termsStore: { available: () => true, list: () => [{ version: TERMS_VERSION }] },
    http: {
      RouteError: Refusal,
      refuse: (token) => new Refusal(token),
      fromStore: (e) => e,
      keyedWindow: () => () => true,
      checkPost: () => {},
      readJsonBody: async (req) => req.body,
      send: (res, status, body) => Object.assign(res, { status, body }),
      sendError: (res, err) => Object.assign(res, { status: err.status, body: { error: err.token } })
    }
  })
  t.teardown(() => routes.close())
  async function api (action, body) {
    const res = { setHeader: () => {} }
    await routes.handle({ method: 'POST', body }, res, { pathname: '/account/pages/' + action })
    return res.body
  }
  async function act (action, op) {
    const { nonce } = await api('start', { member: owner.hex, action })
    if (action === 'close') {
      const f = { page, gen: 2, at: new Date().toISOString(), nonce, actor: owner.hex, association }
      return api(action, { member: owner.hex, nonce, page, record: { type: 'page-close', ...f, signature: signClose(f, owner.kp) } })
    }
    return api(action, { member: owner.hex, nonce, page, op, signature: signPage({ action, nonce, member: owner.hex, page, association, opHash: opHash(op) }, owner.kp) })
  }
  return { raw, writer, state, act, page }
}

function localImage (start = 1) {
  return { core: 'ab'.repeat(32), mime: 'image/jpeg', start, blocks: 1, bytes: 3000, sha256: 'cd'.repeat(32), width: 1200, height: 630 }
}

test('D-FIX: page delete keeps other covers and covers past its original room', async (t) => {
  const { postRecord } = require('@varanda/core/lib/records')
  const image = localImage()
  const records = [postRecord({ text: 'foto', media: [image] }), postShareRecord({ seq: 1 }), postCoverRecord({ seq: 1, image })]
  const s = localRoutes(t, [...records, postRecord({ text: 'reuso', media: [image] })])
  t.absent((await s.act('delete', { to: s.page + ':4' })).error)
  t.is(s.raw.at(-1).record.media, undefined, 'another post keeps its cover')

  const reused = localRoutes(t, [postRecord({ text: 'um', media: [image] }), postRecord({ text: 'dois', media: [image] })])
  t.absent((await reused.act('delete', { to: reused.page + ':1' })).error)
  t.alike(reused.raw.at(-1).record.media, [rangeOf(image)], 'post-to-post reuse keeps its existing deletion behavior')

  const images = Array.from({ length: 10 }, (_, i) => localImage(i + 1))
  const q = localRoutes(t, [postRecord({ text: 'dez', media: images }), ...Array.from({ length: 6 }, () => postCoverRecord({ seq: 1, image }))])
  t.absent((await q.act('delete', { to: q.page + ':1' })).error)
  const tombs = q.raw.filter((e) => e.record && e.record.type === 'delete')
  t.alike(tombs.filter((e) => e.record.seq !== 1).map((e) => e.record.seq), [2, 3, 4, 5, 6], 'room uses the original three post tombstones')
  t.ok(tombs.every((e) => !(e.record.media || []).some((r) => r.start === 1)), 'the cover past the room keeps its range')
})

test('D-FIX: page close assigns shared ranges to the last tombstone', async (t) => {
  const { postRecord } = require('@varanda/core/lib/records')
  const image = localImage()
  const s = localRoutes(t, [postRecord({ text: 'foto', media: [image] }), ...Array.from({ length: 9 }, () => postCoverRecord({ seq: 1, image }))])
  t.absent((await s.act('close')).error)
  t.ok(s.state.closed, 'the writer received the close plan')
  t.alike(s.state.closed.deletes.filter((r) => r.media).map((r) => [r.seq, r.media]), [[10, [rangeOf(image)]]], 'the first batch cannot free the last cover')
})

test('D-FIX: cleanup replay skips holes and deleted newer covers', async (t) => {
  const { postRecord, deleteRecord } = require('@varanda/core/lib/records')
  const image = localImage()
  const records = [postRecord({ text: 'foto', media: [image] }), postCoverRecord({ seq: 1, image }), postCoverRecord({ seq: 1, image }), null, postCoverRecord({ seq: 1, image }), deleteRecord({ seq: 2 }), deleteRecord({ seq: 5 })]
  const s = localRoutes(t, records)
  s.state.spent = 6
  t.alike(await s.act('post-cover', { seq: 1, image }), { coverSeq: 3, created: false, replay: true }, 'the newest live cover below the cleanup')
  s.raw[5].record = null
  delete s.raw[4]
  t.alike(await s.act('post-cover', { seq: 1, image }), { coverSeq: 3, created: false, replay: true }, 'cleared and missing blocks do not hide it')
  s.raw[3].record = null
  t.is((await s.act('post-cover', { seq: 1, image })).error, 'pedido-invalido', 'no surviving cover')
})

test('D-FIX: page cover decisions require a reliable own read', async (t) => {
  const { postRecord, deleteRecord } = require('@varanda/core/lib/records')
  const image = localImage()
  for (const deleted of [false, true]) {
    const s = localRoutes(t, [postRecord({ text: 'foto', media: [image] }), postCoverRecord({ seq: 1, image }), ...(deleted ? [deleteRecord({ seq: 1 })] : [])])
    s.state.lost = true
    t.is((await s.act('delete', { to: s.page + ':1' })).error, 'indisponivel', 'a lost read never means no covers')
    t.is(s.raw.length, deleted ? 4 : 3, 'nothing appended')
    t.is((await s.act('post-cover', { seq: 1, image })).error, 'indisponivel')
    s.state.spent = 3
    t.is((await s.act('post-cover', { seq: 1, image })).error, 'indisponivel', 'replay also needs the read')
  }
})

test('D-FIX: page cover refuses a text-only shared post', async (t) => {
  const { postRecord } = require('@varanda/core/lib/records')
  const image = localImage()
  const s = localRoutes(t, [postRecord({ text: 'texto' }), postShareRecord({ seq: 1 }), postCoverRecord({ seq: 1, image })], [image])
  t.is((await s.act('post-cover', { seq: 1, image })).error, 'pedido-invalido')
  t.is(s.raw.length, 4, 'nothing appended')
})

test('D-FIX: the real writer refuses required own reads after state loss', async (t) => {
  const Hypercore = require('hypercore')
  const { postRecord } = require('@varanda/core/lib/records')
  const dir = tmpDir(t, 'varanda-own-read-')
  const kp = crypto.keyPair()
  const key = hex(kp.publicKey)
  const core = new Hypercore(path.join(dir, 'pages-store', key), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await core.ready()
  await core.append(postRecord({ text: 'fixture' }))
  await core.close()
  // No state file exists for this fixture's stored core.
  const writer = createPagesWriter({ dir, keys: { enabled: true, get: () => ({}) }, association: hex(generateAssociationKeyPair().publicKey) })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  t.alike(await writer.readOwn(key), [], 'display callers keep the legacy empty view')
  await t.exception(writer.readOwn(key, { required: true }), { code: 'fechado' })
})

test('page status uncovered: source, cap, cover, unshare and delete', async (t) => {
  const { postRecord, deleteRecord } = require('@varanda/core/lib/records')
  const image = { ...localImage(), mime: 'image/avif' }
  const s = localRoutes(t, [
    postRecord({ text: 'foto', media: [image] }), postShareRecord({ seq: 1 }),
    postRecord({ text: 'jpeg', media: [localImage()] }), postShareRecord({ seq: 3 }),
    postRecord({ text: 'texto' }), postShareRecord({ seq: 5 }),
    postRecord({ text: 'privada', media: [image] })
  ])
  const status = () => s.act('status', {})
  const first = await status()
  t.absent(first.error, JSON.stringify(first))
  t.alike(first.uncovered, [{ seq: 1, image }])
  t.alike(first.shared, [1, 3, 5])
  t.alike(first.covered, [])
  const before = s.raw.length
  await status()
  t.is(s.raw.length, before, 'status appends nothing')
  await s.writer.append(s.page, [postCoverRecord({ seq: 1, image: localImage(2) })])
  t.alike((await status()).uncovered, [], 'covered')
  await s.writer.append(s.page, [deleteRecord({ seq: before })])
  t.alike((await status()).uncovered, [{ seq: 1, image }], 'cover deleted')
  t.is((await s.act('post-unshare', { seq: 1 })).changed, true)
  t.alike((await status()).uncovered, [], 'unshared')
  await s.writer.append(s.page, [postShareRecord({ seq: 1 })])
  t.alike((await status()).uncovered, [{ seq: 1, image }])
  await s.writer.append(s.page, [deleteRecord({ seq: 1 })])
  t.alike((await status()).uncovered, [], 'post deleted')
  const expected = []
  for (let i = 0; i < 9; i++) {
    const seq = s.raw.length
    await s.writer.append(s.page, [postRecord({ text: 'foto', media: [image] }), postShareRecord({ seq })])
    expected.push({ seq, image })
  }
  t.alike((await status()).uncovered, expected.slice(0, 8), 'eight ascending descriptors')
})
