'use strict'

const test = require('brittle')
const { createFeiraIndex } = require('../lib/feira-index')
const fs = require('#fs')
const vm = require('vm')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const NOW = 1800000000000
const key = i => i.toString(16).padStart(64, '0')
const ref = (author, seq) => author + ':' + seq
const cursor = (atMs, author, seq) => atMs + '.' + author + '.' + seq
const data = (overrides = {}) => ({ atMs: NOW, kind: 'produto', cat: 'casa', uf: 'SP', cityKey: 'sao-paulo', tokens: ['mesa', 'azul'], ...overrides })
const query = (ix, options = {}) => ix.query({ now: NOW, ...options })
const authorPage = (ix, author, position, visible) => ix.byAuthor(author, position, visible, NOW)
const targetPage = (ix, target, position, visible) => ix.byTarget(target, position, visible, NOW)
const latest = (ix, options = {}) => ix.recent({ now: NOW, ...options })
const refs = result => result.items.map(item => item.ref)
const hit = (author, seq, overrides = {}) => ({ ref: ref(author, seq), status: 'disponivel', statusSeq: null, editSeq: null, ...overrides })

function listing (ix, author, seq, overrides) {
  const fields = data(overrides)
  ix.upsertListing(author, seq, fields)
  return ix.add(author, seq, fields)
}

function tokens (count) {
  const out = []
  for (let i = 0; i < count; i++) out.push('t' + i.toString(36).padStart(2, '0'))
  return out
}

test('ordering and cursor paging use date, author and root sequence', t => {
  const ix = createFeiraIndex()
  for (let seq = 1; seq <= 30; seq++) listing(ix, B, seq)
  listing(ix, A, 1)
  listing(ix, A, 2)
  listing(ix, C, 1, { atMs: NOW + 1 })
  const first = query(ix)
  t.alike(first.items.slice(0, 3), [hit(C, 1), hit(A, 2), hit(A, 1)])
  t.is(first.items.length, 30)
  t.is(first.next, cursor(NOW, B, 4))
  t.is(first.complete, false)
  const second = query(ix, { cursor: first.next })
  t.alike(second.items, [hit(B, 3), hit(B, 2), hit(B, 1)])
  t.is(second.next, null)
  t.is(second.complete, true)
  t.alike(query(ix, { cursor: cursor(NOW - 1, B, 1) }).items, [])
  for (const bad of ['', 1, {}, 'nope', cursor(NOW, A, 0), cursor(NOW, A, '01'), cursor('01', A, 1), cursor('9999999999999999', A, 1)]) {
    t.is(query(ix, { cursor: bad }), null)
    t.is(authorPage(ix, A, bad), null)
    t.is(targetPage(ix, A, bad), null)
  }
})

test('segments, token AND, visibility and the exact future boundary', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  listing(ix, B, 1, { kind: 'servico', tokens: ['mesa', 'verde'] })
  listing(ix, C, 1, { kind: 'procura' })
  listing(ix, A, 2, { atMs: NOW + 86400000 })
  listing(ix, A, 3, { atMs: NOW + 86400001 })
  t.alike(refs(query(ix)), [ref(A, 2), ref(A, 1), ref(B, 1)])
  t.alike(refs(query(ix, { kind: 'procura' })), [ref(C, 1)])
  t.alike(refs(query(ix, { kind: 'servico' })), [ref(B, 1)])
  t.alike(refs(query(ix, { tokens: ['mesa', 'azul'] })), [ref(A, 2), ref(A, 1)])
  t.alike(refs(query(ix, { tokens: ['mes'] })), [])
  t.alike(refs(query(ix, { tokens: ['mesa'], visible: author => author === B })), [ref(B, 1)])
  t.alike(query(ix, { visible: () => { throw new Error('hidden') } }).items, [])
  t.alike(query(ix, { visible: () => 1 }).items, [])
  t.is(query(ix, { tokens: Array(9).fill('mesa') }), null)
  t.is(query(ix, { tokens: ['MESA'] }), null)
  t.is(query(ix, { cityKey: 'sao-paulo' }), null)
  t.is(query(ix, { kind: 'invalid' }), null)
  t.is(query(ix, { now: NaN }), null)
  t.is(query(ix, { now: NOW + 1 }).items[0].ref, ref(A, 3))
})

