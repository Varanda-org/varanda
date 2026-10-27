'use strict'

// lib/search-index.js: the normative fold and tokenizer, atomic admission
// against every cap, sticky saturation, whole-token AND over the shortest
// posting list, newest-first cursor paging with a bounded scan, hidden
// future posts, total behaviour on hostile input and a 50k-post load.
const test = require('brittle')
const {
  foldText,
  tokensOf,
  createSearchIndex,
  compareNewestFirst,
  parseSearchCursor,
  SEARCH_PAGE,
  SEARCH_SCAN,
  MAX_FUTURE_MS,
  QUERY_RE,
  CURSOR_RE,
  DEFAULT_PER_AUTHOR_POSTINGS_MAX,
  DEFAULT_PER_AUTHOR_TERMS_MAX
} = require('../lib/search-index')
const { spawnSync } = require('child_process')

const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const K3 = '3'.repeat(64)
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z')
const at = (offsetMs) => new Date(BASE_MS + offsetMs).toISOString()
const post = (text, offsetMs = 0) => ({ type: 'post', text, at: at(offsetMs) })
const key = (i) => i.toString(16).padStart(64, '0')
const NOW = BASE_MS + 10 * 86400000

test('fold and tokens: accents, case, separators and length bounds', (t) => {
  t.alike(tokensOf('Céu'), ['ceu'])
  t.alike(tokensOf('#Céu'), ['ceu'])
  t.alike(tokensOf('CÉU!'), ['ceu'])
  t.alike(tokensOf('ceu'), ['ceu'])
  t.alike(tokensOf('Céus'), ['ceus'])
  t.alike(tokensOf('AÇÃO'), ['acao'])
  t.alike(tokensOf('boa e noite'), ['boa', 'noite'], 'one-letter runs dropped')
  t.alike(tokensOf('ceu+azul#mar'), ['ceu', 'azul', 'mar'], '+ and # are separators')
  t.alike(tokensOf('Céu'), tokensOf('Céu'), 'composed and decomposed é are equal')
  t.is(foldText('Céu'), foldText('Céu'))
  t.is(foldText('Ação'), 'acao')
  t.alike(tokensOf('a'.repeat(33) + ' ' + 'b'.repeat(32)), ['b'.repeat(32)], '33-letter run dropped')
  t.alike(tokensOf('céu Ceu CÉU azul céu'), ['ceu', 'azul'], 'duplicates collapse, first-seen order')
  t.alike(tokensOf('em 2026 foi'), ['em', '2026', 'foi'], 'digits kept')
  t.alike(tokensOf(''), [])
  t.alike(tokensOf('日本語 мир'), [], 'non-Latin scripts give no tokens')
  t.is(foldText({ toString () { throw new Error('x') } }), '', 'fold never throws')
  t.alike(tokensOf(Symbol('s')), ['symbol'], 'String(s) semantics, no throw')
})

test('exports: grammar constants and cursor parsing', (t) => {
  t.ok(QUERY_RE.test('ceu'))
  t.ok(QUERY_RE.test('ceu+azul'))
  t.absent(QUERY_RE.test('c'))
  t.absent(QUERY_RE.test(Array(9).fill('ab').join('+')))
  t.ok(QUERY_RE.test(Array(8).fill('ab').join('+')))
  t.ok(CURSOR_RE.test('0.' + K1 + '.1'))
  t.is(parseSearchCursor(null), null)
  t.is(parseSearchCursor(undefined), null)
  t.alike(parseSearchCursor('123.' + K1 + '.4'), { atMs: 123, author: K1, seq: 4 })
  t.is(parseSearchCursor('123.' + K1 + '.0'), undefined)
  t.is(parseSearchCursor('9999999999999999.' + K1 + '.1'), undefined, 'atMs beyond safe integers')
  t.is(parseSearchCursor(12), undefined)
  t.is(parseSearchCursor(''), undefined)
  const a = { atMs: 2, author: K1, seq: 1 }
  const b = { atMs: 1, author: K1, seq: 1 }
  t.ok(compareNewestFirst(a, b) < 0, 'newer first')
  t.ok(compareNewestFirst({ atMs: 1, author: K1, seq: 1 }, { atMs: 1, author: K2, seq: 9 }) < 0, 'author ascending on ties')
  t.ok(compareNewestFirst({ atMs: 1, author: K1, seq: 5 }, { atMs: 1, author: K1, seq: 2 }) < 0, 'seq descending')
  t.is(compareNewestFirst(a, a), 0)
})

