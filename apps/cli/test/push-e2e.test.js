'use strict'

// End to end, loopback only: a diary append becomes one encrypted Web Push.
// The pieces: a real Seeder whose onPush feeds createPushRelay, which POSTs
// to the /push-event route of an in-process account service (real account,
// terms and push stores in a temp dir, a VAPID key made here), which
// encrypts and sends to a fake push service on 127.0.0.1. The subscription
// endpoint stays an allowlisted fcm.googleapis.com URL: only the injected
// fetch rewrites the origin, so the allowlist is never widened and no socket
// leaves 127.0.0.1. The members are linked in-process; B opts in with a real
// diary-key proof and A's follow, reply, like and repost reach B's browser.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, followRecord, likeRecord, repostRecord, profileRecord } = require('@varanda/core/lib/records')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPushStore } = require('../lib/account/push-store')
const { generateVapidKeys, sendPush, isAllowedEndpoint } = require('../lib/account/web-push')
const { createAccountServer } = require('../lib/account/server')
const { createPushRelay } = require('../lib/push-relay')

const ORIGIN = 'https://varanda.test'
const MINUTE = 60000
const COOLDOWN = 600 * 1000

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recent () {
  return new Date(Date.now() - MINUTE).toISOString()
}

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest()
const TOPIC_KEY = nodeCrypto.randomBytes(32)
const topicOf = (actor, seq) => nodeCrypto.createHmac('sha256', TOPIC_KEY).update(actor + ':' + seq).digest('hex').slice(0, 32)

// RFC 8291 decryption written here, independently of web-push.js.
function decrypt (message, uaPrivate, authB64u) {
  const hmac = (key, data) => nodeCrypto.createHmac('sha256', key).update(data).digest()
  const hkdf = (salt, ikm, info, length) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length)
  const salt = message.subarray(0, 16)
  const idlen = message[20]
  const asPublic = message.subarray(21, 21 + idlen)
  const ciphertext = message.subarray(21 + idlen)
  const ua = nodeCrypto.createECDH('prime256v1')
  ua.setPrivateKey(uaPrivate)
  const shared = ua.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\u0000'), ua.getPublicKey(), asPublic])
  const ikm = hkdf(Buffer.from(authB64u, 'base64url'), shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\u0000'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\u0000'), 12)
  const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // RFC 8188 section 2: strip trailing zero padding, then the 0x02 delimiter.
  let end = padded.length - 1
  while (end > 0 && padded[end] === 0) end--
  if (padded[end] !== 0x02) throw new Error('bad delimiter')
  return padded.subarray(0, end).toString('utf8')
}

// A browser subscription on an allowlisted host, with the private half kept
// to decrypt what the fake push service receives.
function subscription () {
  const ua = nodeCrypto.createECDH('prime256v1')
  ua.generateKeys()
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + nodeCrypto.randomBytes(16).toString('hex'),
    p256dh: ua.getPublicKey().toString('base64url'),
    auth: nodeCrypto.randomBytes(16).toString('base64url'),
    uaPrivate: ua.getPrivateKey()
  }
}

// The push service double: records every POST and answers the status set
// for its path (201 by default).
async function fakePushService (t) {
  const received = []
  const statusOf = new Map()
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      res.statusCode = statusOf.get(req.url) ?? 201
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)), { force: true })
  const base = 'http://127.0.0.1:' + server.address().port
  const hosts = []
  // Injected as sendPush's fetch: only after sendPush checked the allowlist.
  const fetch = (url, init) => {
    const u = new URL(url)
    hosts.push(u.host)
    return globalThis.fetch(base + u.pathname, init)
  }
  return { received, statusOf, fetch, hosts }
}

function prepareSeederDir (t, assoc) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  return { dataDir, publicKey }
}

