'use strict'

// lib/search-text.js: the locked folding examples, marks and invisibles
// dropped without splitting, truncation and caps, dedupe (foldTokens) versus
// none (queryTokens), the query path round trip, the route grammar, the
// rank tiers, and that the module never requires anything (the app keeps a
// verbatim copy).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const {
  TOKEN_MAX,
  NAME_TOKENS_MAX,
  QUERY_TOKENS_MAX,
  QUERY_MIN_CHARS,
  RESULTS_MAX,
  INPUT_MAX,
  QUERY_RE,
  isValidUsername,
  splitTokens,
  foldTokens,
  queryTokens,
  queryPath,
  parseQuery,
  isQueryTokens,
  searchRank
} = require('../lib/search-text')

// Invisible or combining characters, spelled by code point.
const TILDE = String.fromCodePoint(0x0303)
const ZWSP = String.fromCodePoint(0x200b)
const NBSP = String.fromCodePoint(0x00a0)
const IDEO_SPACE = String.fromCodePoint(0x3000)

test('constants', (t) => {
  t.is(TOKEN_MAX, 20)
  t.is(NAME_TOKENS_MAX, 16)
  t.is(QUERY_TOKENS_MAX, 4)
  t.is(QUERY_MIN_CHARS, 2)
  t.is(RESULTS_MAX, 20)
  t.is(INPUT_MAX, 80)
  t.is(QUERY_RE.source, '^[a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3}$')
})

test('foldTokens: locked examples', (t) => {
  t.alike(foldTokens('João da Silva'), ['joao', 'da', 'silva'])
  t.alike(foldTokens('São Paulo'), ['sao', 'paulo'])
  t.alike(foldTokens('Joa' + TILDE + 'o'), ['joao'])
  t.alike(foldTokens('@ana_b'), ['ana', 'b'])
  t.alike(foldTokens('MARÍA maria'), ['maria'])
  t.alike(foldTokens('Straße'), ['strasse'])
  t.alike(foldTokens('ＪＯＡＯ'), ['joao'])
  t.alike(foldTokens('Ma' + ZWSP + 'ria'), ['maria'])
  t.alike(foldTokens('Łukasz Øster'), ['lukasz', 'oster'])
  t.alike(foldTokens('\u{1F600}'), [])
  t.alike(foldTokens('Á'.repeat(200)), ['a'.repeat(20)])
  for (const bad of [null, undefined, 1, {}, [], true]) t.alike(foldTokens(bad), [])
})

test('frozen fold table', (t) => {
  t.alike(splitTokens('ß ẞ æ Æ œ Œ ø Ø ł Ł đ Đ ð Ð þ Þ ı ħ Ħ ŧ Ŧ ŋ Ŋ ĸ'),
    ['ss', 'ss', 'ae', 'ae', 'oe', 'oe', 'o', 'o', 'l', 'l', 'd', 'd', 'd', 'd',
      'th', 'th', 'i', 'h', 'h', 't', 't', 'n', 'n', 'k'])
})

test('marks and invisibles are dropped without splitting', (t) => {
  const drops = [0x0301, 0x1ab0, 0x1dc0, 0x20d0, 0xfe20, 0x00ad, 0x034f, 0x061c,
    0x115f, 0x17b4, 0x180b, 0x200b, 0x200d, 0x202a, 0x2060, 0x3164, 0xfe0f,
    0xfeff, 0xffa0, 0xfff0, 0x1bca0, 0x1d173, 0xe0001, 0xe0fff]
  for (const cp of drops) {
    t.alike(splitTokens('ab' + String.fromCodePoint(cp) + 'cd'), ['abcd'], cp.toString(16))
  }
  for (const sep of [' ', '_', '.', '-', '@', NBSP, IDEO_SPACE, '\u{1F600}', '中', 'й']) {
    t.alike(splitTokens('ab' + sep + 'cd'), ['ab', 'cd'], JSON.stringify(sep))
  }
})

test('truncation and caps', (t) => {
  t.alike(splitTokens('x'.repeat(30)), ['x'.repeat(20)])
  // 160 UTF-16 units, then 80 code points.
  const many = Array.from({ length: 40 }, (_, i) => 'a' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26))).join(' ')
  const split = splitTokens(many)
  t.is(split.length, 20) // 80 code points = 20 'abc ' groups
  t.is(foldTokens(many).length, 16)
  t.is(splitTokens('ab'.repeat(500)).length, 1)
  t.is(splitTokens('ab'.repeat(500))[0].length, 20)
  // A trailing lone high surrogate from the 160-unit cut is dropped.
  t.alike(splitTokens('a'.repeat(159) + '\u{1F600}'), ['a'.repeat(20)])
  t.alike(splitTokens('ab\ud800'), ['ab'])
  t.alike(splitTokens('ab\udc00cd'), ['ab', 'cd'])
})

test('foldTokens dedupes, queryTokens does not', (t) => {
  t.alike(foldTokens('ana ana bia ana'), ['ana', 'bia'])
  t.alike(queryTokens('ana ana bia ana'), ['ana', 'ana', 'bia', 'ana'])
  t.alike(queryTokens('a b c d e f'), ['a', 'b', 'c', 'd'])
  t.alike(queryTokens(null), [])
})