test('add: validation, nothing-to-store records and idempotence', (t) => {
  const ix = createSearchIndex()
  const empty = ix.stats()
  t.alike(empty, { posts: 0, terms: 0, postings: 0, saturated: false, maxPosts: 200000 })
  t.is(ix.add('X'.repeat(64), 1, post('ceu')), false, 'bad author')
  t.is(ix.add(K1.toUpperCase().replace(/1/g, 'A'), 1, post('ceu')), false, 'upper-case hex')
  t.is(ix.add(K1, 0, post('ceu')), false, 'seq 0')
  t.is(ix.add(K1, 1.5, post('ceu')), false, 'fractional seq')
  t.is(ix.add(K1, '1', post('ceu')), false, 'string seq')
  const big = createSearchIndex()
  t.is(big.add(K1, 1000000000000000, post('ceu')), false, '16-digit seq: no cursor could carry it')
  t.is(big.stats().saturated, true, 'that refusal is reported like a cap')
  t.is(createSearchIndex().add(K1, 999999999999999, post('ceu')), true, 'largest 15-digit seq')
  t.is(ix.add(null, 1, post('ceu')), false)
  t.alike(ix.stats(), empty)
  t.is(ix.add(K1, 1, { type: 'like', to: { author: K2, seq: 1 }, on: true, at: at(0) }), true, 'like')
  t.is(ix.add(K1, 2, { type: 'profile', name: 'Céu Azul', bio: 'céu', at: at(0) }), true, 'profile')
  t.is(ix.add(K1, 3, { type: 'post', text: '', media: [{}], at: at(0) }), true, 'media-only post')
  t.is(ix.add(K1, 4, { type: 'post', at: at(0) }), true, 'post without text')
  t.is(ix.add(K1, 5, null), true)
  t.is(ix.add(K1, 6, []), true)
  t.is(ix.add(K1, 7, new Date()), true, 'not a plain object')
  t.alike(ix.stats(), empty, 'nothing stored')
  t.is(ix.add(K1, 8, post('céu azul')), true)
  const once = ix.stats()
  t.alike(once, { posts: 1, terms: 2, postings: 2, saturated: false, maxPosts: 200000 })
  t.is(ix.add(K1, 8, post('outro texto inteiro')), true, 'idempotent re-add')
  t.alike(ix.stats(), once)
  const hostile = { type: 'post', at: at(0) }
  Object.defineProperty(hostile, 'text', { enumerable: true, get () { throw new Error('boom') } })
  t.is(ix.add(K1, 9, hostile), false, 'a throwing getter never escapes')
  t.alike(ix.stats(), once)
  // A throwing `at` getter, read after the text, must not leave new terms.
  const late = { type: 'post', text: 'termo novo aqui' }
  Object.defineProperty(late, 'at', { enumerable: true, get () { throw new Error('boom') } })
  t.is(ix.add(K1, 10, late), false, 'a throwing at getter never escapes')
  t.alike(ix.stats(), once, 'and leaves no term behind')
})

test('add: a long post indexes every distinct word', (t) => {
  const ix = createSearchIndex()
  const words = Array.from({ length: 200 }, (_, i) => 'w' + i.toString(36).padStart(3, '0'))
  const text = words.join(' ')
  t.ok(text.length >= 999, 'about 1000 chars: ' + text.length)
  t.ok(ix.add(K1, 1, post(text)))
  t.is(ix.stats().terms, 200)
  t.is(ix.stats().postings, 200)
  t.alike(ix.search([words[199]], null, undefined, NOW).items, [K1 + ':1'], 'the last word is searchable')
  t.alike(ix.search([words[0], words[199]], null, undefined, NOW).items, [K1 + ':1'])
})

function assertAtomicRefusal (t, ix, author, seq, record, label) {
  const before = ix.stats()
  t.is(ix.add(author, seq, record), false, label + ' refused')
  const after = ix.stats()
  t.alike({ ...after, saturated: before.saturated }, before, label + ' leaves counts unchanged')
  t.is(after.saturated, true, label + ' reports saturated')
}

