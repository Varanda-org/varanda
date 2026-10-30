'use strict'

const nodeCrypto = require('node:crypto')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { canonicalOp, verifyWallet, opHash } = require('@varanda/core/lib/wallet-proof')
const feeMath = require('./fees')
const { externalIdFor, OP_ID_RE } = require('./wallet-ops-store')
const { advanceOp, normalHash, adoptableAttempt } = require('./wallet-webhook')
const { MAX_TRANSFER_CENTS } = require('./hodle')

// The optional payments account with Hodle (mounted by ./server.js):
//
//   - GET /account/wallet/policy answers { available, network, mode } even
//     when the feature is off, so the app can hide it explicitly.
//   - start mints a single-use nonce bound to a member key and one action,
//     with no proof. It keeps no state at all: the nonce is an HMAC token
//     under a per-process secret, so an unsigned flood cannot fill a table
//     or touch anyone's nonces or limits.
//   - every other POST is /account/wallet/<action>, carrying the member's
//     diary-key proof over that nonce and the hash of the operation
//     (packages/core/lib/wallet-proof.js); the nonce is spent once the
//     signature verified, then the
//     directory link and the current terms.
//
// The mode gates which actions exist: cadastro (subaccount and KYC only, the
// default) < carteira (adds wallet-create with the member's PIN) < pix <
// completo. A route outside the mode answers 404.
//
// pix and completo add the money actions (balance, statement, deposit,
// payout-quote, preview, payout, op-status) over the ledger of
// ./wallet-ops-store.js. Every operation is written there BEFORE its
// provider call and never sent twice on our own: a lost answer leaves it
// 'incerto' until op-status reads the outcome. A member with an unresolved
// debit cannot start another one. Varanda's fee (./fees.js) is its own leg,
// sent only once Hodle reports the principal concluded; a fee not collected
// then is re-presented with its original reference inside a later payout
// the member signs, never on its own, and every fee that may still be owed
// stays reserved in the wallet.
//
// Creates are never repeated on our own: the store records the intent
// (subaccountUncertain, walletUncertain) before the call that creates, and a
// member whose create may have happened stays frozen until a read adopts
// what exists. The PIN and the KYC fields (CPF, name, birth date, e-mail,
// address) are read once from the body, removed from it, relayed to Hodle
// and never stored, hashed into a file or logged. Upload and liveness URLs
// reach only the member that proved its key. Logs carry only
// { event: 'carteira', reason } tokens.

const MAX_BODY = 8192
const NONCE_TTL_MS = 600 * 1000
// Spent nonces of verified requests, kept until they expire. Only valid
// member signatures reach it; a full map refuses rather than forget one.
const MAX_SPENT = 100000
const NONCE_DOMAIN = 'varanda-wallet-nonce-v1'
const NONCE_BYTES = 32
const DAY_MS = 24 * 3600 * 1000
const READ_EVERY_MS = 20 * 1000
// A submit intent younger than this may still have its call in flight
// (the client deadline is seconds), so no lookup can tell it apart yet.
const LATEST_AFTER_MS = 60 * 1000
const MAX_CACHE = 10000
const HEX64_RE = /^[0-9a-f]{64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LOG_TOKEN_RE = /^[a-z0-9_-]{1,48}$/
const PIN_RE = /^[0-9]{6}$/

// The same rules as isPin in apps/app/src/wallet.js.
function validPin (s) {
  return typeof s === 'string' && PIN_RE.test(s) && !/^([0-9])\1{5}$/.test(s) &&
    !'0123456789'.includes(s) && !'9876543210'.includes(s)
}
const NETWORKS = Object.freeze(['polygon', 'base'])
const MODES = Object.freeze(['cadastro', 'carteira', 'pix', 'completo'])
const BASE_ACTIONS = Object.freeze(['optin', 'kyc-document', 'kyc-submit', 'status'])
const MONEY_ACTIONS = Object.freeze(['balance', 'statement', 'deposit', 'payout-quote', 'preview', 'payout', 'op-status'])
const MONEY_MODES = Object.freeze(['pix', 'completo'])
const MIN_DEPOSIT_CENTS = 100
const MIN_PAYOUT_CENTS = 10
const QUOTE_TTL_MS = 5 * 60 * 1000
const OP_READ_EVERY_MS = 10 * 1000
const STATEMENT_DAYS = 90
const STATEMENT_LIMIT = 20
// Page one adds at most this many ledger rows to the provider's page, which
// keeps a page under 100 items and the app's 64 KiB statement body cap.
const STATEMENT_LEDGER_ROWS = 40
const MAX_CURSOR = 512
const FEE_SUFFIX = ':taxa'
const STATEMENT_CURSOR_RE = /^([0-9]{1,15})\.([\x21-\x7e]{1,512})$/
// The last pending fee is re-presented only while the tap is this fresh.
const LEG_BUDGET_MS = 45 * 1000
const MONEY_TIMEOUT_MS = 30 * 1000
const TRANSFER_FAILED = Object.freeze(['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED'])
// The recovery search around a row, and the provider's statement window.
const FIND_BEFORE_MS = DAY_MS
const FIND_AFTER_MS = 30 * DAY_MS
const FIND_MAX_AGE_MS = 89 * DAY_MS
const FIND_PAGES = 10
const EXTERNAL_ID_RE = /^var-[0-9a-f]{32}$/
const ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/
const CPF_RE = /^[0-9]{11}$/
// The same patterns as the Hodle client (hodle.js PIX_KEY_RES).
const PIX_KEY_RES = Object.freeze({
  PHONE: /^\+55[0-9]{10,11}$/,
  CPF: /^[0-9]{11}$/,
  CNPJ: /^[0-9]{14}$/,
  EMAIL: /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,252}\.[A-Za-z]{2,24}$/,
  RANDOM: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
})
const PREVIEW_KINDS = Object.freeze(['payout'])
const ZERO_RATES = Object.freeze(Object.fromEntries(feeMath.KINDS.map((k) => [k, Object.freeze({ cents: 0, bps: 0 })])))
// Hodle's provider statuses of a payout, a transfer or a statement row.
const PROVIDER_STATUS = Object.freeze({
  PENDING: 'pendente',
  PROCESSING: 'pendente',
  FIAT_PAID: 'pendente',
  COMPLETED: 'concluido',
  FAILED: 'falhou',
  REFUNDED: 'devolvido',
  EXPIRED: 'expirado'
})
const DEPOSIT_OUTCOME = Object.freeze({
  pendente: 'pendente',
  concluido: 'concluido',
  expirado: 'expirado',
  devolvendo: 'falhou',
  devolvido: 'devolvido'
})
const DOCUMENT_TYPES = Object.freeze(['ID', 'DRIVERS-LICENSE', 'PASSPORT', 'SELFIE-FROM-LIVENESS'])
const KYC_FIELDS = Object.freeze([
  'fullName', 'dateOfBirth', 'taxIdNumber', 'email', 'country', 'state', 'city', 'zipCode', 'streetAddress'
])
const MAX_FIELD = 256
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

// Only a 4xx from the provider (it refused the request) or our own input check
// proves nothing was created; the client marks every other failure of a
// mutating call with `uncertain`.
function failureToken (r) {
  return r && r.uncertain === true ? 'resultado-incerto' : 'indisponivel'
}

// A fixed window whose room can be checked without spending it: a request is
// only charged once every narrower limit let it through, so refused attempts
// never fill the shared ceiling.
function ceiling (limit, windowMs, now) {
  let start = now()
  let count = 0
  function roll () {
    const t = now()
    if (t - start >= windowMs) {
      start = t
      count = 0
    }
  }
  return {
    has () { roll(); return count < limit },
    take () { roll(); count++ }
  }
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// The same canonical form as apps/app/src/wallet.js canonicalJson: each entry
// serialized on its own, so integer-like keys keep UTF-16 order.
function canonicalJson (obj) {
  return '{' + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ':' + JSON.stringify(obj[key])).join(',') + '}'
}

