// The Feira's pure rules on the app side: pt-BR labels, the listing form
// check, the view model of a listing read from a peer and the trust lines
// shown next to it. Pure ES module: no React, no platform module, no Node
// built-ins, so Node's import() tests every branch. Prices, units and city
// keys come from @varanda/rpc feira, so the app agrees with core and the
// seeder index.

import rpc from '@varanda/rpc'

const { feira, displayText, isCardForbiddenChar, MAX_TEXT } = rpc

export const KIND_LABELS = Object.freeze({ produto: 'Produto', servico: 'Serviço', procura: 'Procura-se' })
export const CAT_LABELS = Object.freeze({
  casa: 'Casa',
  roupa: 'Roupas',
  eletronicos: 'Eletrônicos',
  moveis: 'Móveis',
  infantil: 'Infantil',
  esporte: 'Esporte',
  veiculos: 'Veículos',
  comida: 'Comida',
  aulas: 'Aulas',
  beleza: 'Beleza',
  reparos: 'Reparos',
  outros: 'Outros'
})
export const UNIT_LABELS = Object.freeze({
  hora: 'Por hora',
  dia: 'Por dia',
  mes: 'Por mês',
  servico: 'Por serviço',
  'a-partir': 'A partir de'
})
export const PRICE_MODES = Object.freeze(['valor', 'combinar', 'gratis'])

export const QUICK_REPLIES = Object.freeze(['Ainda está disponível?', 'Posso combinar a retirada?', 'Qual o valor do serviço?'])
export const QUICK_REPLIES_PROCURA = Object.freeze(['Tenho o que você procura', 'Posso ajudar com isso'])

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
// Brasília has no daylight saving time: a certificate issued late on the
// last day of a month still reads as that month for a Brazilian reader.
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000
const MAX_MUTUALS = 3
const HEX64 = /^[0-9a-f]{64}$/
const PRICE_TEXT = /^(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)(?:,([0-9]{1,2}))?$/

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const labelOf = (table, key) => (typeof key === 'string' && own(table, key) ? table[key] : '')

export const kindLabel = (kind) => labelOf(KIND_LABELS, kind)
export const catLabel = (cat) => labelOf(CAT_LABELS, cat)
export const unitLabel = (unit) => labelOf(UNIT_LABELS, unit)
export const statusLabel = (status, kind) => feira.statusLabel(status, kind)
export const priceLabel = (cents, unit, kind) => feira.priceLabel(cents, unit, kind)

// The units the form offers for a kind and price: the same rule core folds
// with (feira.unitAllowed), so the form never offers a pair core refuses.
export function unitOptions (kind, price) {
  return [null, ...feira.UNITS].filter((u) => feira.unitAllowed(kind, price, u))
}

// A search is never "reserved": core drops that status for a procura.
export function statusOptions (kind) {
  return kind === 'procura' ? ['disponivel', 'vendido'] : [...feira.STATUSES]
}

export function quickReplies (kind) {
  return kind === 'procura' ? [...QUICK_REPLIES_PROCURA] : [...QUICK_REPLIES]
}

// 'R$ 1.234,56', '1234,5' or '80' -> cents, or null when unreadable.
export function parsePriceText (text) {
  if (typeof text !== 'string') return null
  const m = PRICE_TEXT.exec(text.trim())
  if (!m) return null
  const whole = Number(m[1].replace(/\./g, ''))
  const cents = whole * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0')))
  return Number.isSafeInteger(cents) && feira.isPrice(cents) ? cents : null
}

function hasForbidden (s, allowLf) {
  for (const ch of s) {
    if (isCardForbiddenChar(ch.codePointAt(0), allowLf)) return true
  }
  return false
}

const length = (s) => Array.from(s).length
const fail = (field, error) => ({ ok: false, field, error })

// The form -> the listing fields listing.create and listing.edit take, or
// the first problem in pt-BR. form: { kind, title, text, priceMode
// ('valor' | 'combinar' | 'gratis'), priceText, unit, cat, uf, city, bairro }.
export function validateListingForm (form) {
  if (!form || typeof form !== 'object') return fail('kind', 'Escolha o tipo do anúncio.')
  const kind = form.kind
  if (!feira.isKind(kind)) return fail('kind', 'Escolha o tipo do anúncio.')
  const title = typeof form.title === 'string' ? form.title.trim() : ''
  if (title === '') return fail('title', 'Escreva um título.')
  if (length(title) > feira.MAX_LISTING_TITLE) return fail('title', 'O título pode ter até ' + feira.MAX_LISTING_TITLE + ' caracteres.')
  if (hasForbidden(title, false)) return fail('title', 'O título tem caracteres que não podem ser usados.')
  const text = typeof form.text === 'string' ? form.text.trim() : ''
  if (length(text) > MAX_TEXT) return fail('text', 'A descrição pode ter até ' + MAX_TEXT + ' caracteres.')
  if (hasForbidden(text, true)) return fail('text', 'A descrição tem caracteres que não podem ser usados.')

  let price
  if (form.priceMode === 'combinar') price = null
  else if (form.priceMode === 'gratis') price = 0
  else if (form.priceMode === 'valor') {
    price = parsePriceText(form.priceText)
    if (price === null || price === 0) return fail('price', 'Escreva um valor, por exemplo 25,00.')
  } else return fail('price', 'Escolha como fica o valor.')

  const unit = form.unit === undefined ? null : form.unit
  if (!feira.unitAllowed(kind, price, unit)) {
    if (kind === 'procura') return fail('unit', 'Uma procura diz só até quanto você paga, sem unidade.')
    if (price === null || price === 0) return fail('unit', 'Sem valor definido, não há unidade.')
    return fail('unit', 'Um produto só aceita "a partir de".')
  }
  if (!feira.isCat(form.cat)) return fail('cat', 'Escolha uma categoria.')
  if (!feira.isUf(form.uf)) return fail('uf', 'Escolha o estado.')
  const city = typeof form.city === 'string' ? form.city.trim() : ''
  if (!feira.isPlaceText(city) || feira.cityKey(city) === null) return fail('city', 'Escreva o nome da cidade.')
  const rawBairro = typeof form.bairro === 'string' ? form.bairro.trim() : ''
  const bairro = rawBairro === '' ? null : rawBairro
  if (bairro !== null && !feira.isPlaceText(bairro)) return fail('bairro', 'O bairro precisa ter de ' + feira.MIN_PLACE + ' a ' + feira.MAX_PLACE + ' caracteres.')
  const place = { uf: form.uf, city, bairro }
  if (!feira.isPlace(place)) return fail('city', 'Confira a cidade e o bairro.')
  return { ok: true, value: { kind, title, text, price, unit, cat: form.cat, place } }
}

