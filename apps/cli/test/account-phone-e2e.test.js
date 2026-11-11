'use strict'

// End to end, loopback only: hosted phone verification (Didit) from the
// browser session to the account service, modelled on
// account-age-e2e.test.js. The pieces: an association and an issuer certified
// by it, the account service in-process (createAccountServer over a temp data
// dir with the real account, age, phone, passkey and moderation stores), the
// Didit fake of helpers/fake-didit.js behind the real phone client
// (./phone-client.js), a fake Google on 127.0.0.1 and a browser node session
// over memory storage holding a random key pair, whose seeder is a dead port.
// What is proven here and nowhere else: the phone requests the session signs
// (phone.sign) are the ones the service verifies; the proofs the service
// answers are the ones the session stores (phone.proof) and reads back on
// node.info; the finish gate holds a key without a number and lets it
// through after, with a certificate that carries no phone field; Excluir
// conta ends the row and keeps the seal; and the number never reaches a log,
// a response, the certificate or any file in clear.

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
const { verifyPhoneVerified, verifyPhoneSince } = require('@varanda/core/lib/phone-proof')
const { tmpDir } = require('./helpers/net')
const { freePort } = require('./helpers/free-port')
const { startFakeDidit, loopbackFetch, PHONE_CODE } = require('./helpers/fake-didit')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { createGoogle } = require('../lib/account/google')
const { createDidit } = require('../lib/account/didit')
const { createPhoneClient } = require('../lib/account/phone-client')
const { openAccountStore, phoneSub } = require('../lib/account/store')
const { openAgeStore } = require('../lib/account/age-store')
const { openPhoneStore, FILE: PHONE_FILE } = require('../lib/account/phone-store')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createAccountServer, COOKIE } = require('../lib/account/server')
// The browser node lives in packages/web-member; apps/cli does not depend
// on it, so it is reached by path (as account-e2e.test.js reaches it).
const { createBrowserNode } = require('../../../packages/web-member/lib/node')
const { memoryNodeStorage } = require('../../../packages/web-member/lib/node-storage')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-phone-e2e.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-phone-e2e'
const ACCESS = 'ya29.access-token-phone-e2e'
const CODE = 'codigo-phone-e2e-1'
const EMAIL = 'membro-phone-e2e@example.test'
const API_KEY = 'didit-key-phone-e2e-0123456789'
const WORKFLOW = '11111111-2222-4333-8444-555555555555'
const PHONE = '+5511987654321'
const DIGITS = '11987654321'

