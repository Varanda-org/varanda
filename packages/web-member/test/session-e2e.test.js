// End to end, loopback only: the browser node session (Hypercore 10, memory
// storage, the RPC client wired in memory as the app wires it) and a CLI
// member (the varanda binary, Hypercore 11) exchange posts and a reply
// through a CLI seeder (`seed --ws-port`) and nothing else: the web session
// reaches the seeder only over its WebSocket entry, the CLI member only over
// the local DHT.
const test = require('brittle')
const { FEED_LIMIT_MAX } = require('@varanda/rpc')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, bootstrapFlags } = require('./helpers/net')
const { connectClient, stoppedOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, loadAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { WebSocketServer, createWebSocketStream } = require('ws')
const { localSwarmOptions } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { testimonialRecord, testimonialShowRecord } = require('@varanda/core/lib/records')
const { sealOffer } = require('@varanda/core/lib/testimonials')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const net = require('node:net')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { deletedSeqs, clearDeleted } = require('@varanda/core/lib/deletion')

const BIN = path.join(__dirname, '../../../apps/cli/bin/varanda.js')
const WEB_TEXT = 'olá do navegador (sessão web)'
const CLI_TEXT = 'olá do terminal (membro CLI)'
const REPLY_TEXT = 'resposta do navegador'

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

function last (proc) {
  const lines = jsonLines(proc.stdout)
  return lines[lines.length - 1]
}

// The CLI as a child process, with the loopback testnet flags; killed in teardown.
function varanda (t, bootstrap, args) {
  const child = spawn(process.execPath, [BIN, ...args, ...bootstrapFlags(bootstrap)], { env })
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

async function run (t, bootstrap, args) {
  const proc = await varanda(t, bootstrap, args).exited
  t.is(proc.code, 0, args.slice(0, 2).join(' ') + ' ' + proc.stderr)
  return last(proc)
}

test('the web session and a CLI member exchange posts through the seeder', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)

  // The association, created by the CLI; its key pair signs every cert.
  const assocDir = tmpDir(t, 'varanda-wse-assoc-')
  const association = (await run(t, bootstrap, ['assoc', 'init', '--data', assocDir, '--json'])).publicKey
  const assocKp = loadAssociationKeyPair(path.join(assocDir, 'association.json'))

  // The seeder: the CLI binary with its WebSocket entry on a system port.
  const seederDir = tmpDir(t, 'varanda-wse-seed-')
  Seeder.ensureConfig(seederDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seederDir)
  const seederCertFile = path.join(tmpDir(t, 'varanda-wse-sc-'), 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(createSeederCert({ seeder: seederKey }, assocKp)))
  Seeder.addCert(seederDir, seederCertFile, association)
  const seed = varanda(t, bootstrap, ['seed', '--data', seederDir, '--ws-port', '0', '--json'])
  const wsEvent = await until(() => jsonLines(seed.stdout).find((e) => e.event === 'ws'), { name: 'ws do semeador', timeoutMs: 30000 })
  await until(() => jsonLines(seed.stdout).some((e) => e.event === 'ready'), { name: 'semeador pronto', timeoutMs: 30000 })
  const seederUrl = 'ws://127.0.0.1:' + wsEvent.port + '/seeder'

  // The web node, its client in memory, its identity key handed to it as the
  // page does after the passkey. The write gate is off: the explicit once
  // runs below are the point of this test (passkey-e2e.test.js covers it).
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association,
    seederUrl,
    createSocket: (url) => new WebSocket(url),
    onInternalError: (err) => internal.push(err),
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })

  const { publicKey: webKey } = await web.request('identity.create')
  t.alike(await web.request('cert.add', { cert: createCert({ member: webKey }, assocKp) }), { seq: 0 })
  t.is((await web.request('profile.set', { name: 'Bia', bio: 'no navegador' })).seq, 1)
  const webPost = await web.request('post.create', { text: WEB_TEXT })
  t.alike(webPost, { seq: 2, ref: webKey + ':2' })

  // First run: the seeder admits and holds the web diary.
  const first = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped1 = await stoppedOf(web.events, first.runId)
  if (stopped1.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped1.reason, 'done', 'first web run done')
  t.is(stopped1.result.ok, true)
  t.is(stopped1.result.admitted, true, 'admitted by the seeder')
  t.is(stopped1.result.seederConfirmed, true, 'the seeder holds the whole diary')
  t.is(stopped1.result.seeders, 1)
  const lines1 = web.events.filter((e) => e.name === 'sync.event' && e.data.runId === first.runId).map((e) => e.data.line)
  t.ok(lines1.includes('sync ready'), 'sync ready line')
  t.ok(lines1.some((l) => l === 'peer seeder ' + seederKey.slice(0, 8)), 'verified seeder line')
  t.ok(lines1.some((l) => l.startsWith('admitted ' + webKey)), 'admitted line')

  // The CLI member: identity, certificate, a post; follows the web key.
  const memberDir = tmpDir(t, 'varanda-wse-member-')
  const cliKey = (await run(t, bootstrap, ['id', 'create', '--data', memberDir, '--association', association, '--json'])).publicKey
  const certFile = path.join(tmpDir(t, 'varanda-wse-mc-'), 'member-cert.json')
  await run(t, bootstrap, ['assoc', 'certify', '--data', assocDir, '--member', cliKey, '--age-band', '18+', '--method', 'stub', '--out', certFile, '--json'])
  await run(t, bootstrap, ['cert', 'add', '--data', memberDir, '--cert-file', certFile, '--json'])
  await run(t, bootstrap, ['profile', 'set', '--data', memberDir, '--name', 'Caio', '--json'])
  const cliPost = await run(t, bootstrap, ['post', '--data', memberDir, '--text', CLI_TEXT, '--json'])
  await run(t, bootstrap, ['follow', '--data', memberDir, '--author', webKey, '--json'])
  const cliSync = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json']).exited
  const cliLines = jsonLines(cliSync.stdout)
  const cliResult = cliLines[cliLines.length - 1]
  if (cliSync.code !== 0) t.comment('cli sync: ' + cliSync.stdout + cliSync.stderr)
  t.is(cliSync.code, 0, 'CLI sync --once exits 0')
  t.is(cliResult.downloaded[webKey], 3, 'the CLI member downloaded the whole web diary')
  t.is(cliResult.admitted, true, 'the CLI diary is admitted too')
  const cliFeed = await run(t, bootstrap, ['feed', '--data', memberDir, '--json'])
  t.ok(cliFeed.items.some((i) => i.author === webKey && i.text === WEB_TEXT && i.name === 'Bia'), 'the CLI feed has the web post')

  // The web session follows the CLI member (local-first: the answer is
  // immediate and the unlocked session drains the change into its own diary
  // as a `follow` record before the next request runs) and reads it from
  // the seeder.
  t.alike(await web.request('follow.add', { key: cliKey }), { changed: true, followCount: 1 })
  // The drain appends that one signed `on: true` record.
  const ownLog = await web.request('log.read', {})
  t.alike(ownLog.entries.map((e) => e.seq), [0, 1, 2, 3], 'the drain appended the record')
  t.alike(ownLog.entries.slice(3).map((e) => [e.record.type, e.record.key, e.record.on]), [['follow', cliKey, true]], 'the web session\'s follow reached its diary')
  const second = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped2 = await stoppedOf(web.events, second.runId)
  if (stopped2.reason !== 'done') t.comment(JSON.stringify(web.events))
  t.is(stopped2.reason, 'done', 'second web run done')
  t.is(stopped2.result.ok, true)
  t.is(stopped2.result.seederConfirmed, true, 'the seeder holds the follow record too')
  // The CLI diary: certificate, profile, post, and the `follow` record its
  // follow command appended.
  t.is(stopped2.result.downloaded[cliKey], 4, 'the web session downloaded the CLI diary')
  t.alike(stopped2.result.skipped, [])
  const feed = await web.request('feed.read', { limit: FEED_LIMIT_MAX })
  const cliItem = feed.items.find((i) => i.author === cliKey)
  t.ok(cliItem && cliItem.text === CLI_TEXT && cliItem.name === 'Caio', 'the web feed has the CLI post with its name')
  t.ok(feed.items.some((i) => i.author === webKey && i.text === WEB_TEXT), 'and its own post')
  const log = await web.request('log.read', { author: cliKey })
  t.is(log.key, cliKey)
  t.alike(log.entries.map((e) => e.seq), [0, 1, 2, 3])
  t.is(log.entries[0].record.type, 'member-cert')
  t.alike([log.entries[3].record.type, log.entries[3].record.key, log.entries[3].record.on], ['follow', webKey, true], 'the CLI member\'s follow of the web key, as a record')

  // The names of the downloaded member, from local data; an author with no
  // local data is missing (and no core is created for it).
  const stranger = 'ef'.repeat(32)
  t.alike(await web.request('profile.read', { authors: [cliKey] }), {
    profiles: [{ author: cliKey, name: 'Caio', bio: '', avatar: null, username: null }],
    missing: []
  }, 'the CLI member by name')
  const mixed = await web.request('profile.read', { authors: [cliKey, stranger] })
  t.alike(mixed.profiles.map((p) => [p.author, p.name]), [[cliKey, 'Caio']])
  t.alike(mixed.missing, [stranger], 'no local data: missing')
  t.absent(JSON.stringify(mixed).includes('ws://'), 'no address in the answer')

  // A reply from the web, read by the CLI member.
  const reply = await web.request('post.reply', { to: cliPost.ref, text: REPLY_TEXT })
  t.is(reply.seq, 4, 'after the follow record')
  const third = await web.request('sync.start', { once: true, timeoutMs: 30000 })
  const stopped3 = await stoppedOf(web.events, third.runId)
  t.is(stopped3.reason, 'done', 'third web run done')
  t.is(stopped3.result.seederConfirmed, true)
  const cliSync2 = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json']).exited
  t.is(cliSync2.code, 0, 'second CLI sync exits 0')
  const cliFeed2 = await run(t, bootstrap, ['feed', '--data', memberDir, '--json'])
  const replyItem = cliFeed2.items.find((i) => i.author === webKey && i.text === REPLY_TEXT)
  t.ok(replyItem, 'the CLI feed has the web reply')
  t.alike(replyItem && replyItem.replyTo, { author: cliKey, seq: cliPost.seq }, 'reply points at the CLI post')

  // Nothing the session sent names the seeder's address, and nothing went
  // to the internal-error report.
  const sent = JSON.stringify(web.events)
  t.absent(sent.includes('127.0.0.1') || sent.includes('ws://'), 'no address in events')
  t.is(internal.length, 0, 'no internal error')
  const seederLog = jsonLines(seed.stdout)
  t.ok(seederLog.some((e) => e.event === 'admitted' && e.key === webKey), 'the seeder admitted the web diary')
  seed.kill()
  await seed.exited
})

