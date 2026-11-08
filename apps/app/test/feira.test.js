'use strict'

// The Feira's app-side rules (src/feira.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/feira.js')
const A = 'ab'.repeat(32)
const AT = '2026-11-01T12:00:00.000Z'
const PLACE = { uf: 'SP', city: 'São Paulo', bairro: 'Pinheiros' }

const root = (extra = {}) => ({
  type: 'listing',
  kind: 'produto',
  title: 'Bicicleta aro 26',
  text: 'Pouco uso.',
  price: 25000,
  unit: null,
  cat: 'esporte',
  place: PLACE,
  at: AT,
  ...extra
})

const edit = (extra = {}) => ({
  type: 'listing-edit',
  seq: 4,
  title: 'Bicicleta aro 26 revisada',
  text: 'Revisada ontem.',
  price: 22000,
  unit: 'a-partir',
  cat: 'esporte',
  place: PLACE,
  at: '2026-11-02T12:00:00.000Z',
  ...extra
})

const form = (extra = {}) => ({
  kind: 'produto',
  title: '  Bicicleta  ',
  text: 'Pouco uso.',
  priceMode: 'valor',
  priceText: 'R$ 1.250,5',
  unit: null,
  cat: 'esporte',
  uf: 'SP',
  city: 'São Paulo',
  bairro: '',
  ...extra
})

test('labels: kind, category, unit, status and price', async (t) => {
  const f = await load()
  t.is(f.kindLabel('procura'), 'Procura-se')
  t.is(f.kindLabel('servico'), 'Serviço')
  t.is(f.kindLabel('constructor'), '')
  t.is(f.catLabel('eletronicos'), 'Eletrônicos')
  t.is(f.catLabel('__proto__'), '')
  t.is(f.unitLabel('mes'), 'Por mês')
  t.is(f.unitLabel('a-partir'), 'A partir de')
  t.is(f.unitLabel('semana'), '')
  t.is(f.statusLabel('vendido', 'produto'), 'Vendido')
  t.is(f.statusLabel('vendido', 'procura'), 'Encontrado')
  t.is(f.priceLabel(5000, 'hora', 'servico'), 'R$ 50,00/hora')
  t.is(f.priceLabel(5000, null, 'procura'), 'Até R$ 50,00')
  t.is(f.priceLabel(null, null, 'produto'), 'A combinar')
  t.is(f.priceLabel(0, null, 'produto'), 'Grátis')
})

test('options: units follow unitAllowed, a procura is never reserved', async (t) => {
  const f = await load()
  t.alike(f.unitOptions('produto', 1000), [null, 'a-partir'])
  t.alike(f.unitOptions('procura', 1000), [null])
  t.alike(f.unitOptions('servico', 0), [null])
  t.alike(f.unitOptions('servico', 1000), [null, 'hora', 'dia', 'mes', 'servico', 'a-partir'])
  t.alike(f.statusOptions('procura'), ['disponivel', 'vendido'])
  t.alike(f.statusOptions('produto'), ['disponivel', 'reservado', 'vendido'])
})

test('quick replies per kind', async (t) => {
  const f = await load()
  t.alike(f.quickReplies('produto'), ['Ainda está disponível?', 'Posso combinar a retirada?', 'Qual o valor do serviço?'])
  t.alike(f.quickReplies('procura'), ['Tenho o que você procura', 'Posso ajudar com isso'])
})

test('parsePriceText', async (t) => {
  const f = await load()
  t.is(f.parsePriceText('R$ 1.234,56'), 123456)
  t.is(f.parsePriceText('80'), 8000)
  t.is(f.parsePriceText('12,5'), 1250)
  t.is(f.parsePriceText('1.23'), null)
  t.is(f.parsePriceText('-5'), null)
  t.is(f.parsePriceText('abc'), null)
  t.is(f.parsePriceText('99999999999'), null)
  t.is(f.parsePriceText(null), null)
})

test('form validation: a valid product', async (t) => {
  const f = await load()
  const out = f.validateListingForm(form())
  t.ok(out.ok)
  t.alike(out.value, {
    kind: 'produto',
    title: 'Bicicleta',
    text: 'Pouco uso.',
    price: 125050,
    unit: null,
    cat: 'esporte',
    place: { uf: 'SP', city: 'São Paulo', bairro: null }
  })
})

test('form validation: unit and procura rules', async (t) => {
  const f = await load()
  t.is(f.validateListingForm(form({ unit: 'hora' })).field, 'unit', 'a product is not sold by the hour')
  t.ok(f.validateListingForm(form({ unit: 'a-partir' })).ok)
  t.ok(f.validateListingForm(form({ kind: 'servico', unit: 'hora' })).ok)
  const procura = f.validateListingForm(form({ kind: 'procura', unit: 'a-partir' }))
  t.is(procura.field, 'unit')
  t.ok(procura.error.includes('procura'))
  t.ok(f.validateListingForm(form({ kind: 'procura' })).ok)
  t.is(f.validateListingForm(form({ priceMode: 'combinar', unit: 'a-partir' })).field, 'unit')
  const free = f.validateListingForm(form({ priceMode: 'gratis' }))
  t.is(free.value.price, 0)
  t.is(f.validateListingForm(form({ priceMode: 'combinar' })).value.price, null)
})

