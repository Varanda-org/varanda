'use strict'

// varanda-serve end to end: the real bin, spawned with --port 0, on a member
// data dir with a loopback testnet bootstrap.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { testnet, tmpDir, bootstrapFlags, until } = require('./helpers/net')
const { connect, openSession } = require('./helpers/ws-client')
const { initAssociation } = require('@varanda/core/lib/assoc')
const WebSocket = require('ws')
const { MAX_REQUEST, createClient } = require('@varanda/rpc')

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

test('scripted client: errors and the sync events of the contract', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  const { c } = await openSession(s, ORIGIN)

  const again = await c.call('session.open', { token: s.token })
  t.is(again.error.code, 'USAGE')
  t.is(again.error.message, 'sessão já aberta')
  const extra = await c.call('node.info', { extra: 1 })
  t.is(extra.error.code, 'USAGE')
  t.is(extra.error.message, 'parâmetro desconhecido')
  const noIdentity = await c.call('sync.start')
  t.is(noIdentity.error.code, 'NOT_FOUND')
  t.is(noIdentity.error.message, 'identidade não encontrada')
  t.is(c.events('sync.started').length, 0, 'a refused sync.start emits nothing')

  t.is((await c.call('identity.create')).ok, true)
  const start = await c.call('sync.start', { once: false })
  t.is(start.ok, true)
  const started = await c.event('sync.started')
  t.is(started.data.runId, start.result.runId, 'sync.started carries the runId of the response')
  t.is(started.data.once, false)
  t.ok(c.messages.indexOf(started) < c.messages.indexOf(start), 'sync.started comes before the response')

  const second = await c.call('sync.start')
  t.is(second.error.code, 'USAGE')
  t.is(second.error.message, 'sincronização já em andamento')
  t.alike((await c.call('sync.status')).result, { state: 'running', runId: start.result.runId, once: false })

  const stop = await c.call('sync.stop')
  t.is(stop.result.stopped, true)
  const stopped = await c.event('sync.stopped', (data) => data.runId === start.result.runId)
  t.is(stopped.data.reason, 'stopped')
  t.ok(c.messages.indexOf(stopped) < c.messages.indexOf(stop), 'sync.stopped comes before the sync.stop response')
  t.ok(stopped.seq > started.seq, 'seq grows')
  t.alike((await c.call('sync.status')).result, { state: 'idle' })
  t.is((await c.call('sync.stop')).result.stopped, false, 'nothing left to stop')
  c.ws.close()
  noLeak(t, s)
})

test('reconnection: closing the socket stops the run and keeps the identity', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  const first = await openSession(s, ORIGIN)
  const created = await first.c.call('identity.create')
  const run = await first.c.call('sync.start', { once: false })
  await first.c.event('sync.started')
  first.c.ws.close()
  await first.c.closed

  const { c, r } = await openSession(s, ORIGIN)
  t.is(r.ok, true, 'the same token opens a new session')
  t.is((await c.call('node.info')).result.publicKey, created.result.publicKey, 'the identity survives')
  await until(async () => (await c.call('sync.status')).result.state === 'idle', { name: 'run stopped by the close' })
  t.absent(c.messages.some((msg) => msg.event !== undefined), 'nothing of the old run reaches the new socket')

  const again = await c.call('sync.start', { once: false })
  t.is(again.ok, true, 'a new run can start')
  t.ok(again.result.runId > run.result.runId, 'with a new runId')
  t.is((await c.event('sync.started')).data.runId, again.result.runId)
  c.ws.close()
  noLeak(t, s)
})

