'use strict'

// POST /account/report with kind 'dm' (docs/rpc.md 5.81): a private message
// report signed with verifyDmReport. The message is on no diary, so intake
// never asks the seeder; a block decision works like an account report.
// Loopback only: a fake Google and a stand-in seeder check on 127.0.0.1.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signDmReport, signReport } = require('@varanda/core/lib/report')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { createAccountServer } = require('../lib/account/server')
const { SESSION_COOKIE, LOGIN_COOKIE, ANEXO_LIST_LABEL, ANEXO_PROVENANCE } = require('../lib/account/mod-routes')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const SUB_A = '1111111111111111111111'
const SUB_B = '2222222222222222222222'
const SUB_C = '3333333333333333333333'
const EMAIL_MOD = 'moderadora@example.test'
const QUOTE = 'mensagem privada ofensiva'

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function fakeGoogle (t) {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      const idToken = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: SUB_C, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln'
      if (pathname === '/token') return json(res, 200, { access_token: 'ya29.teste', token_type: 'Bearer', expires_in: 3599, id_token: idToken })
      if (pathname === '/userinfo') return json(res, 200, { sub: SUB_C, email: EMAIL_MOD, email_verified: true })
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  return { endpoints: { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' } }
}

function keys () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

async function linkDirect (accounts, iss, m, username, sub, email) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

async function setup (t) {
  const root = tmpDir(t)
  const dir = path.join(root, 'account')
  const assoc = crypto.keyPair()
  const ikp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(ikp.publicKey, 'hex') }, assoc)
  const iss = { keyPair: ikp, cert, association: cert.association }
  const fake = await fakeGoogle(t)
  const accounts = openAccountStore(dir)
  const moderation = openModerationStore(dir, { association: iss.association })
  const ana = keys()
  const bia = keys()
  const carol = keys()
  await linkDirect(accounts, iss, ana, 'ana', SUB_A, 'ana@example.test')
  await linkDirect(accounts, iss, bia, 'bia', SUB_B, 'bia@example.test')
  await linkDirect(accounts, iss, carol, 'carol', SUB_C, EMAIL_MOD)
  // Every seeder contact is recorded: intake must make none.
  const seederCalls = []
  const groupCheck = {
    check: async (q) => { seederCalls.push(['check', q]); return { ok: false, code: 'config' } },
    checkDiary: async (q) => { seederCalls.push(['checkDiary', q]); return { ok: true } }
  }
  const triageCalls = []
  const triage = {
    onReport: (r) => triageCalls.push(r.id),
    onHumanDecision: () => {},
    onCancel: () => {},
    onUnblock: () => {},
    suggestionOf: () => null,
    verifiedOf: () => null
  }
  const panelDir = path.join(root, 'panel')
  fs.mkdirSync(panelDir)
  const logs = []
  const mk = (uri) => createGoogle({ clientId: CLIENT_ID, clientSecret: 'segredo', redirectUri: ORIGIN + uri, endpoints: fake.endpoints })
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google: mk('/account/callback'),
    store: accounts,
    issuer: null,
    log: (e) => logs.push(JSON.stringify(e)),
    moderation,
    googleMod: mk('/account/mod/callback'),
    modEmails: [EMAIL_MOD],
    triage,
    groupCheck,
    panelDir
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  async function api (method, pathname, { body, cookie } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }
  return { iss, moderation, api, ana, bia, carol, seederCalls, triageCalls, logs, dir, base }
}

// start + a signed DM statement; -> { fields, body } ready to POST.
async function dmBody (s, reporter, target, { quote = QUOTE, reason = 'assedio', text = '', signTarget } = {}) {
  const started = await s.api('POST', '/account/report/start', { body: { member: reporter.hex } })
  const nonce = started.body.nonce
  const fields = { nonce, member: reporter.hex, association: s.iss.association, target: signTarget || target, reason, text, quote }
  const signature = signDmReport(fields, reporter.kp)
  return { kind: 'dm', member: reporter.hex, nonce, target, reason, text, quote, signature }
}

function cookieValue (res, name) {
  for (const line of res.headers.getSetCookie()) {
    const m = new RegExp('^' + name + '=([^;]*);').exec(line)
    if (m) return m[1]
  }
  return null
}

