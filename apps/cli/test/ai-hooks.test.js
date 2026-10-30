'use strict'

// The AI report triage's hooks into the moderation desk
// (apps/cli/lib/account/mod-routes.js): onReport, onHumanDecision, onCancel
// and onUnblock run only after the HTTP answer went out, are never awaited,
// and a throw (or a promise that never settles) changes neither the status
// nor the body; the panel's projection carries `actor`, `ia`, `publicacao`
// and `byAi` but never an e-mail; the operator's pull carries `actor`. A
// fake worker stands in for apps/cli/lib/account/ai/worker.js. The harness
// is the one of account-mod.test.js (loopback service, loopback fake
// Google, random key pairs); no socket leaves 127.0.0.1.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createModeratorCert } = require('@varanda/core/lib/cert')
const { signReport } = require('@varanda/core/lib/report')
const { signModRequest, canonicalBody } = require('@varanda/core/lib/mod-request')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore, AI_ACTOR } = require('../lib/account/moderation-store')
const { createAccountServer } = require('../lib/account/server')
const { SESSION_COOKIE, LOGIN_COOKIE } = require('../lib/account/mod-routes')
const { tmpDir, until } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-de-teste'
const SUB_A = '1111111111111111111111'
const SUB_B = '2222222222222222222222'
const SUB_C = '3333333333333333333333'
const EMAIL_A = 'ana@example.test'
const EMAIL_B = 'bia@example.test'
const EMAIL_MOD = 'moderadora@example.test'

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
  const account = { sub: SUB_C, email: EMAIL_MOD }
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
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
  return { account, endpoints }
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

// A stand-in worker: records every hook call; `throwOn` names hooks that
// throw, `hangOn` hooks whose promise never settles.
function fakeTriage ({ throwOn = [], hangOn = [] } = {}) {
  const calls = { onReport: [], onHumanDecision: [], onCancel: [], onUnblock: [] }
  const triage = { calls }
  for (const name of Object.keys(calls)) {
    triage[name] = (arg) => {
      calls[name].push(arg)
      if (throwOn.includes(name)) throw new Error('falhou com texto que não pode vazar')
      if (hangOn.includes(name)) return new Promise(() => {})
    }
  }
  triage.suggestionOf = (id) => ({ sugestao: null, semelhanca: 0.5, vizinhos: 3, motivo: 'frio', modo: 'sombra' })
  triage.verifiedOf = (id) => ({ texto: 'publicação verificada', midia: false, citacao: false })
  return triage
}

async function setup (t, { triage = null } = {}) {
  const root = tmpDir(t)
  const dir = path.join(root, 'account')
  const iss = issuer()
  const fake = await fakeGoogle(t)
  const accounts = openAccountStore(dir)
  const moderation = openModerationStore(dir, { association: iss.association })
  const ana = keys()
  const bia = keys()
  const carol = keys()
  await linkDirect(accounts, iss, ana, 'ana', SUB_A, EMAIL_A)
  await linkDirect(accounts, iss, bia, 'bia', SUB_B, EMAIL_B)
  await linkDirect(accounts, iss, carol, 'carol', SUB_C, EMAIL_MOD)
  const google = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: fake.endpoints })
  const googleMod = createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/mod/callback', endpoints: fake.endpoints })
  const panelDir = path.join(root, 'panel')
  fs.mkdirSync(panelDir)
  const logs = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store: accounts,
    issuer: null,
    log: (e) => logs.push(JSON.stringify(e)),
    moderation,
    googleMod,
    modEmails: [EMAIL_MOD],
    triage,
    // Every diary is a served diary here: the seeder check is covered in
    // account-mod.test.js, not in these hooks.
    groupCheck: { check: async () => ({ ok: false, code: 'config' }), checkDiary: async () => ({ ok: true }) },
    panelDir
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function api (method, pathname, { body, cookie, origin = ORIGIN } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined) {
      if (origin !== null) init.headers.origin = origin
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  return { dir, iss, fake, accounts, moderation, logs, api, ana, bia, carol }
}

