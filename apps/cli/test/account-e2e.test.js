'use strict'

// End to end, loopback only: the Google account link (B1) from the browser
// session to a CLI follower. The pieces: an association (CLI), an issuer key
// certified by it (`account key`, `assoc certify-issuer`, `account cert add`),
// a fake Google on 127.0.0.1 (/auth answers 302 back to the callback with a
// code, /token checks PKCE, /userinfo), the account service in-process
// (createAccountServer over a temp data dir, with an injectable clock for
// the 7-day rename cooldown), a seeder (`seed --ws-port`), a browser node
// session over memory storage holding a random key pair (as the page holds
// the passkey-derived one) and a CLI member (Hypercore 11) that follows the
// web diary through the seeder.
// What is proven here and nowhere else: the account-link statements the
// session signs (account.sign) are the ones the service verifies; the v2
// certificate it issues is admitted by the seeder and recovered by a second
// device; the username record the session appends reaches a follower's
// `feed --json`, and so does a rename once the cooldown has passed; the
// terms statement the session signs (terms.sign) is the one the service
// verifies and records in terms.json, without touching the diary or storing
// any personal data.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createClient, parseMessage, EVENTS, MAX_MESSAGE } = require('@varanda/rpc')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, loadAssociationKeyPair, certForKey, verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore, COOLDOWN_MS } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { createAccountServer, loadIssuer, COOKIE } = require('../lib/account/server')
// The browser node lives in packages/web-member; apps/cli does not depend
// on it, so it is reached by path (as passkey-e2e.test.js reaches this BIN).
const { createBrowserNode } = require('../../../packages/web-member/lib/node')
const { memoryNodeStorage } = require('../../../packages/web-member/lib/node-storage')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-e2e.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-e2e'
// A 22-digit subject: any leak shows up as a plain substring.
const SUB = '2098765432109876543210'
const EMAIL = 'membro-e2e@example.test'
const ACCESS = 'ya29.access-token-e2e'
const CODE = 'codigo-e2e-1'
const HOUR = 3600 * 1000

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function jsonLines (stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((v) => v !== null)
}

// The CLI as a child process; killed in teardown if still running.
function varanda (t, args) {
  const child = spawn(process.execPath, [BIN, ...args], { env })
  const proc = { stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  proc.exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(proc) }))
  proc.kill = () => child.kill('SIGTERM')
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await proc.exited
    }
  }, { force: true })
  return proc
}

