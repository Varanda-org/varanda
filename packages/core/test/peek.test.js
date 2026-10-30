'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createCert, createIssuerCert, createIssuedCert, createUsernameRecord } = require('../lib/cert')
const { profileRecords } = require('../lib/records')
const { MAX_FUTURE_MS } = require('../lib/feed')
const {
  PEEK_HEAD_BLOCKS, PEEK_TAIL_BLOCKS, PEEK_MAX_BLOCKS_PER_DIARY, PEEK_MAX_ROUNDS,
  PEEK_PARALLEL, PEEK_FETCH_TIMEOUT_MS, PEEK_PAGE_TIMEOUT_MS, PEEK_CONNECT_TIMEOUT_MS,
  PEEK_SNAPSHOT_TTL_MS, PEEK_PAGE_MAX_BYTES, PEEK_RULE,
  peekCandidates, peekWindow, diaryPeek, buildPeekPage, isPeekCursor, retainRecords
} = require('../lib/peek')

const AT = '2026-10-25T12:00:00.000Z'
const NOW = Date.parse(AT)
const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const MEDIA = [{ core: 'dd'.repeat(32), mime: 'image/png', start: 1, blocks: 1, bytes: 10, sha256: 'ee'.repeat(32), width: 4, height: 4 }]

function profile (name = 'Ana') {
  return { type: 'profile', name, bio: '', at: AT }
}

function post (text = 'oi', at = AT, replyTo = null) {
  return { type: 'post', text, at, replyTo }
}

function fixture () {
  const kp = crypto.keyPair()
  const association = b4a.toString(kp.publicKey, 'hex')
  const cert = createCert({ member: A, date: AT }, kp)
  const issuerKp = crypto.keyPair()
  const issuer = b4a.toString(issuerKp.publicKey, 'hex')
  const issuerCert = createIssuerCert({ issuer, date: AT }, kp)
  const username = createUsernameRecord({ member: A, username: 'ana', date: AT }, issuerKp, issuerCert)
  const entries = [{ seq: 0, record: { type: 'member-cert', cert } }, { seq: 1, record: profile() }, { seq: 2, record: username }]
  return { key: A, length: 3, entries, fetched: new Set([0, 1, 2]), association, now: NOW, issuer, issuerKp, issuerCert }
}

function diary (key, count, offset = 0) {
  const posts = Array.from({ length: count }, (_, i) => ({
    seq: count - i,
    at: new Date(NOW + offset - i * 1000).toISOString(),
    text: key.slice(0, 2) + ' ' + i,
    media: null
  }))
  return { key, name: key.slice(0, 2), username: null, posts, exhausted: true }
}

function refs (items) {
  return items.map(({ author, seq, round }) => [author, seq, round])
}

test('peek constants and the public rule', (t) => {
  t.alike([PEEK_HEAD_BLOCKS, PEEK_TAIL_BLOCKS, PEEK_MAX_BLOCKS_PER_DIARY, PEEK_MAX_ROUNDS], [3, 8, 64, 3])
  t.alike([PEEK_PARALLEL, PEEK_FETCH_TIMEOUT_MS, PEEK_PAGE_TIMEOUT_MS, PEEK_CONNECT_TIMEOUT_MS, PEEK_SNAPSHOT_TTL_MS, PEEK_PAGE_MAX_BYTES], [16, 10000, 25000, 15000, 300000, 16777216])
  t.is(PEEK_RULE, 'A Espiadinha mostra a publicação mais recente de cada diário que você não segue, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos.')
})

test('peekCandidates filters inventory, lowercases keys and sorts without mutation', (t) => {
  const inventory = new Map([[C, 12], [A.toUpperCase(), 5], [B, 2], ['dd'.repeat(32), 4], ['ee'.repeat(32), 4], ['ff'.repeat(32), 0], ['11'.repeat(32), 1]])
  const follows = new Set(['dd'.repeat(32)])
  const blocked = new Set(['ee'.repeat(32)])
  const before = Array.from(inventory)
  // The own diary is not excluded: B (length 2) is a candidate like any other.
  t.alike(peekCandidates({ inventory, follows, blocked }), [{ key: A, length: 5 }, { key: B, length: 2 }, { key: C, length: 12 }])
  t.alike(Array.from(inventory), before)
  t.alike(Array.from(follows), ['dd'.repeat(32)])
  t.alike(Array.from(blocked), ['ee'.repeat(32)])
})

test('peekCandidates keeps one candidate per key whatever its spelling', (t) => {
  const inventory = new Map([[A.toUpperCase(), 5], [A, 9], [B, 3]])
  const none = new Set()
  t.alike(peekCandidates({ inventory, follows: none, blocked: none }), [{ key: A, length: 5 }, { key: B, length: 3 }], 'the first spelling wins')
})

test('peekWindow starts with the head and newest eight, then descends with a strict cap', (t) => {
  const expected = new Map([
    [1, [0]],
    [2, [1, 0]],
    [5, [4, 3, 2, 1, 0]],
    [12, [11, 10, 9, 8, 7, 6, 5, 4, 2, 1, 0]],
    [100, [99, 98, 97, 96, 95, 94, 93, 92, 2, 1, 0]]
  ])
  for (const [length, first] of expected) {
    const fetched = new Set()
    t.alike(peekWindow(length, fetched), first, 'first window: ' + length)
    t.is(fetched.size, 0, 'pure')
    const totals = []
    let window = peekWindow(length, fetched)
    while (window.length) {
      t.is(new Set(window).size, window.length, 'no duplicate seqs')
      t.ok(window.every((seq) => seq >= 0 && seq < length && !fetched.has(seq)))
      for (const seq of window) fetched.add(seq)
      totals.push(fetched.size)
      t.ok(fetched.size <= PEEK_MAX_BLOCKS_PER_DIARY)
      window = peekWindow(length, fetched)
    }
    if (length === 100) t.alike(totals, [11, 19, 27, 35, 43, 51, 59, 64])
    else t.is(fetched.size, length)
    t.alike(peekWindow(length, fetched), [])
  }
  t.alike(peekWindow(0, new Set()), [])
  const fetched = new Set([99, 98, 97, 96, 95, 94, 93, 92, 2])
  t.alike(peekWindow(100, fetched), [91, 90, 89, 88, 87, 86, 85, 84, 1, 0], 'missing head is requested again')
  t.alike(peekWindow(12, new Set([0, 1, 2, 4, 6, 7, 8, 9, 10, 11])), [5, 3], 'fill a hole without fetching obtained seqs twice')
})

