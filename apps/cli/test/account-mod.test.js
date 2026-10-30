'use strict'

// apps/cli/lib/account/mod-routes.js (mounted by server.js) and the
// `account reports` / `account status` additions of commands/account.js:
// reports signed by a random web key pair (packages/core/lib/report.js), the
// moderators' Google sign-in against a loopback fake provider (as
// account.test.js), the panel API and the operator's signed challenge, pull
// and ack (packages/core/lib/mod-request.js) with an association-certified
// moderator key. No socket leaves 127.0.0.1: the service and the fake
// provider bind loopback, and the spawned CLI never opens a network socket.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { signReport } = require('@varanda/core/lib/report')
const { signAppeal } = require('@varanda/core/lib/appeal')
const { signModRequest, canonicalBody } = require('@varanda/core/lib/mod-request')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { SESSION_COOKIE, LOGIN_COOKIE, PANEL_CSP, parseModEmails } = require('../lib/account/mod-routes')
const { createGroupCheck } = require('../lib/account/group-check')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
// Digit-only subjects: any leak shows as a 16-hex run in a log line.
const SUB_A = '1111111111111111111111'
const SUB_B = '2222222222222222222222'
const SUB_C = '3333333333333333333333'
const SUB_OUT = '4444444444444444444444'
const EMAIL_A = 'ana@example.test'
const EMAIL_B = 'bia@example.test'
const EMAIL_MOD = 'Moderadora@Example.test'
const EMAIL_OUT = 'intrusa@example.test'
const HEX16 = /[0-9a-f]{16}/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

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

// Fake provider on 127.0.0.1 answering both redirect URIs; `account` is what
// the next exchange answers.
async function fakeGoogle (t) {
  const seen = []
  const account = { sub: SUB_C, email: EMAIL_MOD }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      seen.push({ path: pathname, body: Buffer.concat(chunks).toString('utf8') })
      if (pathname === '/token') return json(res, 200, { access_token: 'ya29.teste', token_type: 'Bearer', expires_in: 3599, id_token: idToken(account.sub) })
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
  const endpoints = { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' }
  const fetch = (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
  return { seen, account, endpoints, fetch, tokenCalls: () => seen.filter((r) => r.path === '/token').length }
}

function keys () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association, assoc }
}

async function linkDirect (accounts, iss, m, username, sub, email) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

// Two linked members (ana, bia), carol linked to the moderator's Google
// account, and the service with the panel enabled for EMAIL_MOD unless
// `emails` says otherwise.
// A stand-in for the seeder's public /index/group/<G> route on 127.0.0.1:
// `groups` maps a group key to its writers ({ key, diary }, `signed`
// defaulting to `length`); any other key
// answers the not-served body (kind null).
// The token-gated /moderation-group-post/<W>/<seq> route hands out a
// group-post for any listed writer below its length ('mensagem conferida'),
// unless `state.unread` holds the writer; message reads go to `posts`.
// A group in `state.rootless` lists its writers without any root header
// (kind null); one in `state.unserved` keeps the verified header with
// rootServed false and creator null (root purged or withheld).
async function fakeSeeder (t, groups = {}) {
  const requests = []
  const posts = []
  // Served diaries for /index/groups/<D>; `down` answers 503 there.
  const state = { diaries: new Set(), down: false, unread: new Set(), rootless: new Set(), unserved: new Set() }
  const server = http.createServer((req, res) => {
    const p = /^\/moderation-group-post\/([0-9a-f]{64})\/([0-9]{1,15})$/.exec(req.url)
    if (p !== null) {
      posts.push(req.url)
      const seq = Number(p[2])
      let found = null
      for (const [g, ws] of Object.entries(groups)) {
        for (const w of ws) if (w.key === p[1] && seq < (w.length ?? 10)) found = { group: g, diary: w.diary }
      }
      if (req.headers.authorization !== 'Bearer ' + SEEDER_TOKEN || found === null || state.unread.has(p[1])) return res.writeHead(404).end()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ...found, seq, texto: 'mensagem conferida', resposta: null }))
    }
    requests.push(req.url)
    const d = /^\/index\/groups\/([0-9a-f]{64})$/.exec(req.url)
    if (d !== null) {
      if (state.down) return res.writeHead(503).end()
      if (!state.diaries.has(d[1])) return res.writeHead(404).end()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ groups: [], indexing: false, complete: true }))
    }
    const m = /^\/index\/group\/([0-9a-f]{64})$/.exec(req.url)
    if (m === null) return res.writeHead(404).end()
    const writers = Object.hasOwn(groups, m[1]) ? groups[m[1]].map((w) => ({ length: 10, signed: w.length ?? 10, ...w, seq: 1, left: false })) : []
    const header = Object.hasOwn(groups, m[1]) && !state.rootless.has(m[1])
    const served = header && !state.unserved.has(m[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ kind: header ? 'grupo' : null, visibility: null, join: null, name: header ? 'Horta' : null, creator: served ? writers[0].diary : null, rootServed: served, writers, next: null, indexing: false, complete: true }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  return { requests, posts, groups, state, port: server.address().port, groupCheck: createGroupCheck({ baseUrl: 'http://127.0.0.1:' + server.address().port, token: SEEDER_TOKEN }) }
}
const SEEDER_TOKEN = 'e5'.repeat(32)

async function setup (t, { emails = [EMAIL_MOD.toLowerCase()], panelDir, statsEmails = [], usage = null, triage = null, groupCheck } = {}) {
  const root = tmpDir(t)
  const dir = path.join(root, 'account')
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const fake = await fakeGoogle(t)
  const accounts = openAccountStore(dir, { now: c.now })
  const moderation = openModerationStore(dir, { association: iss.association, now: c.now })
  const ana = keys()
  const bia = keys()
  const carol = keys()
  // Without a seeder under test: the three linked diaries are served, no
  // group is (every 'Bloquear' asks the seeder, linked target or not).
  // `groupCheck: null` leaves the service without any check.
  if (groupCheck === undefined) {
    const served = new Set([ana.hex, bia.hex, carol.hex])
    groupCheck = {
      check: async () => ({ ok: false, code: 'config' }),
      checkDiary: async ({ diary }) => served.has(diary) ? { ok: true } : { ok: false, code: 'ausente' }
    }
  }
  await linkDirect(accounts, iss, ana, 'ana', SUB_A, EMAIL_A)
  await linkDirect(accounts, iss, bia, 'bia', SUB_B, EMAIL_B)
  await linkDirect(accounts, iss, carol, 'carol', SUB_C, EMAIL_MOD)
  const google = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: fake.endpoints, fetch: fake.fetch })
  const googleMod = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/mod/callback', endpoints: fake.endpoints, fetch: fake.fetch })
  if (panelDir === undefined) {
    panelDir = path.join(root, 'panel')
    fs.mkdirSync(panelDir)
  }
  const logs = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store: accounts,
    issuer: null, // unconfigured: the desk works without an issuer (C10)
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now,
    moderation,
    googleMod,
    modEmails: emails,
    statsEmails,
    usage,
    triage,
    groupCheck,
    panelDir
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function api (method, pathname, { body, cookie, origin = ORIGIN, raw } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined || raw !== undefined) {
      if (origin !== null) init.headers.origin = origin
      init.headers['content-type'] = 'application/json'
      init.body = raw !== undefined ? raw : JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  return { root, dir, c, iss, fake, accounts, moderation, logs, api, ana, bia, carol, base, server }
}

function noLeak (t, s) {
  const text = s.logs.join('\n')
  t.absent(text.includes('@'), 'logs: no e-mail')
  for (const sub of [SUB_A, SUB_B, SUB_C, SUB_OUT]) t.absent(text.includes(sub), 'logs: no sub')
  t.absent(HEX16.test(text), 'logs: no 16-hex run')
}

// start + signed report; -> the /account/report response.
async function sendReport (s, reporter, target, { seq = null, reason = 'spam', text = 'texto da denúncia', quote = '', signTarget, writer, group } = {}) {
  const started = await s.api('POST', '/account/report/start', { body: { member: reporter.hex } })
  if (started.status !== 200) return started
  const nonce = started.body.nonce
  const fields = { nonce, member: reporter.hex, association: s.iss.association, target: signTarget || target, seq, reason, text, quote }
  if (writer !== undefined) Object.assign(fields, { writer, group })
  const signature = signReport(fields, reporter.kp)
  const extra = writer === undefined ? {} : { writer, group }
  return s.api('POST', '/account/report', { body: { member: reporter.hex, nonce, target, seq, ...extra, reason, text, quote, signature } })
}

// start + signed appeal; -> the /account/appeal response.
async function sendAppeal (s, member, { text = 'foi um engano', signer = member, claimed } = {}) {
  const started = await s.api('POST', '/account/appeal/start', { body: { member: member.hex } })
  if (started.status !== 200) return started
  const nonce = started.body.nonce
  const signature = signAppeal({ nonce, member: member.hex, association: s.iss.association, text }, signer.kp)
  return s.api('POST', '/account/appeal', { body: { member: member.hex, nonce, text: claimed === undefined ? text : claimed, signature } })
}

// A block of `member` decided by `by` and published in snapshot `seq`.
async function blockAndPublish (s, member, by, seq = 1) {
  const r = await sendReport(s, s.ana.hex === member.hex ? s.bia : s.ana, member.hex)
  const d = await s.moderation.decide(r.body.id, { decision: 'bloquear', by })
  await s.moderation.pull()
  const mod = crypto.keyPair()
  const cert = createModeratorCert({ moderator: b4a.toString(mod.publicKey, 'hex'), date: '2026-10-01T00:00:00.000Z' }, s.iss.assoc)
  const blocked = [...s.moderation.blocked().map((b) => b.member), member.hex]
  const snapshot = createSnapshot({ seq, date: new Date(s.c.now()).toISOString(), blocked }, mod, cert)
  await s.moderation.ack({ changeIds: [d.change.id], snapshot, moderatorCert: cert })
  return r.body.id
}

function cookieFrom (res, name) {
  const all = res.headers.getSetCookie()
  for (const line of all) {
    const m = new RegExp('^' + name + '=([^;]*); Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=(\\d+)$').exec(line)
    if (m) return { value: m[1], maxAge: Number(m[2]) }
  }
  return null
}

