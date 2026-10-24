'use strict'

// varanda-serve end to end: the real bin, spawned with --port 0, on a member
// data dir with a loopback testnet bootstrap.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const WebSocket = require('ws')
const { testnet, tmpDir, bootstrapFlags, until } = require('./helpers/net')
const { initAssociation } = require('@varanda/core/lib/assoc')
const { MAX_REQUEST } = require('@varanda/rpc')

const SERVE = path.join(__dirname, '..', 'bin', 'varanda-serve.js')
const CLI = path.join(__dirname, '..', 'bin', 'varanda.js')
const HEX64 = /^[0-9a-f]{64}$/

const baseEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) baseEnv[k] = v

// Everything the server ever said, checked for the token at the end of each test.
function noLeak (t, server) {
  t.absent(server.stderr.includes(server.token), 'token never in stderr')
  t.absent(server.seen.some((body) => String(body).includes(server.token)), 'token never in a response')
}

async function member (t) {
  const { bootstrap } = await testnet(t)
  const assocDir = tmpDir(t)
  const { publicKey } = initAssociation(assocDir)
  const dataDir = tmpDir(t)
  return { bootstrap, association: publicKey, dataDir, assocDir }
}

function memberArgs (m) {
  return ['--data', m.dataDir, '--association', m.association, ...bootstrapFlags(m.bootstrap)]
}

// Spawns the bin and resolves once it printed its address and token.
async function serve (t, args, env = {}) {
  const child = spawn(process.execPath, [SERVE, '--port', '0', ...args], { env: { ...baseEnv, ...env } })
  const server = { child, stdout: '', stderr: '', port: null, token: null, seen: [], exit: null }
  server.exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.stdout.on('data', (d) => { server.stdout += d })
  child.stderr.on('data', (d) => { server.stderr += d })
  t.teardown(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await server.exit
  }, { order: 0, force: true })
  await until(() => {
    if (child.exitCode !== null) throw new Error('varanda-serve saiu: ' + server.stderr)
    const m = /^varanda-serve em http:\/\/127\.0\.0\.1:(\d+)\n(?:token: |abra http:\/\/127\.0\.0\.1:\d+\/#token=)(\S+)\n/.exec(server.stdout)
    if (!m) return false
    server.port = Number(m[1])
    server.token = m[2]
    return true
  }, { name: 'varanda-serve escutando' })
  return server
}

