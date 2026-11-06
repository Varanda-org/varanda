import rpc from '@varanda/rpc'
import { WIDEST_DM_ITEM, WIDEST_DM_VOICE, composePlan, stagedVoice, voiceUploadError } from './attach-plan.js'
import { retryChatSend, runChatSend } from './chatSend.js'
import { mergeRows } from './conversas.js'

const { validateParams, MAX_TEXT, dmTextBudget, dmTextBytes, MEMBER_CERT_STANDIN } = rpc

// Forwarding one chat message into other conversations.
//
// forwardPlan(source, target) decides what one forward needs. It does no
// I/O. Every media item is uploaded again into the destination: dm.putMedia
// for a DM, media.uploadFile with sealed: true for a private group,
// media.uploadFile for a public group. The source's items are never sent
// as they are: the node accepts in dm.send only blobs this device uploaded
// in this unlock, a public descriptor only verifies while its core is local
// and still declared, and an old blob would carry the original's age
// through every forward.
//
// source: { kind: 'dm' | 'group' | 'post', visibility: 'public' | 'private'
//   (group only), text, media: [item], replyTo? }. A DM item is the dm.send
//   blob descriptor, a public group or post item the protocol section 2
//   descriptor, a private group item the sealed item. An item marked
//   { unavailable: true } (gone before the forward) is dropped.
// target: { kind: 'dm', to } or { kind: 'group', group, visibility }.
//
// Result, on success:
//   { ok: true, fwd: 1, text, uploads: [step], confirm?: 'audience',
//     dropped?: 'A mídia expirou' }
// where each step is
//   { index, method: 'dm.putMedia' | 'media.uploadFile',
//     params: { mime, width, height, ms?, kind?: 'voice', sealed? } }
// index points into source.media. Otherwise { ok: false, error }; it never
// throws. The plan carries no replyTo and nothing that names the source's
// author. confirm: 'audience' asks AUDIENCE_QUESTION before a private item
// goes to a public group. A DM destination is measured first: a text that
// cannot fit next to its media fails with 'mensagem longa demais' before any
// upload.
//
// runForward then reads each item (the device cache first, then the source),
// uploads it and sends one request with fwd: 1. An item neither read gives
// is dropped and the text still goes; a media-only message with nothing left
// fails. An uncertain send keeps its exact request: only an explicit
// retryForward resends it, never this module by itself.

export const FORWARD_FLAG = 1
export const FORWARD_MAX = 5
export const EXPIRED = 'A mídia expirou'
export const TOO_LONG = 'mensagem longa demais'
export const AUDIENCE = 'audience'
export const AUDIENCE_QUESTION = 'Esta mídia era privada. Enviar para um grupo público?'
export const FORWARDED_LABEL = 'Encaminhada'

const HEX64 = /^[0-9a-f]{64}$/
const STANDIN = '0'.repeat(64)
const VOICE_MIME = 'audio/mp4'

const isKey = (v) => typeof v === 'string' && HEX64.test(v)
const fail = (error) => ({ ok: false, error })
const codePoints = (s) => Array.from(s).length

function isDmItem (item) {
  return validateParams('dm.send', { to: STANDIN, text: '', media: [item] }).ok
}

function isPublicItem (item) {
  return validateParams('group.post', { group: STANDIN, text: '', media: [item] }).ok
}

function isPrivateItem (item) {
  return validateParams('group.post', { group: STANDIN, text: '', media: [item], sealed: true }).ok
}

// Whether the source is private (DM or private group), and the validator its
// items must pass.
function sourceShape (source) {
  if (source.kind === 'dm') return { private: true, valid: isDmItem }
  if (source.kind === 'post') return { private: false, valid: isPublicItem }
  if (source.kind === 'group') {
    if (source.visibility === 'public') return { private: false, valid: isPublicItem }
    if (source.visibility === 'private') return { private: true, valid: isPrivateItem }
    return null
  }
  return null
}

function checkTarget (target) {
  if (!target || typeof target !== 'object') return 'destino inválido'
  if (target.kind === 'dm') return isKey(target.to) ? null : 'destino inválido'
  if (target.kind === 'group') {
    if (!isKey(target.group)) return 'destino inválido'
    return ['public', 'private'].includes(target.visibility) ? null : 'destino inválido'
  }
  return 'destino inválido'
}

function plainMimeOf (source, item) {
  if (source.kind === 'group' && source.visibility === 'private') return item.plainMime
  return item.mime
}

