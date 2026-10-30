'use strict'

const nodeCrypto = require('node:crypto')
const { eventKey, disputeValue, disputeTarget } = require('./wallet-ops-store')

// The Hodle webhook sink of the optional payments account (mounted by
// ./server.js before the global token bucket, under /account/ so Caddy
// proxies it): POST /account/wallet/webhook/<EVENT>, one path per event,
// because Hodle signs each webhook with its own secret.
//
//   - No secrets configured: every path is the generic 404, the body unread.
//   - <EVENT>:registrar (VARANDA_HODLE_WEBHOOK_SECRETS): Hodle sends a signed
//     WEBHOOK_TEST before its secret can be copied and saves the webhook only
//     on a 2xx, so that body alone is answered 200 without verification and
//     without touching any store. Everything else is 401.
//   - <EVENT>:<hex64>: every delivery is verified, WEBHOOK_TEST included:
//     HMAC-SHA256 keyed with the secret string over "<timestamp>.<raw body>",
//     compared in constant time, the timestamp within 300 s, no Origin header
//     (Hodle's servers never send one, a browser always does) and the body's
//     event equal to the path's.
//
// A delivery only moves an operation the ledger already holds (by our own
// externalId), a member's KYC on its current attempt or a dispute flag. It
// never creates a ledger row and never moves money. A deposit or payout
// event that would end an operation never writes that status: it triggers a
// read of the operation from Hodle (`refresh`, the routes' own status read)
// and only Hodle's answer is written. A failed read answers 503 and is not
// remembered, so the sender's retry can apply it. Deliveries are
// deduplicated per event family (eventKey of ./wallet-ops-store.js) in a
// bounded set. The sink has its own fixed window, spent only by verified
// deliveries; the unsigned registrar answers have a separate small window, so
// they can never fill the one signed deliveries use. Caddy caps the path per
// client address. Logs carry only { event: 'carteira', reason } tokens.

const MAX_BODY = 16384
// Far above Hodle's real delivery rate.
const WINDOW_LIMIT = 300
const WINDOW_MS = 60 * 1000
// Registration is a few test posts by the operator's hand.
const REGISTER_LIMIT = 30
const MAX_SEEN = 4096
const SKEW_S = 300
const PATH_PREFIX = '/account/wallet/webhook/'
const EVENT_RE = /^[A-Z_]{1,48}$/
const SECRET_RE = /^[0-9a-f]{64}$/
const SIGNATURE_RE = /^[0-9a-fA-F]{64}$/
const TIMESTAMP_RE = /^[0-9]{1,12}$/
const EXTERNAL_ID_RE = /^var-[0-9a-f]{32}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const REGISTER = 'registrar'
const TEST_EVENT = 'WEBHOOK_TEST'

const DEPOSIT_EVENTS = Object.freeze({
  DEPOSIT_PIX_CONFIRMED: 'pendente',
  DEPOSIT_ASSET_SUCCESS: 'concluido',
  DEPOSIT_ASSET_FAILED: 'falhou',
  DEPOSIT_ASSET_REFUNDED: 'devolvido'
})
const PAYOUT_EVENTS = Object.freeze({
  PAYOUT_SUCCESSFUL: 'concluido',
  PAYOUT_FAILED: 'falhou',
  PAYOUT_REFUNDED: 'devolvido'
})
// A failed KYC needs new documents, as a rejection does.
const KYC_EVENTS = Object.freeze({
  KYC_APPROVED: 'aprovado',
  KYC_REJECTED: 'recusado',
  KYC_EXPIRED: 'expirado',
  KYC_FAILED: 'recusado'
})

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// The ledger keeps lowercase 0x hashes only; anything else is dropped.
function normalHash (v) {
  return typeof v === 'string' && HASH_RE.test(v) ? v.toLowerCase() : null
}