test('caps refuse atomically; removeDiary frees and fires onFreed once', (t) => {
  let freed = 0
  const onFreed = () => { freed++ }

  const a = createSearchIndex({ maxPosts: 2, onFreed })
  t.ok(a.add(K1, 1, post('ceu')))
  t.ok(a.add(K2, 1, post('mar')))
  assertAtomicRefusal(t, a, K3, 1, post('ceu azul'), 'maxPosts')
  t.is(a.search(['azul'], null, undefined, NOW).items.length, 0, 'no partial write')
  t.is(a.removeDiary(K1), true)
  t.is(freed, 1, 'onFreed fired once')
  t.ok(a.add(K3, 1, post('ceu azul')), 'admitted after free')

  freed = 0
  const b = createSearchIndex({ perAuthorMax: 2, onFreed })
  t.ok(b.add(K1, 1, post('ceu')))
  t.ok(b.add(K1, 2, post('ceu')))
  t.is(b.stats().saturated, true, 'full author saturates')
  assertAtomicRefusal(t, b, K1, 3, post('ceu'), 'perAuthorMax')
  t.ok(b.add(K2, 1, post('ceu')), 'another author still admitted')
  t.ok(b.removeDiary(K1))
  t.is(freed, 1)
  t.is(b.stats().saturated, false)
  t.ok(b.add(K1, 3, post('ceu')))

  freed = 0
  const c = createSearchIndex({ maxTerms: 3, onFreed })
  t.ok(c.add(K1, 1, post('ceu azul')))
  t.ok(c.add(K2, 1, post('ceu mar')))
  assertAtomicRefusal(t, c, K2, 2, post('ceu sol'), 'maxTerms')
  t.ok(c.add(K2, 2, post('ceu mar')), 'known terms only still fit')
  t.ok(c.removeDiary(K1))
  t.is(freed, 1)
  t.ok(c.add(K1, 2, post('sol')), 'a freed term admits a new one')

  freed = 0
  const d = createSearchIndex({ maxPostings: 4, onFreed: () => { freed++; throw new Error('hostile') } })
  t.ok(d.add(K1, 1, post('ceu azul')))
  t.ok(d.add(K2, 1, post('ceu mar')))
  assertAtomicRefusal(t, d, K3, 1, post('sol'), 'maxPostings')
  t.is(d.removeDiary(K1), true, 'a throwing onFreed is swallowed')
  t.is(freed, 1)
  t.is(d.removeDiary(K1), false, 'unknown diary')
  t.is(freed, 1, 'no notification without a free')
  t.ok(d.add(K3, 1, post('sol')))
})

test('saturation is sticky after any refusal', (t) => {
  const p = createSearchIndex({ maxPostings: 3 })
  t.ok(p.add(K1, 1, post('ceu')))
  t.ok(p.add(K2, 1, post('mar')))
  t.is(p.stats().saturated, false)
  t.is(p.add(K3, 1, post('sol lua')), false)
  t.is(p.stats().postings, 2)
  t.is(p.stats().saturated, true, 'refusal one slot short of the cap still saturates')
  t.ok(p.add(K3, 2, post('ceu')), 'a smaller post fits')
  t.ok(p.removeDiary(K3))
  t.is(p.stats().saturated, false, 'a free resets the sticky flag')

  const q = createSearchIndex({ maxTerms: 3 })
  t.ok(q.add(K1, 1, post('ceu')))
  t.ok(q.add(K2, 1, post('mar')))
  t.is(q.add(K3, 1, post('sol lua')), false)
  t.is(q.stats().terms, 2)
  t.is(q.stats().saturated, true)
  q.clear()
  t.alike(q.stats(), { posts: 0, terms: 0, postings: 0, saturated: false, maxPosts: 200000 }, 'clear resets')

  const z = createSearchIndex({ perAuthorMax: 0 })
  t.is(z.stats().saturated, true, 'perAuthorMax 0 saturated before any add')
  t.is(z.add(K1, 1, post('ceu')), false)

  const m = createSearchIndex({ maxPosts: 0 })
  t.is(m.stats().saturated, true)
  t.is(m.stats().maxPosts, 0, 'zero is a valid option')

  const f = createSearchIndex({ maxPosts: -1, perAuthorMax: 1.5, maxTerms: 'x', maxPostings: Infinity })
  t.is(f.stats().maxPosts, 200000, 'invalid options fall back to defaults')
  t.ok(f.add(K1, 1, post('ceu')))
  t.ok(f.add(K1, 2, post('ceu')))
})

