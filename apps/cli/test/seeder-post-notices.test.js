// Post notices at the seeder (packages/core/lib/seeder.js, post-notices.js,
// notices-net.js attachNoticesV2): the diary scan folds the posts and
// username records of every served diary, and 'varanda/notices/2' serves
// replies, quotes and @nome mentions merged with the follows, only to a
// connection that proved it owns the target key. 'varanda/notices/1' stays
// follow-only. Proving members hold their diary in compat mode with an
// explicit key pair, so the diary key IS the Ed25519 public key.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert, generateAssociationKeyPair, createIssuerCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, followRecord } = require('@varanda/core/lib/records')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const { attachNotices, attachNoticesV2 } = require('@varanda/core/lib/notices-net')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function validCert (assoc, key) {
  return createCert({ member: key }, assoc.kp)
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

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
    },
    ...opts
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, events }
}

// Past instants, one second apart, so page order is fixed by the records.
const BASE = Date.now() - 3600000
function at (i) {
  return new Date(BASE + i * 1000).toISOString()
}

// A proving member with both notices channels: compat diary dialing the
// seeder directly, with the admission channel.
async function provingMember (t, bootstrap, assoc, seederKey) {
  const kp = signingKeyPair()
  const diary = new Hypercore(tmpDir(t, 'varanda-compat-'), { keyPair: kp, compat: true, valueEncoding: 'json' })
  await diary.ready()
  t.teardown(() => diary.close(), { force: true })
  const key = hex(diary.key)
  await diary.append(memberCertRecord(validCert(assoc, key)))
  await diary.append(postRecord({ text: 'oi', at: at(0) }))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  const sockets = []
  const noticeOpts = { role: 'member', ownKey: key, sign: (payload) => signNoticeProof(payload, kp) }
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    diary.replicate(socket)
    attachNotices(socket, noticeOpts)
    attachNoticesV2(socket, noticeOpts)
    sockets.push(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const seederSocket = () => {
    const socket = [...sockets].reverse().find((s) => !s.destroyed && s.remotePublicKey && hex(s.remotePublicKey) === seederKey)
    if (!socket) throw new Error('no seeder socket')
    return socket
  }
  const pageOf = (attach) => async () => {
    const h = await until(() => { try { return attach(seederSocket(), noticeOpts) } catch { return null } }, { name: 'canal de avisos' })
    return h.requestPage({ limit: 64 })
  }
  const until2 = (read) => (pred, name) => until(async () => {
    let p
    try {
      p = await read()
    } catch {
      return null
    }
    return pred(p) ? p : null
  }, { name, intervalMs: 250, timeoutMs: 30000 })
  const m = { diary, key, kp, messages, peers }
  m.seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  m.message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 20000 })
  m.page = pageOf(attachNotices)
  m.pageV2 = pageOf(attachNoticesV2)
  m.pageUntil = until2(m.page)
  m.pageV2Until = until2(m.pageV2)
  return m
}

async function admit (m, assoc) {
  const peer = await m.seederPeer()
  peer.send({ type: 'announce', key: m.key, cert: validCert(assoc, m.key) })
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
}

async function grown (m, record) {
  await m.diary.append(record)
  const seq = m.diary.length - 1
  await m.message((x) => x.type === 'have' && x.key === m.key && x.length === m.diary.length, 'have ' + m.diary.length)
  return seq
}

async function pushBlocklist (t, bootstrap, seederKey, snapshot) {
  const store = new Corestore(tmpDir(t, 'varanda-mod-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    attachBlocklist(socket, {
      current: () => snapshot,
      offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
    })
    attachAdmission(socket, { role: 'member', have: [] })
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  return swarm
}

function hasSeq (page, seq) {
  return page.items.some((it) => it.seq === seq)
}

