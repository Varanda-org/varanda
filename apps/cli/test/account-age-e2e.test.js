'use strict'

// End to end, loopback only: hosted age verification (Didit) from the browser
// session to the account service. The pieces: an association and an issuer
// certified by it, the account service in-process (createAccountServer over a
// temp data dir with the real account, age and invites stores), the Didit
// fake of helpers/fake-didit.js behind the real client (./didit.js), a fake
// Google on 127.0.0.1 (as account-e2e.test.js) and a browser node session
// over memory storage holding a random key pair, whose seeder is a dead port
// (the age check runs before any certificate, so nothing here syncs).
// What is proven here and nowhere else: the age requests the session signs
// (age.sign) are the ones the service verifies; the band lands in age.json
// and lets that same key through the Google link, whose v2 certificate is
// unchanged by it; the band survives a restart while an open Didit session
// does not; and nothing the vendor answers about the person reaches a file,
// a response or a log line. The route-level cases live in account-age.test.js.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createClient, parseMessage, EVENTS, MAX_MESSAGE } = require('@varanda/rpc')
const { createIssuerCert, certForKey } = require('@varanda/core/lib/cert')
const { signTerms, TERMS_VERSION } = require('@varanda/core/lib/terms')
const { tmpDir } = require('./helpers/net')
const { startFakeDidit, loopbackFetch } = require('./helpers/fake-didit')
const { createGoogle } = require('../lib/account/google')
const { createDidit } = require('../lib/account/didit')
const { openAccountStore, COOLDOWN_MS } = require('../lib/account/store')
const { openAgeStore } = require('../lib/account/age-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { createAccountServer, COOKIE } = require('../lib/account/server')
// The browser node lives in packages/web-member; apps/cli does not depend
// on it, so it is reached by path (as account-e2e.test.js reaches it).
const { createBrowserNode } = require('../../../packages/web-member/lib/node')
const { memoryNodeStorage } = require('../../../packages/web-member/lib/node-storage')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-age-e2e.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-age-e2e'
const ACCESS = 'ya29.access-token-age-e2e'
const CODE = 'codigo-age-e2e-1'
const EMAIL = 'membro-age-e2e@example.test'
const API_KEY = 'didit-key-age-e2e-0123456789'
const WORKFLOW = '11111111-2222-4333-8444-555555555555'

let subSeq = 0
function nextSub () {
  return '40000000000000000' + String(10000 + subSeq++)
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

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

async function waitFor (fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// Fake Google on 127.0.0.1, as account-e2e.test.js: /auth answers 302 back
// to the callback, /token checks PKCE, /userinfo answers account.sub.
async function fakeGoogle (t) {
  const seen = []
  const account = { sub: nextSub() }
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
      const s256 = nodeCrypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url')
      if (form.get('code') !== CODE || challenge === null || s256 !== challenge || form.get('client_secret') !== CLIENT_SECRET) {
        return json(res, 400, { error: 'invalid_grant' })
      }
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: account.sub, exp: Math.floor(Date.now() / 1000) + 3600 }
      const idToken = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(claims) + '.c2ln'
      return json(res, 200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3599, id_token: idToken })
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer ' + ACCESS) return json(res, 401, { error: 'invalid_token' })
      return json(res, 200, { sub: account.sub, email: EMAIL, email_verified: true })
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
  return { endpoints, fetch: loopbackFetch(base), seen, account }
}

// The page's in-memory client, wired to the node as apps/app wires it.
async function connectClient (node) {
  const events = []
  let port = null
  const client = createClient({
    send: (message, text) => queueMicrotask(() => { if (port !== null) port.receive(text) }),
    timeoutMs: 30000
  })
  port = node.connect((text) => queueMicrotask(() => {
    const parsed = parseMessage(text, MAX_MESSAGE)
    if (parsed.ok) client.receive(parsed.value)
  }), { onClose: () => client.close() })
  for (const name of EVENTS) client.on(name, (data) => events.push({ name, data }))
  await client.request('session.open', {})
  return { events, request: (method, params = {}) => client.request(method, params) }
}

// The whole harness for one scenario. `serve()` opens one service lifetime
// over `dir` (stores included); `device()` a browser session with a fresh
// identity; `client(dev)` that browser's cookie jar towards the service.
async function harness (t, { inviting = false, diditTimeoutMs } = {}) {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex') }, assocKp)
  const association = issuerCert.association
  const dir = path.join(tmpDir(t, 'varanda-age-e2e-'), 'account')
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const google = await fakeGoogle(t)
  const seederPort = await deadPort()
  const logs = []
  // Every response the service gave: { path, status, text, location, cookie }.
  const responses = []
  // `offset` moves the service clock (the 7-day rename cooldown).
  const h = { association, dir, fake, google, logs, responses, svc: null, offset: 0 }

  h.serve = async function serve () {
    const now = () => Date.now() + h.offset
    const store = openAccountStore(dir, { now })
    const ages = openAgeStore(dir, { now })
    const invites = inviting ? openInvitesStore(dir, { now, perWeek: 5, isUsed: (id) => store.inviteUsed(id) }) : null
    const diditOpts = { apiKey: API_KEY, workflowId: WORKFLOW, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) }
    if (diditTimeoutMs !== undefined) diditOpts.timeoutMs = diditTimeoutMs
    const server = createAccountServer({
      association,
      origin: ORIGIN,
      google: createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: google.endpoints, fetch: google.fetch }),
      store,
      issuer: { keyPair: issuerKp, cert: issuerCert },
      invites,
      didit: createDidit(diditOpts),
      ages,
      log: (e) => logs.push(JSON.stringify(e)),
      now
    })
    const listener = await server.listen({ host: '127.0.0.1', port: 0 })
    const svc = { store, ages, invites, association, issuer: { keyPair: issuerKp, cert: issuerCert }, closed: false, base: 'http://127.0.0.1:' + listener.port }
    svc.stop = async () => {
      if (svc.closed) return
      svc.closed = true
      await listener.close()
      await store.close()
    }
    t.teardown(() => svc.stop(), { force: true })
    h.svc = svc
    return svc
  }

  h.device = async function device () {
    const keyPair = crypto.keyPair()
    const internal = []
    const node = createBrowserNode({
      storage: memoryNodeStorage(),
      association,
      seederUrl: 'ws://127.0.0.1:' + seederPort + '/seeder',
      createSocket: (url) => {
        const ws = new WebSocket(url)
        ws.on('error', () => {})
        return ws
      },
      onInternalError: (err) => internal.push(err),
      writeGate: false
    })
    t.teardown(() => node.close(), { force: true })
    await node.setKeyPair(keyPair)
    const web = await connectClient(node)
    const { publicKey } = await web.request('identity.create')
    t.is(publicKey, b4a.toString(keyPair.publicKey, 'hex'), 'the session holds the key')
    return { node, web, keyPair, hex: publicKey, internal }
  }

  // A browser's cookie jar towards the current service lifetime.
  h.client = function client (dev) {
    const jar = { cookie: null }
    async function api (method, pathname, { body, withCookie = true } = {}) {
      const init = { method, redirect: 'manual', headers: {} }
      if (withCookie && jar.cookie !== null) init.headers.cookie = COOKIE + '=' + jar.cookie
      if (body !== undefined) {
        init.headers.origin = ORIGIN
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const res = await fetch(h.svc.base + pathname, init)
      const setCookie = res.headers.get('set-cookie') || ''
      const m = /^__Host-varanda-link=([A-Za-z0-9_-]+);.*Max-Age=(\d+)$/.exec(setCookie)
      if (m) jar.cookie = m[2] === '0' ? null : m[1]
      const text = await res.text()
      responses.push({ path: pathname, status: res.status, text, location: res.headers.get('location') || '', cookie: setCookie })
      let parsed = null
      try { parsed = JSON.parse(text) } catch {}
      return { status: res.status, location: res.headers.get('location'), body: parsed, text }
    }
    const post = (pathname, body) => api('POST', pathname, { body })

    // start, then the session signs `action` over the nonce (age.sign).
    async function age (action, extra = {}) {
      const started = await post('/account/age/start', { member: dev.hex })
      if (started.status !== 200) return started
      const { signature } = await dev.web.request('age.sign', { action, nonce: started.body.nonce })
      return post('/account/age/' + action, { member: dev.hex, nonce: started.body.nonce, signature, ...extra })
    }

    // The Google link through the fake Google, every proof signed by the
    // session (account.sign). Stops at the first refusal.
    async function link (username) {
      const started = await post('/account/start', { member: dev.hex, username })
      if (started.status !== 200) return { started, auth: started }
      const reserve = await dev.web.request('account.sign', { phase: 'reserve', nonce: started.body.nonce, username, sub: '' })
      const auth = await post('/account/authorize', { signature: reserve.signature })
      if (auth.status !== 200) return { started, auth }
      const consent = await fetch(new URL(auth.body.authorizeUrl), { redirect: 'manual' })
      await consent.text()
      google.account.sub = nextSub()
      const back = new URL(consent.headers.get('location'))
      if (back.origin !== ORIGIN) throw new Error('redirect to another origin')
      const cb = await api('GET', back.pathname + back.search)
      const pending = await api('GET', '/account/pending')
      if (pending.status !== 200) return { started, auth, cb, done: pending }
      const proof = await dev.web.request('account.sign', { phase: 'finish', nonce: pending.body.nonce, username, sub: pending.body.sub })
      const done = await post('/account/finish', { signature: proof.signature })
      return { started, auth, cb, done }
    }

    return { jar, api, post, age, link }
  }

  h.creates = () => fake.seen.filter((r) => r.method === 'POST' && r.path === '/v3/session/')
  h.deletes = () => fake.seen.filter((r) => r.method === 'DELETE')
  h.decisions = () => fake.seen.filter((r) => r.method === 'GET')
  h.lastSession = () => [...fake.sessions.keys()].pop()
  h.ageFile = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'age.json'), 'utf8'))
    } catch {
      return null
    }
  }
  return h
}

