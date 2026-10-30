// Helpers for the Google account link (@username). Pure ES module: no React and
// no Node built-ins, so Metro bundles it and Node's import() loads it in tests.
// The page talks to the same-origin account service; it cannot verify
// signatures, so usernameMatches is only a consistency check on data the same
// origin serves.

import { applicationServerKey } from './push-state.js'
import { AGE_STATES } from './age.js'
import { KYC_STATES, canonicalJson } from './wallet.js'

const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6_RE = /^[0-9a-f]{6}$/ // would collide with the default handle (@e905a4)
const TIMEOUT_MS = 8000
const MAX_BODY = 4096
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

// Lives here, not in signupInvite.js (which re-exports both), so the two
// modules never import each other.
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/
export const INVITE_NEEDED_TEXT = 'Para entrar, abra o link de convite que alguém da rede te enviou. Nada sobre você fica guardado enquanto o convite não for usado.'

const RETURN_NOTICES = {
  ok: 'conta vinculada',
  erro: 'não foi possível vincular a conta',
  cancelado: 'vínculo cancelado'
}

const ERROR_MESSAGES = {
  'nome-em-uso': 'esse nome já está em uso',
  'nome-invalido': 'nome inválido',
  'conta-vinculada': 'esta conta Google já está vinculada a outra chave',
  'assinatura-invalida': 'não foi possível provar a chave',
  expirado: 'o vínculo expirou, comece de novo',
  'nao-vinculado': 'esta conta não tem vínculo com uma conta Google',
  'termos-pendentes': 'aceite os termos atuais antes de ligar os avisos',
  'pedido-invalido': 'pedido inválido',
  // Member cap (503). Already-linked members never receive this token.
  'lista-de-espera': 'A Varanda está cheia por enquanto. Nada sobre você foi guardado; volte daqui a alguns dias para tentar de novo. Quem já entrou continua usando a rede normalmente.',
  'convite-obrigatorio': INVITE_NEEDED_TEXT,
  'convite-invalido': 'Este convite não vale mais: já foi usado, venceu ou não existe. Peça outro link para quem te convidou.',
  'limite-convites': 'Você já criou os convites desta semana. Na segunda-feira volta a contar.',
  'idade-pendente': 'Confirme sua idade antes de continuar.',
  'limite-idade': 'Muitas tentativas de verificação. Tente de novo amanhã.',
  'carteira-pendente': 'Abra a conta de pagamentos antes.',
  'kyc-pendente': 'A verificação de identidade ainda não terminou.',
  'kyc-recusado': 'A verificação de identidade não foi aprovada.',
  'documentos-pendentes': 'Envie o documento e a selfie antes.',
  'pin-invalido': 'PIN incorreto.',
  'pin-bloqueado': 'PIN bloqueado por 24 horas após três erros.',
  'limite-carteira': 'Muitas operações. Tente de novo mais tarde.',
  'valor-invalido': 'Valor inválido.',
  'destino-invalido': 'Destino inválido.',
  'saldo-insuficiente': 'Saldo insuficiente. O saldo precisa cobrir também as taxas pendentes.',
  'carteira-incerta': 'A criação da carteira ainda não foi confirmada.',
  'taxa-mudou': 'A taxa mudou. Confira de novo antes de confirmar.',
  'idade-minima': 'Por enquanto a conta de pagamentos só pode ser aberta por quem tem 18 anos ou mais.',
  'operacao-pendente': 'Uma operação anterior ainda não foi confirmada. Aguarde a confirmação antes de fazer outra.',
  'operacao-divergente': 'Esta operação já foi pedida com outros valores. Comece de novo.',
  // Never sent by the service: the app's name for the 404 that wallet
  // creation answers while the operator keeps the 'cadastro' mode.
  'aguardando-carteira': 'Verificação aprovada. A carteira será liberada em breve.'
}
const FALLBACK_MESSAGE = 'serviço indisponível'

// Normalized username (one leading '@' stripped, lowercased) or null.
export function isUsername (text) {
  if (typeof text !== 'string') return null
  const name = (text.startsWith('@') ? text.slice(1) : text).toLowerCase()
  if (!USERNAME_RE.test(name) || HEX6_RE.test(name)) return null
  return name
}