test('STATE status and edit hints change without moving the root', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1, { atMs: NOW - 1 })
  listing(ix, B, 1)
  t.ok(ix.setStatus(A, 1, 'vendido', 5))
  t.alike(refs(query(ix)), [ref(B, 1)])
  t.alike(authorPage(ix, A).items, [hit(A, 1, { status: 'vendido', statusSeq: 5 })])
  t.ok(ix.setStatus(A, 1, 'disponivel', 7))
  t.ok(ix.setStatus(A, 1, 'reservado', 6))
  t.ok(ix.applyEdit(A, 1, 10))
  t.ok(ix.applyEdit(A, 1, 8))
  t.alike(query(ix).items, [hit(B, 1), hit(A, 1, { statusSeq: 7, editSeq: 10 })])
  t.alike(authorPage(ix, A).items, [hit(A, 1, { statusSeq: 7, editSeq: 10 })])
  t.ok(ix.markDeleted(A, 7))
  t.ok(ix.markDeleted(A, 10))
  t.alike(authorPage(ix, A).items, [hit(A, 1, { status: 'reservado', statusSeq: 6, editSeq: 8 })])
  ix.markDeleted(A, 5)
  ix.markDeleted(A, 6)
  ix.markDeleted(A, 8)
  t.alike(authorPage(ix, A).items, [hit(A, 1)])
  t.is(ix.setStatus(A, 1, 'vendido', 7), false, 'deleted status cannot return')
  t.is(ix.applyEdit(A, 1, 10), false, 'deleted edit cannot return')
  const snapshot = ix.state(A)
  snapshot.get(1).status = 'vendido'
  snapshot.clear()
  t.is(ix.state(A).get(1).status, 'disponivel', 'readers cannot mutate STATE')
  t.is(ix.applyEdit(A, 1, 1), false)
  t.is(ix.setStatus(A, 1, 'invalid', 11), false)
})

test('a status or edit tombstone recomputes only that root', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  listing(ix, A, 2)
  listing(ix, B, 1)
  ix.setStatus(A, 1, 'vendido', 10)
  ix.setStatus(A, 2, 'reservado', 11)
  ix.setStatus(B, 1, 'reservado', 4)
  ix.applyEdit(A, 1, 12)
  ix.applyEdit(A, 2, 13)
  t.ok(ix.markDeleted(A, 10))
  t.alike(authorPage(ix, A).items, [
    hit(A, 2, { status: 'reservado', statusSeq: 11, editSeq: 13 }),
    hit(A, 1, { editSeq: 12 })
  ])
  t.alike(authorPage(ix, B).items, [hit(B, 1, { status: 'reservado', statusSeq: 4 })])
  t.ok(ix.markDeleted(A, 13))
  t.alike(authorPage(ix, A).items, [
    hit(A, 2, { status: 'reservado', statusSeq: 11 }),
    hit(A, 1, { editSeq: 12 })
  ])
  t.is(ix.state(B).get(1).statusSeq, 4)
})

test('update replaces category, tokens and city while preserving date and kind', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1, { atMs: NOW - 10 })
  listing(ix, B, 1)
  t.ok(ix.update(A, 1, data({ atMs: NOW + 1, kind: 'procura', cat: 'moveis', uf: 'RJ', cityKey: 'rio-de-janeiro', tokens: ['cadeira'] })))
  t.alike(refs(query(ix)), [ref(B, 1), ref(A, 1)])
  t.alike(refs(query(ix, { uf: 'SP', cityKey: 'sao-paulo' })), [ref(B, 1)])
  t.alike(refs(query(ix, { uf: 'RJ', cityKey: 'rio-de-janeiro', cat: 'moveis', tokens: ['cadeira'] })), [ref(A, 1)])
  t.alike(refs(query(ix, { cat: 'casa', tokens: ['mesa'] })), [ref(B, 1)])
  t.is(ix.state(A).get(1).atMs, NOW - 10)
  const before = ix.stats()
  t.is(ix.update(C, 100, data()), false)
  t.is(ix.update(A, 99, data()), false)
  t.alike(ix.stats(), before)
})

