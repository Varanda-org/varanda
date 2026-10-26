'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createCert, createIssuerCert, createIssuedCert, createUsernameRecord } = require('../lib/cert')
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
  t.alike(peekCandidates({ inventory, ownKey: B.toUpperCase(), follows, blocked }), [{ key: A, length: 5 }, { key: C, length: 12 }])
  t.alike(Array.from(inventory), before)
  t.alike(Array.from(follows), ['dd'.repeat(32)])
  t.alike(Array.from(blocked), ['ee'.repeat(32)])
})

test('peekCandidates keeps one candidate per key whatever its spelling', (t) => {
  const inventory = new Map([[A.toUpperCase(), 5], [A, 9], [B, 3]])
  const none = new Set()
  t.alike(peekCandidates({ inventory, ownKey: C, follows: none, blocked: none }), [{ key: A, length: 5 }, { key: B, length: 3 }], 'the first spelling wins')
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

test('retainRecords keeps copied certificate, profiles, usernames, posts and reposts only', (t) => {
  const f = fixture()
  const entries = [...f.entries,
    { seq: 3, record: { ...post('foto'), media: MEDIA } },
    { seq: 4, record: post('reply', AT, { author: B, seq: 1 }) },
    { seq: 5, record: { type: 'follow', key: B, on: true, at: AT } },
    { seq: 6, record: { type: 'media-core', key: C, at: AT } },
    { seq: 7, record: { type: 'other' } },
    { seq: 8, record: null },
    { seq: 9, record: post('plain') },
    { seq: 10, record: { type: 'like', to: { author: B, seq: 1 }, on: true, at: AT } },
    { seq: 11, record: { type: 'repost', to: { author: B, seq: 1 }, on: true, at: AT } }
  ]
  const before = JSON.stringify(entries)
  const kept = retainRecords(entries)
  t.alike(kept.map(({ seq }) => seq), [0, 1, 2, 3, 4, 9, 11])
  t.not(kept, entries)
  t.not(kept[0].record.cert, entries[0].record.cert)
  t.not(kept[3].record.media[0], MEDIA[0])
  t.alike(kept[3].record.media, MEDIA)
  const input = { ...f, length: 12, entries, fetched: new Set(entries.map(({ seq }) => seq)) }
  t.alike(diaryPeek({ ...input, entries: kept }), diaryPeek(input))
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
  t.alike(Object.keys(page.items[0]), ['kind', 'author', 'name', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', 'round'])
  t.is(page.items[0].kind, 'post')
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
  t.alike(Object.keys(page.items[0]), ['kind', 'author', 'name', 'username', 'seq', 'at', 'to', 'text', 'replyTo', 'quote', 'media', 'round'])
  t.alike(page.items[0].to, quote)
  t.is(page.items[0].text, null)
  t.alike(page.items[1].quote, quote)
  // A repost whose undo lies below the scanned tail is never used: here only
  // seq 7 (the undo) is in the tail, so nothing about `other` shows.
  const tailOnly = diaryPeek({ ...f, length: 8, entries, fetched: new Set([0, 1, 2, 7]) })
  t.alike(tailOnly.posts, [])
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
