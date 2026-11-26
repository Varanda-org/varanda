'use strict'

// lib/blocklist.js: the snapshot bytes (golden vector), every rejection of
// verifySnapshot, the acceptSnapshot / compareSnapshots order, the size
// bound, the atomic adoption queue and that the module stays pure; the same
// for the hidden-posts list (#225).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const cert = require('../lib/cert')
const bl = require('../lib/blocklist')

const coreRoot = path.join(__dirname, '..')
const LF = '\n'

// Golden vector shared with docs/protocol.md section 3: association seed =
// 32 bytes 0x01, issuer seed 0x02, moderator seed 0x03.
const GOLDEN_ASSOC = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c'
const GOLDEN_ISSUER = '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394'
const GOLDEN_MODERATOR = 'ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1'
const GOLDEN_MODERATOR_SIG = '00c028052fd43e7518b5825298baf5ef2d194670421b6422c4211f3b1d3f9a2839b6cec54e628c416c8367191a69628bc2e3db5d4263781df11de781fbe9920d'
const GOLDEN_SNAPSHOT_SIG = 'b9b1a5e572534604be3a2708153777b74e6df23e054f22ae874dd3d13ddf80a7bc761491a9529a36514bd6ec2c5f11b069c78065420be2eafc40cf37b9e7960f'
const MOD_DATE = '2026-10-24T00:00:00.000Z'
const SNAP_DATE = '2026-10-24T12:00:00.000Z'
const A = 'ab'.repeat(32)
const C = 'cd'.repeat(32)
const E = 'ef'.repeat(32)

function setup (moderatorDate = MOD_DATE, assocKp = crypto.keyPair()) {
  const modKp = crypto.keyPair()
  const modCert = cert.createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: moderatorDate }, assocKp)
  const assocHex = b4a.toString(assocKp.publicKey, 'hex')
  const snap = (seq, blocked = [], revokedIssuers = []) => bl.createSnapshot({ seq, date: SNAP_DATE, blocked, revokedIssuers }, modKp, modCert)
  return { assocKp, assocHex, modKp, modCert, snap }
}

function hexKey (i) {
  return i.toString(16).padStart(64, '0')
}

test('snapshot golden vector', (t) => {
  const assocKp = crypto.keyPair(b4a.alloc(32, 1))
  const modKp = crypto.keyPair(b4a.alloc(32, 3))
  const modCert = cert.createModeratorCert({ moderator: GOLDEN_MODERATOR, date: MOD_DATE }, assocKp)
  t.is(modCert.signature, GOLDEN_MODERATOR_SIG)
  const s = bl.createSnapshot({ seq: 1, date: SNAP_DATE, blocked: [C, A.toUpperCase()], revokedIssuers: [GOLDEN_ISSUER] }, modKp, modCert)
  t.alike(Object.keys(s), ['v', 'seq', 'date', 'blocked', 'revokedIssuers', 'moderator', 'moderatorDate', 'moderatorSignature', 'signature'])
  t.alike(s, {
    v: 1,
    seq: 1,
    date: SNAP_DATE,
    blocked: [A, C],
    revokedIssuers: [GOLDEN_ISSUER],
    moderator: GOLDEN_MODERATOR,
    moderatorDate: MOD_DATE,
    moderatorSignature: GOLDEN_MODERATOR_SIG,
    signature: GOLDEN_SNAPSHOT_SIG
  })
  const expected = b4a.from([
    'varanda-blocklist-v1', '1', SNAP_DATE, A + ',' + C, GOLDEN_ISSUER, GOLDEN_MODERATOR, MOD_DATE, GOLDEN_MODERATOR_SIG
  ].join(LF), 'utf8')
  t.ok(b4a.equals(bl.snapshotPayload(s), expected))
  t.is(bl.validateSnapshotShape(s), null)
  t.alike(bl.verifySnapshot(s, GOLDEN_ASSOC), { ok: true })
  t.alike(bl.verifySnapshot(s, GOLDEN_ASSOC.toUpperCase()), { ok: true })
  t.alike(bl.verifySnapshot(JSON.parse(JSON.stringify(s)), GOLDEN_ASSOC), { ok: true }, 'survives JSON')

  // empty lists are '' lines
  const empty = bl.createSnapshot({ seq: 12, date: SNAP_DATE }, modKp, modCert)
  t.alike(empty.blocked, [])
  t.alike(empty.revokedIssuers, [])
  const emptyPayload = ['varanda-blocklist-v1', '12', SNAP_DATE, '', '', GOLDEN_MODERATOR, MOD_DATE, GOLDEN_MODERATOR_SIG].join(LF)
  t.is(b4a.toString(bl.snapshotPayload(empty), 'utf8'), emptyPayload)
  t.alike(bl.verifySnapshot(empty, GOLDEN_ASSOC), { ok: true })
})