// ?conta=ok|erro|cancelado -> fixed notice, or null.
export function parseReturn (search) {
  if (typeof search !== 'string') return null
  let value
  try { value = new URLSearchParams(search).get('conta') } catch { return null }
  return Object.hasOwn(RETURN_NOTICES, value) ? RETURN_NOTICES[value] : null
}

// ?conta=lista-de-espera (the service refused the Google callback while the
// member cap was full, before exchanging the code) -> the calm waitlist
// sentence, or ''. Not a return notice: the screen shows it as its
// waitlist state, as for a 503 from start/finish.
export function parseReturnWaitlist (search) {
  if (typeof search !== 'string') return ''
  let value
  try { value = new URLSearchParams(search).get('conta') } catch { return '' }
  return value === 'lista-de-espera' ? ERROR_MESSAGES['lista-de-espera'] : ''
}

// ?conta=convite-invalido (the invite died between /convite and the Google
// return) -> the calm sentence, or ''. Like the waitlist, not a return notice.
export function parseReturnInvite (search) {
  if (typeof search !== 'string') return ''
  let value
  try { value = new URLSearchParams(search).get('conta') } catch { return '' }
  return value === 'convite-invalido' ? ERROR_MESSAGES['convite-invalido'] : ''
}

export function usernameMatches (record, member, name) {
  return !!record && typeof record === 'object' && !Array.isArray(record) &&
    record.member === member && record.username === name
}

// ISO timestamp -> 'DD/MM/AAAA' in the viewer's local time zone, '' if invalid.
export function formatNextChange (iso) {
  if (typeof iso !== 'string') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear()
}

// Never carries a raw body: the message comes from a fixed table.
export function toError (code, nextChangeAt) {
  let message
  let token = 'indisponivel'
  if (code === 'troca-bloqueada') {
    token = code
    const when = formatNextChange(nextChangeAt)
    message = when ? 'você poderá trocar de novo em ' + when : 'você ainda não pode trocar o nome'
  } else if (Object.hasOwn(ERROR_MESSAGES, code)) {
    token = code
    message = ERROR_MESSAGES[code]
  } else {
    message = FALLBACK_MESSAGE
  }
  const err = new Error(message)
  err.code = token
  if (token === 'troca-bloqueada' && typeof nextChangeAt === 'string') err.nextChangeAt = nextChangeAt
  return err
}

async function readJson (res, maxBody = MAX_BODY) {
  const type = res.headers && res.headers.get ? res.headers.get('content-type') : ''
  if (!/^application\/json\b/i.test(type || '')) return null
  let text
  try { text = await res.text() } catch { return null }
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > maxBody) return null
  try { return JSON.parse(text) } catch { return null }
}

export function buildRequest (method, path, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return { url: path, init }
}

// `uncertain`: a state-changing call whose outcome is unknown (no answer, a
// 5xx, or a success without a readable body) says so, so the caller can tell
// it from a refusal and re-read instead of repeating it (docs/app.md).
async function call (method, path, body, { allow404 = false, uncertain = false, definite = false, maxBody = MAX_BODY, map404 = null, timeoutMs = TIMEOUT_MS } = {}) {
  const { url, init } = buildRequest(method, path, body)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const fail = (code, nextChangeAt, unknown) => {
    const err = toError(code, nextChangeAt)
    if (uncertain && unknown) err.uncertain = true
    return err
  }
  let res
  let data
  try {
    res = await fetch(url, { ...init, signal: ctl.signal })
    data = await readJson(res, maxBody)
  } catch {
    throw fail('indisponivel', undefined, true)
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) {
    if (data === null || typeof data !== 'object') throw fail('indisponivel', undefined, true)
    return data
  }
  if (allow404 && res.status === 404) return null
  const code = data && typeof data.error === 'string' ? data.error : ''
  if (map404 && res.status === 404) throw fail(map404(code))
  // `definite`: the route answers a 5xx with an error token only before it
  // changed anything, so that answer is a refusal, not an unknown outcome. A
  // 5xx without a known token (a proxy page, a crash) stays uncertain.
  const known = definite && (code === 'indisponivel' || Object.hasOwn(ERROR_MESSAGES, code))
  throw fail(code, data && data.nextChangeAt, res.status >= 500 && !known)
}

export const accountStatus = (member) =>
  call('GET', '/account/status?member=' + encodeURIComponent(member))
