'use strict'

// Outbound-only client for the Hodle payments API (onboarding subset: the
// subaccount, KYC and the PIN-protected wallet), used by the account service.
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
const MAX_BODY = 65536
const MAX_STRING = 256
const MAX_NAME = 64
const MAX_URL = 4096
const MAX_KEY_BLOB = 8192
const MAX_RETRY_AFTER = 86400
const MAX_ROWS = 64
const MAX_RAW_ROWS = 512
const MAX_LIST = 100

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
  if (!validText(d.expiresAt, 64) || !Number.isFinite(Date.parse(d.expiresAt))) return null
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
  async function request (method, path, payload, callOpts) {
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
        return await handle(res)
      } catch (err) {
        ctrl.abort()
        try { await res.body?.cancel() } catch {}
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function handle (res) {
    if (!res.ok) {
      const extra = {}
      const code = await errorCode(res)
      if (code) extra.code = code
      if (res.status === 429) {
        const after = retryAfterSeconds(res)
        if (after !== undefined) extra.retryAfter = after
      }
      throw new HodleError('http-' + res.status, extra)
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
  // `details` and every other value are dropped unread.
  async function errorCode (res) {
    try {
      const json = await readJson(res)
      if (!isObject(json)) return null
      for (const k of ['errorCode', 'code']) {
        if (typeof json[k] === 'string' && CODE_RE.test(json[k])) return json[k]
      }
      return null
    } catch {
      return null
    }
  }

  async function call (mutating, method, path, payload, callOpts, decode) {
    let json
    try {
      json = await request(method, path, payload, callOpts)
    } catch (err) {
      return failure(err, mutating)
    }
    const out = decode(body(json), json)
    if (!out) return mutating ? { ...BAD_FORMAT, uncertain: true } : BAD_FORMAT
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

  return {
    network,
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
  decodeDeposit,
  decodeQuote,
  decodePayout,
  redact,
  BASES,
  NETWORKS,
  SECRET_FIELDS
}
