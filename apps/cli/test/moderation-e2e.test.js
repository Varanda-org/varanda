'use strict'

// End to end, loopback only: the moderation desk (B3) from a report signed
// in a browser session to a snapshot the seeder enforces. The pieces: an
// association, an issuer and a moderation key set up with the real CLI
// (`assoc init`, `account key`, `assoc certify-issuer`, `account cert add`,
// `mod init`, `assoc certify-moderator`, `mod cert add`), a moderation dir
// that already holds a B2 list blocking an unrelated key Zed (`mod block
// --new-list --no-publish`, seq 1), a fake Google on 127.0.0.1 answering a
// different account per sign-in, the account service in-process
// (createAccountServer with openAccountStore and openModerationStore over
// one temp dir, VARANDA_MODERATOR_EMAILS = the moderators' e-mails), the
// real Seeder in-process with its WebSocket entry, three browser sessions
// (createBrowserNode over memory storage) linked through the B1 flow (the
// third one the moderator's own diary: the panel admits a moderator only
// through the Google account linked to a diary), and `mod apply --server`
// as a child process with --yes (blocks only; a net unblock is held) or
// in-process with a scripted terminal review (interactive, `ask`) for the
// unblocks.
// The service's origin is http://127.0.0.1:<port> with the port reserved
// first (plan D2): the operator's signature binds the origin
// (packages/core/lib/mod-request.js) and the panel's POSTs must carry it as
// their exact Origin (server.js checkPost).
// What is proven here and nowhere else: the report the session signs
// (report.sign) is the one the service verifies; a panel decision becomes,
// through `mod apply`, a snapshot the seeder adopts and enforces (the
// blocked diary is dropped, the unrelated B2 block survives) and the ack
// empties 'Pendentes'; an unblock round trip; the D6 intent log over the
// wire (a cancelled unclaimed decision is never signed; a cancel after the
// operator pulled is compensated by the next apply); an unattended --yes
// run never signs an unblock; a moderator never sees a report filed from
// their own diary, and one without a linked diary gets no session.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createClient, parseMessage, EVENTS, MAX_MESSAGE } = require('@varanda/rpc')
const { Seeder } = require('@varanda/core/lib/seeder')
const assoc = require('@varanda/core/lib/assoc')
const { createModeratorCert } = require('@varanda/core/lib/cert')
const { readBlocklist, lockDataDir } = require('@varanda/core/lib/store')
const { signModRequest, canonicalBody } = require('@varanda/core/lib/mod-request')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { createAccountServer, loadIssuer } = require('../lib/account/server')
const { startSeedWs } = require('../lib/seed-ws')
const modApply = require('../lib/mod-apply')
const modPublish = require('../lib/mod-publish')
// The browser node lives in packages/web-member; apps/cli does not depend
// on it, so it is reached by path (as account-e2e.test.js does).
const { createBrowserNode } = require('../../../packages/web-member/lib/node')
const { memoryNodeStorage } = require('../../../packages/web-member/lib/node-storage')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const CLIENT_ID = 'client-mod-e2e.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-mod-e2e'
const WAIT = { timeoutMs: 45000 }
// 22-digit subjects: any leak shows up as a plain substring (and as a
// 16-hex run).
const ALICE = { sub: '2098765432109876543210', email: 'alice-e2e@example.test' }
const BOB = { sub: '2198765432109876543211', email: 'bob-e2e@example.test' }
const MODERATOR = { sub: '2298765432109876543212', email: 'moderadora-e2e@example.test' }
const STRANGER = { sub: '2398765432109876543213', email: 'intrusa-e2e@example.test' }
// On the moderators' list, but no diary is linked to this Google account.
const UNLINKED_MODERATOR = { sub: '2498765432109876543214', email: 'moderador-sem-diario-e2e@example.test' }
const IDENTITIES = [ALICE, BOB, MODERATOR, STRANGER, UNLINKED_MODERATOR]
// mod-apply.js: the terminal review's question.
const CONFIRM = 'Assinar e publicar estas mudanças? [s/N] '
const SNAPSHOT_KEYS = ['v', 'seq', 'date', 'blocked', 'revokedIssuers', 'moderator', 'moderatorDate', 'moderatorSignature', 'signature']

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function cli (args) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60000 })
}