// login -> fake Google -> callback; -> { login, cb, session (cookie value | null) }.
async function signIn (s, { sub = SUB_C, email = EMAIL_MOD } = {}) {
  s.fake.account.sub = sub
  s.fake.account.email = email
  const login = await s.api('GET', '/account/mod/login')
  const loginCookie = cookieFrom(login, LOGIN_COOKIE)
  const url = new URL(login.headers.get('location'))
  const state = url.searchParams.get('state')
  const cb = await s.api('GET', '/account/mod/callback?state=' + state + '&code=codigo-1', { cookie: LOGIN_COOKIE + '=' + loginCookie.value })
  const session = cookieFrom(cb, SESSION_COOKIE)
  return { login, loginCookie, url, state, cb, session: session && session.maxAge > 0 ? session.value : null }
}

function sessionCookie (value) {
  return SESSION_COOKIE + '=' + value
}

test('parseModEmails: lowercase, trimmed, de-duplicated, bounded; malformed is null', (t) => {
  t.alike(parseModEmails(undefined), [])
  t.alike(parseModEmails(''), [])
  t.alike(parseModEmails(' B@x.test , a@x.test,,b@X.TEST '), ['a@x.test', 'b@x.test'])
  t.is(parseModEmails('sem-arroba'), null)
  t.is(parseModEmails('a@b@c'), null)
  t.is(parseModEmails('a b@x.test'), null)
  const many = Array.from({ length: 33 }, (_, i) => 'm' + i + '@x.test').join(',')
  t.is(parseModEmails(many), null, 'more than 32')
  t.is(parseModEmails(many.split(',').slice(0, 32).join(',')).length, 32)
})

test('reports: linked start and signed report; unlinked, replay, wrong target, own key, Origin', async (t) => {
  const s = await setup(t)
  const stranger = keys()

  const ok = await sendReport(s, s.ana, s.bia.hex, { seq: 3, reason: 'assedio', quote: 'post\ncitado' })
  t.is(ok.status, 200, ok.text)
  t.alike(Object.keys(ok.body).sort(), ['duplicate', 'id'])
  t.is(ok.body.duplicate, false)
  const rows = s.moderation.list({ status: 'aberta' }).reports
  t.is(rows.length, 1, 'one row')
  t.is(rows[0].reporter, s.ana.hex)
  t.is(rows[0].target, s.bia.hex)
  t.is(rows[0].seq, 3)
  t.is(rows[0].quote, 'post\ncitado')

  const account = await sendReport(s, s.ana, s.carol.hex)
  t.is(account.status, 200, 'an account report (seq null, quote empty)')

  const unlinked = await s.api('POST', '/account/report/start', { body: { member: stranger.hex } })
  t.is(unlinked.status, 403)
  t.alike(unlinked.body, { error: 'nao-vinculado' })

  // A replayed nonce: the first report spent it.
  const started = await s.api('POST', '/account/report/start', { body: { member: s.bia.hex } })
  const fields = { nonce: started.body.nonce, member: s.bia.hex, association: s.iss.association, target: s.ana.hex, seq: null, reason: 'spam', text: '', quote: '' }
  const body = { member: s.bia.hex, nonce: started.body.nonce, target: s.ana.hex, seq: null, reason: 'spam', text: '', quote: '', signature: signReport(fields, s.bia.kp) }
  t.is((await s.api('POST', '/account/report', { body })).status, 200)
  const replay = await s.api('POST', '/account/report', { body })
  t.is(replay.status, 400)
  t.alike(replay.body, { error: 'expirado' })

  // Another member's nonce is refused (and not spent: nothing verified).
  const other = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
  const foreign = await s.api('POST', '/account/report', { body: { ...body, nonce: other.body.nonce } })
  t.alike(foreign.body, { error: 'expirado' })

  const wrong = await sendReport(s, s.ana, s.bia.hex, { signTarget: s.carol.hex })
  t.is(wrong.status, 400)
  t.alike(wrong.body, { error: 'assinatura-invalida' })

  const before = s.moderation.stats().open
  const own = await sendReport(s, s.ana, s.ana.hex, { signTarget: s.bia.hex })
  t.is(own.status, 400)
  t.alike(own.body, { error: 'pedido-invalido' })
  t.is(s.moderation.stats().open, before, 'the own key never reaches the store')

  const start2 = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
  const noOrigin = await s.api('POST', '/account/report', { origin: null, body: { member: s.ana.hex, nonce: start2.body.nonce } })
  t.is(noOrigin.status, 403, 'POST needs the Origin')
  const big = await s.api('POST', '/account/report', { raw: JSON.stringify({ pad: 'x'.repeat(9000) }) })
  t.is(big.status, 413, 'report body capped at 8192')

  const getReport = await s.api('GET', '/account/report')
  t.is(getReport.status, 404, 'no GET of a report')
  noLeak(t, s)
})

test('reports: a group message report is stored with writer and group, listed, never handed to the triage, and can block the group', async (t) => {
  const calls = []
  const triage = {
    onReport: (r) => calls.push(['onReport', r.id]),
    onHumanDecision: (r) => calls.push(['onHumanDecision', r.id]),
    onCancel: () => {},
    onUnblock: () => {},
    suggestionOf: () => null,
    verifiedOf: () => null
  }
  const writer = keys().hex
  const group = keys().hex
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { triage, groupCheck: seeder.groupCheck })
  seeder.groups[group] = [{ key: writer, diary: s.bia.hex }]

  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 1, quote: 'mensagem', writer, group })
  t.is(r.status, 200, r.text)
  t.is(r.body.duplicate, false)
  const row = s.moderation.get(r.body.id)
  t.is(row.writer, writer)
  t.is(row.group, group)
  t.is(row.target, s.bia.hex, 'the target stays the author diary')
  // A diary post at the same seq is another report.
  const diary = await sendReport(s, s.ana, s.bia.hex, { seq: 1, quote: 'mensagem' })
  t.is(diary.body.duplicate, false)
  t.not(diary.body.id, r.body.id)
  for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.alike(calls, [['onReport', diary.body.id]], 'only the diary report reached the triage')

  // A v1 signature never passes for a group report.
  const v1 = await sendReport(s, s.ana, s.bia.hex, { seq: 2, writer, group })
  t.is(v1.status, 200)
  const started = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
  const fields = { nonce: started.body.nonce, member: s.ana.hex, association: s.iss.association, target: s.bia.hex, seq: 3, reason: 'spam', text: '', quote: '' }
  const crossed = await s.api('POST', '/account/report', { body: { ...fields, writer, group, signature: signReport(fields, s.ana.kp) } })
  t.is(crossed.status, 400)
  t.alike(crossed.body, { error: 'assinatura-invalida' })

  for (const [label, extra] of [
    ['writer without seq', { seq: null, writer, group }],
    ['writer without group', { seq: 4, writer }],
    ['group without writer', { seq: 4, group }],
    ['upper-case writer', { seq: 4, writer: writer.toUpperCase(), group }],
    ['group is the target diary', { seq: 4, writer, group: s.bia.hex }],
    ['writer is the target diary', { seq: 4, writer: s.bia.hex, group }]
  ]) {
    const st = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
    const body = { member: s.ana.hex, nonce: st.body.nonce, target: s.bia.hex, reason: 'spam', text: '', quote: '', signature: 'ab'.repeat(64), ...extra }
    const res = await s.api('POST', '/account/report', { body })
    t.is(res.status, 400, label)
    t.alike(res.body, { error: 'pedido-invalido' }, label)
  }

  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const list = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  const listed = list.body.reports.find((x) => x.id === r.body.id)
  t.is(listed.writer, writer)
  t.is(listed.group, group)
  t.is(list.body.reports.find((x) => x.id === diary.body.id).writer, null)

  const badTarget = await s.api('POST', '/account/mod/api/reports/' + diary.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'grupo' } })
  t.alike(badTarget.body, { error: 'pedido-invalido' }, 'grupo only for a group report')
  const decided = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'grupo' } })
  t.is(decided.status, 200, decided.text)
  t.is(decided.body.change.member, group, 'the pending change blocks the group root key')
  noLeak(t, s)
})

test('group block: refused unless the seeder confirms the group and its writer, Bloquear conta too', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const writer = keys().hex
  const group = keys().hex
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const decide = (id, block) => s.api('POST', '/account/mod/api/reports/' + id + '/decide', { cookie, body: { decision: 'bloquear', block } })

  // A diary key passed off as a group (not a served root).
  const fake = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer, group: keys().hex })
  t.is(fake.status, 200, fake.text)
  const info = await s.api('GET', '/account/mod/api/reports/' + fake.body.id + '/grupo', { cookie })
  t.alike(info.body, { confirmed: false, reason: 'ausente' })
  const refused = await decide(fake.body.id, 'grupo')
  t.is(refused.status, 409)
  t.alike(refused.body, { error: 'grupo-nao-confirmado' })
  t.is(s.moderation.get(fake.body.id).status, 'aberta', 'nothing decided')
  t.is(s.moderation.pending().changes.length, 0, 'nothing queued')

  // A served group whose writer belongs to someone else.
  seeder.groups[group] = [{ key: writer, diary: s.ana.hex }]
  const other = await sendReport(s, s.ana, s.bia.hex, { seq: 2, writer, group })
  t.alike((await decide(other.body.id, 'grupo')).body, { error: 'grupo-nao-confirmado' })
  // The quote names bia, but nothing ties the writer to her diary: an
  // account block is refused as well (a group report has no verified read).
  const asAccount = await decide(other.body.id, 'diario')
  t.is(asAccount.status, 409, asAccount.text)
  t.alike(asAccount.body, { error: 'grupo-nao-confirmado' })
  t.alike((await decide(fake.body.id, 'diario')).body, { error: 'grupo-nao-confirmado' }, 'nor for a key that is not a group')
  t.is(s.moderation.pending().changes.length, 0, 'still nothing queued')
  const dropped = await s.api('POST', '/account/mod/api/reports/' + fake.body.id + '/decide', { cookie, body: { decision: 'descartar' } })
  t.is(dropped.status, 200, 'Descartar always works')

  // Confirmed: the writer is listed with the reported diary.
  const w2 = keys().hex
  seeder.groups[group] = [{ key: writer, diary: s.ana.hex }, { key: w2, diary: s.bia.hex }]
  const real = await sendReport(s, s.ana, s.bia.hex, { seq: 3, writer: w2, group })
  const ok = await s.api('GET', '/account/mod/api/reports/' + real.body.id + '/grupo', { cookie })
  t.alike(ok.body, { confirmed: true, root: true, name: 'Horta', creator: s.ana.hex, texto: 'mensagem conferida' })
  const done = await decide(real.body.id, 'grupo')
  t.is(done.status, 200, done.text)
  t.is(done.body.change.member, group)
  t.is(done.body.change.kind, 'grupo')
  const real2 = await sendReport(s, s.ana, s.bia.hex, { seq: 4, writer: w2, group })
  const account = await decide(real2.body.id, 'diario')
  t.is(account.status, 200, account.text)
  t.is(account.body.change.member, s.bia.hex)
  t.is(account.body.change.kind, 'conta')
  const listed = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.alike(listed.body.pending.map((c) => [c.member, c.kind]), [[group, 'grupo'], [s.bia.hex, 'conta']])
  t.ok(seeder.requests.every((u) => /^\/index\/group\/[0-9a-f]{64}$/.test(u)), 'only the public group index was read')
  noLeak(t, s)
})