// The invite code goes in only when it is well formed: the service decides
// whether it is still valid.
export const startLink = ({ member, username, invite }) => {
  const body = { member, username }
  if (typeof invite === 'string' && INVITE_CODE_RE.test(invite)) body.invite = invite
  return call('POST', '/account/start', body)
}
export const authorizeLink = ({ signature }) =>
  call('POST', '/account/authorize', { signature })
export const readPending = () =>
  call('GET', '/account/pending', undefined, { allow404: true })
export const finishLink = ({ signature }) =>
  call('POST', '/account/finish', { signature })
export const lookupUsername = (name) =>
  call('GET', '/account/username/' + encodeURIComponent(name), undefined, { allow404: true })
export const renameStart = ({ member, username }) =>
  call('POST', '/account/rename/start', { member, username })
export const renameFinish = ({ member, nonce, signature }) =>
  call('POST', '/account/rename/finish', { member, nonce, signature })

// Terms acceptance sync: the member proves its key over a server nonce, the
// service records which version that Google account accepted and when.
export const termsStart = async ({ member, version }) => {
  const data = await call('POST', '/account/terms/start', { member, version })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
export const termsFinish = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/terms/finish', { member, nonce, signature })
  if (!Number.isInteger(data.version) || typeof data.acceptedAt !== 'string') throw toError('indisponivel')
  return { version: data.version, acceptedAt: data.acceptedAt }
}

// Web Push (pushClient.web.js). The key read and the check answer null on any
// failure: the Ajustes row then hides or reads "not known", nothing more.
export const pushKey = async () => {
  try {
    const data = await call('GET', '/account/push/key')
    return applicationServerKey(data.key) !== null ? data.key : null
  } catch {
    return null
  }
}
export const pushStart = async ({ member, action }) => {
  const data = await call('POST', '/account/push/start', { member, action })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
export const pushFinish = async ({ member, nonce, action, signature, endpoint, p256dh, auth }) => {
  const data = await call('POST', '/account/push/finish', { member, nonce, action, signature, endpoint, p256dh, auth }, { uncertain: true })
  if (data.ok !== true || typeof data.changed !== 'boolean') {
    const err = toError('indisponivel')
    err.uncertain = true
    throw err
  }
  return { ok: true, changed: data.changed }
}
export const pushCheck = async ({ member, endpoint, p256dh, auth }) => {
  try {
    const data = await call('POST', '/account/push/check', { member, endpoint, p256dh, auth })
    return typeof data.registered === 'boolean' ? { registered: data.registered } : null
  } catch {
    return null
  }
}

const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v))
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const isPerWeek = (v) => Number.isInteger(v) && v >= 1 && v <= 100

function exactKeys (o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k))
}

// Signup invites. null on 404: an older service, or one without the feature.
export const invitePolicy = async () => {
  const data = await call('GET', '/account/invites/policy', undefined, { allow404: true })
  if (data === null) return null
  if (exactKeys(data, ['required']) && data.required === false) return { required: false }
  if (exactKeys(data, ['required', 'perWeek']) && data.required === true && isPerWeek(data.perWeek)) {
    return { required: true, perWeek: data.perWeek }
  }
  throw toError('indisponivel')
}
export const invitesStart = async ({ member }) => {
  const data = await call('POST', '/account/invites/start', { member })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
export const invitesFinish = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/invites/finish', { member, nonce, signature })
  if (typeof data.code !== 'string' || !INVITE_CODE_RE.test(data.code) || !isIso(data.expiresAt) ||
    !isCount(data.used) || !isCount(data.remaining) || !isIso(data.resetsAt)) {
    throw toError('indisponivel')
  }
  return { code: data.code, expiresAt: data.expiresAt, used: data.used, remaining: data.remaining, resetsAt: data.resetsAt }
}

// Hosted age check (src/age.js). The policy read answers null on any failure;
// ageGate treats null as required, so a broken read never lets anyone past.
export const agePolicy = async () => {
  try {
    const data = await call('GET', '/account/age/policy')
    return exactKeys(data, ['required']) && typeof data.required === 'boolean' ? { required: data.required } : null
  } catch {
    return null
  }
}
export const ageStart = async ({ member }) => {
  const data = await call('POST', '/account/age/start', { member })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}

function isVerificationUrl (v) {
  if (typeof v !== 'string' || !v.startsWith('https://')) return false
  let u
  try { u = new URL(v) } catch { return false }
  return u.protocol === 'https:' && u.username === '' && u.password === ''
}