test('diaryPeek validates block zero and revoked issuers, with best effort names', (t) => {
  const f = fixture()
  const valid = diaryPeek(f)
  t.is(valid.reason, null)
  t.is(valid.name, 'Ana')
  t.is(valid.avatar, null)
  t.is(valid.username, 'ana')
  t.ok(valid.scanned)
  t.absent(valid.capped)
  for (const entries of [[], [{ seq: 0, record: null }], [{ seq: 0, record: profile() }]]) {
    t.is(diaryPeek({ ...f, entries }).reason, 'not-in-log')
  }
  t.is(diaryPeek({ ...f, key: B }).reason, 'member-mismatch')
  const revokedIssuers = new Set([f.issuer])
  const revokedUsername = diaryPeek({ ...f, revokedIssuers })
  t.is(revokedUsername.reason, null, 'v1 membership is unaffected')
  t.is(revokedUsername.username, null)
  const cert = createIssuedCert({ member: A, date: AT }, f.issuerKp, f.issuerCert)
  const entries = [{ seq: 0, record: { type: 'member-cert', cert } }, ...f.entries.slice(1)]
  t.is(diaryPeek({ ...f, entries, revokedIssuers }).reason, 'revoked-issuer')
  t.is(diaryPeek({ ...f, entries }).reason, null)
})

test('diaryPeek uses seq recency, skips future posts, and copies media', (t) => {
  const f = fixture()
  const withMedia = { ...post('foto', new Date(NOW - 1000).toISOString()), media: MEDIA }
  const entries = [...f.entries,
    { seq: 3, record: post('oldest') },
    { seq: 4, record: post('reply', AT, { author: B, seq: 1 }) },
    { seq: 5, record: post('future', new Date(NOW + MAX_FUTURE_MS + 1).toISOString()) },
    { seq: 6, record: post('at the boundary', new Date(NOW + MAX_FUTURE_MS).toISOString()) },
    { seq: 7, record: withMedia },
    { seq: 8, record: post('last written', new Date(NOW - 2000).toISOString()) },
    { seq: 9, record: profile('Newest name') }
  ].reverse()
  const result = diaryPeek({ ...f, length: 10, entries, fetched: new Set(entries.map((e) => e.seq)) })
  t.is(result.reason, null)
  t.is(result.name, 'Newest name')
  t.is(result.future, 1)
  t.alike(result.posts.map((p) => p.seq), [8, 7, 6], 'only the last three eligible posts, ordered by seq')
  t.is(result.posts[0].media, null)
  t.alike(result.posts[1].media, MEDIA)
  t.not(result.posts[1].media, withMedia.media)
  t.not(result.posts[1].media[0], withMedia.media[0])
  t.is(result.posts[2].at, new Date(NOW + MAX_FUTURE_MS).toISOString())
  t.ok(result.scanned)
  // A reply is a publication too: newest in the tail, it takes the first slot.
  const withReply = [{ seq: 10, record: post('reply', AT, { author: B, seq: 1 }) }, ...entries]
  const replied = diaryPeek({ ...f, length: 11, entries: withReply, fetched: new Set(withReply.map((e) => e.seq)) })
  t.alike(replied.posts.map((p) => [p.seq, p.replyTo]), [[10, { author: B, seq: 1 }], [8, null], [7, null]])
})

test('diaryPeek contiguity uses fetched even when records are discarded', (t) => {
  const f = fixture()
  const entries = [...f.entries, { seq: 3, record: post('below hole') }, { seq: 5, record: post('above hole') }, { seq: 6, record: null }, { seq: 7, record: post('newest') }]
  const fetched = new Set(entries.map((e) => e.seq))
  const input = { ...f, length: 8, entries, fetched }
  const result = diaryPeek(input)
  t.alike(result.posts.map((p) => p.seq), [7, 5], 'seq 4 is missing; invalid seq 6 still counts as fetched')
  t.absent(result.scanned)
  t.absent(result.capped)
  t.alike(diaryPeek({ ...input, entries: retainRecords(entries) }), result)
  fetched.add(4)
  t.alike(diaryPeek(input).posts.map((p) => p.seq), [7, 5, 3])
  t.ok(diaryPeek(input).scanned)
})

test('a missing head block is not a full scan', (t) => {
  const f = fixture()
  const entries = [f.entries[0], { seq: 1, record: profile() }, { seq: 3, record: post('newest') }]
  const result = diaryPeek({ ...f, length: 4, entries, fetched: new Set([0, 1, 3]) })
  t.absent(result.scanned, 'block 2 was never fetched')
  t.alike(peekWindow(4, new Set([0, 1, 3])), [2])
  t.ok(diaryPeek({ ...f, length: 4, entries, fetched: new Set([0, 1, 2, 3]) }).scanned)
  t.absent(diaryPeek({ ...f, length: 2, entries: [f.entries[0]], fetched: new Set([0]) }).scanned, 'short diary missing its last block')
  t.ok(diaryPeek({ ...f, length: 2, entries: [f.entries[0]], fetched: new Set([0, 1]) }).scanned)
})

