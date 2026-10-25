'use strict'

// apps/cli/lib/mod-apply.js (`mod apply --server`): pull the panel's
// decisions, reconcile with the local list, sign ONE snapshot, publish it
// (injected) and acknowledge it, against a loopback stand-in of the account
// service's challenge/pull/ack routes that records every body. The terminal
// is injected (`interactive`, `ask`): no test depends on a real TTY.

const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const assoc = require('@varanda/core/lib/assoc')
const { lockDataDir } = require('@varanda/core/lib/store')
const { loadKeyPairFile } = require('@varanda/core/lib/cert')
const { verifySnapshot, createSnapshot, MAX_BLOCKED } = require('@varanda/core/lib/blocklist')
const { verifyModRequest, canonicalBody } = require('@varanda/core/lib/mod-request')
const { apply, checkServer, MAX_UNATTENDED_BLOCKS } = require('../lib/mod-apply')
const { testnet, tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const X = 'cc'.repeat(32)
const SEEDER = 'dd'.repeat(32)
const CONFIRM = 'Assinar e publicar estas mudanças? [s/N] '
const CONFIRM_OPERATOR = 'Desbloquear também as chaves bloqueadas pela operação? [s/N] '
const MARK = ' (bloqueada pela operação)'

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function cli (args) {
  return spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
}

function readList (modDir) {
  return JSON.parse(fs.readFileSync(path.join(modDir, 'blocklist.json'), 'utf8')).snapshot
}

function logLines (modDir) {
  const file = path.join(modDir, 'moderation.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// `mod init` + `assoc certify-moderator` + `mod cert add`.
function setup (t) {
  const root = tmpDir(t)
  const assocDir = path.join(root, 'assoc')
  const modDir = path.join(root, 'mod')
  const { publicKey: association } = assoc.initAssociation(assocDir)
  const init = cli(['mod', 'init', '--association', association, '--data', modDir])
  t.is(init.status, 0, init.stderr)
  const moderator = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(init.stdout)[1]
  const certFile = path.join(root, 'moderator-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(assoc.issueModeratorCertificate(assocDir, { moderator })))
  const added = cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', modDir])
  t.is(added.status, 0, added.stderr)
  const secret = JSON.parse(fs.readFileSync(path.join(modDir, 'moderator.json'), 'utf8')).secretKey
  return { root, assocDir, modDir, association, moderator, secret }
}

// A second moderator dir for the same association (a key rotation).
function addModerator (t, ctx, name) {
  const modDir = path.join(ctx.root, name)
  const init = cli(['mod', 'init', '--association', ctx.association, '--data', modDir])
  t.is(init.status, 0, init.stderr)
  const moderator = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(init.stdout)[1]
  const certFile = path.join(ctx.root, name + '-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(assoc.issueModeratorCertificate(ctx.assocDir, { moderator })))
  const added = cli(['mod', 'cert', 'add', '--cert-file', certFile, '--data', modDir])
  t.is(added.status, 0, added.stderr)
  const secret = JSON.parse(fs.readFileSync(path.join(modDir, 'moderator.json'), 'utf8')).secretKey
  return { ...ctx, modDir, moderator, secret }
}

function seedList (t, modDir, key) {
  const res = cli(['mod', 'block', key, '--new-list', '--no-publish', '--data', modDir])
  t.is(res.status, 0, res.stderr)
  return readList(modDir)
}

function nonce () {
  return crypto.randomBytes(32).toString('base64url')
}

// The stand-in account service. `state.pull` is the pull answer (or a
// function returning { status, type, body }); every request is recorded.
async function fakeServer (t) {
  const state = {
    requests: [],
    nonces: [],
    pull: { changes: [], published: { snapshot: null } },
    ack: null
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null }
      state.requests.push(entry)
      const send = (status, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(status, { 'content-type': type })
        res.end(typeof body === 'string' ? body : JSON.stringify(body) + '\n')
      }
      if (req.method === 'GET' && url.pathname === '/account/mod/api/challenge') {
        const n = nonce()
        state.nonces.push({ nonce: n, op: url.searchParams.get('op') })
        return send(200, { nonce: n })
      }
      if (req.method === 'POST' && url.pathname === '/account/mod/api/pull') {
        const answer = typeof state.pull === 'function' ? state.pull() : { status: 200, body: state.pull }
        return send(answer.status, answer.body, answer.type)
      }
      if (req.method === 'POST' && url.pathname === '/account/mod/api/ack') {
        if (state.ack) return send(state.ack.status, state.ack.body)
        // As the real service: the snapshot must be signed by the
        // certificate's moderator.
        if (entry.body.snapshot.moderator !== entry.body.cert.moderator) return send(400, { error: 'pedido-invalido' })
        return send(200, { ok: true, seq: entry.body.snapshot.seq })
      }
      send(404, { error: 'nao-encontrado' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)), { force: true })
  state.origin = 'http://127.0.0.1:' + server.address().port
  state.byPath = (p) => state.requests.filter((r) => r.path === p)
  return state
}

function publisher (delivered = true) {
  const calls = []
  const publish = async (snapshot) => {
    calls.push(snapshot)
    return { delivered: typeof delivered === 'function' ? delivered() : delivered, conflict: false, peers: 1 }
  }
  return { calls, publish }
}

// An interactive run by default, answering `answers` in turn ('s' once they
// run out); every question asked is recorded.
async function run (ctx, srv, publish, extra = {}, answers = []) {
  const lines = []
  const asked = []
  let error = null
  let code = null
  const ask = async (question) => {
    asked.push(question)
    return answers.length > 0 ? answers.shift() : 's'
  }
  try {
    code = await apply({ dir: ctx.modDir, association: ctx.association, server: srv.origin, publish, print: (l) => lines.push(l), interactive: true, ask, ...extra })
  } catch (err) {
    error = err
  }
  return { code, error, lines, asked }
}

function verifySignatures (t, ctx, srv) {
  for (const req of srv.requests.filter((r) => r.method === 'POST')) {
    const op = req.path.endsWith('/pull') ? 'pull' : 'ack'
    const body = op === 'pull' ? canonicalBody('pull') : canonicalBody('ack', { changeIds: req.body.changeIds, snapshot: req.body.snapshot })
    const fields = { origin: srv.origin, association: ctx.association, moderator: req.body.cert.moderator, nonce: req.body.nonce, op, body }
    t.is(req.body.cert.moderator, ctx.moderator)
    t.alike(verifyModRequest(fields, req.body.signature), { ok: true }, op + ' signature verifies for the origin')
    t.alike(verifyModRequest({ ...fields, origin: 'https://other.example' }, req.body.signature), { ok: false, reason: 'bad-signature' }, op + ' signature is bound to the origin')
    t.ok(srv.nonces.some((n) => n.nonce === req.body.nonce && n.op === op), op + ' uses a nonce issued for its op')
  }
}

test('two blocks and one unblock become one snapshot, published then acknowledged', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  srv.pull = {
    changes: [
      { id: 'c2', op: 'block', member: B, at: '2026-10-24T10:00:02.000Z' },
      { id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' },
      { id: 'c3', op: 'unblock', member: X, at: '2026-10-24T10:00:03.000Z' }
    ],
    published: { snapshot: first }
  }
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  t.is(res.code, 0)
  const snapshot = readList(ctx.modDir)
  t.is(snapshot.seq, first.seq + 1)
  t.alike(snapshot.blocked.slice().sort(), [A, B])
  // In the server's order (c2 before c1), never re-sorted by `at`.
  t.alike(res.lines, ['bloquear ' + B, 'bloquear ' + A, 'desbloquear ' + X + MARK, 'aplicado: seq 2, 2 chaves bloqueadas'])
  t.alike(res.asked, [CONFIRM, CONFIRM_OPERATOR], 'X was blocked by `mod block`: a second confirmation')
  t.is(pub.calls.length, 1)
  t.is(pub.calls[0].signature, snapshot.signature)
  const acks = srv.byPath('/account/mod/api/ack')
  t.is(acks.length, 1)
  t.alike(acks[0].body.changeIds.slice().sort(), ['c1', 'c2', 'c3'])
  t.alike(verifySnapshot(acks[0].body.snapshot, ctx.association), { ok: true })
  t.is(acks[0].body.snapshot.signature, snapshot.signature)
  t.alike(srv.byPath('/account/mod/api/challenge').map((r) => r.query), [
    { moderator: ctx.moderator, op: 'pull' },
    { moderator: ctx.moderator, op: 'ack' }
  ])
  verifySignatures(t, ctx, srv)
  const log = logLines(ctx.modDir).slice(1)
  t.alike(log.map((l) => [l.op, l.member, l.seq, l.source]).sort(), [['block', A, 2, 'painel'], ['block', B, 2, 'painel'], ['unblock', X, 2, 'painel']])
  t.is(logLines(ctx.modDir)[0].source, 'operacao', '`mod block` lines carry source operacao')
  const all = JSON.stringify(srv.requests) + res.lines.join('\n')
  t.absent(all.includes(ctx.secret), 'the moderator secret never leaves the machine')
})

test('an empty pull with no local list makes no snapshot and no ack', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const srv = await fakeServer(t)
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  t.alike(res.lines, ['nada a aplicar'])
  t.is(pub.calls.length, 0)
  t.is(srv.byPath('/account/mod/api/ack').length, 0)
  t.absent(fs.existsSync(path.join(ctx.modDir, 'blocklist.json')))
})

test('decisions in a dir with no list need --new-list', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: null } }
  const pub = publisher(true)
  const refused = await run(ctx, srv, pub.publish)
  t.ok(refused.error && refused.error.message.startsWith('este diretório não tem lista anterior'))
  t.absent(fs.existsSync(path.join(ctx.modDir, 'blocklist.json')))
  t.is(srv.byPath('/account/mod/api/ack').length, 0)
  const res = await run(ctx, srv, pub.publish, { newList: true })
  t.is(res.error, null, res.error && res.error.message)
  t.is(readList(ctx.modDir).seq, 1)
  t.alike(readList(ctx.modDir).blocked, [A])
  t.is(srv.byPath('/account/mod/api/ack').length, 1)
})

