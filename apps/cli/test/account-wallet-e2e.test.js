'use strict'

// End to end, loopback only: the optional payments account (Hodle) from the
// browser session to the account service. The pieces: an association and an
// issuer certified by it, the account service in-process (createAccountServer
// over a temp data dir with the real account, terms and wallet stores), the
// Hodle fake of helpers/fake-hodle.js behind the real client (./hodle.js), a
// fake Google on 127.0.0.1 (as account-age-e2e.test.js) and a browser node
// session over memory storage holding a random key pair, whose seeder is a
// dead port (nothing here syncs).
// What is proven here and nowhere else: the wallet requests the session signs
// (wallet.sign) are the ones the service verifies, from opt-in through KYC to
// the wallet; wallet.json keeps only identifiers and the wrapped key and
// survives a restart; no PIN, CPF or name reaches a file, a response or a log
// line; a create whose answer was lost is never repeated (C12); the mode gates
// the routes (C11); the social routes do not depend on Hodle; and in completo
// a BRLA send by @nome or to an address moves exactly what was signed, its
// fee only after the principal concluded, never twice on a lost answer
// (C9, C10); USDC shows in the balance and the statement, a conversion moves
// USDC down and BRLA up, a lost one is never POSTed again, and a USDC send
// collects its USDC fee only after the principal concluded. The route-level
// cases live in account-wallet.test.js.
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
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { tmpDir } = require('./helpers/net')
const { startFakeHodle, loopbackFetch, FAKE_LIVENESS_TOKEN, FAKE_POOL_ID } = require('./helpers/fake-hodle')
const { createGoogle } = require('../lib/account/google')
const { createHodle } = require('../lib/account/hodle')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openWalletStore } = require('../lib/account/wallet-store')
const { openWalletOpsStore } = require('../lib/account/wallet-ops-store')
const { parseFees, feeCents } = require('../lib/account/fees')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { canonicalJson } = require('../lib/account/wallet-routes')
// The browser node lives in packages/web-member; apps/cli does not depend
// on it, so it is reached by path (as account-e2e.test.js reaches it).
const { createBrowserNode } = require('../../../packages/web-member/lib/node')
const { memoryNodeStorage } = require('../../../packages/web-member/lib/node-storage')

const ORIGIN = 'https://varanda.test'
const CLIENT_ID = 'client-wallet-e2e.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-wallet-e2e'
const ACCESS = 'ya29.access-token-wallet-e2e'
const CODE = 'codigo-wallet-e2e-1'
const EMAIL = 'membro-wallet-e2e@example.test'
const API_KEY = 'hodle_test_walletE2Ekey0123456789'
const PIN = '246813'
const CPF = '52998224725'
const NAME = 'Sentinela Nomecompleto Wallete'
const KYC = Object.freeze({
  fullName: NAME,
  dateOfBirth: '1988-03-14',
  taxIdNumber: CPF,
  email: 'sentinela-kyc@example.test',
  country: 'BR',
  state: 'MG',
  city: 'Belo Horizonte',
  zipCode: '30130010',
  streetAddress: 'Rua Sentinela Endereco 77'
})
const ENTRY_KEYS = [
  'createdAt', 'kyc', 'network', 'subAccountId', 'subaccountMarkAt', 'subaccountUncertain',
  'wallet', 'walletMarkAt', 'walletUncertain'
]
const KYC_KEYS = ['attempt', 'attemptId', 'documentId', 'selfieId', 'status', 'updatedAt']
const WALLET_KEYS = ['address', 'createdAt', 'id', 'protectedSymmetricKey']
// The member's signed statement that they are 18 or older.
const OPTIN_OP = Object.freeze({ adult: 1 })
// The PIN is six digits, so a random hex or base64 run could contain it; a
// leak shows it standing on its own.
const PIN_ALONE = new RegExp('(^|[^A-Za-z0-9_-])' + PIN + '([^A-Za-z0-9_-]|$)')

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

// The Hodle subaccount name the service gives a member (128 bits of the key).
function subName (dev) {
  return 'membro-' + dev.hex.slice(0, 32)
}

function kycHash (kyc) {
  return nodeCrypto.createHash('sha256').update(canonicalJson(kyc), 'utf8').digest('hex')
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
  const account = { sub: nextSub() }
  let challenge = null
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url, 'http://127.0.0.1')
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
  return { endpoints, fetch: loopbackFetch(base), account }
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

// `serve()` opens one service lifetime over `dir` (stores included) with the
// current `h.mode`; `device()` a browser session with a fresh identity;
// `client(dev)` that browser's cookie jar towards the service.
async function harness (t, { mode = 'carteira', fees = null, webhookSecrets = null, moneyTimeoutMs } = {}) {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex') }, assocKp)
  const association = issuerCert.association
  const root = tmpDir(t, 'varanda-wallet-e2e-')
  const dir = path.join(root, 'account')
  const fake = await startFakeHodle()
  t.teardown(() => fake.close(), { force: true })
  const google = await fakeGoogle(t)
  const seederPort = await deadPort()
  const logs = []
  // Every response the service gave: { path, status, text, location, cookie }.
  const responses = []
  const h = { association, root, dir, fake, google, logs, responses, svc: null, offset: 0, mode, devices: [] }

  h.serve = async function serve () {
    const now = () => Date.now() + h.offset
    const store = openAccountStore(dir, { now })
    const terms = openTermsStore(dir, { now })
    const wallets = openWalletStore(dir, { now })
    const ops = openWalletOpsStore(dir, { now })
    const hodle = createHodle({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) })
    const server = createAccountServer({
      association,
      origin: ORIGIN,
      google: createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + '/account/callback', endpoints: google.endpoints, fetch: google.fetch }),
      store,
      issuer: { keyPair: issuerKp, cert: issuerCert },
      terms,
      hodle,
      wallets,
      walletMode: h.mode,
      ops,
      fees,
      walletWebhookSecrets: webhookSecrets,
      walletMoneyTimeoutMs: moneyTimeoutMs,
      log: (e) => logs.push(JSON.stringify(e)),
      now
    })
    const listener = await server.listen({ host: '127.0.0.1', port: 0 })
    const svc = { store, terms, wallets, ops, closed: false, base: 'http://127.0.0.1:' + listener.port }
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
    const dev = { node, web, keyPair, hex: publicKey, internal }
    h.devices.push(dev)
    return dev
  }

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

    // The Google link through the fake Google, every proof signed by the
    // session (account.sign).
    async function link (username) {
      const started = await post('/account/start', { member: dev.hex, username })
      if (started.status !== 200) return { done: started }
      const reserve = await dev.web.request('account.sign', { phase: 'reserve', nonce: started.body.nonce, username, sub: '' })
      const auth = await post('/account/authorize', { signature: reserve.signature })
      if (auth.status !== 200) return { done: auth }
      const consent = await fetch(new URL(auth.body.authorizeUrl), { redirect: 'manual' })
      await consent.text()
      google.account.sub = nextSub()
      const back = new URL(consent.headers.get('location'))
      if (back.origin !== ORIGIN) throw new Error('redirect to another origin')
      await api('GET', back.pathname + back.search)
      const pending = await api('GET', '/account/pending')
      if (pending.status !== 200) return { done: pending }
      const proof = await dev.web.request('account.sign', { phase: 'finish', nonce: pending.body.nonce, username, sub: pending.body.sub })
      return { done: await post('/account/finish', { signature: proof.signature }) }
    }

    async function acceptTerms () {
      const started = await post('/account/terms/start', { member: dev.hex, version: TERMS_VERSION })
      if (started.status !== 200) return started
      const { signature } = await dev.web.request('terms.sign', { nonce: started.body.nonce, version: TERMS_VERSION })
      return post('/account/terms/finish', { member: dev.hex, nonce: started.body.nonce, signature })
    }

    // start, then the session signs `action` and `op` over the nonce
    // (wallet.sign); `extra` carries the unsigned secrets (kyc, pin).
    async function wallet (action, op = {}, extra = {}) {
      const started = await post('/account/wallet/start', { member: dev.hex, action })
      if (started.status !== 200) return started
      const nonce = started.body.nonce
      const { signature } = await dev.web.request('wallet.sign', { action, nonce, op })
      return post('/account/wallet/' + action, { member: dev.hex, nonce, action, op, signature, ...extra })
    }

    return { jar, api, post, link, acceptTerms, wallet }
  }

  // A linked member with the current terms accepted.
  h.member = async function member (username) {
    const dev = await h.device()
    const c = h.client(dev)
    const linked = await c.link(username)
    t.is(linked.done.status, 200, 'linked: ' + linked.done.text)
    const terms = await c.acceptTerms()
    t.is(terms.status, 200, 'terms accepted: ' + terms.text)
    t.is(terms.body.version, TERMS_VERSION)
    return { dev, c }
  }

  h.seen = (method, p) => fake.seen.filter((r) => r.method === method && (typeof p === 'string' ? r.path === p : p.test(r.path)))
  h.walletFile = () => {
    try {
      return fs.readFileSync(path.join(dir, 'wallet.json'), 'utf8')
    } catch {
      return ''
    }
  }
  h.entry = (hex) => {
    const text = h.walletFile()
    return text === '' ? null : (JSON.parse(text).members[hex] || null)
  }
  h.markReady = () => {
    for (const doc of fake.state.documents.values()) doc.ready = true
  }
  return h
}