// What the upload call needs to rebuild the item from its plaintext: the
// plaintext mime and size, and for a voice note its length and kind, as the
// voice send paths of Mensagem.js and Grupo.js upload them.
function uploadParams (source, item, sealed) {
  const mime = plainMimeOf(source, item)
  let width, height
  if (source.kind === 'dm' || (source.kind === 'group' && source.visibility === 'private')) {
    ({ w: width, h: height } = item)
  } else {
    ({ width, height } = item)
  }
  const params = { mime, width, height }
  if (mime === VOICE_MIME) {
    params.width = 0
    params.height = 0
    params.ms = item.ms
    params.kind = 'voice'
  }
  if (sealed) params.sealed = true
  return params
}

export function forwardPlan (source, target) {
  try {
    return plan(source, target)
  } catch {
    return fail('encaminhamento inválido')
  }
}

function plan (source, target) {
  if (!source || typeof source !== 'object') return fail('mensagem inválida')
  const shape = sourceShape(source)
  if (!shape) return fail('mensagem inválida')
  if (typeof source.text !== 'string') return fail('mensagem inválida')
  if (codePoints(source.text) > MAX_TEXT) return fail(TOO_LONG)
  const media = source.media == null ? [] : source.media
  if (!Array.isArray(media)) return fail('anexos inválidos')
  const targetError = checkTarget(target)
  if (targetError) return fail(targetError)

  const toDm = target.kind === 'dm'
  const toPublic = target.kind === 'group' && target.visibility === 'public'
  const sealed = target.kind === 'group' && target.visibility === 'private'

  const uploads = []
  let dropped = false
  let voice = false
  for (let index = 0; index < media.length; index++) {
    const item = media[index]
    if (item && typeof item === 'object' && item.unavailable === true) {
      dropped = true
      continue
    }
    if (!shape.valid(item)) return fail('anexo inválido')
    const params = uploadParams(source, item, sealed)
    if (params.kind === 'voice') voice = true
    uploads.push({ index, method: toDm ? 'dm.putMedia' : 'media.uploadFile', params })
  }
  if (uploads.length === 0 && source.text === '') return fail(dropped ? EXPIRED : 'mensagem vazia')

  if (toDm) {
    const count = uploads.length
    const budget = dmTextBudget({
      to: target.to,
      fwd: FORWARD_FLAG,
      media: count > 0 ? Array(count).fill(voice ? WIDEST_DM_VOICE : WIDEST_DM_ITEM) : undefined,
      cert: MEMBER_CERT_STANDIN
    })
    if (dmTextBytes(source.text) > budget) return fail(TOO_LONG)
  }

  const result = { ok: true, fwd: FORWARD_FLAG, text: source.text, uploads }
  if (toPublic && shape.private && uploads.length > 0) result.confirm = AUDIENCE
  if (dropped) result.dropped = EXPIRED
  return result
}

// The request target composePlan takes for a forward destination.
function composeTarget (target) {
  if (target.kind === 'dm') return { kind: 'dm', to: target.to, fwd: FORWARD_FLAG }
  return { kind: 'group', group: target.group, visibility: target.visibility, fwd: FORWARD_FLAG }
}

// One read of item `index`: { bytes, mime, w?, h?, ms? } or null. A read
// that throws counts as nothing read.
async function readOnce (read, index) {
  if (typeof read !== 'function') return null
  try {
    const got = await read(index)
    if (!got || !(got.bytes instanceof Uint8Array) || got.bytes.byteLength === 0) return null
    return got
  } catch {
    return null
  }
}

// The file to upload for `step` from what a read gave: the size the read
// measured wins over the one the item declared.
function fileOf (step, got) {
  const p = step.params
  const voice = p.kind === 'voice'
  const width = voice ? 0 : (Number.isInteger(got.w) && got.w > 0 ? got.w : p.width)
  const height = voice ? 0 : (Number.isInteger(got.h) && got.h > 0 ? got.h : p.height)
  const ms = voice ? (Number.isInteger(got.ms) && got.ms > 0 ? got.ms : p.ms) : undefined
  return { bytes: got.bytes, mime: p.mime, width, height, ...(voice ? { ms } : {}) }
}

function uploadArgs (step, file) {
  const p = step.params
  const args = { bytes: file.bytes, mime: file.mime, width: file.width, height: file.height }
  if (p.kind === 'voice') {
    args.ms = file.ms
    args.kind = 'voice'
  }
  if (p.sealed === true) args.sealed = true
  return args
}

// Runs one forward plan into `target`. readCache(index) and
// readSource(index) give an item's plaintext ({ bytes, mime, w, h, ms }) or
// null; media is the node's { putDm, upload }; request(method, params) sends.
// -> { phase: 'done' | 'uncertain' | 'failed' | 'cancelled', op?, error?,
// dropped? }; never rejects, and sends at most once. Every plaintext read is
// zero-filled once the forward settles: the upload made its own copy.
export async function runForward (args = {}) {
  const files = []
  try {
    return await forwardOnce(args, files)
  } finally {
    for (const f of files) {
      try { f.bytes.fill(0) } catch {}
    }
  }
}

