'use strict'

// Outbound-only client for the Hodle payments API (the subaccount, KYC, the
// PIN-protected wallet and its BRLA money calls: balance, statement, Pix
// deposit, Pix payout and on-chain transfer), used by the account service.
// Money crosses this module as integer BRL cents; the provider's decimal
// strings are converted with string arithmetic only, never through a float.
// The API key, the wallet PIN, the CPF and the vendor JSON never leave this
// module in a result or an error: every failure collapses into
// { ok: false, reason } with a coarse `reason` token ('http-403', 'tempo',
// 'rede', 'formato', 'entrada'), plus the provider's schema-like error code
// when there is one, and `retryAfter` (a hint for the caller, never a retry)
// on a 429. A state-changing call that failed after it may have reached the
// provider also carries `uncertain: true`: nothing here repeats it.

const BASES = Object.freeze({
  live: 'https://api.hodle.com.br',
  test: 'https://sandbox-api.hodle.com.br'
})
const NETWORKS = Object.freeze(['polygon', 'base'])

const TIMEOUT_MS = 5000
// Above the provider's 25 s wait for a wallet's nonce queue
// (wallet-payout.md), so a payout or transfer that is merely queued is not
// abandoned as a timeout.
const MONEY_TIMEOUT_MS = 30000
const MAX_BODY = 65536
const MAX_STRING = 256
const MAX_NAME = 64
const MAX_URL = 4096
const MAX_KEY_BLOB = 8192
const MAX_RETRY_AFTER = 86400
const MAX_ROWS = 64
const MAX_RAW_ROWS = 512
const MAX_LIST = 100
const MAX_STATEMENT_LIMIT = 50
// One day under the provider's 90-day window cap, so a clock skew between
// us and the provider cannot push a recovery read over it.
const MAX_FIND_DAYS = 89
const FIND_PAGES = 3
// An explicit window may be read further, still bounded per call.
const MAX_FIND_PAGES = 10
const DAY_MS = 86400000
const MIN_DEPOSIT_CENTS = 100
const MIN_PAYOUT_CENTS = 10
// The provider caps a transfer at 10000 units of the asset.
const MAX_TRANSFER_CENTS = 1000000
const MAX_OWNER_NAME = 128
const MAX_TAX_ID_MASKED = 32
const MAX_BANK_NAME = 64
const MAX_REFERENCE = 64
const MAX_CURSOR = 512
const MAX_ERROR_TEXT = 512

const KEY_RE = /^hodle_(live|test)_[\x21-\x7e]{8,200}$/
// '.' and '..' would be resolved as path segments and send the key elsewhere.
const ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/
const PIN_RE = /^[0-9]{6}$/
const TAX_ID_RE = /^[0-9]{11}$/
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/
const CODE_RE = /^[A-Z_]{1,48}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const COUNTRY_RE = /^[A-Z]{3}$/
const SYMBOL_RE = /^[A-Za-z]{1,16}$/
const AMOUNT_RE = /^[0-9]{1,30}(\.[0-9]{1,30})?$/
const STATUS_RE = /^[A-Z_]{1,32}$/
const PRINTABLE_RE = /^[\x21-\x7e]+$/
// BR Code payloads carry spaces in the merchant name and city fields.
const QR_RE = /^[\x20-\x7e]{1,1024}$/
const BRL_RE = /^([0-9]+)(?:\.([0-9]{1,18}))?$/
// A CPF or a CNPJ, digits only: payer of a deposit or beneficiary of a payout.
const PAYER_TAX_ID_RE = /^([0-9]{11}|[0-9]{14})$/
const HASH_RE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,88})$/
const E2E_RE = /^[A-Za-z0-9]{1,64}$/
const REFERENCE_RE = /^[\x20-\x7e]{1,64}$/
const CURSOR_RE = /^[\x21-\x7e]{1,512}$/
const OP_TYPE_RE = /^[a-z_]{1,32}$/
const PIX_KEY_RES = Object.freeze({
  PHONE: /^\+55[0-9]{10,11}$/,
  CPF: /^[0-9]{11}$/,
  CNPJ: /^[0-9]{14}$/,
  EMAIL: /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,252}\.[A-Za-z]{2,24}$/,
  RANDOM: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
})
const STATEMENT_TYPES = new Set(['deposit', 'withdraw', 'payout', 'transfer'])

// FAILED is not final for a deposit: the Pix is being returned to the payer.
// EXPIRED is not final either: a late Pix is still honoured (deposit-asset.md).
const DEPOSIT_OUTCOMES = Object.freeze({
  PENDING: 'pendente',
  FIAT_PAID: 'pendente',
  PROCESSING: 'pendente',
  COMPLETED: 'concluido',
  EXPIRED: 'expirado',
  FAILED: 'devolvendo',
  REFUNDED: 'devolvido'
})
const DEPOSIT_FINAL = new Set(['concluido', 'devolvido'])

const PIN_CODES = Object.freeze({
  PIN_INVALID: 'PIN_INVALID',
  INVALID_PIN: 'PIN_INVALID',
  PIN_LOCKED: 'PIN_LOCKED'
})
// A 409 that means "try again later", never "this reference already exists".
const BUSY_CODES = new Set(['WALLET_BUSY', 'TRANSFER_IN_PROGRESS', 'PAYOUT_IN_PROGRESS'])
const TRANSFER_FAILED = new Set(['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED'])
// Lone surrogates would make encodeURIComponent throw outside the failure path.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

const UPLOAD_HOST = 'uploads.hodle.com.br'
const LIVENESS_HOST = 'app.hodle.com.br'
const DOCUMENT_TYPES = new Set(['ID', 'DRIVERS-LICENSE', 'PASSPORT', 'SELFIE-FROM-LIVENESS'])

const KYC_OUTCOMES = Object.freeze({
  PENDING: 'pendente',
  APPROVED: 'aprovado',
  REJECTED: 'recusado',
  EXPIRED: 'expirado'
})

// Fields that must never reach a log line, a stored record or a result.
const SECRET_FIELDS = Object.freeze(['walletPin', 'protectedSymmetricKey', 'taxIdNumber'])

