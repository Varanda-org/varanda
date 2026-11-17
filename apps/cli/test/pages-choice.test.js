'use strict'

// A hosted page's poll and event posts and its votes and RSVPs ('choice'),
// the same records a person writes (apps/cli/lib/account/pages-routes.js
// post, choice, status and close; pages-writer.js DELETABLE), end to end
// over loopback with the same account service and real pages writer as
// pages-media.test.js.

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
const { postRecord, choiceRecord, validateRecord } = require('@varanda/core/lib/records')
const { livePick } = require('@varanda/core/lib/polls')
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

let subSeq = 300
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

async function status (s, m, page) {
  const r = await s.act(m, 'status', page, {})
  if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body))
  return r.body
}

const EVENT = { title: 'Feira de trocas', start: '2026-12-05T13:00:00.000Z', end: '2026-12-05T17:00:00.000Z', place: 'Praça da Matriz' }

test('page polls and events: posts, refusals, votes, status and close, the records a person writes', async (t) => {
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

  // A poll post and an event post: the same record a person's post.create
  // writes for the same input.
  const poll = await s.act(ana, 'post', K, { text: 'Qual pão amanhã?', poll: ['Francês', 'Integral', 'Broa'] })
  t.is(poll.status, 200, JSON.stringify(poll.body))
  let rec = await recordAt(ctx, K, poll.body.seq)
  t.alike(rec, postRecord({ text: 'Qual pão amanhã?', poll: ['Francês', 'Integral', 'Broa'], at: rec.at }))
  t.is(validateRecord(rec, poll.body.seq), null)
  const event = await s.act(ana, 'post', K, { text: 'Venham!', event: EVENT })
  t.is(event.status, 200, JSON.stringify(event.body))
  rec = await recordAt(ctx, K, event.body.seq)
  t.alike(rec, postRecord({ text: 'Venham!', event: EVENT, at: rec.at }))
  t.is(validateRecord(rec, event.body.seq), null)
  const noEnd = await s.act(ana, 'post', K, { text: 'Sem hora para acabar', event: { ...EVENT, end: null, place: '' } })
  t.is(noEnd.status, 200, JSON.stringify(noEnd.body))
  const plain = await s.act(ana, 'post', K, { text: 'Bom dia' })
  t.is(plain.status, 200, JSON.stringify(plain.body))

  // Refusals append nothing.
  const term = BLOCKED_TERMS[0]
  const media = [{ core: 'ab'.repeat(32), start: 0, blocks: 1, sha256: 'cd'.repeat(32), mime: 'image/jpeg', width: 10, height: 10, bytes: 100 }]
  let length = ctx.writer.info(K).length
  const refusals = [
    [{ text: 'x', poll: ['Sim', term] }, 'termo-recusado', 'a blocked term in an option'],
    [{ text: term, poll: ['Sim', 'Não'] }, 'termo-recusado', 'a blocked term in the poll text'],
    [{ text: 'x', event: { ...EVENT, title: term } }, 'termo-recusado', 'a blocked term in the event title'],
    [{ text: 'x', event: { ...EVENT, place: 'Rua ' + term } }, 'termo-recusado', 'a blocked term in the event place'],
    [{ text: term, event: EVENT }, 'termo-recusado', 'a blocked term in the event text'],
    [{ text: 'x', poll: ['Sim', 'Não'], media }, 'pedido-invalido', 'a poll and media'],
    [{ text: 'x', poll: ['Sim', 'Não'], preview: { url: 'https://example.com/' } }, 'pedido-invalido', 'a poll and a card'],
    [{ text: 'x', event: EVENT, media }, 'pedido-invalido', 'an event and media'],
    [{ text: 'x', event: EVENT, preview: { url: 'https://example.com/' } }, 'pedido-invalido', 'an event and a card'],
    [{ text: 'x', poll: ['Sim', 'Não'], event: EVENT }, 'pedido-invalido', 'a poll and an event'],
    [{ text: 'x', poll: null }, 'pedido-invalido', 'a null poll'],
    [{ text: 'x', event: null }, 'pedido-invalido', 'a null event'],
    [{ text: 'x', poll: ['Sim'] }, 'pedido-invalido', 'one option'],
    [{ text: 'x', poll: ['A', 'B', 'C', 'D', 'E'] }, 'pedido-invalido', 'five options'],
    [{ text: 'x', poll: ['Sim', ' Sim'] }, 'pedido-invalido', 'the same option twice'],
    [{ text: 'x', poll: ['Sim', 'a'.repeat(81)] }, 'pedido-invalido', 'an option past the cap'],
    [{ text: 'x', poll: 'Sim,Não' }, 'pedido-invalido', 'a poll that is not a list'],
    [{ text: '', poll: ['Sim', 'Não'] }, 'pedido-invalido', 'a poll without text'],
    [{ text: 'x', event: { ...EVENT, end: EVENT.start } }, 'pedido-invalido', 'an end not after the start'],
    [{ text: 'x', event: { ...EVENT, extra: 1 } }, 'pedido-invalido', 'an unknown event key'],
    [{ text: 'x', event: 'amanhã' }, 'pedido-invalido', 'an event that is not an object']
  ]
  for (const [op, error, name] of refusals) {
    const r = await s.act(ana, 'post', K, op)
    t.is(r.body.error, error, name)
  }
  const replyPoll = await s.act(ana, 'reply', K, { to: K + ':' + plain.body.seq, text: 'x', poll: ['Sim', 'Não'] })
  t.is(replyPoll.body.error, 'pedido-invalido', 'a reply never carries a poll')
  const quoteEvent = await s.act(ana, 'quote', K, { to: K + ':' + plain.body.seq, text: 'x', event: EVENT })
  t.is(quoteEvent.body.error, 'pedido-invalido', 'a quote never carries an event')
  t.is(ctx.writer.info(K).length, length, 'no refusal appends')

  // A vote, a changed vote and a withdrawal: each the record a person's
  // choice.set writes.
  const pollRef = { author: K, seq: poll.body.seq }
  const pollTo = K + ':' + poll.body.seq
  const v1 = await s.act(ana, 'choice', K, { to: pollTo, pick: 0 })
  t.is(v1.status, 200, JSON.stringify(v1.body))
  rec = await recordAt(ctx, K, v1.body.seq)
  t.alike(rec, choiceRecord({ to: pollRef, pick: 0, at: rec.at }), 'the person\'s choice record')
  t.is(validateRecord(rec, v1.body.seq), null)
  t.alike((await status(s, ana, K)).picked, { [pollTo]: [0] }, 'status shows the pick')
  const v2 = await s.act(ana, 'choice', K, { to: pollTo, pick: 2 })
  t.is(v2.status, 200, JSON.stringify(v2.body))
  t.alike((await status(s, ana, K)).picked, { [pollTo]: [2, 0] }, 'the last pick first, the earlier one kept')
  const eventTo = K + ':' + event.body.seq
  const rsvp = await s.act(ana, 'choice', K, { to: eventTo, pick: 1 })
  t.is(rsvp.status, 200, JSON.stringify(rsvp.body))
  rec = await recordAt(ctx, K, rsvp.body.seq)
  t.alike(rec, choiceRecord({ to: { author: K, seq: event.body.seq }, pick: 1, at: rec.at }), 'an RSVP is a choice')
  t.alike((await status(s, ana, K)).picked, { [pollTo]: [2, 0], [eventTo]: [1] })
  const cleared = await s.act(ana, 'choice', K, { to: pollTo, pick: null })
  t.is(cleared.status, 200, JSON.stringify(cleared.body))
  rec = await recordAt(ctx, K, cleared.body.seq)
  t.alike(rec, choiceRecord({ to: pollRef, pick: null, at: rec.at }))
  t.alike((await status(s, ana, K)).picked, { [eventTo]: [1] }, 'a withdrawal clears the history')
  t.is(livePick({ entries: await ctx.writer.readEntries(K), poll: pollRef, count: 3 }), null, 'a reader sees no vote')
  const again = await s.act(ana, 'choice', K, { to: pollTo, pick: 1 })
  t.is(again.status, 200, JSON.stringify(again.body))
  t.is(livePick({ entries: await ctx.writer.readEntries(K), poll: pollRef, count: 3 }).pick, 1, 'a reader folds the page vote')

  // A vote on another diary's post: only its shape is checked here (the
  // service cannot read that diary).
  const foreignTo = other.page + ':3'
  const foreign = await s.act(ana, 'choice', K, { to: foreignTo, pick: 0 })
  t.is(foreign.status, 200, JSON.stringify(foreign.body))
  // Then a pick that post may not have: on a 2-option poll readers skip the
  // 3 and keep the 0, so status hands back both and the app folds the same.
  const past = await s.act(ana, 'choice', K, { to: foreignTo, pick: 3 })
  t.is(past.status, 200, JSON.stringify(past.body))
  const foreignPoll = { author: other.page, seq: 3 }
  t.is(livePick({ entries: await ctx.writer.readEntries(K), poll: foreignPoll, count: 2 }).pick, 0, 'a reader of a 2-option poll counts 0')
  const st = await status(s, ana, K)
  t.alike(st.picked[foreignTo], [3, 0], 'status lists both, newest first')

  // Choice refusals append nothing.
  length = ctx.writer.info(K).length
  const choiceRefusals = [
    [{ to: pollTo, pick: 3 }, 'an option the poll does not have'],
    [{ to: eventTo, pick: 2 }, 'an RSVP past talvez'],
    [{ to: K + ':' + plain.body.seq, pick: 0 }, 'a post that is no poll'],
    [{ to: K + ':' + (length + 5), pick: 0 }, 'a block the page does not have'],
    [{ to: foreignTo, pick: 4 }, 'a pick past POLL_MAX'],
    [{ to: foreignTo, pick: -1 }, 'a negative pick'],
    [{ to: foreignTo, pick: '1' }, 'a pick that is not a number'],
    [{ to: foreignTo }, 'no pick'],
    [{ to: other.page + ':0', pick: 0 }, 'block 0'],
    [{ to: 'nada', pick: 0 }, 'a bad ref'],
    [{ to: pollTo, pick: 0, on: true }, 'an unknown key']
  ]
  for (const [op, name] of choiceRefusals) {
    const r = await s.act(ana, 'choice', K, op)
    t.is(r.body.error, 'pedido-invalido', name)
  }
  const stranger = await s.act(caio, 'choice', K, { to: pollTo, pick: 0 })
  t.is(stranger.body.error, 'sem-permissao', 'a member who is not an admin')
  const strangerStatus = await s.act(caio, 'status', K, {})
  t.is(strangerStatus.body.error, 'sem-permissao', 'nor reads its picks')
  const delChoice = await s.act(ana, 'delete', K, { to: K + ':' + again.body.seq })
  t.is(delChoice.body.error, 'pedido-invalido', 'a choice is withdrawn, never deleted, as a person\'s')
  t.is(ctx.writer.info(K).length, length, 'no refusal appends')

  // Closing tombstones every choice, the withdrawal included, so no earlier
  // vote comes back.
  const closed = await s.close(ana, K)
  t.is(closed.status, 200, JSON.stringify(closed.body))
  const dels = await deletedSeqs(ctx, K)
  for (const seq of [v1.body.seq, v2.body.seq, rsvp.body.seq, cleared.body.seq, again.body.seq, foreign.body.seq, past.body.seq]) {
    t.ok(dels.includes(seq), 'close tombstones choice ' + seq)
  }
  t.is(livePick({ entries: await ctx.writer.readEntries(K), poll: pollRef, count: 3 }), null, 'no vote survives the close')
})
