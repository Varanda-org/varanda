'use strict'

// apps/cli/scripts/hosted-lab.js and apps/cli/scripts/oauth-stub.js: the
// lab's one origin maps each route to the right backend (fake seeder, fake
// account service and fake UI, all on 127.0.0.1), the stub hands each lab
// person a distinct sub behind PKCE, and the lab refuses anything off
// loopback before it touches the network.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { WebSocketServer, WebSocket } = require('ws')
const { startLabProxy, routeOf, bootstrapFromEnv, labOrigin, allowedHost, parseArgs, LabUsageError } = require('../scripts/hosted-lab')
const { createOAuthStub, challengeOf } = require('../scripts/oauth-stub')
const { tmpDir } = require('./helpers/net')

const LAB = path.join(__dirname, '..', 'scripts', 'hosted-lab.js')
const STUB = path.join(__dirname, '..', 'scripts', 'oauth-stub.js')
const ASSOC = 'ab'.repeat(32)

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

// A loopback server answering { name, url, host } for every request.
async function fakeBackend (t, name, { ws = false, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name, url: req.url, host: req.headers.host, origin: req.headers.origin || null }))
  })
  if (ws) {
    const wss = new WebSocketServer({ server })
    wss.on('connection', (sock, req) => sock.send(JSON.stringify({ name, url: req.url, host: req.headers.host })))
  }
  await new Promise((resolve) => server.listen(0, host, resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  return server.address().port
}

test('the lab origin maps the five routes and the UI fallback', async (t) => {
  const seederPort = await fakeBackend(t, 'seeder', { ws: true })
  const accountPort = await fakeBackend(t, 'account')
  const uiPort = await fakeBackend(t, 'ui')
  const lab = await startLabProxy({ host: '127.0.0.1', port: 0, association: ASSOC, seederPort, accountPort, ui: { url: 'http://127.0.0.1:' + uiPort } })
  t.teardown(() => lab.close(), { force: true })
  const base = 'http://127.0.0.1:' + lab.port
  const origin = 'http://localhost:' + lab.port
  t.is(lab.origin, origin)

  const config = await fetch(base + '/varanda.json')
  t.is(config.status, 200)
  t.alike(await config.json(), { v: 1, association: ASSOC }, '/varanda.json carries only v and the association')

  const cases = [
    ['/media/' + 'cd'.repeat(32) + '/' + 'ef'.repeat(32) + '/1/1', 'seeder', seederPort],
    ['/index/counts/x', 'seeder', seederPort],
    ['/account/age/policy', 'account', accountPort],
    ['/account/start', 'account', accountPort],
    ['/', 'ui', uiPort],
    ['/@nome', 'ui', uiPort],
    ['/accounts', 'ui', uiPort]
  ]
  for (const [p, name, port] of cases) {
    const res = await fetch(base + p, { headers: { origin } })
    const body = await res.json()
    t.is(body.name, name, p + ' goes to the ' + name)
    t.is(body.url, p, p + ' keeps its path')
    t.is(body.host, '127.0.0.1:' + port, p + ' carries the backend authority as Host')
    t.is(body.origin, origin, p + ' keeps the page origin')
  }

  const sock = new WebSocket('ws://127.0.0.1:' + lab.port + '/seeder', { headers: { origin } })
  const first = await new Promise((resolve, reject) => {
    sock.once('message', (data) => resolve(JSON.parse(data.toString())))
    sock.once('error', reject)
  })
  sock.close()
  t.is(first.name, 'seeder', 'the /seeder WebSocket reaches the seeder listener')
  t.is(first.host, '127.0.0.1:' + seederPort)
})

test('the lab keeps the --expo hostname for HTTP and WebSocket forwarding', async (t) => {
  // Bound where 'localhost' resolves first, which is where the lab connects.
  const uiPort = await fakeBackend(t, 'ui', { ws: true, host: 'localhost' })
  const lab = await startLabProxy({ port: 0, association: ASSOC, seederPort: 1, accountPort: 1, ui: { url: 'http://localhost:' + uiPort } })
  t.teardown(() => lab.close(), { force: true })
  const body = await (await fetch('http://127.0.0.1:' + lab.port + '/@nome')).json()
  t.is(body.name, 'ui')
  t.is(body.host, 'localhost:' + uiPort, 'HTTP carries the configured hostname as Host')

  const sock = new WebSocket('ws://127.0.0.1:' + lab.port + '/_expo/ws')
  const first = await new Promise((resolve, reject) => {
    sock.once('message', (data) => resolve(JSON.parse(data.toString())))
    sock.once('error', reject)
  })
  sock.close()
  t.is(first.name, 'ui', 'the dev server WebSocket reaches the UI')
  t.is(first.host, 'localhost:' + uiPort, 'the WebSocket carries the configured hostname as Host')

  t.exception.all(() => startLabProxy({ port: 0, association: ASSOC, seederPort: 1, accountPort: 1, ui: { url: 'http://example.com:8081' } }), /loopback/)
})

test('the lab serves an exported dist with the index for app routes', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>')
  fs.writeFileSync(path.join(dir, 'app.js'), 'ok()')
  const lab = await startLabProxy({ port: 0, association: ASSOC, seederPort: 1, accountPort: 1, ui: { dir } })
  t.teardown(() => lab.close(), { force: true })
  const base = 'http://127.0.0.1:' + lab.port
  t.is(await (await fetch(base + '/app.js')).text(), 'ok()')
  t.ok((await (await fetch(base + '/g/abc')).text()).includes('<title>app</title>'), 'a client route is index.html')
  t.ok((await (await fetch(base + '/%2e%2e/%2e%2e/etc/passwd')).text()).includes('<title>app</title>'), 'no escape from the dist')
})

