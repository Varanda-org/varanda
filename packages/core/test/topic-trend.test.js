'use strict'

const { mock } = require('node:test')
const test = require('brittle')
const { BLOCKED_TERMS } = require('@varanda/rpc')
const {
  DEFAULT_MAX_POSTS,
  DEFAULT_PER_AUTHOR_MAX,
  DEFAULT_WINDOW_MS,
  TREND_MIN_AUTHORS,
  TREND_LIMIT,
  MAX_TAGS_PER_POST,
  MAX_TEXT_UNITS,
  hashtagsOf,
  createTopicTrend
} = require('../lib/topic-trend')

const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const K3 = '3'.repeat(64)
const K4 = '4'.repeat(64)
const K5 = '5'.repeat(64)
const NOW = Date.parse('2026-01-01T00:00:00.000Z')
const FUTURE = Date.parse('9999-01-01T00:00:00.000Z')
const post = (text, at = NOW) => ({ text, at: new Date(at).toISOString() })
const everyone = () => true
const oneAuthor = { min: 1 }
const empty = { posts: 0, authors: 0, saturated: false }

test('hashtagsOf: fold and validate the entire run from the app rule', (t) => {
  t.alike(hashtagsOf('#Feira'), ['feira'])
  t.alike(hashtagsOf('#Céu #Ce\u0301u #AÇÃO #Kelvin #Ångstrom'), ['ceu', 'acao', 'kelvin', 'angstrom'])
  t.alike(hashtagsOf('#a #' + 'b'.repeat(33) + ' #' + 'c'.repeat(32)), ['c'.repeat(32)])
  t.alike(hashtagsOf('#a#b #azul#mar ##sol palavra#lua'), ['azul'])
  t.alike(hashtagsOf('#2026 (#Dia2!), #sol_lua #mar🙂 #céu日本'), ['2026', 'dia2', 'sol', 'mar'])
  t.alike(hashtagsOf('feira de rua'), [])
  for (const value of [null, undefined, 12, Symbol('s'), Object('#Feira')]) {
    t.alike(hashtagsOf(value), [])
  }
})

test('hashtagsOf: exclude URL paths and fragments using the app boundaries', (t) => {
  t.alike(hashtagsOf('https://exemplo.com/#caminho https://exemplo.com/rota/#secao'), [])
  t.alike(hashtagsOf('www.exemplo.com?#secao exemplo.com/#secao /#secao'), [])
  t.alike(hashtagsOf('WWW.exemplo.com?#secao\u00a0#fora http://exemplo.com/ #sol'), ['fora', 'sol'])
  t.alike(hashtagsOf('exemplo.com?#secao'), ['secao'], 'the app rule requires a slash or www')
  t.alike(hashtagsOf('xwww.#ab'), ['ab'], 'the www rule needs a boundary before www')
})

test('hashtagsOf: distinct tags in first-use order, capped at ten', (t) => {
  const tags = Array.from({ length: 12 }, (_, i) => 'tag' + i)
  const text = '#Feira #fEIRA ' + tags.map((tag) => '#' + tag).join(' ')
  t.is(MAX_TAGS_PER_POST, 10)
  t.alike(hashtagsOf(text), ['feira', ...tags.slice(0, 9)])
})

test('observe and top: the window excludes its start and includes now', (t) => {
  const trend = createTopicTrend({ windowMs: 10 })
  t.is(trend.observe(K1, 0, post('#fora', NOW - 10), NOW), false)
  t.is(trend.observe(K1, 0, post('#inicio', NOW - 10), NOW - 1), true)
  t.is(trend.observe(K1, 1, post('#dentro', NOW - 9), NOW), true)
  t.is(trend.observe(K1, 2, post('#agora'), NOW), true)
  t.alike(trend.top(NOW, everyone, oneAuthor), [
    { tag: 'agora', authors: 1 },
    { tag: 'dentro', authors: 1 }
  ])
  t.is(trend.stats().posts, 3, 'a query leaves held posts alone')
})