test('createSnapshot normalizes and refuses bad input', (t) => {
  const { modKp, modCert, snap } = setup()
  t.alike(snap(1, [E, A, C, A.toUpperCase()], [C, A]).blocked, [A, C, E], 'lowercase, sorted, distinct')
  t.alike(snap(1, [], [C, A, C]).revokedIssuers, [A, C])
  t.exception.all(() => snap(0), /seq/)
  t.exception.all(() => snap(1.5), /seq/)
  t.exception.all(() => snap(Number.MAX_SAFE_INTEGER + 1), /seq/)
  t.exception.all(() => bl.createSnapshot({ seq: 1, date: 'today' }, modKp, modCert), /date/)
  t.exception.all(() => snap(1, ['zz']), /blocked/)
  t.exception.all(() => snap(1, 'x'), /blocked/)
  t.exception.all(() => snap(1, [], ['zz']), /revokedIssuers/)
  t.exception.all(() => snap(1, Array.from({ length: bl.MAX_BLOCKED + 1 }, (_, i) => hexKey(i))), /blocked/)
  t.exception.all(() => snap(1, [], Array.from({ length: bl.MAX_REVOKED_ISSUERS + 1 }, (_, i) => hexKey(i))), /revokedIssuers/)
  t.exception.all(() => bl.createSnapshot({ seq: 1 }, {}, modCert), /key pair/)
  t.exception.all(() => bl.createSnapshot({ seq: 1 }, crypto.keyPair(), modCert), /another key/)
  t.exception.all(() => bl.createSnapshot({ seq: 1 }, modKp, { ...modCert, extra: 1 }), /moderator certificate/)
  t.exception.all(() => bl.createSnapshot({ seq: 1 }, modKp, { ...modCert, date: '2026-10-25T00:00:00.000Z' }), /moderator certificate/)
})

test('verifySnapshot rejections', (t) => {
  const { assocKp, assocHex, modKp, modCert, snap } = setup()
  const s = snap(3, [A, C], [E])
  t.alike(bl.verifySnapshot(s, assocHex), { ok: true })
  const resign = (o) => ({ ...o, signature: b4a.toString(crypto.sign(bl.snapshotPayload(o), modKp.secretKey), 'hex') })
  const without = { ...s }
  delete without.revokedIssuers
  const malformed = {
    'missing key': without,
    'extra key': { ...s, association: assocHex },
    'v 2': resign({ ...s, v: 2 }),
    'seq 0': resign({ ...s, seq: 0 }),
    'seq as string': resign({ ...s, seq: '3' }),
    'unsafe seq': resign({ ...s, seq: 2 ** 53 }),
    'bad date': resign({ ...s, date: '2026-13-01T00:00:00.000Z' }),
    'non-canonical moderatorDate': { ...s, moderatorDate: '2026-10-24' },
    'unsorted blocked': resign({ ...s, blocked: [C, A] }),
    'duplicate blocked': resign({ ...s, blocked: [A, A] }),
    'uppercase blocked': resign({ ...s, blocked: [A.toUpperCase(), C] }),
    'short key blocked': resign({ ...s, blocked: [A.slice(2)] }),
    'blocked not an array': { ...s, blocked: A },
    'oversized blocked': resign({ ...s, blocked: Array.from({ length: bl.MAX_BLOCKED + 1 }, (_, i) => hexKey(i)) }),
    'unsorted revokedIssuers': resign({ ...s, revokedIssuers: [E, A] }),
    'duplicate revokedIssuers': resign({ ...s, revokedIssuers: [E, E] }),
    'oversized revokedIssuers': resign({ ...s, revokedIssuers: Array.from({ length: bl.MAX_REVOKED_ISSUERS + 1 }, (_, i) => hexKey(i)) }),
    'uppercase moderator': { ...s, moderator: s.moderator.toUpperCase() },
    'short signature': { ...s, signature: s.signature.slice(2) },
    'moderator equal to association': { ...s, moderator: assocHex }
  }
  for (const [name, v] of Object.entries(malformed)) {
    t.alike(bl.verifySnapshot(v, assocHex), { ok: false, reason: 'malformed' }, name)
  }
  t.alike(bl.verifySnapshot(s, 'zz'), { ok: false, reason: 'malformed' })
  t.alike(bl.verifySnapshot(s, null), { ok: false, reason: 'malformed' })

  // the moderator certificate
  const other = setup()
  t.alike(bl.verifySnapshot(s, other.assocHex), { ok: false, reason: 'bad-moderator-signature' }, 'moderator of another association')
  t.alike(bl.verifySnapshot(resign({ ...s, moderatorDate: '2026-10-25T00:00:00.000Z' }), assocHex), { ok: false, reason: 'bad-moderator-signature' }, 'moderatorDate changed')
  t.alike(bl.verifySnapshot(resign({ ...s, moderatorSignature: other.modCert.signature }), assocHex), { ok: false, reason: 'bad-moderator-signature' })

  // an issuer (certified by the same association) cannot moderate: its
  // delegation signature uses another prefix
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: MOD_DATE }, assocKp)
  const byIssuer = { ...s, moderator: issuerCert.issuer, moderatorDate: issuerCert.date, moderatorSignature: issuerCert.signature }
  byIssuer.signature = b4a.toString(crypto.sign(bl.snapshotPayload(byIssuer), issuerKp.secretKey), 'hex')
  t.alike(bl.verifySnapshot(byIssuer, assocHex), { ok: false, reason: 'bad-moderator-signature' }, 'issuer-signed snapshot')
  // nor can a seeder certificate's key
  const seederCert = cert.createSeederCert({ seeder: issuerCert.issuer, date: MOD_DATE }, assocKp)
  t.alike(bl.verifySnapshot({ ...byIssuer, moderatorSignature: seederCert.signature }, assocHex), { ok: false, reason: 'bad-moderator-signature' })

  // the snapshot signature binds every field
  const tampered = {
    'blocked removed': { ...s, blocked: [A] },
    'blocked added': { ...s, blocked: [A, C, E] },
    'revokedIssuers cleared': { ...s, revokedIssuers: [] },
    'seq bumped': { ...s, seq: 4 },
    'date changed': { ...s, date: '2026-10-25T00:00:00.000Z' }
  }
  for (const [name, v] of Object.entries(tampered)) {
    t.alike(bl.verifySnapshot(v, assocHex), { ok: false, reason: 'bad-signature' }, name)
  }
  // signed by the association instead of the moderator
  const byAssoc = { ...s, signature: b4a.toString(crypto.sign(bl.snapshotPayload(s), assocKp.secretKey), 'hex') }
  t.alike(bl.verifySnapshot(byAssoc, assocHex), { ok: false, reason: 'bad-signature' })
  t.ok(modCert)
})

