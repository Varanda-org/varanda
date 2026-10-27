'use strict'

// The follower index, the ownership proof and the message validators of
// the notices channel (lib/notices.js). No network.
const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const {
  NOTICES_LIMIT_DEFAULT,
  NOTICES_LIMIT_MAX,
  MAX_FOLLOW_TARGETS_PER_AUTHOR,
  NOTICES_MAX_EDGES,
  MAX_NONMEMBER_TARGETS_PER_AUTHOR,
  MAX_NOTICES_MESSAGE,
  NOTICES_PROTOCOL,
  NOTICE_PROOF_PREFIX,
  createNoticeIndex,
  noticePayload,
  signNoticeProof,
  verifyNoticeProof,
  validateNoticesMessage
} = require('../lib/notices')
const { followRecord, validRecordCopy } = require('../lib/records')

// Distinct hex64 keys that sort in index order.
function k (i) {
  return i.toString(16).padStart(64, '0')
}

const ME = k(0xffff)
const D = (day) => '2026-01-' + String(day).padStart(2, '0') + 'T00:00:00.000Z'

function follow (key, on, at) {
  return validRecordCopy(followRecord({ key, on, at }), 1)
}

// Every key of every object reachable from v.
function allKeys (v, out = []) {
  if (v !== null && typeof v === 'object') {
    for (const key of Object.keys(v)) {
      out.push(key)
      allKeys(v[key], out)
    }
  }
  return out
}

test('constants', (t) => {
  t.is(NOTICES_LIMIT_DEFAULT, 30)
  t.is(NOTICES_LIMIT_MAX, 64)
  t.is(MAX_FOLLOW_TARGETS_PER_AUTHOR, 4096)
  t.is(NOTICES_MAX_EDGES, 262144)
  t.is(MAX_NONMEMBER_TARGETS_PER_AUTHOR, 64)
  t.is(MAX_NOTICES_MESSAGE, 16384)
  t.is(NOTICES_PROTOCOL, 'varanda/notices/1')
  t.is(NOTICE_PROOF_PREFIX, 'varanda-notices-v1\n')
})

test('fold: last seq wins whatever the order; commit publishes only follows', (t) => {
  const idx = createNoticeIndex()
  const a = k(1)
  idx.foldFollow(a, 5, follow(ME, false, D(5)))
  idx.foldFollow(a, 3, follow(ME, true, D(3))) // older: ignored
  idx.commit(a)
  t.alike(idx.page({ target: ME }).items, [], 'the later unfollow wins')

  idx.foldFollow(a, 7, follow(ME, true, D(7)))
  idx.commit(a)
  t.alike(idx.page({ target: ME }).items, [{ key: a, seq: 7, at: D(7) }])

  // Unfollow removes the published edge after commit (not before).
  idx.foldFollow(a, 8, follow(ME, false, D(8)))
  t.is(idx.page({ target: ME }).items.length, 1, 'uncommitted unfollow not visible')
  idx.commit(a)
  t.alike(idx.page({ target: ME }).items, [])
})

test('fold: a record at or below the author high-water seq is ignored, stored or refused', (t) => {
  // Refused at the global cap, then capacity frees up, then an OLDER record
  // for the same target arrives: the latest record (seq 2, off) must win.
  const idx = createNoticeIndex({ maxEdges: 1 })
  const a = k(1)
  const b = k(2)
  idx.foldFollow(a, 1, follow(k(10), true, D(1)))
  idx.commit(a)
  idx.foldFollow(b, 2, follow(ME, false, D(2))) // refused: the index is full
  idx.removeAuthor(a)
  idx.foldFollow(b, 1, follow(ME, true, D(1))) // older than seq 2: ignored
  idx.commit(b)
  t.alike(idx.page({ target: ME }).items, [], 'the refused unfollow still outranks the older follow')
  idx.foldFollow(b, 3, follow(ME, true, D(3)))
  idx.commit(b)
  t.alike(idx.page({ target: ME }).items, [{ key: b, seq: 3, at: D(3) }], 'a newer record is folded')

  // Out of order for an existing target, and an equal seq, are ignored too.
  const idx2 = createNoticeIndex()
  idx2.foldFollow(a, 4, follow(ME, true, D(4)))
  idx2.foldFollow(a, 4, follow(ME, false, D(4)))
  idx2.foldFollow(a, 2, follow(ME, false, D(2)))
  idx2.foldFollow(a, 3, follow(k(11), true, D(3))) // a different target, still stale
  idx2.commit(a)
  t.alike(idx2.page({ target: ME }).items, [{ key: a, seq: 4, at: D(4) }])
  t.alike(idx2.page({ target: k(11) }).items, [])
  // removeAuthor resets the mark (a re-serve scans from seq 1 again).
  idx2.removeAuthor(a)
  idx2.foldFollow(a, 1, follow(ME, true, D(1)))
  idx2.commit(a)
  t.alike(idx2.page({ target: ME }).items, [{ key: a, seq: 1, at: D(1) }])
})

