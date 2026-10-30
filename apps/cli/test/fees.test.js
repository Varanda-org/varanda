'use strict'

// apps/cli/lib/account/fees.js: Varanda's fee rates, treasury and the debit
// quote a member signs. Pure: no network, no disk.

const test = require('brittle')
const fees = require('../lib/account/fees')
const {
  KINDS, FEE_VECTORS, AMOUNT_MAX, parseFees, parseTreasury, feeCents, swapFeeMicros, usdcFeeMicros,
  cryptoFee, quote, debitTerms, checkDebit, isSelfTreasury, feeReference, isActive, describe, formatBrl
} = fees

const ADDR = '0x' + 'ab'.repeat(20)
const TREASURY = 'sub:treasury-1'

function throwsRange (t, fn, message, label) {
  try {
    fn()
    t.fail(label + ': did not throw')
  } catch (err) {
    t.ok(err instanceof RangeError, label + ': RangeError')
    t.is(err.message, message, label + ': message')
  }
}

function zeroRates () {
  const rates = {}
  for (const kind of KINDS) rates[kind] = { cents: 0, bps: 0 }
  return rates
}

function allSafe (t, q, label) {
  for (const key of ['amountCents', 'varandaFeeCents', 'hodleFeeCents', 'pendingFeeCents', 'totalDebitCents', 'netReceivedCents']) {
    t.ok(Number.isSafeInteger(q[key]), label + ': ' + key + ' is a safe integer')
  }
}

test('fees: kinds', (t) => {
  t.alike(KINDS, ['transfer', 'payout', 'crypto', 'deposit', 'swap'])
})

test('fees: empty env means no fee and no treasury', (t) => {
  const { rates, treasury } = parseFees({})
  t.alike(rates, zeroRates())
  t.is(treasury, null)
  t.is(isActive(rates), false)
  const blank = parseFees({ VARANDA_FEE_TRANSFER_CENTS: '', VARANDA_FEE_PAYOUT_BPS: '0', VARANDA_FEE_TREASURY: '' })
  t.alike(blank.rates, zeroRates())
  t.is(blank.treasury, null)
})

test('fees: in-range values parse', (t) => {
  const { rates, treasury } = parseFees({
    VARANDA_FEE_TRANSFER_CENTS: '50',
    VARANDA_FEE_TRANSFER_BPS: '100',
    VARANDA_FEE_PAYOUT_CENTS: '100000',
    VARANDA_FEE_PAYOUT_BPS: '2000',
    VARANDA_FEE_CRYPTO_BPS: ' 150 ',
    VARANDA_FEE_SWAP_BPS: '30',
    VARANDA_FEE_SWAP_CENTS: '0',
    VARANDA_FEE_TREASURY: TREASURY
  })
  t.alike(rates.transfer, { cents: 50, bps: 100 })
  t.alike(rates.payout, { cents: 100000, bps: 2000 })
  t.alike(rates.crypto, { cents: 0, bps: 150 })
  t.alike(rates.deposit, { cents: 0, bps: 0 })
  t.alike(rates.swap, { cents: 0, bps: 30 })
  t.alike(treasury, { kind: 'sub', id: 'treasury-1' })
  t.is(isActive(rates), true)
})

test('fees: bad values name only the variable', (t) => {
  const bad = ['abc', '-1', '01', '1.5', '1e3', '0x10', '+5', ' ', '100001', '9999999999']
  for (const value of bad) {
    if (value.trim() === '') continue
    throwsRange(t, () => parseFees({ VARANDA_FEE_TRANSFER_CENTS: value, VARANDA_FEE_TREASURY: TREASURY }),
      'VARANDA_FEE_TRANSFER_CENTS inválido', 'cents ' + JSON.stringify(value))
  }
  for (const value of ['2001', '-0', '50%', 'x']) {
    throwsRange(t, () => parseFees({ VARANDA_FEE_CRYPTO_BPS: value, VARANDA_FEE_TREASURY: TREASURY }),
      'VARANDA_FEE_CRYPTO_BPS inválido', 'bps ' + JSON.stringify(value))
  }
  try {
    parseFees({ VARANDA_FEE_PAYOUT_BPS: 'segredo-123', VARANDA_FEE_TREASURY: TREASURY })
    t.fail('did not throw')
  } catch (err) {
    t.absent(err.message.includes('segredo'), 'the value is never echoed')
  }
})