// A raw request with any Host header (fetch() will not send a forged one).
function rawRequest (port, lines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(lines.join('\r\n') + '\r\n\r\n'))
    let data = ''
    sock.on('data', (d) => { data += d.toString() })
    sock.on('end', () => resolve(data))
    sock.on('close', () => resolve(data))
    sock.on('error', reject)
  })
}

test('the lab answers 421 to a foreign Host and never proxies it', async (t) => {
  let reached = 0
  const server = http.createServer((req, res) => {
    reached++
    res.end('backend')
  })
  server.on('upgrade', (req, socket) => {
    reached++
    socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  const backend = server.address().port
  const lab = await startLabProxy({ port: 0, association: ASSOC, seederPort: backend, accountPort: backend, ui: { url: 'http://127.0.0.1:' + backend } })
  t.teardown(() => lab.close(), { force: true })

  for (const p of ['/account/start', '/media/x', '/']) {
    const res = await rawRequest(lab.port, ['GET ' + p + ' HTTP/1.1', 'Host: evil.example:' + lab.port, 'Connection: close'])
    t.ok(res.startsWith('HTTP/1.1 421'), p + ' with a foreign Host is 421')
    t.ok(res.includes('host inválido'), 'says why')
  }
  const up = await rawRequest(lab.port, ['GET /seeder HTTP/1.1', 'Host: evil.example:8080', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + Buffer.alloc(16).toString('base64')])
  t.ok(up.startsWith('HTTP/1.1 421'), 'a WebSocket upgrade with a foreign Host is 421')
  t.is(reached, 0, 'nothing reached the backend')

  const ok = await rawRequest(lab.port, ['GET /account/start HTTP/1.1', 'Host: localhost:' + lab.port, 'Connection: close'])
  t.ok(ok.startsWith('HTTP/1.1 200'), 'localhost:<port> is proxied')
  t.is(reached, 1)
})

test('allowedHost and labOrigin', (t) => {
  t.ok(allowedHost('localhost:8080', 8080))
  t.ok(allowedHost('127.0.0.1:8080', 8080))
  t.ok(allowedHost('LOCALHOST:8080', 8080))
  t.absent(allowedHost('localhost', 8080), 'the bare host only on port 80')
  t.absent(allowedHost('localhost:8081', 8080))
  t.absent(allowedHost('evil.example:8080', 8080))
  t.absent(allowedHost('localhost.evil.example:8080', 8080))
  t.absent(allowedHost(undefined, 8080))
  t.ok(allowedHost('localhost', 80))
  t.ok(allowedHost('127.0.0.1', 80))
  t.ok(allowedHost('localhost:80', 80))
  t.absent(allowedHost('evil.example', 80))
  t.is(labOrigin(8080), 'http://localhost:8080')
  t.is(labOrigin(80), 'http://localhost', 'port 80 matches the Origin the browser sends')
})

test('close() resolves with a proxied WebSocket still open', async (t) => {
  const seederPort = await fakeBackend(t, 'seeder', { ws: true })
  const lab = await startLabProxy({ port: 0, association: ASSOC, seederPort, accountPort: 1, ui: { url: 'http://127.0.0.1:1' } })
  const sock = new WebSocket('ws://127.0.0.1:' + lab.port + '/seeder')
  sock.on('error', () => {})
  await new Promise((resolve, reject) => {
    sock.once('message', resolve)
    sock.once('error', reject)
  })
  const closed = new Promise((resolve) => sock.once('close', resolve))
  let timer
  const result = await Promise.race([
    lab.close().then(() => 'closed'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), 5000) })
  ])
  clearTimeout(timer)
  t.is(result, 'closed', 'close() does not wait for the WebSocket')
  await closed
  t.pass('the client socket was closed')
})

