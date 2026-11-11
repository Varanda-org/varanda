// Helpers for the Google account link (@username). Pure ES module: no React and
// no Node built-ins, so Metro bundles it and Node's import() loads it in tests.
// The page talks to the same-origin account service; it cannot verify
// signatures, so usernameMatches is only a consistency check on data the same
// origin serves.
/* global __DEV__ */

import { applicationServerKey } from './push-state.js'
import { AGE_STATES } from './age.js'
import { resolveUrl } from './installation.js'
import { accountOriginOf } from './pageGate.js'
import { isAppClient } from './appClient.js'
import { vitrineEnabled } from './vitrine/enabled.js'
import { MAX_BYTES as GIF_MAX_BYTES, imageUrl, parseSearch, searchBody } from './gif.js'

const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6_RE = /^[0-9a-f]{6}$/ // would collide with the default handle (@e905a4)
const TIMEOUT_MS = 8000
const MAX_BODY = 4096
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
// The literal member access is what Expo inlines into the bundle.
const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)

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
  'lista-de-espera': 'A Varanda está cheia por enquanto. Esta tentativa não criou conta nem lugar em fila; volte daqui a alguns dias para tentar de novo. Quem já entrou continua usando a rede normalmente.',
  'convite-obrigatorio': INVITE_NEEDED_TEXT,
  'convite-invalido': 'Este convite não vale mais: já foi usado, venceu ou não existe. Peça outro link para quem te convidou.',
  'limite-convites': 'Você já criou os convites desta semana. Na segunda-feira volta a contar.',
  'convite-aguardando': 'Seu convite desta semana ainda não chegou. Ele aparece de surpresa, com um aviso.',
  'idade-pendente': 'Confirme sua idade antes de continuar.',
  'limite-idade': 'Muitas tentativas de verificação. Tente de novo amanhã.',
  // A Feira code sent to the ordinary age route: never shown if the app picks
  // the route right, so it only asks to try again.
  'use-a-rota-da-feira': 'Não deu para abrir a verificação agora. Tente de novo daqui a pouco.',
  'telefone-pendente': 'Confirme seu celular antes de continuar.',
  'telefone-invalido': 'Digite um celular brasileiro com DDD, por exemplo (11) 91234-5678.',
  'telefone-em-uso': 'Este número já está em outra conta ou não pode ser usado.',
  'telefone-recusado': 'Use um celular brasileiro comum. Números virtuais e fixos não servem.',
  'codigo-invalido': 'Código incorreto. Confira e tente de novo.',
  'codigo-expirado': 'O código venceu. Peça um novo.',
  'limite-telefone': 'Muitas tentativas agora. Tente de novo mais tarde.',
  'limite-gif': 'Limite de buscas de GIF por hoje',
  'nao-autorizado': 'a sessão de busca de GIF expirou',
  'limite-previa': 'Limite de prévias de links por hoje',
  'limite-recuperacao': 'você já tem o máximo de passkeys e códigos cadastrados; remova um antes',
  // A seen write or delete lost the compare-and-swap: nothing was written.
  conflito: 'Outro aparelho gravou antes.'
}
// Tokens whose sentence only fits the recovery routes: 'nao-encontrado' also
// answers rename and unknown routes, where this sentence would be wrong.
const RECOVERY_MESSAGES = {
  'nao-encontrado': 'esta passkey ou este código não está ligado a uma conta neste endereço'
}
// Excluir conta (/account/delete/*, apps/cli/lib/account/delete-routes.js).
const DELETE_MESSAGES = {
  'conta-excluida': 'esta conta já foi excluída',
  'paginas-ativas': 'você ainda é dono de uma página: encerre ou transfira suas páginas antes de excluir a conta',
  'nao-vinculado': 'esta conta não está vinculada ao serviço',
  expirado: 'o pedido expirou: tente de novo',
  'assinatura-invalida': 'o @nome digitado não confere com a conta',
  lotado: 'o serviço não conseguiu registrar o pedido agora: tente de novo mais tarde',
  'passkey-invalida': 'o serviço de conta não aceitou a confirmação da passkey: tente de novo'
}
// The passkey enrolment after the link (src/passkeyEnrol.js reads the
// tokens; nothing shows these sentences on a screen today).
const PASSKEY_MESSAGES = {
  'passkey-invalida': 'o serviço de conta não aceitou esta passkey',
  'passkey-registrada': 'o serviço de conta já tem a passkey desta conta',
  'vinculo-antigo': 'o prazo para registrar a passkey desta conta passou',
  'conta-excluida': 'esta conta já foi excluída',
  'nao-vinculado': 'esta conta não está vinculada ao serviço',
  expirado: 'o pedido expirou: tente de novo'
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

// Never carries a raw body: the message comes from a fixed table. `extra`
// adds route-scoped tokens (RECOVERY_MESSAGES).
export function toError (code, nextChangeAt, extra) {
  let message
  let token = 'indisponivel'
  if (code === 'troca-bloqueada') {
    token = code
    const when = formatNextChange(nextChangeAt)
    message = when ? 'você poderá trocar de novo em ' + when : 'você ainda não pode trocar o nome'
  } else if (Object.hasOwn(ERROR_MESSAGES, code)) {
    token = code
    message = ERROR_MESSAGES[code]
  } else if (extra && Object.hasOwn(extra, code)) {
    token = code
    message = extra[code]
  } else {
    message = FALLBACK_MESSAGE
  }
  const err = new Error(message)
  err.code = token
  if (token === 'troca-bloqueada' && typeof nextChangeAt === 'string') err.nextChangeAt = nextChangeAt
  return err
}

export async function readJson (res, maxBody = MAX_BODY) {
  const type = res.headers && res.headers.get ? res.headers.get('content-type') : ''
  if (!/^application\/json\b/i.test(type || '')) return null
  // A declared length over the cap is refused before anything is read, and
  // a streamed body stops at the cap, so a hostile answer is never buffered
  // whole (React Native's fetch has no body stream: text() there).
  const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN)
  if (Number.isFinite(declared) && declared > maxBody) return null
  let text
  try { text = await readCapped(res, maxBody) } catch { return null }
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > maxBody) return null
  try { return JSON.parse(text) } catch { return null }
}