test('a refused update leaves the previous search entry in place', t => {
  for (const options of [{ maxTerms: 2 }, { maxPostings: 2 }]) {
    const ix = createFeiraIndex(options)
    listing(ix, A, 1, { tokens: ['mesa'] })
    listing(ix, B, 1, { tokens: ['azul'] })
    ix.applyEdit(A, 1, 2)
    const before = ix.stats()
    t.is(ix.update(A, 1, data({ tokens: ['new', 'words'] })), false)
    t.alike(ix.stats(), before)
    t.alike(refs(query(ix, { tokens: ['mesa'] })), [ref(A, 1)])
    t.alike(refs(query(ix, { tokens: ['new'] })), [])
    t.alike(authorPage(ix, A).items, [hit(A, 1, { editSeq: 2 })])
    t.ok(ix.update(A, 1, data({ tokens: ['nova'] })))
    t.alike(refs(query(ix, { tokens: ['nova'] })), [ref(A, 1)])
    t.alike(refs(query(ix, { tokens: ['mesa'] })), [])
  }
})

test('search caps refuse atomically while STATE remains writable and pageable', t => {
  const ix = createFeiraIndex()
  for (let seq = 1; seq <= 30; seq++) t.ok(listing(ix, A, seq))
  const before = ix.stats()
  t.is(listing(ix, A, 31, { tokens: ['newterm'] }), false)
  t.is(ix.stats().entries, 30)
  t.is(ix.stats().terms, before.terms)
  t.is(ix.stats().postings, before.postings)
  t.is(ix.stats().stateLive, 31)
  t.ok(ix.setStatus(A, 31, 'vendido', 32))
  t.ok(ix.applyEdit(A, 31, 33))
  const first = authorPage(ix, A)
  t.is(first.items.length, 30)
  t.alike(first.items[0], hit(A, 31, { status: 'vendido', statusSeq: 32, editSeq: 33 }))
  t.alike(authorPage(ix, A, first.next).items, [hit(A, 1)])
  t.alike(authorPage(ix, A, null, () => false).items, [])
  for (const options of [{ maxEntries: 1 }, { maxTerms: 2 }, { maxPostings: 2 }]) {
    const limited = createFeiraIndex(options)
    listing(limited, A, 1)
    limited.upsertListing(B, 1, data())
    const counts = limited.stats()
    t.is(limited.add(B, 1, data({ tokens: ['fresh', 'term'] })), false)
    t.alike(limited.stats(), counts, 'refusal leaves no rows or terms')
    limited.remove(A, 1)
    t.ok(limited.add(B, 1, data({ tokens: ['fresh', 'term'] })), 'removal frees capacity')
  }
})

test('add and addRating require a live STATE root', t => {
  const ix = createFeiraIndex()
  t.is(ix.add(A, 1, data()), false)
  t.is(ix.addRating(A, 1, B, 1, NOW), false)
  t.is(ix.stats().entries, 0)
  t.is(ix.stats().ratings, 0)
  t.is(ix.stats().diaries, 0)
  t.ok(ix.upsertListing(A, 1, data()))
  t.ok(ix.add(A, 1, data()))
  t.ok(ix.addRating(A, 1, B, 1, NOW))
  t.is(ix.stats().entries, 1)
  t.is(ix.stats().ratings, 1)
})

test('STATE admits only 64 live roots and tombstones free slots without resurrection', t => {
  const ix = createFeiraIndex({ maxEntries: 0 })
  for (let seq = 1; seq <= 64; seq++) t.ok(ix.upsertListing(A, seq, data()))
  const before = ix.stats()
  t.is(ix.upsertListing(A, 65, data()), false)
  t.alike(ix.stats(), before)
  t.is(ix.state(A).size, 64)
  t.ok(ix.upsertListing(A, 1, data({ atMs: 0 })), 'root replay is idempotent')
  t.is(ix.state(A).get(1).atMs, NOW)
  ix.markDeleted(A, 1)
  t.ok(ix.upsertListing(A, 65, data()))
  t.is(ix.stats().stateLive, 64)
  t.is(ix.state(A).has(1), false)
  t.is(ix.upsertListing(A, 1, data()), false)
  t.is(ix.add(A, 1, data()), false)
  t.is(createFeiraIndex({ stateListingsPerDiary: 0 }).upsertListing(C, 1, data()), false)
})

