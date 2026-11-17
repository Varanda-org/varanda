'use strict'

// The roteiro of issue #31 (Excluir conta), end to end and loopback only:
// every component that holds a member's data on the account service and on
// the seeder, checked one by one after a deletion. The pieces: an
// association, an issuer and a moderation key made with the real CLI (as
// moderation-e2e.test.js), the real Seeder in-process with its WebSocket
// entry and stub postage keys (so its stamp ledgers are on), the account
// service in-process with every store the deletion purges on one movable
// clock, and two browser sessions (createBrowserNode over memory storage)
// linked by phone with an invite. Ana deletes her account; Bia is the
// control whose data must stay.
// The walk: Ana's data lands in each component; she asks the deletion
// through the real routes without a stored passkey assertion, so it waits
// 7 days; the clock passes the date and the service's own sweep runs it;
// `mod apply` signs the block and publishes it to the seeder, which drops
// her diary and media core and prunes her stamp rows; re-admission is
// refused by the service and by the seeder; 180 days later the sweep purges
// the moderation rows and the sealed phone number, and what stays is what
// docs/verification/test-deletion-roteiro.md says stays.
// Planting goes through the stores directly where account-delete.test.js
// does; reports go through the real routes (report.sign in the session).
const test = require('brittle')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createClient, parseMessage, EVENTS, MAX_MESSAGE } = require('@varanda/rpc')
const { Seeder } = require('@varanda/core/lib/seeder')
const assoc = require('@varanda/core/lib/assoc')
const { readBlocklist, lockDataDir } = require('@varanda/core/lib/store')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { SEEN_BLOB_BYTES } = require('@varanda/core/lib/seen-blob')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { linkByPhone } = require('./helpers/phone-link')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { fakeEmbed } = require('./helpers/fake-embed')
const { createPhoneStub } = require('../scripts/phone-stub')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openAgeStore } = require('../lib/account/age-store')
const { openPushStore } = require('../lib/account/push-store')
const { openRecoveryStore } = require('../lib/account/recovery-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { openInviteDrops } = require('../lib/account/invite-drops')
const { weekStartMs } = require('../lib/account/invite-drop-time')
const { openSeenStore } = require('../lib/account/seen-store')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { openDeletionRequests } = require('../lib/account/deletion-requests')
const { openPagesStore } = require('../lib/account/pages-store')
const { openLedger } = require('../lib/account/ai/ledger')
const { openExemplarStore } = require('../lib/account/ai/exemplar-store')
const { createTriageForget } = require('../lib/account/ai/forget')
const { quantize } = require('../lib/account/ai/triage')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createAccountServer, loadIssuer } = require('../lib/account/server')
const { WAIT_MS } = require('../lib/account/delete-routes')
const { MODERATION_RETENTION_MS } = require('../lib/account/deletion')
const { startSeedWs } = require('../lib/seed-ws')
const modApply = require('../lib/mod-apply')
const modPublish = require('../lib/mod-publish')
// The browser node lives in packages/web-member; apps/cli does not depend
// on it, so it is reached by path (as moderation-e2e.test.js does).
const { createBrowserNode } = require('../../../packages/web-member/lib/node')
const { memoryNodeStorage } = require('../../../packages/web-member/lib/node-storage')
const { jpegHead } = require('../../../packages/web-member/test/helpers/photo')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const WAIT = { timeoutMs: 45000 }
const DAY_MS = 24 * 3600 * 1000
const RP = '127.0.0.1'
const TRIAGE_TEXT = 'compre agora bitcoin gratis clique aqui no link promocao imperdivel'

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function hexKey () {
  return hex(crypto.keyPair().publicKey)
}

function cli (args) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60000 })
}

// A free loopback port, released before the service binds it: the origin
// the operator signs must carry the port the service listens on.
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

async function post (origin, pathname, body) {
  const res = await fetch(origin + pathname, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, body: parsed, text }
}

