'use strict'

// End to end, loopback only: the AI report triage from a signed report to a
// block the seeder enforces. The pieces: an association and a moderation key
// set up with the real CLI (`assoc init`, `mod init`, `assoc
// certify-moderator`, `mod cert add`, a local B2 list blocking an unrelated
// key Zed so the first apply needs no --new-list), the real Seeder
// in-process with startSeedWs({ triageToken }) serving the token-gated
// GET /moderation-post route, two real member diaries admitted by it (the
// spammer S and an ordinary member L), the account service in-process on a
// reserved loopback port with the panel and the triage worker wired in
// (createAccountServer({ triage })), the real createPostReader against the
// seeder route, the real exemplar store and ledger, and the deterministic
// fake embedder of test/helpers/fake-embed.js instead of MiniLM. The worker
// runs in mode 'auto' with a test-only judgeOpts.minPerLabel = 2; the human
// precedents are seeded straight into exemplars.json (five block
// precedents from five distinct diaries, K = 5, near copies of S's post;
// two unrelated discard precedents), so no dozens of diaries are needed.
// Reports are real: signed by linked members and sent to POST
// /account/report; panel actions go through the real panel routes after a
// Google sign-in against a loopback fake.
// What is proven here: (a) a spam post near the block precedents is
// decided by 'ia' (pending change byAi, panel actor 'ia' and the verified
// post text); `mod apply --yes` (the operator's cron) publishes the five
// human precedent blocks but holds the AI block of S, marked ' (ia)', pending
// for a terminal (an AI block can be poisoned: no cron publishes a block
// nobody read); the operator's interactive apply (mod-apply.js in-process
// with a scripted 's', as test/moderation-e2e.test.js drives it) then
// publishes it and the seeder blocks S; (b) an 'ilegal' report and a report on a post with a
// photo stay 'aberta'; (c) a Pendentes cancel of a human block withdraws
// that report's precedent; (d) a report read by the worker and then
// decided by a moderator becomes a precedent.
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { Seeder } = require('@varanda/core/lib/seeder')
const { readBlocklist, lockDataDir } = require('@varanda/core/lib/store')
const assocLib = require('@varanda/core/lib/assoc')
const { signReport, digest } = require('@varanda/core/lib/report')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord } = require('@varanda/core/lib/records')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { makeEmbed, fakeEmbed } = require('./helpers/fake-embed')
const { createGoogle } = require('../lib/account/google')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore, AI_ACTOR } = require('../lib/account/moderation-store')
const { createAccountServer } = require('../lib/account/server')
const { createGroupCheck } = require('../lib/account/group-check')
const { SESSION_COOKIE, LOGIN_COOKIE } = require('../lib/account/mod-routes')
const { createPostReader } = require('../lib/account/ai/read-post')
const { openExemplarStore } = require('../lib/account/ai/exemplar-store')
const { openLedger } = require('../lib/account/ai/ledger')
const { createWorker } = require('../lib/account/ai/worker')
const { quantize } = require('../lib/account/ai/triage')
const { startSeedWs } = require('../lib/seed-ws')
const modApply = require('../lib/mod-apply')
const modPublish = require('../lib/mod-publish')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const CLIENT_ID = 'client-ai-e2e.apps.googleusercontent.com'
const CLIENT_SECRET = 'segredo-ai-e2e'
const TRIAGE_TOKEN = 'a5'.repeat(32)
const MODEL = 'fake-embed'
const WAIT = { timeoutMs: 45000 }
const MODERATOR = { sub: '2598765432109876543215', email: 'moderadora-ia-e2e@example.test' }
const SPAM = 'compre seguidores baratos agora mesmo no nosso site promocional e ganhe dinheiro facil hoje'
const BOLO = 'hoje fiz um bolo de cenoura com cobertura de chocolate para a familia'
const ILEGAL = 'texto que alguem denunciou como crime e que so uma pessoa pode avaliar'
const FOTO = 'olha a foto do meu jardim florido nesta primavera tao bonita'
const BICICLETA = 'vendo bicicleta usada em bom estado aceito trocas chamar no privado'
const DESC = { core: 'dd'.repeat(32), mime: 'image/png', start: 1, blocks: 1, bytes: 10, sha256: 'ee'.repeat(32), width: 4, height: 4 }

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function cli (args) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60000 })
}

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