const DOC = (age) => ({ status: 'Approved', id_verifications: [{ status: 'Approved', age }] })
const FACE = (age) => ({ status: 'Approved', liveness_checks: [{ status: 'Approved', age_estimation: age }] })

test('age e2e 1: a fresh hosted key verifies 17 by document, then links with Google; the v2 certificate still says unchecked', async (t) => {
  t.timeout(30000)
  const h = await harness(t)
  await h.serve()
  const dev = await h.device()
  const c = h.client(dev)

  t.alike((await c.api('GET', '/account/age/policy')).body, { required: true }, 'policy: required')

  const sess = await c.age('session')
  t.is(sess.status, 200, sess.text)
  t.ok(typeof sess.body.url === 'string' && sess.body.url.startsWith('https://verify.didit.test/session/'), 'the fake hosted url')
  t.is(h.creates().length, 1, 'one Didit session')

  // Before the result: the Google sign-in is refused.
  const early = await c.link('ana')
  t.is(early.started.status, 200, 'start answers')
  t.is(early.auth.status, 403, 'authorize refused')
  t.alike(early.auth.body, { error: 'idade-pendente' })
  t.is(h.google.seen.length, 0, 'Google never reached')

  h.fake.sessions.set(h.lastSession(), DOC(17))
  const res = await c.age('result')
  t.is(res.status, 200, res.text)
  t.alike(res.body, { state: 'verificado' })
  const entry = h.ageFile().members[dev.hex]
  t.is(entry.band, '16-17', 'age.json holds 16-17 for the key')
  t.is(entry.method, 'didit')
  t.alike(Object.keys(entry).sort(), ['band', 'checkedAt', 'method'])

  const linked = await c.link('ana')
  t.is(linked.auth.status, 200, 'authorize after the band: ' + linked.auth.text)
  t.is(linked.cb.location, ORIGIN + '/?conta=ok')
  t.is(linked.done.status, 200, 'finish: ' + linked.done.text)
  const { cert } = linked.done.body
  t.is(cert.v, 2, 'a v2 certificate')
  t.is(cert.ageBand, 'unchecked', 'the certificate does not carry the band')
  t.ok(certForKey(cert, dev.hex, h.association).ok, 'it verifies for the key')
  t.ok(await waitFor(() => h.deletes().length === 1), 'the Didit session is deleted')
  t.alike(dev.internal, [], 'no internal error in the session')
})

