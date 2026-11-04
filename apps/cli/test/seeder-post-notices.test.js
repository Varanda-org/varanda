// Post notices at the seeder (packages/core/lib/seeder.js, post-notices.js,
// notices-net.js attachNoticesV2): the diary scan folds the posts and
// username records of every served diary, and 'varanda/notices/2' serves
// replies, quotes and @nome mentions merged with the follows, only to a
// connection that proved it owns the target key. 'varanda/notices/3' adds
// likes and reposts of the target's posts from the engagement index.
// 'varanda/notices/1' stays follow-only. Proving members hold their diary in compat mode with an
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
const { memberCertRecord, postRecord, followRecord, likeRecord, repostRecord, deleteRecord } = require('@varanda/core/lib/records')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const { attachNotices, attachNoticesV2, attachNoticesV3 } = require('@varanda/core/lib/notices-net')
const { validateNoticesV2Message } = require('@varanda/core/lib/notices-v2')

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

// A proving member with every notices channel: compat diary dialing the
// seeder directly, with the admission channel. `v3: 'none'` never opens
// varanda/notices/3; `v3: 'v2-proof'` answers its challenge with a v2 proof.
async function provingMember (t, bootstrap, assoc, seederKey, { v3 = 'proof' } = {}) {
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
  const v3Opts = v3 === 'v2-proof'
    ? {
        ...noticeOpts,
        requestTimeoutMs: 3000,
        sign: (payload) => signNoticeProof(b4a.from(b4a.toString(payload, 'utf8').replace(/^varanda-notices-v3\n/, 'varanda-notices-v2\n'), 'utf8'), kp)
      }
    : noticeOpts
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    diary.replicate(socket)
    attachNotices(socket, noticeOpts)
    attachNoticesV2(socket, noticeOpts)
    if (v3 !== 'none') attachNoticesV3(socket, v3Opts)
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
  m.pageV3 = pageOf(attachNoticesV3)
  m.pageUntil = until2(m.page)
  m.pageV2Until = until2(m.pageV2)
  m.pageV3Until = until2(m.pageV3)
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

function hasKeyedRow (page, key, seq, kind) {
  return page.items.some((it) => it.key === key && it.seq === seq && it.kind === kind)
}

test('likes and reposts on the proved v3 channel only; toggles, tombstones, deletes and blocks remove them; v2 unchanged', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()

  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const A = await provingMember(t, bootstrap, assoc, publicKey)
  const B = await provingMember(t, bootstrap, assoc, publicKey)
  const C = await provingMember(t, bootstrap, assoc, publicKey)
  const D = await provingMember(t, bootstrap, assoc, publicKey, { v3: 'v2-proof' })
  const E = await provingMember(t, bootstrap, assoc, publicKey, { v3: 'none' })
  for (const m of [A, B, C, D, E]) await admit(m, assoc)

  const post = { author: A.key, seq: 1 }
  const follow = followRecord({ key: A.key, on: true, at: at(20) })
  const seqFollow = await grown(B, follow)
  const like = likeRecord({ to: post, on: true, at: at(21) })
  const seqLike = await grown(B, like)
  const repost = repostRecord({ to: post, on: true, at: at(22) })
  const seqRepost = await grown(B, repost)

  // Every diary scanned and indexed, nothing at a cap: the page is final.
  const full = await A.pageV3Until((p) => p.items.length === 3 && !p.incomplete, 'A vê curtida e republicação')
  t.alike(full, {
    items: [
      { key: B.key, seq: seqRepost, at: repost.at, kind: 'repost' },
      { key: B.key, seq: seqLike, at: like.at, kind: 'like' },
      { key: B.key, seq: seqFollow, at: follow.at, kind: 'follow' }
    ],
    next: null,
    incomplete: false
  })
  t.is(seeder._index.stats().saturated, false, 'index not saturated')
  for (const it of full.items) {
    t.alike(Object.keys(it).sort(), ['at', 'key', 'kind', 'seq'])
    t.ok(/^[0-9a-f]{64}$/.test(it.key), 'engager is a hex key')
  }

  // The v2 channel on the same socket never carries an engagement row.
  const v2 = await A.pageV2Until((p) => !p.incomplete, 'A v2 completo')
  t.alike(v2, { items: [{ key: B.key, seq: seqFollow, at: follow.at, kind: 'follow' }], next: null, incomplete: false })
  t.ok(validateNoticesV2Message({ type: 'items', ...v2 }), 'v2 page validates')

  // C is not the author: nothing of A's.
  t.alike(await C.pageV3Until((p) => !p.incomplete, 'C completo'), { items: [], next: null, incomplete: false })

  // A v2 proof never opens v3, and that connection still reads v2.
  t.alike(await D.pageV2Until((p) => !p.incomplete, 'D v2'), { items: [], next: null, incomplete: false })
  await t.exception(D.pageV3(), 'a v2 proof gets no v3 page')
  // A peer that never opens v3 reads v2 as before.
  t.alike(await E.pageV2Until((p) => !p.incomplete, 'E v2'), { items: [], next: null, incomplete: false })

  // Unlike: the like row goes, the repost stays.
  await grown(B, likeRecord({ to: post, on: false, at: at(23) }))
  const unliked = await A.pageV3Until((p) => !hasKeyedRow(p, B.key, seqLike, 'like') && !p.incomplete, 'A sem curtida')
  t.ok(hasKeyedRow(unliked, B.key, seqRepost, 'repost'), 'repost still listed')

  // A tombstone of the repost record removes it.
  await grown(B, deleteRecord({ seq: seqRepost, at: at(24) }))
  const tomb = await A.pageV3Until((p) => !hasKeyedRow(p, B.key, seqRepost, 'repost') && !p.incomplete, 'A sem republicação')
  t.alike(tomb.items, [{ key: B.key, seq: seqFollow, at: follow.at, kind: 'follow' }])

  // Deleting the post removes every engagement aimed at it.
  const post2 = postRecord({ text: 'outra', at: at(25) })
  const seqPost2 = await grown(A, post2)
  const like2 = likeRecord({ to: { author: A.key, seq: seqPost2 }, on: true, at: at(26) })
  const seqLike2 = await grown(B, like2)
  const repost2 = repostRecord({ to: { author: A.key, seq: seqPost2 }, on: true, at: at(27) })
  const seqRepost2 = await grown(B, repost2)
  await A.pageV3Until((p) => hasKeyedRow(p, B.key, seqLike2, 'like') && hasKeyedRow(p, B.key, seqRepost2, 'repost'), 'A vê a segunda publicação engajada')
  await grown(A, deleteRecord({ seq: seqPost2, at: at(28) }))
  const gone = await A.pageV3Until((p) => !p.incomplete && !hasKeyedRow(p, B.key, seqLike2, 'like') && !hasKeyedRow(p, B.key, seqRepost2, 'repost'), 'A sem a publicação apagada')
  t.alike(gone.items, [{ key: B.key, seq: seqFollow, at: follow.at, kind: 'follow' }])

  // A blocked engager's likes vanish and never hide another engager's like.
  const likeB = likeRecord({ to: post, on: true, at: at(29) })
  const seqLikeB = await grown(B, likeB)
  const likeC = likeRecord({ to: post, on: true, at: at(30) })
  const seqLikeC = await grown(C, likeC)
  await A.pageV3Until((p) => hasKeyedRow(p, B.key, seqLikeB, 'like') && hasKeyedRow(p, C.key, seqLikeC, 'like'), 'A vê as duas curtidas')
  const modKp = signingKeyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey), date: '2026-06-01T00:00:00.000Z' }, assoc.kp)
  await pushBlocklist(t, bootstrap, publicKey, createSnapshot({ seq: 1, blocked: [B.key], revokedIssuers: [] }, modKp, modCert))
  await until(() => seeder._isBlocked(B.key), { name: 'B bloqueado' })
  const blocked = await A.pageV3Until((p) => !p.items.some((it) => it.key === B.key), 'A sem B')
  t.alike(blocked.items, [{ key: C.key, seq: seqLikeC, at: likeC.at, kind: 'like' }])

  t.absent(events.some((e) => /notice/.test(e.event || '')), 'no notices log events')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})
