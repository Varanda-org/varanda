// Helpers for a member's report (denúncia) to the association's moderation.
// Pure ES module: no React and no Node built-ins, so Metro bundles it and
// Node's import() loads it in tests. The page talks to the same-origin account
// service; the statement itself is signed by the browser node (RPC
// report.sign, docs/rpc.md 5.20, @varanda/core lib/report.js).
//
// The fetch wrapper follows the same rules as ./account.js (same-origin
// credentials, no cache, 8 s timeout, JSON read only when the content type
// says so and the body is under 4096 bytes); it is a local copy so that file
// stays untouched.

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import rpc from '@varanda/rpc'
import { resolveUrl } from './installation.js'
import { isAppClient } from './appClient.js'

// Same order and labels as @varanda/core lib/report.js REASONS/REASON_LABELS.
export const REASONS = [['spam', 'spam'], ['assedio', 'assédio'], ['ilegal', 'conteúdo ilegal'], ['outro', 'outro']]
// Code points (Array.from length), as report.js TEXT_MAX and format.js countChars.
export const TEXT_MAX = 280

const TIMEOUT_MS = 8000
const MAX_BODY = 4096
// The account service ends every request at 10 s (server.js
// REQUEST_TIMEOUT_MS); a little longer here so its answer, not our abort,
// says how an anexo upload ended.
const ANEXO_TIMEOUT_MS = 12000
// The service takes 1 MiB, but its 10 s request deadline is what binds: the
// base64 of 700 KB is about 0.95 MB, under 10 s at about 1 Mbit/s.
export const ANEXO_MAX_BYTES = 700 * 1024
// How the re-encoders (media/reportImage.*.js) step down to fit: these
// qualities at each size, then the sides times REPORT_SHRINK, at most
// REPORT_SHRINKS times.
export const REPORT_QUALITIES = Object.freeze([0.85, 0.7, 0.55])
export const REPORT_SHRINK = 0.7
export const REPORT_SHRINKS = 4
const HEX64 = /^[0-9a-f]{64}$/
const MSG_ID = /^[0-9a-f]{32}$/

export const ANEXO_NOTICE = 'A imagem vai para a moderação, aberta.'
export const ANEXO_TOO_BIG = 'A imagem não coube e não foi enviada.'
export const ANEXO_UNAVAILABLE = 'A imagem não está disponível e não será enviada.'
export const ANEXO_AUDIO_NOTICE = 'O áudio vai para a moderação, aberto.'
export const ANEXO_AUDIO_TOO_BIG = 'O áudio não coube e não foi enviado.'
export const ANEXO_AUDIO_UNAVAILABLE = 'O áudio não está disponível e não será enviado.'
const AUDIO_MIME = 'audio/mp4'

export const NOT_LINKED_MESSAGE = 'Para denunciar, primeiro vincule sua conta Google em Ajustes → Conta e @nome.'

const ERROR_MESSAGES = {
  'nao-vinculado': NOT_LINKED_MESSAGE,
  'limite-denuncias': 'muitas denúncias em 24 horas; tente de novo amanhã',
  limite: 'a moderação não pode receber denúncias agora',
  'assinatura-invalida': 'não foi possível provar a chave',
  expirado: 'a denúncia expirou, tente de novo',
  'pedido-invalido': 'denúncia inválida'
}
const FALLBACK_MESSAGE = 'serviço indisponível'
const REPLACEMENT = String.fromCodePoint(0xfffd)

// Lone surrogates become U+FFFD (String.prototype.toWellFormed, spelled out
// for runtimes without it): report.js refuses a string that is not well
// formed, because a lone surrogate and U+FFFD give the same UTF-8 bytes and a
// digest would not bind the exact text (B3 D5). Posts may legally hold them.
export function wellFormed (s) {
  if (typeof s !== 'string') return ''
  if (typeof s.toWellFormed === 'function') return s.toWellFormed()
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      } else {
        out += REPLACEMENT
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += REPLACEMENT
    } else {
      out += s[i]
    }
  }
  return out
}

// The reporter's note -> trimmed string ('' when only whitespace), or null
// when longer than TEXT_MAX code points.
export function validateReportText (text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return Array.from(trimmed).length > TEXT_MAX ? null : trimmed
}

// Never carries a raw body: the message comes from a fixed table.
export function toError (code) {
  const known = typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
  const err = new Error(known ? ERROR_MESSAGES[code] : FALLBACK_MESSAGE)
  err.code = known ? code : 'indisponivel'
  return err
}