test('fees: a deposit fee is refused', (t) => {
  throwsRange(t, () => parseFees({ VARANDA_FEE_DEPOSIT_CENTS: '1', VARANDA_FEE_TREASURY: TREASURY }),
    'VARANDA_FEE_DEPOSIT_* ainda não suportado', 'deposit cents')
  throwsRange(t, () => parseFees({ VARANDA_FEE_DEPOSIT_BPS: '10', VARANDA_FEE_TREASURY: TREASURY }),
    'VARANDA_FEE_DEPOSIT_* ainda não suportado', 'deposit bps')
  t.alike(parseFees({ VARANDA_FEE_DEPOSIT_CENTS: '0', VARANDA_FEE_DEPOSIT_BPS: '' }).rates.deposit, { cents: 0, bps: 0 })
  throwsRange(t, () => parseFees({ VARANDA_FEE_DEPOSIT_BPS: 'x' }), 'VARANDA_FEE_DEPOSIT_BPS inválido', 'deposit bad format')
})

test('fees: a fixed swap fee is refused, swap bps is fine', (t) => {
  throwsRange(t, () => parseFees({ VARANDA_FEE_SWAP_CENTS: '1', VARANDA_FEE_TREASURY: TREASURY }),
    'VARANDA_FEE_SWAP_CENTS não suportado', 'swap cents')
  throwsRange(t, () => parseFees({ VARANDA_FEE_SWAP_BPS: '2001', VARANDA_FEE_TREASURY: TREASURY }),
    'VARANDA_FEE_SWAP_BPS inválido', 'swap bps out of range')
  t.alike(parseFees({ VARANDA_FEE_SWAP_CENTS: '', VARANDA_FEE_SWAP_BPS: '2000', VARANDA_FEE_TREASURY: ADDR }).rates.swap, { cents: 0, bps: 2000 })
})

test('fees: treasury required only with a nonzero rate', (t) => {
  throwsRange(t, () => parseFees({ VARANDA_FEE_TRANSFER_CENTS: '1' }), 'VARANDA_FEE_TREASURY obrigatório com taxa', 'cents')
  throwsRange(t, () => parseFees({ VARANDA_FEE_SWAP_BPS: '1', VARANDA_FEE_TREASURY: '  ' }), 'VARANDA_FEE_TREASURY obrigatório com taxa', 'blank')
  t.is(parseFees({ VARANDA_FEE_TRANSFER_CENTS: '0' }).treasury, null, 'zero rates need none')
  t.alike(parseFees({ VARANDA_FEE_TREASURY: ADDR }).treasury, { kind: 'address', address: ADDR }, 'set without rates is kept')
  throwsRange(t, () => parseFees({ VARANDA_FEE_TREASURY: 'nope' }), 'VARANDA_FEE_TREASURY inválido', 'bad treasury')
  throwsRange(t, () => parseFees({ VARANDA_FEE_TREASURY: '0x' + '0'.repeat(40), VARANDA_FEE_PAYOUT_CENTS: '5' }),
    'VARANDA_FEE_TREASURY inválido', 'zero address')
})

test('fees: parseTreasury', (t) => {
  t.alike(parseTreasury('sub:a_b.c:d-9'), { kind: 'sub', id: 'a_b.c:d-9' })
  t.alike(parseTreasury('sub:' + 'x'.repeat(128)), { kind: 'sub', id: 'x'.repeat(128) })
  t.is(parseTreasury('sub:' + 'x'.repeat(129)), null)
  t.is(parseTreasury('sub:'), null)
  t.is(parseTreasury('sub:a b'), null)
  t.is(parseTreasury('sub:a/b'), null)
  t.alike(parseTreasury('0x' + 'AB'.repeat(20)), { kind: 'address', address: ADDR }, 'lowercased')
  t.is(parseTreasury('0x' + '0'.repeat(40)), null, 'zero address')
  t.is(parseTreasury('0X' + 'ab'.repeat(20)), null)
  t.is(parseTreasury('0x' + 'ab'.repeat(19)), null)
  t.is(parseTreasury('0x' + 'zz'.repeat(20)), null)
  t.is(parseTreasury(''), null)
  t.is(parseTreasury(null), null)
  t.is(parseTreasury(42), null)
})

test('fees: half up rounding', (t) => {
  t.is(feeCents({ cents: 0, bps: 250 }, 100), 3, '100 at 250 bps')
  t.is(feeCents({ cents: 0, bps: 249 }, 100), 2, '100 at 249 bps')
  t.is(feeCents({ cents: 0, bps: 50 }, 1), 0, '1 at 50 bps')
  t.is(feeCents({ cents: 50, bps: 100 }, 10000), 150, 'fixed plus percent')
})

