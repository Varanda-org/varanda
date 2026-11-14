'use strict'

const test = require('brittle')
const { foldShare, newestShare, POST_SHARES_PER_DIARY } = require('../lib/post-share')
const { postShareRecord, deleteRecord, validRecordCopy } = require('../lib/records')
const { deletedSeqs } = require('../lib/deletion')

const AT = '2026-01-01T00:00:00.000Z'

test('foldShare keeps the highest share seq per post, in any order', (t) => {
  t.is(POST_SHARES_PER_DIARY, 4096)
  const orders = [[5, 9, 7], [9, 7, 5], [7, 5, 9]]
  for (const order of orders) {
    const map = new Map()
    for (const s of order) t.ok(foldShare(map, 3, s))
    t.ok(foldShare(map, 4, 6))
    t.is(newestShare(map, 3), 9, 'order ' + order.join(','))
    t.is(newestShare(map, 4), 6)
    t.is(map.size, 2)
  }
})

test('newestShare is null for an unknown post or a bad map', (t) => {
  const map = new Map()
  t.is(newestShare(map, 3), null)
  foldShare(map, 3, 4)
  t.is(newestShare(map, 2), null)
  t.is(newestShare(null, 3), null)
  t.is(newestShare({ 3: 4 }, 3), null)
})

test('foldShare refuses a new post past the cap and still updates a known one', (t) => {
  const map = new Map()
  t.ok(foldShare(map, 1, 10, { maxPosts: 2 }))
  t.ok(foldShare(map, 2, 11, { maxPosts: 2 }))
  t.is(foldShare(map, 3, 12, { maxPosts: 2 }), false)
  t.is(map.size, 2)
  t.is(newestShare(map, 3), null, 'not inserted')
  t.ok(foldShare(map, 1, 13, { maxPosts: 2 }), 'a known post still folds at the cap')
  t.is(newestShare(map, 1), 13)
  t.is(foldShare(new Map(), 1, 2, { maxPosts: 0 }), false)

  const full = new Map()
  let folded = 0
  for (let i = 1; i <= POST_SHARES_PER_DIARY; i++) if (foldShare(full, i, i + 1)) folded++
  t.is(folded, POST_SHARES_PER_DIARY)
  t.is(foldShare(full, POST_SHARES_PER_DIARY + 1, POST_SHARES_PER_DIARY + 2), false, 'the default cap')
  t.is(full.size, POST_SHARES_PER_DIARY)
})

test('foldShare returns false on invalid input without a change', (t) => {
  const map = new Map([[3, 5]])
  for (const v of [0, -1, 1.5, '3', null, undefined, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(foldShare(map, v, 6), false, 'post ' + String(v))
    t.is(foldShare(map, 3, v), false, 'share ' + String(v))
  }
  t.is(newestShare(map, 3), 5)
  t.is(map.size, 1)
  t.is(foldShare(null, 3, 6), false)
  t.is(foldShare({}, 3, 6), false)
  for (const maxPosts of [NaN, -1, 1.5, '4096', null]) {
    t.is(foldShare(map, 4, 6, { maxPosts }), false, 'maxPosts ' + String(maxPosts))
  }
  t.is(map.size, 1)
})

function highestLive (entries) {
  const deleted = deletedSeqs(entries)
  const map = new Map()
  for (const { seq, record } of entries) {
    const copy = validRecordCopy(record, seq)
    if (copy !== null && copy.type === 'post-share') foldShare(map, copy.seq, seq)
  }
  const newest = newestShare(map, 1)
  return { newest, deleted, shown: newest !== null && !deleted.has(newest) }
}

// docs/protocol.md section 2: tombstoned shares never count, so a withdrawal
// holds on a replica that cleared (or never downloaded) the tombstoned share.
test('a withdrawal survives a replica that lacks the tombstoned share blocks', (t) => {
  const share3 = { seq: 3, record: postShareRecord({ seq: 1, at: AT }) }
  const drop3 = { seq: 4, record: deleteRecord({ seq: 3, at: AT }) }
  const share5 = { seq: 5, record: postShareRecord({ seq: 1, at: AT }) }
  const drop5 = { seq: 6, record: deleteRecord({ seq: 5, at: AT }) }
  const full = highestLive([share3, drop3, share5, drop5])
  t.ok(full.deleted.has(5), 'the delete fold accepts a tombstone on a post-share block')
  t.is(full.newest, 5)
  t.absent(full.shown, 'withdrawn')
  t.absent(highestLive([share3, drop3, drop5]).shown, 'share 5 cleared: still withdrawn')
  t.absent(highestLive([drop3, drop5]).shown, 'both shares cleared: still withdrawn')
  t.ok(highestLive([share3, drop3, share5]).shown, 'a live share is shown')
})

// A reader that keeps only the highest share fails closed when an older share
// is still live under a tombstoned newer one (a diary not written by post.share).
test('the highest-only reader fails closed under a tombstoned newer share', (t) => {
  const r = highestLive([
    { seq: 3, record: postShareRecord({ seq: 1, at: AT }) },
    { seq: 5, record: postShareRecord({ seq: 1, at: AT }) },
    { seq: 6, record: deleteRecord({ seq: 5, at: AT }) }
  ])
  t.absent(r.deleted.has(3), 'share 3 is live')
  t.is(r.newest, 5)
  t.absent(r.shown, 'not shown')
})