test('routeOf', (t) => {
  t.is(routeOf('/varanda.json'), 'config')
  t.is(routeOf('/seeder'), 'seeder')
  t.is(routeOf('/seederx'), 'ui')
  t.is(routeOf('/media/a'), 'seeder')
  t.is(routeOf('/index/a'), 'seeder')
  t.is(routeOf('/account/x'), 'account')
  t.is(routeOf('/x'), 'ui')
})

test('the stub hands each lab person a distinct sub behind PKCE', async (t) => {
  const redirectUri = 'http://localhost:8080/account/callback'
  const stub = createOAuthStub({ redirectUri })
  const listener = await stub.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })

  const verifier = nodeCrypto.randomBytes(32).toString('base64url')
  const state = nodeCrypto.randomBytes(32).toString('base64url')
  const url = new URL(stub.authorizeUrl({ state, codeChallenge: challengeOf(verifier) }))
  t.is(url.origin, listener.url, 'the authorize page is on the stub listener')
  const page = await (await fetch(url)).text()
  for (const n of [1, 2, 3]) t.ok(page.includes('Pessoa ' + n), 'offers Pessoa ' + n)

  async function choose (person, challenge = challengeOf(verifier)) {
    const q = new URLSearchParams({ state, code_challenge: challenge, person: String(person) })
    const res = await fetch(listener.url + '/choose?' + q, { redirect: 'manual' })
    t.is(res.status, 302)
    const to = new URL(res.headers.get('location'))
    t.is(to.origin + to.pathname, redirectUri, 'back to the account callback')
    t.is(to.searchParams.get('state'), state)
    return to.searchParams.get('code')
  }

  const code2 = await choose(2)
  t.alike(await stub.exchange({ code: code2, codeVerifier: verifier }), { ok: true, sub: 'lab-2', email: 'lab2@example.test' })
  t.is((await stub.exchange({ code: code2, codeVerifier: verifier })).ok, false, 'a code is used once')

  const code3 = await choose(3)
  t.is((await stub.exchange({ code: code3, codeVerifier: 'outro-verificador' })).ok, false, 'a wrong verifier is refused')
  t.is((await stub.exchange({ code: 'inventado', codeVerifier: verifier })).ok, false, 'an unknown code is refused')

  const code1 = await choose(1)
  t.is((await stub.exchange({ code: code1, codeVerifier: verifier })).sub, 'lab-1')

  const bad = await fetch(listener.url + '/choose?' + new URLSearchParams({ state, code_challenge: challengeOf(verifier), person: '4' }))
  t.is(bad.status, 404, 'no fourth person')
  let refused = null
  try {
    stub.listen({ host: '0.0.0.0' })
  } catch (err) {
    refused = err
  }
  t.ok(refused && /127\.0\.0\.1/.test(refused.message), 'the stub binds loopback only')
})