// Opt-in, both uploads, readiness at Hodle, the submit, then status polled
// until the fake's attempt says APPROVED.
async function approve (t, h, c, dev) {
  const optin = await c.wallet('optin', OPTIN_OP)
  t.is(optin.status, 200, 'optin: ' + optin.text)
  t.is(optin.body.account.kyc.state, 'documentos')
  t.is(optin.body.account.subaccountUncertain, false)
  const doc = await c.wallet('kyc-document', { documentType: 'ID' })
  t.is(doc.status, 200, 'document: ' + doc.text)
  t.ok(typeof doc.body.uploadUrlFront === 'string', 'an upload url for the member')
  const selfie = await c.wallet('kyc-document', { documentType: 'SELFIE-FROM-LIVENESS' })
  t.is(selfie.status, 200, 'selfie: ' + selfie.text)
  t.ok(typeof selfie.body.livenessUrl === 'string', 'a liveness url for the member')
  t.ok(selfie.body.capture && typeof selfie.body.capture.sessionId === 'string', 'the capture session reaches the client')
  t.is(selfie.body.capture.region, 'eu-west-1')
  t.is(selfie.body.capture.identityPoolId, FAKE_POOL_ID)
  t.absent(selfie.text.includes(FAKE_LIVENESS_TOKEN), 'no liveness token in the answer')
  t.absent(h.walletFile().includes(FAKE_LIVENESS_TOKEN), 'no liveness token in wallet.json')
  const validates = h.seen('POST', '/api/public/liveness/validate').length
  const validated = await c.wallet('kyc-liveness-validate', {})
  t.is(validated.status, 200, 'liveness validate: ' + validated.text)
  t.is(typeof validated.body.ready, 'boolean')
  t.is(h.seen('POST', '/api/public/liveness/validate').length, validates + 1, 'validated once at Hodle')
  h.markReady()

  const sub = await c.wallet('kyc-submit', { kycHash: kycHash(KYC) }, { kyc: { ...KYC } })
  t.is(sub.status, 200, 'submit: ' + sub.text)
  t.is(sub.body.account.kyc.state, 'pendente')
  const attemptId = h.entry(dev.hex).kyc.attemptId
  const attempt = h.fake.state.kyc.get(attemptId)
  t.ok(attempt, 'the fake holds the attempt')
  attempt.status = 'PENDING'

  let state = null
  for (let i = 0; i < 4 && state !== 'aprovado'; i++) {
    const st = await c.wallet('status')
    t.is(st.status, 200, 'status: ' + st.text)
    state = st.body.account.kyc.state
    if (i === 0) {
      t.is(state, 'pendente', 'pending while the fake says PENDING')
      attempt.status = 'APPROVED'
    }
    // Hodle is read at most every 20 s per member.
    h.offset += 21000
  }
  t.is(state, 'aprovado', 'approved once the fake says APPROVED')
}

function walk (d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(fs.readFileSync(p, 'latin1'))
  }
  return out
}

function noSecrets (t, h, label) {
  const responseText = (r) => [r.text, r.location, r.cookie].join('\n')
  const parts = walk(h.root).concat(h.responses.map(responseText), h.logs, h.devices.map((d) => JSON.stringify(d.web.events)))
  const all = parts.join('\n')
  t.absent(PIN_ALONE.test(all), label + ': no PIN in a file, a response, a log line or an event')
  t.absent(all.includes(CPF), label + ': no CPF anywhere')
  t.absent(all.includes(FAKE_LIVENESS_TOKEN), label + ': no liveness token anywhere')
  t.absent(all.includes(NAME), label + ': no name anywhere')
  t.absent(all.includes(KYC.streetAddress), label + ': no address anywhere')
  t.absent(all.includes(KYC.email), label + ': no KYC e-mail anywhere')
  t.absent(all.includes(API_KEY), label + ': no api key anywhere')
  for (const line of h.logs) {
    t.ok(Object.keys(JSON.parse(line)).every((k) => k === 'event' || k === 'reason'), 'log line carries only event and reason: ' + line)
  }
}

function bearerOnlyInAuthorization (t, h) {
  t.ok(h.fake.seen.length > 0, 'the fake was called')
  let ok = true
  for (const r of h.fake.seen) {
    // The public liveness routes take the validate token alone, never the key.
    const expected = r.path.startsWith('/api/public/liveness/') ? undefined : 'Bearer ' + API_KEY
    if (r.headers.authorization !== expected) ok = false
    const rest = { ...r.headers }
    delete rest.authorization
    const text = JSON.stringify([r.path, r.query, rest, r.body])
    if (text.includes(API_KEY)) ok = false
  }
  t.ok(ok, 'the api key rode only in the Authorization header of every keyed request')
}

test('wallet e2e 1: opt-in, KYC and wallet through wallet.sign; nothing personal stored; a restart keeps it; the social routes outlive Hodle', async (t) => {
  t.timeout(60000)
  const h = await harness(t, { mode: 'carteira' })
  await h.serve()
  const { dev, c } = await h.member('wanda')

  const policy = await c.api('GET', '/account/wallet/policy')
  t.alike(policy.body, { available: true, network: 'polygon', mode: 'carteira', actions: ['optin', 'kyc-document', 'kyc-submit', 'status', 'kyc-liveness-validate', 'kyc-liveness-retry', 'wallet-create'] }, 'policy: on, carteira')
  const none = await c.wallet('status')
  t.alike(none.body, { account: null }, 'no account before the opt-in')

  await approve(t, h, c, dev)

  // The KYC fields reached Hodle once, in the submit, with the country mapped.
  const submits = h.seen('POST', '/api/kyc')
  t.is(submits.length, 1, 'one KYC submit')
  t.is(submits[0].body.taxIdNumber, CPF)
  t.is(submits[0].body.fullName, NAME)
  t.is(submits[0].body.country, 'BRA')

  const created = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(created.status, 200, 'wallet-create: ' + created.text)
  const address = created.body.address
  t.ok(/^0x[0-9a-f]{40}$/.test(address), 'a lowercase address')
  const creates = h.seen('POST', '/api/wallet/create')
  t.is(creates.length, 1, 'one wallet create')
  t.is(creates[0].body.walletPin, PIN, 'the PIN went to Hodle')
  t.is(creates[0].body.network, 'polygon')

  const st = await c.wallet('status')
  t.is(st.status, 200)
  t.is(st.body.account.address, address)
  t.alike(st.body.account.wallet, { address })
  t.is(st.body.account.walletUncertain, false)
  t.is(st.body.account.kyc.state, 'aprovado')

  // wallet.json: identifiers and the wrapped key, nothing else.
  const fileText = h.walletFile()
  const file = JSON.parse(fileText)
  t.alike(Object.keys(file).sort(), ['members', 'v'])
  t.alike(Object.keys(file.members), [dev.hex], 'one member')
  const entry = file.members[dev.hex]
  t.alike(Object.keys(entry).sort(), ENTRY_KEYS, 'exactly the entry keys')
  t.alike(Object.keys(entry.kyc).sort(), KYC_KEYS, 'exactly the KYC keys')
  t.alike(Object.keys(entry.wallet).sort(), WALLET_KEYS, 'exactly the wallet keys')
  const fakeSubs = [...h.fake.state.subaccounts.keys()]
  t.alike(fakeSubs, [entry.subAccountId], 'the subaccount id is the fake one')
  t.is(h.fake.state.subaccounts.get(entry.subAccountId).name, subName(dev))
  const fakeWallet = h.fake.state.wallets.get(entry.subAccountId)[0]
  t.is(entry.wallet.id, fakeWallet.id)
  t.is(entry.wallet.address, address)
  t.is(entry.wallet.protectedSymmetricKey, fakeWallet.protectedSymmetricKey, 'the wrapped key is kept')
  t.is(entry.kyc.status, 'aprovado')
  t.is(entry.walletUncertain, false)
  t.is(entry.subaccountUncertain, false)
  t.absent(st.text.includes(fakeWallet.protectedSymmetricKey), 'the wrapped key never goes to the browser')
  t.absent(h.responses.some((r) => r.text.includes(fakeWallet.protectedSymmetricKey)), 'in no response')
  noSecrets(t, h, 'before the restart')

  // A restart over the same dir keeps the account and the wallet.
  await h.svc.stop()
  await h.serve()
  const again = await c.wallet('status')
  t.is(again.status, 200, again.text)
  t.alike(again.body.account.wallet, { address }, 'the wallet survives the restart')
  t.is(again.body.account.kyc.state, 'aprovado')
  const before = h.seen('POST', '/api/wallet/create').length
  const second = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(second.status, 200, second.text)
  t.alike(second.body, { address }, 'the same wallet')
  t.is(h.seen('POST', '/api/wallet/create').length, before, 'no second POST /api/wallet/create')
  t.is(h.walletFile(), fileText, 'wallet.json unchanged')

  bearerOnlyInAuthorization(t, h)

  // Hodle down: the social routes still answer.
  await h.fake.close()
  const status = await c.api('GET', '/account/status?member=' + dev.hex)
  t.is(status.status, 200, 'account status answers')
  t.is(status.body.linked, true)
  const byName = await c.api('GET', '/account/username/wanda')
  t.is(byName.status, 200, 'username lookup answers')
  const p2 = await c.api('GET', '/account/wallet/policy')
  t.is(p2.status, 200, 'the wallet policy answers')
  noSecrets(t, h, 'after the restart')
  t.alike(dev.internal, [], 'no internal error in the session')
})