// Commands that talk to the in-process seeder or service run
// asynchronously, so this process keeps answering; killed in teardown.
function cliAsync (t, args) {
  const child = spawn(process.execPath, [BIN, ...args], { env })
  const proc = { stdout: '', stderr: '', status: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  const exited = new Promise((resolve) => child.on('close', (status) => { proc.status = status; resolve(proc) }))
  t.teardown(async () => {
    if (proc.status === null) {
      child.kill('SIGKILL')
      await exited
    }
  }, { force: true })
  return exited
}

// A free loopback port, released before the service binds it (plan D2):
// the origin the operator signs must carry the port the service listens on.
function reservePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
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

// Fake Google on 127.0.0.1 serving both redirect URIs (the member link's
// /account/callback and the panel's /account/mod/callback). `as(who)` picks
// the account the next consent signs in; /auth binds it and the PKCE
// challenge to a fresh code, /token checks the verifier, /userinfo answers
// that account.
async function fakeGoogle (t) {
  const codes = new Map()
  const tokens = new Map()
  let next = null
  let n = 0
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/auth') {
      if (next === null) return json(res, 400, { error: 'no_account' })
      const code = 'codigo-mod-' + (++n)
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), who: next })
      next = null
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.search = new URLSearchParams({ code, state: url.searchParams.get('state') }).toString()
      res.writeHead(302, { Location: back.toString(), 'Content-Length': 0 })
      return res.end()
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(body)
      const row = codes.get(form.get('code'))
      codes.delete(form.get('code'))
      const s256 = nodeCrypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url')
      if (!row || s256 !== row.challenge || form.get('client_secret') !== CLIENT_SECRET) return json(res, 400, { error: 'invalid_grant' })
      const access = 'ya29.acesso-mod-' + n
      tokens.set(access, row.who)
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: row.who.sub, exp: Math.floor(Date.now() / 1000) + 3600 }
      const idToken = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(claims) + '.c2ln'
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3599, id_token: idToken })
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const who = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''))
      if (!who) return json(res, 401, { error: 'invalid_token' })
      return json(res, 200, { sub: who.sub, email: who.email, email_verified: true })
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
  const fetch = (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
  return { endpoints, fetch, as: (who) => { next = who } }
}

// A browser against the service: its own cookie jar (every cookie the
// service sets, dropped on Max-Age=0), the page's Origin and JSON on
// POSTs, redirects never followed. Cookies go to the service origin only.
function browser (origin) {
  const jar = new Map()
  async function req (method, target, body) {
    const url = target.startsWith('http') ? target : origin + target
    const init = { method, redirect: 'manual', headers: {} }
    if (url.startsWith(origin + '/') && jar.size > 0) {
      init.headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ')
    }
    if (body !== undefined) {
      init.headers.origin = origin
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(url, init)
    for (const line of res.headers.getSetCookie()) {
      const m = /^([^=;\s]+)=([^;]*);.*Max-Age=(\d+)/.exec(line)
      if (!m) continue
      if (m[3] === '0' || m[2] === '') jar.delete(m[1])
      else jar.set(m[1], m[2])
    }
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), text, body: parsed }
  }
  return {
    jar,
    get: (target) => req('GET', target),
    post: (target, body) => req('POST', target, body)
  }
}

// The page's in-memory client, wired to the node as apps/app wires it (as
// account-e2e.test.js).
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

// A gated write (packages/web-member/lib/session.js): its last run must
// end with the seeder holding the diary.
async function gatedWrite (t, web, method, params, label) {
  const from = web.events.length
  const result = await web.request(method, params)
  const started = web.events.slice(from).filter((e) => e.name === 'sync.started')
  const last = started[started.length - 1]
  const stopped = last ? await stoppedOf(web.events, last.data.runId) : null
  t.is(stopped && stopped.reason, 'done', label + ': push done')
  t.is(stopped && stopped.result.seederConfirmed, true, label + ': the seeder holds the whole diary')
  return result
}

// A browser device: a node over fresh memory storage unlocked with a random
// key pair (as the page holds the passkey-derived one), its identity made.
async function device (t, { association, seederUrl }) {
  const internal = []
  const keyPair = crypto.keyPair()
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
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
  const key = hex(keyPair.publicKey)
  t.alike(await web.request('identity.create'), { publicKey: key, association })
  return { node, web, key, internal }
}