test('the stub answers 400 to a request target that cannot parse and keeps serving', async (t) => {
  const stub = createOAuthStub({ redirectUri: 'http://localhost:8080/account/callback' })
  const listener = await stub.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const { port } = new URL(listener.url)
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end('GET //[/ HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n'))
    let data = ''
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
  t.ok(raw.startsWith('HTTP/1.1 400'), 'a malformed target gets 400')
  const after = await fetch(listener.url + '/authorize?state=abc&code_challenge=def')
  t.is(after.status, 200, 'the stub still serves after it')
})

test('the lab refuses anything off loopback before it starts', (t) => {
  for (const host of ['0.0.0.0', '192.168.1.2', '::']) {
    const r = spawnSync(process.execPath, [LAB, '--host', host], { env: cleanEnv, encoding: 'utf8', timeout: 30000 })
    t.is(r.status, 2, '--host ' + host + ' exits 2')
    t.ok(/127\.0\.0\.1 ou localhost/.test(r.stderr), 'says why')
  }
  const r = spawnSync(process.execPath, [LAB], { env: { ...cleanEnv, VARANDA_BOOTSTRAP: '10.0.0.1:49737' }, encoding: 'utf8', timeout: 30000 })
  t.is(r.status, 2, 'a VARANDA_BOOTSTRAP off loopback exits 2')
  const expo = spawnSync(process.execPath, [LAB, '--expo', 'http://192.168.1.2:8081'], { env: cleanEnv, encoding: 'utf8', timeout: 30000 })
  t.is(expo.status, 2, 'an --expo off loopback exits 2')

  t.is(bootstrapFromEnv(undefined), null)
  t.alike(bootstrapFromEnv('127.0.0.1:49737'), ['127.0.0.1:49737'])
  t.exception(() => bootstrapFromEnv('localhost:1,8.8.8.8:1'))
})

test('the lab has no public bootstrap and no flag that skips a check', (t) => {
  for (const file of [LAB, STUB]) {
    const src = fs.readFileSync(file, 'utf8')
    const name = path.basename(file)
    t.absent(/hyperdht\.org|holepunch\.to|88\.99\.3\.86/i.test(src), name + ': no public bootstrap address')
    t.absent(/--(skip|no)-?(passkey|age|idade|terms|termos)/i.test(src), name + ': no skip flag')
    t.absent(/skip(Passkey|Age|Terms)|no(Passkey|Terms)\b/.test(src), name + ': no skip option')
    t.absent(/—/.test(src), name + ': no em dash')
  }
})

test('the dataset flags: a seed, a bounded size, rajada only with a dataset', (t) => {
  const plain = parseArgs([])
  t.is(plain.dataset, null, 'no dataset by default')
  t.is(plain.rajada, false)
  const d = parseArgs(['--dataset', 'seed_1', '--dataset-size', '6x20', '--rajada'])
  t.is(d.dataset, 'seed_1')
  t.alike(d.datasetSize, { members: 6, blocksPerMember: 20 })
  t.is(d.rajada, true)
  t.exception(() => parseArgs(['--dataset', 'a b']), LabUsageError, 'a seed with a space')
  t.exception(() => parseArgs(['--dataset', '1', '--dataset-size', '6x3']), LabUsageError, 'fewer blocks than the header')
  t.exception(() => parseArgs(['--dataset', '1', '--dataset-size', '1001x20']), LabUsageError, 'more members than the bound')
  t.exception(() => parseArgs(['--rajada']), LabUsageError, 'rajada without a dataset')
  t.exception(() => parseArgs(['--dataset-size', '6x20']), LabUsageError, 'a size without a dataset')
  t.is(parseArgs(['--help']).help, true)
})