test('creating and deleting 20000 roots finishes quickly and leaves no state rows', t => {
  const ix = createFeiraIndex()
  const started = Date.now()
  let failed = 0
  for (let seq = 1; seq <= 20000; seq++) {
    if (!ix.upsertListing(A, seq, data())) failed++
    if (!ix.markDeleted(A, seq)) failed++
  }
  const elapsed = Date.now() - started
  t.is(failed, 0)
  t.ok(elapsed < 2000)
  t.is(ix.stats().stateListings, 0)
  t.is(ix.stats().stateLive, 0)
  // 1024 newest tombstones are 18977..20000. The one before that can return.
  t.ok(ix.upsertListing(A, 18976, data()))
  t.is(ix.upsertListing(A, 18977, data()), false)
  t.is(ix.upsertListing(A, 20000, data()), false)
})

test('markDeleted on an unknown author or seq creates nothing', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  const before = ix.stats()
  t.is(ix.markDeleted(B, 1), false)
  t.is(ix.markDeleted(A, 99), false)
  t.alike(ix.stats(), before)
  t.ok(ix.upsertListing(B, 1, data()))
  t.ok(ix.upsertListing(A, 99, data()))
})

test('remove drops search only and a later add indexes the root again', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1, { atMs: NOW - 5 })
  listing(ix, B, 1)
  t.ok(ix.remove(A, 1))
  t.alike(refs(query(ix)), [ref(B, 1)])
  t.alike(authorPage(ix, A).items, [hit(A, 1)])
  t.is(ix.state(A).get(1).atMs, NOW - 5)
  t.is(ix.update(A, 1, data()), false)
  t.ok(ix.add(A, 1, data({ atMs: NOW - 5 })))
  t.alike(refs(query(ix)), [ref(B, 1), ref(A, 1)])
  t.ok(ix.update(A, 1, data({ cat: 'moveis', uf: 'RJ', cityKey: 'rio-de-janeiro', tokens: ['cadeira'] })))
  t.alike(refs(query(ix, { cat: 'moveis', tokens: ['cadeira'] })), [ref(A, 1)])
  t.is(ix.state(A).get(1).atMs, NOW - 5)
})

test('markDeleted and removeDiary clear both layers and ratings', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  listing(ix, B, 1)
  ix.upsertListing(C, 1, data())
  t.ok(ix.addRating(A, 1, B, 2, NOW))
  t.ok(ix.addRating(C, 1, A, 2, NOW))
  t.ok(ix.addRating(C, 1, B, 3, NOW))
  t.ok(ix.markDeleted(A, 1))
  t.alike(refs(query(ix)), [ref(B, 1)])
  t.alike(authorPage(ix, A).items, [])
  t.is(ix.state(A).has(1), false)
  t.is(ix.add(A, 1, data()), false)
  t.is(ix.upsertListing(A, 1, data()), false)
  t.ok(ix.removeDiary(A))
  t.is(ix.state(A).size, 0)
  t.is(ix.stats().ratings, 1)
  t.alike(targetPage(ix, C).items, [{ ref: ref(B, 3) }])
  t.ok(ix.removeDiary(B))
  t.ok(ix.removeDiary(C))
  t.alike(ix.stats(), { entries: 0, authors: 0, terms: 0, postings: 0, ratings: 0, targets: 0, diaries: 0, stateListings: 0, stateLive: 0 })
  t.ok(ix.removeDiary(B))
  t.ok(listing(ix, A, 1), 'a removed diary can be rebuilt')
})

test('rating admission caps deduped rows per listing author and globally', t => {
  const ix = createFeiraIndex()
  ix.upsertListing(A, 1, data())
  for (let i = 1; i <= 200; i++) t.ok(ix.addRating(A, 1, key(i), 1, NOW + i))
  t.is(ix.addRating(A, 1, B, 1, NOW), false)
  t.ok(ix.addRating(A, 1, key(1), 3, NOW - 1), 'newest rateSeq wins even with an older date and at capacity')
  t.ok(ix.addRating(A, 1, key(1), 2, NOW + 1))
  t.is(ix.stats().ratings, 200)
  t.ok(ix.removeRating(key(1), 1), 'superseded reference is gone')
  t.is(ix.stats().ratings, 200)
  t.ok(ix.removeRating(key(1), 3))
  t.is(ix.stats().ratings, 199)
  t.ok(ix.addRating(A, 1, B, 1, NOW))
  t.is(ix.stats().ratings, 200)
  const small = createFeiraIndex({ maxRatings: 1 })
  small.upsertListing(A, 1, data())
  small.upsertListing(C, 1, data())
  t.ok(small.addRating(A, 1, B, 1, NOW))
  t.ok(small.addRating(A, 1, B, 2, NOW))
  t.is(small.addRating(C, 1, B, 3, NOW), false)
  t.is(small.addRating(C, 1, B, 2, NOW), false, 'a rating reference cannot target another listing')
  t.ok(small.removeRating(B, 2))
  t.ok(small.addRating(C, 1, B, 3, NOW))
  t.is(small.addRating(A, 1, A, 4, NOW), false)
})