async function signIn (s) {
  const login = await s.api('GET', '/account/mod/login')
  const state = new URL(login.headers.get('location')).searchParams.get('state')
  const cb = await s.api('GET', '/account/mod/callback?state=' + state + '&code=codigo-1', { cookie: LOGIN_COOKIE + '=' + cookieValue(login, LOGIN_COOKIE) })
  return SESSION_COOKIE + '=' + cookieValue(cb, SESSION_COOKIE)
}

async function settle () {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('dm report: a valid one is stored with the quote, reporter and sender target, without asking the seeder', async (t) => {
  const s = await setup(t)
  const body = await dmBody(s, s.ana, s.bia.hex)
  const r = await s.api('POST', '/account/report', { body })
  t.is(r.status, 200, r.text)
  t.is(r.body.duplicate, false)
  const row = s.moderation.get(r.body.id)
  t.is(row.kind, 'dm')
  t.is(row.reporter, s.ana.hex)
  t.is(row.target, s.bia.hex)
  t.is(row.quote, QUOTE)
  t.alike(Object.keys(row).sort(), ['at', 'blocked', 'decidedAt', 'decidedBy', 'id', 'kind', 'nonce', 'note', 'quote', 'reason', 'reporter', 'signature', 'status', 'target', 'text'])
  await settle()
  t.alike(s.seederCalls, [], 'intake never contacts the seeder')
  t.alike(s.triageCalls, [r.body.id], 'handed to the worker, which marks it for a human')
  t.absent(s.logs.join('\n').includes(QUOTE), 'the quote never reaches a log')
  const replay = await s.api('POST', '/account/report', { body })
  t.alike(replay.body, { error: 'expirado' }, 'the nonce is spent')
})

test('dm report: seq, writer, group, peer or a wrong statement are refused', async (t) => {
  const s = await setup(t)
  for (const extra of [{ seq: 1 }, { seq: null }, { writer: s.carol.hex }, { group: s.carol.hex }, { peer: s.bia.hex }]) {
    const body = await dmBody(s, s.ana, s.bia.hex)
    const r = await s.api('POST', '/account/report', { body: { ...body, ...extra } })
    t.alike(r.body, { error: 'pedido-invalido' }, JSON.stringify(Object.keys(extra)))
  }
  const own = await dmBody(s, s.ana, s.ana.hex, { signTarget: s.bia.hex })
  t.alike((await s.api('POST', '/account/report', { body: own })).body, { error: 'pedido-invalido' }, 'own key')
  const noTarget = await dmBody(s, s.ana, s.bia.hex)
  delete noTarget.target
  t.alike((await s.api('POST', '/account/report', { body: noTarget })).body, { error: 'pedido-invalido' }, 'no target')
  const wrong = await dmBody(s, s.ana, s.bia.hex, { signTarget: s.carol.hex })
  t.alike((await s.api('POST', '/account/report', { body: wrong })).body, { error: 'assinatura-invalida' }, 'signed for another target')
  const empty = await dmBody(s, s.ana, s.bia.hex)
  t.alike((await s.api('POST', '/account/report', { body: { ...empty, quote: '' } })).body, { error: 'assinatura-invalida' }, 'empty quote')
  // A post report's signature never passes as a dm one.
  const post = await dmBody(s, s.ana, s.bia.hex)
  post.signature = signReport({ nonce: post.nonce, member: s.ana.hex, association: s.iss.association, target: s.bia.hex, seq: null, reason: 'assedio', text: '', quote: '' }, s.ana.kp)
  t.alike((await s.api('POST', '/account/report', { body: post })).body, { error: 'assinatura-invalida' }, 'v1 signature')
  const unknownKind = await dmBody(s, s.ana, s.bia.hex)
  t.alike((await s.api('POST', '/account/report', { body: { ...unknownKind, kind: 'outra' } })).body, { error: 'pedido-invalido' }, 'unknown kind')
  t.is(s.moderation.stats().open, 0, 'nothing stored')
  t.alike(s.seederCalls, [], 'no seeder call')
})

test('dm report: the panel lists it with null post fields; Bloquear conta blocks the sender, Bloquear grupo is refused', async (t) => {
  const s = await setup(t)
  const r = await s.api('POST', '/account/report', { body: await dmBody(s, s.ana, s.bia.hex) })
  const cookie = await signIn(s)
  const list = await s.api('GET', '/account/mod/api/reports', { cookie })
  t.is(list.status, 200, list.text)
  const row = list.body.reports.find((x) => x.id === r.body.id)
  t.is(row.kind, 'dm')
  t.is(row.seq, null)
  t.is(row.writer, null)
  t.is(row.group, null)
  t.is(row.quote, QUOTE)
  t.is(row.reported.member, s.bia.hex)
  const grupo = await s.api('GET', '/account/mod/api/reports/' + r.body.id + '/grupo', { cookie })
  t.is(grupo.status, 404, 'no group lookup')
  const asGroup = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear', block: 'grupo' } })
  t.alike(asGroup.body, { error: 'pedido-invalido' })
  const block = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear' } })
  t.is(block.status, 200, block.text)
  t.is(block.body.change.member, s.bia.hex)
  t.is(block.body.change.kind, 'conta')
  t.alike(s.seederCalls.map(([k]) => k), ['checkDiary'], 'only the diary check every account block makes')
})

// A 1x1 GIF: the smallest image mediaBounds accepts.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const sha256 = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex')

// start + a dm v2 statement over `signBytes` (by default the bytes sent).
async function dmAnexoBody (s, reporter, target, bytes, { quote = '', signBytes = bytes } = {}) {
  const started = await s.api('POST', '/account/report/start', { body: { member: reporter.hex } })
  const nonce = started.body.nonce
  const fields = { nonce, member: reporter.hex, association: s.iss.association, target, reason: 'assedio', text: '', quote, anexo: sha256(signBytes) }
  const signature = signDmReport(fields, reporter.kp)
  return { kind: 'dm', member: reporter.hex, nonce, target, reason: 'assedio', text: '', quote, signature, anexo: bytes.toString('base64') }
}

test('dm report with anexo (v2): stored 0600 under the report id, listed com mídia, served from disk, never in a log', async (t) => {
  const s = await setup(t)
  const body = await dmAnexoBody(s, s.ana, s.bia.hex, GIF)
  const r = await s.api('POST', '/account/report/anexo', { body })
  t.is(r.status, 200, r.text)
  const row = s.moderation.get(r.body.id)
  t.is(row.quote, '', 'a media-only message quotes nothing')
  t.alike(row.anexo, { sha256: sha256(GIF), mime: 'image/gif', size: GIF.length })
  const file = path.join(s.dir, 'report-media', r.body.id)
  t.alike(fs.readFileSync(file), GIF)
  if (process.platform !== 'win32') {
    t.is(fs.statSync(file).mode & 0o777, 0o600, 'file 0600')
    t.is(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'dir 0700')
  }
  await settle()
  t.alike(s.triageCalls, [r.body.id], 'handed to the worker, which marks every dm for a human')
  t.alike(s.seederCalls, [], 'no seeder call')
  const cookie = await signIn(s)
  const list = await s.api('GET', '/account/mod/api/reports', { cookie })
  const listed = list.body.reports.find((x) => x.id === r.body.id)
  t.alike(listed.anexo, { mime: 'image/gif', size: GIF.length, label: ANEXO_LIST_LABEL, provenance: ANEXO_PROVENANCE })
  t.is(ANEXO_LIST_LABEL, 'com mídia')
  t.ok(ANEXO_PROVENANCE.includes('não conferida'))
  t.absent(list.text.includes(sha256(GIF)), 'the digest stays in the store')
  const img = await fetchRaw(s, '/account/mod/api/reports/' + r.body.id + '/anexo', cookie)
  t.is(img.status, 200)
  t.is(img.headers.get('content-type'), 'image/gif')
  t.is(img.headers.get('x-content-type-options'), 'nosniff')
  t.is(img.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  t.alike(img.bytes, GIF)
  t.is((await fetchRaw(s, '/account/mod/api/reports/' + r.body.id + '/anexo', null)).status, 401, 'session only')
  // A tampered file is never served.
  fs.writeFileSync(file, Buffer.concat([GIF, Buffer.from([0])]))
  t.is((await fetchRaw(s, '/account/mod/api/reports/' + r.body.id + '/anexo', cookie)).status, 404)
  const logs = s.logs.join('\n')
  for (const secret of [GIF.toString('base64'), sha256(GIF), r.body.id]) t.absent(logs.includes(secret), 'not in logs')
  // The row with its anexo survives a reopen of moderation.json.
  const reopened = openModerationStore(s.dir, { association: s.iss.association })
  t.alike(reopened.get(r.body.id).anexo, row.anexo, 'reopened')
})

test('dm report with anexo: digest mismatch, png, junk, plain route, and 2 MiB are refused; v1 still verifies', async (t) => {
  const s = await setup(t)
  const mismatch = await dmAnexoBody(s, s.ana, s.bia.hex, GIF, { signBytes: Buffer.from('outra imagem') })
  t.alike((await s.api('POST', '/account/report/anexo', { body: mismatch })).body, { error: 'assinatura-invalida' }, 'signed over another digest')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const asPng = await dmAnexoBody(s, s.ana, s.bia.hex, png)
  t.alike((await s.api('POST', '/account/report/anexo', { body: asPng })).body, { error: 'pedido-invalido' }, 'png refused')
  const junk = await dmAnexoBody(s, s.ana, s.bia.hex, Buffer.from('não é imagem'))
  t.alike((await s.api('POST', '/account/report/anexo', { body: junk })).body, { error: 'pedido-invalido' }, 'not an image')
  // Only this route reads past REPORT_BODY_MAX: 600 KiB of junk is read and refused as junk.
  const midJunk = await dmAnexoBody(s, s.ana, s.bia.hex, Buffer.alloc(600 * 1024, 0x41))
  const mid = await s.api('POST', '/account/report/anexo', { body: midJunk })
  t.alike([mid.status, mid.body], [400, { error: 'pedido-invalido' }], 'a large body is read on the anexo route')
  t.is(await declaredPost(s, '/account/report', JSON.stringify(midJunk)), 413, '/account/report keeps its cap')
  const plain = await dmAnexoBody(s, s.ana, s.bia.hex, GIF)
  t.alike((await s.api('POST', '/account/report', { body: plain })).body, { error: 'pedido-invalido' }, 'no anexo on /account/report')
  const missing = await dmAnexoBody(s, s.ana, s.bia.hex, GIF)
  delete missing.anexo
  t.alike((await s.api('POST', '/account/report/anexo', { body: missing })).body, { error: 'pedido-invalido' }, 'the anexo route needs one')
  const huge = Buffer.alloc(2 * 1048576, 0x41)
  const big = await declaredPost(s, '/account/report/anexo', JSON.stringify({ kind: 'dm', member: s.ana.hex, anexo: huge.toString('base64') }))
  t.is(big, 413, 'a 2 MiB anexo answers 413')
  t.is(s.moderation.stats().open, 0, 'nothing stored')
  t.absent(fs.existsSync(path.join(s.dir, 'report-media')) && fs.readdirSync(path.join(s.dir, 'report-media')).length > 0, 'no media written')
  // v1, unchanged, still lands through /account/report.
  const v1 = await s.api('POST', '/account/report', { body: await dmBody(s, s.ana, s.bia.hex) })
  t.is(v1.status, 200, v1.text)
  t.absent(Object.hasOwn(s.moderation.get(v1.body.id), 'anexo'))
})

test('group message report with anexo (v3): stored, never handed to the AI triage', async (t) => {
  const s = await setup(t)
  const started = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
  const nonce = started.body.nonce
  const writer = 'a1'.repeat(32)
  const group = 'b2'.repeat(32)
  const fields = { nonce, member: s.ana.hex, association: s.iss.association, target: s.bia.hex, seq: 3, writer, group, reason: 'outro', text: '', quote: '', anexo: sha256(GIF) }
  const signature = signReport(fields, s.ana.kp)
  const body = { member: s.ana.hex, nonce, target: s.bia.hex, seq: 3, writer, group, reason: 'outro', text: '', quote: '', signature, anexo: GIF.toString('base64') }
  const r = await s.api('POST', '/account/report/anexo', { body })
  t.is(r.status, 200, r.text)
  t.is(s.moderation.get(r.body.id).anexo.mime, 'image/gif')
  await settle()
  t.alike(s.triageCalls, [], 'a person decides it')
  // A diary post never carries an anexo.
  const s2 = await s.api('POST', '/account/report/start', { body: { member: s.ana.hex } })
  const post = { member: s.ana.hex, nonce: s2.body.nonce, target: s.bia.hex, seq: 3, reason: 'outro', text: '', quote: '', signature, anexo: GIF.toString('base64') }
  t.alike((await s.api('POST', '/account/report/anexo', { body: post })).body, { error: 'pedido-invalido' })
})

test('report with anexo: the nonce is checked before the attachment is decoded', async (t) => {
  const s = await setup(t)
  // Junk bytes would answer pedido-invalido once decoded: 'expirado' says
  // the request stopped at the nonce, before any decode, sniff or hash.
  const junk = await dmAnexoBody(s, s.ana, s.bia.hex, Buffer.alloc(600 * 1024, 0x41))
  const forged = { ...junk, nonce: 'A'.repeat(junk.nonce.length) }
  const r1 = await s.api('POST', '/account/report/anexo', { body: forged })
  t.alike([r1.status, r1.body], [400, { error: 'expirado' }], 'forged nonce, junk anexo')
  const other = { ...junk, member: s.bia.hex, target: s.ana.hex }
  t.alike((await s.api('POST', '/account/report/anexo', { body: other })).body, { error: 'expirado' }, 'another member\'s nonce')
  const landed = await dmAnexoBody(s, s.ana, s.bia.hex, GIF)
  t.is((await s.api('POST', '/account/report/anexo', { body: landed })).status, 200)
  const spent = { ...landed, anexo: Buffer.from('não é imagem').toString('base64') }
  t.alike((await s.api('POST', '/account/report/anexo', { body: spent })).body, { error: 'expirado' }, 'spent nonce')
  // A valid nonce still reaches the decode, which refuses the junk.
  t.alike((await s.api('POST', '/account/report/anexo', { body: junk })).body, { error: 'pedido-invalido' }, 'valid nonce, junk anexo')
  const notString = { ...forged, anexo: 12 }
  t.alike((await s.api('POST', '/account/report/anexo', { body: notString })).body, { error: 'pedido-invalido' }, 'shape checked first')
  t.is(s.moderation.stats().open, 1, 'only the valid report stored')
})

// An anexo POST over a raw socket that sends `first` and then nothing more
// (or ends there with `end`). -> { done } resolving to the status, or to
// 'cut' when the server drops the connection without an answer.
function rawAnexoPost (s, headers, first, { end = false } = {}) {
  const req = http.request(s.base + '/account/report/anexo', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }
  })
  const done = new Promise((resolve) => {
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        resolve({ status: res.statusCode, body })
      })
      res.on('error', () => resolve({ status: res.statusCode, body: null }))
    })
    req.on('error', () => resolve('cut'))
  })
  req.write(first)
  if (end) req.end()
  return { req, done }
}