test('self-follow ignored; non-follow and hostile input never throw', (t) => {
  const idx = createNoticeIndex()
  idx.foldFollow(ME, 1, follow(ME, true, D(1)))
  idx.commit(ME)
  t.alike(idx.page({ target: ME }).items, [])

  const hostile = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  const getter = { type: 'follow', on: true, at: D(1) }
  Object.defineProperty(getter, 'key', { enumerable: true, get () { throw new Error('boom') } })
  for (const rec of [null, undefined, 1, 'x', [], hostile, getter, { type: 'post', text: 'x', at: D(1) }, { type: 'follow', key: 'XY', on: true, at: D(1) }]) {
    idx.foldFollow(k(2), 1, rec)
  }
  idx.foldFollow('not-hex', 1, follow(ME, true, D(1)))
  idx.foldFollow(k(2), 0, follow(ME, true, D(1)))
  idx.foldFollow(k(2), 1.5, follow(ME, true, D(1)))
  idx.commit(k(2))
  t.alike(idx.page({ target: ME }).items, [])
  t.alike(idx.page({ target: 'bad' }), { items: [], next: null, incomplete: false })
  t.alike(idx.page(), { items: [], next: null, incomplete: false })
})

test('an uncommitted fold is not visible; markPending makes pages incomplete until commit', (t) => {
  const idx = createNoticeIndex()
  const a = k(1)
  idx.markPending(a)
  idx.foldFollow(a, 1, follow(ME, true, D(1)))
  let p = idx.page({ target: ME })
  t.alike(p.items, [])
  t.is(p.incomplete, true)
  idx.commit(a)
  p = idx.page({ target: ME })
  t.alike(p.items, [{ key: a, seq: 1, at: D(1) }])
  t.is(p.incomplete, false)
  idx.markPending(a) // a later scan ended short of the signed length
  t.is(idx.page({ target: ME }).incomplete, true)
  t.is(idx.page({ target: ME }).items.length, 1, 'the committed edges stay visible')
  idx.removeAuthor(a)
  p = idx.page({ target: ME })
  t.alike(p, { items: [], next: null, incomplete: false })
})

test('per-author cap marks the author truncated', (t) => {
  const idx = createNoticeIndex({ maxPerAuthor: 2 })
  const a = k(1)
  idx.foldFollow(a, 1, follow(k(10), true, D(1)))
  idx.foldFollow(a, 2, follow(k(11), true, D(2)))
  t.is(idx.page({ target: k(10) }).incomplete, false)
  idx.foldFollow(a, 3, follow(k(12), true, D(3)))
  // An existing target still updates past the cap.
  idx.foldFollow(a, 4, follow(k(11), false, D(4)))
  idx.commit(a)
  t.is(idx.page({ target: k(12) }).items.length, 0, 'refused target')
  t.is(idx.page({ target: k(11) }).items.length, 0, 'existing target updated')
  t.is(idx.page({ target: k(10) }).items.length, 1)
  t.is(idx.page({ target: k(10) }).incomplete, true)
  idx.removeAuthor(a)
  t.is(idx.page({ target: k(10) }).incomplete, false)
})

test('global maxEdges cap refuses new targets for any author; removeAuthor releases it', (t) => {
  const idx = createNoticeIndex({ maxEdges: 3 })
  const a = k(1)
  const b = k(2)
  const c = k(3)
  idx.foldFollow(a, 1, follow(k(10), true, D(1)))
  idx.foldFollow(a, 2, follow(k(11), true, D(1)))
  idx.foldFollow(b, 1, follow(k(10), true, D(2)))
  // Unfollow entries count too (the fold holds them).
  idx.foldFollow(c, 1, follow(k(10), true, D(3)))
  idx.commit(a)
  idx.commit(b)
  idx.commit(c)
  t.alike(idx.page({ target: k(10) }).items.map((i) => i.key), [b, a])
  t.is(idx.page({ target: k(10) }).incomplete, true)

  idx.removeAuthor(b)
  t.is(idx.page({ target: k(10) }).incomplete, true, 'c is still truncated')
  idx.removeAuthor(c)
  t.is(idx.page({ target: k(10) }).incomplete, false)
  idx.foldFollow(c, 1, follow(k(10), true, D(3)))
  idx.foldFollow(c, 2, follow(k(12), true, D(3))) // over the cap again (a holds 2, c 1)
  idx.commit(c)
  t.alike(idx.page({ target: k(10) }).items.map((i) => i.key), [c, a], 'released capacity is reused')
  t.is(idx.page({ target: k(12) }).items.length, 0)
  t.is(idx.page({ target: k(10) }).incomplete, true)
})