test('an empty pull with a local list and nothing published republishes and acks it with []', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  t.alike(res.lines, ['confirmado: seq 1'])
  t.is(pub.calls.length, 1)
  t.is(pub.calls[0].signature, first.signature)
  const acks = srv.byPath('/account/mod/api/ack')
  t.is(acks.length, 1)
  t.alike(acks[0].body.changeIds, [])
  t.is(acks[0].body.snapshot.signature, first.signature)
  t.is(readList(ctx.modDir).seq, 1, 'no new snapshot')
  verifySignatures(t, ctx, srv)

  // Once the panel holds it, an empty pull has nothing to do.
  srv.pull = { changes: [], published: { snapshot: first } }
  const again = await run(ctx, srv, pub.publish)
  t.alike(again.lines, ['nada a aplicar'])
  t.is(pub.calls.length, 1)
  t.is(srv.byPath('/account/mod/api/ack').length, 1)
})

test('a publish timeout exits without an ack; the next run republishes the same bytes and acks', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: first } }
  let delivered = false
  const pub = publisher(() => delivered)
  const failed = await run(ctx, srv, pub.publish)
  t.is(failed.error && failed.error.message, 'não foi possível publicar a lista')
  t.is(srv.byPath('/account/mod/api/ack').length, 0, 'no ack for an undelivered list')
  const written = readList(ctx.modDir)
  t.is(written.seq, 2, 'the list stays written')

  delivered = true
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  t.alike(res.lines, ['já estava bloqueada ' + A, 'confirmado: seq 2'])
  t.is(pub.calls.length, 2)
  t.is(pub.calls[1].seq, 2)
  t.is(pub.calls[1].signature, written.signature, 'same bytes republished')
  t.is(readList(ctx.modDir).signature, written.signature)
  const acks = srv.byPath('/account/mod/api/ack')
  t.is(acks.length, 1)
  t.alike(acks[0].body.changeIds, ['c1'])
  t.is(acks[0].body.snapshot.signature, written.signature)
})

