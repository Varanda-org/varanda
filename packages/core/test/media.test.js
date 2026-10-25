'use strict'

// lib/media.js: descriptor and media-header checks, the header builder, the
// latest declared media cores of a diary, the follow set replayed from
// `follow` records, and that every helper stays total on hostile input.
const test = require('brittle')
const {
  MAX_HEADER_BYTES,
  validateDescriptor,
  validateMediaHeader,
  mediaHeader,
  latestMediaCores,
  followSet,
  hasFollowRecords,
  isOwnMediaCore
} = require('../lib/media')
const { MAX_MEDIA_CORES, isCanonicalIso } = require('../lib/records')

const DIARY = 'a'.repeat(64)
const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const K3 = '3'.repeat(64)
const K4 = '4'.repeat(64)
const K5 = '5'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const DESC = { core: K1, mime: 'image/webp', start: 1, blocks: 3, bytes: 70000, sha256: 'f'.repeat(64), width: 1080, height: 1350 }

const mc = (seq, key) => ({ seq, record: { type: 'media-core', key, at: AT } })
const fo = (seq, key, on) => ({ seq, record: { type: 'follow', key, on, at: AT } })

function hostileEntries () {
  const throwing = {}
  Object.defineProperty(throwing, 'record', { enumerable: true, get () { throw new Error('boom') } })
  Object.defineProperty(throwing, 'seq', { enumerable: true, value: 3 })
  const proxy = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  const recordGetter = { type: 'media-core', at: AT }
  Object.defineProperty(recordGetter, 'key', { enumerable: true, get () { throw new Error('boom') } })
  return [null, 1, 'x', [], {}, throwing, proxy, { seq: proxy, record: proxy }, { seq: 4, record: recordGetter }, { seq: '5', record: mc(5, K2).record }]
}

test('validateDescriptor', (t) => {
  t.is(validateDescriptor(DESC), null)
  t.is(validateDescriptor({ ...DESC, mime: 'video/mp4' }), 'media-invalid')
  t.is(validateDescriptor({ ...DESC, bytes: 2 * 32768 }), 'media-invalid')
  t.is(validateDescriptor({ ...DESC, extra: 1 }), 'media-invalid')
  for (const v of [null, undefined, 1, 'x', [], [DESC]]) t.is(validateDescriptor(v), 'media-invalid')
  const getter = { ...DESC }
  Object.defineProperty(getter, 'bytes', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateDescriptor(getter), 'media-invalid')
  t.is(validateDescriptor(new Proxy({}, { getPrototypeOf () { throw new Error('boom') } })), 'media-invalid')
})

test('validateMediaHeader and mediaHeader', async (t) => {
  t.is(MAX_HEADER_BYTES, 16384)
  const h = { type: 'media-header', v: 1, diary: DIARY, at: AT }
  t.is(validateMediaHeader(h), null)
  t.is(validateMediaHeader({ ...h, extra: 1 }), 'malformed')
  t.is(validateMediaHeader({ ...h, v: 2 }), 'malformed')
  t.is(validateMediaHeader({ ...h, type: 'media' }), 'malformed')
  t.is(validateMediaHeader({ ...h, diary: DIARY.toUpperCase() }), 'malformed')
  t.is(validateMediaHeader({ ...h, at: '2026-01-01' }), 'date-invalid')
  const noAt = { ...h }
  delete noAt.at
  t.is(validateMediaHeader(noAt), 'malformed')
  for (const v of [null, 1, 'x', [], [h]]) t.is(validateMediaHeader(v), 'malformed')
  const getter = { type: 'media-header', v: 1, at: AT }
  Object.defineProperty(getter, 'diary', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateMediaHeader(getter), 'malformed')
  t.alike(mediaHeader({ diary: DIARY, at: AT }), h)
  t.alike(Object.keys(mediaHeader({ diary: DIARY, at: AT })), ['type', 'v', 'diary', 'at'])
  t.ok(isCanonicalIso(mediaHeader({ diary: DIARY }).at))
  await t.exception.all(async () => mediaHeader({ diary: 'x', at: AT }), /malformed/)
})