const peer = (s) => displayText(typeof s === 'string' ? s : '')
const peerMultiline = (s) => displayText(typeof s === 'string' ? s : '', { multiline: true })

function placeView (place) {
  if (!place || typeof place !== 'object') return { uf: '', city: '', bairro: null, label: '' }
  const uf = feira.isUf(place.uf) ? place.uf : ''
  const city = peer(place.city)
  const bairro = typeof place.bairro === 'string' ? peer(place.bairro) : null
  const where = city === '' ? uf : (uf === '' ? city : city + '/' + uf)
  return { uf, city, bairro, label: bairro === null || where === '' ? where : bairro + ', ' + where }
}

// The listing a screen shows, from a peeked root record (feira.checkListingShape
// passes) and an optional live edit record (checkEditShape passes): the edit's
// content over the root's, the kind always the root's, as core listing.js
// folds them. An edit whose unit does not fit the root's kind is ignored,
// like core does. Every string from the peer goes through displayText.
// -> view or null when the root is not a listing.
export function listingView ({ author, seq, root, edit = null, editSeq = null, status = 'disponivel' } = {}) {
  try {
    if (typeof author !== 'string' || !HEX64.test(author) || !Number.isSafeInteger(seq) || seq < 1) return null
    if (feira.checkListingShape(root) !== null) return null
    let source = root
    let edited = false
    if (edit && feira.checkEditShape(edit, Number.MAX_SAFE_INTEGER) === null && edit.seq === seq &&
      feira.unitAllowed(root.kind, edit.price, edit.unit)) {
      source = edit
      edited = true
    }
    const kind = root.kind
    const shownStatus = feira.isStatus(status) && !(kind === 'procura' && status === 'reservado') ? status : 'disponivel'
    return {
      author,
      seq,
      editSeq: edited && Number.isSafeInteger(editSeq) ? editSeq : null,
      edited,
      kind,
      kindLabel: kindLabel(kind),
      title: peer(source.title),
      text: peerMultiline(source.text),
      price: source.price,
      unit: source.unit,
      priceLabel: priceLabel(source.price, source.unit, kind),
      cat: source.cat,
      catLabel: catLabel(source.cat),
      place: placeView(source.place),
      media: Array.isArray(source.media) ? source.media : [],
      status: shownStatus,
      statusLabel: statusLabel(shownStatus, kind),
      at: root.at,
      editedAt: edited ? edit.at : null
    }
  } catch {
    return null
  }
}

// "março de 2026" from a canonical ISO date, or ''.
export function monthYear (iso) {
  if (typeof iso !== 'string') return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms - BRASILIA_OFFSET_MS)
  return MONTHS[d.getUTCMonth()] + ' de ' + d.getUTCFullYear()
}

function joinNames (names) {
  if (names.length <= 1) return names.join('')
  return names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1]
}

// The trust lines under a seller: since when the member's certificate is
// verified, the verified name and at most three people the reader follows
// who follow them. A line with nothing to say is left out; there is no age
// badge. -> [{ key, text }].
export function trustLines ({ certDate, verifiedName, mutuals } = {}) {
  const lines = []
  const since = monthYear(certDate)
  if (since !== '') lines.push({ key: 'memberSince', text: 'Na Varanda desde ' + since })
  const name = typeof verifiedName === 'string' ? peer(verifiedName.trim()) : ''
  if (name !== '') lines.push({ key: 'verifiedName', text: 'Nome verificado: ' + name })
  const names = Array.isArray(mutuals)
    ? mutuals.filter((n) => typeof n === 'string' && n.trim() !== '').slice(0, MAX_MUTUALS).map((n) => peer(n.trim()))
    : []
  if (names.length > 0) lines.push({ key: 'mutuals', text: 'Seguido por ' + joinNames(names) })
  return lines
}