const FAIL = Object.freeze({ ok: false, reason: 'entrada' })
const BAD_FORMAT = Object.freeze({ ok: false, reason: 'formato' })

class HodleError extends Error {
  constructor (reason, extra = {}) {
    super(reason)
    this.reason = reason
    this.extra = extra
  }
}

function isObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validId (v) {
  return typeof v === 'string' && ID_RE.test(v)
}

function validText (v, max = MAX_STRING) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !CONTROL_RE.test(v) &&
    !LONE_SURROGATE_RE.test(v)
}

// -> { ok: false, reason, ... } from whatever a request threw. `mutating`
// marks calls whose effect may have happened although no usable answer came.
function failure (err, mutating) {
  let out
  if (err instanceof HodleError) out = { ok: false, reason: err.reason, ...err.extra }
  else if (err && err.name === 'AbortError') out = { ok: false, reason: 'tempo' }
  else out = { ok: false, reason: 'rede' }
  if (mutating && maybeApplied(out.reason)) out.uncertain = true
  return out
}

function maybeApplied (reason) {
  if (reason === 'tempo' || reason === 'rede' || reason === 'formato') return true
  return /^http-5[0-9]{2}$/.test(reason)
}

// Reads at most MAX_BODY bytes of a JSON response; anything else throws a bare
// Error that the callers turn into 'formato'.
async function readJson (res) {
  const type = String(res.headers.get('content-type') || '').toLowerCase()
  if (!type.startsWith('application/json')) throw new Error('not json')
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('too large')
  const chunks = []
  let size = 0
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength
      if (size > MAX_BODY) throw new Error('too large')
      chunks.push(Buffer.from(chunk))
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isFormatError (err) {
  return err instanceof SyntaxError || (err && (err.message === 'not json' || err.message === 'too large'))
}

// Hodle answers some endpoints as { success, data } and others as flat
// bodies (deposit creation, the beneficiary quote, payout acceptance). The
// object a method validates is `data` when that is an object, otherwise the
// top level. A body without success: true is refused whatever its status.
function body (json) {
  if (!isObject(json) || json.success !== true) return null
  return isObject(json.data) ? json.data : json
}

function retryAfterSeconds (res) {
  const raw = String(res.headers.get('retry-after') || '').trim()
  if (!/^[0-9]{1,6}$/.test(raw)) return undefined
  return Math.min(Number(raw), MAX_RETRY_AFTER)
}

function hodleUrl (url, host) {
  if (typeof url !== 'string' || url.length > MAX_URL || !url.startsWith('https://')) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' &&
      parsed.hostname === host && parsed.port === ''
  } catch {
    return false
  }
}

// A real calendar date, not in the future. The age rule belongs to the route.
function validBirthDate (v, now = Date.now()) {
  if (typeof v !== 'string') return false
  const m = DATE_RE.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const date = new Date(t)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false
  return t <= now
}

function present (v) {
  return v !== undefined && v !== null && v !== ''
}

function lowerAddress (v) {
  return typeof v === 'string' && ADDRESS_RE.test(v) ? v.toLowerCase() : null
}

function decimalString (v) {
  if (typeof v === 'string' && AMOUNT_RE.test(v)) return v
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    const s = String(v)
    if (AMOUNT_RE.test(s)) return s
  }
  return null
}

// '12.345' -> 1234: the first two decimals, extra digits floored, through
// BigInt so no float ever rounds a value. null for anything else, including
// a value past Number.MAX_SAFE_INTEGER cents.
function brlToCents (text) {
  if (typeof text !== 'string') return null
  const m = BRL_RE.exec(text)
  if (!m) return null
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] || '').slice(0, 2).padEnd(2, '0'))
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null
}

// 1234 -> '12.34'.
function centsToAmount (cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) return null
  const s = String(cents).padStart(3, '0')
  return s.slice(0, -2) + '.' + s.slice(-2)
}

function depositOutcome (status) {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(DEPOSIT_OUTCOMES, status)
    ? DEPOSIT_OUTCOMES[status]
    : 'desconhecido'
}

// 'done' only on a completed status or a txHash; 'failed' when the provider
// says the transfer did not happen, ahead of any hash; 'pending' otherwise,
// including an absent or unknown status.
function transferState (status, txHash) {
  const s = typeof status === 'string' ? status.toUpperCase() : null
  if (TRANSFER_FAILED.has(s)) return 'failed'
  if ((txHash !== undefined && txHash !== null) || s === 'COMPLETED') return 'done'
  return 'pending'
}

function isoTime (v) {
  return validText(v, 64) && Number.isFinite(Date.parse(v))
}

function intIn (v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max
}

// Pure mapping from a KYC attempt to our outcome. Only `status` is read: the
// rejection text and labels may describe the person and are dropped.
function kycOutcome (attempt) {
  if (!isObject(attempt) || typeof attempt.status !== 'string') return 'desconhecido'
  return Object.prototype.hasOwnProperty.call(KYC_OUTCOMES, attempt.status)
    ? KYC_OUTCOMES[attempt.status]
    : 'desconhecido'
}

// Pure decoders for the flat money endpoints. Each returns null when a field
// it needs is missing or malformed.

function decodeDeposit (json) {
  const d = body(json)
  if (!d) return null
  if (typeof d.qrCode !== 'string' || d.qrCode.trim().length === 0 || !QR_RE.test(d.qrCode)) return null
  // null means the payment rail sets its own lifetime: no countdown to show.
  if (d.expiresAt !== null && !isoTime(d.expiresAt)) return null
  const externalId = d.externalId === undefined || d.externalId === null ? null : d.externalId
  if (externalId !== null && !validId(externalId)) return null
  const walletCharge = d.walletCharge === undefined || d.walletCharge === null ? null : d.walletCharge
  if (walletCharge !== null && !validId(walletCharge)) return null
  if (!Number.isSafeInteger(d.fee) || d.fee < 0) return null
  return { externalId, qrCode: d.qrCode, expiresAt: d.expiresAt, walletCharge, feeCents: d.fee }
}

