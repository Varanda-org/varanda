'use strict'

// Rows of one author in one notices read (lib/notices.js, docs/rpc.md 5.28)
// share one memory storage: a block an earlier row fetched is read from it,
// the reopened core still takes the link's current head first, every check
// runs per row, and an abort leaves no core open and no storage kept.
// A fork is another history: the kept copy is stale and a fresh core is
// dropped. Loopback only: the seeder stand-in of ./helpers/notices.js.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { until } = require('./helpers/net')
const { hex, noop, association, moderator, snapshot, issuer, iso, diary, forkDiary, certOf, noticesSeeder, HOUR } = require('./helpers/notices')
const { createIssuedCert } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, followRecord, deleteRecord } = require('@varanda/core/lib/records')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const { createNoticer } = require('../lib/notices')
const { memoryNodeStorage } = require('../lib/node-storage')
const { writeBlocklist } = require('../lib/node-store')

const NO_SEEDER = 'sem conexão com o semeador'
const SEEN = '0'.repeat(32)

function empty () {
  return { items: [], next: null, incomplete: false }
}

function order (a, b) {
  return (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (b.seq - a.seq)
}

// A v3 page callback over `items` for `target`, in notices order, one page.
function pagesOf (target, items) {
  const sorted = [...items].sort(order)
  return (t) => t === target ? { items: sorted, next: null, incomplete: false } : empty()
}

// A noticer reading for a fresh identity whose own diary holds post blocks
// 1..20 (the own context is stubbed: no own diary is opened). Every trace
// event goes to `events`, and to onTrace when set.
async function setup (t, assoc, state, limits = {}) {
  const pair = crypto.keyPair()
  const me = hex(pair.publicKey)
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state })
  const events = []
  const hooks = { onTrace: noop }
  const storage = memoryNodeStorage()
  const noticer = createNoticer({
    storage,
    association: assoc.hex,
    seederUrl: seeder.url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    ownKey: async () => me,
    sign: (payload) => signNoticeProof(payload, pair),
    seenToken: () => SEEN,
    limits: {
      ...limits,
      trace: (ev) => {
        events.push(ev)
        hooks.onTrace(ev)
      }
    }
  })
  t.teardown(() => noticer.close(), { force: true })
  const posts = new Set()
  for (let s = 1; s <= 20; s++) posts.add(s)
  const read = (params = { limit: 30 }) => noticer.read(params, async () => ({ names: new Map(), posts }))
  return { me, seeder, noticer, events, hooks, storage, read }
}

// Per block index, how many times the core uploaded it.
function uploadsOf (core) {
  const counts = new Map()
  core.on('upload', (index) => counts.set(index, (counts.get(index) || 0) + 1))
  return counts
}

function ofKey (events, key, type) {
  return events.filter((e) => e.key === key && e.type === type)
}

test('five rows by one author: block 0 and the tail are fetched once, the rows are the ones each row proves', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events } = await setup(t, assoc, state)
  const replies = []
  for (let i = 0; i < 5; i++) replies.push(postRecord({ text: 'resposta ' + i, replyTo: { author: me, seq: i + 1 }, at: iso(now - (i + 1) * HOUR) }))
  // cert, profile, the five replies (seq 2..6), then 10 posts: the tail of
  // 8 does not reach the replies, so each row asks for its own block.
  const records = [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' })]
  for (const r of replies) records.push(() => r)
  for (let i = 0; i < 10; i++) records.push(() => postRecord({ text: 'p' + i, at: iso(now - 10 * HOUR - i) }))
  const A = await diary(t, records)
  t.is(A.length, 17)
  const counts = uploadsOf(A)
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, replies.map((r, i) => ({ key, seq: i + 2, at: r.at, kind: 'reply' })))

  const r = await read()
  t.alike(r, {
    notices: replies.map((rec, i) => ({ key, seq: i + 2, at: rec.at, kind: 'reply', name: 'Ana', avatar: null, username: null, seen: SEEN })),
    next: null,
    incomplete: false,
    supported: true,
    activity: true
  }, 'the five replies, newest first, each named by the signed profile')
  // Block 0 and the tail 9..16 once each, from the kept copy after that.
  // Below the tail, every row asks the seeder as without a kept copy: the
  // head 1..2 once per row, each reply 3..6 once by its own row.
  const expected = new Map([[0, 1], [1, 5], [2, 5], [3, 1], [4, 1], [5, 1], [6, 1]])
  for (let s = 9; s <= 16; s++) expected.set(s, 1)
  t.alike([...counts].sort((a, b) => a[0] - b[0]), [...expected], 'block 0 and the tail once, the blocks below the tail per row')
  t.is(ofKey(events, key, 'open').length, 5, 'one core per row')
  t.is(ofKey(events, key, 'open').filter((e) => e.reused).length, 4, 'the later rows reopen the first row\'s storage')
  t.ok(ofKey(events, key, 'local').some((e) => e.seq === 0), 'block 0 read locally by a later row')
  t.is(ofKey(events, key, 'kept').length, ofKey(events, key, 'released').length, 'nothing kept after the read')
})