function refuse (args, env = {}) {
  const r = spawnSync(process.execPath, [SERVE, '--port', '0', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 30000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function request (server, { method = 'GET', path: p = '/', host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: host || '127.0.0.1:' + server.port }
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: p, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        server.seen.push(body, JSON.stringify(res.headers))
        resolve({ status: res.statusCode, headers: res.headers, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// A raw upgrade request -> the HTTP status (101 when accepted).
function rawUpgrade (server, { host, origin, path: p = '/rpc' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      host: host || '127.0.0.1:' + server.port,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': crypto.randomBytes(16).toString('base64')
    }
    if (origin !== undefined) headers.origin = origin
    const req = http.request({ host: '127.0.0.1', port: server.port, path: p, headers, agent: false })
    req.on('response', (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

// A ws client that records every message and resolves responses by id.
function connect (server, origin) {
  const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/rpc', { origin })
  const client = { ws, messages: [], waiting: new Map(), nextId: 1, closed: null }
  client.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  ws.on('error', () => {})
  ws.on('message', (data) => {
    const text = data.toString()
    server.seen.push(text)
    const msg = JSON.parse(text)
    client.messages.push(msg)
    if (msg.id !== undefined && client.waiting.has(msg.id)) {
      client.waiting.get(msg.id)(msg)
      client.waiting.delete(msg.id)
    }
  })
  client.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (req, res) => reject(new Error('status ' + res.statusCode)))
    ws.once('error', reject)
  })
  client.call = (method, params = {}) => {
    const id = client.nextId++
    const p = new Promise((resolve) => client.waiting.set(id, resolve))
    ws.send(JSON.stringify({ v: 1, id, method, params }))
    return p
  }
  return client
}

async function openSession (server, origin) {
  const c = connect(server, origin)
  await c.opened
  const r = await c.call('session.open', { token: server.token })
  return { c, r }
}

const ORIGIN = 'http://localhost:8081'

test('default port 80 is written without :80 in Host, Origin and the CSP', (t) => {
  const { authority, securityHeaders } = require('../lib/serve/server')
  t.is(authority('127.0.0.1', 80), '127.0.0.1')
  t.is(authority('localhost', 8787), 'localhost:8787')
  const csp = securityHeaders(80)['Content-Security-Policy']
  t.ok(csp.includes("connect-src 'self' ws://127.0.0.1 ws://localhost;"), csp)
})

test('Host check on HTTP and on the upgrade', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  t.is((await request(s, { host: 'evil.example:' + s.port })).status, 421, 'bad Host on HTTP -> 421')
  t.is((await request(s, { host: '127.0.0.1:1' })).status, 421, 'wrong port -> 421')
  t.is(await rawUpgrade(s, { host: 'evil.example:' + s.port, origin: ORIGIN }), 421, 'bad Host on upgrade -> 421')
  t.is((await request(s, { host: 'localhost:' + s.port, path: '/x' })).status, 404, 'localhost Host accepted')
  noLeak(t, s)
})

test('Origin: missing, wrong, right; path; no CORS', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  t.is(await rawUpgrade(s, {}), 403, 'no Origin -> 403')
  t.is(await rawUpgrade(s, { origin: 'http://evil.example' }), 403, 'wrong Origin -> 403')
  t.is(await rawUpgrade(s, { origin: 'http://127.0.0.1:' + s.port }), 403, 'own origin not allowed without --ui')
  t.is(await rawUpgrade(s, { origin: ORIGIN, path: '/other' }), 404, 'upgrade outside /rpc -> 404')
  t.is(await rawUpgrade(s, { origin: ORIGIN }), 101, 'allowed Origin -> 101')
  const r = await request(s, { path: '/rpc' })
  t.absent(Object.keys(r.headers).some((h) => h.startsWith('access-control-')), 'no CORS headers')
  noLeak(t, s)
})

test('token wrong -> UNAUTHORIZED and closed; right -> identity.create end to end', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])

  const bad = connect(s, ORIGIN)
  await bad.opened
  const before = await bad.call('node.info')
  t.is(before.error.code, 'UNAUTHORIZED', 'requests before session.open are refused')
  const wrong = await bad.call('session.open', { token: 'x'.repeat(64) })
  t.is(wrong.ok, false)
  t.is(wrong.error.code, 'UNAUTHORIZED')
  t.is((await bad.closed).code, 1008, 'closed after a wrong token')

  const { c, r } = await openSession(s, ORIGIN)
  t.is(r.ok, true)
  t.is(r.result.protocol, 1)
  const created = await c.call('identity.create')
  t.is(created.ok, true, 'identity.create works')
  t.ok(HEX64.test(created.result.publicKey))
  t.is(created.result.association, m.association)
  const info = await c.call('node.info')
  t.is(info.result.publicKey, created.result.publicKey)
  t.is(info.result.publicDht, false)
  c.ws.close()
  noLeak(t, s)
})

test('no session.open in time -> closed (VARANDA_SERVE_OPEN_TIMEOUT_MS)', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN], { VARANDA_SERVE_OPEN_TIMEOUT_MS: '300' })
  const c = connect(s, ORIGIN)
  await c.opened
  const started = Date.now()
  t.is((await c.closed).code, 1008, 'closed without session.open')
  t.ok(Date.now() - started < 4000, 'closed by the shorter deadline')
  noLeak(t, s)
})

test('at most 4 sockets; a second authenticated socket replaces the first (4000)', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  const first = await openSession(s, ORIGIN)
  t.is(first.r.ok, true)
  const others = [connect(s, ORIGIN), connect(s, ORIGIN), connect(s, ORIGIN)]
  await Promise.all(others.map((c) => c.opened))
  t.is(await rawUpgrade(s, { origin: ORIGIN }), 503, 'a 5th socket -> 503')

  const r = await others[0].call('session.open', { token: s.token })
  t.is(r.ok, true, 'second socket authenticates')
  const closed = await first.c.closed
  t.is(closed.code, 4000, 'the first is replaced')
  t.is(closed.reason, 'substituída')
  const info = await others[0].call('node.info')
  t.is(info.ok, true, 'the new socket works')
  await until(async () => (await rawUpgrade(s, { origin: ORIGIN })) === 101, { name: 'slot freed' })
  for (const c of others) c.ws.close()
  noLeak(t, s)
})