async function readCapped (res, maxBody) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
  if (reader === null) return res.text()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBody) {
      try { await reader.cancel() } catch {}
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.length }
  return new TextDecoder().decode(all)
}

// `extra` headers (the app's link proofs) apply to app requests only, so the
// web's requests stay as they were.
export function buildRequest (method, path, body, extra) {
  // pages.js builds its own requests from here, so this guard keeps every
  // account and page call off the network in the Vitrine too.
  if (VITRINE) throw toError('indisponivel')
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
    // React Native's fetch (whatwg-fetch) appends '_=<timestamp>' to the URL
    // for 'no-store'; one rule for every app request (see media/fetch.js).
    delete init.cache
    if (method === 'POST') init.headers['x-varanda-client'] = 'app'
    if (extra) Object.assign(init.headers, extra)
  }
  return { url: resolveUrl(path), init }
}

// `uncertain`: a state-changing call whose outcome is unknown (no answer, a
// 5xx, or a success without a readable body) says so, so the caller can tell
// it from a refusal and re-read instead of repeating it (docs/app.md).
// `origin`: a core node's https account origin (pages.js pagesOrigin); the
// hosted web app passes none and keeps the relative path.
// `errorBody`: a refusal also carries the parsed JSON body as err.body, for a
// caller that validates it (seenFinish's conflict), so it never fetches again.
// `bareStatus` ({ status: token }) names a refusal that comes without the
// service's JSON token (the edge's own 429, say).
async function call (method, path, body, { allow404 = false, uncertain = false, definite = false, errorBody = false, maxBody = MAX_BODY, timeoutMs = TIMEOUT_MS, headers, origin, sessionToken, signal, messages, bareStatus } = {}) {
  // The Vitrine has no account service: every call is a definite refusal,
  // before any request leaves the page.
  if (VITRINE) throw toError('indisponivel')
  const built = buildRequest(method, path, body, headers)
  const { init } = built
  // Unlike `headers` (app only), a member session (GIF, link preview) rides
  // on every client, in the one header a proxy's error log redacts.
  if (typeof sessionToken === 'string') init.headers.authorization = 'Bearer ' + sessionToken
  const base = accountOriginOf(origin)
  const url = base === undefined ? built.url : base + path
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  // The caller's signal (a stale link preview) aborts the request too.
  const stop = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', stop)
  }
  const fail = (code, nextChangeAt, unknown) => {
    const err = toError(code, nextChangeAt, messages)
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
    if (signal) signal.removeEventListener('abort', stop)
  }
  if (res.ok) {
    if (data === null || typeof data !== 'object') throw fail('indisponivel', undefined, true)
    return data
  }
  // allow404 'nao-encontrado': only the service's own JSON answer is null; any
  // other 404 (a proxy page, an empty body, another token, an older server's
  // unknown route answering a bare 'nao-encontrado') cannot be told from
  // "could not ask", so it is the service being unavailable.
  if (allow404 === 'nao-encontrado' && res.status === 404) {
    if (data && data.error === 'nao-encontrado' && data.recovery === true) return null
    throw fail('indisponivel')
  }
  // allow404 'route': only a route the service does not have is null; a
  // refusal that happens to be a 404 (an expired nonce) stays an error.
  if (allow404 && res.status === 404 && !(allow404 === 'route' && data && data.error === 'expirado')) return null
  let code = data && typeof data.error === 'string' ? data.error : ''
  if (code === '' && bareStatus && Object.hasOwn(bareStatus, res.status)) code = bareStatus[res.status]
  // `definite`: the route answers a 5xx with an error token only before it
  // changed anything, so that answer is a refusal, not an unknown outcome. A
  // 5xx without a known token (a proxy page, a crash) stays uncertain.
  const known = definite && (code === 'indisponivel' || Object.hasOwn(ERROR_MESSAGES, code) || (!!messages && Object.hasOwn(messages, code)))
  const err = fail(code, data && data.nextChangeAt, res.status >= 500 && !known)
  if (errorBody && data && typeof data === 'object') err.body = data
  throw err
}

export const accountStatus = (member, { origin } = {}) =>
  call('GET', '/account/status?member=' + encodeURIComponent(member), undefined, { origin })
// The native app's sign-in (apps/cli/lib/account/app-return.js) replaces the
// web's link cookie with V (linkSecret, kept in the app's memory) and R
// (redeem, from the auth session's result). Both ride in headers, only from
// the app, and only when well formed.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const isToken = (v) => typeof v === 'string' && TOKEN_RE.test(v)
function linkHeaders ({ linkSecret, redeem } = {}) {
  if (!isAppClient()) return undefined
  const h = {}
  if (isToken(linkSecret)) h['x-varanda-link'] = linkSecret
  if (isToken(redeem)) h['x-varanda-redeem'] = redeem
  return h
}
// An app row past the Google step answers only to V and R together: without
// both there is nothing to ask, so nothing is sent.
const appMissingProofs = ({ linkSecret, redeem } = {}) => isAppClient() && !(isToken(linkSecret) && isToken(redeem))