test('wallet e2e 2: a 5xx on create leaves walletUncertain, the next create adopts the fake wallet without a second POST; a readable get with no address stays frozen', async (t) => {
  t.timeout(60000)
  const h = await harness(t, { mode: 'carteira' })
  await h.serve()
  const { dev, c } = await h.member('wesley')
  await approve(t, h, c, dev)
  const subAccountId = h.entry(dev.hex).subAccountId

  // The fake creates the wallet, then the answer is lost behind a 502.
  const made = {
    id: 'w' + nodeCrypto.randomBytes(8).toString('hex'),
    address: '0x' + nodeCrypto.randomBytes(20).toString('hex'),
    network: 'polygon',
    protectedSymmetricKey: 'psk-lost-answer-' + nodeCrypto.randomBytes(4).toString('hex')
  }
  h.fake.script({
    walletCreate (req, res, ctx) {
      h.fake.state.wallets.set(ctx.body.subAccountId, [made])
      ctx.json(res, 502, { success: false, error: 'Bad gateway' })
    }
  })
  const lost = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(lost.status, 503, lost.text)
  t.alike(lost.body, { error: 'resultado-incerto' }, 'unknown outcome, not a refusal')
  t.is(h.seen('POST', '/api/wallet/create').length, 1)
  const frozen = h.entry(dev.hex)
  t.is(frozen.walletUncertain, true, 'walletUncertain in the file')
  t.is(frozen.wallet, null)
  const st = await c.wallet('status')
  t.is(st.body.account.walletUncertain, true, 'status reports it')
  t.is(st.body.account.wallet, null)

  const adopted = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(adopted.status, 200, adopted.text)
  t.alike(adopted.body, { address: made.address }, 'the fake wallet is adopted')
  t.is(h.seen('POST', '/api/wallet/create').length, 1, 'no second POST /api/wallet/create')
  t.ok(h.seen('POST', '/api/wallet/get').length >= 1, 'read through wallet/get')
  const entry = h.entry(dev.hex)
  t.is(entry.walletUncertain, false)
  t.alike(entry.wallet && { id: entry.wallet.id, address: entry.wallet.address, psk: entry.wallet.protectedSymmetricKey },
    { id: made.id, address: made.address, psk: made.protectedSymmetricKey })
  t.is(entry.subAccountId, subAccountId)

  // Another member: the create is lost and nothing was made, so wallet/get
  // answers without an address and the member stays frozen.
  const other = await h.member('wilma')
  await approve(t, h, other.c, other.dev)
  h.fake.script({
    walletCreate (req, res, ctx) {
      ctx.json(res, 503, { success: false, error: 'Unavailable' })
    }
  })
  const createsBefore = h.seen('POST', '/api/wallet/create').length
  const gone = await other.c.wallet('wallet-create', {}, { pin: PIN })
  t.alike(gone.body, { error: 'resultado-incerto' })
  t.is(h.entry(other.dev.hex).walletUncertain, true)
  h.fake.script({})
  for (let i = 0; i < 2; i++) {
    const r = await other.c.wallet('wallet-create', {}, { pin: PIN })
    t.is(r.status, 503, r.text)
    t.alike(r.body, { error: 'carteira-incerta' }, 'frozen, never created again')
  }
  t.is(h.seen('POST', '/api/wallet/create').length, createsBefore + 1, 'one POST for that member, ever')
  t.is(h.fake.state.wallets.get(h.entry(other.dev.hex).subAccountId), undefined, 'no wallet exists at the fake')
  t.is(h.entry(other.dev.hex).wallet, null)
  t.is(h.entry(other.dev.hex).walletUncertain, true, 'still frozen')

  bearerOnlyInAuthorization(t, h)
  noSecrets(t, h, 'lost creates')
})

test('wallet e2e 3: a lost subaccount create is adopted by name, or frozen with no second create until it appears (C12)', async (t) => {
  t.timeout(60000)
  const h = await harness(t, { mode: 'cadastro' })
  await h.serve()
  const posts = (dev) => h.seen('POST', '/api/subaccount').filter((r) => r.body && r.body.name === subName(dev))

  // The fake creates the subaccount and the answer is lost.
  const a = await h.member('xavier')
  h.fake.script({
    createSubaccount (req, res, ctx) {
      h.fake.state.subaccounts.set(nodeCrypto.randomUUID(), { name: ctx.body.name })
      ctx.json(res, 500, { success: false, error: 'Internal' })
    }
  })
  const lostA = await a.c.wallet('optin', OPTIN_OP)
  t.is(lostA.status, 503, lostA.text)
  t.alike(lostA.body, { error: 'resultado-incerto' })
  const intent = h.entry(a.dev.hex)
  t.is(intent.subAccountId, null)
  t.is(intent.subaccountUncertain, true, 'the intent was on disk')
  h.fake.script({})
  const found = await a.c.wallet('status')
  t.is(found.status, 200, found.text)
  t.is(found.body.account.subaccountUncertain, false, 'adopted')
  t.is(found.body.account.kyc.state, 'documentos')
  const lookups = h.seen('GET', '/api/subaccount')
  t.ok(lookups.some((r) => r.query === '?name=' + subName(a.dev)), 'looked up by name')
  const adopted = h.entry(a.dev.hex)
  t.is(h.fake.state.subaccounts.get(adopted.subAccountId).name, subName(a.dev))
  t.is(adopted.subaccountUncertain, false)
  t.is(posts(a.dev).length, 1, 'one create for that member')

  // Nothing was created: zero matches leave the member frozen.
  const b = await h.member('yara')
  h.fake.script({
    createSubaccount (req, res, ctx) {
      ctx.json(res, 500, { success: false, error: 'Internal' })
    }
  })
  const lostB = await b.c.wallet('optin', OPTIN_OP)
  t.alike(lostB.body, { error: 'resultado-incerto' })
  h.fake.script({})
  const stB = await b.c.wallet('status')
  t.is(stB.status, 200, stB.text)
  t.is(stB.body.account.subaccountUncertain, true, 'still uncertain')
  const again = await b.c.wallet('optin', OPTIN_OP)
  t.is(again.status, 503, again.text)
  t.alike(again.body, { error: 'carteira-incerta' }, 'opt-in is not offered again')
  const doc = await b.c.wallet('kyc-document', { documentType: 'ID' })
  t.alike(doc.body, { error: 'carteira-incerta' }, 'nor anything else')
  t.is(posts(b.dev).length, 1, 'never created again')

  // It shows up later (Hodle caught up): the next read adopts it.
  const late = nodeCrypto.randomUUID()
  h.fake.state.subaccounts.set(late, { name: subName(b.dev) })
  const caught = await b.c.wallet('status')
  t.is(caught.body.account.subaccountUncertain, false, 'adopted once it exists')
  t.is(h.entry(b.dev.hex).subAccountId, late)
  t.is(posts(b.dev).length, 1)

  bearerOnlyInAuthorization(t, h)
  noSecrets(t, h, 'lost subaccounts')
})

test('wallet e2e 4: cadastro answers 404 for wallet-create and balance, even after approval (C11)', async (t) => {
  t.timeout(60000)
  const h = await harness(t, { mode: 'cadastro' })
  await h.serve()
  const { dev, c } = await h.member('zeca')
  const policy = await c.api('GET', '/account/wallet/policy')
  t.is(policy.body.mode, 'cadastro')
  await approve(t, h, c, dev)

  for (const action of ['balance', 'wallet-create']) {
    const st = await c.post('/account/wallet/start', { member: dev.hex, action })
    t.is(st.status, 404, action + ': start answers 404')
  }
  const direct = await c.post('/account/wallet/wallet-create', { member: dev.hex, nonce: 'A'.repeat(43), action: 'wallet-create', op: {}, signature: 'a'.repeat(128), pin: PIN })
  t.is(direct.status, 404, 'the route does not exist')
  const st = await c.wallet('status')
  t.is(st.body.account.kyc.state, 'aprovado')
  t.is(st.body.account.wallet, null, 'no wallet in cadastro')
  t.is(h.seen('POST', '/api/wallet/create').length, 0, 'Hodle never asked for a wallet')
  t.is(h.fake.state.walletCreates, 0)

  // The same dir reopened in carteira lets the approved member create it.
  await h.svc.stop()
  h.mode = 'carteira'
  await h.serve()
  const created = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(created.status, 200, created.text)
  t.is(h.seen('POST', '/api/wallet/create').length, 1)
  noSecrets(t, h, 'cadastro')
})

