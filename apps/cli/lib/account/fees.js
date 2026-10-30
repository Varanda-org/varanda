'use strict'

// Varanda's own fee on payments account operations: the operator's rates,
// the treasury that receives them and the quote a member signs. Pure: no
// disk, no network, integers only (BRLA in centavos, USDC in micro-units),
// so the server and the app reach the same number for the same input.
// quote() prices centavos only (BRLA debits); a crypto send paid from the
// USDC balance and a swap use cryptoFee / swapFeeMicros, never quote().

const KINDS = ['transfer', 'payout', 'crypto', 'deposit', 'swap']

const CENTS_MAX = 100000
const BPS_MAX = 2000
// Amounts stay at or below 10^10 so amount * BPS_MAX + 5000 is a safe integer.
const AMOUNT_MAX = 1e10
const REFERENCE_MAX = 64
const FEE_SUFFIX = ':taxa'

const INT_RE = /^(0|[1-9][0-9]{0,8})$/
// Same rule as validId in hodle.js: dot-only ids are path tricks.
const SUB_ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x' + '0'.repeat(40)

function readInt (env, name, max) {
  const raw = env[name]
  if (raw === undefined || raw === '') return 0
  const text = typeof raw === 'string' ? raw.trim() : null
  if (text === '') return 0
  const value = text !== null && INT_RE.test(text) ? Number(text) : NaN
  if (!(value >= 0 && value <= max)) throw new RangeError(name + ' inválido')
  return value
}

// { rates: { <kind>: { cents, bps } }, treasury }. A RangeError names only
// the variable, never its value.
function parseFees (env = {}) {
  const rates = {}
  for (const kind of KINDS) {
    const prefix = 'VARANDA_FEE_' + kind.toUpperCase()
    rates[kind] = {
      cents: readInt(env, prefix + '_CENTS', CENTS_MAX),
      bps: readInt(env, prefix + '_BPS', BPS_MAX)
    }
  }
  // A deposit has no PIN moment to sign a fee, and Hodle's own markup on it
  // is unconfirmed, so a deposit fee would be charged blind.
  if (rates.deposit.cents !== 0 || rates.deposit.bps !== 0) {
    throw new RangeError('VARANDA_FEE_DEPOSIT_* ainda não suportado')
  }
  // A swap debits USDC: a fixed BRL fee would need an exchange rate.
  if (rates.swap.cents !== 0) throw new RangeError('VARANDA_FEE_SWAP_CENTS não suportado')

  const rawTreasury = env.VARANDA_FEE_TREASURY
  const treasuryText = typeof rawTreasury === 'string' ? rawTreasury.trim() : ''
  let treasury = null
  if (treasuryText !== '') {
    treasury = parseTreasury(treasuryText)
    if (treasury === null) throw new RangeError('VARANDA_FEE_TREASURY inválido')
  }
  if (treasury === null && isActive(rates)) throw new RangeError('VARANDA_FEE_TREASURY obrigatório com taxa')
  return { rates, treasury }
}

// null when the text is not a treasury: 'sub:<id>' (a Hodle sub-account) or
// a 0x address, lowercased, never the zero address (fees sent there burn).
function parseTreasury (text) {
  if (typeof text !== 'string') return null
  if (text.startsWith('sub:')) {
    const id = text.slice(4)
    return SUB_ID_RE.test(id) ? { kind: 'sub', id } : null
  }
  if (!ADDRESS_RE.test(text)) return null
  const address = text.toLowerCase()
  if (address === ZERO_ADDRESS) return null
  return { kind: 'address', address }
}

function inRange (n, max) {
  return Number.isSafeInteger(n) && n >= 0 && n <= max
}

function isSafeAmount (n) {
  return inRange(n, AMOUNT_MAX)
}

// The bounds parseFees enforces, checked again for rates built elsewhere:
// they are what keeps every product below a safe integer.
function isValidRate (rate) {
  return !!rate && typeof rate === 'object' && inRange(rate.cents, CENTS_MAX) && inRange(rate.bps, BPS_MAX)
}

// Half up: x.5 centavo rounds to x + 1. null for a rate or amount out of
// bounds, never an unsafe number.
function feeCents (rate, amountCents) {
  if (!isValidRate(rate) || !isSafeAmount(amountCents)) return null
  return rate.cents + Math.floor((amountCents * rate.bps + 5000) / 10000)
}

