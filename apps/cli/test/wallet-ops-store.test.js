'use strict'

// apps/cli/lib/account/wallet-ops-store.js: the wallet-ops.json ledger of
// Pix, transfers, crypto sends and swaps with their Varanda fee legs. No
// network; the clock is injected and disk failures are simulated by wrapping
// fs functions.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const ops = require('../lib/account/wallet-ops-store')
const { openWalletOpsStore, externalIdFor, FILE, PRUNE_CAP } = ops
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-29T12:00:00.000Z')
const DAY = 24 * 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()
const TX = '0x' + 'ab'.repeat(32)
const TX2 = '0x' + 'cd'.repeat(32)

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function opId () {
  return b4a.toString(crypto.randomBytes(16), 'base64').replace(/[+/=]/g, 'x').slice(0, 22)
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: T0, now: () => c.t }
  const open = (more = {}) => openWalletOpsStore(dir, { now: c.now, ...opts, ...more })
  return { dir, file: path.join(dir, FILE), c, open, store: open() }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

async function typeErrors (t, fn, cases) {
  for (const args of cases) {
    try {
      await fn(args)
      t.fail('accepted ' + JSON.stringify(args))
    } catch (err) {
      t.ok(err instanceof TypeError, 'TypeError for ' + JSON.stringify(args))
    }
  }
}

function readFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// A payout put() input with a 50 cent Varanda fee, owed once accepted.
function payout (member, more = {}) {
  const externalId = externalIdFor(member, 'payout', more.opId || opId())
  const { opId: _, fee, ...rest } = more
  return {
    externalId,
    member,
    kind: 'payout',
    status: 'enviado',
    cents: 1000,
    hodleFeeCents: 175,
    fee: { cents: 50, status: 'pendente', reference: externalId + ':taxa', ...fee },
    to: '***1234',
    totalDebitCents: 1225,
    ...rest
  }
}

function deposit (member, more = {}) {
  return {
    externalId: externalIdFor(member, 'deposit', opId()),
    member,
    kind: 'deposit',
    status: 'enviado',
    cents: 5000,
    fee: { cents: 0, status: 'nenhuma' },
    ...more
  }
}

test('externalIdFor is var- plus 32 hex of sha256(member:kind:opId)', (t) => {
  const m = memberKey()
  const id = 'abcdefghijklmnopqrstuv'
  const want = 'var-' + nodeCrypto.createHash('sha256').update(m + ':payout:' + id).digest('hex').slice(0, 32)
  t.is(externalIdFor(m, 'payout', id), want)
  t.is(externalIdFor(m, 'payout', id), externalIdFor(m, 'payout', id), 'stable')
  t.not(externalIdFor(m, 'transfer', id), want, 'kind is bound')
  t.not(externalIdFor(memberKey(), 'payout', id), want, 'member is bound')
  for (const bad of ['short', 'a'.repeat(44), 'abcdefghijklmnopqrstu!', 'abcdefghijklmnopqrstu.']) {
    t.exception.all(() => externalIdFor(m, 'payout', bad), TypeError, 'opId ' + bad)
  }
  t.exception.all(() => externalIdFor(m, 'other', id), TypeError, 'kind')
  t.exception.all(() => externalIdFor('xy', 'payout', id), TypeError, 'member')
})

test('a missing file opens empty and writes nothing', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  t.ok(store.available())
  t.is(store.get('var-' + '0'.repeat(32)), null)
  t.is(store.get('nope'), null, 'any input is just absent')
  t.alike(store.listByMember(m), [])
  t.alike(store.pendingFees(m), [])
  t.is(store.stats().ops, 0)
  t.is(await store.heal(), false)
  t.alike(await store.prune(T0), { changed: false, removed: 0 })
  t.alike(fs.readdirSync(dir), [], 'nothing written')
})

test('put writes the exact row, mode 0600, and get returns a copy', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const p = payout(m)
  t.alike(await store.put(p), { changed: true })
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600')
  const want = {
    member: m,
    kind: 'payout',
    status: 'enviado',
    cents: 1000,
    hodleFeeCents: 175,
    asset: 'BRLA',
    source: null,
    amountMicros: null,
    fee: { asset: 'BRL', cents: 50, status: 'pendente', txHash: null, reference: p.externalId + ':taxa' },
    providerId: null,
    txHash: null,
    to: '***1234',
    dispute: null,
    suporte: false,
    pendingFeeCents: 0,
    pendingFeeRef: null,
    totalDebitCents: 1225,
    createdAt: iso(T0),
    updatedAt: iso(T0)
  }
  t.alike(readFile(file), { v: 1, ops: { [p.externalId]: want } })
  t.alike(store.get(p.externalId), { externalId: p.externalId, ...want })
  const copy = store.get(p.externalId)
  copy.fee.status = 'cobrada'
  copy.status = 'concluido'
  t.is(store.get(p.externalId).status, 'enviado', 'get returns a copy')
  t.is(store.get(p.externalId).fee.status, 'pendente')
})