test('reconnection: a replaced socket hands the running sync to the new one', async (t) => {
  const m = await member(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  const first = await openSession(s, ORIGIN)
  await first.c.call('identity.create')
  const run = await first.c.call('sync.start', { once: false })
  await first.c.event('sync.started')

  const next = connect(s, ORIGIN)
  await next.opened
  t.is((await next.call('session.open', { token: s.token })).ok, true)
  t.is((await first.c.closed).code, 4000, 'the first socket is replaced')
  t.alike((await next.call('sync.status')).result, { state: 'running', runId: run.result.runId, once: false }, 'the run goes on')

  t.is((await next.call('sync.stop')).result.stopped, true)
  const stopped = await next.event('sync.stopped', (data) => data.runId === run.result.runId)
  t.is(stopped.data.reason, 'stopped', 'its events reach the new socket')
  t.is(first.c.events('sync.stopped').length, 0, 'and not the replaced one')
  next.ws.close()
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
  // deploy/seeder/Caddyfile's @semExtensao matcher already rewrites these paths in production.
  for (const p of ['/@ana', '/m/' + 'a'.repeat(64)]) {
    const link = await request(s, { path: p })
    t.is(link.status, 200, p + ' SPA fallback')
    t.is(link.headers['content-type'], 'text/html; charset=utf-8', p + ' HTML')
    t.ok(link.body.includes('varanda'), p + ' index body')
  }
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

// A member data dir with an identity and its certificate as block 0, which
// post.create needs.
async function certifiedMember (t) {
  const m = await member(t)
  const run = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { env: baseEnv, encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw new Error('varanda ' + args.join(' ') + ': ' + r.stderr)
    return JSON.parse(r.stdout)
  }
  const { publicKey } = run(['id', 'create', '--data', m.dataDir, '--association', m.association])
  const certFile = path.join(tmpDir(t), 'cert.json')
  run(['assoc', 'certify', '--data', m.assocDir, '--member', publicKey, '--out', certFile])
  run(['cert', 'add', '--data', m.dataDir, '--cert-file', certFile])
  return m
}

// A TCP relay in front of varanda-serve for one connection: hold() keeps what
// the server says from reaching the client, release() delivers it, cut() drops
// the connection. The request always reaches the server.
async function relay (t, server) {
  let down = null
  let up = null
  let held = false
  const chunks = []
  const state = { port: null, heldBytes: 0 }
  const tcp = net.createServer((socket) => {
    down = socket
    up = net.connect(server.port, '127.0.0.1')
    for (const s of [down, up]) s.on('error', () => {})
    down.on('data', (d) => up.write(d))
    up.on('data', (d) => {
      server.seen.push(d.toString())
      if (!held) return down.write(d)
      chunks.push(d)
      state.heldBytes += d.length
    })
    down.on('close', () => up.destroy())
    up.on('close', () => down.destroy())
  })
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  state.port = tcp.address().port
  t.teardown(() => {
    down?.destroy()
    up?.destroy()
    tcp.close()
  }, { order: 0, force: true })
  state.hold = () => { held = true }
  state.release = () => {
    held = false
    for (const d of chunks.splice(0)) down.write(d)
  }
  state.cut = () => {
    down.destroy()
    up.destroy()
  }
  return state
}

// The real rpc client over a WebSocket to the relay, with every request it sent.
async function rpcThrough (server, rel, timeoutMs) {
  const ws = new WebSocket('ws://127.0.0.1:' + rel.port + '/rpc', { origin: ORIGIN, headers: { host: '127.0.0.1:' + server.port } })
  const sent = []
  const ignored = []
  const c = createClient({ send (message, text) { sent.push(message); ws.send(text) }, timeoutMs })
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (!c.receive(msg)) ignored.push(msg)
  })
  ws.on('close', () => c.close())
  ws.on('error', () => {})
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await c.request('session.open', { token: server.token })
  return { c, ws, sent, ignored }
}

const ONCE = 'só uma vez'
const onceBlocks = (result) => result.entries.filter((e) => e.record.type === 'post' && e.record.text === ONCE)
const sentCount = (sent, method) => sent.filter((m) => m.method === method).length

test('uncertain mutation: response held past the timeout -> TIMEOUT uncertain, never resent, one block', async (t) => {
  const m = await certifiedMember(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  const rel = await relay(t, s)
  const { c, ws, sent, ignored } = await rpcThrough(s, rel, 1000)

  rel.hold()
  const [write, read] = await Promise.all([
    c.request('post.create', { text: ONCE }).catch((e) => e),
    c.request('log.read').catch((e) => e)
  ])
  t.is(write.code, 'TIMEOUT')
  t.is(write.uncertain, true, 'the mutation may have happened')
  t.is(read.code, 'TIMEOUT')
  t.is(read.uncertain, false, 'a read is certain')
  t.is(c.pending, 0)

  rel.release()
  await until(() => ignored.length === 2, { name: 'late responses ignored' })
  t.is(sentCount(sent, 'post.create'), 1, 'not resent')
  t.is(sentCount(sent, 'log.read'), 1, 'not resent')
  const seen = await until(async () => {
    const log = await c.request('log.read')
    return onceBlocks(log).length > 0 && log
  }, { name: 'the post in the diary' })
  t.is(onceBlocks(seen).length, 1, 'one block')
  t.is(sentCount(sent, 'post.create'), 1, 'still not resent')
  ws.close()
  noLeak(t, s)
})

test('uncertain mutation: connection lost after the server answered -> CLOSED uncertain, never resent, one block', async (t) => {
  const m = await certifiedMember(t)
  const s = await serve(t, [...memberArgs(m), '--origin', ORIGIN])
  const rel = await relay(t, s)
  const { c, sent } = await rpcThrough(s, rel, 15000)

  rel.hold()
  const write = c.request('post.create', { text: ONCE }).catch((e) => e)
  await until(() => rel.heldBytes > 0, { name: 'post.create answered by the server' })
  const heldBefore = rel.heldBytes
  const read = c.request('log.read').catch((e) => e)
  await until(() => rel.heldBytes > heldBefore, { name: 'log.read answered by the server' })
  rel.cut()

  const w = await write
  const r = await read
  t.is(w.code, 'CLOSED')
  t.is(w.uncertain, true, 'the mutation may have happened')
  t.is(r.code, 'CLOSED')
  t.is(r.uncertain, false, 'a read is certain')
  t.is(c.pending, 0)
  t.is(sentCount(sent, 'post.create'), 1, 'not resent')

  const fresh = await openSession(s, ORIGIN)
  const log = await fresh.c.call('log.read')
  t.is(log.ok, true)
  t.is(onceBlocks(log.result).length, 1, 'one block')
  fresh.c.ws.close()
  noLeak(t, s)
})