test('observe: reject text above the UTF-16 limit without storing it', (t) => {
  const trend = createTopicTrend({ maxPosts: 1 })
  t.is(MAX_TEXT_UNITS, 4000)
  t.is(trend.observe(K1, 0, post('#ab,'.repeat(1001)), NOW), false)
  t.alike(trend.stats(), empty)
  const text = '#feira ' + '🙂'.repeat(1996)
  t.is(text.length, 3999)
  t.is(trend.observe(K1, 0, post(text), NOW), true)
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'feira', authors: 1 }])
})

test('observe: skip hashtag scans for expired or oversized text', (t) => {
  const trend = createTopicTrend({ windowMs: 10 })
  const expired = post('#antigo', NOW - 10)
  const oversized = post('#ab,'.repeat(1001))
  const indexOf = mock.method(String.prototype, 'indexOf')
  let expiredResult, oversizedResult
  try {
    expiredResult = trend.observe(K1, 0, expired, NOW)
    oversizedResult = trend.observe(K1, 1, oversized, NOW)
  } finally {
    indexOf.mock.restore()
  }
  t.is(expiredResult, false)
  t.is(oversizedResult, false)
  t.is(indexOf.mock.callCount(), 0)
})

test('observe: keep a far-future post until its date arrives', (t) => {
  const trend = createTopicTrend()
  t.is(trend.observe(K1, 0, post('#amanha', FUTURE), NOW), true)
  t.alike(trend.top(NOW, everyone, oneAuthor), [])
  t.alike(trend.top(FUTURE - 1, everyone, oneAuthor), [])
  t.alike(trend.top(FUTURE, everyone, oneAuthor), [{ tag: 'amanha', authors: 1 }])
  t.alike(trend.top(FUTURE + 1, everyone, oneAuthor), [{ tag: 'amanha', authors: 1 }])
  t.alike(trend.stats(), { posts: 1, authors: 1, saturated: false })
})

test('observe: idempotence by author and seq preserves the original post', (t) => {
  const trend = createTopicTrend({ maxPosts: 2, perAuthorMax: 1 })
  t.is(trend.observe(K1, 0, post('#feira'), NOW), true)
  t.is(trend.observe(K2, 0, post('#feira'), NOW), true)
  t.is(trend.observe(K1, 0, post('#troca', FUTURE), NOW), true)
  t.is(trend.observe(K1, 0, post('sem hashtag', 0), NOW), true)
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'feira', authors: 2 }])
  t.alike(trend.stats(), { posts: 2, authors: 2, saturated: false })
})

test('removePost and removeDiary update counts and free capacity', (t) => {
  const trend = createTopicTrend({ maxPosts: 3 })
  trend.observe(K1, 0, post('#feira'), NOW)
  trend.observe(K1, 1, post('#sol'), NOW)
  trend.observe(K2, 0, post('#sol'), NOW)
  t.is(trend.removePost(K1, 0), true)
  t.is(trend.removePost(K1, 0), false)
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'sol', authors: 2 }])
  t.alike(trend.stats(), { posts: 2, authors: 2, saturated: false })
  t.is(trend.observe(K2, 1, post('#mar'), NOW), true)
  t.is(trend.removeDiary(K2), true)
  t.is(trend.removeDiary(K2), false)
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'sol', authors: 1 }])
  t.alike(trend.stats(), { posts: 1, authors: 1, saturated: false })
  t.is(trend.removePost(K1, 1), true)
  t.alike(trend.stats(), empty)
  t.is(trend.observe(K1, 0, post('#feira'), NOW), true, 'previously removed pair can be observed again')
})

test('per-author cap prunes that diary first, then keeps the highest seqs', (t) => {
  const trend = createTopicTrend({ maxPosts: 3, perAuthorMax: 2, windowMs: 10 })
  trend.observe(K1, 10, post('#antigo', NOW - 10), NOW - 1)
  trend.observe(K2, 1, post('#velho', NOW - 10), NOW - 1)
  trend.observe(K1, 5, post('#recente'), NOW)
  t.is(trend.observe(K1, 2, post('#menor'), NOW), true, 'pruning admits a lower seq')
  t.is(trend.removePost(K1, 10), false)
  t.is(trend.observe(K1, 1, post('#recusado'), NOW), false)
  t.alike(trend.stats(), { posts: 3, authors: 2, saturated: false })
  t.is(trend.observe(K1, 6, post('#novo'), NOW), true)
  t.is(trend.removePost(K1, 2), false, 'the lowest seq was evicted')
  t.alike(trend.top(NOW, everyone, oneAuthor), [
    { tag: 'novo', authors: 1 },
    { tag: 'recente', authors: 1 }
  ])
  t.is(trend.removePost(K2, 1), true, 'the other diary was not pruned')
})