test('post notices: replies, quotes and verified mentions on the proved v2 channel; v1 stays follow-only; blocks hide; nothing persisted', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const issuerKp = signingKeyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey), date: at(0) }, assoc.kp)
  const username = (member, name, i) => createUsernameRecord({ member, username: name, date: at(i) }, issuerKp, issuerCert)

  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const statsKeys = Object.keys(seeder.stats())
  const filesBefore = fs.readdirSync(dataDir).sort()

  const A = await provingMember(t, bootstrap, assoc, publicKey)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  const C = await provingMember(t, bootstrap, assoc, publicKey)
  await admit(A, assoc)
  await admit(B, assoc)
  await admit(C, assoc)

  // A mention of a name nobody verifiably holds yet is never served.
  const mention = postRecord({ text: 'oi @anapaula', at: at(10) })
  const seqMention = await grown(B, mention)
  const early = await A.pageV2Until((p) => !p.incomplete, 'A completo')
  t.alike(early, { items: [], next: null, incomplete: false }, 'no mention before the username record')

  // Once A's username record is scanned, the earlier mention resolves.
  await grown(A, username(A.key, 'anapaula', 11))
  const pM = await A.pageV2Until((p) => hasSeq(p, seqMention) && !p.incomplete, 'A vê a menção')
  t.alike(pM.items, [{ key: B.key, seq: seqMention, at: mention.at, kind: 'mention' }])

  // A reply, a quote and a follow: all on A's page, newest first.
  const reply = postRecord({ text: 'concordo', replyTo: { author: A.key, seq: 1 }, at: at(12) })
  const seqReply = await grown(B, reply)
  const quote = postRecord({ text: 'olha isso', quote: { author: A.key, seq: 1 }, at: at(13) })
  const seqQuote = await grown(B, quote)
  const follow = followRecord({ key: A.key, on: true, at: at(14) })
  const seqFollow = await grown(B, follow)
  const full = await A.pageV2Until((p) => p.items.length === 4 && !p.incomplete, 'A vê quatro avisos')
  t.alike(full, {
    items: [
      { key: B.key, seq: seqFollow, at: follow.at, kind: 'follow' },
      { key: B.key, seq: seqQuote, at: quote.at, kind: 'quote' },
      { key: B.key, seq: seqReply, at: reply.at, kind: 'reply' },
      { key: B.key, seq: seqMention, at: mention.at, kind: 'mention' }
    ],
    next: null,
    incomplete: false
  })

  // The v1 channel is unchanged: follows only, no kind.
  t.alike(await A.pageUntil((p) => p.items.length === 1 && !p.incomplete, 'A v1'), {
    items: [{ key: B.key, seq: seqFollow, at: follow.at }],
    next: null,
    incomplete: false
  })

  // A newer username keeps the old name's mentions, old and new.
  await grown(A, username(A.key, 'anabeatriz', 15))
  const again = postRecord({ text: '@anapaula de novo', at: at(16) })
  const seqAgain = await grown(B, again)
  const renamed = await A.pageV2Until((p) => hasSeq(p, seqAgain) && !p.incomplete, 'A vê a menção antiga')
  t.ok(hasSeq(renamed, seqMention), 'the old-name mention is still served')
  t.alike(renamed.items[0], { key: B.key, seq: seqAgain, at: again.at, kind: 'mention' })

  // C proved its own key: nothing of A's.
  t.alike(await C.pageV2Until((p) => !p.incomplete, 'C completo'), { items: [], next: null, incomplete: false })

  // Blocking B removes every row it authored, on both channels.
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, modKp, modCert))
  await until(() => seeder._isBlocked(B.key), { name: 'B bloqueado' })
  t.alike(await A.pageV2Until((p) => p.items.length === 0, 'A sem B'), { items: [], next: null, incomplete: false })
  t.alike(await A.page(), { items: [], next: null, incomplete: false })

  // Nothing persisted, nothing new in stats.
  t.alike(Object.keys(seeder.stats()), statsKeys, 'stats keys unchanged')
  const filesAfter = fs.readdirSync(dataDir).sort().filter((f) => !filesBefore.includes(f))
  t.absent(filesAfter.some((f) => /notice|mention/i.test(f)), 'no notices file: ' + filesAfter.join(','))
  t.absent(events.some((e) => /notice/.test(e.event || '')), 'no notices log events')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