test('shape validation: masked destinations only, fee object required, closed keys', async (t) => {
  const { store, dir } = setup(t)
  const m = memberKey()
  await typeErrors(t, (args) => store.put(args), [
    payout(m, { to: '12345678901' }),
    payout(m, { to: '***12345678901' }),
    payout(m, { to: 'fulano@example.com' }),
    payout(m, { to: '+5511987654321' }),
    payout(m, { to: '123e4567-e89b-12d3-a456-426614174000' }),
    payout(m, { to: '1234' }),
    payout(m, { to: '@fulano' }),
    payout(m, { kind: 'transfer', to: '***1234' }),
    payout(m, { kind: 'crypto', to: '0x' + 'ab'.repeat(20) }),
    payout(m, { kind: 'transfer', to: '@12345678901' }),
    { ...payout(m), fee: undefined },
    { ...payout(m), fee: null },
    payout(m, { fee: { cents: 0, status: 'pendente' } }),
    payout(m, { fee: { cents: 50, status: 'nenhuma' } }),
    payout(m, { fee: { pin: '1234' } }),
    payout(m, { pin: '123456' }),
    payout(m, { cpf: '52998224725' }),
    payout(m, { pixKey: 'fulano@example.com' }),
    payout(m, { qrCode: '000201' }),
    payout(m, { balance: 10 }),
    payout(m, { dispute: 'aberta' }),
    payout(m, { createdAt: iso(T0) }),
    payout(m, { status: 'expirado' }),
    payout(m, { status: 'feito' }),
    payout(m, { cents: -1 }),
    payout(m, { cents: 1.5 }),
    payout(m, { externalId: 'var-xyz' }),
    payout(m, { member: 'ab' }),
    payout(m, { providerId: 'a b' }),
    payout(m, { txHash: '0x1234' }),
    payout(m, { pendingFeeCents: 30 }),
    payout(m, { pendingFeeRef: 'var-' + '1'.repeat(32) + ':taxa' }),
    deposit(m, { asset: 'USDC' }),
    deposit(m, { to: '***1234' }),
    null,
    'x'
  ])
  t.alike(fs.readdirSync(dir), [], 'nothing written')
  for (const [kind, to] of [['payout', '***1234'], ['payout', '***.com'], ['transfer', '@fulana'], ['crypto', '0x..abcdef']]) {
    t.alike(await store.put(payout(m, { kind, to })), { changed: true }, kind + ' ' + to)
  }
})

test('main status is monotonic; concluido -> devolvido; incerto may become anything', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  const p = payout(m)
  const id = p.externalId
  await store.put(p)
  c.t += 1000
  t.alike(await store.put({ ...p, status: 'incerto' }), { changed: true })
  t.alike(await store.put({ ...p, status: 'enviado' }), { changed: true }, 'incerto may become anything')
  t.alike(await store.put({ ...p, status: 'pendente', providerId: 'tx_1' }), { changed: true })
  t.is(store.get(id).providerId, 'tx_1')
  t.alike(await store.put({ ...p, status: 'enviado' }), { changed: false }, 'never back')
  t.alike(await store.put({ ...p, status: 'incerto' }), { changed: false }, 'known accepted is never uncertain again')
  t.alike(await store.put({ ...p, status: 'concluido', providerId: 'tx_other' }), { changed: true })
  t.is(store.get(id).providerId, 'tx_1', 'first provider id kept')
  t.alike(await store.put({ ...p, status: 'falhou' }), { changed: false }, 'concluido is final')
  t.alike(await store.put({ ...p, status: 'pendente' }), { changed: false })
  t.alike(await store.put({ ...p, status: 'devolvido' }), { changed: true }, 'concluido -> devolvido')
  t.alike(await store.put({ ...p, status: 'concluido' }), { changed: false }, 'devolvido is final')
  t.is(store.get(id).status, 'devolvido')
  t.ok(store.get(id).updatedAt > store.get(id).createdAt)

  const f = payout(m)
  await store.put(f)
  await store.put({ ...f, status: 'falhou' })
  t.alike(await store.put({ ...f, status: 'concluido' }), { changed: false }, 'falhou is final for a payout')
  t.alike(await store.put({ ...f, status: 'devolvido' }), { changed: false })
})

test('dispute sits beside concluido and never touches the status', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const d = deposit(m)
  await store.put(d)
  await store.put({ ...d, status: 'concluido' })
  t.alike(await store.setDispute(d.externalId, 'aberta'), { changed: true })
  t.is(store.get(d.externalId).status, 'concluido')
  t.is(store.get(d.externalId).dispute, 'aberta')
  t.alike(await store.setDispute(d.externalId, 'aberta'), { changed: false })
  t.alike(await store.setDispute(d.externalId, 'aceita'), { changed: true })
  t.alike(await store.setDispute(d.externalId, 'aberta'), { changed: false }, 'never reopened')
  t.alike(await store.setDispute(d.externalId, 'rejeitada'), { changed: false }, 'one decision')
  t.is(store.get(d.externalId).status, 'concluido')
  t.alike(await store.put({ ...d, status: 'devolvido' }), { changed: true })
  t.is(store.get(d.externalId).dispute, 'aceita', 'put keeps the dispute')
  t.alike(await store.setDispute('var-' + 'f'.repeat(32), 'aberta'), { changed: false, missing: true })
  await typeErrors(t, (v) => store.setDispute(d.externalId, v), [null, 'aberto', 'canceled'])
  await typeErrors(t, (id) => store.setDispute(id, 'aberta'), ['var-1', null])
})

