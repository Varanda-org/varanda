'use strict'

// Páginas from a core node: each step signs with the local page delegate
// (member.pageSign, docs/rpc.md 5.84 and 5.87) and then calls the account
// service at VARANDA_ACCOUNT_ORIGIN (start, then POST /account/pages/<action>),
// as apps/app/src/pages.js does. Nothing here re-signs or resends a request;
// an unknown outcome after a signature exists says so. stdout carries public
// keys, seq and pushed only: never a secret, a signature or a photo body.

const fs = require('node:fs')
const nodeCrypto = require('node:crypto')
const { jsonLine, safe } = require('@varanda/core/lib/safe')
const member = require('@varanda/core/lib/member')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { stillImageSize } = require('@varanda/core/lib/still-image')
const { MEDIA_MIMES, AVATAR_MIMES, AVATAR_SIDE, MAX_AVATAR_BYTES, MEDIA_BLOCK_BYTES, MAX_MEDIA_ITEM_BLOCKS } = require('@varanda/core/lib/records')
const { validateParams } = require('@varanda/rpc')

const USAGE_TEXT = 'node bin/varanda.js page register|terms|create|list|post|reply|photo|follow|unfollow|notices|close|move|join|leave|group-post'
const MAX_FILES = 4
const MAX_MEDIA_BYTES = MEDIA_BLOCK_BYTES * MAX_MEDIA_ITEM_BLOCKS
const TIMEOUT_MS = 30000
const MAX_ANSWER = 1024 * 1024
const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost']
const UNCERTAIN = ' (resultado incerto: confira antes de repetir)'

// The service's tokens (apps/app/src/pages.js TEXTS); any other is 'indisponivel'.
const TEXTS = {
  'nao-vinculado': 'este nó não tem delegado aceito pelo serviço (rode page register, sincronize e page terms)',
  'sem-permissao': 'sem permissão para isso',
  limite: 'limite atingido',
  'nome-em-uso': 'esse @nome já está em uso',
  'nome-invalido': 'esse @nome não vale',
  expirado: 'pedido expirado ou desatualizado',
  'assinatura-invalida': 'não foi possível provar a chave',
  'pedido-invalido': 'pedido inválido',
  pausada: 'página pausada; fale com a associação',
  encerrada: 'esta página foi encerrada',
  movida: 'esta página mudou para uma nova chave',
  'midia-invalida': 'foto não aceita',
  indisponivel: 'serviço indisponível',
  'termos-pendentes': 'aceite os Termos antes (page terms)',
  'troca-bloqueada': 'você ainda não pode trocar o @nome',
  'nao-encontrado': 'não encontrado',
  'em-andamento': 'pedido ainda em andamento'
}

function usage (message) {
  const err = new Error(message)
  err.code = 'USAGE'
  return err
}

function serviceError (code, uncertain) {
  const token = Object.hasOwn(TEXTS, code) ? code : 'indisponivel'
  const err = new Error(TEXTS[token] + (uncertain ? UNCERTAIN : ''))
  err.token = token
  if (uncertain) err.uncertain = true
  return err
}

// https only; plain http only on a loopback host (the local test service).
// The value is not a secret, but the message still does not echo it.
function accountOrigin (raw) {
  if (raw === null || raw === undefined || raw === '') throw usage('informe VARANDA_ACCOUNT_ORIGIN (https://...)')
  let url = null
  try {
    url = new URL(raw)
  } catch {}
  const ok = url !== null && url.username === '' && url.password === '' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) &&
    raw.replace(/\/$/, '') === url.origin
  if (!ok) throw usage('VARANDA_ACCOUNT_ORIGIN inválido: use https://<host>')
  return url.origin
}

function ctxOf (flags) {
  return { dataDir: flags.dataDir, association: flags.association || null }
}

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function pageOf (flags) {
  if (flags.page === null) throw usage('informe --page <chave>')
  return flags.page
}

function textOf (flags) {
  if (flags.text === null) throw usage('informe --text <texto>')
  return flags.text
}

// The delegate's public key, the member of every request. The secret is
// wiped at once: member.pageSign reads the file again for each signature.
function delegateKey (ctx) {
  const pair = member.readDelegate(ctx)
  if (pair === null) throw usage('chave de página não registrada: rode page register')
  pair.secretKey.fill(0)
  return pair.publicKey.toString('hex')
}