test('report with anexo: a body without Content-Length is refused before any slot', async (t) => {
  const s = await setup(t)
  const body = JSON.stringify(await dmAnexoBody(s, s.ana, s.bia.hex, GIF))
  const chunked = await rawAnexoPost(s, {}, body, { end: true }).done
  t.alike(chunked, { status: 411, body: { error: 'pedido-invalido' } }, 'chunked body refused')
  t.is(s.moderation.stats().open, 0, 'nothing stored')
  // The same body with its length lands.
  const r = await s.api('POST', '/account/report/anexo', { body: JSON.parse(body) })
  t.is(r.status, 200, r.text)
})

test('report with anexo: a stalled body is cut and its slot serves the next report', async (t) => {
  const s = await setup(t)
  const started = Date.now()
  const stalled = []
  // Declared long enough (1 MB: a 10 s deadline) that the idle cut acts first.
  for (let i = 0; i < 4; i++) stalled.push(rawAnexoPost(s, { 'content-length': 1000000 }, '{"kind":"dm"'))
  // Every slot is held by a body that stopped sending.
  await settle()
  const fifth = await s.api('POST', '/account/report/anexo', { body: await dmAnexoBody(s, s.ana, s.bia.hex, GIF) })
  t.alike(fifth.body, { error: 'limite' }, 'all four slots taken')
  const ends = await Promise.all(stalled.map((x) => x.done))
  const elapsed = Date.now() - started
  for (const e of ends) t.ok(e === 'cut' || e.status === 408, 'cut by the server')
  t.ok(elapsed >= 4500, 'after the idle cut (' + elapsed + ' ms)')
  t.ok(elapsed < 8000, 'before the deadline and the service request timeout (' + elapsed + ' ms)')
  const r = await s.api('POST', '/account/report/anexo', { body: await dmAnexoBody(s, s.ana, s.bia.hex, GIF) })
  t.is(r.status, 200, r.text)
  t.alike(s.moderation.get(r.body.id).anexo, { sha256: sha256(GIF), mime: 'image/gif', size: GIF.length }, 'stored with its anexo')
})