test('growth between rows: the reopened core takes the current head, so a later row reads what the author appended', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events, hooks } = await setup(t, assoc, state)
  const follow = followRecord({ key: me, on: true, at: iso(now - 5 * HOUR) })
  const reply = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => follow, () => reply])
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, [{ key, seq: 3, at: reply.at, kind: 'reply' }, { key, seq: 2, at: follow.at, kind: 'follow' }])
  // Once the first row (the reply, newest) starts closing its core, the
  // author renames itself. The append is memory only, so it lands before the
  // next row's core hears anything from the link.
  let renamed = null
  hooks.onTrace = (ev) => {
    if (renamed === null && ev.type === 'closed' && ev.key === key) renamed = A.append(profileRecord({ name: 'Bia', bio: '' }))
  }

  const r = await read()
  await renamed
  t.is(A.length, 5)
  t.alike(r.notices.map((n) => [n.seq, n.kind, n.name]), [[3, 'reply', 'Ana'], [2, 'follow', 'Bia']], 'the second row sees the new profile')
  t.is(r.incomplete, false)
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false, true], 'the second row reopened the first row\'s storage')
  t.ok(ofKey(events, key, 'get').some((e) => e.seq === 4), 'the appended block was asked for')
  t.ok(ofKey(events, key, 'local').some((e) => e.seq === 0), 'block 0 came from the kept storage')
})

test('a reply deleted between rows: the kept copy still holds it, the tombstone drops its row', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events, hooks } = await setup(t, assoc, state)
  const first = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const second = postRecord({ text: 'de novo', replyTo: { author: me, seq: 2 }, at: iso(now - 2 * HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => first, () => second])
  const key = hex(A.key)
  state.cores = [A]
  // The first row (seq 2, newest) reads the tail, block 3 included, into the
  // storage the second row (seq 3) reopens.
  state.pageV3 = pagesOf(me, [{ key, seq: 2, at: first.at, kind: 'reply' }, { key, seq: 3, at: second.at, kind: 'reply' }])
  // Once the first row starts closing its core, the author deletes the
  // second reply and the seeder clears it, as real seeders do.
  let deleted = null
  hooks.onTrace = (ev) => {
    if (deleted === null && ev.type === 'closed' && ev.key === key) deleted = A.append(deleteRecord({ seq: 3 })).then(() => A.clear(3))
  }

  const r = await read()
  await deleted
  t.is(A.length, 5)
  t.alike(r.notices.map((n) => [n.seq, n.kind]), [[2, 'reply']], 'the deleted reply is not shown, the other one stands')
  t.is(r.incomplete, false, 'a known deletion is not an incomplete read')
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false, true], 'the second row reopened the first row\'s storage')
  t.ok(ofKey(events, key, 'local').some((e) => e.seq === 3), 'the deleted block came from the kept storage')
  t.ok(ofKey(events, key, 'accept').some((e) => e.seq === 4), 'the tombstone was read')
})