// A latest attempt id found after a lost submit belongs to the current
// attempt unless the member had it before. Entries written before the list
// existed cannot tell, so a closed result on a later attempt stays unknown.
function adoptableAttempt (kyc, attemptId, outcome) {
  const previous = Array.isArray(kyc.previousAttemptIds) ? kyc.previousAttemptIds : []
  if (previous.includes(attemptId)) return false
  if (previous.length > 0 || kyc.attempt === 1) return true
  return outcome === 'pendente' || outcome === 'aprovado'
}

// Moves a ledger row on through put(), which needs the row's own terms
// unchanged: only the status, Hodle's fee, a missing provider id or hash.
function advanceOp (ops, row, changes = {}) {
  const pick = (k) => has(changes, k) && changes[k] !== undefined && changes[k] !== null ? changes[k] : row[k]
  return ops.put({
    externalId: row.externalId,
    member: row.member,
    kind: row.kind,
    status: pick('status'),
    cents: row.cents,
    hodleFeeCents: pick('hodleFeeCents'),
    asset: row.asset,
    source: row.source,
    amountMicros: row.amountMicros,
    fee: { asset: row.fee.asset, cents: row.fee.cents, status: row.fee.status, txHash: row.fee.txHash, reference: row.fee.reference },
    providerId: pick('providerId'),
    txHash: pick('txHash'),
    to: row.to,
    pendingFeeCents: row.pendingFeeCents,
    pendingFeeRef: row.pendingFeeRef,
    totalDebitCents: row.totalDebitCents
  })
}

// Map<EVENT, 'registrar' | hex64> from the env text 'EVENT:value,EVENT:value'.
// null for an empty text. A RangeError names only the variable.
function parseWebhookSecrets (text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const out = new Map()
  for (const part of text.split(',')) {
    const item = part.trim()
    const colon = item.indexOf(':')
    const event = colon === -1 ? '' : item.slice(0, colon)
    const value = colon === -1 ? '' : item.slice(colon + 1)
    if (!EVENT_RE.test(event) || out.has(event) || (value !== REGISTER && !SECRET_RE.test(value))) {
      throw new RangeError('VARANDA_HODLE_WEBHOOK_SECRETS inválido')
    }
    out.set(event, value)
  }
  return out
}

function readRawBody (req, RouteError) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) return reject(new RouteError('pedido-invalido', 413))
    const chunks = []
    let size = 0
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      if (err) reject(err)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) return finish(new RouteError('pedido-invalido', 413))
      chunks.push(chunk)
    })
    req.on('error', () => finish(new RouteError('pedido-invalido', 400)))
    req.on('aborted', () => finish(new RouteError('pedido-invalido', 400)))
    req.on('end', () => finish(null, Buffer.concat(chunks)))
  })
}