test('rate limit, binary frame, oversized frame', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])

  const flood = await openSession(s, ORIGIN)
  for (let i = 0; i < 100; i++) flood.c.ws.send('{"v":1,"id":' + (1000 + i) + ',"method":"sync.status","params":{}}')
  t.is((await flood.c.closed).code, 1008, 'over the rate -> 1008')

  const bin = await openSession(s, ORIGIN)
  bin.c.ws.send(Buffer.from('{}'), { binary: true })
  t.is((await bin.c.closed).code, 1003, 'binary frame -> 1003')

  const big = await openSession(s, ORIGIN)
  big.c.ws.send('"' + 'a'.repeat(MAX_REQUEST + 10) + '"')
  t.is((await big.c.closed).code, 1009, 'oversized frame -> closed (1009)')

  const junk = await openSession(s, ORIGIN)
  junk.c.ws.send('not json')
  t.is((await junk.c.closed).code, 1008, 'unparsable message -> closed')
  noLeak(t, s)
})

test('static UI: index, SPA fallback, traversal and dotfiles, headers', async (t) => {
  const m = await member(t)
  const root = tmpDir(t)
  const outside = tmpDir(t)
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><p>varanda</p>')
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)')
  fs.writeFileSync(path.join(root, 'manifest.webmanifest'), '{"name":"Varanda"}')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'segredo')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  fs.symlinkSync(outside, path.join(root, 'out'))

  const s = await serve(t, [...memberArgs(m), '--ui', root])
  t.ok(/\nabra http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}\n$/.test(s.stdout), 'prints the URL with the token fragment')

  const index = await request(s, { path: '/' })
  t.is(index.status, 200)
  t.is(index.headers['content-type'], 'text/html; charset=utf-8')
  t.ok(index.body.includes('varanda'))
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self' ws://127.0.0.1:" + s.port + ' ws://localhost:' + s.port +
    "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
  t.is(index.headers['content-security-policy'], csp, 'CSP')
  t.is(index.headers['x-content-type-options'], 'nosniff')
  t.is(index.headers['referrer-policy'], 'no-referrer')
  t.is(index.headers['x-frame-options'], 'DENY')
  t.is(index.headers['cache-control'], 'no-store')

  const js = await request(s, { path: '/assets/app.js' })
  t.is(js.status, 200)
  t.is(js.headers['content-type'], 'text/javascript; charset=utf-8')
  t.is((await request(s, { path: '/assets/app.js', method: 'HEAD' })).status, 200, 'HEAD')

  const manifest = await request(s, { path: '/manifest.webmanifest' })
  t.is(manifest.status, 200, 'web manifest served')
  t.is(manifest.headers['content-type'], 'application/manifest+json; charset=utf-8', 'web manifest type')
  t.is((await request(s, { path: '/missing.webmanifest' })).status, 404, 'missing web manifest -> 404')

  const spa = await request(s, { path: '/perfil/abc' })
  t.is(spa.status, 200, 'SPA fallback')
  t.ok(spa.body.includes('varanda'))
  t.is((await request(s, { path: '/assets' })).status, 200, 'a directory is never listed (fallback)')
  t.is((await request(s, { path: '/missing.js' })).status, 404, 'missing file with extension -> 404')

  for (const p of ['/../secret.txt', '/assets/../../x', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt',
    '/assets%5c..%5cindex.html', '/.env', '/%2eenv', '/link.txt', '/out/secret.txt', '/out', '/%00', '/%zz']) {
    const r = await request(s, { path: p })
    t.is(r.status, 404, p + ' -> 404')
    t.absent(r.body.includes('segredo') || r.body.includes('SECRET'), p + ' leaks nothing')
  }
  const notFound = await request(s, { path: '/.env' })
  t.is(notFound.headers['x-frame-options'], 'DENY', 'headers on a 404 too')

  t.is((await request(s, { method: 'POST' })).status, 405, 'POST -> 405')
  t.is(await rawUpgrade(s, { origin: 'http://127.0.0.1:' + s.port }), 101, 'own origin allowed with --ui')
  t.is(await rawUpgrade(s, { origin: 'http://localhost:' + s.port }), 101, 'localhost origin allowed with --ui')
  noLeak(t, s)
})

test('without --ui every path is 404; POST is 405', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  for (const p of ['/', '/index.html', '/x/y']) t.is((await request(s, { path: p })).status, 404, p + ' -> 404')
  t.is((await request(s, { method: 'POST', path: '/rpc' })).status, 405)
  t.is((await request(s, { method: 'PUT', path: '/' })).status, 405)
  noLeak(t, s)
})

