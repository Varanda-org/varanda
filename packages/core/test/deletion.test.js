'use strict'

const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  deletedSeqs,
  applyDeletes,
  deletedRanges,
  tombstonedRanges,
  liveMediaRefs,
  shownMedia,
  overlaps,
  presentState,
  presentLength,
  tagHidden,
  hiddenOf,
  hiddenPostsOnly,
  tombstoneAt,
  clearDeleted,
  downloadExcept,
  downloadExceptPages,
  pageTargets,
  heldKind,
  foldTargets,
  clearRanges
} = require('../lib/deletion')
const { watchPresent, watchContiguous, watchFork } = require('../lib/net')
const { MAX_LOG_BLOCKS, validateRecord } = require('../lib/records')
const { until } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const K3 = 'c'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'

const CERT = {
  v: 1,
  member: K1,
  ageBand: '18+',
  method: 'stub',
  date: AT,
  association: K2,
  signature: 'c'.repeat(128)
}

function desc (core, start, blocks, mime = 'image/webp') {
  return { core, mime, start, blocks, bytes: blocks * 32768, sha256: 'e'.repeat(64), width: 512, height: 512 }
}

const genesis = { seq: 0, record: { type: 'member-cert', cert: CERT } }
const profile = (seq, extra = {}) => ({ seq, record: { type: 'profile', name: 'Ana', bio: '', at: AT, ...extra } })
const post = (seq, extra = {}) => ({ seq, record: { type: 'post', text: 'oi', at: AT, replyTo: null, ...extra } })
const del = (seq, target, media) => ({ seq, record: media ? { type: 'delete', seq: target, at: AT, media } : { type: 'delete', seq: target, at: AT } })
const follow = (seq) => ({ seq, record: { type: 'follow', key: K2, on: true, at: AT } })

test('deletedSeqs: a tombstone deletes its target', (t) => {
  const entries = [genesis, profile(1), post(2), post(3), del(4, 2)]
  t.alike([...deletedSeqs(entries)], [2])
  t.alike([...deletedSeqs([genesis, post(1)])], [])
})

test('deletedSeqs: generic, whatever the target is', (t) => {
  t.alike([...deletedSeqs([genesis, follow(1), del(2, 1)])], [1], 'a follow')
  t.alike([...deletedSeqs([genesis, profile(1), del(5, 3)])], [3], 'an absent target')
  const withHole = [genesis, { seq: 1, record: null }, del(2, 1)]
  t.alike([...deletedSeqs(withHole)], [1], 'a null record target')
  const sparse = [genesis]
  sparse[4] = del(4, 2)
  t.alike([...deletedSeqs(sparse)], [2], 'a sparse array')
})

test('deletedSeqs: a deleted tombstone has no effect', (t) => {
  const entries = [genesis, post(1), del(2, 1), del(3, 2)]
  t.alike([...deletedSeqs(entries)], [2], 'the post survives, the first tombstone is deleted')
  const chain = [genesis, post(1), del(2, 1), del(3, 2), del(4, 3)]
  t.alike([...deletedSeqs(chain)].sort(), [1, 3], 'deleting the undo restores the deletion')
  t.alike([...deletedSeqs([...entries].reverse())], [2], 'order of entries does not matter')
})

test('deletedSeqs: invalid tombstones are ignored', (t) => {
  const forward = { seq: 2, record: { type: 'delete', seq: 3, at: AT } }
  const self = { seq: 2, record: { type: 'delete', seq: 2, at: AT } }
  const zero = { seq: 2, record: { type: 'delete', seq: 0, at: AT } }
  const extra = { seq: 2, record: { type: 'delete', seq: 1, at: AT, author: K1 } }
  const atZero = { seq: 0, record: { type: 'delete', seq: 0, at: AT } }
  for (const bad of [forward, self, zero, extra, atZero]) {
    t.is(deletedSeqs([genesis, post(1), bad, post(3)]).size, 0, JSON.stringify(bad.record))
  }
  const noSeq = { record: { type: 'delete', seq: 1, at: AT } }
  t.is(deletedSeqs([genesis, post(1), noSeq]).size, 0, 'an entry without a seq')
  t.is(deletedSeqs([genesis, post(1), del(2, 1), del(2, 1)]).size, 1, 'a duplicated block counts once')
})

test('deletedSeqs and applyDeletes never throw', (t) => {
  const getter = { seq: 3 }
  Object.defineProperty(getter, 'record', { enumerable: true, get () { throw new Error('boom') } })
  const seqGetter = {}
  Object.defineProperty(seqGetter, 'seq', { enumerable: true, get () { throw new Error('boom') } })
  const hostileRecord = { type: 'delete', at: AT }
  Object.defineProperty(hostileRecord, 'seq', { enumerable: true, get () { throw new Error('boom') } })
  const revocable = Proxy.revocable({ type: 'delete', seq: 1, at: AT }, {})
  revocable.revoke()
  const trap = new Proxy({ type: 'delete', seq: 1, at: AT }, { getPrototypeOf () { throw new Error('boom') } })
  const entries = [genesis, post(1), getter, seqGetter, { seq: 5, record: hostileRecord },
    { seq: 6, record: revocable.proxy }, { seq: 7, record: trap }, null, 1, 'x']
  t.is(deletedSeqs(entries).size, 0)
  const out = applyDeletes(entries)
  t.is(out.length, entries.length)
  for (let i = 0; i < entries.length; i++) t.is(out[i], entries[i])
  const throwingIndex = [genesis]
  Object.defineProperty(throwingIndex, 1, { enumerable: true, get () { throw new Error('boom') } })
  t.alike(applyDeletes(throwingIndex), [genesis, undefined])
  for (const v of [null, undefined, 1, 'x', {}]) {
    t.is(deletedSeqs(v).size, 0)
    t.alike(applyDeletes(v), [])
    t.alike(deletedRanges(v, [K2]), [])
    t.alike(liveMediaRefs(v), [])
  }
  t.alike(deletedRanges([genesis, post(1), del(2, 1, [{ core: K2, start: 1, blocks: 1 }])], null), [])
})

test('applyDeletes keeps length and seq alignment', (t) => {
  const entries = [genesis, profile(1), post(2), post(3), del(4, 2), post(5)]
  const out = applyDeletes(entries)
  t.is(out.length, entries.length)
  for (let i = 0; i < out.length; i++) t.is(out[i].seq, i)
  t.alike(out[2], { seq: 2, record: null, deleted: true })
  t.is(out[3], entries[3], 'others are returned as-is')
  t.is(out[4], entries[4], 'an effective tombstone stays')
  t.not(out, entries)
  t.alike(entries[2], post(2), 'the input is not changed')

  const follows = [genesis, follow(1), del(2, 1)]
  t.alike(applyDeletes(follows)[1], { seq: 1, record: null, deleted: true }, 'a follow is deleted too')

  const undone = [genesis, post(1), del(2, 1), del(3, 2)]
  const got = applyDeletes(undone)
  t.is(got[1], undone[1], 'a deleted tombstone does not delete')
  t.alike(got[2], { seq: 2, record: null, deleted: true })

  const sliced = [post(10), del(11, 10), post(12)]
  const s = applyDeletes(sliced)
  t.alike(s.map((e) => e.seq), [10, 11, 12], 'entries need not start at block 0')
  t.is(s[0].deleted, true)
})

test('deletedRanges: only effective tombstones and declared cores', (t) => {
  const r1 = { core: K2, start: 1, blocks: 2 }
  const r2 = { core: K3, start: 4, blocks: 1 }
  const entries = [genesis, post(1, { media: [desc(K2, 1, 2), desc(K3, 4, 1)] }), del(2, 1, [r1, r2])]
  t.alike(deletedRanges(entries, [K2, K3]), [r1, r2])
  t.alike(deletedRanges(entries, new Set([K2])), [r1], 'a Set of cores')
  t.alike(deletedRanges(entries, []), [])
  t.alike(deletedRanges([...entries, del(3, 2)], [K2, K3]), [], 'a deleted tombstone frees nothing')
  t.not(deletedRanges(entries, [K2])[0], entries[2].record.media[0], 'a copy')
})

test('deletedRanges: several tombstones of one target are all effective and their ranges are unioned', (t) => {
  const ranges = Array.from({ length: 10 }, (_, i) => ({ core: K2, start: 1 + i * 2, blocks: 2 }))
  const entries = [
    genesis,
    post(1, { media: ranges.map((r) => desc(K2, r.start, r.blocks)) }),
    del(2, 1, ranges.slice(0, 4)),
    del(3, 1, ranges.slice(4, 8)),
    del(4, 1, ranges.slice(8))
  ]
  for (const e of entries.slice(2)) t.is(validateRecord(e.record, e.seq), null, 'each tombstone is valid with at most 4 ranges')
  t.alike([...deletedSeqs(entries)], [1], 'the target once')
  t.alike(deletedRanges(entries, [K2]).sort((a, b) => a.start - b.start), ranges, 'all ten ranges')
})

test('deletedRanges: never a range a surviving record overlaps', (t) => {
  const shared = { core: K2, start: 1, blocks: 2 }
  const entries = [
    genesis,
    post(1, { media: [desc(K2, 1, 2)] }),
    profile(2, { avatar: desc(K2, 2, 1) }),
    post(3, { media: [desc(K2, 5, 1)] }),
    del(4, 1, [shared, { core: K2, start: 5, blocks: 1 }])
  ]
  t.alike(deletedRanges(entries, [K2]), [], 'the avatar and post 3 still show those blocks')
  t.alike(deletedRanges([...entries, del(5, 2), del(6, 3)], [K2]), [shared, { core: K2, start: 5, blocks: 1 }], 'freed once the survivors are deleted too')
})

test('tombstonedRanges: every range an effective tombstone lists, a survivor overlapping it or not', (t) => {
  const shared = { core: K2, start: 1, blocks: 2 }
  const own = { core: K3, start: 4, blocks: 1 }
  const entries = [
    genesis,
    post(1, { media: [desc(K2, 1, 2), desc(K3, 4, 1)] }),
    profile(2, { avatar: desc(K2, 2, 1) }),
    del(3, 1, [shared, own])
  ]
  t.alike(deletedRanges(entries, [K2, K3]), [own], 'the avatar keeps the shared range off the clear')
  t.alike(tombstonedRanges(entries), [shared, own], 'but it was listed, whatever core')
  t.alike(tombstonedRanges([...entries, del(4, 3)]), [], 'an undone tombstone lists nothing')
  t.not(tombstonedRanges(entries)[0], entries[3].record.media[0], 'a copy')
  for (const v of [null, undefined, 1, 'x', {}]) t.alike(tombstonedRanges(v), [])
})

