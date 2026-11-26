'use strict'

const test = require('brittle')
const { exportHead, exportFollowsPage, exportDiaryPage, mergeHeld } = require('../lib/export')
const { EXPORT_PAGE_MAX, EXPORT_PAGE_BYTES, FOLLOW_LIMIT_MAX, utf8ByteLength, followsDigest } = require('@varanda/rpc')

const AT = '2026-01-01T00:00:00.000Z'
const ASSOC = 'cd'.repeat(32)
const K = (n) => Array.from({ length: n }, (_, i) => String(i).padStart(64, '0'))
const post = (text) => ({ type: 'post', text, at: AT, replyTo: null })

function log (n, textOf = (i) => 'post ' + i) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ seq: i, record: i === 0 ? { type: 'bogus' } : post(textOf(i)) })
  return out
}

// Follows every next verbatim, like the app does.
function walk (entries, until, opts) {
  const pages = []
  let next = { offset: 0 }
  while (next) {
    const page = exportDiaryPage(entries, next.offset, until, opts)
    pages.push(page)
    next = page.next
    if (pages.length > 5000) throw new Error('no end')
  }
  return pages
}

const seqsOf = (pages) => pages.flatMap((p) => [...p.entries, ...p.invalid].map((e) => e.seq)).sort((a, b) => a - b)

test('paging covers every seq once, ascending, for a 1200-entry log', (t) => {
  const entries = log(1200, (i) => 'x'.repeat((i * 37) % 3000))
  const pages = walk(entries, 1200)
  t.alike(seqsOf(pages), Array.from({ length: 1200 }, (_, i) => i))
  t.ok(pages.length > 1)
  for (const p of pages) {
    t.ok(p.entries.length + p.invalid.length <= EXPORT_PAGE_MAX)
    const bytes = [...p.entries, ...p.invalid].reduce((n, e) => n + utf8ByteLength(JSON.stringify(e)) + 1, 0)
    t.ok(bytes <= EXPORT_PAGE_BYTES)
  }
  t.is(pages[pages.length - 1].next, null)
  t.alike(pages[0].invalid[0], { seq: 0, reason: 'malformed' })
})

test('the block cap splits pages at EXPORT_PAGE_MAX', (t) => {
  const entries = log(1200)
  const first = exportDiaryPage(entries, 0, 1200)
  t.is(first.entries.length + first.invalid.length, EXPORT_PAGE_MAX)
  t.alike(first.next, { part: 'diary', offset: EXPORT_PAGE_MAX, until: 1200 })
})