// The same half up rule in USDC micro-units (6 decimals). Basis points only:
// a USDC debit never carries a fixed BRL part.
function swapFeeMicros (bps, amountMicros) {
  if (!inRange(bps, BPS_MAX) || !isSafeAmount(amountMicros)) return null
  return Math.floor((amountMicros * bps + 5000) / 10000)
}

const usdcFeeMicros = swapFeeMicros

// A crypto send charges in the asset actually debited: USDC from the USDC
// balance pays the crypto bps on micro-units; anything debited as BRLA
// (including USDC converted at send time) pays the full crypto rate in
// centavos. The asset is matched in any case (the ledger and the Hodle
// client write it upper case) and returned lower case.
function cryptoFee (rates, { asset: raw, amount } = {}) {
  const rate = rates && rates.crypto
  if (!isValidRate(rate) || typeof raw !== 'string') return null
  const asset = raw.toLowerCase()
  let fee = null
  if (asset === 'usdc') fee = usdcFeeMicros(rate.bps, amount)
  else if (asset === 'brla') fee = feeCents(rate, amount)
  return fee === null ? null : { asset, fee }
}

const ZERO_QUOTE = Object.freeze({
  amountCents: 0,
  varandaFeeCents: 0,
  hodleFeeCents: 0,
  pendingFeeCents: 0,
  pendingFeeRef: '',
  totalDebitCents: 0,
  netReceivedCents: 0,
  ok: false,
  reason: 'valor-invalido'
})

// The full debit a member signs, in centavos only (BRLA debits): USDC-funded
// crypto sends and swaps go through cryptoFee / swapFeeMicros. The cap covers
// everything that leaves the balance, the pending fee included. Only an
// absent maxCents means no cap. maxFeeCents caps the new fee alone: a fee
// above what one transfer can carry could never be collected. Never throws:
// bad input is a refused quote with every number zero.
function quote ({ kind, amountCents, rates, hodleFeeCents = 0, pendingFeeCents = 0, pendingFeeRef = '', maxCents, maxFeeCents, minCents = 1 } = {}) {
  const rate = rates && KINDS.includes(kind) ? rates[kind] : null
  if (!isValidRate(rate) ||
      !isSafeAmount(amountCents) || !isSafeAmount(hodleFeeCents) || !isSafeAmount(pendingFeeCents) ||
      typeof pendingFeeRef !== 'string' || (pendingFeeCents > 0 && pendingFeeRef === '') ||
      !Number.isSafeInteger(minCents) || minCents < 0 ||
      (maxCents !== undefined && (!Number.isSafeInteger(maxCents) || maxCents < 0)) ||
      (maxFeeCents !== undefined && (!Number.isSafeInteger(maxFeeCents) || maxFeeCents < 0))) {
    return { ...ZERO_QUOTE }
  }
  const varandaFeeCents = feeCents(rate, amountCents)
  const totalDebitCents = amountCents + hodleFeeCents + varandaFeeCents + pendingFeeCents
  const tooSmall = amountCents < Math.max(minCents, 1)
  const tooBig = (maxCents !== undefined && totalDebitCents > maxCents) ||
    (maxFeeCents !== undefined && varandaFeeCents > maxFeeCents)
  const ok = !tooSmall && !tooBig
  return {
    amountCents,
    varandaFeeCents,
    hodleFeeCents,
    pendingFeeCents,
    pendingFeeRef: pendingFeeCents > 0 ? pendingFeeRef : '',
    totalDebitCents,
    netReceivedCents: amountCents,
    ok,
    reason: ok ? null : 'valor-invalido'
  }
}

// The debit fields a signed op carries, as the server recomputes them.
function debitTerms (q) {
  return {
    feeCents: q.varandaFeeCents,
    pendingFeeCents: q.pendingFeeCents,
    pendingFeeRef: q.pendingFeeRef,
    totalDebitCents: q.totalDebitCents
  }
}

// null only when q is an accepted quote and the signed op carries all four
// debit fields with exactly its values, else the 'taxa-mudou' token (strict:
// a string '50' is not 50).
function checkDebit (op, q) {
  if (!op || typeof op !== 'object' || !q || typeof q !== 'object' || q.ok !== true) return 'taxa-mudou'
  const terms = debitTerms(q)
  for (const key of Object.keys(terms)) {
    if (!Object.prototype.hasOwnProperty.call(op, key) || op[key] !== terms[key]) return 'taxa-mudou'
  }
  return null
}

function isSelfTreasury (treasury, { subAccountId, address } = {}) {
  if (!treasury) return false
  if (treasury.kind === 'sub') return typeof subAccountId === 'string' && subAccountId === treasury.id
  if (treasury.kind === 'address') return typeof address === 'string' && address.toLowerCase() === treasury.address
  return false
}