// A fake Google on 127.0.0.1 that always signs in the moderator.
async function fakeGoogle (t) {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      if (pathname === '/token') {
        const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: MODERATOR.sub, exp: Math.floor(Date.now() / 1000) + 3600 }
        return json(res, 200, { access_token: 'ya29.ia', token_type: 'Bearer', expires_in: 3599, id_token: b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(claims) + '.c2ln' })
      }
      if (pathname === '/userinfo') return json(res, 200, { sub: MODERATOR.sub, email: MODERATOR.email, email_verified: true })
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }), { force: true })
  return { authUrl: base + '/auth', tokenUrl: base + '/token', userinfoUrl: base + '/userinfo' }
}

// A member on the swarm whose diary holds an association certificate and
// the posts `posts` (seq 1, 2, ...); admitted by the seeder before return.
async function memberDiary (t, bootstrap, association, assocDir, seeder, posts) {
  const store = new Corestore(tmpDir(t, 'varanda-ai-client-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const cert = assocLib.issueCertificate(assocDir, { member: key })
  await diary.append(memberCertRecord(cert))
  for (const p of posts) await diary.append(postRecord({ ...p, at: '2026-10-20T12:00:00.000Z' }))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  await joinAndFlush(swarm, [topicFor(association)])
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { ...WAIT, name: 'hello do semeador' })
  peer.send({ type: 'announce', key, cert })
  await until(() => messages.find((x) => x.type === 'have' && x.key === key && x.length === diary.length), { ...WAIT, name: 'have ' + diary.length })
  await until(() => {
    const entry = seeder._served.get(key)
    return entry && entry.gated && entry.core.contiguousLength === diary.length
  }, { ...WAIT, name: 'diário local e aprovado' })
  return { key, diary }
}

function keys () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function linkDirect (accounts, iss, m, username, sub, email) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

function cookieFrom (res, name) {
  for (const line of res.headers.getSetCookie()) {
    const m = new RegExp('^' + name + '=([^;]*);').exec(line)
    if (m) return m[1]
  }
  return null
}

function reportId () {
  return nodeCrypto.randomBytes(16).toString('base64url')
}

test('e2e: AI triage decides a spam block that mod apply publishes; illegal and photo reports stay open; cancel and learning', async (t) => {
  t.timeout(175000)
  const { bootstrap } = await testnet(t)
  const flags = bootstrapFlags(bootstrap)
  const root = tmpDir(t, 'varanda-aie2e-')

  // ---- association and moderation key: the operator's ceremony ----
  const assocDir = path.join(root, 'assoc')
  const init = cli(['assoc', 'init', '--data', assocDir])
  t.is(init.status, 0, init.stderr)
  const association = /([0-9a-f]{64})/.exec(init.stdout)[1]
  const modDir = path.join(root, 'mod')
  const modInit = cli(['mod', 'init', '--association', association, '--data', modDir])
  t.is(modInit.status, 0, modInit.stderr)
  const moderatorKey = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(modInit.stdout)[1]
  const modCertFile = path.join(root, 'moderator-cert.json')
  t.is(cli(['assoc', 'certify-moderator', '--moderator', moderatorKey, '--out', modCertFile, '--data', assocDir]).status, 0)
  t.is(cli(['mod', 'cert', 'add', '--cert-file', modCertFile, '--data', modDir]).status, 0)
  const zed = hex(crypto.keyPair().publicKey)
  t.is(cli(['mod', 'block', zed, '--new-list', '--no-publish', '--data', modDir]).status, 0, 'Zed blocked locally at seq 1')

  // ---- the seeder, with the token-gated post route the reader uses ----
  const seedDir = path.join(root, 'seed')
  Seeder.ensureConfig(seedDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seedDir)
  const seederCertFile = path.join(root, 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(assocLib.issueSeederCertificate(assocDir, { seeder: seederKey })))
  Seeder.addCert(seedDir, seederCertFile, association)
  const seeder = new Seeder({ dataDir: seedDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  // Both services read the same VARANDA_TRIAGE_TOKEN in production.
  const ws = await startSeedWs({ host: '127.0.0.1', port: 0, seeder, triageToken: TRIAGE_TOKEN, post: { rate: 1000, burst: 1000 } })
  t.teardown(() => ws.close(), { force: true })
  await seeder.start()

  // ---- two member diaries, admitted ----
  const S = await memberDiary(t, bootstrap, association, assocDir, seeder, [{ text: SPAM }])
  const L = await memberDiary(t, bootstrap, association, assocDir, seeder, [{ text: BOLO }, { text: ILEGAL }, { text: FOTO, media: [DESC] }, { text: BICICLETA }])
  t.ok(seeder.admittedKeys().includes(S.key) && seeder.admittedKeys().includes(L.key), 'S and L admitted')

  // ---- the account service: directory, desk, worker ----
  const accountDir = path.join(root, 'account')
  const issuerKp = crypto.keyPair()
  const iss = { keyPair: issuerKp, cert: assocLib.issueIssuerCertificate(assocDir, { issuer: hex(issuerKp.publicKey) }), association }
  const accounts = openAccountStore(accountDir)
  const moderation = openModerationStore(accountDir, { association })
  const reporters = [keys(), keys(), keys()]
  for (let i = 0; i < reporters.length; i++) await linkDirect(accounts, iss, reporters[i], 'rep' + i, '26' + String(i).repeat(20), 'rep' + i + '@example.test')
  const mara = keys()
  await linkDirect(accounts, iss, mara, 'mara', MODERATOR.sub, MODERATOR.email)

  // The human precedents, seeded straight into exemplars.json: five blocks
  // from five distinct diaries (near copies of S's post) and two unrelated
  // dismissals, every vector the fake embedder's for its own text.
  // Each block precedent also gets a real human block in the desk, as in
  // production: the worker prunes block precedents whose block no longer
  // stands (a cancel or unblock it never heard about).
  const exemplars = openExemplarStore(accountDir, { model: MODEL })
  const precedentReporter = hex(crypto.keyPair().publicKey)
  const precedent = async (text, decision) => {
    const target = hex(crypto.keyPair().publicKey)
    let id = reportId()
    if (decision === 'bloquear') {
      const { report } = await moderation.add({
        reporter: precedentReporter,
        target,
        seq: 1,
        reason: 'spam',
        signature: 'ab'.repeat(64),
        nonce: require('node:crypto').randomBytes(32).toString('base64url')
      })
      await moderation.decide(report.id, { decision: 'bloquear', by: MODERATOR.email })
      id = report.id
    }
    exemplars.add({
      reportId: id,
      target,
      seq: 1,
      reason: 'spam',
      decision,
      contentHash: digest(text),
      text,
      hasMedia: false,
      embedding: quantize(fakeEmbed(text))
    })
  }
  for (let i = 1; i <= 5; i++) await precedent(SPAM + ' oferta' + i, 'bloquear')
  await precedent('adorei o passeio no parque com as criancas ontem a tarde', 'descartar')
  await precedent('alguem sabe um bom livro de ficcao cientifica para indicar', 'descartar')
  t.is(exemplars.size(), 7)

  const ledger = openLedger(accountDir)
  const reader = createPostReader({ baseUrl: 'http://127.0.0.1:' + ws.port, token: TRIAGE_TOKEN, association, revokedIssuers: () => new Set() })
  const embed = makeEmbed()
  const logs = []
  const log = (e) => logs.push(JSON.stringify(e))
  const worker = createWorker({
    mode: 'auto',
    moderation,
    exemplars,
    ledger,
    readPost: (args) => reader.read(args),
    embed,
    log,
    modelId: MODEL,
    judgeOpts: { minPerLabel: 2 }
  })
  t.teardown(() => worker.stop(), { force: true })

  const port = await reservePort()
  const ORIGIN = 'http://127.0.0.1:' + port
  const endpoints = await fakeGoogle(t)
  const googleFor = (p) => createGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: ORIGIN + p, endpoints })
  const server = createAccountServer({
    // The same seeder confirms that an unlinked reported key is a served
    // diary before a person's Bloquear (it serves the reported diaries).
    groupCheck: createGroupCheck({ baseUrl: 'http://127.0.0.1:' + ws.port, token: TRIAGE_TOKEN }),
    association,
    origin: ORIGIN,
    google: googleFor('/account/callback'),
    store: accounts,
    issuer: null,
    log,
    moderation,
    googleMod: googleFor('/account/mod/callback'),
    modEmails: [MODERATOR.email],
    triage: worker
  })
  const listener = await server.listen({ host: '127.0.0.1', port })
  t.teardown(() => listener.close(), { force: true })
  worker.start()

  async function api (method, pathname, { body, cookie } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = cookie
    if (body !== undefined) {
      init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(ORIGIN + pathname, init)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  async function report (reporter, target, seq, reason) {
    const nonce = (await api('POST', '/account/report/start', { body: { member: reporter.hex } })).body.nonce
    const fields = { nonce, member: reporter.hex, association, target, seq, reason, text: 'comentário de quem denuncia', quote: '' }
    const r = await api('POST', '/account/report', { body: { member: reporter.hex, nonce, target, seq, reason, text: fields.text, quote: '', signature: signReport(fields, reporter.kp) } })
    t.is(r.status, 200, 'report ' + reason + ': ' + r.text)
    t.is(r.body.duplicate, false)
    return r.body.id
  }

  const login = await api('GET', '/account/mod/login')
  const state = new URL(login.headers.get('location')).searchParams.get('state')
  const cb = await api('GET', '/account/mod/callback?state=' + state + '&code=codigo-ia', { cookie: LOGIN_COOKIE + '=' + cookieFrom(login, LOGIN_COOKIE) })
  t.is(cb.headers.get('location'), ORIGIN + '/account/mod/', 'the moderator is signed in')
  const cookie = SESSION_COOKIE + '=' + cookieFrom(cb, SESSION_COOKIE)
  const panelRow = async (estado, id) => (await api('GET', '/account/mod/api/reports?estado=' + estado, { cookie })).body.reports.find((r) => r.id === id) || null

  // ---- (a) the spam post: decided by the AI ----
  const spamId = await report(reporters[0], S.key, 1, 'spam')
  await until(() => {
    const row = moderation.get(spamId)
    return row.status === 'bloquear' && row.decidedBy === AI_ACTOR
  }, { ...WAIT, name: 'IA bloqueia a publicação de S' })
  t.pass('the worker decided the spam report as ia')
  t.ok(embed.calls.includes(SPAM), 'the verified post text was embedded')
  t.absent(embed.calls.includes('comentário de quem denuncia'), 'never the reporter\'s words')
  const aiRow = await panelRow('decidida', spamId)
  t.is(aiRow.actor, 'ia')
  t.is(aiRow.ia.sugestao, 'bloquear')
  t.is(aiRow.ia.modo, 'auto')
  t.alike(aiRow.publicacao, { texto: SPAM, midia: false, citacao: false }, 'the panel shows the post the seeder holds')
  const blocked = await api('GET', '/account/mod/api/blocked', { cookie })
  const aiChange = blocked.body.pending.find((c) => c.member === S.key)
  t.ok(aiChange, 'a pending block of S')
  t.is(aiChange.byAi, true)
  t.absent(blocked.text.includes('@'), 'no e-mail in Pendentes')

  // ---- (b) an illegal report and a photo post stay with a human ----
  const ilegalId = await report(reporters[1], L.key, 2, 'ilegal')
  const fotoId = await report(reporters[1], L.key, 3, 'spam')
  const ilegalRow = await until(async () => {
    const r = await panelRow('aberta', ilegalId)
    return r && r.ia !== null ? r : null
  }, { ...WAIT, name: 'denúncia ilegal triada' })
  t.is(ilegalRow.ia.motivo, 'ilegal')
  t.is(ilegalRow.ia.sugestao, null)
  t.is(ilegalRow.actor, null)
  const fotoRow = await until(async () => {
    const r = await panelRow('aberta', fotoId)
    return r && r.ia !== null ? r : null
  }, { ...WAIT, name: 'denúncia com foto triada' })
  t.is(fotoRow.ia.motivo, 'midia')
  t.is(fotoRow.publicacao.midia, true, 'the reader saw the photo descriptor')
  t.is(fotoRow.publicacao.texto, FOTO)
  t.is(moderation.get(ilegalId).status, 'aberta')
  t.is(moderation.get(fotoId).status, 'aberta')

  // ---- (d) learning: read by the worker, decided by a moderator ----
  const boloId = await report(reporters[2], L.key, 1, 'spam')
  const boloRow = await until(async () => {
    const r = await panelRow('aberta', boloId)
    return r && r.ia !== null && r.publicacao !== null ? r : null
  }, { ...WAIT, name: 'leitura em cache' })
  t.is(boloRow.publicacao.texto, BOLO)
  t.is(boloRow.ia.sugestao, null, 'nothing like it in the bank: the AI abstains')
  t.is(moderation.get(boloId).status, 'aberta')
  const discarded = await api('POST', '/account/mod/api/reports/' + boloId + '/decide', { cookie, body: { decision: 'descartar', note: '' } })
  t.is(discarded.status, 200, discarded.text)
  t.is(discarded.body.report.actor, 'pessoa')
  const learned = await until(() => exemplars.list().find((e) => e.reportId === boloId), { ...WAIT, name: 'precedente aprendido' })
  t.is(learned.decision, 'descartar')
  t.is(learned.text, BOLO, 'the text the moderator saw')
  t.is(learned.target, L.key)

  // ---- (c) a Pendentes cancel of a human block withdraws its precedent ----
  const bikeId = await report(reporters[2], L.key, 4, 'spam')
  await until(async () => {
    const r = await panelRow('aberta', bikeId)
    return r && r.ia !== null && r.publicacao !== null
  }, { ...WAIT, name: 'leitura em cache (bicicleta)' })
  const humanBlock = await api('POST', '/account/mod/api/reports/' + bikeId + '/decide', { cookie, body: { decision: 'bloquear', note: '' } })
  t.is(humanBlock.status, 200, humanBlock.text)
  t.is(humanBlock.body.change.byAi, false)
  await until(() => exemplars.list().some((e) => e.reportId === bikeId), { ...WAIT, name: 'precedente de bloqueio' })
  const cancel = await api('POST', '/account/mod/api/pending/' + humanBlock.body.change.id + '/cancel', { cookie, body: {} })
  t.is(cancel.status, 200, cancel.text)
  await until(() => !exemplars.list().some((e) => e.reportId === bikeId), { ...WAIT, name: 'precedente retirado' })
  t.pass('the cancelled block is no longer a precedent')
  t.ok(exemplars.list().some((e) => e.reportId === boloId), 'the other precedent stays')

  // ---- mod apply --yes holds the AI block; only a terminal publishes it ----
  const pendingNow = moderation.pending().changes
  // Pending: the AI block of S plus the five human blocks behind the seeded
  // precedents; exactly one is the AI's.
  t.alike(pendingNow.filter((c) => c.by === AI_ACTOR).map((c) => c.member), [S.key], 'one AI block pending, for S')
  t.is(pendingNow.length, 6, 'and the five precedent blocks')
  const applied = await cliAsync(t, ['mod', 'apply', '--server', ORIGIN, '--data', modDir, '--seeder', seederKey, '--timeout-ms', '30000', '--yes', ...flags])
  t.is(applied.status, 0, applied.stderr)
  t.ok(applied.stdout.includes('bloquear ' + S.key + ' (ia) — aguarda revisão no terminal\n'), '--yes holds the AI block, marked')
  t.ok(applied.stdout.includes('aplicado: seq 2, 6 chaves bloqueadas'), 'seq 2: Zed and the five human blocks')
  const seq2 = readBlocklist(seedDir)
  t.is(seq2 && seq2.snapshot.seq, 2, 'the seeder holds seq 2 (delivered before the exit)')
  t.absent(seq2.snapshot.blocked.includes(S.key), 'seq 2 does not block S')
  t.absent(seeder._isBlocked(S.key), 'the seeder does not block S')
  t.alike(moderation.pending().changes.map((c) => [c.member, c.by]), [[S.key, AI_ACTOR]], 'only the AI block stays pending')

  // The operator at a terminal: mod-apply.js apply() in-process as
  // commands/mod.js runs it (the data-dir lock held throughout), the review
  // answered 's'.
  const lines = []
  const asked = []
  const release = await lockDataDir(modDir)
  let status
  try {
    status = await modApply.apply({
      dir: modDir,
      association,
      server: ORIGIN,
      yes: false,
      interactive: true,
      ask: async (q) => { asked.push(q); return 's' },
      publish: (s) => modPublish.publish({ snapshot: s, association, seeder: seederKey, bootstrap, host: '127.0.0.1', timeoutMs: 30000 }),
      print: (line) => lines.push(line)
    })
  } finally {
    release()
  }
  t.is(status, 0)
  t.is(asked.length, 1, 'one confirmation')
  t.alike(lines, ['bloquear ' + S.key + ' (ia)', 'aplicado: seq 3, 7 chaves bloqueadas'], 'the review marks the AI block')
  await until(() => seeder._isBlocked(S.key), { ...WAIT, name: 'semeador bloqueia S' })
  t.pass('the seeder enforces the AI block')
  t.absent(seeder._isBlocked(L.key), 'L is not blocked')
  t.alike(moderation.pending().changes, [], 'Pendentes is empty after the ack')

  const text = logs.join('\n')
  t.absent(text.includes('@'), 'logs: no e-mail')
  for (const s of [SPAM, BOLO, ILEGAL, FOTO, BICICLETA, TRIAGE_TOKEN]) t.absent(text.includes(s), 'logs: no post text or token')
  t.absent(applied.stdout.includes('@'), 'mod apply: no e-mail')
  t.absent(lines.join('\n').includes('@'), 'mod apply at the terminal: no e-mail')
})