async function forwardOnce ({ plan: p, target, readCache, readSource, media, request, live = () => true, onPhase, uncertain }, files) {
  if (!p || p.ok !== true || !Array.isArray(p.uploads) || checkTarget(target) !== null) {
    return { phase: 'failed', error: new Error('encaminhamento inválido') }
  }
  let dropped = typeof p.dropped === 'string'
  const kept = []
  for (const step of p.uploads) {
    if (!live()) return { phase: 'cancelled' }
    let got = await readOnce(readCache, step.index)
    if (got === null) got = await readOnce(readSource, step.index)
    if (got === null) {
      dropped = true
      continue
    }
    kept.push(step)
    files.push(fileOf(step, got))
  }
  const extra = dropped ? { dropped: EXPIRED } : {}
  if (files.length === 0 && p.text === '') return { phase: 'failed', error: new Error(EXPIRED), ...extra }
  let send
  try {
    const staged = files.map((f, i) => f.ms !== undefined
      ? stagedVoice({ ms: f.ms }, i)
      : { name: i.toString(16).padStart(32, '0') + '.bin', mime: f.mime, width: f.width, height: f.height })
    send = composePlan({ text: p.text, attachments: staged, target: composeTarget(target) })
  } catch (error) {
    return { phase: 'failed', error, ...extra }
  }
  const r = await runChatSend({
    plan: send,
    files,
    upload: async (file, i) => {
      const step = kept[i]
      const voice = step.params.kind === 'voice'
      try {
        if (step.method === 'dm.putMedia') {
          if (!media || typeof media.putDm !== 'function') throw new Error('anexos indisponíveis')
          // A blob of its own per destination (rpc 5.97): an uncertain send
          // to one conversation never lends its blob to the next.
          return await media.putDm({ ...uploadArgs(step, file), to: target.to })
        }
        if (!media || typeof media.upload !== 'function') throw new Error('anexos indisponíveis')
        return await media.upload(uploadArgs(step, file))
      } catch (err) {
        throw voice ? voiceUploadError(err) : err
      }
    },
    request,
    live,
    ...(typeof onPhase === 'function' ? { onPhase } : {}),
    ...(typeof uncertain === 'function' ? { uncertain } : {})
  })
  return { ...r, ...extra }
}

// The explicit "Tentar de novo" of an uncertain forward: the same request,
// once.
export function retryForward ({ op, request, uncertain }) {
  return retryChatSend({ op, request, ...(typeof uncertain === 'function' ? { uncertain } : {}) })
}

// The conversations a message can be forwarded to, newest first: the inbox
// DMs and the groups the person can post in, from dm.list and the
// community.info group rows (5.59, `visibility` read from each row; a group
// whose root is not held has none and is left out).
// -> [{ key, kind, title, peer?, group?, visibility? }]
export function forwardDestinations ({ dmConversations = [], groups = [] } = {}) {
  const visibility = new Map()
  for (const g of Array.isArray(groups) ? groups : []) {
    if (g && isKey(g.group) && (g.visibility === 'public' || g.visibility === 'private')) visibility.set(g.group, g.visibility)
  }
  const rows = mergeRows({ dmConversations: Array.isArray(dmConversations) ? dmConversations : [], groups: (Array.isArray(groups) ? groups : []).filter((g) => g && visibility.has(g.group)) })
  const out = []
  for (const row of rows) {
    if (row.kind === 'dm' && isKey(row.peer)) out.push({ key: row.key, kind: 'dm', title: row.title, peer: row.peer })
    else if (row.kind === 'group' && visibility.has(row.group)) out.push({ key: row.key, kind: 'group', title: row.title, group: row.group, visibility: visibility.get(row.group) })
  }
  return out
}

// The forward target of a destination row.
export function targetOf (row) {
  if (!row || typeof row !== 'object') return null
  if (row.kind === 'dm' && isKey(row.peer)) return { kind: 'dm', to: row.peer }
  if (row.kind === 'group' && isKey(row.group) && (row.visibility === 'public' || row.visibility === 'private')) {
    return { kind: 'group', group: row.group, visibility: row.visibility }
  }
  return null
}

// Selection of up to FORWARD_MAX destinations, in tap order. A tap on a
// chosen key removes it; a tap past the cap changes nothing.
export function toggleSelection (selected, key, max = FORWARD_MAX) {
  const list = Array.isArray(selected) ? selected : []
  if (typeof key !== 'string' || key === '') return list
  if (list.includes(key)) return list.filter((k) => k !== key)
  if (list.length >= max) return list
  return [...list, key]
}