test('wallet e2e 5: pix with a payout fee: deposit settles, a signed webhook concludes the payout through Hodle\'s read, the next payout collects its fee', async (t) => {
  t.timeout(60000)
  const SECRET = nodeCrypto.randomBytes(32).toString('hex')
  const PIX_KEY = 'sentinela-pix@example.test'
  const BENEFICIARY_CPF = '39053344705'
  const fees = parseFees({ VARANDA_FEE_PAYOUT_CENTS: '50', VARANDA_FEE_PAYOUT_BPS: '100', VARANDA_FEE_TREASURY: 'sub:tesouro' })
  const h = await harness(t, { mode: 'pix', fees, webhookSecrets: new Map([['PAYOUT_SUCCESSFUL', SECRET], ['PAYOUT_FAILED', SECRET]]) })
  // The treasury is an operator subaccount at Hodle; the service never holds
  // its PIN or key.
  const treasuryWallet = { id: 'w-tesouro', address: '0x' + 'cd'.repeat(20), network: 'polygon', protectedSymmetricKey: 'psk-tesouro-sentinela' }
  h.fake.state.subaccounts.set('tesouro', { name: 'tesouro' })
  h.fake.state.wallets.set('tesouro', [treasuryWallet])
  await h.serve()
  const { dev, c } = await h.member('pixia')
  const policy = await c.api('GET', '/account/wallet/policy')
  t.is(policy.body.mode, 'pix')
  t.is(policy.body.fees.payout, 'R$ 0,50 + 1%')
  await approve(t, h, c, dev)
  const created = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(created.status, 200, created.text)
  const sub = h.entry(dev.hex).subAccountId

  // A deposit, paid at the fake, concluded by op-status.
  const depositOp = { opId: nodeCrypto.randomBytes(16).toString('base64url'), cents: 10000 }
  const dep = await c.wallet('deposit', depositOp)
  t.is(dep.status, 200, dep.text)
  t.ok(/^var-[0-9a-f]{32}$/.test(dep.body.externalId))
  t.is(dep.body.status, 'pendente')
  h.fake.settleDeposit(dep.body.externalId)
  const depSt = await c.wallet('op-status', { externalId: dep.body.externalId })
  t.is(depSt.status, 200, depSt.text)
  t.is(depSt.body.status, 'concluido', 'the deposit is concluded')
  t.is(depSt.body.kind, 'deposit')
  const funded = 10000 - h.fake.state.depositFeeCents
  t.is(h.fake.state.balances.get(sub), funded)
  const bal = await c.wallet('balance')
  t.is(bal.status, 200, bal.text)
  t.is(bal.body.cents, funded, 'the balance shows the credit')

  // 50 centavos + 1% of R$ 50,50 = 50,5 centavos, rounded half up to 51.
  const cents = 5050
  const quote = await c.wallet('payout-quote', { cents, pixKey: PIX_KEY, pixKeyType: 'EMAIL', beneficiaryCpf: BENEFICIARY_CPF })
  t.is(quote.status, 200, quote.text)
  const preview = await c.wallet('preview', { kind: 'payout', cents, quoteId: quote.body.quoteId })
  t.is(preview.status, 200, preview.text)
  t.is(preview.body.varandaFeeCents, 50 + 51, 'R$ 0,50 + 1% half up')
  t.is(preview.body.varandaFeeCents, feeCents(fees.rates.payout, cents))
  t.is(preview.body.hodleFeeCents, h.fake.state.payoutFeeCents)
  t.is(preview.body.totalDebitCents, cents + 101 + h.fake.state.payoutFeeCents)
  t.is(preview.body.ok, true)

  const payOp = {
    opId: nodeCrypto.randomBytes(16).toString('base64url'),
    cents,
    quoteId: quote.body.quoteId,
    pixKey: PIX_KEY,
    pixKeyType: 'EMAIL',
    beneficiaryCpf: BENEFICIARY_CPF,
    feeCents: preview.body.varandaFeeCents,
    pendingFeeCents: preview.body.pendingFeeCents,
    pendingFeeRef: preview.body.pendingFeeRef,
    totalDebitCents: preview.body.totalDebitCents
  }
  const paid = await c.wallet('payout', payOp, { pin: PIN })
  t.is(paid.status, 200, paid.text)
  const externalId = paid.body.externalId
  // Hodle answers the Pix as processing: the Varanda fee waits until Hodle
  // reports it concluded (S12).
  t.is(paid.body.status, 'pendente')
  t.alike(paid.body.fee, { asset: 'BRL', cents: 101, status: 'pendente' })
  t.is(h.fake.state.sends.payout, 1, 'one payout')
  t.is(h.fake.state.sends.transfer, 0, 'no fee transfer before the payout concludes')
  const payouts = h.seen('POST', '/api/wallet/payout')
  t.is(payouts.length, 1)
  t.is(payouts[0].body.externalId, externalId)
  const before = h.svc.ops.get(externalId)
  t.is(before.status, 'pendente')
  t.is(before.fee.status, 'pendente')
  t.is(before.fee.reference, externalId + ':taxa')

  // Hodle reports the payout, signed with the secret string.
  const transactionId = [...h.fake.state.payouts.keys()][0]
  async function deliver (event, data) {
    const raw = JSON.stringify({ event, data })
    const ts = String(Math.floor((Date.now() + h.offset) / 1000))
    const signature = nodeCrypto.createHmac('sha256', SECRET).update(ts + '.' + raw).digest('hex')
    const res = await fetch(h.svc.base + '/account/wallet/webhook/' + event, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hodle-timestamp': ts, 'x-hodle-signature': signature },
      body: raw
    })
    const text = await res.text()
    h.responses.push({ path: '/account/wallet/webhook/' + event, status: res.status, text, location: '', cookie: '' })
    return res.status
  }
  // A delivery never writes a final status: only Hodle's own read does.
  t.is(await deliver('PAYOUT_FAILED', { externalId, transactionId, status: 'FAILED' }), 200)
  t.is(h.svc.ops.get(externalId).status, 'pendente', 'a FAILED delivery while Hodle reports PENDING changes nothing')
  t.ok(h.seen('GET', '/api/wallet/payout/' + transactionId).length > 0, 'the webhook read the payout from Hodle')
  h.fake.state.payouts.get(transactionId).status = 'COMPLETED'
  t.is(await deliver('PAYOUT_SUCCESSFUL', { externalId, transactionId, status: 'COMPLETED' }), 200)
  t.is(h.svc.ops.get(externalId).status, 'concluido', 'the webhook flips the entry because Hodle reports COMPLETED')
  t.ok(h.logs.includes(JSON.stringify({ event: 'carteira', reason: 'webhook-aplicado' })))
  t.is(await deliver('PAYOUT_SUCCESSFUL', { externalId, transactionId, status: 'COMPLETED' }), 200)
  t.ok(h.logs.includes(JSON.stringify({ event: 'carteira', reason: 'webhook-repetido' })), 'a repeated delivery is deduped')
  const opSt = await c.wallet('op-status', { externalId })
  t.is(opSt.status, 200, opSt.text)
  t.is(opSt.body.status, 'concluido')
  t.is(opSt.body.kind, 'payout')
  t.alike(opSt.body.fee, { asset: 'BRL', cents: 101, status: 'pendente' }, 'a conclusion charges nothing on its own')
  t.is(h.fake.state.sends.transfer, 0)

  // The next payout the member signs collects it, after its own principal.
  const cents2 = 1000
  const quote2 = await c.wallet('payout-quote', { cents: cents2, pixKey: PIX_KEY, pixKeyType: 'EMAIL', beneficiaryCpf: BENEFICIARY_CPF })
  t.is(quote2.status, 200, quote2.text)
  const preview2 = await c.wallet('preview', { kind: 'payout', cents: cents2, quoteId: quote2.body.quoteId })
  t.is(preview2.status, 200, preview2.text)
  t.is(preview2.body.pendingFeeCents, 101)
  t.is(preview2.body.pendingFeeRef, externalId + ':taxa')
  const paid2 = await c.wallet('payout', {
    opId: nodeCrypto.randomBytes(16).toString('base64url'),
    cents: cents2,
    quoteId: quote2.body.quoteId,
    pixKey: PIX_KEY,
    pixKeyType: 'EMAIL',
    beneficiaryCpf: BENEFICIARY_CPF,
    feeCents: preview2.body.varandaFeeCents,
    pendingFeeCents: preview2.body.pendingFeeCents,
    pendingFeeRef: preview2.body.pendingFeeRef,
    totalDebitCents: preview2.body.totalDebitCents
  }, { pin: PIN })
  t.is(paid2.status, 200, paid2.text)
  t.alike(paid2.body.pendingFee, { asset: 'BRL', cents: 101, status: 'cobrada' })
  t.alike(paid2.body.fee, { asset: 'BRL', cents: preview2.body.varandaFeeCents, status: 'pendente' })

  // Two payouts and one fee transfer to the treasury, after the second.
  t.is(h.fake.state.sends.payout, 2, 'two payouts')
  t.is(h.fake.state.sends.transfer, 1, 'one transfer')
  const payouts2 = h.seen('POST', '/api/wallet/payout')
  const transfers = h.seen('POST', '/api/wallet/transfer')
  t.is(transfers.length, 1)
  t.is(transfers[0].body.toSubAccountId, 'tesouro')
  t.is(transfers[0].body.reference, externalId + ':taxa')
  t.is(transfers[0].body.fromSubAccountId, sub, 'the fee leaves the member wallet')
  t.ok(h.fake.seen.indexOf(payouts2[1]) < h.fake.seen.indexOf(transfers[0]), 'the fee leg runs after the principal')
  const record = h.fake.state.transfers.get(externalId + ':taxa')
  t.ok(record, 'the fake recorded the fee transfer by reference')
  t.is(record.to, 'tesouro')
  t.is(record.cents, 101)
  t.is(h.fake.state.balances.get('tesouro'), 101, 'the treasury received the fee')
  const hodleFee = h.fake.state.payoutFeeCents
  t.is(h.fake.state.balances.get(sub), funded - (cents + hodleFee) - (cents2 + hodleFee) - 101)
  // No treasury PIN is ever asked for: every PIN Hodle saw is the member's,
  // and nothing ever moved from or unlocked the treasury.
  for (const r of h.fake.seen) {
    const b = r.body && typeof r.body === 'object' ? r.body : {}
    if (b.walletPin !== undefined) t.is(b.walletPin, PIN, 'only the member PIN: ' + r.path)
    t.not(b.fromSubAccountId, 'tesouro', 'nothing moves from the treasury')
    t.not(b.subAccountId, 'tesouro', 'no call acts as the treasury')
    t.not(b.walletId, treasuryWallet.id, 'the treasury wallet is never unlocked')
  }
  t.is(h.svc.ops.get(externalId).fee.status, 'cobrada')

  // Nothing secret anywhere: files (wallet.json and wallet-ops.json), logs,
  // responses and session events.
  noSecrets(t, h, 'pix')
  const all = walk(h.root).concat(h.responses.map((r) => r.text), h.logs).join('\n')
  t.absent(all.includes(BENEFICIARY_CPF), 'no beneficiary CPF anywhere')
  t.absent(all.includes(PIX_KEY), 'no full Pix key anywhere')
  t.absent(all.includes(SECRET), 'no webhook secret anywhere')
  t.absent(all.includes(treasuryWallet.protectedSymmetricKey), 'no treasury key anywhere')
  t.is(h.svc.ops.get(externalId).to, '***test', 'the destination is kept masked')
  bearerOnlyInAuthorization(t, h)
  t.alike(dev.internal, [], 'no internal error in the session')
})