test('a revoked or blocked author drops every row, and a failed row hands no storage on', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const iss = issuer(assoc)
  const mod = moderator(assoc.kp)
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events, storage } = await setup(t, assoc, state)
  const reply = (k, h) => postRecord({ text: 'r' + k, replyTo: { author: me, seq: k }, at: iso(now - h * HOUR) })
  // R: certified by an issuer the association revoked.
  const rr = [reply(1, 1), reply(2, 2), reply(3, 3)]
  const R = await diary(t, [(key) => memberCertRecord(createIssuedCert({ member: key }, iss.keyPair, iss.cert)), () => rr[0], () => rr[1], () => rr[2]])
  const rCounts = uploadsOf(R)
  // B: blocked by the moderator.
  const br = [reply(4, 4), reply(5, 5), reply(6, 6)]
  const B = await diary(t, [certOf(assoc), () => br[0], () => br[1], () => br[2]])
  const bCounts = uploadsOf(B)
  // C: neither, one row that stands.
  const cr = reply(7, 7)
  const C = await diary(t, [certOf(assoc), () => cr])
  const rKey = hex(R.key)
  const bKey = hex(B.key)
  const cKey = hex(C.key)
  state.cores = [R, B, C]
  state.pageV3 = pagesOf(me, [
    ...rr.map((rec, i) => ({ key: rKey, seq: i + 1, at: rec.at, kind: 'reply' })),
    ...br.map((rec, i) => ({ key: bKey, seq: i + 1, at: rec.at, kind: 'reply' })),
    { key: cKey, seq: 1, at: cr.at, kind: 'reply' }
  ])
  await writeBlocklist(storage, snapshot(mod, { blocked: [bKey], revokedIssuers: [iss.hex] }))

  const r = await read()
  t.alike(r.notices.map((n) => n.key), [cKey], 'only the row of the author in good standing')
  t.is(r.incomplete, false)
  t.is(bCounts.size, 0, 'nothing of the blocked author was fetched')
  t.is(ofKey(events, bKey, 'open').length, 0, 'no core for the blocked author')
  const rOpens = ofKey(events, rKey, 'open')
  t.is(rOpens.length, 3, 'each row of the revoked author judged on its own')
  t.ok(rOpens.every((e) => e.reused === false), 'a row that failed its gate kept no storage for the next')
  t.is(ofKey(events, rKey, 'kept').length, 0)
  t.is(rCounts.get(0), 3, 'block 0 fetched by every row')
})

test('an abort leaves no row core open and no author storage kept', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const blockTimeoutMs = 8000
  // Two rows at once: A's first row verifies and keeps its storage for A's
  // last row, then the next item hangs beside B's.
  const { me, read, events, noticer } = await setup(t, assoc, state, { parallel: 2, blockTimeoutMs })
  const reply = (k, h) => postRecord({ text: 'r' + k, replyTo: { author: me, seq: k }, at: iso(now - h * HOUR) })
  const a1 = reply(1, 1)
  const a2 = reply(2, 9)
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => a1, () => a2])
  const b1 = reply(3, 2)
  const B = await diary(t, [certOf(assoc), () => b1])
  const c1 = reply(4, 3)
  const C = await diary(t, [certOf(assoc), () => c1])
  // B and C serve block 0, never the row's block.
  await B.clear(1)
  await C.clear(1)
  const aKey = hex(A.key)
  const bKey = hex(B.key)
  const cKey = hex(C.key)
  state.cores = [A, B, C]
  state.pageV3 = pagesOf(me, [
    { key: aKey, seq: 2, at: a1.at, kind: 'reply' },
    { key: bKey, seq: 1, at: b1.at, kind: 'reply' },
    { key: cKey, seq: 1, at: c1.at, kind: 'reply' },
    { key: aKey, seq: 3, at: a2.at, kind: 'reply' }
  ])
  const hanging = (key) => ofKey(events, key, 'get').some((e) => e.seq === 1) && !ofKey(events, key, 'settle').some((e) => e.seq === 1)

  const reading = read().then(() => null, (err) => err)
  await until(() => hanging(bKey) && hanging(cKey), { timeoutMs: 15000, name: 'B and C rows waiting for their block' })
  t.is(ofKey(events, aKey, 'kept').length, 1, 'A\'s first row kept its storage for A\'s last row')
  t.is(ofKey(events, aKey, 'released').length, 0, 'still kept at the abort')
  const abortedAt = Date.now()
  noticer.abort()
  const err = await reading
  t.is(err && err.message, NO_SEEDER, 'the aborted read ended')
  t.ok(Date.now() - abortedAt < blockTimeoutMs / 2, 'promptly')
  const opened = events.filter((e) => e.type === 'open').length
  const closed = events.filter((e) => e.type === 'closed').length
  t.ok(opened >= 3, 'rows had cores open')
  t.is(closed, opened, 'every row core closed')
  t.is(events.filter((e) => e.type === 'kept').length, events.filter((e) => e.type === 'released').length, 'no author storage kept')
  t.is(ofKey(events, aKey, 'open').length, 1, 'A\'s last row never started')
})