test('deletedRanges: thousands of survivors and tombstone ranges stay fast and match the naive scan', (t) => {
  const cores = []
  for (let c = 0; c < 8; c++) cores.push(c.toString(16).padStart(64, '0'))
  const POSTS = 4000
  const TOMBS = 4000
  const entries = [genesis]
  // Surviving refs sit on odd blocks, tombstone ranges on even ones, so
  // only the few ranges placed on an odd block overlap a survivor.
  for (let i = 0; i < POSTS; i++) {
    const media = []
    for (let j = 0; j < 4; j++) {
      const g = 4 * i + j
      media.push(desc(cores[g % 8], 1 + 2 * Math.floor(g / 8), 1))
    }
    entries.push(post(1 + i, { media }))
  }
  // Each tombstone targets the absent block just below it, so no post dies.
  let seq = POSTS + 1
  for (let k = 0; k < TOMBS; k++) {
    const ranges = []
    for (let j = 0; j < 4; j++) {
      const g = 4 * k + j
      const start = g % 997 === 0 ? 1 + 2 * Math.floor(g / 8) : 2 + 2 * Math.floor(g / 8)
      ranges.push({ core: cores[g % 8], start, blocks: 1 })
    }
    entries.push(del(seq + 1, seq, ranges))
    seq += 2
  }

  function naive (list, allowed) {
    const live = liveMediaRefs(list)
    const out = []
    const effective = list.filter((e) => e.record.type === 'delete')
    for (const { record } of effective) {
      for (const r of record.media) {
        if (!allowed.includes(r.core) || live.some((l) => overlaps(l, r))) continue
        out.push({ core: r.core, start: r.start, blocks: r.blocks })
      }
    }
    return out.sort((a, b) => a.core.localeCompare(b.core) || a.start - b.start)
  }

  const allowed = cores.slice(0, 6)
  // The bound is the pairwise scan on the same data, timed here in the same
  // process: a load that slows one slows the other, where a fixed number of
  // milliseconds would not. The best of three keeps a pause in one run from
  // counting.
  let got
  let elapsed = Infinity
  for (let run = 0; run < 3; run++) {
    const started = process.hrtime.bigint()
    got = deletedRanges(entries, allowed)
    elapsed = Math.min(elapsed, Number(process.hrtime.bigint() - started) / 1e6)
  }
  const sorted = [...got].sort((a, b) => a.core.localeCompare(b.core) || a.start - b.start)
  const naiveStarted = process.hrtime.bigint()
  const expected = naive(entries, allowed)
  const naiveElapsed = Number(process.hrtime.bigint() - naiveStarted) / 1e6
  t.ok(expected.length > 0 && expected.length < TOMBS * 4 * 6 / 8, 'some ranges kept, the overlapping and undeclared ones dropped')
  t.alike(sorted, expected, 'same ranges as the naive scan')
  // About a tenth of the pairwise scan when measured alone; a quadratic
  // regression would match it.
  t.ok(elapsed * 3 < naiveElapsed, `took ${elapsed} ms against ${naiveElapsed} ms for the pairwise scan`)
})

test('deletedRanges: a range overlapping a survivor at either edge is kept out', (t) => {
  const entries = [
    genesis,
    post(1, { media: [desc(K2, 10, 5)] }),
    post(2, { media: [desc(K2, 30, 2)] }),
    del(4, 3, [
      { core: K2, start: 5, blocks: 5 },
      { core: K2, start: 5, blocks: 6 },
      { core: K2, start: 14, blocks: 1 }
    ]),
    del(6, 5, [
      { core: K2, start: 15, blocks: 15 },
      { core: K2, start: 15, blocks: 16 },
      { core: K3, start: 10, blocks: 5 }
    ])
  ]
  t.alike(deletedRanges(entries, [K2, K3]), [
    { core: K2, start: 15, blocks: 15 },
    { core: K3, start: 10, blocks: 5 },
    { core: K2, start: 5, blocks: 5 }
  ], 'highest tombstone first')
})

test('deletedRanges and liveMediaRefs do not let getters change the caller set', (t) => {
  function entriesAdding (set, value) {
    const sneaky = { seq: 1 }
    Object.defineProperty(sneaky, 'record', {
      enumerable: true,
      get () {
        set.add(value)
        return { type: 'post', text: 'oi', at: AT, replyTo: null, media: [desc(K2, 1, 1)] }
      }
    })
    return [genesis, sneaky, post(2, { media: [desc(K2, 3, 1)] }), del(3, 1, [{ core: K2, start: 1, blocks: 1 }])]
  }
  const cores = new Set([K3])
  t.alike(deletedRanges(entriesAdding(cores, K2), cores), [], 'K2 was not allowed when the call started')
  const except = new Set()
  t.alike(liveMediaRefs(entriesAdding(except, 2), except), [{ core: K2, start: 3, blocks: 1 }], 'post 2 stays live')
})

test('liveMediaRefs: surviving posts and profiles only', (t) => {
  const entries = [
    genesis,
    profile(1, { avatar: desc(K2, 1, 2) }),
    post(2, { media: [desc(K2, 3, 1), desc(K2, 4, 2, 'image/png')] }),
    post(3, { media: [desc(K2, 6, 1)] }),
    del(4, 3),
    post(5),
    { seq: 6, record: { type: 'post', text: 'x', at: AT, replyTo: null, media: [{ core: K2 }] } }
  ]
  t.alike(liveMediaRefs(entries), [
    { core: K2, start: 1, blocks: 2 },
    { core: K2, start: 3, blocks: 1 },
    { core: K2, start: 4, blocks: 2 }
  ])
  t.alike(liveMediaRefs(entries, [2]), [{ core: K2, start: 1, blocks: 2 }], 'exceptSeqs as an array')
  t.alike(liveMediaRefs(entries, new Set([1, 2])), [], 'exceptSeqs as a Set')
})

const card = (image) => ({ url: 'https://example.com/a', host: 'example.com', title: 'Título', desc: '', image })

test('liveMediaRefs: a surviving post keeps its link preview thumbnail live', (t) => {
  const thumb = desc(K2, 7, 1, 'image/jpeg')
  const entries = [genesis, post(1, { preview: card(thumb) }), post(2, { preview: card(null) })]
  t.is(validateRecord(entries[1].record, 1), null, 'the fixture is a valid post')
  t.alike(liveMediaRefs(entries), [{ core: K2, start: 7, blocks: 1 }])
  t.alike(liveMediaRefs(entries, [1]), [], 'not once its post is excepted')
  t.alike(shownMedia(entries[1].record), [thumb])
  t.alike(shownMedia(entries[2].record), [], 'a card with no image shows nothing')
  t.alike(shownMedia(null), [])
})

test('liveMediaRefs: a video post keeps its poster and its video live', (t) => {
  const poster = desc(K2, 1, 1, 'image/jpeg')
  const video = { core: K2, mime: 'video/mp4', start: 2, blocks: 40, bytes: 40 * 32768, sha256: 'f'.repeat(64), width: 1080, height: 1920, ms: 30000 }
  const entries = [genesis, post(1, { text: '', media: [poster, video] }), post(2, { media: [desc(K2, 50, 1)] }), del(3, 2)]
  t.is(validateRecord(entries[1].record, 1), null, 'the fixture is a valid video post')
  t.alike(liveMediaRefs(entries), [{ core: K2, start: 1, blocks: 1 }, { core: K2, start: 2, blocks: 40 }])
  t.alike(liveMediaRefs(entries, [1]), [], 'not once its post is excepted')
  t.alike(deletedRanges([...entries, del(4, 1, [{ core: K2, start: 1, blocks: 1 }, { core: K2, start: 2, blocks: 40 }])], [K2]), [
    { core: K2, start: 1, blocks: 1 },
    { core: K2, start: 2, blocks: 40 }
  ], 'its tombstone frees both ranges')
})

test('deletedRanges: a tombstone never frees a live preview thumbnail', (t) => {
  const range = { core: K2, start: 7, blocks: 1 }
  const entries = [genesis, post(1, { preview: card(desc(K2, 7, 1, 'image/jpeg')) }), post(2, { media: [desc(K2, 7, 1)] }), del(3, 2, [range])]
  t.alike(deletedRanges(entries, [K2]), [], 'post 1 still shows the block')
  t.alike(deletedRanges([...entries, del(4, 1, [range])], [K2]), [range, range], 'freed once the preview post is deleted too')
})

const coverImage = (start, blocks = 1) => ({ ...desc(K2, start, blocks, 'image/jpeg'), width: 1200, height: 630 })
const cover = (seq, target, image) => ({ seq, record: { type: 'post-cover', seq: target, image, at: AT } })

test('shownMedia and liveMediaRefs: a live post cover keeps its range like an avatar', (t) => {
  const image = coverImage(9, 2)
  const entries = [genesis, post(1), cover(2, 1, image)]
  t.is(validateRecord(entries[2].record, 2), null, 'the fixture is a valid cover')
  t.alike(shownMedia(entries[2].record), [image])
  t.alike(liveMediaRefs(entries), [{ core: K2, start: 9, blocks: 2 }])
  t.alike(liveMediaRefs([...entries, del(3, 1)]), [{ core: K2, start: 9, blocks: 2 }], 'the cover block, not the post, keeps it')
  t.alike(liveMediaRefs([...entries, del(3, 2)]), [], 'a tombstoned cover keeps nothing')
})

test('deletedRanges: a live cover protects its range, a tombstoned cover frees it', (t) => {
  const range = { core: K2, start: 9, blocks: 2 }
  const entries = [genesis, post(1, { media: [desc(K2, 9, 2)] }), cover(2, 1, coverImage(9, 2)), del(3, 1, [range])]
  t.alike(deletedRanges(entries, [K2]), [], 'the live cover still shows the blocks')
  t.alike(deletedRanges([...entries, del(4, 2, [range])], [K2]), [range, range], 'freed once the cover is tombstoned too')
  t.alike(deletedRanges([genesis, post(1), cover(2, 1, coverImage(9, 2)), del(3, 2, [range])], [K2]), [range], 'a cover tombstone carries its own range')
  t.alike(deletedRanges([genesis, post(1), cover(2, 1, coverImage(9, 2)), del(3, 2, [range])], [K3]), [], 'not in an undeclared core')
})