test('group block: a missing root header still confirms the diary block from the writer row, never the group block', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const writer = keys().hex
  const group = keys().hex
  seeder.groups[group] = [{ key: writer, diary: s.bia.hex }]
  seeder.state.rootless.add(group)
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const decide = (id, block) => s.api('POST', '/account/mod/api/reports/' + id + '/decide', { cookie, body: { decision: 'bloquear', block } })
  const a = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer, group })
  const info = await s.api('GET', '/account/mod/api/reports/' + a.body.id + '/grupo', { cookie })
  t.alike(info.body, { confirmed: true, root: false, name: null, creator: null, texto: 'mensagem conferida' })
  const asGroup = await decide(a.body.id, 'grupo')
  t.is(asGroup.status, 409, asGroup.text)
  t.alike(asGroup.body, { error: 'grupo-nao-confirmado' })
  t.is(s.moderation.get(a.body.id).status, 'aberta', 'nothing decided')
  t.is(s.moderation.pending().changes.length, 0, 'nothing queued')
  const asAccount = await decide(a.body.id, 'diario')
  t.is(asAccount.status, 200, asAccount.text)
  t.is(asAccount.body.change.member, s.bia.hex)
  t.is(asAccount.body.change.kind, 'conta')

  // The verified header kept for a root no longer served: both blocks.
  const w2 = keys().hex
  const g2 = keys().hex
  seeder.groups[g2] = [{ key: w2, diary: s.ana.hex }]
  seeder.state.unserved.add(g2)
  const b = await sendReport(s, s.bia, s.ana.hex, { seq: 1, writer: w2, group: g2 })
  t.alike((await s.api('GET', '/account/mod/api/reports/' + b.body.id + '/grupo', { cookie })).body, { confirmed: true, root: true, name: 'Horta', creator: null, texto: 'mensagem conferida' })
  const g2Block = await decide(b.body.id, 'grupo')
  t.is(g2Block.status, 200, g2Block.text)
  t.is(g2Block.body.change.member, g2)
  t.is(g2Block.body.change.kind, 'grupo')
  const c = await sendReport(s, s.bia, s.ana.hex, { seq: 2, writer: w2, group: g2 })
  const cBlock = await decide(c.body.id, 'diario')
  t.is(cBlock.status, 200, cBlock.text)
  t.is(cBlock.body.change.member, s.ana.hex)
  noLeak(t, s)
})

test('group block: without a group check configured it is refused', async (t) => {
  const s = await setup(t)
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer: keys().hex, group: keys().hex })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  for (const block of ['grupo', 'diario']) {
    const res = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block } })
    t.alike(res.body, { error: 'grupo-nao-confirmado' }, block)
  }
  const info = await s.api('GET', '/account/mod/api/reports/' + r.body.id + '/grupo', { cookie })
  t.alike(info.body, { confirmed: false, reason: 'config' })
  t.is(s.moderation.get(r.body.id).status, 'aberta')
})

test('group block: the reported seq must exist on the writer, or both blocks are refused', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const writer = keys().hex
  const group = keys().hex
  seeder.groups[group] = [{ key: writer, diary: s.bia.hex, length: 3 }]
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const invented = await sendReport(s, s.ana, s.bia.hex, { seq: 3, writer, group })
  const info = await s.api('GET', '/account/mod/api/reports/' + invented.body.id + '/grupo', { cookie })
  t.alike(info.body, { confirmed: false, reason: 'sem-mensagem' })
  for (const block of ['grupo', 'diario']) {
    const res = await s.api('POST', '/account/mod/api/reports/' + invented.body.id + '/decide', { cookie, body: { decision: 'bloquear', block } })
    t.is(res.status, 409, block)
    t.alike(res.body, { error: 'grupo-nao-confirmado' }, block)
  }
  const real = await sendReport(s, s.ana, s.bia.hex, { seq: 2, writer, group })
  const ok = await s.api('POST', '/account/mod/api/reports/' + real.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'diario' } })
  t.is(ok.status, 200, ok.text)
})

test('a report without a group: the target must be a served diary before Bloquear, linked or not', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const block = (id) => s.api('POST', '/account/mod/api/reports/' + id + '/decide', { cookie, body: { decision: 'bloquear' } })
  const ask = (id) => s.api('GET', '/account/mod/api/reports/' + id + '/alvo', { cookie })

  // A group root key named as a diary: the seeder answers 404.
  const root = keys().hex
  seeder.groups[root] = [{ key: keys().hex, diary: s.bia.hex }]
  const asRoot = await sendReport(s, s.ana, root, { seq: 1 })
  t.alike((await ask(asRoot.body.id)).body, { confirmed: false, reason: 'ausente' })
  const refused = await block(asRoot.body.id)
  t.alike(refused.body, { error: 'alvo-nao-confirmado' })
  t.is(s.moderation.get(asRoot.body.id).status, 'aberta')
  t.is(s.moderation.pending().changes.length, 0, 'nothing queued')

  // A transient failure refuses too, is not cached and is asked again.
  const diary = keys().hex
  seeder.state.diaries.add(diary)
  seeder.state.down = true
  const served = await sendReport(s, s.ana, diary, { seq: 1 })
  t.alike((await ask(served.body.id)).body, { confirmed: false, reason: 'recusado' })
  t.alike((await block(served.body.id)).body, { error: 'alvo-nao-confirmado' })
  seeder.state.down = false
  t.alike((await ask(served.body.id)).body, { confirmed: true })
  const ok = await block(served.body.id)
  t.is(ok.status, 200, ok.text)
  t.is(ok.body.change.member, diary)

  // A linked account proves nothing (a creator can link the root key as an
  // account): the seeder is asked all the same.
  const linked = await sendReport(s, s.bia, s.ana.hex, { seq: 1 })
  const before = seeder.requests.length
  t.alike((await block(linked.body.id)).body, { error: 'alvo-nao-confirmado' }, 'a linked key the seeder does not serve as a diary')
  t.is(seeder.requests.length, before + 1, 'the seeder was asked for a linked target')
  t.is(s.moderation.pending().changes.length, 1, 'only the served diary is queued')
  seeder.state.diaries.add(s.bia.hex)
  seeder.state.down = true
  const linked2 = await sendReport(s, s.ana, s.bia.hex, { seq: 2 })
  t.alike((await block(linked2.body.id)).body, { error: 'alvo-nao-confirmado' }, 'seeder down refuses a linked target too')
  seeder.state.down = false
  const linkedOk = await block(linked2.body.id)
  t.is(linkedOk.status, 200, linkedOk.text)
  t.is(linkedOk.body.change.member, s.bia.hex, 'a linked served diary is confirmed and blocked')
  const dropped = await s.api('POST', '/account/mod/api/reports/' + asRoot.body.id + '/decide', { cookie, body: { decision: 'descartar' } })
  t.is(dropped.status, 200, 'Descartar always works')
})

test('group block: both blocks rest on the message the seeder hands out, never on the index row and the quote alone', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const writer = keys().hex
  const group = keys().hex
  seeder.groups[group] = [{ key: writer, diary: s.bia.hex }]
  seeder.state.unread.add(writer)
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 1, quote: 'citação inventada', writer, group })
  const decide = (block) => s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block } })
  t.alike((await s.api('GET', '/account/mod/api/reports/' + r.body.id + '/grupo', { cookie })).body, { confirmed: false, reason: 'nao-lida' })
  for (const block of ['grupo', 'diario']) t.alike((await decide(block)).body, { error: 'grupo-nao-confirmado' }, block + ': listed writer, message not read')
  t.is(s.moderation.pending().changes.length, 0)
  t.ok(seeder.posts.length > 0, 'the message route was asked')

  // Not cached: once the seeder hands it out, the block goes through.
  seeder.state.unread.delete(writer)
  t.alike((await s.api('GET', '/account/mod/api/reports/' + r.body.id + '/grupo', { cookie })).body, { confirmed: true, root: true, name: 'Horta', creator: s.bia.hex, texto: 'mensagem conferida' })
  t.is((await decide('diario')).status, 200)
})

test('group block: without the seeder token both blocks are refused', async (t) => {
  const seeder = await fakeSeeder(t)
  const tokenless = createGroupCheck({ baseUrl: 'http://127.0.0.1:' + seeder.port })
  const s = await setup(t, { groupCheck: tokenless })
  const writer = keys().hex
  const group = keys().hex
  seeder.groups[group] = [{ key: writer, diary: s.bia.hex }]
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer, group })
  for (const block of ['grupo', 'diario']) {
    const res = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block } })
    t.alike(res.body, { error: 'grupo-nao-confirmado' }, block)
  }
  t.is(seeder.posts.length, 0, 'nothing read without the token')
})

test('group report: the creator writes through the root core, so writer may equal the group key', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const group = keys().hex
  seeder.groups[group] = [{ key: group, diary: s.bia.hex }]
  const first = await sendReport(s, s.ana, s.bia.hex, { seq: 1, quote: 'mensagem', writer: group, group })
  t.is(first.status, 200, first.text)
  t.is(s.moderation.get(first.body.id).writer, group)
  const second = await sendReport(s, s.ana, s.bia.hex, { seq: 2, writer: group, group })
  t.is(second.status, 200, second.text)
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const info = await s.api('GET', '/account/mod/api/reports/' + first.body.id + '/grupo', { cookie })
  t.alike(info.body, { confirmed: true, root: true, name: 'Horta', creator: s.bia.hex, texto: 'mensagem conferida' })
  const asGroup = await s.api('POST', '/account/mod/api/reports/' + first.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'grupo' } })
  t.is(asGroup.status, 200, asGroup.text)
  t.is(asGroup.body.change.member, group)
  const asAccount = await s.api('POST', '/account/mod/api/reports/' + second.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'diario' } })
  t.is(asAccount.status, 200, asAccount.text)
  t.is(asAccount.body.change.member, s.bia.hex)
})