// The invite code goes in only when it is well formed: the service decides
// whether it is still valid. From the app, appProof (the hash of a fresh V)
// goes in the body, and a V already held (a restart) in the header.
export const startLink = ({ member, username, invite, appProof, linkSecret }) => {
  const body = { member, username }
  if (typeof invite === 'string' && INVITE_CODE_RE.test(invite)) body.invite = invite
  if (isAppClient() && isToken(appProof)) body.appProof = appProof
  return call('POST', '/account/start', body, { headers: linkHeaders({ linkSecret }) })
}
export const authorizeLink = ({ signature, linkSecret }) =>
  call('POST', '/account/authorize', { signature }, { headers: linkHeaders({ linkSecret }) })
export const readPending = (opts = {}) => {
  if (appMissingProofs(opts)) return Promise.resolve(null)
  return call('GET', '/account/pending', undefined, { allow404: true, headers: linkHeaders(opts) })
}
export const finishLink = ({ signature, linkSecret, redeem }) => {
  if (appMissingProofs({ linkSecret, redeem })) return Promise.reject(toError('expirado'))
  return call('POST', '/account/finish', { signature }, { headers: linkHeaders({ linkSecret, redeem }) })
}
export const lookupUsername = (name, { origin } = {}) =>
  call('GET', '/account/username/' + encodeURIComponent(name), undefined, { allow404: true, origin })
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
// Seen state shared by the devices of one passkey (seenSync.js). The blob is
// opaque ciphertext the browser node seals and merges; the client only checks
// its shape. Read changes nothing; write and delete are compare-and-swaps on
// prevHash, so a lost answer is uncertain and is never resent here.
const SEEN_BLOB_B64 = 43744 // packages/core/lib/seen-blob.js SEEN_BLOB_B64
const SEEN_MAX_BODY = 49152
const SEEN_TIMEOUT_MS = 20000
const SEEN_HASH_RE = /^[0-9a-f]{64}$/
const SEEN_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const isSeenHash = (v) => typeof v === 'string' && SEEN_HASH_RE.test(v)
const isSeenBlob = (v) => typeof v === 'string' && v.length === SEEN_BLOB_B64 && SEEN_B64_RE.test(v)

export const seenStart = async ({ member, action }) => {
  const data = await call('POST', '/account/seen/start', { member, action })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}

