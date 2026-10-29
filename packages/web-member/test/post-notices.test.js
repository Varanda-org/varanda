// Reply, quote and mention notices of the browser node (lib/notices.js over
// 'varanda/notices/2', through lib/session.js and an in-memory client),
// loopback only, against the seeder stand-in of helpers/notices.js serving
// hand-made kinded pages, so it can lie about kinds, seqs and instants.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createUsernameRecord } = require('@varanda/core/lib/cert')
const { profileRecord, postRecord, followRecord } = require('@varanda/core/lib/records')
const { writeBlocklist, writeFollows } = require('../lib/node-store')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const {
  HOUR,
  hex,
  association,
  moderator,
  snapshot,
  issuer,
  iso,
  diary,
  certOf,
  noticesSeeder,
  spyStorage,
  webNode,
  keysOf,
  withoutSeen,
  seenOf
} = require('./helpers/notices')

function order (a, b) {
  return (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (b.seq - a.seq)
}

// A v2 page callback over `items` ({ key, seq, at, kind }) for `target`
// only, in notices order, continuing strictly after the cursor.
function v2Pages (target, items) {
  const sorted = [...items].sort(order)
  return (t, after, limit) => {
    if (t !== target) return { items: [], next: null, incomplete: false }
    const from = after === null ? 0 : sorted.findIndex((it) => order(it, after) > 0)
    const page = from < 0 ? [] : sorted.slice(from, from + limit)
    const last = page[page.length - 1]
    const next = from >= 0 && from + limit < sorted.length ? { at: last.at, key: last.key, seq: last.seq } : null
    return { items: page, next, incomplete: false }
  }
}

function empty () {
  return { items: [], next: null, incomplete: false }
}

function rowsOf (r) {
  return r.notices.map((n) => [n.key, n.seq, n.kind])
}

async function setup (t, { v2 = true, storage, v2Silent = false, notices = {} } = {}) {
  const assoc = association()
  const state = { cores: [], page: empty }
  if (v2) state.pageV2 = empty
  const seeder = await noticesSeeder(t, { signer: assoc.kp, state, v2Silent })
  const keyPair = crypto.keyPair()
  const seed = b4a.from(keyPair.secretKey.subarray(0, 32)) // copied: a lock zeroes the pair
  const B = await webNode(t, assoc, seeder.url, { certify: true, keyPair, notices, ...(storage ? { storage } : {}) })
  return { assoc, state, seeder, seed, ...B }
}

test('replies and quotes of own posts are listed with the kind the signed block proves; forged items drop silently', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { assoc, state, seeder, web, key: me, internal } = await setup(t)
  const own = await web.request('post.create', { text: 'meu post' })
  const other = hex(crypto.keyPair().publicKey)

  const reply = postRecord({ text: 'resposta', replyTo: { author: me, seq: own.seq }, at: iso(now - HOUR) })
  const R = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Rui', bio: '' }), () => reply])
  const quote = postRecord({ text: 'citação', quote: { author: me, seq: own.seq }, at: iso(now - 2 * HOUR) })
  const Q = await diary(t, [certOf(assoc), () => quote])
  const notPost = postRecord({ text: 'a um bloco que não é post', replyTo: { author: me, seq: 99 }, at: iso(now - 3 * HOUR) })
  const N = await diary(t, [certOf(assoc), () => notPost])
  const elsewhere = postRecord({ text: 'a outra pessoa', replyTo: { author: other, seq: own.seq }, at: iso(now - 4 * HOUR) })
  const E = await diary(t, [certOf(assoc), () => elsewhere])
  const plain = postRecord({ text: 'nada a ver', at: iso(now - 5 * HOUR) })
  const U = await diary(t, [certOf(assoc), () => plain])
  const shifted = postRecord({ text: 'resposta', replyTo: { author: me, seq: own.seq }, at: iso(now - 6 * HOUR) })
  const M = await diary(t, [certOf(assoc), () => shifted])
  const future = postRecord({ text: 'do futuro', replyTo: { author: me, seq: own.seq }, at: iso(now + 48 * HOUR) })
  const F = await diary(t, [certOf(assoc), () => future])
  state.cores = [R, Q, N, E, U, M, F]
  state.pageV2 = v2Pages(me, [
    { key: hex(R.key), seq: 2, at: reply.at, kind: 'reply' },
    { key: hex(Q.key), seq: 1, at: quote.at, kind: 'reply' }, // the hint lies: a quote
    { key: hex(N.key), seq: 1, at: notPost.at, kind: 'reply' },
    { key: hex(E.key), seq: 1, at: elsewhere.at, kind: 'reply' },
    { key: hex(U.key), seq: 1, at: plain.at, kind: 'mention' },
    { key: hex(M.key), seq: 1, at: iso(now - 7 * HOUR), kind: 'reply' }, // not the block's at
    { key: hex(F.key), seq: 1, at: future.at, kind: 'reply' }
  ])

  const r = await web.request('notices.list', {})
  t.alike(withoutSeen(t, r), {
    notices: [
      { key: hex(R.key), seq: 2, at: reply.at, kind: 'reply', name: 'Rui', avatar: null, username: null },
      { key: hex(Q.key), seq: 1, at: quote.at, kind: 'quote', name: null, avatar: null, username: null }
    ],
    next: null,
    incomplete: false,
    supported: true,
    activity: true
  })
  t.is(seeder.pages.length, 0, 'the v1 channel was not read')
  t.alike(seeder.pagesV2[0], { target: me, after: null, limit: 64 })
  t.alike(internal, [])
})