test('setFee: cobrada is final, txHash and reference kept once known', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const p = payout(m, { fee: { reference: null } })
  const id = p.externalId
  await store.put(p)
  t.alike(await store.setFee(id, { status: 'enviada', reference: id + ':taxa' }), { changed: true })
  t.alike(await store.setFee(id, { status: 'incerta' }), { changed: true })
  t.alike(await store.setFee(id, { status: 'cobrada', txHash: TX }), { changed: true })
  t.alike(await store.setFee(id, { status: 'pendente', txHash: TX2, reference: 'other' }), { changed: false })
  t.alike(store.get(id).fee, { asset: 'BRL', cents: 50, status: 'cobrada', txHash: TX, reference: id + ':taxa' })
  t.alike(await store.setFee(id, { status: 'nenhuma' }), { changed: false }, 'a fee never becomes none')
  t.alike(await store.setFee('var-' + 'f'.repeat(32), { status: 'cobrada' }), { changed: false, missing: true })
  await typeErrors(t, (f) => store.setFee(id, f), [
    { status: 'paga' }, { cents: 10 }, { txHash: 'x' }, { reference: 'a b' }, null, { status: 'cobrada', pin: '1' }
  ])
})

test('C2: each leg written before dispatch; WALLET_BUSY fee stays pendente; PIN failure leaves nothing owed', async (t) => {
  const { store, file } = setup(t)
  const m = memberKey()
  const p = payout(m)
  const id = p.externalId
  // (1) principal: on disk as enviado before the call, fee not yet owed.
  await store.put(p)
  t.is(readFile(file).ops[id].status, 'enviado')
  t.alike(store.pendingFees(m), [], 'no fee before the principal is accepted')
  await store.put({ ...p, status: 'pendente', providerId: 'tx_1' })
  // (2) the fee leg: on disk as enviada before its call.
  await store.setFee(id, { status: 'enviada' })
  t.is(readFile(file).ops[id].fee.status, 'enviada')
  t.alike(store.pendingFees(m), [], 'an enviada leg is never re-presented')
  // 409 WALLET_BUSY, or a 409 for the reference without completed/txHash.
  await store.setFee(id, { status: 'pendente' })
  t.alike(store.pendingFees(m), [], 'not collectable while the principal is pending')
  await store.put({ ...p, status: 'concluido', providerId: 'tx_1' })
  t.alike(store.pendingFees(m).map((e) => e.externalId), [id], 'collectable once the payout concluded')
  // (3) re-presented in the next send with the same reference.
  const next = payout(m, { pendingFeeCents: 50, pendingFeeRef: id + ':taxa', totalDebitCents: 1275 })
  await store.put(next)
  await store.setFee(id, { status: 'enviada' })
  await store.setFee(id, { status: 'cobrada', txHash: TX })
  t.alike(store.pendingFees(m), [], 'collected once')
  t.is(store.get(next.externalId).pendingFeeRef, id + ':taxa')

  // PIN_INVALID on the principal: it fails, its fee is never owed.
  const bad = payout(m)
  await store.put(bad)
  await store.put({ ...bad, status: 'falhou' })
  t.alike(store.pendingFees(m), [])
  // An aborted principal call is not proof of refusal: incerto, fee not owed.
  const lost = payout(m)
  await store.put(lost)
  await store.put({ ...lost, status: 'incerto' })
  t.alike(store.pendingFees(m), [], 'no fee while the principal is uncertain')
  t.is(store.get(lost.externalId).fee.status, 'pendente', 'partial outcomes stay separate')
})

test('C10: a repeated opId with different terms is divergent and writes nothing', async (t) => {
  const { store, file, c } = setup(t)
  const m = memberKey()
  const p = payout(m, { pendingFeeCents: 30, pendingFeeRef: 'var-' + '1'.repeat(32) + ':taxa', totalDebitCents: 1255 })
  await store.put(p)
  const before = fs.readFileSync(file, 'utf8')
  c.t += 1000
  for (const more of [
    { cents: 1001 }, { fee: { ...p.fee, cents: 51 } }, { to: '***9999' }, { pendingFeeCents: 0, pendingFeeRef: null },
    { pendingFeeRef: 'var-' + '2'.repeat(32) + ':taxa' }, { totalDebitCents: 1256 }
  ]) {
    t.alike(await store.put({ ...p, ...more, status: 'pendente' }), { changed: false, divergent: true }, JSON.stringify(more))
  }
  t.is(fs.readFileSync(file, 'utf8'), before, 'nothing written')
  t.alike(await store.put({ ...p, status: 'pendente', hodleFeeCents: 175 }), { changed: true }, 'same terms move on')
})