export async function readJson (res) {
  const type = res.headers && res.headers.get ? res.headers.get('content-type') : ''
  if (!/^application\/json\b/i.test(type || '')) return null
  let text
  try { text = await res.text() } catch { return null }
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BODY) return null
  try { return JSON.parse(text) } catch { return null }
}

export function buildPost (path, body, timeout = TIMEOUT_MS) {
  const app = isAppClient()
  const headers = { accept: 'application/json', 'content-type': 'application/json' }
  if (app) headers['x-varanda-client'] = 'app'
  return {
    url: resolveUrl(path),
    init: {
      method: 'POST',
      credentials: app ? 'omit' : 'same-origin',
      // React Native's fetch (whatwg-fetch) appends '_=<timestamp>' to the
      // URL for 'no-store'; one rule for every app request (media/fetch.js).
      ...(app ? {} : { cache: 'no-store' }),
      headers,
      body: JSON.stringify(body)
    },
    timeout
  }
}

// The request builders (exported for the tests; no network).
export function buildReportStart ({ member }) {
  return buildPost('/account/report/start', { member })
}

// `seq` null = a report of the whole account (quote '').
// `writer` and `group` (report v2, a group message) are added to the body only
// when present, so the diary-post and account bodies keep their exact keys.
// `anexo` (bytes, group message only) moves the body to /account/report/anexo
// with the image as standard base64.
export function buildReportSend ({ member, nonce, target, seq, writer, group, reason, text, quote, signature, anexo = null }) {
  const body = { member, nonce, target, seq, reason, text, quote, signature }
  if (typeof writer === 'string' && typeof group === 'string') {
    body.writer = writer
    body.group = group
  }
  return withAnexo(body, anexo)
}

function withAnexo (body, bytes) {
  if (!(bytes instanceof Uint8Array)) return buildPost('/account/report', body)
  return buildPost('/account/report/anexo', { ...body, anexo: toBase64(bytes) }, ANEXO_TIMEOUT_MS)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Standard base64 with padding; spelled out because btoa is not in every
// React Native runtime and takes a binary string, not bytes.
export function toBase64 (bytes) {
  const out = []
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63])
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + '==')
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=')
  }
  return out.join('')
}

async function call ({ url, init, timeout = TIMEOUT_MS }) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  let res
  let data
  try {
    res = await fetch(url, { ...init, signal: ctl.signal })
    data = await readJson(res)
  } catch {
    throw toError('indisponivel')
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw toError('indisponivel')
    return data
  }
  throw toError(data && typeof data.error === 'string' ? data.error : '')
}

// -> { nonce }
export async function reportStart ({ member }) {
  const data = await call(buildReportStart({ member }))
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}

// -> { id, duplicate }
export async function reportSend (fields) {
  const data = await call(buildReportSend(fields))
  return { id: typeof data.id === 'string' ? data.id : null, duplicate: data.duplicate === true }
}

// The report.sign params for one report. `seq` null = the whole account (no
// quote). `writer` and `group` together = a group message (docs/rpc.md 5.20);
// the quote is then the text the reporter sees (for a private group, the
// locally decrypted one), normalized like a diary quote. `anexo` (the hex
// SHA-256 of the attached image) rides only on a group message: the node then
// signs varanda-report-v3.
export function reportParams ({ nonce, target, seq = null, writer = null, group = null, reason, text, quote = '', anexo = null }) {
  const params = { nonce, target, reason, text }
  if (seq !== null && seq !== undefined) {
    params.seq = seq
    params.quote = wellFormed(quote)
    if (writer !== null && group !== null) {
      params.writer = writer
      params.group = group
      if (typeof anexo === 'string') params.anexo = anexo
    }
  }
  return params
}

// The three steps of a report: nonce, signature, POST. The nonce is asked only
// when this runs (the caller runs it on an explicit send, never when a screen
// opens). `isStale()` is checked after each step that can take a while: a
// close, a lock or an identity change makes the flow stop before it signs and
// before it sends (-> null). Nothing here retries: a failed POST throws and
// the next attempt starts from a fresh nonce (the anexo route spends a nonce
// as soon as it is checked, so a fresh one is needed anyway).
// `anexo` = { bytes, digest } from prepareAnexo, for a group message only.
export async function submitReport ({ member, sign, isStale, anexo = null, ...fields }) {
  const { nonce } = await reportStart({ member })
  if (isStale()) return null
  const image = anexo !== null && typeof fields.writer === 'string' && typeof fields.group === 'string' ? anexo : null
  const params = reportParams({ nonce, ...fields, anexo: image === null ? null : image.digest })
  const { signature } = await sign(params)
  if (isStale()) return null
  return reportSend({
    member,
    nonce,
    target: params.target,
    seq: params.seq === undefined ? null : params.seq,
    writer: params.writer,
    group: params.group,
    reason: params.reason,
    text: params.text,
    quote: params.quote === undefined ? '' : params.quote,
    signature,
    anexo: params.anexo === undefined ? null : image.bytes
  })
}

