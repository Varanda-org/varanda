'use strict'

// Loopback fake of the Hodle API (onboarding subset), shared by the client and
// route tests. Nothing here touches the network: the server listens on
// 127.0.0.1 port 0 and loopbackFetch refuses every URL outside it. Default
// answers are shaped after the documented examples.
//
// const fake = await startFakeHodle()
//   fake.base     'http://127.0.0.1:<port>', pass as endpoints.base
//   fake.seen     every request, in order: { method, path, query, headers, body }
//                 (body is the parsed JSON when it parses, else the raw string)
//   fake.state    the in-memory provider:
//                   subaccounts      Map id -> { name }
//                   documents        Map id -> { subAccountId, documentType, ready }
//                   kyc              Map attemptId -> { subAccountId, status }
//                   wallets          Map subAccountId -> [{ id, address, network, protectedSymmetricKey }]
//                   walletCreates    number of successful wallet creations
//                   now              fake clock in ms, advanced by the tests
//                   keysAt           Map subAccountId -> fake time of the last wallet/keys call
//                   balances         Map subAccountId -> BRLA cents, moved by payouts and transfers
//                   deposits         Map externalId -> deposit record
//                   quotes           Map quoteId -> the quoted fields and `used`
//                   payouts          Map transactionId -> payout record (status settable)
//                   transfers        Map reference -> transfer record
//                   pinFailures      Map walletId -> wrong PIN count (3 locks the wallet)
//                   depositFeeCents  fee of a new deposit, in cents
//                   payoutFeeCents   fee of a payout or quote, in cents
//                   payoutStatus     null (a new payout answers PROCESSING and
//                                    stays PENDING) or the status a new payout
//                                    answers and keeps, e.g. 'COMPLETED'
//                   sends            counts of executed money calls: { deposit, payout, transfer }
//   fake.script(handlers)
//                 replaces the routes. `handlers` is either a function
//                 (req, res, ctx) or a map with any of:
//                   createSubaccount POST /api/subaccount
//                   listSubaccounts  GET  /api/subaccount
//                   kycDocument      POST /api/kyc/document
//                   documentReady    GET  /api/kyc/document/:id
//                   kycSubmit        POST /api/kyc
//                   kycStatus        GET  /api/kyc/:id
//                   kycLatest        GET  /api/kyc?subAccountId=
//                   walletCreate     POST /api/wallet/create
//                   walletKeys       POST /api/wallet/keys
//                   walletGet        POST /api/wallet/get
//                   deposit          POST /api/deposit/asset
//                   depositStatus    GET  /api/deposit/:id
//                   payoutQuote      POST /api/wallet/payout/beneficiary
//                   payout           POST /api/wallet/payout
//                   payoutStatus     GET  /api/wallet/payout/:id
//                   transfer         POST /api/wallet/transfer
//                   statement        POST /api/account/statement
//                 each called as (req, res, ctx) with ctx = { id, query, body, json }.
//                 ctx.json(res, code, obj) writes a JSON response. A map only
//                 replaces the routes it names; unknown paths answer 404.
//   fake.apply(name, ctx)
//                 runs the default route `name` without answering, so a scripted
//                 handler can execute a call and then drop or delay the response.
//                 Returns { code, body }.
//   fake.settleDeposit(externalId)
//                 marks a deposit paid and credits its value minus the fee.
//   fake.close()  closes the server and its connections.
//
// loopbackFetch(base) returns a fetch that throws for any URL not under base.

const http = require('node:http')
const crypto = require('node:crypto')

const KEYS_WINDOW_MS = 60000
const PROTECTED_KEY = 'psk-fake-hodle-protected-key'
const DOCUMENT_RE = /^\/api\/kyc\/document\/([^/]+)$/
const DEPOSIT_RE = /^\/api\/deposit\/([^/]+)$/
const PAYOUT_RE = /^\/api\/wallet\/payout\/([^/]+)$/
const PIX_KEY_TYPES = new Set(['PHONE', 'CPF', 'EMAIL', 'RANDOM', 'CNPJ'])
const PER_TX_LIMIT_CENTS = 300000
const PIN_ATTEMPTS = 3
const KYC_RE = /^\/api\/kyc\/([^/]+)$/