const thumbDesc = (start) => ({ core: K2, mime: 'image/jpeg', start, blocks: 1, bytes: 1000, sha256: 'e'.repeat(64), width: 320, height: 240 })
const thumbs = (seq, target, list) => ({ seq, record: { type: 'post-thumbs', seq: target, thumbs: list, at: AT } })

test('post-thumbs: a live one keeps its ranges, one of a deleted post keeps nothing', (t) => {
  const a = thumbDesc(20)
  const b = thumbDesc(21)
  const live = [genesis, post(1, { media: [desc(K2, 5, 2), desc(K2, 7, 1)] }), thumbs(2, 1, [a, b])]
  t.is(validateRecord(live[2].record, 2), null)
  t.alike(shownMedia(live[2].record), [a, b])
  t.alike(shownMedia(thumbs(2, 1, [a, null]).record), [a], 'null entries show nothing')
  t.alike(liveMediaRefs(live), [{ core: K2, start: 5, blocks: 2 }, { core: K2, start: 7, blocks: 1 }, { core: K2, start: 20, blocks: 1 }, { core: K2, start: 21, blocks: 1 }])
  t.alike(liveMediaRefs([...live, del(3, 1)]), [], 'a deleted post: its thumbnails keep nothing')
  t.alike(liveMediaRefs([...live, del(3, 2)]), [{ core: K2, start: 5, blocks: 2 }, { core: K2, start: 7, blocks: 1 }], 'a tombstoned thumbs record keeps nothing')
})

test('post-thumbs: an old-writer tombstone listing only the full-size ranges still deletes the thumbnails', (t) => {
  const full = [{ core: K2, start: 5, blocks: 2 }]
  const entries = [genesis, post(1, { media: [desc(K2, 5, 2)] }), { seq: 2, record: { type: 'post-thumbs', seq: 1, thumbs: [thumbDesc(20)], at: AT } }, del(3, 1, full)]
  t.alike(deletedRanges(entries, [K2]), [...full, { core: K2, start: 20, blocks: 1 }])
  t.alike(tombstonedRanges(entries), [...full, { core: K2, start: 20, blocks: 1 }])
  t.alike(deletedRanges(entries, [K3]), [], 'undeclared core')
  const plain = [genesis, post(1), thumbs(2, 1, [thumbDesc(20)]), del(3, 1)]
  t.alike(deletedRanges(plain, [K2]), [{ core: K2, start: 20, blocks: 1 }], 'a tombstone with no media list too')
  t.alike(deletedRanges([genesis, post(1, { media: [desc(K2, 5, 2)] }), thumbs(2, 1, [thumbDesc(20)])], [K2]), [], 'a live post deletes nothing')
  const other = [genesis, post(1), post(2), thumbs(3, 2, [thumbDesc(20)]), del(4, 1)]
  t.alike(deletedRanges(other, [K2]), [], 'only the adjacent record of the tombstoned post')
  t.alike(deletedRanges([...entries, thumbs(4, 3, [thumbDesc(30)])], [K2]), [...full, { core: K2, start: 20, blocks: 1 }], 'a non-adjacent thumbs record is invalid and ignored')
})

test('post-thumbs: the companion binds to its target only when that is a post or no longer readable', (t) => {
  const profile = { seq: 1, record: { type: 'profile', name: 'ana', bio: '', at: AT } }
  const bound = [genesis, profile, thumbs(2, 1, [thumbDesc(20)]), del(3, 1)]
  t.alike(deletedRanges(bound, [K2]), [], 'a record that is not a post binds no thumbnails')
  t.alike(tombstonedRanges(bound), [])
  const cleared = [genesis, { seq: 1, record: null, deleted: true }, thumbs(2, 1, [thumbDesc(20)]), del(3, 1)]
  t.alike(deletedRanges(cleared, [K2]), [{ core: K2, start: 20, blocks: 1 }], 'a cleared post (the old-writer case) still binds')
})

test('overlaps: same core interval test', (t) => {
  const a = { core: K2, start: 3, blocks: 2 }
  t.ok(overlaps(a, { core: K2, start: 4, blocks: 1 }))
  t.ok(overlaps(a, { core: K2, start: 1, blocks: 3 }))
  t.ok(overlaps(a, a))
  t.absent(overlaps(a, { core: K2, start: 5, blocks: 1 }), 'adjacent after')
  t.absent(overlaps(a, { core: K2, start: 1, blocks: 2 }), 'adjacent before')
  t.absent(overlaps(a, { core: K3, start: 3, blocks: 2 }), 'another core')
  t.absent(overlaps(null, a))
  t.absent(overlaps(a, undefined))
})

// Byte deletion over local in-memory replication streams (no DHT). The
// diary: 0 cert, 1..3 posts, 4 deletes 2, 5 a post.
const GONE = 2
const DIARY = [genesis, post(1), post(2), post(3), del(4, GONE), post(5)]
const LENGTH = DIARY.length
const encode = (record) => b4a.from(JSON.stringify(record))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function openCorestore (t, dir) {
  const store = new Corestore(dir)
  let closed = false
  const close = async () => { if (!closed) { closed = true; await store.close() } }
  t.teardown(close, { force: true })
  store.closeOnce = close
  await store.ready()
  return store
}

async function writer (t, dir = tmpDir(t)) {
  const store = await openCorestore(t, dir)
  const core = store.get({ name: 'diary' })
  await core.ready()
  for (const { record } of DIARY) await core.append(encode(record))
  return { store, core, dir }
}

async function replica (t, key, dir = tmpDir(t)) {
  const store = await openCorestore(t, dir)
  const core = store.get({ key })
  await core.ready()
  return { store, core, dir }
}

// The b -> a direction (answers to a's requests) can be held and released.
function link (t, storeA, storeB) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  let held = null
  a.rawStream.on('data', (d) => b.rawStream.write(d))
  b.rawStream.on('data', (d) => {
    if (held !== null) held.push(d)
    else a.rawStream.write(d)
  })
  storeA.replicate(a)
  storeB.replicate(b)
  const destroy = () => {
    a.destroy()
    b.destroy()
  }
  t.teardown(destroy, { force: true })
  return {
    destroy,
    hold: () => { held = [] },
    release: () => {
      const q = held
      held = null
      for (const d of q) a.rawStream.write(d)
    }
  }
}

async function fullCopy (t, source) {
  const r = await replica(t, source.core.key)
  const l = link(t, r.store, source.store)
  await r.core.download({ start: 0, end: LENGTH }).done()
  l.destroy()
  return r
}

function uploads (core) {
  const seen = []
  core.on('upload', (index) => seen.push(index))
  return seen
}

async function holds (core, seqs) {
  for (const seq of seqs) if (!(await core.has(seq))) return false
  return true
}

const others = [0, 1, 3, 4, 5]

test('presentState: a cleared deleted block keeps the present length while contiguousLength drops', async (t) => {
  const w = await writer(t)
  t.alike(await clearDeleted(w.core, deletedSeqs(DIARY)), [GONE])
  t.is(w.core.contiguousLength, GONE, 'contiguousLength is pulled back by the clear')

  const state = await presentState(w.core)
  t.is(state.present, LENGTH)
  t.alike([...state.deleted], [GONE])
  t.is(state.entries.length, LENGTH)
  t.alike(state.entries[GONE], { seq: GONE, record: null, deleted: true })
  t.alike(state.entries[3], post(3))
  t.alike(state.raw[GONE], { seq: GONE, record: null })
  t.is(await presentLength(w.core, state.deleted), LENGTH)
  t.is(await presentLength(w.core, new Set()), LENGTH, 'a hole a local tombstone targets is passed whatever set the caller holds')
  t.is(await presentLength(w.core, state.deleted, 4), LENGTH, 'from a cached length')

  await w.core.append(encode(post(6).record))
  t.is((await presentState(w.core)).present, LENGTH + 1, 'an append after the clear extends it')
  t.is(w.core.contiguousLength, GONE)
})

test('presentState: the present length and the hole survive a reopen', async (t) => {
  const w = await writer(t)
  await clearDeleted(w.core, [GONE])
  await w.store.closeOnce()
  const store = await openCorestore(t, w.dir)
  const core = store.get({ name: 'diary' })
  await core.ready()
  t.absent(await core.has(GONE))
  const state = await presentState(core)
  t.is(state.present, LENGTH)
  t.alike([...state.deleted], [GONE])
})

test('presentState: an unknown hole stops the present length, a tombstone above it is still read', async (t) => {
  const w = await writer(t)
  const r = await replica(t, w.core.key)
  const l = link(t, r.store, w.store)
  await Promise.all([
    r.core.download({ start: 0, end: 1 }).done(),
    r.core.download({ start: 3, end: LENGTH }).done()
  ])
  l.destroy()
  t.absent(await r.core.has(1))

  const state = await presentState(r.core)
  t.is(state.present, 1, 'seq 1 is unknown and nothing deleted it')
  t.alike([...state.deleted], [GONE], 'the tombstone above the hole is learned')
  t.alike(state.entries[1], { seq: 1, record: null })
  t.alike(state.entries[GONE], { seq: GONE, record: null, deleted: true })
})

test('clearDeleted never clears block 0, a tombstone or a block past the length', async (t) => {
  const w = await writer(t)
  t.ok(await tombstoneAt(w.core, 4))
  t.absent(await tombstoneAt(w.core, 3))
  t.absent(await tombstoneAt(w.core, LENGTH))
  t.alike(await clearDeleted(w.core, [0, 4, 3, LENGTH + 2, -1, 'x']), [3])
  t.ok(await holds(w.core, [0, 1, 2, 4, 5]))
  t.alike(await clearDeleted(w.core, [3]), [], 'a block already gone is skipped')
})