test('C7: deposit statuses, late Pix after expirado, falhou until devolvido', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  t.is(ops.depositStatus('PENDING'), 'pendente')
  t.is(ops.depositStatus('FIAT_PAID'), 'pendente')
  t.is(ops.depositStatus('PROCESSING'), 'pendente')
  t.is(ops.depositStatus('COMPLETED'), 'concluido')
  t.is(ops.depositStatus('EXPIRED'), 'expirado')
  t.is(ops.depositStatus('FAILED'), 'falhou')
  t.is(ops.depositStatus('REFUNDED'), 'devolvido')
  t.is(ops.depositStatus('weird'), null)

  const late = deposit(m)
  await store.put(late)
  await store.put({ ...late, status: 'pendente', providerId: 'trk_1', hodleFeeCents: 200 })
  t.is(store.get(late.externalId).hodleFeeCents, 200, 'partner fee recorded from the answer')
  await store.put({ ...late, status: 'expirado' })
  t.is(store.get(late.externalId).hodleFeeCents, 200, 'an update without the fee keeps it')
  t.is(store.get(late.externalId).providerId, 'trk_1')
  t.alike(await store.put({ ...late, status: 'concluido' }), { changed: true }, 'a late Pix is honoured')

  // A 409 on create is reconciled by a status read: incerto -> pendente.
  const dup = deposit(m)
  await store.put(dup)
  await store.put({ ...dup, status: 'incerto' })
  t.alike(await store.put({ ...dup, status: ops.depositStatus('PENDING') }), { changed: true })

  const failed = deposit(m)
  await store.put(failed)
  await store.put({ ...failed, status: 'falhou' })
  c.t += 100 * DAY
  t.alike(await store.prune(c.t), { changed: true, removed: 1 }, 'only the concluded deposit goes')
  t.is(store.get(late.externalId), null)
  t.ok(store.get(failed.externalId), 'a failed deposit is not final')
  t.ok(store.get(dup.externalId), 'pendente is not final')
  t.alike(await store.put({ ...failed, status: 'devolvido' }), { changed: true })
  await typeErrors(t, (a) => store.put(a), [payout(m, { status: 'expirado' })])
})

test('C3: dispute mapping, target and dedupe identities across two members and reordered deliveries', async (t) => {
  const { store } = setup(t)
  const a = memberKey()
  const b = memberKey()
  t.is(ops.disputeValue('DISPUTE_CREATED'), 'aberta')
  t.is(ops.disputeValue('DISPUTE_ACCEPTED'), 'aceita')
  t.is(ops.disputeValue('DISPUTE_REJECTED'), 'rejeitada')
  t.is(ops.disputeValue('DISPUTE_CANCELED'), 'cancelada')
  t.is(ops.disputeValue('PAYOUT_FAILED'), null)

  const da = deposit(a)
  const db = deposit(b)
  for (const d of [da, db]) {
    await store.put(d)
    await store.put({ ...d, status: 'concluido' })
  }
  const payload = (id, e2e) => ({ endToEndId: e2e, walletCharge: { id: 'x', externalId: id } })
  t.is(ops.disputeTarget(payload(da.externalId, 'E1')), da.externalId)
  t.is(ops.disputeTarget(payload('my-order-123', 'E1')), null, 'only our ids')
  t.is(ops.disputeTarget({ walletCharge: 'x' }), null)
  t.is(ops.disputeTarget(null), null)

  // Member a: cancel arrives before created. Member b: created then rejected.
  const deliveries = [
    ['DISPUTE_CANCELED', payload(da.externalId, 'Ea')],
    ['DISPUTE_CREATED', payload(db.externalId, 'Eb')],
    ['DISPUTE_CREATED', payload(da.externalId, 'Ea')],
    ['DISPUTE_REJECTED', payload(db.externalId, 'Eb')],
    ['DISPUTE_CREATED', payload(db.externalId, 'Eb')]
  ]
  const seen = new Set()
  let acted = 0
  for (const [event, data] of deliveries) {
    const key = ops.eventKey(event, data)
    if (seen.has(key)) continue
    seen.add(key)
    acted++
    await store.setDispute(ops.disputeTarget(data), ops.disputeValue(event))
  }
  t.is(acted, 4, 'the repeated DISPUTE_CREATED for b is deduped')
  t.is(store.get(da.externalId).dispute, 'cancelada', 'a late created never reopens')
  t.is(store.get(db.externalId).dispute, 'rejeitada')
  t.is(store.get(da.externalId).status, 'concluido')

  t.is(ops.eventKey('DEPOSIT_ASSET_SUCCESS', { eventId: 'deposit-completed-1' }), 'deposit:deposit-completed-1')
  t.is(ops.eventKey('DEPOSIT_PIX_CONFIRMED', { eventId: 'deposit-completed-1' }), 'deposit:deposit-completed-1',
    'deposits dedupe by eventId alone')
  t.is(ops.eventKey('PAYOUT_SUCCESSFUL', { transactionId: 't1' }), 'PAYOUT_SUCCESSFUL:t1')
  t.not(ops.eventKey('PAYOUT_REFUNDED', { transactionId: 't1' }), ops.eventKey('PAYOUT_SUCCESSFUL', { transactionId: 't1' }))
  t.is(ops.eventKey('KYC_APPROVED', { attemptId: 'att_a' }, { currentAttemptId: 'att_a' }), 'KYC_APPROVED:att_a')
  t.is(ops.eventKey('KYC_APPROVED', { attemptId: 'att_old' }, { currentAttemptId: 'att_a' }), null, 'not the current attempt')
  t.is(ops.eventKey('KYC_APPROVED', { attemptId: 'att_a' }), null)
  t.is(ops.eventKey('DISPUTE_CREATED', { endToEndId: 'E1' }), 'DISPUTE_CREATED:E1')
  t.is(ops.eventKey('DEPOSIT_ASSET_FAILED', {}), null)
  t.is(ops.eventKey('OTHER', { eventId: 'x' }), null)
  t.is(ops.eventKey('PAYOUT_FAILED', null), null)
})

