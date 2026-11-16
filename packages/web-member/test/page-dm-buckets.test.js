'use strict'

// Buckets on the devices that hold a Página (docs/protocol.md section 11,
// "Buckets"): what a holder asks, the group of each drop it puts, and its
// two pull passes. Real nodes against helpers/dm-seeder.js at 6 bits, and
// engines over a fake pool (no timers, no network) for the passes.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const dmCore = require('@varanda/core/lib/dm')
const gc = require('@varanda/core/lib/group-crypto')
const visitsCore = require('@varanda/core/lib/visits')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { errorOf } = require('./helpers/session')
const { dmSeeder } = require('./helpers/dm-seeder')
const { noop, hex, memberNode, pageDiary, hold, copyDiary, signed } = require('./helpers/page-dm')

const LOCKED = 'identidade bloqueada: entre com a passkey'
// Below the runner's 180 s file limit (scripts/run-tests.js), as in
// page-dm.test.js.
const TEST_TIMEOUT_MS = 150000

function isPrefix (x) {
  return Number.isSafeInteger(x) && x >= 0 && x < 64
}

function ascending (list) {
  return list.every((x, i) => i === 0 || x >= list[i - 1])
}

test('buckets: a member that holds a Página asks every bucket; one that holds none asks only its own', async (t) => {
  t.timeout(TEST_TIMEOUT_MS * 2)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc, bits: 6 })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const pageCert = createCert({ member: P }, assoc)

  // No Página held yet: only the own bucket is asked.
  await A.web.request('dm.pull')
  t.ok(seeder.pageQueries.length > 0)
  t.ok(seeder.pageQueries.every((q) => q.buckets.length === 1), 'a device with no Página asks one bucket')

  const made1 = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made1.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s1 = made1.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s1.sealed, by: A.key, sig: s1.sig, box: made1.box, groupBox: made1.groupBox, cert: pageCert })
  await C.web.request('dm.send', { to: P, text: 'para a 1' })
  await copyDiary(A, C)
  await C.web.request('dm.send', { to: A.key, text: 'para voce' })

  const everyBucket = (qs) => qs.every((q) => q.buckets.length === 64)
  const texts = async () => (await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text)
  const own = async () => (await A.web.request('dm.thread', { peer: C.key })).messages.map((m) => m.text)

  seeder.pageQueries.length = 0
  await A.web.request('dm.pull')
  t.is(seeder.pageQueries.length, 1, 'one pass')
  t.ok(everyBucket(seeder.pageQueries), 'every bucket, no filter')
  t.alike(await texts(), ['para a 1'])
  t.alike(await own(), ['para voce'])

  // A new gen resets the page cursor behind the own one: the own pass goes
  // first, then the page catches up from 0, every bucket in both, nothing
  // filed twice.
  const made2 = await A.web.request('dm.pageGenerate', { page: P, gen: 2, recipients: [{ member: A.key, box: A.box }] })
  const s2 = made2.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 2, sealed: s2.sealed, by: A.key, sig: s2.sig, box: made2.box, groupBox: made2.groupBox, cert: pageCert })
  await C.web.request('dm.send', { to: P, text: 'ainda para a 1' })
  seeder.pageQueries.length = 0
  const trafficAt = seeder.traffic.length
  await A.web.request('dm.pull')
  t.is(seeder.pageQueries.length, 2, 'the own pass, then the catch-up')
  t.ok(everyBucket(seeder.pageQueries))
  const afters = seeder.traffic.slice(trafficAt).filter((x) => x.startsWith('{')).map((x) => JSON.parse(x).after)
  t.ok(afters[0] > 0, 'the own pass starts at the own cursor')
  t.is(afters[1], 0, 'the catch-up starts at the reset page cursor')
  t.alike(await texts(), ['para a 1', 'ainda para a 1'])
  t.alike(await own(), ['para voce'], 'the own scan filed nothing twice')

  // The next pulls: the cursors stay together, so no page costs an extra request.
  for (const text of ['de carona', 'e outra']) {
    await C.web.request('dm.send', { to: P, text })
    seeder.pageQueries.length = 0
    seeder.served = 0
    await A.web.request('dm.pull')
    t.is(seeder.pageQueries.length, 1, 'one request per pull')
    t.ok(everyBucket(seeder.pageQueries))
    t.is(seeder.served, 2, 'the new drop and its self copy, downloaded once')
  }
  t.alike(await texts(), ['para a 1', 'ainda para a 1', 'de carona', 'e outra'])
  t.alike(await own(), ['para voce'])
})

