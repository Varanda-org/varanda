'use strict'

const test = require('brittle')
const load = () => import('../src/topics.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const AT = '2026-10-25T12:00:00.000Z'

const post = (seq, text, extra = {}) => ({ seq, record: { type: 'post', text, at: AT, replyTo: null, ...extra } })
const peekOf = (key, entries, extra = {}) => ({ key, entries, ...extra })

test('fold and tokens (same vectors as the core index)', async (t) => {
  const { tokensOf } = await load()
  t.alike(tokensOf('Céu'), ['ceu'])
  t.alike(tokensOf('céu'), ['ceu'])
  t.alike(tokensOf('CÉU!'), ['ceu'])
  t.alike(tokensOf('#Céu'), ['ceu'])
  t.alike(tokensOf('Céus'), ['ceus'])
  t.alike(tokensOf('Boa, noite!'), ['boa', 'noite'])
  t.alike(tokensOf('boa e noite'), ['boa', 'noite'])
  t.alike(tokensOf('Céu'), tokensOf('Céu'), 'composed equals decomposed')
  t.alike(tokensOf('AÇÃO'), ['acao'])
  t.alike(tokensOf('a'.repeat(33) + ' ok'), ['ok'], 'a 33-letter run is dropped')
  t.alike(tokensOf('a'.repeat(32)), ['a'.repeat(32)])
  t.alike(tokensOf('céu CEU ceu azul'), ['ceu', 'azul'], 'duplicates collapse')
  t.alike(tokensOf('2026'), ['2026'])
})

test('searchPath builds the wire query', async (t) => {
  const { searchPath } = await load()
  t.alike(searchPath('Céu azul'), { tokens: ['ceu', 'azul'], path: 'ceu+azul', truncated: false })
  const nine = searchPath('um dois tres quatro cinco seis sete oito nove')
  t.is(nine.tokens.length, 8)
  t.is(nine.truncated, true)
  t.is(nine.path, 'um+dois+tres+quatro+cinco+seis+sete+oito')
  t.is(searchPath(''), null)
  t.is(searchPath('#'), null)
  t.is(searchPath('a'), null)
  t.is(searchPath('😀'), null)
  t.is(searchPath('?!...'), null)
  t.is(searchPath(null), null)
  t.is(searchPath(42), null)
  t.is(searchPath('ceu+azul').path, 'ceu+azul', 'the wire form is idempotent')
})

test('query regex accepts only wire forms', async (t) => {
  const { QUERY_RE } = await load()
  t.ok(QUERY_RE.test('ceu'))
  t.ok(QUERY_RE.test('ceu+azul'))
  t.absent(QUERY_RE.test('c'))
  t.absent(QUERY_RE.test('ceu+'))
  t.absent(QUERY_RE.test('Ceu'))
  t.absent(QUERY_RE.test('a1+b2+c3+d4+e5+f6+g7+h8+i9'.replace(/(\w)(\d)/g, '$1$1$2')))
})

test('matchesAll needs every whole token', async (t) => {
  const { matchesAll } = await load()
  t.ok(matchesAll('Céu', ['ceu']))
  t.ok(matchesAll('#Céu', ['ceu']))
  t.absent(matchesAll('Céus', ['ceu']))
  t.absent(matchesAll('receba', ['ceu']))
  t.ok(matchesAll('boa e noite', ['boa', 'noite']))
  t.ok(matchesAll('noite boa', ['boa', 'noite']))
  t.absent(matchesAll('boa tarde', ['boa', 'noite']))
  t.absent(matchesAll('boa', []))
  t.absent(matchesAll('boa', null))
})

test('assembleSearch keeps verified matches only', async (t) => {
  const { assembleSearch } = await load()
  const peeked = new Map([
    [A, peekOf(A, [post(1, 'Que Céu azul'), post(2, 'sem nada'), { seq: 3, record: { type: 'repost', on: true, to: { author: B, seq: 1 }, at: AT } }], { profile: { name: 'Ana' }, username: 'ana' })],
    [B, peekOf(B, [post(1, 'céu no futuro', { at: '2026-12-01T00:00:00.000Z' }), post(2, 'ceu em resposta', { replyTo: { author: A, seq: 1 } }), post(3, 'ceu citado', { quote: { author: A, seq: 1 } }), post(4, 'ceu com fotos', { media: [{ id: 'x' }] }), post(5, 'ceu sem fotos', { media: [] })])],
    [C, peekOf(A, [post(1, 'céu')])]
  ])
  const refs = [A + ':1', A + ':2', A + ':3', B + ':1', B + ':2', B + ':3', B + ':4', B + ':5', C + ':1', 'x', A + ':1', A + ':0', A + ':9']
  const { items, unavailable } = assembleSearch({ refs, peeked, tokens: ['ceu'], now: NOW })
  t.alike(items.map((i) => i.author.slice(0, 1) + i.seq), ['a1', 'b2', 'b3', 'b4', 'b5'], 'order preserved')
  t.alike(items[0], { kind: 'post', author: A, seq: 1, at: AT, text: 'Que Céu azul', replyTo: null, quote: null, media: null, name: 'Ana', username: 'ana' })
  t.alike(items[1].replyTo, { author: A, seq: 1 })
  t.alike(items[2].quote, { author: A, seq: 1 })
  t.alike(items[3].media, [{ id: 'x' }])
  t.is(items[4].media, null)
  // A:2 (no token), A:3 (repost), B:1 (future), C:1 (mismatching key), A:9 (missing seq)
  t.is(unavailable, 5)
})

test('assembleSearch ignores bad refs and takes names only from the profile', async (t) => {
  const { assembleSearch } = await load()
  const peeked = new Map([[A, peekOf(undefined, [post(1, 'ceu', { name: 'Fake', username: 'fake' })])]])
  const r = assembleSearch({ refs: [A + ':1', A + ':1', 'zz:1', A.toUpperCase() + ':1', A + ':01', 5], peeked, tokens: ['ceu'], now: NOW })
  t.is(r.items.length, 1)
  t.is(r.unavailable, 0)
  t.is(r.items[0].name, null)
  t.is(r.items[0].username, null)
  t.alike(assembleSearch({ refs: [A + ':1'], peeked: new Map(), tokens: ['ceu'], now: NOW }), { items: [], unavailable: 1 }, 'a missing author is unavailable')
  t.alike(assembleSearch({}), { items: [], unavailable: 0 })
  t.alike(assembleSearch({ refs: [A + ':1'], peeked: null, tokens: ['ceu'] }), { items: [], unavailable: 1 })
})

test('assembleSearch rejects malformed records and defaults now', async (t) => {
  const { assembleSearch } = await load()
  const both = post(1, 'ceu', { replyTo: { author: A, seq: 1 }, quote: { author: A, seq: 1 } })
  const noText = { seq: 2, record: { type: 'post', at: AT, replyTo: null } }
  const peeked = new Map([[A, peekOf(A, [both, noText, post(3, 'ceu', { at: new Date().toISOString() })])]])
  const r = assembleSearch({ refs: [A + ':1', A + ':2', A + ':3'], peeked, tokens: ['ceu'] })
  t.alike(r.items.map((i) => i.seq), [3])
  t.is(r.unavailable, 2)
})

test('an unfollowed or followed author is kept alike', async (t) => {
  const { assembleSearch } = await load()
  const peeked = new Map([[C, peekOf(C, [post(1, 'ceu')])]])
  t.is(assembleSearch({ refs: [C + ':1'], peeked, tokens: ['ceu'], now: NOW }).items.length, 1)
})

test('mergeRefs appends new refs and never mutates', async (t) => {
  const { mergeRefs } = await load()
  const current = Object.freeze([A + ':1', B + ':1'])
  const page = Object.freeze([B + ':1', C + ':1', C + ':1', A + ':2'])
  t.alike(mergeRefs(current, page), { refs: [A + ':1', B + ':1', C + ':1', A + ':2'], added: 2 })
  t.alike(mergeRefs(current, []), { refs: [A + ':1', B + ':1'], added: 0 })
  t.alike(mergeRefs([], page), { refs: [B + ':1', C + ':1', A + ':2'], added: 3 })
})

test('isLastSearchPage only looks at next', async (t) => {
  const { isLastSearchPage } = await load()
  t.is(isLastSearchPage({ items: [], next: null }), true)
  t.is(isLastSearchPage({ items: ['x'], next: null }), true)
  t.is(isLastSearchPage({ items: [], next: 'abc' }), false, 'empty with a cursor is not the end')
  t.is(isLastSearchPage({ items: ['x'], next: 'abc' }), false)
})

test('searchNotice', async (t) => {
  const { searchNotice } = await load()
  t.is(searchNotice({ hosted: false, online: true, loadedAt: null }), 'web-only')
  t.is(searchNotice({ hosted: undefined, online: false, loadedAt: null }), 'web-only')
  t.is(searchNotice({ hosted: true, online: false, loadedAt: null }), 'offline')
  t.is(searchNotice({ hosted: true, online: false, loadedAt: 5 }), null)
  t.is(searchNotice({ hosted: true, online: true, loadedAt: null }), null)
})

test('fixed texts and constants', async (t) => {
  const s = await load()
  t.is(s.SEARCH_LABEL, 'pesquisar por assunto')
  t.is(s.SEARCH_PAGE, 30)
  t.is(s.MAX_QUERY_TOKENS, 8)
  t.is(s.SEARCH_INPUT_MAX, 100)
  t.is(s.MAX_FUTURE_MS, 86400000)
  t.is(s.SEARCH_EMPTY_TITLE, 'Nada encontrado')
  t.ok(s.SEARCH_HINT.includes('"ceu" encontra "Céu" e "#Céu"'))
})