// ---- depoimentos (docs/rpc.md 5.100) ----

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// The real Seeder in this process behind a loopback WebSocket entry.
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-wse-tm-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-wse-tm-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e) })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { seeder, events, publicKey, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

// The seeder's /index/testimonials route, stubbed: `pointers` maps an
// owner to its pending list; every URL asked is recorded.
function indexStub (pointers, asked) {
  return async (url) => {
    asked.push(url)
    const m = /\/index\/testimonials\/([0-9a-f]{64})$/.exec(url)
    if (m === null) return new Response('não encontrado', { status: 404 })
    return new Response(JSON.stringify({ shown: [], pending: pointers[m[1]] || [], indexing: false, complete: true }), { status: 200 })
  }
}

// A browser node with a PRF (so its DM box key is held), certified, in a
// continuous run (diary.peek needs it; writes restart it, which pushes).
async function testimonialNode (t, { assoc, url, fetchMedia, name }) {
  const internal = []
  const prf = crypto.randomBytes(32)
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300 },
    writeGate: false,
    peekTimeoutMs: 3000,
    fetchMedia
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  await web.request('profile.set', { name, bio: '' })
  await web.request('sync.start', {})
  return { node, web, key: publicKey, prf, internal }
}

// A Hypercore member (not a browser node) whose diary holds arbitrary
// records, so forged ones can be served; its link closes once served.
async function rawMember (t, assoc) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  return m
}

