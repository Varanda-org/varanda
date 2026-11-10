'use strict'

const test = require('brittle')
const { feira, MAX_CARD_URL, MAX_TEXT, utf8Decode } = require('..')
const F = feira

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const OFFER = 'c'.repeat(32)
const CONSENT = 'd'.repeat(128)
const AT = '2026-11-07T12:00:00.000Z'
const PLACE = { uf: 'SP', city: 'São Paulo', bairro: 'Pinheiros' }
const LISTING = { type: 'listing', kind: 'produto', title: 'Bicicleta', text: 'Aro 29', price: 50000, unit: null, cat: 'esporte', place: PLACE, at: AT }
const EDIT = { type: 'listing-edit', seq: 3, title: 'Bicicleta', text: '', price: 45000, unit: null, cat: 'esporte', place: PLACE, at: AT }
const STATUS = { type: 'listing-status', seq: 3, status: 'reservado', at: AT }
const RATE = { type: 'listing-rate', to: { author: A, seq: 3 }, offer: OFFER, consent: CONSENT, stars: 5, text: 'Tudo certo', at: AT }

test('constants', (t) => {
  t.is(F.UFS.length, 27)
  t.is(new Set(F.UFS).size, 27)
  t.alike(F.KINDS, ['produto', 'servico', 'procura'])
  t.alike(F.STATUSES, ['disponivel', 'reservado', 'vendido'])
  t.alike(F.UNITS, ['hora', 'dia', 'mes', 'servico', 'a-partir'])
  t.is(F.CATS.length, 12)
  t.is(F.MAX_LISTING_TITLE, 80)
  t.is(F.MAX_PRICE_CENTS, 100000000)
  t.is(F.MAX_LISTINGS, 30)
  t.is(F.RATE_MIN_AGE_MS, 7 * 24 * 3600 * 1000)
  t.is(F.DEAL_PREFIX, 'varanda-feira-deal-v1')
  t.alike(F.LISTING_MEDIA_KEYS, [...F.LISTING_KEYS, 'media'])
  t.alike(F.EDIT_MEDIA_KEYS, [...F.EDIT_KEYS, 'media'])
  t.alike(F.STATUS_KEYS, ['type', 'seq', 'status', 'at'])
  t.alike(F.RATE_KEYS, ['type', 'to', 'offer', 'consent', 'stars', 'text', 'at'])
})

test('validators', (t) => {
  for (const v of F.KINDS) t.ok(F.isKind(v))
  for (const v of ['Produto', 'venda', '', null, 1]) t.absent(F.isKind(v))
  for (const v of F.STATUSES) t.ok(F.isStatus(v))
  for (const v of ['encontrado', 'Vendido', null]) t.absent(F.isStatus(v))
  for (const v of F.CATS) t.ok(F.isCat(v))
  for (const v of ['carros', 'Casa', '', undefined]) t.absent(F.isCat(v))
  for (const v of ['SP', 'RJ', 'DF', 'TO']) t.ok(F.isUf(v))
  for (const v of ['sp', 'XX', 'S', 'SPP', null]) t.absent(F.isUf(v))
  for (const v of F.UNITS) t.ok(F.isUnit(v))
  for (const v of ['mês', 'semana', null, '']) t.absent(F.isUnit(v))
  for (const v of [null, 0, 1, 12345, F.MAX_PRICE_CENTS]) t.ok(F.isPrice(v), String(v))
  for (const v of [-1, 1.5, F.MAX_PRICE_CENTS + 1, '100', NaN, Infinity, undefined]) t.absent(F.isPrice(v), String(v))
  for (const v of ['ab', 'São Paulo', 'x'.repeat(40), '😀😀']) t.ok(F.isPlaceText(v), v)
  for (const v of ['a', 'x'.repeat(41), 'a\nb', 'a\tb', 'ab‮', 'ab\u0085', null, 12]) t.absent(F.isPlaceText(v))
  for (const v of [1, 2, 3, 4, 5]) t.ok(F.isStars(v))
  for (const v of [0, 6, 2.5, '5', null]) t.absent(F.isStars(v))
})

test('unitAllowed matrix', (t) => {
  t.ok(F.unitAllowed('produto', 100, null))
  t.ok(F.unitAllowed('produto', 100, 'a-partir'))
  for (const unit of ['hora', 'dia', 'mes', 'servico']) t.absent(F.unitAllowed('produto', 100, unit), 'produto ' + unit)
  t.ok(F.unitAllowed('procura', 100, null))
  for (const unit of F.UNITS) t.absent(F.unitAllowed('procura', 100, unit), 'procura ' + unit)
  t.ok(F.unitAllowed('servico', 100, null))
  for (const unit of F.UNITS) t.ok(F.unitAllowed('servico', 100, unit), 'servico ' + unit)
  for (const kind of F.KINDS) {
    for (const price of [null, 0]) {
      t.ok(F.unitAllowed(kind, price, null))
      for (const unit of F.UNITS) t.absent(F.unitAllowed(kind, price, unit), kind + ' ' + price + ' ' + unit)
    }
  }
  t.absent(F.unitAllowed('servico', 100, 'semana'))
  t.absent(F.unitAllowed('outro', 100, null))
})