test('downloadExcept: per-gap ranges never fetch a deleted block from a stale peer that still holds it', async (t) => {
  const w = await writer(t)
  const stale = await fullCopy(t, w)
  await w.store.closeOnce()
  const sent = uploads(stale.core)

  const r = await replica(t, stale.core.key)
  link(t, r.store, stale.store)
  const handle = downloadExcept(r.core, new Set([GONE]))
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, others), { name: 'the other blocks' })
  await pause(500)
  t.absent(await r.core.has(GONE), 'the deleted block was never fetched')
  t.absent(sent.includes(GONE), 'the stale peer never sent it')
  t.is((await presentState(r.core)).present, LENGTH)
  t.is(r.core.contiguousLength, GONE)
})

test('downloadExcept: a fresh replica learns the tombstone from a cleared peer, update clears and keeps it out', async (t) => {
  const w = await writer(t)
  const stale = await fullCopy(t, w)
  await clearDeleted(w.core, [GONE])

  const r = await replica(t, w.core.key)
  link(t, r.store, w.store)
  const handle = downloadExcept(r.core, new Set())
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, others), { name: 'the other blocks' })
  const state = await presentState(r.core)
  t.is(state.present, LENGTH, 'never waits on the block nobody serves')
  t.alike(await handle.update(state.deleted), [], 'nothing local to clear')

  const sent = uploads(stale.core)
  link(t, r.store, stale.store)
  await w.core.append(encode(post(6).record))
  await until(() => r.core.has(LENGTH), { name: 'the new block' })
  await pause(500)
  t.absent(await r.core.has(GONE), 'the stale peer is never asked for it')
  t.absent(sent.includes(GONE))
})

test('downloadExcept: update clears a fetched block, and a late answer is cleared again', async (t) => {
  const w = await writer(t)
  const stale = await fullCopy(t, w)
  await w.store.closeOnce()

  const r = await replica(t, stale.core.key)
  const l = link(t, r.store, stale.store)
  const handle = downloadExcept(r.core, new Set())
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [...others, GONE]), { name: 'every block' })
  t.alike(await handle.update(deletedSeqs((await presentState(r.core)).raw)), [GONE])
  t.absent(await r.core.has(GONE))

  l.hold()
  const late = r.core.get(GONE).catch(() => null)
  await pause(200)
  l.release()
  await late
  await handle.idle()
  t.absent(await r.core.has(GONE), 'the download listener cleared the late block')
  t.is((await presentState(r.core)).present, LENGTH)
})

test('clearRanges clears media ranges clamped to the length', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const media = store.get({ name: 'media' })
  await media.ready()
  for (let i = 0; i < 6; i++) await media.append(b4a.from('m' + i))
  await clearRanges(media, [{ start: 1, blocks: 2 }, { start: 5, blocks: 9 }, { start: -1, blocks: 1 }, null, { start: 3 }])
  const has = []
  for (let i = 0; i < 6; i++) has.push(await media.has(i))
  t.alike(has, [true, false, false, true, true, false])
  t.is(media.length, 6)
})

test('a clear keeps fork 0 and a truncate still reports a fork', async (t) => {
  const w = await writer(t)
  const r = await fullCopy(t, w)
  t.alike(await clearDeleted(w.core, [GONE]), [GONE])
  t.alike(await clearDeleted(r.core, [GONE]), [GONE])
  t.is(w.core.fork, 0)
  t.is(r.core.fork, 0)
  let forks = 0
  t.teardown(watchFork(w.core, () => forks++))
  let remote = 0
  t.teardown(watchFork(r.core, () => remote++))
  link(t, r.store, w.store)

  await w.core.truncate(4)
  t.is(forks, 1, 'the writer sees its truncate')
  t.is(w.core.fork, 1)
  await w.core.append(encode(post(4).record))
  await until(() => remote > 0, { name: 'replica truncate' })
  t.pass('the replica sees the fork')
})

test('watchPresent fires on growth past a cleared hole, where watchContiguous stays silent', async (t) => {
  const w = await writer(t)
  await clearDeleted(w.core, [GONE])
  const deleted = new Set([GONE])
  const present = []
  const contiguous = []
  t.teardown(watchPresent(w.core, () => deleted, (len) => present.push(len)))
  t.teardown(watchContiguous(w.core, (len) => contiguous.push(len)))
  await pause(50)

  await w.core.append(encode(post(6).record))
  await until(() => present.length > 0, { name: 'present growth' })
  t.alike(present, [LENGTH + 1])
  t.alike(contiguous, [], 'contiguousLength never grows past the hole')
})

test('watchPresent: a downloaded tombstone above an unknown hole is reported', async (t) => {
  const w = await writer(t)
  await clearDeleted(w.core, [GONE])
  const r = await replica(t, w.core.key)
  let state = { present: 0, deleted: new Set() }
  t.teardown(watchPresent(r.core, () => state.deleted, async () => {
    state = await presentState(r.core)
  }))
  link(t, r.store, w.store)
  const handle = downloadExcept(r.core, new Set())
  t.teardown(() => handle.destroy())
  await until(() => state.present === LENGTH, { name: 'present length past the hole' })
  t.alike([...state.deleted], [GONE])
})

// A stand-in session over DIARY whose has() can be held and whose get() can
// fail, to reach the interleavings a real engine only hits by chance.
function fakeCore ({ local = DIARY.map(() => true), failGet = false } = {}) {
  const { EventEmitter } = require('node:events')
  const core = new EventEmitter()
  core.length = DIARY.length
  core.cleared = []
  core.gate = null
  core.has = async (i) => {
    if (core.gate !== null) await core.gate.promise
    return local[i] === true
  }
  core.get = async (i) => {
    if (failGet) throw new Error('storage error')
    return local[i] === true ? encode(DIARY[i].record) : null
  }
  core.clear = async (start, end) => { core.cleared.push([start, end]) }
  core.download = () => ({ destroy () {} })
  core.local = local
  core.hold = () => {
    let release
    const promise = new Promise((resolve) => { release = resolve })
    core.gate = { promise, release }
  }
  core.release = () => {
    const g = core.gate
    core.gate = null
    g.release()
  }
  return core
}

test('clearDeleted fails closed: a block whose read fails is never cleared', async (t) => {
  const core = fakeCore({ failGet: true })
  t.alike(await clearDeleted(core, [3, 4]), [])
  t.alike(core.cleared, [], 'a tombstone that cannot be read keeps its bytes')
})

test('downloadExcept: a late block whose seq an update took out of the set is not cleared', async (t) => {
  const core = fakeCore()
  const handle = downloadExcept(core, new Set([3]))
  t.teardown(() => handle.destroy())
  core.hold()
  core.emit('download', 3)
  const updated = handle.update(new Set())
  core.release()
  t.alike(await updated, [])
  await handle.idle()
  t.alike(core.cleared, [], 'seq 3 is live again and keeps its bytes')
})

test('watchPresent reports a block that arrived during its first walk', async (t) => {
  const local = DIARY.map(() => true)
  local[1] = false
  const core = fakeCore({ local })
  core.hold()
  const fired = []
  t.teardown(watchPresent(core, () => new Set(), (len) => fired.push(len)))
  local[1] = true
  core.emit('download', 1)
  core.release()
  await until(() => fired.length > 0, { timeoutMs: 2000, name: 'growth during the first walk' })
  t.alike(fired, [LENGTH])
})

test('presentState: a revived block whose bytes were cleared reads as absent and never holds the present length back', async (t) => {
  const w = await writer(t)
  t.alike(await clearDeleted(w.core, [GONE]), [GONE])
  await w.core.append(encode(del(6, 4).record))
  await w.core.append(encode(post(7).record))

  const state = await presentState(w.core)
  t.is(state.present, LENGTH + 2, 'the hole is a tombstone target, so later blocks stay readable')
  t.alike([...state.deleted], [4], 'the undone tombstone is the deleted slot')
  t.alike(state.entries[GONE], { seq: GONE, record: null }, 'the revived seq has no record')
  t.alike(state.entries[LENGTH + 1], post(7))
  t.is(await presentLength(w.core, state.deleted), LENGTH + 2, 'a caller holding the effective set walks past it too')
  t.is(await presentLength(w.core, new Set()), LENGTH + 2, 'whatever deleted set the caller holds')

  const r = await copyLocal(t, w, LENGTH + 2)
  const follower = await presentState(r.core)
  t.is(follower.present, LENGTH + 2, 'a follower that never had the bytes does not stall either')
  t.alike(follower.entries[LENGTH + 1], post(7))
})

async function copyLocal (t, source, length) {
  const r = await replica(t, source.core.key)
  const l = link(t, r.store, source.store)
  const done = []
  for (let i = 0; i < length; i++) {
    if (await source.core.has(i)) done.push(r.core.download({ start: i, end: i + 1 }).done())
  }
  await Promise.all(done)
  l.destroy()
  return r
}

test('presentLength: an unknown hole that no tombstone targets still stops the walk', async (t) => {
  const w = await writer(t)
  const r = await replica(t, w.core.key)
  const l = link(t, r.store, w.store)
  await Promise.all([
    r.core.download({ start: 0, end: 1 }).done(),
    r.core.download({ start: 3, end: LENGTH }).done()
  ])
  l.destroy()
  t.is(await presentLength(r.core, new Set()), 1)
  t.is(await presentLength(r.core, new Set(), 1), 1, 'from a cached length at the hole')
})

// A diary whose post 2 and newest post 5 were hidden (#225): the seeder
// cleared them with no tombstone, so a replica fetched from it has holes
// only the signed list explains.
function hiddenHolesCore () {
  const { EventEmitter } = require('node:events')
  const diary = [genesis, profile(1), post(2), post(3), post(4), post(5)]
  const core = new EventEmitter()
  core.length = diary.length
  core.fork = 0
  core.has = async (i) => i !== 2 && i !== 5 && i < diary.length
  core.get = async (i) => (await core.has(i)) ? encode(diary[i].record) : null
  return core
}

test('presentState and presentLength: a hole at a hidden post is passed, inside the diary and at its end (#225)', async (t) => {
  const core = hiddenHolesCore()
  t.is((await presentState(core)).present, 2, 'without the list the hole stops the walk')
  t.is(await presentLength(core, new Set()), 2)

  const hidden = new Set([2, 5])
  const state = await presentState(core, hidden)
  t.is(state.present, 6, 'both holes are passed, the newest block too')
  t.alike(state.entries[2], { seq: 2, record: null }, 'a passed hole reads as a block not held')
  t.is(state.deleted.size, 0, 'nothing reads as deleted')
  t.is(await presentLength(core, new Set(), 0, undefined, hidden), 6)
  t.is(await presentLength(core, new Set(), 3, new Set(), hidden), 6, 'from a cached length, with caller targets')
  t.is((await presentState(core, new Set([5]))).present, 2, 'a hole the list does not name still stops it')
  t.is(await presentLength(core, new Set(), 0, undefined, new Set([2])), 5, 'the newest hole is passed only when listed')
})

