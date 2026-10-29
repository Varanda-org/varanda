'use strict'

// lib/name-index.js: newest seq wins with no fallback, copied records are
// ignored, settle verifies each candidate exactly once, failed verification
// and unusable issuers hide the @nome but not the name, visibility, the
// RESULTS_MAX bound with `more`, the author cap, remove/clear, totality and
// a speed bound.
const test = require('brittle')
const { DEFAULT_MAX_AUTHORS, createNameIndex } = require('../lib/name-index')

const ISSUER = 'ee'.repeat(32)
const AT = '2026-01-01T00:00:00.000Z'

function hex (n) {
  return n.toString(16).padStart(64, '0')
}

function profile (name) {
  return { type: 'profile', name, bio: 'a bio', at: AT }
}

function username (member, name, issuer = ISSUER) {
  return { type: 'username', username: name, member, date: AT, association: 'cd'.repeat(32), issuer, issuerDate: AT, issuerSignature: 'ef'.repeat(64), signature: 'ab'.repeat(64) }
}

const yes = () => true
const ALL = [yes, yes]

function counter (result = true) {
  const calls = []
  const fn = (author, record) => {
    calls.push({ author, record })
    if (result instanceof Error) throw result
    return result
  }
  fn.calls = calls
  return fn
}

test('a pending candidate keeps only the bounded username schema fields', (t) => {
  const verify = counter(true)
  const idx = createNameIndex({ maxAuthors: 1, verifyUsername: verify })
  const a = hex(1)
  const big = { ...username(a, 'ana'), bio: 'x'.repeat(4 * 1024 * 1024), email: 'a@b.c' }
  t.is(idx.note(a, 1, big), true)
  idx.settle(a)
  t.is(verify.calls.length, 1)
  t.alike(Object.keys(verify.calls[0].record).sort(), ['association', 'date', 'issuer', 'issuerDate', 'issuerSignature', 'member', 'signature', 'type', 'username'])
  // A missing or oversized schema field: the record is ignored (no candidate).
  const missing = username(a, 'ana_b')
  delete missing.issuerSignature
  idx.note(a, 2, missing)
  idx.note(a, 3, { ...username(a, 'ana_c'), signature: 'ab'.repeat(200) })
  idx.settle(a)
  t.is(verify.calls.length, 1)
  t.is(idx.search(['ana'], ...ALL).members[0].usernameSeq, 1)
})

test('a candidate noted during verification supersedes the one being settled', (t) => {
  const a = hex(1)
  let idx = null
  const verify = (author, record) => {
    if (record.username === 'ana') idx.note(a, 5, username(a, 'ana_nova'))
    return true
  }
  idx = createNameIndex({ verifyUsername: verify })
  idx.note(a, 1, profile('Ana'))
  idx.note(a, 2, username(a, 'ana'))
  idx.settle(a)
  // The old @nome was not put back: only the name matches until the next settle.
  t.is(idx.search(['ana'], ...ALL).members[0].usernameSeq, null)
  idx.settle(a)
  t.is(idx.search(['ana', 'nova'], ...ALL).members[0].usernameSeq, 5)
})

test('defaults and stats', (t) => {
  t.is(DEFAULT_MAX_AUTHORS, 4096)
  t.alike(createNameIndex().stats(), { authors: 0, maxAuthors: 4096 })
  t.alike(createNameIndex({ maxAuthors: -1 }).stats().maxAuthors, 4096)
  t.alike(createNameIndex({ maxAuthors: 1.5 }).stats().maxAuthors, 4096)
  t.alike(createNameIndex({ maxAuthors: 0 }).stats().maxAuthors, 0)
  t.alike(createNameIndex({ maxAuthors: 7 }).stats().maxAuthors, 7)
})

test('profile: newest seq wins', (t) => {
  const idx = createNameIndex()
  const a = hex(1)
  t.ok(idx.note(a, 5, profile('Ana Silva')))
  t.ok(idx.note(a, 3, profile('Bia Costa')))
  t.alike(idx.search(['ana'], ...ALL), { members: [{ author: a, profileSeq: 5, usernameSeq: null }], more: false })
  t.alike(idx.search(['bia'], ...ALL), { members: [], more: false })
  t.ok(idx.note(a, 6, profile('Bia Costa')))
  t.alike(idx.search(['ana'], ...ALL), { members: [], more: false })
  t.alike(idx.search(['bia'], ...ALL).members, [{ author: a, profileSeq: 6, usernameSeq: null }])
  // A name with no tokens still records the seq.
  t.ok(idx.note(a, 7, profile('\u{1F600}')))
  t.alike(idx.search(['bia'], ...ALL).members, [])
  // Bad names are ignored.
  t.ok(idx.note(a, 8, profile('')))
  t.ok(idx.note(a, 9, profile('x'.repeat(81))))
  t.ok(idx.note(a, 10, profile(5)))
  t.ok(idx.note(a, 11, profile('Zé ' + 'x'.repeat(77))))
  t.alike(idx.search(['ze'], ...ALL).members, [{ author: a, profileSeq: 11, usernameSeq: null }])
})