test('group report: an old group block keeps its grupo label beyond the listing window', async (t) => {
  const seeder = await fakeSeeder(t)
  const s = await setup(t, { groupCheck: seeder.groupCheck })
  const writer = keys().hex
  const group = keys().hex
  seeder.groups[group] = [{ key: writer, diary: s.bia.hex }]
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const old = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer, group })
  t.is((await s.api('POST', '/account/mod/api/reports/' + old.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'grupo' } })).status, 200)
  s.c.offset += 1000
  seeder.state.diaries.add(s.ana.hex)
  const newer = await sendReport(s, s.bia, s.ana.hex)
  t.is((await s.api('POST', '/account/mod/api/reports/' + newer.body.id + '/decide', { cookie, body: { decision: 'bloquear' } })).status, 200)
  // Stand-in for MAX_REPORTS newer decided rows: any listing window now
  // holds only the newest decision, never the old group block.
  const list = s.moderation.list
  s.moderation.list = (opts = {}) => list({ ...opts, limit: opts.status === 'decidida' ? 1 : opts.limit })
  const listed = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.alike(listed.body.pending.map((c) => [c.member, c.kind]), [[group, 'grupo'], [s.ana.hex, 'conta']])
})

test('group lookups have their own budget: a panel full of them never locks decide', async (t) => {
  const s = await setup(t)
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer: keys().hex, group: keys().hex })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const statuses = []
  for (let i = 0; i < 60; i++) statuses.push((await s.api('GET', '/account/mod/api/reports/' + r.body.id + '/grupo', { cookie })).status)
  t.is(statuses.filter((x) => x === 200).length, 30, 'the group window answers 30 a minute')
  t.ok(statuses.slice(30).every((x) => x === 429))
  const reports = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  t.is(reports.status, 200, 'the lists still answer')
  const dropped = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'descartar' } })
  t.is(dropped.status, 200, 'decide still answers')
})

test('a report naming the moderator diary as its group is listed and can be discarded, never blocked as a group', async (t) => {
  const s = await setup(t)
  // carol is the signed-in moderator (EMAIL_MOD).
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 1, writer: keys().hex, group: s.carol.hex })
  t.is(r.status, 200, r.text)
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const list = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  t.ok(list.body.reports.some((x) => x.id === r.body.id), 'listed: the group key is the reporter\'s choice')
  const me = await s.api('GET', '/account/mod/api/me', { cookie })
  t.is(me.body.open, 1, 'counted')
  const asGroup = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'grupo' } })
  t.is(asGroup.status, 404)
  t.alike(asGroup.body, { error: 'nao-encontrado' }, 'never a group block of the own diary')
  const asAccount = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'diario' } })
  t.alike(asAccount.body, { error: 'grupo-nao-confirmado' }, 'diario follows the normal rule')
  const dropped = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'descartar' } })
  t.is(dropped.status, 200, dropped.text)
  t.is(s.moderation.get(r.body.id).status, 'descartar')
})

test('reports: the daily cap answers limite-denuncias', async (t) => {
  const s = await setup(t)
  let sent = 0
  while (sent < 20) {
    const r = await sendReport(s, s.ana, keys().hex)
    t.is(r.status, 200, r.text)
    sent++
  }
  const capped = await sendReport(s, s.ana, keys().hex)
  t.is(capped.status, 429)
  t.alike(capped.body, { error: 'limite-denuncias' })
  noLeak(t, s)
})

test('panel auth: api/me 401 exactly, disabled login, link cookie refused, callback guards', async (t) => {
  const disabled = await setup(t, { emails: [] })
  for (const s of [disabled, await setup(t)]) {
    const res = await fetch(s.base + '/account/mod/api/me')
    t.is(res.status, 401)
    t.ok(res.headers.get('content-type').startsWith('application/json'))
    t.is(await res.text(), '{"error":"nao-autorizado"}\n', 'the exact bytes deploy.sh compares')
  }
  const login503 = await disabled.api('GET', '/account/mod/login')
  t.is(login503.status, 503)
  t.alike(login503.body, { error: 'indisponivel' })

  const s = await setup(t)
  await sendReport(s, s.ana, s.bia.hex)
  const anon = await s.api('GET', '/account/mod/api/reports')
  t.is(anon.status, 401)
  t.absent(anon.text.includes(s.bia.hex), 'no data without a session')

  const { session } = await signIn(s)
  t.ok(session !== null && TOKEN_RE.test(session))
  // The same token presented as the link cookie (or the login cookie) is no session.
  t.is((await s.api('GET', '/account/mod/api/me', { cookie: COOKIE + '=' + session })).status, 401, 'link cookie refused')
  t.is((await s.api('GET', '/account/mod/api/me', { cookie: LOGIN_COOKIE + '=' + session })).status, 401, 'login cookie refused')
  t.is((await s.api('GET', '/account/mod/api/me', { cookie: sessionCookie('A'.repeat(43)) })).status, 401, 'unknown session refused')

  const calls = s.fake.tokenCalls()
  const login = await s.api('GET', '/account/mod/login')
  t.is(login.status, 302)
  const loginCookie = cookieFrom(login, LOGIN_COOKIE)
  t.is(loginCookie.maxAge, 600)
  const url = new URL(login.headers.get('location'))
  t.is(url.searchParams.get('redirect_uri'), ORIGIN + '/account/mod/callback')
  t.is(url.searchParams.get('code_challenge_method'), 'S256')
  const state = url.searchParams.get('state')

  const noCookie = await s.api('GET', '/account/mod/callback?state=' + state + '&code=x')
  t.is(noCookie.headers.get('location'), ORIGIN + '/account/mod/?erro=sessao')
  const foreign = await s.api('GET', '/account/mod/callback?state=' + 'B'.repeat(43) + '&code=x', { cookie: LOGIN_COOKIE + '=' + loginCookie.value })
  t.is(foreign.headers.get('location'), ORIGIN + '/account/mod/?erro=sessao')
  t.is(s.fake.tokenCalls(), calls, 'no token call without the cookie or with a foreign state')

  const cancelled = await s.api('GET', '/account/mod/callback?state=' + state + '&error=access_denied', { cookie: LOGIN_COOKIE + '=' + loginCookie.value })
  t.is(cancelled.headers.get('location'), ORIGIN + '/account/mod/?erro=cancelado')
  const reused = await s.api('GET', '/account/mod/callback?state=' + state + '&code=x', { cookie: LOGIN_COOKIE + '=' + loginCookie.value })
  t.is(reused.headers.get('location'), ORIGIN + '/account/mod/?erro=sessao', 'state is single-use')
  t.is(s.fake.tokenCalls(), calls)

  const outside = await signIn(s, { sub: SUB_OUT, email: EMAIL_OUT })
  t.is(outside.cb.headers.get('location'), ORIGIN + '/account/mod/?erro=nao-autorizado')
  t.is(outside.session, null, 'no session for an e-mail outside the list')
  t.ok(s.logs.some((l) => l.includes('fora-da-lista')))
  noLeak(t, s)
})