export const seenFinish = async ({ member, nonce, action, signature, prevHash, blob }) => {
  const writes = action === 'write' || action === 'delete'
  const body = { member, nonce, action, signature, prevHash }
  if (action === 'write') body.blob = blob
  const bad = () => {
    const err = toError('indisponivel')
    if (writes) err.uncertain = true
    return err
  }
  let data
  try {
    data = await call('POST', '/account/seen/finish', body, { uncertain: writes, errorBody: true, maxBody: SEEN_MAX_BODY, timeoutMs: SEEN_TIMEOUT_MS })
  } catch (err) {
    const b = err.body || {}
    delete err.body
    if (err.code !== 'conflito') throw err
    // A conflict wrote nothing: definite, with the server's current state.
    const okBlob = action === 'write' ? (b.blob === null || isSeenBlob(b.blob)) : (b.blob === undefined || b.blob === null)
    if (!writes || !isSeenHash(b.hash) || !okBlob) throw toError('indisponivel')
    err.hash = b.hash
    err.blob = action === 'write' ? b.blob : null
    throw err
  }
  if (action === 'read') {
    if (data.hash === null && data.blob === null) return { hash: null, blob: null, unchanged: false }
    if (!isSeenHash(data.hash)) throw bad()
    if (data.unchanged === true && data.blob === null) return { hash: data.hash, blob: null, unchanged: true }
    if (!isSeenBlob(data.blob)) throw bad()
    return { hash: data.hash, blob: data.blob, unchanged: false }
  }
  if (action === 'write') {
    if (data.ok !== true || !isSeenHash(data.hash)) throw bad()
    return { ok: true, hash: data.hash }
  }
  if (data.ok !== true || typeof data.changed !== 'boolean') throw bad()
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
// Unlike agePolicy, where null keeps the check required, null here fails open:
// the account service remains the authority at start, the Google callback,
// finish and the age session.
export const admission = async () => {
  try {
    const data = await call('GET', '/account/admission', undefined, { allow404: true })
    return exactKeys(data, ['open']) && typeof data.open === 'boolean' ? { open: data.open } : null
  } catch {
    return null
  }
}
// Feira entry (apps/cli/lib/account/feira-routes.js). The policy is a hint:
// null (an older service, any failure, a bad shape) falls back to the
// ordinary invite flow, and the service stays the authority at start.
export const feiraPolicy = async () => {
  if (VITRINE) return { enabled: true }
  try {
    const data = await call('GET', '/account/feira/policy', undefined, { allow404: true })
    return exactKeys(data, ['enabled']) && typeof data.enabled === 'boolean' ? { enabled: data.enabled } : null
  } catch {
    return null
  }
}
const FEIRA_MESSAGES = {
  'nao-encontrado': 'Este anúncio não abre uma entrada agora: ele saiu do ar ou a Feira está desligada.'
}
const LISTING_AUTHOR_RE = /^[0-9a-f]{64}$/
// Issues a signup code on the service, so an unknown outcome is uncertain and
// nothing here asks again. A 429 from the proxy carries no token: it is the
// generic 'indisponivel', a definite refusal like every 4xx.
export const feiraStart = async ({ author, seq } = {}) => {
  if (VITRINE) throw toError('indisponivel')
  if (typeof author !== 'string' || !LISTING_AUTHOR_RE.test(author) || !Number.isSafeInteger(seq) || seq < 1) {
    throw toError('pedido-invalido')
  }
  const data = await call('POST', '/account/feira/start', { author, seq }, { uncertain: true, definite: true, messages: FEIRA_MESSAGES })
  if (!exactKeys(data, ['code']) || typeof data.code !== 'string' || !INVITE_CODE_RE.test(data.code)) {
    const err = toError('indisponivel')
    err.uncertain = true
    throw err
  }
  return { code: data.code }
}
export const invitesStart = async ({ member }) => {
  const data = await call('POST', '/account/invites/start', { member })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
export const invitesSummary = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/invites/summary', { member, nonce, signature }, { allow404: 'route' })
  if (data === null) return null
  if (!exactKeys(data, ['mode', 'perWeek', 'opened', 'used', 'remaining', 'resetsAt'])) throw toError('indisponivel')
  const { mode, perWeek, opened, used, remaining, resetsAt } = data
  if ((mode !== 'semanal' && mode !== 'sorteio') || !isPerWeek(perWeek) ||
    !isCount(opened) || opened > perWeek || !isCount(used) ||
    remaining !== Math.max(0, opened - used) || (mode === 'semanal' && opened !== perWeek) ||
    !isIso(resetsAt) || new Date(resetsAt).toISOString() !== resetsAt) {
    throw toError('indisponivel')
  }
  return { mode, perWeek, opened, used, remaining, resetsAt }
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
// The Vitrine has no account service to ask, and the read fails closed.
export const agePolicy = async () => {
  if (VITRINE) return { required: false }
  try {
    const data = await call('GET', '/account/age/policy')
    return exactKeys(data, ['required']) && typeof data.required === 'boolean' ? { required: data.required } : null
  } catch {
    return null
  }
}
// An issuer-signed age attestation is opaque here: a plain object within the
// node's byte cap. The node verifies it (age.proof); the app only bounds and
// forwards it, so a bad one is dropped, never an error.
export const MAX_AGE_PROOF_BYTES = 1024
function isAgeProof (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_AGE_PROOF_BYTES
  } catch {
    return false
  }
}
const verifiedAnswer = (data) => isAgeProof(data.proof) ? { state: 'verificado', proof: data.proof } : { state: 'verificado' }
// The installation's signed age-since attestation: a member certificate dated
// on or after its `since` proves the account passed (the service issues none
// without a recorded band). The object, null when the service has none, or
// undefined on any failure, so a broken read never changes what the node holds.
export const ageSince = async () => {
  // The Vitrine never settles: App.js sends any answer to age.proof and
  // retries a failed one forever, while a pending read does neither and asks
  // nothing (the age step is already clear through agePolicy).
  if (VITRINE) return new Promise(() => {})
  try {
    const data = await call('GET', '/account/age/since')
    if (!exactKeys(data, ['since'])) return undefined
    if (data.since === null) return null
    return isAgeProof(data.since) ? data.since : undefined
  } catch {
    return undefined
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
// `feira`: the invite is the Feira code, whose paid session opens only at
// /account/feira/idade (same body and answers); the edge limits that route
// per address and answers its 429 without a token, read as 'limite-idade'.
export const ageSession = async ({ member, nonce, signature, invite }, { feira = false } = {}) => {
  const body = { member, nonce, signature }
  if (typeof invite === 'string' && INVITE_CODE_RE.test(invite)) body.invite = invite
  const path = feira === true ? '/account/feira/idade' : '/account/age/session'
  const data = await call('POST', path, body, { uncertain: true, definite: true, bareStatus: feira === true ? { 429: 'limite-idade' } : undefined })
  if (isVerificationUrl(data.url)) return { url: data.url }
  if (data.state === 'verificado') return verifiedAnswer(data)
  const err = toError('indisponivel')
  err.uncertain = true
  throw err
}
// The service may record the band and close the provider session before it
// answers, so an unknown outcome is uncertain too; its own error tokens come
// only before the band is recorded.
export const ageResult = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/age/result', { member, nonce, signature }, { uncertain: true, definite: true })
  if (data.state === 'verificado') return verifiedAnswer(data)
  if (typeof data.state === 'string' && AGE_STATES.includes(data.state)) return { state: data.state }
  const err = toError('indisponivel')
  err.uncertain = true
  throw err
}

// Hosted phone check (src/phone.js, apps/cli/lib/account/phone-routes.js).
// Unlike agePolicy, null here is "unknown", not "required": phoneGate then
// decides from the proofs the node holds.
export const phonePolicy = async () => {
  if (VITRINE) return { required: false }
  try {
    const data = await call('GET', '/account/phone/policy')
    return exactKeys(data, ['required']) && typeof data.required === 'boolean' ? { required: data.required } : null
  } catch {
    return null
  }
}
// Phone attestations are opaque here too, within the node's cap
// (packages/core/lib/phone-proof.js MAX_PHONE_PROOF_BYTES).
export const MAX_PHONE_PROOF_BYTES = 1024
function isPhoneProof (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_PHONE_PROOF_BYTES
  } catch {
    return false
  }
}
// Only the state and the proof: nothing else the service sends (a number,
// say) reaches the caller.
const phoneVerified = (data) => isPhoneProof(data.proof) ? { state: 'verificado', proof: data.proof } : { state: 'verificado' }
function phoneUnknown () {
  const err = toError('indisponivel')
  err.uncertain = true
  return err
}
// The nonce-proved phone routes. Their 'expirado' is a spent phone nonce, not
// the Google link ERROR_MESSAGES speaks of, so this table wins over it here
// (toError lets ERROR_MESSAGES win for every other caller).
const PHONE_MESSAGES = {
  expirado: 'O pedido venceu. Tente de novo.',
  'conta-excluida': 'esta conta já foi excluída'
}
async function phoneCall (path, body, opts) {
  try {
    return await call('POST', path, body, { ...opts, messages: PHONE_MESSAGES })
  } catch (err) {
    if (Object.hasOwn(PHONE_MESSAGES, err.code)) err.message = PHONE_MESSAGES[err.code]
    throw err
  }
}
// The object, null when the service has none, or undefined on any failure,
// so a broken read never changes what the node holds.
export const phoneSince = async () => {
  // Pending in the Vitrine for the reason ageSince gives.
  if (VITRINE) return new Promise(() => {})
  try {
    const data = await call('GET', '/account/phone/since')
    if (!exactKeys(data, ['since'])) return undefined
    if (data.since === null) return null
    return isPhoneProof(data.since) ? data.since : undefined
  } catch {
    return undefined
  }
}
export const phoneStart = async ({ member }) => {
  const data = await call('POST', '/account/phone/start', { member })
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
// Asks the provider to text a code (a paid send), so an unknown outcome is
// uncertain and nothing here sends again. SMS only: no channel goes out.
export const phoneSend = async ({ member, nonce, signature, phone }) => {
  const data = await phoneCall('/account/phone/send', { member, nonce, signature, phone }, { uncertain: true, definite: true })
  if (data.state === 'enviado') return { state: 'enviado' }
  if (data.state === 'verificado') return phoneVerified(data)
  throw phoneUnknown()
}
// May record the number before it answers, so an unknown outcome is
// uncertain too.
export const phoneCheck = async ({ member, nonce, signature, code }) => {
  const data = await phoneCall('/account/phone/check', { member, nonce, signature, code }, { uncertain: true, definite: true })
  if (data.state === 'verificado') return phoneVerified(data)
  throw phoneUnknown()
}
// Only reads, so a bad answer changed nothing: never uncertain.
export const phoneStatus = async ({ member, nonce, signature }) => {
  const data = await phoneCall('/account/phone/status', { member, nonce, signature })
  if (data.state === 'verificado') return phoneVerified(data)
  if (data.state === 'nenhum') return { state: 'nenhum' }
  throw toError('indisponivel')
}

// GIF search and link previews through the account service. Every cache of
// theirs is keyed by the account origin the request really goes to (what
// call() resolves: the node's https origin, else the installation's, else ''
// for the page's own origin), so switching installations asks the new one.
function serviceOriginKey (origin) {
  const base = accountOriginOf(origin)
  if (base !== undefined) return base
  return resolveUrl('/').slice(0, -1)
}

// A feature's policy (GET /account/<prefix>/policy): a definite answer (200
// with { enabled }) is kept for the session. Any failure answers false, so
// the feature stays hidden rather than offering something that cannot work,
// and is asked again on a later call once retryMs have passed.
function servicePolicy (prefix, retryMs) {
  const policies = new Map()
  return ({ origin, now = Date.now } = {}) => {
    if (VITRINE) return Promise.resolve(false)
    const key = serviceOriginKey(origin)
    const cached = policies.get(key)
    if (cached && cached.retryAt > now()) return cached.answer
    const entry = { retryAt: Infinity }
    entry.answer = (async () => {
      try {
        const data = await call('GET', '/account/' + prefix + '/policy', undefined, { origin })
        if (exactKeys(data, ['enabled']) && typeof data.enabled === 'boolean') return data.enabled
      } catch {}
      entry.retryAt = now() + retryMs
      return false
    })()
    policies.set(key, entry)
    return entry.answer
  }
}

export const GIF_POLICY_RETRY_MS = 30 * 1000
export const gifPolicy = servicePolicy('gif', GIF_POLICY_RETRY_MS)

// A member session (the service's member-session.js under `prefix`): one
// token per member and origin, kept in memory until its expiresAt. A missing
// token, or a 401 on a read, runs start, the node's read-only invite.sign
// 'summary' statement over the nonce, and finish. Only reads repeat after a
// fresh session; the session calls themselves never do. Each prefix has its
// own tokens and cache: a GIF token never rides on a preview read.
const SESSION_SLACK_MS = 60 * 1000
const HEX64_RE = /^[0-9a-f]{64}$/
const unauthorized = (err) => Boolean(err) && err.code === 'nao-autorizado'

function memberSessions (prefix, { onUnauthorized = () => {}, onForget = () => {} } = {}) {
  const sessions = new Map()
  const opening = new Map()
  const keyOf = (member, origin) => serviceOriginKey(origin) + ' ' + member

  const start = async ({ member, origin }) => {
    const data = await call('POST', '/account/' + prefix + '/session/start', { member }, { origin })
    if (!exactKeys(data, ['nonce']) || !isToken(data.nonce)) throw toError('indisponivel')
    return { nonce: data.nonce }
  }
  const finish = async ({ member, nonce, signature, origin }) => {
    const data = await call('POST', '/account/' + prefix + '/session/finish', { member, nonce, signature }, { origin })
    if (!exactKeys(data, ['token', 'expiresAt']) || !isToken(data.token) || !isIso(data.expiresAt)) throw toError('indisponivel')
    return { token: data.token, expiresAt: data.expiresAt }
  }

  // The cached token, or a new session. `request` is the node's RPC request.
  async function session ({ member, origin, request, now = Date.now }) {
    if (typeof member !== 'string' || !HEX64_RE.test(member) || typeof request !== 'function') throw toError('pedido-invalido')
    const key = keyOf(member, origin)
    const cached = sessions.get(key)
    if (cached && cached.expiresAt - SESSION_SLACK_MS > now()) return cached.token
    sessions.delete(key)
    // Callers asking at once share one session instead of opening one each.
    if (opening.has(key)) return opening.get(key)
    const pending = (async () => {
      const { nonce } = await start({ member, origin })
      let signature
      try {
        signature = (await request('invite.sign', { action: 'summary', nonce })).signature
      } catch {
        throw toError('assinatura-invalida')
      }
      if (typeof signature !== 'string') throw toError('assinatura-invalida')
      const { token, expiresAt } = await finish({ member, nonce, signature, origin })
      sessions.set(key, { token, expiresAt: new Date(expiresAt).getTime() })
      return token
    })().catch((err) => {
      if (unauthorized(err)) onUnauthorized(key)
      throw err
    })
    opening.set(key, pending)
    try {
      return await pending
    } finally {
      opening.delete(key)
    }
  }

  function forget ({ member, origin } = {}) {
    if (typeof member === 'string') {
      const key = keyOf(member, origin)
      sessions.delete(key)
      onForget(key)
    } else {
      sessions.clear()
      onForget(null)
    }
  }

  // A read with the session header; one fresh session and one more try on a
  // 401 (the server forgot the token: a restart, or it expired early).
  async function withSession (opts, read) {
    const token = await session(opts)
    try {
      return await read(token)
    } catch (err) {
      if (!unauthorized(err)) throw err
      forget(opts)
      return read(await session(opts))
    }
  }

  return { keyOf, start, finish, session, forget, withSession }
}

const GIF_SEARCH_BODY = 32768
const GIF_TINY_BYTES = 512 * 1024
// gifReady's linked answers, by the session key: { at }.
const GIF_READY_TTL_MS = 5 * 60 * 1000
const gifLinked = new Map()
const gif = memberSessions('gif', {
  // A member who is no longer linked or is blocked: gifReady asks again.
  onUnauthorized: (key) => gifLinked.delete(key),
  onForget: (key) => { if (key === null) gifLinked.clear(); else gifLinked.delete(key) }
})
const gifSessionKey = gif.keyOf
export const gifSessionStart = gif.start
export const gifSessionFinish = gif.finish
export const gifSession = gif.session
export const forgetGifSession = gif.forget
const withGifSession = gif.withSession

// opts: { member, origin, request } (the session) plus cursor.
export const gifSearch = async (q, { cursor, origin, member, request } = {}) => {
  const body = searchBody(q, cursor)
  if (body === null) throw toError('pedido-invalido')
  return withGifSession({ member, origin, request }, async (gifToken) => {
    const parsed = parseSearch(await call('POST', '/account/gif/search', body, { origin, sessionToken: gifToken, maxBody: GIF_SEARCH_BODY }))
    if (parsed === null) throw toError('indisponivel')
    return parsed
  })
}

// GIF bytes from the account origin (never a provider URL): exactly 200,
// image/gif, at most the size's cap, and the GIF signature. -> Uint8Array.
async function gifImageOnce ({ id, size, origin, gifToken, timeoutMs = TIMEOUT_MS }) {
  // The Vitrine never reaches the network, as call() (the only other fetch).
  if (VITRINE) throw toError('indisponivel')
  const path = imageUrl('', id, size)
  if (path === null) throw toError('pedido-invalido')
  const cap = size === 'tiny' ? GIF_TINY_BYTES : GIF_MAX_BYTES
  const { url: rel, init } = buildRequest('GET', path)
  init.headers.accept = 'image/gif'
  init.headers.authorization = 'Bearer ' + gifToken
  init.redirect = 'error'
  const base = accountOriginOf(origin)
  const url = base === undefined ? rel : base + path
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetch(url, { ...init, signal: ctl.signal })
    } catch {
      throw toError('indisponivel')
    }
    if (!res.ok) {
      let data = null
      try { data = await readJson(res) } catch {}
      throw toError(data && typeof data.error === 'string' ? data.error : '')
    }
    const type = res.headers && res.headers.get ? res.headers.get('content-type') : ''
    if (!/^image\/gif\b/i.test(type || '')) throw toError('indisponivel')
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) throw toError('indisponivel')
    let bytes
    try {
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch {
      throw toError('indisponivel')
    }
    if (bytes.byteLength < 6 || bytes.byteLength > cap) throw toError('indisponivel')
    const sig = String.fromCharCode(...bytes.subarray(0, 6))
    if (sig !== 'GIF87a' && sig !== 'GIF89a') throw toError('indisponivel')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

export const gifImage = (id, size, { origin, member, request } = {}) =>
  withGifSession({ member, origin, request }, (gifToken) => gifImageOnce({ id, size, origin, gifToken }))

// Whether this member may search: the policy is on and the member is linked.
// A linked answer is kept GIF_READY_TTL_MS, so opening the attach sheet does
// not ask the account status each time; forgetGifSession and a fresh session
// refused with nao-autorizado drop it. An unlinked answer is never kept, so
// linking shows GIF on the next open.
export const gifReady = async ({ member, origin, now = Date.now } = {}) => {
  if (typeof member !== 'string' || !HEX64_RE.test(member)) return false
  if (!(await gifPolicy({ origin, now }))) return false
  const key = gifSessionKey(member, origin)
  const cached = gifLinked.get(key)
  if (cached && now() - cached.at < GIF_READY_TTL_MS) return true
  gifLinked.delete(key)
  try {
    const status = await accountStatus(member, { origin })
    const linked = status !== null && typeof status === 'object' && status.linked === true
    if (linked) gifLinked.set(key, { at: now() })
    return linked
  } catch {
    return false
  }
}

// Link previews through the account service (POST /account/preview), for
// a client that cannot read other sites itself (the web page). Its own
// member session under 'preview', its own policy and cache. The answer is
// checked here: exact keys, an https URL whose host is its own, strings, and
// an image of an accepted type within PREVIEW_IMAGE_CAP or null.
// -> { url, host, title, desc, imageBytes, imageMime }; throws otherwise.
export const PREVIEW_POLICY_RETRY_MS = 30 * 1000
export const previewPolicy = servicePolicy('preview', PREVIEW_POLICY_RETRY_MS)
const preview = memberSessions('preview')
export const previewSession = preview.session
export const forgetPreviewSession = preview.forget
const PREVIEW_IMAGE_CAP = 256 * 1024
// base64 of the image cap plus the text fields, with room for the JSON.
const PREVIEW_BODY = Math.ceil(PREVIEW_IMAGE_CAP / 3) * 4 + 8192
// The service fetches the page and then its image, each under 5 s.
const PREVIEW_TIMEOUT_MS = 15000
const PREVIEW_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

// Canonical base64 to bytes, or null. No atob: the same code runs everywhere.
export function base64Bytes (text) {
  if (typeof text !== 'string' || text.length === 0 || !B64_RE.test(text)) return null
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const n = (B64.indexOf(text[i]) << 18) | (B64.indexOf(text[i + 1]) << 12) |
      ((text[i + 2] === '=' ? 0 : B64.indexOf(text[i + 2])) << 6) | (text[i + 3] === '=' ? 0 : B64.indexOf(text[i + 3]))
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

// A missing title or description is '' (an older service answered null);
// a page with no title at all makes no card.
const previewText = (v) => (v === null ? '' : v)

function previewAnswer (data) {
  if (!exactKeys(data, ['url', 'host', 'title', 'desc', 'image'])) return null
  const { url, host, image } = data
  const title = previewText(data.title)
  const desc = previewText(data.desc)
  if (typeof url !== 'string' || !url.startsWith('https://') || typeof host !== 'string' || typeof title !== 'string' || title === '' || typeof desc !== 'string') return null
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== host) return null
  let imageBytes = null
  let imageMime = null
  if (image !== null) {
    if (!exactKeys(image, ['mime', 'bytes']) || !PREVIEW_IMAGE_MIMES.includes(image.mime)) return null
    const bytes = base64Bytes(image.bytes)
    if (bytes === null || bytes.byteLength > PREVIEW_IMAGE_CAP) return null
    imageBytes = bytes
    imageMime = image.mime
  }
  return { url, host, title, desc, imageBytes, imageMime }
}

// opts: { member, origin, request } (the session) plus signal.
export const previewFetch = async (url, { origin, member, request, signal } = {}) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) throw toError('pedido-invalido')
  return preview.withSession({ member, origin, request }, async (sessionToken) => {
    const data = await call('POST', '/account/preview', { url }, { origin, sessionToken, signal, maxBody: PREVIEW_BODY, timeoutMs: PREVIEW_TIMEOUT_MS })
    const answer = previewAnswer(data)
    if (answer === null) throw toError('indisponivel')
    return answer
  })
}