// Members are k(10)..k(99) and ME; k(0x10000 + i) are random non-member keys.
const MEMBERS = new Set([ME])
for (let i = 10; i < 100; i++) MEMBERS.add(k(i))
const isMember = (hex) => MEMBERS.has(hex)
const outsider = (i) => k(0x10000 + i)

test('non-member targets: at most 64 per author, skipped without truncation', (t) => {
  const idx = createNoticeIndex({ isMember })
  const a = k(1)
  for (let i = 0; i < 100; i++) idx.foldFollow(a, i + 1, follow(outsider(i), true, D(1)))
  idx.commit(a)
  let stored = 0
  for (let i = 0; i < 100; i++) stored += idx.page({ target: outsider(i) }).items.length
  t.is(stored, MAX_NONMEMBER_TARGETS_PER_AUTHOR)
  t.is(idx.page({ target: outsider(63) }).items.length, 1, 'the first 64 are kept')
  t.is(idx.page({ target: outsider(64) }).items.length, 0, 'the 65th is skipped')
  t.is(idx.page({ target: ME }).incomplete, false, 'not truncated')
  // Member targets past the non-member cap are still accepted.
  idx.foldFollow(a, 101, follow(ME, true, D(2)))
  idx.foldFollow(a, 102, follow(k(10), true, D(2)))
  // A stored non-member target still updates.
  idx.foldFollow(a, 103, follow(outsider(0), false, D(2)))
  idx.commit(a)
  t.alike(idx.page({ target: ME }).items.map((i) => i.key), [a])
  t.alike(idx.page({ target: k(10) }).items.map((i) => i.key), [a])
  t.is(idx.page({ target: outsider(0) }).items.length, 0)
  t.is(idx.page({ target: ME }).incomplete, false)
})

test('non-member targets cannot exhaust maxEdges for honest member follows', (t) => {
  const idx = createNoticeIndex({ isMember, maxEdges: 4 * MAX_NONMEMBER_TARGETS_PER_AUTHOR + 2 })
  // Four Sybil authors each try 200 random non-member keys.
  for (let s = 0; s < 4; s++) {
    const sybil = k(0x100 + s)
    for (let i = 0; i < 200; i++) idx.foldFollow(sybil, i + 1, follow(outsider(s * 1000 + i), true, D(1)))
    idx.commit(sybil)
  }
  const honest = [k(1), k(2)]
  idx.foldFollow(honest[0], 1, follow(ME, true, D(3)))
  idx.foldFollow(honest[1], 1, follow(ME, true, D(4)))
  idx.commit(honest[0])
  idx.commit(honest[1])
  const p = idx.page({ target: ME })
  t.alike(p.items.map((i) => i.key), [honest[1], honest[0]])
  t.is(p.incomplete, false)
})

test('a throwing isMember counts as not a member', (t) => {
  const idx = createNoticeIndex({ isMember: () => { throw new Error('boom') } })
  const a = k(1)
  for (let i = 0; i < 70; i++) idx.foldFollow(a, i + 1, follow(outsider(i), true, D(1)))
  idx.commit(a)
  t.is(idx.page({ target: outsider(63) }).items.length, 1)
  t.is(idx.page({ target: outsider(64) }).items.length, 0)
  t.is(idx.page({ target: outsider(0) }).incomplete, false)
  t.exception.all(() => createNoticeIndex({ isMember: 1 }), TypeError)
})

test('removeAuthor releases the non-member count', (t) => {
  const idx = createNoticeIndex({ isMember })
  const a = k(1)
  for (let i = 0; i < 64; i++) idx.foldFollow(a, i + 1, follow(outsider(i), true, D(1)))
  idx.foldFollow(a, 65, follow(outsider(500), true, D(1)))
  idx.commit(a)
  t.is(idx.page({ target: outsider(500) }).items.length, 0)
  idx.removeAuthor(a)
  idx.foldFollow(a, 1, follow(outsider(500), true, D(1)))
  idx.commit(a)
  t.is(idx.page({ target: outsider(500) }).items.length, 1, 'count reset on removeAuthor')
})