// The B1 link flow (start, reserve proof, Google, callback, finish proof)
// for `dev` as `who`. -> the finish body ({ cert, usernameRecord, ... }).
async function link (t, origin, google, dev, username, who) {
  const b = browser(origin)
  const started = await b.post('/account/start', { member: dev.key, username })
  t.is(started.status, 200, username + ': start')
  const reserve = await dev.web.request('account.sign', { phase: 'reserve', nonce: started.body.nonce, username, sub: '' })
  const authorized = await b.post('/account/authorize', { signature: reserve.signature })
  t.is(authorized.status, 200, username + ': authorize')
  google.as(who)
  const consent = await fetch(authorized.body.authorizeUrl, { redirect: 'manual' })
  await consent.text()
  const back = await b.get(consent.headers.get('location'))
  t.is(back.location, origin + '/?conta=ok', username + ': callback ok')
  const pending = await b.get('/account/pending')
  const proof = await dev.web.request('account.sign', { phase: 'finish', nonce: pending.body.nonce, username, sub: pending.body.sub })
  const finished = await b.post('/account/finish', { signature: proof.signature })
  t.is(finished.status, 200, username + ': finish')
  return finished.body
}

// A report through the real routes: start, report.sign in the session,
// report. -> the service's answer (or the start refusal).
async function report (origin, dev, { target, seq = null, reason = 'spam', text = '', quote = '' }) {
  const b = browser(origin)
  const start = await b.post('/account/report/start', { member: dev.key })
  if (start.status !== 200) return start
  const params = { nonce: start.body.nonce, target, reason, text }
  if (seq !== null) {
    params.seq = seq
    params.quote = quote
  }
  const { signature } = await dev.web.request('report.sign', params)
  return b.post('/account/report', { member: dev.key, nonce: start.body.nonce, target, seq, reason, text, quote, signature })
}

// The panel's Google sign-in as `who`. -> { b, back } (back = the callback's
// redirect, b the browser holding whatever session it got).
async function modLogin (t, origin, google, who) {
  const b = browser(origin)
  const login = await b.get('/account/mod/login')
  t.is(login.status, 302, 'login redirects to Google')
  google.as(who)
  const consent = await fetch(login.location, { redirect: 'manual' })
  await consent.text()
  const back = await b.get(consent.headers.get('location'))
  return { b, back }
}

function noPersonalData (t, text, label) {
  for (const who of IDENTITIES) {
    t.absent(text.includes(who.email), label + ': no e-mail')
    t.absent(text.includes(who.sub), label + ': no Google sub')
  }
  t.absent(text.includes(CLIENT_SECRET), label + ': no secret')
}