test('username: newest seq wins, no fallback, copied record ignored', (t) => {
  const verify = counter(true)
  const idx = createNameIndex({ verifyUsername: verify })
  const a = hex(1)
  const b = hex(2)
  t.ok(idx.note(a, 2, username(a, 'ana_silva')))
  idx.settle(a)
  t.is(verify.calls.length, 1)
  t.is(verify.calls[0].author, a)
  t.is(verify.calls[0].record.username, 'ana_silva')
  t.alike(idx.search(['ana', 'silva'], ...ALL).members, [{ author: a, profileSeq: null, usernameSeq: 2 }])
  // Copied record from b's diary: ignored, clears nothing.
  t.ok(idx.note(a, 9, username(b, 'bia_costa')))
  idx.settle(a)
  t.is(verify.calls.length, 1)
  t.alike(idx.search(['ana', 'silva'], ...ALL).members, [{ author: a, profileSeq: null, usernameSeq: 2 }])
  // Older/equal seq: no-op.
  t.ok(idx.note(a, 2, username(a, 'zed_one')))
  t.ok(idx.note(a, 1, username(a, 'zed_one')))
  idx.settle(a)
  t.is(verify.calls.length, 1)
  // A newer candidate clears the adopted @nome at once.
  t.ok(idx.note(a, 4, username(a, 'zed_one')))
  t.alike(idx.search(['ana', 'silva'], ...ALL), { members: [], more: false })
  t.alike(idx.search(['zed'], ...ALL), { members: [], more: false })
  idx.settle(a)
  t.is(verify.calls.length, 2)
  t.alike(idx.search(['zed', 'one'], ...ALL).members, [{ author: a, profileSeq: null, usernameSeq: 4 }])
  // Invalid usernames and issuers are ignored.
  t.ok(idx.note(a, 10, username(a, 'abcdef')))
  t.ok(idx.note(a, 11, username(a, 'Zed')))
  t.ok(idx.note(a, 12, username(a, 'zed_two', 'EE'.repeat(32))))
  idx.settle(a)
  t.is(verify.calls.length, 2)
  t.alike(idx.search(['zed', 'one'], ...ALL).members, [{ author: a, profileSeq: null, usernameSeq: 4 }])
})

test('settle: once per candidate, never without one, signature dropped', (t) => {
  const verify = counter(true)
  const idx = createNameIndex({ verifyUsername: verify })
  const a = hex(1)
  idx.settle(a)
  t.is(verify.calls.length, 0)
  idx.note(a, 1, profile('Ana'))
  idx.settle(a)
  t.is(verify.calls.length, 0)
  const rec = username(a, 'ana_b')
  idx.note(a, 2, rec)
  t.not(verify.calls.length, 1)
  idx.settle(a)
  idx.settle(a)
  idx.settle(a)
  t.is(verify.calls.length, 1)
  t.not(verify.calls[0].record, rec) // a copy
  t.alike(verify.calls[0].record, rec)
  // Mutating the original does not change the stored copy.
  rec.username = 'zzz_zzz'
  t.alike(idx.search(['ana', 'b'], ...ALL).members, [{ author: a, profileSeq: 1, usernameSeq: 2 }])
  t.alike(idx.search(['zzz'], ...ALL).members, [])
})

test('false or throwing verifier: @nome unsearchable, name still matches', (t) => {
  for (const result of [false, 'true', 1, null, new Error('boom')]) {
    const verify = counter(result)
    const idx = createNameIndex({ verifyUsername: verify })
    const a = hex(1)
    idx.note(a, 1, profile('Ana Silva'))
    idx.note(a, 2, username(a, 'zed_one'))
    idx.settle(a)
    idx.settle(a)
    t.is(verify.calls.length, 1)
    t.alike(idx.search(['zed'], ...ALL), { members: [], more: false })
    t.alike(idx.search(['ana'], ...ALL).members, [{ author: a, profileSeq: 1, usernameSeq: null }])
  }
  // No verifier at all: never adopted.
  const idx = createNameIndex()
  idx.note(hex(1), 2, username(hex(1), 'zed_one'))
  idx.settle(hex(1))
  t.alike(idx.search(['zed'], ...ALL), { members: [], more: false })
})