test('fees: FEE_VECTORS are exported and hold', (t) => {
  t.ok(Array.isArray(FEE_VECTORS) && FEE_VECTORS.length > 0)
  t.ok(Object.isFrozen(FEE_VECTORS))
  t.ok(FEE_VECTORS.some((v) => v.unit === 'centavos'))
  t.ok(FEE_VECTORS.some((v) => v.unit === 'micros'))
  for (const v of FEE_VECTORS) {
    const got = v.unit === 'centavos' ? feeCents({ cents: v.cents, bps: v.bps }, v.amount) : swapFeeMicros(v.bps, v.amount)
    t.is(got, v.fee, v.name)
    t.ok(Number.isSafeInteger(got), v.name + ': safe integer')
    if (v.unit === 'micros') t.is(v.cents, 0, v.name + ': micros never carry a fixed part')
  }
})

test('fees: swap and USDC fees use micro-units, half up', (t) => {
  t.is(usdcFeeMicros, swapFeeMicros, 'one rule for both')
  t.is(swapFeeMicros(30, 1666667), 5000)
  t.is(swapFeeMicros(1, 5000), 1)
  t.is(swapFeeMicros(1, 4999), 0)
  t.is(swapFeeMicros(0, AMOUNT_MAX), 0)
  t.ok(Number.isSafeInteger(swapFeeMicros(2000, AMOUNT_MAX)))
})

test('fees: crypto send charges the debited asset', (t) => {
  const rates = zeroRates()
  rates.crypto = { cents: 30, bps: 150 }
  t.alike(cryptoFee(rates, { asset: 'usdc', amount: 10000000 }), { asset: 'usdc', fee: 150000 }, 'USDC balance: bps on micros, no fixed BRL part')
  t.alike(cryptoFee(rates, { asset: 'brla', amount: 33333 }), { asset: 'brla', fee: 530 }, 'BRLA debit: full crypto rate in centavos')
  t.alike(cryptoFee(rates, { asset: 'brla', amount: 33333 }).fee, feeCents(rates.crypto, 33333))
  t.is(cryptoFee(rates, { asset: 'eth', amount: 1 }), null)
})

test('fees: quote', (t) => {
  const rates = zeroRates()
  rates.payout = { cents: 50, bps: 100 }
  const q = quote({ kind: 'payout', amountCents: 10000, rates, hodleFeeCents: 25, maxCents: 100000, minCents: 100 })
  t.alike(q, {
    amountCents: 10000,
    varandaFeeCents: 150,
    hodleFeeCents: 25,
    pendingFeeCents: 0,
    pendingFeeRef: '',
    totalDebitCents: 10175,
    netReceivedCents: 10000,
    ok: true,
    reason: null
  })
  allSafe(t, q, 'ok quote')

  const free = quote({ kind: 'transfer', amountCents: 500, rates, maxCents: 500 })
  t.is(free.varandaFeeCents, 0)
  t.is(free.ok, true, 'cap is inclusive')
})

test('fees: quote refusals', (t) => {
  const rates = zeroRates()
  rates.transfer = { cents: 10, bps: 0 }
  const small = quote({ kind: 'transfer', amountCents: 99, rates, minCents: 100, maxCents: 1000 })
  t.is(small.ok, false)
  t.is(small.reason, 'valor-invalido')
  const big = quote({ kind: 'transfer', amountCents: 991, rates, maxCents: 1000 })
  t.is(big.ok, false, 'amount plus fee above the cap')
  t.is(big.reason, 'valor-invalido')
  t.is(big.totalDebitCents, 1001)
  t.is(quote({ kind: 'transfer', amountCents: 990, rates, maxCents: 1000 }).ok, true)
  t.is(quote({ kind: 'transfer', amountCents: 980, rates, hodleFeeCents: 11, maxCents: 1000 }).ok, false, 'Hodle fee counts')
  t.is(quote({ kind: 'transfer', amountCents: 0, rates }).ok, false, 'zero amount')

  const junk = [NaN, Infinity, -1, 1.5, AMOUNT_MAX + 1, '100', null, undefined]
  for (const amountCents of junk) {
    let q
    try {
      q = quote({ kind: 'transfer', amountCents, rates, maxCents: 1000 })
    } catch (err) {
      t.fail('threw on ' + String(amountCents))
      continue
    }
    t.is(q.ok, false, String(amountCents) + ' refused')
    t.is(q.reason, 'valor-invalido')
    allSafe(t, q, String(amountCents))
  }
  t.is(quote({ kind: 'transfer', amountCents: 100, rates, hodleFeeCents: -1 }).ok, false, 'negative Hodle fee')
  t.is(quote({ kind: 'nope', amountCents: 100, rates }).ok, false, 'unknown kind')
  t.is(quote({ kind: 'transfer', amountCents: 100 }).ok, false, 'no rates')
  t.is(quote().ok, false, 'no input')
  allSafe(t, quote({ kind: 'payout', amountCents: AMOUNT_MAX, rates: { ...zeroRates(), payout: { cents: 100000, bps: 2000 } }, hodleFeeCents: AMOUNT_MAX, pendingFeeCents: AMOUNT_MAX, pendingFeeRef: 'r' }), 'largest inputs')
})