// --- completo: BRLA sends by @nome and to an address ------------------------

const SEND_FEES = Object.freeze({
  VARANDA_FEE_TRANSFER_CENTS: '10',
  VARANDA_FEE_TRANSFER_BPS: '100',
  VARANDA_FEE_CRYPTO_CENTS: '20',
  VARANDA_FEE_TREASURY: 'sub:tesouro'
})

function newOpId () {
  return nodeCrypto.randomBytes(16).toString('base64url')
}

// The treasury is an operator subaccount at Hodle, as in wallet e2e 5.
function treasuryAtFake (h) {
  h.fake.state.subaccounts.set('tesouro', { name: 'tesouro' })
  h.fake.state.wallets.set('tesouro', [{ id: 'w-tesouro', address: '0x' + 'cd'.repeat(20), network: 'polygon', protectedSymmetricKey: 'psk-tesouro-sentinela' }])
}

// A linked, approved member with a wallet at the fake.
async function walletMember (t, h, username) {
  const { dev, c } = await h.member(username)
  await approve(t, h, c, dev)
  const created = await c.wallet('wallet-create', {}, { pin: PIN })
  t.is(created.status, 200, 'wallet-create: ' + created.text)
  return { dev, c, sub: h.entry(dev.hex).subAccountId, address: created.body.address }
}

// The preview the member reviews, then the send signed with exactly its
// numbers (C10). `kind` is transfer (dest '@nome') or crypto (dest 0x...).
async function sendBrla (t, c, kind, cents, dest, opId = newOpId()) {
  const preview = await c.wallet('preview', { kind, cents })
  t.is(preview.status, 200, 'preview: ' + preview.text)
  const op = {
    opId,
    cents,
    feeCents: preview.body.varandaFeeCents,
    pendingFeeCents: preview.body.pendingFeeCents,
    pendingFeeRef: preview.body.pendingFeeRef,
    totalDebitCents: preview.body.totalDebitCents
  }
  if (kind === 'transfer') op.to = dest
  else op.address = dest
  const action = kind === 'transfer' ? 'transfer' : 'send-crypto'
  const r = await c.wallet(action, op, { pin: PIN })
  return { preview: preview.body, op, action, r }
}

test('wallet e2e 6: completo: a send to @nome and to an address, fees after the principal, refused destinations alike, pix cannot send', async (t) => {
  t.timeout(90000)
  const fees = parseFees(SEND_FEES)
  const h = await harness(t, { mode: 'completo', fees })
  treasuryAtFake(h)
  await h.serve()
  const a = await walletMember(t, h, 'anabela')
  const b = await walletMember(t, h, 'bento')
  const policy = await a.c.api('GET', '/account/wallet/policy')
  t.is(policy.body.mode, 'completo')
  t.ok(policy.body.actions.includes('transfer') && policy.body.actions.includes('send-crypto'), 'completo offers both sends')
  const funded = 100000
  h.fake.state.balances.set(a.sub, funded)
  const bal = (sub) => h.fake.state.balances.get(sub) || 0

  // A to @bento: the principal, then the fee to the treasury.
  const cents = 1000
  const fee = feeCents(fees.rates.transfer, cents)
  const one = await sendBrla(t, a.c, 'transfer', cents, '@bento')
  t.is(one.preview.varandaFeeCents, fee)
  t.is(one.preview.totalDebitCents, cents + fee)
  t.is(one.r.status, 200, 'transfer: ' + one.r.text)
  const id1 = one.r.body.externalId
  t.ok(/^var-[0-9a-f]{32}$/.test(id1))
  t.is(one.r.body.status, 'concluido')
  t.alike(one.r.body.fee, { asset: 'BRL', cents: fee, status: 'cobrada' }, 'the fee is collected once the principal concluded')
  t.ok(/^0x[0-9a-f]{64}$/.test(one.r.body.txHash), 'the public hash comes back')
  t.is(h.fake.state.sends.transfer, 2, 'principal and fee')
  const legs = h.seen('POST', '/api/wallet/transfer')
  t.is(legs.length, 2)
  t.is(legs[0].body.reference, id1)
  t.is(legs[0].body.toSubAccountId, b.sub, 'the principal goes to the member behind the name')
  t.is(legs[0].body.amount, '10.00')
  t.is(legs[1].body.reference, id1 + ':taxa')
  t.is(legs[1].body.toSubAccountId, 'tesouro')
  t.is(bal(a.sub), funded - cents - fee, 'the sender pays the principal plus the fee')
  t.is(bal(b.sub), cents, 'the recipient receives the principal only')
  t.is(bal('tesouro'), fee, 'the treasury receives the fee only')

  // B's statement shows the money coming in, with nothing of A's ledger.
  const st = await b.c.wallet('statement')
  t.is(st.status, 200, st.text)
  const incoming = st.body.items.filter((i) => i.kind === 'transfer')
  t.is(incoming.length, 1)
  t.is(incoming[0].direction, 'in')
  t.is(incoming[0].cents, cents)
  t.is(incoming[0].status, 'concluido')
  t.is(incoming[0].externalId, null, 'the sender\'s id is not the recipient\'s')
  t.is(incoming[0].fee, null, 'nothing charged on money coming in')
  t.absent(st.text.includes(id1))

  // A to an outside address: the principal leaves A and no subaccount.
  const outside = '0x' + nodeCrypto.randomBytes(20).toString('hex')
  const cents2 = 500
  const fee2 = feeCents(fees.rates.crypto, cents2)
  const before = { a: bal(a.sub), b: bal(b.sub), tesouro: bal('tesouro'), sends: h.fake.state.sends.transfer }
  const two = await sendBrla(t, a.c, 'crypto', cents2, outside)
  t.is(two.r.status, 200, 'send-crypto: ' + two.r.text)
  const id2 = two.r.body.externalId
  t.is(two.r.body.status, 'concluido')
  t.alike(two.r.body.fee, { asset: 'BRL', cents: fee2, status: 'cobrada' })
  t.ok(/^0x[0-9a-f]{64}$/.test(two.r.body.txHash))
  t.is(h.fake.state.sends.transfer, before.sends + 2)
  const legs2 = h.seen('POST', '/api/wallet/transfer').slice(2)
  t.is(legs2[0].body.reference, id2)
  t.is(legs2[0].body.recipientAddress, outside)
  t.is(legs2[0].body.toSubAccountId, undefined, 'no subaccount is the recipient')
  t.is(legs2[1].body.reference, id2 + ':taxa')
  t.is(bal(a.sub), before.a - cents2 - fee2, 'the sender pays the principal plus the fee')
  t.is(h.fake.state.credited.get(outside), cents2, 'the address receives the principal only')
  t.is(bal('tesouro'), before.tesouro + fee2, 'the treasury receives the fee only')
  t.is(bal(b.sub), before.b, 'no member subaccount credited')
  t.is(h.svc.ops.get(id2).to, '0x..' + outside.slice(-6), 'the destination is kept masked')

  // Every refused destination answers the same bytes, before Hodle is called.
  await h.member('celina')
  const posts = h.fake.state.posts.transfer
  const refused = []
  for (const name of ['@ninguemaqui', '@anabela', '@celina']) {
    const r = await sendBrla(t, a.c, 'transfer', 300, name)
    refused.push(r.r)
  }
  for (const address of [a.address.toLowerCase(), '0x' + '0'.repeat(40)]) {
    const r = await sendBrla(t, a.c, 'crypto', 300, address)
    refused.push(r.r)
  }
  for (const r of refused) {
    t.is(r.status, 400)
    t.is(r.text, refused[0].text, 'byte-identical: ' + r.text)
  }
  t.alike(refused[0].body, { error: 'destino-invalido' })
  t.is(h.fake.state.posts.transfer, posts, 'no provider call for a refused destination')

  t.absent(h.logs.some((l) => l.includes(PIN)), 'no log line holds the PIN')
  t.absent(walk(h.root).concat(h.logs).join('\n').includes(outside), 'no full outside address in a file or a log line')
  noSecrets(t, h, 'completo sends')
  bearerOnlyInAuthorization(t, h)

  // The same dir in pix: neither send exists, whatever the balance.
  await h.svc.stop()
  h.mode = 'pix'
  await h.serve()
  const pixPolicy = await a.c.api('GET', '/account/wallet/policy')
  t.is(pixPolicy.body.mode, 'pix')
  t.absent(pixPolicy.body.actions.includes('transfer') || pixPolicy.body.actions.includes('send-crypto'), 'pix offers no send')
  const postsBefore = h.fake.state.posts.transfer
  for (const action of ['transfer', 'send-crypto']) {
    const s = await a.c.post('/account/wallet/start', { member: a.dev.hex, action })
    t.is(s.status, 404, action + ': start answers 404 in pix')
    const direct = await a.c.post('/account/wallet/' + action, { member: a.dev.hex, nonce: 'A'.repeat(43), action, op: {}, signature: 'a'.repeat(128), pin: PIN })
    t.is(direct.status, 404, action + ': the route does not exist in pix')
  }
  t.is(h.fake.state.posts.transfer, postsBefore, 'no transfer reached Hodle in pix')
  t.alike(a.dev.internal, [], 'no internal error in the session')
})