// A prf whose box prefix is not among `taken` (dm.test.js prfWithPrefix):
// the nodes then sit in different buckets at 6 bits, whatever the keys.
async function prfWithPrefix (taken) {
  for (;;) {
    const prf = crypto.randomBytes(32)
    const p = dmCore.bucketPrefix(hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey))
    if (!taken.includes(p)) return { prf, p }
  }
}

// A and C in two buckets at 6 bits, and a Página P owned by A, its diary
// held by both; adopt() gives A its gen 1 secrets. second: a third node B
// in a third bucket that holds the diary too; share() makes it a second
// holder of P (after adopt). dropPutAck: as helpers/dm-seeder.js.
async function bucketPage (t, { second = false, dropPutAck } = {}) {
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc, bits: 6, dropPutAck })
  const a = await prfWithPrefix([])
  const c = await prfWithPrefix([a.p])
  const A = await memberNode(t, assoc, seeder.url, { prf: a.prf })
  const C = await memberNode(t, assoc, seeder.url, { prf: c.prf })
  const B = second ? await memberNode(t, assoc, seeder.url, { prf: (await prfWithPrefix([a.p, c.p])).prf }) : null
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const cert = createCert({ member: P }, assoc)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  if (B !== null) await hold(diary, B.storage)
  const s = made.shares[0]
  const adopt = () => A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert })
  async function share () {
    const shared = await A.web.request('dm.pageShare', { page: P, member: B.key, box: B.box })
    return B.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: shared.sealed, by: A.key, sig: shared.sig, box: made.box, groupBox: made.groupBox, cert })
  }
  return { seeder, A, B, C, a: a.p, c: c.p, P, pageKp, adopt, share }
}

// The bucket of each put since the last call (null: untagged).
function putTags (seeder) {
  let at = seeder.putInfos.length
  return () => {
    const out = seeder.putInfos.slice(at).map((i) => i.bucket)
    at = seeder.putInfos.length
    return out
  }
}

async function pageCtl (A, P, pageKp, peer, op) {
  const d = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op, peer })
  return A.web.request('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) })
}

test('buckets: drops sealed to a Página box go with a random group drawn per drop; the own self copy and the own ctl keep the own bucket', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const { seeder, A, C, a, c, P, pageKp, adopt } = await bucketPage(t)
  await adopt()
  await copyDiary(C, A)
  const tags = putTags(seeder)
  const drawn = []

  await pageCtl(A, P, pageKp, C.key, 'accepted')
  const ctl = tags()
  t.is(ctl.length, 1)
  t.ok(isPrefix(ctl[0]), 'a Página ctl carries a group')
  drawn.push(ctl[0])
  const reply = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'da página' })
  await A.web.request('dm.pageSend', { page: P, id: reply.id, ...signed(reply.digest, pageKp) })
  const pair = tags()
  t.is(pair[0], c, 'a Página reply: the recipient bucket first')
  t.ok(isPrefix(pair[1]), 'then its self copy with a group')
  drawn.push(pair[1])
  await A.web.request('dm.send', { to: C.key, text: 'minha' })
  t.alike(tags(), [c, a], 'an own message: its self copy keeps the own bucket')
  await A.web.request('dm.set', { peer: C.key, state: 'accepted' })
  t.alike(tags(), [a], 'an own ctl keeps the own bucket')

  // A group drawn per drop: from neither the own bucket nor a fixed value.
  for (let i = 0; i < 8; i++) {
    await pageCtl(A, P, pageKp, C.key, i % 2 === 0 ? 'blocked' : 'unblocked')
    drawn.push(...tags())
  }
  t.is(drawn.length, 10)
  t.ok(drawn.every(isPrefix), 'every Página drop carries a group')
  t.ok(new Set(drawn).size > 1, 'not one fixed group')
  t.ok(drawn.some((x) => x !== a), 'not the holder\'s own bucket')
  t.ok(seeder.putInfos.every((i) => i.bits === 6), 'all on the v2 lane')

  await C.web.request('dm.pull')
  t.alike((await C.web.request('dm.thread', { peer: P })).messages.map((m) => m.text), ['da página'], 'the recipient still gets the Página reply')
})

