// Helpers for the Google account link (@username). Pure ES module: no React and
// no Node built-ins, so Metro bundles it and Node's import() loads it in tests.
// The page talks to the same-origin account service; it cannot verify
// signatures, so usernameMatches is only a consistency check on data the same
// origin serves.

import { applicationServerKey } from './push-state.js'
import { AGE_STATES } from './age.js'
import { resolveUrl } from './installation.js'
import { isAppClient } from './appClient.js'
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
  'saldo-insuficiente': 'Saldo insuficiente.',
  'carteira-incerta': 'A criação da carteira ainda não foi confirmada.',
  'taxa-mudou': 'A taxa mudou. Confira de novo antes de confirmar.',
  'idade-minima': 'Por enquanto a conta de pagamentos só pode ser aberta por quem tem 18 anos ou mais.',
  'operacao-pendente': 'Uma operação anterior ainda não foi confirmada. Aguarde a confirmação antes de fazer outra.',
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
  // The app is not the page's origin: it never sends ambient cookies (React
  // Native's fetch attaches stored cookies unless told 'omit', whatever the
  // method), and the service tells its writes apart by this header.
  if (isAppClient()) {
    init.credentials = 'omit'
    if (method === 'POST') init.headers['x-varanda-client'] = 'app'
  }
  return { url: resolveUrl(path), init }
}

// `uncertain`: a state-changing call whose outcome is unknown (no answer, a
// 5xx, or a success without a readable body) says so, so the caller can tell
// it from a refusal and re-read instead of repeating it (docs/app.md).
async function call (method, path, body, { allow404 = false, uncertain = false, definite = false, maxBody = MAX_BODY, map404 = null } = {}) {
  const { url, init } = buildRequest(method, path, body)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
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
// Two presigned provider URLs of up to 4096 characters each fit.
const WALLET_MAX_BODY = 16384

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

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
  return call('POST', path, body, { ...opts, maxBody: WALLET_MAX_BODY, map404 })
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

// null on any failure: walletStep treats a missing policy as off.
export const walletPolicy = async () => {
  try {
    const data = await call('GET', '/account/wallet/policy')
    if (!isObject(data) || typeof data.available !== 'boolean' || !WALLET_MODES.includes(data.mode)) return null
    const network = data.network === undefined ? null : data.network
    if (network !== null && (typeof network !== 'string' || !NETWORK_RE.test(network))) return null
    return { available: data.available, network, mode: data.mode }
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
