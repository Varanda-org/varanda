'use strict'

// The account search helpers (src/search.js). ES module loaded through
// import(); the search text part is pinned to @varanda/core
// lib/search-text.js by parity on a locked corpus plus seeded random input.
const test = require('brittle')
const core = require('@varanda/core/lib/search-text')

const load = () => import('../src/search.js')
const OWN = 'aa'.repeat(32)
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const D = '12'.repeat(32)

const CONSTANTS = ['TOKEN_MAX', 'NAME_TOKENS_MAX', 'QUERY_TOKENS_MAX', 'QUERY_MIN_CHARS', 'RESULTS_MAX', 'INPUT_MAX']
const TEXT_FNS = ['isValidUsername', 'splitTokens', 'foldTokens', 'queryTokens', 'queryPath', 'parseQuery', 'isQueryTokens']

const CORPUS = [
  'João da Silva',
  'São Paulo',
  'Straße',
  'ＪＯＡＯ',
  'Ma​ria',
  '​',
  'Łukasz Øster',
  'Ana 🌻 Lima 👩🏽‍💻',
  'Á'.repeat(200),
  '@a_b',
  '@ana_ana',
  'ana_ana',
  'abc123',
  'a1b2c3',
  'joao-silva',
  'joao--silva',
  'a-b-c-d-e',
  'a'.repeat(21),
  '',
  ' ',
  'x',
  String.fromCharCode(0xd800),
  'ab' + String.fromCharCode(0xd83d),
  null,
  undefined,
  42,
  {},
  [],
  ['ab'],
  true
]

// mulberry32: a small seeded PRNG so the random corpus is the same every run.
function prng (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOLS = [
  [0x20, 0x7e], // ASCII
  [0xa0, 0xff], // Latin-1
  [0x100, 0x17f], // Latin Extended-A
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0xff01, 0xff5e], // fullwidth
  [0x0300, 0x036f], // combining marks
  [0x200b, 0x200f], // invisibles
  [0xfe00, 0xfe0f], // variation selectors
  [0x40, 0x40], // '@'
  [0x5f, 0x5f], // '_'
  [0x2d, 0x2d], // '-'
  [0x1f300, 0x1f64f], // emoji
  [0x4e00, 0x4fff] // CJK
]

function randomString (rnd, maxLen) {
  const len = Math.floor(rnd() * maxLen)
  let s = ''
  for (let i = 0; i < len; i++) {
    const [lo, hi] = POOLS[Math.floor(rnd() * POOLS.length)]
    s += String.fromCodePoint(lo + Math.floor(rnd() * (hi - lo + 1)))
  }
  return s
}

function randomCorpus (seed, count, maxLen) {
  const rnd = prng(seed)
  const out = []
  for (let i = 0; i < count; i++) out.push(randomString(rnd, maxLen))
  return out
}

const USERNAMES = ['ana_ana', 'ana', 'joao_silva', 'joaosilva', 'joaosilva99', 'abcdef', 'abc123', 'a_b', '_ana', 'Ana_ana', 'an', 'ana-ana', 'a'.repeat(21), '', null, 42]

test('constants and QUERY_RE match the core copy', async (t) => {
  const m = await load()
  for (const k of CONSTANTS) t.is(m[k], core[k], k)
  t.is(m.QUERY_RE.source, core.QUERY_RE.source)
  t.is(m.QUERY_RE.flags, core.QUERY_RE.flags)
  for (const k of Object.keys(core)) t.ok(k in m, 'exports ' + k)
})

test('text helpers match the core copy on the locked corpus', async (t) => {
  const m = await load()
  for (const fn of TEXT_FNS) {
    for (const input of CORPUS) {
      t.alike(m[fn](input), core[fn](input), fn + ' ' + JSON.stringify(input))
    }
  }
  t.alike(m.foldTokens('João da Silva'), ['joao', 'da', 'silva'])
  t.alike(m.foldTokens('Straße'), ['strasse'])
  t.alike(m.foldTokens('ＪＯＡＯ'), ['joao'])
  t.alike(m.foldTokens('Ma​ria'), ['maria'])
  t.alike(m.foldTokens('Łukasz Øster'), ['lukasz', 'oster'])
  t.is(m.queryPath('@João Silva'), 'joao-silva')
})

test('text helpers match the core copy on seeded random strings', async (t) => {
  const m = await load()
  const inputs = randomCorpus(0x5eed, 2500, 40)
  let mismatches = 0
  for (const fn of TEXT_FNS) {
    for (const input of inputs) {
      const a = JSON.stringify(m[fn](input))
      const b = JSON.stringify(core[fn](input))
      if (a !== b) {
        mismatches++
        if (mismatches <= 5) t.fail(fn + ' ' + JSON.stringify(input) + ': ' + a + ' vs ' + b)
      }
    }
    // Segments built from query paths reach the parseQuery accept branch.
    for (const input of inputs) {
      const seg = core.queryPath(input)
      if (seg === null) continue
      if (JSON.stringify(m.parseQuery(seg)) !== JSON.stringify(core.parseQuery(seg))) mismatches++
    }
  }
  t.is(mismatches, 0)
})

