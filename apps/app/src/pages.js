// Client of the page routes of the account service (apps/cli/lib/account/
// pages-routes.js, docs/protocol.md section 12): start -> page.sign on the
// node -> POST. Nothing here holds a key; the node signs, the service checks.
//
// A failure before a signature exists is a plain error. After it, an unknown
// outcome (no answer, a 5xx without a known token, a 202, a success without a
// readable body) throws an error with `uncertain: true` and `retry`, which
// resends the same signed bytes, nonce and body. Nothing here ever re-signs
// or repeats a request on its own.
//
// A retry's answer proves a refusal only when the same bytes could never have
// been accepted (DEFINITE); anything else, 'em-andamento' (the first use is
// still in flight) and 'expirado' included, stays uncertain with retry.
//
// The signed reads (READS) are never resent with the same nonce: the service
// keeps no read result, so a resend could only answer 'expirado'. A failed
// read is a plain error whose retry runs a fresh start and page.sign.

import rpc from '@varanda/rpc'
import { buildRequest, readJson, formatNextChange } from './account.js'
import { accountOriginOf, pagesCore } from './pageGate.js'

const { MAX_AVATAR_BYTES } = rpc

// Same values as limits.js (MEDIA_BLOCK_BYTES, MAX_MEDIA_ITEM_BLOCKS,
// MAX_MEDIA_PER_POST); duplicated because the app imports no limits module.
export const MAX_MEDIA_BYTES = 256 * 32768
export const MAX_MEDIA_PER_POST = 4
export { MAX_AVATAR_BYTES }

const KEY_RE = /^[0-9a-f]{64}$/
const TIMEOUT_MS = 8000
const UPLOAD_TIMEOUT_MS = 30000
const MAX_BODY = 65536
// The signed reads: 'follows' answers up to 4095 keys, 'status' up to 4096
// liked and 4096 reposted refs, 'list' every invite and offer.
const READ_MAX_BODY = 1024 * 1024
const READS = ['list', 'status', 'follows', 'notices', 'terms', 'group-read', 'dm-list', 'dm-thread']
const DEFINITE = ['assinatura-invalida', 'pedido-invalido']
const FEED_KEYS = 64

export const TEXTS = Object.freeze({
  'nao-vinculado': 'Esta conta não tem vínculo com uma conta Google',
  'sem-permissao': 'Só o dono pode fazer isso',
  limite: 'Limite atingido',
  'nome-em-uso': 'Esse @nome já está em uso',
  'nome-invalido': 'Esse @nome não vale',
  expirado: 'Convite ou oferta expirada',
  'assinatura-invalida': 'Não foi possível provar a chave',
  'pedido-invalido': 'Pedido inválido',
  pausada: 'Página pausada; fale com a associação',
  encerrada: 'Esta página foi encerrada',
  movida: 'Esta página mudou para uma nova chave',
  'midia-invalida': 'Foto não aceita',
  indisponivel: 'Serviço indisponível',
  'termos-pendentes': 'Aceite os Termos para continuar',
  'troca-bloqueada': 'Você ainda não pode trocar o @nome',
  'nao-encontrado': 'Não encontrado',
  'em-andamento': 'Pedido ainda em andamento'
})

export function pageError (code, nextChangeAt) {
  const token = Object.hasOwn(TEXTS, code) ? code : 'indisponivel'
  let message = TEXTS[token]
  if (token === 'troca-bloqueada') {
    const when = formatNextChange(nextChangeAt)
    if (when) message = 'Você poderá trocar de novo em ' + when
  }
  const err = new Error(message)
  err.code = token
  if (token === 'troca-bloqueada' && typeof nextChangeAt === 'string') err.nextChangeAt = nextChangeAt
  return err
}

const isKey = (v) => typeof v === 'string' && KEY_RE.test(v)
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// A header value is latin-1 on the wire: JSON with every non-ASCII character
// escaped parses to the same op, and the service canonicalizes it anyway.
const headerJson = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

function request (spec, again = false) {
  return run(spec).catch((err) => {
    if (again && spec.signed && err && err.uncertain !== true && !DEFINITE.includes(err.code)) {
      err = pageError(err.code === 'em-andamento' ? 'em-andamento' : 'indisponivel')
      err.uncertain = true
    }
    if (err && err.uncertain === true) err.retry = () => request(spec, true)
    throw err
  })
}

