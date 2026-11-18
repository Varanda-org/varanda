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
import { validDescriptor, validVideoDescriptor } from './media/fetch.js'
import { VIDEO_MIME } from './media/plan.js'
import { accountOriginOf, pagesCore } from './pageGate.js'
import * as actingStore from './actingAs.js'
import { actingPageStopped, actorBoxOf, isLegacyPage, legacyBundleOf, nextGen, pagesNoLongerRun, pagesRun, planShares, secretsParams } from './pageSecrets.js'
import { oldPageKeys } from './pageOldKeys.js'

const { MAX_AVATAR_BYTES } = rpc

// Same byte cap as limits.js (MEDIA_BLOCK_BYTES * MAX_MEDIA_ITEM_BLOCKS),
// duplicated because the app imports no limits module. The count is
// rpc.MAX_MEDIA_PER_POST. A listing uses rpc.feira.MAX_LISTING_MEDIA.
export const MAX_MEDIA_BYTES = 256 * 32768
export const MAX_MEDIA_PER_POST = rpc.MAX_MEDIA_PER_POST
export { MAX_AVATAR_BYTES }

const KEY_RE = /^[0-9a-f]{64}$/
const TIMEOUT_MS = 8000
const UPLOAD_TIMEOUT_MS = 30000
// A video is up to MAX_MEDIA_BYTES on a slow uplink.
const VIDEO_UPLOAD_TIMEOUT_MS = 120000
const MAX_BODY = 65536
// The signed reads: 'follows' answers up to 4095 keys, 'status' up to 4096
// liked and 4096 reposted refs, 'list' every invite and offer.
const READ_MAX_BODY = 1024 * 1024
// 'dm-sign', 'dm-box-read' and 'dm-legacy-read' are signed reads too: a lost
// signature sent nothing, and the service keeps no answer for a same-nonce
// resend.
const READS = ['list', 'status', 'follows', 'notices', 'terms', 'group-read', 'group-topics', 'group-voters', 'group-events', 'dm-sign', 'dm-box-read', 'dm-legacy-read']
// A retry answered by one of these is the service's answer, not a lost one:
// nothing to resend. A page's listing-rate refusals hold whatever the body.
const DEFINITE = ['assinatura-invalida', 'pedido-invalido', 'consentimento-invalido', 'avaliacao-enviada', 'avaliacao-propria']
const FEED_KEYS = 64

let dmDropObserver = () => {}

export function setDmDropObserver (fn) {
  dmDropObserver = fn
}