test('a decision cancelled after a failed publish is undone by the next apply', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: first } }
  let delivered = false
  const pub = publisher(() => delivered)
  await run(ctx, srv, pub.publish)
  t.alike(readList(ctx.modDir).blocked.slice().sort(), [A, X])
  // D6: the panel compensates the claimed block with an unblock.
  srv.pull = {
    changes: [
      { id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' },
      { id: 'c2', op: 'unblock', member: A, at: '2026-10-24T10:00:05.000Z' }
    ],
    published: { snapshot: first }
  }
  delivered = true
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  const snapshot = readList(ctx.modDir)
  t.is(snapshot.seq, 3)
  t.alike(snapshot.blocked, [X])
  const acks = srv.byPath('/account/mod/api/ack')
  t.is(acks.length, 1)
  t.alike(acks[0].body.changeIds.slice().sort(), ['c1', 'c2'])
})

test('changes are walked in the server order even when the clock stepped back', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  // The store's order is insertion order: the unblock (a compensation) comes
  // after the block although its timestamp is earlier.
  srv.pull = {
    changes: [
      { id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:05.000Z' },
      { id: 'c2', op: 'unblock', member: A, at: '2026-10-24T10:00:01.000Z' }
    ],
    published: { snapshot: first }
  }
  const pub = publisher(() => true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  t.alike(readList(ctx.modDir).blocked, [X], 'the later intention (unblock) wins, not the later timestamp')
})

test('pending changes that cancel out in a dir with no list need --new-list, then sign the first list and ack', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const srv = await fakeServer(t)
  srv.pull = {
    changes: [
      { id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' },
      { id: 'c2', op: 'unblock', member: A, at: '2026-10-24T10:00:05.000Z' }
    ],
    published: { snapshot: null }
  }
  const pub = publisher(true)
  const refused = await run(ctx, srv, pub.publish)
  t.ok(refused.error && refused.error.message.includes('--new-list'), refused.error && refused.error.message)
  t.absent(fs.existsSync(path.join(ctx.modDir, 'blocklist.json')), 'nothing signed without --new-list')
  t.is(pub.calls.length, 0)
  t.is(srv.byPath('/account/mod/api/ack').length, 0, 'nothing acked without --new-list')

  const res = await run(ctx, srv, pub.publish, { newList: true })
  t.is(res.error, null, res.error && res.error.message)
  const snapshot = readList(ctx.modDir)
  t.is(snapshot.seq, 1)
  t.alike(snapshot.blocked, [])
  t.alike(res.lines, ['não estava bloqueada ' + A, 'aplicado: seq 1, 0 chaves bloqueadas'])
  t.alike(res.asked, [], 'no net change: nothing to confirm')
  t.is(pub.calls.length, 1)
  t.is(pub.calls[0].signature, snapshot.signature)
  const acks = srv.byPath('/account/mod/api/ack')
  t.is(acks.length, 1)
  t.alike(acks[0].body.changeIds.slice().sort(), ['c1', 'c2'])
  t.is(acks[0].body.snapshot.signature, snapshot.signature)
  verifySignatures(t, ctx, srv)
})

test('after a moderator rotation a run with no net change signs the same sets with the new key', async (t) => {
  await testnet(t)
  const old = setup(t)
  const first = seedList(t, old.modDir, X)
  const ctx = addModerator(t, old, 'mod2')
  t.not(ctx.moderator, old.moderator)
  // README: the rotation copies blocklist.json into the new dir.
  fs.copyFileSync(path.join(old.modDir, 'blocklist.json'), path.join(ctx.modDir, 'blocklist.json'))
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: X, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: first } }
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  const snapshot = readList(ctx.modDir)
  t.is(snapshot.seq, first.seq + 1)
  t.is(snapshot.moderator, ctx.moderator, 'signed by the new moderator')
  t.ok(snapshot.moderatorDate > first.moderatorDate, 'the newer certificate wins')
  t.alike(snapshot.blocked, [X])
  t.alike(verifySnapshot(snapshot, ctx.association), { ok: true })
  t.alike(res.lines, ['já estava bloqueada ' + X, 'aplicado: seq 2, 1 chaves bloqueadas'])
  t.is(pub.calls.length, 1)
  t.is(pub.calls[0].signature, snapshot.signature)
  const acks = srv.byPath('/account/mod/api/ack')
  t.is(acks.length, 1)
  t.alike(acks[0].body.changeIds, ['c1'])
  t.is(acks[0].body.snapshot.signature, snapshot.signature)
  t.is(acks[0].body.snapshot.moderator, acks[0].body.cert.moderator)
  verifySignatures(t, ctx, srv)
  t.absent((JSON.stringify(srv.requests) + res.lines.join('\n')).includes(ctx.secret))

  // The rotated list is now this moderator's: an empty pull has nothing to do.
  srv.pull = { changes: [], published: { snapshot } }
  const again = await run(ctx, srv, pub.publish)
  t.is(again.error, null, again.error && again.error.message)
  t.alike(again.lines, ['nada a aplicar'])
  t.is(readList(ctx.modDir).seq, 2)
  t.is(srv.byPath('/account/mod/api/ack').length, 1)
})