async function post (origin, action, { body, raw, headers }, signed) {
  const init = { method: 'POST', headers: { accept: 'application/json', 'x-varanda-client': 'app' }, signal: AbortSignal.timeout(TIMEOUT_MS) }
  if (raw !== undefined) {
    init.headers['content-type'] = 'application/octet-stream'
    Object.assign(init.headers, headers)
    init.body = raw
  } else {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res
  let data = null
  try {
    res = await fetch(origin + '/account/pages/' + action, init)
    const text = await res.text()
    if (text.length > MAX_ANSWER) throw new Error('too large')
    if (text !== '') data = JSON.parse(text)
  } catch {
    throw serviceError('indisponivel', signed)
  }
  const object = data !== null && typeof data === 'object' && !Array.isArray(data)
  if (res.status === 202 || (res.ok && (!object || data.uncertain === true))) throw serviceError('indisponivel', signed)
  if (res.ok) return data
  const code = object && typeof data.error === 'string' ? data.error : ''
  if (code === 'em-andamento') throw serviceError(code, signed)
  if (Object.hasOwn(TEXTS, code)) throw serviceError(code, false)
  throw serviceError('indisponivel', signed && res.status >= 500)
}

function sign (ctx, params) {
  const checked = validateParams('page.sign', params)
  if (!checked.ok) throw usage('operação de página inválida')
  return member.pageSign(ctx, checked.value)
}

// start -> page.sign -> POST. `op` may be a function of { nonce, to }: the
// records carry the nonce the service minted. A read (signed: false) is plain
// on failure; a write after its signature is uncertain when unknown.
async function step (flags, { action, page = '', op = {}, signed = true, upload = null }) {
  const origin = accountOrigin(flags.accountOrigin)
  const ctx = ctxOf(flags)
  const actor = delegateKey(ctx)
  const startBody = { member: actor, action }
  if (page !== '') startBody.page = page
  const started = await post(origin, 'start', { body: startBody }, false)
  if (typeof started.nonce !== 'string') throw serviceError('indisponivel', false)
  const { nonce } = started
  const to = action === 'move' ? started.to : undefined
  if (action === 'move' && typeof to !== 'string') throw serviceError('indisponivel', false)
  const target = action === 'create' ? started.page : page
  if (action === 'create' && typeof target !== 'string') throw serviceError('indisponivel', false)
  const theOp = typeof op === 'function' ? op({ nonce, to }) : op
  const s = sign(ctx, { action, nonce, page: target, op: theOp })
  let data
  if (upload !== null) {
    data = await post(origin, action, {
      raw: upload,
      headers: {
        'x-varanda-page-member': actor,
        'x-varanda-page-nonce': nonce,
        'x-varanda-page-page': target,
        'x-varanda-page-signature': s.signature,
        'x-varanda-page-op': JSON.stringify(theOp).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
      }
    }, true)
  } else if (action === 'move') {
    data = await post(origin, action, { body: { member: actor, nonce, page, record: s.record, origin: s.origin, roster: s.roster } }, true)
  } else if (action === 'close') {
    data = await post(origin, action, { body: { member: actor, nonce, page, record: s.record } }, true)
  } else {
    const body = { member: actor, nonce }
    if (target !== '') body.page = target
    body.op = theOp
    body.signature = s.signature
    if (action === 'create') body.record = s.record
    if (action === 'terms') body.termsSignature = s.termsSignature
    data = await post(origin, action, { body }, signed)
  }
  return { data, actor, page: target, to }
}

function sniffMime (bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

function imageSize (bytes, mime) {
  if (mime === 'image/jpeg' || mime === 'image/webp') return stillImageSize(bytes, mime)
  if (mime === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (mime === 'image/gif' && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  return null
}

// A photo file: its bytes, sniffed type and size; refused before anything
// is signed. The path is the user's own, so the message names it safely.
function readImage (file, { mimes, max }) {
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch {
    throw usage('não foi possível ler ' + safe(file))
  }
  const mime = sniffMime(bytes)
  if (bytes.length < 1 || bytes.length > max || mime === null || !mimes.includes(mime)) throw usage('foto não aceita: ' + safe(file))
  const size = imageSize(bytes, mime)
  if (size === null || !(size.width > 0) || !(size.height > 0)) throw usage('foto não aceita: ' + safe(file))
  return { bytes, mime, size, sha256: nodeCrypto.createHash('sha256').update(bytes).digest('hex') }
}

function filesOf (flags) {
  const files = flags.files || []
  if (files.length > MAX_FILES) throw usage('no máximo ' + MAX_FILES + ' fotos por publicação')
  return files.map((f) => readImage(f, { mimes: MEDIA_MIMES, max: MAX_MEDIA_BYTES }))
}

async function uploadMedia (flags, page, images) {
  const media = []
  for (const img of images) {
    const op = { sha256: img.sha256, mime: img.mime, width: img.size.width, height: img.size.height, bytes: img.bytes.length }
    const { data } = await step(flags, { action: 'media', page, op, upload: img.bytes })
    if (data === null || typeof data.descriptor !== 'object') throw serviceError('indisponivel', true)
    media.push(data.descriptor)
  }
  return media
}

function written (data) {
  return { seq: data.seq, pushed: data.pushed === true }
}

function writtenLine (prefix, data) {
  return prefix + ' #' + data.seq + (data.pushed === true ? ' (enviado ao semeador)' : ' (envio ao semeador pendente)')
}

async function registerRun (flags) {
  const result = await member.pageRegister(ctxOf(flags))
  print(flags, result, 'delegado de página: ' + result.actor + '\nconvites chegam por esta chave; sincronize antes de page terms')
}

async function termsRun (flags) {
  const ctx = ctxOf(flags)
  const { publicKey } = await member.idShow(ctx)
  const { data } = await step(flags, { action: 'terms', op: { version: TERMS_VERSION, diary: publicKey } })
  const result = { version: data.version }
  print(flags, result, 'Termos aceitos (versão ' + safe(String(data.version)) + ')')
}

async function createRun (flags) {
  if (flags.username === null) throw usage('informe --username <nome>')
  if (flags.name === null) throw usage('informe --name <nome>')
  const at = new Date().toISOString()
  const op = ({ nonce }) => ({
    username: flags.username,
    name: flags.name,
    bio: flags.bio === null ? '' : flags.bio,
    roster: { gen: 1, admins: [], prev: null, at, nonce }
  })
  const { data, page } = await step(flags, { action: 'create', op })
  const result = { page, ...written(data) }
  print(flags, result, writtenLine('página criada: ' + page, data))
}

async function listRun (flags) {
  const { data } = await step(flags, { action: 'list', signed: false })
  const keys = (list) => (Array.isArray(list) ? list : []).map((p) => p && p.page).filter((k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k))
  const result = { owned: keys(data.owned), admin: keys(data.admin), invites: keys(data.invites), offers: keys(data.offers) }
  // A closed or moved page is no longer live: say so, and name the new key.
  const state = {}
  for (const p of [...(Array.isArray(data.owned) ? data.owned : []), ...(Array.isArray(data.admin) ? data.admin : [])]) {
    if (!p || typeof p.page !== 'string' || !/^[0-9a-f]{64}$/.test(p.page)) continue
    if (typeof p.movedTo === 'string' && /^[0-9a-f]{64}$/.test(p.movedTo)) state[p.page] = ', mudou para ' + p.movedTo
    else if (p.closed === true) state[p.page] = ', encerrada'
  }
  const lines = [
    ...result.owned.map((k) => k + ' (dono' + (state[k] || '') + ')'),
    ...result.admin.map((k) => k + ' (admin' + (state[k] || '') + ')'),
    ...result.invites.map((k) => k + ' (convite)'),
    ...result.offers.map((k) => k + ' (oferta de transferência)')
  ]
  print(flags, result, lines.length ? lines.join('\n') : 'nenhuma página')
}

async function postRun (flags) {
  const page = pageOf(flags)
  const text = textOf(flags)
  const images = filesOf(flags)
  const media = await uploadMedia(flags, page, images)
  const op = media.length ? { text, media } : { text }
  const { data } = await step(flags, { action: 'post', page, op })
  print(flags, written(data), writtenLine('publicado', data))
}

async function replyRun (flags) {
  const page = pageOf(flags)
  if (flags.to === null) throw usage('informe --to <chave>:<seq>')
  const text = textOf(flags)
  const images = filesOf(flags)
  const media = await uploadMedia(flags, page, images)
  const op = { to: flags.to.author + ':' + flags.to.seq, text }
  if (media.length) op.media = media
  const { data } = await step(flags, { action: 'reply', page, op })
  print(flags, written(data), writtenLine('resposta publicada', data))
}

async function photoRun (flags) {
  const page = pageOf(flags)
  const files = flags.files || []
  if (files.length !== 1) throw usage('informe uma --file <foto>')
  // The avatar op rewrites the whole profile: a missing --bio would erase it.
  if (flags.name === null || flags.bio === null) throw usage('informe --name <nome> e --bio <texto> (o perfil é reescrito junto com a foto; --bio "" deixa a bio vazia)')
  const img = readImage(files[0], { mimes: AVATAR_MIMES, max: MAX_AVATAR_BYTES })
  if (img.size.width !== AVATAR_SIDE || img.size.height !== AVATAR_SIDE) throw usage('a foto da página precisa ter ' + AVATAR_SIDE + 'x' + AVATAR_SIDE + ' pixels')
  const op = { sha256: img.sha256, mime: img.mime, bytes: img.bytes.length, name: flags.name, bio: flags.bio }
  const { data } = await step(flags, { action: 'avatar', page, op, upload: img.bytes })
  print(flags, written(data), writtenLine('foto da página publicada', data))
}

function followRun (on) {
  return async (flags) => {
    const page = pageOf(flags)
    if (flags.key === null) throw usage('informe --key <chave>')
    const { data } = await step(flags, { action: 'follow', page, op: { key: flags.key, on } })
    print(flags, written(data), writtenLine(on ? 'a página segue ' + flags.key : 'a página deixou de seguir ' + flags.key, data))
  }
}

async function noticesRun (flags) {
  const page = pageOf(flags)
  const op = {}
  if (flags.limit !== null) op.limit = flags.limit
  const { data } = await step(flags, { action: 'notices', page, op, signed: false })
  if (flags.json) {
    process.stdout.write(jsonLine(data) + '\n')
    return
  }
  const items = Array.isArray(data.items) ? data.items : []
  const lines = items.map((n) => [n && n.kind, n && (n.from || n.key || n.author)].filter((v) => typeof v === 'string').map((v) => safe(v)).join(' '))
  process.stdout.write((lines.length ? lines.join('\n') : 'nenhum aviso') + '\n')
}

// The roster in force, from the signed 'status' read.
async function statusOf (flags, page) {
  const { data } = await step(flags, { action: 'status', page, signed: false })
  if (!Number.isSafeInteger(data.gen) || typeof data.owner !== 'string' || !Array.isArray(data.admins)) throw serviceError('indisponivel', false)
  return data
}

async function closeRun (flags) {
  const page = pageOf(flags)
  const { gen } = await statusOf(flags, page)
  const at = new Date().toISOString()
  const { data } = await step(flags, { action: 'close', page, op: ({ nonce }) => ({ gen: gen + 1, at, nonce }) })
  const result = { page, closed: true }
  if (Number.isSafeInteger(data.seq)) result.seq = data.seq
  if (typeof data.pushed === 'boolean') result.pushed = data.pushed
  print(flags, result, 'página encerrada: ' + page)
}

async function moveRun (flags) {
  const page = pageOf(flags)
  const st = await statusOf(flags, page)
  if (!Number.isSafeInteger(st.length) || st.length < 2) throw serviceError('indisponivel', false)
  const at = new Date().toISOString()
  let reserved = null
  const op = ({ nonce, to }) => {
    reserved = to
    return { to, gen: st.gen, fromSeq: st.length - 1, owner: st.owner, admins: st.admins, at, nonce }
  }
  let to
  try {
    ({ to } = await step(flags, { action: 'move', page, op }))
  } catch (err) {
    // An unknown outcome may have moved the page: the new key is public.
    if (err && err.uncertain === true && reserved !== null) err.message += ' (chave nova: ' + reserved + ')'
    throw err
  }
  print(flags, { page, to }, 'página movida para ' + to)
}

function groupStep (kind) {
  return async (flags) => {
    const page = pageOf(flags)
    let action
    let op
    if (kind === 'post') {
      if (flags.group === null) throw usage('informe --group <chave>')
      action = 'group-post'
      op = { group: flags.group, text: textOf(flags) }
    } else if (flags.community !== null && flags.group === null) {
      action = 'community-' + kind
      op = { community: flags.community }
    } else if (flags.group !== null && flags.community === null) {
      action = 'group-' + kind
      op = { group: flags.group }
    } else {
      throw usage('informe --community <chave> ou --group <chave>')
    }
    const { data } = await step(flags, { action, page, op })
    const result = {}
    if (Number.isSafeInteger(data.seq)) result.seq = data.seq
    if (typeof data.pushed === 'boolean') result.pushed = data.pushed
    const lines = { join: 'a página entrou', leave: 'a página saiu', post: 'publicado no grupo' }
    print(flags, result, lines[kind] + (Number.isSafeInteger(data.seq) ? ' #' + data.seq : ''))
  }
}

const subs = {
  register: registerRun,
  terms: termsRun,
  create: createRun,
  list: listRun,
  post: postRun,
  reply: replyRun,
  photo: photoRun,
  follow: followRun(true),
  unfollow: followRun(false),
  notices: noticesRun,
  close: closeRun,
  move: moveRun,
  join: groupStep('join'),
  leave: groupStep('leave'),
  'group-post': groupStep('post')
}

// A mutating call is never resent; the uncertain text is already on the error.
async function pageRun (flags) {
  const sub = flags.positionals[0]
  if (!Object.hasOwn(subs, sub)) throw usage(USAGE_TEXT)
  await subs[sub](flags)
}

module.exports = {
  accountOrigin,
  groupStep,
  commands: {
    page: { summary: 'páginas de negócio ou projeto pelo serviço de conta', run: pageRun }
  }
}
