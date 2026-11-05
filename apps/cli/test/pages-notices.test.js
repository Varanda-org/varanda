'use strict'

// apps/cli/lib/account/pages-notices.js: a page's notices read over a
// short-lived loopback WebSocket link to a real Seeder (local DHT only),
// every row re-verified against the author's signed blocks.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { WebSocket, createWebSocketStream } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair, seederCertForKey } = require('@varanda/core/lib/cert')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, followRecord, profileRecord } = require('@varanda/core/lib/records')
const { noticePayload } = require('@varanda/core/lib/notices')
const { NOTICE_V2_PROOF_PREFIX } = require('@varanda/core/lib/notices-v2')
const { attachNoticesV2 } = require('@varanda/core/lib/notices-net')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { startSeedWs } = require('../lib/seed-ws')
const { openPageKeys } = require('../lib/account/page-keys')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesNotices } = require('../lib/account/pages-notices')

const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', {
  paths: [path.dirname(require.resolve('@varanda/core/lib/seeder'))]
}))

const PAGE_KEYS = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

const BASE = Date.now() - 3600000
function at (i) {
  return new Date(BASE + i * 1000).toISOString()
}

let nonceCount = 0
function nonce () {
  nonceCount++
  return (String(nonceCount) + 'n'.repeat(43)).slice(0, 43)
}

function setup () {
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  return { assocKp, association, issuerKp, issuerCert }
}

function newPage (ctx, keys, username) {
  const { key, row } = keys.pending(nonce())
  keys.put(key, row)
  const cert = createIssuedCert({ member: key }, ctx.issuerKp, ctx.issuerCert)
  const usernameRecord = createUsernameRecord({ member: key, username }, ctx.issuerKp, ctx.issuerCert)
  const owner = crypto.keyPair()
  const fields = { page: key, gen: 1, owner: hex(owner.publicKey), admins: [], prev: null, at: new Date().toISOString(), nonce: nonce(), association: ctx.association }
  const signature = signRoster(fields, owner)
  const rosterRecord = issuerCountersign({ type: 'page-roster', ...fields, signature }, ctx.issuerKp, ctx.issuerCert)
  return { key, row, args: { cert, usernameRecord, rosterRecord } }
}

async function startSeeder (t, bootstrap, ctx) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, ctx.association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, ctx.assocKp)))
  Seeder.addCert(dataDir, certFile, ctx.association)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: ctx.association, log: noop })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, publicKey }
}

// A member diary (compat, so its key is its Ed25519 key) that dials the
// seeder over the local DHT and announces itself.
async function member (t, bootstrap, ctx, seederKey, name) {
  const kp = crypto.keyPair()
  const diary = new Hypercore(tmpDir(t, 'varanda-member-'), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await diary.ready()
  t.teardown(() => diary.close(), { force: true })
  const key = hex(diary.key)
  await diary.append(memberCertRecord(createCert({ member: key }, ctx.assocKp)))
  await diary.append(profileRecord({ name, bio: '', at: at(0) }))
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
  const seen = (length) => until(() => messages.find((x) => (x.type === 'have' || x.type === 'admitted') && x.key === key && x.length >= length), { name: 'have ' + length, timeoutMs: 30000 })
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  peer.send({ type: 'announce', key, cert: createCert({ member: key }, ctx.assocKp) })
  await seen(diary.length)
  return {
    key,
    async add (record) {
      await diary.append(record)
      await seen(diary.length)
      return diary.length - 1
    }
  }
}

// A raw member link on 'varanda/notices/2' that signs the V1 payload for
// the page key: the seeder must refuse it.
function v1ProofLink (port, association, page, secretKey) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/seeder', { perMessageDeflate: false })
    ws.on('error', noop)
    const duplex = createWebSocketStream(ws)
    duplex.on('error', noop)
    const noise = new NoiseSecretStream(true, duplex, { keyPair: crypto.keyPair() })
    noise.on('error', noop)
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      let verified = false
      attachAdmission(noise, {
        role: 'member',
        have: [],
        onmessage: (msg, peer) => {
          if (msg.type === 'hello') verified = msg.role === 'seeder' && seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
        }
      })
      const v2 = attachNoticesV2(noise, {
        role: 'member',
        ownKey: page,
        requestTimeoutMs: 5000,
        sign: (bytes) => {
          if (!verified) throw new Error('not verified')
          const [nonceHex, noiseHex, ownHex] = b4a.toString(bytes, 'utf8').slice(NOTICE_V2_PROOF_PREFIX.length).split('\n')
          return crypto.sign(noticePayload(nonceHex, noiseHex, ownHex), secretKey)
        }
      })
      resolve({ v2, close: () => noise.destroy() })
    })
    noise.once('close', () => reject(new Error('closed')))
  })
}