test('a full list takes an unblock and a replacement block in one run', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const kp = loadKeyPairFile(path.join(ctx.modDir, 'moderator.json'))
  const cert = JSON.parse(fs.readFileSync(path.join(ctx.modDir, 'moderator-cert.json'), 'utf8'))
  const keys = []
  for (let i = 1; i <= MAX_BLOCKED; i++) keys.push(i.toString(16).padStart(64, '0'))
  const full = createSnapshot({ seq: 1, blocked: keys, revokedIssuers: [] }, kp, cert)
  fs.writeFileSync(path.join(ctx.modDir, 'blocklist.json'), JSON.stringify({ v: 1, snapshot: full }), { mode: 0o600 })

  // B2's single-key command keeps its capacity message.
  const over = cli(['mod', 'block', A, '--no-publish', '--data', ctx.modDir])
  t.is(over.status, 1)
  t.is(over.stderr, 'erro: lista cheia (máximo ' + MAX_BLOCKED + ')\n')
  t.is(readList(ctx.modDir).seq, 1)

  const srv = await fakeServer(t)
  srv.pull = {
    changes: [
      { id: 'c1', op: 'unblock', member: keys[0], at: '2026-10-24T10:00:01.000Z' },
      { id: 'c2', op: 'block', member: A, at: '2026-10-24T10:00:02.000Z' }
    ],
    published: { snapshot: full }
  }
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error, null, res.error && res.error.message)
  const snapshot = readList(ctx.modDir)
  t.is(snapshot.seq, 2)
  t.is(snapshot.blocked.length, MAX_BLOCKED)
  t.ok(snapshot.blocked.includes(A))
  t.absent(snapshot.blocked.includes(keys[0]))
  t.alike(srv.byPath('/account/mod/api/ack')[0].body.changeIds.slice().sort(), ['c1', 'c2'])
})