async function serve (t, m, { url, seederKey, assoc }) {
  const link = connectSeeder({ member: m, socket: new WebSocket(url), association: assoc.hex, seederPublicKey: seederKey, timeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
}

async function failureOf (p) {
  try {
    await p
    return null
  } catch (err) {
    return { code: err.code, message: err.message }
  }
}

// Polls a request until check(result) holds (peeks of blocks still on
// their way answer them as missing, or the request fails meanwhile).
async function eventually (fn, check, name) {
  let last = null
  try {
    return await until(async () => {
      try {
        last = await fn()
      } catch (err) {
        last = { error: err.message }
        return false
      }
      return check(last) ? last : false
    }, { name, timeoutMs: 90000, intervalMs: 200 })
  } catch (err) {
    throw new Error(err.message + ': ' + JSON.stringify(last))
  }
}

test('depoimentos: write, pending, show, remove, revoke and forged shows end to end', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { url, publicKey: seederKey, events: seederEvents } = await seederStack(t, bootstrap, assoc)
  const pointers = {}
  const asked = []
  const fetchMedia = indexStub(pointers, asked)

  const A = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Ana' })
  const B = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Bia' })
  const C = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Caio' })
  const results = []
  const req = async (n, method, params) => {
    const r = await n.web.request(method, params)
    results.push(r)
    return r
  }
  const errors = []
  const fail = async (p) => {
    const e = await failureOf(p)
    errors.push(e)
    return e
  }

  // B publishes its dm-key; C never does.
  const enabled = await B.web.request('dm.enable')
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  t.is(enabled.box, hex(boxB.publicKey))
  await eventually(() => A.web.request('dm.lookup', { member: B.key }), (r) => r.box === enabled.box, 'A sees the dm-key of B')

  // Refusals: self, and a recipient without a dm-key.
  t.alike(await fail(A.web.request('testimonial.write', { to: A.key, text: 'eu mesma' })), { code: 'USAGE', message: 'não pode escrever um depoimento para si' })
  await eventually(() => A.web.request('diary.peek', { author: C.key, seqs: [1] }), (r) => r.entries.length === 1, 'C served')
  t.alike(await fail(A.web.request('testimonial.write', { to: C.key, text: 'oi' })), { code: 'USAGE', message: 'a pessoa ainda não recebe mensagens' })
  const before = await A.web.request('log.read', {})
  t.alike(before.entries.map((e) => e.record.type), ['member-cert', 'profile'], 'nothing written by a refusal')

  // A writes a sealed depoimento to B: nothing readable in the record.
  const T1 = 'a Bia é a pessoa mais generosa que conheço'
  const w1 = await req(A, 'testimonial.write', { to: B.key, text: T1 })
  t.alike(w1, { seq: 2, ref: A.key + ':2' })
  const aLog = await A.web.request('log.read', {})
  const rec1 = aLog.entries[2].record
  t.alike(Object.keys(rec1), ['type', 'to', 'gen', 'hash', 'box', 'at'])
  t.is(rec1.to, B.key)
  t.is(rec1.gen, 1)
  t.absent(JSON.stringify(aLog).includes('generosa'), 'the text is not public')

  // E: a raw diary with depoimentos to B that must not reach pending.
  const D = await rawMember(t, assoc)
  const E = await rawMember(t, assoc)
  const TE = 'E escreveu de verdade'
  const good = sealOffer({ from: E.key, text: TE, boxPk: boxB.publicKey })
  const otherGen = sealOffer({ from: E.key, text: 'outra geração', boxPk: boxB.publicKey })
  const mismatch = sealOffer({ from: E.key, text: 'texto selado', boxPk: boxB.publicKey })
  const mismatchHash = sealOffer({ from: E.key, text: 'outro texto', boxPk: boxB.publicKey }).hash
  const toC = sealOffer({ from: E.key, text: 'para o Caio', boxPk: boxB.publicKey })
  const dPair = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(32) }
  sodium.crypto_box_keypair(dPair.publicKey, dPair.secretKey)
  const TD = 'D merece'
  const forD = sealOffer({ from: E.key, text: TD, boxPk: dPair.publicKey })
  await E.core.append(testimonialRecord({ to: B.key, gen: 1, hash: good.hash, box: good.box })) // 1: valid
  // 2: sealed to B's box but naming another generation: the engine holds
  // only its current one, so a depoimento sealed to any other gen (an older
  // one after a rotation) is omitted.
  await E.core.append(testimonialRecord({ to: B.key, gen: 2, hash: otherGen.hash, box: otherGen.box }))
  await E.core.append(testimonialRecord({ to: B.key, gen: 1, hash: mismatchHash, box: mismatch.box })) // 3: hash mismatch
  await E.core.append(testimonialRecord({ to: C.key, gen: 1, hash: toC.hash, box: toC.box })) // 4: addressed to C
  await E.core.append(testimonialRecord({ to: D.key, gen: 1, hash: forD.hash, box: forD.box })) // 5: to D
  await serve(t, E, { url, seederKey, assoc })
  // F copies E's valid block verbatim into its own diary: it opens with B's
  // key but is bound to E, so it never lists E's words under F's name.
  const F = await rawMember(t, assoc)
  await F.core.append(testimonialRecord({ to: B.key, gen: 1, hash: good.hash, box: good.box }))
  await F.core.append(testimonialRecord({ to: D.key, gen: 1, hash: forD.hash, box: forD.box }))
  await serve(t, F, { url, seederKey, assoc })

  // Pending: only B sees A's (and E's valid one), opened; never the nonce.
  pointers[B.key] = [{ from: F.key, seq: 1 }, { from: A.key, seq: w1.seq }, ...[1, 2, 3, 4].map((seq) => ({ from: E.key, seq })), { from: A.key, seq: 1 }, { from: B.key, seq: 1 }]
  pointers[C.key] = [{ from: A.key, seq: w1.seq }, { from: E.key, seq: 4 }]
  const pending = await eventually(() => req(B, 'testimonial.pending', {}), (r) => r.items.length === 2 && !r.incomplete, 'B pending')
  t.absent(pending.items.some((i) => i.from === F.key), 'a copied block is not pending')
  const byFrom = new Map(pending.items.map((i) => [i.from, i]))
  t.alike(Object.keys(byFrom.get(A.key)), ['from', 'seq', 'text', 'at'])
  t.alike([byFrom.get(A.key).seq, byFrom.get(A.key).text, byFrom.get(A.key).at], [w1.seq, T1, rec1.at])
  t.alike([byFrom.get(E.key).seq, byFrom.get(E.key).text], [1, TE], 'other gen, hash mismatch and C\'s omitted')
  t.ok(asked.every((u) => u.startsWith('http://127.0.0.1:')), 'the index of its own seeder')
  t.alike(await req(C, 'testimonial.pending', {}), { items: [], kept: [], incomplete: false }, 'C opens none: E 4 is sealed to B\'s key, A 2 is addressed to B')

  // Showing someone else's, a forged one or a missing one is not found.
  const NOT_FOUND = { code: 'USAGE', message: 'depoimento não encontrado' }
  t.alike(await fail(C.web.request('testimonial.show', { from: A.key, seq: w1.seq })), NOT_FOUND)
  t.alike(await fail(B.web.request('testimonial.show', { from: E.key, seq: 3 })), NOT_FOUND)
  t.alike(await fail(B.web.request('testimonial.show', { from: E.key, seq: 2 })), NOT_FOUND)
  t.alike(await fail(B.web.request('testimonial.show', { from: A.key, seq: 1 })), NOT_FOUND)
  t.alike(await fail(B.web.request('testimonial.show', { from: F.key, seq: 1 })), NOT_FOUND, 'a copied block is refused')

  // B shows A's: the text and nonce become public; a repeat writes nothing.
  const s1 = await req(B, 'testimonial.show', { from: A.key, seq: w1.seq })
  t.alike(await req(B, 'testimonial.show', { from: A.key, seq: w1.seq }), s1, 'no duplicate show')
  const bLog = await B.web.request('log.read', {})
  t.is(bLog.entries.filter((e) => e.record.type === 'testimonial-show').length, 1)
  const show1 = bLog.entries[s1.seq].record
  t.alike([show1.from, show1.seq, show1.text], [A.key, w1.seq, T1])
  t.alike((await req(B, 'testimonial.pending', {})).items.map((i) => [i.from, i.seq]), [[E.key, 1]], 'a shown one leaves pending')

  // Anyone peeking B's diary gets the show, verified against A's block.
  const peek1 = await eventually(() => C.web.request('diary.peek', { author: B.key, seqs: [s1.seq] }), (r) => r.entries.length === 1, 'show visible')
  t.alike(peek1.invalid, [])
  t.alike(peek1.unverified, [])
  t.is(peek1.entries[0].record.text, T1)

  // Forged shows in D's diary: right owner and hash (kept), a hash that does
  // not match, and a show of a block addressed to someone else.
  await D.core.append(testimonialShowRecord({ from: E.key, seq: 5, text: TD, nonce: forD.nonce }))
  await D.core.append(testimonialShowRecord({ from: E.key, seq: 5, text: TD + '!', nonce: forD.nonce }))
  await D.core.append(testimonialShowRecord({ from: A.key, seq: w1.seq, text: T1, nonce: show1.nonce }))
  await D.core.append(testimonialShowRecord({ from: E.key, seq: 9, text: TD, nonce: forD.nonce }))
  await D.core.append(testimonialShowRecord({ from: F.key, seq: 2, text: TD, nonce: forD.nonce }))
  // 6: a writer the seeder does not know: its diary cannot be read at all.
  const NOBODY = 'f0'.repeat(32)
  await D.core.append(testimonialShowRecord({ from: NOBODY, seq: 1, text: TD, nonce: forD.nonce }))
  await serve(t, D, { url, seederKey, assoc })
  t.alike(await fail(C.web.request('diary.peek', { author: NOBODY, seqs: [1] })), { code: 'NOT_FOUND', message: 'diário indisponível' }, 'that writer is unreadable')
  const forged = await C.web.request('diary.peek', { author: D.key, seqs: [1, 2, 3, 4, 5, 6] })
  t.alike(forged.entries.map((e) => e.seq), [1], 'only the show the writer committed to')
  t.alike(forged.invalid, [2, 3, 4, 5], 'wrong hash, wrong owner, missing writer block, E\'s words to D under F')
  t.alike(forged.unverified, [6], 'an unreadable writer is unverified, never invalid')

  // A second depoimento of the same writer, shown too, then removed: every
  // show of that writer goes, so the older one cannot come back.
  const T2 = 'e ainda cozinha muito bem'
  const w2 = await req(A, 'testimonial.write', { to: B.key, text: T2 })
  pointers[B.key] = [{ from: A.key, seq: w1.seq }, { from: A.key, seq: w2.seq }]
  await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.items.length === 1 && r.items[0].seq === w2.seq, 'w2 pending')
  const s2 = await req(B, 'testimonial.show', { from: A.key, seq: w2.seq })
  t.is(s2.seq, s1.seq + 1)
  t.alike(await fail(B.web.request('testimonial.delete', { to: A.key + ':' + w1.seq })), { code: 'USAGE', message: 'referência inválida' }, 'another diary')
  t.alike(await fail(B.web.request('testimonial.delete', { to: B.key + ':' + 2 })), { code: 'USAGE', message: 'referência inválida' }, 'the dm-key is no depoimento')
  t.alike(await fail(B.web.request('testimonial.delete', { to: B.key + ':' + s2.seq, about: A.key })), { code: 'USAGE', message: 'referência inválida' }, 'about: a show is no depoimento to someone')
  const removed = await req(B, 'testimonial.delete', { to: B.key + ':' + s2.seq })
  t.alike(removed, { seq: s2.seq + 2, deleted: [s1.seq, s2.seq] }, 'one tombstone per show, the last one answered')
  const bLog2 = await B.web.request('log.read', {})
  t.alike(bLog2.invalid.map((i) => i.seq), [s1.seq, s2.seq], 'both shows deleted')
  await eventually(() => C.web.request('diary.peek', { author: B.key, seqs: [s1.seq, s2.seq, s2.seq + 1] }), (r) => r.entries.length === 1 && r.entries[0].record.type === 'delete' && r.entries.every((e) => e.record.type !== 'testimonial-show'), 'no show of A remains')

  // The writer revokes: B shows a third one, A tombstones it, and the show
  // reads as invalid while it still sits in B's diary.
  const w3 = await req(A, 'testimonial.write', { to: B.key, text: 'terceiro' })
  pointers[B.key] = [{ from: A.key, seq: w3.seq }]
  await eventually(() => B.web.request('testimonial.pending', {}), (r) => r.items.length === 1, 'w3 pending')
  const s3 = await req(B, 'testimonial.show', { from: A.key, seq: w3.seq })
  await eventually(() => C.web.request('diary.peek', { author: B.key, seqs: [s3.seq] }), (r) => r.entries.length === 1, 'w3 shown')
  t.alike(await fail(A.web.request('testimonial.delete', { to: A.key + ':' + w3.seq, about: C.key })), { code: 'USAGE', message: 'referência inválida' }, 'about: addressed to someone else')
  const revoked = await req(A, 'testimonial.delete', { to: A.key + ':' + w3.seq, about: B.key })
  t.alike(revoked, { seq: w3.seq + 1, deleted: [w3.seq] })
  t.alike(await req(A, 'testimonial.delete', { to: A.key + ':' + w3.seq, about: B.key }), revoked, 'about: an already deleted target answers its tombstone')
  await eventually(() => C.web.request('diary.peek', { author: B.key, seqs: [s3.seq] }), (r) => r.entries.length === 0 && r.invalid.length === 1, 'revoked show invalid')
  t.alike((await req(B, 'testimonial.pending', {})).items, [], 'a revoked one is not pending')

  // No secret anywhere: no box secret key, no PRF, no nonce in an error, a
  // result other than the shows' own records, an internal report or a
  // seeder log line.
  const secretHex = hex(boxB.secretKey)
  const prfHex = hex(B.prf)
  const everything = JSON.stringify({ results, errors, internal: [A.internal, B.internal, C.internal].map((l) => l.map((e) => String(e && e.stack))), seederEvents })
  t.absent(everything.includes(secretHex), 'no box secret key')
  t.absent(everything.includes(prfHex), 'no PRF')
  t.absent(JSON.stringify(errors).includes(show1.nonce) || JSON.stringify(results).includes(show1.nonce), 'no nonce in a result or error')
  t.absent(JSON.stringify(errors).includes('generosa') || JSON.stringify(errors).includes('selado'), 'no plaintext in an error')
  t.alike([A.internal, B.internal, C.internal], [[], [], []], 'no internal error')
})