test('ratings dedupe across pages and keep distinct listings for the same rater', t => {
  const ix = createFeiraIndex()
  for (let i = 1; i <= 35; i++) {
    ix.upsertListing(A, i, data())
    ix.addRating(A, i, B, i, NOW)
  }
  const first = targetPage(ix, A)
  t.is(first.items.length, 30)
  t.is(first.next, cursor(NOW, B, 6))
  t.alike(refs(targetPage(ix, A, first.next)), [5, 4, 3, 2, 1].map(seq => ref(B, seq)))
  ix.addRating(A, 1, B, 36, NOW + 1)
  t.alike(refs(targetPage(ix, A, first.next)), [5, 4, 3, 2].map(seq => ref(B, seq)))
  t.is(targetPage(ix, A).items[0].ref, ref(B, 36))
  t.is(ix.stats().ratings, 35)
  t.alike(targetPage(ix, A, null, author => author !== B).items, [])
  t.alike(targetPage(ix, A, null, author => author !== A).items, [])
  t.alike(targetPage(ix, A, null, () => { throw new Error('hidden') }).items, [])
})

test('recent reads STATE, omits sold and deleted roots and clamps its bound', t => {
  const ix = createFeiraIndex({ maxEntries: 0 })
  listing(ix, A, 1)
  listing(ix, A, 2)
  listing(ix, B, 1, { atMs: NOW + 1 })
  listing(ix, C, 1, { atMs: NOW + 2, kind: 'procura' })
  ix.setStatus(B, 1, 'vendido', 2)
  ix.markDeleted(A, 2)
  t.alike(latest(ix, { limit: 2 }), [ref(C, 1), ref(A, 1)])
  t.alike(latest(ix, { limit: 1 }), [ref(C, 1)])
  t.alike(latest(ix, { limit: 0 }), [])
  t.alike(latest(ix, { limit: 5001 }), [ref(C, 1), ref(A, 1)])
  t.alike(latest(ix, { visible: author => author === A }), [ref(A, 1)])
  ix.setStatus(B, 1, 'disponivel', 3)
  t.alike(latest(ix), [ref(C, 1), ref(B, 1), ref(A, 1)])
})

test('future rows stay hidden and do not evict in-window rows', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1, { atMs: NOW - 1 })
  listing(ix, C, 1, { atMs: NOW })
  listing(ix, B, 1, { atMs: NOW + 86400001 })
  t.alike(latest(ix, { limit: 2 }), [ref(C, 1), ref(A, 1)])
  t.alike(authorPage(ix, B).items, [])
  t.alike(ix.byAuthor(B, null, undefined, NOW + 1).items, [hit(B, 1)])
  t.ok(ix.addRating(A, 1, B, 1, NOW))
  t.ok(ix.addRating(C, 1, B, 2, NOW + 86400001))
  t.alike(targetPage(ix, A).items, [{ ref: ref(B, 1) }])
  t.alike(targetPage(ix, C).items, [])
  t.alike(ix.byTarget(C, null, undefined, NOW + 1).items, [{ ref: ref(B, 2) }])
})

test('more than 32 tokens is refused before any term is stored', t => {
  const ix = createFeiraIndex()
  const many = tokens(33)
  t.ok(ix.upsertListing(A, 1, data()))
  t.is(ix.add(A, 1, data({ tokens: many })), false)
  t.is(ix.stats().entries, 0)
  t.is(ix.stats().terms, 0)
  t.ok(ix.add(A, 1, data({ tokens: many.slice(0, 32) })))
  t.is(ix.stats().terms, 32)
  t.is(ix.update(A, 1, data({ tokens: many })), false)
  t.is(ix.stats().terms, 32)
  t.is(ix.stats().entries, 1)
  t.alike(refs(query(ix, { tokens: [many[0]] })), [ref(A, 1)])
})