test('tagHidden: a session carries a lookup, so a list adopted later applies to it (#225)', async (t) => {
  const core = hiddenHolesCore()
  let seqs = new Set()
  t.is(tagHidden(core, () => seqs), core)
  t.is(hiddenOf(core), null, 'an empty list passes nothing')
  t.is((await presentState(core)).present, 2)
  seqs = new Set([2, 5])
  t.is(hiddenOf(core), seqs)
  t.is((await presentState(core)).present, 6, 'the default reads the lookup on every walk')
  t.is(await presentLength(core, new Set()), 6)
  t.is((await presentState(core, null)).present, 2, 'an explicit null passes nothing')

  tagHidden(core, () => { throw new Error('boom') })
  t.is(hiddenOf(core), null, 'a failing lookup passes nothing')
  t.is((await presentState(core)).present, 2)
  tagHidden(core, () => [2, 5])
  t.is(hiddenOf(core), null, 'only a Set counts')
  for (const v of [null, undefined, 1, 'x']) t.is(hiddenOf(v), null)
  t.is(tagHidden(null, () => seqs), null)
})

// A follower clears the posts the list hides like deleted blocks (#225),
// but a listed seq that holds anything else stays, as blocklist.js
// withoutHidden shows it.
test('clearDeleted with hiddenPostsOnly: a listed seq is cleared only as a post, a deleted one by the deletion rule (#225)', async (t) => {
  const diary = [genesis, profile(1), post(2), post(3), del(4, 3), profile(5), post(6)]
  const held = new Map(diary.map((e) => [e.seq, encode(e.record)]))
  held.set(7, b4a.from('not json'))
  const core = {
    length: 8,
    has: async (i) => held.has(i),
    get: async (i) => held.has(i) ? held.get(i) : null,
    clear: async (a, b) => { for (let i = a; i < b; i++) held.delete(i) }
  }
  const deleted = new Set([3])
  const hidden = new Set([1, 2, 3, 4, 5, 7])
  const rule = hiddenPostsOnly(() => deleted, () => hidden)
  t.alike(await clearDeleted(core, new Set([...deleted, ...hidden]), rule), [2, 3, 7], 'the listed post, the deleted post and bytes that decode as no record')
  t.ok(held.has(1) && held.has(5), 'a listed seq that holds a profile stays')
  t.ok(held.has(4), 'a tombstone stays, listed or not')
  t.ok(held.has(6), 'a post the list does not name stays')
  deleted.add(5)
  t.alike(await clearDeleted(core, [5], rule), [5], 'a listed seq the fold deletes follows the deletion rule')
  t.alike(await clearDeleted(core, [1]), [1], 'with no rule the deletion rule alone decides')
})

test('downloadExcept: every gap range is linear', async (t) => {
  const core = fakeCore()
  const opened = []
  core.download = (opts) => {
    opened.push(opts)
    return { destroy () {} }
  }
  const handle = downloadExcept(core, new Set([2, 4]))
  t.teardown(() => handle.destroy())
  await handle.update(new Set([3]))
  t.ok(opened.length >= 5)
  t.ok(opened.every((o) => o.linear === true), 'no range fetches random indexes')
})

test('downloadExcept: a seq an in-flight clear removed after leaving the set is put back in the ranges', async (t) => {
  const core = fakeCore()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  core.clear = async (start, end) => {
    await gate
    for (let i = start; i < end; i++) core.local[i] = false
    core.cleared.push([start, end])
  }
  let afterClear = false
  const opened = []
  core.download = (opts) => {
    opened.push({ ...opts, afterClear })
    return { destroy () {} }
  }
  const handle = downloadExcept(core, new Set())
  t.teardown(() => handle.destroy())
  const first = handle.update(new Set([3]))
  await pause(20)
  const second = handle.update(new Set())
  await pause(20)
  afterClear = true
  release()
  await first
  await second
  t.absent(core.local[3], 'the in-flight clear did remove it')
  const refill = opened.filter((o) => o.afterClear && o.start <= 3 && (o.end === -1 || o.end > 3))
  t.ok(refill.length > 0, 'a range opened after the clear covers the missing live seq')
})

test('downloadExcept: a handle destroyed while the refill check awaits has() opens no range', async (t) => {
  const local = DIARY.map(() => true)
  local[3] = false
  const core = fakeCore({ local })
  let destroyedAt = null
  const opened = []
  core.download = (opts) => {
    opened.push({ ...opts, afterDestroy: destroyedAt !== null })
    return { destroy () {} }
  }
  const handle = downloadExcept(core, new Set([3]))
  core.hold()
  const updating = handle.update(new Set())
  await pause(20)
  handle.destroy()
  destroyedAt = opened.length
  core.release()
  await updating
  t.alike(opened.filter((o) => o.afterDestroy), [], 'no range opened after destroy()')
})

test('watchPresent re-walks when onGrow changed the deleted set', async (t) => {
  const local = DIARY.map(() => true)
  local[3] = false
  const core = fakeCore({ local })
  const deleted = new Set()
  const fired = []
  t.teardown(watchPresent(core, () => deleted, async (len) => {
    fired.push(len)
    await pause(10)
    deleted.add(3)
  }))
  await pause(50)
  core.emit('download', 4)
  await until(() => fired.length > 1, { timeoutMs: 2000, name: 'the re-walk after onGrow' }).catch(() => {})
  t.alike(fired, [3, LENGTH])
})

test('watchPresent keeps a rerun queued during a pass that threw', async (t) => {
  const local = DIARY.map(() => true)
  local[3] = false
  const core = fakeCore({ local })
  let calls = 0
  const fired = []
  t.teardown(watchPresent(core, () => {
    calls++
    if (calls === 2) {
      local[3] = true
      core.emit('download', 3)
      throw new Error('boom')
    }
    return new Set()
  }, (len) => fired.push(len)))
  await pause(50)
  core.emit('append')
  await until(() => fired.length > 0, { timeoutMs: 2000, name: 'the queued rerun' }).catch(() => {})
  t.alike(fired, [LENGTH])
})

// A signed length far past the blocks served (an author can sign an upgrade
// to 1e9 and withhold the blocks). The call budget turns an unbounded walk
// into a fast failure instead of a hang.
function hugeCore (local, length = 1e9) {
  const core = fakeCore({ local })
  core.length = length
  const budget = 2 * MAX_LOG_BLOCKS + 10
  const has = core.has
  const get = core.get
  core.reset = () => { core.calls = { has: 0, get: 0 } }
  core.reset()
  core.has = async (i) => {
    if (++core.calls.has > budget) throw new Error('has() call budget exceeded')
    return has(i)
  }
  core.get = async (i, opts) => {
    if (++core.calls.get > budget) throw new Error('get() call budget exceeded')
    return get(i, opts)
  }
  return core
}

test('presentState and presentLength: a huge signed length with withheld blocks is walked only up to MAX_LOG_BLOCKS', async (t) => {
  const core = hugeCore(DIARY.map(() => true))
  const state = await presentState(core)
  t.ok(core.calls.has <= MAX_LOG_BLOCKS, 'has() bounded by MAX_LOG_BLOCKS')
  t.ok(core.calls.get <= LENGTH, 'get() only for local blocks')
  t.is(state.present, LENGTH, 'the first withheld block ends the present length')
  t.alike([...state.deleted], [GONE])
  t.is(state.raw.length, LENGTH, 'no entry for a withheld block past the last local one')
  t.is(state.entries.length, LENGTH)
  t.alike(state.entries[GONE], { seq: GONE, record: null, deleted: true })

  core.reset()
  t.is(await presentLength(core, state.deleted), LENGTH)
  t.ok(core.calls.has <= 2 * MAX_LOG_BLOCKS, 'presentLength has() bounded')

  const holed = DIARY.map(() => true)
  holed[GONE] = false
  const cleared = hugeCore(holed)
  t.is(await presentLength(cleared, new Set()), LENGTH, 'a targeted hole is still passed')
  t.ok(cleared.calls.has <= 2 * MAX_LOG_BLOCKS, 'the tombstone lookup above the hole is bounded')
  t.ok(cleared.calls.get <= LENGTH, 'each local block read at most once')
  cleared.reset()
  const holedState = await presentState(cleared)
  t.is(holedState.present, LENGTH)
  t.alike(holedState.raw[GONE], { seq: GONE, record: null })
})

test('presentLength: repeated passes at the download frontier do not re-walk the missing blocks above it', async (t) => {
  const L = 100000
  const core = hugeCore(DIARY.map(() => true), L)
  for (let n = 0; n < 50; n++) {
    t.is(await presentLength(core, new Set(), n % 2 === 0 ? LENGTH : 0), LENGTH)
  }
  t.ok(core.calls.has <= L + 50 * (LENGTH + 2), 'the range above the frontier is checked once, not once per pass')

  const local = DIARY.map(() => true)
  local[GONE] = false
  local[4] = false
  const arriving = hugeCore(local, L)
  t.is(await presentLength(arriving, new Set()), GONE, 'no tombstone explains the hole yet')
  t.is(await presentLength(arriving, new Set(), GONE), GONE)
  local[4] = true
  arriving.emit('download', 4)
  t.is(await presentLength(arriving, new Set(), GONE), LENGTH, 'a downloaded tombstone inside the checked range is read')
  t.ok(arriving.calls.has <= L + 20, 'still one walk of the range')

  const counted = hugeCore(local, L)
  t.is(await presentLength(counted, new Set(), 0, new Set([GONE])), LENGTH, 'caller targets pass the hole')
  t.is(await presentLength(counted, new Set(), 0, new Set()), GONE, 'caller targets replace the scan')
  t.ok(counted.calls.has <= 2 * (LENGTH + 1), 'no scan above the hole when targets are given')
})

