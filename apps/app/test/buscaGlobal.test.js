'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('handle follow keeps its target in the accessible label', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/BuscaGlobal.js'), 'utf8')
  t.ok(src.includes("<Pill label='Seguir' accessibilityLabel={'seguir @' + handle} filled onPress={doAdd} pending={add.pending} disabled={changing || offline || !followsReady} />"), 'a long handle does not lengthen the visible action or change its guards')
})
const load = () => import('../src/buscaGlobal.js')

const EM_DASH = '\u2014'

test('categories and labels', async (t) => {
  const b = await load()
  t.alike(b.CATEGORIES, ['contas', 'publicacoes'])
  t.ok(Object.isFrozen(b.CATEGORIES))
  t.alike(b.CATEGORY_LABEL, { contas: 'Contas', publicacoes: 'Publicações' })
  t.is(b.BUSCA_TITLE, 'Busca')
  t.alike(b.BUSCA_LABEL, { contas: 'Encontrar pessoas', publicacoes: 'pesquisar por assunto' })
  t.alike(b.BUSCA_PLACEHOLDER, { contas: 'nome, @nome ou código', publicacoes: 'uma palavra ou frase' })
  t.ok(Object.isFrozen(b.BUSCA_LABEL))
  t.ok(Object.isFrozen(b.BUSCA_PLACEHOLDER))
  t.ok(Object.isFrozen(b.CATEGORY_LABEL))
})

test('notice and empty texts are exact', async (t) => {
  const b = await load()
  t.is(b.BUSCA_NOT_HOSTED_TITLE, 'Só na versão web')
  t.is(b.BUSCA_NOT_HOSTED, 'Nesta versão, a pesquisa de publicações só funciona no site da associação ou no app ligado à instalação.')
  t.is(b.BUSCA_UNAVAILABLE_TITLE, 'Busca indisponível')
  t.is(b.BUSCA_UNAVAILABLE, 'A pesquisa não está disponível nesta conexão.')
  t.alike(b.BUSCA_EMPTY, {
    contas: 'Procure pessoas pelo nome ou @nome, ou cole o código de alguém.',
    publicacoes: 'Procure palavras nas publicações públicas.'
  })
  t.is(b.BUSCA_EMPTY_CODE, 'Cole o código de 64 letras e números de alguém para seguir.')
  t.is(b.CODE_FIELD_LABEL, 'Cole o código da pessoa (64 letras e números).')
})

test('no exported string contains an em dash', async (t) => {
  const b = await load()
  const strings = []
  const visit = (v) => {
    if (typeof v === 'string') strings.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(visit)
  }
  for (const [name, value] of Object.entries(b)) {
    if (name !== 'plan' && name !== 'buscaNotice') visit(value)
  }
  t.ok(strings.length > 0)
  for (const s of strings) t.absent(s.includes(EM_DASH), JSON.stringify(s))
})

test('plan for publicacoes maps searchPath', async (t) => {
  const { plan } = await load()
  t.alike(plan('publicacoes', 'Céu azul'), { kind: 'posts', query: { tokens: ['ceu', 'azul'], path: 'ceu+azul' }, truncated: false })
  t.alike(plan('publicacoes', '#Céu'), { kind: 'posts', query: { tokens: ['ceu'], path: 'ceu' }, truncated: false })
  const nine = plan('publicacoes', 'um dois tres quatro cinco seis sete oito nove')
  t.is(nine.kind, 'posts')
  t.alike(nine.query, {
    tokens: ['um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito'],
    path: 'um+dois+tres+quatro+cinco+seis+sete+oito'
  })
  t.is(nine.truncated, true)
  t.alike(plan('publicacoes', ''), { kind: 'posts', query: null, truncated: false })
  t.alike(plan('publicacoes', '  a  '), { kind: 'posts', query: null, truncated: false })
  t.alike(plan('publicacoes', null), { kind: 'posts', query: null, truncated: false })
})