test('near the end of the budget a reused row starts one window get at a time, its local lookups counted as in flight', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  // Room for the first row's blocks and one more block, not two: a further
  // window get may start only while every get in flight still fits.
  const budgetBytes = 16384 + 8192
  const { me, read, events, hooks } = await setup(t, assoc, state, { budgetBytes })
  const follow = followRecord({ key: me, on: true, at: iso(now - 5 * HOUR) })
  const reply = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => follow, () => reply])
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, [{ key, seq: 3, at: reply.at, kind: 'reply' }, { key, seq: 2, at: follow.at, kind: 'follow' }])
  // Once the first row starts closing its core, the author appends six posts
  // (4..9): the second row's tail window misses each of them locally.
  let grown = null
  hooks.onTrace = (ev) => {
    if (grown === null && ev.type === 'closed' && ev.key === key) {
      const posts = []
      for (let i = 0; i < 6; i++) posts.push(postRecord({ text: 'p' + i, at: iso(now - 10 * HOUR - i) }))
      grown = A.append(posts)
    }
  }

  const r = await read()
  await grown
  t.is(A.length, 10)
  t.alike(r.notices.map((n) => [n.seq, n.kind]), [[3, 'reply'], [2, 'follow']])
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false, true], 'the second row reopened the first row\'s storage')
  const second = events.indexOf(ofKey(events, key, 'open')[1])
  const first = events.slice(0, second)
  const charged = first.filter((e) => e.key === key && e.type === 'charge')
  t.ok(charged.length > 0 && charged[charged.length - 1].budget + 16384 < budgetBytes, 'one more block fits after the first row')
  const rows = events.slice(second).filter((e) => e.key === key)
  t.ok(rows.some((e) => e.type === 'local' && e.seq === 0), 'block 0 came from the kept storage')
  // The tail is 2..9: the appended blocks 4..9, and head block 1 below it.
  t.alike(rows.filter((e) => e.type === 'get').map((e) => e.seq).sort((a, b) => b - a), [9, 8, 7, 6, 5, 4, 1], 'each appended block and the head block below the tail asked for once')
  let inFlight = 0
  let most = 0
  for (const e of rows) {
    if (e.type === 'get') most = Math.max(most, ++inFlight)
    else if (e.type === 'settle') inFlight--
  }
  t.is(most, 1, 'never more than one get of the row in flight')
})