test('per-author term share: one diary cannot fill the term budget', (t) => {
  t.is(DEFAULT_PER_AUTHOR_TERMS_MAX, 25000, '5% of the term budget')
  let freed = 0
  const ix = createSearchIndex({ perAuthorTermsMax: 5, onFreed: () => { freed++ } })
  t.ok(ix.add(K1, 1, post('aa bb cc')), '3 created')
  t.ok(ix.add(K1, 2, post('dd ee')), '5 created: the share is full')
  t.is(ix.stats().saturated, false)
  assertAtomicRefusal(t, ix, K1, 3, post('aa ff'), 'perAuthorTermsMax')
  t.alike(ix.search(['ff'], null, undefined, NOW), { items: [], next: null }, 'no partial write')
  t.alike(ix.search(['aa'], null, undefined, NOW).items, [K1 + ':1'], 'no posting for the refused post')
  t.ok(ix.add(K1, 3, post('aa bb')), 'known terms only still fit')
  t.ok(ix.add(K2, 1, post('aa gg hh')), 'another author still creates terms')
  t.ok(ix.add(K2, 2, post('ii jj kk')), 'up to its own share')
  t.ok(ix.removeDiary(K1))
  t.is(freed, 1)
  t.is(ix.stats().saturated, false)
  t.alike(ix.search(['aa'], null, undefined, NOW).items, [K2 + ':1'], 'a created term another author uses stays')
  t.ok(ix.add(K1, 1, post('aa ll mm nn oo pp')), 'removeDiary reset the counter: 5 new created')
  t.is(ix.add(K1, 2, post('qq')), false, 'counted again from zero')
})

test('per-author posting share: one diary cannot fill the posting budget', (t) => {
  t.is(DEFAULT_PER_AUTHOR_POSTINGS_MAX, 200000, '5% of the posting budget')
  const ix = createSearchIndex({ perAuthorPostingsMax: 4 })
  t.ok(ix.add(K1, 1, post('aa bb')))
  t.ok(ix.add(K1, 2, post('cc dd')), '4 postings: the share is full')
  assertAtomicRefusal(t, ix, K1, 3, post('ee'), 'perAuthorPostingsMax')
  t.alike(ix.search(['ee'], null, undefined, NOW), { items: [], next: null }, 'no partial write')
  t.ok(ix.add(K2, 1, post('aa bb cc ee')), 'another author still admitted')
  t.is(ix.add(K2, 2, post('ff')), false, 'which has its own share')
  t.ok(ix.removeDiary(K1))
  t.is(ix.stats().saturated, false)
  t.ok(ix.add(K1, 1, post('aa bb cc dd')), 'removeDiary reset the counter')
  t.is(ix.stats().postings, 8)
})

test('search: whole-token AND semantics', (t) => {
  const ix = createSearchIndex()
  ix.add(K1, 1, post('Céu azul', 1))
  ix.add(K1, 2, post('azul, céu!', 2))
  ix.add(K1, 3, post('céu e azul', 3))
  ix.add(K1, 4, post('céu', 4))
  ix.add(K1, 5, post('#Céu', 5))
  ix.add(K1, 6, post('Céus', 6))
  ix.add(K1, 7, post('boa e noite', 7))
  t.alike(ix.search(['ceu', 'azul'], null, undefined, NOW), { items: [K1 + ':3', K1 + ':2', K1 + ':1'], next: null })
  t.alike(ix.search(['azul', 'ceu'], null, undefined, NOW).items, [K1 + ':3', K1 + ':2', K1 + ':1'], 'order of query tokens is irrelevant')
  t.alike(ix.search(['ceu'], null, undefined, NOW).items, [K1 + ':5', K1 + ':4', K1 + ':3', K1 + ':2', K1 + ':1'], "'ceu' finds Céu and #Céu, not Céus")
  t.alike(ix.search(['ceus'], null, undefined, NOW).items, [K1 + ':6'])
  t.alike(ix.search(['boa', 'noite'], null, undefined, NOW).items, [K1 + ':7'])
  t.alike(ix.search(['nada'], null, undefined, NOW), { items: [], next: null }, 'unknown token')
  t.alike(ix.search(['ceu', 'nada'], null, undefined, NOW), { items: [], next: null })
})