test('plan for contas classifies the input', async (t) => {
  const { plan } = await load()
  const key = 'A'.repeat(64)
  t.alike(plan('contas', ''), { kind: 'empty', value: null })
  t.alike(plan('contas', '   '), { kind: 'empty', value: null })
  t.alike(plan('contas', undefined), { kind: 'empty', value: null })
  t.alike(plan('contas', key), { kind: 'key', value: 'a'.repeat(64) })
  t.alike(plan('contas', '  ' + key + '  '), { kind: 'key', value: 'a'.repeat(64) })
  t.alike(plan('contas', 'a'.repeat(30)), { kind: 'partial-key', value: null })
  t.alike(plan('contas', '@maria'), { kind: 'handle', value: '@maria' })
  t.alike(plan('contas', '  Maria Silva  '), { kind: 'name', value: 'Maria Silva' })
})

test('plan for an unknown category is empty', async (t) => {
  const { plan } = await load()
  t.alike(plan('outra', 'maria'), { kind: 'empty', value: null })
  t.alike(plan(undefined, 'maria'), { kind: 'empty', value: null })
})

test('debouncePlan requires two trimmed characters and waits 250 ms', async (t) => {
  const { debouncePlan } = await load()
  for (const query of ['', '   ', 'a', ' a ', null, undefined]) {
    t.alike(debouncePlan(query), { run: false, delayMs: 250, minLength: 2 })
  }
  t.alike(debouncePlan(' ar '), { run: true, delayMs: 250, minLength: 2 })
  t.alike(debouncePlan('céu azul', 'céu'), { run: true, delayMs: 250, minLength: 2 })
})

test('debouncePlan skips an unchanged query without retaining global state', async (t) => {
  const { debouncePlan } = await load()
  t.absent(debouncePlan('céu', 'céu').run)
  t.absent(debouncePlan(' céu ', 'céu  ').run)
  t.ok(debouncePlan('céu', '').run)
  t.ok(debouncePlan('céu', '').run, 'independent callers can plan the same query')
})

test('staleGuard rejects out-of-order answers and invalidates on clear', async (t) => {
  const { staleGuard } = await load()
  let seq = 1
  const first = staleGuard(seq)
  t.ok(first(seq))
  const second = staleGuard(++seq)
  let shown = ''
  if (second(seq)) shown = 'new answer'
  if (first(seq)) shown = 'old answer'
  t.is(shown, 'new answer', 'a late answer cannot replace the newest results')
  t.absent(first(seq))
  t.ok(second(seq), 'the latest request can publish more than once')
  ++seq
  t.absent(second(seq), 'clearing invalidates a request even without a replacement')
  t.absent(staleGuard(2)(1), 'only the current sequence matches')
})

test('recentQueries promotes and deduplicates queries without mutating device state', async (t) => {
  const { recentQueries } = await load()
  const list = Object.freeze(['Chuva', 'Céu', ' céu ', 'Horta'])
  t.alike(recentQueries(list, ' CÉU '), ['CÉU', 'Chuva', 'Horta'])
  t.alike(list, ['Chuva', 'Céu', ' céu ', 'Horta'])
  t.alike(recentQueries([], 'Horta'), ['Horta'], 'another device list stays independent')
  t.alike(recentQueries(['Céu'], 'ceu'), ['ceu', 'Céu'], 'keeps accents in saved queries')
  for (const query of ['', ' ', ' a ', null, undefined]) {
    t.alike(recentQueries(['Céu'], query), ['Céu'])
  }
  t.alike(recentQueries([null, '', ' a ', ' Céu ', 'céu'], 'Horta'), ['Horta', 'Céu'])
  t.alike(recentQueries(undefined, 'Céu'), ['Céu'])
})