test('cityKey', (t) => {
  t.is(F.cityKey('São Paulo'), 'sao-paulo')
  t.is(F.cityKey('Açúcar'), 'acucar')
  t.is(F.cityKey('Ｓão Paulo'), 'sao-paulo', 'fullwidth letters fold to ASCII')
  t.is(F.cityKey('Re​cife'), 'recife', 'zero-width characters are dropped')
  t.is(F.cityKey('São Paulo'), 'sao-paulo', 'decomposed marks fold the same')
  t.is(F.cityKey('sao  paulo'), 'sao-paulo')
  t.is(F.cityKey('  SAO-PAULO  '), 'sao-paulo')
  t.is(F.cityKey('São José do Vale do Rio Preto'), 'sao-jose-do-vale-do-rio-preto')
  t.is(F.cityKey("Santa Bárbara d'Oeste"), 'santa-barbara-d-oeste')
  t.is(F.cityKey('a'), null)
  t.is(F.cityKey('ã'), null)
  t.is(F.cityKey('--'), null)
  t.is(F.cityKey(''), null)
  t.is(F.cityKey('x'.repeat(48)), 'x'.repeat(48))
  t.is(F.cityKey('x'.repeat(49)), null)
  t.is(F.cityKey(null), null)
})

test('priceLabel', (t) => {
  t.is(F.priceLabel(null, null, 'produto'), 'A combinar')
  t.is(F.priceLabel(0, null, 'produto'), 'Grátis')
  t.is(F.priceLabel(123450, null, 'produto'), 'R$ 1.234,50')
  t.is(F.priceLabel(5, null, 'produto'), 'R$ 0,05')
  t.is(F.priceLabel(100, null, 'produto'), 'R$ 1,00')
  t.is(F.priceLabel(F.MAX_PRICE_CENTS, null, 'produto'), 'R$ 1.000.000,00')
  t.is(F.priceLabel(123450, null, 'procura'), 'Até R$ 1.234,50')
  t.is(F.priceLabel(123450, 'a-partir', 'servico'), 'A partir de R$ 1.234,50')
  t.is(F.priceLabel(123450, 'hora', 'servico'), 'R$ 1.234,50/hora')
  t.is(F.priceLabel(123450, 'dia', 'servico'), 'R$ 1.234,50/dia')
  t.is(F.priceLabel(123450, 'mes', 'servico'), 'R$ 1.234,50/mês')
  t.is(F.priceLabel(123450, 'servico', 'servico'), 'R$ 1.234,50/serviço')
  t.is(F.priceLabel(1.5, null, 'produto'), '')
  t.is(F.priceLabel(-1, null, 'produto'), '')
})

test('statusLabel', (t) => {
  t.is(F.statusLabel('disponivel', 'produto'), 'Disponível')
  t.is(F.statusLabel('reservado', 'servico'), 'Reservado')
  t.is(F.statusLabel('vendido', 'produto'), 'Vendido')
  t.is(F.statusLabel('vendido', 'procura'), 'Encontrado')
  t.is(F.statusLabel('disponivel', 'procura'), 'Disponível')
  t.is(F.statusLabel('perdido', 'produto'), '')
})

