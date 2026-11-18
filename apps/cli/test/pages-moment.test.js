'use strict'

// A hosted page's momentos ('moment'), the record a person's moment.create
// writes (apps/cli/lib/account/pages-routes.js moment, delete and close;
// pages-writer.js DELETABLE), end to end over loopback with the same account
// service and real pages writer as pages-choice.test.js. The blob is the
// device's own upload, so the op carries only its public descriptor.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signClose } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { momentRecord, validateRecord } = require('@varanda/core/lib/records')
const { foldMoments } = require('@varanda/core/lib/moments')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { BLOCKED_TERMS } = require('@varanda/rpc')
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

let subSeq = 700
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

  return { ctx, api, newMember, act, create, close }
}

async function recordAt (ctx, page, seq) {
  const e = (await ctx.writer.readEntries(page)).find((x) => x.seq === seq)
  return e ? e.record : null
}

async function deletedSeqs (ctx, page) {
  return (await ctx.writer.readEntries(page)).filter((e) => e.record && e.record.type === 'delete').map((e) => e.record.seq)
}

function momentMedia (over = {}) {
  return { id: 'a'.repeat(64), key: 'b'.repeat(64), nonce: 'c'.repeat(48), chunks: 2, bytes: 40000, sha256: 'd'.repeat(64), mime: 'image/jpeg', w: 1080, h: 1350, ms: 0, ...over }
}

function without (obj, k) {
  const copy = { ...obj }
  delete copy[k]
  return copy
}

const VIDEO = momentMedia({ id: 'e'.repeat(64), mime: 'video/mp4', w: 1080, h: 1920, ms: 15000, bytes: 4194304 + 16, chunks: 129 })
const MUSIC = { p: 'audius', id: 'abc123', start: 30 }

function showing (entries, page) {
  const authors = foldMoments({ logs: [{ key: page, entries }] }).authors
  return authors.length === 0 ? [] : authors[0].items.map((i) => i.seq)
}