test('page order is numeric by date, then key; exclusive cursor across pages', (t) => {
  const idx = createNoticeIndex()
  const EXT = '+010000-01-01T00:00:00.000Z' // later than any 4-digit year, but sorts first as a string
  const NEG = '-000001-01-01T00:00:00.000Z'
  const rows = [
    [k(1), D(1)],
    [k(2), D(2)],
    [k(3), D(2)],
    [k(4), EXT],
    [k(5), NEG],
    [k(6), D(3)]
  ]
  rows.forEach(([a, at], i) => {
    const rec = follow(ME, true, at)
    t.ok(rec, 'valid record ' + at)
    idx.foldFollow(a, i + 1, rec)
    idx.commit(a)
  })
  const expected = [k(4), k(6), k(2), k(3), k(1), k(5)]
  t.alike(idx.page({ target: ME }).items.map((i) => i.key), expected)

  const seen = []
  let after = null
  for (let n = 0; n < 10; n++) {
    const p = idx.page({ target: ME, after, limit: 2 })
    seen.push(...p.items.map((i) => i.key))
    if (p.next === null) break
    t.alike(p.next, { at: p.items[1].at, key: p.items[1].key })
    after = p.next
  }
  t.alike(seen, expected, 'every row exactly once')
  const last = idx.page({ target: ME, after: { at: NEG, key: k(5) } })
  t.alike(last, { items: [], next: null, incomplete: false })
})

test('blocked keys are skipped without stalling the cursor; limit is clamped', (t) => {
  const idx = createNoticeIndex()
  for (let i = 1; i <= 70; i++) {
    idx.foldFollow(k(i), 1, follow(ME, true, D(1)))
    idx.commit(k(i))
  }
  const blocked = new Set([k(2), k(3), k(4)])
  const isBlocked = (key) => blocked.has(key)
  let p = idx.page({ target: ME, isBlocked, limit: 2 })
  t.alike(p.items.map((i) => i.key), [k(1), k(5)])
  t.alike(p.next, { at: D(1), key: k(5) })
  p = idx.page({ target: ME, isBlocked, after: { at: D(1), key: k(1) }, limit: 1 })
  t.alike(p.items.map((i) => i.key), [k(5)], 'a cursor before blocked rows moves past them')

  // Blocked rows at the tail: no next pointing at nothing.
  const tail = new Set()
  for (let i = 3; i <= 70; i++) tail.add(k(i))
  p = idx.page({ target: ME, isBlocked: (key) => tail.has(key), limit: 2 })
  t.is(p.items.length, 2)
  t.is(p.next, null)
  // A throwing isBlocked hides the row.
  t.is(idx.page({ target: ME, isBlocked: () => { throw new Error('x') } }).items.length, 0)

  t.is(idx.page({ target: ME }).items.length, NOTICES_LIMIT_DEFAULT)
  t.is(idx.page({ target: ME, limit: 0 }).items.length, 1)
  t.is(idx.page({ target: ME, limit: -5 }).items.length, 1)
  t.is(idx.page({ target: ME, limit: 1000 }).items.length, NOTICES_LIMIT_MAX)
  t.is(idx.page({ target: ME, limit: 'x' }).items.length, NOTICES_LIMIT_DEFAULT)
  t.is(idx.page({ target: ME, limit: NaN }).items.length, NOTICES_LIMIT_DEFAULT)
})

test('no count, total, size or length anywhere', (t) => {
  const idx = createNoticeIndex()
  for (let i = 1; i <= 5; i++) {
    idx.foldFollow(k(i), 1, follow(ME, true, D(i)))
    idx.commit(k(i))
  }
  const banned = ['count', 'total', 'size', 'length']
  const p = idx.page({ target: ME, limit: 2 })
  for (const key of allKeys(p)) t.absent(banned.includes(key), 'page key ' + key)
  for (const key of Object.keys(idx)) t.absent(banned.includes(key), 'index key ' + key)
  for (const fn of ['markPending', 'foldFollow', 'commit', 'removeAuthor']) {
    t.is(idx[fn](k(1), 1, follow(ME, true, D(1))), undefined, fn + ' returns nothing')
  }
})