test('owner amendment 2: swap rows in USDC with the support flag', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  t.alike(ops.swapStatus('RUNNING'), { status: 'pendente', suporte: false })
  t.alike(ops.swapStatus('COMPLETED'), { status: 'concluido', suporte: false })
  t.alike(ops.swapStatus('FAILED'), { status: 'falhou', suporte: true })
  t.alike(ops.swapStatus('STRANDED'), { status: 'falhou', suporte: true })
  t.is(ops.swapStatus('x'), null)

  const swap = {
    externalId: externalIdFor(m, 'swap', opId()),
    member: m,
    kind: 'swap',
    status: 'enviado',
    cents: 0,
    amountMicros: 2500000,
    fee: { cents: 10000, status: 'pendente' },
    providerId: 'swap_1'
  }
  await store.put(swap)
  const row = store.get(swap.externalId)
  t.is(row.asset, 'USDC')
  t.is(row.fee.asset, 'USDC')
  t.is(row.fee.cents, 10000, 'fee in USDC micros')
  t.is(row.amountMicros, 2500000)
  await typeErrors(t, (a) => store.put(a), [
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), cents: 5 },
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), amountMicros: 0 },
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), amountMicros: null },
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), asset: 'BRLA' },
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), fee: { asset: 'BRL', cents: 1, status: 'pendente' } },
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), to: '0x..abcdef' },
    { ...swap, externalId: externalIdFor(m, 'swap', opId()), suporte: true }
  ])
  await store.put({ ...swap, status: ops.swapStatus('RUNNING').status })
  const s = ops.swapStatus('STRANDED')
  await store.put({ ...swap, status: s.status })
  t.is(store.get(swap.externalId).suporte, true, 'a failed swap awaits the operator')
  t.is(store.stats().suporte, 1)
  await store.put({ ...swap, status: 'falhou' })
  t.alike(await store.clearSupport(swap.externalId), { changed: true })
  t.alike(await store.put({ ...swap, status: 'falhou' }), { changed: false }, 'a later put never sets it again')
  t.is(store.get(swap.externalId).suporte, false)
  t.alike(await store.clearSupport(swap.externalId), { changed: false })

  const p = payout(m)
  await store.put(p)
  await store.put({ ...p, status: 'falhou' })
  t.is(store.get(p.externalId).suporte, false, 'only swap-backed rows get the flag')
})

test('owner amendment 3: USDC sends from the USDC balance or from BRLA', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const send = (more) => ({
    externalId: externalIdFor(m, 'crypto', opId()),
    member: m,
    kind: 'crypto',
    status: 'enviado',
    cents: 0,
    fee: { cents: 30, status: 'pendente' },
    to: '0x..abcdef',
    ...more
  })
  const brla = send({ cents: 1000 })
  await store.put(brla)
  t.is(store.get(brla.externalId).asset, 'BRLA')
  t.is(store.get(brla.externalId).source, 'BRLA')

  const fromUsdc = send({ asset: 'USDC', source: 'USDC', amountMicros: 1000000, providerId: 'tx_9' })
  await store.put(fromUsdc)
  await store.put({ ...fromUsdc, status: 'falhou' })
  t.is(store.get(fromUsdc.externalId).suporte, false, 'a plain USDC send is not swap-backed')

  const fromBrla = send({ asset: 'USDC', source: 'BRLA', amountMicros: 1000000, cents: 560, providerId: 'swap_7' })
  await store.put(fromBrla)
  await store.put({ ...fromBrla, status: ops.swapStatus('RUNNING').status })
  await store.put({ ...fromBrla, status: ops.swapStatus('FAILED').status })
  t.is(store.get(fromBrla.externalId).suporte, true, 'a USDC send funded from BRLA follows the swap mapping')
  t.is(store.get(fromBrla.externalId).fee.asset, 'BRL')

  t.is(store.get(brla.externalId).fee.asset, 'BRL', 'a BRLA send pays the fee in centavos')
  t.is(store.get(fromUsdc.externalId).fee.asset, 'USDC', 'a send from the USDC balance pays the fee in USDC')
  const usdcFee = send({ asset: 'USDC', source: 'USDC', amountMicros: 1000000, fee: { asset: 'USDC', cents: 150000, status: 'pendente' } })
  t.alike(await store.put(usdcFee), { changed: true }, 'an explicit USDC fee of 150000 micros')
  t.alike(store.get(usdcFee.externalId).fee, { asset: 'USDC', cents: 150000, status: 'pendente', txHash: null, reference: null })
  await typeErrors(t, (a) => store.put(a), [
    send({ asset: 'USDC', source: 'USDC', amountMicros: 1, fee: { asset: 'BRL', cents: 30, status: 'pendente' } }),
    send({ asset: 'USDC', source: 'BRLA', amountMicros: 1, fee: { asset: 'USDC', cents: 30, status: 'pendente' } }),
    send({ fee: { asset: 'USDC', cents: 30, status: 'pendente' } }),
    payout(m, { fee: { asset: 'USDC' } })
  ])

  await typeErrors(t, (a) => store.put(a), [
    send({ asset: 'BRLA', source: 'USDC' }),
    send({ asset: 'USDC', source: 'USDC' }),
    send({ asset: 'USDC', source: 'USDC', amountMicros: 1.5 }),
    send({ asset: 'BRLA', amountMicros: 10 }),
    send({ asset: 'USDT', source: 'USDT', amountMicros: 1 }),
    send({ kind: 'transfer', to: '@fulana', asset: 'USDC', source: 'USDC', amountMicros: 1 }),
    send({ to: '0x' + 'ab'.repeat(20) })
  ])
})