test('search: malformed input answers null, never throws', (t) => {
  const ix = createSearchIndex()
  ix.add(K1, 1, post('ceu'))
  t.is(ix.search([]), null)
  t.is(ix.search('ceu'), null)
  t.is(ix.search(['Ceu']), null, 'unfolded token')
  t.is(ix.search(['c']), null)
  t.is(ix.search(['a'.repeat(33)]), null)
  t.is(ix.search(['ceu', 'ceu']), null, 'duplicates')
  t.is(ix.search(Array.from({ length: 9 }, (_, i) => 'ab' + i)), null, 'too many tokens')
  t.is(ix.search([1]), null)
  t.is(ix.search(null), null)
  t.is(ix.search(['ceu'], 'bad'), null, 'bad cursor')
  t.is(ix.search(['ceu'], 7), null)
  t.alike(ix.search(['ceu'], null, 'not a function', NOW).items, [K1 + ':1'], 'non-function visible: all visible')
  t.alike(ix.search(['ceu'], null, undefined, NaN).items, [K1 + ':1'], 'non-finite now falls back to Date.now()')
  t.alike(ix.search(['ceu'], null, () => { throw new Error('hostile') }, NOW), { items: [], next: null }, 'a throwing visible hides the candidate')
  t.alike(ix.search(['ceu'], null, () => 1, NOW).items, [], 'only true means visible')
})

test('search: newest-first order and paging over 70 hits with ties', (t) => {
  const ix = createSearchIndex()
  const expected = []
  // Insert out of order (diary by diary, newest diary first) so the lists
  // go dirty and get sorted lazily; every 5th post shares its time.
  const authors = [K3, K1, K2]
  let n = 0
  for (const author of authors) {
    for (let seq = 1; seq <= 24 && n < 70; seq++, n++) {
      const offset = Math.floor(seq / 5) * 1000
      t.ok(ix.add(author, seq, post('ceu ' + seq, offset)))
      expected.push({ atMs: BASE_MS + offset, author, seq })
    }
  }
  expected.sort(compareNewestFirst)
  const refs = expected.map((e) => e.author + ':' + e.seq)
  const p1 = ix.search(['ceu'], null, undefined, NOW)
  t.alike(p1.items, refs.slice(0, 30))
  t.ok(p1.next !== null)
  const p2 = ix.search(['ceu'], p1.next, undefined, NOW)
  t.alike(p2.items, refs.slice(30, 60))
  t.ok(p2.next !== null)
  const p3 = ix.search(['ceu'], p2.next, undefined, NOW)
  t.alike(p3.items, refs.slice(60))
  t.is(p3.items.length, 10)
  t.is(p3.next, null, 'next null only at the end')
  const last = expected[29]
  t.is(p1.next, last.atMs + '.' + last.author + '.' + last.seq, 'cursor of the last candidate')
  // Ties: same atMs ordered author ascending, then seq descending.
  const tie = expected.filter((e) => e.atMs === BASE_MS + 1000)
  t.ok(tie.length > 3)
  for (let i = 1; i < tie.length; i++) t.ok(tie[i - 1].author <= tie[i].author)
  t.is(SEARCH_PAGE, 30)
})

test('search: the scan budget bounds work when every candidate is hidden', (t) => {
  const ix = createSearchIndex()
  const OLD = key(9999)
  t.ok(ix.add(OLD, 1, post('ceu', 0)))
  for (let i = 1; i <= 2499; i++) ix.add(K1, i, post('ceu', i * 1000))
  let calls = 0
  const visible = (author) => { calls++; return author === OLD }
  const p1 = ix.search(['ceu'], null, visible, NOW)
  t.alike(p1.items, [])
  t.ok(p1.next !== null, 'an empty page still carries next')
  t.is(calls, SEARCH_SCAN, 'exactly SEARCH_SCAN candidates examined')
  calls = 0
  const p2 = ix.search(['ceu'], p1.next, visible, NOW)
  t.alike(p2.items, [OLD + ':1'])
  t.is(p2.next, null)
  t.is(calls, 500)
})