// Creates a provider session on the service, so an unknown outcome is
// uncertain; the service's own 503 'indisponivel' is not unknown (it answers
// it only before creating anything). The invite goes in only when well
// formed: the service checks it before sending anyone to the provider.
export const ageSession = async ({ member, nonce, signature, invite }) => {
  const body = { member, nonce, signature }
  if (typeof invite === 'string' && INVITE_CODE_RE.test(invite)) body.invite = invite
  const data = await call('POST', '/account/age/session', body, { uncertain: true, definite: true })
  if (isVerificationUrl(data.url)) return { url: data.url }
  if (data.state === 'verificado') return { state: 'verificado' }
  const err = toError('indisponivel')
  err.uncertain = true
  throw err
}
// The service may record the band and close the provider session before it
// answers, so an unknown outcome is uncertain too; its own error tokens come
// only before the band is recorded.
export const ageResult = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/age/result', { member, nonce, signature }, { uncertain: true, definite: true })
  if (typeof data.state === 'string' && AGE_STATES.includes(data.state)) return { state: data.state }
  const err = toError('indisponivel')
  err.uncertain = true
  throw err
}

// Optional payments account (Hodle). Every signed POST carries the action and
// the exact op the member signed: the service recomputes the op hash from
// what it receives. The PIN and the KYC fields go straight into one request
// body and are never kept here.
const WALLET_MODES = Object.freeze(['cadastro', 'carteira', 'pix', 'completo'])
const NETWORK_RE = /^[a-z]{1,16}$/
const WALLET_ADDRESS_RE = /^0x[0-9a-f]{40}$/
const UPLOAD_HOST = 'uploads.hodle.com.br'
const LIVENESS_HOST = 'app.hodle.com.br'
const UPLOAD_TYPES = Object.freeze(['image/jpeg', 'image/png'])
const UPLOAD_MAX = 10 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 30000
// Two presigned provider URLs of up to 4096 characters each fit, and so does
// a statement page (provider rows merged with the ledger's own rows).
const WALLET_MAX_BODY = 16384
// Reads and quotes may wait on one or two provider calls; the service's own
// request timeout bounds receipt of the request, not the handler.
const WALLET_TIMEOUT_MS = 20000
// A debit runs up to three provider legs of 30 s each (C2). Giving up sooner
// would only turn a known outcome into an uncertain one.
const WALLET_MONEY_TIMEOUT_MS = 100000
// op-status may read up to 10 statement pages before it answers.
const WALLET_OP_STATUS_TIMEOUT_MS = 60000
const FEE_KEY_RE = /^[a-z]{1,16}$/
const FEE_TEXT_MAX = 64

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function isHodleUrl (v, host) {
  if (!isVerificationUrl(v)) return false
  const u = new URL(v)
  return u.hostname === host && u.port === ''
}

function uncertainError () {
  const err = toError('indisponivel')
  err.uncertain = true
  return err
}

// The service answers 404 with two tokens: 'nao-encontrado' when the route
// is not mounted (wallet creation while the operator keeps the 'cadastro'
// mode) and 'expirado' for a missing or expired nonce. Both are definite.
async function walletCall (path, body, opts = {}) {
  const map404 = (code) => {
    if (code === 'nao-encontrado' && body.action === 'wallet-create') return 'aguardando-carteira'
    return code === 'expirado' ? 'expirado' : 'indisponivel'
  }
  return call('POST', path, body, { maxBody: WALLET_MAX_BODY, ...opts, map404 })
}

function parseAccount (a) {
  if (a === null) return null
  if (!isObject(a) || !isObject(a.kyc)) return undefined
  const { state, attempt } = a.kyc
  if (typeof state !== 'string' || !KYC_STATES.includes(state) || !Number.isSafeInteger(attempt) || attempt < 0) return undefined
  if (typeof a.network !== 'string' || !NETWORK_RE.test(a.network)) return undefined
  if (a.address !== null && (typeof a.address !== 'string' || !WALLET_ADDRESS_RE.test(a.address))) return undefined
  let wallet = null
  if (a.wallet !== null) {
    if (!isObject(a.wallet) || typeof a.wallet.address !== 'string' || !WALLET_ADDRESS_RE.test(a.wallet.address)) return undefined
    wallet = { address: a.wallet.address }
  }
  for (const k of ['subaccountUncertain', 'walletUncertain', 'documentReady', 'selfieReady']) {
    if (typeof a[k] !== 'boolean') return undefined
  }
  return {
    kyc: { state, attempt },
    network: a.network,
    address: a.address,
    wallet,
    subaccountUncertain: a.subaccountUncertain,
    walletUncertain: a.walletUncertain,
    documentReady: a.documentReady,
    selfieReady: a.selfieReady
  }
}