async function getJson (url) {
  const res = await fetch(url)
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, body: parsed, text }
}

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

async function stoppedOf (events, runId) {
  return until(() => {
    const ev = events.find((e) => e.name === 'sync.stopped' && e.data.runId === runId)
    return ev ? ev.data : null
  }, { name: 'sync.stopped ' + runId, timeoutMs: 60000 })
}

// A gated write: its last run ends with the seeder holding the diary
// (or, once the diary is blocked, with the run's own answer).
async function gatedWrite (web, method, params) {
  const from = web.events.length
  const result = await web.request(method, params)
  const started = web.events.slice(from).filter((e) => e.name === 'sync.started')
  const last = started[started.length - 1]
  const stopped = last ? await stoppedOf(web.events, last.data.runId) : null
  return { result, stopped }
}

// A browser device unlocked with a random key pair, its own media key pair
// and a PRF secret, its identity made.
async function device (t, { association, seederUrl, keyPair = crypto.keyPair() }) {
  const internal = []
  const media = crypto.keyPair()
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
  await node.setKeyPair(keyPair, { media, prf: crypto.randomBytes(32) })
  const web = await connectClient(node)
  const key = hex(keyPair.publicKey)
  t.alike(await web.request('identity.create'), { publicKey: key, association })
  return { node, web, key, mediaKey: hex(media.publicKey), internal }
}

async function link (t, origin, dev, username, invite) {
  const finished = await linkByPhone({
    origin,
    member: dev.key,
    username,
    invite,
    sign: ({ action, phase, nonce, sub }) => action
      ? dev.web.request('phone.sign', { action, nonce })
      : dev.web.request('account.sign', { phase, nonce, username, sub })
  })
  t.is(finished.cert.member, dev.key, username + ': linked by phone')
  return finished
}

// A report through the real routes (report.sign in the session).
async function report (origin, dev, { target, seq = null, reason = 'spam', text = '', quote = '' }) {
  const start = await post(origin, '/account/report/start', { member: dev.key })
  if (start.status !== 200) return start
  const params = { nonce: start.body.nonce, target, reason, text }
  if (seq !== null) {
    params.seq = seq
    params.quote = quote
  }
  const { signature } = await dev.web.request('report.sign', params)
  return post(origin, '/account/report', { member: dev.key, nonce: start.body.nonce, target, seq, reason, text, quote, signature })
}