test('recentQueries keeps the newest eight by default and accepts a smaller limit', async (t) => {
  const { recentQueries } = await load()
  const list = ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito']
  t.alike(recentQueries(list, 'nove'), ['nove', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete'])
  t.alike(recentQueries(list, 'oito'), ['oito', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete'])
  t.alike(recentQueries(list, 'nove', 2), ['nove', 'um'])
  t.alike(recentQueries(list, 'nove', 0), [])
})

test('buscaNotice gates on hosted only and tolerates any argument', async (t) => {
  const { buscaNotice } = await load()
  t.is(buscaNotice({ hosted: false, online: true }), 'not-hosted')
  t.is(buscaNotice({ hosted: undefined, online: false }), 'not-hosted')
  t.is(buscaNotice({ hosted: false, online: false }), 'not-hosted')
  t.is(buscaNotice({ hosted: 'true' }), 'not-hosted', 'only a real true counts')
  t.is(buscaNotice({ hosted: true, online: false }), null, 'offline is left to Busca.js, which keeps loaded results')
  t.is(buscaNotice({ hosted: true, online: true }), null)
  t.is(buscaNotice({ hosted: true }), null)
  t.is(buscaNotice({}), 'not-hosted')
  t.is(buscaNotice(), 'not-hosted')
  t.is(buscaNotice(null), 'not-hosted')
  t.is(buscaNotice(true), 'not-hosted')
  t.is(buscaNotice('hosted'), 'not-hosted')
})

test('the module imports nothing from react, react-native or node built-ins', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'buscaGlobal.js'), 'utf8')
  const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  t.ok(specs.length > 0)
  for (const spec of specs) {
    t.absent(/^react(-native)?$/.test(spec) || spec.startsWith('node:'), spec + ' is not a forbidden import')
  }
  t.absent(/from\s+'react/.test(src) || /from\s+'node:/.test(src), 'no react or node: import')
})

test('BuscaGlobal clears shown posts when the draft does not qualify to search', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'BuscaGlobal.js'), 'utf8')
  const run = src.slice(src.indexOf('const runPosts'), src.indexOf('const submit'))
  const type = src.slice(src.indexOf('const typePosts'), src.indexOf('// Own and followed authors only'))
  const noQuery = run.slice(run.indexOf('r.query === null'), run.indexOf('r.truncated'))
  t.ok(noQuery.includes("postsSent.current = ''") && noQuery.includes('setQuery(null)'), 'no searchable token clears results and postsSent')
  const short = type.slice(type.indexOf('next.minLength'), type.indexOf('!next.run'))
  t.ok(short.includes("postsSent.current = ''") && short.includes('setQuery(null)'), 'under the minimum clears results and postsSent')
})

test('BuscaGlobal keeps the list when an edit folds to the path already shown', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'BuscaGlobal.js'), 'utf8')
  const run = src.slice(src.indexOf('const runPosts'), src.indexOf('const submit'))
  t.ok(run.includes('r.query.path === shownPath.current'), 'compares the planned path with the shown one')
  t.ok(run.indexOf('r.query.path === shownPath.current') < run.indexOf('setQuery(r.query)'), 'before setQuery')
  t.ok(run.includes('shownPath.current = r.query.path'), 'remembers the path searched')
  t.is(src.split('shownPath.current = null').length - 1, 3, 'every clear forgets the shown path')
})

test('BuscaGlobal: Enter always searches again, a hidden pane never searches, the keyboard never rewrites the query', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'BuscaGlobal.js'), 'utf8')
  const run = src.slice(src.indexOf('const runPosts'), src.indexOf('const submit'))
  t.ok(run.includes('if (typing && r.query.path === shownPath.current) return'), 'only typing keeps the shown path')
  t.ok(/if \(category === 'publicacoes'\) return\n\s*postsSeq\.current \+= 1\n\s*stopPostsTimer\(\)\n\s*\}, \[category\]\)/.test(src), 'leaving Publicações stops the pause timer')
  const field = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'SearchField.js'), 'utf8')
  t.ok(src.includes('<SearchField') && field.includes("autoCapitalize='none'") && field.includes('autoCorrect={false}') && field.includes('spellCheck={false}'), 'both panes turn off autocorrect')
  t.absent(src.includes('mono='), 'no per-pane switch left')
})

test('Publicações submits from the keyboard search key, without a worded Pesquisar button', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'BuscaGlobal.js'), 'utf8')
  t.absent(src.includes('SEARCH_BUTTON'), 'no Pesquisar button between the field and the tabs')
  const field = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'SearchField.js'), 'utf8')
  t.ok(src.includes('<SearchField') && field.includes("returnKeyType='search'"), 'the keyboard key reads as search')
  t.ok(src.includes("onSubmitEditing={category === 'contas' ? (hosted ? handleSearch : undefined) : submit}"), 'and submits')
})

test('the search field grows with large text instead of clipping its placeholder', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'SearchField.js'), 'utf8')
  t.ok(src.includes('minHeight: layout.hit,') && src.includes('minHeight: layout.hit - 3'))
  t.absent(/\bheight: layout\.hit/.test(src.replace(/minHeight/g, '')), 'no fixed height left')
})