test('status overflow goes stale when emptied and edits fall back to the root', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  listing(ix, A, 2)
  ix.setStatus(A, 2, 'vendido', 3)
  ix.applyEdit(A, 2, 4)
  for (let seq = 10; seq <= 26; seq++) {
    t.ok(ix.setStatus(A, 1, seq % 2 ? 'vendido' : 'reservado', seq))
  }
  t.is(ix.state(A).get(1).status, 'reservado')
  t.is(ix.state(A).get(1).statusSeq, 26)
  for (let seq = 11; seq <= 26; seq++) t.ok(ix.markDeleted(A, seq))
  t.is(ix.state(A).get(1).stale, true, 'an emptied overflowed window is stale')
  t.is(ix.state(A).get(2).status, 'vendido')
  t.is(ix.state(A).get(2).statusSeq, 3)
  t.is(ix.state(A).get(2).editSeq, 4)
  for (let seq = 30; seq <= 46; seq++) t.ok(ix.applyEdit(A, 1, seq))
  t.is(ix.state(A).get(1).editSeq, 46)
  for (let seq = 31; seq <= 46; seq++) t.ok(ix.markDeleted(A, seq))
  t.is(ix.state(A).get(1).editSeq, null)
  t.is(ix.state(A).get(1).stale, true)
  t.is(ix.state(A).get(2).editSeq, 4)
  t.alike(authorPage(ix, A).items[1], hit(A, 1, { status: null }))
})

test('a stale root leaves query and recent, stays in byAuthor, and a setStatus clears it', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  ix.setStatus(A, 1, 'vendido', 2)
  for (let seq = 3; seq <= 18; seq++) ix.setStatus(A, 1, 'disponivel', seq)
  t.alike(refs(query(ix)), [ref(A, 1)])
  for (let seq = 3; seq <= 18; seq++) ix.markDeleted(A, seq)
  t.alike(query(ix).items, [])
  t.alike(latest(ix), [])
  t.alike(authorPage(ix, A).items, [hit(A, 1, { status: null })])
  t.ok(ix.setStatus(A, 1, 'reservado', 20))
  t.alike(refs(query(ix)), [ref(A, 1)])
  t.alike(latest(ix), [ref(A, 1)])
  t.alike(authorPage(ix, A).items, [hit(A, 1, { status: 'reservado', statusSeq: 20 })])
})

test('reservado on a procura root is ignored like the fold', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1, { kind: 'procura' })
  t.ok(ix.setStatus(A, 1, 'vendido', 2))
  t.is(ix.setStatus(A, 1, 'reservado', 3), false)
  t.alike(authorPage(ix, A).items, [hit(A, 1, { status: 'vendido', statusSeq: 2 })])
  t.alike(latest(ix), [])
  t.is(ix.markDeleted(A, 3), false, 'nothing was recorded for seq 3')
  t.ok(ix.upsertListing(A, 3, data()))
})

test('dropping 20000 of 30000 rows is not quadratic and keeps results identical', t => {
  const ix = createFeiraIndex({ maxEntries: 40000, perAuthorMax: 40000, maxTerms: 100000 })
  const rows = []
  for (let i = 1; i <= 30000; i++) {
    const author = key(i)
    const atMs = NOW - i
    ix.upsertListing(author, 1, data({ atMs }))
    ix.add(author, 1, data({ atMs, tokens: ['mesa'] }))
    rows.push(author)
  }
  const started = Date.now()
  for (let i = 0; i < 20000; i++) ix.remove(rows[i], 1)
  const elapsed = Date.now() - started
  // Loose on purpose: timing tests depend on load (AGENTS.md).
  t.ok(elapsed < 3000, 'removal took ' + elapsed + ' ms')
  t.is(ix.stats().entries, 10000)
  t.is(ix.stats().postings, 10000)
  const first = query(ix, { tokens: ['mesa'] })
  t.alike(first.items[0], hit(rows[20000], 1))
  t.is(first.items.length, 30)
  t.alike(refs(query(ix, { uf: 'SP', cityKey: 'sao-paulo' })), refs(first))
})