test('pages-notices: verified follows, replies and mentions of a page; forged, blocked and v1 proofs refused; socket closed', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const { seeder, publicKey: seederKey } = await startSeeder(t, bootstrap, ctx)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + server.port

  const dir = tmpDir(t, 'varanda-account-')
  const env = { VARANDA_PAGE_KEYS: PAGE_KEYS }
  const keys = openPageKeys({ dir, env })
  const writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
  const page = newPage(ctx, keys, 'padaria')
  await writer.createPage(page.args)
  const posted = await writer.append(page.key, [postRecord({ text: 'pão quente', at: at(1) })])
  t.is(posted.pushed, true)

  const A = await member(t, bootstrap, ctx, seederKey, 'Ana')
  const B = await member(t, bootstrap, ctx, seederKey, 'Bia')
  const C = await member(t, bootstrap, ctx, seederKey, 'Caio')
  const follow = followRecord({ key: page.key, on: true, at: at(10) })
  const seqFollow = await A.add(follow)
  const reply = postRecord({ text: 'que delícia', replyTo: { author: page.key, seq: posted.seq }, at: at(11) })
  const seqReply = await A.add(reply)
  const mention = postRecord({ text: 'comprei na @padaria hoje', at: at(12) })
  const seqMention = await B.add(mention)
  const unrelated = postRecord({ text: 'oi @ninguem', at: at(13) })
  await B.add(unrelated)
  const blockedFollow = followRecord({ key: page.key, on: true, at: at(14) })
  await C.add(blockedFollow)

  // The seeder lies on the first page: A's reply claimed at the seq of A's
  // follow. Listed first, it would also hide the real follow row if trusted.
  const forged = { key: A.key, seq: seqFollow, at: reply.at, kind: 'reply' }
  const pageV2 = seeder._postNotices.pageV2.bind(seeder._postNotices)
  seeder._postNotices.pageV2 = (opts) => {
    const r = pageV2(opts)
    if (opts.target === page.key && opts.after === null) r.items = [forged, ...r.items].slice(0, 64)
    return r
  }

  const logs = []
  const blocked = new Set([C.key])
  const notices = createPagesNotices({
    keys,
    writer,
    seederWs,
    association: ctx.association,
    blocklist: { has: (k) => blocked.has(k) },
    env,
    log: (e) => logs.push(e),
    limits: { cacheTtlMs: 0 }
  })
  t.teardown(() => notices.close(), { force: true })
  const baseline = seeder._external.size

  const result = await until(async () => {
    const r = await notices.read(page.key, { limit: 30 })
    return r.notices.length >= 3 && !r.incomplete ? r : null
  }, { name: 'three verified rows', intervalMs: 500, timeoutMs: 60000 })

  t.is(result.supported, true)
  t.is(result.activity, true)
  t.is(result.next, null)
  for (const row of result.notices) t.ok(/^[0-9a-f]{32}$/.test(row.seen), 'seen token')
  t.alike(result.notices.map(({ seen, ...rest }) => rest), [
    { kind: 'mention', key: B.key, seq: seqMention, at: mention.at, name: 'Bia', username: null, avatar: null },
    { kind: 'reply', key: A.key, seq: seqReply, at: reply.at, name: 'Ana', username: null, avatar: null },
    { kind: 'follow', key: A.key, seq: seqFollow, at: follow.at, name: 'Ana', username: null, avatar: null }
  ], 'a follow and a reply of A, a mention of B; the forged row, the blocked author and an unrelated post are dropped')

  // seen is stable for one page and row.
  const again = await notices.read(page.key, { limit: 30 })
  t.alike(again.notices.map((r) => r.seen), result.notices.map((r) => r.seen))

  // The blocked author's row appears once the block is lifted.
  blocked.delete(C.key)
  const withC = await notices.read(page.key, { limit: 30 })
  t.ok(withC.notices.some((r) => r.key === C.key && r.kind === 'follow'), 'C shows once not blocked')

  // The read's socket is gone.
  await until(() => seeder._external.size <= baseline, { name: 'socket closed', timeoutMs: 10000 })
  t.pass('the read socket is closed after the read')

  // A v1-prefixed proof never opens the v2 channel.
  const row = keys.get(page.key)
  const raw = await v1ProofLink(server.port, ctx.association, page.key, row.secretKey)
  t.teardown(() => raw.close(), { force: true })
  await t.exception(raw.v2.requestPage({ after: null, limit: 10 }), 'v1 proof refused')
  raw.close()

  // Arguments.
  await t.exception(notices.read('zz', {}), /invalido/)
  await t.exception(notices.read(page.key, { limit: 65 }), /invalido/)
  await t.exception(notices.read(page.key, { after: { at: 'x', key: A.key } }), /invalido/)
  await t.exception(notices.read('ab'.repeat(32), {}), /nao-encontrada/)

  // Nothing logged names a key or a secret.
  const text = JSON.stringify(logs)
  for (const k of [page.key, A.key, B.key, C.key, hex(row.secretKey), PAGE_KEYS]) t.absent(text.includes(k), 'no key in logs')
  t.ok(logs.every((e) => Object.keys(e).sort().join(',') === 'event,reason' && e.event === 'page-notices'), 'log shape')
})