test('a published snapshot ahead of the local list exits writing nothing', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const kp = loadKeyPairFile(path.join(ctx.modDir, 'moderator.json'))
  const cert = JSON.parse(fs.readFileSync(path.join(ctx.modDir, 'moderator-cert.json'), 'utf8'))
  const ahead = createSnapshot({ seq: first.seq + 1, blocked: [X, B], revokedIssuers: [] }, kp, cert)
  const before = fs.readFileSync(path.join(ctx.modDir, 'blocklist.json'))
  const logBefore = fs.readFileSync(path.join(ctx.modDir, 'moderation.jsonl'))
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: ahead } }
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish)
  t.is(res.error && res.error.message, 'lista local atrás da publicada; restaure o backup da moderação')
  t.alike(fs.readFileSync(path.join(ctx.modDir, 'blocklist.json')), before)
  t.alike(fs.readFileSync(path.join(ctx.modDir, 'moderation.jsonl')), logBefore)
  t.is(pub.calls.length, 0)
  t.is(srv.byPath('/account/mod/api/ack').length, 0)
})

test('malformed answers and a stale ack exit 1', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  const pub = publisher(true)
  const change = { id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' }
  const bad = [
    { status: 200, body: { changes: [], published: { snapshot: null }, extra: 1 } },
    { status: 200, body: { changes: [{ ...change, by: 'x' }], published: { snapshot: null } } },
    { status: 200, body: { changes: [change, change], published: { snapshot: null } } },
    { status: 200, body: { changes: [{ ...change, member: A.toUpperCase() }], published: { snapshot: null } } },
    { status: 200, body: { changes: [{ ...change, at: 'ontem' }], published: { snapshot: null } } },
    { status: 200, body: { changes: [], published: { snapshot: { ...first, seq: 9 } } } },
    { status: 200, body: { changes: new Array(1001).fill(0).map((_, i) => ({ ...change, id: 'c' + i })), published: { snapshot: null } } },
    { status: 200, body: '{"changes":[],', type: 'application/json' },
    { status: 200, body: '{"changes":[],"published":{"snapshot":null}}', type: 'text/html' },
    { status: 200, body: JSON.stringify({ changes: [], published: { snapshot: null }, pad: 'x'.repeat(1048576) }) },
    { status: 403, body: { error: 'nao-autorizado', detail: 1 } }
  ]
  for (const answer of bad) {
    srv.pull = () => answer
    const res = await run(ctx, srv, pub.publish)
    t.is(res.error && res.error.message, 'resposta inválida do servidor')
  }
  srv.pull = () => ({ status: 403, body: { error: 'nao-autorizado' } })
  const refused = await run(ctx, srv, pub.publish)
  t.is(refused.error && refused.error.message, 'o servidor recusou o pedido (nao-autorizado)')
  t.is(pub.calls.length, 0)
  t.is(readList(ctx.modDir).seq, first.seq)

  srv.pull = { changes: [change], published: { snapshot: first } }
  srv.ack = { status: 409, body: { error: 'defasado' } }
  const stale = await run(ctx, srv, pub.publish)
  t.is(stale.error && stale.error.message, 'o servidor tem uma lista mais nova; restaure o backup')
})