test('size: 16384 blocked keys fit MAX_SNAPSHOT_BYTES, 16385 are malformed', (t) => {
  t.is(bl.MAX_BLOCKED, 16384)
  t.is(bl.MAX_SNAPSHOT_BYTES, 1179648)
  // A seeder never serves more logs than one snapshot can block.
  t.ok(bl.MAX_BLOCKED >= require('../lib/admission').MAX_INVENTORY, 'MAX_BLOCKED >= MAX_INVENTORY')
  // the longest canonical dates (expanded years)
  const longDate = '+275760-09-13T00:00:00.000Z'
  t.ok(cert.isCanonicalIso(longDate))
  const { assocHex, modKp, modCert } = setup(longDate)
  const blocked = Array.from({ length: bl.MAX_BLOCKED }, (_, i) => hexKey(i))
  const revokedIssuers = Array.from({ length: bl.MAX_REVOKED_ISSUERS }, (_, i) => hexKey(i + 1).replace(/^0/, 'f'))
  const s = bl.createSnapshot({ seq: Number.MAX_SAFE_INTEGER, date: longDate, blocked, revokedIssuers }, modKp, modCert)
  const bytes = b4a.byteLength(JSON.stringify(s))
  t.ok(bytes <= bl.MAX_SNAPSHOT_BYTES, 'largest snapshot is ' + bytes + ' bytes')
  t.alike(bl.verifySnapshot(s, assocHex), { ok: true })
  const over = { ...s, blocked: blocked.concat([hexKey(bl.MAX_BLOCKED)]) }
  over.signature = b4a.toString(crypto.sign(bl.snapshotPayload(over), modKp.secretKey), 'hex')
  t.alike(bl.verifySnapshot(over, assocHex), { ok: false, reason: 'malformed' })
  t.exception.all(() => bl.createSnapshot({ seq: 1, date: longDate, blocked: over.blocked }, modKp, modCert), /blocked holds more than 16384 keys/)
})