// A loopback port nothing listens on: the node never gets a seeder link.
async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('testimonial.pending: a malformed index answer is unavailable, an incomplete index or a failed writer read is incomplete', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  let answer = null
  const fetchMedia = async (url) => {
    if (!/\/index\/testimonials\/[0-9a-f]{64}$/.test(url)) return new Response('não encontrado', { status: 404 })
    if (typeof answer === 'function') return answer()
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status: 200 })
  }
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false,
    peekTimeoutMs: 300,
    fetchMedia
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })

  const UNAVAILABLE = { code: 'NOT_FOUND', message: 'semeador indisponível' }
  for (const bad of [{}, { shown: [] }, { pending: 'x' }, { pending: null }, [], null, 'não é json', '[]']) {
    answer = bad
    t.alike(await failureOf(web.request('testimonial.pending', {})), UNAVAILABLE, 'malformed: ' + JSON.stringify(bad))
  }

  // An endless streamed answer is cut off just past the cap and cancelled,
  // never buffered whole.
  let pulled = 0
  let cancelled = false
  answer = () => new Response(new ReadableStream({
    pull (ctl) {
      pulled += 64 * 1024
      ctl.enqueue(new Uint8Array(64 * 1024).fill(0x20))
    },
    cancel () { cancelled = true }
  }), { status: 200 })
  t.alike(await failureOf(web.request('testimonial.pending', {})), UNAVAILABLE, 'an oversized streamed answer')
  t.ok(cancelled, 'the stream is cancelled')
  t.ok(pulled <= 256 * 1024 + 3 * 64 * 1024, 'read stops near the cap (' + pulled + ' bytes)')

  answer = { shown: [], pending: [], indexing: false, complete: true }
  t.alike(await web.request('testimonial.pending', {}), { items: [], kept: [], incomplete: false }, 'an empty, complete inbox')
  answer = { shown: [], pending: [], indexing: true, complete: true }
  t.alike(await web.request('testimonial.pending', {}), { items: [], kept: [], incomplete: true }, 'still indexing')
  answer = { shown: [], pending: [], indexing: false, complete: false }
  t.alike(await web.request('testimonial.pending', {}), { items: [], kept: [], incomplete: true }, 'index not complete')

  // A writer block the node cannot read (no seeder link: the peek fails)
  // is skipped and marks the answer incomplete, never an empty inbox.
  answer = { shown: [], pending: [{ from: 'ab'.repeat(32), seq: 1 }], indexing: false, complete: true }
  t.alike(await web.request('testimonial.pending', {}), { items: [], kept: [], incomplete: true }, 'a failed writer read')
})