test('usableIssuer: false or throwing drops a username-only match, keeps a name match', (t) => {
  const idx = createNameIndex({ verifyUsername: yes })
  const a = hex(1)
  const b = hex(2)
  idx.note(a, 1, username(a, 'ana_silva'))
  idx.settle(a)
  idx.note(b, 1, profile('Ana'))
  idx.note(b, 2, username(b, 'ana_costa'))
  idx.settle(b)
  const issuers = []
  const res = idx.search(['ana'], yes, (issuer) => { issuers.push(issuer); return true })
  t.is(res.members.length, 2)
  t.ok(issuers.every((i) => i === ISSUER))
  for (const unusable of [() => false, () => 'yes', () => { throw new Error('x') }]) {
    t.alike(idx.search(['ana'], yes, unusable), {
      members: [{ author: b, profileSeq: 1, usernameSeq: null }],
      more: false
    })
  }
})

test('visible: false or throwing hides', (t) => {
  const idx = createNameIndex()
  const a = hex(1)
  const b = hex(2)
  const c = hex(3)
  idx.note(a, 1, profile('Ana'))
  idx.note(b, 1, profile('Ana'))
  idx.note(c, 1, profile('Ana'))
  const visible = (author) => {
    if (author === a) return true
    if (author === b) return 1
    throw new Error('x')
  }
  t.alike(idx.search(['ana'], visible, yes), { members: [{ author: a, profileSeq: 1, usernameSeq: null }], more: false })
  t.alike(idx.search(['ana'], () => false, yes), { members: [], more: false })
})

test('21 same-rank matches: the 20 lowest authors, more true', (t) => {
  const idx = createNameIndex()
  const order = []
  for (let i = 21; i >= 1; i--) {
    idx.note(hex(i), 1, profile('Ana ' + i))
    order.push(hex(i))
  }
  const res = idx.search(['ana'], ...ALL)
  t.is(res.members.length, 20)
  t.ok(res.more)
  t.alike(res.members.map((m) => m.author), order.slice().sort().slice(0, 20))
  // Exactly 20: more false. A hidden 21st does not set more.
  t.is(idx.search(['ana'], (a) => a !== hex(21), yes).more, false)
  t.is(idx.search(['ana'], (a) => a !== hex(1), yes).more, false)
  idx.remove(hex(21))
  t.is(idx.search(['ana'], ...ALL).more, false)
})

test('exact-username author with a high hex is kept over name-only matches', (t) => {
  const idx = createNameIndex({ verifyUsername: yes })
  for (let i = 1; i <= 30; i++) idx.note(hex(i), 1, profile('Ana Silva'))
  const high = 'f'.repeat(64)
  idx.note(high, 3, username(high, 'ana_silva'))
  idx.settle(high)
  const prefix = 'e'.repeat(64)
  idx.note(prefix, 3, username(prefix, 'anasilvax'))
  idx.settle(prefix)
  const res = idx.search(['ana', 'silva'], ...ALL)
  t.is(res.members.length, 20)
  t.ok(res.more)
  t.alike(res.members[0], { author: high, profileSeq: null, usernameSeq: 3 })
  t.alike(res.members[1], { author: prefix, profileSeq: null, usernameSeq: 3 })
  t.alike(res.members.slice(2).map((m) => m.author), Array.from({ length: 18 }, (_, i) => hex(i + 1)))
})

test('cap: maxAuthors 0 refuses, existing authors update at the cap', (t) => {
  const zero = createNameIndex({ maxAuthors: 0, verifyUsername: yes })
  t.is(zero.note(hex(1), 1, profile('Ana')), false)
  t.is(zero.note(hex(1), 2, username(hex(1), 'ana_b')), false)
  t.is(zero.stats().authors, 0)
  // Ignored input is not a refusal.
  t.is(zero.note(hex(1), 1, { type: 'post', text: 'hi' }), true)
  t.is(zero.note(hex(1), 3, username(hex(2), 'ana_b')), true)
  t.is(zero.note('nope', 1, profile('Ana')), true)
  t.is(zero.stats().authors, 0)
  t.alike(zero.search(['ana'], ...ALL), { members: [], more: false })

  const two = createNameIndex({ maxAuthors: 2, verifyUsername: yes })
  t.ok(two.note(hex(1), 1, profile('Ana')))
  t.ok(two.note(hex(2), 1, profile('Bia')))
  t.is(two.note(hex(3), 1, profile('Cai')), false)
  t.ok(two.note(hex(1), 2, profile('Duda')))
  t.ok(two.note(hex(2), 2, username(hex(2), 'bia_b')))
  two.settle(hex(2))
  t.alike(two.stats(), { authors: 2, maxAuthors: 2 })
  t.alike(two.search(['duda'], ...ALL).members, [{ author: hex(1), profileSeq: 2, usernameSeq: null }])
  t.alike(two.search(['bia', 'b'], ...ALL).members, [{ author: hex(2), profileSeq: 1, usernameSeq: 2 }])
  t.alike(two.search(['cai'], ...ALL).members, [])
})