// The fee transfer's reference, tied to the operation it pays for. Hodle
// references stop at 64 characters.
function feeReference (externalId) {
  if (typeof externalId !== 'string' || externalId === '') throw new RangeError('referência inválida')
  const ref = externalId + FEE_SUFFIX
  if (ref.length > REFERENCE_MAX) throw new RangeError('referência inválida')
  return ref
}

function isActive (rates) {
  if (!rates) return false
  return KINDS.some((kind) => rates[kind] && (rates[kind].cents !== 0 || rates[kind].bps !== 0))
}

function formatBrl (cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const reais = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return sign + 'R$ ' + reais + ',' + String(abs % 100).padStart(2, '0')
}

function formatBps (bps) {
  const whole = Math.floor(bps / 100)
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return (frac === '' ? String(whole) : whole + ',' + frac) + '%'
}

// pt-BR, one plain line per kind: 'R$ 0,50 + 1%', 'R$ 0,50', '1%' or 'sem taxa'.
function describe (rates) {
  const out = {}
  for (const kind of KINDS) {
    const rate = (rates && rates[kind]) || { cents: 0, bps: 0 }
    const parts = []
    if (rate.cents) parts.push(formatBrl(rate.cents))
    if (rate.bps) parts.push(formatBps(rate.bps))
    out[kind] = parts.length ? parts.join(' + ') : 'sem taxa'
  }
  return out
}

// The rounding table the app test pins too (Metro cannot import this file).
// unit 'centavos' is feeCents({ cents, bps }, amount); unit 'micros' is
// swapFeeMicros / usdcFeeMicros(bps, amount), where cents is always 0.
const FEE_VECTORS = Object.freeze([
  { name: 'half up at .5', unit: 'centavos', cents: 0, bps: 250, amount: 100, fee: 3 },
  { name: 'below .5', unit: 'centavos', cents: 0, bps: 249, amount: 100, fee: 2 },
  { name: 'tiny amount', unit: 'centavos', cents: 0, bps: 50, amount: 1, fee: 0 },
  { name: 'exactly .5 of a centavo', unit: 'centavos', cents: 0, bps: 50, amount: 100, fee: 1 },
  { name: 'just under .5', unit: 'centavos', cents: 0, bps: 49, amount: 100, fee: 0 },
  { name: 'fixed plus percent', unit: 'centavos', cents: 50, bps: 100, amount: 10000, fee: 150 },
  { name: 'fixed only', unit: 'centavos', cents: 50, bps: 0, amount: 12345, fee: 50 },
  { name: 'zero rate', unit: 'centavos', cents: 0, bps: 0, amount: 12345, fee: 0 },
  { name: 'largest inputs', unit: 'centavos', cents: CENTS_MAX, bps: BPS_MAX, amount: AMOUNT_MAX, fee: 2000100000 },
  { name: 'crypto brla debit (USDC funded from BRLA)', unit: 'centavos', cents: 30, bps: 150, amount: 33333, fee: 530 },
  { name: 'swap half up', unit: 'micros', cents: 0, bps: 30, amount: 1666667, fee: 5000 },
  { name: 'swap below .5', unit: 'micros', cents: 0, bps: 30, amount: 1666, fee: 5 },
  { name: 'swap tiny', unit: 'micros', cents: 0, bps: 1, amount: 4999, fee: 0 },
  { name: 'swap exactly .5', unit: 'micros', cents: 0, bps: 1, amount: 5000, fee: 1 },
  { name: 'swap largest inputs', unit: 'micros', cents: 0, bps: BPS_MAX, amount: AMOUNT_MAX, fee: 2000000000 },
  { name: 'crypto usdc debit', unit: 'micros', cents: 0, bps: 150, amount: 10000000, fee: 150000 },
  { name: 'crypto usdc half up', unit: 'micros', cents: 0, bps: 150, amount: 333333, fee: 5000 }
].map(Object.freeze))

module.exports = {
  KINDS,
  CENTS_MAX,
  BPS_MAX,
  AMOUNT_MAX,
  FEE_VECTORS,
  parseFees,
  parseTreasury,
  feeCents,
  swapFeeMicros,
  usdcFeeMicros,
  cryptoFee,
  quote,
  debitTerms,
  checkDebit,
  isSelfTreasury,
  feeReference,
  isActive,
  describe,
  formatBrl
}