function decodeQuote (json) {
  const d = body(json)
  if (!d || !validId(d.quoteId)) return null
  if (!isObject(d.quote)) return null
  const fee = decimalString(d.quote.fee)
  if (fee === null) return null
  const owner = d.pixKeyOwner
  if (!isObject(owner)) return null
  const pixKeyOwner = {}
  for (const k of ['name', 'taxId', 'bankName']) {
    if (owner[k] === undefined || owner[k] === null) pixKeyOwner[k] = null
    else if (validText(owner[k])) pixKeyOwner[k] = owner[k]
    else return null
  }
  return { quoteId: d.quoteId, fee, pixKeyOwner }
}

function decodePayout (json) {
  const d = body(json)
  if (!d || !validId(d.transactionId)) return null
  if (typeof d.status !== 'string' || !STATUS_RE.test(d.status)) return null
  const fee = decimalString(d.fee)
  if (fee === null) return null
  return { transactionId: d.transactionId, status: d.status, fee }
}

// A copy of `obj` without the secret fields, at any depth, for anything that
// might be logged or stored.
function redact (obj, depth = 0) {
  if (depth > 8) return null
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1))
  if (!isObject(obj)) return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.includes(k)) continue
    out[k] = redact(v, depth + 1)
  }
  return out
}

function createHodle (opts = {}) {
  const {
    apiKey,
    network = 'polygon',
    fetch = globalThis.fetch,
    endpoints,
    timeoutMs = TIMEOUT_MS
  } = opts
  // The messages never carry the offending value: it may be the secret.
  if (typeof apiKey !== 'string') throw new TypeError('hodle: chave de API inválida')
  const m = KEY_RE.exec(apiKey)
  if (!m) throw new TypeError('hodle: chave de API inválida')
  if (!NETWORKS.includes(network)) throw new TypeError('hodle: rede inválida')
  if (typeof fetch !== 'function') throw new TypeError('hodle: fetch ausente')
  let base = BASES[m[1]]
  if (endpoints !== undefined) {
    if (!isObject(endpoints) || typeof endpoints.base !== 'string' || endpoints.base.length === 0) {
      throw new TypeError('hodle: endpoint inválido')
    }
    base = endpoints.base
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('hodle: prazo inválido')

  const auth = 'Bearer ' + apiKey

  // One request with its own deadline covering headers and body; a redirect
  // is an error, never followed. Any failure after the response arrived
  // releases it so a refused response never holds a connection.
  async function request (method, path, payload, callOpts, opts) {
    const limit = callOpts && Number.isFinite(callOpts.timeoutMs) && callOpts.timeoutMs > 0
      ? callOpts.timeoutMs
      : timeoutMs
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), limit)
    try {
      const headers = { authorization: auth, accept: 'application/json' }
      const init = { method, headers, redirect: 'error', signal: ctrl.signal }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(payload)
      }
      const res = await fetch(base + path, init)
      try {
        return await handle(res, opts)
      } catch (err) {
        ctrl.abort()
        try { await res.body?.cancel() } catch {}
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function handle (res, opts = {}) {
    if (!res.ok) {
      const extra = {}
      let json = null
      try { json = await readJson(res) } catch {}
      const code = errorCode(json, res.status, opts)
      if (code) extra.code = code
      if (res.status === 429) {
        const after = retryAfterSeconds(res)
        if (after !== undefined) extra.retryAfter = after
      }
      const err = new HodleError('http-' + res.status, extra)
      if (opts.conflict && res.status === 409 && isObject(json)) err.conflict = conflictOf(json)
      throw err
    }
    let json
    try {
      json = await readJson(res)
    } catch (err) {
      // A body that stalls past the deadline or a connection that drops while
      // streaming is not a format problem: failure() reports 'tempo'/'rede'.
      if (isFormatError(err)) throw new HodleError('formato')
      throw err
    }
    if (!body(json)) throw new HodleError('formato')
    return json
  }

  // Only the schema-like error code of an error body is read; the message,
  // `details` and every other value are dropped unread. The one exception is
  // a PIN-signed call: the provider answers a wrong or locked PIN with a bare
  // 400 message, so that message is matched against /PIN/ and dropped.
  function errorCode (json, status, opts) {
    if (!isObject(json)) return null
    let code = null
    for (const k of ['errorCode', 'code']) {
      if (typeof json[k] === 'string' && CODE_RE.test(json[k])) {
        code = json[k]
        break
      }
    }
    if (!opts.pin) return code
    if (code !== null) return Object.prototype.hasOwnProperty.call(PIN_CODES, code) ? PIN_CODES[code] : code
    const text = json.error
    if ((status === 400 || status === 401) && typeof text === 'string' && text.length <= MAX_ERROR_TEXT && /PIN/i.test(text)) {
      return /lock|bloq/i.test(text) ? 'PIN_LOCKED' : 'PIN_INVALID'
    }
    return null
  }

  // What a transfer 409 says about the earlier transfer with that reference.
  // Each value is kept only when it is well formed.
  function conflictOf (json) {
    const src = isObject(json.data) ? json.data : json
    const out = {}
    if (validId(src.transactionId)) out.transactionId = src.transactionId
    if (typeof src.txHash === 'string' && HASH_RE.test(src.txHash)) out.txHash = src.txHash
    if (typeof src.status === 'string') out.status = src.status
    if (typeof src.reference === 'string') out.reference = src.reference
    // Raw, compared with the request by the caller: any value that does not
    // match, malformed included, means the reference was used for another
    // transfer.
    for (const k of ['amount', 'toSubAccountId', 'recipientAddress', 'destination']) {
      if (src[k] !== undefined && src[k] !== null) out[k] = src[k]
    }
    return out
  }

  async function call (mutating, method, path, payload, callOpts, decode, opts = {}) {
    let json
    try {
      json = await request(method, path, payload, callOpts, opts)
    } catch (err) {
      if (err instanceof HodleError && err.conflict && opts.onConflict) {
        const settled = opts.onConflict(err.conflict, err.extra)
        if (settled) return settled
      }
      return failure(err, mutating)
    }
    const out = decode(body(json), json)
    if (!out) return mutating ? { ...BAD_FORMAT, uncertain: true } : BAD_FORMAT
    // A decoder may read a definite refusal inside a 2xx body.
    if (out.ok === false) return out
    return { ok: true, ...out }
  }

  function createSubaccount ({ name } = {}, callOpts) {
    if (!validText(name, MAX_NAME)) return Promise.resolve(FAIL)
    return call(true, 'POST', '/api/subaccount', { name, accountType: 'INDIVIDUAL' }, callOpts, (d) => {
      return validId(d.subAccountId) ? { subAccountId: d.subAccountId } : null
    })
  }

  // Recovery read after an uncertain createSubaccount. The provider filters
  // by substring, so only exact name matches count; `complete` is false when
  // another page exists and a match could be on it. Rows for other names are
  // skipped unread so that one odd row cannot hide a match on the page.
  function findSubaccounts ({ name } = {}, callOpts) {
    if (!validText(name, MAX_NAME)) return Promise.resolve(FAIL)
    const path = '/api/subaccount?name=' + encodeURIComponent(name)
    return call(false, 'GET', path, undefined, callOpts, (d, json) => {
      const list = Array.isArray(d) ? d : listOf(d)
      if (!list || list.length > MAX_LIST) return null
      const subAccountIds = []
      for (const item of list) {
        if (!isObject(item) || item.name !== name) continue
        const id = item.subAccountId ?? item.id
        if (!validId(id)) return null
        subAccountIds.push(id)
      }
      let more = false
      for (const src of [d, json]) {
        if (!isObject(src)) continue
        for (const k of ['nextCursor', 'cursor', 'next']) if (present(src[k])) more = true
      }
      return { subAccountIds, complete: !more }
    })
  }

  function listOf (d) {
    for (const k of ['subaccounts', 'subAccounts', 'items', 'data']) {
      if (Array.isArray(d[k])) return d[k]
    }
    return null
  }

  function kycDocument ({ subAccountId, documentType, isDoubleSided } = {}, callOpts) {
    if (!validId(subAccountId) || !DOCUMENT_TYPES.has(documentType)) return Promise.resolve(FAIL)
    if (isDoubleSided !== undefined && typeof isDoubleSided !== 'boolean') return Promise.resolve(FAIL)
    const selfie = documentType === 'SELFIE-FROM-LIVENESS'
    const payload = { subAccountId, documentType }
    if (!selfie && isDoubleSided) payload.isDoubleSided = true
    return call(true, 'POST', '/api/kyc/document', payload, callOpts, (d) => {
      if (!validId(d.documentId)) return null
      if (selfie) {
        return hodleUrl(d.livenessUrl, LIVENESS_HOST) ? { documentId: d.documentId, livenessUrl: d.livenessUrl } : null
      }
      if (!hodleUrl(d.uploadUrlFront, UPLOAD_HOST)) return null
      const out = { documentId: d.documentId, uploadUrlFront: d.uploadUrlFront }
      if (isDoubleSided) {
        if (!hodleUrl(d.uploadUrlBack, UPLOAD_HOST)) return null
        out.uploadUrlBack = d.uploadUrlBack
      }
      return out
    })
  }

  function kycDocumentReady ({ subAccountId, documentId } = {}, callOpts) {
    if (!validId(subAccountId) || !validId(documentId)) return Promise.resolve(FAIL)
    const path = '/api/kyc/document/' + encodeURIComponent(documentId) +
      '?subAccountId=' + encodeURIComponent(subAccountId)
    return call(false, 'GET', path, undefined, callOpts, (d) => {
      return typeof d.ready === 'boolean' ? { ready: d.ready } : null
    })
  }

  const KYC_TEXT = ['fullName', 'email', 'state', 'city', 'zipCode', 'streetAddress']
  const KYC_OPTIONAL_TEXT = ['phone', 'addressNumber', 'addressComplement']

  function kycSubmit (fields = {}, callOpts) {
    if (!isObject(fields)) return Promise.resolve(FAIL)
    const { subAccountId, dateOfBirth, taxIdNumber, uploadedSelfieId, uploadedDocumentId } = fields
    if (!validId(subAccountId) || !validId(uploadedSelfieId) || !validId(uploadedDocumentId)) return Promise.resolve(FAIL)
    if (!validBirthDate(dateOfBirth)) return Promise.resolve(FAIL)
    if (typeof taxIdNumber !== 'string' || !TAX_ID_RE.test(taxIdNumber)) return Promise.resolve(FAIL)
    const country = fields.country === undefined ? 'BRA' : fields.country
    if (typeof country !== 'string' || !COUNTRY_RE.test(country)) return Promise.resolve(FAIL)
    const payload = {
      subAccountId,
      dateOfBirth,
      countryOfTaxId: 'BRA',
      taxIdNumber,
      country,
      uploadedSelfieId,
      uploadedDocumentId
    }
    for (const k of KYC_TEXT) {
      if (!validText(fields[k])) return Promise.resolve(FAIL)
      payload[k] = fields[k]
    }
    for (const k of KYC_OPTIONAL_TEXT) {
      // An empty optional field from a form is the same as an absent one.
      if (fields[k] === undefined || fields[k] === null) continue
      if (typeof fields[k] === 'string' && fields[k].trim() === '') continue
      if (!validText(fields[k])) return Promise.resolve(FAIL)
      payload[k] = fields[k]
    }
    if (fields.sandboxReject !== undefined) {
      if (typeof fields.sandboxReject !== 'boolean') return Promise.resolve(FAIL)
      if (fields.sandboxReject) payload.sandboxReject = true
    }
    return call(true, 'POST', '/api/kyc', payload, callOpts, (d) => {
      return validId(d.attemptId) ? { attemptId: d.attemptId } : null
    })
  }

  function kycStatus (attemptId, callOpts) {
    if (!validId(attemptId)) return Promise.resolve(FAIL)
    return call(false, 'GET', '/api/kyc/' + encodeURIComponent(attemptId), undefined, callOpts, (d) => {
      return { outcome: kycOutcome(d) }
    })
  }

  // Recovery read after an uncertain kycSubmit: the subaccount's latest
  // attempt id (null when there is none yet) and its outcome when the answer
  // carries a status.
  function kycLatest ({ subAccountId } = {}, callOpts) {
    if (!validId(subAccountId)) return Promise.resolve(FAIL)
    const path = '/api/kyc?subAccountId=' + encodeURIComponent(subAccountId)
    return call(false, 'GET', path, undefined, callOpts, (d) => {
      const id = d.lastAttemptId
      if (id === null) return { lastAttemptId: null, outcome: null }
      if (!validId(id)) return null
      return { lastAttemptId: id, outcome: typeof d.status === 'string' ? kycOutcome(d) : null }
    })
  }

  function keyBlob (v) {
    return typeof v === 'string' && v.length <= MAX_KEY_BLOB && PRINTABLE_RE.test(v)
  }

  function createWallet ({ subAccountId, walletPin } = {}, callOpts) {
    if (!validId(subAccountId) || typeof walletPin !== 'string' || !PIN_RE.test(walletPin)) return Promise.resolve(FAIL)
    return call(true, 'POST', '/api/wallet/create', { network, walletPin, subAccountId }, callOpts, (d) => {
      const address = lowerAddress(d.address)
      if (!validId(d.id) || !address || !keyBlob(d.protectedSymmetricKey)) return null
      if (d.network !== undefined && d.network !== network) return null
      return { walletId: d.id, address, protectedSymmetricKey: d.protectedSymmetricKey }
    })
  }

  function walletKeys ({ subAccountId, walletId } = {}, callOpts) {
    if (!validId(subAccountId)) return Promise.resolve(FAIL)
    if (walletId !== undefined && !validId(walletId)) return Promise.resolve(FAIL)
    const payload = { subAccountId }
    if (walletId !== undefined) payload.walletId = walletId
    return call(false, 'POST', '/api/wallet/keys', payload, callOpts, (d) => {
      if (!validId(d.walletId) || !keyBlob(d.protectedSymmetricKey)) return null
      if (walletId !== undefined && d.walletId !== walletId) return null
      return { walletId: d.walletId, protectedSymmetricKey: d.protectedSymmetricKey }
    })
  }

  // Balances of the configured network only; another network's rows are
  // ignored so that a row we never use cannot block a read. `walletId` is the
  // id the provider echoed (null when it did not), and `verified` says the
  // echo matched the requested wallet: only a verified read may be persisted.
  function walletGet ({ subAccountId, walletId, sync = false } = {}, callOpts) {
    if (!validId(subAccountId) || typeof sync !== 'boolean') return Promise.resolve(FAIL)
    if (walletId !== undefined && !validId(walletId)) return Promise.resolve(FAIL)
    const payload = { subAccountId, sync }
    if (walletId !== undefined) payload.walletId = walletId
    return call(false, 'POST', '/api/wallet/get', payload, callOpts, (d) => {
      if (d.addresses !== undefined && d.addresses !== null && !isObject(d.addresses)) return null
      const raw = isObject(d.addresses) ? d.addresses[network] : undefined
      let address = null
      if (raw !== undefined && raw !== null) {
        address = lowerAddress(raw)
        if (!address) return null
      }
      let echoed = null
      if (d.walletId !== undefined && d.walletId !== null) {
        if (!validId(d.walletId)) return null
        echoed = d.walletId
      }
      if (walletId !== undefined && echoed !== null && echoed !== walletId) return null
      const rows = d.balances === undefined || d.balances === null ? [] : d.balances
      if (!Array.isArray(rows) || rows.length > MAX_RAW_ROWS) return null
      const balances = []
      for (const row of rows) {
        if (!isObject(row) || row.network !== network) continue
        if (typeof row.asset !== 'string' || !SYMBOL_RE.test(row.asset)) return null
        if (typeof row.amount !== 'string' || !AMOUNT_RE.test(row.amount)) return null
        balances.push({ network, asset: row.asset, amount: row.amount })
      }
      if (balances.length > MAX_ROWS) return null
      return { address, balances, walletId: echoed, verified: walletId !== undefined && echoed === walletId }
    })
  }

  function moneyOpts (callOpts) {
    return callOpts && Number.isFinite(callOpts.timeoutMs) && callOpts.timeoutMs > 0
      ? callOpts
      : { ...callOpts, timeoutMs: MONEY_TIMEOUT_MS }
  }

  // undefined and null both mean "not given"; anything else must be an id.
  function optionalId (v) {
    return v === undefined || v === null || validId(v)
  }

  function validPixKey (pixKey, pixKeyType) {
    return typeof pixKeyType === 'string' && Object.prototype.hasOwnProperty.call(PIX_KEY_RES, pixKeyType) &&
      typeof pixKey === 'string' && PIX_KEY_RES[pixKeyType].test(pixKey)
  }

  function validCredentials (walletPin, protectedSymmetricKey) {
    return typeof walletPin === 'string' && PIN_RE.test(walletPin) && keyBlob(protectedSymmetricKey)
  }

  // The BRLA balance of the wallet on the configured network, from a fresh
  // provider read. A wallet without a BRLA row holds zero.
  async function balance ({ subAccountId, walletId } = {}, callOpts) {
    if (!validId(subAccountId) || !optionalId(walletId)) return FAIL
    const args = { subAccountId, sync: true }
    if (walletId !== undefined && walletId !== null) args.walletId = walletId
    const r = await walletGet(args, callOpts)
    if (!r.ok) return r
    // Without the provider's echo of that wallet the rows could be another
    // wallet's, or the subaccount's sum.
    if (args.walletId !== undefined && !r.verified) return BAD_FORMAT
    let cents = 0
    for (const row of r.balances) {
      if (row.asset !== 'BRLA') continue
      const c = brlToCents(row.amount)
      if (c === null || !Number.isSafeInteger(cents + c)) return BAD_FORMAT
      cents += c
    }
    return { ok: true, cents, address: r.address }
  }

  function decodeOperation (op) {
    if (!isObject(op) || !validId(op.id)) return null
    if (typeof op.type !== 'string' || !OP_TYPE_RE.test(op.type)) return null
    const status = typeof op.status === 'string' ? op.status.toUpperCase() : null
    if (status === null || !STATUS_RE.test(status)) return null
    if (!isoTime(op.createdAt)) return null
    let cents = null
    if (typeof op.valueInBrl === 'string') cents = brlToCents(op.valueInBrl)
    else if (op.asset === 'BRLA') cents = brlToCents(decimalString(op.amount))
    if (cents === null) return null
    let feeCents = 0
    if (op.fee !== undefined && op.fee !== null) {
      feeCents = brlToCents(decimalString(op.fee))
      if (feeCents === null) return null
    }
    const out = { id: op.id, type: op.type, status, cents, feeCents, createdAt: op.createdAt }
    // A malformed optional field is dropped, not fatal: a reference written
    // by another integration must not hide the rest of the page.
    if (typeof op.txHash === 'string' && HASH_RE.test(op.txHash)) out.txHash = op.txHash
    if (typeof op.endToEndId === 'string' && E2E_RE.test(op.endToEndId)) out.endToEndId = op.endToEndId
    if (validId(op.externalId)) out.externalId = op.externalId
    if (typeof op.reference === 'string' && REFERENCE_RE.test(op.reference)) out.reference = op.reference
    if (op.direction === 'in' || op.direction === 'out') out.direction = op.direction
    return out
  }

  function statement (args = {}, callOpts) {
    return readStatement(args, callOpts, null)
  }

  // A row whose required fields cannot be read is skipped and counted, so one
  // odd row from another integration does not hide the page. When `match`
  // says the skipped row is the one being searched for, the read is refused
  // instead: a recovery must never report a miss for a row it could not read.
  async function readStatement (args, callOpts, match) {
    if (!isObject(args)) return FAIL
    const { subAccountId, from, to, cursor, type } = args
    const limit = args.limit === undefined ? MAX_STATEMENT_LIMIT : args.limit
    if (!validId(subAccountId) || !intIn(limit, 1, MAX_STATEMENT_LIMIT)) return FAIL
    if ((from !== undefined && !isoTime(from)) || (to !== undefined && !isoTime(to))) return FAIL
    if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !CURSOR_RE.test(cursor))) return FAIL
    const types = type === undefined ? null : Array.isArray(type) ? type : [type]
    if (types && (types.length === 0 || !types.every((t) => STATEMENT_TYPES.has(t)))) return FAIL
    const payload = { subAccountId, limit }
    if (from !== undefined) payload.from = from
    if (to !== undefined) payload.to = to
    if (cursor !== undefined && cursor !== null) payload.cursor = cursor
    if (types) payload.type = types.length === 1 ? types[0] : types
    let unreadableMatch = false
    const r = await call(false, 'POST', '/api/account/statement', payload, callOpts, (d) => {
      const rows = d.operations === undefined || d.operations === null ? [] : d.operations
      if (!Array.isArray(rows) || rows.length > MAX_RAW_ROWS) return null
      const operations = []
      let skipped = 0
      for (const row of rows) {
        const op = decodeOperation(row)
        if (op) {
          operations.push(op)
          continue
        }
        skipped++
        if (match && isObject(row) && match(row)) unreadableMatch = true
      }
      let next = null
      if (d.nextCursor !== undefined && d.nextCursor !== null) {
        if (typeof d.nextCursor !== 'string' || d.nextCursor.length > MAX_CURSOR || !CURSOR_RE.test(d.nextCursor)) return null
        next = d.nextCursor
      }
      return { operations, cursor: next, skipped }
    })
    return r.ok && unreadableMatch ? BAD_FORMAT : r
  }

  // Recovery read after a payout or transfer whose answer never arrived:
  // the most recent operation carrying that externalId or reference within
  // the last `days`, or within an explicit window { from, to } (ISO, from
  // before to, at most MAX_FIND_DAYS long), scanning at most `maxPages`
  // statement pages (FIND_PAGES by default, MAX_FIND_PAGES at most). A miss
  // is { operation: null }, and `complete` is false when pages were left
  // unread.
  async function findByReference (args = {}, callOpts) {
    if (!isObject(args)) return FAIL
    const { subAccountId, externalId, reference } = args
    const days = args.days === undefined ? 7 : args.days
    const maxPages = args.maxPages === undefined ? FIND_PAGES : args.maxPages
    if (!validId(subAccountId) || !intIn(days, 1, MAX_FIND_DAYS) || !intIn(maxPages, 1, MAX_FIND_PAGES)) return FAIL
    const windowed = args.from !== undefined || args.to !== undefined
    if (windowed) {
      if (args.days !== undefined || !isoTime(args.from) || !isoTime(args.to)) return FAIL
      const span = Date.parse(args.to) - Date.parse(args.from)
      if (!(span > 0) || span > MAX_FIND_DAYS * DAY_MS) return FAIL
    }
    const byExternal = externalId !== undefined && externalId !== null
    const byReference = reference !== undefined && reference !== null
    if (byExternal === byReference) return FAIL
    if (byExternal && !validId(externalId)) return FAIL
    if (byReference && (typeof reference !== 'string' || !REFERENCE_RE.test(reference))) return FAIL
    // Both bounds from one instant, sent on every page: left to the provider,
    // `to` would be its own later clock and the window could pass the cap.
    const now = Date.now()
    const from = windowed ? new Date(Date.parse(args.from)).toISOString() : new Date(now - days * DAY_MS).toISOString()
    const to = windowed ? new Date(Date.parse(args.to)).toISOString() : new Date(now).toISOString()
    const matches = (op) => byExternal ? op.externalId === externalId : op.reference === reference
    let cursor
    for (let page = 0; page < maxPages; page++) {
      const r = await readStatement({ subAccountId, from, to, limit: MAX_STATEMENT_LIMIT, cursor }, callOpts, matches)
      if (!r.ok) return r
      const hit = r.operations.find(matches)
      if (hit) return { ok: true, operation: hit, complete: true }
      if (r.cursor === null) return { ok: true, operation: null, complete: true }
      cursor = r.cursor
    }
    return { ok: true, operation: null, complete: false }
  }

  // A Pix charge that delivers BRLA to the member's wallet address. The same
  // externalId returns the original charge (deposit-asset.md, Idempotency).
  function createDeposit (args = {}, callOpts) {
    if (!isObject(args)) return Promise.resolve(FAIL)
    const { subAccountId, valueCents, address, externalId, taxId } = args
    const expiresIn = args.expiresIn === undefined ? 900 : args.expiresIn
    if (!validId(subAccountId) || !validId(externalId) || !lowerAddress(address)) return Promise.resolve(FAIL)
    if (!intIn(valueCents, MIN_DEPOSIT_CENTS, Number.MAX_SAFE_INTEGER) || !intIn(expiresIn, 60, 86400)) return Promise.resolve(FAIL)
    if (taxId !== undefined && taxId !== null && (typeof taxId !== 'string' || !PAYER_TAX_ID_RE.test(taxId))) return Promise.resolve(FAIL)
    const payload = { value: valueCents, asset: 'BRLA', network, address, externalId, subAccountId, expiresIn }
    if (taxId !== undefined && taxId !== null) payload.taxId = taxId
    return call(true, 'POST', '/api/deposit/asset', payload, callOpts, (d, json) => {
      const dep = decodeDeposit(json)
      if (!dep) return null
      if (dep.externalId !== null && dep.externalId !== externalId) return null
      // The creation answer carries no trackId; walletCharge is the id that
      // GET /api/deposit/{id} accepts in its place.
      return {
        externalId,
        qrCode: dep.qrCode,
        expiresAt: dep.expiresAt,
        walletCharge: dep.walletCharge,
        trackId: dep.walletCharge,
        status: 'pendente',
        hodleFeeCents: dep.feeCents
      }
    })
  }

  function depositStatus ({ subAccountId, externalId } = {}, callOpts) {
    if (!validId(subAccountId) || !validId(externalId)) return Promise.resolve(FAIL)
    const path = '/api/deposit/' + encodeURIComponent(externalId) + '?subAccountId=' + encodeURIComponent(subAccountId)
    return call(false, 'GET', path, undefined, callOpts, (d) => {
      if (typeof d.status !== 'string' || !STATUS_RE.test(d.status)) return null
      if (d.externalId !== undefined && d.externalId !== null && d.externalId !== externalId) return null
      const outcome = depositOutcome(d.status)
      const out = { status: d.status, outcome, final: DEPOSIT_FINAL.has(outcome) }
      if (Number.isSafeInteger(d.fee) && d.fee >= 0) out.hodleFeeCents = d.fee
      if (typeof d.transactionHash === 'string' && HASH_RE.test(d.transactionHash)) out.txHash = d.transactionHash
      return out
    })
  }

  // Resolves the payee and locks the price. A quote may reserve a payout that
  // cannot be cancelled (payout-beneficiary.md), so callers request one only
  // when the member asks to review a payment, never on their own.
  function payoutQuote (args = {}, callOpts) {
    if (!isObject(args)) return Promise.resolve(FAIL)
    const { valueCents, pixKey, pixKeyType, subAccountId, walletId, taxId } = args
    if (!intIn(valueCents, MIN_PAYOUT_CENTS, Number.MAX_SAFE_INTEGER) || !validPixKey(pixKey, pixKeyType)) return Promise.resolve(FAIL)
    if (!optionalId(subAccountId) || !optionalId(walletId)) return Promise.resolve(FAIL)
    if (taxId !== undefined && taxId !== null && (typeof taxId !== 'string' || !PAYER_TAX_ID_RE.test(taxId))) return Promise.resolve(FAIL)
    const payload = { value: valueCents, network, asset: 'BRLA', pixKey, pixKeyType }
    if (subAccountId !== undefined && subAccountId !== null) payload.subAccountId = subAccountId
    if (walletId !== undefined && walletId !== null) payload.walletId = walletId
    if (taxId !== undefined && taxId !== null) payload.taxId = taxId
    return call(true, 'POST', '/api/wallet/payout/beneficiary', payload, callOpts, (d, json) => {
      const q = decodeQuote(json)
      if (!q) return null
      const feeCents = brlToCents(q.fee)
      if (feeCents === null) return null
      const { name, taxId: masked, bankName } = q.pixKeyOwner
      if ((name !== null && name.length > MAX_OWNER_NAME) || (masked !== null && masked.length > MAX_TAX_ID_MASKED) ||
        (bankName !== null && bankName.length > MAX_BANK_NAME)) return null
      let expiresAt = null
      if (d.expiresAt !== undefined && d.expiresAt !== null) {
        if (!isoTime(d.expiresAt)) return null
        expiresAt = d.expiresAt
      }
      return { quoteId: q.quoteId, ownerName: name, taxIdMasked: masked, bankName, feeCents, expiresAt }
    })
  }

  // With a quoteId the destination comes from the quote, so pixKey and
  // pixKeyType are left out (wallet-payout.md); every field sent must match
  // what was quoted.
  function payout (args = {}, callOpts) {
    if (!isObject(args)) return Promise.resolve(FAIL)
    const { subAccountId, walletId, walletPin, protectedSymmetricKey, externalId, valueCents, quoteId, pixKey, pixKeyType, taxId } = args
    if (!validId(subAccountId) || !optionalId(walletId) || !validId(externalId)) return Promise.resolve(FAIL)
    if (!validCredentials(walletPin, protectedSymmetricKey)) return Promise.resolve(FAIL)
    if (!intIn(valueCents, MIN_PAYOUT_CENTS, Number.MAX_SAFE_INTEGER)) return Promise.resolve(FAIL)
    const quoted = quoteId !== undefined && quoteId !== null
    if (quoted ? !validId(quoteId) : !validPixKey(pixKey, pixKeyType)) return Promise.resolve(FAIL)
    if (taxId !== undefined && taxId !== null && (typeof taxId !== 'string' || !PAYER_TAX_ID_RE.test(taxId))) return Promise.resolve(FAIL)
    const payload = { value: valueCents, network, asset: 'BRLA', subAccountId, externalId, walletPin, protectedSymmetricKey }
    if (walletId !== undefined && walletId !== null) payload.walletId = walletId
    if (quoted) payload.quoteId = quoteId
    else Object.assign(payload, { pixKey, pixKeyType })
    if (taxId !== undefined && taxId !== null) payload.taxId = taxId
    return call(true, 'POST', '/api/wallet/payout', payload, moneyOpts(callOpts), (d, json) => {
      const p = decodePayout(json)
      if (!p) return null
      const feeCents = brlToCents(p.fee)
      if (feeCents === null) return null
      // A repeat returns the original payout: it must be the one we asked for.
      if (d.valueInBrl !== undefined && d.valueInBrl !== null && brlToCents(decimalString(d.valueInBrl)) !== valueCents) return null
      if (d.asset !== undefined && d.asset !== null && d.asset !== 'BRLA') return null
      return { transactionId: p.transactionId, status: p.status, feeCents, existing: d.alreadyProcessed === true }
    }, { pin: true })
  }

  function payoutStatus (transactionId, callOpts) {
    if (!validId(transactionId)) return Promise.resolve(FAIL)
    return call(false, 'GET', '/api/wallet/payout/' + encodeURIComponent(transactionId), undefined, callOpts, (d) => {
      if (typeof d.status !== 'string' || !STATUS_RE.test(d.status)) return null
      if (d.transactionId !== undefined && d.transactionId !== null && d.transactionId !== transactionId) return null
      const out = { status: d.status }
      if (typeof d.endToEndId === 'string' && E2E_RE.test(d.endToEndId)) out.endToEndId = d.endToEndId
      if (typeof d.failureCode === 'string' && CODE_RE.test(d.failureCode)) out.failureCode = d.failureCode
      if (typeof d.txHash === 'string' && HASH_RE.test(d.txHash)) out.txHash = d.txHash
      return out
    })
  }

  // On-chain BRLA from the member's wallet to another subaccount or address.
  // `reference` is the idempotency key: a repeat answers 409 with the earlier
  // transfer, which is reported as existing. Only a completed status or a
  // txHash counts as done; anything else stays pending for a statement read.
  function transfer (args = {}, callOpts) {
    if (!isObject(args)) return Promise.resolve(FAIL)
    const { fromSubAccountId, walletId, toSubAccountId, recipientAddress, amountCents, walletPin, protectedSymmetricKey, reference } = args
    if (!validId(fromSubAccountId) || !optionalId(walletId)) return Promise.resolve(FAIL)
    const toSub = toSubAccountId !== undefined && toSubAccountId !== null
    const toAddress = recipientAddress !== undefined && recipientAddress !== null
    if (toSub === toAddress) return Promise.resolve(FAIL)
    if (toSub ? !validId(toSubAccountId) : !lowerAddress(recipientAddress)) return Promise.resolve(FAIL)
    if (!intIn(amountCents, 1, MAX_TRANSFER_CENTS) || !validCredentials(walletPin, protectedSymmetricKey)) return Promise.resolve(FAIL)
    if (typeof reference !== 'string' || reference.trim() === '' || reference.length > MAX_REFERENCE || !REFERENCE_RE.test(reference)) {
      return Promise.resolve(FAIL)
    }
    const amount = centsToAmount(amountCents)
    const payload = { fromSubAccountId, network, asset: 'BRLA', amount, walletPin, protectedSymmetricKey, reference }
    if (walletId !== undefined && walletId !== null) payload.walletId = walletId
    if (toSub) payload.toSubAccountId = toSubAccountId
    else payload.recipientAddress = recipientAddress
    const sameAmount = (v) => brlToCents(decimalString(v)) === amountCents
    // A recipient echo on a transfer to a subaccount is that subaccount's
    // wallet address, which we do not know, so only an address request can
    // check `recipientAddress`.
    const sameDestination = (c) => {
      if (c.toSubAccountId !== undefined && (!toSub || c.toSubAccountId !== toSubAccountId)) return false
      if (toAddress && c.recipientAddress !== undefined && lowerAddress(c.recipientAddress) !== lowerAddress(recipientAddress)) return false
      if (c.destination !== undefined) {
        const ok = toSub ? c.destination === toSubAccountId : lowerAddress(c.destination) === lowerAddress(recipientAddress)
        if (!ok) return false
      }
      return true
    }
    const onConflict = (c, extra) => {
      if (extra.code && BUSY_CODES.has(extra.code)) return null
      if (c.transactionId === undefined && c.txHash === undefined) return null
      if (c.reference !== undefined && c.reference !== reference) return null
      if ((c.amount !== undefined && !sameAmount(c.amount)) || !sameDestination(c)) return { ...BAD_FORMAT, uncertain: true }
      const state = transferState(c.status, c.txHash)
      if (state === 'failed') return { ok: false, reason: 'http-409', code: 'TRANSFER_FAILED' }
      const out = { ok: true, status: state, existing: true }
      if (c.txHash !== undefined) out.txHash = c.txHash
      if (c.transactionId !== undefined) out.transactionId = c.transactionId
      return out
    }
    return call(true, 'POST', '/api/wallet/transfer', payload, moneyOpts(callOpts), (d) => {
      if (d.amount !== undefined && d.amount !== null && !sameAmount(d.amount)) return null
      if (toAddress && d.recipientAddress !== undefined && d.recipientAddress !== null &&
        lowerAddress(d.recipientAddress) !== lowerAddress(recipientAddress)) return null
      let txHash = null
      if (d.txHash !== undefined && d.txHash !== null) {
        if (typeof d.txHash !== 'string' || !HASH_RE.test(d.txHash)) return null
        txHash = d.txHash
      }
      const state = transferState(d.status, txHash)
      // The provider answered and says the transfer did not happen.
      if (state === 'failed') return { ok: false, reason: 'http-200', code: 'TRANSFER_FAILED' }
      const out = { status: state, existing: false }
      if (txHash) out.txHash = txHash
      return out
    }, { pin: true, conflict: true, onConflict })
  }

  return {
    network,
    balance,
    statement,
    findByReference,
    createDeposit,
    depositStatus,
    payoutQuote,
    payout,
    payoutStatus,
    transfer,
    createSubaccount,
    findSubaccounts,
    kycDocument,
    kycDocumentReady,
    kycSubmit,
    kycStatus,
    kycLatest,
    createWallet,
    walletKeys,
    walletGet
  }
}

module.exports = {
  createHodle,
  kycOutcome,
  depositOutcome,
  brlToCents,
  centsToAmount,
  decodeDeposit,
  decodeQuote,
  decodePayout,
  redact,
  BASES,
  NETWORKS,
  SECRET_FIELDS,
  MONEY_TIMEOUT_MS,
  MAX_TRANSFER_CENTS
}