test('fees: the debit binds the pending fee (C10)', (t) => {
  const rates = zeroRates()
  rates.transfer = { cents: 10, bps: 100 }
  const q = quote({ kind: 'transfer', amountCents: 1000, rates, hodleFeeCents: 5, pendingFeeCents: 40, pendingFeeRef: 'op-1:taxa', maxCents: 1065 })
  t.is(q.varandaFeeCents, 20)
  t.is(q.pendingFeeCents, 40)
  t.is(q.pendingFeeRef, 'op-1:taxa')
  t.is(q.totalDebitCents, 1065)
  t.is(q.netReceivedCents, 1000)
  t.is(q.ok, true)
  allSafe(t, q, 'pending quote')

  const over = quote({ kind: 'transfer', amountCents: 1000, rates, hodleFeeCents: 5, pendingFeeCents: 41, pendingFeeRef: 'op-1:taxa', maxCents: 1065 })
  t.is(over.ok, false, 'the cap includes the pending fee')
  t.is(over.reason, 'valor-invalido')

  t.is(quote({ kind: 'transfer', amountCents: 1000, rates, pendingFeeCents: 40 }).ok, false, 'a pending fee needs its reference')
  t.is(quote({ kind: 'transfer', amountCents: 1000, rates, pendingFeeRef: 'stale' }).pendingFeeRef, '', 'no pending fee, no reference')

  const terms = debitTerms(q)
  t.alike(terms, { feeCents: 20, pendingFeeCents: 40, pendingFeeRef: 'op-1:taxa', totalDebitCents: 1065 })
  t.is(checkDebit({ ...terms, opId: 'x' }, q), null, 'matching op')
  t.is(checkDebit({ ...terms, feeCents: 19 }, q), 'taxa-mudou')
  t.is(checkDebit({ ...terms, pendingFeeCents: 0 }, q), 'taxa-mudou')
  t.is(checkDebit({ ...terms, pendingFeeRef: '' }, q), 'taxa-mudou')
  t.is(checkDebit({ ...terms, totalDebitCents: 1064 }, q), 'taxa-mudou')
  t.is(checkDebit({ ...terms, feeCents: '20' }, q), 'taxa-mudou', 'strict types')
  const { pendingFeeRef, ...missing } = terms
  t.is(checkDebit(missing, q), 'taxa-mudou', 'missing field')
  t.is(checkDebit(null, q), 'taxa-mudou')
  t.ok(pendingFeeRef)
})

test('fees: rates outside the parseFees bounds are refused, never an unsafe number', (t) => {
  const badRates = [
    { cents: 0, bps: 1e10 },
    { cents: 0, bps: 2001 },
    { cents: 100001, bps: 0 },
    { cents: -1, bps: 0 },
    { cents: 0, bps: 1.5 },
    { cents: '50', bps: 0 },
    { cents: 0 },
    null
  ]
  for (const rate of badRates) {
    const label = JSON.stringify(rate)
    const rates = { ...zeroRates(), transfer: rate, crypto: rate }
    const q = quote({ kind: 'transfer', amountCents: AMOUNT_MAX, rates })
    t.is(q.ok, false, label + ': quote refused')
    t.is(q.reason, 'valor-invalido', label + ': reason')
    allSafe(t, q, label)
    t.is(feeCents(rate, 100), null, label + ': feeCents')
    t.is(cryptoFee(rates, { asset: 'brla', amount: 100 }), null, label + ': cryptoFee brla')
    t.is(cryptoFee(rates, { asset: 'usdc', amount: 100 }), null, label + ': cryptoFee usdc')
  }
  for (const bps of [1e10, 2001, -1, 0.5, '30', undefined]) {
    t.is(swapFeeMicros(bps, 100), null, String(bps) + ': swapFeeMicros')
    t.is(usdcFeeMicros(bps, 100), null, String(bps) + ': usdcFeeMicros')
  }
  for (const amount of [AMOUNT_MAX + 1, -1, 1.5, NaN, '100']) {
    t.is(feeCents({ cents: 0, bps: 100 }, amount), null, String(amount) + ': feeCents amount')
    t.is(swapFeeMicros(100, amount), null, String(amount) + ': swapFeeMicros amount')
  }
  t.is(cryptoFee(null, { asset: 'usdc', amount: 1 }), null, 'no rates')
  t.is(feeCents({ cents: 100000, bps: 2000 }, AMOUNT_MAX), 2000100000, 'the bounds themselves are fine')
})