// The directory files (snapshot and journals), byte for byte.
function directoryBytes (dir) {
  const out = {}
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('directory')) out[name] = fs.readFileSync(path.join(dir, name)).toString('hex')
  }
  return out
}

// Linked the way account-age.test.js links: straight through the store,
// which issues the same v2 certificate and username record finish does.
async function linkDirect (svc, dev, username) {
  const row = svc.store.start({ member: dev.hex, username })
  svc.store.reserve(row.id)
  svc.store.putGoogle(row.id, { sub: nextSub(), email: EMAIL })
  const { keyPair, cert } = svc.issuer
  await svc.store.finish(row.id, { signature: 'a'.repeat(128) }, keyPair, cert, svc.association)
}

test('age e2e 2: an already-linked v2 member is held at rename and invites until a face of 25 verifies it; the link is untouched', async (t) => {
  t.timeout(30000)
  const h = await harness(t, { inviting: true })
  const svc = await h.serve()
  const dev = await h.device()
  const c = h.client(dev)
  await linkDirect(svc, dev, 'bia')

  const status = async () => (await c.api('GET', '/account/status?member=' + dev.hex)).text
  const byName = async () => (await c.api('GET', '/account/username/bia')).text
  const before = { status: await status(), byName: await byName(), files: directoryBytes(h.dir) }
  const linkedStatus = JSON.parse(before.status)
  t.is(linkedStatus.linked, true, 'linked')
  t.is(linkedStatus.cert.v, 2, 'a v2 certificate')
  t.is(linkedStatus.cert.ageBand, 'unchecked')

  // Past the cooldown the link just started, so only the age gate could refuse.
  h.offset = COOLDOWN_MS
  const rename = () => c.post('/account/rename/start', { member: dev.hex, username: 'bia_nova' })
  const invites = () => c.post('/account/invites/start', { member: dev.hex })
  const renameFinish = async (nonce) => c.post('/account/rename/finish', {
    member: dev.hex,
    nonce,
    signature: (await dev.web.request('account.sign', { phase: 'rename', nonce, username: 'bia_nova', sub: '' })).signature
  })
  const invitesFinish = async (nonce) => c.post('/account/invites/finish', {
    member: dev.hex,
    nonce,
    signature: (await dev.web.request('invite.sign', { action: 'issue', nonce })).signature
  })
  // The unsigned starts reveal nothing about the age check; the signed
  // finishes refuse until it passes.
  for (const [name, start, end] of [['rename', rename, renameFinish], ['invites', invites, invitesFinish]]) {
    const st = await start()
    t.is(st.status, 200, name + '/start answers as for anyone: ' + st.text)
    const r = await end(st.body.nonce)
    t.is(r.status, 403, name + '/finish refused')
    t.alike(r.body, { error: 'idade-pendente' }, name + ': idade-pendente')
  }

  // Linked: no invite needed for the age session.
  t.is((await c.age('session')).status, 200, 'session opened')
  h.fake.sessions.set(h.lastSession(), FACE(25))
  const pend = await c.age('result')
  t.alike(pend.body, { state: 'verificado' }, 'face 25 verifies')
  t.is(h.ageFile().members[dev.hex].band, '18+', 'age.json: 18+')

  const after = { status: await status(), byName: await byName(), files: directoryBytes(h.dir) }
  t.is(after.status, before.status, 'status byte-identical (link and certificate)')
  t.is(after.byName, before.byName, 'username record byte-identical')
  t.alike(after.files, before.files, 'directory files byte-identical')
  t.ok(Object.keys(after.files).length > 0, 'the directory is on disk')

  const rn = await rename()
  t.is(rn.status, 200, 'rename/start works: ' + rn.text)
  const renamed = await renameFinish(rn.body.nonce)
  t.is(renamed.status, 200, 'rename finishes')
  t.is(renamed.body.usernameRecord.username, 'bia_nova')
  const inv = await invites()
  t.is(inv.status, 200, 'invites/start works: ' + inv.text)
  const issued = await invitesFinish(inv.body.nonce)
  t.is(issued.status, 200, 'an invite is issued')
})