test('an update keeps every stored field the input leaves out', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const d = deposit(m)
  await store.put(d)
  await store.put({ ...d, status: 'pendente', hodleFeeCents: 200, providerId: 'trk_1', txHash: TX })
  t.alike(await store.put({ externalId: d.externalId, status: 'concluido' }), { changed: true }, 'minimal input')
  const row = store.get(d.externalId)
  t.is(row.status, 'concluido')
  t.is(row.hodleFeeCents, 200)
  t.is(row.providerId, 'trk_1')
  t.is(row.txHash, TX)
  t.alike(row.fee, { asset: 'BRL', cents: 0, status: 'nenhuma', txHash: null, reference: null })
  await store.put({ ...d, status: 'concluido', hodleFeeCents: 210 })
  t.is(store.get(d.externalId).hodleFeeCents, 210, 'an explicit value still updates')

  const p = payout(m)
  await store.put(p)
  await store.setFee(p.externalId, { status: 'enviada', txHash: TX2 })
  t.alike(await store.put({ externalId: p.externalId, status: 'pendente', fee: {} }), { changed: true })
  t.alike(store.get(p.externalId).fee, { asset: 'BRL', cents: 50, status: 'enviada', txHash: TX2, reference: p.externalId + ':taxa' })
  t.is(store.get(p.externalId).totalDebitCents, 1225, 'terms are kept, not divergent')
  t.alike(await store.put({ externalId: p.externalId, status: 'concluido', cents: 999 }), { changed: false, divergent: true })
  await typeErrors(t, (a) => store.put(a), [{ externalId: externalIdFor(m, 'payout', opId()), status: 'enviado' }])
})

test('listByMember: newest first, bounded, only that member', async (t) => {
  const { store, c } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const ids = []
  for (let i = 0; i < 55; i++) {
    c.t = T0 + i * 1000
    const p = payout(a)
    ids.push(p.externalId)
    await store.put(p)
  }
  await store.put(payout(b))
  const list = store.listByMember(a)
  t.is(list.length, 20, 'default limit')
  t.is(list[0].externalId, ids[54])
  t.is(store.listByMember(a, { limit: 50 }).length, 50)
  t.is(store.listByMember(a, { limit: 50 })[49].externalId, ids[5])
  t.is(store.listByMember(b).length, 1)
  t.ok(store.listByMember(a).every((e) => e.member === a))
  await typeErrors(t, (o) => store.listByMember(a, o), [{ limit: 51 }, { limit: 0 }, { limit: 1.5 }])
  t.exception.all(() => store.listByMember('x'), TypeError)
})

test('pendingFees: pendente or incerta on a concluded principal, oldest first, at most 20', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  const other = memberKey()
  const ids = []
  for (let i = 0; i < 25; i++) {
    c.t = T0 + (25 - i) * 1000
    const p = payout(m)
    ids.push(p.externalId)
    await store.put(p)
    await store.put({ ...p, status: 'concluido' })
    if (i % 3 === 0) {
      await store.setFee(p.externalId, { status: 'enviada' })
      await store.setFee(p.externalId, { status: 'incerta' })
    }
  }
  const q = payout(other)
  await store.put(q)
  await store.put({ ...q, status: 'concluido' })
  const list = store.pendingFees(m)
  t.is(list.length, 20, 'bounded')
  t.alike(list.map((e) => e.externalId), ids.slice().reverse().slice(0, 20), 'oldest first')
  t.ok(list.every((e) => e.member === m))
  t.ok(list.some((e) => e.fee.status === 'incerta'))
  await store.setFee(ids[24], { status: 'cobrada' })
  t.not(store.pendingFees(m)[0].externalId, ids[24])
  const ref = payout(m)
  await store.put(ref)
  await store.put({ ...ref, status: 'concluido' })
  await store.put({ ...ref, status: 'devolvido' })
  t.absent(store.pendingFees(m).some((e) => e.externalId === ref.externalId), 'not collected after a refund')
  const open = payout(m)
  await store.put(open)
  await store.put({ ...open, status: 'pendente' })
  t.absent(store.pendingFees(m).some((e) => e.externalId === open.externalId), 'not collected before the payout concludes')
})

test('prune keeps non-final rows, outstanding fees, open disputes and the support flag', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  const make = async (status, more = {}, fee) => {
    const p = payout(m, more)
    await store.put(p)
    if (status !== 'enviado') await store.put({ ...p, status })
    if (fee) await store.setFee(p.externalId, { status: fee })
    return p.externalId
  }
  const done = await make('concluido', {}, 'cobrada')
  const noFee = await make('falhou')
  const owed = await make('concluido')
  const sent = await make('falhou', {}, 'enviada')
  const open = await make('enviado')
  const unsure = await make('incerto')
  const pend = await make('pendente')
  const d = deposit(m)
  await store.put(d)
  await store.put({ ...d, status: 'concluido' })
  await store.setDispute(d.externalId, 'aberta')
  const swapId = externalIdFor(m, 'swap', opId())
  await store.put({ externalId: swapId, member: m, kind: 'swap', status: 'falhou', cents: 0, amountMicros: 1, fee: { cents: 0, status: 'nenhuma' } })

  c.t += 89 * DAY
  t.alike(await store.prune(c.t), { changed: false, removed: 0 }, 'nothing under 90 days')
  c.t += 2 * DAY
  t.alike(await store.prune(c.t), { changed: true, removed: 2 })
  t.is(store.get(done), null)
  t.is(store.get(noFee), null, 'a failed principal owes no fee')
  for (const id of [owed, sent, open, unsure, pend, d.externalId, swapId]) t.ok(store.get(id), 'kept ' + id)
})