test('search: two common tokens with one shared oldest post', (t) => {
  const ix = createSearchIndex()
  const OLD = key(9999)
  t.ok(ix.add(OLD, 1, post('ceu azul', 0)))
  for (let i = 1; i <= 2500; i++) ix.add(K1, i, post('ceu', i * 1000))
  for (let i = 1; i <= 2500; i++) ix.add(K2, i, post('azul', i * 1000))
  const p1 = ix.search(['ceu', 'azul'], null, undefined, NOW)
  t.alike(p1.items, [])
  t.ok(p1.next !== null)
  let page = p1
  let pages = 1
  const found = []
  while (page.next !== null && pages < 10) {
    page = ix.search(['ceu', 'azul'], page.next, undefined, NOW)
    found.push(...page.items)
    pages++
  }
  t.alike(found, [OLD + ':1'])
  t.is(pages, 2)
  t.is(page.next, null)
})

test('search: a post dated ahead is hidden until the clock catches up', (t) => {
  const ix = createSearchIndex()
  const ahead = 2 * 86400000
  t.ok(ix.add(K1, 1, { type: 'post', text: 'ceu', at: new Date(NOW + ahead).toISOString() }))
  t.ok(ix.add(K1, 2, { type: 'post', text: 'ceu', at: new Date(NOW).toISOString() }))
  t.alike(ix.search(['ceu'], null, undefined, NOW).items, [K1 + ':2'])
  t.alike(ix.search(['ceu'], null, undefined, NOW + ahead - MAX_FUTURE_MS).items, [K1 + ':1', K1 + ':2'])
  t.alike(ix.search(['ceu'], null, undefined, NOW + ahead).items, [K1 + ':1', K1 + ':2'])
  t.is(ix.stats().posts, 2, 'hidden, never removed')
})

test('search: far-future posts never consume the scan budget', (t) => {
  const ix = createSearchIndex()
  t.ok(ix.add(K2, 1, post('ceu', 0)))
  const far = Date.parse('2099-01-01T00:00:00.000Z')
  for (let i = 1; i <= 3000; i++) ix.add(K1, i, { type: 'post', text: 'ceu', at: new Date(far + i).toISOString() })
  t.is(ix.stats().posts, 3001)
  let calls = 0
  const visible = () => { calls++; return true }
  const page = ix.search(['ceu'], null, visible, NOW)
  t.alike(page, { items: [K2 + ':1'], next: null }, 'the ordinary post on the first page')
  t.ok(calls <= 3, 'far-future entries never examined: ' + calls)
  const only = createSearchIndex()
  t.ok(only.add(K1, 1, { type: 'post', text: 'ceu', at: new Date(far).toISOString() }))
  t.alike(only.search(['ceu'], null, undefined, NOW), { items: [], next: null }, 'nothing in range: the end')
  t.alike(only.search(['ceu'], null, undefined, far).items, [K1 + ':1'], 'shown once the clock catches up')
})

test('search: hidden future posts cannot steer a multi-word query onto a long list', (t) => {
  const ix = createSearchIndex()
  for (let i = 1; i <= 40; i++) t.ok(ix.add(K1, i, post('saudade de casa', i)))
  for (let i = 1; i <= 5000; i++) ix.add(K2, i, post('de novo', 1000 + i))
  const far = Date.parse('2099-01-01T00:00:00.000Z')
  for (let i = 1; i <= 6000; i++) ix.add(K3, i, { type: 'post', text: 'saudade', at: new Date(far + i).toISOString() })
  // 'saudade' has 6,040 entries and 'de' 5,040, but only 40 'saudade'
  // entries are in range: the walk must take that list, not the 'de' one.
  const page = ix.search(['saudade', 'de'], null, undefined, NOW)
  t.is(page.items.length, 30, 'a full first page')
  t.ok(page.items.every((ref) => ref.startsWith(K1 + ':')), 'only the matching posts')
})

test('removeDiary deletes emptied terms and leaves other authors intact', (t) => {
  const ix = createSearchIndex()
  ix.add(K1, 1, post('ceu azul', 1))
  ix.add(K1, 2, post('sol', 2))
  ix.add(K2, 1, post('ceu mar', 3))
  t.alike(ix.stats(), { posts: 3, terms: 4, postings: 5, saturated: false, maxPosts: 200000 })
  t.ok(ix.removeDiary(K1))
  t.alike(ix.stats(), { posts: 1, terms: 2, postings: 2, saturated: false, maxPosts: 200000 })
  t.alike(ix.search(['azul'], null, undefined, NOW), { items: [], next: null })
  t.alike(ix.search(['sol'], null, undefined, NOW), { items: [], next: null })
  t.alike(ix.search(['ceu'], null, undefined, NOW).items, [K2 + ':1'])
  t.alike(ix.search(['mar'], null, undefined, NOW).items, [K2 + ':1'])
  t.ok(ix.add(K1, 1, post('ceu', 4)), 're-ingest after removal')
  t.alike(ix.search(['ceu'], null, undefined, NOW).items, [K1 + ':1', K2 + ':1'])
  t.is(ix.removeDiary('nope'), false)
  t.is(ix.removeDiary(undefined), false)
})