test('a mention counts only against a username the own diary verifiably held, the name before a rename included, under the current revoked issuers', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { assoc, state, web, key: me, storage, internal } = await setup(t)
  const iss = issuer(assoc)
  const mod = moderator(assoc.kp)
  await web.request('username.add', { record: createUsernameRecord({ member: me, username: 'ana', date: iso(now - 10 * HOUR) }, iss.keyPair, iss.cert) })
  await web.request('username.add', { record: createUsernameRecord({ member: me, username: 'bia', date: iso(now - 9 * HOUR) }, iss.keyPair, iss.cert) })

  const old = postRecord({ text: 'oi @ana', at: iso(now - HOUR) })
  const A = await diary(t, [certOf(assoc), () => old])
  const current = postRecord({ text: 'olá @BIA!', at: iso(now - 2 * HOUR) })
  const B = await diary(t, [certOf(assoc), () => current])
  const never = postRecord({ text: '@carla oi', at: iso(now - 3 * HOUR) })
  const C = await diary(t, [certOf(assoc), () => never])
  const inWord = postRecord({ text: 'email@ana', at: iso(now - 4 * HOUR) })
  const D = await diary(t, [certOf(assoc), () => inWord])
  state.cores = [A, B, C, D]
  state.pageV2 = v2Pages(me, [
    { key: hex(A.key), seq: 1, at: old.at, kind: 'mention' },
    { key: hex(B.key), seq: 1, at: current.at, kind: 'mention' },
    { key: hex(C.key), seq: 1, at: never.at, kind: 'mention' },
    { key: hex(D.key), seq: 1, at: inWord.at, kind: 'mention' }
  ])

  const r = await web.request('notices.list', {})
  t.alike(rowsOf(r), [[hex(A.key), 1, 'mention'], [hex(B.key), 1, 'mention']])
  t.is(r.incomplete, false, 'a mention of a name never held is not a failure')
  t.is(r.activity, true)

  // The issuer of both names is revoked: no name of the own diary counts.
  const uploads = A.uploads + B.uploads
  await writeBlocklist(storage, snapshot(mod, { revokedIssuers: [iss.hex] }))
  const revoked = await web.request('notices.list', {})
  t.alike(revoked.notices, [], 'mentions dropped with the names')
  t.is(revoked.incomplete, false)
  await writeBlocklist(storage, snapshot(mod, { seq: 2, revokedIssuers: [] }))
  const back = await web.request('notices.list', {})
  t.alike(rowsOf(back), [[hex(A.key), 1, 'mention'], [hex(B.key), 1, 'mention']], 'back once unrevoked')
  t.is(A.uploads + B.uploads, uploads, 'judged again from the cached block facts')
  t.alike(internal, [])
})