test('a reply deleted between rows, its tombstone pushed below the next row\'s tail: the kept copy does not serve it', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  // The cleared block never arrives: the row waits out one block timeout.
  const { me, read, events, hooks } = await setup(t, assoc, state, { blockTimeoutMs: 2000 })
  const first = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const second = postRecord({ text: 'de novo', replyTo: { author: me, seq: 2 }, at: iso(now - 2 * HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => first, () => second])
  const key = hex(A.key)
  state.cores = [A]
  // The first row (seq 2) reads block 3 in its tail into the storage the
  // second row (seq 3) reopens.
  state.pageV3 = pagesOf(me, [{ key, seq: 2, at: first.at, kind: 'reply' }, { key, seq: 3, at: second.at, kind: 'reply' }])
  // Between the rows the author deletes the second reply (tombstone at 4,
  // the seeder clears 3), then appends 8 posts (5..12): the second row's
  // tail is 5..12, the tombstone below it.
  let changed = null
  hooks.onTrace = (ev) => {
    if (changed === null && ev.type === 'closed' && ev.key === key) {
      const posts = []
      for (let i = 0; i < 8; i++) posts.push(postRecord({ text: 'p' + i, at: iso(now - 10 * HOUR - i) }))
      changed = A.append(deleteRecord({ seq: 3 })).then(() => A.clear(3)).then(() => A.append(posts))
    }
  }

  const r = await read()
  await changed
  t.is(A.length, 13)
  t.alike(r.notices.map((n) => [n.seq, n.kind]), [[2, 'reply']], 'the deleted reply is not shown, the other one stands')
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false, true], 'the second row reopened the first row\'s storage')
  const second2 = events.indexOf(ofKey(events, key, 'open')[1])
  const rows = events.slice(second2).filter((e) => e.key === key)
  t.ok(rows.some((e) => e.type === 'local' && e.seq === 0), 'block 0 came from the kept storage')
  t.absent(rows.some((e) => e.type === 'local' && e.seq === 3), 'the row\'s block below the tail was not read from the kept storage')
  t.ok(rows.some((e) => e.type === 'get' && e.seq === 3), 'it was asked of the seeder')
  t.absent(rows.some((e) => e.type === 'charge' && e.seq === 3), 'and never arrived')
})

test('a kept copy that still matches is the only core the next row opens', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events } = await setup(t, assoc, state)
  const newer = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const older = postRecord({ text: 'de novo', replyTo: { author: me, seq: 2 }, at: iso(now - 2 * HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => newer, () => older])
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, [{ key, seq: 2, at: newer.at, kind: 'reply' }, { key, seq: 3, at: older.at, kind: 'reply' }])

  const r = await read()
  t.alike(r.notices.map((n) => [n.seq, n.kind, n.name]), [[2, 'reply', 'Ana'], [3, 'reply', 'Ana']], 'both rows stand')
  t.is(r.incomplete, false)
  // A matching copy has to return on its own. If every reused row fell
  // through to a fresh core, the fork test could not show that its second
  // open is the STALE path.
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false, true], 'the second row opened the kept copy and no other core')
  t.is(ofKey(events, key, 'kept').length, 1, 'the first row kept the copy')
  t.is(ofKey(events, key, 'open').length, ofKey(events, key, 'closed').length, 'no core stays open')
})

test('a fork after a kept copy: the next row does not answer from it, opens one fresh core, and is dropped', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events, hooks } = await setup(t, assoc, state)
  const newer = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const older = postRecord({ text: 'de novo', replyTo: { author: me, seq: 2 }, at: iso(now - 2 * HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => newer, () => older])
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, [{ key, seq: 2, at: newer.at, kind: 'reply' }, { key, seq: 3, at: older.at, kind: 'reply' }])
  // The copy is in the store only once 'kept' fires, and the next row of this
  // author waits on the key lock, so the rewrite starts before that row opens.
  // The read awaits its own answer: an in-memory rewrite finishes before the
  // next row's core hears the link.
  let forked = null
  hooks.onTrace = (ev) => {
    if (forked === null && ev.type === 'kept' && ev.key === key) {
      forked = forkDiary(A, 3, [() => postRecord({ text: 'reescrito', replyTo: { author: me, seq: 2 }, at: iso(now - 3 * HOUR) })])
    }
  }

  const r = await read()
  await forked
  t.is(A.fork, 1, 'the diary forked after the copy was kept')
  t.is(A.length, 4, 'the rewritten suffix replaced the older reply')
  t.alike(r.notices.map((n) => [n.seq, n.kind, n.name]), [[2, 'reply', 'Ana']], 'the row verified before the fork stands, the later one is dropped')
  t.is(r.incomplete, false, 'a dropped fork is not an incomplete read')
  t.is(r.next, null)
  const opens = ofKey(events, key, 'open')
  t.alike(opens.map((e) => e.reused), [false, true, false], 'the second row opened the kept copy, then exactly one fresh core')
  const reusedAt = events.indexOf(opens[1])
  const freshAt = events.indexOf(opens[2])
  t.is(ofKey(events, key, 'kept').length, 1, 'only the first row kept a copy')
  t.ok(events.indexOf(ofKey(events, key, 'kept')[0]) < reusedAt, 'kept before the reused open')
  t.absent(events.slice(reusedAt).some((e) => e.key === key && e.type === 'kept'), 'no kept trace after the fork')
  t.alike(events.slice(reusedAt + 1, freshAt).filter((e) => e.key === key).map((e) => e.type), ['closed'], 'the kept copy returned before reading a block')
  t.alike(events.slice(freshAt).filter((e) => e.key === key && e.type === 'get').map((e) => e.seq), [0], 'the fresh core read block 0 and stopped')
  t.is(ofKey(events, key, 'closed').length, opens.length, 'no core stays open')
})