// Per-destination state of a forward: 'waiting' (queued), 'pending' (running),
// 'sent', 'uncertain' (only an explicit tap retries) or 'failed'.
export const DEST_STATES = Object.freeze(['waiting', 'pending', 'sent', 'uncertain', 'failed'])

// The state a destination takes from runForward / retryForward's phase.
export function stateOfPhase (phase) {
  if (phase === 'done') return 'sent'
  if (phase === 'uncertain') return 'uncertain'
  if (phase === 'cancelled') return 'waiting'
  return 'failed'
}

// Whether the sheet offers "Tentar de novo" for a destination: only after an
// uncertain send that kept its request.
export function canRetry (entry) {
  return !!entry && entry.state === 'uncertain' && !!entry.op && typeof entry.op.method === 'string'
}

// The forward source of one dm.thread message, or null when there is
// nothing left to forward. dm.thread answers media { unavailable: true } for
// the whole message once its blob is gone (rpc 5.78): that becomes one
// unavailable item, so forwardPlan drops it with EXPIRED and a caption still
// goes.
export function dmForwardSource (text, media) {
  const body = typeof text === 'string' ? text : ''
  let items = []
  if (Array.isArray(media)) items = media
  else if (media && typeof media === 'object' && media.unavailable === true) items = [{ unavailable: true }]
  const usable = items.some((m) => !(m && typeof m === 'object' && m.unavailable === true))
  if (body === '' && !usable) return null
  return { kind: 'dm', text: body, media: items }
}

// Whether a destination still has a request in flight or queued: the sheet
// stays open until it settles, so no answer lands on a closed or reopened
// sheet and no uncertain row loses its "Tentar de novo".
export function forwardBusy (status) {
  if (!status || typeof status !== 'object') return false
  return Object.values(status).some((e) => !!e && (e.state === 'pending' || e.state === 'waiting'))
}

export const DM_LIST_PAGES = 4
const MEMBER_ROLES = new Set(['creator', 'admin', 'member'])
const INFO_AT_ONCE = 4

// The destination rows, read with request(method, params). dm.list is
// followed through `next` for up to `pages` pages. A failed dm.list or
// community.list rejects, so the sheet shows the error and a reload instead
// of an empty list. A community whose community.info fails or answers
// incomplete is left out and `partial` says some groups are missing.
// -> { rows, partial }
export async function loadForwardDestinations (request, { pages = DM_LIST_PAGES } = {}) {
  const readDms = async () => {
    const out = []
    const seen = new Set()
    let before
    for (let i = 0; i < pages; i++) {
      const r = await request('dm.list', before ? { folder: 'inbox', before } : { folder: 'inbox' })
      for (const c of (r && Array.isArray(r.conversations) ? r.conversations : [])) {
        if (!c || !isKey(c.peer) || seen.has(c.peer)) continue
        seen.add(c.peer)
        out.push(c)
      }
      before = r && r.next && typeof r.next === 'object' ? r.next : null
      if (!before) break
    }
    return out
  }
  const [dmConversations, communities] = await Promise.all([readDms(), request('community.list', {})])
  const wanted = (communities && Array.isArray(communities.communities) ? communities.communities : [])
    .filter((c) => c && isKey(c.community) && c.state === 'ready' && MEMBER_ROLES.has(c.role))
  const groups = []
  let partial = false
  for (let i = 0; i < wanted.length; i += INFO_AT_ONCE) {
    await Promise.all(wanted.slice(i, i + INFO_AT_ONCE).map(async (c) => {
      let info
      try {
        info = await request('community.info', { community: c.community })
      } catch {
        partial = true
        return
      }
      if (!info || typeof info !== 'object' || info.incomplete === true || !Array.isArray(info.groups)) {
        partial = true
        return
      }
      const name = typeof info.name === 'string' && info.name !== '' ? info.name : ''
      for (const g of info.groups) {
        if (!g || typeof g.group !== 'string' || !MEMBER_ROLES.has(g.role)) continue
        const row = { ...g, community: c.community }
        if (g.general === true && name !== '') row.title = name
        groups.push(row)
      }
    }))
  }
  return { rows: forwardDestinations({ dmConversations, groups }), partial }
}

// Whether any chosen destination needs the audience question before its
// uploads start: a private item going to a public group.
export function needsAudience (source, rows) {
  return (Array.isArray(rows) ? rows : []).some((row) => {
    const target = targetOf(row)
    if (target === null) return false
    const p = forwardPlan(source, target)
    return p.ok === true && p.confirm === AUDIENCE
  })
}