test('an author already followed: their post rows stay, their follow rows drop, whatever the hint', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { assoc, state, web, key: me, storage, internal } = await setup(t)
  const own = await web.request('post.create', { text: 'meu post' })
  const follow = followRecord({ key: me, on: true, at: iso(now - 3 * HOUR) })
  const reply = postRecord({ text: 'resposta', replyTo: { author: me, seq: own.seq }, at: iso(now - HOUR) })
  const F = await diary(t, [certOf(assoc), () => follow, () => reply])
  const gFollow = followRecord({ key: me, on: true, at: iso(now - 2 * HOUR) })
  const G = await diary(t, [certOf(assoc), () => gFollow])
  state.cores = [F, G]
  state.pageV2 = v2Pages(me, [
    { key: hex(F.key), seq: 1, at: follow.at, kind: 'follow' },
    { key: hex(F.key), seq: 2, at: reply.at, kind: 'reply' },
    { key: hex(G.key), seq: 1, at: gFollow.at, kind: 'reply' } // a follow behind a lying hint
  ])

  const before = await web.request('notices.list', {})
  t.alike(rowsOf(before), [[hex(F.key), 2, 'reply'], [hex(G.key), 1, 'follow'], [hex(F.key), 1, 'follow']], 'every row while nobody is followed')
  t.is(before.incomplete, false, 'two rows of one author are both fetched')

  await writeFollows(storage, [hex(F.key), hex(G.key)])
  const r = await web.request('notices.list', {})
  t.alike(rowsOf(r), [[hex(F.key), 2, 'reply']])
  t.is(r.incomplete, false)
  t.alike(internal, [])
})

test('a v1-only seeder: follow rows with kind follow, activity false, no storage core opened, a 3-key cursor sent as 2 keys', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { storage, spy } = spyStorage()
  const { assoc, state, seeder, seed, web, key: me, internal } = await setup(t, { v2: false, storage })
  const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => profileRecord({ name: 'Dani', bio: '' }), () => f])
  state.cores = [D]
  state.page = (target) => ({ items: target === me ? [{ key: hex(D.key), seq: 2, at: f.at }] : [], next: null, incomplete: false })

  spy.recording = true
  const r = await web.request('notices.list', {})
  spy.recording = false
  t.alike(withoutSeen(t, r), {
    notices: [{ key: hex(D.key), seq: 2, at: f.at, kind: 'follow', name: 'Dani', avatar: null, username: null }],
    next: null,
    incomplete: false,
    supported: true,
    activity: false
  })
  t.is(r.notices[0].seen, seenOf(seed, me, hex(D.key), 2), 'the seen token is unchanged')
  t.alike(spy.cores, [], 'no core of the node storage was opened')
  t.alike(spy.writes, [], 'no kv entry was written')

  const cursor = { at: iso(now), key: hex(crypto.keyPair().publicKey), seq: 4 }
  await web.request('notices.list', { after: cursor })
  t.alike(seeder.pages[1].after, { at: cursor.at, key: cursor.key }, 'v1 takes no seq')
  t.alike(internal, [])
})

test('a follow row over v2 keeps its seen token', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { assoc, state, seed, web, key: me, internal } = await setup(t)
  const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => f])
  state.cores = [D]
  state.pageV2 = v2Pages(me, [{ key: hex(D.key), seq: 1, at: f.at, kind: 'follow' }])
  const r = await web.request('notices.list', {})
  t.alike(rowsOf(r), [[hex(D.key), 1, 'follow']])
  t.is(r.activity, true)
  t.is(r.notices[0].seen, seenOf(seed, me, hex(D.key), 1), 'byte-identical to the follows-only token')
  t.alike(internal, [])
})