test('wallet e2e 7: completo: a 202 send settles by op-status and its fee rides the next send; a lost answer blocks the next debit and is never sent twice', async (t) => {
  t.timeout(90000)
  const fees = parseFees(SEND_FEES)
  const h = await harness(t, { mode: 'completo', fees, moneyTimeoutMs: 1000 })
  treasuryAtFake(h)
  await h.serve()
  const a = await walletMember(t, h, 'aurora')
  const b = await walletMember(t, h, 'benicio')
  const funded = 100000
  h.fake.state.balances.set(a.sub, funded)
  const bal = (sub) => h.fake.state.balances.get(sub) || 0

  // Hodle accepts the send without completing it: no fee leg yet.
  h.fake.state.transferAnswer = 'pending202'
  const cents = 1000
  const fee = feeCents(fees.rates.transfer, cents)
  const one = await sendBrla(t, a.c, 'transfer', cents, '@benicio')
  t.is(one.r.status, 200, one.r.text)
  const id1 = one.r.body.externalId
  t.is(one.r.body.status, 'pendente')
  t.alike(one.r.body.fee, { asset: 'BRL', cents: fee, status: 'pendente' })
  t.is(one.r.body.txHash, null)
  t.is(h.fake.state.sends.transfer, 1, 'the principal only')
  t.is(bal(b.sub), 0, 'nothing credited while pending')
  t.ok(h.logs.includes(JSON.stringify({ event: 'carteira', reason: 'pendente-202' })))
  h.fake.state.transferAnswer = 'done'

  // The statement row completes; op-status reads it and charges nothing.
  h.fake.settleTransfer(id1, 'COMPLETED')
  const st = await a.c.wallet('op-status', { externalId: id1 })
  t.is(st.status, 200, st.text)
  t.is(st.body.kind, 'transfer')
  t.is(st.body.status, 'concluido', 'resolved from the COMPLETED statement row')
  t.ok(/^0x[0-9a-f]{64}$/.test(st.body.txHash))
  t.alike(st.body.fee, { asset: 'BRL', cents: fee, status: 'pendente' }, 'a conclusion charges nothing on its own')
  t.is(h.fake.state.sends.transfer, 1)
  t.is(bal('tesouro'), 0)
  t.is(bal(b.sub), cents)

  // The next send collects it, after its own principal and fee.
  const cents2 = 500
  const fee2 = feeCents(fees.rates.transfer, cents2)
  const two = await sendBrla(t, a.c, 'transfer', cents2, '@benicio')
  t.is(two.preview.pendingFeeCents, fee)
  t.is(two.preview.pendingFeeRef, id1 + ':taxa')
  t.is(two.preview.totalDebitCents, cents2 + fee2 + fee)
  t.is(two.r.status, 200, two.r.text)
  const id2 = two.r.body.externalId
  t.is(two.r.body.status, 'concluido')
  t.alike(two.r.body.fee, { asset: 'BRL', cents: fee2, status: 'cobrada' })
  t.alike(two.r.body.pendingFee, { asset: 'BRL', cents: fee, status: 'cobrada' })
  t.is(h.fake.state.sends.transfer, 4)
  const refs = h.seen('POST', '/api/wallet/transfer').map((r) => r.body.reference)
  t.alike(refs, [id1, id2, id2 + ':taxa', id1 + ':taxa'], 'principal first, then the fees')
  t.is(bal('tesouro'), fee + fee2, 'the treasury holds both fees, nothing more')
  t.is(bal(b.sub), cents + cents2)
  t.is(bal(a.sub), funded - cents - cents2 - fee - fee2)
  t.is(h.svc.ops.get(id1).fee.status, 'cobrada')

  // The answer never arrives: the money may have moved, so the row is incerto.
  h.fake.state.transferAnswer = 'timeout'
  const opId = newOpId()
  const lost = await sendBrla(t, a.c, 'transfer', 300, '@benicio', opId)
  t.is(lost.r.status, 503, lost.r.text)
  t.is(lost.r.body.error, 'resultado-incerto')
  const id3 = lost.r.body.externalId
  t.ok(/^var-[0-9a-f]{32}$/.test(id3))
  t.is(h.svc.ops.get(id3).status, 'incerto')
  const sends = h.fake.state.sends.transfer
  const posts = h.fake.state.posts.transfer
  t.is(sends, 5, 'the fake executed it once')

  // Another debit waits for it to resolve (C9), without calling Hodle.
  const next = await sendBrla(t, a.c, 'transfer', 200, '@benicio')
  t.is(next.r.status, 409, next.r.text)
  t.alike(next.r.body, { error: 'operacao-pendente' })
  const toAddress = await sendBrla(t, a.c, 'crypto', 200, '0x' + nodeCrypto.randomBytes(20).toString('hex'))
  t.alike(toAddress.r.body, { error: 'operacao-pendente' }, 'an address send waits too')

  // The same tap again returns the stored outcome, never a second send.
  const again = await a.c.wallet('transfer', lost.op, { pin: PIN })
  t.is(again.status, 200, again.text)
  t.is(again.body.externalId, id3)
  t.is(again.body.status, 'incerto')
  t.is(h.fake.state.sends.transfer, sends, 'the same opId does not send again')
  t.is(h.fake.state.posts.transfer, posts, 'nor reach Hodle at all')
  t.is(h.fake.state.transfers.get(id3).cents, 300)
  h.fake.state.transferAnswer = 'done'

  t.absent(h.logs.some((l) => l.includes(PIN)), 'no log line holds the PIN')
  noSecrets(t, h, 'completo lost answers')
  bearerOnlyInAuthorization(t, h)
  t.alike(a.dev.internal, [], 'no internal error in the session')
})

// --- completo: USDC and Converter -------------------------------------------

const USDC_FEES = Object.freeze({ ...SEND_FEES, VARANDA_FEE_CRYPTO_BPS: '100' })

function micros (text) {
  const [whole, frac = ''] = text.split('.')
  return Number(whole) * 1000000 + Number(frac.padEnd(6, '0'))
}

// The fake's USDC per subaccount, in micro-units.
function usdcAt (h, sub) {
  return h.fake.state.usdc.has(sub) ? micros(h.fake.state.usdc.get(sub)) : 0
}

// A conversion never names an address: Hodle delivers to the member's own
// wallet, so no swap call, quote or POST, carries one.
function swapsCarryNoAddress (t, h) {
  const calls = h.fake.seen.filter((r) => r.path.startsWith('/api/wallet/swap'))
  t.ok(calls.length > 0, 'the fake saw swap calls')
  let ok = true
  for (const r of calls) {
    if (/address/i.test(r.query)) ok = false
    if (r.body && typeof r.body === 'object' && Object.keys(r.body).some((k) => /address/i.test(k))) ok = false
    // Under any key or in the query, no EVM address value at all.
    if (/0x[0-9a-fA-F]{40}/.test(String(r.query || '') + JSON.stringify(r.body || {}))) ok = false
  }
  t.ok(ok, 'no swap call carries an address')
}