// The fee descriptions the service builds (fees.js describe): short texts
// shown as they are, keyed by operation kind.
function parseFeeTexts (v) {
  if (!isObject(v)) return null
  const keys = Object.keys(v)
  if (keys.length > 16) return null
  const out = {}
  for (const k of keys) {
    const text = v[k]
    if (!FEE_KEY_RE.test(k) || typeof text !== 'string' || text.length > FEE_TEXT_MAX || CONTROL_RE.test(text)) return null
    out[k] = text
  }
  return out
}

// null on any failure: walletStep treats a missing policy as off.
export const walletPolicy = async () => {
  try {
    const data = await call('GET', '/account/wallet/policy')
    if (!isObject(data) || typeof data.available !== 'boolean' || !WALLET_MODES.includes(data.mode)) return null
    const network = data.network === undefined ? null : data.network
    if (network !== null && (typeof network !== 'string' || !NETWORK_RE.test(network))) return null
    const out = { available: data.available, network, mode: data.mode }
    // Absent from a service without the money routes.
    if (data.maxCents !== undefined) {
      if (!isCount(data.maxCents)) return null
      out.maxCents = data.maxCents
    }
    if (data.fees !== undefined) {
      const fees = parseFeeTexts(data.fees)
      if (fees === null) return null
      out.fees = fees
    }
    return out
  } catch {
    return null
  }
}

export const walletStart = async ({ member, action }) => {
  const data = await walletCall('/account/wallet/start', { member, action })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}

// Creates the subaccount at the provider; the service's 503 'indisponivel'
// comes only before it sent anything.
export const walletOptin = async ({ member, nonce, signature, op }) => {
  const data = await walletCall('/account/wallet/optin', { member, nonce, action: 'optin', op, signature }, { uncertain: true, definite: true })
  const out = { ok: true }
  if (Object.hasOwn(data, 'account')) {
    const account = parseAccount(data.account)
    if (account !== undefined) out.account = account
  }
  return out
}

// The upload and liveness URLs are single-use capabilities: returned to the
// caller, never kept. The call creates a provider document, so an unknown
// outcome (or a success without usable URLs) is uncertain.
export const walletKycDocument = async ({ member, nonce, signature, op }) => {
  const data = await walletCall('/account/wallet/kyc-document', { member, nonce, action: 'kyc-document', op, signature }, { uncertain: true, definite: true })
  if (isObject(op) && op.documentType === 'SELFIE-FROM-LIVENESS') {
    if (isHodleUrl(data.livenessUrl, LIVENESS_HOST)) return { livenessUrl: data.livenessUrl }
    throw uncertainError()
  }
  if (!isHodleUrl(data.uploadUrlFront, UPLOAD_HOST)) throw uncertainError()
  const out = { uploadUrlFront: data.uploadUrlFront }
  if (isObject(op) && op.isDoubleSided === 1) {
    if (!isHodleUrl(data.uploadUrlBack, UPLOAD_HOST)) throw uncertainError()
    out.uploadUrlBack = data.uploadUrlBack
  }
  return out
}

export const walletKycSubmit = async ({ member, nonce, signature, op, kyc }) => {
  const data = await walletCall('/account/wallet/kyc-submit', { member, nonce, action: 'kyc-submit', op, signature, kyc }, { uncertain: true, definite: true })
  const out = { ok: true }
  if (Object.hasOwn(data, 'account')) {
    const account = parseAccount(data.account)
    if (account !== undefined) out.account = account
  }
  return out
}

export const walletStatus = async ({ member, nonce, signature, op }) => {
  const data = await walletCall('/account/wallet/status', { member, nonce, action: 'status', op, signature })
  const account = Object.hasOwn(data, 'account') ? parseAccount(data.account) : undefined
  if (account === undefined) throw toError('indisponivel')
  return { account }
}