test('checkListingShape', (t) => {
  t.is(F.checkListingShape(LISTING), null)
  t.is(F.checkListingShape({ ...LISTING, media: [] }), null, 'media bytes are checked by records.js')
  t.is(F.checkListingShape({ ...LISTING, text: 'x'.repeat(MAX_TEXT) }), null)
  t.is(F.checkListingShape({ ...LISTING, title: 'x'.repeat(80), text: 'a\nb' }), null)
  t.is(F.checkListingShape({ ...LISTING, extra: 1 }), 'malformed')
  t.is(F.checkListingShape({ ...LISTING, type: 'post' }), 'malformed')
  t.is(F.checkListingShape({ ...LISTING, kind: 'venda' }), 'malformed')
  t.is(F.checkListingShape(null), 'malformed')
  t.is(F.checkListingShape([]), 'malformed')
  t.is(F.checkListingShape({ ...LISTING, title: '' }), 'name-length')
  t.is(F.checkListingShape({ ...LISTING, title: 'x'.repeat(81) }), 'name-length')
  t.is(F.checkListingShape({ ...LISTING, title: 'a\nb' }), 'control-chars')
  t.is(F.checkListingShape({ ...LISTING, text: 'x'.repeat(MAX_TEXT + 1) }), 'text-length')
  t.is(F.checkListingShape({ ...LISTING, text: 1 }), 'text-length')
  t.is(F.checkListingShape({ ...LISTING, text: 'a‮b' }), 'control-chars')
  t.is(F.checkListingShape({ ...LISTING, price: 1.5 }), 'price-invalid')
  t.is(F.checkListingShape({ ...LISTING, price: F.MAX_PRICE_CENTS + 1 }), 'price-invalid')
  t.is(F.checkListingShape({ ...LISTING, unit: 'hora' }), 'unit-invalid')
  t.is(F.checkListingShape({ ...LISTING, kind: 'servico', unit: 'hora' }), null)
  t.is(F.checkListingShape({ ...LISTING, cat: 'carros' }), 'category-invalid')
  t.is(F.checkListingShape({ ...LISTING, place: { ...PLACE, uf: 'XX' } }), 'place-invalid')
  t.is(F.checkListingShape({ ...LISTING, place: { ...PLACE, extra: 'x' } }), 'place-invalid')
  t.is(F.checkListingShape({ ...LISTING, place: { uf: 'SP', city: 'São Paulo' } }), 'place-invalid')
  t.is(F.checkListingShape({ ...LISTING, place: { ...PLACE, city: '--' } }), 'place-invalid')
  t.is(F.checkListingShape({ ...LISTING, place: { ...PLACE, bairro: 'a\nb' } }), 'place-invalid')
  t.is(F.checkListingShape({ ...LISTING, place: { ...PLACE, bairro: null } }), null)
  t.ok(F.isPlace({ ...PLACE, bairro: null }))
  t.absent(F.isPlace({ ...PLACE, bairro: undefined }))
  t.absent(F.isPlace({ ...PLACE, bairro: 'a' }))
  for (const at of [null, 0, '2026-11-07', '2026-11-07T12:00:00Z']) {
    t.is(F.checkListingShape({ ...LISTING, at }), 'date-invalid')
    t.is(F.checkEditShape({ ...EDIT, at }, 9), 'date-invalid')
    t.is(F.checkStatusShape({ ...STATUS, at }, 9), 'date-invalid')
    t.is(F.checkRateShape({ ...RATE, at }), 'date-invalid')
  }
  const hostile = { ...LISTING }
  Object.defineProperty(hostile, 'title', { enumerable: true, get () { throw new Error('boom') } })
  t.is(F.checkListingShape(hostile), 'malformed')
})

test('checkEditShape', (t) => {
  t.is(F.checkEditShape(EDIT, 4), null)
  t.is(F.checkEditShape({ ...EDIT, media: [] }, 4), null)
  t.is(F.checkEditShape({ ...EDIT, unit: 'hora' }, 4), null, 'the fold checks the unit against the kind')
  t.is(F.checkEditShape({ ...EDIT, price: 0, unit: 'hora' }, 4), 'unit-invalid')
  t.is(F.checkEditShape(EDIT, 3), 'target-invalid')
  t.is(F.checkEditShape({ ...EDIT, seq: 0 }, 4), 'target-invalid')
  t.is(F.checkEditShape({ ...EDIT, seq: '3' }, 4), 'target-invalid')
  t.is(F.checkEditShape({ ...EDIT, kind: 'produto' }, 4), 'malformed')
  t.is(F.checkEditShape({ ...EDIT, type: 'listing' }, 4), 'malformed')
  t.is(F.checkEditShape({ ...EDIT, title: '' }, 4), 'name-length')
  t.is(F.checkEditShape({ ...EDIT, cat: 'x' }, 4), 'category-invalid')
})

test('checkStatusShape', (t) => {
  for (const status of F.STATUSES) t.is(F.checkStatusShape({ ...STATUS, status }, 4), null)
  t.is(F.checkStatusShape({ ...STATUS, status: 'encontrado' }, 4), 'status-invalid')
  t.is(F.checkStatusShape(STATUS, 3), 'target-invalid')
  t.is(F.checkStatusShape({ ...STATUS, extra: 1 }, 4), 'malformed')
  t.is(F.checkStatusShape({ ...STATUS, type: 'listing-edit' }, 4), 'malformed')
})