test('refusals before listening', async (t) => {
  const m = await member(t)
  const seederDir = tmpDir(t)
  const seeded = spawnSync(process.execPath, [CLI, 'seed', 'key', '--data', seederDir, '--association', m.association], { env: baseEnv, encoding: 'utf8' })
  t.is(seeded.status, 0, 'seeder dir created')

  const cases = [
    ['seeder data dir', ['--data', seederDir, '--association', m.association, ...bootstrapFlags(m.bootstrap), '--origin', ORIGIN], {}, /^uso: diretório não é de um membro\n$/],
    ['association data dir', ['--data', m.assocDir, '--association', m.association, ...bootstrapFlags(m.bootstrap), '--origin', ORIGIN], {}, /^uso: diretório não é de um membro\n$/],
    ['no bootstrap, no --public-dht', ['--data', m.dataDir, '--association', m.association, '--origin', ORIGIN], {}, /^uso: informe --bootstrap ou --public-dht\n/],
    ['both', [...memberArgs(m), '--public-dht', '--origin', ORIGIN], {}, /^uso: --bootstrap e --public-dht são exclusivos\n/],
    ['VARANDA_BOOTSTRAP with --public-dht', ['--data', m.dataDir, '--association', m.association, '--public-dht', '--origin', ORIGIN], { VARANDA_BOOTSTRAP: m.bootstrap.join(',') }, /^uso: --bootstrap e --public-dht são exclusivos\n/],
    ['loopback --dht-host with --public-dht', ['--data', m.dataDir, '--association', m.association, '--public-dht', '--dht-host', '127.0.0.1', '--origin', ORIGIN], {}, /^uso: dht-host de loopback e DHT pública são exclusivos\n$/],
    ['no allowed origin', memberArgs(m), {}, /^uso: informe --origin ou --ui\n/],
    ['bad origin', [...memberArgs(m), '--origin', 'http://localhost:8081/'], {}, /^uso: origem inválida /],
    ['a fixed token is refused', [...memberArgs(m), '--origin', ORIGIN], { VARANDA_SERVE_TOKEN: 'T'.repeat(48) }, /^uso: VARANDA_SERVE_TOKEN não é aceito: o token é gerado a cada início\n/],
    ['token flag does not exist', [...memberArgs(m), '--origin', ORIGIN, '--token', 'a'.repeat(64)], {}, /^uso: opção desconhecida --token\n/],
    ['host flag does not exist', [...memberArgs(m), '--origin', ORIGIN, '--host', '0.0.0.0'], {}, /^uso: opção desconhecida --host\n/],
    ['no association', ['--data', m.dataDir, ...bootstrapFlags(m.bootstrap), '--origin', ORIGIN], {}, /^uso: informe --association <hex>\n/],
    ['bad port', [...memberArgs(m), '--origin', ORIGIN, '--port', '70000'], {}, /^uso: porta inválida\n/],
    ['bad open timeout', [...memberArgs(m), '--origin', ORIGIN], { VARANDA_SERVE_OPEN_TIMEOUT_MS: '60000' }, /^uso: VARANDA_SERVE_OPEN_TIMEOUT_MS inválido\n/]
  ]
  for (const [name, args, env, re] of cases) {
    const r = refuse(args, env)
    t.is(r.code, 2, name + ': exit 2')
    t.ok(re.test(r.stderr), name + ': ' + r.stderr.split('\n')[0])
    t.is(r.stdout, '', name + ': nothing on stdout (never listened)')
  }
})

test('EADDRINUSE and SIGTERM releases the data dir', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  t.ok(HEX64.test(s.token), 'a fresh 64-hex token')

  const other = tmpDir(t)
  const busy = spawnSync(process.execPath, [SERVE, '--port', String(s.port), '--data', other, '--association', m.association, ...bootstrapFlags(m.bootstrap), '--origin', ORIGIN], { env: baseEnv, encoding: 'utf8', timeout: 30000 })
  t.is(busy.status, 1)
  t.is(busy.stderr, 'erro: porta em uso\n')

  const { c, r } = await openSession(s, ORIGIN)
  t.is(r.ok, true)
  t.is((await c.call('identity.create')).ok, true)
  // A continuous sync holds the data-dir lock until the session closes.
  const started = await c.call('sync.start', { once: false })
  t.is(started.ok, true, 'sync started')
  await until(() => c.messages.some((msg) => msg.event === 'sync.started'), { name: 'sync.started' })

  s.child.kill('SIGTERM')
  const closed = await c.closed
  t.is(closed.code, 1001, 'socket closed with 1001')
  const { code } = await s.exit
  t.is(code, 0, 'exit 0 after SIGTERM')

  const show = spawnSync(process.execPath, [CLI, 'id', 'show', '--data', m.dataDir], { env: baseEnv, encoding: 'utf8', timeout: 30000 })
  t.is(show.status, 0, 'the data dir is free for the CLI: ' + show.stderr)
  noLeak(t, s)
})
