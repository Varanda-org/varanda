'use strict'

// lib/engagement.js: like/repost records replayed in seq order (the last
// operation per type and target wins), self-engagement counted, invalid
// records ignored, and every helper total on hostile input.
const test = require('brittle')
const { engagementState, isLiked, isReposted } = require('../lib/engagement')

const OWN = 'a'.repeat(64)
const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const AT2 = '2026-01-02T00:00:00.000Z'
const R1 = K1 + ':3'
const R2 = K2 + ':1'

const lk = (seq, author, tseq, on, at = AT) => ({ seq, record: { type: 'like', to: { author, seq: tseq }, on, at } })
const rp = (seq, author, tseq, on, at = AT) => ({ seq, record: { type: 'repost', to: { author, seq: tseq }, on, at } })

test('likes toggle on, off and on again', (t) => {
  t.ok(isLiked(engagementState([lk(1, K1, 3, true)]), R1))
  t.absent(isLiked(engagementState([lk(1, K1, 3, true), lk(2, K1, 3, false)]), R1))
  const s = engagementState([lk(1, K1, 3, true), lk(2, K1, 3, false), lk(3, K1, 3, true)])
  t.ok(isLiked(s, R1))
  t.alike([...s.liked], [R1])
  t.is(s.reposted.size, 0)
  t.absent(isLiked(engagementState([lk(1, K1, 3, false)]), R1), 'off without on')
})

test('reposts toggle and keep the seq/at of the effective on record', (t) => {
  const s = engagementState([rp(1, K1, 3, true), rp(2, K1, 3, false), rp(5, K1, 3, true, AT2), rp(6, K2, 1, true)])
  t.ok(isReposted(s, R1))
  t.ok(isReposted(s, R2))
  t.alike(s.reposted.get(R1), { seq: 5, at: AT2 })
  t.alike(s.reposted.get(R2), { seq: 6, at: AT })
  t.absent(isReposted(engagementState([rp(1, K1, 3, true), rp(2, K1, 3, false)]), R1))
  // A repeated on moves to the latest record.
  t.alike(engagementState([rp(1, K1, 3, true), rp(2, K1, 3, true, AT2)]).reposted.get(R1), { seq: 2, at: AT2 })
})

test('the last op wins by seq, whatever the input order', (t) => {
  const s = engagementState([lk(4, K1, 3, false), lk(2, K1, 3, true), rp(9, K1, 3, true), rp(3, K1, 3, false)])
  t.absent(isLiked(s, R1))
  t.ok(isReposted(s, R1))
  t.alike(s.reposted.get(R1), { seq: 9, at: AT })
})

test('like and repost are independent per target', (t) => {
  const s = engagementState([lk(1, K1, 3, true), rp(2, K1, 3, true), lk(3, K2, 1, true), rp(4, K1, 3, false)])
  t.ok(isLiked(s, R1))
  t.absent(isReposted(s, R1))
  t.ok(isLiked(s, R2))
  t.absent(isLiked(s, K1 + ':4'), 'another seq of the same author')
})

test('self-engagement is counted', (t) => {
  const s = engagementState([lk(1, OWN, 2, true), rp(3, OWN, 2, true)])
  t.ok(isLiked(s, OWN + ':2'))
  t.ok(isReposted(s, OWN + ':2'))
})

test('invalid records are ignored', (t) => {
  const entries = [
    lk(0, K1, 3, true), // seq 0
    { seq: -1, record: lk(0, K1, 3, true).record },
    { seq: '2', record: lk(0, K1, 3, true).record },
    { seq: 1.5, record: lk(0, K1, 3, true).record },
    lk(3, K1, 0, true), // target seq 0
    lk(4, 'A'.repeat(64), 3, true), // uppercase author
    { seq: 5, record: { type: 'like', to: { author: K1, seq: 3, extra: 1 }, on: true, at: AT } },
    { seq: 6, record: { type: 'like', to: { author: K1, seq: 3 }, on: 1, at: AT } },
    { seq: 7, record: { type: 'like', to: { author: K1, seq: 3 }, on: true, at: AT, extra: 1 } },
    { seq: 8, record: { type: 'repost', to: { author: K1, seq: 3 }, on: true, at: 'x' } },
    { seq: 9, record: { type: 'follow', key: K1, on: true, at: AT } },
    { seq: 10, record: { type: 'post', text: 'oi', at: AT, replyTo: null, quote: { author: K1, seq: 3 } } }
  ]
  const s = engagementState(entries)
  t.is(s.liked.size, 0)
  t.is(s.reposted.size, 0)
  // An invalid off does not undo a valid on.
  t.ok(isLiked(engagementState([lk(1, K1, 3, true), { seq: 2, record: { type: 'like', to: { author: K1, seq: 3 }, on: 'no', at: AT } }]), R1))
})

test('never throws on hostile input', (t) => {
  for (const v of [undefined, null, 1, 'x', {}, new Proxy([], { get () { throw new Error('boom') } })]) {
    const s = engagementState(v)
    t.ok(s.liked instanceof Set && s.liked.size === 0)
    t.ok(s.reposted instanceof Map && s.reposted.size === 0)
  }
  const throwing = {}
  Object.defineProperty(throwing, 'record', { enumerable: true, get () { throw new Error('boom') } })
  Object.defineProperty(throwing, 'seq', { enumerable: true, value: 3 })
  const proxy = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  const toGetter = { type: 'like', on: true, at: AT }
  Object.defineProperty(toGetter, 'to', { enumerable: true, get () { throw new Error('boom') } })
  const s = engagementState([null, 1, 'x', [], {}, throwing, proxy, { seq: proxy, record: proxy }, { seq: 4, record: toGetter }, lk(5, K1, 3, true)])
  t.ok(isLiked(s, R1), 'valid entries survive hostile neighbours')
  t.is(s.liked.size, 1)
  for (const st of [null, undefined, 1, {}, { liked: [R1] }, proxy]) {
    t.absent(isLiked(st, R1))
    t.absent(isReposted(st, R1))
  }
})