test('a cap is not a full scan: an old post can remain undiscovered', (t) => {
  const f = fixture()
  const all = [f.entries[0], { seq: 1, record: profile() }, { seq: 2, record: profile() }, { seq: 3, record: post('old') }]
  for (let seq = 4; seq < 74; seq++) all.push({ seq, record: profile() })
  const fetched = new Set()
  let window = peekWindow(all.length, fetched)
  while (window.length) {
    for (const seq of window) fetched.add(seq)
    window = peekWindow(all.length, fetched)
  }
  const entries = all.filter(({ seq }) => fetched.has(seq))
  const result = diaryPeek({ ...f, length: all.length, entries, fetched })
  t.is(result.reason, null)
  t.is(fetched.size, 64)
  t.alike(result.posts, [])
  t.absent(result.scanned)
  t.ok(result.capped)
  t.alike(peekWindow(all.length, fetched), [])
})

test('retainRecords keeps copied certificate, profiles, usernames, posts, reposts and tombstones only', (t) => {
  const f = fixture()
  const tomb = { type: 'delete', seq: 9, at: AT }
  const entries = [...f.entries,
    { seq: 3, record: { ...post('foto'), media: MEDIA } },
    { seq: 4, record: post('reply', AT, { author: B, seq: 1 }) },
    { seq: 5, record: { type: 'follow', key: B, on: true, at: AT } },
    { seq: 6, record: { type: 'media-core', key: C, at: AT } },
    { seq: 7, record: { type: 'other' } },
    { seq: 8, record: null },
    { seq: 9, record: post('plain') },
    { seq: 10, record: { type: 'like', to: { author: B, seq: 1 }, on: true, at: AT } },
    { seq: 11, record: { type: 'repost', to: { author: B, seq: 1 }, on: true, at: AT } },
    { seq: 12, record: tomb },
    { seq: 13, record: { type: 'delete', seq: 0, at: AT } }
  ]
  const before = JSON.stringify(entries)
  const kept = retainRecords(entries)
  t.alike(kept.map(({ seq }) => seq), [0, 1, 2, 3, 4, 9, 11, 12])
  t.not(kept, entries)
  t.not(kept[0].record.cert, entries[0].record.cert)
  t.not(kept[3].record.media[0], MEDIA[0])
  t.alike(kept[3].record.media, MEDIA)
  t.not(kept[7].record, tomb)
  t.alike(kept[7].record, tomb)
  const input = { ...f, length: 14, entries, fetched: new Set(entries.map(({ seq }) => seq)) }
  t.alike(diaryPeek({ ...input, entries: kept }), diaryPeek(input))
  t.alike(diaryPeek(input).posts.map((p) => p.seq), [11, 4, 3], 'the tombstone hides seq 9')
  t.is(JSON.stringify(entries), before, 'inputs unchanged')
})