test('cursor: three posts of one author at one instant walk one by one with 3-key cursors; a 2-key cursor skips its group', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { assoc, state, seeder, web, key: me, internal } = await setup(t)
  const own = await web.request('post.create', { text: 'meu post' })
  const at = iso(now - HOUR)
  const make = (n) => () => postRecord({ text: 'resposta ' + n, replyTo: { author: me, seq: own.seq }, at })
  const A = await diary(t, [certOf(assoc), make(1), make(2), make(3)])
  state.cores = [A]
  const key = hex(A.key)
  state.pageV2 = v2Pages(me, [1, 2, 3].map((seq) => ({ key, seq, at, kind: 'reply' })))

  const seen = []
  let after
  for (let i = 0; i < 4; i++) {
    const r = await web.request('notices.list', after === undefined ? { limit: 1 } : { limit: 1, after })
    seen.push(...r.notices.map((n) => n.seq))
    t.is(r.incomplete, false)
    if (r.next === null) break
    t.alike(r.next, { at, key, seq: r.notices[0].seq }, 'a 3-key cursor')
    after = r.next
  }
  t.alike(seen, [3, 2, 1], 'each exactly once, newest seq first')
  t.alike(seeder.pagesV2[1].after, { at, key, seq: 3 }, 'the cursor reached the seeder')

  const skipped = await web.request('notices.list', { after: { at, key } })
  t.alike(skipped.notices, [], 'the rest of the (at, key) group is skipped')
  t.alike(seeder.pagesV2[seeder.pagesV2.length - 1].after, { at, key, seq: 1 })
  t.alike(internal, [])
})

test('the own diary is read once per v2 read, and not at all while its length is unchanged', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { storage, spy } = spyStorage()
  const { assoc, state, web, key: me, internal } = await setup(t, { storage })
  const own = await web.request('post.create', { text: 'meu post' })
  const reply = postRecord({ text: 'resposta', replyTo: { author: me, seq: own.seq }, at: iso(now - HOUR) })
  const R = await diary(t, [certOf(assoc), () => reply])
  state.cores = [R]
  state.pageV2 = v2Pages(me, [{ key: hex(R.key), seq: 1, at: reply.at, kind: 'reply' }])

  const realContext = member.ownNoticeContext
  const realReadAll = store.readAll
  let inside = 0
  let contexts = 0
  let reads = 0
  member.ownNoticeContext = async (...args) => {
    contexts++
    inside++
    try { return await realContext(...args) } finally { inside-- }
  }
  store.readAll = (...args) => {
    if (inside > 0) reads++
    return realReadAll(...args)
  }
  t.teardown(() => {
    member.ownNoticeContext = realContext
    store.readAll = realReadAll
  })

  spy.recording = true
  const first = await web.request('notices.list', {})
  spy.recording = false
  t.alike(keysOf(first), [hex(R.key)])
  t.is(contexts, 1, 'one own context per read')
  t.is(reads, 1, 'the own diary was read')
  t.alike(spy.cores.filter((name) => name === store.DIARY).length, 1, 'only the own diary core was opened, once')
  t.alike(spy.cores.filter((name) => name !== store.DIARY), [])

  await web.request('notices.list', {})
  t.is(contexts, 2)
  t.is(reads, 1, 'unchanged length: not read again')

  await web.request('post.create', { text: 'outro post' })
  await web.request('notices.list', {})
  t.is(contexts, 3)
  t.is(reads, 2, 'read again after an append')
  t.alike(internal, [])
})

test('activity stays true when the read learned nothing about the channels: own key blocked', async (t) => {
  t.timeout(90000)
  const { assoc, seeder, web, key: me, storage, internal } = await setup(t)
  await writeBlocklist(storage, snapshot(moderator(assoc.kp), { blocked: [me] }))
  const r = await web.request('notices.list', {})
  t.alike(r, { notices: [], next: null, incomplete: false, supported: true, activity: true })
  t.is(seeder.connections, 0, 'no link was opened')
  t.alike(internal, [])
})

test('v2 never answered but v1 taken: follow rows with activity false', async (t) => {
  t.timeout(90000)
  const now = Date.now()
  const { assoc, state, seeder, web, key: me, internal } = await setup(t, { v2: false, v2Silent: true, notices: { requestTimeoutMs: 1000 } })
  const f = followRecord({ key: me, on: true, at: iso(now - HOUR) })
  const D = await diary(t, [certOf(assoc), () => f])
  state.cores = [D]
  state.page = (target) => ({ items: target === me ? [{ key: hex(D.key), seq: 1, at: f.at }] : [], next: null, incomplete: false })
  const r = await web.request('notices.list', {})
  t.alike(rowsOf(r), [[hex(D.key), 1, 'follow']])
  t.is(r.activity, false)
  t.is(r.incomplete, false)
  t.is(r.supported, true)
  t.is(seeder.pages.length, 1, 'read over v1')
  t.alike(internal, [])
})