test('buckets: a Página drop whose put failed goes out again with the group drawn the first time', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  let failAt = -1
  const { seeder, A, C, c, P, pageKp, adopt } = await bucketPage(t, { dropPutAck: (n) => n === failAt })
  await adopt()
  await copyDiary(C, A)
  const tags = putTags(seeder)

  // A ctl: the failed put leaves it queued; the next flush repeats it first.
  failAt = seeder.puts.length
  await pageCtl(A, P, pageKp, C.key, 'accepted')
  const first = tags()
  t.is(first.length, 1, 'stored, then the link dropped before the ack')
  await pageCtl(A, P, pageKp, C.key, 'blocked')
  const next = tags()
  t.is(next.length, 2, 'the queued ctl again, then the new one')
  t.ok(isPrefix(first[0]))
  t.is(next[0], first[0], 'the same group on the repeated put')

  // A reply: the self copy put fails; the user's retry puts it again.
  await pageCtl(A, P, pageKp, C.key, 'unblocked')
  tags()
  const reply = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'da página' })
  const sig = signed(reply.digest, pageKp)
  failAt = seeder.puts.length + 1
  t.ok(await errorOf(A.web.request('dm.pageSend', { page: P, id: reply.id, ...sig })), 'the self copy unconfirmed')
  const sent = tags()
  t.is(sent[0], c)
  t.ok(isPrefix(sent[1]))
  await A.web.request('dm.pageSend', { page: P, id: reply.id, ...sig })
  t.alike(tags(), [sent[1]], 'only the self copy again, with its first group')
})

test('buckets: a second holder files the Página reply copy and the Página ctl a holder put with random groups', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const { seeder, A, B, C, P, pageKp, adopt, share } = await bucketPage(t, { second: true })
  await adopt()
  await share()
  await copyDiary(C, A)
  await C.web.request('dm.send', { to: P, text: 'oi, página' })
  const tags = putTags(seeder)
  const reply = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'da página' })
  await A.web.request('dm.pageSend', { page: P, id: reply.id, ...signed(reply.digest, pageKp) })
  const put = tags()
  t.ok(isPrefix(put[1]), 'the reply self copy carries a group')
  t.not(seeder.pool.entries[seeder.pool.entries.length - 1].tag, 0, 'tagged in the pool too')
  seeder.pageQueries.length = 0
  await B.web.request('dm.pull')
  t.ok(seeder.pageQueries.length > 0 && seeder.pageQueries.every((q) => q.buckets.length === 64), 'the second holder asks every bucket')
  const th = await B.web.request('dm.thread', { page: P, peer: C.key })
  t.alike(th.messages.map((m) => [m.text, m.mine]), [['oi, página', false], ['da página', true]], 'the reply copy filed')
  t.is(th.blocked, false)

  await pageCtl(A, P, pageKp, C.key, 'blocked')
  const ctl = tags()
  t.ok(ctl.length === 1 && isPrefix(ctl[0]), 'the ctl carries a group')
  t.not(seeder.pool.entries[seeder.pool.entries.length - 1].tag, 0)
  await B.web.request('dm.pull')
  t.is((await B.web.request('dm.thread', { page: P, peer: C.key })).blocked, true, 'the Página ctl filed')
})

test('buckets: a Página adopted after the own cursor passed its drop files that drop on the next pull', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const { seeder, A, C, P, adopt } = await bucketPage(t)
  await copyDiary(A, C)
  await C.web.request('dm.send', { to: P, text: 'antes da adoção' })
  const dropSeq = seeder.pool.entries[seeder.pool.entries.length - 2].seq
  await C.web.request('dm.send', { to: A.key, text: 'para voce' })
  await A.web.request('dm.pull')
  t.ok(seeder.pageQueries.every((q) => q.buckets.length === 1), 'no Página held yet: one bucket')
  t.ok((await A.storage.readJson('dmCursor')).after > dropSeq, 'the own cursor passed the drop to the Página')

  await adopt()
  seeder.pageQueries.length = 0
  await A.web.request('dm.pull')
  t.ok(seeder.pageQueries.length > 0 && seeder.pageQueries.every((q) => q.buckets.length === 64), 'every bucket')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text), ['antes da adoção'])
  t.alike((await A.web.request('dm.thread', { peer: C.key })).messages.map((m) => m.text), ['para voce'], 'the own thread as before')
})

