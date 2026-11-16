'use strict'

const test = require('brittle')
const { fanRecord, topFriendsRecord, deleteRecord, postRecord } = require('../lib/records')
const { foldFans } = require('../lib/fans')
const { MAX_FOLLOW_TARGETS_PER_AUTHOR } = require('../lib/notices')

const OWNER = 'a'.repeat(64)
const key = (n) => n.toString(16).padStart(64, '0')
const T = (n) => new Date(Date.UTC(2026, 5, 1, 12, 0, n)).toISOString()
const entries = (...records) => records.map((record, i) => ({ seq: i + 1, record }))
const fan = (k, on, n = 0) => fanRecord({ key: k, on, at: T(n) })
const top = (keys, n = 0) => topFriendsRecord({ keys, at: T(n) })

test('fan: last operation per key wins, off after on', (t) => {
  const A = key(1)
  const B = key(2)
  const out = foldFans({ author: OWNER, entries: entries(fan(A, true, 1), fan(B, true, 2), fan(A, false, 3)) })
  t.alike(out.fans, [{ key: B, seq: 2, at: T(2) }])
  t.is(out.top, null)
  t.is(out.truncated, false)
  const back = foldFans({ author: OWNER, entries: entries(fan(A, true), fan(A, false), fan(A, true)) })
  t.alike(back.fans.map((f) => f.key), [A], 'on after off')
  t.is(back.fans[0].seq, 3)
})

test('fan: newest block first, entry order does not matter', (t) => {
  const list = entries(fan(key(1), true), fan(key(2), true), fan(key(3), true)).reverse()
  const out = foldFans({ author: OWNER, entries: list })
  t.alike(out.fans.map((f) => f.seq), [3, 2, 1])
})

test('fan: self is refused, in fan and in top-friends', (t) => {
  const out = foldFans({ author: OWNER, entries: entries(fan(OWNER, true), fan(key(1), true)) })
  t.alike(out.fans.map((f) => f.key), [key(1)])
  const withSelf = foldFans({ author: OWNER, entries: entries(top([key(1)]), top([key(2), OWNER])) })
  t.alike(withSelf.top.keys, [key(1)], 'a list naming the author is ignored, the earlier one stays')
  t.is(withSelf.top.seq, 1)
  t.is(foldFans({ author: OWNER, entries: entries(top([OWNER])) }).top, null)
})

test('fan: duplicates refused by the record, not folded', async (t) => {
  await t.exception.all(async () => topFriendsRecord({ keys: [key(1), key(1)] }), /malformed/)
  await t.exception.all(async () => topFriendsRecord({ keys: Array.from({ length: 9 }, (_, i) => key(i + 1)) }), /malformed/)
  const hand = { type: 'top-friends', keys: [key(1), key(1)], at: T(0) }
  t.is(foldFans({ author: OWNER, entries: entries(hand) }).top, null, 'a hand-made duplicate list is skipped')
})

test('fan: per-author cap, a new key past it is refused and flagged', (t) => {
  const A = key(1)
  const B = key(2)
  const C = key(3)
  const out = foldFans({ author: OWNER, max: 2, entries: entries(fan(A, true), fan(B, true), fan(C, true), fan(A, false), fan(B, false), fan(C, true)) })
  t.is(out.truncated, true)
  t.alike(out.fans, [], 'C never made it in, A and B flipped off')
  const flip = foldFans({ author: OWNER, max: 2, entries: entries(fan(A, true), fan(B, true), fan(A, false), fan(A, true)) })
  t.is(flip.truncated, false, 'a key already folded can flip at the cap')
  t.alike(flip.fans, [{ key: A, seq: 4, at: T(0) }, { key: B, seq: 2, at: T(0) }])
  t.is(MAX_FOLLOW_TARGETS_PER_AUTHOR, 4096)
  const big = []
  for (let i = 1; i <= MAX_FOLLOW_TARGETS_PER_AUTHOR + 1; i++) big.push(fan(key(i), true))
  const full = foldFans({ author: OWNER, entries: entries(...big) })
  t.is(full.fans.length, MAX_FOLLOW_TARGETS_PER_AUTHOR, 'default cap equals the follow cap')
  t.is(full.truncated, true)
})

test('top-friends: newest live record wins, a tombstone brings back the previous', (t) => {
  const first = foldFans({ author: OWNER, entries: entries(top([key(1)], 1), top([key(2), key(3)], 2)) })
  t.alike(first.top, { seq: 2, keys: [key(2), key(3)], at: T(2) })
  const cleared = foldFans({ author: OWNER, entries: entries(top([key(1)], 1), top([], 2)) })
  t.alike(cleared.top.keys, [], 'an empty list is a live clear')
  const undone = foldFans({ author: OWNER, entries: entries(top([key(1)], 1), top([key(2)], 2), deleteRecord({ seq: 2, at: T(3) })) })
  t.alike(undone.top.keys, [key(1)])
  const eight = Array.from({ length: 8 }, (_, i) => key(i + 1))
  t.alike(foldFans({ author: OWNER, entries: entries(top(eight)) }).top.keys, eight)
})

test('fold: deleted fan, junk entries and bad input never throw', (t) => {
  const A = key(1)
  const out = foldFans({ author: OWNER, entries: entries(fan(A, true), postRecord({ text: 'x', at: T(0) }), deleteRecord({ seq: 1, at: T(1) })) })
  t.alike(out.fans, [], 'a tombstoned fan is gone')
  const junk = [null, 5, { seq: 0, record: fan(A, true) }, { seq: 1, record: { type: 'fan', key: 'x', on: true, at: T(0) } }, { seq: 2, record: fan(A, true) }, { seq: 2, record: fan(key(2), true) }]
  t.alike(foldFans({ author: OWNER, entries: junk }).fans.map((f) => f.key), [A], 'first entry for a seq wins, invalid skipped')
  t.alike(foldFans({ author: 'x', entries: entries(fan(A, true)) }), { fans: [], top: null, truncated: false })
  t.alike(foldFans({ author: OWNER }), { fans: [], top: null, truncated: false })
  t.alike(foldFans(), { fans: [], top: null, truncated: false })
  const original = entries(fan(A, true))
  const before = JSON.stringify(original)
  foldFans({ author: OWNER, entries: original })
  t.is(JSON.stringify(original), before, 'inputs are not mutated')
})