test('acceptSnapshot and compareSnapshots', (t) => {
  const assocKp = crypto.keyPair()
  const first = setup(MOD_DATE, assocKp)
  const rival = setup(MOD_DATE, assocKp)
  const newer = setup('2026-10-25T00:00:00.000Z', assocKp)
  const assocHex = first.assocHex
  const s1 = first.snap(1, [A])
  const s2 = first.snap(2, [A, C])
  const s100 = first.snap(100, [])
  const n1 = newer.snap(1, [E])
  const r5 = rival.snap(5, [C])

  t.alike(bl.acceptSnapshot(null, s1, assocHex), { ok: true })
  t.alike(bl.acceptSnapshot(undefined, s1, assocHex), { ok: true })
  t.alike(bl.acceptSnapshot(s1, s2, assocHex), { ok: true }, 'higher seq')
  t.alike(bl.acceptSnapshot(s2, s1, assocHex), { ok: false, reason: 'stale' }, 'lower seq')
  t.alike(bl.acceptSnapshot(s1, s1, assocHex), { ok: false, reason: 'same' })
  t.alike(bl.acceptSnapshot(s1, JSON.parse(JSON.stringify(s1)), assocHex), { ok: false, reason: 'same' })
  // equivocation: same moderator and seq, another signature -> first wins
  t.alike(bl.acceptSnapshot(s1, first.snap(1, [C]), assocHex), { ok: false, reason: 'stale' })
  // a newer moderator replaces an older one and its seq restarts
  t.alike(bl.acceptSnapshot(s100, n1, assocHex), { ok: true }, 'newer moderatorDate')
  t.alike(bl.acceptSnapshot(n1, s100, assocHex), { ok: false, reason: 'stale' }, 'older moderatorDate')
  // a second moderator with the same date: the first stored wins
  t.alike(bl.acceptSnapshot(s1, r5, assocHex), { ok: false, reason: 'stale' })
  t.alike(bl.acceptSnapshot(r5, s100, assocHex), { ok: false, reason: 'stale' })
  // next must verify
  t.alike(bl.acceptSnapshot(null, { ...s1, seq: 9 }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(bl.acceptSnapshot(s1, { ...s2, blocked: [] }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(bl.acceptSnapshot(null, s1, setup().assocHex), { ok: false, reason: 'bad-moderator-signature' })
  t.alike(bl.acceptSnapshot(null, null, assocHex), { ok: false, reason: 'malformed' })

  // compareSnapshots: moderatorDate first, then seq
  t.is(bl.compareSnapshots(s1, s2), -1)
  t.is(bl.compareSnapshots(s2, s1), 1)
  t.is(bl.compareSnapshots(s1, s1), 0)
  t.is(bl.compareSnapshots(s100, n1), -1)
  t.is(bl.compareSnapshots(n1, s100), 1)
  t.is(bl.compareSnapshots(s1, r5), -1, 'same date: by seq (acceptSnapshot still keeps the first moderator)')
  // `have` values and nothing
  const have = (s) => ({ type: 'have', moderatorDate: s.moderatorDate, seq: s.seq })
  const none = { type: 'have', moderatorDate: '', seq: 0 }
  t.is(bl.compareSnapshots(have(s2), s2), 0)
  t.is(bl.compareSnapshots(have(s1), have(n1)), -1)
  t.is(bl.compareSnapshots(none, have(s1)), -1)
  t.is(bl.compareSnapshots(have(s1), none), 1)
  t.is(bl.compareSnapshots(none, null), 0)
  t.is(bl.compareSnapshots(null, s1), -1)
  // expanded years compare by time, not as strings
  t.is(bl.compareSnapshots({ moderatorDate: '+010000-01-01T00:00:00.000Z', seq: 1 }, { moderatorDate: '2026-10-24T00:00:00.000Z', seq: 1 }), 1)
  // the order agrees with acceptSnapshot on every accepted pair
  for (const [prev, next] of [[s1, s2], [s100, n1], [null, s1]]) {
    t.ok(bl.acceptSnapshot(prev, next, assocHex).ok)
    t.is(bl.compareSnapshots(next, prev), 1)
  }
})

test('blockedSet, revokedIssuerSet and isBlocked', (t) => {
  const { snap } = setup()
  const s = snap(1, [A, C], [E])
  const set = bl.blockedSet(s)
  t.ok(bl.isBlocked(set, A))
  t.ok(bl.isBlocked(set, C.toUpperCase()))
  t.absent(bl.isBlocked(set, E))
  t.absent(bl.isBlocked(set, null))
  t.absent(bl.isBlocked(null, A))
  t.alike([...bl.revokedIssuerSet(s)], [E])
  t.is(bl.blockedSet(null).size, 0)
  t.is(bl.revokedIssuerSet(null).size, 0)
  // a revoked set plugs straight into the certificate verifiers
  t.ok(bl.revokedIssuerSet(s) instanceof Set)
})

test('verifySnapshot, acceptSnapshot and compareSnapshots never throw', (t) => {
  const { assocHex, snap } = setup()
  const s = snap(2, [A])
  const hostile = {}
  for (const k of Object.keys(s)) Object.defineProperty(hostile, k, { enumerable: true, get () { throw new Error('boom') } })
  const flipping = { ...s }
  let n = 0
  Object.defineProperty(flipping, 'blocked', { enumerable: true, get () { return n++ === 0 ? [A] : [C, A] } })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const inputs = [null, undefined, 0, 'x', [], Object.create(null), revoked.proxy, hostile, flipping, { ...s, blocked: [A, 5] }, { ...s, blocked: new Array(3) }]
  for (const v of inputs) {
    t.execution(() => {
      if (bl.verifySnapshot(v, assocHex).ok) throw new Error('verifySnapshot accepted')
      if (bl.acceptSnapshot(s, v, assocHex).ok) throw new Error('acceptSnapshot accepted')
      if (bl.acceptSnapshot(v, v, assocHex).ok) throw new Error('acceptSnapshot accepted')
      bl.acceptSnapshot(v, s, assocHex)
      bl.compareSnapshots(v, s)
      bl.compareSnapshots(s, v)
      bl.validateSnapshotShape(v)
      bl.blockedSet(v)
      bl.revokedIssuerSet(v)
    })
  }
})

test('createBlocklistState: load, offer, atomic adoption', async (t) => {
  const assocKp = crypto.keyPair()
  const { assocHex, snap } = setup(MOD_DATE, assocKp)
  const s1 = snap(1, [A, C])
  const s2 = snap(2, [C, E], [E])
  const s3 = snap(3, [E])

  t.exception.all(() => bl.createBlocklistState({ association: 'zz', save () {} }), /association/)
  t.exception.all(() => bl.createBlocklistState({ association: assocHex }), /save/)

  const saved = []
  const state = bl.createBlocklistState({ association: assocHex, load: async () => null, save: async (s) => { saved.push(s.seq) } })
  await state.ready()
  t.is(state.current(), null)
  t.is(state.blocked().size, 0)

  const a1 = await state.offer(s1)
  t.is(a1.adopted, true)
  t.is(a1.reason, null)
  t.alike([...a1.added].sort(), [A, C])
  t.is(a1.removed.size, 0)
  t.alike(state.current(), s1)
  t.not(state.current(), s1, 'a copy is stored')
  t.ok(state.blocked().has(A))

  const same = await state.offer(s1)
  t.alike({ adopted: same.adopted, reason: same.reason }, { adopted: false, reason: 'same' })
  t.is(same.added.size + same.removed.size, 0)
  t.alike((await state.offer({ ...s2, seq: 9 })).reason, 'bad-signature')
  t.alike((await state.offer(null)).reason, 'malformed')

  // racing offers: s3 queued before s2; inside the queue s2 is compared with
  // s3 (not with s1) and is stale, so s2 is never adopted
  const [r3, r2] = await Promise.all([state.offer(s3), state.offer(s2)])
  t.is(r3.adopted, true)
  t.alike([...r3.added], [E])
  t.alike([...r3.removed].sort(), [A, C])
  t.alike({ adopted: r2.adopted, reason: r2.reason }, { adopted: false, reason: 'stale' })
  t.is(state.current().seq, 3)
  t.alike(saved, [1, 3], 'saved only what was adopted, in order')

  // a failing save rejects that offer and keeps the previous snapshot
  let fail = true
  const flaky = bl.createBlocklistState({
    association: assocHex,
    load: () => s1,
    save: async () => { if (fail) throw new Error('disk full') }
  })
  await flaky.ready()
  t.is(flaky.current().seq, 1, 'sync load adopted')
  await t.exception(flaky.offer(s2), /disk full/)
  t.is(flaky.current().seq, 1)
  t.ok(flaky.blocked().has(A))
  fail = false
  const ok2 = await flaky.offer(s2)
  t.is(ok2.adopted, true)
  t.alike([...ok2.revokedAdded], [E])
  t.alike([...ok2.removed], [A])
  t.alike([...flaky.revokedIssuers()], [E])
  const ok3 = await flaky.offer(s3)
  t.alike([...ok3.revokedRemoved], [E])

  // a stored snapshot that does not verify for the association is ignored
  const foreign = bl.createBlocklistState({ association: setup().assocHex, load: () => s3, save () {} })
  await foreign.ready()
  t.is(foreign.current(), null)

  // a failing load fails closed: ready() and every offer reject
  const broken = bl.createBlocklistState({ association: assocHex, load: async () => { throw new Error('unreadable') }, save () {} })
  await t.exception(broken.ready(), /unreadable/)
  await t.exception(broken.offer(s1), /unreadable/)
  await t.exception(broken.offer(s2), /unreadable/)
  t.is(broken.current(), null)
})

// cert.js itself loads '#fs' (key pair files), so only the module's OWN
// requires are pinned, and nothing it pulls in may be a network module.
test('accept and load use the verified copy, never a second read', async (t) => {
  const { assocHex, snap } = setup()
  const s1 = snap(1, [A])
  const s2 = snap(2, [A])
  // seq reads 1 (signed) the first time and 3 afterwards: verification must
  // not pass on one value and the replay check on another.
  const tricky = { ...s1 }
  let seqReads = 0
  Object.defineProperty(tricky, 'seq', { enumerable: true, get: () => (seqReads++ === 0 ? 1 : 3) })
  const verdict = bl.acceptSnapshot(s2, tricky, assocHex)
  t.is(verdict.ok, false, 'a signed seq 1 never replaces seq 2')

  // blocked reads [A] (signed) the first time and [] afterwards: the loaded
  // snapshot must be the verified one.
  const stored = { ...s1 }
  let blockedReads = 0
  Object.defineProperty(stored, 'blocked', { enumerable: true, get: () => (blockedReads++ === 0 ? [A] : []) })
  const state = bl.createBlocklistState({ association: assocHex, load: async () => stored, save: async () => {} })
  await state.ready()
  const cur = state.current()
  if (cur !== null) {
    t.ok(bl.verifySnapshot(cur, assocHex).ok, 'whatever was adopted verifies')
    t.ok(state.blocked().has(A) || cur.blocked.length === 0, 'adopted set matches the adopted snapshot')
    t.alike(cur.blocked, [...state.blocked()], 'blocked() is the adopted snapshot')
  } else {
    t.pass('nothing adopted')
  }
})

// The hidden-posts list (#225): its own prefix, key set, seq and order.
const GOLDEN_HIDDEN_SIG = '0f0e64a250bd2313dcef643f5167450b7b34a66366473896194db7247092da91ea7952c27d6ff2eaf6d558fab341260fe93e654fcfbae8a1eaa396ba12578d06'

function hiddenSetup (moderatorDate = MOD_DATE, assocKp = crypto.keyPair()) {
  const base = setup(moderatorDate, assocKp)
  const hide = (seq, hiddenPosts = []) => bl.createHiddenList({ seq, date: SNAP_DATE, hiddenPosts }, base.modKp, base.modCert)
  return { ...base, hide }
}

test('hidden-posts list golden vector', (t) => {
  const assocKp = crypto.keyPair(b4a.alloc(32, 1))
  const modKp = crypto.keyPair(b4a.alloc(32, 3))
  const modCert = cert.createModeratorCert({ moderator: GOLDEN_MODERATOR, date: MOD_DATE }, assocKp)
  const h = bl.createHiddenList({ seq: 1, date: SNAP_DATE, hiddenPosts: [C + ':7', A + ':3', { author: A.toUpperCase(), seq: 12 }] }, modKp, modCert)
  t.alike(Object.keys(h), bl.HIDDEN_KEYS)
  t.alike(h, {
    v: 1,
    seq: 1,
    date: SNAP_DATE,
    // string order, not numeric: ':12' sorts before ':3'
    hiddenPosts: [A + ':12', A + ':3', C + ':7'],
    moderator: GOLDEN_MODERATOR,
    moderatorDate: MOD_DATE,
    moderatorSignature: GOLDEN_MODERATOR_SIG,
    signature: GOLDEN_HIDDEN_SIG
  })
  const expected = ['varanda-hidden-posts-v1', '1', SNAP_DATE, [A + ':12', A + ':3', C + ':7'].join(','), GOLDEN_MODERATOR, MOD_DATE, GOLDEN_MODERATOR_SIG].join(LF)
  t.is(b4a.toString(bl.hiddenPayload(h), 'utf8'), expected)
  t.alike(bl.verifyHiddenList(h, GOLDEN_ASSOC), { ok: true })
  // An empty list is a valid list: it gives back every hidden post.
  const empty = bl.createHiddenList({ seq: 2, date: SNAP_DATE }, modKp, modCert)
  t.alike(empty.hiddenPosts, [])
  t.alike(bl.verifyHiddenList(empty, GOLDEN_ASSOC), { ok: true })
})

test('createHiddenList normalizes and refuses bad input', (t) => {
  const { modKp, modCert } = hiddenSetup()
  const h = bl.createHiddenList({ seq: 3, date: SNAP_DATE, hiddenPosts: [A + ':5', A.toUpperCase() + ':5', { author: E, seq: 1 }] }, modKp, modCert)
  t.alike(h.hiddenPosts, [A + ':5', E + ':1'], 'lowercased and deduplicated')
  for (const bad of [[A + ':0'], [A + ':05'], [A + ':1.5'], [{ author: A, seq: 1.5 }], [{ author: 'zz', seq: 1 }], ['x'], [A]]) {
    t.exception.all(() => bl.createHiddenList({ seq: 1, hiddenPosts: bad }, modKp, modCert), /hiddenPosts/, JSON.stringify(bad))
  }
  t.exception.all(() => bl.createHiddenList({ seq: 1, hiddenPosts: 'x' }, modKp, modCert), /hiddenPosts/)
  const tooMany = Array.from({ length: bl.MAX_HIDDEN_POSTS + 1 }, (_, i) => A + ':' + (i + 1))
  t.exception.all(() => bl.createHiddenList({ seq: 1, hiddenPosts: tooMany }, modKp, modCert), /hiddenPosts/)
  t.exception.all(() => bl.createHiddenList({ seq: 0 }, modKp, modCert), /seq/)
  t.exception.all(() => bl.createHiddenList({ seq: 1, date: '2026-10-24' }, modKp, modCert), /date/)
  t.exception.all(() => bl.createHiddenList({ seq: 1 }, crypto.keyPair(), modCert), /moderator/)
})

test('verifyHiddenList rejections', (t) => {
  const { assocHex, modKp, modCert, hide } = hiddenSetup()
  const h = hide(4, [A + ':12', A + ':3', E + ':7'])
  t.alike(bl.verifyHiddenList(h, assocHex), { ok: true })
  const resign = (o) => ({ ...o, signature: b4a.toString(crypto.sign(bl.hiddenPayload(o), modKp.secretKey), 'hex') })
  const without = { ...h }
  delete without.hiddenPosts
  const malformed = {
    'missing key': without,
    'extra key': { ...h, blocked: [] },
    'v 2': resign({ ...h, v: 2 }),
    'seq 0': resign({ ...h, seq: 0 }),
    'seq as string': resign({ ...h, seq: '4' }),
    'date not canonical': resign({ ...h, date: '2026-10-24T12:00:00Z' }),
    'unsorted refs': resign({ ...h, hiddenPosts: [A + ':3', A + ':12'] }),
    'duplicate refs': resign({ ...h, hiddenPosts: [A + ':3', A + ':3'] }),
    'post seq 0': resign({ ...h, hiddenPosts: [A + ':0'] }),
    'leading zero': resign({ ...h, hiddenPosts: [A + ':03'] }),
    'unsafe seq': resign({ ...h, hiddenPosts: [A + ':9007199254740993'] }),
    'uppercase author': resign({ ...h, hiddenPosts: [A.toUpperCase() + ':3'] }),
    'not a string': resign({ ...h, hiddenPosts: [{ author: A, seq: 3 }] }),
    'too many': resign({ ...h, hiddenPosts: Array.from({ length: bl.MAX_HIDDEN_POSTS + 1 }, (_, i) => A + ':' + (i + 1)).sort() }),
    'short signature': { ...h, signature: h.signature.slice(2) },
    null: null,
    array: [h]
  }
  for (const [name, bad] of Object.entries(malformed)) t.alike(bl.verifyHiddenList(bad, assocHex), { ok: false, reason: 'malformed' }, name)
  // A snapshot is not a hidden-posts list, and the other way round.
  const s = bl.createSnapshot({ seq: 4, date: SNAP_DATE }, modKp, modCert)
  t.alike(bl.verifyHiddenList(s, assocHex), { ok: false, reason: 'malformed' })
  t.alike(bl.verifySnapshot(h, assocHex), { ok: false, reason: 'malformed' })
  // Domain separation: a snapshot signature never signs a list with the same
  // seq and date, nor the other way round.
  const e = hide(4, [])
  const plain = bl.createSnapshot({ seq: 4, date: SNAP_DATE, blocked: [], revokedIssuers: [] }, modKp, modCert)
  t.alike(bl.verifyHiddenList({ ...e, signature: plain.signature }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(bl.verifySnapshot({ ...plain, signature: e.signature }, assocHex), { ok: false, reason: 'bad-signature' })
  // Dropping a post keeps the signature of the full list: refused.
  t.alike(bl.verifyHiddenList({ ...h, hiddenPosts: [A + ':12', E + ':7'] }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(bl.verifyHiddenList({ ...h, seq: 5 }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(bl.verifyHiddenList(h, setup().assocHex).ok, false, 'another association')
  t.alike(bl.verifyHiddenList({ ...h, moderatorSignature: 'ab'.repeat(64) }, assocHex).ok, false, 'a forged moderator certificate')
})

test('hidden-posts size: MAX_HIDDEN_POSTS refs fit MAX_HIDDEN_BYTES and the channel 2 message', (t) => {
  const net = require('../lib/blocklist-net')
  t.is(bl.MAX_HIDDEN_POSTS, 512)
  const longDate = '+275760-09-13T00:00:00.000Z'
  const { assocHex, modKp, modCert } = hiddenSetup(longDate)
  const hiddenPosts = Array.from({ length: bl.MAX_HIDDEN_POSTS }, (_, i) => hexKey(i) + ':' + (Number.MAX_SAFE_INTEGER - i))
  const h = bl.createHiddenList({ seq: Number.MAX_SAFE_INTEGER, date: longDate, hiddenPosts }, modKp, modCert)
  t.ok(b4a.byteLength(JSON.stringify(h)) <= bl.MAX_HIDDEN_BYTES)
  const bytes = b4a.byteLength(JSON.stringify({ type: 'snapshot', snapshot: h }))
  t.ok(bytes <= net.MAX_HIDDEN_MESSAGE, 'largest hidden-posts message is ' + bytes + ' bytes')
  t.alike(bl.verifyHiddenList(h, assocHex), { ok: true })
})

test('acceptHiddenList: an older or tampered list never undoes a hide', (t) => {
  const assocKp = crypto.keyPair()
  const { assocHex, hide } = hiddenSetup(MOD_DATE, assocKp)
  const h1 = hide(1, [])
  const h2 = hide(2, [A + ':5'])
  t.alike(bl.acceptHiddenList(null, h1, assocHex), { ok: true })
  t.alike(bl.acceptHiddenList(h1, h2, assocHex), { ok: true })
  t.alike(bl.acceptHiddenList(h2, h1, assocHex), { ok: false, reason: 'stale' }, 'the list from before the hide')
  t.alike(bl.acceptHiddenList(h2, hide(2, []), assocHex), { ok: false, reason: 'stale' }, 'the same seq with other contents')
  t.alike(bl.acceptHiddenList(h2, h2, assocHex), { ok: false, reason: 'same' })
  t.alike(bl.acceptHiddenList(h2, { ...hide(3, [A + ':5', C + ':2']), hiddenPosts: [C + ':2'] }, assocHex), { ok: false, reason: 'bad-signature' })
  // A newer moderator certificate wins over a higher seq, as for snapshots.
  const rotated = hiddenSetup('2026-11-01T00:00:00.000Z', assocKp).hide(1, [A + ':5'])
  t.alike(bl.acceptHiddenList(hide(9, [A + ':5']), rotated, assocHex), { ok: true })
  t.alike(bl.acceptHiddenList(rotated, hide(9, []), assocHex), { ok: false, reason: 'stale' })
  t.is(bl.compareSnapshots(h1, h2), -1, 'the snapshot order also orders lists')
})

test('createBlocklistState: the hidden-posts list is adopted apart from the snapshot', async (t) => {
  const assocKp = crypto.keyPair()
  const { assocHex, snap, hide } = hiddenSetup(MOD_DATE, assocKp)
  const h1 = hide(1, [A + ':5'])
  const h2 = hide(2, [A + ':5', C + ':2'])
  const h3 = hide(3, [C + ':2'])
  const savedHidden = []
  const savedSnap = []
  const state = bl.createBlocklistState({
    association: assocHex,
    load: async () => null,
    save: async (s) => { savedSnap.push(s.seq) },
    loadHidden: async () => null,
    saveHidden: async (h) => { savedHidden.push(h.seq) }
  })
  await state.ready()
  t.is(state.currentHidden(), null)
  t.is(state.hiddenPosts().size, 0)

  const a1 = await state.offerHidden(h1)
  t.is(a1.adopted, true)
  t.alike([...a1.hiddenAdded], [A + ':5'])
  t.is(a1.hiddenRemoved.size + a1.added.size + a1.revokedAdded.size, 0)
  t.alike(state.currentHidden(), h1)
  t.not(state.currentHidden(), h1, 'a copy is stored')
  t.ok(bl.isHiddenPost(state.hiddenPosts(), A, 5))
  t.is(state.current(), null, 'the snapshot is untouched')

  // A snapshot adopted later keeps the hidden posts, and the other way round.
  const s1 = await state.offer(snap(1, [E]))
  t.is(s1.adopted, true)
  t.is(s1.hiddenAdded.size + s1.hiddenRemoved.size, 0)
  t.ok(bl.isHiddenPost(state.hiddenPosts(), A, 5))
  t.alike((await state.offerHidden(h1)).reason, 'same')
  t.alike((await state.offerHidden(snap(2, [E]))).reason, 'malformed', 'a snapshot on the hidden side')
  t.alike((await state.offer(h2)).reason, 'malformed', 'a hidden list on the snapshot side')
  t.ok(state.blocked().has(E))

  // racing offers share the queue: h3 first, then h2 is stale against h3
  const [r3, r2] = await Promise.all([state.offerHidden(h3), state.offerHidden(h2)])
  t.is(r3.adopted, true)
  t.alike([...r3.hiddenAdded], [C + ':2'])
  t.alike([...r3.hiddenRemoved], [A + ':5'])
  t.alike({ adopted: r2.adopted, reason: r2.reason }, { adopted: false, reason: 'stale' })
  t.alike((await state.offerHidden(h1)).reason, 'stale', 'an old list never undoes the newer one')
  t.absent(bl.isHiddenPost(state.hiddenPosts(), A, 5))
  t.alike(savedHidden, [1, 3])
  t.alike(savedSnap, [1])

  // a stored list is adopted at load; a foreign one is ignored
  const reloaded = bl.createBlocklistState({ association: assocHex, load: () => null, save () {}, loadHidden: () => h2, saveHidden () {} })
  await reloaded.ready()
  t.ok(bl.isHiddenPost(reloaded.hiddenPosts(), C, 2))
  const foreign = bl.createBlocklistState({ association: setup().assocHex, save () {}, loadHidden: () => h2, saveHidden () {} })
  await foreign.ready()
  t.is(foreign.currentHidden(), null)

  // no storage for the list: offerHidden rejects, the snapshot still works
  const noHidden = bl.createBlocklistState({ association: assocHex, save () {} })
  await t.exception(noHidden.offerHidden(h1), /no storage/)
  t.is((await noHidden.offer(snap(1))).adopted, true)

  // a failing save keeps the previous list
  let fail = true
  const flaky = bl.createBlocklistState({ association: assocHex, save () {}, loadHidden: () => h1, saveHidden: async () => { if (fail) throw new Error('disk full') } })
  await flaky.ready()
  await t.exception(flaky.offerHidden(h3), /disk full/)
  t.ok(bl.isHiddenPost(flaky.hiddenPosts(), A, 5))
  fail = false
  t.is((await flaky.offerHidden(h3)).adopted, true)

  // a failing hidden load fails closed: ready() and both offers reject
  const broken = bl.createBlocklistState({ association: assocHex, save () {}, loadHidden: async () => { throw new Error('unreadable') }, saveHidden () {} })
  await t.exception(broken.ready(), /unreadable/)
  await t.exception(broken.offerHidden(h1), /unreadable/)
  await t.exception(broken.offer(snap(1)), /unreadable/)
})

test('createBlocklistState: one moderator certificate floor for both lists', async (t) => {
  const assocKp = crypto.keyPair()
  const old = hiddenSetup(MOD_DATE, assocKp)
  const now = hiddenSetup('2026-11-01T00:00:00.000Z', assocKp)
  const state = bl.createBlocklistState({ association: old.assocHex, save () {}, loadHidden: () => null, saveHidden () {} })
  await state.ready()
  t.is((await state.offerHidden(old.hide(1, [A + ':5']))).adopted, true)

  // a snapshot under the newer certificate is adopted; the held list stays
  t.is((await state.offer(now.snap(1, [E]))).adopted, true)
  t.ok(bl.isHiddenPost(state.hiddenPosts(), A, 5), 'a held list is never dropped for the floor')

  // the retired key can no longer sign a hidden-posts list, whatever its seq
  const retired = await state.offerHidden(old.hide(50, []))
  t.alike({ adopted: retired.adopted, reason: retired.reason }, { adopted: false, reason: 'stale' })
  t.ok(bl.isHiddenPost(state.hiddenPosts(), A, 5))
  t.is((await state.offerHidden(now.hide(1, [A + ':5', C + ':2']))).adopted, true, 'the list re-signed under the newer certificate')

  // and the other way round: a newer hidden list blocks a retired snapshot
  const other = bl.createBlocklistState({ association: old.assocHex, save () {}, loadHidden: () => null, saveHidden () {} })
  await other.ready()
  t.is((await other.offer(old.snap(1, [E]))).adopted, true)
  t.is((await other.offerHidden(now.hide(1, [A + ':5']))).adopted, true)
  const stale = await other.offer(old.snap(50, []))
  t.alike({ adopted: stale.adopted, reason: stale.reason }, { adopted: false, reason: 'stale' })
  t.ok(other.blocked().has(E))
  t.is((await other.offer(now.snap(1, []))).adopted, true)
  t.absent(other.blocked().has(E))
})

test('hiddenPostMap, isHiddenPost, withoutHidden and exceptAuthor', (t) => {
  const { hide } = hiddenSetup()
  const h = hide(1, [A + ':12', A + ':3', E + ':7'])
  const map = bl.hiddenPostMap(h)
  t.ok(bl.isHiddenPost(map, A.toUpperCase(), 12))
  t.ok(bl.isHiddenPost(map, E, 7))
  t.absent(bl.isHiddenPost(map, E, 12))
  t.absent(bl.isHiddenPost(map, 'zz', 7))
  t.is(bl.hiddenPostMap(null).size, 0)
  t.is(bl.hiddenPostMap(hide(2)).size, 0)
  const post = { type: 'post' }
  const entries = [{ seq: 1, record: post }, { seq: 3, record: post }, { seq: 12, record: { type: 'profile' } }]
  t.alike(bl.withoutHidden(entries, A, map), [{ seq: 1, record: post }, { seq: 12, record: { type: 'profile' } }], 'only a post is hidden')
  t.is(bl.withoutHidden(entries, C, map), entries, 'an untouched author keeps the same array')
  // The hole a seeder left at a hidden post goes too; a tombstoned block stays.
  const holes = [{ seq: 1, record: post }, { seq: 3, record: null, deleted: true }, { seq: 12, record: null }]
  t.alike(bl.withoutHidden(holes, A, map), [{ seq: 1, record: post }, { seq: 3, record: null, deleted: true }], 'a hole at a hidden seq reads like the hidden post')
  const own = bl.exceptAuthor(map, A)
  t.absent(own.has(A))
  t.ok(own.has(E))
  t.ok(map.has(A), 'the map itself is unchanged')
  t.is(bl.exceptAuthor(map, C), map)
  t.alike(bl.parseHiddenRef(E + ':7'), { author: E, seq: 7 })
  t.is(bl.parseHiddenRef(E + ':07'), null)
  t.is(bl.hiddenRef(E, 7), E + ':7')
})

test('the module is pure: no fs, no network', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/blocklist.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'blocklist.js')).map(([id]) => id)
  t.alike(own.sort(), ['./cert', './verified', 'b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