test('panel: a moderator lists, decides and never sees their own case; operator pull and ack', async (t) => {
  const s = await setup(t)
  const r1 = await sendReport(s, s.ana, s.bia.hex, { seq: 2, quote: 'algo' })
  const own = await sendReport(s, s.ana, s.carol.hex)
  t.is(r1.status, 200)
  t.is(own.status, 200)

  const { session, cb } = await signIn(s)
  t.is(cb.headers.get('location'), ORIGIN + '/account/mod/')
  const cookie = sessionCookie(session)
  const me = await s.api('GET', '/account/mod/api/me', { cookie })
  t.is(me.status, 200)
  // Two open reports, one about the moderator's own diary: the count leaves
  // it out, like the list does.
  t.alike(me.body, { email: EMAIL_MOD.toLowerCase(), published: null, open: 1, appeals: 0, pending: 0 })

  const list = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  t.is(list.status, 200)
  t.is(list.body.reports.length, 1, 'the case against the moderator\'s own diary is omitted')
  const row = list.body.reports[0]
  t.is(row.id, r1.body.id)
  t.alike(row.reporter, { member: s.ana.hex, username: 'ana' })
  t.alike(row.reported, { member: s.bia.hex, username: 'bia', linked: true })
  t.is(row.quote, 'algo')
  t.is(row.actor, null, 'open: nobody decided')
  t.is(row.ia, null, 'triage off: no suggestion')
  t.is(row.publicacao, null, 'triage off: no verified text')
  for (const secret of [EMAIL_A, EMAIL_B, SUB_A, SUB_B, SUB_C]) t.absent(list.text.includes(secret), 'no e-mail or sub in the list')
  t.absent(list.text.includes('signature'), 'no signature')

  const ownDecide = await s.api('POST', '/account/mod/api/reports/' + own.body.id + '/decide', { cookie, body: { decision: 'bloquear', note: '' } })
  t.is(ownDecide.status, 404, 'cannot decide a case about their own diary')
  t.is(s.moderation.get(own.body.id).status, 'aberta')

  const noOrigin = await s.api('POST', '/account/mod/api/reports/' + r1.body.id + '/decide', { cookie, origin: null, body: { decision: 'bloquear' } })
  t.is(noOrigin.status, 403, 'panel POST needs the Origin')
  const bad = await s.api('POST', '/account/mod/api/reports/' + r1.body.id + '/decide', { cookie, body: { decision: 'talvez' } })
  t.alike(bad.body, { error: 'pedido-invalido' })

  const decided = await s.api('POST', '/account/mod/api/reports/' + r1.body.id + '/decide', { cookie, body: { decision: 'bloquear', note: 'nota' } })
  t.is(decided.status, 200, decided.text)
  t.is(decided.body.report.status, 'bloquear')
  t.is(decided.body.report.actor, 'pessoa', 'a moderator decided')
  t.absent('decidedBy' in decided.body.report, 'never the e-mail field')
  t.is(decided.body.change.op, 'block')
  t.is(decided.body.change.byAi, false)
  const blocked = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.is(blocked.body.pending.length, 1, 'one pending block')
  t.is(blocked.body.pending[0].member, s.bia.hex)
  t.is(blocked.body.pending[0].username, 'bia')
  t.is(blocked.body.pending[0].claimedAt, null)
  t.alike(blocked.body.blocked, [])
  t.is(blocked.body.published, null)
  const decidedList = await s.api('GET', '/account/mod/api/reports?estado=decidida', { cookie })
  t.is(decidedList.body.reports[0].status, 'bloquear')
  t.absent(decidedList.text.includes('@') || blocked.text.includes('@'), 'no moderator e-mail in lists')

  // Another moderator queues a block of this moderator's own diary: it stays
  // out of this moderator's api/blocked too (pending row and its report ids).
  await s.moderation.decide(own.body.id, { decision: 'bloquear', by: 'outra moderadora' })
  const withOwn = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.is(withOwn.body.pending.length, 1, 'the block of their own diary is not listed')
  t.absent(withOwn.text.includes(s.carol.hex), 'their own key does not appear')
  t.absent(withOwn.text.includes(own.body.id), 'nor the report about them')
  // Back to the state the rest of this test expects.
  const ownChange = s.moderation.pending().changes.find((c) => c.member === s.carol.hex)
  await s.moderation.cancel(ownChange.id, { by: 'outra moderadora' })

  // --- the operator ---
  const modKeys = keys()
  const modCert = createModeratorCert({ moderator: modKeys.hex, date: '2026-10-01T00:00:00.000Z' }, s.iss.assoc)
  const challenge = async (op, moderator = modKeys.hex) => (await s.api('GET', '/account/mod/api/challenge?moderator=' + moderator + '&op=' + op)).body.nonce
  const signed = (op, nonce, kp, data, origin = ORIGIN) => signModRequest({ origin, association: s.iss.association, moderator: b4a.toString(kp.publicKey, 'hex'), nonce, op, body: canonicalBody(op, data) }, kp)

  let nonce = await challenge('pull')
  const pull = await s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: modCert, nonce, signature: signed('pull', nonce, modKeys.kp) } })
  t.is(pull.status, 200, pull.text)
  t.alike(Object.keys(pull.body), ['changes', 'published'])
  t.alike(Object.keys(pull.body.published), ['snapshot'])
  t.is(pull.body.changes.length, 1)
  t.alike(Object.keys(pull.body.changes[0]), ['id', 'op', 'member', 'at', 'actor'])
  t.is(pull.body.changes[0].actor, 'pessoa', 'a moderator decision')
  t.absent(pull.text.includes('@'), 'never an e-mail')
  t.is(pull.body.changes[0].member, s.bia.hex)
  const replay = await s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: modCert, nonce, signature: signed('pull', nonce, modKeys.kp) } })
  t.is(replay.status, 403, 'a reused nonce')

  const stranger = keys()
  const otherAssoc = crypto.keyPair()
  const uncertified = createModeratorCert({ moderator: stranger.hex }, otherAssoc)
  nonce = await challenge('pull', stranger.hex)
  t.is((await s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: uncertified, nonce, signature: signed('pull', nonce, stranger.kp) } })).status, 403, 'an uncertified key')
  nonce = await challenge('pull')
  t.is((await s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: modCert, nonce, signature: signed('pull', nonce, modKeys.kp, undefined, 'https://outra.test') } })).status, 403, 'a signature for another origin')
  nonce = await challenge('ack')
  t.is((await s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: modCert, nonce, signature: signed('pull', nonce, modKeys.kp) } })).status, 403, 'a challenge for another op')

  const claimed = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.is(typeof claimed.body.pending[0].claimedAt, 'string', 'the pull claimed the change')

  const changeIds = [pull.body.changes[0].id]
  const snapshot = createSnapshot({ seq: 1, blocked: [s.bia.hex] }, modKeys.kp, modCert)
  const forged = { ...snapshot, blocked: [s.bia.hex, s.ana.hex].sort() }
  nonce = await challenge('ack')
  const forgedAck = await s.api('POST', '/account/mod/api/ack', { origin: null, body: { cert: modCert, nonce, signature: signed('ack', nonce, modKeys.kp, { changeIds, snapshot: forged }), changeIds, snapshot: forged } })
  t.is(forgedAck.status, 400)
  t.alike(forgedAck.body, { error: 'assinatura-invalida' }, 'a forged snapshot is refused')
  t.is(s.moderation.stats().pending, 1, 'nothing acked')

  nonce = await challenge('ack')
  const ack = await s.api('POST', '/account/mod/api/ack', { origin: null, body: { cert: modCert, nonce, signature: signed('ack', nonce, modKeys.kp, { changeIds, snapshot }), changeIds, snapshot } })
  t.is(ack.status, 200, ack.text)
  t.alike(ack.body, { ok: true, seq: 1 })
  t.is(s.moderation.stats().pending, 0, 'the change is cleared')
  const after = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.alike(after.body.blocked.map((b) => b.member), [s.bia.hex])
  t.is(after.body.published.seq, 1)

  // A key certified before the one that signed the published list.
  const oldKeys = keys()
  const oldCert = createModeratorCert({ moderator: oldKeys.hex, date: '2026-09-01T00:00:00.000Z' }, s.iss.assoc)
  nonce = await challenge('pull', oldKeys.hex)
  t.is((await s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: oldCert, nonce, signature: signed('pull', nonce, oldKeys.kp) } })).status, 403, 'a rotated-out key')

  const logout = await s.api('POST', '/account/mod/logout', { cookie, body: {} })
  t.is(logout.status, 200)
  t.is(cookieFrom(logout, SESSION_COOKIE).maxAge, 0)
  t.is((await s.api('GET', '/account/mod/api/me', { cookie })).status, 401, 'signed out')
  noLeak(t, s)
})

// A signed POST /account/report over `nonce`; `signer` defaults to reporter.
function signedReport (s, reporter, nonce, target, { signer = reporter, reason = 'spam' } = {}) {
  const fields = { nonce, member: reporter.hex, association: s.iss.association, target, seq: null, reason, text: '', quote: '' }
  const body = { ...fields, signature: signReport(fields, signer.kp) }
  delete body.association
  return body
}

// The same 40 bytes under another base64url spelling (the last of 54
// characters carries 2 spare bits).
function respell (nonce) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const i = alphabet.indexOf(nonce[nonce.length - 1])
  return nonce.slice(0, -1) + alphabet[i ^ 1]
}

test('report nonces: stateless, bound to the member, spent only by a verified report', async (t) => {
  const s = await setup(t)
  const spent = () => s.server.modStats().spentReportNonces

  // Anyone may ask for nonces naming ana's key: it never costs her anything.
  for (let i = 0; i < 15; i++) {
    const r = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
    t.is(r.status, 200, 'start ' + i)
  }
  t.is(spent(), 0, 'issuing nonces stores nothing')
  const started = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
  t.ok(/^[A-Za-z0-9_-]{54}$/.test(started.body.nonce), '40 bytes, 54 characters')
  const nonce = started.body.nonce

  // Invalid attempts with ana's live nonce never spend it.
  const target = keys().hex
  const forgedSig = await s.api('POST', '/account/report', { body: signedReport(s, s.ana, nonce, target, { signer: s.bia }) })
  t.alike(forgedSig.body, { error: 'assinatura-invalida' })
  const wrongMember = await s.api('POST', '/account/report', { body: signedReport(s, s.bia, nonce, target) })
  t.alike(wrongMember.body, { error: 'expirado' }, 'a nonce bound to another member')
  t.is(spent(), 0, 'invalid requests spend nothing')

  const ok = await s.api('POST', '/account/report', { body: signedReport(s, s.ana, nonce, target) })
  t.is(ok.status, 200, 'the victim of the start flood still reports: ' + ok.text)
  t.is(spent(), 1)
  const replay = await s.api('POST', '/account/report', { body: signedReport(s, s.ana, nonce, target) })
  t.is(replay.status, 400)
  t.alike(replay.body, { error: 'expirado' }, 'a replayed signed report is refused before the store')
  const respelled = await s.api('POST', '/account/report', { body: signedReport(s, s.ana, respell(nonce), target) })
  t.alike(respelled.body, { error: 'expirado' }, 'a non-canonical spelling of a spent nonce')
  t.is(s.moderation.stats().open, 1, 'one row')

  const raw = Buffer.from((await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })).body.nonce, 'base64url')
  const tampered = Buffer.from(raw)
  tampered[12] ^= 1
  const later = Buffer.from(raw)
  later[7] ^= 0xff // a forged, later expiry
  const forged = crypto.randomBytes(40)
  for (const [label, n] of [['tampered', tampered], ['extended expiry', later], ['forged', forged]]) {
    const r = await s.api('POST', '/account/report', { body: signedReport(s, s.ana, n.toString('base64url'), keys().hex) })
    t.alike(r.body, { error: 'expirado' }, label)
  }
  for (const n of ['A'.repeat(43), 'x', 7, null]) {
    const r = await s.api('POST', '/account/report', { body: { ...signedReport(s, s.ana, 'A'.repeat(54), keys().hex), nonce: n } })
    t.alike(r.body, { error: 'expirado' }, 'malformed ' + JSON.stringify(n))
  }

  const old = (await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })).body.nonce
  s.c.offset += 600 * 1000 + 1
  const expired = await s.api('POST', '/account/report', { body: signedReport(s, s.ana, old, keys().hex) })
  t.alike(expired.body, { error: 'expirado' }, 'an expired nonce')
  t.is(spent(), 1, 'still only the one verified report')

  // Spent rows are dropped at their own expiry.
  const fresh = (await s.api('POST', '/account/report/start', { body: { member: s.bia.hex } })).body.nonce
  t.is((await s.api('POST', '/account/report', { body: signedReport(s, s.bia, fresh, keys().hex) })).status, 200)
  t.is(spent(), 1, 'the expired spent nonce was swept')
  noLeak(t, s)
})