// Recovery entries (docs/rpc.md 5.90, src/recovery.js). Every proof is the
// node's recovery.sign over the service's single-use nonce; the app never
// hashes or signs here.
const RECOVERY_KINDS = ['passkey', 'code']
const HEX48_RE = /^[0-9a-f]{48}$/
const CIPHERTEXT_RE = /^[0-9a-f]{164}$/
const isRecoveryKind = (v) => typeof v === 'string' && RECOVERY_KINDS.includes(v)
const isHex64 = (v) => typeof v === 'string' && HEX64_RE.test(v)
const isRecoveryBlob = (v) => exactKeys(v, ['v', 'kind', 'nonce', 'ciphertext']) && v.v === 1 &&
  isRecoveryKind(v.kind) && typeof v.nonce === 'string' && HEX48_RE.test(v.nonce) &&
  typeof v.ciphertext === 'string' && CIPHERTEXT_RE.test(v.ciphertext)
const recoveryOpts = (extra) => ({ messages: RECOVERY_MESSAGES, ...extra })

export const recoveryStart = async ({ member }) => {
  const data = await call('POST', '/account/recovery/start', { member }, recoveryOpts())
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
// put and remove may write before a 5xx reaches the app, so every 5xx stays
// an unknown outcome (no `definite`): the caller re-reads with the list. A
// readable 2xx means the service applied it; `changed` is informative only.
// put answers { createdAt, changed } and remove { changed }.
async function recoveryWrite (path, body) {
  const data = await call('POST', path, body, recoveryOpts({ uncertain: true }))
  const out = { ok: true, changed: data.changed === true }
  if (isIso(data.createdAt)) out.createdAt = data.createdAt
  return out
}
export const recoveryPut = ({ member, nonce, signature, kind, lookupId, blob }) =>
  recoveryWrite('/account/recovery/put', { member, nonce, signature, kind, lookupId, blob })
export const recoveryRemove = ({ member, nonce, signature, kind, lookupId }) =>
  recoveryWrite('/account/recovery/remove', { member, nonce, signature, kind, lookupId })
export const recoveryList = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/recovery/list', { member, nonce, signature }, recoveryOpts())
  if (!exactKeys(data, ['entries']) || !Array.isArray(data.entries)) throw toError('indisponivel')
  return data.entries.map((e) => {
    if (!exactKeys(e, ['lookupId', 'kind', 'createdAt']) || !isHex64(e.lookupId) ||
      !isRecoveryKind(e.kind) || !isIso(e.createdAt)) throw toError('indisponivel')
    return { lookupId: e.lookupId, kind: e.kind, createdAt: e.createdAt }
  })
}
// The lookup id rides in a POST body, never in a URL. null only for the
// service's JSON 404 { error: 'nao-encontrado', recovery: true }; any other
// failure throws,
// so "not registered" is never confused with "could not ask" (a null lets
// the app install a ceremony's PRF directly).
export const recoveryFetch = async (lookupId, { origin } = {}) => {
  const data = await call('POST', '/account/recovery/fetch', { lookupId }, recoveryOpts({ allow404: 'nao-encontrado', origin }))
  if (data === null) return null
  if (!exactKeys(data, ['member', 'kind', 'blob']) || !isHex64(data.member) || !isRecoveryKind(data.kind) ||
    !isRecoveryBlob(data.blob) || data.blob.kind !== data.kind) throw toError('indisponivel')
  return { member: data.member, kind: data.kind, blob: { v: 1, kind: data.blob.kind, nonce: data.blob.nonce, ciphertext: data.blob.ciphertext } }
}