function readJsonFile (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

test('roteiro: Excluir conta clears every component or keeps exactly what the docs say', async (t) => {
  t.timeout(120000)
  const began = Date.now()
  const { bootstrap } = await testnet(t)
  const root = tmpDir(t, 'varanda-roteiro-')

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
  const modDir = path.join(root, 'mod')
  const modInit = cli(['mod', 'init', '--association', association, '--data', modDir])
  t.is(modInit.status, 0, modInit.stderr)
  const moderator = /^chave da moderação: ([0-9a-f]{64})\n$/.exec(modInit.stdout)[1]
  const modCertFile = path.join(root, 'moderator-cert.json')
  const cm = cli(['assoc', 'certify-moderator', '--moderator', moderator, '--out', modCertFile, '--data', assocDir])
  t.is(cm.status, 0, cm.stderr)
  const mca = cli(['mod', 'cert', 'add', '--cert-file', modCertFile, '--data', modDir])
  t.is(mca.status, 0, mca.stderr)

  // ---- the seeder, with its stamp ledgers on ----
  const seedDir = path.join(root, 'seed')
  Seeder.ensureConfig(seedDir, association)
  const { publicKey: seederKey } = Seeder.createKey(seedDir)
  const seederCertFile = path.join(root, 'seeder-cert.json')
  fs.writeFileSync(seederCertFile, JSON.stringify(assoc.issueSeederCertificate(assocDir, { seeder: seederKey })))
  Seeder.addCert(seedDir, seederCertFile, association)
  const seedEvents = []
  // The postage keys are asked only when a peer opens the stamp channel,
  // which nobody does here: the ledgers are read and pruned all the same.
  const noKey = () => ({ get: async () => { throw new Error('postage não usada neste teste') } })
  const seeder = new Seeder({ dataDir: seedDir, ...localSwarmOptions(bootstrap), log: (e) => seedEvents.push(e), dm: { postage: noKey(), blobPostage: noKey() } })
  t.teardown(() => seeder.close(), { force: true })

  // ---- the account service on a reserved loopback port, one movable clock ----
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const port = await reservePort()
  const ORIGIN = 'http://127.0.0.1:' + port
  const store = openAccountStore(accountDir, { now })
  const moderation = openModerationStore(accountDir, { association, now })
  const terms = openTermsStore(accountDir, { now })
  const ages = openAgeStore(accountDir, { now })
  const pushStore = openPushStore(accountDir, { now })
  const recovery = openRecoveryStore(accountDir, { now })
  const invites = openInvitesStore(accountDir, { now, perWeek: 5, isUsed: (id) => store.inviteUsed(id) })
  const drops = openInviteDrops(accountDir, { perWeek: 1, now })
  const seen = openSeenStore(accountDir, { now })
  const passkeys = openPasskeyStore(accountDir, { now })
  const phoneKey = nodeCrypto.randomBytes(32)
  const phones = openPhoneStore(accountDir, { key: phoneKey, now })
  const deletionRequests = openDeletionRequests(accountDir, { now })
  const pagesStore = openPagesStore(accountDir, { now })
  // The pages routes load the invite rosters once, at start, so the rows
  // for Ana's and Bia's pending invites are on disk before the server opens.
  const anaKeyPair = crypto.keyPair()
  const biaKeyPair = crypto.keyPair()
  const owner = hexKey()
  const p1 = hexKey()
  const p2 = hexKey()
  const rostersFile = path.join(accountDir, 'page-invite-rosters.json')
  const rosterExp = new Date(now() + 30 * DAY_MS).toISOString()
  fs.writeFileSync(rostersFile, JSON.stringify({
    v: 1,
    rows: {
      [p2 + ':' + hex(anaKeyPair.publicKey)]: { record: { owner, admins: [hex(anaKeyPair.publicKey)] }, expiresAt: rosterExp },
      [p2 + ':' + hex(biaKeyPair.publicKey)]: { record: { owner, admins: [hex(biaKeyPair.publicKey)] }, expiresAt: rosterExp }
    }
  }), { mode: 0o600 })
  const logs = []
  const pushed = []
  const server = createAccountServer({
    association,
    origin: ORIGIN,
    store,
    issuer,
    moderation,
    terms,
    ages,
    push: { pushStore, vapid: null, send: async (args) => { pushed.push(args) }, delayMs: () => 0, relayTokenHash: null },
    recovery,
    invites,
    drops,
    seen,
    passkeys,
    deletionRequests,
    phones,
    phoneClient: createPhoneStub(),
    pages: { pagesStore, dir: accountDir },
    triageForget: createTriageForget({ dataDir: accountDir, moderation }),
    log: (e) => logs.push(JSON.stringify(e)),
    now
  })
  const listener = await server.listen({ host: '127.0.0.1', port })
  t.teardown(() => listener.close(), { force: true })

  const stampFiles = ['dm-stamps.json', 'blob-stamps.json', 'copy-stamps.json']
  const ws = await startSeedWs({ host: '127.0.0.1', port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const seederUrl = 'ws://127.0.0.1:' + ws.port + '/seeder'

  // ---- Ana and Bia: browser sessions, linked by phone with an invite ----
  const inviter = hexKey()
  const ana = await device(t, { association, seederUrl, keyPair: anaKeyPair })
  const bia = await device(t, { association, seederUrl, keyPair: biaKeyPair })
  // The stamp ledgers hold a row for each diary before the seeder starts.
  const day = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
  for (const [i, file] of stampFiles.entries()) {
    const period = i === 2 ? '2026-W47' : day
    fs.writeFileSync(path.join(seedDir, file), JSON.stringify({ v: 2, days: { [ana.key]: { [period]: 2 }, [bia.key]: { [period]: 1 } } }), { mode: 0o600 })
  }
  await seeder.start()

  // Terms before the link: the phone steps need them.
  for (const dev of [ana, bia]) await terms.accept({ member: dev.key, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const anaLink = await link(t, ORIGIN, ana, 'ana', (await invites.issue(inviter)).code)
  const biaLink = await link(t, ORIGIN, bia, 'bia', (await invites.issue(inviter)).code)

  // ---- the diaries reach the seeder: Ana's with a photo (her media core) ----
  for (const [dev, linked] of [[ana, anaLink], [bia, biaLink]]) {
    const w = await gatedWrite(dev.web, 'cert.add', { cert: linked.cert })
    t.is(w.stopped && w.stopped.result.seederConfirmed, true, 'cert.add reaches the seeder')
  }
  const photo = await ana.node.mediaUpload({ bytes: jpegHead(nodeCrypto.randomBytes(40 * 1024), 64, 48), mime: 'image/jpeg', width: 64, height: 48 })
  t.is(photo.core, ana.mediaKey)
  const anaPost = await gatedWrite(ana.web, 'post.create', { text: 'olá da varanda', media: [photo] })
  t.is(anaPost.stopped && anaPost.stopped.result.seederConfirmed, true, 'Ana\'s photo post reaches the seeder')
  await gatedWrite(bia.web, 'post.create', { text: 'bom dia' })
  // The media core travels on a continuous run (as e2e-media.test.js).
  const { runId: anaRun } = await ana.web.request('sync.start', {})
  await until(() => seeder.admittedKeys().includes(ana.key) && seeder.admittedKeys().includes(bia.key), { ...WAIT, name: 'semeador admite Ana e Bia' })
  await until(() => seeder.mediaKeys().includes(ana.mediaKey), { ...WAIT, name: 'semeador admite o núcleo de mídia de Ana' })
  t.pass('seeder: Ana\'s diary and media core admitted')
  await ana.web.request('sync.stop')
  await stoppedOf(ana.web.events, anaRun)
  t.comment('setup ' + (Date.now() - began) + ' ms')

  // ---- Ana's data in every account-service store (Bia's too, as control) ----
  const pk = { ana: createFakePasskey({ rpId: RP }), bia: createFakePasskey({ rpId: RP }) }
  const week = new Date(weekStartMs(now())).toISOString()
  // A second mark for the week of the deletion sweep (or the next one): the
  // first rolls off when the clock passes its week, this one is still live
  // then, so only the purge can take Ana's.
  const sweepWeek = new Date(weekStartMs(now() + WAIT_MS + DAY_MS)).toISOString()
  for (const [name, dev] of [['ana', ana], ['bia', bia]]) {
    const m = dev.key
    await ages.record({ member: m, band: '18+', method: 'didit' })
    await pushStore.put({ member: m, endpoint: 'https://fcm.googleapis.com/fcm/send/' + m.slice(0, 16), p256dh: b4a.toString(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]), 'base64url'), auth: b4a.toString(crypto.randomBytes(16), 'base64url') })
    await recovery.put({ member: m, kind: 'code', lookupId: hex(crypto.randomBytes(32)), blob: { v: 1, kind: 'code', nonce: hex(crypto.randomBytes(24)), ciphertext: hex(crypto.randomBytes(82)) } })
    await invites.issue(m)
    await drops.markNotified(m, week, [0])
    await drops.markNotified(m, sweepWeek, [0])
    await seen.put({ member: m, blob: crypto.randomBytes(SEEN_BLOB_BYTES), expectedHash: HASH_NONE })
    const key = keyFromAttestation({ attestationObject: pk[name].attestationObject(), credentialId: pk[name].credentialId, rpId: RP })
    await passkeys.add({ member: m, credentialId: pk[name].credentialId, ...key })
    await deletionRequests.record(m)
  }
  // Pages: Ana is an admin of another member's page (p1, kept on the
  // owner's signed roster) and has a pending invite to a second one (p2),
  // with the invite roster written above; Bia has one too.
  await pagesStore.create({ page: p1, owner })
  await pagesStore.create({ page: p2, owner })
  await pagesStore.invite(p1, ana.key, { gen: 2, rosterSignature: hex(crypto.randomBytes(64)) })
  const accepted = pagesStore.accept(p1, ana.key)
  await pagesStore.setRoster(p1, { gen: accepted.gen, seq: 3, owner, admins: accepted.admins })
  for (const who of [ana.key, bia.key]) await pagesStore.invite(p2, who, { gen: 2, rosterSignature: hex(crypto.randomBytes(64)) })

  // Reports through the real routes: one by Ana about Bia (left open), one
  // by Ana about Carol (decided 'bloquear'), one by Bia about Ana (open).
  const carol = hexKey()
  const byAnaOpen = await report(ORIGIN, ana, { target: bia.key, reason: 'spam', text: 'propaganda' })
  t.is(byAnaOpen.status, 200, 'Ana reports Bia: ' + byAnaOpen.text)
  const byAnaBlock = await report(ORIGIN, ana, { target: carol, seq: 1, reason: 'ilegal', text: 'conteúdo ilegal', quote: 'trecho citado da publicação' })
  t.is(byAnaBlock.status, 200, 'Ana reports Carol: ' + byAnaBlock.text)
  await moderation.decide(byAnaBlock.body.id, { decision: 'bloquear', by: 'moderadora@example.test' })
  const aboutAna = await report(ORIGIN, bia, { target: ana.key, reason: 'spam', text: 'robô' })
  t.is(aboutAna.status, 200, 'Bia reports Ana: ' + aboutAna.text)
  // AI triage copies left by an earlier run: a read, a mark and a
  // precedent about Ana, the same about Bia.
  const ledger = openLedger(accountDir, { now })
  const exemplars = openExemplarStore(accountDir, { now, model: 'fake-bow-1' })
  for (const [id, target] of [[aboutAna.body.id, ana.key], [byAnaOpen.body.id, bia.key]]) {
    ledger.putRead(id, { target, seq: 1, contentHash: 'cd'.repeat(32), text: TRIAGE_TEXT, hasMedia: false, hasQuote: false, hasPoll: false, textCp: Array.from(TRIAGE_TEXT).length, truncated: false, embedding: quantize(fakeEmbed(TRIAGE_TEXT)) })
    ledger.mark(id, { code: 'frio' })
    exemplars.add({ reportId: b4a.toString(crypto.randomBytes(16), 'base64url'), target, seq: 2, reason: 'spam', decision: 'descartar', contentHash: 'ef'.repeat(32), text: TRIAGE_TEXT, hasMedia: false, embedding: quantize(fakeEmbed(TRIAGE_TEXT)) })
  }
  for (const dev of [ana, bia]) {
    t.ok(pagesStore.holdsMember(dev.key) || dev === bia, 'pages: the pending state is there before')
    t.ok(drops.holds(dev.key) && seen.get(dev.key) !== null && passkeys.holds(dev.key) && invites.holds(dev.key) && deletionRequests.holds(dev.key), 'every store holds the member before')
  }

  // ---- the deletion: asked without a passkey assertion, it waits 7 days ----
  const started = await post(ORIGIN, '/account/delete/start', { member: ana.key })
  t.is(started.status, 200, started.text)
  t.is(started.body.username, 'ana')
  t.alike(started.body.passkeys, [pk.ana.credentialId], 'the stored passkey is listed')
  const { signature } = await ana.web.request('account.sign', { phase: 'delete', nonce: started.body.nonce, username: 'ana', sub: '' })
  const asked = await post(ORIGIN, '/account/delete/finish', { member: ana.key, nonce: started.body.nonce, signature, wait: true })
  t.is(asked.status, 200, asked.text)
  t.ok(typeof asked.body.scheduled === 'string', 'scheduled, 7 days ahead')
  t.is((await getJson(ORIGIN + '/account/status?member=' + ana.key)).body.scheduledDeletion, asked.body.scheduled, 'every device learns the date')
  clock.offset = WAIT_MS - 60000
  await server.deletionSweep()
  t.is(store.status(ana.key).linked, true, 'not before its date')
  clock.offset = WAIT_MS + 60000
  t.alike(await server.deletionSweep(), { members: 1, pending: 0 }, 'the sweep runs the deletion at its date and purges every store')
  t.ok(logs.some((l) => l.includes('"agendada-executada"')))

  // ---- the account service, component by component ----
  t.is(store.status(ana.key).linked, false, 'directory: the link (sub, certificate, records) is gone')
  t.ok(store.deletedAt(ana.key) !== null, 'directory: the deleted mark stays (refuses re-admission)')
  t.is(store.lookup('ana'), null, 'directory: the name resolves to no one')
  t.is(store.status(bia.key).linked, true, 'directory: Bia stays')
  t.alike(terms.list(ana.key), [], 'terms.json: gone')
  t.is(ages.get(ana.key), null, 'age.json: gone')
  t.is(pushStore.devices(ana.key), 0, 'push.json: gone')
  t.alike(recovery.list(ana.key), [], 'recovery.json: gone')
  const recoveryTombs = Object.values(readJsonFile(path.join(accountDir, 'recovery.json')).removed).filter((x) => x.member === ana.key)
  t.is(recoveryTombs.length, 1, 'recovery.json: the 30-day removal mark stays, with her public key')
  t.is(invites.holds(ana.key), false, 'invites.json: the invites she issued are gone')
  t.is(drops.holds(ana.key), false, 'invite-drops.json: her marks are gone')
  t.ok(drops.holds(bia.key), 'invite-drops.json: Bia keeps hers (the week of the sweep)')
  t.is(seen.get(ana.key), null, 'seen/<member>: the blob is gone')
  t.is(passkeys.holds(ana.key), false, 'passkeys.json: the key and the schedule are gone')
  const passkeyFile = readJsonFile(path.join(accountDir, 'passkeys.json'))
  t.absent(JSON.stringify(passkeyFile.members).includes(ana.key), 'passkeys.json: no member row names her')
  t.ok(passkeyFile.removed[ana.key] && typeof passkeyFile.removed[ana.key].removedAt === 'string', 'passkeys.json: the 30-day removal mark stays')
  t.is(phones.live(ana.key), null, 'phone.json: the live row is ended')
  t.is(deletionRequests.holds(ana.key), false, 'deletion-requests.json: her SMS request is gone')
  const disclosed = () => openPhoneStore(accountDir, { key: phoneKey, now, disclose: true }).reveal(ana.key)
  t.alike(disclosed().map((r) => r.end), ['excluida'], 'phone.json: the sealed number stays for the 180-day retention')
  t.absent(pagesStore.holdsMember(ana.key), 'pages.json: her pending invite is gone')
  t.alike(pagesStore.get(p1).admins, [ana.key], 'pages.json: the owner\'s signed admins list waits for the owner\'s Remover')
  t.alike(Object.keys(pagesStore.get(p2).invites), [bia.key], 'pages.json: Bia\'s invite stays')
  t.alike(Object.keys(readJsonFile(rostersFile).rows), [p2 + ':' + bia.key], 'page-invite-rosters.json: her roster is gone')
  const ledgerNow = openLedger(accountDir)
  t.is(ledgerNow.read(aboutAna.body.id), null, 'AI triage: the cached read about her is gone')
  t.is(ledgerNow.get(aboutAna.body.id), null, 'AI triage: the mark about her is gone')
  const precedents = openExemplarStore(accountDir, { model: 'fake-bow-1' }).list()
  t.absent(precedents.some((e) => e.target === ana.key), 'AI triage: her precedents are gone')
  t.ok(precedents.some((e) => e.target === bia.key), 'AI triage: the precedent about Bia stays')
  t.ok(ledgerNow.read(byAnaOpen.body.id), 'AI triage: the copy about Bia stays')
  for (const [label, held] of [['terms', terms.list(bia.key).length === 1], ['age', ages.get(bia.key) !== null], ['push', pushStore.devices(bia.key) === 1], ['recovery', recovery.list(bia.key).length === 1], ['invites', invites.holds(bia.key)], ['seen', seen.get(bia.key) !== null], ['passkeys', passkeys.holds(bia.key)], ['deletion-requests', deletionRequests.holds(bia.key)], ['phone', phones.live(bia.key) !== null]]) {
    t.ok(held, label + ': Bia keeps hers')
  }
  t.ok(moderation.get(aboutAna.body.id), 'moderation.json: the reports stay until the 180-day pass')
  const pendingBlock = moderation.pending().changes.filter((c) => c.member === ana.key)
  t.alike(pendingBlock.map((c) => [c.op, c.by]), [['block', 'titular']], 'moderation.json: her block is queued, asked by the member')
  t.alike((await getJson(ORIGIN + '/account/status?member=' + ana.key)).body, { linked: false, deleted: 'pendente' }, 'status: pendente until the list holds the key')
  t.ok(seeder.admittedKeys().includes(ana.key), 'seeder: still serving until the list arrives')

  // ---- the operator's hourly `mod apply --yes`: the list reaches the seeder ----
  const applyLines = []
  const release = await lockDataDir(modDir)
  let applyStatus
  try {
    applyStatus = await modApply.apply({
      dir: modDir,
      association,
      server: ORIGIN,
      newList: true,
      json: false,
      yes: true,
      interactive: false,
      publish: (s) => modPublish.publish({ snapshot: s, association, seeder: seederKey, bootstrap, host: '127.0.0.1', timeoutMs: 30000 }),
      print: (line) => applyLines.push(line)
    })
  } finally {
    release()
  }
  t.is(applyStatus, 0, 'mod apply: ' + applyLines.join(' | '))
  await until(() => seeder.stats().blocklistSeq === 1, { ...WAIT, name: 'semeador adota seq 1' })
  t.alike(readBlocklist(seedDir).snapshot.blocked, [ana.key, carol].sort(), 'blocklist: Ana (titular) and Carol (moderation)')
  await until(() => seeder.stats().dropping === 0 && !seeder.admittedKeys().includes(ana.key), { ...WAIT, name: 'Ana fora do semeador' })
  t.absent(seeder.mediaKeys().includes(ana.mediaKey), 'seeder: her media core is dropped')
  t.ok(seeder.admittedKeys().includes(bia.key), 'seeder: Bia stays')
  const admittedFile = readJsonFile(path.join(seedDir, 'admitted.json'))
  t.ok(admittedFile !== null && JSON.stringify(admittedFile).includes(bia.key), 'seeder admitted.json: written, and it names Bia')
  t.absent(JSON.stringify(admittedFile).includes(ana.key), 'seeder admitted.json: no row names her diary')
  t.absent(JSON.stringify(admittedFile).includes(ana.mediaKey), 'seeder admitted.json: no row names her media core')
  for (const file of stampFiles) {
    await until(() => !(ana.key in readJsonFile(path.join(seedDir, file)).days), { ...WAIT, name: file + ' sem Ana' })
    t.ok(bia.key in readJsonFile(path.join(seedDir, file)).days, 'seeder ' + file + ': her stamp rows are pruned, Bia\'s stay')
  }
  t.alike((await getJson(ORIGIN + '/account/status?member=' + ana.key)).body, { linked: false, deleted: 'concluida' }, 'status: concluida once the published list holds the key')
  t.alike(moderation.pending().changes, [], 'moderation.json: the block is acked')

  // ---- re-admission is refused by the service and by the seeder ----
  const relink = await post(ORIGIN, '/account/start', { member: ana.key, username: 'ana2', invite: (await invites.issue(inviter)).code })
  t.is(relink.body && relink.body.error, 'conta-excluida', 'account service: her key cannot link again (' + relink.status + ')')
  const again = await post(ORIGIN, '/account/delete/start', { member: ana.key })
  t.is(again.status, 409, 'account service: a second deletion answers the deleted mark')
  const squatter = await post(ORIGIN, '/account/start', { member: hexKey(), username: 'ana', invite: (await invites.issue(inviter)).code })
  t.is(squatter.body && squatter.body.error, 'nome-em-uso', 'directory: the name stays burned (' + squatter.status + ')')
  const fromRejected = seedEvents.length
  await ana.web.request('post.create', { text: 'voltei?' })
  const { runId: comeback } = await ana.web.request('sync.start', {})
  await until(() => seedEvents.slice(fromRejected).some((e) => e.event === 'rejected' && e.reason === 'blocked'), { ...WAIT, name: 'semeador recusa Ana' })
  await ana.web.request('sync.stop')
  await stoppedOf(ana.web.events, comeback)
  t.absent(seeder.admittedKeys().includes(ana.key), 'seeder: her diary is refused (rejected, blocked)')
  t.absent(logs.some((l) => l.includes(ana.key)), 'account service log: no line names her key')

  // ---- 180 days after the deletion: the moderation and phone retention ends ----
  const quoteBefore = moderation.get(byAnaBlock.body.id).quote
  t.is(quoteBefore, 'trecho citado da publicação', 'moderation.json: her report about Carol carries a quote')
  clock.offset = WAIT_MS + MODERATION_RETENTION_MS - DAY_MS
  await server.deletionSweep()
  t.ok(moderation.get(aboutAna.body.id), 'moderation.json: nothing goes before the 180 days')
  // The phone routes' hourly sweep does not tick here, and the moderation
  // pass runs it only once its 180 days are due, so the 179-day check runs
  // the store's sweep itself, with the callbacks server.js gives it.
  const blockedNow = (m) => moderation.blocked().some((x) => x.member === m)
  await phones.sweep({
    linked: (m) => store.status(m).linked,
    deleted: (m) => store.deletedAt(m) !== null,
    burnable: (m, since) => blockedNow(m) && (store.deletedAt(m) === null || moderation.blockReportsAfter(m, since) > 0),
    cleared: (m, since) => {
      if (moderation.held(m) || moderation.blockReportsAfter(m, since) === 0) return false
      const at = store.deletedAt(m)
      return at === null || moderation.blockReportsAfter(m, at) === 0
    },
    blocked: blockedNow
  })
  t.is(disclosed().length, 1, 'phone.json: nor the sealed number, with the phone sweep run')
  clock.offset = WAIT_MS + MODERATION_RETENTION_MS + 2 * DAY_MS
  await server.deletionSweep()
  t.is(moderation.get(aboutAna.body.id), null, 'moderation.json: the report about her is gone')
  t.is(moderation.get(byAnaOpen.body.id), null, 'moderation.json: her open report is gone')
  const kept = moderation.get(byAnaBlock.body.id)
  t.ok(kept, 'moderation.json: her report behind a block still in force stays')
  t.is(kept && kept.reporter, null, 'moderation.json: with no reporter')
  t.is(kept && kept.quote, quoteBefore, 'moderation.json: the quote stays (the ground of the block)')
  t.is(kept && kept.text, '', 'moderation.json: her comment goes')
  t.alike(disclosed(), [], 'phone.json: the sealed number is gone')
  t.ok(store.deletedAt(ana.key) !== null, 'directory: the deleted mark stays for good (refuses re-admission)')
  t.ok(readBlocklist(seedDir).snapshot.blocked.includes(ana.key), 'blocklist: her block stays for good')
  t.ok(store.status(bia.key).linked && phones.live(bia.key) !== null, 'Bia is untouched by the retention pass')
})