test('page momentos: text, media and music, refusals, delete and close, the record a person writes', async (t) => {
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

  // Each the record the person's builder makes for the same input, byte for
  // byte (same keys in the same order), and valid as a person's.
  const cases = [
    [{ text: 'Pão saindo do forno', media: momentMedia() }, 'text and a photo'],
    [{ text: '', media: momentMedia({ id: '1'.repeat(64) }) }, 'a photo alone'],
    [{ text: 'Bom dia', media: VIDEO }, 'a short video'],
    [{ text: 'Com trilha', media: momentMedia({ id: '2'.repeat(64) }), music: MUSIC }, 'with music']
  ]
  const seqs = []
  for (const [op, name] of cases) {
    const r = await s.act(ana, 'moment', K, op)
    t.is(r.status, 200, name + ' ' + JSON.stringify(r.body))
    const rec = await recordAt(ctx, K, r.body.seq)
    const person = momentRecord({ text: op.text, media: op.media, music: op.music === undefined ? null : op.music, at: rec.at })
    t.alike(rec, person, name + ': the person\'s record')
    t.is(JSON.stringify(rec), JSON.stringify(person), name + ': byte for byte')
    t.is(validateRecord(rec, r.body.seq), null, name + ': valid')
    seqs.push(r.body.seq)
  }
  t.absent('music' in (await recordAt(ctx, K, seqs[0])), 'no music key without music')
  t.alike((await recordAt(ctx, K, seqs[3])).music, MUSIC)
  t.alike(showing(await ctx.writer.readEntries(K), K).sort((a, b) => a - b), seqs, 'a reader shows the page\'s momentos')

  // Refusals append nothing.
  const term = BLOCKED_TERMS[0]
  const length = ctx.writer.info(K).length
  const refusals = [
    [{ text: term, media: momentMedia() }, 'termo-recusado', 'a blocked term in the text'],
    [{ text: 'Promoção ' + term, media: momentMedia() }, 'termo-recusado', 'a blocked term inside the text'],
    [{ text: 'x', media: { ...momentMedia(), extra: 1 } }, 'midia-invalida', 'an unknown media key'],
    [{ text: 'x', media: without(momentMedia(), 'key') }, 'midia-invalida', 'a media key missing'],
    [{ text: 'x', media: momentMedia({ mime: 'image/heic' }) }, 'midia-invalida', 'a mime a momento never takes'],
    [{ text: 'x', media: momentMedia({ ms: 10 }) }, 'midia-invalida', 'a photo with a duration'],
    [{ text: 'x', media: momentMedia({ chunks: 3 }) }, 'midia-invalida', 'chunks that do not match the bytes'],
    [{ text: 'x', media: momentMedia({ id: 'zz' }) }, 'midia-invalida', 'a bad blob id'],
    [{ text: 'x', media: { ...VIDEO, ms: 15001 } }, 'midia-invalida', 'a video past 15 s'],
    [{ text: 'x', media: { ...VIDEO, ms: 0 } }, 'midia-invalida', 'a video without a duration'],
    [{ text: 'x', media: null }, 'midia-invalida', 'a null media'],
    [{ text: 'x', media: [momentMedia()] }, 'midia-invalida', 'a list of media'],
    [{ text: 'x' }, 'pedido-invalido', 'no media'],
    [{ media: momentMedia() }, 'pedido-invalido', 'no text, as a person\'s moment.create'],
    [{ text: 'x', media: momentMedia(), music: null }, 'pedido-invalido', 'a null music'],
    [{ text: 'x', media: momentMedia(), music: { ...MUSIC, p: 'spotify' } }, 'pedido-invalido', 'music from another provider'],
    [{ text: 'x', media: momentMedia(), music: { ...MUSIC, start: 7201 } }, 'pedido-invalido', 'music past its start cap'],
    [{ text: 'x', media: momentMedia(), music: { ...MUSIC, title: 'Canção' } }, 'pedido-invalido', 'music with a title'],
    [{ text: 'x'.repeat(201), media: momentMedia() }, 'pedido-invalido', 'a text past 200'],
    [{ text: 'a\u0007b', media: momentMedia() }, 'pedido-invalido', 'a control character'],
    [{ text: 3, media: momentMedia() }, 'pedido-invalido', 'a text that is not a string'],
    [{ text: 'x', media: momentMedia(), at: '2026-11-17T12:00:00.000Z' }, 'pedido-invalido', 'an at the service sets']
  ]
  for (const [op, error, name] of refusals) {
    const r = await s.act(ana, 'moment', K, op)
    t.is(r.body.error, error, name)
  }
  const stranger = await s.act(caio, 'moment', K, { text: 'oi', media: momentMedia() })
  t.is(stranger.body.error, 'sem-permissao', 'a member who is not an admin')
  t.is(ctx.writer.info(K).length, length, 'no refusal appends')

  // Delete: a tombstone with no media range (the blob expires by itself),
  // as a person's moment.delete; never another page's momento.
  const theirs = await s.act(caio, 'moment', other.page, { text: 'deles', media: momentMedia({ id: '3'.repeat(64) }) })
  t.is(theirs.status, 200, JSON.stringify(theirs.body))
  const cross = await s.act(ana, 'delete', K, { to: other.page + ':' + theirs.body.seq })
  t.is(cross.body.error, 'pedido-invalido', 'another page\'s momento')
  const del = await s.act(ana, 'delete', K, { to: K + ':' + seqs[0] })
  t.is(del.status, 200, JSON.stringify(del.body))
  const tomb = await recordAt(ctx, K, del.body.seq)
  t.is(tomb.type, 'delete')
  t.is(tomb.seq, seqs[0])
  t.absent('media' in tomb, 'no media range')
  t.is(validateRecord(tomb, del.body.seq), null)
  t.absent(showing(await ctx.writer.readEntries(K), K).includes(seqs[0]), 'a reader no longer shows it')
  const strangerDel = await s.act(caio, 'delete', K, { to: K + ':' + seqs[1] })
  t.is(strangerDel.body.error, 'sem-permissao', 'a stranger cannot delete it')

  // A second delete answers the tombstone already there: nothing appended,
  // as a person's moment.delete.
  const before = ctx.writer.info(K).length
  const again = await s.act(ana, 'delete', K, { to: K + ':' + seqs[0] })
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(again.body.seq, del.body.seq, 'the existing tombstone')
  t.is(ctx.writer.info(K).length, before, 'no second tombstone')
  t.is((await deletedSeqs(ctx, K)).filter((x) => x === seqs[0]).length, 1, 'one tombstone for the momento')

  // Closing tombstones every momento still shown.
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  const dels = await deletedSeqs(ctx, K)
  for (const seq of seqs) t.ok(dels.includes(seq), 'close tombstones momento ' + seq)
  t.alike(showing(await ctx.writer.readEntries(K), K), [], 'no momento survives the close')
})