test('buildPeekPage: one slot per diary per round, numerical date then author order', (t) => {
  const diaries = [diary(A, 3), diary(B, 1, 2000), diary(C, 2, 1000)]
  const before = JSON.stringify(diaries)
  const page = buildPeekPage({ diaries, limit: 35 })
  t.alike(refs(page.items), [[B, 1, 0], [C, 2, 0], [A, 3, 0], [C, 1, 1], [A, 2, 1], [A, 1, 2]])
  t.alike(page.needs, [])
  t.is(page.next, null)
  t.is(JSON.stringify(diaries), before)
  t.alike(Object.keys(page.items[0]), ['kind', 'author', 'name', 'avatar', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', 'round'])
  t.is(page.items[0].kind, 'post')
  t.is(page.items[0].avatar, null)
  t.is(page.items[0].replyTo, null)
  t.is(page.items[0].quote, null)
  t.is(page.items[0].media, null)
  const tied = buildPeekPage({ diaries: [diary(C, 1), diary(B, 1), diary(A, 1)], limit: 35 })
  t.alike(tied.items.map((i) => i.author), [A, B, C])
  diaries[0].posts[0].media = MEDIA
  const photo = buildPeekPage({ diaries, limit: 35 }).items.find((i) => i.author === A)
  t.alike(photo.media, MEDIA)
  t.not(photo.media[0], MEDIA[0])
})

test('three rounds end even for a diary with fifty posts', (t) => {
  const diaries = [diary(A, 1), diary(B, 1), diary(C, 50, 10000)]
  const all = buildPeekPage({ diaries, limit: 35 })
  t.is(all.items.length, 5)
  t.alike(all.items.slice(0, 3).map((i) => i.author), [C, A, B])
  t.is(all.next, null)
  const exact = buildPeekPage({ diaries, limit: 5 })
  t.alike(exact.items, all.items)
  t.ok(isPeekCursor(exact.next), 'a full page always carries a cursor')
  t.alike(buildPeekPage({ diaries, limit: 5, after: exact.next }), { items: [], next: null, needs: [] }, 'the call after the last full page ends the Espiadinha')
  const first = buildPeekPage({ diaries, limit: 4 })
  t.ok(isPeekCursor(first.next))
  const last = buildPeekPage({ diaries, limit: 1, after: first.next })
  t.ok(isPeekCursor(last.next), 'the page is full')
  t.alike(buildPeekPage({ diaries, limit: 1, after: last.next }), { items: [], next: null, needs: [] })
  t.alike([...first.items, ...last.items], all.items)
})

test('cursor pages concatenate without overlap, and each diary contributes at most three posts', (t) => {
  for (const counts of [[3, 1, 2], [1, 1, 50], [50, 50, 50]]) {
    const diaries = [diary(A, counts[0]), diary(B, counts[1], 1000), diary(C, counts[2], 1000)]
    const full = buildPeekPage({ diaries, limit: 35 }).items
    for (const limit of [1, 2, 3, 4, 5, 6, 8, 9, 35]) {
      let after = null
      const combined = []
      let pages = 0
      do {
        const page = buildPeekPage({ diaries, limit, after })
        t.alike(page.needs, [])
        t.ok(page.items.length <= limit)
        if (page.items.length < limit) t.is(page.next, null)
        combined.push(...page.items)
        after = page.next
        if (++pages > 10) throw new Error('pagination did not terminate')
      } while (after)
      t.alike(combined, full, counts.join('/') + ', limit ' + limit)
      t.is(new Set(combined.map((i) => i.author + ':' + i.seq)).size, combined.length)
      for (const key of [A, B, C]) t.ok(combined.filter((i) => i.author === key).length <= 3)
      t.is(new Set(combined.map((i) => i.author + ':' + i.round)).size, combined.length)
    }
  }
})

test('needs completes a touched round before finalizing even a full page', (t) => {
  const a = diary(A, 3)
  const b = { ...diary(B, 0), exhausted: false }
  const c = { ...diary(C, 0), exhausted: false }
  const input = { diaries: [c, a, b], limit: 1 }
  const first = buildPeekPage(input)
  t.is(first.items.length, 1)
  t.alike(first.needs, [B, C])
  t.is(first.next, null, 'no cursor while the round can reorder')
  b.posts = diary(B, 1, 1000).posts
  c.exhausted = true
  const complete = buildPeekPage(input)
  t.alike(complete.needs, [])
  t.is(complete.items[0].author, B, 'newly fetched slot sorts ahead of the provisional slot')
  t.ok(isPeekCursor(complete.next))
  const second = buildPeekPage({ ...input, limit: 2, after: complete.next })
  t.alike(second.needs, [B], 'round one needs B even though this provisional page is full')
  b.exhausted = true
  const final = buildPeekPage({ ...input, limit: 35, after: complete.next })
  t.alike(final.needs, [])
  t.alike(final.items.map((i) => i.round), [0, 1, 2])
  t.is(final.next, null)
  t.alike(buildPeekPage({ diaries: [], limit: 35 }), { items: [], next: null, needs: [] })
})

test('buildPeekPage: the hidden diary never becomes an item on any round, in any case', (t) => {
  // B is the newest in every round, so its items sit at the head of each round.
  const diaries = [diary(A, 3), diary(B, 3, 5000), diary(C, 3)]
  const plain = buildPeekPage({ diaries, limit: 35 })
  t.is(plain.items.filter((i) => i.author === B).length, 3)
  for (const hidden of [B, B.toUpperCase()]) {
    const all = buildPeekPage({ diaries, limit: 35, hidden })
    t.alike(refs(all.items), refs(plain.items.filter((i) => i.author !== B)), 'rounds 0, 1 and 2 without B: ' + hidden.slice(0, 2))
    t.alike(all.next, plain.next)
    t.alike(all.needs, plain.needs)
    // The hidden diary still takes its slots: a full page keeps the cursor
    // of the unhidden page and shows fewer than `limit` items.
    const first = buildPeekPage({ diaries, limit: 4, hidden })
    const firstPlain = buildPeekPage({ diaries, limit: 4 })
    t.alike(refs(first.items), refs(firstPlain.items.filter((i) => i.author !== B)))
    t.is(first.items.length, 2)
    t.alike(first.next, firstPlain.next)
    const rest = buildPeekPage({ diaries, limit: 35, after: first.next, hidden })
    t.alike(refs(rest.items), refs(plain.items.slice(4).filter((i) => i.author !== B)))
    t.is(rest.next, null)
  }
  t.alike(buildPeekPage({ diaries: [diary(B, 3)], limit: 35, hidden: B }), { items: [], next: null, needs: [] })
})

test('buildPeekPage: the hidden diary lands in needs like a shown one', (t) => {
  const a = diary(A, 3)
  const pending = (key) => ({ ...diary(key, 0), exhausted: false })
  const plain = buildPeekPage({ diaries: [a, pending(B), pending(C)], limit: 35 })
  const hidden = buildPeekPage({ diaries: [a, pending(B), pending(C)], limit: 35, hidden: B })
  t.alike(plain.needs, [B, C])
  t.alike(hidden.needs, [B, C], 'requested exactly like an unhidden diary')
  t.is(hidden.next, null)
  // With one post fetched, round 1 is still pending for the hidden diary.
  const one = { ...diary(B, 1, 5000), exhausted: false }
  const later = buildPeekPage({ diaries: [a, one], limit: 35, hidden: B })
  t.alike(later.needs, [B])
  t.ok(later.items.every((i) => i.author !== B))
  t.alike(buildPeekPage({ diaries: [a, one], limit: 35 }).needs, [B])
})

test('buildPeekPage refuses an invalid hidden key and keeps null as no-op', (t) => {
  for (const hidden of ['zz'.repeat(32), 'aa', 42]) {
    t.exception.all(() => buildPeekPage({ diaries: [], limit: 1, hidden }), { name: 'TypeError', message: 'hidden inválido' })
  }
  const diaries = [diary(A, 3), diary(B, 3, 5000)]
  t.alike(buildPeekPage({ diaries, limit: 35, hidden: null }), buildPeekPage({ diaries, limit: 35 }))
})

function prng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function randomDiaries (rand) {
  const count = 2 + Math.floor(rand() * 19)
  const diaries = []
  for (let d = 0; d < count; d++) {
    const key = d.toString(16).padStart(2, '0').repeat(32)
    const fetched = Math.floor(rand() * 4)
    const posts = []
    for (let i = 0; i < fetched; i++) {
      const seq = 10 - i
      // Few distinct dates, so ties broken by author are common.
      const at = new Date(NOW - Math.floor(rand() * 6) * 1000).toISOString()
      if (rand() < 0.3) {
        posts.push({ kind: 'repost', seq, at, to: { author: A, seq: 1 } })
      } else {
        posts.push({ kind: 'post', seq, at, text: key.slice(0, 2) + ' ' + i, replyTo: null, quote: null, media: null })
      }
    }
    diaries.push({ key, name: key.slice(0, 2), username: null, posts, exhausted: rand() < 0.5 })
  }
  return diaries
}

test('buildPeekPage: hiding a diary changes nothing but the returned items', (t) => {
  const rand = prng(20261028)
  const limits = [1, 2, 3, 4, 30, 31]
  const mismatches = []
  let checked = 0
  let withCursor = 0
  let withNeeds = 0
  for (let n = 0; n < 200; n++) {
    const diaries = randomDiaries(rand)
    const limit = limits[Math.floor(rand() * limits.length)]
    let after = null
    if (rand() < 0.5) {
      const settled = diaries.map((d) => ({ ...d, exhausted: true }))
      after = buildPeekPage({ diaries: settled, limit: limits[Math.floor(rand() * 4)] }).next
    }
    if (after !== null) withCursor++
    const args = { diaries, limit, after }
    const plain = buildPeekPage(args)
    if (plain.needs.length > 0) withNeeds++
    for (const { key } of diaries) {
      for (const hidden of [key, key.toUpperCase()]) {
        const page = buildPeekPage({ ...args, hidden })
        checked++
        const expected = { items: plain.items.filter((i) => i.author !== key), next: plain.next, needs: plain.needs }
        if (JSON.stringify(page) !== JSON.stringify(expected)) mismatches.push({ n, limit, hidden: key.slice(0, 2), page, expected })
      }
    }
  }
  t.is(mismatches.length, 0, 'every hidden page equals the unhidden one minus its items')
  if (mismatches.length > 0) t.comment(JSON.stringify(mismatches[0]))
  t.ok(checked > 1000, 'checked ' + checked + ' hidden pages')
  t.ok(withCursor > 20 && withNeeds > 20, 'cases with a cursor and with needs')
})

test('buildPeekPage: a hidden item filling round 0 does not open round 1', (t) => {
  // Round 0 has exactly `limit` items, one of them hidden. B is not exhausted
  // and has one fetched post: round 1 would add it to needs.
  const x = diary(C, 3, 5000)
  const b = { ...diary(B, 1), exhausted: false }
  const plain = buildPeekPage({ diaries: [x, b], limit: 2 })
  t.alike(plain.needs, [])
  t.ok(plain.next !== null)
  const hidden = buildPeekPage({ diaries: [x, b], limit: 2, hidden: C })
  t.alike(hidden.needs, [], 'no needs from a round the unhidden page never visits')
  t.alike(hidden.next, plain.next)
  t.alike(refs(hidden.items), refs(plain.items.filter((i) => i.author !== C)))
  t.is(hidden.items.length, 1)
})

test('needs accumulates every round the page touches', (t) => {
  const a = diary(A, 3)
  const b = { ...diary(B, 0), exhausted: false }
  const c = { ...diary(C, 1, 1000), exhausted: false }
  const page = buildPeekPage({ diaries: [a, b, c], limit: 35 })
  t.alike(page.needs, [B, C], 'B lacks round zero; C lacks round one')
  t.is(page.next, null)
  t.alike(refs(page.items), [[C, 1, 0], [A, 3, 0], [A, 2, 1], [A, 1, 2]], 'provisional items')
})

test('next is null exactly when the page is not full', (t) => {
  for (const counts of [[3, 1, 2], [1, 1, 50], [50, 50, 50], [0, 0, 1]]) {
    const diaries = [diary(A, counts[0]), diary(B, counts[1], 1000), diary(C, counts[2], 2000)]
    for (let limit = 1; limit <= 10; limit++) {
      let after = null
      let pages = 0
      do {
        const page = buildPeekPage({ diaries, limit, after })
        t.alike(page.needs, [])
        t.is(page.next === null, page.items.length < limit, counts.join('/') + ', limit ' + limit)
        if (page.items.length === limit) t.ok(isPeekCursor(page.next))
        after = page.next
        if (++pages > 12) throw new Error('pagination did not terminate')
      } while (after)
    }
  }
})

test('negative-year ISO dates sort numerically and seq is carried, never compared by the cursor', (t) => {
  const diaries = [diary(A, 1), diary(B, 1)]
  diaries[0].posts[0].at = '-000001-01-01T00:00:00.000Z'
  diaries[1].posts[0].at = '-000002-01-01T00:00:00.000Z'
  const page = buildPeekPage({ diaries, limit: 1 })
  t.is(page.items[0].author, A)
  t.ok(isPeekCursor(page.next))
  const last = buildPeekPage({ diaries, limit: 35, after: { ...page.next, seq: 999 } })
  t.alike(last.items.map((i) => i.author), [B])
  t.is(last.next, null)
})

test('cursor validation is exact, defensive and reads accessor values once', (t) => {
  const valid = { round: 0, at: AT, author: A, seq: 1 }
  t.ok(isPeekCursor(valid))
  t.ok(isPeekCursor({ ...valid, round: Number.MAX_SAFE_INTEGER }))
  t.ok(isPeekCursor(Object.assign(Object.create(null), valid)))
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const throwing = { ...valid, get at () { throw new Error('hostile') } }
  const invalid = [undefined, false, 1, 'cursor', [], {}, revoked.proxy, throwing,
    { ...valid, extra: true }, { at: AT, author: A, seq: 1 },
    { ...valid, round: -1 }, { ...valid, round: 0.5 }, { ...valid, round: Infinity },
    { ...valid, at: '2026-10-25T12:00:00Z' }, { ...valid, at: 'x'.repeat(33) },
    { ...valid, at: '2026-13-25T12:00:00.000Z' }, { ...valid, at: new Date(AT) },
    { ...valid, author: A.toUpperCase() }, { ...valid, author: 'ab' },
    { ...valid, seq: 0 }, { ...valid, seq: -1 }, { ...valid, seq: 0.5 }, { ...valid, seq: Number.MAX_SAFE_INTEGER + 1 }
  ]
  t.absent(isPeekCursor(null))
  for (const after of invalid) {
    t.absent(isPeekCursor(after))
    // Undefined uses the public default, just like an omitted cursor.
    if (after === undefined) continue
    t.exception.all(() => buildPeekPage({ diaries: [], limit: 1, after }), { name: 'TypeError', message: 'after inválido' })
  }
  let reads = 0
  const changing = { ...valid, get at () { return ++reads === 1 ? AT : 'bad' } }
  t.execution(() => buildPeekPage({ diaries: [diary(A, 1)], limit: 1, after: changing }))
  t.is(reads, 1)
  t.alike(buildPeekPage({ diaries: [diary(A, 3)], limit: 1, after: { ...valid, round: 3 } }), { items: [], next: null, needs: [] })
  for (const limit of [0, -1, 0.5, NaN, Infinity]) t.exception.all(() => buildPeekPage({ diaries: [], limit }), /limit inválido/)
})

test('diaryPeek and retainRecords never throw on hostile records, entries or containers', (t) => {
  const f = fixture()
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const hostile = { get type () { throw new Error('hostile') } }
  const values = [null, undefined, 0, 'x', [], revoked.proxy, hostile]
  for (const value of values) {
    t.execution(() => diaryPeek(value))
    t.execution(() => retainRecords(value))
    t.execution(() => diaryPeek({ ...f, fetched: value }))
    t.execution(() => diaryPeek({ ...f, entries: value }))
    t.is(diaryPeek({ ...f, entries: [{ seq: 0, record: value }] }).reason, 'not-in-log')
  }
  const entries = [...f.entries, revoked.proxy, { get seq () { throw new Error('hostile') } }, { seq: 3, record: hostile }, { seq: 4, record: post() }]
  const input = { ...f, length: 5, entries, fetched: new Set([0, 1, 2, 3, 4]) }
  t.alike(diaryPeek(input).posts.map((p) => p.seq), [4])
  t.alike(diaryPeek({ ...input, entries: retainRecords(entries) }), diaryPeek(input))
  t.execution(() => diaryPeek({ get entries () { throw new Error('hostile') } }))
  t.execution(() => diaryPeek({ ...input, fetched: { has () { throw new Error('hostile') } } }))
})

test('quotes and reposts in effect are publications; likes and undone reposts are not', (t) => {
  const f = fixture()
  const quote = { author: B, seq: 1 }
  const other = { author: C, seq: 2 }
  const entries = [
    ...f.entries,
    { seq: 3, record: { type: 'post', text: 'olha isso', at: AT, replyTo: null, quote } },
    { seq: 4, record: { type: 'like', to: quote, on: true, at: AT } },
    { seq: 5, record: { type: 'repost', to: quote, on: true, at: AT } },
    { seq: 6, record: { type: 'repost', to: other, on: true, at: AT } },
    { seq: 7, record: { type: 'repost', to: other, on: false, at: AT } }
  ]
  const result = diaryPeek({ ...f, length: 8, entries, fetched: new Set(entries.map((e) => e.seq)) })
  t.alike(result.posts.map((p) => [p.kind, p.seq]), [['repost', 5], ['post', 3]])
  t.alike(result.posts[0].to, quote)
  t.alike(result.posts[1].quote, quote)
  t.not(result.posts[1].quote, quote, 'a copy')
  const page = buildPeekPage({ diaries: [{ key: A, name: result.name, username: result.username, posts: result.posts, exhausted: true }], limit: 35 })
  t.alike(page.items.map((i) => [i.kind, i.seq, i.round]), [['repost', 5, 0], ['post', 3, 1]])
  t.alike(Object.keys(page.items[0]), ['kind', 'author', 'name', 'avatar', 'username', 'seq', 'at', 'to', 'text', 'replyTo', 'quote', 'media', 'round'])
  t.alike(page.items[0].to, quote)
  t.is(page.items[0].text, null)
  t.alike(page.items[1].quote, quote)
  // A repost whose undo lies below the scanned tail is never used: here only
  // seq 7 (the undo) is in the tail, so nothing about `other` shows.
  const tailOnly = diaryPeek({ ...f, length: 8, entries, fetched: new Set([0, 1, 2, 7]) })
  t.alike(tailOnly.posts, [])
})

test('a repost in the tail shows beside head blocks that were fetched but sit below the floor', (t) => {
  const f = fixture()
  const target = { author: B, seq: 4 }
  // 20 blocks, head 0..2 and tail 12..19 fetched: 3..11 is the unread gap.
  const entries = [
    f.entries[0],
    { seq: 1, record: post('head post') },
    { seq: 2, record: profile() },
    { seq: 13, record: post('tail post') },
    { seq: 16, record: { type: 'repost', to: target, on: true, at: AT } },
    { seq: 19, record: post('newest') }
  ]
  const fetched = new Set([0, 1, 2, 12, 13, 14, 15, 16, 17, 18, 19])
  const result = diaryPeek({ ...f, length: 20, entries, fetched })
  t.is(result.reason, null)
  t.absent(result.scanned, 'the gap was not read')
  t.alike(result.posts.map((p) => [p.kind, p.seq]), [['post', 19], ['repost', 16], ['post', 13]], 'the head post (seq 1) is below the floor')
  t.alike(result.posts[1].to, target)
  t.alike(diaryPeek({ ...f, length: 20, entries: retainRecords(entries), fetched }), result)
})

test('a repost whose undo sits in the tail is dropped even when the repost is below the floor', (t) => {
  const f = fixture()
  const to = { author: B, seq: 4 }
  const entries = [
    ...f.entries,
    { seq: 3, record: { type: 'repost', to, on: true, at: AT } },
    { seq: 19, record: { type: 'repost', to, on: false, at: AT } }
  ]
  const fetched = new Set([0, 1, 2, 12, 13, 14, 15, 16, 17, 18, 19])
  const result = diaryPeek({ ...f, length: 20, entries, fetched })
  t.alike(result.posts, [], 'neither the old repost nor its undo shows')
  t.is(result.future, 0)
  // Without the undo the same on:true below the floor is still never used.
  t.alike(diaryPeek({ ...f, length: 20, entries: entries.slice(0, -1), fetched }).posts, [])
})

test('a repost dated beyond MAX_FUTURE_MS counts as future and shows no item', (t) => {
  const f = fixture()
  const to = { author: B, seq: 4 }
  const late = new Date(NOW + MAX_FUTURE_MS + 1).toISOString()
  const edge = new Date(NOW + MAX_FUTURE_MS).toISOString()
  const entries = [
    ...f.entries,
    { seq: 3, record: { type: 'repost', to, on: true, at: late } },
    { seq: 4, record: { type: 'repost', to: { author: C, seq: 1 }, on: true, at: edge } }
  ]
  const result = diaryPeek({ ...f, length: 5, entries, fetched: new Set([0, 1, 2, 3, 4]) })
  t.is(result.future, 1)
  t.alike(result.posts.map((p) => [p.kind, p.seq, p.at]), [['repost', 4, edge]], 'the boundary is still allowed')
})

test('two reposters of one original give two items with distinct keys', (t) => {
  const f = fixture()
  const to = { author: C, seq: 7 }
  const entries = [...f.entries, { seq: 3, record: { type: 'repost', to, on: true, at: AT } }]
  const result = diaryPeek({ ...f, length: 4, entries, fetched: new Set([0, 1, 2, 3]) })
  t.alike(result.posts.map((p) => [p.kind, p.seq]), [['repost', 3]])
  // Same seq and same target on purpose: only the reposter tells them apart.
  const diaries = [A, B].map((key) => ({ key, name: key.slice(0, 2), username: null, posts: result.posts, exhausted: true }))
  const page = buildPeekPage({ diaries, limit: 35 })
  t.is(page.items.length, 2)
  t.alike(page.items.map((i) => i.kind), ['repost', 'repost'])
  t.alike(page.items.map((i) => i.to), [to, to])
  t.alike(page.items.map((i) => i.author), [A, B])
  t.is(new Set(page.items.map((i) => i.author + ':' + i.seq)).size, 2)
  t.alike(page.items.map((i) => i.round), [0, 0])
})

test('peek loads without the node-only network or storage stack', (t) => {
  const code = "require('./lib/peek.js'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const cached = JSON.parse(r.stdout)
  t.ok(cached.length > 0)
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})

test('avatar: diaryPeek uses the newest retained profile and page items copy its descriptor', (t) => {
  const f = fixture()
  const avatar = { ...MEDIA[0], mime: 'image/jpeg', width: 512, height: 512 }
  const newer = { ...avatar, start: 2 }
  const records = [
    ...profileRecords({ name: 'Older', avatar, at: AT }),
    ...profileRecords({ name: 'Newest', avatar: newer, at: new Date(NOW - 1000).toISOString() }),
    post(),
    { type: 'repost', to: { author: B, seq: 1 }, on: true, at: AT }
  ]
  const entries = [...f.entries, ...records.map((record, i) => ({ seq: i + 3, record }))]
  const input = { ...f, length: entries.length, entries: entries.slice().reverse(), fetched: new Set(entries.map(({ seq }) => seq)) }
  const result = diaryPeek(input)
  t.is(result.name, 'Newest', 'seq wins over profile at')
  t.alike(result.avatar, newer)
  t.not(result.avatar, records[3].avatar)
  const page = buildPeekPage({ diaries: [{ key: A, ...result, exhausted: true }], limit: 35 })
  t.alike(page.items.map(({ kind }) => kind), ['repost', 'post'])
  for (const item of page.items) {
    t.alike(item.avatar, newer)
    t.not(item.avatar, result.avatar)
  }
  t.execution(() => { page.items[0].avatar.start = 99 })
  t.is(page.items[1].avatar?.start, 2, 'items do not share descriptors')
  t.is(result.avatar?.start, 2)
  t.is(records[3].avatar.start, 2)
  entries.push({ seq: entries.length, record: profile('Removed') })
  const removed = diaryPeek({ ...input, entries, length: entries.length, fetched: new Set(entries.map(({ seq }) => seq)) })
  t.is(removed.avatar, null, 'a newer plain profile removes the avatar')
  t.ok(buildPeekPage({ diaries: [{ key: A, ...removed, exhausted: true }], limit: 35 }).items.every(({ avatar }) => avatar === null))
  t.is(diaryPeek({ ...f, entries: [f.entries[0]] }).avatar, null, 'no profile')
  t.is(diaryPeek(null).avatar, null, 'invalid input')
})

function tombstone (block, target) {
  return { seq: block, record: { type: 'delete', seq: target, at: AT } }
}

test('a deleted tail post vanishes and a deletion at either end still folds the rest', (t) => {
  const f = fixture()
  const target = { author: B, seq: 1 }
  const repost = { type: 'repost', to: target, on: true, at: AT }
  const run = (entries) => {
    const fetched = new Set(entries.map((e) => e.seq))
    const length = Math.max(...entries.map((e) => e.seq)) + 1
    return diaryPeek({ ...f, length, entries, fetched })
  }
  // Lowest seq first: the deleted post is the first record the tail reads.
  const lowFirst = [
    { seq: 3, record: post('gone') },
    ...f.entries,
    tombstone(4, 3),
    { seq: 5, record: post('keep') },
    { seq: 6, record: repost },
    { seq: 7, record: post('also') }
  ]
  const low = run(lowFirst)
  t.alike(low.posts.map((p) => [p.kind, p.seq]), [['post', 7], ['repost', 6], ['post', 5]])
  t.alike(low.posts[1].to, target)
  t.absent(low.posts.some((p) => p.seq === 3))
  // Highest seq first: the deleted post is the first entry of the tail.
  const highFirst = [
    { seq: 6, record: post('gone') },
    tombstone(7, 6),
    { seq: 5, record: repost },
    { seq: 4, record: post('keep') },
    { seq: 3, record: post('also') },
    ...[...f.entries].reverse()
  ]
  const high = run(highFirst)
  t.alike(high.posts.map((p) => [p.kind, p.seq]), [['repost', 5], ['post', 4], ['post', 3]])
  t.alike(high.posts[0].to, target)
  t.absent(high.posts.some((p) => p.seq === 6))
})

test('a deleted newest profile falls back to the previous name', (t) => {
  const f = fixture()
  const entries = [
    ...f.entries,
    { seq: 3, record: profile('Nova') },
    { seq: 4, record: post('oi') },
    tombstone(5, 3)
  ]
  const fetched = new Set(entries.map((e) => e.seq))
  const result = diaryPeek({ ...f, length: 6, entries, fetched })
  t.is(result.name, 'Ana')
  t.is(result.username, 'ana')
  t.alike(result.posts.map((p) => p.text), ['oi'])
  const none = [...entries, tombstone(6, 1)]
  const cleared = diaryPeek({ ...f, length: 7, entries: none, fetched: new Set(none.map((e) => e.seq)) })
  t.is(cleared.name, null, 'no surviving profile')
  t.is(cleared.username, 'ana', 'a username is not a profile')
  t.alike(cleared.posts.map((p) => p.seq), [4])
})

test('a tombstone is retained across pages', (t) => {
  const f = fixture()
  const entries = [
    ...f.entries,
    { seq: 3, record: post('some') },
    { seq: 4, record: post('fica') },
    tombstone(5, 3),
    { seq: 6, record: { type: 'repost', to: { author: B, seq: 1 }, on: true, at: AT } }
  ]
  const fetched = new Set(entries.map((e) => e.seq))
  const input = { ...f, length: 7, entries, fetched }
  const result = diaryPeek(input)
  t.alike(result.posts.map((p) => [p.kind, p.seq]), [['repost', 6], ['post', 4]])
  const kept = retainRecords(entries)
  t.ok(kept.some((e) => e.seq === 5 && e.record.type === 'delete'))
  t.alike(diaryPeek({ ...input, entries: kept }), result)
  // The next page only has what the previous page retained, plus a new post.
  const more = { seq: 7, record: post('nova') }
  const page2 = retainRecords([...kept, more])
  const again = diaryPeek({ ...f, length: 8, entries: page2, fetched: new Set([...fetched, 7]) })
  t.alike(again.posts.map((p) => [p.kind, p.seq]), [['post', 7], ['repost', 6], ['post', 4]])
  t.absent(again.posts.some((p) => p.seq === 3 || p.text === 'some'))
  t.alike(diaryPeek({ ...f, length: 8, entries: retainRecords(page2), fetched: new Set([...fetched, 7]) }), again)
})

test('a tombstone below the floor is never seen', (t) => {
  const f = fixture()
  // Length 20: head 0..2 and tail 12..19. Seq 5 sits in the unfetched gap.
  // A tombstone can only name an earlier block, so this one names the head.
  const gap = tombstone(5, 2)
  const entries = [
    f.entries[0],
    { seq: 1, record: profile('Old') },
    { seq: 2, record: profile('Head') },
    gap,
    { seq: 13, record: post('tail post') },
    { seq: 19, record: post('newest') }
  ]
  const fetched = new Set([0, 1, 2, 12, 13, 14, 15, 16, 17, 18, 19])
  const seen = entries.filter((e) => fetched.has(e.seq))
  const result = diaryPeek({ ...f, length: 20, entries: seen, fetched })
  t.is(result.name, 'Head', 'the gap tombstone was not fetched')
  t.alike(result.posts.map((p) => p.seq), [19, 13])
  const fetchedGap = diaryPeek({ ...f, length: 20, entries: [...seen, gap], fetched })
  t.is(fetchedGap.name, 'Old', 'the same tombstone counts once it is in the entries')
  t.alike(fetchedGap.posts.map((p) => p.seq), [19, 13])
  const hidden = diaryPeek({ ...f, length: 20, entries: [...seen, tombstone(18, 13)], fetched })
  t.alike(hidden.posts.map((p) => [p.kind, p.seq]), [['post', 19]], 'a tail tombstone hides the tail post')
  t.is(hidden.name, 'Head')
})

test('avatar: profiles outside the head and tail preserve the older retained value and block 2 name', (t) => {
  const f = fixture()
  const avatar = { ...MEDIA[0], mime: 'image/jpeg', width: 512, height: 512 }
  for (const older of [null, avatar]) {
    const head = profileRecords({ name: 'Retained', avatar: older, at: AT })
    const entries = [
      f.entries[0],
      { seq: 1, record: older === null ? post() : head[0] },
      { seq: 2, record: head[head.length - 1] },
      ...profileRecords({ name: 'Outside', avatar: { ...avatar, start: 2 }, at: AT }).map((record, i) => ({ seq: i + 3, record })),
      ...Array.from({ length: 15 }, (_, i) => ({ seq: i + 5, record: post() }))
    ]
    const fetched = new Set(peekWindow(entries.length, new Set()))
    t.absent(fetched.has(3) || fetched.has(4), 'the compat pair is outside the window')
    const result = diaryPeek({ ...f, length: entries.length, entries: entries.filter(({ seq }) => fetched.has(seq)), fetched })
    t.is(result.name, 'Retained')
    t.alike(result.avatar, older)
    const page = buildPeekPage({ diaries: [{ key: A, ...result, exhausted: true }], limit: 35 })
    t.is(page.items.length, 3)
    for (const item of page.items) {
      t.is(item.name, 'Retained')
      t.alike(item.avatar, older)
    }
  }
})