export const walletCreate = async ({ member, nonce, signature, op, pin }) => {
  const data = await walletCall('/account/wallet/wallet-create', { member, nonce, action: 'wallet-create', op, signature, pin }, { uncertain: true, definite: true })
  if (typeof data.address === 'string' && WALLET_ADDRESS_RE.test(data.address)) return { address: data.address }
  throw uncertainError()
}

// Money (Pix and BRLA). Every shape is checked before the screen sees it; the
// screen still passes provider text (names, bank) through displayText.
// Debits and deposits are never retried here: an unknown outcome is reported
// as uncertain and settled by walletOpStatus or the statement, under the same
// opId.
const OP_KINDS = Object.freeze(['deposit', 'payout', 'transfer', 'crypto', 'swap'])
const OP_STATUSES = Object.freeze(['enviado', 'incerto', 'pendente', 'expirado', 'concluido', 'falhou', 'devolvido'])
const FEE_STATUSES = Object.freeze(['nenhuma', 'pendente', 'enviada', 'incerta', 'cobrada'])
const DISPUTES = Object.freeze(['aberta', 'aceita', 'rejeitada', 'cancelada'])
const EXTERNAL_ID_RE = /^var-[0-9a-f]{32}$/
const FEE_REF_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const QR_RE = /^[\x20-\x7e]{1,1024}$/
const QUOTE_ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/
const E2E_RE = /^[A-Za-z0-9]{1,64}$/
const CURSOR_RE = /^[\x21-\x7e]{1,512}$/
const DIRECTION_RE = /^[a-z]{1,16}$/
const REASON_RE = /^[a-z-]{1,32}$/
const PROVIDER_ISO_RE = /^\d{4}-\d{2}-\d{2}T[\x20-\x7e]{1,40}$/
const STATEMENT_MAX_ITEMS = 100
const MASKED_TO_MAX = 64
// The caps the service applies when it relays a quote (hodle.js).
const OWNER_NAME_MAX = 128
const TAX_ID_MASKED_MAX = 32
const BANK_NAME_MAX = 64
// A first statement page of 100 rows does not fit the 16 KiB wallet reader.
const STATEMENT_MAX_BODY = 65536
// Kinds whose recipient gets exactly the amount sent: every fee is on top.
const FULL_AMOUNT_KINDS = Object.freeze(['payout', 'transfer', 'crypto'])

// Provider timestamps keep their own offset form; any parseable ISO date is
// accepted.
const isProviderIso = (v) => typeof v === 'string' && PROVIDER_ISO_RE.test(v) && Number.isFinite(Date.parse(v))
const isShortText = (v, max) => typeof v === 'string' && v.length <= max && !CONTROL_RE.test(v)

function moneyCall (action, body, opts = {}) {
  return walletCall('/account/wallet/' + action, { ...body, action }, { timeoutMs: WALLET_TIMEOUT_MS, ...opts })
}

const signedBody = ({ member, nonce, signature, op }) => ({ member, nonce, op, signature })

// One ledger or statement row, only its known keys. undefined when malformed.
function parseOp (o) {
  if (!isObject(o)) return undefined
  if (!OP_KINDS.includes(o.kind) || !OP_STATUSES.includes(o.status) || !isCount(o.cents)) return undefined
  const hodleFeeCents = o.hodleFeeCents ?? null
  if (hodleFeeCents !== null && !isCount(hodleFeeCents)) return undefined
  let fee = null
  if (o.fee !== undefined && o.fee !== null) {
    if (!isObject(o.fee) || !isCount(o.fee.cents) || !FEE_STATUSES.includes(o.fee.status)) return undefined
    fee = { cents: o.fee.cents, status: o.fee.status }
  }
  const dispute = o.dispute ?? null
  if (dispute !== null && !DISPUTES.includes(dispute)) return undefined
  const at = o.at ?? null
  if (at !== null && !isProviderIso(at)) return undefined
  const to = o.to ?? null
  if (to !== null && !isShortText(to, MASKED_TO_MAX)) return undefined
  const direction = o.direction ?? null
  if (direction !== null && (typeof direction !== 'string' || !DIRECTION_RE.test(direction))) return undefined
  const externalId = o.externalId ?? null
  if (externalId !== null && (typeof externalId !== 'string' || !EXTERNAL_ID_RE.test(externalId))) return undefined
  const out = { kind: o.kind, status: o.status, cents: o.cents, hodleFeeCents, fee, dispute, at, to, direction, externalId }
  if (o.endToEndId !== undefined && o.endToEndId !== null) {
    if (typeof o.endToEndId !== 'string' || !E2E_RE.test(o.endToEndId)) return undefined
    out.endToEndId = o.endToEndId
  }
  return out
}