test('operator challenges: stateless, bound to moderator and op; anonymous floods never block pull or ack', async (t) => {
  const s = await setup(t)
  const spent = () => s.server.modStats().spentChallenges
  const modKeys = keys()
  const modCert = createModeratorCert({ moderator: modKeys.hex, date: '2026-10-01T00:00:00.000Z' }, s.iss.assoc)
  const otherKeys = keys()
  const challenge = async (op, moderator = modKeys.hex) => {
    const r = await s.api('GET', '/account/mod/api/challenge?moderator=' + moderator + '&op=' + op)
    return r.status === 200 ? r.body.nonce : r
  }
  const signed = (op, nonce, data, kp = modKeys.kp) => signModRequest({ origin: ORIGIN, association: s.iss.association, moderator: b4a.toString(kp.publicKey, 'hex'), nonce, op, body: canonicalBody(op, data) }, kp)
  const pull = (nonce, signature = signed('pull', nonce)) => s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: modCert, nonce, signature } })

  // A pending block to pull and ack.
  const { report } = await s.moderation.add({ reporter: s.ana.hex, target: s.bia.hex, seq: null, reason: 'spam', text: '', quote: '', signature: 'a'.repeat(128), nonce: 'N'.repeat(43) })
  await s.moderation.decide(report.id, { decision: 'bloquear', by: EMAIL_MOD.toLowerCase(), note: '' })

  // 35 anonymous challenges, for strangers and for the operator's own key.
  for (let i = 0; i < 35; i++) {
    const n = await challenge(i % 2 ? 'ack' : 'pull', i % 3 ? keys().hex : modKeys.hex)
    t.is(typeof n, 'string', 'anonymous challenge ' + i)
  }
  t.is(spent(), 0, 'issuing challenges stores nothing')
  s.c.offset += 10 * 1000 // refill the global bucket

  const nonce = await challenge('pull')
  const forged = await pull(nonce, signed('pull', nonce, undefined, otherKeys.kp))
  t.is(forged.status, 403, 'a signature by another key')
  t.is(spent(), 0, 'a forged pull spends nothing')
  const pulled = await pull(nonce)
  t.is(pulled.status, 200, 'the operator pulls after the flood: ' + pulled.text)
  t.is(pulled.body.changes.length, 1)
  t.is(spent(), 1)
  t.is((await pull(nonce)).status, 403, 'a replayed signed pull')
  t.is((await pull(respell(nonce), signed('pull', respell(nonce)))).status, 403, 'a re-spelled spent challenge')
  t.is(spent(), 1)

  const ackNonce = await challenge('ack')
  t.is((await pull(ackNonce, signed('pull', ackNonce))).status, 403, 'an ack challenge cannot pull')
  const otherNonce = await challenge('pull', otherKeys.hex)
  t.is((await pull(otherNonce, signed('pull', otherNonce))).status, 403, 'a challenge for another moderator')
  const old = await challenge('pull')
  s.c.offset += 120 * 1000 + 1
  t.is((await pull(old)).status, 403, 'an expired challenge')

  const changeIds = [pulled.body.changes[0].id]
  const snapshot = createSnapshot({ seq: 1, blocked: [s.bia.hex] }, modKeys.kp, modCert)
  const ack = (n, sig = signed('ack', n, { changeIds, snapshot })) => s.api('POST', '/account/mod/api/ack', { origin: null, body: { cert: modCert, nonce: n, signature: sig, changeIds, snapshot } })
  const pullNonce = await challenge('pull')
  t.is((await ack(pullNonce, signed('ack', pullNonce, { changeIds, snapshot }))).status, 403, 'a pull challenge cannot ack')
  t.is(spent(), 1, 'refused requests spend nothing')

  for (let i = 0; i < 35; i++) await challenge('ack')
  s.c.offset += 10 * 1000
  const n = await challenge('ack')
  const acked = await ack(n)
  t.is(acked.status, 200, 'the operator acks after another flood: ' + acked.text)
  t.alike(acked.body, { ok: true, seq: 1 })
  t.is((await ack(n)).status, 403, 'a replayed signed ack')
  t.is(spent(), 1, 'only the ack is recorded: the pull\'s row was swept at its expiry')
  noLeak(t, s)
})

// The login cookie with one base64url character changed in the middle (the
// sealed bytes change, so the auth tag no longer verifies).
function tamper (value) {
  const i = Math.floor(value.length / 2)
  return value.slice(0, i) + (value[i] === 'A' ? 'B' : 'A') + value.slice(i + 1)
}

test('moderator login: stateless sealed cookie; a /login flood never breaks an in-flight sign-in', async (t) => {
  const s = await setup(t)
  const calls = s.fake.tokenCalls()
  const login = await s.api('GET', '/account/mod/login')
  t.is(login.status, 302)
  const loginCookie = cookieFrom(login, LOGIN_COOKIE)
  t.ok(/^[A-Za-z0-9_-]{155}$/.test(loginCookie.value), 'a fixed-size sealed cookie')
  t.is(loginCookie.maxAge, 600)
  const state = new URL(login.headers.get('location')).searchParams.get('state')

  // 200 anonymous /login requests (the bucket refilled between batches).
  for (let batch = 0; batch < 4; batch++) {
    s.c.offset += 5 * 1000
    for (let i = 0; i < 50; i++) {
      const r = await s.api('GET', '/account/mod/login')
      t.is(r.status, 302, 'anonymous login ' + (batch * 50 + i))
    }
  }
  t.alike(s.server.modStats(), { spentReportNonces: 0, spentAppealNonces: 0, spentChallenges: 0, spentLogins: 0, sessions: 0 }, 'logins store nothing')
  t.is(s.fake.tokenCalls(), calls, 'no token call yet')

  s.c.offset += 5 * 1000
  s.fake.account.sub = SUB_C
  s.fake.account.email = EMAIL_MOD
  const cookie = LOGIN_COOKIE + '=' + loginCookie.value
  const cb = await s.api('GET', '/account/mod/callback?state=' + state + '&code=codigo-1', { cookie })
  t.is(cb.headers.get('location'), ORIGIN + '/account/mod/', 'the in-flight sign-in survives the flood')
  t.is(cookieFrom(cb, LOGIN_COOKIE).maxAge, 0, 'the login cookie is cleared')
  const session = cookieFrom(cb, SESSION_COOKIE)
  t.ok(session && TOKEN_RE.test(session.value))
  t.is((await s.api('GET', '/account/mod/api/me', { cookie: sessionCookie(session.value) })).status, 200)
  t.is(s.server.modStats().spentLogins, 1)

  // The same cookie and state again: refused before any token call.
  const afterOk = s.fake.tokenCalls()
  const replay = await s.api('GET', '/account/mod/callback?state=' + state + '&code=codigo-2', { cookie })
  t.is(replay.headers.get('location'), ORIGIN + '/account/mod/?erro=sessao', 'a replayed callback')
  t.is(s.fake.tokenCalls(), afterOk, 'no token call for a replay')
  noLeak(t, s)
})

test('moderator login: tampered, expired, foreign-state or foreign-process cookies make no token call', async (t) => {
  const s = await setup(t)
  const other = await setup(t)
  const start = async (srv = s) => {
    const login = await srv.api('GET', '/account/mod/login')
    return { value: cookieFrom(login, LOGIN_COOKIE).value, state: new URL(login.headers.get('location')).searchParams.get('state') }
  }
  const cb = (value, state) => s.api('GET', '/account/mod/callback?state=' + state + '&code=codigo-1', { cookie: LOGIN_COOKIE + '=' + value })
  const calls = s.fake.tokenCalls()
  const otherCalls = other.fake.tokenCalls()

  const a = await start()
  const b = await start()
  const foreignProcess = await start(other)
  const cases = [
    ['tampered', tamper(a.value), a.state],
    ['truncated', a.value.slice(0, -1), a.state],
    ['another login\'s state', a.value, b.state],
    ['a made-up state', a.value, 'B'.repeat(43)],
    ['sealed by another process', foreignProcess.value, foreignProcess.state],
    ['a session-shaped value', 'A'.repeat(43), a.state]
  ]
  for (const [label, value, state] of cases) {
    const r = await cb(value, state)
    t.is(r.headers.get('location'), ORIGIN + '/account/mod/?erro=sessao', label)
  }
  t.is(s.server.modStats().spentLogins, 0, 'refused callbacks spend nothing')

  const old = await start()
  s.c.offset += 600 * 1000 + 1
  const expired = await cb(old.value, old.state)
  t.is(expired.headers.get('location'), ORIGIN + '/account/mod/?erro=sessao', 'an expired login cookie')
  t.is(s.fake.tokenCalls(), calls, 'no token call for any of them')
  t.is(other.fake.tokenCalls(), otherCalls)

  // The untouched cookies still work (b, within its own lifetime).
  s.c.offset = 0
  const ok = await cb(b.value, b.state)
  t.is(ok.headers.get('location'), ORIGIN + '/account/mod/')
  noLeak(t, s)
})

test('moderator login: a Google account without a linked diary gets ?erro=sem-diario and no session', async (t) => {
  const EMAIL_NODIARY = 'sem-diario@example.test'
  const s = await setup(t, { emails: [EMAIL_MOD.toLowerCase(), EMAIL_NODIARY] })
  const r = await signIn(s, { sub: SUB_OUT, email: EMAIL_NODIARY })
  t.is(r.cb.headers.get('location'), ORIGIN + '/account/mod/?erro=sem-diario')
  t.is(r.session, null, 'no session cookie')
  t.is(cookieFrom(r.cb, LOGIN_COOKIE).maxAge, 0, 'the login cookie is cleared')
  t.is(s.server.modStats().sessions, 0, 'no session row')
  t.ok(s.logs.some((l) => l.includes('sem-diario')))
  noLeak(t, s)
})

test('panel: a moderator never sees nor decides a report filed from their own diary', async (t) => {
  const s = await setup(t)
  const filed = await sendReport(s, s.carol, s.bia.hex) // carol is the moderator's diary
  const other = await sendReport(s, s.ana, s.bia.hex, { reason: 'assedio' })
  t.is(filed.status, 200, filed.text)
  t.is(other.status, 200, other.text)
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const list = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  t.alike(list.body.reports.map((r) => r.id), [other.body.id], 'their own report is hidden')
  t.absent(list.text.includes(s.carol.hex), 'their key does not appear')
  const decide = await s.api('POST', '/account/mod/api/reports/' + filed.body.id + '/decide', { cookie, body: { decision: 'bloquear', note: '' } })
  t.is(decide.status, 404)
  t.alike(decide.body, { error: 'nao-encontrado' })
  t.is(s.moderation.get(filed.body.id).status, 'aberta', 'still open')
  t.alike(s.moderation.pending().changes, [], 'no block queued')
  noLeak(t, s)
})

test('panel: a moderator whose own cases fill the first page still sees later reports', async (t) => {
  const s = await setup(t)
  const add = (target) => s.moderation.add({ reporter: keys().hex, target, seq: null, reason: 'spam', text: '', quote: '', signature: 'a'.repeat(128), nonce: 'N'.repeat(43) })
  for (let i = 0; i < 101; i++) {
    s.c.offset += 1
    await add(s.carol.hex) // the moderator's own diary
  }
  s.c.offset += 1000
  const { report: later } = await add(s.bia.hex)

  const { session } = await signIn(s)
  const list = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie: sessionCookie(session) })
  t.is(list.status, 200, list.text)
  t.is(list.body.reports.length, 1, 'the actionable report after 101 own cases')
  t.is(list.body.reports[0].id, later.id)
  t.is(list.body.truncated, false, 'truncated is computed on the visible rows')
  noLeak(t, s)
})

// What a usage view might answer: counts only, no key or e-mail.
const STATS_FIXTURE = { geradoEm: 1700000000000, contas: { total: 3, vinculadas: 3 }, seeder: { diarios: 12 } }