test('testimonial.delete: removing a show tombstones 9 live shows of one writer in chunks, the target last', async (t) => {
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair: crypto.keyPair() }
  const { publicKey: own } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: own }, assoc.kp))
  const writer = 'ab'.repeat(32)
  const other = 'cd'.repeat(32)
  const show = (from, seq) => testimonialShowRecord({ from, seq, text: 'depoimento ' + seq, nonce: hex(crypto.randomBytes(32)) })
  // Blocks 1..9: shows of `writer`; block 10: a show of another writer.
  const shows = Array.from({ length: 9 }, (_, i) => show(writer, i + 1))
  await member.withIdentity(ctx, async ({ diary }) => {
    await store.appendRecords(diary, shows.slice(0, 8))
    await store.appendRecords(diary, [shows[8], show(other, 1)])
  })

  const r = await member.testimonialDelete(ctx, { to: { author: own, seq: 9 } })
  t.alike(r.deleted, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'every live show of that writer')
  t.is(r.seq, 19, 'the last tombstone answered')
  t.is(r.changed, true)

  const raw = await member.withIdentity(ctx, ({ diary }) => store.readRaw(diary))
  const tombs = raw.filter((e) => e.seq > 10).map((e) => e.record)
  t.is(tombs.length, 9)
  t.ok(tombs.every((rec) => rec.type === 'delete'))
  t.alike(tombs.map((rec) => rec.seq), [8, 7, 6, 5, 4, 3, 2, 1, 9], 'the other shows newest first, the target last')
  const gone = deletedSeqs(raw)
  t.alike([...gone].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  t.is(raw[10].record.type, 'testimonial-show', 'another writer\'s show stays')

  const again = await member.testimonialDelete(ctx, { to: { author: own, seq: 9 } })
  t.is(again.changed, false, 'a repeat writes nothing')
})