function json (res, code, obj, headers = {}) {
  const text = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers
  })
  res.end(text)
}

function hex (n) {
  return crypto.randomBytes(n).toString('hex')
}

function amountText (cents) {
  const s = String(cents).padStart(3, '0')
  return s.slice(0, -2) + '.' + s.slice(-2)
}

function amountCents (text) {
  const m = /^([0-9]+)(?:\.([0-9]{1,18}))?$/.exec(String(text))
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] || '').slice(0, 2).padEnd(2, '0'))
}

function txHash () {
  return '0x' + hex(32)
}

function notFound (res, what) {
  json(res, 404, { success: false, error: what + ' not found' })
}

async function startFakeHodle () {
  const seen = []
  const state = {
    subaccounts: new Map(),
    documents: new Map(),
    kyc: new Map(),
    wallets: new Map(),
    walletCreates: 0,
    now: 0,
    keysAt: new Map(),
    balances: new Map(),
    deposits: new Map(),
    quotes: new Map(),
    payouts: new Map(),
    transfers: new Map(),
    pinFailures: new Map(),
    depositFeeCents: 100,
    payoutFeeCents: 75,
    payoutStatus: null,
    sends: { deposit: 0, payout: 0, transfer: 0 }
  }
  let seq = 0

  function stamp () {
    seq++
    return { seq, createdAt: new Date(Date.now() + seq).toISOString() }
  }

  function balanceOf (subAccountId) {
    return state.balances.get(subAccountId) || 0
  }

  function move (subAccountId, cents) {
    state.balances.set(subAccountId, balanceOf(subAccountId) + cents)
  }

  // Wrong PIN or protected key -> 400 with a bare message, as documented.
  // The third wrong PIN locks the wallet; later calls are refused even with
  // the right PIN.
  function checkCredentials (res, wallet, b) {
    const failures = state.pinFailures.get(wallet.id) || 0
    if (failures >= PIN_ATTEMPTS) {
      json(res, 400, { success: false, error: 'PIN locked for 24 hours after three failures' })
      return false
    }
    if (b.walletPin !== wallet.pin) {
      state.pinFailures.set(wallet.id, failures + 1)
      json(res, 400, { success: false, error: 'Invalid PIN' })
      return false
    }
    if (b.protectedSymmetricKey !== wallet.protectedSymmetricKey) {
      json(res, 400, { success: false, error: 'Invalid protected key' })
      return false
    }
    return true
  }

  function depositBody (dep) {
    return {
      success: true,
      externalId: dep.externalId,
      qrCode: dep.qrCode,
      qrCodeImage: 'https://api.hodle.com.br/api/public/qrcode/' + dep.walletCharge + '.png',
      expiresAt: dep.expiresAt,
      fee: dep.feeCents,
      fxRateAtTx: 1,
      walletCharge: dep.walletCharge
    }
  }

  function payoutBody (p) {
    return {
      success: true,
      transactionId: p.transactionId,
      status: p.answer,
      stableAmount: amountText(p.value + p.feeCents),
      valueInBrl: amountText(p.value),
      fee: amountText(p.feeCents),
      network: p.network,
      asset: 'BRLA',
      jobId: String(p.seq)
    }
  }

  function findWallet (subAccountId, walletId) {
    const list = state.wallets.get(subAccountId) || []
    if (walletId === undefined) return list[0] || null
    return list.find((w) => w.id === walletId) || null
  }

  const defaults = {
    createSubaccount (req, res, ctx) {
      const name = ctx.body && ctx.body.name
      if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
        return json(res, 400, { success: false, error: 'Validation failed' })
      }
      const id = crypto.randomUUID()
      state.subaccounts.set(id, { name })
      json(res, 201, { success: true, data: { subAccountId: id } })
    },
    listSubaccounts (req, res, ctx) {
      const filter = ctx.query.get('name') || ''
      const items = []
      for (const [id, sub] of state.subaccounts) {
        if (sub.name.includes(filter)) items.push({ id, name: sub.name, accountType: 'INDIVIDUAL' })
      }
      json(res, 200, { success: true, data: items })
    },
    kycDocument (req, res, ctx) {
      const { subAccountId, documentType, isDoubleSided } = ctx.body || {}
      if (!state.subaccounts.has(subAccountId)) return notFound(res, 'Subaccount')
      const documentId = 'doc_' + hex(6)
      state.documents.set(documentId, { subAccountId, documentType, ready: false })
      if (documentType === 'SELFIE-FROM-LIVENESS') {
        const sessionId = crypto.randomUUID()
        return json(res, 201, {
          success: true,
          data: {
            documentId,
            sessionId,
            livenessUrl: 'https://app.hodle.com.br/liveness/' + documentId + '#sessionId=' + sessionId + '&token=eyJfake',
            validateLivenessToken: 'eyJfake',
            livenessIdentityPoolId: 'eu-west-1:fake',
            livenessRegion: 'eu-west-1'
          }
        })
      }
      const data = { documentId, uploadUrlFront: 'https://uploads.hodle.com.br/' + documentId + '/front' }
      if (isDoubleSided) data.uploadUrlBack = 'https://uploads.hodle.com.br/' + documentId + '/back'
      json(res, 201, { success: true, data })
    },
    documentReady (req, res, ctx) {
      const doc = state.documents.get(ctx.id)
      if (!doc || doc.subAccountId !== ctx.query.get('subAccountId')) return notFound(res, 'Document')
      json(res, 200, {
        success: true,
        data: {
          documentId: ctx.id,
          ready: doc.ready,
          documentType: doc.documentType,
          uploadStatusFront: doc.ready ? 'COMPLETED' : 'WAITING-UPLOAD'
        }
      })
    },
    kycSubmit (req, res, ctx) {
      const b = ctx.body || {}
      if (!state.subaccounts.has(b.subAccountId)) return notFound(res, 'Subaccount')
      const attemptId = 'att_' + hex(6)
      const status = b.sandboxReject === true ? 'REJECTED' : 'APPROVED'
      state.kyc.set(attemptId, { subAccountId: b.subAccountId, status })
      json(res, 202, {
        success: true,
        data: { attemptId, subAccountId: b.subAccountId, status: 'PENDING', createdAt: '2026-05-09T22:00:00.000Z' }
      })
    },
    kycLatest (req, res, ctx) {
      const subAccountId = ctx.query.get('subAccountId')
      if (!state.subaccounts.has(subAccountId)) return notFound(res, 'Subaccount')
      let last = null
      for (const [id, attempt] of state.kyc) if (attempt.subAccountId === subAccountId) last = [id, attempt]
      const data = { subAccountId, lastAttemptId: last ? last[0] : null }
      if (last) data.status = last[1].status
      json(res, 200, { success: true, data })
    },
    kycStatus (req, res, ctx) {
      const attempt = state.kyc.get(ctx.id)
      if (!attempt) return notFound(res, 'Attempt')
      const rejected = attempt.status === 'REJECTED'
      json(res, 200, {
        success: true,
        data: {
          attemptId: ctx.id,
          subAccountId: attempt.subAccountId,
          status: attempt.status,
          level: 1,
          rejectionReason: rejected ? 'SANDBOX_SIMULATED' : null,
          rejectionLabels: [],
          createdAt: '2026-05-09T22:00:00.000Z',
          updatedAt: '2026-05-09T22:01:43.000Z'
        }
      })
    },
    walletCreate (req, res, ctx) {
      const { subAccountId, walletPin, network = 'polygon' } = ctx.body || {}
      if (!state.subaccounts.has(subAccountId)) return notFound(res, 'Subaccount')
      if (typeof walletPin !== 'string' || !/^[0-9]{6}$/.test(walletPin)) {
        return json(res, 400, { success: false, error: 'Invalid PIN' })
      }
      const wallet = {
        id: hex(12),
        address: '0x' + hex(20).toUpperCase().replace(/^(.)/, 'a'),
        network,
        protectedSymmetricKey: PROTECTED_KEY + '-' + hex(4),
        pin: walletPin
      }
      const list = state.wallets.get(subAccountId) || []
      list.push(wallet)
      state.wallets.set(subAccountId, list)
      state.walletCreates++
      json(res, 201, {
        success: true,
        data: {
          id: wallet.id,
          address: wallet.address,
          network: wallet.network,
          chainId: 84532,
          balance: '0',
          protectedSymmetricKey: wallet.protectedSymmetricKey
        }
      })
    },
    walletKeys (req, res, ctx) {
      const { subAccountId, walletId } = ctx.body || {}
      const last = state.keysAt.get(subAccountId)
      if (last !== undefined && state.now - last < KEYS_WINDOW_MS) {
        const wait = Math.ceil((KEYS_WINDOW_MS - (state.now - last)) / 1000)
        return json(res, 429, { success: false, error: 'Too many requests' }, { 'Retry-After': String(wait) })
      }
      state.keysAt.set(subAccountId, state.now)
      if (!state.subaccounts.has(subAccountId)) return notFound(res, 'Subaccount')
      const wallet = findWallet(subAccountId, walletId)
      if (!wallet) return notFound(res, 'Wallet')
      json(res, 200, {
        success: true,
        data: { walletId: wallet.id, protectedSymmetricKey: wallet.protectedSymmetricKey, email: 'membro@example.com' }
      })
    },
    walletGet (req, res, ctx) {
      const { subAccountId, walletId } = ctx.body || {}
      if (!state.subaccounts.has(subAccountId)) return notFound(res, 'Subaccount')
      const wallet = findWallet(subAccountId, walletId)
      if (walletId !== undefined && !wallet) return notFound(res, 'Wallet')
      const data = { subAccountId, addresses: {}, balances: [], syncedAt: '2026-05-09T22:14:00.000Z' }
      if (wallet) {
        data.addresses[wallet.network] = wallet.address
        data.addresses.tron = 'TQHvPfake'
        data.balances.push(
          { network: wallet.network, asset: 'BRLA', amount: amountText(balanceOf(subAccountId)) },
          { network: 'tron', asset: 'USDT', amount: '0.00' }
        )
      }
      if (walletId !== undefined) data.walletId = walletId
      json(res, 200, { success: true, data })
    },
    deposit (req, res, ctx) {
      const b = ctx.body || {}
      if (!state.subaccounts.has(b.subAccountId)) return notFound(res, 'Subaccount')
      if (!Number.isSafeInteger(b.value) || b.value < 100 || b.asset !== 'BRLA' || typeof b.address !== 'string') {
        return json(res, 400, { success: false, error: 'Validation failed' })
      }
      const known = state.deposits.get(b.externalId)
      if (known) {
        if (known.subAccountId !== b.subAccountId) {
          return json(res, 409, { success: false, error: 'A deposit with this externalId already exists' })
        }
        return json(res, 200, depositBody(known))
      }
      const expiresIn = Number.isSafeInteger(b.expiresIn) ? b.expiresIn : 600
      const dep = {
        ...stamp(),
        externalId: b.externalId,
        subAccountId: b.subAccountId,
        walletCharge: hex(12),
        trackId: 'trk_' + hex(6),
        value: b.value,
        feeCents: state.depositFeeCents,
        status: 'PENDING',
        network: b.network,
        address: b.address,
        qrCode: '00020126580014br.gov.bcb.pix0136' + crypto.randomUUID() + '5204000053039865802BR5913Fulano de Tal6009Sao Paulo6304ABCD',
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
      }
      state.deposits.set(dep.externalId, dep)
      state.sends.deposit++
      json(res, 200, depositBody(dep))
    },
    depositStatus (req, res, ctx) {
      let dep = state.deposits.get(ctx.id)
      if (!dep) for (const d of state.deposits.values()) if (d.walletCharge === ctx.id || d.trackId === ctx.id) dep = d
      if (!dep || dep.subAccountId !== ctx.query.get('subAccountId')) return notFound(res, 'Deposit')
      json(res, 200, {
        success: true,
        data: {
          externalId: dep.externalId,
          walletCharge: dep.walletCharge,
          trackId: dep.trackId,
          status: dep.status,
          processingStep: null,
          asset: 'BRLA',
          network: dep.network,
          address: dep.address,
          value: dep.value,
          valueInBrl: amountText(dep.value),
          fee: dep.feeCents,
          feeInBrl: amountText(dep.feeCents),
          fxRateAtTx: 1,
          transactionHash: dep.status === 'COMPLETED' ? dep.txHash : null,
          qrCode: dep.qrCode,
          qrCodeImage: 'https://api.hodle.com.br/api/public/qrcode/' + dep.walletCharge + '.png',
          expiresAt: dep.expiresAt,
          payer: dep.status === 'COMPLETED' ? { name: 'FULANO DE TAL', taxId: '12345678901' } : null,
          createdAt: dep.createdAt,
          updatedAt: dep.createdAt
        }
      })
    },
    payoutQuote (req, res, ctx) {
      const b = ctx.body || {}
      if (!Number.isSafeInteger(b.value) || b.value < 10 || typeof b.pixKey !== 'string' || !PIX_KEY_TYPES.has(b.pixKeyType)) {
        return json(res, 400, { success: false, error: 'Validation failed' })
      }
      const quoteId = crypto.randomUUID()
      const quote = {
        value: b.value,
        network: b.network,
        asset: b.asset,
        pixKey: b.pixKey,
        pixKeyType: b.pixKeyType,
        subAccountId: b.subAccountId,
        walletId: b.walletId,
        taxId: b.taxId,
        feeCents: state.payoutFeeCents,
        used: false
      }
      state.quotes.set(quoteId, quote)
      json(res, 200, {
        success: true,
        status: 'PENDING',
        quoteId,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        settlement: 'OWN_ACCOUNT',
        network: b.network,
        asset: 'BRLA',
        pixKey: b.pixKey,
        pixKeyOwner: { name: 'Thiago Mota dos Santos', taxId: '545.***.***-10', bankName: 'NU PAGAMENTOS - IP' },
        quote: {
          inputAmount: (b.value + quote.feeCents) / 100,
          inputCurrency: 'BRLA',
          outputAmount: b.value / 100,
          outputCurrency: 'BRL',
          rate: 1,
          fee: quote.feeCents / 100
        },
        payoutId: hex(12),
        correlationId: quoteId
      })
    },
    payout (req, res, ctx) {
      const b = ctx.body || {}
      if (!state.subaccounts.has(b.subAccountId)) return notFound(res, 'Subaccount')
      const wallet = findWallet(b.subAccountId, b.walletId)
      if (!wallet) return notFound(res, 'Wallet')
      if (!checkCredentials(res, wallet, b)) return
      for (const p of state.payouts.values()) {
        if (b.externalId !== undefined && p.externalId === b.externalId) {
          return json(res, 202, { ...payoutBody(p), alreadyProcessed: true })
        }
      }
      if (!Number.isSafeInteger(b.value) || b.value < 10) return json(res, 400, { success: false, error: 'Validation failed' })
      let quote = null
      if (b.quoteId !== undefined) {
        quote = state.quotes.get(b.quoteId)
        if (!quote || quote.used) return json(res, 400, { success: false, error: 'Quote expired, used or unknown' })
        if (b.pixKey !== undefined || b.pixKeyType !== undefined) {
          return json(res, 400, { success: false, error: 'pixKey comes from the quote' })
        }
        for (const k of ['value', 'network', 'asset', 'subAccountId', 'walletId', 'taxId']) {
          if (b[k] !== quote[k]) return json(res, 400, { success: false, error: 'Fields differ from the quote' })
        }
      } else if (typeof b.pixKey !== 'string' || !PIX_KEY_TYPES.has(b.pixKeyType)) {
        return json(res, 400, { success: false, error: 'Validation failed' })
      }
      if (b.value > PER_TX_LIMIT_CENTS) {
        return json(res, 403, { success: false, error: 'Limit exceeded', errorCode: 'PER_TX_LIMIT_EXCEEDED' })
      }
      const feeCents = quote ? quote.feeCents : state.payoutFeeCents
      if (balanceOf(b.subAccountId) < b.value + feeCents) {
        return json(res, 400, { success: false, error: 'Insufficient balance for the payout', errorCode: 'INSUFFICIENT_BALANCE' })
      }
      if (quote) quote.used = true
      move(b.subAccountId, -(b.value + feeCents))
      const p = {
        ...stamp(),
        transactionId: hex(12),
        externalId: b.externalId,
        subAccountId: b.subAccountId,
        network: b.network,
        value: b.value,
        feeCents,
        status: state.payoutStatus || 'PENDING',
        answer: state.payoutStatus || 'PROCESSING',
        txHash: txHash(),
        endToEndId: 'E' + hex(15).toUpperCase()
      }
      state.payouts.set(p.transactionId, p)
      state.sends.payout++
      json(res, 202, payoutBody(p))
    },
    payoutStatus (req, res, ctx) {
      const p = state.payouts.get(ctx.id)
      if (!p) return notFound(res, 'Payout')
      const done = p.status === 'COMPLETED'
      json(res, 200, {
        success: true,
        data: {
          transactionId: p.transactionId,
          status: p.status,
          network: p.network,
          txHash: p.status === 'PENDING' ? null : p.txHash,
          endToEndId: done ? p.endToEndId : null,
          valueInBrl: amountText(p.value),
          fee: amountText(p.feeCents),
          pixKey: 'recipient@example.com',
          creditParty: done ? { name: 'MARIA SOUZA', taxId: '***.241.413-**' } : null,
          failureCode: p.status === 'REFUNDED' ? 'PAYOUT_FAILED' : null,
          failureReason: p.status === 'REFUNDED' ? 'Chave Pix de MARIA SOUZA inválida' : null,
          createdAt: p.createdAt,
          updatedAt: p.createdAt
        }
      })
    },
    transfer (req, res, ctx) {
      const b = ctx.body || {}
      const from = b.fromSubAccountId
      if (!state.subaccounts.has(from)) return notFound(res, 'Subaccount')
      const wallet = findWallet(from, b.walletId)
      if (!wallet) return notFound(res, 'Wallet')
      if (!checkCredentials(res, wallet, b)) return
      if (b.reference !== undefined && state.transfers.has(b.reference)) {
        const first = state.transfers.get(b.reference)
        return json(res, 409, {
          success: false,
          error: 'A transfer with this reference already exists',
          transactionId: first.transactionId,
          status: 'COMPLETED',
          txHash: first.txHash
        })
      }
      if ((b.toSubAccountId === undefined) === (b.recipientAddress === undefined)) {
        return json(res, 400, { success: false, error: 'Provide toSubAccountId or recipientAddress' })
      }
      let recipientAddress = b.recipientAddress
      if (b.toSubAccountId !== undefined) {
        const target = findWallet(b.toSubAccountId)
        if (!state.subaccounts.has(b.toSubAccountId) || !target) {
          return json(res, 400, { success: false, error: 'Unresolvable recipient' })
        }
        recipientAddress = target.address
      }
      const cents = amountCents(b.amount)
      if (b.asset !== 'BRLA' || cents === null || cents < 1) return json(res, 400, { success: false, error: 'Validation failed' })
      if (balanceOf(from) < cents) return json(res, 400, { success: false, error: 'Insufficient balance', errorCode: 'INSUFFICIENT_BALANCE' })
      move(from, -cents)
      if (b.toSubAccountId !== undefined) move(b.toSubAccountId, cents)
      const record = {
        ...stamp(),
        transactionId: hex(12),
        reference: b.reference,
        from,
        to: b.toSubAccountId,
        cents,
        txHash: txHash()
      }
      if (b.reference !== undefined) state.transfers.set(b.reference, record)
      else state.transfers.set('unreferenced-' + record.seq, record)
      state.sends.transfer++
      json(res, 200, { success: true, data: { txHash: record.txHash, recipientAddress, amount: b.amount } })
    },
    statement (req, res, ctx) {
      const b = ctx.body || {}
      const sub = b.subAccountId
      if (!state.subaccounts.has(sub)) return notFound(res, 'Subaccount')
      const ops = []
      const base = (rec, type, direction, cents, feeCents, status) => ({
        seq: rec.seq,
        id: 'op_' + rec.seq,
        type,
        status,
        amount: amountText(cents),
        asset: 'BRLA',
        network: 'polygon',
        valueInBrl: amountText(cents),
        fee: amountText(feeCents),
        txHash: null,
        endToEndId: null,
        externalId: null,
        reference: null,
        direction,
        createdAt: rec.createdAt,
        completedAt: null,
        vendorNote: 'dropped by the client'
      })
      for (const d of state.deposits.values()) {
        if (d.subAccountId !== sub) continue
        ops.push({ ...base(d, 'deposit', 'in', d.value, d.feeCents, d.status), externalId: d.externalId, txHash: d.txHash || null })
      }
      for (const p of state.payouts.values()) {
        if (p.subAccountId !== sub) continue
        ops.push({ ...base(p, 'payout', 'out', p.value, p.feeCents, p.status), externalId: p.externalId, txHash: p.txHash, endToEndId: p.endToEndId })
      }
      for (const t of state.transfers.values()) {
        const ref = t.reference === undefined ? null : t.reference
        if (t.from === sub) ops.push({ ...base(t, 'transfer', 'out', t.cents, 0, 'COMPLETED'), reference: ref, txHash: t.txHash })
        if (t.to === sub) ops.push({ ...base(t, 'transfer', 'in', t.cents, 0, 'COMPLETED'), reference: ref, txHash: t.txHash })
      }
      const types = b.type === undefined ? null : [].concat(b.type)
      const rows = ops.filter((op) => !types || types.includes(op.type)).sort((x, y) => y.seq - x.seq)
      const start = b.cursor === undefined ? 0 : Number(b.cursor)
      const limit = Number.isSafeInteger(b.limit) ? b.limit : 50
      const page = rows.slice(start, start + limit).map(({ seq, ...op }) => op)
      const data = { balances: [], subAccountId: sub, operations: page, total: rows.length }
      if (start + limit < rows.length) data.nextCursor = String(start + limit)
      json(res, 200, { success: true, data })
    }
  }
  let routes = { ...defaults }
  let handler = null

  function route (method, path) {
    if (path === '/api/subaccount') {
      if (method === 'POST') return ['createSubaccount', null]
      if (method === 'GET') return ['listSubaccounts', null]
    }
    if (method === 'POST' && path === '/api/kyc/document') return ['kycDocument', null]
    if (method === 'POST' && path === '/api/kyc') return ['kycSubmit', null]
    if (method === 'GET' && path === '/api/kyc') return ['kycLatest', null]
    if (method === 'POST' && path === '/api/wallet/create') return ['walletCreate', null]
    if (method === 'POST' && path === '/api/wallet/keys') return ['walletKeys', null]
    if (method === 'POST' && path === '/api/wallet/get') return ['walletGet', null]
    if (method === 'POST' && path === '/api/deposit/asset') return ['deposit', null]
    if (method === 'POST' && path === '/api/wallet/payout/beneficiary') return ['payoutQuote', null]
    if (method === 'POST' && path === '/api/wallet/payout') return ['payout', null]
    if (method === 'POST' && path === '/api/wallet/transfer') return ['transfer', null]
    if (method === 'POST' && path === '/api/account/statement') return ['statement', null]
    let m = DEPOSIT_RE.exec(path)
    if (method === 'GET' && m) return ['depositStatus', decodeURIComponent(m[1])]
    m = PAYOUT_RE.exec(path)
    if (method === 'GET' && m) return ['payoutStatus', decodeURIComponent(m[1])]
    m = DOCUMENT_RE.exec(path)
    if (method === 'GET' && m) return ['documentReady', decodeURIComponent(m[1])]
    m = KYC_RE.exec(path)
    if (method === 'GET' && m) return ['kycStatus', decodeURIComponent(m[1])]
    return [null, null]
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = raw
      try { body = JSON.parse(raw) } catch {}
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname
      seen.push({ method: req.method, path, query: url.search, headers: req.headers, body })
      const ctx = { id: null, query: url.searchParams, body, json }
      if (handler) return handler(req, res, ctx)
      if (!/^Bearer hodle_(live|test)_/.test(String(req.headers.authorization || ''))) {
        return json(res, 401, { success: false, error: 'Invalid API key' })
      }
      const [name, id] = route(req.method, path)
      if (!name) return res.writeHead(404).end()
      ctx.id = id
      return routes[name](req, res, ctx)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port

  function script (handlers) {
    if (typeof handlers === 'function') {
      handler = handlers
      return
    }
    handler = null
    routes = { ...defaults, ...(handlers || {}) }
  }

  function apply (name, ctx) {
    const sink = {
      code: 0,
      text: '',
      writeHead (code) { this.code = code; return this },
      end (text) { this.text = text || '' }
    }
    defaults[name](null, sink, { id: null, query: new URLSearchParams(), json, ...ctx })
    let parsed = sink.text
    try { parsed = JSON.parse(sink.text) } catch {}
    return { code: sink.code, body: parsed }
  }

  function settleDeposit (externalId) {
    const dep = state.deposits.get(externalId)
    if (!dep || dep.status === 'COMPLETED') return
    dep.status = 'COMPLETED'
    dep.txHash = txHash()
    move(dep.subAccountId, dep.value - dep.feeCents)
  }

  function close () {
    return new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  return { base, seen, state, script, apply, settleDeposit, close }
}

// A fetch that refuses any origin other than the fake, so a wrong default can
// never reach the real network.
function loopbackFetch (base) {
  return (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
}

// Raw bodies of the flat money endpoints, copied from the documented examples.
const FIXTURES = Object.freeze({
  deposit: {
    success: true,
    externalId: 'my-order-123',
    qrCode: '00020101021226...',
    qrCodeImage: 'https://api.hodle.com.br/api/public/qrcode/66fc0b7e2a4b5c6d7e8f9012.png',
    expiresAt: '2026-10-05T14:10:00.000Z',
    fee: 100,
    fxRateAtTx: 408000.50,
    walletCharge: '66fc0b7e2a4b5c6d7e8f9012'
  },
  quote: {
    success: true,
    status: 'PENDING',
    quoteId: 'b0f1c7de-9f2b-4a71-9c1e-2f4e2a1d6c88',
    expiresAt: '2026-08-31T14:35:00.000Z',
    settlement: 'OWN_ACCOUNT',
    network: 'base',
    asset: 'BRLA',
    pixKey: 'recipient@example.com',
    pixKeyOwner: { name: 'Thiago Mota dos Santos', taxId: '545.***.***-10', bankName: 'NU PAGAMENTOS - IP' },
    quote: { inputAmount: 50.75, inputCurrency: 'BRLA', outputAmount: 50, outputCurrency: 'BRL', rate: 1, fee: 0.75 },
    payoutId: '6a878236a83b0a4e8cc8c40b',
    correlationId: 'b0f1c7de-9f2b-4a71-9c1e-2f4e2a1d6c88'
  },
  payout: {
    success: true,
    transactionId: '65f1a8',
    status: 'PROCESSING',
    stableAmount: '9.31',
    valueInBrl: '50.00',
    fee: '1.55',
    network: 'polygon',
    asset: 'USDT',
    jobId: '1'
  }
})

module.exports = { startFakeHodle, loopbackFetch, FIXTURES, PROTECTED_KEY, KEYS_WINDOW_MS }