// ---- a holder's pull passes, over a fake pool (engine level) ----

// A fake pool for the dm and visit links of an engine: items { seq, bytes }
// on the dm lane (the visit lane is empty); each page request is recorded
// as { lane, after, prefixes } (prefixes null: every bucket), each put's
// prefix in `puts`. onOpen / onPage: awaited when a dm link opens and before
// a page answers. sweep(seq): drops the items up to seq, as the retention
// does; seqs never go back.
function fakePool () {
  let seq = 0
  const pool = {
    items: [],
    pages: [],
    puts: [],
    onOpen: null,
    onPage: null,
    add (bytes) {
      pool.items.push({ seq: ++seq, bytes })
    },
    sweep (upTo) {
      pool.items = pool.items.filter((x) => x.seq > upTo)
    },
    link (lane) {
      return {
        async page ({ after, limit, prefixes }) {
          const q = { lane, after, prefixes: prefixes === undefined ? null : prefixes }
          pool.pages.push(q)
          if (pool.onPage) await pool.onPage(q)
          const rest = lane === 'dm' ? pool.items.filter((x) => x.seq > after) : []
          const items = rest.slice(0, limit)
          return { items, next: rest.length > items.length ? items[items.length - 1].seq : null }
        },
        async put (bytes, prefix) {
          pool.puts.push(prefix === undefined ? null : prefix)
          return { ok: true, reason: null }
        },
        close: noop
      }
    }
  }
  return pool
}

// An unlocked engine over `pool`, holding no Página yet and no stamps;
// adopt() makes it hold a new one at gen 1, its cursor at 0
// -> { page, box, kp }; stamp(n) fills its wallet.
async function poolEngine (t, pool, assoc, limits = {}) {
  const transport = require('../lib/dm-link')
  const originalDm = transport.openDmLink
  const originalVisit = transport.openVisitLink
  const id = require.resolve('../lib/dm')
  const cached = require.cache[id]
  let createEngine
  try {
    transport.openDmLink = async () => {
      if (pool.onOpen) await pool.onOpen()
      return pool.link('dm')
    }
    transport.openVisitLink = async () => pool.link('visit')
    delete require.cache[id]
    createEngine = require('../lib/dm').createDmEngine
  } finally {
    transport.openDmLink = originalDm
    transport.openVisitLink = originalVisit
    require.cache[id] = cached
  }
  const storage = memoryNodeStorage()
  const engine = createEngine({ storage, association: hex(assoc.publicKey), seederUrl: 'ws://127.0.0.1:1/seeder', createSocket: () => { throw new Error('sem rede') }, limits })
  t.teardown(() => engine.close(), { force: true })
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const prf = crypto.randomBytes(32)
  await engine.unlock(prf)
  await engine.loaded()
  const ownBox = hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey)
  // n stamps the fake put never checks, sealed as the engine's wallet keeps
  // them, in place of the wallet.
  async function stamp (n) {
    const key = await dmLocalKeyFromPrf(prf)
    const kid = 'ab'.repeat(8)
    await store.writeDmStamps(storage, {
      kids: [kid],
      items: Array.from({ length: n }, () => ({ kid, ...gc.sealRecord({ token: hex(crypto.randomBytes(32)), sig: b4a.toString(b4a.alloc(dmCore.DROP.SIG_BYTES), 'base64') }, key) }))
    })
  }
  async function adopt () {
    const kp = crypto.keyPair()
    const page = hex(kp.publicKey)
    const made = engine.pageGenerate(own, idKp, { page, gen: 1, recipients: [{ member: own, box: ownBox }] })
    const sh = made.shares[0]
    await engine.pageSecrets(own, { owner: own, admins: [] }, { page, gen: 1, sealed: sh.sealed, by: own, sig: sh.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) })
    return { page, box: made.box, kp }
  }
  return { engine, storage, idKp, own, ownBox, prf, adopt, stamp }
}