test('testimonial.delete: a failed later chunk leaves the target live, so a repeat of the same ref removes every show of that writer', async (t) => {
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair: crypto.keyPair() }
  const { publicKey: own } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: own }, assoc.kp))
  const writer = 'ab'.repeat(32)
  const show = (from, seq) => testimonialShowRecord({ from, seq, text: 'depoimento ' + seq, nonce: hex(crypto.randomBytes(32)) })
  const shows = Array.from({ length: 9 }, (_, i) => show(writer, i + 1))
  await member.withIdentity(ctx, async ({ diary }) => {
    await store.appendRecords(diary, shows.slice(0, 8))
    await store.appendRecords(diary, [shows[8]])
  })

  // The second append (whichever store call carries it) fails once.
  const appendRecords = store.appendRecords
  const appendRecord = store.appendRecord
  let calls = 0
  const failSecond = (fn) => async (...args) => {
    if (++calls === 2) throw new Error('falha de escrita')
    return fn(...args)
  }
  store.appendRecords = failSecond(appendRecords)
  store.appendRecord = failSecond(appendRecord)
  try {
    await t.exception(member.testimonialDelete(ctx, { to: { author: own, seq: 9 } }), /falha de escrita/)
  } finally {
    store.appendRecords = appendRecords
    store.appendRecord = appendRecord
  }
  t.is(calls, 2)

  // Sync clears every tombstoned block before the person tries again.
  await member.withIdentity(ctx, async ({ diary }) => {
    const raw = await store.readRaw(diary)
    await clearDeleted(diary, [...deletedSeqs(raw)])
  })

  const again = await member.testimonialDelete(ctx, { to: { author: own, seq: 9 } })
  t.is(again.changed, true, 'the repeat finishes the removal')
  const raw = await member.withIdentity(ctx, ({ diary }) => store.readRaw(diary))
  const gone = deletedSeqs(raw)
  const left = raw.filter((e) => e.seq >= 1 && e.seq <= 9 && !gone.has(e.seq))
  t.alike(left.map((e) => e.seq), [], 'no show of that writer remains')
})

