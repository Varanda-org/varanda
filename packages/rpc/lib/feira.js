'use strict'

// The pure rules of the Feira (docs/protocol.md, "Feira"): listing, edit,
// status and rating record shapes, prices and their labels, city keys and the
// offer fragment of a listing URL. Core folds records with them, the seeder
// indexes with them and the app shows them, so every side agrees. Zero
// dependencies, no Node built-ins. The shape checks never throw.

const { charLength, utf8Encode } = require('./text')
const { MAX_TEXT } = require('./limits')
const { isCardForbiddenChar, cardUrlHost, MAX_CARD_URL } = require('./link-card')

const UFS = Object.freeze([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
])
const KINDS = Object.freeze(['produto', 'servico', 'procura'])
const STATUSES = Object.freeze(['disponivel', 'reservado', 'vendido'])
const UNITS = Object.freeze(['hora', 'dia', 'mes', 'servico', 'a-partir'])
const CATS = Object.freeze([
  'casa', 'roupa', 'eletronicos', 'moveis', 'infantil', 'esporte',
  'veiculos', 'comida', 'aulas', 'beleza', 'reparos', 'outros'
])

const MAX_LISTING_TITLE = 80
const MIN_PLACE = 2
const MAX_PLACE = 40
const MAX_PRICE_CENTS = 100000000
const MAX_LISTINGS = 30
const MAX_RATE_TEXT = 280
const MAX_CITY_KEY = 48
const RATE_MIN_AGE_MS = 604800000
const DEAL_PREFIX = 'varanda-feira-deal-v1'

const LISTING_KEYS = Object.freeze(['type', 'kind', 'title', 'text', 'price', 'unit', 'cat', 'place', 'at'])
const LISTING_MEDIA_KEYS = Object.freeze([...LISTING_KEYS, 'media'])
const EDIT_KEYS = Object.freeze(['type', 'seq', 'title', 'text', 'price', 'unit', 'cat', 'place', 'at'])
const EDIT_MEDIA_KEYS = Object.freeze([...EDIT_KEYS, 'media'])
const STATUS_KEYS = Object.freeze(['type', 'seq', 'status', 'at'])
const RATE_KEYS = Object.freeze(['type', 'to', 'offer', 'consent', 'stars', 'text', 'at'])
const PLACE_KEYS = Object.freeze(['uf', 'city', 'bairro'])
const TARGET_KEYS = Object.freeze(['author', 'seq'])

const UNIT_SUFFIX = { hora: '/hora', dia: '/dia', mes: '/mês', servico: '/serviço' }
const STATUS_LABELS = { disponivel: 'Disponível', reservado: 'Reservado', vendido: 'Vendido' }

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

const oneOf = (list) => (v) => typeof v === 'string' && list.includes(v)
const isKind = oneOf(KINDS)
const isStatus = oneOf(STATUSES)
const isCat = oneOf(CATS)
const isUf = oneOf(UFS)
const isUnit = oneOf(UNITS)

function isPrice (v) {
  return v === null || (Number.isSafeInteger(v) && v >= 0 && v <= MAX_PRICE_CENTS)
}

function isStars (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= 5
}

function hasForbidden (s, allowLf) {
  for (const ch of s) {
    if (isCardForbiddenChar(ch.codePointAt(0), allowLf)) return true
  }
  return false
}

function isPlaceText (v) {
  if (typeof v !== 'string') return false
  const n = charLength(v)
  return n >= MIN_PLACE && n <= MAX_PLACE && !hasForbidden(v, false)
}

// A free price ("Grátis") or "A combinar" has nothing to count per hour; a
// search states a ceiling, never a rate; a product is sold whole, so only
// "a partir de" applies.
function unitAllowed (kind, price, unit) {
  if (unit !== null && !isUnit(unit)) return false
  if (price === null || price === 0) return unit === null
  if (kind === 'procura') return unit === null
  if (kind === 'produto') return unit === null || unit === 'a-partir'
  return kind === 'servico'
}