test('queryPath: examples', (t) => {
  t.is(queryPath('@João Silva'), 'joao-silva')
  t.is(queryPath('a silva'), 'a-silva')
  t.is(queryPath('ab'), 'ab')
  t.is(queryPath('@a_b'), 'a-b')
  t.is(queryPath('@ana_ana'), 'ana-ana')
  for (const none of ['', '@', 'a', '@a__', null, 5, '\u{1F600}']) t.is(queryPath(none), null)
  t.is(queryPath('one two three four five'), 'one-two-three-four')
})

test('queryPath and parseQuery round trip over a corpus', (t) => {
  const corpus = ['João da Silva', 'São Paulo', '@ana_b', 'MARÍA maria', 'Straße',
    'ＪＯＡＯ', 'Łukasz Øster', 'x'.repeat(200), 'Á'.repeat(200), 'a b c d e f g',
    '@ana_ana', 'Ma' + ZWSP + 'ria', 'a', 'ab', '1 2', 'Zoë 99', '\u{1F600} ok', '___',
    'ﬀ ligature', 'Ⅻ', '①②', 'ǅemal']
  for (const text of corpus) {
    const p = queryPath(text)
    if (p === null) continue
    t.ok(QUERY_RE.test(p), JSON.stringify(text))
    t.alike(parseQuery(p), queryTokens(text), JSON.stringify(text))
  }
})

test('parseQuery: grammar', (t) => {
  for (const bad of ['', 'a', 'A', 'ab_cd', '-ab', 'ab-', 'ab--cd', 'a-b-c-d-e',
    'x'.repeat(21), '%61b', null, undefined, 1, ['ab'], {}]) {
    t.is(parseQuery(bad), null, JSON.stringify(bad))
  }
  t.alike(parseQuery('a-b'), ['a', 'b'])
  t.alike(parseQuery('ana-ana'), ['ana', 'ana'])
  t.alike(parseQuery('joao-silva'), ['joao', 'silva'])
  t.alike(parseQuery('x'.repeat(20)), ['x'.repeat(20)])
})

test('isQueryTokens', (t) => {
  t.ok(isQueryTokens(['ab']))
  t.ok(isQueryTokens(['a', 'b']))
  t.absent(isQueryTokens(['a']))
  t.absent(isQueryTokens([]))
  t.absent(isQueryTokens(['a', 'b', 'c', 'd', 'e']))
  t.absent(isQueryTokens(['AB']))
  t.absent(isQueryTokens(['a_b']))
  t.absent(isQueryTokens([1, 2]))
  t.absent(isQueryTokens('ab'))
  t.absent(isQueryTokens(null))
})

test('isValidUsername', (t) => {
  t.ok(isValidUsername('ana'))
  t.ok(isValidUsername('a_b'))
  t.ok(isValidUsername('ana_silva'))
  t.absent(isValidUsername('ab'))
  t.absent(isValidUsername('Ana'))
  t.absent(isValidUsername('1ana'))
  t.absent(isValidUsername('abcdef'))
  t.absent(isValidUsername('a'.repeat(21)))
  t.absent(isValidUsername(null))
})

test('searchRank: tiers', (t) => {
  t.is(searchRank(['ana', 'silva'], [], 'ana_silva'), 0)
  t.is(searchRank(['ana', 'silva'], [], 'anasilva'), 1)
  t.is(searchRank(['ana', 'silva'], [], 'anasilvax'), 2)
  t.is(searchRank(['ana', 'silva'], foldTokens('Ana Silva'), null), 3)
  t.is(searchRank(['ana'], foldTokens('@ana'), null), 3)
  t.is(searchRank(['a', 'b'], [], 'a_b'), 0)
  // Username tokens reach rank 3 too.
  t.is(searchRank(['silva'], [], 'ana_silva'), 3)
  t.is(searchRank(['bia'], foldTokens('Ana Silva'), 'ana_silva'), -1)
  // An invalid username counts as none.
  t.is(searchRank(['ana', 'silva'], [], 'Ana_Silva'), -1)
  t.is(searchRank(['abcdef'], [], 'abcdef'), -1)
  // A display name alone never ranks above 3.
  t.is(searchRank(['anasilva'], foldTokens('anasilva'), null), 3)
})

test('searchRank: never throws', (t) => {
  t.is(searchRank(null, [], 'ana'), -1)
  t.is(searchRank(['ana'], null, 'ana'), -1)
  t.is(searchRank(['ana'], [null, 5, {}], null), -1)
  t.is(searchRank(['ana'], [], { startsWith () { throw new Error('x') } }), -1)
  const hostile = new Proxy([], { get () { throw new Error('x') } })
  t.is(searchRank(['ana'], hostile, null), -1)
  t.is(searchRank(hostile, [], null), -1)
})

test('module requires nothing', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'search-text.js'), 'utf8')
  t.absent(/\brequire\s*\(/.test(src))
  t.absent(/\\p\{/.test(src))
  t.absent(/Intl\./.test(src))
})