test('report with anexo: a body that drips past its deadline is cut', async (t) => {
  const s = await setup(t)
  const started = Date.now()
  // 8000 bytes declared: a deadline of 2 s plus 64 ms. A byte every 400 ms
  // keeps the idle cut away, so only the deadline can end it.
  const drip = rawAnexoPost(s, { 'content-length': 8000 }, '{')
  const timer = setInterval(() => { if (!drip.req.destroyed) drip.req.write(' ') }, 400)
  const end = await drip.done
  clearInterval(timer)
  const elapsed = Date.now() - started
  t.ok(end === 'cut' || end.status === 408, 'cut by the server')
  t.ok(elapsed >= 1900 && elapsed < 4500, 'at the deadline (' + elapsed + ' ms)')
  const r = await s.api('POST', '/account/report/anexo', { body: await dmAnexoBody(s, s.ana, s.bia.hex, GIF) })
  t.is(r.status, 200, 'the slot is free again')
})

test('report with anexo: a bad signature spends the nonce', async (t) => {
  const s = await setup(t)
  const bad = await dmAnexoBody(s, s.ana, s.bia.hex, GIF, { signBytes: Buffer.from('outra imagem') })
  t.alike((await s.api('POST', '/account/report/anexo', { body: bad })).body, { error: 'assinatura-invalida' })
  const fields = { nonce: bad.nonce, member: s.ana.hex, association: s.iss.association, target: s.bia.hex, reason: 'assedio', text: '', quote: '', anexo: sha256(GIF) }
  const good = { ...bad, signature: signDmReport(fields, s.ana.kp) }
  t.alike((await s.api('POST', '/account/report/anexo', { body: good })).body, { error: 'expirado' }, 'the same nonce is refused as spent')
  t.is(s.moderation.stats().open, 0, 'nothing stored')
})