test('age e2e 3: a document of 15 is refused, nothing is stored and the session is deleted without face embeddings', async (t) => {
  t.timeout(30000)
  const h = await harness(t)
  await h.serve()
  const dev = await h.device()
  const c = h.client(dev)
  t.is((await c.age('session')).status, 200)
  const id = h.lastSession()
  h.fake.sessions.set(id, DOC(15))
  const res = await c.age('result')
  t.is(res.status, 200, res.text)
  t.alike(res.body, { state: 'recusado' })
  const file = h.ageFile()
  t.absent(file && file.members[dev.hex], 'nothing stored in age.json')
  t.absent(h.svc.ages.verified(dev.hex))

  const a = await c.link('caio')
  t.is(a.auth.status, 403, 'authorize still refused')
  t.alike(a.auth.body, { error: 'idade-pendente' })

  t.ok(await waitFor(() => h.deletes().length === 1), 'one DELETE')
  const del = h.deletes()[0]
  t.is(del.path, '/v3/session/' + id + '/delete/')
  t.alike(del.body, { retain_face_embeddings: false })
  t.alike((await c.age('result')).body, { state: 'nenhum' }, 'the session is gone')
})

test('age e2e 4: In Review answers pendente, then an approved face of 22 verifies', async (t) => {
  t.timeout(30000)
  const h = await harness(t)
  await h.serve()
  const dev = await h.device()
  const c = h.client(dev)
  t.is((await c.age('session')).status, 200)
  const id = h.lastSession()
  h.fake.sessions.set(id, { status: 'In Review' })
  t.alike((await c.age('result')).body, { state: 'pendente' })
  t.is(h.deletes().length, 0, 'no delete while pending')
  t.absent(h.svc.ages.verified(dev.hex))

  h.fake.sessions.set(id, FACE(22))
  t.alike((await c.age('result')).body, { state: 'verificado' })
  t.is(h.ageFile().members[dev.hex].band, '18+')
  t.ok(await waitFor(() => h.deletes().length === 1), 'deleted once final')
  const linked = await c.link('duda')
  t.is(linked.done && linked.done.status, 200, 'the link goes through')
})