test('--server must be an https origin (http only on 127.0.0.1); --no-publish opens no socket', async (t) => {
  await testnet(t)
  for (const bad of ['http://example.com', 'http://10.0.0.1:8080', 'http://localhost:1234', 'https://varanda.example/', 'https://varanda.example/account', 'ftp://varanda.example', 'varanda.example', 'https://user@varanda.example']) {
    try {
      checkServer(bad)
      t.fail(bad + ' accepted')
    } catch (err) {
      t.is(err.code, 'USAGE')
      t.is(err.message, 'server inválido')
    }
  }
  t.is(checkServer('https://varanda.example'), 'https://varanda.example')
  t.is(checkServer('http://127.0.0.1:8790'), 'http://127.0.0.1:8790')

  const ctx = setup(t)
  seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  const remote = cli(['mod', 'apply', '--server', 'http://example.com', '--seeder', SEEDER, '--data', ctx.modDir])
  t.is(remote.status, 2)
  t.is(remote.stderr, 'uso: server inválido\n')
  const noPublish = cli(['mod', 'apply', '--server', srv.origin, '--seeder', SEEDER, '--no-publish', '--data', ctx.modDir])
  t.is(noPublish.status, 2)
  t.is(noPublish.stderr, 'uso: apply publica; não aceita --no-publish\n')
  const missing = cli(['mod', 'apply', '--seeder', SEEDER, '--data', ctx.modDir])
  t.is(missing.status, 2)
  t.is(missing.stderr, 'uso: informe --server <origem>\n')

  // A second operator command while one holds the data-dir lock.
  const release = await lockDataDir(ctx.modDir)
  const locked = cli(['mod', 'apply', '--server', srv.origin, '--seeder', SEEDER, '--yes', '--data', ctx.modDir])
  release()
  t.is(locked.status, 1)
  t.is(locked.stderr, 'erro: outra operação de moderação em andamento\n')
  t.is(srv.requests.length, 0, 'no request reached the server')
})

test('without a terminal and without --yes nothing is pulled or signed', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'unblock', member: X, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: first } }
  const child = cli(['mod', 'apply', '--server', srv.origin, '--seeder', SEEDER, '--data', ctx.modDir])
  t.is(child.status, 1)
  t.is(child.stderr, 'erro: rode num terminal para revisar, ou use --yes para aplicar só os bloqueios\n')
  t.is(child.stdout, '')
  const pub = publisher(true)
  const res = await run(ctx, srv, pub.publish, { interactive: false })
  t.is(res.error && res.error.message, 'rode num terminal para revisar, ou use --yes para aplicar só os bloqueios')
  t.alike(res.asked, [])
  t.is(srv.requests.length, 0, 'no request reached the server')
  t.is(pub.calls.length, 0)
  t.is(readList(ctx.modDir).signature, first.signature)
})