test('per-author cap ranks by log order within the one-day future tolerance', (t) => {
  const trend = createTopicTrend()
  t.is(DEFAULT_PER_AUTHOR_MAX, 50)
  t.is(trend.observe(K1, 0, post('#hoje'), NOW), true)
  const tomorrow = NOW + 86400000
  let seq = 1
  while (seq <= 50) {
    t.is(trend.observe(K1, seq, post('#futuro', tomorrow + 1 - seq), NOW), true)
    seq++
  }
  t.alike(trend.stats(), { posts: 50, authors: 1, saturated: false })
  t.alike(trend.top(NOW, everyone, oneAuthor), [], 'higher seqs already evicted the current post')
  t.is(trend.observe(K1, 0, post('#hoje'), NOW), false)
  t.is(trend.observe(K1, 51, post('#agora'), NOW), true)
  t.is(trend.removePost(K1, 1), false, 'lowest seq is evicted even though it has the latest date')
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'agora', authors: 1 }])
})

test('per-author cap prunes far-future posts before comparing seqs', (t) => {
  const trend = createTopicTrend({ perAuthorMax: 2 })
  t.is(trend.observe(K1, 1, post('#futuro', FUTURE), NOW), true)
  t.is(trend.observe(K1, 2, post('#futuro', FUTURE), NOW), true)
  t.is(trend.observe(K1, 0, post('#agora'), NOW), true)
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'agora', authors: 1 }])
})

test('global cap prunes all expired posts first and saturation stays sticky until clear', (t) => {
  const trend = createTopicTrend({ maxPosts: 3, windowMs: 10 })
  trend.observe(K1, 1, post('#antigo', NOW - 10), NOW - 1)
  trend.observe(K2, 1, post('#velho', NOW - 10), NOW - 1)
  trend.observe(K2, 2, post('#feira'), NOW)
  t.is(trend.observe(K1, 2, post('#feira'), NOW), true, 'reinsert the diary that was fully pruned')
  t.is(trend.removePost(K2, 1), false, 'also pruned the other diary')
  t.alike(trend.stats(), { posts: 2, authors: 2, saturated: false })
  t.is(trend.observe(K3, 1, post('#feira'), NOW), true)
  t.is(trend.observe(K4, 1, post('#feira'), NOW), false)
  t.alike(trend.stats(), { posts: 3, authors: 3, saturated: true })
  t.is(trend.removeDiary(K3), true)
  t.is(trend.observe(K4, 1, post('#feira'), NOW), true)
  t.alike(trend.stats(), { posts: 3, authors: 3, saturated: true })
  t.is(trend.clear(), undefined)
  t.alike(trend.stats(), empty)
  t.alike(trend.top(NOW, everyone, oneAuthor), [])
  t.is(trend.observe(K1, 1, post('#feira'), NOW), true)
})

test('global cap frees a far-future slot for an in-window post', (t) => {
  const trend = createTopicTrend({ maxPosts: 4 })
  for (const author of [K1, K2, K3, K4]) {
    t.is(trend.observe(author, 0, post('#futuro', FUTURE), NOW), true)
  }
  t.is(trend.observe(K5, 0, post('#agora'), NOW), true)
  t.alike(trend.stats(), { posts: 4, authors: 4, saturated: false })
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'agora', authors: 1 }])
  t.alike(trend.top(FUTURE, everyone, oneAuthor), [{ tag: 'futuro', authors: 3 }])
})

test('clear returns undefined when clearing the map throws', (t) => {
  const trend = createTopicTrend()
  const clear = mock.method(Map.prototype, 'clear', () => { throw new Error('clear failed') })
  let result
  try {
    result = trend.clear()
  } finally {
    clear.mock.restore()
  }
  t.is(result, undefined)
})

