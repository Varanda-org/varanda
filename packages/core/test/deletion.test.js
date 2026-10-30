'use strict'

const test = require('brittle')
const { deletedSeqs, applyDeletes, deletedRanges, liveMediaRefs, overlaps } = require('../lib/deletion')

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