test('upsertListing refuses a seq already used as a status or edit action', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  ix.setStatus(A, 1, 'vendido', 5)
  ix.applyEdit(A, 1, 6)
  t.is(ix.upsertListing(A, 5, data()), false)
  t.is(ix.upsertListing(A, 6, data()), false)
  t.is(ix.state(A).size, 1)
})

test('add takes date and kind from the STATE root, not from data', t => {
  const ix = createFeiraIndex()
  ix.upsertListing(A, 1, data({ atMs: NOW - 5, kind: 'servico' }))
  t.ok(ix.add(A, 1, data({ atMs: NOW + 99, kind: 'produto' })))
  t.alike(authorPage(ix, A).items, [hit(A, 1)])
  t.alike(refs(query(ix, { kind: 'servico' })), [ref(A, 1)])
  t.alike(refs(query(ix, { kind: 'produto' })), [])
  t.is(query(ix, { cursor: cursor(NOW - 5, A, 1) }).items.length, 0)
})

test('scan budget resumes after filtered rows and skips future rows before scanning', t => {
  const ix = createFeiraIndex()
  for (let i = 1; i <= 2101; i++) {
    const author = key(i)
    const atMs = NOW - i
    ix.upsertListing(author, 1, data({ atMs }))
    ix.add(author, 1, data({ atMs, cat: i === 2101 ? 'moveis' : 'casa' }))
    const ahead = NOW + 86400001
    ix.upsertListing(author, 2, data({ atMs: ahead }))
    ix.add(author, 2, data({ atMs: ahead }))
  }
  let checks = 0
  const visible = () => {
    checks++
    return false
  }
  const first = query(ix, { visible })
  t.is(checks, 2000)
  t.alike(first.items, [])
  t.is(first.next, cursor(NOW - 2000, key(2000), 1))
  t.is(first.complete, false)
  const second = query(ix, { cursor: first.next, visible })
  t.is(checks, 2101)
  t.is(second.next, null)
  t.is(second.complete, true)
  const filtered = query(ix, { cat: 'moveis' })
  t.alike(filtered.items, [])
  t.is(filtered.complete, false)
  t.alike(refs(query(ix, { cat: 'moveis', cursor: filtered.next })), [ref(key(2101), 1)])
})

test('hostile inputs never throw and failed validation never partially mutates', t => {
  const ix = createFeiraIndex(new Proxy({}, { get () { throw new Error('options') } }))
  const hostile = new Proxy({}, { get () { throw new Error('record') } })
  const before = ix.stats()
  for (const bad of [null, undefined, [], hostile]) {
    t.is(ix.add(A, 1, bad), false)
    t.is(ix.upsertListing(A, 1, bad), false)
  }
  const late = data()
  Object.defineProperty(late, 'tokens', { get () { throw new Error('late') } })
  t.is(ix.add(A, 1, late), false)
  t.is(ix.add(A, 0, data()), false)
  t.is(ix.add(A, 1000000000000000, data()), false)
  t.is(ix.add(A.toUpperCase(), 1, data()), false)
  t.alike(ix.stats(), before)
  t.is(ix.applyEdit(A, 1, 2), false)
  t.is(ix.setStatus(A, 1, 'vendido', 2), false)
  t.is(ix.markDeleted(hostile, 1), false)
  t.ok(ix.upsertListing(A, 1, data()))
  const rooted = ix.stats()
  t.is(ix.add(A, 1, late), false)
  t.is(ix.add(A, 1, data({ tokens: ['valid', 'not valid'] })), false)
  t.alike(ix.stats(), rooted)
  t.is(ix.query(hostile), null)
  t.alike(ix.recent(hostile), [])
  t.is(ix.remove(hostile, 1), false)
  t.is(ix.removeDiary(hostile), false)
  t.is(ix.byAuthor(hostile), null)
  t.is(ix.byTarget(hostile), null)
  t.is(ix.addRating(A, 1, hostile, 1, NOW), false)
  t.is(ix.removeRating(hostile, 1), false)
  t.ok(ix.add(A, 1, data()))
  const valid = ix.stats()
  t.is(ix.update(A, 1, hostile), false)
  t.alike(ix.stats(), valid)
  const fields = data()
  ix.upsertListing(B, 1, fields)
  t.ok(ix.add(B, 1, fields))
  fields.tokens.push('foreign')
  fields.cat = 'moveis'
  t.alike(query(ix, { tokens: ['foreign'] }).items, [], 'caller arrays are not retained')
  t.alike(refs(query(ix, { tokens: ['mesa'], cat: 'casa' })), [ref(A, 1), ref(B, 1)])
})