// A drop from senderKp to `to`, sealed to boxHex.
function dropTo (assoc, senderKp, to, boxHex, text) {
  const inner = dmCore.buildInner({ kind: 'msg', to, text, cert: createCert({ member: hex(senderKp.publicKey) }, assoc) }, senderKp)
  return dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: crypto.randomBytes(8), rsaSig: crypto.randomBytes(dmCore.DROP.SIG_BYTES), token: crypto.randomBytes(32), sealed: dmCore.sealInner(inner, boxHex) })
}

// A drop that no box of the engine opens.
function strayDrop (assoc, senderKp) {
  return dropTo(assoc, senderKp, hex(crypto.keyPair().publicKey), hex(gc.boxKeyPairFromSeed(crypto.randomBytes(32)).publicKey), 'de fora')
}

// Two drops per page and a budget of two drops: a pull reads one page past
// the budget, then stops (incomplete).
const SMALL_BUDGET = { pageMax: 2, budgetBytes: 2 * dmCore.DM_DROP_BYTES }

test('buckets: the visit pull of a device that holds a Página asks every bucket; one that holds none asks its own', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const since = visitsCore.visitDay(Date.now())
  const visitAsks = () => pool.pages.filter((q) => q.lane === 'visit').map((q) => q.prefixes)
  await E.engine.pullVisits(E.own, { since })
  t.alike(visitAsks(), [[dmCore.bucketPrefix(E.ownBox)]], 'no Página: the own bucket')
  await E.adopt()
  pool.pages.length = 0
  await E.engine.pullVisits(E.own, { since })
  t.alike(visitAsks(), [null], 'a holder: every bucket')
  await E.engine.pull(E.own)
  const dmAsks = pool.pages.filter((q) => q.lane === 'dm')
  t.ok(dmAsks.length > 0 && dmAsks.every((q) => q.prefixes === null), 'as on its dm pull')
})

test('buckets: a new own message is filed on the first pull while a Página catches up from 0', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, SMALL_BUDGET)
  const C = crypto.keyPair()
  for (let i = 0; i < 10; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 10)
  await E.adopt()
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'nova'))
  const r = await E.engine.pull(E.own)
  t.is(r.added, 1, 'the new own message, on the first pull')
  t.is(r.cursor, 11)
  t.is(r.incomplete, true, 'the Página catch-up ran out of budget')
  t.alike(pool.pages.map((q) => q.after), [10, 0], 'the own pass first, then the catch-up from 0')
  t.ok(pool.pages.every((q) => q.prefixes === null), 'every request asks every bucket')
  t.alike((await E.engine.thread(E.own, { peer: hex(C.publicKey) })).messages.map((m) => m.text), ['nova'])
})

test('buckets: where the budget stops a holder pull, each cursor stays at the last item its scan saw and the next pull goes on from there', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, SMALL_BUDGET)
  const C = crypto.keyPair()
  const P = await E.adopt()
  pool.add(strayDrop(assoc, C))
  pool.add(strayDrop(assoc, C))
  pool.add(dropTo(assoc, C, P.page, P.box, 'para a página'))
  for (let i = 0; i < 6; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 9)
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'nova'))
  const starts = []
  const ownCursors = []
  const pageCursors = []
  const incomplete = []
  for (let i = 0; i < 6; i++) {
    pool.pages.length = 0
    incomplete.push((await E.engine.pull(E.own)).incomplete)
    starts.push(pool.pages.map((q) => q.after))
    ownCursors.push(await store.readDmCursor(E.storage))
    pageCursors.push((await store.readPageCursor(E.storage, store.pageDmPrefix(P.page))).after)
  }
  t.alike(starts, [[9, 0], [10, 2], [10, 4], [10, 6], [10, 8], [10]], 'each catch-up goes on where the last stopped; then the Página rides along')
  t.alike(ownCursors, [10, 10, 10, 10, 10, 10], 'the own cursor never moves backwards')
  t.alike(pageCursors, [2, 4, 6, 8, 10, 10], 'the Página cursor at the last item its scan saw')
  t.alike(incomplete, [true, true, true, true, false, false])
  const peer = hex(C.publicKey)
  t.alike((await E.engine.thread(E.own, { peer, page: P.page })).messages.map((m) => m.text), ['para a página'])
  t.alike((await E.engine.thread(E.own, { peer })).messages.map((m) => m.text), ['nova'])
})