test('a diary forked before the read: one fresh core, the row is dropped, and no block past 0 is fetched', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events } = await setup(t, assoc, state)
  // The suffix is still a reply under the signed length, with the certificate
  // kept: the gate, the quota and the seq check would let the row through.
  const reply = postRecord({ text: 'reescrito', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => postRecord({ text: 'antes', replyTo: { author: me, seq: 1 }, at: iso(now - 2 * HOUR) })])
  await forkDiary(A, 2, [() => reply])
  t.is(A.fork, 1)
  t.is(A.length, 3)
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, [{ key, seq: 2, at: reply.at, kind: 'reply' }])

  const r = await read()
  t.alike(r.notices, [], 'the forked diary is dropped')
  t.is(r.incomplete, false, 'a dropped fork is not an incomplete read')
  t.is(r.next, null)
  t.is(r.supported, true)
  t.is(r.activity, true)
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false], 'one fresh core')
  t.alike(ofKey(events, key, 'get').map((e) => e.seq), [0], 'block 0 only: the fork check drops the row before its block')
  t.is(ofKey(events, key, 'kept').length, 0, 'nothing kept')
  t.is(ofKey(events, key, 'released').length, 0)
  t.is(ofKey(events, key, 'closed').length, 1, 'the core did not stay open')
})

test('a fork while the row reads its blocks: the window passes, the fork check after it drops the row', async (t) => {
  t.timeout(90000)
  const assoc = association()
  const now = Date.now()
  const state = { cores: [], page: empty, pageV2: empty, pageV3: empty }
  const { me, read, events, hooks } = await setup(t, assoc, state)
  const reply = postRecord({ text: 'oi', replyTo: { author: me, seq: 1 }, at: iso(now - HOUR) })
  const A = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Ana', bio: '' }), () => reply, () => postRecord({ text: 'depois', at: iso(now - 2 * HOUR) })])
  const key = hex(A.key)
  state.cores = [A]
  state.pageV3 = pagesOf(me, [{ key, seq: 2, at: reply.at, kind: 'reply' }])
  // Truncating at the full length cuts no block the row reads, so its gets
  // still settle: only the fork moves, after the check before the window.
  let forked = null
  hooks.onTrace = (ev) => {
    if (forked === null && ev.type === 'get' && ev.key === key && ev.seq === 2) {
      forked = forkDiary(A, 4, [() => postRecord({ text: 'outra', at: iso(now - 30 * 60 * 1000) })])
    }
  }

  const r = await read()
  await forked
  t.is(A.fork, 1)
  t.is(A.length, 5)
  t.alike(r.notices, [], 'the row is dropped')
  t.is(r.incomplete, false, 'a dropped fork is not an incomplete read')
  t.alike(ofKey(events, key, 'open').map((e) => e.reused), [false], 'one fresh core')
  t.alike(ofKey(events, key, 'get').map((e) => e.seq).sort((a, b) => a - b), [0, 1, 2, 3], 'the window read its blocks')
  t.is(ofKey(events, key, 'kept').length, 0, 'nothing kept')
})