// Runs the CLI to completion, expects exit 0; -> the last JSON line.
async function run (t, args) {
  const proc = await varanda(t, args).exited
  t.is(proc.code, 0, args.slice(0, 2).join(' ') + ' ' + proc.stderr)
  const lines = jsonLines(proc.stdout)
  return lines[lines.length - 1]
}

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody (req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

// Fake Google on 127.0.0.1. /auth remembers the PKCE challenge and answers
// 302 to redirect_uri with a code and the same state (the consent screen
// skipped); /token answers only for that code and a verifier whose S256
// matches the challenge; /userinfo answers the account.
async function fakeGoogle (t) {
  const seen = []
  let challenge = null
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url, 'http://127.0.0.1')
    seen.push(url.pathname)
    if (req.method === 'GET' && url.pathname === '/auth') {
      challenge = url.searchParams.get('code_challenge')
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.search = new URLSearchParams({ code: CODE, state: url.searchParams.get('state') }).toString()
      res.writeHead(302, { Location: back.toString(), 'Content-Length': 0 })
      return res.end()
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(body)
      const verifier = form.get('code_verifier') || ''
      const s256 = nodeCrypto.createHash('sha256').update(verifier).digest('base64url')
      if (form.get('code') !== CODE || challenge === null || s256 !== challenge || form.get('client_secret') !== CLIENT_SECRET) {
        return json(res, 400, { error: 'invalid_grant' })
      }
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: SUB, exp: Math.floor(Date.now() / 1000) + 3600 }
      const idToken = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(claims) + '.c2ln'
      return json(res, 200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3599, id_token: idToken })
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer ' + ACCESS) return json(res, 401, { error: 'invalid_token' })
      return json(res, 200, { sub: SUB, email: EMAIL, email_verified: true })
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  const endpoints = { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' }
  // The service's fetch: anything but the fake is a test failure.
  const fetch = (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
  return { base, endpoints, fetch, seen, tokenCalls: () => seen.filter((p) => p === '/token').length }
}

// The browser side of the account service: a cookie jar holding the one
// cookie the service sets, JSON bodies, the page's Origin on POSTs and
// redirects never followed. -> { status, location, body }.
function accountClient (base) {
  const jar = { cookie: null }
  async function api (method, pathname, { body, withCookie = true } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (withCookie && jar.cookie !== null) init.headers.cookie = COOKIE + '=' + jar.cookie
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const setCookie = res.headers.get('set-cookie')
    const m = /^__Host-varanda-link=([A-Za-z0-9_-]+);.*Max-Age=(\d+)$/.exec(setCookie || '')
    if (m) jar.cookie = m[2] === '0' ? null : m[1]
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, location: res.headers.get('location'), body: parsed }
  }
  // A redirect to the public origin, delivered to the loopback service as
  // the browser would deliver it to the public host.
  function local (location) {
    const url = new URL(location)
    if (url.origin !== ORIGIN) throw new Error('redirect to another origin')
    return url.pathname + url.search
  }
  return { jar, api, local }
}

// The page's in-memory client, wired to the node as apps/app wires it (JSON
// text both ways on a microtask), recording every event (as
// packages/web-member/test/helpers/session.js).
async function connectClient (node) {
  const events = []
  let port = null
  const client = createClient({
    send: (message, text) => queueMicrotask(() => { if (port !== null) port.receive(text) }),
    timeoutMs: 60000
  })
  port = node.connect((text) => queueMicrotask(() => {
    const parsed = parseMessage(text, MAX_MESSAGE)
    if (parsed.ok) client.receive(parsed.value)
  }), { onClose: () => client.close() })
  for (const name of EVENTS) client.on(name, (data) => events.push({ name, data }))
  await client.request('session.open', {})
  return { events, request: (method, params = {}) => client.request(method, params) }
}

async function stoppedOf (events, runId, timeoutMs = 60000) {
  return until(() => {
    const ev = events.find((e) => e.name === 'sync.stopped' && e.data.runId === runId)
    return ev ? ev.data : null
  }, { name: 'sync.stopped ' + runId, timeoutMs })
}

// The sync.stopped data of every run started since event index `from`.
async function runsSince (web, from) {
  const out = []
  for (const e of web.events.slice(from)) {
    if (e.name !== 'sync.started') continue
    const lines = web.events.filter((x) => x.name === 'sync.event' && x.data.runId === e.data.runId).map((x) => x.data.line)
    out.push({ lines, stopped: await stoppedOf(web.events, e.data.runId) })
  }
  return out
}

// A gated write (packages/web-member/lib/session.js ensureCaughtUp and
// pushAfterWrite): its push run must end with the seeder holding the diary.
async function gatedWrite (t, web, method, params, label) {
  const from = web.events.length
  const result = await web.request(method, params)
  const runs = await runsSince(web, from)
  const push = runs[runs.length - 1]
  if (!push || push.stopped.reason !== 'done') t.comment(JSON.stringify(runs))
  t.is(runs.length, 2, label + ': a gate run and a push run')
  t.is(push && push.stopped.reason, 'done', label + ': push done')
  t.is(push && push.stopped.result.seederConfirmed, true, label + ': the seeder holds the whole diary')
  return { result, push }
}