async function sendReport (s, reporter, target, { seq = null, reason = 'spam', quote = '' } = {}) {
  const started = await s.api('POST', '/account/report/start', { body: { member: reporter.hex } })
  const nonce = started.body.nonce
  const fields = { nonce, member: reporter.hex, association: s.iss.association, target, seq, reason, text: 'texto da denúncia', quote }
  const signature = signReport(fields, reporter.kp)
  return s.api('POST', '/account/report', { body: { member: reporter.hex, nonce, target, seq, reason, text: fields.text, quote, signature } })
}

function cookieFrom (res, name) {
  for (const line of res.headers.getSetCookie()) {
    const m = new RegExp('^' + name + '=([^;]*);').exec(line)
    if (m) return m[1]
  }
  return null
}

async function signIn (s) {
  const login = await s.api('GET', '/account/mod/login')
  const state = new URL(login.headers.get('location')).searchParams.get('state')
  const cb = await s.api('GET', '/account/mod/callback?state=' + state + '&code=codigo-1', { cookie: LOGIN_COOKIE + '=' + cookieFrom(login, LOGIN_COOKIE) })
  return SESSION_COOKIE + '=' + cookieFrom(cb, SESSION_COOKIE)
}

async function operatorPull (s) {
  const modKeys = keys()
  const modCert = createModeratorCert({ moderator: modKeys.hex, date: '2026-10-01T00:00:00.000Z' }, s.iss.assoc)
  const nonce = (await s.api('GET', '/account/mod/api/challenge?moderator=' + modKeys.hex + '&op=pull')).body.nonce
  const signature = signModRequest({ origin: ORIGIN, association: s.iss.association, moderator: modKeys.hex, nonce, op: 'pull', body: canonicalBody('pull') }, modKeys.kp)
  return s.api('POST', '/account/mod/api/pull', { origin: null, body: { cert: modCert, nonce, signature } })
}

test('hooks: a throwing onReport still answers 200 with an open row; a duplicate never reaches the triage', async (t) => {
  const triage = fakeTriage({ throwOn: ['onReport'] })
  const s = await setup(t, { triage })
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 2, quote: 'algo' })
  t.is(r.status, 200, r.text)
  t.alike(Object.keys(r.body).sort(), ['duplicate', 'id'])
  t.is(s.moderation.get(r.body.id).status, 'aberta')
  await until(() => s.logs.some((l) => l === JSON.stringify({ event: 'triage', reason: 'erro' })), { name: 'erro logged' })
  t.is(triage.calls.onReport.length, 1)
  t.is(triage.calls.onReport[0].id, r.body.id, 'the store row')
  t.absent(s.logs.join('\n').includes('vazar'), 'the error text is never logged')

  // A retry with a fresh nonce lands on the same open row: a duplicate.
  const again = await sendReport(s, s.ana, s.bia.hex, { seq: 2, quote: 'algo' })
  t.is(again.status, 200)
  t.is(again.body.duplicate, true)
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(triage.calls.onReport.length, 1, 'no hook for a duplicate')
})

test('hooks: an onReport that never settles does not hold the answer', async (t) => {
  const triage = fakeTriage({ hangOn: ['onReport'] })
  const s = await setup(t, { triage })
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 3 })
  t.is(r.status, 200, r.text)
  t.is(r.body.duplicate, false)
  t.is(triage.calls.onReport.length, 1)
})