test('latestMediaCores: valid records, deduplicated, newest first, at most n', (t) => {
  t.is(MAX_MEDIA_CORES, 4)
  const entries = [
    { seq: 0, record: { type: 'media-core', key: K1, at: AT } }, // block 0 never counts
    mc(1, K1),
    mc(2, K2),
    mc(3, K1), // K1 again: the newest seq is kept
    mc(4, DIARY), // the diary's own key is never a media core
    mc(5, K3),
    { seq: 6, record: { type: 'media-core', key: 'X'.repeat(64), at: AT } },
    { seq: 7, record: { type: 'media-core', key: K4, at: AT, extra: 1 } },
    { seq: 8, record: { type: 'post', text: 'oi', at: AT, replyTo: null } },
    mc(9, K4),
    mc(10, K5)
  ]
  t.alike(latestMediaCores(entries, DIARY), [{ key: K5, seq: 10 }, { key: K4, seq: 9 }, { key: K3, seq: 5 }, { key: K1, seq: 3 }])
  t.alike(latestMediaCores(entries, DIARY, 2), [{ key: K5, seq: 10 }, { key: K4, seq: 9 }])
  t.alike(latestMediaCores(entries, DIARY, 0), [])
  t.alike(latestMediaCores(entries, DIARY, 10).map((c) => c.key), [K5, K4, K3, K1, K2])
  // Input order does not matter.
  t.alike(latestMediaCores(entries.slice().reverse(), DIARY), latestMediaCores(entries, DIARY))
  t.alike(latestMediaCores([], DIARY), [])
  for (const n of [-1, 1.5, '2', null]) t.alike(latestMediaCores(entries, DIARY, n), [], 'n ' + n)
})

test('followSet: last op per key wins, own key ignored, sorted', (t) => {
  const own = DIARY
  const entries = [
    fo(5, K1, false),
    fo(1, K1, true), // replayed in seq order: seq 5 unfollows K1
    fo(2, K3, true),
    fo(3, K2, true),
    fo(4, own, true),
    fo(6, K4, true),
    fo(7, K4, false),
    fo(8, K4, true),
    { seq: 9, record: { type: 'follow', key: K5, on: 'yes', at: AT } },
    { seq: 0, record: { type: 'follow', key: K5, on: true, at: AT } },
    mc(10, K5)
  ]
  t.alike(followSet(entries, own), [K2, K3, K4])
  t.alike(followSet([], own), [])
  t.alike(followSet([fo(1, K1, false)], own), [])
  t.ok(hasFollowRecords(entries))
  t.ok(hasFollowRecords([fo(1, K1, false)]), 'an unfollow is a follow record')
  t.absent(hasFollowRecords([mc(1, K1)]))
  t.absent(hasFollowRecords([{ seq: 1, record: { type: 'follow', key: K1, on: 1, at: AT } }]))
  t.absent(hasFollowRecords([]))
})

test('isOwnMediaCore', (t) => {
  t.ok(isOwnMediaCore(DESC, [K2, K1]))
  t.ok(isOwnMediaCore(DESC, new Set([K1])))
  t.absent(isOwnMediaCore(DESC, [K2]))
  t.absent(isOwnMediaCore(DESC, []))
  t.absent(isOwnMediaCore(DESC, null))
  t.absent(isOwnMediaCore(DESC, K1), 'a string is not a list of cores')
  t.absent(isOwnMediaCore({ ...DESC, bytes: 0 }, [K1]), 'an invalid descriptor is never own')
  t.absent(isOwnMediaCore(null, [K1]))
  const getter = { ...DESC }
  Object.defineProperty(getter, 'core', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(isOwnMediaCore(getter, [K1]))
})

test('hostile input never throws', (t) => {
  const hostile = hostileEntries()
  for (const entries of [hostile, null, undefined, 1, 'x', {}, new Proxy([], { get () { throw new Error('boom') } })]) {
    t.alike(latestMediaCores(entries, DIARY), [])
    t.alike(followSet(entries, DIARY), [])
    t.is(hasFollowRecords(entries), false)
  }
  // Valid entries among hostile ones are still read.
  t.alike(latestMediaCores(hostile.concat([mc(9, K2)]), DIARY), [{ key: K2, seq: 9 }])
  t.alike(followSet(hostile.concat([fo(9, K2, true)]), DIARY), [K2])
  t.ok(hasFollowRecords(hostile.concat([fo(9, K2, true)])))
  t.absent(isOwnMediaCore(new Proxy({}, { getPrototypeOf () { throw new Error('boom') } }), [K1]))
  t.absent(isOwnMediaCore(DESC, new Proxy([], { get () { throw new Error('boom') } })))
})