test('e2e: report, panel decision, mod apply, seeder enforcement, unblock and the D6 intent log', async (t) => {
  t.timeout(175000)
  const { bootstrap } = await testnet(t)
  const flags = bootstrapFlags(bootstrap)
  const root = tmpDir(t, 'varanda-mode2e-')

  // ---- association, issuer and moderation key: the operator's ceremony ----
  const assocDir = path.join(root, 'assoc')
  const init = cli(['assoc', 'init', '--data', assocDir])
  t.is(init.status, 0, init.stderr)
  const association = /([0-9a-f]{64})/.exec(init.stdout)[1]

  const accountDir = path.join(root, 'account')
  const issuerKey = cli(['account', 'key', '--data', accountDir, '--association', association, '--json'])
  t.is(issuerKey.status, 0, issuerKey.stderr)
  const issuerCertFile = path.join(root, 'issuer-cert.json')
  const ci = cli(['assoc', 'certify-issuer', '--data', assocDir, '--issuer', JSON.parse(issuerKey.stdout).publicKey, '--out', issuerCertFile])
  t.is(ci.status, 0, ci.stderr)
  const ca = cli(['account', 'cert', 'add', '--data', accountDir, '--cert-file', issuerCertFile])
  t.is(ca.status, 0, ca.stderr)
  const issuer = loadIssuer(accountDir, association)
  t.ok(issuer !== null, 'the account dir is configured')

  const modDir = path.join(root, 'mod')
  const modInit = cli(['mod', 'init', '--association', association, '--data', modDir])
  t.is(modInit.status, 0, modInit.stderr)
  const moderator = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(modInit.stdout)[1]
  const modCertFile = path.join(root, 'moderator-cert.json')
  const cm = cli(['assoc', 'certify-moderator', '--moderator', moderator, '--out', modCertFile, '--data', assocDir])
  t.is(cm.status, 0, cm.stderr)
  const mca = cli(['mod', 'cert', 'add', '--cert-file', modCertFile, '--data', modDir])
  t.is(mca.status, 0, mca.stderr)
  const modCert = JSON.parse(fs.readFileSync(modCertFile, 'utf8'))

  // A pre-existing B2 list (seq 1) blocking an unrelated key: it must
  // survive every panel-driven snapshot.
  const zed = hex(crypto.keyPair().publicKey)
  const zedBlock = cli(['mod', 'block', zed, '--new-list', '--no-publish', '--data', modDir])
  t.is(zedBlock.status, 0, zedBlock.stderr)
  t.ok(zedBlock.stdout.endsWith('lista seq 1 gravada\nlista não publicada (--no-publish)\n'), 'Zed blocked locally at seq 1')

  // ---- the seeder, in-process, with its WebSocket entry for the browsers ----
  const seedDir = path.join(root, 'seed')
  Seeder.ensureConfig(seedDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seedDir)
  const seederCertFile = path.join(root, 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(assoc.issueSeederCertificate(assocDir, { seeder: seederKey })))
  Seeder.addCert(seedDir, seederCertFile, association)
  const seedEvents = []
  const seeder = new Seeder({ dataDir: seedDir, ...localSwarmOptions(bootstrap), log: (e) => seedEvents.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  const ws = await startSeedWs({ host: '127.0.0.1', port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  await seeder.start()
  const seederUrl = 'ws://127.0.0.1:' + ws.port + '/seeder'

  // ---- the account service on a reserved loopback port (plan D2) ----
  const port = await reservePort()
  const ORIGIN = 'http://127.0.0.1:' + port
  const google = await fakeGoogle(t)
  const logs = []
  const googleFor = (redirectPath) => createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + redirectPath, endpoints: google.endpoints, fetch: google.fetch })
  const server = createAccountServer({
    association,
    origin: ORIGIN,
    google: googleFor('/account/callback'),
    store: openAccountStore(accountDir),
    issuer,
    log: (e) => logs.push(JSON.stringify(e)),
    moderation: openModerationStore(accountDir, { association }),
    googleMod: googleFor('/account/mod/callback'),
    modEmails: [MODERATOR.email, UNLINKED_MODERATOR.email]
  })
  const listener = await server.listen({ host: '127.0.0.1', port })
  t.teardown(() => listener.close(), { force: true })
  t.is(listener.port, port, 'the service listens on the reserved port')

  // A child process has no terminal: only --yes runs (blocks only).
  const apply = (extra = []) => cliAsync(t, ['mod', 'apply', '--server', ORIGIN, '--data', modDir, '--seeder', seederKey, '--timeout-ms', '30000', '--yes', ...extra, ...flags])
  const applyOutputs = []
  const applied = async (label) => {
    const r = await apply()
    applyOutputs.push(r.stdout + r.stderr)
    t.is(r.status, 0, label + ': ' + r.stderr)
    return r
  }
  // The operator at a terminal: mod-apply.js apply() in-process as
  // commands/mod.js runs it (the data-dir lock held throughout, no
  // --new-list, publish = mod-publish.js to the seeder by its key), the
  // review answered 's'. -> { status, stdout, asked }.
  const appliedAtTerminal = async (label) => {
    const lines = []
    const asked = []
    const release = await lockDataDir(modDir)
    let status
    try {
      status = await modApply.apply({
        dir: modDir,
        association,
        server: ORIGIN,
        newList: false,
        json: false,
        yes: false,
        interactive: true,
        ask: async (q) => { asked.push(q); return 's' },
        publish: (s) => modPublish.publish({ snapshot: s, association, seeder: seederKey, bootstrap, host: '127.0.0.1', timeoutMs: 30000 }),
        print: (line) => lines.push(line)
      })
    } finally {
      release()
    }
    const stdout = lines.join('\n') + '\n'
    applyOutputs.push(stdout)
    t.is(status, 0, label)
    return { status, stdout, asked }
  }
  const seederList = () => {
    const d = readBlocklist(seedDir)
    return d === null ? null : d.snapshot
  }

  // ---- Alice and Bob: browser sessions linked to Google ----
  const alice = await device(t, { association, seederUrl })
  const bob = await device(t, { association, seederUrl })
  const aliceLink = await link(t, ORIGIN, google, alice, 'ana', ALICE)
  await link(t, ORIGIN, google, bob, 'bia', BOB)
  // The moderator's own diary, linked to their Google account (the panel's
  // sign-in requires it); neither a reporter nor a target of the reports
  // below until the own-report step.
  const mara = await device(t, { association, seederUrl })
  await link(t, ORIGIN, google, mara, 'mara', MODERATOR)

  // Alice publishes her certificate and a post; the seeder admits her.
  t.alike(await gatedWrite(t, alice.web, 'cert.add', { cert: aliceLink.cert }, 'cert.add'), { seq: 0 })
  t.alike(await gatedWrite(t, alice.web, 'post.create', { text: 'olá da varanda' }, 'post.create'), { seq: 1, ref: alice.key + ':1' })
  await until(() => seeder.admittedKeys().includes(alice.key), { ...WAIT, name: 'semeador admite Alice' })

  // ---- reports through the real routes ----
  const r1 = await report(ORIGIN, bob, { target: alice.key, seq: 1, reason: 'spam', text: 'propaganda repetida', quote: 'olá da varanda' })
  t.is(r1.status, 200, 'Bob reports Alice\'s post')
  t.is(r1.body.duplicate, false)
  const again = await report(ORIGIN, bob, { target: alice.key, seq: 1, reason: 'spam', text: 'propaganda repetida', quote: 'olá da varanda' })
  t.is(again.status, 200)
  t.alike(again.body, { id: r1.body.id, duplicate: true }, 'the same report again is a duplicate')
  const stranger = await report(ORIGIN, { key: hex(crypto.keyPair().publicKey) }, { target: alice.key })
  t.is(stranger.status, 403)
  t.alike(stranger.body, { error: 'nao-vinculado' }, 'an unlinked key cannot report')
  // A second, account-wide report on Alice, left open for the D6 net-zero step.
  const r2 = await report(ORIGIN, bob, { target: alice.key, reason: 'assedio', text: 'mensagens insistentes' })
  t.is(r2.status, 200)
  t.is(r2.body.duplicate, false)

  // ---- the panel: assets, anonymous refusal, sign-in ----
  const anon = browser(ORIGIN)
  const page = await anon.get('/account/mod/')
  t.is(page.status, 200, 'GET /account/mod/')
  t.ok(page.type.startsWith('text/html'), 'index.html as text/html')
  const script = await anon.get('/account/mod/app.js')
  t.is(script.status, 200)
  t.ok(script.type.startsWith('text/javascript'), 'app.js as text/javascript')
  const noSession = await anon.get('/account/mod/api/me')
  t.is(noSession.status, 401)
  t.is(noSession.text, '{"error":"nao-autorizado"}\n', 'api/me without a session')

  const outsider = await modLogin(t, ORIGIN, google, STRANGER)
  t.is(outsider.back.location, ORIGIN + '/account/mod/?erro=nao-autorizado', 'an e-mail outside the list is refused')
  t.absent(outsider.b.jar.has('__Host-varanda-mod'), 'and gets no session')
  t.is((await outsider.b.get('/account/mod/api/me')).status, 401)

  const noDiary = await modLogin(t, ORIGIN, google, UNLINKED_MODERATOR)
  t.is(noDiary.back.location, ORIGIN + '/account/mod/?erro=sem-diario', 'a listed moderator without a linked diary is refused')
  t.absent(noDiary.b.jar.has('__Host-varanda-mod'), 'and gets no session')
  t.is((await noDiary.b.get('/account/mod/api/me')).status, 401)

  const { b: panel, back } = await modLogin(t, ORIGIN, google, MODERATOR)
  t.is(back.location, ORIGIN + '/account/mod/', 'the moderator is signed in')
  t.ok(panel.jar.has('__Host-varanda-mod'), 'with a session cookie')
  const me = await panel.get('/account/mod/api/me')
  t.is(me.status, 200)
  t.alike(me.body, { email: MODERATOR.email, published: null, open: 2, pending: 0 })

  // A report the moderator files from their own diary: never in their list,
  // never theirs to decide (accuser and judge at once).
  const eve = hex(crypto.keyPair().publicKey)
  const own = await report(ORIGIN, mara, { target: eve, reason: 'spam', text: 'conta suspeita' })
  t.is(own.status, 200, 'the moderator\'s diary can report')
  t.is(own.body.duplicate, false)

  const open = await panel.get('/account/mod/api/reports?estado=aberta')
  t.is(open.status, 200)
  const row = open.body.reports.find((r) => r.id === r1.body.id)
  t.ok(row, 'Bob\'s report is listed')
  t.alike(row.reporter, { member: bob.key, username: 'bia' }, 'by key and @username')
  t.is(row.reported.member, alice.key)
  t.is(row.quote, 'olá da varanda')
  t.absent(open.text.includes('@'), 'no e-mail in the reports')
  t.absent(open.body.reports.some((r) => r.id === own.body.id), 'the moderator\'s own report is not listed')
  t.absent(open.text.includes(mara.key), 'nor anything filed from their diary')
  const ownDecide = await panel.post('/account/mod/api/reports/' + own.body.id + '/decide', { decision: 'bloquear', note: '' })
  t.is(ownDecide.status, 404)
  t.alike(ownDecide.body, { error: 'nao-encontrado' }, 'nor can they decide it')

  // ---- decide 'bloquear'; mod apply signs seq 2 and the seeder drops Alice ----
  const decided = await panel.post('/account/mod/api/reports/' + r1.body.id + '/decide', { decision: 'bloquear', note: '' })
  t.is(decided.status, 200, 'decide bloquear')
  t.is(decided.body.change.op, 'block')
  t.is(decided.body.change.member, alice.key)
  let blocked = await panel.get('/account/mod/api/blocked')
  t.is(blocked.body.published, null, 'nothing published yet')
  t.is(blocked.body.pending.length, 1, 'one pending change')
  t.is(blocked.body.pending[0].claimedAt, null)

  const first = await applied('first apply')
  t.ok(first.stdout.includes('bloquear ' + alice.key + '\n'), 'the review names the net block')
  t.ok(first.stdout.includes('aplicado: seq 2, 2 chaves bloqueadas'), 'aplicado: seq 2')
  await until(() => seeder.stats().blocklistSeq === 2, { ...WAIT, name: 'semeador adota seq 2' })
  const seq2 = seederList()
  t.alike(Object.keys(seq2), SNAPSHOT_KEYS, 'only the B2 snapshot keys')
  t.alike(seq2.blocked, [alice.key, zed].sort(), 'Alice blocked and the unrelated B2 block kept')
  t.is(seq2.moderator, moderator)
  await until(() => seeder.stats().dropping === 0 && !seeder.admittedKeys().includes(alice.key), { ...WAIT, name: 'Alice fora do semeador' })
  t.pass('the seeder dropped Alice\'s diary')

  blocked = await panel.get('/account/mod/api/blocked')
  t.is(blocked.body.published.seq, 2)
  t.alike(blocked.body.blocked.map((b) => b.member), [alice.key, zed].sort(), 'both published')
  t.alike(blocked.body.blocked.find((b) => b.member === alice.key).reportIds, [r1.body.id])
  t.alike(blocked.body.pending, [], 'Pendentes is empty after the ack')
  t.is((await panel.get('/account/mod/api/me')).body.pending, 0)
  const idle = await applied('second apply')
  t.ok(idle.stdout.includes('nada a aplicar'), 'nothing left to apply')

  // ---- unblock round trip, through the D6 net-zero path ----
  const un1 = await panel.post('/account/mod/api/unblock', { member: alice.key })
  t.is(un1.status, 200)
  t.is(un1.body.change.op, 'unblock', 'a pending unblock')
  const reblock = await panel.post('/account/mod/api/reports/' + r2.body.id + '/decide', { decision: 'bloquear', note: '' })
  t.is(reblock.status, 200)
  t.is(reblock.body.change, null, 'bloquear right after the unblock cancels it')
  t.alike((await panel.get('/account/mod/api/blocked')).body.pending, [], 'net zero: no pending change')
  const un2 = await panel.post('/account/mod/api/unblock', { member: alice.key })
  t.is(un2.body.change.op, 'unblock')
  t.is((await panel.get('/account/mod/api/blocked')).body.pending.length, 1, 'one pending unblock')
  // Unattended (--yes), the unblock is held: nothing signed or acked.
  const held = await applied('unattended apply holds the unblock')
  t.ok(held.stdout.includes('desbloquear ' + alice.key + '\n'), 'the review names the net unblock')
  t.ok(held.stdout.includes('desbloqueios aguardando revisão no terminal: 1'), 'and holds it')
  t.ok(held.stdout.includes('nada a aplicar'), 'nothing signed')
  t.is(seeder.stats().blocklistSeq, 2, 'the seeder stays at seq 2')
  t.alike(seederList().blocked, [alice.key, zed].sort(), 'Alice still blocked')
  blocked = await panel.get('/account/mod/api/blocked')
  t.is(blocked.body.published.seq, 2)
  t.alike(blocked.body.pending.map((c) => [c.op, c.member]), [['unblock', alice.key]], 'the unblock stays pending')
  // At a terminal the operator reviews and confirms it.
  const third = await appliedAtTerminal('unblock apply at a terminal')
  t.alike(third.asked, [CONFIRM], 'one confirmation asked (a panel-made block)')
  t.ok(third.stdout.includes('desbloquear ' + alice.key + '\n'), 'the review names the unblock')
  t.ok(third.stdout.includes('aplicado: seq 3'), 'aplicado: seq 3')
  await until(() => seeder.stats().blocklistSeq === 3, { ...WAIT, name: 'semeador adota seq 3' })
  t.alike(seederList().blocked, [zed], 'only Zed stays blocked')
  blocked = await panel.get('/account/mod/api/blocked')
  t.alike(blocked.body.blocked.map((b) => b.member), [zed])
  t.alike(blocked.body.pending, [])

  // ---- D6: a dismissed report and a cancelled unclaimed decision are never signed ----
  const carol = hex(crypto.keyPair().publicKey)
  const r3 = await report(ORIGIN, bob, { target: carol, reason: 'outro', text: 'perfil estranho' })
  const dismissed = await panel.post('/account/mod/api/reports/' + r3.body.id + '/decide', { decision: 'descartar', note: 'sem violação' })
  t.is(dismissed.status, 200)
  t.is(dismissed.body.change, null, 'descartar creates no change')
  const r4 = await report(ORIGIN, alice, { target: carol, seq: 3, reason: 'ilegal', quote: 'conteúdo' })
  t.is(r4.status, 200)
  const r4d = await panel.post('/account/mod/api/reports/' + r4.body.id + '/decide', { decision: 'bloquear', note: '' })
  t.is(r4d.body.change.op, 'block')
  const cancelled = await panel.post('/account/mod/api/pending/' + r4d.body.change.id + '/cancel', {})
  t.is(cancelled.status, 200)
  t.is(cancelled.body.change, null, 'an unclaimed change is simply deleted')
  t.alike((await panel.get('/account/mod/api/blocked')).body.pending, [])
  const quiet = await applied('apply after the cancel')
  t.ok(quiet.stdout.includes('nada a aplicar'), 'the cancelled decision is never signed')
  t.is(seeder.stats().blocklistSeq, 3, 'the seeder stays at seq 3')
  t.absent(seederList().blocked.includes(carol), 'Carol never enters a snapshot')

  // ---- D6: a cancel after the operator pulled is compensated ----
  const dan = hex(crypto.keyPair().publicKey)
  const r5 = await report(ORIGIN, alice, { target: dan, reason: 'spam', text: 'robô' })
  const r5d = await panel.post('/account/mod/api/reports/' + r5.body.id + '/decide', { decision: 'bloquear', note: '' })
  t.is(r5d.body.change.op, 'block')
  // The operator pulls and signs seq 4, but the publish never lands (an
  // unreachable seeder key): the change stays pending, now claimed.
  const nowhere = hex(crypto.keyPair().publicKey)
  const failed = await cliAsync(t, ['mod', 'apply', '--server', ORIGIN, '--data', modDir, '--seeder', nowhere, '--timeout-ms', '3000', '--yes', ...flags])
  applyOutputs.push(failed.stdout + failed.stderr)
  t.is(failed.status, 1, 'the apply fails on the publish')
  t.ok(failed.stderr.includes('não foi possível publicar a lista'), failed.stderr)
  blocked = await panel.get('/account/mod/api/blocked')
  t.is(blocked.body.pending.length, 1)
  t.ok(blocked.body.pending[0].claimedAt !== null, 'the change is claimed (enviada para assinatura)')
  const compensated = await panel.post('/account/mod/api/pending/' + r5d.body.change.id + '/cancel', {})
  t.is(compensated.status, 200)
  t.is(compensated.body.change.op, 'unblock', 'a claimed change is compensated, not deleted')
  t.is(compensated.body.change.member, dan)
  t.alike((await panel.get('/account/mod/api/blocked')).body.pending.map((c) => c.op), ['block', 'unblock'])
  // The compensation is a net unblock of Dan (blocked in the local seq 4):
  // reviewed at a terminal.
  const fifth = await appliedAtTerminal('apply after the compensation')
  t.alike(fifth.asked, [CONFIRM], 'one confirmation asked')
  t.ok(fifth.stdout.includes('desbloquear ' + dan + '\n'), 'the review names Dan\'s unblock')
  t.ok(fifth.stdout.includes('aplicado: seq 5'), 'a snapshot without Dan (seq 5): ' + fifth.stdout)
  await until(() => seeder.stats().blocklistSeq === 5, { ...WAIT, name: 'semeador adota seq 5' })
  t.alike(seederList().blocked, [zed], 'Dan is not blocked')
  blocked = await panel.get('/account/mod/api/blocked')
  t.is(blocked.body.published.seq, 5)
  t.alike(blocked.body.pending, [], 'both ids acked')

  // ---- negative: pulls not signed by the certified moderator ----
  const fresh = crypto.keyPair()
  const freshHex = hex(fresh.publicKey)
  const operatorPull = async (cert, signer, moderatorKey) => {
    const ch = await fetch(ORIGIN + '/account/mod/api/challenge?moderator=' + moderatorKey + '&op=pull')
    const { nonce } = await ch.json()
    const signature = signModRequest({ origin: ORIGIN, association, moderator: moderatorKey, nonce, op: 'pull', body: canonicalBody('pull') }, signer)
    const res = await fetch(ORIGIN + '/account/mod/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cert, nonce, signature }) })
    return { status: res.status, body: await res.json() }
  }
  const selfCert = createModeratorCert({ moderator: freshHex }, crypto.keyPair())
  t.alike(await operatorPull(selfCert, fresh, freshHex), { status: 403, body: { error: 'nao-autorizado' } }, 'an uncertified key is refused')
  t.alike(await operatorPull(modCert, fresh, moderator), { status: 403, body: { error: 'nao-autorizado' } }, 'the real certificate signed by another key is refused')

  // ---- nothing personal anywhere ----
  const status = await anon.get('/account/status?member=' + alice.key)
  t.is(status.status, 200)
  t.is(status.body.linked, true)
  t.absent(status.text.includes('@'), 'account status carries no e-mail')
  for (const id of [r1.body.id, r2.body.id, r4.body.id, r5.body.id, own.body.id]) t.absent(status.text.includes(id), 'and no report')
  const serviceLog = logs.join('\n')
  t.ok(logs.length > 0, 'the service logged')
  t.absent(serviceLog.includes('@'), 'no e-mail in the service log')
  t.absent(/[0-9a-fA-F]{16}/.test(serviceLog), 'no key, sub or signature in the service log')
  t.absent(serviceLog.includes('127.0.0.1'), 'no address in the service log')
  noPersonalData(t, serviceLog, 'service log')
  noPersonalData(t, JSON.stringify(seedEvents), 'seeder events')
  noPersonalData(t, applyOutputs.join('\n'), 'mod apply output')
  noPersonalData(t, JSON.stringify(alice.web.events) + JSON.stringify(bob.web.events) + JSON.stringify(mara.web.events), 'session events')
  t.is(alice.internal.length + bob.internal.length + mara.internal.length, 0, 'no internal error in the sessions')
})