test('searchRank matches the core copy on generated triples', async (t) => {
  const m = await load()
  const rnd = prng(0xbeef)
  const words = randomCorpus(0xcafe, 400, 12).concat(['ana', 'ana ana', 'joao silva', 'jo', 'silva', 'a b', 'ana_ana'])
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  let mismatches = 0
  let ranked = 0
  for (let i = 0; i < 2500; i++) {
    const q = rnd() < 0.1 ? pick([null, [], ['a'], ['A'], ['ab', 'x'.repeat(21)], 'ana']) : core.queryTokens(pick(words))
    const nameTokens = rnd() < 0.05 ? pick([null, 'ana', [1, 'ana']]) : core.foldTokens(pick(words))
    const username = rnd() < 0.5 ? pick(USERNAMES) : pick(words)
    const a = m.searchRank(q, nameTokens, username)
    const b = core.searchRank(q, nameTokens, username)
    if (a !== b) {
      mismatches++
      if (mismatches <= 5) t.fail(JSON.stringify([q, nameTokens, username]) + ': ' + a + ' vs ' + b)
    }
    if (b >= 0) ranked++
  }
  t.is(mismatches, 0)
  t.ok(ranked > 0, 'some triples match')
  for (const [q, n, u, want] of [
    [['ana', 'ana'], [], 'ana_ana', 0],
    [['anaana'], [], 'ana_ana', 1],
    [['ana'], [], 'ana_ana', 2],
    [['silva'], ['joao', 'silva'], null, 3],
    [['x'], ['joao'], 'ana_ana', -1]
  ]) {
    t.is(m.searchRank(q, n, u), want)
    t.is(core.searchRank(q, n, u), want)
  }
})

test('planSearchPeeks builds diary.peek params without null hints', async (t) => {
  const { planSearchPeeks } = await load()
  const plan = planSearchPeeks([
    { rank: 3, author: A, profileSeq: 7, usernameSeq: null },
    { rank: 3, author: B, profileSeq: null, usernameSeq: null },
    { rank: 0, author: OWN, profileSeq: 2, usernameSeq: 3 },
    { rank: 1, author: C, profileSeq: 5, usernameSeq: 5 },
    { rank: 2, author: 'zz'.repeat(32), profileSeq: 1 },
    { rank: 2, author: A.toUpperCase(), profileSeq: 1 },
    { rank: 2, author: D, profileSeq: 9, usernameSeq: 4 },
    { rank: 2, author: B, profileSeq: 0, usernameSeq: 1.5 },
    null,
    'x'
  ], OWN.toUpperCase())
  t.alike(plan, [
    { author: A, seqs: [7], profileSeq: 7 },
    { author: C, seqs: [5], profileSeq: 5, usernameSeq: 5 },
    { author: D, seqs: [4, 9], profileSeq: 9, usernameSeq: 4 }
  ])
  t.absent(Object.prototype.hasOwnProperty.call(plan[0], 'usernameSeq'), 'null hint omitted')
  t.alike(planSearchPeeks([{ author: A, usernameSeq: 3 }]), [{ author: A, seqs: [3], usernameSeq: 3 }])
  t.alike(planSearchPeeks(null), [])
  t.alike(planSearchPeeks('x', OWN), [])
})

const AV = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: 'ef'.repeat(32), width: 512, height: 512 }

function peekOf (key, name, username, extra = {}) {
  return { key, entries: [], profile: name === undefined ? null : { name, bio: 'ana_ana' }, username, ...extra }
}

test('confirmedHits keeps only matches confirmed by the peek', async (t) => {
  const { confirmedHits } = await load()
  const members = [
    { author: C, profileSeq: 1 },
    { author: OWN, profileSeq: 1 },
    { author: A, profileSeq: 1 },
    { author: B, profileSeq: 1 },
    { author: D, profileSeq: 1 },
    { author: '12'.repeat(31) + 'ff', profileSeq: 1 }
  ]
  const peeked = new Map([
    [C, peekOf(C, 'Ana Lima', null)],
    [OWN, peekOf(OWN, 'Ana Own', 'ana_own')],
    [A, peekOf(A, 'Bruno', 'bruno_x')], // name and @nome do not match
    [B, peekOf(A, 'Ana', 'ana_b')], // keyed to another author
    [D, peekOf(D, 'Zeca', 'ana_zeca')]
    // the last member has no peek
  ])
  const r = confirmedHits(['ana'], members, peeked, OWN)
  // D (verified @nome prefix, rank 2) before C (name only, rank 3).
  t.alike(r.hits, [
    { author: D, name: 'Zeca', username: 'ana_zeca', avatar: null },
    { author: C, name: 'Ana Lima', username: null, avatar: null }
  ])
  t.is(r.dropped, 1)
  t.is(r.unconfirmed, 2)
})