test('buckets: a message the own scan skipped stays unfiled when a Página catch-up reads it again', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const C = crypto.keyPair()
  const peer = hex(C.publicKey)
  const P = await E.adopt()
  await E.engine.set(E.own, E.idKp, { peer, state: 'blocked' })
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'enquanto bloqueado'))
  t.is((await E.engine.pull(E.own)).added, 0, 'skipped while blocked')
  await E.engine.set(E.own, E.idKp, { peer, state: 'unblocked' })
  // The Página's cursor starts over, as a new gen or a legacy box makes it.
  const prefix = store.pageDmPrefix(P.page)
  const before = await store.readPageCursor(E.storage, prefix)
  t.is(before.after, 1)
  await store.writePageCursor(E.storage, prefix, { ...before, after: 0 })
  pool.pages.length = 0
  t.is((await E.engine.pull(E.own)).added, 0, 'not filed after the unblock')
  t.alike(pool.pages.map((q) => q.after), [1, 0], 'the catch-up read it again')
  t.alike((await E.engine.thread(E.own, { peer })).messages, [])
})

test('buckets: a catch-up that reaches the pool end with nothing left brings the Página cursor up to the own one', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const C = crypto.keyPair()
  for (let i = 0; i < 10; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 10)
  // The retention swept every drop the Página could still read.
  pool.sweep(10)
  const P = await E.adopt()
  await E.engine.pull(E.own)
  t.alike(pool.pages.map((q) => q.after), [10, 0], 'the own pass, then the catch-up')
  t.is((await store.readPageCursor(E.storage, store.pageDmPrefix(P.page))).after, 10, 'the Página cursor joins the own one')
  pool.pages.length = 0
  await E.engine.pull(E.own)
  t.alike(pool.pages.map((q) => q.after), [10], 'no catch-up on the next pull')
})

test('buckets: two Páginas, one caught up and one behind: no cursor moves backwards across budget-limited pulls', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, SMALL_BUDGET)
  const C = crypto.keyPair()
  const peer = hex(C.publicKey)
  const P1 = await E.adopt()
  for (let i = 0; i < 9; i++) pool.add(strayDrop(assoc, C))
  for (let i = 0; i < 10; i++) {
    if (!(await E.engine.pull(E.own)).incomplete) break
  }
  const cursorOf = async (P) => (await store.readPageCursor(E.storage, store.pageDmPrefix(P.page))).after
  t.is(await cursorOf(P1), 9, 'the first Página caught up with the own scan')
  const P2 = await E.adopt()
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'nova'))
  pool.add(dropTo(assoc, C, P2.page, P2.box, 'para a segunda'))
  pool.add(dropTo(assoc, C, P1.page, P1.box, 'para a primeira'))
  const own = []
  const first = []
  const second = []
  for (let i = 0; i < 8; i++) {
    await E.engine.pull(E.own)
    own.push(await store.readDmCursor(E.storage))
    first.push(await cursorOf(P1))
    second.push(await cursorOf(P2))
  }
  t.ok(ascending(own), 'the own cursor never moves backwards: ' + own.join(' '))
  t.ok(ascending(first), 'the caught-up Página cursor never moves backwards: ' + first.join(' '))
  t.ok(ascending(second), 'the lagging Página cursor never moves backwards: ' + second.join(' '))
  t.alike([own[7], first[7], second[7]], [12, 12, 12], 'all at the pool end')
  t.alike((await E.engine.thread(E.own, { peer })).messages.map((m) => m.text), ['nova'])
  t.alike((await E.engine.thread(E.own, { peer, page: P1.page })).messages.map((m) => m.text), ['para a primeira'])
  t.alike((await E.engine.thread(E.own, { peer, page: P2.page })).messages.map((m) => m.text), ['para a segunda'])
})

test('buckets: a holder whose Página scan fails still asks every bucket', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const P = await E.adopt()
  const key = store.pageDmPrefix(P.page) + 'dmCursor'
  const readJson = E.storage.readJson.bind(E.storage)
  let fail = true
  E.storage.readJson = async (k) => {
    if (fail && k === key) {
      fail = false
      throw new Error('falha de leitura')
    }
    return readJson(k)
  }
  await E.engine.pull(E.own)
  t.is(fail, false, 'the scan of the Página failed')
  t.ok(pool.pages.length > 0 && pool.pages.every((q) => q.prefixes === null), 'every bucket all the same')
})