test('proof sign and verify', (t) => {
  const kp = hcrypto.keyPair()
  const other = hcrypto.keyPair()
  const key = b4a.toString(kp.publicKey, 'hex')
  const nonce = b4a.toString(hcrypto.randomBytes(32), 'hex')
  const noise = b4a.toString(hcrypto.randomBytes(32), 'hex')
  const payload = noticePayload(nonce, noise, key)
  t.is(b4a.toString(payload, 'utf8'), NOTICE_PROOF_PREFIX + nonce + '\n' + noise + '\n' + key)
  const sig = signNoticeProof(payload, kp)
  t.is(sig.byteLength, 64)
  const sigHex = b4a.toString(sig, 'hex')
  t.ok(verifyNoticeProof({ nonce, noise, key }, sigHex))

  const flip = (h) => (h[0] === '0' ? '1' : '0') + h.slice(1)
  t.absent(verifyNoticeProof({ nonce: flip(nonce), noise, key }, sigHex), 'wrong nonce')
  t.absent(verifyNoticeProof({ nonce, noise: flip(noise), key }, sigHex), 'wrong noise')
  t.absent(verifyNoticeProof({ nonce, noise, key: b4a.toString(other.publicKey, 'hex') }, sigHex), 'wrong key')
  t.absent(verifyNoticeProof({ nonce, noise, key }, flip(sigHex)), 'tampered sig')
  t.absent(verifyNoticeProof({ nonce, noise, key }, sigHex.slice(2)), 'short sig')
  t.absent(verifyNoticeProof({ nonce, noise, key }, sigHex + '00'), 'long sig')
  t.absent(verifyNoticeProof({ nonce, noise, key }, sigHex.toUpperCase()), 'upper-case sig')
  t.absent(verifyNoticeProof({ nonce: nonce.toUpperCase(), noise, key }, sigHex), 'upper-case nonce')
  t.absent(verifyNoticeProof({ nonce, noise, key }, null))
  t.absent(verifyNoticeProof(null, sigHex))
  const hostile = new Proxy({}, { get () { throw new Error('boom') } })
  t.absent(verifyNoticeProof(hostile, sigHex))
})

test('message validators', (t) => {
  const H = 'ab'.repeat(32)
  const S = 'cd'.repeat(64)
  const cursor = { at: D(1), key: H }
  const item = { key: H, seq: 1, at: D(1) }
  const valid = [
    { type: 'challenge', nonce: H },
    { type: 'proof', key: H, sig: S },
    { type: 'page', after: null, limit: 1 },
    { type: 'page', after: cursor, limit: 64 },
    { type: 'items', items: [], next: null, incomplete: false },
    { type: 'items', items: new Array(64).fill(item), next: cursor, incomplete: true },
    { type: 'page', after: { at: '+010000-01-01T00:00:00.000Z', key: H }, limit: 30 }
  ]
  for (const m of valid) t.ok(validateNoticesMessage(m), 'valid ' + m.type)
  for (const m of valid) t.absent(validateNoticesMessage({ ...m, extra: 1 }), 'extra key ' + m.type)

  const invalid = [
    { type: 'page', after: null, limit: 0 },
    { type: 'page', after: null, limit: 65 },
    { type: 'page', after: null, limit: 1.5 },
    { type: 'page', after: { at: '2026-01-01', key: H }, limit: 1 },
    { type: 'page', after: { at: D(1), key: H, x: 1 }, limit: 1 },
    { type: 'page', after: { at: D(1), key: H.toUpperCase() }, limit: 1 },
    { type: 'items', items: new Array(65).fill(item), next: null, incomplete: false },
    { type: 'items', items: [{ ...item, seq: 0 }], next: null, incomplete: false },
    { type: 'items', items: [{ ...item, at: '2026-01-01T00:00:00Z' }], next: null, incomplete: false },
    { type: 'items', items: [{ ...item, extra: 1 }], next: null, incomplete: false },
    { type: 'items', items: [], next: null, incomplete: 'no' },
    { type: 'items', items: {}, next: null, incomplete: false },
    { type: 'challenge', nonce: H.toUpperCase() },
    { type: 'challenge', nonce: H.slice(2) },
    { type: 'proof', key: H, sig: S.toUpperCase() },
    { type: 'proof', key: H, sig: S.slice(2) },
    { type: 'other' },
    null,
    [],
    'challenge',
    Object.create({ type: 'challenge', nonce: H })
  ]
  for (const m of invalid) t.absent(validateNoticesMessage(m), 'invalid ' + JSON.stringify(m))

  const throwing = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') }, ownKeys () { throw new Error('boom') } })
  const getter = { type: 'challenge' }
  Object.defineProperty(getter, 'nonce', { enumerable: true, get () { throw new Error('boom') } })
  const itemsProxy = { type: 'items', items: new Proxy([], { get () { throw new Error('boom') } }), next: null, incomplete: false }
  for (const m of [throwing, getter, itemsProxy]) {
    t.execution(() => validateNoticesMessage(m))
    t.absent(validateNoticesMessage(m))
  }
})
