// Helpers for the Google account link (@username). Pure ES module: no React and
// no Node built-ins, so Metro bundles it and Node's import() loads it in tests.
// The page talks to the same-origin account service; it cannot verify
// signatures, so usernameMatches is only a consistency check on data the same
// origin serves.

import { applicationServerKey } from './push-state.js'
import { AGE_STATES } from './age.js'
import { resolveUrl } from './installation.js'
import { isAppClient } from './appClient.js'

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
  'limite-idade': 'Muitas tentativas de verificação. Tente de novo amanhã.'
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

async function readJson (res) {
  const type = res.headers && res.headers.get ? res.headers.get('content-type') : ''
  if (!/^application\/json\b/i.test(type || '')) return null
  let text
  try { text = await res.text() } catch { return null }
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BODY) return null
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
async function call (method, path, body, { allow404 = false, uncertain = false, definite = false } = {}) {
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
    data = await readJson(res)
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