// The USDC preview the member reviews, then the send-crypto signed with
// exactly its micro-unit numbers (C10).
async function sendUsdc (t, c, amountMicros, address, opId = newOpId()) {
  const preview = await c.wallet('preview', { kind: 'crypto', asset: 'USDC', source: 'USDC', amountMicros })
  t.is(preview.status, 200, 'usdc preview: ' + preview.text)
  const op = {
    opId,
    amountMicros,
    feeMicros: preview.body.varandaFeeMicros,
    pendingFeeMicros: preview.body.pendingFeeMicros,
    pendingFeeRef: preview.body.pendingFeeRef,
    totalDebitMicros: preview.body.totalDebitMicros,
    asset: 'USDC',
    source: 'USDC',
    address
  }
  const r = await c.wallet('send-crypto', op, { pin: PIN })
  return { preview: preview.body, op, r }
}

test('wallet e2e 8: completo: USDC arrives, Converter runs to COMPLETED and credits BRLA, a timed out Converter blocks debits and is never POSTed again, refusals and failures', async (t) => {
  t.timeout(90000)
  const fees = parseFees(USDC_FEES)
  const h = await harness(t, { mode: 'completo', fees, moneyTimeoutMs: 1000 })
  treasuryAtFake(h)
  await h.serve()
  const a = await walletMember(t, h, 'ursula')
  const policy = await a.c.api('GET', '/account/wallet/policy')
  t.ok(policy.body.actions.includes('swap-quote') && policy.body.actions.includes('swap'), 'completo offers the Converter')

  // USDC arrives: the balance and the statement show it as USDC.
  h.fake.state.usdc.set(a.sub, '25.000000')
  const bal0 = await a.c.wallet('balance')
  t.is(bal0.status, 200, bal0.text)
  t.is(bal0.body.usdcMicros, 25000000, 'the balance shows the USDC')
  t.is(bal0.body.cents, 0, 'and no BRLA')
  const st0 = await a.c.wallet('statement')
  t.is(st0.status, 200, st0.text)
  const arrivals = st0.body.items.filter((i) => i.asset === 'USDC')
  t.is(arrivals.length, 1, 'one USDC row')
  t.is(arrivals[0].kind, 'deposit')
  t.is(arrivals[0].direction, 'in')
  t.is(arrivals[0].amountMicros, 25000000)
  t.is(arrivals[0].fee, null, 'nothing charged on money coming in')

  // The quote, in integers, with no fee of ours.
  const amount1 = 10000000
  const q = await a.c.wallet('swap-quote', { amountMicros: amount1 })
  t.is(q.status, 200, q.text)
  const hodleFee1 = Math.floor(amount1 * h.fake.state.swapFeeBps / 10000)
  const out1 = Math.floor((amount1 - hodleFee1) * h.fake.state.swapRateCents / 1000000)
  t.alike(q.body, { amountInMicros: amount1, hodleFeeMicros: hodleFee1, brlaOutCents: out1, rateCents: h.fake.state.swapRateCents, indicative: true })

  // Converter: RUNNING, then COMPLETED on a later read; USDC down, BRLA up.
  h.fake.state.swapOutcome = null
  const one = await a.c.wallet('swap', { opId: newOpId(), amountMicros: amount1 }, { pin: PIN })
  t.is(one.status, 200, one.text)
  const id1 = one.body.externalId
  t.ok(/^var-[0-9a-f]{32}$/.test(id1))
  t.is(one.body.status, 'pendente', 'RUNNING reads as pendente')
  t.ok(h.fake.state.swaps.has(one.body.providerId), 'the provider id is the fake swap')
  t.is(h.fake.state.sends.swap, 1)
  t.is(usdcAt(h, a.sub), 25000000 - amount1, 'the USDC left at funding')
  t.is(h.fake.state.balances.get(a.sub) || 0, 0, 'no BRLA while RUNNING')
  const running = await a.c.wallet('op-status', { externalId: id1 })
  t.is(running.status, 200, running.text)
  t.is(running.body.kind, 'swap')
  t.is(running.body.status, 'pendente', 'still RUNNING')
  t.is(running.body.fee, null, 'a conversion is never charged')
  h.fake.state.swapOutcome = 'COMPLETED'
  h.offset += 11000
  const done = await a.c.wallet('op-status', { externalId: id1 })
  t.is(done.body.status, 'concluido', 'COMPLETED reads as concluido')
  t.is(done.body.providerId, one.body.providerId)
  t.is(h.fake.state.swaps.get(one.body.providerId).status, 'COMPLETED')
  const bal1 = await a.c.wallet('balance')
  t.is(bal1.body.usdcMicros, 25000000 - amount1, 'USDC down by the amount')
  t.is(bal1.body.cents, out1, 'BRLA up by what the swap delivered')
  t.is(h.fake.state.sends.transfer, 0, 'no fee leg on a conversion')
  t.is(usdcAt(h, 'tesouro') + (h.fake.state.balances.get('tesouro') || 0), 0, 'the treasury got nothing')

  // A second Converter whose answer never arrives: the swap was funded.
  h.fake.state.swapAnswer = 'timeout'
  const lostOp = { opId: newOpId(), amountMicros: 5000000 }
  const lost = await a.c.wallet('swap', lostOp, { pin: PIN })
  t.is(lost.status, 503, lost.text)
  t.is(lost.body.error, 'resultado-incerto')
  const id2 = lost.body.externalId
  t.ok(/^var-[0-9a-f]{32}$/.test(id2))
  t.is(h.svc.ops.get(id2).status, 'incerto')
  t.is(h.svc.ops.get(id2).providerId, null, 'no provider id came back')
  t.is(h.fake.state.sends.swap, 2)
  const fundedSwap = [...h.fake.state.swaps.values()].find((w) => w.reference === id2)
  t.ok(fundedSwap, 'the fake funded it')
  t.is(usdcAt(h, a.sub), 25000000 - amount1 - 5000000)
  h.fake.state.swapAnswer = 'running'

  // Every further debit waits for it (C9), without calling Hodle.
  const swapPosts = h.seen('POST', '/api/wallet/swap').length
  const transferPosts = h.fake.state.posts.transfer
  const blocked = await a.c.wallet('swap', { opId: newOpId(), amountMicros: 1000000 }, { pin: PIN })
  t.is(blocked.status, 409, blocked.text)
  t.alike(blocked.body, { error: 'operacao-pendente' })
  await h.member('ulisses')
  const usdcSend = await sendUsdc(t, a.c, 1000000, '0x' + nodeCrypto.randomBytes(20).toString('hex'))
  t.alike(usdcSend.r.body, { error: 'operacao-pendente' }, 'a USDC send waits too')
  const brla = await sendBrla(t, a.c, 'transfer', 100, '@ulisses')
  t.alike(brla.r.body, { error: 'operacao-pendente' }, 'a BRLA send waits too')

  // The same tap again returns the stored outcome and never POSTs again.
  const again = await a.c.wallet('swap', lostOp, { pin: PIN })
  t.is(again.status, 200, again.text)
  t.alike(again.body, { externalId: id2, status: 'incerto', providerId: null })
  t.is(h.seen('POST', '/api/wallet/swap').length, swapPosts, 'the same opId does not POST again')
  t.is(h.fake.state.sends.swap, 2, 'the fake ran two swaps, ever')
  t.is(h.fake.state.posts.transfer, transferPosts, 'no transfer reached Hodle')

  // Nothing in the statement yet: op-status leaves it incerto.
  const unknown = await a.c.wallet('op-status', { externalId: id2 })
  t.is(unknown.status, 200, unknown.text)
  t.is(unknown.body.status, 'incerto', 'no statement row, no guess')
  t.is(h.seen('POST', '/api/wallet/swap').length, swapPosts, 'a status read never POSTs')

  // A statement row of the member's own swap with this reference settles it.
  h.fake.settleSwap(fundedSwap.swapId, 'COMPLETED')
  h.fake.state.swapRows.push({ subAccountId: a.sub, reference: id2, amount: '5.000000', status: 'COMPLETED' })
  h.offset += 11000
  const settled = await a.c.wallet('op-status', { externalId: id2 })
  t.is(settled.body.status, 'concluido', 'settled by the planted statement row')
  t.is(h.seen('POST', '/api/wallet/swap').length, swapPosts)
  const bal2 = await a.c.wallet('balance')
  t.is(bal2.body.usdcMicros, 25000000 - amount1 - 5000000)
  t.is(bal2.body.cents, out1 + fundedSwap.outCents, 'BRLA up by both conversions')

  // Refused by Hodle before it registered anything: falhou, no support owed.
  h.fake.state.swapAnswer = 'notEnabled'
  const noQuote = await a.c.wallet('swap-quote', { amountMicros: 1000000 })
  t.alike(noQuote.body, { error: 'indisponivel' }, 'the quote is refused too')
  const refused = await a.c.wallet('swap', { opId: newOpId(), amountMicros: 1000000 }, { pin: PIN })
  t.is(refused.body.error, 'indisponivel', refused.text)
  const id3 = refused.body.externalId
  t.is(h.svc.ops.get(id3).status, 'falhou')
  t.is(h.svc.ops.get(id3).suporte, false, 'nothing for support: no swap exists')
  t.is(usdcAt(h, a.sub), 25000000 - amount1 - 5000000, 'nothing moved')

  // Registered and funded, then failed at Hodle: falhou and owed to support.
  h.fake.state.swapAnswer = 'fail502-with-id'
  h.fake.state.swapOutcome = 'FAILED'
  const broken = await a.c.wallet('swap', { opId: newOpId(), amountMicros: 2000000 }, { pin: PIN })
  t.is(broken.status, 503, broken.text)
  t.is(broken.body.error, 'resultado-incerto')
  const id4 = broken.body.externalId
  const row4 = h.svc.ops.get(id4)
  t.is(row4.status, 'incerto')
  t.ok(h.fake.state.swaps.has(row4.providerId), 'the 502 named the funded swap')
  t.is(usdcAt(h, a.sub), 25000000 - amount1 - 5000000 - 2000000, 'funded before the 502')
  const failed = await a.c.wallet('op-status', { externalId: id4 })
  t.is(failed.body.status, 'falhou', 'Hodle reports it FAILED')
  t.is(h.svc.ops.get(id4).suporte, true, 'a failed registered swap is owed to support')
  t.is(usdcAt(h, a.sub), 25000000 - amount1 - 5000000, 'the fake refunded the USDC')
  h.fake.state.swapAnswer = 'running'
  h.fake.state.swapOutcome = 'COMPLETED'

  swapsCarryNoAddress(t, h)
  t.absent(h.logs.some((l) => l.includes(PIN)), 'no log line holds the PIN')
  noSecrets(t, h, 'converter')
  bearerOnlyInAuthorization(t, h)
  t.alike(a.dev.internal, [], 'no internal error in the session')
})