// A member with a compat diary dialing the seeder; `records(key)` are
// appended before it ever connects (history).
async function member (t, bootstrap, assoc, seederKey, records = () => []) {
  const kp = signingKeyPair()
  const diary = new Hypercore(tmpDir(t, 'varanda-compat-'), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await diary.ready()
  t.teardown(() => diary.close(), { force: true })
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, assoc.kp)))
  await diary.append(postRecord({ text: 'oi', at: recent() }))
  for (const r of records(key)) await diary.append(r)
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    diary.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const m = { diary, key, hex: key, kp, messages, peers }
  m.seederPeer = () => until(() => [...peers].reverse().find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  m.message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 30000 })
  return m
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: createCert({ member: m.key }, assoc.kp) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

async function grown (m, record) {
  await m.diary.append(record)
  const seq = m.diary.length - 1
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return seq
}

async function linkDirect (accounts, iss, m, username, sub, email) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

test('push e2e: diary append to one encrypted POST, and every silent path stays silent', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }

  // The account service: one association for the seeder and the issuer.
  const accountDir = path.join(tmpDir(t), 'account')
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const issuerKp = signingKeyPair()
  const iss = { keyPair: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp), association: assoc.hex }
  const accounts = openAccountStore(accountDir, { now })
  const terms = openTermsStore(accountDir, { now })
  const pushStore = openPushStore(accountDir, { now })
  const vapid = { ...generateVapidKeys(), subject: ORIGIN }
  const relayToken = nodeCrypto.randomBytes(32).toString('hex')
  const push = await fakePushService(t)
  const logs = []
  const server = createAccountServer({
    association: assoc.hex,
    origin: ORIGIN,
    google,
    store: accounts,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    terms,
    push: {
      pushStore,
      vapid,
      send: (args) => sendPush({ ...args, fetch: push.fetch, now: now() }),
      relayTokenHash: sha256(relayToken),
      topicKey: TOPIC_KEY
    },
    log: (e) => logs.push(JSON.stringify(e)),
    now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function post (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }
  async function toggle (who, action, sub) {
    const started = await post('/account/push/start', { member: who.hex, action })
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    const signature = signPush({ nonce, member: who.hex, association: assoc.hex, action, endpointHash: endpointHash(sub.endpoint), p256dh: sub.p256dh, auth: sub.auth }, who.kp)
    return post('/account/push/finish', { member: who.hex, nonce, action, signature, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
  }
  const check = (who, sub) => post('/account/push/check', { member: who.hex, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })

  // The relay and the seeder: every candidate the seeder emits is relayed.
  const relay = createPushRelay({ baseUrl: base, token: relayToken })
  t.teardown(() => relay.close())
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  let pushes = []
  let accepted = 0
  async function startSeeder () {
    const seeder = new Seeder({
      dataDir,
      associationKey: assoc.hex,
      ...localSwarmOptions(bootstrap),
      log: (e) => { if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e)) },
      onPush: (e) => {
        pushes.push(e)
        if (relay.send(e)) accepted++
      }
    })
    t.teardown(() => seeder.close(), { force: true })
    await seeder.start()
    return seeder
  }
  let seeder = await startSeeder()

  // Every relayed event answered and every send to the push service done.
  async function settle () {
    await until(() => {
      const r = relay.stats()
      const p = server.pushStats()
      return r.pending === 0 && r.inflight === 0 && r.sent + r.failed === accepted && p.queued === 0 && p.inFlight === 0
    }, { name: 'relay e envios em dia', timeoutMs: 30000 })
  }

  // B: the recipient, admitted first so A's records aim at a served member.
  const B = await member(t, bootstrap, assoc, publicKey)
  await admit(B, assoc)
  await linkDirect(accounts, iss, B, 'bia', '1111111111111111111111', 'bia@example.test')
  await terms.accept({ member: B.hex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })

  const sub = subscription()
  const on = await toggle(B, 'on', sub)
  t.alike(on.body, { ok: true, changed: true }, 'B registers with a real proof: ' + on.text)
  t.alike((await check(B, sub)).body, { registered: true }, 'check: registered after on')

  // A: a profile name and, before it is ever served, a follow, a reply, a
  // like and a repost aimed at B (history).
  const ref = B.key + ':1'
  const bPost = { author: B.key, seq: 1 }
  const A = await member(t, bootstrap, assoc, publicKey, () => [
    profileRecord({ name: 'Ana Lima', at: recent() }),
    followRecord({ key: B.key, on: true, at: recent() }),
    postRecord({ text: 'resposta antiga', replyTo: bPost, at: recent() }),
    likeRecord({ to: bPost, on: true, at: recent() }),
    repostRecord({ to: bPost, on: true, at: recent() })
  ])
  await linkDirect(accounts, iss, A, 'ana', '2222222222222222222222', 'ana@example.test')
  await terms.accept({ member: A.hex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  await admit(A, assoc)
  await until(() => seeder._index.hints(A.key).profileSeq === 2, { name: 'perfil de A indexado' })

  function opened (got) {
    return JSON.parse(decrypt(got.body, sub.uaPrivate, sub.auth))
  }
  const subPath = new URL(sub.endpoint).pathname
  const topics = (from) => push.received.slice(from).map((r) => r.headers.topic)

  // Live appends: one POST each, decrypting to the notice for B.
  const live = []
  live.push(['follow', await grown(A, followRecord({ key: B.key, on: true, at: recent() })), null])
  live.push(['reply', await grown(A, postRecord({ text: 'concordo', replyTo: bPost, at: recent() })), ref])
  live.push(['like', await grown(A, likeRecord({ to: bPost, on: true, at: recent() })), ref])
  live.push(['repost', await grown(A, repostRecord({ to: bPost, on: true, at: recent() })), ref])
  await until(() => push.received.length >= 4, { name: 'quatro POSTs', timeoutMs: 30000 })
  await settle()
  await delay(300)
  const sentences = {
    follow: 'Ana Lima começou a seguir você',
    reply: 'Ana Lima respondeu ao seu post',
    like: 'Ana Lima curtiu seu post',
    repost: 'Ana Lima republicou seu post'
  }
  t.is(push.received.length, 4, 'history sent nothing; each live append sent exactly one POST')
  for (const [kind, seq, r] of live) {
    const got = push.received.filter((x) => x.headers.topic === topicOf(A.key, seq))
    t.is(got.length, 1, kind + ': one POST')
    t.is(got[0].path, subPath, kind + ': to B\'s subscription')
    t.is(got[0].headers['content-encoding'], 'aes128gcm')
    t.alike(opened(got[0]), { v: 1, kind, body: sentences[kind], actor: A.key, recipient: B.key, ref: r }, kind + ': decrypts with B\'s keys')
  }
  const lengthOf = (kind) => push.received.find((x) => x.headers.topic === topicOf(A.key, live.find((l) => l[0] === kind)[1])).body.length
  t.is(lengthOf('follow'), lengthOf('like'), 'a follow and a like have the same ciphertext length')
  t.ok(push.hosts.every((h) => h === 'fcm.googleapis.com'), 'sendPush only ever addressed the allowlisted host')

  // A follow from A, past the account service's cooldown, as a positive
  // marker: every block appended before it was decided by then.
  async function sentinel () {
    await settle()
    clock.offset += COOLDOWN
    const seq = await grown(A, followRecord({ key: B.key, on: true, at: recent() }))
    const topic = topicOf(A.key, seq)
    await until(() => push.received.some((r) => r.headers.topic === topic), { name: 'sentinela ' + seq, timeoutMs: 30000 })
    await settle()
    await delay(300)
    return topic
  }

  // Unfollow: silent.
  let mark = push.received.length
  await grown(A, followRecord({ key: B.key, on: false, at: recent() }))
  let s = await sentinel()
  t.alike(topics(mark), [s], 'unfollow sent nothing')

  // A like on a seq B never wrote: silent.
  mark = push.received.length
  await grown(A, likeRecord({ to: { author: B.key, seq: 999 }, on: true, at: recent() }))
  s = await sentinel()
  t.alike(topics(mark), [s], 'like on a nonexistent seq sent nothing')

  // like on, off, on within the cooldown: one POST.
  await settle()
  clock.offset += COOLDOWN
  mark = push.received.length
  const l1 = await grown(A, likeRecord({ to: bPost, on: true, at: recent() }))
  await grown(A, likeRecord({ to: bPost, on: false, at: recent() }))
  const l2 = await grown(A, likeRecord({ to: bPost, on: true, at: recent() }))
  await until(() => pushes.some((p) => p.actor === A.key && p.seq === l2), { name: 'segunda curtida emitida', timeoutMs: 30000 })
  s = await sentinel()
  t.alike(topics(mark), [topicOf(A.key, l1), s], 'like on/off/on sent one POST')

  // A forced index rebuild: silent.
  mark = push.received.length
  seeder._rebuildIndex()
  await until(() => {
    const e = seeder._served.get(A.key)
    return e && !seeder._indexRebuildQueued && e.indexed >= A.diary.length
  }, { name: 'índice reconstruído' })
  s = await sentinel()
  t.alike(topics(mark), [s], 'rebuild sent nothing')

  // A seeder restart over the same data dir: silent for stored blocks.
  await settle()
  await seeder.close()
  pushes = []
  mark = push.received.length
  seeder = await startSeeder()
  await until(() => seeder._served.has(A.key) && seeder._served.has(B.key), { name: 'servidos após reinício' })
  A.messages.length = 0
  B.messages.length = 0
  s = await sentinel()
  t.alike(topics(mark), [s], 'restart sent nothing for stored blocks')

  // The push service answers 410: the row goes and the next event sends
  // nothing.
  push.statusOf.set(subPath, 410)
  mark = push.received.length
  s = await sentinel()
  t.alike(topics(mark), [s], 'the 410 event reached the push service once')
  await until(() => pushStore.list(B.hex).length === 0, { name: 'inscrição removida' })
  t.alike((await check(B, sub)).body, { registered: false }, 'check: gone after 410')
  push.statusOf.delete(subPath)
  clock.offset += COOLDOWN
  mark = push.received.length
  const quiet = await grown(A, followRecord({ key: B.key, on: true, at: recent() }))
  await until(() => pushes.some((p) => p.actor === A.key && p.seq === quiet), { name: 'evento após 410', timeoutMs: 30000 })
  await settle()
  await delay(300)
  t.is(push.received.length, mark, 'no POST after the 410 removed the subscription')

  // On again, then finish 'off': removed, and the next event sends nothing.
  t.alike((await toggle(B, 'on', sub)).body, { ok: true, changed: true }, 'on again')
  t.alike((await check(B, sub)).body, { registered: true }, 'check: registered after on again')
  mark = push.received.length
  s = await sentinel()
  t.alike(topics(mark), [s], 'sends again once on')
  t.alike((await toggle(B, 'off', sub)).body, { ok: true, changed: true }, 'off')
  t.alike(pushStore.list(B.hex), [], 'off removed the row')
  t.alike((await check(B, sub)).body, { registered: false }, 'check: false after off')
  clock.offset += COOLDOWN
  mark = push.received.length
  const afterOff = await grown(A, followRecord({ key: B.key, on: true, at: recent() }))
  await until(() => pushes.some((p) => p.actor === A.key && p.seq === afterOff), { name: 'evento após off', timeoutMs: 30000 })
  await settle()
  await delay(300)
  t.is(push.received.length, mark, 'no POST after off')

  t.ok(isAllowedEndpoint(sub.endpoint), 'the endpoint stayed an allowlisted URL')
  const all = logs.join('\n')
  t.absent(all.includes(sub.endpoint) || all.includes('Ana Lima') || all.includes(relayToken), 'no endpoint, name or token in the logs')
  t.is(relay.stats().failed, 0, 'every relay POST was accepted')
})