// The search key of a city: the same for "São Paulo", "sao  paulo" and
// "SAO-PAULO", so the index never splits one city in two.
function cityKey (text) {
  if (typeof text !== 'string' || text.length > 4 * MAX_PLACE) return null
  // NFKC first folds fullwidth and compatibility forms into ASCII, and format
  // characters (zero-width spaces and joiners) are dropped, so one city never
  // splits into two keys.
  const key = text.normalize('NFKC').replace(/\p{Cf}/gu, '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return key.length >= 2 && key.length <= MAX_CITY_KEY ? key : null
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isPlace (v) {
  return isPlainObject(v) && hasExactKeys(v, PLACE_KEYS) &&
    isUf(v.uf) && isPlaceText(v.city) && cityKey(v.city) !== null && (v.bairro === null || isPlaceText(v.bairro))
}

// Integer math only: a float would round 0.1 + 0.2 into a wrong label.
function reais (cents) {
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return 'R$ ' + whole + ',' + String(cents % 100).padStart(2, '0')
}

function priceLabel (cents, unit, kind) {
  if (cents === null) return 'A combinar'
  if (!isPrice(cents)) return ''
  if (cents === 0) return 'Grátis'
  const value = reais(cents)
  if (kind === 'procura') return 'Até ' + value
  if (unit === 'a-partir') return 'A partir de ' + value
  if (typeof unit === 'string' && Object.prototype.hasOwnProperty.call(UNIT_SUFFIX, unit)) return value + UNIT_SUFFIX[unit]
  return value
}

function statusLabel (status, kind) {
  if (!isStatus(status)) return ''
  if (status === 'vendido' && kind === 'procura') return 'Encontrado'
  return STATUS_LABELS[status]
}

// The fields a listing and its edit share; `kind` is null for an edit, whose
// kind lives in the listing it edits (the fold checks the pair).
function checkFields (record, kind) {
  const { title, text, price, unit } = record
  if (typeof title !== 'string' || charLength(title) < 1 || charLength(title) > MAX_LISTING_TITLE) return 'name-length'
  if (hasForbidden(title, false)) return 'control-chars'
  if (typeof text !== 'string' || charLength(text) > MAX_TEXT) return 'text-length'
  if (hasForbidden(text, true)) return 'control-chars'
  if (!isPrice(price)) return 'price-invalid'
  if (!unitAllowed(kind === null ? 'servico' : kind, price, unit)) return 'unit-invalid'
  if (!isCat(record.cat)) return 'category-invalid'
  if (!isPlace(record.place)) return 'place-invalid'
  return null
}

// The same canonical ISO rule every diary record's `at` follows (records.js),
// so a status or edit order never compares NaN.
function isCanonicalAt (v) {
  if (typeof v !== 'string' || v.length > 32) return false
  try {
    return new Date(v).toISOString() === v
  } catch {
    return false
  }
}

function isOwnTarget (seq, ownSeq) {
  return Number.isSafeInteger(seq) && seq >= 1 && Number.isSafeInteger(ownSeq) && seq < ownSeq
}

function guard (fn) {
  return (...args) => {
    try {
      return fn(...args)
    } catch {
      return 'malformed'
    }
  }
}

const checkListingShape = guard((record) => {
  if (!isPlainObject(record)) return 'malformed'
  if (!hasExactKeys(record, LISTING_KEYS) && !hasExactKeys(record, LISTING_MEDIA_KEYS)) return 'malformed'
  if (record.type !== 'listing' || !isKind(record.kind)) return 'malformed'
  if (!isCanonicalAt(record.at)) return 'date-invalid'
  return checkFields(record, record.kind)
})

const checkEditShape = guard((record, ownSeq) => {
  if (!isPlainObject(record)) return 'malformed'
  if (!hasExactKeys(record, EDIT_KEYS) && !hasExactKeys(record, EDIT_MEDIA_KEYS)) return 'malformed'
  if (record.type !== 'listing-edit') return 'malformed'
  if (!isOwnTarget(record.seq, ownSeq)) return 'target-invalid'
  if (!isCanonicalAt(record.at)) return 'date-invalid'
  return checkFields(record, null)
})

const checkStatusShape = guard((record, ownSeq) => {
  if (!isPlainObject(record) || !hasExactKeys(record, STATUS_KEYS) || record.type !== 'listing-status') return 'malformed'
  if (!isOwnTarget(record.seq, ownSeq)) return 'target-invalid'
  if (!isCanonicalAt(record.at)) return 'date-invalid'
  return isStatus(record.status) ? null : 'status-invalid'
})

const checkRateShape = guard((record) => {
  if (!isPlainObject(record) || !hasExactKeys(record, RATE_KEYS) || record.type !== 'listing-rate') return 'malformed'
  const to = record.to
  if (!isPlainObject(to) || !hasExactKeys(to, TARGET_KEYS) || typeof to.author !== 'string' || !HEX64.test(to.author) ||
    !Number.isSafeInteger(to.seq) || to.seq < 1) return 'target-invalid'
  if (typeof record.offer !== 'string' || !HEX32.test(record.offer)) return 'malformed'
  if (typeof record.consent !== 'string' || !HEX128.test(record.consent)) return 'malformed'
  if (!isStars(record.stars)) return 'stars-invalid'
  if (typeof record.text !== 'string' || charLength(record.text) > MAX_RATE_TEXT) return 'text-length'
  if (hasForbidden(record.text, true)) return 'control-chars'
  if (!isCanonicalAt(record.at)) return 'date-invalid'
  return null
})

// The bytes the listing author signs when accepting an offer: the rater can
// then rate exactly that listing, once per offer, and nobody else can.
function dealPayload ({ listingAuthor, listingSeq, rater, offerId } = {}) {
  if (typeof listingAuthor !== 'string' || !HEX64.test(listingAuthor)) throw new TypeError('listingAuthor')
  if (!Number.isSafeInteger(listingSeq) || listingSeq < 1) throw new TypeError('listingSeq')
  if (typeof rater !== 'string' || !HEX64.test(rater)) throw new TypeError('rater')
  if (typeof offerId !== 'string' || !HEX32.test(offerId)) throw new TypeError('offerId')
  return utf8Encode([DEAL_PREFIX, listingAuthor, String(listingSeq), rater, offerId].join('\n'))
}

const OFFER_PATH = /^\/f\/([0-9a-f]{64})\/([1-9][0-9]{0,15})$/
const OFFER_FRAGMENT = /^oferta=([1-9][0-9]{0,8})(?:&aceite=([0-9a-f]{128})|(&resposta=recusada))?$/

// An offer is a listing URL with `#oferta=<cents>`; the answer repeats it with
// `&aceite=<consent>` or `&resposta=recusada`. Any host: the origin differs
// per deployment. Never throws.
function parseOfferRef (url) {
  try {
    if (typeof url !== 'string' || url.length > MAX_CARD_URL || cardUrlHost(url) === null) return null
    const hash = url.indexOf('#')
    if (hash === -1 || url.includes('?')) return null
    const rest = url.slice(8, hash)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    const path = OFFER_PATH.exec(rest.slice(slash))
    const frag = OFFER_FRAGMENT.exec(url.slice(hash + 1))
    if (!path || !frag) return null
    const seq = Number(path[2])
    const cents = Number(frag[1])
    if (!Number.isSafeInteger(seq) || cents > MAX_PRICE_CENTS) return null
    return { author: path[1], seq, cents, aceite: frag[2] || null, recusada: frag[3] !== undefined }
  } catch {
    return null
  }
}

module.exports = {
  UFS,
  KINDS,
  STATUSES,
  UNITS,
  CATS,
  MAX_LISTING_TITLE,
  MIN_PLACE,
  MAX_PLACE,
  MAX_PRICE_CENTS,
  MAX_LISTINGS,
  MAX_RATE_TEXT,
  MAX_CITY_KEY,
  RATE_MIN_AGE_MS,
  DEAL_PREFIX,
  LISTING_KEYS,
  LISTING_MEDIA_KEYS,
  EDIT_KEYS,
  EDIT_MEDIA_KEYS,
  STATUS_KEYS,
  RATE_KEYS,
  PLACE_KEYS,
  isKind,
  isStatus,
  isCat,
  isUf,
  isUnit,
  isPrice,
  isPlaceText,
  isPlace,
  isStars,
  unitAllowed,
  cityKey,
  priceLabel,
  statusLabel,
  checkListingShape,
  checkEditShape,
  checkStatusShape,
  checkRateShape,
  dealPayload,
  parseOfferRef
}