test('wallet e2e 9: completo: a USDC send collects its USDC fee only after concluido, a BRLA send leaves the USDC reserve alone, the next USDC send collects it', async (t) => {
  t.timeout(90000)
  const fees = parseFees(USDC_FEES)
  const h = await harness(t, { mode: 'completo', fees, moneyTimeoutMs: 1000 })
  treasuryAtFake(h)
  await h.serve()
  const a = await walletMember(t, h, 'valquiria')
  const b = await walletMember(t, h, 'vicente')
  const usdcStart = 50000000
  const brlaStart = 100000
  h.fake.state.usdc.set(a.sub, '50.000000')
  h.fake.state.balances.set(a.sub, brlaStart)
  const bal = (sub) => h.fake.state.balances.get(sub) || 0
  // The crypto bps on micro-units, rounded half up.
  const usdcFee = (m) => Math.floor((m * 100 + 5000) / 10000)

  // Hodle accepts the USDC send without completing it: no fee leg yet.
  h.fake.state.transferAnswer = 'pending202'
  const out1 = '0x' + nodeCrypto.randomBytes(20).toString('hex')
  const amount1 = 10000000
  const fee1 = usdcFee(amount1)
  const one = await sendUsdc(t, a.c, amount1, out1)
  t.is(one.preview.varandaFeeMicros, fee1)
  t.is(one.preview.totalDebitMicros, amount1 + fee1)
  t.is(one.r.status, 200, one.r.text)
  const id1 = one.r.body.externalId
  t.is(one.r.body.status, 'pendente')
  t.alike(one.r.body.fee, { asset: 'USDC', cents: null, feeMicros: fee1, status: 'pendente' })
  t.is(h.fake.state.sends.transfer, 1, 'the principal only')
  t.is(usdcAt(h, a.sub), usdcStart - amount1, 'the principal left the sender')
  t.is(h.fake.state.creditedUsdc.get(out1), undefined, 'nothing credited while pending')
  t.is(usdcAt(h, 'tesouro'), 0)
  h.fake.state.transferAnswer = 'done'

  // Concluded at Hodle: op-status reads it and charges nothing on its own.
  h.fake.settleTransfer(id1, 'COMPLETED')
  const st1 = await a.c.wallet('op-status', { externalId: id1 })
  t.is(st1.status, 200, st1.text)
  t.is(st1.body.status, 'concluido')
  t.is(st1.body.asset, 'USDC')
  t.is(st1.body.amountMicros, amount1)
  t.alike(st1.body.fee, { asset: 'USDC', cents: null, feeMicros: fee1, status: 'pendente' })
  t.is(h.fake.state.sends.transfer, 1)
  t.is(h.fake.state.creditedUsdc.get(out1), amount1, 'the address received the principal only')
  t.is(usdcAt(h, 'tesouro'), 0)

  // A BRLA send: its own BRL fee only; the USDC fee and reserve stay put.
  const balOwed = await a.c.wallet('balance')
  t.is(balOwed.body.pendingUsdcMicros, fee1, 'the USDC fee is owed')
  t.is(balOwed.body.pendingFeeCents, 0, 'no BRL fee is owed')
  const cents = 1000
  const brlaFee = feeCents(fees.rates.transfer, cents)
  const two = await sendBrla(t, a.c, 'transfer', cents, '@vicente')
  t.is(two.preview.pendingFeeCents, 0, 'a BRLA send never collects a USDC fee')
  t.is(two.preview.totalDebitCents, cents + brlaFee)
  t.is(two.r.status, 200, two.r.text)
  const id2 = two.r.body.externalId
  t.is(two.r.body.status, 'concluido')
  t.alike(two.r.body.fee, { asset: 'BRL', cents: brlaFee, status: 'cobrada' })
  t.is(two.r.body.pendingFee, null)
  t.is(usdcAt(h, a.sub), usdcStart - amount1, 'the USDC reserve is untouched')
  t.is(bal(a.sub), brlaStart - cents - brlaFee)
  t.is(bal(b.sub), cents)
  t.is(bal('tesouro'), brlaFee, 'the treasury BRLA holds the BRL fee only')
  t.is(usdcAt(h, 'tesouro'), 0, 'and no USDC')
  t.is(h.svc.ops.get(id1).fee.status, 'pendente', 'the USDC fee is still owed')

  // The next USDC send collects both USDC fees, after its own principal.
  const out2 = '0x' + nodeCrypto.randomBytes(20).toString('hex')
  const amount2 = 5000000
  const fee2 = usdcFee(amount2)
  const three = await sendUsdc(t, a.c, amount2, out2)
  t.is(three.preview.pendingFeeMicros, fee1)
  t.is(three.preview.pendingFeeRef, id1 + ':taxa')
  t.is(three.preview.totalDebitMicros, amount2 + fee2 + fee1)
  t.is(three.r.status, 200, three.r.text)
  const id3 = three.r.body.externalId
  t.is(three.r.body.status, 'concluido')
  t.alike(three.r.body.fee, { asset: 'USDC', cents: null, feeMicros: fee2, status: 'cobrada' })
  t.alike(three.r.body.pendingFee, { asset: 'USDC', cents: null, feeMicros: fee1, status: 'cobrada' })
  t.is(h.svc.ops.get(id1).fee.status, 'cobrada')

  const legs = h.seen('POST', '/api/wallet/transfer')
  t.alike(legs.map((r) => r.body.reference), [id1, id2, id2 + ':taxa', id3, id3 + ':taxa', id1 + ':taxa'], 'every fee after its principal')
  t.alike(legs.map((r) => r.body.asset), ['USDC', 'BRLA', 'BRLA', 'USDC', 'USDC', 'USDC'], 'each leg in the asset its principal debits')
  t.is(legs[5].body.toSubAccountId, 'tesouro')
  t.is(legs[5].body.amount, '0.' + String(fee1).padStart(6, '0'))

  // Balances: the sender pays principal plus fees, the addresses receive the
  // principal only, the treasury the fees only.
  t.is(usdcAt(h, a.sub), usdcStart - amount1 - fee1 - amount2 - fee2, 'sender USDC down by principals plus fees')
  t.is(h.fake.state.creditedUsdc.get(out1), amount1)
  t.is(h.fake.state.creditedUsdc.get(out2), amount2)
  t.is(usdcAt(h, 'tesouro'), fee1 + fee2, 'the treasury USDC holds both fees, nothing more')
  t.is(bal('tesouro'), brlaFee, 'the treasury BRLA unchanged by USDC sends')
  t.is(bal(a.sub), brlaStart - cents - brlaFee, 'the BRLA balance unchanged by USDC sends')

  t.absent(h.logs.some((l) => l.includes(PIN)), 'no log line holds the PIN')
  const stored = walk(h.root).concat(h.logs).join('\n').toLowerCase()
  for (const out of [out1, out2]) t.absent(stored.includes(out.toLowerCase()), 'no full outside address in a file or a log line')
  noSecrets(t, h, 'usdc sends')
  bearerOnlyInAuthorization(t, h)
  t.alike(a.dev.internal, [], 'no internal error in the session')
})