test('panel image loads have their own window: many in one minute leave the list and decide their allowance', async (t) => {
  const s = await setup(t)
  const r = await s.api('POST', '/account/report/anexo', { body: await dmAnexoBody(s, s.ana, s.bia.hex, GIF) })
  t.is(r.status, 200, r.text)
  const cookie = await signIn(s)
  const statuses = new Set()
  for (let i = 0; i < 70; i++) statuses.add((await fetchRaw(s, '/account/mod/api/reports/' + r.body.id + '/anexo', cookie)).status)
  t.alike([...statuses], [200], '70 image loads in a minute all answer')
  const list = await s.api('GET', '/account/mod/api/reports', { cookie })
  t.is(list.status, 200, 'the list keeps its allowance')
  const block = await s.api('POST', '/account/mod/api/reports/' + r.body.id + '/decide', { cookie, body: { decision: 'bloquear' } })
  t.is(block.status, 200, block.text)
})

// Declares the whole body but sends only its start: the 413 must come
// before the server reads it. -> the status.
function declaredPost (s, pathname, text) {
  return new Promise((resolve, reject) => {
    const req = http.request(s.base + pathname, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }
    }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.write(text.slice(0, 1024))
  })
}

async function fetchRaw (s, pathname, cookie) {
  const base = s.base
  const res = await fetch(base + pathname, { headers: cookie ? { cookie } : {} })
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
}