function fakeUsage (view) {
  const calls = { n: 0 }
  return { calls, usage: { view: async () => { calls.n++; return view() } } }
}

test('stats: an allowed moderator sees the stats flag and api/stats; anonymous is 401 exactly', async (t) => {
  const fake = fakeUsage(() => STATS_FIXTURE)
  // EMAIL_MOD as written (mixed case): the routes lowercase it.
  const s = await setup(t, { statsEmails: [EMAIL_MOD], usage: fake.usage })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const me = await s.api('GET', '/account/mod/api/me', { cookie })
  t.is(me.status, 200)
  t.is(me.body.stats, true, 'me carries stats: true')

  const res = await s.api('GET', '/account/mod/api/stats', { cookie })
  t.is(res.status, 200, res.text)
  t.alike(res.body, STATS_FIXTURE)
  t.is(res.headers.get('cache-control'), 'no-store')
  t.is(fake.calls.n, 1)

  const anon = await fetch(s.base + '/account/mod/api/stats')
  t.is(anon.status, 401)
  t.is(await anon.text(), '{"error":"nao-autorizado"}\n')
  t.is(fake.calls.n, 1, 'no view without a session')
  noLeak(t, s)
})

test('stats: a stats e-mail outside the moderator list is ignored', async (t) => {
  const fake = fakeUsage(() => STATS_FIXTURE)
  const s = await setup(t, { statsEmails: ['outra@example.test'], usage: fake.usage })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const me = await s.api('GET', '/account/mod/api/me', { cookie })
  t.is(me.status, 200)
  t.absent('stats' in me.body, 'no stats key at all (never stats: false)')
  const res = await s.api('GET', '/account/mod/api/stats', { cookie })
  t.is(res.status, 403)
  t.alike(res.body, { error: 'nao-autorizado' })
  t.is(fake.calls.n, 0, 'the view is never called')
  noLeak(t, s)
})

test('stats: usage off means no flag and 403', async (t) => {
  const s = await setup(t, { statsEmails: [EMAIL_MOD], usage: null })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const me = await s.api('GET', '/account/mod/api/me', { cookie })
  t.absent('stats' in me.body)
  const res = await s.api('GET', '/account/mod/api/stats', { cookie })
  t.is(res.status, 403)
  t.alike(res.body, { error: 'nao-autorizado' })
  noLeak(t, s)
})

test('stats: a throwing view answers 503 indisponivel; POST is 404', async (t) => {
  const fake = fakeUsage(() => { throw new Error('falhou ' + EMAIL_A) })
  const s = await setup(t, { statsEmails: [EMAIL_MOD], usage: fake.usage })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const res = await s.api('GET', '/account/mod/api/stats', { cookie })
  t.is(res.status, 503)
  t.alike(res.body, { error: 'indisponivel' })
  t.absent(res.text.includes('falhou'), 'never the error message')

  const post = await s.api('POST', '/account/mod/api/stats', { cookie, body: {} })
  t.is(post.status, 404)
  t.alike(post.body, { error: 'nao-encontrado' })
  noLeak(t, s)
})

test('panel: the history pages with antes, without repeats or gaps, and keeps own cases out', async (t) => {
  const s = await setup(t)
  const add = (reporter, target) => s.moderation.add({ reporter: reporter.hex, target, seq: null, reason: 'spam', text: '', quote: '', signature: 'a'.repeat(128), nonce: 'N'.repeat(43) })
  const decidedIds = []
  const ownIds = []
  for (let i = 0; i < 235; i++) {
    const own = i % 25 === 0
    s.c.offset += 1
    const { report } = await add(keys(), own ? s.carol.hex : s.bia.hex)
    s.c.offset += 1
    await s.moderation.decide(report.id, { decision: 'descartar', by: 'outra moderadora' })
    ;(own ? ownIds : decidedIds).push(report.id)
  }
  const open = await add(keys(), s.bia.hex)

  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const page = (query) => s.api('GET', '/account/mod/api/reports?estado=decidida' + query, { cookie })
  const first = await page('')
  t.is(first.status, 200, first.text)
  t.is(first.body.reports.length, 100)
  t.is(first.body.truncated, true)
  const second = await page('&antes=' + first.body.reports[99].id)
  t.is(second.body.reports.length, 100)
  t.is(second.body.truncated, true)
  const third = await page('&antes=' + second.body.reports[99].id)
  t.is(third.body.reports.length, decidedIds.length - 200)
  t.is(third.body.truncated, false, 'the last page')
  const all = [...first.body.reports, ...second.body.reports, ...third.body.reports].map((r) => r.id)
  t.alike(all, decidedIds.slice().reverse(), 'every decision once, newest first')
  for (const id of ownIds) t.absent(all.includes(id), 'own case stays out')

  for (const bad of ['&antes=' + open.report.id, '&antes=' + ownIds[0], '&antes=nao-existe', '&antes=', '&antes=' + 'a'.repeat(65), '&antes=%00']) {
    const r = await page(bad)
    t.is(r.status, 400, 'antes ' + bad)
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  const openWithAntes = await s.api('GET', '/account/mod/api/reports?estado=aberta&antes=' + all[0], { cookie })
  t.is(openWithAntes.status, 400, 'antes is for the history only')
  noLeak(t, s)
})

test('panel: a store cut at its limit is reported on the last reachable page', async (t) => {
  const s = await setup(t)
  const { report } = await s.moderation.add({ reporter: s.ana.hex, target: s.bia.hex, seq: null, reason: 'spam', text: '', quote: '', signature: 'a'.repeat(128), nonce: 'N'.repeat(43) })
  s.c.offset += 1
  await s.moderation.decide(report.id, { decision: 'descartar', by: 'outra moderadora' })
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const uncut = await s.api('GET', '/account/mod/api/reports?estado=decidida', { cookie })
  t.is(uncut.body.alemDoLimite, false)

  const list = s.moderation.list
  const asked = []
  s.moderation.list = (options) => { asked.push(options); return { ...list(options), truncated: true } }
  const cut = await s.api('GET', '/account/mod/api/reports?estado=decidida', { cookie })
  t.is(cut.body.truncated, false, 'this page is the last one the panel reaches')
  t.is(cut.body.alemDoLimite, true)
  t.is(asked.length, 1)
  t.is(asked[0].exclude, s.carol.hex, 'the own cases leave the store list before its cut')
  await s.api('GET', '/account/mod/api/me', { cookie })
  t.is(asked[1].exclude, s.carol.hex, 'and the counts of api/me')
  s.moderation.list = list
})

test('panel assets: literal paths, CSP, 404 when missing, no SPA fallback; loopback origin', async (t) => {
  const empty = await setup(t)
  const missing = await empty.api('GET', '/account/mod/')
  t.is(missing.status, 404)
  t.alike(missing.body, { error: 'nao-encontrado' })

  const dir = path.join(tmpDir(t), 'panel')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>painel</title>')
  fs.writeFileSync(path.join(dir, 'app.js'), 'void 0\n')
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{}\n')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nao')
  const s = await setup(t, { panelDir: dir })
  for (const [p, type, text] of [['/account/mod/', 'text/html', '<!doctype html><title>painel</title>'], ['/account/mod/app.js', 'text/javascript', 'void 0\n'], ['/account/mod/app.css', 'text/css', 'body{}\n']]) {
    const res = await s.api('GET', p)
    t.is(res.status, 200, p)
    t.ok(res.headers.get('content-type').startsWith(type), p + ' type')
    t.is(res.text, text)
    t.is(res.headers.get('content-security-policy'), PANEL_CSP)
    t.is(res.headers.get('x-content-type-options'), 'nosniff')
  }
  const bare = await s.api('GET', '/account/mod')
  t.is(bare.status, 302)
  t.is(bare.headers.get('location'), ORIGIN + '/account/mod/')
  for (const p of ['/account/mod/secret.txt', '/account/mod/..%2Fsecret.txt', '/account/mod/qualquer', '/account/mod/api/nada']) {
    const res = await s.api('GET', p)
    t.is(res.status, 404, p)
    t.alike(res.body, { error: 'nao-encontrado' })
  }
  const options = await fetch(s.base + '/account/mod/api/me', { method: 'OPTIONS' })
  t.is(options.status, 404, 'no preflight answer')
  t.is(options.headers.get('access-control-allow-origin'), null)

  // An explicit loopback origin is accepted (tests); plain http elsewhere is not.
  const iss = issuer()
  const base = { association: iss.association, google: { authorizeUrl () {}, exchange () {} }, store: { start () {} } }
  t.ok(createAccountServer({ ...base, origin: 'http://127.0.0.1:8790' }))
  for (const origin of ['http://varanda.test', 'http://localhost:8790', 'http://127.0.0.2']) {
    try {
      createAccountServer({ ...base, origin })
      t.fail(origin + ' accepted')
    } catch (err) {
      t.ok(/invalid origin/.test(err.message), origin)
    }
  }
})

// --- the CLI ---------------------------------------------------------------------