test('top: one vote per author, blocked terms, ordering, min and limit', (t) => {
  const trend = createTopicTrend()
  const blocked = BLOCKED_TERMS.find((term) => /^[a-z]{2,30}$/.test(term))
  t.ok(blocked)
  for (const author of [K1, K2, K3]) {
    const text = '#mar #azul #zeta #' + blocked + ' #' + blocked + '99'
    trend.observe(author, 0, post(author === K1 ? text + ' #raro' : text), NOW)
  }
  let seq = 1
  while (seq < 50) {
    trend.observe(K1, seq, post('#raro #zeta'), NOW)
    seq++
  }
  trend.observe(K4, 0, post('#zeta'), NOW)
  const expected = [
    { tag: 'zeta', authors: 4 },
    { tag: 'azul', authors: 3 },
    { tag: 'mar', authors: 3 }
  ]
  t.alike(trend.top(NOW, everyone), expected)
  t.alike(trend.top(NOW, everyone, { min: 4 }), expected.slice(0, 1))
  t.alike(trend.top(NOW, everyone, { min: 1, limit: 2 }), expected.slice(0, 2))
  t.alike(trend.top(NOW, everyone, oneAuthor), [...expected, { tag: 'raro', authors: 1 }])
})

test('top: a multi-word blocked term glued into one tag is dropped, exactly', (t) => {
  const trend = createTopicTrend()
  const glued = BLOCKED_TERMS.filter((term) => term.includes(' ')).map((term) => term.replace(/ /g, '')).find((tag) => /^[a-z0-9]{2,28}$/.test(tag))
  t.ok(glued, 'the list has a multi-word term that fits a tag')
  for (const author of [K1, K2, K3]) {
    trend.observe(author, 0, post('#' + glued + ' #' + glued + '2026 #7' + glued + ' #xy' + glued + 'z #sol'), NOW)
  }
  t.alike(trend.top(NOW, everyone).map((r) => r.tag).sort(), ['sol', 'xy' + glued + 'z'].sort(), 'only the longer word and the plain tag stay')
})

test('top: two authors qualify only when the minimum is lowered', (t) => {
  const trend = createTopicTrend()
  trend.observe(K1, 0, post('#feira'), NOW)
  trend.observe(K2, 0, post('#feira'), NOW)
  t.alike(trend.top(NOW, everyone), [])
  t.alike(trend.top(NOW, everyone, { min: 2 }), [{ tag: 'feira', authors: 2 }])
})

test('top: a throwing predicate hides only that author and must return true', (t) => {
  const trend = createTopicTrend()
  for (const author of [K1, K2, K3, K4]) {
    trend.observe(author, 1, post('#feira'), NOW)
    trend.observe(author, 2, post('#feira'), NOW)
  }
  const calls = []
  const visible = (author) => {
    calls.push(author)
    if (author === K1) throw new Error('hidden')
    if (author === K2) return 1
    return true
  }
  t.alike(trend.top(NOW, visible, oneAuthor), [{ tag: 'feira', authors: 2 }])
  t.alike(calls.sort(), [K1, K2, K3, K4])
})

test('top: a predicate that re-adds an author is still called once per author', (t) => {
  const trend = createTopicTrend()
  trend.observe(K1, 0, post('#feira'), NOW)
  let calls = 0
  const visible = (author) => {
    if (++calls === 1) {
      trend.removeDiary(author)
      trend.observe(author, 0, post('#feira'), NOW)
    }
    return true
  }
  t.alike(trend.top(NOW, visible, oneAuthor), [{ tag: 'feira', authors: 1 }])
  t.is(calls, 1)
})

test('top: a predicate can remove another author without affecting the remaining counts', (t) => {
  const trend = createTopicTrend()
  trend.observe(K1, 0, post('#feira'), NOW)
  trend.observe(K2, 0, post('#feira #mar'), NOW)
  trend.observe(K2, 1, post('#feira'), NOW)
  trend.observe(K3, 0, post('#feira'), NOW)
  const visible = (author) => {
    if (author === K3) trend.removeDiary(K2)
    return true
  }
  t.alike(trend.top(NOW, visible, oneAuthor), [{ tag: 'feira', authors: 2 }])
  t.alike(trend.stats(), { posts: 2, authors: 2, saturated: false })
})