let subSeq = 0
function nextSub () {
  return '50000000000000000' + String(10000 + subSeq++)
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

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// Fake Google on 127.0.0.1, as account-age-e2e.test.js.
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

async function harness (t) {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex') }, assocKp)
  const association = issuerCert.association
  const dir = path.join(tmpDir(t, 'varanda-phone-e2e-'), 'account')
  const phoneKey = nodeCrypto.randomBytes(32)
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const google = await fakeGoogle(t)
  const seederPort = await deadPort()
  const logs = []
  const responses = []
  const h = { association, dir, phoneKey, fake, google, logs, responses, svc: null }

  h.serve = async function serve () {
    const store = openAccountStore(dir)
    const ages = openAgeStore(dir)
    const phones = openPhoneStore(dir, { key: phoneKey })
    const passkeys = openPasskeyStore(dir)
    const moderation = openModerationStore(dir, { association })
    let port
    do { port = await freePort() } while (port === seederPort)
    const base = 'http://127.0.0.1:' + port
    const server = createAccountServer({
      association,
      origin: base,
      google: createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: google.endpoints, fetch: google.fetch }),
      store,
      issuer: { keyPair: issuerKp, cert: issuerCert },
      moderation,
      passkeys,
      didit: createDidit({ apiKey: API_KEY, workflowId: WORKFLOW, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) }),
      ages,
      phoneClient: createPhoneClient({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) }),
      phones,
      log: (e) => logs.push(JSON.stringify(e))
    })
    const listener = await server.listen({ host: '127.0.0.1', port })
    const svc = { store, ages, phones, passkeys, closed: false, base: 'http://127.0.0.1:' + listener.port }
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

  h.client = function client (dev) {
    const jar = { cookie: null }
    async function api (method, pathname, { body } = {}) {
      const init = { method, redirect: 'manual', headers: {} }
      if (jar.cookie !== null) init.headers.cookie = COOKIE + '=' + jar.cookie
      if (body !== undefined) {
        init.headers.origin = h.svc.base
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

    // start, then the session signs `action` over the nonce (phone.sign).
    async function phone (action, extra = {}) {
      const started = await post('/account/phone/start', { member: dev.hex })
      if (started.status !== 200) return started
      const { signature } = await dev.web.request('phone.sign', { action, nonce: started.body.nonce })
      return post('/account/phone/' + action, { member: dev.hex, nonce: started.body.nonce, signature, ...extra })
    }

    return { jar, api, post, phone }
  }

  h.reveal = (member) => openPhoneStore(dir, { key: phoneKey, readOnly: true, disclose: true }).reveal(member)
  return h
}

test('phone e2e: a session verifies its number, stores the proofs, links without a phone field and Excluir conta keeps the seal', async (t) => {
  t.timeout(60000)
  const h = await harness(t)
  await h.serve()
  const dev = await h.device()
  const c = h.client(dev)

  t.alike((await c.api('GET', '/account/phone/policy')).body, { required: true }, 'policy: required')
  t.alike((await c.api('GET', '/account/phone/since')).body, { since: null }, 'no number verified yet')

  // The age band comes first (the brake on paid sends); written straight to
  // the store, as account-phone.test.js does.
  await h.svc.ages.record({ member: dev.hex, band: '18+', method: 'didit', checkedAt: new Date().toISOString() })

  const started = await c.post('/account/start', { member: dev.hex, username: 'ana' })
  t.is(started.status, 200, 'start answers')
  const proof = await dev.web.request('account.sign', { phase: 'finish', nonce: started.body.nonce, username: 'ana', sub: phoneSub(dev.hex) })
  const early = await c.post('/account/finish', { signature: proof.signature })
  t.is(early.status, 403, 'finish refused before phone verification')
  t.alike(early.body, { error: 'telefone-pendente' })
  t.is(h.google.seen.length, 0, 'Google never reached')

  const sent = await c.phone('send', { phone: PHONE })
  t.is(sent.status, 200, sent.text)
  t.alike(sent.body, { state: 'enviado' })
  const sends = h.fake.seen.filter((r) => r.path === '/v3/phone/send/')
  t.is(sends.length, 1, 'one phone send through the real client')
  t.is(sends[0].body.options.preferred_channel, 'sms')
  t.is(sends[0].body.phone_number, PHONE, 'the provider received the number')
  const checked = await c.phone('check', { code: PHONE_CODE })
  t.is(checked.status, 200, checked.text)
  t.alike(Object.keys(checked.body), ['state', 'proof'])
  t.is(checked.body.state, 'verificado')
  const verified = checked.body.proof
  t.alike(verifyPhoneVerified(verified, dev.hex, h.association), { ok: true }, 'the proof verifies for this key')
  t.absent(JSON.stringify(verified).includes(DIGITS), 'the proof carries no number')
  t.alike((await c.phone('status')).body, checked.body, 'status answers the same proof')

  const stored = await dev.web.request('phone.proof', { verified })
  t.is(stored.phoneVerifiedDate, verified.date, 'phone.proof answers the stored date')
  let info = await dev.web.request('node.info')
  t.is(info.phoneVerifiedDate, verified.date, 'node.info: phoneVerifiedDate')
  t.is(info.phoneSince, null, 'no since stored yet')

  const sinceRes = await c.api('GET', '/account/phone/since')
  t.is(sinceRes.status, 200, sinceRes.text)
  const since = sinceRes.body.since
  t.ok(since !== null, 'a since once a number is verified')
  t.alike(verifyPhoneSince(since, h.association), { ok: true }, 'the since verifies')
  await dev.web.request('phone.proof', { since })
  info = await dev.web.request('node.info')
  t.is(info.phoneSince, since.since, 'node.info: phoneSince')
  t.is(info.phoneVerifiedDate, verified.date, 'the verified date is kept')

  t.is(h.fake.seen.filter((r) => r.path === '/v3/phone/check/').length, 1, 'one code check')
  t.is((await c.api('GET', '/account/callback?code=retired')).location, h.svc.base + '/?conta=erro')
  t.is(h.google.seen.length, 0, 'the retired callback makes no outbound request')
  // The row kept by the refused finish links now that the number is verified.
  if (c.jar.cookie === null) {
    const again = await c.post('/account/start', { member: dev.hex, username: 'ana' })
    t.is(again.status, 200, 'start again after the cookie was cleared')
    started.body = again.body
  }
  const finalProof = await dev.web.request('account.sign', { phase: 'finish', nonce: started.body.nonce, username: 'ana', sub: phoneSub(dev.hex) })
  const linked = await c.post('/account/finish', { signature: finalProof.signature })
  t.is(linked.status, 200, 'finish after the number: ' + linked.text)
  const { cert } = linked.body
  t.ok(certForKey(cert, dev.hex, h.association).ok, 'the certificate verifies for the key')
  t.absent(Object.keys(cert).some((k) => /phone|telefone/i.test(k)), 'no phone field in the certificate')
  t.absent(JSON.stringify(cert).includes(DIGITS), 'no number in the certificate')

  // Excluir conta with a stored passkey: immediate.
  const pk = createFakePasskey({ rpId: new URL(h.svc.base).hostname })
  const key = keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: new URL(h.svc.base).hostname })
  await h.svc.passkeys.add({ member: dev.hex, credentialId: pk.credentialId, ...key })
  const st = await c.post('/account/delete/start', { member: dev.hex })
  t.is(st.status, 200, st.text)
  const { signature } = await dev.web.request('account.sign', { phase: 'delete', nonce: st.body.nonce, username: st.body.username, sub: '' })
  const done = await c.post('/account/delete/finish', {
    member: dev.hex,
    nonce: st.body.nonce,
    signature,
    assertion: pk.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: h.svc.base })
  })
  t.is(done.status, 200, done.text)
  t.ok(h.svc.store.deletedAt(dev.hex) !== null, 'the key is deleted')
  t.absent(h.svc.phones.verified(dev.hex), 'no live number')

  const rows = h.reveal(dev.hex)
  t.is(rows.length, 1, 'the row stays')
  t.is(rows[0].end, 'excluida', 'ended by the deletion')
  t.ok(rows[0].endedAt !== null)
  t.is(rows[0].phone, PHONE, 'the seal is kept for a court order')
  t.alike(dev.internal, [], 'no internal error in the session')

  await h.svc.stop()
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else files.push({ name: e.name, text: fs.readFileSync(p, 'latin1') })
    }
  }
  walk(h.dir)
  t.ok(files.some((f) => f.name === PHONE_FILE), 'phone.json is on disk')
  t.is(fs.statSync(path.join(h.dir, PHONE_FILE)).mode & 0o777, 0o600, 'phone.json is 0600')
  for (const f of files) t.absent(f.text.includes(DIGITS), f.name + ': no number in clear')
  const responseText = (r) => [r.text, r.location, r.cookie].join('\n')
  const all = h.responses.map(responseText).concat(h.logs, JSON.stringify(dev.web.events)).join('\n')
  t.absent(all.includes(DIGITS), 'no number in a response, a log line or a session event')
  t.absent(all.includes(PHONE_CODE), 'no code either')
  for (const line of h.logs) {
    t.ok(Object.keys(JSON.parse(line)).every((k) => k === 'event' || k === 'reason'), 'log line carries only event and reason: ' + line)
  }
})