test('prune caps the file, oldest final first, never a non-final row', async (t) => {
  const { file, c } = setup(t)
  const m = memberKey()
  const state = { v: 1, ops: {} }
  const base = {
    member: m,
    kind: 'transfer',
    cents: 1,
    hodleFeeCents: 0,
    asset: 'BRLA',
    source: null,
    amountMicros: null,
    fee: { asset: 'BRL', cents: 0, status: 'nenhuma', txHash: null, reference: null },
    providerId: null,
    txHash: null,
    to: null,
    dispute: null,
    suporte: false,
    pendingFeeCents: 0,
    pendingFeeRef: null,
    totalDebitCents: 1
  }
  const n = PRUNE_CAP + 5
  for (let i = 0; i < n; i++) {
    const at = iso(T0 + i * 1000)
    const id = 'var-' + i.toString(16).padStart(32, '0')
    state.ops[id] = { ...base, status: i < 10 ? 'pendente' : 'concluido', createdAt: at, updatedAt: at }
  }
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  const s2 = openWalletOpsStore(path.dirname(file), { now: c.now })
  t.alike(await s2.prune(T0 + n * 1000), { changed: true, removed: 5 })
  const ids = Object.keys(readFile(file).ops)
  t.is(ids.length, PRUNE_CAP)
  for (let i = 0; i < 10; i++) t.ok(s2.get('var-' + i.toString(16).padStart(32, '0')), 'non-final kept')
  for (let i = 10; i < 15; i++) t.is(s2.get('var-' + i.toString(16).padStart(32, '0')), null, 'oldest final removed')
  t.ok(s2.get('var-' + (15).toString(16).padStart(32, '0')))
})

test('merges with disk after an external rewrite', async (t) => {
  const { store, file, open, c } = setup(t)
  const m = memberKey()
  const p = payout(m)
  await store.put(p)
  const other = open()
  c.t += 1000
  await other.put({ ...p, status: 'pendente', providerId: 'tx_1' })
  await other.setFee(p.externalId, { status: 'enviada' })
  const q = payout(m)
  await other.put(q)
  // The first holder still believes enviado; its next write must not undo.
  c.t += 1000
  const r = payout(m)
  await store.put(r)
  const disk = readFile(file).ops
  t.is(disk[p.externalId].status, 'pendente', 'later status kept')
  t.is(disk[p.externalId].providerId, 'tx_1')
  t.is(disk[p.externalId].fee.status, 'enviada')
  t.ok(disk[q.externalId], 'external row adopted')
  t.ok(disk[r.externalId])
  t.is(store.get(q.externalId).externalId, q.externalId, 'memory adopts the disk rows')
  // A stale holder moving the same row forward still merges.
  await store.put({ ...p, status: 'concluido' })
  t.is(readFile(file).ops[p.externalId].status, 'concluido')
  t.is(readFile(file).ops[p.externalId].fee.status, 'enviada')
  // heal brings a rewritten file back up to date.
  const state = readFile(file)
  delete state.ops[r.externalId]
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  t.is(await store.heal(), true)
  t.ok(readFile(file).ops[r.externalId])
  t.is(await store.heal(), false)
})

test('a malformed file is unavailable and never rewritten', async (t) => {
  const m = memberKey()
  const valid = () => {
    const at = iso(T0)
    return {
      member: m,
      kind: 'payout',
      status: 'enviado',
      cents: 1,
      hodleFeeCents: 0,
      asset: 'BRLA',
      source: null,
      amountMicros: null,
      fee: { asset: 'BRL', cents: 0, status: 'nenhuma', txHash: null, reference: null },
      providerId: null,
      txHash: null,
      to: null,
      dispute: null,
      suporte: false,
      pendingFeeCents: 0,
      pendingFeeRef: null,
      totalDebitCents: 1,
      createdAt: at,
      updatedAt: at
    }
  }
  const id = 'var-' + 'a'.repeat(32)
  const bad = [
    'not json',
    JSON.stringify({ v: 2, ops: {} }),
    JSON.stringify({ v: 1, ops: {}, extra: 1 }),
    JSON.stringify({ v: 1, ops: { 'var-1': valid() } }),
    JSON.stringify({ v: 1, ops: { [id]: { ...valid(), pin: '1234' } } }),
    JSON.stringify({ v: 1, ops: { [id]: { ...valid(), to: '52998224725' } } }),
    JSON.stringify({ v: 1, ops: { [id]: { ...valid(), fee: { ...valid().fee, qrCode: 'x' } } } }),
    JSON.stringify({ v: 1, ops: { [id]: { ...valid(), suporte: true } } }),
    JSON.stringify({ v: 1, ops: { [id]: { ...valid(), createdAt: iso(T0 + 1) } } })
  ]
  for (const text of bad) {
    const { file, open } = setup(t)
    fs.writeFileSync(file, text, { mode: 0o600 })
    const store = open()
    t.absent(store.available(), 'unavailable: ' + text.slice(0, 40))
    t.exception(() => store.get(id), /indisponivel/)
    t.exception(() => store.listByMember(m), /indisponivel/)
    t.exception(() => store.stats(), /indisponivel/)
    await rejects(t, store.put(payout(m)), 'indisponivel', 'put')
    await rejects(t, store.setFee(id, { status: 'cobrada' }), 'indisponivel', 'setFee')
    t.is(await store.heal(), false)
    t.is(fs.readFileSync(file, 'utf8'), text, 'never rewritten')
  }
  const { file, open } = setup(t)
  fs.writeFileSync(file, JSON.stringify({ v: 1, ops: { [id]: valid() } }), { mode: 0o600 })
  t.ok(open().get(id), 'a valid file opens')
})