test('presentLength: thousands of targeted holes are passed without scanning every tombstone per hole', async (t) => {
  const { EventEmitter } = require('node:events')
  const N = 40000
  const core = new EventEmitter()
  core.length = N
  core.fork = 0
  // Block 0 and every odd block are local; odd block b deletes the absent
  // block b - 1 below it, so each even hole is explained by a tombstone.
  core.has = async (i) => i === 0 || i % 2 === 1
  core.get = async (i) => {
    if (i === 0) return encode(genesis.record)
    return i % 2 === 1 && i > 1 ? encode(del(i, i - 1).record) : encode(post(i).record)
  }
  const started = Date.now()
  t.is(await presentLength(core, new Set()), N, 'every hole is a tombstone target')
  const elapsed = Date.now() - started
  t.ok(elapsed < 400, `took ${elapsed} ms`)
})

test('downloadExcept: tens of thousands of deleted seqs open a bounded number of ranges, a seq past the cap is still cleared', async (t) => {
  const { EventEmitter } = require('node:events')
  const core = new EventEmitter()
  core.length = 70000
  const local = new Set()
  const calls = { download: 0, has: 0 }
  core.has = async (i) => {
    calls.has++
    return local.has(i)
  }
  core.get = async (i) => (local.has(i) ? encode(post(i).record) : null)
  core.cleared = []
  core.clear = async (start, end) => {
    for (let i = start; i < end; i++) local.delete(i)
    core.cleared.push(start)
  }
  let linear = true
  core.download = (opts) => {
    calls.download++
    if (opts.linear !== true) linear = false
    return { destroy () {} }
  }
  const deleted = []
  for (let s = 1; s < 60000; s += 2) deleted.push(s)
  const handle = downloadExcept(core, new Set(deleted))
  t.teardown(() => handle.destroy())
  t.ok(calls.download <= 1024, `open: ${calls.download} ranges`)

  calls.download = 0
  await handle.update(new Set(deleted))
  t.ok(calls.download <= 1024, `same set: ${calls.download} ranges`)

  calls.download = 0
  calls.has = 0
  await handle.update(new Set([...deleted, 60001, 60003]))
  t.ok(calls.download <= 1024, `grown set: ${calls.download} ranges`)
  t.ok(calls.has <= 10, `only the new seqs are cleared: ${calls.has} reads`)

  calls.download = 0
  const shrunk = deleted.slice(1).concat([60001, 60003])
  await handle.update(new Set(shrunk))
  t.ok(calls.download <= 2048, `shrunk set: ${calls.download} ranges`)

  local.add(59999)
  core.emit('download', 59999)
  await handle.idle()
  t.ok(core.cleared.includes(59999), 'a deleted seq past the range cap is cleared on download')
  t.absent(local.has(59999))
  t.ok(linear, 'every range is linear')
})

// A delete of a page-* record has no effect (docs/protocol.md §12): the
// fold keeps a present target and no clear path removes its bytes.
const pageDelegation = { association: K2, issuer: K3, issuerDate: AT, issuerSignature: 'e'.repeat(128) }
const pageClose = (seq) => ({ seq, record: { type: 'page-close', page: K1, gen: 2, at: AT, nonce: 'c'.repeat(43), actor: 'd'.repeat(64), ...pageDelegation, signature: 'a'.repeat(128), countersignature: 'b'.repeat(128) } })
const pageDelegate = (seq) => ({ seq, record: { type: 'page-delegate', actor: K3, at: AT } })

test('deletedSeqs and applyDeletes: a delete of a present page-* record has no effect', (t) => {
  const entries = [genesis, post(1), pageClose(2), del(3, 2), post(4), del(5, 1), pageDelegate(6), del(7, 6)]
  t.is(validateRecord(entries[2].record, 2), null, 'the page-close is shape-valid')
  t.alike([...deletedSeqs(entries)], [1], 'only the post is deleted')
  const out = applyDeletes(entries)
  t.alike(out[2], entries[2], 'the page-close block is kept')
  t.alike(out[6], entries[6], 'the page-delegate block is kept')
  t.alike(out[1], { seq: 1, record: null, deleted: true })
  // The fold cannot know the type of a block it does not hold.
  const hole = [genesis, post(1), { seq: 2, record: null }, del(3, 2)]
  t.alike([...deletedSeqs(hole)], [2], 'an absent target is folded as before')
})

test('clearDeleted never clears a page-* block, even when a caller names it', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const core = store.get({ name: 'page-diary' })
  await core.ready()
  const blocks = [genesis, post(1), pageClose(2), del(3, 2), del(4, 1)]
  for (const { record } of blocks) await core.append(encode(record))
  t.alike(await clearDeleted(core, [1, 2]), [1], 'the post is cleared, the page-close is not')
  t.ok(await holds(core, [0, 2, 3, 4]))
  const state = await presentState(core)
  t.alike(state.entries[2], { seq: 2, record: blocks[2].record }, 'the page-close still reads back')
  t.absent(state.deleted.has(2))

  // downloadExcept clears through the same check.
  const handle = downloadExcept(core, new Set([2]))
  t.teardown(() => handle.destroy())
  await handle.update(new Set([2]))
  await handle.idle()
  t.ok(await holds(core, [2]), 'downloadExcept keeps the page-close too')
})

// Group readers ignore deletes of group-join, group-confirm and group-cut
// (docs/protocol.md, "Deletion"), so membership history stays as written.
const groupJoin = (seq) => ({ seq, record: { type: 'group-join', group: K2, writer: K3, on: true, at: AT } })
const groupConfirm = (seq) => ({ seq, record: { type: 'group-confirm', group: K2, writer: K3, seq: 4, digest: 'd'.repeat(64), at: AT } })
const groupCut = (seq) => ({ seq, record: { type: 'group-cut', group: K2, writer: K3, cut: 3, at: AT } })

test('deletedSeqs and applyDeletes: a delete of a present group-join, group-confirm or group-cut has no effect', (t) => {
  const entries = [genesis, groupJoin(1), post(2), groupConfirm(3), groupCut(4), follow(5), del(6, 1), del(7, 2), del(8, 3), del(9, 4), del(10, 5)]
  for (const seq of [1, 3, 4]) t.is(validateRecord(entries[seq].record, seq), null, entries[seq].record.type + ' is valid')
  t.alike([...deletedSeqs(entries)].sort((a, b) => a - b), [2, 5], 'only the post and the follow are deleted')
  const out = applyDeletes(entries)
  for (const seq of [1, 3, 4]) t.alike(out[seq], entries[seq], entries[seq].record.type + ' is kept')
  t.alike(out[2], { seq: 2, record: null, deleted: true })
  t.alike(out[5], { seq: 5, record: null, deleted: true })
  // A later tombstone that deletes the tombstone of a kept block changes
  // nothing for the kept block.
  const undone = [genesis, groupJoin(1), post(2), del(3, 1), del(4, 3)]
  t.alike([...deletedSeqs(undone)], [3], 'only the first tombstone is deleted')
  t.alike(applyDeletes(undone)[1], undone[1], 'the group-join is kept')
  t.alike([...deletedSeqs([genesis, { seq: 1, record: null }, del(2, 1)])], [1], 'an absent target is folded as before')
})

test('clearDeleted never clears a group-join, group-confirm or group-cut block, and presentState reads them back', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const core = store.get({ name: 'diary' })
  await core.ready()
  const blocks = [genesis, groupJoin(1), post(2), groupConfirm(3), groupCut(4), del(5, 1), del(6, 2), del(7, 3), del(8, 4)]
  for (const { record } of blocks) await core.append(encode(record))
  const state = await presentState(core)
  t.alike([...state.deleted], [2], 'only the post is deleted')
  for (const seq of [1, 3, 4]) t.alike(state.entries[seq], { seq, record: blocks[seq].record }, blocks[seq].record.type + ' reads back')
  t.alike(await clearDeleted(core, [1, 2, 3, 4]), [2], 'only the post is cleared when a caller names them all')
  t.ok(await holds(core, [1, 3, 4]))
  const after = await presentState(core)
  t.alike([...after.deleted], [2])
  t.is(after.present, core.length)
})

test('foldTargets over the heldKind of each block agrees with deletedSeqs and presentState', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const core = store.get({ name: 'diary' })
  await core.ready()
  const blocks = [genesis, groupJoin(1), post(2), groupConfirm(3), groupCut(4), post(5), del(6, 1), del(7, 2), del(8, 3), del(9, 4), del(10, 6), del(11, 5)]
  for (const { record } of blocks) await core.append(encode(record))
  // The deleted post at 5 is cleared: its tombstone counts with the target
  // absent, as for any replica that never held it.
  await core.clear(5, 6)
  const tombs = new Map()
  const kept = new Set()
  for (let seq = 1; seq < core.length; seq++) {
    const kind = await heldKind(core, seq)
    if (kind === null) continue
    if (kind.kept) kept.add(seq)
    else tombs.set(seq, kind.target)
  }
  t.alike([...kept].sort((a, b) => a - b), [1, 3, 4], 'the held group records are kept')
  const expected = [...deletedSeqs(blocks.map((b) => b.seq === 5 ? { seq: 5, record: null } : b))].sort((a, b) => a - b)
  t.alike(expected, [2, 5, 6], 'the reader fold deletes the posts and the tombstone of the kept join')
  t.alike([...foldTargets(tombs, kept)].sort((a, b) => a - b), expected, 'foldTargets agrees with deletedSeqs')
  t.alike([...(await presentState(core)).deleted].sort((a, b) => a - b), expected, 'and with presentState')
  t.alike([...foldTargets(tombs)].sort((a, b) => a - b), [2, 3, 4, 5, 6], 'without the kept set the group records would be deleted')
})

// docs/protocol.md §12: a page diary (page-roster at 2) keeps an unheld
// tombstone target in the download until it is read once, so a replica
// that learned the tombstone first still fetches a page-close it names
// (core sync followRange and the seeder's diary download use this).
const pageRoster = (seq) => ({ seq, record: { type: 'page-roster', page: K1, gen: 1, owner: 'd'.repeat(64), admins: [], prev: null, at: AT, nonce: 'r'.repeat(43), ...pageDelegation, signature: 'a'.repeat(128), countersignature: 'b'.repeat(128) } })