test('confirmedHits orders by the verified rank, seeder order breaking ties', async (t) => {
  const { confirmedHits } = await load()
  // A lying seeder lists two name-only look-alikes before the real @alice.
  const members = [{ author: A, profileSeq: 1 }, { author: B, profileSeq: 1 }, { author: C, usernameSeq: 2 }]
  const peeked = new Map([
    [A, peekOf(A, 'alice', null)],
    [B, peekOf(B, '@alice', null)],
    [C, peekOf(C, 'Maria', 'alice')]
  ])
  const r = confirmedHits(['alice'], members, peeked, OWN)
  t.alike(r.hits.map((h) => h.author), [C, A, B])
})

test('searchRank with precomputed @nome tokens equals folding them', async (t) => {
  const { searchRank, foldTokens } = await load()
  for (const u of USERNAMES) {
    for (const q of [['ana'], ['ana', 'ana'], ['joao', 'silva'], ['a', 'b'], ['abc']]) {
      const pre = typeof u === 'string' ? foldTokens(u) : null
      t.is(searchRank(q, ['ana', 'lima'], u, pre), searchRank(q, ['ana', 'lima'], u), JSON.stringify([q, u]))
      t.is(core.searchRank(q, ['ana', 'lima'], u, pre), core.searchRank(q, ['ana', 'lima'], u))
    }
  }
})

test('confirmedHits reads only profile.name and a valid username', async (t) => {
  const { confirmedHits } = await load()
  const members = [{ author: A }, { author: B }, { author: C }, { author: D }]
  const peeked = new Map([
    [A, peekOf(A, undefined, 'ana_a', { entries: [{ seq: 1, record: { type: 'post', text: 'ana' } }] })],
    [B, peekOf(B, 'Bea', 'abcdef')], // hex6 username is invalid; bio says ana
    [C, { key: C, profile: { name: 42 }, username: 'Ana_c' }],
    [D, ['not', 'plain']]
  ])
  const r = confirmedHits(['ana'], members, peeked)
  t.alike(r.hits, [{ author: A, name: null, username: 'ana_a', avatar: null }])
  t.is(r.dropped, 2)
  t.is(r.unconfirmed, 1)
})

test('a display name @ana without a verified @nome is only a name match', async (t) => {
  const { confirmedHits, queryTokens } = await load()
  const peeked = new Map([[A, peekOf(A, '@ana', null)], [B, peekOf(B, '@ana', 'not valid!')]])
  const r = confirmedHits(queryTokens('@ana'), [{ author: A }, { author: B }], peeked, OWN)
  t.alike(r.hits, [
    { author: A, name: '@ana', username: null, avatar: null },
    { author: B, name: '@ana', username: null, avatar: null }
  ])
  t.is(r.dropped, 0)
  t.is(r.unconfirmed, 0)
})

test('confirmedHits copies a valid peeked avatar, an invalid one gives null', async (t) => {
  const { confirmedHits } = await load()
  const members = [{ author: A }, { author: B }, { author: C }]
  const peeked = new Map([
    [A, { key: A, profile: { name: 'Ana A', bio: '', avatar: AV }, username: null }],
    [B, { key: B, profile: { name: 'Ana B', bio: '', avatar: { ...AV, extra: 1 } }, username: null }],
    [C, { key: C, profile: { name: 'Ana C', bio: '', avatar: { ...AV, blocks: 9 } }, username: null }]
  ])
  const r = confirmedHits(['ana'], members, peeked, OWN)
  t.alike(r.hits.map((h) => h.avatar), [AV, null, null])
  t.not(r.hits[0].avatar, AV, 'a copy, never the peer object')
})

test('confirmedHits with a non-Map peek set or bad tokens confirms nothing', async (t) => {
  const { confirmedHits } = await load()
  const members = [{ author: A }, { author: OWN }, { author: B }]
  const obj = { [A]: peekOf(A, 'Ana', null) }
  t.alike(confirmedHits(['ana'], members, obj, OWN), { hits: [], dropped: 0, unconfirmed: 2 })
  t.alike(confirmedHits(['a'], members, new Map(), OWN), { hits: [], dropped: 0, unconfirmed: 2 })
  t.alike(confirmedHits(null, members, new Map(), OWN), { hits: [], dropped: 0, unconfirmed: 2 })
  t.alike(confirmedHits(['ana'], null, new Map(), OWN), { hits: [], dropped: 0, unconfirmed: 0 })
  const evil = new Map()
  evil.get = () => { throw new Error('boom') }
  t.alike(confirmedHits(['ana'], members, evil, OWN), { hits: [], dropped: 0, unconfirmed: 0 })
})