test('at a terminal the changes are shown and signed only on s or sim', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const logBefore = fs.readFileSync(path.join(ctx.modDir, 'moderation.jsonl'))
  const srv = await fakeServer(t)
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: A, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: first } }
  const pub = publisher(true)
  for (const answer of ['n', '', 'yes', 'ss', 'não']) {
    const res = await run(ctx, srv, pub.publish, {}, [answer])
    t.is(res.error && res.error.message, 'nada assinado', JSON.stringify(answer) + ' refuses')
    t.alike(res.lines, ['bloquear ' + A], 'the change is shown before the question')
    t.alike(res.asked, [CONFIRM])
  }
  t.is(readList(ctx.modDir).signature, first.signature, 'nothing signed')
  t.alike(fs.readFileSync(path.join(ctx.modDir, 'moderation.jsonl')), logBefore, 'nothing logged')
  t.is(pub.calls.length, 0, 'nothing published')
  t.is(srv.byPath('/account/mod/api/ack').length, 0, 'nothing acked')

  const res = await run(ctx, srv, pub.publish, {}, [' SIM '])
  t.is(res.error, null, res.error && res.error.message)
  t.alike(res.lines, ['bloquear ' + A, 'aplicado: seq 2, 2 chaves bloqueadas'])
  t.is(readList(ctx.modDir).seq, 2)
  t.is(pub.calls.length, 1)
  t.alike(srv.byPath('/account/mod/api/ack')[0].body.changeIds, ['c1'])
})

test('--yes applies blocks and holds unblocks; the next run at a terminal applies them', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  const pub = publisher(true)
  // A is blocked through the panel (source painel).
  srv.pull = { changes: [{ id: 'c0', op: 'block', member: A, at: '2026-10-24T10:00:00.000Z' }], published: { snapshot: first } }
  const yesBlock = await run(ctx, srv, pub.publish, { yes: true })
  t.is(yesBlock.error, null, yesBlock.error && yesBlock.error.message)
  t.alike(yesBlock.asked, [], '--yes never asks')
  t.alike(yesBlock.lines, ['bloquear ' + A, 'aplicado: seq 2, 2 chaves bloqueadas'])
  const second = readList(ctx.modDir)

  const held = [
    { id: 'c2', op: 'unblock', member: X, at: '2026-10-24T10:00:02.000Z' },
    { id: 'c3', op: 'unblock', member: A, at: '2026-10-24T10:00:03.000Z' }
  ]
  srv.pull = { changes: [{ id: 'c1', op: 'block', member: B, at: '2026-10-24T10:00:01.000Z' }, ...held], published: { snapshot: second } }
  const res = await run(ctx, srv, pub.publish, { yes: true })
  t.is(res.error, null, res.error && res.error.message)
  t.alike(res.asked, [])
  t.alike(res.lines, [
    'bloquear ' + B,
    'desbloquear ' + X + MARK,
    'desbloquear ' + A,
    'desbloqueios aguardando revisão no terminal: 2',
    'aplicado: seq 3, 3 chaves bloqueadas'
  ])
  const third = readList(ctx.modDir)
  t.alike(third.blocked, [A, B, X].sort(), 'only the block was signed')
  t.is(pub.calls[pub.calls.length - 1].signature, third.signature)
  let acks = srv.byPath('/account/mod/api/ack')
  t.alike(acks[acks.length - 1].body.changeIds, ['c1'], 'held ids are not acked')
  t.alike(logLines(ctx.modDir).filter((l) => l.seq === 3).map((l) => [l.op, l.member, l.source]), [['block', B, 'painel']])

  // Only held unblocks left: --yes signs and acks nothing.
  srv.pull = { changes: held, published: { snapshot: third } }
  const idle = await run(ctx, srv, pub.publish, { yes: true })
  t.is(idle.error, null, idle.error && idle.error.message)
  t.alike(idle.lines, ['desbloquear ' + X + MARK, 'desbloquear ' + A, 'desbloqueios aguardando revisão no terminal: 2', 'nada a aplicar'])
  t.is(readList(ctx.modDir).seq, 3)
  t.is(srv.byPath('/account/mod/api/ack').length, acks.length)

  // At a terminal the held changes are applied.
  const later = await run(ctx, srv, pub.publish)
  t.is(later.error, null, later.error && later.error.message)
  t.alike(later.asked, [CONFIRM, CONFIRM_OPERATOR])
  t.alike(later.lines, ['desbloquear ' + X + MARK, 'desbloquear ' + A, 'aplicado: seq 4, 1 chaves bloqueadas'])
  t.alike(readList(ctx.modDir).blocked, [B])
  acks = srv.byPath('/account/mod/api/ack')
  t.alike(acks[acks.length - 1].body.changeIds, ['c2', 'c3'])

  // --json reports how many unblocks were held.
  srv.pull = { changes: [{ id: 'c4', op: 'unblock', member: B, at: '2026-10-24T10:00:04.000Z' }], published: { snapshot: readList(ctx.modDir) } }
  const json = await run(ctx, srv, pub.publish, { yes: true, json: true })
  t.is(json.error, null, json.error && json.error.message)
  t.is(json.lines.length, 1)
  const out = JSON.parse(json.lines[0])
  t.is(out.outcome, 'nada')
  t.is(out.held, 1)
})