// A private message report (docs/rpc.md 5.81, kind 'dm'): the chosen message
// as `quote` and its sender's diary key as `target`, nothing else of the
// conversation. Same account client and header as a post report. `anexo`
// (bytes) moves it to /account/report/anexo.
export function buildDmReportSend ({ member, nonce, target, reason, text, quote, signature, anexo = null }) {
  return withAnexo({ kind: 'dm', member, nonce, target, reason, text, quote, signature }, anexo)
}

// The dm.reportSign params: never a member, an association or the bytes;
// with an image, its hex SHA-256 as `anexo` (the node signs
// varanda-dm-report-v2, and the quote may then be '').
export function dmReportParams ({ nonce, target, reason, text, quote, anexo = null }) {
  const params = { nonce, target, reason, text, quote: wellFormed(quote) }
  if (typeof anexo === 'string') params.anexo = anexo
  return params
}

// As submitReport, signed with dm.reportSign. No retry: a failed POST throws
// and the next attempt starts from a fresh nonce.
export async function submitDmReport ({ member, sign, isStale, target, reason, text, quote, anexo = null }) {
  const { nonce } = await reportStart({ member })
  if (isStale()) return null
  const params = dmReportParams({ nonce, target, reason, text, quote, anexo: anexo === null ? null : anexo.digest })
  const { signature } = await sign(params)
  if (isStale()) return null
  const { anexo: digest, ...signed } = params
  const data = await call(buildDmReportSend({ member, ...signed, signature, anexo: digest === undefined ? null : anexo.bytes }))
  return { id: typeof data.id === 'string' ? data.id : null, duplicate: data.duplicate === true }
}

// A Feira listing report (docs/rpc.md 5.20, kind 'listing'): the listing as
// the sheet opened it, or null. `seq` is the listing's ROOT record, the key
// moderation reads it by; an `editSeq` on the target is never used, so an
// edit while the sheet is open never moves the report to another block.
export function listingTarget (target) {
  if (!target || typeof target !== 'object' || target.kind !== 'listing') return null
  if (typeof target.author !== 'string' || !HEX64.test(target.author)) return null
  if (!Number.isSafeInteger(target.seq) || target.seq < 1) return null
  return { author: target.author, seq: target.seq, title: typeof target.title === 'string' ? target.title : '' }
}

// The report.sign params for a listing: never a writer, a group or an anexo.
export function listingReportParams ({ nonce, target, seq, reason, text, quote }) {
  return { kind: 'listing', nonce, target, seq, reason, text, quote: wellFormed(quote) }
}

// The diary-post body plus kind 'listing', on the plain route.
export function buildListingReportSend ({ member, nonce, target, seq, reason, text, quote, signature }) {
  return buildPost('/account/report', { kind: 'listing', member, nonce, target, seq, reason, text, quote, signature })
}

// As submitReport, signed with report.sign kind 'listing'. No retry: a
// failed POST throws and the next attempt starts from a fresh nonce.
export async function submitListingReport ({ member, sign, isStale, target, seq, reason, text, quote }) {
  const { nonce } = await reportStart({ member })
  if (isStale()) return null
  const params = listingReportParams({ nonce, target, seq, reason, text, quote })
  const { signature } = await sign(params)
  if (isStale()) return null
  const { kind, ...signed } = params
  const data = await call(buildListingReportSend({ member, ...signed, signature }))
  return { id: typeof data.id === 'string' ? data.id : null, duplicate: data.duplicate === true }
}