test('age e2e 5: after a restart the band is still on record and a session left open is forgotten', async (t) => {
  t.timeout(30000)
  const h = await harness(t)
  await h.serve()
  const done = await h.device()
  const open = await h.device()
  const a = h.client(done)
  const b = h.client(open)
  t.is((await a.age('session')).status, 200)
  h.fake.sessions.set(h.lastSession(), FACE(30))
  t.alike((await a.age('result')).body, { state: 'verificado' })
  t.is((await b.age('session')).status, 200)
  h.fake.sessions.set(h.lastSession(), { status: 'In Progress' })
  t.alike((await b.age('result')).body, { state: 'pendente' })
  t.ok(await waitFor(() => h.deletes().length === 1), 'the verified session is deleted before the restart')

  await h.svc.stop()
  const svc = await h.serve()
  const seen = h.fake.seen.length
  t.ok(svc.ages.verified(done.hex), 'the reopened store holds the band')
  const again = await a.age('result')
  t.is(again.status, 200, again.text)
  t.alike(again.body, { state: 'verificado' }, 'verificado after the restart')
  t.alike((await a.age('session')).body, { state: 'verificado' }, 'and no new session')
  t.is(h.fake.seen.length, seen, 'no Didit call for a verified member')
  const lost = await b.age('result')
  t.alike(lost.body, { state: 'nenhum' }, 'the pending session did not survive')
  t.is(h.fake.seen.length, seen, 'no decision read for it either')
  t.absent(svc.ages.verified(open.hex))
  t.is(h.ageFile().members[done.hex].band, '18+')
  const linked = await a.link('eva')
  t.is(linked.done && linked.done.status, 200, 'the verified key links after the restart')
})

test('age e2e 6: a terms or an invite signature over an age nonce is refused', async (t) => {
  t.timeout(30000)
  const h = await harness(t)
  await h.serve()
  const dev = await h.device()
  const c = h.client(dev)

  const attempts = [
    ['terms.sign', (nonce) => dev.web.request('terms.sign', { nonce, version: TERMS_VERSION })],
    ['signTerms', async (nonce) => ({ signature: signTerms({ nonce, member: dev.hex, association: h.association, version: TERMS_VERSION }, dev.keyPair) })],
    ['invite.sign', (nonce) => dev.web.request('invite.sign', { action: 'issue', nonce })]
  ]
  for (const action of ['session', 'result']) {
    for (const [name, signer] of attempts) {
      const started = await c.post('/account/age/start', { member: dev.hex })
      t.is(started.status, 200)
      const { signature } = await signer(started.body.nonce)
      const r = await c.post('/account/age/' + action, { member: dev.hex, nonce: started.body.nonce, signature })
      t.is(r.status, 400, name + ' for ' + action)
      t.alike(r.body, { error: 'assinatura-invalida' }, name + ' for ' + action + ': assinatura-invalida')
    }
  }
  t.is(h.fake.seen.length, 0, 'Didit never called')
  t.is(h.ageFile(), null, 'no age.json')
})

