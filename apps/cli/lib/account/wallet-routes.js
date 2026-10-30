'use strict'

const nodeCrypto = require('node:crypto')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { canonicalOp, verifyWallet, opHash } = require('@varanda/core/lib/wallet-proof')

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
  network
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

  const on = hodle !== null && wallets !== null
  const actions = mode === 'cadastro' ? BASE_ACTIONS : [...BASE_ACTIONS, 'wallet-create']
  log({ event: 'carteira', reason: on ? 'ligada' : 'desligada' })

  const limits = {
    optin: keyedWindow(3, DAY_MS, now),
    document: keyedWindow(10, DAY_MS, now),
    submit: keyedWindow(3, DAY_MS, now),
    status: keyedWindow(60, 600 * 1000, now),
    create: keyedWindow(3, DAY_MS, now),
    // Recovery reads after a lost create; they never create anything.
    recover: keyedWindow(6, 600 * 1000, now),
    daily: ceiling(dailyLimit, DAY_MS, now),
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
    send(res, 200, { available: on, network: net, mode })
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
      limits.daily.take()
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
        limits.daily.take()
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
        } else if (r.lastAttemptId !== null && e.kyc.attempt > 1 && r.outcome !== 'pendente' && r.outcome !== 'aprovado') {
          // Hodle keeps one latest id per subaccount: a closed result may be
          // the previous attempt, which must never end this one.
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
      limits.daily.take()
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

  const ACTIONS = {
    optin: (member, op) => optin(member, op),
    'kyc-document': (member, op) => kycDocument(member, op),
    'kyc-submit': (member, op, secret) => kycSubmit(member, op, secret.kyc),
    status: (member, op) => status(member, op),
    'wallet-create': (member, op, secret) => walletCreate(member, op, secret.pin)
  }

  async function act (action, req, res, body) {
    // The secrets leave the body before anything else can see it.
    const secret = { pin: body.pin, kyc: body.kyc }
    delete body.pin
    delete body.kyc
    available()
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
    return { spent: spent.size, inflight: inflight.size, kycReads: kycReads.size, latestReads: latestReads.size, readyCache: readyCache.size }
  }

  return { owns, handle, stats }
}

module.exports = {
  createWalletRoutes,
  canonicalJson,
  MODES
}