test('checkRateShape', (t) => {
  t.is(F.checkRateShape(RATE), null)
  t.is(F.checkRateShape({ ...RATE, text: '' }), null)
  t.is(F.checkRateShape({ ...RATE, text: '😀'.repeat(280) }), null)
  t.is(F.checkRateShape({ ...RATE, text: 'x'.repeat(281) }), 'text-length')
  t.is(F.checkRateShape({ ...RATE, text: 'a\u0007' }), 'control-chars')
  t.is(F.checkRateShape({ ...RATE, stars: 6 }), 'stars-invalid')
  t.is(F.checkRateShape({ ...RATE, stars: 0 }), 'stars-invalid')
  t.is(F.checkRateShape({ ...RATE, to: { author: A, seq: 0 } }), 'target-invalid')
  t.is(F.checkRateShape({ ...RATE, to: { author: A, seq: 1, x: 1 } }), 'target-invalid')
  t.is(F.checkRateShape({ ...RATE, to: 'x' }), 'target-invalid')
  t.is(F.checkRateShape({ ...RATE, offer: 'c'.repeat(31) }), 'malformed')
  t.is(F.checkRateShape({ ...RATE, consent: 'd'.repeat(127) }), 'malformed')
  t.is(F.checkRateShape({ ...RATE, consent: 'D'.repeat(128) }), 'malformed')
  t.is(F.checkRateShape({ ...RATE, price: 1 }), 'malformed')
})

test('dealPayload bytes are stable', (t) => {
  const bytes = F.dealPayload({ listingAuthor: A, listingSeq: 7, rater: B, offerId: OFFER })
  t.ok(bytes instanceof Uint8Array)
  const text = ['varanda-feira-deal-v1', A, '7', B, OFFER].join('\n')
  t.is(utf8Decode(bytes), text)
  t.is(bytes.length, 21 + 1 + 64 + 1 + 1 + 1 + 64 + 1 + 32)
  t.not(bytes[bytes.length - 1], 0x0a)
  t.exception.all(() => F.dealPayload({ listingAuthor: A, listingSeq: 0, rater: B, offerId: OFFER }))
  t.exception.all(() => F.dealPayload({ listingAuthor: A, listingSeq: 7, rater: B, offerId: 'x' }))
  t.exception.all(() => F.dealPayload({ listingAuthor: 'A'.repeat(64), listingSeq: 7, rater: B, offerId: OFFER }))
})

test('parseOfferRef', (t) => {
  const base = 'https://feira.varanda.app/f/' + A + '/12'
  t.alike(F.parseOfferRef(base + '#oferta=15000'), { author: A, seq: 12, cents: 15000, aceite: null, recusada: false })
  t.alike(F.parseOfferRef(base + '#oferta=15000&aceite=' + CONSENT), { author: A, seq: 12, cents: 15000, aceite: CONSENT, recusada: false })
  t.alike(F.parseOfferRef(base + '#oferta=15000&resposta=recusada'), { author: A, seq: 12, cents: 15000, aceite: null, recusada: true })
  t.alike(F.parseOfferRef('https://outra.example.com:8443/f/' + A + '/1#oferta=1'), { author: A, seq: 1, cents: 1, aceite: null, recusada: false })
  t.ok(F.parseOfferRef(base + '#oferta=' + F.MAX_PRICE_CENTS))
  for (const url of [
    base,
    base + '#oferta=015000',
    base + '#oferta=0',
    base + '#oferta=1.5',
    base + '#oferta=+1',
    base + '#oferta=' + (F.MAX_PRICE_CENTS + 1),
    base + '#oferta=1000000000',
    base + '#oferta=1&aceite=' + 'd'.repeat(127),
    base + '#oferta=1&aceite=' + 'g'.repeat(128),
    base + '#oferta=1&aceite=' + CONSENT + '&resposta=recusada',
    base + '#oferta=1&resposta=aceita',
    base + '?x=1#oferta=1',
    'https://feira.varanda.app/f/' + 'A'.repeat(64) + '/12#oferta=1',
    'https://feira.varanda.app/f/' + A + '/012#oferta=1',
    'https://feira.varanda.app/f/' + A + '/0#oferta=1',
    'https://feira.varanda.app/x/' + A + '/12#oferta=1',
    'https://feira.varanda.app/f/' + A + '/12/#oferta=1',
    'http://feira.varanda.app/f/' + A + '/12#oferta=1',
    'https://127.0.0.1/f/' + A + '/12#oferta=1',
    null,
    42
  ]) {
    t.is(F.parseOfferRef(url), null, String(url))
  }
  const host = 'a'.repeat(60) + '.com'
  const fixed = 'https://' + host + '/f/' + A + '/12#oferta=1&aceite=' + CONSENT
  const sub = 'b'.repeat(MAX_CARD_URL - fixed.length) + '.'
  const atCap = 'https://' + sub + host + '/f/' + A + '/12#oferta=1&aceite=' + CONSENT
  t.is(atCap.length, MAX_CARD_URL + 1)
  t.is(F.parseOfferRef(atCap), null, 'oversize url')
  const fits = 'https://' + sub.slice(2) + host + '/f/' + A + '/12#oferta=1&aceite=' + CONSENT
  t.is(fits.length, MAX_CARD_URL - 1)
  t.ok(F.parseOfferRef(fits))
})