test('50k posts from 500 diaries: build and common-token queries stay bounded', (t) => {
  let seed = 42
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const vocab = Array.from({ length: 2000 }, (_, i) => 'pal' + i.toString(36))
  const ix = createSearchIndex()
  const heapBefore = process.memoryUsage().heapUsed
  const startBuild = performance.now()
  let accepted = 0
  for (let d = 0; d < 500; d++) {
    const author = key(d + 1)
    for (let seq = 1; seq <= 100; seq++) {
      const words = []
      for (let w = 0; w < 3; w++) words.push(vocab[Math.floor(rand() * vocab.length)])
      const offset = ((seq - 1) * 500 + d) * 1000
      if (ix.add(author, seq, post('de ' + words.join(' '), offset))) accepted++
    }
  }
  const buildMs = performance.now() - startBuild
  t.is(accepted, 50000)
  t.is(ix.stats().posts, 50000)
  const heapDelta = process.memoryUsage().heapUsed - heapBefore
  const q1 = performance.now()
  const first = ix.search(['de'], null, undefined, NOW + 365 * 86400000)
  const firstMs = performance.now() - q1
  const q2 = performance.now()
  const second = ix.search(['de'], first.next, undefined, NOW + 365 * 86400000)
  const secondMs = performance.now() - q2
  t.is(first.items.length, 30)
  t.is(first.items[0], key(500) + ':100', 'newest post first')
  t.is(second.items.length, 30)
  t.ok(buildMs < 15000, 'build under 15 s: ' + buildMs.toFixed(1))
  t.ok(firstMs < 3000, 'first query under 3 s: ' + firstMs.toFixed(1))
  t.ok(secondMs < 250, 'second query under 250 ms: ' + secondMs.toFixed(1))
  t.comment('50k posts: build ' + buildMs.toFixed(1) + ' ms; first query ' + firstMs.toFixed(2) + ' ms; second ' + secondMs.toFixed(2) + ' ms; heapUsed delta ' + (heapDelta / 1048576).toFixed(1) + ' MB')
})

// A stored token cut from the folded text must not pin that text (V8 keeps
// a 13+ character substring as a slice of its parent). Each crafted post is
// one 13-letter word plus 986 U+1D160 (1000 code points; ~6,000 UTF-16
// units once folded). Measured in a child with --expose-gc so the retained
// heap is read after a full collection.
test('memory: a stored token never retains the post text', (t) => {
  const code = [
    'const { createSearchIndex } = require(' + JSON.stringify(require.resolve('../lib/search-index')) + ')',
    "const K = (i) => i.toString(16).padStart(64, '0')",
    'const pad = String.fromCodePoint(0x1D160).repeat(986)',
    'global.gc()',
    'const before = process.memoryUsage().heapUsed',
    'const ix = createSearchIndex()',
    'let ok = 0',
    'for (let i = 0; i < 4000; i++) {',
    "  const record = { type: 'post', text: 'abcdefghijklm ' + pad, at: new Date(1700000000000 + i).toISOString() }",
    '  if (ix.add(K(1 + (i % 10)), 1 + Math.floor(i / 10), record)) ok++',
    '}',
    'global.gc()',
    'const perPost = (process.memoryUsage().heapUsed - before) / 4000',
    'console.log(JSON.stringify({ ok, perPost, stats: ix.stats() }))'
  ].join('\n')
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', code], { encoding: 'utf8', timeout: 20000 })
  t.is(child.status, 0, 'child ran: ' + child.stderr)
  const out = JSON.parse(child.stdout)
  t.is(out.ok, 4000)
  t.is(out.stats.terms, 1)
  t.is(out.stats.postings, 4000)
  t.ok(out.perPost < 2000, 'retained heap per crafted post under 2,000 B: ' + out.perPost.toFixed(0))
  t.comment('crafted posts retain ' + out.perPost.toFixed(0) + ' B/post after gc')
})