test('buckets: a budget stop in the own pass asks no catch-up on that pull', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, SMALL_BUDGET)
  const C = crypto.keyPair()
  for (let i = 0; i < 10; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 2)
  await E.adopt()
  const r = await E.engine.pull(E.own)
  t.is(r.incomplete, true)
  t.alike(pool.pages.map((q) => q.after), [2], 'the own pass only')
})

test('buckets: a lock and an unlock while a Página ctl flush opens its link put each ctl once, with its group', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const P = await E.adopt()
  const peer = hex(crypto.keyPair().publicKey)
  const ctl = async (op) => {
    const d = await E.engine.pageDraft({ page: P.page, kind: 'ctl', op, peer })
    await E.engine.pageSend({ page: P.page, id: d.id, ...signed(d.digest, P.kp) })
  }
  // No stamp yet: the first ctl waits in the queue, so the flush below
  // carries two and has one left to write back after its first put.
  await ctl('accepted')
  t.is(pool.puts.length, 0)
  await E.stamp(2)
  let once = true
  pool.onOpen = async () => {
    if (!once) return
    once = false
    E.engine.lock()
    await E.engine.unlock(E.prf)
    await E.engine.loaded()
  }
  await ctl('blocked')
  await E.engine.loaded()
  await E.engine.idle()
  t.is(once, false, 'the link opened across a lock and an unlock')
  t.is(pool.puts.length, 2, 'each ctl put once')
  t.ok(pool.puts.every(isPrefix), 'each with the group drawn when it was queued')
  t.alike(await store.readDmCtlQueue(E.storage, store.pageDmPrefix(P.page)), [], 'nothing left queued')
})

test('buckets: a lock during the Página catch-up writes nothing for the Página', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const C = crypto.keyPair()
  const P = await E.adopt()
  pool.add(strayDrop(assoc, C))
  pool.add(dropTo(assoc, C, P.page, P.box, 'para a página'))
  pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 3)
  const prefix = store.pageDmPrefix(P.page)
  const writes = []
  let locked = false
  const writeJson = E.storage.writeJson.bind(E.storage)
  E.storage.writeJson = (k, v) => {
    if (locked) writes.push(k)
    return writeJson(k, v)
  }
  pool.onPage = (q) => {
    if (q.after !== 0) return
    E.engine.lock()
    locked = true
  }
  const err = await errorOf(E.engine.pull(E.own))
  t.is(err && err.message, LOCKED)
  t.alike(pool.pages.map((q) => q.after), [3, 0], 'locked during the catch-up')
  t.absent(writes.some((k) => k.startsWith(prefix)), 'no Página write after the lock')
  t.is((await store.readPageCursor(E.storage, prefix)).after, 0)
  await E.engine.unlock(E.prf)
  await E.engine.loaded()
  t.alike((await E.engine.thread(E.own, { peer: hex(C.publicKey), page: P.page })).messages, [], 'nothing filed for the Página')
})

test('buckets: a lock as the Página catch-up reaches the pool end leaves its cursor at the last item it read', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, { pageMax: 1 })
  const C = crypto.keyPair()
  const P = await E.adopt()
  for (let i = 0; i < 3; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 3)
  const prefix = store.pageDmPrefix(P.page)
  // The catch-up's last page, which a sweep leaves empty, so the end-of-pool
  // move touches no Página store (one refuses on its own once locked). The
  // lock comes with the blocklist read that follows the page, past the
  // reads of the own store that would refuse too.
  let armed = false
  pool.onPage = (q) => {
    if (q.after !== 2) return
    pool.sweep(3)
    armed = true
  }
  const readJson = E.storage.readJson.bind(E.storage)
  E.storage.readJson = async (k) => {
    if (armed && k === 'blocklist') {
      armed = false
      E.engine.lock()
    }
    return readJson(k)
  }
  const err = await errorOf(E.engine.pull(E.own))
  t.is(err && err.message, LOCKED)
  t.alike(pool.pages.map((q) => q.after), [3, 0, 1, 2], 'locked on the catch-up\'s last page')
  t.is((await store.readPageCursor(E.storage, prefix)).after, 2, 'not moved up to the own cursor after the lock')
})