test('--yes refuses more than MAX_UNATTENDED_BLOCKS new blocks', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  const srv = await fakeServer(t)
  const pub = publisher(true)
  const many = (n) => new Array(n).fill(0).map((_, i) => ({ id: 'b' + i, op: 'block', member: (i + 1).toString(16).padStart(64, '0'), at: '2026-10-24T10:00:01.000Z' }))
  t.is(MAX_UNATTENDED_BLOCKS, 100)
  srv.pull = { changes: many(101), published: { snapshot: first } }
  const over = await run(ctx, srv, pub.publish, { yes: true })
  t.is(over.error && over.error.message, 'muitos bloqueios de uma vez; rode no terminal para revisar')
  t.is(readList(ctx.modDir).signature, first.signature, 'nothing signed')
  t.is(pub.calls.length, 0)
  t.is(srv.byPath('/account/mod/api/ack').length, 0)

  // 100 new blocks pass; a block of a key already in the list is not new.
  srv.pull = { changes: [...many(100), { id: 'bx', op: 'block', member: X, at: '2026-10-24T10:00:02.000Z' }], published: { snapshot: first } }
  const cap = await run(ctx, srv, pub.publish, { yes: true })
  t.is(cap.error, null, cap.error && cap.error.message)
  t.is(readList(ctx.modDir).blocked.length, 101)
  t.is(srv.byPath('/account/mod/api/ack')[0].body.changeIds.length, 101)
})

test('an unblock of a key the operator blocked needs a second confirmation', async (t) => {
  await testnet(t)
  const ctx = setup(t)
  const first = seedList(t, ctx.modDir, X)
  // A line written before the source field existed reads as 'operacao'.
  const logFile = path.join(ctx.modDir, 'moderation.jsonl')
  const legacy = logLines(ctx.modDir).map(({ source, ...rest }) => JSON.stringify(rest) + '\n').join('')
  fs.writeFileSync(logFile, legacy, { mode: 0o600 })
  t.absent('source' in logLines(ctx.modDir)[0])
  const srv = await fakeServer(t)
  const pub = publisher(true)
  srv.pull = { changes: [{ id: 'c0', op: 'block', member: A, at: '2026-10-24T10:00:00.000Z' }], published: { snapshot: first } }
  t.is((await run(ctx, srv, pub.publish)).error, null)
  const second = readList(ctx.modDir)

  srv.pull = {
    changes: [
      { id: 'c1', op: 'unblock', member: X, at: '2026-10-24T10:00:01.000Z' },
      { id: 'c2', op: 'unblock', member: A, at: '2026-10-24T10:00:02.000Z' },
      { id: 'c3', op: 'block', member: B, at: '2026-10-24T10:00:03.000Z' }
    ],
    published: { snapshot: second }
  }
  const res = await run(ctx, srv, pub.publish, {}, ['s', 'n'])
  t.is(res.error, null, res.error && res.error.message)
  t.alike(res.asked, [CONFIRM, CONFIRM_OPERATOR])
  t.alike(res.lines, [
    'desbloquear ' + X + MARK,
    'desbloquear ' + A,
    'bloquear ' + B,
    'desbloqueios aguardando revisão no terminal: 1',
    'aplicado: seq 3, 2 chaves bloqueadas'
  ])
  t.alike(readList(ctx.modDir).blocked, [B, X].sort(), 'X stays blocked, A is unblocked')
  const acks = srv.byPath('/account/mod/api/ack')
  t.alike(acks[acks.length - 1].body.changeIds.slice().sort(), ['c2', 'c3'], 'the change of X is held')

  // Refusing the first question signs nothing, whatever the second would be.
  srv.pull = { changes: [{ id: 'c1', op: 'unblock', member: X, at: '2026-10-24T10:00:01.000Z' }], published: { snapshot: readList(ctx.modDir) } }
  const refused = await run(ctx, srv, pub.publish, {}, ['n'])
  t.is(refused.error && refused.error.message, 'nada assinado')
  t.alike(refused.asked, [CONFIRM])
  t.is(readList(ctx.modDir).seq, 3)
})