// Excluir conta: start names the current @nome the person must type, the
// credential ids of the passkeys whose keys the service holds and the date
// of a deletion already waiting (or null); finish is the signed request,
// with the passkey's assertion over the nonce (the deletion runs now) or
// wait: true (it runs in 7 days unless cancelled). The route answers
// 'indisponivel' only before it changed anything (`definite`); after its
// first write it answers 'resultado-incerto', and any other 5xx is unknown
// too: the caller then re-reads accountStatus instead of repeating it.
// -> { deleted: 'pendente' | 'concluida' } or { scheduled: ISO date }
const DELETE_STATES = ['pendente', 'concluida']
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{1,1364}$/
export const deleteStart = async ({ member }) => {
  const data = await call('POST', '/account/delete/start', { member }, { messages: DELETE_MESSAGES })
  if (!exactKeys(data, ['nonce', 'username', 'passkeys', 'scheduled']) || typeof data.nonce !== 'string' || !isUsername(data.username) ||
    !Array.isArray(data.passkeys) || data.passkeys.length > 8 || !data.passkeys.every((id) => typeof id === 'string' && CREDENTIAL_RE.test(id)) ||
    (data.scheduled !== null && !isIso(data.scheduled))) throw toError('indisponivel')
  return { nonce: data.nonce, username: data.username, passkeys: data.passkeys.slice(), scheduled: data.scheduled }
}
export const deleteFinish = async ({ member, nonce, signature, assertion, wait }) => {
  const body = { member, nonce, signature }
  if (assertion !== undefined && assertion !== null) body.assertion = assertion
  if (wait === true) body.wait = true
  const data = await call('POST', '/account/delete/finish', body, { messages: DELETE_MESSAGES, uncertain: true, definite: true })
  if (exactKeys(data, ['scheduled']) && isIso(data.scheduled)) return { scheduled: data.scheduled }
  if (!exactKeys(data, ['deleted']) || !DELETE_STATES.includes(data.deleted)) {
    const err = toError('indisponivel')
    err.uncertain = true
    throw err
  }
  return { deleted: data.deleted }
}
// Cancelling a deletion that waits for its date, with the diary-key proof
// at account-link phase 'cancel'. -> { cancelled }
export const deleteCancelStart = async ({ member }) => {
  const data = await call('POST', '/account/delete/cancel/start', { member }, { messages: DELETE_MESSAGES })
  if (!exactKeys(data, ['nonce', 'username', 'scheduled']) || typeof data.nonce !== 'string' || !isUsername(data.username) || (data.scheduled !== null && !isIso(data.scheduled))) throw toError('indisponivel')
  return { nonce: data.nonce, username: data.username, scheduled: data.scheduled }
}
export const deleteCancelFinish = async ({ member, nonce, signature }) => {
  const data = await call('POST', '/account/delete/cancel/finish', { member, nonce, signature }, { messages: DELETE_MESSAGES })
  if (!exactKeys(data, ['cancelled']) || typeof data.cancelled !== 'boolean') throw toError('indisponivel')
  return { cancelled: data.cancelled }
}
// The passkey enrolment right after the link (src/passkeyEnrol.js): the
// creation's attestation object, signed at account-link phase 'passkey'.
export const passkeyStart = async ({ member }) => {
  const data = await call('POST', '/account/passkey/start', { member }, { messages: PASSKEY_MESSAGES })
  if (!exactKeys(data, ['nonce']) || typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}
export const passkeyAdd = async ({ member, nonce, signature, credentialId, attestationObject }) => {
  const data = await call('POST', '/account/passkey/add', { member, nonce, signature, credentialId, attestationObject }, { messages: PASSKEY_MESSAGES })
  if (!exactKeys(data, ['added']) || typeof data.added !== 'boolean') throw toError('indisponivel')
  return { added: data.added }
}