export const walletBalance = async (args) => {
  const data = await moneyCall('balance', signedBody(args))
  const address = data.address ?? null
  const network = data.network ?? null
  if (!isCount(data.cents) || !isCount(data.pendingFeeCents) ||
    (address !== null && (typeof address !== 'string' || !WALLET_ADDRESS_RE.test(address))) ||
    (network !== null && (typeof network !== 'string' || !NETWORK_RE.test(network)))) {
    throw toError('indisponivel')
  }
  return { cents: data.cents, address, network, pendingFeeCents: data.pendingFeeCents }
}

// A malformed row refuses the whole page: dropping it could hide an
// uncertain operation the member has to settle first.
export const walletStatement = async (args) => {
  const data = await moneyCall('statement', signedBody(args), { maxBody: STATEMENT_MAX_BODY })
  const cursor = data.cursor ?? null
  if (!Array.isArray(data.items) || data.items.length > STATEMENT_MAX_ITEMS ||
    (cursor !== null && (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)))) {
    throw toError('indisponivel')
  }
  const items = data.items.map(parseOp)
  if (items.includes(undefined)) throw toError('indisponivel')
  return { items, cursor }
}

// Creates a Pix charge at the provider, so an unknown outcome is uncertain; a
// new tap with the same opId gets the same charge back. expiresAt may be null
// because the provider does not always send it. qrCode null with a ledger
// status is a known answer: the charge was reconciled or is already final,
// so the screen shows the status instead of a code.
export const walletDeposit = async (args) => {
  const data = await moneyCall('deposit', signedBody(args), { uncertain: true, definite: true, timeoutMs: WALLET_MONEY_TIMEOUT_MS })
  const qrCode = data.qrCode ?? null
  const expiresAt = data.expiresAt ?? null
  const hodleFeeCents = data.hodleFeeCents ?? null
  const netCents = data.netCents ?? null
  const status = data.status ?? null
  const qrOk = qrCode === null
    ? OP_STATUSES.includes(status)
    : typeof qrCode === 'string' && QR_RE.test(qrCode) && qrCode.trim() !== ''
  if (!qrOk || (status !== null && !OP_STATUSES.includes(status)) ||
    (expiresAt !== null && !isProviderIso(expiresAt)) ||
    typeof data.externalId !== 'string' || !EXTERNAL_ID_RE.test(data.externalId) ||
    (hodleFeeCents !== null && !isCount(hodleFeeCents)) ||
    (netCents !== null && !isCount(netCents))) {
    throw uncertainError()
  }
  return { qrCode, expiresAt, externalId: data.externalId, hodleFeeCents, netCents, status }
}

export const walletPayoutQuote = async (args) => {
  const data = await moneyCall('payout-quote', signedBody(args))
  const text = (v, max) => v === null || v === undefined ? '' : (isShortText(v, max) ? v : null)
  const ownerName = text(data.ownerName, OWNER_NAME_MAX)
  const bankName = text(data.bankName, BANK_NAME_MAX)
  const taxIdMasked = text(data.taxIdMasked, TAX_ID_MASKED_MAX)
  const expiresAt = data.expiresAt ?? null
  if (typeof data.quoteId !== 'string' || !QUOTE_ID_RE.test(data.quoteId) || !isCount(data.feeCents) ||
    ownerName === null || bankName === null || taxIdMasked === null ||
    (expiresAt !== null && !isProviderIso(expiresAt))) {
    throw toError('indisponivel')
  }
  return { quoteId: data.quoteId, ownerName, taxIdMasked, bankName, feeCents: data.feeCents, expiresAt }
}