test('fees: checkDebit refuses without an accepted quote', (t) => {
  const rates = zeroRates()
  rates.transfer = { cents: 10, bps: 0 }
  const refused = quote({ kind: 'transfer', amountCents: 991, rates, maxCents: 1000 })
  t.is(refused.ok, false)
  t.is(checkDebit(debitTerms(refused), refused), 'taxa-mudou', 'refused quote')
  const empty = quote()
  t.is(checkDebit(debitTerms(empty), empty), 'taxa-mudou', 'empty quote')
  const zeros = { feeCents: 0, pendingFeeCents: 0, pendingFeeRef: '', totalDebitCents: 0 }
  t.is(checkDebit(zeros, null), 'taxa-mudou', 'null quote')
  t.is(checkDebit(zeros, undefined), 'taxa-mudou', 'undefined quote')
  t.is(checkDebit(zeros, {}), 'taxa-mudou', 'object without ok')
  t.is(checkDebit(zeros, { ok: 'yes', varandaFeeCents: 0, pendingFeeCents: 0, pendingFeeRef: '', totalDebitCents: 0 }), 'taxa-mudou', 'ok must be true')

  const fake = { ok: true, varandaFeeCents: 10, pendingFeeCents: 0, pendingFeeRef: undefined, totalDebitCents: 110 }
  t.is(checkDebit({ feeCents: 10, pendingFeeCents: 0, totalDebitCents: 110 }, fake), 'taxa-mudou', 'a missing field never matches an undefined one')

  const ok = quote({ kind: 'transfer', amountCents: 100, rates })
  t.is(checkDebit(debitTerms(ok), ok), null, 'accepted quote matches')
})

test('fees: quote bounds must be safe integers', (t) => {
  const rates = zeroRates()
  for (const maxCents of [null, NaN, Infinity, -1, 1.5, '1000']) {
    const q = quote({ kind: 'transfer', amountCents: 100, rates, maxCents })
    t.is(q.ok, false, 'maxCents ' + String(maxCents))
    t.is(q.reason, 'valor-invalido')
    allSafe(t, q, 'maxCents ' + String(maxCents))
  }
  for (const minCents of [null, NaN, -Infinity, -1, 0.5, '1']) {
    const q = quote({ kind: 'transfer', amountCents: 100, rates, minCents })
    t.is(q.ok, false, 'minCents ' + String(minCents))
    t.is(q.reason, 'valor-invalido')
  }
  t.is(quote({ kind: 'transfer', amountCents: 100, rates }).ok, true, 'absent maxCents is no cap')
  t.is(quote({ kind: 'transfer', amountCents: 100, rates, maxCents: undefined }).ok, true, 'undefined maxCents is no cap')
  t.is(quote({ kind: 'transfer', amountCents: 0, rates, minCents: 0 }).ok, false, 'zero amount even with minCents 0')
  t.is(quote({ kind: 'transfer', amountCents: 1, rates, minCents: 0 }).ok, true)
  t.is(quote({ kind: 'transfer', amountCents: 0, rates, maxCents: 0 }).ok, false)
})

test('fees: cryptoFee matches the asset in any case', (t) => {
  const rates = zeroRates()
  rates.crypto = { cents: 30, bps: 150 }
  t.alike(cryptoFee(rates, { asset: 'USDC', amount: 10000000 }), cryptoFee(rates, { asset: 'usdc', amount: 10000000 }))
  t.alike(cryptoFee(rates, { asset: 'USDC', amount: 10000000 }), { asset: 'usdc', fee: 150000 })
  t.alike(cryptoFee(rates, { asset: 'BRLA', amount: 33333 }), cryptoFee(rates, { asset: 'brla', amount: 33333 }))
  t.alike(cryptoFee(rates, { asset: 'Brla', amount: 33333 }), { asset: 'brla', fee: 530 })
  t.is(cryptoFee(rates, { asset: 7, amount: 1 }), null)
  t.is(cryptoFee(rates, {}), null)
})