test('remove and clear', (t) => {
  const idx = createNameIndex()
  idx.note(hex(1), 1, profile('Ana'))
  idx.note(hex(2), 1, profile('Ana'))
  t.is(idx.remove(hex(1)), true)
  t.is(idx.remove(hex(1)), false)
  t.is(idx.remove(null), false)
  t.is(idx.stats().authors, 1)
  t.alike(idx.search(['ana'], ...ALL).members.map((m) => m.author), [hex(2)])
  idx.clear()
  t.is(idx.stats().authors, 0)
  t.alike(idx.search(['ana'], ...ALL), { members: [], more: false })
})

test('ignored input and totality', (t) => {
  const idx = createNameIndex({ verifyUsername: yes })
  const a = hex(1)
  const huge = 'x'.repeat(1e6)
  const hostile = {}
  Object.defineProperty(hostile, 'type', { get () { throw new Error('x') }, enumerable: true })
  const proxy = new Proxy({}, { getPrototypeOf () { throw new Error('x') } })
  const bad = [null, undefined, [], [1], 'x', 5, huge, {}, hostile, proxy, Object.create({ type: 'profile', name: 'Ana' })]
  for (const v of bad) {
    t.is(idx.note(v, 1, profile('Ana')), true)
    t.is(idx.note(a, v, profile('Ana')), true)
    t.is(idx.note(a, 1, v), true)
    t.is(idx.note(a, 1, profile(v)), true)
    t.is(idx.note(a, 1, username(a, v)), true)
    t.execution(() => idx.settle(v))
    t.is(idx.remove(v), false)
    t.is(idx.search(v, yes, yes), null)
    t.is(idx.search(['ana'], v, yes), null)
    t.is(idx.search(['ana'], yes, v), null)
  }
  t.is(idx.stats().authors, 1) // only profile('x') was a valid record
  idx.clear()
  for (const seq of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) t.is(idx.note(a, seq, profile('Ana')), true)
  t.is(idx.note(hex(0xabc).toUpperCase(), 1, profile('Ana')), true)
  t.is(idx.stats().authors, 0)
  t.is(idx.search(['a'], ...ALL), null)
  t.is(idx.search(['ANA'], ...ALL), null)
  t.is(idx.search(['a', 'b', 'c', 'd', 'e'], ...ALL), null)
  t.is(idx.search([], ...ALL), null)
  t.is(idx.search(huge, ...ALL), null)
  t.execution(() => idx.clear())
  t.execution(() => idx.stats())
})

test('search over 4096 entries under 50 ms', (t) => {
  const idx = createNameIndex({ verifyUsername: yes })
  for (let i = 1; i <= 4096; i++) {
    const a = hex(i)
    idx.note(a, 1, profile('Ana Maria da Silva Santos ' + i))
    idx.note(a, 2, username(a, 'ana_' + i))
    idx.settle(a)
  }
  t.is(idx.stats().authors, 4096)
  idx.search(['ana'], ...ALL) // warm up
  const start = process.hrtime.bigint()
  const res = idx.search(['ana', 'silva'], ...ALL)
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  t.is(res.members.length, 20)
  t.ok(res.more)
  t.ok(ms < 50, ms.toFixed(2) + ' ms')
})

test('forget clears only the current profile and permits an older name to be noted', (t) => {
  const a = hex(1)
  const verify = counter(true)
  const idx = createNameIndex({ maxAuthors: 1, verifyUsername: verify })
  idx.note(a, 1, profile('Ana'))
  idx.note(a, 2, username(a, 'bia_costa'))
  idx.settle(a)
  idx.note(a, 3, profile('Cai'))
  t.is(idx.forget(a, 4), false)
  t.is(idx.forget(a, 2), false)
  t.ok(idx.forget(a, 3))
  t.is(idx.forget(a, 3), false)
  t.alike(idx.search(['cai'], ...ALL), { members: [], more: false })
  t.alike(idx.search(['bia', 'costa'], ...ALL).members, [{ author: a, profileSeq: null, usernameSeq: 2 }])
  idx.note(a, 1, profile('Ana'))
  idx.note(a, 1, username(a, 'zed_one'))
  idx.settle(a)
  t.is(verify.calls.length, 1, 'username watermark survives profile removal')
  t.alike(idx.search(['ana'], ...ALL).members, [{ author: a, profileSeq: 1, usernameSeq: 2 }])
  t.alike(idx.search(['zed'], ...ALL).members, [])
  t.alike(idx.stats(), { authors: 1, maxAuthors: 1 })
  for (const value of [null, undefined, {}, 0, -1, 1.5, NaN, '1', Infinity]) {
    t.is(idx.forget(a, value), false)
    t.is(idx.forget(value, 1), false)
  }
  t.is(idx.forget(hex(2), 1), false)
})