function sha256Hex (text) {
  return nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function validText (v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_FIELD &&
    !CONTROL_RE.test(v) && !LONE_SURROGATE_RE.test(v)
}

// Birthdays turn on the Brasília calendar: a fixed UTC-3, since Brazil has
// had no daylight saving time since 2019.
const BRASILIA_OFFSET_MS = 3 * 3600 * 1000

function adult (dateOfBirth, nowMs) {
  const birth = new Date(dateOfBirth + 'T00:00:00.000Z')
  const today = new Date(nowMs - BRASILIA_OFFSET_MS)
  let age = today.getUTCFullYear() - birth.getUTCFullYear()
  if (today.getUTCMonth() < birth.getUTCMonth() ||
    (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age--
  return age >= 18
}

function remember (map, key, value) {
  map.delete(key)
  while (map.size >= MAX_CACHE) map.delete(map.keys().next().value)
  map.set(key, value)
}

function createWalletRoutes ({
  hodle = null,
  wallets = null,
  ages = null,
  terms = null,
  mode = 'cadastro',
  association,
  origin,
  store,
  log = () => {},
  now = Date.now,
  http,
  dailyLimit = 100,
  network,
  ops = null,
  fees = null,
  maxCents = 300000,
  moneyTimeoutMs = MONEY_TIMEOUT_MS
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse, keyedWindow, fixedWindow } = http
  if (!MODES.includes(mode)) throw new TypeError('walletMode must be one of ' + MODES.join(', '))
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw new TypeError('walletDailyLimit must be a positive integer')
  // The client's network is the one wallets are created on, so it is the only
  // source for what is advertised and stored.
  if (network !== undefined && network !== null && !NETWORKS.includes(network)) {
    throw new TypeError('walletNetwork must be one of ' + NETWORKS.join(', '))
  }
  if (hodle !== null && network !== undefined && network !== null && network !== hodle.network) {
    throw new TypeError('walletNetwork differs from the Hodle client network')
  }
  const net = hodle !== null ? hodle.network : (network ?? null)
  if (hodle !== null && !NETWORKS.includes(net)) throw new TypeError('hodle network must be one of ' + NETWORKS.join(', '))

  if (!Number.isSafeInteger(maxCents) || maxCents < MIN_DEPOSIT_CENTS) throw new TypeError('walletMaxCents must be an integer of at least 100')
  if (!Number.isFinite(moneyTimeoutMs) || moneyTimeoutMs <= 0) throw new TypeError('walletMoneyTimeoutMs must be positive')
  const rates = fees !== null && fees.rates ? fees.rates : ZERO_RATES
  const treasury = fees !== null && fees.treasury ? fees.treasury : null
  if (treasury === null && feeMath.isActive(rates)) throw new TypeError('fees need a treasury')

  const on = hodle !== null && wallets !== null
  const money = MONEY_MODES.includes(mode)
  const actions = mode === 'cadastro'
    ? BASE_ACTIONS
    : money ? [...BASE_ACTIONS, 'wallet-create', ...MONEY_ACTIONS] : [...BASE_ACTIONS, 'wallet-create']
  log({ event: 'carteira', reason: on ? 'ligada' : 'desligada' })

  const limits = {
    optin: keyedWindow(3, DAY_MS, now),
    document: keyedWindow(10, DAY_MS, now),
    submit: keyedWindow(3, DAY_MS, now),
    status: keyedWindow(60, 600 * 1000, now),
    create: keyedWindow(3, DAY_MS, now),
    // Recovery reads after a lost create; they never create anything.
    recover: keyedWindow(6, 600 * 1000, now),
    balance: keyedWindow(30, 600 * 1000, now),
    statement: keyedWindow(30, 600 * 1000, now),
    deposit: keyedWindow(20, DAY_MS, now),
    // Re-taps of a charge already asked for: paid calls, outside `deposit`.
    redeposit: keyedWindow(6, 600 * 1000, now),
    quote: keyedWindow(30, 600 * 1000, now),
    preview: keyedWindow(60, 600 * 1000, now),
    payout: keyedWindow(10, DAY_MS, now),
    opStatus: keyedWindow(60, 600 * 1000, now),
    daily: ceiling(dailyLimit, DAY_MS, now),
    // Each member's share of the ceiling, so one member cannot block the rest.
    memberDaily: keyedWindow(Math.max(10, Math.floor(dailyLimit / 4)), DAY_MS, now),
    policy: fixedWindow(6000, 60 * 1000, now)
  }

  // Tokens die with the process, as an in-memory table would.
  const secret = nodeCrypto.randomBytes(32)
  // nonce -> expiry in ms, for nonces already used by a verified request.
  const spent = new Map()
  // '<action>:<member>' -> Promise<{ value } | { err }> of a run in flight.
  const inflight = new Map()
  // member -> time of the last KYC status read.
  const kycReads = new Map()
  // member -> time of the last latest-attempt lookup after a lost submit.
  const latestReads = new Map()
  // '<subAccountId>:<documentId>' -> { ready, at }.
  const readyCache = new Map()
  // member -> walletId whose stored address Hodle confirmed.
  const verifiedWallets = new Map()
  // member -> the one quote of the payment being reviewed.
  const quotes = new Map()
  // externalId -> time of the last provider read by op-status.
  const opReads = new Map()
  // Members with a debit between its checks and its last leg.
  const debiting = new Set()

  const over = () => refuse('limite-carteira')

  function storageDown () {
    log({ event: 'carteira', reason: 'armazenamento-indisponivel' })
    return refuse('indisponivel')
  }

  function available () {
    if (!on) throw refuse('indisponivel')
    let ok = false
    try { ok = wallets.available() === true } catch {}
    if (!ok) throw storageDown()
  }

  function logProvider (passo, r) {
    const reason = r && typeof r.reason === 'string' && LOG_TOKEN_RE.test(r.reason) ? r.reason : 'falha'
    log({ event: 'carteira', reason: 'hodle-' + passo + '-' + reason })
  }

  function getEntry (member) {
    try {
      return wallets.get(member)
    } catch {
      throw storageDown()
    }
  }

  async function write (fn) {
    try {
      return await fn()
    } catch {
      throw storageDown()
    }
  }

  // A write right after Hodle accepted a call: the effect exists there, so a
  // failure here is an unknown outcome, never a plain refusal the app would
  // retry.
  async function writeAfter (fn) {
    try {
      return await fn()
    } catch {
      log({ event: 'carteira', reason: 'armazenamento-indisponivel' })
      throw refuse('resultado-incerto')
    }
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  // random 12 bytes || expiry (uint32 seconds) || HMAC-SHA256 prefix of 16.
  function tag (member, action, random, expiry) {
    return nodeCrypto.createHmac('sha256', secret)
      .update(NONCE_DOMAIN + '\n' + member + '\n' + action + '\n')
      .update(random)
      .update(expiry)
      .digest()
      .subarray(0, 16)
  }

  function mintNonce (member, action) {
    const random = nodeCrypto.randomBytes(12)
    const expiry = Buffer.alloc(4)
    expiry.writeUInt32BE(Math.floor((now() + NONCE_TTL_MS) / 1000))
    return Buffer.concat([random, expiry, tag(member, action, random, expiry)]).toString('base64url')
  }

  // True when `nonce` was minted here for this member and action and has not
  // expired. Reads nothing but the token.
  function validNonce (nonce, member, action) {
    if (typeof nonce !== 'string' || !TOKEN_RE.test(nonce)) return false
    const buf = Buffer.from(nonce, 'base64url')
    if (buf.length !== NONCE_BYTES || buf.toString('base64url') !== nonce) return false
    const random = buf.subarray(0, 12)
    const expiry = buf.subarray(12, 16)
    if (!nodeCrypto.timingSafeEqual(buf.subarray(16), tag(member, action, random, expiry))) return false
    return expiry.readUInt32BE(0) * 1000 > now()
  }

  function sweep () {
    const t = now()
    for (const [k, v] of spent) if (v <= t) spent.delete(k)
  }

  // Checks the token, the action and the signature over the operation's
  // hash, then spends the nonce. Synchronous from the check to the insert,
  // so two copies of one request cannot both pass. Returns the member and a
  // snapshot of the operation that matches the hash.
  function prove (body, action) {
    const member = memberParam(body.member)
    const nonce = body.nonce
    if (!validNonce(nonce, member, action)) throw refuse('expirado')
    if (body.action !== action) throw refuse('pedido-invalido')
    let op
    try {
      op = JSON.parse(canonicalOp(body.op))
    } catch {
      throw refuse('pedido-invalido')
    }
    if (!verifyWallet({ action, nonce, member, association, opHash: opHash(op) }, body.signature).ok) {
      throw refuse('assinatura-invalida')
    }
    // Only a linked member's signature may allocate a spent entry: keys
    // are free to make.
    linked(member)
    if (spent.has(nonce)) throw refuse('expirado')
    sweep()
    if (spent.size >= MAX_SPENT) throw over()
    spent.set(nonce, Buffer.from(nonce, 'base64url').readUInt32BE(12) * 1000)
    return { member, op }
  }

  function linked (member) {
    if (!store.status(member).linked) throw refuse('nao-vinculado')
  }

  function termsAccepted (member) {
    if (terms === null || !terms.available()) throw refuse('indisponivel')
    let accepted
    try {
      accepted = terms.list(member).some((e) => e.version === TERMS_VERSION)
    } catch {
      throw refuse('indisponivel')
    }
    if (!accepted) throw refuse('termos-pendentes')
  }

  function opKeys (op, required, optional = []) {
    const keys = Object.keys(op)
    for (const k of required) if (!keys.includes(k)) throw refuse('pedido-invalido')
    for (const k of keys) if (!required.includes(k) && !optional.includes(k)) throw refuse('pedido-invalido')
  }

  // A second request for the same member and action shares the first one's
  // answer instead of running (and paying for) the call again.
  async function once (key, fn) {
    const cur = inflight.get(key)
    if (cur !== undefined) {
      const r = await cur
      if (r.err) throw r.err
      return r.value
    }
    let settle
    inflight.set(key, new Promise((resolve) => { settle = resolve }))
    try {
      const value = await fn()
      settle({ value })
      return value
    } catch (err) {
      settle({ err })
      throw err
    } finally {
      inflight.delete(key)
    }
  }

  function dailyRoom () {
    if (!limits.daily.has()) {
      log({ event: 'carteira', reason: 'teto-diario' })
      throw refuse('indisponivel')
    }
  }

  // Charges a paid call that every narrower limit let through. A member past
  // their share is told it is their limit, not that the service is down.
  function paidCall (member) {
    if (!limits.memberDaily(member)) throw over()
    limits.daily.take()
  }

  function subaccountName (member) {
    // 128 bits of the key, so two members never share a name that recovery
    // would match.
    return 'membro-' + member.slice(0, 32)
  }

  // After a lost createSubaccount: adopt the one subaccount with our name
  // that no other member holds. Anything else leaves the member frozen.
  async function recoverSubaccount (member) {
    if (!limits.recover(member)) return false
    const r = await hodle.findSubaccounts({ name: subaccountName(member) })
    if (!r.ok) {
      logProvider('subconta', r)
      return false
    }
    let free
    try {
      free = r.subAccountIds.length === 1 && wallets.bySubAccount(r.subAccountIds[0]) === null
    } catch {
      throw storageDown()
    }
    if (r.complete !== true || !free) {
      log({ event: 'carteira', reason: 'carteira-incerta' })
      return false
    }
    const res = await write(() => wallets.create({ member, subAccountId: r.subAccountIds[0], network: net }))
    if (res.conflict) {
      log({ event: 'carteira', reason: 'conflito' })
      return false
    }
    return true
  }

  // The member's entry: null without an account, the frozen intent when a
  // create may have happened and no read found it yet.
  async function account (member) {
    const e = getEntry(member)
    if (e === null) return null
    if (e.subAccountId !== null) return e
    if (!e.subaccountUncertain) return null
    if (await recoverSubaccount(member)) return getEntry(member)
    return e
  }

  async function needAccount (member) {
    const e = await account(member)
    if (e === null) throw refuse('carteira-pendente')
    if (e.subAccountId === null) throw refuse('carteira-incerta')
    return e
  }

  // Readiness of one upload, read through kycDocumentReady and cached for
  // 20 s. `fresh` re-reads a cached false.
  async function documentReady (subAccountId, documentId, fresh) {
    if (documentId === null) return false
    const key = subAccountId + ':' + documentId
    const hit = readyCache.get(key)
    if (hit !== undefined && now() - hit.at < READ_EVERY_MS && (hit.ready || !fresh)) return hit.ready
    const r = await hodle.kycDocumentReady({ subAccountId, documentId })
    if (!r.ok) {
      logProvider('documento', r)
      return false
    }
    remember(readyCache, key, { ready: r.ready, at: now() })
    return r.ready
  }

  async function readiness (e, fresh = false) {
    const s = e.kyc.status
    if (s === 'pendente' || s === 'aprovado') return { documentReady: true, selfieReady: true }
    if (s === 'recusado' || s === 'expirado') return { documentReady: false, selfieReady: false }
    const [doc, selfie] = await Promise.all([
      documentReady(e.subAccountId, e.kyc.documentId, fresh),
      documentReady(e.subAccountId, e.kyc.selfieId, fresh)
    ])
    return { documentReady: doc, selfieReady: selfie }
  }

  async function view (member, e) {
    if (e.subAccountId === null) {
      return {
        kyc: { state: 'documentos', attempt: 0 },
        network: e.network,
        address: null,
        wallet: null,
        walletUncertain: false,
        subaccountUncertain: true,
        documentReady: false,
        selfieReady: false
      }
    }
    const ready = await readiness(e)
    const address = e.wallet === null ? null : e.wallet.address
    return {
      kyc: { state: e.kyc.status === 'nenhum' ? 'documentos' : e.kyc.status, attempt: e.kyc.attempt },
      network: e.network,
      address,
      wallet: address === null ? null : { address },
      // A create still in flight is not a lost one.
      walletUncertain: e.walletUncertain && !inflight.has('wallet-create:' + member),
      subaccountUncertain: false,
      documentReady: ready.documentReady,
      selfieReady: ready.selfieReady
    }
  }

  async function afterView (member) {
    let e
    try {
      e = wallets.get(member)
    } catch {
      log({ event: 'carteira', reason: 'armazenamento-indisponivel' })
      throw refuse('resultado-incerto')
    }
    return view(member, e)
  }

  // --- routes --------------------------------------------------------------

  async function policy (req, res) {
    if (!limits.policy()) throw new RouteError('pedido-invalido', 429)
    const out = { available: on, network: net, mode }
    if (money) Object.assign(out, { maxCents, fees: feeMath.describe(rates) })
    send(res, 200, out)
  }

  async function start (req, res, body) {
    available()
    const member = memberParam(body.member)
    if (typeof body.action !== 'string' || !actions.includes(body.action)) throw refuse('nao-encontrado')
    send(res, 200, { nonce: mintNonce(member, body.action) })
  }

  async function optin (member, op) {
    opKeys(op, [], ['adult'])
    // The subaccount is permanent: the member declares 18+ before it exists.
    if (op.adult !== 1) throw refuse('idade-minima')
    return once('optin:' + member, async () => {
      const e = await account(member)
      if (e !== null) {
        if (e.subAccountId === null) throw refuse('carteira-incerta')
        return { account: await view(member, e) }
      }
      dailyRoom()
      if (!limits.optin(member)) throw over()
      if (ages !== null) {
        let row
        try {
          row = ages.get(member)
        } catch {
          throw refuse('indisponivel')
        }
        if (row !== null && row.band === '16-17') throw refuse('idade-minima')
      }
      paidCall(member)
      await write(() => wallets.intendSubaccount({ member, network: net }))
      const r = await hodle.createSubaccount({ name: subaccountName(member) })
      if (!r.ok) {
        logProvider('subconta', r)
        const token = failureToken(r)
        if (token === 'indisponivel') await write(() => wallets.clearSubaccountUncertain(member))
        throw refuse(token)
      }
      // On a failed write the intent on disk lets a later read find the
      // subaccount by name.
      const created = await writeAfter(() => wallets.create({ member, subAccountId: r.subAccountId, network: net }))
      if (created.conflict) {
        log({ event: 'carteira', reason: 'conflito' })
        throw refuse('indisponivel')
      }
      return { account: await afterView(member) }
    })
  }

  async function kycDocument (member, op) {
    opKeys(op, ['documentType'], ['isDoubleSided'])
    const { documentType, isDoubleSided = 0 } = op
    if (!DOCUMENT_TYPES.includes(documentType)) throw refuse('pedido-invalido')
    if (isDoubleSided !== 0 && isDoubleSided !== 1) throw refuse('pedido-invalido')
    const selfie = documentType === 'SELFIE-FROM-LIVENESS'
    let e = await needAccount(member)
    if (e.kyc.status === 'pendente') throw refuse('kyc-pendente')
    if (e.kyc.status === 'aprovado') throw refuse('pedido-invalido')
    if (!limits.document(member)) throw over()
    if (e.kyc.status === 'recusado' || e.kyc.status === 'expirado') {
      await write(() => wallets.setKyc({ member, status: 'documentos' }))
      e = getEntry(member)
    }
    const args = { subAccountId: e.subAccountId, documentType }
    if (!selfie) args.isDoubleSided = isDoubleSided === 1
    const r = await hodle.kycDocument(args)
    if (!r.ok) {
      logProvider('documento', r)
      throw refuse(failureToken(r))
    }
    const ids = selfie ? { selfieId: r.documentId } : { documentId: r.documentId }
    await writeAfter(() => wallets.setKyc({ member, status: 'documentos', attempt: e.kyc.attempt, ...ids }))
    if (selfie) return { documentId: r.documentId, livenessUrl: r.livenessUrl }
    const out = { documentId: r.documentId, uploadUrlFront: r.uploadUrlFront }
    if (r.uploadUrlBack !== undefined) out.uploadUrlBack = r.uploadUrlBack
    return out
  }

  // The personal fields, read once into a fresh object. Throws on any shape
  // other than the nine string fields.
  function readKyc (kyc) {
    if (!isPlainObject(kyc)) throw refuse('pedido-invalido')
    const own = Reflect.ownKeys(kyc)
    if (own.length !== KYC_FIELDS.length) throw refuse('pedido-invalido')
    const fields = {}
    for (const key of KYC_FIELDS) {
      const d = Object.getOwnPropertyDescriptor(kyc, key)
      if (d === undefined || !('value' in d) || !validText(d.value)) throw refuse('pedido-invalido')
      fields[key] = d.value
    }
    if (!/^[0-9]{11}$/.test(fields.taxIdNumber)) throw refuse('pedido-invalido')
    if (!/^[0-9]{8}$/.test(fields.zipCode)) throw refuse('pedido-invalido')
    if (fields.country !== 'BR') throw refuse('pedido-invalido')
    const dob = fields.dateOfBirth
    if (!DATE_RE.test(dob) || dob.startsWith('0000')) throw refuse('pedido-invalido')
    const birth = new Date(dob + 'T00:00:00.000Z')
    if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== dob) throw refuse('pedido-invalido')
    if (!adult(dob, now())) throw refuse('idade-minima')
    return fields
  }

  async function kycSubmit (member, op, kyc) {
    opKeys(op, ['kycHash'])
    if (typeof op.kycHash !== 'string' || !HEX64_RE.test(op.kycHash)) throw refuse('pedido-invalido')
    const e = await needAccount(member)
    const s = e.kyc.status
    if (s === 'aprovado') return { account: await view(member, e) }
    if (s === 'pendente') throw refuse('kyc-pendente')
    if (s !== 'documentos') throw refuse('documentos-pendentes')
    let fields = readKyc(kyc)
    if (sha256Hex(canonicalJson(fields)) !== op.kycHash) throw refuse('assinatura-invalida')
    try {
      return await once('kyc-submit:' + member, async () => {
        const ready = await readiness(e, true)
        if (!ready.documentReady || !ready.selfieReady) throw refuse('documentos-pendentes')
        dailyRoom()
        if (!limits.submit(member)) throw over()
        paidCall(member)
        // The intent goes to disk first: after a lost answer the member stays
        // pendente, status looks the attempt up, and nothing is sent twice.
        await write(() => wallets.setKyc({ member, status: 'pendente', attempt: e.kyc.attempt }))
        const r = await hodle.kycSubmit({
          ...fields,
          country: 'BRA',
          subAccountId: e.subAccountId,
          uploadedDocumentId: e.kyc.documentId,
          uploadedSelfieId: e.kyc.selfieId
        })
        fields = null
        if (!r.ok) {
          logProvider('kyc', r)
          if (r.uncertain === true) throw refuse('resultado-incerto')
          // A refusal of the submission itself ends the attempt. Any other
          // definite answer (rate limit, key refused, our own input check)
          // means no attempt exists: back to documentos with the uploads.
          if (/^http-(400|409|422)$/.test(String(r.reason))) {
            await writeAfter(() => wallets.setKyc({ member, status: 'recusado', attempt: e.kyc.attempt }))
            throw refuse('indisponivel')
          }
          await writeAfter(() => wallets.revertKycIntent(member, e.kyc.attempt))
          throw refuse(r.reason === 'http-429' ? 'limite-carteira' : 'indisponivel')
        }
        await writeAfter(() => wallets.setKyc({ member, status: 'pendente', attempt: e.kyc.attempt, attemptId: r.attemptId }))
        kycReads.delete(member)
        return { account: await afterView(member) }
      })
    } finally {
      fields = null
    }
  }

  async function status (member, op) {
    opKeys(op, [])
    if (!limits.status(member)) throw over()
    let e = await account(member)
    if (e === null) return { account: null }
    if (e.subAccountId !== null && e.kyc.status === 'pendente' && e.kyc.attemptId === null &&
      !inflight.has('kyc-submit:' + member) && now() - Date.parse(e.kyc.updatedAt) >= LATEST_AFTER_MS) {
      const last = latestReads.get(member)
      if (last === undefined || now() - last >= READ_EVERY_MS) {
        remember(latestReads, member, now())
        const r = await hodle.kycLatest({ subAccountId: e.subAccountId })
        if (!r.ok) {
          logProvider('kyc', r)
        } else if (r.lastAttemptId !== null && !adoptableAttempt(e.kyc, r.lastAttemptId, r.outcome)) {
          // Hodle keeps one latest id per subaccount: an id this member had
          // before is a closed earlier attempt and must never end this one.
          log({ event: 'carteira', reason: 'kyc-incerto' })
        } else if (r.lastAttemptId !== null) {
          await write(() => wallets.setKyc({ member, status: 'pendente', attempt: e.kyc.attempt, attemptId: r.lastAttemptId }))
          e = getEntry(member)
        }
      }
    }
    if (e.subAccountId !== null && e.kyc.status === 'pendente' && e.kyc.attemptId !== null) {
      const last = kycReads.get(member)
      if (last === undefined || now() - last >= READ_EVERY_MS) {
        remember(kycReads, member, now())
        const r = await hodle.kycStatus(e.kyc.attemptId)
        if (!r.ok) {
          logProvider('kyc', r)
        } else if (r.outcome === 'aprovado' || r.outcome === 'recusado' || r.outcome === 'expirado') {
          await write(() => wallets.setKyc({ member, status: r.outcome, attempt: e.kyc.attempt }))
          e = getEntry(member)
        }
      }
    }
    return { account: await view(member, e) }
  }

  // After a lost createWallet: adopt the wallet Hodle shows on our network,
  // with its walletId checked against its address. A readable answer with no
  // wallet keeps the member frozen: nothing is created again on our own.
  async function recoverWallet (member, e) {
    if (!limits.recover(member)) throw refuse('carteira-incerta')
    const subAccountId = e.subAccountId
    const got = await hodle.walletGet({ subAccountId })
    if (!got.ok) {
      logProvider('leitura', got)
      throw refuse('carteira-incerta')
    }
    if (got.address === null) {
      log({ event: 'carteira', reason: 'carteira-incerta' })
      throw refuse('carteira-incerta')
    }
    const keys = await hodle.walletKeys({ subAccountId })
    if (!keys.ok || typeof keys.walletId !== 'string') {
      logProvider('chaves', keys)
      throw refuse('carteira-incerta')
    }
    const check = await hodle.walletGet({ subAccountId, walletId: keys.walletId })
    if (!check.ok) {
      logProvider('leitura', check)
      throw refuse('carteira-incerta')
    }
    if (check.verified !== true || check.address === null || check.address !== got.address) {
      log({ event: 'carteira', reason: 'carteira-incerta' })
      throw refuse('carteira-incerta')
    }
    const res = await write(() => wallets.setWallet({ member, id: keys.walletId, address: got.address, protectedSymmetricKey: keys.protectedSymmetricKey }))
    if (res.conflict) {
      log({ event: 'carteira', reason: 'conflito' })
      throw refuse('indisponivel')
    }
    return { address: got.address }
  }

  async function walletCreate (member, op, pin) {
    opKeys(op, [])
    if (!validPin(pin)) throw refuse('pin-invalido')
    const first = await needAccount(member)
    const s = first.kyc.status
    if (s === 'recusado' || s === 'expirado') throw refuse('kyc-recusado')
    if (s !== 'aprovado') throw refuse('kyc-pendente')
    if (first.wallet !== null) return { address: first.wallet.address }
    return once('wallet-create:' + member, async () => {
      const e = getEntry(member)
      if (e.wallet !== null) return { address: e.wallet.address }
      // The entry keeps the chain it was opened on; a wallet on another one
      // would not match it.
      if (e.network !== net) {
        log({ event: 'carteira', reason: 'rede-divergente' })
        throw refuse('rede-divergente')
      }
      if (e.walletUncertain) return recoverWallet(member, e)
      dailyRoom()
      if (!limits.create(member)) throw over()
      paidCall(member)
      await write(() => wallets.setWalletUncertain(member, true))
      const r = await hodle.createWallet({ subAccountId: e.subAccountId, walletPin: pin })
      pin = null
      if (!r.ok) {
        logProvider('carteira', r)
        // Hodle refuses a member PIN when the subaccount uses the platform's.
        if (r.reason === 'http-403') log({ event: 'carteira', reason: 'pin-plataforma' })
        const token = failureToken(r)
        if (token === 'indisponivel') await write(() => wallets.setWalletUncertain(member, false))
        throw refuse(token)
      }
      const res = await writeAfter(() => wallets.setWallet({ member, id: r.walletId, address: r.address, protectedSymmetricKey: r.protectedSymmetricKey }))
      if (res.conflict) {
        log({ event: 'carteira', reason: 'conflito' })
        throw refuse('indisponivel')
      }
      return { address: r.address }
    })
  }

  // --- money (pix and completo) ------------------------------------------

  function moneyOpts () {
    return { timeoutMs: moneyTimeoutMs }
  }

  function intIn (v, min, max) {
    return Number.isSafeInteger(v) && v >= min && v <= max
  }

  function validPixKey (pixKey, pixKeyType) {
    return typeof pixKeyType === 'string' && Object.prototype.hasOwnProperty.call(PIX_KEY_RES, pixKeyType) &&
      typeof pixKey === 'string' && PIX_KEY_RES[pixKeyType].test(pixKey)
  }

  function optionalCpf (v) {
    if (v === undefined) return null
    if (typeof v !== 'string' || !CPF_RE.test(v)) throw refuse('pedido-invalido')
    return v
  }

  // A beneficiary CPF is compared with the quote's through its hash, so the
  // quote cache never holds the number itself.
  function cpfTag (cpf) {
    return cpf === null ? null : sha256Hex('cpf\n' + cpf)
  }

  // The same for the Pix key: the quote cache keeps only its hash.
  function pixTag (pixKeyType, pixKey) {
    return sha256Hex('pix\n' + pixKeyType + '\n' + pixKey)
  }

  // The same rule as hodle.js transferState: a failure status wins over a
  // hash; done only on COMPLETED or a hash.
  function transferOutcome (status, txHash) {
    const s = typeof status === 'string' ? status.toUpperCase() : null
    if (TRANSFER_FAILED.includes(s)) return 'failed'
    if ((txHash !== undefined && txHash !== null) || s === 'COMPLETED') return 'done'
    return 'pending'
  }

  // A fee leg's provider row: failed goes back to pendente (re-presented
  // only inside a later confirmed send), done is cobrada, else unchanged.
  // A reference alone proves nothing (a payer may choose one), so only the
  // member's outbound transfer of exactly the fee's amount counts.
  function settleFee (row, operation) {
    if (operation.type !== 'transfer' || operation.direction !== 'out' || operation.cents !== row.fee.cents) return null
    const state = transferOutcome(operation.status, operation.txHash)
    if (state === 'pending') return null
    if (state === 'failed') return ops.setFee(row.externalId, { status: 'pendente' })
    const txHash = normalHash(operation.txHash)
    return ops.setFee(row.externalId, txHash ? { status: 'cobrada', txHash } : { status: 'cobrada' })
  }

  function ledgerRead (fn) {
    try {
      return fn()
    } catch {
      throw storageDown()
    }
  }

  // A ledger read after Hodle accepted a call: as with writeAfter, a store
  // failure is an unknown outcome, never a refusal the app would retry with
  // a new opId.
  function readAfter (fn, externalId) {
    try {
      return fn()
    } catch {
      log({ event: 'carteira', reason: 'armazenamento-indisponivel' })
      throw refuse('resultado-incerto', { externalId })
    }
  }

  function memberRates (e) {
    return feeMath.isSelfTreasury(treasury, { subAccountId: e.subAccountId, address: e.wallet.address }) ? ZERO_RATES : rates
  }

  // The member's approved wallet, its stored address confirmed once by Hodle
  // before any money moves.
  async function ready (member) {
    const e = await needAccount(member)
    if (e.kyc.status !== 'aprovado' || e.wallet === null) throw refuse('carteira-pendente')
    if (e.network !== net) {
      log({ event: 'carteira', reason: 'rede-divergente' })
      throw refuse('rede-divergente')
    }
    if (verifiedWallets.get(member) !== e.wallet.id) {
      const r = await hodle.walletGet({ subAccountId: e.subAccountId, walletId: e.wallet.id })
      if (!r.ok) {
        logProvider('leitura', r)
        throw refuse('indisponivel')
      }
      if (r.verified !== true || r.address !== e.wallet.address) {
        log({ event: 'carteira', reason: 'carteira-incerta' })
        throw refuse('carteira-incerta')
      }
      remember(verifiedWallets, member, e.wallet.id)
    }
    return e
  }

  // The oldest fee this member still owes in BRL, or null. Without a
  // treasury there is nowhere to send it, so nothing is collected or quoted.
  function owedFee (member) {
    if (treasury === null) return null
    const rows = ledgerRead(() => ops.pendingFees(member))
    return rows.find((r) => r.fee.asset === 'BRL' && r.fee.cents > 0 && r.fee.reference !== null) || null
  }

  function owedFeeTotal (member) {
    if (treasury === null) return 0
    let total = 0
    for (const r of ledgerRead(() => ops.pendingFees(member))) if (r.fee.asset === 'BRL') total += r.fee.cents
    return total
  }

  // Every other outstanding fee beyond the one this send collects: a debit
  // must leave it in the wallet for a later send to collect (owner decision:
  // reserve them all). Without a treasury nothing is ever collected.
  function reservedFees (member, collecting) {
    if (treasury === null) return 0
    const o = ledgerRead(() => ops.outstandingFees(member))
    return Math.max(0, o.cents - collecting)
  }

  function feeView (row) {
    return row.fee.status === 'nenhuma' ? null : { cents: row.fee.cents, status: row.fee.status }
  }

  function opView (row) {
    return {
      externalId: row.externalId,
      kind: row.kind,
      status: row.status,
      cents: row.cents,
      hodleFeeCents: row.hodleFeeCents,
      fee: feeView(row),
      dispute: row.dispute,
      to: row.to,
      at: row.createdAt
    }
  }

  function cachedQuote (member) {
    const q = quotes.get(member)
    if (q === undefined) return null
    if (now() - q.at >= QUOTE_TTL_MS) {
      quotes.delete(member)
      return null
    }
    return q
  }

  async function balance (member, op) {
    opKeys(op, [])
    if (!limits.balance(member)) throw over()
    const e = await ready(member)
    const r = await hodle.balance({ subAccountId: e.subAccountId, walletId: e.wallet.id })
    if (!r.ok) {
      logProvider('saldo', r)
      throw refuse('indisponivel')
    }
    if (r.address !== null && r.address !== e.wallet.address) {
      log({ event: 'carteira', reason: 'carteira-incerta' })
      throw refuse('carteira-incerta')
    }
    return { cents: r.cents, address: e.wallet.address, network: net, pendingFeeCents: owedFeeTotal(member) }
  }

  function kindOf (type) {
    if (type === 'deposit') return 'deposit'
    if (type === 'transfer') return 'transfer'
    return 'payout'
  }

  // The member's own ledger row a provider operation belongs to, by its
  // externalId or (transfers) its reference.
  function rowOf (member, id) {
    if (typeof id !== 'string' || !EXTERNAL_ID_RE.test(id)) return null
    const row = ledgerRead(() => ops.get(id))
    return row !== null && row.member === member ? row : null
  }

  // A fee leg's statement row: its reference is '<externalId>:taxa' of one
  // of the member's rows.
  function feeRowOf (member, reference) {
    if (typeof reference !== 'string' || !reference.endsWith(FEE_SUFFIX)) return null
    const row = rowOf(member, reference.slice(0, -FEE_SUFFIX.length))
    return row !== null && row.fee.reference === reference ? row : null
  }

  // Our cursor is '<cutoff ms>.<provider cursor>'. Page one shows every
  // ledger row created at or after the cutoff (merged with its provider row
  // or on its own); later pages skip provider rows that belong to those, so
  // each operation appears once across pages.
  function parseCursor (text) {
    if (text === null) return null
    const m = typeof text === 'string' ? STATEMENT_CURSOR_RE.exec(text) : null
    if (!m) throw refuse('pedido-invalido')
    return { cutoff: Number(m[1]), provider: m[2] }
  }

  async function statement (member, op) {
    opKeys(op, [], ['cursor'])
    const cursor = parseCursor(op.cursor === undefined ? null : op.cursor)
    if (!limits.statement(member)) throw over()
    const e = await ready(member)
    const args = { subAccountId: e.subAccountId, from: new Date(now() - STATEMENT_DAYS * DAY_MS + 60 * 1000).toISOString(), limit: STATEMENT_LIMIT }
    if (cursor !== null) args.cursor = cursor.provider
    const r = await hodle.statement(args)
    if (!r.ok) {
      logProvider('extrato', r)
      throw refuse('indisponivel')
    }
    const first = cursor === null
    const rows = first ? ledgerRead(() => ops.listByMember(member, { limit: STATEMENT_LEDGER_ROWS })) : []
    const cutoff = first
      ? (rows.length > 0 ? Date.parse(rows[rows.length - 1].createdAt) : now())
      : cursor.cutoff
    const matched = new Set()
    const items = []
    for (const o of r.operations) {
      const feeRow = feeRowOf(member, o.reference)
      if (feeRow !== null) {
        // A fee leg folds into its principal; a settled one is reconciled.
        if (feeRow.fee.status !== 'cobrada') {
          try {
            await settleFee(feeRow, o)
          } catch {
            log({ event: 'carteira', reason: 'armazenamento-indisponivel' })
          }
        }
        continue
      }
      const row = rowOf(member, o.externalId) || rowOf(member, o.reference)
      if (row !== null) {
        if (!first && Date.parse(row.createdAt) >= cutoff) continue
        if (matched.has(row.externalId)) continue
        matched.add(row.externalId)
      }
      const fresh = row !== null ? ledgerRead(() => ops.get(row.externalId)) : null
      const item = {
        externalId: row !== null ? row.externalId : null,
        kind: row !== null ? row.kind : kindOf(o.type),
        status: PROVIDER_STATUS[o.status] || 'pendente',
        cents: o.cents,
        hodleFeeCents: row !== null ? row.hodleFeeCents : o.feeCents,
        fee: fresh !== null ? feeView(fresh) : null,
        dispute: row !== null ? row.dispute : null,
        at: o.createdAt,
        to: row !== null ? row.to : null,
        direction: o.direction || (o.type === 'deposit' ? 'in' : 'out')
      }
      if (o.endToEndId !== undefined) item.endToEndId = o.endToEndId
      items.push(item)
    }
    for (const row of rows) {
      if (matched.has(row.externalId)) continue
      const fresh = ledgerRead(() => ops.get(row.externalId))
      items.push({
        externalId: row.externalId,
        kind: row.kind,
        status: row.status,
        cents: row.cents,
        hodleFeeCents: row.hodleFeeCents,
        fee: feeView(fresh),
        dispute: row.dispute,
        at: row.createdAt,
        to: row.to,
        direction: row.kind === 'deposit' ? 'in' : 'out'
      })
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    let next = null
    if (r.cursor !== null) {
      next = String(cutoff) + '.' + r.cursor
      // The app takes cursors of at most 512 characters.
      if (next.length > MAX_CURSOR) {
        log({ event: 'carteira', reason: 'extrato-cursor-longo' })
        next = null
      }
    }
    return { items, cursor: next }
  }

  function opIdParam (v) {
    if (typeof v !== 'string' || !OP_ID_RE.test(v)) throw refuse('pedido-invalido')
    return v
  }

  async function deposit (member, op) {
    opKeys(op, ['opId', 'cents'], ['payerCpf'])
    const opId = opIdParam(op.opId)
    const cents = op.cents
    if (!intIn(cents, MIN_DEPOSIT_CENTS, maxCents)) throw refuse('valor-invalido')
    let payerCpf = optionalCpf(op.payerCpf)
    delete op.payerCpf
    const externalId = externalIdFor(member, 'deposit', opId)
    try {
      return await once('deposit:' + externalId, async () => {
        const e = await ready(member)
        const existing = ledgerRead(() => ops.get(externalId))
        if (existing !== null) {
          if (existing.cents !== cents) throw refuse('operacao-divergente')
          // A settled, expired or refused charge is never asked for again.
          if (!['enviado', 'incerto', 'pendente'].includes(existing.status)) {
            if (existing.status === 'falhou') throw refuse('indisponivel', { externalId })
            return { externalId, status: existing.status, qrCode: null, expiresAt: null, hodleFeeCents: existing.hodleFeeCents }
          }
        }
        // A re-tap re-sends the same externalId, so it is not a new charge
        // against the member's deposit window; it is still a paid call, so
        // it has its own small window and the daily ceiling.
        dailyRoom()
        if (existing === null) {
          if (!limits.deposit(member)) throw over()
        } else if (!limits.redeposit(member)) {
          throw over()
        }
        paidCall(member)
        if (existing === null) {
          const put = await write(() => ops.put({ externalId, member, kind: 'deposit', status: 'enviado', cents, fee: { cents: 0, status: 'nenhuma' } }))
          if (put.divergent) throw refuse('operacao-divergente')
        }
        const row = () => readAfter(() => ops.get(externalId), externalId)
        const args = { subAccountId: e.subAccountId, valueCents: cents, address: e.wallet.address, externalId }
        if (payerCpf !== null) args.taxId = payerCpf
        const r = await hodle.createDeposit(args)
        payerCpf = null
        args.taxId = null
        if (!r.ok) {
          logProvider('deposito', r)
          if (r.code === 'THIRD_PARTY_NOT_ENABLED') log({ event: 'carteira', reason: 'terceiros-desligado' })
          if (r.reason === 'http-409') return reconcileDeposit(e, externalId, row())
          if (r.uncertain === true) {
            await writeAfter(() => advanceOp(ops, row(), { status: 'incerto' }))
            throw refuse('resultado-incerto', { externalId })
          }
          const token = r.reason === 'http-429' ? 'limite-carteira' : 'indisponivel'
          // A refused repeat says nothing about the charge made earlier: the
          // row keeps its status, moved on only by what a status read shows.
          if (existing !== null) {
            const s = await hodle.depositStatus({ subAccountId: e.subAccountId, externalId })
            const status = s.ok ? DEPOSIT_OUTCOME[s.outcome] : undefined
            if (status !== undefined) {
              await writeAfter(() => advanceOp(ops, row(), { status, hodleFeeCents: s.hodleFeeCents, txHash: normalHash(s.txHash) }))
            }
            throw refuse(token, { externalId })
          }
          await writeAfter(() => advanceOp(ops, row(), { status: 'falhou' }))
          throw refuse(token, { externalId })
        }
        await writeAfter(() => advanceOp(ops, row(), { status: 'pendente', providerId: r.walletCharge, hodleFeeCents: r.hodleFeeCents }))
        return {
          externalId,
          status: 'pendente',
          qrCode: r.qrCode,
          expiresAt: r.expiresAt,
          hodleFeeCents: r.hodleFeeCents,
          netCents: Math.max(0, cents - r.hodleFeeCents)
        }
      })
    } finally {
      payerCpf = null
    }
  }

  // A 409 means the externalId exists at Hodle: read what it is, never mark
  // it refused.
  async function reconcileDeposit (e, externalId, row) {
    const s = await hodle.depositStatus({ subAccountId: e.subAccountId, externalId })
    if (!s.ok) {
      logProvider('deposito', s)
      await writeAfter(() => advanceOp(ops, row, { status: 'incerto' }))
      throw refuse('resultado-incerto', { externalId })
    }
    const status = DEPOSIT_OUTCOME[s.outcome] || 'incerto'
    await writeAfter(() => advanceOp(ops, row, { status, hodleFeeCents: s.hodleFeeCents, txHash: normalHash(s.txHash) }))
    const after = readAfter(() => ops.get(externalId), externalId)
    return { externalId, status: after.status, qrCode: null, expiresAt: null, hodleFeeCents: after.hodleFeeCents }
  }

  async function payoutQuote (member, op) {
    opKeys(op, ['cents', 'pixKey', 'pixKeyType'], ['beneficiaryCpf'])
    const { cents, pixKey, pixKeyType } = op
    if (!intIn(cents, MIN_PAYOUT_CENTS, maxCents)) throw refuse('valor-invalido')
    if (!validPixKey(pixKey, pixKeyType)) throw refuse('destino-invalido')
    let taxId = optionalCpf(op.beneficiaryCpf)
    delete op.beneficiaryCpf
    const e = await ready(member)
    // Refused before Hodle reserves anything: this fee could never be sent.
    const fee = feeMath.feeCents(memberRates(e).payout, cents)
    if (fee === null || fee > MAX_TRANSFER_CENTS) throw refuse('valor-invalido')
    dailyRoom()
    if (!limits.quote(member)) throw over()
    paidCall(member)
    // A quote may reserve a payout that cannot be cancelled, so only an
    // explicit tap asks for one, and a new one replaces the last.
    quotes.delete(member)
    const args = { valueCents: cents, pixKey, pixKeyType, subAccountId: e.subAccountId, walletId: e.wallet.id }
    if (taxId !== null) args.taxId = taxId
    const tag = cpfTag(taxId)
    taxId = null
    const r = await hodle.payoutQuote(args)
    args.taxId = null
    if (!r.ok) {
      logProvider('cotacao', r)
      throw refuse(failureToken(r))
    }
    remember(quotes, member, { quoteId: r.quoteId, cents, pix: pixTag(pixKeyType, pixKey), cpf: tag, hodleFeeCents: r.feeCents, at: now() })
    return {
      quoteId: r.quoteId,
      ownerName: r.ownerName,
      taxIdMasked: r.taxIdMasked,
      bankName: r.bankName,
      feeCents: r.feeCents,
      expiresAt: r.expiresAt
    }
  }

  async function preview (member, op) {
    opKeys(op, ['kind', 'cents'], ['quoteId'])
    if (!PREVIEW_KINDS.includes(op.kind)) throw refuse('pedido-invalido')
    if (!intIn(op.cents, 1, maxCents)) throw refuse('valor-invalido')
    if (op.quoteId !== undefined && (typeof op.quoteId !== 'string' || !ID_RE.test(op.quoteId))) throw refuse('pedido-invalido')
    if (!limits.preview(member)) throw over()
    const e = await ready(member)
    let hodleFeeCents = 0
    if (op.quoteId !== undefined) {
      const cached = cachedQuote(member)
      if (cached === null || cached.quoteId !== op.quoteId || cached.cents !== op.cents) throw refuse('taxa-mudou')
      hodleFeeCents = cached.hodleFeeCents
    }
    const pf = owedFee(member)
    const q = feeMath.quote({
      kind: op.kind,
      amountCents: op.cents,
      rates: memberRates(e),
      hodleFeeCents,
      pendingFeeCents: pf === null ? 0 : pf.fee.cents,
      pendingFeeRef: pf === null ? '' : pf.fee.reference,
      maxCents,
      maxFeeCents: MAX_TRANSFER_CENTS,
      minCents: MIN_PAYOUT_CENTS
    })
    return { ...q, reservedFeeCents: reservedFees(member, q.pendingFeeCents) }
  }

  function unresolvedDebit (member) {
    return ledgerRead(() => ops.unresolvedDebits(member)).length > 0
  }

  const PAYOUT_REFUSALS = Object.freeze({
    PIN_INVALID: 'pin-invalido',
    PIN_LOCKED: 'pin-bloqueado',
    INSUFFICIENT_BALANCE: 'saldo-insuficiente',
    PER_TX_LIMIT_EXCEEDED: 'valor-invalido',
    WALLET_BUSY: 'indisponivel'
  })

  // One fee transfer to the treasury, written 'enviada' before dispatch. A
  // 409 for a reference that exists counts as collected only when Hodle
  // shows it completed; anything else stays for a statement read.
  async function feeLeg (e, pin, externalId, cents, reference) {
    if (treasury === null) return { status: 'pendente', code: null }
    await writeAfter(() => ops.setFee(externalId, { status: 'enviada' }))
    const to = treasury.kind === 'sub' ? { toSubAccountId: treasury.id } : { recipientAddress: treasury.address }
    const r = await hodle.transfer({
      fromSubAccountId: e.subAccountId,
      walletId: e.wallet.id,
      ...to,
      amountCents: cents,
      walletPin: pin,
      protectedSymmetricKey: e.wallet.protectedSymmetricKey,
      reference
    }, moneyOpts())
    let status
    let txHash = null
    if (r.ok) {
      // Accepted but not yet completed: it stays enviada (never re-presented)
      // until op-status or the statement finds it by its reference.
      status = r.status === 'done' ? 'cobrada' : 'enviada'
      if (status === 'cobrada') txHash = normalHash(r.txHash)
    } else {
      logProvider('taxa', r)
      status = r.uncertain === true ? 'incerta' : 'pendente'
    }
    if (status !== 'enviada') await writeAfter(() => ops.setFee(externalId, txHash ? { status, txHash } : { status }))
    return { status, code: r.ok ? null : r.code }
  }

  async function payout (member, op, pin) {
    opKeys(op, ['opId', 'cents', 'quoteId', 'pixKey', 'pixKeyType', 'feeCents', 'pendingFeeCents', 'pendingFeeRef', 'totalDebitCents'], ['beneficiaryCpf'])
    const opId = opIdParam(op.opId)
    const { cents, quoteId, pixKey, pixKeyType } = op
    if (!intIn(cents, MIN_PAYOUT_CENTS, maxCents)) throw refuse('valor-invalido')
    if (typeof quoteId !== 'string' || !ID_RE.test(quoteId)) throw refuse('pedido-invalido')
    if (!validPixKey(pixKey, pixKeyType)) throw refuse('destino-invalido')
    for (const k of ['feeCents', 'pendingFeeCents', 'totalDebitCents']) if (!intIn(op[k], 0, Number.MAX_SAFE_INTEGER)) throw refuse('pedido-invalido')
    if (typeof op.pendingFeeRef !== 'string') throw refuse('pedido-invalido')
    let taxId = optionalCpf(op.beneficiaryCpf)
    delete op.beneficiaryCpf
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw refuse('pin-invalido')
    const externalId = externalIdFor(member, 'payout', opId)
    const to = '***' + pixKey.slice(-4)
    try {
      const e = await ready(member)
      const existing = ledgerRead(() => ops.get(externalId))
      if (existing !== null) {
        // The same tap again: its stored outcome, never a second send.
        if (existing.cents !== cents || existing.to !== to || existing.fee.cents !== op.feeCents ||
          existing.pendingFeeCents !== op.pendingFeeCents || (existing.pendingFeeRef ?? '') !== op.pendingFeeRef ||
          existing.totalDebitCents !== op.totalDebitCents) throw refuse('operacao-divergente')
        return { externalId, status: existing.status, fee: feeView(existing), pendingFee: null }
      }
      if (debiting.has(member) || unresolvedDebit(member)) throw refuse('operacao-pendente')
      debiting.add(member)
      try {
        return await sendPayout(member, e, op, pin, externalId, to, taxId)
      } finally {
        debiting.delete(member)
      }
    } finally {
      pin = null
      taxId = null
    }
  }

  async function sendPayout (member, e, op, pin, externalId, to, taxId) {
    const { cents, quoteId, pixKey, pixKeyType } = op
    const cached = cachedQuote(member)
    if (cached === null || cached.quoteId !== quoteId) throw refuse('taxa-mudou')
    if (cached.cents !== cents || cached.pix !== pixTag(pixKeyType, pixKey) || cached.cpf !== cpfTag(taxId)) {
      throw refuse('pedido-invalido')
    }
    const pf = owedFee(member)
    const q = feeMath.quote({
      kind: 'payout',
      amountCents: cents,
      rates: memberRates(e),
      hodleFeeCents: cached.hodleFeeCents,
      pendingFeeCents: pf === null ? 0 : pf.fee.cents,
      pendingFeeRef: pf === null ? '' : pf.fee.reference,
      maxCents,
      maxFeeCents: MAX_TRANSFER_CENTS,
      minCents: MIN_PAYOUT_CENTS
    })
    if (feeMath.checkDebit(op, q) !== null) throw refuse('taxa-mudou')
    if (treasury === null && (q.varandaFeeCents > 0 || q.pendingFeeCents > 0)) throw refuse('indisponivel')
    if (!q.ok) throw refuse('valor-invalido')
    dailyRoom()
    if (!limits.payout(member)) throw over()
    // Charged with the check, before the balance read: payouts racing for the
    // last slot of the shared ceiling must not all pass it.
    paidCall(member)
    const bal = await hodle.balance({ subAccountId: e.subAccountId, walletId: e.wallet.id })
    if (!bal.ok) {
      logProvider('saldo', bal)
      throw refuse('indisponivel')
    }
    if (bal.cents < q.totalDebitCents + reservedFees(member, q.pendingFeeCents)) throw refuse('saldo-insuficiente')

    const feeCents = q.varandaFeeCents
    const feeRef = feeCents > 0 ? feeMath.feeReference(externalId) : null
    const put = await write(() => ops.put({
      externalId,
      member,
      kind: 'payout',
      status: 'enviado',
      cents,
      hodleFeeCents: q.hodleFeeCents,
      fee: { cents: feeCents, status: feeCents > 0 ? 'pendente' : 'nenhuma', reference: feeRef },
      to,
      pendingFeeCents: q.pendingFeeCents,
      pendingFeeRef: q.pendingFeeCents > 0 ? q.pendingFeeRef : null,
      totalDebitCents: q.totalDebitCents
    }))
    if (put.divergent) throw refuse('operacao-divergente')
    const started = now()
    // Read only after hodle.payout returned.
    const row = () => readAfter(() => ops.get(externalId), externalId)

    // Leg 1: the principal.
    const args = {
      subAccountId: e.subAccountId,
      walletId: e.wallet.id,
      walletPin: pin,
      protectedSymmetricKey: e.wallet.protectedSymmetricKey,
      externalId,
      valueCents: cents,
      quoteId
    }
    if (taxId !== null) args.taxId = taxId
    const r = await hodle.payout(args, moneyOpts())
    args.walletPin = null
    args.taxId = null
    if (!r.ok) {
      logProvider('pagamento', r)
      const code = typeof r.code === 'string' ? r.code : null
      // A 5xx, a timeout or an unreadable answer may have debited the
      // wallet, whatever code it carries: only a plain refusal is falhou.
      if (code === 'PAYOUT_IN_PROGRESS' || r.uncertain === true) {
        quotes.delete(member)
        await writeAfter(() => advanceOp(ops, row(), { status: 'incerto' }))
        throw refuse('resultado-incerto', { externalId })
      }
      await writeAfter(() => advanceOp(ops, row(), { status: 'falhou' }))
      const token = Object.prototype.hasOwnProperty.call(PAYOUT_REFUSALS, code) ? PAYOUT_REFUSALS[code] : 'indisponivel'
      throw refuse(token, { externalId })
    }
    quotes.delete(member)
    const mapped = PROVIDER_STATUS[typeof r.status === 'string' ? r.status.toUpperCase() : '']
    const accepted = mapped === 'concluido' || mapped === 'falhou' || mapped === 'devolvido' ? mapped : 'pendente'
    await writeAfter(() => advanceOp(ops, row(), { status: accepted, providerId: r.transactionId }))
    // A status read may have moved the row while the call was in flight, so
    // the legs follow the ledger, not this answer.
    const status = row().status
    // Accepted but already failed or returned: nothing left the wallet for
    // good, so no fee is charged on it and none is shown as owed.
    if (status === 'falhou' || status === 'devolvido') {
      return { externalId, status, fee: null, pendingFee: null }
    }

    // Leg 2: Varanda's fee, only once Hodle reports this payout concluded.
    // Still pending, the fee waits on the row for a later send.
    let fee = feeCents > 0 ? { cents: feeCents, status: 'pendente' } : null
    let legsOk = true
    if (feeCents > 0 && status === 'concluido') {
      const leg = await feeLeg(e, pin, externalId, feeCents, feeRef)
      fee = { cents: feeCents, status: leg.status }
      legsOk = leg.status === 'cobrada'
      if (leg.code === 'PIN_INVALID' || leg.code === 'PIN_LOCKED') legsOk = false
    }

    // Leg 3: at most one fee owed from before, while the tap is fresh.
    let pendingFee = null
    if (pf !== null && q.pendingFeeCents > 0) {
      pendingFee = { cents: pf.fee.cents, status: pf.fee.status }
      if (legsOk && now() - started < LEG_BUDGET_MS) {
        const leg = await feeLeg(e, pin, pf.externalId, pf.fee.cents, pf.fee.reference)
        pendingFee = { cents: pf.fee.cents, status: leg.status }
      }
    }
    return { externalId, status, fee, pendingFee }
  }

  // True only when Hodle answered with a status for the operation and it was
  // written (the ledger may still refuse a backward move).
  async function pollOp (e, row) {
    if (row.kind === 'deposit') {
      const s = await hodle.depositStatus({ subAccountId: e.subAccountId, externalId: row.externalId })
      if (!s.ok) {
        logProvider('consulta', s)
        return false
      }
      const status = DEPOSIT_OUTCOME[s.outcome]
      if (status === undefined) return false
      await write(() => advanceOp(ops, row, { status, hodleFeeCents: s.hodleFeeCents, txHash: normalHash(s.txHash) }))
      return true
    }
    if (row.kind !== 'payout') return false
    if (row.providerId !== null) {
      const s = await hodle.payoutStatus(row.providerId)
      if (!s.ok) {
        logProvider('consulta', s)
        return false
      }
      const status = PROVIDER_STATUS[s.status]
      if (status === undefined || status === 'expirado') return false
      await write(() => advanceOp(ops, row, { status, txHash: normalHash(s.txHash) }))
      return true
    }
    // A lost answer: the statement shows whether the payout exists.
    const f = await findAround(e, row, { externalId: row.externalId })
    if (f === null) return false
    if (f.operation === null) return false
    const status = PROVIDER_STATUS[f.operation.status]
    if (status === undefined || status === 'expirado') return false
    await write(() => advanceOp(ops, row, { status, txHash: normalHash(f.operation.txHash) }))
    return true
  }

  // The webhook's authoritative read (./wallet-webhook.js): a delivery never
  // writes a final status itself, it asks Hodle through pollOp. No member
  // proof and no per-op throttle; the sink's own window and dedupe bound it.
  // Returns the fresh row, null for an unknown externalId, or throws when the
  // read failed or told nothing.
  async function refreshOp (externalId) {
    if (hodle === null || wallets === null || ops === null) throw refuse('indisponivel')
    const row = ledgerRead(() => ops.get(externalId))
    if (row === null) return null
    // Only a row with no move left skips the read: a settled Pix can still
    // be returned (concluido -> devolvido).
    if (row.status === 'devolvido' || (row.status === 'falhou' && row.kind !== 'deposit')) return row
    const e = getEntry(row.member)
    if (e === null || e.subAccountId === null) throw refuse('indisponivel')
    if (!(await pollOp(e, row))) throw refuse('indisponivel')
    return ledgerRead(() => ops.get(externalId))
  }

  // A fee leg dispatched without a usable answer, looked up by reference.
  async function pollFee (e, row) {
    const f = await findAround(e, row, { reference: row.fee.reference })
    if (f === null || f.operation === null) return
    await write(() => settleFee(row, f.operation))
  }

  // Searches the statement in the window around the row (a day before it,
  // up to 30 days after it or now), however old or busy the account. A row
  // past the provider's 89-day statement window stays for the operator.
  async function findAround (e, row, match) {
    const created = Date.parse(row.createdAt)
    if (now() - created > FIND_MAX_AGE_MS) {
      log({ event: 'carteira', reason: 'consulta-antiga' })
      return null
    }
    const from = new Date(created - FIND_BEFORE_MS).toISOString()
    const to = new Date(Math.min(created + FIND_AFTER_MS, now())).toISOString()
    const f = await hodle.findByReference({ subAccountId: e.subAccountId, ...match, from, to, maxPages: FIND_PAGES })
    if (!f.ok) {
      logProvider('consulta', f)
      return null
    }
    return f
  }

  function settled (row) {
    if (row.status === 'concluido' || row.status === 'devolvido') return true
    return row.status === 'falhou' && row.kind !== 'deposit'
  }

  async function opStatus (member, op) {
    opKeys(op, ['externalId'])
    const externalId = op.externalId
    if (typeof externalId !== 'string' || !EXTERNAL_ID_RE.test(externalId)) throw refuse('pedido-invalido')
    if (!limits.opStatus(member)) throw over()
    let row = ledgerRead(() => ops.get(externalId))
    if (row === null || row.member !== member) throw refuse('nao-encontrado')
    const feeOpen = row.fee.status === 'enviada' || row.fee.status === 'incerta'
    if (!settled(row) || feeOpen) {
      const last = opReads.get(externalId)
      if (last === undefined || now() - last >= OP_READ_EVERY_MS) {
        remember(opReads, externalId, now())
        const e = await ready(member)
        if (!settled(row)) await pollOp(e, row)
        row = ledgerRead(() => ops.get(externalId))
        if ((row.fee.status === 'enviada' || row.fee.status === 'incerta') && row.fee.reference !== null) {
          await pollFee(e, row)
          row = ledgerRead(() => ops.get(externalId))
        }
      }
    }
    return opView(row)
  }

  const ACTIONS = {
    optin: (member, op) => optin(member, op),
    'kyc-document': (member, op) => kycDocument(member, op),
    'kyc-submit': (member, op, secret) => kycSubmit(member, op, secret.kyc),
    status: (member, op) => status(member, op),
    'wallet-create': (member, op, secret) => walletCreate(member, op, secret.pin),
    balance: (member, op) => balance(member, op),
    statement: (member, op) => statement(member, op),
    deposit: (member, op) => deposit(member, op),
    'payout-quote': (member, op) => payoutQuote(member, op),
    preview: (member, op) => preview(member, op),
    payout: (member, op, secret) => payout(member, op, secret.pin),
    'op-status': (member, op) => opStatus(member, op)
  }

  async function act (action, req, res, body) {
    // The secrets leave the body before anything else can see it.
    const secret = { pin: body.pin, kyc: body.kyc }
    delete body.pin
    delete body.kyc
    available()
    if (MONEY_ACTIONS.includes(action)) {
      if (ops === null) throw refuse('indisponivel')
      let ok = false
      try { ok = ops.available() === true } catch {}
      if (!ok) throw storageDown()
    }
    const { member, op } = prove(body, action)
    termsAccepted(member)
    // A subaccount being created right now is not a lost one.
    const opening = inflight.get('optin:' + member)
    if (action !== 'optin' && opening !== undefined) await opening
    const out = await ACTIONS[action](member, op, secret)
    secret.pin = null
    secret.kyc = null
    send(res, 200, out)
  }

  function owns (pathname) {
    return pathname === '/account/wallet' || pathname.startsWith('/account/wallet/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'GET' && p === '/account/wallet/policy') return policy(req, res)
    if (req.method === 'POST') {
      const name = p.slice('/account/wallet/'.length)
      if (name === 'start' || actions.includes(name)) {
        checkPost(req)
        const body = await readJsonBody(req, MAX_BODY)
        if (name === 'start') return start(req, res, body)
        return act(name, req, res, body)
      }
    }
    throw refuse('nao-encontrado')
  }

  // Sizes only, never a nonce or an id.
  function stats () {
    return {
      spent: spent.size,
      inflight: inflight.size,
      kycReads: kycReads.size,
      latestReads: latestReads.size,
      readyCache: readyCache.size,
      quotes: quotes.size,
      opReads: opReads.size,
      verifiedWallets: verifiedWallets.size
    }
  }

  return { owns, handle, stats, refreshOp }
}

module.exports = {
  createWalletRoutes,
  canonicalJson,
  MODES
}