async function run ({ method, path, body, raw, headers, origin, maxBody = MAX_BODY, timeoutMs = TIMEOUT_MS, signed = false, allow404 = false }) {
  const built = buildRequest(method, path, raw === undefined ? body : undefined)
  const { init } = built
  // A core node's account service lives at its own https origin; the hosted
  // web app keeps the relative path.
  const base = accountOriginOf(origin)
  const url = base === undefined ? built.url : base + path
  if (raw !== undefined) {
    init.body = raw
    init.headers['content-type'] = 'application/octet-stream'
  }
  // buildRequest applies its extra headers on the app only; these are
  // arguments of the statement and ride on every client.
  if (headers) Object.assign(init.headers, headers)
  const unknown = () => {
    const err = pageError('indisponivel')
    if (signed) err.uncertain = true
    return err
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  let data
  try {
    res = await fetch(url, { ...init, signal: ctl.signal })
    data = await readJson(res, maxBody)
  } catch {
    throw unknown()
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 202 || (res.ok && isObject(data) && data.uncertain === true)) throw unknown()
  if (res.ok) {
    if (!isObject(data)) throw unknown()
    return data
  }
  if (allow404 && res.status === 404) return null
  const code = isObject(data) && typeof data.error === 'string' ? data.error : ''
  if (code === 'em-andamento') {
    const err = pageError(code)
    if (signed) err.uncertain = true
    throw err
  }
  if (Object.hasOwn(TEXTS, code)) throw pageError(code, isObject(data) ? data.nextChangeAt : undefined)
  if (res.status >= 500) throw unknown()
  throw pageError('indisponivel')
}

const path = (action) => '/account/pages/' + action

// The account origin a node's page requests go to: its https account origin
// on a core node (pageGate.js pagesCore), else undefined (the relative path).
export function pagesOrigin (node) {
  if (!node || typeof node !== 'object') return undefined
  return pagesCore({ hosted: node.hosted, accountOrigin: node.accountOrigin }) ? accountOriginOf(node.accountOrigin) : undefined
}

export async function pagesPolicy ({ origin } = {}) {
  try {
    const data = await request({ method: 'GET', path: path('policy'), allow404: true, origin })
    if (data === null || data.available !== true) return { available: false }
    const out = { available: true }
    if (Number.isInteger(data.maxOwned)) out.maxOwned = data.maxOwned
    if (Number.isInteger(data.maxAdmins)) out.maxAdmins = data.maxAdmins
    return out
  } catch {
    return { available: false }
  }
}

// Reads the page's successor (a moved page's new key). No session, no proof.
export async function pagesSuccessor (key, { origin } = {}) {
  if (!isKey(key)) throw pageError('pedido-invalido')
  return request({ method: 'GET', path: path('successor/' + key), allow404: true, origin })
}

export async function pagesStart ({ member, action, page, origin }) {
  const body = { member, action }
  if (isKey(page)) body.page = page
  const data = await request({ method: 'POST', path: path('start'), body, origin })
  if (typeof data.nonce !== 'string') throw pageError('indisponivel')
  const out = { nonce: data.nonce }
  if (isKey(data.page)) out.page = data.page
  if (isKey(data.to)) out.to = data.to
  return out
}

// A statement action (the op travels as sent, the signature covers its hash).
// `page` is left out for the pageless ones (list, terms). A read's failure is
// plain: it has no same-nonce retry (see READS).
export function pagesAct ({ action, member, nonce, page, op, signature, termsSignature, origin }) {
  const body = { member, nonce }
  if (isKey(page)) body.page = page
  body.op = op
  body.signature = signature
  if (termsSignature !== undefined) body.termsSignature = termsSignature
  return request({
    method: 'POST',
    path: path(action),
    body,
    signed: !READS.includes(action),
    origin,
    maxBody: READS.includes(action) ? READ_MAX_BODY : MAX_BODY
  })
}

// A record action: the member-signed record(s) are the proof. create and
// invite also carry their statement (op, signature); move carries the three
// records it signed and no statement.
// `origin` here is move's page-origin record; `accountOrigin` where to send.
export function pagesRecord ({ action, member, nonce, page, record, op, signature, origin, roster, accountOrigin }) {
  const body = { member, nonce, page, record }
  if (op !== undefined) body.op = op
  if (signature !== undefined) body.signature = signature
  if (origin !== undefined) body.origin = origin
  if (roster !== undefined) body.roster = roster
  return request({ method: 'POST', path: path(action), body, signed: true, origin: accountOrigin })
}

function upload (action, { member, nonce, page, op, signature, bytes, origin }, max) {
  const size = bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : -1
  if (size < 1 || size > max) return Promise.reject(pageError('midia-invalida'))
  return request({
    method: 'POST',
    path: path(action),
    raw: bytes,
    headers: {
      'x-varanda-page-member': member,
      'x-varanda-page-nonce': nonce,
      'x-varanda-page-page': page,
      'x-varanda-page-signature': signature,
      'x-varanda-page-op': headerJson(op)
    },
    timeoutMs: UPLOAD_TIMEOUT_MS,
    signed: true,
    origin
  })
}

export const pagesMedia = (args) => upload('media', args, MAX_MEDIA_BYTES)
export const pagesAvatar = (args) => upload('avatar', args, MAX_AVATAR_BYTES)

// ---- the whole step: start, page.sign, POST ---------------------------------

const PAGELESS = ['create', 'list', 'terms']
const RECORD_ACTIONS = ['accept', 'remove', 'offer', 'transfer-accept', 'close']
const GROUP_ACTIONS = ['community-join', 'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read']
const DM_ACTIONS = ['dm-list', 'dm-thread', 'dm-send', 'dm-set', 'dm-seen']
const STATEMENT_ACTIONS = ['list', 'status', 'post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile', 'rename',
  'follow', 'follows', 'notices', 'terms', ...GROUP_ACTIONS, ...DM_ACTIONS]
const ACTIONS = [...STATEMENT_ACTIONS, ...RECORD_ACTIONS, 'create', 'invite', 'move']

const signer = (node) => {
  if (node && typeof node.request === 'function') return node.request.bind(node)
  if (node && typeof node.call === 'function') return node.call.bind(node)
  return null
}

function checkMedia (action, op) {
  if (!['post', 'reply', 'quote'].includes(action) || !isObject(op) || op.media === undefined) return true
  return Array.isArray(op.media) && op.media.length >= 1 && op.media.length <= MAX_MEDIA_PER_POST
}

// `op` may be a function of { nonce, to }: records carry the nonce the service
// minted for the action, which is known only after start.
async function step (node, { member, action, page = '', op = {} }) {
  const sign = signer(node)
  if (sign === null || !isKey(member) || !ACTIONS.includes(action)) throw pageError('pedido-invalido')
  if (page === '' ? !PAGELESS.includes(action) : !isKey(page)) throw pageError('pedido-invalido')
  if (typeof op !== 'function' && (!isObject(op) || !checkMedia(action, op))) throw pageError('pedido-invalido')
  const accountOrigin = pagesOrigin(node)
  const started = await pagesStart({ member, action, page, origin: accountOrigin })
  const { nonce } = started
  const to = action === 'move' ? (started.to || started.page) : undefined
  if (action === 'create' && !started.page) throw pageError('indisponivel')
  if (action === 'move' && !isKey(to)) throw pageError('indisponivel')
  const target = action === 'create' ? started.page : page
  const theOp = typeof op === 'function' ? op({ nonce, to }) : op
  if (!isObject(theOp) || !checkMedia(action, theOp)) throw pageError('pedido-invalido')
  const signed = await sign('page.sign', { action, nonce, page: target, op: theOp })
  // From here a signature exists: an unknown outcome is 'uncertain'.
  let data
  if (action === 'create') {
    data = await pagesRecord({ action, member, nonce, page: target, record: signed.record, op: theOp, signature: signed.signature, accountOrigin })
  } else if (action === 'invite') {
    data = await pagesRecord({
      action,
      member,
      nonce,
      page,
      record: signed.record,
      op: { ...theOp, rosterSignature: signed.record.signature },
      signature: signed.signature,
      accountOrigin
    })
  } else if (action === 'move') {
    data = await pagesRecord({ action, member, nonce, page, record: signed.record, origin: signed.origin, roster: signed.roster, accountOrigin })
  } else if (RECORD_ACTIONS.includes(action)) {
    data = await pagesRecord({ action, member, nonce, page, record: signed.record, accountOrigin })
  } else {
    const body = { action, member, nonce, page, op: theOp, signature: signed.signature, origin: accountOrigin }
    // The delegate's Terms acceptance carries the node's own terms signature.
    if (action === 'terms' && typeof signed.termsSignature === 'string') body.termsSignature = signed.termsSignature
    data = await pagesAct(body)
  }
  return { data, to }
}

export async function actAs (node, args) {
  if (!READS.includes(args && args.action)) return (await step(node, args)).data
  try {
    return (await step(node, args)).data
  } catch (err) {
    if (!err || (err.code !== 'indisponivel' && err.code !== 'expirado')) throw err
    // A read nonce that lapsed is no refusal: a fresh read may answer.
    const plain = err.code === 'expirado' ? pageError('indisponivel') : err
    plain.retry = () => actAs(node, args)
    throw plain
  }
}

export function pagesFollow (node, { member, page, key, on }) {
  return actAs(node, { member, action: 'follow', page, op: { key, on: on === true } })
}

export async function pagesFollows (node, { member, page }) {
  const data = await actAs(node, { member, action: 'follows', page })
  return Array.isArray(data.follows) ? data.follows : []
}

export function pagesNotices (node, { member, page, after, limit } = {}) {
  const op = {}
  if (after !== undefined && after !== null) op.after = after
  if (limit !== undefined && limit !== null) op.limit = limit
  return actAs(node, { member, action: 'notices', page, op })
}

// Close and move are limited per day; the generic 'Limite atingido' would not
// say when to try again.
export const LIFECYCLE_LIMIT = 'Limite de mudanças atingido, tente amanhã'
const lifecycleLimit = (err) => {
  if (err && err.code === 'limite' && err.uncertain !== true) err.message = LIFECYCLE_LIMIT
  throw err
}

export function pagesClose (node, { member, page, gen, at = new Date().toISOString() }) {
  return actAs(node, { member, action: 'close', page, op: ({ nonce }) => ({ gen, at, nonce }) }).catch(lifecycleLimit)
}

// Resolves to the new page key.
export async function pagesMove (node, { member, page, op }) {
  const { to } = await step(node, { member, action: 'move', page, op }).catch(lifecycleLimit)
  return to
}

export function pagesTerms (node, { member, op = {} }) {
  return actAs(node, { member, action: 'terms', page: '', op })
}

export function pagesGroup (node, { member, page, action, op = {} }) {
  if (!GROUP_ACTIONS.includes(action)) return Promise.reject(pageError('pedido-invalido'))
  return actAs(node, { member, action, page, op })
}

// Conversas as the page (docs/rpc.md 5.75 to 5.80 shapes). The op is the
// params of the matching dm.* method; a write throws { uncertain, retry }.
export function pagesDm (node, { member, page, action, op = {} }) {
  if (!DM_ACTIONS.includes(action)) return Promise.reject(pageError('pedido-invalido'))
  return actAs(node, { member, action, page, op })
}

export const pagesDmList = (node, { member, page, ...op }) => pagesDm(node, { member, page, action: 'dm-list', op })
export const pagesDmThread = (node, { member, page, ...op }) => pagesDm(node, { member, page, action: 'dm-thread', op })
export const pagesDmSend = (node, { member, page, ...op }) => pagesDm(node, { member, page, action: 'dm-send', op })
export const pagesDmSet = (node, { member, page, ...op }) => pagesDm(node, { member, page, action: 'dm-set', op })
export const pagesDmSeen = (node, { member, page, ...op }) => pagesDm(node, { member, page, action: 'dm-seen', op })

// The keys page.feed peeks at: the newest `max` follows by seq, as given
// (page.read already answers its newest 64). Lowercase hex64, no repeats.
export function pagesFeedKeys (follows, max = FEED_KEYS) {
  if (!Array.isArray(follows)) return []
  const rows = follows.filter((f) => isObject(f) && isKey(f.key) && Number.isFinite(f.seq))
  rows.sort((a, b) => b.seq - a.seq)
  const out = []
  for (const f of rows) {
    if (out.length >= Math.min(max, FEED_KEYS)) break
    if (!out.includes(f.key)) out.push(f.key)
  }
  return out
}