test('age e2e 7: one paid session per hour for repeated calls, and none re-created after a timeout', async (t) => {
  t.timeout(30000)
  const h = await harness(t, { diditTimeoutMs: 300 })
  await h.serve()
  const dev = await h.device()
  const c = h.client(dev)
  const first = await c.age('session')
  const second = await c.age('session')
  t.is(first.status, 200, first.text)
  t.is(second.status, 200, second.text)
  t.is(second.body.url, first.body.url, 'the same url')
  t.is(h.creates().length, 1, 'exactly one create')

  // Another member: the fake swallows the create and never answers.
  const late = await h.device()
  const l = h.client(late)
  h.fake.script({ create () {} })
  const timedOut = await l.age('session')
  t.is(timedOut.status, 503)
  t.alike(timedOut.body, { error: 'resultado-incerto' }, 'Didit may have created it: unknown, not refused')
  t.is(h.creates().length, 2, 'one attempt for the timed-out call')
  await sleep(1000)
  t.is(h.creates().length, 2, 'nothing re-created on its own')
  t.is(h.deletes().length, 0, 'and nothing deleted')
})

test('age e2e 8: no birth date, document number, session token, api key, session id or url leaks to a file, a response or a log', async (t) => {
  t.timeout(30000)
  const DOB = '1987-07-19'
  const DOC_NUMBER = 'DOCSENTINEL4471X'
  const TOKEN = 'tok-sentinel-session-9182'
  const h = await harness(t)
  await h.serve()
  const ids = []
  h.fake.script({
    create (req, res, ctx) {
      const id = 'sess-sentinel-' + nodeCrypto.randomBytes(6).toString('hex')
      ids.push(id)
      h.fake.sessions.set(id, { status: 'Not Started' })
      ctx.json(res, 201, { session_id: id, session_number: 7, session_token: TOKEN, url: 'https://verify.didit.test/session/' + id, status: 'Not Started' })
    }
  })
  const dev = await h.device()
  const c = h.client(dev)
  const sess = await c.age('session')
  t.is(sess.status, 200, sess.text)
  const url = sess.body.url
  t.ok(url.includes(ids[0]), 'the member got its url')
  h.fake.sessions.set(ids[0], {
    status: 'Approved',
    session_token: TOKEN,
    id_verifications: [{ status: 'Approved', age: 38, date_of_birth: DOB, document_number: DOC_NUMBER, first_name: 'Fulana' }]
  })
  t.alike((await c.age('result')).body, { state: 'verificado' })
  t.ok(await waitFor(() => h.deletes().length === 1), 'deleted')
  const linked = await c.link('fabi')
  t.is(linked.done && linked.done.status, 200, 'linked')
  await h.svc.stop()

  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else files.push(fs.readFileSync(p, 'latin1'))
    }
  }
  walk(path.dirname(h.dir))
  t.ok(files.length >= 2, 'age.json and the directory are on disk')
  const responseText = (r) => [r.text, r.location, r.cookie].join('\n')
  const everywhere = files.concat(h.responses.map(responseText), h.logs, JSON.stringify(dev.web.events))
  const all = everywhere.join('\n')
  for (const [name, needle] of [['birth date', DOB], ['document number', DOC_NUMBER], ['session token', TOKEN], ['api key', API_KEY], ['name', 'Fulana']]) {
    t.absent(all.includes(needle), 'no ' + name + ' anywhere')
  }
  // The url (and the id in it) goes only to its own member, in the session answer.
  const urlAnswers = h.responses.filter((r) => r.path === '/account/age/session' && r.status === 200)
  t.is(urlAnswers.length, 1)
  const rest = files.concat(h.responses.filter((r) => !urlAnswers.includes(r)).map(responseText), h.logs).join('\n')
  t.absent(rest.includes(url), 'no session url elsewhere')
  t.absent(rest.includes(ids[0]), 'no session id elsewhere')
  t.absent(rest.includes('verify.didit.test'), 'no Didit host elsewhere')
  t.absent(h.logs.join('\n').includes('sentinel'), 'no sentinel in a log line')
  for (const line of h.logs) {
    t.ok(Object.keys(JSON.parse(line)).every((k) => k === 'event' || k === 'reason'), 'log line carries only event and reason: ' + line)
  }
})