test('form validation: field errors', async (t) => {
  const f = await load()
  t.is(f.validateListingForm(null).field, 'kind')
  t.is(f.validateListingForm(form({ kind: 'troca' })).field, 'kind')
  t.is(f.validateListingForm(form({ title: '   ' })).field, 'title')
  t.is(f.validateListingForm(form({ title: 'x'.repeat(81) })).field, 'title')
  t.is(f.validateListingForm(form({ title: 'a\u202eb' })).field, 'title')
  t.is(f.validateListingForm(form({ text: 'x'.repeat(1001) })).field, 'text')
  t.ok(f.validateListingForm(form({ text: 'linha 1\nlinha 2' })).ok)
  t.is(f.validateListingForm(form({ priceText: '0' })).field, 'price')
  t.is(f.validateListingForm(form({ priceMode: 'outro' })).field, 'price')
  t.is(f.validateListingForm(form({ cat: 'armas' })).field, 'cat')
  t.is(f.validateListingForm(form({ uf: 'XX' })).field, 'uf')
  t.is(f.validateListingForm(form({ city: 'a' })).field, 'city')
  t.is(f.validateListingForm(form({ bairro: 'b' })).field, 'bairro')
  for (const v of Object.values(f)) if (typeof v === 'string') t.absent(v.includes('\u2014'))
})

test('view model: hostile root title is made safe', async (t) => {
  const f = await load()
  // A forbidden title fails the shape: nothing is shown at all.
  t.is(f.listingView({ author: A, seq: 4, root: root({ title: 'Oi\u202eevil' }) }), null)
  // A title that passes the shape still goes through displayText: the
  // direction mark U+200F is allowed in a record but never reaches the screen.
  const v = f.listingView({ author: A, seq: 4, root: root({ title: 'Oferta\u200f', text: 'x\u200e', place: { uf: 'SP', city: 'Rio\u061c', bairro: null } }) })
  t.is(v.title, 'Oferta\ufffd')
  t.is(v.text, 'x\ufffd')
  t.is(v.place.city, 'Rio\ufffd')
  const ok = f.listingView({ author: A, seq: 4, root: root({ text: 'a\nb' }) })
  t.is(ok.title, 'Bicicleta aro 26')
  t.is(ok.text, 'a\nb', 'line breaks stay in the text')
  t.is(ok.kindLabel, 'Produto')
  t.is(ok.priceLabel, 'R$ 250,00')
  t.is(ok.catLabel, 'Esporte')
  t.is(ok.place.label, 'Pinheiros, São Paulo/SP')
  t.is(ok.statusLabel, 'Disponível')
  t.is(ok.edited, false)
  t.is(ok.editSeq, null)
  t.alike(ok.media, [])
  t.is(f.listingView({ author: 'zz', seq: 4, root: root() }), null)
  t.is(f.listingView({ author: A, seq: 0, root: root() }), null)
  t.is(f.listingView({ author: A, seq: 4, root: { ...root(), extra: 1 } }), null)
  t.is(f.listingView(), null)
})

test('view model: an edit is applied over the root, kind from the root', async (t) => {
  const f = await load()
  const v = f.listingView({ author: A, seq: 4, root: root(), edit: edit(), editSeq: 9, status: 'reservado' })
  t.is(v.title, 'Bicicleta aro 26 revisada')
  t.is(v.text, 'Revisada ontem.')
  t.is(v.priceLabel, 'A partir de R$ 220,00')
  t.is(v.kind, 'produto')
  t.is(v.edited, true)
  t.is(v.editSeq, 9)
  t.is(v.at, AT, 'the root date stays')
  t.is(v.editedAt, '2026-11-02T12:00:00.000Z')
  t.is(v.statusLabel, 'Reservado')

  const wrongUnit = f.listingView({ author: A, seq: 4, root: root(), edit: edit({ unit: 'hora' }), editSeq: 9 })
  t.is(wrongUnit.title, 'Bicicleta aro 26', 'an edit whose unit does not fit the kind is ignored')
  t.is(wrongUnit.edited, false)
  const otherTarget = f.listingView({ author: A, seq: 4, root: root(), edit: edit({ seq: 5 }), editSeq: 9 })
  t.is(otherTarget.edited, false, 'an edit of another listing is ignored')

  const procura = f.listingView({ author: A, seq: 4, root: root({ kind: 'procura' }), status: 'reservado' })
  t.is(procura.status, 'disponivel', 'a procura is never shown as reserved')
  t.is(f.listingView({ author: A, seq: 4, root: root({ kind: 'procura' }), status: 'vendido' }).statusLabel, 'Encontrado')
})

test('trust lines: omitted when empty, at most three mutuals', async (t) => {
  const f = await load()
  t.alike(f.trustLines({}), [])
  t.alike(f.trustLines(), [])
  t.alike(f.trustLines({ certDate: 'ontem', verifiedName: '  ', mutuals: ['', 3] }), [])
  const lines = f.trustLines({
    certDate: '2026-03-01T01:00:00.000Z',
    verifiedName: 'Ana Souza',
    mutuals: ['Bia', 'Caio', 'Dani', 'Edu']
  })
  t.alike(lines, [
    { key: 'memberSince', text: 'Na Varanda desde fevereiro de 2026' },
    { key: 'verifiedName', text: 'Nome verificado: Ana Souza' },
    { key: 'mutuals', text: 'Seguido por Bia, Caio e Dani' }
  ])
  t.alike(f.trustLines({ mutuals: ['Bia'] }), [{ key: 'mutuals', text: 'Seguido por Bia' }])
  t.absent(JSON.stringify(f.trustLines({ certDate: AT, verifiedName: 'A', mutuals: ['B'] })).toLowerCase().includes('idade'), 'no age badge')
})