export const TEXTS = Object.freeze({
  'nao-vinculado': 'Termine o cadastro em Ajustes → Conta e @nome.',
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
  'midia-invalida': 'Foto ou vídeo não aceito',
  indisponivel: 'Serviço indisponível',
  'termos-pendentes': 'Aceite os Termos para continuar',
  'troca-bloqueada': 'Você ainda não pode trocar o @nome',
  'nao-encontrado': 'Não encontrado',
  'em-andamento': 'Pedido ainda em andamento',
  conflito: 'Outro aparelho gravou antes',
  'rotacao-necessaria': 'A chave da página está sendo trocada; tente de novo em instantes',
  sequencia: 'Alguém publicou antes; toque para enviar de novo',
  'aguardando-chave': 'aguardando nova chave',
  'fora-da-comunidade': 'A página ainda não está na comunidade deste grupo',
  privado: 'Este grupo é privado: a mensagem precisa ser cifrada neste aparelho',
  // A page's rating of a listing (listing-rate).
  'consentimento-invalido': 'Esta oferta não pode ser avaliada pela página.',
  'avaliacao-enviada': 'A página já avaliou esta oferta.',
  'avaliacao-propria': 'Uma página não avalia anúncios de quem cuida dela.',
  // The account service's word check (apps/cli/lib/account/word-check.js):
  // the app checks the same list first, so this shows only when the service
  // has a term this build does not.
  'termo-recusado': 'Não dá para publicar: o texto tem um termo que o Varanda não permite em conteúdo público. Edite o texto e tente de novo.'
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
const plainObject = (v) => {
  if (!isObject(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

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

async function run ({ method, path, body, raw, headers, origin, maxBody = MAX_BODY, timeoutMs = TIMEOUT_MS, signed = false, allow404 = false, drops = false }) {
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
    if (drops) {
      try { dmDropObserver() } catch {}
    }
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
// `dmBox` (remove and move of a page with device-held keys) rides in the
// body, outside the signed op.
export function pagesRecord ({ action, member, nonce, page, record, op, signature, origin, roster, dmBox, accountOrigin }) {
  const body = { member, nonce, page, record }
  if (op !== undefined) body.op = op
  if (signature !== undefined) body.signature = signature
  if (origin !== undefined) body.origin = origin
  if (roster !== undefined) body.roster = roster
  if (dmBox !== undefined && dmBox !== null) body.dmBox = dmBox
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
    timeoutMs: op && op.mime === VIDEO_MIME ? VIDEO_UPLOAD_TIMEOUT_MS : UPLOAD_TIMEOUT_MS,
    signed: true,
    origin
  })
}

// A video's duration `ms` travels inside the signed op; upload() sends the
// op whole. video/mp4 shares the still-image byte cap (MAX_VIDEO_BYTES equals
// MAX_MEDIA_BYTES).
export const pagesMedia = (args) => upload('media', args, MAX_MEDIA_BYTES)
export const pagesAvatar = (args) => upload('avatar', args, MAX_AVATAR_BYTES)

// ---- the whole step: start, page.sign, POST ---------------------------------

const PAGELESS = ['create', 'list', 'terms']
const RECORD_ACTIONS = ['accept', 'remove', 'offer', 'transfer-accept', 'close']
// A page's post in a private group is sealed on the device (node group.seal)
// and sent as 'group-seal'; the service cannot read it (docs/rpc.md 5.114).
const GROUP_ACTIONS = ['community-join', 'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read', 'group-seal', 'group-rebox', 'group-react', 'group-hide', 'group-choice', 'group-topics', 'group-voters', 'group-events']
// The page's own messages go through the node (5.114); dm-legacy-read and
// dm-legacy-done serve only the sealed bundle of a legacy page's old ones.
const DM_ACTIONS = ['dm-sign', 'dm-box', 'dm-box-share', 'dm-box-read', 'dm-legacy-read', 'dm-legacy-done']
const LISTING_ACTIONS = ['listing', 'listing-edit', 'listing-status', 'listing-consent', 'listing-rate']
const STATEMENT_ACTIONS = ['list', 'status', 'post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile', 'rename',
  'follow', 'follows', 'notices', 'terms', 'choice', 'moment', 'post-share', 'post-unshare', ...GROUP_ACTIONS, ...DM_ACTIONS, ...LISTING_ACTIONS]
const ACTIONS = [...STATEMENT_ACTIONS, ...RECORD_ACTIONS, 'create', 'invite', 'move']

const signer = (node) => {
  if (node && typeof node.request === 'function') return node.request.bind(node)
  if (node && typeof node.call === 'function') return node.call.bind(node)
  return null
}

const MEDIA_ACTIONS = ['post', 'reply', 'quote', 'listing', 'listing-edit']
const POST_ACTIONS = ['post', 'reply', 'quote']

// A diary video is exactly [JPEG poster, video], the same pair postRecord
// accepts. Anything else that carries a video is not that pair.
function isVideoPair (media) {
  if (!Array.isArray(media) || media.length !== 2) return false
  const poster = media[0]
  const video = media[1]
  return validDescriptor(poster) && poster.mime === 'image/jpeg' && validVideoDescriptor(video)
}

function hasVideo (media) {
  if (!Array.isArray(media)) return false
  for (let i = 0; i < media.length; i++) {
    const item = media[i]
    if (validVideoDescriptor(item)) return true
    if (item && typeof item === 'object' && item.mime === VIDEO_MIME) return true
  }
  return false
}

// preview, when present on a post, reply or quote: a plain object with a
// url string. The service checks the card; this is only the shape.
function checkPreview (action, op) {
  if (!POST_ACTIONS.includes(action) || op.preview === undefined) return true
  return plainObject(op.preview) && typeof op.preview.url === 'string'
}

function checkMedia (action, op) {
  if (!MEDIA_ACTIONS.includes(action) || !isObject(op)) return true
  if (!checkPreview(action, op)) return false
  // A preview never travels with media (records.js POST_PREVIEW_KEYS).
  if (op.preview !== undefined && op.media !== undefined && op.media !== null && !(Array.isArray(op.media) && op.media.length === 0)) return false
  if (op.media === undefined) return true
  // listing.edit takes media null to drop every photo (docs/rpc.md 5.107).
  if (action === 'listing-edit' && op.media === null) return true
  if (POST_ACTIONS.includes(action) && isVideoPair(op.media)) return true
  if (POST_ACTIONS.includes(action) && hasVideo(op.media)) return false
  // A listing is not a diary post: Feira stays at its own cap.
  const cap = action === 'listing' || action === 'listing-edit' ? rpc.feira.MAX_LISTING_MEDIA : MAX_MEDIA_PER_POST
  return Array.isArray(op.media) && op.media.length >= 1 && op.media.length <= cap
}

// `op` may be a function of { nonce, to }: records carry the nonce the service
// minted for the action, which is known only after start. So may `dmBox`
// (an async one: move seals for K2, known only after start).
async function step (node, { member, action, page = '', op = {}, dmBox }) {
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
  const box = typeof dmBox === 'function' ? await dmBox({ nonce, to }) : dmBox
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
    data = await pagesRecord({ action, member, nonce, page, record: signed.record, origin: signed.origin, roster: signed.roster, dmBox: box, accountOrigin })
  } else if (RECORD_ACTIONS.includes(action)) {
    data = await pagesRecord({ action, member, nonce, page, record: signed.record, dmBox: action === 'remove' ? box : undefined, accountOrigin })
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

// The page's vote on a poll or RSVP to an event ('choice', docs/rpc.md 5.84):
// `to` an 'author:seq' ref, `pick` an option index or null to withdraw (an
// absent pick is null). Anything else is sent as given for the service to
// refuse, never turned into a withdrawal.
export function pageChoiceOp (to, pick) {
  return { to, pick: pick === undefined ? null : pick }
}

export function pagesChoice (node, { member, page, to, pick }) {
  return actAs(node, { member, action: 'choice', page, op: pageChoiceOp(to, pick) })
}

// The page's momento ('moment', docs/rpc.md 5.84), the person's
// moment.create input: `media` the item the node's moment.putMedia answered
// (the device uploads the blob itself), `text` '' when absent, `music` sent
// only when given (null or absent is none).
export function pageMomentOp ({ text, media, music } = {}) {
  const op = { text: text === undefined || text === null ? '' : text, media }
  if (music !== undefined && music !== null) op.music = music
  return op
}

// The page's web share of one of its posts ('post-share' / 'post-unshare',
// docs/rpc.md 5.84): `seq` the page's own post. One request each, never
// resent.
export function pagesPostShare (node, { member, page, seq }) {
  return actAs(node, { member, action: 'post-share', page, op: { seq } })
}

export function pagesPostUnshare (node, { member, page, seq }) {
  return actAs(node, { member, action: 'post-unshare', page, op: { seq } })
}

export function pagesMoment (node, { member, page, text, media, music }) {
  return actAs(node, { member, action: 'moment', page, op: pageMomentOp({ text, media, music }) })
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
export async function pagesMove (node, { member, page, op, dmBox }) {
  const { to } = await step(node, { member, action: 'move', page, op, dmBox }).catch(lifecycleLimit)
  return to
}

export function pagesTerms (node, { member, op = {} }) {
  return actAs(node, { member, action: 'terms', page: '', op })
}

export function pagesGroup (node, { member, page, action, op = {} }) {
  if (!GROUP_ACTIONS.includes(action)) return Promise.reject(pageError('pedido-invalido'))
  return actAs(node, { member, action, page, op })
}

// The page statements of its Conversas (docs/rpc.md 5.84): the signed reads
// 'dm-box-read', 'dm-sign' and 'dm-legacy-read', and the writes 'dm-box',
// 'dm-box-share' and 'dm-legacy-done', which throw { uncertain, retry }.
export function pagesDm (node, { member, page, action, op = {} }) {
  if (!DM_ACTIONS.includes(action)) return Promise.reject(pageError('pedido-invalido'))
  return actAs(node, { member, action, page, op })
}

export const pagesDmBoxRead = (node, { member, page }) => pagesDm(node, { member, page, action: 'dm-box-read' })

// ---- the page's device-held keys (docs/rpc.md 5.114) -------------------------

export const PAGE_DM_NO_OWN_BOX = 'Suas Conversas ainda não estão ativas neste aparelho'
export const PAGE_DM_NO_BOX = 'Essa pessoa ainda não recebe mensagens'
export const PAGE_DM_CORE_ONLY = 'Para remover administradores ou mudar a chave desta página, use o app no celular ou na web.'
// A core node's dm.* refusal: it cannot hold a page's keys.
const NODE_DM_BROWSER_ONLY = 'mensagens diretas disponíveis só no navegador'
const coreOnly = () => Object.assign(new Error(PAGE_DM_CORE_ONLY), { coreOnly: true })
export const pagesDmCoreOnly = (node) => !!node && node.hosted === false
export const PAGE_DM_OWN_BOX_PENDING = 'A chave de mensagens deste aparelho ainda não foi publicada; tente de novo em instantes'
// 'dm-legacy-read' answers up to 8 chunks; a bundle has at most 1024.
const MAX_LEGACY_READS = 1024

const nodeCall = (node) => {
  const call = signer(node)
  if (call === null) throw pageError('pedido-invalido')
  return call
}

// The node's own dm box (dm.enable: derived on this device, appended to the
// own diary only when the newest dm-key differs). A failed or uncertain
// answer is a plain refusal here; the next tap asks again.
async function ownDmBox (node) {
  let mine
  try {
    mine = await nodeCall(node)('dm.enable', {})
  } catch (err) {
    if (err && err.message === NODE_DM_BROWSER_ONLY) throw coreOnly()
    throw new Error(PAGE_DM_NO_OWN_BOX)
  }
  if (!isObject(mine) || !isKey(mine.box)) throw new Error(PAGE_DM_NO_OWN_BOX)
  return mine.box
}

// The newest dm-key box of each member (dm.lookup), null when none or the
// read failed: such a member is left out of the shares.
export async function pagesDmBoxes (node, members) {
  const call = nodeCall(node)
  const out = {}
  for (const m of members) {
    if (!isKey(m) || Object.hasOwn(out, m)) continue
    try {
      const r = await call('dm.lookup', { member: m })
      out[m] = r && isKey(r.box) ? r.box : null
    } catch {
      out[m] = null
    }
  }
  return out
}

// The gen this device published for a page (a remove, a move's K2, an
// activation or rotation) and has not adopted yet. While one is listed no
// new gen is prepared for that page: a second rotation would replace the
// node's pending secrets and the intermediate gen would be lost here. Kept
// for the session; after a reload the inbox read adopts first.
const unadopted = new Map()

export function pagesDmExpectAdopt (page, gen) {
  if (isKey(page) && Number.isInteger(gen)) unadopted.set(page, Math.max(gen, unadopted.get(page) || 0))
}

// A definite refusal of the write that carried the gen: nothing to adopt.
export function pagesDmForgetAdopt (page, gen) {
  if (unadopted.get(page) === gen) unadopted.delete(page)
}

export const pagesDmAwaitsAdopt = (page) => unadopted.has(page)

const adoptedUpTo = (page, gen) => {
  if (Number.isInteger(gen) && unadopted.has(page) && unadopted.get(page) <= gen) unadopted.delete(page)
}

// Stores the caller's share from a 'dm-box-read' answer on this device.
export async function pagesDmAdopt (node, { page, status }) {
  const params = secretsParams({
    page,
    share: status && status.share,
    box: status && status.box,
    groupBox: status && status.groupBox,
    cert: status && status.cert
  })
  if (params === null) throw pageError('indisponivel')
  const out = await nodeCall(node)('dm.pageSecrets', params)
  adoptedUpTo(page, params.gen)
  return out
}

// The last step of a remove, a move or a rotation the service accepted: a
// fresh 'dm-box-read' and the own share of gen `gen` (or newer) into the
// node. While the rotation is still pending it throws the rotating text;
// the screen offers a manual retry, nothing repeats by itself.
export async function pagesDmAdoptNew (node, { member, page, gen }) {
  const status = await pagesDmBoxRead(node, { member, page })
  if (!isObject(status) || status.rotatePending === true || !isObject(status.share) || !Number.isInteger(status.share.gen) || status.share.gen < gen) throw pageError('rotacao-necessaria')
  await pagesDmAdopt(node, { page, status })
  return status
}

// New secrets for `roster` sealed for gen `gen` (default nextGen(status)):
// the dmBox of 'dm-box', a remove or a move, plus the members left out.
// Not mutating: nothing leaves the device until the caller sends it.
export async function pagesDmPrepare (node, args) {
  // Fail closed on a node without page keys: no rotation, so no remove or
  // move either, and a plain refusal with no retry.
  if (pagesDmCoreOnly(node)) throw coreOnly()
  try {
    return await prepare(node, args)
  } catch (err) {
    throw err && err.message === NODE_DM_BROWSER_ONLY ? coreOnly() : err
  }
}

// The boxes core delegates signed for themselves, for planShares: read fresh
// from `page` only when some roster member has no dm-key, because the given
// status may be the screen's older read (a delegate restated since) or a
// move's K2 placeholder, while the statements live on the old page. A failed
// read keeps the given status's statements.
async function statedBoxes (node, { member, page, owner, admins, boxes, status }) {
  if ([owner, ...admins].filter(isKey).every((m) => isKey(boxes[m]))) return status
  try {
    const fresh = await pagesDmBoxRead(node, { member, page })
    if (isObject(fresh)) return { actorBoxes: fresh.actorBoxes }
  } catch {}
  return status
}

async function prepare (node, { member, page, status, roster, gen, boxesFrom = page }) {
  const owner = roster && roster.owner
  const admins = roster && Array.isArray(roster.admins) ? roster.admins : []
  // A device that never opened the page's inbox holds no gen yet: the
  // current share goes in first, so after the rotation it is a held
  // previous box and the earlier messages stay readable here.
  if (isObject(status) && isObject(status.share) && status.share.gen === status.gen && status.rotatePending !== true) await pagesDmAdopt(node, { page, status })
  // A guard left by a publication that never reached the service (its
  // retry lost with the screen): the fresh read still shows the gen before
  // it and nothing pending, so it goes.
  if (unadopted.has(page) && isObject(status) && status.rotatePending !== true && status.gen === unadopted.get(page) - 1) unadopted.delete(page)
  if (unadopted.has(page)) throw pageError('rotacao-necessaria')
  const ownBox = await ownDmBox(node)
  const boxes = await pagesDmBoxes(node, [owner, ...admins, member])
  // The legacy bundle is sealed to ownBox: only a box this node derives will
  // open it, so a published dm-key that is not this node's is refused here.
  if (boxes[member] !== ownBox) throw new Error(PAGE_DM_OWN_BOX_PENDING)
  const stated = await statedBoxes(node, { member, page: boxesFrom, owner, admins, boxes, status })
  const { recipients, missing } = planShares({ owner, admins, boxes, status: stated })
  if (!recipients.some((r) => r.member === owner)) throw new Error(PAGE_DM_NO_OWN_BOX)
  const g = Number.isInteger(gen) ? gen : nextGen(status)
  const made = await nodeCall(node)('dm.pageGenerate', { page, gen: g, recipients })
  if (!isObject(made) || !isKey(made.box) || !isKey(made.groupBox) || !Array.isArray(made.shares)) throw pageError('indisponivel')
  const shares = made.shares.map((sh) => ({ member: sh.member, sealed: sh.sealed, sig: sh.sig }))
  return { gen: g, missing, dmBox: { expectedGen: g - 1, box: made.box, groupBox: made.groupBox, ownBox, shares } }
}

// Copies the sealed legacy bundle 'dm-box-read' names (5.84 'dm-legacy-read',
// 5.114 dm.pageLegacyChunk) into the node, 8 chunks per read, and tells the
// service 'dm-legacy-done' once the node has filed the whole bundle. A read
// or a chunk the node refuses is a plain error (the node keeps the chunks it
// has, a new tap starts over); an uncertain 'dm-legacy-done' keeps its retry.
export async function pagesDmLegacyImport (node, { member, page, bundle }) {
  const call = nodeCall(node)
  let from = 0
  let complete = false
  for (let reads = 0; !complete; reads++) {
    if (reads >= MAX_LEGACY_READS || from >= bundle.count) throw pageError('indisponivel')
    const got = await pagesDm(node, { member, page, action: 'dm-legacy-read', op: { from } })
    const chunks = isObject(got) && got.id === bundle.id && Array.isArray(got.chunks) ? got.chunks : []
    if (chunks.length === 0) throw pageError('indisponivel')
    for (const c of chunks) {
      if (!isObject(c) || !Number.isInteger(c.index) || c.index < from || c.index >= bundle.count || typeof c.sealed !== 'string') throw pageError('indisponivel')
      const r = await call('dm.pageLegacyChunk', { page, id: bundle.id, index: c.index, count: bundle.count, sealed: c.sealed })
      from = c.index + 1
      if (isObject(r) && r.complete === true) {
        complete = true
        break
      }
    }
  }
  await pagesDm(node, { member, page, action: 'dm-legacy-done', op: { id: bundle.id } })
  return { complete }
}

// Re-applies the old sender blocks the node still lists (dm.pageLegacyBlocks)
// as page ctl ops (dm.pageDraft kind 'ctl', 'dm-sign', dm.pageSend), one peer
// after another, so every admin device gets them; the node drops a peer from
// its list once the send succeeded. Only from an owner's tap. The first
// failure stops with `peer`, step 'blocks' and a `retry` that goes on from
// there, resending the exact uncertain dm.pageSend when the outcome is unknown.
export async function pagesDmReapplyBlocks (node, { member, page }) {
  const call = nodeCall(node)
  const rest = () => pagesDmReapplyBlocks(node, { member, page })
  let listed
  try {
    listed = await call('dm.pageLegacyBlocks', { page })
  } catch (err) {
    const out = err || pageError('indisponivel')
    out.step = 'blocks'
    out.retry = rest
    throw out
  }
  const todo = []
  for (const peer of isObject(listed) && Array.isArray(listed.pending) ? listed.pending : []) {
    if (isKey(peer) && !todo.includes(peer)) todo.push(peer)
  }
  for (const peer of todo) {
    let params = null
    const put = () => call('dm.pageSend', params)
    const fail = (err) => {
      const out = err || pageError('indisponivel')
      out.peer = peer
      out.step = 'blocks'
      if (params !== null && (out.uncertain === true || out.message === 'não deu para confirmar o envio')) {
        out.uncertain = true
        out.retry = () => put().then(rest, (e) => { throw fail(e) })
      } else {
        out.retry = rest
      }
      return out
    }
    try {
      const draft = await call('dm.pageDraft', { page, kind: 'ctl', op: 'blocked', peer })
      const signed = await pagesDm(node, { member, page, action: 'dm-sign', op: { digest: draft.digest } })
      params = { page, id: draft.id, signature: signed.signature, expiresAt: signed.expiresAt }
      await put()
    } catch (err) {
      throw fail(err)
    }
  }
  return { done: todo.length }
}

// The peers whose old blocks the node still lists for re-apply, once each;
// [] when the read fails (a locked node, no held keys). A read only: the
// card names them before the owner confirms.
export async function pagesDmLegacyPeers (node, { page }) {
  try {
    const listed = await nodeCall(node)('dm.pageLegacyBlocks', { page })
    const pending = isObject(listed) && Array.isArray(listed.pending) ? listed.pending.filter(isKey) : []
    return [...new Set(pending)]
  } catch {
    return []
  }
}

// How many old blocks the node still lists for re-apply: the card's label.
export async function pagesDmLegacyPending (node, { page }) {
  return (await pagesDmLegacyPeers(node, { page })).length
}

// The legacy steps of an owner's tap, in order: import `bundle` (null skips
// it), then re-apply the pending blocks. The first failure throws with
// `step` ('import' or 'blocks') and a `retry` that goes on from there: the
// exact uncertain write when its outcome is unknown, else the steps left.
export async function pagesDmLegacyFinish (node, { member, page, bundle }) {
  const blocks = () => pagesDmReapplyBlocks(node, { member, page })
  if (bundle) {
    const onward = (err) => {
      const out = err || pageError('indisponivel')
      out.step = 'import'
      if (out.uncertain === true && typeof out.retry === 'function') {
        const again = out.retry
        out.retry = () => again().then(blocks, (e) => { throw onward(e) })
      } else {
        out.retry = () => pagesDmLegacyFinish(node, { member, page, bundle })
      }
      return out
    }
    try {
      await pagesDmLegacyImport(node, { member, page, bundle })
    } catch (err) {
      throw onward(err)
    }
  }
  return blocks()
}

// After 'dm-box': the self share goes into the node.
async function adoptOwn (node, { member, page, prep, cert }) {
  const self = prep.dmBox.shares.find((sh) => sh.member === member)
  const params = secretsParams({ page, share: { ...self, gen: prep.gen }, by: member, box: prep.dmBox.box, groupBox: prep.dmBox.groupBox, cert })
  if (params === null) throw pageError('indisponivel')
  await nodeCall(node)('dm.pageSecrets', params)
  adoptedUpTo(page, prep.gen)
  return { gen: prep.gen, missing: prep.missing }
}

// Activation by the owner (5.84 'dm-box'): generate, publish, then keep the
// own share. An uncertain 'dm-box' keeps its retry (the same signed bytes,
// then the adoption); a 'conflito' is plain: the caller reads 'dm-box-read'
// again. On a legacy page the service seals the old conversations into a
// bundle for the owner: 'dm-box-read', read again after 'dm-box', names it,
// and the last steps import it and re-apply the old blocks
// (pagesDmLegacyFinish). A failure there does not undo the activation: it
// comes back as `blocksError`, with its retry.
export async function pagesDmActivate (node, { member, page, status, roster }) {
  const legacy = isLegacyPage(status)
  const prep = await pagesDmPrepare(node, { member, page, status, roster })
  const finish = async () => {
    let cert = status.cert
    let after = null
    if (legacy) {
      after = await pagesDmBoxRead(node, { member, page })
      if (isObject(after.cert)) cert = after.cert
    }
    const out = await adoptOwn(node, { member, page, prep, cert })
    if (!legacy) return out
    try {
      await pagesDmLegacyFinish(node, { member, page, bundle: legacyBundleOf(after) })
    } catch (err) {
      out.blocksError = err
    }
    return out
  }
  // Every retry, however many, ends in the same finish.
  const wrap = (err) => {
    if (err && err.uncertain === true && typeof err.retry === 'function') {
      const again = err.retry
      err.retry = () => again().then(finish, (e) => { throw wrap(e) })
    }
    return err
  }
  pagesDmExpectAdopt(page, prep.gen)
  try {
    await pagesDm(node, { member, page, action: 'dm-box', op: prep.dmBox })
  } catch (err) {
    if (!err || err.uncertain !== true) pagesDmForgetAdopt(page, prep.gen)
    throw wrap(err)
  }
  return finish()
}

// 'Enviar chave' to one member of the roster: seal the held secrets for the
// member's dm-key, or for the box a core delegate signed for itself (a fresh
// 'dm-box-read', only when it has no dm-key; a failed read counts as no
// statement), and file the share. A write: { uncertain, retry }.
export async function pagesDmShareTo (node, { member, page, to }) {
  const boxes = await pagesDmBoxes(node, [to])
  let params = isKey(boxes[to]) ? { page, member: to, box: boxes[to] } : null
  if (params === null) {
    let stated = null
    try {
      stated = actorBoxOf(await pagesDmBoxRead(node, { member, page }), to)
    } catch {}
    if (stated !== null) params = { page, member: to, box: stated.box, proof: stated.proof }
  }
  if (params === null) throw new Error(PAGE_DM_NO_BOX)
  const s = await nodeCall(node)('dm.pageShare', params)
  if (!isObject(s) || !Number.isInteger(s.gen)) throw pageError('indisponivel')
  return pagesDm(node, { member, page, action: 'dm-box-share', op: { member: to, gen: s.gen, sealed: s.sealed, sig: s.sig } })
}

// The invite's optional share: { sealed, sig } for the invitee, sealed for
// the service's current gen (`status`, a 'dm-box-read' answer), or null when
// the invitee has no dm-key or this device cannot seal that gen: the invite
// still goes out and the member is listed for 'Enviar chave'. A device whose
// held gen is behind adopts the own share of `status` first.
export async function pagesDmInviteShare (node, { page, to, status }) {
  if (!isObject(status) || !Number.isInteger(status.gen) || status.gen < 1) return null
  const boxes = await pagesDmBoxes(node, [to])
  if (!isKey(boxes[to])) return null
  const seal = async () => {
    try {
      const s = await nodeCall(node)('dm.pageShare', { page, member: to, box: boxes[to] })
      return isObject(s) && Number.isInteger(s.gen) && typeof s.sealed === 'string' && typeof s.sig === 'string' ? s : null
    } catch {
      return null
    }
  }
  let s = await seal()
  if ((s === null || s.gen < status.gen) && isObject(status.share) && status.share.gen === status.gen) {
    try {
      await pagesDmAdopt(node, { page, status })
    } catch {
      return null
    }
    s = await seal()
  }
  return s !== null && s.gen === status.gen ? { sealed: s.sealed, sig: s.sig } : null
}

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

// ---- forgetting a page's keys on this device (dm.pageForget) ------------------

// Best effort and never repeated by itself: the keys and the conversations
// this node holds for a page go. dm.pageLegacyBlocks answers only while the
// node holds that page's keys, so a page it never held writes nothing. A
// core node holds none. -> true when the node forgot it.
export async function pagesDmForget (node, page) {
  const call = signer(node)
  if (call === null || pagesDmCoreOnly(node) || !isKey(page)) return false
  try {
    await call('dm.pageLegacyBlocks', { page })
  } catch {
    return false
  }
  try {
    await call('dm.pageForget', { page })
    return true
  } catch {
    return false
  }
}

// The newest 'list' answer applied per account origin and member this
// session (another origin's list never names this one's pages), the pages a
// forget was tried for (each once), the pages whose move chain could not be
// read (the next list read for that origin and member walks it again) and the
// walks in flight.
const listRuns = new Map()
const forgetTried = new Set()
const walkAgain = new Map()
const walking = new Set()
let listCalls = 0

// The signed 'list' read. An answer newer than the last one applied for the
// member also forgets, on this device, the keys of the pages it shows the
// member no longer runs (pageSecrets.js pagesNoLongerRun) and of the keys
// those pages moved from (pageOldKeys.js); `also` names the acting page and
// the pages the node flagged. A failed read forgets nothing.
export async function pagesList (node, { member, also = [] } = {}) {
  const seq = ++listCalls
  // Who the app acted as when this read started: an answer never ends an identity chosen after it.
  const actedAs = actingStore.pageKey()
  const runKey = String(pagesOrigin(node)) + ' ' + member
  const data = await actAs(node, { member, action: 'list', page: '', op: {} })
  const last = listRuns.get(runKey)
  if (last !== undefined && last.seq > seq) return data
  const before = [...(last ? last.run : []), ...(walkAgain.get(runKey) || [])]
  const out = pagesNoLongerRun(data, { before, also, tried: forgetTried })
  if (out === null) return data
  listRuns.set(runKey, { seq, run: out.run })
  // The device keeps acting as a page the member stopped running (closed, moved
  // or removed as admin elsewhere) until this answer says otherwise.
  if (actedAs !== null && actingPageStopped(data, actedAs)) actingStore.dropPage(actedAs)
  walkAgain.delete(runKey)
  const forget = (page) => {
    forgetTried.add(page)
    pagesDmForget(node, page).then((forgot) => {
      if (forgot && typeof node.clearPageMismatch === 'function') node.clearPageMismatch(page)
    }).catch(() => {})
  }
  const call = signer(node)
  const closed = pagesRun(data).closed
  for (const page of out.gone) {
    // A closed page is not walked: the keys it moved from are still listed to
    // its roster. A core node holds no page keys.
    if (call === null || pagesDmCoreOnly(node) || closed.includes(page)) {
      forget(page)
      continue
    }
    if (walking.has(page)) continue
    // The keys it moved from go with it unless still run: after a restart no
    // earlier answer names them, and the service lists them to no one who
    // lost the newest key. The chain is read before the page goes, so a
    // failed read keeps the page (and the node's flag on it) for a retry.
    walking.add(page)
    oldPageKeys(call, page, { strict: true }).then((keys) => {
      walking.delete(page)
      const { run } = listRuns.get(runKey)
      for (const k of [page, ...keys]) if (!run.includes(k) && !forgetTried.has(k)) forget(k)
    }, () => {
      walking.delete(page)
      const later = walkAgain.get(runKey) || []
      if (!later.includes(page)) walkAgain.set(runKey, [...later, page])
    })
  }
  return data
}
