'use strict'

// apps/cli/lib/account/feira-routes.js mounted by server.js, the Feira store
// behind apps/cli/lib/account/invites-pair.js, the
// VARANDA_FEIRA_INVITES_PER_WEEK checks of apps/cli/lib/commands/account.js
// and the Excluir conta sweep (apps/cli/lib/account/deletion.js). Loopback
// only: a fake Google and a fake listing reader, random keys, a temporary
// data dir.

const test = require('brittle')
const http = require('node:http')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore } = require('../lib/account/store')
const { openInvitesStore, inviteId, CODE_RE } = require('../lib/account/invites-store')
const { pairInvites } = require('../lib/account/invites-pair')
const { createDeletionSweep } = require('../lib/account/deletion')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { readEnv } = require('../lib/commands/account')
const { UsageError } = require('../lib/cli')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
const EMAIL = 'membro@example.test'
const TOKEN = 'c3'.repeat(32)
const ENV = {
  VARANDA_PUBLIC_ORIGIN: ORIGIN,
  VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID,
  VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET
}
const FEIRA_OPTS = { file: 'feira-invites.json', ttlMs: 3600 * 1000, capOn: 'use', maxRows: 20000, pruneUnused: true }

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function idToken (sub) {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, exp: Math.floor(Date.now() / 1000) + 3600 }
  return b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(payload) + '.c2ln'
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function fakeGoogle (t) {
  const account = { sub: '1000000000000000000001', email: EMAIL }
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      if (pathname === '/token') return json(res, 200, { access_token: 'ya29.x', token_type: 'Bearer', expires_in: 3599, id_token: idToken(account.sub) })
      if (pathname === '/userinfo') return json(res, 200, { sub: account.sub, email: account.email, email_verified: true })
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  return { account, endpoints: { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' } }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

let subSeq = 100
function nextSub () {
  return '30000000000000000' + String(subSeq++).padStart(5, '0')
}

async function linkDirect (s, m, username) {
  const row = s.store.start({ member: m.hex, username })
  s.store.reserve(row.id)
  s.store.putGoogle(row.id, { sub: nextSub(), email: EMAIL })
  await s.store.finish(row.id, { signature: 'a'.repeat(128) }, s.iss.keyPair, s.iss.cert, s.iss.association)
}

// `feira: false` passes no Feira store; `reader: false` no listing reader.
// `listings` maps 'author/seq' to what readListing answers; `pages` maps a
// page key to its pages-store row.
async function setup (t, { feira = true, reader = true, perWeek = 3 } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const fake = await fakeGoogle(t)
  const google = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: fake.endpoints })
  const store = openAccountStore(dir)
  const primary = openInvitesStore(dir, { perWeek: 2, isUsed: (id) => store.inviteUsed(id) })
  const feiraStore = feira ? openInvitesStore(dir, { ...FEIRA_OPTS, perWeek, isUsed: (id) => store.inviteUsed(id) }) : null
  const invites = pairInvites(primary, feiraStore)
  const listings = new Map()
  const reads = []
  const listingReader = reader
    ? { readListing: async (author, seq) => { reads.push([author, seq]); return listings.get(author + '/' + seq) ?? 'ausente' }, readCurrent: async () => 'ausente' }
    : null
  const pages = new Map()
  const pagesStore = { get: (k) => pages.get(k) ?? null, ownedCount: () => 0, listFor: () => [] }
  const logs = []
  const texts = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    invites,
    feiraInvites: feiraStore,
    listingReader,
    pages: { pagesStore },
    log: (e) => logs.push(JSON.stringify(e))
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function api (method, pathname, { body, cookie } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = COOKIE + '=' + cookie
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    texts.push(text)
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  return { dir, iss, fake, store, primary, feiraStore, invites, listings, reads, pages, logs, texts, api }
}

function listingOf (author, seq) {
  return { record: { type: 'listing', kind: 'produto', title: 'Bicicleta' }, author, seq }
}

function cookieOf (res) {
  const m = /^__Host-varanda-link=([A-Za-z0-9_-]+);/.exec(res.headers.get('set-cookie') || '')
  return m ? m[1] : null
}

function sign (s, m, phase, nonce, username, sub = '') {
  return signAccountLink({ phase, nonce, member: m.hex, username, association: s.iss.association, sub }, m.kp)
}

function startWith (s, m, username, invite) {
  return s.api('POST', '/account/start', { body: { member: m.hex, username, invite } })
}

async function linkWith (s, m, username, code) {
  const started = await startWith(s, m, username, code)
  if (started.status !== 200) return { started }
  const cookie = cookieOf(started)
  const auth = await s.api('POST', '/account/authorize', { cookie, body: { signature: sign(s, m, 'reserve', started.body.nonce, username) } })
  const state = new URL(auth.body.authorizeUrl).searchParams.get('state')
  s.fake.account.sub = nextSub()
  await s.api('GET', '/account/callback?state=' + state + '&code=codigo-1', { cookie })
  const pending = await s.api('GET', '/account/pending', { cookie })
  const done = await s.api('POST', '/account/finish', { cookie, body: { signature: sign(s, m, 'finish', pending.body.nonce, username, pending.body.sub) } })
  return { started, done }
}

function feiraStart (s, author, seq) {
  return s.api('POST', '/account/feira/start', { body: { author, seq } })
}

test('policy: off by default, off without the listing reader, on with both', async (t) => {
  const off = await setup(t, { feira: false })
  t.alike((await off.api('GET', '/account/feira/policy')).body, { enabled: false })
  const st = await feiraStart(off, member().hex, 1)
  t.is(st.status, 404)
  t.alike(st.body, { error: 'nao-encontrado' })

  const tokenless = await setup(t, { reader: false })
  t.alike((await tokenless.api('GET', '/account/feira/policy')).body, { enabled: false }, 'no triage token: no reader, off')
  t.is((await feiraStart(tokenless, member().hex, 1)).status, 404)

  const on = await setup(t)
  const policy = await on.api('GET', '/account/feira/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { enabled: true })
})

test('readEnv: VARANDA_FEIRA_INVITES_PER_WEEK needs the member invites and the triage token', (t) => {
  const full = { ...ENV, VARANDA_INVITES_PER_WEEK: '2', VARANDA_TRIAGE_TOKEN: TOKEN, VARANDA_FEIRA_INVITES_PER_WEEK: '10' }
  t.is(readEnv(full).limits.feiraInvitesPerWeek, 10)
  t.absent('feiraInvitesPerWeek' in readEnv({ ...full, VARANDA_FEIRA_INVITES_PER_WEEK: '' }).limits, 'empty: off')

  const cases = [
    [{ ...full, VARANDA_INVITES_PER_WEEK: undefined }, 'VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_INVITES_PER_WEEK'],
    [{ ...full, VARANDA_TRIAGE_TOKEN: undefined }, 'VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_TRIAGE_TOKEN'],
    [{ ...full, VARANDA_TRIAGE_TOKEN: '' }, 'VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_TRIAGE_TOKEN'],
    [{ ...full, VARANDA_TRIAGE_TOKEN: 'curto' }, 'VARANDA_TRIAGE_TOKEN inválido'],
    [{ ...full, VARANDA_FEIRA_INVITES_PER_WEEK: '0' }, 'VARANDA_FEIRA_INVITES_PER_WEEK inválido'],
    [{ ...full, VARANDA_FEIRA_INVITES_PER_WEEK: '101' }, 'VARANDA_FEIRA_INVITES_PER_WEEK inválido']
  ]
  for (const [env, message] of cases) {
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
    try {
      readEnv(env)
      t.fail(message + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, message)
      t.is(err.message, message)
      t.absent(err.message.includes(TOKEN), 'the token is never in the message')
    }
  }
})

test('start: a person and a page listing, both charged to the owner; 404 for a post', async (t) => {
  const s = await setup(t)
  const seller = member()
  await linkDirect(s, seller, 'ana')
  s.listings.set(seller.hex + '/3', listingOf(seller.hex, 3))

  const person = await feiraStart(s, seller.hex, 3)
  t.is(person.status, 200, person.text)
  t.alike(Object.keys(person.body), ['code'])
  t.ok(CODE_RE.test(person.body.code))
  t.ok(s.feiraStore.holds(seller.hex), 'the row is charged to the seller')
  t.is(s.feiraStore.count().total, 1)
  t.is(s.primary.count().total, 0, 'no member invite is spent')

  const owner = member()
  await linkDirect(s, owner, 'bia')
  const page = member().hex
  s.pages.set(page, { owner: owner.hex, closed: null })
  s.listings.set(page + '/2', listingOf(page, 2))
  const fromPage = await feiraStart(s, page, 2)
  t.is(fromPage.status, 200, fromPage.text)
  t.ok(s.feiraStore.holds(owner.hex), 'the page owner pays')
  t.absent(s.feiraStore.holds(page), 'never the page key')

  s.pages.set(page, { owner: owner.hex, closed: '2026-11-01T00:00:00.000Z' })
  const readsBefore = s.reads.length
  t.is((await feiraStart(s, page, 2)).status, 404, 'a closed page has no owner')

  const stranger = member().hex
  s.listings.set(stranger + '/1', listingOf(stranger, 1))
  t.is((await feiraStart(s, stranger, 1)).status, 404, 'an unlinked author without a page')
  t.is(s.reads.length, readsBefore, 'no owner, no seeder read')

  const post = await feiraStart(s, seller.hex, 4)
  t.is(post.status, 404)
  t.alike(post.body, { error: 'nao-encontrado' })
  s.listings.set(seller.hex + '/5', 'nao-e-anuncio')
  t.is((await feiraStart(s, seller.hex, 5)).status, 404, 'a post or edit seq')

  // A sold listing still opens the door: the route never asks for a status.
  s.listings.set(seller.hex + '/6', { ...listingOf(seller.hex, 6), status: 'vendido' })
  t.is((await feiraStart(s, seller.hex, 6)).status, 200, 'vendido accepted')

  for (const bad of [{ author: seller.hex }, { author: seller.hex, seq: 0 }, { author: seller.hex.toUpperCase(), seq: 3 }, { author: seller.hex, seq: 3, x: 1 }, { author: seller.hex, seq: '3' }]) {
    t.is((await s.api('POST', '/account/feira/start', { body: bad })).status, 400, JSON.stringify(Object.keys(bad)))
  }

  const all = s.logs.join('\n')
  for (const line of s.logs) t.alike(Object.keys(JSON.parse(line)).sort(), ['event', 'reason'], 'event and reason only')
  t.absent(all.includes(person.body.code), 'no code in the logs')
  t.absent(all.includes(seller.hex) || all.includes(page) || all.includes(owner.hex), 'no key in the logs')
})

test('start: the owner is resolved before the seeder read, and no window is keyed by the owner', async (t) => {
  const s = await setup(t, { perWeek: 100 })
  const seller = member()
  await linkDirect(s, seller, 'ana')

  // Junk refs of unknown authors never reach the seeder.
  for (let i = 0; i < 20; i++) {
    const junk = member().hex
    t.is((await feiraStart(s, junk, 1)).status, 404)
  }
  t.is(s.reads.length, 0, 'no seeder read for an unknown owner')

  // Anyone may ask many starts for one owner: nothing locks the owner out.
  for (let seq = 1; seq <= 15; seq++) s.listings.set(seller.hex + '/' + seq, listingOf(seller.hex, seq))
  for (let seq = 1; seq <= 15; seq++) t.is((await feiraStart(s, seller.hex, seq)).status, 200, 'start ' + seq)
  t.is(s.reads.length, 15, 'one read per start of a known owner')
})

test('signup: a Feira code passes the invite check and consumes one Feira row, no primary row', async (t) => {
  const s = await setup(t, { perWeek: 1 })
  const seller = member()
  await linkDirect(s, seller, 'ana')
  s.listings.set(seller.hex + '/3', listingOf(seller.hex, 3))
  const a = (await feiraStart(s, seller.hex, 3)).body.code
  const b = (await feiraStart(s, seller.hex, 3)).body.code

  // The same check age-routes runs before a paid age session.
  t.is(s.invites.check(inviteId(a)), null, 'the pair accepts a Feira code')

  const newcomer = member()
  const { done } = await linkWith(s, newcomer, 'carla', a)
  t.is(done.status, 200, done.text)
  t.is(s.store.status(newcomer.hex).linked, true)
  t.is(s.feiraStore.count().used, 1, 'one Feira row used')
  t.alike(s.primary.count(), { total: 0, used: 0 }, 'no primary row')

  const again = await startWith(s, member(), 'dani', a)
  t.is(again.status, 404, 'single use')

  // The weekly cap (1) is reached: the second code is refused at start,
  // before any pending row or member exists.
  const capped = await startWith(s, member(), 'eva', b)
  t.is(capped.status, 404)
  t.alike(capped.body, { error: 'convite-invalido' })
  t.is(cookieOf(capped), null, 'no pending row')
  t.absent(s.logs.join('\n').includes(a) || s.logs.join('\n').includes(b), 'no code in the logs')
})

test('Excluir conta: the sweep forgets the member in both invite files', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const primary = openInvitesStore(dir, { perWeek: 2 })
  const feira = openInvitesStore(dir, { ...FEIRA_OPTS, perWeek: 3 })
  const invites = pairInvites(primary, feira)
  const gone = member().hex
  const kept = member().hex
  await primary.issue(gone)
  await feira.issue(gone)
  await feira.issue(kept)
  t.ok(primary.holds(gone) && feira.holds(gone))

  const logs = []
  const sweep = createDeletionSweep({ accounts: { deletedMembers: () => [gone] }, invites, log: (e) => logs.push(e) })
  const r = await sweep.sweep()
  t.alike(r, { members: 1, pending: 0 })
  t.absent(primary.holds(gone), 'gone from invites.json')
  t.absent(feira.holds(gone), 'gone from feira-invites.json')
  t.ok(feira.holds(kept), 'another owner keeps its codes')
  t.is(logs.length, 0)
})