test('hooks: panel decide, cancel and unblock reach the worker after the answer; projection fields', async (t) => {
  const triage = fakeTriage({ throwOn: ['onHumanDecision', 'onCancel', 'onUnblock'] })
  const s = await setup(t, { triage })
  const r1 = await sendReport(s, s.ana, s.bia.hex, { seq: 2 })
  const r2 = await sendReport(s, s.bia, s.ana.hex, { seq: 4 })
  const cookie = await signIn(s)

  const open = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  t.is(open.status, 200)
  const row = open.body.reports.find((x) => x.id === r1.body.id)
  t.is(row.actor, null, 'nobody decided an open report')
  t.alike(row.ia, { sugestao: null, semelhanca: 0.5, vizinhos: 3, motivo: 'frio', modo: 'sombra' })
  t.alike(row.publicacao, { texto: 'publicação verificada', midia: false, citacao: false })
  t.absent('decidedBy' in row)

  // A body field naming the AI is ignored: the moderator decides.
  const decided = await s.api('POST', '/account/mod/api/reports/' + r1.body.id + '/decide', { cookie, body: { decision: 'bloquear', note: '', by: AI_ACTOR } })
  t.is(decided.status, 200, decided.text)
  t.is(decided.body.report.actor, 'pessoa')
  t.is(decided.body.change.byAi, false)
  t.absent(decided.text.includes('@'), 'no e-mail in the decide answer')
  await until(() => triage.calls.onHumanDecision.length === 1, { name: 'onHumanDecision' })
  t.is(triage.calls.onHumanDecision[0].id, r1.body.id)
  t.is(triage.calls.onHumanDecision[0].decidedBy, EMAIL_MOD, 'the store row: decided by the moderator')

  // Cancel: the worker receives the change as it was, with its reportIds.
  const change = s.moderation.pending().changes.find((c) => c.member === s.bia.hex)
  const cancelled = await s.api('POST', '/account/mod/api/pending/' + change.id + '/cancel', { cookie, body: {} })
  t.is(cancelled.status, 200, cancelled.text)
  await until(() => triage.calls.onCancel.length === 1, { name: 'onCancel' })
  t.is(triage.calls.onCancel[0].id, change.id)
  t.alike(triage.calls.onCancel[0].reportIds, [r1.body.id])

  // Unblock: a pending block of ana, then a panel unblock of ana.
  await s.api('POST', '/account/mod/api/reports/' + r2.body.id + '/decide', { cookie, body: { decision: 'bloquear', note: '' } })
  const unblocked = await s.api('POST', '/account/mod/api/unblock', { cookie, body: { member: s.ana.hex } })
  t.is(unblocked.status, 200, unblocked.text)
  await until(() => triage.calls.onUnblock.length === 1, { name: 'onUnblock' })
  t.is(triage.calls.onUnblock[0], s.ana.hex)

  await until(() => s.logs.filter((l) => l === JSON.stringify({ event: 'triage', reason: 'erro' })).length === 4, { name: 'four erro tokens' })
  const text = s.logs.join('\n')
  t.absent(text.includes('@') || text.includes('vazar'), 'logs: tokens only')
})

test('hooks: an AI decision projects actor ia, byAi true and pull actor ia, never an e-mail', async (t) => {
  const s = await setup(t, { triage: fakeTriage() })
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 5 })
  const own = await sendReport(s, s.ana, s.carol.hex, { seq: 6 })
  await s.moderation.decide(r.body.id, { decision: 'bloquear', by: AI_ACTOR, note: 'IA: parecido' })
  await s.moderation.decide(own.body.id, { decision: 'bloquear', by: AI_ACTOR, note: 'IA: parecido' })
  const cookie = await signIn(s)

  const decided = await s.api('GET', '/account/mod/api/reports?estado=decidida', { cookie })
  t.is(decided.status, 200)
  t.is(decided.body.reports.length, 1, 'an AI-decided case about the moderator\'s own diary stays hidden')
  t.is(decided.body.reports[0].id, r.body.id)
  t.is(decided.body.reports[0].actor, 'ia')
  t.absent('decidedBy' in decided.body.reports[0])

  const blocked = await s.api('GET', '/account/mod/api/blocked', { cookie })
  t.is(blocked.body.pending.length, 1)
  t.is(blocked.body.pending[0].byAi, true)

  const pull = await operatorPull(s)
  t.is(pull.status, 200, pull.text)
  const mine = pull.body.changes.find((c) => c.member === s.bia.hex)
  t.alike(Object.keys(mine), ['id', 'op', 'member', 'at', 'actor'])
  t.is(mine.actor, 'ia')
  for (const res of [decided, blocked, pull]) t.absent(res.text.includes('@'), 'no e-mail in any body')
})

test('hooks: with the triage off the projection carries ia and publicacao as null', async (t) => {
  const s = await setup(t)
  const r = await sendReport(s, s.ana, s.bia.hex, { seq: 7 })
  t.is(r.status, 200)
  const cookie = await signIn(s)
  const open = await s.api('GET', '/account/mod/api/reports?estado=aberta', { cookie })
  t.is(open.body.reports[0].ia, null)
  t.is(open.body.reports[0].publicacao, null)
  t.is(open.body.reports[0].actor, null)
  t.absent(s.logs.some((l) => l.includes('triage')), 'no triage log when off')
})