// The image a report may carry, as a chat media ref (media/chatMedia.js), or
// null. A private message: its first item still there. A private group
// message: its first sealed item (one with a key). A public group post never
// carries one: the moderators read it where it is published.
// `target.media` is the raw item list of the dm.thread row or group.read item.
export function anexoRef (target) {
  if (!target || typeof target !== 'object' || !Array.isArray(target.media)) return null
  const index = target.media.findIndex((it) => it && typeof it === 'object' && it.unavailable !== true)
  if (index < 0 || index > 3) return null
  const item = target.media[index]
  if (target.dm === true) {
    if (typeof target.author !== 'string' || !HEX64.test(target.author)) return null
    if (typeof target.id !== 'string' || !MSG_ID.test(target.id)) return null
    return { kind: 'dm', from: target.author, id: target.id, index, item }
  }
  if (target.private !== true || typeof target.group !== 'string' || typeof target.writer !== 'string') return null
  if (typeof target.author !== 'string' || !HEX64.test(target.author) || typeof item.key !== 'string') return null
  return { kind: 'group', diary: target.author, item }
}

// Whether a chat item (DM item or private group item) is a voice note, as
// media/chatMedia.js isVoiceItem.
export function isAudioItem (item) {
  if (!item || typeof item !== 'object') return false
  return (typeof item.plainMime === 'string' ? item.plainMime : item.mime) === AUDIO_MIME
}

// The image or voice note as it will be sent, from the device-local copy the
// chat shows. `source(ref)` -> { uri, mime, w, h } or { unavailable: true }
// (chatMedia's sourceFor bound to the screen's context).
// An image is re-encoded as JPEG (which also drops any metadata) by
// `encode(entry, maxBytes)` -> { bytes, mime, width, height }
// (media/reportImage.*.js), then hashed.
// A voice note is sent as it is, never re-encoded: `readBytes(uri)` reads the
// local copy (media/reportAudio.*.js), and the bytes must pass `audioBounds`
// (audio only, @varanda/rpc) and fit `max`.
// -> { status: 'ok', bytes, digest, uri, width, height } (an image),
// { status: 'ok', kind: 'audio', mime: 'audio/mp4', bytes, digest, uri, ms },
// { status: 'over', uri, kind? } or { status: 'unavailable', kind? } (gone, or
// it could not be decoded). Never rejects; never touches the network itself
// (the uri is a blob: or file:// the node produced).
export async function prepareAnexo (ref, { source, encode, readBytes, audioBounds = rpc.audioBounds, sha256 = nobleSha256, max = ANEXO_MAX_BYTES }) {
  if (ref === null) return { status: 'unavailable' }
  const audio = isAudioItem(ref.item)
  const kind = audio ? { kind: 'audio' } : {}
  let entry
  try {
    entry = await source(ref)
  } catch {
    return { status: 'unavailable', ...kind }
  }
  if (!entry || entry.unavailable === true || typeof entry.uri !== 'string' || !isLocalUri(entry.uri)) return { status: 'unavailable', ...kind }
  if (audio) return prepareAudio(entry, { readBytes, audioBounds, sha256, max })
  let out
  try {
    out = await encode(entry, max)
  } catch {
    return { status: 'unavailable' }
  }
  if (!out || !(out.bytes instanceof Uint8Array) || out.bytes.byteLength === 0 || out.mime !== 'image/jpeg') return { status: 'over', uri: entry.uri }
  if (out.bytes.byteLength > max) return { status: 'over', uri: entry.uri }
  return { status: 'ok', bytes: out.bytes, digest: toHexString(sha256(out.bytes)), uri: entry.uri, width: out.width, height: out.height }
}

async function prepareAudio (entry, { readBytes, audioBounds, sha256, max }) {
  if (entry.mime !== undefined && entry.mime !== AUDIO_MIME) return { status: 'unavailable', kind: 'audio' }
  if (typeof readBytes !== 'function' || typeof audioBounds !== 'function') return { status: 'unavailable', kind: 'audio' }
  let bytes
  try {
    bytes = await readBytes(entry.uri)
  } catch {
    return { status: 'unavailable', kind: 'audio' }
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { status: 'unavailable', kind: 'audio' }
  // The cap first: a file past it is never walked, and the person is told it
  // did not fit rather than that it is gone.
  if (bytes.byteLength > max) return { status: 'over', kind: 'audio', uri: entry.uri }
  let bounds = null
  try { bounds = audioBounds(bytes) } catch {}
  if (bounds === null || typeof bounds !== 'object') return { status: 'unavailable', kind: 'audio' }
  return { status: 'ok', kind: 'audio', mime: AUDIO_MIME, bytes, digest: toHexString(sha256(bytes)), uri: entry.uri, ms: bounds.ms }
}

// Only what the node or the browser made on this device: never an http(s)
// URL, so preparing a report never reaches a third party.
export function isLocalUri (uri) {
  return typeof uri === 'string' && (uri.startsWith('blob:') || uri.startsWith('file://'))
}

function toHexString (bytes) {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