test('forget preserves a pending username candidate', (t) => {
  const a = hex(1)
  const idx = createNameIndex({ verifyUsername: yes })
  idx.note(a, 1, profile('Ana'))
  idx.note(a, 2, username(a, 'bia_costa'))
  t.ok(idx.forget(a, 1))
  idx.settle(a)
  t.alike(idx.search(['bia', 'costa'], ...ALL).members, [{ author: a, profileSeq: null, usernameSeq: 2 }])
  t.is(idx.forget(a, null), false)
})

test('forget tombstones that profile seq so a rescan cannot restore it', (t) => {
  const a = hex(1)
  function build () {
    const idx = createNameIndex()
    idx.note(a, 2, profile('Nova'))
    idx.note(a, 5, profile('Apagada'))
    t.ok(idx.forget(a, 5))
    return idx
  }
  // Rescan of the forgotten seq before the older survivor is noted again.
  const rescanFirst = build()
  t.ok(rescanFirst.note(a, 5, profile('Apagada')))
  t.alike(rescanFirst.search(['apagada'], ...ALL), { members: [], more: false })
  t.ok(rescanFirst.note(a, 2, profile('Nova')))
  t.alike(rescanFirst.search(['nova'], ...ALL).members, [{ author: a, profileSeq: 2, usernameSeq: null }])
  t.ok(rescanFirst.note(a, 5, profile('Apagada')))
  t.alike(rescanFirst.search(['nova'], ...ALL).members, [{ author: a, profileSeq: 2, usernameSeq: null }])
  t.alike(rescanFirst.search(['apagada'], ...ALL).members, [])

  // Older survivor first: the forgotten seq must not replace it.
  const olderFirst = build()
  t.ok(olderFirst.note(a, 2, profile('Nova')))
  t.alike(olderFirst.search(['nova'], ...ALL).members, [{ author: a, profileSeq: 2, usernameSeq: null }])
  t.ok(olderFirst.note(a, 5, profile('Apagada')))
  t.alike(olderFirst.search(['apagada'], ...ALL).members, [])
  t.alike(olderFirst.search(['nova'], ...ALL).members, [{ author: a, profileSeq: 2, usernameSeq: null }])
})

test('forget tombstones a non-current profile seq too', (t) => {
  const a = hex(1)
  const idx = createNameIndex()
  idx.note(a, 1, profile('Velha'))
  idx.note(a, 2, profile('Nova'))
  t.is(idx.forget(a, 1), false)
  t.ok(idx.forget(a, 2))
  t.ok(idx.note(a, 1, profile('Velha')))
  t.alike(idx.search(['velha'], ...ALL), { members: [], more: false })
  t.alike(idx.search(['nova'], ...ALL), { members: [], more: false })

  // An author the full index never noted: the tombstone takes no entry slot.
  const b = hex(2)
  const full = createNameIndex({ maxAuthors: 1 })
  full.note(a, 1, profile('Ana'))
  t.is(full.forget(b, 3), false)
  t.alike(full.stats(), { authors: 1, maxAuthors: 1 })
  t.ok(full.remove(a))
  t.ok(full.note(b, 3, profile('Bia')))
  t.alike(full.search(['bia'], ...ALL), { members: [], more: false })
})

test('replaying a forgotten profile seq never takes an author slot', (t) => {
  const a = hex(1)
  const b = hex(2)
  const idx = createNameIndex({ maxAuthors: 1 })
  t.is(idx.forget(a, 1), false)
  t.ok(idx.note(a, 1, profile('Apagada')))
  t.alike(idx.stats(), { authors: 0, maxAuthors: 1 })
  t.ok(idx.note(b, 2, profile('Bia')))
  t.is(idx.search(['bia'], ...ALL).members.length, 1)
  t.ok(idx.note(a, 1, profile('Apagada')), 'a full index still answers true for the forgotten seq')
})