test('retained structures contain only index fields and bounded action histories', t => {
  // Expose closure storage only in this isolated test copy, without a public
  // debugging API that could let callers mutate the actual index.
  const source = fs.readFileSync(require.resolve('../lib/feira-index'), 'utf8')
  let storage
  const context = { module: { exports: {} }, inspect: value => { storage = value } }
  vm.runInNewContext(source.replace('function stats () {', 'function stats () { inspect({ diaries, entries, authors, terms, places, all, ratings, targets })'), context)
  const ix = context.module.exports.createFeiraIndex()
  const forbidden = 'PRIVATE TITLE AND REVIEW MUST NOT SURVIVE'
  const fields = data({ title: forbidden, text: forbidden, price: 123456, unit: forbidden, bairro: forbidden, city: forbidden, stars: 4 })
  listing(ix, A, 1, fields)
  for (let seq = 2; seq <= 40; seq++) {
    ix.applyEdit(A, 1, seq)
    ix.setStatus(A, 1, seq % 2 ? 'vendido' : 'reservado', seq)
  }
  ix.addRating(A, 1, B, 1, NOW)
  ix.stats()
  const root = storage.diaries.get(A).roots.get(1)
  t.is(root.edits.length, 16)
  t.is(root.statuses.length, 16)
  t.is(root.editSeq, 40)
  ix.markDeleted(A, 40)
  t.is(root.editSeq, 39)
  t.is(root.statusSeq, 39)
  const seen = new Set()
  const forbiddenKeys = new Set(['title', 'text', 'price', 'unit', 'bairro', 'city', 'stars', 'review'])
  let clean = true
  function visit (value) {
    if (value === forbidden || value === fields || value === fields.tokens) clean = false
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const tag = Object.prototype.toString.call(value)
    if (tag === '[object Map]') {
      for (const [entryKey, child] of value) {
        visit(entryKey)
        visit(child)
      }
    } else if (tag === '[object Set]') {
      for (const child of value) visit(child)
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) clean = false
        visit(child)
      }
    }
  }
  visit(storage)
  t.ok(clean, 'no record object, caller array or forbidden field is retained')
})

test('deleting a listing root frees the slots of its ratings', t => {
  const ix = createFeiraIndex({ maxRatingsPerTarget: 1 })
  listing(ix, A, 1)
  listing(ix, A, 2)
  t.ok(ix.addRating(A, 1, B, 1, NOW))
  t.absent(ix.addRating(A, 2, C, 1, NOW), 'the target is full')
  t.ok(ix.markDeleted(A, 1))
  t.alike(refs(targetPage(ix, A)), [], 'the rating of the deleted root is gone')
  t.is(ix.stats().ratings, 0)
  t.ok(ix.addRating(A, 2, C, 1, NOW), 'its slot is free again')
})

test('an overflowed edit window that empties makes the root stale, not the root text', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  for (let s = 2; s <= 18; s++) t.ok(ix.applyEdit(A, 1, s))
  for (let s = 3; s <= 18; s++) ix.markDeleted(A, s)
  const row = ix.state(A).get(1)
  t.is(row.editSeq, null)
  t.ok(row.stale, 'edit 2 may still be live, so the content is unknown')
  t.ok(row.editStale)
  t.alike(ix.query({ uf: 'SP', cityKey: 'sao-paulo', kind: 'todos', cat: 'todas', now: NOW }).items, [], 'out of search')
})

test('ratingsFor copies the received ratings, oldest first', t => {
  const ix = createFeiraIndex()
  listing(ix, A, 1)
  ix.addRating(A, 1, B, 3, NOW + 1)
  ix.addRating(A, 1, C, 2, NOW)
  t.alike(ix.ratingsFor(A), [
    { target: A, targetSeq: 1, rater: C, seq: 2, atMs: NOW },
    { target: A, targetSeq: 1, rater: B, seq: 3, atMs: NOW + 1 }
  ])
  t.alike(ix.ratingsFor(B), [])
  t.alike(ix.ratingsFor('x'), [])
})