function parseJson (raw) {
  try {
    const value = JSON.parse(raw.toString('utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function createWalletWebhook ({ secrets = null, ops = null, wallets = null, refresh = null, log = () => {}, now = Date.now, http }) {
  const { send, sendError, refuse, RouteError, fixedWindow } = http
  if (secrets !== null) {
    if (!(secrets instanceof Map)) throw new TypeError('walletWebhookSecrets must be a Map')
    for (const [event, value] of secrets) {
      if (!EVENT_RE.test(event) || (value !== REGISTER && !SECRET_RE.test(value))) {
        throw new TypeError('walletWebhookSecrets has an invalid entry')
      }
    }
  }
  if (refresh !== null && typeof refresh !== 'function') throw new TypeError('refresh must be a function')
  const seen = new Set()
  // Digest of a verified delivery -> ms until it stops verifying.
  const delivered = new Map()
  const window = fixedWindow(WINDOW_LIMIT, WINDOW_MS, now)
  const registerWindow = fixedWindow(REGISTER_LIMIT, WINDOW_MS, now)

  function note (reason) {
    log({ event: 'carteira', reason })
  }

  // Every refusal before a signature is proven: the generic 404, the body
  // never read and the socket closed once the answer is flushed.
  function hidden (req, res) {
    res.setHeader('Connection', 'close')
    res.once('finish', () => req.socket.destroy())
    sendError(res, refuse('nao-encontrado'))
  }

  // The answer is the last thing this socket carries.
  function closing (req, res) {
    res.setHeader('Connection', 'close')
    res.once('finish', () => req.socket.destroy())
  }

  function unauthorized (req, res) {
    note('webhook-recusado')
    closing(req, res)
    return refuse('nao-autorizado')
  }

  // Only deliveries that passed verification spend the window, so unsigned
  // traffic can never use it up for Hodle's own. It still bounds the
  // authoritative reads that signed deliveries trigger.
  function admit (req, res) {
    if (window()) return
    note('webhook-limite')
    closing(req, res)
    throw new RouteError('pedido-invalido', 429)
  }

  function verified (secret, raw, req) {
    const ts = req.headers['x-hodle-timestamp']
    const sig = req.headers['x-hodle-signature']
    if (typeof ts !== 'string' || !TIMESTAMP_RE.test(ts)) return false
    if (typeof sig !== 'string' || !SIGNATURE_RE.test(sig)) return false
    if (Math.abs(Math.floor(now() / 1000) - Number(ts)) > SKEW_S) return false
    const expected = nodeCrypto.createHmac('sha256', secret).update(ts + '.').update(raw).digest()
    return nodeCrypto.timingSafeEqual(Buffer.from(sig, 'hex'), expected)
  }

  function remember (key) {
    seen.add(key)
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
  }

  // A captured genuine delivery verifies for SKEW_S, so a replay is answered
  // before it can spend the shared window. Only deliveries answered 2xx are
  // recorded: a 503 or 429 must stay retryable by Hodle.
  function digest (req, raw) {
    return nodeCrypto.createHash('sha256')
      .update(req.headers['x-hodle-signature'].toLowerCase() + '.')
      .update(raw)
      .digest('hex')
  }

  function replayed (d) {
    const until = delivered.get(d)
    if (until === undefined) return false
    if (until >= now()) return true
    delivered.delete(d)
    return false
  }

  function deliveredOk (d, req) {
    // Kept for as long as verified() could still accept it.
    delivered.set(d, (Number(req.headers['x-hodle-timestamp']) + SKEW_S + 1) * 1000)
    for (const [k, until] of delivered) {
      if (delivered.size <= MAX_SEEN && until >= now()) break
      delivered.delete(k)
    }
  }

  function storage () {
    note('armazenamento-indisponivel')
    return refuse('indisponivel')
  }

  function row (externalId, kind) {
    if (ops === null || typeof externalId !== 'string' || !EXTERNAL_ID_RE.test(externalId)) return null
    let r
    try {
      r = ops.get(externalId)
    } catch {
      throw storage()
    }
    return r !== null && r.kind === kind ? r : null
  }

  async function store (fn) {
    try {
      return await fn()
    } catch {
      throw storage()
    }
  }

  // Hodle's own status for the operation, written by the routes' read.
  async function authoritative (externalId) {
    try {
      if (refresh === null) throw new Error('no reader')
      await refresh(externalId)
    } catch {
      note('webhook-leitura')
      throw refuse('indisponivel')
    }
  }

  // The KYC member and its current attempt id, for the dedupe identity.
  function kycTarget (data) {
    if (wallets === null) return null
    let member, entry
    try {
      member = wallets.bySubAccount(data.subAccountId)
      entry = member === null ? null : wallets.get(member)
    } catch {
      throw storage()
    }
    return entry === null || entry.subAccountId === null ? null : { member, entry }
  }

  async function apply (event, data) {
    let kyc = null
    if (has(KYC_EVENTS, event)) {
      // A second verification never revokes or grants on its own.
      if (data.provider === 'SECONDARY') return 'ignorado'
      kyc = kycTarget(data)
      if (kyc === null) return 'ignorado'
    }
    let current = kyc === null ? null : kyc.entry.kyc.attemptId
    // After a lost submit the attempt id was never recorded: an id this
    // member never had before is the current attempt's.
    let adopt = false
    if (kyc !== null && current === null && kyc.entry.kyc.status === 'pendente' &&
      typeof data.attemptId === 'string' && ID_RE.test(data.attemptId) &&
      adoptableAttempt(kyc.entry.kyc, data.attemptId, KYC_EVENTS[event])) {
      current = data.attemptId
      adopt = true
    }
    const key = eventKey(event, data, { currentAttemptId: current })
    if (key === null) return 'ignorado'
    if (seen.has(key)) return 'repetido'

    if (has(DEPOSIT_EVENTS, event)) {
      const r = row(data.externalId, 'deposit')
      if (r === null) return 'ignorado'
      // A partial refund keeps the charge's previous status.
      if (event === 'DEPOSIT_ASSET_REFUNDED' && data.status !== 'REFUNDED') {
        remember(key)
        return 'aplicado'
      }
      if (DEPOSIT_EVENTS[event] === 'pendente') await store(() => advanceOp(ops, r, { status: 'pendente' }))
      else await authoritative(r.externalId)
    } else if (has(PAYOUT_EVENTS, event)) {
      const r = row(data.externalId, 'payout')
      if (r === null) return 'ignorado'
      await authoritative(r.externalId)
    } else if (kyc !== null) {
      if (kyc.entry.kyc.status !== 'pendente') {
        remember(key)
        return 'aplicado'
      }
      if (adopt) await store(() => wallets.setKyc({ member: kyc.member, status: 'pendente', attempt: kyc.entry.kyc.attempt, attemptId: current }))
      await store(() => wallets.setKyc({ member: kyc.member, status: KYC_EVENTS[event], attempt: kyc.entry.kyc.attempt }))
    } else {
      const value = disputeValue(event)
      const target = disputeTarget(data)
      if (value === null || target === null || ops === null) return 'ignorado'
      let r
      try {
        r = ops.get(target)
      } catch {
        throw storage()
      }
      if (r === null) return 'ignorado'
      await store(() => ops.setDispute(target, value))
      note('contestacao')
    }
    remember(key)
    return 'aplicado'
  }

  function owns (pathname) {
    return pathname.startsWith(PATH_PREFIX)
  }

  async function handle (req, res, url) {
    if (secrets === null || req.method !== 'POST') return hidden(req, res)
    const event = url.pathname.slice(PATH_PREFIX.length)
    if (!EVENT_RE.test(event) || !secrets.has(event)) return hidden(req, res)
    if (req.headers.origin !== undefined) throw unauthorized(req, res)
    let raw
    try {
      raw = await readRawBody(req, RouteError)
    } catch (err) {
      closing(req, res)
      throw err
    }
    const secret = secrets.get(event)
    if (secret === REGISTER) {
      const body = parseJson(raw)
      if (body === null || body.event !== TEST_EVENT) throw unauthorized(req, res)
      if (!registerWindow()) {
        note('webhook-limite')
        closing(req, res)
        throw new RouteError('pedido-invalido', 429)
      }
      note('webhook-registro')
      return send(res, 200, {})
    }
    if (!verified(secret, raw, req)) throw unauthorized(req, res)
    const d = digest(req, raw)
    if (replayed(d)) {
      note('webhook-repetido')
      return send(res, 200, {})
    }
    admit(req, res)
    const body = parseJson(raw)
    if (body === null) throw unauthorized(req, res)
    if (body.event === TEST_EVENT) {
      deliveredOk(d, req)
      return send(res, 200, {})
    }
    if (body.event !== event) throw unauthorized(req, res)
    if (!isPlainObject(body.data)) {
      deliveredOk(d, req)
      note('webhook-ignorado')
      return send(res, 200, {})
    }
    const outcome = await apply(event, body.data)
    deliveredOk(d, req)
    note('webhook-' + outcome)
    send(res, 200, {})
  }

  function stats () {
    return { seen: seen.size }
  }

  return { owns, handle, stats }
}

module.exports = {
  createWalletWebhook,
  parseWebhookSecrets,
  advanceOp,
  normalHash,
  adoptableAttempt,
  MAX_BODY
}