test('pages-notices: cache, one read in flight per page, off without VARANDA_PAGE_KEYS', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const { seeder } = await startSeeder(t, bootstrap, ctx)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + server.port
  const dir = tmpDir(t, 'varanda-account-')
  const env = { VARANDA_PAGE_KEYS: PAGE_KEYS }
  const keys = openPageKeys({ dir, env })
  const writer = createPagesWriter({ dir, keys, association: ctx.association, seederWs })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  await until(() => writer.connected(), { name: 'link up', timeoutMs: 20000 })
  const page = newPage(ctx, keys, 'feira')
  await writer.createPage(page.args)

  t.exception.all(() => createPagesNotices({ keys, writer, seederWs: 'http://example.com:80', association: ctx.association }), /loopback/)
  const off = createPagesNotices({ keys, writer, seederWs, association: ctx.association, env: {} })
  await t.exception(off.read(page.key, {}), /desligado/)

  const notices = createPagesNotices({ keys, writer, seederWs, association: ctx.association, env })
  t.teardown(() => notices.close(), { force: true })
  const first = notices.read(page.key, { limit: 10 })
  const joined = notices.read(page.key, { limit: 10 })
  await t.exception(notices.read(page.key, { limit: 11 }), /ocupado/, 'another read of the page is refused while one runs')
  const [r1, r2] = await Promise.all([first, joined])
  t.alike(r1, r2, 'the same read is shared')
  t.alike(r1, { notices: [], next: null, incomplete: false, supported: true, activity: true })
  const before = seeder._external.size
  const cached = await notices.read(page.key, { limit: 10 })
  t.alike(cached, r1)
  t.is(seeder._external.size, before, 'a cached read opens no socket')
  notices.close()
  await t.exception(notices.read(page.key, {}), /fechado/)
})