test('defaults: one day, three authors and ten rows', (t) => {
  t.is(DEFAULT_MAX_POSTS, 20000)
  t.is(DEFAULT_WINDOW_MS, 86400000)
  t.is(TREND_MIN_AUTHORS, 3)
  t.is(TREND_LIMIT, 10)
  const trend = createTopicTrend({ maxPosts: 0, perAuthorMax: 1.5, windowMs: -1 })
  const text = Array.from({ length: 10 }, (_, i) => '#tag' + i).join(' ')
  for (const author of [K1, K2, K3]) {
    t.is(trend.observe(author, 0, post(text, NOW - DEFAULT_WINDOW_MS + 1), NOW), true)
    t.is(trend.observe(author, 1, post('#ab #cd'), NOW), true)
    t.is(trend.observe(author, 2, post('#fora', NOW - DEFAULT_WINDOW_MS), NOW), false)
  }
  t.is(trend.top(NOW, everyone).length, 10)
  t.is(trend.top(NOW, everyone, { limit: 12 }).length, 12)
  t.alike(trend.top(NOW + 1, everyone), [{ tag: 'ab', authors: 3 }, { tag: 'cd', authors: 3 }])
})

test('hostile arguments return safely and invalid records leave the store untouched', (t) => {
  const fail = () => { throw new Error('hostile') }
  const hostile = new Proxy({}, { get: fail })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const trend = createTopicTrend({ maxPosts: 1, perAuthorMax: 1, windowMs: 1 })
  t.is(trend.observe(K1, 0, post('#feira'), NOW), true)
  for (const record of [
    hostile, revoked.proxy, null, 1, { text: 'sem hashtag', at: post('').at },
    { text: '#feira', get at () { return fail() } },
    { get text () { return fail() }, at: post('').at },
    { text: '#feira', at: hostile },
    { text: '#feira', at: '2026-01-01' },
    { text: '#feira', at: '2026-02-30T00:00:00.000Z' },
    post('#feira', -1)
  ]) {
    t.is(trend.observe(K1, 1, record, NOW + 1), false)
  }
  t.is(trend.observe(K1, 0, hostile, NOW), false, 'validate the record before checking idempotence')
  for (const arg of [undefined, hostile, revoked.proxy, Symbol('x'), NaN, Infinity, -1, 1.5, 2 ** 53]) {
    t.is(trend.observe(arg, 0, post('#feira'), NOW), false)
    t.is(trend.observe(K1, arg, post('#feira'), NOW), false)
    t.is(trend.observe(K1, 1, post('#feira'), arg), false)
    t.is(trend.removePost(arg, 0), false)
    t.is(trend.removePost(K1, arg), false)
    t.is(trend.removeDiary(arg), false)
    t.alike(trend.top(arg, everyone, oneAuthor), [])
  }
  t.is(trend.observe(K1 + '\n', 1, post('#feira'), NOW), false)
  t.alike(trend.top(NOW, hostile, oneAuthor), [])
  t.alike(trend.top(NOW, everyone, hostile), [])
  t.alike(trend.top(NOW, everyone, null), [])
  t.alike(trend.top(NOW, everyone, { min: hostile, limit: hostile }), [])
  t.alike(trend.stats(), { posts: 1, authors: 1, saturated: false })
  t.alike(trend.top(NOW, everyone, oneAuthor), [{ tag: 'feira', authors: 1 }])
  t.alike(createTopicTrend(revoked.proxy).stats(), empty)
  t.alike(createTopicTrend(null).stats(), empty)
  const mixed = createTopicTrend({ get maxPosts () { return fail() }, perAuthorMax: 1 })
  t.is(mixed.observe(K1, Number.MAX_SAFE_INTEGER, post('#feira'), NOW), true)
  t.is(mixed.observe(K1, 0, post('#sol'), NOW), false, 'the valid option still applies')
})

test('observe: uppercase hex and negative seq are refused on an empty store', (t) => {
  const trend = createTopicTrend()
  t.is(trend.observe('A'.repeat(64), 0, post('#feira'), NOW), false)
  t.is(trend.observe(K1, -1, post('#feira'), NOW), false)
  t.alike(trend.stats(), empty)
})