test('downloadExceptPages: a page diary fetches the page-close a known tombstone names, not the deleted post', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'page' })
  await source.ready()
  const PAGE = [genesis, post(1), pageRoster(2), post(3), pageClose(4), post(5), del(6, 4), del(7, 3), post(8)]
  t.is(validateRecord(PAGE[2].record, 2), null, 'fixture: the roster is shape-valid')
  for (const { record } of PAGE) await source.append(encode(record))
  const r = await replica(t, source.key)
  link(t, r.store, store)
  const handle = downloadExceptPages(r.core, new Set([4, 3]))
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [0, 1, 2, 5, 6, 7, 8]), { name: 'the other blocks' })
  await until(() => r.core.has(4), { name: 'the page-close' })
  t.ok(await r.core.has(4), 'the page-close named by the tombstone was fetched')
  await handle.update(new Set([4, 3]))
  await handle.idle()
  t.ok(await r.core.has(4), 'and kept')
  await until(async () => !(await r.core.has(3)), { name: 'the deleted post cleared' })
  t.absent(await r.core.has(3), 'the deleted post is not kept')
})

test('downloadExceptPages: a page whose roster and close were tombstoned (a leaked key) is still a page and fetches the close', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'page-tombstoned' })
  await source.ready()
  const PAGE = [genesis, post(1), pageRoster(2), post(3), pageClose(4), post(5), del(6, 2), del(7, 4), post(8)]
  for (const { record } of PAGE) await source.append(encode(record))
  const r = await replica(t, source.key)
  const fetched = new Set()
  r.core.on('download', (index) => fetched.add(index))
  link(t, r.store, store)
  const guard = pageTargets(r.core)
  const handle = downloadExceptPages(r.core, new Set([2, 4]), { guard })
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [0, 1, 3, 5, 6, 7, 8]), { name: 'the live blocks' })
  await until(() => r.core.has(4), { name: 'the page-close' })
  t.is(guard.page(), true, 'block 2 probed once settles it as a page')
  t.ok(await r.core.has(2), 'the roster is kept')
  t.ok(await r.core.has(4), 'the page-close named by the tombstone was fetched')
  await handle.update(new Set([2, 4]))
  await handle.idle()
  t.ok(await holds(r.core, [2, 4]), 'and both page-* blocks are kept')
})

test('downloadExceptPages remember: a page post read once is not fetched again from a stale peer by the next download, after a reopen', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'page-stale' })
  await source.ready()
  // The stale peer still holds the deleted post at 3.
  const PAGE = [genesis, post(1), pageRoster(2), post(3), post(4), del(5, 3), post(6)]
  for (const { record } of PAGE) await source.append(encode(record))
  const dir = tmpDir(t)
  let r = await replica(t, source.key, dir)
  let fetched = new Set()
  r.core.on('download', (index) => fetched.add(index))
  let l = link(t, r.store, store)
  let handle = downloadExceptPages(r.core, new Set([3]), { remember: true })
  await until(() => holds(r.core, [0, 1, 2, 4, 5, 6]), { name: 'the live blocks' })
  await until(() => fetched.has(3), { name: 'the deleted post read once' })
  await handle.update(new Set([3]))
  await handle.idle()
  await until(async () => !(await r.core.has(3)), { name: 'the deleted post cleared' })
  handle.destroy()
  l.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await r.store.closeOnce()

  // The next run: the same replica reopened, the stale peer connected again.
  r = await replica(t, source.key, dir)
  fetched = new Set()
  r.core.on('download', (index) => fetched.add(index))
  l = link(t, r.store, store)
  handle = downloadExceptPages(r.core, new Set([3]), { remember: true })
  t.teardown(() => handle.destroy())
  await source.append(encode(post(7)))
  await until(() => r.core.has(7), { name: 'a new block' })
  await handle.idle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.absent(fetched.has(3), 'the deleted post is not fetched again')
  t.absent(await r.core.has(3), 'nor held')
})

test('downloadExceptPages: a burst of downloads joins the refresh already queued instead of re-reading every target per block', async (t) => {
  const { EventEmitter } = require('node:events')
  const core = new EventEmitter()
  const targets = Array.from({ length: 50 }, (_, i) => 10 + i)
  let calls = 0
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const guard = {
    page: () => true,
    async excludable (deleted) {
      calls++
      await gate
      return new Set()
    }
  }
  const updates = []
  const make = () => ({ update: async (skip) => { updates.push(skip.size); return [] }, destroy () {} })
  const handle = downloadExceptPages(core, new Set(targets), { make, guard })
  t.teardown(() => handle.destroy())
  // The first refresh is still reading; every target named arrives meanwhile.
  await new Promise((resolve) => setImmediate(resolve))
  for (const seq of targets) core.emit('download', seq)
  const joined = handle.update(new Set(targets))
  release()
  await joined
  await handle.idle()
  t.is(calls, 2, 'the first refresh and one joined refresh, not one per block (' + calls + ')')
  t.is(updates.length, 1, 'the joined refresh updates the ranges once')
})

test('downloadExceptPages: a person whose block 2 was deleted is never treated as a page; a stale peer is not asked for deleted posts', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'person' })
  await source.ready()
  // The stale peer still holds the deleted bytes of blocks 2 and 4.
  const PERSON = [genesis, post(1), post(2), post(3), post(4), del(5, 2), del(6, 4), post(7)]
  for (const { record } of PERSON) await source.append(encode(record))
  const r = await replica(t, source.key)
  // A fetched-then-cleared block still crossed the wire: watch the downloads.
  const fetched = new Set()
  r.core.on('download', (index) => fetched.add(index))
  link(t, r.store, store)
  const guard = pageTargets(r.core)
  const handle = downloadExceptPages(r.core, new Set([2, 4]), { guard })
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [0, 1, 3, 5, 6, 7]), { name: 'the live blocks' })
  await handle.idle()
  await new Promise((resolve) => setTimeout(resolve, 500))
  // Block 2 alone may be fetched, once, to settle the type; it is a post,
  // so the diary is personal and block 2 is cleared at once.
  t.is(guard.page(), false, 'a person')
  t.absent(await r.core.has(2), 'block 2 is not kept')
  t.absent(fetched.has(4), 'nor any other deleted post')
})

test('downloadExceptPages: once the diary is group-bound each deleted target is fetched once, the group record kept and the post cleared', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'grouped' })
  await source.ready()
  // The peer still holds the deleted join at 3 and the deleted post at 4.
  const LOG = [genesis, groupJoin(1), post(2), groupJoin(3), post(4), del(5, 3), del(6, 4), post(7)]
  for (const { record } of LOG) await source.append(encode(record))
  const r = await replica(t, source.key)
  const fetched = []
  r.core.on('download', (index) => fetched.push(index))
  link(t, r.store, store)
  const guard = pageTargets(r.core)
  const handle = downloadExceptPages(r.core, new Set([3, 4]), { guard })
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [0, 1, 2, 5, 6, 7]), { name: 'the live blocks' })
  await handle.idle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(guard.page(), false, 'a person')
  t.absent(fetched.includes(3) || fetched.includes(4), 'not group-bound yet: no deleted target is fetched')
  guard.setGroupBound(true)
  t.ok(guard.groupBound(), 'group-bound now')
  await until(() => r.core.has(3), { name: 'the deleted join' })
  await until(() => fetched.includes(4), { name: 'the deleted post fetched' })
  await until(async () => !(await r.core.has(4)), { name: 'the deleted post cleared' })
  await handle.update(new Set([3, 4]))
  await handle.idle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.ok(await r.core.has(3), 'the deleted join is kept')
  t.absent(await r.core.has(4), 'the deleted post stays cleared')
  t.is(fetched.filter((i) => i === 4).length, 1, 'the deleted post was fetched once and never again')
})

test('downloadExceptPages: a probed block 2 that is itself a tombstone is kept, so every replica refolds the same way', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'person-undo' })
  await source.ready()
  // Block 2 deletes block 1; block 4 deletes that tombstone.
  const PERSON = [genesis, post(1), del(2, 1), post(3), del(4, 2), post(5)]
  for (const { record } of PERSON) await source.append(encode(record))
  const r = await replica(t, source.key)
  link(t, r.store, store)
  const guard = pageTargets(r.core)
  const handle = downloadExceptPages(r.core, new Set([2]), { guard })
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [0, 1, 3, 4, 5]), { name: 'the live blocks' })
  await handle.idle()
  await until(() => guard.page() !== null, { name: 'the probe settles' })
  t.is(guard.page(), false, 'a person')
  t.ok(await r.core.has(2), 'the tombstone at block 2 is never cleared')
})

test('downloadExceptPages: a roster probe that timed out is not sticky; the honest peer connecting later still delivers the close', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'page-late-honest' })
  await source.ready()
  const PAGE = [genesis, post(1), pageRoster(2), post(3), pageClose(4), post(5), del(6, 2), del(7, 4), post(8)]
  for (const { record } of PAGE) await source.append(encode(record))
  // A peer that withholds the roster and the close (cleared).
  const stale = await replica(t, source.key)
  const feed = link(t, stale.store, store)
  await stale.core.download({ start: 0, end: PAGE.length }).done()
  await stale.core.clear(2, 3)
  await stale.core.clear(4, 5)
  feed.destroy()
  t.absent(await stale.core.has(2))

  const r = await replica(t, source.key)
  link(t, r.store, stale.store)
  const guard = pageTargets(r.core, { probeMs: 300, reprobeMs: 200 })
  const handle = downloadExceptPages(r.core, new Set([2, 4]), { guard })
  t.teardown(() => handle.destroy())
  await until(() => holds(r.core, [0, 1, 3, 5, 6, 7, 8]), { name: 'the live blocks from the stale peer' })
  await new Promise((resolve) => setTimeout(resolve, 600))
  t.is(guard.page(), null, 'a timed-out probe leaves the type unknown, not personal')
  t.absent(await r.core.has(4), 'nothing deleted is fetched meanwhile')

  link(t, r.store, store)
  await until(() => r.core.has(4), { name: 'the page-close from the honest peer' })
  t.is(guard.page(), true, 'a later probe read the roster')
  t.ok(await holds(r.core, [2, 4]), 'the roster and the close are kept')
})