test('fees: dot-only treasury sub ids are refused', (t) => {
  for (const id of ['.', '..', '...']) {
    t.is(parseTreasury('sub:' + id), null, JSON.stringify(id))
    throwsRange(t, () => parseFees({ VARANDA_FEE_TREASURY: 'sub:' + id, VARANDA_FEE_PAYOUT_CENTS: '5' }),
      'VARANDA_FEE_TREASURY inválido', 'parseFees ' + JSON.stringify(id))
  }
  t.alike(parseTreasury('sub:.a'), { kind: 'sub', id: '.a' }, 'a dot with other characters is fine')
  t.alike(parseTreasury('sub:a..b'), { kind: 'sub', id: 'a..b' })
})

test('fees: isSelfTreasury', (t) => {
  const sub = parseTreasury('sub:t1')
  const addr = parseTreasury(ADDR)
  t.is(isSelfTreasury(sub, { subAccountId: 't1' }), true)
  t.is(isSelfTreasury(sub, { subAccountId: 't2', address: ADDR }), false)
  t.is(isSelfTreasury(addr, { address: '0x' + 'AB'.repeat(20) }), true)
  t.is(isSelfTreasury(addr, { subAccountId: ADDR }), false)
  t.is(isSelfTreasury(null, { subAccountId: 't1' }), false)
  t.is(isSelfTreasury(sub), false)
})

test('fees: feeReference', (t) => {
  t.is(feeReference('op-1'), 'op-1:taxa')
  const longest = 'a'.repeat(59)
  t.is(feeReference(longest).length, 64)
  throwsRange(t, () => feeReference('a'.repeat(60)), 'referência inválida', 'too long')
  throwsRange(t, () => feeReference(''), 'referência inválida', 'empty')
  throwsRange(t, () => feeReference(7), 'referência inválida', 'not a string')
})

test('fees: isActive', (t) => {
  t.is(isActive(zeroRates()), false)
  t.is(isActive({ ...zeroRates(), swap: { cents: 0, bps: 1 } }), true)
  t.is(isActive({ ...zeroRates(), crypto: { cents: 1, bps: 0 } }), true)
  t.is(isActive(null), false)
})

test('fees: describe and formatBrl', (t) => {
  const rates = zeroRates()
  rates.transfer = { cents: 50, bps: 100 }
  rates.payout = { cents: 150, bps: 0 }
  rates.crypto = { cents: 0, bps: 125 }
  rates.swap = { cents: 0, bps: 30 }
  t.alike(describe(rates), {
    transfer: 'R$ 0,50 + 1%',
    payout: 'R$ 1,50',
    crypto: '1,25%',
    deposit: 'sem taxa',
    swap: '0,3%'
  })
  t.is(describe(null).transfer, 'sem taxa')
  t.is(formatBrl(0), 'R$ 0,00')
  t.is(formatBrl(5), 'R$ 0,05')
  t.is(formatBrl(123456789), 'R$ 1.234.567,89')
  t.is(formatBrl(100000), 'R$ 1.000,00')
  t.is(formatBrl(-250), '-R$ 2,50')
})

test('fees: maxFeeCents caps the new fee alone (S5)', (t) => {
  const rates = zeroRates()
  rates.payout = { cents: 0, bps: 2000 }
  const at = quote({ kind: 'payout', amountCents: 5000000, rates, maxFeeCents: 1000000 })
  t.is(at.ok, true, 'exactly at the cap')
  t.is(at.varandaFeeCents, 1000000)
  const over = quote({ kind: 'payout', amountCents: 5000100, rates, maxFeeCents: 1000000 })
  t.is(over.ok, false)
  t.is(over.reason, 'valor-invalido')
  t.is(quote({ kind: 'payout', amountCents: 5000100, rates }).ok, true, 'absent maxFeeCents is no cap')
  for (const maxFeeCents of [null, NaN, -1, 1.5, '1000']) {
    t.is(quote({ kind: 'payout', amountCents: 100, rates, maxFeeCents }).ok, false, 'maxFeeCents ' + String(maxFeeCents))
  }
})