// The panel (panel/app.js) under a minimal fake DOM, as panel.test.js does.
class FakeNode {
  constructor (tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.attributes = {}
    this.listeners = {}
    this.className = ''
    this.disabled = false
    this.value = ''
    this._text = ''
  }

  set textContent (v) { this.children = []; this._text = String(v) }
  get textContent () { return this._text + this.children.map((c) => c.textContent).join('') }
  appendChild (c) { this.children.push(c); return c }
  replaceChildren () { this.children = []; this._text = '' }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return Object.hasOwn(this.attributes, k) ? this.attributes[k] : null }
  addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
}

function walk (node, out = []) {
  out.push(node)
  for (const c of node.children) walk(c, out)
  return out
}

test('panel: a dm report shows the quote as untrusted text with its label, the sender account and Bloquear conta only', async (t) => {
  const panel = require('../lib/account/panel/app')
  const SENDER = 'd4'.repeat(32)
  const REPORTER = 'e5'.repeat(32)
  const main = new FakeNode('main')
  const document = { getElementById: (id) => (id === 'app' ? main : null), createElement: (tag) => new FakeNode(tag), write: () => { throw new Error('no write') } }
  const row = {
    id: 'r1abcdefghijklmnopqrst',
    at: '2026-11-03T12:00:00.000Z',
    kind: 'dm',
    target: SENDER,
    seq: null,
    writer: null,
    group: null,
    quote: QUOTE + ' <b>x',
    reason: 'assedio',
    text: '',
    reporter: { member: REPORTER, username: 'ana' },
    reported: { member: SENDER, username: 'bia', linked: true },
    status: 'aberta',
    decidedAt: null,
    note: '',
    actor: null,
    ia: null,
    publicacao: null
  }
  const routes = {
    'GET /account/mod/api/me': [200, { email: EMAIL_MOD, published: null, open: 1, pending: 0 }],
    'GET /account/mod/api/reports?estado=aberta': [200, { reports: [row], truncated: false }],
    'GET /account/mod/api/reports?estado=decidida': [200, { reports: [], truncated: false }],
    'GET /account/mod/api/blocked': [200, { published: null, blocked: [], pending: [] }],
    'GET /account/mod/api/reports/r1abcdefghijklmnopqrst/alvo': [200, { confirmed: true }]
  }
  const asked = []
  const fetch = async (url, opts) => {
    asked.push(opts.method + ' ' + url)
    const [status, body] = routes[opts.method + ' ' + url] || [404, { error: 'nao-encontrado' }]
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  }
  const p = panel.createPanel({ document, fetch, location: { search: '', pathname: '/account/mod/', assign: () => {} }, history: { replaceState: () => {} }, confirm: () => true })
  await p.start()
  await p.settled()
  const nodes = walk(main)
  const quote = nodes.find((n) => n.tagName === 'BLOCKQUOTE')
  t.ok(quote, 'a quote node')
  t.is(quote.className, 'untrusted')
  t.is(quote.textContent, QUOTE + ' <b>x', 'as text')
  t.ok(nodes.some((n) => n.className === 'label' && n.textContent === panel.TEXT.dmQuoteLabel), 'labelled as unverified private message')
  t.ok(panel.TEXT.dmQuoteLabel.includes('não conferido'))
  t.absent(nodes.some((n) => n.textContent === panel.TEXT.quoteLabel), 'not the post quote label')
  t.absent(nodes.some((n) => n.textContent === panel.TEXT.groupSealedQuote), 'not the group label')
  const buttons = nodes.filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent)
  t.ok(buttons.includes('Bloquear conta'))
  t.ok(buttons.includes('Descartar'))
  t.absent(buttons.includes('Bloquear grupo'))
  t.ok(nodes.some((n) => n.textContent === 'denunciada: @bia'), 'the sender account is shown')
  t.ok(nodes.some((n) => n.className === 'meta' && n.textContent.includes('mensagem privada')))
  t.absent(asked.some((u) => u.endsWith('/grupo')), 'no group lookup')
})