// A device: a browser node over `storage`, unlocked with keyPair.
async function device (t, { storage, association, seederUrl, keyPair }) {
  const internal = []
  const node = createBrowserNode({
    storage,
    association,
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300 },
    writeGateTimeoutMs: 15000
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  return { node, web, internal }
}

function noPersonalData (t, text, label) {
  t.absent(text.includes(EMAIL), label + ': no e-mail')
  t.absent(text.includes(SUB), label + ': no sub')
  t.absent(text.includes(CLIENT_SECRET), label + ': no secret')
  t.absent(text.includes(ACCESS), label + ': no access token')
}

test('Google link to a v2 certificate and @username, seen by a CLI follower, renamed after 7 days', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)

  // ---- association and issuer: the operator's ceremony, through the CLI ----
  const assocDir = tmpDir(t, 'varanda-acc-assoc-')
  const association = (await run(t, ['assoc', 'init', '--data', assocDir, '--json'])).publicKey
  const assocKp = loadAssociationKeyPair(path.join(assocDir, 'association.json'))
  const accountDir = path.join(tmpDir(t, 'varanda-acc-svc-'), 'account')
  const issuerKey = (await run(t, ['account', 'key', '--data', accountDir, '--association', association, '--json'])).publicKey
  const issuerCertFile = path.join(tmpDir(t, 'varanda-acc-ic-'), 'issuer-cert.json')
  await run(t, ['assoc', 'certify-issuer', '--data', assocDir, '--issuer', issuerKey, '--out', issuerCertFile, '--json'])
  await run(t, ['account', 'cert', 'add', '--data', accountDir, '--cert-file', issuerCertFile, '--json'])
  const issuer = loadIssuer(accountDir, association)
  t.ok(issuer !== null, 'the account dir is configured')

  // ---- the account service against the fake Google, with a movable clock ----
  const google = await fakeGoogle(t)
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const logs = []
  const termsDir = tmpDir(t, 'varanda-acc-terms-')
  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: google.endpoints, fetch: google.fetch }),
    store: openAccountStore(accountDir, { now }),
    issuer,
    terms: openTermsStore(termsDir),
    log: (e) => logs.push(JSON.stringify(e)),
    now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const account = accountClient('http://127.0.0.1:' + listener.port)

  // ---- the seeder: the CLI binary with its WebSocket entry ----
  const seederDir = tmpDir(t, 'varanda-acc-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const seederCertFile = path.join(tmpDir(t, 'varanda-acc-sc-'), 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
  Seeder.addCert(seederDir, seederCertFile, association)
  const seed = varanda(t, ['seed', '--data', seederDir, '--ws-port', '0', '--json', ...bootstrapFlags(bootstrap)])
  const wsEvent = await until(() => jsonLines(seed.stdout).find((e) => e.event === 'ws'), { name: 'ws do semeador', timeoutMs: 30000 })
  await until(() => jsonLines(seed.stdout).some((e) => e.event === 'ready'), { name: 'semeador pronto', timeoutMs: 30000 })
  const seederUrl = 'ws://127.0.0.1:' + wsEvent.port + '/seeder'

  // ---- the browser: a fresh identity, no certificate yet ----
  const keyPair = crypto.keyPair()
  const keyHex = b4a.toString(keyPair.publicKey, 'hex')
  const storageA = memoryNodeStorage()
  const a = await device(t, { storage: storageA, association, seederUrl, keyPair })
  t.alike(await a.web.request('identity.create'), { publicKey: keyHex, association })

  // ---- link: start, reserve proof, Google, callback ----
  const started = await account.api('POST', '/account/start', { body: { member: keyHex, username: 'ana' } })
  t.is(started.status, 200, 'start')
  t.ok(account.jar.cookie !== null, 'the service set the link cookie')
  const reserve = await a.web.request('account.sign', { phase: 'reserve', nonce: started.body.nonce, username: 'ana', sub: '' })
  const authorized = await account.api('POST', '/account/authorize', { body: { signature: reserve.signature } })
  t.is(authorized.status, 200, 'the reserve proof the session signed verifies')
  const authorizeUrl = new URL(authorized.body.authorizeUrl)
  t.is(authorizeUrl.origin + authorizeUrl.pathname, google.endpoints.authUrl)
  const consent = await fetch(authorizeUrl, { redirect: 'manual' })
  await consent.text()
  t.is(consent.status, 302, 'the fake Google sends the browser back')
  const callbackPath = account.local(consent.headers.get('location'))
  t.ok(callbackPath.startsWith('/account/callback?'), 'to the service callback')

  // Negative: the same callback without the cookie is refused before any
  // exchange, and links nothing.
  const stray = await account.api('GET', callbackPath, { withCookie: false })
  t.is(stray.status, 302)
  t.is(stray.location, ORIGIN + '/?conta=erro', 'no cookie: ?conta=erro')
  t.is(google.tokenCalls(), 0, 'nothing exchanged without the cookie')
  t.alike((await account.api('GET', '/account/status?member=' + keyHex)).body, { linked: false }, 'and no link')

  const back = await account.api('GET', callbackPath)
  t.is(back.status, 302)
  t.is(back.location, ORIGIN + '/?conta=ok', 'with the cookie: ?conta=ok')
  t.is(google.tokenCalls(), 1, 'one code exchange (PKCE checked by the fake)')

  // ---- finish: the proof binds the Google subject; a v2 cert and a username record ----
  const pending = await account.api('GET', '/account/pending')
  t.is(pending.status, 200)
  t.is(pending.body.sub, SUB, 'pending carries the subject after the callback')
  t.is(pending.body.member, keyHex)
  const finishProof = await a.web.request('account.sign', { phase: 'finish', nonce: pending.body.nonce, username: 'ana', sub: pending.body.sub })
  const finished = await account.api('POST', '/account/finish', { body: { signature: finishProof.signature } })
  t.is(finished.status, 200, 'finish')
  t.is(account.jar.cookie, null, 'the cookie is cleared after finish')
  const { cert, usernameRecord, nextChangeAt } = finished.body
  t.is(cert.v, 2, 'a v2 certificate')
  t.alike(Object.keys(cert), ['v', 'member', 'ageBand', 'method', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature'])
  t.is(cert.issuer, issuerKey)
  t.ok(certForKey(cert, keyHex, association).ok, 'it verifies for the key and the association')
  t.is(usernameRecord.username, 'ana')
  t.ok(verifyUsernameRecord(usernameRecord, keyHex, association).ok, 'the username record verifies')
  const firstChange = Date.parse(nextChangeAt) - COOLDOWN_MS
  t.ok(Math.abs(firstChange - Date.now()) < 60000, 'next change is 7 days after the link')

  // ---- the browser writes both; the seeder admits the diary ----
  const certWrite = await gatedWrite(t, a.web, 'cert.add', { cert }, 'cert.add')
  t.alike(certWrite.result, { seq: 0 })
  t.is(certWrite.push.stopped.result.admitted, true, 'the v2 certificate is admitted on the push')
  const named = await gatedWrite(t, a.web, 'username.add', { record: usernameRecord }, 'username.add')
  t.alike(named.result, { changed: true, username: 'ana', seq: 1 })
  t.alike((await a.web.request('username.add', { record: usernameRecord })).changed, false, 'the same record again writes nothing')
  t.alike((await gatedWrite(t, a.web, 'post.create', { text: 'olá da web' }, 'post.create')).result, { seq: 2, ref: keyHex + ':2' })
  await until(() => jsonLines(seed.stdout).some((e) => e.event === 'admitted' && e.key === keyHex), { name: 'admitted no semeador', timeoutMs: 20000 })

  const byName = await account.api('GET', '/account/username/ana')
  t.is(byName.status, 200)
  t.is(byName.body.member, keyHex, '@ana resolves to the key')
  t.alike(byName.body.usernameRecord, usernameRecord)
  const linked = (await account.api('GET', '/account/status?member=' + keyHex)).body
  t.is(linked.linked, true)
  t.is(linked.username, 'ana')
  t.alike(linked.cert, cert)
  t.is(linked.nextChangeAt, nextChangeAt)

  // ---- terms: signed by the session, recorded by the service, diary untouched ----
  const diaryBefore = (await a.web.request('log.read', {})).entries.length
  const acceptTerms = async () => {
    const start = await account.api('POST', '/account/terms/start', { body: { member: keyHex, version: TERMS_VERSION } })
    t.is(start.status, 200, 'terms start')
    const proof = await a.web.request('terms.sign', { nonce: start.body.nonce, version: TERMS_VERSION })
    return account.api('POST', '/account/terms/finish', { body: { member: keyHex, nonce: start.body.nonce, signature: proof.signature } })
  }
  const accepted = await acceptTerms()
  t.is(accepted.status, 200, 'the terms proof the session signed verifies')
  t.is(accepted.body.version, TERMS_VERSION)
  const again = await acceptTerms()
  t.is(again.status, 200, 'a fresh nonce is accepted again')
  t.is(again.body.acceptedAt, accepted.body.acceptedAt, 'and answers the same acceptedAt')
  const stranger = crypto.keyPair()
  const strangerHex = b4a.toString(stranger.publicKey, 'hex')
  const c = await device(t, { storage: memoryNodeStorage(), association, seederUrl, keyPair: stranger })
  await c.web.request('identity.create')
  const unlinked = await account.api('POST', '/account/terms/start', { body: { member: strangerHex, version: TERMS_VERSION } })
  t.is(unlinked.status, 403, 'an unlinked session cannot start')
  t.alike(unlinked.body, { error: 'nao-vinculado' })
  await c.node.close()
  t.is((await a.web.request('log.read', {})).entries.length, diaryBefore, 'signing writes nothing to the diary')
  const termsText = fs.readFileSync(path.join(termsDir, 'terms.json'), 'utf8')
  t.absent(termsText.includes(EMAIL), 'terms.json: no e-mail')
  t.absent(termsText.includes(SUB), 'terms.json: no sub')
  t.alike(openTermsStore(termsDir, { readOnly: true }).list(keyHex), [{ version: TERMS_VERSION, acceptedAt: accepted.body.acceptedAt }])

  // ---- a second device: the same pair on fresh storage recovers the certificate ----
  const b = await device(t, { storage: memoryNodeStorage(), association, seederUrl, keyPair })
  t.alike(await b.web.request('identity.create'), { publicKey: keyHex, association })
  t.is((await b.web.request('node.info')).memberCert, false, 'nothing yet on B')
  const { runId: recovery } = await b.web.request('sync.start', { once: true, timeoutMs: 30000 })
  const recovered = await stoppedOf(b.web.events, recovery)
  if (recovered.reason !== 'done') t.comment(JSON.stringify(b.web.events))
  t.is(recovered.reason, 'done', 'B\'s run done')
  t.is(recovered.result.admitted, true, 'B announced the recovered v2 certificate and was admitted')
  const recoveryLines = b.web.events.filter((e) => e.name === 'sync.event' && e.data.runId === recovery).map((e) => e.data.line)
  t.ok(recoveryLines.includes('certificado recuperado do semeador'), 'the certificate was recomputed from block 0')
  t.ok(recoveryLines.includes('diário próprio sincronizado (3)'), 'B caught up')
  t.is((await b.web.request('node.info')).memberCert, true)
  const logB = await b.web.request('log.read', {})
  t.alike(logB.entries.map((e) => e.record.type), ['member-cert', 'username', 'post'])
  t.alike(logB.entries[0].record.cert, cert)
  t.alike(logB.invalid, [])
  await b.node.close()

  // ---- a CLI member follows the key and sees @ana ----
  const followerDir = tmpDir(t, 'varanda-acc-follower-')
  const follower = (await run(t, ['id', 'create', '--data', followerDir, '--association', association, '--json'])).publicKey
  const followerCert = path.join(tmpDir(t, 'varanda-acc-fc-'), 'cert.json')
  await run(t, ['assoc', 'certify', '--data', assocDir, '--member', follower, '--out', followerCert, '--json'])
  await run(t, ['cert', 'add', '--data', followerDir, '--cert-file', followerCert, '--json'])
  await run(t, ['follow', '--data', followerDir, '--author', keyHex, '--json'])
  const feedItem = async (label) => {
    const synced = await run(t, ['sync', '--data', followerDir, '--once', '--json', ...bootstrapFlags(bootstrap)])
    t.is(synced && synced.ok, true, label + ': follower sync ok ' + JSON.stringify(synced && synced.errors))
    const feed = await run(t, ['feed', '--data', followerDir, '--json'])
    t.alike(feed.skipped, [], label + ': nothing skipped')
    return feed.items.find((i) => i.author === keyHex && i.seq === 2)
  }
  const item = await feedItem('first')
  t.ok(item, 'the web post is in the follower\'s feed')
  t.is(item && item.text, 'olá da web')
  t.is(item && item.username, 'ana', 'with its @username')

  // ---- rename: refused before 7 days, allowed after; the follower sees the new @nome ----
  clock.offset = COOLDOWN_MS - HOUR
  const early = await account.api('POST', '/account/rename/start', { body: { member: keyHex, username: 'ana_maria' } })
  t.is(early.status, 409, 'at +6d23h')
  t.alike(early.body, { error: 'troca-bloqueada', nextChangeAt }, 'refused with the date it opens')

  clock.offset = COOLDOWN_MS
  const renameStart = await account.api('POST', '/account/rename/start', { body: { member: keyHex, username: 'ana_maria' } })
  t.is(renameStart.status, 200, 'at +7d')
  const renameProof = await a.web.request('account.sign', { phase: 'rename', nonce: renameStart.body.nonce, username: 'ana_maria', sub: '' })
  const renamed = await account.api('POST', '/account/rename/finish', { body: { member: keyHex, nonce: renameStart.body.nonce, signature: renameProof.signature } })
  t.is(renamed.status, 200, 'rename finish')
  t.is(renamed.body.usernameRecord.username, 'ana_maria')
  t.ok(verifyUsernameRecord(renamed.body.usernameRecord, keyHex, association).ok)
  t.ok(Date.parse(renamed.body.nextChangeAt) >= Date.parse(nextChangeAt) + COOLDOWN_MS, 'the next change is 7 days after the rename')
  const replay = await account.api('POST', '/account/rename/finish', { body: { member: keyHex, nonce: renameStart.body.nonce, signature: renameProof.signature } })
  t.is(replay.status, 404, 'a spent nonce is refused')
  t.is((await account.api('GET', '/account/username/ana')).status, 404, '@ana is released')
  t.is((await account.api('GET', '/account/username/ana_maria')).body.member, keyHex, '@ana_maria resolves to the key')

  const renameWrite = await gatedWrite(t, a.web, 'username.add', { record: renamed.body.usernameRecord }, 'username.add (rename)')
  t.alike(renameWrite.result, { changed: true, username: 'ana_maria', seq: 3 })
  const after = await feedItem('after the rename')
  t.is(after && after.username, 'ana_maria', 'the follower\'s next feed shows the new @nome')

  // Nothing personal in the service log, the session events or the seeder's
  // output, and no internal error in the session.
  noPersonalData(t, logs.join('\n'), 'service log')
  noPersonalData(t, JSON.stringify(a.web.events), 'session events')
  noPersonalData(t, seed.stdout + seed.stderr, 'seeder output')
  t.is(a.internal.length, 0, 'no internal error on A')
  t.is(b.internal.length, 0, 'no internal error on B')
  seed.kill()
  await seed.exited
})