test('pageTargets: with no peer connected the roster probe returns at once; a peer connecting later settles it', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'page-no-peer' })
  await source.ready()
  for (const { record } of [genesis, post(1), pageRoster(2), del(3, 2)]) await source.append(encode(record))
  const r = await replica(t, source.key)
  const guard = pageTargets(r.core, { probeMs: 2000 })
  const started = Date.now()
  const skip = await guard.excludable(new Set([2]))
  t.ok(Date.now() - started < 1000, 'no 2 s poll without a peer (' + (Date.now() - started) + ' ms)')
  t.alike([...skip], [2], 'the target stays out meanwhile')
  t.is(guard.page(), null)

  const waited = Date.now()
  await guard.excludable(new Set([2]), { wait: false })
  t.ok(Date.now() - waited < 1000, 'wait: false never waits for a probe')

  link(t, r.store, store)
  await until(() => guard.page() === true, { name: 'the peer-add probe settles the page' })
  guard.destroy()
})

test('pageTargets: a roster probe that timed out retries on its own, with no new peer and no further call', async (t) => {
  const { EventEmitter } = require('node:events')
  const ROSTER = encode(pageRoster(2).record)
  const core = new EventEmitter()
  core.length = 4
  let delivered = false
  let gets = 0
  // A peer that advertises block 2 but stalls the first request.
  core.peers = [{ remoteContiguousLength: 4, remoteBitfield: { get: () => true } }]
  core.has = async (i) => i === 2 && delivered
  core.get = async (i, { timeout = 0 } = {}) => {
    gets++
    if (i === 2 && delivered) return ROSTER
    await pause(timeout)
    throw new Error('timeout')
  }
  core.clear = async () => {}
  const guard = pageTargets(core, { probeMs: 100, reprobeMs: 200 })
  t.teardown(() => guard.destroy())
  let told = 0
  guard.watch(() => { told++ })
  const skip = await guard.excludable(new Set([2, 3]))
  t.is(guard.page(), null, 'the first probe timed out')
  t.alike([...skip].sort(), [2, 3], 'every target stays out meanwhile')
  t.is(gets, 1, 'one request so far')
  delivered = true
  await until(() => guard.page() !== null, { name: 'the retry settles the type', timeoutMs: 3000 })
  t.is(guard.page(), true, 'a page')
  t.is(told, 1, 'the watcher is told, so the download refreshes')
  t.is((await guard.excludable(new Set([3]))).size, 0, 'an unheld target (the close) joins the download')
})

test('downloadExceptPages: a guard it made itself goes with destroy (no peer-add listener left)', async (t) => {
  const store = await openCorestore(t, tmpDir(t))
  const source = store.get({ name: 'page-own-guard' })
  await source.ready()
  for (const { record } of [genesis, post(1), pageRoster(2), del(3, 2)]) await source.append(encode(record))
  const r = await replica(t, source.key)
  const before = r.core.listenerCount('peer-add')
  // Block 2 unheld and tombstoned: the guard waits for a peer to settle it.
  const handle = downloadExceptPages(r.core, new Set([2]))
  await until(() => r.core.listenerCount('peer-add') > before, { name: 'the guard listens for peers' })
  handle.destroy()
  t.is(r.core.listenerCount('peer-add'), before, 'the peer-add listener is gone')

  // A guard the caller passes stays the caller's.
  const guard = pageTargets(r.core)
  const other = downloadExceptPages(r.core, new Set([2]), { guard })
  await until(() => r.core.listenerCount('peer-add') > before, { name: 'the given guard listens' })
  other.destroy()
  t.is(r.core.listenerCount('peer-add'), before + 1, 'a given guard is not destroyed')
  guard.destroy()
  t.is(r.core.listenerCount('peer-add'), before)
})

// presentState scans only the tombstone and page-* candidates, once: on
// random stored diaries (holes, undone and invalid tombstones, tombstones
// over page records, blocks that do not decode) it answers exactly what the
// three full folds of the decoded blocks answer.
test('presentState: one candidate scan answers as the three full folds', async (t) => {
  let seed = 7
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return (seed >>> 8) % n
  }
  const encodeJson = (record) => b4a.from(JSON.stringify(record))
  let checked = 0
  let undone = 0
  let pageKept = 0
  for (let round = 0; round < 200; round++) {
    const length = 2 + rand(40)
    const blocks = new Map([[0, encodeJson(genesis.record)]])
    for (let seq = 1; seq < length; seq++) {
      const kind = rand(10)
      let block
      if (kind < 4) block = encodeJson(post(seq).record)
      else if (kind < 7) block = encodeJson(del(seq, 1 + rand(seq)).record)
      else if (kind === 7) block = encodeJson({ type: 'page-delegate', actor: K3, at: AT })
      else if (kind === 8) block = encodeJson({ type: 'delete', seq: 1 + rand(seq), at: AT, author: K1 })
      else block = b4a.from('{oops')
      if (rand(6) !== 0) blocks.set(seq, block)
    }
    const core = {
      length,
      has: async (i) => blocks.has(i),
      get: async (i) => blocks.get(i) || null
    }
    const state = await presentState(core)
    const deleted = deletedSeqs(state.raw)
    const targets = new Set()
    const holes = []
    for (const { seq, record } of state.raw) {
      if (record === null && !blocks.has(seq)) holes.push(seq)
      if (record !== null && record.type === 'delete' && validateRecord(record, seq) === null) targets.add(record.seq)
    }
    let present = state.raw.length
    for (const seq of holes) {
      if (!targets.has(seq)) {
        present = seq
        break
      }
    }
    t.alike([...state.deleted].sort((a, b) => a - b), [...deleted].sort((a, b) => a - b), 'deleted ' + round)
    t.alike(state.entries, applyDeletes(state.raw), 'entries ' + round)
    t.is(state.present, present, 'present ' + round)
    checked++
    if (targets.size > deleted.size) undone++
    if ([...targets].some((s) => state.raw[s] && state.raw[s].record && state.raw[s].record.type === 'page-delegate')) pageKept++
  }
  t.is(checked, 200)
  t.ok(undone > 0, 'some tombstones were undone')
  t.ok(pageKept > 0, 'some tombstones named a page record')
})

const PLACE = { uf: 'SP', city: 'Recife', bairro: 'Boa Vista' }
const listingRec = (media) => ({ type: 'listing', kind: 'produto', title: 'Mesa', text: '', price: 100, unit: null, cat: 'moveis', place: PLACE, at: AT, ...(media ? { media } : {}) })
const editRec = (target, media) => ({ type: 'listing-edit', seq: target, title: 'Mesa', text: '', price: 90, unit: null, cat: 'moveis', place: PLACE, at: AT, ...(media ? { media } : {}) })

test('shownMedia: listing and edit photos, nothing for status or rate', (t) => {
  const a = desc(K3, 1, 2)
  const b = desc(K3, 3, 1)
  t.alike(shownMedia(listingRec([a])), [a])
  t.alike(shownMedia(listingRec()), [])
  t.alike(shownMedia(editRec(1, [b])), [b])
  t.alike(shownMedia(editRec(1)), [])
  t.alike(shownMedia({ type: 'listing-status', seq: 1, status: 'vendido', at: AT }), [])
  t.alike(shownMedia({ type: 'listing-rate', to: { author: K2, seq: 1 }, offer: 'f'.repeat(32), consent: 'c'.repeat(128), stars: 5, text: '', at: AT }), [])
})

test('liveMediaRefs: a live listing root keeps its photos after an edit replaced them', (t) => {
  const a = desc(K3, 1, 2)
  const b = desc(K3, 3, 1)
  const entries = [genesis, { seq: 1, record: listingRec([a]) }, { seq: 2, record: editRec(1, [b]) }]
  t.alike(liveMediaRefs(entries), [{ core: K3, start: 1, blocks: 2 }, { core: K3, start: 3, blocks: 1 }])
})

test('deletedRanges: a range a listing shares with a post survives', (t) => {
  const shared = desc(K3, 1, 2)
  const own = desc(K3, 5, 1)
  const ranges = [{ core: K3, start: 1, blocks: 2 }, { core: K3, start: 5, blocks: 1 }]
  const entries = [genesis, post(1, { text: '', media: [shared] }), { seq: 2, record: listingRec([shared, own]) }, del(3, 2, ranges)]
  t.is(validateRecord(entries[2].record, 2), null)
  t.alike(deletedRanges(entries, [K3]), [{ core: K3, start: 5, blocks: 1 }])
})

test('liveMediaRefs: an edit of a deleted listing shows nothing', (t) => {
  const a = desc(K3, 1, 1)
  const b = desc(K3, 2, 1)
  const entries = [genesis, { seq: 1, record: listingRec([a]) }, { seq: 2, record: editRec(1, [b]) }, del(3, 1, [{ core: K3, start: 1, blocks: 1 }])]
  t.alike(liveMediaRefs(entries), [])
  t.alike(deletedRanges([...entries, del(4, 2, [{ core: K3, start: 2, blocks: 1 }])], [K3]), [{ core: K3, start: 2, blocks: 1 }, { core: K3, start: 1, blocks: 1 }])
})

// The targets of `seqs` a group-bound download of `core` lets go: the ones
// this replica read or remembers reading; one it never held stays in.
async function settledTargets (core, seqs) {
  const guard = pageTargets(core, { groupBound: true, page: false, remember: true })
  try {
    return [...await guard.excludable(new Set(seqs), { wait: false })].sort()
  } finally {
    guard.destroy()
  }
}

test('clears are remembered: a group-bound download never fetches a cleared block back, after a reopen', async (t) => {
  const w = await writer(t)
  const r = await replica(t, w.core.key)
  const l = link(t, r.store, w.store)
  for (const seq of [0, 1, 3, 4, 5]) await r.core.get(seq)
  l.destroy()
  t.alike(await settledTargets(r.core, [GONE]), [], 'a target this replica never held stays in the download')
  t.alike(await clearDeleted(w.core, [GONE]), [GONE])
  await w.store.closeOnce()
  const store = await openCorestore(t, w.dir)
  const core = store.get({ name: 'diary' })
  await core.ready()
  t.absent(await core.has(GONE), 'still cleared after the reopen')
  t.alike(await settledTargets(core, [GONE]), [GONE], 'the cleared block leaves the download')
})

test('clears are remembered: clears of several blocks are all kept, none overwrites another', async (t) => {
  const w = await writer(t)
  t.alike(await clearDeleted(w.core, [1]), [1])
  t.alike(await clearDeleted(w.core, [3]), [3])
  t.alike(await settledTargets(w.core, [1, 3]), [1, 3], 'both cleared blocks leave the download')
  t.alike(await settledTargets({ has: async () => false }, [1, 3]), [], 'a core with no user data remembers nothing')
})