// The total must be the sum of its lines, so the confirmation never shows a
// total its lines do not add up to.
export const walletPreview = async (args) => {
  const data = await moneyCall('preview', signedBody(args))
  const keys = ['amountCents', 'varandaFeeCents', 'hodleFeeCents', 'pendingFeeCents', 'totalDebitCents', 'netReceivedCents']
  if (!keys.every((k) => isCount(data[k]))) throw toError('indisponivel')
  const ref = data.pendingFeeRef ?? ''
  const refOk = data.pendingFeeCents === 0 ? ref === '' : (typeof ref === 'string' && FEE_REF_RE.test(ref))
  const sum = data.amountCents + data.varandaFeeCents + data.hodleFeeCents + data.pendingFeeCents
  const ok = data.ok ?? true
  const reason = data.reason ?? null
  const kind = isObject(args && args.op) ? args.op.kind : undefined
  const netOk = !FULL_AMOUNT_KINDS.includes(kind) || data.netReceivedCents === data.amountCents
  if (!refOk || !netOk || !Number.isSafeInteger(sum) || sum !== data.totalDebitCents || typeof ok !== 'boolean' ||
    (reason !== null && (typeof reason !== 'string' || !REASON_RE.test(reason)))) {
    throw toError('indisponivel')
  }
  // The other pending fees, held in the balance but not debited by this send.
  // An older service leaves it out.
  const reserved = data.reservedFeeCents
  if (reserved !== undefined && reserved !== null && !isCount(reserved)) throw toError('indisponivel')
  const out = { ok, reason, pendingFeeRef: ref }
  for (const k of keys) out[k] = data[k]
  if (isCount(reserved)) out.reservedFeeCents = reserved
  return out
}

// The debit fields a signed op carries (C10), exactly as the preview showed
// them; the service recomputes each one and answers 'taxa-mudou' otherwise.
export function debitTerms (preview) {
  return {
    feeCents: preview.varandaFeeCents,
    pendingFeeCents: preview.pendingFeeCents,
    pendingFeeRef: preview.pendingFeeRef,
    totalDebitCents: preview.totalDebitCents
  }
}

function parseLeg (v) {
  if (v === undefined || v === null) return null
  if (!isObject(v) || !FEE_STATUSES.includes(v.status)) return undefined
  const cents = v.cents ?? null
  if (cents !== null && !isCount(cents)) return undefined
  return { cents, status: v.status }
}

// The principal and each fee leg are reported apart (C2): a sent payout whose
// fee stayed pendente is a success with a separate note, not a failure. The
// PIN goes into this one request body and nowhere else.
export const walletPayout = async ({ member, nonce, signature, op, pin }) => {
  const data = await moneyCall('payout', { member, nonce, op, signature, pin }, { uncertain: true, definite: true, timeoutMs: WALLET_MONEY_TIMEOUT_MS })
  const principal = isObject(data.principal) ? data.principal : data
  const externalId = principal.externalId ?? data.externalId
  const fee = parseLeg(data.fee)
  const pendingFee = parseLeg(data.pendingFee)
  if (typeof externalId !== 'string' || !EXTERNAL_ID_RE.test(externalId) || !OP_STATUSES.includes(principal.status) ||
    fee === undefined || pendingFee === undefined) {
    throw uncertainError()
  }
  return { externalId, status: principal.status, fee, pendingFee }
}

// One of the member's own operations; the service may poll the provider but
// never sends anything for it.
export const walletOpStatus = async (args) => {
  const data = await moneyCall('op-status', signedBody(args), { timeoutMs: WALLET_OP_STATUS_TIMEOUT_MS })
  const op = parseOp(isObject(data.operation) ? data.operation : data)
  if (op === undefined || op.externalId === null) throw toError('indisponivel')
  return op
}

function toHex (buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Lowercase hex SHA-256 of the UTF-8 canonical JSON: the signed op carries
// only this hash, the service recomputes it from the fields it forwards.
export async function kycHash (kyc) {
  const bytes = new TextEncoder().encode(canonicalJson(kyc))
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes))
}

// The image goes from the browser straight to the provider's single-use URL,
// never through the account service; no cookies, no redirects.
export async function uploadDocument (url, blob) {
  if (!isHodleUrl(url, UPLOAD_HOST)) throw toError('indisponivel')
  if (!blob || typeof blob !== 'object' || !UPLOAD_TYPES.includes(blob.type) ||
    !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > UPLOAD_MAX) {
    throw new Error('arquivo inválido')
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), UPLOAD_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      method: 'PUT',
      body: blob,
      headers: { 'content-type': blob.type },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: ctl.signal
    })
  } catch {
    throw toError('indisponivel')
  } finally {
    clearTimeout(timer)
  }
  if (!res || !(res.status >= 200 && res.status < 300)) throw toError('indisponivel')
}