// The seeder's /index/scraps and /index/follow routes answered by the real
// in-process Seeder (Seeder#indexScraps, Seeder#indexFollowSeq), as
// apps/cli/lib/seed-ws.js serves them; null is the route's 404.
// doctor.fn(url, body), when set, rewrites an answer (a hostile seeder).
function scrapIndex (seeder, doctor = {}) {
  return async (url) => {
    let m = /\/index\/scraps\/([0-9a-f]{64})$/.exec(url)
    let body = null
    if (m !== null) body = seeder.indexScraps(m[1])
    m = /\/index\/follow\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(url)
    if (m !== null) body = seeder.indexFollowSeq(m[1], m[2])
    if (typeof doctor.fn === 'function') body = doctor.fn(url, body)
    if (body === null) return new Response('não encontrado', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200 })
  }
}

test('recados: write, reply back without a mutual follow, hide, delete and wall changes end to end', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { seeder, url } = await seederStack(t, bootstrap, assoc)
  const doctor = {}
  const fetchMedia = scrapIndex(seeder, doctor)
  const A = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Ana' })
  const B = await testimonialNode(t, { assoc, url, fetchMedia, name: 'Bia' })
  const FOLLOWING = { code: 'USAGE', message: 'esta pessoa só recebe recados de quem ela segue' }
  const NOBODY = { code: 'USAGE', message: 'esta pessoa não está recebendo recados' }
  const types = async (n) => (await n.web.request('log.read', {})).entries.map((e) => e.record.type)
  // Until the seeder indexes the evidence the node answers 'semeador
  // indisponível': only that answer is retried; anything else (a write
  // where a refusal is expected included) settles at once.
  const settle = async (n, params, name) => {
    const deadline = Date.now() + 90000
    for (;;) {
      try {
        return { result: await n.web.request('scrap.write', params) }
      } catch (err) {
        if (err.message !== 'semeador indisponível') return { error: { code: err.code, message: err.message } }
      }
      if (Date.now() > deadline) throw new Error('tempo esgotado: ' + name)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const refused = async (n, params, want, name) => t.alike(await settle(n, params, name), { error: want }, name)
  const written = async (n, params, name) => {
    const r = await settle(n, params, name)
    t.ok(r.result !== undefined, name + ': ' + JSON.stringify(r.error))
    return r.result
  }

  t.alike(await failureOf(A.web.request('scrap.write', { to: A.key, text: 'eu mesma' })), { code: 'USAGE', message: 'não pode deixar recado para si' })
  await eventually(() => A.web.request('diary.peek', { author: B.key, seqs: [1] }), (r) => r.entries.length === 1, 'B served')
  await eventually(() => B.web.request('diary.peek', { author: A.key, seqs: [1] }), (r) => r.entries.length === 1, 'A served')

  // B follows A, A does not follow B; both walls are the default 'following'.
  await B.web.request('follow.add', { key: A.key })
  await refused(B, { to: A.key, text: 'oi Ana' }, FOLLOWING, 'A does not follow B')
  t.alike(await types(B), ['member-cert', 'profile', 'follow'], 'nothing written by the refusal')

  // A writes on B's page: B follows A, proven by B's own follow block.
  const w1 = await written(A, { to: B.key, text: 'oi Bia, tudo bem?' }, 'A writes to B')
  t.alike(w1, { seq: 2, ref: A.key + ':2' })
  const rec1 = (await A.web.request('log.read', {})).entries[2].record
  t.alike([rec1.type, rec1.to, rec1.text, rec1.replyTo], ['scrap', B.key, 'oi Bia, tudo bem?', null])

  // B answers on A's page without being followed: the reply exception.
  t.alike(await failureOf(B.web.request('scrap.write', { to: A.key, text: 'x', replyTo: A.key + ':1' })), { code: 'USAGE', message: 'referência inválida' }, 'a reply to a block that is no scrap')
  t.alike(await failureOf(B.web.request('scrap.write', { to: A.key, text: 'x', replyTo: A.key + ':40' })), { code: 'NOT_FOUND', message: 'semeador indisponível' }, 'a reply past A\'s diary cannot be told from one not replicated yet')
  const r1 = await written(B, { to: A.key, text: 'tudo ótimo!', replyTo: w1.ref }, 'B replies on A\'s page')
  const rec2 = (await B.web.request('log.read', {})).entries[r1.seq].record
  t.alike([rec2.type, rec2.to, rec2.replyTo], ['scrap', A.key, { author: A.key, seq: w1.seq }])
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && p.scraps.some((s) => s.author === B.key && s.seq === r1.seq), 'the reply is on A\'s page')
  await refused(B, { to: A.key, text: 'de novo' }, FOLLOWING, 'a plain scrap is still refused')

  // A hides the reply: it leaves A's page.
  const hide = await A.web.request('scrap.hide', { from: B.key, seq: r1.seq })
  t.alike(hide, { seq: w1.seq + 1, ref: A.key + ':' + (w1.seq + 1) })
  t.alike(await A.web.request('scrap.hide', { from: B.key, seq: r1.seq }), hide, 'no second hide')
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && p.hides.includes(hide.seq) && p.scraps.length === 0, 'hidden on A\'s page')

  // A closes its page to everyone, even a reply.
  const closedWall = await A.web.request('scrap.wall', { who: 'nobody' })
  // Waited for first, so a reply the old wall would admit is never written.
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && p.wall === closedWall.seq, 'A\'s wall indexed')
  await refused(B, { to: A.key, text: 'outra resposta', replyTo: w1.ref }, NOBODY, 'nobody')
  // Then opens it to everyone: B writes without being followed.
  const open = await A.web.request('scrap.wall', { who: 'everyone' })
  t.is(open.seq, closedWall.seq + 1)
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && p.wall === open.seq, 'A\'s open wall indexed')
  const w2 = await written(B, { to: A.key, text: 'agora pode!' }, 'everyone')
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && p.wall === open.seq && p.scraps.some((s) => s.author === B.key && s.seq === w2.seq), 'B\'s scrap on A\'s page')

  // B deletes its scrap; a repeat answers the same tombstone.
  const del = await B.web.request('scrap.delete', { seq: w2.seq })
  t.alike(del, { seq: w2.seq + 1, deleted: [w2.seq] })
  t.alike(await B.web.request('scrap.delete', { seq: w2.seq }), del)
  t.alike(await failureOf(B.web.request('scrap.delete', { seq: 1 })), { code: 'USAGE', message: 'referência inválida' }, 'B\'s profile is no recado')
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && !p.scraps.some((s) => s.author === B.key && s.seq === w2.seq), 'gone from A\'s page')

  // Back to the default wall by deleting the walls: B is refused again.
  await A.web.request('scrap.delete', { seq: open.seq })
  await A.web.request('scrap.delete', { seq: closedWall.seq })
  await eventually(async () => seeder.indexScraps(A.key), (p) => p !== null && p.wall === null, 'no wall indexed')
  await refused(B, { to: A.key, text: 'ainda posso?' }, FOLLOWING, 'the default wall again')

  // A hostile seeder: every pointer that does not verify is unavailable,
  // never a write. B's diary gets a follow of another key and its unfollow.
  const OTHER = 'ab'.repeat(32)
  await B.web.request('follow.add', { key: OTHER })
  await eventually(() => B.web.request('log.read', {}), (l) => l.entries.some((e) => e.record.type === 'follow' && e.record.key === OTHER), 'B follows another key')
  await B.web.request('follow.remove', { key: OTHER })
  const bLog = await eventually(() => B.web.request('log.read', {}), (l) => l.entries.some((e) => e.record.type === 'follow' && e.record.key === OTHER && e.record.on === false), 'B unfollows it')
  const seqOf = (match) => bLog.entries.find((e) => match(e.record)).seq
  const followA = seqOf((r) => r.type === 'follow' && r.key === A.key && r.on === true)
  const otherKey = seqOf((r) => r.type === 'follow' && r.key === OTHER && r.on === true)
  const unfollow = seqOf((r) => r.type === 'follow' && r.key === OTHER && r.on === false)
  const UNAVAILABLE = { code: 'NOT_FOUND', message: 'semeador indisponível' }
  const aBefore = await types(A)
  const toB = { to: B.key, text: 'teste' }
  const follow = (seq, indexing = false) => (u, body) => u.includes('/index/follow/') ? { seq, indexing } : body
  for (const [name, fn] of [
    ['the follow pointer at a profile', follow(1)],
    ['the follow pointer at a follow of another key', follow(otherKey)],
    ['the follow pointer at an unfollow', follow(unfollow)],
    ['no follow while indexing', follow(null, true)],
    ['the wall pointer at a follow', (u, body) => u.includes('/index/scraps/') ? { ...body, wall: followA } : body]
  ]) {
    doctor.fn = fn
    t.alike(await failureOf(A.web.request('scrap.write', toB)), UNAVAILABLE, name)
  }
  doctor.fn = follow(followA)
  t.ok(Number.isSafeInteger((await A.web.request('scrap.write', toB)).seq), 'the true follow pointer admits A')
  doctor.fn = null
  t.alike((await types(A)).length, aBefore.length + 1, 'only the admitted write was written')
  t.alike([A.internal, B.internal], [[], []], 'no internal error')
})
