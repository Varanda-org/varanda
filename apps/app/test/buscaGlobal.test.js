'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
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