test('a failed write leaves memory as it was; readOnly never writes; guard refuses', async (t) => {
  const { store, file, dir, open } = setup(t)
  const m = memberKey()
  const { renameSync } = fs
  t.teardown(() => { fs.renameSync = renameSync }, { force: true })
  fs.renameSync = () => { throw new Error('disk full') }
  const p = payout(m)
  await rejects(t, store.put(p), 'indisponivel', 'write failure')
  fs.renameSync = renameSync
  t.is(store.get(p.externalId), null, 'not in memory')
  t.ok(store.available())
  await store.put(p)
  t.ok(readFile(file).ops[p.externalId])

  const ro = open({ readOnly: true })
  await rejects(t, ro.put(payout(m)), 'indisponivel', 'readOnly')
  t.ok(ro.get(p.externalId), 'readOnly reads')

  const g = { ok: true }
  const guarded = open({ guard: () => g.ok })
  g.ok = false
  await rejects(t, guarded.put(payout(m)), 'indisponivel', 'guard')
  t.is(Object.keys(readFile(file).ops).length, 1)
  t.ok(fs.readdirSync(dir).every((f) => f === FILE), 'no stray files')
})

test('stats counts kinds, statuses, fees, open disputes and support', async (t) => {
  const { store } = setup(t)
  const m = memberKey()
  const p = payout(m)
  await store.put(p)
  const d = deposit(m)
  await store.put(d)
  await store.put({ ...d, status: 'concluido' })
  await store.setDispute(d.externalId, 'aberta')
  const s = store.stats()
  t.is(s.ops, 2)
  t.is(s.byKind.payout, 1)
  t.is(s.byKind.deposit, 1)
  t.is(s.byStatus.enviado, 1)
  t.is(s.byStatus.concluido, 1)
  t.is(s.fees.pendente, 1)
  t.is(s.fees.nenhuma, 1)
  t.is(s.disputesOpen, 1)
  t.is(s.suporte, 0)
})

test('unresolvedDebits: every enviado or incerto debit of the member, however many rows follow', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  const other = memberKey()
  const lost = payout(m)
  await store.put(lost)
  await store.put({ ...lost, status: 'incerto' })
  for (let i = 0; i < 60; i++) {
    c.t += 1000
    await store.put(deposit(m))
  }
  await store.put(deposit(m, { status: 'incerto' }))
  await store.put(payout(other))
  t.absent(store.listByMember(m, { limit: 50 }).some((e) => e.externalId === lost.externalId), 'pushed out of the latest 50')
  t.alike(store.unresolvedDebits(m).map((e) => e.externalId), [lost.externalId], 'deposits are not debits')
  await store.put({ ...lost, status: 'concluido' })
  t.alike(store.unresolvedDebits(m), [])
  t.is(store.unresolvedDebits(other).length, 1)
})

test('outstandingFees: sums every pendente, enviada or incerta BRL fee whose principal may still conclude, no cap (S11, S12)', async (t) => {
  const { store, c } = setup(t)
  const m = memberKey()
  const other = memberKey()
  t.alike(store.outstandingFees(m), { cents: 0, count: 0 })
  const ids = []
  for (let i = 0; i < 25; i++) {
    c.t = T0 + (25 - i) * 1000
    const p = payout(m)
    ids.push(p.externalId)
    await store.put(p)
    await store.put({ ...p, status: 'concluido' })
    if (i % 3 === 0) await store.setFee(p.externalId, { status: 'enviada' })
    if (i % 5 === 0) await store.setFee(p.externalId, { status: 'incerta' })
  }
  t.ok(store.pendingFees(m).length <= 20, 'the display list stays capped')
  t.alike(store.outstandingFees(m), { cents: 25 * 50, count: 25 }, 'all 25 summed')
  await store.setFee(ids[0], { status: 'cobrada' })
  const unsure = payout(m)
  await store.put(unsure)
  const failed = payout(m)
  await store.put(failed)
  await store.put({ ...failed, status: 'falhou' })
  const undone = payout(m)
  await store.put(undone)
  await store.put({ ...undone, status: 'concluido' })
  await store.put({ ...undone, status: 'devolvido' })
  const q = payout(other)
  await store.put(q)
  await store.put({ ...q, status: 'concluido' })
  t.alike(store.outstandingFees(m), { cents: 25 * 50, count: 25 }, 'an enviado principal may still conclude; not cobrada, falhou, a refund or another member')
  store.fail()
  t.exception(() => store.outstandingFees(m), 'an unreadable store refuses')
})