function varanda (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('account reports and status: contacts joined, issuer key never read; bad moderator list refused', async (t) => {
  const root = tmpDir(t)
  const dir = path.join(root, 'account')
  const iss = issuer()
  fs.mkdirSync(dir, { mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 1, role: 'account', association: iss.association }))
  const MARKER = 'MARCADOR-DA-CHAVE-DO-EMISSOR'
  fs.writeFileSync(path.join(dir, 'issuer-key.json'), JSON.stringify({ marker: MARKER }), { mode: 0o600 })

  const none = varanda(dir, ['account', 'reports'])
  t.is(none.code, 0, none.stderr)
  t.is(none.stdout, '', 'no reports before the first start')
  t.absent(fs.existsSync(path.join(dir, 'moderation.json')), 'a read-only command never creates moderation.json')

  const accounts = openAccountStore(dir)
  const ana = keys()
  const bia = keys()
  await linkDirect(accounts, iss, ana, 'ana', SUB_A, EMAIL_A)
  const moderation = openModerationStore(dir, { association: iss.association })
  const nonce = 'N'.repeat(43)
  const fields = { nonce, member: ana.hex, association: iss.association, target: bia.hex, seq: null, reason: 'ilegal', text: 'motivo', quote: '' }
  await moderation.add({ reporter: ana.hex, target: bia.hex, seq: null, reason: 'ilegal', text: 'motivo', quote: '', signature: signReport(fields, ana.kp), nonce })

  const out = varanda(dir, ['account', 'reports'])
  t.is(out.code, 0, out.stderr)
  const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l))
  t.is(lines.length, 1)
  t.alike(lines[0].reporterContact, { email: EMAIL_A, username: 'ana' })
  t.is(lines[0].targetContact, null, 'an unlinked target')
  t.is(lines[0].text, 'motivo')
  t.ok('note' in lines[0] && 'quote' in lines[0])
  t.absent(out.stdout.includes(MARKER), 'never the issuer key file')

  t.is(varanda(dir, ['account', 'reports', '--member', bia.hex]).stdout.trim().split('\n').length, 1)
  t.is(varanda(dir, ['account', 'reports', '--member', ana.hex]).stdout, '', 'filtered by target')

  // `account status` does read the issuer key (it prints its public half).
  fs.unlinkSync(path.join(dir, 'issuer-key.json'))
  const status = varanda(dir, ['account', 'status'])
  t.is(status.code, 0, status.stderr)
  t.ok(status.stdout.includes('denúncias abertas: 1'))
  t.ok(status.stdout.includes('mudanças pendentes: 0'))
  t.ok(status.stdout.includes('lista publicada: nenhuma'))
  const json = JSON.parse(varanda(dir, ['account', 'status', '--json']).stdout.trim().split('\n').pop())
  t.alike(json.moderation, { open: 1, pending: 0, publishedSeq: null })

  const memberDir = path.join(root, 'member')
  fs.mkdirSync(memberDir)
  fs.writeFileSync(path.join(memberDir, 'config.json'), JSON.stringify({ v: 1, role: 'member', association: iss.association }))
  const refused = varanda(memberDir, ['account', 'reports'])
  t.is(refused.code, 1)
  t.ok(refused.stderr.includes('diretório não é do serviço de conta'))

  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: CLIENT_ID, VARANDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET, VARANDA_MODERATOR_EMAILS: 'segredo-sem-arroba' }
  const bad = varanda(path.join(root, 'other'), ['account', '--account-port', '0', '--association', iss.association], env)
  t.is(bad.code, 1)
  t.ok(bad.stderr.includes('VARANDA_MODERATOR_EMAILS inválido'))
  t.absent(bad.stderr.includes('segredo-sem-arroba') || bad.stdout.includes('segredo-sem-arroba'), 'the value is never printed')
})

test('appeals: linked start, signed appeal; not blocked, replay, wrong signer, tampered text, Origin', async (t) => {
  const s = await setup(t)
  const stranger = keys()
  const unlinked = await s.api('POST', '/account/appeal/start', { body: { member: stranger.hex } })
  t.is(unlinked.status, 403)
  t.alike(unlinked.body, { error: 'nao-vinculado' })

  const free = await sendAppeal(s, s.bia)
  t.is(free.status, 403, 'a member that is not blocked')
  t.alike(free.body, { error: 'nao-bloqueado' })

  const r = await sendReport(s, s.ana, s.bia.hex)
  await s.moderation.decide(r.body.id, { decision: 'bloquear', by: 'outra moderadora' })
  const started = await s.api('POST', '/account/appeal/start', { body: { member: s.bia.hex } })
  t.ok(TOKEN_RE.test(started.body.nonce.slice(0, 43)) && started.body.nonce.length === 54)
  const fields = { nonce: started.body.nonce, member: s.bia.hex, association: s.iss.association, text: 'foi um engano' }
  const signature = signAppeal(fields, s.bia.kp)
  const body = { member: s.bia.hex, nonce: fields.nonce, text: 'foi um engano', signature }

  const tampered = await s.api('POST', '/account/appeal', { body: { ...body, text: 'outro texto' } })
  t.alike(tampered.body, { error: 'assinatura-invalida' }, 'the text is bound')
  const wrongSigner = await s.api('POST', '/account/appeal', { body: { ...body, signature: signAppeal(fields, s.ana.kp) } })
  t.alike(wrongSigner.body, { error: 'assinatura-invalida' }, 'only the key itself signs')
  const noOrigin = await s.api('POST', '/account/appeal', { origin: null, body })
  t.is(noOrigin.status, 403, 'the Origin rule holds')
  const asReport = await s.api('POST', '/account/appeal', { body: { ...body, nonce: (await s.api('POST', '/account/report/start', { body: { member: s.bia.hex } })).body.nonce } })
  t.alike(asReport.body, { error: 'expirado' }, 'a report nonce is not an appeal nonce')

  const sent = await s.api('POST', '/account/appeal', { body })
  t.is(sent.status, 200, sent.text)
  t.alike(Object.keys(sent.body).sort(), ['duplicate', 'id'])
  t.is(sent.body.duplicate, false)
  const replay = await s.api('POST', '/account/appeal', { body })
  t.alike(replay.body, { error: 'expirado' }, 'a nonce works once')
  const again = await sendAppeal(s, s.bia, { text: 'mais palavras' })
  t.is(again.status, 200)
  t.alike(again.body, { id: sent.body.id, duplicate: true }, 'the open appeal answers again')
  t.is(s.moderation.getAppeal(sent.body.id).text, 'foi um engano')
  t.is(s.server.modStats().spentAppealNonces, 3, 'spent by the three verified signatures (not blocked, first, duplicate), never by a refused one')

  const huge = await s.api('POST', '/account/appeal', { raw: '{"text":"' + 'a'.repeat(9000) + '"}' })
  t.is(huge.status, 413)
  noLeak(t, s)
})

test('appeals: the panel lists them, hides what a moderator may not judge, and decides', async (t) => {
  const s = await setup(t)
  const MOD_EMAIL = EMAIL_MOD.toLowerCase()
  // ana is blocked and published by another moderator; bia is blocked by
  // this moderator; carol is the moderator's own diary, blocked too.
  await blockAndPublish(s, s.ana, 'outra moderadora', 1)
  const biaReport = await sendReport(s, s.ana, s.bia.hex)
  await s.moderation.decide(biaReport.body.id, { decision: 'bloquear', by: MOD_EMAIL })
  const carolReport = await sendReport(s, s.ana, s.carol.hex)
  await s.moderation.decide(carolReport.body.id, { decision: 'bloquear', by: 'outra moderadora' })
  for (const m of [s.ana, s.bia, s.carol]) t.is((await sendAppeal(s, m)).status, 200)

  t.is((await s.api('GET', '/account/mod/api/appeals')).status, 401, 'a session is required')
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const me = await s.api('GET', '/account/mod/api/me', { cookie })
  t.is(me.body.appeals, 1, 'only ana\'s appeal is theirs to judge')

  const list = await s.api('GET', '/account/mod/api/appeals', { cookie })
  t.is(list.status, 200)
  t.is(list.body.appeals.length, 1, 'neither their own appeal nor the one about a block they decided')
  const row = list.body.appeals[0]
  t.is(row.member, s.ana.hex)
  t.is(row.username, 'ana')
  t.is(row.text, 'foi um engano')
  t.is(row.status, 'aberta')
  t.alike(row.bloqueios.map((b) => b.reason), ['spam'])
  t.alike(Object.keys(row).sort(), ['at', 'bloqueios', 'decidedAt', 'id', 'member', 'note', 'status', 'text', 'username'])
  for (const secret of [EMAIL_A, EMAIL_B, EMAIL_MOD, MOD_EMAIL, SUB_A, SUB_B, SUB_C, 'signature', 'outra moderadora']) t.absent(list.text.includes(secret), 'no ' + secret)
  t.is((await s.api('GET', '/account/mod/api/appeals?estado=x', { cookie })).status, 400)

  const biaAppeal = s.moderation.listAppeals().appeals.find((a) => a.member === s.bia.hex)
  const ownAppeal = s.moderation.listAppeals().appeals.find((a) => a.member === s.carol.hex)
  for (const hidden of [biaAppeal, ownAppeal]) {
    const res = await s.api('POST', '/account/mod/api/appeals/' + hidden.id + '/decide', { cookie, body: { decision: 'aceitar' } })
    t.is(res.status, 404, 'cannot decide it')
    t.is(s.moderation.getAppeal(hidden.id).status, 'aberta')
  }
  const noOrigin = await s.api('POST', '/account/mod/api/appeals/' + row.id + '/decide', { cookie, origin: null, body: { decision: 'aceitar' } })
  t.is(noOrigin.status, 403)
  const bad = await s.api('POST', '/account/mod/api/appeals/' + row.id + '/decide', { cookie, body: { decision: 'bloquear' } })
  t.alike(bad.body, { error: 'pedido-invalido' })
  t.is((await s.api('POST', '/account/mod/api/appeals/' + 'x'.repeat(22) + '/decide', { cookie, body: { decision: 'aceitar' } })).status, 404)

  const accepted = await s.api('POST', '/account/mod/api/appeals/' + row.id + '/decide', { cookie, body: { decision: 'aceitar', note: 'conferi' } })
  t.is(accepted.status, 200, accepted.text)
  t.is(accepted.body.appeal.status, 'aceito')
  t.is(accepted.body.appeal.note, 'conferi')
  t.is(accepted.body.change.op, 'unblock')
  t.is(accepted.body.change.member, s.ana.hex)
  t.absent(accepted.text.includes(MOD_EMAIL), 'no moderator e-mail')
  const again = await s.api('POST', '/account/mod/api/appeals/' + row.id + '/decide', { cookie, body: { decision: 'negar' } })
  t.is(again.status, 404, 'decided once')
  t.alike((await s.api('GET', '/account/mod/api/appeals', { cookie })).body.appeals, [])
  const history = await s.api('GET', '/account/mod/api/appeals?estado=decidida', { cookie })
  t.alike(history.body.appeals.map((a) => [a.id, a.status]), [[row.id, 'aceito']])
  const pending = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.ok(pending.body.pending.some((c) => c.op === 'unblock' && c.member === s.ana.hex), 'a pending unblock waits for the operator')
  t.ok(pending.body.blocked.some((b) => b.member === s.ana.hex), 'still listed until mod apply')
  noLeak(t, s)
})

test('appeals: negar closes the case and leaves the block', async (t) => {
  const s = await setup(t)
  await blockAndPublish(s, s.ana, 'outra moderadora', 1)
  const sent = await sendAppeal(s, s.ana)
  const { session } = await signIn(s)
  const cookie = sessionCookie(session)
  const denied = await s.api('POST', '/account/mod/api/appeals/' + sent.body.id + '/decide', { cookie, body: { decision: 'negar', note: 'mantido' } })
  t.is(denied.status, 200, denied.text)
  t.is(denied.body.appeal.status, 'negado')
  t.is(denied.body.change, null)
  t.alike(s.moderation.pending().changes, [])
  const again = await sendAppeal(s, s.ana)
  t.is(again.status, 429, 'one appeal per 30 days')
  t.alike(again.body, { error: 'limite-recursos' })
})
