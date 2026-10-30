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
//                 each called as (req, res, ctx) with ctx = { id, query, body, json }.
//                 ctx.json(res, code, obj) writes a JSON response. A map only
//                 replaces the routes it names; unknown paths answer 404.
//   fake.close()  closes the server and its connections.
//
// loopbackFetch(base) returns a fetch that throws for any URL not under base.

const http = require('node:http')
const crypto = require('node:crypto')

const KEYS_WINDOW_MS = 60000
const PROTECTED_KEY = 'psk-fake-hodle-protected-key'
const DOCUMENT_RE = /^\/api\/kyc\/document\/([^/]+)$/
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
    keysAt: new Map()
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
        protectedSymmetricKey: PROTECTED_KEY + '-' + hex(4)
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
          { network: wallet.network, asset: 'BRLA', amount: '0.00' },
          { network: 'tron', asset: 'USDT', amount: '0.00' }
        )
      }
      if (walletId !== undefined) data.walletId = walletId
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
    let m = DOCUMENT_RE.exec(path)
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

  function close () {
    return new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  return { base, seen, state, script, close }
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