test('the byte budget splits pages and a page never has zero blocks', (t) => {
  const entries = log(10, () => 'y'.repeat(1000))
  const pages = walk(entries, 10, { maxBytes: 2500 })
  t.ok(pages.length > 1)
  t.alike(seqsOf(pages), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const tiny = walk(entries, 10, { maxBytes: 1 })
  t.is(tiny.length, 10, 'one block per page')
  for (const p of tiny) t.is(p.entries.length + p.invalid.length, 1)
})

test('deleted and malformed blocks are invalid with a reason code only', (t) => {
  const entries = [
    { seq: 0, record: null, deleted: true },
    { seq: 1, record: null },
    { seq: 2, record: { type: 'post', text: 5 } },
    { seq: 3, record: post('ok') }
  ]
  const page = exportDiaryPage(entries, 0, 4)
  t.alike(page.entries, [{ seq: 3, record: post('ok') }])
  t.is(page.invalid.length, 3)
  t.alike(page.invalid.slice(0, 2), [{ seq: 0, reason: 'deleted' }, { seq: 1, reason: 'malformed' }])
  t.alike(Object.keys(page.invalid[2]), ['seq', 'reason'])
  t.is(typeof page.invalid[2].reason, 'string')
  t.absent(JSON.stringify(page.invalid).includes('"text"'))
  t.is(page.next, null)
})

test('until clamps, offset past the bound is empty, gaps are skipped', (t) => {
  const entries = log(20)
  const page = exportDiaryPage(entries, 5, 8)
  t.alike(seqsOf([page]), [5, 6, 7])
  t.is(page.next, null)
  const past = exportDiaryPage(entries, 20, 20)
  t.alike(past, { entries: [], invalid: [], next: null })
  const beyond = exportDiaryPage(entries, 30, 25)
  t.alike(beyond, { entries: [], invalid: [], next: null })
  const gaps = [1, 2, 5, 9].map((seq) => ({ seq, record: post('g' + seq) }))
  t.alike(seqsOf(walk(gaps, 10)), [1, 2, 5, 9])
  const split = walk(gaps, 10, { maxBlocks: 2 })
  t.alike(split.map((p) => seqsOf([p])), [[1, 2], [5, 9]])
  t.alike(split[0].next, { part: 'diary', offset: 3, until: 10 })
})

test('follows paging over 1201 keys', (t) => {
  const follows = Array.from({ length: 1201 }, (_, i) => i.toString(16).padStart(64, '0'))
  const seen = []
  let step = exportFollowsPage(follows, 0, 7)
  seen.push(...step.follows)
  t.is(step.follows.length, FOLLOW_LIMIT_MAX)
  t.alike(step.next, { part: 'follows', offset: 500, until: 7 })
  step = exportFollowsPage(follows, 500, 7)
  seen.push(...step.follows)
  t.alike(step.next, { part: 'follows', offset: 1000, until: 7 })
  step = exportFollowsPage(follows, 1000, 7)
  seen.push(...step.follows)
  t.is(step.follows.length, 201)
  t.alike(step.next, { part: 'diary', offset: 0, until: 7 })
  t.alike(seen, follows)
  t.is(exportFollowsPage(follows, 1000, 0).next, null)
  t.is(exportFollowsPage([], 0, 0).next, null)
})

test('head.next for the four (follows, length) combinations', (t) => {
  const base = { association: ASSOC, blocked: null, muted: null }
  const some = log(3)
  const a = exportHead({ ...base, length: 3, entries: some, follows: K(2) })
  t.alike(a.next, { part: 'follows', offset: 0, until: 3 })
  t.is(a.head.length, 3)
  t.is(a.head.follows, 2)
  const b = exportHead({ ...base, length: 3, entries: some, follows: K(0) })
  t.alike(b.next, { part: 'diary', offset: 0, until: 3 })
  const c = exportHead({ ...base, length: 0, entries: [], follows: K(4) })
  t.alike(c.next, { part: 'follows', offset: 0, until: 0 })
  const d = exportHead({ ...base, length: 0, entries: [], follows: K(0) })
  t.is(d.next, null)
  t.is(d.head.length, 0)
  t.alike(Object.keys(d.head), ['format', 'version', 'association', 'length', 'follows', 'followsDigest', 'profile', 'blocked', 'muted'])
  t.is(a.head.followsDigest, followsDigest(K(2)))
  t.is(followsDigest([...K(2)].reverse()), followsDigest(K(2)), 'order does not matter')
  t.not(followsDigest(K(2)), followsDigest(K(3)))
  t.is(d.head.format, 'varanda-export')
  t.is(d.head.version, 1)
})

test('head carries the newest live profile without the avatar, and the lists', (t) => {
  const key = 'ab'.repeat(32)
  const entries = [
    { seq: 0, record: { type: 'bogus' } },
    { seq: 1, record: { type: 'profile', name: 'Velho', bio: 'a', at: AT } },
    { seq: 2, record: post('x') },
    { seq: 3, record: { type: 'profile', name: 'Novo', bio: 'b', at: AT } }
  ]
  const { head } = exportHead({ association: ASSOC, length: 4, entries, follows: K(0), blocked: [key], muted: null })
  t.alike(head.profile, { name: 'Novo', bio: 'b' })
  t.alike(head.blocked, [key])
  t.is(head.muted, null)
  t.is(head.length, 4)
  t.is(exportHead({ association: ASSOC, length: 1, entries: [{ seq: 0, record: { type: 'bogus' } }], follows: K(0) }).head.profile, null)
  // the signed length, even past the blocks held here
  t.is(exportHead({ association: ASSOC, length: 9, entries: [{ seq: 4, record: post('z') }], follows: K(0) }).head.length, 9)
})

test('a delete past the snapshot bound blanks nothing inside it', (t) => {
  const entries = [
    { seq: 0, record: { type: 'bogus' } },
    { seq: 1, record: post('kept') },
    { seq: 2, record: { type: 'profile', name: 'Antes', bio: '', at: AT } },
    { seq: 3, record: { type: 'delete', seq: 1, at: AT } },
    { seq: 4, record: { type: 'delete', seq: 2, at: AT } }
  ]
  const inside = exportDiaryPage(entries, 0, 3)
  t.alike(inside.entries.map((e) => e.seq), [1, 2])
  t.alike(exportHead({ association: ASSOC, length: 3, entries, follows: K(0) }).head.profile, { name: 'Antes', bio: '' })
  const all = exportDiaryPage(entries, 0, 5)
  t.alike(all.invalid.filter((e) => e.reason === 'deleted').map((e) => e.seq), [1, 2])
  t.is(exportHead({ association: ASSOC, length: 5, entries, follows: K(0) }).head.profile, null)
  // the same delete after its target's bytes were cleared: a hole, still deleted
  const cleared = entries.map((e) => e.seq === 1 ? { seq: 1, record: null } : e)
  t.alike(exportDiaryPage(cleared, 0, 3).invalid.find((e) => e.seq === 1), { seq: 1, reason: 'deleted' })
})

test('mergeHeld keeps blocks past a hole and the prefix copy of a cleared seq', (t) => {
  const prefix = [{ seq: 0, record: { type: 'bogus' } }, { seq: 1, record: null }, { seq: 2, record: post('a') }]
  const held = [{ seq: 0, record: { type: 'bogus' } }, { seq: 2, record: post('a') }, { seq: 5, record: post('b') }]
  const merged = mergeHeld(prefix, held)
  t.alike(merged.map((e) => e.seq), [0, 1, 2, 5])
  t.is(merged[1].record, null)
  const page = exportDiaryPage([...merged, { seq: 6, record: { type: 'delete', seq: 1, at: AT } }], 0, 7)
  t.alike(page.entries.map((e) => e.seq), [2, 5, 6])
  t.alike(page.invalid.map((e) => [e.seq, e.reason]).filter(([s]) => s === 1), [[1, 'deleted']])
  t.is(page.next, null)
})