test('page momentos: status lists the page\'s own, live or expired, newest first, only for who holds the page', async (t) => {
  t.timeout(300000)
  const s = await setup(t)
  const { ctx } = s
  const ana = await s.newMember('ana')
  const caio = await s.newMember('caio')
  const made = await s.create(ana, 'quitanda')
  t.is(made.status, 200, JSON.stringify(made.body))
  const K = made.page

  async function status (m) {
    return s.act(m, 'status', K, {})
  }

  const empty = await status(ana)
  t.is(empty.status, 200, JSON.stringify(empty.body))
  t.alike(empty.body.moments, [], 'no momento yet')

  const first = await s.act(ana, 'moment', K, { text: 'Primeiro', media: momentMedia() })
  t.is(first.status, 200, JSON.stringify(first.body))
  // A momento past 24 h: the service always stamps now, so this one goes
  // straight to the writer with a backdated at, and the store is told the
  // new length as the service's own append would.
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const expired = await ctx.writer.append(K, [momentRecord({ text: 'Antigo', media: momentMedia({ id: '4'.repeat(64) }), at: old })])
  await ctx.pagesStore.expectLength(K, ctx.writer.info(K).length)
  const second = await s.act(ana, 'moment', K, { text: 'Segundo', media: VIDEO, music: MUSIC })
  t.is(second.status, 200, JSON.stringify(second.body))
  // Another kind of record is never listed.
  const post = await s.act(ana, 'post', K, { text: 'Uma publicação' })
  t.is(post.status, 200, JSON.stringify(post.body))

  const listed = (await status(ana)).body.moments
  const atOf = async (seq) => (await recordAt(ctx, K, seq)).at
  t.alike(listed, [
    { seq: second.body.seq, at: await atOf(second.body.seq), text: 'Segundo' },
    { seq: expired.seq, at: old, text: 'Antigo' },
    { seq: first.body.seq, at: await atOf(first.body.seq), text: 'Primeiro' }
  ], 'newest first, the expired one too, only seq, at and text')
  t.absent(showing(await ctx.writer.readEntries(K), K).includes(expired.seq), 'a reader no longer shows the expired one')

  // Status stays gated: a member without a role gets no list.
  const refused = await status(caio)
  t.is(refused.body.error, 'sem-permissao', 'a member who is not owner or admin')
  t.absent('moments' in refused.body, 'no list for a stranger')

  // The expired one, deleted through the page delete action, leaves the list.
  const del = await s.act(ana, 'delete', K, { to: K + ':' + expired.seq })
  t.is(del.status, 200, JSON.stringify(del.body))
  t.alike((await status(ana)).body.moments.map((m) => m.seq), [second.body.seq, first.body.seq], 'a deleted momento is not listed')

  // At most 20: the newest kept.
  const batch = []
  for (let i = 0; i < 21; i++) batch.push(momentRecord({ text: 'Lote ' + i, media: momentMedia({ id: (i % 10).toString().repeat(64) }) }))
  const seqsOfBatch = []
  for (let i = 0; i < batch.length; i += 7) {
    const res = await ctx.writer.append(K, batch.slice(i, i + 7))
    for (let j = 6; j >= 0; j--) seqsOfBatch.push(res.seq - j)
  }
  await ctx.pagesStore.expectLength(K, ctx.writer.info(K).length)
  const capped = (await status(ana)).body.moments
  t.is(capped.length, 20, 'capped at 20')
  t.alike(capped.map((m) => m.seq), seqsOfBatch.slice(1).reverse(), 'the 20 newest, newest first')
  t.is(capped[0].text, 'Lote 20')
  t.is(capped[19].text, 'Lote 1')
})
